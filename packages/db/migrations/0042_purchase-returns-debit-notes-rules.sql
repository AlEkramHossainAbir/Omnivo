-- Custom SQL migration file, put your code below! --
-- 1) The seven new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'purchase_returns', 'purchase_return_lines', 'debit_notes', 'debit_note_lines',
      'debit_note_expenses', 'debit_note_allocations', 'supplier_refunds'
    ])
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

-- 2) A purchase return is 0032's sales return the other way round: a draft is changed and deleted
--    freely, a posted one never changes, because what left the warehouse left.
--    Posting finishes what the API did first (17d.3 writes the lines, the receipt lines and the
--    order lines, then sets the return to posted last), under every path that writes:
--    - every line has its value;
--    - a line from a receipt line took that line's own lot, and only serial numbers that came in on
--      it (decision 15);
--    - it remembers the bill line that billed the receipt line, exactly when one had: a posted bill
--      line of that receipt line, or none and the receipt line not billed. A bill posted at the
--      same moment fails here or in its own check (section 8), never both pass;
--    - the receipt line counts it: its returned quantity is what the posted returns sent back, this
--      one included.
CREATE FUNCTION purchase_returns_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'purchase return % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_returns_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.status = 'posted' THEN
    IF EXISTS (
         SELECT 1 FROM purchase_return_lines
          WHERE tenant_id = NEW.tenant_id AND return_id = NEW.id AND value IS NULL) THEN
      RAISE EXCEPTION 'purchase return % has lines with no value', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_returns_value_check';
    END IF;
    IF EXISTS (
         SELECT 1
           FROM purchase_return_lines l
           JOIN goods_receipt_lines gl ON gl.tenant_id = l.tenant_id AND gl.id = l.receipt_line_id
          WHERE l.tenant_id = NEW.tenant_id AND l.return_id = NEW.id
            AND (l.batch_id IS DISTINCT FROM gl.batch_id
                 OR NOT l.serial_numbers <@ gl.serial_numbers
                 OR (l.bill_line_id IS NULL AND gl.billed)
                 OR (l.bill_line_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1
                     FROM bill_lines bl
                     JOIN bills b ON b.tenant_id = bl.tenant_id AND b.id = bl.bill_id
                    WHERE bl.tenant_id = l.tenant_id AND bl.id = l.bill_line_id
                      AND bl.receipt_line_id = l.receipt_line_id AND b.status = 'posted'))
                 OR gl.returned_quantity <> (
                   SELECT sum(o.base_quantity)
                     FROM purchase_return_lines o
                     JOIN purchase_returns r ON r.tenant_id = o.tenant_id AND r.id = o.return_id
                    WHERE o.tenant_id = l.tenant_id AND o.receipt_line_id = l.receipt_line_id
                      AND (r.status = 'posted' OR r.id = NEW.id)))) THEN
      RAISE EXCEPTION 'purchase return % does not match the goods receipt lines it sends back', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_returns_receipts_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_returns_guard
  BEFORE UPDATE OR DELETE ON purchase_returns
  FOR EACH ROW EXECUTE FUNCTION purchase_returns_guard();

-- The lines: only while the return is a draft, like a sales return's. One change is allowed on a
-- posted return's line: a debit note's posting adds to debited_quantity, with nothing else. It
-- only grows: a debit note is never undone. A line from a receipt line names a line of a posted
-- goods receipt of the return's supplier. When a draft is deleted its lines cascade; the header is
-- gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION purchase_return_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_supplier uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.debited_quantity > OLD.debited_quantity
     AND to_jsonb(NEW) - 'debited_quantity' = to_jsonb(OLD) - 'debited_quantity' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM purchase_returns
         WHERE tenant_id = OLD.tenant_id AND id = OLD.return_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM purchase_returns
         WHERE tenant_id = NEW.tenant_id AND id = NEW.return_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted purchase return cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_return_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.receipt_line_id IS NOT NULL THEN
    SELECT supplier_id INTO v_supplier
      FROM purchase_returns WHERE tenant_id = NEW.tenant_id AND id = NEW.return_id;
    -- NULL: no such return — the foreign key gives that error. The receipt line's own existence
    -- is its key's.
    IF v_supplier IS NOT NULL AND EXISTS (
         SELECT 1
           FROM goods_receipt_lines gl
           JOIN goods_receipts g ON g.tenant_id = gl.tenant_id AND g.id = gl.receipt_id
          WHERE gl.tenant_id = NEW.tenant_id AND gl.id = NEW.receipt_line_id
            AND (g.status <> 'posted' OR g.supplier_id <> v_supplier)) THEN
      RAISE EXCEPTION 'a purchase return line sends back a line of a posted goods receipt of its supplier'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_return_lines_receipt_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER purchase_return_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_return_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_return_lines_guard();

