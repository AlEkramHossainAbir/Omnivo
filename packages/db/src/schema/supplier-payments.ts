import { PAYMENT_METHODS, SUPPLIER_PAYMENT_STATUSES } from '@omnivo/contracts';
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
import { bills } from './bills.js';
import { branches } from './branches.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { purchaseOrders } from './purchase-orders.js';
import { tenants } from './tenants.js';

// Step 17c: supplier payments and the bills their money is applied to. A money receipt the other
// way round, with an approval in the middle: draft → pending → posted, and a posted payment is
// voided, never changed. The rules live in migration 0040.
// Step 17d adds what supplier refunds take back from a payment's advance (refunded; rules in
// migration 0042).

export const supplierPayments = pgTable(
  'supplier_payments',
  {
    // deleted_at is not used: a draft that was never submitted is deleted for real, any other
    // payment never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first submitted ('purchase.payment'), like a bill
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    supplierId: uuid('supplier_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    // The sum of its allocations, kept by their trigger (migration 0040). On a draft it is the plan
    // (decision 23); only a posted payment's allocations count on the bills. amount − applied is
    // the advance.
    applied: numeric('applied', { precision: 19, scale: 4 }).notNull().default('0'),
    // Step 17d: what posted supplier refunds took back out of the advance, kept by their trigger
    // (migration 0042). amount − applied − refunded is the advance that is left
    // (contracts' unappliedPaymentOf).
    refunded: numeric('refunded', { precision: 19, scale: 4 }).notNull().default('0'),
    // The cash or bank account it is paid from (a money account: the API checks that)
    accountId: uuid('account_id').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    // The cheque number or the transfer's reference
    reference: text('reference'),
    // The supplier's bank account it went to (decision 24). The FK is in migration 0040: it needs
    // ON DELETE SET NULL on one column, because a supplier's form may remove the account later.
    supplierBankAccountId: uuid('supplier_bank_account_id'),
    branchId: uuid('branch_id').notNull(),
    // The purchase order an advance was paid against (decision 12)
    orderId: uuid('order_id'),
    note: text('note'),
    status: text('status', { enum: SUPPLIER_PAYMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
    // Set when voided: the day it turned out not to have gone (a bounced cheque), and why
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    uniqueIndex('supplier_payments_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the allocation's FK: a payment to THIS supplier
    uniqueIndex('supplier_payments_supplier_id_idx').on(table.tenantId, table.supplierId, table.id),
    uniqueIndex('supplier_payments_tenant_number_idx').on(table.tenantId, table.number),
    index('supplier_payments_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('supplier_payments_supplier_idx').on(
      table.tenantId,
      table.supplierId,
      table.date,
      table.id,
    ),
    // A supplier's money not applied yet (advances): what the bill and payment pages offer to
    // apply, and the supplier refund form. Partial: once applied or taken back in full, a payment
    // leaves it.
    index('supplier_payments_unapplied_idx')
      .on(table.tenantId, table.supplierId, table.date, table.id)
      .where(
        sql`${table.status} = 'posted' AND ${table.applied} + ${table.refunded} < ${table.amount}`,
      ),
    // An order's advances (its page), and the order FK's check
    index('supplier_payments_order_idx')
      .on(table.tenantId, table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    // The FK checks when an account or a supplier's bank account is deleted
    index('supplier_payments_account_idx').on(table.tenantId, table.accountId),
    index('supplier_payments_bank_account_idx')
      .on(table.tenantId, table.supplierBankAccountId)
      .where(sql`${table.supplierBankAccountId} IS NOT NULL`),
    foreignKey({
      name: 'supplier_payments_supplier_fk',
      columns: [table.tenantId, table.supplierId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'supplier_payments_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'supplier_payments_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // supplier_id is in the key: an advance names an order of the same supplier
    foreignKey({
      name: 'supplier_payments_order_fk',
      columns: [table.tenantId, table.supplierId, table.orderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.supplierId, purchaseOrders.id],
    }),
    check(
      'supplier_payments_number_check',
      sql`${table.status} = 'draft' OR ${table.number} IS NOT NULL`,
    ),
    // Posted ⇔ a posting time; a voided payment was posted once and keeps it
    check(
      'supplier_payments_posted_check',
      sql`(${table.status} IN ('posted', 'voided')) = (${table.postedAt} IS NOT NULL)`,
    ),
    // A payment of ৳0 moves no money, and its money is never used twice over: applied (the plan
    // of a draft included) and taken back together, never more than the amount
    // (payment_over_allocated, supplier_refund_over_source). Only a posted payment's advance is
    // taken back.
    check(
      'supplier_payments_amount_check',
      sql`${table.amount} > 0 AND ${table.applied} >= 0 AND ${table.refunded} >= 0 AND ${table.applied} + ${table.refunded} <= ${table.amount} AND (${table.status} = 'posted' OR ${table.refunded} = 0)`,
    ),
    // Voided ⇔ a void date and a reason (200 = the contract's limit). A voided payment pays
    // nothing: its allocations are removed before it is voided.
    check(
      'supplier_payments_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL) AND (${table.status} <> 'voided' OR ${table.applied} = 0) AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date}) AND (${table.voidReason} IS NULL OR char_length(${table.voidReason}) BETWEEN 1 AND 200)`,
    ),
  ],
);

// The money of one payment put on one bill. The pair is unique; changing how the money is applied
// replaces the payment's rows. A draft's rows are the plan (decision 23).
export const supplierPaymentAllocations = pgTable(
  'supplier_payment_allocations',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: uuid('payment_id').notNull(),
    // The supplier of both: it is in both FKs, so a payment pays only its own supplier's bills
    supplierId: uuid('supplier_id').notNull(),
    billId: uuid('bill_id').notNull(),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('supplier_payment_allocations_pair_idx').on(
      table.tenantId,
      table.paymentId,
      table.billId,
    ),
    // A bill's payments (its page), and the bill FK's check
    index('supplier_payment_allocations_bill_idx').on(table.tenantId, table.billId),
    // A draft deleted for real takes its plan with it
    foreignKey({
      name: 'supplier_payment_allocations_payment_fk',
      columns: [table.tenantId, table.supplierId, table.paymentId],
      foreignColumns: [supplierPayments.tenantId, supplierPayments.supplierId, supplierPayments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'supplier_payment_allocations_bill_fk',
      columns: [table.tenantId, table.supplierId, table.billId],
      foreignColumns: [bills.tenantId, bills.supplierId, bills.id],
    }),
    check('supplier_payment_allocations_amount_check', sql`${table.amount} > 0`),
  ],
);
