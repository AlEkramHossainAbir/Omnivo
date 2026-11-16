# Step 26g: Storefront, part 7 — the shop's screens in the ERP

> The implementation guide for "Phase 10 → Step 26", the seventh part, of [build-plan.bn.md](build-plan.bn.md).
> Step 26 so far:
>
> - **26a–26e (done):** `apps/shop` with every screen, on mock data.
> - **26f (done):** the storefront tables, the public API `/public/v1`, and the shop's data source that reads it.
> - **26g (this guide):** the ERP's Storefront menu, first half: the permission, the shop's settings and "Open the
>   shop", its categories, its listings (photos, price and sale, description, SEO) and the photo uploads with the
>   image job that makes the shop's WebP files.
> - **26h:** the second half: Appearance (logo, colors, the hero, image banners, collections, the home page's
>   order), the text pages, and a seed with photos.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `4873be5`, "middleware added",
> with your lint fix `f8e4da6`, "ci issue fixed") and checked on 2026-11-16: `pnpm dedupe --check`, `pnpm build`,
> `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (1,356, of them 562 in `packages/contracts`, 223 in
> `apps/app` and 183 in `apps/api`), `pnpm test:integration` (775) and `pnpm test:tenant-leak` (154) on
> Testcontainers, `pnpm boundaries`, `pnpm test:bundle-size` (first load 237.2 KB gz, budget 240; the listing editor
> 145.9 KB, budget 150), `pnpm test:openapi`, the app's Playwright suite on a computer and on a phone (all 435 that
> run pass; 12 timed out on a busy machine and passed when run again), the PWA suite (4) and the shop's Playwright
> tests (38, 2 skipped on purpose, as before), all clean. The new table was also checked on a throwaway Postgres
> with its own script (26g.2).
>
> Also checked:
>
> - **The screens on the real API**, end to end: a production build of the app, the API, the worker with `sharp` and
>   MinIO, then the built shop with `SHOP_SOURCE=api` showing the shop the screens made (26g.8).
> - **`sharp` in the API's Alpine Docker image** (26g.8).
> - **Broken on purpose** while the parts were written, each caught by a test: the photo check off, the event sent
>   on every confirm, the mock publishing without a photo, Save not waiting for a photo, publish not waiting for the
>   save, and more. Each part's "Check this part" lists them.

## Goal

🛒 **A workspace opens its own shop from the ERP.** After 26f the shop could read a workspace's products from the
API, but nobody could make a shop: there was no screen, and the tests wrote their shops with SQL. After 26g the ERP
has a Storefront menu for people with the new `storefront.manage` permission. Shop settings sets the shop up (its
address, name, warehouse, delivery zones, free delivery, minimum order and payment methods) and opens it once a
checklist is done. Shop categories holds the shop's own tree of categories. Catalog adds products to the shop as
drafts, and a listing's editor gives each one its photos, shop price and sale, description and SEO, then shows it in
the shop. A photo goes straight from the browser to storage, and a worker job (`sharp`) turns it upright, drops its
metadata and makes the three WebP sizes the shop shows. Appearance, the text pages and a seed with photos come in
26h.

## The whole picture

```
packages/contracts   storefront-admin.ts: 20 routes (all storefront.manage), the subdomain rules, slugFromName,
                     the settings, categories, photo upload and listing shapes, the launch checklist
                     attachments.ts: the storefront_image purpose (8 MB)    permissions/errors/audit: 1 + 26 + 12
packages/db          storefront.ts: storefront_images (a photo's job state)    0065 + 0066 (RLS)
                     outbox-events.ts: storefront.image_uploaded             permission-catalog.ts: storefront.manage
      │
      ▼
apps/api/src/storefront/admin   (login, storefront.manage, version checks, every save audited)
   settings     GET setup → POST (set up) / PUT (change) → launch when the checklist is done
   categories   tree, add, change, Move up / down, delete (refused while used)
   images       a presigned PUT ticket → complete → the job row and the outbox event, in one transaction
   listings     candidates, Add to shop (a draft), change, publish / unpublish, delete
apps/api/src/storefront/image.handler.ts   (worker)
   the original from storage → sharp: header check, EXIF turn, no metadata, 40 MP / 200 px → small, large, wide
   .webp in the public storefront/<id>/ folder → the row is ready (or failed, with why)
      │
      ▼
apps/app   Storefront group in the sidebar: Catalog · Shop categories · Shop settings
   /storefront/settings          the form, the launch checklist, "Open the shop", a subdomain change dialog
   /storefront/categories        TreeList, a dialog form, Move up / down
   /storefront/listings          server-paged table: search, In the shop / Drafts, category; "Add to shop"
   /storefront/listings/$id      Basics, Photos (upload, "Preparing the photo…"), Price and sale (live preview),
                                 Description (sections, the shop's own HTML as preview), SEO; Show in the shop

Monday 16 Nov 2026, Nabil Super Shop, on a laptop:
  Shop settings → nabil-….localhost:4321, MAIN, Inside Dhaka ৳80 → "Shop set up" (2 of 3 on the checklist)
  Catalog → Add to shop: Mango juice 250 ml → a 900 × 600 PNG → "Preparing the photo…" → ready in a few seconds
  Show in the shop → Open the shop → "View shop": the card with its WebP photo, ৳25, "Available in stock"
```

## Not in this step, on purpose

- **Appearance and the text pages** (logo, colors with the 4.5:1 check, the hero, image banners, collections, the
  home page's order, Privacy / Terms / About / Contact) and a dev seed with photos: 26h (decision 1). Until then an
  open shop has no hero and the Omnivo mark as its logo.
- **Adding many products at once, cleaning up unused photos, custom domains and the `feature.storefront`
  entitlement** (decision 7). An unused photo costs only space: its files never change.
- **Staging on the real API.** Staging still shows the mock shop. A real shop lives at
  `<subdomain>.<SHOP_BASE_DOMAIN>`, and staging has one fixed shop host, so the switch needs a wildcard host (DNS,
  the tunnel and Caddy) first (your choice in 26g.8). 26g.8 rewrites the comment in `compose.yml` to say so.
- **Orders, stock held for an order, coupons and the phone code by SMS:** step 27. The shop's checkout still runs on
  its own mock.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/attachments.ts` | The `storefront_image` purpose (8 MB), `GENERAL_UPLOAD_PURPOSES` for `POST /attachments`, `uploadTargetSchema` |
| `packages/contracts/src/permissions.ts` | `storefront.manage` in its own group |
| `packages/contracts/src/errors.ts`, `audit.ts` | 26 error codes; 12 audit actions and 3 entity types |
| `packages/contracts/src/routes.ts`, `index.ts` | `storefront` in the routes registry; `storefront-admin` exported |
| `packages/contracts/openapi.json` | Regenerated with the 20 routes |
| `packages/db/src/schema/storefront.ts` | The `storefront_images` table at the end |
| `packages/db/src/schema/outbox-events.ts` | The event `storefront.image_uploaded` |
| `packages/db/src/permission-catalog.ts` | The `storefront.manage` line |
| `packages/db/migrations/meta/_journal.json` | Migrations 0065 and 0066 |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The permission, its group, the errors, the audit words, the nav and the `storefront` block |
| `apps/api/package.json` | `sharp` 0.35.5 |
| `apps/api/src/config.ts`, `config.spec.ts`, `.env.example` | `SHOP_PUBLIC_PORT`; the shop's scheme and port for "View shop" |
| `apps/api/src/storage/storage.service.ts` | Only `storefront/*` public (a bucket policy at every start in dev); a `Cache-Control` on `put()` |
| `apps/api/src/attachments/attachments.service.ts`, `attachments.module.ts` | Upload and confirm reused by the shop's photos; the general routes refuse a shop photo |
| `apps/api/src/common/outbox/outbox.ts` | The event's payload `{ imageId }` |
| `apps/api/src/worker/queues.ts`, `handlers.ts`, `worker.module.ts` | The event's queue and handler |
| `apps/api/src/storefront/media.ts` | The size names as a list, a photo file's key |
| `apps/api/src/storefront/listing-sql.ts` | `isoText` exported |
| `apps/api/src/storefront/storefront.module.ts` | The admin services and controller |
| `apps/api/src/setup/templates.ts` | `storefront.manage` for retail's Shop manager and the general Manager |
| `apps/api/src/testing/storefront.ts` | A comment (decision 30) and an optional `sku` on `createProduct` |
| `apps/app/src/router.tsx` | Four lazy routes |
| `apps/app/src/routes/app-shell.tsx` | The Storefront group, by `storefront.manage` |
| `apps/app/scripts/check-bundle-size.ts` | First load 240 KB, a lazy page 150 KB (your choice) |
| `apps/app/src/mocks/handlers.ts`, `workspace-data.ts` | The 20 routes and a mock storage PUT; a shop in every workspace |
| `apps/app/e2e/settings.e2e.ts`, `bills.e2e.ts`, `purchase-orders.e2e.ts`, `refunds.e2e.ts`, `stock-valuation.e2e.ts` | `openFromNav(page, /^Settings$/)` |
| `infra/staging/compose.yml`, `Caddyfile` | `mc anonymous` for `storefront/`; the photos may be cached; the shop's comment |
| `infra/docker/Dockerfile` | The shop's comment |

New: `packages/contracts/src/storefront-admin.ts` (with its spec); migrations 0065 and 0066; in
`apps/api/src/storefront/`: `admin/` (four services and the controller), `image-files.ts` (with its spec),
`image.handler.ts`, `shop-url.ts` and two integration test files; `apps/api/src/testing/shop-photo.ts`; in
`apps/app/src`: `lib/storefront.ts` (with its spec), `components/storefront-parts.tsx`, `storefront-photos.tsx`,
`storefront-sections.tsx`, the four `routes/storefront-*.tsx` pages, `mocks/storefront-seed.ts` and
`mocks/storefront-data.ts`; `apps/app/e2e/storefront.e2e.ts`.

## Decisions

Agreed with the user on 2026-11-15:

1. **Two guides.** 26g is the permission, the settings and the launch, the categories, the catalog and the photo
   job; 26h is Appearance, the text pages and a seed. A shop can open without 26h (no hero, the Omnivo mark as its
   logo), but not without a warehouse, a delivery zone and a listing with a photo.
2. **Photos** go up with the attachments' presigned PUT, to the workspace's private folder. Confirming the upload
   starts a job (outbox → worker) that turns the photo upright from its EXIF data, drops the metadata, and writes
   the three WebP sizes of 26f's `media.ts` (small, large, wide) to the public `storefront/<id>/` folder. A photo's
   id is its attachment's id. A save checks that each photo is this workspace's and ready. The screen asks again
   while the job runs ("Preparing the photo…"). Photos nobody uses any more are cleaned up in a later step: their
   files never change, so leaving them costs only space.
3. **The subdomain may change after the launch**, with a dialog that says old links stop working (there is no
   redirect).
4. **"View shop"** sits in the page header, with the line "Changes show in the shop within a minute": the shop's
   server keeps an answer for 30 seconds (26f.5).
5. **A "Storefront" group in the sidebar** (26g: Catalog, Categories, Settings; 26h adds Appearance and Pages),
   hidden without `storefront.manage`. Every form has the usual version check, every save is in the audit log, and
   the screens are online only.
6. **A mockup before the screens**, as a local HTML page and pictures (CLAUDE.md rule 6), approved by the user first.
7. **Not now:** adding many products at once, cleaning up unused photos, custom domains, and the
   `feature.storefront` entitlement (step 24).

The decisions made while writing (8 onward) are in the parts, where the code they shape is.

## 26g.1 — The contracts

This part adds what the screens and the API agree on: the routes of the Storefront menu, their inputs and answers,
the new permission, the photo upload's purpose, the error codes and the audit events. Nothing is stored or served
yet, and no screen changes.

### The Storefront menu's contract: `storefront-admin.ts`

26f split the storefront's contracts in two: `storefront.ts` is what the shop reads, and `storefront-content.ts` is
the raw material both sides share (the sale, the sections, the photo `{id, alt}`). This third file is what the
tenant's screens send and get back. It imports from both and adds nothing to them, so the shop's contract does not
change in this step.

```ts
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
  // null = not open yet: the address answers "No shop has this address"
  launchedAt: z.iso.datetime().nullable(),
  readiness: storefrontReadinessSchema,
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;

// The settings page's one read. Before the first save there is no shop (`shop: null`), and the
// form starts from `suggested`: the workspace's slug as the subdomain when it is free, and the
// company's name, phone and address from the workspace settings. baseDomain lets the form show the
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

// A new category goes last among its siblings; a new parent moves it, with everything under it, to
// the end of that parent's list
export const createStorefrontCategoryInputSchema = withSlug(categoryFieldsSchema);
export const updateStorefrontCategoryInputSchema = withSlug(
  categoryFieldsSchema.extend({ version: versionSchema }),
);
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
```

**The subdomain** (`storefrontSubdomainSchema`).

- `.toLowerCase()` runs before the checks, so `Nirvor` and `nirvor` can never be two shops. The table's unique
  index (26f.2) is on the lower-case text, so the two rules agree.
- The rule is a little narrower than the table's check (decision 11). At least 3 characters, like a workspace slug:
  one- and two-letter names are the ones people take just to hold them. No two hyphens in a row: this also keeps
  out `xn--…`, the start of an internationalized domain name. A browser shows such a name as other letters, so
  `xn--nirvor-…` could look like a different shop.
- `STOREFRONT_RESERVED_SUBDOMAINS` is the workspace slugs' list plus the names a file or media server takes
  (`files`, `media`, `cdn`, `static`, `assets`). On staging the ERP is `app.omnivosoft.com` and the API is
  `api.omnivosoft.com`, under the same domain as the shops. A shop called `app` would take the ERP's address.

**Slugs** (decision 12).

- `slugFromName` is in the contract, not only in the API, so the form shows the slug a save is going to make
  before the tenant saves. `normalize('NFKD')` splits "é" into "e" plus an accent mark, and the next line removes
  the mark, so "Café" becomes `cafe` and not `caf`.
- A Bangla-only name ("নিম ফেস ওয়াশ") has no Latin letter and gives `''`. The function does not make up a slug
  like `c-7f3a`: that is a link nobody can read or type. The form asks for one instead.
- The cut at 100 runs before the last `.replace(/-+$/, '')`. In the other order, a name cut in the middle of
  `wash-150ml` could end in a hyphen, which the table's check refuses.
- `withSlug` wraps an object schema. Its `superRefine` puts `storefront_slug_required` on the **slug** box, not the
  name: the name is fine, it is the link that is missing. Its `transform` then fills an empty slug from the name.
  The order matters: the refine runs on the input (`slug: ''`), and the transform only on input that passed.
- The generic `T extends z.ZodType<{ name: string; slug: string }>` lets one helper wrap the category's and the
  listing's schemas, whose other fields differ. TypeScript keeps each schema's own output type.

**The settings.**

- `socialLinkSchema` is `optionalText(300)` (an empty box is `null`), then an https check. The regex wants a dot
  after `https://`, so `https://facebook` (a typo) is refused, and it has no quote or `<`, so a link can never
  close the `href="…"` it goes into. The table's `storefront_settings_social_check` refuses non-https as well; this
  check gives the form a clear error before the database ever sees the row.
- A delivery zone's `id` is what a shopper's cart keeps (the zone picked at checkout, 26c). So a saved zone keeps
  its id when it is renamed or its charge changes, and a new zone sends `null` and the API names it (decision 13).
  If the form made up ids instead, two tabs could make the same one.
- The zone's charge may be `0`: a shop may deliver for free in its own area ("Sylhet city — ৳0"). An empty box is
  refused: it is a charge nobody typed. `freeDeliveryFrom` and `minimumOrder` are the other way round: empty means
  none, and `0` is refused, because "free from ৳0" is the same as a zone at ৳0, and "a minimum of ৳0" is no
  minimum.
- `paymentMethods` ends with a `transform` to a `Set`, so a method ticked twice is saved once. The table's
  `cardinality >= 1` check would let `{cod,cod}` through.
- `uniqueZoneNames` compares without case and outer spaces, and puts the error on the **second** zone's name box.
  The first one is fine; it is the second that repeats it.
- There are two input schemas, `create…` (POST, the first save) and `update…` (PUT, with `version`), not one with
  an optional version (decision 10). A POST can never carry a version the server ignores, and a PUT can never
  forget one. `.superRefine` is added after `.extend`, because `.extend` on a refined schema would drop the refine.
- The answer has `readiness`, worked out by the API: a warehouse, a zone and one published listing. The first two
  are also the table's launch check. The third is not a database rule, so a shop whose last listing is unpublished
  after the launch keeps working; it only keeps the first shopper from landing on an empty shop.
- `storefrontSetupSchema` is the settings page's one read. Before the first save, `shop` is `null` and the form
  starts from `suggested` (the workspace's slug when no shop has it, and the company's name, phone and address).
  `baseDomain` lets the form show the whole address while the subdomain is being typed.

**The categories.** The shape is the product categories' (`product-categories.ts`): a flat list with parent ids,
the whole tree in one answer, `''` for "Top level". Two things are new. `slug` is there, through `withSlug`. And
`moveStorefrontCategoryInputSchema` swaps a category with its sibling above or below it (decision 15). These are
buttons, not dragging, so the keyboard and a screen reader can do it too. The move answers the whole list, because
two rows change at once.

**The photos.**

- `storefrontUploadSchema` is a discriminated union on `status` (decision 9). Only a `ready` photo has a `url`, and
  only a `failed` one has a `code`, so the screen cannot show a thumbnail of a photo that is not there yet.
- A failed photo's `code` is one of `STOREFRONT_IMAGE_FAILURES`, which are error codes. The screen shows its words
  from `errors.*` like any other error, in English or Bangla.
- `STOREFRONT_IMAGE_MIN_SIDE` (200px) and `STOREFRONT_IMAGE_MAX_PIXELS` (40 MP) are the job's limits (26g.3). A
  photo smaller than 200px looks broken even on a 223px card. 40 megapixels is more than any phone photo. A larger
  picture is either a mistake or a "decompression bomb": a small file that unpacks into a huge picture and fills
  the worker's memory.
- `createStorefrontUploadInputSchema` has no `purpose`: the route says it. Size and type are checked against
  `ATTACHMENT_RULES.storefront_image`, so the browser refuses a 30 MB photo before it starts sending it.
- `storefrontImageViewSchema` is the saved `{id, alt}` plus the small file's address, for the form's thumbnails.
  The input stays `{id, alt}`: a URL the browser sends back is never trusted or stored.

**The listings.**

- The summary's `price` and `compareAtPrice` are what a shopper sees now, worked out with `listingPricing` on the
  server's clock (26f). `price` is `null` when neither the listing nor the variant has a price: a draft can be
  saved like that, but not published.
- `inStock` is `null` while the shop has no warehouse. The list shows a dash then, not "Out of stock", which would
  be a wrong answer.
- The editor's answer has the product and the variant as the ERP has them. The form shows the variant's own price
  under the price box ("Product price: ৳299") and works out the preview from `priceOverride ?? variant.salePrice`.
- "Add to shop" sends only the variant and a category. The API makes a draft from them (decision 16). The
  category is required: every listing is in one (the table's foreign key).
- `updateStorefrontListingInputSchema` is the whole editor in one PUT, like every other form. Publish and
  unpublish are their own routes with the version, because they are what the page header's button does, not a field
  of the form.
- `priceOverrideSchema` is `priceSchema` (`''` is `null`) with zero refused, as the table's
  `storefront_listings_price_check` does.
- `listingImagesSchema` puts `storefront_image_twice` on the repeated photo's own index (`images.2`), so the form
  marks that thumbnail and not the whole row.
- `badges` ends with `SHOP_BADGES.filter(…)`: each badge once, in the shop's own order, whatever order the
  checkboxes sent.
- Whether a sale takes something off is checked by the API (`storefront_sale_not_lower`), because only it knows the
  regular price for sure. The form's preview shows the same thing first.

**The routes.** Every route needs `storefront.manage`, reads included: only the people who run the shop use these
screens. "Add to shop"'s search is at `/storefront/candidates`, not `/storefront/listings/candidates` (decision
14). Under `/listings/` it would sit next to `/listings/:id`, and a router that tried `:id` first would answer
"not a valid id". The spec checks that no fixed path is ever put there.

```ts
import { describe, expect, it } from 'vitest';

import { createUploadInputSchema } from './attachments.js';
import { PERMISSION_GROUP_OF } from './permissions.js';
import {
  createStorefrontCategoryInputSchema,
  createStorefrontSettingsInputSchema,
  createStorefrontUploadInputSchema,
  slugFromName,
  STOREFRONT_SLUG_MAX,
  storefrontRoutes,
  storefrontSubdomainSchema,
  updateStorefrontCategoryInputSchema,
  updateStorefrontListingInputSchema,
  updateStorefrontSettingsInputSchema,
  type StorefrontListingFormValues,
} from './storefront-admin.js';

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
const CATEGORY = '2dab8e74-9f40-4da0-9c73-5b6e4f3a2c33';

describe('the shop subdomain', () => {
  it('lower-cases and trims what the tenant typed', () => {
    expect(storefrontSubdomainSchema.parse('  Nirvor-Pharmacy ')).toBe('nirvor-pharmacy');
  });

  it.each([
    ['ab', 'too_short'],
    ['nirvor pharmacy', 'storefront_subdomain_format'],
    ['-nirvor', 'storefront_subdomain_format'],
    ['nirvor-', 'storefront_subdomain_format'],
    // Two hyphens in a row: also keeps out "xn--", an internationalized name in disguise
    ['xn--nirvor', 'storefront_subdomain_format'],
    ['নির্ভর', 'storefront_subdomain_format'],
    ['a'.repeat(64), 'too_long'],
  ])('refuses %s with %s', (label, code) => {
    expect(errorsOf(storefrontSubdomainSchema.safeParse(label))['']).toContain(code);
  });

  // app and api are the ERP's and the API's own hosts on staging (app.omnivosoft.com)
  it.each(['app', 'api', 'www', 'files', 'media', 'shop'])('keeps %s for Omnivo', (label) => {
    expect(errorsOf(storefrontSubdomainSchema.safeParse(label))['']).toEqual([
      'storefront_subdomain_reserved',
    ]);
  });
});

describe('slugs from names', () => {
  it.each([
    ['Neem Face Wash 150ml', 'neem-face-wash-150ml'],
    ['  Diabetic care & sugar-free  ', 'diabetic-care-sugar-free'],
    ['Café Latte', 'cafe-latte'],
    ['Himalaya — Herbals', 'himalaya-herbals'],
    // No Latin letter: the form asks for a slug instead of making one up
    ['নিম ফেস ওয়াশ', ''],
    ['নিম Neem', 'neem'],
  ])('makes %j into %j', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });

  it('cuts a long name at 100 without a hyphen at the end', () => {
    const slug = slugFromName(`${'a'.repeat(99)} b`);
    expect(slug).toBe('a'.repeat(99));
    expect(slug.length).toBeLessThanOrEqual(STOREFRONT_SLUG_MAX);
  });
});

describe('a shop category', () => {
  it('takes its slug from the name when the box is empty, and the top level as null', () => {
    expect(
      createStorefrontCategoryInputSchema.parse({
        parentId: '',
        name: 'Diabetic Corner',
        slug: '',
      }),
    ).toEqual({ parentId: null, name: 'Diabetic Corner', slug: 'diabetic-corner' });
  });

  it('keeps a slug the tenant typed, lower-cased', () => {
    expect(
      createStorefrontCategoryInputSchema.parse({
        parentId: CATEGORY,
        name: 'ডায়াবেটিক কর্নার',
        slug: 'Diabetic',
      }).slug,
    ).toBe('diabetic');
  });

  it('asks for a slug when a Bangla name has nothing to make one from', () => {
    const result = createStorefrontCategoryInputSchema.safeParse({
      parentId: '',
      name: 'ডায়াবেটিক কর্নার',
      slug: '',
    });
    expect(errorsOf(result)).toEqual({ slug: ['storefront_slug_required'] });
  });

  it('refuses a slug with spaces on the slug box', () => {
    expect(
      errorsOf(
        updateStorefrontCategoryInputSchema.safeParse({
          parentId: '',
          name: 'Tea',
          slug: 'green tea',
          version: 2,
        }),
      ),
    ).toEqual({ slug: ['storefront_slug_format'] });
  });
});

// A settings form as the page sends it, before the tenant changes anything
const SETTINGS = {
  subdomain: 'nirvor',
  name: 'Nirvor Pharmacy',
  language: 'bn',
  hotline: '09612-345678',
  address: 'House 12, Road 3, Zindabazar, Sylhet',
  facebookUrl: '',
  instagramUrl: '',
  xUrl: '',
  linkedinUrl: '',
  defaultWarehouseId: '',
  deliveryZones: [],
  freeDeliveryFrom: '',
  minimumOrder: '',
  paymentMethods: ['cod'],
} as const;

describe('the shop settings', () => {
  it('turns every empty box into null', () => {
    expect(createStorefrontSettingsInputSchema.parse(SETTINGS)).toMatchObject({
      facebookUrl: null,
      defaultWarehouseId: null,
      freeDeliveryFrom: null,
      minimumOrder: null,
    });
  });

  it('keeps a zone id when it has one, and names a new zone null', () => {
    const parsed = updateStorefrontSettingsInputSchema.parse({
      ...SETTINGS,
      version: 3,
      deliveryZones: [
        { id: 'inside-dhaka', name: 'Inside Dhaka', charge: '80' },
        { id: null, name: 'Sylhet city', charge: '0' },
      ],
    });
    expect(parsed.deliveryZones).toEqual([
      { id: 'inside-dhaka', name: 'Inside Dhaka', charge: '80' },
      { id: null, name: 'Sylhet city', charge: '0' },
    ]);
  });

  it('refuses two zones with one name on the second, and a zone with no charge', () => {
    const result = createStorefrontSettingsInputSchema.safeParse({
      ...SETTINGS,
      deliveryZones: [
        { id: null, name: 'Inside Dhaka', charge: '80' },
        { id: null, name: ' inside dhaka ', charge: '' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'deliveryZones.1.name': ['storefront_zone_name_taken'],
      'deliveryZones.1.charge': ['required'],
    });
  });

  it('refuses a seventh zone', () => {
    const zones = Array.from({ length: 7 }, (_, index) => ({
      id: null,
      name: `Zone ${String(index + 1)}`,
      charge: '60',
    }));
    expect(
      errorsOf(
        createStorefrontSettingsInputSchema.safeParse({ ...SETTINGS, deliveryZones: zones }),
      ),
    ).toEqual({ deliveryZones: ['too_long'] });
  });

  it.each([
    ['http://facebook.com/nirvor', 'storefront_link_https'],
    ['javascript:alert(1)', 'storefront_link_https'],
    ['facebook.com/nirvor', 'storefront_link_https'],
  ])('refuses the social link %s', (link, code) => {
    expect(
      errorsOf(createStorefrontSettingsInputSchema.safeParse({ ...SETTINGS, facebookUrl: link })),
    ).toEqual({ facebookUrl: [code] });
  });

  it('takes an https social link', () => {
    expect(
      createStorefrontSettingsInputSchema.parse({
        ...SETTINGS,
        instagramUrl: 'https://instagram.com/nirvor.pharmacy',
      }).instagramUrl,
    ).toBe('https://instagram.com/nirvor.pharmacy');
  });

  it('refuses free delivery from ৳0, no way to pay, and keeps a method ticked twice once', () => {
    expect(
      errorsOf(
        createStorefrontSettingsInputSchema.safeParse({
          ...SETTINGS,
          freeDeliveryFrom: '0',
          paymentMethods: [],
        }),
      ),
    ).toEqual({
      freeDeliveryFrom: ['too_small'],
      paymentMethods: ['storefront_payment_required'],
    });
    expect(
      createStorefrontSettingsInputSchema.parse({ ...SETTINGS, paymentMethods: ['cod', 'cod'] })
        .paymentMethods,
    ).toEqual(['cod']);
  });
});

// The listing editor as it opens on a draft
const LISTING: StorefrontListingFormValues = {
  version: 1,
  name: 'Himalaya Neem Face Wash',
  slug: '',
  packSize: '150ml',
  categoryId: CATEGORY,
  priceOverride: '',
  sale: null,
  badges: [],
  images: [],
  descriptionSections: [],
  seoTitle: '',
  seoDescription: '',
};

describe('the listing editor', () => {
  it('fills the slug from the name, and the empty boxes as null', () => {
    expect(updateStorefrontListingInputSchema.parse(LISTING)).toMatchObject({
      slug: 'himalaya-neem-face-wash',
      priceOverride: null,
      seoTitle: null,
      seoDescription: null,
    });
  });

  it('keeps each badge once, in the shop’s order', () => {
    expect(
      updateStorefrontListingInputSchema.parse({
        ...LISTING,
        badges: ['new', 'most_picked', 'new'],
      }).badges,
    ).toEqual(['most_picked', 'new']);
  });

  it('refuses a shop price of ৳0, the same photo twice and a photo without its words', () => {
    const result = updateStorefrontListingInputSchema.safeParse({
      ...LISTING,
      priceOverride: '0',
      images: [
        { id: PHOTO, alt: 'Neem face wash, front' },
        { id: PHOTO_2, alt: ' ' },
        { id: PHOTO, alt: 'Neem face wash, again' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      priceOverride: ['too_small'],
      'images.1.alt': ['required'],
      'images.2': ['storefront_image_twice'],
    });
  });

  it('refuses a fifth photo', () => {
    const images = [PHOTO, PHOTO_2, CATEGORY, '3ebc9f85-a051-4eb1-8d84-6c7f5a4b3d44', PHOTO].map(
      (id, index) => ({ id, alt: `Photo ${String(index + 1)}` }),
    );
    expect(errorsOf(updateStorefrontListingInputSchema.safeParse({ ...LISTING, images }))).toEqual({
      images: ['too_long'],
    });
  });

  it('takes a sale with its dates, and refuses one that ends before it starts', () => {
    expect(
      updateStorefrontListingInputSchema.parse({
        ...LISTING,
        sale: { kind: 'percent', value: '10', startsAt: null, endsAt: '2026-11-30T23:59:00+06:00' },
      }).sale,
    ).toEqual({
      kind: 'percent',
      value: '10',
      startsAt: null,
      endsAt: '2026-11-30T23:59:00+06:00',
    });
    expect(
      errorsOf(
        updateStorefrontListingInputSchema.safeParse({
          ...LISTING,
          sale: {
            kind: 'amount',
            value: '21',
            startsAt: '2026-11-20T00:00:00+06:00',
            endsAt: '2026-11-19T00:00:00+06:00',
          },
        }),
      ),
    ).toEqual({ 'sale.endsAt': ['storefront_sale_dates'] });
  });
});

describe('photo uploads', () => {
  it('takes a phone photo up to 8 MB', () => {
    expect(
      createStorefrontUploadInputSchema.safeParse({
        fileName: 'IMG_2041.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 8 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });

  it('refuses an SVG and a photo over 8 MB, each on its own box', () => {
    expect(
      errorsOf(
        createStorefrontUploadInputSchema.safeParse({
          fileName: 'logo.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 8 * 1024 * 1024 + 1,
        }),
      ),
    ).toEqual({
      contentType: ['file_type_not_allowed'],
      sizeBytes: ['storefront_image_file_too_large'],
    });
  });

  // Through POST /attachments a storefront photo would be a file no image job ever makes ready
  it('is not a purpose of the general upload route', () => {
    expect(
      createUploadInputSchema.safeParse({
        purpose: 'storefront_image',
        fileName: 'IMG_2041.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1000,
      }).success,
    ).toBe(false);
  });
});

describe('the Storefront routes', () => {
  it('all need storefront.manage, which has a group of its own', () => {
    for (const route of Object.values(storefrontRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
    expect(PERMISSION_GROUP_OF['storefront.manage']).toBe('storefront');
  });

  // A path like /storefront/listings/candidates would meet /storefront/listings/:id first
  it('keep fixed paths out of the way of an :id', () => {
    const paths = Object.values(storefrontRoutes).map((route) => `${route.method} ${route.path}`);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path).not.toMatch(/\/listings\/(?!:id)[a-z]/);
    }
  });
});
```

The spec checks the rules above with the shop's real examples: Nirvor Pharmacy in Sylhet, a neem face wash, a
Bangla category name. Some tests worth reading:

- "keeps app for Omnivo" runs over the names that matter on staging.
- "refuses two zones with one name on the second…" checks both errors and where they land, in one parse.
- "is not a purpose of the general upload route" pins decision 8 (next section).
- "keep fixed paths out of the way of an :id" pins decision 14.

### Photos have their own routes: `attachments.ts`

```diff
@@ -5,10 +5,15 @@ import { defineRoute } from './http.js';
 
 // ফাইল কী কাজে লাগবে — প্রতিটার নিজের আকার আর ধরনের সীমা। নতুন কাজ (ইনভয়েস PDF, খরচের রসিদ)
 // = এখানে এক লাইন
-export const ATTACHMENT_PURPOSES = ['company_logo'] as const;
+export const ATTACHMENT_PURPOSES = ['company_logo', 'storefront_image'] as const;
 export type AttachmentPurpose = (typeof ATTACHMENT_PURPOSES)[number];
 
-interface AttachmentRule {
+// Step 26g: the purposes POST /attachments takes. A storefront photo has its own routes
+// (storefront-admin.ts): they need storefront.manage, not core.settings.manage, and their upload
+// starts the image job. Through this route one would be a file no job ever makes ready
+export const GENERAL_UPLOAD_PURPOSES = ['company_logo'] as const;
+
+export interface AttachmentRule {
   maxBytes: number;
   contentTypes: readonly string[];
 }
@@ -19,13 +24,19 @@ export const ATTACHMENT_RULES = {
     maxBytes: 2 * 1024 * 1024,
     contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
   },
+  // Step 26g: a product or banner photo, straight from a phone camera (4–8 MB is common). The job
+  // makes small WebP files from it, so the shop never sends this size to a shopper
+  storefront_image: {
+    maxBytes: 8 * 1024 * 1024,
+    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
+  },
 } satisfies Record<AttachmentPurpose, AttachmentRule>;
 
 // ফাইল পাঠানোর আগে শুধু তার বর্ণনা — ফাইল নিজে API-তে আসে না, সরাসরি storage-এ যায়।
 // ব্রাউজারও আগে থেকে একই schema দিয়ে যাচাই করে: ৩০ MB-র ছবি বাছলে আপলোড শুরুর আগেই error
 export const createUploadInputSchema = z
   .object({
-    purpose: z.enum(ATTACHMENT_PURPOSES),
+    purpose: z.enum(GENERAL_UPLOAD_PURPOSES),
     fileName: z.string().trim().min(1).max(200),
     contentType: z.string().max(100),
     sizeBytes: z.number().int().positive(),
@@ -57,16 +68,19 @@ export const attachmentSchema = z.object({
 });
 export type Attachment = z.infer<typeof attachmentSchema>;
 
+// ব্রাউজার ঠিক এই method, ঠিকানা আর header দিয়ে ফাইল পাঠাবে — header না মিললে storage সই
+// মানবে না (Content-Type সইয়ের অংশ)। Step 26g: its own schema, so the storefront photos' ticket
+// (storefront-admin.ts) has exactly the same upload part
+export const uploadTargetSchema = z.object({
+  method: z.literal('PUT'),
+  url: z.url(),
+  headers: z.record(z.string(), z.string()),
+  expiresAt: z.iso.datetime(),
+});
+
 export const uploadTicketSchema = z.object({
   attachment: attachmentSchema,
-  // ব্রাউজার ঠিক এই method, ঠিকানা আর header দিয়ে ফাইল পাঠাবে — header না মিললে storage সই
-  // মানবে না (Content-Type সইয়ের অংশ)
-  upload: z.object({
-    method: z.literal('PUT'),
-    url: z.url(),
-    headers: z.record(z.string(), z.string()),
-    expiresAt: z.iso.datetime(),
-  }),
+  upload: uploadTargetSchema,
 });
 export type UploadTicket = z.infer<typeof uploadTicketSchema>;
 
```

- `storefront_image` joins `ATTACHMENT_PURPOSES`, because the photo **is** an attachment: the same table, the same
  storage folder, the same presigned PUT (decision 2).
- `GENERAL_UPLOAD_PURPOSES` is what `POST /attachments` takes now (decision 8). That route needs
  `core.settings.manage`, and it starts no image job. A storefront photo sent through it would be a file no job ever
  makes ready, so the schema refuses the purpose there.
- 8 MB, not the logo's 2 MB: a phone's camera photo is often 4 to 8 MB, and the tenant should not have to shrink it
  first. The shop never sends this file to a shopper; it sends the job's WebP sizes.
- `uploadTargetSchema` is the upload part of the old ticket, now its own schema, so the storefront photo's ticket
  has exactly the same shape. Nothing about the old ticket changes.
- `AttachmentRule` is exported for `storefront-admin.ts`. It was a local interface before.

### The new permission: `permissions.ts`

```diff
@@ -53,6 +53,8 @@ export const PERMISSION_KEYS = [
   'pos.register.manage',
   'pos.shift.manage',
   'pos.return.create',
+  // Step 26g: everything in the Storefront menu, from the settings and the launch to the listings
+  'storefront.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -73,6 +75,7 @@ export const PERMISSION_GROUPS = [
   'sales',
   'purchase',
   'pos',
+  'storefront',
 ] as const;
 export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];
 
@@ -128,4 +131,5 @@ export const PERMISSION_GROUP_OF = {
   'pos.register.manage': 'pos',
   'pos.shift.manage': 'pos',
   'pos.return.create': 'pos',
+  'storefront.manage': 'storefront',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

`storefront.manage` gets a group of its own, `storefront` ("Online shop" in the role matrix). The shop is neither
sales nor inventory: the people who run it are often not the ones who post invoices or count stock. The database's
permission catalog (`packages/db/src/permission-catalog.ts`) is a `Record` over every key, so it stops type-checking
until 26g.2 adds the key there. That is expected.

### Error codes and audit events: `errors.ts`, `audit.ts`

```diff
@@ -639,6 +639,42 @@ export const ERROR_CODES = [
   'storefront_sale_percent',
   'storefront_sale_zero',
   'storefront_sale_dates',
+  // Step 26g: the Storefront screens. The shop's address and its links
+  'storefront_subdomain_format',
+  'storefront_subdomain_reserved',
+  'storefront_subdomain_taken',
+  'storefront_link_https',
+  'storefront_slug_format',
+  'storefront_slug_required',
+  'storefront_slug_taken',
+  // The settings: a zone named twice, no way to pay, a warehouse that is not this workspace's
+  // active one, saving the settings before the first save (or twice the first one), and "Open the
+  // shop" before the checklist is done (params say nothing: the page shows the checklist)
+  'storefront_zone_name_taken',
+  'storefront_payment_required',
+  'storefront_warehouse_invalid',
+  'storefront_not_set_up',
+  'storefront_set_up_already',
+  'storefront_launch_not_ready',
+  // The categories (the rest reuse the product categories' words: category_name_taken,
+  // category_parent_invalid, category_parent_loop, category_has_children)
+  'storefront_category_in_use',
+  'storefront_category_invalid',
+  // The listings: a variant listed already or archived, publishing without a photo or a price, a
+  // sale that takes nothing off the regular price
+  'storefront_variant_listed',
+  'storefront_variant_archived',
+  'storefront_listing_needs_photo',
+  'storefront_listing_no_price',
+  'storefront_sale_not_lower',
+  // The photos: one twice on a listing, one that is not ready (or not this workspace's), a file
+  // over 8 MB, and the image job's three refusals (STOREFRONT_IMAGE_FAILURES)
+  'storefront_image_twice',
+  'storefront_image_not_ready',
+  'storefront_image_file_too_large',
+  'storefront_image_unreadable',
+  'storefront_image_too_small',
+  'storefront_image_too_many_pixels',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

The categories reuse four codes of the product categories (`category_name_taken`, `category_parent_invalid`,
`category_parent_loop`, `category_has_children`): their words fit a shop category too. `category_in_use` does not.
Its words say "Products are in this category", so the shop has its own `storefront_category_in_use` ("Listings
are…"). The same for `file_too_large`: its words say "under 2 MB", so the photo has
`storefront_image_file_too_large`.

```diff
@@ -253,6 +253,20 @@ export const AUDIT_ACTIONS = [
   'report_schedule.paused',
   'report_schedule.resumed',
   'report_schedule.deleted',
+  // Step 26g: the shop (entity = the workspace's storefront, entityId = tenant id), its categories
+  // and its listings. A photo upload is not an event of its own: the listing's save that uses it is
+  'storefront.created',
+  'storefront.updated',
+  'storefront.launched',
+  'storefront_category.created',
+  'storefront_category.updated',
+  'storefront_category.moved',
+  'storefront_category.deleted',
+  'storefront_listing.created',
+  'storefront_listing.updated',
+  'storefront_listing.published',
+  'storefront_listing.unpublished',
+  'storefront_listing.deleted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -311,6 +325,9 @@ export const AUDIT_ENTITY_TYPES = [
   'pos_shift',
   'pos_return',
   'report_schedule',
+  'storefront',
+  'storefront_category',
+  'storefront_listing',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

The shop's own events have the entity `storefront`, whose id is the workspace's (one shop per workspace, like
`settings.updated`). A photo upload is not an event of its own: the listing's save that uses the photo is.

### Registered: `routes.ts`, `index.ts`

```diff
@@ -19,6 +19,7 @@ import { meRoutes } from './preferences.js';
 import { reportScheduleRoutes } from './report-schedules.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { stockMovementReportRoutes } from './stock-movement-report.js';
+import { storefrontRoutes } from './storefront-admin.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
@@ -155,4 +156,5 @@ export const routes = {
   posShifts: posShiftRoutes,
   posReturns: posReturnRoutes,
   publicStorefront: publicStorefrontRoutes,
+  storefront: storefrontRoutes,
 };
```

```diff
@@ -63,6 +63,7 @@ export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
 export * from './storefront.js';
 export * from './storefront-content.js';
+export * from './storefront-admin.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

### The words: `en.ts`, `bn.ts`

```diff
@@ -5638,6 +5638,7 @@ export const en = {
       sales: 'Sales',
       purchase: 'Purchase',
       pos: 'POS',
+      storefront: 'Online shop',
     },
     members_one: '{{count}} person',
     members_other: '{{count}} people',
@@ -5764,6 +5765,10 @@ export const en = {
         create: 'Take goods back at a POS counter, and pay the money back or use it on a new sale',
       },
     },
+    // Step 26g
+    storefront: {
+      manage: 'Run the online shop: its settings, categories, listings and photos, and open it',
+    },
   },
   invite: {
     checking: 'Checking your invitation…',
@@ -5839,6 +5844,9 @@ export const en = {
       pos_shift: 'POS shifts',
       pos_return: 'POS returns',
       report_schedule: 'Scheduled emails',
+      storefront: 'Online shop',
+      storefront_category: 'Shop categories',
+      storefront_listing: 'Shop listings',
     },
     columns: {
       when: 'When',
@@ -6163,6 +6171,25 @@ export const en = {
         resumed: 'Resumed a scheduled report email',
         deleted: 'Deleted a scheduled report email',
       },
+      // Step 26g
+      storefront: {
+        created: 'Set up the online shop',
+        updated: 'Changed the online shop’s settings',
+        launched: 'Opened the online shop',
+      },
+      storefront_category: {
+        created: 'Added a shop category',
+        updated: 'Edited a shop category',
+        moved: 'Moved a shop category up or down',
+        deleted: 'Deleted a shop category',
+      },
+      storefront_listing: {
+        created: 'Put a product in the shop',
+        updated: 'Edited a shop listing',
+        published: 'Showed a listing in the shop',
+        unpublished: 'Took a listing out of the shop',
+        deleted: 'Deleted a shop listing',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -7187,6 +7214,44 @@ export const en = {
     storefront_sale_percent: 'Type a whole percent from 1 to 99.',
     storefront_sale_zero: 'Type an amount above ৳0.',
     storefront_sale_dates: 'Pick an end after the start, or leave the end empty.',
+    // Step 26g
+    storefront_subdomain_format:
+      'Use lowercase letters, numbers and single hyphens, like nirvor-pharmacy.',
+    storefront_subdomain_reserved: 'Omnivo keeps this address. Try your shop’s name, like nirvor.',
+    storefront_subdomain_taken:
+      'Another shop has this address. Try adding your city, like nirvor-sylhet.',
+    storefront_link_https: 'Paste the whole link, starting with https://.',
+    storefront_slug_format:
+      'Use lowercase letters, numbers and single hyphens, like neem-face-wash.',
+    storefront_slug_required:
+      'Type a link name in English letters, like neem-face-wash. The name has none to make it from.',
+    storefront_slug_taken: 'Something else in the shop has this link name. Change it a little.',
+    storefront_zone_name_taken: 'Two zones have this name. Give each zone its own name.',
+    storefront_payment_required: 'Tick at least one way to pay.',
+    storefront_warehouse_invalid: 'Pick an active warehouse from the list.',
+    storefront_not_set_up: 'The shop is not set up yet. Save its settings first.',
+    storefront_set_up_already:
+      'The shop was set up in another tab or by someone else. Reload the page to see it.',
+    storefront_launch_not_ready:
+      'The shop can’t open yet. Do everything on the checklist, then open it.',
+    storefront_category_in_use:
+      'Listings are in this category. Move them to another category first.',
+    storefront_category_invalid: 'Pick a shop category from the list.',
+    storefront_variant_listed: 'This product is in the shop already. Open its listing instead.',
+    storefront_variant_archived: 'This product is archived. Restore it in Products first.',
+    storefront_listing_needs_photo: 'Add at least one photo, then show it in the shop.',
+    storefront_listing_no_price:
+      'Type a shop price, or give the product a sale price, then show it in the shop.',
+    storefront_sale_not_lower: 'The sale must take something off the regular price. Lower it.',
+    storefront_image_twice: 'This photo is on the listing twice. Remove one.',
+    storefront_image_not_ready: 'A photo is still being prepared. Wait for it, then save again.',
+    storefront_image_file_too_large: 'This photo is too large. Pick one under 8 MB.',
+    storefront_image_unreadable:
+      'This file can’t be read as a photo. Pick a JPEG, PNG or WebP photo.',
+    storefront_image_too_small:
+      'This photo is too small. Pick one at least 200 pixels on each side.',
+    storefront_image_too_many_pixels:
+      'This photo has too many pixels. Pick one under 40 megapixels, or make it smaller first.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -5275,6 +5275,7 @@ export const bn: Messages = {
       sales: 'বিক্রি',
       purchase: 'কেনাকাটা',
       pos: 'POS',
+      storefront: 'অনলাইন শপ',
     },
     members_one: '{{count}} জন',
     members_other: '{{count}} জন',
@@ -5387,6 +5388,9 @@ export const bn: Messages = {
         create: 'POS কাউন্টারে মাল ফেরত নেওয়া, আর টাকা ফেরত দেওয়া বা নতুন বিক্রিতে লাগানো',
       },
     },
+    storefront: {
+      manage: 'অনলাইন শপ চালানো: সেটিংস, ক্যাটাগরি, লিস্টিং আর ছবি, আর শপ খোলা',
+    },
   },
   invite: {
     checking: 'আপনার আমন্ত্রণ দেখা হচ্ছে…',
@@ -5462,6 +5466,9 @@ export const bn: Messages = {
       pos_shift: 'POS শিফট',
       pos_return: 'POS ফেরত',
       report_schedule: 'নিয়মিত ইমেইল',
+      storefront: 'অনলাইন শপ',
+      storefront_category: 'শপের ক্যাটাগরি',
+      storefront_listing: 'শপের লিস্টিং',
     },
     columns: {
       when: 'কখন',
@@ -5776,6 +5783,24 @@ export const bn: Messages = {
         resumed: 'রিপোর্টের নিয়মিত ইমেইল আবার চালু করেছেন',
         deleted: 'রিপোর্টের নিয়মিত ইমেইল মুছেছেন',
       },
+      storefront: {
+        created: 'অনলাইন শপ সেট আপ করেছেন',
+        updated: 'অনলাইন শপের সেটিংস বদলেছেন',
+        launched: 'অনলাইন শপ খুলেছেন',
+      },
+      storefront_category: {
+        created: 'শপের ক্যাটাগরি যোগ করেছেন',
+        updated: 'শপের ক্যাটাগরি বদলেছেন',
+        moved: 'শপের ক্যাটাগরি উপরে বা নিচে সরিয়েছেন',
+        deleted: 'শপের ক্যাটাগরি মুছেছেন',
+      },
+      storefront_listing: {
+        created: 'একটা প্রোডাক্ট শপে দিয়েছেন',
+        updated: 'শপের লিস্টিং বদলেছেন',
+        published: 'লিস্টিং শপে দেখিয়েছেন',
+        unpublished: 'লিস্টিং শপ থেকে সরিয়েছেন',
+        deleted: 'শপের লিস্টিং মুছেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -6754,6 +6779,41 @@ export const bn: Messages = {
     storefront_sale_percent: '১ থেকে ৯৯-এর মধ্যে একটা পূর্ণ শতাংশ লিখুন।',
     storefront_sale_zero: '৳০-এর বেশি একটা অঙ্ক লিখুন।',
     storefront_sale_dates: 'শুরুর পরের একটা শেষ সময় বাছুন, অথবা শেষ সময় ফাঁকা রাখুন।',
+    storefront_subdomain_format:
+      'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা আর একটা করে হাইফেন দিন, যেমন nirvor-pharmacy।',
+    storefront_subdomain_reserved:
+      'এই ঠিকানা Omnivo নিজে রাখে। শপের নাম দিয়ে চেষ্টা করুন, যেমন nirvor।',
+    storefront_subdomain_taken:
+      'এই ঠিকানা আরেকটা শপের। শহরের নাম যোগ করে দেখুন, যেমন nirvor-sylhet।',
+    storefront_link_https: 'https:// দিয়ে শুরু হওয়া পুরো লিংকটা দিন।',
+    storefront_slug_format:
+      'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা আর একটা করে হাইফেন দিন, যেমন neem-face-wash।',
+    storefront_slug_required:
+      'ইংরেজি অক্ষরে একটা লিংকের নাম দিন, যেমন neem-face-wash। নামে ইংরেজি অক্ষর নেই, তাই নিজে থেকে বানানো যায়নি।',
+    storefront_slug_taken: 'শপের আরেকটা জিনিসের এই লিংকের নাম আছে। একটু বদলে দিন।',
+    storefront_zone_name_taken: 'দুইটা এলাকার একই নাম। প্রতিটা এলাকার আলাদা নাম দিন।',
+    storefront_payment_required: 'অন্তত একটা পেমেন্টের উপায়ে টিক দিন।',
+    storefront_warehouse_invalid: 'তালিকা থেকে একটা চালু ওয়্যারহাউস বাছুন।',
+    storefront_not_set_up: 'শপ এখনো সেট আপ হয়নি। আগে এর সেটিংস সেভ করুন।',
+    storefront_set_up_already:
+      'অন্য ট্যাবে বা অন্য কেউ শপটা সেট আপ করে ফেলেছেন। দেখতে পেজটা রিলোড করুন।',
+    storefront_launch_not_ready: 'শপ এখনো খোলা যাবে না। চেকলিস্টের সব কাজ শেষ করে তারপর খুলুন।',
+    storefront_category_in_use: 'এই ক্যাটাগরিতে লিস্টিং আছে। আগে সেগুলো অন্য ক্যাটাগরিতে সরান।',
+    storefront_category_invalid: 'তালিকা থেকে শপের একটা ক্যাটাগরি বাছুন।',
+    storefront_variant_listed: 'এই প্রোডাক্ট আগে থেকেই শপে আছে। এর লিস্টিংটা খুলুন।',
+    storefront_variant_archived: 'এই প্রোডাক্ট আর্কাইভ করা। আগে Products থেকে ফিরিয়ে আনুন।',
+    storefront_listing_needs_photo: 'অন্তত একটা ছবি দিন, তারপর শপে দেখান।',
+    storefront_listing_no_price:
+      'শপের দাম লিখুন, বা প্রোডাক্টের বিক্রয়মূল্য দিন, তারপর শপে দেখান।',
+    storefront_sale_not_lower: 'অফারে সাধারণ দাম থেকে কিছু কমতে হবে। দামটা কমান।',
+    storefront_image_twice: 'এই ছবি লিস্টিংয়ে দুইবার আছে। একটা সরান।',
+    storefront_image_not_ready:
+      'একটা ছবি এখনো তৈরি হচ্ছে। শেষ হওয়া পর্যন্ত অপেক্ষা করে আবার সেভ করুন।',
+    storefront_image_file_too_large: 'ছবিটা অনেক বড়। ৮ MB-র ছোট একটা বাছুন।',
+    storefront_image_unreadable: 'এই ফাইল ছবি হিসেবে পড়া যাচ্ছে না। JPEG, PNG বা WebP ছবি বাছুন।',
+    storefront_image_too_small: 'ছবিটা অনেক ছোট। প্রতিটা দিকে অন্তত ২০০ পিক্সেলের একটা বাছুন।',
+    storefront_image_too_many_pixels:
+      'ছবিটায় অনেক বেশি পিক্সেল। ৪০ মেগাপিক্সেলের কম একটা বাছুন, বা আগে ছোট করে নিন।',
   },
   ui: {
     dataTable: {
```

The permission's line, its group, the audit events and the errors. The screens' own words come in 26g.5. Each error
says how to fix the problem, and the Bangla keeps `slug`-like examples in English letters (`nirvor-sylhet`),
because that is what the box takes.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test              # 562 tests
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/i18n typecheck
pnpm exec eslint packages/contracts/src packages/i18n/src
```

Expected to fail until later parts, and only these:

- `packages/db` (`permission-catalog.ts` has no line for `storefront.manage`) and everything that builds on it,
  until 26g.2.
- `apps/api`'s `contract.spec.ts` and `pnpm test:openapi` (20 routes with no controller yet), until 26g.3.

## 26g.2 — The database

This part adds one table, `storefront_images`, and the new permission's line in the database's catalog. Nothing
else in the database changes: the listings already keep their photos as `StorefrontImage` ids (26f), and the
audit log has no check on its entity types.

**Decision 17 (the user's, 2026-11-16): a photo's job state has its own table.** The other choice was more columns
on `attachments` (a `processing` and a `failed` status, a failure code, a width and a height). That would give
`ready` two meanings: "the file is confirmed" for a receipt's scan, and "the shop's files are made" for a photo.
It would also need a check per purpose, because a scan never has a width. With a table of its own, `attachments`
stays exactly as it is, and every rule about a photo sits in one place.

A photo goes through these states:

| State the screen shows | `attachments.status` | `storefront_images` row |
|---|---|---|
| uploading | `pending` | none |
| processing | `ready` (confirmed) | `processing` |
| ready | `ready` | `ready`, with width and height |
| failed | `ready` | `failed`, with a failure code |

The row is made when the upload is confirmed, in the same transaction that marks the attachment ready and queues
the job (26g.3). So "confirmed but no row" never happens, and "no row" can only mean "still uploading".

### The table: `storefront.ts`

```diff
@@ -2,6 +2,9 @@ import {
   LANGUAGE_CODES,
   SHOP_PAYMENT_METHODS,
   SHOP_TEXT_PAGES,
+  STOREFRONT_IMAGE_FAILURES,
+  STOREFRONT_IMAGE_MAX_PIXELS,
+  STOREFRONT_IMAGE_MIN_SIDE,
   STOREFRONT_SALE_KINDS,
   type ShopBadge,
   type ShopDeliveryZone,
@@ -14,6 +17,7 @@ import {
   check,
   foreignKey,
   index,
+  integer,
   jsonb,
   numeric,
   pgTable,
@@ -25,6 +29,7 @@ import {
   uuid,
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
+import { attachments } from './attachments.js';
 import { productVariants } from './products.js';
 import { tenants } from './tenants.js';
 import { warehouses } from './warehouses.js';
@@ -526,3 +531,62 @@ export const storefrontPages = pgTable(
     ),
   ],
 );
+
+// Step 26g: what the image job made of an uploaded photo. The photo itself is an attachment
+// (purpose storefront_image), uploaded and confirmed like any other; this row starts when the
+// upload is confirmed and the job is queued, in the same transaction. Before that there is no row,
+// and the screens call the photo "uploading". Its own table, not more columns on attachments: a
+// receipt's scan has no width and no job, and "ready" on attachments keeps one meaning for every
+// purpose (the file is confirmed). StorefrontImage.id is this id, and so the attachment's.
+export const storefrontImages = pgTable(
+  'storefront_images',
+  {
+    // The attachment's id, never a new one: the files are under storefront/<id>/ and the forms
+    // save this id, so one id names the photo everywhere. No default on purpose
+    id: uuid('id').primaryKey(),
+    tenantId: uuid('tenant_id')
+      .notNull()
+      .references(() => tenants.id),
+    status: text('status', { enum: ['processing', 'ready', 'failed'] })
+      .notNull()
+      .default('processing'),
+    // Why the job could not use it, as the error code the screen shows (errors.*)
+    failureCode: text('failure_code', { enum: STOREFRONT_IMAGE_FAILURES }),
+    // The original's size after the EXIF rotation, so a phone's portrait photo is taller than wide
+    width: integer('width'),
+    height: integer('height'),
+    createdAt: baseColumns().createdAt,
+    // When the job finished, either way
+    processedAt: timestamp('processed_at', { withTimezone: true }),
+  },
+  (table) => [
+    // The photo is this workspace's attachment. The pair, not the id alone: another workspace's
+    // attachment id is refused here too, whatever the API checks first. CASCADE: the row only
+    // describes its attachment, so the later unused-photo cleanup deletes the attachment alone
+    foreignKey({
+      name: 'storefront_images_attachment_fk',
+      columns: [table.tenantId, table.id],
+      foreignColumns: [attachments.tenantId, attachments.id],
+    }).onDelete('cascade'),
+    // Each state has exactly its own fields, one line per state like pos_shifts_status_check, so
+    // a status or a code the list does not know is refused too: a code only when failed, a size
+    // only when ready, a finish time unless still processing. The screen's union
+    // (storefrontUploadSchema) can then be read straight from a row, with no "ready but no width"
+    // case to guess about. "failure_code IS NOT NULL" before the IN is not extra: NULL IN (…) is
+    // NULL, not false, and a CHECK passes on NULL, so without it a failed row with no code got in
+    check(
+      'storefront_images_state_check',
+      sql`(${table.status} = 'processing' AND ${table.failureCode} IS NULL AND ${table.width} IS NULL AND ${table.height} IS NULL AND ${table.processedAt} IS NULL)
+        OR (${table.status} = 'ready' AND ${table.failureCode} IS NULL AND ${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.processedAt} IS NOT NULL)
+        OR (${table.status} = 'failed' AND ${table.failureCode} IS NOT NULL AND ${table.failureCode} IN (${sql.raw(STOREFRONT_IMAGE_FAILURES.map((code) => `'${code}'`).join(', '))}) AND ${table.width} IS NULL AND ${table.height} IS NULL AND ${table.processedAt} IS NOT NULL)`,
+    ),
+    // The job's limits again, so a ready photo is always one the shop's cards can show
+    check(
+      'storefront_images_size_check',
+      sql`${table.width} IS NULL OR (
+        ${table.width} >= ${sql.raw(String(STOREFRONT_IMAGE_MIN_SIDE))}
+        AND ${table.height} >= ${sql.raw(String(STOREFRONT_IMAGE_MIN_SIDE))}
+        AND ${table.width}::bigint * ${table.height} <= ${sql.raw(String(STOREFRONT_IMAGE_MAX_PIXELS))})`,
+    ),
+  ],
+);
```

Why each part is written this way:

- **`id` has no default.** It is always the attachment's id. The files are under `storefront/<id>/`, and the forms
  save this id as `StorefrontImage.id`. One id names the photo everywhere, so nothing has to map one id to another.
  A default would let a bug make a row with a fresh id that matches no attachment. The FK would refuse that row,
  but with no default the mistake cannot even be written.
- **No `baseColumns()`.** Only the job writes the row after it is made, and it writes it once. There is nothing to
  lock with a `version` and no person to name in `updated_by`. The attachment already records who uploaded it.
- **The composite FK `(tenant_id, id)` to `attachments`.** It uses the pair, not the id alone. Then a row in
  workspace A can never point at an attachment of workspace B, whatever the API checks first. The pair needs the
  unique index `attachments_tenant_id_idx`, which the logo's FK in `tenant_settings` already uses.
- **`ON DELETE CASCADE`.** The row only describes its attachment and means nothing without it. The later
  unused-photo cleanup can then delete the attachment alone. The only other FK to `attachments`, the workspace
  logo's in `tenant_settings`, has no cascade: a settings row means something on its own, so there a refusal is
  right.
- **The FK does not check the purpose.** It cannot check that the attachment's purpose is `storefront_image`
  without an extra column and an extra unique index on `attachments`. The API checks the purpose when it confirms
  the upload (26g.3). 26f made the same choice for an image banner's kind.
- **`storefront_images_state_check` has one line per state**, like `pos_shifts_status_check`. Each line says
  exactly which fields that state has: a failure code only when failed, a size only when ready, a finish time
  unless still processing. A shorter form like `(status = 'failed') = (failure_code IS NOT NULL)` was tried first.
  It let an unknown status (`'done'`) through, because every comparison in it was simply false. With one line per
  state, a status or a failure code that the list does not know matches no line, so the row is refused. That
  matters because the API reads a row straight into the screen's union (`storefrontUploadSchema`), and a row
  outside the union would fail that parse on every request.
- **`failure_code IS NOT NULL` before the `IN`** looks like it adds nothing, but it does. `NULL IN (…)` is
  `NULL`, not false. A CHECK refuses a row only when the check is false, so a `NULL` lets the row in, even when
  the other two lines are false. Without that part, the check below found that a failed row with no code got in.
- **The failure codes come from the contracts** (`STOREFRONT_IMAGE_FAILURES`), written into the check with
  `sql.raw`. A check cannot take a bound parameter, and these are the file's own constants, never input (the same
  reason as `matches()` above it). A new failure code in the contracts then needs a new migration, which
  `drizzle-kit generate` writes by itself, because the check's text changes.
- **`storefront_images_size_check` repeats the job's limits** (200px a side, 40 megapixels), so a ready photo is
  always one the shop's cards can show, even if a later job has a bug. `width::bigint` is there because two
  `integer`s multiply as an `integer`: 100,000 × 100,000 would overflow and throw an error instead of failing the
  check cleanly.
- **`width` and `height` are the size after the EXIF turn.** A phone's portrait photo is stored on its side with a
  "turn me" note. The job turns it first, so the numbers are what a shopper sees.
- **No index besides the primary key.** The API and the job always find a row by its id, and the FK's cascade
  looks it up by `(tenant_id, id)`, which the primary key on `id` already covers.

### The migrations

```sql
CREATE TABLE "storefront_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"failure_code" text,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "storefront_images_state_check" CHECK (("storefront_images"."status" = 'processing' AND "storefront_images"."failure_code" IS NULL AND "storefront_images"."width" IS NULL AND "storefront_images"."height" IS NULL AND "storefront_images"."processed_at" IS NULL)
        OR ("storefront_images"."status" = 'ready' AND "storefront_images"."failure_code" IS NULL AND "storefront_images"."width" IS NOT NULL AND "storefront_images"."height" IS NOT NULL AND "storefront_images"."processed_at" IS NOT NULL)
        OR ("storefront_images"."status" = 'failed' AND "storefront_images"."failure_code" IS NOT NULL AND "storefront_images"."failure_code" IN ('storefront_image_unreadable', 'storefront_image_too_small', 'storefront_image_too_many_pixels') AND "storefront_images"."width" IS NULL AND "storefront_images"."height" IS NULL AND "storefront_images"."processed_at" IS NOT NULL)),
	CONSTRAINT "storefront_images_size_check" CHECK ("storefront_images"."width" IS NULL OR (
        "storefront_images"."width" >= 200
        AND "storefront_images"."height" >= 200
        AND "storefront_images"."width"::bigint * "storefront_images"."height" <= 40000000))
);
--> statement-breakpoint
ALTER TABLE "storefront_images" ADD CONSTRAINT "storefront_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_images" ADD CONSTRAINT "storefront_images_attachment_fk" FOREIGN KEY ("tenant_id","id") REFERENCES "public"."attachments"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
```

`0065` is what `drizzle-kit generate --name storefront-images` writes from the schema. Do not edit it by hand: the
next `generate` compares the schema with the snapshot in `meta/`, not with this file.

```sql
-- Custom SQL migration file, put your code below! --
-- Step 26g: the tenant rules for storefront_images (made by 0065), like every tenant table:
-- ENABLE + FORCE RLS + tenant_isolation, with NULLIF as in 0002 (an unset app.tenant_id is '' on a
-- pooled connection, and ''::uuid would throw instead of matching nothing). FORCE keeps the table's
-- owner, the migrator, inside the rule too. The API and the image job both use omnivo_app with
-- app.tenant_id set to the photo's workspace; its SELECT/INSERT/UPDATE/DELETE come from the
-- default privileges in infra/docker/postgres/init/01-roles.sql, as for every table.
ALTER TABLE storefront_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_images FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront_images
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No grant to omnivo_public, on purpose: the shop never reads this table. It turns an image id into
-- an address by itself (storefront/<id>/<size>.webp), and the API saves only ready photos' ids, so
-- a shopper's request has nothing to ask here. 0064 gave the role no default privileges, so the
-- table stays closed to it.
```

`0066` is a custom migration (`drizzle-kit generate --custom --name storefront-images-rules`), because drizzle
cannot write row-level security:

- **`ENABLE` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation`**, the same three lines as every tenant table. The
  `NULLIF` matters on a pooled connection: there an unset `app.tenant_id` reads as `''`, and `''::uuid` would throw
  an error instead of matching nothing.
- **No grant to `omnivo_public`.** The shop never reads this table. It turns an image id into an address by itself
  (`storefront/<id>/<size>.webp`), and the API saves only the ids of ready photos into a listing. 0064 gave that
  role no default privileges, so the table stays closed to it, and the check below proves it.
- `omnivo_app` needs no grant line either: its rights on every new table come from the default privileges in
  `infra/docker/postgres/init/01-roles.sql`.

### The permission's line: `permission-catalog.ts`

```diff
@@ -68,6 +68,8 @@ const DESCRIPTIONS = {
     "See every register's shifts and cash differences, and close a stuck shift without a count",
   'pos.return.create':
     'Take goods back at a POS register and pay the money back, or use it for an exchange',
+  'storefront.manage':
+    'Run the online shop: its settings, categories, listings and photos, and open it to shoppers',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

The catalog is a `Record` over every `PermissionKey`, so after 26g.1 the db package stopped type-checking until
this line was added. No migration inserts the permission: `migrate.ts` calls `syncPermissions()` after the
migrations, which adds new keys and updates descriptions. The owner role gets every permission by its `kind`, and
the role templates get `storefront.manage` in 26g.3.

**Why the outbox event type is not here.** The image job's event (`storefront.image_uploaded`) goes into
`OUTBOX_EVENT_TYPES` in this package. The API keeps three maps that must name every event type: the payload
schemas (`outbox.ts`), the queues (`queues.ts`) and the handlers (`handlers.ts`). Adding the type here alone would
break the API's type check until 26g.3, so the type is added in 26g.3, together with its payload, queue and
handler.

### Check this part

```bash
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/db typecheck
pnpm exec eslint packages/db/src
pnpm exec prettier --check packages/db/src
pnpm --filter @omnivo/api exec tsc --noEmit      # clean again after this part
pnpm db:migrate
```

The guide was checked against a fresh Postgres 17 with every migration, as the migrator, and then with this
script as `omnivo_app`:

- the normal life: processing, then ready or failed, and a second row for the same photo refused;
- a failed row with no code refused (the case the `IS NOT NULL` above is for);
- another workspace's attachment refused, by the FK under this tenant's id and by RLS under its own;
- every wrong combination of state, failure code, size and finish time refused, including an unknown status
  and an unknown code;
- the size edges: 199px refused, 200 × 200 accepted, exactly 40 MP accepted, one row more refused, and
  100,000 × 100,000 refused without an overflow;
- another workspace, and no workspace (`''`), see and change nothing;
- deleting the attachment deletes its row;
- `omnivo_public` gets "permission denied";
- `storefront.manage` is in `permissions` after the migrate.

Expected to fail until 26g.3, and only these: `apps/api`'s `contract.spec.ts` and `pnpm test:openapi` (20 routes
with no controller yet).

## 26g.3 — The API and the image job

This part serves the 20 routes of 26g.1 and adds the worker job that turns an uploaded photo into the shop's
WebP files. After it, `contract.spec.ts` and `pnpm test:openapi` pass again. The screens come in 26g.6; the
integration tests in 26g.4.

What the part adds, from the bottom up:

```
packages/db      outbox-events.ts: the event 'storefront.image_uploaded'
apps/api
  worker/        queues.ts, handlers.ts, worker.module.ts: the event's queue and handler
  common/outbox  outbox.ts: the event's payload { imageId }
  storage/       storage.service.ts: the public storefront/ folder in dev, a Cache-Control on put()
  attachments/   attachments.service.ts: upload and confirm reused by the shop's photos
  storefront/
    media.ts          the size names as a list, the file's key
    image-files.ts    sharp: one photo in, three WebP files out (or why not)
    image.handler.ts  the job: read the original, make the files, mark the row
    shop-url.ts       a shop's own address ("View shop")
    admin/            the Storefront menu: settings, categories, photos, listings, the controller
  config.ts      SHOP_PUBLIC_PORT
  setup/         templates.ts: storefront.manage for the shop's managers
infra/staging    compose.yml (mc anonymous), Caddyfile (the photos may be cached)
```

Decisions made while writing this part (mine, numbered after 26g.2's 17):

18. **The suggested subdomain is the workspace's slug when it can be one.** Whether another shop already has
    it is a question about other workspaces, and this transaction cannot see them (RLS). The first save
    answers it (`storefront_subdomain_taken` on the box). Workspace slugs are unique and shops start from
    them, so a clash is rare. The contract's comment says so now.
19. **A photo is confirmed and its job row made in one transaction**, with the outbox event. The general
    `/attachments` routes no longer confirm or download a shop photo, and the shop's routes do not take a logo.
    The original keeps the phone's EXIF data, its GPS position too; only the job reads it.
20. **Only `storefront/` is public.** A bucket policy lets anyone read `storefront/*` and nothing else. In
    dev and in the tests the API sets it when it starts (like the bucket); staging's `storage-init` sets it
    with `mc anonymous`; production's bucket is set up outside the app (step 25).
21. **The job measures before it decodes.** It reads the header, refuses anything that is not JPEG, PNG or
    WebP by its bytes, refuses over 40 MP or under 200px after the EXIF turn, then makes the three sizes,
    never larger than the photo. It writes the files before it marks the row ready. When the last try fails,
    the photo is marked failed, so the screen never waits for good.
22. **"View shop" is `http://<sub>.localhost:4321` in dev and `https://<sub>.<domain>` in production.**
    `SHOP_PUBLIC_PORT` changes the port; it is not needed in dev.
23. **"Add to shop" offers active goods that are not listed yet**, A to Z. A service has no stock to sell.
24. **A new listing's slug** comes from its name, else from the SKU (a Bangla name has no Latin letter), else
    `listing`, then the first free one of `slug`, `slug-2`, `slug-3`…
25. **The sale is checked at save time, without its dates:** it must take something off and leave something
    to pay, at today's price. A sale needs a price. A published listing keeps a photo and a price; publishing
    needs both, and an active product and variant. Publishing twice, and opening the shop twice, change
    nothing.
26. **Move up / down numbers the siblings 1, 2, 3… first,** then swaps two, and writes only the rows whose
    number changed, each with a new version.
27. **The launch checklist's listing is one the shop would show:** published, with its product and variant
    not archived. Its warehouse must still be active.
28. **The role templates:** retail's "Shop manager" and the general "Manager" get `storefront.manage`. The
    owner has every permission anyway.
29. **A new delivery zone's id is random** (`zone-1f3a9c2b`), not made from its name: a Bangla name has no
    Latin letter, and two zones renamed into each other's names must not swap the carts that picked them.

### The event: `outbox-events.ts`, `outbox.ts`, `queues.ts`

```diff
@@ -24,6 +24,7 @@ export const OUTBOX_EVENT_TYPES = [
   'pos.shift_variance',
   'report.schedule_due',
   'report.schedule_email',
+  'storefront.image_uploaded',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

```diff
@@ -51,6 +51,9 @@ export const outboxPayloadSchemas = {
   'report.schedule_due': z.object({ scheduleId: z.uuid(), runAt: z.iso.datetime() }),
   // Step 21c: a scheduled report's file is ready; email it to the person it was made for
   'report.schedule_email': z.object({ exportId: z.uuid(), scheduleId: z.uuid() }),
+  // Step 26g: a shop photo's upload was confirmed. Its storefront_images row (processing) and its
+  // attachment say everything; the worker makes the shop's WebP files from the original
+  'storefront.image_uploaded': z.object({ imageId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

```diff
@@ -30,6 +30,7 @@ const QUEUE_OF = {
   'pos.sold_short': 'jobs',
   'pos.shift_variance': 'jobs',
   'report.schedule_due': 'jobs',
+  'storefront.image_uploaded': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```

- **The payload is the photo's id only**, like every event: the worker reads the rows when it runs, so the
  payload cannot go stale and holds nothing private. The id is enough because the `storefront_images` row
  and its attachment say everything else (the workspace, the storage key).
- **The `jobs` queue**, not `email`: a slow mail server must not hold up a photo, and a big photo must not
  hold up an invitation.
- The three lists are checked by the type checker (`satisfies Record<OutboxEventType, …>` and the handlers'
  mapped type), which is why the event type waited for this part (26g.2's note).

### `sharp`: `package.json`

```diff
@@ -48,6 +48,7 @@
     "pdfkit": "^0.20.2",
     "reflect-metadata": "^0.2.2",
     "rxjs": "^7.8.2",
+    "sharp": "^0.35.5",
     "write-excel-file": "^4.1.1",
     "zod": "^4.6.5"
   }
```

```bash
pnpm --filter @omnivo/api add sharp
```

`sharp` is libvips for Node. It is in the API's package only, because only the worker uses it. It needs no
build step: its binaries come as optional packages for each platform (`@img/sharp-linuxmusl-x64` for the Alpine
image), so `pnpm-workspace.yaml`'s `allowBuilds` does not change. The lockfile changes very little, because
the shop (Astro) already had it.

### The file names: `media.ts`

```diff
@@ -11,16 +11,28 @@ import type { ShopImage, StorefrontImage } from '@omnivo/contracts';
 // - large: 1200px. The product page's photo (524px) and the phone's banners (up to 393px, 2x–3x)
 // - wide: 2560px. The desktop banners (1280px)
 // Step 26g's job makes exactly these; a size added here needs it there too.
-export const STOREFRONT_IMAGE_SIZES = { small: 480, large: 1200, wide: 2560 } as const;
+// Step 26g: the names as a list too, for the job's loop (Object.keys would type them as string).
+// satisfies Record: a name in one and not the other does not compile
+export const STOREFRONT_IMAGE_SIZE_NAMES = ['small', 'large', 'wide'] as const;
+export type StorefrontImageSize = (typeof STOREFRONT_IMAGE_SIZE_NAMES)[number];
 
-export type StorefrontImageSize = keyof typeof STOREFRONT_IMAGE_SIZES;
+export const STOREFRONT_IMAGE_SIZES = {
+  small: 480,
+  large: 1200,
+  wide: 2560,
+} as const satisfies Record<StorefrontImageSize, number>;
 
-// mediaUrl is the config's storefront.mediaUrl, with no "/" at its end. The id is a uuid
-// (storefrontImageSchema), so it needs no escaping in a path
+// Step 26g: the file's key in the storage, which the image job writes and the address reads. The
+// id is a uuid (storefrontImageSchema), so it needs no escaping in a path
+export function shopImageKey(id: string, size: StorefrontImageSize): string {
+  return `storefront/${id}/${size}.webp`;
+}
+
+// mediaUrl is the config's storefront.mediaUrl, with no "/" at its end
 export function shopImage(
   mediaUrl: string,
   image: StorefrontImage,
   size: StorefrontImageSize,
 ): ShopImage {
-  return { url: `${mediaUrl}/storefront/${image.id}/${size}.webp`, alt: image.alt };
+  return { url: `${mediaUrl}/${shopImageKey(image.id, size)}`, alt: image.alt };
 }
```

- **`STOREFRONT_IMAGE_SIZE_NAMES`** is the list the job loops over. `Object.keys(STOREFRONT_IMAGE_SIZES)` would
  give `string[]`, and turning it back into the size type needs a cast. With the list as the source of the
  type, and `satisfies Record<StorefrontImageSize, number>` on the widths, a size in one and not the other does
  not compile, in either direction.
- **`shopImageKey()`** is the one place that spells the file's key. The job writes to it and `shopImage()`
  builds the address from it, so the two can never disagree on a path.

### One photo in, three files out: `image-files.ts`

```ts
import {
  STOREFRONT_IMAGE_MAX_PIXELS,
  STOREFRONT_IMAGE_MIN_SIDE,
  type STOREFRONT_IMAGE_FAILURES,
} from '@omnivo/contracts';
import sharp, { type Metadata } from 'sharp';

import {
  STOREFRONT_IMAGE_SIZE_NAMES,
  STOREFRONT_IMAGE_SIZES,
  type StorefrontImageSize,
} from './media.js';

// Step 26g: the image job's work, without the queue, the database or the storage, so a unit test
// can feed it real pictures. One uploaded photo in, the shop's three WebP files out (26f's
// media.ts names them), or the reason the photo cannot be used.

export type StorefrontImageFailure = (typeof STOREFRONT_IMAGE_FAILURES)[number];

export interface ShopImageFile {
  size: StorefrontImageSize;
  body: Buffer;
}

export type MadeShopImages =
  | { ok: true; width: number; height: number; files: ShopImageFile[] }
  | { ok: false; code: StorefrontImageFailure };

// The formats the upload allows (ATTACHMENT_RULES.storefront_image). The browser's content type is
// only what it said: the bytes decide. libvips also reads SVG, HEIF, TIFF, GIF and PDF, and a file
// named photo.png can be any of them; anything but these three is refused as unreadable
const FORMATS: ReadonlySet<string> = new Set(['jpeg', 'png', 'webp']);

// WebP at 80 is about a third of a JPEG at the same look; effort 4 (sharp's default) is the
// balance of time and size, and a photo is made once
const WEBP = { quality: 80, effort: 4 } as const;

// The worker runs for days and makes photos now and then: libvips' cache would keep each
// decoded photo in memory for nothing
sharp.cache(false);

export async function makeShopImages(original: Uint8Array): Promise<MadeShopImages> {
  // The header only: metadata() does not decode the pixels, so a "decompression bomb" (a small
  // file that unpacks to gigapixels) is measured here before anything is unpacked
  let meta: Metadata;
  try {
    meta = await sharp(original).metadata();
  } catch {
    return { ok: false, code: 'storefront_image_unreadable' };
  }
  if (!FORMATS.has(meta.format)) {
    return { ok: false, code: 'storefront_image_unreadable' };
  }
  // autoOrient: the size after the EXIF turn. A phone's portrait photo is stored on its side
  // (4032 × 3024) with a "turn me" note; a shopper sees it 3024 × 4032
  const { width, height } = meta.autoOrient;
  if (width * height > STOREFRONT_IMAGE_MAX_PIXELS) {
    return { ok: false, code: 'storefront_image_too_many_pixels' };
  }
  if (Math.min(width, height) < STOREFRONT_IMAGE_MIN_SIDE) {
    return { ok: false, code: 'storefront_image_too_small' };
  }

  try {
    // limitInputPixels again, as a second lock: the check above read the header, and a file whose
    // pixels disagree with its header must still not unpack past the limit. rotate() with no
    // angle turns the photo the way its EXIF says; each size is a clone that keeps both settings
    const upright = sharp(original, { limitInputPixels: STOREFRONT_IMAGE_MAX_PIXELS }).rotate();
    const files = await Promise.all(
      STOREFRONT_IMAGE_SIZE_NAMES.map(async (size) => ({
        size,
        // withoutEnlargement: a 1,000px photo stays 1,000px in "large" and "wide". Blown up it
        // would only be blurred and heavier. No metadata call: sharp drops EXIF (the phone's GPS
        // position too), XMP and IPTC unless asked to keep them, and turns the colours into sRGB
        body: await upright
          .clone()
          .resize({ width: STOREFRONT_IMAGE_SIZES[size], withoutEnlargement: true })
          .webp(WEBP)
          .toBuffer(),
      })),
    );
    return { ok: true, width, height, files };
  } catch {
    // A header that reads but pixels that do not (a cut-off upload, a broken JPEG)
    return { ok: false, code: 'storefront_image_unreadable' };
  }
}
```

The job's work, without the queue, the database or the storage, so a unit test can give it real pictures.

- **`metadata()` first.** It reads the file's header and does not decode the pixels. A "decompression bomb"
  is a small file (a few KB of one colour) that says it is 50,000 × 50,000; decoding it would take gigabytes of
  the worker's memory. Measured from the header, it is refused before anything is unpacked.
- **`FORMATS` checks the bytes, not the content type.** The browser's `image/png` is only what it said, and
  storage only checks that the upload matched what was declared. libvips also reads SVG, HEIF, TIFF, GIF and
  PDF. SVG in particular can hold scripts and links; none of these is what the shop expects, so they are all
  "unreadable".
- **`meta.autoOrient`** is the size after the EXIF turn. A phone stores a portrait photo on its side
  (4032 × 3024) with a note "turn me 90°". The limits and the saved size are about what a shopper sees.
- **The pixel limit before the side limit**, so a huge photo gets the right reason.
- **`limitInputPixels` again** in the real decode. The header check above trusts the header; a file whose
  pixels disagree with it must still not unpack past the limit. Then libvips throws, and the `catch` turns it
  into "unreadable".
- **`.rotate()` with no angle** turns the photo the way its EXIF says, so the WebP files need no EXIF at all.
- **`clone()` per size.** Each size is its own pipeline over the same input and the same settings; the three
  run together with `Promise.all`.
- **`withoutEnlargement`.** A 1,000px photo stays 1,000px in "large" and "wide". Blowing it up would only make
  a bigger, blurred file.
- **No `.withMetadata()` / `.keepMetadata()`.** sharp drops EXIF (the camera, the time, the GPS position),
  XMP and IPTC by default, and turns the colours into sRGB. The shop's files carry no data about the tenant's
  phone.
- **WebP at quality 80**, about a third of a JPEG that looks the same.
- **`sharp.cache(false)`**: the worker runs for days and makes a photo now and then. libvips' cache would only
  keep each decoded photo in memory.
- **The second `catch`**: a header that reads but pixels that do not (a JPEG cut off halfway) is
  "unreadable", not a crash that the queue would try again for nothing.

```ts
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { makeShopImages } from './image-files.js';

// Real pictures made by sharp itself, so the test needs no fixture files
function photo(width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg') {
  return sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 88, b: 89 } },
  }).toFormat(format);
}

describe('makeShopImages', () => {
  it('makes the three sizes as WebP, never wider than the photo', async () => {
    const made = await makeShopImages(await photo(1600, 1200).toBuffer());
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect({ width: made.width, height: made.height }).toEqual({ width: 1600, height: 1200 });
    const sizes = await Promise.all(
      made.files.map(async (file) => {
        const meta = await sharp(file.body).metadata();
        return [file.size, meta.format, meta.width, meta.height];
      }),
    );
    // small 480, large 1200, and "wide" stays 1600: never blown up
    expect(sizes).toEqual([
      ['small', 'webp', 480, 360],
      ['large', 'webp', 1200, 900],
      ['wide', 'webp', 1600, 1200],
    ]);
  });

  it('turns a phone photo upright from its EXIF note, and drops the EXIF', async () => {
    // Stored 800 × 400 with orientation 6 ("turn 90° clockwise"): a shopper sees 400 × 800
    const sideways = await photo(800, 400)
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'Phone', Copyright: 'Rahim' } } })
      .toBuffer();
    const made = await makeShopImages(sideways);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect({ width: made.width, height: made.height }).toEqual({ width: 400, height: 800 });
    const small = made.files.find((file) => file.size === 'small');
    if (!small) throw new Error('no small file');
    const meta = await sharp(small.body).metadata();
    expect([meta.width, meta.height]).toEqual([400, 800]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('takes PNG and WebP too', async () => {
    for (const format of ['png', 'webp'] as const) {
      const made = await makeShopImages(await photo(300, 300, format).toBuffer());
      expect(made.ok, format).toBe(true);
    }
  });

  it('refuses a side under 200px, after the turn', async () => {
    expect(await makeShopImages(await photo(1000, 199).toBuffer())).toEqual({
      ok: false,
      code: 'storefront_image_too_small',
    });
    const edge = await makeShopImages(await photo(200, 200).toBuffer());
    expect(edge.ok).toBe(true);
  });

  it('refuses more than 40 megapixels from the header, before it decodes', async () => {
    // 8,000 × 5,001 = 40,008,000 pixels: one row over. PNG of one colour, so the file is small
    const big = await photo(8000, 5001, 'png').png({ compressionLevel: 9 }).toBuffer();
    expect(await makeShopImages(big)).toEqual({
      ok: false,
      code: 'storefront_image_too_many_pixels',
    });
  });

  it('refuses what is not a JPEG, PNG or WebP, whatever it was called', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400"/></svg>',
    );
    const gif = await photo(300, 300).gif().toBuffer();
    for (const file of [svg, gif, Buffer.from('%PDF-1.7 not a photo'), Buffer.alloc(0)]) {
      expect(await makeShopImages(file)).toEqual({
        ok: false,
        code: 'storefront_image_unreadable',
      });
    }
  });

  it('refuses a JPEG cut off halfway (the header reads, the pixels do not)', async () => {
    const whole = await photo(1200, 900).jpeg({ quality: 95 }).toBuffer();
    const made = await makeShopImages(whole.subarray(0, Math.floor(whole.length / 2)));
    expect(made).toEqual({ ok: false, code: 'storefront_image_unreadable' });
  });
});
```

The pictures are made by sharp itself, so the test needs no fixture files. It covers the three sizes (the
"wide" one stays 1,600px), a phone photo with EXIF orientation 6 and a copyright note (turned upright, and the
EXIF gone), PNG and WebP, the 199px and 200px edges, one row over 40 MP (a one-colour PNG, small on disk), SVG,
GIF, a PDF and an empty file, and a JPEG cut in half.

### Public photos and a cache header: `storage.service.ts`

```diff
@@ -7,6 +7,7 @@ import {
   HeadObjectCommand,
   NoSuchKey,
   NotFound,
+  PutBucketPolicyCommand,
   PutObjectCommand,
   S3Client,
 } from '@aws-sdk/client-s3';
@@ -23,6 +24,24 @@ export interface SignedUrl {
 
 const HOUR_MS = 60 * 60 * 1000;
 
+// Step 26g: anyone may read storefront/ (the shop's WebP files, which shoppers' browsers load
+// straight from storage), and nothing else: every other file still needs a signed URL. Set by the
+// API in dev and test only, with the bucket; staging's storage-init does it with `mc anonymous`,
+// and production's bucket is set up outside the app (step 25)
+function publicStorefrontPolicy(bucket: string): string {
+  return JSON.stringify({
+    Version: '2012-10-17',
+    Statement: [
+      {
+        Effect: 'Allow',
+        Principal: { AWS: ['*'] },
+        Action: ['s3:GetObject'],
+        Resource: [`arn:aws:s3:::${bucket}/storefront/*`],
+      },
+    ],
+  });
+}
+
 // storage-এর সাথে কথা বলার একমাত্র জায়গা — AWS SDK এর বাইরে কেউ দেখে না। MinIO, R2 আর S3 একই
 // API বলে, তাই dev থেকে production-এ শুধু env বদলায়
 @Injectable()
@@ -67,6 +86,14 @@ export class StorageService implements OnApplicationBootstrap {
         if (!(createError instanceof BucketAlreadyOwnedByYou)) throw createError;
       }
     }
+    // Step 26g: on every start, not only with a new bucket, so a dev bucket made before this step
+    // gets it too. The same policy twice is the same policy
+    await this.client.send(
+      new PutBucketPolicyCommand({
+        Bucket: this.bucket,
+        Policy: publicStorefrontPolicy(this.bucket),
+      }),
+    );
   }
 
   // ব্রাউজার সরাসরি storage-এ PUT করে — ফাইল API সার্ভারের memory বা ব্যান্ডউইথ দিয়ে যায় না।
@@ -117,9 +144,22 @@ export class StorageService implements OnApplicationBootstrap {
 
   // A file the server made itself (a report export from the worker). The same key twice replaces
   // the file, so a job that runs again after a crash writes the same object, not a second one.
-  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
+  // cacheControl (step 26g): what the storage sends with the file. The shop's photos never change
+  // under their address, so a browser or a CDN may keep them for a year
+  async put(
+    key: string,
+    body: Uint8Array,
+    contentType: string,
+    cacheControl?: string,
+  ): Promise<void> {
     await this.client.send(
-      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
+      new PutObjectCommand({
+        Bucket: this.bucket,
+        Key: key,
+        Body: body,
+        ContentType: contentType,
+        CacheControl: cacheControl,
+      }),
     );
   }
 
```

- **`publicStorefrontPolicy()`** allows `s3:GetObject` on `storefront/*` for anyone, and nothing else. A
  shopper's browser loads the photos straight from storage, with no signed URL; every other file (the
  originals, the logos, the reports) still needs one. The check at the end of this part found that an original answers 403.
- **Set on every start** in dev and test, not only when the bucket is new, so a dev bucket made before this
  step gets it too. It runs only where the API may create the bucket (`createBucket`, not production) and only
  when the storage answered: the early `return` for an unreachable storage skips it, as before.
- **`put()`'s `cacheControl`**: the storage sends it back with the file. The job writes
  `public, max-age=31536000, immutable`, because a new photo always gets a new id (26f, decision 5): the
  content under an address never changes, so a browser or a CDN may keep it for a year.

The staging server sets the same rule with MinIO's own command, and lets Cloudflare keep the photos:

```diff
@@ -111,6 +111,8 @@ services:
         mc mb --ignore-existing local/omnivo
         mc admin user add local omnivo-app "$$S3_APP_SECRET"
         mc admin policy attach local readwrite --user omnivo-app || true
+        # Step 26g: the shop's photos (storefront/) may be read without a signed URL, nothing else
+        mc anonymous set download local/omnivo/storefront
 
   mail:
     image: axllent/mailpit:v1.31.2
```

```diff
@@ -72,14 +72,24 @@ http://{$API_HOST} {
 # the Host header as it is, which matters: it is part of the URL's signature.
 http://{$FILES_HOST} {
 	header X-Robots-Tag "noindex, nofollow"
-	# The files are private. Cloudflare keeps .png, .pdf and similar files at its edge by default;
-	# "private" tells it not to, so a file is served only while its signed URL is valid. "defer"
-	# sets it after MinIO answers, so MinIO's own Cache-Control cannot win.
-	header {
-		Cache-Control "private, no-cache"
-		defer
+
+	# Step 26g: the shop's photos, public (storage-init's `mc anonymous`). A photo's address never
+	# gets other content (a new photo gets a new id), so MinIO's own "a year, immutable" (written
+	# by the image job) stands, and Cloudflare may keep them at its edge.
+	handle /omnivo/storefront/* {
+		reverse_proxy storage:9000
+	}
+
+	# Every other file is private. Cloudflare keeps .png, .pdf and similar files at its edge by
+	# default; "private" tells it not to, so a file is served only while its signed URL is valid.
+	# "defer" sets it after MinIO answers, so MinIO's own Cache-Control cannot win.
+	handle {
+		header {
+			Cache-Control "private, no-cache"
+			defer
+		}
+		reverse_proxy storage:9000
 	}
-	reverse_proxy storage:9000
 }
 
 # The online shop: an Astro server that makes each page per request, so Caddy passes every request
```

- **`mc anonymous set download local/omnivo/storefront`** is the same rule as the policy above: anyone may
  read under `storefront/`, nothing else. `storage-init` runs on every deploy and skips what is set.
- **Two `handle` blocks in the Caddyfile.** Before, every file got `Cache-Control: private, no-cache`, which is
  right for the private files: Cloudflare would otherwise keep a `.png` at its edge and serve it after its
  signed URL ran out. The shop's photos are public and never change, so their block leaves MinIO's header
  (the job's "a year, immutable") as it is. `handle` blocks are tried most specific first, so the order in the
  file does not matter.

### The job: `image.handler.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { attachments, storefrontImages } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { PermanentJobError } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StorageService } from '../storage/storage.service.js';
import { makeShopImages, type StorefrontImageFailure } from './image-files.js';
import { shopImageKey } from './media.js';

// A new photo gets a new id, so the file under an address never changes (26f, decision 5)
const IMMUTABLE = 'public, max-age=31536000, immutable';

type Finish =
  | { status: 'ready'; width: number; height: number }
  | { status: 'failed'; failureCode: StorefrontImageFailure };

// Step 26g: an uploaded shop photo becomes the shop's three WebP files (decision 2). The original
// stays in the workspace's private folder; the files go to the public storefront/<id>/ folder.
//
// Idempotent like every handler: it works only on a row that is still processing, and it writes
// the files before it marks the row ready. A run that dies halfway leaves the row processing, so
// the retry makes the same files again (the same keys, so they are replaced, not doubled).
@Injectable()
export class StorefrontImageHandler implements EventHandler<'storefront.image_uploaded'> {
  private readonly logger = new Logger(StorefrontImageHandler.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly storage: StorageService,
  ) {}

  async handle(event: OutboxEvent<'storefront.image_uploaded'>): Promise<void> {
    const { imageId } = event.payload;
    // A short read, then the slow work with no transaction open: decoding a 12 MP photo takes a
    // second or two, and a transaction held that long would hold a pooled connection with it
    const [job] = await this.withTenant((tx) =>
      tx
        .select({ status: storefrontImages.status, storageKey: attachments.storageKey })
        .from(storefrontImages)
        .innerJoin(
          attachments,
          and(
            eq(attachments.tenantId, storefrontImages.tenantId),
            eq(attachments.id, storefrontImages.id),
          ),
        )
        .where(and(eq(storefrontImages.tenantId, getTenantId()), eq(storefrontImages.id, imageId))),
    );
    // Done by an earlier run, or the attachment was deleted (the row went with it): nothing to do
    if (job?.status !== 'processing') return;

    const original = await this.storage.get(job.storageKey);
    // complete() saw the file before it queued this job, so a missing one was deleted since.
    // Trying again cannot bring it back: onGiveUp marks the photo failed
    if (!original) throw new PermanentJobError(`Photo ${imageId} has no original file`);

    const made = await makeShopImages(original);
    if (!made.ok) {
      await this.finish(imageId, { status: 'failed', failureCode: made.code });
      return;
    }
    // The files first: a row marked ready before its files exist would let a listing be
    // published with a photo that is not there yet
    for (const file of made.files) {
      await this.storage.put(shopImageKey(imageId, file.size), file.body, 'image/webp', IMMUTABLE);
    }
    await this.finish(imageId, { status: 'ready', width: made.width, height: made.height });
  }

  // The storage was down for every try, or the original is gone. The screen asks until the photo
  // is ready or failed; without this it would show "Preparing the photo…" for good
  async onGiveUp(event: OutboxEvent<'storefront.image_uploaded'>): Promise<void> {
    this.logger.warn(`Photo ${event.payload.imageId} given up after the last try`);
    await this.finish(event.payload.imageId, {
      status: 'failed',
      failureCode: 'storefront_image_unreadable',
    });
  }

  // Only a row still processing: a second run (or onGiveUp after a run that did finish) never
  // turns a ready photo into a failed one
  private async finish(imageId: string, result: Finish): Promise<void> {
    await this.withTenant((tx) =>
      tx
        .update(storefrontImages)
        .set({ ...result, processedAt: new Date() })
        .where(
          and(
            eq(storefrontImages.tenantId, getTenantId()),
            eq(storefrontImages.id, imageId),
            eq(storefrontImages.status, 'processing'),
          ),
        ),
    );
  }
}
```

- **A short read, then the slow work outside any transaction.** Decoding a 12 MP photo takes a second or two;
  a transaction open that long would hold one of the pool's connections for nothing.
- **`job?.status !== 'processing'`**: a row that is ready or failed was done by an earlier run (a job can run
  twice after a crash), and a missing row means the attachment was deleted (its row went with it, 26g.2's
  cascade). Either way there is nothing to do, and returning is the idempotent answer.
- **A missing original is a `PermanentJobError`.** `complete()` saw the file before it queued the job, so it
  was deleted since. Trying again cannot bring it back; the error skips the retries and goes to `onGiveUp`.
- **A refusal (`made.ok === false`) is a normal finish**, not an error: the photo is fine to mark failed at
  once, and the screen shows why.
- **The files before the row.** If the row were marked ready first, a listing could be saved and published
  with a photo whose files are not there yet. Written in this order, a run that dies between the two leaves
  the row processing, and the retry writes the same three keys again (replaced, not doubled).
- **`onGiveUp`** runs after the last try failed (the storage was down each time, or the original is gone). It
  marks the photo failed, so the screen's "Preparing the photo…" ends with a reason instead of going on for
  good.
- **`finish()` only changes a row still processing.** A late `onGiveUp` after a run that did finish, or two
  runs at once, can never turn a ready photo into a failed one.

```diff
@@ -19,6 +19,7 @@ import { ProvisioningHandler } from '../setup/provisioning.handler.js';
 import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
+import { StorefrontImageHandler } from '../storefront/image.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
 // handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
@@ -48,6 +49,7 @@ export class EventHandlers {
     shiftVariance: ShiftVarianceHandler,
     scheduleRun: ReportScheduleRunHandler,
     scheduleEmail: ReportScheduleEmailHandler,
+    storefrontImage: StorefrontImageHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -67,6 +69,7 @@ export class EventHandlers {
       'pos.shift_variance': shiftVariance,
       'report.schedule_due': scheduleRun,
       'report.schedule_email': scheduleEmail,
+      'storefront.image_uploaded': storefrontImage,
     };
   }
 
```

```diff
@@ -26,6 +26,7 @@ import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
+import { StorefrontImageHandler } from '../storefront/image.handler.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
@@ -88,6 +89,8 @@ export class WorkerModule implements OnApplicationShutdown {
         ReportScheduleSweep,
         ReportScheduleRunHandler,
         ReportScheduleEmailHandler,
+        // Step 26g: a shop photo's WebP files
+        StorefrontImageHandler,
       ],
     };
   }
```

The worker already has `StorageService` (step 11's exports use it), so the handler needs only its own line.

### Reusing the upload: `attachments.service.ts`

```diff
@@ -1,8 +1,14 @@
 import { randomUUID } from 'node:crypto';
 import { Inject, Injectable } from '@nestjs/common';
-import type { Attachment, CreateUploadInput, UploadTicket } from '@omnivo/contracts';
+import {
+  type Attachment,
+  type AttachmentPurpose,
+  type CreateUploadInput,
+  GENERAL_UPLOAD_PURPOSES,
+  type UploadTicket,
+} from '@omnivo/contracts';
 import { attachments } from '@omnivo/db';
-import { and, eq } from 'drizzle-orm';
+import { and, eq, inArray } from 'drizzle-orm';
 
 import { AppError, notFound } from '../common/http/app-error.js';
 import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
@@ -13,7 +19,15 @@ import { StorageService, type SignedUrl } from '../storage/storage.service.js';
 // আপলোডের ঠিকানা ১০ মিনিট চলে — ধীর নেটওয়ার্কে ২ MB-র জন্য যথেষ্ট, আর ফাঁস হলেও বেশিক্ষণ কাজে লাগে না
 const UPLOAD_TTL_SECONDS = 10 * 60;
 
-type AttachmentRow = typeof attachments.$inferSelect;
+export type AttachmentRow = typeof attachments.$inferSelect;
+
+// Step 26g: what a file is, before its upload. The route's own schema has checked it against its
+// purpose's rule (size and type)
+export interface UploadFile {
+  fileName: string;
+  contentType: string;
+  sizeBytes: number;
+}
 
 function toAttachment(row: AttachmentRow): Attachment {
   return {
@@ -40,6 +54,20 @@ export class AttachmentsService {
 
   // ধাপ ১: রো (pending) + সই করা PUT ঠিকানা। ফাইল নিজে কখনো API-তে আসে না
   createUpload(input: CreateUploadInput): Promise<UploadTicket> {
+    const { purpose, ...file } = input;
+    return this.withTenant(async (tx) => {
+      const { row, upload } = await this.startUpload(tx, purpose, file);
+      return { attachment: toAttachment(row), upload };
+    });
+  }
+
+  // Step 26g: the same first step for a purpose with its own routes (a shop photo, with
+  // storefront.manage), inside the caller's transaction
+  async startUpload(
+    tx: Transaction,
+    purpose: AttachmentPurpose,
+    file: UploadFile,
+  ): Promise<{ row: AttachmentRow; upload: UploadTicket['upload'] }> {
     const tenantId = getTenantId();
     const now = new Date();
     // system-design §৩.৭-এর পাথ। টেন্যান্ট দিয়ে শুরু: একটা টেন্যান্টের সব ফাইল এক prefix-এ — export,
@@ -47,59 +75,70 @@ export class AttachmentsService {
     const key = [
       'tenants',
       tenantId,
-      input.purpose,
+      purpose,
       String(now.getUTCFullYear()),
       String(now.getUTCMonth() + 1).padStart(2, '0'),
       randomUUID(),
     ].join('/');
 
-    return this.withTenant(async (tx) => {
-      const [row] = await tx
-        .insert(attachments)
-        .values({ tenantId, ...input, storageKey: key, createdBy: currentPrincipal().userId })
-        .returning();
-      if (!row) throw new Error('Attachment insert returned no row');
-      const upload = await this.storage.uploadUrl(key, input.contentType, UPLOAD_TTL_SECONDS);
-      return {
-        attachment: toAttachment(row),
-        upload: {
-          method: 'PUT',
-          url: upload.url,
-          headers: { 'content-type': input.contentType },
-          expiresAt: upload.expiresAt.toISOString(),
-        },
-      };
-    });
+    const [row] = await tx
+      .insert(attachments)
+      .values({ tenantId, purpose, ...file, storageKey: key, createdBy: currentPrincipal().userId })
+      .returning();
+    if (!row) throw new Error('Attachment insert returned no row');
+    const upload = await this.storage.uploadUrl(key, file.contentType, UPLOAD_TTL_SECONDS);
+    return {
+      row,
+      upload: {
+        method: 'PUT',
+        url: upload.url,
+        headers: { 'content-type': file.contentType },
+        expiresAt: upload.expiresAt.toISOString(),
+      },
+    };
   }
 
   // ধাপ ২: ব্রাউজার বলে "পাঠিয়েছি" — কিন্তু বিশ্বাস না করে storage-কে জিজ্ঞেস করা হয়। presigned PUT
   // আকার বাঁধতে পারে না (S3-এর POST policy পারে, R2 সেটা সমর্থন করে না) — তাই ২ MB ঘোষণা করে ২০০ MB
   // পাঠানো ঠেকানোর জায়গা এটাই: না মিললে ফাইল মুছে 409
   complete(id: string): Promise<Attachment> {
-    return this.withTenant(async (tx) => {
-      const row = await this.find(tx, id, true);
-      if (row.status === 'ready') return toAttachment(row);
-
-      const stored = await this.storage.head(row.storageKey);
-      if (!stored) throw uploadIncomplete();
-      if (stored.sizeBytes !== row.sizeBytes || stored.contentType !== row.contentType) {
-        await this.storage.delete(row.storageKey);
-        throw uploadIncomplete();
-      }
+    return this.withTenant(async (tx) =>
+      toAttachment(await this.confirm(tx, id, GENERAL_UPLOAD_PURPOSES)),
+    );
+  }
 
-      const [ready] = await tx
-        .update(attachments)
-        .set({ status: 'ready', updatedBy: currentPrincipal().userId })
-        .where(eq(attachments.id, id))
-        .returning();
-      if (!ready) throw notFound('Attachment');
-      return toAttachment(ready);
-    });
+  // Step 26g: the check itself, for any purpose, inside the caller's transaction. The row is
+  // locked, so two confirms of one file wait for each other. Only the given purposes: a shop
+  // photo is not confirmed through POST /attachments, and a logo not through the shop's route
+  async confirm(
+    tx: Transaction,
+    id: string,
+    purposes: readonly AttachmentPurpose[],
+  ): Promise<AttachmentRow> {
+    const row = await this.find(tx, id, purposes, true);
+    if (row.status === 'ready') return row;
+
+    const stored = await this.storage.head(row.storageKey);
+    if (!stored) throw uploadIncomplete();
+    if (stored.sizeBytes !== row.sizeBytes || stored.contentType !== row.contentType) {
+      await this.storage.delete(row.storageKey);
+      throw uploadIncomplete();
+    }
+
+    const [ready] = await tx
+      .update(attachments)
+      .set({ status: 'ready', updatedBy: currentPrincipal().userId })
+      .where(eq(attachments.id, id))
+      .returning();
+    if (!ready) throw notFound('Attachment');
+    return ready;
   }
 
+  // The general route's files only. A shop photo's original keeps the phone's EXIF (its GPS
+  // position too); only the image job reads it, and the shop gets the stripped WebP files
   download(id: string): Promise<SignedUrl> {
     return this.withTenant(async (tx) => {
-      const row = await this.find(tx, id, false);
+      const row = await this.find(tx, id, GENERAL_UPLOAD_PURPOSES, false);
       if (row.status !== 'ready') {
         throw new AppError(409, 'attachment_not_ready', 'The file has not finished uploading.');
       }
@@ -107,11 +146,23 @@ export class AttachmentsService {
     });
   }
 
-  private async find(tx: Transaction, id: string, forUpdate: boolean): Promise<AttachmentRow> {
+  // Another purpose's file is "not found", like another workspace's: the route does not know it
+  async find(
+    tx: Transaction,
+    id: string,
+    purposes: readonly AttachmentPurpose[],
+    forUpdate: boolean,
+  ): Promise<AttachmentRow> {
     const query = tx
       .select()
       .from(attachments)
-      .where(and(eq(attachments.tenantId, getTenantId()), eq(attachments.id, id)));
+      .where(
+        and(
+          eq(attachments.tenantId, getTenantId()),
+          eq(attachments.id, id),
+          inArray(attachments.purpose, [...purposes]),
+        ),
+      );
     const [row] = forUpdate ? await query.for('update') : await query;
     if (!row) throw notFound('Attachment');
     return row;
```

```diff
@@ -6,5 +6,7 @@ import { AttachmentsService } from './attachments.service.js';
 @Module({
   controllers: [AttachmentsController],
   providers: [AttachmentsService],
+  // Step 26g: the storefront's photo routes use its upload and its check
+  exports: [AttachmentsService],
 })
 export class AttachmentsModule {}
```

A shop photo goes up exactly like a logo: a `pending` row, a presigned PUT, then a check that the stored file
is what was declared. Rather than copy those steps, the service now has them as methods that take the
caller's transaction:

- **`startUpload(tx, purpose, file)`** makes the row and the signed URL. `createUpload()` is now one call to
  it. The key layout (`tenants/<id>/<purpose>/<year>/<month>/<uuid>`) stays in one place.
- **`confirm(tx, id, purposes)`** is the old `complete()`'s check. It runs inside the caller's transaction,
  so the shop's `complete` can add its job row and its outbox event to the same commit (decision 19).
- **`purposes` in `find()`.** The general routes pass `GENERAL_UPLOAD_PURPOSES`, so they answer 404 for a shop
  photo, the same 404 as another workspace's file: the route does not know it. Without this, someone with
  `core.settings.manage` could confirm a shop photo through `/attachments` (it would never get its job row)
  or download its original, EXIF and GPS position included. The shop's routes pass `['storefront_image']`, so
  they do not take a logo either.
- **`exports`** in the module: the storefront module imports `AttachmentsModule` to get the service.

### A shop's address: `config.ts`, `shop-url.ts`

```diff
@@ -42,6 +42,10 @@ const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
   // which is right for MinIO in dev and on staging. Cloudflare R2 serves public files from another
   // address than its API, so production sets it
   STOREFRONT_MEDIA_URL: z.url().optional(),
+  // Step 26g: the port in a shop's own address, which the Storefront screens link to ("View
+  // shop"). In dev the shop's server has its own port (apps/shop runs on 4321); behind a proxy the
+  // address has none. Left out: 4321 outside production, none in production
+  SHOP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
 });
 
 const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
@@ -114,6 +118,10 @@ export function loadConfig(env: Record<string, string | undefined>) {
     storefront: {
       baseDomain: e.SHOP_BASE_DOMAIN,
       mediaUrl: storefrontMediaUrl(e),
+      // Step 26g: how a shop's address starts and ends (storefront/shop-url.ts). https in
+      // production, where the browser would refuse a shop on plain http anyway
+      shopScheme: e.NODE_ENV === 'production' ? 'https' : 'http',
+      shopPort: e.SHOP_PUBLIC_PORT ?? (e.NODE_ENV === 'production' ? null : 4321),
     },
     auth: {
       betterAuthSecret: e.BETTER_AUTH_SECRET,
```

```diff
@@ -26,6 +26,8 @@ describe('storefront config', () => {
     expect(storefront).toEqual({
       baseDomain: 'localhost',
       mediaUrl: 'http://localhost:9000/omnivo',
+      shopScheme: 'http',
+      shopPort: 4321,
     });
   });
 
@@ -40,9 +42,26 @@ describe('storefront config', () => {
     expect(storefront).toEqual({
       baseDomain: 'omnivo.shop',
       mediaUrl: 'https://media.omnivo.shop',
+      shopScheme: 'https',
+      shopPort: null,
     });
   });
 
+  // Step 26g: the "View shop" link's port. The shop runs on its own port in dev only
+  it('puts the shop port in the address only where one is set or in dev', () => {
+    expect(loadConfig(env({ SHOP_PUBLIC_PORT: '4331' })).storefront.shopPort).toBe(4331);
+    expect(
+      loadConfig(
+        env({
+          NODE_ENV: 'production',
+          STOREFRONT_MEDIA_URL: 'https://media.omnivo.shop',
+          SHOP_PUBLIC_PORT: '8443',
+        }),
+      ).storefront.shopPort,
+    ).toBe(8443);
+    expect(() => loadConfig(env({ SHOP_PUBLIC_PORT: '70000' }))).toThrow(/Invalid environment/);
+  });
+
   // The contract takes http only on this computer, so a production API with an http address would
   // answer every shop page with a broken contract. It refuses to start instead, and says why
   it('refuses to start in production with photos on plain http', () => {
```

```diff
@@ -32,6 +32,9 @@ S3_SECRET_ACCESS_KEY=omnivo-dev-secret
 # left out, it is S3_ENDPOINT/S3_BUCKET (right for MinIO). Production needs an https address
 SHOP_BASE_DOMAIN=localhost
 # STOREFRONT_MEDIA_URL=https://media.omnivo.shop
+# Step 26g: the port in a shop's address for the Storefront screens' "View shop" link. Left out:
+# 4321 (the shop's dev server) outside production, none in production
+# SHOP_PUBLIC_PORT=4321
 # Step 26f.5: the shop's server (apps/shop) reads these two, not the API. Left out, it shows the
 # mock shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
 # pnpm --filter @omnivo/shop dev, then open http://<subdomain>.localhost:4321
```

```ts
import type { Config } from '../config.js';

// Step 26g: a shop's own address, made the way the shop's server reads it (26f.5's middleware
// takes the subdomain off SHOP_BASE_DOMAIN): "nirvor" → https://nirvor.omnivosoft.com in
// production, http://nirvor.localhost:4321 in dev. path starts with "/" ("/p/neem-face-wash")
export function shopUrl(config: Config['storefront'], subdomain: string, path = ''): string {
  const port = config.shopPort === null ? '' : `:${String(config.shopPort)}`;
  return `${config.shopScheme}://${subdomain}.${config.baseDomain}${port}${path}`;
}
```

- **`shopScheme`**: `https` in production, where a browser would refuse a shop on plain http anyway, `http`
  elsewhere.
- **`shopPort`**: in dev the shop's server runs on its own port (`apps/shop` on 4321), so the link needs it;
  behind a proxy (staging, production) it has none. `SHOP_PUBLIC_PORT` overrides both, for a setup that is
  neither. With the default, your `.env` needs no new line.
- **`shopUrl()`** builds the address the way the shop's middleware reads it (26f.5): the subdomain, a dot, the
  base domain. The settings answer it as `shopUrl`, and a listing as its product page (`/p/<slug>`).

### The settings and the launch: `settings.service.ts`

```ts
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontSettingsInput,
  type ShopDeliveryZone,
  type StorefrontReadiness,
  type StorefrontSettings,
  type StorefrontSetup,
  storefrontSubdomainSchema,
  type UpdateStorefrontSettingsInput,
} from '@omnivo/contracts';
import { storefrontSettings, tenants, tenantSettings, warehouses } from '@omnivo/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopUrl } from '../shop-url.js';

type SettingsRow = typeof storefrontSettings.$inferSelect;
type SettingsInput = CreateStorefrontSettingsInput;

function subdomainTaken(): AppError {
  return new AppError(409, 'storefront_subdomain_taken', 'Another shop has this address.', {
    fieldErrors: { subdomain: ['storefront_subdomain_taken'] },
  });
}

function warehouseInvalid(): AppError {
  return new AppError(409, 'storefront_warehouse_invalid', 'Pick an active warehouse.', {
    fieldErrors: { defaultWarehouseId: ['storefront_warehouse_invalid'] },
  });
}

export function notSetUp(): AppError {
  return new AppError(409, 'storefront_not_set_up', 'Save the shop settings first.');
}

// A new zone's id: what a shopper's cart keeps (decision 13). Random, not made from the name: a
// Bangla name has no Latin letter, and two zones renamed into each other's names must not swap
// carts. 8 hex characters in a list of six never collide in practice; the loop makes sure
function zoneIds(input: SettingsInput['deliveryZones'], before: readonly ShopDeliveryZone[]) {
  const saved = new Set(before.map((zone) => zone.id));
  const used = new Set<string>();
  return input.map((zone): ShopDeliveryZone => {
    // A saved zone keeps its id. An id the shop never had (a stale form, a hand-made request) is
    // a new zone, and an id sent twice is kept once: two radio cards with one value would be one
    let id = zone.id !== null && saved.has(zone.id) && !used.has(zone.id) ? zone.id : null;
    while (id === null || used.has(id)) id = `zone-${randomBytes(4).toString('hex')}`;
    used.add(id);
    // 4 decimals, as Postgres keeps every other amount, so the quote compares like with like
    return { id, name: zone.name, charge: addMoney(zone.charge, '0') };
  });
}

// What the table keeps, from the form. The name in NFC (26f, decision 34): the shop's search folds
// to NFC, so a Bangla word typed in its other form would miss
function columnsOf(input: SettingsInput, before: readonly ShopDeliveryZone[]) {
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
    freeDeliveryFrom: input.freeDeliveryFrom,
    minimumOrder: input.minimumOrder,
    paymentMethods: input.paymentMethods,
  };
}

// The audit's view of the settings: plain values only (AuditValue), so the lists become text.
// Each amount as Postgres writes it, so "1000" and "1000.0000" are not a change
function snapshot(row: SettingsRow) {
  const money = (value: string | null) => (value === null ? null : addMoney(value, '0'));
  return {
    subdomain: row.subdomain,
    name: row.name,
    language: row.language,
    hotline: row.hotline,
    address: row.address,
    facebookUrl: row.facebookUrl,
    instagramUrl: row.instagramUrl,
    xUrl: row.xUrl,
    linkedinUrl: row.linkedinUrl,
    defaultWarehouseId: row.defaultWarehouseId,
    deliveryZones: row.deliveryZones
      .map((zone) => `${zone.name} ${addMoney(zone.charge, '0')}`)
      .join(', '),
    freeDeliveryFrom: money(row.freeDeliveryFrom),
    minimumOrder: money(row.minimumOrder),
    paymentMethods: row.paymentMethods.join(', '),
  };
}

// Step 26g: the shop's settings and its launch (decision 1). One row per workspace: the first
// save makes it (POST), later saves change it (PUT, with the version), and "Open the shop" sets
// launched_at once. Nothing here closes a shop again (step 26e: a shop is always open).
@Injectable()
export class StorefrontSettingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  setup(): Promise<StorefrontSetup> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, false);
      const [company] = await tx
        .select({
          slug: tenants.slug,
          name: tenants.name,
          phone: tenantSettings.phone,
          address: tenantSettings.address,
        })
        .from(tenants)
        .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
        .where(eq(tenants.id, getTenantId()));
      // Decision 18: the workspace's slug when it can be a subdomain at all. Whether another
      // shop has it is a question about other workspaces, which this transaction cannot see
      // (RLS); the first save answers it (storefront_subdomain_taken). Workspace slugs are
      // unique, and shops start from them, so a clash is rare
      const slug = company?.slug ?? '';
      return {
        baseDomain: this.config.storefront.baseDomain,
        shop: row === null ? null : await this.toSettings(tx, row),
        suggested: {
          subdomain: storefrontSubdomainSchema.safeParse(slug).success ? slug : '',
          name: company?.name ?? '',
          hotline: company?.phone ?? '',
          address: company?.address ?? '',
        },
      };
    });
  }

  async create(input: CreateStorefrontSettingsInput): Promise<StorefrontSettings> {
    try {
      return await this.withTenant(async (tx) => {
        await this.checkWarehouse(tx, input.defaultWarehouseId);
        const [row] = await tx
          .insert(storefrontSettings)
          .values({
            tenantId: getTenantId(),
            ...columnsOf(input, []),
            updatedBy: currentPrincipal().userId,
          })
          // A second first save (two tabs, a double click): the row is there already. Not an
          // upsert: that would overwrite the other tab's save without its version
          .onConflictDoNothing({ target: storefrontSettings.tenantId })
          .returning();
        if (!row) {
          throw new AppError(409, 'storefront_set_up_already', 'The shop is set up already.');
        }
        await audit(tx, {
          action: 'storefront.created',
          entityType: 'storefront',
          entityId: row.tenantId,
          changes: created(snapshot(row)),
        });
        return this.toSettings(tx, row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_settings_subdomain_idx')) throw subdomainTaken();
      throw error;
    }
  }

  async update(input: UpdateStorefrontSettingsInput): Promise<StorefrontSettings> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.find(tx, true);
        if (before === null) throw notSetUp();
        if (before.version !== input.version) throw versionConflict();
        // A launched shop counts its stock somewhere and delivers somewhere (the table's
        // storefront_settings_launch_check); said on the boxes, not as a database error
        if (before.launchedAt !== null) {
          if (input.defaultWarehouseId === null) throw warehouseInvalid();
          if (input.deliveryZones.length === 0) {
            throw new AppError(409, 'too_short', 'An open shop needs a delivery zone.', {
              fieldErrors: { deliveryZones: ['too_short'] },
            });
          }
        }
        // Only a new warehouse is checked: the saved one may have been archived since, and the
        // shop keeps counting there until someone picks another
        if (input.defaultWarehouseId !== before.defaultWarehouseId) {
          await this.checkWarehouse(tx, input.defaultWarehouseId);
        }
        const [after] = await tx
          .update(storefrontSettings)
          .set({
            ...columnsOf(input, before.deliveryZones),
            version: sql`${storefrontSettings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(eq(storefrontSettings.tenantId, getTenantId()))
          .returning();
        if (!after) throw notSetUp();
        await audit(tx, {
          action: 'storefront.updated',
          entityType: 'storefront',
          entityId: after.tenantId,
          changes: diff(snapshot(before), snapshot(after)),
        });
        return this.toSettings(tx, after);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_settings_subdomain_idx')) throw subdomainTaken();
      throw error;
    }
  }

  launch(version: number): Promise<StorefrontSettings> {
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, true);
      if (before === null) throw notSetUp();
      if (before.version !== version) throw versionConflict();
      // A second click, or two tabs: open already, which is what both wanted
      if (before.launchedAt !== null) return this.toSettings(tx, before);
      const readiness = await this.readiness(tx, before);
      if (!readiness.warehouse || !readiness.zone || !readiness.listing) {
        throw new AppError(
          409,
          'storefront_launch_not_ready',
          'The shop needs a warehouse, a delivery zone and a published listing first.',
        );
      }
      const [after] = await tx
        .update(storefrontSettings)
        .set({
          launchedAt: new Date(),
          version: sql`${storefrontSettings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(storefrontSettings.tenantId, getTenantId()))
        .returning();
      if (!after) throw notSetUp();
      await audit(tx, {
        action: 'storefront.launched',
        entityType: 'storefront',
        entityId: after.tenantId,
        changes: diff({ launched: false }, { launched: true }),
      });
      return this.toSettings(tx, after);
    });
  }

  // The shop's row; null before the first save. Also what the catalog reads for its warehouse
  // and the listings' shop addresses
  async find(tx: Transaction, forUpdate: boolean): Promise<SettingsRow | null> {
    const query = tx
      .select()
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }

  // null is allowed before the launch ("Pick a warehouse"); otherwise an active warehouse of
  // this workspace. The FK checks the workspace too, but its error would name no box
  private async checkWarehouse(tx: Transaction, warehouseId: string | null): Promise<void> {
    if (warehouseId === null) return;
    const [found] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          eq(warehouses.id, warehouseId),
          isNull(warehouses.archivedAt),
        ),
      );
    if (!found) throw warehouseInvalid();
  }

  // The launch checklist. The warehouse must still be active (one archived since the save would
  // show every listing out of stock), and "a published listing" is one the shop would show: its
  // product and variant not archived
  private async readiness(tx: Transaction, row: SettingsRow): Promise<StorefrontReadiness> {
    const tenantId = getTenantId();
    const [warehouse] =
      row.defaultWarehouseId === null
        ? []
        : await tx
            .select({ id: warehouses.id })
            .from(warehouses)
            .where(
              and(
                eq(warehouses.tenantId, tenantId),
                eq(warehouses.id, row.defaultWarehouseId),
                isNull(warehouses.archivedAt),
              ),
            );
    const listing = await tx.execute(sql`
      SELECT 1 FROM storefront_listings l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
       WHERE l.tenant_id = ${tenantId}::uuid AND l.published_at IS NOT NULL
         AND v.archived_at IS NULL AND p.archived_at IS NULL
       LIMIT 1`);
    return {
      warehouse: warehouse !== undefined,
      zone: row.deliveryZones.length > 0,
      listing: listing.length > 0,
    };
  }

  private async toSettings(tx: Transaction, row: SettingsRow): Promise<StorefrontSettings> {
    return {
      subdomain: row.subdomain,
      shopUrl: shopUrl(this.config.storefront, row.subdomain),
      name: row.name,
      language: row.language,
      hotline: row.hotline,
      address: row.address,
      facebookUrl: row.facebookUrl,
      instagramUrl: row.instagramUrl,
      xUrl: row.xUrl,
      linkedinUrl: row.linkedinUrl,
      defaultWarehouseId: row.defaultWarehouseId,
      deliveryZones: row.deliveryZones,
      freeDeliveryFrom: row.freeDeliveryFrom,
      minimumOrder: row.minimumOrder,
      paymentMethods: row.paymentMethods,
      launchedAt: row.launchedAt?.toISOString() ?? null,
      readiness: await this.readiness(tx, row),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
```

- **`zoneIds()`** keeps a saved zone's id and names a new one (decision 13 of 26g.1, decision 29 here). An
  id the shop never had (a stale form, a hand-made request) is treated as new, and an id sent twice is kept
  once: two radio cards with the same value would be one card at checkout. The charge is written with 4
  decimals (`addMoney(charge, '0')`), like every amount Postgres keeps, so the quote compares like with like.
- **`columnsOf()`** turns the form into the table's columns in one place, for both the first save and the
  later ones. The shop's name is saved in NFC (26f, decision 34): the shop's search folds to NFC, and a Bangla
  word typed in its other form would not match.
- **`snapshot()`** is the audit's view: plain values only (`AuditValue` has no arrays), so the zones and the
  payment methods become text. Amounts go through `addMoney` too, so saving `1000` over `1000.0000` is not
  logged as a change.
- **`setup()`** answers the page's first read. The suggested subdomain is the slug only when the subdomain
  schema accepts it (a slug like `ab` is too short to be one), and `''` otherwise (decision 18).
- **`create()` uses `onConflictDoNothing` on `tenant_id`**, not an upsert. A second "first save" (two tabs, a
  double click) finds the row there already and is refused with `storefront_set_up_already`. An upsert would
  quietly overwrite the other tab's save without a version check.
- **A subdomain taken by another workspace** is found by the unique index (RLS hides other workspaces' rows
  but not a unique violation) and turned into `storefront_subdomain_taken` on the box.
- **`update()` on a launched shop** refuses an empty warehouse or no zone with an error on the box, before the
  table's `storefront_settings_launch_check` would refuse it as a database error with no box to show it on.
  The subdomain may change (decision 3); the screen warns that old links stop working.
- **Only a new warehouse is checked** (`input.defaultWarehouseId !== before.defaultWarehouseId`). The saved
  one may have been archived since; refusing every save until someone picks another would block a change of
  the hotline for no reason. The readiness list shows the problem instead.
- **`launch()`**: already open is a success, not an error, because a second click and a second tab both
  wanted the shop open. The checklist is worked out again inside the locked transaction, so the shop cannot
  open on a list that changed a moment ago. There is no way back (step 26e: a shop is always open).
- **`readiness()`** (decision 27): the warehouse must still be active, and the listing must be one the shop
  would show (its product and variant not archived), so the first shopper does not land on an empty shop.
- **`find()` and `notSetUp()` are exported** for the listings, which need the shop's warehouse and subdomain.

### The categories: `categories.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateStorefrontCategoryInput,
  StorefrontCategory,
  UpdateStorefrontCategoryInput,
} from '@omnivo/contracts';
import { storefrontCategories, storefrontListings } from '@omnivo/db';
import { and, asc, count, eq, isNull, max, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';

type CategoryRow = typeof storefrontCategories.$inferSelect;

function toCategory(row: CategoryRow, listingCount: number): StorefrontCategory {
  return {
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    name: row.name,
    position: row.position,
    listingCount,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function slugTaken(): AppError {
  return new AppError(409, 'storefront_slug_taken', 'Another one in the shop has this link.', {
    fieldErrors: { slug: ['storefront_slug_taken'] },
  });
}

function nameTaken(): AppError {
  return new AppError(409, 'category_name_taken', 'This place already has a category so named.', {
    fieldErrors: { name: ['category_name_taken'] },
  });
}

function parentInvalid(): AppError {
  return new AppError(409, 'category_parent_invalid', 'Pick a category from the list.', {
    fieldErrors: { parentId: ['category_parent_invalid'] },
  });
}

// The two unique indexes, by the box each belongs to
function uniqueError(error: unknown): AppError | null {
  if (isUniqueViolation(error, 'storefront_categories_slug_idx')) return slugTaken();
  if (isUniqueViolation(error, 'storefront_categories_sibling_name_idx')) return nameTaken();
  return null;
}

// The product categories' lock (product-categories.service.ts), for the same races: two moves at
// once, a new category under one being deleted, and two new categories taking one position. The
// tree is tens of rows that change rarely, so one tenant's changes waiting for each other costs
// nothing
async function lockTree(tx: Transaction): Promise<void> {
  const key = `storefront_categories:${getTenantId()}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The siblings' order, as the shop lists them: position, then name (26f), then the id so two rows
// never tie
const ORDER = [
  asc(storefrontCategories.position),
  asc(storefrontCategories.name),
  asc(storefrontCategories.id),
] as const;

function underParent(parentId: string | null) {
  return parentId === null
    ? isNull(storefrontCategories.parentId)
    : eq(storefrontCategories.parentId, parentId);
}

// Step 26g: the shop's own categories (26f: not the product categories). A tree, like the
// product categories, plus a link (the slug) and an order the tenant sets with Move up / down.
@Injectable()
export class StorefrontCategoriesService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(): Promise<StorefrontCategory[]> {
    return this.withTenant((tx) => this.all(tx));
  }

  async create(input: CreateStorefrontCategoryInput): Promise<StorefrontCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockTree(tx);
        const parent = input.parentId === null ? null : await this.find(tx, input.parentId);
        if (input.parentId !== null && !parent) throw parentInvalid();
        const [row] = await tx
          .insert(storefrontCategories)
          .values({
            tenantId: getTenantId(),
            parentId: input.parentId,
            slug: input.slug,
            // NFC, like every name the shop searches (26f, decision 34)
            name: input.name.normalize('NFC'),
            position: await this.endOf(tx, input.parentId),
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Category insert returned no row');
        await audit(tx, {
          action: 'storefront_category.created',
          entityType: 'storefront_category',
          entityId: row.id,
          changes: created({ name: row.name, slug: row.slug, parent: parent?.name ?? null }),
        });
        return toCategory(row, 0);
      });
    } catch (error) {
      throw uniqueError(error) ?? error;
    }
  }

  async update(id: string, input: UpdateStorefrontCategoryInput): Promise<StorefrontCategory> {
    try {
      return await this.withTenant(async (tx) => {
        await lockTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== input.version) throw versionConflict();
        const moved = input.parentId !== before.parentId;
        const parentBefore = before.parentId === null ? null : await this.find(tx, before.parentId);
        const parentAfter = moved ? await this.moveTarget(tx, id, input.parentId) : parentBefore;
        const [after] = await tx
          .update(storefrontCategories)
          .set({
            parentId: input.parentId,
            slug: input.slug,
            name: input.name.normalize('NFC'),
            // A new parent: the end of its list, with everything under it coming along (the
            // children point at this row, not at a place)
            ...(moved && { position: await this.endOf(tx, input.parentId) }),
            version: sql`${storefrontCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
          )
          .returning();
        if (!after) throw notFound('Category');
        await audit(tx, {
          action: 'storefront_category.updated',
          entityType: 'storefront_category',
          entityId: id,
          changes: diff(
            { name: before.name, slug: before.slug, parent: parentBefore?.name ?? null },
            { name: after.name, slug: after.slug, parent: parentAfter?.name ?? null },
          ),
        });
        return toCategory(after, await this.listingCount(tx, id));
      });
    } catch (error) {
      throw uniqueError(error) ?? error;
    }
  }

  // Decision 15: a swap with the sibling above or below, answered with the whole list (two rows
  // changed, and the tree shows them all). The siblings are numbered 1, 2, 3… in their order first:
  // positions may tie (a new category's 0 from 26f's tests, a row made by hand), and swapping two
  // equal numbers would change nothing
  move(id: string, direction: 'up' | 'down', version: number): Promise<StorefrontCategory[]> {
    return this.withTenant(async (tx) => {
      await lockTree(tx);
      const category = await this.find(tx, id, true);
      if (!category) throw notFound('Category');
      if (category.version !== version) throw versionConflict();
      const siblings = await tx
        .select()
        .from(storefrontCategories)
        .where(
          and(eq(storefrontCategories.tenantId, getTenantId()), underParent(category.parentId)),
        )
        .orderBy(...ORDER);
      const from = siblings.findIndex((row) => row.id === id);
      const to = direction === 'up' ? from - 1 : from + 1;
      const neighbour = siblings[to];
      // Already first or last: the button is disabled there, and a second click is a no-op
      if (neighbour === undefined) return this.all(tx);

      const order = siblings.map((row) => row.id);
      order[from] = neighbour.id;
      order[to] = id;
      // Only the rows whose number changes are written, each with its version: a position is
      // part of the row, and a form open on a moved row should know it changed
      for (const [index, rowId] of order.entries()) {
        const row = siblings.find((sibling) => sibling.id === rowId);
        if (row === undefined || row.position === index + 1) continue;
        await tx
          .update(storefrontCategories)
          .set({
            position: index + 1,
            version: sql`${storefrontCategories.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(
              eq(storefrontCategories.tenantId, getTenantId()),
              eq(storefrontCategories.id, rowId),
            ),
          );
      }
      await audit(tx, {
        action: 'storefront_category.moved',
        entityType: 'storefront_category',
        entityId: id,
        changes: diff({ position: from + 1 }, { position: to + 1 }),
      });
      return this.all(tx);
    });
  }

  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        await lockTree(tx);
        const before = await this.find(tx, id, true);
        if (!before) throw notFound('Category');
        if (before.version !== version) throw versionConflict();
        await tx
          .delete(storefrontCategories)
          .where(
            and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
          );
        await audit(tx, {
          action: 'storefront_category.deleted',
          entityType: 'storefront_category',
          entityId: id,
          changes: diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
        });
      });
    } catch (error) {
      // The foreign keys are the checks (26f: no ON DELETE on either)
      if (isForeignKeyViolation(error, 'storefront_categories_parent_fk')) {
        throw new AppError(
          409,
          'category_has_children',
          'Move or delete the sub-categories first.',
        );
      }
      if (isForeignKeyViolation(error, 'storefront_listings_category_fk')) {
        throw new AppError(
          409,
          'storefront_category_in_use',
          'Move its listings to another category first.',
        );
      }
      throw error;
    }
  }

  // A category of this workspace, for a listing's category box
  async exists(tx: Transaction, id: string): Promise<boolean> {
    return (await this.find(tx, id)) !== null;
  }

  private async all(tx: Transaction): Promise<StorefrontCategory[]> {
    const tenantId = getTenantId();
    const counts = tx
      .select({ categoryId: storefrontListings.categoryId, total: count().as('total') })
      .from(storefrontListings)
      .where(eq(storefrontListings.tenantId, tenantId))
      .groupBy(storefrontListings.categoryId)
      .as('counts');
    const rows = await tx
      .select({
        category: storefrontCategories,
        // coalesce: a category with no listings has no row in `counts`
        total: sql<number>`coalesce(${counts.total}, 0)`.mapWith(Number),
      })
      .from(storefrontCategories)
      .leftJoin(counts, eq(counts.categoryId, storefrontCategories.id))
      .where(eq(storefrontCategories.tenantId, tenantId))
      .orderBy(...ORDER);
    return rows.map((row) => toCategory(row.category, row.total));
  }

  private async listingCount(tx: Transaction, id: string): Promise<number> {
    const [counted] = await tx
      .select({ total: count() })
      .from(storefrontListings)
      .where(
        and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.categoryId, id)),
      );
    return counted?.total ?? 0;
  }

  // After the last sibling. smallint: tens of categories, never 32,767
  private async endOf(tx: Transaction, parentId: string | null): Promise<number> {
    const [last] = await tx
      .select({ position: max(storefrontCategories.position) })
      .from(storefrontCategories)
      .where(and(eq(storefrontCategories.tenantId, getTenantId()), underParent(parentId)));
    return (last?.position ?? 0) + 1;
  }

  // The new parent, after checking the move does not put the category under itself (the tree
  // lock keeps any other move from being half done while this walks up)
  private async moveTarget(
    tx: Transaction,
    id: string,
    parentId: string | null,
  ): Promise<CategoryRow | null> {
    if (parentId === null) return null;
    const parent = await this.find(tx, parentId);
    if (!parent) throw parentInvalid();
    const loop = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM storefront_categories
         WHERE tenant_id = ${getTenantId()}::uuid AND id = ${parentId}::uuid
        UNION ALL
        SELECT c.id, c.parent_id FROM storefront_categories c
          JOIN up ON c.id = up.parent_id
         WHERE c.tenant_id = ${getTenantId()}::uuid
      )
      SELECT 1 FROM up WHERE id = ${id}::uuid LIMIT 1`);
    if (loop.length > 0) {
      throw new AppError(409, 'category_parent_loop', 'A category cannot go under itself.', {
        fieldErrors: { parentId: ['category_parent_loop'] },
      });
    }
    return parent;
  }

  private async find(tx: Transaction, id: string, forUpdate = false): Promise<CategoryRow | null> {
    const query = tx
      .select()
      .from(storefrontCategories)
      .where(
        and(eq(storefrontCategories.tenantId, getTenantId()), eq(storefrontCategories.id, id)),
      );
    const [row] = forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }
}
```

It follows the product categories' service (step 12), with a slug and an order added.

- **`lockTree()`**: the same advisory lock as the product categories, per workspace. It covers two moves at
  once, a new category under one being deleted, and two new categories taking one position at the end.
- **`ORDER`** is the shop's own order (position, then name, 26f), plus the id, so two rows never tie and the
  admin list and the shop always agree.
- **`endOf()`**: a new category, or one moved to a new parent, goes last in that list. Its children come along,
  because they point at the row, not at a place.
- **`move()` numbers the siblings 1, 2, 3… before it swaps** (decision 26). Positions may tie: 26f's tests and
  rows made by hand use 0, and swapping two zeros would change nothing on screen. Only the rows whose number
  changed are written, each with a new version: the position is part of the row, and a form open on a moved
  row should know it changed. Already first or last is a no-op that answers the list, because the button is
  disabled there and a second quick click is not an error.
- **`remove()` lets the foreign keys check.** `storefront_categories_parent_fk` means sub-categories, and
  `storefront_listings_category_fk` means listings (26f: no `ON DELETE` on either). A check before the delete
  would race with a listing added at the same moment; the key cannot.
- **`exists()`** is for the listings' category box.

### The photos: `images.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateStorefrontUploadInput,
  StorefrontImage,
  StorefrontImageView,
  StorefrontUpload,
  StorefrontUploadTicket,
} from '@omnivo/contracts';
import { attachments, storefrontImages } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AttachmentsService } from '../../attachments/attachments.service.js';
import { emit } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { shopImage } from '../media.js';

const PHOTO = ['storefront_image'] as const;

type ImageRow = typeof storefrontImages.$inferSelect;

// Step 26g: the shop's photos (decisions 2 and 8). The file goes up like any attachment, with a
// presigned PUT to the workspace's private folder; confirming it starts the image job. A photo's
// id is its attachment's id from then on: the job's row, the WebP files and the listings all use it.
@Injectable()
export class StorefrontImagesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly attachments: AttachmentsService,
  ) {}

  createUpload(input: CreateStorefrontUploadInput): Promise<StorefrontUploadTicket> {
    return this.withTenant(async (tx) => {
      const { row, upload } = await this.attachments.startUpload(tx, 'storefront_image', input);
      return { image: { id: row.id, status: 'uploading' }, upload };
    });
  }

  // The attachment's check (the file is there, its size and type are what was said), then, in
  // the same transaction, the job's row and its outbox event: all three commit or none do. A
  // second confirm (a retry after a lost answer) finds the row and starts nothing
  complete(id: string): Promise<StorefrontUpload> {
    return this.withTenant(async (tx) => {
      await this.attachments.confirm(tx, id, PHOTO);
      const [row] = await tx
        .insert(storefrontImages)
        .values({ id, tenantId: getTenantId() })
        .onConflictDoNothing({ target: storefrontImages.id })
        .returning();
      if (row) await emit(tx, 'storefront.image_uploaded', { imageId: id });
      return this.statusOf(id, row ?? (await this.jobRow(tx, id)));
    });
  }

  get(id: string): Promise<StorefrontUpload> {
    return this.withTenant(async (tx) => {
      // 404 for anything that is not this workspace's shop photo (another purpose included)
      await this.attachments.find(tx, id, PHOTO, false);
      return this.statusOf(id, await this.jobRow(tx, id));
    });
  }

  // The ids among these that a listing may save: this workspace's shop photos whose files are
  // made. Everything else (another workspace's id, a logo, a photo still processing or failed) is
  // missing from the answer, and the save says storefront_image_not_ready on that photo
  async readyIds(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: storefrontImages.id })
      .from(storefrontImages)
      .innerJoin(
        attachments,
        and(
          eq(attachments.tenantId, storefrontImages.tenantId),
          eq(attachments.id, storefrontImages.id),
        ),
      )
      .where(
        and(
          eq(storefrontImages.tenantId, getTenantId()),
          inArray(storefrontImages.id, [...ids]),
          eq(storefrontImages.status, 'ready'),
          eq(attachments.purpose, 'storefront_image'),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  // A saved photo as the editor shows it: the small file, for the thumbnail
  view(image: StorefrontImage): StorefrontImageView {
    return { ...image, url: shopImage(this.config.storefront.mediaUrl, image, 'small').url };
  }

  private async jobRow(tx: Transaction, id: string): Promise<ImageRow | undefined> {
    const [row] = await tx
      .select()
      .from(storefrontImages)
      .where(and(eq(storefrontImages.tenantId, getTenantId()), eq(storefrontImages.id, id)));
    return row;
  }

  // The table's states into the screen's union (26g.2's table). The table's check makes each
  // state carry its own fields; the guards below are for the type checker, and a row that broke
  // them would be a bug worth an error, not a photo shown half
  private statusOf(id: string, row: ImageRow | undefined): StorefrontUpload {
    if (row === undefined) return { id, status: 'uploading' };
    switch (row.status) {
      case 'processing':
        return { id, status: 'processing' };
      case 'ready':
        if (row.width === null || row.height === null) {
          throw new Error(`Photo ${id} is ready without a size`);
        }
        return {
          id,
          status: 'ready',
          url: shopImage(this.config.storefront.mediaUrl, { id, alt: '' }, 'small').url,
          width: row.width,
          height: row.height,
        };
      case 'failed':
        if (row.failureCode === null) throw new Error(`Photo ${id} failed without a code`);
        return { id, status: 'failed', code: row.failureCode };
    }
  }
}
```

- **`createUpload()`** is the attachments' first step with the `storefront_image` purpose. The contract has
  already checked the size (8 MB) and the type.
- **`complete()`** does three things in one transaction: the attachment's check (`confirm`), the job's row
  (`processing`), and the outbox event. All three commit or none does, so "confirmed but no job" cannot happen.
  `onConflictDoNothing` makes a second confirm (a retry after a lost answer) start nothing: no new row means no
  new event, and the answer is the row as it is.
- **`get()`** checks the attachment first, so another workspace's id, a logo's id and a made-up id are all the
  same 404.
- **`readyIds()`** is what a listing's save asks: which of these ids are this workspace's shop photos with
  their files made. It joins `attachments` for the purpose, because the table's FK cannot check it (26g.2).
- **`statusOf()`** turns a row into the screen's union. No row is "uploading" (26g.2's table of states). The
  table's check gives each state its own fields, so the two `throw`s cannot happen; they are there for the
  type checker, and a row that broke them would be a bug worth an error rather than a photo shown half.

### The listings: `listings.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontListingInput,
  type ErrorCode,
  listingPricing,
  SHOP_BADGES,
  slugFromName,
  STOREFRONT_LISTING_SORTS,
  STOREFRONT_SALE_KINDS,
  STOREFRONT_SLUG_MAX,
  type StorefrontCandidate,
  type StorefrontListing,
  type StorefrontListingSort,
  type StorefrontListingSummary,
  type StorefrontSale,
  storefrontCandidateQuerySchema,
  storefrontImagesSchema,
  storefrontListingQuerySchema,
  storefrontSectionsSchema,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { storefrontListings } from '@omnivo/db';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import { containsPattern } from '../../common/db/search.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';
import { shopUrl } from '../shop-url.js';
import { slugTaken, StorefrontCategoriesService } from './categories.service.js';
import { StorefrontImagesService } from './images.service.js';
import { notSetUp, StorefrontSettingsService } from './settings.service.js';

// One listing as the catalog and the editor read it, straight from SQL: the listing, its
// category's name, the product and variant it sells, and whether the shop's warehouse has it.
// Checked like any answer from the database (listing-sql.ts does the same for the shop)
const rowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pack_size: z.string(),
  category_id: z.uuid(),
  category_name: z.string(),
  price_override: z.string().nullable(),
  sale_kind: z.enum(STOREFRONT_SALE_KINDS).nullable(),
  sale_value: z.string().nullable(),
  sale_starts_at: z.iso.datetime().nullable(),
  sale_ends_at: z.iso.datetime().nullable(),
  badges: z.array(z.enum(SHOP_BADGES)),
  images: storefrontImagesSchema,
  description_sections: storefrontSectionsSchema,
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  published_at: z.iso.datetime().nullable(),
  updated_at: z.iso.datetime(),
  version: z.number().int(),
  product_id: z.uuid(),
  product_name: z.string(),
  archived: z.boolean(),
  variant_id: z.uuid(),
  sku: z.string(),
  option_values: z.array(z.string()),
  sale_price: z.string().nullable(),
  // null while the shop has no warehouse
  in_stock: z.boolean().nullable(),
  // The sort's key as Postgres wrote it, for the next cursor (see ORDERS)
  sort_key: z.string(),
});
type Row = z.infer<typeof rowSchema>;

// Each sort's key. A Record: a sort added to STOREFRONT_LISTING_SORTS without a line here does
// not compile. "-updated" uses the microseconds (isoText), so two listings saved in one
// millisecond are not skipped by a cursor. The name sorts use the first 60 characters, as the
// shop's "Name: A to Z" does (26f, decision 30): the key goes into a cursor of at most 512
// characters. Ties go by id, so the order is total and a cursor is exact
const ORDERS: Record<StorefrontListingSort, { key: SQL; text: SQL; desc: boolean; cast: SQL }> = {
  '-updated': {
    key: sql`l.updated_at`,
    text: isoText(sql`l.updated_at`),
    desc: true,
    cast: sql`timestamptz`,
  },
  name: {
    key: sql`left(lower(l.name), 60)`,
    text: sql`left(lower(l.name), 60)`,
    desc: false,
    cast: sql`text`,
  },
  '-name': {
    key: sql`left(lower(l.name), 60)`,
    text: sql`left(lower(l.name), 60)`,
    desc: true,
    cast: sql`text`,
  },
};

// A cursor is [sort, key, id]; the sort is in it, so a cursor from one order sent with another is
// refused instead of landing in the middle of a different list
const cursorSchema = z.tuple([z.enum(STOREFRONT_LISTING_SORTS), z.string().max(300), z.uuid()]);

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

// The SQL every read starts from. `sort` picks the key column; `where` and `rest` finish it
function listingsSql(
  warehouseId: string | null,
  sort: StorefrontListingSort,
  where: SQL,
  rest: SQL,
) {
  // The shop's rule for "in stock" (26f, decision 27): more than nothing in its warehouse, summed
  // over the batches
  const inStock =
    warehouseId === null
      ? sql`NULL::boolean`
      : sql`(SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
              WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
                AND b.warehouse_id = ${warehouseId}::uuid) > 0`;
  return sql`
    SELECT l.id::text, l.slug, l.name, l.pack_size, l.category_id::text, c.name AS category_name,
           l.price_override::text, l.sale_kind, l.sale_value::text,
           ${isoText(sql`l.sale_starts_at`)} AS sale_starts_at,
           ${isoText(sql`l.sale_ends_at`)} AS sale_ends_at,
           l.badges, l.images, l.description_sections, l.seo_title, l.seo_description,
           ${isoText(sql`l.published_at`)} AS published_at,
           ${isoText(sql`l.updated_at`)} AS updated_at, l.version,
           p.id::text AS product_id, p.name AS product_name,
           (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived,
           v.id::text AS variant_id, v.sku, v.option_values, v.sale_price::text,
           ${inStock} AS in_stock, ${ORDERS[sort].text} AS sort_key
      FROM storefront_listings l
      JOIN storefront_categories c ON c.tenant_id = l.tenant_id AND c.id = l.category_id
      JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
     WHERE l.tenant_id = ${getTenantId()}::uuid AND ${where}
     ${rest}`;
}

// The sale as the tenant typed it, back into the form's shape. A percent comes as "10.0000"
// (numeric(19,4)); the form's box takes a whole number, so it goes back as "10"
function saleOf(row: Row): StorefrontSale | null {
  if (row.sale_kind === null || row.sale_value === null) return null;
  const dates = { startsAt: row.sale_starts_at, endsAt: row.sale_ends_at };
  return row.sale_kind === 'percent'
    ? { kind: 'percent', value: String(Number(row.sale_value)), ...dates }
    : { kind: row.sale_kind, value: row.sale_value, ...dates };
}

// The variant's options in words ("150ml · Neem"); '' for a product with one variant
function optionsText(values: readonly string[]): string {
  return values.join(' · ');
}

// A sale's start or end for the table: the form sends an ISO time with any offset, or null
function dateOrNull(value: string | null | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(value);
}

// What a shopper pays: the listing's own price, else the variant's (26f, decision 2)
function regularOf(priceOverride: string | null, salePrice: string | null): string | null {
  return priceOverride ?? salePrice;
}

// A refusal that belongs to one box of the form
function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

// The audit's view of a listing: plain values only. The sale and the photos as short text, so a
// change shows as "10% → 15%" and "2 photos → 3 photos" in the log
function snapshot(row: {
  name: string;
  slug: string;
  packSize: string;
  categoryId: string;
  priceOverride: string | null;
  sale: StorefrontSale | null;
  badges: readonly string[];
  imageIds: readonly string[];
  sections: number;
  seoTitle: string | null;
  seoDescription: string | null;
}) {
  const sale = row.sale;
  return {
    name: row.name,
    slug: row.slug,
    packSize: row.packSize,
    categoryId: row.categoryId,
    // Like the table: "229" and "229.0000" are one price (addMoney writes 4 decimals)
    priceOverride: row.priceOverride === null ? null : addMoney(row.priceOverride, '0'),
    sale:
      sale === null
        ? null
        : [
            sale.kind,
            sale.kind === 'percent' ? sale.value : addMoney(sale.value, '0'),
            sale.startsAt === null ? '-' : new Date(sale.startsAt).toISOString(),
            sale.endsAt === null ? '-' : new Date(sale.endsAt).toISOString(),
          ].join(' '),
    badges: row.badges.join(', '),
    images: row.imageIds.join(', '),
    sections: row.sections,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
  };
}

function snapshotOf(row: Row) {
  return snapshot({
    name: row.name,
    slug: row.slug,
    packSize: row.pack_size,
    categoryId: row.category_id,
    priceOverride: row.price_override,
    sale: saleOf(row),
    badges: row.badges,
    imageIds: row.images.map((image) => image.id),
    sections: row.description_sections.length,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
  });
}

// Step 26g: the shop's listings (decision 16): a variant put in the shop as a draft ("Add to
// shop"), edited as one form, then published. A listing never changes the product: the ERP keeps
// the stock item, and the listing adds what only a shop needs.
@Injectable()
export class StorefrontListingsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    private readonly settings: StorefrontSettingsService,
    private readonly categories: StorefrontCategoriesService,
    private readonly images: StorefrontImagesService,
  ) {}

  // The query as the route parsed it (z.output: the defaults filled in)
  list(q: z.output<typeof storefrontListingQuerySchema>): Promise<{
    items: StorefrontListingSummary[];
    nextCursor: string | null;
  }> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      const order = ORDERS[q.sort];
      const filters: SQL[] = [sql`true`];
      if (q.search !== undefined && q.search !== '') {
        const pattern = containsPattern(q.search.normalize('NFC'));
        filters.push(
          sql`(lower(l.name) LIKE ${pattern} OR l.slug LIKE ${pattern} OR lower(v.sku) LIKE ${pattern})`,
        );
      }
      if (q.status === 'published') filters.push(sql`l.published_at IS NOT NULL`);
      if (q.status === 'draft') filters.push(sql`l.published_at IS NULL`);
      if (q.categoryId !== undefined) filters.push(sql`l.category_id = ${q.categoryId}::uuid`);

      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [sort, key, id] = cursor;
        if (sort !== q.sort) throw invalidCursor();
        // The key goes into SQL with a cast; a bad one would be Postgres's cast error, a 500
        if (q.sort === '-updated' && Number.isNaN(Date.parse(key))) throw invalidCursor();
        const op = order.desc ? sql`<` : sql`>`;
        filters.push(sql`(${order.key}, l.id) ${op} (${key}::${order.cast}, ${id}::uuid)`);
      }
      const direction = order.desc ? sql`DESC` : sql`ASC`;
      const rows = await this.select(
        tx,
        shop?.defaultWarehouseId ?? null,
        q.sort,
        sql.join(filters, sql` AND `),
        sql`ORDER BY ${order.key} ${direction}, l.id ${direction} LIMIT ${q.limit + 1}`,
      );
      const page = toPage(rows, q.limit, (last) => [q.sort, last.sort_key, last.id]);
      return { items: page.items.map((row) => this.toSummary(row)), nextCursor: page.nextCursor };
    });
  }

  // Decision 14: "Add to shop"'s search. Active goods (a service has no stock to sell online),
  // not listed yet, by name or SKU, A to Z. Its own cursor: [name key, variant id]
  candidates(
    q: z.output<typeof storefrontCandidateQuerySchema>,
  ): Promise<{ items: StorefrontCandidate[]; nextCursor: string | null }> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const filters: SQL[] = [
        sql`v.tenant_id = ${tenantId}::uuid`,
        sql`p.type = 'goods'`,
        sql`p.archived_at IS NULL AND v.archived_at IS NULL`,
        sql`NOT EXISTS (SELECT 1 FROM storefront_listings l
                         WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id)`,
      ];
      if (q.search !== undefined && q.search !== '') {
        const pattern = containsPattern(q.search.normalize('NFC'));
        filters.push(sql`(lower(p.name) LIKE ${pattern} OR lower(v.sku) LIKE ${pattern})`);
      }
      const cursor = decodeCursor(q.cursor, z.tuple([z.string().max(300), z.uuid()]));
      if (cursor !== undefined) {
        filters.push(sql`(left(lower(p.name), 60), v.id) > (${cursor[0]}, ${cursor[1]}::uuid)`);
      }
      const rows = z
        .array(
          z.object({
            variant_id: z.uuid(),
            product_id: z.uuid(),
            product_name: z.string(),
            option_values: z.array(z.string()),
            sku: z.string(),
            sale_price: z.string().nullable(),
            sort_key: z.string(),
          }),
        )
        .parse(
          await tx.execute(sql`
            SELECT v.id::text AS variant_id, p.id::text AS product_id, p.name AS product_name,
                   v.option_values, v.sku, v.sale_price::text, left(lower(p.name), 60) AS sort_key
              FROM product_variants v
              JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
             WHERE ${sql.join(filters, sql` AND `)}
             ORDER BY left(lower(p.name), 60), v.id
             LIMIT ${q.limit + 1}`),
        );
      const page = toPage(rows, q.limit, (last) => [last.sort_key, last.variant_id]);
      return {
        items: page.items.map((row) => ({
          variantId: row.variant_id,
          productId: row.product_id,
          name: [row.product_name, optionsText(row.option_values)].filter(Boolean).join(' · '),
          sku: row.sku,
          salePrice: row.sale_price,
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  async create(input: CreateStorefrontListingInput): Promise<StorefrontListing> {
    try {
      return await this.withTenant(async (tx) => {
        const shop = await this.settings.find(tx, false);
        if (shop === null) throw notSetUp();
        const variant = await this.variant(tx, input.variantId);
        if (!(await this.categories.exists(tx, input.categoryId))) {
          throw fieldError('storefront_category_invalid', 'categoryId', 'Pick a category.');
        }
        // The product's name and the variant's options, in NFC (26f, decision 34)
        const name = [variant.productName, optionsText(variant.optionValues)]
          .filter(Boolean)
          .join(' · ')
          .normalize('NFC');
        const [row] = await tx
          .insert(storefrontListings)
          .values({
            tenantId: getTenantId(),
            productId: variant.productId,
            variantId: variant.id,
            categoryId: input.categoryId,
            slug: await this.freeSlug(tx, name, variant.sku),
            name,
            updatedBy: currentPrincipal().userId,
          })
          .returning({ id: storefrontListings.id });
        if (!row) throw new Error('Listing insert returned no row');
        const listing = await this.load(tx, row.id, shop.defaultWarehouseId);
        await audit(tx, {
          action: 'storefront_listing.created',
          entityType: 'storefront_listing',
          entityId: row.id,
          changes: created({ ...snapshotOf(listing), variant: variant.sku }),
        });
        return this.toListing(listing, shop.subdomain);
      });
    } catch (error) {
      // Two "Add to shop" clicks for one variant: the second one finds the first's row
      if (isUniqueViolation(error, 'storefront_listings_variant_idx')) {
        throw fieldError('storefront_variant_listed', 'variantId', 'It is in the shop already.');
      }
      throw error;
    }
  }

  get(id: string): Promise<StorefrontListing> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      if (shop === null) throw notSetUp();
      return this.toListing(await this.load(tx, id, shop.defaultWarehouseId), shop.subdomain);
    });
  }

  async update(id: string, input: UpdateStorefrontListingInput): Promise<StorefrontListing> {
    try {
      return await this.withTenant(async (tx) => {
        const shop = await this.settings.find(tx, false);
        if (shop === null) throw notSetUp();
        const before = await this.load(tx, id, shop.defaultWarehouseId, true);
        if (before.version !== input.version) throw versionConflict();
        if (input.categoryId !== before.category_id) {
          if (!(await this.categories.exists(tx, input.categoryId))) {
            throw fieldError('storefront_category_invalid', 'categoryId', 'Pick a category.');
          }
        }
        await this.checkImages(tx, input.images, before);
        const published = before.published_at !== null;
        // A published listing stays one the shop can show: a photo (the table's
        // storefront_listings_published_check) and a price (the shop leaves a listing without
        // one out, so it would vanish without a word)
        if (published && input.images.length === 0) {
          throw fieldError('storefront_listing_needs_photo', 'images', 'Keep one photo.');
        }
        const regular = regularOf(input.priceOverride, before.sale_price);
        if (published && regular === null) {
          throw fieldError('storefront_listing_no_price', 'priceOverride', 'Type a price.');
        }
        this.checkSale(input.sale, regular);

        await tx
          .update(storefrontListings)
          .set({
            name: input.name.normalize('NFC'),
            slug: input.slug,
            packSize: input.packSize,
            categoryId: input.categoryId,
            priceOverride: input.priceOverride,
            saleKind: input.sale?.kind ?? null,
            saleValue: input.sale?.value ?? null,
            saleStartsAt: dateOrNull(input.sale?.startsAt),
            saleEndsAt: dateOrNull(input.sale?.endsAt),
            badges: input.badges,
            images: input.images,
            descriptionSections: input.descriptionSections,
            seoTitle: input.seoTitle,
            seoDescription: input.seoDescription,
            version: sql`${storefrontListings.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(
            and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)),
          );
        const after = await this.load(tx, id, shop.defaultWarehouseId);
        await audit(tx, {
          action: 'storefront_listing.updated',
          entityType: 'storefront_listing',
          entityId: id,
          changes: diff(snapshotOf(before), snapshotOf(after)),
        });
        return this.toListing(after, shop.subdomain);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'storefront_listings_slug_idx')) throw slugTaken();
      throw error;
    }
  }

  publish(id: string, version: number): Promise<StorefrontListing> {
    return this.setPublished(id, version, true);
  }

  unpublish(id: string, version: number): Promise<StorefrontListing> {
    return this.setPublished(id, version, false);
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.load(tx, id, null, true);
      if (before.version !== version) throw versionConflict();
      // Its collection rows go with it (their FK cascades, 26f); the product stays in the ERP
      await tx
        .delete(storefrontListings)
        .where(and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)));
      await audit(tx, {
        action: 'storefront_listing.deleted',
        entityType: 'storefront_listing',
        entityId: id,
        changes: diff({ name: before.name, slug: before.slug }, { name: null, slug: null }),
      });
    });
  }

  private setPublished(id: string, version: number, on: boolean): Promise<StorefrontListing> {
    return this.withTenant(async (tx) => {
      const shop = await this.settings.find(tx, false);
      if (shop === null) throw notSetUp();
      const before = await this.load(tx, id, shop.defaultWarehouseId, true);
      if (before.version !== version) throw versionConflict();
      // Already so (a second click, two tabs): what both wanted
      if ((before.published_at !== null) === on) return this.toListing(before, shop.subdomain);
      if (on) {
        if (before.archived) {
          throw new AppError(
            409,
            'storefront_variant_archived',
            'The product or its variant is archived in the ERP.',
          );
        }
        if (before.images.length === 0) {
          throw new AppError(409, 'storefront_listing_needs_photo', 'Add a photo first.');
        }
        if (regularOf(before.price_override, before.sale_price) === null) {
          throw new AppError(409, 'storefront_listing_no_price', 'Give it a price first.');
        }
      }
      await tx
        .update(storefrontListings)
        .set({
          // The "Newest" sort's time: a listing published again goes back to the top
          publishedAt: on ? new Date() : null,
          version: sql`${storefrontListings.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontListings.tenantId, getTenantId()), eq(storefrontListings.id, id)));
      await audit(tx, {
        action: on ? 'storefront_listing.published' : 'storefront_listing.unpublished',
        entityType: 'storefront_listing',
        entityId: id,
        changes: diff({ published: !on }, { published: on }),
      });
      return this.toListing(await this.load(tx, id, shop.defaultWarehouseId), shop.subdomain);
    });
  }

  // Every photo is this workspace's, ready, and (for a new one) made by the job. The photos the
  // listing has already are not asked again: they were ready when saved, and their files never
  // change. One error per photo that is not, on its own box
  private async checkImages(
    tx: Transaction,
    images: UpdateStorefrontListingInput['images'],
    before: Row,
  ): Promise<void> {
    const saved = new Set(before.images.map((image) => image.id));
    const asked = images.filter((image) => !saved.has(image.id)).map((image) => image.id);
    const ready = await this.images.readyIds(tx, asked);
    const fieldErrors: Record<string, ErrorCode[]> = {};
    images.forEach((image, index) => {
      if (!saved.has(image.id) && !ready.has(image.id)) {
        fieldErrors[`images.${String(index)}`] = ['storefront_image_not_ready'];
      }
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError(409, 'storefront_image_not_ready', 'A photo is not ready yet.', {
        fieldErrors,
      });
    }
  }

  // A sale must take something off and leave something to pay, at the price it is for. Its dates
  // do not matter here: a sale that starts next week must already be lower. listingPricing() is
  // the shop's own rule (26f), so the form's preview, this check and the shop agree
  private checkSale(sale: StorefrontSale | null, regular: string | null): void {
    if (sale === null) return;
    if (regular === null) {
      throw fieldError('storefront_listing_no_price', 'priceOverride', 'Type a price first.');
    }
    const priced = listingPricing(regular, { ...sale, startsAt: null, endsAt: null }, new Date());
    if (priced.compareAtPrice === null) {
      throw fieldError('storefront_sale_not_lower', 'sale.value', 'Take less off the price.');
    }
  }

  // A variant that may go into the shop: this workspace's, goods, not archived
  private async variant(tx: Transaction, variantId: string) {
    const [variant] = z
      .array(
        z.object({
          id: z.uuid(),
          product_id: z.uuid(),
          product_name: z.string(),
          option_values: z.array(z.string()),
          sku: z.string(),
          type: z.string(),
          archived: z.boolean(),
        }),
      )
      .parse(
        await tx.execute(sql`
          SELECT v.id::text, p.id::text AS product_id, p.name AS product_name, v.option_values,
                 v.sku, p.type, (p.archived_at IS NOT NULL OR v.archived_at IS NOT NULL) AS archived
            FROM product_variants v
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
           WHERE v.tenant_id = ${getTenantId()}::uuid AND v.id = ${variantId}::uuid`),
      );
    // Another workspace's variant is "not found" like a made-up one, and so is a service
    if (variant?.type !== 'goods') {
      throw fieldError('required', 'variantId', 'Pick a product.');
    }
    if (variant.archived) {
      throw fieldError('storefront_variant_archived', 'variantId', 'The product is archived.');
    }
    return {
      id: variant.id,
      productId: variant.product_id,
      productName: variant.product_name,
      optionValues: variant.option_values,
      sku: variant.sku,
    };
  }

  // Decision 16: a slug made from the name, or from the SKU when the name has no Latin letter
  // (a Bangla name), else "listing"; then the first of slug, slug-2, slug-3… nobody has. Cut so
  // the number still fits in 100 characters. The unique index has the last word: a race between
  // two adds is a storefront_slug_taken the person can fix in the editor
  private async freeSlug(tx: Transaction, name: string, sku: string): Promise<string> {
    const base = slugFromName(name) || slugFromName(sku) || 'listing';
    const rows = z.array(z.object({ slug: z.string() })).parse(
      await tx.execute(sql`
          SELECT slug FROM storefront_listings
           WHERE tenant_id = ${getTenantId()}::uuid
             AND (slug = ${base} OR slug LIKE ${`${base.slice(0, STOREFRONT_SLUG_MAX - 5)}-%`})`),
    );
    const taken = new Set(rows.map((row) => row.slug));
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : `-${String(n)}`;
      const slug = `${base.slice(0, STOREFRONT_SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (!taken.has(slug)) return slug;
    }
  }

  private async select(
    tx: Transaction,
    warehouseId: string | null,
    sort: StorefrontListingSort,
    where: SQL,
    rest: SQL,
  ): Promise<Row[]> {
    return z.array(rowSchema).parse(await tx.execute(listingsSql(warehouseId, sort, where, rest)));
  }

  private async load(
    tx: Transaction,
    id: string,
    warehouseId: string | null,
    forUpdate = false,
  ): Promise<Row> {
    const [row] = await this.select(
      tx,
      warehouseId,
      '-updated',
      sql`l.id = ${id}::uuid`,
      forUpdate ? sql`FOR UPDATE OF l` : sql``,
    );
    if (!row) throw notFound('Listing');
    return row;
  }

  private toSummary(row: Row): StorefrontListingSummary {
    const [first] = row.images;
    const regular = regularOf(row.price_override, row.sale_price);
    const priced = regular === null ? null : listingPricing(regular, saleOf(row), new Date());
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      packSize: row.pack_size,
      sku: row.sku,
      categoryId: row.category_id,
      categoryName: row.category_name,
      image: first === undefined ? null : this.images.view(first),
      price: priced?.price ?? null,
      compareAtPrice: priced?.compareAtPrice ?? null,
      inStock: row.in_stock,
      status: row.published_at === null ? 'draft' : 'published',
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
    };
  }

  private toListing(row: Row, subdomain: string): StorefrontListing {
    return {
      id: row.id,
      product: {
        id: row.product_id,
        name: row.product_name,
        // The stock item as one: archived when its product or this variant is
        status: row.archived ? 'archived' : 'active',
      },
      variant: {
        id: row.variant_id,
        sku: row.sku,
        name: optionsText(row.option_values),
        salePrice: row.sale_price,
      },
      categoryId: row.category_id,
      slug: row.slug,
      name: row.name,
      packSize: row.pack_size,
      priceOverride: row.price_override,
      sale: saleOf(row),
      badges: row.badges,
      images: row.images.map((image) => this.images.view(image)),
      descriptionSections: row.description_sections,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      inStock: row.in_stock,
      status: row.published_at === null ? 'draft' : 'published',
      publishedAt: row.published_at,
      shopUrl: shopUrl(this.config.storefront, subdomain, `/p/${row.slug}`),
      version: row.version,
      updatedAt: row.updated_at,
    };
  }
}
```

```diff
@@ -79,7 +79,7 @@ function shownListings(shop: ShopScope): SQL {
 // Raw queries leave timestamps as Postgres's own text, which is not ISO (products.service.ts has
 // the same helper). Microseconds, not milliseconds: published_at is a cursor key, and a key cut to
 // the millisecond would skip a listing published in the same millisecond as the last card
-function isoText(column: SQL): SQL {
+export function isoText(column: SQL): SQL {
   return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
 }
 
```

- **One SQL for every read** (`listingsSql`), checked with `rowSchema` like 26f's listing SQL: the catalog page,
  the editor, the reads after a save. `isoText` (now exported from 26f's file) writes the times with
  microseconds: `updated_at` is a cursor key, and a key cut to the millisecond would skip a listing saved in the
  same millisecond as the last one on the page.
- **`in_stock`** is the shop's own rule (26f, decision 27), and `NULL` while the shop has no warehouse, so the
  catalog can say "no warehouse" instead of "out of stock".
- **`ORDERS`** is a `Record` over the sorts, so a sort added to the contract without its line does not compile.
  The name sorts use the first 60 characters of `lower(name)`, like the shop's (26f, decision 30): the key goes
  into the cursor, and a cursor is at most 512 characters. The cursor carries its sort, and a cursor from
  another sort is refused instead of landing in the middle of a different list. A `-updated` key that is not a
  time is refused before it reaches `::timestamptz`, which would be a 500.
- **`saleOf()` gives the sale back in the form's shape.** Postgres sends a percent as `10.0000`; the form's
  box (and the contract's `salePercentSchema`) takes `10`. The editor can then send the answer back as the next
  save without touching it, which the check below does.
- **`snapshot()`** uses `addMoney` for amounts, never `Number()`: money is never a JavaScript number
  (CLAUDE.md), even in the audit log.
- **`candidates()`** (decision 23): active goods, not listed yet, by name or SKU, A to Z, with their own cursor.
- **`create()`** makes a draft named after the product and the variant's options ("Neem Face Wash · 150ml"),
  in NFC. Two "Add to shop" clicks for one variant meet at the unique index, and the second gets
  `storefront_variant_listed` on the box.
- **`freeSlug()`** (decision 24) reads the slugs that could clash in one query and takes the first free one. It
  cuts the base so the number still fits in 100 characters. The unique index has the last word: if two adds
  race for one slug, the loser gets `storefront_slug_taken` and fixes it in the editor.
- **`update()`** checks in this order: the version, the category (only if it changed), the photos, then what a
  published listing must keep, then the sale. Each refusal names its box.
- **`checkImages()`** asks only about new photos. The ones the listing has already were ready when they were
  saved, and their files never change; asking again would refuse a save if a photo's row were ever cleaned
  up. One error per photo that is not ready, at `images.<n>`, so the form marks the right one.
- **`checkSale()`** (decision 25) uses `listingPricing()`, the shop's own rule, with the dates taken out: a sale
  that starts next week must already be lower. If `compareAtPrice` is `null`, the sale takes nothing off, or
  everything, so it is refused on `sale.value`. The form's preview runs the same function first.
- **`setPublished()`**: already so is a success (two tabs). Publishing needs an active stock item, a photo and
  a price; unpublishing needs nothing. A listing published again gets a new `published_at`, so it goes back to
  the top of "Newest", which is what a tenant who puts something back on sale expects.
- **`remove()`**: the collection rows go with it (their FK cascades, 26f). The product stays in the ERP.
- **`load()`** takes `FOR UPDATE OF l`: only the listing's row is locked, not the product, the variant or the
  category it joins, which other screens may be saving at the same time.

### The routes: `storefront-admin.controller.ts`, `storefront.module.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontCategoriesService } from './categories.service.js';
import { StorefrontImagesService } from './images.service.js';
import { StorefrontListingsService } from './listings.service.js';
import { StorefrontSettingsService } from './settings.service.js';

type Routes = typeof routes.storefront;

// Step 26g: the Storefront menu's 20 routes, all behind storefront.manage (the contract says so;
// the guard reads it). Thin on purpose: each one hands its parsed input to a service
@Controller()
export class StorefrontAdminController {
  constructor(
    private readonly settings: StorefrontSettingsService,
    private readonly categories: StorefrontCategoriesService,
    private readonly images: StorefrontImagesService,
    private readonly listings: StorefrontListingsService,
  ) {}

  @Endpoint(routes.storefront.getSettings)
  getSettings(): Promise<RouteResponse<Routes['getSettings']>> {
    return this.settings.setup();
  }

  @Endpoint(routes.storefront.createSettings)
  createSettings({
    body,
  }: RouteInput<Routes['createSettings']>): Promise<RouteResponse<Routes['createSettings']>> {
    return this.settings.create(body);
  }

  @Endpoint(routes.storefront.updateSettings)
  updateSettings({
    body,
  }: RouteInput<Routes['updateSettings']>): Promise<RouteResponse<Routes['updateSettings']>> {
    return this.settings.update(body);
  }

  @Endpoint(routes.storefront.launch)
  launch({ body }: RouteInput<Routes['launch']>): Promise<RouteResponse<Routes['launch']>> {
    return this.settings.launch(body.version);
  }

  @Endpoint(routes.storefront.listCategories)
  async listCategories(): Promise<RouteResponse<Routes['listCategories']>> {
    return { items: await this.categories.list() };
  }

  @Endpoint(routes.storefront.createCategory)
  createCategory({
    body,
  }: RouteInput<Routes['createCategory']>): Promise<RouteResponse<Routes['createCategory']>> {
    return this.categories.create(body);
  }

  @Endpoint(routes.storefront.updateCategory)
  updateCategory({
    params,
    body,
  }: RouteInput<Routes['updateCategory']>): Promise<RouteResponse<Routes['updateCategory']>> {
    return this.categories.update(params.id, body);
  }

  @Endpoint(routes.storefront.moveCategory)
  async moveCategory({
    params,
    body,
  }: RouteInput<Routes['moveCategory']>): Promise<RouteResponse<Routes['moveCategory']>> {
    return { items: await this.categories.move(params.id, body.direction, body.version) };
  }

  @Endpoint(routes.storefront.deleteCategory)
  deleteCategory({ params, query }: RouteInput<Routes['deleteCategory']>): Promise<void> {
    return this.categories.remove(params.id, query.version);
  }

  @Endpoint(routes.storefront.createUpload)
  createUpload({
    body,
  }: RouteInput<Routes['createUpload']>): Promise<RouteResponse<Routes['createUpload']>> {
    return this.images.createUpload(body);
  }

  @Endpoint(routes.storefront.completeUpload)
  completeUpload({
    params,
  }: RouteInput<Routes['completeUpload']>): Promise<RouteResponse<Routes['completeUpload']>> {
    return this.images.complete(params.id);
  }

  @Endpoint(routes.storefront.getUpload)
  getUpload({
    params,
  }: RouteInput<Routes['getUpload']>): Promise<RouteResponse<Routes['getUpload']>> {
    return this.images.get(params.id);
  }

  @Endpoint(routes.storefront.listListings)
  listListings({
    query,
  }: RouteInput<Routes['listListings']>): Promise<RouteResponse<Routes['listListings']>> {
    return this.listings.list(query);
  }

  @Endpoint(routes.storefront.listCandidates)
  listCandidates({
    query,
  }: RouteInput<Routes['listCandidates']>): Promise<RouteResponse<Routes['listCandidates']>> {
    return this.listings.candidates(query);
  }

  @Endpoint(routes.storefront.createListing)
  createListing({
    body,
  }: RouteInput<Routes['createListing']>): Promise<RouteResponse<Routes['createListing']>> {
    return this.listings.create(body);
  }

  @Endpoint(routes.storefront.getListing)
  getListing({
    params,
  }: RouteInput<Routes['getListing']>): Promise<RouteResponse<Routes['getListing']>> {
    return this.listings.get(params.id);
  }

  @Endpoint(routes.storefront.updateListing)
  updateListing({
    params,
    body,
  }: RouteInput<Routes['updateListing']>): Promise<RouteResponse<Routes['updateListing']>> {
    return this.listings.update(params.id, body);
  }

  @Endpoint(routes.storefront.publishListing)
  publishListing({
    params,
    body,
  }: RouteInput<Routes['publishListing']>): Promise<RouteResponse<Routes['publishListing']>> {
    return this.listings.publish(params.id, body.version);
  }

  @Endpoint(routes.storefront.unpublishListing)
  unpublishListing({
    params,
    body,
  }: RouteInput<Routes['unpublishListing']>): Promise<RouteResponse<Routes['unpublishListing']>> {
    return this.listings.unpublish(params.id, body.version);
  }

  @Endpoint(routes.storefront.deleteListing)
  deleteListing({ params, query }: RouteInput<Routes['deleteListing']>): Promise<void> {
    return this.listings.remove(params.id, query.version);
  }
}
```

```diff
@@ -1,13 +1,29 @@
 import { Module } from '@nestjs/common';
 
+import { AttachmentsModule } from '../attachments/attachments.module.js';
+import { StorefrontCategoriesService } from './admin/categories.service.js';
+import { StorefrontImagesService } from './admin/images.service.js';
+import { StorefrontListingsService } from './admin/listings.service.js';
+import { StorefrontSettingsService } from './admin/settings.service.js';
+import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
 import { ShopDb } from './shop-db.js';
 
-// Step 26f: the online shop's side of the API. Today only the public reads (/public/v1); step 26g
-// adds the ERP's Storefront screens' routes here, behind storefront.manage
+// Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
+// ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
+// tables and the photo addresses (media.ts), never a service: the public half runs as
+// omnivo_public in a read-only transaction, the admin half as the signed-in member
 @Module({
-  controllers: [PublicStorefrontController],
-  providers: [ShopDb, PublicStorefrontService],
+  imports: [AttachmentsModule],
+  controllers: [PublicStorefrontController, StorefrontAdminController],
+  providers: [
+    ShopDb,
+    PublicStorefrontService,
+    StorefrontSettingsService,
+    StorefrontCategoriesService,
+    StorefrontImagesService,
+    StorefrontListingsService,
+  ],
 })
 export class StorefrontModule {}
```

The controller is thin: `@Endpoint` takes the method, the path, the status and the permission from the
contract, and the guard checks `storefront.manage`. The admin half and the public half are in one module
because they share the tables and `media.ts`, but never a service: the public half runs as `omnivo_public` in a
read-only transaction, the admin half as the signed-in member.

Then write the OpenAPI file again:

```bash
pnpm gen:openapi
```

### The role templates: `templates.ts`

```diff
@@ -190,6 +190,11 @@ const STOCK_REPORTS = ['inventory.report.read'] as const;
 // their own role may read.
 const SCHEDULING_REPORTS = ['core.report.schedule'] as const;
 
+// Step 26g: running the online shop (its settings, categories and listings). For the people who
+// run a shop, the retail shop manager and the general manager; the distributors and makers sell
+// to businesses, and their owner can give it to a role when they open a shop
+const RUNNING_THE_SHOP = ['storefront.manage'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -756,6 +761,7 @@ export const INDUSTRY_TEMPLATES = {
           ...PURCHASE_REPORTS,
           ...STOCK_REPORTS,
           ...SCHEDULING_REPORTS,
+          ...RUNNING_THE_SHOP,
         ],
       },
       {
@@ -834,6 +840,7 @@ export const INDUSTRY_TEMPLATES = {
           ...PURCHASE_REPORTS,
           ...STOCK_REPORTS,
           ...SCHEDULING_REPORTS,
+          ...RUNNING_THE_SHOP,
         ],
       },
     ],
```

New workspaces get the permission on the roles that run a shop (decision 28). Distributors and makers sell to
businesses; their owner can add it to a role when they open a shop. The templates apply only when a workspace
is set up, so existing workspaces keep their roles.

### The contract's comment: `storefront-admin.ts`

```diff
@@ -226,6 +226,7 @@ export const storefrontReadinessSchema = z.object({
   zone: z.boolean(),
   listing: z.boolean(),
 });
+export type StorefrontReadiness = z.infer<typeof storefrontReadinessSchema>;
 
 export const storefrontSettingsSchema = z.object({
   subdomain: z.string(),
@@ -254,8 +255,9 @@ export const storefrontSettingsSchema = z.object({
 export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;
 
 // The settings page's one read. Before the first save there is no shop (`shop: null`), and the
-// form starts from `suggested`: the workspace's slug as the subdomain when it is free, and the
-// company's name, phone and address from the workspace settings. baseDomain lets the form show the
+// form starts from `suggested`: the workspace's slug as the subdomain when it can be one ('' when
+// not; whether another shop has it, the first save says), and the company's name, phone and
+// address from the workspace settings. baseDomain lets the form show the
 // whole address while the subdomain is typed ("nirvor" → "nirvor.omnivosoft.com")
 export const storefrontSetupSchema = z.object({
   baseDomain: z.string(),
```

`StorefrontReadiness` is the settings service's return type, inferred from the schema. The comment on
`suggested` now says what the API does (decision 18).

### Check this part

```bash
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/api exec tsc --noEmit
pnpm --filter @omnivo/api test                 # unit tests, image-files.spec.ts and config.spec.ts among them
pnpm exec eslint apps/api/src packages/contracts/src packages/db/src
pnpm exec prettier --check apps/api/src packages/contracts/src packages/db/src
pnpm test:openapi
```

`contract.spec.ts` and `pnpm test:openapi` pass again with this part. The guide was also checked with one run
against real Postgres, Redis and MinIO containers and the real worker: the settings (first save, a second first
save, zones keeping their ids, the launch refused and then done), the categories (slugs, Move up, a slug
taken, a loop refused, a delete refused while listings use it), "Add to shop" twice, a photo uploaded with a
presigned PUT and turned upright by the job (1600 × 1200 with EXIF orientation 6 became 1200 × 1600, its small
file 480 × 640 WebP with the "a year, immutable" header, read without a signed URL), the original refused
without one (403) and through `/attachments` (404), a broken photo marked failed, a sale that took too much
refused, a photo that is not ready refused, the editor's answer sent back unchanged as the next save, publish,
the shop's public API showing the listing, the three sorts with their cursors, and the audit rows. The full
integration tests are 26g.4's.

## 26g.4 — The API's tests

This part tests 26g.3 against a real Postgres, Redis and MinIO, with the real worker running the image job. It
adds no feature and changes no API code: every test passed against 26g.3 as it is.

```
apps/api/src
  testing/
    shop-photo.ts    a shop photo the way the editor sends one (new)
    storefront.ts    26f's SQL helper: a new comment, and createProduct takes a SKU
  storefront/
    storefront-admin.int.spec.ts          the Storefront menu, from the first save to an open shop (new)
    storefront-admin.tenant-leak.int.spec.ts   two workspaces: no id of one works in the other (new)
```

Decisions for this part:

30. **26f's tests keep their SQL helper** (the user's choice). They test how the public API reads a shop, so
    they still write the rows as the superuser. Made through the admin API, each of their listings would need
    a real photo, so the storage and the image job, in a suite that tests none of that. 26g's own tests test
    the writing side through the API.
31. **One integration file that builds one shop in order**, like a person setting up the shop for the first
    time: settings, categories, photos, listings, the launch. Each `describe` uses what the one before it made,
    so a test never sets up a shop in a way the screens could not.
32. **The tenant-leak file uses real photos.** Another workspace's photo must be ready when Nirvor tries to use
    it, or the test would pass for the wrong reason ("not ready" because it is still processing). So the leak
    suite starts MinIO and the worker too, unlike 26f's leak suite.
33. **A refused id answers like a made-up one.** The leak tests check the exact answer (status, code and field
    errors), not only "not 200": a different code for "exists, but not yours" would tell a stranger that the
    id exists.

### A photo for a test: `shop-photo.ts`

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type StorefrontUpload,
  storefrontUploadSchema,
  storefrontUploadTicketSchema,
} from '@omnivo/contracts';
import sharp from 'sharp';
import { expect } from 'vitest';

import { eventually } from './app.js';
import { bearer, type SignedIn } from './http.js';

// Step 26g: a shop photo the way the editor sends one. The tests that use these need the storage
// (startStorage) for the upload and a worker for the image job.

// A plain JPEG of this size, in the shop's teal. orientation: the EXIF "turn me" note a phone
// writes (6 = turn a quarter to the right), so a test can see the job turn the photo upright
export function jpegOf(width: number, height: number, orientation?: number): Promise<Buffer> {
  const picture = sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 88, b: 89 } },
  }).jpeg();
  return (orientation === undefined ? picture : picture.withMetadata({ orientation })).toBuffer();
}

// The three steps of an upload: describe the file, PUT it to the presigned address, confirm it.
// The answer is the photo's id; the job then runs on its own
export async function sendPhoto(
  app: NestFastifyApplication,
  who: SignedIn,
  bytes: Buffer,
  contentType = 'image/jpeg',
): Promise<string> {
  const headers = bearer(who.accessToken);
  const start = await app.inject({
    method: 'POST',
    url: '/storefront/images',
    headers,
    payload: { fileName: 'photo.jpg', contentType, sizeBytes: bytes.length },
  });
  expect(start.statusCode, start.body).toBe(201);
  const ticket = storefrontUploadTicketSchema.parse(start.json());
  // fetch, not inject: the address is the storage's, not the API's. Uint8Array: what fetch's body
  // type takes (a Buffer is one, but the DOM types do not say so)
  const put = await fetch(ticket.upload.url, {
    method: 'PUT',
    headers: ticket.upload.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  const done = await app.inject({
    method: 'POST',
    url: `/storefront/images/${ticket.image.id}/complete`,
    headers,
  });
  expect(done.statusCode, done.body).toBe(200);
  return ticket.image.id;
}

// The photo once the job is done with it: ready or failed. A photo still processing after the
// time is a failure of the test, with the last state in the message
export function photoSettled(
  app: NestFastifyApplication,
  who: SignedIn,
  id: string,
): Promise<StorefrontUpload> {
  return eventually(async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/storefront/images/${id}`,
      headers: bearer(who.accessToken),
    });
    const upload = storefrontUploadSchema.parse(res.json());
    if (upload.status !== 'ready' && upload.status !== 'failed') {
      throw new Error(`Photo ${id} is still ${upload.status}`);
    }
    return upload;
  }, 20_000);
}

// A photo a listing may save: sent, made, ready
export async function readyPhoto(app: NestFastifyApplication, who: SignedIn): Promise<string> {
  const id = await sendPhoto(app, who, await jpegOf(800, 800));
  expect((await photoSettled(app, who, id)).status).toBe('ready');
  return id;
}
```

`jpegOf()` makes the picture in memory with sharp, so the repo needs no test image files. The `orientation`
option writes the EXIF note a phone writes when it is held upright; the job must turn the photo, and a
plain picture would not show whether it does.

`sendPhoto()` runs the three steps the editor runs. The `PUT` uses `fetch`, not `app.inject`: the presigned
address points at MinIO, not at the API. `new Uint8Array(bytes)`: `fetch`'s body type does not list `Buffer`
(even though a `Buffer` is a `Uint8Array`), and a cast would hide a real type error.

`photoSettled()` waits up to 20 seconds, because the job runs in the worker after the outbox relay picks
the event up. It waits for "ready" or "failed", never for one of them only: a test that expects "ready" and
gets "failed" then fails at once with the reason, instead of waiting for the time to run out.

### 26f's helper: `storefront.ts`

```diff
@@ -6,10 +6,11 @@ import { z } from 'zod';
 
 import { bearer, type SignedIn } from './http.js';
 
-// Step 26f's tests: a shop made straight in the database. The ERP's Storefront screens (and their
-// API) come in step 26g, so until then the tests write the rows as the superuser, the way 26g's
-// API will. Every row still passes the tables' checks, so a test can never set up a shop the real
-// screens could not make.
+// Step 26f's tests: a shop made straight in the database, as the superuser. Every row still passes
+// the tables' checks, so a test can never set up a shop the real screens could not make.
+// Step 26g kept this for the public API's tests (its decision 30): they test how a shop is read,
+// and step 26g's own tests (storefront-admin.int.spec.ts) test how one is written. Made through
+// the admin API, every listing would need a real photo, the storage and the image job.
 
 const idRowSchema = z.array(z.object({ id: z.uuid() })).length(1);
 
@@ -35,13 +36,15 @@ export async function tenantIdOf(sql: postgres.Sql, slug: string): Promise<strin
 }
 
 // A product with one variant, through the ERP's own API, so its rows are exactly what a real
-// workspace has (SKU, base unit, version). The SKU is the name without spaces, in capitals
+// workspace has (SKU, base unit, version). The SKU is the name without spaces, in capitals, unless
+// the test names one (step 26g: a Bangla name has no letter \W keeps, and two names can make one SKU)
 export async function createProduct(
   app: NestFastifyApplication,
   who: SignedIn,
   unitId: string,
   name: string,
   salePrice: string,
+  sku = name.replace(/\W/g, '').toUpperCase(),
 ): Promise<Product> {
   const res = await app.inject({
     method: 'POST',
@@ -63,7 +66,7 @@ export async function createProduct(
       variants: [
         {
           id: null,
-          sku: name.replace(/\W/g, '').toUpperCase(),
+          sku,
           optionValues: [],
           barcode: '',
           salePrice,
```

The comment now says why 26f's tests still write rows by hand (decision 30). `createProduct()` takes an
optional SKU as its last parameter, with the old rule as the default, so 26f's calls do not change. The
new tests need it twice: `\W` removes every Bangla letter (a Bangla name would get an empty SKU), and two
products with the same name would get the same SKU, which the products table refuses.

### The Storefront menu, start to finish: `storefront-admin.int.spec.ts`

```ts
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
```

`UNKNOWN` is a valid uuid that no row has. A test that sends it checks the "does not exist" path, which
must look exactly like "another workspace's" (the leak file checks that side).

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
```

`refused()` checks the status **before** it parses the answer. Every error body parses as a problem, a 500
too, so without the status check a crash would pass a test that expects a 409.

`FIRST_SAVE` is typed as the form's input (`StorefrontSettingsFormValues` without `version`), not as the
parsed output: the test sends what the browser sends (`''` for "no warehouse", amounts as typed). If the
contract changes a box, this object stops type-checking.

`formOf()` and `editorOf()` build the next form from an answer, the way the screens fill their boxes. Many
tests send `{ ...formOf(shop), oneChange }`, so each test changes one thing and keeps the rest valid.
`editorOf()` keeps only `{ id, alt }` of each photo: the answer adds a `url`, which the form does not send.

```ts
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
```

The worker runs in the test process, so the setup job (units, warehouse, role templates) and the image job
run as in production. `joinWithoutRoles()` adds Sumi to Nirvor with no role: she can sign in, and she may do
nothing. She signs up to her own workspace first, because a user only exists after a sign-up.

```ts
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
```

**Who may run the shop.** Each route is tried as Sumi. `POST /storefront/images` gets an empty body on
purpose: the permission guard runs before the body is checked, so the answer is 403, not 400. A 400 would
tell someone without the permission what the route expects. The second test checks decision 28 of 26g.3:
the retail template's "Shop manager" gets `storefront.manage`.

**The settings.** The first test checks the setup answer before any save: no shop yet, and the workspace's
own slug and name as the suggestion. "Needs the settings first" checks that nothing can be added to a shop
that does not exist yet (`storefront_not_set_up`), not even with a valid-looking body.

The zone test sends three zones on purpose: a saved id, the same id again, and an id the shop never had.
The answer must keep the first, give the second a new id (two radio cards with one value would be one), and
give the made-up one a new id too (a stale form or a hand-made request cannot choose an id). `Savar` at
`৳0` checks that a free zone is allowed, which `free_delivery_from` is not. The amounts come back with 4
decimals, as the database keeps them, so the shop's quote compares like with like.

"Does not open the shop before it has a published listing" runs while the shop has a warehouse and a zone,
so the listing is the only thing missing: the test shows that the checklist really needs all three.

```ts
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
```

**The categories.** The Bangla name test checks decision 12 of 26g.1 from the API's side: an empty slug with a
name that has no Latin letter is refused on the slug box, and the same name with a slug is fine.
`skin CARE` checks that a taken name is compared without case in the same parent (`category_name_taken`),
and it sends its own slug so the slug check does not answer first.

The rename test moves "Baby care" under "Skin care" and back. Under "Skin care" it is second (Face wash is
first), and back at the top it is last: a new parent always puts the category at the end of its list. The
slug is sent empty, so the API makes it from the new name.

The move test checks three things decision 26 of 26g.3 promised: the swap, a new version on the rows that
moved (a form open on one of them must know it changed), and a no-op at the top. The no-op answer is
compared with the whole previous list, `updatedAt` included, which proves nothing was written. A move with
the old version is then refused, because the row changed since.

The last test deletes a category that still has a child. The foreign key refuses it, and the service turns
that into `category_has_children`, which the screen can explain.

```ts
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
```

**The photos.** The general `/attachments` route refuses the `storefront_image` purpose (400): a shop photo
must go through the shop's routes, or no job would start for it. The GIF test sends both mistakes at once and
expects both field errors, so the form can show them together.

"Does not confirm a photo whose file never arrived" confirms before the `PUT`. The answer is
`upload_incomplete`, and the photo stays "uploading": no job row, no event. Without this, a lost upload would
leave a job that can only fail.

The main photo test checks the whole job: the EXIF turn (1600 × 1200 with orientation 6 comes back as
1200 × 1600), the three files with their widths (small 480; large and wide stay 1200, because the job never
makes a photo bigger), the year-long `Cache-Control`, and no EXIF data left in the files (`meta.exif` is
`undefined`; the phone's GPS position must not reach the shop). The original stays private: the storage
answers 403 without a signed address, and the general download route answers 404. The second confirm must
not start a second job; the test counts the outbox events for this photo in the database, because the answer
alone ("ready") would look the same either way.

The failed photo test sends a 150px PNG and a text file named as a PNG. Each gets its own code, so the
screen can say "too small" or "not a picture" under that photo.

```ts
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
```

**The listings, first part.** `beforeAll` makes one ready photo that the later tests reuse; a photo takes a
second or two to make.

The candidates test makes two "Neem Face Wash" products with different SKUs, a tea with no price, and a
Bangla soap. Searching "neem" finds the soap by its SKU (`NEEM-SOAP`), which is how a Bangla name is found
with a Latin search. The next test adds three of them and checks decision 24 of 26g.3: the first gets
`neem-face-wash`, the second `neem-face-wash-2`, and the Bangla one its SKU as its slug. Once listed, a
variant leaves the "Add to shop" box, and a second add is refused on the variant's box.

The sale test checks a price sale with a start date next week. It is still refused if it is not lower: a
sale that starts later must already be lower, or the shop would show a "sale" that costs more when it starts.

The photo test sends one good photo, one failed photo and one made-up id. The errors land on `images.1` and
`images.2` only, so the editor can mark the two bad photos and leave the good one alone. The same photo twice
is refused by the contract (400) before the API looks at the database.

The editor test saves everything at once, then sends the answer back unchanged (`saveListing(neem, {})`).
The second answer must equal the first, except for the version and the time. This is the editor's normal
loop: if an answer did not survive a round trip, every second save would change something nobody touched.
The badges are sent in a mixed order with one twice, and come back once each in `SHOP_BADGES` order.

```ts
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
```

**The listings, second part.** The tea is published step by step: without a photo, then without a price,
then with a sale but no price (the sale's error is on the price box, because the price is what is missing),
then with a price. Each step gets its own error, so the screen can say what to do next.

"Keeps a published listing sellable" removes the last photo of a published listing. The shop would show a
card with no picture, so the save is refused on the photos box.

The launch test checks the checklist with all three ticked, opens the shop, then clicks again with the new
version. The answer must be equal to the first one: open already, nothing written. Then the public API
shows the published listing, and not the draft.

The open-shop test checks the launch rule from the API's side: an open shop cannot drop its warehouse or
its last zone. Each is refused on its own box, before the table's check would refuse it with a database
error.

The address test is decision 3 of 26g: after the move, the new host answers and the old one answers
`storefront_not_found`, like any address with no shop. There is no redirect.

The archive test archives the product in the ERP through its own route, then tries to publish its listing.
The answer is `storefront_variant_archived`: a shop must not sell what the ERP stopped selling.

```ts
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
```

**The listings, third part.** The catalog test puts stock in the shop's warehouse for one product only, with
SQL: stock comes from stock documents, and making one here would test step 13, not the catalog. Then it checks
the price a shopper pays now (`269.1000`, 10% off `299`) with the old price, the stock flag, search by SKU,
the category filter, and the status filter.

The paging loop asks for one row at a time in each sort and collects every id. Four listings must come back
four times, each once: a cursor that skipped or repeated a row would show here. A cursor from one sort is
refused in another (`invalid_cursor`), because its key means something else there.

The delete test refuses to delete a category with a listing, unpublishes the listing, refuses a delete with
the old version, deletes it, and then deletes the empty category. Unpublish is tested here because it is
what a person does before deleting.

The audit test reads every Storefront action this workspace wrote. All twelve actions of 26g.1 appear, so
each service writes its audit row.

### Two workspaces: `storefront-admin.tenant-leak.int.spec.ts`

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  problemSchema,
  setupSchema,
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
```

`answer()` returns the status, the code and the field errors together, so each leak test compares the whole
answer in one `toEqual` (decision 33).

```ts
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
```

`setUp()` gives each workspace the same things: a shop, a "Beverages" category with the same slug in both
(each shop's slugs are its own), a listing, a ready photo and a product that is not listed yet. The two
workspaces are set up at the same time (`Promise.all`); they share nothing, so the order does not matter.

```ts
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
```

Acme's photo is ready, so it is refused only because it is Acme's (decision 32). The listing save puts
Nirvor's own photo first: the error must be on `images.1` only, which shows that the check looks at each
photo and does not refuse the whole list. The last test reads `storefront_images` as the superuser and checks
that the job wrote each row under its own workspace: the worker runs one job per tenant, and a mix-up there
would put Acme's photo into Nirvor's rows.

```ts
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
```

Acme's variant is refused with `required`, the same code as a made-up id (decision 33). Acme's category is
refused as a parent, as a new listing's category and as an existing listing's category. Changing, moving and
deleting Acme's category all answer 404, and then Acme's own list shows the category at version 1: nothing
was written, not even a version bump. Filtering Nirvor's catalog by Acme's category returns nothing, not an
error: an error would tell that the id exists somewhere.

```ts
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
```

Every route of Acme's listing answers 404 to Nirvor, and Acme's listing keeps its version. The search for
"green" finds only Nirvor's tea, though both workspaces have one.

```ts
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
```

Subdomains are the one thing shared by all workspaces: the unique index sees every shop, even though the
transaction cannot read them (RLS). The answer is the field error `storefront_subdomain_taken`, and nothing
more about the other shop. Acme's warehouse is refused like a made-up one, so Nirvor's shop can never count
Acme's stock.

### Check this part

```bash
pnpm --filter @omnivo/api exec tsc --noEmit
pnpm exec eslint apps/api/src/storefront apps/api/src/testing
pnpm exec prettier --check apps/api/src/storefront apps/api/src/testing
cd apps/api
npx vitest run src/storefront/ src/common/tenant/rls-coverage.tenant-leak.int.spec.ts --maxWorkers=3
```

The last command runs 26f's and 26g's storefront suites and the check that every table with a `tenant_id`
has row-level security (`storefront_images` included): 10 files, 99 tests, all passing. The two new files
have 50 tests.

Two "break it on purpose" changes were made together, run, and then undone: the photo check in
`listings.service.ts` turned off (every photo counted as ready), and the outbox event emitted on every
confirm, not only the first. 9 tests failed in the two files: the second-confirm test, the photo tests of
the editor, and the tenant-leak test for Acme's photo among them.

## 26g.5 — `packages/i18n`: the screens' words

The four pages of 26g.6 need their words in English and Bangla, so they come first. This part changes only the two
locale files. 26g.1 already gave the permission, the audit events and the error codes their words; this part adds the
sidebar's items, the audit log's names for the new fields, and one `storefront` block for the pages.

These words come before the pages' mockup. If the mockup in 26g.6 changes a page, the words change with it, and the
diffs below show them as they are at the end of the step.

Four decisions came up while writing the words (mine):

34. **A sale's dates are whole days**, in the workspace's time zone, the last day included. The contract keeps two
    moments (`startsAt`, `endsAt`, and the sale stops *at* `endsAt`), but a shop owner thinks "from the 1st until the
    7th". The screen sends the start of the first day and the start of the day after the last one. The hint under the
    dates says so, and an empty box means "now" or "no end".
35. **The sidebar says "Shop categories" and "Shop settings"**, not "Categories" and "Settings" (decision 5's
    names). On a phone the sidebar is one row with no group labels, so "Categories" would sit next to Inventory's
    Categories, and "Settings" next to the workspace's Settings. "Catalog" is unique, so it stays.
36. **The audit log's `slug` field reads "Web address"**, not "Workspace address". The audit page has one word per
    field name for every kind of record (`audit.fields`), and a shop category and a listing write `slug` too. "Web
    address" is true for all three; a workspace's old log rows keep reading well.
37. **No read-only words.** Every Storefront route needs `storefront.manage`, and the sidebar hides the group
    without it (decision 5), so unlike POS registers there is no page that someone may see but not change.

### `locales/en.ts`

```diff
@@ -147,6 +147,13 @@ export const en = {
     cashReasons: 'POS cash reasons',
     // Step 20c: what the counters took back (under Sales, next to POS sales)
     posReturns: 'POS returns',
+    // Step 26g: the Storefront group, by storefront.manage (decision 5). Its categories and
+    // settings say "Shop": on a phone the nav is one row with no group labels, next to the
+    // Inventory's Categories and the workspace's Settings
+    storefront: 'Storefront',
+    storefrontCatalog: 'Catalog',
+    storefrontCategories: 'Shop categories',
+    storefrontSettings: 'Shop settings',
   },
   auth: {
     workspace: 'Workspace',
```

The sidebar's group and its three items. The comment says why two of them carry "Shop" (decision 35).

```diff
@@ -5210,6 +5217,334 @@ export const en = {
       'Goods a counter takes back show here once its device syncs: a shirt in the wrong size, a phone case that does not fit.',
     loadFailed: "Couldn't load the POS returns. Refresh the page to try again.",
   },
+  // Step 26g: the Storefront menu (decision 5): the catalog, the shop's categories, a listing's
+  // editor and the shop's settings with its launch. Online only, all behind storefront.manage, so
+  // there is no read-only state: someone without the permission never sees the menu
+  storefront: {
+    // Decision 4: next to "View shop" on every page of the menu. The shop's server keeps an
+    // answer for 30 seconds (26f.5), so "a minute" is safe
+    changesSoon: 'Changes show in the shop within a minute',
+    viewShop: 'View shop',
+    needsConnection: 'The shop’s menu works on the server. Connect to the internet to use it.',
+    statuses: { published: 'In the shop', draft: 'Draft' },
+    badges: { most_picked: 'Most Picked', new: 'New', buy_one_get_one: 'Buy 1 Get 1' },
+    payments: { cod: 'Cash on Delivery', online: 'Mobile Banking' },
+    moveUp: 'Move up',
+    moveDown: 'Move down',
+    // Step 26g.6: the save bar under a long form, while it has changes (the mockup's bar)
+    unsaved: 'Changes not saved yet',
+    discard: 'Discard changes',
+    settings: {
+      title: 'Shop settings',
+      description: 'Your online shop’s address, contact details, delivery and payment',
+      // Before the first save: the form starts from the workspace's own details (decision 10)
+      notSetUp:
+        'The shop is not set up yet. Check these details, which come from your company, and save. The shop opens only when you choose Open the shop.',
+      statusNotOpen: 'Not open yet',
+      statusOpen: 'Open',
+      addressTitle: 'Name and address',
+      subdomain: 'Shop address',
+      subdomainHint:
+        'Lowercase English letters, numbers and single hyphens. Shoppers type it to reach your shop.',
+      // Decision 3: once the shop is open, a new address breaks the old links
+      subdomainLiveHint: 'The shop is open at this address. Changing it breaks links to it.',
+      name: 'Shop name',
+      nameHint: 'In the shop’s header and its browser tab. It can differ from your legal name.',
+      language: 'Shop language',
+      languageHint: 'The shop’s pages and messages are in this language.',
+      contactTitle: 'Contact',
+      contactHint: 'Shoppers see these on every page.',
+      hotline: 'Hotline',
+      hotlinePlaceholder: '09612-345678',
+      hotlineHint: 'On every product page, next to "Hotline:".',
+      address: 'Address',
+      addressPlaceholder: 'House 12, Road 5, Dhanmondi, Dhaka 1205',
+      addressHint: 'In the shop’s footer.',
+      socialTitle: 'Social pages',
+      socialHint: 'The whole link, starting with https://. An empty one has no icon in the footer.',
+      facebookUrl: 'Facebook',
+      instagramUrl: 'Instagram',
+      xUrl: 'X',
+      linkedinUrl: 'LinkedIn',
+      facebookPlaceholder: 'https://facebook.com/nirvorpharmacy',
+      instagramPlaceholder: 'https://instagram.com/nirvorpharmacy',
+      xPlaceholder: 'https://x.com/nirvorpharmacy',
+      linkedinPlaceholder: 'https://linkedin.com/company/nirvor',
+      deliveryTitle: 'Stock and delivery',
+      warehouse: 'Warehouse for the shop',
+      warehousePlaceholder: 'Pick a warehouse',
+      warehouseHint: 'The shop says "In stock" or "Out of stock" from this warehouse.',
+      zones: 'Delivery zones',
+      // max = STOREFRONT_ZONES_MAX in the page's language
+      zonesHint:
+        'Where you deliver and what it costs, up to {{max}}. The shopper picks one at checkout.',
+      zoneNumber: 'Zone {{number}}',
+      zoneName: 'Zone',
+      zoneNamePlaceholder: 'Inside Dhaka',
+      zoneCharge: 'Charge',
+      // Decision 13: a charge of ৳0 is allowed (a zone you deliver to for free)
+      zoneChargeHint: '৳0 means free in this zone.',
+      addZone: 'Add zone',
+      removeZone: 'Remove zone {{number}}',
+      noZones: 'No delivery zone yet. Add one, like Inside Dhaka for ৳80.',
+      freeDeliveryFrom: 'Free delivery from',
+      freeDeliveryHint:
+        'Orders of this much or more pay no delivery charge. Empty means never free.',
+      minimumOrder: 'Minimum order',
+      minimumOrderHint: 'Checkout waits until the cart reaches this. Empty means no minimum.',
+      paymentTitle: 'Payment',
+      payments: 'Ways to pay',
+      paymentsHint: 'Mobile Banking is bKash or Nagad, paid before the parcel leaves.',
+      create: 'Set up the shop',
+      created: 'Shop set up. Open it when the checklist is done.',
+      updated: 'Shop settings saved',
+      // Decision 3: the dialog when a save changes the address of an open shop
+      moveTitle: 'Change the shop’s address?',
+      moveBody:
+        '{{from}} stops working as soon as you save, and so do the links to it on Facebook or in an SMS. Nothing sends shoppers on to {{to}}.',
+      moveConfirm: 'Change the address',
+      loadFailed: "Couldn't load the shop settings. Refresh the page to try again.",
+    },
+    // The checklist card on the settings page, until the shop is open (decision 1)
+    launch: {
+      title: 'Open the shop',
+      description: 'Three things before shoppers can order',
+      warehouse: 'Pick the warehouse the shop sells from',
+      zone: 'Add at least one delivery zone',
+      listing: 'Show at least one listing in the shop, with a photo and a price',
+      goToCatalog: 'Go to the catalog',
+      done: 'Done',
+      notDone: 'Not done yet',
+      // The button waits for the first save: the checklist reads the saved settings
+      saveFirst: 'Save the settings first. The checklist reads what is saved.',
+      open: 'Open the shop',
+      confirmTitle: 'Open {{name}}?',
+      confirmBody:
+        '{{url}} starts answering, and anyone can see your listings and order from them. A shop can’t be closed again, but you can take listings out of it.',
+      opened: '{{name}} is open',
+      openTitle: 'The shop is open',
+      // date = the launch day in the workspace's time zone
+      openSince: 'Open since {{date}} at {{url}}',
+    },
+    categories: {
+      title: 'Shop categories',
+      description: 'How the shop groups its listings, in the order its menu shows them',
+      add: 'Add category',
+      addTo: 'Add a category to {{name}}',
+      newTitle: 'Add a shop category',
+      editTitle: 'Edit {{name}}',
+      parent: 'Inside',
+      topLevel: 'Top level',
+      name: 'Name',
+      namePlaceholder: 'Skin care',
+      slug: 'Link name',
+      // Decision 12: an empty link name is made from the name
+      slugHint: 'In the shop’s address: /c/{{slug}}. Leave it empty to make it from the name.',
+      slugChangeHint: 'Old links to this category stop working when the link name changes.',
+      listingCount_one: '{{formatted}} listing',
+      listingCount_other: '{{formatted}} listings',
+      moveUpLabel: 'Move {{name}} up',
+      moveDownLabel: 'Move {{name}} down',
+      edit: 'Edit',
+      delete: 'Delete',
+      created: '{{name}} added',
+      updated: '{{name}} saved',
+      confirmDelete: 'Delete {{name}}?',
+      deleteWarning: 'Only a category with no listings and no categories inside it can be deleted.',
+      // 26g.6: the row's menu (Edit, Delete) and the search above the tree
+      actions: 'Actions for {{name}}',
+      searchLabel: 'Search the shop categories',
+      searchPlaceholder: 'Name or link name',
+      noMatchTitle: 'No shop category matches',
+      noMatchBody: 'Check the spelling, or clear the search.',
+      deleted: '{{name}} deleted',
+      expand: 'Show the categories in {{name}}',
+      collapse: 'Hide the categories in {{name}}',
+      emptyTitle: 'No shop categories yet',
+      emptyBody:
+        'Add the groups shoppers look for, like Skin care, Baby care and Diabetic corner, then put listings in them.',
+      loadFailed: "Couldn't load the shop categories. Refresh the page to try again.",
+    },
+    catalog: {
+      title: 'Catalog',
+      description: 'The products your shop shows, with their shop price and photos',
+      add: 'Add to shop',
+      searchLabel: 'Search the catalog',
+      searchPlaceholder: 'Name or SKU',
+      status: 'Show',
+      statuses: { all: 'All', published: 'In the shop', draft: 'Drafts' },
+      category: 'Category',
+      allCategories: 'All categories',
+      columns: {
+        listing: 'Listing',
+        category: 'Category',
+        price: 'Shop price',
+        stock: 'Stock',
+        status: 'Status',
+        updated: 'Changed',
+      },
+      // packSize may be empty; the page then shows the SKU alone
+      subline: '{{sku}} · {{packSize}}',
+      noPhoto: 'No photo',
+      noPrice: 'No price',
+      inStock: 'In stock',
+      outOfStock: 'Out of stock',
+      // inStock = null: the shop has no warehouse yet, so stock is not known
+      noWarehouse: 'No warehouse',
+      // Listings need the shop's settings first (storefront_not_set_up)
+      notSetUpTitle: 'Set up the shop first',
+      notSetUpBody:
+        'Save the shop’s address, contact and delivery details, then add products to it.',
+      goToSettings: 'Go to shop settings',
+      emptyTitle: 'Nothing in the shop yet',
+      emptyBody:
+        'Add products like Neem face wash or Napa 500 mg tablets, give each a photo and a price, then show them in the shop.',
+      noMatchTitle: 'No listing matches',
+      noMatchBody: 'Check the spelling, or clear the filters.',
+      clearFilters: 'Clear the filters',
+      loadFailed: "Couldn't load the catalog. Refresh the page to try again.",
+    },
+    // The "Add to shop" dialog (decisions 14 and 16)
+    add: {
+      title: 'Add a product to the shop',
+      description:
+        'It starts as a draft. Add a photo and check the price, then show it in the shop.',
+      product: 'Product',
+      productPlaceholder: 'Pick a product',
+      searchLabel: 'Search products',
+      searching: 'Searching…',
+      noMatch: 'No product to add matches. Products already in the shop are not listed.',
+      // sku · the product's sale price, or sku alone when it has none
+      detail: '{{sku}} · {{price}}',
+      category: 'Shop category',
+      categoryPlaceholder: 'Pick a category',
+      noCategories: 'The shop has no categories yet.',
+      addCategories: 'Add categories',
+      submit: 'Add to shop',
+      added: '{{name}} added as a draft',
+    },
+    // A listing's editor (/storefront/listings/$id)
+    listing: {
+      back: 'Catalog',
+      // Under the title: the product in Omnivo the listing sells
+      fromProduct: 'Sells {{name}} · {{sku}}',
+      publish: 'Show in the shop',
+      unpublish: 'Take out of the shop',
+      published: '{{name}} is in the shop',
+      unpublished: '{{name}} is a draft again',
+      // The publish button waits for the form: the server publishes what is saved
+      saveFirst: 'Save your changes first, then show it in the shop.',
+      viewInShop: 'View in the shop',
+      // 26g.6: the header's menu button (View in the shop, Delete listing)
+      moreActions: 'More actions',
+      delete: 'Delete listing',
+      confirmDelete: 'Delete {{name}}?',
+      deleteBody:
+        'It leaves the shop and its photos and description are deleted. The product and its stock stay in Omnivo.',
+      deleted: '{{name}} deleted',
+      updated: 'Changes to {{name}} saved',
+      draftNotice: 'This listing is a draft, so the shop does not show it.',
+      // An archived product hides its listing in the shop (26f), whatever the listing says
+      archivedNotice:
+        '{{name}} is archived in Products, so the shop hides this listing. Restore the product to sell it again.',
+      inStock: 'In stock in {{warehouse}}',
+      outOfStock: 'Out of stock in {{warehouse}}',
+      noWarehouse: 'The shop has no warehouse yet, so it shows no stock.',
+      basicsTitle: 'Basics',
+      name: 'Name in the shop',
+      nameHint: 'The product’s name in Omnivo stays as it is.',
+      slug: 'Link name',
+      slugHint: 'In the address: /p/{{slug}}. Leave it empty to make it from the name.',
+      slugChangeHint: 'Old links to this listing stop working when the link name changes.',
+      packSize: 'Pack size',
+      packSizePlaceholder: '150 ml',
+      packSizeHint: 'Under the name on the shop’s card.',
+      category: 'Shop category',
+      badges: 'Badges',
+      badgesHint: 'On the photo’s corner in the shop.',
+      photosTitle: 'Photos',
+      // max = the most photos a listing has (storefrontImagesSchema)
+      photosHint:
+        'Up to {{max}}. The first is the one on the shop’s card. JPEG, PNG or WebP, under 8 MB, at least 200 pixels on each side.',
+      addPhoto: 'Add photo',
+      photoNumber: 'Photo {{number}}',
+      uploading: 'Uploading…',
+      // Decision 2: the job makes the shop's sizes; the screen asks again until it is done
+      preparing: 'Preparing the photo…',
+      alt: 'What the photo shows',
+      altPlaceholder: 'Neem face wash, 150 ml tube',
+      altHint: 'Read aloud to shoppers who can’t see the photo.',
+      removePhoto: 'Remove photo {{number}}',
+      movePhotoUp: 'Move photo {{number}} earlier',
+      movePhotoDown: 'Move photo {{number}} later',
+      noPhotos: 'No photo yet. The shop shows a listing only with at least one photo.',
+      // 26g.6 (mockup approved): the first photo's tag and what the Add tile says under it
+      firstPhoto: 'On the shop’s card',
+      photosLeft_one: '{{formatted}} more can be added',
+      photosLeft_other: '{{formatted}} more can be added',
+      // A photo the job could not use: the error words say why; this drops it from the form
+      dropPhoto: 'Remove it',
+      priceTitle: 'Price and sale',
+      price: 'Shop price',
+      // price = the variant's sale price in Omnivo
+      priceHint: 'Leave it empty to use the product’s sale price, {{price}}.',
+      priceHintNone: 'The product has no sale price in Omnivo, so type one here.',
+      sale: 'Sale',
+      saleKinds: {
+        none: 'No sale',
+        percent: 'Percent off',
+        amount: 'Taka off',
+        price: 'Sale price',
+      },
+      // The value box's label follows the kind
+      saleValues: {
+        percent: 'Percent off (1 to 99)',
+        amount: 'Amount off',
+        price: 'Price on sale',
+      },
+      percentPlaceholder: '10',
+      // Decision 34: whole days in the workspace's time zone, the last day included
+      saleFrom: 'From',
+      saleUntil: 'Until',
+      saleDatesHint:
+        'Whole days in your workspace’s time zone, the last day included. Empty From means now; empty Until means no end.',
+      preview: 'In the shop now',
+      previewNoPrice: 'No price yet. Type a shop price.',
+      // ribbon = the card's tag: "৳20 OFF" or "10% OFF"
+      ribbonAmount: '{{amount}} OFF',
+      ribbonPercent: '{{percent}}% OFF',
+      previewUntil: 'The sale ends after {{date}}.',
+      previewLater: 'The sale starts on {{date}}.',
+      previewEnded: 'The sale ended on {{date}}.',
+      descriptionTitle: 'Description',
+      descriptionHint:
+        'Sections under the photos on the product page, like Benefits and How to use.',
+      sectionNumber: 'Section {{number}}',
+      heading: 'Heading',
+      headingPlaceholder: 'Benefits',
+      body: 'Text',
+      bodyPlaceholder: '- Clears pimples\n- Gentle enough for every day',
+      bodyHint:
+        'A blank line starts a new paragraph. Lines that start with - make a list, and 1. a numbered one. **Bold** and [a link](https://…) work too.',
+      addSection: 'Add section',
+      removeSection: 'Remove section {{number}}',
+      moveSectionUp: 'Move section {{number}} up',
+      moveSectionDown: 'Move section {{number}} down',
+      noSections: 'No description. The product page then shows the photos and the price only.',
+      showPreview: 'Preview',
+      hidePreview: 'Hide preview',
+      previewCaption: 'As the product page shows it',
+      seoTitle: 'Search engines',
+      seoHint:
+        'What Google and Facebook show for this page. Empty boxes use the listing’s own words.',
+      seoPageTitle: 'Page title',
+      seoPageDescription: 'Page description',
+      // count and max in the page's language
+      seoCount: '{{count}} of {{max}} characters',
+      notFound: "This listing doesn't exist.",
+      loadFailed: "Couldn't load the listing. Refresh the page to try again.",
+    },
+  },
   approvals: {
     title: 'Approvals',
     description: 'Documents waiting for your decision, oldest first',
```

The pages' words, in one block per page. Some things to notice:

- **`changesSoon` and `viewShop`** sit at the top of the block, because every page of the menu shows them in its
  header (decision 4). "Within a minute" and not "within 30 seconds": the shop's server keeps an answer for 30
  seconds, and the browser and a phone's network add their own delay, so a minute is a promise that holds.
- **`statuses`, `badges` and `payments`** are shared by the catalog, the editor and the settings. The badges and the
  payment methods use the shop's own words (`shop.badges`, `shop.checkout`), so the owner reads in the ERP exactly
  what a shopper reads in the shop. They are copied, not imported: the ERP app never loads the shop's words (CLAUDE.md
  → Language).
- **`settings.notSetUp`** is the notice above the form before the first save. The form starts from the company's own
  name, phone and address (`suggested`, decision 10), so the notice says where they came from: an owner who sees
  their own phone number should know why it is already there.
- **`settings.subdomainLiveHint` and `settings.moveTitle`/`moveBody`** are decision 3. The hint shows under the box
  once the shop is open; the dialog asks before a save that changes the address. `{{from}}` and `{{to}}` are the
  whole addresses (`nirvor.omnivo.shop`), so the owner sees exactly which link breaks.
- **`settings.zoneChargeHint`** says that ৳0 is allowed: decision 13 lets a zone deliver for free, while "Free
  delivery from" can't be ৳0 (an amount of 0 there would make every order free; the owner would leave it empty).
- **`launch.saveFirst`**: the checklist is worked out by the server from the saved settings (`readiness`). While the
  form has unsaved changes, a tick could be wrong (a warehouse picked but not saved), so the page disables "Open the
  shop" and says why.
- **`launch.confirmBody`** says that a shop can't be closed again (26e: a shop is always open) and what the owner
  can do instead: take listings out of it.
- **`categories.slugHint` and `listing.slugHint`** show the real address (`/c/skin-care`, `/p/neem-face-wash`), with
  the slug the box holds now, or the one the name would make (decision 12). Their `slugChangeHint` shows only while
  editing a saved one, because only then does a link already exist.
- **`catalog.noWarehouse`**: the list's stock is `null` when the shop has no warehouse yet (26g.3). "Out of stock"
  would be wrong there, so the cell says what is missing.
- **`catalog.notSetUpTitle`**: a listing needs the shop's settings first (`storefront_not_set_up`), so the catalog
  before the first save is an empty state with a link to the settings, not a list that fails on "Add to shop".
- **`add.noMatch`** explains why a product may be missing from the search: the candidates leave out what is already
  in the shop (decision 14).
- **`listing.saveFirst`**: publishing checks what is saved (a photo, a price). With unsaved changes the button waits,
  like `launch.saveFirst`.
- **`listing.archivedNotice`**: the shop hides a listing whose product is archived (26f), whatever its status says.
  The notice tells the owner why a "published" listing is not in the shop.
- **`listing.priceHint`** names the product's own sale price, because an empty shop price uses it. When the product
  has none, `priceHintNone` says the box is needed, before the publish refuses it (`storefront_listing_no_price`).
- **`listing.saleValues`**: the value box's label follows the sale's kind, so one box serves the three kinds.
  `ribbonAmount` and `ribbonPercent` are the card's own tag ("৳20 OFF"), so the preview looks like the card.
- **`listing.saleDatesHint`** is decision 34.
- **`listing.bodyHint`** lists the only formatting `renderSections` understands (26f): paragraphs, `-` lists, `1.`
  lists, bold and links. Telling the owner keeps them from typing HTML, which the shop would show as text.
- **`listing.photosHint`** repeats the photo rules of the job (decision 9) before the upload, so a too-small photo
  is not found out only after it is sent.

```diff
@@ -6194,7 +6529,7 @@ export const en = {
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
       name: 'Name',
-      slug: 'Workspace address',
+      slug: 'Web address',
       companyName: 'Company name',
       legalName: 'Legal name',
       bin: 'BIN',
@@ -6372,6 +6707,32 @@ export const en = {
       dayOfMonth: 'Day of the month',
       recipients: 'Sent to',
       pausedReason: 'Why it stopped',
+      // Step 26g: the shop's settings, a shop category and a listing. slug above is the
+      // workspace's address; a category's and a listing's link name show as "Web address" too
+      subdomain: 'Shop address',
+      language: 'Language',
+      hotline: 'Hotline',
+      facebookUrl: 'Facebook',
+      instagramUrl: 'Instagram',
+      xUrl: 'X',
+      linkedinUrl: 'LinkedIn',
+      defaultWarehouseId: 'Warehouse for the shop',
+      deliveryZones: 'Delivery zones',
+      freeDeliveryFrom: 'Free delivery from',
+      minimumOrder: 'Minimum order',
+      paymentMethods: 'Ways to pay',
+      launched: 'Open',
+      position: 'Place in the list',
+      packSize: 'Pack size',
+      categoryId: 'Shop category',
+      priceOverride: 'Shop price',
+      badges: 'Badges',
+      images: 'Photos',
+      sections: 'Description sections',
+      seoTitle: 'Page title',
+      seoDescription: 'Page description',
+      variant: 'Product',
+      published: 'In the shop',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

The audit log's names for the fields the 26g.3 services write (`snapshot()` in `settings.service.ts` and
`listings.service.ts`, and the categories' `position` and `parent`). A field with no word would show its raw name
("priceOverride"); the page falls back to it, so a missing word is ugly but not an error. Fields that already had a
word (`name`, `address`, `parent`, `sale`) keep it: one word per field name across the whole log. `slug` changes for
decision 36.

### `locales/bn.ts`

```diff
@@ -130,6 +130,10 @@ export const bn: Messages = {
     posShifts: 'POS শিফট',
     cashReasons: 'POS ক্যাশের কারণ',
     posReturns: 'POS ফেরত',
+    storefront: 'স্টোরফ্রন্ট',
+    storefrontCatalog: 'ক্যাটালগ',
+    storefrontCategories: 'শপের ক্যাটাগরি',
+    storefrontSettings: 'শপের সেটিংস',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -4866,6 +4870,294 @@ export const bn: Messages = {
       'কাউন্টার যা ফেরত নেয়, তার ডিভাইস সিঙ্ক হলে এখানে দেখা যায়: ভুল সাইজের শার্ট, না মেলা ফোন কভার।',
     loadFailed: 'POS ফেরতের তালিকা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  storefront: {
+    changesSoon: 'পরিবর্তন এক মিনিটের মধ্যে শপে দেখা যায়',
+    viewShop: 'শপ দেখুন',
+    needsConnection: 'শপের মেনু সার্ভারে চলে। ব্যবহার করতে ইন্টারনেটে যুক্ত হন।',
+    statuses: { published: 'শপে আছে', draft: 'ড্রাফট' },
+    badges: { most_picked: 'সবচেয়ে জনপ্রিয়', new: 'নতুন', buy_one_get_one: '১টি কিনলে ১টি ফ্রি' },
+    payments: { cod: 'ক্যাশ অন ডেলিভারি', online: 'মোবাইল ব্যাংকিং' },
+    moveUp: 'উপরে সরান',
+    moveDown: 'নিচে সরান',
+    unsaved: 'পরিবর্তন এখনো সেভ হয়নি',
+    discard: 'পরিবর্তন বাদ দিন',
+    settings: {
+      title: 'শপের সেটিংস',
+      description: 'আপনার অনলাইন শপের ঠিকানা, যোগাযোগ, ডেলিভারি আর পেমেন্ট',
+      notSetUp:
+        'শপ এখনো সেট আপ হয়নি। নিচের তথ্যগুলো আপনার কোম্পানি থেকে নেওয়া, দেখে নিয়ে সেভ করুন। আপনি "শপ খুলুন" বাছাই না করা পর্যন্ত শপ খুলবে না।',
+      statusNotOpen: 'এখনো খোলা হয়নি',
+      statusOpen: 'খোলা',
+      addressTitle: 'নাম আর ঠিকানা',
+      subdomain: 'শপের ঠিকানা',
+      subdomainHint:
+        'ছোট হাতের ইংরেজি অক্ষর, সংখ্যা আর একটা করে হাইফেন। ক্রেতারা এটা লিখে আপনার শপে আসেন।',
+      subdomainLiveHint: 'শপ এই ঠিকানায় খোলা আছে। বদলালে এর লিংকগুলো আর কাজ করবে না।',
+      name: 'শপের নাম',
+      nameHint: 'শপের হেডারে আর ব্রাউজারের ট্যাবে দেখা যায়। আইনি নাম থেকে আলাদা হতে পারে।',
+      language: 'শপের ভাষা',
+      languageHint: 'শপের পেজ আর মেসেজ এই ভাষায় থাকে।',
+      contactTitle: 'যোগাযোগ',
+      contactHint: 'ক্রেতারা এগুলো প্রতিটা পেজে দেখেন।',
+      hotline: 'হটলাইন',
+      hotlinePlaceholder: '09612-345678',
+      hotlineHint: 'প্রতিটা প্রোডাক্ট পেজে, "হটলাইন:"-এর পাশে।',
+      address: 'ঠিকানা',
+      addressPlaceholder: 'বাড়ি ১২, রোড ৫, ধানমন্ডি, ঢাকা ১২০৫',
+      addressHint: 'শপের ফুটারে।',
+      socialTitle: 'সোশ্যাল পেজ',
+      socialHint: 'https:// দিয়ে শুরু পুরো লিংক। ফাঁকা থাকলে ফুটারে তার আইকন থাকে না।',
+      facebookUrl: 'Facebook',
+      instagramUrl: 'Instagram',
+      xUrl: 'X',
+      linkedinUrl: 'LinkedIn',
+      facebookPlaceholder: 'https://facebook.com/nirvorpharmacy',
+      instagramPlaceholder: 'https://instagram.com/nirvorpharmacy',
+      xPlaceholder: 'https://x.com/nirvorpharmacy',
+      linkedinPlaceholder: 'https://linkedin.com/company/nirvor',
+      deliveryTitle: 'স্টক আর ডেলিভারি',
+      warehouse: 'শপের গুদাম',
+      warehousePlaceholder: 'একটা গুদাম বাছুন',
+      warehouseHint: 'শপ এই গুদাম দেখে "স্টকে আছে" বা "স্টক নেই" বলে।',
+      zones: 'ডেলিভারির এলাকা',
+      zonesHint: 'কোথায় ডেলিভারি দেন আর কত খরচ, সর্বোচ্চ {{max}}টা। চেকআউটে ক্রেতা একটা বাছেন।',
+      zoneNumber: 'এলাকা {{number}}',
+      zoneName: 'এলাকা',
+      zoneNamePlaceholder: 'ঢাকার ভেতরে',
+      zoneCharge: 'চার্জ',
+      zoneChargeHint: '৳০ মানে এই এলাকায় ফ্রি।',
+      addZone: 'এলাকা যোগ করুন',
+      removeZone: 'এলাকা {{number}} সরান',
+      noZones: 'এখনো কোনো ডেলিভারির এলাকা নেই। একটা যোগ করুন, যেমন ঢাকার ভেতরে ৳৮০।',
+      freeDeliveryFrom: 'ফ্রি ডেলিভারি যত থেকে',
+      freeDeliveryHint:
+        'এর সমান বা বেশি দামের অর্ডারে ডেলিভারি চার্জ লাগে না। ফাঁকা মানে কখনো ফ্রি না।',
+      minimumOrder: 'সর্বনিম্ন অর্ডার',
+      minimumOrderHint:
+        'কার্ট এই পরিমাণে না পৌঁছানো পর্যন্ত চেকআউট হয় না। ফাঁকা মানে কোনো সীমা নেই।',
+      paymentTitle: 'পেমেন্ট',
+      payments: 'পেমেন্টের উপায়',
+      paymentsHint: 'মোবাইল ব্যাংকিং মানে bKash বা Nagad, পার্সেল রওনা হওয়ার আগে পেমেন্ট।',
+      create: 'শপ সেট আপ করুন',
+      created: 'শপ সেট আপ হয়েছে। চেকলিস্ট শেষ হলে খুলুন।',
+      updated: 'শপের সেটিংস সেভ হয়েছে',
+      moveTitle: 'শপের ঠিকানা বদলাবেন?',
+      moveBody:
+        'সেভ করলেই {{from}} আর কাজ করবে না, Facebook-এ বা SMS-এ পাঠানো এর লিংকগুলোও না। ক্রেতাদের {{to}}-তে নিয়ে যাওয়ার কোনো ব্যবস্থা নেই।',
+      moveConfirm: 'ঠিকানা বদলান',
+      loadFailed: 'শপের সেটিংস আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    launch: {
+      title: 'শপ খুলুন',
+      description: 'ক্রেতারা অর্ডার দেওয়ার আগে তিনটা কাজ',
+      warehouse: 'শপ যে গুদাম থেকে বিক্রি করবে, সেটা বাছুন',
+      zone: 'অন্তত একটা ডেলিভারির এলাকা যোগ করুন',
+      listing: 'ছবি আর দামসহ অন্তত একটা লিস্টিং শপে দেখান',
+      goToCatalog: 'ক্যাটালগে যান',
+      done: 'হয়েছে',
+      notDone: 'এখনো হয়নি',
+      saveFirst: 'আগে সেটিংস সেভ করুন। চেকলিস্ট সেভ করা তথ্য দেখে।',
+      open: 'শপ খুলুন',
+      confirmTitle: '{{name}} খুলবেন?',
+      confirmBody:
+        '{{url}} চালু হয়ে যাবে, আর যে কেউ আপনার লিস্টিং দেখতে ও অর্ডার দিতে পারবেন। শপ আর বন্ধ করা যায় না, তবে লিস্টিং শপ থেকে সরানো যায়।',
+      opened: '{{name}} খোলা হয়েছে',
+      openTitle: 'শপ খোলা আছে',
+      openSince: '{{date}} থেকে {{url}}-এ খোলা',
+    },
+    categories: {
+      title: 'শপের ক্যাটাগরি',
+      description: 'শপ তার লিস্টিংগুলো যেভাবে সাজায়, মেনুতে যে ক্রমে দেখায়',
+      add: 'ক্যাটাগরি যোগ করুন',
+      addTo: '{{name}}-এর ভেতরে ক্যাটাগরি যোগ করুন',
+      newTitle: 'শপের ক্যাটাগরি যোগ করুন',
+      editTitle: '{{name}} বদলান',
+      parent: 'যার ভেতরে',
+      topLevel: 'সবার উপরে',
+      name: 'নাম',
+      namePlaceholder: 'ত্বকের যত্ন',
+      slug: 'লিংকের নাম',
+      slugHint: 'শপের ঠিকানায়: /c/{{slug}}। ফাঁকা রাখলে নাম থেকে তৈরি হয়।',
+      slugChangeHint: 'লিংকের নাম বদলালে এই ক্যাটাগরির পুরনো লিংকগুলো আর কাজ করবে না।',
+      listingCount_one: '{{formatted}}টা লিস্টিং',
+      listingCount_other: '{{formatted}}টা লিস্টিং',
+      moveUpLabel: '{{name}} উপরে সরান',
+      moveDownLabel: '{{name}} নিচে সরান',
+      edit: 'বদলান',
+      delete: 'মুছুন',
+      created: '{{name}} যোগ হয়েছে',
+      updated: '{{name}} সেভ হয়েছে',
+      confirmDelete: '{{name}} মুছবেন?',
+      deleteWarning:
+        'যে ক্যাটাগরিতে কোনো লিস্টিং বা ভেতরে কোনো ক্যাটাগরি নেই, শুধু সেটাই মোছা যায়।',
+      actions: '{{name}}-এর কাজ',
+      searchLabel: 'শপের ক্যাটাগরি খুঁজুন',
+      searchPlaceholder: 'নাম বা লিংকের নাম',
+      noMatchTitle: 'কোনো শপ ক্যাটাগরি মেলেনি',
+      noMatchBody: 'বানান দেখুন, বা খোঁজা মুছে দিন।',
+      deleted: '{{name}} মোছা হয়েছে',
+      expand: '{{name}}-এর ক্যাটাগরিগুলো দেখান',
+      collapse: '{{name}}-এর ক্যাটাগরিগুলো লুকান',
+      emptyTitle: 'এখনো শপের কোনো ক্যাটাগরি নেই',
+      emptyBody:
+        'ক্রেতারা যে দলগুলো খোঁজেন সেগুলো যোগ করুন, যেমন ত্বকের যত্ন, শিশুর যত্ন, ডায়াবেটিক কর্নার, তারপর তাতে লিস্টিং রাখুন।',
+      loadFailed: 'শপের ক্যাটাগরি আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    catalog: {
+      title: 'ক্যাটালগ',
+      description: 'আপনার শপ যে প্রোডাক্টগুলো দেখায়, শপের দাম আর ছবিসহ',
+      add: 'শপে যোগ করুন',
+      searchLabel: 'ক্যাটালগে খুঁজুন',
+      searchPlaceholder: 'নাম বা SKU',
+      status: 'দেখান',
+      statuses: { all: 'সব', published: 'শপে আছে', draft: 'ড্রাফট' },
+      category: 'ক্যাটাগরি',
+      allCategories: 'সব ক্যাটাগরি',
+      columns: {
+        listing: 'লিস্টিং',
+        category: 'ক্যাটাগরি',
+        price: 'শপের দাম',
+        stock: 'স্টক',
+        status: 'অবস্থা',
+        updated: 'বদলানো',
+      },
+      subline: '{{sku}} · {{packSize}}',
+      noPhoto: 'ছবি নেই',
+      noPrice: 'দাম নেই',
+      inStock: 'স্টকে আছে',
+      outOfStock: 'স্টক নেই',
+      noWarehouse: 'গুদাম নেই',
+      notSetUpTitle: 'আগে শপ সেট আপ করুন',
+      notSetUpBody:
+        'শপের ঠিকানা, যোগাযোগ আর ডেলিভারির তথ্য সেভ করুন, তারপর তাতে প্রোডাক্ট যোগ করুন।',
+      goToSettings: 'শপের সেটিংসে যান',
+      emptyTitle: 'শপে এখনো কিছু নেই',
+      emptyBody:
+        'নিম ফেস ওয়াশ বা নাপা ৫০০ mg ট্যাবলেটের মতো প্রোডাক্ট যোগ করুন, প্রতিটায় ছবি আর দাম দিন, তারপর শপে দেখান।',
+      noMatchTitle: 'কোনো লিস্টিং মেলেনি',
+      noMatchBody: 'বানানটা দেখুন, বা ফিল্টারগুলো তুলে দিন।',
+      clearFilters: 'ফিল্টার তুলে দিন',
+      loadFailed: 'ক্যাটালগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    add: {
+      title: 'শপে একটা প্রোডাক্ট যোগ করুন',
+      description: 'এটা ড্রাফট হিসেবে শুরু হয়। ছবি দিন আর দাম দেখে নিন, তারপর শপে দেখান।',
+      product: 'প্রোডাক্ট',
+      productPlaceholder: 'একটা প্রোডাক্ট বাছুন',
+      searchLabel: 'প্রোডাক্ট খুঁজুন',
+      searching: 'খোঁজা হচ্ছে…',
+      noMatch: 'যোগ করার মতো কোনো প্রোডাক্ট মেলেনি। যেগুলো শপে আছে, সেগুলো তালিকায় নেই।',
+      detail: '{{sku}} · {{price}}',
+      category: 'শপের ক্যাটাগরি',
+      categoryPlaceholder: 'একটা ক্যাটাগরি বাছুন',
+      noCategories: 'শপে এখনো কোনো ক্যাটাগরি নেই।',
+      addCategories: 'ক্যাটাগরি যোগ করুন',
+      submit: 'শপে যোগ করুন',
+      added: '{{name}} ড্রাফট হিসেবে যোগ হয়েছে',
+    },
+    listing: {
+      back: 'ক্যাটালগ',
+      fromProduct: '{{name}} · {{sku}} বিক্রি করে',
+      publish: 'শপে দেখান',
+      unpublish: 'শপ থেকে সরান',
+      published: '{{name}} শপে আছে',
+      unpublished: '{{name}} আবার ড্রাফট',
+      saveFirst: 'আগে পরিবর্তনগুলো সেভ করুন, তারপর শপে দেখান।',
+      viewInShop: 'শপে দেখুন',
+      moreActions: 'আরও কাজ',
+      delete: 'লিস্টিং মুছুন',
+      confirmDelete: '{{name}} মুছবেন?',
+      deleteBody:
+        'এটা শপ থেকে চলে যাবে, আর এর ছবি ও বর্ণনা মুছে যাবে। প্রোডাক্ট আর তার স্টক Omnivo-তে থাকবে।',
+      deleted: '{{name}} মোছা হয়েছে',
+      updated: '{{name}}-এর পরিবর্তন সেভ হয়েছে',
+      draftNotice: 'এই লিস্টিং ড্রাফট, তাই শপ এটা দেখায় না।',
+      archivedNotice:
+        '{{name}} Products-এ আর্কাইভ করা, তাই শপ এই লিস্টিং লুকিয়ে রাখে। আবার বিক্রি করতে প্রোডাক্টটা ফিরিয়ে আনুন।',
+      inStock: '{{warehouse}}-এ স্টকে আছে',
+      outOfStock: '{{warehouse}}-এ স্টক নেই',
+      noWarehouse: 'শপের এখনো কোনো গুদাম নেই, তাই স্টক দেখায় না।',
+      basicsTitle: 'মূল তথ্য',
+      name: 'শপে নাম',
+      nameHint: 'Omnivo-তে প্রোডাক্টের নাম যেমন আছে তেমনই থাকে।',
+      slug: 'লিংকের নাম',
+      slugHint: 'ঠিকানায়: /p/{{slug}}। ফাঁকা রাখলে নাম থেকে তৈরি হয়।',
+      slugChangeHint: 'লিংকের নাম বদলালে এই লিস্টিংয়ের পুরনো লিংকগুলো আর কাজ করবে না।',
+      packSize: 'প্যাকের সাইজ',
+      packSizePlaceholder: '150 ml',
+      packSizeHint: 'শপের কার্ডে নামের নিচে।',
+      category: 'শপের ক্যাটাগরি',
+      badges: 'ব্যাজ',
+      badgesHint: 'শপে ছবির কোণে দেখা যায়।',
+      photosTitle: 'ছবি',
+      photosHint:
+        'সর্বোচ্চ {{max}}টা। প্রথমটা শপের কার্ডে থাকে। JPEG, PNG বা WebP, ৮ MB-র কম, প্রতিটা দিকে অন্তত ২০০ পিক্সেল।',
+      addPhoto: 'ছবি যোগ করুন',
+      photoNumber: 'ছবি {{number}}',
+      uploading: 'আপলোড হচ্ছে…',
+      preparing: 'ছবি তৈরি হচ্ছে…',
+      alt: 'ছবিতে কী আছে',
+      altPlaceholder: 'নিম ফেস ওয়াশ, 150 ml টিউব',
+      altHint: 'যে ক্রেতারা ছবি দেখতে পান না, তাঁদের এটা পড়ে শোনানো হয়।',
+      removePhoto: 'ছবি {{number}} সরান',
+      movePhotoUp: 'ছবি {{number}} আগে আনুন',
+      movePhotoDown: 'ছবি {{number}} পরে নিন',
+      noPhotos: 'এখনো ছবি নেই। অন্তত একটা ছবি থাকলেই শপ লিস্টিং দেখায়।',
+      firstPhoto: 'শপের কার্ডে এটাই',
+      photosLeft_one: 'আরও {{formatted}}টা যোগ করা যায়',
+      photosLeft_other: 'আরও {{formatted}}টা যোগ করা যায়',
+      dropPhoto: 'বাদ দিন',
+      priceTitle: 'দাম আর অফার',
+      price: 'শপের দাম',
+      priceHint: 'ফাঁকা রাখলে প্রোডাক্টের বিক্রয়মূল্য {{price}} লাগে।',
+      priceHintNone: 'Omnivo-তে প্রোডাক্টের কোনো বিক্রয়মূল্য নেই, তাই এখানে দাম লিখুন।',
+      sale: 'অফার',
+      saleKinds: {
+        none: 'অফার নেই',
+        percent: 'শতাংশ ছাড়',
+        amount: 'টাকা ছাড়',
+        price: 'অফারের দাম',
+      },
+      saleValues: { percent: 'শতাংশ ছাড় (১ থেকে ৯৯)', amount: 'কত টাকা ছাড়', price: 'অফারে দাম' },
+      percentPlaceholder: '10',
+      saleFrom: 'শুরু',
+      saleUntil: 'শেষ',
+      saleDatesHint:
+        'ওয়ার্কস্পেসের টাইম জোনে পুরো দিন, শেষ দিনসহ। শুরু ফাঁকা মানে এখনই; শেষ ফাঁকা মানে কোনো শেষ নেই।',
+      preview: 'এখন শপে',
+      previewNoPrice: 'এখনো দাম নেই। শপের দাম লিখুন।',
+      ribbonAmount: '{{amount}} ছাড়',
+      ribbonPercent: '{{percent}}% ছাড়',
+      previewUntil: 'অফার {{date}} পর্যন্ত।',
+      previewLater: 'অফার {{date}} থেকে শুরু।',
+      previewEnded: 'অফার {{date}}-এ শেষ হয়েছে।',
+      descriptionTitle: 'বর্ণনা',
+      descriptionHint: 'প্রোডাক্ট পেজে ছবির নিচের অংশগুলো, যেমন উপকারিতা আর ব্যবহারের নিয়ম।',
+      sectionNumber: 'অংশ {{number}}',
+      heading: 'শিরোনাম',
+      headingPlaceholder: 'উপকারিতা',
+      body: 'লেখা',
+      bodyPlaceholder: '- ব্রণ দূর করে\n- প্রতিদিন ব্যবহারের মতো কোমল',
+      bodyHint:
+        'ফাঁকা লাইন দিলে নতুন অনুচ্ছেদ। - দিয়ে শুরু লাইনগুলো তালিকা হয়, আর 1. দিয়ে শুরু হলে নম্বরসহ তালিকা। **বোল্ড** আর [লিংক](https://…)-ও চলে।',
+      addSection: 'অংশ যোগ করুন',
+      removeSection: 'অংশ {{number}} সরান',
+      moveSectionUp: 'অংশ {{number}} উপরে সরান',
+      moveSectionDown: 'অংশ {{number}} নিচে সরান',
+      noSections: 'বর্ণনা নেই। তখন প্রোডাক্ট পেজে শুধু ছবি আর দাম থাকে।',
+      showPreview: 'প্রিভিউ',
+      hidePreview: 'প্রিভিউ লুকান',
+      previewCaption: 'পণ্যের পেজে যেমন দেখাবে',
+      seoTitle: 'সার্চ ইঞ্জিন',
+      seoHint:
+        'Google আর Facebook এই পেজের জন্য যা দেখায়। ফাঁকা বক্সে লিস্টিংয়ের নিজের লেখা বসে।',
+      seoPageTitle: 'পেজের শিরোনাম',
+      seoPageDescription: 'পেজের বর্ণনা',
+      seoCount: '{{max}}টার মধ্যে {{count}}টা অক্ষর',
+      notFound: 'এই লিস্টিং নেই।',
+      loadFailed: 'লিস্টিং আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+  },
   approvals: {
     title: 'অনুমোদন',
     description: 'যে ডকুমেন্টগুলো আপনার সিদ্ধান্তের অপেক্ষায়, সবচেয়ে পুরনোটা আগে',
@@ -5804,7 +6096,7 @@ export const bn: Messages = {
     },
     fields: {
       name: 'নাম',
-      slug: 'ওয়ার্কস্পেসের ঠিকানা',
+      slug: 'ওয়েব ঠিকানা',
       companyName: 'কোম্পানির নাম',
       legalName: 'আইনি নাম',
       bin: 'BIN',
@@ -5978,6 +6270,30 @@ export const bn: Messages = {
       dayOfMonth: 'মাসের তারিখ',
       recipients: 'যাঁদের যায়',
       pausedReason: 'কেন থামল',
+      subdomain: 'শপের ঠিকানা',
+      language: 'ভাষা',
+      hotline: 'হটলাইন',
+      facebookUrl: 'Facebook',
+      instagramUrl: 'Instagram',
+      xUrl: 'X',
+      linkedinUrl: 'LinkedIn',
+      defaultWarehouseId: 'শপের গুদাম',
+      deliveryZones: 'ডেলিভারির এলাকা',
+      freeDeliveryFrom: 'ফ্রি ডেলিভারি যত থেকে',
+      minimumOrder: 'সর্বনিম্ন অর্ডার',
+      paymentMethods: 'পেমেন্টের উপায়',
+      launched: 'খোলা',
+      position: 'তালিকায় জায়গা',
+      packSize: 'প্যাকের সাইজ',
+      categoryId: 'শপের ক্যাটাগরি',
+      priceOverride: 'শপের দাম',
+      badges: 'ব্যাজ',
+      images: 'ছবি',
+      sections: 'বর্ণনার অংশ',
+      seoTitle: 'পেজের শিরোনাম',
+      seoDescription: 'পেজের বর্ণনা',
+      variant: 'প্রোডাক্ট',
+      published: 'শপে আছে',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -6793,7 +7109,7 @@ export const bn: Messages = {
     storefront_slug_taken: 'শপের আরেকটা জিনিসের এই লিংকের নাম আছে। একটু বদলে দিন।',
     storefront_zone_name_taken: 'দুইটা এলাকার একই নাম। প্রতিটা এলাকার আলাদা নাম দিন।',
     storefront_payment_required: 'অন্তত একটা পেমেন্টের উপায়ে টিক দিন।',
-    storefront_warehouse_invalid: 'তালিকা থেকে একটা চালু ওয়্যারহাউস বাছুন।',
+    storefront_warehouse_invalid: 'তালিকা থেকে একটা চালু গুদাম বাছুন।',
     storefront_not_set_up: 'শপ এখনো সেট আপ হয়নি। আগে এর সেটিংস সেভ করুন।',
     storefront_set_up_already:
       'অন্য ট্যাবে বা অন্য কেউ শপটা সেট আপ করে ফেলেছেন। দেখতে পেজটা রিলোড করুন।',
```

The same keys in Bangla; the type check fails if one is missing. Some choices:

- **The terms the app already uses**: গুদাম for warehouse (and 26g.1's `storefront_warehouse_invalid` changes from
  ওয়্যারহাউস to গুদাম, the last hunk, so the error matches the box it is about), ড্রাফট, লিস্টিং, ক্যাটাগরি, SKU.
- **The shop's own Bangla** for the badges and the payment methods (`১টি কিনলে ১টি ফ্রি`, `ক্যাশ অন ডেলিভারি`), copied
  from `shop/bn.ts` for the same reason as in English.
- **What is typed stays in English letters**: the phone and the link placeholders, `150 ml`, `10`, `/c/{{slug}}`.
  Those are values the boxes take, and the money and number boxes always show ASCII digits (CLAUDE.md → Money
  input). Numbers inside sentences are Bangla (৮ MB, ২০০ পিক্সেল, ৳৮০).
- **`saleFrom` / `saleUntil` are শুরু / শেষ**: "From" and "Until" read naturally in English above two dates; in
  Bangla the nouns read better.

### Check this part

```bash
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm --filter @omnivo/app typecheck        # nothing uses the new words yet, and nothing breaks
```

## 26g.6 — `apps/app`: the Storefront screens

This part adds the four pages of the Storefront menu: **Catalog** (`/storefront/listings`), a **listing's editor**
(`/storefront/listings/$listingId`), **Shop categories** (`/storefront/categories`) and **Shop settings**
(`/storefront/settings`), and the sidebar group that leads to them. They follow the mockup you approved (16 screens,
HTML and PNG, kept outside the repo; decision 6). Nothing in the API or the database changes.

Decisions made while building the pages (mine, except 46):

38. **A few more words than 26g.5 had.** The mockup added four, which you approved: the first photo's tag ("On the
    shop’s card"), what the Add tile says under it ("1 more can be added"), the preview's caption ("As the product
    page shows it") and the save bar. The save bar says the same thing on both forms ("Changes not saved yet" and
    "Discard changes"); the mockup's "You changed the description." would need a sentence per card. The pages also
    needed a label for the category row's menu and the editor's menu, the categories' search box and its empty
    result, and "Remove it" under a photo the job could not use. They are in 26g.5's diff above (marked "26g.6"),
    because that diff runs to the end of the step.
39. **The listing form holds the sale as the person sees it** (a kind, a value and two days), and one schema turns
    it into the API's body (`listingFormSchema`). The API's own schema still checks everything: the form schema is a
    transform followed by `.pipe(updateStorefrontListingInputSchema)`, so there is no second copy of the rules.
40. **Save waits until every photo is ready.** The API refuses a photo whose sizes are not made yet
    (`storefront_image_not_ready`), so the save bar's button is disabled while a photo uploads or is prepared, and a
    photo the job could not use must be removed first.
41. **Publishing and opening the shop wait for a saved form.** Both act on what the server has. With unsaved
    changes, "Show in the shop" and "Open the shop" are disabled and a line says to save first.
42. **The catalog sorts by name, both ways, or by the newest change** (the contract's three sorts). The category
    filter shows that category only, not the ones under it (the contract), because the table shows each listing's
    own category.
43. **A shop price shows its paisa only when it has some** ("৳229", "৳247.50"), like the counter. Lists of money
    elsewhere show whole taka, but a shop price is a unit price the owner typed, and rounding it would hide a typo.
44. **The settings form starts again after every new version** (a React `key` on the version). The launch changes
    the shop's version on the server; without the new key, the next save would send the old one and fail with a
    version conflict.
45. **The description's preview is the shop's own HTML.** `renderSections` (26f) makes it, and it escapes every
    character the owner typed before it adds its few tags. The preview puts that HTML into the page with
    `dangerouslySetInnerHTML`, the first place the app does so; the comment there says why it is safe.
46. **Bundle budgets (you chose):** the first load 240 KB (26g.5's words and the sidebar group took it to 237.2 KB)
    and a lazy page 150 KB (the listing editor is 145.9 KB). Loading the photo and description cards on their own
    saved only 4 KB, so the editor stays one chunk.

### `lib/storefront.ts`: the reads, the form values and the upload

```ts
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
```

The menu's reads, in their own file like `pos-queries.ts`: only the four storefront pages load them, so
`queries.ts`, which almost every page loads, does not grow.

- Every key starts with `['storefront', tenantId]`. A save then refreshes the whole menu with one
  `invalidateQueries` (see `useStorefrontRefresh` below), which matters because one change shows in several places:
  a published listing ticks the launch checklist, and a new category changes the catalog's filter.
- The catalog's query puts the whole filter object in its key, so each search, status and category has its own
  pages, and `keepPreviousData` keeps the old rows on the screen until the new first page comes. Without it, every
  key press in the search box would flash an empty table.
- Empty values are left out of the query (`...(filter.search !== '' && { search })`): the contract's `search` is
  optional, and an empty `search=` would be a search for nothing.
- The candidates' search asks for 20 at a time. The box shows matches as the person types; a long list would only
  be scrolled past.

```ts
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
```

The categories' helpers.

- `storefrontCategoryTree` sorts by `position`, not by name like the product categories: the shop's menu shows the
  categories in the owner's order, and the page must show the same order, or Move up would seem to do nothing.
- `storefrontCategoryOptions` shows the whole path ("Skin care › Face wash"). Two categories can have the same name
  under different parents ("Others"), and a select that shows only "Others" twice cannot be used. `moving` leaves out
  a category and everything under it, so the edit dialog never offers to put a category inside itself (the API would
  refuse it with `category_parent_invalid`).
- `siblingPlace` disables Move up on the first sibling and Move down on the last. The API would answer "nothing to
  swap"; a disabled button says it before the click.

```ts
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
    version: shop.version,
  };
}

// The API keeps money with 4 decimals ("80.0000"); a box shows what a person would type ("80",
// "80.50"). Not rounding: only zeros at the end go
export function plainAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}
```

The settings form's values.

- Before the first save there is no shop (`setup.shop === null`), so the form starts from what the API suggests: the
  workspace's slug, name, phone and address (decision 10). It also starts with one empty delivery zone, because no
  shop opens without one and an empty row shows what to type, and with Cash on Delivery ticked, because a shop needs
  at least one way to pay (`storefront_payment_required`).
- `version: 1` for a new shop only passes the update schema. The page leaves it out of the create body.
- Every `null` becomes `''`, because a text box cannot hold `null`; the schemas turn `''` back into `null`.
- `plainAmount` shows money the way a person types it. The API keeps 4 decimals ("80.0000"); a box that shows
  "80.0000" looks wrong, and saving it unchanged would still be the same amount. Only zeros at the end go, so nothing
  is rounded.

```ts
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
```

The sale's days (decision 34). The API stores two moments, and the sale stops *at* `endsAt`. The owner thinks in
days: "from the 20th until the 30th". So the form holds two ISO dates, and these functions turn them into moments in
the **workspace's** time zone, not the browser's: a manager in another country must still set a sale that ends at
midnight in Dhaka.

- `offsetAt` asks `Intl.DateTimeFormat` what the wall clock shows in the time zone at one moment, and subtracts the
  moment itself. JavaScript has no "offset of a time zone" function, and this works for every zone the browser knows.
- `startOfDayIn` takes midnight as if it were UTC, then subtracts the offset. It does that twice: on a day the clock
  moves (summer time), the offset at the first guess can differ from the offset at the answer. Bangladesh has no
  summer time, but a workspace may use any zone, and the spec tests a London clock change.
- `saleFromForm` sends "Until 30 Nov" as the first moment of 1 Dec (`shiftIsoDate(…, 1)`), so the whole last day
  counts. `saleToForm` goes back by one millisecond before it takes the day, so the box shows 30 Nov again, not 1 Dec.
- The form's sale has a fourth kind, `none`. A select needs a value for "No sale"; the API's `sale` is `null` then.
- The form's fields are named `startsAt` and `endsAt` like the API's on purpose: the schema's error for an end before
  the start has the path `sale.endsAt`, so it lands on the Until box without any renaming.

```ts
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
```

The listing form (decision 39).

- `listingFormSchema` is built from the update schema's own fields (`updateStorefrontListingInputSchema.in.shape`),
  with the sale replaced by the form's shape. `.in` is the object inside the schema's pipe (its transform makes the
  slug from the name). `.extend()` cannot be used: zod refuses to extend an object that has a refinement, and the
  slug check is one. Building a new object from `shape` copies the fields only.
- The `.transform` turns the form's sale into the API's, and `.pipe(updateStorefrontListingInputSchema)` then runs
  the real schema on the result: the slug, the sale's value and dates, the photos. Its error paths (`sale.value`,
  `sale.endsAt`, `images.0.alt`) are the form's field names, so each error shows under its box. The output type is
  the API body (`UpdateStorefrontListingInput`), so `handleSubmit` hands the page exactly what `call()` takes.
- `listingFormValues` keeps only `{id, alt}` per photo, the shape the API saves. The photo's address lives beside
  the form (the page's photo states), because it is not part of what is saved.
- `pricePreview` is what "In the shop now" shows, worked out by the shop's own function (`listingPricing`), so the
  preview and the shop can never disagree. The regular price is the box's price when it is a usable amount, else the
  product's. A sale the form cannot read yet (a half-typed percent) is left out instead of breaking the preview.
  `sale: 'later' | 'ended'` says why a sale with dates is not on now, so the card can say "The sale starts on …"
  instead of silently showing the full price.

```ts
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
```

The photo upload (decision 2).

- `PhotoState` is what a slot shows: uploading, processing ("Preparing the photo…"), ready (with the small file's
  address) or failed (with the error code to show). It is the contract's `StorefrontUpload` plus one more failure the
  browser can have: the file never reached storage (`upload_incomplete`).
- `checkPhotoFile` checks the file's type and size with the contract's schema before anything is sent, so a 30 MB
  photo or a PDF is refused at once, with the same words the API would use.
- `uploadShopPhoto` has the logo's three steps (ask for an address, send the file straight to storage, confirm).
  `onTicket` gives the page the photo's id as soon as the API answers, so the slot appears and says "Uploading…"
  while the file travels; on a slow phone network that can take a while. The storage `fetch` is not `call()`: it is
  not our API, and the signed headers must go exactly as given.
- `photoState` turns the API's answer into a `PhotoState` with a `switch` over the union. TypeScript checks that
  every status is handled; a new status in the contract would fail the type check here.

### `lib/storefront.spec.ts`

```ts
import type { StorefrontCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  listingFormSchema,
  plainAmount,
  pricePreview,
  type SaleForm,
  saleFromForm,
  saleToForm,
  siblingPlace,
  startOfDayIn,
  storefrontCategoryOptions,
} from './storefront';

const DHAKA = 'Asia/Dhaka';
const NO_SALE: SaleForm = { kind: 'none', value: '', startsAt: '', endsAt: '' };

describe('startOfDayIn', () => {
  it('is local midnight as an instant', () => {
    expect(startOfDayIn('2026-11-30', DHAKA)).toBe('2026-11-29T18:00:00.000Z');
    expect(startOfDayIn('2026-11-30', 'UTC')).toBe('2026-11-30T00:00:00.000Z');
  });

  it('follows a clock change (London moves to summer time on 29 Mar 2026)', () => {
    expect(startOfDayIn('2026-03-29', 'Europe/London')).toBe('2026-03-29T00:00:00.000Z');
    expect(startOfDayIn('2026-03-30', 'Europe/London')).toBe('2026-03-29T23:00:00.000Z');
  });
});

describe('sale days (decision 34)', () => {
  it('sends Until as the start of the next day, so the last day counts', () => {
    const sale = saleFromForm(
      { kind: 'percent', value: '10', startsAt: '2026-11-20', endsAt: '2026-11-30' },
      DHAKA,
    );
    expect(sale).toEqual({
      kind: 'percent',
      value: '10',
      startsAt: '2026-11-19T18:00:00.000Z',
      endsAt: '2026-11-30T18:00:00.000Z',
    });
  });

  it('reads the same days back', () => {
    const form: SaleForm = { kind: 'amount', value: '20', startsAt: '', endsAt: '2026-11-30' };
    const sale = saleFromForm(form, DHAKA);
    expect(saleToForm(sale, DHAKA)).toEqual(form);
  });

  it('shows the API amount without its trailing zeros', () => {
    expect(
      saleToForm({ kind: 'price', value: '229.5000', startsAt: null, endsAt: null }, DHAKA),
    ).toEqual({ kind: 'price', value: '229.5', startsAt: '', endsAt: '' });
    expect(saleFromForm(NO_SALE, DHAKA)).toBeNull();
  });
});

describe('plainAmount', () => {
  it('drops only the zeros at the end', () => {
    expect(plainAmount('80.0000')).toBe('80');
    expect(plainAmount('80.5000')).toBe('80.5');
    expect(plainAmount('100')).toBe('100');
    expect(plainAmount('')).toBe('');
  });
});

describe('pricePreview', () => {
  const now = new Date('2026-11-16T06:00:00Z');

  it('uses the listing price, else the product price', () => {
    const own = pricePreview('255', '250.0000', NO_SALE, DHAKA, now);
    expect(own.kind === 'priced' && own.regular).toBe('255');
    const product = pricePreview('', '250.0000', NO_SALE, DHAKA, now);
    expect(product.kind === 'priced' && product.regular).toBe('250.0000');
    expect(pricePreview('', null, NO_SALE, DHAKA, now).kind).toBe('none');
  });

  it('says whether the sale is on, later or over', () => {
    const on = pricePreview('255', null, { ...NO_SALE, kind: 'percent', value: '10' }, DHAKA, now);
    expect(on.kind === 'priced' && on.sale).toBe('on');
    const later = pricePreview(
      '255',
      null,
      { kind: 'percent', value: '10', startsAt: '2026-12-01', endsAt: '' },
      DHAKA,
      now,
    );
    expect(later.kind === 'priced' && later.sale).toBe('later');
    const ended = pricePreview(
      '255',
      null,
      { kind: 'percent', value: '10', startsAt: '', endsAt: '2026-11-15' },
      DHAKA,
      now,
    );
    expect(ended.kind === 'priced' && ended.sale).toBe('ended');
  });

  it('leaves out a sale it cannot read yet', () => {
    const typing = pricePreview(
      '255',
      null,
      { ...NO_SALE, kind: 'percent', value: '' },
      DHAKA,
      now,
    );
    expect(typing.kind === 'priced' && typing.sale).toBe('none');
  });
});

describe('listingFormSchema', () => {
  const values = {
    version: 3,
    name: 'Neem Face Wash',
    slug: '',
    packSize: '150 ml',
    categoryId: '0195f0a0-0000-7000-8000-000000000001',
    priceOverride: '',
    sale: NO_SALE,
    badges: [],
    images: [],
    descriptionSections: [],
    seoTitle: '',
    seoDescription: '',
  };

  it('turns the form into the API body', () => {
    const parsed = listingFormSchema(DHAKA).safeParse({
      ...values,
      sale: { kind: 'percent', value: '10', startsAt: '', endsAt: '2026-11-30' },
    });
    expect(parsed.success && parsed.data).toMatchObject({
      slug: 'neem-face-wash',
      priceOverride: null,
      seoTitle: null,
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: '2026-11-30T18:00:00.000Z' },
    });
  });

  it("puts the sale's errors on the form's boxes", () => {
    const parsed = listingFormSchema(DHAKA).safeParse({
      ...values,
      sale: { kind: 'percent', value: '10', startsAt: '2026-11-30', endsAt: '2026-11-20' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['sale.endsAt']);
  });
});

describe('categories', () => {
  const at = (id: string, parentId: string | null, position: number, name: string) =>
    ({
      id,
      parentId,
      position,
      name,
      slug: name.toLowerCase(),
      listingCount: 0,
      version: 1,
      updatedAt: '2026-11-16T00:00:00.000Z',
    }) satisfies StorefrontCategory;
  const list = [
    at('b', null, 2, 'Hair'),
    at('a', null, 1, 'Skin'),
    at('c', 'a', 1, 'Face wash'),
    at('d', 'a', 2, 'Sunscreen'),
  ];

  it('keeps the shop order and shows the path', () => {
    expect(storefrontCategoryOptions(list).map((option) => option.label)).toEqual([
      'Skin',
      'Skin › Face wash',
      'Skin › Sunscreen',
      'Hair',
    ]);
    expect(storefrontCategoryOptions(list, 'a').map((option) => option.value)).toEqual(['b']);
  });

  it('knows the first and the last of the siblings', () => {
    const [hair, , faceWash] = list;
    if (!hair || !faceWash) throw new Error('the list has four categories');
    expect(siblingPlace(list, faceWash)).toEqual({ first: true, last: false });
    expect(siblingPlace(list, hair)).toEqual({ first: false, last: true });
  });
});
```

The helpers' tests, without a browser:

- Midnight in Dhaka is 18:00 UTC the day before, and a London clock change moves midnight by an hour.
- "Until 30 Nov" goes out as the start of 1 Dec and comes back as 30 Nov; amounts lose only their trailing zeros.
- The preview uses the listing's price before the product's, and says "on", "later" or "ended" for the sale.
- `listingFormSchema` makes the slug from the name, turns empty boxes into `null`, and puts an end before the start
  on `sale.endsAt` (one error, on the right box).
- The categories' select keeps the shop's order and leaves out a branch being moved; Move up and down know the ends.

### `components/storefront-parts.tsx`: what the four pages share

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  FileEditIcon,
  LinkSquare02Icon,
  Store04Icon,
  WifiDisconnected02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { StorefrontListingStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, cn, EmptyState, Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useTenantId } from '../lib/workspace';

// Step 26g: what the four Storefront pages share. Kept out of lib/storefront.ts so the lib (queries,
// form values) has no React and its spec runs without a DOM.

// After any save in the menu: every storefront read again (settings' checklist, the catalog, the
// categories' counts), because one change shows in several places
export function useStorefrontRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
    [queryClient, tenantId],
  );
}

// Decision 4: the shop's server keeps its answers for 30 seconds, so a save is not on the shop at
// once. Under every page's description, so nobody wonders why the shop still shows the old price
export function ShopLine() {
  const { t } = useLocale();
  return (
    <span className="mt-1.5 flex items-center gap-2 text-label text-ink-3">
      <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.5} />
      {t('storefront.changesSoon')}
    </span>
  );
}

// The shop in a new tab. A link that looks like the secondary button: it goes to another site, so
// it is an <a> (middle-click, "copy link"), never a button with window.open
const LINK_BUTTON =
  'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-4 text-body-sm font-medium whitespace-nowrap text-ink shadow-sm transition-colors duration-150 hover:bg-subtle';

export function ViewShopLink({
  href,
  label,
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  const { t } = useLocale();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(LINK_BUTTON, className)}>
      <HugeiconsIcon icon={LinkSquare02Icon} size={17} strokeWidth={1.5} />
      {label ?? t('storefront.viewShop')}
    </a>
  );
}

export function ListingStatusPill({ status }: { status: StorefrontListingStatus }) {
  const { t } = useLocale();
  return status === 'published' ? (
    <Pill tone="good" icon={Store04Icon}>
      {t('storefront.statuses.published')}
    </Pill>
  ) : (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('storefront.statuses.draft')}
    </Pill>
  );
}

// null: the shop has no warehouse yet, so nobody knows
export function StockPill({ inStock }: { inStock: boolean | null }) {
  const { t } = useLocale();
  if (inStock === null) {
    return <span className="text-ink-3">{t('storefront.catalog.noWarehouse')}</span>;
  }
  return inStock ? (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('storefront.catalog.inStock')}
    </Pill>
  ) : (
    <Pill tone="warn" icon={Alert02Icon}>
      {t('storefront.catalog.outOfStock')}
    </Pill>
  );
}

// Every page of the menu reads and writes on the server (decision 5: online only)
export function StorefrontOffline() {
  const { t } = useLocale();
  return (
    <EmptyState
      icon={WifiDisconnected02Icon}
      title={t('sync.needsConnectionTitle')}
      description={t('storefront.needsConnection')}
    />
  );
}

// A shop price the way the counter shows money: whole taka, or with paisa when it has some
// ("৳229", "৳247.50"), so a price typed with paisa never looks rounded
export function useShopMoney(): (value: string) => string {
  const { format } = useLocale();
  return useCallback(
    (value: string) => {
      const paisa = /\.(\d+)$/.exec(value)?.[1] ?? '';
      return format.money(value, { decimals: /[1-9]/.test(paisa) ? 2 : 0 });
    },
    [format],
  );
}

// The bar under a long form while it has changes: the buttons stay in reach wherever the person
// scrolled (the roles page's bar). Sticky, so it sits at the end of the form when that is in view
export function SaveBar({
  saving,
  onDiscard,
  formId,
  blocked = false,
}: {
  saving: boolean;
  onDiscard: () => void;
  formId: string;
  // Save waits (a photo still uploading or being prepared)
  blocked?: boolean;
}) {
  const { t } = useLocale();
  return (
    <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-card border border-line bg-surface px-5 py-3 shadow-md">
      <p className="mr-auto text-body-sm text-ink-2">{t('storefront.unsaved')}</p>
      <Button variant="secondary" disabled={saving} onClick={onDiscard}>
        {t('storefront.discard')}
      </Button>
      <Button type="submit" form={formId} disabled={saving || blocked}>
        {saving ? t('common.saving') : t('common.save')}
      </Button>
    </div>
  );
}
```

- `useStorefrontRefresh` invalidates every storefront read after a save (see the keys above).
- `ShopLine` is decision 4: under each page's description, "Changes show in the shop within a minute", because the
  shop keeps its answers for 30 seconds. Without it, an owner who saves a price and opens the shop would think the
  save failed.
- `ViewShopLink` is an `<a target="_blank">`, not a button that calls `window.open`: it goes to another site, so a
  middle-click, "Copy link" and the browser's own link hints must work. `rel="noopener noreferrer"` stops the shop's
  page from reaching back into the ERP tab.
- `StockPill` shows "No warehouse" for `null`. "Out of stock" would be a wrong answer: the shop has no warehouse yet,
  so nobody knows (26g.3).
- `useShopMoney` is decision 43.
- `SaveBar` is the roles page's bar: sticky at the bottom, so on a long form the buttons stay in reach. `blocked`
  disables Save while photos are not ready (decision 40); Discard still works, because throwing changes away needs no
  photo.

### `routes/storefront-settings.tsx`: the shop's settings and its launch

```tsx
import {
  Call02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Facebook01Icon,
  Globe02Icon,
  Instagram,
  LanguageSkillIcon,
  Linkedin01Icon,
  Location01Icon,
  NewTwitterIcon,
  PlusSignIcon,
  Rocket01Icon,
  Store01Icon,
  StoreVerified01Icon,
  Tick02Icon,
  WarehouseIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  SHOP_PAYMENT_METHODS,
  STOREFRONT_ZONES_MAX,
  type StorefrontSettings,
  type StorefrontSetup,
  todayIn,
  type UpdateStorefrontSettingsInput,
  updateStorefrontSettingsInputSchema,
} from '@omnivo/contracts';
import { LANGUAGES, useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  CheckboxGroup,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import {
  SaveBar,
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { warehousesQuery } from '../lib/queries';
import { settingsFormValues, storefrontSetupQuery } from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: the shop's settings (decision 1). Before the first save there is no shop: the form
// starts from the workspace's own details and its button says "Set up the shop" (POST). After it,
// the same form saves with the version (PUT). Beside it, the launch checklist until the shop is
// open, then the "The shop is open" card. Online only, like the whole menu.

type SettingsValues = ReturnType<typeof settingsFormValues>;

const FORM_ID = 'storefront-settings';
const TOP_FIELDS = updateStorefrontSettingsInputSchema.keyof().options;

// The API names a zone's box in its field errors ("deliveryZones.1.name"), so the form knows those
// paths too, for as many zones as there are
function fieldNames(zoneCount: number): Path<SettingsValues>[] {
  const zones = Array.from({ length: zoneCount }, (_, index) => [
    rowPath('deliveryZones', index, 'name'),
    rowPath('deliveryZones', index, 'charge'),
  ]).flat();
  return [...TOP_FIELDS, ...zones];
}
```

`fieldNames` lists every path an API field error may name, including each zone's two boxes
(`deliveryZones.1.name`). `applyApiError` places an error only on a path it knows; anything else shows at the top.
`rowPath` (from `lib/products.ts`) builds `deliveryZones.1.name` with the type react-hook-form wants: a plain
template string fails the lint rule on numbers in templates, and `String(index)` gives a type react-hook-form does
not accept. `rowPath` keeps the one cast for that in one place (CLAUDE.md rule 3).

```tsx
function SettingsForm({
  setup,
  onSaved,
  onDirtyChange,
}: {
  setup: StorefrontSetup;
  onSaved: (saved: StorefrontSettings) => void;
  // The checklist beside the form waits while the form has changes
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, language } = useLocale();
  const tenantId = useTenantId();
  const shop = setup.shop;
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const [moving, setMoving] = useState<UpdateStorefrontSettingsInput | null>(null);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(updateStorefrontSettingsInputSchema, { error: contractErrorMap }),
    defaultValues: settingsFormValues(setup, language),
  });
  const zones = useFieldArray({ control, name: 'deliveryZones' });
  const subdomain = watch('subdomain');
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  const save = async (values: UpdateStorefrontSettingsInput) => {
    try {
      // The first save makes the shop: the create body has no version (its schema has none)
      const { version, ...fields } = values;
      const saved = shop
        ? await call(routes.storefront.updateSettings, { body: { ...fields, version } })
        : await call(routes.storefront.createSettings, { body: fields });
      reset(settingsFormValues({ ...setup, shop: saved }, language));
      toast(t(shop ? 'storefront.settings.updated' : 'storefront.settings.created'));
      onSaved(saved);
    } catch (error) {
      applyApiError(error, fieldNames(values.deliveryZones.length), setError);
    }
  };

  // Decision 3: an open shop's new address breaks every link to the old one, so the save asks
  // first. The dialog holds the parsed values and saves them on "Change the address"
  const onSubmit = handleSubmit(async (values) => {
    if (shop?.launchedAt != null && values.subdomain !== shop.subdomain) {
      setMoving(values);
      return;
    }
    await save(values);
  });

  const serverError = errors.root?.server?.message;
  const warehouseOptions = [
    { value: '', label: t('storefront.settings.warehousePlaceholder') },
    ...(warehouses ?? []).map((warehouse) => ({
      value: warehouse.id,
      label: `${warehouse.code} · ${warehouse.name}`,
    })),
  ];
  const languageOptions = LANGUAGES.map((item) => ({ value: item.code, label: item.label }));
  const paymentOptions = SHOP_PAYMENT_METHODS.map((method) => ({
    value: method,
    label: t(`storefront.payments.${method}`),
  }));
```

The form's logic.

- One form for both cases: before the first save it posts to `createSettings` without the version (the create
  schema has none); after it, it puts to `updateSettings` with the version.
- After a save, `reset()` with the saved values makes the form clean again, with the new version, and `onSaved` puts
  the answer into the page's query cache, so the checklist beside the form updates without another request.
- `onDirtyChange` tells the page whether the form has changes, because the checklist beside it must wait for a save
  (decision 41).
- Decision 3: when the shop is open and the subdomain changed, the submit does not save. It keeps the checked values
  in `moving` and opens the dialog; "Change the address" saves them. The values are kept, not read again, so the
  dialog saves exactly what was checked.

```tsx
  return (
    <form id={FORM_ID} noValidate onSubmit={(event) => void onSubmit(event)} className="grid gap-5">
      {serverError && <FormAlert message={serverError} />}

      <Card>
        <CardHeader title={t('storefront.settings.addressTitle')} />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <div className="sm:col-span-2">
            <TextField
              label={t('storefront.settings.subdomain')}
              icon={Globe02Icon}
              suffix={`.${setup.baseDomain}`}
              autoComplete="off"
              spellCheck={false}
              hint={
                shop?.launchedAt != null
                  ? t('storefront.settings.subdomainLiveHint')
                  : t('storefront.settings.subdomainHint')
              }
              {...register('subdomain')}
              error={errors.subdomain?.message}
            />
          </div>
          <TextField
            label={t('storefront.settings.name')}
            icon={Store01Icon}
            hint={t('storefront.settings.nameHint')}
            {...register('name')}
            error={errors.name?.message}
          />
          <SelectField
            label={t('storefront.settings.language')}
            icon={LanguageSkillIcon}
            hint={t('storefront.settings.languageHint')}
            options={languageOptions}
            {...register('language')}
            error={errors.language?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t('storefront.settings.contactTitle')}
          subtitle={t('storefront.settings.contactHint')}
        />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('storefront.settings.hotline')}
            icon={Call02Icon}
            type="tel"
            placeholder={t('storefront.settings.hotlinePlaceholder')}
            hint={t('storefront.settings.hotlineHint')}
            {...register('hotline')}
            error={errors.hotline?.message}
          />
          <TextField
            label={t('storefront.settings.address')}
            icon={Location01Icon}
            placeholder={t('storefront.settings.addressPlaceholder')}
            hint={t('storefront.settings.addressHint')}
            {...register('address')}
            error={errors.address?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t('storefront.settings.socialTitle')}
          subtitle={t('storefront.settings.socialHint')}
        />
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          <TextField
            label={t('storefront.settings.facebookUrl')}
            icon={Facebook01Icon}
            optional
            type="url"
            placeholder={t('storefront.settings.facebookPlaceholder')}
            {...register('facebookUrl')}
            error={errors.facebookUrl?.message}
          />
          <TextField
            label={t('storefront.settings.instagramUrl')}
            icon={Instagram}
            optional
            type="url"
            placeholder={t('storefront.settings.instagramPlaceholder')}
            {...register('instagramUrl')}
            error={errors.instagramUrl?.message}
          />
          <TextField
            label={t('storefront.settings.xUrl')}
            icon={NewTwitterIcon}
            optional
            type="url"
            placeholder={t('storefront.settings.xPlaceholder')}
            {...register('xUrl')}
            error={errors.xUrl?.message}
          />
          <TextField
            label={t('storefront.settings.linkedinUrl')}
            icon={Linkedin01Icon}
            optional
            type="url"
            placeholder={t('storefront.settings.linkedinPlaceholder')}
            {...register('linkedinUrl')}
            error={errors.linkedinUrl?.message}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t('storefront.settings.deliveryTitle')} />
        <div className="grid gap-5 p-5">
          <SelectField
            label={t('storefront.settings.warehouse')}
            icon={WarehouseIcon}
            hint={t('storefront.settings.warehouseHint')}
            options={warehouseOptions}
            {...register('defaultWarehouseId')}
            error={errors.defaultWarehouseId?.message}
          />
          <fieldset className="grid min-w-0 gap-3">
            <legend className="mb-1.5 text-label font-medium text-ink">
              {t('storefront.settings.zones')}
            </legend>
            <p className="-mt-1.5 text-label text-ink-3">
              {t('storefront.settings.zonesHint', { max: STOREFRONT_ZONES_MAX })}
            </p>
            {zones.fields.length === 0 && (
              <p className="text-body-sm text-ink-2">{t('storefront.settings.noZones')}</p>
            )}
            {zones.fields.map((zone, index) => {
              const number = index + 1;
              return (
                <div
                  key={zone.id}
                  role="group"
                  aria-label={t('storefront.settings.zoneNumber', { number })}
                  // On a phone the remove button sits beside the name; from sm the three share a row
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 sm:grid-cols-[minmax(0,1fr)_180px_auto]"
                >
                  <TextField
                    label={t('storefront.settings.zoneName')}
                    placeholder={t('storefront.settings.zoneNamePlaceholder')}
                    {...register(rowPath('deliveryZones', index, 'name'))}
                    error={errors.deliveryZones?.[index]?.name?.message}
                  />
                  <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">
                    <FormField
                      control={control}
                      name={rowPath('deliveryZones', index, 'charge')}
                      label={t('storefront.settings.zoneCharge')}
                    >
                      {(field) => <MoneyInput {...field} />}
                    </FormField>
                  </div>
                  <IconButton
                    icon={Delete02Icon}
                    label={t('storefront.settings.removeZone', { number })}
                    // Lines the icon up with the boxes, under their labels
                    className="mt-[26px] sm:col-start-3"
                    onClick={() => {
                      zones.remove(index);
                    }}
                  />
                </div>
              );
            })}
            <p className="text-label text-ink-3">{t('storefront.settings.zoneChargeHint')}</p>
            {errors.deliveryZones?.root?.message !== undefined && (
              <FormAlert message={errors.deliveryZones.root.message} />
            )}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={zones.fields.length >= STOREFRONT_ZONES_MAX}
                onClick={() => {
                  zones.append({ id: null, name: '', charge: '' });
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.settings.addZone')}
              </Button>
            </div>
          </fieldset>
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
            <FormField
              control={control}
              name="freeDeliveryFrom"
              label={t('storefront.settings.freeDeliveryFrom')}
              optional
              hint={t('storefront.settings.freeDeliveryHint')}
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
            <FormField
              control={control}
              name="minimumOrder"
              label={t('storefront.settings.minimumOrder')}
              optional
              hint={t('storefront.settings.minimumOrderHint')}
            >
              {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
            </FormField>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('storefront.settings.paymentTitle')} />
        <div className="p-5">
          <Controller
            control={control}
            name="paymentMethods"
            render={({ field }) => (
              <CheckboxGroup
                legend={t('storefront.settings.payments')}
                options={paymentOptions}
                value={field.value}
                onChange={(next) => {
                  field.onChange(next);
                }}
                hint={t('storefront.settings.paymentsHint')}
                error={errors.paymentMethods?.message}
              />
            )}
          />
        </div>
      </Card>

      {shop === null ? (
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
            {isSubmitting ? t('common.saving') : t('storefront.settings.create')}
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

      <Dialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
      >
        {moving !== null && shop !== null && (
          <DialogContent
            title={t('storefront.settings.moveTitle')}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={isSubmitting}
                  onClick={() => {
                    const values = moving;
                    setMoving(null);
                    void save(values);
                  }}
                >
                  {t('storefront.settings.moveConfirm')}
                </Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('storefront.settings.moveBody', {
                from: `${shop.subdomain}.${setup.baseDomain}`,
                to: `${subdomain.trim().toLowerCase()}.${setup.baseDomain}`,
              })}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </form>
  );
}
```

The form's cards, as in the mockup.

- The subdomain box shows the base domain as a suffix (`.omnivosoft.com` on staging, `.localhost` in dev), so the
  owner sees the whole address while typing. Its hint changes once the shop is open (decision 3).
- The warehouse select starts with "Pick a warehouse" (`''`), which the schema turns into `null`: before the launch
  a shop may have none.
- The zones are a field array, each row a `role="group"` named "Zone 2", so a screen reader knows which zone's
  boxes it is in. On a phone the remove button sits beside the name and the charge goes below; from `sm` the three
  share a row. "Add zone" is disabled at six (`STOREFRONT_ZONES_MAX`), the most the checkout's cards show.
- The charge, the free delivery amount and the minimum order are `MoneyInput`s through `FormField`: the money box
  keeps the value a decimal string and takes Bangla digits.
- "Ways to pay" is a `CheckboxGroup` through a `Controller`, because it is one value (an array) for several boxes.
- Before the first save, the button says "Set up the shop" and stays at the end of the form. After it, the save bar
  appears only while there are changes.

```tsx
// The checklist until the shop is open (decision 1). It reads the saved settings (readiness comes
// from the API), so it waits while the form has changes: "Open" would open what is saved, not what
// is on the screen
function LaunchCard({
  shop,
  dirty,
  onLaunched,
}: {
  shop: StorefrontSettings | null;
  dirty: boolean;
  onLaunched: (saved: StorefrontSettings) => void;
}) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const launch = useMutation({
    mutationFn: (version: number) => call(routes.storefront.launch, { body: { version } }),
    onSuccess: (saved) => {
      setConfirming(false);
      toast(t('storefront.launch.opened', { name: saved.name }));
      onLaunched(saved);
    },
  });
  const ready = shop?.readiness;
  const steps = [
    { key: 'warehouse', done: ready?.warehouse === true, text: t('storefront.launch.warehouse') },
    { key: 'zone', done: ready?.zone === true, text: t('storefront.launch.zone') },
    { key: 'listing', done: ready?.listing === true, text: t('storefront.launch.listing') },
  ] as const;
  const allDone = steps.every((step) => step.done);

  return (
    <Card>
      <CardHeader
        title={t('storefront.launch.title')}
        subtitle={t('storefront.launch.description')}
      />
      <div className="grid gap-4 px-5 pt-3 pb-5">
        <ol className="grid">
          {steps.map((step) => (
            <li
              key={step.key}
              className="flex items-start gap-3 border-t border-line py-3.5 first:border-t-0 first:pt-1"
            >
              <span
                className={
                  step.done
                    ? 'mt-px grid size-[22px] shrink-0 place-items-center rounded-full bg-good-bg text-good'
                    : 'mt-px size-[22px] shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong'
                }
              >
                {step.done && <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />}
              </span>
              <span className="grid gap-1">
                <span className={step.done ? 'text-body-sm text-ink' : 'text-body-sm text-ink-2'}>
                  {step.text}
                </span>
                <span className={step.done ? 'text-caption text-good' : 'text-caption text-ink-3'}>
                  {step.done ? t('storefront.launch.done') : t('storefront.launch.notDone')}
                </span>
                {step.key === 'listing' && !step.done && shop !== null && (
                  <Link
                    to="/storefront/listings"
                    className="text-label font-medium text-brand underline-offset-3 hover:underline"
                  >
                    {t('storefront.launch.goToCatalog')}
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ol>
        {(shop === null || dirty) && (
          <p className="text-label text-ink-3">{t('storefront.launch.saveFirst')}</p>
        )}
        {launch.error && (
          <FormAlert
            message={launch.error instanceof ApiRequestError ? launch.error.code : 'unknown_error'}
          />
        )}
        <Button
          variant={allDone ? 'primary' : 'secondary'}
          disabled={shop === null || dirty || !allDone}
          className="w-full"
          onClick={() => {
            setConfirming(true);
          }}
        >
          <HugeiconsIcon icon={Rocket01Icon} size={17} strokeWidth={1.5} />
          {t('storefront.launch.open')}
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        {shop !== null && (
          <DialogContent
            title={t('storefront.launch.confirmTitle', { name: shop.name })}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">{t('common.cancel')}</Button>
                </DialogClose>
                <Button
                  disabled={launch.isPending}
                  onClick={() => {
                    launch.mutate(shop.version);
                  }}
                >
                  <HugeiconsIcon icon={Rocket01Icon} size={17} strokeWidth={1.5} />
                  {t('storefront.launch.open')}
                </Button>
              </>
            }
          >
            <p className="text-body-sm text-ink-2">
              {t('storefront.launch.confirmBody', { url: shop.shopUrl })}
            </p>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
```

The launch checklist (decision 1).

- The three ticks come from the server (`readiness`), because only the server knows whether a published listing has
  a photo and a price. The page does not guess from the form.
- "Open the shop" is disabled until the shop is saved, the form is clean and all three are done; the line above it
  says why when it waits for a save.
- The dialog says the shop can't be closed again (26e). The launch sends the version it read, like every other
  write, so a launch from a stale page fails with a version conflict instead of opening something unexpected.
- After the launch, `onLaunched` puts the new settings in the cache; their new version changes the form's `key` and
  the form starts again from it (decision 44).

```tsx
function OpenCard({ shop }: { shop: StorefrontSettings }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const day = useMemo(() => {
    if (shop.launchedAt === null) return '';
    // The launch day in the workspace's time zone, as a date (no time: "Open since 12 Nov 2026")
    const iso = todayIn(timeZone, new Date(shop.launchedAt));
    return format.date(new Date(`${iso}T00:00:00`));
  }, [shop.launchedAt, timeZone, format]);
  return (
    <Card>
      <CardHeader title={t('storefront.launch.openTitle')} />
      <div className="grid gap-4 px-5 pt-3 pb-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-good-bg text-good">
            <HugeiconsIcon icon={StoreVerified01Icon} size={20} strokeWidth={1.5} />
          </span>
          <p className="text-body-sm text-ink-2">
            {t('storefront.launch.openSince', { date: day, url: shop.shopUrl })}
          </p>
        </div>
        <Pill tone="good" icon={CheckmarkCircle02Icon}>
          {t('storefront.settings.statusOpen')}
        </Pill>
        <ViewShopLink href={shop.shopUrl} className="w-full" />
      </div>
    </Card>
  );
}

export function StorefrontSettingsPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const queryClient = useQueryClient();
  const refresh = useStorefrontRefresh();
  const { data: setup, isError } = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  // Whether the form has changes, for the checklist (the form reports it)
  const [formDirty, setFormDirty] = useState(false);
  const shop = setup?.shop ?? null;

  const saved = (next: StorefrontSettings) => {
    if (setup) {
      queryClient.setQueryData(storefrontSetupQuery(tenantId).queryKey, { ...setup, shop: next });
    }
    // The catalog's stock column and the checklist depend on the warehouse and the zones
    void refresh();
  };

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.settings.title')}
        description={
          <>
            {t('storefront.settings.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p className="text-body-sm text-crit">{t('storefront.settings.loadFailed')}</p>
      )}
      {online && setup && (
        <>
          {shop === null && (
            <DocumentNotice tone="neutral">{t('storefront.settings.notSetUp')}</DocumentNotice>
          )}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* key: a new version (the first save, the launch) starts the form again from it, so
                the next save sends that version */}
            <SettingsForm
              key={`${tenantId}-${String(shop?.version ?? 0)}`}
              setup={setup}
              onSaved={saved}
              onDirtyChange={setFormDirty}
            />
            <div className="grid gap-5 lg:sticky lg:top-5">
              {shop?.launchedAt != null ? (
                <OpenCard shop={shop} />
              ) : (
                <LaunchCard shop={shop} dirty={formDirty} onLaunched={saved} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

`OpenCard` replaces the checklist once the shop is open: the launch day in the workspace's time zone (the same
`todayIn` the rest of the app uses for "today"), the address and "View shop". The page shows "Needs a connection"
offline (decision 5), and the notice above the form before the first save says where the suggested details came
from.

### `routes/storefront-categories.tsx`: the shop's categories

```tsx
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  Edit02Icon,
  FolderAddIcon,
  FolderLibraryIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  slugFromName,
  type StorefrontCategory,
  updateStorefrontCategoryInputSchema,
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
  filterTree,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
  TreeList,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  ShopLine,
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  siblingPlace,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontCategoryTree,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 26g: the shop's categories, in the order the shop's menu shows them. Like the product
// categories page (TreeList, one dialog form for new and edit), plus what a shop needs: a link name
// (slug), Move up / Move down among the siblings (decision 15: buttons, so a keyboard can do it),
// and each category's listing count.

const FIELDS = updateStorefrontCategoryInputSchema.in.keyof().options;
```

The imports. `FIELDS` is the update schema's field names, read from `.in` because the schema is a pipe (its
transform makes the slug).

```tsx
function CategoryForm({
  categories,
  category,
  parentId,
  onDone,
}: {
  categories: StorefrontCategory[];
  category: StorefrontCategory | null;
  parentId: string;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const parents = useMemo(
    () => [
      { value: '', label: t('storefront.categories.topLevel') },
      ...storefrontCategoryOptions(categories, category?.id),
    ],
    [categories, category, t],
  );
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateStorefrontCategoryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      parentId: category ? (category.parentId ?? '') : parentId,
      name: category?.name ?? '',
      slug: category?.slug ?? '',
      // A new category has no version; 1 passes the schema, and the create route never reads it
      version: category?.version ?? 1,
    },
  });
  // What an empty link name becomes, as the schema makes it (decision 12): shown as the box's
  // placeholder and in its hint, so the person sees the link before saving
  const name = watch('name');
  const slug = watch('slug');
  const madeSlug = slugFromName(name);
  const shownSlug = slug.trim() === '' ? madeSlug : slug.trim().toLowerCase();

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = category
        ? await call(routes.storefront.updateCategory, {
            params: { id: category.id },
            body: { ...fields, version },
          })
        : await call(routes.storefront.createCategory, { body: fields });
      await refresh();
      toast(
        t(category ? 'storefront.categories.updated' : 'storefront.categories.created', {
          name: saved.name,
        }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={
        category
          ? t('storefront.categories.editTitle', { name: category.name })
          : t('storefront.categories.newTitle')
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="shop-category-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : category
                ? t('common.save')
                : t('storefront.categories.add')}
          </Button>
        </>
      }
    >
      <form
        id="shop-category-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <SelectField
          label={t('storefront.categories.parent')}
          icon={FolderLibraryIcon}
          options={parents}
          {...register('parentId')}
          error={errors.parentId?.message}
        />
        <TextField
          label={t('storefront.categories.name')}
          placeholder={t('storefront.categories.namePlaceholder')}
          {...register('name')}
          error={errors.name?.message}
        />
        <TextField
          label={t('storefront.categories.slug')}
          optional
          prefix="/c/"
          autoComplete="off"
          spellCheck={false}
          placeholder={madeSlug}
          hint={
            category && shownSlug !== category.slug
              ? t('storefront.categories.slugChangeHint')
              : t('storefront.categories.slugHint', { slug: shownSlug || '…' })
          }
          {...register('slug')}
          error={errors.slug?.message}
        />
      </form>
    </DialogContent>
  );
}
```

One dialog form for a new category and an edit, like the product categories.

- The link name box shows, as its placeholder and in its hint, the slug the name would make (`slugFromName`, the
  same function the schema uses), so the owner sees `/c/skin-care` before saving. A Bangla-only name makes no slug,
  so the hint shows "…" and the schema asks for one (`storefront_slug_required`).
- When editing, the hint changes to the warning once the slug differs from the saved one: only then does an old
  link break.

```tsx
function DeleteDialog({ category, onDone }: { category: StorefrontCategory; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const remove = useMutation({
    mutationFn: () =>
      call(routes.storefront.deleteCategory, {
        params: { id: category.id },
        query: { version: category.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('storefront.categories.deleted', { name: category.name }));
      onDone();
    },
  });
  return (
    <DialogContent
      title={t('storefront.categories.confirmDelete', { name: category.name })}
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
            {t('storefront.categories.delete')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {remove.error && (
          <FormAlert
            message={remove.error instanceof ApiRequestError ? remove.error.code : 'unknown_error'}
          />
        )}
        <p className="text-body-sm text-ink-2">{t('storefront.categories.deleteWarning')}</p>
      </div>
    </DialogContent>
  );
}

type Editing =
  | null
  | { kind: 'new'; parentId: string }
  | { kind: 'edit'; category: StorefrontCategory }
  | { kind: 'delete'; category: StorefrontCategory };
```

Deleting asks first and sends the version it read. The warning says which categories can be deleted; when one cannot
be (`storefront_category_in_use`), the error shows in the dialog, which stays open.

```tsx
function CategoryRow({
  category,
  categories,
  canMove,
  moving,
  onMove,
  onEdit,
}: {
  category: StorefrontCategory;
  categories: readonly StorefrontCategory[];
  // Not while a search hides some siblings: "up" would jump over rows nobody can see
  canMove: boolean;
  moving: boolean;
  onMove: (category: StorefrontCategory, direction: 'up' | 'down') => void;
  onEdit: (editing: Editing) => void;
}) {
  const { t, format } = useLocale();
  const place = siblingPlace(categories, category);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          onEdit({ kind: 'edit', category });
        }}
        className={
          category.parentId === null
            ? 'min-w-0 truncate text-left text-body-sm font-medium text-ink underline-offset-3 hover:underline'
            : 'min-w-0 truncate text-left text-body-sm text-ink-2 underline-offset-3 hover:underline'
        }
      >
        {category.name}
      </button>
      <span className="hidden truncate font-mono text-caption text-ink-3 sm:inline">
        /c/{category.slug}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <span className="mr-2 text-caption text-ink-3 tabular-nums">
          {t('storefront.categories.listingCount', {
            count: category.listingCount,
            formatted: format.number(category.listingCount),
          })}
        </span>
        <IconButton
          icon={FolderAddIcon}
          label={t('storefront.categories.addTo', { name: category.name })}
          // CLAUDE.md → Tree list: on hover or focus with a mouse, always on a touch screen
          className="-my-1 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100"
          onClick={() => {
            onEdit({ kind: 'new', parentId: category.id });
          }}
        />
        <IconButton
          icon={ArrowUp01Icon}
          label={t('storefront.categories.moveUpLabel', { name: category.name })}
          className="-my-1"
          disabled={!canMove || moving || place.first}
          onClick={() => {
            onMove(category, 'up');
          }}
        />
        <IconButton
          icon={ArrowDown01Icon}
          label={t('storefront.categories.moveDownLabel', { name: category.name })}
          className="-my-1"
          disabled={!canMove || moving || place.last}
          onClick={() => {
            onMove(category, 'down');
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              icon={MoreHorizontalIcon}
              label={t('storefront.categories.actions', { name: category.name })}
              className="-my-1"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              icon={Edit02Icon}
              onSelect={() => {
                onEdit({ kind: 'edit', category });
              }}
            >
              {t('storefront.categories.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={Delete02Icon}
              onSelect={() => {
                onEdit({ kind: 'delete', category });
              }}
            >
              {t('storefront.categories.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </>
  );
}
```

One row of the tree.

- The name is a button that opens the edit dialog; a top-level category's name is `ink`/500 and a child's `ink-2`,
  as CLAUDE.md's tree list says for groups and others.
- The "Add a category inside" button shows on hover or focus with a mouse and always on a touch screen, like the
  product categories (CLAUDE.md → Tree list).
- Move up and down are disabled at the ends (`siblingPlace`), while a move is running (two quick clicks would send
  the same version twice, and the second would fail), and while a search is on: the search hides some siblings, and
  "up" would jump over a row nobody can see.
- The row's menu has Edit and Delete, named "Actions for Skin care" for a screen reader.

```tsx
export function StorefrontCategoriesPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const queryClient = useQueryClient();
  const shop = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online }).data?.shop;
  const { data: categories, isError } = useQuery({
    ...storefrontCategoriesQuery(tenantId),
    enabled: online,
  });
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const query = search.trim().toLowerCase();

  // The move answers the whole list (decision 15: both siblings changed), so the page takes it as
  // it is instead of asking again
  const move = useMutation({
    mutationFn: ({
      category,
      direction,
    }: {
      category: StorefrontCategory;
      direction: 'up' | 'down';
    }) =>
      call(routes.storefront.moveCategory, {
        params: { id: category.id },
        body: { direction, version: category.version },
      }),
    onSuccess: (list) => {
      queryClient.setQueryData(storefrontCategoriesQuery(tenantId).queryKey, list.items);
    },
  });

  const tree = useMemo(() => {
    const full = storefrontCategoryTree(categories ?? []);
    return query === ''
      ? full
      : filterTree(
          full,
          (category) =>
            category.name.toLowerCase().includes(query) || category.slug.includes(query),
        );
  }, [categories, query]);

  const isOpen = useCallback(
    (id: string) => query !== '' || !collapsed.has(id),
    [query, collapsed],
  );
  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onMove = useCallback(
    (category: StorefrontCategory, direction: 'up' | 'down') => {
      move.mutate({ category, direction });
    },
    [move],
  );

  return (
    <div className="grid max-w-5xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.categories.title')}
        description={
          <>
            {t('storefront.categories.description')}
            <ShopLine />
          </>
        }
        actions={
          <>
            {shop && <ViewShopLink href={shop.shopUrl} />}
            <Button
              disabled={!online}
              onClick={() => {
                setEditing({ kind: 'new', parentId: '' });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.categories.add')}
            </Button>
          </>
        }
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p className="text-body-sm text-crit">{t('storefront.categories.loadFailed')}</p>
      )}
      {online && categories && categories.length > 0 && (
        <div className="max-w-sm">
          <Input
            type="search"
            icon={Search01Icon}
            aria-label={t('storefront.categories.searchLabel')}
            placeholder={t('storefront.categories.searchPlaceholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      )}
      {move.error && (
        <FormAlert
          message={move.error instanceof ApiRequestError ? move.error.code : 'unknown_error'}
        />
      )}
      {online && categories?.length === 0 && (
        <EmptyState
          icon={FolderLibraryIcon}
          title={t('storefront.categories.emptyTitle')}
          description={t('storefront.categories.emptyBody')}
        />
      )}
      {online && categories && categories.length > 0 && tree.length === 0 && (
        <EmptyState
          icon={Search01Icon}
          title={t('storefront.categories.noMatchTitle')}
          description={t('storefront.categories.noMatchBody')}
        />
      )}
      {online && categories && tree.length > 0 && (
        <TreeList
          label={t('storefront.categories.title')}
          nodes={tree}
          isOpen={isOpen}
          onToggle={toggle}
          toggleLabel={(category, shown) =>
            t(shown ? 'storefront.categories.collapse' : 'storefront.categories.expand', {
              name: category.name,
            })
          }
          renderRow={(category) => (
            <CategoryRow
              category={category}
              categories={categories}
              canMove={query === ''}
              moving={move.isPending}
              onMove={onMove}
              onEdit={setEditing}
            />
          )}
        />
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(shown) => {
          if (!shown) setEditing(null);
        }}
      >
        {categories && editing?.kind === 'delete' && (
          <DeleteDialog
            category={editing.category}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
        {categories && (editing?.kind === 'new' || editing?.kind === 'edit') && (
          <CategoryForm
            key={editing.kind === 'edit' ? editing.category.id : `new-${editing.parentId}`}
            categories={categories}
            category={editing.kind === 'edit' ? editing.category : null}
            parentId={editing.kind === 'new' ? editing.parentId : ''}
            onDone={() => {
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

The page. The move's answer is the whole list (decision 15: two categories changed), so the page puts it straight
into the cache instead of asking again. The search matches the name or the link name, and opens every group on the
way to a match, like the other tree lists.

### `routes/storefront-catalog.tsx`: the catalog and "Add to shop"

```tsx
import {
  FolderLibraryIcon,
  Image01Icon,
  PackageIcon,
  PlusSignIcon,
  Search01Icon,
  Store04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createStorefrontListingInputSchema,
  routes,
  type StorefrontListingSort,
  type StorefrontListingSummary,
  todayIn,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Combobox,
  type ComboboxOption,
  DataTable,
  dataTableColumns,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  SelectField,
  type SortingState,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';

import {
  ListingStatusPill,
  ShopLine,
  StockPill,
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import {
  type ListingFilter,
  storefrontCandidatesQuery,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontListingsQuery,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: the catalog, the shop's listings a page at a time (decision 1): searched, filtered and
// sorted on the server, like the devices list. A row opens the listing's editor; "Add to shop"
// makes a draft from one product variant and opens it.

const column = dataTableColumns<StorefrontListingSummary>();
const STATUSES = ['all', 'published', 'draft'] as const;

// Only the name sorts both ways; with no sort the newest change is first (the API's default)
function sortOf(state: SortingState): StorefrontListingSort {
  const first = state[0];
  if (first?.id === 'name') return first.desc ? '-name' : 'name';
  return '-updated';
}

// The photo, or a grey tile that says there is none (a draft before its first photo)
function Thumb({ url }: { url: string | null }) {
  const { t } = useLocale();
  return url === null ? (
    <span
      title={t('storefront.catalog.noPhoto')}
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3"
    >
      <HugeiconsIcon icon={Image01Icon} size={18} strokeWidth={1.5} />
    </span>
  ) : (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}
```

`sortOf` turns the table's sort into the contract's (decision 42). `Thumb` is the row's first photo, 40px, or a grey
tile with an image icon when a draft has none yet; the photo is `object-contain`, because packshots are tall and
narrow, and a crop would cut the product.

```tsx
function AddDialog({ onDone }: { onDone: () => void }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const navigate = useNavigate();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const candidates = useQuery(storefrontCandidatesQuery(tenantId, settled));
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(createStorefrontListingInputSchema, { error: contractErrorMap }),
    defaultValues: { variantId: '', categoryId: '' },
  });

  const options = useMemo<ComboboxOption[]>(
    () =>
      (candidates.data ?? []).map((candidate) => ({
        value: candidate.variantId,
        label: candidate.name,
        detail:
          candidate.salePrice === null
            ? candidate.sku
            : t('storefront.add.detail', { sku: candidate.sku, price: money(candidate.salePrice) }),
      })),
    [candidates.data, money, t],
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      const listing = await call(routes.storefront.createListing, { body: values });
      await refresh();
      toast(t('storefront.add.added', { name: listing.name }));
      onDone();
      void navigate({ to: '/storefront/listings/$listingId', params: { listingId: listing.id } });
    } catch (error) {
      applyApiError(error, ['variantId', 'categoryId'], setError);
    }
  });

  return (
    <DialogContent
      title={t('storefront.add.title')}
      description={t('storefront.add.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="add-to-shop"
            disabled={isSubmitting || categories?.length === 0}
          >
            {isSubmitting ? t('common.saving') : t('storefront.add.submit')}
          </Button>
        </>
      }
    >
      <form
        id="add-to-shop"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <FormField control={control} name="variantId" label={t('storefront.add.product')}>
          {(field) => (
            <Combobox
              {...field}
              selectedLabel={picked?.value === field.value ? picked.label : null}
              options={options}
              search={search}
              onSearchChange={setSearch}
              onChange={(value, option) => {
                setPicked({ value, label: option.label });
                field.onChange(value);
              }}
              loading={candidates.isFetching}
              icon={PackageIcon}
              placeholder={t('storefront.add.productPlaceholder')}
              searchPlaceholder={t('storefront.add.searchPlaceholder')}
              emptyText={t('storefront.add.noMatch')}
            />
          )}
        </FormField>
        {categories?.length === 0 ? (
          // A listing needs a category, and the shop has none yet: say where to make one
          <p className="text-body-sm text-ink-2">
            {t('storefront.add.noCategories')}{' '}
            <Link
              to="/storefront/categories"
              className="font-medium text-brand underline-offset-3 hover:underline"
            >
              {t('storefront.add.addCategories')}
            </Link>
          </p>
        ) : (
          <SelectField
            label={t('storefront.add.category')}
            icon={FolderLibraryIcon}
            options={[
              { value: '', label: t('storefront.add.categoryPlaceholder') },
              ...storefrontCategoryOptions(categories ?? []),
            ]}
            {...register('categoryId')}
            error={errors.categoryId?.message}
          />
        )}
      </form>
    </DialogContent>
  );
}
```

The "Add to shop" dialog (decisions 14 and 16).

- The product box is the app's `Combobox`, searched on the server with a 250ms pause after the last key. Each match
  shows its SKU and price, so two sizes of one product can be told apart.
- `picked` keeps the chosen label: the next search replaces the options, and the box must keep showing what was
  chosen.
- When the shop has no categories, the select would be empty and the form could never be sent, so the dialog says
  so and links to the categories page instead.
- After the draft is made, the page opens its editor: the next thing the owner does is add a photo and check the
  price.

```tsx
export function StorefrontCatalogPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const money = useShopMoney();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<ListingFilter['status']>('all');
  const [categoryId, setCategoryId] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [adding, setAdding] = useState(false);

  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const categories = useQuery({ ...storefrontCategoriesQuery(tenantId), enabled: online }).data;
  const filter: ListingFilter = { search: settled, status, categoryId, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontListingsQuery(tenantId, filter),
    // Listings need the shop first (storefront_not_set_up): no request before there is one
    enabled: online && shop !== null,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const filtered = settled !== '' || status !== 'all' || categoryId !== '';

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('name', {
          header: t('storefront.catalog.columns.listing'),
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-3">
              <Thumb url={row.original.image?.url ?? null} />
              <span className="grid min-w-0">
                <span className="truncate font-medium text-ink">{row.original.name}</span>
                <span className="truncate text-caption text-ink-3">
                  {row.original.packSize === '' ? (
                    <span className="font-mono">{row.original.sku}</span>
                  ) : (
                    <>
                      <span className="font-mono">{row.original.sku}</span> ·{' '}
                      {row.original.packSize}
                    </>
                  )}
                </span>
              </span>
            </span>
          ),
        }),
        column.accessor('categoryName', {
          header: t('storefront.catalog.columns.category'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span>,
        }),
        column.accessor('price', {
          header: t('storefront.catalog.columns.price'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) =>
            row.original.price === null ? (
              <span className="text-ink-3">{t('storefront.catalog.noPrice')}</span>
            ) : (
              <span className="grid justify-items-end tabular-nums">
                <span className="font-medium">{money(row.original.price)}</span>
                {row.original.compareAtPrice !== null && (
                  <s className="text-caption text-ink-3">{money(row.original.compareAtPrice)}</s>
                )}
              </span>
            ),
        }),
        column.accessor('inStock', {
          header: t('storefront.catalog.columns.stock'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <StockPill inStock={getValue()} />,
        }),
        column.accessor('status', {
          header: t('storefront.catalog.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <ListingStatusPill status={getValue()} />,
        }),
        column.accessor('updatedAt', {
          header: t('storefront.catalog.columns.updated'),
          enableSorting: false,
          meta: { card: 'detail' },
          // The day in the workspace's time zone, like every other list's date
          cell: ({ getValue }) => (
            <span className="text-ink-2 tabular-nums">
              {format.date(new Date(`${todayIn(timeZone, new Date(getValue()))}T00:00:00`))}
            </span>
          ),
        }),
      ]),
    [t, format, money, timeZone],
  );

  const statusOptions = STATUSES.map((value) => ({
    value,
    label: t(`storefront.catalog.statuses.${value}`),
  }));

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.catalog.title')}
        description={
          <>
            {t('storefront.catalog.description')}
            {shop !== null && <ShopLine />}
          </>
        }
        actions={
          shop !== null && (
            <>
              <ViewShopLink href={shop.shopUrl} />
              <Button
                onClick={() => {
                  setAdding(true);
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.catalog.add')}
              </Button>
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && (isError || setup.isError) && (
        <p className="text-body-sm text-crit">{t('storefront.catalog.loadFailed')}</p>
      )}
      {online && setup.data && shop === null && (
        <EmptyState
          icon={Store04Icon}
          title={t('storefront.catalog.notSetUpTitle')}
          description={t('storefront.catalog.notSetUpBody')}
          action={
            <Button
              onClick={() => {
                void navigate({ to: '/storefront/settings' });
              }}
            >
              {t('storefront.catalog.goToSettings')}
            </Button>
          }
        />
      )}
      {online && shop !== null && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.catalog.searchLabel')}
                placeholder={t('storefront.catalog.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.catalog.status')}
              value={status}
              options={statusOptions}
              onChange={setStatus}
            />
            <div className="w-full sm:w-60">
              <Select
                aria-label={t('storefront.catalog.category')}
                icon={FolderLibraryIcon}
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.target.value);
                }}
                options={[
                  { value: '', label: t('storefront.catalog.allCategories') },
                  ...storefrontCategoryOptions(categories ?? []),
                ]}
              />
            </div>
          </div>
          {rows && (
            <DataTable
              label={t('storefront.catalog.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              sorting={{ state: sorting, onChange: setSorting }}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/listings/$listingId',
                  params: { listingId: row.id },
                })
              }
              onEndReached={loadMore}
              empty={
                filtered ? (
                  <EmptyState
                    icon={Search01Icon}
                    title={t('storefront.catalog.noMatchTitle')}
                    description={t('storefront.catalog.noMatchBody')}
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setSearch('');
                          setStatus('all');
                          setCategoryId('');
                        }}
                      >
                        {t('storefront.catalog.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={Store04Icon}
                    title={t('storefront.catalog.emptyTitle')}
                    description={t('storefront.catalog.emptyBody')}
                  />
                )
              }
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddDialog
            onDone={() => {
              setAdding(false);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

The page.

- The list waits for the shop (`enabled: shop !== null`): before the first save the API answers
  `storefront_not_set_up`, so the page shows "Set up the shop first" with a button to the settings instead.
- The columns opt into the phone's card list (`meta.card`): the name and photo are the title, the status the
  subtitle, the price on the right, and the rest details below.
- The price column shows the price a shopper pays now and the struck-out regular price during a sale, both from the
  API's `listingPricing`, so the list says the same as the shop.
- The date is the day of the last change in the workspace's time zone.
- An empty list says why: with a filter on, "No listing matches" and a button that clears every filter; without,
  what to add.

### `components/storefront-photos.tsx`: the photos card

```tsx
import {
  Alert02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Image01Icon,
  ImageAdd01Icon,
  Loading03Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ATTACHMENT_RULES,
  type ErrorCode,
  routes,
  STOREFRONT_IMAGES_MAX,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, CardHeader, FormAlert, IconButton, Pill, TextField } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  type Control,
  type FieldErrors,
  useFieldArray,
  type UseFormRegister,
} from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { rowPath } from '../lib/products';
import {
  checkPhotoFile,
  type ListingFormValues,
  photoState,
  type PhotoState,
  uploadShopPhoto,
} from '../lib/storefront';
import { useTenantId } from '../lib/workspace';

// Step 26g: a listing's photos (decision 2). The form keeps {id, alt} per photo, in order; the page
// keeps each photo's state beside it (the upload, the server's job, the small file's address), so
// the slot can say "Uploading…" and "Preparing the photo…" while the job makes the shop's sizes.
// The page waits for every photo to be ready before it saves: the API refuses a photo it has not
// finished (storefront_image_not_ready).

type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;
```

The imports and the form's control type. The control's third type (`UpdateStorefrontListingInput`) is the form's
output after the schema; react-hook-form needs all three to match the page's `useForm`.

```tsx
// One photo the server is still working on: asks every 2 seconds until the job has finished, then
// hands the answer to the page. A query per slot, so a photo that is ready stops asking
function useJobState(
  id: string,
  state: PhotoState,
  onState: (id: string, next: PhotoState) => void,
) {
  const tenantId = useTenantId();
  const { data } = useQuery({
    queryKey: ['storefront', tenantId, 'upload', id],
    queryFn: () => call(routes.storefront.getUpload, { params: { id } }),
    enabled: state.status === 'processing',
    refetchInterval: 2000,
    // A fresh answer each time the slot asks: a cached "processing" must not stop the polling
    gcTime: 0,
  });
  useEffect(() => {
    if (state.status !== 'processing' || data === undefined) return;
    const next = photoState(data);
    if (next.status !== 'processing') onState(id, next);
  }, [data, id, state.status, onState]);
}
```

`useJobState` asks the API every 2 seconds while a photo is processing, and stops when it is not
(`enabled: state.status === 'processing'`). One query per slot, so a ready photo never asks. `gcTime: 0` drops the
answer when the slot goes, so a photo removed and added again starts with a fresh question.

```tsx
function PhotoSlot({
  index,
  count,
  id,
  state,
  register,
  error,
  onState,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  id: string;
  state: PhotoState;
  register: UseFormRegister<ListingFormValues>;
  error: string | undefined;
  onState: (id: string, next: PhotoState) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useLocale();
  const number = index + 1;
  useJobState(id, state, onState);

  return (
    <div
      role="group"
      aria-label={t('storefront.listing.photoNumber', { number })}
      className="grid content-start gap-3 rounded-control border border-line p-3"
    >
      <div className="flex items-center gap-0.5">
        <span className="mr-auto text-caption text-ink-2">
          {t('storefront.listing.photoNumber', { number })}
        </span>
        <IconButton
          icon={ArrowLeft01Icon}
          label={t('storefront.listing.movePhotoUp', { number })}
          disabled={index === 0}
          onClick={() => {
            onMove(index, index - 1);
          }}
        />
        <IconButton
          icon={ArrowRight01Icon}
          label={t('storefront.listing.movePhotoDown', { number })}
          disabled={index === count - 1}
          onClick={() => {
            onMove(index, index + 1);
          }}
        />
        <IconButton
          icon={Delete02Icon}
          label={t('storefront.listing.removePhoto', { number })}
          onClick={() => {
            onRemove(index);
          }}
        />
      </div>
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-lg bg-subtle">
        {state.status === 'ready' ? (
          // The small WebP the job made. multiply drops a packshot's white box onto the grey
          <img src={state.url} alt="" className="size-full object-contain mix-blend-multiply" />
        ) : state.status === 'failed' ? (
          <span className="grid justify-items-center gap-2 px-4 text-center text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.5} />
            <ErrorWords code={state.code} />
          </span>
        ) : (
          <span role="status" className="grid justify-items-center gap-2 text-body-sm text-ink-2">
            <HugeiconsIcon
              icon={state.status === 'uploading' ? Image01Icon : Loading03Icon}
              size={22}
              strokeWidth={1.5}
              className={state.status === 'processing' ? 'motion-safe:animate-spin' : undefined}
            />
            {state.status === 'uploading'
              ? t('storefront.listing.uploading')
              : t('storefront.listing.preparing')}
          </span>
        )}
        {index === 0 && state.status === 'ready' && (
          <span className="absolute top-2 left-2">
            <Pill tone="brand" icon={Image01Icon}>
              {t('storefront.listing.firstPhoto')}
            </Pill>
          </span>
        )}
      </div>
      {state.status === 'failed' ? (
        <button
          type="button"
          onClick={() => {
            onRemove(index);
          }}
          className="justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          {t('storefront.listing.dropPhoto')}
        </button>
      ) : (
        <TextField
          label={t('storefront.listing.alt')}
          placeholder={t('storefront.listing.altPlaceholder')}
          hint={index === 0 ? t('storefront.listing.altHint') : undefined}
          {...register(rowPath('images', index, 'alt'))}
          error={error}
        />
      )}
    </div>
  );
}

function ErrorWords({ code }: { code: ErrorCode }) {
  const { errorText } = useLocale();
  return <>{errorText(code)}</>;
}
```

One slot.

- The buttons move the photo earlier or later, because the first photo is the card's (decision 1's "Move up/down"
  for photos), and remove it.
- The image is the small WebP the job made. `mix-blend-multiply` drops a packshot's white box onto the grey slot,
  like the shop's cards.
- While uploading or preparing, the slot shows a `role="status"` line, so a screen reader hears "Preparing the
  photo…". The spinner turns only when the person allows motion (`motion-safe:`).
- A failed photo shows the error's words (from `errors.*`, like every other error) and "Remove it" instead of the
  alt box: the photo cannot be saved, so asking what it shows would be pointless.
- The alt box's hint shows only on the first slot; four copies of the same hint would only add noise.

```tsx
export function PhotosCard({
  control,
  register,
  errors,
  photos,
  onPhotoState,
}: {
  control: ListingControl;
  register: UseFormRegister<ListingFormValues>;
  errors: FieldErrors<ListingFormValues>;
  photos: ReadonlyMap<string, PhotoState>;
  onPhotoState: (id: string, next: PhotoState) => void;
}) {
  const { t, format } = useLocale();
  const images = useFieldArray({ control, name: 'images', keyName: 'key' });
  const fileInput = useRef<HTMLInputElement>(null);
  const [failure, setFailure] = useState<ErrorCode | null>(null);
  const left = STOREFRONT_IMAGES_MAX - images.fields.length;

  // Several files at once, up to the photos still free; each goes its own way (one failing does
  // not stop the others). The form gets the photo as soon as it has an id, with an empty alt
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])].slice(0, Math.max(left, 0));
    // Emptied, so choosing the same file again (after a failure) is a change again
    event.target.value = '';
    setFailure(null);
    for (const file of files) {
      const problem = checkPhotoFile(file);
      if (problem !== null) {
        setFailure(problem);
        continue;
      }
      uploadShopPhoto(file, (id) => {
        onPhotoState(id, { status: 'uploading' });
        images.append({ id, alt: '' }, { shouldFocus: false });
      })
        .then(({ id, state }) => {
          onPhotoState(id, state);
        })
        .catch((error: unknown) => {
          setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
        });
    }
  };

  const listError = errors.images?.root?.message ?? errors.images?.message;

  return (
    <Card>
      <CardHeader
        title={t('storefront.listing.photosTitle')}
        subtitle={t('storefront.listing.photosHint', { max: STOREFRONT_IMAGES_MAX })}
      />
      <div className="grid gap-4 p-5">
        {failure !== null && <FormAlert message={failure} />}
        {listError !== undefined && <FormAlert message={listError} />}
        {images.fields.length === 0 && (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.noPhotos')}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {images.fields.map((image, index) => (
            <PhotoSlot
              key={image.key}
              index={index}
              count={images.fields.length}
              id={image.id}
              state={photos.get(image.id) ?? { status: 'processing' }}
              register={register}
              error={errors.images?.[index]?.alt?.message ?? errors.images?.[index]?.message}
              onState={onPhotoState}
              onMove={images.swap}
              onRemove={images.remove}
            />
          ))}
          {left > 0 && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="grid min-h-48 place-items-center content-center gap-2 rounded-control border border-dashed border-line-strong bg-surface p-4 text-body-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-subtle"
            >
              <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ImageAdd01Icon} size={20} strokeWidth={1.5} />
              </span>
              {t('storefront.listing.addPhoto')}
              <span className="text-caption font-normal text-ink-3">
                {t('storefront.listing.photosLeft', {
                  count: left,
                  formatted: format.number(left),
                })}
              </span>
            </button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          // Only the kinds the server takes; it checks the bytes again (26g.3)
          accept={ATTACHMENT_RULES.storefront_image.contentTypes.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={choose}
        />
      </div>
    </Card>
  );
}
```

The card.

- `useFieldArray` with `keyName: 'key'`: react-hook-form puts its own row id in a field called `id` by default, which
  would hide the photo's real `id`.
- Several files can be chosen at once, up to the photos still free. Each goes on its own way: one failing does not
  stop the others, and its error shows above the slots.
- The photo enters the form as soon as it has an id (with an empty alt), so the slot appears at once. The save waits
  until it is ready (decision 40).
- The file input is hidden and out of the tab order; the Add tile is the real button, and a click on it opens the
  file picker. Its `accept` list comes from the contract's upload rule, so the picker shows only the kinds the server
  takes.

### `components/storefront-sections.tsx`: the description

```tsx
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PlusSignIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  renderSections,
  STOREFRONT_SECTIONS_MAX,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  FormAlert,
  IconButton,
  TextAreaField,
  TextField,
} from '@omnivo/ui';
import { useState } from 'react';
import {
  type Control,
  type FieldErrors,
  useFieldArray,
  type UseFormRegister,
  useWatch,
} from 'react-hook-form';

import { rowPath } from '../lib/products';
import type { ListingFormValues } from '../lib/storefront';

// Step 26g: the description, as sections of a heading and a text box (26f decision 6: the tenant
// never writes HTML). Each section has a preview made by the same renderSections the API uses, so
// what the box shows is what the product page will show, list markers and bold included.

type ListingControl = Control<ListingFormValues, unknown, UpdateStorefrontListingInput>;

// The product page's prose, at the app's sizes: headings like a card title, lists with markers
const PROSE =
  'grid gap-2 text-body-sm text-ink-2 [&_a]:font-medium [&_a]:text-brand [&_a]:underline [&_h2]:text-h3 [&_h2]:text-ink [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:pl-5';

function SectionPreview({ control, index }: { control: ListingControl; index: number }) {
  const { t } = useLocale();
  const [heading, body] = useWatch({
    control,
    name: [
      rowPath('descriptionSections', index, 'heading'),
      rowPath('descriptionSections', index, 'body'),
    ],
  });
  // renderSections escapes every character the person typed before it adds its own few tags
  // (26f: the same function writes the shop's HTML), so this HTML carries no markup of theirs
  const html = renderSections([{ heading: heading.trim(), body: body.trim() }]);
  return (
    <div className="overflow-hidden rounded-control border border-line">
      <p className="flex items-center gap-1.5 bg-subtle px-3.5 py-2 text-caption text-ink-3">
        <HugeiconsIcon icon={ViewIcon} size={14} strokeWidth={1.5} />
        {t('storefront.listing.previewCaption')}
      </p>
      <div className={`px-5 py-4 ${PROSE}`} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function DescriptionCard({
  control,
  register,
  errors,
}: {
  control: ListingControl;
  register: UseFormRegister<ListingFormValues>;
  errors: FieldErrors<ListingFormValues>;
}) {
  const { t } = useLocale();
  const sections = useFieldArray({ control, name: 'descriptionSections' });
  // Which sections show their preview, by the field array's own key (it survives a move)
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());
  const listError =
    errors.descriptionSections?.root?.message ?? errors.descriptionSections?.message;

  return (
    <Card>
      <CardHeader
        title={t('storefront.listing.descriptionTitle')}
        subtitle={t('storefront.listing.descriptionHint')}
      />
      <div className="grid gap-4 p-5">
        {listError !== undefined && <FormAlert message={listError} />}
        {sections.fields.length === 0 && (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.noSections')}</p>
        )}
        {sections.fields.map((section, index) => {
          const number = index + 1;
          const shown = previews.has(section.id);
          return (
            <div
              key={section.id}
              role="group"
              aria-label={t('storefront.listing.sectionNumber', { number })}
              className="grid gap-4 rounded-control border border-line p-4"
            >
              <div className="flex items-center gap-0.5">
                <span className="mr-auto text-caption text-ink-2">
                  {t('storefront.listing.sectionNumber', { number })}
                </span>
                <IconButton
                  icon={ArrowUp01Icon}
                  label={t('storefront.listing.moveSectionUp', { number })}
                  disabled={index === 0}
                  onClick={() => {
                    sections.swap(index, index - 1);
                  }}
                />
                <IconButton
                  icon={ArrowDown01Icon}
                  label={t('storefront.listing.moveSectionDown', { number })}
                  disabled={index === sections.fields.length - 1}
                  onClick={() => {
                    sections.swap(index, index + 1);
                  }}
                />
                <IconButton
                  icon={Delete02Icon}
                  label={t('storefront.listing.removeSection', { number })}
                  onClick={() => {
                    sections.remove(index);
                  }}
                />
              </div>
              <TextField
                label={t('storefront.listing.heading')}
                placeholder={t('storefront.listing.headingPlaceholder')}
                {...register(rowPath('descriptionSections', index, 'heading'))}
                error={errors.descriptionSections?.[index]?.heading?.message}
              />
              <TextAreaField
                label={t('storefront.listing.body')}
                placeholder={t('storefront.listing.bodyPlaceholder')}
                rows={6}
                hint={index === 0 ? t('storefront.listing.bodyHint') : undefined}
                {...register(rowPath('descriptionSections', index, 'body'))}
                error={errors.descriptionSections?.[index]?.body?.message}
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-expanded={shown}
                  onClick={() => {
                    setPreviews((current) => {
                      const next = new Set(current);
                      if (!next.delete(section.id)) next.add(section.id);
                      return next;
                    });
                  }}
                >
                  <HugeiconsIcon
                    icon={shown ? ViewOffSlashIcon : ViewIcon}
                    size={17}
                    strokeWidth={1.5}
                  />
                  {shown
                    ? t('storefront.listing.hidePreview')
                    : t('storefront.listing.showPreview')}
                </Button>
              </div>
              {shown && <SectionPreview control={control} index={index} />}
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={sections.fields.length >= STOREFRONT_SECTIONS_MAX}
            onClick={() => {
              sections.append({ heading: '', body: '' });
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
            {t('storefront.listing.addSection')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
```

- Each section is a heading box and a text box, in a `role="group"` named "Section 2", with Move up, Move down and
  Remove. At 12 sections (`STOREFRONT_SECTIONS_MAX`) "Add section" is disabled.
- The preview is per section and shows the shop's HTML for it (decision 45). `useWatch` reads only that section's two
  boxes, so typing in one section does not redraw the others. The `PROSE` classes style the few tags
  `renderSections` writes (headings, paragraphs, lists, bold, links) at the app's sizes.
- The preview's open state is kept by the field array's key, not the index, so a moved section keeps its preview
  open.

### `routes/storefront-listing.tsx`: a listing's editor

```tsx
import {
  Alert02Icon,
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  FileEditIcon,
  FolderLibraryIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  Store04Icon,
  Tag01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  sectionsSummary,
  SHOP_BADGES,
  type StorefrontListing,
  type UpdateStorefrontListingInput,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  CheckboxGroup,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FormAlert,
  FormField,
  IconButton,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { DocumentNotice } from '../components/document-notice';
import { PhotosCard } from '../components/storefront-photos';
import { DescriptionCard } from '../components/storefront-sections';
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
import { warehousesQuery } from '../lib/queries';
import {
  listingFormSchema,
  listingFormValues,
  type ListingFormValues,
  type PhotoState,
  plainAmount,
  pricePreview,
  SALE_FORM_KINDS,
  storefrontCategoriesQuery,
  storefrontCategoryOptions,
  storefrontListingQuery,
  storefrontSetupQuery,
} from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 26g: one listing's editor (decision 1): Basics, Photos, Price and sale, Description and
// Search engines in one form that saves with one PUT, and beside it what the shop shows for the
// price right now. Publishing is its own button in the header: it waits until the form is saved,
// because the server publishes what is saved, not what is on the screen.

const FORM_ID = 'storefront-listing';
const SEO_TITLE_MAX = 120;
const SEO_DESCRIPTION_MAX = 300;

// Where the API's field errors can land; anything else shows at the top
const FIELDS: Path<ListingFormValues>[] = [
  'name',
  'slug',
  'packSize',
  'categoryId',
  'priceOverride',
  'badges',
  'images',
  'descriptionSections',
  'seoTitle',
  'seoDescription',
  'sale.value',
  'sale.startsAt',
  'sale.endsAt',
];

// A day as the page shows it ("30 Nov 2026"), from an ISO date
function useDay(): (isoDate: string) => string {
  const { format } = useLocale();
  return useCallback((isoDate: string) => format.date(new Date(`${isoDate}T00:00:00`)), [format]);
}
```

The imports and `FIELDS`, the paths an API error may name. `sale.value`, `sale.startsAt` and `sale.endsAt` are in it
because the API checks an amount or price sale against the regular price (26g.3) and names the value box.

```tsx
function PricePreviewCard({
  listing,
  control,
  timeZone,
}: {
  listing: StorefrontListing;
  control: ReturnType<
    typeof useForm<ListingFormValues, unknown, UpdateStorefrontListingInput>
  >['control'];
  timeZone: string;
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const day = useDay();
  const [priceOverride, sale, name, packSize, images] = useWatch({
    control,
    name: ['priceOverride', 'sale', 'name', 'packSize', 'images'],
  });
  const preview = pricePreview(
    priceOverride ?? '',
    listing.variant.salePrice,
    sale,
    timeZone,
    new Date(),
  );
  const firstPhoto = listing.images.find((image) => image.id === images[0]?.id);

  return (
    <Card>
      <CardHeader title={t('storefront.listing.preview')} />
      <div className="grid gap-3 px-5 pt-3.5 pb-5">
        <div className="flex items-center gap-3 rounded-control border border-line p-3">
          {firstPhoto ? (
            <img
              src={firstPhoto.url}
              alt=""
              className="size-14 shrink-0 rounded-lg border border-line object-contain"
            />
          ) : (
            <span className="size-14 shrink-0 rounded-lg bg-subtle" />
          )}
          <span className="grid min-w-0 gap-0.5">
            <span className="line-clamp-2 text-body-sm font-medium text-ink">{name}</span>
            {packSize !== '' && <span className="text-caption text-ink-3">{packSize}</span>}
          </span>
        </div>
        {preview.kind === 'none' ? (
          <p className="text-body-sm text-ink-2">{t('storefront.listing.previewNoPrice')}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-kpi tracking-[-0.03em] tabular-nums">
                {money(preview.pricing.price)}
              </span>
              {preview.pricing.compareAtPrice !== null && (
                <s className="text-body-sm text-ink-3 tabular-nums">
                  {money(preview.pricing.compareAtPrice)}
                </s>
              )}
              {preview.pricing.discount !== null && (
                <Pill tone="brand" icon={Tag01Icon}>
                  {preview.pricing.discount.kind === 'percent'
                    ? t('storefront.listing.ribbonPercent', {
                        percent: preview.pricing.discount.value,
                      })
                    : t('storefront.listing.ribbonAmount', {
                        amount: money(preview.pricing.discount.value),
                      })}
                </Pill>
              )}
            </p>
            {preview.sale === 'on' && sale.endsAt !== '' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewUntil', { date: day(sale.endsAt) })}
              </p>
            )}
            {preview.sale === 'later' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewLater', { date: day(sale.startsAt) })}
              </p>
            )}
            {preview.sale === 'ended' && (
              <p className="text-label text-ink-3">
                {t('storefront.listing.previewEnded', { date: day(sale.endsAt) })}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
```

The "In the shop now" card. It watches only the boxes it needs (`useWatch` with five names), so typing in the
description does not redraw it. The photo is the form's first photo, looked up among the saved ones: a new photo has
no address in the saved listing until the next save, so the card shows the grey tile until then.

```tsx
function ListingEditor({ listing }: { listing: StorefrontListing }) {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = useStorefrontRefresh();
  const money = useShopMoney();
  const setup = useQuery(storefrontSetupQuery(tenantId)).data;
  const categories = useQuery(storefrontCategoriesQuery(tenantId)).data;
  const warehouses = useQuery(warehousesQuery(tenantId, 'active')).data;
  const [deleting, setDeleting] = useState(false);
  // The photos' states beside the form: the saved ones are ready (they have their small file)
  const [photos, setPhotos] = useState<ReadonlyMap<string, PhotoState>>(
    () => new Map(listing.images.map((image) => [image.id, { status: 'ready', url: image.url }])),
  );
  const onPhotoState = useCallback((id: string, next: PhotoState) => {
    setPhotos((current) => new Map(current).set(id, next));
  }, []);

  const schema = useMemo(() => listingFormSchema(timeZone), [timeZone]);
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(schema, { error: contractErrorMap }),
    defaultValues: listingFormValues(listing, timeZone),
  });

  const saved = async (next: StorefrontListing) => {
    queryClient.setQueryData(storefrontListingQuery(tenantId, next.id).queryKey, next);
    reset(listingFormValues(next, timeZone));
    await refresh();
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const next = await call(routes.storefront.updateListing, {
        params: { id: listing.id },
        body: values,
      });
      await saved(next);
      toast(t('storefront.listing.updated', { name: next.name }));
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const publish = useMutation({
    mutationFn: (show: boolean) =>
      call(show ? routes.storefront.publishListing : routes.storefront.unpublishListing, {
        params: { id: listing.id },
        body: { version: listing.version },
      }),
    onSuccess: async (next) => {
      await saved(next);
      toast(
        t(
          next.status === 'published'
            ? 'storefront.listing.published'
            : 'storefront.listing.unpublished',
          { name: next.name },
        ),
      );
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.storefront.deleteListing, {
        params: { id: listing.id },
        query: { version: listing.version },
      }),
    onSuccess: async () => {
      toast(t('storefront.listing.deleted', { name: listing.name }));
      await refresh();
      void navigate({ to: '/storefront/listings' });
    },
  });

  const images = watch('images');
  const saleKind = watch('sale.kind');
  const name = watch('name');
  const slug = watch('slug');
  const seoTitle = watch('seoTitle') ?? '';
  const seoDescription = watch('seoDescription') ?? '';
  const sections = watch('descriptionSections');
  // Save waits until every photo is ready, and a failed one is removed: the API takes ready ones
  const photosBusy = images.some((image) => photos.get(image.id)?.status !== 'ready');
  const warehouse = warehouses?.find((item) => item.id === setup?.shop?.defaultWarehouseId);
  const actionError = publish.error ?? remove.error;
  const shownSlug = slug.trim() === '' ? listing.slug : slug.trim();
  const isPublished = listing.status === 'published';
```

The editor's logic.

- `photos` starts with every saved photo as ready (the API sent its address). `onPhotoState` is a `useCallback`
  with no inputs, so the slots' effects do not run again on every render.
- The resolver is `listingFormSchema(timeZone)`, made once per time zone (`useMemo`).
- `saved` is shared by the save, the publish and the unpublish: it puts the answer in the cache, resets the form to
  it (the new version) and refreshes the menu.
- Publish and unpublish send the version the page read, like every write. The button is disabled while the form has
  changes (decision 41).
- After a delete, the page goes back to the catalog: the listing is gone, and its page would show "doesn't exist".
- `photosBusy` is decision 40.

```tsx
  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="grid gap-2.5">
        <Link
          to="/storefront/listings"
          className="inline-flex items-center gap-1 justify-self-start text-body-sm font-medium text-brand underline-offset-3 hover:underline"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
          {t('storefront.listing.back')}
        </Link>
        <PageHeader
          title={listing.name}
          description={
            <>
              <span className="mb-1.5 flex">
                <ListingStatusPill status={listing.status} />
              </span>
              {t('storefront.listing.fromProduct', {
                name: [listing.product.name, listing.variant.name].filter(Boolean).join(' · '),
                sku: listing.variant.sku,
              })}
              <ShopLine />
            </>
          }
          actions={
            <>
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
                    icon={LinkSquare02Icon}
                    onSelect={() => {
                      window.open(listing.shopUrl, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    {t('storefront.listing.viewInShop')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={Delete02Icon}
                    onSelect={() => {
                      setDeleting(true);
                    }}
                  >
                    {t('storefront.listing.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant={isPublished || isDirty ? 'secondary' : 'primary'}
                disabled={isDirty || publish.isPending}
                title={isDirty ? t('storefront.listing.saveFirst') : undefined}
                onClick={() => {
                  publish.mutate(!isPublished);
                }}
              >
                <HugeiconsIcon
                  icon={isPublished ? FileEditIcon : Store04Icon}
                  size={17}
                  strokeWidth={1.5}
                />
                {isPublished ? t('storefront.listing.unpublish') : t('storefront.listing.publish')}
              </Button>
            </>
          }
        />
        {isDirty && (
          <p className="text-label text-ink-3 sm:text-right">{t('storefront.listing.saveFirst')}</p>
        )}
      </div>
      {actionError && (
        <FormAlert
          message={actionError instanceof ApiRequestError ? actionError.code : 'unknown_error'}
        />
      )}
      {listing.product.status === 'archived' && (
        <DocumentNotice tone="warn" icon={Alert02Icon}>
          {t('storefront.listing.archivedNotice', { name: listing.product.name })}
        </DocumentNotice>
      )}
      {!isPublished && (
        <DocumentNotice tone="neutral">{t('storefront.listing.draftNotice')}</DocumentNotice>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
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
            <CardHeader title={t('storefront.listing.basicsTitle')} />
            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
              <div className="sm:col-span-2">
                <TextField
                  label={t('storefront.listing.name')}
                  hint={t('storefront.listing.nameHint')}
                  {...register('name')}
                  error={errors.name?.message}
                />
              </div>
              <TextField
                label={t('storefront.listing.slug')}
                optional
                prefix="/p/"
                autoComplete="off"
                spellCheck={false}
                placeholder={listing.slug}
                hint={
                  shownSlug !== listing.slug
                    ? t('storefront.listing.slugChangeHint')
                    : t('storefront.listing.slugHint', { slug: shownSlug })
                }
                {...register('slug')}
                error={errors.slug?.message}
              />
              <TextField
                label={t('storefront.listing.packSize')}
                optional
                placeholder={t('storefront.listing.packSizePlaceholder')}
                hint={t('storefront.listing.packSizeHint')}
                {...register('packSize')}
                error={errors.packSize?.message}
              />
              <SelectField
                label={t('storefront.listing.category')}
                icon={FolderLibraryIcon}
                options={storefrontCategoryOptions(categories ?? [])}
                {...register('categoryId')}
                error={errors.categoryId?.message}
              />
              <Controller
                control={control}
                name="badges"
                render={({ field }) => (
                  <CheckboxGroup
                    legend={t('storefront.listing.badges')}
                    options={SHOP_BADGES.map((badge) => ({
                      value: badge,
                      label: t(`storefront.badges.${badge}`),
                    }))}
                    value={field.value}
                    onChange={(next) => {
                      field.onChange(next);
                    }}
                    hint={t('storefront.listing.badgesHint')}
                    error={errors.badges?.message}
                  />
                )}
              />
              <p
                className={
                  listing.inStock === true
                    ? 'flex items-center gap-2 text-body-sm text-good sm:col-span-2'
                    : 'flex items-center gap-2 text-body-sm text-ink-2 sm:col-span-2'
                }
              >
                {listing.inStock !== null && (
                  <HugeiconsIcon
                    icon={listing.inStock ? CheckmarkCircle02Icon : Alert02Icon}
                    size={16}
                    strokeWidth={1.5}
                  />
                )}
                {listing.inStock === null
                  ? t('storefront.listing.noWarehouse')
                  : t(
                      listing.inStock
                        ? 'storefront.listing.inStock'
                        : 'storefront.listing.outOfStock',
                      {
                        warehouse: warehouse?.name ?? '',
                      },
                    )}
              </p>
            </div>
          </Card>

          <PhotosCard
            control={control}
            register={register}
            errors={errors}
            photos={photos}
            onPhotoState={onPhotoState}
          />

          <Card>
            <CardHeader title={t('storefront.listing.priceTitle')} />
            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
              <div className="sm:col-span-2">
                <FormField
                  control={control}
                  name="priceOverride"
                  label={t('storefront.listing.price')}
                  optional
                  hint={
                    listing.variant.salePrice === null
                      ? t('storefront.listing.priceHintNone')
                      : t('storefront.listing.priceHint', {
                          price: money(listing.variant.salePrice),
                        })
                  }
                >
                  {(field) => (
                    <MoneyInput
                      {...field}
                      value={field.value ?? ''}
                      placeholder={plainAmount(listing.variant.salePrice ?? '')}
                    />
                  )}
                </FormField>
              </div>
              <SelectField
                label={t('storefront.listing.sale')}
                options={SALE_FORM_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`storefront.listing.saleKinds.${kind}`),
                }))}
                {...register('sale.kind')}
              />
              {saleKind === 'percent' && (
                <TextField
                  label={t('storefront.listing.saleValues.percent')}
                  inputMode="numeric"
                  autoComplete="off"
                  align="end"
                  suffix="%"
                  placeholder={t('storefront.listing.percentPlaceholder')}
                  {...register('sale.value')}
                  error={errors.sale?.value?.message}
                />
              )}
              {(saleKind === 'amount' || saleKind === 'price') && (
                <FormField
                  control={control}
                  name="sale.value"
                  label={t(`storefront.listing.saleValues.${saleKind}`)}
                >
                  {(field) => <MoneyInput {...field} />}
                </FormField>
              )}
              {saleKind !== 'none' && (
                <>
                  <FormField
                    control={control}
                    name="sale.startsAt"
                    label={t('storefront.listing.saleFrom')}
                    optional
                  >
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                  <FormField
                    control={control}
                    name="sale.endsAt"
                    label={t('storefront.listing.saleUntil')}
                    optional
                  >
                    {(field) => <DatePicker {...field} />}
                  </FormField>
                  <p className="text-label text-ink-3 sm:col-span-2">
                    {t('storefront.listing.saleDatesHint')}
                  </p>
                </>
              )}
            </div>
          </Card>

          <DescriptionCard control={control} register={register} errors={errors} />

          <Card>
            <CardHeader
              title={t('storefront.listing.seoTitle')}
              subtitle={t('storefront.listing.seoHint')}
            />
            <div className="grid gap-5 p-5">
              <TextField
                label={t('storefront.listing.seoPageTitle')}
                optional
                // What the shop uses when the box is empty: the listing's name
                placeholder={name}
                hint={t('storefront.listing.seoCount', {
                  count: seoTitle.length,
                  max: SEO_TITLE_MAX,
                })}
                {...register('seoTitle')}
                error={errors.seoTitle?.message}
              />
              <TextAreaField
                label={t('storefront.listing.seoPageDescription')}
                optional
                // …and the start of the description
                placeholder={sectionsSummary(sections)}
                hint={t('storefront.listing.seoCount', {
                  count: seoDescription.length,
                  max: SEO_DESCRIPTION_MAX,
                })}
                {...register('seoDescription')}
                error={errors.seoDescription?.message}
              />
            </div>
          </Card>

          {isDirty && (
            <SaveBar
              formId={FORM_ID}
              saving={isSubmitting}
              blocked={photosBusy}
              onDiscard={() => {
                reset();
              }}
            />
          )}
        </form>
        <div className="grid gap-5 lg:sticky lg:top-5">
          <PricePreviewCard listing={listing} control={control} timeZone={timeZone} />
        </div>
      </div>

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent
          title={t('storefront.listing.confirmDelete', { name: listing.name })}
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
                {t('storefront.listing.delete')}
              </Button>
            </>
          }
        >
          <p className="text-body-sm text-ink-2">{t('storefront.listing.deleteBody')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

The editor's layout, as in the mockup: the back link, the header (the status pill, the product it sells, the menu,
and "Show in the shop" or "Take out of the shop"), the notices, then the form's five cards beside the price card.

- An archived product's notice is `warn`: the shop hides the listing (26f), whatever its status says, and the owner
  must act. A draft's notice is neutral: being a draft is normal.
- The stock line names the shop's warehouse, so the owner knows where "In stock" was counted.
- The shop price's placeholder is the product's own price, and its hint names it: an empty box uses that price.
- The value box follows the sale's kind: a percent is a plain number box with a `%` suffix (whole numbers 1–99), an
  amount or a price is a money box. The dates show only when there is a sale.
- The SEO boxes' placeholders are what the shop uses when they are empty (the name, the start of the description),
  and their hints count the characters against the limits the contract sets.

```tsx
export function StorefrontListingPage() {
  const { t } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const timeZone = useTimeZone();
  const { listingId = '' } = useParams({ strict: false });
  const { data, error } = useQuery({
    ...storefrontListingQuery(tenantId, listingId),
    enabled: online,
  });

  if (!online) return <StorefrontOffline />;
  if (error) {
    return (
      <p className="text-body-sm text-crit">
        {error instanceof ApiRequestError && error.status === 404
          ? t('storefront.listing.notFound')
          : t('storefront.listing.loadFailed')}
      </p>
    );
  }
  if (!data) return null;
  // key: another listing, or the workspace's time zone arriving after the first paint, starts
  // the form again (its sale days depend on the zone)
  return <ListingEditor key={`${data.id}-${timeZone}`} listing={data} />;
}
```

The page reads the listing and shows "This listing doesn't exist" for a 404 (a deleted listing, or another
workspace's id). The editor's `key` includes the time zone: the workspace's zone may arrive after the first paint,
and the sale's days depend on it.

### `router.tsx` and `routes/app-shell.tsx`

```diff
@@ -1027,6 +1027,45 @@ const auditLogRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/audit-log'), 'AuditLogPage'),
 });
 
+// Step 26g: the Storefront menu (decision 5), behind storefront.manage: the sidebar hides it, and
+// the API refuses the reads for anyone else. '/storefront/listings' is the catalog; a listing's
+// editor sits under it
+const storefrontListingsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/listings',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-catalog'),
+    'StorefrontCatalogPage',
+  ),
+});
+
+const storefrontListingRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/listings/$listingId',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-listing'),
+    'StorefrontListingPage',
+  ),
+});
+
+const storefrontCategoriesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/categories',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-categories'),
+    'StorefrontCategoriesPage',
+  ),
+});
+
+const storefrontSettingsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/settings',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-settings'),
+    'StorefrontSettingsPage',
+  ),
+});
+
 // শুধু `pnpm dev`-এ। production build-এ Vite import.meta.env.DEV-কে false বসায়, minifier পুরো
 // শাখা মুছে দেয় — import() হারায়, তাই kitchen-sink-এর chunk তৈরিই হয় না
 const devRoutes = import.meta.env.DEV
@@ -1170,6 +1209,10 @@ const routeTree = rootRoute.addChildren([
     rolesRoute,
     approvalRulesRoute,
     auditLogRoute,
+    storefrontListingsRoute,
+    storefrontListingRoute,
+    storefrontCategoriesRoute,
+    storefrontSettingsRoute,
     ...devRoutes,
   ]),
 ]);
```

Four lazy routes, one chunk per page. `/storefront/listings` is the catalog and `/storefront/listings/$listingId` its
editor, so the address says where a listing is.

```diff
@@ -18,6 +18,7 @@ import {
   Factory01Icon,
   FileDownloadIcon,
   FileImportIcon,
+  FolderLibraryIcon,
   FolderTreeIcon,
   HourglassIcon,
   Invoice01Icon,
@@ -52,6 +53,7 @@ import {
   ShoppingCart01Icon,
   SquareLock02Icon,
   Store01Icon,
+  Store04Icon,
   TableIcon,
   Tag01Icon,
   TaxesIcon,
@@ -68,6 +70,7 @@ import {
   UserMultiple02Icon,
   UserTime01Icon,
   WarehouseIcon,
+  WebDesign01Icon,
   Wifi01Icon,
   WifiDisconnected02Icon,
   WorkHistoryIcon,
@@ -659,6 +662,21 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               {t('nav.warehouses')}
             </NavLink>
           </NavGroup>
+          {/* Step 26g (decision 5): the online shop, for the people who run it. After Stock, the
+              group the shop sells from */}
+          {can('storefront.manage') && (
+            <NavGroup label={t('nav.storefront')}>
+              <NavLink to="/storefront/listings" icon={Store04Icon}>
+                {t('nav.storefrontCatalog')}
+              </NavLink>
+              <NavLink to="/storefront/categories" icon={FolderLibraryIcon}>
+                {t('nav.storefrontCategories')}
+              </NavLink>
+              <NavLink to="/storefront/settings" icon={WebDesign01Icon}>
+                {t('nav.storefrontSettings')}
+              </NavLink>
+            </NavGroup>
+          )}
           <NavGroup label={t('nav.workspace')}>
             {(can('core.user.read') || can('core.user.invite')) && (
               <NavLink to="/team" icon={UserGroupIcon}>
```

The sidebar's Storefront group, after Stock (the shop sells from a warehouse), only with `storefront.manage`
(decision 5). The icons are ones the sidebar does not use yet, so no two items look alike.

### `scripts/check-bundle-size.ts`

```diff
@@ -16,8 +16,10 @@ import { z } from 'zod';
 // Step 21a: 230 KB (you chose this). The Overview's words and its contract took it to 225.7 KB; the
 // chart and the page are in the Overview's own lazy chunk. Step 21c: 235 KB (you chose this). 21c's
 // words (the VAT and stock movement reports, the scheduled emails) took it to 231.7 KB; the pages
-// and the schedule dialog are their own lazy chunks.
-const INITIAL_BUDGET = 235 * 1024;
+// and the schedule dialog are their own lazy chunks. Step 26g: 240 KB (you chose this). The
+// Storefront menu's words (26g.5) and its sidebar group took it to 237.2 KB; its four pages are
+// lazy chunks.
+const INITIAL_BUDGET = 240 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
@@ -31,8 +33,11 @@ const INITIAL_BUDGET = 235 * 1024;
 // this). The screen takes goods back and pays with a return's money (/pos is 121 KB), so the return
 // dialog with it is 133 KB and the pay dialog 129.5 KB, after the refund rows moved to a file of
 // their own. Step 21b: 140 KB (you chose this). The return dialog went to 135.1 KB without changing:
-// the route table grew by the four reports' schemas, and every page loads the whole table.
-const CHUNK_BUDGET = 140 * 1024;
+// the route table grew by the four reports' schemas, and every page loads the whole table. Step
+// 26g: 150 KB (you chose this). A shop listing's editor is one form of five cards (the photo
+// uploader, the sale with its dates, the description with its preview): 145.9 KB. Loading two of
+// its cards on their own saved only 4 KB, most of the chunk being the route table and form parts.
+const CHUNK_BUDGET = 150 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

Decision 46. The comment keeps the history of the budget, like the earlier steps.

### Check this part

```bash
pnpm --filter @omnivo/i18n build           # the app reads the words from i18n's build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test             # 23 files, 223 tests (13 new in storefront.spec.ts)
pnpm exec eslint apps/app/src apps/app/scripts
pnpm exec prettier --check apps/app
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
```

The pages call the real API. Their mock (MSW) handlers and the browser tests come in 26g.7.

---

## 26g.7 — The mock and the Playwright tests

The twenty Storefront routes get an answer in mock mode, so `pnpm dev:mock` and the Playwright tests can show the four
pages. The mock keeps a shop per workspace with the API's rules: the settings and the launch, the categories, the
listings, and the photos with a pretend image job. Then the tests, on a computer and on a phone. Running them found
three things to fix outside the new files (decisions 50 and 51 below, and the import cycle of decision 52).

Decisions in this part (mine):

47. **Two shops on the mock.** The garments workspace has an open shop, Rahman Fashion, to look around in: categories
    with and without listings, published listings with photos and a sale, a draft with no photo, and listings with no
    stock. The pharma workspace has no shop, so one test can go the whole way: settings, a category, "Add to shop",
    a photo, publish, open. Neither product catalog changes: the shop lists products the mock already has (the polo
    shirt, the T-shirt and two kids' styles; Napa 500 mg), so no older test sees new products.
48. **The pretend image job looks at the real file.** The browser decodes the upload (`createImageBitmap`), so the
    job's limits apply as on the server: a photo under 200 pixels on a side is "too small", a file that is not an
    image is "unreadable". The answer shows 1.5 seconds after "complete", so the editor sees "Preparing the photo…"
    first. A ready photo's address is the uploaded file itself (a `blob:` address); the seeded photos are drawn SVG
    `data:` addresses, so the mock needs no image files.
49. **"nirvor" belongs to another workspace.** The first save with it is refused like a real clash
    (`storefront_subdomain_taken`), so the test can check that path.
50. **The "Add to shop" search box says "Search products".** The ui's `Combobox` uses `searchPlaceholder` as the
    search box's name too. 26g.6 passed "Name or SKU", so a screen reader heard "Name or SKU, combobox" with no word of
    what it searches. The customer box passes "Search customers"; the catalog now passes `storefront.add.searchLabel`
    the same way. One line in `storefront-catalog.tsx`.
51. **Older tests open Settings by its exact name.** 26g.6 added "Shop settings" to the nav, and `openFromNav(page,
    'Settings')` matches part of a name, so it found two links and failed (6 tests in 5 files). They pass
    `/^Settings$/` now, the way 17d's tests tell "Refunds" from "Supplier refunds".
52. **The seed in its own file.** `storefront-data.ts` uses `workspace-data.ts`'s `record()`, and `workspace-data.ts`
    makes and seeds the shop. In one file that is an import cycle, which `pnpm boundaries` refuses. So the shapes the
    mock keeps, the empty shop and the seed live in `storefront-seed.ts`, which imports `WorkspaceData` as a type only,
    like 21c's `report-schedule-seed.ts`.

### `apps/app/src/mocks/storefront-seed.ts` (new): what the mock keeps, and Rahman Fashion

```ts
import {
  type ShopPaymentMethod,
  slugFromName,
  type StorefrontCategory,
  type StorefrontImage,
  type StorefrontListing,
  type StorefrontSale,
  type StorefrontSection,
  type StorefrontSettings,
  type StorefrontUpload,
} from '@omnivo/contracts';

import { findVariant } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// Step 26g: what the mock keeps of the online shop, and the garments workspace's open shop. A file
// of its own with a type import only of workspace-data.ts, which makes and seeds the shop: the
// rules (storefront-data.ts) import workspace-data.ts's record(), so one file would be an import
// cycle (21c's report-schedule-seed.ts does the same).
//
// The garments workspace has Rahman Fashion, open for 12 days: Men (Polo shirts, T-shirts), Women
// (empty) and Kids; two navy polo shirts and a T-shirt in the shop, a white polo shirt as a draft
// with no photo, and two kids' styles with no stock in the Main store. The pharma workspace has
// no shop, so a test can set one up from the start and open it.

// The settings row, as the table keeps it: readiness and the shop's address are worked out on read
export type MockShop = Omit<StorefrontSettings, 'shopUrl' | 'readiness'>;

export type MockCategory = Omit<StorefrontCategory, 'listingCount'>;

export interface MockListing {
  id: string;
  productId: string;
  variantId: string;
  categoryId: string;
  slug: string;
  name: string;
  packSize: string;
  // 4 decimals, as Postgres keeps money ("299.0000"); null = the variant's sale price
  priceOverride: string | null;
  sale: StorefrontSale | null;
  badges: StorefrontListing['badges'];
  images: StorefrontImage[];
  descriptionSections: StorefrontSection[];
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  version: number;
  updatedAt: string;
}

// One uploaded photo, from its upload address to the job's answer (26g.2's storefront_images row
// plus the attachment). `url` is the uploaded file itself, standing in for the job's small WebP;
// `outcome` is what the pretend job found when the file arrived, shown once readyAt has passed
export interface MockPhoto {
  id: string;
  contentType: string;
  sizeBytes: number;
  url: string | null;
  outcome:
    | { kind: 'ready'; width: number; height: number }
    | { kind: 'failed'; code: Extract<StorefrontUpload, { status: 'failed' }>['code'] }
    | null;
  // null until "complete": the attachment is still pending, and the screen sees "uploading"
  readyAt: number | null;
}

export interface MockStorefront {
  shop: MockShop | null;
  categories: MockCategory[];
  listings: MockListing[];
  photos: Map<string, MockPhoto>;
}

export function emptyStorefront(): MockStorefront {
  return { shop: null, categories: [], listings: [], photos: new Map() };
}
```

The shapes, close to the tables.

- `MockShop` is the settings answer without `shopUrl` and `readiness`: both are worked out on every read, as the API
  does, so a new published listing ticks the checklist without anyone updating a stored flag.
- `MockCategory` has no `listingCount` for the same reason: it is counted from the listings on read.
- `MockListing` keeps the price and the sale as the table keeps them: `priceOverride` with 4 decimals ("299.0000"),
  and `null` meaning "the variant's sale price". The variant itself is looked up in the catalog each time, so an
  archived product shows in the editor at once.
- `MockPhoto` is the attachment plus 26g.2's `storefront_images` row. `readyAt` is `null` until "complete": the
  screen then sees `uploading`, like a pending attachment with no job row. `outcome` is what the pretend job found
  in the file; it shows only once `readyAt` has passed.
- `photos` is a `Map` per workspace: a photo id from the other workspace is "not found", as RLS makes it on the
  server.

```ts
// A drawn packshot for a seeded photo: the garment's colour behind its name. A data: address, so it
// needs no file and no network; an uploaded photo has the file itself
function packshot(label: string, colour: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="#F1F3F6"/><path d="M210 140l-90 50 40 90 40-20v220h200V260l40 20 40-90-90-50c-10 30-40 50-90 50s-80-20-90-50z" fill="${colour}"/><text x="300" y="560" font-family="sans-serif" font-size="30" text-anchor="middle" fill="#475467">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// What a listing without a known photo shows (a seeded listing's photo is always known)
export const PLACEHOLDER = packshot('', '#D0D5DD');

function seedPhoto(
  data: WorkspaceData,
  label: string,
  colour: string,
  alt: string,
): StorefrontImage {
  const id = crypto.randomUUID();
  data.storefront.photos.set(id, {
    id,
    contentType: 'image/svg+xml',
    sizeBytes: 0,
    url: packshot(label, colour),
    outcome: { kind: 'ready', width: 600, height: 600 },
    readyAt: 0,
  });
  return { id, alt };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

const POLO_SECTIONS: StorefrontSection[] = [
  {
    heading: 'Fabric',
    body: '- 100% combed cotton pique, 220 GSM\n- Knitted and dyed at our Gazipur factory',
  },
  {
    heading: 'Care',
    body: 'Machine wash cold with like colours. Do not bleach. **Iron on the reverse.**',
  },
];
```

The drawn photos. `packshot()` writes a small SVG (a shirt in the garment's colour and its name under it) as a
`data:` address. It passes the contract's `z.url()` like any address, needs no file in the repo and no network, and
an `<img>` shows it. `seedPhoto()` stores it as a ready photo of 600 × 600, so the editor shows it like an uploaded
one. `PLACEHOLDER` is what a listing would show for a photo the mock does not know; the seed never makes one, but
`viewOf()` needs an answer for the type checker.

```ts
export function seedStorefront(data: WorkspaceData, garments: boolean): void {
  if (!garments) return;
  const main = data.stock.warehouses.find((place) => place.code === 'MAIN');
  const payments: ShopPaymentMethod[] = ['cod', 'online'];
  data.storefront.shop = {
    subdomain: 'rahman-fashion',
    name: 'Rahman Fashion',
    language: 'en',
    hotline: '09612-345678',
    address: 'House 42, Road 11, Banani, Dhaka 1213',
    facebookUrl: 'https://facebook.com/rahmanfashion',
    instagramUrl: 'https://instagram.com/rahmanfashion',
    xUrl: null,
    linkedinUrl: null,
    defaultWarehouseId: main?.id ?? null,
    deliveryZones: [
      { id: 'zone-1a2b3c4d', name: 'Inside Dhaka', charge: '80.0000' },
      { id: 'zone-5e6f7a8b', name: 'Outside Dhaka', charge: '120.0000' },
    ],
    freeDeliveryFrom: '2000.0000',
    minimumOrder: null,
    paymentMethods: payments,
    launchedAt: daysAgo(12),
    version: 4,
    updatedAt: daysAgo(3),
  };

  const category = (
    name: string,
    slug: string,
    position: number,
    parentId: string | null = null,
  ) => {
    const item: MockCategory = {
      id: crypto.randomUUID(),
      parentId,
      slug,
      name,
      position,
      version: 1,
      updatedAt: daysAgo(12),
    };
    data.storefront.categories.push(item);
    return item;
  };
  // Men holds two categories (it cannot be deleted); Kids holds listings (nor can it); Women is
  // empty, the one a test can delete
  const men = category('Men', 'men', 1);
  const polos = category('Polo shirts', 'polo-shirts', 1, men.id);
  const tees = category('T-shirts', 't-shirts', 2, men.id);
  category('Women', 'women', 2);
  const kids = category('Kids', 'kids', 3);

  const byCode = (code: string) => data.catalog.products.find((product) => product.code === code);
  const polo = byCode('ST-118');
  const tee = byCode('P-00001');
  const listing = (
    variantId: string | undefined,
    fields: Partial<MockListing> & Pick<MockListing, 'name' | 'slug' | 'categoryId'>,
    minutesAgo: number,
  ) => {
    const found = variantId === undefined ? undefined : findVariant(data, variantId);
    if (!found) return;
    data.storefront.listings.push({
      id: crypto.randomUUID(),
      productId: found.product.id,
      variantId: found.variant.id,
      packSize: '',
      priceOverride: null,
      sale: null,
      badges: [],
      images: [],
      descriptionSections: [],
      seoTitle: null,
      seoDescription: null,
      publishedAt: daysAgo(12),
      version: 3,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ...fields,
    });
  };
  // The polo's variant of a size and a colour (its options are Size, then Colour)
  const poloIn = (size: string, colour: string) =>
    polo?.variants.find((item) => item.optionValues.join('|') === `${size}|${colour}`)?.id;
  listing(
    poloIn('M', 'Navy blue'),
    {
      name: 'Pique polo shirt · Navy blue · M',
      slug: 'pique-polo-navy-m',
      categoryId: polos.id,
      packSize: 'Size M',
      sale: { kind: 'percent', value: '10', startsAt: null, endsAt: null },
      badges: ['most_picked'],
      images: [
        seedPhoto(data, 'Pique polo · Navy', '#1F2A44', 'Navy blue pique polo shirt, front'),
        seedPhoto(data, 'Pique polo · Back', '#1F2A44', 'Navy blue pique polo shirt, back'),
      ],
      descriptionSections: POLO_SECTIONS,
    },
    20,
  );
  listing(
    poloIn('L', 'Navy blue'),
    {
      name: 'Pique polo shirt · Navy blue · L',
      slug: 'pique-polo-navy-l',
      categoryId: polos.id,
      packSize: 'Size L',
      images: [seedPhoto(data, 'Pique polo · Navy', '#1F2A44', 'Navy blue pique polo shirt')],
      descriptionSections: POLO_SECTIONS,
    },
    45,
  );
  // A draft with no photo yet: it cannot be shown until one is added
  listing(
    poloIn('M', 'White'),
    {
      name: 'Pique polo shirt · White · M',
      slug: 'pique-polo-white-m',
      categoryId: polos.id,
      packSize: 'Size M',
      publishedAt: null,
      version: 1,
    },
    5,
  );
  listing(
    tee?.variants[0]?.id,
    {
      name: 'Basic crew-neck T-shirt',
      slug: 'basic-crew-neck-t-shirt',
      categoryId: tees.id,
      packSize: '160 GSM cotton',
      priceOverride: '299.0000',
      badges: ['new'],
      images: [seedPhoto(data, 'Crew-neck T-shirt', '#8A94A6', 'Grey crew-neck T-shirt')],
    },
    90,
  );
  // Two kids' styles with no stock in the Main store: "Out of stock" in the catalog
  for (const [code, colour, minutes] of [
    ['ST-20003', '#B25E09', 120],
    ['ST-20007', '#0A7A4B', 150],
  ] as const) {
    const product = byCode(code);
    if (!product) continue;
    listing(
      product.variants[0]?.id,
      {
        name: product.name,
        slug: slugFromName(product.name),
        categoryId: kids.id,
        images: [seedPhoto(data, product.name, colour, product.name)],
      },
      minutes,
    );
  }
}
```

The seed, garments only.

- The shop has been open 12 days, with two zones, free delivery from ৳2,000 and both ways to pay. Its warehouse is the
  Main store, where the polo shirts and the T-shirt have stock (13's seed); the kids' styles have none there, so the
  catalog shows "Out of stock" without a special case.
- The categories are picked for the tests: Men has categories under it (`category_has_children`), Kids has listings
  (`storefront_category_in_use`), and Women is empty, the one a test can delete.
- `poloIn()` finds the polo shirt's variant by its options, "M|Navy blue" (Size, then Colour). Looking up by the option
  values, not by an index, keeps the seed right if the catalog's option order ever changes.
- The navy M has a 10% sale with no dates, a badge and two description sections, so the editor has every card filled
  in. The white M is a draft with no photo: the test that refuses to publish without a photo uses it.
- `listing()` skips a variant it cannot find instead of throwing: a missing seed row must not stop `pnpm dev:mock`.

### `apps/app/src/mocks/storefront-data.ts` (new): the API's rules

```ts
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
```

The shop's address is made the way the API makes it in dev (`shop-url.ts`: `http`, `SHOP_BASE_DOMAIN=localhost`,
port 4321), so "View shop" shows the same address `pnpm dev` would. `OTHER_SHOPS` stands in for the other
workspaces' rows in the unique index (decision 49). `MOCK_PREPARE_MS` is shorter than the editor's 2-second poll, so
its first question after the upload already finds the photo ready and the test does not wait long. `fieldProblem()`
is the API's error that names a box: the page puts it under that box.

```ts
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
```

The settings and the launch, line for line like `settings.service.ts`.

- `readinessOf()` is the checklist: an active warehouse, at least one zone, and one listing the shop would show
  (published, its product and variant not archived). It reads the current data each time.
- `setupOf()` suggests the workspace's slug only when it can be a subdomain, and the company's name, phone and
  address. The pharma workspace has no phone or address in its settings, so the test sees empty Hotline and Address
  boxes and fills them.
- `zoneIds()` keeps a saved zone's id and names a new one `zone-` and 8 hex characters, so a shopper's cart that
  remembers a zone keeps working after a rename.
- `fieldsOf()` stores money with 4 decimals (`addMoney(value, '0')`), as Postgres does. The form then shows "80", not
  "80.0000", through `plainAmount()` from 26g.6, so the mock tests that path too.
- `updateShop()` checks the version first, like every save, then the open shop's two rules (a warehouse and a zone),
  then only a new warehouse and a new subdomain: a saved warehouse that was archived since stays until someone
  picks another, as on the server.
- `launchShop()` returns the shop as it is on a second click, and refuses with `storefront_launch_not_ready` when the
  checklist is not done. The page never sends that (its button is disabled), but a stale tab could.
- Each save writes the API's audit row with the same snapshot, so the audit log page shows the same lines in mock mode.

```ts
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
```

The categories, like `categories.service.ts`.

- `byPlace()` is the API's order: position, then name, then id, so two rows never tie and the tree is the same on
  every read.
- `assertCategoryFree()` is the two unique indexes: the slug in the whole workspace, the name among its siblings in
  any case.
- `updateCategory()` walks up from the new parent; meeting the category itself means it would go under itself
  (`category_parent_loop`). A new parent puts the category at the end of that parent's list.
- `moveCategory()` numbers the siblings 1, 2, 3… in their order, swaps two, and gives a new version only to the rows
  whose number changed. Like the API, a move at the top or the bottom does nothing and answers the list.
- `removeCategory()` refuses a category with categories under it or listings in it, the two foreign keys the API maps
  to these codes.

```ts
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
```

The photos and the pretend job (decision 48).

- `startUpload()` makes the upload's row; the handler builds the upload address in the mock's storage.
- `receivePhoto()` is the PUT to storage. It keeps the file as a `blob:` address and decodes it at once
  (`inspect()`), so the job's answer is known before "complete". `createImageBitmap` throws on a file that is not an
  image: that is `storefront_image_unreadable`. The pixel limit is checked before the side, as the job does, so a
  huge image never reads as "too small".
- `stateOf()` turns the row into the screen's union: `uploading` before "complete", `processing` until `readyAt`,
  then `ready` with the size, or `failed` with the job's code.
- `completeUpload()` refuses before the file is there (`upload_incomplete`), and a second "complete" keeps the first
  `readyAt` (`??=`), like the API's insert that does nothing on a conflict.
- `isReady()` is what a listing's save asks of a new photo.

```ts
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
```

The listings' reads, like `listings.service.ts`.

- `stockOf()` is the shop's rule for "in stock": more than nothing of the variant in the shop's warehouse, from the
  stock movements (`balancesOf()`). `null` while the shop has no warehouse, which the catalog shows as "No warehouse".
- `toSummary()` works the price out with `listingPricing()`, the shop's own function, so the catalog's price column,
  the editor's preview and the shop agree.
- `SORTS` is a `Record` over the contract's sorts, so a new sort without a line here does not compile. The name sorts
  use the first 60 characters without case, then the id, like the API's cursor.
- `listingPage()` filters by status, category and a search in the name, the slug and the SKU, then pages with the
  offset cursor the other mock lists use (`pageOf()`).
- `candidatePage()` lists active goods not in the shop yet. The garments catalog has about 17,500 variants; one pass
  with a sort is a few milliseconds, so the mock needs no index. Each match keeps its sort key beside it, so the
  answer has only the contract's fields.
- `freeSlug()` is the API's: the name's slug, else the SKU's, else "listing", then the first of `-2`, `-3`… that is
  free, cut so the number still fits in 100 characters.

```ts
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
```

The listings' writes.

- `createListing()` refuses a service or an unknown variant on the product box (`required`), an archived one, a
  category that is not the shop's, and a variant that is listed already. The name is the product's and the
  variant's options, like the API.
- `updateListing()` checks in the API's order: the version, the category, then each new photo (one error per photo,
  on its own box: `images.0`), then a published listing keeps a photo and a price, then the sale. The sale is
  checked without its dates, so one that starts next week must already take something off. The slug last, as the
  unique index would.
- `saleToKeep()` stores an amount with 4 decimals and a percent as typed, and the dates as UTC: what the table gives
  back, so the form's round trip is tested too.
- `setPublished()` returns the listing as it is when it is already so (a second click), and refuses to publish an
  archived product, a listing with no photo or one with no price.

### `apps/app/src/mocks/workspace-data.ts`: the shop in every workspace

```diff
@@ -57,6 +57,7 @@ import {
   seedSalesDocuments,
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
+import { emptyStorefront, type MockStorefront, seedStorefront } from './storefront-seed';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
 import { emptySync, type MockSync, seedDevices } from './sync-data';
 import { seedTradeHistory } from './trade-history-data';
@@ -110,6 +111,8 @@ export interface WorkspaceData {
   pos: MockPos;
   // Step 21c: the scheduled report emails, in the order they were made (report-schedule-data.ts)
   reportSchedules: MockReportSchedule[];
+  // Step 26g: the online shop: its settings, categories, listings and photos (storefront-data.ts)
+  storefront: MockStorefront;
 }
 
 function now(): string {
@@ -202,6 +205,7 @@ function seed(workspace: Workspace): WorkspaceData {
     sync: emptySync(),
     pos: emptyPos(),
     reportSchedules: [],
+    storefront: emptyStorefront(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   data.salesAccounts = seedSalesAccounts(data.accounts);
@@ -233,6 +237,8 @@ function seed(workspace: Workspace): WorkspaceData {
   // scheduled emails of the mockup, after the team and the warehouses they name
   if (garments && seedsVatMonth()) seedVatMonth(data);
   if (garments) seedReportSchedules(data);
+  // Step 26g: after the stock (the shop counts in the Main store) and the catalog it lists from
+  seedStorefront(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -302,6 +308,8 @@ export function startFresh(workspace: Workspace, companyName: string): void {
   data.sync = emptySync();
   // A new shop adds its counters in Settings → POS registers
   data.pos = emptyPos();
+  // Step 26g: and sets up its online shop in Shop settings
+  data.storefront = emptyStorefront();
   // Sign-up gives a new workspace its Main store, in its one branch (like auth.service.ts)
   data.stock = emptyStock();
   const [first] = data.branches;
```

`storefront` joins `WorkspaceData`, empty at first. The seed runs after the stock and the catalog, which it reads (the
Main store and the products). A workspace made by the mock's sign-up starts with no shop, like a real new workspace.

### `apps/app/src/mocks/handlers.ts`

```diff
@@ -167,6 +167,28 @@ import {
   salesReportOf,
 } from './trade-report-data';
 import { stockMovementOf, vatDocumentsOf, vatReportOf } from './vat-stock-report-data';
+import {
+  candidatePage,
+  categoryList,
+  completeUpload,
+  createCategory,
+  createListing,
+  createShop,
+  launchShop,
+  listingOf,
+  listingPage,
+  moveCategory,
+  receivePhoto,
+  removeCategory,
+  removeListing,
+  setPublished,
+  setupOf,
+  startUpload,
+  updateCategory,
+  updateListing,
+  updateShop,
+  uploadState,
+} from './storefront-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -436,6 +458,15 @@ function guarded(resolver: HttpResponseResolver): HttpResponseResolver {
   };
 }
 
+// Step 26g: every Storefront route needs storefront.manage, like the API's guard. The owner has it;
+// a test's role (fixtures.ts → MOCK_ROLE_KEY) may not
+function shopData(): WorkspaceData {
+  if (!me().permissions.includes('storefront.manage')) {
+    throw new MockProblem(403, 'permission_missing');
+  }
+  return current();
+}
+
 // audit-এর "আগের মান" — ফর্মের ঘরগুলো
 function editable(settings: Settings) {
   return {
```

The imports, and `shopData()`: every Storefront route needs `storefront.manage`, like the API's guard. The owner has
it; a test's role (`actAs`, 21a) may not, and then the route answers 403 `permission_missing`. It returns the current
workspace's data, so each handler is one line shorter.

```diff
@@ -5595,4 +5626,221 @@ export const handlers = [
       return reply(routes.posReturns.getReturn, toPosReturn(data, findPosReturn(data, id)));
     }),
   ),
+
+  // --- Step 26g: the Storefront menu (storefront-data.ts) ---------------------------------------
+
+  mock(
+    routes.storefront.getSettings,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.storefront.getSettings, setupOf(data, workspace));
+    }),
+  ),
+
+  mock(
+    routes.storefront.createSettings,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefront.createSettings.body, request);
+      return reply(routes.storefront.createSettings, createShop(data, workspace.tenantId, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.updateSettings,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefront.updateSettings.body, request);
+      return reply(routes.storefront.updateSettings, updateShop(data, workspace.tenantId, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.launch,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const { version } = await readBody(routes.storefront.launch.body, request);
+      return reply(routes.storefront.launch, launchShop(data, workspace.tenantId, version));
+    }),
+  ),
+
+  mock(
+    routes.storefront.listCategories,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.storefront.listCategories, { items: categoryList(data) });
+    }),
+  ),
+
+  mock(
+    routes.storefront.createCategory,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefront.createCategory.body, request);
+      return reply(routes.storefront.createCategory, createCategory(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.updateCategory,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.updateCategory.params.parse(params);
+      const body = await readBody(routes.storefront.updateCategory.body, request);
+      return reply(routes.storefront.updateCategory, updateCategory(data, id, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.moveCategory,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.moveCategory.params.parse(params);
+      const { direction, version } = await readBody(routes.storefront.moveCategory.body, request);
+      return reply(routes.storefront.moveCategory, {
+        items: moveCategory(data, id, direction, version),
+      });
+    }),
+  ),
+
+  mock(
+    routes.storefront.deleteCategory,
+    guarded(({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.deleteCategory.params.parse(params);
+      const { version } = readQuery(routes.storefront.deleteCategory.query, request);
+      removeCategory(data, id, version);
+      return reply(routes.storefront.deleteCategory, undefined);
+    }),
+  ),
+
+  // A photo goes up like the logo: an upload address in the mock's storage, then "complete". The
+  // pretend job answers MOCK_PREPARE_MS later (storefront-data.ts)
+  mock(
+    routes.storefront.createUpload,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefront.createUpload.body, request);
+      const id = startUpload(data, body);
+      return reply(routes.storefront.createUpload, {
+        image: { id, status: 'uploading' },
+        upload: {
+          method: 'PUT',
+          url: `${MOCK_STORAGE}/storefront/${id}`,
+          headers: { 'content-type': body.contentType },
+          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
+        },
+      });
+    }),
+  ),
+
+  // Storage, not a contract route (like the logo's PUT above)
+  http.put(`${MOCK_STORAGE}/storefront/:id`, async ({ request, params }) => {
+    const id = typeof params.id === 'string' ? params.id : '';
+    if (!(await receivePhoto(current(), id, await request.blob()))) {
+      return new HttpResponse(null, { status: 404 });
+    }
+    await delay(400);
+    return new HttpResponse(null, { status: 200 });
+  }),
+
+  mock(
+    routes.storefront.completeUpload,
+    guarded(({ params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.completeUpload.params.parse(params);
+      return reply(routes.storefront.completeUpload, completeUpload(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefront.getUpload,
+    guarded(({ params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.getUpload.params.parse(params);
+      return reply(routes.storefront.getUpload, uploadState(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefront.listListings,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const query = readQuery(routes.storefront.listListings.query, request);
+      await delay();
+      return reply(routes.storefront.listListings, listingPage(data, query));
+    }),
+  ),
+
+  mock(
+    routes.storefront.listCandidates,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const query = readQuery(routes.storefront.listCandidates.query, request);
+      await delay();
+      return reply(routes.storefront.listCandidates, candidatePage(data, query));
+    }),
+  ),
+
+  mock(
+    routes.storefront.createListing,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefront.createListing.body, request);
+      return reply(routes.storefront.createListing, createListing(data, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.getListing,
+    guarded(async ({ params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.getListing.params.parse(params);
+      await delay();
+      return reply(routes.storefront.getListing, listingOf(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefront.updateListing,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.updateListing.params.parse(params);
+      const body = await readBody(routes.storefront.updateListing.body, request);
+      return reply(routes.storefront.updateListing, updateListing(data, id, body));
+    }),
+  ),
+
+  mock(
+    routes.storefront.publishListing,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.publishListing.params.parse(params);
+      const { version } = await readBody(routes.storefront.publishListing.body, request);
+      return reply(routes.storefront.publishListing, setPublished(data, id, version, true));
+    }),
+  ),
+
+  mock(
+    routes.storefront.unpublishListing,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.unpublishListing.params.parse(params);
+      const { version } = await readBody(routes.storefront.unpublishListing.body, request);
+      return reply(routes.storefront.unpublishListing, setPublished(data, id, version, false));
+    }),
+  ),
+
+  mock(
+    routes.storefront.deleteListing,
+    guarded(({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefront.deleteListing.params.parse(params);
+      const { version } = readQuery(routes.storefront.deleteListing.query, request);
+      removeListing(data, id, version);
+      return reply(routes.storefront.deleteListing, undefined);
+    }),
+  ),
 ];
```

The twenty routes, each a thin wrapper: parse the request with the contract's own schema (`readBody`, `readQuery`,
`params.parse`), call the rule in `storefront-data.ts`, and answer through `reply()`, which checks the answer against
the contract's response schema. A rule that throws `MockProblem` becomes the API's problem answer (`guarded`). The
reads wait a moment (`delay()`), so the pages' loading states show in `pnpm dev:mock`.

- The photo's upload address is in the mock's storage under `storefront/<id>`, a path of its own: the logo's PUT
  handler takes `/:id`, one segment, so the two never catch each other's requests.
- The PUT handler reads the file as a `Blob` and hands it to `receivePhoto()`. An id the workspace does not have
  answers 404, as storage would for a wrong signed address.

### `apps/app/src/routes/storefront-catalog.tsx`: the search box's name

```diff
@@ -188,7 +188,9 @@ function AddDialog({ onDone }: { onDone: () => void }) {
               loading={candidates.isFetching}
               icon={PackageIcon}
               placeholder={t('storefront.add.productPlaceholder')}
-              searchPlaceholder={t('storefront.add.searchPlaceholder')}
+              // The search box's name too (the ui's Combobox), so it says what it searches,
+              // like the customer box's "Search customers"
+              searchPlaceholder={t('storefront.add.searchLabel')}
               emptyText={t('storefront.add.noMatch')}
             />
           )}
```

Decision 50. The words "Search products" were in `en.ts` and `bn.ts` since 26g.5 but not used. Now "Name or SKU"
(`storefront.add.searchPlaceholder`) was the unused one, so 26g.8 took it out of both files (26g.5's diff of the
words no longer shows it).

### `apps/app/e2e/storefront.e2e.ts` (new)

```ts
import { crc32, deflateSync } from 'node:zlib';

import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  pinAnswered,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 26g: the Storefront menu on the mock (mocks/storefront-data.ts). The garments workspace has
// an open shop, Rahman Fashion: Men (Polo shirts, T-shirts), Women (empty) and Kids, two navy polo
// shirts and a T-shirt in the shop, a white polo shirt as a draft with no photo, and two kids'
// styles with no stock. The pharma workspace has no shop yet.

// A real PNG of one grey colour, for the photo upload. The mock decodes it in the browser like the
// image job does with sharp, so its size decides: 200 pixels or more on each side is a photo the
// shop can use, less is "too small". Built here so the test needs no file on disk
function png(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const name = Buffer.from(type, 'ascii');
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(Buffer.concat([name, body])));
    return Buffer.concat([length, name, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 bits per channel, RGB; compression, filter and interlace stay 0
  header[8] = 8;
  header[9] = 2;
  // Each row starts with its filter byte (0 = none), then 3 bytes a pixel
  const row = Buffer.alloc(1 + width * 3, 0xd0);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
}

async function openListing(page: Page, name: string): Promise<void> {
  await openFromNav(page, 'Catalog');
  await listItem(page, new RegExp(name)).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}
```

The helpers.

- `png()` writes a real PNG of one colour in memory: the 8-byte signature, an `IHDR` chunk with the size (8 bits, RGB),
  one `IDAT` chunk of the rows (each row starts with its filter byte, 0), and `IEND`. Each chunk ends with a CRC-32 of
  its name and body, which Node's `zlib.crc32` gives (Node 22.2 and later). A real image is needed because the mock
  decodes it (decision 48): its size decides whether the photo is ready or too small. Made in the test, so the repo
  needs no image file.
- `openListing()` opens a listing from the catalog by its row (a card on a phone, `listItem`).

```ts
test('sets up a shop from nothing, fills it and opens it', async ({ page }) => {
  // Four pages and a photo the job prepares: more than the usual 30 seconds on a busy machine
  test.slow();
  await start(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  // The catalog waits for the settings
  await openFromNav(page, 'Catalog');
  await expect(page.getByText('Set up the shop first')).toBeVisible();
  await page.getByRole('button', { name: 'Go to shop settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop settings' })).toBeVisible();

  // The form starts from the workspace: its slug and its name
  await expect(page.getByText(/^The shop is not set up yet\./)).toBeVisible();
  await expect(page.getByLabel('Shop address')).toHaveValue('karim-pharma');
  await expect(page.getByLabel('Shop name')).toHaveValue('Karim Pharma');
  await expect(page.getByRole('button', { name: 'Open the shop' })).toBeDisabled();
  await expectNoSideScroll(page);

  await page.getByLabel('Shop address').fill('nirvor');
  await page.getByLabel('Hotline').fill('09612-777888');
  await page.getByLabel('Address', { exact: true }).fill('Tejgaon Industrial Area, Dhaka 1208');
  await page.getByLabel('Warehouse for the shop').selectOption({ label: 'MAIN · Main store' });
  const zone = page.getByRole('group', { name: 'Zone 1' });
  await zone.getByLabel('Zone', { exact: true }).fill('Inside Dhaka');
  await zone.getByLabel('Charge').fill('80');
  await page.getByRole('button', { name: 'Set up the shop' }).click();
  // Another workspace's shop has that address: the API's answer, under the box
  await expect(page.getByText(/^Another shop has this address\./)).toBeVisible();

  await page.getByLabel('Shop address').fill('karim-pharmacy');
  await page.getByRole('button', { name: 'Set up the shop' }).click();
  await toastShown(page, 'Shop set up. Open it when the checklist is done.');
  // Two of three done: a listing in the shop is still missing
  await expect(page.getByText('Not done yet')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open the shop' })).toBeDisabled();

  await openFromNav(page, 'Shop categories');
  await expect(page.getByText('No shop categories yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add category' }).first().click();
  const categoryDialog = page.getByRole('dialog', { name: 'Add a shop category' });
  await categoryDialog.getByLabel('Name', { exact: true }).fill('Pain relief');
  // An empty link name is made from the name
  await expect(categoryDialog.getByText('/c/pain-relief')).toBeVisible();
  await categoryDialog.getByRole('button', { name: 'Add category' }).click();
  await toastShown(page, 'Pain relief added');

  await openFromNav(page, 'Catalog');
  await expect(page.getByText('Nothing in the shop yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add to shop' }).first().click();
  const addDialog = page.getByRole('dialog', { name: 'Add a product to the shop' });
  await addDialog.getByRole('button', { name: 'Product', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search products' }).fill('napa');
  await page.getByRole('option', { name: /Napa 500 mg/ }).click();
  await addDialog.getByLabel('Shop category').selectOption({ label: 'Pain relief' });
  await addDialog.getByRole('button', { name: 'Add to shop' }).click();
  await toastShown(page, 'Napa 500 mg added as a draft');
  await expect(page.getByRole('heading', { level: 1, name: 'Napa 500 mg' })).toBeVisible();
  await expect(
    page.getByText('This listing is a draft, so the shop does not show it.'),
  ).toBeVisible();
  // No shop price of its own: the product's sale price
  await expect(
    page.getByText('Leave it empty to use the product’s sale price, ৳1.20.'),
  ).toBeVisible();

  // The photo: uploaded, then prepared by the job, then ready to describe
  await page.locator('input[type="file"]').setInputFiles({
    name: 'napa-strip.png',
    mimeType: 'image/png',
    buffer: png(400, 300),
  });
  const photo = page.getByRole('group', { name: 'Photo 1' });
  await expect(photo.getByRole('status')).toBeVisible();
  // Save waits for a photo that is not ready
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expect(photo.getByText('On the shop’s card')).toBeVisible({ timeout: 10_000 });
  await photo.getByLabel('What the photo shows').fill('Napa 500 mg, a strip of 10 tablets');
  // The publish button waits for the form: the server publishes what is saved
  await expect(page.getByRole('button', { name: 'Show in the shop' })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to Napa 500 mg saved');

  await page.getByRole('button', { name: 'Show in the shop' }).click();
  await toastShown(page, 'Napa 500 mg is in the shop');
  await expect(page.getByText('In the shop', { exact: true }).first()).toBeVisible();

  await openFromNav(page, 'Shop settings');
  await expect(page.getByText('Not done yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the shop' }).click();
  const openDialog = page.getByRole('dialog', { name: 'Open Karim Pharma?' });
  await expect(
    openDialog.getByText(/^http:\/\/karim-pharmacy\.localhost:4321 starts/),
  ).toBeVisible();
  await openDialog.getByRole('button', { name: 'Open the shop' }).click();
  await toastShown(page, 'Karim Pharma is open');
  await expect(page.getByRole('heading', { name: 'The shop is open' })).toBeVisible();
  await expect(page.getByText(/at http:\/\/karim-pharmacy\.localhost:4321$/)).toBeVisible();
});
```

The whole way on the pharma workspace.

- `test.slow()`: four pages and a photo the job prepares take more than the usual 30 seconds on a busy machine.
- The catalog first: with no shop it says "Set up the shop first" and sends to the settings.
- The form starts from the workspace (its slug, its name). The pharma workspace has no phone or address in its
  settings, so the test fills Hotline and Address, which the shop needs.
- "nirvor" comes back from the mock as taken, under the box (decision 49). Then the save works, and the checklist
  shows one step not done: the listing.
- The category's link name is made from the name while the box is empty ("/c/pain-relief" in the hint).
- "Add to shop": the combobox, by its new name (decision 50), finds Napa; the editor says the price comes from the
  product (৳1.20).
- The photo: `setInputFiles` with a 400 × 300 PNG. First a `role="status"` line (uploading, then preparing), and Save
  is disabled meanwhile; then the "On the shop's card" tag shows that the photo is ready. "Show in the shop" is
  disabled until the form is saved. Then publish, then the checklist is all done, and the shop opens at its address.

```ts
test('finds listings by name, status and category', async ({ page, context }) => {
  await start(page);
  await openFromNav(page, 'Catalog');
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByLabel('Search the catalog').fill('polo');
  await expect(listItem(page, /Pique polo shirt/)).toHaveCount(3);
  await page.getByText('Drafts', { exact: true }).click();
  await expect(listItem(page, /Pique polo shirt/)).toHaveCount(1);
  await expect(listItem(page, /White · M/)).toContainText('Draft');

  await page.getByLabel('Search the catalog').fill('');
  await page.getByText('All', { exact: true }).click();
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Kids' });
  await expect(listItem(page, /Kids/)).toHaveCount(2);
  await expect(listItem(page, /Kids trouser 20003/)).toContainText('Out of stock');

  await page.getByLabel('Search the catalog').fill('panjabi');
  await expect(page.getByText('No listing matches')).toBeVisible();
  await page.getByRole('button', { name: 'Clear the filters' }).click();
  await expect(listItem(page, /Basic crew-neck T-shirt/)).toBeVisible();

  // A product already in the shop is not offered again
  await page.getByRole('button', { name: 'Add to shop' }).click();
  await page
    .getByRole('dialog', { name: 'Add a product to the shop' })
    .getByRole('button', { name: 'Product', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Search products' }).fill('basic crew');
  await expect(page.getByText(/^No product to add matches\./)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Online only
  await context.setOffline(true);
  await expect(page.getByText(/^The shop’s menu works on the server\./)).toBeVisible();
  await context.setOffline(false);
});
```

The catalog's filters on the open shop: search, the Drafts segment, the category select, the "No listing matches"
empty state with its "Clear the filters" button, and "Add to shop" not offering a product that is listed already.
Last, offline: the page shows the "Needs a connection" state (decision 5 of 26g.1, online only).

```ts
test('prices a listing, checks its sale and publishes only what is saved', async ({ page }) => {
  await start(page);
  await openListing(page, 'Basic crew-neck T-shirt');
  await expectNoSideScroll(page);
  // The card beside the form: what a shopper pays with the form as it is now
  const preview = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'In the shop now' }) });

  await page.getByLabel('Sale', { exact: true }).selectOption({ label: 'Percent off' });
  await page.getByLabel('Percent off (1 to 99)').fill('10');
  await expect(preview).toContainText('৳269.10');
  await expect(preview.locator('s')).toHaveText('৳299');
  await expect(preview).toContainText('10% OFF');
  // A change waits for its save before the listing can leave the shop
  await expect(page.getByRole('button', { name: 'Take out of the shop' })).toBeDisabled();
  await expect(page.getByText('Save your changes first, then show it in the shop.')).toBeVisible();

  // ৳400 off ৳299 takes off everything: the API refuses it on the box
  await page.getByLabel('Sale', { exact: true }).selectOption({ label: 'Taka off' });
  await page.getByLabel('Amount off').fill('400');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText('The sale must take something off the regular price. Lower it.'),
  ).toBeVisible();

  await page.getByLabel('Amount off').fill('50');
  // Another listing's link name
  await page.getByLabel('Link name').fill('pique-polo-navy-m');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/^Something else in the shop has this link name\./)).toBeVisible();

  await page.getByLabel('Link name').fill('');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to Basic crew-neck T-shirt saved');
  await expect(preview).toContainText('৳249');
  await expect(preview).toContainText('৳50 OFF');

  await page.getByRole('button', { name: 'Take out of the shop' }).click();
  await toastShown(page, 'Basic crew-neck T-shirt is a draft again');
  await expect(
    page.getByText('This listing is a draft, so the shop does not show it.'),
  ).toBeVisible();
});
```

The price card and the publish button.

- The preview is the card titled "In the shop now" (a `<section>` with no role of its own, so the test finds it by
  its heading). 10% off ৳299 is ৳269.10: the price keeps its paisa, and the struck-out price is ৳299.
- While the form has changes, "Take out of the shop" is disabled with the sentence that says why.
- ৳400 off ৳299 passes the browser's checks (it is an amount above zero) and is refused by the mock on the value's
  box, as the API refuses it: only the server knows the regular price for sure.
- A link name another listing has is refused on its box. Emptying the box makes the slug from the name again.

```ts
test('refuses a photo the shop cannot use, and a listing with no photo', async ({ page }) => {
  await start(page);
  await openListing(page, 'Pique polo shirt · White · M');
  await expect(
    page.getByText('No photo yet. The shop shows a listing only with at least one photo.'),
  ).toBeVisible();

  // Not a photo at all: refused before anything is sent
  const file = page.locator('input[type="file"]');
  await file.setInputFiles({
    name: 'size-chart.pdf',
    mimeType: 'application/pdf',
    buffer: png(1, 1),
  });
  await expect(page.getByRole('group', { name: 'Photo 1' })).toHaveCount(0);

  // A photo the job finds too small: its error in the slot, and a way to remove it
  await file.setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: png(120, 120) });
  const photo = page.getByRole('group', { name: 'Photo 1' });
  await expect(photo.getByText(/^This photo is too small\./)).toBeVisible({ timeout: 10_000 });
  await photo.getByRole('button', { name: 'Remove it' }).click();
  await expect(photo).toHaveCount(0);

  // A draft with no photo cannot go into the shop
  await page.getByRole('button', { name: 'Show in the shop' }).click();
  await expect(page.getByText('Add at least one photo, then show it in the shop.')).toBeVisible();
});
```

The photos the shop cannot use: a PDF is refused in the browser before any upload, so no slot appears; a 120 × 120 PNG
goes up and the job finds it too small, with "Remove it" in the slot. A draft with no photo cannot be published: the
API's words show above the form.

```ts
test('keeps the shop categories in order and deletes only empty ones', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop categories');
  await expectNoSideScroll(page);
  const tree = page.getByRole('list', { name: 'Shop categories' });
  const topLevel = tree.locator(':scope > li');
  await expect(topLevel).toHaveText([/^Men/, /^Women/, /^Kids/]);

  await page.getByRole('button', { name: 'Move Kids up' }).click();
  await expect(topLevel).toHaveText([/^Men/, /^Kids/, /^Women/]);
  // Last among its siblings now
  await expect(page.getByRole('button', { name: 'Move Women down' })).toBeDisabled();

  // Kids holds listings, Men holds categories: both stay
  await page.getByRole('button', { name: 'Actions for Kids' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const kids = page.getByRole('dialog', { name: 'Delete Kids?' });
  await kids.getByRole('button', { name: 'Delete' }).click();
  await expect(kids.getByText(/^Listings are in this category\./)).toBeVisible();
  await kids.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Actions for Women' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Women?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await toastShown(page, 'Women deleted');
  await expect(topLevel).toHaveText([/^Men/, /^Kids/]);

  // A new one inside Men, last in its list. Every group starts open
  await page.getByRole('button', { name: 'Add a category to Men' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a shop category' });
  await expect(dialog.getByLabel('Inside')).toHaveValue(/.+/);
  await dialog.getByLabel('Name', { exact: true }).fill('Panjabi');
  await dialog.getByRole('button', { name: 'Add category' }).click();
  await toastShown(page, 'Panjabi added');
  await expect(tree.getByRole('button', { name: 'Panjabi', exact: true })).toBeVisible();
});
```

The category tree. The top level is the tree's own `<li>` children (`:scope > li`), so the order of Men, Women and
Kids can be read in one assertion. Kids and Men cannot be deleted, each for its own reason; Women can. Every group
starts open (26g.6's page keeps a set of closed ones), so "Add a category to Men" is there at once; it shows on hover
with a mouse, but it is in the page, so Playwright can click it.

```ts
test('warns before an open shop moves to a new address', async ({ page }) => {
  await start(page);
  await openFromNav(page, 'Shop settings');
  await expect(page.getByRole('heading', { name: 'The shop is open' })).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByLabel('Shop address').fill('rahman-outlet');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the shop’s address?' });
  await expect(dialog.getByText(/^rahman-fashion\.localhost stops working/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Change the address' }).click();
  await toastShown(page, 'Shop settings saved');
  await expect(page.getByText(/at http:\/\/rahman-outlet\.localhost:4321$/)).toBeVisible();
});

test('hides the Storefront menu from a role without storefront.manage', async ({ page }) => {
  await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
  await start(page);
  await pinAnswered(page);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Shop settings' }),
  ).toHaveCount(0);
});
```

The open shop's address change asks first, and names the old address (without the scheme, as the dialog writes it).
The last test signs in with a role that does not have `storefront.manage`: the nav has no Storefront group.

### The older tests: `/^Settings$/`

Decision 51, the same change in five files: the name must be "Settings" exactly, not "Shop settings".

```diff
@@ -8,7 +8,7 @@ const PNG = Buffer.from(
 
 test.beforeEach(async ({ page }) => {
   await page.goto('/');
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
 });
 
 test('checks the BIN, then saves the company profile', async ({ page }) => {
```

```diff
@@ -245,7 +245,7 @@ test('pays an advance against an order, and the order shows it', async ({ page }
 });
 
 test('chooses the purchase accounts in Settings', async ({ page }) => {
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
   // The template's two accounts, chosen when the workspace was set up
   const difference = page.getByLabel('Purchase price difference', { exact: true });
   await expect(difference).toHaveValue(/.+/);
```

```diff
@@ -223,7 +223,7 @@ test('writes a goods receipt from its own page, keeps it a draft, and posts it l
 });
 
 test('the over-receipt percent in Settings lets a little more in', async ({ page }) => {
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
   await page.getByLabel('Receive over the order').fill('5');
   await page.getByRole('button', { name: 'Save changes' }).click();
   await toastShown(page, 'Settings saved');
```

```diff
@@ -137,7 +137,7 @@ test('keeps the sales returns account, and protects it on the chart', async ({ p
   await toastShown(page, 'Switched to Karim Pharma');
 
   // Chosen when the pharmacy's chart was set up
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
   const select = page.getByLabel('Sales returns account');
   await expect(select.locator('option:checked')).toHaveText('4120 · Sales returns');
 
@@ -154,7 +154,7 @@ test('keeps the sales returns account, and protects it on the chart', async ({ p
   await expect(edit).toBeHidden();
 
   // Back to taking sales back from the Sales account itself
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
   await select.selectOption({ label: 'None: take it off the Sales account itself' });
   await page.getByRole('button', { name: 'Save account', exact: true }).click();
   await toastShown(page, 'Sales returns account saved');
```

```diff
@@ -89,7 +89,7 @@ test('revalues an item, and posts the difference', async ({ page }) => {
 });
 
 test('chooses where stock documents post', async ({ page }) => {
-  await openFromNav(page, 'Settings');
+  await openFromNav(page, /^Settings$/);
   await expect(page.getByRole('heading', { name: 'Stock accounts' })).toBeVisible();
   await page
     .getByLabel('Free samples')
```

### What I checked

- **Type checks:** `@omnivo/app` with its `scripts`, `e2e` and `sw` projects.
- **Unit tests:** app 23 files, 223 tests, all pass (this part adds none: the mock is checked by the browser tests).
- **Playwright, the new file:** `storefront.e2e.ts`, 7 tests on a computer and on a phone, twice in a row with
  `--repeat-each=2`: 28 passed.
- **Playwright, the whole suite on a computer** (2 workers): 216 of 219 passed. The 3 that failed (two credit note
  tests, the credit limit's audit row) timed out with the machine's load near 10; run again one at a time, all 3
  passed. Before decision 51, the 6 tests that open Settings failed every time.
- **Break on purpose**, each caught by a test: the mock publishing a listing with no photo, Save not waiting for a
  photo that is being prepared, and the publish button not waiting for the save.
- **ESLint** (with a 6 GB heap), **Prettier**, `pnpm boundaries` (it found the import cycle of decision 52, now fixed).
- **Not run here:** the phone half of the whole suite, the real API with these pages, the build and bundle size. That
  is 26g.8.

### Check this part

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/app typecheck && pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts storefront settings bills purchase-orders refunds stock-valuation --workers=2
NODE_OPTIONS=--max-old-space-size=6144 pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
pnpm boundaries
```

## 26g.8 — Run it and check it

### Two words out: `en.ts`, `bn.ts`

Two words of 26g.5 were not used by any screen in the end: `storefront.add.searchPlaceholder` ("Name or SKU", see
decision 50) and `storefront.listing.previewSale` (the preview card shows the price, the struck price and the
ribbon on their own, so it needs no sentence that joins them). Both are gone from `en.ts` and `bn.ts`, so 26g.5's diff
above no longer has them. Nothing else changes: an unused key passes every check, which is why only reading the
screens found them.

### The shop's comments: `infra/staging/compose.yml`, `infra/docker/Dockerfile`

```diff
@@ -212,9 +212,12 @@ services:
       - caddy-data:/data
       - caddy-config:/config
 
-  # The online shop (apps/shop). It shows the mock shop (SHOP_SOURCE is not set) until 26g lets a
-  # workspace launch a shop: its products, prices and orders are made up, and an order lives in
-  # this container's memory only, so a restart forgets it. It needs nothing else in the stack. `web` does not wait for it either:
+  # The online shop (apps/shop). It shows the mock shop (SHOP_SOURCE is not set): its products,
+  # prices and orders are made up, and an order lives in this container's memory only, so a restart
+  # forgets it. Since 26g a workspace can launch a real shop, but it lives at
+  # <subdomain>.<SHOP_BASE_DOMAIN>, and staging has one fixed SHOP_HOST. Switching to the API needs a
+  # wildcard host (DNS, the tunnel and Caddy) first, then SHOP_SOURCE=api, SHOP_API_URL and the API's
+  # SHOP_BASE_DOMAIN. It needs nothing else in the stack. `web` does not wait for it either:
   # if the shop fails, the ERP app keeps working and only the shop's address answers 502.
   shop:
     image: ${REGISTRY}/omnivo-shop:${IMAGE_TAG}
```

```diff
@@ -4,8 +4,8 @@
 #   api      the API and the worker (same code, a different command)
 #   migrate  runs the database migrations once per deploy, then exits
 #   web      Caddy: HTTPS in front of everything, and the app's static files
-#   shop     the online shop (apps/shop), an Astro Node server. Until step 26's public API exists
-#            it shows the mock shop, so on staging it is a demo only
+#   shop     the online shop (apps/shop), an Astro Node server. It reads the mock or the API's
+#            /public/v1 (SHOP_SOURCE); staging still shows the mock (infra/staging/compose.yml)
 # Build from the repo root: docker build -f infra/docker/Dockerfile --target api .
 
 ARG NODE_IMAGE=node:24.22.2-alpine3.24
```

Staging keeps the mock shop (your choice in this part). The comment said it would show the mock "until 26g lets a
workspace launch a shop". 26g does that, but a launched shop's address is `<subdomain>.<SHOP_BASE_DOMAIN>`, and
staging's tunnel and Caddy know one fixed shop host (`SHOP_HOST`). So the comment now says what the switch needs, in
the order it has to happen: a wildcard host first, then the three settings. Switching only `SHOP_SOURCE` would turn
the demo shop into "No shop has this address" for every visitor. The Dockerfile's comment about the shop image was
older still (from before 26f's API) and now says the image can read either source.

### The commands

Your dev database needs the two new migrations first (0065 and 0066), and `pnpm install` brings `sharp`:

```bash
pnpm install
pnpm db:migrate
```

Then the packages this step touched, one at a time:

```bash
pnpm --filter "./packages/*" build
pnpm --filter @omnivo/contracts test      # 562
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test            # 183 unit tests (no database)
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test            # 223
```

And the whole repo:

```bash
pnpm dedupe --check
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test                 # 1,356: contracts 562 + shop 223 + app 223 + api 183 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm test:integration     # 775 in 46 files, with the 38 of storefront-admin.int.spec.ts
pnpm test:tenant-leak     # 154 in 23 files, with the 12 of storefront-admin.tenant-leak.int.spec.ts
pnpm boundaries
pnpm test:bundle-size     # first load 237.2 KB gz (budget 240), the listing editor 145.9 KB (budget 150)
pnpm test:openapi         # up to date, with the 20 Storefront routes
pnpm --filter @omnivo/app test:e2e        # 438: 435 run, 3 skipped on purpose (as before)
pnpm test:e2e:pwa                         # 4
pnpm --filter @omnivo/shop test:e2e       # 38 passed, 2 skipped on purpose (as before)
```

On a laptop with 8 GB, add `--concurrency=2` to the turbo ones, run the two database suites with `--maxWorkers=3`
(from `apps/api`: `npx vitest run .int.spec --maxWorkers=3`), and the app's e2e suite with `--workers=2`.

**The app's e2e suite on 2 workers:** 423 passed the first time. 12 timed out (the first pull past 25 seconds, the
30-second test limit) while macOS's own background services kept the machine's load near 30; none of them is a
Storefront test. Run again one at a time, all 12 passed on a computer and on a phone (24 runs).

### The screens on the real API, end to end

The Playwright tests run the screens on the mock (26g.7), and the integration tests run the API with real photos
(26g.4). One more check put the real pieces together once: a throwaway script (not in this guide, and not in `src`)
on throwaway Postgres, Valkey, MinIO and Mailpit containers, with the built API, the real worker, a production
build of the app (`vite build`, served by `vite preview`) and the built shop. It drove the screens in Chromium, as
the owner of a new retail workspace with one product (Mango juice 250 ml, ৳25, 40 in MAIN). Every step passed:

- **Shop settings** started from the workspace (its slug, "Nabil Super Shop"). The first save set the shop up and the
  checklist showed 2 of 3; the database had the row, not launched.
- **Shop categories:** "Juice and drinks", with `/c/juice-and-drinks` worked out from the name.
- **Add to shop** → a draft, the editor open.
- **The photo:** a 900 × 600 PNG went from the browser straight to MinIO (the presigned PUT), the worker's sharp job
  made the three sizes, and the editor showed it, **ready in 3 seconds**. `small.webp`, `large.webp` and `wide.webp`
  answered `200 image/webp` with no login and no signature, with `Cache-Control: public, max-age=31536000,
  immutable`; the original answered `403`: only `storefront/` is public (decision 20). The row said 900 × 600.
- **Save, "Show in the shop", "Open the shop"**: the dialog named `http://nabil-….localhost:4398` (the smoke's
  `SHOP_PUBLIC_PORT`), and both "View shop" links pointed there.
- **The built shop with `SHOP_SOURCE=api`**, in the same browser at that address: the home page with the card and its
  WebP photo loaded, the product page with the photo (`large.webp`, its alt text as typed), ৳25, "Available in
  stock" and the hotline, and the category page with the listing.
- **"Take out of the shop"** → the editor said draft, and the product page answered `404` once the shop's 30-second
  cache ran out.
- **The audit log** had all seven saves in order: `storefront.created`, `storefront_category.created`,
  `storefront_listing.created`, `storefront_listing.updated`, `storefront_listing.published`,
  `storefront.launched`, `storefront_listing.unpublished`. The worker's log had no error, and no page threw.

### `sharp` in the API's Docker image

The image job is the first code in the API that needs a native library, so the API's Alpine image was built once
(`docker build -f infra/docker/Dockerfile --target api .`, 2 minutes, 684 MB) and asked to load `sharp` and make a
WebP from a 900 × 600 JPEG: `linux arm64, sharp 0.35.5, libvips 8.18.7`, a 400 × 267 WebP. Nothing in the
Dockerfile changes: `pnpm fetch` takes the build of `sharp` for the image's own system (musl), and `pnpm deploy
--prod` copies it with the API. The lockfile has both `@img/sharp-linuxmusl-arm64` and `@img/sharp-linuxmusl-x64`,
so the staging deploy, which builds on GitHub's x64 runners, gets its own. The x64 image itself was not built here
(this Mac is arm64).

### Found while finishing

- **Two unused words** (above), found by reading the screens against the words. No check finds an unused key.
- **The staging comments** (above). Staging itself is unchanged, by your choice.
- **The shop card's photo has no alt text, on purpose.** On the card the photo is a second copy of the name's link,
  hidden from screen readers, so the alt text the owner types in the editor shows on the product page's
  gallery, not on the cards. The smoke first looked for it on the home page and did not find it; the shop was right.
- **No code change** came out of the whole-repo checks or the smoke.

### What you should see

Your dev database needs the two new migrations (0065 and 0066), and `pnpm install` brings `sharp`:

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

`pnpm dev` starts the API, the worker, the app and the shop (still on its mock). Then, signed in as the owner:

- [ ] The sidebar has a **Storefront** group: Catalog, Shop categories, Shop settings. Someone whose role does not
      have `storefront.manage` sees no group; typing `/storefront/settings` by hand only gets the page's load error,
      because the API answers `403` to every Storefront route.
- [ ] **Catalog** before any setup says "Set up the shop first", with a button to the settings.
- [ ] **Shop settings** starts from the workspace (its slug as the shop's address, its name). Pick the warehouse,
      fill one delivery zone, "Set up the shop": the checklist shows 2 of 3, and "Open the shop" stays disabled.
- [ ] **Shop categories:** add one, add one under it, Move up / down, and delete one that a listing uses (refused,
      with the reason).
- [ ] **Catalog → Add to shop:** pick a product, a category → the editor opens on a draft. Upload a photo (a phone
      photo is fine): "Preparing the photo…" for a moment, then the photo, turned the right way up. Type what it
      shows, Save, "Show in the shop".
- [ ] **Shop settings → Open the shop** → the dialog names the address (`http://<subdomain>.localhost:4321`) →
      "The shop is open", and "View shop" in the header.
- [ ] Stop the shop's dev server and start it on the API instead:
      `SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 pnpm --filter @omnivo/shop dev`. "View shop" now shows your
      shop: its name, the listing's card with the photo, its price and stock. "Take out of the shop" in the editor,
      and within a minute the product page is gone (the shop keeps an answer for 30 seconds).
- [ ] `pnpm dev:mock`: the garments workspace has Rahman Fashion open, with photos, a sale and a draft; the pharma
      workspace has no shop yet.

### Known differences from the mockup

- **The save bar** says "Changes not saved yet" on both forms, where the mockup said "You changed the description."
  (decision 38). Everything else is as you approved it.

## What comes next

- **26h, the rest of the Storefront menu:** Appearance (the logo, the two colors with the 4.5:1 check, the hero,
  image banners, collections, the home page's order), Pages (Privacy, Terms, About, Contact), and a dev seed with
  photos.
- **Staging on the real API:** a wildcard shop host (DNS, the tunnel, Caddy), then `SHOP_SOURCE=api`,
  `SHOP_API_URL` and `SHOP_BASE_DOMAIN`, with the steps in `docs/vps-deploy.en.md`. Production's storage needs a
  public address for `storefront/` too (R2 serves public files from another host, `STOREFRONT_MEDIA_URL`).
- **Step 27:** the real checkout and orders, stock held for an order, coupons, the phone code by SMS, and the API's
  own rate limits.
- **Later:** adding many products at once, cleaning up unused photos, a tenant's own domain, and the
  `feature.storefront` entitlement (step 24).