-- 3) A debit note, 0032's credit note with a bill that may be missing:
--    - a draft is changed and deleted freely. With a bill, it debits a posted bill, is not dated
--      before it, and carries the bill's own branch and "prices include VAT" (decision 19): a line
--      debited in full then takes off exactly what it charged;
--    - posting needs something to take off: a line or an expense;
--    - a posted one is in the books and in the supplier's file: never deleted, never voided. Only
--      its money moves: applied (section 5's trigger; the API bumps the version) and refunded
--      (section 6's).
CREATE FUNCTION debit_notes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bill record;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status = 'posted' THEN
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by']
           = to_jsonb(OLD) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'debit note % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_notes_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.bill_id IS NOT NULL THEN
    SELECT status, date, branch_id, prices_include_vat INTO v_bill
      FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
    -- Not found: no such bill — the foreign key gives that error
    IF FOUND AND (v_bill.status <> 'posted' OR NEW.date < v_bill.date
                  OR NEW.branch_id <> v_bill.branch_id
                  OR NEW.prices_include_vat <> v_bill.prices_include_vat) THEN
      RAISE EXCEPTION 'a debit note debits a posted bill, from its date, with its branch and prices'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_notes_bill_check';
    END IF;
  END IF;

  IF NEW.status = 'posted'
     AND NOT EXISTS (SELECT 1 FROM debit_note_lines
                      WHERE tenant_id = NEW.tenant_id AND debit_note_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM debit_note_expenses
                      WHERE tenant_id = NEW.tenant_id AND debit_note_id = NEW.id) THEN
    RAISE EXCEPTION 'debit note % takes nothing off', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_notes_lines_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER debit_notes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON debit_notes
  FOR EACH ROW EXECUTE FUNCTION debit_notes_guard();

-- The lines: only while the debit note is a draft, like a credit note's. And what the keys cannot
-- see:
--    - a line with no bill belongs to a debit note with no bill (the key that holds bill_id is not
--      checked when it is NULL);
--    - a return line is of a posted return of the debit note's supplier: a draft return can still
--      change. Without a bill, it is a line on its own (decision 9): a receipt line's goods were
--      either billed (debit them on that bill) or not (the bill bills less).
CREATE FUNCTION debit_note_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_note record;
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM debit_notes
         WHERE tenant_id = OLD.tenant_id AND id = OLD.debit_note_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM debit_notes
         WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted debit note cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_note_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT supplier_id, bill_id INTO v_note
    FROM debit_notes WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id;
  -- Not found: no such debit note — the foreign key gives that error
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.bill_id IS NULL AND v_note.bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'a debit note line debits a line of its debit note''s bill'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_note_lines_bill_check';
  END IF;
  IF NEW.return_line_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM purchase_return_lines rl
         JOIN purchase_returns r ON r.tenant_id = rl.tenant_id AND r.id = rl.return_id
        WHERE rl.tenant_id = NEW.tenant_id AND rl.id = NEW.return_line_id
          AND (r.status <> 'posted' OR r.supplier_id <> v_note.supplier_id
               OR (NEW.bill_id IS NULL AND rl.receipt_line_id IS NOT NULL))) THEN
    RAISE EXCEPTION 'a debit note line takes money off a line of a posted return of its supplier'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_note_lines_return_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER debit_note_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON debit_note_lines
  FOR EACH ROW EXECUTE FUNCTION debit_note_lines_guard();

-- The expenses: only while the debit note is a draft, checked before (OLD) and after (NEW)
CREATE FUNCTION debit_note_expenses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM debit_notes
         WHERE tenant_id = OLD.tenant_id AND id = OLD.debit_note_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM debit_notes
         WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the expenses of a posted debit note cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'debit_note_expenses_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER debit_note_expenses_guard
  BEFORE INSERT OR UPDATE OR DELETE ON debit_note_expenses
  FOR EACH ROW EXECUTE FUNCTION debit_note_expenses_guard();

-- 4) A supplier refund is never deleted: like a payment, its number is on paper. While posted it
--    may be voided (status, the void date and reason), nothing else. A voided refund never changes
--    again. 0032's refund guard.
CREATE FUNCTION supplier_refunds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status = 'voided'
     AND to_jsonb(NEW) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                                 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'supplier refund % can only be voided', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_refunds_immutable';
