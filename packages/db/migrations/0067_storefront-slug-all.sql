-- Custom SQL migration file, put your code below! --
-- Step 26h: 0068 adds storefront_categories_slug_reserved_check (a category may not be called
-- "all", because /c/all is the shop's All Products page). Step 26g's screens allowed that slug, so
-- a workspace may have one already, and ADD CONSTRAINT would then fail the whole deploy. This file
-- gives such a category another slug first: "all-" and the last 12 characters of its id (the
-- random part of a uuidv7; the first part is the time, which two rows made close together share).
-- The category could never be opened anyway: the shop answered /c/all with All Products.
-- version + 1, so a Storefront screen still open on the old row gets a conflict when it saves,
-- instead of writing "all" back (the contracts refuse that now, but with a less helpful error).
-- Per workspace with app.tenant_id set, because FORCE RLS applies to the table owner too (0060);
-- cleared at the end. A deleted workspace too: it may be restored.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);

    UPDATE storefront_categories
       SET slug = 'all-' || right(id::text, 12),
           updated_at = now(),
           version = version + 1
     WHERE tenant_id = t AND slug = 'all';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
