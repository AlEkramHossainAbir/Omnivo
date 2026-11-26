-- Custom SQL migration file, put your code below! --
-- Step 28a: who may read and write the couriers. 0077 made the courier accounts, the parcels and
-- their events; this file gives the three tables their tenant rules, lets the tracking page read
-- a parcel's way, lets the worker's poll find the workspaces with parcels on their way, finds a
-- webhook's account before the workspace is known, and keeps what must not change.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Shop couriers page, the order page, the booking job,
--    the webhook once it knows the account) and omnivo_shop (the tracking page) set app.tenant_id
--    to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['courier_accounts', 'storefront_shipments', 'storefront_shipment_events'])
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

-- 2) The courier accounts: no grant to omnivo_public or omnivo_shop. The shop never needs the
--    keys, the token's hash or even the account's name: a parcel carries its own courier. As for
--    the payment gateway (0076), nothing is written here on purpose

-- 3) The tracking page (a tracking link and /track) runs as omnivo_shop (27a's ShopDb.orders). It
--    reads a parcel's courier, code and courier page, and its events: only those columns. Not the
--    account, the COD amount, the courier's id, the errors or the raw bodies. And only a parcel
--    the courier gave a code to (mine 17): a RESTRICTIVE policy, so a bug in the API's query
--    cannot show "booking" or "booking failed" to a shopper. An event with no status (a notice we
--    could not read) is hidden the same way
GRANT SELECT (tenant_id, id, order_id, parcel_no, courier, status, tracking_code, tracking_url)
  ON storefront_shipments TO omnivo_shop;
CREATE POLICY storefront_shipments_shop_booked ON storefront_shipments
  AS RESTRICTIVE FOR SELECT TO omnivo_shop
  USING (status NOT IN ('booking', 'booking_failed'));
GRANT SELECT (tenant_id, shipment_id, status, note, occurred_at)
  ON storefront_shipment_events TO omnivo_shop;
CREATE POLICY storefront_shipment_events_shop_read ON storefront_shipment_events
  AS RESTRICTIVE FOR SELECT TO omnivo_shop
  USING (status IS NOT NULL);

-- 4) The worker's poll (decision 9) asks about the parcels still on their way in EVERY workspace,
--    so tenant_isolation alone would show it nothing. As in 0062 and 0071: it reads as
--    omnivo_worker, the workspace and the status of the open parcels only, enough to know which
--    workspaces to queue. The courier calls then run as omnivo_app inside each workspace. The
--    list is OPEN_SHIPMENT_STATUSES, as in 0077's two indexes
GRANT SELECT (tenant_id, status) ON storefront_shipments TO omnivo_worker;
CREATE POLICY storefront_shipments_poll ON storefront_shipments
  FOR SELECT
  TO omnivo_worker
  USING (status IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold',
    'returning'));