END $$;

CREATE TRIGGER supplier_refunds_guard
  BEFORE UPDATE OR DELETE ON supplier_refunds
  FOR EACH ROW EXECUTE FUNCTION supplier_refunds_guard();

-- 5) bills.amount_debited and debit_notes.applied are the sums of the debit note allocations:
--    0032's credit_note_allocations_apply with the bill's names. The table checks refuse what must
--    not happen: settling a bill past its total by payments and debit notes together, or a bill
--    that is not posted (bills_paid_check); applying more than the debit note has left, or
--    anything of a draft (debit_notes_money_check). The UPDATE locks the bill row, so a payment
--    and a debit note settling its last ৳5,000 at the same moment run one after the other, and
--    the second one fails on the check.
CREATE FUNCTION debit_note_allocations_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE bills SET amount_debited = amount_debited - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id;
    UPDATE debit_notes SET applied = applied - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.debit_note_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE bills SET amount_debited = amount_debited + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
    UPDATE debit_notes SET applied = applied + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER debit_note_allocations_apply
  AFTER INSERT OR UPDATE OR DELETE ON debit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION debit_note_allocations_apply();

-- 6) supplier_payments.refunded and debit_notes.refunded are the sums of the POSTED supplier
--    refunds that took money back out of them: 0032's refunds_apply with the purchase names. Only
--    one of the two UPDATEs finds a row (a refund has one source). The checks refuse taking back
--    more than the source has left (supplier_payments_amount_check, debit_notes_money_check), from
--    a draft debit note or a payment that is not posted (the same two checks).
CREATE FUNCTION supplier_refunds_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    UPDATE supplier_payments SET refunded = refunded - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.payment_id;
    UPDATE debit_notes SET refunded = refunded - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.debit_note_id;
  END IF;
  IF NEW.status = 'posted' THEN
    UPDATE supplier_payments SET refunded = refunded + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
    UPDATE debit_notes SET refunded = refunded + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER supplier_refunds_apply
  AFTER INSERT OR UPDATE ON supplier_refunds
  FOR EACH ROW EXECUTE FUNCTION supplier_refunds_apply();

-- 7) 0040's supplier payment guard, with refunds. A posted payment may now also have its advance
--    taken back (refunded moves, by section 6's trigger). Voiding does not list refunded, and
--    supplier_payments_amount_check wants it at zero on anything but a posted payment, so a
--    payment with a posted refund cannot be voided (payment_has_refunds) until the refund is
--    voided first. The rest is unchanged.
CREATE OR REPLACE FUNCTION supplier_payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'supplier_payment'
            AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'supplier payment % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payments_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.supplier_bank_account_id IS NULL AND OLD.supplier_bank_account_id IS NOT NULL
     AND to_jsonb(NEW) - 'supplier_bank_account_id' = to_jsonb(OLD) - 'supplier_bank_account_id' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND (
       (NEW.status = 'posted'
        AND to_jsonb(NEW) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by']
            = to_jsonb(OLD) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by'])
       OR (NEW.status = 'voided'
        AND to_jsonb(NEW) - ARRAY['status', 'applied', 'void_date', 'void_reason', 'version',
                                  'updated_at', 'updated_by']
            = to_jsonb(OLD) - ARRAY['status', 'applied', 'void_date', 'void_reason', 'version',
                                    'updated_at', 'updated_by'])) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('posted', 'voided', 'cancelled') THEN
    RAISE EXCEPTION 'supplier payment % is %: it can only have its money applied or be voided', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payments_posted_immutable';
  END IF;

  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.status = 'pending'
         AND to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at',
                                   'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at',
                                      'updated_by']) THEN
    RAISE EXCEPTION 'supplier payment % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payments_locked';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'), ('pending', 'posted'), ('pending', 'draft')) THEN
    RAISE EXCEPTION 'supplier payment % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payments_status_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'supplier_payment' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'posted' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'supplier payment % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payments_approval_check';
  END IF;
  RETURN NEW;
