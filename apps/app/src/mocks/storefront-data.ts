import {
  addMoney,
  compareQuantity,
  type CreateStorefrontCategoryInput,
  type CreateStorefrontListingInput,
  type CreateStorefrontSettingsInput,
  type CreateStorefrontUploadInput,
  type ErrorCode,
  listingPricing,
  type ShopDeliveryZone,
  slugFromName,
  STOREFRONT_IMAGE_MAX_PIXELS,
  STOREFRONT_IMAGE_MIN_SIDE,
  STOREFRONT_SLUG_MAX,
  type StorefrontCandidate,
  type storefrontCandidateQuerySchema,
  type StorefrontCategory,
  type StorefrontImage,
  type StorefrontImageView,
  type StorefrontListing,
  type storefrontListingQuerySchema,
  type StorefrontListingSummary,
  type StorefrontReadiness,
  type StorefrontSale,
  type StorefrontSettings,
  type StorefrontSetup,
  storefrontSubdomainSchema,
  type StorefrontUpload,
  type UpdateStorefrontCategoryInput,
  type UpdateStorefrontListingInput,
  type UpdateStorefrontSettingsInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import type { Workspace } from './fixtures';
import { MockProblem } from './mock';
import { pageOf } from './sales-document-data';
import { balancesOf, findVariant } from './stock-data';
import {
  type MockCategory,
  type MockListing,
  type MockPhoto,
  type MockShop,
  PLACEHOLDER,
} from './storefront-seed';
import { checkVersion, diff, record, type WorkspaceData } from './workspace-data';

// Step 26g: the workspace's online shop, with the API's rules (apps/api/src/storefront/admin/): its
// settings and launch, its categories, its listings and the photos' upload and image job. What it
// keeps, and the garments workspace's open shop, are in storefront-seed.ts.

// The shop's own address, as the API makes it in dev (shop-url.ts: SHOP_BASE_DOMAIN=localhost and
// the shop's dev port). "View shop" opens it; the mock has no shop behind it
const BASE_DOMAIN = 'localhost';
const SHOP_PORT = 4321;

function shopUrl(subdomain: string, path = ''): string {
  return `http://${subdomain}.${BASE_DOMAIN}:${String(SHOP_PORT)}${path}`;
}

// Other workspaces' shops: the API's unique index refuses their subdomains on the first save
// (storefront_subdomain_taken). "nirvor" is 26f's demo shop
const OTHER_SHOPS: ReadonlySet<string> = new Set(['nirvor']);

// How long the pretend image job takes, from "complete" to ready. The editor asks every 2
// seconds, so its first question after the upload already finds the photo ready
const MOCK_PREPARE_MS = 1_500;

function now(): string {
  return new Date().toISOString();
}

function money(value: string): string {
  return addMoney(value, '0');
}

function fieldProblem(code: ErrorCode, field: string): MockProblem {
  return new MockProblem(409, code, { [field]: [code] });
}

function notSetUp(): MockProblem {
  return new MockProblem(409, 'storefront_not_set_up');
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

// ---------------------------------------------------------------------------------------------
// Settings and the launch (settings.service.ts)

function activeWarehouse(data: WorkspaceData, id: string | null): boolean {
  return (
    id !== null &&
    data.stock.warehouses.some((place) => place.id === id && place.archivedAt === null)
  );
}

// A published listing the shop would show: its product and variant not archived
function showable(data: WorkspaceData, listing: MockListing): boolean {
  if (listing.publishedAt === null) return false;
  const found = findVariant(data, listing.variantId);
  return found?.product.archivedAt === null && found.variant.archivedAt === null;
}

function readinessOf(data: WorkspaceData, shop: MockShop): StorefrontReadiness {
  return {
    warehouse: activeWarehouse(data, shop.defaultWarehouseId),
    zone: shop.deliveryZones.length > 0,
    listing: data.storefront.listings.some((listing) => showable(data, listing)),
  };
}

function toSettings(data: WorkspaceData, shop: MockShop): StorefrontSettings {
  return { ...shop, shopUrl: shopUrl(shop.subdomain), readiness: readinessOf(data, shop) };
}

export function setupOf(data: WorkspaceData, workspace: Workspace): StorefrontSetup {
  const shop = data.storefront.shop;
  const slug = workspace.slug;
  return {
    baseDomain: BASE_DOMAIN,
    shop: shop === null ? null : toSettings(data, shop),
    suggested: {
      subdomain: storefrontSubdomainSchema.safeParse(slug).success ? slug : '',
      name: data.settings.companyName,
      hotline: data.settings.phone ?? '',
      address: data.settings.address ?? '',
    },
  };
}

// A saved zone keeps its id; a new one (or an id the shop never had) gets a new one
function zoneIds(
  input: CreateStorefrontSettingsInput['deliveryZones'],
  before: readonly ShopDeliveryZone[],
): ShopDeliveryZone[] {
  const saved = new Set(before.map((zone) => zone.id));
  const used = new Set<string>();
  return input.map((zone) => {
    let id = zone.id !== null && saved.has(zone.id) && !used.has(zone.id) ? zone.id : null;
    while (id === null || used.has(id)) id = `zone-${crypto.randomUUID().slice(0, 8)}`;
    used.add(id);
    return { id, name: zone.name, charge: money(zone.charge) };
  });
}

function fieldsOf(input: CreateStorefrontSettingsInput, before: readonly ShopDeliveryZone[]) {
  return {
    subdomain: input.subdomain,
    name: input.name.normalize('NFC'),
    language: input.language,
    hotline: input.hotline,
    address: input.address,
    facebookUrl: input.facebookUrl,
    instagramUrl: input.instagramUrl,
    xUrl: input.xUrl,
    linkedinUrl: input.linkedinUrl,
    defaultWarehouseId: input.defaultWarehouseId,
    deliveryZones: zoneIds(input.deliveryZones, before),
    freeDeliveryFrom: input.freeDeliveryFrom === null ? null : money(input.freeDeliveryFrom),
    minimumOrder: input.minimumOrder === null ? null : money(input.minimumOrder),
    paymentMethods: input.paymentMethods,
  };
}

// The audit's view, as the API's snapshot(): the lists as text
function settingsSnapshot(shop: MockShop) {
  return {
    subdomain: shop.subdomain,
    name: shop.name,
    language: shop.language,
    hotline: shop.hotline,
    address: shop.address,
    facebookUrl: shop.facebookUrl,
    instagramUrl: shop.instagramUrl,
    xUrl: shop.xUrl,
    linkedinUrl: shop.linkedinUrl,
    defaultWarehouseId: shop.defaultWarehouseId,
    deliveryZones: shop.deliveryZones.map((zone) => `${zone.name} ${zone.charge}`).join(', '),
    freeDeliveryFrom: shop.freeDeliveryFrom,
    minimumOrder: shop.minimumOrder,
    paymentMethods: shop.paymentMethods.join(', '),
  };
}

function assertSubdomainFree(subdomain: string): void {
  if (OTHER_SHOPS.has(subdomain)) throw fieldProblem('storefront_subdomain_taken', 'subdomain');
}

function assertWarehouse(data: WorkspaceData, id: string | null): void {
  if (id !== null && !activeWarehouse(data, id)) {
    throw fieldProblem('storefront_warehouse_invalid', 'defaultWarehouseId');
  }
}

export function createShop(
  data: WorkspaceData,
  tenantId: string,
  input: CreateStorefrontSettingsInput,
): StorefrontSettings {
  if (data.storefront.shop !== null) throw new MockProblem(409, 'storefront_set_up_already');
  assertWarehouse(data, input.defaultWarehouseId);
  assertSubdomainFree(input.subdomain);
  const shop: MockShop = {
    ...fieldsOf(input, []),
    launchedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.storefront.shop = shop;
  record(data, 'storefront.created', 'storefront', tenantId, diff({}, settingsSnapshot(shop)));
  return toSettings(data, shop);
}

export function updateShop(
  data: WorkspaceData,
  tenantId: string,
  input: UpdateStorefrontSettingsInput,
): StorefrontSettings {
  const before = data.storefront.shop;
  if (before === null) throw notSetUp();
  checkVersion(before.version, input.version);
  // A launched shop counts its stock somewhere and delivers somewhere
  if (before.launchedAt !== null) {
    if (input.defaultWarehouseId === null) {
      throw fieldProblem('storefront_warehouse_invalid', 'defaultWarehouseId');
    }
    if (input.deliveryZones.length === 0) throw fieldProblem('too_short', 'deliveryZones');
  }
  // Only a new warehouse is checked: the saved one may have been archived since
  if (input.defaultWarehouseId !== before.defaultWarehouseId) {
    assertWarehouse(data, input.defaultWarehouseId);
  }
  if (input.subdomain !== before.subdomain) assertSubdomainFree(input.subdomain);
  const after: MockShop = {
    ...before,
    ...fieldsOf(input, before.deliveryZones),
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.shop = after;
  record(
    data,
    'storefront.updated',
    'storefront',
    tenantId,
    diff(settingsSnapshot(before), settingsSnapshot(after)),
  );
  return toSettings(data, after);
}

export function launchShop(
  data: WorkspaceData,
  tenantId: string,
  version: number,
): StorefrontSettings {
  const before = data.storefront.shop;
  if (before === null) throw notSetUp();
  checkVersion(before.version, version);
  // A second click, or two tabs: open already
  if (before.launchedAt !== null) return toSettings(data, before);
  const ready = readinessOf(data, before);
  if (!ready.warehouse || !ready.zone || !ready.listing) {
    throw new MockProblem(409, 'storefront_launch_not_ready');
  }
  const after: MockShop = {
    ...before,
    launchedAt: now(),
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.shop = after;
  record(
    data,
    'storefront.launched',
    'storefront',
    tenantId,
    diff({ launched: false }, { launched: true }),
  );
  return toSettings(data, after);
}

// ---------------------------------------------------------------------------------------------
// Categories (categories.service.ts)

// position, then name, then id: the shop's order, and never a tie
function byPlace(a: MockCategory, b: MockCategory): number {
  return a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function categoryList(data: WorkspaceData): StorefrontCategory[] {
  return data.storefront.categories.toSorted(byPlace).map((category) => ({
    ...category,
    listingCount: data.storefront.listings.filter((item) => item.categoryId === category.id).length,
  }));
}

function findCategory(data: WorkspaceData, id: string): MockCategory {
  const found = data.storefront.categories.find((category) => category.id === id);
  if (!found) throw notFound();
  return found;
}

function presentCategory(data: WorkspaceData, category: MockCategory): StorefrontCategory {
  const found = categoryList(data).find((item) => item.id === category.id);
  if (!found) throw notFound();
  return found;
}

// The two unique indexes: the slug in the workspace, the name among its siblings (any case)
function assertCategoryFree(
  data: WorkspaceData,
  input: CreateStorefrontCategoryInput,
  except?: string,
): void {
  const others = data.storefront.categories.filter((category) => category.id !== except);
  if (others.some((category) => category.slug === input.slug)) {
    throw fieldProblem('storefront_slug_taken', 'slug');
  }
  const name = input.name.toLowerCase();
  if (
    others.some(
      (category) => category.parentId === input.parentId && category.name.toLowerCase() === name,
    )
  ) {
    throw fieldProblem('category_name_taken', 'name');
  }
}

function endOf(data: WorkspaceData, parentId: string | null): number {
  const siblings = data.storefront.categories.filter((category) => category.parentId === parentId);
  return Math.max(0, ...siblings.map((category) => category.position)) + 1;
}

function nameOfParent(data: WorkspaceData, parentId: string | null): string | null {
  if (parentId === null) return null;
  return data.storefront.categories.find((category) => category.id === parentId)?.name ?? null;
}

export function createCategory(
  data: WorkspaceData,
  input: CreateStorefrontCategoryInput,
): StorefrontCategory {
  if (input.parentId !== null && !data.storefront.categories.some((c) => c.id === input.parentId)) {
    throw fieldProblem('category_parent_invalid', 'parentId');
  }
  assertCategoryFree(data, input);
  const category: MockCategory = {
    id: crypto.randomUUID(),
    parentId: input.parentId,
    slug: input.slug,
    name: input.name.normalize('NFC'),
    position: endOf(data, input.parentId),
    version: 1,
    updatedAt: now(),
  };
  data.storefront.categories.push(category);
  record(
    data,
    'storefront_category.created',
    'storefront_category',
    category.id,
    diff(
      {},
      { name: category.name, slug: category.slug, parent: nameOfParent(data, input.parentId) },
    ),
  );
  return presentCategory(data, category);
}

export function updateCategory(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontCategoryInput,
): StorefrontCategory {
  const before = findCategory(data, id);
  checkVersion(before.version, input.version);
  const moved = input.parentId !== before.parentId;
  if (moved && input.parentId !== null) {
    if (!data.storefront.categories.some((category) => category.id === input.parentId)) {
      throw fieldProblem('category_parent_invalid', 'parentId');
    }
    // Up from the new parent: meeting the category itself means it would go under itself
    for (let at: string | null = input.parentId; at !== null;) {
      if (at === id) throw fieldProblem('category_parent_loop', 'parentId');
      at = data.storefront.categories.find((category) => category.id === at)?.parentId ?? null;
    }
  }
  assertCategoryFree(data, input, id);
  const after: MockCategory = {
    ...before,
    parentId: input.parentId,
    slug: input.slug,
    name: input.name.normalize('NFC'),
    // A new parent: the end of its list, with everything under it coming along
    position: moved ? endOf(data, input.parentId) : before.position,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.categories = data.storefront.categories.map((category) =>
    category.id === id ? after : category,
  );
  record(
    data,
    'storefront_category.updated',
    'storefront_category',
    id,
    diff(
      { name: before.name, slug: before.slug, parent: nameOfParent(data, before.parentId) },
      { name: after.name, slug: after.slug, parent: nameOfParent(data, after.parentId) },
    ),
  );
  return presentCategory(data, after);
}

// A swap with the sibling above or below. The siblings are numbered 1, 2, 3… in their order first,
// so two equal positions still swap; a row whose number changes gets a new version
export function moveCategory(
  data: WorkspaceData,
  id: string,
  direction: 'up' | 'down',
  version: number,
): StorefrontCategory[] {
  const category = findCategory(data, id);
  checkVersion(category.version, version);
  const siblings = data.storefront.categories
    .filter((item) => item.parentId === category.parentId)
    .toSorted(byPlace);
  const from = siblings.findIndex((item) => item.id === id);
  const to = direction === 'up' ? from - 1 : from + 1;
  const neighbour = siblings[to];
  // Already first or last: nothing to do
  if (neighbour === undefined) return categoryList(data);
  const order = siblings.map((item) => item.id);
  order[from] = neighbour.id;
  order[to] = id;
  const positions = new Map(order.map((rowId, index) => [rowId, index + 1]));
  data.storefront.categories = data.storefront.categories.map((item) => {
    const position = positions.get(item.id);
    if (position === undefined || position === item.position) return item;
    return { ...item, position, version: item.version + 1, updatedAt: now() };
  });
  record(
    data,
    'storefront_category.moved',
    'storefront_category',
    id,
    diff({ position: from + 1 }, { position: to + 1 }),
  );
  return categoryList(data);
}

export function removeCategory(data: WorkspaceData, id: string, version: number): void {
  const before = findCategory(data, id);
  checkVersion(before.version, version);
  // The two foreign keys the API maps to these codes
  if (data.storefront.categories.some((category) => category.parentId === id)) {
    throw new MockProblem(409, 'category_has_children');
  }
  if (data.storefront.listings.some((listing) => listing.categoryId === id)) {
    throw new MockProblem(409, 'storefront_category_in_use');
  }
  data.storefront.categories = data.storefront.categories.filter((category) => category.id !== id);
  record(
    data,
    'storefront_category.deleted',
    'storefront_category',
    id,
    diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
  );
}

// ---------------------------------------------------------------------------------------------
// Photos (images.service.ts and the image job)

export function startUpload(data: WorkspaceData, input: CreateStorefrontUploadInput): string {
  const id = crypto.randomUUID();
  data.storefront.photos.set(id, {
    id,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    url: null,
    outcome: null,
    readyAt: null,
  });
  return id;
}

// What the job would find in the file: whether it decodes, and its size against the limits. The
// browser decodes it (createImageBitmap), so a real photo is ready and a broken file fails, as with
// sharp. EXIF turns are not looked at: the mock never writes the shop's sizes
async function inspect(blob: Blob): Promise<NonNullable<MockPhoto['outcome']>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return { kind: 'failed', code: 'storefront_image_unreadable' };
  }
  const { width, height } = bitmap;
  bitmap.close();
  if (width * height > STOREFRONT_IMAGE_MAX_PIXELS) {
    return { kind: 'failed', code: 'storefront_image_too_many_pixels' };
  }
  if (Math.min(width, height) < STOREFRONT_IMAGE_MIN_SIDE) {
    return { kind: 'failed', code: 'storefront_image_too_small' };
  }
  return { kind: 'ready', width, height };
}

// The PUT to storage. false = no such upload in this workspace (the handler answers 404)
export async function receivePhoto(data: WorkspaceData, id: string, blob: Blob): Promise<boolean> {
  const photo = data.storefront.photos.get(id);
  if (!photo) return false;
  photo.url = URL.createObjectURL(blob);
  photo.outcome = await inspect(blob);
  return true;
}

function photoOf(data: WorkspaceData, id: string): MockPhoto {
  const photo = data.storefront.photos.get(id);
  if (!photo) throw notFound();
  return photo;
}

function stateOf(photo: MockPhoto): StorefrontUpload {
  const { id } = photo;
  if (photo.readyAt === null) return { id, status: 'uploading' };
  if (Date.now() < photo.readyAt || photo.outcome === null || photo.url === null) {
    return { id, status: 'processing' };
  }
  return photo.outcome.kind === 'ready'
    ? {
        id,
        status: 'ready',
        url: photo.url,
        width: photo.outcome.width,
        height: photo.outcome.height,
      }
    : { id, status: 'failed', code: photo.outcome.code };
}

// "complete": the file must be there. A second confirm starts nothing new (the API's
// ON CONFLICT DO NOTHING on the job's row)
export function completeUpload(data: WorkspaceData, id: string): StorefrontUpload {
  const photo = photoOf(data, id);
  if (photo.url === null) throw new MockProblem(409, 'upload_incomplete');
  photo.readyAt ??= Date.now() + MOCK_PREPARE_MS;
  return stateOf(photo);
}

export function uploadState(data: WorkspaceData, id: string): StorefrontUpload {
  return stateOf(photoOf(data, id));
}

function isReady(data: WorkspaceData, id: string): boolean {
  const photo = data.storefront.photos.get(id);
  return photo !== undefined && stateOf(photo).status === 'ready';
}

// A saved photo as the editor shows it: the file's address. A seeded photo has a drawn one
function viewOf(data: WorkspaceData, image: StorefrontImage): StorefrontImageView {
  return { ...image, url: data.storefront.photos.get(image.id)?.url ?? PLACEHOLDER };
}

// ---------------------------------------------------------------------------------------------
// Listings (listings.service.ts)

type ListingQuery = z.output<typeof storefrontListingQuerySchema>;
type CandidateQuery = z.output<typeof storefrontCandidateQuerySchema>;

function optionsText(values: readonly string[]): string {
  return values.join(' · ');
}

function stockOf(data: WorkspaceData, variantId: string): boolean | null {
  const warehouseId = data.storefront.shop?.defaultWarehouseId ?? null;
  if (warehouseId === null) return null;
  const onHand = balancesOf(data.stock).byPlace.get(`${warehouseId}|${variantId}`) ?? '0';
  return compareQuantity(onHand, '0') > 0;
}

function sold(data: WorkspaceData, listing: MockListing) {
  const found = findVariant(data, listing.variantId);
  if (!found) throw new Error(`The listing ${listing.slug} sells a variant the catalog lost`);
  return found;
}

function regularOf(data: WorkspaceData, listing: MockListing): string | null {
  return listing.priceOverride ?? sold(data, listing).variant.salePrice;
}

function categoryName(data: WorkspaceData, id: string): string {
  return data.storefront.categories.find((category) => category.id === id)?.name ?? '';
}

function toSummary(data: WorkspaceData, listing: MockListing): StorefrontListingSummary {
  const [first] = listing.images;
  const regular = regularOf(data, listing);
  const priced = regular === null ? null : listingPricing(regular, listing.sale, new Date());
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    packSize: listing.packSize,
    sku: sold(data, listing).variant.sku,
    categoryId: listing.categoryId,
    categoryName: categoryName(data, listing.categoryId),
    image: first === undefined ? null : viewOf(data, first),
    price: priced?.price ?? null,
    compareAtPrice: priced?.compareAtPrice ?? null,
    inStock: stockOf(data, listing.variantId),
    status: listing.publishedAt === null ? 'draft' : 'published',
    publishedAt: listing.publishedAt,
    updatedAt: listing.updatedAt,
  };
}

function toListing(data: WorkspaceData, listing: MockListing): StorefrontListing {
  const shop = data.storefront.shop;
  if (shop === null) throw notSetUp();
  const { product, variant } = sold(data, listing);
  return {
    id: listing.id,
    product: {
      id: product.id,
      name: product.name,
      status: product.archivedAt !== null || variant.archivedAt !== null ? 'archived' : 'active',
    },
    variant: {
      id: variant.id,
      sku: variant.sku,
      name: optionsText(variant.optionValues),
      salePrice: variant.salePrice,
    },
    categoryId: listing.categoryId,
    slug: listing.slug,
    name: listing.name,
    packSize: listing.packSize,
    priceOverride: listing.priceOverride,
    sale: listing.sale,
    badges: listing.badges,
    images: listing.images.map((image) => viewOf(data, image)),
    descriptionSections: listing.descriptionSections,
    seoTitle: listing.seoTitle,
    seoDescription: listing.seoDescription,
    inStock: stockOf(data, listing.variantId),
    status: listing.publishedAt === null ? 'draft' : 'published',
    publishedAt: listing.publishedAt,
    shopUrl: shopUrl(shop.subdomain, `/p/${listing.slug}`),
    version: listing.version,
    updatedAt: listing.updatedAt,
  };
}

function findListing(data: WorkspaceData, id: string): MockListing {
  const found = data.storefront.listings.find((listing) => listing.id === id);
  if (!found) throw notFound();
  return found;
}

// The sort keys of the API's ORDERS: the first 60 characters of the name, without case, then id
function nameKey(listing: MockListing): string {
  return listing.name.toLowerCase().slice(0, 60);
}

const SORTS = {
  '-updated': (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
  name: (a, b) =>
    nameKey(a) < nameKey(b) ? -1 : nameKey(a) > nameKey(b) ? 1 : a.id.localeCompare(b.id),
  '-name': (a, b) =>
    nameKey(a) < nameKey(b) ? 1 : nameKey(a) > nameKey(b) ? -1 : b.id.localeCompare(a.id),
} satisfies Record<ListingQuery['sort'], (a: MockListing, b: MockListing) => number>;

export function listingPage(
  data: WorkspaceData,
  query: ListingQuery,
): { items: StorefrontListingSummary[]; nextCursor: string | null } {
  const search = query.search?.normalize('NFC').toLowerCase() ?? '';
  const found = data.storefront.listings.filter((listing) => {
    if (query.status === 'published' && listing.publishedAt === null) return false;
    if (query.status === 'draft' && listing.publishedAt !== null) return false;
    if (query.categoryId !== undefined && listing.categoryId !== query.categoryId) return false;
    if (search === '') return true;
    return (
      listing.name.toLowerCase().includes(search) ||
      listing.slug.includes(search) ||
      sold(data, listing).variant.sku.toLowerCase().includes(search)
    );
  });
  const page = pageOf(found.toSorted(SORTS[query.sort]), query);
  return {
    items: page.items.map((listing) => toSummary(data, listing)),
    nextCursor: page.nextCursor,
  };
}

// "Add to shop"'s search: active goods not in the shop yet, by name or SKU, A to Z
export function candidatePage(
  data: WorkspaceData,
  query: CandidateQuery,
): { items: StorefrontCandidate[]; nextCursor: string | null } {
  const search = query.search?.normalize('NFC').toLowerCase() ?? '';
  const listed = new Set(data.storefront.listings.map((listing) => listing.variantId));
  // Each with its sort key, the API's: the first 60 characters of the product's name, then the id
  const found: { key: string; candidate: StorefrontCandidate }[] = [];
  for (const product of data.catalog.products) {
    if (product.type !== 'goods' || product.archivedAt !== null) continue;
    const named = search === '' || product.name.toLowerCase().includes(search);
    for (const variant of product.variants) {
      if (variant.archivedAt !== null || listed.has(variant.id)) continue;
      if (!named && !variant.sku.toLowerCase().includes(search)) continue;
      found.push({
        key: product.name.toLowerCase().slice(0, 60),
        candidate: {
          variantId: variant.id,
          productId: product.id,
          name: [product.name, optionsText(variant.optionValues)].filter(Boolean).join(' · '),
          sku: variant.sku,
          salePrice: variant.salePrice,
        },
      });
    }
  }
  found.sort((a, b) =>
    a.key < b.key
      ? -1
      : a.key > b.key
        ? 1
        : a.candidate.variantId.localeCompare(b.candidate.variantId),
  );
  const page = pageOf(found, query);
  return { items: page.items.map((item) => item.candidate), nextCursor: page.nextCursor };
}

function listingSnapshot(listing: MockListing) {
  const sale = listing.sale;
  return {
    name: listing.name,
    slug: listing.slug,
    packSize: listing.packSize,
    categoryId: listing.categoryId,
    priceOverride: listing.priceOverride,
    sale:
      sale === null
        ? null
        : [
            sale.kind,
            sale.value,
            sale.startsAt === null ? '-' : new Date(sale.startsAt).toISOString(),
            sale.endsAt === null ? '-' : new Date(sale.endsAt).toISOString(),
          ].join(' '),
    badges: listing.badges.join(', '),
    images: listing.images.map((image) => image.id).join(', '),
    sections: listing.descriptionSections.length,
    seoTitle: listing.seoTitle,
    seoDescription: listing.seoDescription,
  };
}

// slug-from-name, then the SKU's, then "listing"; the first of slug, slug-2, slug-3… free
function freeSlug(data: WorkspaceData, name: string, sku: string): string {
  const base = slugFromName(name) || slugFromName(sku) || 'listing';
  const taken = new Set(data.storefront.listings.map((listing) => listing.slug));
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '' : `-${String(n)}`;
    const slug = `${base.slice(0, STOREFRONT_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(slug)) return slug;
  }
}

export function createListing(
  data: WorkspaceData,
  input: CreateStorefrontListingInput,
): StorefrontListing {
  if (data.storefront.shop === null) throw notSetUp();
  const found = findVariant(data, input.variantId);
  // A service, like another workspace's variant, is "not found"
  if (found?.product.type !== 'goods') throw fieldProblem('required', 'variantId');
  if (found.product.archivedAt !== null || found.variant.archivedAt !== null) {
    throw fieldProblem('storefront_variant_archived', 'variantId');
  }
  if (!data.storefront.categories.some((category) => category.id === input.categoryId)) {
    throw fieldProblem('storefront_category_invalid', 'categoryId');
  }
  if (data.storefront.listings.some((listing) => listing.variantId === input.variantId)) {
    throw fieldProblem('storefront_variant_listed', 'variantId');
  }
  const name = [found.product.name, optionsText(found.variant.optionValues)]
    .filter(Boolean)
    .join(' · ')
    .normalize('NFC');
  const listing: MockListing = {
    id: crypto.randomUUID(),
    productId: found.product.id,
    variantId: found.variant.id,
    categoryId: input.categoryId,
    slug: freeSlug(data, name, found.variant.sku),
    name,
    packSize: '',
    priceOverride: null,
    sale: null,
    badges: [],
    images: [],
    descriptionSections: [],
    seoTitle: null,
    seoDescription: null,
    publishedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.storefront.listings.push(listing);
  record(
    data,
    'storefront_listing.created',
    'storefront_listing',
    listing.id,
    diff({}, { ...listingSnapshot(listing), variant: found.variant.sku }),
  );
  return toListing(data, listing);
}

export function listingOf(data: WorkspaceData, id: string): StorefrontListing {
  if (data.storefront.shop === null) throw notSetUp();
  return toListing(data, findListing(data, id));
}

// The sale's value as the table gives it back: a percent as typed, an amount with 4 decimals
function saleToKeep(sale: StorefrontSale | null): StorefrontSale | null {
  if (sale === null) return null;
  const dates = {
    startsAt: sale.startsAt === null ? null : new Date(sale.startsAt).toISOString(),
    endsAt: sale.endsAt === null ? null : new Date(sale.endsAt).toISOString(),
  };
  return sale.kind === 'percent'
    ? { kind: 'percent', value: sale.value, ...dates }
    : { kind: sale.kind, value: money(sale.value), ...dates };
}

export function updateListing(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontListingInput,
): StorefrontListing {
  if (data.storefront.shop === null) throw notSetUp();
  const before = findListing(data, id);
  checkVersion(before.version, input.version);
  if (
    input.categoryId !== before.categoryId &&
    !data.storefront.categories.some((category) => category.id === input.categoryId)
  ) {
    throw fieldProblem('storefront_category_invalid', 'categoryId');
  }
  // Every new photo is this workspace's and ready; the saved ones are not asked again
  const saved = new Set(before.images.map((image) => image.id));
  const fieldErrors: Record<string, ErrorCode[]> = {};
  input.images.forEach((image, index) => {
    if (!saved.has(image.id) && !isReady(data, image.id)) {
      fieldErrors[`images.${String(index)}`] = ['storefront_image_not_ready'];
    }
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw new MockProblem(409, 'storefront_image_not_ready', fieldErrors);
  }
  const published = before.publishedAt !== null;
  if (published && input.images.length === 0) {
    throw fieldProblem('storefront_listing_needs_photo', 'images');
  }
  const regular = input.priceOverride ?? sold(data, before).variant.salePrice;
  if (published && regular === null)
    throw fieldProblem('storefront_listing_no_price', 'priceOverride');
  if (input.sale !== null) {
    if (regular === null) throw fieldProblem('storefront_listing_no_price', 'priceOverride');
    // Checked without its dates: a sale that starts next week must already be lower
    const priced = listingPricing(
      regular,
      { ...input.sale, startsAt: null, endsAt: null },
      new Date(),
    );
    if (priced.compareAtPrice === null)
      throw fieldProblem('storefront_sale_not_lower', 'sale.value');
  }
  if (
    data.storefront.listings.some((listing) => listing.id !== id && listing.slug === input.slug)
  ) {
    throw fieldProblem('storefront_slug_taken', 'slug');
  }
  const after: MockListing = {
    ...before,
    name: input.name.normalize('NFC'),
    slug: input.slug,
    packSize: input.packSize,
    categoryId: input.categoryId,
    priceOverride: input.priceOverride === null ? null : money(input.priceOverride),
    sale: saleToKeep(input.sale),
    badges: input.badges,
    images: input.images,
    descriptionSections: input.descriptionSections,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.listings = data.storefront.listings.map((listing) =>
    listing.id === id ? after : listing,
  );
  record(
    data,
    'storefront_listing.updated',
    'storefront_listing',
    id,
    diff(listingSnapshot(before), listingSnapshot(after)),
  );
  return toListing(data, after);
}

export function setPublished(
  data: WorkspaceData,
  id: string,
  version: number,
  on: boolean,
): StorefrontListing {
  if (data.storefront.shop === null) throw notSetUp();
  const before = findListing(data, id);
  checkVersion(before.version, version);
  // Already so (a second click, two tabs)
  if ((before.publishedAt !== null) === on) return toListing(data, before);
  if (on) {
    const { product, variant } = sold(data, before);
    if (product.archivedAt !== null || variant.archivedAt !== null) {
      throw new MockProblem(409, 'storefront_variant_archived');
    }
    if (before.images.length === 0) throw new MockProblem(409, 'storefront_listing_needs_photo');
    if (regularOf(data, before) === null) throw new MockProblem(409, 'storefront_listing_no_price');
  }
  const after: MockListing = {
    ...before,
    publishedAt: on ? now() : null,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.listings = data.storefront.listings.map((listing) =>
    listing.id === id ? after : listing,
  );
  record(
    data,
    on ? 'storefront_listing.published' : 'storefront_listing.unpublished',
    'storefront_listing',
    id,
    diff({ published: !on }, { published: on }),
  );
  return toListing(data, after);
}

export function removeListing(data: WorkspaceData, id: string, version: number): void {
  const before = findListing(data, id);
  checkVersion(before.version, version);
  data.storefront.listings = data.storefront.listings.filter((listing) => listing.id !== id);
  record(
    data,
    'storefront_listing.deleted',
    'storefront_listing',
    id,
    diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
  );
}