-- 5) From a webhook's address to its workspace (decision 8). The courier's call knows only the
--    account's id, so it cannot set app.tenant_id yet. This function looks across workspaces and
--    answers one row for one id: the workspace and the token's hash, which the API compares with
--    the bearer token before it reads the body. Nothing for an unknown id, a manual account, an
--    account of another provider (Steadfast's address with 28c's Pathao account) or a deleted
--    workspace. An archived account still answers: its parcels on their way still get their news
--    (28a.1's archiveCourier).
--    SECURITY DEFINER, with a policy for its owner (the migrator) to read across workspaces, as
--    0064's storefront_tenant_for_subdomain. search_path is fixed for 0064's reason
CREATE POLICY courier_webhook_lookup ON courier_accounts
  FOR SELECT TO omnivo_migrator
  USING (true);

CREATE FUNCTION courier_account_for_webhook(account_id uuid, provider_name text)
  RETURNS TABLE (tenant_id uuid, webhook_token_hash text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT a.tenant_id, a.webhook_token_hash
  FROM courier_accounts a
  JOIN tenants t ON t.id = a.tenant_id
  WHERE a.id = account_id AND a.provider = provider_name AND a.provider <> 'manual'
    AND t.deleted_at IS NULL
$$;

-- The webhook's controller runs as omnivo_app with no workspace yet. Every role may run a new
-- function (PUBLIC), so that right goes first
REVOKE EXECUTE ON FUNCTION courier_account_for_webhook(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION courier_account_for_webhook(uuid, text) TO omnivo_app;

-- 6) An account's provider never changes (courier_accounts_provider_fixed): its keys, its webhook
--    address and its parcels are that provider's. And an account is never deleted
--    (courier_accounts_kept): its parcels name it. The API answers courier_provider_fixed first;
--    this is the last word. The CONSTRAINT names are what the API's database-error mapping reads
CREATE FUNCTION courier_accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'courier account % is archived, never deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'courier_accounts_kept';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.provider) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.provider) THEN
    RAISE EXCEPTION 'courier account % keeps its provider', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'courier_accounts_provider_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER courier_accounts_guard
  BEFORE UPDATE OR DELETE ON courier_accounts
  FOR EACH ROW EXECUTE FUNCTION courier_accounts_guard();

-- 7) A parcel (decision 3):
--    - is made for a confirmed order, and its invoice is that order's number (with "-2" to "-5"
--      for a later parcel): the courier finds it by that number, so a wrong one would lose it
--      (storefront_shipments_invoice_check). A check cannot read the order, so a trigger does
--    - keeps its order, account, number, invoice, courier and COD amount: the courier was told
--      these (storefront_shipments_fixed)
--    - keeps the courier's id, its tracking code and its booking time once it has them: the
--      shopper got the code by SMS (storefront_shipments_code_kept)
--    - moves only forward: back to booking only from booking_failed ("Book again"), to
--      booking_failed only from booking, and never out of cancelled or returned
--      (storefront_shipments_not_reopened)
--    - is never deleted (storefront_shipments_kept)
CREATE FUNCTION storefront_shipments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'parcel % is kept', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_kept';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The CASE is worked out first: inside an IF's condition, PL/pgSQL would take the CASE's
    -- own THEN as the IF's
    SELECT o.order_no || CASE WHEN NEW.parcel_no = 1 THEN '' ELSE '-' || NEW.parcel_no END
      INTO expected
    FROM storefront_orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
    IF expected IS NULL OR NEW.invoice <> expected THEN
      RAISE EXCEPTION 'parcel % must carry its order''s number', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_invoice_check';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.order_id, NEW.courier_account_id, NEW.parcel_no, NEW.invoice,
      NEW.courier, NEW.cod_amount, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.order_id, OLD.courier_account_id, OLD.parcel_no,
      OLD.invoice, OLD.courier, OLD.cod_amount, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'parcel % keeps its order, account, invoice and amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_fixed';
  END IF;
  IF (OLD.tracking_code IS NOT NULL AND NEW.tracking_code IS DISTINCT FROM OLD.tracking_code)
     OR (OLD.consignment_id IS NOT NULL AND NEW.consignment_id IS DISTINCT FROM OLD.consignment_id)
     OR (OLD.booked_at IS NOT NULL AND NEW.booked_at IS DISTINCT FROM OLD.booked_at) THEN
    RAISE EXCEPTION 'parcel % keeps its tracking code', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_code_kept';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND ((NEW.status = 'booking' AND OLD.status <> 'booking_failed')
       OR (NEW.status = 'booking_failed' AND OLD.status <> 'booking')
       OR OLD.status IN ('cancelled', 'returned')) THEN
    RAISE EXCEPTION 'parcel % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_not_reopened';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_shipments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_guard();

-- 8) The courier's news is a record (§14.7): an event is never changed or deleted, like a stock
--    movement (0022). A later notice is a new row. omnivo_app has UPDATE and DELETE on every
--    table (default privileges), so the rule lives here
CREATE FUNCTION storefront_shipment_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'parcel event % cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipment_events_append_only';
END;
$$;

CREATE TRIGGER storefront_shipment_events_append_only
  BEFORE UPDATE OR DELETE ON storefront_shipment_events
  FOR EACH ROW EXECUTE FUNCTION storefront_shipment_events_append_only();
