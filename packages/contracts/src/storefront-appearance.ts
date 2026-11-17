import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import {
  deleteStorefrontVersionQuerySchema,
  storefrontImageViewSchema,
  storefrontListingSummarySchema,
} from './storefront-admin.js';
import { storefrontImageSchema, storefrontSectionsSchema } from './storefront-content.js';
import { SHOP_TEXT_PAGES } from './storefront.js';
import { versionSchema } from './fields.js';

// Step 26h: the second half of the ERP's Storefront menu. Appearance (the logo and the two colors,
// the hero, the picture banners, the collections and the home page's order) and the four text
// pages. The tables and the shop's side were made in 26f (storefront_banners, _collections,
// _collection_items, _home_blocks, _pages); this file is what the tenant's screens send and get
// back. Every route needs storefront.manage, like the rest of the menu.

// ---------------------------------------------------------------------------------------------
// Colors and contrast

// A color as the tables keep it: "#" and six hex digits, lower case. Lower-cased here so "#B8EF69"
// and "#b8ef69" are one color, and the audit log never shows a change that is only the case
export const hexColorInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, errorCode('storefront_color_format'));

// The shop's own colors that never change (CLAUDE.md → Storefront color tokens). Only the ones a
// tenant color is checked against are here
export const SHOP_WHITE = '#ffffff';
export const SHOP_CREAM = '#f4f5ec';

// The Figma colors a new shop starts with, and what "Use the default colors" puts back. The same
// as the table's defaults (storefront_settings.brand_color / accent_color)
export const STOREFRONT_DEFAULT_THEME = { brandColor: '#005859', accentColor: '#b8ef69' } as const;

// WCAG 2's minimums: 4.5:1 for normal text, 3:1 for large text (24px, or 18.66px bold, and up)
export const CONTRAST_TEXT = 4.5;
export const CONTRAST_LARGE_TEXT = 3;

// One sRGB channel (0–255) as linear light, the formula WCAG 2 gives
function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// How bright a color looks, from 0 (black) to 1 (white). The hex is one that passed
// hexColorInputSchema; anything else is NaN, and every comparison with NaN is false, so a broken
// color never passes a check
export function relativeLuminance(hex: string): number {
  const digits = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (digits === undefined) return Number.NaN;
  // Red, green and blue are the three bytes of the number, from the left
  const rgb = parseInt(digits, 16);
  return (
    0.2126 * linear((rgb >> 16) & 0xff) +
    0.7152 * linear((rgb >> 8) & 0xff) +
    0.0722 * linear(rgb & 0xff)
  );
}

