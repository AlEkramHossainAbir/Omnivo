import { DEBIT_NOTE_REASONS, DEBIT_NOTE_STATUSES } from '@omnivo/contracts';
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
import { billExpenses, billLines, bills } from './bills.js';
import { branches } from './branches.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { purchaseReturnLines } from './purchase-returns.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// Step 17d: debit notes, and the bills their money is applied to. The credit note of 15d from the
// buyer's side. Usually for one posted bill; without one only for goods from before Omnivo
// (decision 9). A draft is changed freely; posting numbers it and takes the money off. From then on
// only its allocations (applied) and the supplier refunds paid out of it (refunded) move; it is
// never voided. The rules live in migration 0042.

export const debitNotes = pgTable(
  'debit_notes',
  {
    // deleted_at is not used: a draft is deleted for real, a posted debit note never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('purchase.debit_note'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // The bill's supplier: it is in the bill FK, so the two can never disagree
    supplierId: uuid('supplier_id').notNull(),
    // The bill it debits; NULL for a debit note without a bill (decision 9)
    billId: uuid('bill_id'),
    // The bill's own two (migration 0042 checks they match), or the ones chosen without a bill.
    // Stored, not read from the bill as a credit note reads its invoice's: a debit note without a
    // bill has nowhere else to keep them.
    branchId: uuid('branch_id').notNull(),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    reason: text('reason', { enum: DEBIT_NOTE_REASONS }).notNull(),
    status: text('status', { enum: DEBIT_NOTE_STATUSES }).notNull().default('draft'),
    // The supplier's own credit note (Mushak 6.7), when it gave one (decision 8)
    supplierCreditNumber: text('supplier_credit_number'),
    supplierCreditDate: date('supplier_credit_date', { mode: 'string' }),
    note: text('note'),
    ...totalColumns(),
    // The sum of its allocations, kept by their trigger (migration 0042) like a payment's applied
    applied: numeric('applied', { precision: 19, scale: 4 }).notNull().default('0'),
    // What posted supplier refunds took back out of it, kept by their trigger (migration 0042).
    // total − applied − refunded is what the supplier still owes (contracts' unappliedOf).
    refunded: numeric('refunded', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('debit_notes_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's and the refund's FKs: a debit note of THIS supplier
    uniqueIndex('debit_notes_supplier_id_idx').on(table.tenantId, table.supplierId, table.id),
    // The target of the line's and the expense's FKs: a debit note of THIS bill. Also a bill's
    // debit notes (its page), and the bill FK's check.
    uniqueIndex('debit_notes_bill_id_idx').on(table.tenantId, table.billId, table.id),
    uniqueIndex('debit_notes_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('debit_notes_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One supplier's debit notes (the list's filter), and the supplier FK's check on delete
    index('debit_notes_supplier_idx').on(table.tenantId, table.supplierId, table.date, table.id),
    // What a supplier owes the company and is not used yet, like supplier_payments_unapplied_idx:
    // the bill page's open debit notes and the refund form
    index('debit_notes_unapplied_idx')
      .on(table.tenantId, table.supplierId, table.date, table.id)
      .where(
        sql`${table.status} = 'posted' AND ${table.applied} + ${table.refunded} < ${table.total}`,
      ),
    // No ON DELETE: a supplier with a debit note cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'debit_notes_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // supplier_id is in both keys: a debit note's bill is a bill of the same supplier
    foreignKey({
      name: 'debit_notes_bill_fk',
      columns: [table.tenantId, table.supplierId, table.billId],
      foreignColumns: [bills.tenantId, bills.supplierId, bills.id],
    }),
    foreignKey({
      name: 'debit_notes_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // Posted ⇔ a number and a posting time, like a credit note
    check(
      'debit_notes_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check(
      'debit_notes_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    // 40 = the contract's limit. A Mushak 6.7 date needs its number
    // (debit_note_supplier_credit_required), like a bill's 6.3.
    check(
      'debit_notes_supplier_credit_check',
      sql`(${table.supplierCreditNumber} IS NULL OR char_length(${table.supplierCreditNumber}) BETWEEN 1 AND 40) AND (${table.supplierCreditDate} IS NULL OR ${table.supplierCreditNumber} IS NOT NULL)`,
    ),
    // Its money is never used twice over (applied and taken back together, never more than the
    // total), and a draft has no money to use: the last word on debit_note_over_allocated,
    // debit_note_not_posted and supplier_refund_over_source
    check(
      'debit_notes_money_check',
      sql`${table.applied} >= 0 AND ${table.refunded} >= 0 AND ${table.applied} + ${table.refunded} <= ${table.total} AND (${table.status} = 'posted' OR (${table.applied} = 0 AND ${table.refunded} = 0))`,
    ),
  ],
);

// A line. With a bill: the bill line it debits (the item, the unit's product and the VAT snapshot
// are that line's, copied by the API), and maybe the return line it takes the money off for.
// Without a bill: the return line, always, and the VAT rate typed from the supplier's credit note.
export const debitNoteLines = pgTable(
  'debit_note_lines',
  {
    ...salesLineColumns(),
    debitNoteId: uuid('debit_note_id').notNull(),
    // The debit note's bill, again (it is in the FKs below), and its line; both NULL without a bill
    billId: uuid('bill_id'),
    billLineId: uuid('bill_line_id'),
    // The return line it takes the money off for; NULL for a price cut or a billing mistake
    returnLineId: uuid('return_line_id'),
  },
  (table) => [
    uniqueIndex('debit_note_lines_line_idx').on(table.tenantId, table.debitNoteId, table.lineNo),
    index('debit_note_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // A bill line's debit notes, and the bill line FK's check
    index('debit_note_lines_bill_line_idx')
      .on(table.tenantId, table.billId, table.billLineId)
      .where(sql`${table.billLineId} IS NOT NULL`),
    // A return's debit notes (its page), and the return line FKs' check
    index('debit_note_lines_return_line_idx')
      .on(table.tenantId, table.returnLineId)
      .where(sql`${table.returnLineId} IS NOT NULL`),
    // The debit note alone: the key below holds bill_id, and a key with a NULL in it is not
    // checked at all (MATCH SIMPLE), so a line of a debit note without a bill needs this one
    foreignKey({
      name: 'debit_note_lines_debit_note_id_fk',
      columns: [table.tenantId, table.debitNoteId],
      foreignColumns: [debitNotes.tenantId, debitNotes.id],
    }).onDelete('cascade'),
    // bill_id is in the next two keys: the line belongs to a debit note of that bill, and debits a
    // line of that bill, for the item that line billed
    foreignKey({
      name: 'debit_note_lines_debit_note_fk',
      columns: [table.tenantId, table.billId, table.debitNoteId],
      foreignColumns: [debitNotes.tenantId, debitNotes.billId, debitNotes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'debit_note_lines_bill_line_fk',
      columns: [table.tenantId, table.billId, table.billLineId, table.variantId],
      foreignColumns: [billLines.tenantId, billLines.billId, billLines.id, billLines.variantId],
    }),
    // The return line went back for the item of this line; with a bill, it is one that THIS bill
    // line billed
    foreignKey({
      name: 'debit_note_lines_return_line_fk',
      columns: [table.tenantId, table.returnLineId, table.variantId],
      foreignColumns: [
        purchaseReturnLines.tenantId,
        purchaseReturnLines.id,
        purchaseReturnLines.variantId,
      ],
    }),
    foreignKey({
      name: 'debit_note_lines_return_bill_line_fk',
      columns: [table.tenantId, table.billLineId, table.returnLineId],
      foreignColumns: [
        purchaseReturnLines.tenantId,
        purchaseReturnLines.billLineId,
        purchaseReturnLines.id,
      ],
    }),
    foreignKey({
      name: 'debit_note_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'debit_note_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'debit_note_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'debit_note_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'debit_note_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('debit_note_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
    // The contract's debit_note_line_invalid and debit_note_return_required: a bill line with its
    // bill, or else a return line
    check(
      'debit_note_lines_source_check',
      sql`(${table.billId} IS NULL) = (${table.billLineId} IS NULL) AND (${table.billLineId} IS NOT NULL OR ${table.returnLineId} IS NOT NULL)`,
    ),
  ],
);

// The tax columns of a sales line: the bill expense's rate, copied, and the amounts
const { taxRateId, taxRateName, taxRateKind, taxRate, net, vat, total } = salesLineColumns();

// An expense of the bill, debited by money. Only a debit note with a bill has them, so bill_id is
// required here.
export const debitNoteExpenses = pgTable(
  'debit_note_expenses',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    debitNoteId: uuid('debit_note_id').notNull(),
    billId: uuid('bill_id').notNull(),
    billExpenseId: uuid('bill_expense_id').notNull(),
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
  },
  (table) => [
    // An expense once per debit note (debit_note_expense_twice)
    uniqueIndex('debit_note_expenses_expense_idx').on(
      table.tenantId,
      table.debitNoteId,
      table.billExpenseId,
    ),
    // A bill expense's debit notes, and the FK's check
    index('debit_note_expenses_bill_expense_idx').on(
      table.tenantId,
      table.billId,
      table.billExpenseId,
    ),
    foreignKey({
      name: 'debit_note_expenses_debit_note_fk',
      columns: [table.tenantId, table.billId, table.debitNoteId],
      foreignColumns: [debitNotes.tenantId, debitNotes.billId, debitNotes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'debit_note_expenses_bill_expense_fk',
      columns: [table.tenantId, table.billId, table.billExpenseId],
      foreignColumns: [billExpenses.tenantId, billExpenses.billId, billExpenses.id],
    }),
    foreignKey({
      name: 'debit_note_expenses_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'debit_note_expenses_amounts_check',
      sql`${table.amount} > 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'debit_note_expenses_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
  ],
);

// The money of one debit note put on one bill, like a supplier payment's allocation. Posting puts
// it on its own bill first; changing how it is applied replaces its rows.
export const debitNoteAllocations = pgTable(
  'debit_note_allocations',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    debitNoteId: uuid('debit_note_id').notNull(),
    // The supplier of both: it is in both FKs, so a debit note settles only its own supplier's
    // bills
    supplierId: uuid('supplier_id').notNull(),
    billId: uuid('bill_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('debit_note_allocations_pair_idx').on(
      table.tenantId,
      table.debitNoteId,
      table.billId,
    ),
    // A bill's debit notes applied to it (its page), and the bill FK's check
    index('debit_note_allocations_bill_idx').on(table.tenantId, table.billId),
    foreignKey({
      name: 'debit_note_allocations_debit_note_fk',
      columns: [table.tenantId, table.supplierId, table.debitNoteId],
      foreignColumns: [debitNotes.tenantId, debitNotes.supplierId, debitNotes.id],
    }),
    foreignKey({
      name: 'debit_note_allocations_bill_fk',
      columns: [table.tenantId, table.supplierId, table.billId],
      foreignColumns: [bills.tenantId, bills.supplierId, bills.id],
    }),
    check('debit_note_allocations_amount_check', sql`${table.amount} > 0`),
  ],
);
