import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Product,
  problemSchema,
  publicShopSchema,
  setupSchema,
  shopCartQuoteSchema,
  shopCategorySchema,
  shopCheckoutSettingsSchema,
  shopHomeSchema,
  type ShopListing,
  shopListingPageSchema,
  shopProductPageSchema,
  shopTextPageSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import {
  addCategory,
  addListing,
  createProduct,
  insertedId,
  launchShop,
  photo,
  tenantIdOf,
  variantOf,
} from '../testing/storefront.js';
import { selectListings } from './listing-sql.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the public shop API against a real database, as the shop's server calls it: no
// login, only the X-Shop-Host header. One launched shop, "nirvor", with a few categories and
// listings; each test adds what it needs in a category of its own, so the tests do not change
// each other's pages.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let tenantId: string;
let pcs: string;
let mainWarehouse: string;
// The four listings of beforeAll, by name
let listings: { neem: string; tea: string; milk: string; old: string };
let milk: Product;

const HOST = { 'x-shop-host': 'nirvor.localhost:4331' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function get(url: string, headers: Record<string, string> = HOST) {
  return app.inject({ method: 'GET', url, headers });
}

async function page(query: string): Promise<ShopListing[]> {
  const res = await get(`/public/v1/listings?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return shopListingPageSchema.parse(res.json()).items;
}

function product(name: string, salePrice: string): Promise<Product> {
  return createProduct(app, owner, pcs, name, salePrice);
}

function problemOf(res: Awaited<ReturnType<typeof get>>) {
  return problemSchema.parse(res.json());
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  const auth = { headers: bearer(owner.accessToken) };
  expect(
    (await app.inject({ method: 'POST', url: '/setup', payload: { industry: 'retail' }, ...auth }))
      .statusCode,
  ).toBe(200);
  await eventually(async () => {
    const setup = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(setup.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  mainWarehouse = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  pcs = unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  tenantId = await tenantIdOf(sql, 'nirvor');

  await launchShop(sql, {
    tenantId,
    subdomain: 'nirvor',
    name: 'Nirvor Pharmacy',
    warehouseId: mainWarehouse,
  });
  const skin = await addCategory(sql, tenantId, { slug: 'skin-care', name: 'Skin care' });
  const face = await addCategory(sql, tenantId, {
    slug: 'face-wash',
    name: 'Face wash',
    parentId: skin,
  });
  const drinks = await addCategory(sql, tenantId, { slug: 'beverages', name: 'Beverages' });

  const neem = await product('Neem Face Wash', '299');
  const tea = await product('Green Tea', '120');
  milk = await product('Milk Powder', '780');
  const old = await product('Old Soap', '50');
  // Old Soap is archived after it was listed: its listing stays published, and the shop hides it
  await sql`UPDATE product_variants SET archived_at = now() WHERE id = ${variantOf(old)}`;
  await sql`UPDATE products SET archived_at = now() WHERE id = ${old.id}`;
  // Milk Powder has no stock: out of stock, but still on the shelf
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${tenantId}, ${mainWarehouse}, ${neem.id}, ${variantOf(neem)}, 5),
           (${tenantId}, ${mainWarehouse}, ${tea.id}, ${variantOf(tea)}, 2)`;

  const neemId = await addListing(sql, tenantId, {
    product: neem,
    categoryId: face,
    slug: 'neem-face-wash',
    sale: { kind: 'price', value: '229' },
    publishedDaysAgo: 3,
  });
  const teaId = await addListing(sql, tenantId, {
    product: tea,
    categoryId: drinks,
    slug: 'green-tea',
    sale: { kind: 'percent', value: '10' },
    seo: { title: 'Green tea from Sylhet', description: 'Loose green tea, 100 g.' },
    publishedDaysAgo: 2,
  });
  const milkId = await addListing(sql, tenantId, {
    product: milk,
    categoryId: drinks,
    slug: 'milk-powder',
    publishedDaysAgo: 1,
  });
  const oldId = await addListing(sql, tenantId, {
    product: old,
    categoryId: skin,
    slug: 'old-soap',
    publishedDaysAgo: 0,
  });
  listings = { neem: neemId, tea: teaId, milk: milkId, old: oldId };

  // The home page: an image banner, then a row that holds the archived soap and the tea
  const collection = insertedId(
    await sql`
    INSERT INTO storefront_collections (id, tenant_id, title, icon)
    VALUES (gen_random_uuid(), ${tenantId}, 'Hot & Trending', 'fire') RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
    VALUES (${tenantId}, ${collection}, ${listings.old}, 1),
           (${tenantId}, ${collection}, ${listings.tea}, 2)`;
  const banner = insertedId(
    await sql`
    INSERT INTO storefront_banners (id, tenant_id, kind, href, desktop_image, phone_image)
    VALUES (gen_random_uuid(), ${tenantId}, 'image', '/c/skin-care', ${sql.json(photo(3))},
      ${sql.json(photo(4))})
    RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_home_blocks (tenant_id, position, banner_id, collection_id)
    VALUES (${tenantId}, 1, ${banner}, NULL), (${tenantId}, 2, NULL, ${collection})`;
  await sql`
    INSERT INTO storefront_pages (tenant_id, slug, sections)
    VALUES (${tenantId}, 'terms', ${sql.json([{ heading: 'Terms', body: 'Read [this](/pages/privacy).' }])})`;
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('which shop', () => {
  it('answers the shop and its categories, never cached', async () => {
    const shop = await get('/public/v1/shop');
    expect(shop.statusCode, shop.body).toBe(200);
    // Decision 24: the shop's server caches; the API never lets a proxy keep a tenant's answer
    expect(shop.headers['cache-control']).toBe('no-store');
    expect(publicShopSchema.parse(shop.json())).toMatchObject({
      name: 'Nirvor Pharmacy',
      timeZone: 'Asia/Dhaka',
      hotline: '09612-000000',
      logo: null,
    });
    const tree = z.array(shopCategorySchema).parse((await get('/public/v1/categories')).json());
    // One flat list in the tenant's order (position, then name); the shop builds the tree
    expect(tree.map((category) => category.slug)).toEqual(['beverages', 'face-wash', 'skin-care']);
  });

  it('finds the shop by any spelling of its host', async () => {
    for (const host of ['NIRVOR.localhost', 'nirvor.localhost.', ' nirvor.localhost ']) {
      expect((await get('/public/v1/shop', { 'x-shop-host': host })).statusCode, host).toBe(200);
    }
  });

  it('answers 404 storefront_not_found for every host that is not a launched shop', async () => {
    const hosts = ['other.localhost', 'nirvor.example.com', 'a.nirvor.localhost', 'localhost', ''];
    for (const host of hosts) {
      const res = await get('/public/v1/shop', { 'x-shop-host': host });
      expect(res.statusCode, host).toBe(404);
      expect(problemOf(res).code).toBe('storefront_not_found');
    }
    // No header at all
    expect((await get('/public/v1/shop', {})).statusCode).toBe(404);
  });

  it('closes the shop while it is not launched, and when its workspace is deleted', async () => {
    try {
      await sql`UPDATE storefront_settings SET launched_at = NULL WHERE tenant_id = ${tenantId}`;
      for (const url of [
        '/public/v1/shop',
        '/public/v1/listings',
        '/public/v1/products/green-tea',
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(problemOf(res).code).toBe('storefront_not_found');
      }
    } finally {
      await sql`UPDATE storefront_settings SET launched_at = now() WHERE tenant_id = ${tenantId}`;
    }
    try {
      await sql`UPDATE tenants SET deleted_at = now() WHERE id = ${tenantId}`;
      expect(problemOf(await get('/public/v1/shop')).code).toBe('storefront_not_found');
    } finally {
      await sql`UPDATE tenants SET deleted_at = NULL WHERE id = ${tenantId}`;
    }
    expect((await get('/public/v1/shop')).statusCode).toBe(200);
  });
});

describe('the cards', () => {
  it('shows only published listings of products that are not archived', async () => {
    const all = await page('');
    expect(all.map((card) => card.slug)).toEqual(['milk-powder', 'green-tea', 'neem-face-wash']);
    expect(all.find((card) => card.slug === 'neem-face-wash')).toMatchObject({
      price: '229.0000',
      compareAtPrice: '299.0000',
      discount: { kind: 'amount', value: '70.0000' },
      inStock: true,
      packSize: '150ml',
    });
    // A card has one photo, the small one
    expect(all[0]?.images).toHaveLength(1);
    expect(all[0]?.images[0]?.url).toMatch(
      /\/storefront\/0{8}-0{4}-4000-8000-0{11}1\/small\.webp$/,
    );
    expect(all.find((card) => card.slug === 'milk-powder')?.inStock).toBe(false);
  });

  it('hides a draft, an archived variant and a variant with no price', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'hidden', name: 'Hidden' });
    const draft = await product('Draft Lotion', '150');
    const archived = await product('Archived Lotion', '150');
    const noPrice = await product('Unpriced Lotion', '150');
    const ownPrice = await product('Own Price Lotion', '150');
    await addListing(sql, tenantId, {
      product: draft,
      categoryId: category,
      slug: 'draft-lotion',
      publishedDaysAgo: null,
    });
    await addListing(sql, tenantId, {
      product: archived,
      categoryId: category,
      slug: 'archived-lotion',
    });
    await addListing(sql, tenantId, {
      product: noPrice,
      categoryId: category,
      slug: 'unpriced-lotion',
    });
    await addListing(sql, tenantId, {
      product: ownPrice,
      categoryId: category,
      slug: 'own-price-lotion',
      priceOverride: '175',
    });
    // Only the variant is archived, not the product
    await sql`UPDATE product_variants SET archived_at = now() WHERE id = ${variantOf(archived)}`;
    // Decision 2: no price of its own and none on the variant
    await sql`UPDATE product_variants SET sale_price = NULL WHERE id IN (${variantOf(noPrice)}, ${variantOf(ownPrice)})`;

    const shown = await page('category=hidden');
    // The listing's own price is enough, even when the variant has none
    expect(shown.map((card) => [card.slug, card.price])).toEqual([
      ['own-price-lotion', '175.0000'],
    ]);
    for (const slug of ['draft-lotion', 'archived-lotion', 'unpriced-lotion', 'old-soap']) {
      expect((await get(`/public/v1/products/${slug}`)).statusCode, slug).toBe(404);
    }
  });

  // listing-sql.ts works the price out in SQL (to filter and sort by it) and the card in
  // TypeScript (listingPricing). If the two ever differ, a "From ৳100" filter shows a ৳99 card,
  // or the cards of "Price: low to high" come out of order. So every kind of sale, and every way a
  // sale is not on, is checked both ways: the card the API answers, and the SQL's own column
  it('works out the same price in SQL as on the card, for every kind of sale', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'sales', name: 'Sales' });
    const now = Date.now();
    // Whole seconds: the API sends the end back as saleUntil, and the test compares it. Postgres
    // writes it to the microsecond (isoText in listing-sql.ts), still an ISO time for Date.parse
    const tomorrow = new Date(Math.floor((now + DAY) / 1000) * 1000);
    const cases: {
      slug: string;
      regular: string;
      override?: string;
      sale: { kind: 'percent' | 'amount' | 'price'; value: string; startsAt?: Date; endsAt?: Date };
      expected: Pick<ShopListing, 'price' | 'compareAtPrice' | 'discount' | 'saleUntil'>;
    }[] = [
      {
        // 10% of ৳249.95 is ৳24.995: half up to ৳25.00, in Postgres's round() and in percentOfMoney
        slug: 'percent-rounds',
        regular: '249.95',
        sale: { kind: 'percent', value: '10' },
        expected: {
          price: '224.9500',
          compareAtPrice: '249.9500',
          discount: { kind: 'percent', value: 10 },
          saleUntil: null,
        },
      },
      {
        slug: 'amount-off',
        regular: '299',
        sale: { kind: 'amount', value: '50' },
        expected: {
          price: '249.0000',
          compareAtPrice: '299.0000',
          discount: { kind: 'amount', value: '50.0000' },
          saleUntil: null,
        },
      },
      {
        // The listing's own price is the regular price; the variant's ৳999 is not used
        slug: 'set-price-on-override',
        regular: '999',
        override: '500',
        sale: { kind: 'price', value: '425' },
        expected: {
          price: '425.0000',
          compareAtPrice: '500.0000',
          discount: { kind: 'amount', value: '75.0000' },
          saleUntil: null,
        },
      },
      {
        slug: 'running-window',
        regular: '299',
        sale: { kind: 'amount', value: '30', startsAt: new Date(now - HOUR), endsAt: tomorrow },
        expected: {
          price: '269.0000',
          compareAtPrice: '299.0000',
          discount: { kind: 'amount', value: '30.0000' },
          saleUntil: tomorrow.toISOString().replace('.000Z', '.000000Z'),
        },
      },
      {
        slug: 'not-started',
        regular: '299',
        sale: { kind: 'percent', value: '20', startsAt: new Date(now + DAY) },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // Decision 11: the end is exclusive, so a sale that ended a minute ago is off
        slug: 'ended',
        regular: '299',
        sale: {
          kind: 'percent',
          value: '20',
          startsAt: new Date(now - 2 * DAY),
          endsAt: new Date(now - 60_000),
        },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // Decision 9: "sell at ৳350" when it costs ৳299 takes nothing off: no sale
        slug: 'price-above-regular',
        regular: '299',
        sale: { kind: 'price', value: '350' },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // …and neither does a sale that would give it away
        slug: 'everything-off',
        regular: '299',
        sale: { kind: 'amount', value: '299' },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
    ];
    for (const [index, c] of cases.entries()) {
      const made = await product(`Sale case ${String(index)}`, c.regular);
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: c.slug,
        sale: c.sale,
        ...(c.override !== undefined && { priceOverride: c.override }),
      });
    }

    const cards = await page('category=sales');
    expect(cards).toHaveLength(cases.length);
    // The price column of listing-sql.ts's subquery, read the way the API reads it (as
    // omnivo_public, in this shop, at one moment). The card's price is listingPricing's
    const rows = await app
      .get(ShopDb)
      .read(HOST['x-shop-host'], (tx, shop) =>
        selectListings(tx, shop, drizzleSql`WHERE shown.category_id = ${category}::uuid`),
      );
    const sqlPrice = new Map(rows.map((row) => [row.slug, row.price]));
    for (const c of cases) {
      const card = cards.find((one) => one.slug === c.slug);
      expect(card, c.slug).toMatchObject(c.expected);
      // The same text: numeric(19,4) in Postgres, 4 decimals in the contracts' money helpers
      expect(sqlPrice.get(c.slug), c.slug).toBe(card?.price);
    }
    // The filter is in whole taka: ৳224.95 is under 225 and over 224
    expect((await page('category=sales&maxPrice=224')).map((one) => one.slug)).not.toContain(
      'percent-rounds',
    );
    expect((await page('category=sales&minPrice=225')).map((one) => one.slug)).not.toContain(
      'percent-rounds',
    );
    // The SQL's on_sale is the card's struck-out price: "Offer" shows exactly those
    const offer = await page('category=sales&offer=1');
    expect(offer.map((card) => card.slug).sort()).toEqual(
      cards
        .filter((card) => card.compareAtPrice !== null)
        .map((card) => card.slug)
        .sort(),
    );
    // And the cards come in the order of the prices the shopper pays
    const ascending = (await page('category=sales&sort=price_asc')).map((card) =>
      Number(card.price),
    );
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
  });

  it('counts stock in the shop warehouse only, over all its batches', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'stock', name: 'Stock' });
    const [factory] = z.array(z.object({ id: z.uuid() })).parse(
      await sql`
      INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
      SELECT gen_random_uuid(), tenant_id, branch_id, 'FACTORY', 'Factory store'
        FROM warehouses WHERE id = ${mainWarehouse}
      RETURNING id::text`,
    );
    const balance = async (made: Product, warehouseId: string, quantities: string[]) => {
      for (const [index, quantity] of quantities.entries()) {
        const batch = insertedId(
          await sql`
          INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number)
          VALUES (gen_random_uuid(), ${tenantId}, ${made.id}, ${variantOf(made)},
            ${`${made.id.slice(0, 8)}-${warehouseId.slice(0, 4)}-${String(index)}`})
          RETURNING id::text`,
        );
        await sql`
          INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity)
          VALUES (${tenantId}, ${warehouseId}, ${made.id}, ${variantOf(made)}, ${batch}, ${quantity})`;
      }
    };
    const more = await product('Sold Short Plenty', '90');
    const none = await product('Sold Short Even', '90');
    const elsewhere = await product('Factory Only', '90');
    // Step 20a's sold-short: one batch below zero, another above. 3 − 1 = 2 left
    await balance(more, mainWarehouse, ['3', '-1']);
    // 1 − 1 = nothing left
    await balance(none, mainWarehouse, ['1', '-1']);
    // Ten in the factory store, none in the shop's warehouse
    await balance(elsewhere, factory?.id ?? '', ['10']);
    for (const made of [more, none, elsewhere]) {
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: made.name.toLowerCase().replaceAll(' ', '-'),
      });
    }

    const cards = await page('category=stock&sort=name');
    expect(cards.map((card) => [card.slug, card.inStock])).toEqual([
      ['factory-only', false],
      ['sold-short-even', false],
      ['sold-short-plenty', true],
    ]);
    expect((await page('category=stock&inStock=1')).map((card) => card.slug)).toEqual([
      'sold-short-plenty',
    ]);
  });

  it('filters by category tree, words, price, stock and offer, and sorts', async () => {
    // A parent category shows its children's listings too
    expect((await page('category=skin-care')).map((card) => card.slug)).toEqual(['neem-face-wash']);
    // Every word must match: "beverages" the category, "tea" the name
    expect((await page('q=beverages%20tea')).map((card) => card.slug)).toEqual(['green-tea']);
    // Part of the SKU (NEEMFACEWASH), in any case
    expect((await page('q=nee')).map((card) => card.slug)).toEqual(['neem-face-wash']);
    expect(
      (await page('category=beverages&offer=1&inStock=1&maxPrice=200')).map((card) => card.slug),
    ).toEqual(['green-tea']);
    expect((await page('category=beverages&sort=price_desc')).map((card) => card.price)).toEqual([
      '780.0000',
      '108.0000',
    ]);
    // An unknown category finds nothing (decision 31), never every listing
    expect(await page('category=no-such-category')).toEqual([]);
    const bad = await get('/public/v1/listings?cursor=bad');
    expect(bad.statusCode).toBe(400);
    expect(problemOf(bad).code).toBe('invalid_cursor');
  });
});

