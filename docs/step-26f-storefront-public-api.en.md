# Step 26f: Storefront, part 6 — the shop reads the ERP

> The implementation guide for "Phase 10 → Step 26", the sixth part, of [build-plan.bn.md](build-plan.bn.md).
> Step 26 so far:
>
> - **26a–26e (done):** `apps/shop` with every screen, on mock data: the home page, the product page, the cart
>   drawer, the checkout, the phone code, the order page, the category and search pages, tracking, the text pages,
>   404 and the Playwright tests.
> - **26f (this guide):** the storefront tables, the public API `/public/v1`, and the shop's data source that reads
>   it. The shop shows a workspace's real products, at their real prices and stock.
> - **26g:** the ERP's Storefront menu: Catalog (listings with photos, description, sale, badges, SEO), Appearance
>   (logo, colors, banners, collections), Delivery zones and Pages.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `309cda5`, "tracking system in
> progress", with your test fix `957dce0`, "ci fixed") and checked on 2026-11-15: `pnpm dedupe --check`,
> `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (1,291, of them 518 in
> `packages/contracts`, 223 in `apps/shop` and 175 in `apps/api`), `pnpm test:integration` (737) and
> `pnpm test:tenant-leak` (142) on Testcontainers, `pnpm boundaries`, `pnpm test:bundle-size` (the ERP app's first
> load 231.9 KB gz, budget 235), `pnpm test:openapi`, and the shop's Playwright tests (38 passed, 2 skipped on
> purpose, as before), all clean. The two migrations were also checked on a throwaway Postgres with about 70 checks
> of their own (26f.2).
>
> **Not run:** the ERP app's e2e suites. The app's only change is four error words, and its e2e tests run on MSW, so
> they never meet the new API module.
>
> Also checked:
>
> - **The built shop on the real API**, end to end: a launched test shop on Testcontainers, the API on a real port,
>   the built shop with `SHOP_SOURCE=api` in front of it, and its pages asked over HTTP (26f.7).
> - **The built shop against a fake API**, for the cache, the timeout, a host with no shop and the two settings
>   (26f.5).
> - **Broken on purpose** while the parts were written, each caught by a test: a percent rounded the wrong way, an
>   archived variant left in the shop, the public role left out, no "published" or "warehouse" rule, the role able to
>   inherit `omnivo_app`'s rights, the host left out of the shop's cache key, and more. Each part's "Check this
>   part" lists them.

## Goal

🛍️ **The shop shows a workspace's real products.** After 26e every page of the shop existed, but on made-up data.
After 26f the ERP keeps a shop in eight new tables (its settings, categories, listings, banners, collections, the
home page's order and the text pages), the API answers the shop's questions on `/public/v1` with no login, and the
shop's server asks it when `SHOP_SOURCE=api`. The prices are the ERP's, with the tenant's sale worked out on the
server, and the stock is the shop warehouse's. Orders, the phone code and tracking still run in the shop's own mock
until step 27, and the tenant's screens for all this come in 26g.

## The whole picture

```
packages/contracts   storefront-content.ts: the sale (percent | amount | price), listingPricing(), sections →
                     escaped HTML, sectionsSummary(), the photo {id, alt}     storefront.ts: the product's seo,
                     X-Shop-Host, the 8 /public/v1 routes, the hero may be null      errors.ts: 4 new codes
packages/db          storefront.ts: 8 tables      0063: the tables      0064: RLS, the omnivo_public role, its
                     column grants, the restrictive policies, storefront_tenant_for_subdomain()
      │
      ▼
apps/api/src/storefront   (no login, Cache-Control: no-store)
   shop-host     X-Shop-Host "acme.localhost:4331" → the label "acme", or 404 before any database work
   shop-db       BEGIN READ ONLY · SET LOCAL ROLE omnivo_public · the label → the tenant · set the tenant
   listing-sql   one subquery: the price the shopper pays, the struck-out price, the ribbon, in stock (SQL)
   quote         the cart's lines, zone, free delivery and minimum order; every coupon is refused as unknown
   service       shop · categories · home · listings · product · quote · checkout settings · text page
      │  GET /public/v1/…  +  X-Shop-Host
      ▼
apps/shop/src
   middleware    locals.source = sourceFor(url): the mock, or the API source for this host; no shop → 404
   data/api      shop-api (8 s timeout, every answer parsed with its route's schema) · answer-cache (30 s per
                 host + path, never a failure, never the quote) · api-source (orders stay in a mock book per host)
   pages         every page and route reads Astro.locals.source; the product page's <title> and description

Sunday 15 Nov 2026, Nirvor Pharmacy's shop, on a laptop:
  nirvor.localhost:4331/p/neem-face-wash ─► the ERP's Neem Face Wash: ৳229 over a struck-out ৳299 ("৳70 OFF"),
                                            "Available in stock" (5 in the shop's warehouse), the description's
                                            sections, and its SEO title in the tab.
  nobody.localhost:4331 ─► "No shop has this address", status 404.
```

## Not in this step, on purpose

- **No orders in the ERP yet.** Placing an order, the phone code, the order page and tracking stay in the shop's mock
  until step 27 stores orders (decision 1). `/public/v1` only reads, and the quote is the one thing it works out.
- **No screens in the ERP.** The tenant fills the shop in 26g. Until then no workspace has a shop: there is no
  seed (decision 17), so the shop stays on the mock, and the API's tests make their shops with SQL (decision 36).
- **No stock is held** for a cart or an order (decision 3). Step 27 adds the reservation.
- **No custom domains.** A shop is a subdomain (decision 4); a tenant's own domain comes with Cloudflare for SaaS.
- **No rate limit in the API** (decision 25), and **no CDN** in front of the API (decision 24).
- **No entitlement.** The Storefront menu is guarded by a permission (decision 7); `feature.storefront` waits for
  billing (step 24).

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront.ts`, `storefront.spec.ts` | The product's `seo`, `SHOP_HOST_HEADER`, the listing query as parameters, the 8 public routes, `imageUrlSchema`, a nullable hero |
| `packages/contracts/src/routes.ts`, `index.ts` | `publicStorefront` in the routes registry; `storefront-content` exported |
| `packages/contracts/src/errors.ts` | `storefront_not_found`, `storefront_sale_percent`, `storefront_sale_zero`, `storefront_sale_dates` |
| `packages/contracts/openapi.json` | Regenerated with the public routes |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The four error words |
| `packages/i18n/src/locales/shop/en.ts`, `bn.ts` | `shop.noShop` |
| `packages/db/src/schema/index.ts`, `migrations/meta/_journal.json` | The new schema file; migrations 0063 and 0064 |
| `apps/api/src/config.ts`, `.env.example` | `SHOP_BASE_DOMAIN`, `STOREFRONT_MEDIA_URL`; the shop's `SHOP_SOURCE`, `SHOP_API_URL` |
| `apps/api/src/app.module.ts` | `StorefrontModule` |
| `apps/api/src/products/products.service.ts` | A listed variant cannot be deleted (`VARIANT_IN_USE`) |
| `apps/shop/astro.config.ts` | `SHOP_SOURCE` and `SHOP_API_URL` as run-time secrets (`astro:env`) |
| `apps/shop/src/data/source.ts` | `sourceFor(url)` in place of one `shopSource`; the cache and the order books per host |
| `apps/shop/src/data/mock/products.ts` | The mock's product gets its `seo` |
| `apps/shop/src/lib/listing-page.ts` | Takes the source from its caller |
| `apps/shop/src/layouts/ShopLayout.astro` | `description` → `<meta name="description">` |
| `apps/shop/src/pages/**` (every page and API route) | `Astro.locals.source` in place of the imported `shopSource` |
| `apps/shop/src/pages/index.astro` | No hero banner → the page starts with the grid |
| `apps/shop/src/pages/404.astro` | Draws `NoShopPage` when the host has no shop |
| `apps/shop/src/boundaries.spec.ts` | Only the middleware imports `data/source.ts` |
| `infra/staging/compose.yml` | A comment only: staging stays on the mock until 26g |

New: `packages/contracts/src/storefront-content.ts` (with its spec); `packages/db/src/schema/storefront.ts` and
migrations 0063 and 0064; the folder `apps/api/src/storefront/` (with its specs and two integration test files),
`apps/api/src/testing/storefront.ts` and `apps/api/src/config.spec.ts`; in `apps/shop/src`: `middleware.ts`,
`env.d.ts`, `data/config.ts`, the folder `data/api/` (with their specs) and `components/NoShopPage.astro`.

## Decisions

Agreed with the user on 2026-11-15:

1. **Two guides.** 26f is the data and the public API, read by the shop; 26g is the ERP's screens. The shop's
   contract was fixed in 26a–26e, so the API has an exact target, and the screens (a big UI with a mockup to approve)
   get their own guide.
2. **The price** is the listing's own price when it has one, else the variant's sale price (step 12). There is no
   storefront price list yet.
3. **The stock** is what is on hand in the shop's warehouse (`storefront_settings.default_warehouse_id`), and the
   shop only says "in stock" or "out of stock".
4. **Subdomains only** for now: `acme.localhost:4331` on a laptop, `acme.omnivosoft.com` on staging. A tenant will
   also be able to use a domain they bought (`www.acme.com.bd`); that comes in a later step, with its own table,
   DNS checks and Cloudflare for SaaS. Every shop keeps its subdomain, so a custom domain is an extra address, not
   a replacement (see decision 16).
5. **Photos are public files** under a `storefront/` folder, with names that never change, so a CDN can keep them.
   Not signed links: a signed link changes every time, and nothing could cache it.
6. **The description cannot carry the tenant's HTML.** Agreed as "clean it on save"; decision 8 makes it stronger.
7. **A permission, not an entitlement,** guards the Storefront menu (`storefront.manage`).

The user added: **the ERP must support every field the shop shows for a product**: photos, the description, the
sale (a percent off, an amount off, or the price after the discount), badges, SEO, and the rest. The table in 26f.2
has a column for each, and 26g's form fills them. Also agreed: the sale is kept as the tenant typed it; photos are
made into WebP sizes by a worker job (26g); the description is written in sections; the shop has its own category
tree; a listing has at most 4 photos.

Mine, made while writing this guide (say so if you want any of them changed):

8. **Sections, never HTML.** The tenant writes a description (and a text page) as sections: a heading and a text
   box, where a blank line starts a paragraph, `- ` a bullet, `1. ` a number, `**bold**` bold and `[words](link)` a
   link. The API writes the HTML from that and escapes every character the tenant typed. So no tag of theirs can
   reach the shop, and no HTML cleaner (`sanitize-html`) is needed at all. Decision 6 asked for a cleaner; this
   makes one unnecessary.
9. **A sale that would take nothing off is not shown.** "Sell at ৳229" after the regular price fell to ৳220 would
   show ৳229 over a struck-out ৳220. The shop then shows ৳220 alone. It is not an error: the regular price is
   changed elsewhere (the product's own form), long after the sale was saved.
10. **The ribbon of a set price says the taka it saves** ("৳21 OFF" for ৳229 from ৳250). A percent sale says the
    percent ("10% OFF").
11. **A sale ends at its end time.** At that second the countdown shows zero, so the price is the regular one again.
12. **The shop's address travels in an `X-Shop-Host` header.** The shop's server calls the API from inside the
    network, where the API's own `Host` header names the API. The header only picks which shop's public pages to
    answer, so a forged one gets nothing more than that shop's own pages. Never a query parameter (system design
    §14.2).
13. **The listing query sends only what is set**, with the flags as `1` (like the shop's own addresses). The first
    page of `/c/all` is then one plain address for every shopper: one cache entry.
14. **SEO is part of the product's answer**, filled in by the API: the tenant's SEO title or the name, and their SEO
    description or the start of the first section. The shop never decides.

Agreed with the user while writing 26f.2 (each was the recommended choice):

15. **The public API reads as its own role, `omnivo_public`, without logging in as it.** Migration 0064 makes it a
    NOLOGIN role and lets `omnivo_app` become it. A public request's transaction starts with `SET LOCAL ROLE
    omnivo_public`. The other way (a second role that logs in, with its own password and connection pool) would
    need a change to the database init scripts, and those run only when a database volume is new: your dev
    database and the staging server would never get the role.
16. **The shop's address is a subdomain label plus `launched_at`.** `storefront_settings.subdomain` holds only
    `acme`, never the whole host; the API adds its `SHOP_BASE_DOMAIN` (`localhost`, `omnivosoft.com`), so one row
    works on a laptop, on staging and in production. A shop answers only once `launched_at` is set ("Open the
    shop" in 26g), so a half-made shop is never on the internet. There is no `storefront_domains` table yet: the
    later custom-domain step adds one, and the lookup function gets a second way in.
17. **No demo seed in 26f.** A demo shop needs photos in the public `storefront/` folder, and the job that makes
    them is 26g's. The integration tests (26f.4) make their own data, and the shop keeps the mock as its default
    source until then.

Mine, made while writing 26f.2:

18. **No `enabled` flag and no `featured` column.** `launched_at` is the switch, and it never goes back (step 26e:
    a shop is always open). The home page's grid is the first page of `/c/all`; 26f.3 says so.
19. **No images table yet.** A photo is `{ id, alt }` in a jsonb column. 26g adds `storefront_images` with the
    upload job, and the foreign keys with it. The address of a photo is `storefront/<image id>/<size>.webp`, with no
    tenant id in it: the image id alone is unique, and a public address need not name the workspace.
20. **Enum columns are checked by TypeScript only,** as in every earlier step (`text(…, { enum })` adds no SQL
    check). The checks in SQL are for rules a typo in the API could break and the shop would then show: prices,
    sales, links, colours, slugs, lengths.
21. **"Only an image banner in a home block" is the API's rule.** One column of a composite foreign key cannot say
    `kind = 'image'`, and a trigger for it is not worth its weight.

Agreed with the user while writing 26f.3 (2026-11-15):

22. **Photo addresses come from the config.** `STOREFRONT_MEDIA_URL` is the public address of the storage's
    `storefront/` folder's parent; left out, it is `S3_ENDPOINT/S3_BUCKET` (right for MinIO in dev and on staging).
    The contract's image address also takes plain `http://localhost` and `http://127.0.0.1`, because dev's MinIO is
    not https. That address is never typed by a tenant, so this opens nothing; production refuses to start with an
    http address.
23. **The hero banner is optional.** `shopHomeSchema.hero` is nullable, and the home page starts with the grid when
    there is none. A new shop, or one whose banner was deleted, never breaks for a missing picture.
24. **The API's answers are never cached in front of it** (`Cache-Control: no-store`). A CDN keys an answer by its
    address, not by the `X-Shop-Host` header, so it could hand one shop's page to another. The shop's own server
    keeps a short cache per host (26f.5).
25. **No rate limit in the API yet.** It sees only the shop server's address, and its reads are cheap index
    queries. An edge rule for `/public/v1/*` goes into the deploy notes; real limits come with step 27's orders and
    phone codes.

Mine, made while writing 26f.3:

26. **One read-only transaction per request.** It starts `READ ONLY`, becomes `omnivo_public`, finds the shop, then
    sets the tenant. A host that cannot be a shop of ours is refused before any database work.
27. **"In stock" is the sum over batches in the shop's warehouse, above zero.** The quote uses the same flag; whether
    there are as many as the cart asks for is step 27's question, when an order holds stock.
28. **Every coupon is refused as unknown** until step 27 has coupons. The quote's shape stays the one 26c built.
29. **The sorts and the price filter use the price the shopper pays.** The SQL works it out with the same rules as
    `listingPricing()`; 26f.4 checks that the two agree.
30. **"Name: A to Z" orders by the first 60 characters, then the id.** The key goes into the cursor, and a cursor is
    at most 512 characters; 60 Bangla letters fit, a whole long name may not.
31. **An unknown category slug is an empty page** (as in the mock); a broken cursor is `400 invalid_cursor`, which
    the shop's API source turns into "go to the first page" (26f.5), as the mock does.
32. **Cards carry one small photo; the product page carries all of them, large.** Three sizes, by where they are
    drawn: small (480px), large (1200px), wide (2560px). 26g's image job makes exactly these.
33. **A collection row shows at most 24 cards,** and a row whose listings are all hidden is left out. "Related
    Products" is the newest 12 of the same category.
34. **The search folds the words (NFC, lower case) and compares with `lower(name)`.** 26g must save names in NFC,
    or a Bangla word typed in its other form would miss.
35. **A listed variant cannot be deleted:** the listing's foreign key joins `VARIANT_IN_USE`, so the products screen
    says "Archive it instead", as for every other document that holds a variant.

36. **The tests make the shop with SQL, as the superuser.** The ERP has no Storefront screens until 26g, so one
    helper (`apps/api/src/testing/storefront.ts`) writes the rows the way 26g's API will. The tables' checks still
    hold for it, so a test can never set up a shop the screens could not make. 26g moves the tests to its API.
37. **SQL and TypeScript prices are compared directly.** The price filter takes whole taka, so a filter cannot prove
    that ৳224.95 is ৳224.95 to the paisa. The test reads the subquery's own `price` column through `ShopDb.read` and
    `selectListings` (the API's own path, as `omnivo_public`) and compares it with the card's.
38. **`saleUntil` keeps the microseconds Postgres writes** (`…:51.000000Z`). It is a valid ISO time, the contract
    takes it and `Date.parse` reads it; cutting it would need a second format helper for no gain.

Agreed with the user while writing 26f.5 (2026-11-15):

39. **Each request gets its own source, from the middleware.** `src/middleware.ts` runs before every page and route
    and puts `sourceFor(url)` in `Astro.locals.source`. The real source belongs to the shop the host names, so a
    module-level `shopSource` (26a–26e) could not stay: one variable would serve every shop. Only the middleware
    may import `data/source.ts` (a new rule in `boundaries.spec.ts`).
40. **Orders stay in the mock's order book, one book per shop, priced by the API.** The API source reuses 26c's
    `createOrderBook()`, but the price and the checkout settings come from `/public/v1`, so an order is checked
    against the same quote the checkout showed. Each host has its own book, so two shops never share W-000001. The
    verify page still shows the test code: no SMS is sent before step 27, and these orders reach no ERP. A real shop
    has no demo tracking orders.
41. **A host that is no launched shop gets a plain 404 page.** The middleware asks for the shop first; on
    `storefront_not_found` it draws `pages/404.astro` in the page's place, which shows "No shop has this address"
    without any shop's name, colors or menu. `/api/*` answers problem JSON. No redirect: the address stays what the
    shopper typed, and a search engine keeps nothing.
42. **The shop's server keeps the API's answers for 30 seconds.** In its own memory, keyed by host + path + query,
    GET only, at most 1,000 answers. Callers of one key at the same time share one request. A failure (no answer, a
    5xx) is never kept; a refusal such as "no such product" is. The quote is never kept.

Mine, made while writing 26f.5:

43. **Every answer is parsed with the route's own contract schema** on the shop's server. A page gets exactly the
    contract's type, and an API that broke the contract fails at the call, not as `undefined` in a component.
44. **The quote gets only the lines, the zone and the coupon.** An order request carries the shopper's name, phone
    and address, and the API has no reason to see them before step 27 stores orders.
45. **A product slug the ERP could never make is not asked for** (`Neem Face Wash`): the API would answer 400, which
    is not "no such product". The shop checks it with the route's own params schema and answers 404 itself.
46. **The two settings are read at run time** (`astro:env`, `access: 'secret'`). A public server value would be fixed
    into the build, and staging could not switch the same image from the mock to the API.
47. **One timeout of 8 seconds per API call.** Long enough for a slow query, short enough that a shopper sees an
    error page instead of a browser that spins.
48. **Staging keeps the mock until 26g.** No workspace has a launched shop before 26g's screens (decision 17), so
    switching staging to the API now would only show "No shop has this address".

## 26f.1 — The contracts

This part adds what both sides of the public API agree on: the raw material the ERP keeps (a sale, sections,
photos), the functions that turn it into the shop's shapes, and the routes of `/public/v1`. Nothing is stored or
served yet. The shop's pages do not change: they already read these shapes from the mock.

### What the ERP keeps: `storefront-content.ts`

`storefront.ts` is what the shop reads. It holds answers. This new file holds what those answers are built from,
the way the tenant typed it. The API uses it to build the answers (26f.3), and 26g's forms use the same functions
for their preview. So a price on the form and the price in the shop are worked out by one function.

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import {
  compareMoney,
  isMoneyAmount,
  isZeroMoney,
  percentOfMoney,
  subtractMoney,
} from './money.js';
import type { ShopDiscount } from './storefront.js';

// Step 26f: what the tenant writes for the shop, kept the way the ERP stores it. storefront.ts is
// what the shop reads (answers); this file is the raw material those answers are built from: a
// listing's sale, its description and its photos. The API turns them into the shop's shapes with
// the functions below, and step 26g's forms use the same functions for their preview, so the form
// and the shop can never disagree on a price or a paragraph.

// ---------------------------------------------------------------------------------------------
// The sale

// How the tenant typed the offer. Kept as typed, not turned into one final price, because each
// means something different when the regular price changes later:
// - percent: "10% off". A new regular price of ৳260 sells at ৳234.
// - amount: "৳21 off". ৳260 sells at ৳239.
// - price: "sell at ৳229". ৳260 still sells at ৳229.
export const STOREFRONT_SALE_KINDS = ['percent', 'amount', 'price'] as const;

// A whole percent, 1 to 99: the shop's ribbon says "10% OFF" (shopDiscountSchema has the same
// range). 0% is no sale, and 100% gives the goods away, which a form typo should never do
const salePercentSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d?$/, errorCode('storefront_sale_percent'));

// An amount in taka, more than zero. Whether it is under the regular price is checked by the API
// (step 26g), because only the API knows that price
const saleMoneySchema = z
  .string()
  .trim()
  .refine(isMoneyAmount, errorCode('money_format'))
  .refine(
    (value) => !isMoneyAmount(value) || !isZeroMoney(value),
    errorCode('storefront_sale_zero'),
  );

const saleTimeSchema = z.iso.datetime({ offset: true }).nullable();

export const storefrontSaleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('percent'), value: salePercentSchema }),
    z.object({ kind: z.literal('amount'), value: saleMoneySchema }),
    z.object({ kind: z.literal('price'), value: saleMoneySchema }),
  ])
  .and(
    z.object({
      // null: the sale has started already / runs until the tenant turns it off. With an end, the
      // product page shows the countdown (CLAUDE.md → Product page, top)
      startsAt: saleTimeSchema,
      endsAt: saleTimeSchema,
    }),
  )
  // An end before (or at) its start is a sale that never runs. Compared as dates: the two strings
  // may have different offsets
  .refine(
    (sale) =>
      sale.startsAt === null ||
      sale.endsAt === null ||
      Date.parse(sale.startsAt) < Date.parse(sale.endsAt),
    { message: errorCode('storefront_sale_dates'), path: ['endsAt'] },
  );

export type StorefrontSaleKind = (typeof STOREFRONT_SALE_KINDS)[number];
export type StorefrontSale = z.infer<typeof storefrontSaleSchema>;

// The four price fields of a shop listing (shopListingSchema), worked out from the regular price
export interface ListingPricing {
  price: string;
  compareAtPrice: string | null;
  discount: ShopDiscount | null;
  saleUntil: string | null;
}

// What the shopper pays now, and what the card and the product page show for it. `regular` is the
// listing's own price or the variant's sale price (decision 2), `now` the server's clock (a
// parameter, so a test can fix it). A sale outside its dates is no sale. So is one that would not
// take anything off any more: a "sell at ৳229" after the regular price fell to ৳220 would show a
// struck-out ৳220 under a higher ৳229, so the shop shows ৳220 alone instead.
export function listingPricing(
  regular: string,
  sale: StorefrontSale | null,
  now: Date,
): ListingPricing {
  const noSale: ListingPricing = {
    price: regular,
    compareAtPrice: null,
    discount: null,
    saleUntil: null,
  };
  if (sale === null) return noSale;
  const time = now.getTime();
  if (sale.startsAt !== null && time < Date.parse(sale.startsAt)) return noSale;
  if (sale.endsAt !== null && time >= Date.parse(sale.endsAt)) return noSale;

  // How much comes off, to the paisa. A percent rounds half up (percentOfMoney): 10% of ৳249.95
  // is ৳25.00, not ৳24.995
  const off =
    sale.kind === 'percent'
      ? percentOfMoney(regular, sale.value)
      : sale.kind === 'amount'
        ? sale.value
        : subtractMoney(regular, sale.value);
  const price = subtractMoney(regular, off);
  // Nothing off, or everything off (and more): not a sale the shop can show
  if (compareMoney(off, '0') <= 0 || compareMoney(price, '0') <= 0) return noSale;

  return {
    price,
    compareAtPrice: regular,
    // The ribbon says it the way the tenant thought of it: "10% OFF" for a percent, the taka for
    // the other two ("৳21 OFF" for "sell at ৳229" from ৳250). The taka as regular − price, so it
    // has the 4 decimals of every other amount here even when the tenant typed "21"
    discount:
      sale.kind === 'percent'
        ? { kind: 'percent', value: Number(sale.value) }
        : { kind: 'amount', value: subtractMoney(regular, price) },
    saleUntil: sale.endsAt,
  };
}

// ---------------------------------------------------------------------------------------------
// The description and the text pages

// The tenant writes sections, never HTML (decision 6, made safer): each has a heading and a text
// box. The text box knows three things, enough for every description Figma shows:
// - a blank line starts a new paragraph,
// - lines that start with "- " are a bulleted list, lines that start with "1. " a numbered one,
// - **words** are bold, and [words](https://…) or [words](/pages/terms) is a link.
// The server writes the HTML from that (renderSections). Every character the tenant typed is
// escaped first, so no tag, attribute or script of theirs can reach the shop, and no HTML cleaner
// (sanitize-html) is needed at all.
export const STOREFRONT_SECTIONS_MAX = 12;
export const STOREFRONT_HEADING_MAX = 120;
export const STOREFRONT_BODY_MAX = 5000;

export const storefrontSectionSchema = z.object({
  heading: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_HEADING_MAX, errorCode('too_long')),
  body: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_BODY_MAX, errorCode('too_long')),
});

// A listing may have none (the product page then leaves out its Overview card). A text page needs
// at least one; its own schema (step 26g) says so
export const storefrontSectionsSchema = z
  .array(storefrontSectionSchema)
  .max(STOREFRONT_SECTIONS_MAX, errorCode('too_long'));

export type StorefrontSection = z.infer<typeof storefrontSectionSchema>;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

// A link or bold words, matched on the text before it is escaped. A link's address is https:// or a
// path on the shop's own site ("/pages/terms"), never "//other.site" (a link to another site that
// looks like a path), javascript: or data:, and it has no spaces, brackets or quotes, so it ends
// where the ")" is and cannot leave the href's quotes. Bold is the shortest run between two "**"
// on one line, so "**a** and **b**" is two bold words, not one long one.
const INLINE =
  /\[([^\]\n]+)\]\((https:\/\/[^\s()"'<>]+|\/(?!\/)[^\s()"'<>]*)\)|\*\*([^*\n]+?)\*\*/g;

function renderInline(text: string): string {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, linkText, href, bold] = match;
    html += escapeHtml(text.slice(last, match.index));
    if (bold !== undefined) {
      html += `<strong>${escapeHtml(bold)}</strong>`;
    } else if (linkText !== undefined && href !== undefined) {
      // Another site's page gets no referrer and no window.opener, like every outside link in the
      // shop (the tracking page's courier link)
      const rel = href.startsWith('https://') ? ' rel="noopener noreferrer"' : '';
      html += `<a href="${escapeHtml(href)}"${rel}>${escapeHtml(linkText)}</a>`;
    }
    last = match.index + whole.length;
  }
  return html + escapeHtml(text.slice(last));
}

const BULLET = /^[-*]\s+/;
const NUMBERED = /^\d{1,3}[.)]\s+/;

// One block of lines between blank lines: a list when every line is an item, else a paragraph.
// A paragraph keeps the tenant's line breaks (<br>): an address or a phone list on the contact page
// is written one per line
function renderBlock(lines: readonly string[]): string {
  if (lines.every((line) => BULLET.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(BULLET, ''))}</li>`);
    return `<ul>${items.join('')}</ul>`;
  }
  if (lines.every((line) => NUMBERED.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(NUMBERED, ''))}</li>`);
    return `<ol>${items.join('')}</ol>`;
  }
  return `<p>${lines.map(renderInline).join('<br>')}</p>`;
}

// The HTML the shop draws with its prose style (shopProductSchema.descriptionHtml,
// shopTextPageSchema.html): one <section> with an <h2> per section. No sections: '' (no
// description). Windows line ends (\r\n, from a pasted text) count as plain line ends.
export function renderSections(sections: readonly StorefrontSection[]): string {
  return sections
    .map((section) => {
      const blocks = section.body
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n/)
        .map((block) =>
          block
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        )
        .filter((lines) => lines.length > 0)
        .map(renderBlock);
      return `<section><h2>${escapeHtml(section.heading)}</h2>${blocks.join('')}</section>`;
    })
    .join('');
}

// The sections as plain words, for the page's <meta name="description"> when the tenant wrote no
// SEO description: the first section's text without its markup, cut at a word to at most `max`
// characters (search engines show about 155). '' when there is no section.
export function sectionsSummary(sections: readonly StorefrontSection[], max = 155): string {
  const first = sections[0];
  if (first === undefined) return '';
  const words = first.body
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .split('\n')
    .map((line) => line.trim().replace(BULLET, '').replace(NUMBERED, ''))
    .filter((line) => line !== '')
    .join(' ');
  if (words.length <= max) return words;
  // One character is kept for the "…". The cut is at a word's end already when the next character
  // is a space; otherwise it goes back to the last space, so no word is cut in half (a single word
  // longer than `max` is the exception: it is cut)
  const cut = words.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const whole = words[max - 1] === ' ' || lastSpace <= 0 ? cut : cut.slice(0, lastSpace);
  return `${whole.trimEnd()}…`;
}

// ---------------------------------------------------------------------------------------------
// Photos

// A listing shows at most this many: the product page's gallery has four thumbnails in its row
// (SHOP_GALLERY_MAX in storefront.ts, the same number). The first is the card's photo
export const STOREFRONT_IMAGES_MAX = 4;
export const STOREFRONT_ALT_MAX = 200;

// One photo as the ERP keeps it: the id of the uploaded picture (its files live under that id in
// the public storefront/ folder, made by step 26g's image job) and the words a screen reader says
// for it. The API turns the id into an address; the shop never sees a storage key.
export const storefrontImageSchema = z.object({
  id: z.uuid(),
  alt: z
    .string()
    .trim()
    .min(1, errorCode('required'))
    .max(STOREFRONT_ALT_MAX, errorCode('too_long')),
});

export const storefrontImagesSchema = z
  .array(storefrontImageSchema)
  .max(STOREFRONT_IMAGES_MAX, errorCode('too_long'));

export type StorefrontImage = z.infer<typeof storefrontImageSchema>;
```

**The sale.**

- `STOREFRONT_SALE_KINDS` keeps the sale the way the tenant typed it, not as one final price. The comment above it
  shows why: when the regular price changes from ৳250 to ৳260, "10% off" should follow it (৳234), "৳21 off" too
  (৳239), and "sell at ৳229" should not (৳229). A single stored final price would lose that.
- `salePercentSchema` takes a whole 1 to 99, the same range as the shop's `shopDiscountSchema`. The regex refuses
  `05` and `7.5` as well as `0` and `100`. A percent with a decimal would need a ribbon like "7.5% OFF", which the
  ribbon was not designed for.
- `saleMoneySchema` has two checks, and the second one runs only when the first passed
  (`!isMoneyAmount(value) || …`). Without that guard, `isZeroMoney('twenty')` would throw, because the money
  functions only take amounts. The test "refuses an amount or a price of zero" checks that `twenty` gets exactly one
  error, `money_format`.
- Whether the amount is under the regular price is **not** checked here. The schema does not know the regular price;
  the API does (26g).
- The schema is a discriminated union `.and(...)` the dates. The union decides how `value` is read; the dates are
  the same for all three kinds. The refine compares the dates with `Date.parse`, not as strings:
  `2026-11-16T00:00:00+06:00` and `2026-11-15T18:00:00Z` are the same moment and would compare wrong as text.

**`listingPricing`** builds the four price fields of a listing (`price`, `compareAtPrice`, `discount`,
`saleUntil`).

- `now` is a parameter, so a test fixes the clock instead of waiting for a sale to start.
- A sale outside its dates returns `noSale`. The end is exclusive (`time >= endsAt`, decision 11).
- `off` is worked out first, then `price = regular − off`. For "price" the off is `regular − value`, so every kind
  goes through the same check: nothing off, or a price of zero or less, is no sale (decision 9). That is the case
  where a product's regular price was lowered under the sale price after the sale was saved.
- A percent rounds half up to the paisa (`percentOfMoney`, the same function the sales lines use): 10% of ৳249.95
  is ৳25.00.
- The ribbon's taka is `regular − price`, not `off` or the typed value. For "amount" both are the same number, but
  `subtractMoney` returns the 4-decimal form (`21.0000`) that every other amount in the answer has, even when the
  tenant typed `21`.

**Sections.**

- The comment block lists the whole markup the text box knows. It is small on purpose: it covers every description
  in Figma (a paragraph, a list of "**Brand:** Himalaya" lines, a numbered list) and a contact page (lines and a
  link).
- `escapeHtml` replaces the five characters that matter in HTML text and in a double-quoted attribute. `'` is
  included so the output stays safe even if someone later puts it in a single-quoted attribute.
- `INLINE` is matched on the text **before** it is escaped. Each piece between matches is escaped on its own, and
  so is each link's words and address. If the regex ran on escaped text instead, a `&amp;` in an address would be
  matched as `&amp;` and escaped again into `&amp;amp;`.
- The link address must be `https://…` or a path starting with one `/`. `(?!\/)` refuses `//evil.example`, which a
  browser reads as "another site, same protocol". `javascript:` and `data:` cannot match at all. The address class
  `[^\s()"'<>]` has no quote, so an address cannot close the `href="…"` and add an attribute. The test "links to
  https and to the shop only" tries all four.
- `rel="noopener noreferrer"` goes only on outside links, the same rule as the tracking page's courier link (26e).
- `renderBlock`: a block is a list only when **every** line is an item. A block with one bullet and one plain line
  stays a paragraph, which is what the tenant sees in the preview too. A paragraph keeps line breaks as `<br>`,
  because an address on the contact page is one line per part.
- `renderSections` turns `\r\n` into `\n` first: a text pasted from Word on Windows has them, and without this every
  line would end in a stray `\r`. A blank line may hold spaces or tabs (`\n[ \t]*\n`), which a text box often keeps.
- `sectionsSummary` is the fallback for the page's description (decision 14). It drops the markup (`**`, the link
  syntax, the list marks) and joins the lines with spaces. The cut keeps one character for the `…` and never ends
  inside a word, unless one word alone is longer than `max`.

**Photos.** `storefrontImageSchema` keeps an id and the alt text, never a storage key or an address. The API builds
the address from the id (26f.3), so moving the files later changes one function, not every row. `alt` is required:
the shop's contract already refuses a photo without words for a screen reader.

```ts
import { describe, expect, it } from 'vitest';

import {
  listingPricing,
  renderSections,
  sectionsSummary,
  STOREFRONT_IMAGES_MAX,
  storefrontImagesSchema,
  storefrontSaleSchema,
  storefrontSectionsSchema,
  type StorefrontSale,
} from './storefront-content.js';
import { SHOP_GALLERY_MAX } from './storefront.js';

// A neem face wash at ৳250, on a Sunday afternoon in Dhaka
const NOW = new Date('2026-11-15T10:00:00+06:00');
const ALWAYS = { startsAt: null, endsAt: null };

type SaleDates = Pick<StorefrontSale, 'startsAt' | 'endsAt'>;

function sale(
  kind: StorefrontSale['kind'],
  value: string,
  dates: SaleDates = ALWAYS,
): StorefrontSale {
  return storefrontSaleSchema.parse({ kind, value, ...dates });
}

describe('listing pricing', () => {
  it('sells at the regular price without a sale', () => {
    expect(listingPricing('250.0000', null, NOW)).toEqual({
      price: '250.0000',
      compareAtPrice: null,
      discount: null,
      saleUntil: null,
    });
  });

  it('takes a percent off, to the paisa, and the ribbon says the percent', () => {
    expect(listingPricing('249.9500', sale('percent', '10'), NOW)).toEqual({
      // 10% of ৳249.95 is ৳24.995, rounded half up to ৳25.00
      price: '224.9500',
      compareAtPrice: '249.9500',
      discount: { kind: 'percent', value: 10 },
      saleUntil: null,
    });
  });

  it('takes an amount off', () => {
    const pricing = listingPricing('250.0000', sale('amount', '21'), NOW);
    expect(pricing.price).toBe('229.0000');
    expect(pricing.discount).toEqual({ kind: 'amount', value: '21.0000' });
  });

  it('sells at a set price, and the ribbon says the taka it saves', () => {
    const pricing = listingPricing('250.0000', sale('price', '229'), NOW);
    expect(pricing.price).toBe('229.0000');
    expect(pricing.compareAtPrice).toBe('250.0000');
    expect(pricing.discount).toEqual({ kind: 'amount', value: '21.0000' });
  });

  it('keeps a set price when the regular price changes, and a percent follows it', () => {
    expect(listingPricing('260.0000', sale('price', '229'), NOW).price).toBe('229.0000');
    expect(listingPricing('260.0000', sale('percent', '10'), NOW).price).toBe('234.0000');
  });

  it('shows no sale that would take nothing off, or everything', () => {
    // The regular price fell under the set sale price
    expect(listingPricing('220.0000', sale('price', '229'), NOW).compareAtPrice).toBeNull();
    expect(listingPricing('220.0000', sale('price', '220'), NOW).compareAtPrice).toBeNull();
    // ৳300 off a ৳250 face wash
    expect(listingPricing('250.0000', sale('amount', '300'), NOW).price).toBe('250.0000');
    expect(listingPricing('250.0000', sale('amount', '250'), NOW).price).toBe('250.0000');
  });

  it('runs a sale only between its dates, and the end is the countdown', () => {
    const dates = { startsAt: '2026-11-15T09:00:00+06:00', endsAt: '2026-11-16T23:59:00+06:00' };
    const live = listingPricing('250.0000', sale('amount', '21', dates), NOW);
    expect(live.price).toBe('229.0000');
    expect(live.saleUntil).toBe(dates.endsAt);

    const early = new Date('2026-11-15T08:59:59+06:00');
    expect(listingPricing('250.0000', sale('amount', '21', dates), early).discount).toBeNull();
    // The end itself is no longer the sale: the countdown has reached zero
    const end = new Date(dates.endsAt);
    expect(listingPricing('250.0000', sale('amount', '21', dates), end).discount).toBeNull();
  });
});

describe('sale schema', () => {
  it('takes a whole percent from 1 to 99', () => {
    for (const value of ['1', '10', '99', ' 15 ']) {
      expect(storefrontSaleSchema.safeParse({ kind: 'percent', value, ...ALWAYS }).success).toBe(
        true,
      );
    }
    for (const value of ['0', '100', '7.5', '05', '', '-5']) {
      const result = storefrontSaleSchema.safeParse({ kind: 'percent', value, ...ALWAYS });
      expect(result.error?.issues[0]?.message).toBe('storefront_sale_percent');
    }
  });

  it('refuses an amount or a price of zero, and one that is not money', () => {
    for (const kind of ['amount', 'price'] as const) {
      const zero = storefrontSaleSchema.safeParse({ kind, value: '0.00', ...ALWAYS });
      expect(zero.error?.issues.map((issue) => issue.message)).toEqual(['storefront_sale_zero']);
      const words = storefrontSaleSchema.safeParse({ kind, value: 'twenty', ...ALWAYS });
      expect(words.error?.issues.map((issue) => issue.message)).toEqual(['money_format']);
    }
  });

  it('refuses an end at or before the start, whatever their offsets', () => {
    const backwards = storefrontSaleSchema.safeParse({
      kind: 'amount',
      value: '21',
      startsAt: '2026-11-16T00:00:00+06:00',
      // The same moment, written in UTC
      endsAt: '2026-11-15T18:00:00Z',
    });
    expect(backwards.error?.issues[0]).toMatchObject({
      message: 'storefront_sale_dates',
      path: ['endsAt'],
    });
  });
});

describe('sections', () => {
  it('writes paragraphs, lists and bold words', () => {
    const html = renderSections([
      {
        heading: 'Specifications',
        body: 'A soap-free herbal cleanser.\nFor every day.\n\n- **Brand:** Himalaya\n- **Size:** 150ml\n\n1. Wet the face\n2. Rinse',
      },
    ]);
    expect(html).toBe(
      '<section><h2>Specifications</h2>' +
        '<p>A soap-free herbal cleanser.<br>For every day.</p>' +
        '<ul><li><strong>Brand:</strong> Himalaya</li><li><strong>Size:</strong> 150ml</li></ul>' +
        '<ol><li>Wet the face</li><li>Rinse</li></ol>' +
        '</section>',
    );
  });

  it('escapes everything the tenant typed', () => {
    const html = renderSections([
      {
        heading: '<script>alert(1)</script>',
        body: 'Neem & Turmeric <img src=x onerror=alert(1)> "quoted"',
      },
    ]);
    expect(html).toBe(
      '<section><h2>&lt;script&gt;alert(1)&lt;/script&gt;</h2>' +
        '<p>Neem &amp; Turmeric &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;</p></section>',
    );
  });

  it('links to https and to the shop only, and never lets a link leave its quotes', () => {
    const html = renderSections([
      {
        heading: 'Contact',
        body: [
          'See [our terms](/pages/terms) and [bKash](https://www.bkash.com/help?a=1&b=2).',
          '[evil](javascript:alert(1)) [other](//evil.example) [data](data:text/html,x)',
          '[quote](https://x.example/"onmouseover="alert(1))',
        ].join('\n'),
      },
    ]);
    expect(html).toContain('<a href="/pages/terms">our terms</a>');
    expect(html).toContain(
      '<a href="https://www.bkash.com/help?a=1&amp;b=2" rel="noopener noreferrer">bKash</a>',
    );
    // Not links: they stay as the words the tenant typed
    expect(html).toContain('[evil](javascript:alert(1))');
    expect(html).toContain('[other](//evil.example)');
    expect(html).toContain('[data](data:text/html,x)');
    expect(html).not.toContain('onmouseover="');
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it('keeps a mixed block a paragraph, and drops empty lines and Windows line ends', () => {
    const html = renderSections([
      { heading: 'Use', body: '- Wet the face\nThen rinse\r\n\r\n\r\n   \n- One\r\n- Two' },
    ]);
    expect(html).toBe(
      '<section><h2>Use</h2><p>- Wet the face<br>Then rinse</p>' +
        '<ul><li>One</li><li>Two</li></ul></section>',
    );
  });

  it('writes nothing for no sections', () => {
    expect(renderSections([])).toBe('');
  });

  it('allows up to 12 sections, each with a heading and some text', () => {
    const section = { heading: 'Benefits', body: 'Cleans deeply.' };
    expect(storefrontSectionsSchema.safeParse(Array(12).fill(section)).success).toBe(true);
    expect(storefrontSectionsSchema.safeParse(Array(13).fill(section)).success).toBe(false);
    const blank = storefrontSectionsSchema.safeParse([{ heading: '  ', body: 'x' }]);
    expect(blank.error?.issues[0]?.message).toBe('required');
  });
});

describe('sections summary', () => {
  it('is the first section as plain words', () => {
    expect(
      sectionsSummary([
        {
          heading: 'Overview',
          body: '**Soap-free** face wash.\n\n- Controls oil\n- [Neem](/c/neem)',
        },
        { heading: 'More', body: 'Not this.' },
      ]),
    ).toBe('Soap-free face wash. Controls oil Neem');
  });

  it('cuts a long text at a word, with an ellipsis', () => {
    const summary = sectionsSummary([{ heading: 'x', body: 'Neem face wash '.repeat(20) }], 30);
    expect(summary).toBe('Neem face wash Neem face wash…');
    expect(summary.length).toBeLessThanOrEqual(30);
  });

  it('is empty without sections', () => {
    expect(sectionsSummary([])).toBe('');
  });
});

describe('images', () => {
  it('keeps as many photos as the gallery shows', () => {
    expect(STOREFRONT_IMAGES_MAX).toBe(SHOP_GALLERY_MAX);
    const photo = { id: '0193a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', alt: 'Neem face wash, front' };
    expect(storefrontImagesSchema.safeParse(Array(4).fill(photo)).success).toBe(true);
    expect(storefrontImagesSchema.safeParse(Array(5).fill(photo)).success).toBe(false);
  });

  it('needs words for a screen reader', () => {
    const result = storefrontImagesSchema.safeParse([
      { id: '0193a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', alt: ' ' },
    ]);
    expect(result.error?.issues[0]?.message).toBe('required');
  });
});
```

The tests use one product (a ৳250 neem face wash) and one fixed `NOW`. Each `describe` matches a block above. The
sections tests check the exact HTML for the normal cases, and only `toContain` / `not.toContain` for the attack
cases, because what matters there is what must never appear.

### The public routes and the product's SEO: `storefront.ts`

```diff
@@ -1,6 +1,7 @@
 import { z } from 'zod';
 
 import { errorCode } from './errors.js';
+import { defineRoute } from './http.js';
 import { isMoneyAmount } from './money.js';
 import { pageOf } from './pagination.js';
 import { LANGUAGE_CODES } from './preferences.js';
@@ -168,10 +169,19 @@ export const shopProductSchema = shopListingSchema.extend({
   // nothing to a shopper
   unitName: z.string().min(1),
   // The description, as HTML: one <section> per block, each starting with an <h2>, then <p>, <ul>
-  // or <ol>, and <strong> for label words. The ERP cleans it to these tags when the tenant saves it
-  // (step 26's API), because the shop puts it on the page as it is. '' = no description, and the
-  // page leaves out the whole Overview card
+  // or <ol>, <strong> for label words, <a> and <br>. Step 26f: the tenant never writes HTML; the
+  // API writes it from the tenant's sections (renderSections in storefront-content.ts), escaping
+  // every character they typed, because the shop puts it on the page as it is. '' = no
+  // description, and the page leaves out the whole Overview card
   descriptionHtml: z.string(),
+  // Step 26f: what search engines show for the page. The API fills both in, so the shop never
+  // decides: the title is the tenant's SEO title or the listing's name, the description their SEO
+  // description or the start of the first section ('' when there is neither, and the page then
+  // has no <meta name="description">)
+  seo: z.object({
+    title: z.string().min(1).max(120),
+    description: z.string().max(300),
+  }),
 });
 
 // What /p/<slug> needs in one answer: the product and its "Related Products" row. The related
@@ -680,8 +690,8 @@ export const shopTrackingSchema = z.object({
 export const SHOP_TEXT_PAGES = ['privacy', 'terms', 'about', 'contact'] as const;
 
 // One text page. The HTML is the description's kind (step 26b): <section>s with an <h2>, then <p>,
-// <ul>, <ol>, <strong> and <a>, cleaned by the ERP when the tenant saves it (step 26's API), drawn
-// as it is with the description's prose style. A page the tenant has not written does not come at
+// <ul>, <ol>, <strong>, <a> and <br>, written by the API from the tenant's sections (step 26f),
+// drawn as it is with the description's prose style. A page the tenant has not written does not come at
 // all (the source answers null and the shop shows "page not found"), so html is never empty
 export const shopTextPageSchema = z.object({
   slug: z.enum(SHOP_TEXT_PAGES),
@@ -699,3 +709,159 @@ export type ShopShipment = z.infer<typeof shopShipmentSchema>;
 export type ShopTracking = z.infer<typeof shopTrackingSchema>;
 export type ShopTextPage = z.infer<typeof shopTextPageSchema>;
 export type ShopTextPageSlug = (typeof SHOP_TEXT_PAGES)[number];
+
+// ---------------------------------------------------------------------------------------------
+// Step 26f: the public API (/public/v1). What the shop's server asks the ERP's API for, with no
+// login. Every answer is one of the shapes above, so the shop's pages do not change when its data
+// source goes from the mock to this API.
+
+// Which shop: the address the shopper typed ("acme.omnivo.shop"), as the shop's server received it
+// in its own Host header. The shop's server calls the API from inside the network, so the API's
+// own Host header is the API's name, not the shop's; this header carries the shop's. It names a
+// shop and nothing else: anyone may send any value, and all it can get is what that shop's own
+// pages already show to anyone (published listings, never an order or a phone). The API takes the
+// subdomain from it ("acme") and looks it up with the database's storefront_tenant_for_subdomain
+// (migration 0064); an address that is not a launched shop gets 404 storefront_not_found. Never a
+// query parameter (system design §14.2): a link with ?shop=… would be a way to pass one shop off as
+// another.
+export const SHOP_HOST_HEADER = 'x-shop-host';
+
+// A slug in an address: the characters the ERP allows in one, so it is safe in a URL and in a
+// cache key
+const slugParamSchema = z
+  .string()
+  .max(100)
+  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
+
+// The category and search query as a querystring. Every value arrives as text and may be left out;
+// the flags are "1" or absent, as in the shop's own addresses (?stock=1&offer=1). Turned into the
+// clean ShopListingQuery by listingQueryFromParams.
+export const publicListingParamsSchema = z
+  .object({
+    category: slugParamSchema.optional(),
+    q: z.string().trim().max(SHOP_SEARCH_MAX_LENGTH).optional(),
+    sort: z.enum(SHOP_SORTS).optional(),
+    minPrice: shopPriceFilterSchema.optional(),
+    maxPrice: shopPriceFilterSchema.optional(),
+    inStock: z.literal('1').optional(),
+    offer: z.literal('1').optional(),
+    cursor: z.string().min(1).max(512).optional(),
+  })
+  // The same rule as shopListingQuerySchema, so a wrong pair is a 400 at the door, not a ZodError
+  // deep in the service
+  .refine(
+    (params) =>
+      params.minPrice === undefined ||
+      params.maxPrice === undefined ||
+      Number(params.minPrice) <= Number(params.maxPrice),
+    { message: errorCode('invalid_value'), path: ['maxPrice'] },
+  );
+
+export type PublicListingParams = z.input<typeof publicListingParamsSchema>;
+
+// The API's side: the querystring (parsed) as the clean query the listing search takes. A search
+// of only spaces is no search, as on the shop's pages
+export function listingQueryFromParams(
+  params: z.output<typeof publicListingParamsSchema>,
+): ShopListingQuery {
+  return {
+    category: params.category ?? null,
+    q: params.q === undefined || params.q === '' ? null : params.q,
+    sort: params.sort ?? 'newest',
+    minPrice: params.minPrice ?? null,
+    maxPrice: params.maxPrice ?? null,
+    inStock: params.inStock === '1',
+    offer: params.offer === '1',
+    cursor: params.cursor ?? null,
+  };
+}
+
+// The shop's side: the clean query as the querystring it sends. Only what is set, so the default
+// first page of /c/all is the plain address, the same cache entry for every shopper
+export function listingParamsFromQuery(query: ShopListingQuery): PublicListingParams {
+  const params: PublicListingParams = {};
+  if (query.category !== null) params.category = query.category;
+  if (query.q !== null) params.q = query.q;
+  if (query.sort !== 'newest') params.sort = query.sort;
+  if (query.minPrice !== null) params.minPrice = query.minPrice;
+  if (query.maxPrice !== null) params.maxPrice = query.maxPrice;
+  if (query.inStock) params.inStock = '1';
+  if (query.offer) params.offer = '1';
+  if (query.cursor !== null) params.cursor = query.cursor;
+  return params;
+}
+
+// Orders, the phone code and tracking are not here: they stay in the shop's mock until step 27
+// stores orders (decision 1). The quote is here already: the cart drawer and the checkout need
+// today's prices and stock, and it only reads.
+export const publicStorefrontRoutes = {
+  shop: defineRoute({
+    method: 'GET',
+    path: '/public/v1/shop',
+    summary: 'The shop named by the X-Shop-Host header: name, logo, colors, contact (no login)',
+    auth: 'public',
+    status: 200,
+    response: publicShopSchema,
+  }),
+  categories: defineRoute({
+    method: 'GET',
+    path: '/public/v1/categories',
+    summary: "The shop's categories, every level, in their order (no login)",
+    auth: 'public',
+    status: 200,
+    response: z.array(shopCategorySchema),
+  }),
+  home: defineRoute({
+    method: 'GET',
+    path: '/public/v1/home',
+    summary:
+      "The shop's home page: hero banner, featured listings, banners and collections (no login)",
+    auth: 'public',
+    status: 200,
+    response: shopHomeSchema,
+  }),
+  listings: defineRoute({
+    method: 'GET',
+    path: '/public/v1/listings',
+    summary: 'Published listings of a category or a search, filtered, sorted and paged (no login)',
+    auth: 'public',
+    status: 200,
+    query: publicListingParamsSchema,
+    response: shopListingPageSchema,
+  }),
+  product: defineRoute({
+    method: 'GET',
+    path: '/public/v1/products/:slug',
+    summary: 'One published listing with its gallery, description and related listings (no login)',
+    auth: 'public',
+    status: 200,
+    params: z.object({ slug: slugParamSchema }),
+    response: shopProductPageSchema,
+  }),
+  quote: defineRoute({
+    method: 'POST',
+    path: '/public/v1/cart/quote',
+    summary: "Today's prices, stock and delivery charge for a cart of listing ids (no login)",
+    auth: 'public',
+    status: 200,
+    body: shopCartQuoteRequestSchema,
+    response: shopCartQuoteSchema,
+  }),
+  checkoutSettings: defineRoute({
+    method: 'GET',
+    path: '/public/v1/checkout-settings',
+    summary: 'Delivery zones, payment methods, free delivery and minimum order (no login)',
+    auth: 'public',
+    status: 200,
+    response: shopCheckoutSettingsSchema,
+  }),
+  textPage: defineRoute({
+    method: 'GET',
+    path: '/public/v1/pages/:slug',
+    summary: 'One of the footer pages (privacy, terms, about, contact) (no login)',
+    auth: 'public',
+    status: 200,
+    params: z.object({ slug: z.enum(SHOP_TEXT_PAGES) }),
+    response: shopTextPageSchema,
+  }),
+};
```

- `shopProductSchema` gains `seo`. Both fields are always there; the API fills them in (decision 14). The title is
  at most 120 characters and the description 300: longer ones are cut by search engines anyway, and a limit keeps a
  pasted essay out of the page's `<head>`.
- The comments on `descriptionHtml` and the text page now say where the HTML comes from (the API, from sections) and
  name the two tags sections add (`<a>`, `<br>`). The shop's prose style already draws both.
- `SHOP_HOST_HEADER` is decision 12. The comment says what a forged value can and cannot get, because a reviewer
  will ask.
- `slugParamSchema` is the ERP's slug rule. A slug goes into the API's address and into a cache key, so `../admin`
  or a space never gets that far.
- `publicListingParamsSchema` is the querystring form of `ShopListingQuery`: every field optional, flags as the
  literal `'1'`. It repeats the min/max refine, so a wrong pair is a 400 at the door. It must stay a `z.object`
  (a refine keeps it one in Zod 4): `RouteDef.query` takes only an object, because Nest and OpenAPI read its keys.
- `listingQueryFromParams` and `listingParamsFromQuery` are the two directions. The API uses the first, the shop's
  source (26f.5) the second. `listingParamsFromQuery` leaves out every default (decision 13).
- `publicStorefrontRoutes`: eight routes, all `auth: 'public'`. The quote is a `POST` with status 200, not 201: it
  creates nothing. Orders are not here (decision 1).

```diff
@@ -19,6 +19,7 @@ import { meRoutes } from './preferences.js';
 import { reportScheduleRoutes } from './report-schedules.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { stockMovementReportRoutes } from './stock-movement-report.js';
+import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
@@ -153,4 +154,5 @@ export const routes = {
   pos: posRoutes,
   posShifts: posShiftRoutes,
   posReturns: posReturnRoutes,
+  publicStorefront: publicStorefrontRoutes,
 };
```

The registry lists every route the API serves. `apps/api/src/contract.spec.ts` checks that Nest serves exactly
this list, so from here until 26f.3 adds the controller, that one test fails. That is expected; the next parts fix
it.

```diff
@@ -62,6 +62,7 @@ export * from './stock-adjustments.js';
 export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
 export * from './storefront.js';
+export * from './storefront-content.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

```diff
@@ -632,6 +632,13 @@ export const ERROR_CODES = [
   'shop_order_no_format',
   'shop_track_not_found',
   'shop_track_too_many',
+  // Step 26f: the public API's address is not a shop (no storefront has this domain, or its
+  // workspace has turned the shop off), and a listing's sale as the ERP's form sends it: a
+  // percent that is not a whole 1 to 99, an amount of zero, an end not after its start
+  'storefront_not_found',
+  'storefront_sale_percent',
+  'storefront_sale_zero',
+  'storefront_sale_dates',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

`storefront_not_found` is the answer for an address that is not a shop. The three sale codes are what the schema
above sends; the form in 26g shows them under the boxes.

```diff
@@ -1,7 +1,11 @@
 import { describe, expect, it } from 'vitest';
 
 import {
+  listingParamsFromQuery,
+  listingQueryFromParams,
+  publicListingParamsSchema,
   publicShopSchema,
+  publicStorefrontRoutes,
   SHOP_CART_MAX_LINES,
   SHOP_CART_MAX_QUANTITY,
   shopCartQuoteLineSchema,
@@ -44,6 +48,7 @@ const NEEM_PRODUCT = {
   sku: 'MD2346',
   unitName: 'Piece',
   descriptionHtml: '<section><h2>Key Benefits</h2><ul><li>Controls excess oil</li></ul></section>',
+  seo: { title: 'Himalaya Purifying Neem Face Wash 150ml', description: 'Controls excess oil' },
 };
 
 describe('public shop', () => {
@@ -631,3 +636,57 @@ describe('text page', () => {
     );
   });
 });
+
+describe('public API', () => {
+  const PLAIN = {
+    category: null,
+    q: null,
+    sort: 'newest',
+    minPrice: null,
+    maxPrice: null,
+    inStock: false,
+    offer: false,
+    cursor: null,
+  } as const;
+
+  it('sends only what is set, so the first page of /c/all is the plain address', () => {
+    expect(listingParamsFromQuery(PLAIN)).toEqual({});
+  });
+
+  it('reads back the query it sent', () => {
+    const query = {
+      category: 'skin-care',
+      q: 'neem',
+      sort: 'price_asc',
+      minPrice: '100',
+      maxPrice: '500',
+      inStock: true,
+      offer: true,
+      cursor: 'eyJwIjoiMjI5In0',
+    } as const;
+    const params = publicListingParamsSchema.parse(listingParamsFromQuery(query));
+    expect(params).toMatchObject({ inStock: '1', offer: '1' });
+    expect(listingQueryFromParams(params)).toEqual(query);
+  });
+
+  it('takes a search of only spaces as no search', () => {
+    expect(listingQueryFromParams(publicListingParamsSchema.parse({ q: '   ' })).q).toBeNull();
+  });
+
+  it('refuses prices the wrong way round, and flags other than 1', () => {
+    const backwards = publicListingParamsSchema.safeParse({ minPrice: '500', maxPrice: '90' });
+    expect(backwards.error?.issues[0]).toMatchObject({
+      message: 'invalid_value',
+      path: ['maxPrice'],
+    });
+    expect(publicListingParamsSchema.safeParse({ inStock: 'true' }).success).toBe(false);
+    expect(publicListingParamsSchema.safeParse({ category: '../admin' }).success).toBe(false);
+  });
+
+  it('has no login on any route, and every path under /public/v1', () => {
+    for (const route of Object.values(publicStorefrontRoutes)) {
+      expect(route.auth).toBe('public');
+      expect(route.path.startsWith('/public/v1/')).toBe(true);
+    }
+  });
+});
```

The product in the existing test gains `seo`, or it would fail the new required field. The new tests check the two
conversions in both directions, the plain first page, a search of spaces, a backwards price pair, and that every
route is public and under `/public/v1/`.

### The words for the new errors

```diff
@@ -7182,6 +7182,11 @@ export const en = {
     shop_order_no_format: 'Type the order number from the SMS, like W-000123.',
     shop_track_not_found: 'No order has this number and mobile number. Check both, then try again.',
     shop_track_too_many: 'Too many tries. Wait {{minutes}} minutes, then try again.',
+    storefront_not_found:
+      'This address is not a shop. Check the address, or ask the shop for its link.',
+    storefront_sale_percent: 'Type a whole percent from 1 to 99.',
+    storefront_sale_zero: 'Type an amount above ৳0.',
+    storefront_sale_dates: 'Pick an end after the start, or leave the end empty.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6750,6 +6750,10 @@ export const bn: Messages = {
     shop_track_not_found:
       'এই নম্বর আর মোবাইল নম্বরের কোনো অর্ডার নেই। দুটোই দেখে আবার চেষ্টা করুন।',
     shop_track_too_many: 'অনেকবার চেষ্টা হয়েছে। {{minutes}} মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
+    storefront_not_found: 'এই ঠিকানায় কোনো শপ নেই। ঠিকানাটা দেখুন, অথবা শপের কাছে লিংক চেয়ে নিন।',
+    storefront_sale_percent: '১ থেকে ৯৯-এর মধ্যে একটা পূর্ণ শতাংশ লিখুন।',
+    storefront_sale_zero: '৳০-এর বেশি একটা অঙ্ক লিখুন।',
+    storefront_sale_dates: 'শুরুর পরের একটা শেষ সময় বাছুন, অথবা শেষ সময় ফাঁকা রাখুন।',
   },
   ui: {
     dataTable: {
```

Each message says what to do, as the rules for copy ask. `storefront_not_found` is read by a shopper who typed a
wrong address, so it tells them to ask the shop for its link.

### The mock's product gets its SEO

```diff
@@ -109,6 +109,12 @@ const neemProduct: Omit<ShopProduct, 'saleUntil'> = {
   sku: NEEM_SKU,
   unitName: 'Piece',
   descriptionHtml: NEEM_DESCRIPTION,
+  // Step 26f: what the API sends when the tenant wrote no SEO words: the name, and the start of
+  // the first section
+  seo: {
+    title: NEEM_NAME,
+    description: `Refresh and purify your skin every day with ${NEEM_NAME}. Enriched with the natural goodness of Neem & Turmeric, this soap-free face wash…`,
+  },
 };
 
 // Every listing the mock shop sells: the home page's and the product page's. The quote looks a
@@ -166,6 +172,7 @@ export function mockProductPage(slug: string, now: Date): ShopProductPage | null
       sku: null,
       unitName: 'Piece',
       descriptionHtml: '',
+      seo: { title: found.name, description: '' },
     },
     // The same category, as the real API will choose them, without the product itself
     related: mockCatalog
```

The mock is a `ShopSource` too, so its product must have the new field, or the shop stops type-checking. It sends
what the API would send for the same data: the name, and the start of the first section. A plain mock product has
no description, so its SEO description is `''`.

### Check this part

```sh
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
```

`@omnivo/i18n` is built before the shop's type check: the shop reads the words from the package's `dist/`, and an
old build does not know the new error codes (the check fails on `errors.storefront_not_found` in `track.astro`).

One test is expected to fail until 26f.3: `apps/api/src/contract.spec.ts` ("serves exactly the routes in
@omnivo/contracts"), because the eight `/public/v1` routes are in the registry and not served yet. `pnpm
test:openapi` fails for the same reason until 26f.3 writes the new spec.

Broken on purpose while writing this part, each caught by a test:

- the percent regex as `/^\d{1,2}$/` (takes `0` and `05`),
- the link regex without `(?!\/)` (`//evil.example` became a link),
- the ribbon's amount as the typed value (`21` instead of `21.0000`),
- the summary cut at the last space always (`Neem face wash Neem face…`: one word too short).

## 26f.2 — The tables and who may read them

This part stores the shop. Eight tables hold what the tenant writes (26g's screens fill them). Migration 0064 then
decides who reads them: the ERP as before, and the public API through a new role that sees only what a shopper
may see. Nothing serves the data yet; 26f.3 does.

How the public reading works, in one picture:

```text
shop server ──GET /public/v1/home, X-Shop-Host: acme.omnivosoft.com──▶ API (connected as omnivo_app)
  BEGIN
  SET LOCAL ROLE omnivo_public                     -- from here on, only the shop's rights
  SELECT storefront_tenant_for_subdomain('acme')   -- the one look across workspaces: one id or NULL
  SELECT set_config('app.tenant_id', <id>, true)   -- tenant_isolation, as for any member
  SELECT … FROM storefront_listings …              -- + the RESTRICTIVE policies: launched, published
  COMMIT                                           -- the role and the tenant end here
```

### The schema: `packages/db/src/schema/storefront.ts`

A new file. It starts with the patterns the checks use and two small helpers.

```ts
import {
  LANGUAGE_CODES,
  SHOP_PAYMENT_METHODS,
  SHOP_TEXT_PAGES,
  STOREFRONT_SALE_KINDS,
  type ShopBadge,
  type ShopDeliveryZone,
  type ShopPaymentMethod,
  type StorefrontImage,
  type StorefrontSection,
} from '@omnivo/contracts';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// Step 26f: the tenant's online shop (apps/shop), as the ERP keeps it. The shop's pages read it
// through /public/v1 as the omnivo_public role, which sees only what a shopper may see (migration
// 0064). Step 26g's Storefront screens write it as omnivo_app, like every other table. What the
// shopper gets (storefront.ts in the contracts) is worked out from these rows by the API: a price
// from the variant and the sale, HTML from the sections, an address from an image id.

// The rules every slug here follows: the contract's slugParamSchema, so a slug the ERP saves is
// always one the public API's routes accept
const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
// A colour as the shop's CSS takes it. Either case: the contract's hexColorSchema allows both
const HEX_PATTERN = '^#[0-9a-fA-F]{6}$';
// A link the tenant typed: a page of the shop itself or another https site. "//x.com" is not a
// path, so a path's second character is never "/" (the contract's linkSchema)
const LINK_PATTERN = '^(/([^/]|$)|https://)';

// `value ~ 'pattern'`, for the checks. sql.raw, because a CHECK cannot take a bound parameter ($1),
// and drizzle would make one of a plain string. Safe here: the patterns are this file's constants,
// never input
function matches(value: SQLWrapper, pattern: string): SQL {
  return sql`${value} ~ ${sql.raw(`'${pattern}'`)}`;
}

// A jsonb array's length, or NULL when the value is not an array. jsonb_array_length() of an
// object throws (22023) instead of returning false, and Postgres may run both sides of an AND in
// any order, so "jsonb_typeof(x) = 'array' AND jsonb_array_length(x) <= 4" can still throw. With
// this, the length check passes on NULL and the type check beside it refuses the row as a normal
// check_violation, which the API can turn into an error code
function arrayLength(value: SQLWrapper): SQL {
  return sql`CASE WHEN jsonb_typeof(${value}) = 'array' THEN jsonb_array_length(${value}) END`;
}
```

- The three patterns copy the contract's own rules (`slugParamSchema`, `hexColorSchema`, `linkSchema`). The API
  checks them first with Zod; the database checks them again, so a row written by some other code path (a seed, a
  later import, a bug) can still never hold a slug the public routes refuse or a `javascript:` link that ends up
  in an `<a href>`.
- `matches()` uses `sql.raw`. drizzle turns a plain string inside `sql` into a bound parameter (`$1`), and a
  `CHECK` cannot have one, so `drizzle-kit generate` would write SQL that Postgres refuses. `sql.raw` writes the
  text itself. That is safe only because the patterns are this file's constants, never anything a person typed.
- `arrayLength()` exists because of a bug the database checks found. The first version said
  `jsonb_typeof(x) = 'array' AND jsonb_array_length(x) <= 6`. Postgres does not promise to run the left side first,
  and `jsonb_array_length('{}')` does not return false: it throws `22023`. So a wrong value got an odd error
  instead of a `check_violation`, which the API could not turn into an error code. With the `CASE`, a non-array
  gives `NULL`, the length check lets `NULL` pass, and the type check beside it refuses the row properly.

#### The shop's settings

```ts
// One row per workspace that has a shop. The row is made by step 26g's first save, and the shop
// answers once launched_at is set ("Open the shop"); until then its address is a 404, so a
// half-made shop is never on the internet. There is no way to close it again (step 26e: a shop is
// always open).
export const storefrontSettings = pgTable(
  'storefront_settings',
  {
    // One shop per workspace, so the tenant is the key (like tenant_settings)
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    // The shop's own name in its address: "acme" in acme.omnivo.shop. Only the label, never the
    // whole host: dev (acme.localhost), staging and production put a different domain after it
    // (the API's SHOP_BASE_DOMAIN), and the same row works in all of them. Step 26g starts it as
    // the workspace's slug. A custom domain (www.acme.com.bd) is a later step with its own table.
    subdomain: text('subdomain').notNull(),
    // The name in the header and the footer. Its own column, not tenants.name: the shop may trade
    // under another name than the company, and omnivo_public never reads the tenants table
    name: text('name').notNull(),
    language: text('language', { enum: LANGUAGE_CODES }).notNull().default('en'),
    // An uploaded picture (StorefrontImage's id, step 26g); its alt text is the shop's name. NULL:
    // the Omnivo mark is drawn next to the name
    logoImageId: uuid('logo_image_id'),
    // The two colours a tenant may change (CLAUDE.md → Storefront color tokens). The defaults are
    // Figma's. That they keep 4.5:1 between them is checked by step 26g's form, not here: a
    // contrast ratio is arithmetic SQL should not do
    brandColor: text('brand_color').notNull().default('#005859'),
    accentColor: text('accent_color').notNull().default('#b8ef69'),
    hotline: text('hotline').notNull(),
    address: text('address').notNull(),
    // One column per network, not a jsonb object: each can then be checked to be https
    facebookUrl: text('facebook_url'),
    instagramUrl: text('instagram_url'),
    xUrl: text('x_url'),
    linkedinUrl: text('linkedin_url'),
    // Where the shop's stock is counted (decision 3) and, from step 27, where its orders are
    // picked. NULL only before the launch: every listing would be out of stock
    defaultWarehouseId: uuid('default_warehouse_id'),
    // The checkout's radio cards ("Inside Dhaka — ৳80"). A list edited as one, read whole by the
    // checkout and the quote, and at most six: a jsonb array, not a table
    deliveryZones: jsonb('delivery_zones').$type<ShopDeliveryZone[]>().notNull().default([]),
    // NULL: never free / any order size. Per the subtotal, like shopCheckoutSettingsSchema
    freeDeliveryFrom: numeric('free_delivery_from', { precision: 19, scale: 4 }),
    minimumOrder: numeric('minimum_order', { precision: 19, scale: 4 }),
    paymentMethods: text('payment_methods', { enum: SHOP_PAYMENT_METHODS })
      .array()
      .$type<ShopPaymentMethod[]>()
      .notNull()
      .default(sql`'{cod}'::text[]`),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    // One address, one shop, across every workspace: the host lookup reads this index
    uniqueIndex('storefront_settings_subdomain_idx').on(table.subdomain),
    // A DNS label in lower case: 1 to 63 letters, digits and hyphens, never starting or ending
    // with a hyphen. Lower case only, so "Acme" and "acme" can never be two shops
    check(
      'storefront_settings_subdomain_check',
      sql`${table.subdomain} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check(
      'storefront_settings_colors_check',
      sql`${matches(table.brandColor, HEX_PATTERN)} AND ${matches(table.accentColor, HEX_PATTERN)}`,
    ),
    // Each link ends up in an <a href> on every page: never javascript: or plain http
    check(
      'storefront_settings_social_check',
      sql`coalesce(${table.facebookUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.instagramUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.xUrl}, 'https://') LIKE 'https://%' AND coalesce(${table.linkedinUrl}, 'https://') LIKE 'https://%'`,
    ),
    check(
      'storefront_settings_zones_check',
      sql`jsonb_typeof(${table.deliveryZones}) = 'array' AND ${arrayLength(table.deliveryZones)} <= 6`,
    ),
    check(
      'storefront_settings_amounts_check',
      sql`coalesce(${table.freeDeliveryFrom}, 1) > 0 AND coalesce(${table.minimumOrder}, 1) > 0`,
    ),
    // At least one way to pay, or no order can be placed
    check('storefront_settings_payment_check', sql`cardinality(${table.paymentMethods}) >= 1`),
    // A launched shop can sell: it counts stock somewhere and delivers somewhere. Before the
    // launch the tenant may save the form half-filled
    check(
      'storefront_settings_launch_check',
      sql`${table.launchedAt} IS NULL OR (${table.defaultWarehouseId} IS NOT NULL AND ${arrayLength(table.deliveryZones)} >= 1)`,
    ),
    // A warehouse of this workspace. No ON DELETE: warehouses are archived, never deleted
    foreignKey({
      name: 'storefront_settings_warehouse_fk',
      columns: [table.tenantId, table.defaultWarehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
  ],
);
```

- The tenant is the primary key: one shop per workspace, and a second settings row is impossible, as with
  `tenant_settings`.
- `subdomain` is only the label (decision 16). The unique index has no `tenant_id` in it on purpose: an address
  names one shop across all workspaces. The check is a DNS label in lower case, so `Acme` and `acme` can never be
  two shops, and `acme.shop` (a dot) or `-acme` cannot be saved at all.
- `name` is its own column, not `tenants.name`. A shop may trade under another name, and the public role never
  reads the `tenants` table: that table has no RLS, so a grant on it would let the role list every workspace.
- `logo_image_id` is a plain uuid for now (decision 19).
- The four social links are columns, not one jsonb object, so each can be checked to start with `https://`. The
  `coalesce(…, 'https://')` lets an empty link pass.
- `delivery_zones` is a jsonb array: the checkout reads the list whole, and there are at most six. A table would
  add joins and nothing else.
- `payment_methods` needs at least one entry, or no order could be placed.
- The launch check is the important one: a launched shop has a warehouse to count stock in and at least one zone
  to deliver to. Before the launch the tenant may save the form half-filled, which is how 26g's screen works
  (save as you go, then "Open the shop").
- The warehouse foreign key includes `tenant_id`, so another workspace's warehouse cannot be chosen.

#### The shop's categories

```ts
// The shop's own categories (decision: not the product categories). The ERP groups products the
// way its stock is kept ("Tablets", "Syrups"); a shop groups them the way people shop ("Diabetic
// care"). A tree, like product_categories, in the tenant's own order.
export const storefrontCategories = pgTable(
  'storefront_categories',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // NULL = a top category (the filter row's chips)
    parentId: uuid('parent_id'),
    // /c/<slug>. Unique in the whole shop, not only among siblings: the address has no parent in it
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    // The order among siblings, smallest first; ties by name. Not unique: a reorder then writes
    // only the rows that moved
    position: smallint('position').notNull().default(0),
  },
  (table) => [
    uniqueIndex('storefront_categories_slug_idx').on(table.tenantId, table.slug),
    // Two "Tea" side by side would be two chips with one name. COALESCE as in product_categories:
    // NULLs never collide in a unique index
    uniqueIndex('storefront_categories_sibling_name_idx').on(
      table.tenantId,
      sql`coalesce(${table.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${table.name})`,
    ),
    // The target of the parent FK and of the listings' category FK
    uniqueIndex('storefront_categories_tenant_id_idx').on(table.tenantId, table.id),
    index('storefront_categories_tenant_parent_idx').on(table.tenantId, table.parentId),
    // A category with children cannot be deleted (no ON DELETE): step 26g says so in words
    foreignKey({
      name: 'storefront_categories_parent_fk',
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('storefront_categories_parent_not_self', sql`${table.parentId} <> ${table.id}`),
    check(
      'storefront_categories_slug_check',
      sql`${matches(table.slug, SLUG_PATTERN)} AND char_length(${table.slug}) <= 100`,
    ),
  ],
);
```

The shop has its own tree (agreed with the user): the ERP groups products the way stock is kept, a shop the way
people shop. It copies `product_categories` with two changes. The slug is unique in the whole shop, not only among
siblings, because `/c/<slug>` has no parent in it. And `position` orders siblings; it is not unique, so moving one
category writes only the rows that moved. A category with children or with listings cannot be deleted: there is no
`ON DELETE`, and 26g turns the error into words.

#### The listings

```ts
// A variant on sale in the shop: its page, its card and what the cart buys. The stock item stays
// the ERP's (product_variants); the listing adds what only a shop needs. Its price is the variant's
// sale_price unless price_override says otherwise (decision 2).
export const storefrontListings = pgTable(
  'storefront_listings',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Both, for the composite FK below: a variant of THIS product of THIS workspace. product_id
    // also lets omnivo_public's policy on products find the listed ones without a join
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    categoryId: uuid('category_id').notNull(),
    slug: text('slug').notNull(),
    // The name a shopper reads ("Himalaya Neem Face Wash"), not the ERP's ("HIM-NFW-150"). Step
    // 26g starts it from the product's name and the variant's options
    name: text('name').notNull(),
    // Words under the name ("150ml"); '' = none
    packSize: text('pack_size').notNull().default(''),
    // NULL = the variant's sale_price (decision 2)
    priceOverride: numeric('price_override', { precision: 19, scale: 4 }),
    // The sale as the tenant typed it (StorefrontSale): all NULL = no sale. listingPricing() turns
    // it into the shop's price, struck-out price and ribbon at the moment of the request
    saleKind: text('sale_kind', { enum: STOREFRONT_SALE_KINDS }),
    // A percent (1–99) or taka, to the paisa
    saleValue: numeric('sale_value', { precision: 19, scale: 4 }),
    saleStartsAt: timestamp('sale_starts_at', { withTimezone: true }),
    // Exclusive (decision 11): at this moment the sale is over
    saleEndsAt: timestamp('sale_ends_at', { withTimezone: true }),
    badges: text('badges')
      .array()
      .$type<ShopBadge[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    // At most four (STOREFRONT_IMAGES_MAX); the first is the card's. A jsonb array of
    // StorefrontImage, not a table: the four are saved and read together, in their order
    images: jsonb('images').$type<StorefrontImage[]>().notNull().default([]),
    // The description as sections (decision 8), never HTML. The API escapes and renders them
    descriptionSections: jsonb('description_sections')
      .$type<StorefrontSection[]>()
      .notNull()
      .default([]),
    // NULL = the name / the start of the first section (decision 14)
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    // NULL = a draft the shop never shows. Also the "Newest" sort: the time it went on sale
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('storefront_listings_slug_idx').on(table.tenantId, table.slug),
    // One listing per variant: two pages for one stock item would split its stock between two
    // carts and its reviews (later) between two pages. Also what omnivo_public's policy on
    // product_variants looks up
    uniqueIndex('storefront_listings_variant_idx').on(table.tenantId, table.variantId),
    // The target of the collection items' FK
    uniqueIndex('storefront_listings_tenant_id_idx').on(table.tenantId, table.id),
    // omnivo_public's policy on products
    index('storefront_listings_product_idx').on(table.tenantId, table.productId),
    // /c/<slug>, and what Postgres uses to check the category FK on delete
    index('storefront_listings_category_idx').on(table.tenantId, table.categoryId),
    // /c/all, newest first: only the published ones are ever listed, so only they are indexed
    index('storefront_listings_published_idx')
      .on(table.tenantId, table.publishedAt.desc())
      .where(sql`${table.publishedAt} IS NOT NULL`),
    // The search's trigram index on lower(name) is in migration 0064, like the products' (0020):
    // drizzle cannot write an operator class on an expression
    // No ON DELETE: a listed product cannot be deleted. The products API turns this FK's error
    // into product_in_use (step 26f.3 adds it to VARIANT_IN_USE), and the tenant archives it
    foreignKey({
      name: 'storefront_listings_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    // A category with listings cannot be deleted either
    foreignKey({
      name: 'storefront_listings_category_fk',
      columns: [table.tenantId, table.categoryId],
      foreignColumns: [storefrontCategories.tenantId, storefrontCategories.id],
    }),
    check(
      'storefront_listings_slug_check',
      sql`${matches(table.slug, SLUG_PATTERN)} AND char_length(${table.slug}) <= 100`,
    ),
    // Zero is no price: a free product is not something a shop lists
    check(
      'storefront_listings_price_check',
      sql`${table.priceOverride} IS NULL OR ${table.priceOverride} > 0`,
    ),
    // storefrontSaleSchema again, so a row the API did not write can still never hold a sale
    // listingPricing() cannot read: a kind with its value, dates only with a sale, a whole percent
    // from 1 to 99, an amount above zero, and an end after the start
    check(
      'storefront_listings_sale_check',
      sql`(${table.saleKind} IS NULL) = (${table.saleValue} IS NULL)
        AND (${table.saleKind} IS NOT NULL OR (${table.saleStartsAt} IS NULL AND ${table.saleEndsAt} IS NULL))
        AND (${table.saleValue} IS NULL OR ${table.saleValue} > 0)
        AND (${table.saleKind} IS DISTINCT FROM 'percent' OR (${table.saleValue} = trunc(${table.saleValue}) AND ${table.saleValue} <= 99))
        AND (${table.saleStartsAt} IS NULL OR ${table.saleEndsAt} IS NULL OR ${table.saleStartsAt} < ${table.saleEndsAt})`,
    ),
    check(
      'storefront_listings_images_check',
      sql`jsonb_typeof(${table.images}) = 'array' AND ${arrayLength(table.images)} <= 4`,
    ),
    // A card always has a photo (shopListingSchema.images.min(1)): a draft may wait for one, a
    // published listing may not
    check(
      'storefront_listings_published_check',
      sql`${table.publishedAt} IS NULL OR ${arrayLength(table.images)} >= 1`,
    ),
    check(
      'storefront_listings_sections_check',
      sql`jsonb_typeof(${table.descriptionSections}) = 'array' AND ${arrayLength(table.descriptionSections)} <= 12`,
    ),
    // The contract's seo limits: a longer title would fail shopProductSchema on every request
    check(
      'storefront_listings_seo_check',
      sql`coalesce(char_length(${table.seoTitle}), 1) BETWEEN 1 AND 120 AND coalesce(char_length(${table.seoDescription}), 0) <= 300`,
    ),
  ],
);
```

- A listing points at a variant through `(tenant_id, product_id, variant_id)`. The product id is there for the
  composite foreign key (a variant of *this* product of *this* workspace) and for the public role's policy on
  `products`, which can then find the listed products without a join.
- One listing per variant (`storefront_listings_variant_idx`). Two pages for one stock item would split its stock
  between two carts.
- The sale is four columns, kept as the tenant typed it (`storefrontSaleSchema`). The check repeats the schema's
  rules: a kind always has a value, dates only with a sale, a percent is a whole number from 1 to 99, an amount is
  above zero, and the end comes after the start. `IS DISTINCT FROM 'percent'` is used instead of `<>` because
  `sale_kind` may be `NULL`, and `NULL <> 'percent'` is `NULL`, not true.
- `images` and `description_sections` are jsonb arrays of the contract's types: they are saved and read together,
  in their order. A draft may have no photo yet; a published listing must have one (`shopListingSchema` requires
  it, and an answer without it would fail on every request).
- The SEO check uses the contract's limits. An empty SEO title is refused: `NULL` means "use the name", and `''`
  would make a page with no title.
- `published_at` is both the switch and the "Newest" sort. Its index is partial, so drafts are not in it.
- There is no `ON DELETE` to the variant. A product that is listed cannot be deleted: the products API must turn
  this new foreign key's error into `product_in_use` (26f.3 adds it to `VARIANT_IN_USE`), and the tenant archives
  the product instead.
- The search's trigram index is in migration 0064, because drizzle cannot write an operator class on an
  expression.

#### Banners

```ts
// The home page's pictures: the one hero at the top (kind 'hero') and the picture-only banners
// between the rows (kind 'image'). One table for both: they share the link and the two pictures,
// and the hero's extra words are columns the checks below keep on the hero only.
export const storefrontBanners = pgTable(
  'storefront_banners',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind', { enum: ['hero', 'image'] }).notNull(),
    href: text('href').notNull(),
    // Desktop and phone draw a banner differently (CLAUDE.md → Hero banner), so each has its own
    // picture. StorefrontImage objects
    desktopImage: jsonb('desktop_image').$type<StorefrontImage>().notNull(),
    phoneImage: jsonb('phone_image').$type<StorefrontImage>().notNull(),
    // The hero's words and colours (heroBannerSchema); NULL on an image banner, whose words are
    // part of its picture
    headline: text('headline'),
    line: text('line'),
    eyebrow: text('eyebrow'),
    buttonLabel: text('button_label'),
    backgroundColor: text('background_color'),
    panelColor: text('panel_color'),
    buttonColor: text('button_color'),
    buttonTextColor: text('button_text_color'),
  },
  (table) => [
    // The home blocks' FK
    uniqueIndex('storefront_banners_tenant_id_idx').on(table.tenantId, table.id),
    // The home page has one hero (shopHomeSchema.hero)
    uniqueIndex('storefront_banners_hero_idx')
      .on(table.tenantId)
      .where(sql`${table.kind} = 'hero'`),
    check('storefront_banners_href_check', matches(table.href, LINK_PATTERN)),
    check(
      'storefront_banners_images_check',
      sql`jsonb_typeof(${table.desktopImage}) = 'object' AND jsonb_typeof(${table.phoneImage}) = 'object'`,
    ),
    // Two exact cases. A hero has its headline, its button and all four colours (line and eyebrow
    // are optional on it). An image banner has none of the hero's eight fields: a stray headline on
    // one would never show, and step 26g's form would offer to edit words nobody sees. Not
    // "(kind = 'hero') = (all six are there)": that lets an image banner keep a headline, since
    // "not all six" is still true
    check(
      'storefront_banners_hero_check',
      sql`(${table.kind} = 'hero' AND num_nonnulls(${table.headline}, ${table.buttonLabel}, ${table.backgroundColor}, ${table.panelColor}, ${table.buttonColor}, ${table.buttonTextColor}) = 6)
        OR (${table.kind} = 'image' AND num_nonnulls(${table.headline}, ${table.line}, ${table.eyebrow}, ${table.buttonLabel}, ${table.backgroundColor}, ${table.panelColor}, ${table.buttonColor}, ${table.buttonTextColor}) = 0)`,
    ),
    check(
      'storefront_banners_colors_check',
      // NULL passes (a regex on NULL is NULL, which a CHECK lets through): the hero check above says
      // which ones must be there
      sql`${matches(table.backgroundColor, HEX_PATTERN)} AND ${matches(table.panelColor, HEX_PATTERN)} AND ${matches(table.buttonColor, HEX_PATTERN)} AND ${matches(table.buttonTextColor, HEX_PATTERN)}`,
    ),
  ],
);
```

The hero and the picture-only banners share one table: both have a link and two pictures. The hero's words and
colours are columns that must be there on a hero and must be empty on an image banner. The partial unique index
allows one hero per shop.

The hero check is two exact cases with `num_nonnulls`. The first version was `(kind = 'hero') = (all six fields
are there)`, and the database checks showed the hole: an image banner with only a headline has "not all six", so
both sides were false, and false = false let it in. A stray headline would never show, but 26g's form would offer
to edit it.

#### Collections and the home page

```ts
// A row of hand-picked listings on the home page ("Refresh with Himalaya")
export const storefrontCollections = pgTable(
  'storefront_collections',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: text('title').notNull(),
    // 'fire': the flame after "Hot & Trending Right Now"; NULL = no icon
    icon: text('icon', { enum: ['fire'] }),
  },
  (table) => [uniqueIndex('storefront_collections_tenant_id_idx').on(table.tenantId, table.id)],
);

// The listings of a collection, in their order. A save replaces all of a collection's rows (like
// report_schedule_recipients), so the unique position never gets in the way of a reorder.
export const storefrontCollectionItems = pgTable(
  'storefront_collection_items',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    collectionId: uuid('collection_id').notNull(),
    listingId: uuid('listing_id').notNull(),
    // 1 = first in the row
    position: smallint('position').notNull(),
  },
  (table) => [
    // Each listing once per row
    primaryKey({
      name: 'storefront_collection_items_pkey',
      columns: [table.tenantId, table.collectionId, table.listingId],
    }),
    uniqueIndex('storefront_collection_items_position_idx').on(
      table.tenantId,
      table.collectionId,
      table.position,
    ),
    // A listing's rows, for the cascade below
    index('storefront_collection_items_listing_idx').on(table.tenantId, table.listingId),
    foreignKey({
      name: 'storefront_collection_items_collection_fk',
      columns: [table.tenantId, table.collectionId],
      foreignColumns: [storefrontCollections.tenantId, storefrontCollections.id],
    }).onDelete('cascade'),
    // A deleted listing leaves every row it was in. An unpublished one stays in the row and
    // comes back when it is published again: omnivo_public simply does not see it meanwhile
    foreignKey({
      name: 'storefront_collection_items_listing_fk',
      columns: [table.tenantId, table.listingId],
      foreignColumns: [storefrontListings.tenantId, storefrontListings.id],
    }).onDelete('cascade'),
    check('storefront_collection_items_position_check', sql`${table.position} >= 1`),
  ],
);

// What the home page shows under the hero and the featured grid, top to bottom: each block is an
// image banner or a collection (shopHomeSchema.blocks). A save replaces all of a shop's rows.
export const storefrontHomeBlocks = pgTable(
  'storefront_home_blocks',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    position: smallint('position').notNull(),
    // Exactly one of the two. The banner is an image banner: the API refuses the hero here (one
    // column of a composite FK cannot say "kind = image", and a trigger for it is not worth it)
    bannerId: uuid('banner_id'),
    collectionId: uuid('collection_id'),
  },
  (table) => [
    primaryKey({
      name: 'storefront_home_blocks_pkey',
      columns: [table.tenantId, table.position],
    }),
    // Each banner and each collection once on the page. Partial: the other column is NULL
    uniqueIndex('storefront_home_blocks_banner_idx')
      .on(table.tenantId, table.bannerId)
      .where(sql`${table.bannerId} IS NOT NULL`),
    uniqueIndex('storefront_home_blocks_collection_idx')
      .on(table.tenantId, table.collectionId)
      .where(sql`${table.collectionId} IS NOT NULL`),
    // Deleting a banner or a collection takes it off the page
    foreignKey({
      name: 'storefront_home_blocks_banner_fk',
      columns: [table.tenantId, table.bannerId],
      foreignColumns: [storefrontBanners.tenantId, storefrontBanners.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_home_blocks_collection_fk',
      columns: [table.tenantId, table.collectionId],
      foreignColumns: [storefrontCollections.tenantId, storefrontCollections.id],
    }).onDelete('cascade'),
    check(
      'storefront_home_blocks_one_check',
      sql`num_nonnulls(${table.bannerId}, ${table.collectionId}) = 1`,
    ),
    check('storefront_home_blocks_position_check', sql`${table.position} >= 1`),
  ],
);
```

- A collection is a title and an optional icon. Its items are rows with a position. A save replaces all of a
  collection's rows, as `report_schedule_recipients` does, so the unique position never blocks a reorder.
- Deleting a listing removes it from every collection (`ON DELETE CASCADE`). An unpublished listing stays in its
  rows; the public role simply does not see it, and it comes back when it is published again.
- A home block is exactly one of a banner or a collection (`num_nonnulls(…) = 1`), each at most once on the page.
  Deleting the banner or the collection removes its block.

#### Text pages

```ts
// The footer's four text pages. A page the tenant has not written has no row (the shop shows "page
// not found"); updated_at is the "Last updated" date under its title.
export const storefrontPages = pgTable(
  'storefront_pages',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slug: text('slug', { enum: SHOP_TEXT_PAGES }).notNull(),
    sections: jsonb('sections').$type<StorefrontSection[]>().notNull(),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
  },
  (table) => [
    primaryKey({ name: 'storefront_pages_pkey', columns: [table.tenantId, table.slug] }),
    // A page with no section would be an empty card under its title
    check(
      'storefront_pages_sections_check',
      sql`jsonb_typeof(${table.sections}) = 'array' AND ${arrayLength(table.sections)} BETWEEN 1 AND 12`,
    ),
  ],
);
```

The footer's four pages, keyed by `(tenant_id, slug)`. A page the tenant has not written has no row. A written page
has at least one section, or the shop would show an empty card under its title.

#### Export it

```diff
@@ -52,3 +52,4 @@ export * from './supplier-refunds.js';
 export * from './sync.js';
 export * from './pos.js';
 export * from './report-schedules.js';
+export * from './storefront.js';
```

### Migration 0063 (generated): the tables

Generate it from the `packages/db` folder:

```sh
pnpm --filter @omnivo/db generate --name storefront
```

`drizzle-kit` writes the tables, then the foreign keys, then the indexes. That order fails: a composite foreign key
needs its target's unique index first (`storefront_categories_parent_fk` points at
`storefront_categories_tenant_id_idx`), and Postgres answers "there is no unique constraint matching given keys".
Move the `CREATE INDEX` and `CREATE UNIQUE INDEX` lines above the first `ALTER TABLE … ADD CONSTRAINT`, as the
earlier migrations have them (0019, 0061). Do not edit the snapshot (`meta/0063_snapshot.json`): it describes the
tables, not the order of the statements.

```sql
CREATE TABLE "storefront_banners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"href" text NOT NULL,
	"desktop_image" jsonb NOT NULL,
	"phone_image" jsonb NOT NULL,
	"headline" text,
	"line" text,
	"eyebrow" text,
	"button_label" text,
	"background_color" text,
	"panel_color" text,
	"button_color" text,
	"button_text_color" text,
	CONSTRAINT "storefront_banners_href_check" CHECK ("storefront_banners"."href" ~ '^(/([^/]|$)|https://)'),
	CONSTRAINT "storefront_banners_images_check" CHECK (jsonb_typeof("storefront_banners"."desktop_image") = 'object' AND jsonb_typeof("storefront_banners"."phone_image") = 'object'),
	CONSTRAINT "storefront_banners_hero_check" CHECK (("storefront_banners"."kind" = 'hero' AND num_nonnulls("storefront_banners"."headline", "storefront_banners"."button_label", "storefront_banners"."background_color", "storefront_banners"."panel_color", "storefront_banners"."button_color", "storefront_banners"."button_text_color") = 6)
        OR ("storefront_banners"."kind" = 'image' AND num_nonnulls("storefront_banners"."headline", "storefront_banners"."line", "storefront_banners"."eyebrow", "storefront_banners"."button_label", "storefront_banners"."background_color", "storefront_banners"."panel_color", "storefront_banners"."button_color", "storefront_banners"."button_text_color") = 0)),
	CONSTRAINT "storefront_banners_colors_check" CHECK ("storefront_banners"."background_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."panel_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."button_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_banners"."button_text_color" ~ '^#[0-9a-fA-F]{6}$')
);--> statement-breakpoint
CREATE TABLE "storefront_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "storefront_categories_parent_not_self" CHECK ("storefront_categories"."parent_id" <> "storefront_categories"."id"),
	CONSTRAINT "storefront_categories_slug_check" CHECK ("storefront_categories"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("storefront_categories"."slug") <= 100)
);--> statement-breakpoint
CREATE TABLE "storefront_collection_items" (
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "storefront_collection_items_pkey" PRIMARY KEY("tenant_id","collection_id","listing_id"),
	CONSTRAINT "storefront_collection_items_position_check" CHECK ("storefront_collection_items"."position" >= 1)
);--> statement-breakpoint
CREATE TABLE "storefront_collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"icon" text
);--> statement-breakpoint
CREATE TABLE "storefront_home_blocks" (
	"tenant_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"banner_id" uuid,
	"collection_id" uuid,
	CONSTRAINT "storefront_home_blocks_pkey" PRIMARY KEY("tenant_id","position"),
	CONSTRAINT "storefront_home_blocks_one_check" CHECK (num_nonnulls("storefront_home_blocks"."banner_id", "storefront_home_blocks"."collection_id") = 1),
	CONSTRAINT "storefront_home_blocks_position_check" CHECK ("storefront_home_blocks"."position" >= 1)
);--> statement-breakpoint
CREATE TABLE "storefront_listings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_size" text DEFAULT '' NOT NULL,
	"price_override" numeric(19, 4),
	"sale_kind" text,
	"sale_value" numeric(19, 4),
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"badges" text[] DEFAULT '{}'::text[] NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "storefront_listings_slug_check" CHECK ("storefront_listings"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("storefront_listings"."slug") <= 100),
	CONSTRAINT "storefront_listings_price_check" CHECK ("storefront_listings"."price_override" IS NULL OR "storefront_listings"."price_override" > 0),
	CONSTRAINT "storefront_listings_sale_check" CHECK (("storefront_listings"."sale_kind" IS NULL) = ("storefront_listings"."sale_value" IS NULL)
        AND ("storefront_listings"."sale_kind" IS NOT NULL OR ("storefront_listings"."sale_starts_at" IS NULL AND "storefront_listings"."sale_ends_at" IS NULL))
        AND ("storefront_listings"."sale_value" IS NULL OR "storefront_listings"."sale_value" > 0)
        AND ("storefront_listings"."sale_kind" IS DISTINCT FROM 'percent' OR ("storefront_listings"."sale_value" = trunc("storefront_listings"."sale_value") AND "storefront_listings"."sale_value" <= 99))
        AND ("storefront_listings"."sale_starts_at" IS NULL OR "storefront_listings"."sale_ends_at" IS NULL OR "storefront_listings"."sale_starts_at" < "storefront_listings"."sale_ends_at")),
	CONSTRAINT "storefront_listings_images_check" CHECK (jsonb_typeof("storefront_listings"."images") = 'array' AND CASE WHEN jsonb_typeof("storefront_listings"."images") = 'array' THEN jsonb_array_length("storefront_listings"."images") END <= 4),
	CONSTRAINT "storefront_listings_published_check" CHECK ("storefront_listings"."published_at" IS NULL OR CASE WHEN jsonb_typeof("storefront_listings"."images") = 'array' THEN jsonb_array_length("storefront_listings"."images") END >= 1),
	CONSTRAINT "storefront_listings_sections_check" CHECK (jsonb_typeof("storefront_listings"."description_sections") = 'array' AND CASE WHEN jsonb_typeof("storefront_listings"."description_sections") = 'array' THEN jsonb_array_length("storefront_listings"."description_sections") END <= 12),
	CONSTRAINT "storefront_listings_seo_check" CHECK (coalesce(char_length("storefront_listings"."seo_title"), 1) BETWEEN 1 AND 120 AND coalesce(char_length("storefront_listings"."seo_description"), 0) <= 300)
);--> statement-breakpoint
CREATE TABLE "storefront_pages" (
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"sections" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "storefront_pages_pkey" PRIMARY KEY("tenant_id","slug"),
	CONSTRAINT "storefront_pages_sections_check" CHECK (jsonb_typeof("storefront_pages"."sections") = 'array' AND CASE WHEN jsonb_typeof("storefront_pages"."sections") = 'array' THEN jsonb_array_length("storefront_pages"."sections") END BETWEEN 1 AND 12)
);--> statement-breakpoint
CREATE TABLE "storefront_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"subdomain" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"logo_image_id" uuid,
	"brand_color" text DEFAULT '#005859' NOT NULL,
	"accent_color" text DEFAULT '#b8ef69' NOT NULL,
	"hotline" text NOT NULL,
	"address" text NOT NULL,
	"facebook_url" text,
	"instagram_url" text,
	"x_url" text,
	"linkedin_url" text,
	"default_warehouse_id" uuid,
	"delivery_zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_delivery_from" numeric(19, 4),
	"minimum_order" numeric(19, 4),
	"payment_methods" text[] DEFAULT '{cod}'::text[] NOT NULL,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "storefront_settings_subdomain_check" CHECK ("storefront_settings"."subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "storefront_settings_colors_check" CHECK ("storefront_settings"."brand_color" ~ '^#[0-9a-fA-F]{6}$' AND "storefront_settings"."accent_color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "storefront_settings_social_check" CHECK (coalesce("storefront_settings"."facebook_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."instagram_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."x_url", 'https://') LIKE 'https://%' AND coalesce("storefront_settings"."linkedin_url", 'https://') LIKE 'https://%'),
	CONSTRAINT "storefront_settings_zones_check" CHECK (jsonb_typeof("storefront_settings"."delivery_zones") = 'array' AND CASE WHEN jsonb_typeof("storefront_settings"."delivery_zones") = 'array' THEN jsonb_array_length("storefront_settings"."delivery_zones") END <= 6),
	CONSTRAINT "storefront_settings_amounts_check" CHECK (coalesce("storefront_settings"."free_delivery_from", 1) > 0 AND coalesce("storefront_settings"."minimum_order", 1) > 0),
	CONSTRAINT "storefront_settings_payment_check" CHECK (cardinality("storefront_settings"."payment_methods") >= 1),
	CONSTRAINT "storefront_settings_launch_check" CHECK ("storefront_settings"."launched_at" IS NULL OR ("storefront_settings"."default_warehouse_id" IS NOT NULL AND CASE WHEN jsonb_typeof("storefront_settings"."delivery_zones") = 'array' THEN jsonb_array_length("storefront_settings"."delivery_zones") END >= 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_banners_tenant_id_idx" ON "storefront_banners" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_banners_hero_idx" ON "storefront_banners" USING btree ("tenant_id") WHERE "storefront_banners"."kind" = 'hero';--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_slug_idx" ON "storefront_categories" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_sibling_name_idx" ON "storefront_categories" USING btree ("tenant_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_categories_tenant_id_idx" ON "storefront_categories" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "storefront_categories_tenant_parent_idx" ON "storefront_categories" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_collection_items_position_idx" ON "storefront_collection_items" USING btree ("tenant_id","collection_id","position");--> statement-breakpoint
CREATE INDEX "storefront_collection_items_listing_idx" ON "storefront_collection_items" USING btree ("tenant_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_collections_tenant_id_idx" ON "storefront_collections" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_home_blocks_banner_idx" ON "storefront_home_blocks" USING btree ("tenant_id","banner_id") WHERE "storefront_home_blocks"."banner_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_home_blocks_collection_idx" ON "storefront_home_blocks" USING btree ("tenant_id","collection_id") WHERE "storefront_home_blocks"."collection_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_slug_idx" ON "storefront_listings" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_variant_idx" ON "storefront_listings" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_listings_tenant_id_idx" ON "storefront_listings" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "storefront_listings_product_idx" ON "storefront_listings" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "storefront_listings_category_idx" ON "storefront_listings" USING btree ("tenant_id","category_id");--> statement-breakpoint
CREATE INDEX "storefront_listings_published_idx" ON "storefront_listings" USING btree ("tenant_id","published_at" DESC NULLS LAST) WHERE "storefront_listings"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_settings_subdomain_idx" ON "storefront_settings" USING btree ("subdomain");--> statement-breakpoint
ALTER TABLE "storefront_banners" ADD CONSTRAINT "storefront_banners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_categories" ADD CONSTRAINT "storefront_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."storefront_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."storefront_collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collection_items" ADD CONSTRAINT "storefront_collection_items_listing_fk" FOREIGN KEY ("tenant_id","listing_id") REFERENCES "public"."storefront_listings"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_collections" ADD CONSTRAINT "storefront_collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_banner_fk" FOREIGN KEY ("tenant_id","banner_id") REFERENCES "public"."storefront_banners"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_home_blocks" ADD CONSTRAINT "storefront_home_blocks_collection_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."storefront_collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_listings" ADD CONSTRAINT "storefront_listings_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."storefront_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_pages" ADD CONSTRAINT "storefront_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_warehouse_fk" FOREIGN KEY ("tenant_id","default_warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;
```

```diff
@@ -442,6 +442,20 @@
       "when": 1794289438849,
       "tag": "0062_report-schedules-rules",
       "breakpoints": true
+    },
+    {
+      "idx": 63,
+      "version": "7",
+      "when": 1794730138512,
+      "tag": "0063_storefront",
+      "breakpoints": true
+    },
+    {
+      "idx": 64,
+      "version": "7",
+      "when": 1794730139948,
+      "tag": "0064_storefront-rules",
+      "breakpoints": true
     }
   ]
 }
\ No newline at end of file
```

### Migration 0064 (written by hand): who may read the shop

Make an empty one and write it in:

```sh
pnpm --filter @omnivo/db generate --custom --name storefront-rules
```

```sql
-- Custom SQL migration file, put your code below! --
-- Step 26f: who may read the shop. 0063 made the eight tables; this file gives them the tenant
-- rules every table has, and makes the role the public API reads as: omnivo_public, which sees a
-- launched shop's published listings and the few ERP columns their cards need, and nothing else.

-- 1) The eight new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    The policy has no TO, so it holds for every role, omnivo_public included: the public API sets
--    app.tenant_id to the shop's workspace, exactly like the ERP's API does for a member
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_settings', 'storefront_categories', 'storefront_listings',
      'storefront_banners', 'storefront_collections', 'storefront_collection_items',
      'storefront_home_blocks', 'storefront_pages'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- 2) The shop's search looks for words anywhere in a listing's name, like the products' search
--    (0020). lower() so any case matches; Bangla has no case and lower() leaves it alone. Here and
--    not in the schema file: drizzle cannot write an operator class on an expression
CREATE INDEX storefront_listings_name_trgm_idx
  ON storefront_listings USING gin (lower(name) gin_trgm_ops);

-- 3) The role. NOLOGIN: nobody connects as it, so it has no password to keep in the init scripts or
--    the server's .env. The API connects as omnivo_app, as always, and a public request's
--    transaction starts with SET LOCAL ROLE omnivo_public (LOCAL: it ends with the transaction, so
--    the pooled connection is omnivo_app again for the next request, like set_config(…, true)).
--    Made here and not in infra/docker/postgres/init/01-roles.sql: an init script runs only when a
--    volume is new, so the dev databases and the staging server would never get it. Roles belong
--    to the whole Postgres server, not to one database, hence IF NOT EXISTS: a second database on
--    the same server may have made it already.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omnivo_public') THEN
    CREATE ROLE omnivo_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO omnivo_public;
-- SET TRUE: omnivo_app may become it. INHERIT FALSE: omnivo_app does not get its rights or its
-- policies by being a member. Without it, the RESTRICTIVE policies below (written for
-- omnivo_public) would hold for omnivo_app too, and the ERP would stop seeing every variant that
-- is not on sale in the shop. Postgres 16+ syntax; the servers run 17.
GRANT omnivo_public TO omnivo_app WITH INHERIT FALSE, SET TRUE;

-- 4) What it may read. SELECT only: the public API never writes (orders come in step 27, with
--    their own grants). No default privileges either, so a table added later is closed to it until
--    a migration opens it. The ERP tables give only the columns a card and the quote need, so a
--    bug in the public API cannot read a cost, a supplier or a customer: those columns and tables
--    answer "permission denied".
GRANT SELECT ON storefront_settings, storefront_categories, storefront_listings, storefront_banners,
  storefront_collections, storefront_collection_items, storefront_home_blocks, storefront_pages
  TO omnivo_public;
-- The SKU, the regular price (decision 2), and whether it is archived (an archived product leaves
-- the shop)
GRANT SELECT (id, tenant_id, product_id, sku, sale_price, archived_at) ON product_variants
  TO omnivo_public;
-- "Per Piece": the base unit's name
GRANT SELECT (id, tenant_id, base_unit_id, archived_at) ON products TO omnivo_public;
GRANT SELECT (id, tenant_id, name) ON units TO omnivo_public;
-- In stock or not (decision 3). The API says only that, never the number
GRANT SELECT (tenant_id, warehouse_id, variant_id, quantity) ON stock_balances TO omnivo_public;
-- The shop prints its times in the workspace's zone (publicShopSchema.timeZone)
GRANT SELECT (tenant_id, timezone) ON tenant_settings TO omnivo_public;

-- 5) Which rows. tenant_isolation already keeps the role inside one workspace; these RESTRICTIVE
--    policies (AND-ed with it, never OR-ed) keep it to what that workspace's shop shows. TO
--    omnivo_public only: omnivo_app (INHERIT FALSE) and the migrator never meet them.

-- A shop that is not launched shows nothing, even if the API set its workspace by mistake
CREATE POLICY storefront_public_launched ON storefront_settings
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (launched_at IS NOT NULL);

-- Every other storefront table: only while its shop is launched. The subquery reads
-- storefront_settings as omnivo_public, so the policy above is part of it
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_categories', 'storefront_listings', 'storefront_banners',
      'storefront_collections', 'storefront_collection_items', 'storefront_home_blocks',
      'storefront_pages'])
  LOOP
    EXECUTE format(
      'CREATE POLICY storefront_public_launched ON %I
         AS RESTRICTIVE FOR SELECT TO omnivo_public
         USING (EXISTS (SELECT 1 FROM storefront_settings s WHERE s.tenant_id = %I.tenant_id))',
      t, t
    );
  END LOOP;
END $$;

-- A draft listing is not in the shop. A collection that holds one simply comes back without it,
-- because the API joins the items to the listings it can see
CREATE POLICY storefront_public_published ON storefront_listings
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (published_at IS NOT NULL);

-- The ERP's rows: only the variants and products a published listing sells. The subqueries read
-- storefront_listings as omnivo_public, so "published" and "launched" are part of them. Each is
-- one probe of an index (storefront_listings_variant_idx, storefront_listings_product_idx)
CREATE POLICY storefront_public_listed ON product_variants
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_listings l
    WHERE l.tenant_id = product_variants.tenant_id AND l.variant_id = product_variants.id
  ));
CREATE POLICY storefront_public_listed ON products
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_listings l
    WHERE l.tenant_id = products.tenant_id AND l.product_id = products.id
  ));
-- The stock of a listed variant in the shop's own warehouse, not in the others: how much a
-- workspace holds in its factory store is not the shop's business
CREATE POLICY storefront_public_listed ON stock_balances
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (
    EXISTS (
      SELECT 1 FROM storefront_listings l
      WHERE l.tenant_id = stock_balances.tenant_id AND l.variant_id = stock_balances.variant_id
    )
    AND warehouse_id = (
      SELECT s.default_warehouse_id FROM storefront_settings s
      WHERE s.tenant_id = stock_balances.tenant_id
    )
  );
-- units and tenant_settings need no more than tenant_isolation: a unit's name and the time zone
-- are on the shop's pages anyway, and the column grants above are all the role can read of them.

-- 6) From the address to the workspace. A request knows only the host, so it cannot set
--    app.tenant_id yet, and tenant_isolation shows it no settings row at all. This one function
--    looks across workspaces, and answers only "which workspace has this subdomain's launched
--    shop": one id, never a list, so nobody can walk through every shop with it.
--    SECURITY DEFINER: it runs as its owner, the migrator. FORCE RLS holds for the owner too, so
--    the migrator gets a policy of its own on storefront_settings to read across workspaces (it
--    owns the table and could turn RLS off anyway, so this gives it nothing new). search_path is
--    fixed, so a caller cannot slip in a table of its own named storefront_settings.
CREATE POLICY storefront_host_lookup ON storefront_settings
  FOR SELECT TO omnivo_migrator
  USING (true);

CREATE FUNCTION storefront_tenant_for_subdomain(label text) RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.tenant_id
  FROM storefront_settings s
  JOIN tenants t ON t.id = s.tenant_id
  -- A deleted workspace's shop is gone with it
  WHERE s.subdomain = lower(label) AND s.launched_at IS NOT NULL AND t.deleted_at IS NULL
$$;

-- Every role may run a new function (PUBLIC); this one is for the public API only
REVOKE EXECUTE ON FUNCTION storefront_tenant_for_subdomain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_tenant_for_subdomain(text) TO omnivo_public;
```

Section by section:

1. **The tenant rules** every table has. `tenant_isolation` has no `TO`, so it also holds for `omnivo_public`: the
   public API sets `app.tenant_id` to the shop's workspace, and the role then sees that workspace only.
2. **The search index**, like the products' in 0020.
3. **The role** (decision 15). `IF NOT EXISTS` because roles belong to the whole Postgres server: a second database
   on the same server may have made it already. `INHERIT FALSE` is the line that matters most. Without it,
   `omnivo_app` would take on the role's policies by being a member, the restrictive ones below would hold for the
   ERP too, and every screen would stop seeing the variants that are not in the shop. The checks below break it on
   purpose and catch it. `SET TRUE` is what lets the API run `SET LOCAL ROLE`.
4. **The grants.** Whole tables only for the storefront's own tables. On the ERP's tables only the columns a card
   and the quote need: a variant's SKU and price, a product's base unit, a unit's name, the stock quantity, the
   workspace's time zone. A product's name, its cost, a customer, an invoice and the `tenants` table answer
   "permission denied", so a bug in 26f.3 cannot leak them. No default privileges: a table added later stays
   closed to the role until a migration opens it.
5. **The restrictive policies.** A restrictive policy is AND-ed with the others, so it can only take rows away.
   `TO omnivo_public` keeps them off every other role. A shop that is not launched shows nothing, even when its
   workspace is set: the other tables ask `storefront_settings`, and the role sees a settings row only when it is
   launched. Variants, products and stock are limited to what a published listing sells; their subqueries read
   `storefront_listings` as the same role, so "published" and "launched" come along. Stock is limited to the
   shop's own warehouse too: the factory store's numbers are not the shop's business.
6. **From the address to the workspace.** Before the lookup the request has no tenant, so `tenant_isolation`
   shows it no settings row. The function is the only way across workspaces, and it answers one id for one label,
   never a list. It is `SECURITY DEFINER`, so it runs as its owner, the migrator. `FORCE ROW LEVEL SECURITY`
   holds for the owner too, so the migrator gets its own read policy on `storefront_settings`. That gives it
   nothing new: it owns the table and could turn RLS off. `search_path` is fixed so a caller cannot put a table of
   its own in front of the real one. `REVOKE … FROM PUBLIC` matters because every new function can be run by
   everyone; `omnivo_app` cannot call it either, which the checks confirm.

### Check this part

```sh
pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/db build
pnpm exec eslint packages/db/src/schema
pnpm exec prettier --check packages/db/src/schema/storefront.ts
pnpm --filter @omnivo/api exec tsc --noEmit
```

Then run the migrations on a database you can throw away, never your dev database:

```sh
docker run -d --name omnivo26f2-pg -e POSTGRES_DB=omnivo -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 55432:5432 -v "$PWD/infra/docker/postgres/init:/docker-entrypoint-initdb.d:ro" postgres:17-alpine
MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@127.0.0.1:55432/omnivo \
  pnpm --filter @omnivo/db migrate
docker rm -f omnivo26f2-pg
```

While writing this part, two SQL scripts ran on such a database: test data for two workspaces (one launched shop,
one not), then about 70 checks connected as `omnivo_app`. They checked that:

- the function finds `acme` (in any case) and nothing for a shop that is not launched or does not exist,
- the role sees one workspace's published listings, their variants and products, and the stock in the shop's
  warehouse only (5, not the factory's 100); nothing at all without a tenant, nothing for the unlaunched shop,
- a product's name and code, `parties`, `invoices`, `stock_values`, `tenants`, `warehouses` and any write answer
  "permission denied",
- the role ends with the transaction, and `omnivo_app` still sees all its variants and cannot call the function,
- every check and foreign key above refuses a bad row and accepts a good one.

The same checks come back as integration tests in 26f.4. Broken on purpose, each caught:

- `WITH INHERIT TRUE` (the ERP saw 1 variant instead of 3),
- no `storefront_public_published` policy (2 listings instead of 1),
- the stock policy without the warehouse rule (2 stock rows instead of 1).

Two real bugs were found by the checks and fixed above: the `jsonb_array_length` error on a non-array, and the
hero check that let an image banner keep a headline.

## 26f.3 — The public API

This part serves `/public/v1`: the eight routes 26f.1 defined, answered from the tables 26f.2 made, as the role
26f.2 made. Nothing in the ERP's screens changes, and the shop still reads its mock (26f.5 switches it). Two small
contract changes come first (decisions 22 and 23), then the config, then the module, file by file.

### Two changes to the contract

```diff
@@ -23,10 +23,18 @@ const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
 // banner links come from the tenant and end up in an <a href>
 const linkSchema = z.string().regex(/^(\/(?!\/)|https:\/\/)/);
 
+// Where a picture is. The links above, plus plain http on this computer only: step 26f's public
+// API builds photo addresses from the storage's own address (STOREFRONT_MEDIA_URL), and in dev that
+// is MinIO at http://localhost:9000. Never a tenant's typed text, so this loosening opens no way in
+// for a stranger's link; production refuses an http address when the API starts (config.ts)
+const imageUrlSchema = z
+  .string()
+  .regex(/^(\/(?!\/)|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/)/);
+
 // A picture and the words a screen reader says for it. The alt text is required: a product photo
 // is the main content of a shop, and an empty alt would hide it from blind shoppers
 export const shopImageSchema = z.object({
-  url: linkSchema,
+  url: imageUrlSchema,
   alt: z.string().min(1),
 });
 
@@ -125,7 +133,9 @@ export const shopCollectionSchema = z.object({
 });
 
 export const shopHomeSchema = z.object({
-  hero: heroBannerSchema,
+  // Step 26f: null when the tenant has no hero banner (a new shop, or one deleted later). The home
+  // page then starts with the "All Category" grid, so a shop never breaks for a missing picture
+  hero: heroBannerSchema.nullable(),
   // The "All Category" grid; the phone shows its first two as "Featured Products"
   featured: z.array(shopListingSchema),
   hasMoreFeatured: z.boolean(),
```

- `imageUrlSchema` is the old link rule plus plain http on this computer. The `(:\d{1,5})?\/` part needs a path
  after the host, so `http://localhost.evil.com/…` (a host that only starts like ours) does not pass. Banner links
  (`href`) still use `linkSchema`: those the tenant types, and they stay https or a path.
- `hero` is nullable. The comment says why: a missing picture must never take a shop down.

```diff
@@ -12,6 +12,8 @@ import {
   shopCartQuoteRequestSchema,
   shopCartQuoteSchema,
   shopCheckoutSettingsSchema,
+  shopHomeSchema,
+  shopImageSchema,
   SHOP_PAGE_SIZE,
   shopListingPageSchema,
   shopListingQuerySchema,
@@ -690,3 +692,25 @@ describe('public API', () => {
     }
   });
 });
+
+describe('public API answers (step 26f.3)', () => {
+  it('takes a photo from storage over https, a path, or plain http on this computer only', () => {
+    const ok = (url: string) => shopImageSchema.safeParse({ url, alt: 'Neem face wash' }).success;
+    expect(ok('https://files.omnivosoft.com/omnivo/storefront/a/small.webp')).toBe(true);
+    expect(ok('/mock/products/neem.png')).toBe(true);
+    expect(ok('http://localhost:9000/omnivo/storefront/a/small.webp')).toBe(true);
+    expect(ok('http://127.0.0.1:9000/omnivo/storefront/a/small.webp')).toBe(true);
+    // Another computer over plain http, a name that only starts like localhost, and no path at all
+    expect(ok('http://files.example.com/a.webp')).toBe(false);
+    expect(ok('http://localhost.evil.com/a.webp')).toBe(false);
+    expect(ok('http://localhost:9000')).toBe(false);
+    expect(ok('//cdn.example.com/a.webp')).toBe(false);
+  });
+
+  it('lets a home page have no hero banner', () => {
+    expect(
+      shopHomeSchema.safeParse({ hero: null, featured: [], hasMoreFeatured: false, blocks: [] })
+        .success,
+    ).toBe(true);
+  });
+});
```

The tests pin both: the four addresses that must pass, the four that must not, and a home page with no hero.

The shop's home page draws the hero only when there is one:

```diff
@@ -30,10 +30,11 @@ const query = readListingQuery(null, new URLSearchParams());
 >
   <h1 class="sr-only">{shop.name}</h1>
 
-  <HeroBanner hero={home.hero} />
+  {home.hero && <HeroBanner hero={home.hero} />}
 
   {/* Desktop "All Category" (Figma 37:3128); phone "All Categories" and "Featured Products" (138:797, 138:810) */}
-  <section aria-labelledby="all-category" class="mt-4 md:mt-16">
+  {/* Step 26f: with no hero, the grid sits where a category page's title does (36px under the header) */}
+  <section aria-labelledby="all-category" class:list={['mt-4', home.hero ? 'md:mt-16' : 'md:mt-9']}>
     <h2
       id="all-category"
       class="text-sf-subtitle leading-[23px] font-bold md:trim-text md:text-sf-display md:font-semibold"
```

`class:list` picks the gap. Under a hero the grid is 64px down (`md:mt-16`); without one it sits where a category
page's title sits, 36px under the header (`md:mt-9`), so the page never starts with an empty band.

Then rebuild the contracts (`pnpm --filter @omnivo/contracts build`): the API and the shop read them from `dist/`.

### The config: `apps/api/src/config.ts`

```diff
@@ -30,6 +30,18 @@ const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
   // Fastify then takes the client's address from X-Forwarded-For, so the audit log records the
   // person's IP, not the proxy's. Left off, a client could write any IP into that header.
   TRUST_PROXY: z.stringbool().default(false),
+  // Step 26f: the domain every shop's address ends with. A shop's subdomain is put before it:
+  // "acme" + "localhost" = acme.localhost (dev), "acme" + "omnivo.shop" = acme.omnivo.shop. One
+  // DNS name, lower case, no port and no dot at either end
+  SHOP_BASE_DOMAIN: z
+    .string()
+    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/)
+    .default('localhost'),
+  // Step 26f: the public address of the storage's storefront/ folder's parent, as a shopper's
+  // browser reaches it. Left out: the storage's own address and bucket (S3_ENDPOINT/S3_BUCKET),
+  // which is right for MinIO in dev and on staging. Cloudflare R2 serves public files from another
+  // address than its API, so production sets it
+  STOREFRONT_MEDIA_URL: z.url().optional(),
 });
 
 const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
@@ -69,6 +81,21 @@ function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | u
   return parsed.data;
 }
 
+// Step 26f: where the shop's photos are, without a "/" at the end (media.ts adds the path). The
+// contract allows http only on this computer (dev MinIO), so a production API with an http address
+// would answer every page with a broken contract; it refuses to start instead, with the reason
+function storefrontMediaUrl(e: z.output<typeof envSchema>): string {
+  const url = (
+    e.STOREFRONT_MEDIA_URL ?? `${e.S3_ENDPOINT.replace(/\/+$/, '')}/${e.S3_BUCKET}`
+  ).replace(/\/+$/, '');
+  if (e.NODE_ENV === 'production' && !url.startsWith('https://')) {
+    throw new Error(
+      `Invalid environment — the shop's photos need an https address. Set STOREFRONT_MEDIA_URL (now ${url}).`,
+    );
+  }
+  return url;
+}
+
 export function loadConfig(env: Record<string, string | undefined>) {
   const e = parseEnv(envSchema, env);
   return {
@@ -83,6 +110,11 @@ export function loadConfig(env: Record<string, string | undefined>) {
     // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
     secureCookies: e.NODE_ENV === 'production',
     storage: storageConfig(e),
+    // Step 26f: the public shop API (storefront/)
+    storefront: {
+      baseDomain: e.SHOP_BASE_DOMAIN,
+      mediaUrl: storefrontMediaUrl(e),
+    },
     auth: {
       betterAuthSecret: e.BETTER_AUTH_SECRET,
       baseURL: e.API_BASE_URL,
```

- `SHOP_BASE_DOMAIN` is the domain after every shop's subdomain. The regex is one DNS name in lower case, with no
  port: the host check (`shop-host.ts`) compares it with the end of the host, and a port or an upper-case letter
  in it would make every shop a 404. `localhost` by default, so dev needs nothing.
- `STOREFRONT_MEDIA_URL` is optional. Left out, the photos are read where the storage is (`S3_ENDPOINT` +
  `S3_BUCKET`), which is right for MinIO, path style, in dev and on staging (`https://files.omnivosoft.com/omnivo`).
  Cloudflare R2 answers its API on one address and its public files on another, so production sets it.
- `storefrontMediaUrl` strips a trailing `/` (the path is added later, and `//storefront` would be a different
  key on some CDNs) and refuses an http address in production. Refusing at start is better than starting: the
  contract would refuse every photo, so every page of every shop would answer 500, with a much worse message.

`.env.example` gets the two lines, with `STOREFRONT_MEDIA_URL` commented out:

```diff
@@ -27,6 +27,12 @@ S3_BUCKET=omnivo
 S3_ACCESS_KEY_ID=omnivo
 S3_SECRET_ACCESS_KEY=omnivo-dev-secret
 
+# Step 26f: the online shop's public API. A shop's address is its subdomain + this domain
+# (nirvor.localhost:4331 in dev). The shop's photos are read from STOREFRONT_MEDIA_URL/storefront/;
+# left out, it is S3_ENDPOINT/S3_BUCKET (right for MinIO). Production needs an https address
+SHOP_BASE_DOMAIN=localhost
+# STOREFRONT_MEDIA_URL=https://media.omnivo.shop
+
 # Email — only the worker sends it (invitations, welcome). Dev: docker-compose's Mailpit; every
 # email lands at http://localhost:8025
 SMTP_URL=smtp://localhost:1025
```

### Which shop: `apps/api/src/storefront/shop-host.ts`

```ts
// Step 26f: which shop a request is for, from the X-Shop-Host header (SHOP_HOST_HEADER in the
// contracts). The shop's server sends its own Host header in it, as the shopper's browser sent it:
// "acme.omnivo.shop", or "acme.localhost:4331" in dev.

// One DNS label, lower case: the same rule as storefront_settings_subdomain_check (migration 0063),
// so a label that passes here is one the database can hold
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// The shop's subdomain ("acme"), or null when the host is not one of ours. Only a single label
// in front of the base domain: "a.b.omnivo.shop" is not a shop, and neither is the base domain
// itself. The port goes first (dev runs on :4331), then a trailing dot (a fully qualified name,
// "acme.omnivo.shop.", is the same host), and the case: DNS names have none, and the browser
// sends lower case anyway.
export function subdomainOf(host: string | undefined, baseDomain: string): string | null {
  if (host === undefined) return null;
  const name = host
    .trim()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const suffix = `.${baseDomain}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  return LABEL.test(label) ? label : null;
}
```

The header carries the host the shopper's browser sent, so it may have a port (`:4331` in dev), a trailing dot (a
fully qualified name is the same host) and any case. Each is removed before the compare. The suffix check uses
`.${baseDomain}` with the dot: without it, `acme.evilomnivo.shop` would end with `omnivo.shop`. What is left must be
exactly one label that the database's check accepts, so `a.b.omnivo.shop` and `omnivo.shop` itself are not shops.
The function never throws: anything that is not a shop is `null`, and the caller answers the one 404.

```ts
import { describe, expect, it } from 'vitest';

import { subdomainOf } from './shop-host.js';

describe('subdomainOf', () => {
  it('takes the label in front of the base domain', () => {
    expect(subdomainOf('acme.omnivo.shop', 'omnivo.shop')).toBe('acme');
    expect(subdomainOf('nirvor-pharma.localhost', 'localhost')).toBe('nirvor-pharma');
  });

  it('drops the port, a trailing dot and the case', () => {
    expect(subdomainOf('acme.localhost:4331', 'localhost')).toBe('acme');
    expect(subdomainOf('ACME.Omnivo.Shop.', 'omnivo.shop')).toBe('acme');
    expect(subdomainOf(' acme.omnivo.shop ', 'omnivo.shop')).toBe('acme');
  });

  it('answers null for a host that is not one shop of ours', () => {
    expect(subdomainOf(undefined, 'omnivo.shop')).toBeNull();
    expect(subdomainOf('', 'omnivo.shop')).toBeNull();
    // The base domain itself, another domain, and one that only ends with the same letters
    expect(subdomainOf('omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme.example.com', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme.evilomnivo.shop', 'omnivo.shop')).toBeNull();
    // Two labels, an empty one, and labels the database's check refuses
    expect(subdomainOf('a.b.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('-acme.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf('acme_shop.omnivo.shop', 'omnivo.shop')).toBeNull();
    expect(subdomainOf(`${'a'.repeat(64)}.omnivo.shop`, 'omnivo.shop')).toBeNull();
  });
});
```

```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { SHOP_HOST_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

// The X-Shop-Host header as it came, or undefined. Node joins a header sent twice with ", ", which
// is then no host at all and gets the same 404 as any other: subdomainOf (shop-host.ts) is what
// reads it, never this
export const ShopHost = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<FastifyRequest>().headers[SHOP_HOST_HEADER];
  return typeof value === 'string' ? value : undefined;
});
```

A small parameter decorator, so each handler takes the header as an argument. Node joins a header sent twice into
one string with ", "; that is not a host, `subdomainOf` refuses it, and nothing here has to know.

### The public transaction: `apps/api/src/storefront/shop-db.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { type Db, storefrontSettings } from '@omnivo/db';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../common/http/app-error.js';
import { setTenantContext, type Transaction } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG, DB } from '../infra/tokens.js';
import { subdomainOf } from './shop-host.js';

// The one answer for every address that is not a launched shop: no such subdomain, a shop not
// launched yet, a deleted workspace, or a header that is not a host at all. Telling them apart
// would tell a stranger which workspaces are about to open a shop
export function storefrontNotFound(): AppError {
  return new AppError(404, 'storefront_not_found', 'There is no shop at this address.');
}

// What every public read knows about its shop once it is found
export interface ShopScope {
  tenantId: string;
  // Where the shop counts its stock (decision 3)
  warehouseId: string;
  // One clock for the whole answer: a sale that ends during the request is either on in every
  // card of it or in none, and the SQL's price (listing-sql.ts) and listingPricing() agree
  now: Date;
}

const tenantRowSchema = z.object({ tenant_id: z.uuid().nullable() });

// Step 26f: how the public API reads the database (decision 15). Every public request is one
// read-only transaction that first becomes omnivo_public (migration 0064), so even a bug in this
// module reads only what the shop's own pages show, and writes nothing.
@Injectable()
export class ShopDb {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  read<T>(
    host: string | undefined,
    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
  ): Promise<T> {
    // Before any database work: a host that cannot be a shop of ours costs nothing
    const label = subdomainOf(host, this.config.storefront.baseDomain);
    if (label === null) return Promise.reject(storefrontNotFound());

    return this.db.transaction(
      async (tx) => {
        // LOCAL: only until this transaction ends. The pooled connection is omnivo_app again for
        // the next request, as with set_config(…, true) in setTenantContext
        await tx.execute(sql`SET LOCAL ROLE omnivo_public`);
        // The one look across workspaces, through the database's own function: it answers one id
        // for a launched shop, or NULL
        const [found] = z
          .array(tenantRowSchema)
          .parse(
            await tx.execute(
              sql`SELECT storefront_tenant_for_subdomain(${label})::text AS tenant_id`,
            ),
          );
        const tenantId = found?.tenant_id ?? null;
        if (tenantId === null) throw storefrontNotFound();

        // From here on, the same tenant_isolation as the ERP's own requests
        await setTenantContext(tx, tenantId);
        const [settings] = await tx
          .select({ warehouseId: storefrontSettings.defaultWarehouseId })
          .from(storefrontSettings)
          .where(eq(storefrontSettings.tenantId, tenantId));
        // A launched shop always has its warehouse (storefront_settings_launch_check). No row at
        // all would mean the shop's launch was undone between the two queries: the same 404
        if (settings?.warehouseId == null) throw storefrontNotFound();

        return fn(tx, { tenantId, warehouseId: settings.warehouseId, now: new Date() });
      },
      // READ ONLY on top of the role's SELECT-only grants: a write here fails twice over
      { accessMode: 'read only' },
    );
  }
}
```

This is decision 15 and 26 in code, and the only way the module reaches the database.

- `subdomainOf` runs first, outside any transaction. A scan of random hosts costs no connection from the pool.
- `{ accessMode: 'read only' }` makes Postgres open the transaction `READ ONLY`. The role can only `SELECT`
  anyway; this is the second lock on the same door.
- `SET LOCAL ROLE omnivo_public` is the first statement. `LOCAL` matters: the role ends with the transaction, so
  the pooled connection goes back as `omnivo_app`. A plain `SET ROLE` would leave the next ERP request on that
  connection reading as the shop.
- `storefront_tenant_for_subdomain` is the one look across workspaces (0064). It answers one id or `NULL`. The
  result is parsed with Zod, like every raw query, so `tenant_id` is a real uuid before it goes into
  `set_config`.
- `setTenantContext` is the same call the ERP uses, so `tenant_isolation` holds exactly as it does for a member.
- The warehouse is read here, because almost every answer needs the stock. `== null` covers both "no row" and
  "no warehouse": a launched shop always has one (the launch check in 0063), and if the launch was somehow undone
  between the two queries, the shopper gets the same 404 as for any other address.
- `now` is taken once per request. A sale that ends during the request is then either on in every card of the
  answer or in none, and the SQL and the TypeScript work out the price at the same moment.

`storefrontNotFound()` is one answer for every reason a shop is not there. Separate answers ("not launched yet")
would tell a stranger which workspaces are about to open a shop.

### Photo addresses: `apps/api/src/storefront/media.ts`

```ts
import type { ShopImage, StorefrontImage } from '@omnivo/contracts';

// Step 26f: a photo's address. Step 26g's image job writes each uploaded photo as WebP files in
// the storage's public storefront/ folder, one per size, under the photo's id
// (storefront/<id>/<size>.webp). A new photo gets a new id, so a file's content never changes: a
// browser or a CDN may keep it for a year (decision 5).
//
// The sizes, by where they are drawn (CLAUDE.md → Storefront components), about twice the drawn
// width for sharp screens:
// - small: 480px wide. A card's photo (223px), the gallery's thumbnails, a cart line, the logo
// - large: 1200px. The product page's photo (524px) and the phone's banners (up to 393px, 2x–3x)
// - wide: 2560px. The desktop banners (1280px)
// Step 26g's job makes exactly these; a size added here needs it there too.
export const STOREFRONT_IMAGE_SIZES = { small: 480, large: 1200, wide: 2560 } as const;

export type StorefrontImageSize = keyof typeof STOREFRONT_IMAGE_SIZES;

// mediaUrl is the config's storefront.mediaUrl, with no "/" at its end. The id is a uuid
// (storefrontImageSchema), so it needs no escaping in a path
export function shopImage(
  mediaUrl: string,
  image: StorefrontImage,
  size: StorefrontImageSize,
): ShopImage {
  return { url: `${mediaUrl}/storefront/${image.id}/${size}.webp`, alt: image.alt };
}
```

The three sizes are named by where they are drawn, at about twice the drawn width for sharp screens. The address
has the image id and the size, nothing else (decision 19): no tenant id, because the id alone is unique and a
public address need not name the workspace. 26g's image job writes exactly these files; the comment says so,
because a size added here without the job would be a broken picture.

```ts
import { shopImageSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { shopImage } from './media.js';

const PHOTO = { id: '0b6f8f6e-6a3c-4a49-9d4e-2f1c7b9a5e10', alt: 'Neem face wash, 150ml tube' };

describe('shopImage', () => {
  it('points at the size under the photo id in the public folder', () => {
    expect(shopImage('https://files.omnivosoft.com/omnivo', PHOTO, 'small')).toEqual({
      url: 'https://files.omnivosoft.com/omnivo/storefront/0b6f8f6e-6a3c-4a49-9d4e-2f1c7b9a5e10/small.webp',
      alt: 'Neem face wash, 150ml tube',
    });
  });

  it('makes addresses the contract takes, in dev and in production', () => {
    for (const base of ['http://localhost:9000/omnivo', 'https://media.omnivo.shop']) {
      expect(shopImageSchema.safeParse(shopImage(base, PHOTO, 'wide')).success).toBe(true);
    }
  });
});
```

The second test is the one that matters: the addresses made from dev's and production's bases both pass the
contract, so `ContractInterceptor` never turns a page into a 500 because of a photo.

### The categories: `apps/api/src/storefront/categories.ts`

```ts
import type { ShopCategory } from '@omnivo/contracts';

// Step 26f: the two things the listing search needs from the shop's category tree. A shop has tens
// of categories, not thousands, so the API reads them all once per request and works these out
// here, the same way the shop's mock does (apps/shop/src/data/mock/browse.ts). The database then
// gets plain id lists, and no recursive query.

// The ids of the category with this slug and of every category under it, at any depth: /c/cosmetics
// shows the face washes of "Skin care" too. An unknown slug gives an empty list, so no cards. A loop
// in the data (A under B under A) cannot hang it: an id already in the set is never added again
export function subtreeIds(slug: string, categories: readonly ShopCategory[]): string[] {
  const top = categories.find((category) => category.slug === slug);
  if (top === undefined) return [];
  const ids = new Set([top.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId !== null && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return [...ids];
}

// One form for the search's words and the names they are looked for in. NFC: a Bangla letter like
// য় can be typed as one code point or two (য + ়), and both must match. Lower case for English,
// with fixed rules ('en'), so a server set to Turkish would not turn "I" into "ı". Bangla has no
// case. The SQL side compares with lower(name); the shop writes names in NFC (step 26g)
export function fold(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en');
}

// A search's words: every one must be found, in any field and in any order. Empty: no search
export function searchWords(q: string | null): string[] {
  return q === null
    ? []
    : fold(q)
        .split(/\s+/u)
        .filter((word) => word !== '');
}

// The categories a word finds: those whose name, or the name of a category above them, has the
// word in it. A search for "beverages" then finds the teas under "Beverages > Tea". `seen` stops a
// loop in the data
export function categoriesMatching(word: string, categories: readonly ShopCategory[]): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return categories
    .filter((category) => {
      const seen = new Set<string>();
      let current: ShopCategory | undefined = category;
      while (current !== undefined && !seen.has(current.id)) {
        if (fold(current.name).includes(word)) return true;
        seen.add(current.id);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      return false;
    })
    .map((category) => category.id);
}
```

A shop has tens of categories. The API reads them all (one small query), works out the id lists here, and hands
the database plain `IN (…)` lists, with no recursive query. These are the mock's rules (`browse.ts`), so a
category page shows the same cards from either source.

- `subtreeIds` adds children until a round adds none. A loop in the data cannot hang it, because an id already in
  the set is never added again.
- `fold` is NFC plus lower case with fixed English rules. NFC because a Bangla letter like য় has two spellings in
  Unicode; `'en'` because the server's own locale must not change what matches.
- `categoriesMatching` walks up from each category, so "beverages" finds the teas under "Beverages > Tea".

```ts
import type { ShopCategory } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { categoriesMatching, searchWords, subtreeIds } from './categories.js';

function category(id: string, name: string, parentId: string | null = null): ShopCategory {
  return { id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, parentId };
}

const TREE = [
  category('c1', 'Cosmetics'),
  category('c2', 'Skin care', 'c1'),
  category('c3', 'Face wash', 'c2'),
  category('c4', 'Beverages'),
  category('c5', 'Tea', 'c4'),
  category('c6', 'চা পাতা', 'c4'),
];

describe('subtreeIds', () => {
  it('takes the category and everything under it', () => {
    expect(subtreeIds('cosmetics', TREE).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(subtreeIds('tea', TREE)).toEqual(['c5']);
  });

  it('gives no ids for an unknown slug, and stops on a loop in the data', () => {
    expect(subtreeIds('toys', TREE)).toEqual([]);
    const loop = [category('a', 'A', 'b'), category('b', 'B', 'a')];
    expect(subtreeIds('a', loop).sort()).toEqual(['a', 'b']);
  });
});

describe('search words', () => {
  it('splits, folds and drops empty words', () => {
    expect(searchWords('  Neem   FACE ')).toEqual(['neem', 'face']);
    expect(searchWords(null)).toEqual([]);
  });

  it('finds the categories under a matching name, in English and in Bangla', () => {
    expect(categoriesMatching('beverages', TREE).sort()).toEqual(['c4', 'c5', 'c6']);
    expect(categoriesMatching('চা', TREE)).toEqual(['c6']);
    expect(categoriesMatching('toys', TREE)).toEqual([]);
  });

  it('matches a Bangla word typed in its other form', () => {
    // য় as one code point (U+09DF) in the name, as য + ় (U+09AF U+09BC) in the search
    const tree = [category('d1', 'মিষ্টি দইয়')];
    const [word] = searchWords('দইয়');
    expect(word).toBeDefined();
    expect(categoriesMatching(word ?? '', tree)).toEqual(['d1']);
  });
});
```

The last test types য় one way in the name and the other way in the search, and still finds it.

### The listings: `apps/api/src/storefront/listing-sql.ts`

This file is the heart of the module: one SQL subquery that says which listings the shop shows and at what price,
and the code around it. Every read uses it (cards, the product page, collections, the quote), so a rule like "an
archived product leaves the shop" cannot hold on the cards and not in the cart.

```ts
import {
  isMoneyAmount,
  listingPricing,
  SHOP_BADGES,
  SHOP_PAGE_SIZE,
  SHOP_SORTS,
  STOREFRONT_SALE_KINDS,
  storefrontImagesSchema,
  storefrontSectionsSchema,
  type ShopCategory,
  type ShopImage,
  type ShopListing,
  type ShopListingPage,
  type ShopListingQuery,
  type ShopSort,
  type StorefrontSale,
} from '@omnivo/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { containsPattern } from '../common/db/search.js';
import { AppError } from '../common/http/app-error.js';
import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { categoriesMatching, searchWords, subtreeIds } from './categories.js';
import { shopImage } from './media.js';
import type { ShopScope } from './shop-db.js';

// Step 26f: the listings the shop shows, as one SQL subquery every public read starts from (the
// cards, the product page, the collections, the quote). One place, so a rule like "an archived
// product leaves the shop" can never hold on the cards and not in the cart.
//
// A listing is shown when it is published (also omnivo_public's policy), its product and variant
// are not archived, and it has a price (its own, or the variant's sale price; a variant may have
// none, decision 2). Its price now comes from the same rules as listingPricing() in the contracts:
// the SQL needs it to filter and sort by the price the shopper pays, and the TypeScript to build
// the card. The integration test (26f.4) checks that the two agree for every kind of sale.
function shownListings(shop: ShopScope): SQL {
  const now = sql`${shop.now.toISOString()}::timestamptz`;
  return sql`
    SELECT l.id, l.slug, l.name, l.pack_size, l.category_id, l.badges, l.images, l.published_at,
           l.description_sections, l.seo_title, l.seo_description,
           l.sale_kind, l.sale_value, l.sale_starts_at, l.sale_ends_at,
           v.sku, u.name AS unit_name, r.regular, s.on_sale,
           CASE WHEN s.on_sale THEN r.regular - o.off ELSE r.regular END AS price,
           -- Decision 3: in stock = more than nothing in the shop's warehouse. Summed over the
           -- batches, so a batch below zero (step 20a's sold-short) takes from the others
           (SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
             WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
               AND b.warehouse_id = ${shop.warehouseId}::uuid) > 0 AS in_stock
      FROM storefront_listings l
      JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
      JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
      JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.base_unit_id
      CROSS JOIN LATERAL (SELECT coalesce(l.price_override, v.sale_price) AS regular) r
      -- What the sale takes off, and whether it runs now. round(…, 2) is half away from zero,
      -- which for a positive amount is percentOfMoney's half up, to the paisa. The end is
      -- exclusive (decision 11)
      CROSS JOIN LATERAL (
        SELECT CASE l.sale_kind
                 WHEN 'percent' THEN round(r.regular * l.sale_value / 100, 2)
                 WHEN 'amount' THEN l.sale_value
                 WHEN 'price' THEN r.regular - l.sale_value
               END AS off,
               l.sale_kind IS NOT NULL
                 AND (l.sale_starts_at IS NULL OR l.sale_starts_at <= ${now})
                 AND (l.sale_ends_at IS NULL OR ${now} < l.sale_ends_at) AS running
      ) o
      -- Decision 9: a sale that takes nothing off, or everything, is no sale
      CROSS JOIN LATERAL (
        SELECT coalesce(o.running AND o.off > 0 AND r.regular - o.off > 0, false) AS on_sale
      ) s
     WHERE l.tenant_id = ${shop.tenantId}::uuid
       AND l.published_at IS NOT NULL
       AND v.archived_at IS NULL AND p.archived_at IS NULL
       AND r.regular IS NOT NULL`;
}
```

`shownListings` reads as `omnivo_public`, so it may only name the columns 0064 granted; a `v.*` would be
"permission denied". The rules, line by line:

- **Shown** = published, product and variant not archived, and a price. A variant's sale price may be empty
  (decision 2); a listing without its own price is then not for sale. `l.tenant_id = …` repeats what RLS already
  does, so the planner can use the indexes that start with `tenant_id`.
- **In stock** is a subquery that sums the batches in the shop's warehouse. A sum, not "any row above zero": after
  a sale below zero (step 20a) one batch can be negative and another positive, and the shelf holds the sum.
- **The price** is three `LATERAL` steps, so each part is written once: the regular price, then what the sale takes
  off and whether it runs now, then whether it is a sale the shop can show (decision 9: something off, and not
  everything). `round(…, 2)` rounds half away from zero; on a positive amount that is half up, which is what
  `percentOfMoney` does, to the paisa. The end time is exclusive (decision 11), so at 18:00 a sale that ends at
  18:00 is over, in SQL and in `listingPricing` alike. `coalesce(…, false)`: a listing with no sale has `NULL` in
  `running`, and `on_sale` must be a real boolean for the `offer` filter.

```ts

// Raw queries leave timestamps as Postgres's own text, which is not ISO (products.service.ts has
// the same helper). Microseconds, not milliseconds: published_at is a cursor key, and a key cut to
// the millisecond would skip a listing published in the same millisecond as the last card
function isoText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// The columns every read selects from the subquery, as text where Postgres would send its own types
const LISTING_COLUMNS = sql`
  shown.id::text, shown.slug, shown.name, shown.pack_size, shown.category_id::text, shown.badges,
  shown.images, shown.sku, shown.unit_name, shown.description_sections, shown.seo_title,
  shown.seo_description, shown.regular::text, shown.sale_kind, shown.sale_value::text,
  ${isoText(sql`shown.sale_starts_at`)} AS sale_starts_at,
  ${isoText(sql`shown.sale_ends_at`)} AS sale_ends_at,
  ${isoText(sql`shown.published_at`)} AS published_at, shown.price::text, shown.in_stock`;

const isoSchema = z.iso.datetime();

// The jsonb columns are checked like everything else from the database: they are the API's own
// writing (step 26g), but a row from a hand-made fix must not reach the shop half broken
const listingRowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  pack_size: z.string(),
  category_id: z.uuid(),
  badges: z.array(z.enum(SHOP_BADGES)),
  // At least one: storefront_listings_published_check
  images: storefrontImagesSchema.min(1),
  sku: z.string().nullable(),
  unit_name: z.string(),
  description_sections: storefrontSectionsSchema,
  seo_title: z.string().nullable(),
  seo_description: z.string().nullable(),
  regular: z.string(),
  sale_kind: z.enum(STOREFRONT_SALE_KINDS).nullable(),
  sale_value: z.string().nullable(),
  sale_starts_at: isoSchema.nullable(),
  sale_ends_at: isoSchema.nullable(),
  published_at: isoSchema,
  price: z.string(),
  in_stock: z.boolean(),
});

export type ListingRow = z.infer<typeof listingRowSchema>;

// Run a query on the subquery: `shown` is its name, so `rest` (the WHERE, ORDER BY, LIMIT) reads
// like a query on a table
export async function selectListings(
  tx: Transaction,
  shop: ShopScope,
  rest: SQL,
): Promise<ListingRow[]> {
  return z.array(listingRowSchema).parse(await tx.execute(listingsSql(shop, sql``, rest)));
}

// `extra` adds columns to the select list (the page's sort key)
function listingsSql(shop: ShopScope, extra: SQL, rest: SQL): SQL {
  return sql`SELECT ${LISTING_COLUMNS}${extra} FROM (${shownListings(shop)}) shown ${rest}`;
}

function saleOf(row: ListingRow): StorefrontSale | null {
  if (row.sale_kind === null || row.sale_value === null) return null;
  // A percent comes as "10.0000" (numeric(19,4)); listingPricing reads it as a number
  return {
    kind: row.sale_kind,
    value: row.sale_value,
    startsAt: row.sale_starts_at,
    endsAt: row.sale_ends_at,
  };
}

// A card. Only its first photo, small: the card draws one (ProductCard.astro), and a page of 20
// cards stays light. The product page asks for its photos itself (productOf)
export function listingOf(row: ListingRow, shop: ShopScope, mediaUrl: string): ShopListing {
  const [first] = row.images;
  return listingWith(row, shop, first === undefined ? [] : [shopImage(mediaUrl, first, 'small')]);
}

export function listingWith(row: ListingRow, shop: ShopScope, images: ShopImage[]): ShopListing {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    packSize: row.pack_size,
    images,
    ...listingPricing(row.regular, saleOf(row), shop.now),
    badges: row.badges,
    inStock: row.in_stock,
    categoryId: row.category_id,
  };
}
```

- `isoText` writes timestamps as ISO in Postgres, because a raw query leaves them in Postgres's own format. With
  microseconds: `published_at` is a cursor key, and a key cut to the millisecond would skip a listing published
  in the same millisecond as the last card of a page.
- `listingRowSchema` checks every row, the jsonb columns too. They are the API's own writing (26g), but a row fixed
  by hand must fail loudly here, not reach a shopper half broken. `images` has `.min(1)`, the database's published
  check, so `listingOf` always has a first photo.
- `listingWith` spreads `listingPricing()` into the card: the price, the struck-out price, the ribbon and the end
  of the sale come from the contracts' one function, the same one 26g's form will use for its preview.
- `listingOf` gives a card only its first photo, small: `ProductCard.astro` draws one, and a page of 20 cards stays
  light.

```ts

// ---------------------------------------------------------------------------------------------
// The category and search pages

// Each sort: the key it orders by and which way. A Record, so a sort added to SHOP_SORTS without
// a line here fails the type check. Ties go by id, so the order is total and a cursor is exact.
// "name" orders by the first 60 characters: the key goes into the cursor, and a cursor is at most
// 512 characters (publicListingParamsSchema); 60 Bangla letters are 180 bytes, safely under it.
// Two names with the same first 60 characters go by id, which is still one fixed order
const ORDERS: Record<ShopSort, { key: SQL; desc: boolean; cast: SQL }> = {
  newest: { key: sql`shown.published_at`, desc: true, cast: sql`timestamptz` },
  price_asc: { key: sql`shown.price`, desc: false, cast: sql`numeric` },
  price_desc: { key: sql`shown.price`, desc: true, cast: sql`numeric` },
  name: { key: sql`left(lower(shown.name), 60)`, desc: false, cast: sql`text` },
};

// The sort's key as text, for the next cursor, written by Postgres itself: the same lower() and
// left() as the ORDER BY, so the key is exactly what the next page compares with. JavaScript's
// toLowerCase() and slice() differ from them on some letters (and slice counts UTF-16 units)
function sortKeyText(sort: ShopSort): SQL {
  return sort === 'newest' ? isoText(ORDERS.newest.key) : sql`${ORDERS[sort].key}::text`;
}

// A cursor is [sort, key, id]. The sort is in it, so a cursor from "Price: low to high" sent with
// "Newest" is refused instead of landing in the middle of another order
const cursorSchema = z.tuple([z.enum(SHOP_SORTS), z.string().max(300), z.uuid()]);

const pageRowSchema = z.object({ sort_key: z.string() });

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

function readCursor(cursor: string | null, sort: ShopSort): [string, string] | null {
  const decoded = decodeCursor(cursor ?? undefined, cursorSchema);
  if (decoded === undefined) return null;
  const [cursorSort, key, id] = decoded;
  if (cursorSort !== sort) throw invalidCursor();
  // The key goes into SQL with a cast: a bad one would be Postgres's cast error, a 500
  const valid =
    sort === 'newest' ? isoSchema.safeParse(key).success : sort === 'name' || isMoneyAmount(key);
  if (!valid) throw invalidCursor();
  return [key, id];
}

// `id IN (…)`, or false for an empty list (Postgres has no empty IN ()). Each id is cast, so a
// caller passes only uuids (the quote checks its ids first)
export function idIn(column: SQL, ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

// One page of cards: the shop's category and search pages, and the home page's grid (its first
// page). The same filters as the shop's mock (browse.ts), so its pages need no change:
// - a category and every category under it; an unknown slug finds nothing
// - every search word in the name, the SKU or the category trail
// - the price the shopper pays, in stock, on sale
export async function listingPage(
  tx: Transaction,
  shop: ShopScope,
  query: ShopListingQuery,
  categories: readonly ShopCategory[],
  mediaUrl: string,
): Promise<ShopListingPage> {
  const order = ORDERS[query.sort];
  const after = readCursor(query.cursor, query.sort);
  const conditions: SQL[] = [sql`true`];

  if (query.category !== null) {
    conditions.push(idIn(sql`shown.category_id`, subtreeIds(query.category, categories)));
  }
  for (const word of searchWords(query.q)) {
    const pattern = containsPattern(word);
    // lower(name) LIKE: the trigram index of 0064. A SKU is looked for anywhere in it, like the
    // ERP's product search
    conditions.push(sql`(lower(shown.name) LIKE ${pattern}
      OR lower(coalesce(shown.sku, '')) LIKE ${pattern}
      OR ${idIn(sql`shown.category_id`, categoriesMatching(word, categories))})`);
  }
  if (query.minPrice !== null) conditions.push(sql`shown.price >= ${query.minPrice}::numeric`);
  if (query.maxPrice !== null) conditions.push(sql`shown.price <= ${query.maxPrice}::numeric`);
  if (query.inStock) conditions.push(sql`shown.in_stock`);
  // On sale: a ribbon or a struck-out price, which listingPricing gives exactly when on_sale
  if (query.offer) conditions.push(sql`shown.on_sale`);
  if (after !== null) {
    const [key, id] = after;
    conditions.push(
      sql`(${order.key}, shown.id) ${order.desc ? sql`<` : sql`>`} (${key}::${order.cast}, ${id}::uuid)`,
    );
  }

  const direction = order.desc ? sql`DESC` : sql`ASC`;
  // One more than a page: if it comes, there is a next page (toPage in pagination/cursor.ts)
  const rows = z.array(listingRowSchema.extend(pageRowSchema.shape)).parse(
    await tx.execute(
      listingsSql(
        shop,
        sql`, ${sortKeyText(query.sort)} AS sort_key`,
        sql`WHERE ${sql.join(conditions, sql` AND `)}
            ORDER BY ${order.key} ${direction}, shown.id ${direction}
            LIMIT ${SHOP_PAGE_SIZE + 1}`,
      ),
    ),
  );
  const items = rows.slice(0, SHOP_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items: items.map((row) => listingOf(row, shop, mediaUrl)),
    nextCursor:
      rows.length > SHOP_PAGE_SIZE && last !== undefined
        ? encodeCursor([query.sort, last.sort_key, last.id])
        : null,
  };
}
```

- `ORDERS` is a `Record` over `SHOP_SORTS`, so a sort added to the contract without a line here fails the type
  check. Each order ends with the id, so it is total and a cursor is exact.
- `"name"` orders by `left(lower(name), 60)` (decision 30). Two names with the same first 60 characters fall back
  to the id, which is still one fixed order, so no card is skipped or shown twice.
- `sortKeyText` lets Postgres write the cursor's key. JavaScript's `toLowerCase()` differs from Postgres's `lower()`
  on a few letters, and `slice()` counts UTF-16 units, not characters; a key made in JavaScript could then be a
  little off, and the next page would start in the wrong place.
- The cursor is `[sort, key, id]`. With the sort in it, a cursor from "Price: low to high" sent with "Newest" is a
  400 instead of a page from the middle of another order. `readCursor` also checks the key's form before it goes
  into SQL with a cast: a broken key would otherwise be Postgres's cast error, a 500.
- `idIn` turns an empty list into `false`, because `IN ()` is a syntax error in Postgres. An unknown category slug
  is therefore an empty page (decision 31), not an error.
- Each search word must match the name, the SKU or a category on the way down. `lower(shown.name) LIKE` is what the
  trigram index of 0064 serves. `containsPattern` escapes `%` and `_`, so "10%" means ten percent.
- The price filter compares the price the shopper pays (decision 29). `offer` is `on_sale`, which is exactly when
  `listingPricing` gives a ribbon and a struck-out price.
- One row more than a page is fetched; if it comes, there is a next page, without a `COUNT(*)`.

### The cart's prices: `apps/api/src/storefront/quote.ts`

```ts
import {
  compareMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopCouponResult,
  type ShopImage,
  type ShopListing,
} from '@omnivo/contracts';

// A listing as the quote needs it: the card (price, stock) and the photo a cart line draws. The
// line's photo is the small size (media.ts), the same as the card's, so it is the card's own
export interface QuotedListing {
  listing: ShopListing;
  image: ShopImage;
}

// Step 26f: the cart's prices, the same rules as the shop's mock (apps/shop/src/data/mock/quote.ts,
// step 26c), so the drawer and the checkout do not change when the shop moves to this API. Each
// line at the listing's price now, summed with the money helpers (never JavaScript numbers). Only
// coupons differ: the ERP has none until step 27, so a code is always refused as unknown.
//
// `listings` has only what the shop shows now: a listing that is unpublished, deleted, archived in
// the ERP or without a price is not in it, and its line is 'unavailable'.
export function quoteCart(
  request: ShopCartQuoteRequest,
  listings: ReadonlyMap<string, QuotedListing>,
  settings: ShopCheckoutSettings,
): ShopCartQuote {
  const lines = request.lines.map((line): ShopCartQuoteLine => {
    const found = listings.get(line.listingId);
    if (found === undefined) return { status: 'unavailable', listingId: line.listingId };
    const { listing, image } = found;
    const shown = {
      listingId: listing.id,
      slug: listing.slug,
      name: listing.name,
      packSize: listing.packSize,
      image,
      quantity: line.quantity,
    };
    // Decision 3: the shop knows only "in stock" (one or more in the shop's warehouse). Whether
    // there are as many as the cart asks for is step 27's question, when an order holds the stock
    if (!listing.inStock) return { ...shown, status: 'out_of_stock' };
    return {
      ...shown,
      status: 'available',
      unitPrice: listing.price,
      lineTotal: multiplyMoney(String(line.quantity), listing.price),
    };
  });

  const sold = lines.filter((line) => line.status === 'available');
  const subtotal = sumMoney(sold.map((line) => line.lineTotal));

  // No coupon takes anything off yet (see above). The promo box then says "This code does not
  // exist", which is true of every code in a shop with no coupons
  const coupon: ShopCouponResult =
    request.couponCode === undefined
      ? { status: 'none' }
      : {
          status: 'refused',
          code: request.couponCode,
          reason: 'shop_coupon_unknown',
          minimum: null,
        };
  const discount = '0.0000';

  // Both rules look at the subtotal, the items before the coupon (step 26c's decision 8)
  const freeDelivery =
    settings.freeDeliveryFrom !== null && compareMoney(subtotal, settings.freeDeliveryFrom) >= 0;
  const belowMinimum =
    settings.minimumOrder !== null && compareMoney(subtotal, settings.minimumOrder) < 0;

  // A zone the shop no longer has is no zone: the checkout says "Pick a location"
  const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
  const deliveryCharge = zone ? (freeDelivery ? '0.0000' : sumMoney([zone.charge])) : null;

  return {
    lines,
    itemCount: sold.reduce((count, line) => count + line.quantity, 0),
    subtotal,
    discount,
    coupon,
    deliveryCharge,
    freeDelivery,
    total: sumMoney([subtractMoney(subtotal, discount), deliveryCharge ?? '0']),
    belowMinimum,
  };
}
```

The mock's `quoteCart` (26c), with the listings as an argument and no coupons. Kept in its own file with no
database code, so it is tested in milliseconds. The money helpers do every sum: `3 × 49.90` in JavaScript numbers
is `149.70000000000002`. Decision 27: an out-of-stock line stays on the screen and adds nothing. Decision 28: a
code is refused as unknown, which is true in a shop with no coupons, and the promo box already has words for it.

```ts
import {
  shopCartQuoteSchema,
  type ShopCartQuoteRequest,
  type ShopCheckoutSettings,
  type ShopListing,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { quoteCart, type QuotedListing } from './quote.js';

const NEEM = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a01';
const STEVIA = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a02';
const DANO = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a03';
const GONE = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a04';

function quoted(id: string, name: string, price: string, inStock = true): QuotedListing {
  const image = { url: `https://media.example.com/storefront/${id}/small.webp`, alt: name };
  const listing: ShopListing = {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    packSize: '',
    images: [image],
    price,
    compareAtPrice: null,
    saleUntil: null,
    discount: null,
    badges: [],
    inStock,
    categoryId: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a10',
  };
  return { listing, image };
}

// What the database gives: numeric(19,4), so every amount has four decimals
const LISTINGS = new Map([
  [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000')],
  [STEVIA, quoted(STEVIA, 'Zero Cal Stevia 30 Sachets', '120.0000')],
  [DANO, quoted(DANO, 'Dano Daily Pushti Milk 1kg', '780.0000', false)],
]);

const SETTINGS: ShopCheckoutSettings = {
  zones: [
    { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80.0000' },
    { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120.0000' },
  ],
  paymentMethods: ['cod'],
  freeDeliveryFrom: '1000.0000',
  minimumOrder: '300.0000',
};

function quote(request: ShopCartQuoteRequest, settings = SETTINGS) {
  const answer = quoteCart(request, LISTINGS, settings);
  // Every answer goes out through the contract, so a test answer must pass it too
  expect(() => shopCartQuoteSchema.parse(answer)).not.toThrow();
  return answer;
}

describe('quoteCart (public API)', () => {
  it('prices each line at its price now and leaves out what cannot be sold', () => {
    const answer = quote({
      lines: [
        { listingId: NEEM, quantity: 3 },
        { listingId: DANO, quantity: 2 },
        { listingId: GONE, quantity: 1 },
      ],
    });
    expect(answer.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
    ]);
    expect(answer.lines[0]).toMatchObject({ unitPrice: '229.0000', lineTotal: '687.0000' });
    expect(answer.lines[2]).toEqual({ status: 'unavailable', listingId: GONE });
    expect(answer).toMatchObject({ itemCount: 3, subtotal: '687.0000', belowMinimum: false });
  });

  it('adds the zone charge, and none from the free-delivery amount on', () => {
    expect(
      quote({ lines: [{ listingId: STEVIA, quantity: 3 }], zoneId: 'outside_dhaka' }),
    ).toMatchObject({ deliveryCharge: '120.0000', freeDelivery: false, total: '480.0000' });
    // 5 × ৳229 = ৳1,145: over ৳1,000
    expect(
      quote({ lines: [{ listingId: NEEM, quantity: 5 }], zoneId: 'inside_dhaka' }),
    ).toMatchObject({ deliveryCharge: '0.0000', freeDelivery: true, total: '1145.0000' });
  });

  it('treats a zone the shop does not have as no zone', () => {
    expect(
      quote({ lines: [{ listingId: NEEM, quantity: 2 }], zoneId: 'chattogram' }),
    ).toMatchObject({ deliveryCharge: null, total: '458.0000' });
  });

  it('says when the items are under the minimum order', () => {
    expect(quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }).belowMinimum).toBe(true);
    expect(
      quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }, { ...SETTINGS, minimumOrder: null })
        .belowMinimum,
    ).toBe(false);
  });

  it('refuses every coupon as unknown, and takes nothing off', () => {
    const answer = quote({ lines: [{ listingId: NEEM, quantity: 1 }], couponCode: 'WELCOME10' });
    expect(answer.coupon).toEqual({
      status: 'refused',
      code: 'WELCOME10',
      reason: 'shop_coupon_unknown',
      minimum: null,
    });
    expect(answer).toMatchObject({ discount: '0.0000', total: '229.0000' });
  });
});
```

The amounts in the test have four decimals, as `numeric(19,4)` gives them, and every answer is parsed with the
contract, because the real route sends it through `ContractInterceptor`.

### The answers: `apps/api/src/storefront/public-storefront.service.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_SETTINGS,
  listingQueryFromParams,
  renderSections,
  sectionsSummary,
  SHOP_GALLERY_MAX,
  shopDeliveryZoneSchema,
  type PublicListingParams,
  type PublicShop,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopCategory,
  type ShopCheckoutSettings,
  type ShopCollection,
  type HeroBanner,
  type ShopHome,
  type ShopHomeBlock,
  type ShopListingPage,
  type ShopProductPage,
  type ShopTextPage,
  type ShopTextPageSlug,
  type StorefrontImage,
  storefrontImageSchema,
} from '@omnivo/contracts';
import {
  storefrontBanners,
  storefrontCategories,
  storefrontCollectionItems,
  storefrontCollections,
  storefrontHomeBlocks,
  storefrontPages,
  storefrontSettings,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../common/http/app-error.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { idIn, listingOf, listingPage, listingWith, selectListings } from './listing-sql.js';
import { shopImage, type StorefrontImageSize } from './media.js';
import { quoteCart, type QuotedListing } from './quote.js';
import { ShopDb, type ShopScope, storefrontNotFound } from './shop-db.js';

type BannerRow = typeof storefrontBanners.$inferSelect;

// A collection row on the home page shows at most this many cards. The row scrolls a page at a
// time; more than this is a category page, and the tenant links to one with a banner
const COLLECTION_MAX = 24;
// "Related Products" (shopProductPageSchema.related.max(12))
const RELATED_MAX = 12;
// The cart's ids are uuids. Anything else is a listing that cannot exist, and must not reach a
// ::uuid cast (a 500)
const uuidSchema = z.uuid();

// Step 26f: the eight answers of /public/v1. Every one runs inside ShopDb.read, as omnivo_public in
// the shop's workspace, and answers in the contract's shapes (storefront.ts), so the shop's pages
// are the same whether their data comes from the mock or from here.
@Injectable()
export class PublicStorefrontService {
  private readonly mediaUrl: string;

  constructor(
    private readonly shopDb: ShopDb,
    @Inject(CONFIG) config: Config,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }
```

The limits are named constants with their reason: 24 cards in a row (more is a category page), 12 related
products (the contract's maximum). `uuidSchema` is for the quote: a cart in a browser can hold anything, and an id
that is not a uuid must become "unavailable", never a `::uuid` cast error.

```ts
  shop(host: string | undefined): Promise<PublicShop> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [settings] = await tx
        .select()
        .from(storefrontSettings)
        .where(eq(storefrontSettings.tenantId, shop.tenantId));
      if (settings === undefined) throw storefrontNotFound();
      const [workspace] = await tx
        .select({ timezone: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, shop.tenantId));
      return {
        name: settings.name,
        // The logo's alt text is the shop's name: it is what the logo says
        logo:
          settings.logoImageId === null
            ? null
            : shopImage(this.mediaUrl, { id: settings.logoImageId, alt: settings.name }, 'small'),
        language: settings.language,
        theme: { brand: settings.brandColor, accent: settings.accentColor },
        hotline: settings.hotline,
        // A workspace has its settings row from its first day; the default is only for TypeScript
        timeZone: workspace?.timezone ?? DEFAULT_SETTINGS.timezone,
        address: settings.address,
        social: {
          facebook: settings.facebookUrl,
          instagram: settings.instagramUrl,
          x: settings.xUrl,
          linkedin: settings.linkedinUrl,
        },
      };
    });
  }

  categories(host: string | undefined): Promise<ShopCategory[]> {
    return this.shopDb.read(host, (tx, shop) => categoriesOf(tx, shop));
  }

  listings(host: string | undefined, params: PublicListingParams): Promise<ShopListingPage> {
    return this.shopDb.read(host, async (tx, shop) =>
      listingPage(
        tx,
        shop,
        listingQueryFromParams(params),
        await categoriesOf(tx, shop),
        this.mediaUrl,
      ),
    );
  }
```

- `shop`: the logo's alt text is the shop's name, because that is what the logo says. `timeZone` falls back to the
  default only for TypeScript: every workspace has its settings row from its first day.
- `listings` turns the querystring into the clean query with the contract's `listingQueryFromParams`, the same
  function the shop's source will use in reverse (26f.5).

```ts
  home(host: string | undefined): Promise<ShopHome> {
    return this.shopDb.read(host, async (tx, shop) => {
      const banners = await tx
        .select()
        .from(storefrontBanners)
        .where(eq(storefrontBanners.tenantId, shop.tenantId));
      const hero = banners.find((banner) => banner.kind === 'hero');

      // Decision 18: the grid is the first page of /c/all, so "Load More" under it continues
      // exactly where it stops
      const featured = await listingPage(
        tx,
        shop,
        listingQueryFromParams({}),
        await categoriesOf(tx, shop),
        this.mediaUrl,
      );

      return {
        // The 26f.3 decision: no hero is a home page without one, never an error
        hero: hero === undefined ? null : this.heroOf(hero),
        featured: featured.items,
        hasMoreFeatured: featured.nextCursor !== null,
        blocks: await this.blocks(tx, shop, banners),
      };
    });
  }

  product(host: string | undefined, slug: string): Promise<ShopProductPage> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [row] = await selectListings(tx, shop, sql`WHERE shown.slug = ${slug}`);
      if (row === undefined) throw notFound('Product');
      const related = await selectListings(
        tx,
        shop,
        sql`WHERE shown.category_id = ${row.category_id}::uuid AND shown.id <> ${row.id}::uuid
            ORDER BY shown.published_at DESC, shown.id DESC
            LIMIT ${RELATED_MAX}`,
      );
      return {
        product: {
          // The gallery's photos, large; the database keeps at most four (SHOP_GALLERY_MAX)
          ...listingWith(
            row,
            shop,
            row.images.slice(0, SHOP_GALLERY_MAX).map((image) => this.image(image, 'large')),
          ),
          sku: row.sku === null || row.sku === '' ? null : row.sku,
          unitName: row.unit_name,
          descriptionHtml: renderSections(row.description_sections),
          // Decision 14: the API decides, so the shop never does. The name is cut to the
          // contract's 120 characters; the tenant's own SEO title is already that short (0063)
          seo: {
            title: row.seo_title ?? row.name.slice(0, 120),
            description: row.seo_description ?? sectionsSummary(row.description_sections),
          },
        },
        related: related.map((listing) => listingOf(listing, shop, this.mediaUrl)),
      };
    });
  }

  quote(host: string | undefined, request: ShopCartQuoteRequest): Promise<ShopCartQuote> {
    return this.shopDb.read(host, async (tx, shop) => {
      const ids = request.lines
        .map((line) => line.listingId)
        .filter((id) => uuidSchema.safeParse(id).success);
      const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
      const listings = new Map<string, QuotedListing>();
      for (const row of rows) {
        const listing = listingOf(row, shop, this.mediaUrl);
        // The card's photo (the first, small) is the cart line's photo too. It is always there
        // (listingRowSchema: at least one); TypeScript only cannot know it
        const [image] = listing.images;
        if (image !== undefined) listings.set(row.id, { listing, image });
      }
      return quoteCart(request, listings, await checkoutSettingsOf(tx, shop));
    });
  }

  checkoutSettings(host: string | undefined): Promise<ShopCheckoutSettings> {
    return this.shopDb.read(host, (tx, shop) => checkoutSettingsOf(tx, shop));
  }

  textPage(host: string | undefined, slug: ShopTextPageSlug): Promise<ShopTextPage> {
    return this.shopDb.read(host, async (tx, shop) => {
      const [page] = await tx
        .select({ sections: storefrontPages.sections, updatedAt: storefrontPages.updatedAt })
        .from(storefrontPages)
        .where(and(eq(storefrontPages.tenantId, shop.tenantId), eq(storefrontPages.slug, slug)));
      // A page the tenant has not written is not there (the shop's "page not found")
      if (page === undefined) throw notFound('Page');
      return {
        slug,
        html: renderSections(page.sections),
        updatedAt: page.updatedAt.toISOString(),
      };
    });
  }
```

- `home`: the grid is the first page of `/c/all` (decision 18), so "Load More" under it continues exactly where it
  stops. `hero` is `null` when there is none (decision 23).
- `product`: the photos are large and at most four. `sku` of `''` is `null`: the ERP keeps an empty SKU as an empty
  string, and the page then leaves out the "SKU:" line. `seo` is decided here (decision 14); the name is cut to the
  contract's 120 characters, because a long name would otherwise fail the contract and take the page down.
- `quote` reads only the cart's listings, through the same subquery, so a listing that left the shop is
  "unavailable" for the same reasons it left the cards.
- `textPage`: a page the tenant has not written is a 404, which the shop shows as "page not found".

```ts
  // The banners and collections under the grid, in the tenant's order (shopHomeSchema.blocks)
  private async blocks(
    tx: Transaction,
    shop: ShopScope,
    banners: BannerRow[],
  ): Promise<ShopHomeBlock[]> {
    const blocks = await tx
      .select()
      .from(storefrontHomeBlocks)
      .where(eq(storefrontHomeBlocks.tenantId, shop.tenantId))
      .orderBy(asc(storefrontHomeBlocks.position));
    const collections = await this.collections(tx, shop);
    const bannerById = new Map(banners.map((banner) => [banner.id, banner]));

    return blocks.flatMap((block): ShopHomeBlock[] => {
      if (block.bannerId !== null) {
        const banner = bannerById.get(block.bannerId);
        // Decision 21: the hero has its own place at the top. A hero put in the blocks as well
        // (the database cannot refuse it) is left out here, so it never shows twice
        if (banner?.kind !== 'image') return [];
        return [
          {
            id: banner.id,
            kind: 'image',
            href: banner.href,
            desktopImage: this.image(banner.desktopImage, 'wide'),
            phoneImage: this.image(banner.phoneImage, 'large'),
          },
        ];
      }
      const collection =
        block.collectionId === null ? undefined : collections.get(block.collectionId);
      // A row whose listings are all hidden now (unpublished, archived, no price) is left out:
      // a collection has at least one card (shopCollectionSchema)
      return collection === undefined ? [] : [{ kind: 'collection', collection }];
    });
  }

  // Every collection with the cards it shows now, in its order. A listing the shop does not show
  // is simply not in `shown`, so the join leaves it out of its row (0064's comment)
  private async collections(
    tx: Transaction,
    shop: ShopScope,
  ): Promise<Map<string, ShopCollection>> {
    const heads = await tx
      .select()
      .from(storefrontCollections)
      .where(eq(storefrontCollections.tenantId, shop.tenantId));
    const items = await tx
      .select({
        collectionId: storefrontCollectionItems.collectionId,
        listingId: storefrontCollectionItems.listingId,
      })
      .from(storefrontCollectionItems)
      .where(eq(storefrontCollectionItems.tenantId, shop.tenantId))
      .orderBy(
        asc(storefrontCollectionItems.collectionId),
        asc(storefrontCollectionItems.position),
      );
    const ids = [...new Set(items.map((item) => item.listingId))];
    const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
    const cards = new Map(rows.map((row) => [row.id, listingOf(row, shop, this.mediaUrl)]));

    const result = new Map<string, ShopCollection>();
    for (const head of heads) {
      const listings = items
        .filter((item) => item.collectionId === head.id)
        .flatMap((item) => {
          const card = cards.get(item.listingId);
          return card === undefined ? [] : [card];
        })
        .slice(0, COLLECTION_MAX);
      if (listings.length > 0) {
        result.set(head.id, { id: head.id, title: head.title, icon: head.icon, listings });
      }
    }
    return result;
  }

  // The hero's words and colours are there whenever kind is 'hero' (storefront_banners_hero_check);
  // the checks below are what lets TypeScript know it. A row that breaks it shows no hero
  private heroOf(banner: BannerRow): HeroBanner | null {
    const { headline, buttonLabel, backgroundColor, panelColor, buttonColor, buttonTextColor } =
      banner;
    if (
      headline === null ||
      buttonLabel === null ||
      backgroundColor === null ||
      panelColor === null ||
      buttonColor === null ||
      buttonTextColor === null
    ) {
      return null;
    }
    return {
      id: banner.id,
      kind: 'hero',
      href: banner.href,
      headline,
      line: banner.line,
      eyebrow: banner.eyebrow,
      buttonLabel,
      desktopImage: this.image(banner.desktopImage, 'wide'),
      phoneImage: this.image(banner.phoneImage, 'large'),
      colors: {
        background: backgroundColor,
        panel: panelColor,
        button: buttonColor,
        buttonText: buttonTextColor,
      },
    };
  }

  // A listing's photos come checked from listing-sql.ts. A banner's pictures are jsonb objects
  // that the database checks only to be objects (storefront_banners_images_check), so their
  // shape is checked here
  private image(value: StorefrontImage, size: StorefrontImageSize) {
    return shopImage(this.mediaUrl, storefrontImageSchema.parse(value), size);
  }
}
```

- `blocks` leaves out a hero placed in the blocks (decision 21) and a collection with no card left.
- `collections` reads the items in their order, then the listings through `shownListings`, so a hidden listing is
  simply not in the map and drops out of its row.
- `heroOf` checks the hero's words and colours one by one. The database's check guarantees them for a hero, but
  TypeScript sees nullable columns; the checks narrow them without a cast. A row that broke the rule would show no
  hero instead of a 500.
- `image` parses a banner's pictures: the database checks only that they are objects.

```ts

// Every category of the shop, in the tenant's order: siblings by position, then by name
async function categoriesOf(tx: Transaction, shop: ShopScope): Promise<ShopCategory[]> {
  return tx
    .select({
      id: storefrontCategories.id,
      slug: storefrontCategories.slug,
      name: storefrontCategories.name,
      parentId: storefrontCategories.parentId,
    })
    .from(storefrontCategories)
    .where(eq(storefrontCategories.tenantId, shop.tenantId))
    .orderBy(
      asc(storefrontCategories.position),
      asc(sql`lower(${storefrontCategories.name})`),
      asc(storefrontCategories.id),
    );
}

// The checkout's settings, also what the quote applies
async function checkoutSettingsOf(tx: Transaction, shop: ShopScope): Promise<ShopCheckoutSettings> {
  const [settings] = await tx
    .select({
      zones: storefrontSettings.deliveryZones,
      paymentMethods: storefrontSettings.paymentMethods,
      freeDeliveryFrom: storefrontSettings.freeDeliveryFrom,
      minimumOrder: storefrontSettings.minimumOrder,
    })
    .from(storefrontSettings)
    .where(eq(storefrontSettings.tenantId, shop.tenantId));
  if (settings === undefined) throw storefrontNotFound();
  return {
    // A launched shop has one to six (storefront_settings_launch_check and zones_check); each
    // zone's shape is checked here, because jsonb holds whatever was written
    zones: z.array(shopDeliveryZoneSchema).parse(settings.zones),
    paymentMethods: settings.paymentMethods,
    freeDeliveryFrom: settings.freeDeliveryFrom,
    minimumOrder: settings.minimumOrder,
  };
}
```

The categories come in the tenant's order, by name within a position and then by id, so the order is the same
every time. The checkout settings parse each delivery zone: jsonb holds whatever was written.

### The routes: `apps/api/src/storefront/public-storefront.controller.ts`

```ts
import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopHost } from './shop-host.decorator.js';

type Routes = typeof routes.publicStorefront;

// Step 26f: /public/v1, the shop's server's way into the ERP (no login). Every answer is no-store
// (the 26f.3 decision): a cache in front of the API keys an answer by its address, not by the
// X-Shop-Host header, so it could hand one shop's page to another. The shop's server keeps its own
// short cache, per host (26f.5).
@Controller()
export class PublicStorefrontController {
  constructor(private readonly storefront: PublicStorefrontService) {}

  @Endpoint(routes.publicStorefront.shop)
  @Header('Cache-Control', 'no-store')
  shop(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['shop']>> {
    return this.storefront.shop(host);
  }

  @Endpoint(routes.publicStorefront.categories)
  @Header('Cache-Control', 'no-store')
  categories(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['categories']>> {
    return this.storefront.categories(host);
  }

  @Endpoint(routes.publicStorefront.home)
  @Header('Cache-Control', 'no-store')
  home(@ShopHost() host: string | undefined): Promise<RouteResponse<Routes['home']>> {
    return this.storefront.home(host);
  }

  @Endpoint(routes.publicStorefront.listings)
  @Header('Cache-Control', 'no-store')
  listings(
    { query }: RouteInput<Routes['listings']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['listings']>> {
    return this.storefront.listings(host, query);
  }

  @Endpoint(routes.publicStorefront.product)
  @Header('Cache-Control', 'no-store')
  product(
    { params }: RouteInput<Routes['product']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['product']>> {
    return this.storefront.product(host, params.slug);
  }

  @Endpoint(routes.publicStorefront.quote)
  @Header('Cache-Control', 'no-store')
  quote(
    { body }: RouteInput<Routes['quote']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['quote']>> {
    return this.storefront.quote(host, body);
  }

  @Endpoint(routes.publicStorefront.checkoutSettings)
  @Header('Cache-Control', 'no-store')
  checkoutSettings(
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['checkoutSettings']>> {
    return this.storefront.checkoutSettings(host);
  }

  @Endpoint(routes.publicStorefront.textPage)
  @Header('Cache-Control', 'no-store')
  textPage(
    { params }: RouteInput<Routes['textPage']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['textPage']>> {
    return this.storefront.textPage(host, params.slug);
  }
}
```

`@Endpoint` takes the path, the method, the status and "no login" from the contract, so the routes cannot drift
from it. Where a route has an input, `@Endpoint` puts the parsed input in the first argument; the host is the
second. Every answer is `no-store` (decision 24).

```ts
import { Module } from '@nestjs/common';

import { PublicStorefrontController } from './public-storefront.controller.js';
import { PublicStorefrontService } from './public-storefront.service.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the online shop's side of the API. Today only the public reads (/public/v1); step 26g
// adds the ERP's Storefront screens' routes here, behind storefront.manage
@Module({
  controllers: [PublicStorefrontController],
  providers: [ShopDb, PublicStorefrontService],
})
export class StorefrontModule {}
```

```diff
@@ -39,6 +39,7 @@ import { RolesModule } from './roles/roles.module.js';
 import { SalesModule } from './sales/sales.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 import { SetupModule } from './setup/setup.module.js';
+import { StorefrontModule } from './storefront/storefront.module.js';
 import { SyncModule } from './sync/sync.module.js';
 import { TaxModule } from './tax/tax.module.js';
 
@@ -75,6 +76,7 @@ export class AppModule implements NestModule {
         PurchaseModule,
         SyncModule,
         PosModule,
+        StorefrontModule,
       ],
       controllers: [HealthController, ...(config.exposeDocs ? [DocsController] : [])],
       providers: [
```

### A listed product cannot be deleted

```diff
@@ -76,6 +76,8 @@ const VARIANT_IN_USE = [
   'bill_lines_variant_fk',
   // step 20a
   'pos_sale_lines_variant_fk',
+  // step 26f: a variant on sale in the online shop. The tenant takes it off the shop first
+  'storefront_listings_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

Without this line, deleting a listed product would fail on the listing's foreign key with a raw 500. With it, the
products screen gets `product_in_use` and says to archive it, which also takes it out of the shop.

### Regenerate the API description

```sh
pnpm --filter @omnivo/contracts gen:openapi
```

`packages/contracts/openapi.json` gets the eight routes and the two schema changes. `pnpm test:openapi` fails until
this is done.

### Check this part

```sh
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm --filter @omnivo/contracts test:openapi
pnpm exec eslint apps/api/src/storefront apps/api/src/config.ts packages/contracts/src
pnpm exec prettier --check apps/api/src/storefront apps/api/src/config.ts packages/contracts/src apps/shop/src/pages/index.astro
```

`pnpm --filter @omnivo/api test` includes `contract.spec.ts`, which fails since 26f.1 (the routes were in the
contract and not served) and passes again now: the API serves exactly the routes of `@omnivo/contracts`.

While writing this part, a smoke test also ran against a real Postgres (a Testcontainers database, never the dev
one): a workspace with four products, three categories, four listings (one with an archived product), a
collection, an image banner and a text page, all made through SQL because the ERP has no Storefront screens yet.
It checked the shop and its 404 for other hosts, every sort and filter, a cursor walk of 25 listings in all four
sorts (each listing exactly once), a cursor from one sort refused in another, the product page with escaped HTML,
the home page with no hero, the quote, and the text pages. All passed. With the "not archived" rule taken out on
purpose, five of the eight failed. The smoke test becomes the integration tests of 26f.4.

## 26f.4 — The API's tests

26f.3 ran a smoke test while it was written. This part turns it into the real suites: an integration spec for every
answer of `/public/v1`, a tenant-leak spec for the walls between shops and around the ERP, and a small unit spec
for the two new config values. Nothing in the API's code changes in this part: every test passed against 26f.3's
code (after the test's own mistakes were fixed), and each wall below was broken on purpose once to prove its test
catches it.

The integration specs need Docker (Testcontainers starts a throwaway Postgres and Valkey for each file, never the
dev database). They run in `pnpm --filter @omnivo/api test:integration` and `test:tenant-leak` like every other
`*.int.spec.ts`; the file name decides which (decision 36 explains why they write SQL).

### A shop for the tests: `apps/api/src/testing/storefront.ts`

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Product, productSchema, type StorefrontImage } from '@omnivo/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';
import { z } from 'zod';

import { bearer, type SignedIn } from './http.js';

// Step 26f's tests: a shop made straight in the database. The ERP's Storefront screens (and their
// API) come in step 26g, so until then the tests write the rows as the superuser, the way 26g's
// API will. Every row still passes the tables' checks, so a test can never set up a shop the real
// screens could not make.

const idRowSchema = z.array(z.object({ id: z.uuid() })).length(1);

// A photo reference. The public API never opens the file, it only builds the address, so any uuid
// will do. padStart: photo(12) is still a valid uuid
export function photo(n: number): StorefrontImage {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    alt: `Photo ${String(n)}`,
  };
}

// The id of the one row an INSERT … RETURNING id::text made. postgres.js types its rows loosely,
// so the row is checked like any answer from outside the program
export function insertedId(rows: unknown): string {
  const [row] = idRowSchema.parse(rows);
  return row?.id ?? '';
}

export async function tenantIdOf(sql: postgres.Sql, slug: string): Promise<string> {
  const [row] = idRowSchema.parse(await sql`SELECT id::text FROM tenants WHERE slug = ${slug}`);
  return row?.id ?? '';
}

// A product with one variant, through the ERP's own API, so its rows are exactly what a real
// workspace has (SKU, base unit, version). The SKU is the name without spaces, in capitals
export async function createProduct(
  app: NestFastifyApplication,
  who: SignedIn,
  unitId: string,
  name: string,
  salePrice: string,
): Promise<Product> {
  const res = await app.inject({
    method: 'POST',
    url: '/products',
    headers: bearer(who.accessToken),
    payload: {
      code: '',
      name,
      type: 'goods',
      categoryId: '',
      description: '',
      baseUnitId: unitId,
      salesUnitId: '',
      purchaseUnitId: '',
      tracking: 'none',
      hasExpiry: false,
      taxRateId: '',
      options: [],
      variants: [
        {
          id: null,
          sku: name.replace(/\W/g, '').toUpperCase(),
          optionValues: [],
          barcode: '',
          salePrice,
          archived: false,
        },
      ],
      units: [],
      customFields: {},
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

export function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (variant === undefined) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

// A launched shop at `<subdomain>.localhost` (SHOP_BASE_DOMAIN's default), counting its stock in
// `warehouseId`, with one delivery zone: what storefront_settings_launch_check asks of a launch
export async function launchShop(
  sql: postgres.Sql,
  shop: { tenantId: string; subdomain: string; name: string; warehouseId: string },
): Promise<void> {
  await sql`
    INSERT INTO storefront_settings (tenant_id, subdomain, name, hotline, address,
      default_warehouse_id, delivery_zones, free_delivery_from, minimum_order, launched_at)
    VALUES (${shop.tenantId}, ${shop.subdomain}, ${shop.name}, '09612-000000', 'Mirpur 10, Dhaka',
      ${shop.warehouseId}, ${sql.json([{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }])},
      1000, 300, now())`;
}

export async function addCategory(
  sql: postgres.Sql,
  tenantId: string,
  category: { slug: string; name: string; parentId?: string },
): Promise<string> {
  const [row] = idRowSchema.parse(
    await sql`
    INSERT INTO storefront_categories (id, tenant_id, parent_id, slug, name)
    VALUES (gen_random_uuid(), ${tenantId}, ${category.parentId ?? null}, ${category.slug},
      ${category.name})
    RETURNING id::text`,
  );
  return row?.id ?? '';
}

export interface ListingInput {
  product: Product;
  categoryId: string;
  slug: string;
  // The card's name; the product's name when left out
  name?: string;
  priceOverride?: string;
  sale?: { kind: 'percent' | 'amount' | 'price'; value: string; startsAt?: Date; endsAt?: Date };
  seo?: { title: string; description: string };
  // How long ago it was published. null: a draft. Different ages give "Newest" a known order
  publishedDaysAgo?: number | null;
}

// One listing of the product's first variant, with two photos and one description section. The
// section holds a <script> on purpose: the API must send it as text (decision 8)
export async function addListing(
  sql: postgres.Sql,
  tenantId: string,
  listing: ListingInput,
): Promise<string> {
  const published = listing.publishedDaysAgo === undefined ? 0 : listing.publishedDaysAgo;
  const [row] = idRowSchema.parse(
    await sql`
    INSERT INTO storefront_listings (id, tenant_id, product_id, variant_id, category_id, slug, name,
      pack_size, price_override, sale_kind, sale_value, sale_starts_at, sale_ends_at, images,
      description_sections, seo_title, seo_description, published_at)
    VALUES (gen_random_uuid(), ${tenantId}, ${listing.product.id}, ${variantOf(listing.product)},
      ${listing.categoryId}, ${listing.slug}, ${listing.name ?? listing.product.name}, '150ml',
      ${listing.priceOverride ?? null}, ${listing.sale?.kind ?? null}, ${listing.sale?.value ?? null},
      ${listing.sale?.startsAt ?? null}, ${listing.sale?.endsAt ?? null},
      ${sql.json(published === null ? [] : [photo(1), photo(2)])},
      ${sql.json([{ heading: 'Key benefits', body: '- Controls **oil**\n- <script>x</script>' }])},
      ${listing.seo?.title ?? null}, ${listing.seo?.description ?? null},
      ${published === null ? null : sql`now() - make_interval(days => ${published})`})
    RETURNING id::text`,
  );
  return row?.id ?? '';
}
```

- **Why a helper file, not code in each spec.** Both specs need a launched shop, categories and listings. The rows
  have many required columns and checks (a published listing needs a photo, a launched shop a warehouse and a zone),
  so one place writes them right, and 26g can replace it with calls to its API in one place.
- **`createProduct` goes through the ERP's API, the shop rows do not.** A product has a SKU, a base unit, a version
  and audit rows that only the products service writes correctly. Writing it with SQL would make a product the ERP
  itself never makes. The shop's rows have no service yet (26g), so SQL is the only way.
- **`photo(n)` pads the number** to twelve digits. The smoke test wrote `…00000000000${n}`, which made photo 10 a
  13-digit group, not a uuid: the listing would then fail `storefrontImagesSchema` and drop out of the shop with no
  clear reason.
- **`insertedId` parses the row with Zod.** postgres.js types a raw row as `any`. Reading `row.id` straight from it
  is what the lint rules (`no-unsafe-argument`) refuse, and they are right: a typo in the column name would be
  `undefined` at run time, not a type error.
- **`publishedDaysAgo`.** `null` is a draft (and a draft may have no photo, so it gets none). A number gives each
  listing a different `published_at`, so "Newest" has a known order to check. It defaults to 0 (published now).
- **The description holds `<script>x</script>` on purpose.** Every listing made here carries it, so every product
  page in the tests proves decision 8 again: the tenant's words go out as text.

### The answers: `apps/api/src/storefront/public-storefront.int.spec.ts`

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Product,
  problemSchema,
  publicShopSchema,
  setupSchema,
  shopCartQuoteSchema,
  shopCategorySchema,
  shopCheckoutSettingsSchema,
  shopHomeSchema,
  type ShopListing,
  shopListingPageSchema,
  shopProductPageSchema,
  shopTextPageSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import { sql as drizzleSql } from 'drizzle-orm';
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
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import {
  addCategory,
  addListing,
  createProduct,
  insertedId,
  launchShop,
  photo,
  tenantIdOf,
  variantOf,
} from '../testing/storefront.js';
import { selectListings } from './listing-sql.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the public shop API against a real database, as the shop's server calls it: no
// login, only the X-Shop-Host header. One launched shop, "nirvor", with a few categories and
// listings; each test adds what it needs in a category of its own, so the tests do not change
// each other's pages.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let tenantId: string;
let pcs: string;
let mainWarehouse: string;
// The four listings of beforeAll, by name
let listings: { neem: string; tea: string; milk: string; old: string };
let milk: Product;

const HOST = { 'x-shop-host': 'nirvor.localhost:4331' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function get(url: string, headers: Record<string, string> = HOST) {
  return app.inject({ method: 'GET', url, headers });
}

async function page(query: string): Promise<ShopListing[]> {
  const res = await get(`/public/v1/listings?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return shopListingPageSchema.parse(res.json()).items;
}

function product(name: string, salePrice: string): Promise<Product> {
  return createProduct(app, owner, pcs, name, salePrice);
}

function problemOf(res: Awaited<ReturnType<typeof get>>) {
  return problemSchema.parse(res.json());
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
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
  const auth = { headers: bearer(owner.accessToken) };
  expect(
    (await app.inject({ method: 'POST', url: '/setup', payload: { industry: 'retail' }, ...auth }))
      .statusCode,
  ).toBe(200);
  await eventually(async () => {
    const setup = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(setup.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  mainWarehouse = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  pcs = unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  tenantId = await tenantIdOf(sql, 'nirvor');

  await launchShop(sql, {
    tenantId,
    subdomain: 'nirvor',
    name: 'Nirvor Pharmacy',
    warehouseId: mainWarehouse,
  });
  const skin = await addCategory(sql, tenantId, { slug: 'skin-care', name: 'Skin care' });
  const face = await addCategory(sql, tenantId, {
    slug: 'face-wash',
    name: 'Face wash',
    parentId: skin,
  });
  const drinks = await addCategory(sql, tenantId, { slug: 'beverages', name: 'Beverages' });

  const neem = await product('Neem Face Wash', '299');
  const tea = await product('Green Tea', '120');
  milk = await product('Milk Powder', '780');
  const old = await product('Old Soap', '50');
  // Old Soap is archived after it was listed: its listing stays published, and the shop hides it
  await sql`UPDATE product_variants SET archived_at = now() WHERE id = ${variantOf(old)}`;
  await sql`UPDATE products SET archived_at = now() WHERE id = ${old.id}`;
  // Milk Powder has no stock: out of stock, but still on the shelf
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${tenantId}, ${mainWarehouse}, ${neem.id}, ${variantOf(neem)}, 5),
           (${tenantId}, ${mainWarehouse}, ${tea.id}, ${variantOf(tea)}, 2)`;

  const neemId = await addListing(sql, tenantId, {
    product: neem,
    categoryId: face,
    slug: 'neem-face-wash',
    sale: { kind: 'price', value: '229' },
    publishedDaysAgo: 3,
  });
  const teaId = await addListing(sql, tenantId, {
    product: tea,
    categoryId: drinks,
    slug: 'green-tea',
    sale: { kind: 'percent', value: '10' },
    seo: { title: 'Green tea from Sylhet', description: 'Loose green tea, 100 g.' },
    publishedDaysAgo: 2,
  });
  const milkId = await addListing(sql, tenantId, {
    product: milk,
    categoryId: drinks,
    slug: 'milk-powder',
    publishedDaysAgo: 1,
  });
  const oldId = await addListing(sql, tenantId, {
    product: old,
    categoryId: skin,
    slug: 'old-soap',
    publishedDaysAgo: 0,
  });
  listings = { neem: neemId, tea: teaId, milk: milkId, old: oldId };

  // The home page: an image banner, then a row that holds the archived soap and the tea
  const collection = insertedId(
    await sql`
    INSERT INTO storefront_collections (id, tenant_id, title, icon)
    VALUES (gen_random_uuid(), ${tenantId}, 'Hot & Trending', 'fire') RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
    VALUES (${tenantId}, ${collection}, ${listings.old}, 1),
           (${tenantId}, ${collection}, ${listings.tea}, 2)`;
  const banner = insertedId(
    await sql`
    INSERT INTO storefront_banners (id, tenant_id, kind, href, desktop_image, phone_image)
    VALUES (gen_random_uuid(), ${tenantId}, 'image', '/c/skin-care', ${sql.json(photo(3))},
      ${sql.json(photo(4))})
    RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_home_blocks (tenant_id, position, banner_id, collection_id)
    VALUES (${tenantId}, 1, ${banner}, NULL), (${tenantId}, 2, NULL, ${collection})`;
  await sql`
    INSERT INTO storefront_pages (tenant_id, slug, sections)
    VALUES (${tenantId}, 'terms', ${sql.json([{ heading: 'Terms', body: 'Read [this](/pages/privacy).' }])})`;
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **One workspace, four listings.** Neem (a "sell at ৳229" sale), tea (10% off, with its own SEO), milk (no stock)
  and an old soap whose product is archived *after* it was listed. That last one is the case a real tenant hits:
  the listing is still published in the database, and only the shop's rules hide it.
- **`listings` and `milk` are typed variables, not a `Record<string, string>`.** Inside `beforeAll` TypeScript
  narrows `record.old` after it is assigned; inside a test it does not, and with `noUncheckedIndexedAccess` it is
  `string | undefined`. An object with named keys is `string` everywhere and needs no `?? ''`.
- **The header is `nirvor.localhost:4331`,** with the port, as the shop's dev server really sends it
  (`subdomainOf` strips it).
- **Each later test adds rows in a category of its own** (`hidden`, `sales`, `stock`, `paging`) and asks with
  `?category=`. Vitest runs the tests of one file in order, but a test that only sees its own category does not
  depend on that order, and the first tests can still check the exact list of all cards.

```ts
describe('which shop', () => {
  it('answers the shop and its categories, never cached', async () => {
    const shop = await get('/public/v1/shop');
    expect(shop.statusCode, shop.body).toBe(200);
    // Decision 24: the shop's server caches; the API never lets a proxy keep a tenant's answer
    expect(shop.headers['cache-control']).toBe('no-store');
    expect(publicShopSchema.parse(shop.json())).toMatchObject({
      name: 'Nirvor Pharmacy',
      timeZone: 'Asia/Dhaka',
      hotline: '09612-000000',
      logo: null,
    });
    const tree = z.array(shopCategorySchema).parse((await get('/public/v1/categories')).json());
    // One flat list in the tenant's order (position, then name); the shop builds the tree
    expect(tree.map((category) => category.slug)).toEqual(['beverages', 'face-wash', 'skin-care']);
  });

  it('finds the shop by any spelling of its host', async () => {
    for (const host of ['NIRVOR.localhost', 'nirvor.localhost.', ' nirvor.localhost ']) {
      expect((await get('/public/v1/shop', { 'x-shop-host': host })).statusCode, host).toBe(200);
    }
  });

  it('answers 404 storefront_not_found for every host that is not a launched shop', async () => {
    const hosts = ['other.localhost', 'nirvor.example.com', 'a.nirvor.localhost', 'localhost', ''];
    for (const host of hosts) {
      const res = await get('/public/v1/shop', { 'x-shop-host': host });
      expect(res.statusCode, host).toBe(404);
      expect(problemOf(res).code).toBe('storefront_not_found');
    }
    // No header at all
    expect((await get('/public/v1/shop', {})).statusCode).toBe(404);
  });

  it('closes the shop while it is not launched, and when its workspace is deleted', async () => {
    try {
      await sql`UPDATE storefront_settings SET launched_at = NULL WHERE tenant_id = ${tenantId}`;
      for (const url of [
        '/public/v1/shop',
        '/public/v1/listings',
        '/public/v1/products/green-tea',
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(problemOf(res).code).toBe('storefront_not_found');
      }
    } finally {
      await sql`UPDATE storefront_settings SET launched_at = now() WHERE tenant_id = ${tenantId}`;
    }
    try {
      await sql`UPDATE tenants SET deleted_at = now() WHERE id = ${tenantId}`;
      expect(problemOf(await get('/public/v1/shop')).code).toBe('storefront_not_found');
    } finally {
      await sql`UPDATE tenants SET deleted_at = NULL WHERE id = ${tenantId}`;
    }
    expect((await get('/public/v1/shop')).statusCode).toBe(200);
  });
});
```

- **`no-store` is checked on the first answer.** Decision 24 is easy to lose: a later "performance" change that adds
  `s-maxage` would let a CDN keep one tenant's prices for everyone. The quote test checks it again.
- **The categories come as one flat list** in the tenant's order (position, then name), so "Face wash" (a child of
  "Skin care") sits between the two roots. The shop builds the tree from `parentId`; the test pins the order so a
  change to the ORDER BY is seen.
- **The host spellings:** upper case, a trailing dot and spaces are the same host. Each is a way a real request
  can arrive (a typed URL, a fully qualified name, a proxy that adds a space).
- **The 404 hosts** cover every branch of `subdomainOf`: another subdomain, another domain, two labels
  (`a.nirvor.localhost`), the base domain alone, an empty header, and no header at all. All give the same
  `storefront_not_found`, so a stranger learns nothing.
- **Closing the shop and deleting the workspace** are each undone in `finally`. If an assertion fails in the middle,
  the shop is open again for the tests after it, and the report shows the real failure instead of twenty 404s.
  The three URLs prove the lookup holds for every route, not only `/shop`.

```ts
describe('the cards', () => {
  it('shows only published listings of products that are not archived', async () => {
    const all = await page('');
    expect(all.map((card) => card.slug)).toEqual(['milk-powder', 'green-tea', 'neem-face-wash']);
    expect(all.find((card) => card.slug === 'neem-face-wash')).toMatchObject({
      price: '229.0000',
      compareAtPrice: '299.0000',
      discount: { kind: 'amount', value: '70.0000' },
      inStock: true,
      packSize: '150ml',
    });
    // A card has one photo, the small one
    expect(all[0]?.images).toHaveLength(1);
    expect(all[0]?.images[0]?.url).toMatch(
      /\/storefront\/0{8}-0{4}-4000-8000-0{11}1\/small\.webp$/,
    );
    expect(all.find((card) => card.slug === 'milk-powder')?.inStock).toBe(false);
  });

  it('hides a draft, an archived variant and a variant with no price', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'hidden', name: 'Hidden' });
    const draft = await product('Draft Lotion', '150');
    const archived = await product('Archived Lotion', '150');
    const noPrice = await product('Unpriced Lotion', '150');
    const ownPrice = await product('Own Price Lotion', '150');
    await addListing(sql, tenantId, {
      product: draft,
      categoryId: category,
      slug: 'draft-lotion',
      publishedDaysAgo: null,
    });
    await addListing(sql, tenantId, {
      product: archived,
      categoryId: category,
      slug: 'archived-lotion',
    });
    await addListing(sql, tenantId, {
      product: noPrice,
      categoryId: category,
      slug: 'unpriced-lotion',
    });
    await addListing(sql, tenantId, {
      product: ownPrice,
      categoryId: category,
      slug: 'own-price-lotion',
      priceOverride: '175',
    });
    // Only the variant is archived, not the product
    await sql`UPDATE product_variants SET archived_at = now() WHERE id = ${variantOf(archived)}`;
    // Decision 2: no price of its own and none on the variant
    await sql`UPDATE product_variants SET sale_price = NULL WHERE id IN (${variantOf(noPrice)}, ${variantOf(ownPrice)})`;

    const shown = await page('category=hidden');
    // The listing's own price is enough, even when the variant has none
    expect(shown.map((card) => [card.slug, card.price])).toEqual([
      ['own-price-lotion', '175.0000'],
    ]);
    for (const slug of ['draft-lotion', 'archived-lotion', 'unpriced-lotion', 'old-soap']) {
      expect((await get(`/public/v1/products/${slug}`)).statusCode, slug).toBe(404);
    }
  });

  // listing-sql.ts works the price out in SQL (to filter and sort by it) and the card in
  // TypeScript (listingPricing). If the two ever differ, a "From ৳100" filter shows a ৳99 card,
  // or the cards of "Price: low to high" come out of order. So every kind of sale, and every way a
  // sale is not on, is checked both ways: the card the API answers, and the SQL's own column
  it('works out the same price in SQL as on the card, for every kind of sale', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'sales', name: 'Sales' });
    const now = Date.now();
    // Whole seconds: the API sends the end back as saleUntil, and the test compares it. Postgres
    // writes it to the microsecond (isoText in listing-sql.ts), still an ISO time for Date.parse
    const tomorrow = new Date(Math.floor((now + DAY) / 1000) * 1000);
    const cases: {
      slug: string;
      regular: string;
      override?: string;
      sale: { kind: 'percent' | 'amount' | 'price'; value: string; startsAt?: Date; endsAt?: Date };
      expected: Pick<ShopListing, 'price' | 'compareAtPrice' | 'discount' | 'saleUntil'>;
    }[] = [
      {
        // 10% of ৳249.95 is ৳24.995: half up to ৳25.00, in Postgres's round() and in percentOfMoney
        slug: 'percent-rounds',
        regular: '249.95',
        sale: { kind: 'percent', value: '10' },
        expected: {
          price: '224.9500',
          compareAtPrice: '249.9500',
          discount: { kind: 'percent', value: 10 },
          saleUntil: null,
        },
      },
      {
        slug: 'amount-off',
        regular: '299',
        sale: { kind: 'amount', value: '50' },
        expected: {
          price: '249.0000',
          compareAtPrice: '299.0000',
          discount: { kind: 'amount', value: '50.0000' },
          saleUntil: null,
        },
      },
      {
        // The listing's own price is the regular price; the variant's ৳999 is not used
        slug: 'set-price-on-override',
        regular: '999',
        override: '500',
        sale: { kind: 'price', value: '425' },
        expected: {
          price: '425.0000',
          compareAtPrice: '500.0000',
          discount: { kind: 'amount', value: '75.0000' },
          saleUntil: null,
        },
      },
      {
        slug: 'running-window',
        regular: '299',
        sale: { kind: 'amount', value: '30', startsAt: new Date(now - HOUR), endsAt: tomorrow },
        expected: {
          price: '269.0000',
          compareAtPrice: '299.0000',
          discount: { kind: 'amount', value: '30.0000' },
          saleUntil: tomorrow.toISOString().replace('.000Z', '.000000Z'),
        },
      },
      {
        slug: 'not-started',
        regular: '299',
        sale: { kind: 'percent', value: '20', startsAt: new Date(now + DAY) },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // Decision 11: the end is exclusive, so a sale that ended a minute ago is off
        slug: 'ended',
        regular: '299',
        sale: {
          kind: 'percent',
          value: '20',
          startsAt: new Date(now - 2 * DAY),
          endsAt: new Date(now - 60_000),
        },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // Decision 9: "sell at ৳350" when it costs ৳299 takes nothing off: no sale
        slug: 'price-above-regular',
        regular: '299',
        sale: { kind: 'price', value: '350' },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
      {
        // …and neither does a sale that would give it away
        slug: 'everything-off',
        regular: '299',
        sale: { kind: 'amount', value: '299' },
        expected: { price: '299.0000', compareAtPrice: null, discount: null, saleUntil: null },
      },
    ];
    for (const [index, c] of cases.entries()) {
      const made = await product(`Sale case ${String(index)}`, c.regular);
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: c.slug,
        sale: c.sale,
        ...(c.override !== undefined && { priceOverride: c.override }),
      });
    }

    const cards = await page('category=sales');
    expect(cards).toHaveLength(cases.length);
    // The price column of listing-sql.ts's subquery, read the way the API reads it (as
    // omnivo_public, in this shop, at one moment). The card's price is listingPricing's
    const rows = await app
      .get(ShopDb)
      .read(HOST['x-shop-host'], (tx, shop) =>
        selectListings(tx, shop, drizzleSql`WHERE shown.category_id = ${category}::uuid`),
      );
    const sqlPrice = new Map(rows.map((row) => [row.slug, row.price]));
    for (const c of cases) {
      const card = cards.find((one) => one.slug === c.slug);
      expect(card, c.slug).toMatchObject(c.expected);
      // The same text: numeric(19,4) in Postgres, 4 decimals in the contracts' money helpers
      expect(sqlPrice.get(c.slug), c.slug).toBe(card?.price);
    }
    // The filter is in whole taka: ৳224.95 is under 225 and over 224
    expect((await page('category=sales&maxPrice=224')).map((one) => one.slug)).not.toContain(
      'percent-rounds',
    );
    expect((await page('category=sales&minPrice=225')).map((one) => one.slug)).not.toContain(
      'percent-rounds',
    );
    // The SQL's on_sale is the card's struck-out price: "Offer" shows exactly those
    const offer = await page('category=sales&offer=1');
    expect(offer.map((card) => card.slug).sort()).toEqual(
      cards
        .filter((card) => card.compareAtPrice !== null)
        .map((card) => card.slug)
        .sort(),
    );
    // And the cards come in the order of the prices the shopper pays
    const ascending = (await page('category=sales&sort=price_asc')).map((card) =>
      Number(card.price),
    );
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b));
  });

  it('counts stock in the shop warehouse only, over all its batches', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'stock', name: 'Stock' });
    const [factory] = z.array(z.object({ id: z.uuid() })).parse(
      await sql`
      INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
      SELECT gen_random_uuid(), tenant_id, branch_id, 'FACTORY', 'Factory store'
        FROM warehouses WHERE id = ${mainWarehouse}
      RETURNING id::text`,
    );
    const balance = async (made: Product, warehouseId: string, quantities: string[]) => {
      for (const [index, quantity] of quantities.entries()) {
        const batch = insertedId(
          await sql`
          INSERT INTO batches (id, tenant_id, product_id, variant_id, lot_number)
          VALUES (gen_random_uuid(), ${tenantId}, ${made.id}, ${variantOf(made)},
            ${`${made.id.slice(0, 8)}-${warehouseId.slice(0, 4)}-${String(index)}`})
          RETURNING id::text`,
        );
        await sql`
          INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, batch_id, quantity)
          VALUES (${tenantId}, ${warehouseId}, ${made.id}, ${variantOf(made)}, ${batch}, ${quantity})`;
      }
    };
    const more = await product('Sold Short Plenty', '90');
    const none = await product('Sold Short Even', '90');
    const elsewhere = await product('Factory Only', '90');
    // Step 20a's sold-short: one batch below zero, another above. 3 − 1 = 2 left
    await balance(more, mainWarehouse, ['3', '-1']);
    // 1 − 1 = nothing left
    await balance(none, mainWarehouse, ['1', '-1']);
    // Ten in the factory store, none in the shop's warehouse
    await balance(elsewhere, factory?.id ?? '', ['10']);
    for (const made of [more, none, elsewhere]) {
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: made.name.toLowerCase().replaceAll(' ', '-'),
      });
    }

    const cards = await page('category=stock&sort=name');
    expect(cards.map((card) => [card.slug, card.inStock])).toEqual([
      ['factory-only', false],
      ['sold-short-even', false],
      ['sold-short-plenty', true],
    ]);
    expect((await page('category=stock&inStock=1')).map((card) => card.slug)).toEqual([
      'sold-short-plenty',
    ]);
  });

  it('filters by category tree, words, price, stock and offer, and sorts', async () => {
    // A parent category shows its children's listings too
    expect((await page('category=skin-care')).map((card) => card.slug)).toEqual(['neem-face-wash']);
    // Every word must match: "beverages" the category, "tea" the name
    expect((await page('q=beverages%20tea')).map((card) => card.slug)).toEqual(['green-tea']);
    // Part of the SKU (NEEMFACEWASH), in any case
    expect((await page('q=nee')).map((card) => card.slug)).toEqual(['neem-face-wash']);
    expect(
      (await page('category=beverages&offer=1&inStock=1&maxPrice=200')).map((card) => card.slug),
    ).toEqual(['green-tea']);
    expect((await page('category=beverages&sort=price_desc')).map((card) => card.price)).toEqual([
      '780.0000',
      '108.0000',
    ]);
    // An unknown category finds nothing (decision 31), never every listing
    expect(await page('category=no-such-category')).toEqual([]);
    const bad = await get('/public/v1/listings?cursor=bad');
    expect(bad.statusCode).toBe(400);
    expect(problemOf(bad).code).toBe('invalid_cursor');
  });
});
```

- **The first test checks the exact list and the order** (newest first): milk, tea, neem; the archived soap is not
  there. The card's photo is the small one, and only one: a page of 20 cards must stay light.
- **What hides a listing.** A draft, a variant archived while its product is not (the product test alone would not
  catch a missing `v.archived_at` rule), and a variant with no sale price and no override. The fourth listing has no
  variant price but its own: it shows, at ৳175. Each hidden one is also a 404 on its product page, because the
  page reads the same subquery.
- **The price test (decision 37).** Eight sales, one per rule of `listingPricing`:
  - 10% of ৳249.95 is ৳24.995, which rounds half up to ৳25.00. This is the one case where Postgres's `round()` and
    a careless rounding in TypeScript (or `trunc`) differ, so it is the most important line of the test.
  - an amount off, and a set price on a listing whose own price (৳500) replaces the variant's (৳999),
  - a sale inside its dates, with `saleUntil` sent back; one not started; one that ended a minute ago (the end is
    exclusive, decision 11),
  - a set price above the regular price, and an amount that takes the whole price: no sale (decision 9).

  `tomorrow` is cut to whole seconds, so the test can write the exact `saleUntil` text Postgres sends back
  (decision 38). Then for each case the card must match, and the SQL's own `price` column, read through
  `ShopDb.read` and `selectListings` (the API's path, as `omnivo_public`), must be the same text. "Offer" must
  show exactly the cards with a struck-out price (the SQL's `on_sale` against `listingPricing`'s
  `compareAtPrice`), and "Price: low to high" must be in the order of the card prices. The two whole-taka filters
  check that ৳224.95 is between 224 and 225 and not rounded on the way.
- **The stock test** writes balances with batches, because a balance with a batch is the only way to have two
  rows for one variant in one warehouse (the unique key is warehouse + variant + batch). 3 and −1 is a sold-short
  batch (step 20a) next to a good one: 2 left, in stock. 1 and −1 is nothing left. Ten in a second warehouse (the
  "Factory store") is not the shop's stock (decision 3). The lot numbers are built from the ids, so they never
  collide with `batches_variant_lot_idx`.
- **The filter test** goes through each filter once against the four listings of `beforeAll`: a parent category
  shows its child's listing, every word must match (one in the category, one in the name), part of the SKU in any
  case, the three flags together, the price sort, an unknown category (decision 31), and a broken cursor as
  `400 invalid_cursor`.

```ts
describe('the product page', () => {
  it('answers the gallery, the description as escaped HTML, SEO and the related cards', async () => {
    const res = await get('/public/v1/products/green-tea');
    expect(res.statusCode, res.body).toBe(200);
    const { product: tea, related } = shopProductPageSchema.parse(res.json());
    // Both photos, large
    expect(tea.images).toHaveLength(2);
    for (const image of tea.images)
      expect(image.url).toMatch(/\/storefront\/[0-9a-f-]{36}\/large\.webp$/);
    // Decision 8: the tenant's words are text, never HTML; the <script> is shown, not run
    expect(tea.descriptionHtml).toBe(
      '<section><h2>Key benefits</h2><ul><li>Controls <strong>oil</strong></li><li>&lt;script&gt;x&lt;/script&gt;</li></ul></section>',
    );
    expect(tea).toMatchObject({
      sku: 'GREENTEA',
      unitName: 'Pieces',
      seo: { title: 'Green tea from Sylhet', description: 'Loose green tea, 100 g.' },
    });
    // The same category, newest first, without the product itself
    expect(related.map((card) => card.slug)).toEqual(['milk-powder']);
  });

  it('fills SEO from the name and the description when the tenant left it empty', async () => {
    const { product: neem } = shopProductPageSchema.parse(
      (await get('/public/v1/products/neem-face-wash')).json(),
    );
    expect(neem.seo.title).toBe('Neem Face Wash');
    expect(neem.seo.description).toContain('Controls oil');
    expect((await get('/public/v1/products/nothing-here')).statusCode).toBe(404);
  });

  it('refuses to delete a product the shop lists', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/products/${milk.id}?version=${String(milk.version)}`,
      headers: bearer(owner.accessToken),
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('product_in_use');
  });
});

describe('the home page', () => {
  it('answers no hero, and the blocks without the hidden listings', async () => {
    const home = shopHomeSchema.parse((await get('/public/v1/home')).json());
    expect(home.hero).toBeNull();
    expect(home.featured.map((card) => card.slug)).toContain('green-tea');
    expect(home.blocks.map((block) => block.kind)).toEqual(['image', 'collection']);
    const [banner, row] = home.blocks;
    expect(banner?.kind === 'image' && banner.desktopImage.url).toMatch(/\/wide\.webp$/);
    // The archived soap is left out of its row
    expect(row?.kind === 'collection' && row.collection.listings.map((card) => card.slug)).toEqual([
      'green-tea',
    ]);
  });

  it('answers the hero once, and leaves out a row with nothing to show', async () => {
    const hero = insertedId(
      await sql`
      INSERT INTO storefront_banners (id, tenant_id, kind, href, desktop_image, phone_image,
        headline, button_label, background_color, panel_color, button_color, button_text_color)
      VALUES (gen_random_uuid(), ${tenantId}, 'hero', '/c/beverages', ${sql.json(photo(5))},
        ${sql.json(photo(6))}, 'Fresh from Sylhet', 'Shop tea', '#eee0d8', '#e7d1b2', '#8b471f',
        '#ffffff')
      RETURNING id::text`,
    );
    const empty = insertedId(
      await sql`
      INSERT INTO storefront_collections (id, tenant_id, title)
      VALUES (gen_random_uuid(), ${tenantId}, 'Gone for now') RETURNING id::text`,
    );
    await sql`
      INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
      VALUES (${tenantId}, ${empty}, ${listings.old}, 1)`;
    // Decision 21: the hero put in the blocks too, and the row of only the archived soap
    await sql`
      INSERT INTO storefront_home_blocks (tenant_id, position, banner_id, collection_id)
      VALUES (${tenantId}, 3, ${hero}, NULL), (${tenantId}, 4, NULL, ${empty})`;

    const home = shopHomeSchema.parse((await get('/public/v1/home')).json());
    expect(home.hero).toMatchObject({
      headline: 'Fresh from Sylhet',
      colors: { panel: '#e7d1b2' },
    });
    expect(home.hero?.desktopImage.url).toMatch(/\/wide\.webp$/);
    expect(home.hero?.phoneImage.url).toMatch(/\/large\.webp$/);
    expect(home.blocks.map((block) => block.kind)).toEqual(['image', 'collection']);
  });
});
```

- **The product page.** Both photos, large; the description exactly as `renderSections` writes it, with the script
  as text; the tenant's SEO used as it is; "Related" from the same category, newest first, without the product
  itself. The unit name is `Pieces`, the retail template's name for `pcs`: the test pins it so a change in the
  template is seen here too.
- **SEO filled in (decision 14).** Neem has no SEO of its own: the title is the name, and the description is made
  from the description's own words (`sectionsSummary`), so it holds "Controls oil" without the `**`.
- **A listed product cannot be deleted.** The `DELETE` gets `409 product_in_use`, the products screen's own
  message, not a 500 from the foreign key (26f.3's change to `VARIANT_IN_USE`).
- **The home page without a hero**, and with one. The second test adds the hero to the blocks as well, and a row
  whose only listing is the archived soap. The answer has the hero once, at the top (wide on a computer, large on a
  phone, decision 32), and the blocks are still only the image banner and the first row: decision 21 and the
  "row with nothing to show is left out" rule of `blocks()`.

```ts
describe('the checkout', () => {
  it('quotes a cart from the shop price and stock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: HOST,
      payload: {
        lines: [
          { listingId: listings.neem, quantity: 2 },
          { listingId: listings.milk, quantity: 1 },
          { listingId: listings.old, quantity: 1 },
          // Not a uuid: unavailable, never a 500 from a ::uuid cast
          { listingId: 'lst-not-a-uuid', quantity: 1 },
        ],
        zoneId: 'inside_dhaka',
        couponCode: 'welcome10',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const quote = shopCartQuoteSchema.parse(res.json());
    expect(quote.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
      'unavailable',
    ]);
    // 2 × ৳229; the milk is out of stock, so it is not in the subtotal. Coupons come in step 27
    expect(quote).toMatchObject({
      subtotal: '458.0000',
      deliveryCharge: '80.0000',
      total: '538.0000',
      coupon: { status: 'refused', code: 'WELCOME10' },
    });
  });

  it('answers the checkout settings and the text pages', async () => {
    const settings = shopCheckoutSettingsSchema.parse(
      (await get('/public/v1/checkout-settings')).json(),
    );
    expect(settings).toMatchObject({
      zones: [{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }],
      freeDeliveryFrom: '1000.0000',
      minimumOrder: '300.0000',
    });
    const terms = shopTextPageSchema.parse((await get('/public/v1/pages/terms')).json());
    expect(terms.html).toBe(
      '<section><h2>Terms</h2><p>Read <a href="/pages/privacy">this</a>.</p></section>',
    );
    // A page the tenant has not written is not there
    expect((await get('/public/v1/pages/about')).statusCode).toBe(404);
  });
});

describe('paging', () => {
  it('walks 25 listings with a cursor in every sort, each one once', async () => {
    const category = await addCategory(sql, tenantId, { slug: 'paging', name: 'Paging' });
    for (let n = 0; n < 25; n += 1) {
      // Five prices and the same day for all: many ties, which only the id can order
      const made = await product(`Page item ${String(n)}`, String(100 + (n % 5)));
      await addListing(sql, tenantId, {
        product: made,
        categoryId: category,
        slug: `page-item-${String(n)}`,
        publishedDaysAgo: 4,
      });
    }
    for (const sort of ['newest', 'price_asc', 'price_desc', 'name']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const after: string = cursor === null ? '' : `&cursor=${cursor}`;
        const res = await get(`/public/v1/listings?category=paging&sort=${sort}${after}`);
        expect(res.statusCode, res.body).toBe(200);
        const next = shopListingPageSchema.parse(res.json());
        seen.push(...next.items.map((card) => card.id));
        cursor = next.nextCursor;
      } while (cursor !== null);
      expect(seen, sort).toHaveLength(25);
      expect(new Set(seen).size, sort).toBe(25);
    }
    // A cursor of one sort is refused in another
    const first = shopListingPageSchema.parse(
      (await get('/public/v1/listings?category=paging&sort=price_asc')).json(),
    );
    const mixed = await get(
      `/public/v1/listings?category=paging&sort=newest&cursor=${first.nextCursor ?? ''}`,
    );
    expect(mixed.statusCode).toBe(400);
  });
});
```

- **The quote** has one line of each kind: available, out of stock, archived (unavailable) and an id that is not a
  uuid. The last one is the line that would have been a 500 from a `::uuid` cast; it must be `unavailable` like any
  listing that does not exist. The subtotal counts only the available line, and a coupon is refused (decision 28).
- **The checkout settings** come back with the amounts as `numeric(19,4)` text, and the zone as it was saved.
- **Paging** makes 25 listings with only five prices and one day, so most rows tie on the sort key and only the id
  orders them. Each of the four sorts must walk every listing exactly once, page by page; a cursor that skipped or
  repeated a tie would fail the count or the `Set`. A cursor from "Price: low to high" is then refused under
  "Newest".

### The walls: `apps/api/src/storefront/storefront.tenant-leak.int.spec.ts`

The file name ends in `tenant-leak.int.spec.ts`, so it runs in `pnpm test:tenant-leak` (and not in
`test:integration`).

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  productPageSchema,
  setupSchema,
  shopCartQuoteSchema,
  shopCategorySchema,
  shopHomeSchema,
  shopListingPageSchema,
  shopProductPageSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import type { Db } from '@omnivo/db';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { DB } from '../infra/tokens.js';
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
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import {
  addCategory,
  addListing,
  createProduct,
  insertedId,
  launchShop,
  tenantIdOf,
} from '../testing/storefront.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the public API reads without a login, by the host alone, so a mistake here would show
// one workspace's shop to every stranger. Two launched shops, Nirvor and Acme, that use the same
// slugs on purpose: a host must only ever see its own shop. Then the database's own walls: the
// omnivo_public role reads nothing of the ERP beyond a card's columns, even through a query the
// API would never write, and the pooled connection is omnivo_app again after every request.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let nirvor: SignedIn;
let acme: SignedIn;
let nirvorId: string;
let acmeId: string;
let acmeTeaId: string;
let acmeOnlyId: string;

const NIRVOR = 'nirvor.localhost';
const ACME = 'acme.localhost';

function get(host: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { 'x-shop-host': host } });
}

// drizzle wraps the driver's error (DrizzleQueryError); Postgres's own code is on a .cause
function pgCodeOf(error: unknown): string | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') return current.code;
  }
  return null;
}

async function workspace(who: SignedIn, slug: string, name: string) {
  const auth = { headers: bearer(who.accessToken) };
  expect(
    (await app.inject({ method: 'POST', url: '/setup', payload: { industry: 'retail' }, ...auth }))
      .statusCode,
  ).toBe(200);
  await eventually(async () => {
    const setup = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(setup.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  const warehouseId = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  const pcs =
    unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  const tenantId = await tenantIdOf(sql, slug);
  await launchShop(sql, { tenantId, subdomain: slug, name, warehouseId });
  // The same category slug in both shops
  const beverages = await addCategory(sql, tenantId, { slug: 'beverages', name: `${name} drinks` });
  const tea = await createProduct(app, who, pcs, `${name} Green Tea`, '120');
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${tenantId}, ${warehouseId}, ${tea.id}, ${tea.variants[0]?.id ?? ''}, 5)`;
  // …and the same listing slug
  const teaId = await addListing(sql, tenantId, {
    product: tea,
    categoryId: beverages,
    slug: 'green-tea',
  });
  // A product the shop does not list: the ERP must still see it (INHERIT FALSE)
  await createProduct(app, who, pcs, `${name} Office Paper`, '450');
  return { tenantId, pcs, teaId };
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
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
  const a = await workspace(nirvor, 'nirvor', 'Nirvor');
  const b = await workspace(acme, 'acme', 'Acme');
  nirvorId = a.tenantId;
  acmeId = b.tenantId;
  acmeTeaId = b.teaId;

  // What only Acme has: a category, a listing in it, a text page, a draft, and a home row
  const acmeOnly = await addCategory(sql, acmeId, { slug: 'acme-only', name: 'Acme only' });
  const soap = await createProduct(app, acme, b.pcs, 'Acme Soap', '60');
  acmeOnlyId = await addListing(sql, acmeId, {
    product: soap,
    categoryId: acmeOnly,
    slug: 'acme-soap',
  });
  // The soap's stock is in a second warehouse, not the shop's
  const factory = insertedId(
    await sql`
      INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
      SELECT gen_random_uuid(), tenant_id, branch_id, 'FACTORY', 'Factory store'
        FROM warehouses WHERE tenant_id = ${acmeId} LIMIT 1
      RETURNING id::text`,
  );
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${acmeId}, ${factory}, ${soap.id}, ${soap.variants[0]?.id ?? ''}, 7)`;
  const draft = await createProduct(app, acme, b.pcs, 'Acme Draft', '60');
  await addListing(sql, acmeId, {
    product: draft,
    categoryId: acmeOnly,
    slug: 'acme-draft',
    publishedDaysAgo: null,
  });
  await sql`
    INSERT INTO storefront_pages (tenant_id, slug, sections)
    VALUES (${acmeId}, 'about', ${sql.json([{ heading: 'About Acme', body: 'Since 1998.' }])})`;
  const picks = insertedId(
    await sql`
      INSERT INTO storefront_collections (id, tenant_id, title)
      VALUES (gen_random_uuid(), ${acmeId}, 'Acme picks') RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
    VALUES (${acmeId}, ${picks}, ${acmeOnlyId}, 1)`;
  await sql`
    INSERT INTO storefront_home_blocks (tenant_id, position, collection_id)
    VALUES (${acmeId}, 1, ${picks})`;
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **Two shops with the same slugs.** Both have a `beverages` category and a `green-tea` listing. Slugs are unique per
  workspace only, so this is allowed, and it is exactly the case where a missing tenant filter would answer the
  wrong shop's product without any error.
- **What only Acme has:** a category, a listing in it, a draft, a text page, a home row, and stock of its soap in a
  second warehouse. Each is something Nirvor's host must never see, and the draft and the factory stock are what
  the role's own policies must hide inside Acme's shop.
- **Each workspace also gets a product that is not listed** ("Office Paper"). The last test needs it: the ERP must
  still see it.
- **`pgCodeOf` walks `.cause`,** like `pg-errors.ts`: drizzle wraps the driver's error, and the test wants the
  Postgres code (42501, 25006), not a message that could change between versions.

```ts
describe('one host, one shop', () => {
  it('answers each shop its own listing for the same slug', async () => {
    const mine = shopProductPageSchema.parse(
      (await get(NIRVOR, '/public/v1/products/green-tea')).json(),
    );
    const theirs = shopProductPageSchema.parse(
      (await get(ACME, '/public/v1/products/green-tea')).json(),
    );
    expect(mine.product.name).toBe('Nirvor Green Tea');
    expect(theirs.product.name).toBe('Acme Green Tea');
    expect(mine.product.id).not.toBe(theirs.product.id);
  });

  it('never lists, finds or links the other shop', async () => {
    const all = shopListingPageSchema.parse((await get(NIRVOR, '/public/v1/listings')).json());
    expect(all.items.map((card) => card.name)).toEqual(['Nirvor Green Tea']);
    // Acme's words find nothing in Nirvor's shop
    const search = shopListingPageSchema.parse(
      (await get(NIRVOR, '/public/v1/listings?q=acme')).json(),
    );
    expect(search.items).toEqual([]);
    // Acme's category slug is an unknown category here: an empty page, not Acme's cards
    const category = shopListingPageSchema.parse(
      (await get(NIRVOR, '/public/v1/listings?category=acme-only')).json(),
    );
    expect(category.items).toEqual([]);
    const tree = z
      .array(shopCategorySchema)
      .parse((await get(NIRVOR, '/public/v1/categories')).json());
    expect(tree.map((one) => one.name)).toEqual(['Nirvor drinks']);
    expect((await get(NIRVOR, '/public/v1/products/acme-soap')).statusCode).toBe(404);
    // Acme wrote an About page; Nirvor did not
    expect((await get(ACME, '/public/v1/pages/about')).statusCode).toBe(200);
    expect((await get(NIRVOR, '/public/v1/pages/about')).statusCode).toBe(404);
    const home = shopHomeSchema.parse((await get(NIRVOR, '/public/v1/home')).json());
    expect(home.blocks).toEqual([]);
    expect(home.featured.map((card) => card.name)).toEqual(['Nirvor Green Tea']);
  });

  it('quotes the other shop listings as unavailable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: { 'x-shop-host': NIRVOR },
      payload: {
        lines: [
          { listingId: acmeTeaId, quantity: 1 },
          { listingId: acmeOnlyId, quantity: 1 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const quote = shopCartQuoteSchema.parse(res.json());
    expect(quote.lines.map((line) => line.status)).toEqual(['unavailable', 'unavailable']);
    expect(quote.subtotal).toBe('0.0000');
  });
});
```

- **The same slug** answers each shop its own product, with a different id.
- **Never lists, finds or links:** the cards, a search for Acme's word, Acme's category slug (an empty page, not
  Acme's cards), the category list, Acme's product slug, Acme's text page (200 on Acme's host, 404 on Nirvor's, so
  the 404 is the wall and not a broken route), and the home page (no blocks; Acme's row is not there).
- **The quote** with Acme's listing ids from Nirvor's host: both `unavailable` and a subtotal of zero. A cart is the
  one place a shopper sends ids, so it is where one shop's ids reach another's API.

```ts
describe('the omnivo_public role', () => {
  // ShopDb.read is the API's own way in: SET LOCAL ROLE omnivo_public, Nirvor's workspace. The
  // queries below are ones the public API never writes, as a bug might
  function asShop<T>(query: (tx: Transaction) => Promise<T>, host = NIRVOR): Promise<T> {
    return app.get(ShopDb).read(host, (tx) => query(tx));
  }

  it('cannot read the ERP tables or columns a card does not need', async () => {
    const forbidden = [
      // Customers and suppliers (step 15a's parties), their invoices, the books
      drizzleSql`SELECT count(*) FROM parties`,
      drizzleSql`SELECT count(*) FROM invoices`,
      drizzleSql`SELECT count(*) FROM journal_entries`,
      // product_variants: the SKU and price are granted, the barcode and options are not
      drizzleSql`SELECT option_values FROM product_variants`,
      drizzleSql`SELECT * FROM products`,
      // stock_balances: only whether there is any, never what it is worth
      drizzleSql`SELECT batch_id FROM stock_balances`,
    ];
    for (const query of forbidden) {
      const error = await asShop((tx) => tx.execute(query)).catch((caught: unknown) => caught);
      // 42501 = insufficient_privilege ("permission denied")
      expect(pgCodeOf(error)).toBe('42501');
    }
  });

  it('writes nothing, even to the shop own tables', async () => {
    const error = await asShop((tx) =>
      tx.execute(drizzleSql`UPDATE storefront_listings SET name = 'Hacked'`),
    ).catch((caught: unknown) => caught);
    // 25006 = read_only_sql_transaction: READ ONLY answers before the missing grant does
    expect(pgCodeOf(error)).toBe('25006');
  });

  // In Acme's shop, which has a draft and stock in a second warehouse
  it('sees only the published listings, the variants they sell and the shop stock', async () => {
    const counts = await asShop(
      async (tx) =>
        z.array(z.object({ listings: z.number(), variants: z.number(), stock: z.number() })).parse(
          await tx.execute(drizzleSql`
            SELECT (SELECT count(*)::int FROM storefront_listings) AS listings,
                   (SELECT count(*)::int FROM product_variants) AS variants,
                   (SELECT count(*)::int FROM stock_balances) AS stock`),
        ),
      ACME,
    );
    // Four products: the tea and the soap are published, the draft is not, the paper is not
    // listed. Stock: the tea's in the shop's warehouse; the soap's is in the factory store
    expect(counts).toEqual([{ listings: 2, variants: 2, stock: 1 }]);
  });

  // Straight in the database, without the API: the role alone, as the superuser becomes it
  it('sees no shop at all without a workspace, and none of a shop not launched', async () => {
    const count = (rows: unknown) => z.array(z.object({ n: z.number() })).parse(rows)[0]?.n;
    const unset = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      return count(await tx`SELECT count(*)::int AS n FROM storefront_listings`);
    });
    expect(unset).toBe(0);
    // The same query with Nirvor's workspace finds its one listing: the zero above is the wall,
    // not a query that can find nothing
    const own = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      await tx`SELECT set_config('app.tenant_id', ${nirvorId}, true)`;
      return count(await tx`SELECT count(*)::int AS n FROM storefront_listings`);
    });
    expect(own).toBe(1);
    try {
      await sql`UPDATE storefront_settings SET launched_at = NULL WHERE tenant_id = ${acmeId}`;
      const closed = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE omnivo_public`;
        await tx`SELECT set_config('app.tenant_id', ${acmeId}, true)`;
        return count(
          await tx`
          SELECT (SELECT count(*) FROM storefront_listings)::int
               + (SELECT count(*) FROM storefront_pages)::int
               + (SELECT count(*) FROM product_variants)::int AS n`,
        );
      });
      // A bug that set Acme's workspace still finds nothing while Acme's shop is closed
      expect(closed).toBe(0);
    } finally {
      await sql`UPDATE storefront_settings SET launched_at = now() WHERE tenant_id = ${acmeId}`;
    }
    // The lookup function answers a launched shop's id, and only that
    const lookup = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      return z
        .array(z.object({ id: z.string().nullable() }))
        .parse(await tx`SELECT storefront_tenant_for_subdomain('acme')::text AS id`);
    });
    expect(lookup).toEqual([{ id: acmeId }]);
  });

  it('leaves the pooled connections as omnivo_app with no workspace', async () => {
    // Public requests, one of them failing mid-transaction
    await asShop((tx) => tx.execute(drizzleSql`SELECT count(*) FROM parties`)).catch(() => null);
    await Promise.all(Array.from({ length: 6 }, () => get(NIRVOR, '/public/v1/listings')));
    const db = app.get<symbol, Db>(DB);
    // In parallel, so they take different connections of the pool
    const rows = await Promise.all(
      Array.from({ length: 8 }, async () =>
        z
          .array(z.object({ who: z.string(), tenant: z.string().nullable() }))
          .parse(
            await db.execute(
              drizzleSql`SELECT current_user AS who, nullif(current_setting('app.tenant_id', true), '') AS tenant`,
            ),
          ),
      ),
    );
    expect(rows.flat()).toEqual(
      Array.from({ length: 8 }, () => ({ who: 'omnivo_app', tenant: null })),
    );
  });

  it('does not hide the products the shop does not list from the ERP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: bearer(nirvor.accessToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    // The restrictive policies are for omnivo_public only: the ERP sees both products
    expect(
      productPageSchema
        .parse(res.json())
        .items.map((item) => item.name)
        .sort(),
    ).toEqual(['Nirvor Green Tea', 'Nirvor Office Paper']);
  });
});
```

- **`asShop` runs a query through `ShopDb.read`,** the API's own way in (read-only, `omnivo_public`, the shop's
  workspace). The queries are ones the public API never writes, as a bug might.
- **Permission denied** for the customers and suppliers (`parties`), invoices, the books, a variant's options,
  every column of `products` (`SELECT *` reaches the columns that are not granted), and a stock row's batch. Each is
  42501: the role cannot even name them.
- **No write,** even to the shop's own table: 25006, because the transaction is `READ ONLY` before the missing grant
  is ever checked. Two walls, and the test proves the first.
- **What the role sees in Acme's shop:** 2 listings (not the draft), 2 variants (the listed ones, not the draft's or
  the paper's), 1 stock row (the tea's in the shop's warehouse, not the soap's in the factory). These three numbers
  are the restrictive policies of 0064.
- **Straight in the database**, as the superuser who becomes `omnivo_public`: no workspace set, nothing at all; with
  Nirvor's workspace, its one listing (so the zero before is the wall, not a query that finds nothing); with Acme's
  workspace but Acme's shop closed, nothing, even counting pages and variants (a bug that set the workspace still
  finds nothing in a closed shop); and the lookup function answers Acme's id. The closing is undone in `finally`.
- **The pool is clean afterwards.** A public request that failed in the middle, then six good ones, then eight
  queries on the API's own `Db` at once (so they take different connections): every one is `omnivo_app` with no
  `app.tenant_id`. `SET LOCAL ROLE` and `set_config(…, true)` end with the transaction; if either outlived it, the
  next ERP request on that connection would run as the shop or in the wrong workspace.
- **The ERP sees every product,** the listed tea and the unlisted paper. This is the `INHERIT FALSE` of 0064: with
  `INHERIT TRUE` the restrictive policies would hold for `omnivo_app` too, and the ERP would lose every product
  that is not in the shop.

### The config: `apps/api/src/config.spec.ts`

```ts
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

// Step 26f: the shop's settings in the API's config. Every other value is the same as in
// testConfig (testing/app.ts); only the ones under test change.
function env(extra: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://omnivo_app:app@localhost:5432/omnivo',
    REDIS_URL: 'redis://localhost:6379',
    API_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:5173',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-at-least-32-bytes',
    JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-bytes',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY_ID: 'omnivo',
    S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
    ...extra,
  };
}

describe('storefront config', () => {
  it('serves the photos from the storage bucket in dev, on localhost', () => {
    const { storefront } = loadConfig(env({}));
    expect(storefront).toEqual({
      baseDomain: 'localhost',
      mediaUrl: 'http://localhost:9000/omnivo',
    });
  });

  it('takes the public address and the base domain, without a slash at the end', () => {
    const { storefront } = loadConfig(
      env({
        NODE_ENV: 'production',
        SHOP_BASE_DOMAIN: 'omnivo.shop',
        STOREFRONT_MEDIA_URL: 'https://media.omnivo.shop/',
      }),
    );
    expect(storefront).toEqual({
      baseDomain: 'omnivo.shop',
      mediaUrl: 'https://media.omnivo.shop',
    });
  });

  // The contract takes http only on this computer, so a production API with an http address would
  // answer every shop page with a broken contract. It refuses to start instead, and says why
  it('refuses to start in production with photos on plain http', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'production' }))).toThrow(/https address/);
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', STOREFRONT_MEDIA_URL: 'http://media.omnivo.shop' })),
    ).toThrow(/STOREFRONT_MEDIA_URL/);
  });

  it('refuses a base domain that is not one lower-case DNS name', () => {
    for (const domain of ['Omnivo.shop', 'omnivo.shop:4331', '.omnivo.shop', 'omnivo.shop.']) {
      expect(() => loadConfig(env({ SHOP_BASE_DOMAIN: domain })), domain).toThrow(
        /Invalid environment/,
      );
    }
  });
});
```

- **The dev default** is the storage's own address and bucket, so MinIO serves the photos with no new setting.
- **Production with an http address refuses to start,** with or without `STOREFRONT_MEDIA_URL`, and the message
  names the variable to set (26f.3's decision 22). A `/` at the end is dropped, so `media.ts` never writes `//`.
- **The base domain** must be one lower-case DNS name: a capital, a port, or a dot at either end would make every
  host fail `subdomainOf` and every shop a 404, so the API refuses it at startup instead.

### Check this part

```sh
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
cd apps/api
npx vitest run src/storefront/public-storefront.int.spec.ts src/storefront/storefront.tenant-leak.int.spec.ts --maxWorkers=2
cd ../..
pnpm exec eslint apps/api/src/storefront apps/api/src/testing/storefront.ts apps/api/src/config.spec.ts
pnpm exec prettier --check apps/api/src/storefront apps/api/src/testing/storefront.ts apps/api/src/config.spec.ts
```

The unit tests are 175 (171 of 26f.3 and the 4 config tests); the two integration files have 17 and 9 tests, all
passing, in about 10 seconds on Testcontainers.

Broken on purpose, one at a time, each caught by the named test:

- `trunc` in place of `round` for a percent sale: "works out the same price in SQL as on the card"
  (৳224.96 against ৳224.95).
- no `v.archived_at IS NULL` in the subquery: "hides a draft, an archived variant and a variant with no price".
- `SET ROLE` in place of `SET LOCAL ROLE`: "leaves the pooled connections as omnivo_app", and the ERP test after
  it.
- no `storefront_public_published` policy: "sees only the published listings…" (3 listings instead of 2).
- the stock policy without its warehouse rule: the same test (2 stock rows instead of 1).
- `WITH INHERIT TRUE`: the whole file fails in `beforeAll`, because the ERP cannot even create its products.

While writing the tests, three of their own mistakes came up and were fixed in the test, not the code: the price
filter takes whole taka (the first draft filtered on ৳224.95), the quote's `zoneId` and `couponCode` are left out
rather than sent as `null`, and amounts come back with four decimals (`0.0000`). One weak test was found too: the
first "only published listings" check ran in Nirvor's shop, which has no draft, so removing the policy did not fail
it. It now runs in Acme's shop.

## 26f.5 — The shop reads the API

Until now the shop drew the mock shop on every address. This part gives it a second data source that reads
`/public/v1` for the shop the request's host names, and picks one of the two from the environment. The mock stays
the default: `pnpm dev`, the Playwright tests and the staging demo need nothing new. Every page and route changes
in one way only: it takes its source from `Astro.locals` instead of importing it.

What the source answers from where:

| `ShopSource` method | Mock | API source |
|---|---|---|
| `shop`, `categories`, `home`, `listings`, `product`, `textPage`, `checkoutSettings` | mock data | `GET /public/v1/…`, kept 30 s |
| `quote` | mock rules | `POST /public/v1/cart/quote`, never kept |
| `placeOrder` | mock book, mock quote | the host's own mock book, the API's quote |
| `codeWait`, `verifyCode`, `resendCode`, `order`, `tracking`, `track` | mock book | the host's own mock book |

### The words for a host with no shop

```diff
@@ -304,6 +304,13 @@ export const shopEn = {
     text: 'The link may have a typo, or the page has moved. Start again from the home page.',
     action: 'Go to the home page',
   },
+  // Step 26f.5: an address that is no launched shop (a typo in the subdomain, or a shop not open
+  // yet). No shop's name, colors or menu: there is no shop to take them from
+  noShop: {
+    pageTitle: 'No shop here',
+    title: 'No shop has this address',
+    text: 'Check the address for a typo. A shop that is still being set up opens here once it is launched.',
+  },
   footer: {
     pages: 'Shop pages',
     social: '{{shop}} on social media',
```
```diff
@@ -261,6 +261,11 @@ export const shopBn: ShopMessages = {
     text: 'লিংকে হয়তো ভুল আছে, অথবা পেজটি সরানো হয়েছে। হোম পেজ থেকে আবার শুরু করুন।',
     action: 'হোম পেজে যান',
   },
+  noShop: {
+    pageTitle: 'এখানে কোনো দোকান নেই',
+    title: 'এই ঠিকানায় কোনো দোকান নেই',
+    text: 'ঠিকানায় কোনো ভুল আছে কি না দেখুন। যে দোকান এখনো তৈরি হচ্ছে, সেটা চালু হলে এখানেই খুলবে।',
+  },
   footer: {
     pages: 'দোকানের পেজ',
     social: 'সোশ্যাল মিডিয়ায় {{shop}}',
```

Three words for decision 41. The text says what to check (a typo) and what is normal (a shop being set up opens
later), without blaming anyone. Rebuild i18n (`pnpm --filter @omnivo/i18n build`): the shop reads it from `dist/`.

### The two settings: `apps/shop/astro.config.ts`

```diff
@@ -1,7 +1,7 @@
 import node from '@astrojs/node';
 import react from '@astrojs/react';
 import tailwindcss from '@tailwindcss/vite';
-import { defineConfig } from 'astro/config';
+import { defineConfig, envField } from 'astro/config';
 
 // Step 26b: every page is made per request on a Node server. The real source (step 26's public
 // API) answers for the shop the request's Host names, so a page built ahead of time would show one
@@ -36,4 +36,21 @@ export default defineConfig({
   // one the visitor sent
   security: { allowedDomains: [{}] },
   build: { format: 'file' },
+  // Step 26f.5: where the data comes from (src/data/config.ts). "secret" is Astro's word for "read
+  // when the server runs, never written into the build": a public server value would be fixed when
+  // the image is built, and staging could not switch the same image to the API. Neither is a
+  // secret in the usual sense, and neither reaches a browser (context: 'server'). A wrong value
+  // (SHOP_SOURCE=apii) fails the first request with Astro's message naming the variable: the
+  // node server loads the middleware, which reads them, only when a request comes
+  env: {
+    schema: {
+      SHOP_SOURCE: envField.enum({
+        context: 'server',
+        access: 'secret',
+        values: ['mock', 'api'],
+        default: 'mock',
+      }),
+      SHOP_API_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
+    },
+  },
 });
```

- `envField` declares the two variables, so `astro:env/server` exports them with their types: `SHOP_SOURCE` is
  `'mock' | 'api'` (never `undefined`, because of the default) and `SHOP_API_URL` is `string | undefined`.
- `access: 'secret'` is decision 46: the value is read when the server runs. With `'public'` Astro writes the value
  into the built server, and the same image could never switch.
- A wrong value (`SHOP_SOURCE=apii`) fails the first request with Astro's own message naming the variable. It does
  not fail at start: the Node server loads the middleware, which reads the variables, only when a request comes.
  (Astro's `validateSecrets` option was tried and changes nothing here, so it is left out.)

`.env.example` says how to try the API source in dev:

```diff
@@ -32,6 +32,11 @@ S3_SECRET_ACCESS_KEY=omnivo-dev-secret
 # left out, it is S3_ENDPOINT/S3_BUCKET (right for MinIO). Production needs an https address
 SHOP_BASE_DOMAIN=localhost
 # STOREFRONT_MEDIA_URL=https://media.omnivo.shop
+# Step 26f.5: the shop's server (apps/shop) reads these two, not the API. Left out, it shows the
+# mock shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
+# pnpm --filter @omnivo/shop dev, then open http://<subdomain>.localhost:4321
+# SHOP_SOURCE=api
+# SHOP_API_URL=http://localhost:3000
 
 # Email — only the worker sends it (invitations, welcome). Dev: docker-compose's Mailpit; every
 # email lands at http://localhost:8025
```

### The rules for the two settings: `apps/shop/src/data/config.ts`

```ts
// Step 26f.5: where the shop gets its data, from two settings (astro.config.ts declares them):
// - SHOP_SOURCE: 'mock' (the default: `pnpm dev`, the e2e tests and the staging demo) or 'api'
// - SHOP_API_URL: the ERP API's address as the shop's server reaches it ("http://api:3000" inside
//   the deploy's network). Only read with SHOP_SOURCE=api
// A plain function of the two values, so the tests check the rules without Astro's env module.
export type ShopConfig = { source: 'mock' } | { source: 'api'; apiUrl: string };

export function shopConfigOf(source: 'mock' | 'api', apiUrl: string | undefined): ShopConfig {
  if (source === 'mock') return { source };
  // Without an address every page would fail with "fetch failed" and nothing to say why. The
  // first request fails here instead, with the setting to fix in the message
  if (apiUrl === undefined || apiUrl === '') {
    throw new Error('SHOP_SOURCE=api needs SHOP_API_URL (the ERP API, such as http://api:3000)');
  }
  // http is fine: the shop's server calls the API inside the deploy's own network, never across
  // the internet. Anything else (a typo such as "api:3000" reads as the scheme "api:") is refused
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`SHOP_API_URL is not an address: ${apiUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SHOP_API_URL must start with http:// or https://, not ${url.protocol}`);
  }
  // A path is kept ("https://erp.example.com/api" behind a proxy); the "/" at its end is dropped,
  // so a route's "/public/v1/…" never makes "//"
  return { source, apiUrl: url.href.replace(/\/+$/, '') };
}
```

- A plain function of two values, not of `astro:env`: Vitest cannot load Astro's virtual modules, and the rules
  are worth a test.
- `SHOP_SOURCE=api` without an address throws with the name of the setting to fix. Without the check, every page
  would fail with "fetch failed".
- `new URL('api:3000')` does not throw: it reads `api:` as a scheme. So the scheme is checked on its own, and a
  string that is not an address at all gets its own message.
- The `/` at the end is dropped, because every route path starts with `/` and `//public/v1` is a different path.

### The cache: `apps/shop/src/data/api/answer-cache.ts`

```ts
// Step 26f.5 (decision 24): the shop's server keeps the API's answers for a short time. The API
// says no-store, because a cache in front of it would key an answer by its address and could hand
// one shop's page to another. This cache is inside the shop's server and keys every answer by the
// shop's host too, so it cannot.

// What is kept: the status and the body as JSON, before the contract's parse. The client parses
// each time it reads, so one cache holds every route's answer without a cast to each one's type
export interface ApiAnswer {
  status: number;
  body: unknown;
}

export interface AnswerCache {
  // The kept answer for this key, or the one `load` fetches. Callers that ask for the same key
  // while it is on the way share the one request
  read(key: string, load: () => Promise<ApiAnswer>): Promise<ApiAnswer>;
  readonly size: number;
}

interface Entry {
  expiresAt: number;
  answer: Promise<ApiAnswer>;
}

export function createAnswerCache({
  ttlMs,
  maxEntries,
  now = () => Date.now(),
}: {
  ttlMs: number;
  maxEntries: number;
  // For the tests, which move time
  now?: () => number;
}): AnswerCache {
  // A Map keeps the order keys went in, so its first key is the oldest. Dropping that one when the
  // map is full is enough here: every entry ends after ttlMs anyway
  const entries = new Map<string, Entry>();

  // Only the entry that failed: a newer one for the same key (asked after this one ended) stays
  function forget(key: string, entry: Entry) {
    if (entries.get(key) === entry) entries.delete(key);
  }

  return {
    read(key, load) {
      const at = now();
      const kept = entries.get(key);
      if (kept !== undefined && kept.expiresAt > at) return kept.answer;
      // Deleted before the set below, so the key moves to the end of the order (the newest)
      entries.delete(key);

      const entry: Entry = { expiresAt: at + ttlMs, answer: load() };
      entries.set(key, entry);
      // The map's size is the only thing that grows with traffic. A crawler walking every filter
      // of every shop makes new keys all day; without the limit they would fill the memory
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }

      // A failure is never kept: no answer at all (the API down, a timeout) or a 5xx. The next
      // page asks again instead of showing the error for 30 seconds. A 4xx is an answer ("no such
      // product") and is kept like a 200, so a wrong link asked again and again costs one request.
      // `void`: the caller awaits the same promise and handles its rejection; this branch only
      // tidies up, and its own rejection handler stops an "unhandled rejection"
      void entry.answer.then(
        (answer) => {
          if (answer.status >= 500) forget(key, entry);
        },
        () => {
          forget(key, entry);
        },
      );
      return entry.answer;
    },
    get size() {
      return entries.size;
    },
  };
}
```

- **It keeps the raw answer** (status + JSON body), not the parsed value. One cache holds every route's answer, and
  the client parses it on each read with that route's schema (decision 43). Keeping parsed values would need a cast
  from `unknown` to each route's type.
- **It keeps the promise,** not the finished answer. Two pages that ask for the same key at the same moment share
  one request: after a deploy, the first second of traffic would otherwise send every page's calls at once.
- **`delete` before `set`:** a `Map` keeps the order keys went in, so moving a key to the end keeps the first key
  the oldest. That is the one dropped when the map is over `maxEntries`. A crawler that walks every filter of every
  shop makes new keys all day; the limit is what keeps the memory flat.
- **A failure is forgotten when it fails** (decision 42). `forget` removes the entry only if it is still the same
  object: a slow request that fails after its 30 seconds must not remove the newer answer that replaced it.
- **`void entry.answer.then(…, …)`:** the caller awaits the same promise and sees its error. This second branch only
  tidies up, and its own rejection handler is what stops Node's "unhandled rejection" warning.

### The client: `apps/shop/src/data/api/shop-api.ts`

```ts
import {
  buildPath,
  type ErrorCode,
  isErrorCode,
  problemSchema,
  type RouteDef,
  SHOP_HOST_HEADER,
} from '@omnivo/contracts';
import type { z } from 'zod';

import type { AnswerCache, ApiAnswer } from './answer-cache';

// Step 26f.5: how the shop's server calls the ERP's public API (/public/v1) for one shop. Server
// only: it runs in the pages' frontmatter and the API routes, never in a browser script.

// The API did not answer the question: it is down, too slow, failed (5xx), or sent a body that
// breaks the contract. The page fails (Astro's 500), and the next request asks again: none of
// these answers is kept (answer-cache.ts)
export class ShopApiError extends Error {
  // 0: no answer reached the shop's server at all
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ShopApiError';
    this.status = status;
  }
}

// The host is not a launched shop (404 storefront_not_found). Its own class, because the answer
// is the same for every route: the middleware draws "No shop has this address" (src/middleware.ts)
export class ShopMissingError extends Error {
  constructor(host: string) {
    super(`No launched shop has the host ${host}`);
    this.name = 'ShopMissingError';
  }
}

// What a route may answer: its value, or a refusal the caller decides about ("no such product"
// is a normal answer for product(), a mistake for shop()). `code` is null for a code this shop
// does not know, from an API newer than the shop
export type ShopApiResult<T> =
  { ok: true; value: T } | { ok: false; status: number; code: ErrorCode | null };

// The query as the API reads it: every value a string, the ones not set left out
type Query = Record<string, string | undefined>;

export interface ShopApi {
  get<S extends z.ZodType>(
    route: RouteDef & { method: 'GET'; response: S },
    input?: { params?: Record<string, string>; query?: Query },
  ): Promise<ShopApiResult<z.output<S>>>;
  post<S extends z.ZodType, B extends z.ZodType>(
    route: RouteDef & { method: 'POST'; response: S; body: B },
    body: z.input<B>,
  ): Promise<ShopApiResult<z.output<S>>>;
}

export interface ShopApiOptions {
  apiUrl: string;
  // The shop's host, as the shopper's browser asked for it (acme.omnivosoft.com)
  host: string;
  cache: AnswerCache;
  // How long a page waits for the API. Long enough for a slow query, short enough that a shopper
  // sees an error page instead of a browser that spins forever
  timeoutMs?: number;
  // For the tests, which answer without a network
  fetch?: typeof fetch;
}

export function createShopApi({
  apiUrl,
  host,
  cache,
  timeoutMs = 8_000,
  fetch: send = fetch,
}: ShopApiOptions): ShopApi {
  // One request, read to the end: the status and the JSON body (null when it is not JSON, such as
  // a proxy's own HTML error page). A network failure or the timeout is a ShopApiError
  async function ask(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiAnswer> {
    const headers = new Headers({ accept: 'application/json', [SHOP_HOST_HEADER]: host });
    if (body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await send(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ShopApiError(0, `${method} ${path} for ${host} got no answer: ${String(error)}`);
    }
    const json: unknown = await response.json().catch(() => null);
    return { status: response.status, body: json };
  }

  // The answer as the route's value, or a refusal. A 2xx body is parsed with the route's own
  // schema, so a page gets exactly the contract's type, and an API that broke the contract is
  // found here rather than as "undefined" deep in a component
  function readAnswer<S extends z.ZodType>(
    route: RouteDef & { response: S },
    path: string,
    answer: ApiAnswer,
  ): ShopApiResult<z.output<S>> {
    if (answer.status >= 200 && answer.status < 300) {
      const parsed = route.response.safeParse(answer.body);
      if (!parsed.success) {
        throw new ShopApiError(answer.status, `${route.method} ${path} broke its contract`);
      }
      return { ok: true, value: parsed.data };
    }
    const problem = problemSchema.safeParse(answer.body);
    // A 5xx, or a refusal with no problem body (a proxy's page): the API did not answer
    if (answer.status >= 500 || !problem.success) {
      throw new ShopApiError(
        answer.status,
        `${route.method} ${path} failed (${String(answer.status)})`,
      );
    }
    if (problem.data.code === 'storefront_not_found') throw new ShopMissingError(host);
    return {
      ok: false,
      status: answer.status,
      code: isErrorCode(problem.data.code) ? problem.data.code : null,
    };
  }

  return {
    async get(route, input = {}) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) search.set(key, value);
      }
      const query = search.size === 0 ? '' : `?${search.toString()}`;
      const path = `${buildPath(route.path, input.params)}${query}`;
      // The host is part of the key (decision 24): two shops ask for the same "/public/v1/home"
      const answer = await cache.read(`${host} ${path}`, () => ask('GET', path));
      return readAnswer(route, path, answer);
    },
    async post(route, body) {
      // Never kept: a POST asks about one cart, and its answer is today's prices
      const path = buildPath(route.path);
      return readAnswer(route, path, await ask('POST', path, body));
    },
  };
}
```

- **Two error classes.** `ShopApiError` is "the API did not answer" (status 0 for no answer at all, a 5xx, a body
  that breaks the contract): the page fails with Astro's 500, and nothing of it is kept. `ShopMissingError` is "no
  such shop", the same for every route, so the middleware can catch it by class (decision 41).
- **`ShopApiResult`:** any other refusal comes back as a value, because only the caller knows what it means. "No
  such product" is normal for `product()`; for `shop()` it would be a bug. `code` goes through `isErrorCode`, so the
  callers compare with `ErrorCode` literals (a typo in `'not_found'` fails the type check), and a code from a newer
  API is `null`, not a crash.
- **The `get` and `post` types** take the route object from the contracts, so the params, the body and the answer
  all come from one `defineRoute`. `RouteDef & { method: 'GET' }` stops a POST route from being passed to `get`.
- **`ask`** sends `X-Shop-Host` (decision 12) and nothing that names the shopper. `AbortSignal.timeout` is decision
  47; when it fires, `fetch` rejects, and the shopper gets the error page. `response.json().catch(() => null)`:
  a proxy's HTML error page is not JSON, and the 502 must still reach `readAnswer`, which throws for it.
- **The cache key is the host, a space, then the path with its query.** A space can never be in a host or a path,
  so two keys cannot run together. The query is written in the order `listingParamsFromQuery` builds it, which is
  fixed, so one list is one key.
- **`post` never uses the cache.** A quote is one cart's prices today.

### The source: `apps/shop/src/data/api/api-source.ts`

```ts
import {
  listingParamsFromQuery,
  publicStorefrontRoutes as routes,
  type ShopCartQuoteRequest,
} from '@omnivo/contracts';

import { MOCK_CODE, type MockOrderBook } from '../mock/orders';
import type { ShopSource } from '../types';
import { ShopApiError, type ShopApi, type ShopApiResult } from './shop-api';

// Step 26f.5: the shop's data from the ERP's public API, for the one shop the ShopApi asks for.
// Browsing and the cart's prices come from the API. Orders, the phone code and tracking have no
// API until step 27 (decision 1), so they stay in a mock order book, one per shop (26f.5's
// decision b), priced with the API's quote.

// A refusal where the page has no use for one: shop() refused is not "no shop" (that is a
// ShopMissingError already), it is an API that breaks its own contract
function must<T>(result: ShopApiResult<T>, what: string): T {
  if (result.ok) return result.value;
  throw new ShopApiError(result.status, `${what} was refused (${result.code ?? 'unknown code'})`);
}

// `orders` is called only when an order is placed or looked up, so a shop nobody orders from never
// gets a book (data/source.ts keeps one per host)
export function createApiSource(api: ShopApi, orders: () => MockOrderBook): ShopSource {
  // Only what the quote asks: the lines, the zone and the coupon. An order request also carries
  // the shopper's name, phone and address, and those have no reason to reach the API (or its
  // logs) before step 27 stores orders
  async function quote(request: ShopCartQuoteRequest) {
    const body: ShopCartQuoteRequest = { lines: request.lines };
    if (request.zoneId !== undefined) body.zoneId = request.zoneId;
    if (request.couponCode !== undefined) body.couponCode = request.couponCode;
    return must(await api.post(routes.quote, body), 'cart quote');
  }

  async function checkoutSettings() {
    return must(await api.get(routes.checkoutSettings), 'checkout settings');
  }

  return {
    shop: async () => must(await api.get(routes.shop), 'shop'),
    categories: async () => must(await api.get(routes.categories), 'categories'),
    home: async () => must(await api.get(routes.home), 'home'),

    async product(slug) {
      // An address the ERP could never have made ("Neem", "a b") is not asked for: it can only be
      // a typo, and the API would refuse it with 400, which is not "no such product"
      if (!routes.product.params.shape.slug.safeParse(slug).success) return null;
      const result = await api.get(routes.product, { params: { slug } });
      if (!result.ok && result.code === 'not_found') return null;
      return must(result, 'product');
    },

    quote,

    async listings(query) {
      // Only what is set (decision 13), so the first page of /c/all is one cache entry for every
      // shopper
      const result = await api.get(routes.listings, { query: listingParamsFromQuery(query) });
      // A cursor the API did not make, or made for another sort: the page starts again from the
      // first page (ShopSource.listings)
      if (!result.ok && result.code === 'invalid_cursor') return null;
      return must(result, 'listings');
    },

    checkoutSettings,

    // The order is priced again here, by the API, from its own lines, zone and coupon, never from
    // what the browser says it costs (26c's decision 10). The book only decides whether the order
    // may be placed with that price, as it does for the mock
    async placeOrder(request) {
      const [priced, settings] = await Promise.all([quote(request), checkoutSettings()]);
      return orders().place(request, priced, settings);
    },
    codeWait: (token) => Promise.resolve(orders().codeWait(token)),
    verifyCode: (token, code) => Promise.resolve(orders().verify(token, code)),
    resendCode: (token) => Promise.resolve(orders().resend(token)),
    order: (orderNo, token) => Promise.resolve(orders().find(orderNo, token)),
    // No SMS is sent before step 27, so the verify page shows the code, as the mock's does. The
    // orders are not real yet either: nothing reaches the ERP
    testCode: MOCK_CODE,

    tracking: (token) => Promise.resolve(orders().trackByLink(token)),
    track: (request) => Promise.resolve(orders().track(request)),
    async textPage(slug) {
      const result = await api.get(routes.textPage, { params: { slug } });
      if (!result.ok && result.code === 'not_found') return null;
      return must(result, 'text page');
    },
    // A real shop has no demo orders: their numbers and links would lead nowhere
    testTracking: null,
  };
}
```

- **`must()`** turns a refusal the page has no use for into a `ShopApiError`, with the code in the message for the
  logs. `shop()`, `categories()` and `home()` use it as they are.
- **`quote()` builds its own body** (decision 44). `exactOptionalPropertyTypes` is on, so a key that is not set is
  left out, never sent as `undefined`; the API's schema takes them as optional, not nullable (26f.4 found that).
- **`product()`** checks the slug with the route's own params schema first (decision 45). Using
  `routes.product.params.shape.slug` keeps the rule in one place: if the ERP's slug rule changes, the shop follows.
- **`listings()`** turns `invalid_cursor` into `null`, which `loadListing` already treats as "start again from the
  first page" (26d).
- **`placeOrder()`** asks the quote and the settings at the same time, then lets the book decide, as the mock does
  (decision 40). The book refuses when the total differs from `expectedTotal`, so a price changed in the ERP after
  the checkout drew it is caught here.
- **`orders` is a function,** called only when an order is placed or looked up. A shop that nobody orders from never
  gets a book.

### Which source: `apps/shop/src/data/source.ts`

```diff
@@ -1,8 +1,48 @@
+import { SHOP_API_URL, SHOP_SOURCE } from 'astro:env/server';
+
+import { createAnswerCache } from './api/answer-cache';
+import { createApiSource } from './api/api-source';
+import { createShopApi } from './api/shop-api';
+import { shopConfigOf } from './config';
+import { createOrderBook, type MockOrderBook } from './mock/orders';
 import { mockSource } from './mock/mock-source';
 import type { ShopSource } from './types';
 
-// Step 26a: the only door the pages use to get data. Today it is the mock; step 26b adds a source
-// that reads the public API (/public/v1) for the shop the request's Host names, and this file picks
-// it. No page or component imports the mock directly (src/boundaries.spec.ts), so swapping the
-// source cannot leave one page on fake data.
-export const shopSource: ShopSource = mockSource;
+// Step 26a: the only door to the shop's data. No page or component imports the mock directly
+// (src/boundaries.spec.ts), so swapping the source cannot leave one page on fake data.
+// Step 26f.5: the door is per request. The real source answers for the shop the request's host
+// names, so src/middleware.ts asks sourceFor() once per request and puts the answer in
+// Astro.locals.source, which every page and route reads.
+
+// Read once, when the server starts. astro:env reads both at run time ("secret" in
+// astro.config.ts), so one built image serves the mock or the API by its environment
+const config = shopConfigOf(SHOP_SOURCE, SHOP_API_URL);
+
+// One cache for the whole server, every shop's answers in it, keyed by host (decision 24):
+// 30 seconds, so a price changed in the ERP shows within half a minute, and at most 1,000 answers
+const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 1_000 });
+
+// 26f.5's decision b: each shop's orders in its own book, so one shop's W-000001 is never another
+// shop's. Made at the first order, and only for a launched shop: the middleware stops every other
+// host before a page runs. They live as long as the process, as the mock's do
+const books = new Map<string, MockOrderBook>();
+
+function bookFor(host: string): MockOrderBook {
+  let book = books.get(host);
+  if (book === undefined) {
+    book = createOrderBook();
+    books.set(host, book);
+  }
+  return book;
+}
+
+export function sourceFor(url: URL): ShopSource {
+  if (config.source === 'mock') return mockSource;
+  // The host without its port: the API strips it too, and "acme.localhost:4331" and
+  // "acme.localhost" are one shop. URL has made it lower case already. Behind the proxy this is the
+  // shopper's host, not the proxy's (security.allowedDomains in astro.config.ts)
+  const host = url.hostname;
+  return createApiSource(createShopApi({ apiUrl: config.apiUrl, host, cache }), () =>
+    bookFor(host),
+  );
+}
```

- **`config` is read once,** when the module loads. The cache and the books are module variables too: they must
  outlive one request. Only the source object is made per request, and it is cheap (two closures).
- **The host is `url.hostname`:** no port, lower case (the `URL` parser does both). The API strips the port as
  well, so `acme.localhost:4331` and `acme.localhost` are one shop, one cache entry and one order book. Behind the
  proxy this is the shopper's host, because `security.allowedDomains` (26e) tells Astro to trust
  `X-Forwarded-Host`.
- **`books` grows only with launched shops.** The middleware stops every other host before a page runs, and no
  route reaches `bookFor` without a page or a quote that already found the shop.

### The middleware: `apps/shop/src/middleware.ts`

```ts
import { defineMiddleware } from 'astro:middleware';

import { ShopMissingError } from './data/api/shop-api';
import { sourceFor } from './data/source';
import { problemResponse } from './server/problem';

// Step 26f.5: runs before every page and API route. It gives the request its data source (the one
// for the shop its host names), and stops a host that is no launched shop before any page runs,
// because every page draws the shop's header and footer and would fail without a shop.
export const onRequest = defineMiddleware(async (context, next) => {
  const source = sourceFor(context.url);
  context.locals.source = source;

  try {
    // The page asks for the shop again; the API source's cache answers that one, and the mock
    // answers at once, so the check costs one request per host every 30 seconds
    await source.shop();
    context.locals.shopMissing = false;
  } catch (error) {
    // Any other failure (the API down) is the page's normal 500: only "no such shop" is answered
    // here
    if (!(error instanceof ShopMissingError)) throw error;
    context.locals.shopMissing = true;
    // A script (the cart drawer, the checkout) reads problem JSON, like every other refusal
    if (context.url.pathname.startsWith('/api/')) {
      return problemResponse(404, 'storefront_not_found', 'No shop has this address.');
    }
    // 26f.5's decision c: the 404 page, without a shop's frame (pages/404.astro). A rewrite, not a
    // redirect: the address stays the one the shopper typed, and Astro answers its 404 page with
    // the 404 status, so a search engine keeps nothing. A rewrite from `next()` does not run this
    // middleware again, so it cannot loop
    return next('/404');
  }
  return next();
});
```

- Astro runs `onRequest` before every page and every API route, never for the files in `public/` or the built
  `/_astro/` files, which the Node server sends before Astro.
- **It asks for the shop first.** Every page draws the shop's header and footer, so a page of no shop can only fail.
  The answer is kept 30 seconds and the page's own `source.shop()` gets it from the cache, so the check costs one
  API request per host every 30 seconds. The mock answers at once.
- **Only `ShopMissingError` is handled here.** Any other failure goes on to Astro's 500 page, as before.
- **`next('/404')` rewrites, it does not redirect.** The address bar keeps what the shopper typed, and Astro answers
  its 404 page with the 404 status. A rewrite from `next()` does not run the middleware again, so it cannot loop.
  Both were checked on the built server (see "Check this part"): the first draft also set the status by hand and
  guarded `/404` against a loop, and neither was needed.

### The types of `Astro.locals`: `apps/shop/src/env.d.ts`

```ts
import type { ShopSource } from './data/types';

// Step 26f.5: what src/middleware.ts gives every page and route, as Astro.locals (or `locals` in an
// API route). Astro's own types read the global App namespace; without this, Astro.locals.source
// would not type-check. `declare global` because the import makes this file a module, and a
// namespace declared in a module would be the module's own, which Astro never sees
declare global {
  namespace App {
    interface Locals {
      // The data source for the shop this request's host names
      source: ShopSource;
      // True when the host is no launched shop: the middleware has drawn the 404 page in the
      // page's place (pages/404.astro), and that page must not ask the source for a shop it does
      // not have
      shopMissing: boolean;
    }
  }
}
```

Astro types `Astro.locals` as the global `App.Locals`. The file imports `ShopSource`, which makes it a module, so the
namespace must be inside `declare global`; a namespace declared in a module would be the module's own, and
`Astro.locals.source` would not type-check. (ESLint refuses the shorter `import('./data/types').ShopSource` form.)

### The no-shop page

```
---
import '../styles/shop.css';

import { StoreRemove01Icon } from '@hugeicons/core-free-icons';

import { shopLocale } from '../lib/locale';
import EmptyState from './EmptyState.astro';

// Step 26f.5 (decision c): the whole page for a host that is no launched shop. A document of its
// own, not ShopLayout: the layout draws a shop's name, colors, menu and footer, and there is no
// shop to take them from. The stylesheet's default colors (Omnivo's teal and lime) stand in for a
// shop's theme. English, because no shop says which language it speaks. No link either: the
// shopper's way back is the address bar, and a link to "/" would land on this page again
const locale = await shopLocale('en');
const { t } = locale;
---

<!doctype html>
<html lang={locale.language}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    {/* An address with no shop has nothing a search engine should keep */}
    <meta name="robots" content="noindex" />
    <title>{t('shop.noShop.pageTitle')}</title>
  </head>
  <body>
    <main class="shop-container pt-4 md:pt-9">
      <EmptyState
        icon={StoreRemove01Icon}
        level="h1"
        title={t('shop.noShop.title')}
        text={t('shop.noShop.text')}
      />
    </main>
  </body>
</html>
```

- A whole document of its own, not `ShopLayout`: the layout needs a `PublicShop` for its name, colors, menu and
  footer, and there is none. The stylesheet's defaults (`--brand`, `--accent` in `shop.css`) stand in for a theme.
- English, because no shop says which language to speak.
- `noindex` next to the 404 status: an address with no shop has nothing a search engine should keep, and the tag
  says so even to a crawler that reads the page and not the status.
- No action button. The `EmptyState` card's only link would be `/`, which is the same page again.

```diff
@@ -2,7 +2,7 @@
 import { FileNotFoundIcon } from '@hugeicons/core-free-icons';
 
 import EmptyState from '../components/EmptyState.astro';
-import { shopSource } from '../data/source';
+import NoShopPage from '../components/NoShopPage.astro';
 import ShopLayout from '../layouts/ShopLayout.astro';
 import { shopLocale } from '../lib/locale';
 
@@ -12,25 +12,36 @@ import { shopLocale } from '../lib/locale';
 // who followed an old link can search or open a category from here. Made per request like every
 // page (astro.config.ts), because it needs the shop of the request's domain. Astro answers it
 // with the 404 status in both cases, so a search engine drops the old address.
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
-const locale = await shopLocale(shop.language);
-const { t } = locale;
+// Step 26f.5: also the page of a host that is no launched shop (src/middleware.ts rewrites every
+// address of it here). The source is not asked then: it has no shop to answer with, so `page` is
+// null and the template draws NoShopPage. The status is still 404, as for any rewrite to this page
+async function load() {
+  const { source } = Astro.locals;
+  const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
+  return { shop, categories, locale: await shopLocale(shop.language) };
+}
+
+const page = Astro.locals.shopMissing ? null : await load();
 ---
 
-<ShopLayout
-  shop={shop}
-  locale={locale}
-  title={t('shop.notFound.pageTitle', { shop: shop.name })}
-  categories={categories}
->
-  {/* The checkout card's distance from the header and to the footer */}
-  <div class="mt-4 md:mt-9 md:mb-40">
-    <EmptyState
-      icon={FileNotFoundIcon}
-      level="h1"
-      title={t('shop.notFound.title')}
-      text={t('shop.notFound.text')}
-      action={{ href: '/', label: t('shop.notFound.action') }}
-    />
-  </div>
-</ShopLayout>
+{page === null ? (
+  <NoShopPage />
+) : (
+  <ShopLayout
+    shop={page.shop}
+    locale={page.locale}
+    title={page.locale.t('shop.notFound.pageTitle', { shop: page.shop.name })}
+    categories={page.categories}
+  >
+    {/* The checkout card's distance from the header and to the footer */}
+    <div class="mt-4 md:mt-9 md:mb-40">
+      <EmptyState
+        icon={FileNotFoundIcon}
+        level="h1"
+        title={page.locale.t('shop.notFound.title')}
+        text={page.locale.t('shop.notFound.text')}
+        action={{ href: '/', label: page.locale.t('shop.notFound.action') }}
+      />
+    </div>
+  </ShopLayout>
+)}
```

- `load()` is called only when there is a shop; `page` is `null` otherwise, and TypeScript makes the template check
  it before it reads `page.shop`. A plain `if` with `return` cannot work here: a page's frontmatter can return a
  `Response`, not markup.
- The `t` of the old page is now `page.locale.t`, because the locale exists only when the shop does.

### Every page and route takes the request's source

The same change in each file: the import of `shopSource` goes, and a page reads `const { source } = Astro.locals;`.
An API route takes `locals` from its context. Nothing else changes in them.

```diff
@@ -5,17 +5,19 @@ import ImageBanner from '../components/ImageBanner.astro';
 import LoadMoreLink from '../components/LoadMoreLink.astro';
 import ProductCard from '../components/ProductCard.astro';
 import ProductRow from '../components/ProductRow.astro';
-import { shopSource } from '../data/source';
 import ShopLayout from '../layouts/ShopLayout.astro';
 import { readListingQuery } from '../lib/listing-query';
 import { shopLocale } from '../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26a: the home page (Figma 37:3083 on desktop, 138:234 on the phone)
-const shop = await shopSource.shop();
+const shop = await source.shop();
 const [locale, categories, home] = await Promise.all([
   shopLocale(shop.language),
-  shopSource.categories(),
-  shopSource.home(),
+  source.categories(),
+  source.home(),
 ]);
 const { t } = locale;
 // Step 26d.3: the filter row works from the defaults here, so every chip leads to /c/all
```
```diff
@@ -1,17 +1,19 @@
 ---
 import ListingView from '../../components/ListingView.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { loadListing } from '../../lib/listing-page';
 import { ALL_SLUG } from '../../lib/listing-query';
 import { shopLocale } from '../../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26d.3: a category's products, with those of the categories under it (/c/cosmetics), or
 // every product (/c/all). The address holds the search, the filters, the sort and the page
 // (decision 2); lib/listing-page.ts reads it
 const [shop, load] = await Promise.all([
-  shopSource.shop(),
-  loadListing(Astro.params.slug ?? '', Astro.url.searchParams),
+  source.shop(),
+  loadListing(Astro.params.slug ?? '', Astro.url.searchParams, source),
 ]);
 
 // No category has this slug: Astro's 404 page, with the 404 status, like an unknown product
```
```diff
@@ -1,17 +1,19 @@
 ---
 import ListingGrid from '../../../components/ListingGrid.astro';
-import { shopSource } from '../../../data/source';
 import { loadListing } from '../../../lib/listing-page';
 import { shopLocale } from '../../../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26d.3: the cards Load More's script asks for (decision 3). A partial: only this component's
 // HTML, no <html>, header or footer. The address is the page's own, so the cards are the ones the
 // page's link would show
 export const partial = true;
 
 const [shop, load] = await Promise.all([
-  shopSource.shop(),
-  loadListing(Astro.params.slug ?? '', Astro.url.searchParams),
+  source.shop(),
+  loadListing(Astro.params.slug ?? '', Astro.url.searchParams, source),
 ]);
 
 // No redirect here: fetch() would follow it to the first page and the script would add those
```
```diff
@@ -1,15 +1,17 @@
 ---
 import ListingView from '../components/ListingView.astro';
-import { shopSource } from '../data/source';
 import ShopLayout from '../layouts/ShopLayout.astro';
 import { loadListing } from '../lib/listing-page';
 import { shopLocale } from '../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26d.3: the header's search (/search?q=neem), across every category (decision 8). The words
 // go to the source; the page draws the answer like a category's
 const [shop, load] = await Promise.all([
-  shopSource.shop(),
-  loadListing(null, Astro.url.searchParams),
+  source.shop(),
+  loadListing(null, Astro.url.searchParams, source),
 ]);
 
 // No words (an empty box): /c/all. A cursor the source did not make: the first page. A search has
```
```diff
@@ -1,15 +1,17 @@
 ---
 import ListingGrid from '../../components/ListingGrid.astro';
-import { shopSource } from '../../data/source';
 import { loadListing } from '../../lib/listing-page';
 import { shopLocale } from '../../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26d.3: Load More's cards for the search page, like /c/<slug>/more
 export const partial = true;
 
 const [shop, load] = await Promise.all([
-  shopSource.shop(),
-  loadListing(null, Astro.url.searchParams),
+  source.shop(),
+  loadListing(null, Astro.url.searchParams, source),
 ]);
 
 if (load.kind !== 'found') return new Response(null, { status: 409 });
```
```diff
@@ -2,21 +2,23 @@
 import { numberLocale } from '@omnivo/i18n';
 
 import OrderConfirmedDialog from '../components/OrderConfirmedDialog.astro';
-import { shopSource } from '../data/source';
 import CheckoutForm from '../islands/checkout/CheckoutForm';
 import { checkoutChoices, checkoutWords } from '../islands/checkout/words';
 import ShopLayout from '../layouts/ShopLayout.astro';
 import { shopLocale } from '../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26c: the checkout (Figma checkout_process 37:3765, 1440px). The page draws the frame and
 // the words; the form is a React island (decision 1). The cart is in the shopper's browser, so the
 // server cannot know it: the island is drawn here with "Getting today's prices…" and takes over
 // in the browser (client:load: a checkout is useless until it can price the cart).
 // Step 26d.4: the categories for the header's drawer, asked with the rest
 const [shop, settings, categories] = await Promise.all([
-  shopSource.shop(),
-  shopSource.checkoutSettings(),
-  shopSource.categories(),
+  source.shop(),
+  source.checkoutSettings(),
+  source.categories(),
 ]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
```
```diff
@@ -5,24 +5,26 @@ import { numberLocale } from '@omnivo/i18n';
 import { SHOP_CODE_LENGTH } from '@omnivo/contracts';
 
 import OrderConfirmedDialog from '../../components/OrderConfirmedDialog.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { shopLocale } from '../../lib/locale';
 import { waitText } from '../../lib/verify';
 import { checkoutToken } from '../../server/cookies';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26c: the phone code for a Cash on Delivery order (decision 4; CLAUDE.md → Phone
 // verification, not in Figma). The order is found by the token in the httpOnly checkout cookie,
 // so this page can only ever show the order this browser placed.
 const token = checkoutToken(Astro.request);
-const wait = token === null ? null : await shopSource.codeWait(token);
+const wait = token === null ? null : await source.codeWait(token);
 // No order waits here: never placed, already confirmed (a reload after the dialog), dropped after
 // five wrong codes, or past its hour. The checkout is where a shopper can do something about it,
 // and their cart is still there (decision 23)
 if (wait === null) return Astro.redirect('/checkout');
 
 // Step 26d.4: the categories for the header's drawer
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
+const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 const numbers = numberLocale(locale.language);
@@ -77,9 +79,9 @@ const textLink =
         <div class="flex flex-col gap-3">
           <p class="text-body">{t('shop.verify.sent', { phone: wait.maskedPhone })}</p>
           {/* Only a test shop has a code to show (ShopSource.testCode): the mock sends no SMS */}
-          {shopSource.testCode !== null && (
+          {source.testCode !== null && (
             <p class="rounded-lg bg-canvas px-4 py-3 text-sf-small font-medium text-body">
-              {t('shop.verify.mockCode', { code: shopSource.testCode })}
+              {t('shop.verify.mockCode', { code: source.testCode })}
             </p>
           )}
         </div>
```
```diff
@@ -3,25 +3,27 @@ import { compareMoney } from '@omnivo/contracts';
 import { formatDateTime, formatNumber } from '@omnivo/i18n';
 
 import OrderTimeline from '../../components/OrderTimeline.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { shopLocale } from '../../lib/locale';
 import { spacedPhone } from '../../lib/phone';
 import { orderTokens } from '../../server/cookies';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26c: one order, from "View Order Details" (CLAUDE.md → Order details, not in Figma). Only
 // the browser that placed it may see it (decision 5): the number must be one of the orders cookie's,
 // and the source checks that its token belongs to it.
 const orderNo = Astro.params.no ?? '';
 const token = orderTokens(Astro.request).get(orderNo);
-const order = token === undefined ? null : await shopSource.order(orderNo, token);
+const order = token === undefined ? null : await source.order(orderNo, token);
 
 // Not this browser's order, a number that does not exist, or one still waiting for its code: the
 // same "page not found" for each, so the page never tells a stranger that an order exists
 if (order === null) return Astro.rewrite('/404');
 
 // Step 26d.4: the categories for the header's drawer
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
+const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
 const locale = await shopLocale(shop.language);
 const { t, money } = locale;
 const when = (iso: string) => formatDateTime(new Date(iso), locale.language, shop.timeZone);
```
```diff
@@ -5,19 +5,21 @@ import { shopTrackingTokenSchema } from '@omnivo/contracts';
 import EmptyState from '../../components/EmptyState.astro';
 import PageCard from '../../components/PageCard.astro';
 import TrackingView from '../../components/TrackingView.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { shopLocale } from '../../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26e: a tracking link, as the SMS sends it (decision 1). The token is the key: anyone who has
 // the link sees the page, and the page names no person (decision 12).
 const raw = Astro.params.token ?? '';
 // The shape first (26e.1): a link an SMS app cut in two, or one typed by hand, is answered without
 // asking the source, so the real API never sees a token that cannot be one
 const token = shopTrackingTokenSchema.safeParse(raw);
-const tracking = token.success ? await shopSource.tracking(token.data) : null;
+const tracking = token.success ? await source.tracking(token.data) : null;
 
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
+const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 
```
```diff
@@ -4,7 +4,6 @@ import { HugeiconsIcon } from '@hugeicons/react';
 
 import PageCard from '../components/PageCard.astro';
 import TrackingView from '../components/TrackingView.astro';
-import { shopSource } from '../data/source';
 import ShopLayout from '../layouts/ShopLayout.astro';
 import { shopLocale } from '../lib/locale';
 import { spacedPhone } from '../lib/phone';
@@ -16,13 +15,16 @@ import {
   type TrackFormValues,
 } from '../server/track';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26e: the way back for a shopper who lost the SMS (decision 3; CLAUDE.md → Track order). A
 // GET draws the form. The form POSTs to this same page, so the phone stays in the request's body,
 // and the answer is drawn in place: the tracking view, or the form again with what to fix.
 let answer: TrackFormAnswer | null = null;
 if (Astro.request.method === 'POST') {
   answer = await answerTrackForm(Astro.request, {
-    source: shopSource,
+    source,
     limiter: trackLimiter,
     // The visitor's address, which astro.config.ts → security says to read from the proxy's
     // X-Forwarded-For (26e.2)
@@ -36,7 +38,7 @@ if (Astro.request.method === 'POST') {
   }
 }
 
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
+const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 
@@ -119,11 +121,11 @@ const errorText = (name: keyof TrackFormValues): string | null => {
           <p class="text-body">{t('shop.track.intro')}</p>
           {/* Only a test shop has orders to offer (ShopSource.testTracking): the mock sends no
               SMS, so this is where a tester gets a number, its phone and its link (decision 18) */}
-          {shopSource.testTracking !== null && (
+          {source.testTracking !== null && (
             <div class="flex flex-col gap-2 rounded-lg bg-canvas px-4 py-3 text-sf-small font-medium text-body">
               <p>{t('shop.track.mockOrders')}</p>
               <ul class="flex flex-col gap-1">
-                {shopSource.testTracking.map((demo) => (
+                {source.testTracking.map((demo) => (
                   <li class="flex flex-wrap gap-x-2 tabular-nums">
                     <span>
                       {t('shop.track.mockOrder', {
```
```diff
@@ -2,20 +2,22 @@
 import { formatDate } from '@omnivo/i18n';
 
 import PageCard from '../../components/PageCard.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { shopLocale } from '../../lib/locale';
 import { dayInShop, isTextPageSlug } from '../../lib/text-page';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26e: the footer's four pages (decision 5; CLAUDE.md → Text pages): the checkout card at
 // 848px, the title in its header, the tenant's HTML in the description's prose style.
 const slug = Astro.params.slug;
 // Any other slug, or a page the tenant has not written: "page not found" with the 404 status, so a
 // search engine drops an old link (decision 15). The guard also narrows the slug to the four
-const page = isTextPageSlug(slug) ? await shopSource.textPage(slug) : null;
+const page = isTextPageSlug(slug) ? await source.textPage(slug) : null;
 if (page === null) return Astro.rewrite('/404');
 
-const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
+const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
 const locale = await shopLocale(shop.language);
 const { t } = locale;
 
```
```diff
@@ -1,10 +1,9 @@
 import type { APIRoute } from 'astro';
 
-import { shopSource } from '../../../data/source';
 import { answerCartQuote } from '../../../server/cart-quote';
 
 // Step 26b: the cart drawer sends the stored cart's ids and counts here and draws what comes back.
 // POST, not GET: a cart of 50 lines does not fit well in a URL, and a quote is never cached.
 // Another site can post here too (a JSON body is not a "simple" form, but text/plain is), which is
 // harmless: the answer is public prices, and the shop has no session cookie to misuse.
-export const POST: APIRoute = ({ request }) => answerCartQuote(request, shopSource);
+export const POST: APIRoute = ({ request, locals }) => answerCartQuote(request, locals.source);
```
```diff
@@ -1,10 +1,9 @@
 import type { APIRoute } from 'astro';
 
-import { shopSource } from '../../../data/source';
 import { answerPlaceOrder } from '../../../server/orders';
 
 // Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
 // plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
 // exception for localhost, Safari does not)
-export const POST: APIRoute = ({ request }) =>
-  answerPlaceOrder(request, shopSource, { secure: import.meta.env.PROD });
+export const POST: APIRoute = ({ request, locals }) =>
+  answerPlaceOrder(request, locals.source, { secure: import.meta.env.PROD });
```
```diff
@@ -1,9 +1,8 @@
 import type { APIRoute } from 'astro';
 
-import { shopSource } from '../../../data/source';
 import { answerResendCode } from '../../../server/orders';
 
 // Step 26c: "Resend code". POST, not GET: it sends an SMS, and a GET could be fired by a link
 // preview, a prefetch or an <img> on another site
-export const POST: APIRoute = ({ request }) =>
-  answerResendCode(request, shopSource, { secure: import.meta.env.PROD });
+export const POST: APIRoute = ({ request, locals }) =>
+  answerResendCode(request, locals.source, { secure: import.meta.env.PROD });
```
```diff
@@ -1,8 +1,7 @@
 import type { APIRoute } from 'astro';
 
-import { shopSource } from '../../../data/source';
 import { answerVerifyCode } from '../../../server/orders';
 
 // Step 26c: the phone code from /checkout/verify. The order comes from the cookie, never the body
-export const POST: APIRoute = ({ request }) =>
-  answerVerifyCode(request, shopSource, { secure: import.meta.env.PROD });
+export const POST: APIRoute = ({ request, locals }) =>
+  answerVerifyCode(request, locals.source, { secure: import.meta.env.PROD });
```

`loadListing` lost its default source, because the default was the module-level one:

```diff
@@ -1,6 +1,5 @@
 import type { ShopCategory, ShopListingPage, ShopListingQuery } from '@omnivo/contracts';
 
-import { shopSource } from '../data/source';
 import type { ShopSource } from '../data/types';
 import { ALL_SLUG, listingHref, readListingQuery } from './listing-query';
 
@@ -23,12 +22,13 @@ export type ListingLoad =
       categories: ShopCategory[];
     };
 
-// `slug` is the path's: a category's slug, 'all' for every listing, or null on /search. The
-// source is a parameter for the tests, which use a mock source of their own
+// `slug` is the path's: a category's slug, 'all' for every listing, or null on /search.
+// Step 26f.5: the source is the request's (Astro.locals.source), so it has no default any more;
+// the tests pass a mock source of their own
 export async function loadListing(
   slug: string | null,
   params: URLSearchParams,
-  source: ShopSource = shopSource,
+  source: ShopSource,
 ): Promise<ListingLoad> {
   const categories = await source.categories();
   let category: ShopCategory | null = null;
```

The four listing pages above pass `source` as its third argument; its tests already passed a mock source of their
own.

### The product page's SEO

```diff
@@ -15,6 +15,10 @@ interface Props {
   shop: PublicShop;
   locale: ShopLocale;
   title: string;
+  // Step 26f.5: the page's line for search engines and link previews (product.seo.description).
+  // An empty one is left out: it would say nothing, and without the tag a search engine writes its
+  // own line from the page's text
+  description?: string;
   // Step 26d.3: the words of the search on screen, which the header's box shows again
   search?: string | null;
   // Step 26d.4: every category, for the category drawer. Required, not fetched here: the layout
@@ -26,7 +30,15 @@ interface Props {
   currentList?: string | null;
 }
 
-const { shop, locale, title, search = null, categories, currentList = null } = Astro.props;
+const {
+  shop,
+  locale,
+  title,
+  description = '',
+  search = null,
+  categories,
+  currentList = null,
+} = Astro.props;
 const { t } = locale;
 
 // The tenant's two theme colors win over the stylesheet's defaults. They are #rrggbb (the contract
@@ -41,6 +53,7 @@ const theme = `--brand: ${shop.theme.brand}; --accent: ${shop.theme.accent}`;
     <meta name="viewport" content="width=device-width, initial-scale=1" />
     <meta name="theme-color" content={shop.theme.brand} />
     <title>{title}</title>
+    {description !== '' && <meta name="description" content={description} />}
   </head>
   <body>
     <a
```

`description` is optional and empty by default, and an empty one writes no tag: an empty `<meta name="description">`
says nothing, and without the tag a search engine writes its own line from the page.

```diff
@@ -4,17 +4,19 @@ import ProductDescription from '../../components/ProductDescription.astro';
 import ProductGallery from '../../components/ProductGallery.astro';
 import ProductInfo from '../../components/ProductInfo.astro';
 import ProductRow from '../../components/ProductRow.astro';
-import { shopSource } from '../../data/source';
 import ShopLayout from '../../layouts/ShopLayout.astro';
 import { shopLocale } from '../../lib/locale';
 
+// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
+const { source } = Astro.locals;
+
 // Step 26b: one product's page (Figma product_details 37:3521, 1440px). Figma has no phone frame
 // for it, so below md it follows the storefront rules: the cards stack, 16px apart.
 const slug = Astro.params.slug ?? '';
 const [shop, page, categories] = await Promise.all([
-  shopSource.shop(),
-  shopSource.product(slug),
-  shopSource.categories(),
+  source.shop(),
+  source.product(slug),
+  source.categories(),
 ]);
 
 // An old link or a typo: Astro's own 404 page, with the 404 status, so a search engine drops the
@@ -36,7 +38,8 @@ const category = categories.find((candidate) => candidate.id === product.categor
 <ShopLayout
   shop={shop}
   locale={locale}
-  title={t('shop.product.title', { name: product.name, shop: shop.name })}
+  title={t('shop.product.title', { name: product.seo.title, shop: shop.name })}
+  description={product.seo.description}
   categories={categories}
 >
   {/* Figma: 524px gallery + 16px + 740px info card. fr, not px, so the two keep their share
```

The title is `seo.title` (the tenant's SEO title, or the listing's name, decision 14) with the shop's name after it,
as before, and the description is `seo.description`.

### The import rules: `apps/shop/src/boundaries.spec.ts`

```diff
@@ -40,6 +40,17 @@ describe('shop imports', () => {
     expect(offenders).toEqual([]);
   });
 
+  it('reaches data/source.ts only from the middleware', () => {
+    // Step 26f.5: the source is per request (the shop of the request's host). A page that imported
+    // sourceFor() could ask it with another URL than the middleware's, or keep one shop's source in
+    // a module variable for the next shop's request. Pages read Astro.locals.source instead
+    const offenders = Object.entries(files)
+      .filter(([path]) => path !== './middleware.ts')
+      .filter(([, source]) => importsOf(source).some((name) => name.endsWith('/data/source')))
+      .map(([path]) => path);
+    expect(offenders).toEqual([]);
+  });
+
   it('never imports the ERP app or the API', () => {
     // The shop is a public site: their code would bring signed-in screens and server code into it
     const offenders = Object.entries(files)
@@ -59,9 +70,12 @@ describe('shop imports', () => {
     // Step 26e: /track answers its own form's POST (26e.2's server/track.ts), so that one page
     // may import that one module, like an API route. Named page by page, not "any page": a page
     // has <script>s too, and the rule should stay as narrow as what needs it
+    // Step 26f.5: the middleware answers /api/* for a host with no shop with problem JSON, like
+    // the routes, so it may import server/problem.ts. It runs only on the server
     const pageMay = (path: string, name: string) =>
       (path.startsWith('./pages/') && name.endsWith('/server/cookies')) ||
-      (path === './pages/track.astro' && name.endsWith('/server/track'));
+      (path === './pages/track.astro' && name.endsWith('/server/track')) ||
+      (path === './middleware.ts' && name.endsWith('/server/problem'));
     const offenders = Object.entries(files)
       .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
       .filter(([path, source]) =>
```

- **A new rule: only the middleware imports `data/source.ts`** (decision 39). A page that imported `sourceFor` could
  call it with another URL, or keep one shop's source in a module variable for the next shop's request.
- The middleware may import `server/problem.ts`, the one server module it needs, named like the other two
  exceptions.

### The tests

```ts
import { describe, expect, it } from 'vitest';

import { shopConfigOf } from './config';

describe('shopConfigOf', () => {
  it('uses the mock without asking for an address', () => {
    expect(shopConfigOf('mock', undefined)).toEqual({ source: 'mock' });
    // An address left over from another setup does not switch the source
    expect(shopConfigOf('mock', 'http://api:3000')).toEqual({ source: 'mock' });
  });

  it('needs the API’s address for the API', () => {
    expect(() => shopConfigOf('api', undefined)).toThrow(/SHOP_API_URL/);
    // An empty value in a compose file ("SHOP_API_URL=") is no address either
    expect(() => shopConfigOf('api', '')).toThrow(/SHOP_API_URL/);
  });

  it('takes http and https, and drops the "/" at the end', () => {
    expect(shopConfigOf('api', 'http://api:3000/')).toEqual({
      source: 'api',
      apiUrl: 'http://api:3000',
    });
    expect(shopConfigOf('api', 'https://erp.example.com/api/')).toEqual({
      source: 'api',
      apiUrl: 'https://erp.example.com/api',
    });
  });

  it('refuses what is not an http address', () => {
    // "api:3000" is a valid URL with the scheme "api:", so only the scheme check catches it
    expect(() => shopConfigOf('api', 'api:3000')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => shopConfigOf('api', 'not an address')).toThrow(/not an address/);
  });
});
```

The rules of `shopConfigOf`: the mock needs no address and ignores one, the API needs one, an empty value is none,
the `/` at the end goes, and `api:3000` is refused for its scheme.

```ts
import { describe, expect, it } from 'vitest';

import { type ApiAnswer, createAnswerCache } from './answer-cache';

// A cache on a clock the test moves, and a loader that counts its calls
function setup(maxEntries = 10) {
  let time = 0;
  const cache = createAnswerCache({ ttlMs: 30_000, maxEntries, now: () => time });
  let loads = 0;
  const load = (answer: ApiAnswer = { status: 200, body: { n: loads + 1 } }) => {
    return () => {
      loads += 1;
      return Promise.resolve(answer);
    };
  };
  return {
    cache,
    load,
    loads: () => loads,
    wait: (ms: number) => {
      time += ms;
    },
  };
}

describe('createAnswerCache', () => {
  it('keeps an answer for 30 seconds, then asks again', async () => {
    const { cache, load, loads, wait } = setup();
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 1 } });
    wait(29_999);
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 1 } });
    expect(loads()).toBe(1);
    wait(1);
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 2 } });
    expect(loads()).toBe(2);
  });

  it('sends one request for callers that ask at the same time', async () => {
    const { cache, load, loads } = setup();
    const answers = await Promise.all([cache.read('a', load()), cache.read('a', load())]);
    expect(answers[0]).toBe(answers[1]);
    expect(loads()).toBe(1);
  });

  it('keeps a refusal, such as "no such product"', async () => {
    const { cache, load, loads } = setup();
    const missing = { status: 404, body: { code: 'not_found' } };
    await cache.read('a', load(missing));
    expect(await cache.read('a', load())).toEqual(missing);
    expect(loads()).toBe(1);
  });

  it('never keeps a failure', async () => {
    const { cache, load, loads } = setup();
    await cache.read('a', load({ status: 502, body: null }));
    await expect(cache.read('a', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    // The rejected load has been forgotten too: the third read loads again (the second answer of
    // the counting loader, which the rejected one is not)
    expect(await cache.read('a', load())).toEqual({ status: 200, body: { n: 2 } });
    expect(loads()).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('does not let an old failure remove a newer answer', async () => {
    const { cache, load, wait } = setup();
    let fail: (error: Error) => void = () => undefined;
    const slow = cache.read('a', () => new Promise<ApiAnswer>((_, reject) => (fail = reject)));
    // The slow answer has ended (its 30 seconds are over) before it fails; a new one comes in
    wait(30_000);
    await cache.read('a', load());
    fail(new Error('late'));
    await expect(slow).rejects.toThrow('late');
    expect(cache.size).toBe(1);
  });

  it('drops the oldest answer when it is full', async () => {
    const { cache, load, loads } = setup(2);
    await cache.read('a', load());
    await cache.read('b', load());
    await cache.read('c', load());
    expect(cache.size).toBe(2);
    // b is still kept; a was dropped and loads again
    await cache.read('b', load());
    expect(loads()).toBe(3);
    await cache.read('a', load());
    expect(loads()).toBe(4);
  });
});
```

- The cache runs on a clock the test moves, so "30 seconds" is tested without waiting.
- "never keeps a failure" checks both kinds: a 502 answer and a rejected load.
- "does not let an old failure remove a newer answer" holds a load open, moves the clock past its 30 seconds, puts
  a new answer in, and only then fails the old one. The new answer must stay.

```ts
import {
  listingQueryFromParams,
  publicListingParamsSchema,
  SHOP_HOST_HEADER,
  shopCartQuoteRequestSchema,
  type ShopTextPageSlug,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockHome } from '../mock/home';
import { createMockSource } from '../mock/mock-source';
import { createOrderBook, MOCK_CODE, type MockOrderBook } from '../mock/orders';
import { mockCategories, mockShop } from '../mock/shop';
import type { ShopSource } from '../types';
import { createAnswerCache } from './answer-cache';
import { createApiSource } from './api-source';
import { createShopApi, ShopApiError, ShopMissingError } from './shop-api';

// The tests' ERP API: the mock shop's data behind the /public/v1 routes, for one host. The mock
// matches the public contract (mock.spec.ts), so the answers are real ones in shape. Every request
// is written down, so a test can see what the shop sent
const HOST = 'nirvor.omnivo.test';
const API = 'http://api.test';
const STEVIA = 'lst-zero-cal-stevia-30-sachets';
const NEEM = 'himalaya-purifying-neem-face-wash-150ml';

function problem(status: number, code: string): Response {
  return Response.json({ title: 'Refused', status, detail: code, code }, { status });
}

function fakeApi(data: ShopSource = createMockSource()) {
  const requests: Request[] = [];
  let failNext: Response | null = null;

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get(SHOP_HOST_HEADER) !== HOST) return problem(404, 'storefront_not_found');
    const path = url.pathname.replace(/^\/public\/v1/, '');
    const slug = /^\/(?:products|pages)\/(.+)$/.exec(path)?.[1] ?? '';

    if (request.method === 'POST' && path === '/cart/quote') {
      const body = shopCartQuoteRequestSchema.parse(await request.json());
      return Response.json(await data.quote(body));
    }
    if (path === '/shop') return Response.json(await data.shop());
    if (path === '/categories') return Response.json(await data.categories());
    if (path === '/home') return Response.json(await data.home());
    if (path === '/checkout-settings') return Response.json(await data.checkoutSettings());
    if (path === '/listings') {
      const params = publicListingParamsSchema.parse(Object.fromEntries(url.searchParams));
      const page = await data.listings(listingQueryFromParams(params));
      return page === null ? problem(400, 'invalid_cursor') : Response.json(page);
    }
    if (path.startsWith('/products/')) {
      const page = await data.product(slug);
      return page === null ? problem(404, 'not_found') : Response.json(page);
    }
    if (path.startsWith('/pages/')) {
      // The route's own schema lets only the four slugs in; the test asks for those only
      const page = await data.textPage(slug as ShopTextPageSlug);
      return page === null ? problem(404, 'not_found') : Response.json(page);
    }
    return problem(404, 'not_found');
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const failure = failNext;
    failNext = null;
    return failure ?? answer(request);
  };

  return {
    fetch,
    requests,
    // The next request gets this answer in place of the real one
    failWith(response: Response) {
      failNext = response;
    },
    paths: () =>
      requests.map((request) => new URL(request.url).pathname + new URL(request.url).search),
  };
}

// A shop source on the fake API, with its own cache and order book, as data/source.ts makes one
function setup({ host = HOST, api = fakeApi(), book = createOrderBook() } = {}) {
  const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
  const source = createApiSource(
    createShopApi({ apiUrl: API, host, cache, fetch: api.fetch }),
    () => book,
  );
  return { source, api, cache };
}

describe('the API source', () => {
  it('reads the shop the host names, and says which one in every request', async () => {
    const { source, api } = setup();
    expect(await source.shop()).toEqual(mockShop);
    expect(await source.categories()).toEqual(mockCategories);
    expect(await source.home()).toEqual(mockHome);
    expect(api.paths()).toEqual(['/public/v1/shop', '/public/v1/categories', '/public/v1/home']);
    expect(api.requests.every((request) => request.headers.get(SHOP_HOST_HEADER) === HOST)).toBe(
      true,
    );
  });

  it('sends a listing query with only what is set', async () => {
    const { source, api } = setup();
    const first = await source.listings({
      category: null,
      q: null,
      sort: 'newest',
      minPrice: null,
      maxPrice: null,
      inStock: false,
      offer: false,
      cursor: null,
    });
    expect(first?.items).toHaveLength(20);
    await source.listings({
      category: 'cosmetics',
      q: 'নিম',
      sort: 'price_asc',
      minPrice: '100',
      maxPrice: null,
      inStock: true,
      offer: false,
      cursor: null,
    });
    expect(api.paths()).toEqual([
      // The first page of /c/all is the plain address, one cache entry for every shopper
      '/public/v1/listings',
      `/public/v1/listings?category=cosmetics&q=${encodeURIComponent('নিম')}&sort=price_asc&minPrice=100&inStock=1`,
    ]);
  });

  it('starts a list again for a cursor the API did not make', async () => {
    const { source } = setup();
    const page = await source.listings({
      category: null,
      q: null,
      sort: 'newest',
      minPrice: null,
      maxPrice: null,
      inStock: false,
      offer: false,
      cursor: 'not-a-cursor',
    });
    expect(page).toBeNull();
  });

  it('answers null for a product or page the shop does not have', async () => {
    const { source, api } = setup();
    expect((await source.product(NEEM))?.product.slug).toBe(NEEM);
    expect(await source.product('no-such-product')).toBeNull();
    // An address the ERP could never have made is not even asked for
    expect(await source.product('Neem Face Wash')).toBeNull();
    expect(api.paths()).not.toContain('/public/v1/products/Neem%20Face%20Wash');
    expect((await source.textPage('terms'))?.slug).toBe('terms');
  });

  it('throws ShopMissingError for a host that is no launched shop', async () => {
    const { source } = setup({ host: 'nobody.omnivo.test' });
    await expect(source.shop()).rejects.toBeInstanceOf(ShopMissingError);
    // Every route, not only shop(): a product of no shop is not "no such product"
    await expect(source.product(NEEM)).rejects.toBeInstanceOf(ShopMissingError);
  });

  it('keeps answers per host for 30 seconds, and never a quote', async () => {
    const api = fakeApi();
    const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
    const sourceOf = (host: string) =>
      createApiSource(createShopApi({ apiUrl: API, host, cache, fetch: api.fetch }), () =>
        createOrderBook(),
      );
    await sourceOf(HOST).shop();
    await sourceOf(HOST).shop();
    // Another host is another shop: never the first one's answer
    await expect(sourceOf('other.omnivo.test').shop()).rejects.toBeInstanceOf(ShopMissingError);
    // "No such product" is kept as well
    await sourceOf(HOST).product('no-such-product');
    await sourceOf(HOST).product('no-such-product');
    const cart = { lines: [{ listingId: STEVIA, quantity: 1 }] };
    await sourceOf(HOST).quote(cart);
    await sourceOf(HOST).quote(cart);
    expect(api.paths()).toEqual([
      '/public/v1/shop',
      '/public/v1/shop',
      '/public/v1/products/no-such-product',
      '/public/v1/cart/quote',
      '/public/v1/cart/quote',
    ]);
    expect(api.requests.map((request) => request.headers.get(SHOP_HOST_HEADER))).toEqual([
      HOST,
      'other.omnivo.test',
      HOST,
      HOST,
      HOST,
    ]);
  });

  it('fails when the API fails, and asks again next time', async () => {
    const { source, api } = setup();
    api.failWith(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(source.shop()).rejects.toBeInstanceOf(ShopApiError);
    expect(await source.shop()).toEqual(mockShop);
    expect(api.paths()).toEqual(['/public/v1/shop', '/public/v1/shop']);
  });

  it('fails on an answer that breaks the contract', async () => {
    const { source, api } = setup();
    api.failWith(Response.json({ ...mockShop, theme: { brand: 'red', accent: 'lime' } }));
    await expect(source.shop()).rejects.toThrow(/broke its contract/);
  });

  it('fails when no answer comes, or it comes too late', async () => {
    const down = createShopApi({
      apiUrl: API,
      host: HOST,
      cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(createApiSource(down, createOrderBook).shop()).rejects.toMatchObject({
      name: 'ShopApiError',
      status: 0,
    });

    // A fetch that answers only when it is aborted, as a hung API does
    const hung = createShopApi({
      apiUrl: API,
      host: HOST,
      cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation timed out.', 'TimeoutError'));
          });
        }),
    });
    await expect(createApiSource(hung, createOrderBook).home()).rejects.toBeInstanceOf(
      ShopApiError,
    );
  });
});

describe('orders on the API source', () => {
  const order = {
    lines: [{ listingId: STEVIA, quantity: 3 }],
    zoneId: 'inside_dhaka',
    name: 'Sumi Akter',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod: 'cod' as const,
    termsAccepted: true as const,
  };

  // What the checkout saw: the mock's total for the same cart, which is what the fake API answers
  async function expectedTotal() {
    return (await createMockSource().quote({ lines: order.lines, zoneId: order.zoneId })).total;
  }

  async function place(source: ShopSource) {
    const placed = await source.placeOrder({ ...order, expectedTotal: await expectedTotal() });
    if (!placed.ok) throw new Error(`refused: ${placed.code}`);
    return placed.value;
  }

  it('prices the order with the API and sends it no name, phone or address', async () => {
    const { source, api } = setup();
    const placed = await place(source);
    expect(placed.orderNo).toBe('W-000001');

    const quote = api.requests.find((request) => request.url.endsWith('/cart/quote'));
    expect(await quote?.json()).toEqual({ lines: order.lines, zoneId: 'inside_dhaka' });

    // The code is the mock's until step 27 sends SMS, and the page shows it
    expect(source.testCode).toBe(MOCK_CODE);
    const confirmed = await source.verifyCode(placed.token, MOCK_CODE);
    expect(confirmed).toMatchObject({ ok: true, value: { orderNo: 'W-000001' } });
    expect((await source.order('W-000001', placed.token))?.total).toBe(await expectedTotal());
  });

  it('refuses an order whose price changed since the checkout saw it', async () => {
    const { source } = setup();
    const placed = await source.placeOrder({ ...order, expectedTotal: '1.0000' });
    expect(placed).toEqual({ ok: false, code: 'shop_order_changed' });
  });

  it('keeps each shop’s orders in its own book', async () => {
    // data/source.ts gives each host its own book; two books here stand for two shops
    const first: MockOrderBook = createOrderBook();
    const second: MockOrderBook = createOrderBook();
    const acme = setup({ book: first }).source;
    const nirvor = setup({ book: second }).source;
    const fromAcme = await place(acme);
    expect((await place(nirvor)).orderNo).toBe('W-000001');
    // The second shop cannot open the first one's order, even with its token
    expect(await nirvor.order(fromAcme.orderNo, fromAcme.token)).toBeNull();
    // A real shop offers no demo orders on /track
    expect(acme.testTracking).toBeNull();
  });
});
```

- **The fake API is the mock shop behind the `/public/v1` routes, for one host.** The mock matches the contract
  (`mock.spec.ts`), so its answers are real ones in shape, and the same schemas the real API uses
  (`publicListingParamsSchema`, `listingQueryFromParams`) read its query. Every request is recorded, so a test sees
  what the shop sent: the paths, the queries and the `X-Shop-Host` header.
- **"sends a listing query with only what is set"** pins decision 13 from the shop's side: the first page of
  `/c/all` is the bare path.
- **"keeps answers per host…"** puts two hosts on one cache and checks the order of the real requests: the second
  `shop()` of the first host is not sent, the other host's is, "no such product" is sent once, and both quotes go.
- **"fails when no answer comes, or it comes too late"** uses a fetch that rejects, then one that answers only when
  the timeout aborts it, as a hung API does.
- **The order tests** read the quote request the source sent and compare it with exactly the lines and the zone: a
  name or a phone in it fails the test. The expected total comes from the mock's own quote of the same cart, which is
  what the fake API answers, so the test does not hard-code a price.

### Check this part

```sh
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm --filter @omnivo/shop test:e2e
pnpm exec eslint apps/shop/src apps/shop/astro.config.ts
pnpm exec prettier --check apps/shop/src apps/shop/astro.config.ts packages/i18n/src/locales/shop
```

The shop has 223 unit tests (200 before, 23 new); the 40 Playwright tests run on the mock as before (38 pass, 2 are
desktop-only or phone-only tests skipped on the other size, as before).

The built server was also run with `SHOP_SOURCE=api` against a fake API (the mock shop on port 4399, for the host
`nirvor.localhost`):

- every page answered from the API: home, `/c/all` with filters, search, the product page (with its
  `<meta name="description">`), the text pages and `/track`; `/c/all?cursor=garbage` redirected to `/c/all`;
- over all those pages the fake API saw the shop, the categories and the home page once each, and no request for
  `/p/Bad%20Slug`;
- `nobody.localhost` answered 404 "No shop has this address" on `/`, `/p/x`, `/404` and an unknown path, and
  `/api/cart/quote` answered `404 storefront_not_found` as problem JSON;
- the API down: every page 500, and the next page asked again;
- `SHOP_SOURCE=apii`, and `SHOP_SOURCE=api` without `SHOP_API_URL`: the first request failed with the setting's name.

Broken on purpose, one at a time, each caught by the named test:

- the host left out of the cache key: "keeps answers per host for 30 seconds, and never a quote";
- 5xx answers kept: "never keeps a failure" and "fails when the API fails, and asks again next time";
- `forget` without its "same entry" check: "does not let an old failure remove a newer answer";
- the whole order request sent to the quote: "prices the order with the API and sends it no name, phone or
  address";
- no slug check in `product()`: "answers null for a product or page the shop does not have".

While writing the tests, two of their own mistakes came up and were fixed in the test: the mock shop's minimum order
is ৳300, so the first cart (2 × ৳120) was refused, and the mock's home page has 5 featured cards, not 20.

## 26f.6 — Doc updates

After you implement this (ask me and I can do these). Four files change. The build plan's progress list (section ৯)
is **not** ticked: the line "ধাপ ২৬–২৮" stays open until steps 27 and 28 are done too.

**CLAUDE.md** (all in "Storefront design system"):

1. In the paragraph that starts "What still applies from the rest of this file", after "(no i18next in the
   browser).", add: "Every page and route reads its data from `Astro.locals.source`, which `src/middleware.ts` sets
   for each request: the mock (the default, `SHOP_SOURCE=mock`) or the ERP's `/public/v1` for the shop the host
   names (`SHOP_SOURCE=api` plus `SHOP_API_URL`). Only the middleware imports `data/source.ts`. The API reads a
   shop only inside `ShopDb.read`, a read-only transaction as the `omnivo_public` role, so a table or column the
   shop needs is granted to that role in a migration."
2. In **Tenant theme**, replace "the tenant's `storefront_settings.theme`" with "the tenant's `storefront_settings`
   (`brand_color`, `accent_color`, `#rrggbb`)".
3. At the end of the **Product page, top** bullet, add: "The page's `<title>` and `<meta name="description">` are
   the product's `seo`, which the API fills: the tenant's SEO words, or the name and the start of the description."
4. In "Storefront screens not in Figma", after the **Page not found (`404`)** bullet, add: "**No shop (a host with
   no launched shop):** a page of its own, not the shop's layout, because there is no shop to take a name, colors or
   a menu from. The empty state 16px from the top (36px from `md`) in the default colors: `StoreRemove01`, "No shop
   has this address", "Check the address for a typo…", and no button (a link to `/` would land here again).
   English, `noindex`, status 404. `/api/*` on such a host answers `404 storefront_not_found` as problem JSON."
5. At the end of **Storefront tests**, add: "They run on the mock source. The API source is tested without a
   browser, against a fake `/public/v1` made of the mock (`src/data/api/api-source.spec.ts`), and the API's answers
   by its own integration and tenant-leak tests (`apps/api/src/storefront/`)."

**docs/system-design.bn.md** (§14, in Bangla like the rest of the file):

6. In §14.2, replace the bullet that starts "**পাবলিক API আলাদা:**" with:

   ```markdown
   - **পাবলিক API আলাদা:** `/public/v1/*`, JWT নেই। শপের সার্ভার API-কে ভেতর থেকে ডাকে আর ক্রেতার ব্রাউজারের
     host পাঠায় `X-Shop-Host` হেডারে। টেন্যান্ট আসে শুধু সেই host থেকে (subdomain label →
     `storefront_tenant_for_subdomain()`), কখনো query param থেকে না। প্রতিটা রিকোয়েস্ট একটা `READ ONLY`
     transaction, শুরু হয় `SET LOCAL ROLE omnivo_public` দিয়ে: NOLOGIN role, RLS বাইপাস করতে পারে না, শুধু শপের
     দরকারি কলামে `SELECT` আছে, আর restrictive policy-তে শুধু চালু (`launched_at`) শপের প্রকাশিত লিস্টিং দেখে।
     Rate limit আপাতত edge-এ (Cloudflare); API-তে আসল limit আসবে ধাপ ২৭-এর অর্ডার আর OTP-র সাথে।
   ```
7. In §14.2, replace the bullet that starts "**রেন্ডারিং:**" with:

   ```markdown
   - **রেন্ডারিং:** পেজ শপের সার্ভারে রেন্ডার হয়। API-র উত্তর `Cache-Control: no-store`, কারণ CDN উত্তর চেনে
     address দিয়ে, `X-Shop-Host` দিয়ে না, তাই এক শপের পেজ অন্য শপে চলে যেতে পারত। শপের সার্ভার নিজের মেমরিতে
     host + path ধরে ৩০ সেকেন্ড রাখে (শুধু GET, ব্যর্থ উত্তর রাখে না, quote কখনো না)। শপের পেজ যখন CDN-এ cache
     হবে, তখন পাবলিশ/দাম বদলালে outbox ইভেন্ট → worker → **CDN purge** (§১৩.৩-এর ক্যাটালগ পাবলিশের প্যাটার্ন)।
   ```
8. In §14.2, replace the bullet that starts "**ছবি:**" with:

   ```markdown
   - **ছবি:** স্টোরেজের পাবলিক `storefront/` ফোল্ডারে, নাম কখনো বদলায় না (`storefront/<image id>/<size>.webp`:
     small 480px, large 1200px, wide 2560px), তাই CDN রেখে দিতে পারে; signed link না। WebP বানায় worker-এর
     sharp জব (ধাপ ২৬g)। শপের LCP টার্গেট < ২.৫ সেকেন্ড 3G-তে।
   ```
9. In §14.2, replace the bullet that starts "**কার্ট:**" with:

   ```markdown
   - **কার্ট:** ব্রাউজারে (localStorage), দাম প্রতিবার সার্ভারের quote থেকে। Abandoned cart রিপোর্ট আর
     রিমাইন্ডার SMS-এর জন্য সার্ভারে `storefront_carts` পরে আসবে।
   ```
10. In §14.3, replace the lines from `storefront_settings                ← টেন্যান্টপ্রতি একটা রো` down to
    `storefront_categories, storefront_banners, storefront_carts, storefront_cart_items` with:

    ```text
    storefront_settings                ← টেন্যান্টপ্রতি একটা রো (ধাপ ২৬f)
      tenant_id (PK), subdomain (UNIQUE, শুধু label: acme), launched_at (NULL = শপ বন্ধ, 404)
      name, language, logo_image_id, brand_color, accent_color, hotline, address, সোশ্যাল লিংক
      default_warehouse_id, delivery_zones (JSONB: ঢাকার ভিতরে ৮০, বাইরে ১২০)
      free_delivery_from, minimum_order, payment_methods
      (পরে: gateway_credentials, default_courier_account_id, auto_consign, require_phone_otp)

    storefront_domains                 ← পরের ধাপে: টেন্যান্টের নিজের কেনা ডোমেইন
      domain (UNIQUE), tenant_id, verified, ssl_status

    storefront_categories              ← শপের নিজের ক্যাটাগরি ট্রি (প্রোডাক্টের ক্যাটাগরি না)
      tenant_id, parent_id, slug (UNIQUE per tenant), name, position

    storefront_listings                ← Inventory-র variant-কে শপে "প্রকাশ" করা
      tenant_id, product_id, variant_id (FK → product_variants), category_id
      slug, name, pack_size, published_at (NULL = draft)
      price_override (NULL হলে variant-এর sale_price)
      sale_kind (percent | amount | price), sale_value, sale_starts_at, sale_ends_at
      badges, images (JSONB, সর্বোচ্চ ৪টা {id, alt}), description_sections (JSONB, HTML না)
      seo_title, seo_description
      UNIQUE (tenant_id, slug)

    storefront_banners (hero | image), storefront_collections + storefront_collection_items,
    storefront_home_blocks (হোমপেজের ক্রম), storefront_pages (privacy | terms | about | contact)
    ```
11. In §14.3 → "মূল নিয়ম", after the first bullet ("**প্রোডাক্ট ডুপ্লিকেট করবেন না।** …"), add:

    ```markdown
    - **বর্ণনায় টেন্যান্টের HTML নেই।** বর্ণনা আর টেক্সট পেজ section হিসেবে রাখা হয় (heading আর লেখা, `- `
      তালিকা, `**bold**`, লিংক); API সেখান থেকে HTML বানায় আর টেন্যান্টের লেখা প্রতিটা অক্ষর escape করে।
    - **দাম সার্ভার ঠিক করে।** অফার রাখা হয় টেন্যান্ট যেভাবে লিখেছে (৳ বা % ছাড়, বা ছাড়ের পরের দাম); শপের
      দাম, কাটা দাম আর ribbon API বানায়। যে অফারে কিছু কমে না, সেটা দেখানো হয় না।
    ```

**docs/build-plan.bn.md** (section ২, ধাপ ২৬):

12. Replace the line that starts "`storefront` মডিউল:" with:

    ```markdown
    `storefront` মডিউল (ধাপ ২৬f): `storefront_settings` (subdomain + `launched_at`), `storefront_categories` (শপের নিজের ট্রি), **`storefront_listings`** (Inventory-র প্রোডাক্টকে "প্রকাশ" করা — নতুন প্রোডাক্ট টেবিল **নয়**; দাম, অফার, ছবি, বর্ণনা, SEO), banners, collections, হোমপেজের ক্রম, টেক্সট পেজ। নিজের কেনা ডোমেইনের `storefront_domains` পরের একটা ধাপে; কার্ট আপাতত ব্রাউজারে।
    ```
13. Replace "পাবলিক API `/public/v1/*` — JWT নেই, তাই আলাদা **read-mostly DB role** + rate limit + WAF।" with
    "পাবলিক API `/public/v1/*` — JWT নেই, তাই আলাদা **read-only DB role** (`omnivo_public`) + rate limit + WAF
    (ধাপ ২৬f; rate limit এখন edge-এ, API-তে ধাপ ২৭-এর অর্ডার আর OTP-র সাথে)।"
14. Replace "ERP অ্যাপে Storefront মেনু: Catalog, Appearance, Delivery zones।" with "ERP অ্যাপে Storefront মেনু:
    Catalog, Appearance, Delivery zones, Pages (ধাপ ২৬g)।"

**docs/vps-deploy.en.md** ("Not on this server yet"):

15. Replace the first bullet ("The online shop (`apps/shop`). It needs its own image and Caddy site, and it still
    uses mock data.") with these two:

    ```markdown
    - A real shop. `https://shop.omnivosoft.com` shows the mock shop (`SHOP_SOURCE` is not set) until 26g lets a
      workspace launch one. Then the `shop` service gets `SHOP_SOURCE=api` and `SHOP_API_URL=http://api:3000`
      (inside Docker's network), the API gets `SHOP_BASE_DOMAIN=omnivosoft.com`, and the tunnel and Caddy need a
      route for the shops' names.
    - A rate limit for the public shop API. `https://api.omnivosoft.com/public/v1/*` answers anyone, with no
      sign-in. Before a real shop opens, add a Cloudflare rate limiting rule for that path (**Security → WAF → Rate
      limiting rules**). The shop's server calls the API inside Docker's network, so the rule never slows the shop.
    ```

Two notes on these:

- **Why item 1 names `ShopDb.read`:** the walls of decision 15 hold only if every public read goes through it. A
  new public route that used the ERP's normal `withTenant` would read as `omnivo_app`, with every column of every
  table, and no test of 26f.4 would notice, because it is a new route. CLAUDE.md is where the next step looks first.
- **Why item 15 has no exact numbers:** the limit depends on how many shops share one office's IP and how chatty a
  page is once 26g fills the shops. The bullet says where the rule goes; its numbers belong to the step that opens a
  real shop.

## 26f.7 — Run it and check it

### One comment on staging: `infra/staging/compose.yml`

```diff
@@ -210,9 +210,9 @@ services:
       - caddy-data:/data
       - caddy-config:/config
 
-  # The online shop (apps/shop). Until step 26's public API exists it shows the mock shop: its
-  # products, prices and orders are made up, and an order lives in this container's memory only,
-  # so a restart forgets it. It needs nothing else in the stack. `web` does not wait for it either:
+  # The online shop (apps/shop). It shows the mock shop (SHOP_SOURCE is not set) until 26g lets a
+  # workspace launch a shop: its products, prices and orders are made up, and an order lives in
+  # this container's memory only, so a restart forgets it. It needs nothing else in the stack. `web` does not wait for it either:
   # if the shop fails, the ERP app keeps working and only the shop's address answers 502.
   shop:
     image: ${REGISTRY}/omnivo-shop:${IMAGE_TAG}
```

The shop's comment said it shows the mock "until step 26's public API exists". The API exists now, and staging still
shows the mock on purpose (decision 48), so the comment says what keeps it there: `SHOP_SOURCE` is not set, and no
workspace can launch a shop before 26g.

### The commands

Your dev database needs the two new migrations first (0063 and 0064):

```bash
pnpm install
pnpm db:migrate
```

Then the packages this step touched, one at a time:

```bash
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/db build
pnpm --filter @omnivo/contracts test      # 518
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test            # 175 unit tests (no database)
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test           # 223
pnpm --filter @omnivo/shop test:e2e       # on the mock, as before: 38 passed, 2 skipped
```

And the whole repo:

```bash
pnpm dedupe --check
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test                 # 1,291: contracts 518 + shop 223 + app 210 + api 175 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm test:integration     # 737 in 45 files, with the 17 of public-storefront.int.spec.ts
pnpm test:tenant-leak     # 142 in 22 files, with the 9 of storefront.tenant-leak.int.spec.ts
pnpm boundaries
pnpm test:bundle-size     # the ERP app's first load 231.9 KB gz (budget 235): four error words more
pnpm test:openapi         # up to date, with the eight /public/v1 routes
```

On a laptop with 8 GB, add `--concurrency=2` to the turbo ones, and run the two database suites with
`--maxWorkers=3` (from `apps/api`: `npx vitest run .int.spec --maxWorkers=3`).

**Not run:** the ERP app's e2e suites (`@omnivo/app test:e2e` and the PWA suite). The app's only change is four error
words in `en.ts` and `bn.ts`, which the type check, the unit tests and the build cover, and its e2e tests run on MSW,
so they never meet the API's new module.

### The shop on the real API, end to end

The unit tests check the shop's API source against a fake API (26f.5), and the integration tests check the API's
answers (26f.4). One more check put the two real halves together once: a throwaway test file (not in this guide, and
not in `src`) that sets up the same Nirvor Pharmacy shop as `public-storefront.int.spec.ts`, starts the API on a real
port, starts the built shop (`node dist/server/entry.mjs`) with `SHOP_SOURCE=api` against it, and asks the shop's
pages over HTTP with the host `nirvor.localhost`. All six of its tests passed:

- **The home page** has the shop's name, the listings in stock and out of stock but not the archived Old Soap, the
  "Hot & Trending" row, and photo addresses of the form `…/storefront/<image id>/small.webp`. The prices on it were
  ৳229, ৳70 (the ribbon), ৳108 and ৳780: all from the database, none from the mock.
- **The product pages:** Neem Face Wash at ৳229 over ৳299, "Available in stock", and its description's sections as
  HTML; Green Tea with its SEO title in `<title>` and its SEO description in the meta tag, at ৳108 (10% off ৳120);
  Milk Powder "Out of stock"; Old Soap and an unknown slug `404`.
- **The lists:** `/c/all?sort=price_asc` in price order, `/c/beverages` with only its listings, `/c/skin-care` with
  its child category's Neem, `/search?q=neem`, `?stock=1` without Milk Powder, and `?cursor=garbage` redirected.
- **The text pages:** `/pages/terms` with its link to `/pages/privacy`, and `/pages/privacy` (not written) `404`.
- **The cart:** `POST /api/cart/quote` with 2 × Neem and 1 × Milk Powder → Neem `available` with `lineTotal` 458,
  Milk Powder `out_of_stock`. The listing ids in the request are the database's UUIDs, which the mock does not know,
  so this answer can only have come from the API.
- **No shop:** `nobody.localhost` → `404` "No shop has this address", and `/api/cart/quote` there → `404`
  `application/problem+json` with `storefront_not_found`.

### Found while finishing

- **The tenant's `<script>` in the product page's meta description is not a hole.** The test shop's description
  holds `<script>x</script>` on purpose (decision 8), and the first run of the check above failed on it: the page's
  HTML contains `<meta name="description" content="Controls oil <script>x</script>">`. That is the summary of
  decision 14: plain text, put in a quoted attribute. An HTML parser does not look for tags inside a quoted
  attribute value, and Astro escapes the `"` and the `&` in it, so the text cannot close the attribute. In the
  page's body the same words are escaped (`&lt;script&gt;x&lt;/script&gt;`). The check was wrong, not the page; it
  now checks the attribute exactly and the body for the escaped form.
- **"Until then the seed fills it"** in "Not in this step" was wrong since decision 17 (there is no seed). It now
  says the shop stays on the mock and the tests make their own shops.
- **The staging comment** (above).

### What you should see

No workspace has a shop until 26g's screens can launch one (decision 17), so nothing on your laptop changes yet:

- [ ] `pnpm --filter @omnivo/shop dev` (the mock, as before): every page as after 26e. The product page's tab says
      "Neem Face Wash | …", and its source has a `<meta name="description">`.
- [ ] With the API running (`pnpm dev`), `curl -i -H 'X-Shop-Host: acme.localhost' http://localhost:3000/public/v1/shop`
      → `404` with `storefront_not_found` and `Cache-Control: no-store`: the route is there, and no shop is launched.
- [ ] `curl -i http://localhost:3000/public/v1/shop` (no header) → `404 storefront_not_found` too, before any
      database work (decision 26).
- [ ] `SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 pnpm --filter @omnivo/shop dev`, then
      `http://acme.localhost:4321` → "No shop has this address", status 404, without any shop's name or menu.
- [ ] `SHOP_SOURCE=api` without `SHOP_API_URL` → the first request fails with the setting's name in the error.

### Known differences from Figma

- **The "No shop has this address" page is not in Figma.** It is the storefront's empty state on a page of its own
  (decision 41), and 26f.6 writes it into `CLAUDE.md`.

## What comes next

- **26g, the ERP's Storefront menu:** Catalog (listings with photos, the description's sections, the sale, badges,
  SEO), Appearance (logo, colors with the 4.5:1 check, banners, collections, the home page's order), Delivery zones,
  Pages, and "Open the shop" (`launched_at`). With it: the `storefront_images` table, the upload and the sharp job that
  makes the three WebP sizes, a dev seed with photos, the tests' shops made through 26g's API instead of SQL
  (decision 36), and staging switched to `SHOP_SOURCE=api` (decision 48).
- **Step 27:** the real checkout and orders, stock held for an order, coupons, the phone code by SMS, and the API's
  own rate limits.
- **Later:** a tenant's own domain (`storefront_domains`, DNS checks, Cloudflare for SaaS), as a second way into the
  host lookup (decision 16).
