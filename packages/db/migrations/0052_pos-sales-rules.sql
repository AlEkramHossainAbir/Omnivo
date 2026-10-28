-- Custom SQL migration file, put your code below! --
-- 1) The five new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'pos_registers', 'pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'
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

-- 2) A register is archived, never deleted: its sales point at it and its code is in their numbers
REVOKE DELETE ON pos_registers FROM omnivo_app;

-- 3) The rules of a register that keep a receipt number from being given twice:
--    - its code never changes: it is the first part of every number the register gave;
--    - its last number only grows: a claim numbers on from it;
--    - the device that holds it is active and in the register's branch (its warehouse's). Checked
--      when a device takes it, and when a held register moves to another warehouse. Both rows are
--      read FOR SHARE: a revoke or a move of the device, or a move of the warehouse, that is running
--      at the same moment finishes first, and this check sees its result (sections 4 and 5).
CREATE FUNCTION pos_registers_guard() RETURNS trigger
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

CREATE TRIGGER pos_registers_guard
  BEFORE INSERT OR UPDATE ON pos_registers
  FOR EACH ROW EXECUTE FUNCTION pos_registers_guard();

-- 4) A device that is revoked or moved to another branch lets go of its register at once, whoever
--    revoked or moved it (the device's person, a manager, removing the member). A revoked device
--    never pushes again, so a sale it did not send is lost with it (decision 14: a lost PC is
--    revoked), and the next device may number on. Step 18c moves a device only when nothing waits
--    on it. version is left as it is: the register's form does not change who holds it, so a
--    manager's open form must not fail on it.
CREATE FUNCTION devices_pos_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET device_id = NULL
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER devices_pos_release
  AFTER UPDATE OF revoked_at, branch_id ON devices
  FOR EACH ROW
  WHEN ((OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) OR OLD.branch_id <> NEW.branch_id)
  EXECUTE FUNCTION devices_pos_release();

-- 5) A warehouse that moves to another branch takes its registers with it (a register's branch is
--    its warehouse's). Refused while one of them is held: its device stays in the old branch and
--    may still have sales to send. A free one moves, and the devices of both branches hear about
--    it here: the register row itself did not change, so its own triggers log nothing. The API
--    already refuses to move a warehouse with stock movements (warehouse_branch_locked), so this
--    is rare: a new warehouse set up in the wrong branch.
CREATE FUNCTION warehouses_pos_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pos_registers r
     WHERE r.tenant_id = NEW.tenant_id AND r.warehouse_id = NEW.id AND r.device_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'warehouse % has a POS register a device holds', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'warehouses_register_held';
  END IF;
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT r.tenant_id, 'pos_register', r.id::text
    FROM pos_registers r
   WHERE r.tenant_id = NEW.tenant_id AND r.warehouse_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER warehouses_pos_branch
  AFTER UPDATE OF branch_id ON warehouses
  FOR EACH ROW
  WHEN (OLD.branch_id <> NEW.branch_id)
  EXECUTE FUNCTION warehouses_pos_branch();

-- 6) The devices keep the registers of their branch (pos_register, step 18a's change log). An
--    insert and a delete use 0044's sync_log. An update is logged only when something other than
--    last_number and updated_at changed: every sale moves the last number (section 7), and the
--    device does not keep it (syncPosRegisterSchema), so logging it would send the row again after
--    every sale for nothing. to_jsonb(row) minus those two keys compares every other column, also
--    the ones a later step adds.
CREATE TRIGGER pos_registers_sync_insert
  AFTER INSERT ON pos_registers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_register', 'r.id::text', 'true', 'NULL');

CREATE TRIGGER pos_registers_sync_delete
  AFTER DELETE ON pos_registers
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log('pos_register', 'r.id::text', 'true', 'NULL');

CREATE FUNCTION sync_log_pos_registers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT n.tenant_id, 'pos_register', n.id::text
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
   WHERE to_jsonb(n) - ARRAY['last_number', 'updated_at']
         IS DISTINCT FROM to_jsonb(o) - ARRAY['last_number', 'updated_at'];
  RETURN NULL;
END $$;

CREATE TRIGGER pos_registers_sync_update
  AFTER UPDATE ON pos_registers
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_pos_registers();

-- 7) A sale moves its register's last number up to its own, in the same transaction, whoever
--    writes it. So the next device that claims the register can never start at a number a sale
--    already has. The API moves it for a refused sale too (its number was printed), which this
--    trigger cannot see.
CREATE FUNCTION pos_sales_last_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE pos_registers
     SET last_number = NEW.sequence
   WHERE tenant_id = NEW.tenant_id AND id = NEW.register_id AND last_number < NEW.sequence;
  RETURN NULL;
