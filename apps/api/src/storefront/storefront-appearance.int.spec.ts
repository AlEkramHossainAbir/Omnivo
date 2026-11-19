import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Problem,
  problemSchema,
  publicShopSchema,
  setupSchema,
  shopHomeSchema,
  shopTextPageSchema,
  STOREFRONT_HERO_DEFAULT_COLORS,
  storefrontAppearanceSchema,
  storefrontBannerSchema,
  type StorefrontCollection,
  storefrontCollectionSchema,
  type StorefrontHeroFormValues,
  storefrontHeroSchema,
  type StorefrontHomeBlock,
  storefrontHomeBlockListSchema,
  type StorefrontListing,
  storefrontListingSchema,
  storefrontPageListSchema,
  storefrontPageSchema,
  type StorefrontSettings,
  storefrontSetupSchema,
  storefrontThemeSchema,
  storefrontUploadTicketSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { readyPhoto } from '../testing/shop-photo.js';
import { createProduct, tenantIdOf, variantOf } from '../testing/storefront.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 26h: the Appearance page and the text pages, as the screens use them, against a real
// database, storage and worker: the logo and the colors, the hero, the picture banners and the
// collections in the home page's order, the limits and the races at them, and the four pages. The
// describes run in order and build one shop; each change is then read back from the shop's own
// public API, because that is where a shopper sees it.
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

// Two ready photos (the job made their files), and one whose upload never finished
let photo: string;
let wide: string;
let pending: string;
// Neem and tea are published; rose is a draft with no photo
let neem: StorefrontListing;
let tea: StorefrontListing;
let rose: StorefrontListing;

const UNKNOWN = '00000000-0000-4000-8000-000000000001';
const SHOP_HOST = { 'x-shop-host': 'nirvor.localhost:4331' };

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

// The shop's public API, as apps/shop calls it
function shop(url: string) {
  return app.inject({ method: 'GET', url, headers: SHOP_HOST });
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

// The Appearance page's one read
async function appearance() {
  const res = await send('GET', '/storefront/appearance');
  expect(res.statusCode, res.body).toBe(200);
  return storefrontAppearanceSchema.parse(res.json());
}

// The blocks as ids in the page's order: a banner's id or a collection's
function idsOf(blocks: readonly StorefrontHomeBlock[]): string[] {
  return blocks.map((block) => (block.kind === 'banner' ? block.banner.id : block.collection.id));
}

// The positions the table holds, to see the order has no gap: 1, 2, 3…
async function positions(): Promise<number[]> {
  const rows = z.array(z.object({ position: z.number() })).parse(
    await sql`SELECT position FROM storefront_home_blocks WHERE tenant_id = ${tenantId}
                 ORDER BY position`,
  );
  return rows.map((row) => row.position);
}

// 1, 2, … n: what positions() must be for n blocks
function oneTo(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index + 1);
}

async function settingsNow(): Promise<StorefrontSettings> {
  const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
  if (setup.shop === null) throw new Error('The shop is not set up');
  return setup.shop;
}

// A picture banner the way the dialog sends it
function bannerForm(alt: string) {
  return {
    href: '/c/all?offer=1',
    desktopImage: { id: wide, alt },
    phoneImage: { id: photo, alt },
  };
}

async function addBanner(alt: string) {
  const res = await send('POST', '/storefront/appearance/banners', bannerForm(alt));
  expect(res.statusCode, res.body).toBe(201);
  return storefrontBannerSchema.parse(res.json());
}

async function addCollection(title: string, listingIds: string[]): Promise<StorefrontCollection> {
  const res = await send('POST', '/storefront/appearance/collections', {
    title,
    icon: null,
    listingIds,
  });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCollectionSchema.parse(res.json());
}

// The hero form as a person fills it in: the Figma hero's colors, a link to a category
function heroForm(version: number | null): StorefrontHeroFormValues {
  return {
    version,
    href: '/c/skin-care',
    headline: 'Glow up this winter',
    line: '',
    eyebrow: 'Exclusive offer',
    buttonLabel: 'Shop now',
    desktopImage: { id: wide, alt: 'Neem face wash on a winter table' },
    phoneImage: { id: photo, alt: 'Neem face wash tube' },
    ...STOREFRONT_HERO_DEFAULT_COLORS,
  };
}