describe('the product page', () => {
  it('answers the gallery, the description as escaped HTML, SEO and the related cards', async () => {
    const res = await get('/public/v1/products/green-tea');
    expect(res.statusCode, res.body).toBe(200);
    const { product: tea, related } = shopProductPageSchema.parse(res.json());
    // Both photos, large
    expect(tea.images).toHaveLength(2);
    for (const image of tea.images)
      expect(image.url).toMatch(/\/storefront\/[0-9a-f-]{36}\/large\.webp$/);
    // Decision 8: the tenant's words are text, never HTML; the <script> is shown, not run
    expect(tea.descriptionHtml).toBe(
      '<section><h2>Key benefits</h2><ul><li>Controls <strong>oil</strong></li><li>&lt;script&gt;x&lt;/script&gt;</li></ul></section>',
    );
    expect(tea).toMatchObject({
      sku: 'GREENTEA',
      unitName: 'Pieces',
      seo: { title: 'Green tea from Sylhet', description: 'Loose green tea, 100 g.' },
    });
    // The same category, newest first, without the product itself
    expect(related.map((card) => card.slug)).toEqual(['milk-powder']);
  });

  it('fills SEO from the name and the description when the tenant left it empty', async () => {
    const { product: neem } = shopProductPageSchema.parse(
      (await get('/public/v1/products/neem-face-wash')).json(),
    );
    expect(neem.seo.title).toBe('Neem Face Wash');
    expect(neem.seo.description).toContain('Controls oil');
    expect((await get('/public/v1/products/nothing-here')).statusCode).toBe(404);
  });

  it('refuses to delete a product the shop lists', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/products/${milk.id}?version=${String(milk.version)}`,
      headers: bearer(owner.accessToken),
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('product_in_use');
  });
});

describe('the home page', () => {
  it('answers no hero, and the blocks without the hidden listings', async () => {
    const home = shopHomeSchema.parse((await get('/public/v1/home')).json());
    expect(home.hero).toBeNull();
    expect(home.featured.map((card) => card.slug)).toContain('green-tea');
    expect(home.blocks.map((block) => block.kind)).toEqual(['image', 'collection']);
    const [banner, row] = home.blocks;
    expect(banner?.kind === 'image' && banner.desktopImage.url).toMatch(/\/wide\.webp$/);
    // The archived soap is left out of its row
    expect(row?.kind === 'collection' && row.collection.listings.map((card) => card.slug)).toEqual([
      'green-tea',
    ]);
  });

  it('answers the hero once, and leaves out a row with nothing to show', async () => {
    const hero = insertedId(
      await sql`
      INSERT INTO storefront_banners (id, tenant_id, kind, href, desktop_image, phone_image,
        headline, button_label, background_color, panel_color, button_color, button_text_color)
      VALUES (gen_random_uuid(), ${tenantId}, 'hero', '/c/beverages', ${sql.json(photo(5))},
        ${sql.json(photo(6))}, 'Fresh from Sylhet', 'Shop tea', '#eee0d8', '#e7d1b2', '#8b471f',
        '#ffffff')
      RETURNING id::text`,
    );
    const empty = insertedId(
      await sql`
      INSERT INTO storefront_collections (id, tenant_id, title)
      VALUES (gen_random_uuid(), ${tenantId}, 'Gone for now') RETURNING id::text`,
    );
    await sql`
      INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
      VALUES (${tenantId}, ${empty}, ${listings.old}, 1)`;
    // Decision 21: the hero put in the blocks too, and the row of only the archived soap
    await sql`
      INSERT INTO storefront_home_blocks (tenant_id, position, banner_id, collection_id)
      VALUES (${tenantId}, 3, ${hero}, NULL), (${tenantId}, 4, NULL, ${empty})`;

    const home = shopHomeSchema.parse((await get('/public/v1/home')).json());
    expect(home.hero).toMatchObject({
      headline: 'Fresh from Sylhet',
      colors: { panel: '#e7d1b2' },
    });
    expect(home.hero?.desktopImage.url).toMatch(/\/wide\.webp$/);
    expect(home.hero?.phoneImage.url).toMatch(/\/large\.webp$/);
    expect(home.blocks.map((block) => block.kind)).toEqual(['image', 'collection']);
  });
});

describe('the checkout', () => {
  it('quotes a cart from the shop price and stock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: HOST,
      payload: {
        lines: [
          { listingId: listings.neem, quantity: 2 },
          { listingId: listings.milk, quantity: 1 },
          { listingId: listings.old, quantity: 1 },
          // Not a uuid: unavailable, never a 500 from a ::uuid cast
          { listingId: 'lst-not-a-uuid', quantity: 1 },
        ],
        zoneId: 'inside_dhaka',
        couponCode: 'welcome10',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const quote = shopCartQuoteSchema.parse(res.json());
    expect(quote.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
      'unavailable',
    ]);
    // 2 × ৳229; the milk is out of stock, so it is not in the subtotal. Coupons come in step 27
    expect(quote).toMatchObject({
      subtotal: '458.0000',
      deliveryCharge: '80.0000',
      total: '538.0000',
      coupon: { status: 'refused', code: 'WELCOME10' },
    });
  });

  it('answers the checkout settings and the text pages', async () => {
    const settings = shopCheckoutSettingsSchema.parse(
      (await get('/public/v1/checkout-settings')).json(),
    );
    expect(settings).toMatchObject({
      zones: [{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }],
      freeDeliveryFrom: '1000.0000',
      minimumOrder: '300.0000',
    });
    const terms = shopTextPageSchema.parse((await get('/public/v1/pages/terms')).json());
    expect(terms.html).toBe(
      '<section><h2>Terms</h2><p>Read <a href="/pages/privacy">this</a>.</p></section>',
    );
    // A page the tenant has not written is not there
    expect((await get('/public/v1/pages/about')).statusCode).toBe(404);
  });
});

describe('paging', () => {
  it('walks 25 listings with a cursor in every sort, each one once', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'paging', name: 'Paging' });
    for (let n = 0; n < 25; n += 1) {
      // Five prices and the same day for all: many ties, which only the id can order
      const made = await product(`Page item ${String(n)}`, String(100 + (n % 5)));
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: `page-item-${String(n)}`,
        publishedDaysAgo: 4,
      });
    }
    for (const sort of ['newest', 'price_asc', 'price_desc', 'name']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const after: string = cursor === null ? '' : `&cursor=${cursor}`;
        const res = await get(`/public/v1/listings?category=paging&sort=${sort}${after}`);
        expect(res.statusCode, res.body).toBe(200);
        const next = shopListingPageSchema.parse(res.json());
        seen.push(...next.items.map((card) => card.id));
        cursor = next.nextCursor;
      } while (cursor !== null);
      expect(seen, sort).toHaveLength(25);
      expect(new Set(seen).size, sort).toBe(25);
    }
    // A cursor of one sort is refused in another
    const first = shopListingPageSchema.parse(
      (await get('/public/v1/listings?category=paging&sort=price_asc')).json(),
    );
    const mixed = await get(
      `/public/v1/listings?category=paging&sort=newest&cursor=${first.nextCursor ?? ''}`,
    );
    expect(mixed.statusCode).toBe(400);
  });
});
