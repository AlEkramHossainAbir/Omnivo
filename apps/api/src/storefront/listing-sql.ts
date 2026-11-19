import {
  isMoneyAmount,
  listingPricing,
  SHOP_BADGES,
  SHOP_PAGE_SIZE,
  SHOP_SORTS,
  STOREFRONT_SALE_KINDS,
  storefrontImagesSchema,
  storefrontSectionsSchema,
  type ShopCategory,
  type ShopImage,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
  type ShopSort,
  type StorefrontSale,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { containsPattern } from '../common/db/search.js';
import { AppError } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { categoriesMatching, searchWords, subtreeIds } from './categories.js';
import { shopImage } from './media.js';
import type { ShopScope } from './shop-db.js';

// Step 26f: the listings the shop shows, as one SQL subquery every public read starts from (the
// cards, the product page, the collections, the quote). One place, so a rule like "an archived
// product leaves the shop" can never hold on the cards and not in the cart.
//
// A listing is shown when it is published (also omnivo_public's policy), its product and variant
// are not archived, and it has a price (its own, or the variant's sale price; a variant may have
// none, decision 2). Its price now comes from the same rules as listingPricing() in the contracts:
// the SQL needs it to filter and sort by the price the shopper pays, and the TypeScript to build
// the card. The integration test (26f.4) checks that the two agree for every kind of sale.
function shownListings(shop: ShopScope): SQL {
  const now = sql`${shop.now.toISOString()}::timestamptz`;
  return sql`
    SELECT l.id, l.slug, l.name, l.pack_size, l.category_id, l.badges, l.images, l.published_at,
           l.description_sections, l.seo_title, l.seo_description,
           l.sale_kind, l.sale_value, l.sale_starts_at, l.sale_ends_at,
           l.product_id, l.variant_id,
           v.sku, u.name AS unit_name, r.regular, s.on_sale,
           CASE WHEN s.on_sale THEN r.regular - o.off ELSE r.regular END AS price,
           f.free, f.free > 0 AS in_stock
      FROM storefront_listings l
      JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
      JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
      CROSS JOIN LATERAL (SELECT coalesce(l.price_override, v.sale_price) AS regular) r
      -- What the sale takes off, and whether it runs now. round(…, 2) is half away from zero,
      -- which for a positive amount is percentOfMoney's half up, to the paisa. The end is
      -- exclusive (decision 11)
      CROSS JOIN LATERAL (
        SELECT CASE l.sale_kind
                 WHEN 'percent' THEN round(r.regular * l.sale_value / 100, 2)
                 WHEN 'amount' THEN l.sale_value
                 WHEN 'price' THEN r.regular - l.sale_value
               END AS off,
               l.sale_kind IS NOT NULL
                 AND (l.sale_starts_at IS NULL OR l.sale_starts_at <= ${now})
                 AND (l.sale_ends_at IS NULL OR ${now} < l.sale_ends_at) AS running
      ) o
      -- Decision 9: a sale that takes nothing off, or everything, is no sale
      CROSS JOIN LATERAL (
        SELECT coalesce(o.running AND o.off > 0 AND r.regular - o.off > 0, false) AS on_sale
      ) s
      -- 26f's decision 3: in stock = more than nothing in the shop's warehouse. Summed over the
      -- batches, so a batch below zero (step 20a's sold-short) takes from the others. Step 27a:
      -- minus what orders hold there (27a's decision 6). A waiting order's hold counts until its
      -- expires_at, a confirmed order's (NULL) until its challan. Same clock as the price: one
      -- answer never shows a hold as both on and over
      CROSS JOIN LATERAL (
        SELECT (SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
                 WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
                   AND b.warehouse_id = ${shop.warehouseId}::uuid)
             - (SELECT coalesce(sum(h.quantity), 0) FROM storefront_stock_holds h
                 WHERE h.tenant_id = l.tenant_id AND h.variant_id = l.variant_id
                   AND h.warehouse_id = ${shop.warehouseId}::uuid
                   AND (h.expires_at IS NULL OR h.expires_at > ${now})) AS free
      ) f
     WHERE l.tenant_id = ${shop.tenantId}::uuid
       AND l.published_at IS NOT NULL
       AND v.archived_at IS NULL AND p.archived_at IS NULL
       AND r.regular IS NOT NULL`;
}

// Raw queries leave timestamps as Postgres's own text, which is not ISO (products.service.ts has
// the same helper). Microseconds, not milliseconds: published_at is a cursor key, and a key cut to
// the millisecond would skip a listing published in the same millisecond as the last card
export function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// The columns every read selects from the subquery, as text where Postgres would send its own types
const LISTING_COLUMNS = sql`
  shown.id::text, shown.slug, shown.name, shown.pack_size, shown.category_id::text, shown.badges,
  shown.images, shown.sku, shown.unit_name, shown.description_sections, shown.seo_title,
  shown.seo_description, shown.regular::text, shown.sale_kind, shown.sale_value::text,
  ${isoText(sql`shown.sale_starts_at`)} AS sale_starts_at,
  ${isoText(sql`shown.sale_ends_at`)} AS sale_ends_at,
  ${isoText(sql`shown.published_at`)} AS published_at, shown.price::text, shown.in_stock,
  shown.product_id::text, shown.variant_id::text, shown.free::text`;

const isoSchema = z.iso.datetime();

// The jsonb columns are checked like everything else from the database: they are the API's own
// writing (step 26g), but a row from a hand-made fix must not reach the shop half broken
const listingRowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pack_size: z.string(),
  category_id: z.uuid(),
  badges: z.array(z.enum(SHOP_BADGES)),
  // At least one: storefront_listings_published_check
  images: storefrontImagesSchema.min(1),
  sku: z.string().nullable(),
  unit_name: z.string(),
  description_sections: storefrontSectionsSchema,
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  regular: z.string(),
  sale_kind: z.enum(STOREFRONT_SALE_KINDS).nullable(),
  sale_value: z.string().nullable(),
  sale_starts_at: isoSchema.nullable(),
  sale_ends_at: isoSchema.nullable(),
  published_at: isoSchema,
  price: z.string(),
  in_stock: z.boolean(),
  // Step 27a: the stock item and how much of it is free (on hand minus held), for the quote and
  // the order. Never on a card: the shop says only "in stock", not how many (26f's decision 3)
  product_id: z.uuid(),
  variant_id: z.uuid(),
  free: z.string(),
});

