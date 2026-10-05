import { MOVEMENT_KINDS } from '@omnivo/contracts';
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
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches, serials } from './batches.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// The stock ledger (build plan step 13): one row per change of stock, never updated, never
// deleted (migration 0022's trigger). Stock is the sum of these rows — there is no quantity column
// on products, and there never will be (system design §17, mistake 6). A posted document writes
// its rows once; a mistake is fixed by another document, like a journal entry.
export const stockMovements = pgTable(
  'stock_movements',
  {
    // UUIDv7: ordered by the time the row was written — the stock card's tie-break inside a day
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // The business date of the document, without time or time zone
    date: date('date', { mode: 'string' }).notNull(),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // A batch-tracked product: always a batch. A serial-tracked one: one row per serial number.
    batchId: uuid('batch_id'),
    serialId: uuid('serial_id'),
    // In the product's base unit: + in, − out. NUMERIC(19,4), a string in TypeScript.
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    kind: text('kind', { enum: MOVEMENT_KINDS }).notNull(),
    // The document that made it (an adjustment or a transfer) and its number at the time: a
    // posted document's number never changes, so the stock card needs no join to show it
    documentId: uuid('document_id').notNull(),
    documentNumber: text('document_number').notNull(),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
  },
  (table) => [
    // The stock card: one variant's rows in date order (keyset on date, id)
    index('stock_movements_variant_date_idx').on(
      table.tenantId,
      table.variantId,
      table.date,
      table.id,
    ),
    // "Does this product have stock history?" (ProductsService) and the variant FK's own check
    index('stock_movements_product_idx').on(table.tenantId, table.productId, table.variantId),
    index('stock_movements_warehouse_idx').on(table.tenantId, table.warehouseId),
    index('stock_movements_document_idx').on(table.tenantId, table.documentId),
    // No ON DELETE: a variant with movements cannot be deleted, so neither can its product (the
    // API turns this FK's error into product_in_use / product_variant_in_use)
    foreignKey({
      name: 'stock_movements_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_movements_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    // variant_id is in both keys: the batch and the serial are always of this variant
    foreignKey({
      name: 'stock_movements_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    foreignKey({
      name: 'stock_movements_serial_fk',
      columns: [table.tenantId, table.variantId, table.serialId],
      foreignColumns: [serials.tenantId, serials.variantId, serials.id],
    }),
    check('stock_movements_quantity_check', sql`${table.quantity} <> 0`),
    check(
      'stock_movements_serial_check',
      sql`${table.serialId} IS NULL OR ${table.quantity} IN (1, -1)`,
    ),
  ],
);

// What is in each warehouse right now, per variant and batch: the sum of the movements, kept by
// the database itself (migration 0022's trigger adds every new movement here, in the same
// transaction). Code never writes it. It exists for two reasons: reading stock must not add up
// years of movements, and the row is what two people taking the last carton at the same time
// queue on (a row lock), so the second one sees the first one's result.
export const stockBalances = pgTable(
  'stock_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // NULL for a product without batches
    batchId: uuid('batch_id'),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per place. NULLS NOT DISTINCT: without it, two rows with batch_id NULL would not
    // collide, and an untracked variant could get two balances in one warehouse.
    unique('stock_balances_key')
      .on(table.tenantId, table.warehouseId, table.variantId, table.batchId)
      .nullsNotDistinct(),
    // A variant's stock in every warehouse (the stock list, the card)
    index('stock_balances_variant_idx').on(table.tenantId, table.variantId),
    foreignKey({
      name: 'stock_balances_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'stock_balances_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'stock_balances_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
  ],
);

// When to order more: per variant and warehouse (a depot keeps more Napa than a shop does)
export const reorderLevels = pgTable(
  'reorder_levels',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    warehouseId: uuid('warehouse_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // Reorder when the stock here falls to this (zero = "when it runs out")
    minQuantity: numeric('min_quantity', { precision: 19, scale: 4 }).notNull(),
    // How much to order then; NULL = the person decides each time
    reorderQuantity: numeric('reorder_quantity', { precision: 19, scale: 4 }),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
  },
  (table) => [
    uniqueIndex('reorder_levels_key_idx').on(table.tenantId, table.warehouseId, table.variantId),
    index('reorder_levels_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // A variant that is deleted (never had stock) takes its levels with it
    foreignKey({
      name: 'reorder_levels_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reorder_levels_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('reorder_levels_min_check', sql`${table.minQuantity} >= 0`),
    check(
      'reorder_levels_quantity_check',
      sql`${table.reorderQuantity} IS NULL OR ${table.reorderQuantity} > 0`,
    ),
  ],
);
