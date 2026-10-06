import {
  ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_REASONS,
  STOCK_DOCUMENT_STATUSES,
  TRANSFER_STATUSES,
} from '@omnivo/contracts';
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
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// The columns every stock document line has: which variant, in which unit and how many, and the
// same quantity in the base unit. The factor is copied from the product at the time (1 for the
// base unit): removing or resizing a pack later never changes what an old line meant.
function lineColumns() {
  return {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    // As typed: 3 (cartons)
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    // Base units in one of that unit: 24
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    // In the base unit, rounded to its decimals: 72 (pcs)
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // The batch the line takes from (out), or the one it went into (in, set when posted)
    batchId: uuid('batch_id'),
    // One per base unit, for a serial-tracked product
    serialNumbers: text('serial_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  };
}

// ---------------------------------------------------------------------------------------------
// Stock adjustments

export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    // deleted_at is not used: a draft is deleted for real, a posted adjustment never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted (NumberingService, 'inventory.adjustment'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    direction: text('direction', { enum: ADJUSTMENT_DIRECTIONS }).notNull(),
    reason: text('reason', { enum: ADJUSTMENT_REASONS }).notNull(),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('stock_adjustments_tenant_id_idx').on(table.tenantId, table.id),
    // Drafts have no number; NULLs never collide
    uniqueIndex('stock_adjustments_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('stock_adjustments_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('stock_adjustments_tenant_warehouse_idx').on(table.tenantId, table.warehouseId),
    foreignKey({
      name: 'stock_adjustments_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ it has a number and a posting time, like a journal entry
    check(
      'stock_adjustments_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const stockAdjustmentLines = pgTable(
  'stock_adjustment_lines',
  {
    ...lineColumns(),
    adjustmentId: uuid('adjustment_id').notNull(),
    // An "in" line of a batch product: the lot as typed. Posting finds or makes the batch.
    lotNumber: text('lot_number'),
    expiresOn: date('expires_on', { mode: 'string' }),
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    // Step 14. An "in" line's cost per unit of the line, as typed (3 cartons at ৳1,200); NULL =
    // at the average cost. value: what the line moved, set when the adjustment is posted.
    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }),
    value: numeric('value', { precision: 19, scale: 4 }),
  },
  (table) => [
    uniqueIndex('stock_adjustment_lines_line_idx').on(
      table.tenantId,
      table.adjustmentId,
      table.lineNo,
    ),
    // A draft's line blocks deleting its variant too (product_variant_in_use): the draft would
    // otherwise point at nothing
    index('stock_adjustment_lines_variant_idx').on(
      table.tenantId,
      table.productId,
      table.variantId,
    ),
    foreignKey({
      name: 'stock_adjustment_lines_adjustment_fk',
      columns: [table.tenantId, table.adjustmentId],
      foreignColumns: [stockAdjustments.tenantId, stockAdjustments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_adjustment_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_adjustment_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'stock_adjustment_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'stock_adjustment_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'stock_adjustment_lines_value_check',
      sql`(${table.unitCost} IS NULL OR ${table.unitCost} >= 0) AND (${table.value} IS NULL OR ${table.value} >= 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Stock transfers

export const stockTransfers = pgTable(
  'stock_transfers',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when sent ('inventory.transfer')
    number: text('number'),
    status: text('status', { enum: TRANSFER_STATUSES }).notNull().default('draft'),
    fromWarehouseId: uuid('from_warehouse_id').notNull(),
    toWarehouseId: uuid('to_warehouse_id').notNull(),
    sentOn: date('sent_on', { mode: 'string' }).notNull(),
    receivedOn: date('received_on', { mode: 'string' }),
    note: text('note'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: uuid('received_by'),
  },
  (table) => [
    uniqueIndex('stock_transfers_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('stock_transfers_tenant_number_idx').on(table.tenantId, table.number),
    index('stock_transfers_tenant_date_idx').on(table.tenantId, table.sentOn, table.id),
    // What is on the road to a warehouse: the stock list's "in transit"
    index('stock_transfers_in_transit_idx')
      .on(table.tenantId, table.toWarehouseId)
      .where(sql`${table.status} = 'in_transit'`),
    index('stock_transfers_from_idx').on(table.tenantId, table.fromWarehouseId),
    foreignKey({
      name: 'stock_transfers_from_fk',
      columns: [table.tenantId, table.fromWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'stock_transfers_to_fk',
      columns: [table.tenantId, table.toWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('stock_transfers_places_check', sql`${table.fromWarehouseId} <> ${table.toWarehouseId}`),
    // Sent (in transit or received) ⇔ a number and a sending time; received ⇔ its date and time
    check(
      'stock_transfers_sent_check',
      sql`(${table.status} <> 'draft') = (${table.number} IS NOT NULL AND ${table.sentAt} IS NOT NULL)`,
    ),
    check(
      'stock_transfers_received_check',
      sql`(${table.status} = 'received') = (${table.receivedOn} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`,
    ),
  ],
);

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    ...lineColumns(),
    transferId: uuid('transfer_id').notNull(),
    // Set on receipt, in the base unit: what arrived. sent − received = the shortage.
    receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 }),
    receivedSerialNumbers: text('received_serial_numbers').array(),
    // What the line was worth when it left (step 14), at the average cost then; set when it is
    // sent. What arrives is valued at the same cost per unit; the rest is the shortage.
    value: numeric('value', { precision: 19, scale: 4 }),
  },
  (table) => [
    uniqueIndex('stock_transfer_lines_line_idx').on(table.tenantId, table.transferId, table.lineNo),
    index('stock_transfer_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'stock_transfer_lines_transfer_fk',
      columns: [table.tenantId, table.transferId],
      foreignColumns: [stockTransfers.tenantId, stockTransfers.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'stock_transfer_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_transfer_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'stock_transfer_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'stock_transfer_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'stock_transfer_lines_received_check',
      sql`${table.receivedQuantity} IS NULL OR ${table.receivedQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
    ),
  ],
);
