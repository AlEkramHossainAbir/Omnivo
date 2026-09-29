import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions, rolePermissions, roles, tenants } from './schema/index.js';

// সিস্টেম-জোড়া permission-এর একমাত্র উৎস। নতুন permission এলে শুধু এখানে যোগ হবে —
// DB-তে তোলে syncPermissions(), আর @RequirePermission() এই তালিকা থেকেই টাইপ পায়
export const PERMISSIONS = [
  { key: 'core.user.read', description: 'View users in the workspace' },
  { key: 'core.user.invite', description: 'Invite users to the workspace' },
  { key: 'core.role.manage', description: 'Create roles and assign permissions' },
  {
    key: 'core.settings.manage',
    description: 'Edit the company profile, regional settings and numbering',
  },
  { key: 'core.branch.manage', description: 'Add, edit and archive branches' },
  { key: 'core.audit.read', description: 'View the audit log' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

// signup-এ যে রোল তৈরি হয় আর সব permission পায়
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values([...PERMISSIONS])
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}

// Owner মানে "সব অনুমতি" — কিন্তু সেটা ডেটায় লেখা, কোডে না। তাই নতুন permission যোগ হলে (এই ধাপে
// settings, branch, audit) পুরনো workspace-এর Owner আপনা-আপনি পায় না; signup শুধু নতুনদের দেয়।
// migrate প্রতিবার এটা চালায়: idempotent, যা আছে তা থাকে। role_permissions-এ FORCE RLS, তাই
// প্রতিটা টেন্যান্টের জন্য আলাদা transaction-এ tenant context বসিয়ে
export async function grantOwnerPermissions(db: PostgresJsDatabase): Promise<void> {
  const allPermissions = await db.select({ id: permissions.id }).from(permissions);
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(isNull(tenants.deletedAt));
  for (const tenant of tenantRows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`);
      const [owner] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(
          and(
            eq(roles.tenantId, tenant.id),
            eq(roles.name, OWNER_ROLE_NAME),
            isNull(roles.deletedAt),
          ),
        );
      if (!owner || allPermissions.length === 0) return;
      await tx
        .insert(rolePermissions)
        .values(
          allPermissions.map((permission) => ({
            tenantId: tenant.id,
            roleId: owner.id,
            permissionId: permission.id,
          })),
        )
        .onConflictDoNothing();
    });
  }
}
