import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontListingInput,
  type ErrorCode,
  listingPricing,
  SHOP_BADGES,
  slugFromName,
  STOREFRONT_LISTING_SORTS,
  STOREFRONT_SALE_KINDS,
  STOREFRONT_SLUG_MAX,
  type StorefrontCandidate,
  type StorefrontListing,
  type StorefrontListingSort,
  type StorefrontListingSummary,
  type StorefrontSale,
  storefrontCandidateQuerySchema,
  storefrontImagesSchema,
  storefrontListingQuerySchema,
  storefrontSectionsSchema,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { storefrontListings } from '@omnivo/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import { containsPattern } from '../../common/db/search.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';
import { shopUrl } from '../shop-url.js';
import { slugTaken, StorefrontCategoriesService } from './categories.service.js';
import { StorefrontImagesService } from './images.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

// One listing as the catalog and the editor read it, straight from SQL: the listing, its
// category's name, the product and variant it sells, and whether the shop's warehouse has it.
// Checked like any answer from the database (listing-sql.ts does the same for the shop)
const rowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pack_size: z.string(),
  category_id: z.uuid(),
  category_name: z.string(),
  price_override: z.string().nullable(),
  sale_kind: z.enum(STOREFRONT_SALE_KINDS).nullable(),
  sale_value: z.string().nullable(),
  sale_starts_at: z.iso.datetime().nullable(),
  sale_ends_at: z.iso.datetime().nullable(),
  badges: z.array(z.enum(SHOP_BADGES)),
  images: storefrontImagesSchema,
  description_sections: storefrontSectionsSchema,
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  published_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
  version: z.number().int(),
  product_id: z.uuid(),
  product_name: z.string(),
  archived: z.boolean(),
  variant_id: z.uuid(),
  sku: z.string(),
  option_values: z.array(z.string()),
  sale_price: z.string().nullable(),
  // null while the shop has no warehouse
  in_stock: z.boolean().nullable(),
  // The sort's key as Postgres wrote it, for the next cursor (see ORDERS)
  sort_key: z.string(),
});
type Row = z.infer<typeof rowSchema>;

// Each sort's key. A Record: a sort added to STOREFRONT_LISTING_SORTS without a line here does
// not compile. "-updated" uses the microseconds (isoText), so two listings saved in one
// millisecond are not skipped by a cursor. The name sorts use the first 60 characters, as the
// shop's "Name: A to Z" does (26f, decision 30): the key goes into a cursor of at most 512
// characters. Ties go by id, so the order is total and a cursor is exact
const ORDERS: Record<StorefrontListingSort, { key: SQL; text: SQL; desc: boolean; cast: SQL }> = {
  '-updated': {
    key: sql`l.updated_at`,
    text: isoText(sql`l.updated_at`),
    desc: true,
    cast: sql`timestamptz`,
  },
  name: {
    key: sql`left(lower(l.name), 60)`,
    text: sql`left(lower(l.name), 60)`,
    desc: false,
    cast: sql`text`,
  },
  '-name': {
    key: sql`left(lower(l.name), 60)`,
    text: sql`left(lower(l.name), 60)`,
    desc: true,
    cast: sql`text`,
  },
};

// A cursor is [sort, key, id]; the sort is in it, so a cursor from one order sent with another is
// refused instead of landing in the middle of a different list
const cursorSchema = z.tuple([z.enum(STOREFRONT_LISTING_SORTS), z.string().max(300), z.uuid()]);

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

