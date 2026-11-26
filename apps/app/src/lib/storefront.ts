import {
  contractErrorMap,
  createStorefrontUploadInputSchema,
  type ErrorCode,
  isErrorCode,
  isMoneyAmount,
  isZeroMoney,
  listingPricing,
  type ListingPricing,
  routes,
  shiftIsoDate,
  type StorefrontCategory,
  type StorefrontCouponView,
  type StorefrontListing,
  type StorefrontListingSort,
  type StorefrontSale,
  storefrontSaleSchema,
  type StorefrontSettingsFormValues,
  type StorefrontUpload,
  type StorefrontSetup,
  todayIn,
  updateStorefrontListingInputSchema,
} from '@omnivo/contracts';
import { buildTree, flattenTree, type TreeNode } from '@omnivo/ui';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';

import { ApiRequestError, call } from './api';

// Step 26g: the Storefront menu's reads, form values and the photo upload. Its own file like
// pos-queries.ts: only the four storefront pages load it. Every key starts with
// ['storefront', tenantId], so one invalidate after a save refreshes the whole menu.

// ---------------------------------------------------------------------------------------------
// Reads

export function storefrontSetupQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'settings'],
    queryFn: () => call(routes.storefront.getSettings),
  });
}

// Step 27d: the Online payment card's read (the saved gateway, never its password, and the two
// account selects' choices). Under the same ['storefront', tenantId] key, so a save refreshes it
export function storefrontPaymentSetupQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payment-gateway'],
    queryFn: () => call(routes.storefrontPayments.getPaymentGateway),
  });
}

// Step 28a: the Shop couriers page's one read (every account, archived ones too, and the default)
export function storefrontCouriersQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'couriers'],
    queryFn: () => call(routes.shipping.getCouriers),
  });
}

export function storefrontCategoriesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'categories'],
    queryFn: async () => (await call(routes.storefront.listCategories)).items,
  });
}

export interface ListingFilter {
  search: string;
  status: 'all' | 'published' | 'draft';
  // '' = every category
  categoryId: string;
  sort: StorefrontListingSort;
}