export type ListingRow = z.infer<typeof listingRowSchema>;

// Run a query on the subquery: `shown` is its name, so `rest` (the WHERE, ORDER BY, LIMIT) reads
// like a query on a table
export async function selectListings(
  tx: Transaction,
  shop: ShopScope,
  rest: SQL,
): Promise<ListingRow[]> {
  return z.array(listingRowSchema).parse(await tx.execute(listingsSql(shop, sql``, rest)));
}

// `extra` adds columns to the select list (the page's sort key)
function listingsSql(shop: ShopScope, extra: SQL, rest: SQL): SQL {
  return sql`SELECT ${LISTING_COLUMNS}${extra} FROM (${shownListings(shop)}) shown ${rest}`;
}

function saleOf(row: ListingRow): StorefrontSale | null {
  if (row.sale_kind === null || row.sale_value === null) return null;
  // A percent comes as "10.0000" (numeric(19,4)); listingPricing reads it as a number
  return {
    kind: row.sale_kind,
    value: row.sale_value,
    startsAt: row.sale_starts_at,
    endsAt: row.sale_ends_at,
  };
}

// A card. Only its first photo, small: the card draws one (ProductCard.astro), and a page of 20
// cards stays light. The product page asks for its photos itself (productOf)
export function listingOf(row: ListingRow, shop: ShopScope, mediaUrl: string): ShopListing {
  const [first] = row.images;
  return listingWith(row, shop, first === undefined ? [] : [shopImage(mediaUrl, first, 'small')]);
}

export function listingWith(row: ListingRow, shop: ShopScope, images: ShopImage[]): ShopListing {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    packSize: row.pack_size,
    images,
    ...listingPricing(row.regular, saleOf(row), shop.now),
    badges: row.badges,
    inStock: row.in_stock,
    categoryId: row.category_id,
  };
}

// ---------------------------------------------------------------------------------------------
// The category and search pages

// Each sort: the key it orders by and which way. A Record, so a sort added to SHOP_SORTS without
// a line here fails the type check. Ties go by id, so the order is total and a cursor is exact.
// "name" orders by the first 60 characters: the key goes into the cursor, and a cursor is at most
// 512 characters (publicListingParamsSchema); 60 Bangla letters are 180 bytes, safely under it.
// Two names with the same first 60 characters go by id, which is still one fixed order
const ORDERS: Record<ShopSort, { key: SQL; desc: boolean; cast: SQL }> = {
  newest: { key: sql`shown.published_at`, desc: true, cast: sql`timestamptz` },
  price_asc: { key: sql`shown.price`, desc: false, cast: sql`numeric` },
  price_desc: { key: sql`shown.price`, desc: true, cast: sql`numeric` },
  name: { key: sql`left(lower(shown.name), 60)`, desc: false, cast: sql`text` },
};

