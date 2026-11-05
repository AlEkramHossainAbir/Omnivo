-- Custom SQL migration file, put your code below! --

-- 1) Workspaces that exist before step 8 were set up by the old sign-up, which did everything in
--    one transaction. They must not be sent to the onboarding wizard. tenants has no RLS, so a
--    plain UPDATE sees every row. New workspaces keep the column default, 'pending'.
UPDATE tenants SET setup_status = 'ready';

-- 2) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['outbox_events', 'notifications'])
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

-- 3) The API only ever adds to the outbox. Without these rights, a bug (or an injected query) in
--    the API cannot read other events, mark them published, or delete them.
REVOKE SELECT, UPDATE, DELETE ON outbox_events FROM omnivo_app;

-- 4) The relay reads new events of EVERY tenant, so tenant_isolation alone would show it nothing.
--    It connects as its own role, omnivo_worker (infra/docker/postgres/init/01-roles.sql), and
--    this policy applies to that role only. Policies are OR-ed, so omnivo_worker sees all outbox
--    rows while omnivo_app still sees only its tenant's. omnivo_worker has no rights on any other
--    table: the worker's jobs use omnivo_app with a tenant context, like the API.
GRANT SELECT, UPDATE, DELETE ON outbox_events TO omnivo_worker;
CREATE POLICY outbox_relay ON outbox_events
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);
