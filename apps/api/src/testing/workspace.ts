import postgres from 'postgres';

// ধাপ ৭-এর invite আসার আগে: একজন বিদ্যমান ইউজারকে আরেকটা workspace-এ ঢোকানো, কোনো রোল ছাড়া —
// তাহলে সে লগইন করতে পারে কিন্তু কোনো permission নেই। সরাসরি SQL (superuser, RLS-এর বাইরে)
export async function joinWithoutRoles(
  superuserUrl: string,
  { email, workspace }: { email: string; workspace: string },
): Promise<void> {
  const sql = postgres(superuserUrl, { max: 1 });
  try {
    await sql`
      INSERT INTO memberships (id, tenant_id, user_id)
      SELECT gen_random_uuid(), t.id, u.id
      FROM tenants t, users u
      WHERE t.slug = ${workspace} AND u.email = ${email}`;
  } finally {
    await sql.end();
  }
}
