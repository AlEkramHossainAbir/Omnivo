import {
  LANGUAGE_CODES,
  SHOP_PAYMENT_METHODS,
  SHOP_TEXT_PAGES,
  STOREFRONT_SALE_KINDS,
  type ShopBadge,
  type ShopDeliveryZone,
  type ShopPaymentMethod,
  type StorefrontImage,
  type StorefrontSection,
} from '@omnivo/contracts';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
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
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// Step 26f: the tenant's online shop (apps/shop), as the ERP keeps it. The shop's pages read it
// through /public/v1 as the omnivo_public role, which sees only what a shopper may see (migration
// 0064). Step 26g's Storefront screens write it as omnivo_app, like every other table. What the
// shopper gets (storefront.ts in the contracts) is worked out from these rows by the API: a price
// from the variant and the sale, HTML from the sections, an address from an image id.

// The rules every slug here follows: the contract's slugParamSchema, so a slug the ERP saves is
// always one the public API's routes accept
const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
// A colour as the shop's CSS takes it. Either case: the contract's hexColorSchema allows both
const HEX_PATTERN = '^#[0-9a-fA-F]{6}$';
// A link the tenant typed: a page of the shop itself or another https site. "//x.com" is not a
// path, so a path's second character is never "/" (the contract's linkSchema)
const LINK_PATTERN = '^(/([^/]|$)|https://)';

// `value ~ 'pattern'`, for the checks. sql.raw, because a CHECK cannot take a bound parameter ($1),
// and drizzle would make one of a plain string. Safe here: the patterns are this file's constants,
// never input
function matches(value: SQLWrapper, pattern: string): SQL {
  return sql`${value} ~ ${sql.raw(`'${pattern}'`)}`;
}

