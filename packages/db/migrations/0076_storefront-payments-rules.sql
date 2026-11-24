-- Custom SQL migration file, put your code below! --
-- Step 27d: who may read and write online payments. 0075 made the gateway account, the payment
-- tries and the order's new pending rule; this file gives the two tables their tenant rules, lets
-- the shop's order routes record a try and the gateway's answer, tells the shop whether it can take
-- online payment without showing it the account, and keeps a paid try for good.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Payment card, the worker's receipt) and omnivo_shop
--    (the tries) both set app.tenant_id to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['storefront_payment_gateways', 'storefront_payments'])
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

-- 2) The gateway account: no grant to omnivo_public or omnivo_shop (decision 4). The shop's server
--    and every shop page run as one of them, and none of them needs the store id or the sealed
--    password: the API reads the account as omnivo_app when it calls the gateway (27d.3). Nothing
--    is written here on purpose: a new table is closed to both until a grant opens it (0064, 0071)

-- 3) What omnivo_shop may do with the tries. Placing an online order and "Try again" make one
--    (INSERT); /checkout/paid reads them (SELECT); settle records the gateway's answer, and only
--    these columns of it. Not the receipt's columns (the worker's, as omnivo_app), and not the
--    amount, the tran_id or the mode: a bug in the shop's routes cannot make a try ask for less
--    money or point at another payment. No DELETE: a pending order's tries go with it through
--    the foreign key's CASCADE, which Postgres runs as the table's owner
GRANT SELECT, INSERT ON storefront_payments TO omnivo_shop;
GRANT UPDATE (status, settled_at, val_id, card_type, bank_tran_id, store_amount)
  ON storefront_payments TO omnivo_shop;
-- "Pay on delivery" (decision 3) turns a pending online order into Cash on Delivery, with its
-- phone code, in one UPDATE; a late payment turns it back (27d.3). The code's columns were granted
-- in 0071; the method was not, because until now nothing changed it
GRANT UPDATE (payment_method) ON storefront_orders TO omnivo_shop;

-- 4) Whether the shop can take online payment now (decision 4): a gateway is saved, its money
--    account is a posting account that is not archived and holds money (itself or a group above
--    it, as contracts' moneyAccountIds() reads the tree), and its fee account is an expense
--    posting account that is not archived. The checkout offers "Pay online" only while this is
--    true, and the Payment card's `ready` is the same answer, so the two never disagree (mine 22).
--    SECURITY DEFINER, because the shop's pages run as omnivo_public, which may read neither the
--    gateway nor the chart of accounts: this answers true or false and nothing else. FORCE RLS
--    holds for the owner too, so tenant_isolation keeps it inside the caller's workspace, and the
--    tenant filter is written out as well, for 0074's reason. UNION, not UNION ALL, so a broken
--    tree with a loop still ends. search_path is fixed for 0064's reason
CREATE FUNCTION storefront_online_ready()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM storefront_payment_gateways g
    JOIN ledger_accounts f ON f.tenant_id = g.tenant_id AND f.id = g.fee_account_id
    WHERE g.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND f.type = 'expense' AND NOT f.is_group AND f.archived_at IS NULL
      AND EXISTS (
        WITH RECURSIVE up AS (
          SELECT a.parent_id, a.holds_money
          FROM ledger_accounts a
          WHERE a.tenant_id = g.tenant_id AND a.id = g.money_account_id
            AND NOT a.is_group AND a.archived_at IS NULL
          UNION
          SELECT p.parent_id, p.holds_money
          FROM ledger_accounts p
          JOIN up ON p.tenant_id = g.tenant_id AND p.id = up.parent_id
        )
        SELECT 1 FROM up WHERE up.holds_money
      )
  )
$$;

-- The shop's pages and the order routes (omnivo_public, and omnivo_shop through it) and the
-- Payment card and the settings' save (omnivo_app, whose membership in omnivo_public does not
-- inherit). Every role may run a new function (PUBLIC), so that right goes first
REVOKE EXECUTE ON FUNCTION storefront_online_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_online_ready() TO omnivo_public, omnivo_app;

-- 5) A paid try is the record that money came (decision 5). The trigger keeps it:
--    - a try's own columns never change: it is always the same order, number, id, gateway, mode
--      and amount (storefront_payments_fixed)
--    - once paid, the gateway's answer never changes, and the try is never deleted, so a pending
--      order with a paid try cannot be swept away either: the CASCADE from the order's delete
--      runs this trigger too, and the whole delete fails (storefront_payments_paid_kept)
--    - a receipt, once linked, stays linked: a receipt is voided, never deleted, and the link says
--      which payment it was (storefront_payments_receipt_kept)
--    - a try that was answered never goes back to started (storefront_payments_not_restarted):
--      "Try again" is a new try, with a new tran_id
--    A trigger and not checks, because the rules compare the row before and after. The CONSTRAINT
--    names are what the API's database-error mapping reads (18c's pattern)
CREATE FUNCTION storefront_payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'payment % was paid, so it is kept', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_paid_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.order_id, NEW.try_no, NEW.tran_id, NEW.provider, NEW.mode,
      NEW.amount, NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.order_id, OLD.try_no, OLD.tran_id, OLD.provider,
      OLD.mode, OLD.amount, OLD.started_at) THEN
    RAISE EXCEPTION 'payment % keeps its order, number, id, gateway and amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_fixed';
  END IF;
  IF OLD.status = 'paid'
     AND (NEW.status, NEW.settled_at, NEW.val_id, NEW.card_type, NEW.bank_tran_id, NEW.store_amount)
       IS DISTINCT FROM (OLD.status, OLD.settled_at, OLD.val_id, OLD.card_type, OLD.bank_tran_id,
         OLD.store_amount) THEN
    RAISE EXCEPTION 'payment % was paid, so it is kept', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_paid_kept';
  END IF;
  IF OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
    RAISE EXCEPTION 'payment % keeps its receipt', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_receipt_kept';
  END IF;
  IF NEW.status = 'started' AND OLD.status <> 'started' THEN
    RAISE EXCEPTION 'payment % was answered, so it cannot start again', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_not_restarted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_payments_guard
  BEFORE UPDATE OR DELETE ON storefront_payments
  FOR EACH ROW EXECUTE FUNCTION storefront_payments_guard();

-- 6) An order's payment method changes only while it is pending ("Pay on delivery", or a late
--    payment that comes before the phone code was typed), the confirming UPDATE included. After
--    that it is what the rider and the books go by: a confirmed Cash on Delivery order that turned
--    "online" would send the rider out with nothing to collect
--    (storefront_orders_payment_method_kept). omnivo_shop's grant above is a column, not a rule
--    about when, and omnivo_app may write every column, so the rule is the database's
CREATE FUNCTION storefront_orders_payment_method_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'order % keeps its payment method once confirmed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_orders_payment_method_kept';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_orders_payment_method_guard
  BEFORE UPDATE OF payment_method ON storefront_orders
  FOR EACH ROW EXECUTE FUNCTION storefront_orders_payment_method_guard();
