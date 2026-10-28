import { DISCOUNT_TYPES, POS_PAPER_WIDTHS, POS_PAYMENT_METHODS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { devices } from './sync.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 20a: the point of sale. A register is a counter; a POS sale is made on a device, already
// paid, and arrives as a sync command (pos_sale.create). The server writes the sale, its lines,
// the batches they left from and its payments in one go, and never changes them afterwards. The
// rules live in migration 0052.

// ---------------------------------------------------------------------------------------------
// Registers

// One counter: the warehouse its goods leave from and an account for each way of paying. Archived,
// never deleted: its sales point at it, and its code is in their numbers. deleted_at (from
// baseColumns) is not used, like warehouses.
export const posRegisters = pgTable(
  'pos_registers',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "POS1": the first part of every receipt number. Never changes (migration 0052).
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Its branch is the warehouse's: no branch_id column that could say something else
    warehouseId: uuid('warehouse_id').notNull(),
    // The account each payment method goes into (a money account: the API checks that). Cash is
    // always there, because the change is given in cash; NULL = the register does not take it.
    cashAccountId: uuid('cash_account_id').notNull(),
    cardAccountId: uuid('card_account_id'),
    bkashAccountId: uuid('bkash_account_id'),
    nagadAccountId: uuid('nagad_account_id'),
    // The most a cashier may take off without pos.price.override: 10.00 = 10%
    maxDiscountPercent: numeric('max_discount_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),
    paperWidth: text('paper_width', { enum: POS_PAPER_WIDTHS }).notNull(),
    receiptFooter: text('receipt_footer'),
    // The device that holds it (decision 14); NULL = free. Set by a claim, cleared by a release,
    // and by the database itself when that device is revoked or moved to another branch (0052).
    deviceId: uuid('device_id'),
    // The highest number the server has received from it, accepted or refused; 0 = none yet. A
    // device that claims the register numbers from here + 1, so no number is given twice. Only
    // grows (0052). Written without touching version: a sale must not make a manager's edit of
    // the register fail on its version.
    lastNumber: integer('last_number').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // An archived register keeps its code: POS1-000123 on an old receipt means one counter
    uniqueIndex('pos_registers_tenant_code_idx').on(table.tenantId, table.code),
    // The target of the composite FK from pos_sales
    uniqueIndex('pos_registers_tenant_id_idx').on(table.tenantId, table.id),
    // A warehouse's registers (0052's trigger when a warehouse moves), and the FK's own check
    index('pos_registers_warehouse_idx').on(table.tenantId, table.warehouseId),
    // A device holds one register at most: the last word on pos_device_has_register
    uniqueIndex('pos_registers_device_idx')
      .on(table.tenantId, table.deviceId)
      .where(sql`${table.deviceId} IS NOT NULL`),
    foreignKey({
      name: 'pos_registers_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Devices are revoked, never deleted, so this never blocks anything
    foreignKey({
      name: 'pos_registers_device_fk',
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    // No index for the four account FKs: a workspace has a few registers, so the check when an
    // account is deleted reads a few rows
    foreignKey({
      name: 'pos_registers_cash_account_fk',
      columns: [table.tenantId, table.cashAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_card_account_fk',
      columns: [table.tenantId, table.cardAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_bkash_account_fk',
      columns: [table.tenantId, table.bkashAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'pos_registers_nagad_account_fk',
      columns: [table.tenantId, table.nagadAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // The contract's format: the code is split from the number at the hyphen
    check('pos_registers_code_check', sql`${table.code} ~ '^[A-Z][A-Z0-9]{1,7}$'`),
    check('pos_registers_discount_check', sql`${table.maxDiscountPercent} BETWEEN 0 AND 100`),
    check('pos_registers_paper_check', sql`${table.paperWidth} IN ('58', '80')`),
    check('pos_registers_last_number_check', sql`${table.lastNumber} >= 0`),
    // An archived register is held by no device: the last word on archiving a held one
    check(
      'pos_registers_archived_check',
      sql`${table.archivedAt} IS NULL OR ${table.deviceId} IS NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Sales

// A sale is posted when it arrives: there is no draft and no status. It never changes and is
// never deleted (0052); a return (step 20c) is a document of its own. version and updated_* (from
// baseColumns) stay as they were written, deleted_at is not used.
// created_by is the cashier: the device's person, who pushed it. created_at is when the server
// received it; sold_at is when it was sold, by the device's clock.
export const posSales = pgTable(
  'pos_sales',
  {
    // The id is made by the device (the command's saleId), so the receipt can point at it
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    registerId: uuid('register_id').notNull(),
    // Its place in the register's series, and the number it makes (formatPosNumber): stored, so
    // the list, the journal and the stock card show it without the register's code
    sequence: integer('sequence').notNull(),
    number: text('number').notNull(),
    // The day it is in the books (the device's day, or the first open day after it)
    date: date('date', { mode: 'string' }).notNull(),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull(),
    // NULL = walk-in
    customerId: uuid('customer_id'),
    // The register's warehouse when it was sold: a register may move to another warehouse later
    warehouseId: uuid('warehouse_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    // The bill's discount as typed (10 = 10% or ৳10), and what it came to in taka
    billDiscountType: text('bill_discount_type', { enum: DISCOUNT_TYPES }).notNull(),
    billDiscount: numeric('bill_discount', { precision: 19, scale: 4 }).notNull(),
    billDiscountAmount: numeric('bill_discount_amount', { precision: 19, scale: 4 }).notNull(),
    // discount = the lines' own discounts in taka; net, vat and total after both discounts
    ...totalColumns(),
    // What the customer handed over, all methods: the sum of the payments. paid − total is the
    // change given back in cash.
    paid: numeric('paid', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    // The target of the composite FKs from the lines and the payments
    uniqueIndex('pos_sales_tenant_id_idx').on(table.tenantId, table.id),
    // A number is never given twice (POS1-000123), whatever the devices did: the last word on
    // pos_number_taken. Also the search by number (a return in step 20c starts from one).
    uniqueIndex('pos_sales_tenant_number_idx').on(table.tenantId, table.number),
    uniqueIndex('pos_sales_register_sequence_idx').on(
      table.tenantId,
      table.registerId,
      table.sequence,
    ),
    // The list: newest date first, keyset on (date, id)
    index('pos_sales_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // The list filtered by register, in the same order
    index('pos_sales_register_idx').on(table.tenantId, table.registerId, table.date, table.id),
    // A customer's sales, and the customer FK's check on delete. Partial: most sales are walk-in.
    index('pos_sales_customer_idx')
      .on(table.tenantId, table.customerId, table.date, table.id)
      .where(sql`${table.customerId} IS NOT NULL`),
    foreignKey({
      name: 'pos_sales_register_fk',
      columns: [table.tenantId, table.registerId],
      foreignColumns: [posRegisters.tenantId, posRegisters.id],
    }),
    // No ON DELETE: a customer with a sale cannot be deleted (customer_in_use)
    foreignKey({
      name: 'pos_sales_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Warehouses and devices are never deleted: no index for these two
    foreignKey({
      name: 'pos_sales_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'pos_sales_device_fk',
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    check('pos_sales_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'pos_sales_bill_discount_check',
      sql`${table.billDiscount} >= 0 AND (${table.billDiscountType} = 'amount' OR ${table.billDiscount} <= 100) AND ${table.billDiscountAmount} >= 0`,
    ),
    // Paid in full at the counter: never less than the total (decision 5)
    check(
      'pos_sales_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat} AND ${table.paid} >= ${table.total}`,
    ),
  ],
);

export const posSaleLines = pgTable(
  'pos_sale_lines',
  {
    ...salesLineColumns(),
    saleId: uuid('sale_id').notNull(),
    // The price the line started with on the device; NULL = there was none and it was typed
    startingPrice: numeric('starting_price', { precision: 19, scale: 4 }),
    // The line's share of the bill's discount; net, vat and total are after it
    billDiscount: numeric('bill_discount', { precision: 19, scale: 4 }).notNull(),
    // A batch product: the batch the device chose. Where the goods really left from is in
    // pos_sale_line_batches: this one, then others when it was short.
    batchId: uuid('batch_id'),
    // A serial product: what the scanner read, one per base unit
    serialNumbers: text('serial_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // What the goods cost (step 14's value of its movements, a positive number), for the gross
    // margin and for a return (step 20c)
    value: numeric('value', { precision: 19, scale: 4 }).notNull(),
    // What the warehouse did not have when the sale was posted, in the base unit: the part that
    // went below zero (decision 7)
    shortQuantity: numeric('short_quantity', { precision: 19, scale: 4 }).notNull().default('0'),
    // The serial numbers that were not in the warehouse: they left without a serial
    shortSerials: text('short_serials')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => [
    uniqueIndex('pos_sale_lines_line_idx').on(table.tenantId, table.saleId, table.lineNo),
    // The target of the line batches' FK: a line of THIS variant
    uniqueIndex('pos_sale_lines_variant_id_idx').on(table.tenantId, table.variantId, table.id),
    // "Does this product have sales?" (product_variant_in_use), and the variant FK's own check
    index('pos_sale_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // The "Sold short" list. Partial: almost every line had its stock.
    index('pos_sale_lines_short_idx')
      .on(table.tenantId, table.saleId)
      .where(sql`${table.shortQuantity} > 0 OR cardinality(${table.shortSerials}) > 0`),
    foreignKey({
      name: 'pos_sale_lines_sale_fk',
      columns: [table.tenantId, table.saleId],
      foreignColumns: [posSales.tenantId, posSales.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    foreignKey({
      name: 'pos_sale_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'pos_sale_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // A sales line's rules (sales_order_lines_amounts_check), with the bill's share
    check(
      'pos_sale_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.billDiscount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'pos_sale_lines_starting_price_check',
      sql`${table.startingPrice} IS NULL OR ${table.startingPrice} >= 0`,
    ),
    check('pos_sale_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
    check('pos_sale_lines_value_check', sql`${table.value} >= 0`),
    // Never short of more than was sold, and a short serial is one the scanner read
    check(
      'pos_sale_lines_short_check',
      sql`${table.shortQuantity} BETWEEN 0 AND ${table.baseQuantity} AND ${table.shortSerials} <@ ${table.serialNumbers}`,
    ),
  ],
);

// The batches a batch product's line left from, in the base unit: the device's batch first, then
// the others first-expiry-first-out when it was short (decision 15). A line has one row per batch
// it touched, and none for a product without batches. The rows add up to the line's base quantity
// (0052).
export const posSaleLineBatches = pgTable(
  'pos_sale_line_batches',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineId: uuid('line_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'pos_sale_line_batches_pkey',
      columns: [table.tenantId, table.lineId, table.batchId],
    }),
    // variant_id is in both keys: the batch is of the line's own variant
    foreignKey({
      name: 'pos_sale_line_batches_line_fk',
      columns: [table.tenantId, table.variantId, table.lineId],
      foreignColumns: [posSaleLines.tenantId, posSaleLines.variantId, posSaleLines.id],
    }),
    foreignKey({
      name: 'pos_sale_line_batches_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check('pos_sale_line_batches_quantity_check', sql`${table.quantity} > 0`),
  ],
);

// How the customer paid: cash and a card, or bKash with the rest in cash
export const posSalePayments = pgTable(
  'pos_sale_payments',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    saleId: uuid('sale_id').notNull(),
    // The order the cashier took them in
    lineNo: smallint('line_no').notNull(),
    method: text('method', { enum: POS_PAYMENT_METHODS }).notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The card's last 4 digits or approval code, the bKash or Nagad TrxID
    reference: text('reference'),
    // The register's account for the method when the sale was posted: a later change of the
    // register does not move old money
    accountId: uuid('account_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'pos_sale_payments_pkey',
      columns: [table.tenantId, table.saleId, table.lineNo],
    }),
    // The account FK's check when an account is deleted: a busy counter has thousands of rows
    index('pos_sale_payments_account_idx').on(table.tenantId, table.accountId),
    foreignKey({
      name: 'pos_sale_payments_sale_fk',
      columns: [table.tenantId, table.saleId],
      foreignColumns: [posSales.tenantId, posSales.id],
    }),
    foreignKey({
      name: 'pos_sale_payments_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    check(
      'pos_sale_payments_method_check',
      sql`${table.method} IN ('cash', 'card', 'bkash', 'nagad')`,
    ),
    check('pos_sale_payments_amount_check', sql`${table.amount} > 0`),
  ],
);
