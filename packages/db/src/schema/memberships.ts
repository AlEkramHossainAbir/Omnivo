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
    index('memberships_tenant_idx').on(table.tenantId),
    uniqueIndex('memberships_tenant_user_idx').on(table.tenantId, table.userId),
  ],
);