// The SQL every read starts from. `sort` picks the key column; `where` and `rest` finish it
function listingsSql(
  warehouseId: string | null,
  sort: StorefrontListingSort,
  where: SQL,
  rest: SQL,
) {
  // The shop's rule for "in stock" (26f, decision 27): more than nothing in its warehouse, summed
  // over the batches
  const inStock =
    warehouseId === null
      ? sql`NULL::boolean`
      : sql`(SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
              WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
                AND b.warehouse_id = ${warehouseId}::uuid) > 0`;
  return sql`
    SELECT l.id::text, l.slug, l.name, l.pack_size, l.category_id::text, c.name AS category_name,
           l.price_override::text, l.sale_kind, l.sale_value::text,
           ${isoText(sql`l.sale_starts_at`)} AS sale_starts_at,
           ${isoText(sql`l.sale_ends_at`)} AS sale_ends_at,
           l.badges, l.images, l.description_sections, l.seo_title, l.seo_description,
           ${isoText(sql`l.published_at`)} AS published_at,
           ${isoText(sql`l.updated_at`)} AS updated_at, l.version,
           p.id::text AS product_id, p.name AS product_name,
           (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived,
           v.id::text AS variant_id, v.sku, v.option_values, v.sale_price::text,
           ${inStock} AS in_stock, ${ORDERS[sort].text} AS sort_key
      FROM storefront_listings l
      JOIN storefront_categories c ON c.tenant_id = l.tenant_id AND c.id = l.category_id
      JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE l.tenant_id = ${getTenantId()}::uuid AND ${where}
     ${rest}`;
}

// The sale as the tenant typed it, back into the form's shape. A percent comes as "10.0000"
// (numeric(19,4)); the form's box takes a whole number, so it goes back as "10"
function saleOf(row: Row): StorefrontSale | null {
  if (row.sale_kind === null || row.sale_value === null) return null;
  const dates = { startsAt: row.sale_starts_at, endsAt: row.sale_ends_at };
  return row.sale_kind === 'percent'
    ? { kind: 'percent', value: String(Number(row.sale_value)), ...dates }
    : { kind: row.sale_kind, value: row.sale_value, ...dates };
}

// The variant's options in words ("150ml · Neem"); '' for a product with one variant
function optionsText(values: readonly string[]): string {
  return values.join(' · ');
}

