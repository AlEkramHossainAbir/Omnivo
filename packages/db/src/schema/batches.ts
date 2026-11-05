import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// Batches (lots) and serial numbers: the tables exist from step 12 (build plan 0.3), so step 13's
// stock_movements point at them from their first row. A batch is made the first time a lot comes
// in (an adjustment "in", later a purchase receipt); a serial the first time an IMEI does.

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
    // The target of the composite FKs from stock rows: a batch of THIS variant (step 13)
    uniqueIndex('batches_variant_id_idx').on(table.tenantId, table.variantId, table.id),
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
    // Where it is now: NULL = not in any warehouse (sold, written off, or on a truck in transit).
    // Kept by migration 0022's trigger from the movements, like stock_balances; code never writes it.
    warehouseId: uuid('warehouse_id'),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    uniqueIndex('serials_variant_number_idx').on(
      table.tenantId,
      table.variantId,
      table.serialNumber,
    ),
    uniqueIndex('serials_variant_id_idx').on(table.tenantId, table.variantId, table.id),
    // The serial numbers in a warehouse (the stock card)
    index('serials_warehouse_idx').on(table.tenantId, table.warehouseId, table.variantId),
    foreignKey({
      name: 'serials_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'serials_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
  ],
);
