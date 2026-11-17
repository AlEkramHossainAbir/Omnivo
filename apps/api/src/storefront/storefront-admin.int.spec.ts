import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Problem,
  problemSchema,
  productSchema,
  roleListSchema,
  setupSchema,
  storefrontCandidatePageSchema,
  type StorefrontCategory,
  storefrontCategoryListSchema,
  storefrontCategorySchema,
  type StorefrontListing,
  type StorefrontListingFormValues,
  storefrontListingPageSchema,
  storefrontListingSchema,
  type StorefrontSettings,
  type StorefrontSettingsFormValues,
  storefrontSettingsSchema,
  storefrontSetupSchema,
  storefrontUploadSchema,
  storefrontUploadTicketSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { jpegOf, photoSettled, readyPhoto, sendPhoto } from '../testing/shop-photo.js';
import { createProduct, tenantIdOf } from '../testing/storefront.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 26g: the Storefront menu's API, as the screens use it, against a real database, storage
// and worker: the shop's settings and its launch, the categories, a photo through the image job,
// and the listings from "Add to shop" to the shop showing them. The describes run in order and
// build one shop, like a person setting it up for the first time.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let viewer: SignedIn;
let tenantId: string;
let warehouseId: string;
let pcs: string;

const UNKNOWN = '00000000-0000-4000-8000-000000000001';

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

// The answer of a refused request, with its status checked first: a 500 would also parse
async function refused(
  response: Promise<{ statusCode: number; body: string; json: () => unknown }>,
  status: number,
): Promise<Problem> {
  const res = await response;
  expect(res.statusCode, res.body).toBe(status);
  return problemSchema.parse(res.json());
}

// The settings form as a person fills it in on the first save
const FIRST_SAVE: Omit<StorefrontSettingsFormValues, 'version'> = {
  subdomain: 'nirvor',
  name: 'Nirvor Pharmacy',
  language: 'en',
  hotline: '09612-000000',
  address: 'Mirpur 10, Dhaka',
  facebookUrl: '',
  instagramUrl: '',
  xUrl: '',
  linkedinUrl: '',
  defaultWarehouseId: '',
  deliveryZones: [{ id: null, name: 'Inside Dhaka', charge: '80' }],
  freeDeliveryFrom: '1000',
  minimumOrder: '',
  paymentMethods: ['cod'],
};

// The form again from a saved shop, the way the settings page fills its boxes from the answer
function formOf(shop: StorefrontSettings): StorefrontSettingsFormValues {
  return {
    ...FIRST_SAVE,
    subdomain: shop.subdomain,
    defaultWarehouseId: shop.defaultWarehouseId ?? '',
    deliveryZones: shop.deliveryZones.map((zone) => ({ ...zone })),
    freeDeliveryFrom: shop.freeDeliveryFrom ?? '',
    minimumOrder: shop.minimumOrder ?? '',
    version: shop.version,
  };
}

// The listing editor's form from a saved listing. images: only {id, alt}, as the editor keeps them
function editorOf(listing: StorefrontListing): StorefrontListingFormValues {
  return {
    version: listing.version,
    name: listing.name,
    slug: listing.slug,
    packSize: listing.packSize,
    categoryId: listing.categoryId,
    priceOverride: listing.priceOverride ?? '',
    sale: listing.sale,
    badges: listing.badges,
    images: listing.images.map(({ id, alt }) => ({ id, alt })),
    descriptionSections: listing.descriptionSections,
    seoTitle: listing.seoTitle ?? '',
    seoDescription: listing.seoDescription ?? '',
  };
}

async function shopNow(): Promise<StorefrontSettings> {
  const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
  if (setup.shop === null) throw new Error('The shop is not set up');
  return setup.shop;
}

async function categories(): Promise<StorefrontCategory[]> {
  return storefrontCategoryListSchema.parse((await send('GET', '/storefront/categories')).json())
    .items;
}

async function categoryNow(id: string): Promise<StorefrontCategory> {
  const found = (await categories()).find((category) => category.id === id);
  if (found === undefined) throw new Error(`No category ${id}`);
  return found;
}

async function addCategory(name: string, parentId = '', slug = ''): Promise<StorefrontCategory> {
  const res = await send('POST', '/storefront/categories', { name, slug, parentId });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCategorySchema.parse(res.json());
}

async function addListing(variantId: string, categoryId: string): Promise<StorefrontListing> {
  const res = await send('POST', '/storefront/listings', { variantId, categoryId });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontListingSchema.parse(res.json());
}

