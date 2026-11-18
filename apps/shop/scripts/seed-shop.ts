import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { routes, SHOP_TEXT_PAGES, type SignUpInput } from '@omnivo/contracts';

import { SeedApi, SeedApiError } from './seed-client';
import {
  heroBody,
  idOf,
  listingBody,
  megaSaleBody,
  seedCategories,
  seedCollections,
  seedListings,
  seedPhotos,
  settingsBody,
  type SeedListing,
  type SeedPhoto,
} from './seed-plan';
import { PAGES } from './seed-words';

// Step 26h: `pnpm seed:shop`. Makes a demo workspace with a launched shop on the running dev
// stack (`pnpm dev`: the API, its worker and MinIO), through the HTTP API only, as a person would
// with the ERP's screens: sign up, set the workspace up, add the products and their opening stock,
// set the shop up, upload the photos, list the products, design the home page, write the pages and
// open the shop. Nothing is written to the database directly, so every rule of the API (contrast,
// limits, photos ready, the launch checklist) checks the demo too, and the seed doubles as a smoke
// test of the whole storefront path. It never runs in CI.
//
// It stops before changing anything when the workspace is there already: the sign-up is the check,
// and it is atomic, so two runs at once cannot both make it.

const API_URL = process.env.SEED_API_URL ?? 'http://localhost:3000';
// Also the shop's subdomain: http://demo-shop.localhost:4321
const SLUG = process.env.SEED_SHOP_SLUG ?? 'demo-shop';

// The owner the seed signs up. A made-up person and a .test address (a domain that never
// receives mail), printed at the end so the developer can sign in
const OWNER: SignUpInput = {
  companyName: 'Omnivo Demo Shop',
  workspaceSlug: SLUG,
  fullName: 'Nusrat Jahan',
  email: `owner@${SLUG}.test`,
  password: 'Demo-shop-2026',
};

// How long the worker may take: the workspace's setup job, and the photo job for the 26 photos.
// Both run in the worker, which `pnpm dev` starts beside the API
const SETUP_WAIT_MS = 60_000;
const PHOTO_WAIT_MS = 180_000;
const POLL_MS = 500;

const api = new SeedApi(API_URL);
const started = performance.now();

function step(text: string): void {
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`[${seconds.padStart(5)} s] ${text}`);
}

// The workspace's day in Dhaka (its time zone), never the UTC day: run before 6 am, the UTC day is
// still yesterday. en-CA writes a date as YYYY-MM-DD
function today(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(now);
}

async function signUp(): Promise<boolean> {
  try {
    await api.signUp(OWNER);
    return true;
  } catch (error) {
    if (error instanceof SeedApiError && error.code === 'slug_taken') return false;
    throw error;
  }
}

// The setup job makes the chart of accounts, the main branch and its MAIN warehouse, the units and
// the roles. Products need its units and stock needs its warehouse, so the seed waits for it
async function setUpWorkspace(): Promise<void> {
  await api.call(routes.setup.start, { body: { industry: 'retail' } });
  const deadline = Date.now() + SETUP_WAIT_MS;
  for (;;) {
    const { status } = await api.call(routes.setup.get);
    if (status === 'ready') return;
    if (status === 'failed') throw new Error('The workspace setup job failed. See the worker log.');
    if (Date.now() > deadline) {
      throw new Error('The workspace setup did not finish. Is the worker running (pnpm dev)?');
    }
    await sleep(POLL_MS);
  }
}

// One simple product per listing, priced at the shop's regular price. Its code is the next
// product number (P-00001); its SKU too, except the design product's own "MD2346"
async function addProducts(
  listings: readonly SeedListing[],
  pcs: string,
): Promise<Map<string, string>> {
  const variants = new Map<string, string>();
  for (const listing of listings) {
    const product = await api.call(routes.products.create, {
      body: {
        code: '',
        name: listing.productName,
        type: 'goods',
        categoryId: '',
        description: '',
        baseUnitId: pcs,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking: 'none',
        hasExpiry: false,
        taxRateId: '',
        options: [],
        variants: [
          {
            id: null,
            sku: listing.sku,
            optionValues: [],
            barcode: '',
            salePrice: listing.regularPrice,
            archived: false,
          },
        ],
        units: [],
        customFields: {},
      },
    });
    const [variant] = product.variants;
    if (variant === undefined) throw new Error(`${listing.productName} has no variant`);
    variants.set(listing.slug, variant.id);
  }
  return variants;
}

