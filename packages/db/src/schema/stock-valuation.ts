import { STOCK_ACCOUNT_USES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
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
import { ledgerAccounts } from './ledger-accounts.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';

// The accounts stock documents post to besides the inventory account (step 14, contracts'
// STOCK_ACCOUNT_USES): one row per use, set by the template and changed in Settings → Inventory.
// A missing row is "not chosen yet": the posting that needs it is refused until someone picks one.
export const stockAccounts = pgTable(
  'stock_accounts',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    use: text('use', { enum: STOCK_ACCOUNT_USES }).notNull(),
    accountId: uuid('account_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    primaryKey({ name: 'stock_accounts_pkey', columns: [table.tenantId, table.use] }),
    // "Is this account chosen for a stock use?" — the account FK's own check on delete, too
    index('stock_accounts_account_idx').on(table.tenantId, table.accountId),
    // An account that a stock use points at cannot be deleted (AccountsService: account_in_use)
    foreignKey({
      name: 'stock_accounts_account_fk',
      columns: [table.tenantId, table.accountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
  ],
);

// A stock revaluation (step 14): new average costs for some variants, posted when it is saved.
// Its movements (kind 'revaluation', quantity 0) carry the difference into stock_values; its
// journal entry carries it into the books.
export const stockRevaluations = pgTable(
  'stock_revaluations',
  {
    // deleted_at and version are not used: a revaluation is never changed or deleted (0024)
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    note: text('note'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('stock_revaluations_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('stock_revaluations_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('stock_revaluations_tenant_date_idx').on(table.tenantId, table.date, table.id),
  ],
);

export const stockRevaluationLines = pgTable(
  'stock_revaluation_lines',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    revaluationId: uuid('revaluation_id').notNull(),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The stock and its value when it was revalued: the difference is new − old
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    oldUnitCost: numeric('old_unit_cost', { precision: 19, scale: 4 }),
    oldValue: numeric('old_value', { precision: 19, scale: 4 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 19, scale: 4 }).notNull(),
    newValue: numeric('new_value', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    uniqueIndex('stock_revaluation_lines_line_idx').on(
      table.tenantId,
      table.revaluationId,
      table.lineNo,
    ),
    // One line per variant in a revaluation (the contract says it too)
    uniqueIndex('stock_revaluation_lines_variant_idx').on(
      table.tenantId,
      table.revaluationId,
      table.variantId,
    ),
    index('stock_revaluation_lines_product_idx').on(
      table.tenantId,
      table.productId,
      table.variantId,
    ),
    foreignKey({
      name: 'stock_revaluation_lines_revaluation_fk',
      columns: [table.tenantId, table.revaluationId],
      foreignColumns: [stockRevaluations.tenantId, stockRevaluations.id],
    }),
    foreignKey({
      name: 'stock_revaluation_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'stock_revaluation_lines_values_check',
      sql`${table.quantity} > 0 AND ${table.unitCost} >= 0 AND ${table.newValue} >= 0`,
    ),
  ],
);
