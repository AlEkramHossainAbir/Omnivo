-- Custom SQL migration file, put your code below! --
-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE account_day_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_day_totals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_day_totals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) The totals only grow: a posted entry is never deleted, so no row ever goes. omnivo_app keeps
--    INSERT and UPDATE (default privileges), because the trigger below runs as the person who
--    posts; code never writes this table.
REVOKE DELETE ON account_day_totals FROM omnivo_app;

-- 3) A posted entry adds its lines to the day's totals: one row per account and branch, on the
--    entry's date. Every entry is posted the same way, a draft turned into a posted entry by one
--    UPDATE (0016 refuses new lines on a posted entry), so that update is the only event to
--    watch. A posted entry never changes again, so nothing is ever taken back out.
--    It runs at COMMIT (DEFERRABLE INITIALLY DEFERRED), not at the update. The upsert locks the
--    day's rows, and every sale of the day reaches the same sales and cash rows: locked at the
--    update, they would stay locked for the rest of a long posting (the stock, the document),
--    and every other posting would queue behind it. At COMMIT the lock lasts a moment.
--    The advisory lock makes the postings of one workspace add their totals one at a time. Without
--    it, two transactions that each post two entries (a transfer, a POS sale with an exchange)
--    could each hold a row the other wants next: a deadlock, and one of them fails.
--    A year-end closing entry and the reversal of one are marked `closing`, like the reports'
--    withoutClosingEntries().
CREATE FUNCTION journal_entries_day_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_closing boolean;
BEGIN
  v_closing := NEW.source = 'year_close' OR (NEW.source = 'reversal' AND EXISTS (
    SELECT 1 FROM journal_entries o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.reversal_of_id AND o.source = 'year_close'));

  PERFORM pg_advisory_xact_lock(hashtextextended('account_day_totals:' || NEW.tenant_id::text, 0));

  -- GROUP BY: two lines of one entry on the same account and branch become one row, so the
  -- ON CONFLICT never meets the same row twice in one statement (Postgres refuses that)
  INSERT INTO account_day_totals AS t (tenant_id, day, account_id, branch_id, closing, debit, credit)
  SELECT l.tenant_id, NEW.date, l.account_id, l.branch_id, v_closing, sum(l.debit), sum(l.credit)
    FROM journal_lines l
   WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
   GROUP BY l.tenant_id, l.account_id, l.branch_id
  ON CONFLICT ON CONSTRAINT account_day_totals_key
  DO UPDATE SET debit = t.debit + EXCLUDED.debit, credit = t.credit + EXCLUDED.credit;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_day_totals
  AFTER UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'posted')
  EXECUTE FUNCTION journal_entries_day_totals();

-- 4) The entries posted before this step, every workspace's (a deleted one too: it may be
--    restored), added up the way the trigger would have. After the trigger: creating it waits for
--    the postings that are running, and holds back new ones until the migration commits, so an
--    entry is counted once, here or by the trigger. Per tenant, with app.tenant_id set, because
--    FORCE RLS applies to the table owner too; cleared at the end, so no later migration in the
--    same run reads as the last workspace.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO account_day_totals (tenant_id, day, account_id, branch_id, closing, debit, credit)
    SELECT l.tenant_id, e.date, l.account_id, l.branch_id,
           e.source = 'year_close' OR coalesce(o.source = 'year_close', false),
           sum(l.debit), sum(l.credit)
      FROM journal_lines l
      JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      LEFT JOIN journal_entries o ON o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id
     WHERE l.tenant_id = t AND e.status = 'posted'
     GROUP BY 1, 2, 3, 4, 5;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