// A jsonb array's length, or NULL when the value is not an array. jsonb_array_length() of an
// object throws (22023) instead of returning false, and Postgres may run both sides of an AND in
// any order, so "jsonb_typeof(x) = 'array' AND jsonb_array_length(x) <= 4" can still throw. With
// this, the length check passes on NULL and the type check beside it refuses the row as a normal
// check_violation, which the API can turn into an error code
function arrayLength(value: SQLWrapper): SQL {
  return sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_array_length(${value}) END`;
}

// One row per workspace that has a shop. The row is made by step 26g's first save, and the shop
// answers once launched_at is set ("Open the shop"); until then its address is a 404, so a
// half-made shop is never on the internet. There is no way to close it again (step 26e: a shop is
// always open).
export const storefrontSettings = pgTable(
  'storefront_settings',
  {
    // One shop per workspace, so the tenant is the key (like tenant_settings)
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    // The shop's own name in its address: "acme" in acme.omnivo.shop. Only the label, never the
    // whole host: dev (acme.localhost), staging and production put a different domain after it
    // (the API's SHOP_BASE_DOMAIN), and the same row works in all of them. Step 26g starts it as
    // the workspace's slug. A custom domain (www.acme.com.bd) is a later step with its own table.
    subdomain: text('subdomain').notNull(),
    // The name in the header and the footer. Its own column, not tenants.name: the shop may trade
    // under another name than the company, and omnivo_public never reads the tenants table
    name: text('name').notNull(),
    language: text('language', { enum: LANGUAGE_CODES }).notNull().default('en'),
    // An uploaded picture (StorefrontImage's id, step 26g); its alt text is the shop's name. NULL:
    // the Omnivo mark is drawn next to the name
    logoImageId: uuid('logo_image_id'),
    // The two colours a tenant may change (CLAUDE.md → Storefront color tokens). The defaults are
    // Figma's. That they keep 4.5:1 between them is checked by step 26g's form, not here: a
    // contrast ratio is arithmetic SQL should not do
    brandColor: text('brand_color').notNull().default('#005859'),
    accentColor: text('accent_color').notNull().default('#b8ef69'),
    hotline: text('hotline').notNull(),
    address: text('address').notNull(),
    // One column per network, not a jsonb object: each can then be checked to be https
    facebookUrl: text('facebook_url'),
    instagramUrl: text('instagram_url'),
    xUrl: text('x_url'),
    linkedinUrl: text('linkedin_url'),
    // Where the shop's stock is counted (decision 3) and, from step 27, where its orders are
    // picked. NULL only before the launch: every listing would be out of stock
    defaultWarehouseId: uuid('default_warehouse_id'),
    // The checkout's radio cards ("Inside Dhaka — ৳80"). A list edited as one, read whole by the
    // checkout and the quote, and at most six: a jsonb array, not a table
    deliveryZones: jsonb('delivery_zones').$type<ShopDeliveryZone[]>().notNull().default([]),
    // NULL: never free / any order size. Per the subtotal, like shopCheckoutSettingsSchema
    freeDeliveryFrom: numeric('free_delivery_from', { precision: 19, scale: 4 }),
    minimumOrder: numeric('minimum_order', { precision: 19, scale: 4 }),
    paymentMethods: text('payment_methods', { enum: SHOP_PAYMENT_METHODS })
      .array()
      .$type<ShopPaymentMethod[]>()
      .notNull()
      .default(sql`'{cod}'::text[]`),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    // One address, one shop, across every workspace: the host lookup reads this index
    uniqueIndex('storefront_settings_subdomain_idx').on(table.subdomain),
    // A DNS label in lower case: 1 to 63 letters, digits and hyphens, never starting or ending
    // with a hyphen. Lower case only, so "Acme" and "acme" can never be two shops
    check(
      'storefront_settings_subdomain_check',
      sql`${table.subdomain} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check(
      'storefront_settings_colors_check',
      sql`${matches(table.brandColor, HEX_PATTERN)} AND ${matches(table.accentColor, HEX_PATTERN)}`,
    ),
    // Each link ends up in an <a href> on every page: never javascript: or plain http
    check(
      'storefront_settings_social_check',
      sql`coalesce(${table.facebookUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.instagramUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.xUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.linkedinUrl}, 'https://') LIKE 'https://%'`,
    ),
    check(
      'storefront_settings_zones_check',
      sql`jsonb_typeof(${table.deliveryZones}) = 'array' AND ${arrayLength(table.deliveryZones)} <= 6`,
    ),
    check(
      'storefront_settings_amounts_check',
      sql`coalesce(${table.freeDeliveryFrom}, 1) > 0 AND coalesce(${table.minimumOrder}, 1) > 0`,
    ),
    // At least one way to pay, or no order can be placed
    check('storefront_settings_payment_check', sql`cardinality(${table.paymentMethods}) >= 1`),
    // A launched shop can sell: it counts stock somewhere and delivers somewhere. Before the
    // launch the tenant may save the form half-filled
    check(
      'storefront_settings_launch_check',
      sql`${table.launchedAt} IS NULL OR (${table.defaultWarehouseId} IS NOT NULL AND ${arrayLength(table.deliveryZones)} >= 1)`,
    ),
    // A warehouse of this workspace. No ON DELETE: warehouses are archived, never deleted
    foreignKey({
      name: 'storefront_settings_warehouse_fk',
      columns: [table.tenantId, table.defaultWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
);

// The shop's own categories (decision: not the product categories). The ERP groups products the
// way its stock is kept ("Tablets", "Syrups"); a shop groups them the way people shop ("Diabetic
// care"). A tree, like product_categories, in the tenant's own order.
export const storefrontCategories = pgTable(
  'storefront_categories',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = a top category (the filter row's chips)
    parentId: uuid('parent_id'),
    // /c/<slug>. Unique in the whole shop, not only among siblings: the address has no parent in it
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // The order among siblings, smallest first; ties by name. Not unique: a reorder then writes
    // only the rows that moved
    position: smallint('position').notNull().default(0),
  },
  (table) => [
    uniqueIndex('storefront_categories_slug_idx').on(table.tenantId, table.slug),
    // Two "Tea" side by side would be two chips with one name. COALESCE as in product_categories:
    // NULLs never collide in a unique index
    uniqueIndex('storefront_categories_sibling_name_idx').on(
      table.tenantId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    // The target of the parent FK and of the listings' category FK
    uniqueIndex('storefront_categories_tenant_id_idx').on(table.tenantId, table.id),
    index('storefront_categories_tenant_parent_idx').on(table.tenantId, table.parentId),
    // A category with children cannot be deleted (no ON DELETE): step 26g says so in words
    foreignKey({
      name: 'storefront_categories_parent_fk',
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('storefront_categories_parent_not_self', sql`${table.parentId} <> ${table.id}`),
    check(
      'storefront_categories_slug_check',
      sql`${matches(table.slug, SLUG_PATTERN)} AND char_length(${table.slug}) <= 100`,
    ),
  ],
);

// A variant on sale in the shop: its page, its card and what the cart buys. The stock item stays
// the ERP's (product_variants); the listing adds what only a shop needs. Its price is the variant's
// sale_price unless price_override says otherwise (decision 2).
export const storefrontListings = pgTable(
  'storefront_listings',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Both, for the composite FK below: a variant of THIS product of THIS workspace. product_id
    // also lets omnivo_public's policy on products find the listed ones without a join
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    slug: text('slug').notNull(),
    // The name a shopper reads ("Himalaya Neem Face Wash"), not the ERP's ("HIM-NFW-150"). Step
    // 26g starts it from the product's name and the variant's options
    name: text('name').notNull(),
    // Words under the name ("150ml"); '' = none
    packSize: text('pack_size').notNull().default(''),
    // NULL = the variant's sale_price (decision 2)
    priceOverride: numeric('price_override', { precision: 19, scale: 4 }),
    // The sale as the tenant typed it (StorefrontSale): all NULL = no sale. listingPricing() turns
    // it into the shop's price, struck-out price and ribbon at the moment of the request
    saleKind: text('sale_kind', { enum: STOREFRONT_SALE_KINDS }),
    // A percent (1–99) or taka, to the paisa
    saleValue: numeric('sale_value', { precision: 19, scale: 4 }),
    saleStartsAt: timestamp('sale_starts_at', { withTimezone: true }),
    // Exclusive (decision 11): at this moment the sale is over
    saleEndsAt: timestamp('sale_ends_at', { withTimezone: true }),
    badges: text('badges')
      .array()
      .$type<ShopBadge[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    // At most four (STOREFRONT_IMAGES_MAX); the first is the card's. A jsonb array of
    // StorefrontImage, not a table: the four are saved and read together, in their order
    images: jsonb('images').$type<StorefrontImage[]>().notNull().default([]),
    // The description as sections (decision 8), never HTML. The API escapes and renders them
    descriptionSections: jsonb('description_sections')
      .$type<StorefrontSection[]>()
      .notNull()
      .default([]),
    // NULL = the name / the start of the first section (decision 14)
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    // NULL = a draft the shop never shows. Also the "Newest" sort: the time it went on sale
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('storefront_listings_slug_idx').on(table.tenantId, table.slug),
    // One listing per variant: two pages for one stock item would split its stock between two
    // carts and its reviews (later) between two pages. Also what omnivo_public's policy on
    // product_variants looks up
    uniqueIndex('storefront_listings_variant_idx').on(table.tenantId, table.variantId),
    // The target of the collection items' FK
    uniqueIndex('storefront_listings_tenant_id_idx').on(table.tenantId, table.id),
    // omnivo_public's policy on products
    index('storefront_listings_product_idx').on(table.tenantId, table.productId),
    // /c/<slug>, and what Postgres uses to check the category FK on delete
    index('storefront_listings_category_idx').on(table.tenantId, table.categoryId),
    // /c/all, newest first: only the published ones are ever listed, so only they are indexed
    index('storefront_listings_published_idx')
      .on(table.tenantId, table.publishedAt.desc())
      .where(sql`${table.publishedAt} IS NOT NULL`),
    // The search's trigram index on lower(name) is in migration 0064, like the products' (0020):
    // drizzle cannot write an operator class on an expression
    // No ON DELETE: a listed product cannot be deleted. The products API turns this FK's error
    // into product_in_use (step 26f.3 adds it to VARIANT_IN_USE), and the tenant archives it
    foreignKey({
      name: 'storefront_listings_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    // A category with listings cannot be deleted either
    foreignKey({
      name: 'storefront_listings_category_fk',
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [storefrontCategories.tenantId, storefrontCategories.id],
    }),
    check(
      'storefront_listings_slug_check',
      sql`${matches(table.slug, SLUG_PATTERN)} AND char_length(${table.slug}) <= 100`,
    ),
    // Zero is no price: a free product is not something a shop lists
    check(
      'storefront_listings_price_check',
      sql`${table.priceOverride} IS NULL OR ${table.priceOverride} > 0`,
    ),
    // storefrontSaleSchema again, so a row the API did not write can still never hold a sale
    // listingPricing() cannot read: a kind with its value, dates only with a sale, a whole percent
    // from 1 to 99, an amount above zero, and an end after the start
    check(
      'storefront_listings_sale_check',
      sql`(${table.saleKind} IS NULL) = (${table.saleValue} IS NULL)
        AND (${table.saleKind} IS NOT NULL OR (${table.saleStartsAt} IS NULL AND ${table.saleEndsAt} IS NULL))
        AND (${table.saleValue} IS NULL OR ${table.saleValue} > 0)
        AND (${table.saleKind} IS DISTINCT FROM 'percent' OR (${table.saleValue} = trunc(${table.saleValue}) AND ${table.saleValue} <= 99))
        AND (${table.saleStartsAt} IS NULL OR ${table.saleEndsAt} IS NULL OR ${table.saleStartsAt} < ${table.saleEndsAt})`,
    ),
    check(
      'storefront_listings_images_check',
      sql`jsonb_typeof(${table.images}) = 'array' AND ${arrayLength(table.images)} <= 4`,
    ),
    // A card always has a photo (shopListingSchema.images.min(1)): a draft may wait for one, a
    // published listing may not
    check(
      'storefront_listings_published_check',
      sql`${table.publishedAt} IS NULL OR ${arrayLength(table.images)} >= 1`,
    ),
    check(
      'storefront_listings_sections_check',
      sql`jsonb_typeof(${table.descriptionSections}) = 'array' AND ${arrayLength(table.descriptionSections)} <= 12`,
    ),
    // The contract's seo limits: a longer title would fail shopProductSchema on every request
    check(
      'storefront_listings_seo_check',
      sql`coalesce(char_length(${table.seoTitle}), 1) BETWEEN 1 AND 120 AND coalesce(char_length(${table.seoDescription}), 0) <= 300`,
    ),
  ],
);

// The home page's pictures: the one hero at the top (kind 'hero') and the picture-only banners
// between the rows (kind 'image'). One table for both: they share the link and the two pictures,
// and the hero's extra words are columns the checks below keep on the hero only.
export const storefrontBanners = pgTable(
  'storefront_banners',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ['hero', 'image'] }).notNull(),
    href: text('href').notNull(),
    // Desktop and phone draw a banner differently (CLAUDE.md → Hero banner), so each has its own
    // picture. StorefrontImage objects
    desktopImage: jsonb('desktop_image').$type<StorefrontImage>().notNull(),
    phoneImage: jsonb('phone_image').$type<StorefrontImage>().notNull(),
    // The hero's words and colours (heroBannerSchema); NULL on an image banner, whose words are
    // part of its picture
    headline: text('headline'),
    line: text('line'),
    eyebrow: text('eyebrow'),
    buttonLabel: text('button_label'),
    backgroundColor: text('background_color'),
    panelColor: text('panel_color'),
    buttonColor: text('button_color'),
    buttonTextColor: text('button_text_color'),
  },
  (table) => [
    // The home blocks' FK
    uniqueIndex('storefront_banners_tenant_id_idx').on(table.tenantId, table.id),
    // The home page has one hero (shopHomeSchema.hero)
    uniqueIndex('storefront_banners_hero_idx')
      .on(table.tenantId)
      .where(sql`${table.kind} = 'hero'`),
    check('storefront_banners_href_check', matches(table.href, LINK_PATTERN)),
    check(
      'storefront_banners_images_check',
      sql`jsonb_typeof(${table.desktopImage}) = 'object' AND jsonb_typeof(${table.phoneImage}) = 'object'`,
    ),
    // Two exact cases. A hero has its headline, its button and all four colours (line and eyebrow
    // are optional on it). An image banner has none of the hero's eight fields: a stray headline on
    // one would never show, and step 26g's form would offer to edit words nobody sees. Not
    // "(kind = 'hero') = (all six are there)": that lets an image banner keep a headline, since
    // "not all six" is still true
    check(
      'storefront_banners_hero_check',
      sql`(${table.kind} = 'hero' AND num_nonnulls(${table.headline}, ${table.buttonLabel}, ${table.backgroundColor}, ${table.panelColor}, ${table.buttonColor}, ${table.buttonTextColor}) = 6)
        OR (${table.kind} = 'image' AND num_nonnulls(${table.headline}, ${table.line}, ${table.eyebrow}, ${table.buttonLabel}, ${table.backgroundColor}, ${table.panelColor}, ${table.buttonColor}, ${table.buttonTextColor}) = 0)`,
    ),
    check(
      'storefront_banners_colors_check',
      // NULL passes (a regex on NULL is NULL, which a CHECK lets through): the hero check above says
      // which ones must be there
      sql`${matches(table.backgroundColor, HEX_PATTERN)} AND ${matches(table.panelColor, HEX_PATTERN)} AND ${matches(table.buttonColor, HEX_PATTERN)} AND ${matches(table.buttonTextColor, HEX_PATTERN)}`,
    ),
  ],
);

// A row of hand-picked listings on the home page ("Refresh with Himalaya")
export const storefrontCollections = pgTable(
  'storefront_collections',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    // 'fire': the flame after "Hot & Trending Right Now"; NULL = no icon
    icon: text('icon', { enum: ['fire'] }),
  },
  (table) => [uniqueIndex('storefront_collections_tenant_id_idx').on(table.tenantId, table.id)],
);

// The listings of a collection, in their order. A save replaces all of a collection's rows (like
// report_schedule_recipients), so the unique position never gets in the way of a reorder.
export const storefrontCollectionItems = pgTable(
  'storefront_collection_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    collectionId: uuid('collection_id').notNull(),
    listingId: uuid('listing_id').notNull(),
    // 1 = first in the row
    position: smallint('position').notNull(),
  },
  (table) => [
    // Each listing once per row
    primaryKey({
      name: 'storefront_collection_items_pkey',
      columns: [table.tenantId, table.collectionId, table.listingId],
    }),
    uniqueIndex('storefront_collection_items_position_idx').on(
      table.tenantId,
      table.collectionId,
      table.position,
    ),
    // A listing's rows, for the cascade below
    index('storefront_collection_items_listing_idx').on(table.tenantId, table.listingId),
    foreignKey({
      name: 'storefront_collection_items_collection_fk',
      columns: [table.tenantId, table.collectionId],
      foreignColumns: [storefrontCollections.tenantId, storefrontCollections.id],
    }).onDelete('cascade'),
    // A deleted listing leaves every row it was in. An unpublished one stays in the row and
    // comes back when it is published again: omnivo_public simply does not see it meanwhile
    foreignKey({
      name: 'storefront_collection_items_listing_fk',
      columns: [table.tenantId, table.listingId],
      foreignColumns: [storefrontListings.tenantId, storefrontListings.id],
    }).onDelete('cascade'),
    check('storefront_collection_items_position_check', sql`${table.position} >= 1`),
  ],
);

// What the home page shows under the hero and the featured grid, top to bottom: each block is an
// image banner or a collection (shopHomeSchema.blocks). A save replaces all of a shop's rows.
export const storefrontHomeBlocks = pgTable(
  'storefront_home_blocks',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    position: smallint('position').notNull(),
    // Exactly one of the two. The banner is an image banner: the API refuses the hero here (one
    // column of a composite FK cannot say "kind = image", and a trigger for it is not worth it)
    bannerId: uuid('banner_id'),
    collectionId: uuid('collection_id'),
  },
  (table) => [
    primaryKey({
      name: 'storefront_home_blocks_pkey',
      columns: [table.tenantId, table.position],
    }),
    // Each banner and each collection once on the page. Partial: the other column is NULL
    uniqueIndex('storefront_home_blocks_banner_idx')
      .on(table.tenantId, table.bannerId)
      .where(sql`${table.bannerId} IS NOT NULL`),
    uniqueIndex('storefront_home_blocks_collection_idx')
      .on(table.tenantId, table.collectionId)
      .where(sql`${table.collectionId} IS NOT NULL`),
    // Deleting a banner or a collection takes it off the page
    foreignKey({
      name: 'storefront_home_blocks_banner_fk',
      columns: [table.tenantId, table.bannerId],
      foreignColumns: [storefrontBanners.tenantId, storefrontBanners.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_home_blocks_collection_fk',
      columns: [table.tenantId, table.collectionId],
      foreignColumns: [storefrontCollections.tenantId, storefrontCollections.id],
    }).onDelete('cascade'),
    check(
      'storefront_home_blocks_one_check',
      sql`num_nonnulls(${table.bannerId}, ${table.collectionId}) = 1`,
    ),
    check('storefront_home_blocks_position_check', sql`${table.position} >= 1`),
  ],
);

// The footer's four text pages. A page the tenant has not written has no row (the shop shows "page
// not found"); updated_at is the "Last updated" date under its title.
export const storefrontPages = pgTable(
  'storefront_pages',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slug: text('slug', { enum: SHOP_TEXT_PAGES }).notNull(),
    sections: jsonb('sections').$type<StorefrontSection[]>().notNull(),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    primaryKey({ name: 'storefront_pages_pkey', columns: [table.tenantId, table.slug] }),
    // A page with no section would be an empty card under its title
    check(
      'storefront_pages_sections_check',
      sql`jsonb_typeof(${table.sections}) = 'array' AND ${arrayLength(table.sections)} BETWEEN 1 AND 12`,
    ),
  ],
);
