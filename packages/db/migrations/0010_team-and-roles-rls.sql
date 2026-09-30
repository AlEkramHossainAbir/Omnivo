-- Custom SQL migration file, put your code below! --

-- ১) আগে থেকে থাকা workspace-এর "Owner" রোল → kind = 'owner', আর তার role_permissions-এর রো মুছে
--    ফেলা (owner-এর অধিকার এখন কোডে)। roles আর role_permissions-এ FORCE RLS আছে (0001), তাই migrator-ও
--    tenant context ছাড়া একটা রো-ও দেখে না — UPDATE চুপচাপ ০ রো বদলাত। RLS বন্ধ না করে, অ্যাপের মতোই
--    প্রতিটা টেন্যান্টের context বসিয়ে। set_config(..., true) = এই transaction-এর ভেতরেই
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE roles SET kind = 'owner' WHERE tenant_id = t AND name = 'Owner';
    DELETE FROM role_permissions rp
      USING roles r
      WHERE rp.tenant_id = t AND r.tenant_id = t AND r.id = rp.role_id AND r.kind = 'owner';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- ২) নতুন tenant-টেবিলে ENABLE + FORCE RLS + tenant_isolation (0002-এর মতো NULLIF সহ)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['invitations', 'invitation_roles'])
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

-- ৩) invitation-এর লিংক খোলা লোকটা এখনো কোনো টেন্যান্টে নেই (লগইনই করেনি), তাই tenant context নেই।
--    0004-এর own_memberships-এর ছাঁচে: শুধু SELECT, আর শুধু সেই রো যার token_hash ঠিক এই মান —
--    token না জানলে কোনো রো দেখা যায় না। লেখা (গ্রহণ) হয় এর পরে, টেন্যান্ট জেনে tenant_isolation দিয়ে
CREATE POLICY invitation_by_token ON invitations
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.invitation_token_hash', true), ''));
