-- Custom SQL migration file, put your code below! --

-- 1) The ten new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'units', 'product_categories', 'custom_field_definitions', 'products', 'product_variants',
      'product_units', 'product_barcodes', 'batches', 'serials', 'product_imports'
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

-- 2) "Contains" search for the product list: part of a name, a code or a SKU ("napa" finds
--    "Napa Extra 500 mg"). A b-tree index only helps a LIKE that starts at the beginning; a
--    trigram index (pg_trgm, which ships with Postgres) helps LIKE '%napa%' too. pg_trgm is a
--    "trusted" extension, so the database owner (omnivo_migrator) may create it without being a
--    superuser. These indexes live here and not in the Drizzle schema: drizzle-kit would create
--    them before the extension exists. Drizzle never sees them, so it never tries to drop them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm_idx ON products USING gin (lower(name) gin_trgm_ops);
CREATE INDEX products_code_trgm_idx ON products USING gin (lower(code) gin_trgm_ops);
CREATE INDEX product_variants_sku_trgm_idx ON product_variants USING gin (lower(sku) gin_trgm_ops);

-- 3) Workspaces set up before this step have no units, categories or custom fields, and a product
--    cannot be made without a unit. The starting set lives in TypeScript (setup/templates.ts), so,
--    like 0014's chart, one outbox event per workspace asks the worker to make it with the same
--    code the setup job uses. 'pending' workspaces are skipped: their setup job makes it after the
--    owner picks a business type.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.catalog_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
