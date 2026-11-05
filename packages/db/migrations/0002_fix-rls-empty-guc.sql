-- Custom SQL migration file, put your code below! --

-- set_config(..., true) দিয়ে সেট করা মান transaction শেষে NULL না হয়ে '' হয়ে যায়।
-- তখন ''::uuid error দেয়, তাই pool-এর একই connection-এ context ছাড়া পরের query crash করত।
-- খালি স্ট্রিংকে NULL বানাও, তাহলে তুলনা false হবে (error না)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['memberships', 'roles', 'role_permissions', 'audit_logs'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
