import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { tenants } from './tenants.js';

// A place that holds stock, inside a branch (step 13). Archived, never deleted: its movements stay
// in the stock ledger and point at it. deleted_at (from baseColumns) is not used, like branches.
export const warehouses = pgTable(
  'warehouses',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    branchId: uuid('branch_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // An archived warehouse keeps its code: "FAB" in an old stock card means one place
    uniqueIndex('warehouses_tenant_code_idx').on(table.tenantId, table.code),
    // The target of the composite FKs from movements, balances, documents and serials
    uniqueIndex('warehouses_tenant_id_idx').on(table.tenantId, table.id),
    // A branch's warehouses — and Postgres's own check of the FK below
    index('warehouses_tenant_branch_idx').on(table.tenantId, table.branchId),
    foreignKey({
      name: 'warehouses_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
  ],
);
