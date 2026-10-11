import { INVOICE_STATUSES } from '@omnivo/contracts';
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
import { branches } from './branches.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import {
  deliveryLines,
  salesLineColumns,
  salesOrderLines,
  totalColumns,
} from './sales-documents.js';
import { stockLineColumns } from './stock-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 15c: sales invoices. A draft is changed freely; posting numbers it and books the sale, and
// from then on only what receipts paid (amount_paid) moves. The rules on what may change when live
// in migration 0030.

export const invoices = pgTable(
  'invoices',
  {
    // deleted_at is not used: a draft is deleted for real, a posted invoice never (15d's credit
    // note corrects it)
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.invoice'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // Always set: the API fills an empty one with the date plus the customer's payment terms
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    customerReference: text('customer_reference'),
    // Whose sale it is: every line of its journal entry carries this branch
    branchId: uuid('branch_id').notNull(),
    // Where its own goods lines leave from; NULL when every goods line is on a challan
    warehouseId: uuid('warehouse_id'),
    // The customer's billing address text when the invoice was saved: what it prints, even after
    // the customer moves
    billingAddress: text('billing_address'),
    // The orders' copy of the setting when it bills orders, else the workspace setting
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),
    note: text('note'),
    ...totalColumns(),
    // The sum of the receipt allocations that point here. Kept by the allocations' trigger
    // (migration 0030), never written by the API, so it can never disagree with them.
    amountPaid: numeric('amount_paid', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('invoices_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the receipt allocation's FK: an invoice of THIS customer
    uniqueIndex('invoices_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('invoices_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('invoices_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's invoices, and the customer FK's check on delete
    index('invoices_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // What is still to be paid, oldest due date first: one customer's (the receipt form's list, in
    // the order it suggests paying them) and everyone's (the overdue list). Partial: a paid
    // invoice leaves both, so they stay small however many invoices a year brings.
    index('invoices_open_customer_idx')
      .on(table.tenantId, table.customerId, table.dueDate, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.amountPaid} < ${table.total}`),
    index('invoices_open_due_idx')
      .on(table.tenantId, table.dueDate, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.amountPaid} < ${table.total}`),
    // No ON DELETE: a customer with an invoice cannot be deleted (customer_in_use)
    foreignKey({
      name: 'invoices_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Branches and warehouses are archived, never deleted, so these two need no index
    foreignKey({
      name: 'invoices_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: 'invoices_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Posted ⇔ a number and a posting time, like a delivery
    check(
      'invoices_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check('invoices_due_date_check', sql`${table.dueDate} >= ${table.date}`),
    check(
      'invoices_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    // Never paid more than the total, and a draft is never paid: the last word on
    // receipt_over_invoice, whatever the API checked first
    check(
      'invoices_paid_check',
      sql`${table.amountPaid} >= 0 AND ${table.amountPaid} <= ${table.total} AND (${table.status} = 'posted' OR ${table.amountPaid} = 0)`,
    ),
  ],
);

// The batch and serial numbers of a line of its own, the same two columns a challan line has
const { batchId, serialNumbers } = stockLineColumns();

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    ...salesLineColumns(),
    invoiceId: uuid('invoice_id').notNull(),
    // The challan line it bills. A line of its own gets the line of the challan the posting made.
    deliveryLineId: uuid('delivery_line_id'),
    // The order line behind it: the challan line's (copied by the API), or an order's service line
    orderLineId: uuid('order_line_id'),
    // Only on a goods line of its own: what the posting's challan takes out
    batchId,
    serialNumbers,
  },
  (table) => [
    uniqueIndex('invoice_lines_line_idx').on(table.tenantId, table.invoiceId, table.lineNo),
    index('invoice_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // Which invoice billed a challan line (the delivery page), and the FK's check
    index('invoice_lines_delivery_line_idx')
      .on(table.tenantId, table.deliveryLineId)
      .where(sql`${table.deliveryLineId} IS NOT NULL`),
    // An order's invoices (the order page), and the FK's check when a draft order's lines change
    index('invoice_lines_order_line_idx')
      .on(table.tenantId, table.orderLineId)
      .where(sql`${table.orderLineId} IS NOT NULL`),
    foreignKey({
      name: 'invoice_lines_invoice_fk',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.id],
    }).onDelete('cascade'),
    // No ON DELETE on the next two: a line an invoice points at cannot be deleted. A posted
    // challan's lines never are anyway; an order line is, when a draft order is changed, and this
    // keeps an order line that a draft invoice bills from disappearing under it.
    foreignKey({
      name: 'invoice_lines_delivery_line_fk',
      columns: [table.tenantId, table.deliveryLineId],
      foreignColumns: [deliveryLines.tenantId, deliveryLines.id],
    }),
    foreignKey({
      name: 'invoice_lines_order_line_fk',
      columns: [table.tenantId, table.orderLineId],
      foreignColumns: [salesOrderLines.tenantId, salesOrderLines.id],
    }),
    foreignKey({
      name: 'invoice_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'invoice_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'invoice_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    foreignKey({
      name: 'invoice_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'invoice_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'invoice_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('invoice_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
  ],
);
