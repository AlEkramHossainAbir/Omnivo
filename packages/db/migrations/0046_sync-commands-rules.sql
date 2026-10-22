-- Custom SQL migration file, put your code below! --
-- 1) The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
ALTER TABLE sync_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_commands
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) An answer is written once and never changed (decision 10). A device that sends a command
--    again must get the answer it would have got the first time; an UPDATE could turn a refusal
--    into an acceptance that never ran, or the other way round. So the push (18b.3) never claims
--    a command with a row it fills in later: it locks the command's id, looks it up, runs the
--    command behind a savepoint, and inserts the finished answer, all in one transaction.
REVOKE UPDATE, DELETE ON sync_commands FROM omnivo_app;

-- 3) The answers keep 30 days, like the change log (0044): a device sends a command again within
--    minutes of a lost answer, never a month later. The worker's hourly cleanup deletes the older
--    rows of EVERY tenant in one statement, as omnivo_worker: this policy is for that role only.
GRANT SELECT, DELETE ON sync_commands TO omnivo_worker;
CREATE POLICY sync_prune ON sync_commands
  TO omnivo_worker
  USING (true)
  WITH CHECK (true);
