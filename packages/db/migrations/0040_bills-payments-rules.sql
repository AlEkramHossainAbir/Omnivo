-- Custom SQL migration file, put your code below! --
-- 1) The five new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'bills', 'bill_lines', 'bill_expenses', 'supplier_payments', 'supplier_payment_allocations'
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

-- 2) Two links that are cleared, not kept, when what they point at is deleted. Only the one column
--    becomes NULL: a plain ON DELETE SET NULL would also clear tenant_id and the other columns of
--    the key (NOT NULL, so the delete would fail). As in 0038, the column list needs Postgres 15 or
--    later, and Drizzle cannot write it.
--    - A bill line bills an order line of the same variant. A reopened order writes its lines
--      again, which section 4 allows only once every bill that billed them was cancelled; the
--      cancelled bill keeps its line.
--    - A payment names a bank account of its own supplier (decision 24). The supplier's form may
--      remove the account later (17a keeps the ids of the accounts it keeps); the payment then
--      names none.
ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_order_line_fk
  FOREIGN KEY (tenant_id, order_line_id, variant_id)
  REFERENCES purchase_order_lines (tenant_id, id, variant_id)
  ON DELETE SET NULL (order_line_id);

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_bank_account_fk
  FOREIGN KEY (tenant_id, supplier_id, supplier_bank_account_id)
  REFERENCES party_bank_accounts (tenant_id, party_id, id)
  ON DELETE SET NULL (supplier_bank_account_id);

-- 3) 0038's round guard, with the bill and the supplier payment as the third and fourth kinds of
--    document: a round names one that exists. The rest is unchanged.
CREATE OR REPLACE FUNCTION approval_rounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval round % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_history_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The foreign key a polymorphic column cannot have, one branch per kind of document
    IF (NEW.document = 'requisition' AND NOT EXISTS (
          SELECT 1 FROM requisitions WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id))
       OR (NEW.document = 'purchase_order' AND NOT EXISTS (
          SELECT 1 FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id))
       OR (NEW.document = 'bill' AND NOT EXISTS (
          SELECT 1 FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id))
       OR (NEW.document = 'supplier_payment' AND NOT EXISTS (
          SELECT 1 FROM supplier_payments
           WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id)) THEN
      RAISE EXCEPTION 'approval round names % %, which does not exist', NEW.document, NEW.document_id
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'approval_rounds_document_fk';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.tenant_id, NEW.document, NEW.document_id, NEW.amount, NEW.submitted_by, NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.document, OLD.document_id, OLD.amount, OLD.submitted_by, OLD.submitted_at) THEN
    RAISE EXCEPTION 'approval round % cannot move to another document or amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_identity_immutable';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'approval round % is % and cannot be changed', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_closed_immutable';
  END IF;
  IF (NEW.status = 'approved' AND EXISTS (
        SELECT 1 FROM approval_steps
         WHERE tenant_id = NEW.tenant_id AND round_id = NEW.id
           AND decision IS DISTINCT FROM 'approved'))
     OR (NEW.status = 'rejected' AND NOT EXISTS (
        SELECT 1 FROM approval_steps
         WHERE tenant_id = NEW.tenant_id AND round_id = NEW.id AND decision = 'rejected')) THEN
    RAISE EXCEPTION 'approval round % cannot be % with these steps', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_steps_check';
  END IF;
  RETURN NEW;
END $$;

-- 4) 0038's purchase order guard, with the bills. A service line is billed straight from the order
--    (it never comes on a goods receipt), so:
--    - while a bill that is not cancelled bills one of its lines, even a draft bill, the order is
--      not reopened or cancelled: the bill line points at its line, like a goods receipt line;
--    - closed needs a posted goods receipt OR a posted bill, so an order of services only (a dyeing
--      job) that was billed can be closed.
--    The rest is unchanged.
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
       ('approved', 'cancelled')) THEN
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