END $$;

-- 8) 0040's bill guards, with what debit notes and returns change:
--    - a posted bill may also have debit notes' money applied (amount_debited, section 5's
--      trigger) and its debited total grow (debit_note_total, written by a debit note's posting
--      through Drizzle, which also sets updated_at and may set updated_by). Never down: a debit
--      note is never undone. version still never moves, so a bill page open in another tab stays
--      current;
--    - posting also checks that each receipt line is billed for what was kept: a return posted
--      after the draft was written left the bill line too big (decision 17). The rest is
--      unchanged.
CREATE OR REPLACE FUNCTION bills_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'bill' AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'bill % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('posted', 'cancelled') THEN
    IF OLD.status = 'posted' AND NEW.debit_note_total >= OLD.debit_note_total
       AND to_jsonb(NEW) - ARRAY['amount_paid', 'amount_debited', 'debit_note_total', 'updated_at',
                                 'updated_by']
           = to_jsonb(OLD) - ARRAY['amount_paid', 'amount_debited', 'debit_note_total',
                                   'updated_at', 'updated_by'] THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'bill % is % and cannot be changed', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_posted_immutable';
  END IF;

  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.status = 'pending'
         AND to_jsonb(NEW) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at',
                                   'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'posted_at', 'posted_by', 'version', 'updated_at',
                                      'updated_by']) THEN
    RAISE EXCEPTION 'bill % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_locked';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'), ('pending', 'posted'), ('pending', 'draft')) THEN
    RAISE EXCEPTION 'bill % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_status_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'bill' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'posted' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'bill % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_approval_check';
  END IF;

  IF NEW.status = 'posted' THEN
    IF EXISTS (
         SELECT 1
           FROM bill_lines bl
           LEFT JOIN goods_receipt_lines gl
             ON gl.tenant_id = bl.tenant_id AND gl.id = bl.receipt_line_id
           JOIN products p ON p.tenant_id = bl.tenant_id AND p.id = bl.product_id
          WHERE bl.tenant_id = NEW.tenant_id AND bl.bill_id = NEW.id
            AND (gl.billed IS FALSE
                 OR bl.base_quantity <> gl.base_quantity - gl.returned_quantity
                 OR (bl.receipt_line_id IS NULL AND bl.order_line_id IS NULL
                     AND p.type = 'goods')
                 OR EXISTS (
                   SELECT 1
                     FROM bill_lines other
                     JOIN bills b ON b.tenant_id = other.tenant_id AND b.id = other.bill_id
                    WHERE other.tenant_id = bl.tenant_id
                      AND other.receipt_line_id = bl.receipt_line_id
                      AND other.bill_id <> bl.bill_id AND b.status = 'posted'))) THEN
      RAISE EXCEPTION 'bill % has goods lines that are not received, or billed by another bill', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_receipts_check';
    END IF;
    -- The service lines' order lines are locked first, in id order: a second bill posting the
    -- same line at the same moment waits here, and then sees this one posted
    PERFORM 1
       FROM purchase_order_lines pl
      WHERE pl.tenant_id = NEW.tenant_id
        AND pl.id IN (SELECT bl.order_line_id
                        FROM bill_lines bl
                       WHERE bl.tenant_id = NEW.tenant_id AND bl.bill_id = NEW.id
                         AND bl.receipt_line_id IS NULL AND bl.order_line_id IS NOT NULL)
      ORDER BY pl.id
        FOR NO KEY UPDATE;
    IF EXISTS (
         SELECT 1
           FROM bill_lines bl
           JOIN bill_lines other
             ON other.tenant_id = bl.tenant_id AND other.order_line_id = bl.order_line_id
            AND other.receipt_line_id IS NULL AND other.bill_id <> bl.bill_id
           JOIN bills b ON b.tenant_id = other.tenant_id AND b.id = other.bill_id
          WHERE bl.tenant_id = NEW.tenant_id AND bl.bill_id = NEW.id
            AND bl.receipt_line_id IS NULL AND bl.order_line_id IS NOT NULL
            AND b.status = 'posted') THEN
      RAISE EXCEPTION 'bill % bills an order line another posted bill billed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_order_lines_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The lines: 0040's guard, with two changes. A posted bill's line may have what debit notes took
