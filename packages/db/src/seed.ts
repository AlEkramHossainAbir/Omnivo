import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadRootEnv, requireEnv } from './env.js';
import {
  tenants,
  users,
  memberships,
  roles,
  permissions,
  rolePermissions,
  membershipRoles,
} from './schema/index.js';

loadRootEnv();

// সিস্টেম-জোড়া permission তালিকা; নতুন permission এলে এখানে যোগ হবে
const PERMISSIONS = [
  { key: 'core.user.read', description: 'View users in the workspace' },
  { key: 'core.user.invite', description: 'Invite users to the workspace' },
  { key: 'core.role.manage', description: 'Create roles and assign permissions' },
] as const;

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
    await tx
      .insert(permissions)
      .values([...PERMISSIONS])
      .onConflictDoNothing({
        target: permissions.key,
      });
    const permissionRows = await tx
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        inArray(
          permissions.key,
          PERMISSIONS.map((p) => p.key),
        ),
      );

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

    await tx
      .insert(roles)
      .values({ tenantId: tenant.id, name: 'Owner' })
      .onConflictDoNothing({ target: [roles.tenantId, roles.name] });
    const owner = one(
      await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, tenant.id), eq(roles.name, 'Owner'))),
      'Owner role',
    );

    await tx
      .insert(rolePermissions)
      .values(
        permissionRows.map((p) => ({ tenantId: tenant.id, roleId: owner.id, permissionId: p.id })),
      )
      .onConflictDoNothing();

    await tx
      .insert(membershipRoles)
      .values({ tenantId: tenant.id, membershipId: membership.id, roleId: owner.id })
      .onConflictDoNothing();
  });

  await client.end();
  console.log('seed done');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
