import { JOURNAL_SOURCES, JOURNAL_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
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
import { ledgerAccounts } from './ledger-accounts.js';
import { parties } from './parties.js';
import { tenants } from './tenants.js';

// One journal entry: the header. Its debits and credits are the rows of journal_lines. Three
// rules live in the database itself (migration 0016), not only in the API:
// - a posted entry balances (sum of debits = sum of credits) and has at least two lines;
// - a posted entry and its lines never change and are never deleted;
// - lines of a posted entry post to ledgers only, never to a group.
export const journalEntries = pgTable(
  'journal_entries',
  {
    // deleted_at (from baseColumns) is not used: a draft is deleted for real, a posted entry never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when the entry is posted (NumberingService), so posted numbers have no gaps
    number: text('number'),
    // mode 'string': a business date is "2026-09-23", not a Date at midnight in some time zone
    date: date('date', { mode: 'string' }).notNull(),
    narration: text('narration'),
    status: text('status', { enum: JOURNAL_STATUSES }).notNull().default('draft'),
    source: text('source', { enum: JOURNAL_SOURCES }).notNull().default('manual'),
    // Set on a reversal: the entry it undoes
    reversalOfId: uuid('reversal_of_id'),
    // The stock document that made this entry (step 14): which one follows from the source (an
    // adjustment, a transfer, a revaluation); its number never changes once posted, so the
    // journal shows it without a join
    documentId: uuid('document_id'),
    documentNumber: text('document_number'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    // The target of the composite FKs below (lines → entry, reversal → original)
    uniqueIndex('journal_entries_tenant_id_idx').on(table.tenantId, table.id),
    // Drafts have no number; NULLs never collide in a unique index
    uniqueIndex('journal_entries_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('journal_entries_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // An entry is reversed at most once. Two people pressing Reverse at the same time: the
    // second insert fails here, whatever the code checked before.
    uniqueIndex('journal_entries_tenant_reversal_idx')
      .on(table.tenantId, table.reversalOfId)
      .where(sql`${table.reversalOfId} IS NOT NULL`),
    foreignKey({
      name: 'journal_entries_reversal_fk',
      columns: [table.tenantId, table.reversalOfId],
      foreignColumns: [table.tenantId, table.id],
    }),
    // Posted ⇔ it has a number and a posting time. A draft with a number, or a posted entry
    // without one, cannot exist.
    check(
      'journal_entries_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
    check(
      'journal_entries_reversal_check',
      sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
    ),
    // A stock document's entry (a delivery's too, step 15b) always points at its document, and no
    // other entry does. The list is contracts' STOCK_JOURNAL_SOURCES.
    check(
      'journal_entries_document_check',
      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
    ),
    // A stock document's entries (a transfer has up to two)
    index('journal_entries_document_idx')
      .on(table.tenantId, table.documentId)
      .where(sql`${table.documentId} IS NOT NULL`),
  ],
);

// The debits and credits. No created_at/updated_by of their own: a line is part of its entry,
// written with it (the entry's columns say who and when), and never changed after posting.
export const journalLines = pgTable(
  'journal_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id').notNull(),
    // The order the person wrote the lines in
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    // Optional: which branch the amount belongs to (branch-wise P&L later)
    branchId: uuid('branch_id'),
    // Step 15a: whose line this is. Set on every line of the receivable account and on no other
    // line (migration 0026 checks it when the entry is posted), so the customers' balances add up
    // to the account's balance. Lines posted before step 15a have none.
    partyId: uuid('party_id'),
    description: text('description'),
    // NUMERIC(19,4), read and written as strings: never a JavaScript number
    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
  },
  (table) => [
    uniqueIndex('journal_lines_entry_line_idx').on(table.tenantId, table.entryId, table.lineNo),
    // An account's ledger, and Postgres's own check of the account FK when an account is deleted
    index('journal_lines_tenant_account_idx').on(table.tenantId, table.accountId),
    // Deleting a draft deletes its lines. A posted entry is never deleted (the trigger in 0016).
    foreignKey({
      name: 'journal_lines_entry_fk',
      columns: [table.tenantId, table.entryId],
      foreignColumns: [journalEntries.tenantId, journalEntries.id],
    }).onDelete('cascade'),
    // The step 9 index (tenant_id, id) is the target. An account with lines cannot be deleted:
    // the API turns this FK's error into account_in_use.
    foreignKey({
      name: 'journal_lines_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // NULL branch_id skips the check (MATCH SIMPLE)
    foreignKey({
      name: 'journal_lines_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    // A customer's balance and statement. Partial: most lines (cash, sales, expenses) have no
    // party and are left out. Also the FK's check when a customer is deleted.
    index('journal_lines_tenant_party_idx')
      .on(table.tenantId, table.partyId)
      .where(sql`${table.partyId} IS NOT NULL`),
    // A customer with lines cannot be deleted: the API turns this FK's error into customer_in_use
    foreignKey({
      name: 'journal_lines_party_fk',
      columns: [table.tenantId, table.partyId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // Exactly one side has an amount, and neither is negative
    check(
      'journal_lines_one_side',
      sql`${table.debit} >= 0 AND ${table.credit} >= 0 AND (${table.debit} = 0) <> (${table.credit} = 0)`,
    ),
  ],
);

// The lock date: the books are closed up to and including this day. One row per workspace, made
// the first time someone needs it (like number_series), so no backfill for old workspaces.
export const periodLocks = pgTable('period_locks', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  // NULL = nothing is closed
  lockDate: date('lock_date', { mode: 'string' }),
  createdAt: baseColumns().createdAt,
  updatedAt: baseColumns().updatedAt,
  updatedBy: baseColumns().updatedBy,
  version: baseColumns().version,
});
