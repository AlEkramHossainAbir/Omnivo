-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
    ])
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

-- 2) A register's last return number only grows, like its last number: a device that claims the
--    register numbers its returns on from it (decision 5). The rest is 0054's guard as it was.
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
    IF NEW.last_return_number < OLD.last_return_number THEN
      RAISE EXCEPTION 'the last return number of POS register % cannot go down from % to %',
          OLD.id, OLD.last_return_number, NEW.last_return_number
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

-- 3) The device does not keep the last return number either (syncPosRegisterSchema), so a return
--    that moves it does not send the register's row again. The rest is 0052's function as it was.
CREATE OR REPLACE FUNCTION sync_log_pos_registers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT n.tenant_id, 'pos_register', n.id::text
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
   WHERE to_jsonb(n) - ARRAY['last_number', 'last_return_number', 'updated_at']
         IS DISTINCT FROM to_jsonb(o) - ARRAY['last_number', 'last_return_number', 'updated_at'];
  RETURN NULL;
END $$;

-- 4) A return moves its register's last return number up to its own, in the same transaction,
--    like a sale moves the last number (0052)
CREATE FUNCTION pos_returns_last_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET last_return_number = NEW.sequence
   WHERE tenant_id = NEW.tenant_id AND id = NEW.register_id AND last_return_number < NEW.sequence;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_returns_last_number
  AFTER INSERT ON pos_returns
  FOR EACH ROW EXECUTE FUNCTION pos_returns_last_number();

-- 5) A POS return is posted the moment it is written, and never changes: no line, batch or refund
--    is changed or removed. It is final, like a sale; a mistake is put right by a new sale.
CREATE FUNCTION pos_returns_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a POS return cannot be changed or deleted; a new sale puts a mistake right'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_immutable';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION pos_returns_immutable()',
      t || '_immutable', t
    );
  END LOOP;
END $$;

-- 6) A return adds up, checked at COMMIT like a sale (0052): by then every line, batch and refund is
--    in place. Its totals are the sums of its lines; every line is a line of its own sale, and a
--    serial number that came back is one the sale line sold; the refunds add up to the total (a
--    return gives no change; one of ৳0 has none); and a line of a sale line that left from batches
--    went back into batches that add up to its quantity. More than is left to return is NOT
--    checked here: the server takes it and writes the audit log (decision 20).
CREATE FUNCTION pos_return_check(p_tenant uuid, p_return uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r pos_returns%ROWTYPE;
  v_lines integer;
  v_net numeric;
  v_vat numeric;
  v_total numeric;
  v_refunded numeric;
BEGIN
  SELECT * INTO r FROM pos_returns WHERE tenant_id = p_tenant AND id = p_return;

  SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(total), 0)
    INTO v_lines, v_net, v_vat, v_total
    FROM pos_return_lines WHERE tenant_id = p_tenant AND return_id = p_return;
  IF v_lines = 0 OR v_net <> r.net OR v_vat <> r.vat OR v_total <> r.total THEN
    RAISE EXCEPTION 'POS return % does not add up: % lines, net %, VAT %, total %',
        p_return, v_lines, v_net, v_vat, v_total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_lines_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_return_lines l
      JOIN pos_sale_lines sl ON sl.tenant_id = l.tenant_id AND sl.id = l.sale_line_id
     WHERE l.tenant_id = p_tenant AND l.return_id = p_return
       AND (sl.sale_id <> r.sale_id OR NOT l.serial_numbers <@ sl.serial_numbers)
  ) THEN
    RAISE EXCEPTION 'a line of POS return % is not a line of sale %, or brings back a serial it did not sell',
        p_return, r.sale_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_return_lines_sale_match';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_refunded
    FROM pos_return_refunds WHERE tenant_id = p_tenant AND return_id = p_return;
  IF v_refunded <> r.total THEN
    RAISE EXCEPTION 'the refunds of POS return % add up to %, not its total %',
        p_return, v_refunded, r.total
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_returns_refunds_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_return_lines l
     WHERE l.tenant_id = p_tenant AND l.return_id = p_return
       AND EXISTS (SELECT 1 FROM pos_sale_line_batches sb
                    WHERE sb.tenant_id = l.tenant_id AND sb.line_id = l.sale_line_id)
       AND l.base_quantity <> (SELECT coalesce(sum(b.quantity), 0)
                                 FROM pos_return_line_batches b
                                WHERE b.tenant_id = l.tenant_id AND b.line_id = l.id)
  ) THEN
    RAISE EXCEPTION 'the batches of a line of POS return % do not add up to its quantity', p_return
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_return_line_batches_match';
  END IF;
END $$;

-- The return each kind of row belongs to. IF, not CASE, for the reason in 0052.
CREATE FUNCTION pos_returns_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_return uuid;
BEGIN
  IF TG_TABLE_NAME = 'pos_returns' THEN
    v_return := NEW.id;
  ELSIF TG_TABLE_NAME = 'pos_return_line_batches' THEN
    SELECT l.return_id INTO v_return
      FROM pos_return_lines l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id;
  ELSE
    v_return := NEW.return_id;
  END IF;
  PERFORM pos_return_check(NEW.tenant_id, v_return);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_returns', 'pos_return_lines', 'pos_return_line_batches', 'pos_return_refunds'
    ])
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION pos_returns_complete()',
      t || '_complete', t
    );
  END LOOP;
END $$;

