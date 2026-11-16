import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  problemSchema,
  setupSchema,
  storefrontCandidatePageSchema,
  storefrontCategoryListSchema,
  storefrontCategorySchema,
  type StorefrontListing,
  storefrontListingPageSchema,
  storefrontListingSchema,
  type StorefrontSettings,
  storefrontSettingsSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
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
  startStorage,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { readyPhoto } from '../testing/shop-photo.js';
import { createProduct, tenantIdOf, variantOf } from '../testing/storefront.js';

// Step 26g: the Storefront menu writes a shop, so a mistake here would put one workspace's photo,
// product or category into another's shop. Two workspaces, Nirvor and Acme, each with a shop, a
// category, a ready photo, a listing and a product not listed yet. Every id of Acme's, sent by
// Nirvor, must be refused like an id that does not exist: never used, never shown, never named.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let nirvor: SignedIn;
let acme: SignedIn;

interface Shop {
  tenantId: string;
  warehouseId: string;
  settings: StorefrontSettings;
  categoryId: string;
  photoId: string;
  listing: StorefrontListing;
  // A variant of its own that is not in its shop yet: "Add to shop" would take it
  freeVariantId: string;
}

let ours: Shop;
let theirs: Shop;

function send(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload && { payload }),
  });
}

// What Nirvor gets back for one of Acme's ids: the status and, when there is one, the code
async function answer(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
): Promise<{ status: number; code: string | undefined; fieldErrors: unknown }> {
  const res = await send(nirvor, method, url, payload);
  const problem = res.statusCode >= 400 ? problemSchema.parse(res.json()) : undefined;
  return { status: res.statusCode, code: problem?.code, fieldErrors: problem?.fieldErrors };
}

async function setUp(who: SignedIn, slug: string, name: string): Promise<Shop> {
  expect((await send(who, 'POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send(who, 'GET', '/setup')).json()).status).toBe('ready');
  }, 20_000);
  const warehouseId =
    warehouseListSchema.parse((await send(who, 'GET', '/warehouses')).json()).items[0]?.id ?? '';
  const pcs =
    unitListSchema
      .parse((await send(who, 'GET', '/units')).json())
      .items.find((unit) => unit.code === 'pcs')?.id ?? '';

  const shop = await send(who, 'POST', '/storefront/settings', {
    subdomain: slug,
    name,
    language: 'en',
    hotline: '09612-000000',
    address: 'Mirpur 10, Dhaka',
    facebookUrl: '',
    instagramUrl: '',
    xUrl: '',
    linkedinUrl: '',
    defaultWarehouseId: warehouseId,
    deliveryZones: [{ id: null, name: 'Inside Dhaka', charge: '80' }],
    freeDeliveryFrom: '',
    minimumOrder: '',
    paymentMethods: ['cod'],
  });
  expect(shop.statusCode, shop.body).toBe(201);
  // The same category slug in both shops on purpose: each shop's slugs are its own
  const category = await send(who, 'POST', '/storefront/categories', {
    name: 'Beverages',
    slug: '',
    parentId: '',
  });
  expect(category.statusCode, category.body).toBe(201);
  const categoryId = storefrontCategorySchema.parse(category.json()).id;
  const tea = await createProduct(app, who, pcs, `${name} Green Tea`, '120');
  const added = await send(who, 'POST', '/storefront/listings', {
    variantId: variantOf(tea),
    categoryId,
  });
  expect(added.statusCode, added.body).toBe(201);
  const free = await createProduct(app, who, pcs, `${name} Neem Soap`, '60');
  return {
    tenantId: await tenantIdOf(sql, slug),
    warehouseId,
    settings: storefrontSettingsSchema.parse(shop.json()),
    categoryId,
    photoId: await readyPhoto(app, who),
    listing: storefrontListingSchema.parse(added.json()),
    freeVariantId: variantOf(free),
  };
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  nirvor = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  acme = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  [ours, theirs] = await Promise.all([
    setUp(nirvor, 'nirvor', 'Nirvor'),
    setUp(acme, 'acme', 'Acme'),
  ]);
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('another workspace’s photo', () => {
  it('is not found, and confirming it starts nothing', async () => {
    expect(await answer('GET', `/storefront/images/${theirs.photoId}`)).toMatchObject({
      status: 404,
    });
    expect(await answer('POST', `/storefront/images/${theirs.photoId}/complete`)).toMatchObject({
      status: 404,
    });
  });

  it('cannot go on a listing, even though it is ready', async () => {
    const res = await answer('PUT', `/storefront/listings/${ours.listing.id}`, {
      version: ours.listing.version,
      name: ours.listing.name,
      slug: ours.listing.slug,
      packSize: '',
      categoryId: ours.categoryId,
      priceOverride: '',
      sale: null,
      badges: [],
      images: [
        { id: ours.photoId, alt: 'Our tea' },
        { id: theirs.photoId, alt: 'Their tea' },
      ],
      descriptionSections: [],
      seoTitle: '',
      seoDescription: '',
    });
    expect(res).toEqual({
      status: 409,
      code: 'storefront_image_not_ready',
      fieldErrors: { 'images.1': ['storefront_image_not_ready'] },
    });
  });

  it('was made by the job as its own workspace’s', async () => {
    const rows = z
      .array(z.object({ id: z.string(), tenant_id: z.string(), status: z.string() }))
      .parse(
        await sql`SELECT id::text, tenant_id::text, status FROM storefront_images ORDER BY created_at`,
      );
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: ours.photoId, tenant_id: ours.tenantId, status: 'ready' },
        { id: theirs.photoId, tenant_id: theirs.tenantId, status: 'ready' },
      ]),
    );
  });
});

