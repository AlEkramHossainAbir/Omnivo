import { pgTable, uuid, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

export const roles = pgTable(
  'roles',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
  },
  (table) => [
    uniqueIndex('roles_tenant_name_idx').on(table.tenantId, table.name),
    // role_permissions / membership_roles-এর composite FK-এর target
    uniqueIndex('roles_tenant_id_idx').on(table.tenantId, table.id),
  ],
);