export function storefrontListingsQuery(tenantId: string, filter: ListingFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'listings', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefront.listListings, {
        query: {
          limit: 50,
          status: filter.status,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(filter.categoryId !== '' && { categoryId: filter.categoryId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A new filter keeps the old rows until its first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

// Step 27c: the Coupons page, a page at a time, newest first (the contract's only order). The key
// is under ['storefront', tenantId] like the rest of the menu, so useStorefrontRefresh() after a
// save, an archive or a restore reads it again
export interface CouponFilter {
  view: StorefrontCouponView;
  search: string;
}

export function storefrontCouponsQuery(tenantId: string, filter: CouponFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'coupons', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefrontCoupons.listCoupons, {
        query: {
          limit: 50,
          view: filter.view,
          ...(filter.search !== '' && { search: filter.search }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // The other tab keeps the old rows until its first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

export function storefrontListingQuery(tenantId: string, listingId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'listing', listingId],
    queryFn: () => call(routes.storefront.getListing, { params: { id: listingId } }),
  });
}

// "Add to shop": the first 20 active variants not in the shop yet that match the search
export function storefrontCandidatesQuery(tenantId: string, search: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'candidates', search],
    queryFn: async () =>
      (
        await call(routes.storefront.listCandidates, {
          query: { limit: 20, ...(search !== '' && { search }) },
        })
      ).items,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------------------------
// Categories

// The API sends the categories in their order (position among siblings), so the tree keeps it
export function storefrontCategoryTree(
  categories: readonly StorefrontCategory[],
): TreeNode<StorefrontCategory>[] {
  return buildTree(categories, {
    id: (category) => category.id,
    parentId: (category) => category.parentId,
    compare: (a, b) => a.position - b.position,
  });
}

// "Skin care › Face wash": the path a select shows, so two "Others" under different parents differ.
// `moving` leaves out a category and everything under it: it cannot go inside itself
export function storefrontCategoryOptions(
  categories: readonly StorefrontCategory[],
  moving?: string,
): { value: string; label: string }[] {
  const without = (
    nodes: readonly TreeNode<StorefrontCategory>[],
  ): TreeNode<StorefrontCategory>[] =>
    nodes.flatMap((node) =>
      node.id === moving ? [] : [{ ...node, children: without(node.children) }],
    );
  const byId = new Map(categories.map((category) => [category.id, category]));
  const path = (category: StorefrontCategory): string => {
    const parent = category.parentId === null ? undefined : byId.get(category.parentId);
    return parent ? `${path(parent)} › ${category.name}` : category.name;
  };
  return flattenTree(without(storefrontCategoryTree(categories))).map(({ node }) => ({
    value: node.id,
    label: path(node.item),
  }));
}

// Whether Move up / Move down can do anything: the first and the last of its siblings cannot
export function siblingPlace(
  categories: readonly StorefrontCategory[],
  category: StorefrontCategory,
): { first: boolean; last: boolean } {
  const siblings = categories
    .filter((item) => item.parentId === category.parentId)
    .sort((a, b) => a.position - b.position);
  return {
    first: siblings[0]?.id === category.id,
    last: siblings.at(-1)?.id === category.id,
  };
}

// ---------------------------------------------------------------------------------------------
// Settings

// The form starts from the saved shop, or before the first save from what the API suggests (the
// workspace's slug, name, phone and address). version 1 for a new shop passes the update schema;
// the create route never reads it (the page strips it)
export function settingsFormValues(
  setup: StorefrontSetup,
  language: 'en' | 'bn',
): StorefrontSettingsFormValues {
  const shop = setup.shop;
  if (shop === null) {
    return {
      subdomain: setup.suggested.subdomain,
      name: setup.suggested.name,
      language,
      hotline: setup.suggested.hotline,
      address: setup.suggested.address,
      facebookUrl: '',
      instagramUrl: '',
      xUrl: '',
      linkedinUrl: '',
      defaultWarehouseId: '',
      // One empty zone to start from: no shop opens without one, and an empty row says what to type
      deliveryZones: [{ id: null, name: '', charge: '' }],
      freeDeliveryFrom: '',
      minimumOrder: '',
      paymentMethods: ['cod'],
      // Step 27b (decision 4): none picked; the first order with a charge makes "Delivery charge"
      deliveryVariantId: '',
      version: 1,
    };
  }
  return {
    subdomain: shop.subdomain,
    name: shop.name,
    language: shop.language,
    hotline: shop.hotline,
    address: shop.address,
    facebookUrl: shop.facebookUrl ?? '',
    instagramUrl: shop.instagramUrl ?? '',
    xUrl: shop.xUrl ?? '',
    linkedinUrl: shop.linkedinUrl ?? '',
    defaultWarehouseId: shop.defaultWarehouseId ?? '',
    deliveryZones: shop.deliveryZones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      charge: plainAmount(zone.charge),
    })),
    freeDeliveryFrom: plainAmount(shop.freeDeliveryFrom ?? ''),
    minimumOrder: plainAmount(shop.minimumOrder ?? ''),
    paymentMethods: shop.paymentMethods,
    // null (none picked yet) is the select's empty choice, ''
    deliveryVariantId: shop.deliveryVariantId ?? '',
    version: shop.version,
  };
}

// The API keeps money with 4 decimals ("80.0000"); a box shows what a person would type ("80",
// "80.50"). Not rounding: only zeros at the end go
export function plainAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

// ---------------------------------------------------------------------------------------------
// Sale dates: whole days in the workspace's time zone (decision 34)

// The time zone's offset from UTC at one moment, in ms (Dhaka: +6 h)
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? '0');
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(ms / 1000) * 1000;
}

// The first moment of a day in a time zone, as the API takes it ("2026-11-30" in Asia/Dhaka →
// "2026-11-29T18:00:00.000Z"). Two passes: the second uses the offset at the answer itself, which
// is different from the first guess's on a day a clock moves (summer time; not Bangladesh, but a
// workspace may pick any zone)
export function startOfDayIn(isoDate: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`not an ISO date: ${isoDate}`);
  const midnightUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const first = midnightUtc - offsetAt(midnightUtc, timeZone);
  return new Date(midnightUtc - offsetAt(first, timeZone)).toISOString();
}

