-- Custom SQL migration file, put your code below! --
-- Cost floor: the devices keep each variant's average cost (the contract's price_floor entity,
-- SYNC_PROTOCOL 5), so the POS can refuse a sale below cost without a connection. This file logs a
-- variant's cost for the pull when it changes. The pull's loader (sync-rows.ts) reads
-- stock_values.unit_cost; the key is the variant's id, and the row belongs to no warehouse (one
-- average cost per variant, step 14).
--
-- stock_values is written by stock_movements_apply() (0024, 0052) on every movement, with an
-- INSERT ... ON CONFLICT DO UPDATE. Postgres fires both the INSERT and the UPDATE statement
-- triggers for that statement, each with its own transition table, so the three triggers below see
-- every row it wrote.
--
-- Only a change of a paisa or more is logged (round(…, 2)). An outflow takes its value at the
-- average cost rounded to the paisa, so the 4th decimal of the cost moves on almost every sale
-- (42 at ৳700 is ৳16.6667; after one sale, 41 at ৳683.33 is ৳16.6666). Logging those would send a
-- row to every device of the workspace for each sale, and the floor would not change by a paisa.
-- The device's floor may then be off by less than a paisa per base unit; the server checks the
-- sale's real cost anyway, in its audit log (PosSalesService).
--
-- Like 0044's sync_log(): per statement, DISTINCT, and only inside the writer's tenant context
-- (the log's WITH CHECK). Whoever moves stock already writes sync_changes for stock_balances, so no
-- new grant is needed.
CREATE FUNCTION sync_log_price_floor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO sync_changes (tenant_id, entity, entity_key)
    SELECT DISTINCT n.tenant_id, 'price_floor', n.variant_id::text
      FROM new_rows n
     WHERE n.unit_cost IS NOT NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    -- stock_values_key: one row per (tenant, variant), so the join pairs each row with itself
    INSERT INTO sync_changes (tenant_id, entity, entity_key)
    SELECT DISTINCT n.tenant_id, 'price_floor', n.variant_id::text
      FROM new_rows n
      JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.variant_id = n.variant_id
     WHERE round(n.unit_cost, 2) IS DISTINCT FROM round(o.unit_cost, 2);
  ELSE
    -- No code deletes a stock_values row today; if a later step does, the device drops its floor
    INSERT INTO sync_changes (tenant_id, entity, entity_key)
    SELECT DISTINCT o.tenant_id, 'price_floor', o.variant_id::text
      FROM old_rows o
     WHERE o.unit_cost IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_values_sync_insert
  AFTER INSERT ON stock_values
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_price_floor();
--> statement-breakpoint
CREATE TRIGGER stock_values_sync_update
  AFTER UPDATE ON stock_values
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_price_floor();
--> statement-breakpoint
CREATE TRIGGER stock_values_sync_delete
  AFTER DELETE ON stock_values
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_price_floor();
