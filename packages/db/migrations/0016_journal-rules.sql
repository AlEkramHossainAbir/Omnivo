-- Custom SQL migration file, put your code below! --

-- 1) The three new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['journal_entries', 'journal_lines', 'period_locks'])
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

-- 2) A posted entry never changes and is never deleted. A mistake is undone by a reversal: a new
--    entry. Only a draft may be edited, deleted, or turned into a posted entry (OLD.status =
--    'draft'), which is how every entry gets posted, so the API needs no exception.
CREATE FUNCTION journal_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'journal entry % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_entries_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

-- 3) The lines of a posted entry are frozen with it: no line is added, changed or removed. A line
--    is checked against its entry before (OLD) and after (NEW), so moving a line from a draft
--    into a posted entry is refused too. When a draft is deleted, its lines go by ON DELETE
--    CASCADE; the entry row is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION journal_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM journal_entries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.entry_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM journal_entries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted journal entry cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

-- 4) Double entry, checked by the database: a posted entry has at least two lines, its debits
--    equal its credits, and every line posts to a ledger (not a group). A CONSTRAINT TRIGGER that
--    is DEFERRABLE INITIALLY DEFERRED runs at COMMIT, not after each statement: by then every
--    line of the entry is in place, whatever order the code wrote them in. If it fails, the
--    whole transaction is rolled back — the entry, its lines and its number.
CREATE FUNCTION journal_entries_balanced() RETURNS trigger
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
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION journal_entries_balanced();
