import { z } from 'zod';

import { ATTACHMENT_RULES, uploadTargetSchema, type AttachmentRule } from './attachments.js';
import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { isMoneyAmount, isZeroMoney, priceSchema } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { LANGUAGE_CODES } from './preferences.js';
import {
  storefrontImageSchema,
  storefrontImagesSchema,
  storefrontSaleSchema,
  storefrontSectionsSchema,
} from './storefront-content.js';
import { SHOP_BADGES, SHOP_PAYMENT_METHODS, shopDeliveryZoneSchema } from './storefront.js';

// Step 26g: the ERP's Storefront screens. storefront.ts is what the shop reads, storefront-content.ts
// the raw material both sides share (the sale, the sections, the photo {id, alt}); this file is what
// the tenant's screens send and get back: the shop's settings and its launch, its categories, its
// listings and the photo uploads. Every route needs storefront.manage (decision 7 of 26f): the
// screens are for the people who run the shop, and nobody else reads these answers.

// ---------------------------------------------------------------------------------------------
// Addresses: the shop's subdomain and the slugs in its links

// The labels Omnivo uses itself under the shop domain, or may use: staging serves the ERP on
// app.omnivosoft.com and the API on api.omnivosoft.com, so a shop named "app" would take the ERP's
// address there. The workspace slugs' list (auth.ts), plus the hosts a file or media server takes
export const STOREFRONT_RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'blog',
  'cdn',
  'docs',
  'files',
  'help',
  'mail',
  'media',
  'omnivo',
  'shop',
  'static',
  'status',
  'www',
]);

// One DNS label, as storefront_settings_subdomain_check (migration 0063) takes it, but a little
// narrower: at least 3 characters like a workspace slug (one- and two-letter names are the ones
// people squat on), and no two hyphens in a row, which also keeps out "xn--", the start of an
// internationalized name a browser shows as other letters. Lower-cased first, so "Nirvor" is
// "nirvor" and never a second shop
export const storefrontSubdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, errorCode('too_short'))
  .max(63, errorCode('too_long'))
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, errorCode('storefront_subdomain_format'))
  .refine(
    (label) => !STOREFRONT_RESERVED_SUBDOMAINS.has(label),
    errorCode('storefront_subdomain_reserved'),
  );

// A category's or a listing's slug: /c/<slug>, /p/<slug>. The tables' check (SLUG_PATTERN, at most
// 100) and the public routes' slugParamSchema accept exactly this
export const STOREFRONT_SLUG_MAX = 100;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A slug from a name, the way the forms suggest one: "Neem Face Wash 150ml" → "neem-face-wash-150ml".
// Accents go ("Café" → "cafe"); every other character that is not a-z or 0-9 becomes one hyphen.
// A Bangla-only name ("নিম ফেস ওয়াশ") has no Latin letter at all and gives '': the form then asks
// for a slug, because a made-up one ("c-7f3a") would be a link nobody can read or type. Cut at
// 100 without leaving a hyphen at the end
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STOREFRONT_SLUG_MAX)
    .replace(/-+$/, '');
}

// The slug box. '' is allowed here and means "make it from the name"; the object's schema below does
// that (withSlug), so a form and a script that leave it out get the same slug
const slugInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(STOREFRONT_SLUG_MAX, errorCode('too_long'))
  .refine((slug) => slug === '' || SLUG.test(slug), errorCode('storefront_slug_format'));

// An empty slug becomes the name's; a name with no Latin letter and no slug is refused on the slug
// box (not the name: the name is fine, the link is what is missing). In the contract, not only in
// the API, so the form shows the same slug it is going to get and the same error
function withSlug<T extends z.ZodType<{ name: string; slug: string }>>(schema: T) {
  return schema
    .superRefine((value, ctx) => {
      if (value.slug === '' && slugFromName(value.name) === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['slug'],
          message: errorCode('storefront_slug_required'),
        });
      }
    })
    .transform((value) => ({
      ...value,
      slug: value.slug === '' ? slugFromName(value.name) : value.slug,
    }));
}

