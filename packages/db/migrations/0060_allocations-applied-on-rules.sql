-- Custom SQL migration file, put your code below! --
-- Step 21b: the day each allocation started to count (applied_on), for the receivables and
-- payables aging as of a day. 0059 added the four columns empty; this file fills them, makes them
-- required, indexes them, and keeps every new one from being earlier than its two documents.

-- 1) The allocations made before this step get the later of their two documents' dates. That is
--    the day an allocation made with its document has from now on (a receipt applied when it was
--    made, a credit note when it was posted). One applied again later had a later day, which
--    nothing recorded, so it gets the earliest day it could have had.
--    Per workspace, a deleted one too (it may be restored), with app.tenant_id set, because FORCE
--    RLS applies to the table owner too (0024, 0058); cleared at the end.
--    The tables' own triggers are off for these UPDATEs. The AFTER triggers (0030, 0032, 0040,
--    0042) would take every amount off its invoice or bill and put it back: a write to every paid
--    document, for nothing. 0040's guard would only check what is already true. DISABLE TRIGGER
--    USER leaves the foreign keys' own triggers on; the ALTER is part of this migration's
--    transaction, so a failure turns them back on with everything else.
ALTER TABLE receipt_allocations DISABLE TRIGGER USER;
ALTER TABLE credit_note_allocations DISABLE TRIGGER USER;
ALTER TABLE supplier_payment_allocations DISABLE TRIGGER USER;
ALTER TABLE debit_note_allocations DISABLE TRIGGER USER;

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);

    UPDATE receipt_allocations a
       SET applied_on = greatest(r.date, i.date)
      FROM receipts r, invoices i
     WHERE a.tenant_id = t
       AND r.tenant_id = a.tenant_id AND r.id = a.receipt_id
       AND i.tenant_id = a.tenant_id AND i.id = a.invoice_id;

    UPDATE credit_note_allocations a
       SET applied_on = greatest(c.date, i.date)
      FROM credit_notes c, invoices i
     WHERE a.tenant_id = t
       AND c.tenant_id = a.tenant_id AND c.id = a.credit_note_id
       AND i.tenant_id = a.tenant_id AND i.id = a.invoice_id;

    UPDATE supplier_payment_allocations a
       SET applied_on = greatest(p.date, b.date)
      FROM supplier_payments p, bills b
     WHERE a.tenant_id = t
       AND p.tenant_id = a.tenant_id AND p.id = a.payment_id
       AND b.tenant_id = a.tenant_id AND b.id = a.bill_id;

    UPDATE debit_note_allocations a
       SET applied_on = greatest(d.date, b.date)
      FROM debit_notes d, bills b
     WHERE a.tenant_id = t
       AND d.tenant_id = a.tenant_id AND d.id = a.debit_note_id
       AND b.tenant_id = a.tenant_id AND b.id = a.bill_id;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

ALTER TABLE receipt_allocations ENABLE TRIGGER USER;
ALTER TABLE credit_note_allocations ENABLE TRIGGER USER;
ALTER TABLE supplier_payment_allocations ENABLE TRIGGER USER;
ALTER TABLE debit_note_allocations ENABLE TRIGGER USER;

-- 2) Required from now on. SET NOT NULL reads every row whatever the RLS policy says, so a row
--    the loop above missed fails the migration here instead of staying empty.
ALTER TABLE receipt_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE credit_note_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE supplier_payment_allocations ALTER COLUMN applied_on SET NOT NULL;
ALTER TABLE debit_note_allocations ALTER COLUMN applied_on SET NOT NULL;

-- 3) The schema's indexes (what was applied after a day), built here, once, on the filled
--    columns, instead of in 0059 and then again row by row by the UPDATEs.
CREATE INDEX receipt_allocations_applied_idx
  ON receipt_allocations USING btree (tenant_id, applied_on);
CREATE INDEX credit_note_allocations_applied_idx
  ON credit_note_allocations USING btree (tenant_id, applied_on);
CREATE INDEX supplier_payment_allocations_applied_idx
  ON supplier_payment_allocations USING btree (tenant_id, applied_on);
CREATE INDEX debit_note_allocations_applied_idx
  ON debit_note_allocations USING btree (tenant_id, applied_on);

-- 4) Never earlier than either document. The aging as of a day D counts a document dated D or
--    before, less what was applied to it on D or before. An allocation dated before its receipt
--    would take money off the invoice on a day the receipt is not counted yet, and the aging
--    would no longer add up to the books' balance. So every write is moved up to the later of
--    the two dates: the API says the day it means (the document's date, or today when money is
--    applied again), and the database makes sure of the rest under every path that writes.
--    A NULL from the API becomes the later date too (greatest() skips NULLs); the Drizzle type
--    still asks for it, so a writer always says which day it means.
--    Scalar subqueries, not SELECT … INTO: a document that does not exist gives NULL here and the
--    foreign key refuses the row with its own error, instead of a confusing NOT NULL one.
--    Only a draft supplier payment's date changes after its allocations are written, and its plan
--    is written again with it (supplier-payments.service.ts, update), so the rule still holds.
CREATE FUNCTION receipt_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM receipts WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id),
    (SELECT date FROM invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER receipt_allocations_applied_on
  BEFORE INSERT OR UPDATE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION receipt_allocations_applied_on();

CREATE FUNCTION credit_note_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM credit_notes WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id),
    (SELECT date FROM invoices WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER credit_note_allocations_applied_on
  BEFORE INSERT OR UPDATE ON credit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION credit_note_allocations_applied_on();

CREATE FUNCTION supplier_payment_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM supplier_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id),
    (SELECT date FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_payment_allocations_applied_on
  BEFORE INSERT OR UPDATE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocations_applied_on();

CREATE FUNCTION debit_note_allocations_applied_on() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := greatest(
    NEW.applied_on,
    (SELECT date FROM debit_notes WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id),
    (SELECT date FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id)
  );
  RETURN NEW;
END $$;

CREATE TRIGGER debit_note_allocations_applied_on
  BEFORE INSERT OR UPDATE ON debit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION debit_note_allocations_applied_on();
