import { UNIT_DIMENSIONS } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// The units of measure a workspace uses: pcs, kg, yard, box. Seeded from the industry template
// (step 12), then the workspace's own data. deleted_at is not used: a unit is deleted for real
// (only when no product uses it) or archived.
export const units = pgTable(
  'units',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    dimension: text('dimension', { enum: UNIT_DIMENSIONS }).notNull(),
    // How many of the dimension's reference unit one of this is (a yard = 0.9144 m). NULL = a pack
    // whose size each product says (box, carton, strip). NUMERIC(19,6), read and written as strings.
    ratio: numeric('ratio', { precision: 19, scale: 6 }),
    // Decimals a quantity in this unit may have (pcs 0, kg 3)
    decimals: smallint('decimals').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // "KG" and "kg" are one unit: people type codes in any case, and a CSV import matches them so
    uniqueIndex('units_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from products and product_units
    uniqueIndex('units_tenant_id_idx').on(table.tenantId, table.id),
    check('units_ratio_check', sql`${table.ratio} IS NULL OR ${table.ratio} > 0`),
    check('units_decimals_check', sql`${table.decimals} BETWEEN 0 AND 4`),
  ],
);
