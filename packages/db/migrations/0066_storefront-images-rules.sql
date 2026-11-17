-- Custom SQL migration file, put your code below! --
-- Step 26g: the tenant rules for storefront_images (made by 0065), like every tenant table:
-- ENABLE + FORCE RLS + tenant_isolation, with NULLIF as in 0002 (an unset app.tenant_id is '' on a
-- pooled connection, and ''::uuid would throw instead of matching nothing). FORCE keeps the table's
-- owner, the migrator, inside the rule too. The API and the image job both use omnivo_app with
-- app.tenant_id set to the photo's workspace; its SELECT/INSERT/UPDATE/DELETE come from the
-- default privileges in infra/docker/postgres/init/01-roles.sql, as for every table.
ALTER TABLE storefront_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_images FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront_images
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No grant to omnivo_public, on purpose: the shop never reads this table. It turns an image id into
-- an address by itself (storefront/<id>/<size>.webp), and the API saves only ready photos' ids, so
-- a shopper's request has nothing to ask here. 0064 gave the role no default privileges, so the
-- table stays closed to it.
