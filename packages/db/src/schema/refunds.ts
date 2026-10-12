import { PAYMENT_METHODS, REFUND_STATUSES } from '@omnivo/contracts';
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
import { creditNotes } from './credit-notes.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { receipts } from './receipts.js';
import { tenants } from './tenants.js';

// Step 15d: refunds, money paid back to a customer out of a cash, bank or wallet account. Like a
// money receipt, saving posts it, and a mistake is voided; it never changes otherwise. Its amount
// is added to its source's `refunded` by a trigger (migration 0032).

export const refunds = pgTable(
  'refunds',
  {
    // deleted_at is not used: a refund is never deleted, a mistake is voided
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('sales.refund'): saved means posted
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The money account it was paid out of (the API checks it holds money, like a receipt's)
    accountId: uuid('account_id').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference'),
    branchId: uuid('branch_id').notNull(),
    note: text('note'),
    // Where the money it pays back came from: exactly one of the two
    receiptId: uuid('receipt_id'),
    creditNoteId: uuid('credit_note_id'),
    status: text('status', { enum: REFUND_STATUSES }).notNull().default('posted'),
    // Set when voided, like a receipt's
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    uniqueIndex('refunds_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('refunds_tenant_number_idx').on(table.tenantId, table.number),
    index('refunds_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('refunds_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // The account FK's check when an account is deleted, like receipts_account_idx
    index('refunds_account_idx').on(table.tenantId, table.accountId),
    // A receipt's refunds and a credit note's (their pages; receipt_has_refunds)
    index('refunds_receipt_idx')
      .on(table.tenantId, table.receiptId)
      .where(sql`${table.receiptId} IS NOT NULL`),
    index('refunds_credit_note_idx')
      .on(table.tenantId, table.creditNoteId)
      .where(sql`${table.creditNoteId} IS NOT NULL`),
    // No ON DELETE: a customer with a refund cannot be deleted (customer_in_use)
    foreignKey({
      name: 'refunds_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // customer_id is in both keys: a refund pays back only its own customer's money
    foreignKey({
      name: 'refunds_receipt_fk',
      columns: [table.tenantId, table.customerId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.customerId, receipts.id],
    }),
    foreignKey({
      name: 'refunds_credit_note_fk',
      columns: [table.tenantId, table.customerId, table.creditNoteId],
      foreignColumns: [creditNotes.tenantId, creditNotes.customerId, creditNotes.id],
    }),
    foreignKey({
      name: 'refunds_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'refunds_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    check('refunds_amount_check', sql`${table.amount} > 0`),
    // Exactly one source: the last word on refund_source
    check(
      'refunds_source_check',
      sql`(${table.receiptId} IS NULL) <> (${table.creditNoteId} IS NULL)`,
    ),
    // Voided ⇔ a void date and a reason, not before its own date, like a receipt
    check(
      'refunds_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL) AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date})`,
    ),
  ],
);