-- 5) A bill (decisions 7, 13 and 14):
--    - its number never changes once given, even when it goes back to draft;
--    - a draft is changed freely; a pending one keeps what was submitted, and only its status
--      moves (reopen first, to change it);
--    - the moves are draft → pending or cancelled (cancelled needs a number: a draft never
--      submitted is deleted instead), and pending → posted or draft. A pending bill is cancelled
--      by reopening it first, in the same transaction, so its waiting round ends as reopened.
--      Posted and cancelled are final;
--    - the status follows its newest approval round, like a purchase order's, with posted in
--      approved's place: the last approval posts it (decision 7);
--    - posting finishes what the API did first, under every path that writes: each goods receipt
--      line it bills is marked billed (section 10) and billed by no other posted bill, each goods
--      line of its own came in on the goods receipt the posting made (section 6), and an order's
--      service line is billed by one posted bill only;
--    - a posted bill changes only in what payments paid (section 9's triggers);
--    - only a draft that was never submitted is deleted.
CREATE FUNCTION bills_guard() RETURNS trigger
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
    IF OLD.status = 'posted' AND to_jsonb(NEW) - 'amount_paid' = to_jsonb(OLD) - 'amount_paid' THEN
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

CREATE TRIGGER bills_guard
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_guard();

-- 6) The lines of a bill:
--    - free while the bill is a draft, and each line bills something of the bill's own supplier:
--      a whole line of a posted goods receipt (bill_receipt_line_quantity), with its order line
--      copied; or a service line of an approved, received or closed order;
--    - while the bill is pending, one change only, made by its posting: a goods line of its own
--      gets the line of the goods receipt the posting made for this bill;
--    - otherwise frozen. The one change at any time is section 2's: order_line_id becomes NULL
--      when a cancelled bill's order line is deleted.
--    When a draft is deleted, its lines go by ON DELETE CASCADE; the header is gone by then, so
--    the lookup finds nothing and lets them go.
CREATE FUNCTION bill_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_supplier uuid;
  v_own boolean := false;
  v_receipt record;
  v_order record;
BEGIN
  -- Section 2's change. Only a service line's: a receipt line's order has a goods receipt, so it
  -- is never reopened, and its copy of the order line must stay.
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
    SELECT r.supplier_id, r.status, r.bill_id, l.order_line_id, l.base_quantity
      INTO v_receipt
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.tenant_id = l.tenant_id AND r.id = l.receipt_id
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.receipt_line_id;
    -- Not found: the foreign key gives that error. A receipt a bill made is billed by that bill
    -- only, and only by its posting.
    IF FOUND AND (v_receipt.supplier_id <> v_supplier OR v_receipt.status <> 'posted'
                  OR v_receipt.base_quantity <> NEW.base_quantity
                  OR v_receipt.order_line_id IS DISTINCT FROM NEW.order_line_id
                  OR v_receipt.bill_id IS DISTINCT FROM (CASE WHEN v_own THEN NEW.bill_id END)) THEN
      RAISE EXCEPTION 'a bill line bills a whole line of a posted goods receipt of its supplier'
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

CREATE TRIGGER bill_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION bill_lines_guard();

-- 7) The expenses: only while the bill is a draft, checked before (OLD) and after (NEW), like
--    0030's invoice lines
CREATE FUNCTION bill_expenses_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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

CREATE TRIGGER bill_expenses_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bill_expenses
  FOR EACH ROW EXECUTE FUNCTION bill_expenses_guard();

-- 8) A supplier payment: the bill's rules, then the money receipt's (0030):
--    - number, moves and approval as a bill's: draft → pending or cancelled, pending → posted or
--      draft; a pending payment is cancelled by reopening it first;
--    - a posted payment changes in two ways only: its money is applied again (applied moves; the
--      API bumps the version), or it is voided (status, the void date and reason, and applied,
--      which section 9 has brought to zero first). Voided and cancelled are final;
--    - section 2's change at any time;
--    - only a draft that was never submitted is deleted.
CREATE FUNCTION supplier_payments_guard() RETURNS trigger
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
        AND to_jsonb(NEW) - ARRAY['applied', 'version', 'updated_at', 'updated_by']
            = to_jsonb(OLD) - ARRAY['applied', 'version', 'updated_at', 'updated_by'])
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

CREATE TRIGGER supplier_payments_guard
  BEFORE UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION supplier_payments_guard();

