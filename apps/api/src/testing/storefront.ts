import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Product, productSchema, type StorefrontImage } from '@omnivo/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';
import { z } from 'zod';

import { bearer, type SignedIn } from './http.js';

// Step 26f's tests: a shop made straight in the database, as the superuser. Every row still passes
// the tables' checks, so a test can never set up a shop the real screens could not make.
// Step 26g kept this for the public API's tests (its decision 30): they test how a shop is read,
// and step 26g's own tests (storefront-admin.int.spec.ts) test how one is written. Made through
// the admin API, every listing would need a real photo, the storage and the image job.

const idRowSchema = z.array(z.object({ id: z.uuid() })).length(1);

// A photo reference. The public API never opens the file, it only builds the address, so any uuid
// will do. padStart: photo(12) is still a valid uuid
export function photo(n: number): StorefrontImage {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    alt: `Photo ${String(n)}`,
  };
}

// The id of the one row an INSERT … RETURNING id::text made. postgres.js types its rows loosely,
// so the row is checked like any answer from outside the program
export function insertedId(rows: unknown): string {
  const [row] = idRowSchema.parse(rows);
  return row?.id ?? '';
}

export async function tenantIdOf(sql: postgres.Sql, slug: string): Promise<string> {
  const [row] = idRowSchema.parse(await sql`SELECT id::text FROM tenants WHERE slug = ${slug}`);
  return row?.id ?? '';
}

// A product with one variant, through the ERP's own API, so its rows are exactly what a real
// workspace has (SKU, base unit, version). The SKU is the name without spaces, in capitals, unless
// the test names one (step 26g: a Bangla name has no letter \W keeps, and two names can make one SKU)
export async function createProduct(
  app: NestFastifyApplication,
  who: SignedIn,
  unitId: string,
  name: string,
  salePrice: string,
  sku = name.replace(/\W/g, '').toUpperCase(),
): Promise<Product> {
  const res = await app.inject({
    method: 'POST',
    url: '/products',
    headers: bearer(who.accessToken),
    payload: {
      code: '',
      name,
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: unitId,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      taxRateId: '',
      options: [],
      variants: [
        {
          id: null,
          sku,
          optionValues: [],
          barcode: '',
          salePrice,
          archived: false,
        },
      ],
      units: [],
      customFields: {},
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

export function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (variant === undefined) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

// A launched shop at `<subdomain>.localhost` (SHOP_BASE_DOMAIN's default), counting its stock in
// `warehouseId`, with one delivery zone: what storefront_settings_launch_check asks of a launch
export async function launchShop(
  sql: postgres.Sql,
  shop: { tenantId: string; subdomain: string; name: string; warehouseId: string },
): Promise<void> {
  await sql`
    INSERT INTO storefront_settings (tenant_id, subdomain, name, hotline, address,
      default_warehouse_id, delivery_zones, free_delivery_from, minimum_order, launched_at)
    VALUES (${shop.tenantId}, ${shop.subdomain}, ${shop.name}, '09612-000000', 'Mirpur 10, Dhaka',
      ${shop.warehouseId}, ${sql.json([{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }])},
      1000, 300, now())`;
}

export async function addCategory(
  sql: postgres.Sql,
  tenantId: string,
  category: { slug: string; name: string; parentId?: string },
): Promise<string> {
  const [row] = idRowSchema.parse(
    await sql`
    INSERT INTO storefront_categories (id, tenant_id, parent_id, slug, name)
    VALUES (gen_random_uuid(), ${tenantId}, ${category.parentId ?? null}, ${category.slug},
      ${category.name})
    RETURNING id::text`,
  );
  return row?.id ?? '';
}

export interface ListingInput {
  product: Product;
  categoryId: string;
  slug: string;
  // The card's name; the product's name when left out
  name?: string;
  priceOverride?: string;
  sale?: { kind: 'percent' | 'amount' | 'price'; value: string; startsAt?: Date; endsAt?: Date };
  seo?: { title: string; description: string };
  // How long ago it was published. null: a draft. Different ages give "Newest" a known order
  publishedDaysAgo?: number | null;
}

// One listing of the product's first variant, with two photos and one description section. The
// section holds a <script> on purpose: the API must send it as text (decision 8)
export async function addListing(
  sql: postgres.Sql,
  tenantId: string,
  listing: ListingInput,
): Promise<string> {
  const published = listing.publishedDaysAgo === undefined ? 0 : listing.publishedDaysAgo;
  const [row] = idRowSchema.parse(
    await sql`
    INSERT INTO storefront_listings (id, tenant_id, product_id, variant_id, category_id, slug, name,
      pack_size, price_override, sale_kind, sale_value, sale_starts_at, sale_ends_at, images,
      description_sections, seo_title, seo_description, published_at)
    VALUES (gen_random_uuid(), ${tenantId}, ${listing.product.id}, ${variantOf(listing.product)},
      ${listing.categoryId}, ${listing.slug}, ${listing.name ?? listing.product.name}, '150ml',
      ${listing.priceOverride ?? null}, ${listing.sale?.kind ?? null}, ${listing.sale?.value ?? null},
      ${listing.sale?.startsAt ?? null}, ${listing.sale?.endsAt ?? null},
      ${sql.json(published === null ? [] : [photo(1), photo(2)])},
      ${sql.json([{ heading: 'Key benefits', body: '- Controls **oil**\n- <script>x</script>' }])},
      ${listing.seo?.title ?? null}, ${listing.seo?.description ?? null},
      ${published === null ? null : sql`now() - make_interval(days => ${published})`})
    RETURNING id::text`,
  );
  return row?.id ?? '';
}