// ---------------------------------------------------------------------------------------------
// Settings and the launch

const nameSchema = (max: number) =>
  z.string().trim().min(1, errorCode('required')).max(max, errorCode('too_long'));

// A social link ends up in an <a href> on every page of the shop: https only, never javascript: or
// plain http (the table's storefront_settings_social_check says the same). '' = no link
const socialLinkSchema = optionalText(300).refine(
  (link) => link === null || /^https:\/\/[^\s"'<>]+\.[^\s"'<>]+$/.test(link),
  errorCode('storefront_link_https'),
);

// A delivery zone's id is what a shopper's cart keeps (the zone picked at checkout), so a saved zone
// keeps its id when it is renamed or its charge changes. null = a new zone; the API names it
const ZONE_ID = /^[a-z0-9-]{1,32}$/;

// The charge, which may be ৳0 (a zone the shop delivers to for free, like its own area). Required:
// an empty box is a charge nobody typed, not a free zone
const zoneChargeSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('required'))
  .refine((value) => value === '' || isMoneyAmount(value), errorCode('money_format'));

export const storefrontZoneInputSchema = z.object({
  id: z.string().regex(ZONE_ID).nullable(),
  name: nameSchema(60),
  charge: zoneChargeSchema,
});

// Six fit the checkout's radio cards on one screen (shopCheckoutSettingsSchema has the same limit)
export const STOREFRONT_ZONES_MAX = 6;

// Free delivery from / minimum order: '' = none (NULL). Zero is refused: "free from ৳0" is a free
// zone (charge ৳0), and "a minimum of ৳0" is no minimum, each with its own clearer box
const optionalAmountSchema = priceSchema.refine(
  (value) => value === null || !isZeroMoney(value),
  errorCode('too_small'),
);

