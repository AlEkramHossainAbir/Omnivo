import { pgTable, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const memberships = pgTable(
  'memberships',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('memberships_tenant_user_idx').on(table.tenantId, table.userId),
    // membership_roles-এর composite FK-এর target
    uniqueIndex('memberships_tenant_id_idx').on(table.tenantId, table.id),
    // লগইনে "এই ইউজার কোন কোন টেন্যান্টে আছে" — ইচ্ছাকৃতভাবে cross-tenant lookup, তাই tenant_id দিয়ে শুরু না
    index('memberships_user_idx').on(table.userId),
  ],
);
