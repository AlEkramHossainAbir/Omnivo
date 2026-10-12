import { CREDIT_NOTE_REASONS, CREDIT_NOTE_STATUSES } from '@omnivo/contracts';
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
import { invoiceLines, invoices } from './invoices.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { salesLineColumns, totalColumns } from './sales-documents.js';
import { salesReturnLines } from './sales-returns.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// Step 15d: credit notes, and the invoices their money is applied to. A credit note is always for
// one posted invoice. A draft is changed freely; posting numbers it and books the sale back. From
// then on only its allocations (applied) and the refunds paid out of it (refunded) move; it is
// never voided. The rules live in migration 0032.

export const creditNotes = pgTable(
  'credit_notes',
  {
    // deleted_at is not used: a draft is deleted for real, a posted credit note never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.credit_note'), so posted numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    // The invoice's customer: it is in the invoice FK, so the two can never disagree
    customerId: uuid('customer_id').notNull(),
    // The invoice it credits. Its branch and its prices_include_vat are read from it, not copied:
    // a posted invoice never changes.
    invoiceId: uuid('invoice_id').notNull(),
    reason: text('reason', { enum: CREDIT_NOTE_REASONS }).notNull(),
    status: text('status', { enum: CREDIT_NOTE_STATUSES }).notNull().default('draft'),
    note: text('note'),
    ...totalColumns(),
    // The sum of its allocations, kept by their trigger (migration 0032) like receipts.applied
    applied: numeric('applied', { precision: 19, scale: 4 }).notNull().default('0'),
    // What posted refunds paid back out of it, kept by the refunds' trigger (migration 0032).
    // total − applied − refunded is the customer's advance that is left (contracts' unappliedOf).
    refunded: numeric('refunded', { precision: 19, scale: 4 }).notNull().default('0'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('credit_notes_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's and the refund's FKs: a credit note of THIS customer
    uniqueIndex('credit_notes_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    // The target of the line's FK: a credit note of THIS invoice. Also an invoice's credit notes
    // (its page), and the invoice FK's check.
    uniqueIndex('credit_notes_invoice_id_idx').on(table.tenantId, table.invoiceId, table.id),
    uniqueIndex('credit_notes_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('credit_notes_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's credit notes (the list's filter), and the customer FK's check on delete
    index('credit_notes_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // A customer's credit that is not used yet (advances), like receipts_unapplied_idx
    index('credit_notes_unapplied_idx')
      .on(table.tenantId, table.customerId, table.date, table.id)
      .where(
        sql`${table.status} = 'posted' AND ${table.applied} + ${table.refunded} < ${table.total}`,
      ),
    // No ON DELETE: a customer with a credit note cannot be deleted (customer_in_use)
    foreignKey({
      name: 'credit_notes_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // customer_id is in both keys: a credit note's invoice is an invoice of the same customer
    foreignKey({
      name: 'credit_notes_invoice_fk',
      columns: [table.tenantId, table.customerId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.customerId, invoices.id],
    }),
    // Posted ⇔ a number and a posting time, like an invoice
    check(
      'credit_notes_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check(
      'credit_notes_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    // Its money is never used twice over (applied and paid back together, never more than the
    // total), and a draft has no money to use: the last word on credit_note_over_allocated,
    // credit_note_not_posted and refund_over_source
    check(
      'credit_notes_money_check',
      sql`${table.applied} >= 0 AND ${table.refunded} >= 0 AND ${table.applied} + ${table.refunded} <= ${table.total} AND (${table.status} = 'posted' OR (${table.applied} = 0 AND ${table.refunded} = 0))`,
    ),
  ],
);

export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    // The item, the unit and the VAT snapshot are the invoice line's, copied by the API
    ...salesLineColumns(),
    creditNoteId: uuid('credit_note_id').notNull(),
    // The credit note's invoice, again: it is in both FKs below
    invoiceId: uuid('invoice_id').notNull(),
    // The invoice line it credits
    invoiceLineId: uuid('invoice_line_id').notNull(),
    // The return line it gives the money back for; NULL for a price cut or a billing mistake
    returnLineId: uuid('return_line_id'),
  },
  (table) => [
    uniqueIndex('credit_note_lines_line_idx').on(table.tenantId, table.creditNoteId, table.lineNo),
    index('credit_note_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // The invoice line FK's check when a draft invoice's lines are replaced
    index('credit_note_lines_invoice_line_idx').on(
      table.tenantId,
      table.invoiceId,
      table.invoiceLineId,
    ),
    // A return's credit notes (its page), and the return line FK's check
    index('credit_note_lines_return_line_idx')
      .on(table.tenantId, table.returnLineId)
      .where(sql`${table.returnLineId} IS NOT NULL`),
    // invoice_id is in the key of all three: the line belongs to a credit note of that invoice,
    // credits a line of that invoice, and names a return line that line billed
    foreignKey({
      name: 'credit_note_lines_credit_note_fk',
      columns: [table.tenantId, table.invoiceId, table.creditNoteId],
      foreignColumns: [creditNotes.tenantId, creditNotes.invoiceId, creditNotes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'credit_note_lines_invoice_line_fk',
      columns: [table.tenantId, table.invoiceId, table.invoiceLineId],
      foreignColumns: [invoiceLines.tenantId, invoiceLines.invoiceId, invoiceLines.id],
    }),
    foreignKey({
      name: 'credit_note_lines_return_line_fk',
      columns: [table.tenantId, table.invoiceLineId, table.returnLineId],
      foreignColumns: [
        salesReturnLines.tenantId,
        salesReturnLines.invoiceLineId,
        salesReturnLines.id,
      ],
    }),
    foreignKey({
      name: 'credit_note_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'credit_note_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'credit_note_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'credit_note_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check(
      'credit_note_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'credit_note_lines_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
  ],
);

// The money of one credit note put on one invoice, like a receipt's allocation (receipts.ts).
// Posting puts it on its own invoice first; changing how it is applied replaces its rows.
export const creditNoteAllocations = pgTable(
  'credit_note_allocations',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    creditNoteId: uuid('credit_note_id').notNull(),
    // The customer of both: it is in both FKs, so a credit note settles only its own customer's
    // invoices
    customerId: uuid('customer_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('credit_note_allocations_pair_idx').on(
      table.tenantId,
      table.creditNoteId,
      table.invoiceId,
    ),
    // An invoice's credits (its page), and the invoice FK's check
    index('credit_note_allocations_invoice_idx').on(table.tenantId, table.invoiceId),
    foreignKey({
      name: 'credit_note_allocations_credit_note_fk',
      columns: [table.tenantId, table.customerId, table.creditNoteId],
      foreignColumns: [creditNotes.tenantId, creditNotes.customerId, creditNotes.id],
    }),
    foreignKey({
      name: 'credit_note_allocations_invoice_fk',
      columns: [table.tenantId, table.customerId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.customerId, invoices.id],
    }),
    check('credit_note_allocations_amount_check', sql`${table.amount} > 0`),
  ],
);
