-- Custom SQL migration file, put your code below! --

-- ১) আগে থেকে থাকা workspace-এর জন্য settings রো আর একটা "Head office" ব্রাঞ্চ। RLS চালু করার
--    আগে: migrator টেবিলের মালিক, কিন্তু FORCE RLS মালিককেও আটকায় — পরে লিখলে tenant context লাগত।
--    নতুন workspace এগুলো signup-এর provisioning-এ পায় (auth.service.ts)
INSERT INTO tenant_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT DO NOTHING;

-- gen_random_uuid() = UUIDv4 (Postgres 17-এ uuidv7() নেই, ১৮-এ আসছে)। শুধু এই কয়েকটা পুরনো রো-র
-- জন্য; ক্রমের সুবিধা হারানো এখানে কিছু না
INSERT INTO branches (id, tenant_id, code, name)
SELECT gen_random_uuid(), id, 'HO', 'Head office' FROM tenants
ON CONFLICT DO NOTHING;

-- ২) নতুন tenant-টেবিলে ENABLE + FORCE RLS + tenant_isolation (0002-এর মতো NULLIF সহ)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'tenant_settings', 'branches', 'number_series', 'number_series_counters', 'attachments'
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

-- ৩) নম্বরের কাউন্টার শুধু বাড়ে: মুছে ফেললে পরের ডকুমেন্ট আবার ০০০১ পেত — দুটো INV-2026-27-0001
REVOKE DELETE ON number_series_counters FROM omnivo_app;
