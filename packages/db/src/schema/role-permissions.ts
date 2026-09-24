import { pgTable, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id),
  },
  (table) => [
    index('role_permissions_tenant_idx').on(table.tenantId),
    uniqueIndex('role_permissions_role_permission_idx').on(table.roleId, table.permissionId),
  ],
);
