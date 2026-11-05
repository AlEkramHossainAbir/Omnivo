-- Custom SQL migration file, put your code below! --
-- 1) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['sync_changes', 'devices'])
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

-- 2) The change log is written by the triggers below and read by the pull. The API never edits or
--    deletes a line of it: a bug that did would make devices miss changes without anyone noticing.
--    A device is revoked (step 18c), never deleted.
REVOKE UPDATE, DELETE ON sync_changes FROM omnivo_app;
REVOKE DELETE ON devices FROM omnivo_app;

-- 3) The log keeps 30 days (decision 26). The worker's hourly cleanup deletes the older lines of
--    EVERY tenant in one statement, as its own role (omnivo_worker), like the outbox's cleanup in
--    0012: this policy applies to that role only, and omnivo_app still sees its tenant's lines only.
GRANT SELECT, DELETE ON sync_changes TO omnivo_worker;
CREATE POLICY sync_prune ON sync_changes
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);

-- 4) The keys of the two entities without an id of their own. The contract's priceListItemKey()
--    and stockKey() build the same strings in TypeScript (packages/contracts/src/sync.ts), so the
--    format must not change: three ids joined by ':', and '-' for a stock row without a batch.
--    The triggers here and the pull (18a.3) use these, so the format is written once in SQL.
CREATE FUNCTION sync_price_key(price_list_id uuid, variant_id uuid, unit_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT price_list_id::text || ':' || variant_id::text || ':' || unit_id::text
$$;

CREATE FUNCTION sync_stock_key(warehouse_id uuid, variant_id uuid, batch_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT warehouse_id::text || ':' || variant_id::text || ':' || coalesce(batch_id::text, '-')
$$;

-- 5) One function writes the log for every synced table. It runs once per statement, not once per
--    row, and reads the statement's rows from its transition tables (new_rows, old_rows): a price
--    list save of 500 prices or a product import is one INSERT here, and the 300 variants of one
--    style written in one statement are one line, not 300 (DISTINCT).
--    Its arguments come from the CREATE TRIGGER statements in section 8 (fixed text, never input):
--      0  the entity (SYNC_ENTITIES)
--      1  the key, as SQL on the row r
--      2  which rows count, as SQL on r ('true' = all of them)
--      3  the warehouse of a stock row, as SQL on r ('NULL' for the others)
--    An UPDATE logs the rows before and after: a key never changes, but a filter may stop being
--    true (a customer that is now only a supplier), and the device must hear about that one too.
CREATE FUNCTION sync_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rows_sql text := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT * FROM new_rows'
    WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
    ELSE 'SELECT * FROM old_rows UNION ALL SELECT * FROM new_rows'
  END;
BEGIN
  EXECUTE format(
    'INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
     SELECT DISTINCT r.tenant_id, %L, %s, (%s)::uuid FROM (%s) r WHERE %s',
    TG_ARGV[0], TG_ARGV[1], TG_ARGV[3], rows_sql, TG_ARGV[2]
  );
  RETURN NULL;
END $$;

-- 6) A price and a stock row are on a device only while their product is active, and a price only
--    while its list is active too: an archived list falls back to the products' own prices
--    (PriceLookupService), and nobody sells an archived product. Archiving or restoring a product
--    or a list does not touch those rows, so these two triggers log them. A stock row at zero is
--    not on any device, so it is left out.
--    The stock rows are found through the product's variants: stock_balances has an index on the
--    variant, not on the product.
CREATE FUNCTION sync_log_product_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT DISTINCT i.tenant_id, 'price_list_item', sync_price_key(i.price_list_id, i.variant_id, i.unit_id)
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN price_list_items i ON i.tenant_id = n.tenant_id AND i.product_id = n.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL);

  INSERT INTO sync_changes (tenant_id, entity, entity_key, warehouse_id)
  SELECT DISTINCT b.tenant_id, 'stock', sync_stock_key(b.warehouse_id, b.variant_id, b.batch_id),
         b.warehouse_id
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN product_variants v ON v.tenant_id = n.tenant_id AND v.product_id = n.id
    JOIN stock_balances b ON b.tenant_id = v.tenant_id AND b.variant_id = v.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL)
     AND b.quantity <> 0;
  RETURN NULL;
END $$;

CREATE TRIGGER products_sync_scope
  AFTER UPDATE ON products
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_product_scope();

