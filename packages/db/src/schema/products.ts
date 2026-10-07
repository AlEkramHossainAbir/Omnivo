import {
  type CustomFieldValues,
  PRODUCT_TYPES,
  type ProductOption,
  TRACKING_MODES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productCategories } from './product-categories.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';

// A product: what it is called, how it is counted and grouped. What is stocked and sold is its
// variants (product_variants): exactly one for a simple product. deleted_at is not used: a product
// is deleted for real (only while nothing uses it) or archived.
export const products = pgTable(
  'products',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // P-00042 from the number series, or the company's own (a garments style number)
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type', { enum: PRODUCT_TYPES }).notNull().default('goods'),
    categoryId: uuid('category_id'),
    description: text('description'),
    // Stock is counted in this unit, always. Packs are rows of product_units.
    baseUnitId: uuid('base_unit_id').notNull(),
    tracking: text('tracking', { enum: TRACKING_MODES }).notNull().default('none'),
    hasExpiry: boolean('has_expiry').notNull().default(false),
    // The VAT rate its sales lines start with (step 15a). NULL = the workspace's default rate, so
    // changing the default moves every product that never chose its own.
    taxRateId: uuid('tax_rate_id'),
    // [{ name: 'Size', values: ['S', 'M'] }], checked with Zod on the way in. JSONB, not a table:
    // it is only ever read and written whole, with its product.
    options: jsonb('options')
      .$type<ProductOption[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The workspace's own fields (custom_field_definitions): key → value
    customFields: jsonb('custom_fields')
      .$type<CustomFieldValues>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // A code means one product, in any case: a scanner field or a CSV does not care about case
    uniqueIndex('products_tenant_code_idx').on(table.tenantId, sql`lower(${table.code})`),
    // The target of the composite FKs from variants and units
    uniqueIndex('products_tenant_id_idx').on(table.tenantId, table.id),
    // The list's keyset orders: by name, and by last change. By code uses the unique index above.
    index('products_tenant_name_idx').on(table.tenantId, sql`lower(${table.name})`, table.id),
    index('products_tenant_updated_idx').on(table.tenantId, table.updatedAt, table.id),
    // A category's products — and Postgres's own check of the FK when a category is deleted
    index('products_tenant_category_idx').on(table.tenantId, table.categoryId),
    index('products_tenant_base_unit_idx').on(table.tenantId, table.baseUnitId),
    // "Which products use this rate?" Rates are archived, never deleted, so the FK below never
    // has to check a delete; the index is for the settings page's count and the reports.
    index('products_tenant_tax_rate_idx').on(table.tenantId, table.taxRateId),
    foreignKey({
      name: 'products_category_fk',
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [productCategories.tenantId, productCategories.id],
    }),
    foreignKey({
      name: 'products_base_unit_fk',
      columns: [table.tenantId, table.baseUnitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // NULL tax_rate_id skips the check (MATCH SIMPLE)
    foreignKey({
      name: 'products_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    // The same two rules as the contract's productRules, here too: a row written by any other path
    // (a script, a later import) still cannot be a tracked service or an expiry without batches
    check('products_service_untracked', sql`${table.type} = 'goods' OR ${table.tracking} = 'none'`),
    check(
      'products_expiry_needs_batch',
      sql`NOT ${table.hasExpiry} OR ${table.tracking} = 'batch'`,
    ),
    check('products_options_array', sql`jsonb_typeof(${table.options}) = 'array'`),
    check('products_custom_fields_object', sql`jsonb_typeof(${table.customFields}) = 'object'`),
  ],
);

// What is stocked and sold: a size and colour of a T-shirt, or the one and only "variant" of a
// simple product. Stock, sales and purchase lines (steps 13–17) point here.
export const productVariants = pgTable(
  'product_variants',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    // The order the form shows them in
    position: smallint('position').notNull(),
    sku: text('sku').notNull(),
    // One value per product option, in the options' order; '{}' for a simple product
    optionValues: text('option_values')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Per base unit. NULL = no fixed price (not zero: zero is a price)
    salePrice: numeric('sale_price', { precision: 19, scale: 4 }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
    // Step 18's sync reads changes by updated_at
    updatedAt: baseColumns().updatedAt,
  },
  (table) => [
    uniqueIndex('product_variants_tenant_sku_idx').on(table.tenantId, sql`lower(${table.sku})`),
    // The target of the FKs from barcodes, batches and serials: a variant of THIS product
    uniqueIndex('product_variants_product_id_idx').on(table.tenantId, table.productId, table.id),
    // Each combination once per product. An array, so no NULLs to slip past the index.
    uniqueIndex('product_variants_values_idx').on(
      table.tenantId,
      table.productId,
      table.optionValues,
    ),
    // Deleting a product deletes its variants. From step 13, a variant with stock lines cannot be
    // deleted (their FK), so neither can its product: the API turns that into product_in_use.
    foreignKey({
      name: 'product_variants_product_fk',
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    check(
      'product_variants_price_check',
      sql`${table.salePrice} IS NULL OR ${table.salePrice} >= 0`,
    ),
    check('product_variants_values_check', sql`cardinality(${table.optionValues}) <= 3`),
  ],
);

// The bigger units a product also comes in, with how many base units each is: a box = 10 strips,
// a strip = 10 tablets (both written in tablets: 100 and 10). The base unit itself is not a row.
export const productUnits = pgTable(
  'product_units',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    productId: uuid('product_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    position: smallint('position').notNull(),
    // Base units in one of these. NUMERIC(19,6): a yard in metres is 0.9144.
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    // The unit sales and purchase forms start with. No row flagged = the base unit.
    isSalesDefault: boolean('is_sales_default').notNull().default(false),
    isPurchaseDefault: boolean('is_purchase_default').notNull().default(false),
  },
  (table) => [
    // Each unit once per product. Also the target of the barcodes' FK below.
    uniqueIndex('product_units_product_unit_idx').on(table.tenantId, table.productId, table.unitId),
    // At most one default of each kind per product
    uniqueIndex('product_units_sales_default_idx')
      .on(table.tenantId, table.productId)
      .where(sql`${table.isSalesDefault}`),
    uniqueIndex('product_units_purchase_default_idx')
      .on(table.tenantId, table.productId)
      .where(sql`${table.isPurchaseDefault}`),
    // A unit used by a product cannot be deleted (unit_in_use)
    index('product_units_tenant_unit_idx').on(table.tenantId, table.unitId),
    foreignKey({
      name: 'product_units_product_fk',
      columns: [table.tenantId, table.productId],
      foreignColumns: [products.tenantId, products.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'product_units_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    check('product_units_factor_check', sql`${table.factor} > 0`),
  ],
);

// Every barcode, in one table: a variant's own, and a pack's (unit_id). A scan is then one lookup,
// and the unique index makes sure a barcode means one thing in the whole workspace — a variant's
// barcode can never also be some carton's.
export const productBarcodes = pgTable(
  'product_barcodes',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // NULL = one base unit of the variant; otherwise the pack it is printed on
    unitId: uuid('unit_id'),
  },
  (table) => [
    uniqueIndex('product_barcodes_tenant_code_idx').on(table.tenantId, table.code),
    index('product_barcodes_product_idx').on(table.tenantId, table.productId),
    // product_id is in both keys, so the variant and the pack are always of the same product
    foreignKey({
      name: 'product_barcodes_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }).onDelete('cascade'),
    // NULL unit_id skips the check (MATCH SIMPLE)
    foreignKey({
      name: 'product_barcodes_unit_fk',
      columns: [table.tenantId, table.productId, table.unitId],
      foreignColumns: [productUnits.tenantId, productUnits.productId, productUnits.unitId],
    }).onDelete('cascade'),
  ],
);
