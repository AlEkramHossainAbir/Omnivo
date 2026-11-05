import { pgTable, uuid, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { roles } from './roles.js';
import { permissions } from './permissions.js';

export const rolePermissions = pgTable(
  'role_permissions',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleId: uuid('role_id').notNull(),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id),
  },
  (table) => [
    uniqueIndex('role_permissions_tenant_role_permission_idx').on(
      table.tenantId,
      table.roleId,
      table.permissionId,
    ),
    // composite FK: অন্য টেন্যান্টের role-কে রেফার করা DB-লেভেলেই অসম্ভব (FK চেক RLS মানে না)
    foreignKey({
      name: 'role_permissions_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
  ],
);