// One posted opening-stock adjustment for every product the mock has in stock. The others get
// none, so the shop says "Out of stock" on the same cards the mock does
async function addOpeningStock(
  listings: readonly SeedListing[],
  variants: ReadonlyMap<string, string>,
  warehouseId: string,
  pcs: string,
): Promise<number> {
  const lines = listings.flatMap((listing) =>
    listing.stock === null
      ? []
      : [
          {
            variantId: idOf(variants, listing.slug),
            unitId: pcs,
            quantity: listing.stock,
            batchId: '',
            lotNumber: '',
            expiresOn: '',
            manufacturedOn: '',
            serialNumbers: [],
            unitCost: listing.unitCost,
          },
        ],
  );
  await api.call(routes.stockAdjustments.create, {
    body: {
      date: today(new Date()),
      warehouseId,
      direction: 'in',
      reason: 'opening',
      note: 'Demo shop opening stock',
      post: true,
      lines,
    },
  });
  return lines.length;
}

// Parents first (the plan's order), so a child always finds its parent's real id
async function addCategories(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const category of seedCategories) {
    const created = await api.call(routes.storefront.createCategory, {
      body: {
        parentId: category.parentId === null ? '' : idOf(ids, category.parentId),
        name: category.name,
        slug: category.slug,
      },
    });
    ids.set(category.id, created.id);
  }
  return ids;
}

// Each file as the ERP's photo box sends it: the upload address, the file straight to storage,
// "complete", then the worker's image job. All the files go first and the seed then waits for all
// of them, so the worker makes the WebP files of one photo while the next one uploads
async function uploadPhotos(photos: readonly SeedPhoto[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const photo of photos) {
    const bytes = await readFile(photo.file);
    const ticket = await api.call(routes.storefront.createUpload, {
      body: {
        fileName: basename(photo.file),
        contentType: photo.contentType,
        sizeBytes: bytes.byteLength,
      },
    });
    await api.put(ticket.upload.url, ticket.upload.headers, bytes);
    await api.call(routes.storefront.completeUpload, { params: { id: ticket.image.id } });
    ids.set(photo.url, ticket.image.id);
  }

  const deadline = Date.now() + PHOTO_WAIT_MS;
  const waiting = new Map(ids);
  while (waiting.size > 0) {
    for (const [url, id] of waiting) {
      const upload = await api.call(routes.storefront.getUpload, { params: { id } });
      if (upload.status === 'ready') waiting.delete(url);
      // A photo the job refused (too small, unreadable) would only fail later, at the listing's
      // save, with a less clear error. Stop here, naming the file and the reason
      if (upload.status === 'failed')
        throw new Error(`The image job refused ${url}: ${upload.code}`);
    }
    if (waiting.size === 0) break;
    if (Date.now() > deadline) {
      throw new Error(
        `${String(waiting.size)} photos were not ready in time. Is the worker running (pnpm dev)?`,
      );
    }
    await sleep(POLL_MS);
  }
  return ids;
}

// Add to shop, then the editor's save with the mock's name, link, sale, badges and photos. They
// are published afterwards, last first (publishListings)
async function addListings(
  listings: readonly SeedListing[],
  variants: ReadonlyMap<string, string>,
  categories: ReadonlyMap<string, string>,
  photos: ReadonlyMap<string, string>,
): Promise<Map<string, { id: string; version: number }>> {
  const saved = new Map<string, { id: string; version: number }>();
  for (const listing of listings) {
    const categoryId = idOf(categories, listing.categoryKey);
    const draft = await api.call(routes.storefront.createListing, {
      body: { variantId: idOf(variants, listing.slug), categoryId },
    });
    const edited = await api.call(routes.storefront.updateListing, {
      params: { id: draft.id },
      body: listingBody(listing, draft.version, categoryId, photos),
    });
    saved.set(listing.slug, { id: edited.id, version: edited.version });
  }
  return saved;
}

// The shop's "Newest" order, its home grid and /c/all, is the publishing order, newest first. The
// mock lists its catalog newest first, so the seed publishes it from the end: the mock's first
// card is then the real shop's newest, and the home grid starts with the same cards
async function publishListings(
  listings: readonly SeedListing[],
  saved: ReadonlyMap<string, { id: string; version: number }>,
): Promise<void> {
  for (const listing of [...listings].reverse()) {
    const draft = saved.get(listing.slug);
    if (draft === undefined) throw new Error(`no listing for ${listing.slug}`);
    await api.call(routes.storefront.publishListing, {
      params: { id: draft.id },
      body: { version: draft.version },
    });
  }
}

