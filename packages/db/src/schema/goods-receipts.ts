import { STOCK_DOCUMENT_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { bills } from './bills.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { purchaseOrderLines, purchaseOrders } from './purchase-orders.js';
import { stockLineColumns } from './stock-documents.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17b: goods receipts (GRN). Like a delivery: a draft is changed freely, a posted one never
// (migration 0038). Always made from an approved purchase order (decision 8).
// Step 17c: or by a bill's own goods lines, with no order (decision 21; rules in migration 0040).
// Bills mark the lines they bill (billed).
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    // deleted_at is not used: a draft is deleted for real, a posted receipt never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('inventory.receipt'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // The order's supplier: in the FK below, so it cannot be another one
    supplierId: uuid('supplier_id').notNull(),
    // Never changes once the receipt is written (decision 20, migration 0038). Step 17c: NULL on a
    // receipt a bill made, which names its bill instead (exactly one of the two)
    orderId: uuid('order_id'),
    billId: uuid('bill_id'),
    // Where it was unloaded; may be another warehouse than the order's (decision 20)
    warehouseId: uuid('warehouse_id').notNull(),
    // The number on the supplier's own delivery challan
    supplierChallan: text('supplier_challan'),
    vehicle: text('vehicle'),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('goods_receipts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the line's FK: the line's order is its receipt's order
    uniqueIndex('goods_receipts_order_id_idx').on(table.tenantId, table.id, table.orderId),
    uniqueIndex('goods_receipts_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('goods_receipts_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('goods_receipts_supplier_idx').on(table.tenantId, table.supplierId, table.date, table.id),
    // An order's receipts (its page; "has it any receipt?" before a reopen or a cancel)
    index('goods_receipts_order_idx').on(table.tenantId, table.orderId),
    index('goods_receipts_warehouse_idx').on(table.tenantId, table.warehouseId),
    // Step 17c: the receipt a bill made (its page), and the FK's check. A bill makes at most one:
    // its goods lines of its own all come into its one warehouse.
    uniqueIndex('goods_receipts_bill_idx')
      .on(table.tenantId, table.billId)
      .where(sql`${table.billId} IS NOT NULL`),
    foreignKey({
      name: 'goods_receipts_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // supplier_id is in both keys: a receipt's order is always an order of the same supplier
    foreignKey({
      name: 'goods_receipts_order_fk',
      columns: [table.tenantId, table.supplierId, table.orderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.supplierId, purchaseOrders.id],
    }),
    // Step 17c: the same with the bill. A posted bill is never deleted, and the receipt is made
    // only while it is being posted.
    foreignKey({
      name: 'goods_receipts_bill_fk',
      columns: [table.tenantId, table.supplierId, table.billId],
      foreignColumns: [bills.tenantId, bills.supplierId, bills.id],
    }),
    foreignKey({
      name: 'goods_receipts_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check(
      'goods_receipts_source_check',
      sql`(${table.orderId} IS NULL) <> (${table.billId} IS NULL)`,
    ),
    // Posted ⇔ it has a number and a posting time, like a delivery
    check(
      'goods_receipts_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

// A line: a stock line (decision 20: quantity and base_quantity are what was accepted), the lot
// as typed like an adjustment's "in" line, what was turned back and why, and the order line it
// receives
export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    ...stockLineColumns(),
    receiptId: uuid('receipt_id').notNull(),
    // A copy of the receipt's order, so the FKs below can say the order line is a line of it.
    // Step 17c: both NULL on a receipt a bill made.
    orderId: uuid('order_id'),
    orderLineId: uuid('order_line_id'),
    // A batch product: the lot as typed. Posting finds or makes the batch (batch_id).
    lotNumber: text('lot_number'),
    expiresOn: date('expires_on', { mode: 'string' }),
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    // What was turned back, as typed and in the base unit (same factor as the line), and why
    rejectedQuantity: numeric('rejected_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    rejectedBaseQuantity: numeric('rejected_base_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    rejectionReason: text('rejection_reason'),
    // What the accepted goods were booked at (the order line's net per base unit), set when posted
    value: numeric('value', { precision: 19, scale: 4 }),
    // Step 17c: a posted bill billed it. Set by the bill's posting, false → true and never back
    // (migration 0040), so one line is never billed twice.
    billed: boolean('billed').notNull().default(false),
  },
  (table) => [
    uniqueIndex('goods_receipt_lines_line_idx').on(table.tenantId, table.receiptId, table.lineNo),
    index('goods_receipt_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // Step 17c: the target of the bill line's FK: THIS line, for THIS variant
    uniqueIndex('goods_receipt_lines_bill_target_idx').on(
      table.tenantId,
      table.id,
      table.variantId,
    ),
    // Step 17c: the receipts with something left to bill (the to_bill filter, the bill form).
    // Partial: once billed, a line leaves it.
    index('goods_receipt_lines_to_bill_idx')
      .on(table.tenantId, table.receiptId)
      .where(sql`NOT ${table.billed} AND ${table.quantity} > 0`),
    // An order line's receipts, and the order line FK's check
    index('goods_receipt_lines_order_line_idx').on(
      table.tenantId,
      table.orderId,
      table.orderLineId,
    ),
    // Step 17c: the receipt alone. The key below holds order_id, and a key with a NULL in it is not
    // checked at all (MATCH SIMPLE), so a line of a receipt a bill made needs this one.
    foreignKey({
      name: 'goods_receipt_lines_receipt_id_fk',
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id],
    }).onDelete('cascade'),
    // order_id is in the key: a line belongs to a receipt of that order. When a draft receipt is
    // deleted, its lines go with it.
    foreignKey({
      name: 'goods_receipt_lines_receipt_fk',
      columns: [table.tenantId, table.receiptId, table.orderId],
      foreignColumns: [goodsReceipts.tenantId, goodsReceipts.id, goodsReceipts.orderId],
    }).onDelete('cascade'),
    // order_id and variant_id are in the key: the order line is a line of the receipt's order, for
    // the item the line brings in. No ON DELETE: an order with a receipt is never reopened
    // (decision 21), so its lines are not replaced.
    foreignKey({
      name: 'goods_receipt_lines_order_line_fk',
      columns: [table.tenantId, table.orderId, table.orderLineId, table.variantId],
      foreignColumns: [
        purchaseOrderLines.tenantId,
        purchaseOrderLines.orderId,
        purchaseOrderLines.id,
        purchaseOrderLines.variantId,
      ],
    }),
    foreignKey({
      name: 'goods_receipt_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'goods_receipt_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'goods_receipt_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    // Either part may be zero, never both (the contract's grn_line_empty), and each is zero in the
    // line's unit exactly when it is zero in the base unit
    check(
      'goods_receipt_lines_quantity_check',
      sql`${table.factor} > 0 AND ${table.quantity} >= 0 AND ${table.rejectedQuantity} >= 0 AND ${table.quantity} + ${table.rejectedQuantity} > 0 AND (${table.quantity} = 0) = (${table.baseQuantity} = 0) AND (${table.rejectedQuantity} = 0) = (${table.rejectedBaseQuantity} = 0)`,
    ),
    // A rejection says why (the contract's grn_rejection_reason); 200 = the contract's limit
    check(
      'goods_receipt_lines_rejection_check',
      sql`(${table.rejectedQuantity} = 0 OR ${table.rejectionReason} IS NOT NULL) AND (${table.rejectionReason} IS NULL OR char_length(${table.rejectionReason}) BETWEEN 1 AND 200)`,
    ),
    check('goods_receipt_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
    // Step 17c: an order line exactly when an order. Only a line that accepted something is billed
    // (a line that turned everything back has nothing to bill).
    check(
      'goods_receipt_lines_order_check',
      sql`(${table.orderId} IS NULL) = (${table.orderLineId} IS NULL)`,
    ),
    check('goods_receipt_lines_billed_check', sql`NOT ${table.billed} OR ${table.quantity} > 0`),
  ],
);