// A listing of a new product, saved with a photo and published, or left a draft
async function listed(
  name: string,
  price: string,
  categoryId: string,
  publish: boolean,
): Promise<StorefrontListing> {
  const product = await createProduct(app, owner, pcs, name, price);
  let res = await send('POST', '/storefront/listings', {
    variantId: variantOf(product),
    categoryId,
  });
  expect(res.statusCode, res.body).toBe(201);
  const draft = storefrontListingSchema.parse(res.json());
  if (!publish) return draft;
  res = await send('PUT', `/storefront/listings/${draft.id}`, {
    version: draft.version,
    name: draft.name,
    slug: draft.slug,
    packSize: '150ml',
    categoryId,
    priceOverride: '',
    sale: null,
    badges: [],
    images: [{ id: photo, alt: name }],
    descriptionSections: [],
    seoTitle: '',
    seoDescription: '',
  });
  expect(res.statusCode, res.body).toBe(200);
  const saved = storefrontListingSchema.parse(res.json());
  res = await send('POST', `/storefront/listings/${draft.id}/publish`, { version: saved.version });
  expect(res.statusCode, res.body).toBe(200);
  return storefrontListingSchema.parse(res.json());
}

beforeAll(async () => {
  [pg, redis, storage] = await Promise.all([startPostgres(), startRedis(), startStorage()]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  // The worker runs the outbox: the setup job, and the image job that makes the photos ready
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
  [photo, wide] = await Promise.all([readyPhoto(app, owner), readyPhoto(app, owner)]);
  // Described but never sent: the photo stays "uploading"
  const ticket = await send('POST', '/storefront/images', {
    fileName: 'banner.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1000,
  });
  expect(ticket.statusCode, ticket.body).toBe(201);
  pending = storefrontUploadTicketSchema.parse(ticket.json()).image.id;

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

// Every one of the 16 routes, with a body that passes the contract where it has one
function everyRoute(): [method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object][] {
  return [
    ['GET', '/storefront/appearance'],
    [
      'PUT',
      '/storefront/appearance/theme',
      { version: 1, logoImageId: null, brandColor: '#005859', accentColor: '#b8ef69' },
    ],
    ['PUT', '/storefront/appearance/hero', heroForm(null)],
    ['DELETE', '/storefront/appearance/hero?version=1'],
    ['POST', '/storefront/appearance/banners', bannerForm('Mega sale')],
    ['PUT', `/storefront/appearance/banners/${UNKNOWN}`, { ...bannerForm('Sale'), version: 1 }],
    ['DELETE', `/storefront/appearance/banners/${UNKNOWN}?version=1`],
    ['GET', `/storefront/appearance/collections/${UNKNOWN}`],
    [
      'POST',
      '/storefront/appearance/collections',
      { title: 'Hot', icon: 'fire', listingIds: [UNKNOWN] },
    ],
    [
      'PUT',
      `/storefront/appearance/collections/${UNKNOWN}`,
      { title: 'Hot', icon: null, listingIds: [UNKNOWN], version: 1 },
    ],
    ['DELETE', `/storefront/appearance/collections/${UNKNOWN}?version=1`],
    ['POST', '/storefront/appearance/home/move', { kind: 'banner', id: UNKNOWN, direction: 'up' }],
    ['GET', '/storefront/pages'],
    ['GET', '/storefront/pages/terms'],
    [
      'PUT',
      '/storefront/pages/terms',
      { version: null, sections: [{ heading: 'Delivery', body: 'Inside Dhaka in 2 days.' }] },
    ],
    ['DELETE', '/storefront/pages/terms?version=1'],
  ];
}

describe('who may change the look', () => {
  it('refuses all 16 routes to a member without storefront.manage', async () => {
    const routes = everyRoute();
    expect(routes).toHaveLength(16);
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body, viewer);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('before the shop is set up', () => {
  it('reads and makes nothing: the screens say "Set up the shop first"', async () => {
    const asked = everyRoute().filter(
      ([method, url]) => method !== 'DELETE' && !url.includes(UNKNOWN) && !url.endsWith('/move'),
    );
    for (const [method, url, body] of asked) {
      const problem = await refused(send(method, url, body), 409);
      expect(problem.code, `${method} ${url}`).toBe('storefront_not_set_up');
    }
    // A collection's page and its form ask for the shop first, not "no such collection"
    const byId = everyRoute().filter(
      ([method, url]) => method !== 'DELETE' && url.includes(`/collections/${UNKNOWN}`),
    );
    expect(byId).toHaveLength(2);
    for (const [method, url, body] of byId) {
      const problem = await refused(send(method, url, body), 409);
      expect(problem.code, `${method} ${url}`).toBe('storefront_not_set_up');
    }
  });

  it('finds nothing to change or delete', async () => {
    // A banner, a collection, a hero or a page needs the shop to be made, so before it there is
    // none: these answer like any id that does not exist (decision 24)
    const changes = everyRoute().filter(
      ([method, url]) =>
        method === 'DELETE' ||
        url.endsWith('/move') ||
        (method === 'PUT' && url.includes('/banners/')),
    );
    expect(changes).toHaveLength(6);
    for (const [method, url, body] of changes) {
      expect((await send(method, url, body)).statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

describe('the logo and the colors', () => {
  beforeAll(async () => {
    // The shop as Shop settings makes it, then three listings and the launch
    const made = await send('POST', '/storefront/settings', {
      subdomain: 'nirvor',
      name: 'Nirvor Pharmacy',
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
      // Step 27b: "Made by the first order with a charge"
      deliveryVariantId: '',
    });
    expect(made.statusCode, made.body).toBe(201);
    const category = await send('POST', '/storefront/categories', {
      name: 'Skin care',
      slug: '',
      parentId: '',
    });
    expect(category.statusCode, category.body).toBe(201);
    const categoryId = z.object({ id: z.uuid() }).parse(category.json()).id;
    neem = await listed('Neem Face Wash', '229', categoryId, true);
    tea = await listed('Green Tea', '120', categoryId, true);
    rose = await listed('Rose Water', '90', categoryId, false);
    const launched = await send('POST', '/storefront/settings/launch', {
      version: (await settingsNow()).version,
    });
    expect(launched.statusCode, launched.body).toBe(200);
  }, 60_000);

  it('starts with the Figma colors, the Omnivo mark, no hero and no blocks', async () => {
    const page = await appearance();
    expect(page).toMatchObject({
      shopUrl: 'http://nirvor.localhost:4321',
      theme: {
        logo: null,
        brandColor: '#005859',
        accentColor: '#b8ef69',
        name: 'Nirvor Pharmacy',
        // The settings row's version (decision 12)
        version: (await settingsNow()).version,
      },
      hero: null,
      blocks: [],
    });
  });

  it('refuses colors a shopper could not read, each on its own box', async () => {
    const { version } = (await appearance()).theme;
    // A light teal: too pale on cream, and too close to the lime
    const problem = await refused(
      send('PUT', '/storefront/appearance/theme', {
        version,
        logoImageId: null,
        brandColor: '#88c0c0',
        accentColor: '#b8ef69',
      }),
      400,
    );
    expect(problem.fieldErrors).toEqual({
      brandColor: ['storefront_brand_contrast'],
      accentColor: ['storefront_accent_contrast'],
    });
    const format = await refused(
      send('PUT', '/storefront/appearance/theme', {
        version,
        logoImageId: null,
        brandColor: 'teal',
        accentColor: '#b8ef69',
      }),
      400,
    );
    expect(format.fieldErrors).toEqual({ brandColor: ['storefront_color_format'] });
  });

  it('takes as the logo only a photo of this workspace that is ready', async () => {
    const { version } = (await appearance()).theme;
    for (const logoImageId of [pending, UNKNOWN]) {
      const problem = await refused(
        send('PUT', '/storefront/appearance/theme', {
          version,
          logoImageId,
          brandColor: '#005859',
          accentColor: '#b8ef69',
        }),
        409,
      );
      expect(problem.fieldErrors, logoImageId).toEqual({
        logoImageId: ['storefront_image_not_ready'],
      });
    }
  });

  it('saves on the settings row’s version, and the shop draws them', async () => {
    const before = await settingsNow();
    const res = await send('PUT', '/storefront/appearance/theme', {
      version: before.version,
      logoImageId: photo,
      // Upper case is the same color: kept in lower case
      brandColor: '#1F47B5',
      accentColor: '#B8EF69',
    });
    expect(res.statusCode, res.body).toBe(200);
    const theme = storefrontThemeSchema.parse(res.json());
    expect(theme).toMatchObject({
      brandColor: '#1f47b5',
      accentColor: '#b8ef69',
      logo: { id: photo },
      version: before.version + 1,
    });
    expect(theme.logo?.url).toMatch(new RegExp(`/storefront/${photo}/small\\.webp$`));
    // One version for the row: Shop settings, open since before, must reload first
    const stale = await refused(
      send('PUT', '/storefront/settings', {
        subdomain: before.subdomain,
        name: before.name,
        language: before.language,
        hotline: before.hotline,
        address: before.address,
        facebookUrl: '',
        instagramUrl: '',
        xUrl: '',
        linkedinUrl: '',
        defaultWarehouseId: warehouseId,
        deliveryZones: before.deliveryZones,
        freeDeliveryFrom: '',
        minimumOrder: '',
        paymentMethods: ['cod'],
        deliveryVariantId: '',
        version: before.version,
      }),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    const again = await refused(
      send('PUT', '/storefront/appearance/theme', {
        version: before.version,
        logoImageId: null,
        brandColor: '#005859',
        accentColor: '#b8ef69',
      }),
      409,
    );
    expect(again.code).toBe('version_conflict');

    const shopNow = publicShopSchema.parse((await shop('/public/v1/shop')).json());
    expect(shopNow.theme).toEqual({ brand: '#1f47b5', accent: '#b8ef69' });
    // The logo's alt text is the shop's name
    expect(shopNow.logo).toMatchObject({ alt: 'Nirvor Pharmacy' });
    expect(shopNow.logo?.url).toMatch(new RegExp(`/storefront/${photo}/small\\.webp$`));
  });

  it('puts the Omnivo mark and the default colors back', async () => {
    const { version } = (await appearance()).theme;
    const res = await send('PUT', '/storefront/appearance/theme', {
      version,
      logoImageId: null,
      brandColor: '#005859',
      accentColor: '#b8ef69',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(storefrontThemeSchema.parse(res.json()).logo).toBeNull();
    const shopNow = publicShopSchema.parse((await shop('/public/v1/shop')).json());
    expect([shopNow.logo, shopNow.theme]).toEqual([null, { brand: '#005859', accent: '#b8ef69' }]);
  });
});

describe('the hero', () => {
  it('refuses words a shopper could not read and links that are not links', async () => {
    const colors = await refused(
      send('PUT', '/storefront/appearance/hero', {
        ...heroForm(null),
        // The label in the button's own color, and white words on a white panel
        buttonTextColor: STOREFRONT_HERO_DEFAULT_COLORS.buttonColor,
        panelColor: '#ffffff',
      }),
      400,
    );
    expect(colors.fieldErrors).toEqual({
      buttonTextColor: ['storefront_button_contrast'],
      panelColor: ['storefront_panel_contrast'],
    });
    for (const href of ['javascript:alert(1)', '/\\evil.com', '//evil.com', 'https://shop']) {
      const link = await refused(
        send('PUT', '/storefront/appearance/hero', { ...heroForm(null), href }),
        400,
      );
      expect(link.fieldErrors, href).toEqual({ href: ['storefront_link_format'] });
    }
  });

  it('refuses a picture that is not ready, on its own box', async () => {
    const problem = await refused(
      send('PUT', '/storefront/appearance/hero', {
        ...heroForm(null),
        phoneImage: { id: pending, alt: 'Not there yet' },
      }),
      409,
    );
    expect(problem.fieldErrors).toEqual({ phoneImage: ['storefront_image_not_ready'] });
  });

  it('makes one hero when two first saves come at once', async () => {
    const answers = await Promise.all([
      send('PUT', '/storefront/appearance/hero', heroForm(null)),
      send('PUT', '/storefront/appearance/hero', { ...heroForm(null), headline: 'Second tab' }),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loser = answers.find((res) => res.statusCode === 409);
    expect(problemSchema.parse(loser?.json()).code).toBe('version_conflict');
    const rows = await sql`
      SELECT 1 FROM storefront_banners WHERE tenant_id = ${tenantId} AND kind = 'hero'`;
    expect(rows).toHaveLength(1);
    // And a first save after it, from a form opened before: a conflict, not a second hero
    const late = await refused(send('PUT', '/storefront/appearance/hero', heroForm(null)), 409);
    expect(late.code).toBe('version_conflict');
  });

  it('changes the hero, and the shop shows it at the top, never among the blocks', async () => {
    const hero = (await appearance()).hero;
    if (hero === null) throw new Error('No hero');
    expect(hero).toMatchObject({ line: null, eyebrow: 'Exclusive offer' });
    const res = await send('PUT', '/storefront/appearance/hero', {
      ...heroForm(hero.version),
      headline: 'Winter skin care',
      line: 'Up to 30% off Himalaya',
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = storefrontHeroSchema.parse(res.json());
    expect(saved).toMatchObject({
      id: hero.id,
      headline: 'Winter skin care',
      line: 'Up to 30% off Himalaya',
      version: hero.version + 1,
    });
    const home = shopHomeSchema.parse((await shop('/public/v1/home')).json());
    expect(home.hero).toMatchObject({
      id: hero.id,
      href: '/c/skin-care',
      headline: 'Winter skin care',
      line: 'Up to 30% off Himalaya',
      colors: {
        background: STOREFRONT_HERO_DEFAULT_COLORS.backgroundColor,
        panel: STOREFRONT_HERO_DEFAULT_COLORS.panelColor,
      },
    });
    expect(home.blocks).toEqual([]);
    // The hero is not a picture banner: their routes do not find it
    expect(
      (
        await send('PUT', `/storefront/appearance/banners/${hero.id}`, {
          ...bannerForm('Hero'),
          version: saved.version,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('deletes the hero, and the home page starts with its grid', async () => {
    const hero = (await appearance()).hero;
    if (hero === null) throw new Error('No hero');
    const stale = await refused(
      send('DELETE', `/storefront/appearance/hero?version=${String(hero.version - 1)}`),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    const res = await send('DELETE', `/storefront/appearance/hero?version=${String(hero.version)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await appearance()).hero).toBeNull();
    expect(shopHomeSchema.parse((await shop('/public/v1/home')).json()).hero).toBeNull();
  });
});

describe('the home page’s blocks', () => {
  let sale: string;
  let hot: StorefrontCollection;

  it('adds a picture banner at the end of the page', async () => {
    const banner = await addBanner('Himalaya mega sale');
    expect(banner).toMatchObject({ href: '/c/all?offer=1', version: 1 });
    expect(banner.desktopImage).toMatchObject({ id: wide, alt: 'Himalaya mega sale' });
    sale = banner.id;
    expect(idsOf((await appearance()).blocks)).toEqual([sale]);
  });

  it('refuses a collection that is empty, has a listing twice or one it does not know', async () => {
    const empty = await refused(
      send('POST', '/storefront/appearance/collections', {
        title: 'Hot',
        icon: null,
        listingIds: [],
      }),
      400,
    );
    expect(empty.fieldErrors).toEqual({ listingIds: ['storefront_collection_empty'] });
    const twice = await refused(
      send('POST', '/storefront/appearance/collections', {
        title: 'Hot',
        icon: null,
        listingIds: [neem.id, neem.id],
      }),
      400,
    );
    expect(twice.fieldErrors).toEqual({ 'listingIds.1': ['storefront_listing_twice'] });
    const unknown = await refused(
      send('POST', '/storefront/appearance/collections', {
        title: 'Hot',
        icon: null,
        listingIds: [neem.id, UNKNOWN],
      }),
      409,
    );
    expect(unknown).toMatchObject({
      code: 'storefront_listing_invalid',
      fieldErrors: { 'listingIds.1': ['storefront_listing_invalid'] },
    });
    // None of the refused ones left a block behind
    expect(await positions()).toEqual([1]);
  });

  it('adds a collection with its listings in order, counting what the shop shows', async () => {
    const res = await send('POST', '/storefront/appearance/collections', {
      title: 'Hot & Trending Right Now',
      icon: 'fire',
      listingIds: [rose.id, tea.id, neem.id],
    });
    expect(res.statusCode, res.body).toBe(201);
    hot = storefrontCollectionSchema.parse(res.json());
    expect(hot).toMatchObject({ icon: 'fire', listingCount: 3, publishedCount: 2, version: 1 });
    expect(hot.listings.map((listing) => listing.id)).toEqual([rose.id, tea.id, neem.id]);
    const page = await appearance();
    expect(idsOf(page.blocks)).toEqual([sale, hot.id]);
    // The Home page card's summary: no listings, only the counts
    expect(page.blocks[1]).toEqual({
      kind: 'collection',
      collection: {
        id: hot.id,
        title: 'Hot & Trending Right Now',
        icon: 'fire',
        listingCount: 3,
        publishedCount: 2,
        version: 1,
        updatedAt: hot.updatedAt,
      },
    });
  });

  it('shows the blocks in the shop in their order, with the cards it shows', async () => {
    const home = shopHomeSchema.parse((await shop('/public/v1/home')).json());
    expect(home.blocks.map((block) => block.kind)).toEqual(['image', 'collection']);
    const [banner, row] = home.blocks;
    expect(banner).toMatchObject({ id: sale, href: '/c/all?offer=1' });
    // The draft waits in the collection; the shop leaves it out until it is published
    expect(row?.kind === 'collection' && row.collection.listings.map((card) => card.slug)).toEqual([
      'green-tea',
      'neem-face-wash',
    ]);
  });

  it('changes a collection’s title, icon and listings, once per version', async () => {
    const res = await send('PUT', `/storefront/appearance/collections/${hot.id}`, {
      title: 'Best sellers',
      icon: null,
      listingIds: [neem.id, tea.id],
      version: hot.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = storefrontCollectionSchema.parse(res.json());
    expect(saved).toMatchObject({
      title: 'Best sellers',
      icon: null,
      listingCount: 2,
      publishedCount: 2,
      version: hot.version + 1,
    });
    expect(saved.listings.map((listing) => listing.id)).toEqual([neem.id, tea.id]);
    const stale = await refused(
      send('PUT', `/storefront/appearance/collections/${hot.id}`, {
        title: 'Old tab',
        icon: null,
        listingIds: [rose.id],
        version: hot.version,
      }),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    const read = await send('GET', `/storefront/appearance/collections/${hot.id}`);
    expect(storefrontCollectionSchema.parse(read.json())).toEqual(saved);
    hot = saved;
  });

  it('moves a block up and down; at the end a second click changes nothing', async () => {
    const corner = await addCollection('Diabetic Corner', [tea.id]);
    expect(idsOf((await appearance()).blocks)).toEqual([sale, hot.id, corner.id]);
    let res = await send('POST', '/storefront/appearance/home/move', {
      kind: 'collection',
      id: corner.id,
      direction: 'up',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(storefrontHomeBlockListSchema.parse(res.json()).blocks)).toEqual([
      sale,
      corner.id,
      hot.id,
    ]);
    res = await send('POST', '/storefront/appearance/home/move', {
      kind: 'banner',
      id: sale,
      direction: 'up',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(storefrontHomeBlockListSchema.parse(res.json()).blocks)).toEqual([
      sale,
      corner.id,
      hot.id,
    ]);
    expect(await positions()).toEqual([1, 2, 3]);
    // A collection's id named as a banner is not a block of the page
    const wrongKind = await send('POST', '/storefront/appearance/home/move', {
      kind: 'banner',
      id: corner.id,
      direction: 'down',
    });
    expect(wrongKind.statusCode).toBe(404);
    const home = shopHomeSchema.parse((await shop('/public/v1/home')).json());
    expect(
      home.blocks.map((block) => (block.kind === 'image' ? block.id : block.collection.id)),
    ).toEqual([sale, corner.id, hot.id]);
  });

  it('closes the gap a deleted block leaves, so the next one goes last', async () => {
    const corner = (await appearance()).blocks[1];
    if (corner?.kind !== 'collection') throw new Error('Diabetic Corner is not second');
    const stale = await refused(
      send(
        'DELETE',
        `/storefront/appearance/collections/${corner.collection.id}?version=${String(corner.collection.version + 1)}`,
      ),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    const res = await send(
      'DELETE',
      `/storefront/appearance/collections/${corner.collection.id}?version=${String(corner.collection.version)}`,
    );
    expect(res.statusCode, res.body).toBe(204);
    expect(await positions()).toEqual([1, 2]);
    // The listings stay: only the collection went
    expect((await send('GET', `/storefront/listings/${tea.id}`)).statusCode).toBe(200);
    const next = await addBanner('Free delivery over ৳1,000');
    expect(idsOf((await appearance()).blocks)).toEqual([sale, hot.id, next.id]);
    expect(await positions()).toEqual([1, 2, 3]);
    // A banner's delete closes its gap the same way
    const deleted = await send(
      'DELETE',
      `/storefront/appearance/banners/${sale}?version=${String(1)}`,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(idsOf((await appearance()).blocks)).toEqual([hot.id, next.id]);
    expect(await positions()).toEqual([1, 2]);
  });

  it('changes a banner’s link and pictures, once per version', async () => {
    const block = (await appearance()).blocks[1];
    if (block?.kind !== 'banner') throw new Error('No banner second');
    const res = await send('PUT', `/storefront/appearance/banners/${block.banner.id}`, {
      href: 'https://www.facebook.com/nirvor',
      desktopImage: { id: photo, alt: 'Follow us' },
      phoneImage: { id: wide, alt: 'Follow us' },
      version: block.banner.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(storefrontBannerSchema.parse(res.json())).toMatchObject({
      href: 'https://www.facebook.com/nirvor',
      version: block.banner.version + 1,
    });
    const notReady = await refused(
      send('PUT', `/storefront/appearance/banners/${block.banner.id}`, {
        ...bannerForm('Late'),
        desktopImage: { id: pending, alt: 'Late' },
        version: block.banner.version + 1,
      }),
      409,
    );
    expect(notReady.fieldErrors).toEqual({ desktopImage: ['storefront_image_not_ready'] });
  });
});

describe('the limits', () => {
  // Now: one collection, one banner (2 blocks)
  it('keeps 6 picture banners', async () => {
    for (let n = 2; n <= 6; n += 1) await addBanner(`Banner ${String(n)}`);
    const problem = await refused(
      send('POST', '/storefront/appearance/banners', bannerForm('Seventh')),
      409,
    );
    expect(problem.code).toBe('storefront_banners_full');
    expect(await positions()).toEqual(oneTo(7));
  });

  it('keeps 12 blocks, even with two adds at once for the last place', async () => {
    for (let n = 2; n <= 5; n += 1) await addCollection(`Collection ${String(n)}`, [neem.id]);
    expect(await positions()).toEqual(oneTo(11));
    const answers = await Promise.all(
      ['Twelfth', 'Thirteenth'].map((title) =>
        send('POST', '/storefront/appearance/collections', {
          title,
          icon: null,
          listingIds: [tea.id],
        }),
      ),
    );
    expect(answers.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const loser = answers.find((res) => res.statusCode === 409);
    expect(problemSchema.parse(loser?.json()).code).toBe('storefront_home_full');
    expect(await positions()).toEqual(oneTo(12));
    // The loser left no collection without a block
    const [counted] = z.array(z.object({ count: z.number() })).parse(
      await sql`SELECT count(*)::int AS count FROM storefront_collections
                   WHERE tenant_id = ${tenantId}`,
    );
    expect(counted?.count).toBe(6);
  });

  it('keeps 8 collections, with room on the page', async () => {
    let blocks = (await appearance()).blocks;
    // Three banners go: 9 blocks, room for three more
    for (const block of blocks.filter((one) => one.kind === 'banner').slice(0, 3)) {
      const res = await send(
        'DELETE',
        `/storefront/appearance/banners/${block.banner.id}?version=${String(block.banner.version)}`,
      );
      expect(res.statusCode, res.body).toBe(204);
    }
    await addCollection('Seventh', [neem.id]);
    await addCollection('Eighth', [neem.id]);
    const problem = await refused(
      send('POST', '/storefront/appearance/collections', {
        title: 'Ninth',
        icon: null,
        listingIds: [neem.id],
      }),
      409,
    );
    expect(problem.code).toBe('storefront_collections_full');
    blocks = (await appearance()).blocks;
    expect(blocks).toHaveLength(11);
    expect(await positions()).toEqual(oneTo(11));
  });
});

describe('the text pages', () => {
  const DELIVERY = { heading: 'Delivery', body: 'Inside Dhaka in **2 days**.' };
  const RETURNS = { heading: 'Returns', body: 'Unopened, within 7 days. <script>x</script>' };

  it('lists the four pages in the footer’s order, none written yet', async () => {
    const res = await send('GET', '/storefront/pages');
    expect(res.statusCode, res.body).toBe(200);
    const list = storefrontPageListSchema.parse(res.json());
    expect(list.items.map((page) => [page.slug, page.version, page.sectionCount])).toEqual([
      ['privacy', null, 0],
      ['terms', null, 0],
      ['about', null, 0],
      ['contact', null, 0],
    ]);
    expect(list.items[1]?.shopUrl).toBe('http://nirvor.localhost:4321/pages/terms');
    const terms = storefrontPageSchema.parse((await send('GET', '/storefront/pages/terms')).json());
    expect(terms).toMatchObject({ sections: [], version: null, updatedAt: null });
    // Only the four
    expect((await send('GET', '/storefront/pages/faq')).statusCode).toBe(400);
    expect(publicShopSchema.parse((await shop('/public/v1/shop')).json()).pages).toEqual([]);
  });

  it('refuses a page with no section', async () => {
    const problem = await refused(
      send('PUT', '/storefront/pages/terms', { version: null, sections: [] }),
      400,
    );
    expect(problem.fieldErrors).toEqual({ sections: ['storefront_page_empty'] });
  });

  it('writes a page once when two first saves come at once', async () => {
    const answers = await Promise.all([
      send('PUT', '/storefront/pages/terms', { version: null, sections: [DELIVERY] }),
      send('PUT', '/storefront/pages/terms', { version: null, sections: [RETURNS] }),
    ]);
    expect(answers.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const loser = answers.find((res) => res.statusCode === 409);
    expect(problemSchema.parse(loser?.json()).code).toBe('version_conflict');
    const page = storefrontPageSchema.parse((await send('GET', '/storefront/pages/terms')).json());
    expect(page.version).toBe(1);
    expect(page.sections).toHaveLength(1);
  });

  it('changes a page, and the shop links and shows only the written ones', async () => {
    const before = storefrontPageSchema.parse(
      (await send('GET', '/storefront/pages/terms')).json(),
    );
    let res = await send('PUT', '/storefront/pages/terms', {
      version: before.version,
      sections: [DELIVERY, RETURNS],
    });
    expect(res.statusCode, res.body).toBe(200);
    const terms = storefrontPageSchema.parse(res.json());
    expect(terms).toMatchObject({ sections: [DELIVERY, RETURNS], version: 2 });
    expect(terms.updatedAt).not.toBeNull();
    const stale = await refused(
      send('PUT', '/storefront/pages/terms', { version: 1, sections: [DELIVERY] }),
      409,
    );
    expect(stale.code).toBe('version_conflict');
    res = await send('PUT', '/storefront/pages/about', {
      version: null,
      sections: [{ heading: 'About Nirvor', body: 'A pharmacy in Mirpur since 2009.' }],
    });
    expect(res.statusCode, res.body).toBe(200);

    // The footer's order, not the order they were written in
    expect(publicShopSchema.parse((await shop('/public/v1/shop')).json()).pages).toEqual([
      'terms',
      'about',
    ]);
    const page = shopTextPageSchema.parse((await shop('/public/v1/pages/terms')).json());
    expect(page.html).toContain('<h2>Returns</h2>');
    expect(page.html).toContain('<strong>2 days</strong>');
    // What the tenant typed is text, never markup
    expect(page.html).toContain('&lt;script&gt;');
    expect(page.html).not.toContain('<script>');
    const list = storefrontPageListSchema.parse((await send('GET', '/storefront/pages')).json());
    expect(list.items.map((one) => one.sectionCount)).toEqual([0, 2, 1, 0]);
  });

  it('deletes a page: the shop answers "page not found" and drops its link', async () => {
    const stale = await refused(send('DELETE', '/storefront/pages/terms?version=1'), 409);
    expect(stale.code).toBe('version_conflict');
    const res = await send('DELETE', '/storefront/pages/terms?version=2');
    expect(res.statusCode, res.body).toBe(204);
    expect(publicShopSchema.parse((await shop('/public/v1/shop')).json()).pages).toEqual(['about']);
    expect((await shop('/public/v1/pages/terms')).statusCode).toBe(404);
    // Nothing to delete twice; and written again, it starts over at version 1
    expect((await send('DELETE', '/storefront/pages/terms?version=2')).statusCode).toBe(404);
    const again = await send('PUT', '/storefront/pages/terms', {
      version: null,
      sections: [DELIVERY],
    });
    expect(storefrontPageSchema.parse(again.json()).version).toBe(1);
  });
});

describe('the audit log', () => {
  const changesSchema = z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() }));

  async function entries(action: string) {
    const rows = await sql`
      SELECT entity_type, entity_id::text, payload->'changes' AS changes FROM audit_logs
       WHERE tenant_id = ${tenantId} AND action = ${action} ORDER BY created_at, id`;
    return z
      .array(z.object({ entity_type: z.string(), entity_id: z.string(), changes: changesSchema }))
      .parse(rows);
  }

  it('wrote every change of the look and the pages', async () => {
    const rows = await sql`
      SELECT DISTINCT action FROM audit_logs
       WHERE tenant_id = ${tenantId} AND entity_type LIKE 'storefront%'
         AND action NOT LIKE 'storefront_listing.%' AND action NOT LIKE 'storefront_category.%'`;
    expect(rows.map((row) => String(row.action)).sort()).toEqual([
      'storefront.created',
      'storefront.home_moved',
      'storefront.launched',
      'storefront.page_deleted',
      'storefront.page_saved',
      'storefront.theme_updated',
      'storefront_banner.created',
      'storefront_banner.deleted',
      'storefront_banner.updated',
      'storefront_collection.created',
      'storefront_collection.deleted',
      'storefront_collection.updated',
    ]);
  });

  it('says what changed in words a person reads', async () => {
    const [theme] = await entries('storefront.theme_updated');
    expect(theme?.entity_type).toBe('storefront');
    expect(theme?.changes).toMatchObject({
      logoImageId: { from: null, to: photo },
      brandColor: { from: '#005859', to: '#1f47b5' },
    });
    // Decision 25: the move is on the block that moved, from its place to the new one
    const [moved] = await entries('storefront.home_moved');
    expect(moved?.entity_type).toBe('storefront_collection');
    expect(moved?.changes).toEqual({ position: { from: 3, to: 2 } });
    // Decision 26: a page's line is keyed by its slug, its headings as the value
    const pages = await entries('storefront.page_saved');
    // [slug, from, to] per save. The race's winner is either tab, so its headings are one of two
    const lines = pages.flatMap((entry) =>
      Object.entries(entry.changes).map(([slug, change]) => [slug, change.from, change.to]),
    );
    const winner = lines[0]?.[2];
    expect(['Delivery', 'Returns']).toContain(winner);
    expect(lines).toEqual([
      ['terms', null, winner],
      ['terms', winner, 'Delivery, Returns'],
      ['about', null, 'About Nirvor'],
      ['terms', null, 'Delivery'],
    ]);
    const [deletedPage] = await entries('storefront.page_deleted');
    expect(deletedPage?.changes).toEqual({ terms: { from: 'Delivery, Returns', to: null } });
    // The hero is a banner: deleted, every field went to null, its kind too
    const heroGone = (await entries('storefront_banner.deleted')).find(
      (entry) => entry.changes.kind?.from === 'hero',
    );
    expect(heroGone?.changes).toMatchObject({
      kind: { from: 'hero', to: null },
      headline: { from: 'Winter skin care', to: null },
    });
  });
});