async function saveListing(
  listing: StorefrontListing,
  changes: Partial<StorefrontListingFormValues>,
): Promise<StorefrontListing> {
  const res = await send('PUT', `/storefront/listings/${listing.id}`, {
    ...editorOf(listing),
    ...changes,
  });
  expect(res.statusCode, res.body).toBe(200);
  return storefrontListingSchema.parse(res.json());
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  // The worker runs the outbox, so the setup job and the image job happen as in production
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
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
  expect((await send('POST', '/setup', { industry: 'retail' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  }, 20_000);
  warehouseId =
    warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items[0]?.id ?? '';
  pcs =
    unitListSchema.parse((await send('GET', '/units')).json()).items.find((u) => u.code === 'pcs')
      ?.id ?? '';
  tenantId = await tenantIdOf(sql, 'nirvor');

  // A member with no role: signed in to the workspace, allowed nothing
  await signUp(app, {
    companyName: 'Sumi Store',
    workspaceSlug: 'sumi-store',
    fullName: 'Sumi Akter',
    email: 'sumi@nirvor.com',
    password: 'Sumi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, { email: 'sumi@nirvor.com', workspace: 'nirvor' });
  viewer = await logIn(app, {
    workspace: 'nirvor',
    email: 'sumi@nirvor.com',
    password: 'Sumi-store-2026',
    keepSignedIn: false,
  });
}, 180_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), storage.container.stop()]);
});