export const SALE_FORM_KINDS = ['none', 'percent', 'amount', 'price'] as const;
export type SaleFormKind = (typeof SALE_FORM_KINDS)[number];

// The sale as the form holds it: a kind ('none' = no sale), the value box, and two day boxes. The
// days are named like the API's fields, so the API's and the schema's errors (sale.endsAt: "the
// end is before the start") land on the right box
export interface SaleForm {
  kind: SaleFormKind;
  value: string;
  // ISO dates, '' = empty box
  startsAt: string;
  endsAt: string;
}

export function saleToForm(sale: StorefrontSale | null, timeZone: string): SaleForm {
  if (sale === null) return { kind: 'none', value: '', startsAt: '', endsAt: '' };
  return {
    kind: sale.kind,
    value: sale.kind === 'percent' ? sale.value : plainAmount(sale.value),
    startsAt: sale.startsAt === null ? '' : todayIn(timeZone, new Date(sale.startsAt)),
    // The end is the first moment after the last day, so the last day is the one before it
    endsAt: sale.endsAt === null ? '' : todayIn(timeZone, new Date(Date.parse(sale.endsAt) - 1)),
  };
}

// From: the day's first moment. Until: the first moment of the day after, so the last day counts
export function saleFromForm(form: SaleForm, timeZone: string): StorefrontSale | null {
  if (form.kind === 'none') return null;
  return {
    kind: form.kind,
    value: form.value,
    startsAt: form.startsAt === '' ? null : startOfDayIn(form.startsAt, timeZone),
    endsAt: form.endsAt === '' ? null : startOfDayIn(shiftIsoDate(form.endsAt, 1), timeZone),
  };
}

// ---------------------------------------------------------------------------------------------
// The listing's form

// The update schema's fields before its own checks (zod's ZodPipe keeps them in `.in`), with the
// sale as the form holds it. The transform turns the form's sale into the API's, and the pipe then
// runs the real schema: the slug made from the name, the sale's value and dates, the photos. Its
// errors keep their paths (sale.value, sale.endsAt, images.0.alt), which are the form's names
const saleFormSchema = z.object({
  kind: z.enum(SALE_FORM_KINDS),
  value: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
});

export function listingFormSchema(timeZone: string) {
  // A new object from the fields (`shape`), not `.extend()`: zod refuses to extend an object that
  // has a refinement, and the slug check is one. The pipe runs that check anyway
  return z
    .object({ ...updateStorefrontListingInputSchema.in.shape, sale: saleFormSchema })
    .transform(({ sale, ...fields }) => ({ ...fields, sale: saleFromForm(sale, timeZone) }))
    .pipe(updateStorefrontListingInputSchema);
}

export type ListingFormValues = z.input<ReturnType<typeof listingFormSchema>>;

export function listingFormValues(listing: StorefrontListing, timeZone: string): ListingFormValues {
  return {
    version: listing.version,
    name: listing.name,
    slug: listing.slug,
    packSize: listing.packSize,
    categoryId: listing.categoryId,
    priceOverride: plainAmount(listing.priceOverride ?? ''),
    sale: saleToForm(listing.sale, timeZone),
    badges: listing.badges,
    // The form keeps {id, alt}; the page keeps the photos' addresses next to it
    images: listing.images.map((image) => ({ id: image.id, alt: image.alt })),
    descriptionSections: listing.descriptionSections,
    seoTitle: listing.seoTitle ?? '',
    seoDescription: listing.seoDescription ?? '',
  };
}

