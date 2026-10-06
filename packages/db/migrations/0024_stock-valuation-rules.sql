-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['stock_values', 'stock_accounts', 'stock_revaluations', 'stock_revaluation_lines'])
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

-- 2) Every new movement also adds its quantity and value to its variant's stock_values row (step
--    14), in the same statement that updates its warehouse balance (0022). So the value of a
--    variant's stock is always the sum of its movements' values, whoever inserts them, exactly like
--    its quantity. The average cost is worked out here too: value ÷ quantity while there is stock;
--    at zero or below it keeps the last one, which prices an outflow below zero.
--    A revaluation's movement has quantity 0: it changes the value only, so it does not touch the
--    warehouse balance (that would make an empty balance row for a batch product).
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

-- 3) A revaluation and its lines never change and are never deleted, like a posted journal entry:
--    a wrong one is put right by another revaluation
CREATE FUNCTION stock_revaluations_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a stock revaluation cannot be changed or deleted; post another one instead'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_revaluations_immutable';
END $$;

CREATE TRIGGER stock_revaluations_immutable
  BEFORE UPDATE OR DELETE ON stock_revaluations
  FOR EACH ROW EXECUTE FUNCTION stock_revaluations_immutable();

CREATE TRIGGER stock_revaluation_lines_immutable
  BEFORE UPDATE OR DELETE ON stock_revaluation_lines
  FOR EACH ROW EXECUTE FUNCTION stock_revaluations_immutable();

-- 4) A sent transfer line keeps its value (set while it was still a draft, in the same transaction
--    as the sending): 0022's guard, with value added to what the receipt must not change
CREATE OR REPLACE FUNCTION stock_transfer_lines_guard() RETURNS trigger
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
          NEW.serial_numbers, NEW.value)
         IS NOT DISTINCT FROM
         (OLD.tenant_id, OLD.transfer_id, OLD.line_no, OLD.product_id, OLD.variant_id,
          OLD.unit_id, OLD.quantity, OLD.factor, OLD.base_quantity, OLD.batch_id,
          OLD.serial_numbers, OLD.value) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a sent stock transfer cannot be changed, except to record the receipt once'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'stock_transfer_lines_sent_immutable';
END $$;

-- 5) The stock that is already there (step 13) gets its stock_values row: its quantity, at zero
--    value — it came in without a cost. You chose this: a revaluation gives it its real value. The
--    sums are taken from the movements, exactly what the trigger would have added. Per tenant, with
--    app.tenant_id set, because FORCE RLS applies to the table owner too.
--    Then every workspace that already has a chart gets a job that adds the stock accounts and
--    chooses them (StockAccountsHandler); a workspace without a chart gets them with its chart.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO stock_values (tenant_id, product_id, variant_id, quantity, value, unit_cost)
    SELECT m.tenant_id, m.product_id, m.variant_id, sum(m.quantity), 0,
           CASE WHEN sum(m.quantity) > 0 THEN 0 END
      FROM stock_movements m
     WHERE m.tenant_id = t
     GROUP BY m.tenant_id, m.product_id, m.variant_id
    ON CONFLICT ON CONSTRAINT stock_values_key DO NOTHING;

    IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.tenant_id = t) THEN
      INSERT INTO outbox_events (id, tenant_id, type, payload)
      VALUES (gen_random_uuid(), t, 'workspace.stock_accounts_requested', '{}'::jsonb);
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