-- 7) A sale's exchange payment uses its return's exchange refund exactly (decision 7): the same
--    amount, and a return of the same shift (so of the same register and device: the return was
--    saved with the sale). The unique index on return_id keeps a second sale from using it. The
--    rest is 0052's check as it was.
CREATE OR REPLACE FUNCTION pos_sale_check(p_tenant uuid, p_sale uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  s pos_sales%ROWTYPE;
  v_lines integer;
  v_net numeric;
  v_vat numeric;
  v_total numeric;
  v_bill numeric;
  v_payments integer;
  v_paid numeric;
  v_not_cash numeric;
BEGIN
  SELECT * INTO s FROM pos_sales WHERE tenant_id = p_tenant AND id = p_sale;

  SELECT count(*), coalesce(sum(net), 0), coalesce(sum(vat), 0), coalesce(sum(total), 0),
         coalesce(sum(bill_discount), 0)
    INTO v_lines, v_net, v_vat, v_total, v_bill
    FROM pos_sale_lines WHERE tenant_id = p_tenant AND sale_id = p_sale;
  IF v_lines = 0 OR v_net <> s.net OR v_vat <> s.vat OR v_total <> s.total
     OR v_bill <> s.bill_discount_amount THEN
    RAISE EXCEPTION 'POS sale % does not add up: % lines, net %, VAT %, total %, bill discount %',
        p_sale, v_lines, v_net, v_vat, v_total, v_bill
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_lines_match';
  END IF;

  SELECT count(*), coalesce(sum(amount), 0),
         coalesce(sum(amount) FILTER (WHERE method <> 'cash'), 0)
    INTO v_payments, v_paid, v_not_cash
    FROM pos_sale_payments WHERE tenant_id = p_tenant AND sale_id = p_sale;
  IF v_payments = 0 OR v_paid <> s.paid OR v_not_cash > s.total THEN
    RAISE EXCEPTION 'the payments of POS sale % do not match: % payments, paid %, not in cash %',
        p_sale, v_payments, v_paid, v_not_cash
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_payments_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_sale_payments p
      LEFT JOIN pos_returns r ON r.tenant_id = p.tenant_id AND r.id = p.return_id
      LEFT JOIN pos_return_refunds f
        ON f.tenant_id = p.tenant_id AND f.return_id = p.return_id AND f.method = 'exchange'
     WHERE p.tenant_id = p_tenant AND p.sale_id = p_sale AND p.method = 'exchange'
       AND (r.shift_id IS DISTINCT FROM s.shift_id OR f.amount IS DISTINCT FROM p.amount)
  ) THEN
    RAISE EXCEPTION 'the exchange payment of POS sale % does not match its return''s exchange', p_sale
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sale_payments_exchange_match';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pos_sale_lines l
      JOIN pos_sale_line_batches b ON b.tenant_id = l.tenant_id AND b.line_id = l.id
     WHERE l.tenant_id = p_tenant AND l.sale_id = p_sale
     GROUP BY l.id, l.base_quantity
    HAVING sum(b.quantity) <> l.base_quantity
  ) THEN
    RAISE EXCEPTION 'the batches of a line of POS sale % do not add up to its quantity', p_sale
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sale_line_batches_match';
  END IF;
END $$;

-- 8) The cash of a shift, with the cash its returns paid back (decision 26): the drawer should
--    hold that much less. An exchange's money never leaves the drawer, so only the cash refunds
--    count. The return type grows by a column, which CREATE OR REPLACE cannot do, so the function
--    is dropped and made again; 0054's revoke and the API call it by name and read the columns by
--    name. The rest is 0054's function as it was.
DROP FUNCTION pos_shift_cash(uuid, uuid);

CREATE FUNCTION pos_shift_cash(p_tenant uuid, p_shift uuid)
RETURNS TABLE (
  opening numeric,
  cash_taken numeric,
  change_given numeric,
  paid_in numeric,
  paid_out numeric,
  cash_refunded numeric,
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
  ), refunds AS (
    SELECT coalesce(sum(f.amount), 0) AS cash_refunded
      FROM pos_returns r
      JOIN pos_return_refunds f ON f.tenant_id = r.tenant_id AND f.return_id = r.id
     WHERE r.tenant_id = p_tenant AND r.shift_id = p_shift AND f.method = 'cash'
  )
  SELECT s.opening_cash, sales.cash_taken, sales.change_given, moves.paid_in, moves.paid_out,
         refunds.cash_refunded,
         s.opening_cash + sales.cash_taken + moves.paid_in
           - sales.change_given - moves.paid_out - refunds.cash_refunded
    FROM pos_shifts s, sales, moves, refunds
   WHERE s.tenant_id = p_tenant AND s.id = p_shift
$$;

-- 9) The devices keep the recent sales of the register they hold (pos_sale, step 18a's change log,
--    decision 21), with what was returned of each line. A sale logs itself when it is written; a
--    return logs its sale, because the sale's row now has less to return. Both are logged with the
--    SALE's warehouse, so only the devices of the sale's branch hear about it (the pull skips the
--    other branches' here), even when a counter of another branch took the goods back. Which
--    device of the branch keeps the row is the API's loader's business. Neither is ever changed or
--    deleted, so there is nothing else to log; a sale that turns 31 days old leaves the device by
--    the device's own clean-up.
CREATE TRIGGER pos_sales_sync_insert
  AFTER INSERT ON pos_sales
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_sale', 'r.id::text', 'true', 'r.warehouse_id');

CREATE FUNCTION sync_log_pos_returns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
  SELECT DISTINCT s.tenant_id, 'pos_sale', s.id::text, s.warehouse_id
    FROM new_rows n
    JOIN pos_sales s ON s.tenant_id = n.tenant_id AND s.id = n.sale_id;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_returns_sync_insert
  AFTER INSERT ON pos_returns
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_pos_returns();
