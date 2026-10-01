-- Custom SQL migration file, put your code below! --

-- The new tenant table: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). The
-- worker reads and finishes an export as omnivo_app inside the export's tenant, like every job,
-- so no grant to omnivo_worker is needed: that role stays limited to the outbox (0012).
ALTER TABLE report_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_exports
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