// A sale's start or end for the table: the form sends an ISO time with any offset, or null
function dateOrNull(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

// What a shopper pays: the listing's own price, else the variant's (26f, decision 2)
function regularOf(priceOverride: string | null, salePrice: string | null): string | null {
  return priceOverride ?? salePrice;
}

// A refusal that belongs to one box of the form
function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

// The audit's view of a listing: plain values only. The sale and the photos as short text, so a
// change shows as "10% → 15%" and "2 photos → 3 photos" in the log
function snapshot(row: {
  name: string;
  slug: string;
  packSize: string;
  categoryId: string;
  priceOverride: string | null;
  sale: StorefrontSale | null;
  badges: readonly string[];
  imageIds: readonly string[];
  sections: number;
  seoTitle: string | null;
  seoDescription: string | null;
}) {
  const sale = row.sale;
  return {
    name: row.name,
    slug: row.slug,
    packSize: row.packSize,
    categoryId: row.categoryId,
    // Like the table: "229" and "229.0000" are one price (addMoney writes 4 decimals)
    priceOverride: row.priceOverride === null ? null : addMoney(row.priceOverride, '0'),
    sale:
      sale === null
        ? null
        : [
            sale.kind,
            sale.kind === 'percent' ? sale.value : addMoney(sale.value, '0'),
            sale.startsAt === null ? '-' : new Date(sale.startsAt).toISOString(),
            sale.endsAt === null ? '-' : new Date(sale.endsAt).toISOString(),
          ].join(' '),
    badges: row.badges.join(', '),
    images: row.imageIds.join(', '),
    sections: row.sections,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}

function snapshotOf(row: Row) {
  return snapshot({
    name: row.name,
    slug: row.slug,
    packSize: row.pack_size,
    categoryId: row.category_id,
    priceOverride: row.price_override,
    sale: saleOf(row),
    badges: row.badges,
    imageIds: row.images.map((image) => image.id),
    sections: row.description_sections.length,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
  });
}

// Step 26g: the shop's listings (decision 16): a variant put in the shop as a draft ("Add to
// shop"), edited as one form, then published. A listing never changes the product: the ERP keeps
// the stock item, and the listing adds what only a shop needs.
@Injectable()
export class StorefrontListingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
    private readonly categories: StorefrontCategoriesService,
    private readonly images: StorefrontImagesService,
  ) {}

  // The query as the route parsed it (z.output: the defaults filled in)
  list(q: z.output<typeof storefrontListingQuerySchema>): Promise<{
    items: StorefrontListingSummary[];
    nextCursor: string | null;
  }> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      const order = ORDERS[q.sort];
      const filters: SQL[] = [sql`true`];
      if (q.search !== undefined && q.search !== '') {
        const pattern = containsPattern(q.search.normalize('NFC'));
        filters.push(
          sql`(lower(l.name) LIKE ${pattern} OR l.slug LIKE ${pattern} OR lower(v.sku) LIKE ${pattern})`,
        );
      }
      if (q.status === 'published') filters.push(sql`l.published_at IS NOT NULL`);
      if (q.status === 'draft') filters.push(sql`l.published_at IS NULL`);
      if (q.categoryId !== undefined) filters.push(sql`l.category_id = ${q.categoryId}::uuid`);

      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [sort, key, id] = cursor;
        if (sort !== q.sort) throw invalidCursor();
        // The key goes into SQL with a cast; a bad one would be Postgres's cast error, a 500
        if (q.sort === '-updated' && Number.isNaN(Date.parse(key))) throw invalidCursor();
        const op = order.desc ? sql`<` : sql`>`;
        filters.push(sql`(${order.key}, l.id) ${op} (${key}::${order.cast}, ${id}::uuid)`);
      }
      const direction = order.desc ? sql`DESC` : sql`ASC`;
      const rows = await this.select(
        tx,
        shop?.defaultWarehouseId ?? null,
        q.sort,
        sql.join(filters, sql` AND `),
        sql`ORDER BY ${order.key} ${direction}, l.id ${direction} LIMIT ${q.limit + 1}`,
      );
      const page = toPage(rows, q.limit, (last) => [q.sort, last.sort_key, last.id]);
      return { items: page.items.map((row) => this.toSummary(row)), nextCursor: page.nextCursor };
    });
  }

  // Decision 14: "Add to shop"'s search. Active goods (a service has no stock to sell online),
  // not listed yet, by name or SKU, A to Z. Its own cursor: [name key, variant id]
  candidates(
    q: z.output<typeof storefrontCandidateQuerySchema>,
  ): Promise<{ items: StorefrontCandidate[]; nextCursor: string | null }> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const filters: SQL[] = [
        sql`v.tenant_id = ${tenantId}::uuid`,
        sql`p.type = 'goods'`,
        sql`p.archived_at IS NULL AND v.archived_at IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM storefront_listings l
                         WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id)`,
      ];
      if (q.search !== undefined && q.search !== '') {
        const pattern = containsPattern(q.search.normalize('NFC'));
        filters.push(sql`(lower(p.name) LIKE ${pattern} OR lower(v.sku) LIKE ${pattern})`);
      }
      const cursor = decodeCursor(q.cursor, z.tuple([z.string().max(300), z.uuid()]));
      if (cursor !== undefined) {
        filters.push(sql`(left(lower(p.name), 60), v.id) > (${cursor[0]}, ${cursor[1]}::uuid)`);
      }
      const rows = z
        .array(
          z.object({
            variant_id: z.uuid(),
            product_id: z.uuid(),
            product_name: z.string(),
            option_values: z.array(z.string()),
            sku: z.string(),
            sale_price: z.string().nullable(),
            sort_key: z.string(),
          }),
        )
        .parse(
          await tx.execute(sql`
            SELECT v.id::text AS variant_id, p.id::text AS product_id, p.name AS product_name,
                   v.option_values, v.sku, v.sale_price::text, left(lower(p.name), 60) AS sort_key
              FROM product_variants v
              JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
             WHERE ${sql.join(filters, sql` AND `)}
             ORDER BY left(lower(p.name), 60), v.id
             LIMIT ${q.limit + 1}`),
        );
      const page = toPage(rows, q.limit, (last) => [last.sort_key, last.variant_id]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variant_id,
          productId: row.product_id,
          name: [row.product_name, optionsText(row.option_values)].filter(Boolean).join(' · '),
          sku: row.sku,
          salePrice: row.sale_price,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  async create(input: CreateStorefrontListingInput): Promise<StorefrontListing> {
    try {
      return await this.withTenant(async (tx) => {
        const shop = await this.settings.find(tx, false);
        if (shop === null) throw notSetUp();
        const variant = await this.variant(tx, input.variantId);
        if (!(await this.categories.exists(tx, input.categoryId))) {
          throw fieldError('storefront_category_invalid', 'categoryId', 'Pick a category.');
        }
        // The product's name and the variant's options, in NFC (26f, decision 34)
        const name = [variant.productName, optionsText(variant.optionValues)]
          .filter(Boolean)
          .join(' · ')
          .normalize('NFC');
        const [row] = await tx
          .insert(storefrontListings)
          .values({
            tenantId: getTenantId(),
            productId: variant.productId,
            variantId: variant.id,
            categoryId: input.categoryId,
            slug: await this.freeSlug(tx, name, variant.sku),
            name,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: storefrontListings.id });
        if (!row) throw new Error('Listing insert returned no row');
        const listing = await this.load(tx, row.id, shop.defaultWarehouseId);
        await audit(tx, {
          action: 'storefront_listing.created',
          entityType: 'storefront_listing',
          entityId: row.id,
          changes: created({ ...snapshotOf(listing), variant: variant.sku }),
        });
        return this.toListing(listing, shop.subdomain);
      });
    } catch (error) {
      // Two "Add to shop" clicks for one variant: the second one finds the first's row
      if (isUniqueViolation(error, 'storefront_listings_variant_idx')) {
        throw fieldError('storefront_variant_listed', 'variantId', 'It is in the shop already.');
      }
      throw error;
    }
  }

  get(id: string): Promise<StorefrontListing> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      if (shop === null) throw notSetUp();
      return this.toListing(await this.load(tx, id, shop.defaultWarehouseId), shop.subdomain);
    });
  }

  async update(id: string, input: UpdateStorefrontListingInput): Promise<StorefrontListing> {
    try {
      return await this.withTenant(async (tx) => {
        const shop = await this.settings.find(tx, false);
        if (shop === null) throw notSetUp();
        const before = await this.load(tx, id, shop.defaultWarehouseId, true);
        if (before.version !== input.version) throw versionConflict();
        if (input.categoryId !== before.category_id) {
          if (!(await this.categories.exists(tx, input.categoryId))) {
            throw fieldError('storefront_category_invalid', 'categoryId', 'Pick a category.');
          }
        }
        await this.checkImages(tx, input.images, before);
        const published = before.published_at !== null;
        // A published listing stays one the shop can show: a photo (the table's
        // storefront_listings_published_check) and a price (the shop leaves a listing without
        // one out, so it would vanish without a word)
        if (published && input.images.length === 0) {
          throw fieldError('storefront_listing_needs_photo', 'images', 'Keep one photo.');
        }
        const regular = regularOf(input.priceOverride, before.sale_price);
        if (published && regular === null) {
          throw fieldError('storefront_listing_no_price', 'priceOverride', 'Type a price.');
        }
        this.checkSale(input.sale, regular);

        await tx
          .update(storefrontListings)
          .set({
            name: input.name.normalize('NFC'),
            slug: input.slug,
            packSize: input.packSize,
            categoryId: input.categoryId,
            priceOverride: input.priceOverride,
            saleKind: input.sale?.kind ?? null,
            saleValue: input.sale?.value ?? null,
            saleStartsAt: dateOrNull(input.sale?.startsAt),
            saleEndsAt: dateOrNull(input.sale?.endsAt),
            badges: input.badges,
            images: input.images,
            descriptionSections: input.descriptionSections,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            version: sql`${storefrontListings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)),
          );
        const after = await this.load(tx, id, shop.defaultWarehouseId);
        await audit(tx, {
          action: 'storefront_listing.updated',
          entityType: 'storefront_listing',
          entityId: id,
          changes: diff(snapshotOf(before), snapshotOf(after)),
        });
        return this.toListing(after, shop.subdomain);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_listings_slug_idx')) throw slugTaken();
      throw error;
    }
  }

  publish(id: string, version: number): Promise<StorefrontListing> {
    return this.setPublished(id, version, true);
  }

  unpublish(id: string, version: number): Promise<StorefrontListing> {
    return this.setPublished(id, version, false);
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.load(tx, id, null, true);
      if (before.version !== version) throw versionConflict();
      // Its collection rows go with it (their FK cascades, 26f); the product stays in the ERP
      await tx
        .delete(storefrontListings)
        .where(and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)));
      await audit(tx, {
        action: 'storefront_listing.deleted',
        entityType: 'storefront_listing',
        entityId: id,
        changes: diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
      });
    });
  }

  private setPublished(id: string, version: number, on: boolean): Promise<StorefrontListing> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      if (shop === null) throw notSetUp();
      const before = await this.load(tx, id, shop.defaultWarehouseId, true);
      if (before.version !== version) throw versionConflict();
      // Already so (a second click, two tabs): what both wanted
      if ((before.published_at !== null) === on) return this.toListing(before, shop.subdomain);
      if (on) {
        if (before.archived) {
          throw new AppError(
            409,
            'storefront_variant_archived',
            'The product or its variant is archived in the ERP.',
          );
        }
        if (before.images.length === 0) {
          throw new AppError(409, 'storefront_listing_needs_photo', 'Add a photo first.');
        }
        if (regularOf(before.price_override, before.sale_price) === null) {
          throw new AppError(409, 'storefront_listing_no_price', 'Give it a price first.');
        }
      }
      await tx
        .update(storefrontListings)
        .set({
          // The "Newest" sort's time: a listing published again goes back to the top
          publishedAt: on ? new Date() : null,
          version: sql`${storefrontListings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)));
      await audit(tx, {
        action: on ? 'storefront_listing.published' : 'storefront_listing.unpublished',
        entityType: 'storefront_listing',
        entityId: id,
        changes: diff({ published: !on }, { published: on }),
      });
      return this.toListing(await this.load(tx, id, shop.defaultWarehouseId), shop.subdomain);
    });
  }

  // Every photo is this workspace's, ready, and (for a new one) made by the job. The photos the
  // listing has already are not asked again: they were ready when saved, and their files never
  // change. One error per photo that is not, on its own box
  private async checkImages(
    tx: Transaction,
    images: UpdateStorefrontListingInput['images'],
    before: Row,
  ): Promise<void> {
    const saved = new Set(before.images.map((image) => image.id));
    const asked = images.filter((image) => !saved.has(image.id)).map((image) => image.id);
    const ready = await this.images.readyIds(tx, asked);
    const fieldErrors: Record<string, ErrorCode[]> = {};
    images.forEach((image, index) => {
      if (!saved.has(image.id) && !ready.has(image.id)) {
        fieldErrors[`images.${String(index)}`] = ['storefront_image_not_ready'];
      }
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError(409, 'storefront_image_not_ready', 'A photo is not ready yet.', {
        fieldErrors,
      });
    }
  }

  // A sale must take something off and leave something to pay, at the price it is for. Its dates
  // do not matter here: a sale that starts next week must already be lower. listingPricing() is
  // the shop's own rule (26f), so the form's preview, this check and the shop agree
  private checkSale(sale: StorefrontSale | null, regular: string | null): void {
    if (sale === null) return;
    if (regular === null) {
      throw fieldError('storefront_listing_no_price', 'priceOverride', 'Type a price first.');
    }
    const priced = listingPricing(regular, { ...sale, startsAt: null, endsAt: null }, new Date());
    if (priced.compareAtPrice === null) {
      throw fieldError('storefront_sale_not_lower', 'sale.value', 'Take less off the price.');
    }
  }

  // A variant that may go into the shop: this workspace's, goods, not archived
  private async variant(tx: Transaction, variantId: string) {
    const [variant] = z
      .array(
        z.object({
          id: z.uuid(),
          product_id: z.uuid(),
          product_name: z.string(),
          option_values: z.array(z.string()),
          sku: z.string(),
          type: z.string(),
          archived: z.boolean(),
        }),
      )
      .parse(
        await tx.execute(sql`
          SELECT v.id::text, p.id::text AS product_id, p.name AS product_name, v.option_values,
                 v.sku, p.type, (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived
            FROM product_variants v
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
           WHERE v.tenant_id = ${getTenantId()}::uuid AND v.id = ${variantId}::uuid`),
      );
    // Another workspace's variant is "not found" like a made-up one, and so is a service
    if (variant?.type !== 'goods') {
      throw fieldError('required', 'variantId', 'Pick a product.');
    }
    if (variant.archived) {
      throw fieldError('storefront_variant_archived', 'variantId', 'The product is archived.');
    }
    return {
      id: variant.id,
      productId: variant.product_id,
      productName: variant.product_name,
      optionValues: variant.option_values,
      sku: variant.sku,
    };
  }

  // Decision 16: a slug made from the name, or from the SKU when the name has no Latin letter
  // (a Bangla name), else "listing"; then the first of slug, slug-2, slug-3… nobody has. Cut so
  // the number still fits in 100 characters. The unique index has the last word: a race between
  // two adds is a storefront_slug_taken the person can fix in the editor
  private async freeSlug(tx: Transaction, name: string, sku: string): Promise<string> {
    const base = slugFromName(name) || slugFromName(sku) || 'listing';
    const rows = z.array(z.object({ slug: z.string() })).parse(
      await tx.execute(sql`
          SELECT slug FROM storefront_listings
           WHERE tenant_id = ${getTenantId()}::uuid
             AND (slug = ${base} OR slug LIKE ${`${base.slice(0, STOREFRONT_SLUG_MAX - 5)}-%`})`),
    );
    const taken = new Set(rows.map((row) => row.slug));
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : `-${String(n)}`;
      const slug = `${base.slice(0, STOREFRONT_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken.has(slug)) return slug;
    }
  }

  private async select(
    tx: Transaction,
    warehouseId: string | null,
    sort: StorefrontListingSort,
    where: SQL,
    rest: SQL,
  ): Promise<Row[]> {
    return z.array(rowSchema).parse(await tx.execute(listingsSql(warehouseId, sort, where, rest)));
  }

  private async load(
    tx: Transaction,
    id: string,
    warehouseId: string | null,
    forUpdate = false,
  ): Promise<Row> {
    const [row] = await this.select(
      tx,
      warehouseId,
      '-updated',
      sql`l.id = ${id}::uuid`,
      forUpdate ? sql`FOR UPDATE OF l` : sql``,
    );
    if (!row) throw notFound('Listing');
    return row;
  }

  private toSummary(row: Row): StorefrontListingSummary {
    const [first] = row.images;
    const regular = regularOf(row.price_override, row.sale_price);
    const priced = regular === null ? null : listingPricing(regular, saleOf(row), new Date());
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      packSize: row.pack_size,
      sku: row.sku,
      categoryId: row.category_id,
      categoryName: row.category_name,
      image: first === undefined ? null : this.images.view(first),
      price: priced?.price ?? null,
      compareAtPrice: priced?.compareAtPrice ?? null,
      inStock: row.in_stock,
      status: row.published_at === null ? 'draft' : 'published',
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    };
  }

  private toListing(row: Row, subdomain: string): StorefrontListing {
    return {
      id: row.id,
      product: {
        id: row.product_id,
        name: row.product_name,
        // The stock item as one: archived when its product or this variant is
        status: row.archived ? 'archived' : 'active',
      },
      variant: {
        id: row.variant_id,
        sku: row.sku,
        name: optionsText(row.option_values),
        salePrice: row.sale_price,
      },
      categoryId: row.category_id,
      slug: row.slug,
      name: row.name,
      packSize: row.pack_size,
      priceOverride: row.price_override,
      sale: saleOf(row),
      badges: row.badges,
      images: row.images.map((image) => this.images.view(image)),
      descriptionSections: row.description_sections,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      inStock: row.in_stock,
      status: row.published_at === null ? 'draft' : 'published',
      publishedAt: row.published_at,
      shopUrl: shopUrl(this.config.storefront, subdomain, `/p/${row.slug}`),
      version: row.version,
      updatedAt: row.updated_at,
    };
  }
}
