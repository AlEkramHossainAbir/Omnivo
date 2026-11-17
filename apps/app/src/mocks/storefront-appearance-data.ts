import {
  type CreateStorefrontBannerInput,
  type CreateStorefrontCollectionInput,
  type ErrorCode,
  type MoveStorefrontHomeBlockInput,
  type SaveStorefrontHeroInput,
  type SaveStorefrontPageInput,
  SHOP_TEXT_PAGES,
  type ShopTextPageSlug,
  STOREFRONT_BANNERS_MAX,
  STOREFRONT_COLLECTIONS_MAX,
  STOREFRONT_HOME_BLOCKS_MAX,
  type StorefrontAppearance,
  type StorefrontBanner,
  type StorefrontCollection,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontHomeBlock,
  type StorefrontImage,
  type StorefrontPage,
  type StorefrontPageSummary,
  type StorefrontSection,
  type StorefrontTheme,
  type UpdateStorefrontBannerInput,
  type UpdateStorefrontCollectionInput,
  type UpdateStorefrontThemeInput,
} from '@omnivo/contracts';

import { MockProblem } from './mock';
import {
  isReady,
  notFound,
  notSetUp,
  now,
  shopUrl,
  showable,
  toSummary,
  viewOf,
} from './storefront-data';
import type {
  MockBanner,
  MockCollection,
  MockHero,
  MockHomeBlock,
  MockShop,
} from './storefront-seed';
import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';

// Step 26h: Shop appearance and the text pages, with the API's rules
// (apps/api/src/storefront/admin/appearance.service.ts, collections.service.ts, pages.service.ts,
// home-blocks.ts). What it keeps, and Rahman Fashion's look, are in storefront-seed.ts. A file of
// its own beside storefront-data.ts: the two halves of the menu change apart, like the API's
// services.

function requireShop(data: WorkspaceData): MockShop {
  const shop = data.storefront.shop;
  if (shop === null) throw notSetUp();
  return shop;
}

// A refusal for a full list: no box, it belongs to the "Add" button (home-blocks.ts full())
function full(code: ErrorCode): MockProblem {
  return new MockProblem(409, code);
}

// A picture that is not ready (or not this workspace's), on its own box
function imagesNotReady(fields: readonly string[]): MockProblem {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const field of fields) fieldErrors[field] = ['storefront_image_not_ready'];
  return new MockProblem(409, 'storefront_image_not_ready', fieldErrors);
}

// Both pictures ready; a picture the banner has already is not asked again
function checkImages(
  data: WorkspaceData,
  input: { desktopImage: StorefrontImage; phoneImage: StorefrontImage },
  before: { desktopImage: StorefrontImage; phoneImage: StorefrontImage } | null,
): void {
  const saved = new Set(before === null ? [] : [before.desktopImage.id, before.phoneImage.id]);
  const missing = (['desktopImage', 'phoneImage'] as const).filter(
    (field) => !saved.has(input[field].id) && !isReady(data, input[field].id),
  );
  if (missing.length > 0) throw imagesNotReady(missing);
}

// ---------------------------------------------------------------------------------------------
// The audit's views (the API's bannerSnapshot(), snapshot() and headings())

function bannerSnapshot(kind: 'hero' | 'image', banner: MockBanner | MockHero) {
  const hero = 'headline' in banner ? banner : null;
  return {
    kind,
    href: banner.href,
    desktopImage: banner.desktopImage.id,
    desktopAlt: banner.desktopImage.alt,
    phoneImage: banner.phoneImage.id,
    phoneAlt: banner.phoneImage.alt,
    headline: hero?.headline ?? null,
    line: hero?.line ?? null,
    eyebrow: hero?.eyebrow ?? null,
    buttonLabel: hero?.buttonLabel ?? null,
    backgroundColor: hero?.backgroundColor ?? null,
    panelColor: hero?.panelColor ?? null,
    buttonColor: hero?.buttonColor ?? null,
    buttonTextColor: hero?.buttonTextColor ?? null,
  };
}

