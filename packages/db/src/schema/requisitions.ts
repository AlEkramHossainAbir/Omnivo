import { REQUISITION_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { users } from './users.js';
import { warehouses } from './warehouses.js';

// Step 17a: purchase requisitions. The rules on what may change when (and when one may be
// deleted) live in migration 0036.
export const requisitions = pgTable(
  'requisitions',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other
    // requisition never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('purchase.requisition'), like a quotation's
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    neededBy: date('needed_by', { mode: 'string' }),
    // Where the goods are for; the warehouse's branch is the requisition's
    warehouseId: uuid('warehouse_id').notNull(),
    status: text('status', { enum: REQUISITION_STATUSES }).notNull().default('draft'),
    // contracts' requisitionAmount() when it was saved: the approval levels are chosen by it
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull().default('0'),
    note: text('note'),
    // Who wrote it. Not created_by: that one has no foreign key and may be empty on old rows of
    // other tables; this one is shown on the document, so it must name a real person.
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('requisitions_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('requisitions_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('requisitions_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One warehouse's requisitions (the list's filter), and the warehouse FK's check
    index('requisitions_warehouse_idx').on(table.tenantId, table.warehouseId, table.date, table.id),
    foreignKey({
      name: 'requisitions_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check(
      'requisitions_needed_by_check',
      sql`${table.neededBy} IS NULL OR ${table.neededBy} >= ${table.date}`,
    ),
    check('requisitions_amount_check', sql`${table.amount} >= 0`),
  ],
);

// A line: the product, the quantity as typed and in the base unit (like a stock line), and the
// cost the person expects per one of the unit. No batch, no serial numbers and no VAT: nothing
// is bought yet.
export const requisitionLines = pgTable(
  'requisition_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requisitionId: uuid('requisition_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // The person's own text, or the product's name with its variant's options
    description: text('description').notNull(),
    estimatedCost: numeric('estimated_cost', { precision: 19, scale: 4 }).notNull(),
    // contracts' requisitionLineAmount() when it was saved
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('requisition_lines_line_idx').on(table.tenantId, table.requisitionId, table.lineNo),
    // A line blocks deleting its variant (product_variant_in_use), and finds where it is used
    index('requisition_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'requisition_lines_requisition_fk',
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'requisition_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'requisition_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    check(
      'requisition_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'requisition_lines_amount_check',
      sql`${table.estimatedCost} >= 0 AND ${table.amount} >= 0`,
    ),
  ],
);
