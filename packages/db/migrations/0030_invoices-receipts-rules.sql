-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['invoices', 'invoice_lines', 'receipts', 'receipt_allocations'])
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

-- 2) A draft invoice is changed and deleted freely. A posted one was sent to the customer and is in
--    the books: it is never deleted, and the only thing that moves is amount_paid (section 4's
--    trigger, when a receipt is applied or voided). 15d's credit note corrects a posted invoice
--    with a document of its own, not by changing this one.
CREATE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'amount_paid' = to_jsonb(OLD) - 'amount_paid' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invoice % is posted and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'invoices_posted_immutable';
END $$;

CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- The lines: only while the invoice is a draft, like a delivery's lines (0028). So posting writes
-- the lines first (a line of its own gets the challan line its posting made) and only then sets
-- the invoice to posted. When a draft is deleted its lines cascade; the header is gone by then,
-- so the lookup finds nothing and lets them go.
CREATE FUNCTION invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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

CREATE TRIGGER invoice_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

-- 3) A receipt is never deleted: its number is printed on the customer's copy. While posted, two
--    things may happen to it: its money is applied again (applied moves; the API bumps the
--    version), or it is voided (status, the void date and reason, and applied, which section 4
--    has brought to zero first). A voided receipt never changes again.
CREATE FUNCTION receipts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND (
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
  RAISE EXCEPTION 'receipt % can only have its money applied or be voided', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'receipts_immutable';
END $$;

CREATE TRIGGER receipts_guard
  BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_guard();

-- 4) invoices.amount_paid and receipts.applied are the sums of the allocations, kept here and
--    nowhere else, like stock_balances by stock_movements (0022). The API only inserts and deletes
--    allocations; the two sums follow in the same statement. The table checks then refuse what
--    must not happen, under every path that writes:
--    - paying an invoice past its total, or a draft at all (invoices_paid_check);
--    - applying more than the receipt brought, or anything of a voided one (receipts_amount_check,
--      receipts_void_check, and section 3's guard).
--    The UPDATE locks the invoice row, so two receipts paying the last ৳5,000 of one invoice at the
--    same moment run one after the other here, and the second one fails on the check.
CREATE FUNCTION receipt_allocations_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    UPDATE invoices SET amount_paid = amount_paid - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.invoice_id;
    UPDATE receipts SET applied = applied - OLD.amount
     WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE invoices SET amount_paid = amount_paid + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id;
    UPDATE receipts SET applied = applied + NEW.amount
     WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER receipt_allocations_apply
  AFTER INSERT OR UPDATE OR DELETE ON receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION receipt_allocations_apply();

-- 5) 0028's order line guard, with what invoices write. While the order is confirmed a line may
--    have its delivered AND invoiced quantities changed; once delivered or closed, its invoiced
--    quantity only (the challans of a delivered order are still billed). A cancelled order stays
--    frozen. A draft order's lines stay free, except a line that was invoiced: an order reopened
--    after an invoice billed it cannot have the billed line rewritten under the invoice.
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
     AND to_jsonb(NEW) - 'invoiced_quantity' = to_jsonb(OLD) - 'invoiced_quantity' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a confirmed sales order cannot be changed, except what was delivered and invoiced'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
END $$;

-- 6) 0028's delivery line guard, with one change allowed on a posted challan: a line becomes
--    invoiced, false → true, with nothing else. Never back, and never twice: a second invoice that
--    tries to bill the same line fails here, even if two are posted at the same moment.
CREATE OR REPLACE FUNCTION delivery_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD.invoiced AND NEW.invoiced
     AND to_jsonb(NEW) - 'invoiced' = to_jsonb(OLD) - 'invoiced' THEN
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

-- 7) The money accounts of the workspaces that already exist: what the template (15c.3) flags in a
--    new one. Cash in hand by its purpose (it may have been renamed or renumbered); the bank and
--    wallet groups by their template codes, as groups of assets only. A company that moved its
--    banks elsewhere ticks its own groups on the account form. FORCE RLS applies to this
--    migration's role too, so each workspace is updated with its own app.tenant_id, like 0026.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE ledger_accounts
       SET holds_money = true
     WHERE tenant_id = t
       AND type = 'asset'
       AND (purpose = 'cash' OR (is_group AND code IN ('1120', '1130')));
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
