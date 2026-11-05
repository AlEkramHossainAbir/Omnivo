-- Custom SQL migration file, put your code below! --
-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines'
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

-- 2) An order line buys for a requisition line of the same variant: variant_id is in the key, so
--    a line for cotton yarn cannot point at a request for polyester. When the requisition line is
--    deleted later (a reopened requisition writes its lines again, which section 5 allows only
--    once every order that bought for it was cancelled), only requisition_line_id becomes NULL:
--    the cancelled order keeps its line. A plain ON DELETE SET NULL would also clear tenant_id and
--    variant_id (NOT NULL, so the requisition's save would fail). As in 0036, the column list
--    needs Postgres 15 or later, and Drizzle cannot write it.
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_requisition_line_fk
  FOREIGN KEY (tenant_id, requisition_line_id, variant_id)
  REFERENCES requisition_lines (tenant_id, id, variant_id)
  ON DELETE SET NULL (requisition_line_id);

-- 3) 0036's round guard, with the purchase order as the second kind of document: a round names an
--    order that exists. The rest is unchanged.
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
          SELECT 1 FROM purchase_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id)) THEN
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

-- 4) "An order buys for this requisition" (decision 17): a line of an order that is not cancelled
--    points at one of its lines. A draft order counts too: its lines point there, and they would
--    lose their link if the requisition's lines were written again. Used by section 5.
CREATE FUNCTION requisition_is_ordered(p_tenant uuid, p_requisition uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM requisition_lines rl
      JOIN purchase_order_lines pl
        ON pl.tenant_id = rl.tenant_id AND pl.requisition_line_id = rl.id
      JOIN purchase_orders po
        ON po.tenant_id = pl.tenant_id AND po.id = pl.order_id
     WHERE rl.tenant_id = p_tenant AND rl.requisition_id = p_requisition
       AND po.status <> 'cancelled')
$$;

-- 5) 0036's requisition guard, with step 17b's rules (decision 17):
--    - a new move, approved → closed: the rest will not be ordered. Closed is final;
--    - once an order buys for it, it is no longer reopened or cancelled (its lines would change
--      under the order), and only then may it be closed (a requisition nothing was ordered for is
--      cancelled, not closed). The API says which one with purchase_close_instead and
--      purchase_cancel_instead; this is the last word.
--    The rest is unchanged.
CREATE OR REPLACE FUNCTION requisitions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_round text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR EXISTS (
         SELECT 1 FROM approval_rounds
          WHERE tenant_id = OLD.tenant_id AND document = 'requisition' AND document_id = OLD.id) THEN
      RAISE EXCEPTION 'requisition % was submitted and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_submitted_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.number <> OLD.number OR NEW.requested_by <> OLD.requested_by
     OR (OLD.status <> 'draft'
         AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
             <> to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'requisition % is % and cannot be changed; reopen it first', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_locked';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'pending'), ('draft', 'cancelled'),
       ('pending', 'approved'), ('pending', 'draft'),
       ('approved', 'draft'), ('approved', 'cancelled'), ('approved', 'closed')) THEN
    RAISE EXCEPTION 'requisition % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_status_check';
  END IF;

  IF OLD.status = 'approved'
     AND (NEW.status = 'closed') <> requisition_is_ordered(NEW.tenant_id, NEW.id) THEN
    RAISE EXCEPTION 'requisition % cannot be % %', OLD.id, NEW.status,
        CASE WHEN NEW.status = 'closed' THEN 'before an order buys for it'
             ELSE 'once an order buys for it' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_ordered_check';
  END IF;

  SELECT status INTO v_round
    FROM approval_rounds
   WHERE tenant_id = NEW.tenant_id AND document = 'requisition' AND document_id = NEW.id
   ORDER BY submitted_at DESC, id DESC
   LIMIT 1;
  IF (NEW.status = 'pending' AND v_round IS DISTINCT FROM 'pending')
     OR (NEW.status = 'approved' AND v_round IS DISTINCT FROM 'approved')
     OR (OLD.status = 'pending' AND NEW.status = 'draft'
         AND coalesce(v_round, 'missing') NOT IN ('rejected', 'reopened')) THEN
    RAISE EXCEPTION 'requisition % cannot be % while its approval round is %',
        OLD.id, NEW.status, coalesce(v_round, 'missing')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_approval_check';
  END IF;
  RETURN NEW;
END $$;