// Every field to null, the kind too, so a deleted hero reads as the hero
function gone(snapshot: Record<string, string | null>): Record<string, null> {
  return Object.fromEntries(Object.keys(snapshot).map((key) => [key, null]));
}

function collectionSnapshot(collection: { title: string; icon: string | null }, ids: string[]) {
  return { title: collection.title, icon: collection.icon, listings: ids.join(', ') };
}

function headings(sections: readonly StorefrontSection[] | undefined): string | null {
  return sections === undefined ? null : sections.map((section) => section.heading).join(', ');
}

// ---------------------------------------------------------------------------------------------
// Reads

function toTheme(data: WorkspaceData, shop: MockShop): StorefrontTheme {
  const { logoImageId, brandColor, accentColor } = data.storefront.theme;
  return {
    logo:
      logoImageId === null
        ? null
        : { id: logoImageId, url: viewOf(data, { id: logoImageId, alt: shop.name }).url },
    brandColor,
    accentColor,
    name: shop.name,
    version: shop.version,
    updatedAt: shop.updatedAt,
  };
}

function toBanner(data: WorkspaceData, banner: MockBanner): StorefrontBanner {
  return {
    ...banner,
    desktopImage: viewOf(data, banner.desktopImage),
    phoneImage: viewOf(data, banner.phoneImage),
  };
}

function toHero(data: WorkspaceData, hero: MockHero): StorefrontHero {
  return {
    ...hero,
    desktopImage: viewOf(data, hero.desktopImage),
    phoneImage: viewOf(data, hero.phoneImage),
  };
}

// The counts: every listing in it, and those the shop shows now (the launch checklist's
// "published": not a draft, its product and variant not archived)
function toCollectionSummary(
  data: WorkspaceData,
  collection: MockCollection,
): StorefrontCollectionSummary {
  const { listingIds, ...fields } = collection;
  const listings = data.storefront.listings.filter((listing) => listingIds.includes(listing.id));
  return {
    ...fields,
    listingCount: listings.length,
    publishedCount: listings.filter((listing) => showable(data, listing)).length,
  };
}

function toCollection(data: WorkspaceData, collection: MockCollection): StorefrontCollection {
  return {
    ...toCollectionSummary(data, collection),
    listings: collection.listingIds.flatMap((id) => {
      const listing = data.storefront.listings.find((item) => item.id === id);
      return listing === undefined ? [] : [toSummary(data, listing)];
    }),
  };
}

function blocksOf(data: WorkspaceData): StorefrontHomeBlock[] {
  return data.storefront.home.flatMap((block): StorefrontHomeBlock[] => {
    if (block.kind === 'banner') {
      const banner = data.storefront.banners.find((item) => item.id === block.id);
      return banner === undefined ? [] : [{ kind: 'banner', banner: toBanner(data, banner) }];
    }
    const collection = data.storefront.collections.find((item) => item.id === block.id);
    return collection === undefined
      ? []
      : [{ kind: 'collection', collection: toCollectionSummary(data, collection) }];
  });
}

export function appearanceOf(data: WorkspaceData): StorefrontAppearance {
  const shop = requireShop(data);
  const hero = data.storefront.hero;
  return {
    shopUrl: shopUrl(shop.subdomain),
    theme: toTheme(data, shop),
    hero: hero === null ? null : toHero(data, hero),
    blocks: blocksOf(data),
  };
}

// ---------------------------------------------------------------------------------------------
// The logo and the colors