// The sort's key as text, for the next cursor, written by Postgres itself: the same lower() and
// left() as the ORDER BY, so the key is exactly what the next page compares with. JavaScript's
// toLowerCase() and slice() differ from them on some letters (and slice counts UTF-16 units)
function sortKeyText(sort: ShopSort): SQL {
  return sort === 'newest' ? isoText(ORDERS.newest.key) : sql`${ORDERS[sort].key}::text`;
}

// A cursor is [sort, key, id]. The sort is in it, so a cursor from "Price: low to high" sent with
// "Newest" is refused instead of landing in the middle of another order
const cursorSchema = z.tuple([z.enum(SHOP_SORTS), z.string().max(300), z.uuid()]);

const pageRowSchema = z.object({ sort_key: z.string() });

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

function readCursor(cursor: string | null, sort: ShopSort): [string, string] | null {
  const decoded = decodeCursor(cursor ?? undefined, cursorSchema);
  if (decoded === undefined) return null;
  const [cursorSort, key, id] = decoded;
  if (cursorSort !== sort) throw invalidCursor();
  // The key goes into SQL with a cast: a bad one would be Postgres's cast error, a 500
  const valid =
    sort === 'newest' ? isoSchema.safeParse(key).success : sort === 'name' || isMoneyAmount(key);
  if (!valid) throw invalidCursor();
  return [key, id];
}

// `id IN (…)`, or false for an empty list (Postgres has no empty IN ()). Each id is cast, so a
// caller passes only uuids (the quote checks its ids first)
export function idIn(column: SQL, ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

// One page of cards: the shop's category and search pages, and the home page's grid (its first
// page). The same filters as the shop's mock (browse.ts), so its pages need no change:
// - a category and every category under it; an unknown slug finds nothing
// - every search word in the name, the SKU or the category trail
// - the price the shopper pays, in stock, on sale
export async function listingPage(
  tx: Transaction,
  shop: ShopScope,
  query: ShopListingQuery,
  categories: readonly ShopCategory[],
  mediaUrl: string,
): Promise<ShopListingPage> {
  const order = ORDERS[query.sort];
  const after = readCursor(query.cursor, query.sort);
  const conditions: SQL[] = [sql`true`];

  if (query.category !== null) {
    conditions.push(idIn(sql`shown.category_id`, subtreeIds(query.category, categories)));
  }
  for (const word of searchWords(query.q)) {
    const pattern = containsPattern(word);
    // lower(name) LIKE: the trigram index of 0064. A SKU is looked for anywhere in it, like the
    // ERP's product search
    conditions.push(sql`(lower(shown.name) LIKE ${pattern}
      OR lower(coalesce(shown.sku, '')) LIKE ${pattern}
      OR ${idIn(sql`shown.category_id`, categoriesMatching(word, categories))})`);
  }
  if (query.minPrice !== null) conditions.push(sql`shown.price >= ${query.minPrice}::numeric`);
  if (query.maxPrice !== null) conditions.push(sql`shown.price <= ${query.maxPrice}::numeric`);
  if (query.inStock) conditions.push(sql`shown.in_stock`);
  // On sale: a ribbon or a struck-out price, which listingPricing gives exactly when on_sale
  if (query.offer) conditions.push(sql`shown.on_sale`);
  if (after !== null) {
    const [key, id] = after;
    conditions.push(
      sql`(${order.key}, shown.id) ${order.desc ? sql`<` : sql`>`} (${key}::${order.cast}, ${id}::uuid)`,
    );
  }

  const direction = order.desc ? sql`DESC` : sql`ASC`;
  // One more than a page: if it comes, there is a next page (toPage in pagination/cursor.ts)
  const rows = z.array(listingRowSchema.extend(pageRowSchema.shape)).parse(
    await tx.execute(
      listingsSql(
        shop,
        sql`, ${sortKeyText(query.sort)} AS sort_key`,
        sql`WHERE ${sql.join(conditions, sql` AND `)}
            ORDER BY ${order.key} ${direction}, shown.id ${direction}
            LIMIT ${SHOP_PAGE_SIZE + 1}`,
      ),
    ),
  );
  const items = rows.slice(0, SHOP_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items: items.map((row) => listingOf(row, shop, mediaUrl)),
    nextCursor:
      rows.length > SHOP_PAGE_SIZE && last !== undefined
        ? encodeCursor([query.sort, last.sort_key, last.id])
        : null,
  };
}
