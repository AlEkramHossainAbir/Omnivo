import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// A named set of prices: "Dealer", "Wholesale" (step 15a). A customer points at one; step 15b's
// lookup reads it. deleted_at is not used: a list is archived, never deleted.
export const priceLists = pgTable(
  'price_lists',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('price_lists_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`),
    // The target of the composite FKs from items and parties
    uniqueIndex('price_lists_tenant_id_idx').on(table.tenantId, table.id),
  ],
);

// One price: a variant, in one unit, in one list. No id and no version: the key is the row
// (the PUT batch upserts on it), and each row is saved on its own (no lost update to guard).
export const priceListItems = pgTable(
  'price_list_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    priceListId: uuid('price_list_id').notNull(),
    // product_id is here for the FK below (a variant of THIS product) and for the page's join
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The base unit or one of the product's units (the API checks it: price_list_unit_invalid).
    // The price is per one of this unit.
    unitId: uuid('unit_id').notNull(),
    price: numeric('price', { precision: 19, scale: 4 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    primaryKey({
      name: 'price_list_items_pkey',
      columns: [table.tenantId, table.priceListId, table.variantId, table.unitId],
    }),
    // A list's page groups the rows by product, and itemCount counts them
    index('price_list_items_list_product_idx').on(
      table.tenantId,
      table.priceListId,
      table.productId,
    ),
    // Step 15b's lookup ("this variant, in any list"), and the variant FK's own delete check
    index('price_list_items_variant_idx').on(table.tenantId, table.productId, table.variantId),
    index('price_list_items_unit_idx').on(table.tenantId, table.unitId),
    foreignKey({
      name: 'price_list_items_list_fk',
      columns: [table.tenantId, table.priceListId],
      foreignColumns: [priceLists.tenantId, priceLists.id],
    }),
    // Deleting a product (only while nothing else uses it) takes its prices with it: a price is
    // not a use of the product
    foreignKey({
      name: 'price_list_items_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'price_list_items_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Zero is a price (a free sample); an empty box in the form removes the row instead
    check('price_list_items_price_check', sql`${table.price} >= 0`),
  ],
);
