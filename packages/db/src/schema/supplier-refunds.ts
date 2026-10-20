import { PAYMENT_METHODS, SUPPLIER_REFUND_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { debitNotes } from './debit-notes.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { supplierPayments } from './supplier-payments.js';
import { tenants } from './tenants.js';

// Step 17d: supplier refunds, money a supplier paid back into a cash, bank or wallet account. The
// customer's refund of 15d the other way round: saving posts it, and a mistake is voided; it never
// changes otherwise. Its amount is added to its source's `refunded` by a trigger (migration 0042).

export const supplierRefunds = pgTable(
  'supplier_refunds',
  {
    // deleted_at is not used: a refund is never deleted, a mistake is voided
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('purchase.refund'): saved means posted
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The money account it came into (the API checks it holds money, like a payment's)
    accountId: uuid('account_id').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference'),
    branchId: uuid('branch_id').notNull(),
    note: text('note'),
    // Where the money it takes back was: exactly one of the two
    debitNoteId: uuid('debit_note_id'),
    paymentId: uuid('payment_id'),
    status: text('status', { enum: SUPPLIER_REFUND_STATUSES }).notNull().default('posted'),
    // Set when voided, like a supplier payment's
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    uniqueIndex('supplier_refunds_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('supplier_refunds_tenant_number_idx').on(table.tenantId, table.number),
    index('supplier_refunds_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('supplier_refunds_supplier_idx').on(
      table.tenantId,
      table.supplierId,
      table.date,
      table.id,
    ),
    // The account FK's check when an account is deleted, like supplier_payments_account_idx
    index('supplier_refunds_account_idx').on(table.tenantId, table.accountId),
    // A debit note's refunds and a payment's (their pages; payment_has_refunds)
    index('supplier_refunds_debit_note_idx')
      .on(table.tenantId, table.debitNoteId)
      .where(sql`${table.debitNoteId} IS NOT NULL`),
    index('supplier_refunds_payment_idx')
      .on(table.tenantId, table.paymentId)
      .where(sql`${table.paymentId} IS NOT NULL`),
    // No ON DELETE: a supplier with a refund cannot be deleted (supplier_in_use)
    foreignKey({
      name: 'supplier_refunds_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // supplier_id is in both keys: a refund takes back only its own supplier's money
    foreignKey({
      name: 'supplier_refunds_debit_note_fk',
      columns: [table.tenantId, table.supplierId, table.debitNoteId],
      foreignColumns: [debitNotes.tenantId, debitNotes.supplierId, debitNotes.id],
    }),
    foreignKey({
      name: 'supplier_refunds_payment_fk',
      columns: [table.tenantId, table.supplierId, table.paymentId],
      foreignColumns: [supplierPayments.tenantId, supplierPayments.supplierId, supplierPayments.id],
    }),
    foreignKey({
      name: 'supplier_refunds_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'supplier_refunds_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    check('supplier_refunds_amount_check', sql`${table.amount} > 0`),
    // Exactly one source: the last word on supplier_refund_source
    check(
      'supplier_refunds_source_check',
      sql`(${table.debitNoteId} IS NULL) <> (${table.paymentId} IS NULL)`,
    ),
    // Voided ⇔ a void date and a reason (200 = the contract's limit), not before its own date,
    // like a supplier payment
    check(
      'supplier_refunds_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL) AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date}) AND (${table.voidReason} IS NULL OR char_length(${table.voidReason}) BETWEEN 1 AND 200)`,
    ),
  ],
);
