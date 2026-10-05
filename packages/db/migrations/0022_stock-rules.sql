-- Custom SQL migration file, put your code below! --
-- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'warehouses', 'stock_movements', 'stock_balances', 'reorder_levels', 'stock_adjustments',
      'stock_adjustment_lines', 'stock_transfers', 'stock_transfer_lines'
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

-- 2) The stock ledger is append-only (build plan step 13): a movement is never changed or deleted.
--    A wrong adjustment is fixed by another adjustment, and both stay in the stock card. omnivo_app
--    has UPDATE and DELETE on every table (default privileges), so the rule lives here.
CREATE FUNCTION stock_movements_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock movement % cannot be changed or deleted; post another document instead', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_movements_append_only';
END $$;

CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();

-- 3) Every new movement updates the balance of its warehouse, variant and batch, in the same
--    transaction — so a balance is always the sum of its movements, whoever inserts them.
--    INSERT … ON CONFLICT DO UPDATE locks the balance row: two documents taking the last carton
--    at the same moment run one after the other here, and the second one sees the first one's
--    result. Taking stock below zero is refused unless the workspace allows it (tenant_settings),
--    and never for a batch or a serial number: a batch or an IMEI is either there or it is not.
--    Only a movement OUT is refused: stock coming into a warehouse that is still below zero (the
--    workspace allowed it once, then turned it off) must always be welcome.
--    The API checks all of this first, line by line, to give a readable error; this is the last
--    word, the way 0016 checks that a posted journal entry balances.
--    A serial number's current warehouse is kept here too: in = it must not be in stock anywhere,
--    out = it must be in this warehouse.
CREATE FUNCTION stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
  v_tracking text;
  v_allowed boolean;
  v_serial_at uuid;
BEGIN
  INSERT INTO stock_balances AS b
         (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity, updated_at)
  VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.product_id, NEW.variant_id, NEW.batch_id,
          NEW.quantity, now())
  ON CONFLICT ON CONSTRAINT stock_balances_key
  DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity, updated_at = now()
  RETURNING b.quantity INTO v_balance;

  IF v_balance < 0 AND NEW.quantity < 0 THEN
    SELECT p.tracking INTO v_tracking
      FROM products p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id;
    SELECT s.allow_negative_stock INTO v_allowed
      FROM tenant_settings s WHERE s.tenant_id = NEW.tenant_id;
    IF v_tracking <> 'none' OR NOT coalesce(v_allowed, false) THEN
      RAISE EXCEPTION 'stock of variant % in warehouse % would be %',
          NEW.variant_id, NEW.warehouse_id, v_balance
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_balances_not_negative';
    END IF;
  END IF;

  IF NEW.serial_id IS NOT NULL THEN
    SELECT s.warehouse_id INTO v_serial_at
      FROM serials s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.serial_id
       FOR UPDATE;
    IF NEW.quantity > 0 AND v_serial_at IS NOT NULL THEN
      RAISE EXCEPTION 'serial % is already in stock', NEW.serial_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'serials_in_stock';
    END IF;
    IF NEW.quantity < 0 AND v_serial_at IS DISTINCT FROM NEW.warehouse_id THEN
      RAISE EXCEPTION 'serial % is not in warehouse %', NEW.serial_id, NEW.warehouse_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'serials_not_here';
    END IF;
    UPDATE serials
       SET warehouse_id = CASE WHEN NEW.quantity > 0 THEN NEW.warehouse_id END
     WHERE tenant_id = NEW.tenant_id AND id = NEW.serial_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER stock_movements_apply
  AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

-- 4) A posted adjustment and its lines never change, like a posted journal entry (0016). Only a
--    draft may be edited, deleted or posted.
CREATE FUNCTION stock_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'stock adjustment % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_adjustments_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_adjustments_guard
  BEFORE UPDATE OR DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION stock_adjustments_guard();

CREATE FUNCTION stock_adjustment_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM stock_adjustments
         WHERE tenant_id = OLD.tenant_id AND id = OLD.adjustment_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM stock_adjustments
         WHERE tenant_id = NEW.tenant_id AND id = NEW.adjustment_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted stock adjustment cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_adjustment_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_adjustment_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_lines
  FOR EACH ROW EXECUTE FUNCTION stock_adjustment_lines_guard();

-- 5) A transfer goes draft → in_transit → received, and nothing else. Once sent, what was sent
--    (the places, the date, the number, the lines) is fixed; the only change left is the receipt,
--    once. A received transfer never changes. Only a draft may be deleted.
CREATE FUNCTION stock_transfers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'stock transfer % was sent and cannot be deleted', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfers_sent_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'received'
     OR (OLD.status = 'in_transit' AND (
          NEW.status <> 'received'
          OR (NEW.number, NEW.from_warehouse_id, NEW.to_warehouse_id, NEW.sent_on, NEW.note,
              NEW.sent_at, NEW.sent_by)
             IS DISTINCT FROM
             (OLD.number, OLD.from_warehouse_id, OLD.to_warehouse_id, OLD.sent_on, OLD.note,
              OLD.sent_at, OLD.sent_by))) THEN
    RAISE EXCEPTION 'stock transfer % was sent: only its receipt can be recorded', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfers_sent_immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER stock_transfers_guard
  BEFORE UPDATE OR DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION stock_transfers_guard();

-- The lines: free while the transfer is a draft. In transit, a line may only get its receipt
-- (received_quantity, received_serial_numbers), once, with nothing else changed. Received: frozen.
-- When a draft is deleted its lines go by ON DELETE CASCADE; the header is gone by then, so the
-- lookup finds nothing and lets them go.
CREATE FUNCTION stock_transfer_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM stock_transfers WHERE tenant_id = NEW.tenant_id AND id = NEW.transfer_id;
    -- NULL: no such transfer — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a stock transfer that was sent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM stock_transfers WHERE tenant_id = OLD.tenant_id AND id = OLD.transfer_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF v_status = 'in_transit' AND TG_OP = 'UPDATE' AND OLD.received_quantity IS NULL
     AND NEW.received_quantity IS NOT NULL
     AND (NEW.tenant_id, NEW.transfer_id, NEW.line_no, NEW.product_id, NEW.variant_id,
          NEW.unit_id, NEW.quantity, NEW.factor, NEW.base_quantity, NEW.batch_id,
          NEW.serial_numbers)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.transfer_id, OLD.line_no, OLD.product_id, OLD.variant_id,
          OLD.unit_id, OLD.quantity, OLD.factor, OLD.base_quantity, OLD.batch_id,
          OLD.serial_numbers) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a sent stock transfer cannot be changed, except to record the receipt once'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
END $$;

CREATE TRIGGER stock_transfer_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION stock_transfer_lines_guard();

-- 6) Every workspace gets a first warehouse, "Main store" (MAIN), in its first active branch —
--    sign-up does the same for new workspaces (auth.service.ts). Without one, no stock page can
--    be used. Plain SQL, not a job: the data is fixed and needs no template.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
    SELECT gen_random_uuid(), t, b.id, 'MAIN', 'Main store'
      FROM branches b
     WHERE b.tenant_id = t AND b.archived_at IS NULL
     ORDER BY b.created_at, b.code
     LIMIT 1
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