export function updateTheme(
  data: WorkspaceData,
  tenantId: string,
  input: UpdateStorefrontThemeInput,
): StorefrontTheme {
  const shop = requireShop(data);
  // The settings row's version (decision 12): a save on Shop settings meanwhile is a conflict
  checkVersion(shop.version, input.version);
  const before = data.storefront.theme;
  if (
    input.logoImageId !== null &&
    input.logoImageId !== before.logoImageId &&
    !isReady(data, input.logoImageId)
  ) {
    throw imagesNotReady(['logoImageId']);
  }
  const after = {
    logoImageId: input.logoImageId,
    brandColor: input.brandColor,
    accentColor: input.accentColor,
  };
  data.storefront.theme = after;
  const updated: MockShop = { ...shop, version: shop.version + 1, updatedAt: now() };
  data.storefront.shop = updated;
  record(data, 'storefront.theme_updated', 'storefront', tenantId, diff({ ...before }, after));
  return toTheme(data, updated);
}

// ---------------------------------------------------------------------------------------------
// The hero

export function saveHero(data: WorkspaceData, input: SaveStorefrontHeroInput): StorefrontHero {
  requireShop(data);
  const before = data.storefront.hero;
  // version null = "no hero yet" (decision 13): a hero made or deleted in another tab meanwhile
  if ((before === null) !== (input.version === null)) {
    throw new MockProblem(409, 'version_conflict');
  }
  if (before !== null && input.version !== null) checkVersion(before.version, input.version);
  checkImages(data, input, before);
  const after: MockHero = {
    id: before?.id ?? crypto.randomUUID(),
    href: input.href,
    headline: input.headline,
    line: input.line,
    eyebrow: input.eyebrow,
    buttonLabel: input.buttonLabel,
    desktopImage: input.desktopImage,
    phoneImage: input.phoneImage,
    backgroundColor: input.backgroundColor,
    panelColor: input.panelColor,
    buttonColor: input.buttonColor,
    buttonTextColor: input.buttonTextColor,
    version: before === null ? 1 : before.version + 1,
    updatedAt: now(),
  };
  data.storefront.hero = after;
  record(
    data,
    before === null ? 'storefront_banner.created' : 'storefront_banner.updated',
    'storefront_banner',
    after.id,
    diff(before === null ? {} : bannerSnapshot('hero', before), bannerSnapshot('hero', after)),
  );
  return toHero(data, after);
}

export function deleteHero(data: WorkspaceData, version: number): void {
  const before = data.storefront.hero;
  if (before === null) throw notFound();
  checkVersion(before.version, version);
  data.storefront.hero = null;
  const snapshot = bannerSnapshot('hero', before);
  record(
    data,
    'storefront_banner.deleted',
    'storefront_banner',
    before.id,
    diff(snapshot, gone(snapshot)),
  );
}

// ---------------------------------------------------------------------------------------------
// The home page's blocks

// Room for one more block (decision 6); the banners and the collections count apart too
function checkHomeRoom(data: WorkspaceData): void {
  if (data.storefront.home.length >= STOREFRONT_HOME_BLOCKS_MAX) {
    throw full('storefront_home_full');
  }
}

function dropBlock(data: WorkspaceData, block: MockHomeBlock): void {
  data.storefront.home = data.storefront.home.filter(
    (item) => item.kind !== block.kind || item.id !== block.id,
  );
}

// A swap with the block above or below, answered with the whole page. Already first or last: a
// no-op, like the API
export function moveBlock(
  data: WorkspaceData,
  input: MoveStorefrontHomeBlockInput,
): { blocks: StorefrontHomeBlock[] } {
  const order = [...data.storefront.home];
  const from = order.findIndex((block) => block.kind === input.kind && block.id === input.id);
  const block = order[from];
  if (block === undefined) throw notFound();
  const to = input.direction === 'up' ? from - 1 : from + 1;
  const neighbour = order[to];
  if (neighbour === undefined) return { blocks: blocksOf(data) };
  order[from] = neighbour;
  order[to] = block;
  data.storefront.home = order;
  record(
    data,
    'storefront.home_moved',
    input.kind === 'banner' ? 'storefront_banner' : 'storefront_collection',
    input.id,
    diff({ position: from + 1 }, { position: to + 1 }),
  );
  return { blocks: blocksOf(data) };
}

