-- Custom SQL migration file, put your code below! --
-- Step 27c: who may read and write the shop's coupons. 0073 made the table and the order's link
-- to it; this file gives it the tenant rules every table has, lets the shop's quote read the
-- coupons and count their uses without reading an order, lets placing an order lock a coupon,
-- and freezes a code once an order has it.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Coupons page), omnivo_public (the quote) and
--    omnivo_shop (placing an order) all set app.tenant_id to one workspace first
ALTER TABLE storefront_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront_coupons
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) The quote reads the coupon a cart names (judgeShopCoupon needs every rule column). The whole
--    table, as 0064 gave the other storefront tables: a coupon has no name, phone or address.
--    Two RESTRICTIVE policies, like a listing's: only while the shop is launched, and never an
--    archived coupon. To the shop an archived code does not exist (decision 2), and this way no
--    bug in a quote or an order can take one. omnivo_shop inherits both (0071, INHERIT TRUE), so
--    placing an order cannot lock an archived coupon either
GRANT SELECT ON storefront_coupons TO omnivo_public;
CREATE POLICY storefront_public_launched ON storefront_coupons
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_settings s WHERE s.tenant_id = storefront_coupons.tenant_id
  ));
CREATE POLICY storefront_public_current ON storefront_coupons
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (archived_at IS NULL);

-- 3) Placing an order takes the coupon's row lock (decision 3): two shoppers who want the last
--    use are then counted one after the other. Postgres asks for UPDATE on at least one column
--    even for SELECT … FOR UPDATE, and the one column the shop has a reason to write is the
--    first order's time (decision 16). Not updated_at or version: an order is not an edit, and a
--    new version would make every open Coupons form fail with a version conflict
GRANT UPDATE (first_ordered_at) ON storefront_coupons TO omnivo_shop;

-- 4) How many orders hold a use of a coupon now (decision 3): the confirmed and later ones and
--    the ones still waiting for their phone code, but not the cancelled ones (a cancel gives the
--    use back), and not a pending order past its hold (SHOP_ORDER_HOLD_MINUTES): it can no longer
--    be confirmed, so its use is free again even before the worker's sweep deletes it, as its
--    stock is (27a's holds). With p_phone, only that mobile number's orders: once per phone.
--    p_since is "now minus the hold" from the API, so the minutes stay in the contracts and a
--    test's clock is the clock here too.
--    One function, so the quote, placing an order and the Coupons page count a use the same way.
--    SECURITY DEFINER, because the quote runs as omnivo_public, which may not read an order
--    (names, phones and addresses): this answers a number and nothing else. FORCE RLS holds for
--    the owner too, so tenant_isolation keeps it inside the caller's workspace; the tenant
--    filter is written out as well, so it would stay inside even if the owner skipped row
--    security one day. search_path is fixed for 0064's reason
CREATE FUNCTION storefront_coupon_uses(p_coupon_id uuid, p_since timestamptz, p_phone text DEFAULT NULL)
  RETURNS integer
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM storefront_orders o
  WHERE o.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND o.coupon_id = p_coupon_id
    AND o.status <> 'cancelled'
    AND (o.status <> 'pending' OR o.created_at > p_since)
    AND (p_phone IS NULL OR o.phone = p_phone)
$$;

-- Every role may run a new function (PUBLIC). The quote (omnivo_public, and omnivo_shop through
-- it) and the Coupons page (omnivo_app, whose membership in omnivo_public does not inherit)
REVOKE EXECUTE ON FUNCTION storefront_coupon_uses(uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_coupon_uses(uuid, timestamptz, text) TO omnivo_public, omnivo_app;

-- 5) A code with an order is frozen (decision 2). The order's foreign key (0073) already refuses
--    a new code while that order exists, but a pending order that was dropped had the code too,
--    and so did a cancelled one that may be deleted one day; first_ordered_at remembers them all.
--    A trigger and not a CHECK, because the rule compares the row before and after. It reads the
--    row as it is when the UPDATE runs: when the Coupons page saves a new code while an order is
--    being placed, the save waits for the order's row lock and then sees its first_ordered_at.
--    The CONSTRAINT names are what the API answers by (storefront_coupon_code_locked)
CREATE FUNCTION storefront_coupons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_ordered_at IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'coupon % has orders, so its code cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_coupons_code_locked';
  END IF;
  -- Once set, kept: set back to NULL, it would let the code change after all
  IF OLD.first_ordered_at IS NOT NULL
     AND NEW.first_ordered_at IS DISTINCT FROM OLD.first_ordered_at THEN
    RAISE EXCEPTION 'coupon % keeps the time of its first order', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_coupons_first_ordered_kept';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_coupons_guard
  BEFORE UPDATE ON storefront_coupons
  FOR EACH ROW EXECUTE FUNCTION storefront_coupons_guard();