describe('another workspace’s products and categories', () => {
  it('are not offered to "Add to shop"', async () => {
    const page = storefrontCandidatePageSchema.parse(
      (await send(nirvor, 'GET', '/storefront/candidates?search=soap')).json(),
    );
    expect(page.items.map((item) => item.name)).toEqual(['Nirvor Neem Soap']);
  });

  it('cannot be added to the shop', async () => {
    expect(
      await answer('POST', '/storefront/listings', {
        variantId: theirs.freeVariantId,
        categoryId: ours.categoryId,
      }),
    ).toEqual({ status: 409, code: 'required', fieldErrors: { variantId: ['required'] } });
    expect(
      await answer('POST', '/storefront/listings', {
        variantId: ours.freeVariantId,
        categoryId: theirs.categoryId,
      }),
    ).toEqual({
      status: 409,
      code: 'storefront_category_invalid',
      fieldErrors: { categoryId: ['storefront_category_invalid'] },
    });
  });

  it('cannot hold one of our categories or listings', async () => {
    const parent = await answer('POST', '/storefront/categories', {
      name: 'Green tea',
      slug: '',
      parentId: theirs.categoryId,
    });
    expect(parent).toMatchObject({ status: 409, code: 'category_parent_invalid' });
    const moved = await answer('PUT', `/storefront/listings/${ours.listing.id}`, {
      version: ours.listing.version,
      name: ours.listing.name,
      slug: ours.listing.slug,
      packSize: '',
      categoryId: theirs.categoryId,
      priceOverride: '',
      sale: null,
      badges: [],
      images: [],
      descriptionSections: [],
      seoTitle: '',
      seoDescription: '',
    });
    expect(moved).toMatchObject({ status: 409, code: 'storefront_category_invalid' });
  });

  it('cannot be changed, moved or deleted', async () => {
    const id = theirs.categoryId;
    for (const [method, url, payload] of [
      ['PUT', `/storefront/categories/${id}`, { name: 'Ours', slug: '', parentId: '', version: 1 }],
      ['POST', `/storefront/categories/${id}/move`, { direction: 'down', version: 1 }],
      ['DELETE', `/storefront/categories/${id}?version=1`, undefined],
    ] as const) {
      expect(await answer(method, url, payload), `${method} ${url}`).toMatchObject({
        status: 404,
      });
    }
    const theirsNow = storefrontCategoryListSchema.parse(
      (await send(acme, 'GET', '/storefront/categories')).json(),
    ).items;
    expect(theirsNow.map((category) => [category.id, category.version])).toEqual([[id, 1]]);
  });

  it('are not in our lists', async () => {
    const categories = storefrontCategoryListSchema.parse(
      (await send(nirvor, 'GET', '/storefront/categories')).json(),
    ).items;
    expect(categories.map((category) => category.id)).toEqual([ours.categoryId]);
    // Filtering by their category is a filter that matches nothing, not a way in
    const filtered = storefrontListingPageSchema.parse(
      (await send(nirvor, 'GET', `/storefront/listings?categoryId=${theirs.categoryId}`)).json(),
    );
    expect(filtered.items).toEqual([]);
  });
});

describe('another workspace’s listing', () => {
  it('is not found by any route', async () => {
    const id = theirs.listing.id;
    const version = theirs.listing.version;
    for (const [method, url, payload] of [
      ['GET', `/storefront/listings/${id}`, undefined],
      ['POST', `/storefront/listings/${id}/publish`, { version }],
      ['POST', `/storefront/listings/${id}/unpublish`, { version }],
      ['DELETE', `/storefront/listings/${id}?version=${String(version)}`, undefined],
    ] as const) {
      expect(await answer(method, url, payload), `${method} ${url}`).toMatchObject({
        status: 404,
      });
    }
    const theirsNow = storefrontListingSchema.parse(
      (await send(acme, 'GET', `/storefront/listings/${id}`)).json(),
    );
    expect(theirsNow.version).toBe(version);
  });

  it('is not in our catalog, even searched by its own name', async () => {
    const page = storefrontListingPageSchema.parse(
      (await send(nirvor, 'GET', '/storefront/listings?search=green')).json(),
    );
    expect(page.items.map((listing) => listing.id)).toEqual([ours.listing.id]);
  });
});

describe('another workspace’s shop settings', () => {
  it('keeps its address: ours cannot take it', async () => {
    const res = await answer('PUT', '/storefront/settings', {
      subdomain: 'acme',
      name: 'Nirvor',
      language: 'en',
      hotline: '09612-000000',
      address: 'Mirpur 10, Dhaka',
      facebookUrl: '',
      instagramUrl: '',
      xUrl: '',
      linkedinUrl: '',
      defaultWarehouseId: ours.warehouseId,
      deliveryZones: [],
      freeDeliveryFrom: '',
      minimumOrder: '',
      paymentMethods: ['cod'],
      version: ours.settings.version,
    });
    expect(res).toEqual({
      status: 409,
      code: 'storefront_subdomain_taken',
      fieldErrors: { subdomain: ['storefront_subdomain_taken'] },
    });
  });

  it('keeps its warehouse: our shop cannot count stock there', async () => {
    const res = await answer('PUT', '/storefront/settings', {
      subdomain: 'nirvor',
      name: 'Nirvor',
      language: 'en',
      hotline: '09612-000000',
      address: 'Mirpur 10, Dhaka',
      facebookUrl: '',
      instagramUrl: '',
      xUrl: '',
      linkedinUrl: '',
      defaultWarehouseId: theirs.warehouseId,
      deliveryZones: [],
      freeDeliveryFrom: '',
      minimumOrder: '',
      paymentMethods: ['cod'],
      version: ours.settings.version,
    });
    expect(res).toMatchObject({ status: 409, code: 'storefront_warehouse_invalid' });
  });
});
