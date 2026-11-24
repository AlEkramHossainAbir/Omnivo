-- Custom SQL migration file, put your code below! --
-- Step 28b: the rules of the courier's COD money. 0080 gave each courier account its COD and
-- charge accounts, and each parcel what the rider collected, the courier's charge and its COD
-- receipt; this file keeps a parcel's receipt for good and makes sure it is the parcel's money.

-- 1) No grant for the shop. omnivo_shop reads the parcels by column (0078 and 0079), so the four
--    new columns are closed to it without a line here: the tracking page never shows money, and a
--    tracking link can be forwarded. Nothing is written here on purpose. omnivo_app writes them
--    (Delivered, the courier's news, "Make the receipt"), with every column, as for every table.
--    The worker's poll reads only the workspace and the status of the open parcels (0078), and a
--    parcel with a receipt is no longer open

-- 2) A parcel's COD receipt (decision 4, mine 14):
--    - once linked, it stays linked, and what was collected stays what the receipt says: a receipt
--      is voided, never deleted, and 28c's payout pays a parcel by its receipt
--      (storefront_shipments_receipt_kept)
--    - it is linked only while the parcel is delivered or partly delivered, and only a receipt
--      that is this parcel's money: posted, by `courier`, for exactly what was collected, into the
--      COD account of the parcel's courier account (storefront_shipments_receipt_match). A bug that
--      linked another receipt, or the right one for the wrong amount, would put money in the
--      courier's balance (decision 12) that the courier never collected. 0080's check cannot read
--      the receipt or the account, so a trigger does, when the link is made. Later the parcel may
--      still move (a delivered parcel the courier says came back) and the account may get another
--      COD account: the receipt stays what it was when it was made
--    Its own trigger, next to 0078's storefront_shipments_guard, so that guard is not written
--    again here. Triggers on one table run in the order of their names; the two never disagree,
--    so the order does not matter. The CONSTRAINT names are what the API's database-error mapping
--    reads (18c's pattern)
CREATE FUNCTION storefront_shipments_cod_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.receipt_id IS NOT NULL
     AND (NEW.receipt_id, NEW.collected_amount) IS DISTINCT FROM (OLD.receipt_id, OLD.collected_amount) THEN
    RAISE EXCEPTION 'parcel % keeps its COD receipt and what was collected', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_kept';
  END IF;
  IF NEW.receipt_id IS NOT NULL AND OLD.receipt_id IS NULL THEN
    IF NEW.status NOT IN ('delivered', 'partly_delivered') THEN
      RAISE EXCEPTION 'parcel % is %, so it has no COD receipt', NEW.id, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_match';
    END IF;
    PERFORM 1
    FROM receipts r
    JOIN courier_accounts a ON a.tenant_id = NEW.tenant_id AND a.id = NEW.courier_account_id
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.receipt_id
      AND r.status = 'posted' AND r.method = 'courier'
      AND r.amount = NEW.collected_amount AND r.account_id = a.cod_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'receipt % is not parcel %''s COD money', NEW.receipt_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_shipments_cod_guard
  BEFORE UPDATE ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_cod_guard();
