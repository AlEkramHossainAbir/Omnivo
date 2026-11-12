-- Custom SQL migration file, put your code below! --
-- Step 21c: scheduled report emails. 0061 made the two tables; this file gives them their tenant
-- rules and lets the worker's sweep see when each schedule is due, and nothing more.

-- 1) The two new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['report_schedules', 'report_schedule_recipients'])
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

-- 2) The sweep (every 5 minutes) looks for the due schedules of EVERY workspace in one query, so
--    tenant_isolation alone would show it nothing. It reads as the worker's own role, like the
--    outbox relay (0012) and the sync log's cleanup (0044), with a policy for that role only.
--    Three columns, not the table: the sweep needs to know which schedule of which workspace is
--    due, never what it sends or to whom. The rest of the run (moving next_run_at on, writing the
--    outbox event, making the files) happens as omnivo_app inside that one workspace, so a bug in
--    the sweep can neither read another workspace's filters and recipients nor change a schedule.
--    omnivo_worker gets nothing on report_schedule_recipients.
GRANT SELECT (id, tenant_id, next_run_at) ON report_schedules TO omnivo_worker;
CREATE POLICY report_schedule_sweep ON report_schedules
  FOR SELECT
  TO omnivo_worker
  USING (true);
