import { PAYMENT_METHODS, RECEIPT_STATUSES } from '@omnivo/contracts';
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
import { invoices } from './invoices.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { tenants } from './tenants.js';

// Step 15c: money receipts and the invoices their money is applied to. A receipt is posted when it
// is saved; afterwards only its allocations change, until it is voided. The rules live in
// migration 0030.

export const receipts = pgTable(
  'receipts',
  {
    // deleted_at is not used: a receipt is never deleted, a mistake is voided
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('sales.receipt'): saved means posted
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The sum of its allocations, kept by their trigger (migration 0030) like invoices.amount_paid.
    // amount − applied is the customer's money not applied to an invoice yet.
    applied: numeric('applied', { precision: 19, scale: 4 }).notNull().default('0'),
    // The cash, bank or wallet account it went into (a money account: the API checks that)
    accountId: uuid('account_id').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    reference: text('reference'),
    branchId: uuid('branch_id').notNull(),
    note: text('note'),
    status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('posted'),
    // Set when voided: the day the money turned out not to be there, and why
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    uniqueIndex('receipts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's FK: a receipt of THIS customer
    uniqueIndex('receipts_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('receipts_tenant_number_idx').on(table.tenantId, table.number),
    index('receipts_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('receipts_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // A customer's money that is not applied yet (advances): what the invoice and receipt pages
    // offer to apply. Partial: once applied in full, a receipt leaves it.
    index('receipts_unapplied_idx')
      .on(table.tenantId, table.customerId, table.date, table.id)
      .where(sql`${table.status} = 'posted' AND ${table.applied} < ${table.amount}`),
    // The account FK's check when an account is deleted (accounts are deleted for real when unused)
    index('receipts_account_idx').on(table.tenantId, table.accountId),
    foreignKey({
      name: 'receipts_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'receipts_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'receipts_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // A receipt of ৳0 moved no money, and its money is never applied twice over
    check(
      'receipts_amount_check',
      sql`${table.amount} > 0 AND ${table.applied} >= 0 AND ${table.applied} <= ${table.amount}`,
    ),
    // Voided ⇔ a void date and a reason. A voided receipt paid nothing: its allocations are
    // removed before it is voided.
    check(
      'receipts_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL) AND (${table.status} = 'posted' OR ${table.applied} = 0) AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date})`,
    ),
  ],
);

// The money of one receipt put on one invoice. The pair is unique; changing how the money is
// applied replaces the receipt's rows.
export const receiptAllocations = pgTable(
  'receipt_allocations',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    receiptId: uuid('receipt_id').notNull(),
    // The customer of both: it is in both FKs, so a receipt pays only its own customer's invoices
    customerId: uuid('customer_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('receipt_allocations_pair_idx').on(
      table.tenantId,
      table.receiptId,
      table.invoiceId,
    ),
    // An invoice's payments (its page), and the invoice FK's check
    index('receipt_allocations_invoice_idx').on(table.tenantId, table.invoiceId),
    foreignKey({
      name: 'receipt_allocations_receipt_fk',
      columns: [table.tenantId, table.customerId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.customerId, receipts.id],
    }),
    foreignKey({
      name: 'receipt_allocations_invoice_fk',
      columns: [table.tenantId, table.customerId, table.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.customerId, invoices.id],
    }),
    check('receipt_allocations_amount_check', sql`${table.amount} > 0`),
  ],
);
