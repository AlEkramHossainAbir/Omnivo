-- Custom SQL migration file, put your code below! --
-- Step 27a: who may read and write the shop's orders. 0070 made the four tables; this file gives
-- them the tenant rules every table has, lets the shop's pages count the held stock, and makes the
-- role the shop's order routes write as: omnivo_shop.

-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    No TO, so it holds for every role: omnivo_app (the ERP's screens, 27b), omnivo_shop and
--    omnivo_public all set app.tenant_id to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_orders', 'storefront_order_lines', 'storefront_stock_holds',
      'storefront_order_counters'])
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

-- 2) The shop's pages count what is free: on hand minus held (decision 6). omnivo_public reads the
--    holds for that, and only the columns the sum needs: which order holds them is not its
--    business. A hold has no name, phone or address, which is why the holds are a table of their
--    own and not columns on the order lines. Only while the shop is launched, like every
--    storefront table it reads (0064)
GRANT SELECT (tenant_id, warehouse_id, variant_id, quantity, expires_at) ON storefront_stock_holds
  TO omnivo_public;
CREATE POLICY storefront_public_launched ON storefront_stock_holds
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_settings s WHERE s.tenant_id = storefront_stock_holds.tenant_id
  ));

-- 3) The role the order routes write as (decision 22). omnivo_public stays read-only: every page
--    of every shop reads as it, and none of them should ever be able to write. The order routes
--    (place, verify, resend, the order page, tracking) run in their own transaction as
--    omnivo_shop, which can do what omnivo_public does plus the orders, and nothing else in the
--    ERP. NOLOGIN, made here, and IF NOT EXISTS, for 0064's reasons
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omnivo_shop') THEN
    CREATE ROLE omnivo_shop NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO omnivo_shop;
-- INHERIT TRUE: omnivo_shop gets omnivo_public's grants AND its RESTRICTIVE policies (a policy TO a
-- role holds for the roles that inherit from it). So placing an order sees exactly the listings,
-- prices and stock a shopper sees: a draft listing or another warehouse's stock cannot be ordered
-- by a bug, because the database does not show them. It also gets storefront_tenant_for_subdomain
GRANT omnivo_public TO omnivo_shop WITH INHERIT TRUE;
-- The API becomes it with SET LOCAL ROLE, like omnivo_public. INHERIT FALSE for 0064's reason: the
-- ERP must not get these rights, or the policies above, by being a member
GRANT omnivo_shop TO omnivo_app WITH INHERIT FALSE, SET TRUE;

-- 4) What omnivo_shop may write. No default privileges, so a table added later is closed to it.
-- An order: placed (INSERT), dropped after five wrong codes (DELETE; its lines and holds go by
-- CASCADE), and only these columns changed: the code's, and the confirm's. Packed, shipped,
-- delivered and cancelled are the ERP's (27b): a bug in the shop's routes cannot set them, nor
-- change an order's address or amounts after it was placed
GRANT SELECT, INSERT, DELETE ON storefront_orders TO omnivo_shop;
GRANT UPDATE (status, order_no, tracking_token_hash, confirmed_at, code_hash, code_expires_at,
  code_sent_at, code_sends, code_tries_left, updated_at, version) ON storefront_orders TO omnivo_shop;
-- Lines are written once, with the order
GRANT SELECT, INSERT ON storefront_order_lines TO omnivo_shop;
-- Holds: made with the order; confirm ends their expiry. SELECT on every column (the grant to
-- omnivo_public above has five): the confirm finds an order's holds by order_id
GRANT SELECT, INSERT ON storefront_stock_holds TO omnivo_shop;
GRANT UPDATE (expires_at) ON storefront_stock_holds TO omnivo_shop;
-- The number at confirm: INSERT … ON CONFLICT DO UPDATE, which needs all three
GRANT SELECT, INSERT, UPDATE ON storefront_order_counters TO omnivo_shop;
-- Confirm writes storefront.order_confirmed in the same transaction (the bell, and 27b's sales
-- order). INSERT only, as for omnivo_app since 0012: the outbox is the worker's to read
GRANT INSERT ON outbox_events TO omnivo_shop;

-- 5) The worker's sweep (decision 19) drops the pending orders older than SHOP_ORDER_HOLD_MINUTES
--    in EVERY workspace, so tenant_isolation alone would show it nothing. As in 0062: it reads as
--    omnivo_worker, three columns of the pending rows only, enough to know which workspaces have
--    one to drop. The DELETE then runs as omnivo_app inside each workspace. The worker never sees
--    a name, a phone, or a confirmed order
GRANT SELECT (tenant_id, status, created_at) ON storefront_orders TO omnivo_worker;
CREATE POLICY storefront_order_sweep ON storefront_orders
  FOR SELECT
  TO omnivo_worker
  USING (status = 'pending');