// The "In the shop now" card, from what the form holds this moment: the regular price is the
// listing's own price when the box has a usable one, else the product's sale price. A sale the
// form cannot read yet (a half-typed value, "From" after "Until") is left out until it can
export type PricePreview =
  | { kind: 'none' }
  | {
      kind: 'priced';
      pricing: ListingPricing;
      regular: string;
      // Why the sale is not on now, when there is one: it starts later or it has ended
      sale: 'on' | 'later' | 'ended' | 'none';
    };

export function pricePreview(
  priceOverride: string,
  salePrice: string | null,
  sale: SaleForm,
  timeZone: string,
  now: Date,
): PricePreview {
  const own = priceOverride.trim();
  const regular = own !== '' && isMoneyAmount(own) && !isZeroMoney(own) ? own : salePrice;
  if (regular === null) return { kind: 'none' };
  const parsed =
    sale.kind === 'none' ? null : storefrontSaleSchema.safeParse(saleFromForm(sale, timeZone));
  const live = parsed?.success === true ? parsed.data : null;
  const pricing = listingPricing(regular, live, now);
  let state: 'on' | 'later' | 'ended' | 'none' = 'none';
  if (live !== null) {
    if (pricing.compareAtPrice !== null) state = 'on';
    else if (live.startsAt !== null && now.getTime() < Date.parse(live.startsAt)) state = 'later';
    else if (live.endsAt !== null && now.getTime() >= Date.parse(live.endsAt)) state = 'ended';
  }
  return { kind: 'priced', pricing, regular, sale: state };
}

// ---------------------------------------------------------------------------------------------
// Photos

// A photo in the form, as the page tracks it: the upload, then the server's job
export type PhotoState =
  | { status: 'uploading' }
  | { status: 'processing' }
  | { status: 'ready'; url: string }
  | { status: 'failed'; code: ErrorCode };

function uploadError(code: ErrorCode): ApiRequestError {
  return new ApiRequestError({ title: 'Upload failed', status: 0, detail: code, code });
}

// The file's description, checked against the storefront_image rule before anything is sent: a
// 30 MB photo or a PDF never starts uploading. The first problem's error code, or null
export function checkPhotoFile(file: File): ErrorCode | null {
  const described = createStorefrontUploadInputSchema.safeParse(
    { fileName: file.name, contentType: file.type, sizeBytes: file.size },
    { error: contractErrorMap },
  );
  if (described.success) return null;
  const message = described.error.issues[0]?.message;
  return isErrorCode(message) ? message : 'invalid_value';
}

// Three steps, like the company logo (settings.tsx): the upload address, the file straight to
// storage, then "complete", which starts the job. `onTicket` gives the page the photo's id as soon
// as there is one, so the slot shows "Uploading…" while the file travels
export async function uploadShopPhoto(
  file: File,
  onTicket: (id: string) => void,
): Promise<{ id: string; state: PhotoState }> {
  const ticket = await call(routes.storefront.createUpload, {
    body: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
  });
  const id = ticket.image.id;
  onTicket(id);
  // Storage, not our API: a plain fetch with the signed headers exactly as given
  const put = await fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body: file,
  }).catch(() => null);
  if (!put?.ok) return { id, state: { status: 'failed', code: 'upload_incomplete' } };
  try {
    const done = await call(routes.storefront.completeUpload, { params: { id } });
    return { id, state: photoState(done) };
  } catch (error) {
    throw error instanceof ApiRequestError ? error : uploadError('upload_incomplete');
  }
}

export function photoState(upload: StorefrontUpload): PhotoState {
  switch (upload.status) {
    case 'uploading':
      return { status: 'uploading' };
    case 'processing':
      return { status: 'processing' };
    case 'ready':
      return { status: 'ready', url: upload.url };
    case 'failed':
      return { status: 'failed', code: upload.code };
  }
}
