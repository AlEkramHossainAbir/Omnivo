import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions } from './schema/index.js';

// সিস্টেম-জোড়া permission-এর একমাত্র উৎস। নতুন permission এলে শুধু এখানে যোগ হবে —
// DB-তে তোলে syncPermissions(), আর @RequirePermission() এই তালিকা থেকেই টাইপ পায়
export const PERMISSIONS = [
  { key: 'core.user.read', description: 'View users in the workspace' },
  { key: 'core.user.invite', description: 'Invite users to the workspace' },
  { key: 'core.role.manage', description: 'Create roles and assign permissions' },
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
