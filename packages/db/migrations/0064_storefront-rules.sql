-- Custom SQL migration file, put your code below! --
-- Step 26f: who may read the shop. 0063 made the eight tables; this file gives them the tenant
-- rules every table has, and makes the role the public API reads as: omnivo_public, which sees a
-- launched shop's published listings and the few ERP columns their cards need, and nothing else.

-- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    The policy has no TO, so it holds for every role, omnivo_public included: the public API sets
--    app.tenant_id to the shop's workspace, exactly like the ERP's API does for a member
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_settings', 'storefront_categories', 'storefront_listings',
      'storefront_banners', 'storefront_collections', 'storefront_collection_items',
      'storefront_home_blocks', 'storefront_pages'])
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

-- 2) The shop's search looks for words anywhere in a listing's name, like the products' search
--    (0020). lower() so any case matches; Bangla has no case and lower() leaves it alone. Here and
--    not in the schema file: drizzle cannot write an operator class on an expression
CREATE INDEX storefront_listings_name_trgm_idx
  ON storefront_listings USING gin (lower(name) gin_trgm_ops);

-- 3) The role. NOLOGIN: nobody connects as it, so it has no password to keep in the init scripts or
--    the server's .env. The API connects as omnivo_app, as always, and a public request's
--    transaction starts with SET LOCAL ROLE omnivo_public (LOCAL: it ends with the transaction, so
--    the pooled connection is omnivo_app again for the next request, like set_config(…, true)).
--    Made here and not in infra/docker/postgres/init/01-roles.sql: an init script runs only when a
--    volume is new, so the dev databases and the staging server would never get it. Roles belong
--    to the whole Postgres server, not to one database, hence IF NOT EXISTS: a second database on
--    the same server may have made it already.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omnivo_public') THEN
    CREATE ROLE omnivo_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO omnivo_public;
-- SET TRUE: omnivo_app may become it. INHERIT FALSE: omnivo_app does not get its rights or its
-- policies by being a member. Without it, the RESTRICTIVE policies below (written for
-- omnivo_public) would hold for omnivo_app too, and the ERP would stop seeing every variant that
-- is not on sale in the shop. Postgres 16+ syntax; the servers run 17.
GRANT omnivo_public TO omnivo_app WITH INHERIT FALSE, SET TRUE;

-- 4) What it may read. SELECT only: the public API never writes (orders come in step 27, with
--    their own grants). No default privileges either, so a table added later is closed to it until
--    a migration opens it. The ERP tables give only the columns a card and the quote need, so a
--    bug in the public API cannot read a cost, a supplier or a customer: those columns and tables
--    answer "permission denied".
GRANT SELECT ON storefront_settings, storefront_categories, storefront_listings, storefront_banners,
  storefront_collections, storefront_collection_items, storefront_home_blocks, storefront_pages
  TO omnivo_public;
-- The SKU, the regular price (decision 2), and whether it is archived (an archived product leaves
-- the shop)
GRANT SELECT (id, tenant_id, product_id, sku, sale_price, archived_at) ON product_variants
  TO omnivo_public;
-- "Per Piece": the base unit's name
GRANT SELECT (id, tenant_id, base_unit_id, archived_at) ON products TO omnivo_public;
GRANT SELECT (id, tenant_id, name) ON units TO omnivo_public;
-- In stock or not (decision 3). The API says only that, never the number
GRANT SELECT (tenant_id, warehouse_id, variant_id, quantity) ON stock_balances TO omnivo_public;
-- The shop prints its times in the workspace's zone (publicShopSchema.timeZone)
GRANT SELECT (tenant_id, timezone) ON tenant_settings TO omnivo_public;

-- 5) Which rows. tenant_isolation already keeps the role inside one workspace; these RESTRICTIVE
--    policies (AND-ed with it, never OR-ed) keep it to what that workspace's shop shows. TO
--    omnivo_public only: omnivo_app (INHERIT FALSE) and the migrator never meet them.

-- A shop that is not launched shows nothing, even if the API set its workspace by mistake
CREATE POLICY storefront_public_launched ON storefront_settings
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (launched_at IS NOT NULL);

-- Every other storefront table: only while its shop is launched. The subquery reads
-- storefront_settings as omnivo_public, so the policy above is part of it
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_categories', 'storefront_listings', 'storefront_banners',
      'storefront_collections', 'storefront_collection_items', 'storefront_home_blocks',
      'storefront_pages'])
  LOOP
    EXECUTE format(
      'CREATE POLICY storefront_public_launched ON %I
         AS RESTRICTIVE FOR SELECT TO omnivo_public
         USING (EXISTS (SELECT 1 FROM storefront_settings s WHERE s.tenant_id = %I.tenant_id))',
      t, t
    );
  END LOOP;
END $$;

-- A draft listing is not in the shop. A collection that holds one simply comes back without it,
-- because the API joins the items to the listings it can see
CREATE POLICY storefront_public_published ON storefront_listings
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (published_at IS NOT NULL);

-- The ERP's rows: only the variants and products a published listing sells. The subqueries read
-- storefront_listings as omnivo_public, so "published" and "launched" are part of them. Each is
-- one probe of an index (storefront_listings_variant_idx, storefront_listings_product_idx)
CREATE POLICY storefront_public_listed ON product_variants
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_listings l
    WHERE l.tenant_id = product_variants.tenant_id AND l.variant_id = product_variants.id
  ));
CREATE POLICY storefront_public_listed ON products
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_listings l
    WHERE l.tenant_id = products.tenant_id AND l.product_id = products.id
  ));
-- The stock of a listed variant in the shop's own warehouse, not in the others: how much a
-- workspace holds in its factory store is not the shop's business
CREATE POLICY storefront_public_listed ON stock_balances
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (
    EXISTS (
      SELECT 1 FROM storefront_listings l
      WHERE l.tenant_id = stock_balances.tenant_id AND l.variant_id = stock_balances.variant_id
    )
    AND warehouse_id = (
      SELECT s.default_warehouse_id FROM storefront_settings s
      WHERE s.tenant_id = stock_balances.tenant_id
    )
  );
-- units and tenant_settings need no more than tenant_isolation: a unit's name and the time zone
-- are on the shop's pages anyway, and the column grants above are all the role can read of them.

-- 6) From the address to the workspace. A request knows only the host, so it cannot set
--    app.tenant_id yet, and tenant_isolation shows it no settings row at all. This one function
--    looks across workspaces, and answers only "which workspace has this subdomain's launched
--    shop": one id, never a list, so nobody can walk through every shop with it.
--    SECURITY DEFINER: it runs as its owner, the migrator. FORCE RLS holds for the owner too, so
--    the migrator gets a policy of its own on storefront_settings to read across workspaces (it
--    owns the table and could turn RLS off anyway, so this gives it nothing new). search_path is
--    fixed, so a caller cannot slip in a table of its own named storefront_settings.
CREATE POLICY storefront_host_lookup ON storefront_settings
  FOR SELECT TO omnivo_migrator
  USING (true);

CREATE FUNCTION storefront_tenant_for_subdomain(label text) RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.tenant_id
  FROM storefront_settings s
  JOIN tenants t ON t.id = s.tenant_id
  -- A deleted workspace's shop is gone with it
  WHERE s.subdomain = lower(label) AND s.launched_at IS NOT NULL AND t.deleted_at IS NULL
$$;

-- Every role may run a new function (PUBLIC); this one is for the public API only
REVOKE EXECUTE ON FUNCTION storefront_tenant_for_subdomain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_tenant_for_subdomain(text) TO omnivo_public;