describe('who may run the shop', () => {
  it('refuses every Storefront route to a member without storefront.manage', async () => {
    for (const [method, url] of [
      ['GET', '/storefront/settings'],
      ['GET', '/storefront/categories'],
      ['GET', '/storefront/listings'],
      ['GET', '/storefront/candidates'],
      ['POST', '/storefront/images'],
    ] as const) {
      const res = await send(method, url, method === 'POST' ? {} : undefined, viewer);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('gives the retail template’s Shop manager the permission', async () => {
    const roles = roleListSchema.parse((await send('GET', '/roles')).json()).items;
    const manager = roles.find((role) => role.name === 'Shop manager');
    expect(manager?.permissions).toContain('storefront.manage');
  });
});

describe('the settings', () => {
  it('suggests the workspace’s own name and slug before the first save', async () => {
    const res = await send('GET', '/storefront/settings');
    expect(res.statusCode, res.body).toBe(200);
    const setup = storefrontSetupSchema.parse(res.json());
    expect(setup.shop).toBeNull();
    expect(setup.baseDomain).toBe('localhost');
    expect(setup.suggested).toMatchObject({ subdomain: 'nirvor', name: 'Nirvor Pharmacy' });
  });

  it('needs the settings before anything goes into the shop', async () => {
    const problem = await refused(
      send('POST', '/storefront/listings', { variantId: UNKNOWN, categoryId: UNKNOWN }),
      409,
    );
    expect(problem.code).toBe('storefront_not_set_up');
    const update = await refused(
      send('PUT', '/storefront/settings', { ...FIRST_SAVE, version: 1 }),
      409,
    );
    expect(update.code).toBe('storefront_not_set_up');
  });

  it('refuses a reserved address and a warehouse that is not the workspace’s', async () => {
    const reserved = await refused(
      send('POST', '/storefront/settings', { ...FIRST_SAVE, subdomain: 'admin' }),
      400,
    );
    expect(reserved.fieldErrors).toEqual({ subdomain: ['storefront_subdomain_reserved'] });
    const warehouse = await refused(
      send('POST', '/storefront/settings', { ...FIRST_SAVE, defaultWarehouseId: UNKNOWN }),
      409,
    );
    expect(warehouse.code).toBe('storefront_warehouse_invalid');
    expect(warehouse.fieldErrors).toEqual({ defaultWarehouseId: ['storefront_warehouse_invalid'] });
  });

  it('makes the shop on the first save, and only once', async () => {
    const res = await send('POST', '/storefront/settings', FIRST_SAVE);
    expect(res.statusCode, res.body).toBe(201);
    const shop = storefrontSettingsSchema.parse(res.json());
    expect(shop).toMatchObject({
      subdomain: 'nirvor',
      shopUrl: 'http://nirvor.localhost:4321',
      freeDeliveryFrom: '1000.0000',
      minimumOrder: null,
      launchedAt: null,
      readiness: { warehouse: false, zone: true, listing: false },
      version: 1,
    });
    // The API names a new zone, and keeps the charge with 4 decimals like every amount
    const [zone] = shop.deliveryZones;
    expect(zone?.id).toMatch(/^zone-[0-9a-f]{8}$/);
    expect(shop.deliveryZones).toEqual([{ id: zone?.id, name: 'Inside Dhaka', charge: '80.0000' }]);
    // A second first save (another tab) does not overwrite the first
    const again = await refused(send('POST', '/storefront/settings', FIRST_SAVE), 409);
    expect(again.code).toBe('storefront_set_up_already');
  });

  it('keeps a saved zone’s id, names new ones, and keeps an id sent twice once', async () => {
    const before = await shopNow();
    const inside = before.deliveryZones[0]?.id ?? '';
    const res = await send('PUT', '/storefront/settings', {
      ...formOf(before),
      defaultWarehouseId: warehouseId,
      deliveryZones: [
        { id: inside, name: 'Dhaka city', charge: '60' },
        { id: inside, name: 'Savar', charge: '0' },
        { id: 'zone-made-up', name: 'Outside Dhaka', charge: '120' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const shop = storefrontSettingsSchema.parse(res.json());
    const [city, savar, outside] = shop.deliveryZones;
    expect(city).toEqual({ id: inside, name: 'Dhaka city', charge: '60.0000' });
    expect(savar?.charge).toBe('0.0000');
    expect(new Set([inside, savar?.id, outside?.id]).size).toBe(3);
    expect(outside?.id).not.toBe('zone-made-up');
    expect(shop.readiness).toEqual({ warehouse: true, zone: true, listing: false });
    expect(shop.version).toBe(before.version + 1);
  });

  it('refuses a save from a stale form', async () => {
    const shop = await shopNow();
    const problem = await refused(
      send('PUT', '/storefront/settings', { ...formOf(shop), version: shop.version - 1 }),
      409,
    );
    expect(problem.code).toBe('version_conflict');
  });

  it('does not open the shop before it has a published listing', async () => {
    const shop = await shopNow();
    const problem = await refused(
      send('POST', '/storefront/settings/launch', { version: shop.version }),
      409,
    );
    expect(problem.code).toBe('storefront_launch_not_ready');
  });
});

describe('the categories', () => {
  it('makes the slug from the name and puts a new category last', async () => {
    const skin = await addCategory('Skin care');
    const drinks = await addCategory('Beverages');
    const face = await addCategory('Face wash', skin.id);
    expect([skin.slug, drinks.slug, face.slug]).toEqual(['skin-care', 'beverages', 'face-wash']);
    expect([skin.position, drinks.position, face.position]).toEqual([1, 2, 1]);
    expect(face.parentId).toBe(skin.id);
  });

  it('asks for a slug when the name has no Latin letter', async () => {
    const problem = await refused(
      send('POST', '/storefront/categories', { name: 'শিশুর যত্ন', slug: '', parentId: '' }),
      400,
    );
    expect(problem.fieldErrors).toEqual({ slug: ['storefront_slug_required'] });
    const baby = await addCategory('শিশুর যত্ন', '', 'baby-care');
    expect(baby.slug).toBe('baby-care');
  });

  it('refuses a taken slug, a taken name in the same place and a parent it does not have', async () => {
    const slug = await refused(
      send('POST', '/storefront/categories', { name: 'Skin', slug: 'skin-care', parentId: '' }),
      409,
    );
    expect(slug.code).toBe('storefront_slug_taken');
    const name = await refused(
      send('POST', '/storefront/categories', { name: 'skin CARE', slug: 'skin-2', parentId: '' }),
      409,
    );
    expect(name.code).toBe('category_name_taken');
    const parent = await refused(
      send('POST', '/storefront/categories', { name: 'Toner', slug: '', parentId: UNKNOWN }),
      409,
    );
    expect(parent.code).toBe('category_parent_invalid');
  });

  it('renames a category and moves it under another, to the end of that list', async () => {
    const baby = (await categories()).find((category) => category.slug === 'baby-care');
    const skin = (await categories()).find((category) => category.slug === 'skin-care');
    if (!baby || !skin) throw new Error('Categories missing');
    let res = await send('PUT', `/storefront/categories/${baby.id}`, {
      name: 'Baby care',
      slug: '',
      parentId: skin.id,
      version: baby.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    // An empty slug is made from the new name; Face wash is first under Skin care, so 2
    expect(storefrontCategorySchema.parse(res.json())).toMatchObject({
      name: 'Baby care',
      slug: 'baby-care',
      parentId: skin.id,
      position: 2,
      version: baby.version + 1,
    });
    // And back to the top level, last there
    const moved = await categoryNow(baby.id);
    res = await send('PUT', `/storefront/categories/${baby.id}`, {
      name: moved.name,
      slug: moved.slug,
      parentId: '',
      version: moved.version,
    });
    expect(storefrontCategorySchema.parse(res.json()).position).toBe(3);
  });

  it('does not put a category under itself', async () => {
    const all = await categories();
    const skin = all.find((category) => category.slug === 'skin-care');
    const face = all.find((category) => category.slug === 'face-wash');
    if (!skin || !face) throw new Error('Categories missing');
    const problem = await refused(
      send('PUT', `/storefront/categories/${skin.id}`, {
        name: skin.name,
        slug: skin.slug,
        parentId: face.id,
        version: skin.version,
      }),
      409,
    );
    expect(problem.code).toBe('category_parent_loop');
  });

  it('swaps a category with its neighbour, and does nothing at the top', async () => {
    const before = await categories();
    const drinks = before.find((category) => category.slug === 'beverages');
    if (!drinks) throw new Error('No Beverages');
    const res = await send('POST', `/storefront/categories/${drinks.id}/move`, {
      direction: 'up',
      version: drinks.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = storefrontCategoryListSchema.parse(res.json()).items;
    const top = after.filter((category) => category.parentId === null);
    expect(top.map((category) => category.slug)).toEqual(['beverages', 'skin-care', 'baby-care']);
    // Both rows that changed place have a new version: a form open on either one knows
    const moved = after.find((category) => category.id === drinks.id);
    expect(moved?.version).toBe(drinks.version + 1);

    // Already first: the same list, nothing written
    const again = await send('POST', `/storefront/categories/${drinks.id}/move`, {
      direction: 'up',
      version: moved?.version,
    });
    expect(storefrontCategoryListSchema.parse(again.json()).items).toEqual(after);
    // And a click from a stale list is refused
    const stale = await refused(
      send('POST', `/storefront/categories/${drinks.id}/move`, {
        direction: 'down',
        version: drinks.version,
      }),
      409,
    );
    expect(stale.code).toBe('version_conflict');
  });

  it('keeps a category that still has sub-categories', async () => {
    const skin = (await categories()).find((category) => category.slug === 'skin-care');
    if (!skin) throw new Error('No Skin care');
    const problem = await refused(
      send('DELETE', `/storefront/categories/${skin.id}?version=${String(skin.version)}`),
      409,
    );
    expect(problem.code).toBe('category_has_children');
  });
});

describe('the photos', () => {
  it('has its own upload route: the general one refuses a shop photo', async () => {
    const res = await send('POST', '/attachments', {
      purpose: 'storefront_image',
      fileName: 'neem.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a type or a size the shop does not take before the upload', async () => {
    const problem = await refused(
      send('POST', '/storefront/images', {
        fileName: 'neem.gif',
        contentType: 'image/gif',
        sizeBytes: 9 * 1024 * 1024,
      }),
      400,
    );
    expect(problem.fieldErrors).toEqual({
      contentType: ['file_type_not_allowed'],
      sizeBytes: ['storefront_image_file_too_large'],
    });
  });

  it('does not confirm a photo whose file never arrived', async () => {
    const res = await send('POST', '/storefront/images', {
      fileName: 'neem.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 5000,
    });
    const ticket = storefrontUploadTicketSchema.parse(res.json());
    expect(ticket.image).toEqual({ id: ticket.image.id, status: 'uploading' });
    const problem = await refused(
      send('POST', `/storefront/images/${ticket.image.id}/complete`),
      409,
    );
    expect(problem.code).toBe('upload_incomplete');
    // Still waiting for its file: no job was started
    const now = storefrontUploadSchema.parse(
      (await send('GET', `/storefront/images/${ticket.image.id}`)).json(),
    );
    expect(now.status).toBe('uploading');
  });

  it('turns a phone photo upright and makes three public WebP files without its metadata', async () => {
    // 1600 × 1200 with "turn a quarter right": a shopper sees it 1200 × 1600
    const id = await sendPhoto(app, owner, await jpegOf(1600, 1200, 6));
    const ready = await photoSettled(app, owner, id);
    if (ready.status !== 'ready') throw new Error(`The photo ${ready.status}`);
    expect([ready.width, ready.height]).toEqual([1200, 1600]);
    expect(ready.url).toMatch(new RegExp(`/storefront/${id}/small\\.webp$`));

    // small is 480 wide; large and wide stay 1200, the photo's own width: never enlarged
    for (const [size, width] of [
      ['small', 480],
      ['large', 1200],
      ['wide', 1200],
    ] as const) {
      const file = await fetch(ready.url.replace('small.webp', `${size}.webp`));
      expect(file.status, size).toBe(200);
      expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
      expect([meta.format, meta.width, meta.exif], size).toEqual(['webp', width, undefined]);
    }

    // The original stays in the workspace's private folder, out of the shop's reach and out of
    // the general attachment routes
    const [row] = await sql`SELECT storage_key FROM attachments WHERE id = ${id}`;
    expect((await fetch(`${storage.url}/omnivo/${String(row?.storage_key)}`)).status).toBe(403);
    expect((await send('GET', `/attachments/${id}/download`)).statusCode).toBe(404);

    // A second confirm (a retry after a lost answer) starts no second job
    const again = await send('POST', `/storefront/images/${id}/complete`);
    expect(storefrontUploadSchema.parse(again.json()).status).toBe('ready');
    const [jobs] = await sql`
      SELECT count(*)::int AS n FROM outbox_events
       WHERE type = 'storefront.image_uploaded' AND payload->>'imageId' = ${id}`;
    expect(jobs?.n).toBe(1);
  });

  it('marks a photo failed with the reason: too small, or not a picture', async () => {
    const tiny = await sendPhoto(
      app,
      owner,
      await sharp({
        create: { width: 150, height: 150, channels: 3, background: '#005859' },
      })
        .png()
        .toBuffer(),
      'image/png',
    );
    const text = await sendPhoto(app, owner, Buffer.from('just some text'), 'image/png');
    expect(await photoSettled(app, owner, tiny)).toEqual({
      id: tiny,
      status: 'failed',
      code: 'storefront_image_too_small',
    });
    expect(await photoSettled(app, owner, text)).toEqual({
      id: text,
      status: 'failed',
      code: 'storefront_image_unreadable',
    });
  });

  it('knows no photo it was never sent', async () => {
    expect((await send('GET', `/storefront/images/${UNKNOWN}`)).statusCode).toBe(404);
    expect((await send('POST', `/storefront/images/${UNKNOWN}/complete`)).statusCode).toBe(404);
  });
});

describe('the listings', () => {
  let face: StorefrontCategory;
  let drinks: StorefrontCategory;
  let neem: StorefrontListing;
  let photo: string;

  beforeAll(async () => {
    const all = await categories();
    const find = (slug: string) => {
      const found = all.find((category) => category.slug === slug);
      if (!found) throw new Error(slug);
      return found;
    };
    face = find('face-wash');
    drinks = find('beverages');
    photo = await readyPhoto(app, owner);
  }, 60_000);

  it('offers the active goods that are not in the shop yet', async () => {
    await createProduct(app, owner, pcs, 'Neem Face Wash', '299');
    await createProduct(app, owner, pcs, 'Neem Face Wash', '499', 'NEEMFACEWASH-L');
    await createProduct(app, owner, pcs, 'Green Tea', '');
    await createProduct(app, owner, pcs, 'নিম সাবান', '60', 'NEEM-SOAP');
    const res = await send('GET', '/storefront/candidates?search=neem');
    expect(res.statusCode, res.body).toBe(200);
    const page = storefrontCandidatePageSchema.parse(res.json());
    // The search matches the SKU too, so the Bangla soap is found by "neem"
    expect(page.items.map((item) => item.sku).sort()).toEqual([
      'NEEM-SOAP',
      'NEEMFACEWASH',
      'NEEMFACEWASH-L',
    ]);
  });

  it('adds a variant as a draft, with a free slug from its name or its SKU', async () => {
    const page = storefrontCandidatePageSchema.parse(
      (await send('GET', '/storefront/candidates?search=neem')).json(),
    );
    const variant = (sku: string) => page.items.find((item) => item.sku === sku)?.variantId ?? '';
    neem = await addListing(variant('NEEMFACEWASH'), face.id);
    expect(neem).toMatchObject({
      slug: 'neem-face-wash',
      name: 'Neem Face Wash',
      status: 'draft',
      images: [],
      inStock: false,
      shopUrl: 'http://nirvor.localhost:4321/p/neem-face-wash',
      version: 1,
    });
    const large = await addListing(variant('NEEMFACEWASH-L'), face.id);
    expect(large.slug).toBe('neem-face-wash-2');
    const soap = await addListing(variant('NEEM-SOAP'), face.id);
    expect(soap.slug).toBe('neem-soap');

    // Listed: out of the "Add to shop" box, and refused a second time
    const after = storefrontCandidatePageSchema.parse(
      (await send('GET', '/storefront/candidates?search=neem')).json(),
    );
    expect(after.items).toEqual([]);
    const twice = await refused(
      send('POST', '/storefront/listings', {
        variantId: variant('NEEMFACEWASH'),
        categoryId: face.id,
      }),
      409,
    );
    expect(twice.fieldErrors).toEqual({ variantId: ['storefront_variant_listed'] });
  });

  it('refuses a variant or a category it does not know', async () => {
    const variant = await refused(
      send('POST', '/storefront/listings', { variantId: UNKNOWN, categoryId: face.id }),
      409,
    );
    expect(variant.fieldErrors).toEqual({ variantId: ['required'] });
    const tea = storefrontCandidatePageSchema.parse(
      (await send('GET', '/storefront/candidates?search=green')).json(),
    ).items[0];
    const category = await refused(
      send('POST', '/storefront/listings', { variantId: tea?.variantId, categoryId: UNKNOWN }),
      409,
    );
    expect(category.fieldErrors).toEqual({ categoryId: ['storefront_category_invalid'] });
  });

  it('checks a sale against the price it is for', async () => {
    const tooMuch = await refused(
      send('PUT', `/storefront/listings/${neem.id}`, {
        ...editorOf(neem),
        sale: { kind: 'amount', value: '400', startsAt: null, endsAt: null },
      }),
      409,
    );
    expect(tooMuch.fieldErrors).toEqual({ 'sale.value': ['storefront_sale_not_lower'] });
    // A sale that starts next week must already be lower: the dates do not matter
    const later = await refused(
      send('PUT', `/storefront/listings/${neem.id}`, {
        ...editorOf(neem),
        sale: {
          kind: 'price',
          value: '350',
          startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          endsAt: null,
        },
      }),
      409,
    );
    expect(later.code).toBe('storefront_sale_not_lower');
  });

  it('saves only photos that are this workspace’s and ready, each error on its own box', async () => {
    const failed = await sendPhoto(app, owner, Buffer.from('not a photo'), 'image/png');
    expect((await photoSettled(app, owner, failed)).status).toBe('failed');
    const problem = await refused(
      send('PUT', `/storefront/listings/${neem.id}`, {
        ...editorOf(neem),
        images: [
          { id: photo, alt: 'Neem face wash tube' },
          { id: failed, alt: 'Broken' },
          { id: UNKNOWN, alt: 'Made up' },
        ],
      }),
      409,
    );
    expect(problem.code).toBe('storefront_image_not_ready');
    expect(problem.fieldErrors).toEqual({
      'images.1': ['storefront_image_not_ready'],
      'images.2': ['storefront_image_not_ready'],
    });
    // The same photo twice is the form's mistake, said before the API looks
    const twice = await refused(
      send('PUT', `/storefront/listings/${neem.id}`, {
        ...editorOf(neem),
        images: [
          { id: photo, alt: 'Front' },
          { id: photo, alt: 'Front again' },
        ],
      }),
      400,
    );
    expect(twice.fieldErrors).toEqual({ 'images.1': ['storefront_image_twice'] });
  });

  it('saves the whole editor, and its answer goes back as the next save unchanged', async () => {
    neem = await saveListing(neem, {
      slug: '',
      packSize: '150ml',
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: null },
      badges: ['new', 'most_picked', 'new'],
      images: [{ id: photo, alt: 'Neem face wash tube' }],
      descriptionSections: [{ heading: 'Key benefits', body: '- Controls **oil**' }],
    });
    expect(neem).toMatchObject({
      slug: 'neem-face-wash',
      packSize: '150ml',
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: null },
      seoTitle: null,
      version: 2,
    });
    // Each badge once, in the shop's order (SHOP_BADGES), whatever order the boxes were ticked in
    expect(neem.badges).toEqual(['most_picked', 'new']);
    // The editor's thumbnail is the small file
    expect(neem.images.map(({ id, alt }) => ({ id, alt }))).toEqual([
      { id: photo, alt: 'Neem face wash tube' },
    ]);
    expect(neem.images[0]?.url).toMatch(new RegExp(`/storefront/${photo}/small\\.webp$`));
    const again = await saveListing(neem, {});
    expect(again.version).toBe(neem.version + 1);
    expect({ ...again, version: 0, updatedAt: '' }).toEqual({ ...neem, version: 0, updatedAt: '' });
    neem = again;
  });

  it('publishes a listing only with a photo and a price', async () => {
    const tea = await addListing(
      storefrontCandidatePageSchema.parse(
        (await send('GET', '/storefront/candidates?search=green')).json(),
      ).items[0]?.variantId ?? '',
      drinks.id,
    );
    const noPhoto = await refused(
      send('POST', `/storefront/listings/${tea.id}/publish`, { version: tea.version }),
      409,
    );
    expect(noPhoto.code).toBe('storefront_listing_needs_photo');
    const withPhoto = await saveListing(tea, { images: [{ id: photo, alt: 'Green tea box' }] });
    const noPrice = await refused(
      send('POST', `/storefront/listings/${tea.id}/publish`, { version: withPhoto.version }),
      409,
    );
    expect(noPrice.code).toBe('storefront_listing_no_price');
    // A sale needs a price to come off
    const sale = await refused(
      send('PUT', `/storefront/listings/${tea.id}`, {
        ...editorOf(withPhoto),
        sale: { kind: 'percent', value: '5', startsAt: null, endsAt: null },
      }),
      409,
    );
    expect(sale.fieldErrors).toEqual({ priceOverride: ['storefront_listing_no_price'] });
    const priced = await saveListing(withPhoto, { priceOverride: '120' });
    const res = await send('POST', `/storefront/listings/${tea.id}/publish`, {
      version: priced.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(storefrontListingSchema.parse(res.json()).status).toBe('published');
  });

  it('publishes, and a second click changes nothing', async () => {
    let res = await send('POST', `/storefront/listings/${neem.id}/publish`, {
      version: neem.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const published = storefrontListingSchema.parse(res.json());
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();
    res = await send('POST', `/storefront/listings/${neem.id}/publish`, {
      version: published.version,
    });
    expect(storefrontListingSchema.parse(res.json()).version).toBe(published.version);
    neem = published;
  });

  it('keeps a published listing sellable: its last photo stays', async () => {
    const photo0 = await refused(
      send('PUT', `/storefront/listings/${neem.id}`, { ...editorOf(neem), images: [] }),
      409,
    );
    expect(photo0.fieldErrors).toEqual({ images: ['storefront_listing_needs_photo'] });
  });

  it('opens the shop once everything is ready, and the shop shows it', async () => {
    let shop = await shopNow();
    expect(shop.readiness).toEqual({ warehouse: true, zone: true, listing: true });
    let res = await send('POST', '/storefront/settings/launch', { version: shop.version });
    expect(res.statusCode, res.body).toBe(200);
    shop = storefrontSettingsSchema.parse(res.json());
    expect(shop.launchedAt).not.toBeNull();
    // A second click: open already, nothing written
    res = await send('POST', '/storefront/settings/launch', { version: shop.version });
    expect(storefrontSettingsSchema.parse(res.json())).toEqual(shop);

    const cards = await app.inject({
      method: 'GET',
      url: '/public/v1/listings',
      headers: { 'x-shop-host': 'nirvor.localhost:4331' },
    });
    expect(cards.statusCode, cards.body).toBe(200);
    expect(cards.body).toContain('Neem Face Wash');
    // Drafts stay out of the shop
    expect(cards.body).not.toContain('neem-face-wash-2');
  });

  it('keeps an open shop’s warehouse and zones', async () => {
    const shop = await shopNow();
    const warehouse = await refused(
      send('PUT', '/storefront/settings', { ...formOf(shop), defaultWarehouseId: '' }),
      409,
    );
    expect(warehouse.code).toBe('storefront_warehouse_invalid');
    const zones = await refused(
      send('PUT', '/storefront/settings', { ...formOf(shop), deliveryZones: [] }),
      409,
    );
    expect(zones.fieldErrors).toEqual({ deliveryZones: ['too_short'] });
  });

  it('moves the shop to a new address: the old one stops working', async () => {
    const res = await send('PUT', '/storefront/settings', {
      ...formOf(await shopNow()),
      subdomain: 'nirvor-bd',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(storefrontSettingsSchema.parse(res.json()).shopUrl).toBe(
      'http://nirvor-bd.localhost:4321',
    );
    const at = (host: string) =>
      app.inject({ method: 'GET', url: '/public/v1/shop', headers: { 'x-shop-host': host } });
    expect((await at('nirvor-bd.localhost')).statusCode).toBe(200);
    const old = await at('nirvor.localhost');
    expect(problemSchema.parse(old.json()).code).toBe('storefront_not_found');
  });

  it('refuses to publish a listing whose product was archived in the ERP', async () => {
    const page = storefrontListingPageSchema.parse(
      (await send('GET', '/storefront/listings?search=neem-face-wash-2')).json(),
    );
    const id = page.items[0]?.id ?? '';
    let large = storefrontListingSchema.parse(
      (await send('GET', `/storefront/listings/${id}`)).json(),
    );
    large = await saveListing(large, { images: [{ id: photo, alt: 'Large tube' }] });
    const product = await send('GET', `/products/${large.product.id}`);
    const archive = await send('POST', `/products/${large.product.id}/archive`, {
      version: productSchema.parse(product.json()).version,
    });
    expect(archive.statusCode, archive.body).toBe(200);
    const problem = await refused(
      send('POST', `/storefront/listings/${id}/publish`, { version: large.version }),
      409,
    );
    expect(problem.code).toBe('storefront_variant_archived');
  });

  it('lists the catalog: search, status, category, stock, sorts and pages', async () => {
    // Stock in the shop's warehouse for the face wash only
    await sql`
      INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
      VALUES (${tenantId}, ${warehouseId}, ${neem.product.id}, ${neem.variant.id}, 12)`;
    const list = async (query: string) => {
      const res = await send('GET', `/storefront/listings?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return storefrontListingPageSchema.parse(res.json());
    };

    const published = await list('status=published&search=NEEM');
    expect(
      published.items.map((l) => [l.name, l.price, l.compareAtPrice, l.inStock, l.status]),
    ).toEqual([['Neem Face Wash', '269.1000', '299.0000', true, 'published']]);
    // By SKU, and by category (only that category, not the ones under it)
    expect((await list('search=neem-soap')).items.map((l) => l.sku)).toEqual(['NEEM-SOAP']);
    expect((await list(`categoryId=${drinks.id}`)).items.map((l) => l.name)).toEqual(['Green Tea']);
    const drafts = await list('status=draft&sort=name');
    expect(drafts.items.map((l) => l.status)).toEqual(['draft', 'draft']);
    expect(drafts.items.every((l) => l.inStock === false)).toBe(true);

    // Every sort pages through all four, one at a time, each listing once
    for (const sort of ['-updated', 'name', '-name']) {
      const seen: string[] = [];
      let cursor = '';
      do {
        const page = await list(`sort=${sort}&limit=1${cursor && `&cursor=${cursor}`}`);
        seen.push(...page.items.map((l) => l.id));
        cursor = page.nextCursor ?? '';
      } while (cursor !== '');
      expect(new Set(seen).size, sort).toBe(4);
      expect(seen, sort).toHaveLength(4);
    }
    // A to Z by the name without case; Z to A the other way round
    const names = (await list('sort=name')).items.map((l) => l.name);
    expect(names.slice(0, 3)).toEqual(['Green Tea', 'Neem Face Wash', 'Neem Face Wash']);
    expect((await list('sort=-name')).items.map((l) => l.name)).toEqual([...names].reverse());
    // A cursor from another sort is not a place in this list
    const byName = await list('sort=name&limit=1');
    const wrong = await send(
      'GET',
      `/storefront/listings?sort=-updated&cursor=${byName.nextCursor ?? ''}`,
    );
    expect(problemSchema.parse(wrong.json()).code).toBe('invalid_cursor');
  });

  it('deletes a listing, then its category', async () => {
    const problem = await refused(
      send(
        'DELETE',
        `/storefront/categories/${drinks.id}?version=${String((await categoryNow(drinks.id)).version)}`,
      ),
      409,
    );
    expect(problem.code).toBe('storefront_category_in_use');
    const teaListing = storefrontListingPageSchema.parse(
      (await send('GET', `/storefront/listings?categoryId=${drinks.id}`)).json(),
    ).items[0];
    const full = storefrontListingSchema.parse(
      (await send('GET', `/storefront/listings/${teaListing?.id ?? ''}`)).json(),
    );
    // Unpublished first, the way a person takes it out of the shop before deleting it
    const unpublished = await send('POST', `/storefront/listings/${full.id}/unpublish`, {
      version: full.version,
    });
    expect(unpublished.statusCode, unpublished.body).toBe(200);
    const draft = storefrontListingSchema.parse(unpublished.json());
    expect([draft.status, draft.publishedAt]).toEqual(['draft', null]);
    const stale = await refused(
      send('DELETE', `/storefront/listings/${full.id}?version=${String(full.version)}`),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    let res = await send(
      'DELETE',
      `/storefront/listings/${full.id}?version=${String(draft.version)}`,
    );
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/storefront/listings/${full.id}`)).statusCode).toBe(404);
    res = await send(
      'DELETE',
      `/storefront/categories/${drinks.id}?version=${String((await categoryNow(drinks.id)).version)}`,
    );
    expect(res.statusCode, res.body).toBe(204);
  });

  it('wrote every change to the audit log', async () => {
    const rows = await sql`
      SELECT DISTINCT action FROM audit_logs
       WHERE tenant_id = ${tenantId} AND entity_type LIKE 'storefront%'`;
    expect(rows.map((row) => String(row.action)).sort()).toEqual([
      'storefront.created',
      'storefront.launched',
      'storefront.updated',
      'storefront_category.created',
      'storefront_category.deleted',
      'storefront_category.moved',
      'storefront_category.updated',
      'storefront_listing.created',
      'storefront_listing.deleted',
      'storefront_listing.published',
      'storefront_listing.unpublished',
      'storefront_listing.updated',
    ]);
  });
});
