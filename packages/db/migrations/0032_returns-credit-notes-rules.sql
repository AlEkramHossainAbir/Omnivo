-- Custom SQL migration file, put your code below! --
-- 1) The six new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'sales_returns', 'sales_return_lines', 'credit_notes', 'credit_note_lines',
      'credit_note_allocations', 'refunds'
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

-- 2) A sales return is a delivery the other way round (0028): a draft is changed and deleted
--    freely, a posted one never changes, because what came back into the warehouse came back.
CREATE FUNCTION sales_returns_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'sales return % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_returns_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sales_returns_guard
  BEFORE UPDATE OR DELETE ON sales_returns
  FOR EACH ROW EXECUTE FUNCTION sales_returns_guard();

-- The lines: only while the return is a draft, like a delivery's lines. So posting writes the
-- lines first (the value, the batch of a challan line, the invoice line that billed it) and sets
-- the return to posted last. One change is allowed on a posted return's line: a credit note's
-- posting adds to credited_quantity, with nothing else. It only grows: a credit note is never
-- undone. When a draft is deleted its lines cascade; the header is gone by then, so the lookup
-- finds nothing and lets them go.
CREATE FUNCTION sales_return_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.credited_quantity > OLD.credited_quantity
     AND to_jsonb(NEW) - 'credited_quantity' = to_jsonb(OLD) - 'credited_quantity' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM sales_returns
         WHERE tenant_id = OLD.tenant_id AND id = OLD.return_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM sales_returns
         WHERE tenant_id = NEW.tenant_id AND id = NEW.return_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted sales return cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_return_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sales_return_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_return_lines
  FOR EACH ROW EXECUTE FUNCTION sales_return_lines_guard();

-- 3) A draft credit note is changed and deleted freely. A posted one is in the books and in the
--    customer's file: it is never deleted and never voided. Only its money moves: applied (section
--    5's trigger, when it is applied again; the API bumps the version) and refunded (section 6's,
--    when a refund pays some of it back).
CREATE FUNCTION credit_notes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['applied', 'refunded', 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'credit note % is posted and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_notes_posted_immutable';
END $$;

CREATE TRIGGER credit_notes_guard
  BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION credit_notes_guard();

-- The lines: only while the credit note is a draft, like an invoice's lines (0030)
CREATE FUNCTION credit_note_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tenant_id = OLD.tenant_id AND id = OLD.credit_note_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM credit_notes
         WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted credit note cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'credit_note_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credit_note_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION credit_note_lines_guard();

-- 4) A refund is never deleted: like a receipt, its number is on paper. While posted it may be
--    voided (status, the void date and reason), nothing else. A voided refund never changes again.
CREATE FUNCTION refunds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status = 'voided'
     AND to_jsonb(NEW) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                                 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'refund % can only be voided', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'refunds_immutable';
END $$;

CREATE TRIGGER refunds_guard
  BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_guard();

-- 5) invoices.amount_credited and credit_notes.applied are the sums of the credit note
--    allocations: 0030's receipt_allocations_apply with the credit note's names. The table checks
--    refuse what must not happen: settling an invoice past its total by receipts and credit notes
--    together, or a draft at all (invoices_paid_check); applying more than the credit note has
--    left, or anything of a draft (credit_notes_money_check). The UPDATE locks the invoice row,
--    so a receipt and a credit note settling its last ৳5,000 at the same moment run one after the
--    other, and the second one fails on the check.
CREATE FUNCTION credit_note_allocations_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE invoices SET amount_credited = amount_credited - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.invoice_id;
    UPDATE credit_notes SET applied = applied - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.credit_note_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE invoices SET amount_credited = amount_credited + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    UPDATE credit_notes SET applied = applied + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER credit_note_allocations_apply
  AFTER INSERT OR UPDATE OR DELETE ON credit_note_allocations
  FOR EACH ROW EXECUTE FUNCTION credit_note_allocations_apply();

-- 6) receipts.refunded and credit_notes.refunded are the sums of the POSTED refunds paid out of
--    them. A new refund adds its amount to its source; voiding it takes the amount off again, so
--    the money is the source's advance once more. Section 4's guard means nothing else ever
--    changes on a refund, but the trigger handles any update the same way: take the old row off
--    if it counted, put the new row on if it counts. Only one of the two UPDATEs finds a row (a
--    refund has one source). The checks refuse paying back more than the source has left
--    (receipts_amount_check, credit_notes_money_check), from a draft credit note
--    (credit_notes_money_check) and from a voided receipt (its guard).
CREATE FUNCTION refunds_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    UPDATE receipts SET refunded = refunded - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id;
    UPDATE credit_notes SET refunded = refunded - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.credit_note_id;
  END IF;
  IF NEW.status = 'posted' THEN
    UPDATE receipts SET refunded = refunded + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id;
    UPDATE credit_notes SET refunded = refunded + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER refunds_apply
  AFTER INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_apply();

