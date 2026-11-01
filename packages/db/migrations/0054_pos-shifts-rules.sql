-- Custom SQL migration file, put your code below! --
-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_cash_reasons', 'pos_shifts', 'pos_cash_movements'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 2) A reason is archived, never deleted: movements and first shifts point at it. Its direction
--    never changes (decision 20): every movement made with it was posted that way.
REVOKE DELETE ON pos_cash_reasons FROM omnivo_app;

CREATE FUNCTION pos_cash_reasons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction <> OLD.direction THEN
    RAISE EXCEPTION 'the direction of pay in / pay out reason % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_cash_reasons_direction_locked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pos_cash_reasons_guard
  BEFORE UPDATE ON pos_cash_reasons
  FOR EACH ROW EXECUTE FUNCTION pos_cash_reasons_guard();

-- 3) The cash of a shift: the opening count, the cash its sales took and the change they gave,
--    its pay ins and pay outs, and what the drawer should hold (the contract's expectedCashOf()).
--    The server's one place for this sum: a close (with or without a count) stores its expected
--    cash, and the shift's page shows the parts. Change is always given in cash (0052 lets no
--    other method pay more than the total), so it is what was paid less the total. No row = no
--    such shift.
CREATE FUNCTION pos_shift_cash(p_tenant uuid, p_shift uuid)
RETURNS TABLE (
  opening numeric,
  cash_taken numeric,
  change_given numeric,
  paid_in numeric,
  paid_out numeric,
  expected numeric
)
LANGUAGE sql STABLE AS $$
  WITH sales AS (
    SELECT coalesce(sum(x.paid - x.total), 0) AS change_given,
           coalesce(sum((SELECT sum(p.amount)
                           FROM pos_sale_payments p
                          WHERE p.tenant_id = x.tenant_id AND p.sale_id = x.id
                            AND p.method = 'cash')), 0) AS cash_taken
      FROM pos_sales x
     WHERE x.tenant_id = p_tenant AND x.shift_id = p_shift
  ), moves AS (
    SELECT coalesce(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0) AS paid_in,
           coalesce(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0) AS paid_out
      FROM pos_cash_movements m
     WHERE m.tenant_id = p_tenant AND m.shift_id = p_shift
  )
  SELECT s.opening_cash, sales.cash_taken, sales.change_given, moves.paid_in, moves.paid_out,
         s.opening_cash + sales.cash_taken + moves.paid_in - sales.change_given - moves.paid_out
    FROM pos_shifts s, sales, moves
   WHERE s.tenant_id = p_tenant AND s.id = p_shift
$$;

-- 4) The rules of a shift:
--    - it opens on a register its own device holds. The device and then the register are read FOR
--      SHARE: a release or a revoke running at the same moment finishes first and this check sees
--      it, or waits for this shift and then sees it open (sections 5 and 6). Without the locks a
--      shift could open on a register nobody holds, or a revoke could fail: it would not see the
--      new shift to close, and then its release would find it open;
--    - while it is open only the close may be written: the opening columns stay as the device sent
--      them. to_jsonb(row) minus the closing columns compares every other column, also the ones a
--      later step adds;
--    - once closed, with or without a count, it never changes, and it is never deleted: its
--      entries and its sales point at it.
CREATE FUNCTION pos_shifts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_holder uuid;
  v_closing text[] := ARRAY[
    'status', 'closed_at', 'closing_date', 'closing_notes', 'counted_cash', 'device_expected',
    'held_dropped', 'expected_cash', 'closing_entry_id', 'closed_by',
    'version', 'updated_at', 'updated_by'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'POS shift % cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The device first, the order a revoke takes (device, then its shift, then the register)
    PERFORM 1 FROM devices d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.device_id FOR SHARE;
    SELECT r.device_id INTO v_holder
      FROM pos_registers r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.register_id
       FOR SHARE;
    -- Nothing found: no such register, which the foreign key reports
    IF FOUND AND v_holder IS DISTINCT FROM NEW.device_id THEN
      RAISE EXCEPTION 'device % does not hold POS register %, so it cannot open a shift on it',
          NEW.device_id, NEW.register_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_register_not_held';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'POS shift % is closed and cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_immutable';
  END IF;
  IF to_jsonb(NEW) - v_closing IS DISTINCT FROM to_jsonb(OLD) - v_closing THEN
    RAISE EXCEPTION 'the opening of POS shift % cannot be changed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_shifts_opening_locked';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pos_shifts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON pos_shifts
  FOR EACH ROW EXECUTE FUNCTION pos_shifts_guard();

-- 5) A register with an open shift keeps its device (decision 32): letting go of it, moving the
--    device to another branch (whose release fires this) and giving it to another device are all
--    refused until the shift is closed. A revoke closes the shift first (section 6), so it passes.
--    The rest is 0052's guard as it was.
CREATE OR REPLACE FUNCTION pos_registers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_device_branch uuid;
  v_register_branch uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'the code of POS register % cannot be changed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_code_locked';
    END IF;
    IF NEW.last_number < OLD.last_number THEN
      RAISE EXCEPTION 'the last number of POS register % cannot go down from % to %',
          OLD.id, OLD.last_number, NEW.last_number
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_last_number_grows';
    END IF;
    IF NEW.device_id IS DISTINCT FROM OLD.device_id AND EXISTS (
      SELECT 1 FROM pos_shifts s
       WHERE s.tenant_id = OLD.tenant_id AND s.register_id = OLD.id AND s.status = 'open'
    ) THEN
      RAISE EXCEPTION 'POS register % has an open shift, so its device keeps it', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_shift_open';
    END IF;
  END IF;

  IF NEW.device_id IS NOT NULL AND (
       TG_OP = 'INSERT'
       OR NEW.device_id IS DISTINCT FROM OLD.device_id
       OR NEW.warehouse_id <> OLD.warehouse_id) THEN
    SELECT d.revoked_at IS NULL, d.branch_id INTO v_active, v_device_branch
      FROM devices d WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.device_id
       FOR SHARE;
    SELECT w.branch_id INTO v_register_branch
      FROM warehouses w WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.warehouse_id
       FOR SHARE;
    -- Nothing found: no such device or warehouse, which the foreign keys report
    IF v_active IS NOT NULL AND v_register_branch IS NOT NULL
       AND (NOT v_active OR v_device_branch <> v_register_branch) THEN
      RAISE EXCEPTION 'device % cannot hold POS register %: it is revoked or in another branch',
          NEW.device_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_registers_holder_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 6) A revoked device's open shift is closed without a count (decision 11), whoever revoked it and
