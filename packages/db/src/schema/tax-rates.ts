import { TAX_RATE_KINDS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The VAT rates a workspace charges (step 15a): 15%, 10%, 7.5%, 5%, zero-rated, exempt. Made from
// the list in TypeScript when the workspace is set up (and by migration 0026's event for older
// ones). deleted_at is not used: a rate is archived, never deleted, because old documents name it.
export const taxRates = pgTable(
  'tax_rates',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: TAX_RATE_KINDS }).notNull(),
    // A percentage: 15.00, 7.50. NUMERIC(5,2), read and written as a string.
    rate: numeric('rate', { precision: 5, scale: 2 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // "VAT 15%" once per workspace, in any case
    uniqueIndex('tax_rates_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // The target of the composite FK from products (and from 15b's sales lines)
    uniqueIndex('tax_rates_tenant_id_idx').on(table.tenantId, table.id),
    // At most one default per workspace. "At least one" is the API's rule (tax_rate_default_needed):
    // switching the default clears the old one first, in the same transaction.
    uniqueIndex('tax_rates_tenant_default_idx')
      .on(table.tenantId)
      .where(sql`${table.isDefault}`),
    // The contract's rules, here too: below 100, and a charged kind charges something
    check('tax_rates_rate_check', sql`${table.rate} >= 0 AND ${table.rate} < 100`),
    check(
      'tax_rates_kind_rate_check',
      sql`(${table.kind} IN ('standard', 'reduced')) = (${table.rate} > 0)`,
    ),
    // The default is what every product without its own rate uses, so it cannot be hidden
    check('tax_rates_default_active', sql`NOT ${table.isDefault} OR ${table.archivedAt} IS NULL`),
  ],
);
