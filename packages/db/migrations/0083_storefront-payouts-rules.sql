-- Custom SQL migration file, put your code below! --
-- Step 28c: the rules of the courier's payout. 0082 made the payouts and their lines, gave each
-- parcel the payout that paid it out and each courier account its saved CSV map; this file gives
-- the two tables their tenant rules and keeps the money right: a parcel is paid out once, by its
-- own receipt's money, and a payout never changes but to be voided.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role. Only omnivo_app uses them (the payout pages): no grant to
--    omnivo_public, omnivo_shop or omnivo_worker, so the shop and the worker cannot read a payout
--    at all. Nothing is written here on purpose. The parcel's new payout_id and the account's
--    payout_csv_map are closed to the shop the same way: it reads those tables by column (0078)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_payouts', 'storefront_payout_lines'])
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

-- 2) A payout (decision 6) is saved posted, never deleted (its number is in the books), and while
--    posted only one thing may happen to it: it is voided (status, the void date and reason, and
--    the version). A voided payout never changes again. As receipts_guard (0030), it compares the
--    whole row without the columns that may move, so a column added later is fixed too
CREATE FUNCTION storefront_payouts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payout % is saved posted', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status = 'voided'
     AND to_jsonb(NEW) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by']
       = to_jsonb(OLD) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payout % can only be voided, once', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_immutable';
END;
$$;

CREATE TRIGGER storefront_payouts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_payouts
  FOR EACH ROW EXECUTE FUNCTION storefront_payouts_guard();

-- 3) A payout's line (decisions 4 and 5):
--    - is written with its payout, before its parcels are linked, and never changed or deleted
--      (storefront_payout_lines_immutable). Once a parcel points at the payout, a line added later
--      would be money nobody checked. A voided payout takes no line either
--    - pays the parcel's own money (storefront_payout_lines_parcel_check). A cod line is the
--      parcel's COD receipt, still posted, for exactly what it took in, into the COD account the
--      payout credits: anything else would take money out of the COD account that was never put
--      in. A charge line is a parcel with no COD receipt (a parcel that has one is paid by its
--      receipt, or its money would stay in the COD account for good) whose journey is over:
--      delivered with nothing to collect, partly delivered with ৳0, returned or cancelled. A
--      parcel still on its way may still bring money, so it is not paid out yet
--    The receipt is read FOR SHARE: a void of the same receipt at the same moment waits for this
--    transaction, and then section 6 refuses it; or the void went first, and this read sees it
--    voided. Without the lock both would commit (each saw the other's old row), and the payout
--    would take a voided receipt's money out of the COD account
CREATE FUNCTION storefront_payout_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payout storefront_payouts%ROWTYPE;
  parcel storefront_shipments%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payout % keeps its lines', OLD.payout_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_immutable';
  END IF;
  SELECT * INTO payout FROM storefront_payouts p
  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payout_id;
  IF payout.status <> 'posted' OR EXISTS (
       SELECT 1 FROM storefront_shipments s
       WHERE s.tenant_id = NEW.tenant_id AND s.payout_id = NEW.payout_id) THEN
    RAISE EXCEPTION 'payout % takes no more lines', NEW.payout_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_immutable';
  END IF;
  SELECT * INTO parcel FROM storefront_shipments s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shipment_id;
  IF NEW.kind = 'cod' THEN
    PERFORM 1 FROM receipts r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.receipt_id
      AND parcel.receipt_id = r.id AND r.status = 'posted' AND r.amount = NEW.collected
      AND r.account_id = payout.cod_account_id
    FOR SHARE;
    IF FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF parcel.receipt_id IS NULL
     AND parcel.status IN ('delivered', 'partly_delivered', 'returned', 'cancelled') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'parcel % is not a % line of payout %', NEW.shipment_id, NEW.kind, NEW.payout_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_parcel_check';
END;
$$;

CREATE TRIGGER storefront_payout_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_payout_lines
  FOR EACH ROW EXECUTE FUNCTION storefront_payout_lines_guard();

-- 4) At the end of the transaction that saved or voided it, a payout adds up
--    (storefront_payouts_lines_check): 1 to 500 lines (MAX_PAYOUT_LINES), its collected and
--    charges are the sums of its lines, and its parcels point at it while it is posted, all of
--    them, and none once voided. A check runs per row and cannot see the lines, so this is a
--    constraint trigger deferred to COMMIT, when the API has written the payout, its lines and its
--    parcels in whatever order. "All of them" is a count: section 5 lets a parcel point at a
--    payout only with a line in it, and a payout has one line per parcel (the primary key), so as
--    many parcels as lines means every line's parcel.
--    The row is read again: a deferred trigger gets the row as it was when the event happened, and
--    a payout saved and voided in one transaction would be checked as posted. How many parcels it
--    should have is worked out before the IF, for 0078's reason (PL/pgSQL would take the CASE's
--    own THEN as the IF's)
CREATE FUNCTION storefront_payouts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payout storefront_payouts%ROWTYPE;
  line_count integer;
  collected_sum numeric;
  charge_sum numeric;
  linked integer;
  should_link integer;
