import { sql } from 'drizzle-orm';
import { check, date, foreignKey, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';

// Batches (lots) and serial numbers: the tables exist from step 12 (build plan 0.3), so step 13's
// stock_movements can point at them from its first line. Nothing writes them yet: a batch is made
// when goods are received (step 13), a serial when a phone is received or sold.

export const batches = pgTable(
  'batches',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The maker's lot number, as printed on the strip: "NP24117"
    lotNumber: text('lot_number').notNull(),
    // mode 'string': business dates without a time zone, like the journal's
    manufacturedOn: date('manufactured_on', { mode: 'string' }),
    // NULL when the product has no expiry (products.has_expiry)
    expiresOn: date('expires_on', { mode: 'string' }),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    // One lot number per variant: receiving more of NP24117 adds to the same batch
    uniqueIndex('batches_variant_lot_idx').on(
      table.tenantId,
      table.variantId,
      sql`lower(${table.lotNumber})`,
    ),
    foreignKey({
      name: 'batches_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'batches_dates_check',
      sql`${table.manufacturedOn} IS NULL OR ${table.expiresOn} IS NULL OR ${table.expiresOn} > ${table.manufacturedOn}`,
    ),
  ],
);

export const serials = pgTable(
  'serials',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // An IMEI, a machine's serial plate
    serialNumber: text('serial_number').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    uniqueIndex('serials_variant_number_idx').on(
      table.tenantId,
      table.variantId,
      table.serialNumber,
    ),
    foreignKey({
      name: 'serials_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
  ],
);