-- 7) 0030's invoice guard, with what credit notes write. A posted invoice may still have its money
--    settled (amount_paid by receipts, amount_credited by credit notes) and its credited total
--    grow (credit_note_total, written by a credit note's posting through Drizzle, which also sets
--    updated_at and may set updated_by). Nothing else, and the credited total never goes down: a
--    credit note is never undone.
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.credit_note_total >= OLD.credit_note_total
     AND to_jsonb(NEW) - ARRAY['amount_paid', 'amount_credited', 'credit_note_total',
                               'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['amount_paid', 'amount_credited', 'credit_note_total',
                                 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice % is posted and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_posted_immutable';
END $$;

-- The lines: one change is allowed on a posted invoice's line, a credit note's posting adding to
-- credited, with nothing else. Never down.
CREATE OR REPLACE FUNCTION invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.credited > OLD.credited
     AND to_jsonb(NEW) - 'credited' = to_jsonb(OLD) - 'credited' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM invoices
         WHERE tenant_id = OLD.tenant_id AND id = OLD.invoice_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM invoices
         WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted invoice cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- 8) 0030's receipt guard, with refunds. While posted, a receipt may have its money applied again
--    or paid back (applied and refunded move, by their triggers), or be voided. Voiding does not
--    list refunded: receipts_void_check wants it at zero, so a receipt with a posted refund cannot
--    be voided (receipt_has_refunds) until the refund is voided first.
CREATE OR REPLACE FUNCTION receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND (
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
  RAISE EXCEPTION 'receipt % can only have its money applied or be voided', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'receipts_immutable';
END $$;

-- 9) 0030's delivery line guard, with returns. Two changes are allowed on a posted challan's
--    line, each on its own: it becomes invoiced (false → true, once), or a return's posting adds
--    to returned_quantity (only up: a posted return is never undone). Both with nothing else.
CREATE OR REPLACE FUNCTION delivery_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.invoiced AND NEW.invoiced
     AND to_jsonb(NEW) - 'invoiced' = to_jsonb(OLD) - 'invoiced' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.returned_quantity > OLD.returned_quantity
     AND to_jsonb(NEW) - 'returned_quantity' = to_jsonb(OLD) - 'returned_quantity' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.delivery_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.delivery_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted delivery cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'delivery_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

-- 10) A return before invoicing gives the order its goods back (you chose this): the order line's
--     delivered quantity goes down, and a delivered order is confirmed again, so a replacement can
--     go out on the same order, or the order is closed. 0028's order guard, with that one new move:
--     delivered → confirmed, only the status changing. It keeps its confirmation time: it was
--     confirmed then, and still is.
CREATE OR REPLACE FUNCTION sales_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL THEN
      RAISE EXCEPTION 'sales order % has a number and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_numbered_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                               'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                                 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  IF NEW.shipping_address_id IS NULL
     AND to_jsonb(NEW) - 'shipping_address_id' = to_jsonb(OLD) - 'shipping_address_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sales order % is % and cannot be changed this way', OLD.id, OLD.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_confirmed_immutable';
END $$;

-- The lines: 0030's guard, and on a delivered or closed order the delivered quantity may now go
-- down. Never up: a delivered order is confirmed again before it delivers more, and a closed one
-- delivers nothing more.
CREATE OR REPLACE FUNCTION sales_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM sales_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a sales order that is not a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM sales_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
  IF v_status IS NULL OR (v_status = 'draft' AND OLD.invoiced_quantity = 0) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND v_status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['delivered_quantity', 'invoiced_quantity']
         = to_jsonb(OLD) - ARRAY['delivered_quantity', 'invoiced_quantity'] THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND v_status IN ('delivered', 'closed')
     AND NEW.delivered_quantity <= OLD.delivered_quantity
     AND to_jsonb(NEW) - ARRAY['delivered_quantity', 'invoiced_quantity']
         = to_jsonb(OLD) - ARRAY['delivered_quantity', 'invoiced_quantity'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a confirmed sales order cannot be changed, except what was delivered and invoiced'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
END $$;

-- 11) The sales returns account of the workspaces that already exist: what setup (15d.3) fills in
--     for a new one. The pharmacy and retail templates have "4120 Sales returns"; in the other
--     templates 4120 is something else ("Local sales", "Trade discounts", "Service income"), so the
--     code alone is not enough: the name must match too, and the account must still be an active
--     income account that takes postings. A workspace that renamed or moved it picks it in
--     Settings → Sales. Like 0030, each workspace is updated with its own app.tenant_id: FORCE RLS
--     applies to this migration's role too.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE tenant_settings s
       SET sales_returns_account_id = a.id
      FROM ledger_accounts a
     WHERE s.tenant_id = t
       AND s.sales_returns_account_id IS NULL
       AND a.tenant_id = t
       AND a.code = '4120'
       AND a.name = 'Sales returns'
       AND a.type = 'income'
       AND NOT a.is_group
       AND a.archived_at IS NULL;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
