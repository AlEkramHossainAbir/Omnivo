import { BILL_STATUSES } from '@omnivo/contracts';
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
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { goodsReceiptLines } from './goods-receipts.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 17c: supplier bills. A draft is changed freely; a pending bill waits for its approval and
// does not change; the last approval posts it, and from then on only what payments paid
// (amount_paid) moves. The rules on what may change when live in migration 0040.
// Step 17d adds what debit notes write here: what they applied (amount_debited), what they took off
// in all (debit_note_total) and per line (debited). Rules in migration 0042.
export const bills = pgTable(
  'bills',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other bill
    // never (a cancelled one keeps its number)
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first submitted ('purchase.bill'), like a purchase order. Kept when it goes
    // back to draft.
    number: text('number'),
    // The day it is booked (decision 19)
    date: date('date', { mode: 'string' }).notNull(),
    // Always set: the API fills an empty one with the date plus the order's or the supplier's terms
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').notNull(),
    // The number on the supplier's own bill: required, and once per supplier (the index below)
    supplierBillNumber: text('supplier_bill_number').notNull(),
    // The supplier's VAT invoice (Mushak 6.3), when it gave one (decision 11)
    mushakNumber: text('mushak_number'),
    mushakDate: date('mushak_date', { mode: 'string' }),
    // Whose purchase it is (decision 20)
    branchId: uuid('branch_id').notNull(),
    // Where its own goods lines come in; NULL when it has none
    warehouseId: uuid('warehouse_id'),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: BILL_STATUSES }).notNull().default('draft'),
    note: text('note'),
    // contracts' documentTotals of the lines and the expenses together; total is what the
    // approval levels are chosen by
    ...totalColumns(),
    // The sum of the allocations of POSTED payments that point here. Kept by migration 0040's
    // triggers, never written by the API. total − amount_paid is still due.
    amountPaid: numeric('amount_paid', { precision: 19, scale: 4 }).notNull().default('0'),
    // Step 17d: the sum of the debit note allocations that point here, kept by their trigger
    // (migration 0042) like amount_paid. total − amount_paid − amount_debited is still due
    // (contracts' billAmountDueOf).
    amountDebited: numeric('amount_debited', { precision: 19, scale: 4 }).notNull().default('0'),
    // Step 17d: the totals of the posted debit notes written for this bill, wherever their money
    // went (the "Debited" pill). Written by a debit note's posting; it only grows.
    debitNoteTotal: numeric('debit_note_total', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('bills_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's FK and of the goods receipt's: a bill of THIS supplier
    uniqueIndex('bills_supplier_id_idx').on(table.tenantId, table.supplierId, table.id),
    // Drafts that were never submitted have no number; NULLs never collide
    uniqueIndex('bills_tenant_number_idx').on(table.tenantId, table.number),
    // Decision 9: one bill per supplier bill number, ignoring case and the spaces around it. A
    // cancelled bill lets its number go, so the right bill can be typed again.
    uniqueIndex('bills_supplier_bill_number_idx')
      .on(table.tenantId, table.supplierId, sql`lower(btrim(${table.supplierBillNumber}))`)
      .where(sql`${table.status} <> 'cancelled'`),
    // The list: newest date first, keyset on (date, id)
    index('bills_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One supplier's bills, and the supplier FK's check on delete
    index('bills_supplier_idx').on(table.tenantId, table.supplierId, table.date, table.id),
    // What is still to be paid, oldest due date first: one supplier's (the payment form's list, in
    // the order it suggests paying them) and everyone's (the overdue list). Partial: a paid bill
    // leaves both, and so does one that debit notes settled (step 17d).
    index('bills_open_supplier_idx')
      .on(table.tenantId, table.supplierId, table.dueDate, table.id)
      .where(
        sql`${table.status} = 'posted' AND ${table.amountPaid} + ${table.amountDebited} < ${table.total}`,
      ),
    index('bills_open_due_idx')
      .on(table.tenantId, table.dueDate, table.id)
      .where(
        sql`${table.status} = 'posted' AND ${table.amountPaid} + ${table.amountDebited} < ${table.total}`,
      ),
    // No ON DELETE: a supplier with a bill cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'bills_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Branches and warehouses are archived, never deleted, so these two need no index
    foreignKey({
      name: 'bills_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: 'bills_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // Out of draft ⇔ numbered (decision 13). A draft may still have a number: it was submitted
    // once, then rejected or reopened.
    check('bills_number_check', sql`${table.status} = 'draft' OR ${table.number} IS NOT NULL`),
    // Posted ⇔ a posting time. A posted bill is never undone, so nothing else has one.
    check(
      'bills_posted_check',
      sql`(${table.status} = 'posted') = (${table.postedAt} IS NOT NULL)`,
    ),
    check('bills_due_date_check', sql`${table.dueDate} >= ${table.date}`),
    // 40 = the contract's limit. A Mushak date needs its number (bill_mushak_number_required).
    check(
      'bills_supplier_number_check',
      sql`char_length(btrim(${table.supplierBillNumber})) BETWEEN 1 AND 40 AND (${table.mushakNumber} IS NULL OR char_length(${table.mushakNumber}) BETWEEN 1 AND 40) AND (${table.mushakDate} IS NULL OR ${table.mushakNumber} IS NOT NULL)`,
    ),
    check(
      'bills_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    // Never settled past its total by payments and debit notes together, and only a posted bill is
    // settled at all: the last word on payment_over_bill and debit_note_over_bill, whatever the API
    // checked first
    check(
      'bills_paid_check',
      sql`${table.amountPaid} >= 0 AND ${table.amountDebited} >= 0 AND ${table.amountPaid} + ${table.amountDebited} <= ${table.total} AND (${table.status} = 'posted' OR (${table.amountPaid} = 0 AND ${table.amountDebited} = 0))`,
    ),
    // Step 17d: debit notes never take off more than the total, and a bill that is not posted has
    // none
    check(
      'bills_debited_check',
      sql`${table.debitNoteTotal} >= 0 AND ${table.debitNoteTotal} <= ${table.total} AND (${table.status} = 'posted' OR ${table.debitNoteTotal} = 0)`,
    ),
  ],
);

// A line is a sales line (decision 15), plus where it came from and the lot of a goods line of its
// own. Exactly one of the contract's three kinds:
//   receipt_line_id set              a goods receipt line (order_line_id is a copy of its order line)
//   only order_line_id set           an order's service line
//   neither                          a line of its own; posting a goods line sets receipt_line_id
//                                    to the line of the goods receipt the posting made
export const billLines = pgTable(
  'bill_lines',
  {
    ...salesLineColumns(),
    billId: uuid('bill_id').notNull(),
    // No ON DELETE: a posted goods receipt's lines are never deleted
    receiptLineId: uuid('receipt_line_id'),
    // The FK is in migration 0040: it needs ON DELETE SET NULL on one column (a reopened order
    // writes its lines again once every bill that billed them was cancelled)
    orderLineId: uuid('order_line_id'),
    // A service line's expense account; NULL on goods lines (decision 16: the API fills an empty
    // one from Settings' "Purchased services")
    accountId: uuid('account_id'),
    // A goods line of its own: the lot as typed, like a goods receipt line. The posting's goods
    // receipt finds or makes the batch.
    lotNumber: text('lot_number'),
    expiresOn: date('expires_on', { mode: 'string' }),
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    serialNumbers: text('serial_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Step 17d: the money posted debit note lines took off this line. Written by the debit note's
    // posting, under a lock on the bill; it only grows (migration 0042).
    debited: numeric('debited', { precision: 19, scale: 4 }).notNull().default('0'),
  },
  (table) => [
    uniqueIndex('bill_lines_line_idx').on(table.tenantId, table.billId, table.lineNo),
    // Step 17d: the target of the return line's and the debit note line's FKs: a line of THIS
    // bill, for THIS item
    uniqueIndex('bill_lines_variant_target_idx').on(
      table.tenantId,
      table.billId,
      table.id,
      table.variantId,
    ),
    index('bill_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // Which bill billed a receipt line (the goods receipt's page), and the FK's check
    index('bill_lines_receipt_line_idx')
      .on(table.tenantId, table.receiptLineId)
      .where(sql`${table.receiptLineId} IS NOT NULL`),
    // What an order line was billed (billedQuantity, counted, never stored), the order's bills,
    // and the FK's check when a reopened order's lines are written again
    index('bill_lines_order_line_idx')
      .on(table.tenantId, table.orderLineId)
      .where(sql`${table.orderLineId} IS NOT NULL`),
    // The account FK's check when an account is deleted (accounts are deleted for real when unused)
    index('bill_lines_account_idx')
      .on(table.tenantId, table.accountId)
      .where(sql`${table.accountId} IS NOT NULL`),
    foreignKey({
      name: 'bill_lines_bill_fk',
      columns: [table.tenantId, table.billId],
      foreignColumns: [bills.tenantId, bills.id],
    }).onDelete('cascade'),
    // variant_id is in the key: the receipt line brought in the item this line bills
    foreignKey({
      name: 'bill_lines_receipt_line_fk',
      columns: [table.tenantId, table.receiptLineId, table.variantId],
      foreignColumns: [
        goodsReceiptLines.tenantId,
        goodsReceiptLines.id,
        goodsReceiptLines.variantId,
      ],
    }),
    foreignKey({
      name: 'bill_lines_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'bill_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'bill_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'bill_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'bill_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'bill_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('bill_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
    // Step 17d: never debited past what it charged: the last word on debit_note_over_line
    check('bill_lines_debited_check', sql`${table.debited} BETWEEN 0 AND ${table.total}`),
    // The contract's bill_account_not_allowed and bill_stock_not_allowed: a receipt line's goods
    // came in on the receipt, with their lot, and its value is in "Goods received not billed"; an
    // order's line (a receipt line copies it) takes no lot from the bill. A goods line of its own
    // keeps the lot it was typed with, also once its posting gave it a receipt line: that receipt
    // was made by the bill and has no order.
    check(
      'bill_lines_source_check',
      sql`(${table.receiptLineId} IS NULL OR ${table.accountId} IS NULL) AND (${table.orderLineId} IS NULL OR (${table.lotNumber} IS NULL AND ${table.expiresOn} IS NULL AND ${table.manufacturedOn} IS NULL AND cardinality(${table.serialNumbers}) = 0))`,
    ),
  ],
);

// The tax columns of a sales line: the rate the expense used, its copy, and the amounts
const { taxRateId, taxRateName, taxRateKind, taxRate, net, vat, total } = salesLineColumns();

// A cost with no product (decision 15): rent, electricity, a repair. Its own list, not a fourth
// kind of line, so every bill line keeps a product.
export const billExpenses = pgTable(
  'bill_expenses',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    billId: uuid('bill_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    description: text('description').notNull(),
    // As typed: with or without VAT, as the bill's prices_include_vat says
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    taxRateId,
    taxRateName,
    taxRateKind,
    taxRate,
    // contracts' expenseLineAmounts when it was saved
    net,
    vat,
    total,
    // Step 17d: the money posted debit notes took off this expense, like a line's
    debited: numeric('debited', { precision: 19, scale: 4 }).notNull().default('0'),
  },
  (table) => [
    uniqueIndex('bill_expenses_line_idx').on(table.tenantId, table.billId, table.lineNo),
    // Step 17d: the target of the debit note expense's FK: an expense of THIS bill
    uniqueIndex('bill_expenses_bill_id_idx').on(table.tenantId, table.billId, table.id),
    index('bill_expenses_account_idx').on(table.tenantId, table.accountId),
    foreignKey({
      name: 'bill_expenses_bill_fk',
      columns: [table.tenantId, table.billId],
      foreignColumns: [bills.tenantId, bills.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'bill_expenses_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'bill_expenses_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    // 2–300 = the contract's limits
    check(
      'bill_expenses_description_check',
      sql`char_length(${table.description}) BETWEEN 2 AND 300`,
    ),
    check(
      'bill_expenses_amounts_check',
      sql`${table.amount} > 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('bill_expenses_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
    check('bill_expenses_debited_check', sql`${table.debited} BETWEEN 0 AND ${table.total}`),
  ],
);
