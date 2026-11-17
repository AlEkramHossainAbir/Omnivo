# Step 26h: Storefront, part 8 — the shop's look, its pages and a seed

> The implementation guide for "Phase 10 → Step 26", the eighth and last part, of [build-plan.bn.md](build-plan.bn.md).
> Step 26 so far:
>
> - **26a–26e (done):** `apps/shop` with every screen, on mock data.
> - **26f (done):** the storefront tables, the public API `/public/v1`, and the shop's data source that reads it.
> - **26g (done):** the ERP's Storefront menu, first half: the permission, the shop's settings and "Open the shop",
>   its categories, its listings and the photo job.
> - **26h (this guide):** the second half: Appearance (the logo and the two colors, the hero, picture banners,
>   collections and the home page's order), the four text pages, and a seed that builds a whole demo shop with
>   photos through the API.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `b2102e4`, "store front image
> added") and checked on 2026-11-17: `pnpm dedupe --check`, `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (1,429, of them 614 in `packages/contracts`, 234 in `apps/shop`, 229 in `apps/app` and 183 in
> `apps/api`), `pnpm test:integration` (806 in 47 files) and `pnpm test:tenant-leak` (159 in 23 files) on
> Testcontainers, `pnpm boundaries`, `pnpm test:bundle-size` (first load 241.1 KB gz, budget 245; the listing editor
> 149.6 KB, budget 150), `pnpm test:openapi`, the app's Playwright suite on a computer and on a phone (all 449 that
> run pass), the PWA suite (4) and the shop's Playwright tests (38, 2 skipped on purpose, as before), all clean. The
> three migrations were also checked on a throwaway Postgres with their own script (26h.2).
>
> Also checked:
>
> - **The seed on the real API** (26h.8), and **the new screens on the real API** (26h.9): a production build of the
>   app, the API, the worker with `sharp` and MinIO, then the built shop with `SHOP_SOURCE=api` showing what the
>   screens changed.
> - **Broken on purpose** while the parts were written, each caught by a test: the contrast rounded up, the panel
>   asked for 4.5:1, no renumbering after a delete, the hero reachable through the banner routes, a new banner put
>   first, a collection counting its drafts, the seed's sale and photos, and more. Each part's "Check this part"
>   lists them.

## Goal

🎨 **A workspace makes its shop look like its own.** After 26g a shop could open, but it always wore Omnivo's mark
and Figma's teal and lime, its home page had no hero and no rows, and the footer's four links led to "page not
found". The tables for all of it were there since 26f, and the shop already read them; only the ERP had no screen
to fill them. After 26h the Storefront menu has two more pages. Appearance sets the logo and the two colors (with a
contrast check, so a tenant cannot make the shop unreadable), the hero at the top, the picture banners and the
collections under the grid, and their order. Pages writes Privacy, Terms, About and Contact with the same section
editor as a listing's description, and the footer links only the pages that are written. A new script,
`pnpm seed:shop`, builds a whole demo shop with photos through the API, so a developer sees a real shop in a minute.

## The whole picture

```
packages/contracts   storefront-appearance.ts: 16 routes (all storefront.manage), contrastRatio(), the link
                     helpers, theme, hero, banners, collections, home blocks, pages; publicShopSchema.pages
                     errors/audit: 14 codes, 10 actions + 2 entity types    category slug "all" refused
packages/db          0067 renames a category called "all"; 0068 the slug check, item ≤ 24, block ≤ 12;
                     0069 the logo's foreign key (the tables themselves are 26f's)
      │
      ▼
apps/api/src/storefront/admin   (login, storefront.manage, the shop set up, every save audited)
   appearance    GET the whole look → theme (version), hero (create or change), picture banners
   collections   up to 24 listings each, this workspace's only
   home-blocks   one advisory lock per shop: limits 6 / 8 / 12, Move up / down, renumbered 1..n
   pages         four slugs, saved as sections → the shop's own HTML
public-storefront   shop().pages: the written pages only, so the footer links nothing that 404s
      │
      ▼
apps/app   Storefront: Catalog · Shop categories · Shop appearance · Shop pages · Shop settings
   /storefront/appearance                Logo and colors (contrast shown as you type), Hero banner,
                                         Home page (blocks in order, a banner dialog, Move up / down)
   /storefront/appearance/hero           Words, Pictures (computer + phone), "Links to", a live drawing
   /storefront/appearance/collections/…  a name, an icon, up to 24 listings in order
   /storefront/pages, /storefront/pages/$slug   the four pages, the shared section editor
apps/shop   Footer.astro: only shop.pages    scripts/: `pnpm seed:shop` builds a demo shop through the API

Tuesday 17 Nov 2026, Rahman Fashion, on a laptop:
  Shop appearance → a logo, brand #7A1F3D (accent #F4D06F: 6.7:1, 9.1:1 on cream) → Save
  Hero banner → "Eid collection: 20% off polo shirts", two pictures, Links to: a category → Save
  Home page → Add collection "Eid picks" (8 listings) → Move up above the Mega Sale banner
  Shop pages → Terms & Condition: three sections → Save; "View shop": the new colors, the hero, the footer link
```

## Not in this step, on purpose

- **Banners with start and end dates, a hero carousel, more than two tenant colors, page templates** (decision 8).
  A seasonal banner is added and removed by hand for now.
- **Cleaning up unused photos** (26g decision 7): a replaced logo or banner picture stays in storage.
- **Staging on the real API** (26g.8): staging keeps the mock shop until it has a wildcard shop host.
- **Orders, stock held for an order, coupons and the phone code by SMS:** step 27.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront-admin.ts` (+ spec) | A category's slug may not be `all` (`/c/all` is All Products) |
| `packages/contracts/src/storefront.ts` (+ spec) | `publicShopSchema.pages`; `SHOP_TEXT_PAGES` moved above it |
| `packages/contracts/src/errors.ts`, `audit.ts` | 14 error codes; 10 audit actions and 2 entity types |
| `packages/contracts/src/routes.ts`, `index.ts` | `storefrontAppearance` in the routes registry; the new file exported |
| `packages/contracts/openapi.json` | Regenerated with the 16 routes |
| `packages/db/src/schema/storefront.ts` | The slug check, the position checks, an index on images and the logo's foreign key |
| `packages/db/src/permission-catalog.ts` | `storefront.manage` says "its look and pages" too |
| `packages/db/migrations/meta/_journal.json` | Migrations 0067, 0068 and 0069 |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The errors, the audit words, the nav, the shared `storefront.sections`, and the appearance, collection and pages words |
| `apps/api/src/storefront/admin/listings.service.ts` | `summaries(tx, ids)`, for a collection's listings |
| `apps/api/src/storefront/admin/categories.service.ts` | The reserved slug as an error on the box |
| `apps/api/src/storefront/public-storefront.service.ts` | `pages` in the shop's answer |
| `apps/api/src/storefront/storefront.module.ts` | The three services and the controller |
| `apps/api/src/storefront/*.int.spec.ts` (3 files) | Another workspace's look and pages; the shop's `pages` |
| `apps/app/src/components/storefront-sections.tsx` | `SectionsCard`, the section editor with props, shared by a listing and a page |
| `apps/app/src/components/storefront-photos.tsx`, `storefront-parts.tsx` | `useJobState`, `LINK_BUTTON`, `PageStatusPill` exported |
| `apps/app/src/routes/storefront-listing.tsx` | Uses `SectionsCard` |
| `apps/app/src/router.tsx`, `routes/app-shell.tsx` | Six lazy routes; Shop appearance and Shop pages in the sidebar |
| `apps/app/scripts/check-bundle-size.ts` | First load 245 KB (your choice) |
| `apps/app/src/mocks/handlers.ts`, `storefront-seed.ts`, `storefront-data.ts` | The 16 routes; a seeded look (logo, hero, four blocks, two pages) |
| `apps/app/e2e/helpers.ts`, `storefront.e2e.ts` | `png()` moved to the helpers |
| `apps/shop/src/components/Footer.astro`, `data/mock/shop.ts` | The footer links only written pages; the mock has all four |
| `apps/shop/package.json`, `vitest.config.ts`, root `package.json`, `pnpm-lock.yaml` | `seed` with `tsx`, `scripts/` type-checked and tested; `pnpm seed:shop` |
| `apps/shop/public/mock/banners/mega-sale-phone.jpg` | Figma's 2x export (the 1x one is too small for the photo job) |

New: `packages/contracts/src/storefront-appearance.ts` (with its spec); migrations 0067, 0068 and 0069;
`packages/i18n/src/locales/locales.spec.ts`; in `apps/api/src/storefront/admin/`: `home-blocks.ts`,
`appearance.service.ts`, `collections.service.ts`, `pages.service.ts` and `storefront-appearance.controller.ts`;
`apps/api/src/storefront/storefront-appearance.int.spec.ts`; in `apps/app/src`: `lib/storefront-appearance.ts` (with
its spec), `components/storefront-picture.tsx`, `storefront-color.tsx`, `storefront-link.tsx`,
`storefront-shop-preview.tsx`, the five `routes/storefront-{appearance,hero,collection,pages,page}.tsx` pages and
`mocks/storefront-appearance-data.ts`; `apps/app/e2e/storefront-appearance.e2e.ts`; `apps/shop/scripts/` (the seed,
its plan and its test).

## Decisions

Agreed with the user on 2026-11-16 (all as recommended):

1. **One guide.** Appearance, the text pages and the seed. The seed is its own part near the end, and it is also the
   end-to-end check on the real API (26h.8).
2. **One Appearance page** (`/storefront/appearance`) with three cards: "Logo and colors", "Hero banner" and "Home
   page". The home page card lists the blocks under the product grid in their order, with Move up / Move down.
   A picture banner is edited in a dialog; a collection has its own page (`/storefront/collections/$id`; 26h.6 put it under `/storefront/appearance`, decision 37), because
   ordering up to 24 products does not fit a dialog. Every banner and collection is on the home page: adding one
   puts it at the end, and removing it deletes it. There is no "hidden" state to explain.
3. **Contrast checks.** Brand against accent 4.5:1 (already in CLAUDE.md), brand against `cream` 4.5:1, the hero's
   button against its text 4.5:1, and the white headline against the hero's panel 3:1 (large text). One
   `contrastRatio()` in the contracts, used by the form and the API.
4. **Banner links stay an address** (`href`, no schema change). The form has a "Links to" select: a shop category,
   a product, the products on offer, all products, or another address. A slug changed later breaks the link (a
   404); that is rare, and storing ids would change the tables and the public queries.
5. **Pages:** a list of the four pages and an editor that reuses the listing's section editor. The shop's
   `publicShopSchema` gets `pages`, the written ones, so the footer links only those. No template text: privacy
   and terms are legal words the tenant must own.
6. **Limits:** 6 picture banners, 8 collections, 24 products in a collection, 12 blocks on the home page.
7. **A seed through the HTTP API** (`pnpm seed:shop`), against the running dev stack: it signs up a demo workspace,
   makes a warehouse, products and their opening stock, the shop's categories, listings with the 22 mock photos
   (uploaded, then made into WebP by the worker), the hero, a picture banner, collections and the four pages, and
   opens the shop. It stops with a message when the demo workspace is there already. Not in CI.
8. **Not now:** banner dates, a hero carousel, page templates, more tenant colors, cleaning up photos.
9. **A mockup before the screens**, as a local HTML page and pictures (CLAUDE.md rule 6), approved first.

The decisions made while writing (10 onward) are in the parts, where the code they shape is.

## 26h.1 — The contracts

This part adds what the Appearance and Pages screens and the API agree on: 16 routes, their inputs and answers,
the contrast and link helpers, the error codes and the audit events. It also adds `pages` to the shop's own
`publicShopSchema`, and closes a gap from 26g (a shop category called "all"). Nothing is stored or served yet.

### Appearance and pages: `storefront-appearance.ts`

**Decision 10: a file of its own.** `storefront-admin.ts` (26g) is already 770 lines. The new routes sit under a
second key in the routes registry, `storefrontAppearance`, and their paths under `/storefront/appearance` and
`/storefront/pages`. They import the shapes they share from `storefront-admin.ts` (the photo view, a listing's
summary, the delete's version query), so a listing in a collection looks exactly like a listing in the catalog.

```ts
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
```

**Colors and contrast** (decision 3, decision 11).

- `hexColorInputSchema` lower-cases the color. The tables accept either case, but `#B8EF69` and `#b8ef69` are one
  color: without this, saving the same color typed differently would show in the audit log as a change.
- `relativeLuminance` and `contrastRatio` are the formulas from WCAG 2. `linear()` undoes the screen's gamma for
  one channel; the three weights (0.2126, 0.7152, 0.0722) say how bright red, green and blue look to an eye. The
  ratio always puts the lighter color on top, so the order of the two arguments does not matter.
- A string that is not `#rrggbb` gives `NaN`. Every comparison with `NaN` is false, so `ratio < 4.5` is false too —
  which would let a broken color **pass** a check written as "refuse when below". That is why every check runs
  after `hexColorInputSchema` on the same object: a broken color is refused by its format first. The spec pins the
  other side: `contrastRatio('red', …) >= 3` is false.
- `formatContrast` cuts to one decimal instead of rounding. A ratio of 4.47 fails, and "4.5:1" next to a "Too low"
  pill would read as a contradiction. The checks themselves compare the exact number, as WCAG says.
- `checkThemeContrast` puts each error on the box that should change. Brand against `cream`: brand is the color of
  names, titles and labels on white, `canvas` and `cream`, and `cream` is the darkest of the three, so passing on
  `cream` passes on all of them. Brand against accent: Add to cart is brand text on accent, and the selected chip is
  accent text on brand. Both are 16px text or smaller, so both need 4.5:1.
- The field errors carry no numbers (a field error is a code only, `problemSchema.fieldErrors`). The form shows the
  ratio next to the boxes while the tenant picks, so the error's words only need to say what to do.

**Links** (decision 4).

- `storefrontLinkSchema` is the tables' `LINK_PATTERN` and a little more. No spaces, quotes or angle brackets: any
  of them could end the `href="…"` the shop writes. No backslash anywhere: browsers read `/\evil.example` as
  `//evil.example`, another site. `(?!\/)` keeps out `//evil.example` itself. An https address needs a dot in its
  host, so `https://` alone or `https://shop` is refused as a typo, not saved as a dead link.
- `storefrontLinkHref` and `storefrontLinkTarget` turn the form's "Links to" choice into an address and back. The
  `switch` has no `default`: with a new kind in the union, TypeScript stops compiling it.
- `storefrontLinkTarget` only reads the exact addresses `storefrontLinkHref` makes. `/c/skin-care?sort=name` is kept
  as "Another address", so opening a banner and saving it again never drops what comes after the `?`. A slug
  `all` is never read as a category: `/c/all` is All Products (see the category fix below).

**The logo and the colors** (decision 12).

- `updateStorefrontThemeInputSchema` takes the **settings row's** `version`. The logo and the colors are columns of
  `storefront_settings`, so a save on Appearance and one on Shop settings in another tab cannot overwrite each other
  without a "changed by someone else" error.
- `logoImageId` is an id only. A logo's alt text is the shop's name (26f's public service), which the shop knows.
- `storefrontThemeSchema` carries the shop's `name` because the preview draws it next to the logo, and the Appearance
  page should not need a second request to Shop settings for it.

**The hero** (decision 13).

- `STOREFRONT_HERO_DEFAULT_COLORS` are the Figma hero's colors (`apps/shop`'s mock home). A new hero starts with
  them, and the spec checks they pass both hero checks (the button is 4.7:1, close to the line).
- The limits come from the drawing: the desktop panel is 303px wide for a 36px headline, so about three lines of
  20 letters.
- `optionalWords` turns an empty box into `null`, like `optionalText` in `fields.ts`, but with an error code on the
  limit (`optionalText` has none, and its `max` message would be Zod's English).
- `checkHeroContrast`: the button's label is 16px, so 4.5:1. The headline is white at 36px, large text in WCAG's
  terms, so 3:1 is enough on the panel. The spec pins that a mid-tone panel passes 3:1 and a pale one does not. The
  background color sits behind the product photo with no words on it, so it has no check.
- **One PUT makes or changes the hero.** `version: null` means "there is no hero yet". If another tab made one
  meanwhile, the API answers `version_conflict` instead of making a second (the table allows one hero, 26f.2), and
  the page reloads to show it. The text pages use the same pattern.

**Picture banners and collections** (decision 6).

- `STOREFRONT_COLLECTION_ITEMS_MAX` is 24 because the shop shows at most 24 cards in a row (26f's
  `COLLECTION_MAX`): a 25th would never show.
- `listingIdsSchema` needs at least one listing (`storefront_collection_empty`). A row with nothing in it is not
  drawn, and the Home page card would then list a block nobody can see.
- A listing twice is refused on the **second** one (`path: [index]`), so the form marks the row to remove, not the
  first one.
- `storefrontCollectionSummarySchema.publishedCount` lets the Home page card say "8 products, 2 not in the shop
  yet": a draft in a collection waits there until it is published (26f's foreign key keeps it).
- `storefrontCollectionSchema.listings` reuses the catalog's `storefrontListingSummarySchema`, so the collection's
  page draws a product exactly like the catalog does, photo and price included.

**The home page** (decision 14).

- `storefrontAppearanceSchema` is the page's one read: theme, hero and the blocks in order.
- Move up / Move down names the block by what it shows (`kind` and `id`): a home block has no id of its own, its
  key is its position. It takes no version: a block has none, and moving the block the person clicked is right
  even when the list changed meanwhile. The answer is the whole new list, like the categories' move in 26g.

**The text pages.**

- `saveStorefrontPageInputSchema` needs a section (`storefront_page_empty`). An empty page would be an empty card
  under its title; Delete is the way to take a page out of the shop.
- `storefrontPageListSchema` always has the four pages, in the footer's order, written or not. A page not written
  has `version: null` and `updatedAt: null`, and the list shows it as "Not written".

**The routes.** All 16 need `storefront.manage`. The hero and the home move have fixed paths
(`/storefront/appearance/hero`, `/storefront/appearance/home/move`) beside `/storefront/appearance/banners/:id` and
`/collections/:id`; none of them can be read as an id.

```ts
import { describe, expect, it } from 'vitest';

import { storefrontRoutes } from './storefront-admin.js';
import {
  contrastRatio,
  createStorefrontCollectionInputSchema,
  CONTRAST_LARGE_TEXT,
  CONTRAST_TEXT,
  formatContrast,
  relativeLuminance,
  saveStorefrontHeroInputSchema,
  saveStorefrontPageInputSchema,
  SHOP_CREAM,
  SHOP_WHITE,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  STOREFRONT_DEFAULT_THEME,
  STOREFRONT_HERO_DEFAULT_COLORS,
  storefrontAppearanceRoutes,
  storefrontLinkHref,
  storefrontLinkSchema,
  storefrontLinkTarget,
  updateStorefrontCollectionInputSchema,
  updateStorefrontThemeInputSchema,
  type StorefrontHeroFormValues,
  type StorefrontLinkTarget,
} from './storefront-appearance.js';

// The error codes of a failed parse, by the path of the box they belong to
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.');
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

const PHOTO = '0b8f6c52-7d2e-4b8e-9a51-3f4c2d1e0a11';
const PHOTO_2 = '1c9a7d63-8e3f-4c9f-8b62-4a5d3e2f1b22';
const LISTING = '2dab8e74-9f40-4da0-9c73-5b6e4f3a2c33';
const LISTING_2 = '3ebc9f85-a051-4eb1-8d84-6c7f5a4b3d44';

describe('contrast', () => {
  it('is 21:1 for black on white and 1:1 for a color on itself, in either order', () => {
    expect(contrastRatio('#000000', SHOP_WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(SHOP_WHITE, '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#005859', '#005859')).toBe(1);
  });

  // The ratios CLAUDE.md gives for the Figma colors
  it('matches the design system for the default colors', () => {
    const { brandColor, accentColor } = STOREFRONT_DEFAULT_THEME;
    expect(contrastRatio(brandColor, SHOP_CREAM)).toBeCloseTo(7.5, 1);
    expect(contrastRatio(brandColor, accentColor)).toBeCloseTo(6.1, 1);
  });

  it('reads upper-case hex the same as lower-case', () => {
    expect(relativeLuminance('#B8EF69')).toBe(relativeLuminance('#b8ef69'));
  });

  // NaN compares false with everything, so a color that is not #rrggbb passes no check
  it.each(['red', '#fff', 'b8ef69', ''])('never lets %j pass', (color) => {
    expect(contrastRatio(color, '#000000') >= CONTRAST_LARGE_TEXT).toBe(false);
  });

  it('shows the ratio cut to one decimal, never rounded up to a pass', () => {
    expect(formatContrast(4.47)).toBe('4.4:1');
    expect(formatContrast(4.5)).toBe('4.5:1');
    expect(formatContrast(21)).toBe('21.0:1');
  });
});

describe('the logo and the colors', () => {
  it('takes the defaults, and lower-cases what was typed', () => {
    expect(
      updateStorefrontThemeInputSchema.parse({
        version: 4,
        logoImageId: null,
        brandColor: ' #005859',
        accentColor: '#B8EF69',
      }),
    ).toEqual({ version: 4, logoImageId: null, brandColor: '#005859', accentColor: '#b8ef69' });
  });

  it.each(['005859', '#05859', '#00585z', 'teal'])('refuses %j as a color', (color) => {
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: color,
      accentColor: '#b8ef69',
    });
    expect(errorsOf(result).brandColor).toContain('storefront_color_format');
  });

  // A light blue is fine as a button, but names and titles in it on cream are hard to read
  it('refuses a brand color too light for text on cream, on the brand box', () => {
    expect(contrastRatio('#7c9cf2', SHOP_CREAM)).toBeLessThan(CONTRAST_TEXT);
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: '#7c9cf2',
      accentColor: '#0b0f17',
    });
    expect(errorsOf(result)).toEqual({ brandColor: ['storefront_brand_contrast'] });
  });

  it('refuses an accent too close to the brand, on the accent box', () => {
    const result = updateStorefrontThemeInputSchema.safeParse({
      version: 4,
      logoImageId: null,
      brandColor: '#005859',
      accentColor: '#2a8a6b',
    });
    expect(errorsOf(result)).toEqual({ accentColor: ['storefront_accent_contrast'] });
  });
});

describe('banner links', () => {
  it.each([
    '/c/skin-care',
    '/c/all?offer=1',
    '/p/himalaya-neem-face-wash-150ml',
    '/pages/about',
    'https://www.facebook.com/nirvor.pharmacy',
  ])('takes %s', (href) => {
    expect(storefrontLinkSchema.parse(href)).toBe(href);
  });

  it.each([
    ['', 'required'],
    // Another site that looks like a path, in both spellings a browser accepts
    ['//evil.example', 'storefront_link_format'],
    ['/\\evil.example', 'storefront_link_format'],
    ['javascript:alert(1)', 'storefront_link_format'],
    ['http://nirvor.com', 'storefront_link_format'],
    ['https://', 'storefront_link_format'],
    ['https://nirvor', 'storefront_link_format'],
    ['/c/skin care', 'storefront_link_format'],
    ['/c/"onmouseover="', 'storefront_link_format'],
    [`/${'a'.repeat(300)}`, 'too_long'],
  ])('refuses %j with %s', (href, code) => {
    expect(errorsOf(storefrontLinkSchema.safeParse(href))['']).toContain(code);
  });

  const TARGETS: [string, StorefrontLinkTarget][] = [
    ['/c/skin-care', { kind: 'category', slug: 'skin-care' }],
    ['/p/neem-face-wash', { kind: 'listing', slug: 'neem-face-wash' }],
    ['/c/all', { kind: 'all' }],
    ['/c/all?offer=1', { kind: 'offers' }],
    ['https://example.com/eid', { kind: 'other', href: 'https://example.com/eid' }],
  ];

  it.each(TARGETS)('reads %s back as the target that makes it', (href, target) => {
    expect(storefrontLinkTarget(href)).toEqual(target);
    expect(storefrontLinkHref(target)).toBe(href);
  });

  // Saving the form again must not drop the part after the "?"
  it('keeps an address with more to it as the tenant typed it', () => {
    expect(storefrontLinkTarget('/c/skin-care?sort=name')).toEqual({
      kind: 'other',
      href: '/c/skin-care?sort=name',
    });
    expect(storefrontLinkTarget('/c/skin-care/')).toEqual({
      kind: 'other',
      href: '/c/skin-care/',
    });
  });
});

// A hero form as a new hero starts, filled in
const HERO: StorefrontHeroFormValues = {
  version: null,
  href: '/c/cosmetics',
  headline: 'Get 10% cash-back on shopping ৳150',
  line: '',
  eyebrow: 'Exclusive offer',
  buttonLabel: 'Get 10% cashback',
  desktopImage: { id: PHOTO, alt: 'Make-up and skin care products' },
  phoneImage: { id: PHOTO_2, alt: 'Make-up and skin care products' },
  ...STOREFRONT_HERO_DEFAULT_COLORS,
};

describe('the hero', () => {
  it('starts with colors that pass, and saves an empty line as none', () => {
    const hero = saveStorefrontHeroInputSchema.parse(HERO);
    expect(hero.line).toBeNull();
    expect(hero.eyebrow).toBe('Exclusive offer');
    expect(hero.version).toBeNull();
  });

  it('needs a headline, a button label and the photos’ alt texts', () => {
    const result = saveStorefrontHeroInputSchema.safeParse({
      ...HERO,
      headline: ' ',
      buttonLabel: '',
      phoneImage: { id: PHOTO_2, alt: '' },
    });
    expect(errorsOf(result)).toEqual({
      headline: ['required'],
      buttonLabel: ['required'],
      'phoneImage.alt': ['required'],
    });
  });

  it('refuses button words that do not stand out from the button', () => {
    const result = saveStorefrontHeroInputSchema.safeParse({
      ...HERO,
      buttonColor: '#e7d1b2',
      buttonTextColor: '#c49a6c',
    });
    expect(errorsOf(result)).toEqual({ buttonTextColor: ['storefront_button_contrast'] });
  });

  // The headline is large text: 3:1 is enough, so a mid-tone panel passes where 4.5 would not
  it('lets the white headline sit on a mid-tone panel, but not on a pale one', () => {
    expect(contrastRatio('#c0602a', SHOP_WHITE)).toBeGreaterThan(CONTRAST_LARGE_TEXT);
    expect(contrastRatio('#c0602a', SHOP_WHITE)).toBeLessThan(CONTRAST_TEXT);
    expect(
      saveStorefrontHeroInputSchema.safeParse({ ...HERO, panelColor: '#c0602a' }).success,
    ).toBe(true);
    const pale = saveStorefrontHeroInputSchema.safeParse({ ...HERO, panelColor: '#eee0d8' });
    expect(errorsOf(pale)).toEqual({ panelColor: ['storefront_panel_contrast'] });
  });
});

describe('a collection', () => {
  it('keeps its listings in the order given', () => {
    expect(
      createStorefrontCollectionInputSchema.parse({
        title: 'Hot & Trending Right Now',
        icon: 'fire',
        listingIds: [LISTING_2, LISTING],
      }).listingIds,
    ).toEqual([LISTING_2, LISTING]);
  });

  it('needs at least one listing', () => {
    const result = createStorefrontCollectionInputSchema.safeParse({
      title: 'Diabetic Corner',
      icon: null,
      listingIds: [],
    });
    expect(errorsOf(result)).toEqual({ listingIds: ['storefront_collection_empty'] });
  });

  it('refuses a listing twice, on the second one', () => {
    const result = updateStorefrontCollectionInputSchema.safeParse({
      version: 2,
      title: 'Diabetic Corner',
      icon: null,
      listingIds: [LISTING, LISTING_2, LISTING],
    });
    expect(errorsOf(result)).toEqual({ 'listingIds.2': ['storefront_listing_twice'] });
  });

  it('holds at most as many listings as the shop shows in a row', () => {
    const ids = Array.from(
      { length: STOREFRONT_COLLECTION_ITEMS_MAX + 1 },
      (_, index) => `${String(index).padStart(8, '0')}-7d2e-4b8e-9a51-3f4c2d1e0a11`,
    );
    const result = createStorefrontCollectionInputSchema.safeParse({
      title: 'Everything',
      icon: null,
      listingIds: ids,
    });
    expect(errorsOf(result)).toEqual({ listingIds: ['too_long'] });
  });
});

describe('a text page', () => {
  it('needs a section: Delete is the way to take a page away', () => {
    expect(
      errorsOf(saveStorefrontPageInputSchema.safeParse({ version: null, sections: [] })),
    ).toEqual({ sections: ['storefront_page_empty'] });
  });

  it('takes a first save without a version', () => {
    expect(
      saveStorefrontPageInputSchema.parse({
        version: null,
        sections: [{ heading: 'Returns', body: 'Unopened items within 7 days.' }],
      }).version,
    ).toBeNull();
  });
});

describe('the Appearance routes', () => {
  it('all need storefront.manage', () => {
    for (const route of Object.values(storefrontAppearanceRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
  });

  // One method and path is one handler: none may meet one of 26g's routes or another of these
  it('do not take a path the Storefront routes have', () => {
    const paths = [
      ...Object.values(storefrontRoutes),
      ...Object.values(storefrontAppearanceRoutes),
    ].map((route) => `${route.method} ${route.path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
```

- "matches the design system for the default colors" checks the formula against the ratios CLAUDE.md gives for the
  Figma colors (7.5:1 and 6.1:1). A wrong weight or a missing gamma step fails here.
- "never lets … pass" pins the `NaN` point above.
- "shows the ratio cut to one decimal" fails if `Math.floor` becomes `Math.round` (checked by breaking it).
- "lets the white headline sit on a mid-tone panel" fails if the panel check uses 4.5 instead of 3 (checked by
  breaking it).
- The link cases include both spellings of "another site that looks like a path" and a quote that would end the
  `href`.
- "do not take a path the Storefront routes have" puts 26g's routes and these in one set: two handlers on one
  method and path would make Nest pick one silently.

### A category may not be called "all": `storefront-admin.ts`

```diff
@@ -302,12 +302,26 @@ const categoryFieldsSchema = z.object({
   slug: slugInputSchema,
 });
 
+// Step 26h: /c/all is the shop's "All Products" page, which the shop answers before it looks for a
+// category, so a category with the slug "all" could never be opened. Checked after withSlug, so a
+// category named "All" with an empty slug box is refused too, on the slug box that would fix it
+function notAllProducts(value: { slug: string }, ctx: z.RefinementCtx): void {
+  if (value.slug === 'all') {
+    ctx.addIssue({
+      code: 'custom',
+      path: ['slug'],
+      message: errorCode('storefront_slug_reserved'),
+    });
+  }
+}
+
 // A new category goes last among its siblings; a new parent moves it, with everything under it, to
 // the end of that parent's list
-export const createStorefrontCategoryInputSchema = withSlug(categoryFieldsSchema);
+export const createStorefrontCategoryInputSchema =
+  withSlug(categoryFieldsSchema).superRefine(notAllProducts);
 export const updateStorefrontCategoryInputSchema = withSlug(
   categoryFieldsSchema.extend({ version: versionSchema }),
-);
+).superRefine(notAllProducts);
 export type CreateStorefrontCategoryInput = z.infer<typeof createStorefrontCategoryInputSchema>;
 export type UpdateStorefrontCategoryInput = z.infer<typeof updateStorefrontCategoryInputSchema>;
 export type StorefrontCategoryFormValues = z.input<typeof createStorefrontCategoryInputSchema>;
```

**Decision 15, a fix to 26g.** The shop answers `/c/all` with All Products before it looks for a category, so a
category with the slug `all` could never be opened, and a banner linking to it would show every product. The check
runs **after** `withSlug`, on its output: a category named "All" with an empty slug box gets the slug `all` from
the name, and is refused too, on the slug box that would fix it. `all-natural` is still fine (the spec checks it).

```diff
@@ -121,6 +121,29 @@ describe('a shop category', () => {
       ),
     ).toEqual({ slug: ['storefront_slug_format'] });
   });
+
+  // Step 26h: /c/all is "All Products", answered before any category, so "all" would hide this one
+  it.each([
+    ['typed', 'All', 'all'],
+    ['made from the name', 'All', ''],
+  ])('refuses the slug "all" (%s) on the slug box', (_how, name, slug) => {
+    const result = createStorefrontCategoryInputSchema.safeParse({ parentId: '', name, slug });
+    expect(errorsOf(result)).toEqual({ slug: ['storefront_slug_reserved'] });
+    const update = updateStorefrontCategoryInputSchema.safeParse({
+      parentId: '',
+      name,
+      slug,
+      version: 3,
+    });
+    expect(errorsOf(update)).toEqual({ slug: ['storefront_slug_reserved'] });
+  });
+
+  it('still takes a longer slug that starts with all', () => {
+    expect(
+      createStorefrontCategoryInputSchema.parse({ parentId: '', name: 'All Natural', slug: '' })
+        .slug,
+    ).toBe('all-natural');
+  });
 });
 
 // A settings form as the page sends it, before the tenant changes anything
```

### The footer's pages: `storefront.ts`

```diff
@@ -44,6 +44,12 @@ export const shopThemeSchema = z.object({
   accent: hexColorSchema,
 });
 
+// The footer's four pages, at /pages/<slug>. Fixed slugs: the footer links to exactly these, and
+// each has its title in the shop's words (shop.footer.*), so a link and the page it opens always
+// say the same. Step 26h moved it up here: publicShopSchema uses it, and a const is not there
+// before its line runs
+export const SHOP_TEXT_PAGES = ['privacy', 'terms', 'about', 'contact'] as const;
+
 export const publicShopSchema = z.object({
   name: z.string().min(1),
   // null: the shop has no logo of its own, so the Omnivo mark is drawn next to its name
@@ -61,6 +67,9 @@ export const publicShopSchema = z.object({
     x: linkSchema.nullable(),
     linkedin: linkSchema.nullable(),
   }),
+  // Step 26h: the text pages the tenant has written, in the footer's order. The footer links only
+  // these, so a shopper never follows a footer link to "page not found"
+  pages: z.array(z.enum(SHOP_TEXT_PAGES)),
 });
 
 export const shopCategorySchema = z.object({
@@ -694,10 +703,7 @@ export const shopTrackingSchema = z.object({
   shipments: z.array(shopShipmentSchema).max(5),
 });
 
-// The footer's four pages, at /pages/<slug>. Fixed slugs: the footer links to exactly these, and
-// each has its title in the shop's words (shop.footer.*), so a link and the page it opens always
-// say the same
-export const SHOP_TEXT_PAGES = ['privacy', 'terms', 'about', 'contact'] as const;
+// The footer's four pages: SHOP_TEXT_PAGES, near the top (publicShopSchema lists the written ones)
 
 // One text page. The HTML is the description's kind (step 26b): <section>s with an <h2>, then <p>,
 // <ul>, <ol>, <strong>, <a> and <br>, written by the API from the tenant's sections (step 26f),
```

**Decision 16.** `publicShopSchema` gets `pages`: the text pages the tenant has written, in the footer's order. The
footer then links only those (decision 5). It is part of the shop's one "who am I" answer, which every page reads
anyway, so the footer needs no request of its own.

`SHOP_TEXT_PAGES` moves up the file, before `publicShopSchema`. It was declared near the end, and a `const` does not
exist before its line runs: `z.enum(SHOP_TEXT_PAGES)` above it would throw a `ReferenceError` when the module
loads, not a type error.

```diff
@@ -63,6 +63,7 @@ describe('public shop', () => {
     timeZone: 'Asia/Dhaka',
     address: 'Zindabazar, Sylhet 3100',
     social: { facebook: null, instagram: null, x: null, linkedin: null },
+    pages: ['terms', 'contact'],
   };
 
   it('takes the workspace time zone', () => {
@@ -73,6 +74,11 @@ describe('public shop', () => {
   it('refuses a time zone Intl does not know', () => {
     expect(publicShopSchema.safeParse({ ...SHOP, timeZone: 'Asia/Sylhet' }).success).toBe(false);
   });
+
+  // Step 26h: the footer links the written pages only, so a page the shop has no route for is a bug
+  it('refuses a text page the footer does not have', () => {
+    expect(publicShopSchema.safeParse({ ...SHOP, pages: ['refunds'] }).success).toBe(false);
+  });
 });
 
 describe('product page', () => {
```

### Error codes and audit events: `errors.ts`, `audit.ts`

```diff
@@ -675,6 +675,28 @@ export const ERROR_CODES = [
   'storefront_image_unreadable',
   'storefront_image_too_small',
   'storefront_image_too_many_pixels',
+  // Step 26h: Appearance and the text pages. A category slug the shop keeps for itself (/c/all), a
+  // color that is not #rrggbb, a banner link that is neither a path nor an https address
+  'storefront_slug_reserved',
+  'storefront_color_format',
+  'storefront_link_format',
+  // The contrast checks (decision 3): the brand color on cream, the accent next to the brand, the
+  // hero's button text on its button, the white headline on the hero's panel. Field errors carry
+  // no params, so the words say the minimum; the form shows the ratio itself next to the boxes
+  'storefront_brand_contrast',
+  'storefront_accent_contrast',
+  'storefront_button_contrast',
+  'storefront_panel_contrast',
+  // The limits (decision 6): six picture banners, eight collections, twelve blocks on the page
+  'storefront_banners_full',
+  'storefront_collections_full',
+  'storefront_home_full',
+  // A collection with no listing, one listing twice in it, or one that is not this workspace's
+  'storefront_collection_empty',
+  'storefront_listing_twice',
+  'storefront_listing_invalid',
+  // A text page saved with no section (Delete is the way to take a page out of the shop)
+  'storefront_page_empty',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Fourteen codes. Each contrast check has its own, so the words can say which color to change. The limits have three
(`storefront_banners_full`, `storefront_collections_full`, `storefront_home_full`): with 6 banners and 8
collections the page could hold 14 blocks, so the page's own limit of 12 is a separate rule.

```diff
@@ -267,6 +267,19 @@ export const AUDIT_ACTIONS = [
   'storefront_listing.published',
   'storefront_listing.unpublished',
   'storefront_listing.deleted',
+  // Step 26h. The logo and colors, the home page's order and the text pages belong to the shop
+  // itself (entity = storefront, entityId = tenant id; a page's slug is in the changes): a page
+  // has no id of its own. The hero is a banner (its changes say kind: hero)
+  'storefront.theme_updated',
+  'storefront.home_moved',
+  'storefront.page_saved',
+  'storefront.page_deleted',
+  'storefront_banner.created',
+  'storefront_banner.updated',
+  'storefront_banner.deleted',
+  'storefront_collection.created',
+  'storefront_collection.updated',
+  'storefront_collection.deleted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -328,6 +341,8 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront',
   'storefront_category',
   'storefront_listing',
+  'storefront_banner',
+  'storefront_collection',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

**Decision 17.** The logo and colors, the home page's order and the text pages are events of the shop itself
(entity `storefront`, the workspace's id, like 26g's settings). A text page has no id of its own (its key is its
slug, and `audit_logs.entity_id` is a uuid), so the slug goes in the changes. Banners and collections have ids and
get entity types of their own. The hero is a banner: its changes say `kind: hero`.

### Registered: `routes.ts`, `index.ts`

```diff
@@ -20,6 +20,7 @@ import { reportScheduleRoutes } from './report-schedules.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { stockMovementReportRoutes } from './stock-movement-report.js';
 import { storefrontRoutes } from './storefront-admin.js';
+import { storefrontAppearanceRoutes } from './storefront-appearance.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
@@ -157,4 +158,5 @@ export const routes = {
   posReturns: posReturnRoutes,
   publicStorefront: publicStorefrontRoutes,
   storefront: storefrontRoutes,
+  storefrontAppearance: storefrontAppearanceRoutes,
 };
```

```diff
@@ -64,6 +64,7 @@ export * from './stock-transfers.js';
 export * from './storefront.js';
 export * from './storefront-content.js';
 export * from './storefront-admin.js';
+export * from './storefront-appearance.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

### The words: `en.ts`, `bn.ts`

```diff
@@ -6102,7 +6102,8 @@ export const en = {
     },
     // Step 26g
     storefront: {
-      manage: 'Run the online shop: its settings, categories, listings and photos, and open it',
+      manage:
+        'Run the online shop: its settings, categories, listings and photos, its look and pages, and open it',
     },
   },
   invite: {
@@ -6182,6 +6183,8 @@ export const en = {
       storefront: 'Online shop',
       storefront_category: 'Shop categories',
       storefront_listing: 'Shop listings',
+      storefront_banner: 'Shop banners',
+      storefront_collection: 'Shop collections',
     },
     columns: {
       when: 'When',
@@ -6511,6 +6514,21 @@ export const en = {
         created: 'Set up the online shop',
         updated: 'Changed the online shop’s settings',
         launched: 'Opened the online shop',
+        // Step 26h
+        theme_updated: 'Changed the shop’s logo or colors',
+        home_moved: 'Moved a block on the shop’s home page',
+        page_saved: 'Wrote or changed a shop page',
+        page_deleted: 'Deleted a shop page',
+      },
+      storefront_banner: {
+        created: 'Added a shop banner',
+        updated: 'Edited a shop banner',
+        deleted: 'Deleted a shop banner',
+      },
+      storefront_collection: {
+        created: 'Added a shop collection',
+        updated: 'Edited a shop collection',
+        deleted: 'Deleted a shop collection',
       },
       storefront_category: {
         created: 'Added a shop category',
@@ -7613,6 +7631,28 @@ export const en = {
       'This photo is too small. Pick one at least 200 pixels on each side.',
     storefront_image_too_many_pixels:
       'This photo has too many pixels. Pick one under 40 megapixels, or make it smaller first.',
+    // Step 26h
+    storefront_slug_reserved:
+      'The shop uses “all” for its All Products page. Pick another link name, like all-items.',
+    storefront_color_format: 'Type a color as # and six letters or digits, like #005859.',
+    storefront_link_format:
+      'Type a page of the shop, starting with /, like /c/skin-care, or a whole link starting with https://.',
+    storefront_brand_contrast:
+      'Names and titles in this color are hard to read on the shop’s light backgrounds. Pick a darker color.',
+    storefront_accent_contrast:
+      'This color is too close to the brand color. Buttons need 4.5:1 between the two. Pick a lighter or darker one.',
+    storefront_button_contrast:
+      'The button’s words are hard to read on it. Make one of the two colors lighter or darker.',
+    storefront_panel_contrast:
+      'The white headline is hard to read on this panel. Pick a darker panel color.',
+    storefront_banners_full: 'The home page has 6 picture banners already. Remove one first.',
+    storefront_collections_full: 'The home page has 8 collections already. Remove one first.',
+    storefront_home_full: 'The home page has 12 blocks already. Remove one first.',
+    storefront_collection_empty: 'Add at least one product to the collection.',
+    storefront_listing_twice: 'This product is in the collection twice. Remove one.',
+    storefront_listing_invalid: 'Pick a product from the shop’s catalog.',
+    storefront_page_empty:
+      'Write at least one section. To take the page out of the shop, delete it.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -5681,7 +5681,7 @@ export const bn: Messages = {
       },
     },
     storefront: {
-      manage: 'অনলাইন শপ চালানো: সেটিংস, ক্যাটাগরি, লিস্টিং আর ছবি, আর শপ খোলা',
+      manage: 'অনলাইন শপ চালানো: সেটিংস, ক্যাটাগরি, লিস্টিং আর ছবি, শপের চেহারা আর পেজ, আর শপ খোলা',
     },
   },
   invite: {
@@ -5761,6 +5761,8 @@ export const bn: Messages = {
       storefront: 'অনলাইন শপ',
       storefront_category: 'শপের ক্যাটাগরি',
       storefront_listing: 'শপের লিস্টিং',
+      storefront_banner: 'শপের ব্যানার',
+      storefront_collection: 'শপের কালেকশন',
     },
     columns: {
       when: 'কখন',
@@ -6079,6 +6081,21 @@ export const bn: Messages = {
         created: 'অনলাইন শপ সেট আপ করেছেন',
         updated: 'অনলাইন শপের সেটিংস বদলেছেন',
         launched: 'অনলাইন শপ খুলেছেন',
+        // ধাপ ২৬h
+        theme_updated: 'শপের লোগো বা রং বদলেছেন',
+        home_moved: 'শপের হোম পেজের একটা ব্লক সরিয়েছেন',
+        page_saved: 'শপের একটা পেজ লিখেছেন বা বদলেছেন',
+        page_deleted: 'শপের একটা পেজ মুছেছেন',
+      },
+      storefront_banner: {
+        created: 'শপের ব্যানার যোগ করেছেন',
+        updated: 'শপের ব্যানার বদলেছেন',
+        deleted: 'শপের ব্যানার মুছেছেন',
+      },
+      storefront_collection: {
+        created: 'শপের কালেকশন যোগ করেছেন',
+        updated: 'শপের কালেকশন বদলেছেন',
+        deleted: 'শপের কালেকশন মুছেছেন',
       },
       storefront_category: {
         created: 'শপের ক্যাটাগরি যোগ করেছেন',
@@ -7130,6 +7147,26 @@ export const bn: Messages = {
     storefront_image_too_small: 'ছবিটা অনেক ছোট। প্রতিটা দিকে অন্তত ২০০ পিক্সেলের একটা বাছুন।',
     storefront_image_too_many_pixels:
       'ছবিটায় অনেক বেশি পিক্সেল। ৪০ মেগাপিক্সেলের কম একটা বাছুন, বা আগে ছোট করে নিন।',
+    // ধাপ ২৬h
+    storefront_slug_reserved:
+      'শপ “all” নিজের All Products পেজের জন্য রাখে। অন্য একটা লিংকের নাম দিন, যেমন all-items।',
+    storefront_color_format: '# আর ছয়টা অক্ষর বা সংখ্যা দিয়ে রং লিখুন, যেমন #005859।',
+    storefront_link_format:
+      'শপের একটা পেজ লিখুন, / দিয়ে শুরু করে, যেমন /c/skin-care, বা https:// দিয়ে শুরু হওয়া পুরো লিংক দিন।',
+    storefront_brand_contrast:
+      'এই রঙে নাম আর শিরোনাম শপের হালকা পটভূমিতে পড়া কঠিন। আরেকটু গাঢ় রং বাছুন।',
+    storefront_accent_contrast:
+      'এই রং ব্র্যান্ডের রঙের খুব কাছাকাছি। বাটনের জন্য দুটোর মধ্যে ৪.৫:১ লাগে। আরও হালকা বা গাঢ় একটা বাছুন।',
+    storefront_button_contrast:
+      'বাটনের লেখা বাটনের ওপর পড়া কঠিন। দুটো রঙের একটা আরও হালকা বা গাঢ় করুন।',
+    storefront_panel_contrast: 'এই প্যানেলে সাদা শিরোনাম পড়া কঠিন। প্যানেলের রং আরেকটু গাঢ় করুন।',
+    storefront_banners_full: 'হোম পেজে আগে থেকেই ৬টা ছবির ব্যানার আছে। আগে একটা সরান।',
+    storefront_collections_full: 'হোম পেজে আগে থেকেই ৮টা কালেকশন আছে। আগে একটা সরান।',
+    storefront_home_full: 'হোম পেজে আগে থেকেই ১২টা ব্লক আছে। আগে একটা সরান।',
+    storefront_collection_empty: 'কালেকশনে অন্তত একটা প্রোডাক্ট দিন।',
+    storefront_listing_twice: 'এই প্রোডাক্ট কালেকশনে দুইবার আছে। একটা সরান।',
+    storefront_listing_invalid: 'শপের ক্যাটালগ থেকে একটা প্রোডাক্ট বাছুন।',
+    storefront_page_empty: 'অন্তত একটা অংশ লিখুন। শপ থেকে পেজটা সরাতে চাইলে মুছে দিন।',
   },
   ui: {
     dataTable: {
```

The errors, the audit events, the two entity types, and the permission's line, which now says it covers the shop's
look and pages too. The screens' own words come in 26h.5. Each error says what to change; the contrast errors say
which color, because the form shows the number.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test              # 614 tests
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/db build                    # the audit types the API reads
pnpm exec eslint packages/contracts/src packages/i18n/src
```

Expected to fail until later parts, and only these:

- `apps/api`: `public-storefront.service.ts` has no `pages` in its shop answer, and `contract.spec.ts` and
  `pnpm test:openapi` find 16 routes with no controller, until 26h.3.
- `apps/shop`: its mock shop (`src/data/mock/shop.ts`) has no `pages`, until 26h.3.

## 26h.2 — The database

The tables this step writes were made in 26f: `storefront_banners`, `storefront_collections`,
`storefront_collection_items`, `storefront_home_blocks`, `storefront_pages`, and the logo and color columns of
`storefront_settings`. Row-level security, the `tenant_isolation` policy and the `omnivo_public` read rules are on
all of them already (0064). The audit log has no check on its actions or entity types. So this part adds no table.
It adds four rules the API could break by mistake, and the permission's new line:

- a shop category may not be called `all` (decision 15, now in the database too);
- the logo is a photo of the same workspace (an FK);
- a collection holds at most 24 listings, and the home page at most 12 blocks (decision 6);
- the `storefront.manage` line says it covers the shop's look and pages.

**Decision 18 (mine): the database refuses the category slug `all` too.** The contracts refuse it from 26h.1 on. A
check in the database also covers a later bug in the API and any other writer, and it costs one line. The banner's
"Links to" picker (decision 4) depends on it: `/c/all` must always mean All Products.

**Decision 19 (mine): the logo gets a composite FK to `storefront_images`.** It is the only photo saved in its own
`uuid` column. Listings and banners keep their photos inside `jsonb`, where an FK is not possible, so the API checks
those. The FK cannot check that the photo is ready. The API still checks that (26h.3), as it does for listings.

**Decision 20 (mine): the counts are capped through the positions.** A CHECK sees one row at a time, so it cannot
count rows. But a collection's items and the home blocks are numbered 1, 2, 3… with no gaps (the API always writes
them that way) and a position is unique. So "position at most 24" means "at most 24 rows". The other two limits, 6
picture banners and 8 collections, have no position column. They stay with the API, which counts them while it
holds a lock (26h.3).

### The schema: `storefront.ts`

```diff
@@ -4,6 +4,8 @@ import {
   SHOP_TEXT_PAGES,
   STOREFRONT_IMAGE_FAILURES,
   STOREFRONT_IMAGE_MAX_PIXELS,
+  STOREFRONT_COLLECTION_ITEMS_MAX,
+  STOREFRONT_HOME_BLOCKS_MAX,
   STOREFRONT_IMAGE_MIN_SIDE,
   STOREFRONT_SALE_KINDS,
   type ShopBadge,
@@ -86,7 +88,7 @@ export const storefrontSettings = pgTable(
     name: text('name').notNull(),
     language: text('language', { enum: LANGUAGE_CODES }).notNull().default('en'),
     // An uploaded picture (StorefrontImage's id, step 26g); its alt text is the shop's name. NULL:
-    // the Omnivo mark is drawn next to the name
+    // the Omnivo mark is drawn next to the name. Step 26h's Appearance page writes it
     logoImageId: uuid('logo_image_id'),
     // The two colours a tenant may change (CLAUDE.md → Storefront color tokens). The defaults are
     // Figma's. That they keep 4.5:1 between them is checked by step 26g's form, not here: a
@@ -160,6 +162,16 @@ export const storefrontSettings = pgTable(
       columns: [table.tenantId, table.defaultWarehouseId],
       foreignColumns: [warehouses.tenantId, warehouses.id],
     }),
+    // Step 26h: the logo is a photo of this workspace. The pair, so another workspace's photo id is
+    // refused here whatever the API checks first. No ON DELETE: a photo in use as the logo cannot
+    // be deleted (the later unused-photo cleanup must skip it anyway). NULL skips the check, as in
+    // every composite FK here. storefrontImages is defined further down; drizzle reads this list
+    // only after the whole file has run
+    foreignKey({
+      name: 'storefront_settings_logo_fk',
+      columns: [table.tenantId, table.logoImageId],
+      foreignColumns: [storefrontImages.tenantId, storefrontImages.id],
+    }),
   ],
 );
 
@@ -209,6 +221,10 @@ export const storefrontCategories = pgTable(
       'storefront_categories_slug_check',
       sql`${matches(table.slug, SLUG_PATTERN)} AND char_length(${table.slug}) <= 100`,
     ),
+    // Step 26h: /c/all is the shop's "All Products" page, so a category called "all" could never
+    // be opened, and a banner's "Links to: a category" could not tell the two apart. Its own check,
+    // not one more AND in the one above, so the API can answer storefront_slug_reserved by name
+    check('storefront_categories_slug_reserved_check', sql`${table.slug} <> 'all'`),
   ],
 );
 
@@ -458,7 +474,13 @@ export const storefrontCollectionItems = pgTable(
       columns: [table.tenantId, table.listingId],
       foreignColumns: [storefrontListings.tenantId, storefrontListings.id],
     }).onDelete('cascade'),
-    check('storefront_collection_items_position_check', sql`${table.position} >= 1`),
+    // Step 26h: at most 24 listings in a row (the public API shows no more). The positions are
+    // 1, 2, 3… with no gaps (a save writes them all) and unique, so a cap on the position is a cap on
+    // the count, which a CHECK cannot count by itself
+    check(
+      'storefront_collection_items_position_check',
+      sql`${table.position} BETWEEN 1 AND ${sql.raw(String(STOREFRONT_COLLECTION_ITEMS_MAX))}`,
+    ),
   ],
 );
 
@@ -503,7 +525,11 @@ export const storefrontHomeBlocks = pgTable(
       'storefront_home_blocks_one_check',
       sql`num_nonnulls(${table.bannerId}, ${table.collectionId}) = 1`,
     ),
-    check('storefront_home_blocks_position_check', sql`${table.position} >= 1`),
+    // Step 26h: at most 12 blocks on the home page, the same way as the collection's 24 above
+    check(
+      'storefront_home_blocks_position_check',
+      sql`${table.position} BETWEEN 1 AND ${sql.raw(String(STOREFRONT_HOME_BLOCKS_MAX))}`,
+    ),
   ],
 );
 
@@ -560,6 +586,9 @@ export const storefrontImages = pgTable(
     processedAt: timestamp('processed_at', { withTimezone: true }),
   },
   (table) => [
+    // Step 26h: the target of the logo's FK in storefront_settings. A composite FK needs a unique
+    // index on exactly its columns; the primary key on id alone is not one
+    uniqueIndex('storefront_images_tenant_id_idx').on(table.tenantId, table.id),
     // The photo is this workspace's attachment. The pair, not the id alone: another workspace's
     // attachment id is refused here too, whatever the API checks first. CASCADE: the row only
     // describes its attachment, so the later unused-photo cleanup deletes the attachment alone
```

Why each change is written this way:

- **The two new constants come from the contracts** (`STOREFRONT_COLLECTION_ITEMS_MAX`, `STOREFRONT_HOME_BLOCKS_MAX`,
  from 26h.1). The form, the API and the database then read one number. If the number changes later,
  `drizzle-kit generate` writes a new migration by itself, because the check's text changes. They go into the SQL
  with `sql.raw`, for the same reason as the photo limits in 26g: a CHECK cannot take a bound parameter (`$1`), and
  these are the code's own constants, never input.
- **`storefront_categories_slug_reserved_check` is a check of its own.** One more `AND` in
  `storefront_categories_slug_check` would refuse the same rows, but under the same name as a badly formed slug.
  With its own name, the API can tell the two apart by the constraint's name, the way it already turns
  `storefront_categories_slug_idx` into `storefront_slug_taken`. Only categories get it. A listing's address is
  `/p/<slug>`, where `all` means nothing special.
- **`storefront_images_tenant_id_idx`.** An FK must point at columns that have a unique index on exactly those
  columns. The primary key is on `id` alone, so `(tenant_id, id)` needs its own index. It is the same pattern as
  `storefront_banners_tenant_id_idx` and the other `*_tenant_id_idx` indexes that the composite FKs point at.
- **`storefront_settings_logo_fk` uses the pair `(tenant_id, logo_image_id)`**, not the id alone. So workspace A
  can never save workspace B's photo as its logo, whatever the API checks first. This is the same reason as the
  photo's own FK to `attachments` in 26g.
- **The FK has no `ON DELETE`.** A photo that is the logo cannot be deleted while it is the logo. That holds
  through the cascade too: deleting the photo's attachment would delete its `storefront_images` row, and the FK
  stops that. `ON DELETE SET NULL` is not possible here: it would set both columns to NULL, and `tenant_id` is
  `NOT NULL`. Postgres 15 can set only some of the columns, but drizzle cannot write that. Refusing is the right
  answer anyway: the later photo cleanup (decision 8) must skip a photo in use, wherever it is used.
- **A `NULL` logo needs nothing extra.** A composite FK checks a row only when all its columns are filled
  (`MATCH SIMPLE`, the default), so "no logo" passes.
- **`storefrontImages` is used above its definition.** That is fine: drizzle calls the table's second argument (the
  list of indexes, checks and FKs) only after the whole file has run. Moving the 26g table up would only make the
  diff bigger.
- **The position checks become `BETWEEN 1 AND …`.** They replace the `>= 1` checks of 26f under the same names,
  because they are the same rule, with an upper end now.

### The migrations

There are three files. Drizzle would write the schema change as one file, but in the wrong order: it adds the FK
before the unique index the FK needs, and Postgres refuses that ("there is no unique constraint matching given
keys"). Editing a generated file by hand is not a good fix, because the next `generate` would not know about the
edit. So the schema was generated in two steps: first everything except the logo's FK, then the FK. In front of
both there is one data migration.

```sql
-- Custom SQL migration file, put your code below! --
-- Step 26h: 0068 adds storefront_categories_slug_reserved_check (a category may not be called
-- "all", because /c/all is the shop's All Products page). Step 26g's screens allowed that slug, so
-- a workspace may have one already, and ADD CONSTRAINT would then fail the whole deploy. This file
-- gives such a category another slug first: "all-" and the last 12 characters of its id (the
-- random part of a uuidv7; the first part is the time, which two rows made close together share).
-- The category could never be opened anyway: the shop answered /c/all with All Products.
-- version + 1, so a Storefront screen still open on the old row gets a conflict when it saves,
-- instead of writing "all" back (the contracts refuse that now, but with a less helpful error).
-- Per workspace with app.tenant_id set, because FORCE RLS applies to the table owner too (0060);
-- cleared at the end. A deleted workspace too: it may be restored.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);

    UPDATE storefront_categories
       SET slug = 'all-' || right(id::text, 12),
           updated_at = now(),
           version = version + 1
     WHERE tenant_id = t AND slug = 'all';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
```

`0067` is a custom migration (`drizzle-kit generate --custom --name storefront-slug-all`). It must run before `0068`:

- **Why a data fix is needed.** 26g's screens allowed the slug `all`, so a workspace on staging or on your own
  machine may have such a category. `ADD CONSTRAINT … CHECK` checks every existing row. One `all` row would fail
  the migration, and with it the whole deploy. The check below did that on purpose.
- **The new slug is `all-` plus the last 12 characters of the id.** It still fits the slug pattern (lower-case hex
  and a hyphen). It is the random end of a uuidv7. The first part of a uuidv7 is the time, and two categories made
  close together would share it. Only one row per workspace can be called `all` (the slug is unique in a workspace),
  so one rename per workspace never collides with itself.
- **Nothing is lost.** The shop always answered `/c/all` with All Products, so this category could never be opened.
  Its listings keep it by id.
- **`version + 1`.** A Storefront screen that is still open on the old row then gets a conflict when it saves,
  instead of trying to write `all` back.
- **The loop sets `app.tenant_id` for each workspace**, as `0060` does. `FORCE ROW LEVEL SECURITY` holds for the
  table's owner, the migrator, too. Without the setting, the `UPDATE` would see no rows, change nothing, and `0068`
  would still fail. Deleted workspaces are included, because one may be restored. The setting is cleared at the
  end.

```sql
ALTER TABLE "storefront_collection_items" DROP CONSTRAINT "storefront_collection_items_position_check";--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" DROP CONSTRAINT "storefront_home_blocks_position_check";--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_images_tenant_id_idx" ON "storefront_images" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_slug_reserved_check" CHECK ("storefront_categories"."slug" <> 'all');--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_position_check" CHECK ("storefront_collection_items"."position" BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_position_check" CHECK ("storefront_home_blocks"."position" BETWEEN 1 AND 12);
```

`0068` is what `drizzle-kit generate --name storefront-appearance` wrote with the logo's FK left out of the schema
for a moment. It drops the two position checks and adds them back with their upper end. Postgres cannot change a
check in place. It also adds the images' unique index and the reserved-slug check.

```sql
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_logo_fk" FOREIGN KEY ("tenant_id","logo_image_id") REFERENCES "public"."storefront_images"("tenant_id","id") ON DELETE no action ON UPDATE no action;
```

`0069` is the second `generate` (`--name storefront-logo`), after the FK was back in the schema. It runs after the
index exists. All three files run in one transaction (drizzle's migrator), so a failure in any of them leaves the
database as it was.

No `-rules` file this time: no table is new, so there is no row-level security to add. The `omnivo_public` grants
of 0064 already cover every column the shop reads, and the shop never reads `storefront_images`.

### The permission's line: `permission-catalog.ts`

```diff
@@ -69,7 +69,7 @@ const DESCRIPTIONS = {
   'pos.return.create':
     'Take goods back at a POS register and pay the money back, or use it for an exchange',
   'storefront.manage':
-    'Run the online shop: its settings, categories, listings and photos, and open it to shoppers',
+    'Run the online shop: its settings, categories, listings and photos, its look and pages, and open it to shoppers',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

The same words as the screens' line from 26h.1. No migration writes it: `migrate.ts` calls `syncPermissions()` after
the migrations, which updates the descriptions.

### Check this part

```bash
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/db typecheck
pnpm exec eslint packages/db/src
pnpm exec prettier --check packages/db/src
pnpm db:migrate
```

`apps/api` still fails its type check on `public-storefront.service.ts` only (no `pages` yet), as after 26h.1.

The guide was checked against a fresh Postgres 17. Every migration up to `0066` ran as the migrator. Then two
workspaces were added, each with a category called `all`, 25 listings and a photo. Then `0067`–`0069` ran, and
then a script ran as `omnivo_app`:

- both `all` categories became `all-00000000c001` (version 2), and the other categories did not change; the
  permission's line was updated;
- the slug `all` is refused on insert and on rename, by `storefront_categories_slug_reserved_check`; `allergy` and
  `all-…` are fine;
- the logo takes this workspace's photo or NULL; another workspace's photo and an id that is no photo are refused
  by `storefront_settings_logo_fk`; a photo still processing passes the FK (the API's check, 26h.3);
- the logo's photo cannot be deleted, neither directly nor through its attachment's cascade; an unused photo can;
- a collection takes positions 1 to 24 and refuses 25 and 0; the home page takes 12 and refuses 13;
- for 26h.3: swapping two home blocks with one `UPDATE … SET position = CASE …` fails with `23505`. Postgres
  checks a unique key that is not `DEFERRABLE` row by row, so for a moment two rows have the same position.
  Deleting both rows and writing them back swapped, in one transaction, works;
- workspace B sees none of A's blocks and keeps its own renamed category.

Broken on purpose:

- `0067` left out: `0068` fails with `23514` on the old `all` rows, and nothing is applied;
- the FK added before the unique index: "there is no unique constraint matching given keys".

## 26h.3 — The API

This part serves the 16 routes of 26h.1 and gives the shop its `pages`. After it, `apps/api` and `apps/shop` type
check again, and `contract.spec.ts` and `pnpm test:openapi` pass. The integration tests come in 26h.4, the screens in
26h.6.

What the part adds:

```
apps/api/src/storefront/
  admin/
    home-blocks.ts                     the home page's order: lock, read, add at the end, write again
    appearance.service.ts              the logo and colors, the hero, the picture banners, Move up / down
    collections.service.ts             the collections and their listings
    pages.service.ts                   the four text pages
    storefront-appearance.controller.ts  the 16 routes
    listings.service.ts                summaries(): listings by id, as the catalog shows them
    categories.service.ts              the reserved slug's check, said on the box
  storefront.module.ts                 the new controller and services
  public-storefront.service.ts         the shop's `pages`
apps/shop/src/
  data/mock/shop.ts                    the mock shop's `pages` (all four)
  components/Footer.astro              links only the written pages
packages/contracts/openapi.json        regenerated with the 16 routes
```

Decisions made while writing this part (mine, numbered after 26h.2's 20):

21. **Its own controller and three services.** The contract has its own group (`storefrontAppearance`, decision 10),
    so the API has its own controller next to 26g's, which does not change. The services split by what they keep:
    `StorefrontAppearanceService` (the settings row's logo and colors, the hero and the picture banners, the order),
    `StorefrontCollectionsService` and `StorefrontPagesService`. The order of the home page is used by the first two,
    so it lives in plain functions in `home-blocks.ts`, not in a fourth service.
22. **One lock for the home page.** Every write that adds, removes or moves a block takes one advisory lock per
    workspace first, like the shop's categories (26g). The limits (6 banners, 8 collections, 12 blocks) are counted
    while it is held, so two "Add" clicks at once cannot both see room for the last place.
23. **The order is written again as 1, 2, 3… after every move and every delete.** A delete leaves a gap (its block
    goes with it, by the FK's cascade). Without the renumbering, the next block would go after the gap, and the
    position check (1 to 12, decision 20) would refuse a block while the page has fewer than 12. Writing is delete
    and insert, because a swap in one `UPDATE` fails with `23505` (proven in 26h.2). The page has 12 rows at most.
24. **Every route that reads or adds needs the shop set up** (`storefront_not_set_up`), as the catalog's do. The
    logo and the colors are columns of the settings row, and "View shop" and "View page" need the shop's address.
    The screens show "Set up the shop first" before it. A route that changes, moves or deletes one banner,
    collection, hero or page answers 404 before it: none can exist yet, so it is an id or a slug with no row, like
    any other (26h.4 tests both).
25. **Move up / down is logged on the block itself** (`storefront.home_moved` with the banner's or the collection's
    entity and id, "position: 2 → 3"). This changes decision 17 a little: only the logo and colors and the pages are
    logged on the shop (entity `storefront`). A move on the shop's entity could not say which block moved without
    an odd "from X to X" line, and the log's link now opens the block that moved.
26. **A page's log line is keyed by its slug**, with its headings as the value: `terms: Delivery, Returns →
    Delivery, Returns, Payment`. It is built by hand, not with `diff()`, because a save that changed only the text
    keeps the same headings, and `diff()` would then leave the page out of its own log line.
27. **A collection's "published" count is what the launch checklist counts**: published, with its product and
    variant not archived in the ERP. These are the listings the shop shows; the Home page card can then say "3 of 5
    in the shop now".

### The home page's order: `home-blocks.ts`

```ts
import {
  type ErrorCode,
  STOREFRONT_HOME_BLOCKS_MAX,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHomeBlock,
} from '@omnivo/contracts';
import { storefrontHomeBlocks } from '@omnivo/db';
import { asc, eq, sql } from 'drizzle-orm';

import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';

// Step 26h: the home page's order (storefront_home_blocks), shared by the banners, the collections
// and Move up / down. A block is a banner or a collection; its key is its place on the page.

// What a block points at. Exactly one of the two, like the table's storefront_home_blocks_one_check
export type HomeBlockRef =
  { bannerId: string; collectionId: null } | { bannerId: null; collectionId: string };

// Every change to the order takes this lock first: adding a banner and a collection at once must
// not both take the place after the last one, and a move must not swap a block that a delete is
// taking away. The page has at most twelve blocks that change rarely, so the wait is nothing
export async function lockHome(tx: Transaction): Promise<void> {
  const key = `storefront_home:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The blocks in the page's order
export async function homeBlockRefs(tx: Transaction): Promise<HomeBlockRef[]> {
  const rows = await tx
    .select({
      bannerId: storefrontHomeBlocks.bannerId,
      collectionId: storefrontHomeBlocks.collectionId,
    })
    .from(storefrontHomeBlocks)
    .where(eq(storefrontHomeBlocks.tenantId, getTenantId()))
    .orderBy(asc(storefrontHomeBlocks.position));
  // The table's check makes each row one or the other; this tells TypeScript
  return rows.flatMap((row): HomeBlockRef[] => {
    if (row.bannerId !== null) return [{ bannerId: row.bannerId, collectionId: null }];
    if (row.collectionId !== null) return [{ bannerId: null, collectionId: row.collectionId }];
    return [];
  });
}

// A refusal for a full list. No box to put it under: it belongs to the "Add" button
export function full(code: ErrorCode, detail: string): AppError {
  return new AppError(409, code, detail);
}

// Room for one more block. Asked before the banner or collection is made, under lockHome, so the
// answer still holds at the insert. The table's position check (1–12) would refuse a 13th too,
// as a 500: this says it in words
export async function checkHomeRoom(tx: Transaction): Promise<void> {
  if ((await homeBlockRefs(tx)).length >= STOREFRONT_HOME_BLOCKS_MAX) {
    throw full('storefront_home_full', 'The home page has 12 blocks. Remove one first.');
  }
}

// A new banner or collection goes to the end of the page (decision 2: everything is on the page)
export async function appendHomeBlock(tx: Transaction, ref: HomeBlockRef): Promise<void> {
  const blocks = await homeBlockRefs(tx);
  await tx.insert(storefrontHomeBlocks).values({
    tenantId: getTenantId(),
    // The positions are 1, 2, 3… with no gap (writeHomeBlocks keeps them so), so the count is the
    // last one
    position: blocks.length + 1,
    ...ref,
  });
}

// Writes the whole order again, as 1, 2, 3… Used by Move (a swap) and after a delete (the gap
// closes). Delete and insert, not UPDATE: the key is (tenant, position) and not deferrable, so a
// swap in one UPDATE meets the other row's old position and fails with 23505 (proven in 26h.2).
// Twelve rows at most
export async function writeHomeBlocks(tx: Transaction, refs: readonly HomeBlockRef[]) {
  await tx.delete(storefrontHomeBlocks).where(eq(storefrontHomeBlocks.tenantId, getTenantId()));
  if (refs.length === 0) return;
  await tx
    .insert(storefrontHomeBlocks)
    .values(refs.map((ref, index) => ({ tenantId: getTenantId(), position: index + 1, ...ref })));
}

// The page's blocks as the Appearance page shows them. A block whose banner or collection the
// maps do not have is left out; it cannot happen (the FKs cascade), and a half block on the screen
// would be worse than one missing
export function homeBlocksOf(
  refs: readonly HomeBlockRef[],
  banners: ReadonlyMap<string, StorefrontBanner>,
  collections: ReadonlyMap<string, StorefrontCollectionSummary>,
): StorefrontHomeBlock[] {
  return refs.flatMap((ref): StorefrontHomeBlock[] => {
    if (ref.bannerId !== null) {
      const banner = banners.get(ref.bannerId);
      return banner === undefined ? [] : [{ kind: 'banner', banner }];
    }
    const collection = collections.get(ref.collectionId);
    return collection === undefined ? [] : [{ kind: 'collection', collection }];
  });
}
```

Why it is written this way:

- **`HomeBlockRef` is a union with both keys in each case** (`bannerId: null` in the collection case). The table's
  `storefront_home_blocks_one_check` says exactly one of the two is set; the type says the same, and an object of
  either case can be spread straight into an insert (`...ref`) with both columns named.
- **`lockHome` uses `pg_advisory_xact_lock` on a text key with the workspace's id** (decision 22). The lock ends with
  the transaction, so no code path can forget to let it go. It is the same pattern as `lockTree` in
  `categories.service.ts`. A row lock would not work here: the rows that matter (the next position) do not exist yet.
- **`homeBlockRefs` drops a row that is neither**, instead of throwing. The check makes that row impossible; the
  `flatMap` is only how TypeScript learns that each kept row is one case or the other.
- **`full()` has no field errors.** A full list is not about a box in a form; the screen shows it next to the
  "Add" button.
- **`checkHomeRoom` runs before the banner or collection is inserted.** If it ran after, the new row would already
  exist when the 13th block is refused; the transaction would roll it back, but the error would come from the
  position check as a 500. Asked first, under the lock, the answer is a clear `storefront_home_full`.
- **`appendHomeBlock` takes `blocks.length + 1` as the position.** That is right only because the positions have no
  gaps (decision 23). If they ever had one, this would collide with an existing position and fail with `23505`
  rather than overwrite anything.
- **`writeHomeBlocks` deletes every block of the workspace and inserts the list again.** It is called with the full
  list, so nothing is lost. The `refs.length === 0` return is needed: Drizzle throws on an insert with no rows.
- **`homeBlocksOf` leaves out a block whose banner or collection is missing.** The FKs cascade, so this cannot
  happen in one transaction. Still, a screen that shows a block with nothing in it would be worse than one that does
  not show it.

### Listings by id: `listings.service.ts`

```diff
@@ -33,7 +33,7 @@ import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-contex
 import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
 import type { Config } from '../../config.js';
 import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
-import { isoText } from '../listing-sql.js';
+import { idIn, isoText } from '../listing-sql.js';
 import { shopUrl } from '../shop-url.js';
 import { slugTaken, StorefrontCategoriesService } from './categories.service.js';
 import { StorefrontImagesService } from './images.service.js';
@@ -460,6 +460,26 @@ export class StorefrontListingsService {
     }
   }
 
+  // Step 26h: these listings as the catalog shows them, by id, for a collection's page and its
+  // save. An id that is not this workspace's listing is missing from the map, which is how the
+  // collection's save finds one (storefront_listing_invalid). Drafts and archived products are
+  // there too: a collection may hold them, and the shop leaves them out until they can be shown
+  async summaries(
+    tx: Transaction,
+    ids: readonly string[],
+  ): Promise<Map<string, StorefrontListingSummary>> {
+    if (ids.length === 0) return new Map();
+    const shop = await this.settings.find(tx, false);
+    const rows = await this.select(
+      tx,
+      shop?.defaultWarehouseId ?? null,
+      '-updated',
+      idIn(sql`l.id`, ids),
+      sql``,
+    );
+    return new Map(rows.map((row) => [row.id, this.toSummary(row)]));
+  }
+
   publish(id: string, version: number): Promise<StorefrontListing> {
     return this.setPublished(id, version, true);
   }
```

A collection's page shows its listings as the catalog does (photo, name, SKU, price, status). `summaries()` reuses the
catalog's own SQL (`listingsSql`) and `toSummary()`, so the two pages can never show a listing differently. It
answers a `Map` by id, not a list: the collection keeps its own order (positions), and the caller walks its ids
through the map. An id that is not in the map is not a listing of this workspace (RLS hides the others), which is
exactly what the collection's save needs to check. `idIn` (from 26f's `listing-sql.ts`) casts each id to `uuid`; the
ids come from the contract (`z.uuid()`), so a cast never fails. With no ids it answers at once: `idIn` would write
`false`, but there is no reason to read the settings row first.

### Collections: `collections.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontCollectionInput,
  type ErrorCode,
  STOREFRONT_COLLECTION_ICONS,
  STOREFRONT_COLLECTIONS_MAX,
  type StorefrontCollection,
  type StorefrontCollectionSummary,
  type UpdateStorefrontCollectionInput,
} from '@omnivo/contracts';
import { storefrontCollectionItems, storefrontCollections } from '@omnivo/db';
import { and, asc, count, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isForeignKeyViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';
import {
  appendHomeBlock,
  checkHomeRoom,
  full,
  homeBlockRefs,
  lockHome,
  writeHomeBlocks,
} from './home-blocks.js';
import { StorefrontListingsService } from './listings.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

// A collection with its two counts, straight from SQL
const summaryRowSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  icon: z.enum(STOREFRONT_COLLECTION_ICONS).nullable(),
  version: z.number().int(),
  updated_at: z.iso.datetime(),
  listing_count: z.number().int(),
  published_count: z.number().int(),
});

// "Published" as the launch checklist counts it (settings.service.ts readiness): published, and its
// product and variant not archived in the ERP. The shop shows exactly those; a draft in the row
// waits there until it is published
function summarySql(where: SQL): SQL {
  return sql`
    SELECT c.id::text, c.title, c.icon, c.version, ${isoText(sql`c.updated_at`)} AS updated_at,
           count(i.listing_id)::int AS listing_count,
           (count(i.listing_id) FILTER (
             WHERE l.published_at IS NOT NULL AND p.archived_at IS NULL AND v.archived_at IS NULL
           ))::int AS published_count
      FROM storefront_collections c
      LEFT JOIN storefront_collection_items i
             ON i.tenant_id = c.tenant_id AND i.collection_id = c.id
      LEFT JOIN storefront_listings l ON l.tenant_id = i.tenant_id AND l.id = i.listing_id
      LEFT JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      LEFT JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE c.tenant_id = ${getTenantId()}::uuid AND ${where}
     GROUP BY c.id`;
}

// A listing deleted between the check and the insert (another tab, at that moment): the FK
// refuses the row. Said like the check says it, without a box: which one went is not known here
function listingGone(error: unknown): AppError | null {
  if (!isForeignKeyViolation(error, 'storefront_collection_items_listing_fk')) return null;
  return new AppError(409, 'storefront_listing_invalid', 'A listing is not in the shop.');
}

// The audit's view: the title, the icon and the listings in their order, as text
function snapshot(row: { title: string; icon: string | null }, listingIds: readonly string[]) {
  return { title: row.title, icon: row.icon, listings: listingIds.join(', ') };
}

// Step 26h: the rows of hand-picked listings on the home page ("Hot & Trending Right Now"). Each
// is a block of the page from the moment it is made until it is deleted (decision 2).
@Injectable()
export class StorefrontCollectionsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly settings: StorefrontSettingsService,
    private readonly listings: StorefrontListingsService,
  ) {}

  get(id: string): Promise<StorefrontCollection> {
    return this.withTenant(async (tx) => {
      await this.requireShop(tx);
      return this.load(tx, id);
    });
  }

  async create(input: CreateStorefrontCollectionInput): Promise<StorefrontCollection> {
    try {
      return await this.withTenant(async (tx) => {
        await lockHome(tx);
        await this.requireShop(tx);
        const [counted] = await tx
          .select({ total: count() })
          .from(storefrontCollections)
          .where(eq(storefrontCollections.tenantId, getTenantId()));
        if ((counted?.total ?? 0) >= STOREFRONT_COLLECTIONS_MAX) {
          throw full(
            'storefront_collections_full',
            'The shop has 8 collections. Remove one first.',
          );
        }
        await checkHomeRoom(tx);
        await this.checkListings(tx, input.listingIds);
        const [row] = await tx
          .insert(storefrontCollections)
          .values({
            tenantId: getTenantId(),
            title: input.title.normalize('NFC'),
            icon: input.icon,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Collection insert returned no row');
        await this.writeItems(tx, row.id, input.listingIds);
        await appendHomeBlock(tx, { bannerId: null, collectionId: row.id });
        await audit(tx, {
          action: 'storefront_collection.created',
          entityType: 'storefront_collection',
          entityId: row.id,
          changes: created(snapshot(row, input.listingIds)),
        });
        return this.load(tx, row.id);
      });
    } catch (error) {
      throw listingGone(error) ?? error;
    }
  }

  async update(id: string, input: UpdateStorefrontCollectionInput): Promise<StorefrontCollection> {
    try {
      return await this.withTenant(async (tx) => {
        await this.requireShop(tx);
        const before = await this.find(tx, id);
        if (before.version !== input.version) throw versionConflict();
        const listingIdsBefore = await this.itemIds(tx, id);
        await this.checkListings(tx, input.listingIds);
        const [after] = await tx
          .update(storefrontCollections)
          .set({
            title: input.title.normalize('NFC'),
            icon: input.icon,
            // The listings are part of the collection: a form open on it should know they changed
            version: sql`${storefrontCollections.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(
              eq(storefrontCollections.tenantId, getTenantId()),
              eq(storefrontCollections.id, id),
            ),
          )
          .returning();
        if (!after) throw notFound('Collection');
        await this.writeItems(tx, id, input.listingIds);
        await audit(tx, {
          action: 'storefront_collection.updated',
          entityType: 'storefront_collection',
          entityId: id,
          changes: diff(snapshot(before, listingIdsBefore), snapshot(after, input.listingIds)),
        });
        return this.load(tx, id);
      });
    } catch (error) {
      throw listingGone(error) ?? error;
    }
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const before = await this.find(tx, id);
      if (before.version !== version) throw versionConflict();
      const listingIdsBefore = await this.itemIds(tx, id);
      // Its rows and its block go with it (both FKs cascade, 26f); the listings stay
      await tx
        .delete(storefrontCollections)
        .where(
          and(eq(storefrontCollections.tenantId, getTenantId()), eq(storefrontCollections.id, id)),
        );
      // The block's place is a gap now: 1, 2, 4. Numbered again, or the next block added would go
      // to 4 while a 12th could never be added (the position check stops at 12)
      await writeHomeBlocks(tx, await homeBlockRefs(tx));
      await audit(tx, {
        action: 'storefront_collection.deleted',
        entityType: 'storefront_collection',
        entityId: id,
        changes: diff(snapshot(before, listingIdsBefore), {
          title: null,
          icon: null,
          listings: null,
        }),
      });
    });
  }

  // Every collection of the shop with its counts, by id, for the Appearance page's blocks
  async summaries(tx: Transaction): Promise<Map<string, StorefrontCollectionSummary>> {
    const rows = z.array(summaryRowSchema).parse(await tx.execute(summarySql(sql`true`)));
    return new Map(rows.map((row) => [row.id, toSummary(row)]));
  }

  private async requireShop(tx: Transaction): Promise<void> {
    if ((await this.settings.find(tx, false)) === null) throw notSetUp();
  }

  // The collection's row, locked: its version is what the save compares
  private async find(tx: Transaction, id: string) {
    const [row] = await tx
      .select()
      .from(storefrontCollections)
      .where(
        and(eq(storefrontCollections.tenantId, getTenantId()), eq(storefrontCollections.id, id)),
      )
      .for('update');
    if (!row) throw notFound('Collection');
    return row;
  }

  private async itemIds(tx: Transaction, id: string): Promise<string[]> {
    const rows = await tx
      .select({ listingId: storefrontCollectionItems.listingId })
      .from(storefrontCollectionItems)
      .where(
        and(
          eq(storefrontCollectionItems.tenantId, getTenantId()),
          eq(storefrontCollectionItems.collectionId, id),
        ),
      )
      .orderBy(asc(storefrontCollectionItems.position));
    return rows.map((row) => row.listingId);
  }

  // Every id is a listing of this workspace. The FK would refuse another workspace's id too, but
  // as a 500 naming no box; this names the one to remove (listingIds.3)
  private async checkListings(tx: Transaction, ids: readonly string[]): Promise<void> {
    const found = await this.listings.summaries(tx, ids);
    const fieldErrors: Record<string, ErrorCode[]> = {};
    ids.forEach((listingId, index) => {
      if (!found.has(listingId))
        fieldErrors[`listingIds.${String(index)}`] = ['storefront_listing_invalid'];
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError(409, 'storefront_listing_invalid', 'A listing is not in the shop.', {
        fieldErrors,
      });
    }
  }

  // The listings in the form's order, as 1, 2, 3…, written again on every save (the order is the
  // list, so a diff of moves would be longer than the list). Delete and insert for the same reason
  // as the home blocks: (collection, position) is unique and not deferrable
  private async writeItems(tx: Transaction, id: string, listingIds: readonly string[]) {
    await tx
      .delete(storefrontCollectionItems)
      .where(
        and(
          eq(storefrontCollectionItems.tenantId, getTenantId()),
          eq(storefrontCollectionItems.collectionId, id),
        ),
      );
    await tx.insert(storefrontCollectionItems).values(
      listingIds.map((listingId, index) => ({
        tenantId: getTenantId(),
        collectionId: id,
        listingId,
        position: index + 1,
      })),
    );
  }

  // The collection's page: its counts and its listings in their order
  private async load(tx: Transaction, id: string): Promise<StorefrontCollection> {
    const [row] = z
      .array(summaryRowSchema)
      .parse(await tx.execute(summarySql(sql`c.id = ${id}::uuid`)));
    if (!row) throw notFound('Collection');
    const ids = await this.itemIds(tx, id);
    const listings = await this.listings.summaries(tx, ids);
    return {
      ...toSummary(row),
      listings: ids.flatMap((listingId) => {
        const listing = listings.get(listingId);
        return listing === undefined ? [] : [listing];
      }),
    };
  }
}

function toSummary(row: z.infer<typeof summaryRowSchema>): StorefrontCollectionSummary {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    listingCount: row.listing_count,
    publishedCount: row.published_count,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
```

Why it is written this way:

- **The counts come from one SQL query** with `LEFT JOIN`s and `count(...) FILTER (WHERE ...)`. `LEFT`, because a
  collection is still a collection while all its listings are drafts. `count(i.listing_id)` counts the items, not
  the joined rows, so a collection with no items says 0 (not 1). `::int`, because Postgres's `count` is a `bigint`,
  which postgres.js sends as a string; `z.number()` would refuse it. `GROUP BY c.id` is enough for the other
  columns of `c`, because `id` is the primary key.
- **`updated_at` goes through `isoText`**, the same function the catalog uses, so the time has microseconds and
  passes `z.iso.datetime()`.
- **`create` takes the home lock before anything else**, then checks the shop, the 8 collections, the 12 blocks and
  the listings, and only then inserts. Each refusal leaves nothing behind.
- **The title is stored in NFC**, like every name the shop shows (26f, decision 34).
- **`update` takes no home lock.** It does not add or remove a block. It locks the collection's own row
  (`FOR UPDATE` in `find`), so two saves of one collection wait for each other and the second meets a version
  conflict.
- **The version goes up when only the listings change.** The listings are part of the collection; a second tab with
  the collection open must learn that its list is old.
- **`writeItems` deletes the rows and inserts them again** in the form's order. A save is the whole list (at most
  24), and the unique `(collection, position)` index is not deferrable, so moving rows one by one would collide.
- **`checkListings` names the box** (`listingIds.3`). The FK would refuse another workspace's listing too, but as a
  500 that names nothing. A draft or an archived product's listing is allowed: the shop leaves it out until it can
  be shown (26f's `shown` view), and the screen says "3 of 5 in the shop now".
- **`listingGone` maps the FK error** for the race the check cannot see: a listing deleted in another tab between
  the check and the insert. It has no box, because which listing went is not known at that point.
- **`remove` renumbers the blocks** after the delete (decision 23). The listings stay: only the collection's rows
  go, by the FK's cascade.
- **The audit snapshot keeps the listing ids in order**, so a reorder shows in the log as a change.

### Logo, colors, hero and banners: `appearance.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontBannerInput,
  type ErrorCode,
  type MoveStorefrontHomeBlockInput,
  type SaveStorefrontHeroInput,
  STOREFRONT_BANNERS_MAX,
  type StorefrontAppearance,
  type StorefrontBanner,
  type StorefrontHero,
  type StorefrontHomeBlock,
  type StorefrontImage,
  storefrontImageSchema,
  type StorefrontTheme,
  type UpdateStorefrontBannerInput,
  type UpdateStorefrontThemeInput,
} from '@omnivo/contracts';
import { storefrontBanners, storefrontSettings } from '@omnivo/db';
import { and, count, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopImage } from '../media.js';
import { shopUrl } from '../shop-url.js';
import { StorefrontCollectionsService } from './collections.service.js';
import {
  appendHomeBlock,
  checkHomeRoom,
  full,
  homeBlockRefs,
  homeBlocksOf,
  lockHome,
  writeHomeBlocks,
} from './home-blocks.js';
import { StorefrontImagesService } from './images.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

type BannerRow = typeof storefrontBanners.$inferSelect;
type SettingsRow = typeof storefrontSettings.$inferSelect;

// A picture that is not ready (or not this workspace's), on its own box. One error per picture
function imagesNotReady(fields: readonly string[]): AppError {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const field of fields) fieldErrors[field] = ['storefront_image_not_ready'];
  return new AppError(409, 'storefront_image_not_ready', 'A picture is not ready yet.', {
    fieldErrors,
  });
}

// The audit's view of a banner: its link and its pictures (the id and the alt text, so a new
// picture and a corrected alt both show). The hero adds its words and colors
function bannerSnapshot(row: BannerRow) {
  return {
    kind: row.kind,
    href: row.href,
    desktopImage: row.desktopImage.id,
    desktopAlt: row.desktopImage.alt,
    phoneImage: row.phoneImage.id,
    phoneAlt: row.phoneImage.alt,
    headline: row.headline,
    line: row.line,
    eyebrow: row.eyebrow,
    buttonLabel: row.buttonLabel,
    backgroundColor: row.backgroundColor,
    panelColor: row.panelColor,
    buttonColor: row.buttonColor,
    buttonTextColor: row.buttonTextColor,
  };
}

// Step 26h: the Appearance page (decision 2). The logo and the two colors live on the settings
// row; the hero and the picture banners are rows of storefront_banners (kind hero / image); the
// collections have their own service. The home page's order is shared (home-blocks.ts).
@Injectable()
export class StorefrontAppearanceService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
    private readonly images: StorefrontImagesService,
    private readonly collections: StorefrontCollectionsService,
  ) {}

  get(): Promise<StorefrontAppearance> {
    return this.withTenant(async (tx) => {
      const shop = await this.requireShop(tx);
      const [hero] = await tx
        .select()
        .from(storefrontBanners)
        .where(
          and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'hero')),
        );
      return {
        shopUrl: shopUrl(this.config.storefront, shop.subdomain),
        theme: this.toTheme(shop),
        hero: hero === undefined ? null : this.toHero(hero),
        blocks: await this.blocks(tx),
      };
    });
  }

  async updateTheme(input: UpdateStorefrontThemeInput): Promise<StorefrontTheme> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.settings.find(tx, true);
        if (before === null) throw notSetUp();
        if (before.version !== input.version) throw versionConflict();
        // Only a new logo is asked: the saved one was ready when it was saved, and its files never
        // change
        if (input.logoImageId !== null && input.logoImageId !== before.logoImageId) {
          const ready = await this.images.readyIds(tx, [input.logoImageId]);
          if (!ready.has(input.logoImageId)) throw imagesNotReady(['logoImageId']);
        }
        const [after] = await tx
          .update(storefrontSettings)
          .set({
            logoImageId: input.logoImageId,
            brandColor: input.brandColor,
            accentColor: input.accentColor,
            // The settings row's one version (decision 12): Shop settings and this card cannot
            // overwrite each other unseen
            version: sql`${storefrontSettings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(eq(storefrontSettings.tenantId, getTenantId()))
          .returning();
        if (!after) throw notSetUp();
        const view = (row: SettingsRow) => ({
          logoImageId: row.logoImageId,
          brandColor: row.brandColor,
          accentColor: row.accentColor,
        });
        await audit(tx, {
          action: 'storefront.theme_updated',
          entityType: 'storefront',
          entityId: after.tenantId,
          changes: diff(view(before), view(after)),
        });
        return this.toTheme(after);
      });
    } catch (error) {
      // The FK (26h.2) behind the check above: a photo of another workspace never gets this far,
      // so this is a race with nothing today (photos are never deleted yet). Said on the box anyway
      if (isForeignKeyViolation(error, 'storefront_settings_logo_fk')) {
        throw imagesNotReady(['logoImageId']);
      }
      throw error;
    }
  }

  // version null makes the hero, a number changes it (decision 13)
  async saveHero(input: SaveStorefrontHeroInput): Promise<StorefrontHero> {
    try {
      return await this.withTenant(async (tx) => {
        await this.requireShop(tx);
        const before = await this.findHero(tx);
        // No hero and a version: another tab deleted it. A hero and no version: another tab made
        // one. Either way this form shows something that is not there any more
        if ((before === null) !== (input.version === null)) throw versionConflict();
        if (before !== null && before.version !== input.version) throw versionConflict();
        await this.checkImages(tx, input, before);
        const columns = {
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
          updatedBy: currentPrincipal().userId,
        };
        const [after] =
          before === null
            ? await tx
                .insert(storefrontBanners)
                .values({ tenantId: getTenantId(), kind: 'hero', ...columns })
                .returning()
            : await tx
                .update(storefrontBanners)
                .set({ ...columns, version: sql`${storefrontBanners.version} + 1` })
                .where(
                  and(
                    eq(storefrontBanners.tenantId, getTenantId()),
                    eq(storefrontBanners.id, before.id),
                  ),
                )
                .returning();
        if (!after) throw new Error('Hero save returned no row');
        await audit(tx, {
          action: before === null ? 'storefront_banner.created' : 'storefront_banner.updated',
          entityType: 'storefront_banner',
          entityId: after.id,
          changes:
            before === null
              ? created(bannerSnapshot(after))
              : diff(bannerSnapshot(before), bannerSnapshot(after)),
        });
        return this.toHero(after);
      });
    } catch (error) {
      // Two first saves at once: both saw no hero, and the one-hero index stopped the second
      if (isUniqueViolation(error, 'storefront_banners_hero_idx')) throw versionConflict();
      throw error;
    }
  }

  deleteHero(version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.findHero(tx);
      if (before === null) throw notFound('Hero');
      if (before.version !== version) throw versionConflict();
      await this.deleteBannerRow(tx, before);
    });
  }

  createBanner(input: CreateStorefrontBannerInput): Promise<StorefrontBanner> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      await this.requireShop(tx);
      const [counted] = await tx
        .select({ total: count() })
        .from(storefrontBanners)
        .where(
          and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'image')),
        );
      if ((counted?.total ?? 0) >= STOREFRONT_BANNERS_MAX) {
        throw full('storefront_banners_full', 'The shop has 6 picture banners. Remove one first.');
      }
      await checkHomeRoom(tx);
      await this.checkImages(tx, input, null);
      const [row] = await tx
        .insert(storefrontBanners)
        .values({
          tenantId: getTenantId(),
          kind: 'image',
          href: input.href,
          desktopImage: input.desktopImage,
          phoneImage: input.phoneImage,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Banner insert returned no row');
      await appendHomeBlock(tx, { bannerId: row.id, collectionId: null });
      await audit(tx, {
        action: 'storefront_banner.created',
        entityType: 'storefront_banner',
        entityId: row.id,
        changes: created(bannerSnapshot(row)),
      });
      return this.toBanner(row);
    });
  }

  updateBanner(id: string, input: UpdateStorefrontBannerInput): Promise<StorefrontBanner> {
    return this.withTenant(async (tx) => {
      const before = await this.findBanner(tx, id);
      if (before.version !== input.version) throw versionConflict();
      await this.checkImages(tx, input, before);
      const [after] = await tx
        .update(storefrontBanners)
        .set({
          href: input.href,
          desktopImage: input.desktopImage,
          phoneImage: input.phoneImage,
          version: sql`${storefrontBanners.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.id, id)))
        .returning();
      if (!after) throw notFound('Banner');
      await audit(tx, {
        action: 'storefront_banner.updated',
        entityType: 'storefront_banner',
        entityId: id,
        changes: diff(bannerSnapshot(before), bannerSnapshot(after)),
      });
      return this.toBanner(after);
    });
  }

  deleteBanner(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const before = await this.findBanner(tx, id);
      if (before.version !== version) throw versionConflict();
      await this.deleteBannerRow(tx, before);
      // Its block went with it (the FK cascades); the gap closes, as after a collection's delete
      await writeHomeBlocks(tx, await homeBlockRefs(tx));
    });
  }

  // Decision 14: a swap with the block above or below, answered with the whole page
  moveBlock(input: MoveStorefrontHomeBlockInput): Promise<{ blocks: StorefrontHomeBlock[] }> {
    return this.withTenant(async (tx) => {
      await lockHome(tx);
      const refs = await homeBlockRefs(tx);
      const from = refs.findIndex((ref) =>
        input.kind === 'banner' ? ref.bannerId === input.id : ref.collectionId === input.id,
      );
      const block = refs[from];
      if (block === undefined) throw notFound(input.kind === 'banner' ? 'Banner' : 'Collection');
      const to = input.direction === 'up' ? from - 1 : from + 1;
      const neighbour = refs[to];
      // Already first or last: the button is disabled there, and a second click is a no-op
      if (neighbour === undefined) return { blocks: await this.blocks(tx) };
      const order = [...refs];
      order[from] = neighbour;
      order[to] = block;
      await writeHomeBlocks(tx, order);
      // The block's own entity, so the log's link opens what moved; the page's order is the shop's
      await audit(tx, {
        action: 'storefront.home_moved',
        entityType: input.kind === 'banner' ? 'storefront_banner' : 'storefront_collection',
        entityId: input.id,
        changes: diff({ position: from + 1 }, { position: to + 1 }),
      });
      return { blocks: await this.blocks(tx) };
    });
  }

  private async requireShop(tx: Transaction): Promise<SettingsRow> {
    const shop = await this.settings.find(tx, false);
    if (shop === null) throw notSetUp();
    return shop;
  }

  private async findHero(tx: Transaction): Promise<BannerRow | null> {
    const [row] = await tx
      .select()
      .from(storefrontBanners)
      .where(and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'hero')))
      .for('update');
    return row ?? null;
  }

  // A picture banner. The hero has its own routes: through these it is "not found"
  private async findBanner(tx: Transaction, id: string): Promise<BannerRow> {
    const [row] = await tx
      .select()
      .from(storefrontBanners)
      .where(
        and(
          eq(storefrontBanners.tenantId, getTenantId()),
          eq(storefrontBanners.id, id),
          eq(storefrontBanners.kind, 'image'),
        ),
      )
      .for('update');
    if (!row) throw notFound('Banner');
    return row;
  }

  private async deleteBannerRow(tx: Transaction, before: BannerRow): Promise<void> {
    await tx
      .delete(storefrontBanners)
      .where(
        and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.id, before.id)),
      );
    const snapshot = bannerSnapshot(before);
    await audit(tx, {
      action: 'storefront_banner.deleted',
      entityType: 'storefront_banner',
      entityId: before.id,
      // Every field to null, the kind too ("kind: hero → none"), so a deleted hero reads as the hero
      changes: diff(snapshot, Object.fromEntries(Object.keys(snapshot).map((key) => [key, null]))),
    });
  }

  // Both pictures are this workspace's and ready. A picture the banner has already is not asked
  // again (the listings' rule, listings.service.ts checkImages)
  private async checkImages(
    tx: Transaction,
    input: { desktopImage: StorefrontImage; phoneImage: StorefrontImage },
    before: BannerRow | null,
  ): Promise<void> {
    const saved = new Set(before === null ? [] : [before.desktopImage.id, before.phoneImage.id]);
    const fields = [
      ['desktopImage', input.desktopImage.id],
      ['phoneImage', input.phoneImage.id],
    ] as const;
    const asked = fields.filter(([, id]) => !saved.has(id)).map(([, id]) => id);
    const ready = await this.images.readyIds(tx, asked);
    const missing = fields
      .filter(([, id]) => !saved.has(id) && !ready.has(id))
      .map(([field]) => field);
    if (missing.length > 0) throw imagesNotReady(missing);
  }

  // The page's blocks: the picture banners and the collections, in the page's order
  private async blocks(tx: Transaction): Promise<StorefrontHomeBlock[]> {
    const rows = await tx
      .select()
      .from(storefrontBanners)
      .where(
        and(eq(storefrontBanners.tenantId, getTenantId()), eq(storefrontBanners.kind, 'image')),
      );
    const banners = new Map(rows.map((row) => [row.id, this.toBanner(row)]));
    return homeBlocksOf(await homeBlockRefs(tx), banners, await this.collections.summaries(tx));
  }

  private toTheme(row: SettingsRow): StorefrontTheme {
    return {
      logo:
        row.logoImageId === null
          ? null
          : {
              id: row.logoImageId,
              url: shopImage(
                this.config.storefront.mediaUrl,
                { id: row.logoImageId, alt: row.name },
                'small',
              ).url,
            },
      brandColor: row.brandColor,
      accentColor: row.accentColor,
      name: row.name,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // The pictures are jsonb that the database checks only to be objects; their shape is checked
  // here, as the shop's side does (public-storefront.service.ts image())
  private picture(value: StorefrontImage) {
    return this.images.view(storefrontImageSchema.parse(value));
  }

  private toBanner(row: BannerRow): StorefrontBanner {
    return {
      id: row.id,
      href: row.href,
      desktopImage: this.picture(row.desktopImage),
      phoneImage: this.picture(row.phoneImage),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // A hero row has its words and colors (storefront_banners_hero_check); the guard tells
  // TypeScript, and a row that broke it would be a bug worth an error, not a hero shown half
  private toHero(row: BannerRow): StorefrontHero {
    const { headline, buttonLabel, backgroundColor, panelColor, buttonColor, buttonTextColor } =
      row;
    if (
      headline === null ||
      buttonLabel === null ||
      backgroundColor === null ||
      panelColor === null ||
      buttonColor === null ||
      buttonTextColor === null
    ) {
      throw new Error(`Hero ${row.id} is missing its words or colors`);
    }
    return {
      ...this.toBanner(row),
      headline,
      line: row.line,
      eyebrow: row.eyebrow,
      buttonLabel,
      backgroundColor,
      panelColor,
      buttonColor,
      buttonTextColor,
    };
  }
}
```

Why it is written this way:

- **The contrast checks are not here.** `updateStorefrontThemeInputSchema` and `saveStorefrontHeroInputSchema`
  refuse a pair below the minimum while the route parses the body (26h.1), with the error on the box. The server
  therefore refuses what the form refuses, with the same function (decision 3).
- **`updateTheme` locks the settings row and compares its version** (decision 12). The logo and the colors are
  columns of that row, so a save here and a save on Shop settings cannot overwrite each other unseen; the second one
  gets `version_conflict`.
- **Only a new logo is checked** with `readyIds` (26g): this workspace's photo, made by the job. The saved logo was
  ready when it was saved, and its files never change, so it is not asked again. The FK from 26h.2 stands behind
  the check; its error is mapped to the same field error, so even a race reads as words on the box.
- **`saveHero` decides create or change from two facts**: is there a hero, and did the form send a version
  (decision 13). If they disagree, another tab made or deleted the hero since this form opened, and the answer is
  `version_conflict`. Two first saves at once both see "no hero"; the one-hero index stops the second, and that
  error becomes `version_conflict` too.
- **The hero is never a home block.** It has its own place at the top of the shop. `findBanner` filters on
  `kind = 'image'`, so the banner routes answer 404 for the hero's id, and only `createBanner` adds a block.
- **`createBanner` counts the picture banners under the home lock** (decision 22). The hero is not counted: the
  limit of 6 is for the blocks under the grid.
- **`checkImages` asks only for pictures the banner does not have yet**, like the listings (26g). Each picture that
  is not ready gets its own field error (`desktopImage`, `phoneImage`), so the dialog shows it under the right tile.
- **`deleteBanner` renumbers the blocks**; `deleteHero` does not, because the hero has no block.
- **`deleteBannerRow` logs every field as going to null**, the kind too. `diff()` only reports the keys of its second
  argument, so `{ kind: … }` alone would drop everything else. `Object.fromEntries` builds the nulls without a cast.
- **`moveBlock` finds the block by what it shows** (`kind` and `id`, decision 14), swaps it with its neighbour and
  writes the order again. At the top or the bottom it changes nothing and answers the page, like the categories'
  move: the button is disabled there, and a second click is not an error. The log line is on the block (decision 25).
- **The pictures are parsed with `storefrontImageSchema`** when they are read. The database checks only that each is
  a JSON object; a broken one is an error here, not a tile with no address.
- **`toHero` throws on a hero row without its words or colors.** The table's check makes that impossible. The guard
  tells TypeScript the columns are not null; a row that broke the check would be a bug that should be loud.

### The text pages: `pages.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type SaveStorefrontPageInput,
  SHOP_TEXT_PAGES,
  type ShopTextPageSlug,
  type StorefrontPage,
  type StorefrontPageSummary,
  type StorefrontSection,
} from '@omnivo/contracts';
import { storefrontPages } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { audit } from '../../common/audit/audit.js';
import { notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopUrl } from '../shop-url.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

type PageRow = typeof storefrontPages.$inferSelect;

// A page in the audit log: its headings, "Delivery, Returns, Payment". The sections' text can be
// long, so the log names what the page holds, not every word of it
function headings(sections: readonly StorefrontSection[] | undefined): string | null {
  return sections === undefined ? null : sections.map((section) => section.heading).join(', ');
}

// Step 26h: the footer's four text pages (decision 5). A page is a row from its first save until
// Delete; without a row the shop answers "page not found" for it and the footer leaves its link
// out (publicShopSchema.pages). A page has no id: its slug, one of the four, is its key.
@Injectable()
export class StorefrontPagesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
  ) {}

  // Always the four, in the footer's order, written or not
  list(): Promise<{ items: StorefrontPageSummary[] }> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      const rows = await tx
        .select()
        .from(storefrontPages)
        .where(eq(storefrontPages.tenantId, getTenantId()));
      const bySlug = new Map(rows.map((row) => [row.slug, row]));
      return {
        items: SHOP_TEXT_PAGES.map((slug) => {
          const { sections, ...page } = this.toPage(subdomain, slug, bySlug.get(slug));
          return { ...page, sectionCount: sections.length };
        }),
      };
    });
  }

  get(slug: ShopTextPageSlug): Promise<StorefrontPage> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      return this.toPage(subdomain, slug, await this.find(tx, slug));
    });
  }

  save(slug: ShopTextPageSlug, input: SaveStorefrontPageInput): Promise<StorefrontPage> {
    return this.withTenant(async (tx) => {
      const subdomain = await this.subdomain(tx);
      const before = await this.find(tx, slug);
      // As the hero (decision 13): version null is "not written yet". A row and no version, or a
      // version and no row: another tab wrote or deleted the page since this form opened
      if ((before === undefined) !== (input.version === null)) throw versionConflict();
      if (before !== undefined && before.version !== input.version) throw versionConflict();
      const [after] =
        before === undefined
          ? await tx
              .insert(storefrontPages)
              .values({
                tenantId: getTenantId(),
                slug,
                sections: input.sections,
                updatedBy: currentPrincipal().userId,
              })
              // Two first saves at once: the second finds the first's row. Not an upsert, for the
              // settings' reason: it would overwrite the other tab's page without its version
              .onConflictDoNothing({ target: [storefrontPages.tenantId, storefrontPages.slug] })
              .returning()
          : await tx
              .update(storefrontPages)
              .set({
                sections: input.sections,
                version: sql`${storefrontPages.version} + 1`,
                updatedBy: currentPrincipal().userId,
              })
              .where(
                and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)),
              )
              .returning();
      if (!after) throw versionConflict();
      await audit(tx, {
        action: 'storefront.page_saved',
        entityType: 'storefront',
        entityId: getTenantId(),
        // Keyed by the slug, so the log says which page: "terms: Delivery → Delivery, Returns".
        // Built by hand, not with diff(): a save that changed only the text keeps the same
        // headings, and diff() would leave the page out of its own entry
        changes: { [slug]: { from: headings(before?.sections), to: headings(after.sections) } },
      });
      return this.toPage(subdomain, slug, after);
    });
  }

  remove(slug: ShopTextPageSlug, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, slug);
      if (before === undefined) throw notFound('Page');
      if (before.version !== version) throw versionConflict();
      await tx
        .delete(storefrontPages)
        .where(and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)));
      await audit(tx, {
        action: 'storefront.page_deleted',
        entityType: 'storefront',
        entityId: getTenantId(),
        changes: { [slug]: { from: headings(before.sections), to: null } },
      });
    });
  }

  // The shop's subdomain, for the pages' addresses. A shop not set up has no address yet, and its
  // screens show "Set up the shop first" (the catalog's rule)
  private async subdomain(tx: Transaction): Promise<string> {
    const shop = await this.settings.find(tx, false);
    if (shop === null) throw notSetUp();
    return shop.subdomain;
  }

  private async find(tx: Transaction, slug: ShopTextPageSlug): Promise<PageRow | undefined> {
    const [row] = await tx
      .select()
      .from(storefrontPages)
      .where(and(eq(storefrontPages.tenantId, getTenantId()), eq(storefrontPages.slug, slug)))
      .for('update');
    return row;
  }

  private toPage(
    subdomain: string,
    slug: ShopTextPageSlug,
    row: PageRow | undefined,
  ): StorefrontPage {
    return {
      slug,
      sections: row?.sections ?? [],
      shopUrl: shopUrl(this.config.storefront, subdomain, `/pages/${slug}`),
      version: row?.version ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }
}
```

Why it is written this way:

- **`list` always answers the four pages**, in the footer's order (`SHOP_TEXT_PAGES`), written or not. A page not
  written has no row; it answers no sections and no version, which is what the editor's first save sends back
  (`version: null`).
- **`save` follows the hero's rule** (decision 13): a version without a row, or a row without a version, means
  another tab changed the page. The insert uses `onConflictDoNothing` on the key, not an upsert: an upsert would
  overwrite the other tab's first save without looking at its version. No row back means that happened, and the
  answer is `version_conflict`.
- **`find` locks the row** (`FOR UPDATE`), so two saves of one page wait for each other. For a page with no row
  there is nothing to lock; the key decides, as above.
- **An empty page cannot be saved.** `saveStorefrontPageInputSchema` asks for at least one section
  (`storefront_page_empty`), and Delete is the way to take a page out of the shop. The table's check (1 to 12
  sections) stands behind it.
- **The log line is built by hand** (decision 26).
- **`shopUrl` is the page's own address** (`/pages/terms`), for "View page".

### The routes: `storefront-appearance.controller.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontAppearanceService } from './appearance.service.js';
import { StorefrontCollectionsService } from './collections.service.js';
import { StorefrontPagesService } from './pages.service.js';

type Routes = typeof routes.storefrontAppearance;

// Step 26h: Appearance and the text pages, 16 routes behind storefront.manage (the contract says
// so; the guard reads it). Its own controller, as the contract has its own group: 26g's
// controller stays as it was. Thin on purpose, like that one
@Controller()
export class StorefrontAppearanceController {
  constructor(
    private readonly appearance: StorefrontAppearanceService,
    private readonly collections: StorefrontCollectionsService,
    private readonly pages: StorefrontPagesService,
  ) {}

  @Endpoint(routes.storefrontAppearance.getAppearance)
  getAppearance(): Promise<RouteResponse<Routes['getAppearance']>> {
    return this.appearance.get();
  }

  @Endpoint(routes.storefrontAppearance.updateTheme)
  updateTheme({
    body,
  }: RouteInput<Routes['updateTheme']>): Promise<RouteResponse<Routes['updateTheme']>> {
    return this.appearance.updateTheme(body);
  }

  @Endpoint(routes.storefrontAppearance.saveHero)
  saveHero({ body }: RouteInput<Routes['saveHero']>): Promise<RouteResponse<Routes['saveHero']>> {
    return this.appearance.saveHero(body);
  }

  @Endpoint(routes.storefrontAppearance.deleteHero)
  deleteHero({ query }: RouteInput<Routes['deleteHero']>): Promise<void> {
    return this.appearance.deleteHero(query.version);
  }

  @Endpoint(routes.storefrontAppearance.createBanner)
  createBanner({
    body,
  }: RouteInput<Routes['createBanner']>): Promise<RouteResponse<Routes['createBanner']>> {
    return this.appearance.createBanner(body);
  }

  @Endpoint(routes.storefrontAppearance.updateBanner)
  updateBanner({
    params,
    body,
  }: RouteInput<Routes['updateBanner']>): Promise<RouteResponse<Routes['updateBanner']>> {
    return this.appearance.updateBanner(params.id, body);
  }

  @Endpoint(routes.storefrontAppearance.deleteBanner)
  deleteBanner({ params, query }: RouteInput<Routes['deleteBanner']>): Promise<void> {
    return this.appearance.deleteBanner(params.id, query.version);
  }

  @Endpoint(routes.storefrontAppearance.getCollection)
  getCollection({
    params,
  }: RouteInput<Routes['getCollection']>): Promise<RouteResponse<Routes['getCollection']>> {
    return this.collections.get(params.id);
  }

  @Endpoint(routes.storefrontAppearance.createCollection)
  createCollection({
    body,
  }: RouteInput<Routes['createCollection']>): Promise<RouteResponse<Routes['createCollection']>> {
    return this.collections.create(body);
  }

  @Endpoint(routes.storefrontAppearance.updateCollection)
  updateCollection({
    params,
    body,
  }: RouteInput<Routes['updateCollection']>): Promise<RouteResponse<Routes['updateCollection']>> {
    return this.collections.update(params.id, body);
  }

  @Endpoint(routes.storefrontAppearance.deleteCollection)
  deleteCollection({ params, query }: RouteInput<Routes['deleteCollection']>): Promise<void> {
    return this.collections.remove(params.id, query.version);
  }

  @Endpoint(routes.storefrontAppearance.moveHomeBlock)
  moveHomeBlock({
    body,
  }: RouteInput<Routes['moveHomeBlock']>): Promise<RouteResponse<Routes['moveHomeBlock']>> {
    return this.appearance.moveBlock(body);
  }

  @Endpoint(routes.storefrontAppearance.listPages)
  listPages(): Promise<RouteResponse<Routes['listPages']>> {
    return this.pages.list();
  }

  @Endpoint(routes.storefrontAppearance.getPage)
  getPage({ params }: RouteInput<Routes['getPage']>): Promise<RouteResponse<Routes['getPage']>> {
    return this.pages.get(params.slug);
  }

  @Endpoint(routes.storefrontAppearance.savePage)
  savePage({
    params,
    body,
  }: RouteInput<Routes['savePage']>): Promise<RouteResponse<Routes['savePage']>> {
    return this.pages.save(params.slug, body);
  }

  @Endpoint(routes.storefrontAppearance.deletePage)
  deletePage({ params, query }: RouteInput<Routes['deletePage']>): Promise<void> {
    return this.pages.remove(params.slug, query.version);
  }
}
```

Each route hands its parsed input to a service. The permission (`storefront.manage`) is in the contract, and the
guard reads it there, so the controller has no decorator for it. The delete routes return `Promise<void>`: the
contract's status is 204, and `Endpoint` sends no body for it.

### The module: `storefront.module.ts`

```diff
@@ -1,11 +1,15 @@
 import { Module } from '@nestjs/common';
 
 import { AttachmentsModule } from '../attachments/attachments.module.js';
+import { StorefrontAppearanceService } from './admin/appearance.service.js';
 import { StorefrontCategoriesService } from './admin/categories.service.js';
+import { StorefrontCollectionsService } from './admin/collections.service.js';
 import { StorefrontImagesService } from './admin/images.service.js';
 import { StorefrontListingsService } from './admin/listings.service.js';
+import { StorefrontPagesService } from './admin/pages.service.js';
 import { StorefrontSettingsService } from './admin/settings.service.js';
 import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
+import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
 import { ShopDb } from './shop-db.js';
@@ -13,10 +17,15 @@ import { ShopDb } from './shop-db.js';
 // Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
 // ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
 // tables and the photo addresses (media.ts), never a service: the public half runs as
-// omnivo_public in a read-only transaction, the admin half as the signed-in member
+// omnivo_public in a read-only transaction, the admin half as the signed-in member. Step 26h adds
+// Appearance and the text pages, with their own controller (the contract's own group)
 @Module({
   imports: [AttachmentsModule],
-  controllers: [PublicStorefrontController, StorefrontAdminController],
+  controllers: [
+    PublicStorefrontController,
+    StorefrontAdminController,
+    StorefrontAppearanceController,
+  ],
   providers: [
     ShopDb,
     PublicStorefrontService,
@@ -24,6 +33,9 @@ import { ShopDb } from './shop-db.js';
     StorefrontCategoriesService,
     StorefrontImagesService,
     StorefrontListingsService,
+    StorefrontCollectionsService,
+    StorefrontAppearanceService,
+    StorefrontPagesService,
   ],
 })
 export class StorefrontModule {}
```

The three services join the module's providers, and the controller its controllers. `StorefrontCollectionsService`
is listed before `StorefrontAppearanceService` only for reading order; Nest resolves the order itself.

### The reserved slug, said on the box: `categories.service.ts`

```diff
@@ -8,7 +8,11 @@ import { storefrontCategories, storefrontListings } from '@omnivo/db';
 import { and, asc, count, eq, isNull, max, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../../common/audit/audit.js';
-import { isForeignKeyViolation, isUniqueViolation } from '../../common/db/pg-errors.js';
+import {
+  isCheckViolation,
+  isForeignKeyViolation,
+  isUniqueViolation,
+} from '../../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
 import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
@@ -47,10 +51,17 @@ function parentInvalid(): AppError {
   });
 }
 
-// The two unique indexes, by the box each belongs to
+// The two unique indexes, by the box each belongs to. Step 26h: and the slug the shop keeps for
+// itself. The contract refuses "all" before it gets here (storefront-admin.ts); the check
+// (26h.2) is for a request that went around it, and it says so on the box, not as a 500
 function uniqueError(error: unknown): AppError | null {
   if (isUniqueViolation(error, 'storefront_categories_slug_idx')) return slugTaken();
   if (isUniqueViolation(error, 'storefront_categories_sibling_name_idx')) return nameTaken();
+  if (isCheckViolation(error, 'storefront_categories_slug_reserved_check')) {
+    return new AppError(409, 'storefront_slug_reserved', 'The shop keeps this link for itself.', {
+      fieldErrors: { slug: ['storefront_slug_reserved'] },
+    });
+  }
   return null;
 }
 
```

The contract refuses the slug `all` (26h.1), so this check runs only for a request that went around the contract.
Without the mapping, that request would end in a 500; with it, it gets `storefront_slug_reserved` on the slug box,
like `storefront_slug_taken`. `isCheckViolation` matches the constraint by name, so no other check is caught by
mistake.

### The shop's pages: `public-storefront.service.ts`

```diff
@@ -5,6 +5,7 @@ import {
   renderSections,
   sectionsSummary,
   SHOP_GALLERY_MAX,
+  SHOP_TEXT_PAGES,
   shopDeliveryZoneSchema,
   type PublicListingParams,
   type PublicShop,
@@ -81,6 +82,12 @@ export class PublicStorefrontService {
         .select({ timezone: tenantSettings.timezone })
         .from(tenantSettings)
         .where(eq(tenantSettings.tenantId, shop.tenantId));
+      // Step 26h: the pages the tenant has written, so the footer links only those
+      const written = await tx
+        .select({ slug: storefrontPages.slug })
+        .from(storefrontPages)
+        .where(eq(storefrontPages.tenantId, shop.tenantId));
+      const slugs = new Set(written.map((page) => page.slug));
       return {
         name: settings.name,
         // The logo's alt text is the shop's name: it is what the logo says
@@ -100,6 +107,8 @@ export class PublicStorefrontService {
           x: settings.xUrl,
           linkedin: settings.linkedinUrl,
         },
+        // In the footer's order (SHOP_TEXT_PAGES), not the table's: rows come back in any order
+        pages: SHOP_TEXT_PAGES.filter((slug) => slugs.has(slug)),
       };
     });
   }
```

`publicShopSchema` has `pages` since 26h.1 (decision 5). The slugs are read with the shop's own read
(`omnivo_public` already reads `storefront_pages` for the text page itself, 26f). They are then put in the footer's
order by filtering `SHOP_TEXT_PAGES`, because the rows come back in no particular order and the footer must always
read Privacy, Terms, About, Contact.

### The shop: `shop.ts` and `Footer.astro`

```diff
@@ -1,4 +1,4 @@
-import type { PublicShop, ShopCategory } from '@omnivo/contracts';
+import { type PublicShop, SHOP_TEXT_PAGES, type ShopCategory } from '@omnivo/contracts';
 
 // Step 26a: a made-up shop with the words and colors of the Figma design. Its name is the tenant's
 // shop name; the Figma file shows "Omnivo" there, so the mock uses it too.
@@ -16,6 +16,8 @@ export const mockShop = {
     x: 'https://x.com/',
     linkedin: 'https://linkedin.com/',
   },
+  // Step 26h: the mock has written all four (pages.ts; tracking.spec.ts checks each is there)
+  pages: [...SHOP_TEXT_PAGES],
 } satisfies PublicShop;
 
 export const mockCategories = [
```

The mock shop has written all four pages (`pages.ts`), so it lists all four. `[...SHOP_TEXT_PAGES]` makes a plain
array of the four slugs; `satisfies PublicShop` checks that it is the type the API sends.

```diff
@@ -6,7 +6,7 @@ import {
   NewTwitterIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import type { PublicShop } from '@omnivo/contracts';
+import type { PublicShop, ShopTextPageSlug } from '@omnivo/contracts';
 
 import type { ShopLocale } from '../lib/locale';
 import Logo from './Logo.astro';
@@ -31,13 +31,15 @@ const social = [
   { url: shop.social.linkedin, icon: Linkedin01Icon, label: t('shop.footer.linkedin') },
 ].flatMap((network) => (network.url === null ? [] : [{ ...network, url: network.url }]));
 
-// Step 26e builds these pages (pages/pages/[slug].astro)
-const pages = [
-  { href: '/pages/privacy', label: t('shop.footer.privacy') },
-  { href: '/pages/terms', label: t('shop.footer.terms') },
-  { href: '/pages/about', label: t('shop.footer.about') },
-  { href: '/pages/contact', label: t('shop.footer.contact') },
-];
+// Step 26e builds these pages (pages/pages/[slug].astro). Step 26h: only the ones the tenant has
+// written (shop.pages, already in this order), so a footer link never opens "page not found"
+const pageLabels = {
+  privacy: t('shop.footer.privacy'),
+  terms: t('shop.footer.terms'),
+  about: t('shop.footer.about'),
+  contact: t('shop.footer.contact'),
+} satisfies Record<ShopTextPageSlug, string>;
+const pages = shop.pages.map((slug) => ({ href: `/pages/${slug}`, label: pageLabels[slug] }));
 
 const copyright = t('shop.footer.copyright', { year, shop: shop.name });
 ---
@@ -94,23 +96,26 @@ const copyright = t('shop.footer.copyright', { year, shop: shop.name });
             </ul>
           )}
         </div>
-        <nav aria-label={t('shop.footer.pages')}>
-          {/* A paragraph of links, not a flex list: text-box trim works on a block of text only */}
-          <p class="text-center text-sf-small text-brand md:trim-text md:text-sf-body md:leading-6">
-            {pages.map((page, index) => (
-              <>
-                {index > 0 && (
-                  <span aria-hidden="true" class="px-1 text-muted md:px-2">
-                    |
-                  </span>
-                )}
-                <a href={page.href} class="underline-offset-3 hover:underline">
-                  {page.label}
-                </a>
-              </>
-            ))}
-          </p>
-        </nav>
+        {/* No nav at all while no page is written: an empty landmark is a dead stop for a screen reader */}
+        {pages.length > 0 && (
+          <nav aria-label={t('shop.footer.pages')}>
+            {/* A paragraph of links, not a flex list: text-box trim works on a block of text only */}
+            <p class="text-center text-sf-small text-brand md:trim-text md:text-sf-body md:leading-6">
+              {pages.map((page, index) => (
+                <>
+                  {index > 0 && (
+                    <span aria-hidden="true" class="px-1 text-muted md:px-2">
+                      |
+                    </span>
+                  )}
+                  <a href={page.href} class="underline-offset-3 hover:underline">
+                    {page.label}
+                  </a>
+                </>
+              ))}
+            </p>
+          </nav>
+        )}
         <p class="text-sf-meta font-normal text-muted md:hidden">{copyright}</p>
       </div>
     </div>
```

- **The labels are a record keyed by the slug**, with `satisfies Record<ShopTextPageSlug, string>`. A fifth page
  added to `SHOP_TEXT_PAGES` without a label here does not compile.
- **The list comes from `shop.pages`**, which is already in the footer's order, so the footer does not sort.
- **With no page written, the whole `<nav>` goes.** An empty navigation landmark is still announced by a screen
  reader, and it leads nowhere.

### The OpenAPI file

```bash
pnpm gen:openapi
```

This writes `packages/contracts/openapi.json` again with the 16 routes. It is generated, so the guide does not show
it; `pnpm test:openapi` fails when the file and the contracts differ.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test          # the unit tests, contract.spec.ts included
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/api/src/storefront apps/shop/src
pnpm exec prettier --check apps/api/src/storefront apps/shop/src
pnpm test:openapi
```

All of these pass. `apps/api`'s unit tests: 183, `contract.spec.ts` included (every route of the contract has its
controller). `apps/shop`'s: 223. The services meet a real database in 26h.4's integration and tenant-leak tests.

## 26h.4 — The API's tests

This part tests 26h.3 against a real Postgres, Redis and MinIO, with the real worker making the photos. It adds
no feature and changes no API code: every test passed against 26h.3 as it is.

```
apps/api/src/storefront
  storefront-appearance.int.spec.ts          Appearance and the pages, from an empty shop to a full home page (new)
  storefront-admin.tenant-leak.int.spec.ts   26g's two workspaces: none of their look or pages reaches the other
  public-storefront.int.spec.ts              the shop's `pages` (one line)
  storefront.tenant-leak.int.spec.ts         each shop's `pages` lists its own pages only (two lines)
```

Decisions for this part:

28. **One new integration file that builds one shop in order**, like 26g's (its decision 31): set up, three
    listings, the launch, then the colors, the hero, the blocks, the limits and the pages. Each change is then
    read back from the shop's public API (`/public/v1/shop`, `/home`, `/pages/terms`), because that is what a
    shopper sees. An answer from the admin API alone would not show that the shop reads the same rows.
29. **The leak tests go into 26g's leak file**, as a `describe` of their own with its own `beforeAll`. That file
    already has two workspaces with a shop, a ready photo and a listing each; a new file would start the same
    four containers again to make the same things. 26g's tests in it do not change.
30. **Each race is two requests at once** (`Promise.all`): two first saves of the hero, two of a page, and two
    "Add" clicks for the last place on the home page. The test does not ask which one wins. It asks for one
    success and one 409 with the right code, and then counts the rows in the table: a race that "passes" with two
    rows would be the bug itself.
31. **Decision 24 is said more exactly** (above): before the shop is set up, the reads and the adds answer
    `storefront_not_set_up`, and the six routes that change something by its id or slug answer 404.

### Appearance and the pages, start to finish: `storefront-appearance.int.spec.ts`

```ts
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
```

Three photos: `photo` and `wide` are ready (the image job made their files), and `pending` was described but its
file was never sent, so it stays "uploading". `pending` is how every "not ready" test works: a photo of this
workspace that exists but is not ready, which is a different case from `UNKNOWN` (no such photo). Both must be
refused the same way.

The three listings are made so that a collection can hold a draft: `rose` has no photo and stays a draft, `neem`
and `tea` are published. `SHOP_HOST` is the header the shop's server sends with every request to `/public/v1`
(26f), so the test reads the shop exactly as `apps/shop` does.

```ts
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
```

- **`refused()`** checks the status before it parses the answer, as in 26g: every error body parses as a problem,
  a 500 too.
- **`idsOf()`** turns the blocks into ids in the page's order. Most order tests compare these lists: a list of ids
  says the whole order in one line, and its failure message shows both orders.
- **`positions()`** reads the positions straight from the table, as the superuser. The answer of the API is built
  from the rows in their order, so it would look right even with a gap (1, 2, 4). Only the table shows the gap,
  and a gap is the bug that decision 23 prevents.
- **`heroForm()`** is typed as the form's input (`StorefrontHeroFormValues`): `line: ''` is what the browser sends
  for an empty box, and the answer must turn it into `null`. If the contract changes a box, this stops type-checking.
- **`listed()`** makes a product through the ERP's API, adds it to the shop, and, for a published one, saves a
  photo on it and publishes it: the three steps the Catalog screens take. The products have a sale price, so the
  listing has a price without one of its own.

```ts
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
```

The two ready photos are made at once (`Promise.all`); each takes a second or two in the worker. The unfinished
upload needs only the first step of `sendPhoto()`, so the test calls the route itself. Sumi is the member without
a role, as in 26g.

```ts
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
```

`everyRoute()` lists the 16 routes once, each with a body that passes the contract. The body matters: if a body
failed the contract, the answer would be 400 and the test would not reach what it means to check. The first test
also checks the list has 16 entries, so a route added to the contract later must be added here too.

**Who may change the look.** Every route as Sumi answers 403, even the ones with a body: the permission guard
runs before the body is read.

**Before the shop is set up.** The reads and the adds say `storefront_not_set_up`, which the screens turn into
"Set up the shop first". A collection's page (`GET` by id) and its form (`PUT` by id) ask for the shop before
they look for the collection; the six routes that change, move or delete answer 404, as decision 24 now says.
The filter that picks the six is checked with `toHaveLength(6)`, so a route that moves from one group to the
other cannot quietly drop out of both tests.

```ts
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
```

The `beforeAll` of this `describe` makes the shop the way Shop settings and the Catalog do, and launches it, so
every later test can read the shop's public API.

- **The first read** is the Figma colors, no logo, no hero and no blocks, with the settings row's version: the
  theme has no version of its own (decision 12).
- **Unreadable colors.** A light teal fails both checks at once, and the answer names both boxes: the brand on
  cream, and the accent next to the brand. `teal` is not a hex color, so it gets only the format error: a color that
  is not hex gives no contrast number, and no contrast error is added on top of the format one.
- **The logo** must be a ready photo of this workspace: `pending` (not ready) and `UNKNOWN` (no such photo) get
  the same error on the logo's box.
- **The save** sends upper-case colors; they come back in lower case. The logo's address is its small file. Then
  two stale saves: Shop settings with the version from before (it is the same row, so it must reload first), and
  the theme again with that version. The shop's public answer has the new colors, and the logo's alt text is the
  shop's name.
- **Back to the defaults**: `logoImageId: null` is the Omnivo mark, and the shop draws it.

```ts
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
```

**The hero.** The color test makes both mistakes in one request (a label in the button's own color, white words
on a white panel), so both boxes get their error. The links are the four kinds the contract refuses: a
`javascript:` address, a backslash that browsers read as `//`, an address of another site with no `https:`, and
`https://` with a host that has no dot (a typo).

The race test sends two first saves at once. Both find no hero, both insert; the database's one-hero index makes
the second wait for the first and then fail, and the service turns that into `version_conflict`. The test then
counts the hero rows: exactly one. A first save after that, from a form opened before the hero existed, is a
conflict too, not a second hero.

The change test checks the answer, then the shop: the hero is at the top of `/home` with its words and colors,
and it is not in `blocks` (the shop's decision 21 of 26f). The last line sends the hero's id to the picture
banners' route: 404, because those routes find only `kind = 'image'`. Without that filter, the banner form could
overwrite the hero's pictures and leave its words behind.

The delete test tries an old version first (409), then the right one. The home page then has no hero.

```ts
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
```

**The home page's blocks.** The tests share `sale` (the first banner) and `hot` (the first collection).

- **A refused collection** is checked three ways: empty and twice are the contract's (400), a listing it does not
  know is the API's (409, on the box of that listing). After the three, `positions()` is still `[1]`: a refused
  add left no block behind.
- **A new collection** holds a draft first, then two published listings. The answer keeps that order, and its
  counts are 3 listings, 2 in the shop (decision 27). The Appearance page's block is only the summary, with no
  listings in it.
- **The shop** shows the banner, then the collection with its two published cards in the collection's order; the
  draft waits.
- **The move test** adds a third block, moves it up (a swap with the one above), then clicks Move up on the first
  block: nothing changes, and the answer is still 200, because a second click on a button that just went disabled
  is not an error. A collection's id sent as a banner is 404: a move names its block by kind and id. The shop's
  order is the same.
- **The gap test** is the one that guards decision 23. It deletes the middle block, checks the table says
  `[1, 2]`, and adds a banner, which must go last at 3. Without the renumbering the table would hold 1 and 3, and
  the new block would be refused by the key at position 3. A banner's delete is checked the same way.
- **A banner's change** takes a new link and swaps the pictures; a picture that is not ready is refused on its box.

```ts
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
```

**The limits.** The page has one collection and one banner here. Five more banners make six, and the seventh is
refused with `storefront_banners_full`. Four more collections make 11 blocks; then two "Add" clicks at once
compete for the twelfth place. One wins, the other gets `storefront_home_full`, the table says 1 to 12, and there
are 6 collections: the loser left no collection without a block, because the count is checked under the lock
before anything is written (decision 22). Then three banners go, two collections fill 8, and the ninth gets
`storefront_collections_full` while the page still has room, so that error is checked on its own.

```ts
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
```

**The text pages.** The list is always the four, in the footer's order, with no version before the first save,
and each has its address in the shop. A slug that is not one of the four (`faq`) is refused by the contract. The
shop's `pages` is empty, so its footer has no links yet.

- **An empty page** is refused: a page with no section is what Delete is for.
- **The race** sends two first saves; one wins and the other gets `version_conflict` from the insert that found
  the first page's row (`onConflictDoNothing`). The page has version 1 and one section, the winner's.
- **The change** adds a section whose text has a `<script>`. The shop's page shows it as text (`&lt;script&gt;`)
  and `**2 days**` as bold: the shop builds the HTML with `renderSections`, which escapes first. Then About is
  written, and the shop lists `terms` then `about`, the footer's order, not the order they were written in.
- **The delete** needs the right version. Then the shop answers 404 for the page and drops its link, a second
  delete is 404, and writing the page again starts at version 1.

```ts
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
```

**The audit log.** The first test lists every action of 26h, with 26g's two that the setup made. The listing and
category actions are left out on purpose: 26g's tests check those. The second reads the `changes` of a few:

- the theme's line has the logo and the old and new brand color;
- the move is on the collection's own entity, "position: 3 → 2" (decision 25);
- each page save is keyed by its slug with its headings (decision 26). The race's winner is either tab, so the test
  reads the first line's headings and expects the next line to start from them;
- the hero's delete sets every field to null, its kind too, so the log says a hero went, not a banner.

### Another workspace's look and pages: `storefront-admin.tenant-leak.int.spec.ts`

```diff
@@ -3,6 +3,11 @@ import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
   problemSchema,
   setupSchema,
+  STOREFRONT_HERO_DEFAULT_COLORS,
+  storefrontAppearanceSchema,
+  storefrontBannerSchema,
+  storefrontCollectionSchema,
+  storefrontPageSchema,
   storefrontCandidatePageSchema,
   storefrontCategoryListSchema,
   storefrontCategorySchema,
@@ -391,3 +396,209 @@ describe('another workspace’s shop settings', () => {
     expect(res).toMatchObject({ status: 409, code: 'storefront_warehouse_invalid' });
   });
 });
+
+// Step 26h: the look and the pages. Acme has a hero, a picture banner, a collection of its own
+// listing and a Terms page; Nirvor a picture banner. Nirvor sends Acme's ids: a photo must not go
+// on its logo or banners, a listing not into its collections, and a banner, a collection, the hero
+// or a page must not be read, changed, moved or deleted. Pages have no id, so for them the
+// question is whether the slug reaches the other workspace's row.
+describe('another workspace’s look and pages', () => {
+  let theirBanner: string;
+  let theirCollection: string;
+  let ourBanner: string;
+
+  function heroForm(photoId: string, version: number | null) {
+    return {
+      version,
+      href: '/c/beverages',
+      headline: 'Fresh tea every morning',
+      line: '',
+      eyebrow: '',
+      buttonLabel: 'Shop now',
+      desktopImage: { id: photoId, alt: 'Green tea' },
+      phoneImage: { id: photoId, alt: 'Green tea' },
+      ...STOREFRONT_HERO_DEFAULT_COLORS,
+    };
+  }
+
+  function bannerForm(desktop: string, phone: string) {
+    return {
+      href: '/c/all',
+      desktopImage: { id: desktop, alt: 'Mega sale' },
+      phoneImage: { id: phone, alt: 'Mega sale' },
+    };
+  }
+
+  beforeAll(async () => {
+    let res = await send(
+      acme,
+      'PUT',
+      '/storefront/appearance/hero',
+      heroForm(theirs.photoId, null),
+    );
+    expect(res.statusCode, res.body).toBe(200);
+    res = await send(
+      acme,
+      'POST',
+      '/storefront/appearance/banners',
+      bannerForm(theirs.photoId, theirs.photoId),
+    );
+    expect(res.statusCode, res.body).toBe(201);
+    theirBanner = storefrontBannerSchema.parse(res.json()).id;
+    // A draft may wait in a collection: the shop shows it once it is published
+    res = await send(acme, 'POST', '/storefront/appearance/collections', {
+      title: 'Acme picks',
+      icon: null,
+      listingIds: [theirs.listing.id],
+    });
+    expect(res.statusCode, res.body).toBe(201);
+    theirCollection = storefrontCollectionSchema.parse(res.json()).id;
+    res = await send(acme, 'PUT', '/storefront/pages/terms', {
+      version: null,
+      sections: [{ heading: 'Acme terms', body: 'Wholesale only.' }],
+    });
+    expect(res.statusCode, res.body).toBe(200);
+    res = await send(
+      nirvor,
+      'POST',
+      '/storefront/appearance/banners',
+      bannerForm(ours.photoId, ours.photoId),
+    );
+    expect(res.statusCode, res.body).toBe(201);
+    ourBanner = storefrontBannerSchema.parse(res.json()).id;
+  }, 60_000);
+
+  it('cannot put their photo on our logo, hero or banner, though it is ready', async () => {
+    const theme = storefrontAppearanceSchema.parse(
+      (await send(nirvor, 'GET', '/storefront/appearance')).json(),
+    ).theme;
+    expect(
+      await answer('PUT', '/storefront/appearance/theme', {
+        version: theme.version,
+        logoImageId: theirs.photoId,
+        brandColor: theme.brandColor,
+        accentColor: theme.accentColor,
+      }),
+    ).toEqual({
+      status: 409,
+      code: 'storefront_image_not_ready',
+      fieldErrors: { logoImageId: ['storefront_image_not_ready'] },
+    });
+    expect(
+      await answer('PUT', '/storefront/appearance/hero', {
+        ...heroForm(ours.photoId, null),
+        desktopImage: { id: theirs.photoId, alt: 'Their tea' },
+      }),
+    ).toEqual({
+      status: 409,
+      code: 'storefront_image_not_ready',
+      fieldErrors: { desktopImage: ['storefront_image_not_ready'] },
+    });
+    expect(
+      await answer(
+        'POST',
+        '/storefront/appearance/banners',
+        bannerForm(ours.photoId, theirs.photoId),
+      ),
+    ).toEqual({
+      status: 409,
+      code: 'storefront_image_not_ready',
+      fieldErrors: { phoneImage: ['storefront_image_not_ready'] },
+    });
+  });
+
+  it('cannot put their listing in our collection', async () => {
+    expect(
+      await answer('POST', '/storefront/appearance/collections', {
+        title: 'Our picks',
+        icon: null,
+        listingIds: [ours.listing.id, theirs.listing.id],
+      }),
+    ).toEqual({
+      status: 409,
+      code: 'storefront_listing_invalid',
+      fieldErrors: { 'listingIds.1': ['storefront_listing_invalid'] },
+    });
+  });
+
+  it('finds their banner, collection and hero by no route', async () => {
+    for (const [method, url, payload] of [
+      [
+        'PUT',
+        `/storefront/appearance/banners/${theirBanner}`,
+        { ...bannerForm(ours.photoId, ours.photoId), version: 1 },
+      ],
+      ['DELETE', `/storefront/appearance/banners/${theirBanner}?version=1`, undefined],
+      ['GET', `/storefront/appearance/collections/${theirCollection}`, undefined],
+      [
+        'PUT',
+        `/storefront/appearance/collections/${theirCollection}`,
+        { title: 'Ours now', icon: null, listingIds: [ours.listing.id], version: 1 },
+      ],
+      ['DELETE', `/storefront/appearance/collections/${theirCollection}?version=1`, undefined],
+      [
+        'POST',
+        '/storefront/appearance/home/move',
+        { kind: 'banner', id: theirBanner, direction: 'down' },
+      ],
+      [
+        'POST',
+        '/storefront/appearance/home/move',
+        { kind: 'collection', id: theirCollection, direction: 'up' },
+      ],
+      // Nirvor has no hero; Acme's must not be the one found
+      ['DELETE', '/storefront/appearance/hero?version=1', undefined],
+    ] as const) {
+      expect(await answer(method, url, payload), `${method} ${url}`).toMatchObject({
+        status: 404,
+      });
+    }
+    const theirsNow = storefrontAppearanceSchema.parse(
+      (await send(acme, 'GET', '/storefront/appearance')).json(),
+    );
+    expect(theirsNow.hero?.version).toBe(1);
+    expect(
+      theirsNow.blocks.map((block) =>
+        block.kind === 'banner'
+          ? [block.banner.id, block.banner.version]
+          : [block.collection.id, block.collection.version],
+      ),
+    ).toEqual([
+      [theirBanner, 1],
+      [theirCollection, 1],
+    ]);
+  });
+
+  it('shows us only our own blocks, and no hero', async () => {
+    const page = storefrontAppearanceSchema.parse(
+      (await send(nirvor, 'GET', '/storefront/appearance')).json(),
+    );
+    expect(page.hero).toBeNull();
+    expect(
+      page.blocks.map((block) => (block.kind === 'banner' ? block.banner.id : block.collection.id)),
+    ).toEqual([ourBanner]);
+  });
+
+  it('keeps each workspace’s Terms page its own', async () => {
+    const ourTerms = storefrontPageSchema.parse(
+      (await send(nirvor, 'GET', '/storefront/pages/terms')).json(),
+    );
+    expect([ourTerms.version, ourTerms.sections]).toEqual([null, []]);
+    expect(await answer('DELETE', '/storefront/pages/terms?version=1')).toMatchObject({
+      status: 404,
+    });
+    // Our first save is a first save: their row does not make it a conflict
+    const res = await send(nirvor, 'PUT', '/storefront/pages/terms', {
+      version: null,
+      sections: [{ heading: 'Nirvor terms', body: 'Retail only.' }],
+    });
+    expect(res.statusCode, res.body).toBe(200);
+    const theirTerms = storefrontPageSchema.parse(
+      (await send(acme, 'GET', '/storefront/pages/terms')).json(),
+    );
+    expect(theirTerms).toMatchObject({
+      version: 1,
+      sections: [{ heading: 'Acme terms', body: 'Wholesale only.' }],
+    });
+  });
+});
```

The new `describe` starts from 26g's two workspaces (decision 29). Its `beforeAll` gives Acme a hero, a banner, a
collection of Acme's draft listing and a Terms page, and Nirvor one banner of its own.

- **Their photo is ready**, so "not ready" can only mean "not ours": on the logo, on the hero and on a banner, each
  error on its own box, exactly as for a photo that does not exist (26g's decision 33).
- **Their listing in our collection** is refused on its box (`listingIds.1`). Without the API's check the
  database's foreign key, which includes the workspace, would still refuse it, but as an error on no box.
- **By no route** checks every route that takes a banner's or a collection's id, and both kinds of move, with
  Acme's ids: all 404. `DELETE /storefront/appearance/hero` has no id; Nirvor has no hero, so it must answer 404
  and not find Acme's. Then Acme's page is read as Acme: its hero and both blocks still at version 1.
- **Our page** shows only our banner and no hero.
- **Terms** is the same slug in both workspaces. Nirvor's is not written (version null), deleting it is 404, and
  Nirvor's first save is a first save: Acme's row is not a conflict. Acme's page keeps its version and its words.

### The shop's `pages`: two public tests

```diff
@@ -219,6 +219,8 @@ describe('which shop', () => {
       timeZone: 'Asia/Dhaka',
       hotline: '09612-000000',
       logo: null,
+      // Step 26h: only the page it has written, so the footer never links to "page not found"
+      pages: ['terms'],
     });
     const tree = z.array(shopCategorySchema).parse((await get('/public/v1/categories')).json());
     // One flat list in the tenant's order (position, then name); the shop builds the tree
```

26f's test shop has written Terms only, so its `pages` is `['terms']`.

```diff
@@ -2,6 +2,7 @@ import type { INestApplicationContext } from '@nestjs/common';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
   productPageSchema,
+  publicShopSchema,
   setupSchema,
   shopCartQuoteSchema,
   shopCategorySchema,
@@ -223,6 +224,9 @@ describe('one host, one shop', () => {
     // Acme wrote an About page; Nirvor did not
     expect((await get(ACME, '/public/v1/pages/about')).statusCode).toBe(200);
     expect((await get(NIRVOR, '/public/v1/pages/about')).statusCode).toBe(404);
+    // Step 26h: and its footer does not link to Acme's page
+    const shops = await Promise.all([NIRVOR, ACME].map((host) => get(host, '/public/v1/shop')));
+    expect(shops.map((res) => publicShopSchema.parse(res.json()).pages)).toEqual([[], ['about']]);
     const home = shopHomeSchema.parse((await get(NIRVOR, '/public/v1/home')).json());
     expect(home.blocks).toEqual([]);
     expect(home.featured.map((card) => card.name)).toEqual(['Nirvor Green Tea']);
```

Acme has written About and Nirvor nothing. Nirvor's footer must not link to Acme's page, so Nirvor's `pages` is
empty and Acme's is `['about']`.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/storefront
pnpm exec prettier --check apps/api/src/storefront
cd apps/api && npx vitest run src/storefront/ --maxWorkers=2
```

The storefront folder's 10 files pass: 134 tests (the new file has 31, the leak file 17). Each suite starts its own
containers, so they need Docker.

Broken on purpose, one at a time, each caught by the new tests (and put back):

| Broken | Caught by |
|---|---|
| No renumbering after a collection's delete | 5 tests, from "closes the gap" on |
| No home lock when a collection is added | the race for the twelfth place (three runs, three failures) |
| The banner routes find the hero too (no `kind = 'image'`) | "changes the hero…" |
| The hero's race not turned into `version_conflict` | "makes one hero when two first saves come at once" |
| The page's first insert without `onConflictDoNothing` | "writes a page once…" |
| The shop's `pages` not filtered | 4 tests |
| The collection's listing check skipped | "cannot put their listing in our collection" (leak) |

## 26h.5 — `packages/i18n`: the screens' words

The four new pages of 26h.6 need their words in English and Bangla, so they come first. 26h.1 already gave the
errors, the audit events and the permission's line their words; this part adds the sidebar's two items, one block
per page, four small blocks the pages share, the audit log's names for the fields the 26h.3 services write, and a test that the Bangla
keeps the English placeholders.

These words come before the mockup. If the mockup in 26h.6 changes a page, the words change with it, and the diffs
below show them as they are at the end of the step.

Five decisions came up while writing the words (mine):

32. **The sidebar says "Shop appearance" and "Shop pages"**, for the reason of 26g's decision 35: on a phone the
    nav is one row with no group labels, and "Pages" alone says nothing there.
33. **The section editor's words move to `storefront.sections`.** A listing's description and a text page use the
    same editor (decision 5), so its own words (Section 1, Heading, Text, Add section, Preview…) are shared now. The
    words that differ per page stay with the page: the card's title and hint, the placeholders, the line when there
    is no section, and the preview's caption ("As the product page shows it", "As the shop shows it"). The one
    component that read the old keys gets the new names in this part, so the app keeps type-checking.
34. **A banner has "pictures", a listing has "photos".** A picture banner is usually a designed picture with its
    words in it, not a photo, so the Appearance page says "Picture for computers" and "Preparing the picture…". The
    upload errors from 26g say "photo" for both; that is still true enough, and changing them would change 26g's
    screens.
35. **A banner is named by its words.** A picture banner has no title, so the Home page card, the menus and the
    labels call it by its computer picture's alt text ("Picture banner: Himalaya mega sale"). The alt text is
    required (26f), so the name is never empty, and it is the same text a screen reader hears in the shop.
36. **The audit log names a page's change by the page.** 26h.3 keys a page's change by its slug ("terms: Returns →
    Returns, Delivery", decision 26), so the four slugs get field words, the footer's own: "Terms & Condition:
    Returns → Returns, Delivery".

### `locales/en.ts`

```diff
@@ -154,6 +154,9 @@ export const en = {
     storefrontCatalog: 'Catalog',
     storefrontCategories: 'Shop categories',
     storefrontSettings: 'Shop settings',
+    // Step 26h: the group's last two items, "Shop" for the same reason (decision 32)
+    storefrontAppearance: 'Shop appearance',
+    storefrontPages: 'Shop pages',
   },
   auth: {
     workspace: 'Workspace',
```

The sidebar's two new items (decision 32).

```diff
@@ -5234,6 +5237,71 @@ export const en = {
     // Step 26g.6: the save bar under a long form, while it has changes (the mockup's bar)
     unsaved: 'Changes not saved yet',
     discard: 'Discard changes',
+    // Step 26h: the section editor, shared by a listing's description and the text pages (decision
+    // 33). Moved here from `listing`; each page keeps its own title, placeholders and caption
+    sections: {
+      number: 'Section {{number}}',
+      heading: 'Heading',
+      body: 'Text',
+      bodyHint:
+        'A blank line starts a new paragraph. Lines that start with - make a list, and 1. a numbered one. **Bold** and [a link](https://…) work too.',
+      add: 'Add section',
+      remove: 'Remove section {{number}}',
+      moveUp: 'Move section {{number}} up',
+      moveDown: 'Move section {{number}} down',
+      showPreview: 'Preview',
+      hidePreview: 'Hide preview',
+    },
+    // Step 26h: one picture box of the logo, the hero or a picture banner (decision 34: a banner
+    // is a picture, often with its words in it; a listing keeps its "photos")
+    picture: {
+      upload: 'Upload picture',
+      replace: 'Replace picture',
+      remove: 'Remove picture',
+      uploading: 'Uploading…',
+      preparing: 'Preparing the picture…',
+      // A picture the job could not use: the error words say why; this empties the box
+      drop: 'Remove it',
+      alt: 'What the picture shows',
+      fileHint: 'JPEG, PNG or WebP, under 8 MB, at least 200 pixels on each side.',
+      // 26h.6: under an empty box after a save was tried (the schema refuses an empty id)
+      missing: 'Upload a picture.',
+    },
+    // Step 26h: a color box and its contrast line (decisions 3 and 11)
+    color: {
+      // name = the box's label, for the palette button's accessible name
+      palette: 'Pick {{name}} on a palette',
+      // ratio = formatContrast() ("4.4:1", cut, not rounded), min = "4.5:1" or "3:1"
+      ratio: '{{ratio}}, needs {{min}}',
+      ok: 'Easy to read',
+      low: 'Too low',
+    },
+    // Step 26h: the "Links to" select of the hero and a picture banner (decision 4)
+    link: {
+      label: 'Links to',
+      kinds: {
+        category: 'A shop category',
+        listing: 'A product',
+        offers: 'Products on offer',
+        all: 'All products',
+        other: 'Another address',
+      },
+      category: 'Shop category',
+      categoryPlaceholder: 'Pick a category',
+      listing: 'Product',
+      listingPlaceholder: 'Pick a product',
+      searchLabel: 'Search the catalog',
+      noMatch: 'No listing matches.',
+      href: 'Address',
+      hrefPlaceholder: '/pages/about',
+      hrefHint: 'A page of your shop, starting with /, or a whole link starting with https://.',
+      // href = the address the choice makes, under the select: "Goes to /c/skin-care"
+      goesTo: 'Goes to {{href}}',
+      // The saved address names a category or product that is gone (renamed or deleted, decision 4)
+      gone: 'Nothing in the shop has this address now, so shoppers get “page not found”. Pick where it goes again.',
+      // A draft listing has no page in the shop yet
+      draft: 'This product is a draft, so the link shows “page not found” until it is in the shop.',
+    },
     settings: {
       title: 'Shop settings',
       description: 'Your online shop’s address, contact details, delivery and payment',
```

Four blocks the pages share, before the 26g pages' own blocks:

- **`sections`** is decision 33. The keys lose their `Section` part (`addSection` → `add`), because the block's name
  already says it.
- **`picture`** is one picture box: the logo, and the hero's and a banner's two pictures. `fileHint` repeats the
  photo job's rules (26g decision 9) before the upload, like the listing's `photosHint`. `drop` empties a box whose
  picture the job could not use; the error under it says why.
- **`color`** is the color box of decisions 3 and 11: a palette button (its accessible name says which color), the
  `#` code, and a contrast line. `ratio` gets two strings that `formatContrast()` makes, the ratio ("4.4:1", cut,
  not rounded) and the minimum ("4.5:1", or "3:1" for the hero's headline), so the line shows the number the check
  uses. `ok` and `low` are the pill beside it: the color is never the only sign (CLAUDE.md → Color tokens).
- **`link`** is the "Links to" select of decision 4. Its five kinds are the contract's `STOREFRONT_LINK_KINDS`.
  `goesTo` shows the address the choice makes, so the owner sees what will be saved. `gone` is for a saved address
  that names a category or product that is not there any more (renamed or deleted), the case decision 4 accepted:
  the form says so instead of quietly showing "Another address". `draft` warns that a link to a draft listing leads
  to "page not found" until the listing is in the shop.

```diff
@@ -5519,20 +5587,10 @@ export const en = {
       descriptionTitle: 'Description',
       descriptionHint:
         'Sections under the photos on the product page, like Benefits and How to use.',
-      sectionNumber: 'Section {{number}}',
-      heading: 'Heading',
+      // Step 26h: the editor's own words moved to `sections`; these four are the listing's
       headingPlaceholder: 'Benefits',
-      body: 'Text',
       bodyPlaceholder: '- Clears pimples\n- Gentle enough for every day',
-      bodyHint:
-        'A blank line starts a new paragraph. Lines that start with - make a list, and 1. a numbered one. **Bold** and [a link](https://…) work too.',
-      addSection: 'Add section',
-      removeSection: 'Remove section {{number}}',
-      moveSectionUp: 'Move section {{number}} up',
-      moveSectionDown: 'Move section {{number}} down',
       noSections: 'No description. The product page then shows the photos and the price only.',
-      showPreview: 'Preview',
-      hidePreview: 'Hide preview',
       previewCaption: 'As the product page shows it',
       seoTitle: 'Search engines',
       seoHint:
```

The listing keeps only its own four words for the editor (decision 33).

```diff
@@ -5544,6 +5602,233 @@ export const en = {
       notFound: "This listing doesn't exist.",
       loadFailed: "Couldn't load the listing. Refresh the page to try again.",
     },
+    // Step 26h: /storefront/appearance (decision 2), three cards
+    appearance: {
+      title: 'Shop appearance',
+      description: 'Your shop’s logo, colors, hero banner and home page',
+      // Every route needs the shop's settings first (storefront_not_set_up)
+      notSetUpTitle: 'Set up the shop first',
+      notSetUpBody: 'Save the shop’s address, contact and delivery details, then give it its look.',
+      goToSettings: 'Go to shop settings',
+      loadFailed: "Couldn't load the shop’s appearance. Refresh the page to try again.",
+      theme: {
+        title: 'Logo and colors',
+        description: 'On every page of the shop',
+        logo: 'Logo',
+        logoHint:
+          'In the header and the footer, next to your shop’s name. A square picture with a plain background works best.',
+        noLogo: 'No logo. The shop shows the Omnivo mark.',
+        // name = the shop's name: the logo's alt text, here and in the shop
+        logoAlt: '{{name}} logo',
+        brand: 'Brand color',
+        brandHint: 'The header, titles, product names and labels.',
+        accent: 'Accent color',
+        accentHint: 'Add to cart, the search button, and words on the brand color.',
+        contrastCream: 'Brand color on light backgrounds',
+        contrastAccent: 'Brand and accent together',
+        reset: 'Use the default colors',
+        preview: 'In the shop',
+        // The preview's own words are the shop's (shop.header, shop.card), copied: the ERP app
+        // never loads the shop's words
+        previewSearch: 'Search for Cosmetics, Food',
+        previewChip: 'All Categories',
+        previewAddToCart: 'Add to cart',
+        saved: 'Logo and colors saved',
+      },
+      hero: {
+        title: 'Hero banner',
+        description: 'The big banner at the top of the home page',
+        none: 'No hero banner. The home page starts with its products.',
+        add: 'Add hero banner',
+        edit: 'Edit hero banner',
+        newTitle: 'Add the hero banner',
+        editTitle: 'Edit the hero banner',
+        headline: 'Headline',
+        headlinePlaceholder: 'Get 10% cash-back on shopping ৳150',
+        headlineHint: 'White, on the panel. About three short lines fit on a computer.',
+        line: 'Line under the headline',
+        linePlaceholder: 'Shop your favorite brands and save big this season.',
+        lineHint: 'On phones only.',
+        eyebrow: 'Tag',
+        eyebrowPlaceholder: 'Exclusive offer',
+        eyebrowHint: 'The small pill at the top, on phones only.',
+        button: 'Button',
+        buttonPlaceholder: 'Get 10% cashback',
+        buttonHint: 'On computers. On phones the whole banner is the link.',
+        desktopImage: 'Picture for computers',
+        desktopImageHint:
+          'On the right of the panel, 280 pixels high. About 1,400 × 560 pixels looks sharp.',
+        phoneImage: 'Picture for phones',
+        phoneImageHint:
+          'Fills the banner behind the words, 220 pixels high. About 1,080 × 660 pixels looks sharp.',
+        altPlaceholder: 'Make-up and skin care products',
+        colorsTitle: 'Colors',
+        // 26h.6: the hero page's other cards (approved with the mockup) and its preview card
+        wordsTitle: 'Words',
+        picturesTitle: 'Pictures',
+        previewTitle: 'In the shop',
+        // The segmented control's name: "Preview on Computer / Phone"
+        previewLabel: 'Preview on',
+        background: 'Background',
+        backgroundHint: 'Behind the picture on computers.',
+        panel: 'Panel',
+        panelHint: 'Behind the white headline on computers.',
+        buttonColor: 'Button',
+        buttonText: 'Button’s words',
+        contrastButton: 'Button’s words on the button',
+        contrastPanel: 'White headline on the panel',
+        previewDesktop: 'Computer',
+        previewPhone: 'Phone',
+        saved: 'Hero banner saved',
+        delete: 'Delete hero banner',
+        confirmDelete: 'Delete the hero banner?',
+        deleteBody: 'The home page then starts with its products. You can add a new one later.',
+        deleted: 'Hero banner deleted',
+      },
+      // The blocks under the product grid (decision 2: every banner and collection is on it)
+      home: {
+        title: 'Home page',
+        description: 'The blocks under the product grid, from the top',
+        // count and max in the page's language
+        count: '{{count}} of {{max}} blocks',
+        fixed: 'The hero banner and the product grid always come first.',
+        addBanner: 'Add picture banner',
+        addCollection: 'Add collection',
+        // Why an Add button is disabled (decision 6)
+        bannersFull: 'The home page has {{max}} picture banners, the most it can have.',
+        collectionsFull: 'The home page has {{max}} collections, the most it can have.',
+        full: 'The home page has {{max}} blocks, the most it can have. Delete one to add another.',
+        banner: 'Picture banner',
+        collection: 'Collection',
+        // A collection's line: all of it in the shop, some of it, or none (the shop hides an
+        // empty row)
+        products_one: '{{formatted}} product',
+        products_other: '{{formatted}} products',
+        partlyPublished: '{{published}} of {{total}} in the shop',
+        nonePublished: 'None in the shop now, so the row is hidden',
+        moveUpLabel: 'Move {{name}} up',
+        moveDownLabel: 'Move {{name}} down',
+        actions: 'Actions for {{name}}',
+        edit: 'Edit',
+        delete: 'Delete',
+        emptyTitle: 'Nothing under the product grid yet',
+        emptyBody:
+          'Add a picture banner for a sale, or a collection like Hot & Trending Right Now.',
+      },
+      // The picture banner's dialog
+      banner: {
+        newTitle: 'Add a picture banner',
+        editTitle: 'Edit picture banner',
+        description: 'A picture with its words in it, like a sale, across the home page.',
+        desktopImageHint: 'Shown 1,280 × 280 pixels. Upload 2,560 × 560 for sharp screens.',
+        phoneImageHint: 'Shown about 360 × 140 pixels. Upload 1,080 × 420.',
+        altHint:
+          'The banner’s words are in the picture, so type them here for shoppers who can’t see it.',
+        altPlaceholder: 'Himalaya mega sale, up to 30% off',
+        submit: 'Add banner',
+        added: 'Picture banner added at the end of the home page',
+        saved: 'Picture banner saved',
+        confirmDelete: 'Delete this picture banner?',
+        deleteBody: 'It leaves the home page, with its link and pictures.',
+        deleted: 'Picture banner deleted',
+        // A banner's name in the list and in labels: the words of its computer picture
+        name: 'Picture banner: {{alt}}',
+      },
+    },
+    // Step 26h: a collection's page (/storefront/collections/$id, and .../new)
+    collection: {
+      back: 'Shop appearance',
+      newTitle: 'New collection',
+      description: 'A row of products you pick, on the home page',
+      title: 'Title',
+      titlePlaceholder: 'Hot & Trending Right Now',
+      fire: 'Show a flame after the title',
+      products: 'Products',
+      // max = STOREFRONT_COLLECTION_ITEMS_MAX
+      productsHint: 'Up to {{max}}, in the order the row shows them.',
+      count: '{{count}} of {{max}}',
+      addLabel: 'Product to add',
+      addPlaceholder: 'Pick a product',
+      searchLabel: 'Search the catalog',
+      noMatch: 'No listing matches. Products in the collection already are not listed.',
+      full: 'The collection has {{max}} products, the most a row shows.',
+      none: 'No products yet. Add the ones this row shows, like your best sellers.',
+      remove: 'Remove {{name}}',
+      moveUpLabel: 'Move {{name}} up',
+      moveDownLabel: 'Move {{name}} down',
+      // A draft waits in the collection and shows once it is in the shop
+      draftHint: 'Drafts stay here and show in the row once they are in the shop.',
+      hiddenNotice:
+        'None of these products is in the shop now, so the home page hides this row until one is.',
+      create: 'Add collection',
+      created: '{{title}} added at the end of the home page',
+      saved: '{{title}} saved',
+      delete: 'Delete collection',
+      confirmDelete: 'Delete {{title}}?',
+      deleteBody: 'It leaves the home page. The products stay in the shop.',
+      deleted: '{{title}} deleted',
+      notFound: "This collection doesn't exist.",
+      loadFailed: "Couldn't load the collection. Refresh the page to try again.",
+    },
+    // Step 26h: the four text pages (decision 5)
+    pages: {
+      title: 'Shop pages',
+      description: 'The four pages linked from the shop’s footer',
+      notSetUpTitle: 'Set up the shop first',
+      notSetUpBody: 'Save the shop’s address, contact and delivery details, then write its pages.',
+      goToSettings: 'Go to shop settings',
+      // The footer's own words (shop.footer), copied
+      names: {
+        privacy: 'Privacy Policy',
+        terms: 'Terms & Condition',
+        about: 'About Us',
+        contact: 'Contact Us',
+      },
+      // What each page is for, under its name in the list
+      hints: {
+        privacy: 'How you use the names, phone numbers and addresses shoppers give you.',
+        terms: 'Your rules for delivery, returns, refunds and payment.',
+        about: 'Who you are and what you sell.',
+        contact: 'Your hotline, address and hours. The page has no form.',
+      },
+      // 26h.6: sections and the hidden name of the Edit / Write column
+      columns: {
+        page: 'Page',
+        status: 'Status',
+        sections: 'Sections',
+        updated: 'Changed',
+        actions: 'Actions',
+      },
+      written: 'In the footer',
+      notWritten: 'Not written',
+      sections_one: '{{formatted}} section',
+      sections_other: '{{formatted}} sections',
+      write: 'Write',
+      edit: 'Edit',
+      loadFailed: "Couldn't load the shop’s pages. Refresh the page to try again.",
+    },
+    // Step 26h: one text page's editor (/storefront/pages/$slug)
+    page: {
+      back: 'Shop pages',
+      notWrittenNotice:
+        'This page is not written yet. The footer leaves its link out, and its address shows “page not found”.',
+      sectionsTitle: 'Sections',
+      sectionsHint: 'Each with a heading and its text, like Delivery and Returns.',
+      headingPlaceholder: 'Returns',
+      bodyPlaceholder: '- Unopened items come back within 7 days\n- Keep the order number',
+      noSections: 'No sections yet. Add the first one, then save to put the page in the shop.',
+      previewCaption: 'As the shop shows it',
+      viewPage: 'View page',
+      // name = the page's name (pages.names)
+      created: '{{name}} is in the shop',
+      saved: '{{name}} saved',
+      delete: 'Delete page',
+      confirmDelete: 'Delete {{name}}?',
+      deleteBody:
+        'The footer drops its link, and its address shows “page not found”. You can write it again later.',
+      deleted: '{{name}} deleted',
+      loadFailed: "Couldn't load the page. Refresh the page to try again.",
+    },
   },
   approvals: {
     title: 'Approvals',
```

The pages' words, one block each. Some things to notice:

- **`notSetUpTitle`, `notSetUpBody` and `goToSettings`** are in both `appearance` and `pages`: the reads and the adds of
  26h answer `storefront_not_set_up` before the first save of the settings (decisions 24 and 31), so both pages start with
  that empty state, like the catalog. The body says what comes next on that page.
- **`theme.contrastCream` and `theme.contrastAccent`** name the two checks of decision 3 in the owner's words:
  "cream" is a token name, "light backgrounds" is what they see. `brandHint` and `accentHint` say where each color
  shows, so the owner knows what a change does before saving.
- **`theme.previewSearch`, `previewChip` and `previewAddToCart`** are the shop's own words (the header's search box,
  the first filter chip, the card's button), copied, not imported: the ERP app never loads the shop's words
  (CLAUDE.md → Language). The preview then reads exactly like the shop.
- **`hero.lineHint`, `eyebrowHint` and `buttonHint`** say which screen shows each part: the line and the tag are on
  the phone's hero only, the button on the computer's only (CLAUDE.md → Hero banner). Without them an owner fills
  a box and looks for it on the wrong screen.
- **`hero.desktopImageHint`, `phoneImageHint` and `banner.desktopImageHint`, `phoneImageHint`** give the size the
  shop draws and a size that looks sharp on a high-density screen (twice or three times it). They are advice, not
  rules: the job only refuses a picture under 200 pixels (26g decision 9), and `object-cover` crops the rest.
- **`hero.headlinePlaceholder` and the other placeholders** are the Figma hero's own words (the mock shop's hero),
  so a new hero's empty form looks like the shop the owner has seen.
- **`home.fixed`** says why the hero and the product grid are not in the list: they always come first, and only
  the blocks under the grid move.
- **`home.bannersFull`, `collectionsFull` and `full`** say why an Add button is disabled (decision 6), with the
  number from the contract. The API refuses the same with the error codes of 26h.1; the button is disabled first so
  the owner does not fill a dialog for nothing.
- **`home.products`, `partlyPublished` and `nonePublished`** are a collection's line in the card. A collection keeps
  its drafts (the contract), and its count is the shop's (decision 27), so "9 of 12 in the shop" says how many the row shows, and "None in the shop now, so the
  row is hidden" says why a collection is missing from the shop.
- **`banner.altHint`** asks for the words in the picture: a picture banner has no other text, so its alt text is
  what a shopper who can't see it gets (and its name in the ERP, decision 35).
- **`collection.noMatch`** explains why a listing is missing from the search: the ones already in the collection
  are left out (the contract refuses one listing twice, `storefront_listing_twice`). `draftHint` and
  `hiddenNotice` are the collection page's side of `home.nonePublished`.
- **`pages.names`** are the footer's own words (`shop.footer`), copied, so the list names a page the way a shopper
  sees it. `pages.hints` say what each page is for, because there are no templates (decision 5) and an owner may
  not know what a privacy page holds.
- **`pages.written` and `notWritten`** are the list's status: "In the footer" says what a written page does in the
  shop, which is the point of writing it.
- **`page.notWrittenNotice` and `page.deleteBody`** say what the shop does without the page: no link in the footer,
  "page not found" at its address. `page.created` is the toast of the first save, which puts the page in the shop.

```diff
@@ -6751,6 +7036,31 @@ export const en = {
       seoDescription: 'Page description',
       variant: 'Product',
       published: 'In the shop',
+      // Step 26h: the logo and colors, a banner (the hero's words and colors too), a collection,
+      // and a text page, whose change is named by the page ("Terms & Condition: Returns → …")
+      logoImageId: 'Logo',
+      brandColor: 'Brand color',
+      accentColor: 'Accent color',
+      href: 'Links to',
+      desktopImage: 'Picture for computers',
+      desktopAlt: 'What the computer picture shows',
+      phoneImage: 'Picture for phones',
+      phoneAlt: 'What the phone picture shows',
+      headline: 'Headline',
+      line: 'Line under the headline',
+      eyebrow: 'Tag',
+      buttonLabel: 'Button',
+      backgroundColor: 'Background',
+      panelColor: 'Panel',
+      buttonColor: 'Button color',
+      buttonTextColor: 'Button’s words',
+      title: 'Title',
+      icon: 'Icon',
+      listings: 'Products',
+      privacy: 'Privacy Policy',
+      terms: 'Terms & Condition',
+      about: 'About Us',
+      contact: 'Contact Us',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

The audit log's names for the fields 26h.3 writes: the theme's three (`logoImageId`, `brandColor`, `accentColor`), a
banner's (the hero's words and colors too), a collection's (`title`, `icon`, `listings`), and the four page slugs
(decision 36). No other service writes `line`, `title`, `icon` or `href` into the log, so the words can't read
wrong elsewhere. A banner's `kind` already had a word ("Kind"); its values, `hero` and `image`, show as they are,
like every other kind in the log.

### `locales/bn.ts`

```diff
@@ -134,6 +134,8 @@ export const bn: Messages = {
     storefrontCatalog: 'ক্যাটালগ',
     storefrontCategories: 'শপের ক্যাটাগরি',
     storefrontSettings: 'শপের সেটিংস',
+    storefrontAppearance: 'শপের চেহারা',
+    storefrontPages: 'শপের পেজ',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -4881,6 +4883,58 @@ export const bn: Messages = {
     moveDown: 'নিচে সরান',
     unsaved: 'পরিবর্তন এখনো সেভ হয়নি',
     discard: 'পরিবর্তন বাদ দিন',
+    sections: {
+      number: 'অংশ {{number}}',
+      heading: 'শিরোনাম',
+      body: 'লেখা',
+      bodyHint:
+        'ফাঁকা লাইন দিলে নতুন অনুচ্ছেদ। - দিয়ে শুরু লাইনগুলো তালিকা হয়, আর 1. দিয়ে শুরু হলে নম্বরসহ তালিকা। **বোল্ড** আর [লিংক](https://…)-ও চলে।',
+      add: 'অংশ যোগ করুন',
+      remove: 'অংশ {{number}} সরান',
+      moveUp: 'অংশ {{number}} উপরে সরান',
+      moveDown: 'অংশ {{number}} নিচে সরান',
+      showPreview: 'প্রিভিউ',
+      hidePreview: 'প্রিভিউ লুকান',
+    },
+    picture: {
+      upload: 'ছবি আপলোড করুন',
+      replace: 'ছবি বদলান',
+      remove: 'ছবি সরান',
+      uploading: 'আপলোড হচ্ছে…',
+      preparing: 'ছবি তৈরি হচ্ছে…',
+      drop: 'বাদ দিন',
+      alt: 'ছবিতে কী আছে',
+      fileHint: 'JPEG, PNG বা WebP, ৮ MB-র কম, প্রতিটা দিকে অন্তত ২০০ পিক্সেল।',
+      missing: 'একটা ছবি আপলোড করুন।',
+    },
+    color: {
+      palette: 'প্যালেট থেকে {{name}} বাছুন',
+      ratio: '{{ratio}}, দরকার {{min}}',
+      ok: 'সহজে পড়া যায়',
+      low: 'খুব কম',
+    },
+    link: {
+      label: 'যেখানে নিয়ে যায়',
+      kinds: {
+        category: 'শপের একটা ক্যাটাগরি',
+        listing: 'একটা প্রোডাক্ট',
+        offers: 'অফারের প্রোডাক্ট',
+        all: 'সব প্রোডাক্ট',
+        other: 'অন্য ঠিকানা',
+      },
+      category: 'শপের ক্যাটাগরি',
+      categoryPlaceholder: 'ক্যাটাগরি বাছুন',
+      listing: 'প্রোডাক্ট',
+      listingPlaceholder: 'প্রোডাক্ট বাছুন',
+      searchLabel: 'ক্যাটালগে খুঁজুন',
+      noMatch: 'কোনো লিস্টিং মেলেনি।',
+      href: 'ঠিকানা',
+      hrefPlaceholder: '/pages/about',
+      hrefHint: 'আপনার শপের একটা পেজ, / দিয়ে শুরু, অথবা https:// দিয়ে শুরু পুরো লিংক।',
+      goesTo: '{{href}}-এ নিয়ে যায়',
+      gone: 'শপে এখন এই ঠিকানায় কিছু নেই, তাই ক্রেতারা “পেজ পাওয়া যায়নি” দেখেন। কোথায় নিয়ে যাবে আবার বাছুন।',
+      draft: 'এই প্রোডাক্ট ড্রাফট, তাই শপে না আসা পর্যন্ত লিংকটা “পেজ পাওয়া যায়নি” দেখায়।',
+    },
     settings: {
       title: 'শপের সেটিংস',
       description: 'আপনার অনলাইন শপের ঠিকানা, যোগাযোগ, ডেলিভারি আর পেমেন্ট',
@@ -5133,20 +5187,9 @@ export const bn: Messages = {
       previewEnded: 'অফার {{date}}-এ শেষ হয়েছে।',
       descriptionTitle: 'বর্ণনা',
       descriptionHint: 'প্রোডাক্ট পেজে ছবির নিচের অংশগুলো, যেমন উপকারিতা আর ব্যবহারের নিয়ম।',
-      sectionNumber: 'অংশ {{number}}',
-      heading: 'শিরোনাম',
       headingPlaceholder: 'উপকারিতা',
-      body: 'লেখা',
       bodyPlaceholder: '- ব্রণ দূর করে\n- প্রতিদিন ব্যবহারের মতো কোমল',
-      bodyHint:
-        'ফাঁকা লাইন দিলে নতুন অনুচ্ছেদ। - দিয়ে শুরু লাইনগুলো তালিকা হয়, আর 1. দিয়ে শুরু হলে নম্বরসহ তালিকা। **বোল্ড** আর [লিংক](https://…)-ও চলে।',
-      addSection: 'অংশ যোগ করুন',
-      removeSection: 'অংশ {{number}} সরান',
-      moveSectionUp: 'অংশ {{number}} উপরে সরান',
-      moveSectionDown: 'অংশ {{number}} নিচে সরান',
       noSections: 'বর্ণনা নেই। তখন প্রোডাক্ট পেজে শুধু ছবি আর দাম থাকে।',
-      showPreview: 'প্রিভিউ',
-      hidePreview: 'প্রিভিউ লুকান',
       previewCaption: 'পণ্যের পেজে যেমন দেখাবে',
       seoTitle: 'সার্চ ইঞ্জিন',
       seoHint:
@@ -5157,6 +5200,211 @@ export const bn: Messages = {
       notFound: 'এই লিস্টিং নেই।',
       loadFailed: 'লিস্টিং আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     },
+    appearance: {
+      title: 'শপের চেহারা',
+      description: 'আপনার শপের লোগো, রং, হিরো ব্যানার আর হোম পেজ',
+      notSetUpTitle: 'আগে শপ সেট আপ করুন',
+      notSetUpBody: 'শপের ঠিকানা, যোগাযোগ আর ডেলিভারির তথ্য সেভ করুন, তারপর এর চেহারা ঠিক করুন।',
+      goToSettings: 'শপের সেটিংসে যান',
+      loadFailed: 'শপের চেহারা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+      theme: {
+        title: 'লোগো আর রং',
+        description: 'শপের প্রতিটা পেজে',
+        logo: 'লোগো',
+        logoHint:
+          'হেডার আর ফুটারে, আপনার শপের নামের পাশে। সাদামাটা ব্যাকগ্রাউন্ডের চৌকো ছবি সবচেয়ে ভালো দেখায়।',
+        noLogo: 'লোগো নেই। শপ Omnivo-র চিহ্ন দেখায়।',
+        logoAlt: '{{name}}-এর লোগো',
+        brand: 'ব্র্যান্ডের রং',
+        brandHint: 'হেডার, শিরোনাম, প্রোডাক্টের নাম আর লেবেল।',
+        accent: 'অ্যাকসেন্ট রং',
+        accentHint: 'কার্টে যোগ করুন, সার্চের বাটন, আর ব্র্যান্ডের রঙের ওপর লেখা।',
+        contrastCream: 'হালকা ব্যাকগ্রাউন্ডে ব্র্যান্ডের রং',
+        contrastAccent: 'ব্র্যান্ড আর অ্যাকসেন্ট একসাথে',
+        reset: 'আগের রং ফিরিয়ে আনুন',
+        preview: 'শপে',
+        previewSearch: 'কসমেটিকস, খাবার খুঁজুন',
+        previewChip: 'সব ক্যাটাগরি',
+        previewAddToCart: 'কার্টে যোগ করুন',
+        saved: 'লোগো আর রং সেভ হয়েছে',
+      },
+      hero: {
+        title: 'হিরো ব্যানার',
+        description: 'হোম পেজের একদম ওপরের বড় ব্যানার',
+        none: 'হিরো ব্যানার নেই। হোম পেজ প্রোডাক্ট দিয়ে শুরু হয়।',
+        add: 'হিরো ব্যানার যোগ করুন',
+        edit: 'হিরো ব্যানার এডিট করুন',
+        newTitle: 'হিরো ব্যানার যোগ করুন',
+        editTitle: 'হিরো ব্যানার এডিট করুন',
+        headline: 'শিরোনাম',
+        headlinePlaceholder: '৳১৫০-এর কেনাকাটায় ১০% ক্যাশব্যাক',
+        headlineHint: 'প্যানেলের ওপর সাদা লেখা। কম্পিউটারে ছোট তিন লাইনের মতো ধরে।',
+        line: 'শিরোনামের নিচের লাইন',
+        linePlaceholder: 'পছন্দের ব্র্যান্ড কিনুন, এই মৌসুমে বেশি সাশ্রয় করুন।',
+        lineHint: 'শুধু ফোনে।',
+        eyebrow: 'ট্যাগ',
+        eyebrowPlaceholder: 'বিশেষ অফার',
+        eyebrowHint: 'ওপরের ছোট পিল, শুধু ফোনে।',
+        button: 'বাটন',
+        buttonPlaceholder: '১০% ক্যাশব্যাক নিন',
+        buttonHint: 'কম্পিউটারে। ফোনে পুরো ব্যানারটাই লিংক।',
+        desktopImage: 'কম্পিউটারের ছবি',
+        desktopImageHint:
+          'প্যানেলের ডানে, ২৮০ পিক্সেল উঁচু। মোটামুটি ১,৪০০ × ৫৬০ পিক্সেল হলে ঝকঝকে দেখায়।',
+        phoneImage: 'ফোনের ছবি',
+        phoneImageHint:
+          'লেখার পেছনে পুরো ব্যানার জুড়ে, ২২০ পিক্সেল উঁচু। মোটামুটি ১,০৮০ × ৬৬০ পিক্সেল হলে ঝকঝকে দেখায়।',
+        altPlaceholder: 'মেকআপ আর স্কিন কেয়ারের প্রোডাক্ট',
+        colorsTitle: 'রং',
+        wordsTitle: 'লেখা',
+        picturesTitle: 'ছবি',
+        previewTitle: 'শপে যেমন দেখাবে',
+        previewLabel: 'যেখানে দেখাবে',
+        background: 'ব্যাকগ্রাউন্ড',
+        backgroundHint: 'কম্পিউটারে ছবির পেছনে।',
+        panel: 'প্যানেল',
+        panelHint: 'কম্পিউটারে সাদা শিরোনামের পেছনে।',
+        buttonColor: 'বাটন',
+        buttonText: 'বাটনের লেখা',
+        contrastButton: 'বাটনের ওপর বাটনের লেখা',
+        contrastPanel: 'প্যানেলের ওপর সাদা শিরোনাম',
+        previewDesktop: 'কম্পিউটার',
+        previewPhone: 'ফোন',
+        saved: 'হিরো ব্যানার সেভ হয়েছে',
+        delete: 'হিরো ব্যানার মুছুন',
+        confirmDelete: 'হিরো ব্যানার মুছবেন?',
+        deleteBody: 'তখন হোম পেজ প্রোডাক্ট দিয়ে শুরু হবে। পরে নতুন একটা যোগ করতে পারবেন।',
+        deleted: 'হিরো ব্যানার মোছা হয়েছে',
+      },
+      home: {
+        title: 'হোম পেজ',
+        description: 'প্রোডাক্টের গ্রিডের নিচের ব্লকগুলো, ওপর থেকে',
+        count: '{{max}}টার মধ্যে {{count}}টা ব্লক',
+        fixed: 'হিরো ব্যানার আর প্রোডাক্টের গ্রিড সবসময় আগে থাকে।',
+        addBanner: 'ছবির ব্যানার যোগ করুন',
+        addCollection: 'কালেকশন যোগ করুন',
+        bannersFull: 'হোম পেজে {{max}}টা ছবির ব্যানার আছে, এর বেশি রাখা যায় না।',
+        collectionsFull: 'হোম পেজে {{max}}টা কালেকশন আছে, এর বেশি রাখা যায় না।',
+        full: 'হোম পেজে {{max}}টা ব্লক আছে, এর বেশি রাখা যায় না। আরেকটা যোগ করতে একটা মুছুন।',
+        banner: 'ছবির ব্যানার',
+        collection: 'কালেকশন',
+        products_one: '{{formatted}}টা প্রোডাক্ট',
+        products_other: '{{formatted}}টা প্রোডাক্ট',
+        partlyPublished: '{{total}}টার মধ্যে {{published}}টা শপে আছে',
+        nonePublished: 'এখন একটাও শপে নেই, তাই সারিটা লুকানো',
+        moveUpLabel: '{{name}} উপরে সরান',
+        moveDownLabel: '{{name}} নিচে সরান',
+        actions: '{{name}}-এর কাজ',
+        edit: 'এডিট',
+        delete: 'মুছুন',
+        emptyTitle: 'প্রোডাক্টের গ্রিডের নিচে এখনো কিছু নেই',
+        emptyBody:
+          'অফারের জন্য একটা ছবির ব্যানার যোগ করুন, অথবা Hot & Trending Right Now-এর মতো একটা কালেকশন।',
+      },
+      banner: {
+        newTitle: 'ছবির ব্যানার যোগ করুন',
+        editTitle: 'ছবির ব্যানার এডিট করুন',
+        description: 'লেখাসহ একটা ছবি, যেমন অফারের, হোম পেজ জুড়ে।',
+        desktopImageHint:
+          '১,২৮০ × ২৮০ পিক্সেলে দেখায়। ঝকঝকে স্ক্রিনের জন্য ২,৫৬০ × ৫৬০ আপলোড করুন।',
+        phoneImageHint: 'মোটামুটি ৩৬০ × ১৪০ পিক্সেলে দেখায়। ১,০৮০ × ৪২০ আপলোড করুন।',
+        altHint:
+          'ব্যানারের লেখা ছবির ভেতরে, তাই যে ক্রেতারা ছবি দেখতে পান না তাঁদের জন্য লেখাটা এখানে লিখুন।',
+        altPlaceholder: 'হিমালয়া মেগা সেল, ৩০% পর্যন্ত ছাড়',
+        submit: 'ব্যানার যোগ করুন',
+        added: 'ছবির ব্যানার হোম পেজের শেষে যোগ হয়েছে',
+        saved: 'ছবির ব্যানার সেভ হয়েছে',
+        confirmDelete: 'এই ছবির ব্যানার মুছবেন?',
+        deleteBody: 'এটা লিংক আর ছবিসহ হোম পেজ থেকে চলে যাবে।',
+        deleted: 'ছবির ব্যানার মোছা হয়েছে',
+        name: 'ছবির ব্যানার: {{alt}}',
+      },
+    },
+    collection: {
+      back: 'শপের চেহারা',
+      newTitle: 'নতুন কালেকশন',
+      description: 'আপনার বাছাই করা প্রোডাক্টের একটা সারি, হোম পেজে',
+      title: 'শিরোনাম',
+      titlePlaceholder: 'Hot & Trending Right Now',
+      fire: 'শিরোনামের পরে আগুনের চিহ্ন দেখান',
+      products: 'প্রোডাক্ট',
+      productsHint: 'সর্বোচ্চ {{max}}টা, সারিতে যে ক্রমে দেখাবে সেই ক্রমে।',
+      count: '{{max}}টার মধ্যে {{count}}টা',
+      addLabel: 'যে প্রোডাক্ট যোগ হবে',
+      addPlaceholder: 'প্রোডাক্ট বাছুন',
+      searchLabel: 'ক্যাটালগে খুঁজুন',
+      noMatch: 'কোনো লিস্টিং মেলেনি। কালেকশনে আগে থেকে থাকা প্রোডাক্ট তালিকায় নেই।',
+      full: 'কালেকশনে {{max}}টা প্রোডাক্ট আছে, একটা সারিতে এর বেশি দেখায় না।',
+      none: 'এখনো প্রোডাক্ট নেই। এই সারিতে যেগুলো দেখাতে চান যোগ করুন, যেমন সবচেয়ে বেশি বিক্রি হওয়াগুলো।',
+      remove: '{{name}} সরান',
+      moveUpLabel: '{{name}} উপরে সরান',
+      moveDownLabel: '{{name}} নিচে সরান',
+      draftHint: 'ড্রাফটগুলো এখানে থাকে, শপে এলে সারিতে দেখায়।',
+      hiddenNotice:
+        'এই প্রোডাক্টগুলোর একটাও এখন শপে নেই, তাই একটা না আসা পর্যন্ত হোম পেজ সারিটা লুকিয়ে রাখে।',
+      create: 'কালেকশন যোগ করুন',
+      created: '{{title}} হোম পেজের শেষে যোগ হয়েছে',
+      saved: '{{title}} সেভ হয়েছে',
+      delete: 'কালেকশন মুছুন',
+      confirmDelete: '{{title}} মুছবেন?',
+      deleteBody: 'এটা হোম পেজ থেকে চলে যাবে। প্রোডাক্টগুলো শপে থাকবে।',
+      deleted: '{{title}} মোছা হয়েছে',
+      notFound: 'এই কালেকশন নেই।',
+      loadFailed: 'কালেকশন আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    pages: {
+      title: 'শপের পেজ',
+      description: 'শপের ফুটার থেকে লিংক করা চারটা পেজ',
+      notSetUpTitle: 'আগে শপ সেট আপ করুন',
+      notSetUpBody: 'শপের ঠিকানা, যোগাযোগ আর ডেলিভারির তথ্য সেভ করুন, তারপর এর পেজগুলো লিখুন।',
+      goToSettings: 'শপের সেটিংসে যান',
+      names: {
+        privacy: 'গোপনীয়তা নীতি',
+        terms: 'শর্তাবলি',
+        about: 'আমাদের সম্পর্কে',
+        contact: 'যোগাযোগ',
+      },
+      hints: {
+        privacy: 'ক্রেতাদের দেওয়া নাম, ফোন নম্বর আর ঠিকানা আপনি কীভাবে ব্যবহার করেন।',
+        terms: 'ডেলিভারি, ফেরত, টাকা ফেরত আর পেমেন্টের নিয়ম।',
+        about: 'আপনি কারা আর কী বিক্রি করেন।',
+        contact: 'আপনার হটলাইন, ঠিকানা আর খোলার সময়। পেজে কোনো ফর্ম নেই।',
+      },
+      columns: {
+        page: 'পেজ',
+        status: 'অবস্থা',
+        sections: 'অংশ',
+        updated: 'বদলেছে',
+        actions: 'কাজ',
+      },
+      written: 'ফুটারে আছে',
+      notWritten: 'লেখা হয়নি',
+      sections_one: '{{formatted}}টা অংশ',
+      sections_other: '{{formatted}}টা অংশ',
+      write: 'লিখুন',
+      edit: 'এডিট',
+      loadFailed: 'শপের পেজগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    page: {
+      back: 'শপের পেজ',
+      notWrittenNotice:
+        'এই পেজ এখনো লেখা হয়নি। ফুটারে এর লিংক নেই, আর এর ঠিকানায় “পেজ পাওয়া যায়নি” দেখায়।',
+      sectionsTitle: 'অংশ',
+      sectionsHint: 'প্রতিটায় একটা শিরোনাম আর তার লেখা, যেমন ডেলিভারি আর ফেরত।',
+      headingPlaceholder: 'ফেরত',
+      bodyPlaceholder: '- না খোলা পণ্য ৭ দিনের মধ্যে ফেরত দেওয়া যায়\n- অর্ডার নম্বর রেখে দিন',
+      noSections: 'এখনো কোনো অংশ নেই। প্রথমটা যোগ করুন, তারপর সেভ করলে পেজটা শপে আসবে।',
+      previewCaption: 'শপে যেমন দেখাবে',
+      viewPage: 'পেজ দেখুন',
+      created: '{{name}} শপে এসেছে',
+      saved: '{{name}} সেভ হয়েছে',
+      delete: 'পেজ মুছুন',
+      confirmDelete: '{{name}} মুছবেন?',
+      deleteBody:
+        'ফুটার থেকে এর লিংক চলে যাবে, আর এর ঠিকানায় “পেজ পাওয়া যায়নি” দেখাবে। পরে আবার লিখতে পারবেন।',
+      deleted: '{{name}} মোছা হয়েছে',
+      loadFailed: 'পেজটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
   },
   approvals: {
     title: 'অনুমোদন',
@@ -6311,6 +6559,29 @@ export const bn: Messages = {
       seoDescription: 'পেজের বর্ণনা',
       variant: 'প্রোডাক্ট',
       published: 'শপে আছে',
+      logoImageId: 'লোগো',
+      brandColor: 'ব্র্যান্ডের রং',
+      accentColor: 'অ্যাকসেন্ট রং',
+      href: 'যেখানে নিয়ে যায়',
+      desktopImage: 'কম্পিউটারের ছবি',
+      desktopAlt: 'কম্পিউটারের ছবিতে কী আছে',
+      phoneImage: 'ফোনের ছবি',
+      phoneAlt: 'ফোনের ছবিতে কী আছে',
+      headline: 'শিরোনাম',
+      line: 'শিরোনামের নিচের লাইন',
+      eyebrow: 'ট্যাগ',
+      buttonLabel: 'বাটন',
+      backgroundColor: 'ব্যাকগ্রাউন্ড',
+      panelColor: 'প্যানেল',
+      buttonColor: 'বাটনের রং',
+      buttonTextColor: 'বাটনের লেখা',
+      title: 'শিরোনাম',
+      icon: 'চিহ্ন',
+      listings: 'প্রোডাক্ট',
+      privacy: 'গোপনীয়তা নীতি',
+      terms: 'শর্তাবলি',
+      about: 'আমাদের সম্পর্কে',
+      contact: 'যোগাযোগ',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
```

The same keys in Bangla; the type check fails if one is missing. Some choices:

- **The terms the app already uses**: লিস্টিং, ক্যাটাগরি, ড্রাফট, শপ, লিংক, আর 26g-র ছবি.
- **The shop's own Bangla** for the preview and the four page names (`কসমেটিকস, খাবার খুঁজুন`, `শর্তাবলি`), copied
  from `shop/bn.ts` for the same reason as in English.
- **ব্যানার, কালেকশন, হিরো, প্যানেল**: common words for a Bangladeshi shop owner, the same as in English, like PO and
  LC (CLAUDE.md → Language). The collection's example title stays "Hot & Trending Right Now": it is the shop's own
  English title in Figma, not a word of the ERP.
- **Sizes and numbers inside sentences are Bangla** (২৮০ পিক্সেল, ১,৪০০ × ৫৬০); what is typed into a box stays in
  English letters (`/pages/about`).

### The section editor's keys: `storefront-sections.tsx`

```diff
@@ -101,16 +101,16 @@ export function DescriptionCard({
             <div
               key={section.id}
               role="group"
-              aria-label={t('storefront.listing.sectionNumber', { number })}
+              aria-label={t('storefront.sections.number', { number })}
               className="grid gap-4 rounded-control border border-line p-4"
             >
               <div className="flex items-center gap-0.5">
                 <span className="mr-auto text-caption text-ink-2">
-                  {t('storefront.listing.sectionNumber', { number })}
+                  {t('storefront.sections.number', { number })}
                 </span>
                 <IconButton
                   icon={ArrowUp01Icon}
-                  label={t('storefront.listing.moveSectionUp', { number })}
+                  label={t('storefront.sections.moveUp', { number })}
                   disabled={index === 0}
                   onClick={() => {
                     sections.swap(index, index - 1);
@@ -118,7 +118,7 @@ export function DescriptionCard({
                 />
                 <IconButton
                   icon={ArrowDown01Icon}
-                  label={t('storefront.listing.moveSectionDown', { number })}
+                  label={t('storefront.sections.moveDown', { number })}
                   disabled={index === sections.fields.length - 1}
                   onClick={() => {
                     sections.swap(index, index + 1);
@@ -126,23 +126,23 @@ export function DescriptionCard({
                 />
                 <IconButton
                   icon={Delete02Icon}
-                  label={t('storefront.listing.removeSection', { number })}
+                  label={t('storefront.sections.remove', { number })}
                   onClick={() => {
                     sections.remove(index);
                   }}
                 />
               </div>
               <TextField
-                label={t('storefront.listing.heading')}
+                label={t('storefront.sections.heading')}
                 placeholder={t('storefront.listing.headingPlaceholder')}
                 {...register(rowPath('descriptionSections', index, 'heading'))}
                 error={errors.descriptionSections?.[index]?.heading?.message}
               />
               <TextAreaField
-                label={t('storefront.listing.body')}
+                label={t('storefront.sections.body')}
                 placeholder={t('storefront.listing.bodyPlaceholder')}
                 rows={6}
-                hint={index === 0 ? t('storefront.listing.bodyHint') : undefined}
+                hint={index === 0 ? t('storefront.sections.bodyHint') : undefined}
                 {...register(rowPath('descriptionSections', index, 'body'))}
                 error={errors.descriptionSections?.[index]?.body?.message}
               />
@@ -165,8 +165,8 @@ export function DescriptionCard({
                     strokeWidth={1.5}
                   />
                   {shown
-                    ? t('storefront.listing.hidePreview')
-                    : t('storefront.listing.showPreview')}
+                    ? t('storefront.sections.hidePreview')
+                    : t('storefront.sections.showPreview')}
                 </Button>
               </div>
               {shown && <SectionPreview control={control} index={index} />}
@@ -183,7 +183,7 @@ export function DescriptionCard({
             }}
           >
             <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
-            {t('storefront.listing.addSection')}
+            {t('storefront.sections.add')}
           </Button>
         </div>
       </div>
```

Only the key names change (decision 33). The listing's own words (the title, the placeholders, the caption) are
still read here; 26h.6 makes them the caller's, so the pages editor can pass its own.

### A test that the Bangla keeps the placeholders: `locales.spec.ts`

The type check makes sure `bn.ts` has every key of `en.ts`, but not that a sentence keeps its `{{placeholders}}`. A
misspelt one (`{{maks}}` for `{{max}}`) type-checks, and every Bangla reader then sees "{{maks}}" on the screen.
Nothing in the package compared the two languages, so this part adds a test that does, for the app's words and the
shop's.

```ts
import { describe, expect, it } from 'vitest';

import { bn } from './bn.js';
import { en } from './en.js';
import { shopBn } from './shop/bn.js';
import { shopEn } from './shop/en.js';

// Step 26h.5: the type check makes sure bn.ts has every key of en.ts, but not that a sentence
// keeps its {{placeholders}}. A misspelt one ("{{maks}}" for "{{max}}") type-checks, and the
// screen then shows "{{maks}}" to every Bangla reader. These tests compare the two languages.

type Words = Readonly<Record<string, unknown>>;

// A block of keys, not a sentence (and not an array: the locales have none)
function isBlock(value: unknown): value is Words {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every string in a locale, by its dotted key ("storefront.home.count")
function strings(messages: Words, prefix = ''): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') found.set(path, value);
    else if (isBlock(value)) {
      for (const [inner, text] of strings(value, path)) found.set(inner, text);
    }
  }
  return found;
}

// The names inside {{ }}, sorted, each once. "{{- name}}" (not escaped) and "{{value, format}}"
// count as "name" and "value": the name is what the code passes, the rest is how it is shown.
// Once each: a sentence may use a name twice in one language and once in the other
function placeholders(text: string): string[] {
  const names = [...text.matchAll(/\{\{-?\s*([\w.]+)/g)].map((match) => match[1] ?? '');
  return [...new Set(names)].sort();
}

// The keys whose placeholders differ, as "key: en [a, b] / bn [a]"
function mismatches(english: Words, bangla: Words): string[] {
  const banglaStrings = strings(bangla);
  const wrong: string[] = [];
  for (const [key, text] of strings(english)) {
    const other = banglaStrings.get(key);
    // A key missing from bn.ts is the type check's job, not this test's
    if (other === undefined) continue;
    const a = placeholders(text);
    const b = placeholders(other);
    if (a.join(',') !== b.join(','))
      wrong.push(`${key}: en [${a.join(', ')}] / bn [${b.join(', ')}]`);
  }
  return wrong;
}

describe('placeholders', () => {
  it('finds each name once, with the unescaped and formatted forms', () => {
    expect(placeholders('{{count}} of {{max}} blocks')).toEqual(['count', 'max']);
    expect(placeholders('{{- name}} and {{ name }}')).toEqual(['name']);
    expect(placeholders('{{value, number}}')).toEqual(['value']);
    expect(placeholders('No placeholder')).toEqual([]);
  });
});

describe('the Bangla words keep the English placeholders', () => {
  it('in the app (en.ts, bn.ts)', () => {
    expect(mismatches(en, bn)).toEqual([]);
  });

  it('in the shop (shop/en.ts, shop/bn.ts)', () => {
    expect(mismatches(shopEn, shopBn)).toEqual([]);
  });

  it('notices a misspelt name', () => {
    expect(
      mismatches(
        { home: { count: '{{count}} of {{max}} blocks' } },
        { home: { count: '{{maks}}টার মধ্যে {{count}}টা ব্লক' } },
      ),
    ).toEqual(['home.count: en [count, max] / bn [count, maks]']);
  });
});
```

- **`strings()`** walks a locale and gives every sentence its dotted key, the same key `t()` takes. It reads the
  values as `unknown` and narrows them with `isBlock()`: `Object.entries()` on a plain `object` gives `any`, which
  the lint refuses (and CLAUDE.md rule 3).
- **`placeholders()`** keeps each name once, sorted. A Bangla sentence may put the words in another order, or use a
  name twice where English uses it once, and that is not a mistake. `{{- name}}` (not escaped) and
  `{{value, number}}` count as the name alone, because the name is what the code passes; the rest is how i18next
  shows it.
- **A key missing from `bn.ts` is skipped**: the type check already fails for it, and one failure is clearer than two.
- **The answer is a list of the wrong keys**, compared with `[]`, so a failure names every key at once ("home.count:
  en [count, max] / bn [count, maks]"), not only the first one.
- **The last test feeds it a known mistake**, so a change that makes `mismatches()` always answer `[]` fails too.

The file ends in `.spec.ts`, which `tsconfig.build.json` leaves out of `dist/`.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test                  # 21 tests, 4 of them new
pnpm --filter @omnivo/i18n build                 # the app reads the words from dist/
pnpm --filter @omnivo/app typecheck              # the section editor's new key names
pnpm --filter @omnivo/app test                   # 223 tests
pnpm exec eslint packages/i18n/src apps/app/src/components/storefront-sections.tsx
pnpm exec prettier --check packages/i18n/src apps/app/src/components/storefront-sections.tsx
```

Broken on purpose (and put back): a key missing from `bn.ts` fails the i18n type check; a misspelt placeholder
in `bn.ts` (`{{maks}}` for `{{max}}` in `storefront.appearance.home.count`) fails "in the app (en.ts, bn.ts)". Before
this part's test, nothing caught it. The whole app and shop pass it today: no key had a different placeholder.

## 26h.6 — The screens

The mockup came first, as a local HTML page and pictures (decision 9, CLAUDE.md rule 6): 16 screens, approved by the
user on 2026-11-17 as drawn. Five things in it were proposals, and all were taken: the hero has its own page
(`/storefront/appearance/hero`, not a dialog: four cards and a preview do not fit in 520px), the sidebar icons are
`PaintBoard` and `Files01` and the two items come before Shop settings, the "Logo and colors" card has its own Save
(no save bar), the hero page's cards are called "Words" and "Pictures", and a pages row opens on a click and also has
an Edit / Write link.

This part adds six pages, four shared pieces, one lib file and its test, and changes the listing's editor so the
text pages can use its section editor.

| Page | Address | What it does |
|---|---|---|
| Shop appearance | `/storefront/appearance` | Logo and colors (own form), the hero's picture, the home page's blocks |
| Hero banner | `/storefront/appearance/hero` | Makes or changes the hero, with a preview at both sizes |
| Collection | `/storefront/appearance/collections/$collectionId`, `…/new` | A title, the flame, up to 24 listings in order |
| Shop pages | `/storefront/pages` | The four footer pages, written or not |
| A page | `/storefront/pages/$slug` | One page's sections, in the listing's section editor |

A picture banner has no page: it is a dialog on the Appearance page (decision 2).

Ten decisions came up while writing the screens (mine; 45 is the user's):

37. **A collection's page is under `/storefront/appearance`** (`/storefront/appearance/collections/$collectionId`,
    and `…/new`), not `/storefront/collections/$id` as decision 2 said. The sidebar marks an item when the address
    starts with its link, so this keeps "Shop appearance" marked while a collection is open, like the hero's page.
    It is also the API's own path (`/storefront/appearance/collections/:id`).
38. **The section editor takes rows and inputs, not the form** (`SectionsCard`). The listing's list is
    `descriptionSections` and a page's is `sections`. A component generic over the form type would have to build
    `${name}.${index}.heading` paths that TypeScript cannot check, which means casts. Instead each page owns its
    `useFieldArray` and passes the rows, a `field(index, part)` that calls its own `register`, and an `error(index,
    part)`. Both callers are fully typed.
39. **An empty picture says "Upload a picture."**, chosen by the box, not by a new error code. Before an upload the
    picture's id is `''`, and the schema's answer for `''` is `invalid_format` (an id is a uuid). The box knows it
    is empty, so it shows the plain sentence; a real bad id (never seen in practice) still shows the error's own words.
40. **"Links to" keeps its own choice.** The form keeps only the address. "A shop category" with nothing picked yet
    has no address, and "Another address" may hold `/c/all` while it is typed; reading the choice back from the
    address would flip the select under the person's hands. So the choice is state in the picker, and it follows
    the address only when the form changes it from outside (Discard, a reset).
41. **The colors' preview shows the shop's own products**: the two listings in the shop that changed last (one small
    read), or two grey shapes when there are none. The shop's fixed colors (canvas, the price red, the muted grey)
    are copied into the preview's file as constants: the drawing is of the shop, and must look the same in the
    app's light and dark themes.
42. **The hero sends `''` for an empty line or tag.** The schema's output has `null` there (what the table keeps),
    but a request body is the schema's *input*, which takes `''` for "none". The page turns the `null` back.
43. **The product pickers have no photos.** The mockup drew a small photo in each match; `@omnivo/ui`'s `Combobox`
    has a label and a detail line only. The detail says "SKU · ৳229 · Draft", which is enough to tell two face
    washes apart, and the ui package stays as it is.
44. **The collection's "hidden" notice reads the form**, not the saved collection: it shows as soon as the list has
    products and none of them is in the shop, and goes as soon as one is. The API's own count (the Appearance
    page's line) also leaves out archived products, which the form cannot know; the two agree after a save.
45. **The initial JS budget is 245 KB** (the user's choice). It was 241.1 KB, over 240 KB even without this part's
    two sidebar items: 26h.5's words are in the first download. The six pages are lazy chunks (90.5–141.6 KB).
46. **A read in the background never resets a form being typed in.** The editors are keyed by what they edit (the
    hero's id, the page's slug, the collection's id), never by the version. A save's own answer resets the form
    with `reset()`; a refresh after it changes nothing on the screen.

### The reads and form values: `storefront-appearance.ts`

```ts
import {
  routes,
  STOREFRONT_HERO_DEFAULT_COLORS,
  type StorefrontBanner,
  type StorefrontBannerFormValues,
  type StorefrontCollection,
  type StorefrontHero,
  type StorefrontHeroFormValues,
  type StorefrontHomeBlock,
  type StorefrontPage,
  type StorefrontPageFormValues,
  type StorefrontTheme,
  type StorefrontThemeFormValues,
} from '@omnivo/contracts';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 26h: the reads and the form values of Shop appearance, a collection, and the text pages.
// Its own file, like storefront.ts: only these pages load it. The keys start with
// ['storefront', tenantId] like the rest of the menu, so useStorefrontRefresh() reads them again
// after any save (a collection's count on the Appearance page changes when a listing is published).

// ---------------------------------------------------------------------------------------------
// Reads

export function storefrontAppearanceQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'appearance'],
    queryFn: () => call(routes.storefrontAppearance.getAppearance),
  });
}

export function storefrontCollectionQuery(tenantId: string, id: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'collection', id],
    queryFn: () => call(routes.storefrontAppearance.getCollection, { params: { id } }),
  });
}

export function storefrontPagesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'pages'],
    queryFn: async () => (await call(routes.storefrontAppearance.listPages)).items,
  });
}

export function storefrontPageQuery(tenantId: string, slug: StorefrontPage['slug']) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'page', slug],
    queryFn: () => call(routes.storefrontAppearance.getPage, { params: { slug } }),
  });
}

// The product pickers (a collection's "Product to add", a link to a product): the catalog's own
// list, drafts too, 20 at a time, A to Z. The search also matches the slug (26g), which is how a
// saved "/p/<slug>" link finds its listing's name again
export function storefrontListingSearchQuery(tenantId: string, search: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'listing-search', search],
    queryFn: async () =>
      (
        await call(routes.storefront.listListings, {
          query: { limit: 20, sort: 'name', ...(search !== '' && { search }) },
        })
      ).items,
    // A new search keeps the old matches on screen until its answer comes: no flash of "Nothing"
    placeholderData: keepPreviousData,
  });
}

// The two product cards of the colors' preview: the shop's own listings that are in the shop,
// the last changed first. Two rows, so it costs nothing next to the page's own read
export function storefrontPreviewListingsQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'preview-listings'],
    queryFn: async () =>
      (
        await call(routes.storefront.listListings, {
          query: { limit: 2, status: 'published', sort: '-updated' },
        })
      ).items,
  });
}

// ---------------------------------------------------------------------------------------------
// Form values

export function themeFormValues(theme: StorefrontTheme): StorefrontThemeFormValues {
  return {
    version: theme.version,
    logoImageId: theme.logo?.id ?? null,
    brandColor: theme.brandColor,
    accentColor: theme.accentColor,
  };
}

// A picture box before anything is uploaded. The id stays '' until the upload has one; the schema
// then refuses it (an id is a uuid), and the box says "Upload a picture" (PictureField)
const NO_PICTURE = { id: '', alt: '' };

// A new hero starts from the Figma hero's colors (they pass both checks) and empty words.
// version null = "there is no hero yet" (decision 13)
export function heroFormValues(hero: StorefrontHero | null): StorefrontHeroFormValues {
  if (hero === null) {
    return {
      version: null,
      href: '',
      headline: '',
      line: '',
      eyebrow: '',
      buttonLabel: '',
      desktopImage: NO_PICTURE,
      phoneImage: NO_PICTURE,
      ...STOREFRONT_HERO_DEFAULT_COLORS,
    };
  }
  return {
    version: hero.version,
    href: hero.href,
    headline: hero.headline,
    // The API keeps "no line" as null; the box shows it empty, and '' goes back as null
    line: hero.line ?? '',
    eyebrow: hero.eyebrow ?? '',
    buttonLabel: hero.buttonLabel,
    desktopImage: { id: hero.desktopImage.id, alt: hero.desktopImage.alt },
    phoneImage: { id: hero.phoneImage.id, alt: hero.phoneImage.alt },
    backgroundColor: hero.backgroundColor,
    panelColor: hero.panelColor,
    buttonColor: hero.buttonColor,
    buttonTextColor: hero.buttonTextColor,
  };
}

export function bannerFormValues(banner: StorefrontBanner | null): StorefrontBannerFormValues {
  if (banner === null) return { href: '', desktopImage: NO_PICTURE, phoneImage: NO_PICTURE };
  return {
    href: banner.href,
    desktopImage: { id: banner.desktopImage.id, alt: banner.desktopImage.alt },
    phoneImage: { id: banner.phoneImage.id, alt: banner.phoneImage.alt },
  };
}

// The collection's form: the update schema's fields. A new one has no version; the create route
// never reads it (the page leaves it out), and 1 passes the update schema's check meanwhile
export interface CollectionFormValues {
  version: number;
  title: string;
  icon: 'fire' | null;
  listingIds: string[];
}

export function collectionFormValues(
  collection: StorefrontCollection | null,
): CollectionFormValues {
  if (collection === null) return { version: 1, title: '', icon: null, listingIds: [] };
  return {
    version: collection.version,
    title: collection.title,
    icon: collection.icon,
    listingIds: collection.listings.map((listing) => listing.id),
  };
}

export function pageFormValues(page: StorefrontPage): StorefrontPageFormValues {
  return { version: page.version, sections: page.sections };
}

// ---------------------------------------------------------------------------------------------
// The home page's blocks

// What a block is called in labels ("Move Hot & Trending Right Now up"). A banner has no title:
// it is named by the words of its computer picture (26h.5 decision 35)
export function homeBlockKey(block: StorefrontHomeBlock): string {
  return block.kind === 'banner'
    ? `banner-${block.banner.id}`
    : `collection-${block.collection.id}`;
}

export function homeBlockId(block: StorefrontHomeBlock): string {
  return block.kind === 'banner' ? block.banner.id : block.collection.id;
}

// Whether "Add picture banner" and "Add collection" can add one more (decision 6). The API
// checks again under its lock; the page only says why a button is disabled
export function homeRoom(
  blocks: readonly StorefrontHomeBlock[],
  limits: { banners: number; collections: number; blocks: number },
): { banner: 'ok' | 'banners' | 'blocks'; collection: 'ok' | 'collections' | 'blocks' } {
  const banners = blocks.filter((block) => block.kind === 'banner').length;
  const collections = blocks.length - banners;
  const full = blocks.length >= limits.blocks;
  return {
    banner: full ? 'blocks' : banners >= limits.banners ? 'banners' : 'ok',
    collection: full ? 'blocks' : collections >= limits.collections ? 'collections' : 'ok',
  };
}
```

- **Every key starts with `['storefront', tenantId]`**, like 26g's reads, so `useStorefrontRefresh()` reads the
  whole menu again after any save. That matters here: publishing a listing changes a collection's "6 of 8 in the
  shop" on the Appearance page, and only a shared prefix reaches it.
- **`storefrontListingSearchQuery`** is the catalog's own list (drafts too, A to Z, 20 at a time). The API's search
  also matches the slug (26g), and that is how the link picker finds a saved `/p/<slug>` link's product name again
  without a new route. `keepPreviousData` keeps the old matches on screen while a new search runs, so the list never
  flashes "No listing matches".
- **`storefrontPreviewListingsQuery`** asks for two rows only (decision 41).
- **`heroFormValues(null)`** starts from `STOREFRONT_HERO_DEFAULT_COLORS`, the Figma hero's colors, which pass both
  checks; a new hero then never starts with a red "Too low" line. `version: null` is decision 13's "there is no hero
  yet". A saved hero's `line` and `eyebrow` come back as `''`, because a text box cannot hold `null`.
- **`NO_PICTURE`** is `{ id: '', alt: '' }`: the schema refuses it (decision 39), so a save without pictures stops
  in the browser.
- **`CollectionFormValues`** is written out, not inferred: the form holds `version: 1` for a new collection so one
  resolver (the update schema) serves both; the page leaves the version out of the create request.
- **`homeRoom()`** says why an Add button is disabled. The block limit is named first: with 12 blocks, deleting a
  banner or a collection both help, so "the page has 12 blocks" is the useful sentence. The API checks again under
  its lock (26h.3); the page only explains.

```ts
import {
  saveStorefrontHeroInputSchema,
  STOREFRONT_HERO_DEFAULT_COLORS,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontHomeBlock,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { bannerFormValues, heroFormValues, homeRoom } from './storefront-appearance';

const IMAGE = {
  id: '0199a3f0-0000-7000-8000-000000000001',
  alt: 'Make-up',
  url: 'https://f/x.webp',
};
const NOW = '2026-11-17T04:00:00.000Z';

const banner = (n: number): StorefrontHomeBlock => ({
  kind: 'banner',
  banner: {
    id: `0199a3f0-0000-7000-8000-00000000010${String(n)}`,
    href: '/c/all',
    desktopImage: IMAGE,
    phoneImage: IMAGE,
    version: 1,
    updatedAt: NOW,
  } satisfies StorefrontBanner,
});
const collection = (n: number): StorefrontHomeBlock => ({
  kind: 'collection',
  collection: {
    id: `0199a3f0-0000-7000-8000-00000000020${String(n)}`,
    title: `Row ${String(n)}`,
    icon: null,
    listingCount: 3,
    publishedCount: 3,
    version: 1,
    updatedAt: NOW,
  } satisfies StorefrontCollectionSummary,
});
const LIMITS = { banners: 2, collections: 2, blocks: 3 };

describe('heroFormValues', () => {
  it('starts a new hero from the Figma colors, with no version (decision 13)', () => {
    const values = heroFormValues(null);
    expect(values.version).toBeNull();
    expect(values).toMatchObject(STOREFRONT_HERO_DEFAULT_COLORS);
    // Empty pictures: the schema refuses them, the box then says "Upload a picture"
    expect(saveStorefrontHeroInputSchema.safeParse(values).success).toBe(false);
  });

  it("puts a saved hero's null line and tag back as empty boxes", () => {
    const hero: StorefrontHero = {
      id: '0199a3f0-0000-7000-8000-000000000301',
      href: '/c/cosmetics',
      headline: 'Get 10% cash-back',
      line: null,
      eyebrow: null,
      buttonLabel: 'Shop now',
      desktopImage: IMAGE,
      phoneImage: IMAGE,
      ...STOREFRONT_HERO_DEFAULT_COLORS,
      version: 4,
      updatedAt: NOW,
    };
    const values = heroFormValues(hero);
    expect(values).toMatchObject({ line: '', eyebrow: '', version: 4 });
    // The picture's address stays out of the form: the API takes {id, alt}
    expect(values.desktopImage).toEqual({ id: IMAGE.id, alt: IMAGE.alt });
    expect(saveStorefrontHeroInputSchema.safeParse(values).success).toBe(true);
  });
});

describe('bannerFormValues', () => {
  it('has empty pictures for a new banner', () => {
    expect(bannerFormValues(null)).toEqual({
      href: '',
      desktopImage: { id: '', alt: '' },
      phoneImage: { id: '', alt: '' },
    });
  });
});

describe('homeRoom', () => {
  it('lets both kinds in while there is room', () => {
    expect(homeRoom([banner(1)], LIMITS)).toEqual({ banner: 'ok', collection: 'ok' });
  });

  it('stops one kind at its own limit', () => {
    expect(homeRoom([banner(1), banner(2)], LIMITS)).toEqual({
      banner: 'banners',
      collection: 'ok',
    });
    expect(homeRoom([collection(1), collection(2)], LIMITS)).toEqual({
      banner: 'ok',
      collection: 'collections',
    });
  });

  it('names the block limit first: it is the one to fix', () => {
    expect(homeRoom([banner(1), banner(2), collection(1)], LIMITS)).toEqual({
      banner: 'blocks',
      collection: 'blocks',
    });
  });
});
```

Three things the screens rely on: a new hero's form does not pass the schema (no pictures), a saved hero's form does
(so a person who changes nothing can still save), and the order of `homeRoom()`'s answers.

### The section editor, shared: `storefront-sections.tsx`

```diff
@@ -7,11 +7,7 @@ import {
   ViewOffSlashIcon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import {
-  renderSections,
-  STOREFRONT_SECTIONS_MAX,
-  type UpdateStorefrontListingInput,
-} from '@omnivo/contracts';
+import { renderSections, STOREFRONT_SECTIONS_MAX } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
   Button,
@@ -23,36 +19,29 @@ import {
   TextField,
 } from '@omnivo/ui';
 import { useState } from 'react';
-import {
-  type Control,
-  type FieldErrors,
-  useFieldArray,
-  type UseFormRegister,
-  useWatch,
-} from 'react-hook-form';
-
-import { rowPath } from '../lib/products';
-import type { ListingFormValues } from '../lib/storefront';
+import type { UseFormRegisterReturn } from 'react-hook-form';
 
 // Step 26g: the description, as sections of a heading and a text box (26f decision 6: the tenant
 // never writes HTML). Each section has a preview made by the same renderSections the API uses, so
 // what the box shows is what the product page will show, list markers and bold included.
-
-type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;
+//
+// Step 26h: the text pages use the same editor (decision 5), so it no longer knows the listing's
+// form. The page that owns the form passes the rows, the inputs and the errors; the words that
+// differ (title, placeholders, the empty line, the preview's caption) are props too (decision 33).
 
 // The product page's prose, at the app's sizes: headings like a card title, lists with markers
 const PROSE =
   'grid gap-2 text-body-sm text-ink-2 [&_a]:font-medium [&_a]:text-brand [&_a]:underline [&_h2]:text-h3 [&_h2]:text-ink [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5';
 
-function SectionPreview({ control, index }: { control: ListingControl; index: number }) {
-  const { t } = useLocale();
-  const [heading, body] = useWatch({
-    control,
-    name: [
-      rowPath('descriptionSections', index, 'heading'),
-      rowPath('descriptionSections', index, 'body'),
-    ],
-  });
+function SectionPreview({
+  heading,
+  body,
+  caption,
+}: {
+  heading: string;
+  body: string;
+  caption: string;
+}) {
   // renderSections escapes every character the person typed before it adds its own few tags
   // (26f: the same function writes the shop's HTML), so this HTML carries no markup of theirs
   const html = renderSections([{ heading: heading.trim(), body: body.trim() }]);
@@ -60,46 +49,72 @@ function SectionPreview({ control, index }: { control: ListingControl; index: nu
     <div className="overflow-hidden rounded-control border border-line">
       <p className="flex items-center gap-1.5 bg-subtle px-3.5 py-2 text-caption text-ink-3">
         <HugeiconsIcon icon={ViewIcon} size={14} strokeWidth={1.5} />
-        {t('storefront.listing.previewCaption')}
+        {caption}
       </p>
       <div className={`px-5 py-4 ${PROSE}`} dangerouslySetInnerHTML={{ __html: html }} />
     </div>
   );
 }
 
-export function DescriptionCard({
-  control,
-  register,
-  errors,
-}: {
-  control: ListingControl;
-  register: UseFormRegister<ListingFormValues>;
-  errors: FieldErrors<ListingFormValues>;
-}) {
+export interface SectionRow {
+  // The field array's own key (useFieldArray's `id`): it survives a move, an index does not
+  key: string;
+  // What the boxes hold now (useWatch), for the preview
+  heading: string;
+  body: string;
+}
+
+export interface SectionsCardProps {
+  title: string;
+  subtitle: string;
+  headingPlaceholder: string;
+  bodyPlaceholder: string;
+  // Shown while there is no section
+  emptyText: string;
+  previewCaption: string;
+  rows: readonly SectionRow[];
+  // register() of the row's box. The page builds the path, so its form type stays its own: the
+  // listing's list is `descriptionSections`, a text page's is `sections`
+  field: (index: number, part: 'heading' | 'body') => UseFormRegisterReturn;
+  error: (index: number, part: 'heading' | 'body') => string | undefined;
+  // An error about the list itself (too many sections, a page with none)
+  listError: string | undefined;
+  onAdd: () => void;
+  onRemove: (index: number) => void;
+  onSwap: (from: number, to: number) => void;
+}
+
+export function SectionsCard({
+  title,
+  subtitle,
+  headingPlaceholder,
+  bodyPlaceholder,
+  emptyText,
+  previewCaption,
+  rows,
+  field,
+  error,
+  listError,
+  onAdd,
+  onRemove,
+  onSwap,
+}: SectionsCardProps) {
   const { t } = useLocale();
-  const sections = useFieldArray({ control, name: 'descriptionSections' });
-  // Which sections show their preview, by the field array's own key (it survives a move)
+  // Which sections show their preview, by the row's key
   const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());
-  const listError =
-    errors.descriptionSections?.root?.message ?? errors.descriptionSections?.message;
 
   return (
     <Card>
-      <CardHeader
-        title={t('storefront.listing.descriptionTitle')}
-        subtitle={t('storefront.listing.descriptionHint')}
-      />
+      <CardHeader title={title} subtitle={subtitle} />
       <div className="grid gap-4 p-5">
         {listError !== undefined && <FormAlert message={listError} />}
-        {sections.fields.length === 0 && (
-          <p className="text-body-sm text-ink-2">{t('storefront.listing.noSections')}</p>
-        )}
-        {sections.fields.map((section, index) => {
+        {rows.length === 0 && <p className="text-body-sm text-ink-2">{emptyText}</p>}
+        {rows.map((row, index) => {
           const number = index + 1;
-          const shown = previews.has(section.id);
+          const shown = previews.has(row.key);
           return (
             <div
-              key={section.id}
+              key={row.key}
               role="group"
               aria-label={t('storefront.sections.number', { number })}
               className="grid gap-4 rounded-control border border-line p-4"
@@ -113,38 +128,38 @@ export function DescriptionCard({
                   label={t('storefront.sections.moveUp', { number })}
                   disabled={index === 0}
                   onClick={() => {
-                    sections.swap(index, index - 1);
+                    onSwap(index, index - 1);
                   }}
                 />
                 <IconButton
                   icon={ArrowDown01Icon}
                   label={t('storefront.sections.moveDown', { number })}
-                  disabled={index === sections.fields.length - 1}
+                  disabled={index === rows.length - 1}
                   onClick={() => {
-                    sections.swap(index, index + 1);
+                    onSwap(index, index + 1);
                   }}
                 />
                 <IconButton
                   icon={Delete02Icon}
                   label={t('storefront.sections.remove', { number })}
                   onClick={() => {
-                    sections.remove(index);
+                    onRemove(index);
                   }}
                 />
               </div>
               <TextField
                 label={t('storefront.sections.heading')}
-                placeholder={t('storefront.listing.headingPlaceholder')}
-                {...register(rowPath('descriptionSections', index, 'heading'))}
-                error={errors.descriptionSections?.[index]?.heading?.message}
+                placeholder={headingPlaceholder}
+                {...field(index, 'heading')}
+                error={error(index, 'heading')}
               />
               <TextAreaField
                 label={t('storefront.sections.body')}
-                placeholder={t('storefront.listing.bodyPlaceholder')}
+                placeholder={bodyPlaceholder}
                 rows={6}
                 hint={index === 0 ? t('storefront.sections.bodyHint') : undefined}
-                {...register(rowPath('descriptionSections', index, 'body'))}
-                error={errors.descriptionSections?.[index]?.body?.message}
+                {...field(index, 'body')}
+                error={error(index, 'body')}
               />
               <div>
                 <Button
@@ -154,7 +169,7 @@ export function DescriptionCard({
                   onClick={() => {
                     setPreviews((current) => {
                       const next = new Set(current);
-                      if (!next.delete(section.id)) next.add(section.id);
+                      if (!next.delete(row.key)) next.add(row.key);
                       return next;
                     });
                   }}
@@ -169,7 +184,9 @@ export function DescriptionCard({
                     : t('storefront.sections.showPreview')}
                 </Button>
               </div>
-              {shown && <SectionPreview control={control} index={index} />}
+              {shown && (
+                <SectionPreview heading={row.heading} body={row.body} caption={previewCaption} />
+              )}
             </div>
           );
         })}
@@ -177,10 +194,8 @@ export function DescriptionCard({
           <Button
             variant="secondary"
             size="sm"
-            disabled={sections.fields.length >= STOREFRONT_SECTIONS_MAX}
-            onClick={() => {
-              sections.append({ heading: '', body: '' });
-            }}
+            disabled={rows.length >= STOREFRONT_SECTIONS_MAX}
+            onClick={onAdd}
           >
             <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
             {t('storefront.sections.add')}
```

- **The component knows no form** (decision 38). `rows` carries each row's `key` (the field array's `id`, which
  survives a move; an index would show the wrong preview open after Move up) and the two values the preview needs.
- **The preview is fed the row's values**, not a `useWatch` of its own. The page already watches the list to build
  `rows`, so a second subscription per row would only repeat it.
- **The words that differ are props**: the title, the placeholders, the empty line and the preview's caption. The
  words that are the same everywhere (Section 1, Heading, Text, the move and remove labels) stay inside.

### The listing uses it: `storefront-listing.tsx`

```diff
@@ -48,11 +48,11 @@ import {
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link, useNavigate, useParams } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
-import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
+import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 
 import { DocumentNotice } from '../components/document-notice';
 import { PhotosCard } from '../components/storefront-photos';
-import { DescriptionCard } from '../components/storefront-sections';
+import { SectionsCard } from '../components/storefront-sections';
 import {
   ListingStatusPill,
   SaveBar,
@@ -63,6 +63,7 @@ import {
 } from '../components/storefront-parts';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
+import { rowPath } from '../lib/products';
 import { warehousesQuery } from '../lib/queries';
 import {
   listingFormSchema,
@@ -289,6 +290,8 @@ function ListingEditor({ listing }: { listing: StorefrontListing }) {
     },
   });
 
+  // The description's sections: the shared editor gets the rows and the boxes (decision 33)
+  const sectionArray = useFieldArray({ control, name: 'descriptionSections' });
   const images = watch('images');
   const saleKind = watch('sale.kind');
   const name = watch('name');
@@ -580,7 +583,29 @@ function ListingEditor({ listing }: { listing: StorefrontListing }) {
             </div>
           </Card>
 
-          <DescriptionCard control={control} register={register} errors={errors} />
+          <SectionsCard
+            title={t('storefront.listing.descriptionTitle')}
+            subtitle={t('storefront.listing.descriptionHint')}
+            headingPlaceholder={t('storefront.listing.headingPlaceholder')}
+            bodyPlaceholder={t('storefront.listing.bodyPlaceholder')}
+            emptyText={t('storefront.listing.noSections')}
+            previewCaption={t('storefront.listing.previewCaption')}
+            rows={sectionArray.fields.map((field, index) => ({
+              key: field.id,
+              heading: sections[index]?.heading ?? '',
+              body: sections[index]?.body ?? '',
+            }))}
+            field={(index, part) => register(rowPath('descriptionSections', index, part))}
+            error={(index, part) => errors.descriptionSections?.[index]?.[part]?.message}
+            listError={
+              errors.descriptionSections?.root?.message ?? errors.descriptionSections?.message
+            }
+            onAdd={() => {
+              sectionArray.append({ heading: '', body: '' });
+            }}
+            onRemove={sectionArray.remove}
+            onSwap={sectionArray.swap}
+          />
 
           <Card>
             <CardHeader
```

The listing now owns the `useFieldArray` that `DescriptionCard` had. `sections` was already watched for the search
engines' placeholder, so the rows come from it at no cost. `rowPath()` (from `lib/products`) builds the typed path
`descriptionSections.${number}.heading`, the same helper the photos use.

### Small changes to 26g's pieces: `storefront-photos.tsx`, `storefront-parts.tsx`

```diff
@@ -46,8 +46,9 @@ import { useTenantId } from '../lib/workspace';
 type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;
 
 // One photo the server is still working on: asks every 2 seconds until the job has finished, then
-// hands the answer to the page. A query per slot, so a photo that is ready stops asking
-function useJobState(
+// hands the answer to the page. A query per slot, so a photo that is ready stops asking.
+// Step 26h: exported, the logo and the banners' pictures use it too (storefront-picture.tsx)
+export function useJobState(
   id: string,
   state: PhotoState,
   onState: (id: string, next: PhotoState) => void,
```

`useJobState` is exported: the logo and the banners' pictures wait for the same image job as a listing's photo.

```diff
@@ -4,6 +4,7 @@ import {
   Clock01Icon,
   FileEditIcon,
   LinkSquare02Icon,
+  MinusSignCircleIcon,
   Store04Icon,
   WifiDisconnected02Icon,
 } from '@hugeicons/core-free-icons';
@@ -43,9 +44,13 @@ export function ShopLine() {
 }
 
 // The shop in a new tab. A link that looks like the secondary button: it goes to another site, so
-// it is an <a> (middle-click, "copy link"), never a button with window.open
-const LINK_BUTTON =
+// it is an <a> (middle-click, "copy link"), never a button with window.open.
+// Step 26h: exported, with a small one, for the router's links that look like buttons ("Edit hero
+// banner", "Add collection"): they go to another page, so they are links too
+export const LINK_BUTTON =
   'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 text-body-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
+export const LINK_BUTTON_SM =
+  'inline-flex min-h-9 items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-3 text-body-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';
 
 export function ViewShopLink({
   href,
@@ -78,6 +83,20 @@ export function ListingStatusPill({ status }: { status: StorefrontListingStatus
   );
 }
 
+// Step 26h: a text page in the footer or not (Shop pages and the page's editor)
+export function PageStatusPill({ written }: { written: boolean }) {
+  const { t } = useLocale();
+  return written ? (
+    <Pill tone="good" icon={CheckmarkCircle02Icon}>
+      {t('storefront.pages.written')}
+    </Pill>
+  ) : (
+    <Pill tone="neutral" icon={MinusSignCircleIcon}>
+      {t('storefront.pages.notWritten')}
+    </Pill>
+  );
+}
+
 // null: the shop has no warehouse yet, so nobody knows
 export function StockPill({ inStock }: { inStock: boolean | null }) {
   const { t } = useLocale();
```

- **`LINK_BUTTON` is exported, with a small one.** "Edit hero banner" and "Add collection" go to another page, so they
  are router links (middle-click opens a tab, the address shows on hover), not buttons that call `navigate()`. They
  need the secondary button's look, and `Button` has no `asChild`.
- **`PageStatusPill`** is here because two pages show it (the list and the editor), and one route file importing
  another would put the list's code into the editor's chunk.

### One picture: `storefront-picture.tsx`

```tsx
import {
  Alert02Icon,
  Delete02Icon,
  Image01Icon,
  ImageAdd01Icon,
  ImageUploadIcon,
  Loading03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ATTACHMENT_RULES, type ErrorCode } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, TextField } from '@omnivo/ui';
import { type ChangeEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import { ApiRequestError } from '../lib/api';
import { checkPhotoFile, type PhotoState, uploadShopPhoto } from '../lib/storefront';
import { useJobState } from './storefront-photos';

// Step 26h: one picture of the logo, the hero or a picture banner (26h.5 decision 34: a banner has
// "pictures", a listing "photos"). The same upload as a listing's photo (26g: the upload address,
// the file straight to storage, "complete", then the image job), one file at a time. The form
// keeps the picture's id; the page keeps its state beside it, like the listing's photos, so Save
// can wait until every picture is ready (the API refuses one that is not).

// The hidden file input and what choosing a file does. `onPicked` gets the new picture's id as
// soon as there is one, so the box says "Uploading…" while the file travels
export function usePictureUpload({
  onPicked,
  onState,
}: {
  onPicked: (id: string) => void;
  onState: (id: string, next: PhotoState) => void;
}): { open: () => void; failure: ErrorCode | null; fileInput: ReactNode } {
  const input = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<ErrorCode | null>(null);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so choosing the same file again (after a failure) is a change again
    event.target.value = '';
    setFailure(null);
    if (file === undefined) return;
    // The storefront_image rule before anything is sent: a 30 MB file never starts uploading
    const problem = checkPhotoFile(file);
    if (problem !== null) {
      setFailure(problem);
      return;
    }
    uploadShopPhoto(file, (id) => {
      onState(id, { status: 'uploading' });
      onPicked(id);
    })
      .then(({ id, state }) => {
        onState(id, state);
      })
      .catch((error: unknown) => {
        setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
      });
  };

  return {
    open: () => input.current?.click(),
    failure,
    fileInput: (
      <input
        ref={input}
        type="file"
        // Only the kinds the server takes; it checks the bytes again (26g.3)
        accept={ATTACHMENT_RULES.storefront_image.contentTypes.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={choose}
      />
    ),
  };
}

// An error under a picture, in the look of a field's error
export function PictureError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
      {children}
    </p>
  );
}

// What the box shows while the server works, or why it failed
function PictureState({ state }: { state: PhotoState }) {
  const { t, errorText } = useLocale();
  if (state.status === 'failed') {
    return (
      <span className="grid justify-items-center gap-2 px-4 text-center text-label text-crit">
        <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.5} />
        {errorText(state.code)}
      </span>
    );
  }
  return (
    <span role="status" className="grid justify-items-center gap-2 text-body-sm text-ink-2">
      <HugeiconsIcon
        icon={state.status === 'uploading' ? Image01Icon : Loading03Icon}
        size={22}
        strokeWidth={1.5}
        className={state.status === 'processing' ? 'motion-safe:animate-spin' : undefined}
      />
      {state.status === 'uploading'
        ? t('storefront.picture.uploading')
        : t('storefront.picture.preparing')}
    </span>
  );
}

export interface PictureFieldProps {
  label: string;
  hint: string;
  // The picture's shape in the shop, as a whole Tailwind class written out by the caller
  // ("aspect-[1280/280]"): Tailwind finds only class names it can read in the source
  aspectClass: string;
  // A photo that fills its box (the phone hero, cut to fit) or one shown whole (a banner, whose
  // words are in the picture and must never be cut)
  cover?: boolean;
  // The picture's id in the form, '' = none
  value: string;
  state: PhotoState | undefined;
  onPicked: (id: string) => void;
  onState: (id: string, next: PhotoState) => void;
  // The alt text box: register() of `<picture>.alt`
  alt: UseFormRegisterReturn;
  altPlaceholder: string;
  altHint?: string | undefined;
  altError?: string | undefined;
  // The schema's error on `<picture>.id`: with no picture it means "upload one"
  idError?: string | undefined;
}

export function PictureField({
  label,
  hint,
  aspectClass,
  cover = false,
  value,
  state,
  onPicked,
  onState,
  alt,
  altPlaceholder,
  altHint,
  altError,
  idError,
}: PictureFieldProps) {
  const { t, errorText } = useLocale();
  const labelId = useId();
  const upload = usePictureUpload({ onPicked, onState });
  // The polling stops by itself for a picture that is ready (or for no picture)
  useJobState(value, state ?? { status: 'ready', url: '' }, onState);
  const empty = value === '';

  return (
    <div role="group" aria-labelledby={labelId} className="grid content-start gap-1.5">
      <span id={labelId} className="text-label font-medium text-ink">
        {label}
      </span>
      <div className="grid gap-3 rounded-control border border-line p-3">
        {empty ? (
          <button
            type="button"
            onClick={upload.open}
            className={cn(
              'grid max-h-45 w-full place-items-center content-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle',
              aspectClass,
            )}
          >
            <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
              <HugeiconsIcon icon={ImageAdd01Icon} size={20} strokeWidth={1.5} />
            </span>
            {t('storefront.picture.upload')}
          </button>
        ) : (
          <>
            <div
              className={cn(
                'relative grid max-h-45 w-full place-items-center overflow-hidden rounded-lg bg-subtle',
                aspectClass,
              )}
            >
              {state?.status === 'ready' ? (
                <img
                  src={state.url}
                  alt=""
                  className={cn('size-full', cover ? 'object-cover' : 'object-contain')}
                />
              ) : (
                <PictureState state={state ?? { status: 'processing' }} />
              )}
            </div>
            {state?.status === 'failed' ? (
              <button
                type="button"
                onClick={() => {
                  onPicked('');
                }}
                className="justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
              >
                {t('storefront.picture.drop')}
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={upload.open}>
                  <HugeiconsIcon icon={ImageUploadIcon} size={17} strokeWidth={1.5} />
                  {t('storefront.picture.replace')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onPicked('');
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                  {t('storefront.picture.remove')}
                </Button>
              </div>
            )}
          </>
        )}
        <TextField
          label={t('storefront.picture.alt')}
          placeholder={altPlaceholder}
          hint={altHint}
          {...alt}
          error={altError}
        />
      </div>
      {upload.failure !== null ? (
        <PictureError>{errorText(upload.failure)}</PictureError>
      ) : idError !== undefined ? (
        <PictureError>{empty ? t('storefront.picture.missing') : errorText(idError)}</PictureError>
      ) : (
        <p className="text-label text-ink-3">{hint}</p>
      )}
      {upload.fileInput}
    </div>
  );
}
```

- **`usePictureUpload()`** is the listing's upload (26g) for one file: it checks the file against the
  `storefront_image` rule before anything is sent, gives the page the new id as soon as there is one (so the box
  says "Uploading…"), and the state after the upload. It returns the hidden `<input type="file">` as an element,
  so each caller puts it inside its own group.
- **`event.target.value = ''`** lets the same file be chosen again after a failure; without it the browser sees no
  change and nothing happens.
- **`useJobState(value, state ?? ready)`**: a query that polls only while the picture is `processing`. With no
  picture, or a ready one, the query is disabled, so a page with four ready pictures makes no requests.
- **`aspectClass` is a whole class name** from the caller (`"aspect-[1280/280]"`). Tailwind writes only the classes
  it finds written out in the source; a class built from a prop at run time (`aspect-[${w}/${h}]`) would have no CSS.
- **`max-h-45`** (180px) keeps a tall picture (the hero's 1200 × 700) from pushing the alt box off the screen.
- **`object-contain` by default, `cover` for the phone hero**: a picture banner has its words in it and must never be
  cut, while the phone hero is a photo the shop crops to fill (`object-cover` in `HeroBanner.astro`).
- **"Remove it" on a failed picture** empties the box instead of showing Replace / Remove: the failed picture is
  useless, and Upload is the next step.
- **The error line** shows, in order: a file that was refused before upload, then the schema's error on the id
  ("Upload a picture." when the box is empty, decision 39), else the hint. One line, so the box never grows two
  red lines at once.

### A color box and its contrast: `storefront-color.tsx`

```tsx
import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { contrastRatio, formatContrast } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { controlBoxClass, Pill } from '@omnivo/ui';
import type { Ref } from 'react';

// Step 26h: a color box and the contrast lines under it (decisions 3 and 11). The box is a swatch
// that opens the browser's own palette (<input type="color">) and the code beside it, which can be
// typed or pasted ("#005859"). Both edit the same form value, so the schema checks one string.

const HEX = /^#[0-9a-f]{6}$/i;

// What FormField hands its child (id, value, onChange, the error state), for a string value
export interface ColorInputProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  ref?: Ref<HTMLInputElement>;
  invalid: boolean;
  'aria-describedby': string | undefined;
  // The box's label, for the swatch's own name: "Pick Brand color on a palette"
  label: string;
}

export function ColorInput({
  id,
  name,
  value,
  onChange,
  onBlur,
  ref,
  invalid,
  'aria-describedby': describedBy,
  label,
}: ColorInputProps) {
  const { t } = useLocale();
  // The palette takes only a whole color: while the code is half typed ("#00585") the palette
  // opens on black, and the swatch is empty until the code is whole again
  const whole = HEX.test(value);
  return (
    <div className={controlBoxClass(invalid)}>
      <span className="relative -ml-1 size-6.5 shrink-0 overflow-hidden rounded-lg border border-line-strong">
        {/* The swatch's color is the tenant's own value, which no token can name */}
        <span className="absolute inset-0" style={whole ? { background: value } : undefined} />
        <input
          type="color"
          aria-label={t('storefront.color.palette', { name: label })}
          value={whole ? value.toLowerCase() : '#000000'}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        ref={ref}
        id={id}
        name={name}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onBlur={onBlur}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        maxLength={7}
        className="min-w-0 flex-1 bg-transparent py-2.5 font-mono text-body outline-none"
      />
    </div>
  );
}

export interface ContrastLine {
  label: string;
  // The two colors the line compares, as the boxes hold them now
  first: string;
  second: string;
  // CONTRAST_TEXT (4.5) or CONTRAST_LARGE_TEXT (3)
  min: number;
}

// The checks as the person types: the ratio, the minimum and a pill. The API runs the same
// contrastRatio on save, so a line that says "Easy to read" never meets a refusal
export function ContrastList({ lines }: { lines: readonly ContrastLine[] }) {
  const { t } = useLocale();
  return (
    <ul className="rounded-control border border-line">
      {lines.map((line) => {
        const whole = HEX.test(line.first) && HEX.test(line.second);
        const ratio = whole ? contrastRatio(line.first, line.second) : null;
        return (
          <li
            key={line.label}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3.5 py-2.5 first:border-t-0"
          >
            <span className="mr-auto text-body-sm text-ink-2">{line.label}</span>
            {ratio !== null && (
              <>
                <span className="text-caption font-normal text-ink-3 tabular-nums">
                  {t('storefront.color.ratio', {
                    ratio: formatContrast(ratio),
                    min: `${String(line.min)}:1`,
                  })}
                </span>
                {ratio >= line.min ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('storefront.color.ok')}
                  </Pill>
                ) : (
                  <Pill tone="crit" icon={Alert02Icon}>
                    {t('storefront.color.low')}
                  </Pill>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
```

- **Two inputs, one value.** The swatch is a real `<input type="color">` laid over a colored square at zero opacity:
  the browser's own palette opens on click, and it has its own accessible name ("Pick Brand color on a palette").
  The code box beside it can be typed or pasted. Both call the same `onChange`, so the schema checks one string.
- **The palette gets `#000000` while the code is half typed.** `<input type="color">` accepts only a whole
  `#rrggbb`; given `#00585` it would warn in the console and show black anyway.
- **The swatch's color is an inline style**: it is the tenant's value, which no token can name. CLAUDE.md's "only
  tokens" is about the app's own colors.
- **`ContrastList` uses the contracts' `contrastRatio()` and `formatContrast()`**, the same code the API runs on save
  (decision 11), so a line that says "Easy to read" never meets a refusal. A line whose colors are not whole yet
  shows its label only: a ratio of half a color would be noise.
- **The ratio is cut, not rounded** (`formatContrast`, 26h.1): 4.47 shows "4.4:1, needs 4.5:1" next to "Too low",
  never "4.5:1" next to "Too low".

### "Links to": `storefront-link.tsx`

```tsx
import {
  Alert02Icon,
  FolderLibraryIcon,
  Link01Icon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  STOREFRONT_LINK_KINDS,
  type StorefrontLinkKind,
  storefrontLinkHref,
  storefrontLinkTarget,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Combobox, type ComboboxOption, Field, SelectField, TextField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type RefCallback, useMemo, useState } from 'react';

import { storefrontListingSearchQuery } from '../lib/storefront-appearance';
import { storefrontCategoriesQuery } from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useTenantId } from '../lib/workspace';
import { useShopMoney } from './storefront-parts';

// Step 26h: "Links to" (decision 4). The table keeps one address (`href`); the picker turns a
// choice into it (storefrontLinkHref) and an address back into a choice (storefrontLinkTarget), so
// a banner a script made still opens here. A category or a product is picked by its slug, the part
// of the address the shop reads.

export interface LinkPickerProps {
  // The form's `href` and its setter (a Controller's field)
  value: string;
  onChange: (href: string) => void;
  error: string | undefined;
  // The Controller's field.ref: react-hook-form focuses the box it is on after a refused save.
  // A callback, so the select, the text box and the product button can each take it
  ref?: RefCallback<HTMLElement>;
}

// The product box: the catalog's search, and the saved product's name found by its slug
function ListingBox({
  slug,
  onChange,
  invalid,
  describedBy,
}: {
  slug: string;
  onChange: (slug: string) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const matches = useQuery(storefrontListingSearchQuery(tenantId, settled));
  // The saved link's listing: the search matches the slug too, and only an exact slug counts
  const saved = useQuery({
    ...storefrontListingSearchQuery(tenantId, slug),
    enabled: slug !== '',
  });
  const listing = slug === '' ? undefined : saved.data?.find((item) => item.slug === slug);

  const options = useMemo<ComboboxOption[]>(
    () =>
      (matches.data ?? []).map((item) => ({
        value: item.slug,
        label: item.name,
        detail: [
          item.sku,
          item.price === null ? null : money(item.price),
          item.status === 'draft' ? t('storefront.statuses.draft') : null,
        ]
          .filter((part) => part !== null)
          .join(' · '),
      })),
    [matches.data, money, t],
  );

  return (
    <>
      <Combobox
        id="link-listing"
        value={slug}
        // Until the saved listing's name comes back, the slug stands in for it
        selectedLabel={slug === '' ? null : (listing?.name ?? slug)}
        options={options}
        search={search}
        onSearchChange={setSearch}
        onChange={(value) => {
          onChange(value);
        }}
        loading={matches.isFetching}
        icon={Store04Icon}
        invalid={invalid}
        aria-describedby={describedBy}
        placeholder={t('storefront.link.listingPlaceholder')}
        searchPlaceholder={t('storefront.link.searchLabel')}
        emptyText={t('storefront.link.noMatch')}
      />
      {slug !== '' && saved.isSuccess && listing === undefined && <GoneLine />}
      {listing?.status === 'draft' && (
        <p className="text-label text-ink-3">{t('storefront.link.draft')}</p>
      )}
    </>
  );
}

function GoneLine() {
  const { t } = useLocale();
  return (
    <p className="flex items-start gap-1.5 text-label text-warn">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {t('storefront.link.gone')}
    </p>
  );
}

export function LinkPicker({ value, onChange, error, ref }: LinkPickerProps) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const target = storefrontLinkTarget(value);
  // The select's choice. Mostly what the address says; but "A shop category" with nothing picked
  // yet has no address, and "Another address" may hold "/c/all" while it is typed, so the choice
  // is kept here. It follows the address only when the form changes it (Discard, a reset): an
  // address this picker did not send. Adjusted while rendering, React's way for state that
  // follows a prop (no effect, so no second paint with the old choice)
  const [kind, setKind] = useState<StorefrontLinkKind>(value === '' ? 'category' : target.kind);
  const [sent, setSent] = useState(value);
  if (value !== sent) {
    setSent(value);
    if (value !== '') setKind(target.kind);
  }

  const send = (href: string) => {
    setSent(href);
    onChange(href);
  };

  const pick = (next: StorefrontLinkKind) => {
    setKind(next);
    // Offers and All products are one address each; the others wait for the second box
    if (next === 'offers' || next === 'all') send(storefrontLinkHref({ kind: next }));
    else if (next === 'other') send(target.kind === 'other' ? value : '');
    else send('');
  };

  const slug =
    (kind === 'category' || kind === 'listing') && target.kind === kind ? target.slug : '';
  const categoryOptions = useMemo(
    () => [
      { value: '', label: t('storefront.link.categoryPlaceholder') },
      ...(categories ?? []).map((category) => ({ value: category.slug, label: category.name })),
    ],
    [categories, t],
  );
  const categoryGone =
    kind === 'category' &&
    slug !== '' &&
    categories !== undefined &&
    !categories.some((category) => category.slug === slug);

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
        <SelectField
          id="link-kind"
          label={t('storefront.link.label')}
          icon={Link01Icon}
          options={STOREFRONT_LINK_KINDS.map((item) => ({
            value: item,
            label: t(`storefront.link.kinds.${item}`),
          }))}
          value={kind}
          onChange={(event) => {
            const next = STOREFRONT_LINK_KINDS.find((item) => item === event.target.value);
            if (next !== undefined) pick(next);
          }}
          // The kinds with one address have nowhere else to show an error
          error={kind === 'offers' || kind === 'all' ? error : undefined}
          {...((kind === 'offers' || kind === 'all') && { ref })}
        />
        {kind === 'category' && (
          <SelectField
            id="link-category"
            label={t('storefront.link.category')}
            icon={FolderLibraryIcon}
            // A saved category that is gone is still the select's value, so it is an option
            options={
              categoryGone
                ? [...categoryOptions, { value: slug, label: `/c/${slug}` }]
                : categoryOptions
            }
            value={slug}
            onChange={(event) => {
              send(
                event.target.value === ''
                  ? ''
                  : storefrontLinkHref({ kind: 'category', slug: event.target.value }),
              );
            }}
            error={error}
            ref={ref}
          />
        )}
        {kind === 'listing' && (
          <Field id="link-listing" label={t('storefront.link.listing')} error={error}>
            <ListingBox
              slug={slug}
              onChange={(next) => {
                send(storefrontLinkHref({ kind: 'listing', slug: next }));
              }}
              invalid={error !== undefined}
              // Field's own id for the error line under the box
              describedBy={error === undefined ? undefined : 'link-listing-error'}
            />
          </Field>
        )}
        {kind === 'other' && (
          <TextField
            id="link-href"
            label={t('storefront.link.href')}
            placeholder={t('storefront.link.hrefPlaceholder')}
            hint={t('storefront.link.hrefHint')}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              send(event.target.value);
            }}
            error={error}
            ref={ref}
          />
        )}
      </div>
      {categoryGone && <GoneLine />}
      {kind !== 'other' && value !== '' && (
        // The whole sentence from t(): in Bangla the address comes before the verb
        <p className="text-label text-ink-3">{t('storefront.link.goesTo', { href: value })}</p>
      )}
    </div>
  );
}
```

- **The choice is state that follows the address only from outside** (decision 40). `sent` remembers the last
  address this picker sent; a `value` that differs from it came from the form (Discard, a reset), and only then
  does the choice change. This is done while rendering (`if (value !== sent) setSent(…)`), React's way for state
  that follows a prop: an effect would paint the old choice once first, and the lint refuses `setState` in an
  effect for that reason.
- **Offers and All products send their address at once**; Category and Product send `''` until something is picked,
  so a save before that fails with "Fill in this field." under the second box.
- **A category is picked by its slug**, the part of the address the shop reads. A saved slug that no category has
  any more is still the select's value, so it is added as an option (`/c/old-slug`) with a `warn` line under it:
  a select whose value is not among its options shows the first option, which would hide the broken link.
- **A product's name comes from a search for its slug.** Only an exact `slug` match counts (the search also matches
  names). While the answer is on its way, the button shows the slug; when nothing matches, the same `warn` line; a
  draft gets a hint that its link shows "page not found" until it is in the shop.
- **`ref` is a callback**: react-hook-form focuses the first box with an error after a refused save, and here that
  box is a select, a text box or the product button, depending on the choice.
- **"Goes to /c/skin-care" is one sentence from `t()`**: in Bangla the address comes before the verb.

### Drawings of the shop: `storefront-shop-preview.tsx`

```tsx
import {
  Add01Icon,
  Image01Icon,
  Menu01Icon,
  Search01Icon,
  ShoppingCart01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';
import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';

import { useShopMoney } from './storefront-parts';

// Step 26h: small drawings of the shop, from what the form holds this moment: the header, a chip
// and two product cards for the logo and the colors, and the hero at its two sizes. They draw the
// shop, not the app, so they use the shop's own look (apps/shop, CLAUDE.md → Storefront design
// system): the tenant's colors come from the form, and the shop's fixed colors are copied below.
// Every drawing is aria-hidden: the form's boxes and the contrast lines say the same in words.

// The shop's fixed tokens (apps/shop/src/styles/shop.css) that the drawings need. Not the app's
// tokens on purpose: the preview must look like the shop in both of the app's themes
const SHOP = {
  canvas: '#f6f7f7',
  card: '#ffffff',
  muted: '#707070',
  price: '#a70b1e',
  onBrandLine: 'rgb(255 255 255 / .15)',
} as const;

// Figma's hero panel ("Rectangle 4"), the same path as apps/shop's HeroBanner.astro
const HERO_PANEL =
  'M0 0L438.603 0C456.754 0 473.93 8.21725 485.32 22.3505L571.108 128.801C588.994 150.994 593.72 181.028 583.515 207.643L555.769 280H0V0Z';

// The Omnivo mark in the shop's header: the accent color on the brand bar (CLAUDE.md → Logo)
function ShopMark({ color }: { color: string }) {
  return (
    <span className="relative size-6 shrink-0">
      <span
        className="absolute top-0 left-0 size-[15px] rounded-[4px]"
        style={{ background: color }}
      />
      <span
        className="absolute right-0 bottom-0 size-[15px] rounded-[4px] border-2"
        style={{ borderColor: color }}
      />
    </span>
  );
}

export interface PreviewProduct {
  id: string;
  name: string;
  packSize: string;
  price: string | null;
  imageUrl: string | null;
}

export function ThemePreview({
  brand,
  accent,
  logoUrl,
  name,
  products,
}: {
  brand: string;
  accent: string;
  logoUrl: string | null;
  name: string;
  // Up to two of the shop's own listings; with none the cards are shapes only
  products: readonly PreviewProduct[];
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const cards: (PreviewProduct | null)[] =
    products.length > 0 ? products.slice(0, 2) : [null, null];
  return (
    <div className="grid min-w-0 gap-2">
      <span className="text-caption text-ink-3">{t('storefront.appearance.theme.preview')}</span>
      <div
        aria-hidden="true"
        className="grid min-w-0 gap-3 rounded-control border border-line p-3 tracking-[-0.02em]"
        style={{ background: SHOP.canvas }}
      >
        <div
          className="flex h-12 min-w-0 items-center gap-2 rounded-control px-2.5 text-white"
          style={{ background: brand }}
        >
          <HugeiconsIcon icon={Menu01Icon} size={18} strokeWidth={1.5} className="shrink-0" />
          {logoUrl === null ? (
            <ShopMark color={accent} />
          ) : (
            <img src={logoUrl} alt="" className="size-6 shrink-0 rounded-md object-contain" />
          )}
          <span className="truncate text-body-sm font-semibold">{name}</span>
          <span
            className="ml-auto flex h-7 min-w-0 max-w-38 flex-1 items-center justify-between overflow-hidden rounded-full pl-2.5 text-[10.5px] whitespace-nowrap"
            style={{ background: SHOP.card, color: SHOP.muted }}
          >
            <span className="truncate">{t('storefront.appearance.theme.previewSearch')}</span>
            <span
              className="mr-[3px] grid h-[22px] w-[30px] shrink-0 place-items-center rounded-full"
              style={{ background: accent, color: brand }}
            >
              <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.5} />
            </span>
          </span>
          <span
            className="grid size-7 shrink-0 place-items-center rounded-lg border"
            style={{ borderColor: SHOP.onBrandLine }}
          >
            <HugeiconsIcon icon={ShoppingCart01Icon} size={15} strokeWidth={1.5} />
          </span>
        </div>
        <div className="flex gap-2">
          <span
            className="inline-flex h-6.5 items-center rounded-md px-2.5 text-caption"
            style={{ background: brand, color: accent }}
          >
            {t('storefront.appearance.theme.previewChip')}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {cards.map((product, index) => (
            <div
              key={product?.id ?? index}
              className="grid content-start gap-1 rounded-lg p-2.5 text-center"
              style={{ background: SHOP.card }}
            >
              {product?.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt=""
                  className="h-24 w-full object-contain mix-blend-multiply"
                />
              ) : (
                <span
                  className="grid h-24 place-items-center rounded-md"
                  style={{ background: SHOP.canvas, color: SHOP.muted }}
                >
                  <HugeiconsIcon icon={Image01Icon} size={20} strokeWidth={1.5} />
                </span>
              )}
              {product ? (
                <>
                  <span
                    className="line-clamp-2 h-[31px] text-[12.5px] leading-tight font-semibold"
                    style={{ color: brand }}
                  >
                    {product.name}
                  </span>
                  <span className="text-[10.5px] font-semibold" style={{ color: SHOP.muted }}>
                    {product.packSize}
                  </span>
                  <span
                    className="mt-1 text-body font-semibold tabular-nums"
                    style={{ color: SHOP.price }}
                  >
                    {product.price === null ? '' : money(product.price)}
                  </span>
                </>
              ) : (
                // Shapes for a shop with nothing in it yet: the brand color of a name
                <span className="grid justify-items-center gap-1.5 py-1">
                  <span className="h-2 w-4/5 rounded-full" style={{ background: brand }} />
                  <span className="h-2 w-1/2 rounded-full" style={{ background: SHOP.canvas }} />
                </span>
              )}
              <span
                className="mt-1.5 flex h-8 items-center justify-center gap-1 rounded-[4px] text-caption font-semibold"
                style={{ background: accent, color: brand }}
              >
                <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.5} />
                {t('storefront.appearance.theme.previewAddToCart')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The box's own width, for a drawing made at the shop's size and scaled down to fit
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

export interface HeroLook {
  headline: string;
  line: string;
  eyebrow: string;
  buttonLabel: string;
  backgroundColor: string;
  panelColor: string;
  buttonColor: string;
  buttonTextColor: string;
}

// The desktop hero: drawn at the shop's 1280 × 280 and scaled to the box, so the headline wraps
// where it will wrap in the shop
export function HeroDesktopPreview({
  hero,
  imageUrl,
}: {
  hero: HeroLook;
  imageUrl: string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const scale = width / 1280;
  const inner: CSSProperties = {
    transform: `scale(${String(scale)})`,
    background: hero.backgroundColor,
  };
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="relative overflow-hidden rounded-control border border-line"
      style={{ height: Math.round(280 * scale) }}
    >
      <div
        className="absolute top-0 left-0 h-[280px] w-[1280px] origin-top-left overflow-hidden tracking-[-0.02em]"
        style={inner}
      >
        {imageUrl !== null && (
          <img
            src={imageUrl}
            alt=""
            className="absolute -top-6 right-[47px] h-[313px] w-[522px] object-contain"
          />
        )}
        <svg viewBox="0 0 588.819 280" className="absolute top-0 left-0 h-[280px] w-[589px]">
          <path d={HERO_PANEL} fill={hero.panelColor} />
        </svg>
        <div className="absolute top-1/2 left-[102px] flex w-[360px] -translate-y-1/2 flex-col items-start gap-9">
          <span className="text-[36px] leading-[1.2] font-semibold text-white">
            {hero.headline}
          </span>
          {hero.buttonLabel !== '' && (
            <span
              className="rounded-full px-6 py-4 text-[16px] font-semibold"
              style={{ background: hero.buttonColor, color: hero.buttonTextColor }}
            >
              {hero.buttonLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// The phone hero at the shop's own size (361 × 220 on a 393px phone): the photo under the scrim,
// the tag at the top in the theme's colors, the headline and its line at the bottom
export function HeroPhonePreview({
  hero,
  imageUrl,
  brand,
  accent,
}: {
  hero: HeroLook;
  imageUrl: string | null;
  brand: string;
  accent: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto h-[220px] w-full max-w-[361px] overflow-hidden rounded-2xl tracking-[-0.02em]"
      style={{ background: hero.backgroundColor }}
    >
      {imageUrl !== null && (
        <img src={imageUrl} alt="" className="absolute inset-0 size-full object-cover" />
      )}
      {/* The shop's hero-scrim, so its white words read on any photo (not a decoration of the app) */}
      <span className="absolute inset-0 bg-linear-to-b from-black/0 to-black/80" />
      <span className="absolute inset-0 flex flex-col items-start justify-between p-5">
        {hero.eyebrow === '' ? (
          <span />
        ) : (
          <span
            className="rounded-full px-3 py-1.5 text-caption leading-none font-bold uppercase"
            style={{ background: accent, color: brand }}
          >
            {hero.eyebrow}
          </span>
        )}
        <span className="grid gap-2">
          <span className="text-[28px] leading-[1.15] font-bold text-white">{hero.headline}</span>
          {hero.line !== '' && <span className="text-body-sm text-white/80">{hero.line}</span>}
        </span>
      </span>
    </div>
  );
}
```

- **Every drawing is `aria-hidden`**: the boxes and the contrast lines say the same in words, and a screen reader
  reading a fake header and two fake product cards would only confuse.
- **`SHOP` holds the shop's fixed colors** (decision 41), copied from `apps/shop/src/styles/shop.css` with a comment
  saying so; the tenant's two colors come from the form.
- **The desktop hero is drawn at the shop's 1280 × 280 and scaled** with `transform: scale()` to the box's width,
  measured with a `ResizeObserver`. The headline then wraps exactly where it wraps in the shop; a drawing made at
  the box's own size would wrap differently and lie about how many lines fit. The panel is the same SVG path as
  `HeroBanner.astro`, and the picture's place (`right-[47px]`, 522 × 313) is copied from it too.
- **The phone hero is drawn at its real size** (361 × 220), because it fits the card; the tag uses the shop's brand
  and accent colors, as the shop does.
- **The scrim is the shop's `hero-scrim`**, the one gradient here, and it belongs to the shop's design (its white
  words must read on any photo), not to the app's.

### Shop appearance: `storefront-appearance.tsx`

```tsx
import {
  Alert02Icon,
  Delete02Icon,
  DashboardSquareAddIcon,
  Edit02Icon,
  FireIcon,
  Image02Icon,
  ImageAdd01Icon,
  ImageUploadIcon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  PlusSignIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONTRAST_TEXT,
  contractErrorMap,
  createStorefrontBannerInputSchema,
  type CreateStorefrontBannerInput,
  routes,
  SHOP_CREAM,
  STOREFRONT_BANNERS_MAX,
  STOREFRONT_COLLECTIONS_MAX,
  STOREFRONT_DEFAULT_THEME,
  STOREFRONT_HOME_BLOCKS_MAX,
  type StorefrontAppearance,
  type StorefrontBanner,
  type StorefrontCollectionSummary,
  type StorefrontHero,
  type StorefrontHomeBlock,
  type StorefrontTheme,
  updateStorefrontThemeInputSchema,
  type UpdateStorefrontThemeInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormAlert,
  FormField,
  IconButton,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { ColorInput, ContrastList } from '../components/storefront-color';
import { LinkPicker } from '../components/storefront-link';
import {
  LINK_BUTTON_SM,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { useJobState } from '../components/storefront-photos';
import { PictureError, PictureField, usePictureUpload } from '../components/storefront-picture';
import {
  HeroDesktopPreview,
  HeroPhonePreview,
  ThemePreview,
} from '../components/storefront-shop-preview';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import type { PhotoState } from '../lib/storefront';
import { storefrontSetupQuery } from '../lib/storefront';
import {
  bannerFormValues,
  homeBlockId,
  homeBlockKey,
  homeRoom,
  storefrontAppearanceQuery,
  storefrontPreviewListingsQuery,
  themeFormValues,
} from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: Shop appearance (decision 2). Three cards on one page: the logo and the two colors
// (their own form and Save, decision approved with the mockup), the hero (a picture of it and a
// link to its own page), and the home page's blocks under the product grid. Every picture banner
// and collection is on the home page: Add puts one at the end, Delete deletes it.

// The page's read in the cache, changed in place after a save so the page does not wait for a
// second read; useStorefrontRefresh() still reads the menu again in the background
function useAppearanceCache(): (
  change: (current: StorefrontAppearance) => StorefrontAppearance,
) => void {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    (change) => {
      queryClient.setQueryData(storefrontAppearanceQuery(tenantId).queryKey, (current) =>
        current === undefined ? current : change(current),
      );
    },
    [queryClient, tenantId],
  );
}

// ---------------------------------------------------------------------------------------------
// Logo and colors

const THEME_FORM = 'storefront-theme';

function LogoField({
  value,
  onChange,
  state,
  onState,
  name,
  savedUrl,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  state: PhotoState | undefined;
  onState: (id: string, next: PhotoState) => void;
  name: string;
  // The saved logo's address, while the box still holds it
  savedUrl: string | null;
}) {
  const { t, errorText } = useLocale();
  const upload = usePictureUpload({
    onPicked: (id) => {
      onChange(id === '' ? null : id);
    },
    onState,
  });
  useJobState(value ?? '', state ?? { status: 'ready', url: '' }, onState);
  const url = state?.status === 'ready' ? state.url : savedUrl;

  return (
    <div role="group" aria-labelledby="logo-label" className="grid content-start gap-1.5">
      <span id="logo-label" className="text-label font-medium text-ink">
        {t('storefront.appearance.theme.logo')}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-subtle">
          {value !== null && state !== undefined && state.status !== 'ready' ? (
            <HugeiconsIcon
              icon={state.status === 'failed' ? Alert02Icon : ImageUploadIcon}
              size={20}
              strokeWidth={1.5}
              className={state.status === 'failed' ? 'text-crit' : 'text-ink-3'}
            />
          ) : value !== null && url !== null && url !== '' ? (
            <img
              src={url}
              alt={t('storefront.appearance.theme.logoAlt', { name })}
              className="size-full object-contain"
            />
          ) : (
            // The Omnivo mark the shop shows without a logo (CLAUDE.md → Logo)
            <span aria-hidden="true" className="relative size-7">
              <span className="absolute top-0 left-0 size-[18px] rounded-[5px] bg-brand" />
              <span className="absolute right-0 bottom-0 size-[18px] rounded-[5px] border-2 border-brand" />
            </span>
          )}
        </span>
        <div className="grid gap-2">
          {value === null && (
            <span className="text-body-sm text-ink-2">
              {t('storefront.appearance.theme.noLogo')}
            </span>
          )}
          {value !== null && state?.status === 'uploading' && (
            <span role="status" className="text-body-sm text-ink-2">
              {t('storefront.picture.uploading')}
            </span>
          )}
          {value !== null && state?.status === 'processing' && (
            <span role="status" className="text-body-sm text-ink-2">
              {t('storefront.picture.preparing')}
            </span>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={upload.open}>
              <HugeiconsIcon icon={ImageUploadIcon} size={17} strokeWidth={1.5} />
              {value === null ? t('storefront.picture.upload') : t('storefront.picture.replace')}
            </Button>
            {value !== null && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onChange(null);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {t('storefront.picture.remove')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {state?.status === 'failed' && value !== null ? (
        <PictureError>{errorText(state.code)}</PictureError>
      ) : upload.failure !== null ? (
        <PictureError>{errorText(upload.failure)}</PictureError>
      ) : (
        <p className="text-label text-ink-3">
          {t('storefront.appearance.theme.logoHint')} {t('storefront.picture.fileHint')}
        </p>
      )}
      {upload.fileInput}
    </div>
  );
}

function ThemeCard({ theme }: { theme: StorefrontTheme }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const refresh = useStorefrontRefresh();
  const updateCache = useAppearanceCache();
  const products = useQuery(storefrontPreviewListingsQuery(tenantId)).data;
  const [logoStates, setLogoStates] = useState<ReadonlyMap<string, PhotoState>>(() =>
    theme.logo === null
      ? new Map()
      : new Map([[theme.logo.id, { status: 'ready', url: theme.logo.url }]]),
  );
  const onLogoState = useCallback((id: string, next: PhotoState) => {
    setLogoStates((current) => new Map(current).set(id, next));
  }, []);

  const {
    control,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontThemeInputSchema, { error: contractErrorMap }),
    defaultValues: themeFormValues(theme),
  });
  const [brand, accent, logoId] = useWatch({
    control,
    name: ['brandColor', 'accentColor', 'logoImageId'],
  });
  const logoState = logoId === null ? undefined : logoStates.get(logoId);
  // Save waits for the logo's job: the API refuses a picture that is not ready
  const logoBusy = logoId !== null && logoState !== undefined && logoState.status !== 'ready';

  const onSubmit = handleSubmit(async (values: UpdateStorefrontThemeInput) => {
    try {
      const next = await call(routes.storefrontAppearance.updateTheme, { body: values });
      updateCache((current) => ({ ...current, theme: next }));
      reset(themeFormValues(next));
      toast(t('storefront.appearance.theme.saved'));
      await refresh();
    } catch (error) {
      applyApiError(error, ['logoImageId', 'brandColor', 'accentColor'], setError);
    }
  });

  return (
    <Card>
      <CardHeader
        title={t('storefront.appearance.theme.title')}
        subtitle={t('storefront.appearance.theme.description')}
      />
      <form
        id={THEME_FORM}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 items-start gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_380px]"
      >
        <div className="grid min-w-0 gap-[18px]">
          {errors.root?.server?.message !== undefined && (
            <FormAlert message={errors.root.server.message} />
          )}
          <Controller
            control={control}
            name="logoImageId"
            render={({ field }) => (
              <LogoField
                value={field.value}
                onChange={field.onChange}
                state={logoState}
                onState={onLogoState}
                name={theme.name}
                savedUrl={theme.logo?.id === field.value ? theme.logo.url : null}
              />
            )}
          />
          {errors.logoImageId?.message !== undefined && (
            <FormAlert message={errors.logoImageId.message} />
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
            <FormField
              control={control}
              name="brandColor"
              label={t('storefront.appearance.theme.brand')}
              hint={t('storefront.appearance.theme.brandHint')}
            >
              {(field) => <ColorInput {...field} label={t('storefront.appearance.theme.brand')} />}
            </FormField>
            <FormField
              control={control}
              name="accentColor"
              label={t('storefront.appearance.theme.accent')}
              hint={t('storefront.appearance.theme.accentHint')}
            >
              {(field) => <ColorInput {...field} label={t('storefront.appearance.theme.accent')} />}
            </FormField>
          </div>
          <ContrastList
            lines={[
              {
                label: t('storefront.appearance.theme.contrastCream'),
                first: brand,
                second: SHOP_CREAM,
                min: CONTRAST_TEXT,
              },
              {
                label: t('storefront.appearance.theme.contrastAccent'),
                first: brand,
                second: accent,
                min: CONTRAST_TEXT,
              },
            ]}
          />
        </div>
        <ThemePreview
          brand={brand}
          accent={accent}
          logoUrl={
            logoId === null
              ? null
              : logoState?.status === 'ready' && logoState.url !== ''
                ? logoState.url
                : theme.logo?.id === logoId
                  ? theme.logo.url
                  : null
          }
          name={theme.name}
          products={(products ?? []).map((listing) => ({
            id: listing.id,
            name: listing.name,
            packSize: listing.packSize,
            price: listing.price,
            imageUrl: listing.image?.url ?? null,
          }))}
        />
      </form>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3.5">
        <button
          type="button"
          className="mr-auto text-body-sm font-medium text-brand underline-offset-3 hover:underline"
          onClick={() => {
            setValue('brandColor', STOREFRONT_DEFAULT_THEME.brandColor, { shouldDirty: true });
            setValue('accentColor', STOREFRONT_DEFAULT_THEME.accentColor, { shouldDirty: true });
          }}
        >
          {t('storefront.appearance.theme.reset')}
        </button>
        {isDirty && (
          <Button
            variant="secondary"
            disabled={isSubmitting}
            onClick={() => {
              reset();
            }}
          >
            {t('storefront.discard')}
          </Button>
        )}
        <Button type="submit" form={THEME_FORM} disabled={!isDirty || isSubmitting || logoBusy}>
          {isSubmitting ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The hero

function HeroCard({ hero, theme }: { hero: StorefrontHero | null; theme: StorefrontTheme }) {
  const { t } = useLocale();
  if (hero === null) {
    return (
      <Card>
        <CardHeader
          title={t('storefront.appearance.hero.title')}
          subtitle={t('storefront.appearance.hero.description')}
        />
        <div className="grid justify-items-center gap-3 px-5 py-7 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={Image02Icon} size={20} strokeWidth={1.5} />
          </span>
          <p className="text-body-sm text-ink-2">{t('storefront.appearance.hero.none')}</p>
          <Link to="/storefront/appearance/hero" className={LINK_BUTTON_SM}>
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('storefront.appearance.hero.add')}
          </Link>
        </div>
      </Card>
    );
  }
  const look = {
    headline: hero.headline,
    line: hero.line ?? '',
    eyebrow: hero.eyebrow ?? '',
    buttonLabel: hero.buttonLabel,
    backgroundColor: hero.backgroundColor,
    panelColor: hero.panelColor,
    buttonColor: hero.buttonColor,
    buttonTextColor: hero.buttonTextColor,
  };
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 pr-5">
        <CardHeader
          title={t('storefront.appearance.hero.title')}
          subtitle={t('storefront.appearance.hero.description')}
        />
        <Link to="/storefront/appearance/hero" className={`${LINK_BUTTON_SM} mt-4 ml-5`}>
          <HugeiconsIcon icon={Edit02Icon} size={17} strokeWidth={1.5} />
          {t('storefront.appearance.hero.edit')}
        </Link>
      </div>
      <div className="grid gap-3 p-5">
        {/* The shop's own two layouts: the phone's below sm, as a phone would see it */}
        <div className="max-sm:hidden">
          <HeroDesktopPreview hero={look} imageUrl={hero.desktopImage.url} />
        </div>
        <div className="sm:hidden">
          <HeroPhonePreview
            hero={look}
            imageUrl={hero.phoneImage.url}
            brand={theme.brandColor}
            accent={theme.accentColor}
          />
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-body-sm font-medium text-ink">{hero.headline}</span>
          <span className="text-caption font-normal text-ink-3">
            {t('storefront.link.goesTo', { href: hero.href })}
          </span>
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The home page's blocks

// The line under a block's name: where a banner goes, how much of a collection is in the shop
function BlockLine({ block }: { block: StorefrontHomeBlock }) {
  const { t, format } = useLocale();
  if (block.kind === 'banner') {
    return (
      <span className="truncate text-caption font-normal text-ink-3">
        {t('storefront.appearance.home.banner')} ·{' '}
        {t('storefront.link.goesTo', { href: block.banner.href })}
      </span>
    );
  }
  const { listingCount, publishedCount } = block.collection;
  if (publishedCount === 0) {
    // The shop hides an empty row: say so, it is something to act on
    return (
      <span className="flex items-center gap-1.5 text-caption font-normal text-warn">
        <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.5} className="shrink-0" />
        {t('storefront.appearance.home.collection')} ·{' '}
        {t('storefront.appearance.home.nonePublished')}
      </span>
    );
  }
  return (
    <span className="truncate text-caption font-normal text-ink-3">
      {t('storefront.appearance.home.collection')} ·{' '}
      {publishedCount === listingCount
        ? t('storefront.appearance.home.products', {
            count: listingCount,
            formatted: format.number(listingCount),
          })
        : t('storefront.appearance.home.partlyPublished', {
            published: format.number(publishedCount),
            total: format.number(listingCount),
          })}
    </span>
  );
}

// A banner's name: the words of its computer picture (26h.5 decision 35)
function useBlockName(): (block: StorefrontHomeBlock) => string {
  const { t } = useLocale();
  return (block) =>
    block.kind === 'banner'
      ? t('storefront.appearance.banner.name', { alt: block.banner.desktopImage.alt })
      : block.collection.title;
}

type Deleting =
  | { kind: 'banner'; banner: StorefrontBanner }
  | { kind: 'collection'; collection: StorefrontCollectionSummary };

function HomeCard({
  blocks,
  onEditBanner,
  onAddBanner,
  onDelete,
}: {
  blocks: readonly StorefrontHomeBlock[];
  onEditBanner: (banner: StorefrontBanner) => void;
  onAddBanner: () => void;
  onDelete: (deleting: Deleting) => void;
}) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const updateCache = useAppearanceCache();
  const nameOf = useBlockName();
  const room = homeRoom(blocks, {
    banners: STOREFRONT_BANNERS_MAX,
    collections: STOREFRONT_COLLECTIONS_MAX,
    blocks: STOREFRONT_HOME_BLOCKS_MAX,
  });
  const move = useMutation({
    mutationFn: (input: { block: StorefrontHomeBlock; direction: 'up' | 'down' }) =>
      call(routes.storefrontAppearance.moveHomeBlock, {
        body: { kind: input.block.kind, id: homeBlockId(input.block), direction: input.direction },
      }),
    // The answer is the whole list in its new order (decision 14)
    onSuccess: (next) => {
      updateCache((current) => ({ ...current, blocks: next.blocks }));
    },
  });
  // Why an Add button is disabled (decision 6): the block limit first, it covers both
  const fullLine =
    room.banner === 'blocks'
      ? t('storefront.appearance.home.full', { max: format.number(STOREFRONT_HOME_BLOCKS_MAX) })
      : [
          room.banner === 'banners'
            ? t('storefront.appearance.home.bannersFull', {
                max: format.number(STOREFRONT_BANNERS_MAX),
              })
            : null,
          room.collection === 'collections'
            ? t('storefront.appearance.home.collectionsFull', {
                max: format.number(STOREFRONT_COLLECTIONS_MAX),
              })
            : null,
        ]
          .filter((line) => line !== null)
          .join(' ');

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 pr-5">
        <CardHeader
          title={t('storefront.appearance.home.title')}
          subtitle={t('storefront.appearance.home.description')}
        />
        <span className="mt-[21px] shrink-0 text-caption font-normal text-ink-3 tabular-nums">
          {t('storefront.appearance.home.count', {
            count: format.number(blocks.length),
            max: format.number(STOREFRONT_HOME_BLOCKS_MAX),
          })}
        </span>
      </div>
      <div className="grid gap-4 p-5">
        <p className="flex items-center gap-2 text-caption font-normal text-ink-3">
          <HugeiconsIcon icon={InformationCircleIcon} size={14} strokeWidth={1.5} />
          {t('storefront.appearance.home.fixed')}
        </p>
        {move.error && (
          <FormAlert
            message={move.error instanceof ApiRequestError ? move.error.code : 'unknown_error'}
          />
        )}
        {blocks.length === 0 ? (
          <EmptyState
            icon={DashboardSquareAddIcon}
            title={t('storefront.appearance.home.emptyTitle')}
            description={t('storefront.appearance.home.emptyBody')}
          />
        ) : (
          <ol className="rounded-control border border-line">
            {blocks.map((block, index) => {
              const name = nameOf(block);
              return (
                <li
                  key={homeBlockKey(block)}
                  className="flex min-h-16 items-center gap-3 border-t border-line py-2.5 pr-2.5 pl-3 first:border-t-0"
                >
                  {block.kind === 'banner' ? (
                    <span className="h-10 w-24 shrink-0 overflow-hidden rounded-md border border-line bg-subtle max-sm:hidden">
                      <img
                        src={block.banner.desktopImage.url}
                        alt=""
                        className="size-full object-cover"
                      />
                    </span>
                  ) : (
                    // A row of cards, drawn small: the block is a row of products
                    <span
                      aria-hidden="true"
                      className="flex h-10 w-24 shrink-0 items-center justify-center gap-[3px] rounded-md bg-brand-soft max-sm:hidden"
                    >
                      {[0, 1, 2, 3].map((card) => (
                        <span
                          key={card}
                          className="h-[22px] w-[18px] rounded-[3px] border border-brand-line bg-surface"
                        />
                      ))}
                    </span>
                  )}
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    {block.kind === 'banner' ? (
                      <button
                        type="button"
                        onClick={() => {
                          onEditBanner(block.banner);
                        }}
                        className="truncate text-left text-body-sm font-medium text-ink underline-offset-3 hover:underline"
                      >
                        {name}
                      </button>
                    ) : (
                      <Link
                        to="/storefront/appearance/collections/$collectionId"
                        params={{ collectionId: block.collection.id }}
                        className="flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-ink underline-offset-3 hover:underline"
                      >
                        <span className="truncate">{name}</span>
                        {block.collection.icon === 'fire' && (
                          <HugeiconsIcon
                            icon={FireIcon}
                            size={14}
                            strokeWidth={1.5}
                            className="shrink-0 text-ink-3"
                          />
                        )}
                      </Link>
                    )}
                    <BlockLine block={block} />
                  </span>
                  <span className="flex shrink-0 gap-0.5">
                    <IconButton
                      icon={ArrowUp01Icon}
                      label={t('storefront.appearance.home.moveUpLabel', { name })}
                      disabled={index === 0 || move.isPending}
                      onClick={() => {
                        move.mutate({ block, direction: 'up' });
                      }}
                    />
                    <IconButton
                      icon={ArrowDown01Icon}
                      label={t('storefront.appearance.home.moveDownLabel', { name })}
                      disabled={index === blocks.length - 1 || move.isPending}
                      onClick={() => {
                        move.mutate({ block, direction: 'down' });
                      }}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          icon={MoreHorizontalIcon}
                          label={t('storefront.appearance.home.actions', { name })}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          icon={Edit02Icon}
                          onSelect={() => {
                            if (block.kind === 'banner') onEditBanner(block.banner);
                            else
                              void navigate({
                                to: '/storefront/appearance/collections/$collectionId',
                                params: { collectionId: block.collection.id },
                              });
                          }}
                        >
                          {t('storefront.appearance.home.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          icon={Delete02Icon}
                          onSelect={() => {
                            onDelete(
                              block.kind === 'banner'
                                ? { kind: 'banner', banner: block.banner }
                                : { kind: 'collection', collection: block.collection },
                            );
                          }}
                        >
                          {t('storefront.appearance.home.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex flex-wrap gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={room.banner !== 'ok'}
            onClick={onAddBanner}
          >
            <HugeiconsIcon icon={ImageAdd01Icon} size={17} strokeWidth={1.5} />
            {t('storefront.appearance.home.addBanner')}
          </Button>
          {room.collection === 'ok' ? (
            <Link to="/storefront/appearance/collections/new" className={LINK_BUTTON_SM}>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.addCollection')}
            </Link>
          ) : (
            <Button variant="secondary" size="sm" disabled>
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.addCollection')}
            </Button>
          )}
        </div>
        {fullLine !== '' && <p className="text-label text-ink-3">{fullLine}</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// A picture banner's dialog

const BANNER_FORM = 'storefront-banner';

function BannerDialog({
  banner,
  onDone,
  onDelete,
}: {
  // null = a new banner
  banner: StorefrontBanner | null;
  onDone: () => void;
  onDelete: (banner: StorefrontBanner) => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const updateCache = useAppearanceCache();
  const [pictures, setPictures] = useState<ReadonlyMap<string, PhotoState>>(
    () =>
      new Map(
        banner === null
          ? []
          : [
              [banner.desktopImage.id, { status: 'ready', url: banner.desktopImage.url }],
              [banner.phoneImage.id, { status: 'ready', url: banner.phoneImage.url }],
            ],
      ),
  );
  const onPictureState = useCallback((id: string, next: PhotoState) => {
    setPictures((current) => new Map(current).set(id, next));
  }, []);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createStorefrontBannerInputSchema, { error: contractErrorMap }),
    defaultValues: bannerFormValues(banner),
  });
  const [desktopId, phoneId] = useWatch({ control, name: ['desktopImage.id', 'phoneImage.id'] });
  const busy = [desktopId, phoneId].some(
    (id) => id !== '' && pictures.get(id) !== undefined && pictures.get(id)?.status !== 'ready',
  );

  const onSubmit = handleSubmit(async (values: CreateStorefrontBannerInput) => {
    try {
      if (banner === null) {
        await call(routes.storefrontAppearance.createBanner, { body: values });
        toast(t('storefront.appearance.banner.added'));
      } else {
        const next = await call(routes.storefrontAppearance.updateBanner, {
          params: { id: banner.id },
          body: { ...values, version: banner.version },
        });
        updateCache((current) => ({
          ...current,
          blocks: current.blocks.map((block) =>
            block.kind === 'banner' && block.banner.id === next.id
              ? { ...block, banner: next }
              : block,
          ),
        }));
        toast(t('storefront.appearance.banner.saved'));
      }
      // A new banner's place on the page comes from the server (the end of the list)
      await refresh();
      onDone();
    } catch (error) {
      applyApiError(
        error,
        [
          'href',
          'desktopImage',
          'desktopImage.id',
          'desktopImage.alt',
          'phoneImage',
          'phoneImage.id',
          'phoneImage.alt',
        ],
        setError,
      );
    }
  });

  return (
    <DialogContent
      className="sm:max-w-140"
      title={
        banner === null
          ? t('storefront.appearance.banner.newTitle')
          : t('storefront.appearance.banner.editTitle')
      }
      description={t('storefront.appearance.banner.description')}
      footer={
        <>
          {banner !== null && (
            <Button
              variant="secondary"
              className="sm:mr-auto"
              onClick={() => {
                onDelete(banner);
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
              {t('storefront.appearance.home.delete')}
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form={BANNER_FORM} disabled={isSubmitting || busy}>
            {isSubmitting
              ? t('common.saving')
              : banner === null
                ? t('storefront.appearance.banner.submit')
                : t('common.save')}
          </Button>
        </>
      }
    >
      <form
        id={BANNER_FORM}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-[18px]"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <PictureField
          label={t('storefront.appearance.hero.desktopImage')}
          hint={t('storefront.appearance.banner.desktopImageHint')}
          aspectClass="aspect-[1280/280]"
          value={desktopId}
          state={pictures.get(desktopId)}
          onPicked={(id) => {
            setValue('desktopImage.id', id, { shouldDirty: true });
          }}
          onState={onPictureState}
          alt={register('desktopImage.alt')}
          altPlaceholder={t('storefront.appearance.banner.altPlaceholder')}
          altHint={t('storefront.appearance.banner.altHint')}
          altError={errors.desktopImage?.alt?.message}
          idError={errors.desktopImage?.id?.message ?? errors.desktopImage?.message}
        />
        <PictureField
          label={t('storefront.appearance.hero.phoneImage')}
          hint={t('storefront.appearance.banner.phoneImageHint')}
          aspectClass="aspect-[361/140]"
          value={phoneId}
          state={pictures.get(phoneId)}
          onPicked={(id) => {
            setValue('phoneImage.id', id, { shouldDirty: true });
          }}
          onState={onPictureState}
          alt={register('phoneImage.alt')}
          altPlaceholder={t('storefront.appearance.banner.altPlaceholder')}
          altError={errors.phoneImage?.alt?.message}
          idError={errors.phoneImage?.id?.message ?? errors.phoneImage?.message}
        />
        <Controller
          control={control}
          name="href"
          render={({ field, fieldState }) => (
            <LinkPicker
              value={field.value}
              onChange={field.onChange}
              error={fieldState.error?.message}
              ref={field.ref}
            />
          )}
        />
      </form>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// Deleting a banner or a collection

function DeleteDialog({ deleting, onDone }: { deleting: Deleting; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const remove = useMutation({
    mutationFn: () =>
      deleting.kind === 'banner'
        ? call(routes.storefrontAppearance.deleteBanner, {
            params: { id: deleting.banner.id },
            query: { version: deleting.banner.version },
          })
        : call(routes.storefrontAppearance.deleteCollection, {
            params: { id: deleting.collection.id },
            query: { version: deleting.collection.version },
          }),
    onSuccess: async () => {
      toast(
        deleting.kind === 'banner'
          ? t('storefront.appearance.banner.deleted')
          : t('storefront.collection.deleted', { title: deleting.collection.title }),
      );
      await refresh();
      onDone();
    },
  });
  return (
    <DialogContent
      title={
        deleting.kind === 'banner'
          ? t('storefront.appearance.banner.confirmDelete')
          : t('storefront.collection.confirmDelete', { title: deleting.collection.title })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            {deleting.kind === 'banner'
              ? t('storefront.appearance.home.delete')
              : t('storefront.collection.delete')}
          </Button>
        </>
      }
    >
      {remove.error && (
        <FormAlert
          message={remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'}
        />
      )}
      <p className="text-body-sm text-ink-2">
        {deleting.kind === 'banner'
          ? t('storefront.appearance.banner.deleteBody')
          : t('storefront.collection.deleteBody')}
      </p>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

function AppearanceView({ appearance }: { appearance: StorefrontAppearance }) {
  // The banner dialog: a banner to change, 'new', or closed
  const [editing, setEditing] = useState<StorefrontBanner | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  return (
    <>
      <ThemeCard theme={appearance.theme} />
      <HeroCard hero={appearance.hero} theme={appearance.theme} />
      <HomeCard
        blocks={appearance.blocks}
        onEditBanner={setEditing}
        onAddBanner={() => {
          setEditing('new');
        }}
        onDelete={setDeleting}
      />
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        {editing !== null && (
          <BannerDialog
            key={editing === 'new' ? 'new' : editing.id}
            banner={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
            }}
            onDelete={(banner) => {
              setEditing(null);
              setDeleting({ kind: 'banner', banner });
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        {deleting !== null && (
          <DeleteDialog
            deleting={deleting}
            onDone={() => {
              setDeleting(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

export function StorefrontAppearancePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  // Every route here needs the shop's settings first (storefront_not_set_up): no read before
  const appearance = useQuery({
    ...storefrontAppearanceQuery(tenantId),
    enabled: online && shop !== null,
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.appearance.title')}
        description={
          <>
            {t('storefront.appearance.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (setup.isError || appearance.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.appearance.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
        <EmptyState
          icon={PaintBoardIcon}
          title={t('storefront.appearance.notSetUpTitle')}
          description={t('storefront.appearance.notSetUpBody')}
          action={
            <Button
              onClick={() => {
                void navigate({ to: '/storefront/settings' });
              }}
            >
              {t('storefront.appearance.goToSettings')}
            </Button>
          }
        />
      )}
      {online && appearance.data && <AppearanceView appearance={appearance.data} />}
    </div>
  );
}
```

- **`useAppearanceCache()`** writes a save's answer into the page's read, so the card changes at once; the refresh
  after it reads the menu again in the background.
- **The theme card is its own form with its own Save** (approved with the mockup). It is short and sits at the top;
  a sticky save bar there would cover the hero card below. Save is disabled until something changed and while the
  logo is still being prepared.
- **The logo has no alt box**: its alt text is the shop's name, which the shop already knows ("Nirvor Shop logo").
  `LogoField` shows the Omnivo mark when there is no logo, the same mark the shop shows.
- **"Use the default colors" only fills the boxes** (`setValue` with `shouldDirty`), it does not save: the person
  sees the colors and the contrast lines first, then saves or discards.
- **The hero card has both layouts**: the computer drawing from `sm` up and the phone drawing below it, so a phone
  shows what a phone shopper sees.
- **The home card's rows** are an `<ol>`: the order is the content. A banner's name is a button that opens its
  dialog; a collection's name is a link to its page. Each row has Move up / Move down (disabled at the ends and
  while a move is running, so two quick clicks cannot cross) and a menu with Edit and Delete.
- **A move's answer is the whole list** (decision 14), written straight into the cache: no second read, and the list
  is exactly the server's order even if another tab moved something meanwhile.
- **"Add collection" is a link** while there is room and a disabled button when not: a link cannot be disabled.
  The sentence under the buttons says why (decision 6), the block limit first.
- **A collection with nothing in the shop** has a `warn` line with an icon ("None in the shop now, so the row is
  hidden"): color is never the only sign.
- **The banner dialog** is the dialog at 560px (`sm:max-w-140`) for the two pictures. One resolver (the create
  schema) serves both new and changed banners, because their fields are the same; a change adds the banner's
  version to the request. Delete in the dialog closes it and opens the confirmation, so two dialogs never stack.
- **The field names for the API's errors** include `desktopImage.id` and `desktopImage`: the API puts an image's
  error (`storefront_image_not_ready`, a picture of another workspace) on the picture, and the box shows it.
- **Before the shop is set up** the page shows the empty state with "Go to shop settings" and makes no read: every
  route here answers `storefront_not_set_up` until then (26h.3).

### The hero's page: `storefront-hero.tsx`

```tsx
import {
  ArrowLeft01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONTRAST_LARGE_TEXT,
  CONTRAST_TEXT,
  contractErrorMap,
  routes,
  saveStorefrontHeroInputSchema,
  type SaveStorefrontHeroInput,
  SHOP_WHITE,
  type StorefrontAppearance,
  type StorefrontHero,
  type StorefrontTheme,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormAlert,
  FormField,
  IconButton,
  PageHeader,
  SegmentedControl,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { type Path, Controller, useForm, useWatch } from 'react-hook-form';

import { ColorInput, ContrastList } from '../components/storefront-color';
import { LinkPicker } from '../components/storefront-link';
import {
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
} from '../components/storefront-parts';
import { PictureField } from '../components/storefront-picture';
import { HeroDesktopPreview, HeroPhonePreview } from '../components/storefront-shop-preview';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { type PhotoState, storefrontSetupQuery } from '../lib/storefront';
import { heroFormValues, storefrontAppearanceQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: the hero's own page (/storefront/appearance/hero, approved with the mockup instead of a
// dialog: four cards and a preview do not fit in 520px). One form that makes the hero or changes
// it with one PUT (decision 13), and above it the hero as the shop will draw it, from the boxes.

const FORM_ID = 'storefront-hero';

const FIELDS: Path<ReturnType<typeof heroFormValues>>[] = [
  'href',
  'headline',
  'line',
  'eyebrow',
  'buttonLabel',
  'desktopImage',
  'desktopImage.id',
  'desktopImage.alt',
  'phoneImage',
  'phoneImage.id',
  'phoneImage.alt',
  'backgroundColor',
  'panelColor',
  'buttonColor',
  'buttonTextColor',
];

const COLOR_FIELDS = [
  ['backgroundColor', 'background', 'backgroundHint'],
  ['panelColor', 'panel', 'panelHint'],
  ['buttonColor', 'buttonColor', null],
  ['buttonTextColor', 'buttonText', null],
] as const;

function HeroEditor({ hero, theme }: { hero: StorefrontHero | null; theme: StorefrontTheme }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const [view, setView] = useState<'desktop' | 'phone'>('desktop');
  const [deleting, setDeleting] = useState(false);
  const [pictures, setPictures] = useState<ReadonlyMap<string, PhotoState>>(
    () =>
      new Map(
        hero === null
          ? []
          : [
              [hero.desktopImage.id, { status: 'ready', url: hero.desktopImage.url }],
              [hero.phoneImage.id, { status: 'ready', url: hero.phoneImage.url }],
            ],
      ),
  );
  const onPictureState = useCallback((id: string, next: PhotoState) => {
    setPictures((current) => new Map(current).set(id, next));
  }, []);

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(saveStorefrontHeroInputSchema, { error: contractErrorMap }),
    defaultValues: heroFormValues(hero),
  });
  const look = useWatch({ control });
  const desktopId = look.desktopImage?.id ?? '';
  const phoneId = look.phoneImage?.id ?? '';
  const urlOf = (id: string) => {
    const state = pictures.get(id);
    return state?.status === 'ready' ? state.url : null;
  };
  const busy = [desktopId, phoneId].some((id) => id !== '' && pictures.get(id)?.status !== 'ready');
  const preview = {
    headline: look.headline ?? '',
    line: look.line ?? '',
    eyebrow: look.eyebrow ?? '',
    buttonLabel: look.buttonLabel ?? '',
    backgroundColor: look.backgroundColor ?? '',
    panelColor: look.panelColor ?? '',
    buttonColor: look.buttonColor ?? '',
    buttonTextColor: look.buttonTextColor ?? '',
  };

  const saved = (next: StorefrontHero | null) => {
    queryClient.setQueryData(
      storefrontAppearanceQuery(tenantId).queryKey,
      (current: StorefrontAppearance | undefined) =>
        current === undefined ? current : { ...current, hero: next },
    );
  };

  const onSubmit = handleSubmit(async (values: SaveStorefrontHeroInput) => {
    try {
      // The schema turned an empty line or tag into null (that is what the table keeps); the body
      // is the schema's input, which takes '' for "none", so the request sends '' back
      const next = await call(routes.storefrontAppearance.saveHero, {
        body: { ...values, line: values.line ?? '', eyebrow: values.eyebrow ?? '' },
      });
      saved(next);
      reset(heroFormValues(next));
      toast(t('storefront.appearance.hero.saved'));
      await refresh();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const remove = useMutation({
    mutationFn: (version: number) =>
      call(routes.storefrontAppearance.deleteHero, { query: { version } }),
    onSuccess: async () => {
      saved(null);
      toast(t('storefront.appearance.hero.deleted'));
      await refresh();
      void navigate({ to: '/storefront/appearance' });
    },
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/appearance"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.appearance.title')}
        </Link>
        <PageHeader
          title={
            hero === null
              ? t('storefront.appearance.hero.newTitle')
              : t('storefront.appearance.hero.editTitle')
          }
          description={
            <>
              {t('storefront.appearance.hero.description')}
              <ShopLine />
            </>
          }
          actions={
            hero !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.listing.moreActions')}
                    className="size-[42px] rounded-control border border-line-strong bg-surface shadow-sm"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setDeleting(true);
                    }}
                  >
                    {t('storefront.appearance.hero.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      </div>

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid min-w-0 gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}

        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3 pr-5">
            <CardHeader title={t('storefront.appearance.hero.previewTitle')} />
            <div className="mt-3.5 ml-5">
              <SegmentedControl
                label={t('storefront.appearance.hero.previewLabel')}
                value={view}
                options={[
                  { value: 'desktop', label: t('storefront.appearance.hero.previewDesktop') },
                  { value: 'phone', label: t('storefront.appearance.hero.previewPhone') },
                ]}
                onChange={setView}
              />
            </div>
          </div>
          <div className="p-5">
            {view === 'desktop' ? (
              <HeroDesktopPreview hero={preview} imageUrl={urlOf(desktopId)} />
            ) : (
              <div className="rounded-control bg-subtle px-4 py-5">
                <HeroPhonePreview
                  hero={preview}
                  imageUrl={urlOf(phoneId)}
                  brand={theme.brandColor}
                  accent={theme.accentColor}
                />
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.wordsTitle')} />
          <div className="grid gap-5 p-5">
            <TextField
              label={t('storefront.appearance.hero.headline')}
              placeholder={t('storefront.appearance.hero.headlinePlaceholder')}
              hint={t('storefront.appearance.hero.headlineHint')}
              {...register('headline')}
              error={errors.headline?.message}
            />
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              <TextField
                label={t('storefront.appearance.hero.button')}
                placeholder={t('storefront.appearance.hero.buttonPlaceholder')}
                hint={t('storefront.appearance.hero.buttonHint')}
                {...register('buttonLabel')}
                error={errors.buttonLabel?.message}
              />
              <TextField
                label={t('storefront.appearance.hero.eyebrow')}
                optional
                placeholder={t('storefront.appearance.hero.eyebrowPlaceholder')}
                hint={t('storefront.appearance.hero.eyebrowHint')}
                {...register('eyebrow')}
                error={errors.eyebrow?.message}
              />
            </div>
            <TextField
              label={t('storefront.appearance.hero.line')}
              optional
              placeholder={t('storefront.appearance.hero.linePlaceholder')}
              hint={t('storefront.appearance.hero.lineHint')}
              {...register('line')}
              error={errors.line?.message}
            />
            <Controller
              control={control}
              name="href"
              render={({ field, fieldState }) => (
                <LinkPicker
                  value={field.value}
                  onChange={field.onChange}
                  error={fieldState.error?.message}
                  ref={field.ref}
                />
              )}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.picturesTitle')} />
          <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2 md:gap-x-4">
            <PictureField
              label={t('storefront.appearance.hero.desktopImage')}
              hint={t('storefront.appearance.hero.desktopImageHint')}
              aspectClass="aspect-[1200/700]"
              value={desktopId}
              state={pictures.get(desktopId)}
              onPicked={(id) => {
                setValue('desktopImage.id', id, { shouldDirty: true });
              }}
              onState={onPictureState}
              alt={register('desktopImage.alt')}
              altPlaceholder={t('storefront.appearance.hero.altPlaceholder')}
              altError={errors.desktopImage?.alt?.message}
              idError={errors.desktopImage?.id?.message ?? errors.desktopImage?.message}
            />
            <PictureField
              label={t('storefront.appearance.hero.phoneImage')}
              hint={t('storefront.appearance.hero.phoneImageHint')}
              aspectClass="aspect-[361/220]"
              cover
              value={phoneId}
              state={pictures.get(phoneId)}
              onPicked={(id) => {
                setValue('phoneImage.id', id, { shouldDirty: true });
              }}
              onState={onPictureState}
              alt={register('phoneImage.alt')}
              altPlaceholder={t('storefront.appearance.hero.altPlaceholder')}
              altError={errors.phoneImage?.alt?.message}
              idError={errors.phoneImage?.id?.message ?? errors.phoneImage?.message}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title={t('storefront.appearance.hero.colorsTitle')} />
          <div className="grid gap-5 p-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-x-4">
              {COLOR_FIELDS.map(([name, label, hint]) => (
                <FormField
                  key={name}
                  control={control}
                  name={name}
                  label={t(`storefront.appearance.hero.${label}`)}
                  hint={hint === null ? undefined : t(`storefront.appearance.hero.${hint}`)}
                >
                  {(field) => (
                    <ColorInput {...field} label={t(`storefront.appearance.hero.${label}`)} />
                  )}
                </FormField>
              ))}
            </div>
            <ContrastList
              lines={[
                {
                  label: t('storefront.appearance.hero.contrastButton'),
                  first: preview.buttonColor,
                  second: preview.buttonTextColor,
                  min: CONTRAST_TEXT,
                },
                {
                  label: t('storefront.appearance.hero.contrastPanel'),
                  first: preview.panelColor,
                  second: SHOP_WHITE,
                  min: CONTRAST_LARGE_TEXT,
                },
              ]}
            />
          </div>
        </Card>

        {/* A new hero has nothing saved yet, so its buttons always show */}
        {(isDirty || hero === null) && (
          <SaveBar
            formId={FORM_ID}
            saving={isSubmitting}
            blocked={busy}
            onDiscard={() => {
              if (hero === null) void navigate({ to: '/storefront/appearance' });
              else reset();
            }}
          />
        )}
      </form>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title={t('storefront.appearance.hero.confirmDelete')}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">{t('common.cancel')}</Button>
              </DialogClose>
              <Button
                disabled={remove.isPending || hero === null}
                onClick={() => {
                  if (hero !== null) remove.mutate(hero.version);
                }}
              >
                {t('storefront.appearance.hero.delete')}
              </Button>
            </>
          }
        >
          {remove.error && (
            <FormAlert
              message={
                remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'
              }
            />
          )}
          <p className="text-body-sm text-ink-2">{t('storefront.appearance.hero.deleteBody')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StorefrontHeroPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const appearance = useQuery({
    ...storefrontAppearanceQuery(tenantId),
    enabled: online && shop !== null,
  });

  if (!online) return <StorefrontOffline />;
  if (setup.isError || appearance.isError) {
    return <p className="text-body-sm text-crit">{t('storefront.appearance.loadFailed')}</p>;
  }
  if (setup.data && shop === null) {
    return (
      <EmptyState
        icon={PaintBoardIcon}
        title={t('storefront.appearance.notSetUpTitle')}
        description={t('storefront.appearance.notSetUpBody')}
        action={
          <Button
            onClick={() => {
              void navigate({ to: '/storefront/settings' });
            }}
          >
            {t('storefront.appearance.goToSettings')}
          </Button>
        }
      />
    );
  }
  if (!appearance.data) return null;
  const { hero, theme } = appearance.data;
  // key: a hero made or deleted in another tab starts the form again from it
  return <HeroEditor key={hero?.id ?? 'new'} hero={hero} theme={theme} />;
}
```

- **One `useWatch({ control })`** feeds the preview and the contrast lines with every box at once. The preview
  needs all the words and colors, so watching them one by one would only be longer.
- **The preview switches between Computer and Phone** with the segmented control, so the two drawings never sit one
  above the other at different scales.
- **`body: { ...values, line: values.line ?? '', … }`** is decision 42.
- **A new hero always shows the save bar**, and its Discard goes back to Shop appearance: there is nothing saved to
  go back to.
- **Delete is in the page's menu**, only when there is a hero, and asks first. After it the page goes back to
  Shop appearance, where the card says "No hero banner".
- **`key={hero?.id ?? 'new'}`**: a hero made or deleted in another tab starts the form again; a save of this one keeps
  its id, so the form stays (decision 46).

### A collection: `storefront-collection.tsx`

```tsx
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  FireIcon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  type StorefrontCollection,
  type StorefrontListingSummary,
  updateStorefrontCollectionInputSchema,
  type UpdateStorefrontCollectionInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Combobox,
  type ComboboxOption,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FormAlert,
  IconButton,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  ListingStatusPill,
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { storefrontSetupQuery } from '../lib/storefront';
import {
  collectionFormValues,
  type CollectionFormValues,
  storefrontCollectionQuery,
  storefrontListingSearchQuery,
} from '../lib/storefront-appearance';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: one collection (decision 2: its own page). Under /storefront/appearance like the
// hero's page and the API's own path (/storefront/appearance/collections/:id), so the sidebar's
// "Shop appearance" stays marked while it is open; /storefront/appearance/collections/new for a new one. A title, the flame, and up to 24 listings in the
// order the shop's row shows them. Drafts may wait in it: the row shows a listing once it is in
// the shop.

const FORM_ID = 'storefront-collection';

function Thumb({ url }: { url: string | null }) {
  return url === null ? (
    <span className="size-10 shrink-0 rounded-lg bg-subtle" />
  ) : (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}

// The "Product to add" box: the catalog's search, without the listings already in the row
function AddListingBox({
  chosen,
  full,
  onAdd,
}: {
  chosen: ReadonlySet<string>;
  full: boolean;
  onAdd: (listing: StorefrontListingSummary) => void;
}) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const matches = useQuery(storefrontListingSearchQuery(tenantId, settled));
  const left = (matches.data ?? []).filter((listing) => !chosen.has(listing.id));
  const options = useMemo<ComboboxOption[]>(
    () =>
      left.map((listing) => ({
        value: listing.id,
        label: listing.name,
        detail: [
          listing.sku,
          listing.price === null ? null : money(listing.price),
          listing.status === 'draft' ? t('storefront.statuses.draft') : null,
        ]
          .filter((part) => part !== null)
          .join(' · '),
      })),
    [left, money, t],
  );

  if (full) {
    return (
      <p className="text-label text-ink-3">
        {t('storefront.collection.full', { max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX) })}
      </p>
    );
  }
  return (
    <div className="max-w-[520px]">
      <Field id="collection-add" label={t('storefront.collection.addLabel')}>
        <Combobox
          id="collection-add"
          // Always empty: a pick goes into the list, and the box is ready for the next one
          value=""
          selectedLabel={null}
          options={options}
          search={search}
          onSearchChange={setSearch}
          onChange={(value) => {
            const listing = left.find((item) => item.id === value);
            if (listing !== undefined) onAdd(listing);
          }}
          loading={matches.isFetching}
          icon={Store04Icon}
          placeholder={t('storefront.collection.addPlaceholder')}
          searchPlaceholder={t('storefront.collection.searchLabel')}
          emptyText={t('storefront.collection.noMatch')}
        />
      </Field>
    </div>
  );
}

function CollectionEditor({ collection }: { collection: StorefrontCollection | null }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const [deleting, setDeleting] = useState(false);
  // The listings the rows draw, by id: the saved ones and every one picked since
  const [listings, setListings] = useState<ReadonlyMap<string, StorefrontListingSummary>>(
    () => new Map((collection?.listings ?? []).map((listing) => [listing.id, listing])),
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontCollectionInputSchema, { error: contractErrorMap }),
    defaultValues: collectionFormValues(collection),
  });
  const ids = useWatch({ control, name: 'listingIds' });
  const inShop = ids.filter((id) => listings.get(id)?.status === 'published').length;

  const onSubmit = handleSubmit(async (values: UpdateStorefrontCollectionInput) => {
    try {
      if (collection === null) {
        // The create route has no version: the new row starts at 1
        const next = await call(routes.storefrontAppearance.createCollection, {
          body: { title: values.title, icon: values.icon, listingIds: values.listingIds },
        });
        queryClient.setQueryData(storefrontCollectionQuery(tenantId, next.id).queryKey, next);
        toast(t('storefront.collection.created', { title: next.title }));
        await refresh();
        void navigate({
          to: '/storefront/appearance/collections/$collectionId',
          params: { collectionId: next.id },
          replace: true,
        });
        return;
      }
      const next = await call(routes.storefrontAppearance.updateCollection, {
        params: { id: collection.id },
        body: values,
      });
      queryClient.setQueryData(storefrontCollectionQuery(tenantId, next.id).queryKey, next);
      reset(collectionFormValues(next));
      toast(t('storefront.collection.saved', { title: next.title }));
      await refresh();
    } catch (error) {
      applyApiError<CollectionFormValues>(error, ['title', 'icon', 'listingIds'], setError);
    }
  });

  const remove = useMutation({
    mutationFn: (current: StorefrontCollection) =>
      call(routes.storefrontAppearance.deleteCollection, {
        params: { id: current.id },
        query: { version: current.version },
      }),
    onSuccess: async (_answer, current) => {
      toast(t('storefront.collection.deleted', { title: current.title }));
      await refresh();
      void navigate({ to: '/storefront/appearance' });
    },
  });

  return (
    <div className="grid max-w-[880px] grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/appearance"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.collection.back')}
        </Link>
        <PageHeader
          title={collection?.title ?? t('storefront.collection.newTitle')}
          description={
            <>
              {t('storefront.collection.description')}
              {collection !== null && <ShopLine />}
            </>
          }
          actions={
            collection !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.listing.moreActions')}
                    className="size-[42px] rounded-control border border-line-strong bg-surface shadow-sm"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setDeleting(true);
                    }}
                  >
                    {t('storefront.collection.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          }
        />
      </div>
      {ids.length > 0 && inShop === 0 && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('storefront.collection.hiddenNotice')}
        </DocumentNotice>
      )}

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid min-w-0 gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <Card>
          <div className="grid gap-4 p-5">
            <TextField
              label={t('storefront.collection.title')}
              placeholder={t('storefront.collection.titlePlaceholder')}
              {...register('title')}
              error={errors.title?.message}
            />
            <Controller
              control={control}
              name="icon"
              render={({ field }) => (
                <Checkbox
                  id="collection-fire"
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {t('storefront.collection.fire')}
                      <HugeiconsIcon
                        icon={FireIcon}
                        size={14}
                        strokeWidth={1.5}
                        className="text-ink-3"
                      />
                    </span>
                  }
                  checked={field.value === 'fire'}
                  onCheckedChange={(checked) => {
                    field.onChange(checked === true ? 'fire' : null);
                  }}
                />
              )}
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3 pr-5">
            <CardHeader
              title={t('storefront.collection.products')}
              subtitle={t('storefront.collection.productsHint', {
                max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX),
              })}
            />
            <span className="mt-[21px] shrink-0 text-caption font-normal text-ink-3 tabular-nums">
              {t('storefront.collection.count', {
                count: format.number(ids.length),
                max: format.number(STOREFRONT_COLLECTION_ITEMS_MAX),
              })}
            </span>
          </div>
          <Controller
            control={control}
            name="listingIds"
            render={({ field, fieldState }) => {
              const move = (from: number, to: number) => {
                const next = [...field.value];
                const [item] = next.splice(from, 1);
                if (item !== undefined) next.splice(to, 0, item);
                field.onChange(next);
              };
              return (
                <div className="grid gap-4 p-5">
                  {fieldState.error?.message !== undefined && (
                    <FormAlert message={fieldState.error.message} />
                  )}
                  {field.value.length === 0 ? (
                    <DocumentNotice tone="neutral">
                      {t('storefront.collection.none')}
                    </DocumentNotice>
                  ) : (
                    <>
                      <ol className="rounded-control border border-line">
                        {field.value.map((id, index) => {
                          const listing = listings.get(id);
                          const name = listing?.name ?? id;
                          return (
                            <li
                              key={id}
                              className="flex items-center gap-3 border-t border-line py-2.5 pr-2.5 pl-3 first:border-t-0"
                            >
                              <span className="w-5 shrink-0 text-right text-caption font-normal text-ink-3 tabular-nums max-sm:hidden">
                                {format.number(index + 1)}
                              </span>
                              <Thumb url={listing?.image?.url ?? null} />
                              <span className="grid min-w-0 flex-1 gap-0.5">
                                <span className="truncate text-body-sm font-medium text-ink">
                                  {name}
                                </span>
                                {listing !== undefined && (
                                  <span className="truncate text-caption font-normal text-ink-3">
                                    <span className="font-mono">{listing.sku}</span>
                                    {listing.packSize !== '' && ` · ${listing.packSize}`}
                                    <span className="sm:hidden">
                                      {listing.price !== null && ` · ${money(listing.price)}`}
                                    </span>
                                  </span>
                                )}
                                {listing !== undefined && (
                                  <span className="mt-1 sm:hidden">
                                    <ListingStatusPill status={listing.status} />
                                  </span>
                                )}
                              </span>
                              {listing !== undefined && (
                                <>
                                  <span className="w-18 shrink-0 text-right text-body-sm tabular-nums max-sm:hidden">
                                    {listing.price === null ? '' : money(listing.price)}
                                  </span>
                                  <span className="w-26 shrink-0 max-sm:hidden">
                                    <ListingStatusPill status={listing.status} />
                                  </span>
                                </>
                              )}
                              <span className="flex shrink-0 gap-0.5">
                                <IconButton
                                  icon={ArrowUp01Icon}
                                  label={t('storefront.collection.moveUpLabel', { name })}
                                  disabled={index === 0}
                                  onClick={() => {
                                    move(index, index - 1);
                                  }}
                                />
                                <IconButton
                                  icon={ArrowDown01Icon}
                                  label={t('storefront.collection.moveDownLabel', { name })}
                                  disabled={index === field.value.length - 1}
                                  onClick={() => {
                                    move(index, index + 1);
                                  }}
                                />
                                <IconButton
                                  icon={Delete02Icon}
                                  label={t('storefront.collection.remove', { name })}
                                  onClick={() => {
                                    field.onChange(field.value.filter((item) => item !== id));
                                  }}
                                />
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                      <p className="-mt-1 text-label text-ink-3">
                        {t('storefront.collection.draftHint')}
                      </p>
                    </>
                  )}
                  <AddListingBox
                    chosen={new Set(field.value)}
                    full={field.value.length >= STOREFRONT_COLLECTION_ITEMS_MAX}
                    onAdd={(listing) => {
                      setListings((current) => new Map(current).set(listing.id, listing));
                      field.onChange([...field.value, listing.id]);
                    }}
                  />
                </div>
              );
            }}
          />
        </Card>

        {collection === null ? (
          <div className="flex justify-end gap-2.5">
            <Button
              variant="secondary"
              onClick={() => {
                void navigate({ to: '/storefront/appearance' });
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('storefront.collection.create')}
            </Button>
          </div>
        ) : (
          isDirty && (
            <SaveBar
              formId={FORM_ID}
              saving={isSubmitting}
              onDiscard={() => {
                reset();
              }}
            />
          )
        )}
      </form>

      {collection !== null && (
        <Dialog open={deleting} onOpenChange={setDeleting}>
          <DialogContent
            title={t('storefront.collection.confirmDelete', { title: collection.title })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.mutate(collection);
                  }}
                >
                  {t('storefront.collection.delete')}
                </Button>
              </>
            }
          >
            {remove.error && (
              <FormAlert
                message={
                  remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'
                }
              />
            )}
            <p className="text-body-sm text-ink-2">{t('storefront.collection.deleteBody')}</p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export function StorefrontCollectionPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  // No id on /storefront/appearance/collections/new
  const { collectionId } = useParams({ strict: false });
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const collection = useQuery({
    ...storefrontCollectionQuery(tenantId, collectionId ?? ''),
    enabled: online && shop !== null && collectionId !== undefined,
  });

  if (!online) return <StorefrontOffline />;
  if (setup.isError || collection.isError) {
    return (
      <p className="text-body-sm text-crit">
        {collection.error instanceof ApiRequestError && collection.error.status === 404
          ? t('storefront.collection.notFound')
          : t('storefront.collection.loadFailed')}
      </p>
    );
  }
  if (setup.data && shop === null) {
    return (
      <EmptyState
        icon={PaintBoardIcon}
        title={t('storefront.appearance.notSetUpTitle')}
        description={t('storefront.appearance.notSetUpBody')}
        action={
          <Button
            onClick={() => {
              void navigate({ to: '/storefront/settings' });
            }}
          >
            {t('storefront.appearance.goToSettings')}
          </Button>
        }
      />
    );
  }
  if (collectionId === undefined) {
    return shop === null ? null : <CollectionEditor key="new" collection={null} />;
  }
  if (!collection.data) return null;
  return <CollectionEditor key={collection.data.id} collection={collection.data} />;
}
```

- **The list of ids is one `Controller`**, not a `useFieldArray`: react-hook-form's field arrays hold objects, and
  the API takes plain ids. Move, remove and add each hand the controller a new array.
- **`listings` (a `Map` by id)** keeps what the rows draw: the saved listings, and every listing picked since. The
  form holds only ids, so without it a new row would have no name or photo until the save.
- **The picker leaves out the listings already in the row** and stays empty after a pick (`value=""`), ready for the
  next one. At 24 it is replaced by the sentence that says the row is full.
- **A new collection has Cancel and "Add collection"** at the end of the form, not a save bar: there is nothing
  saved yet. After the create the page replaces its address with the new collection's (`replace: true`), so Back
  does not reopen an empty "New collection" form.
- **The "hidden" notice** is decision 44.

### The pages list and a page: `storefront-pages.tsx`, `storefront-page.tsx`

```tsx
import {
  CallIncoming01Icon,
  Files01Icon,
  LegalDocument01Icon,
  SecurityCheckIcon,
  Store01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { type ShopTextPageSlug, type StorefrontPageSummary, todayIn } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DataTable, dataTableColumns, EmptyState, PageHeader } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';

import {
  PageStatusPill,
  ShopLine,
  StorefrontOffline,
  ViewShopLink,
} from '../components/storefront-parts';
import { storefrontSetupQuery } from '../lib/storefront';
import { storefrontPagesQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26h: the four text pages the shop's footer links (decision 5): always the four, in the
// footer's order, written or not. A page not written is left out of the footer, so the list says
// which are in it. A row opens the page's editor.

// One icon per page, so the four rows read apart at a glance (approved with the mockup)
const PAGE_ICONS: Readonly<Record<ShopTextPageSlug, IconSvgElement>> = {
  privacy: SecurityCheckIcon,
  terms: LegalDocument01Icon,
  about: Store01Icon,
  contact: CallIncoming01Icon,
};

const column = dataTableColumns<StorefrontPageSummary>();

export function StorefrontPagesPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const pages = useQuery({ ...storefrontPagesQuery(tenantId), enabled: online && shop !== null });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('slug', {
          header: t('storefront.pages.columns.page'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="flex min-w-0 items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={PAGE_ICONS[getValue()]} size={16} strokeWidth={1.5} />
              </span>
              <span className="grid min-w-0">
                <span className="truncate font-medium text-ink">
                  {t(`storefront.pages.names.${getValue()}`)}
                </span>
                <span className="text-caption font-normal text-ink-3">
                  {t(`storefront.pages.hints.${getValue()}`)}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('version', {
          id: 'status',
          header: t('storefront.pages.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <PageStatusPill written={getValue() !== null} />,
        }),
        column.accessor('sectionCount', {
          header: t('storefront.pages.columns.sections'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row, getValue }) =>
            row.original.version === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-ink-2 tabular-nums">
                {t('storefront.pages.sections', {
                  count: getValue(),
                  formatted: format.number(getValue()),
                })}
              </span>
            ),
        }),
        column.accessor('updatedAt', {
          header: t('storefront.pages.columns.updated'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The day in the workspace's time zone, like every other list's date
          cell: ({ getValue }) => {
            const value = getValue();
            return value === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="text-ink-2 tabular-nums">
                {format.date(new Date(`${todayIn(timeZone, new Date(value))}T00:00:00`))}
              </span>
            );
          },
        }),
        column.display({
          id: 'action',
          header: () => <span className="sr-only">{t('storefront.pages.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          // A real link too: the row's click is for the mouse, the link is for the keyboard
          cell: ({ row }) => (
            <Link
              to="/storefront/pages/$slug"
              params={{ slug: row.original.slug }}
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            >
              {row.original.version === null
                ? t('storefront.pages.write')
                : t('storefront.pages.edit')}
              <span className="sr-only">: {t(`storefront.pages.names.${row.original.slug}`)}</span>
            </Link>
          ),
        }),
      ]),
    [t, format, timeZone],
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.pages.title')}
        description={
          <>
            {t('storefront.pages.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (setup.isError || pages.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.pages.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
        <EmptyState
          icon={Files01Icon}
          title={t('storefront.pages.notSetUpTitle')}
          description={t('storefront.pages.notSetUpBody')}
          action={
            <Button
              onClick={() => {
                void navigate({ to: '/storefront/settings' });
              }}
            >
              {t('storefront.pages.goToSettings')}
            </Button>
          }
        />
      )}
      {online && pages.data && (
        <DataTable
          label={t('storefront.pages.title')}
          data={pages.data}
          columns={columns}
          getRowId={(row) => row.slug}
          onRowClick={(row) =>
            void navigate({ to: '/storefront/pages/$slug', params: { slug: row.slug } })
          }
        />
      )}
    </div>
  );
}
```

- **A data table of four rows** keeps the app's one look for lists, with cards on a phone (`meta.card`). It is not
  sortable: the order is the footer's.
- **A row opens on a click, and the last column is a real link** (approved with the mockup): the click is for the
  mouse, the link is for the keyboard and for "open in a new tab". The link stops the row's click from firing too.
  Its hidden words name the page ("Edit: Terms & Condition"), so a list of four "Edit" links reads apart.
- **A page not written shows dashes** for its sections and day: zero sections would read as an empty page in the
  shop, which is not what "not written" means.

```tsx
import {
  ArrowLeft01Icon,
  Delete02Icon,
  Files01Icon,
  MoreHorizontalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  saveStorefrontPageInputSchema,
  type SaveStorefrontPageInput,
  SHOP_TEXT_PAGES,
  type ShopTextPageSlug,
  type StorefrontPage,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormAlert,
  IconButton,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  PageStatusPill,
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { SectionsCard } from '../components/storefront-sections';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { storefrontSetupQuery } from '../lib/storefront';
import { pageFormValues, storefrontPageQuery } from '../lib/storefront-appearance';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26h: one text page's editor (decision 5): its sections in the listing's section editor, and
// one PUT that writes or changes it. Saving the first section puts the page in the footer; Delete
// takes it out, and the shop answers "page not found" for its address again.

const FORM_ID = 'storefront-page';

function PageEditor({ page }: { page: StorefrontPage }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const [deleting, setDeleting] = useState(false);
  const name = t(`storefront.pages.names.${page.slug}`);
  const written = page.version !== null;

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(saveStorefrontPageInputSchema, { error: contractErrorMap }),
    defaultValues: pageFormValues(page),
  });
  const sections = useFieldArray({ control, name: 'sections' });
  const values = useWatch({ control, name: 'sections' });

  const onSubmit = handleSubmit(async (body: SaveStorefrontPageInput) => {
    try {
      const next = await call(routes.storefrontAppearance.savePage, {
        params: { slug: page.slug },
        body,
      });
      queryClient.setQueryData(storefrontPageQuery(tenantId, page.slug).queryKey, next);
      reset(pageFormValues(next));
      toast(
        written ? t('storefront.page.saved', { name }) : t('storefront.page.created', { name }),
      );
      await refresh();
    } catch (error) {
      applyApiError(error, ['sections'], setError);
    }
  });

  const remove = useMutation({
    mutationFn: (version: number) =>
      call(routes.storefrontAppearance.deletePage, {
        params: { slug: page.slug },
        query: { version },
      }),
    onSuccess: async () => {
      toast(t('storefront.page.deleted', { name }));
      await refresh();
      void navigate({ to: '/storefront/pages' });
    },
  });

  return (
    <div className="grid max-w-[880px] grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/pages"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.page.back')}
        </Link>
        <PageHeader
          title={name}
          description={
            <>
              <span className="mb-1.5 flex">
                <PageStatusPill written={written} />
              </span>
              {t(`storefront.pages.hints.${page.slug}`)}
              {written && <ShopLine />}
            </>
          }
          actions={
            written && (
              <>
                <ViewShopLink href={page.shopUrl} label={t('storefront.page.viewPage')} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      icon={MoreHorizontalIcon}
                      label={t('storefront.listing.moreActions')}
                      className="size-[42px] rounded-control border border-line-strong bg-surface shadow-sm"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      icon={Delete02Icon}
                      onSelect={() => {
                        setDeleting(true);
                      }}
                    >
                      {t('storefront.page.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )
          }
        />
      </div>
      {!written && (
        <DocumentNotice tone="neutral">{t('storefront.page.notWrittenNotice')}</DocumentNotice>
      )}

      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid min-w-0 gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <SectionsCard
          title={t('storefront.page.sectionsTitle')}
          subtitle={t('storefront.page.sectionsHint')}
          headingPlaceholder={t('storefront.page.headingPlaceholder')}
          bodyPlaceholder={t('storefront.page.bodyPlaceholder')}
          emptyText={t('storefront.page.noSections')}
          previewCaption={t('storefront.page.previewCaption')}
          rows={sections.fields.map((field, index) => ({
            key: field.id,
            heading: values[index]?.heading ?? '',
            body: values[index]?.body ?? '',
          }))}
          field={(index, part) => register(rowPath('sections', index, part))}
          error={(index, part) => errors.sections?.[index]?.[part]?.message}
          listError={errors.sections?.root?.message ?? errors.sections?.message}
          onAdd={() => {
            sections.append({ heading: '', body: '' });
          }}
          onRemove={sections.remove}
          onSwap={sections.swap}
        />
        {/* A page not written yet shows its buttons once it has a section to save */}
        {isDirty && (
          <SaveBar
            formId={FORM_ID}
            saving={isSubmitting}
            onDiscard={() => {
              reset();
            }}
          />
        )}
      </form>

      {page.version !== null && (
        <Dialog open={deleting} onOpenChange={setDeleting}>
          <DialogContent
            title={t('storefront.page.confirmDelete', { name })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={remove.isPending}
                  onClick={() => {
                    if (page.version !== null) remove.mutate(page.version);
                  }}
                >
                  {t('storefront.page.delete')}
                </Button>
              </>
            }
          >
            {remove.error && (
              <FormAlert
                message={
                  remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'
                }
              />
            )}
            <p className="text-body-sm text-ink-2">{t('storefront.page.deleteBody')}</p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function isPageSlug(value: string): value is ShopTextPageSlug {
  return SHOP_TEXT_PAGES.some((slug) => slug === value);
}

export function StorefrontPagePage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const navigate = useNavigate();
  const { slug = '' } = useParams({ strict: false });
  // Only the four pages have an editor: any other address is "not found", without a request
  const known = isPageSlug(slug) ? slug : null;
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const page = useQuery({
    ...storefrontPageQuery(tenantId, known ?? 'privacy'),
    enabled: online && shop !== null && known !== null,
  });

  if (!online) return <StorefrontOffline />;
  if (known === null) {
    return <p className="text-body-sm text-crit">{t('errors.not_found')}</p>;
  }
  if (setup.isError || page.isError) {
    return <p className="text-body-sm text-crit">{t('storefront.page.loadFailed')}</p>;
  }
  if (setup.data && shop === null) {
    return (
      <EmptyState
        icon={Files01Icon}
        title={t('storefront.pages.notSetUpTitle')}
        description={t('storefront.pages.notSetUpBody')}
        action={
          <Button
            onClick={() => {
              void navigate({ to: '/storefront/settings' });
            }}
          >
            {t('storefront.pages.goToSettings')}
          </Button>
        }
      />
    );
  }
  if (!page.data) return null;
  // key: another page starts its own form. Not the version: a read in the background must never
  // wipe what the person is typing (the save's own answer resets the form)
  return <PageEditor key={page.data.slug} page={page.data} />;
}
```

- **`isPageSlug()`** checks the address before any request: only the four pages have an editor, and a typed
  `/storefront/pages/careers` shows "not found" without asking the API.
- **The save bar shows once there is a change**, also on a page not written yet: the first "Add section" is a
  change, and saving a page with no section would be refused (`storefront_page_empty`).
- **The toast says "Terms & Condition is in the shop"** on the first save and "… saved" after it: the first save is
  the moment the footer gets its link, which is worth saying.
- **View page and Delete only on a written page**: an unwritten page has no address that works.

### Routes and the sidebar: `router.tsx`, `app-shell.tsx`

```diff
@@ -1066,6 +1066,54 @@ const storefrontSettingsRoute = createRoute({
   ),
 });
 
+// Step 26h: the menu's second half (decision 2). The hero and a collection have their own pages
+// under /storefront/appearance, so the sidebar keeps "Shop appearance" marked on them; 'new' is
+// matched before the id (TanStack Router prefers a fixed segment over a parameter)
+const storefrontAppearanceRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/appearance',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-appearance'),
+    'StorefrontAppearancePage',
+  ),
+});
+
+const storefrontHeroRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/appearance/hero',
+  component: lazyRouteComponent(() => import('./routes/storefront-hero'), 'StorefrontHeroPage'),
+});
+
+const storefrontNewCollectionRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/appearance/collections/new',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-collection'),
+    'StorefrontCollectionPage',
+  ),
+});
+
+const storefrontCollectionRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/appearance/collections/$collectionId',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-collection'),
+    'StorefrontCollectionPage',
+  ),
+});
+
+const storefrontPagesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/pages',
+  component: lazyRouteComponent(() => import('./routes/storefront-pages'), 'StorefrontPagesPage'),
+});
+
+const storefrontPageRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/pages/$slug',
+  component: lazyRouteComponent(() => import('./routes/storefront-page'), 'StorefrontPagePage'),
+});
+
 // শুধু `pnpm dev`-এ। production build-এ Vite import.meta.env.DEV-কে false বসায়, minifier পুরো
 // শাখা মুছে দেয় — import() হারায়, তাই kitchen-sink-এর chunk তৈরিই হয় না
 const devRoutes = import.meta.env.DEV
@@ -1213,6 +1261,12 @@ const routeTree = rootRoute.addChildren([
     storefrontListingRoute,
     storefrontCategoriesRoute,
     storefrontSettingsRoute,
+    storefrontAppearanceRoute,
+    storefrontHeroRoute,
+    storefrontNewCollectionRoute,
+    storefrontCollectionRoute,
+    storefrontPagesRoute,
+    storefrontPageRoute,
     ...devRoutes,
   ]),
 ]);
```

Six lazy routes. `…/collections/new` and `…/collections/$collectionId` are separate routes that load the same page;
TanStack Router prefers the fixed segment `new` over the parameter, so "new" is never read as an id.

```diff
@@ -71,6 +71,8 @@ import {
   UserTime01Icon,
   WarehouseIcon,
   WebDesign01Icon,
+  PaintBoardIcon,
+  Files01Icon,
   Wifi01Icon,
   WifiDisconnected02Icon,
   WorkHistoryIcon,
@@ -672,6 +674,14 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               <NavLink to="/storefront/categories" icon={FolderLibraryIcon}>
                 {t('nav.storefrontCategories')}
               </NavLink>
+              {/* Step 26h: the look and the text pages, before the settings (approved with the
+                  mockup: the things changed most often come first) */}
+              <NavLink to="/storefront/appearance" icon={PaintBoardIcon}>
+                {t('nav.storefrontAppearance')}
+              </NavLink>
+              <NavLink to="/storefront/pages" icon={Files01Icon}>
+                {t('nav.storefrontPages')}
+              </NavLink>
               <NavLink to="/storefront/settings" icon={WebDesign01Icon}>
                 {t('nav.storefrontSettings')}
               </NavLink>
```

The two items sit before Shop settings (approved with the mockup), behind the group's `storefront.manage` check
like the other three.

### The budget: `check-bundle-size.ts`

```diff
@@ -18,8 +18,9 @@ import { z } from 'zod';
 // words (the VAT and stock movement reports, the scheduled emails) took it to 231.7 KB; the pages
 // and the schedule dialog are their own lazy chunks. Step 26g: 240 KB (you chose this). The
 // Storefront menu's words (26g.5) and its sidebar group took it to 237.2 KB; its four pages are
-// lazy chunks.
-const INITIAL_BUDGET = 240 * 1024;
+// lazy chunks. Step 26h: 245 KB (you chose this). The words of Shop appearance and Shop pages
+// (26h.5) took it to 241.1 KB, with or without their two sidebar items; the six pages are lazy.
+const INITIAL_BUDGET = 245 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

Decision 45.

### The words added here

The en/bn diffs in 26h.5 run to the end of the step, so these words are already in them, marked "26h.6":
`storefront.picture.missing` ("Upload a picture."), the hero page's `wordsTitle`, `picturesTitle`, `previewTitle`
and `previewLabel`, and the pages table's `sections` and `actions` column names.

### Check this part

```bash
pnpm --filter @omnivo/i18n build                 # the app reads the words from dist/
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                   # 229 tests, 6 of them new
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src/components/storefront-*.tsx \
  apps/app/src/routes/storefront-*.tsx apps/app/src/lib/storefront-appearance*.ts apps/app/src/router.tsx \
  apps/app/src/routes/app-shell.tsx apps/app/scripts/check-bundle-size.ts
pnpm exec prettier --check apps/app/src apps/app/scripts packages/i18n/src
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
```

`test:bundle-size` before decision 45: "initial JS 241.1 KB gz (budget 240.0 KB)", failing. After it: 241.1 of
245 KB; Shop appearance 141.6 KB, the hero 137.6 KB, a collection 129.9 KB, a page 125.7 KB, the pages list
90.5 KB, and the listing editor 149.6 KB (of 150).

Broken on purpose (and put back): `homeRoom()` naming the banner limit before the block limit, and a saved hero's
`null` line coming back as `'x'`: the new spec fails on both.

The screens are seen in a browser in 26h.7, with the mock API's answers and the Playwright tests.

## 26h.7 — The mock and the Playwright tests

The sixteen routes of 26h.1 get an answer in mock mode, so `pnpm dev:mock` and the Playwright tests can show the five
new pages. The mock follows the API's services of 26h.3: the same limits, the same version checks, the same audit
rows. Then the tests, on a computer and on a phone. The screens were also compared, page by page, with the approved
mockup at 1440 and 390 pixels; they match it (see decision 52 for the small differences that were left).

Decisions in this part (mine):

47. **Rahman Fashion gets a look; Karim Pharma stays without a shop.** The garments shop has a logo, the default
    colors, an Eid hero that links to Polo shirts, and four blocks under the product grid: "Hot & Trending Right Now"
    (three listings, all in the shop), the winter sale picture banner, "For the kids" (two listings) and "Coming
    soon", which holds only the white polo draft, so the Home page card shows its `warn` line. Terms & Condition and
    About Us are written; Privacy Policy and Contact Us are not. Each case a screen can show has a row to show it.
    The pictures are drawn SVG `data:` addresses, like 26g's packshots: no image files in the repo.
48. **The logo and the colors sit beside the settings row.** In the API they are three columns of
    `storefront_settings` and share its version (decision 12). The mock keeps them in `storefront.theme` and raises
    the settings' `version` when they are saved. Putting them inside `MockShop` would add three fields to every Shop
    settings answer, and taking them out again needs a rest pattern with three unused names, which the lint rules
    refuse.
49. **Its own mock file.** The rules live in `storefront-appearance-data.ts`, beside 26g's `storefront-data.ts`, like
    the API's separate services. `storefront-data.ts` exports the eight helpers both halves need (the shop's address,
    the errors, `isReady()`, `viewOf()`, `toSummary()`, `showable()`). The page read is `textPageOf()`, because
    `handlers.ts` already imports a `pageOf()` (the paging helper of `sales-document-data.ts`).
50. **Deleting a listing takes it out of every collection.** On the server the collection item's foreign key
    cascades. The mock does the same in `removeListing()`, and, like the database, leaves the collection's version
    alone.
51. **`png()` moves to `helpers.ts`.** 26g's test file built its test PNG itself; the picture uploads here need it
    too, so it is shared instead of copied.
52. **What differs from the mockup, and stays.** The hero page's Computer / Phone control has no icons (the ui's
    segmented control takes text only); "Goes to /c/…" is in the body font, not `Geist Mono` (the address is inside
    a translated sentence); on a phone "View shop" keeps its own width and "Edit hero banner" sits above the preview,
    as the card header puts actions everywhere else. Each is how the rest of the app already looks.

### What the mock keeps: `storefront-seed.ts`

```diff
@@ -1,7 +1,13 @@
 import {
   type ShopPaymentMethod,
+  type ShopTextPageSlug,
   slugFromName,
+  STOREFRONT_DEFAULT_THEME,
+  STOREFRONT_HERO_DEFAULT_COLORS,
+  type StorefrontBanner,
   type StorefrontCategory,
+  type StorefrontCollectionSummary,
+  type StorefrontHero,
   type StorefrontImage,
   type StorefrontListing,
   type StorefrontSale,
@@ -22,10 +28,23 @@ import type { WorkspaceData } from './workspace-data';
 // (empty) and Kids; two navy polo shirts and a T-shirt in the shop, a white polo shirt as a draft
 // with no photo, and two kids' styles with no stock in the Main store. The pharma workspace has
 // no shop, so a test can set one up from the start and open it.
+//
+// Step 26h adds the shop's look: a drawn logo and the default colors, an Eid hero, and under the
+// product grid a winter sale banner and three collections (one all in the shop, one partly, one
+// with only the draft, so the shop hides it); Terms & Condition and About Us are written.
 
 // The settings row, as the table keeps it: readiness and the shop's address are worked out on read
 export type MockShop = Omit<StorefrontSettings, 'shopUrl' | 'readiness'>;
 
+// Step 26h: the logo and the two colors. In the API they are columns of the settings row and share
+// its version (decision 12); kept beside it here, so Shop settings' answer stays as it was, and a
+// save of either one raises MockShop's version
+export interface MockTheme {
+  logoImageId: string | null;
+  brandColor: string;
+  accentColor: string;
+}
+
 export type MockCategory = Omit<StorefrontCategory, 'listingCount'>;
 
 export interface MockListing {
@@ -65,15 +84,65 @@ export interface MockPhoto {
   readyAt: number | null;
 }
 
+// Step 26h: a banner as storefront_banners keeps it: the pictures without their files' addresses,
+// which are worked out on read (viewOf). The hero has its words and colors too
+interface KeptPictures {
+  desktopImage: StorefrontImage;
+  phoneImage: StorefrontImage;
+}
+export type MockBanner = Omit<StorefrontBanner, 'desktopImage' | 'phoneImage'> & KeptPictures;
+export type MockHero = Omit<StorefrontHero, 'desktopImage' | 'phoneImage'> & KeptPictures;
+
+// A collection with its listings in their order (storefront_collection_items); the counts are
+// worked out on read
+export type MockCollection = Omit<
+  StorefrontCollectionSummary,
+  'listingCount' | 'publishedCount'
+> & {
+  listingIds: string[];
+};
+
+// One block of the home page, in storefront_home_blocks' order: what it shows, by id
+export interface MockHomeBlock {
+  kind: 'banner' | 'collection';
+  id: string;
+}
+
+// A written text page (storefront_pages). A page not written has no entry
+export interface MockPage {
+  sections: StorefrontSection[];
+  version: number;
+  updatedAt: string;
+}
+
 export interface MockStorefront {
   shop: MockShop | null;
   categories: MockCategory[];
   listings: MockListing[];
   photos: Map<string, MockPhoto>;
+  // Step 26h
+  theme: MockTheme;
+  hero: MockHero | null;
+  banners: MockBanner[];
+  collections: MockCollection[];
+  home: MockHomeBlock[];
+  pages: Map<ShopTextPageSlug, MockPage>;
 }
 
 export function emptyStorefront(): MockStorefront {
-  return { shop: null, categories: [], listings: [], photos: new Map() };
+  return {
+    shop: null,
+    categories: [],
+    listings: [],
+    photos: new Map(),
+    // The table's defaults: the Figma colors and no logo (the Omnivo mark)
+    theme: { logoImageId: null, ...STOREFRONT_DEFAULT_THEME },
+    hero: null,
+    banners: [],
+    collections: [],
+    home: [],
+    pages: new Map(),
+  };
 }
 
 // A drawn packshot for a seeded photo: the garment's colour behind its name. A data: address, so it
@@ -86,10 +155,11 @@ function packshot(label: string, colour: string): string {
 // What a listing without a known photo shows (a seeded listing's photo is always known)
 export const PLACEHOLDER = packshot('', '#D0D5DD');
 
-function seedPhoto(
+// A drawn picture kept like an uploaded one that the job has prepared
+function seedPicture(
   data: WorkspaceData,
-  label: string,
-  colour: string,
+  url: string,
+  size: { width: number; height: number },
   alt: string,
 ): StorefrontImage {
   const id = crypto.randomUUID();
@@ -97,13 +167,42 @@ function seedPhoto(
     id,
     contentType: 'image/svg+xml',
     sizeBytes: 0,
-    url: packshot(label, colour),
-    outcome: { kind: 'ready', width: 600, height: 600 },
+    url,
+    outcome: { kind: 'ready', ...size },
     readyAt: 0,
   });
   return { id, alt };
 }
 
+function seedPhoto(
+  data: WorkspaceData,
+  label: string,
+  colour: string,
+  alt: string,
+): StorefrontImage {
+  return seedPicture(data, packshot(label, colour), { width: 600, height: 600 }, alt);
+}
+
+// Step 26h: a drawn banner picture, its words in it like a real sale banner, so a test can see
+// which picture is where. Plain shapes, no photo: the mock needs no file
+function drawnBanner(
+  size: { width: number; height: number },
+  background: string,
+  words: string,
+  ink: string,
+): string {
+  const { width, height } = size;
+  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}"><rect width="${String(width)}" height="${String(height)}" fill="${background}"/><circle cx="${String(width * 0.78)}" cy="${String(height / 2)}" r="${String(height * 0.32)}" fill="${ink}" opacity=".18"/><text x="${String(width * 0.06)}" y="${String(height * 0.58)}" font-family="sans-serif" font-weight="700" font-size="${String(Math.round(height * 0.16))}" fill="${ink}">${words}</text></svg>`;
+  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
+}
+
+// The shop's own mark, drawn: two letters in the brand color on cream, so it shows on the brand
+// colored header and on the white footer alike
+function drawnLogo(): string {
+  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" rx="80" fill="#F4F5EC"/><text x="200" y="250" font-family="sans-serif" font-weight="700" font-size="150" text-anchor="middle" fill="${STOREFRONT_DEFAULT_THEME.brandColor}">RF</text></svg>`;
+  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
+}
+
 function daysAgo(days: number): string {
   return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
 }
@@ -123,6 +222,7 @@ export function seedStorefront(data: WorkspaceData, garments: boolean): void {
   if (!garments) return;
   const main = data.stock.warehouses.find((place) => place.code === 'MAIN');
   const payments: ShopPaymentMethod[] = ['cod', 'online'];
+  const logo = seedPicture(data, drawnLogo(), { width: 400, height: 400 }, 'Rahman Fashion logo');
   data.storefront.shop = {
     subdomain: 'rahman-fashion',
     name: 'Rahman Fashion',
@@ -145,6 +245,7 @@ export function seedStorefront(data: WorkspaceData, garments: boolean): void {
     version: 4,
     updatedAt: daysAgo(3),
   };
+  data.storefront.theme = { logoImageId: logo.id, ...STOREFRONT_DEFAULT_THEME };
 
   const category = (
     name: string,
@@ -276,4 +377,123 @@ export function seedStorefront(data: WorkspaceData, garments: boolean): void {
       minutes,
     );
   }
+
+  seedAppearance(data, { polos: polos.slug, kids: kids.id });
+}
+
+// Step 26h: the hero, the blocks under the product grid and two written pages
+function seedAppearance(data: WorkspaceData, place: { polos: string; kids: string }): void {
+  const store = data.storefront;
+  const desktop = { width: 1400, height: 560 };
+  const phone = { width: 1080, height: 660 };
+  store.hero = {
+    id: crypto.randomUUID(),
+    href: `/c/${place.polos}`,
+    headline: 'Eid collection: 20% off polo shirts',
+    line: 'Combed cotton pique, knitted in Gazipur.',
+    eyebrow: 'Eid offer',
+    buttonLabel: 'Shop polo shirts',
+    desktopImage: seedPicture(
+      data,
+      drawnBanner(desktop, '#EEE0D8', 'Polo shirts', '#54260A'),
+      desktop,
+      'Navy and white pique polo shirts on a rail',
+    ),
+    phoneImage: seedPicture(
+      data,
+      // No words: the phone hero writes its headline over the picture
+      drawnBanner(phone, '#54260A', '', '#EEE0D8'),
+      phone,
+      'A navy pique polo shirt, folded',
+    ),
+    ...STOREFRONT_HERO_DEFAULT_COLORS,
+    version: 2,
+    updatedAt: daysAgo(5),
+  };
+
+  const wide = { width: 2560, height: 560 };
+  const narrow = { width: 1080, height: 420 };
+  const sale: MockBanner = {
+    id: crypto.randomUUID(),
+    href: '/c/all?offer=1',
+    desktopImage: seedPicture(
+      data,
+      drawnBanner(wide, '#1F2A44', 'WINTER SALE · UP TO 30% OFF', '#FFFFFF'),
+      wide,
+      'Winter sale, up to 30% off',
+    ),
+    phoneImage: seedPicture(
+      data,
+      drawnBanner(narrow, '#1F2A44', 'UP TO 30% OFF', '#FFFFFF'),
+      narrow,
+      'Winter sale, up to 30% off',
+    ),
+    version: 1,
+    updatedAt: daysAgo(4),
+  };
+  store.banners.push(sale);
+
+  // The listings by their link name; a seed that lost one leaves it out
+  const ids = (...slugsWanted: string[]) =>
+    slugsWanted.flatMap((slug) => {
+      const found = store.listings.find((listing) => listing.slug === slug);
+      return found === undefined ? [] : [found.id];
+    });
+  const kids = store.listings.filter((listing) => listing.categoryId === place.kids);
+  const collection = (title: string, icon: 'fire' | null, listingIds: string[]) => {
+    const item: MockCollection = {
+      id: crypto.randomUUID(),
+      title,
+      icon,
+      listingIds,
+      version: 1,
+      updatedAt: daysAgo(4),
+    };
+    store.collections.push(item);
+    return item;
+  };
+  // All three in the shop; the kids' styles are in the shop too, out of stock; the last one holds
+  // only the draft, so the shop hides it and the Home page card says so
+  const trending = collection(
+    'Hot & Trending Right Now',
+    'fire',
+    ids('pique-polo-navy-m', 'basic-crew-neck-t-shirt', 'pique-polo-navy-l'),
+  );
+  const forKids = collection(
+    'For the kids',
+    null,
+    kids.map((listing) => listing.id),
+  );
+  const coming = collection('Coming soon', null, ids('pique-polo-white-m'));
+  store.home = [
+    { kind: 'collection', id: trending.id },
+    { kind: 'banner', id: sale.id },
+    { kind: 'collection', id: forKids.id },
+    { kind: 'collection', id: coming.id },
+  ];
+
+  store.pages.set('terms', {
+    sections: [
+      {
+        heading: 'Delivery',
+        body: '- Inside Dhaka in 2 days, ৳80\n- Outside Dhaka in 3 to 5 days, ৳120\n- Free on orders over ৳2,000',
+      },
+      {
+        heading: 'Returns',
+        body: 'Unworn items with their tags come back within **7 days**. Keep the order number.',
+      },
+    ],
+    version: 1,
+    updatedAt: daysAgo(10),
+  });
+  store.pages.set('about', {
+    sections: [
+      {
+        heading: 'Who we are',
+        body: 'Rahman Fashion knits, dyes and sews its own shirts at its Gazipur factory since 2009.',
+      },
+    ],
+    version: 1,
+    updatedAt: daysAgo(10),
+  });
 }
```

- `MockTheme` is decision 48. `emptyStorefront()` starts it with the table's defaults (the Figma pair, no logo), so a
  shop set up in the mock has the colors a new real shop has.
- `MockBanner` and `MockHero` keep the pictures as the table's `jsonb` keeps them, `{ id, alt }`, without the file's
  address: the address is worked out on read (`viewOf()`), as the API does with its media URL. `KeptPictures` is an
  `interface` because the lint rule asks for one for a plain object shape.
- `MockCollection` keeps only the listing ids, in their order. The two counts are worked out on read, so publishing
  or archiving a listing changes the Home page card at once, with nothing stored to update.
- `home` is the page's order, a list of `{ kind, id }`. Like `storefront_home_blocks`, a block has no id of its own.
- `pages` is a `Map` by slug: a page not written has no entry, which is how the table has no row.
- `seedPicture()` is 26g's `seedPhoto()` with its size and drawing as arguments, so a 1,400 × 560 banner and a
  600 × 600 packshot go through the same code. `seedPhoto()` now calls it.
- `drawnBanner()` writes the banner's words into the picture, like a real sale banner. The phone hero's picture has
  no words (`''`): the phone hero writes its headline over the picture, and two texts on top of each other were
  unreadable in the first run.
- `drawnLogo()` is brand-colored letters on cream. The first try, accent on brand, vanished in the preview's header,
  which is brand-colored too.
- `seedAppearance()` takes the Polo shirts slug and the Kids category id from the seed above, so the hero's link
  and "For the kids" stay right if those rows change. `ids()` skips a slug it cannot find, so a missing listing
  never stops `pnpm dev:mock`.

### The shared helpers: `storefront-data.ts`

```diff
@@ -54,7 +54,7 @@ import { checkVersion, diff, record, type WorkspaceData } from './workspace-data
 const BASE_DOMAIN = 'localhost';
 const SHOP_PORT = 4321;
 
-function shopUrl(subdomain: string, path = ''): string {
+export function shopUrl(subdomain: string, path = ''): string {
   return `http://${subdomain}.${BASE_DOMAIN}:${String(SHOP_PORT)}${path}`;
 }
 
@@ -66,7 +66,7 @@ const OTHER_SHOPS: ReadonlySet<string> = new Set(['nirvor']);
 // seconds, so its first question after the upload already finds the photo ready
 const MOCK_PREPARE_MS = 1_500;
 
-function now(): string {
+export function now(): string {
   return new Date().toISOString();
 }
 
@@ -74,15 +74,15 @@ function money(value: string): string {
   return addMoney(value, '0');
 }
 
-function fieldProblem(code: ErrorCode, field: string): MockProblem {
+export function fieldProblem(code: ErrorCode, field: string): MockProblem {
   return new MockProblem(409, code, { [field]: [code] });
 }
 
-function notSetUp(): MockProblem {
+export function notSetUp(): MockProblem {
   return new MockProblem(409, 'storefront_not_set_up');
 }
 
-function notFound(): MockProblem {
+export function notFound(): MockProblem {
   return new MockProblem(404, 'not_found');
 }
 
@@ -96,8 +96,9 @@ function activeWarehouse(data: WorkspaceData, id: string | null): boolean {
   );
 }
 
-// A published listing the shop would show: its product and variant not archived
-function showable(data: WorkspaceData, listing: MockListing): boolean {
+// A published listing the shop would show: its product and variant not archived. Step 26h: a
+// collection's "in the shop" count uses it too
+export function showable(data: WorkspaceData, listing: MockListing): boolean {
   if (listing.publishedAt === null) return false;
   const found = findVariant(data, listing.variantId);
   return found?.product.archivedAt === null && found.variant.archivedAt === null;
@@ -553,13 +554,14 @@ export function uploadState(data: WorkspaceData, id: string): StorefrontUpload {
   return stateOf(photoOf(data, id));
 }
 
-function isReady(data: WorkspaceData, id: string): boolean {
+export function isReady(data: WorkspaceData, id: string): boolean {
   const photo = data.storefront.photos.get(id);
   return photo !== undefined && stateOf(photo).status === 'ready';
 }
 
-// A saved photo as the editor shows it: the file's address. A seeded photo has a drawn one
-function viewOf(data: WorkspaceData, image: StorefrontImage): StorefrontImageView {
+// A saved photo as the editor shows it: the file's address. A seeded photo has a drawn one. Step 26h:
+// a banner's pictures and the logo too
+export function viewOf(data: WorkspaceData, image: StorefrontImage): StorefrontImageView {
   return { ...image, url: data.storefront.photos.get(image.id)?.url ?? PLACEHOLDER };
 }
 
@@ -594,7 +596,7 @@ function categoryName(data: WorkspaceData, id: string): string {
   return data.storefront.categories.find((category) => category.id === id)?.name ?? '';
 }
 
-function toSummary(data: WorkspaceData, listing: MockListing): StorefrontListingSummary {
+export function toSummary(data: WorkspaceData, listing: MockListing): StorefrontListingSummary {
   const [first] = listing.images;
   const regular = regularOf(data, listing);
   const priced = regular === null ? null : listingPricing(regular, listing.sale, new Date());
@@ -956,6 +958,11 @@ export function removeListing(data: WorkspaceData, id: string, version: number):
   const before = findListing(data, id);
   checkVersion(before.version, version);
   data.storefront.listings = data.storefront.listings.filter((listing) => listing.id !== id);
+  // Step 26h: it leaves every collection too (storefront_collection_items' FK cascades). The
+  // collection's version stays: the database changes no collection row
+  for (const collection of data.storefront.collections) {
+    collection.listingIds = collection.listingIds.filter((listingId) => listingId !== id);
+  }
   record(
     data,
     'storefront_listing.deleted',
```

Only `export` added to eight helpers (decision 49), two comments, and the cascade of decision 50 at the end of
`removeListing()`.

### The rules: `storefront-appearance-data.ts` (new)

```ts
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
```

The shared checks. `requireShop()` is the API's `storefront_not_set_up` for every read and every add.
`full()` names no box: the page shows a full list's error next to its Add button. `checkImages()` asks only a new
picture to be ready; a picture the banner already has was ready when it was saved, the API's rule for listings too.

```ts
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
```

The audit views, field for field the API's, so the audit log page shows the same lines in mock mode. A banner's
snapshot has the hero's fields as `null`, and a delete sets every field to `null`, the kind too: "kind: hero → none"
is how the log tells a deleted hero from a deleted picture banner.

```ts
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
```

The reads. `toCollectionSummary()` counts "in the shop" with 26g's `showable()`: published, and its product and
variant not archived, the launch checklist's rule and the API's SQL `FILTER`. `blocksOf()` skips a block whose banner
or collection it cannot find, like `homeBlocksOf()` in the API: half a block would be worse than a missing one.

```ts
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
```

The theme save checks the settings' version (decision 12), so a Shop settings tab open on version 4 gets a conflict
after this save, then raises it. `diff({ ...before }, after)`: the spread turns the `MockTheme` interface into a plain
object type, which `diff()`'s record type accepts.

```ts
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
```

The hero, with decision 13's two conflicts: no hero but a version (another tab deleted it), or a hero but no version
(another tab made one). Both are `version_conflict`, not a second hero.

```ts
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
```

The page's order. The limits are checked before anything is made, as the API does under its lock. A delete filters
the block out, and the array has no gaps, which is the renumbering the API does by hand. A move at the top or the
bottom answers the page unchanged.

```ts
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
```

Picture banners: at most 6, then room on the page, then the pictures. A new one goes to the end of the page
(decision 2), and its delete takes its block with it, as the foreign key does.

```ts
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
```

Collections. `checkListings()` names the box of the listing that is not there (`listingIds.3`), the API's answer
for a listing deleted in another tab. A save raises the version even when only the listings changed: they are part
of the collection.

```ts
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
```

The text pages: always the four, in the footer's order. A save with `version: null` is the first save, as with the
hero. The audit row is built by hand and keyed by the slug, as the API does, so a change of the text only (same
headings) still has its line.

### The handlers: `handlers.ts`

```diff
@@ -189,6 +189,24 @@ import {
   updateShop,
   uploadState,
 } from './storefront-data';
+import {
+  appearanceOf,
+  collectionOf,
+  createBanner,
+  createCollection,
+  deleteBanner,
+  deleteCollection,
+  deleteHero,
+  deletePage,
+  moveBlock,
+  pageList,
+  saveHero,
+  savePage,
+  textPageOf,
+  updateBanner,
+  updateCollection,
+  updateTheme,
+} from './storefront-appearance-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -5843,4 +5861,169 @@ export const handlers = [
       return reply(routes.storefront.deleteListing, undefined);
     }),
   ),
+
+  // --- Step 26h: Shop appearance and Shop pages (storefront-appearance-data.ts) ----------------
+  // The pictures go up through 26g's upload routes above; these only name them
+
+  mock(
+    routes.storefrontAppearance.getAppearance,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.storefrontAppearance.getAppearance, appearanceOf(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.updateTheme,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontAppearance.updateTheme.body, request);
+      return reply(
+        routes.storefrontAppearance.updateTheme,
+        updateTheme(data, workspace.tenantId, body),
+      );
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.saveHero,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontAppearance.saveHero.body, request);
+      return reply(routes.storefrontAppearance.saveHero, saveHero(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.deleteHero,
+    guarded(({ request }) => {
+      const data = shopData();
+      const { version } = readQuery(routes.storefrontAppearance.deleteHero.query, request);
+      deleteHero(data, version);
+      return reply(routes.storefrontAppearance.deleteHero, undefined);
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.createBanner,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontAppearance.createBanner.body, request);
+      return reply(routes.storefrontAppearance.createBanner, createBanner(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.updateBanner,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontAppearance.updateBanner.params.parse(params);
+      const body = await readBody(routes.storefrontAppearance.updateBanner.body, request);
+      return reply(routes.storefrontAppearance.updateBanner, updateBanner(data, id, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.deleteBanner,
+    guarded(({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontAppearance.deleteBanner.params.parse(params);
+      const { version } = readQuery(routes.storefrontAppearance.deleteBanner.query, request);
+      deleteBanner(data, id, version);
+      return reply(routes.storefrontAppearance.deleteBanner, undefined);
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.getCollection,
+    guarded(async ({ params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontAppearance.getCollection.params.parse(params);
+      await delay();
+      return reply(routes.storefrontAppearance.getCollection, collectionOf(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.createCollection,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontAppearance.createCollection.body, request);
+      return reply(routes.storefrontAppearance.createCollection, createCollection(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.updateCollection,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontAppearance.updateCollection.params.parse(params);
+      const body = await readBody(routes.storefrontAppearance.updateCollection.body, request);
+      return reply(routes.storefrontAppearance.updateCollection, updateCollection(data, id, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.deleteCollection,
+    guarded(({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontAppearance.deleteCollection.params.parse(params);
+      const { version } = readQuery(routes.storefrontAppearance.deleteCollection.query, request);
+      deleteCollection(data, id, version);
+      return reply(routes.storefrontAppearance.deleteCollection, undefined);
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.moveHomeBlock,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontAppearance.moveHomeBlock.body, request);
+      return reply(routes.storefrontAppearance.moveHomeBlock, moveBlock(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.listPages,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.storefrontAppearance.listPages, pageList(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.getPage,
+    guarded(async ({ params }) => {
+      const data = shopData();
+      const { slug } = routes.storefrontAppearance.getPage.params.parse(params);
+      await delay();
+      return reply(routes.storefrontAppearance.getPage, textPageOf(data, slug));
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.savePage,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { slug } = routes.storefrontAppearance.savePage.params.parse(params);
+      const body = await readBody(routes.storefrontAppearance.savePage.body, request);
+      return reply(
+        routes.storefrontAppearance.savePage,
+        savePage(data, workspace.tenantId, slug, body),
+      );
+    }),
+  ),
+
+  mock(
+    routes.storefrontAppearance.deletePage,
+    guarded(({ request, params }) => {
+      const data = shopData();
+      const { slug } = routes.storefrontAppearance.deletePage.params.parse(params);
+      const { version } = readQuery(routes.storefrontAppearance.deletePage.query, request);
+      deletePage(data, workspace.tenantId, slug, version);
+      return reply(routes.storefrontAppearance.deletePage, undefined);
+    }),
+  ),
 ];
```

One `mock()` per route, the same shape as 26g's: `shopData()` first (the `storefront.manage` check), then the body or
the query through the route's own schema, then `reply()`, which checks the answer against the route's response
schema. That check is what makes a mock answer that drifts from the contract fail in the test, not on screen. The
pictures need no new handler: they go up through 26g's upload routes, and these routes only name them by id.

### The shared PNG: `helpers.ts`, `storefront.e2e.ts`

```diff
@@ -1,3 +1,5 @@
+import { crc32, deflateSync } from 'node:zlib';
+
 import { syncPullSchema } from '@omnivo/contracts';
 import { newDeviceId, saveDevice } from '@omnivo/sync';
 import { test as base, expect, type Locator, type Page, type Response } from '@playwright/test';
@@ -207,3 +209,34 @@ export async function actAs(page: Page, role: MockRole): Promise<void> {
     [MOCK_ROLE_KEY, JSON.stringify(role)] as const,
   );
 }
+
+// A real PNG of one grey colour, for a photo or picture upload (step 26g; shared with 26h's
+// pictures). The mock decodes it in the browser like the
+// image job does with sharp, so its size decides: 200 pixels or more on each side is a photo the
+// shop can use, less is "too small". Built here so the test needs no file on disk
+export function png(width: number, height: number): Buffer {
+  const chunk = (type: string, body: Buffer) => {
+    const length = Buffer.alloc(4);
+    length.writeUInt32BE(body.length);
+    const name = Buffer.from(type, 'ascii');
+    const check = Buffer.alloc(4);
+    check.writeUInt32BE(crc32(Buffer.concat([name, body])));
+    return Buffer.concat([length, name, body, check]);
+  };
+  const header = Buffer.alloc(13);
+  header.writeUInt32BE(width, 0);
+  header.writeUInt32BE(height, 4);
+  // 8 bits per channel, RGB; compression, filter and interlace stay 0
+  header[8] = 8;
+  header[9] = 2;
+  // Each row starts with its filter byte (0 = none), then 3 bytes a pixel
+  const row = Buffer.alloc(1 + width * 3, 0xd0);
+  row[0] = 0;
+  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
+  return Buffer.concat([
+    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
+    chunk('IHDR', header),
+    chunk('IDAT', deflateSync(pixels)),
+    chunk('IEND', Buffer.alloc(0)),
+  ]);
+}
```

```diff
@@ -1,5 +1,3 @@
-import { crc32, deflateSync } from 'node:zlib';
-
 import type { Page } from '@playwright/test';
 
 import {
@@ -9,6 +7,7 @@ import {
   listItem,
   openFromNav,
   pinAnswered,
+  png,
   test,
   toastShown,
   waitForCopy,
@@ -19,36 +18,6 @@ import {
 // shirts and a T-shirt in the shop, a white polo shirt as a draft with no photo, and two kids'
 // styles with no stock. The pharma workspace has no shop yet.
 
-// A real PNG of one grey colour, for the photo upload. The mock decodes it in the browser like the
-// image job does with sharp, so its size decides: 200 pixels or more on each side is a photo the
-// shop can use, less is "too small". Built here so the test needs no file on disk
-function png(width: number, height: number): Buffer {
-  const chunk = (type: string, body: Buffer) => {
-    const length = Buffer.alloc(4);
-    length.writeUInt32BE(body.length);
-    const name = Buffer.from(type, 'ascii');
-    const check = Buffer.alloc(4);
-    check.writeUInt32BE(crc32(Buffer.concat([name, body])));
-    return Buffer.concat([length, name, body, check]);
-  };
-  const header = Buffer.alloc(13);
-  header.writeUInt32BE(width, 0);
-  header.writeUInt32BE(height, 4);
-  // 8 bits per channel, RGB; compression, filter and interlace stay 0
-  header[8] = 8;
-  header[9] = 2;
-  // Each row starts with its filter byte (0 = none), then 3 bytes a pixel
-  const row = Buffer.alloc(1 + width * 3, 0xd0);
-  row[0] = 0;
-  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
-  return Buffer.concat([
-    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
-    chunk('IHDR', header),
-    chunk('IDAT', deflateSync(pixels)),
-    chunk('IEND', Buffer.alloc(0)),
-  ]);
-}
-
 async function start(page: Page): Promise<void> {
   await page.goto('/');
   await waitForCopy(page);
```

The function moved without a change (decision 51).

### The tests: `storefront-appearance.e2e.ts` (new)

Each test runs twice, at 1280 pixels and on a 390-pixel phone (the config's two projects).

```ts
import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  pinAnswered,
  png,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 26h: Shop appearance and Shop pages on the mock (mocks/storefront-appearance-data.ts).
// Rahman Fashion has a drawn logo and the default colors, an Eid hero that links to Polo shirts,
// and under the product grid: Hot & Trending Right Now (three listings, all in the shop), the
// winter sale picture banner, For the kids (two listings) and Coming soon (only the draft, so the
// shop hides it). Terms & Condition and About Us are written. Karim Pharma has no shop.

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

// The Home page card's rows, top to bottom, by their first line
function homeRows(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Home page' }) })
    .getByRole('listitem');
}
```

`homeRows()` finds the Home page card by its heading and reads its list items, so the order checks read the page
the way a person does, top to bottom.

```ts
test('keeps the two colors readable together and saves them', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await expectNoSideScroll(page);
  await expect(page.getByRole('img', { name: 'Rahman Fashion logo' })).toBeVisible();
  await expect(page.getByText('4 of 12 blocks')).toBeVisible();

  // A light brand color: names on cream would be hard to read, and the accent is too close to it.
  // The lines say so as it is typed, and the save is refused on both boxes
  await page.getByLabel('Brand color', { exact: true }).fill('#9ad0c2');
  await expect(page.getByText('Too low')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await expect(page.getByText(/^Names and titles in this color are hard to read/)).toBeVisible();
  await expect(page.getByText(/^This color is too close to the brand color\./)).toBeVisible();

  // Back to the Figma pair, then a warmer accent that still keeps 4.5:1 with it
  await page.getByRole('button', { name: 'Use the default colors' }).click();
  await expect(page.getByLabel('Brand color', { exact: true })).toHaveValue('#005859');
  await expect(page.getByText('Too low')).toHaveCount(0);
  await page.getByLabel('Accent color', { exact: true }).fill('#FFD166');
  await page.getByRole('button', { name: 'Save changes' }).first().click();
  await toastShown(page, 'Logo and colors saved');

  // The colors share the settings row's version: Shop settings saves after it without a conflict
  await openFromNav(page, 'Shop settings');
  await page.getByLabel('Hotline').fill('09612-345679');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Shop settings saved');
  await openFromNav(page, 'Shop appearance');
  await expect(page.getByLabel('Accent color', { exact: true })).toHaveValue('#ffd166');
});
```

The colors. A light brand color fails both checks at once (on cream, and next to the light accent), so two "Too
low" lines and two errors. The last part is decision 12 seen from the screen: Shop settings saves after the colors
without a conflict, because the colors' save made the menu read the settings again.

```ts
test('changes the hero, refuses words that would be hard to read, and deletes it', async ({
  page,
}) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await page.getByRole('link', { name: 'Edit hero banner' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Edit the hero banner' })).toBeVisible();
  await expectNoSideScroll(page);
  await expect(page.getByText('Goes to /c/polo-shirts')).toBeVisible();

  // The button's words the color of the button: the contrast line and the save both say so
  await page.getByLabel('Button’s words', { exact: true }).fill('#e7d1b2');
  await expect(page.getByText('Too low')).toHaveCount(1);
  await page.getByLabel('Headline', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/^The button’s words are hard to read on it\./)).toBeVisible();
  await expect(page.getByText('Fill in this field.')).toBeVisible();

  await page.getByLabel('Button’s words', { exact: true }).fill('#8b471f');
  await page.getByLabel('Headline', { exact: true }).fill('Winter polo shirts, 20% off');
  await page.getByLabel('Links to').selectOption({ label: 'All products' });
  await expect(page.getByText('Goes to /c/all')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Hero banner saved');

  await page.getByRole('link', { name: 'Shop appearance' }).first().click();
  await expect(page.getByText(/^Winter polo shirts, 20% off\s*Goes to \/c\/all$/)).toBeVisible();

  await page.getByRole('link', { name: 'Edit hero banner' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete hero banner' }).click();
  await page
    .getByRole('dialog', { name: 'Delete the hero banner?' })
    .getByRole('button', { name: 'Delete hero banner' })
    .click();
  await toastShown(page, 'Hero banner deleted');
  await expect(page.getByRole('heading', { level: 1, name: 'Shop appearance' })).toBeVisible();
  await expect(
    page.getByText('No hero banner. The home page starts with its products.'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add hero banner' })).toBeVisible();
});
```

The hero. The error words are the API's error codes through `errors.*`, checked by their start, so a later change
of the second sentence does not break the test. The headline is emptied on purpose: the form shows every error at
once, not one per click.

```ts
test('adds a picture banner at the end, moves it up and deletes a collection', async ({ page }) => {
  // Two pictures the pretend job prepares
  test.slow();
  await start(page);
  await openFromNav(page, 'Shop appearance');
  const rows = homeRows(page);
  await expect(rows).toHaveText([
    /^Hot & Trending Right Now/,
    /^Picture banner: Winter sale/,
    /^For the kids/,
    /^Coming soon/,
  ]);
  // The row with only the draft: the shop hides it, and the card says why
  await expect(rows.nth(3)).toContainText('None in the shop now, so the row is hidden');

  await page.getByRole('button', { name: 'Add picture banner' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a picture banner' });
  // Nothing uploaded: both boxes ask for a picture
  await dialog.getByRole('button', { name: 'Add banner' }).click();
  await expect(dialog.getByText('Upload a picture.')).toHaveCount(2);

  for (const [name, width, height, alt] of [
    ['Picture for computers', 1280, 280, 'Pohela Boishakh sale, 25% off panjabi'],
    ['Picture for phones', 540, 210, 'Pohela Boishakh sale, 25% off panjabi'],
  ] as const) {
    const box = dialog.getByRole('group', { name });
    await box.locator('input[type="file"]').setInputFiles({
      name: 'boishakh.png',
      mimeType: 'image/png',
      buffer: png(width, height),
    });
    // Uploaded, then prepared: the alt box stays, the status line goes
    await expect(box.getByRole('button', { name: 'Replace picture' })).toBeVisible({
      timeout: 10_000,
    });
    await box.getByLabel('What the picture shows').fill(alt);
  }
  await dialog.getByLabel('Links to').selectOption({ label: 'Products on offer' });
  await expect(dialog.getByText('Goes to /c/all?offer=1')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add banner' }).click();
  await toastShown(page, 'Picture banner added at the end of the home page');
  await expect(page.getByText('5 of 12 blocks')).toBeVisible();
  await expect(rows.last()).toContainText('Picture banner: Pohela Boishakh sale');

  await page
    .getByRole('button', { name: 'Move Picture banner: Pohela Boishakh sale, 25% off panjabi up' })
    .click();
  await expect(rows).toHaveText([
    /^Hot & Trending Right Now/,
    /^Picture banner: Winter sale/,
    /^For the kids/,
    /^Picture banner: Pohela Boishakh sale/,
    /^Coming soon/,
  ]);
  // The first block cannot go higher
  await expect(
    page.getByRole('button', { name: 'Move Hot & Trending Right Now up' }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Actions for Coming soon' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Coming soon?' })
    .getByRole('button', { name: 'Delete collection' })
    .click();
  await toastShown(page, 'Coming soon deleted');
  await expect(page.getByText('4 of 12 blocks')).toBeVisible();
  await expect(rows.last()).toContainText('Picture banner: Pohela Boishakh sale');
  await expectNoSideScroll(page);
});
```

A picture banner. The PNGs are 1280 × 280 and 540 × 210: both over 200 pixels on the short side, so the pretend job
prepares them. The test waits for "Replace picture", which shows only once the picture is ready; then "Add banner"
is sure to send ready pictures. `test.slow()` gives the two pretend jobs time on a busy machine.

```ts
test('makes a collection from the catalog, in the order picked', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop appearance');
  await page.getByRole('link', { name: 'Add collection' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New collection' })).toBeVisible();
  await expectNoSideScroll(page);

  // Empty: a title and a product are both needed
  await page.getByRole('button', { name: 'Add collection' }).click();
  await expect(page.getByText('Fill in this field.')).toBeVisible();
  await expect(page.getByText('Add at least one product to the collection.')).toBeVisible();

  await page.getByRole('textbox', { name: 'Title' }).fill('Eid picks');
  await page.getByLabel('Show a flame after the title').check();
  for (const [search, option] of [
    ['white', /^Pique polo shirt · White · M/],
    ['crew', /^Basic crew-neck T-shirt/],
  ] as const) {
    await page.getByRole('button', { name: 'Product to add' }).click();
    await page.getByRole('combobox', { name: 'Search the catalog' }).fill(search);
    await page.getByRole('option', { name: option }).click();
  }
  await expect(page.getByText('2 of 24')).toBeVisible();
  await expect(
    page.getByText('Drafts stay here and show in the row once they are in the shop.'),
  ).toBeVisible();
  // The T-shirt first: the row shows them in this order
  await page.getByRole('button', { name: 'Move Basic crew-neck T-shirt up' }).click();
  await page.getByRole('button', { name: 'Add collection' }).click();
  await toastShown(page, 'Eid picks added at the end of the home page');

  await page.getByRole('link', { name: 'Shop appearance' }).first().click();
  const last = homeRows(page).last();
  await expect(last).toContainText('Eid picks');
  // One of the two is a draft
  await expect(last).toContainText('1 of 2 in the shop');
  await last.getByRole('link', { name: 'Eid picks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eid picks' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Basic crew-neck T-shirt' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Move Basic crew-neck T-shirt up' }),
  ).toBeDisabled();
});
```

A collection, empty first (both errors), then two listings picked through the search box, one a draft, and moved.
"1 of 2 in the shop" on the Home page card is decision 47's count at work.

```ts
test('writes a text page into the footer and deletes another', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop pages');
  await expectNoSideScroll(page);
  // A table row on a computer, a card on a phone
  const row = (name: string) => listItem(page, new RegExp(`^${name}`));
  await expect(row('Privacy Policy')).toContainText('Not written');
  await expect(row('Terms & Condition')).toContainText('2 sections');

  await row('Privacy Policy').getByRole('link', { name: 'Write' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  await expect(page.getByText(/^This page is not written yet\./)).toBeVisible();
  await page.getByRole('button', { name: 'Add section' }).click();
  const section = page.getByRole('group', { name: 'Section 1' });
  await section.getByLabel('Heading').fill('What we keep');
  await section
    .getByLabel('Text')
    .fill('Your name, phone and address, **only** to deliver the order.');
  await section.getByRole('button', { name: 'Preview' }).click();
  // The shop's own HTML: the stars became bold
  await expect(section.locator('strong')).toHaveText('only');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Privacy Policy is in the shop');
  await expect(page.getByText(/^This page is not written yet\./)).toHaveCount(0);

  await page.getByRole('link', { name: 'Shop pages' }).first().click();
  await expect(row('Privacy Policy')).toContainText('In the footer');
  await expect(row('Privacy Policy')).toContainText('1 section');

  await row('About Us').getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await page
    .getByRole('dialog', { name: 'Delete About Us?' })
    .getByRole('button', { name: 'Delete page' })
    .click();
  await toastShown(page, 'About Us deleted');
  await expect(row('About Us')).toContainText('Not written');
});
```

The pages. `listItem()` is the helper that finds a table row on a computer and a card on a phone; the first run
used `getByRole('row')` and failed on the phone. The preview's `<strong>` shows that the shop's renderer, not the
form, turned the stars into bold.

```ts
test('asks a workspace with no shop to set it up first', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');
  await openFromNav(page, 'Shop appearance');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await openFromNav(page, 'Shop pages');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await page.getByRole('button', { name: 'Go to shop settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop settings' })).toBeVisible();
});

test('hides Shop appearance and Shop pages from a role without the permission', async ({
  page,
}) => {
  await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
  await start(page);
  await pinAnswered(page);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Shop appearance' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Shop pages' })).toHaveCount(0);
});
```

The workspace with no shop, and the role without `storefront.manage`.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                   # 229 tests, none new (the mock has no unit tests)
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src/mocks apps/app/e2e
pnpm exec prettier --check apps/app/src/mocks apps/app/e2e
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts \
  storefront-appearance storefront.e2e audit-and-preferences settings.e2e --workers=2
```

The new file: 14 tests (7 on each size) pass; 26g's storefront tests, the audit log and Settings: 28 pass.

Broken on purpose (and put back): a new picture banner going to the top of the page (`unshift`), and "in the shop"
counting drafts too. The banner test and the collection test fail.

## 26h.8 — A demo shop on your dev stack: `pnpm seed:shop`

Until now a launched shop existed only after someone clicked through every Storefront screen. This part adds one
command that does all of it on the running dev stack (`pnpm dev`): it signs up a demo workspace, sets it up, adds 62
products and their opening stock, sets the shop up, uploads 26 photos, lists the products, makes the hero, the Mega
Sale banner and three rows, writes the four pages and opens the shop. Then the real shop, read from the API, looks
like the mock shop the design was built from.

It talks to the API over HTTP only, exactly like the ERP's screens. Nothing goes into the database directly, so every
rule of the API (contrast, limits, photos ready, the launch checklist) checks the demo data too. That also makes the
seed a smoke test of the whole storefront path, from the photo upload to the shop's product page.

Decisions in this part (53 and 54 are the user's, the rest mine):

53. **The seed lives in `apps/shop/scripts`.** The mock shop's 62 listings, 8 categories, home page and photos are in
    `apps/shop`. A script there reads them directly, so the real shop and the mock shop can never drift apart. The
    API package may not import `apps/shop` (the boundaries check), so a seed in `apps/api` would need a copy of all
    that data. `tsx` runs it (already in the lockfile, used by `packages/db`), and its own `scripts/tsconfig.json`
    type-checks it.
54. **A sale only where the mock has one.** The regular price is the mock's struck-out price, or its price when it has
    none. A struck-out price becomes a "sell at" sale, and a percent ribbon becomes a percent sale. The mock's
    "৳10 OFF" ribbon on most cards is a design placeholder with no struck-out price beside it; in the real shop a
    ribbon always comes from a sale, so those cards get no sale and show only their price. The Neem face wash gets
    ৳299 → ৳229 with a sale that ends 1 day 12 hours later, so its countdown shows, as in Figma.
55. **Every call names a contract route.** `SeedApi.call(routes.products.create, { body })` takes its path, method,
    body type and answer type from `@omnivo/contracts`, like the app's `call()`. The answer is parsed with the route's
    schema. A field renamed in a contract breaks the seed's type check instead of a seed run on someone's machine.
56. **The sign-up is the "already there" check.** Signing up with a taken workspace slug answers `slug_taken`. The
    seed then stops before it changes anything, prints the sign-in, and exits with 1. The sign-up is atomic, so two
    runs at once cannot both make the workspace. A run that stops after the sign-up says the workspace is half made.
    `SEED_SHOP_SLUG` makes a second demo next to the first.
57. **The phone Mega Sale picture is now Figma's 2× export.** The mock's file was the 1× export, 361 × 140 pixels. The
    photo job refuses any side under 200 pixels (`storefront_image_too_small`, 26g), and that rule is right for a
    tenant's pictures. So `apps/shop/public/mock/banners/mega-sale-phone.jpg` is replaced by the same Figma frame
    (`mega-sale`, 138:841) exported at 2×: 722 × 280, the same picture. The mock shop draws it at 140 pixels high as
    before, now sharp on a phone's screen too.
58. **Published from the end.** The shop's "Newest" order (its home grid and `/c/all`) is the order the listings were
    published, newest first. The mock lists its catalog newest first, so the seed publishes it from the last listing
    to the first. The mock's first card is then the real shop's newest.
59. **One simple product per listing.** Its name is the shop's name with the pack size ("Cold drinks (Sprite) 500ml"),
    as a shopkeeper names a product; the listing keeps the shop's shorter name. Its code and SKU are the next product
    number (P-00001), except the design product's own "MD2346". Its sale price is the regular price, and the listing
    keeps no price of its own.
60. **Opening stock: 48 of each, at 70% of the price.** One posted opening adjustment in MAIN, for the 58 products
    the mock has in stock. The 4 it shows out of stock get none, so the real shop says "Out of stock" on the same
    cards. The date is the workspace's day in Dhaka, not the UTC day.
61. **The pages and the Neem description are typed as sections.** The API takes no HTML from a tenant (26g, decision
    6), so the mock's HTML is typed again the way a tenant writes it: headings and text boxes with `- ` lists, `1.`
    lists, `**bold**` and links. The hotline on the contact page is plain text, because a section's link is https://
    or a path of the shop, never `tel:`.
62. **No theme and no logo.** The mock shop uses the default colors and the Omnivo mark, which is what a new shop has.
63. **Never in CI.** It needs the API and its worker running, and it makes a workspace. `SEED_API_URL` points it at
    another API (the default is `http://localhost:3000`, the dev API). The owner is a made-up person with a `.test`
    address, a domain that never receives mail.

### The API client: `seed-client.ts` (new)

```ts
import {
  buildPath,
  problemSchema,
  routes,
  type LoginInput,
  type RouteDef,
  type RouteRequest,
  type RouteResult,
  type SignUpInput,
} from '@omnivo/contracts';

// Step 26h: the seed's way to the API. Every call names a route of the contracts, so the path,
// the method, what is sent and what comes back are the same types the ERP's screens use: a field
// renamed in a contract breaks the seed's type check, not the seed's run on someone's machine.

// A refusal, with the API's own error code ("slug_taken"), so the seed can tell "this demo shop is
// there already" from a real problem
export class SeedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SeedApiError';
  }
}

// The loose shape the one implementation takes; call()'s signature below is the strict one, from
// the route, like apps/app/src/lib/api.ts
interface RequestParts {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

// No second argument for a route that takes nothing (GET /setup), a required one for a route
// with a body or path params. `& RequestParts` lets TypeScript see that the strict input fits the
// implementation's loose one, without a cast
type CallArgs<R extends RouteDef> =
  Partial<RouteRequest<R>> extends RouteRequest<R>
    ? [input?: RouteRequest<R> & RequestParts]
    : [input: RouteRequest<R> & RequestParts];

export class SeedApi {
  private accessToken: string | null = null;
  // Kept so a token that runs out (15 minutes, apps/api/src/config.ts) is replaced by signing in
  // again. A slow machine with the worker busy can take longer than that to make every photo
  private login: LoginInput | null = null;

  constructor(private readonly baseUrl: string) {}

  // Sign-up answers with a session, like a login, so the seed starts signed in as the owner
  async signUp(input: SignUpInput): Promise<void> {
    const session = await this.call(routes.auth.signUp, { body: input });
    this.accessToken = session.accessToken;
    this.login = {
      workspace: input.workspaceSlug,
      email: input.email,
      password: input.password,
      keepSignedIn: false,
    };
  }

  call<R extends RouteDef>(route: R, ...args: CallArgs<R>): Promise<RouteResult<R>>;
  async call(route: RouteDef, input: RequestParts = {}): Promise<unknown> {
    let response = await this.send(route, input);
    // A 401 with a token = the token ran out. Signing in again once is enough; a second 401 is a
    // real refusal and goes to the caller like any other
    if (response.status === 401 && this.accessToken !== null && this.login !== null) {
      const session = await this.call(routes.auth.login, { body: this.login });
      this.accessToken = session.accessToken;
      response = await this.send(route, input);
    }
    return this.read(route, response);
  }

  // The file straight to storage, with the signed headers exactly as the API gave them (the
  // signature covers them). Not our API: no token, and the answer has no body to read
  // Uint8Array<ArrayBuffer>, what readFile gives: fetch takes no view of a SharedArrayBuffer
  async put(
    url: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const response = await fetch(url, { method: 'PUT', headers, body });
    if (!response.ok) {
      throw new SeedApiError(
        response.status,
        'upload_incomplete',
        `PUT to storage ${String(response.status)}`,
      );
    }
  }

  private async send(route: RouteDef, input: RequestParts): Promise<Response> {
    const url = new URL(`${this.baseUrl}${buildPath(route.path, input.params)}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers();
    if (this.accessToken !== null) headers.set('authorization', `Bearer ${this.accessToken}`);
    if (input.body !== undefined) headers.set('content-type', 'application/json');
    try {
      return await fetch(url, {
        method: route.method,
        headers,
        body: input.body === undefined ? null : JSON.stringify(input.body),
      });
    } catch {
      // fetch throws only when no answer came: the API is not running, or on another port
      throw new SeedApiError(
        0,
        'network_error',
        `${route.method} ${route.path}: no answer from ${this.baseUrl}`,
      );
    }
  }

  // The answer parsed with the route's own schema, so the seed gets the same types the screens
  // get, and an API that breaks its contract stops the seed at that call, with its name
  private async read(route: RouteDef, response: Response): Promise<unknown> {
    const body: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => null);
    if (!response.ok) {
      const problem = problemSchema.safeParse(body);
      if (!problem.success) {
        throw new SeedApiError(
          response.status,
          'unknown_error',
          `${route.method} ${route.path} ${String(response.status)}`,
        );
      }
      const fields = Object.entries(problem.data.fieldErrors ?? {})
        .map(([field, codes]) => `${field}: ${codes.join(', ')}`)
        .join('; ');
      throw new SeedApiError(
        response.status,
        problem.data.code,
        `${route.method} ${route.path} ${String(response.status)} ${problem.data.code}${fields === '' ? '' : ` (${fields})`}`,
      );
    }
    const parsed = route.response.safeParse(body);
    if (!parsed.success) {
      throw new SeedApiError(
        response.status,
        'unexpected_response',
        `${route.method} ${route.path} broke its contract`,
      );
    }
    return parsed.data;
  }
}
```

- `CallArgs` and the `call()` overload are the app's (`apps/app/src/lib/api.ts`): a route with nothing to send takes
  no second argument, and a route with a body or path parameters must get them. The loose `RequestParts` is only for
  the one implementation; callers always see the strict type from the route.
- `read()` parses the answer with `route.response`. Without it the seed would get `unknown` back and would need casts;
  with it, an API that breaks its contract stops the seed at that call, with the route's name.
- A refusal becomes a `SeedApiError` with the API's own error code, read with `problemSchema`. The seed needs the code
  to tell "this demo is there already" (`slug_taken`) from a real problem. The field errors are added to the message,
  because "400 validation_failed" alone does not say which field.
- An access token lasts 15 minutes. A slow machine with a busy worker could pass that, so a 401 signs in again once,
  with the sign-up's own details, and repeats the call. A second 401 is a real refusal.
- `put()` sends the file to storage with the signed headers exactly as the API gave them; the signature covers them. It
  takes `Uint8Array<ArrayBuffer>`, what `readFile` gives: `fetch` does not take a view of a `SharedArrayBuffer`.

### What the seed makes: `seed-plan.ts` (new)

```ts
import { extname, join } from 'node:path';

import {
  percentOfMoney,
  type RouteRequest,
  type routes,
  type ShopCategory,
  type ShopListing,
  type StorefrontSale,
  type StorefrontSection,
} from '@omnivo/contracts';

import { mockCheckoutSettings } from '../src/data/mock/checkout';
import { mockHome } from '../src/data/mock/home';
import { mockCatalog, mockProductPage } from '../src/data/mock/products';
import { mockCategories, mockShop } from '../src/data/mock/shop';
import { DESCRIPTIONS } from './seed-words';

// Step 26h: what the seed makes, worked out from the mock shop (apps/shop/src/data/mock) before
// anything is sent. The mock is the Figma design's shop, so the real shop the seed makes looks
// like the one `pnpm dev` shows with no API: the same 62 listings, categories, photos, hero, Mega
// Sale banner and three rows. Pure functions only (no fetch, no clock of its own), so
// seed-plan.spec.ts checks every body against its contract without an API.

// The photos are the mock's own files, served by the mock shop from public/
export const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

export interface SeedPhoto {
  // "/mock/products/sprite-cold-drink-500ml.png": the mock's address, and the key the seed keeps
  // the uploaded photo's id under
  url: string;
  file: string;
  contentType: 'image/png' | 'image/jpeg';
}

export interface SeedListing {
  slug: string;
  // The stock item's name in the ERP: the shop's name with its pack size, as a shopkeeper names
  // a product ("Cold drinks (Sprite) 500ml"). The listing keeps the shop's shorter name
  productName: string;
  name: string;
  packSize: string;
  // '' = the product's own code (P-00001), what a new product gets without a SKU
  sku: string;
  // The variant's sale price: what the shop shows struck out while a sale runs
  regularPrice: string;
  sale: StorefrontSale | null;
  badges: ShopListing['badges'];
  // The mock's category id ("cat-tea"); the seed swaps it for the real one
  categoryKey: string;
  photos: { url: string; alt: string }[];
  descriptionSections: StorefrontSection[];
  // null = none in stock, so the shop shows "Out of stock" as the mock does
  stock: string | null;
  // The opening stock's cost per piece. Not the shop's business, but a stock entry needs one, and
  // a margin report on the demo workspace then says something
  unitCost: string;
}

// The shop's own price rules (listingPricing) turn these into what the mock shows:
// - a struck-out price in the mock = a "sell at" sale from the struck-out price, so the card shows
//   the mock's price and the struck-out one ("৳229", "৳299") and the ribbon says the difference;
// - a percent ribbon without a struck-out price = a percent sale on the mock's price;
// - the "৳10 OFF" ribbon the mock puts on most cards is the design's placeholder, with no struck-out
//   price beside it; a real ribbon always comes from a sale, so those cards get no sale (the user's
//   choice, 26h.8)
function pricing(listing: ShopListing, saleUntil: string | null) {
  if (listing.compareAtPrice !== null) {
    return {
      regularPrice: listing.compareAtPrice,
      sale: {
        kind: 'price',
        value: listing.price,
        startsAt: null,
        endsAt: saleUntil,
      } satisfies StorefrontSale,
    };
  }
  if (listing.discount?.kind === 'percent') {
    return {
      regularPrice: listing.price,
      sale: {
        kind: 'percent',
        value: String(listing.discount.value),
        startsAt: null,
        endsAt: saleUntil,
      } satisfies StorefrontSale,
    };
  }
  return { regularPrice: listing.price, sale: null };
}

// The product page's photos, each once: the mock's design product shows its two photos twice
// (Figma's four thumbnails), which a real listing may not (storefront_image_twice)
function photosOf(images: readonly { url: string; alt: string }[]): SeedListing['photos'] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
}

// `now` decides when the design product's sale ends (1 day 12 hours later, like the mock's)
export function seedListings(now: Date): SeedListing[] {
  return mockCatalog.map((listing) => {
    const page = mockProductPage(listing.slug, now);
    if (page === null) throw new Error(`the mock has no product page for ${listing.slug}`);
    const { product } = page;
    const { regularPrice, sale } = pricing(listing, product.saleUntil);
    return {
      slug: listing.slug,
      productName: listing.name.endsWith(listing.packSize)
        ? listing.name
        : `${listing.name} ${listing.packSize}`,
      name: listing.name,
      packSize: listing.packSize,
      sku: product.sku ?? '',
      regularPrice,
      sale,
      badges: listing.badges,
      categoryKey: listing.categoryId,
      photos: photosOf(product.images),
      descriptionSections: DESCRIPTIONS[listing.slug] ?? [],
      stock: listing.inStock ? '48' : null,
      unitCost: percentOfMoney(regularPrice, '70'),
    };
  });
}

// The mock lists a category after its parent, so creating them in this order always has the
// parent's real id ready (seed-plan.spec.ts checks it)
export const seedCategories: readonly ShopCategory[] = mockCategories;

function photo(url: string): SeedPhoto {
  const extension = extname(url);
  if (extension !== '.png' && extension !== '.jpg') throw new Error(`no content type for ${url}`);
  return {
    url,
    file: join(PUBLIC_DIR, url),
    contentType: extension === '.png' ? 'image/png' : 'image/jpeg',
  };
}

const heroImages = mockHome.hero;

// The mock home's one picture banner, Mega Sale. A function, so its type is the banner and never
// undefined inside the functions below (a narrowed const would not stay narrowed there)
function pictureBanner() {
  for (const block of mockHome.blocks) if (block.kind === 'image') return block;
  throw new Error('the mock home has no picture banner');
}
const megaSale = pictureBanner();

// Every file to upload, each once: 22 product photos for 62 listings (another pack size of a
// product shows that product's photo), plus the hero's two and the Mega Sale's two
export function seedPhotos(listings: readonly SeedListing[]): SeedPhoto[] {
  const urls = new Set<string>([
    ...listings.flatMap((listing) => listing.photos.map((image) => image.url)),
    heroImages.desktopImage.url,
    heroImages.phoneImage.url,
    megaSale.desktopImage.url,
    megaSale.phoneImage.url,
  ]);
  return [...urls].map(photo);
}

// The bodies, with the real ids handed in. Types from the routes, so a body that a contract would
// refuse does not type-check (and seed-plan.spec.ts parses each with its schema too)
type Body<R> = RouteRequest<R> extends { body: infer B } ? B : never;
export type SettingsBody = Body<typeof routes.storefront.createSettings>;
export type ListingBody = Body<typeof routes.storefront.updateListing>;
export type HeroBody = Body<typeof routes.storefrontAppearance.saveHero>;
export type BannerBody = Body<typeof routes.storefrontAppearance.createBanner>;

// The mock shop's settings: its name, hotline, address and social pages, and the checkout's two
// zones, free delivery and minimum order, so the real checkout charges what the mock's does
export function settingsBody(subdomain: string, warehouseId: string): SettingsBody {
  return {
    subdomain,
    name: mockShop.name,
    language: mockShop.language,
    hotline: mockShop.hotline,
    address: mockShop.address,
    facebookUrl: mockShop.social.facebook,
    instagramUrl: mockShop.social.instagram,
    xUrl: mockShop.social.x,
    linkedinUrl: mockShop.social.linkedin,
    defaultWarehouseId: warehouseId,
    // id null = new zones, named by the API
    deliveryZones: mockCheckoutSettings.zones.map((zone) => ({
      id: null,
      name: zone.name,
      charge: zone.charge,
    })),
    freeDeliveryFrom: mockCheckoutSettings.freeDeliveryFrom,
    minimumOrder: mockCheckoutSettings.minimumOrder,
    paymentMethods: [...mockCheckoutSettings.paymentMethods],
  };
}

// The editor's whole form for one listing. Its slug is the mock's, so every link of the mock
// (/p/himalaya-purifying-neem-face-wash-150ml) works on the real shop too
export function listingBody(
  listing: SeedListing,
  version: number,
  categoryId: string,
  imageIds: ReadonlyMap<string, string>,
): ListingBody {
  return {
    version,
    name: listing.name,
    slug: listing.slug,
    packSize: listing.packSize,
    categoryId,
    // '' = the variant's sale price, which the seed set to the regular price
    priceOverride: '',
    sale: listing.sale,
    badges: listing.badges,
    images: listing.photos.map((image) => ({ id: idOf(imageIds, image.url), alt: image.alt })),
    descriptionSections: listing.descriptionSections,
    // '' = the shop's own: the name, and the start of the description
    seoTitle: '',
    seoDescription: '',
  };
}

export function idOf(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`no id for ${key}`);
  return id;
}

// The hero of the mock home, the Figma one. version null = there is no hero yet
export function heroBody(imageIds: ReadonlyMap<string, string>): HeroBody {
  const hero = mockHome.hero;
  return {
    version: null,
    href: hero.href,
    headline: hero.headline,
    line: hero.line,
    eyebrow: hero.eyebrow,
    buttonLabel: hero.buttonLabel,
    desktopImage: { id: idOf(imageIds, hero.desktopImage.url), alt: hero.desktopImage.alt },
    phoneImage: { id: idOf(imageIds, hero.phoneImage.url), alt: hero.phoneImage.alt },
    backgroundColor: hero.colors.background,
    panelColor: hero.colors.panel,
    buttonColor: hero.colors.button,
    buttonTextColor: hero.colors.buttonText,
  };
}

export function megaSaleBody(imageIds: ReadonlyMap<string, string>): BannerBody {
  return {
    href: megaSale.href,
    desktopImage: { id: idOf(imageIds, megaSale.desktopImage.url), alt: megaSale.desktopImage.alt },
    phoneImage: { id: idOf(imageIds, megaSale.phoneImage.url), alt: megaSale.phoneImage.alt },
  };
}

// The three rows under the banner, in the mock's order, each as the listings' slugs
export const seedCollections = mockHome.blocks.flatMap((block) =>
  block.kind === 'collection'
    ? [
        {
          title: block.collection.title,
          icon: block.collection.icon,
          slugs: block.collection.listings.map((listing) => listing.slug),
        },
      ]
    : [],
);
```

- Pure functions only. Nothing here calls the API or reads the clock, so `seed-plan.spec.ts` checks every body
  without a running stack. `seedListings(now)` takes the time to work out when the design product's sale ends.
- `pricing()` is decision 54. `satisfies StorefrontSale` checks each sale against the contract's type at the place it
  is written.
- `photosOf()` keeps each photo once. The mock's design product shows its two photos twice (Figma's four thumbnails),
  but a listing may not hold one photo twice (`storefront_image_twice`, 26g).
- `seedListings()` uses `mockProductPage()`, not the card, because the product page has the photos, the SKU and the
  sale's end. Another pack size of a product shows that product's photo, so 62 listings need only 22 product photos.
- `pictureBanner()` is a function and not a narrowed `const`: TypeScript does not keep a narrowing inside the other
  functions of the file, so a `const` would be "possibly undefined" in each of them.
- `seedPhotos()` collects every file once: 22 product photos, the hero's two and the Mega Sale's two.
- The body types (`SettingsBody`, `ListingBody`, …) come from the routes, so a body the contract would refuse does
  not type-check. The real ids are handed in as arguments; the plan never knows them.
- `listingBody()` keeps the mock's slug, so every link of the mock works on the real shop
  (`/p/himalaya-purifying-neem-face-wash-150ml`). `priceOverride: ''` means "the variant's price", which the seed set
  to the regular price.

### The words: `seed-words.ts` (new)

```ts
import type { ShopTextPageSlug, StorefrontSection } from '@omnivo/contracts';

import { mockCheckoutSettings } from '../src/data/mock/checkout';
import { mockShop } from '../src/data/mock/shop';
import { shopMoney } from '../src/lib/money';

// Step 26h: the words the seed types into the editors. They are the mock's (products.ts and
// pages.ts), written the way the tenant writes them: sections of a heading and a text box, with
// "- " lists, "1. " numbered lists, **bold** and [links](/track) (renderSections). The mock's own
// HTML cannot be sent: the API takes no HTML from a tenant (decision 6 of 26g), and makes it.
// Two small differences from the mock follow from that: the hotline is plain text, not a tel:
// link (a section's link is https:// or a path of the shop), and "&amp;" is typed as "&" (the API
// escapes what is typed).

const NEEM = 'Himalaya Purifying Neem Face Wash';

// By the listing's slug. Only the design product has a description; every other product page
// leaves out its Overview card, as in the mock
export const DESCRIPTIONS: Readonly<Record<string, StorefrontSection[]>> = {
  'himalaya-purifying-neem-face-wash-150ml': [
    {
      heading: NEEM,
      body: `Refresh and purify your skin every day with ${NEEM}. Enriched with the natural goodness of Neem & Turmeric, this soap-free face wash effectively removes impurities, controls excess oil, and helps prevent pimples while maintaining your skin's natural moisture.`,
    },
    {
      heading: 'Specifications',
      body: [
        '- **Product Type:** Face Wash',
        '- **Brand:** Himalaya',
        '- **Skin Type:** Suitable for all skin types (Best for Normal, Oily & Pimple-Prone Skin)',
        '- **Category:** Daily Facial Cleanser',
        '- **Formula:** Soap-Free Herbal Cleanser',
      ].join('\n'),
    },
    {
      heading: 'Key Benefits',
      body: [
        '- Deeply cleanses dirt, impurities, and excess oil',
        '- Helps prevent pimples and future breakouts',
        '- Controls excess oil without drying the skin',
        "- Maintains the skin's natural moisture balance",
        '- Removes dead skin cells for a fresh, healthy glow',
        '- Soothes irritated skin with the goodness of Turmeric',
        '- Leaves skin clean, refreshed, and soft after every wash',
      ].join('\n'),
    },
    {
      heading: 'Main Ingredients',
      body: [
        '- **Neem:** Naturally antibacterial and antifungal, helps purify skin, fight acne-causing bacteria, and reduce blemishes.',
        '- **Turmeric:** Known for its anti-inflammatory and antiseptic properties that soothe the skin and promote an even-looking complexion.',
      ].join('\n'),
    },
    {
      heading: `Why Choose ${NEEM}?`,
      body: [
        '- Soap-free formula for gentle daily cleansing',
        '- Dermatologically tested',
        '- Free from Parabens, SLS/SLES, Phthalates, Artificial Colors & Artificial Fragrances',
        '- 100% Cruelty-Free skincare',
        '- Suitable for daily morning and evening use',
      ].join('\n'),
    },
    {
      heading: 'How to Use',
      body: [
        '1. Moisten your face with water.',
        `2. Apply a small amount of ${NEEM}.`,
        '3. Gently massage using circular motions until it forms a rich lather.',
        '4. Rinse thoroughly with water.',
        '5. Pat your face dry with a clean towel.',
        '6. For best results, use twice daily.',
      ].join('\n'),
    },
    {
      heading: 'Product Details',
      body: `${NEEM} is a herbal, soap-free facial cleanser specially formulated to keep your skin clean, fresh, and healthy. Its unique blend of Neem and Turmeric effectively removes excess oil, dirt, and impurities while helping prevent acne and pimple breakouts. Unlike ordinary cleansers, it deeply purifies the skin without stripping away its essential moisture, making it ideal for everyday use. The gentle formula keeps your skin feeling refreshed, soft, and naturally healthy after every wash.`,
    },
  ],
};

// "Inside Dhaka: 1 to 2 days, ৳80." from the checkout's zones, like the mock's terms, so the
// terms say what the checkout charges. shopMoney, as the shop writes money ("৳1,000")
function zoneLine(name: string, days: string): string {
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.name === name);
  if (zone === undefined) throw new Error(`no zone ${name}`);
  return `- **${zone.name}:** ${days}, ${shopMoney(zone.charge, 'en')}.`;
}
const freeFrom = shopMoney(mockCheckoutSettings.freeDeliveryFrom, 'en');

// The footer's four pages, all written, in the footer's order
export const PAGES: Readonly<Record<ShopTextPageSlug, StorefrontSection[]>> = {
  privacy: [
    {
      heading: 'What we keep',
      body: 'When you order, we keep your name, your mobile number, your delivery address and what you bought. We need them to deliver the order and to call you if the rider cannot find the address.',
    },
    {
      heading: 'What we use it for',
      body: [
        '- To deliver your order and to send you SMS about it: the code that confirms it, and the link that tracks it.',
        '- To give the courier the name, number and address the parcel needs. The courier gets nothing else.',
        '- To answer you when you call the hotline about an order.',
        '',
        'We do not sell your details, and we do not send you offers by SMS unless you ask for them.',
      ].join('\n'),
    },
    {
      heading: 'Cookies',
      body: 'The shop keeps your cart in your browser. Two small cookies remember the order you are confirming and the orders this browser placed, so you can open them again. They hold no name, number or address.',
    },
    {
      heading: 'Tracking links',
      body: 'The link in the SMS shows where your parcel is. Anyone you forward it to can see that page, so it shows no address and no phone number.',
    },
  ],
  terms: [
    {
      heading: 'Orders',
      body: 'An order is placed when you confirm it with the code we send to your mobile number, or when you pay with Mobile Banking. Prices are the ones on the checkout page when you confirm.',
    },
    {
      heading: 'Delivery',
      body: [
        zoneLine('Inside Dhaka', '1 to 2 days'),
        zoneLine('Outside Dhaka', '2 to 4 days'),
        `- Delivery is free on orders over ${freeFrom}.`,
        '',
        'With Cash on Delivery, please keep the amount ready for the rider. You may check the parcel before you pay.',
      ].join('\n'),
    },
    {
      heading: 'Returns',
      body: 'If an item arrives damaged, expired or is not what you ordered, tell the rider or call us within 3 days. We replace it or give the money back. Opened food and personal care items cannot be returned for any other reason.',
    },
    {
      heading: 'Cancelling an order',
      body: 'Call the hotline before the parcel leaves the shop. Once it is with the courier, you can refuse it at the door instead.',
    },
  ],
  about: [
    {
      heading: `About ${mockShop.name}`,
      body: `${mockShop.name} is an online shop in Dhaka for everyday groceries, tea and coffee, personal care and diabetic food. We buy from the brands' own distributors, so every pack is genuine and inside its expiry date.`,
    },
    {
      heading: 'How we work',
      body: [
        '- Orders placed before 4 pm are packed the same day.',
        '- Every parcel goes with a courier that lets you follow it from our shop to your door.',
        '- Cash on Delivery everywhere in Bangladesh.',
      ].join('\n'),
    },
  ],
  contact: [
    {
      heading: 'Call or visit us',
      body: [
        `- **Hotline:** ${mockShop.hotline}, Saturday to Thursday, 10 am to 8 pm`,
        `- **Address:** ${mockShop.address}`,
      ].join('\n'),
    },
    {
      heading: 'About an order',
      body: 'Keep the order number from the SMS ready (it starts with W-). To see where a parcel is, open the link in the SMS, or use [Track Order](/track) with the number and your mobile number.',
    },
  ],
};
```

Decision 61. The words are the mock's (`products.ts` and `pages.ts`), with the same zones and the same free-delivery
amount: `zoneLine()` and `freeFrom` read them from `mockCheckoutSettings` and format them with the shop's own
`shopMoney()`, so the terms say what the checkout charges.

### The run: `seed-shop.ts` (new)

```ts
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
      `See the shop from this API (the shop's dev server reads the mock unless told otherwise):\n` +
      `  SHOP_SOURCE=api SHOP_API_URL=${API_URL} pnpm --filter @omnivo/shop dev\n` +
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
```

- `today()` is decision 60. `en-CA` writes a date as `YYYY-MM-DD`; with `timeZone: 'Asia/Dhaka'` it is the
  workspace's day. `toISOString()` would give yesterday before 6 am in Dhaka.
- `setUpWorkspace()` waits for the setup job: products need its units and the stock needs its MAIN warehouse. "failed"
  and the time limit both say to look at the worker, which is the usual cause.
- `addOpeningStock()` sends one adjustment with all the lines. One posting is one journal entry, as a shop's real
  opening stock would be.
- `addCategories()` follows the mock's order, where a parent always comes before its children, so the parent's real
  id is always known. `seed-plan.spec.ts` checks that order.
- `uploadPhotos()` first sends all the files, then waits for all of them. The worker makes the WebP files of one photo
  while the next one uploads. A photo the job refuses stops the seed with the file's name and the reason; otherwise
  the error would come later, at a listing's save, and point at the listing instead.
- `addListings()` and then `publishListings()`: a listing can only be published once it has a photo, and the two
  loops keep the publishing order (decision 58) in one place.
- `designHome()` makes the hero, then the banner and the collections in the mock's order. A new block always goes to
  the end of the home page, so the order of creation is the page's order.
- The launch reads the settings row again first: the launch needs its version, and the shop's settings were the last
  thing that changed it.
- `main()` and `seed()` are decision 56. `stopped()` sets `process.exitCode` instead of calling `process.exit()`, so
  Node finishes writing the output first.

### The test: `seed-plan.spec.ts` (new)

```ts
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import {
  compareMoney,
  createStorefrontCategoryInputSchema,
  createStorefrontCollectionInputSchema,
  createStorefrontSettingsInputSchema,
  createStorefrontBannerInputSchema,
  listingPricing,
  renderSections,
  saveStorefrontHeroInputSchema,
  saveStorefrontPageInputSchema,
  SHOP_TEXT_PAGES,
  STOREFRONT_COLLECTION_ITEMS_MAX,
  STOREFRONT_IMAGES_MAX,
  updateStorefrontListingInputSchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockCatalog } from '../src/data/mock/products';
import {
  heroBody,
  listingBody,
  megaSaleBody,
  seedCategories,
  seedCollections,
  seedListings,
  seedPhotos,
  settingsBody,
} from './seed-plan';
import { PAGES } from './seed-words';

// Step 26h: the seed's plan, checked without an API. Every body is parsed with the schema of
// its route, so a mistake shows here as a field name, not as a 400 halfway through a seed run
// against the dev stack. The prices are checked with the shop's own pricing (listingPricing):
// the real shop must show what the mock shows.

const NOW = new Date('2026-11-17T04:00:00Z');
const listings = seedListings(NOW);
const photos = seedPhotos(listings);
// Every file gets a made-up id, as the seed gets real ones from the uploads
const photoIds = new Map(photos.map((photo) => [photo.url, randomUUID()]));

// The same amount, whatever its decimals: the pricing answers "229.0000" for the mock's "229"
function sameMoney(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return compareMoney(a, b) === 0;
}

describe('the listings', () => {
  it('are the mock catalog, each once', () => {
    expect(listings).toHaveLength(mockCatalog.length);
    expect(new Set(listings.map((listing) => listing.slug)).size).toBe(listings.length);
  });

  it('each pass the editor contract', () => {
    for (const listing of listings) {
      const body = listingBody(listing, 1, randomUUID(), photoIds);
      const parsed = updateStorefrontListingInputSchema.safeParse(body);
      expect(parsed.error?.issues, listing.slug).toBeUndefined();
      // The slug stays the mock's, so the mock's links work on the real shop
      expect(parsed.data?.slug).toBe(listing.slug);
    }
  });

  it('show the mock price, and its struck-out price when it has one', () => {
    for (const listing of listings) {
      const mock = mockCatalog.find((candidate) => candidate.slug === listing.slug);
      const shown = listingPricing(listing.regularPrice, listing.sale, NOW);
      if (mock?.discount?.kind === 'percent' && mock.compareAtPrice === null) {
        // A percent ribbon is a percent sale on the mock's price: same ribbon, lower price
        expect(shown.discount, listing.slug).toEqual(mock.discount);
        continue;
      }
      expect(sameMoney(shown.price, mock?.price), `${listing.slug} price`).toBe(true);
      expect(
        sameMoney(shown.compareAtPrice, mock?.compareAtPrice),
        `${listing.slug} struck out`,
      ).toBe(true);
    }
  });

  it('give the design product its two photos once, its SKU, a description and a sale that ends', () => {
    const neem = listings.find(
      (listing) => listing.slug === 'himalaya-purifying-neem-face-wash-150ml',
    );
    expect(neem?.photos).toHaveLength(2);
    expect(neem?.sku).toBe('MD2346');
    expect(neem?.descriptionSections.length).toBeGreaterThan(0);
    expect(neem?.sale?.endsAt).not.toBeNull();
    for (const listing of listings)
      expect(listing.photos.length).toBeLessThanOrEqual(STOREFRONT_IMAGES_MAX);
  });

  it('put no stock on the ones the mock shows out of stock', () => {
    const out = listings.filter((listing) => listing.stock === null).map((listing) => listing.slug);
    expect(out).toEqual(
      mockCatalog.filter((listing) => !listing.inStock).map((listing) => listing.slug),
    );
  });
});

describe('the photos', () => {
  it('are files in public/, each once', () => {
    expect(new Set(photos.map((photo) => photo.url)).size).toBe(photos.length);
    for (const photo of photos) expect(existsSync(photo.file), photo.file).toBe(true);
  });
});

describe('the shop', () => {
  it('settings pass the first save', () => {
    const parsed = createStorefrontSettingsInputSchema.safeParse(
      settingsBody('demo-shop', randomUUID()),
    );
    expect(parsed.error?.issues).toBeUndefined();
  });

  it('categories come after their parent and pass the form', () => {
    const made = new Set<string>();
    for (const category of seedCategories) {
      if (category.parentId !== null) expect(made.has(category.parentId), category.slug).toBe(true);
      made.add(category.id);
      const parsed = createStorefrontCategoryInputSchema.safeParse({
        parentId: category.parentId === null ? '' : randomUUID(),
        name: category.name,
        slug: category.slug,
      });
      expect(parsed.error?.issues, category.slug).toBeUndefined();
    }
  });

  it('hero and Mega Sale pass their contracts, contrast included', () => {
    expect(
      saveStorefrontHeroInputSchema.safeParse(heroBody(photoIds)).error?.issues,
    ).toBeUndefined();
    expect(
      createStorefrontBannerInputSchema.safeParse(megaSaleBody(photoIds)).error?.issues,
    ).toBeUndefined();
  });

  it('collections are the mock rows of listings the seed makes', () => {
    const slugs = new Set(listings.map((listing) => listing.slug));
    expect(seedCollections.map((collection) => collection.title)).toEqual([
      'Refresh with Himalaya',
      'Hot & Trending Right Now',
      'Diabetic Corner',
    ]);
    for (const collection of seedCollections) {
      expect(collection.slugs.length).toBeLessThanOrEqual(STOREFRONT_COLLECTION_ITEMS_MAX);
      for (const slug of collection.slugs) expect(slugs.has(slug), slug).toBe(true);
      const parsed = createStorefrontCollectionInputSchema.safeParse({
        title: collection.title,
        icon: collection.icon,
        listingIds: collection.slugs.map(() => randomUUID()),
      });
      expect(parsed.error?.issues, collection.title).toBeUndefined();
    }
  });

  it('pages are all four, and their lists and links come out as HTML', () => {
    for (const slug of SHOP_TEXT_PAGES) {
      const parsed = saveStorefrontPageInputSchema.safeParse({
        version: null,
        sections: PAGES[slug],
      });
      expect(parsed.error?.issues, slug).toBeUndefined();
    }
    expect(renderSections(PAGES.terms)).toContain(
      '<li><strong>Inside Dhaka:</strong> 1 to 2 days, ৳80.</li>',
    );
    expect(renderSections(PAGES.contact)).toContain('<a href="/track">Track Order</a>');
  });
});
```

- Every body is parsed with its route's schema, with made-up ids. A wrong field shows here as a field name, not as a
  400 halfway through a seed run.
- The prices are checked with the shop's own `listingPricing()`: the real shop must show the mock's price and the
  mock's struck-out price. `sameMoney()` compares amounts, because the pricing answers `229.0000` for the mock's `229`.
- `existsSync()` checks every photo file, so a renamed mock photo fails the test and not the seed.
- The last test renders two pages with `renderSections()`, the API's own renderer, so the section syntax (`**bold**`,
  `[Track Order](/track)`) is checked too.

### Type check, test and the command

```json
{
  "extends": "../../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "noEmit": true,
    "declaration": false
  },
  "include": ["*.ts"]
}
```

The shop's main `tsconfig.json` is for Astro (`astro/client` types) and has no Node types. The scripts get their own,
like `e2e/`. `moduleResolution: "Bundler"` because the mock files they import use paths without `.ts`, as the rest of
the shop does.

```diff
@@ -8,9 +8,10 @@
     "build": "astro check && astro build",
     "preview": "astro preview --port 4321",
     "start": "node dist/server/entry.mjs",
-    "typecheck": "astro check && tsc --noEmit -p e2e",
+    "typecheck": "astro check && tsc --noEmit -p e2e && tsc --noEmit -p scripts",
     "test": "vitest run --passWithNoTests",
-    "test:e2e": "playwright test --config e2e/playwright.config.ts"
+    "test:e2e": "playwright test --config e2e/playwright.config.ts",
+    "seed": "tsx scripts/seed-shop.ts"
   },
   "dependencies": {
     "@astrojs/node": "~11.1.11",
@@ -39,6 +40,7 @@
     "@types/react": "^19.3.0",
     "@types/react-dom": "^19.3.0",
     "tailwindcss": "^4.3.3",
+    "tsx": "^4.23.15",
     "typescript": "^6.0.3",
     "vitest": "^5.0.1"
   }
```

`typecheck` now checks the scripts too, so CI type-checks them. `seed` runs the script with `tsx`.

```diff
@@ -4,7 +4,7 @@ import { defineConfig } from 'vitest/config';
 // and in the browser, not here.
 export default defineConfig({
   test: {
-    include: ['src/**/*.spec.ts'],
+    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
     environment: 'node',
   },
 });
```

```diff
@@ -30,7 +30,8 @@
     "db:generate": "pnpm --filter @omnivo/db generate",
     "db:migrate": "pnpm --filter @omnivo/db migrate",
     "db:seed": "pnpm --filter @omnivo/db seed",
-    "db:studio": "pnpm --filter @omnivo/db studio"
+    "db:studio": "pnpm --filter @omnivo/db studio",
+    "seed:shop": "pnpm --filter @omnivo/shop seed"
   },
   "devDependencies": {
     "@omnivo/config": "workspace:*",
```

`pnpm seed:shop` from the repo root. `pnpm install` adds `tsx` to the shop's part of `pnpm-lock.yaml` (the same
version `packages/db` has, so nothing new is downloaded).

The phone Mega Sale picture (decision 57) is a binary file, so it has no diff here. Export the `mega-sale` frame
(138:841) of the `home_page_mobile` frame in Figma as JPG at 2×, and save it over
`apps/shop/public/mock/banners/mega-sale-phone.jpg` (722 × 280 pixels).

### Using it

With the dev stack running (`pnpm db:up`, `pnpm dev`):

```bash
pnpm seed:shop
# [  6.4 s] shop open at http://demo-shop.localhost:4321
# Sign in to the ERP: workspace demo-shop, owner@demo-shop.test, password Demo-shop-2026

SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 pnpm --filter @omnivo/shop dev
# then open http://demo-shop.localhost:4321
```

A second `pnpm seed:shop` says the workspace is there and changes nothing. For a second demo:
`SEED_SHOP_SLUG=demo-shop-2 pnpm seed:shop`.

One difference from the mock shop is not the seed's: the home page's grid shows the first page of `/c/all`, 20
cards (26f, decision 18), where the mock shows 5.

### Check this part

```bash
pnpm install
pnpm --filter @omnivo/shop typecheck            # astro check, e2e and scripts
pnpm --filter @omnivo/shop test                 # 234 tests, 11 new
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/shop/scripts
pnpm exec prettier --check apps/shop package.json
pnpm exec depcruise apps/shop
```

The real run was on throwaway containers (Postgres, Valkey, MinIO, Mailpit on other ports), with the built API and
worker: the seed finished in about 6.5 seconds (62 products, stock for 58, 8 categories, 26 photos, 62 listings, hero,
banner, 3 rows, 4 pages, launched), and a second run stopped with "there already" and exit 1. The built shop with
`SHOP_SOURCE=api` was then checked in a browser at 1440 and 390 pixels: the hero, the Mega Sale banner and the three
rows, every visible photo loaded from the public `storefront/` folder, the first card "Cold drinks (Sprite)", the Neem
page with ৳229, the struck-out ৳299, the countdown, SKU MD2346 and its description, an out-of-stock product, the
categories, search, offers, the four pages (the terms with the zones and "free over ৳1,000", the contact page's
`/track` link), no sideways scroll on the phone, and Add to cart. Screenshots of the real and the mock home page side
by side match, apart from the ribbons (decision 54) and the grid's 20 cards.

Broken on purpose (and put back): no sale for a struck-out price and the photos not made unique each fail
`seed-plan.spec.ts`; publishing from the first listing instead of the last makes the browser check fail, because the
home grid's first card is then another product.

## 26h.9 — Run it and check it

### Four words out: `en.ts`, `bn.ts`

Four words of 26h.5 were not used by any screen in the end, so they are gone from `en.ts` and `bn.ts`, and 26h.5's
diff above no longer has them:

- `storefront.link.searching` and `storefront.collection.searching` ("Searching…"): the `Combobox` from `@omnivo/ui`
  shows its own `ui.combobox.loading` while the server searches, the same word everywhere.
- `storefront.collection.add` ("Add product"): the collection's product box has a label ("Product to add") and a
  placeholder, and a pick adds the product at once, so there is no Add button to name.
- `storefront.color.code` ("Color code"): the code box is named by the field's own label ("Brand color"); only the
  palette button needs its own name.

Nothing else changes: an unused key passes every check (the type check only asks that `bn.ts` has every key of
`en.ts`), which is why only reading the screens against the words found them.

### The commands

Your dev database needs the three new migrations first (0067, 0068 and 0069), and `pnpm install` brings `tsx` for
the seed:

```bash
pnpm install
pnpm db:migrate
```

Then the packages this step touched, one at a time:

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/contracts test      # 614
pnpm --filter @omnivo/i18n test           # 21, with the placeholder test
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test            # 183 unit tests (no database)
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test            # 229
pnpm --filter @omnivo/shop typecheck      # astro check, e2e and scripts
pnpm --filter @omnivo/shop test           # 234, with the seed's plan
```

And the whole repo:

```bash
pnpm dedupe --check
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test                 # 1,429: contracts 614 + shop 234 + app 229 + api 183 + sync 118 + ui 22 + i18n 21 + auth 8
pnpm test:integration     # 806 in 47 files, with the 31 of storefront-appearance.int.spec.ts
pnpm test:tenant-leak     # 159 in 23 files, with the 5 new ones for the look and the pages
pnpm boundaries
pnpm test:bundle-size     # first load 241.1 KB gz (budget 245), the listing editor 149.6 KB (budget 150)
pnpm test:openapi         # up to date, with the 16 new routes
pnpm --filter @omnivo/app test:e2e        # 452: 449 run, 3 skipped on purpose (as before)
pnpm test:e2e:pwa                         # 4
pnpm --filter @omnivo/shop test:e2e       # 38 passed, 2 skipped on purpose (as before)
```

On a laptop with 8 GB, add `--concurrency=2` to the turbo ones, run the two database suites with `--maxWorkers=3`
(from `apps/api`: `npx vitest run .int.spec --maxWorkers=3`), and the app's e2e suite with `--workers=2`.

**The integration suite on 3 workers:** two files (`bills.int.spec.ts` and `purchase-returns.int.spec.ts`, neither
touched by this step) did not start the first time: Docker took more than 10 seconds to give their test databases a
port. Run again on their own, all 44 of their tests passed. Every other check passed the first time, the app's e2e
suite included.

**The listing editor is 0.4 KB under its budget.** 26h moved its section editor into the shared `SectionsCard`,
which is a little bigger than before. The next change that adds code to that page will need a split (the photos card
is the biggest piece that could load later) or a new budget.

### The screens on the real API, end to end

The Playwright tests run the screens on the mock (26h.7), and the integration tests run the API (26h.4). One more
check put the real pieces together once: a throwaway script (not in this guide, and not in `src`) on throwaway
Postgres, Valkey, MinIO and Mailpit containers, with the built API, the real worker and the built shop. It ran
`pnpm seed:shop` first (6.4 seconds, and a second run stopped with "there already"), then drove a production build of
the app (`vite build`, served by `vite preview`) in Chromium, signed in as the seed's owner. Every step passed:

- **Shop appearance** showed "4 of 12 blocks": the Mega Sale banner and the three rows, in the seed's order.
- **The logo:** a 400 × 400 PNG went from the browser straight to MinIO, the worker's sharp job made the WebP files,
  and the card showed it, **ready in 3 seconds**.
- **The colors:** brand `#7A1F3D` and accent `#F4D06F` (6.7:1 together, 9.1:1 on cream), no "Too low" line, "Logo and
  colors saved". The settings row had both, in lowercase, and the logo's id.
- **The hero's page:** a new headline, "Links to" → Products on offer ("Goes to /c/all?offer=1"), "Hero banner
  saved".
- **A picture banner** with two real uploads (1,280 × 280 and 540 × 210), "Picture banner added at the end of the home
  page", "5 of 12 blocks", then Move up: the database had it fourth, above Diabetic Corner.
- **A collection's page** (Refresh with Himalaya) listed its five products, "5 of 24".
- **Shop pages** said "In the footer" for all four; About Us was deleted and then said "Not written".
- **The built shop with `SHOP_SOURCE=api`:** `--brand` was `#7a1f3d`, the header showed the logo from the public
  `storefront/` folder, the hero had the new headline, the Boishakh banner loaded, the footer had Privacy Policy but
  no About Us, and `/pages/about` answered `404`.
- **The audit log** had each save: `storefront.theme_updated`, `storefront_banner.updated` (the hero),
  `storefront_banner.created` (the hero, Mega Sale and the new one), `storefront.home_moved`,
  `storefront.page_deleted`, beside the seed's own. No page threw.

### Found while finishing

- **Four unused words** (above), found by reading the screens against the words.
- **The pages table's link name** reads "Write : Privacy Policy" to a screen reader (the visible "Write" and a hidden
  ": Privacy Policy"). It is clear enough, so it stays; a later clean-up can join the two without the space.
- **No code change** came out of the whole-repo checks or the smoke.

### What you should see

Your dev database needs the three migrations (0067, 0068 and 0069), and `pnpm install` brings `tsx`:

```bash
pnpm install
pnpm db:migrate
pnpm dev
pnpm seed:shop
```

`pnpm dev` starts the API, the worker, the app and the shop (still on its mock); `pnpm seed:shop` then builds the
demo shop. Sign in to `demo-shop` as `owner@demo-shop.test` with `Demo-shop-2026`:

- [ ] The Storefront group has five items: Catalog, Shop categories, **Shop appearance**, **Shop pages**, Shop
      settings. A role without `storefront.manage` sees none of them.
- [ ] **Shop appearance → Logo and colors:** type a light brand color (`#9ad0c2`): both lines say "Too low" and
      Save is refused on both boxes. "Use the default colors" brings the Figma pair back. Upload a logo, Save.
- [ ] **Edit hero banner:** change the headline and "Links to"; the drawing on the right follows as you type. Make the
      button's words the button's own color: "Too low", and Save says why.
- [ ] **Home page:** "Add picture banner" (two pictures and what they show) goes to the end; Move up / down; Delete
      asks first. "Add collection" opens its own page; pick products, change their order, "Add collection".
- [ ] **Shop pages:** all four say "In the footer". Open one, add a section, Preview shows the shop's own HTML, Save.
      Delete another: it says "Not written".
- [ ] Start the shop on the API: `SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 pnpm --filter @omnivo/shop dev`,
      then open `http://demo-shop.localhost:4321`. Within a minute (the shop keeps an answer for 30 seconds) it has
      the colors, the logo, the hero, the blocks in their order, and a footer with only the written pages.
- [ ] `pnpm dev:mock`: Rahman Fashion has a logo, the Eid hero, four blocks (the last one hidden, with the reason),
      and Terms and About written.

### Known differences from the mockup

- **The hero's Computer / Phone control** has no icons, **"Goes to /c/…"** is not in the mono font, and on a phone
  **View shop** and **Edit hero banner** sit a little differently (decision 52). Everything else is as you approved
  it.

## What comes next

- **Staging on the real API:** a wildcard shop host (DNS, the tunnel, Caddy), then `SHOP_SOURCE=api`,
  `SHOP_API_URL` and `SHOP_BASE_DOMAIN`, with the steps in `docs/vps-deploy.en.md`. The seed can then fill a staging
  shop through the API (`SEED_API_URL`).
- **Step 27:** the real checkout and orders, stock held for an order, coupons, the phone code by SMS, and the API's
  own rate limits.
- **Step 28:** the courier bookings and their events on the tracking page.
- **Later (decision 8):** banners with dates, a hero carousel, more tenant colors, page templates, cleaning up unused
  pictures, and a tenant's own domain.
