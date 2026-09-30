import { PERMISSION_KEYS, type PermissionKey } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { permissions } from './schema/index.js';

// key-এর তালিকা contracts-এ (API, UI, অনুবাদ সবাই সেখান থেকে); এখানে শুধু DB-র permissions টেবিলের
// ইংরেজি বিবরণ — psql বা Drizzle Studio-তে দেখার জন্য। satisfies: নতুন key-র বিবরণ ভুলে গেলে compile error
const DESCRIPTIONS = {
  'core.user.read': 'View people in the workspace',
  'core.user.invite': 'Invite people and manage open invitations',
  'core.user.manage': "Change members' roles and remove members",
  'core.role.manage': 'Create roles and choose their permissions',
  'core.settings.manage': 'Edit the company profile, regional settings and numbering',
  'core.branch.manage': 'Add, edit and archive branches',
  'core.audit.read': 'View the audit log',
} satisfies Record<PermissionKey, string>;

export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));

// signup-এ তৈরি owner রোলের নাম। নামটা শুধু দেখানোর — কোড owner চেনে roles.kind দিয়ে, নাম দিয়ে না
export const OWNER_ROLE_NAME = 'Owner';

// Pick<..., 'insert'>: migrate-এর plain db, createDb()-এর Db, বা transaction-এর tx — সবই চলে
// idempotent: নতুন key যোগ হয়, পুরনো key-এর description আপডেট হয়; কিছু মোছে না
export async function syncPermissions(db: Pick<PostgresJsDatabase, 'insert'>): Promise<void> {
  await db
    .insert(permissions)
    .values(PERMISSIONS)
    .onConflictDoUpdate({
      target: permissions.key,
      set: { description: sql`excluded.description` },
    });
}