-- off grow (debited), with nothing else. And a receipt line is billed for what was kept (base −
-- returned, contracts' keptQuantity), no longer the whole line.
CREATE OR REPLACE FUNCTION bill_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_supplier uuid;
  v_own boolean := false;
  v_receipt record;
  v_order record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.debited > OLD.debited
     AND to_jsonb(NEW) - 'debited' = to_jsonb(OLD) - 'debited'
     AND EXISTS (SELECT 1 FROM bills
                  WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id AND status = 'posted') THEN
    RETURN NEW;
  END IF;
  -- 0040's section 2 change. Only a service line's: a receipt line's order has a goods receipt, so
  -- it is never reopened, and its copy of the order line must stay.
  IF TG_OP = 'UPDATE' AND NEW.order_line_id IS NULL AND OLD.order_line_id IS NOT NULL
     AND OLD.receipt_line_id IS NULL
     AND to_jsonb(NEW) - 'order_line_id' = to_jsonb(OLD) - 'order_line_id' THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO v_status FROM bills WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id;
    v_own := TG_OP = 'UPDATE' AND v_status = 'pending'
      AND OLD.receipt_line_id IS NULL AND OLD.order_line_id IS NULL
      AND NEW.receipt_line_id IS NOT NULL
      AND to_jsonb(NEW) - 'receipt_line_id' = to_jsonb(OLD) - 'receipt_line_id';
    -- NULL: a deleted draft's cascade
    IF v_status IS NOT NULL AND v_status <> 'draft' AND NOT v_own THEN
      RAISE EXCEPTION 'the lines of a % bill cannot be changed', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_locked';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  -- The bill the line is (or moves) in must be a draft too
  SELECT status, supplier_id INTO v_status, v_supplier
    FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
  -- NULL: no such bill — the foreign key gives that error
  IF v_status IS NULL THEN
    RETURN NEW;
  END IF;
  IF v_status <> 'draft' AND NOT v_own THEN
    RAISE EXCEPTION 'lines cannot be added to a % bill', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_locked';
  END IF;

  IF NEW.receipt_line_id IS NOT NULL THEN
    SELECT r.supplier_id, r.status, r.bill_id, l.order_line_id, l.base_quantity,
           l.returned_quantity
      INTO v_receipt
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.tenant_id = l.tenant_id AND r.id = l.receipt_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.receipt_line_id;
    -- Not found: the foreign key gives that error. A receipt a bill made is billed by that bill
    -- only, and only by its posting.
    IF FOUND AND (v_receipt.supplier_id <> v_supplier OR v_receipt.status <> 'posted'
                  OR v_receipt.base_quantity - v_receipt.returned_quantity <> NEW.base_quantity
                  OR v_receipt.order_line_id IS DISTINCT FROM NEW.order_line_id
                  OR v_receipt.bill_id IS DISTINCT FROM (CASE WHEN v_own THEN NEW.bill_id END)) THEN
      RAISE EXCEPTION 'a bill line bills what was kept of a line of a posted goods receipt of its supplier'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_receipt_check';
    END IF;
  ELSIF NEW.order_line_id IS NOT NULL THEN
    SELECT o.supplier_id, o.status, p.type
      INTO v_order
      FROM purchase_order_lines l
      JOIN purchase_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
      JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.order_line_id;
    IF FOUND AND (v_order.supplier_id <> v_supplier
                  OR v_order.status NOT IN ('approved', 'received', 'closed')
                  OR v_order.type <> 'service') THEN
      RAISE EXCEPTION 'a bill line bills a service line of an approved purchase order of its supplier'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_order_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The expenses: 0040's guard, and a posted bill's expense may have debited grow, with nothing else
CREATE OR REPLACE FUNCTION bill_expenses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.debited > OLD.debited
     AND to_jsonb(NEW) - 'debited' = to_jsonb(OLD) - 'debited'
     AND EXISTS (SELECT 1 FROM bills
                  WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id AND status = 'posted') THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM bills
         WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id AND status <> 'draft'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM bills
         WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id AND status <> 'draft')) THEN
    RAISE EXCEPTION 'the expenses of a bill change only while it is a draft'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_expenses_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- 9) 0040's goods receipt line guard, with returns. Two changes are allowed on a posted receipt's