END $$;

CREATE TRIGGER pos_sales_last_number
  AFTER INSERT ON pos_sales
  FOR EACH ROW EXECUTE FUNCTION pos_sales_last_number();

-- 8) A POS sale is posted the moment it is written, and never changes: no line, batch or payment
--    is changed or removed. A wrong sale is put right by a return (step 20c), like a posted
--    document by another document.
CREATE FUNCTION pos_sales_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a POS sale cannot be changed or deleted; a return brings the goods back'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'pos_sales_immutable';
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION pos_sales_immutable()',
      t || '_immutable', t
    );
  END LOOP;
END $$;

-- 9) A sale adds up, checked at COMMIT like a journal entry (0016): by then every line, batch and
--    payment is in place, whatever order the code wrote them in. The header's totals are the sums
--    of its lines; it has a payment, the payments add up to what was paid, and no more than the
--    total was paid by anything but cash (only cash gives change); a batch product's line left
--    from batches that add up to its quantity. A line or a payment added to an old sale later
--    fires this too, and fails it. It runs once per row written, so a sale of 50 lines is checked
--    about 50 times at its commit: a few thousand rows read, once per sale.
CREATE FUNCTION pos_sale_check(p_tenant uuid, p_sale uuid) RETURNS void
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

-- The sale each kind of row belongs to. IF, not CASE: a CASE would read NEW.sale_id on a
-- pos_sales row, which has no such field, and fail.
CREATE FUNCTION pos_sales_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sale uuid;
BEGIN
  IF TG_TABLE_NAME = 'pos_sales' THEN
    v_sale := NEW.id;
  ELSIF TG_TABLE_NAME = 'pos_sale_line_batches' THEN
    SELECT l.sale_id INTO v_sale
      FROM pos_sale_lines l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.line_id;
  ELSE
    v_sale := NEW.sale_id;
  END IF;
  PERFORM pos_sale_check(NEW.tenant_id, v_sale);
  RETURN NULL;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['pos_sales', 'pos_sale_lines', 'pos_sale_line_batches', 'pos_sale_payments'])
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW EXECUTE FUNCTION pos_sales_complete()',
      t || '_complete', t
    );
  END LOOP;
END $$;

-- 10) A POS sale is never refused for stock (decision 7): the money was taken and the receipt
--     printed. So its movements may take a warehouse below zero even when the workspace does not
--     allow it, and even on a batch (decision 15: what is missing goes below zero on the device's
--     batch). Every other document keeps 0022's rule. The rest is 0024's function as it was.
--     A serial number is still never sold twice: the API leaves the serial off a line whose serial
--     is not in this warehouse, so serials_not_here never fires for a sale.
CREATE OR REPLACE FUNCTION stock_movements_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric;
  v_tracking text;
  v_allowed boolean;
  v_serial_at uuid;
BEGIN
  IF NEW.quantity <> 0 THEN
    INSERT INTO stock_balances AS b
           (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity, updated_at)
    VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.product_id, NEW.variant_id, NEW.batch_id,
            NEW.quantity, now())
    ON CONFLICT ON CONSTRAINT stock_balances_key
    DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity, updated_at = now()
    RETURNING b.quantity INTO v_balance;

    IF v_balance < 0 AND NEW.quantity < 0 AND NEW.kind <> 'pos_sale' THEN
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

  INSERT INTO stock_values AS sv
         (tenant_id, product_id, variant_id, quantity, value, unit_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.product_id, NEW.variant_id, NEW.quantity, NEW.value,
          CASE WHEN NEW.quantity > 0 THEN round(NEW.value / NEW.quantity, 4) END, now())
  ON CONFLICT ON CONSTRAINT stock_values_key
  DO UPDATE SET
    quantity = sv.quantity + EXCLUDED.quantity,
    value = sv.value + EXCLUDED.value,
    unit_cost = CASE
      WHEN sv.quantity + EXCLUDED.quantity > 0
        THEN round((sv.value + EXCLUDED.value) / (sv.quantity + EXCLUDED.quantity), 4)
      ELSE coalesce(sv.unit_cost, EXCLUDED.unit_cost)
    END,
    updated_at = now();
  RETURN NULL;
END $$;
