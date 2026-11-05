-- Custom SQL migration file, put your code below! --

-- 1) The six new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'tax_rates', 'customer_groups', 'parties', 'party_addresses', 'price_lists',
      'price_list_items'
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

-- 2) "Contains" search for the customer list, like 0020's for products: part of a name, a code,
--    a contact person or a phone number ("1711" finds "01711-234567"). pg_trgm is there since
--    0020. Not in the Drizzle schema, for the same reason as 0020's.
CREATE INDEX parties_name_trgm_idx ON parties USING gin (lower(name) gin_trgm_ops);
CREATE INDEX parties_code_trgm_idx ON parties USING gin (lower(code) gin_trgm_ops);
CREATE INDEX parties_contact_trgm_idx ON parties USING gin (lower(contact_person) gin_trgm_ops);
CREATE INDEX parties_phone_trgm_idx ON parties USING gin (phone gin_trgm_ops);

-- 3) The posting check from 0016, with one more rule: a line has a party exactly when its account
--    is kept per party (contracts' PARTY_ACCOUNT_PURPOSES: the receivable). This is what makes the
--    customers' balances add up to the receivable account, so it lives here, under every path that
--    posts. It runs when an entry is posted, so lines posted before step 15a are never checked.
--    One exception: a reversal copies its original's lines as they were, so the reversal of an
--    entry from before step 15a may have a receivable line without a party. Without it, such an
--    entry (or the old opening balances, which a save reverses) could never be undone.
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
       AND (l.party_id IS NOT NULL) <> coalesce(a.purpose IN ('accounts_receivable'), false)
       AND NOT (NEW.source = 'reversal' AND l.party_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'journal entry % has a party on the wrong line', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_party_check';
  END IF;
  RETURN NULL;
END $$;

-- 4) The VAT rates of the workspaces that already exist. The list lives in TypeScript (the setup
--    templates, 15a.3), so, like 0020's catalog and 0024's stock accounts, one outbox event per
--    workspace asks the worker to make them with the same code the setup job uses. 'pending'
--    workspaces are skipped: their setup job makes them after the owner picks a business type.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.tax_rates_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