// The warehouse select's "Pick a warehouse" sends ''
const warehouseIdSchema = z
  .union([z.uuid(errorCode('storefront_warehouse_invalid')), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

// Step 27b: the service a shop order's delivery charge is sold as (decision 4). The select's
// "Made on the first order" sends ''. Whether it is an active service, and whether it may be
// empty (not once an order used one), the API checks
const deliveryVariantIdSchema = z
  .union([z.uuid(errorCode('storefront_delivery_product_invalid')), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const settingsFieldsSchema = z.object({
  subdomain: storefrontSubdomainSchema,
  name: nameSchema(80),
  language: z.enum(LANGUAGE_CODES),
  hotline: nameSchema(30),
  address: nameSchema(300),
  facebookUrl: socialLinkSchema,
  instagramUrl: socialLinkSchema,
  xUrl: socialLinkSchema,
  linkedinUrl: socialLinkSchema,
  // Only before the launch may it be empty: a launched shop counts its stock somewhere (the API
  // refuses to empty it then, as the table's launch check does)
  defaultWarehouseId: warehouseIdSchema,
  deliveryZones: z
    .array(storefrontZoneInputSchema)
    .max(STOREFRONT_ZONES_MAX, errorCode('too_long')),
  freeDeliveryFrom: optionalAmountSchema,
  minimumOrder: optionalAmountSchema,
  // At least one way to pay, or no order can be placed. Ticked twice is once
  paymentMethods: z
    .array(z.enum(SHOP_PAYMENT_METHODS))
    .min(1, errorCode('storefront_payment_required'))
    .transform((methods) => [...new Set(methods)]),
  deliveryVariantId: deliveryVariantIdSchema,
});

// Two zones with one name would be two radio cards nobody can tell apart. Compared without case
// and spaces at the ends, on the second one's box
function uniqueZoneNames(
  value: { deliveryZones: readonly { name: string }[] },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  value.deliveryZones.forEach((zone, index) => {
    const key = zone.name.trim().toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliveryZones', index, 'name'],
        message: errorCode('storefront_zone_name_taken'),
      });
    }
    seen.add(key);
  });
}

// The first save makes the shop (POST); later saves change it (PUT, with the version). The form is
// the same: one schema each, so a POST can never carry a version the server would ignore
export const createStorefrontSettingsInputSchema =
  settingsFieldsSchema.superRefine(uniqueZoneNames);
export const updateStorefrontSettingsInputSchema = settingsFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(uniqueZoneNames);

export type CreateStorefrontSettingsInput = z.infer<typeof createStorefrontSettingsInputSchema>;
export type UpdateStorefrontSettingsInput = z.infer<typeof updateStorefrontSettingsInputSchema>;
export type StorefrontSettingsFormValues = z.input<typeof updateStorefrontSettingsInputSchema>;

// What "Open the shop" waits for, worked out by the API: a warehouse to count stock in, a zone to
// deliver to (both also the table's launch check), and one published listing, so the first
// shopper does not land on an empty shop. The page shows them as a checklist
export const storefrontReadinessSchema = z.object({
  warehouse: z.boolean(),
  zone: z.boolean(),
  listing: z.boolean(),
});
export type StorefrontReadiness = z.infer<typeof storefrontReadinessSchema>;

export const storefrontSettingsSchema = z.object({
  subdomain: z.string(),
  // The shop's own address, made by the API from the subdomain and its SHOP_BASE_DOMAIN: what
  // "View shop" opens ("https://nirvor.omnivosoft.com", in dev "http://nirvor.localhost:4321")
  shopUrl: z.url(),
  name: z.string(),
  language: z.enum(LANGUAGE_CODES),
  hotline: z.string(),
  address: z.string(),
  facebookUrl: z.string().nullable(),
  instagramUrl: z.string().nullable(),
  xUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  defaultWarehouseId: z.uuid().nullable(),
  deliveryZones: z.array(shopDeliveryZoneSchema),
  freeDeliveryFrom: z.string().nullable(),
  minimumOrder: z.string().nullable(),
  paymentMethods: z.array(z.enum(SHOP_PAYMENT_METHODS)),
  // Step 27b: the delivery charge's service. null until the first order makes one ("Delivery
  // charge") or the tenant picks one
  deliveryVariantId: z.uuid().nullable(),
  // null = not open yet: the address answers "No shop has this address"
  launchedAt: z.iso.datetime().nullable(),
  readiness: storefrontReadinessSchema,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;

// The settings page's one read. Before the first save there is no shop (`shop: null`), and the
// form starts from `suggested`: the workspace's slug as the subdomain when it can be one ('' when
// not; whether another shop has it, the first save says), and the company's name, phone and
// address from the workspace settings. baseDomain lets the form show the
// whole address while the subdomain is typed ("nirvor" → "nirvor.omnivosoft.com")
export const storefrontSetupSchema = z.object({
  baseDomain: z.string(),
  shop: storefrontSettingsSchema.nullable(),
  suggested: z.object({
    subdomain: z.string(),
    name: z.string(),
    hotline: z.string(),
    address: z.string(),
  }),
  // Step 27b: what the delivery charge select offers: the workspace's active services, by name.
  // Here and not from the products list, because storefront.manage does not read products
  deliveryChoices: z.array(z.object({ variantId: z.uuid(), name: z.string(), sku: z.string() })),
});
export type StorefrontSetup = z.infer<typeof storefrontSetupSchema>;

export const storefrontVersionInputSchema = z.object({ version: versionSchema });

// ---------------------------------------------------------------------------------------------
// Categories

export const storefrontCategorySchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  slug: z.string(),
  name: z.string(),
  // The order among its siblings, smallest first (the shop's filter row and drawer)
  position: z.number().int(),
  // Listings directly in it, drafts too: a category with any cannot be deleted
  listingCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontCategory = z.infer<typeof storefrontCategorySchema>;

// The form's "Top level" option sends '', like the product categories' form
const parentIdSchema = z
  .union([z.uuid(errorCode('category_parent_invalid')), z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable();

const categoryFieldsSchema = z.object({
  parentId: parentIdSchema,
  name: nameSchema(80),
  slug: slugInputSchema,
});

// Step 26h: /c/all is the shop's "All Products" page, which the shop answers before it looks for a
// category, so a category with the slug "all" could never be opened. Checked after withSlug, so a
// category named "All" with an empty slug box is refused too, on the slug box that would fix it
function notAllProducts(value: { slug: string }, ctx: z.RefinementCtx): void {
  if (value.slug === 'all') {
    ctx.addIssue({
      code: 'custom',
      path: ['slug'],
      message: errorCode('storefront_slug_reserved'),
    });
  }
}

// A new category goes last among its siblings; a new parent moves it, with everything under it, to
// the end of that parent's list
export const createStorefrontCategoryInputSchema =
  withSlug(categoryFieldsSchema).superRefine(notAllProducts);
export const updateStorefrontCategoryInputSchema = withSlug(
  categoryFieldsSchema.extend({ version: versionSchema }),
).superRefine(notAllProducts);
export type CreateStorefrontCategoryInput = z.infer<typeof createStorefrontCategoryInputSchema>;
export type UpdateStorefrontCategoryInput = z.infer<typeof updateStorefrontCategoryInputSchema>;
export type StorefrontCategoryFormValues = z.input<typeof createStorefrontCategoryInputSchema>;

// Move up / Move down: a swap with the sibling above or below. Buttons, not dragging, so the
// keyboard and a screen reader can do it too
export const moveStorefrontCategoryInputSchema = z.object({
  direction: z.enum(['up', 'down']),
  version: versionSchema,
});

export const deleteStorefrontVersionQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

// Tens of categories at most: the whole tree in one answer, like the product categories
export const storefrontCategoryListSchema = z.object({ items: z.array(storefrontCategorySchema) });

// ---------------------------------------------------------------------------------------------
// Photos

// A photo after its upload, as the screens see it. The original goes to the private tenant folder
// like any attachment; the image job then makes the shop's WebP files from it (26f's media.ts:
// small, large, wide) in the public storefront/ folder.
// - uploading: the upload address is out, the file is not confirmed yet
// - processing: confirmed, the job has not finished. The screen asks again every few seconds
// - ready: the files are there; url is the small one, for the form's thumbnail
// - failed: the job could not use it; code says why, in words the screen shows from errors.*
export const STOREFRONT_IMAGE_FAILURES = [
  'storefront_image_unreadable',
  'storefront_image_too_small',
  'storefront_image_too_many_pixels',
] as const;

// The job's limits. A photo narrower or lower than 200px looks broken even on a card (223px wide);
// one over 40 megapixels (7,000 × 5,700) is no phone's or camera's normal photo, and decoding it
// would take the worker's memory (a "decompression bomb" is a small file that unpacks huge)
export const STOREFRONT_IMAGE_MIN_SIDE = 200;
export const STOREFRONT_IMAGE_MAX_PIXELS = 40_000_000;

export const storefrontUploadSchema = z.discriminatedUnion('status', [
  z.object({ id: z.uuid(), status: z.literal('uploading') }),
  z.object({ id: z.uuid(), status: z.literal('processing') }),
  z.object({
    id: z.uuid(),
    status: z.literal('ready'),
    url: z.url(),
    width: z.number().int(),
    height: z.number().int(),
  }),
  z.object({ id: z.uuid(), status: z.literal('failed'), code: z.enum(STOREFRONT_IMAGE_FAILURES) }),
]);
export type StorefrontUpload = z.infer<typeof storefrontUploadSchema>;

// The file's description before the upload, checked against the storefront_image rule (size and
// type) here, so the browser refuses a 30 MB photo before it starts sending it
const storefrontImageRule: AttachmentRule = ATTACHMENT_RULES.storefront_image;

export const createStorefrontUploadInputSchema = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    contentType: z.string().max(100),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((input, ctx) => {
    if (!storefrontImageRule.contentTypes.includes(input.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: errorCode('file_type_not_allowed'),
      });
    }
    if (input.sizeBytes > storefrontImageRule.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['sizeBytes'],
        message: errorCode('storefront_image_file_too_large'),
      });
    }
  });
export type CreateStorefrontUploadInput = z.infer<typeof createStorefrontUploadInputSchema>;

export const storefrontUploadTicketSchema = z.object({
  image: storefrontUploadSchema,
  upload: uploadTargetSchema,
});
export type StorefrontUploadTicket = z.infer<typeof storefrontUploadTicketSchema>;

// A photo on a listing as the screens show it: the saved {id, alt} plus the small file's address
export const storefrontImageViewSchema = storefrontImageSchema.extend({ url: z.url() });
export type StorefrontImageView = z.infer<typeof storefrontImageViewSchema>;

// ---------------------------------------------------------------------------------------------
// Listings

export const STOREFRONT_LISTING_STATUSES = ['published', 'draft'] as const;
export type StorefrontListingStatus = (typeof STOREFRONT_LISTING_STATUSES)[number];

export const STOREFRONT_LISTING_SORTS = ['-updated', 'name', '-name'] as const;
export type StorefrontListingSort = (typeof STOREFRONT_LISTING_SORTS)[number];

export const storefrontListingQuerySchema = pageQuerySchema.extend({
  // Part of the listing's name, its slug or the variant's SKU
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', ...STOREFRONT_LISTING_STATUSES]).default('all'),
  // This category only, not the ones under it: the catalog shows where each listing is
  categoryId: z.uuid().optional(),
  sort: z.enum(STOREFRONT_LISTING_SORTS).default('-updated'),
});
export type StorefrontListingQuery = z.input<typeof storefrontListingQuerySchema>;

export const storefrontListingSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  packSize: z.string(),
  sku: z.string(),
  categoryId: z.uuid(),
  categoryName: z.string(),
  // The first photo (the card's); null for a draft that has none yet
  image: storefrontImageViewSchema.nullable(),
  // What a shopper pays now and the struck-out price, as the shop works them out at this moment
  // (listingPricing). price null: neither the listing nor the variant has a price yet
  price: z.string().nullable(),
  compareAtPrice: z.string().nullable(),
  // In the shop's warehouse; null while the shop has none
  inStock: z.boolean().nullable(),
  status: z.enum(STOREFRONT_LISTING_STATUSES),
  publishedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontListingSummary = z.infer<typeof storefrontListingSummarySchema>;

export const storefrontListingPageSchema = pageOf(storefrontListingSummarySchema);
export type StorefrontListingPage = z.infer<typeof storefrontListingPageSchema>;

export const storefrontListingSchema = z.object({
  id: z.uuid(),
  // The stock item it sells, as the ERP has it. The form shows the variant's own price under the
  // price box ("Product price: ৳299") and works out the preview from it
  product: z.object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(['active', 'archived']),
  }),
  variant: z.object({
    id: z.uuid(),
    sku: z.string(),
    // The variant's options in words ("150ml · Neem"), '' for a product with one variant
    name: z.string(),
    salePrice: z.string().nullable(),
  }),
  categoryId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  packSize: z.string(),
  priceOverride: z.string().nullable(),
  sale: storefrontSaleSchema.nullable(),
  badges: z.array(z.enum(SHOP_BADGES)),
  images: z.array(storefrontImageViewSchema),
  descriptionSections: storefrontSectionsSchema,
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  inStock: z.boolean().nullable(),
  status: z.enum(STOREFRONT_LISTING_STATUSES),
  publishedAt: z.iso.datetime().nullable(),
  // Its product page in the shop. A draft's page answers "Page not found" until it is published
  shopUrl: z.url(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontListing = z.infer<typeof storefrontListingSchema>;

// "Add to shop": one variant into one category. The API makes a draft from it, with the product's
// name and the variant's options as its name and a free slug made from that name
export const createStorefrontListingInputSchema = z.object({
  variantId: z.uuid(errorCode('required')),
  categoryId: z.uuid(errorCode('required')),
});
export type CreateStorefrontListingInput = z.infer<typeof createStorefrontListingInputSchema>;

// The listing's own price: '' = the variant's sale price (NULL). Zero is not a price a shop lists
// (the table's storefront_listings_price_check)
const priceOverrideSchema = priceSchema.refine(
  (value) => value === null || !isZeroMoney(value),
  errorCode('too_small'),
);

// The photos, with one photo at most once: two of the same in the gallery is a mistake, and the
// shop would draw the same picture twice
const listingImagesSchema = storefrontImagesSchema.superRefine((images, ctx) => {
  const seen = new Set<string>();
  images.forEach((image, index) => {
    if (seen.has(image.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: errorCode('storefront_image_twice'),
      });
    }
    seen.add(image.id);
  });
});

// The whole editor in one PUT, like every other form. Whether an amount or a price sale is below
// the regular price is the API's to check (only it knows that price for sure); the form's preview
// shows the same thing first (listingPricing)
export const updateStorefrontListingInputSchema = withSlug(
  z.object({
    version: versionSchema,
    name: nameSchema(120),
    slug: slugInputSchema,
    packSize: z.string().trim().max(40, errorCode('too_long')),
    categoryId: z.uuid(errorCode('required')),
    priceOverride: priceOverrideSchema,
    sale: storefrontSaleSchema.nullable(),
    // Each badge once, in the order the shop lists them
    badges: z
      .array(z.enum(SHOP_BADGES))
      .transform((badges) => SHOP_BADGES.filter((badge) => badges.includes(badge))),
    images: listingImagesSchema,
    descriptionSections: storefrontSectionsSchema,
    // '' = the shop's own (the name; the start of the description). Limits as shopProductSchema.seo
    seoTitle: optionalText(120),
    seoDescription: optionalText(300),
  }),
);
export type UpdateStorefrontListingInput = z.infer<typeof updateStorefrontListingInputSchema>;
export type StorefrontListingFormValues = z.input<typeof updateStorefrontListingInputSchema>;

// The "Add to shop" box's search: active variants that are not in the shop yet
export const storefrontCandidateQuerySchema = pageQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
});
export type StorefrontCandidateQuery = z.input<typeof storefrontCandidateQuerySchema>;

