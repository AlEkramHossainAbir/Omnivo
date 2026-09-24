import { pgTable, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
    index('roles_tenant_idx').on(table.tenantId),
    uniqueIndex('roles_tenant_name_idx').on(table.tenantId, table.name),
  ],
);
