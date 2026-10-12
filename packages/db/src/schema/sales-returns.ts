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
import { invoiceLines } from './invoices.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { deliveryLines } from './sales-documents.js';
import { stockLineColumns } from './stock-documents.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 15d: sales returns, goods a customer sent back. Shaped like a delivery: a draft is changed
// freely; posting numbers it, puts the stock back and books its cost back. From then on only what
// credit notes gave back for its lines (credited_quantity) moves. The rules live in migration 0032.

export const salesReturns = pgTable(
  'sales_returns',
  {
    // deleted_at is not used: a draft is deleted for real, a posted return never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.return'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    // Where every line comes back into (a "Damage/Expiry" warehouse, often)
    warehouseId: uuid('warehouse_id').notNull(),
    // Decides nothing in the books: the list and the reports show it
    reason: text('reason', { enum: RETURN_REASONS }).notNull(),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('sales_returns_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('sales_returns_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('sales_returns_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's returns (the list's filter), and the customer FK's check on delete
    index('sales_returns_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // The list's warehouse filter
    index('sales_returns_warehouse_idx').on(table.tenantId, table.warehouseId),
    // No ON DELETE: a customer with a return cannot be deleted (customer_in_use)
    foreignKey({
      name: 'sales_returns_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'sales_returns_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ a number and a posting time, like a delivery
    check(
      'sales_returns_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const salesReturnLines = pgTable(
  'sales_return_lines',
  {
    ...stockLineColumns(),
    returnId: uuid('return_id').notNull(),
    // The challan line the goods left on; NULL for a line on its own (goods that left before the
    // workspace used Omnivo)
    deliveryLineId: uuid('delivery_line_id'),
    // The invoice line that had billed that challan line when the return was posted, and its
    // invoice. Set by the posting and never again: NULL = not billed then (the invoice bills less
    // instead), and always NULL on a draft and on a line on its own. The contract's `billed`.
    invoiceId: uuid('invoice_id'),
    invoiceLineId: uuid('invoice_line_id'),
    // What the goods came back at (step 14's value): the challan line's cost, or the average cost
    // for a line on its own. NULL while a draft.
    value: numeric('value', { precision: 19, scale: 4 }),
    // In the base unit: what posted credit note lines gave back for this line. Written by the
    // credit note's posting; it only grows (migration 0032).
    creditedQuantity: numeric('credited_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('sales_return_lines_line_idx').on(table.tenantId, table.returnId, table.lineNo),
    // The target of the credit note line's FK: a return line that THIS invoice line billed
    uniqueIndex('sales_return_lines_invoice_line_id_idx').on(
      table.tenantId,
      table.invoiceLineId,
      table.id,
    ),
    index('sales_return_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // A challan's returns (its page), the sum already returned before posting, and the FK's check
    index('sales_return_lines_delivery_line_idx')
      .on(table.tenantId, table.deliveryLineId)
      .where(sql`${table.deliveryLineId} IS NOT NULL`),
    foreignKey({
      name: 'sales_return_lines_return_fk',
      columns: [table.tenantId, table.returnId],
      foreignColumns: [salesReturns.tenantId, salesReturns.id],
    }).onDelete('cascade'),
    // No ON DELETE on the next two: a posted challan's lines and a posted invoice's lines are
    // never deleted anyway
    foreignKey({
      name: 'sales_return_lines_delivery_line_fk',
      columns: [table.tenantId, table.deliveryLineId],
      foreignColumns: [deliveryLines.tenantId, deliveryLines.id],
    }),
    // invoice_id is in the key: the invoice line is a line of that invoice
    foreignKey({
      name: 'sales_return_lines_invoice_line_fk',
      columns: [table.tenantId, table.invoiceId, table.invoiceLineId],
      foreignColumns: [invoiceLines.tenantId, invoiceLines.invoiceId, invoiceLines.id],
    }),
    foreignKey({
      name: 'sales_return_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'sales_return_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'sales_return_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'sales_return_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check('sales_return_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
    // Billed only through a challan line, and the invoice and its line come together
    check(
      'sales_return_lines_billed_check',
      sql`(${table.invoiceId} IS NULL) = (${table.invoiceLineId} IS NULL) AND (${table.invoiceLineId} IS NULL OR ${table.deliveryLineId} IS NOT NULL)`,
    ),
    // Never credited past what came back, and only a billed line is credited at all: the last
    // word on credit_note_over_return
    check(
      'sales_return_lines_credited_check',
      sql`${table.creditedQuantity} BETWEEN 0 AND ${table.baseQuantity} AND (${table.invoiceLineId} IS NOT NULL OR ${table.creditedQuantity} = 0)`,
    ),
  ],
);