// The contrast ratio of two colors, 1 (the same) to 21 (black on white). Either order: the
// lighter one is always on top of the fraction
export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The ratio as the forms show it, "4.4:1". Cut, not rounded: 4.47 would round to "4.5:1" next to a
// "Too low" pill, which reads as a contradiction. WCAG compares the exact value, and so do the
// checks below
export function formatContrast(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

// ---------------------------------------------------------------------------------------------
// Links

// Where a banner sends a shopper. The tables' LINK_PATTERN (a path on the shop's own site or https)
// and a little more: no spaces, quotes or angle brackets, which would end the href's quotes, no
// backslash anywhere (browsers read "/\evil.com" as "//evil.com"), and an https address has a dot in its
// host, so "https://" alone or "https://shop" is refused as a typo
export const STOREFRONT_LINK_MAX = 300;
export const storefrontLinkSchema = z
  .string()
  .trim()
  .min(1, errorCode('required'))
  .max(STOREFRONT_LINK_MAX, errorCode('too_long'))
  .regex(
    /^(?:\/(?!\/)[^\s"'<>\\]*|https:\/\/[^\s"'<>\\/]+\.[^\s"'<>\\]+)$/,
    errorCode('storefront_link_format'),
  );

// The form's "Links to" select (decision 4). The table keeps the address only, so a banner made by
// a script or an older form still opens in the form: storefrontLinkTarget reads the address back
export const STOREFRONT_LINK_KINDS = ['category', 'listing', 'offers', 'all', 'other'] as const;
export type StorefrontLinkKind = (typeof STOREFRONT_LINK_KINDS)[number];

export type StorefrontLinkTarget =
  | { kind: 'category'; slug: string }
  | { kind: 'listing'; slug: string }
  | { kind: 'offers' }
  | { kind: 'all' }
  | { kind: 'other'; href: string };

// The shop's own addresses (apps/shop/src/pages): /c/<slug> a category, /c/all every product,
// ?offer=1 the "Offer" switch of the filter row, /p/<slug> a product page
export const STOREFRONT_ALL_PRODUCTS_PATH = '/c/all';
export const STOREFRONT_OFFERS_PATH = '/c/all?offer=1';

export function storefrontLinkHref(target: StorefrontLinkTarget): string {
  switch (target.kind) {
    case 'category':
      return `/c/${target.slug}`;
    case 'listing':
      return `/p/${target.slug}`;
    case 'offers':
      return STOREFRONT_OFFERS_PATH;
    case 'all':
      return STOREFRONT_ALL_PRODUCTS_PATH;
    case 'other':
      return target.href;
  }
}

const SLUG_PATH = /^\/([cp])\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

// The other way round, for the form. Only the exact addresses storefrontLinkHref makes are read as
// a category or a product: "/c/skin-care?sort=name" is the tenant's own address, kept as "other",
// so opening and saving the form never drops the part after the "?"
export function storefrontLinkTarget(href: string): StorefrontLinkTarget {
  if (href === STOREFRONT_ALL_PRODUCTS_PATH) return { kind: 'all' };
  if (href === STOREFRONT_OFFERS_PATH) return { kind: 'offers' };
  const match = SLUG_PATH.exec(href);
  const slug = match?.[2];
  if (match !== null && slug !== undefined && slug !== 'all') {
    return match[1] === 'c' ? { kind: 'category', slug } : { kind: 'listing', slug };
  }
  return { kind: 'other', href };
}

// ---------------------------------------------------------------------------------------------
// The logo and the two colors

// The colors' two checks (decision 3), on the box to change. brand↔accent: Add to cart is brand
// text on accent, the header's chip accent text on brand. brand↔cream: brand is the text color of
// names, titles and labels on white, canvas and cream, and cream is the darkest of the three, so
// passing on cream passes on all of them. Both 4.5:1: every one of those texts is 16px or smaller
export function checkThemeContrast(
  value: { brandColor: string; accentColor: string },
  ctx: z.RefinementCtx,
): void {
  if (contrastRatio(value.brandColor, SHOP_CREAM) < CONTRAST_TEXT) {
    ctx.addIssue({
      code: 'custom',
      path: ['brandColor'],
      message: errorCode('storefront_brand_contrast'),
    });
  }
  if (contrastRatio(value.brandColor, value.accentColor) < CONTRAST_TEXT) {
    ctx.addIssue({
      code: 'custom',
      path: ['accentColor'],
      message: errorCode('storefront_accent_contrast'),
    });
  }
}

export const updateStorefrontThemeInputSchema = z
  .object({
    // The settings row's version: the logo and the colors are columns of storefront_settings, so
    // a save here and one on Shop settings cannot overwrite each other unseen
    version: versionSchema,
    // An uploaded, ready photo of this workspace (the API checks), or null for the Omnivo mark.
    // No alt text: a logo's alt is the shop's name, which the shop already knows
    logoImageId: z.uuid().nullable(),
    brandColor: hexColorInputSchema,
    accentColor: hexColorInputSchema,
  })
  .superRefine(checkThemeContrast);
export type UpdateStorefrontThemeInput = z.infer<typeof updateStorefrontThemeInputSchema>;
export type StorefrontThemeFormValues = z.input<typeof updateStorefrontThemeInputSchema>;

export const storefrontThemeSchema = z.object({
  // The small file's address and the id, for the form's tile; null = the Omnivo mark
  logo: z.object({ id: z.uuid(), url: z.url() }).nullable(),
  brandColor: z.string(),
  accentColor: z.string(),
  // The shop's name, which the preview draws beside the logo
  name: z.string(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontTheme = z.infer<typeof storefrontThemeSchema>;

// ---------------------------------------------------------------------------------------------
// The hero

// The colors a new hero starts with: the Figma hero's (apps/shop's mock home). They pass both of
// the hero's checks (button 4.7:1, panel 13.6:1)
export const STOREFRONT_HERO_DEFAULT_COLORS = {
  backgroundColor: '#eee0d8',
  panelColor: '#54260a',
  buttonColor: '#e7d1b2',
  buttonTextColor: '#8b471f',
} as const;

// The limits come from the drawing: the desktop panel is 303px wide for a 36px headline (about
// three lines of 20 letters), the phone's line is one or two 14px lines, the eyebrow and the
// button are pills of one short line
export const STOREFRONT_HEADLINE_MAX = 60;
export const STOREFRONT_HERO_LINE_MAX = 120;
export const STOREFRONT_EYEBROW_MAX = 24;
export const STOREFRONT_BUTTON_LABEL_MAX = 24;

const requiredText = (max: number) =>
  z.string().trim().min(1, errorCode('required')).max(max, errorCode('too_long'));

// '' = none, saved as NULL (like optionalText, with an error code for the limit)
const optionalWords = (max: number) =>
  z
    .string()
    .trim()
    .max(max, errorCode('too_long'))
    .transform((value) => (value === '' ? null : value));

const heroFieldsSchema = z.object({
  href: storefrontLinkSchema,
  headline: requiredText(STOREFRONT_HEADLINE_MAX),
  line: optionalWords(STOREFRONT_HERO_LINE_MAX),
  eyebrow: optionalWords(STOREFRONT_EYEBROW_MAX),
  buttonLabel: requiredText(STOREFRONT_BUTTON_LABEL_MAX),
  desktopImage: storefrontImageSchema,
  phoneImage: storefrontImageSchema,
  backgroundColor: hexColorInputSchema,
  panelColor: hexColorInputSchema,
  buttonColor: hexColorInputSchema,
  buttonTextColor: hexColorInputSchema,
});

// The hero's two checks (decision 3). The button's label is 16px: 4.5:1. The headline is white on
// the panel at 36px, large text: 3:1. The background color is behind the product photo only, with
// no words on it, so it has no check
function checkHeroContrast(
  value: { panelColor: string; buttonColor: string; buttonTextColor: string },
  ctx: z.RefinementCtx,
): void {
  if (contrastRatio(value.buttonColor, value.buttonTextColor) < CONTRAST_TEXT) {
    ctx.addIssue({
      code: 'custom',
      path: ['buttonTextColor'],
      message: errorCode('storefront_button_contrast'),
    });
  }
  if (contrastRatio(value.panelColor, SHOP_WHITE) < CONTRAST_LARGE_TEXT) {
    ctx.addIssue({
      code: 'custom',
      path: ['panelColor'],
      message: errorCode('storefront_panel_contrast'),
    });
  }
}

// One PUT makes the hero or changes it. version null = "there is no hero yet": if another tab made
// one meanwhile, the API answers version_conflict instead of making a second (the table allows
// one hero per shop, storefront_banners_hero_idx)
export const saveStorefrontHeroInputSchema = heroFieldsSchema
  .extend({ version: versionSchema.nullable() })
  .superRefine(checkHeroContrast);
export type SaveStorefrontHeroInput = z.infer<typeof saveStorefrontHeroInputSchema>;
export type StorefrontHeroFormValues = z.input<typeof saveStorefrontHeroInputSchema>;

export const storefrontHeroSchema = z.object({
  id: z.uuid(),
  href: z.string(),
  headline: z.string(),
  line: z.string().nullable(),
  eyebrow: z.string().nullable(),
  buttonLabel: z.string(),
  desktopImage: storefrontImageViewSchema,
  phoneImage: storefrontImageViewSchema,
  backgroundColor: z.string(),
  panelColor: z.string(),
  buttonColor: z.string(),
  buttonTextColor: z.string(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontHero = z.infer<typeof storefrontHeroSchema>;

// ---------------------------------------------------------------------------------------------
// Picture banners

// Decision 6. Six picture banners and eight collections, and twelve blocks on the page in all: a
// home page longer than that is scrolled past, and each block is a query on every visit
export const STOREFRONT_BANNERS_MAX = 6;
export const STOREFRONT_COLLECTIONS_MAX = 8;
export const STOREFRONT_HOME_BLOCKS_MAX = 12;

// A picture banner has its words in its pictures, so its alt texts are what a screen reader gets
// instead: "Himalaya mega sale, up to 30% off"
const bannerFieldsSchema = z.object({
  href: storefrontLinkSchema,
  desktopImage: storefrontImageSchema,
  phoneImage: storefrontImageSchema,
});

// A new banner goes to the end of the home page
export const createStorefrontBannerInputSchema = bannerFieldsSchema;
export const updateStorefrontBannerInputSchema = bannerFieldsSchema.extend({
  version: versionSchema,
});
export type CreateStorefrontBannerInput = z.infer<typeof createStorefrontBannerInputSchema>;
export type UpdateStorefrontBannerInput = z.infer<typeof updateStorefrontBannerInputSchema>;
export type StorefrontBannerFormValues = z.input<typeof createStorefrontBannerInputSchema>;

export const storefrontBannerSchema = z.object({
  id: z.uuid(),
  href: z.string(),
  desktopImage: storefrontImageViewSchema,
  phoneImage: storefrontImageViewSchema,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontBanner = z.infer<typeof storefrontBannerSchema>;

// ---------------------------------------------------------------------------------------------
// Collections

// The shop shows at most 24 cards in a row (COLLECTION_MAX in public-storefront.service.ts); more
// would never show
export const STOREFRONT_COLLECTION_ITEMS_MAX = 24;
export const STOREFRONT_COLLECTION_TITLE_MAX = 60;
export const STOREFRONT_COLLECTION_ICONS = ['fire'] as const;

// The listings in their order, each once. At least one: a row with nothing in it is not drawn, and
// a collection nobody can see on the page is a puzzle in the Home page card
const listingIdsSchema = z
  .array(z.uuid())
  .min(1, errorCode('storefront_collection_empty'))
  .max(STOREFRONT_COLLECTION_ITEMS_MAX, errorCode('too_long'))
  .superRefine((ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: errorCode('storefront_listing_twice'),
        });
      }
      seen.add(id);
    });
  });

const collectionFieldsSchema = z.object({
  title: requiredText(STOREFRONT_COLLECTION_TITLE_MAX),
  // 'fire' = the flame after the title ("Hot & Trending Right Now"); null = no icon
  icon: z.enum(STOREFRONT_COLLECTION_ICONS).nullable(),
  listingIds: listingIdsSchema,
});

export const createStorefrontCollectionInputSchema = collectionFieldsSchema;
export const updateStorefrontCollectionInputSchema = collectionFieldsSchema.extend({
  version: versionSchema,
});
export type CreateStorefrontCollectionInput = z.infer<typeof createStorefrontCollectionInputSchema>;
export type UpdateStorefrontCollectionInput = z.infer<typeof updateStorefrontCollectionInputSchema>;
export type StorefrontCollectionFormValues = z.input<typeof createStorefrontCollectionInputSchema>;

// A collection on the Home page card: its title and how many of its listings the shop shows now
// (published ones; a draft in it waits there until it is published)
export const storefrontCollectionSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  icon: z.enum(STOREFRONT_COLLECTION_ICONS).nullable(),
  listingCount: z.number().int(),
  publishedCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontCollectionSummary = z.infer<typeof storefrontCollectionSummarySchema>;

// The collection's page: everything above plus its listings in their order, as the catalog shows
// a listing (photo, name, SKU, price, status)
export const storefrontCollectionSchema = storefrontCollectionSummarySchema.extend({
  listings: z.array(storefrontListingSummarySchema),
});
export type StorefrontCollection = z.infer<typeof storefrontCollectionSchema>;

// ---------------------------------------------------------------------------------------------
// The home page

// One block under the hero and the featured grid, in the page's order
export const storefrontHomeBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('banner'), banner: storefrontBannerSchema }),
  z.object({ kind: z.literal('collection'), collection: storefrontCollectionSummarySchema }),
]);
export type StorefrontHomeBlock = z.infer<typeof storefrontHomeBlockSchema>;