export const storefrontCandidateSchema = z.object({
  variantId: z.uuid(),
  productId: z.uuid(),
  // The product's name and the variant's options ("Neem Face Wash · 150ml")
  name: z.string(),
  sku: z.string(),
  salePrice: z.string().nullable(),
});
export type StorefrontCandidate = z.infer<typeof storefrontCandidateSchema>;

export const storefrontCandidatePageSchema = pageOf(storefrontCandidateSchema);

// ---------------------------------------------------------------------------------------------
// Routes

const idParamsSchema = z.object({ id: z.uuid() });

export const storefrontRoutes = {
  getSettings: defineRoute({
    method: 'GET',
    path: '/storefront/settings',
    summary: "The shop's settings, or what to start from before it is set up",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontSetupSchema,
  }),
  createSettings: defineRoute({
    method: 'POST',
    path: '/storefront/settings',
    summary: "Set up the workspace's shop (not open yet)",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontSettingsInputSchema,
    response: storefrontSettingsSchema,
  }),
  updateSettings: defineRoute({
    method: 'PUT',
    path: '/storefront/settings',
    summary: "Save the shop's settings",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: updateStorefrontSettingsInputSchema,
    response: storefrontSettingsSchema,
  }),
  launch: defineRoute({
    method: 'POST',
    path: '/storefront/settings/launch',
    summary: 'Open the shop: its address starts answering. It cannot be closed again',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: storefrontVersionInputSchema,
    response: storefrontSettingsSchema,
  }),
  listCategories: defineRoute({
    method: 'GET',
    path: '/storefront/categories',
    summary: "The shop's categories, as a flat list with parent ids, in their order",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontCategoryListSchema,
  }),
  createCategory: defineRoute({
    method: 'POST',
    path: '/storefront/categories',
    summary: 'Add a shop category, at the top or under another one, last in its list',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontCategoryInputSchema,
    response: storefrontCategorySchema,
  }),
  updateCategory: defineRoute({
    method: 'PUT',
    path: '/storefront/categories/:id',
    summary: 'Rename a shop category, change its slug or move it under another one',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontCategoryInputSchema,
    response: storefrontCategorySchema,
  }),
  moveCategory: defineRoute({
    method: 'POST',
    path: '/storefront/categories/:id/move',
    summary: 'Swap a shop category with the sibling above or below it',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: moveStorefrontCategoryInputSchema,
    response: storefrontCategoryListSchema,
  }),
  deleteCategory: defineRoute({
    method: 'DELETE',
    path: '/storefront/categories/:id',
    summary: 'Delete a shop category that holds no listings and no categories',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    params: idParamsSchema,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
  createUpload: defineRoute({
    method: 'POST',
    path: '/storefront/images',
    summary: 'Describe a photo and get a short-lived URL to upload it to storage',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontUploadInputSchema,
    response: storefrontUploadTicketSchema,
  }),
  completeUpload: defineRoute({
    method: 'POST',
    path: '/storefront/images/:id/complete',
    summary: "Confirm a photo's upload; the server checks it and starts making the shop's sizes",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontUploadSchema,
  }),
  getUpload: defineRoute({
    method: 'GET',
    path: '/storefront/images/:id',
    summary: "Whether an uploaded photo's sizes are ready",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontUploadSchema,
  }),
  listListings: defineRoute({
    method: 'GET',
    path: '/storefront/listings',
    summary: "The shop's listings, a page at a time, searched, filtered and sorted on the server",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    query: storefrontListingQuerySchema,
    response: storefrontListingPageSchema,
  }),
  listCandidates: defineRoute({
    method: 'GET',
    path: '/storefront/candidates',
    summary: 'Active product variants that are not in the shop yet, for "Add to shop"',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    query: storefrontCandidateQuerySchema,
    response: storefrontCandidatePageSchema,
  }),
  createListing: defineRoute({
    method: 'POST',
    path: '/storefront/listings',
    summary: 'Put a product variant in the shop as a draft listing',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontListingInputSchema,
    response: storefrontListingSchema,
  }),
  getListing: defineRoute({
    method: 'GET',
    path: '/storefront/listings/:id',
    summary: 'One listing with everything its editor shows',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontListingSchema,
  }),
  updateListing: defineRoute({
    method: 'PUT',
    path: '/storefront/listings/:id',
    summary: "Save a listing's name, price, sale, photos, description and SEO",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontListingInputSchema,
    response: storefrontListingSchema,
  }),
  publishListing: defineRoute({
    method: 'POST',
    path: '/storefront/listings/:id/publish',
    summary: 'Show a listing in the shop (it needs a photo and a price)',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontVersionInputSchema,
    response: storefrontListingSchema,
  }),
  unpublishListing: defineRoute({
    method: 'POST',
    path: '/storefront/listings/:id/unpublish',
    summary: 'Take a listing out of the shop; it stays as a draft',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontVersionInputSchema,
    response: storefrontListingSchema,
  }),
  deleteListing: defineRoute({
    method: 'DELETE',
    path: '/storefront/listings/:id',
    summary: 'Delete a listing; the product stays in the ERP',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    params: idParamsSchema,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
};