--    line, each on its own: it becomes billed (false → true, once), or a return's posting adds to
--    returned_quantity (only up: a posted return is never undone). Like 0032's challan line.
CREATE OR REPLACE FUNCTION goods_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_order uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO v_status
      FROM goods_receipts WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id;
    IF v_status = 'posted' THEN
      IF TG_OP = 'UPDATE' AND NOT OLD.billed AND NEW.billed
         AND to_jsonb(NEW) - 'billed' = to_jsonb(OLD) - 'billed' THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.returned_quantity > OLD.returned_quantity
         AND to_jsonb(NEW) - 'returned_quantity' = to_jsonb(OLD) - 'returned_quantity' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'the lines of a posted goods receipt cannot be changed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_posted_immutable';
    END IF;
    -- NULL: a deleted draft's cascade
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT status, order_id INTO v_status, v_order
    FROM goods_receipts WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id;
  -- Not found: no such receipt — the foreign key gives that error
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'the lines of a posted goods receipt cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_posted_immutable';
  END IF;
  IF NEW.billed THEN
    RAISE EXCEPTION 'only a line of a posted goods receipt is billed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_billed_check';
  END IF;
  -- Nothing goes back from goods that are not in stock yet
  IF NEW.returned_quantity <> 0 THEN
    RAISE EXCEPTION 'only a line of a posted goods receipt is sent back'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_returned_check';
  END IF;
  -- Another order than the receipt's is the line's key's error (goods_receipt_lines_receipt_fk);
  -- this is the case the key cannot see
  IF NEW.order_id IS NULL AND v_order IS NOT NULL THEN
    RAISE EXCEPTION 'a goods receipt line copies its receipt''s purchase order'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_order_check';
  END IF;
  RETURN NEW;
END $$;

-- 10) A return before billing gives the order its goods back (decision 3): the order line's
--     received quantity goes down, and a received order is approved again ("Partly received"), so
--     the supplier can send the goods again on the same order. 0040's order guard, with that one
--     new move: received → approved, only the status changing, and only while a goods line is
--     short. It keeps its approval: its newest round is still approved.
CREATE OR REPLACE FUNCTION purchase_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'purchase_order'
            AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'purchase order % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
     OR (OLD.status <> 'draft'
         AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'purchase order % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_locked';
  END IF;
  -- A draft that moves to another warehouse keeps no line of a requisition for the old one
  -- (decision 16; section 7 checks each line as it is written)
  IF NEW.warehouse_id <> OLD.warehouse_id AND EXISTS (
       SELECT 1
         FROM purchase_order_lines pl
         JOIN requisition_lines rl ON rl.tenant_id = pl.tenant_id AND rl.id = pl.requisition_line_id
         JOIN requisitions r ON r.tenant_id = rl.tenant_id AND r.id = rl.requisition_id
        WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
          AND r.warehouse_id <> NEW.warehouse_id) THEN
    RAISE EXCEPTION 'purchase order % buys for a requisition of another warehouse', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_requisition_check';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'),
       ('pending', 'approved'), ('pending', 'draft'),
       ('approved', 'draft'), ('approved', 'received'), ('approved', 'closed'),
       ('approved', 'cancelled'), ('received', 'approved')) THEN
    RAISE EXCEPTION 'purchase order % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_status_check';
  END IF;

  IF (OLD.status = 'approved' AND NEW.status IN ('draft', 'cancelled') AND EXISTS (
        SELECT 1 FROM goods_receipts WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id))
     OR (NEW.status = 'closed' AND NOT EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND status = 'posted')
        AND NOT EXISTS (
        SELECT 1
          FROM purchase_order_lines pl
          JOIN bill_lines bl ON bl.tenant_id = pl.tenant_id AND bl.order_line_id = pl.id
          JOIN bills b ON b.tenant_id = bl.tenant_id AND b.id = bl.bill_id
         WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id AND b.status = 'posted'))
     OR (NEW.status = 'received' AND EXISTS (
        SELECT 1
          FROM purchase_order_lines pl
          JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
         WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
           AND p.type = 'goods' AND pl.received_quantity < pl.base_quantity))
     OR (OLD.status = 'received' AND NOT EXISTS (
        SELECT 1
          FROM purchase_order_lines pl
          JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
         WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
           AND p.type = 'goods' AND pl.received_quantity < pl.base_quantity)) THEN
    RAISE EXCEPTION 'purchase order % cannot be % with the goods receipts it has', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_receipts_check';
  END IF;
  IF OLD.status = 'approved' AND NEW.status IN ('draft', 'cancelled') AND EXISTS (
       SELECT 1
         FROM purchase_order_lines pl
         JOIN bill_lines bl ON bl.tenant_id = pl.tenant_id AND bl.order_line_id = pl.id
         JOIN bills b ON b.tenant_id = bl.tenant_id AND b.id = bl.bill_id
        WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id AND b.status <> 'cancelled') THEN
    RAISE EXCEPTION 'purchase order % is billed and cannot be %', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_bills_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'purchase_order' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'approved' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'purchase order % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_approval_check';
  END IF;
  RETURN NEW;