--    however: a lost PC is revoked so the counter can work again. Nobody counted, so nothing is
--    posted; the server's expected cash is stored, and it is what the next shift's opening count
--    is compared with. closed_by is the person who revoked it (0048 makes every revoke name one).
--    The shift is closed before the register is let go, or section 5 would refuse the release.
--    A device moved to another branch closes nothing: its open shift makes the release, and so
--    the move, fail. The rest is 0052's release as it was.
CREATE OR REPLACE FUNCTION devices_pos_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE pos_shifts s
       SET status = 'closed_without_count',
           closed_at = NEW.revoked_at,
           closed_by = NEW.revoked_by,
           expected_cash = (SELECT c.expected FROM pos_shift_cash(s.tenant_id, s.id) c),
           version = s.version + 1,
           updated_at = now(),
           updated_by = NEW.revoked_by
     WHERE s.tenant_id = NEW.tenant_id AND s.device_id = NEW.id AND s.status = 'open';
  END IF;
  UPDATE pos_registers
     SET device_id = NULL
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id;
  RETURN NULL;
END $$;

-- 7) The devices keep every active reason (pos_cash_reason, step 18a's change log), and each
--    register's latest shift is part of the register's row (lastShift). So a shift that opens or
--    closes logs its register: the next pull sends the register again, and the next cashier on
--    any device of the branch numbers on from it and compares their count with what it left. A
--    shift is never deleted (section 4), so it has no delete trigger.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT *
      FROM (VALUES
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'INSERT'),
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'UPDATE'),
        ('pos_cash_reasons', 'pos_cash_reason', 'r.id::text', 'DELETE'),
        ('pos_shifts', 'pos_register', 'r.register_id::text', 'INSERT'),
        ('pos_shifts', 'pos_register', 'r.register_id::text', 'UPDATE')
      ) AS v(tbl, entity, key_sql, op)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_' || lower(s.op), s.op, s.tbl,
      CASE s.op
        WHEN 'INSERT' THEN 'NEW TABLE AS new_rows'
        WHEN 'DELETE' THEN 'OLD TABLE AS old_rows'
        ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows'
      END,
      s.entity, s.key_sql, 'true', 'NULL'
    );
  END LOOP;
END $$;

-- 8) A pay in or pay out is posted the moment it is written, and never changes: a mistake is put
--    right by a movement the other way (decision 28)
CREATE FUNCTION pos_cash_movements_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a pay in or pay out cannot be changed or deleted; move the money back instead'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_cash_movements_immutable';
END $$;

CREATE TRIGGER pos_cash_movements_immutable
  BEFORE UPDATE OR DELETE ON pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION pos_cash_movements_immutable();