// The hero, then the home page's blocks in the mock's order. A new banner or collection goes to
// the end of the page, so making them in order is the order
async function designHome(
  photos: ReadonlyMap<string, string>,
  saved: ReadonlyMap<string, { id: string; version: number }>,
): Promise<void> {
  await api.call(routes.storefrontAppearance.saveHero, { body: heroBody(photos) });
  await api.call(routes.storefrontAppearance.createBanner, { body: megaSaleBody(photos) });
  for (const collection of seedCollections) {
    await api.call(routes.storefrontAppearance.createCollection, {
      body: {
        title: collection.title,
        icon: collection.icon,
        listingIds: collection.slugs.map((slug) => {
          const listing = saved.get(slug);
          if (listing === undefined) throw new Error(`no listing for ${slug}`);
          return listing.id;
        }),
      },
    });
  }
}

async function writePages(): Promise<void> {
  for (const slug of SHOP_TEXT_PAGES) {
    await api.call(routes.storefrontAppearance.savePage, {
      params: { slug },
      body: { version: null, sections: PAGES[slug] },
    });
  }
}

// Everything after the sign-up, in the order the ERP's screens would do it
async function seed(): Promise<void> {
  await setUpWorkspace();
  const { items: units } = await api.call(routes.units.list);
  const pcs = units.find((unit) => unit.code === 'pcs');
  if (pcs === undefined) throw new Error('The workspace has no "pcs" unit');
  const { items: warehouses } = await api.call(routes.warehouses.list);
  const warehouse = warehouses.find((candidate) => candidate.code === 'MAIN');
  if (warehouse === undefined) throw new Error('The workspace has no MAIN warehouse');
  step('workspace set up (retail)');

  const listings = seedListings(new Date());
  const variants = await addProducts(listings, pcs.id);
  const stocked = await addOpeningStock(listings, variants, warehouse.id, pcs.id);
  step(`${String(listings.length)} products, opening stock for ${String(stocked)} in MAIN`);

  await api.call(routes.storefront.createSettings, { body: settingsBody(SLUG, warehouse.id) });
  const categories = await addCategories();
  step(`shop set up, ${String(categories.size)} categories`);

  const photos = await uploadPhotos(seedPhotos(listings));
  step(`${String(photos.size)} photos ready`);

  const saved = await addListings(listings, variants, categories, photos);
  await publishListings(listings, saved);
  step(`${String(saved.size)} listings in the shop`);

  await designHome(photos, saved);
  await writePages();
  step(
    `hero, Mega Sale banner, ${String(seedCollections.length)} collections, ${String(SHOP_TEXT_PAGES.length)} pages`,
  );

  // The launch takes the settings row's version, read after everything above (the listings and
  // the home page do not change it, the settings do)
  const { shop } = await api.call(routes.storefront.getSettings);
  if (shop === null) throw new Error('The shop is not set up');
  const launched = await api.call(routes.storefront.launch, { body: { version: shop.version } });
  step(`shop open at ${launched.shopUrl}`);

  console.log(
    `\nSign in to the ERP: workspace ${SLUG}, ${OWNER.email}, password ${OWNER.password}\n` +
      `See the shop from this API (the shop's dev server reads the mock unless told otherwise).\n` +
      `SHOP_API_KEY is the API's STOREFRONT_SHOP_KEY (.env.example has the dev one):\n` +
      `  SHOP_SOURCE=api SHOP_API_URL=${API_URL} SHOP_API_KEY=… pnpm --filter @omnivo/shop dev\n` +
      `  then open ${launched.shopUrl}`,
  );
}

function stopped(error: unknown): void {
  console.error(`\nThe seed stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  step(`API ${API_URL}, workspace ${SLUG}`);
  if (!(await signUp())) {
    console.log(
      `\nThe workspace "${SLUG}" is there already, so nothing was changed.\n` +
        `Sign in to it as ${OWNER.email} / ${OWNER.password}, or make another one:\n` +
        `  SEED_SHOP_SLUG=demo-shop-2 pnpm seed:shop`,
    );
    process.exitCode = 1;
    return;
  }
  step(`signed up ${OWNER.companyName}`);
  try {
    await seed();
  } catch (error) {
    // After the sign-up a stop leaves a half-made workspace, which a second run would refuse
    stopped(error);
    console.error(
      `The workspace "${SLUG}" is half made. Reset the dev database, or use another SEED_SHOP_SLUG.`,
    );
  }
}

// Before the sign-up (no API on that address, say), nothing was made
try {
  await main();
} catch (error) {
  stopped(error);
}
