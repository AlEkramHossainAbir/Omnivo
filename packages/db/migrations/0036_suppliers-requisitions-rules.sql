-- Custom SQL migration file, put your code below! ---- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'supplier_groups', 'party_bank_accounts', 'approval_rules', 'approval_levels',
      'approval_rounds', 'approval_steps', 'requisitions', 'requisition_lines'
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

-- 2) A step names the role it waits for. When that role is deleted later, the step keeps its
--    role_name and only role_id becomes NULL: the history still reads "Purchase manager". A plain
--    ON DELETE SET NULL would also clear tenant_id (NOT NULL, so the role's delete would fail).
--    As in 0028, the column list needs Postgres 15 or later, and Drizzle cannot write it.
ALTER TABLE approval_steps
  ADD CONSTRAINT approval_steps_role_fk
  FOREIGN KEY (tenant_id, role_id)
  REFERENCES roles (tenant_id, id)
  ON DELETE SET NULL (role_id);

-- 3) The posting check from 0026, with the payable (decision 11):
--    - a line has a party exactly when its account is kept per party: the receivable or, from
--      now on, the payable (contracts' PARTY_ACCOUNT_PURPOSES);
--    - the party is on the right side: a receivable line names a customer, a payable line a
--      supplier (contracts' partyRoleOf). Without this a supplier's statement could show a sale.
--    Both run when an entry is posted, so lines posted before this step are never checked, and
--    the payable lines of old opening balances (with no party) stay as they are. A reversal is
--    let through both rules: it copies its original's lines as they were, and a party that has
--    left a side since must not make an old entry impossible to undo.
CREATE OR REPLACE FUNCTION journal_entries_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  debits numeric;
  credits numeric;
  lines integer;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO debits, credits, lines
    FROM journal_lines
   WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;
  IF lines < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: % lines, debits %, credits %',
        NEW.id, lines, debits, credits
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_balanced';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id AND a.is_group
  ) THEN
    RAISE EXCEPTION 'journal entry % posts to a group account', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_ledger_only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
       AND (l.party_id IS NOT NULL)
           <> coalesce(a.purpose IN ('accounts_receivable', 'accounts_payable'), false)
       AND NOT (NEW.source = 'reversal' AND l.party_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'journal entry % has a party on the wrong line', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_check';
  END IF;
  IF NEW.source <> 'reversal' AND EXISTS (
    SELECT 1 FROM journal_lines l
      JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id
     WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
       AND NOT CASE a.purpose
                 WHEN 'accounts_receivable' THEN p.is_customer
                 WHEN 'accounts_payable' THEN p.is_supplier
                 ELSE true
               END
  ) THEN
    RAISE EXCEPTION 'journal entry % names a party that is not a customer or supplier there', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_role_check';
  END IF;
  RETURN NULL;
END $$;

-- 4) An approval round is history. It names a real document of its kind when it is made. Its
--    document, amount and who submitted it never change. Its status moves once, from pending, and
--    only to what its steps say: approved when every step is approved (a round with no steps, for
--    a document no level reaches, is approved at once), rejected when a step was rejected. Once
--    closed, nothing changes, and no round is ever deleted.
CREATE FUNCTION approval_rounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval round % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_rounds_history_immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The foreign key a polymorphic column cannot have. 17b adds the purchase order here.
    IF NEW.document = 'requisition' AND NOT EXISTS (
         SELECT 1 FROM requisitions WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id) THEN
      RAISE EXCEPTION 'approval round names requisition %, which does not exist', NEW.document_id
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

CREATE TRIGGER approval_rounds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_rounds
  FOR EACH ROW EXECUTE FUNCTION approval_rounds_guard();

-- 5) A step is written once, when its round is submitted, and decided once, while its round is
--    pending: only the decision, who, when and the comment change, from empty. A step is decided
--    after every step before it was approved (decision 3: the levels go one after another). The
--    order is checked on UPDATE only: the Owner's own document (decision 14) inserts its steps
--    already approved, in one statement, and a row trigger may see that statement's rows in any
--    order. The one change after that is section 2's: role_id becomes NULL when the role is
--    deleted. No step is ever deleted.
CREATE FUNCTION approval_steps_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approval step % is history and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_history_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role_id IS NULL AND OLD.role_id IS NOT NULL
     AND to_jsonb(NEW) - 'role_id' = to_jsonb(OLD) - 'role_id' THEN
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM approval_rounds WHERE tenant_id = NEW.tenant_id AND id = NEW.round_id;
  -- NULL: no such round — the foreign key gives that error
  IF v_status IS NOT NULL AND v_status <> 'pending' THEN
    RAISE EXCEPTION 'the steps of a % approval round cannot be changed', v_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_closed_immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF OLD.decision IS NOT NULL
     OR to_jsonb(NEW) - ARRAY['decision', 'decided_by', 'decided_at', 'comment']
        <> to_jsonb(OLD) - ARRAY['decision', 'decided_by', 'decided_at', 'comment'] THEN
    RAISE EXCEPTION 'approval step % was decided, or would change more than its decision', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_decided_immutable';
  END IF;
  IF NEW.decision IS NOT NULL AND EXISTS (
       SELECT 1 FROM approval_steps
        WHERE tenant_id = NEW.tenant_id AND round_id = NEW.round_id
          AND position < NEW.position AND decision IS DISTINCT FROM 'approved') THEN
    RAISE EXCEPTION 'approval step % is decided before the steps above it', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_steps_order_check';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER approval_steps_guard
  BEFORE INSERT OR UPDATE OR DELETE ON approval_steps
  FOR EACH ROW EXECUTE FUNCTION approval_steps_guard();

-- 6) A requisition (decisions 6 and 19):
--    - its number and who asked never change;
--    - a draft is changed freely; anything else keeps what was asked for, and only its status
--      moves (reopen first, to change it);
--    - the moves are draft → pending or cancelled; pending → approved or draft; approved → draft
--      or cancelled. Cancelled is final (17b adds the ordered states). Approval always passes
--      through pending, even when no level applies or the Owner submits it (the API makes both
--      moves in one transaction): a reopened requisition's newest round is still the old,
--      approved one, and draft → approved would approve its changes with nobody looking;
--    - the status follows its newest approval round: pending while a round waits, approved only
--      when that round was approved, back from pending to draft only when it was rejected or
--      reopened. So no bug can approve a requisition that nobody approved;
--    - only a draft that was never submitted is deleted; any other is cancelled, so its approval
--      history stays.
CREATE FUNCTION requisitions_guard() RETURNS trigger
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
       ('approved', 'draft'), ('approved', 'cancelled')) THEN
    RAISE EXCEPTION 'requisition % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisitions_status_check';
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

CREATE TRIGGER requisitions_guard
  BEFORE UPDATE OR DELETE ON requisitions
  FOR EACH ROW EXECUTE FUNCTION requisitions_guard();

-- The lines: only while the requisition is a draft, checked before (OLD) and after (NEW) like
-- 0028's quotation lines. When a draft is deleted, its lines go by ON DELETE CASCADE; the header
-- is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION requisition_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM requisitions
         WHERE tenant_id = OLD.tenant_id AND id = OLD.requisition_id AND status <> 'draft'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM requisitions
         WHERE tenant_id = NEW.tenant_id AND id = NEW.requisition_id AND status <> 'draft')) THEN
    RAISE EXCEPTION 'the lines of a requisition that is not a draft cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'requisition_lines_locked';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER requisition_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON requisition_lines
  FOR EACH ROW EXECUTE FUNCTION requisition_lines_guard();
