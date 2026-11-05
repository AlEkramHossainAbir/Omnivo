import { pgTable, uuid, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { memberships } from './memberships.js';
import { roles } from './roles.js';

// একজন ইউজার একটা টেন্যান্টে কোন কোন role-এ আছে
export const membershipRoles = pgTable(
  'membership_roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (table) => [
    uniqueIndex('membership_roles_tenant_membership_role_idx').on(
      table.tenantId,
      table.membershipId,
      table.roleId,
    ),
    // composite FK: membership আর role দুটোই একই টেন্যান্টের হতে হবে
    foreignKey({
      name: 'membership_roles_membership_fk',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
    foreignKey({
      name: 'membership_roles_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
  ],
);
