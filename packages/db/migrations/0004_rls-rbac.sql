-- Custom SQL migration file, put your code below! --

-- নতুন tenant-টেবিল: ENABLE + FORCE RLS + tenant_isolation (0002-এর মতো NULLIF সহ)
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_roles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- লগইন/tenant switcher: tenant context ছাড়াই ইউজার নিজের membership তালিকা পড়তে পারবে।
-- শুধু SELECT — লেখার জন্য tenant_isolation (tenant context) লাগবেই।
-- permissive policy OR হয়: tenant মিললে অথবা নিজের user_id হলে রো দেখা যাবে
CREATE POLICY own_memberships ON memberships
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- audit log append-only: অ্যাপ লিখতে ও পড়তে পারবে, বদলাতে বা মুছতে পারবে না
REVOKE UPDATE, DELETE ON audit_logs FROM omnivo_app;