CREATE FUNCTION sync_log_price_list_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  SELECT DISTINCT i.tenant_id, 'price_list_item', sync_price_key(i.price_list_id, i.variant_id, i.unit_id)
    FROM new_rows n
    JOIN old_rows o ON o.tenant_id = n.tenant_id AND o.id = n.id
    JOIN price_list_items i ON i.tenant_id = n.tenant_id AND i.price_list_id = n.id
   WHERE (n.archived_at IS NULL) <> (o.archived_at IS NULL);
  RETURN NULL;
END $$;

CREATE TRIGGER price_lists_sync_scope
  AFTER UPDATE ON price_lists
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION sync_log_price_list_scope();

-- 7) The company's name is in tenants, not in tenant_settings (0007), but it is part of the
--    device's settings row. tenants has no tenant_id column and no RLS, so it gets its own small
--    trigger, per row and only when the name changes: the setup wizard's status changes on the
--    same table must not reach the devices. The insert below passes the log's WITH CHECK only
--    inside the workspace's own tenant context, which SettingsService sets: a rename from outside
--    a tenant context (a future admin console) must set it first.
CREATE FUNCTION sync_log_tenant_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sync_changes (tenant_id, entity, entity_key)
  VALUES (NEW.id, 'settings', NEW.id::text);
  RETURN NULL;
END $$;

CREATE TRIGGER tenants_sync_name
  AFTER UPDATE OF name ON tenants
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION sync_log_tenant_name();

-- 8) The synced tables. Postgres allows transition tables on a trigger of one event only, so each
--    table gets three triggers: <table>_sync_insert, _sync_update and _sync_delete.
--    - A product is one row with its variants, packs and barcodes (decision 14), so a change to
--      any of them logs the product. A product deleted for real takes its children with it (ON
--      DELETE CASCADE); their triggers log the product again, which does no harm.
--    - A party is logged only while it is (or was, for an UPDATE) a customer: a supplier that never
--      sold anything is not a device's business. An address is logged when its party is a customer
--      now; when a customer stops being one, the party's own line is the one that counts.
--    - A stock row carries its warehouse, so a device skips the other branches' stock.
--    - batches are not here: a batch's lot number and dates never change once it exists (step 13).
--      A later step that lets someone fix them must log its stock rows.
--    - warehouses log only themselves: a warehouse with stock cannot be archived
--      (warehouse_has_stock) or moved to another branch (warehouse_branch_locked), so its stock
--      rows never leave a device that way.
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT *
      FROM (VALUES
        ('tenant_settings', 'settings', 'r.tenant_id::text', 'true', 'NULL'),
        ('units', 'unit', 'r.id::text', 'true', 'NULL'),
        ('product_categories', 'product_category', 'r.id::text', 'true', 'NULL'),
        ('tax_rates', 'tax_rate', 'r.id::text', 'true', 'NULL'),
        ('warehouses', 'warehouse', 'r.id::text', 'true', 'NULL'),
        ('price_lists', 'price_list', 'r.id::text', 'true', 'NULL'),
        ('customer_groups', 'customer_group', 'r.id::text', 'true', 'NULL'),
        ('products', 'product', 'r.id::text', 'true', 'NULL'),
        ('product_variants', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('product_units', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('product_barcodes', 'product', 'r.product_id::text', 'true', 'NULL'),
        ('price_list_items', 'price_list_item',
           'sync_price_key(r.price_list_id, r.variant_id, r.unit_id)', 'true', 'NULL'),
        ('parties', 'customer', 'r.id::text', 'r.is_customer', 'NULL'),
        ('party_addresses', 'customer', 'r.party_id::text',
           'EXISTS (SELECT 1 FROM parties p
                     WHERE p.tenant_id = r.tenant_id AND p.id = r.party_id AND p.is_customer)',
           'NULL'),
        ('stock_balances', 'stock', 'sync_stock_key(r.warehouse_id, r.variant_id, r.batch_id)',
           'true', 'r.warehouse_id')
      ) AS v(tbl, entity, key_sql, filter_sql, warehouse_sql)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_insert', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_update', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
         FOR EACH STATEMENT EXECUTE FUNCTION sync_log(%L, %L, %L, %L)',
      s.tbl || '_sync_delete', s.tbl, s.entity, s.key_sql, s.filter_sql, s.warehouse_sql
    );
  END LOOP;
END $$;
