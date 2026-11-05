import { RETURN_REASONS, STOCK_DOCUMENT_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
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
import { billLines } from './bills.js';
import { goodsReceiptLines } from './goods-receipts.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { stockLineColumns } from './stock-documents.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17d: purchase returns, goods sent back to a supplier. The sales return of 15d the other way
// round: a draft is changed freely; posting numbers it, takes the stock out and puts its cost back
// on goods received not billed. From then on only what debit notes took off for its lines
// (debited_quantity) moves. The rules live in migration 0042.

export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    // deleted_at is not used: a draft is deleted for real, a posted return never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('purchase.return'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').notNull(),
    // Where every line leaves from (decision 14)
    warehouseId: uuid('warehouse_id').notNull(),
    // Decides nothing in the books: the list and the reports show it
    reason: text('reason', { enum: RETURN_REASONS }).notNull(),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('purchase_returns_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('purchase_returns_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('purchase_returns_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One supplier's returns (the list's filter), and the supplier FK's check on delete
    index('purchase_returns_supplier_idx').on(
      table.tenantId,
      table.supplierId,
      table.date,
      table.id,
    ),
    // The list's warehouse filter
    index('purchase_returns_warehouse_idx').on(table.tenantId, table.warehouseId),
    // No ON DELETE: a supplier with a return cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'purchase_returns_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'purchase_returns_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ a number and a posting time, like a goods receipt
    check(
      'purchase_returns_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const purchaseReturnLines = pgTable(
  'purchase_return_lines',
  {
    ...stockLineColumns(),
    returnId: uuid('return_id').notNull(),
    // The goods receipt line the goods came in on; NULL for a line on its own (goods that came in
    // before the workspace used Omnivo)
    receiptLineId: uuid('receipt_line_id'),
    // The bill line that had billed that receipt line when the return was posted, and its bill.
    // Set by the posting and never again: NULL = not billed then (the bill bills less instead),
    // and always NULL on a draft and on a line on its own. The contract's `billed`.
    billId: uuid('bill_id'),
    billLineId: uuid('bill_line_id'),
    // What the goods left at (step 14's value): the receipt line's cost, or the average cost for a
    // line on its own (decision 2). NULL while a draft.
    value: numeric('value', { precision: 19, scale: 4 }),
    // In the base unit: what posted debit note lines took off for this line. Written by the debit
    // note's posting; it only grows (migration 0042).
    debitedQuantity: numeric('debited_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('purchase_return_lines_line_idx').on(table.tenantId, table.returnId, table.lineNo),
    // The target of the debit note line's FKs: THIS return line, for THIS item; and a return line
    // that THIS bill line billed
    uniqueIndex('purchase_return_lines_variant_target_idx').on(
      table.tenantId,
      table.id,
      table.variantId,
    ),
    uniqueIndex('purchase_return_lines_bill_line_id_idx').on(
      table.tenantId,
      table.billLineId,
      table.id,
    ),
    index('purchase_return_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // A goods receipt's returns (its page), and the receipt line FK's check
    index('purchase_return_lines_receipt_line_idx')
      .on(table.tenantId, table.receiptLineId)
      .where(sql`${table.receiptLineId} IS NOT NULL`),
    foreignKey({
      name: 'purchase_return_lines_return_fk',
      columns: [table.tenantId, table.returnId],
      foreignColumns: [purchaseReturns.tenantId, purchaseReturns.id],
    }).onDelete('cascade'),
    // variant_id is in the next two keys: the receipt line brought in, and the bill line billed,
    // the very item that goes back. No ON DELETE: a posted receipt's and a posted bill's lines are
    // never deleted.
    foreignKey({
      name: 'purchase_return_lines_receipt_line_fk',
      columns: [table.tenantId, table.receiptLineId, table.variantId],
      foreignColumns: [
        goodsReceiptLines.tenantId,
        goodsReceiptLines.id,
        goodsReceiptLines.variantId,
      ],
    }),
    // bill_id is in the key: the bill line is a line of that bill
    foreignKey({
      name: 'purchase_return_lines_bill_line_fk',
      columns: [table.tenantId, table.billId, table.billLineId, table.variantId],
      foreignColumns: [billLines.tenantId, billLines.billId, billLines.id, billLines.variantId],
    }),
    foreignKey({
      name: 'purchase_return_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'purchase_return_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'purchase_return_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'purchase_return_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check('purchase_return_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
    // Billed only through a receipt line, and the bill and its line come together
    check(
      'purchase_return_lines_billed_check',
      sql`(${table.billId} IS NULL) = (${table.billLineId} IS NULL) AND (${table.billLineId} IS NULL OR ${table.receiptLineId} IS NOT NULL)`,
    ),
    // Never debited past what went back. A receipt line that no bill had billed is never debited:
    // the bill billed less instead. The last word on debit_note_over_return.
    check(
      'purchase_return_lines_debited_check',
      sql`${table.debitedQuantity} BETWEEN 0 AND ${table.baseQuantity} AND (${table.billLineId} IS NOT NULL OR ${table.receiptLineId} IS NULL OR ${table.debitedQuantity} = 0)`,
    ),
  ],
);