// The Appearance page's one read. Every banner and every collection is on the page (decision 2):
// adding one puts it at the end, and removing it deletes it, so there is no "not on the page" list
export const storefrontAppearanceSchema = z.object({
  // "View shop"
  shopUrl: z.url(),
  theme: storefrontThemeSchema,
  hero: storefrontHeroSchema.nullable(),
  blocks: z.array(storefrontHomeBlockSchema),
});
export type StorefrontAppearance = z.infer<typeof storefrontAppearanceSchema>;

// Move up / Move down, like the categories: a swap with the block above or below. The block is
// named by what it shows, since a block has no id of its own (its key is its position). No version:
// a block has none, and moving the one the person clicked is right even if the list changed
export const moveStorefrontHomeBlockInputSchema = z.object({
  kind: z.enum(['banner', 'collection']),
  id: z.uuid(),
  direction: z.enum(['up', 'down']),
});
export type MoveStorefrontHomeBlockInput = z.infer<typeof moveStorefrontHomeBlockInputSchema>;

export const storefrontHomeBlockListSchema = z.object({
  blocks: z.array(storefrontHomeBlockSchema),
});

// ---------------------------------------------------------------------------------------------
// The text pages

// A page the tenant writes has at least one section: a page with none is the shop's "page not
// found", which is what Delete does
export const saveStorefrontPageInputSchema = z.object({
  // null = not written yet (no row). As the hero: a second tab's first save meets
  // version_conflict, not a silent overwrite
  version: versionSchema.nullable(),
  sections: storefrontSectionsSchema.min(1, errorCode('storefront_page_empty')),
});
export type SaveStorefrontPageInput = z.infer<typeof saveStorefrontPageInputSchema>;
export type StorefrontPageFormValues = z.input<typeof saveStorefrontPageInputSchema>;