BEGIN
  SELECT * INTO payout FROM storefront_payouts p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.id;
  SELECT count(*), coalesce(sum(l.collected), 0), coalesce(sum(l.charge), 0)
    INTO line_count, collected_sum, charge_sum
  FROM storefront_payout_lines l
  WHERE l.tenant_id = payout.tenant_id AND l.payout_id = payout.id;
  SELECT count(*) INTO linked
  FROM storefront_shipments s
  WHERE s.tenant_id = payout.tenant_id AND s.payout_id = payout.id;
  should_link := CASE payout.status WHEN 'posted' THEN line_count ELSE 0 END;
  IF line_count NOT BETWEEN 1 AND 500
     OR collected_sum <> payout.collected OR charge_sum <> payout.charges
     OR linked <> should_link THEN
    RAISE EXCEPTION 'payout % does not add up: % lines, % parcels linked', payout.id, line_count,
      linked
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_lines_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER storefront_payouts_check
  AFTER INSERT OR UPDATE ON storefront_payouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION storefront_payouts_check();

-- 5) A parcel's payout (decision 6, storefront_shipments_payout_check): set only from none to a
--    posted payout with a line for this parcel, and cleared only when that payout is voided. Never
--    moved from one payout to another: two payouts at once both lock the row, and the second one
--    then finds it taken (its UPDATE … WHERE payout_id IS NULL matches nothing, and if it did not
--    ask, this refuses it). That the payout is of the parcel's own courier account is 0082's
--    foreign key. Its own trigger, next to 0078's and 0081's, so neither is written again here
CREATE FUNCTION storefront_shipments_payout_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payout_id IS NOT DISTINCT FROM OLD.payout_id THEN
    RETURN NEW;
  END IF;
  IF OLD.payout_id IS NULL THEN
    PERFORM 1
    FROM storefront_payouts p
    JOIN storefront_payout_lines l
      ON l.tenant_id = p.tenant_id AND l.payout_id = p.id AND l.shipment_id = NEW.id
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payout_id AND p.status = 'posted';
    IF FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.payout_id IS NULL THEN
    PERFORM 1
    FROM storefront_payouts p
    WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.payout_id AND p.status = 'voided';
    IF FOUND THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'parcel % cannot go from payout % to %', OLD.id, OLD.payout_id, NEW.payout_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_payout_check';
END;
$$;

CREATE TRIGGER storefront_shipments_payout_guard
  BEFORE UPDATE OF payout_id ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_payout_guard();

-- 6) A COD receipt whose parcel a posted payout paid out is not voided (receipts_paid_out, mine
--    26): the payout already took its money out of the COD account, so a void would leave that
--    account below what the courier holds. The payout is voided first, then the receipt. An
--    ordinary receipt has no parcel, so this costs it one look-up by 0080's unique index. Read
--    with a new snapshot (a PL/pgSQL query in READ COMMITTED), so a payout that committed while
--    this void waited for section 3's lock is seen
CREATE FUNCTION receipts_paid_out_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'voided' AND EXISTS (
       SELECT 1 FROM storefront_shipments s
       WHERE s.tenant_id = OLD.tenant_id AND s.receipt_id = OLD.id AND s.payout_id IS NOT NULL) THEN
    RAISE EXCEPTION 'receipt % was paid out by a courier payout', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipts_paid_out';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipts_paid_out_guard
  BEFORE UPDATE OF status ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_paid_out_guard();
