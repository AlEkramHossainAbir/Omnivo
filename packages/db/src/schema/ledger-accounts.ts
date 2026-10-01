import { ACCOUNT_PURPOSES, ACCOUNT_TYPES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The chart of accounts: a tree of groups and posting accounts. Named ledger_accounts, not
// accounts — that name belongs to Better Auth's sign-in accounts (accounts.ts). The contracts and
// the UI call it simply "account".
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    // deleted_at (from baseColumns) is not used: an account is either deleted for real (only when
    // nothing uses it) or archived
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = one of the five top-level groups
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    // Copied from the parent when the account is made, and kept equal to it by the parent FK below
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    // A group only holds other accounts; journal lines (step 10) post to the others. Fixed at creation.
    isGroup: boolean('is_group').notNull().default(false),
    // What the system uses this account for (contracts: ACCOUNT_PURPOSES). NULL for most accounts.
    purpose: text('purpose', { enum: ACCOUNT_PURPOSES }),
    description: text('description'),
    // Like branches: hidden from new entries, never removed from old reports
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // The code is how people find an account. An archived account keeps its code, so an old
    // report's "1140" never means two different accounts.
    uniqueIndex('ledger_accounts_tenant_code_idx').on(table.tenantId, table.code),
    // The target of step 10's composite FK: a journal line → an account of the same tenant
    uniqueIndex('ledger_accounts_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the parent FK below
    uniqueIndex('ledger_accounts_tenant_id_type_idx').on(table.tenantId, table.id, table.type),
    // A group's children. Also what Postgres uses to check the parent FK when a group is deleted.
    index('ledger_accounts_tenant_parent_idx').on(table.tenantId, table.parentId),
    // Exactly one top-level group per type
    uniqueIndex('ledger_accounts_tenant_root_idx')
      .on(table.tenantId, table.type)
      .where(sql`${table.parentId} IS NULL`),
    // At most one account per purpose: "the receivable account" is always one row
    uniqueIndex('ledger_accounts_tenant_purpose_idx')
      .on(table.tenantId, table.purpose)
      .where(sql`${table.purpose} IS NOT NULL`),
    // The parent is in the same tenant AND has the same type. Type is part of the key, so the
    // database itself refuses an expense under an asset group — whatever the code does. A NULL
    // parent_id (a top-level group) skips the check (MATCH SIMPLE).
    foreignKey({
      name: 'ledger_accounts_parent_fk',
      columns: [table.tenantId, table.parentId, table.type],
      foreignColumns: [table.tenantId, table.id, table.type],
    }),
    check('ledger_accounts_parent_not_self', sql`${table.parentId} <> ${table.id}`),
    check('ledger_accounts_top_is_group', sql`${table.parentId} IS NOT NULL OR ${table.isGroup}`),
    check(
      'ledger_accounts_purpose_not_group',
      sql`${table.purpose} IS NULL OR NOT ${table.isGroup}`,
    ),
  ],
);
