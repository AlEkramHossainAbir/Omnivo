import { PURCHASE_ORDER_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17b: purchase orders. The rules on what may change when (an approved order's lines, the
// status that follows the approval) live in migration 0038, like the requisition's in 0036.
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other
    // order never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first submitted ('purchase.order'). Kept when it goes back to draft, so the
    // number the supplier was told never changes.
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    expectedDate: date('expected_date', { mode: 'string' }),
    supplierId: uuid('supplier_id').notNull(),
    // The supplier's quotation or proforma invoice number
    supplierReference: text('supplier_reference'),
    // Where the goods are to be delivered; its branch is the order's branch
    warehouseId: uuid('warehouse_id').notNull(),
    // The order's own (decision 15): the supplier's terms when it was written, or what was agreed
    paymentTermsDays: smallint('payment_terms_days').notNull().default(0),
    pricesIncludeVat: boolean('prices_include_vat').notNull().default(false),
    status: text('status', { enum: PURCHASE_ORDER_STATUSES }).notNull().default('draft'),
    note: text('note'),
    // contracts' documentTotals when it was saved; total is what the approval levels are chosen by
    ...totalColumns(),
  },
  (table) => [
    uniqueIndex('purchase_orders_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the goods receipt's FK: an order of THIS supplier
    uniqueIndex('purchase_orders_supplier_id_idx').on(table.tenantId, table.supplierId, table.id),
    // Drafts that were never submitted have no number; NULLs never collide
    uniqueIndex('purchase_orders_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('purchase_orders_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One supplier's orders (the list's filter), and the supplier FK's check on delete
    index('purchase_orders_supplier_idx').on(
      table.tenantId,
      table.supplierId,
      table.date,
      table.id,
    ),
    index('purchase_orders_warehouse_idx').on(table.tenantId, table.warehouseId),
    // What approved orders still have to bring, per warehouse: the stock list's "incoming" and the
    // goods receipt form's orders. Partial: received, closed and cancelled orders are not in it.
    index('purchase_orders_open_idx')
      .on(table.tenantId, table.warehouseId)
      .where(sql`${table.status} = 'approved'`),
    // No ON DELETE: a supplier with an order cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'purchase_orders_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'purchase_orders_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Out of draft ⇔ numbered (decision 13). A draft may still have a number: it was submitted
    // once, then rejected or reopened.
    check(
      'purchase_orders_number_check',
      sql`${table.status} = 'draft' OR ${table.number} IS NOT NULL`,
    ),
    check(
      'purchase_orders_expected_date_check',
      sql`${table.expectedDate} IS NULL OR ${table.expectedDate} >= ${table.date}`,
    ),
    // 365 = the contract's MAX_PAYMENT_TERMS_DAYS
    check('purchase_orders_terms_check', sql`${table.paymentTermsDays} BETWEEN 0 AND 365`),
    check(
      'purchase_orders_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

// A line is a sales line (decision 6), plus the requisition line it buys for and what goods
// receipts brought in against it. What bills billed is counted from the bill lines (step 17c),
// never stored here.
export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    ...salesLineColumns(),
    orderId: uuid('order_id').notNull(),
    // NULL = not from a requisition. The FK is in migration 0038: it also says the requisition
    // line is for the same variant, and it needs ON DELETE SET NULL on one column, which Drizzle
    // cannot write.
    requisitionLineId: uuid('requisition_line_id'),
    // In the base unit: what posted goods receipts accepted. Written by the receipt's posting,
    // under a lock on the order (17b.3). May pass base_quantity by the over-receipt percent.
    receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    // In the base unit: what posted goods receipts turned back. Recorded only: it is not stock and
    // does not count as received.
    rejectedQuantity: numeric('rejected_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('purchase_order_lines_line_idx').on(table.tenantId, table.orderId, table.lineNo),
    // The target of the goods receipt line's FK: a line of THIS order, for THIS variant
    uniqueIndex('purchase_order_lines_receipt_target_idx').on(
      table.tenantId,
      table.orderId,
      table.id,
      table.variantId,
    ),
    // Step 17c: the target of the bill line's FK (migration 0040): THIS line, for THIS variant. A
    // bill line names no order, so the key above cannot serve.
    uniqueIndex('purchase_order_lines_bill_target_idx').on(
      table.tenantId,
      table.id,
      table.variantId,
    ),
    index('purchase_order_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // How much of a requisition line was ordered, and the requisition line FK's check on delete
    index('purchase_order_lines_requisition_line_idx')
      .on(table.tenantId, table.requisitionLineId)
      .where(sql`${table.requisitionLineId} IS NOT NULL`),
    foreignKey({
      name: 'purchase_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'purchase_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'purchase_order_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'purchase_order_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'purchase_order_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The sales line's rules again: a discount never takes more than the line, and total is net
    // plus VAT, to the paisa
    check(
      'purchase_order_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'purchase_order_lines_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
    // Never more than double the order: 100% is the highest over-receipt percent (decision 22).
    // The workspace's own percent is the API's check; this is the last word whatever it says.
    check(
      'purchase_order_lines_received_check',
      sql`${table.receivedQuantity} BETWEEN 0 AND 2 * ${table.baseQuantity} AND ${table.rejectedQuantity} >= 0`,
    ),
  ],
);
