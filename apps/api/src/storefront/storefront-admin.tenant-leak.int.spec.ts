import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  problemSchema,
  setupSchema,
  STOREFRONT_HERO_DEFAULT_COLORS,
  storefrontAppearanceSchema,
  storefrontBannerSchema,
  storefrontCollectionSchema,
  storefrontPageSchema,
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

// Step 26h: the look and the pages. Acme has a hero, a picture banner, a collection of its own
// listing and a Terms page; Nirvor a picture banner. Nirvor sends Acme's ids: a photo must not go
// on its logo or banners, a listing not into its collections, and a banner, a collection, the hero
// or a page must not be read, changed, moved or deleted. Pages have no id, so for them the
// question is whether the slug reaches the other workspace's row.
describe('another workspace’s look and pages', () => {
  let theirBanner: string;
  let theirCollection: string;
  let ourBanner: string;

  function heroForm(photoId: string, version: number | null) {
    return {
      version,
      href: '/c/beverages',
      headline: 'Fresh tea every morning',
      line: '',
      eyebrow: '',
      buttonLabel: 'Shop now',
      desktopImage: { id: photoId, alt: 'Green tea' },
      phoneImage: { id: photoId, alt: 'Green tea' },
      ...STOREFRONT_HERO_DEFAULT_COLORS,
    };
  }

  function bannerForm(desktop: string, phone: string) {
    return {
      href: '/c/all',
      desktopImage: { id: desktop, alt: 'Mega sale' },
      phoneImage: { id: phone, alt: 'Mega sale' },
    };
  }

  beforeAll(async () => {
    let res = await send(
      acme,
      'PUT',
      '/storefront/appearance/hero',
      heroForm(theirs.photoId, null),
    );
    expect(res.statusCode, res.body).toBe(200);
    res = await send(
      acme,
      'POST',
      '/storefront/appearance/banners',
      bannerForm(theirs.photoId, theirs.photoId),
    );
    expect(res.statusCode, res.body).toBe(201);
    theirBanner = storefrontBannerSchema.parse(res.json()).id;
    // A draft may wait in a collection: the shop shows it once it is published
    res = await send(acme, 'POST', '/storefront/appearance/collections', {
      title: 'Acme picks',
      icon: null,
      listingIds: [theirs.listing.id],
    });
    expect(res.statusCode, res.body).toBe(201);
    theirCollection = storefrontCollectionSchema.parse(res.json()).id;
    res = await send(acme, 'PUT', '/storefront/pages/terms', {
      version: null,
      sections: [{ heading: 'Acme terms', body: 'Wholesale only.' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    res = await send(
      nirvor,
      'POST',
      '/storefront/appearance/banners',
      bannerForm(ours.photoId, ours.photoId),
    );
    expect(res.statusCode, res.body).toBe(201);
    ourBanner = storefrontBannerSchema.parse(res.json()).id;
  }, 60_000);

  it('cannot put their photo on our logo, hero or banner, though it is ready', async () => {
    const theme = storefrontAppearanceSchema.parse(
      (await send(nirvor, 'GET', '/storefront/appearance')).json(),
    ).theme;
    expect(
      await answer('PUT', '/storefront/appearance/theme', {
        version: theme.version,
        logoImageId: theirs.photoId,
        brandColor: theme.brandColor,
        accentColor: theme.accentColor,
      }),
    ).toEqual({
      status: 409,
      code: 'storefront_image_not_ready',
      fieldErrors: { logoImageId: ['storefront_image_not_ready'] },
    });
    expect(
      await answer('PUT', '/storefront/appearance/hero', {
        ...heroForm(ours.photoId, null),
        desktopImage: { id: theirs.photoId, alt: 'Their tea' },
      }),
    ).toEqual({
      status: 409,
      code: 'storefront_image_not_ready',
      fieldErrors: { desktopImage: ['storefront_image_not_ready'] },
    });
    expect(
      await answer(
        'POST',
        '/storefront/appearance/banners',
        bannerForm(ours.photoId, theirs.photoId),
      ),
    ).toEqual({
      status: 409,
      code: 'storefront_image_not_ready',
      fieldErrors: { phoneImage: ['storefront_image_not_ready'] },
    });
  });

  it('cannot put their listing in our collection', async () => {
    expect(
      await answer('POST', '/storefront/appearance/collections', {
        title: 'Our picks',
        icon: null,
        listingIds: [ours.listing.id, theirs.listing.id],
      }),
    ).toEqual({
      status: 409,
      code: 'storefront_listing_invalid',
      fieldErrors: { 'listingIds.1': ['storefront_listing_invalid'] },
    });
  });

  it('finds their banner, collection and hero by no route', async () => {
    for (const [method, url, payload] of [
      [
        'PUT',
        `/storefront/appearance/banners/${theirBanner}`,
        { ...bannerForm(ours.photoId, ours.photoId), version: 1 },
      ],
      ['DELETE', `/storefront/appearance/banners/${theirBanner}?version=1`, undefined],
      ['GET', `/storefront/appearance/collections/${theirCollection}`, undefined],
      [
        'PUT',
        `/storefront/appearance/collections/${theirCollection}`,
        { title: 'Ours now', icon: null, listingIds: [ours.listing.id], version: 1 },
      ],
      ['DELETE', `/storefront/appearance/collections/${theirCollection}?version=1`, undefined],
      [
        'POST',
        '/storefront/appearance/home/move',
        { kind: 'banner', id: theirBanner, direction: 'down' },
      ],
      [
        'POST',
        '/storefront/appearance/home/move',
        { kind: 'collection', id: theirCollection, direction: 'up' },
      ],
      // Nirvor has no hero; Acme's must not be the one found
      ['DELETE', '/storefront/appearance/hero?version=1', undefined],
    ] as const) {
      expect(await answer(method, url, payload), `${method} ${url}`).toMatchObject({
        status: 404,
      });
    }
    const theirsNow = storefrontAppearanceSchema.parse(
      (await send(acme, 'GET', '/storefront/appearance')).json(),
    );
    expect(theirsNow.hero?.version).toBe(1);
    expect(
      theirsNow.blocks.map((block) =>
        block.kind === 'banner'
          ? [block.banner.id, block.banner.version]
          : [block.collection.id, block.collection.version],
      ),
    ).toEqual([
      [theirBanner, 1],
      [theirCollection, 1],
    ]);
  });

  it('shows us only our own blocks, and no hero', async () => {
    const page = storefrontAppearanceSchema.parse(
      (await send(nirvor, 'GET', '/storefront/appearance')).json(),
    );
    expect(page.hero).toBeNull();
    expect(
      page.blocks.map((block) => (block.kind === 'banner' ? block.banner.id : block.collection.id)),
    ).toEqual([ourBanner]);
  });

  it('keeps each workspace’s Terms page its own', async () => {
    const ourTerms = storefrontPageSchema.parse(
      (await send(nirvor, 'GET', '/storefront/pages/terms')).json(),
    );
    expect([ourTerms.version, ourTerms.sections]).toEqual([null, []]);
    expect(await answer('DELETE', '/storefront/pages/terms?version=1')).toMatchObject({
      status: 404,
    });
    // Our first save is a first save: their row does not make it a conflict
    const res = await send(nirvor, 'PUT', '/storefront/pages/terms', {
      version: null,
      sections: [{ heading: 'Nirvor terms', body: 'Retail only.' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const theirTerms = storefrontPageSchema.parse(
      (await send(acme, 'GET', '/storefront/pages/terms')).json(),
    );
    expect(theirTerms).toMatchObject({
      version: 1,
      sections: [{ heading: 'Acme terms', body: 'Wholesale only.' }],
    });
  });
});