END $$;

-- The lines: 0038's guard, and a return before billing may lower what was received, with nothing
-- else: on an approved order (partly received), a received one (the line goes down first, then the
-- order goes back to approved) and a closed one (it stays closed). Never what was turned back.
CREATE OR REPLACE FUNCTION purchase_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_warehouse uuid;
  v_req_status text;
  v_req_warehouse uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.requisition_line_id IS NULL AND OLD.requisition_line_id IS NOT NULL
     AND to_jsonb(NEW) - 'requisition_line_id' = to_jsonb(OLD) - 'requisition_line_id' THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT status, warehouse_id INTO v_status, v_warehouse
      FROM purchase_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
    IF TG_OP = 'UPDATE' AND v_status = 'approved'
       AND NEW.received_quantity >= OLD.received_quantity
       AND NEW.rejected_quantity >= OLD.rejected_quantity
       AND to_jsonb(NEW) - ARRAY['received_quantity', 'rejected_quantity']
           = to_jsonb(OLD) - ARRAY['received_quantity', 'rejected_quantity'] THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND v_status IN ('approved', 'received', 'closed')
       AND NEW.received_quantity < OLD.received_quantity
       AND to_jsonb(NEW) - 'received_quantity' = to_jsonb(OLD) - 'received_quantity' THEN
      RETURN NEW;
    END IF;
    -- NULL: a deleted draft's cascade
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'the lines of a % purchase order cannot be changed, except what was received', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_locked';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  -- The order the line is (or moves) in must be a draft too
  SELECT status, warehouse_id INTO v_status, v_warehouse
    FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  -- NULL: no such order — the foreign key gives that error
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'lines cannot be added to a % purchase order', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_locked';
  END IF;

  IF NEW.requisition_line_id IS NOT NULL THEN
    SELECT r.status, r.warehouse_id INTO v_req_status, v_req_warehouse
      FROM requisition_lines rl
      JOIN requisitions r ON r.tenant_id = rl.tenant_id AND r.id = rl.requisition_id
     WHERE rl.tenant_id = NEW.tenant_id AND rl.id = NEW.requisition_line_id
       FOR SHARE OF r;
    -- NULL: no such requisition line — the foreign key gives that error
    IF v_req_status IS NOT NULL
       AND (v_req_status NOT IN ('approved', 'closed') OR v_req_warehouse <> v_warehouse) THEN
      RAISE EXCEPTION 'an order line buys only for an approved requisition of the order''s warehouse'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_order_lines_requisition_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;