// One of the four pages. A page not written yet has no sections and no version
export const storefrontPageSchema = z.object({
  slug: z.enum(SHOP_TEXT_PAGES),
  sections: storefrontSectionsSchema,
  // Its address in the shop, for "View page"
  shopUrl: z.url(),
  version: z.number().int().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type StorefrontPage = z.infer<typeof storefrontPageSchema>;

// The list: always the four, in the footer's order
export const storefrontPageListSchema = z.object({
  items: z.array(
    storefrontPageSchema.omit({ sections: true }).extend({ sectionCount: z.number() }),
  ),
});
export type StorefrontPageList = z.infer<typeof storefrontPageListSchema>;
export type StorefrontPageSummary = StorefrontPageList['items'][number];

// ---------------------------------------------------------------------------------------------
// Routes

const idParamsSchema = z.object({ id: z.uuid() });
const pageParamsSchema = z.object({ slug: z.enum(SHOP_TEXT_PAGES) });

export const storefrontAppearanceRoutes = {
  getAppearance: defineRoute({
    method: 'GET',
    path: '/storefront/appearance',
    summary: "The shop's logo, colors, hero and home page blocks, in the page's order",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontAppearanceSchema,
  }),
  updateTheme: defineRoute({
    method: 'PUT',
    path: '/storefront/appearance/theme',
    summary: "Save the shop's logo and its two colors (they must keep 4.5:1)",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: updateStorefrontThemeInputSchema,
    response: storefrontThemeSchema,
  }),
  saveHero: defineRoute({
    method: 'PUT',
    path: '/storefront/appearance/hero',
    summary: 'Make or change the banner at the top of the home page',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: saveStorefrontHeroInputSchema,
    response: storefrontHeroSchema,
  }),
  deleteHero: defineRoute({
    method: 'DELETE',
    path: '/storefront/appearance/hero',
    summary: 'Delete the hero; the home page then starts with its product grid',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
  createBanner: defineRoute({
    method: 'POST',
    path: '/storefront/appearance/banners',
    summary: 'Add a picture banner at the end of the home page',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontBannerInputSchema,
    response: storefrontBannerSchema,
  }),
  updateBanner: defineRoute({
    method: 'PUT',
    path: '/storefront/appearance/banners/:id',
    summary: "Change a picture banner's link or pictures",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontBannerInputSchema,
    response: storefrontBannerSchema,
  }),
  deleteBanner: defineRoute({
    method: 'DELETE',
    path: '/storefront/appearance/banners/:id',
    summary: 'Delete a picture banner; it leaves the home page',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    params: idParamsSchema,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
  getCollection: defineRoute({
    method: 'GET',
    path: '/storefront/appearance/collections/:id',
    summary: 'One collection with its listings in their order',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontCollectionSchema,
  }),
  createCollection: defineRoute({
    method: 'POST',
    path: '/storefront/appearance/collections',
    summary: 'Add a row of hand-picked listings at the end of the home page',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontCollectionInputSchema,
    response: storefrontCollectionSchema,
  }),
  updateCollection: defineRoute({
    method: 'PUT',
    path: '/storefront/appearance/collections/:id',
    summary: "Change a collection's title, icon or listings",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontCollectionInputSchema,
    response: storefrontCollectionSchema,
  }),
  deleteCollection: defineRoute({
    method: 'DELETE',
    path: '/storefront/appearance/collections/:id',
    summary: 'Delete a collection; it leaves the home page, the listings stay',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    params: idParamsSchema,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
  moveHomeBlock: defineRoute({
    method: 'POST',
    path: '/storefront/appearance/home/move',
    summary: 'Swap a home page block with the one above or below it',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: moveStorefrontHomeBlockInputSchema,
    response: storefrontHomeBlockListSchema,
  }),
  listPages: defineRoute({
    method: 'GET',
    path: '/storefront/pages',
    summary: 'The four text pages in the footer, written or not',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontPageListSchema,
  }),
  getPage: defineRoute({
    method: 'GET',
    path: '/storefront/pages/:slug',
    summary: 'One text page; one not written yet has no sections',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: pageParamsSchema,
    response: storefrontPageSchema,
  }),
  savePage: defineRoute({
    method: 'PUT',
    path: '/storefront/pages/:slug',
    summary: 'Write or change a text page',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: pageParamsSchema,
    body: saveStorefrontPageInputSchema,
    response: storefrontPageSchema,
  }),
  deletePage: defineRoute({
    method: 'DELETE',
    path: '/storefront/pages/:slug',
    summary: 'Delete a text page; the shop answers "page not found" for it and drops its link',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 204,
    params: pageParamsSchema,
    query: deleteStorefrontVersionQuerySchema,
    response: z.void(),
  }),
};
