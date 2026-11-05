import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';
import { OWNER_ROLE_NAME, syncPermissions } from './permission-catalog.js';
import {
  tenants,
  users,
  memberships,
  roles,
  membershipRoles,
  branches,
  tenantSettings,
} from './schema/index.js';

loadRootEnv();

// noUncheckedIndexedAccess-এর কারণে rows[0] হলো T | undefined — এখানে একবার narrow করা
function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`seed: ${what} not found`);
  }
  return row;
}

async function main() {
  const client = postgres(requireEnv('MIGRATOR_DATABASE_URL'), { max: 1 });
  const db = drizzle(client);

  // সব insert idempotent — বারবার চালালেও একই অবস্থা থাকবে
  await db.transaction(async (tx) => {
    await syncPermissions(tx);

    const tenant = one(
      await tx
        .insert(tenants)
        .values({ name: 'Acme Textiles', slug: 'acme' })
        .onConflictDoUpdate({ target: tenants.slug, set: { name: 'Acme Textiles' } })
        .returning({ id: tenants.id }),
      'tenant',
    );

    const user = one(
      await tx
        .insert(users)
        .values({ email: 'admin@acme.omnivo.app', fullName: 'Acme Admin' })
        .onConflictDoUpdate({ target: users.email, set: { fullName: 'Acme Admin' } })
        .returning({ id: users.id }),
      'user',
    );

    // বাকি টেবিলে FORCE ROW LEVEL SECURITY আছে, তাই insert-এর আগে
    // এই ট্রানজ্যাকশনে tenant context সেট করতে হবে — নাহলে policy insert ব্লক করবে।
    // true = transaction-local, tx কমিট/রোলব্যাক হলে এই সেটিংও সাথে যায়
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);

    await tx
      .insert(memberships)
      .values({ tenantId: tenant.id, userId: user.id })
      .onConflictDoNothing({ target: [memberships.tenantId, memberships.userId] });
    const membership = one(
      await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user.id))),
      'membership',
    );

    // owner রোলের অধিকার কোডে — role_permissions-এ কিছু লেখার নেই। conflict-এর target partial index
    // (roles_tenant_owner_idx), তাই where-ও দিতে হয়: Postgres index-এর শর্ত মিলিয়ে তবেই সেটা চেনে
    await tx
      .insert(roles)
      .values({ tenantId: tenant.id, name: OWNER_ROLE_NAME, kind: 'owner' })
      .onConflictDoNothing({ target: roles.tenantId, where: sql`kind = 'owner'` });
    const owner = one(
      await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), eq(roles.kind, 'owner'))),
      'Owner role',
    );

    await tx
      .insert(membershipRoles)
      .values({ tenantId: tenant.id, membershipId: membership.id, roleId: owner.id })
      .onConflictDoNothing();

    // signup-এর provisioning যা দেয় seed-ও তা-ই দেয়: settings রো (ডিফল্ট মান) আর একটা ব্রাঞ্চ
    await tx.insert(tenantSettings).values({ tenantId: tenant.id }).onConflictDoNothing();
    await tx
      .insert(branches)
      .values({ tenantId: tenant.id, code: 'HO', name: 'Head office' })
      .onConflictDoNothing({ target: [branches.tenantId, branches.code] });
  });

  await client.end();
  console.log('seed done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