// ---------------------------------------------------------------------------------------------
// Picture banners

function findBanner(data: WorkspaceData, id: string): MockBanner {
  const found = data.storefront.banners.find((banner) => banner.id === id);
  if (!found) throw notFound();
  return found;
}

export function createBanner(
  data: WorkspaceData,
  input: CreateStorefrontBannerInput,
): StorefrontBanner {
  requireShop(data);
  if (data.storefront.banners.length >= STOREFRONT_BANNERS_MAX) {
    throw full('storefront_banners_full');
  }
  checkHomeRoom(data);
  checkImages(data, input, null);
  const banner: MockBanner = {
    id: crypto.randomUUID(),
    href: input.href,
    desktopImage: input.desktopImage,
    phoneImage: input.phoneImage,
    version: 1,
    updatedAt: now(),
  };
  data.storefront.banners.push(banner);
  // At the end of the page (decision 2: everything is on it)
  data.storefront.home.push({ kind: 'banner', id: banner.id });
  record(
    data,
    'storefront_banner.created',
    'storefront_banner',
    banner.id,
    diff({}, bannerSnapshot('image', banner)),
  );
  return toBanner(data, banner);
}

export function updateBanner(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontBannerInput,
): StorefrontBanner {
  const before = findBanner(data, id);
  checkVersion(before.version, input.version);
  checkImages(data, input, before);
  const after: MockBanner = {
    ...before,
    href: input.href,
    desktopImage: input.desktopImage,
    phoneImage: input.phoneImage,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.banners = data.storefront.banners.map((banner) =>
    banner.id === id ? after : banner,
  );
  record(
    data,
    'storefront_banner.updated',
    'storefront_banner',
    id,
    diff(bannerSnapshot('image', before), bannerSnapshot('image', after)),
  );
  return toBanner(data, after);
}

export function deleteBanner(data: WorkspaceData, id: string, version: number): void {
  const before = findBanner(data, id);
  checkVersion(before.version, version);
  data.storefront.banners = data.storefront.banners.filter((banner) => banner.id !== id);
  // Its block goes with it (the FK cascades), and the page closes the gap
  dropBlock(data, { kind: 'banner', id });
  const snapshot = bannerSnapshot('image', before);
  record(
    data,
    'storefront_banner.deleted',
    'storefront_banner',
    id,
    diff(snapshot, gone(snapshot)),
  );
}

// ---------------------------------------------------------------------------------------------
// Collections

function findCollection(data: WorkspaceData, id: string): MockCollection {
  const found = data.storefront.collections.find((collection) => collection.id === id);
  if (!found) throw notFound();
  return found;
}

// Every id is a listing of this workspace, named on its own box (listingIds.3)
function checkListings(data: WorkspaceData, ids: readonly string[]): void {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  ids.forEach((id, index) => {
    if (!data.storefront.listings.some((listing) => listing.id === id)) {
      fieldErrors[`listingIds.${String(index)}`] = ['storefront_listing_invalid'];
    }
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw new MockProblem(409, 'storefront_listing_invalid', fieldErrors);
  }
}

export function collectionOf(data: WorkspaceData, id: string): StorefrontCollection {
  requireShop(data);
  return toCollection(data, findCollection(data, id));
}

export function createCollection(
  data: WorkspaceData,
  input: CreateStorefrontCollectionInput,
): StorefrontCollection {
  requireShop(data);
  if (data.storefront.collections.length >= STOREFRONT_COLLECTIONS_MAX) {
    throw full('storefront_collections_full');
  }
  checkHomeRoom(data);
  checkListings(data, input.listingIds);
  const collection: MockCollection = {
    id: crypto.randomUUID(),
    title: input.title.normalize('NFC'),
    icon: input.icon,
    listingIds: [...input.listingIds],
    version: 1,
    updatedAt: now(),
  };
  data.storefront.collections.push(collection);
  data.storefront.home.push({ kind: 'collection', id: collection.id });
  record(
    data,
    'storefront_collection.created',
    'storefront_collection',
    collection.id,
    diff({}, collectionSnapshot(collection, collection.listingIds)),
  );
  return toCollection(data, collection);
}

export function updateCollection(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontCollectionInput,
): StorefrontCollection {
  requireShop(data);
  const before = findCollection(data, id);
  checkVersion(before.version, input.version);
  checkListings(data, input.listingIds);
  const after: MockCollection = {
    ...before,
    title: input.title.normalize('NFC'),
    icon: input.icon,
    listingIds: [...input.listingIds],
    // The listings are part of it: a form open on it should know they changed
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.collections = data.storefront.collections.map((collection) =>
    collection.id === id ? after : collection,
  );
  record(
    data,
    'storefront_collection.updated',
    'storefront_collection',
    id,
    diff(
      collectionSnapshot(before, before.listingIds),
      collectionSnapshot(after, after.listingIds),
    ),
  );
  return toCollection(data, after);
}

export function deleteCollection(data: WorkspaceData, id: string, version: number): void {
  const before = findCollection(data, id);
  checkVersion(before.version, version);
  data.storefront.collections = data.storefront.collections.filter((item) => item.id !== id);
  // Its block and its rows go with it; the listings stay
  dropBlock(data, { kind: 'collection', id });
  record(
    data,
    'storefront_collection.deleted',
    'storefront_collection',
    id,
    diff(collectionSnapshot(before, before.listingIds), {
      title: null,
      icon: null,
      listings: null,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The text pages

function toPage(data: WorkspaceData, shop: MockShop, slug: ShopTextPageSlug): StorefrontPage {
  const page = data.storefront.pages.get(slug);
  return {
    slug,
    sections: page?.sections ?? [],
    shopUrl: shopUrl(shop.subdomain, `/pages/${slug}`),
    version: page?.version ?? null,
    updatedAt: page?.updatedAt ?? null,
  };
}

// Always the four, in the footer's order, written or not
export function pageList(data: WorkspaceData): { items: StorefrontPageSummary[] } {
  const shop = requireShop(data);
  return {
    items: SHOP_TEXT_PAGES.map((slug) => {
      const { sections, ...page } = toPage(data, shop, slug);
      return { ...page, sectionCount: sections.length };
    }),
  };
}

export function textPageOf(data: WorkspaceData, slug: ShopTextPageSlug): StorefrontPage {
  return toPage(data, requireShop(data), slug);
}

export function savePage(
  data: WorkspaceData,
  tenantId: string,
  slug: ShopTextPageSlug,
  input: SaveStorefrontPageInput,
): StorefrontPage {
  const shop = requireShop(data);
  const before = data.storefront.pages.get(slug);
  // As the hero: null = "not written yet"; a page written or deleted in another tab meanwhile
  if ((before === undefined) !== (input.version === null)) {
    throw new MockProblem(409, 'version_conflict');
  }
  if (before !== undefined && input.version !== null) checkVersion(before.version, input.version);
  data.storefront.pages.set(slug, {
    sections: input.sections,
    version: before === undefined ? 1 : before.version + 1,
    updatedAt: now(),
  });
  // Keyed by the slug and built by hand, like the API: a change of the text only keeps the headings
  record(data, 'storefront.page_saved', 'storefront', tenantId, {
    [slug]: { from: headings(before?.sections), to: headings(input.sections) },
  });
  return toPage(data, shop, slug);
}

export function deletePage(
  data: WorkspaceData,
  tenantId: string,
  slug: ShopTextPageSlug,
  version: number,
): void {
  const before = data.storefront.pages.get(slug);
  if (before === undefined) throw notFound();
  checkVersion(before.version, version);
  data.storefront.pages.delete(slug);
  record(data, 'storefront.page_deleted', 'storefront', tenantId, {
    [slug]: { from: headings(before.sections), to: null },
  });
}