-- 9) bills.amount_paid and supplier_payments.applied are sums of the allocations, kept here and
--    nowhere else, like 0030's. One difference: a draft's allocations are a plan (decision 23).
--    applied counts the plan, so the form and the list say what will be applied, and the
--    payment's amount check refuses a plan bigger than the payment. A bill counts only the
--    allocations of a posted payment: they are added to it when the payment is posted, and
--    follow every change while it stays posted. The table checks then refuse what must not
--    happen, under every path that writes: paying a bill past its total (bills_paid_check), or
--    applying more than the payment (supplier_payments_amount_check).
--    The allocations change only while the payment is a draft (the plan) or posted (applied
--    again, or removed before a void), and only on a posted bill.
CREATE FUNCTION supplier_payment_allocations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_bill text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO v_status
      FROM supplier_payments WHERE tenant_id = OLD.tenant_id AND id = OLD.payment_id;
    -- NULL: a deleted draft's cascade
    IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'posted') THEN
      RAISE EXCEPTION 'the money of a % supplier payment cannot be applied again', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payment_allocations_locked';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT status INTO v_status
    FROM supplier_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
  IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'posted') THEN
    RAISE EXCEPTION 'the money of a % supplier payment cannot be applied again', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payment_allocations_locked';
  END IF;
  SELECT status INTO v_bill FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
  IF v_bill IS NOT NULL AND v_bill <> 'posted' THEN
    RAISE EXCEPTION 'money is applied only to a posted bill, not a % one', v_bill
      USING ERRCODE = 'check_violation', CONSTRAINT = 'supplier_payment_allocations_bill_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_payment_allocations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocations_guard();

CREATE FUNCTION supplier_payment_allocations_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE supplier_payments SET applied = applied - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.payment_id
    RETURNING status INTO v_status;
    IF v_status = 'posted' THEN
      UPDATE bills SET amount_paid = amount_paid - OLD.amount
       WHERE tenant_id = OLD.tenant_id AND id = OLD.bill_id;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE supplier_payments SET applied = applied + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
    RETURNING status INTO v_status;
    IF v_status = 'posted' THEN
      UPDATE bills SET amount_paid = amount_paid + NEW.amount
       WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER supplier_payment_allocations_apply
  AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocations_apply();

-- When the payment is posted, its plan becomes payments: each bill gets its share. In bill id
-- order, so two payments posted at the same moment for the same bills lock them in the same
-- order and never deadlock; the second one waits, and fails on bills_paid_check if the first took
-- what was left.
CREATE FUNCTION supplier_payments_post() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT bill_id, amount
      FROM supplier_payment_allocations
     WHERE tenant_id = NEW.tenant_id AND payment_id = NEW.id
     ORDER BY bill_id
  LOOP
    UPDATE bills SET amount_paid = amount_paid + r.amount
     WHERE tenant_id = NEW.tenant_id AND id = r.bill_id;
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER supplier_payments_post
  AFTER UPDATE OF status ON supplier_payments
  FOR EACH ROW
  WHEN (OLD.status <> 'posted' AND NEW.status = 'posted')
  EXECUTE FUNCTION supplier_payments_post();

-- 10) 0038's goods receipt guards, with the receipts a bill makes (decision 21):
--    - a receipt has an order or a bill (the table's goods_receipts_source_check), and keeps it;
--    - with an order, it is written and posted only while the order is approved (as before);
--      with a bill, only while the bill is pending: its posting makes the receipt and posts it in
--      the same transaction, and the bill row is already locked by then;
--    - a posted receipt never changes and is never deleted, and its lines change in one way only:
--      a bill's posting marks a line billed, false → true and never back. A second bill that
--      tries to bill the same line fails here, even if two are posted at the same moment;
--    - a draft's line is not billed, and copies its receipt's order. The line's key checks that,
--      except for a line with no order (a key with a NULL in it is not checked at all): here, such
--      a line needs a receipt with no order.
CREATE OR REPLACE FUNCTION goods_receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'goods receipt % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.bill_id IS DISTINCT FROM OLD.bill_id
          OR NEW.supplier_id <> OLD.supplier_id) THEN
    RAISE EXCEPTION 'goods receipt % keeps its purchase order or bill', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_immutable';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.status = 'posted' THEN
    IF NEW.order_id IS NOT NULL THEN
      SELECT status INTO v_status
        FROM purchase_orders
       WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
         FOR SHARE;
      -- NULL: no such order — the foreign key gives that error
      IF v_status IS NOT NULL AND v_status <> 'approved' THEN
        RAISE EXCEPTION 'goods are received only against an approved purchase order, not a % one', v_status
          USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_check';
      END IF;
    ELSE
      SELECT status INTO v_status FROM bills WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id;
      IF v_status IS NOT NULL AND v_status <> 'pending' THEN
        RAISE EXCEPTION 'a bill brings its goods in only while it is being posted, not when %', v_status
          USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_bill_check';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
  -- Another order than the receipt's is the line's key's error (goods_receipt_lines_receipt_fk);
  -- this is the case the key cannot see
  IF NEW.order_id IS NULL AND v_order IS NOT NULL THEN
    RAISE EXCEPTION 'a goods receipt line copies its receipt''s purchase order'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_order_check';
  END IF;
  RETURN NEW;
END $$;