-- 6) A purchase order (decisions 11, 13 and 21). The requisition's rules, plus the receipts:
--    - its number never changes once given, even when it goes back to draft;
--    - a draft is changed freely; anything else keeps what was ordered, and only its status moves
--      (reopen first, to change it);
--    - the moves are draft → pending or cancelled (cancelled needs a number: a draft never
--      submitted is deleted instead); pending → approved or draft; approved → draft (reopen),
--      received, closed or cancelled. Received, closed and cancelled are final;
--    - the status follows its newest approval round, exactly like the requisition's;
--    - while a goods receipt points at it, even a draft one, it is not reopened or cancelled
--      (decision 21: the receipt's lines point at its lines). Closed needs a posted receipt (an
--      order nothing came for is cancelled), and received needs every goods line in full;
--    - only a draft that was never submitted is deleted.
CREATE FUNCTION purchase_orders_guard() RETURNS trigger
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
         WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id AND status = 'posted'))
     OR (NEW.status = 'received' AND EXISTS (
        SELECT 1
          FROM purchase_order_lines pl
          JOIN products p ON p.tenant_id = pl.tenant_id AND p.id = pl.product_id
         WHERE pl.tenant_id = NEW.tenant_id AND pl.order_id = NEW.id
           AND p.type = 'goods' AND pl.received_quantity < pl.base_quantity)) THEN
    RAISE EXCEPTION 'purchase order % cannot be % with the goods receipts it has', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'purchase_orders_receipts_check';
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

CREATE TRIGGER purchase_orders_guard
  BEFORE UPDATE OR DELETE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_guard();

-- 7) The lines of an order:
--    - free while the order is a draft. A line that buys for a requisition line needs an approved
--      requisition (or a closed one: a draft's lines are written again on every save, and the
--      requisition may have been closed since) for the order's warehouse. The requisition row is
--      locked (FOR SHARE) for that, so a reopen or a cancel of the same requisition at the same
--      moment waits, and then sees this line (section 5);
--    - while the order is approved, only what goods receipts brought in changes, and only up;
--    - otherwise frozen. The one change at any time is section 2's: requisition_line_id becomes
--      NULL when its requisition line is deleted.
--    When a draft is deleted, its lines go by ON DELETE CASCADE; the header is gone by then, so
--    the lookup finds nothing and lets them go.
CREATE FUNCTION purchase_order_lines_guard() RETURNS trigger
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

CREATE TRIGGER purchase_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- 8) A goods receipt (decisions 8 and 20):
--    - it is written, and posted, only against an approved order. The order row is locked (FOR
--      SHARE) for that, so a reopen or a cancel of the same order at the same moment waits, and
--      then sees this receipt (section 6);
--    - it keeps its order and its supplier;
--    - a posted receipt never changes and is never deleted, like a posted delivery: what came in
--      came in, and a purchase return (17d) sends goods back.
CREATE FUNCTION goods_receipts_guard() RETURNS trigger
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
     AND (NEW.order_id <> OLD.order_id OR NEW.supplier_id <> OLD.supplier_id) THEN
    RAISE EXCEPTION 'goods receipt % keeps its purchase order', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_immutable';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.status = 'posted' THEN
    SELECT status INTO v_status
      FROM purchase_orders
     WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
       FOR SHARE;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'approved' THEN
      RAISE EXCEPTION 'goods are received only against an approved purchase order, not a % one', v_status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipts_order_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER goods_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard();

-- The lines: only while the receipt is a draft, checked before (OLD) and after (NEW), like 0028's
-- delivery lines. When a draft is deleted its lines cascade; the header is gone by then.
CREATE FUNCTION goods_receipt_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = OLD.tenant_id AND id = OLD.receipt_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM goods_receipts
         WHERE tenant_id = NEW.tenant_id AND id = NEW.receipt_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted goods receipt cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'goods_receipt_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER goods_receipt_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();

-- 9) "Goods received not billed" for the workspaces that already exist (decision 12): step 14's
--    job again (StockAccountsHandler). It adds the template's accounts that are missing and
--    chooses them for the uses that have none, so the new use gets 2115 (17b.3 teaches it). A
--    workspace without a chart gets it with its chart. Per workspace, with app.tenant_id set, as
--    in 0024: FORCE RLS applies to this migration's role too.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.tenant_id = t) THEN
      INSERT INTO outbox_events (id, tenant_id, type, payload)
      VALUES (gen_random_uuid(), t, 'workspace.stock_accounts_requested', '{}'::jsonb);
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
