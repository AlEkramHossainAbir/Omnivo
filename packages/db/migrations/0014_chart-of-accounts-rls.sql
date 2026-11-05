-- Custom SQL migration file, put your code below! --

-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger_accounts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) Workspaces whose setup has already started have no chart yet: the setup job of step 8 only
--    made roles. The chart itself lives in TypeScript (apps/api/src/setup/templates.ts), so SQL
--    cannot write it. Instead, one outbox event per workspace asks the worker to do it, with the
--    same code the setup job uses. 'pending' workspaces are skipped on purpose: their owner has
--    not picked a business type yet, and the setup job will make the right chart after the pick.
--    outbox_events has FORCE RLS (0012), so each insert runs inside its tenant's context, like 0010.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE setup_status <> 'pending' AND deleted_at IS NULL LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO outbox_events (id, tenant_id, type, payload)
    VALUES (gen_random_uuid(), t, 'workspace.chart_requested', '{}'::jsonb);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
