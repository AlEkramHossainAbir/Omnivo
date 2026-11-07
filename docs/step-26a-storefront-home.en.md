# Step 26a: Storefront, part 1 — the shop app and the home page

> The implementation guide for "Phase 10 → Step 26", the first of three parts, of [build-plan.bn.md](build-plan.bn.md).
> It is built ahead of its place in the plan, on purpose: the shop's screens are made **static** first (mock data,
> no API, no database), and step 26b makes them read the real data. The three parts:
>
> - **26a (this guide):** `apps/shop` (Astro), the shop's design tokens, the data contract, the mock data, the header,
>   the footer and the home page, on desktop and on the phone, with a cart count that lives in the browser.
> - **26b:** the product page, the cart drawer, checkout, the phone code and the "Order Confirmed" dialog.
> - **26c:** the category and search pages, order details and tracking, the text pages (privacy, terms…), the empty
>   states and the Playwright tests.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `1219788`, "device e2e fix") and
> checked on 2026-11-07: `astro check` (0 errors, 0 warnings), `vitest` in `apps/shop` (11), in `packages/contracts`
> (363) and in `packages/i18n` (17), `tsc --noEmit` in both packages, ESLint and Prettier on every changed package,
> `depcruise apps packages`, and `astro build` (in English and once with the shop set to Bangla).
>
> **Not run:** the whole repo's `pnpm lint`, `pnpm test`, `pnpm typecheck` and the e2e suites. This step does not
> touch `apps/app` or `apps/api`, but run them once after you implement it (see 26a.11).
>
> **Not covered by ESLint:** `.astro` files. ESLint reads the shop's `.ts` files, but the components and their
> `<script>` blocks are checked by `astro check` (types) only. `eslint-plugin-astro` would add that; it is left for
> 26b, when the shop has more script code.
>
> Also checked:
>
> - **The page against Figma, measured in a browser** (Edge through Playwright, 1440px, 900px and 393px wide). At
>   1440px: header at 80,20 (1280×72), hero at y 108 (280 high), "All Category" at 452, the chips at 514, the grid at
>   588, a card 458 high with its pack size at 317, its price at 349 and its button at 390, the banner at 1093, the
>   rows at 1421 / 2049 / 2677, Load More at 3305, the footer at 3423 (359 high), the copyright at 3817, the page
>   3862 high. Figma: the same, ±1px. At 393px: header 16 (64 high), hero 96 (220), categories 332, "Featured
>   Products" 463, a card 316 high, the banner 1167, the rows 1323 / 1730 / 2118, Load More 2514, the footer 2592.
>   Figma: the same, ±1px, except the phone footer (316 against 311). Nothing scrolls sideways at any width.
> - **The cart count:** two clicks on "Add to cart" give "Cart, 2 items" and say "Added to cart" to a screen reader; a
>   reload keeps the 2 and says nothing.
> - **Broken on purpose, twice:** a page that imports the mock directly (the boundary test failed), and a wrong
>   translation key (`astro check` failed).
> - **JavaScript sent to the browser:** about 2 KB gz in total, and 6.6 KB gz of CSS.

## Goal

🛒 **A shop page that looks exactly like the Figma design.** Omnivo's tenants sell on Facebook today and write orders
by hand. Step 26 gives each of them a public online shop. Before any of it talks to the server, this step builds what
the shopper sees, so the design can be checked on a real screen.

After this step:

- **`apps/shop` exists:** one Astro site, `pnpm --filter @omnivo/shop dev`, at `http://localhost:4321`.
- **The home page matches Figma** on a computer (`home_page`, 1440px) and on a phone (`home_page_mobile`, 393px):
  header, hero banner, category filters, the product grid, the "Mega Sale" banner, three product rows with arrows,
  Load More and the footer.
- **"Add to cart" works** in the browser: the header's count goes up, stays after a reload and follows other tabs.
- **The data has its final shape.** The mock data passes the same Zod schemas the public API will be checked
  against, so step 26b replaces the mock and no page changes.
- **Every word goes through `t()`**, in English and Bangla.

## The whole picture

```
packages/contracts   storefront.ts: PublicShop, ShopCategory, ShopListing, HeroBanner, ImageBanner, ShopHome (Zod)
      │
      ▼
apps/shop/src/data   source.ts ── the only door ──► mock/ (today) · the public API (step 26b)
      │
      ▼
apps/shop/src/pages  index.astro: asks the source, then draws
      │                 ShopLayout ─ Header (Logo, search, CartButton) ─ main ─ Footer
      │                 HeroBanner · CategoryFilters · ProductCard ×5 · ImageBanner · ProductRow ×3 · Load More
      ▼
the browser          plain HTML and CSS; two tiny scripts: the cart count and "Add to cart" (nanostores + localStorage)

Saturday 7 Nov 2026, a shopper in Sylhet opens the shop on her phone:
  the green header, the cash-back photo, "All Categories" as pills, two featured products,
  the Mega Sale banner, "Refresh with Himalaya" (one card, swipe for the next) …
  she taps "Add to cart" on the Sprite ──► the cart button says 1, and her screen reader says "Added to cart"
  she reloads ──► still 1
```

## Not in this step, on purpose

- **No API, no database, no tenant from the `Host` header.** Step 26b. Today the pages are built once into HTML from
  the mock (`output: 'static'`).
- **No product page, cart drawer or checkout.** Step 26b. A product's name already links to `/p/<slug>`, and the cart
  button is a button that does nothing yet: both go to pages that do not exist until then.
- **No category pages, search results, chip menus, filters or sorting.** Step 26c. The chips, "Sort By", "View All"
  and "Load More" link to `/c/all` or `/c/<slug>`, which 26c builds.
- **No React in the browser.** The icons are React components, but Astro draws them into the HTML on the build
  machine. The first React island comes with the checkout form in 26b.
- **No Playwright tests.** 26c, when there are pages to walk through.

## What changes in the code you already have

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | An `overrides` entry for `@emnapi/runtime` (decision 9) |
| `.gitignore` | `.astro/` |
| `packages/config/eslint/index.js` | `**/.astro/**` in the ignores |
| `packages/config/prettier/index.js`, `packages/config/package.json` | The Astro plugin (decision 10) |
| `packages/contracts/src/index.ts` | `export * from './storefront.js'` |
| `packages/i18n/src/format.ts`, `index.ts` | `numberLocale()` |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The `shop` group |
| `CLAUDE.md` | Already done: "Storefront design system (approved 2026-11-07)" |

Everything else is new: `packages/contracts/src/storefront.ts` and the whole `apps/shop` folder.

## The decisions behind this step

1. **Astro, static for now.** The system design (§14.2) chose Astro for the shop: pages are drawn on the server and
   cached by the CDN, which is what a shop on a slow 3G phone needs. A React app like `apps/app` would send all its
   JavaScript before showing a product. `output: 'static'` builds the pages once from the mock; step 26b switches to
   `output: 'server'` and nothing in the components changes.
2. **The contract first, then the mock.** The biggest risk of a static UI is mock data in a shape the API will never
   send. The shapes are Zod schemas in `@omnivo/contracts`; the mock is typed with them (`satisfies`) and a test runs
   it through them, so a price written as `"1,199"` fails today, not on the day the API arrives.
3. **One door for data.** Every page asks `shopSource` (`src/data/source.ts`). Only that file knows the mock exists. A
   test makes sure no page imports the mock directly (decision 8).
4. **No React in the browser in this step.** The first version used a React island for the cart count. It sent about
   176 KB gz of JavaScript: React (66 KB), the whole app's English texts that `@omnivo/i18n` loads (83 KB) and Zod
   (25 KB), all for one number. Now the count is a small custom element (about 2 KB gz with nanostores), and the
   server hands it its words in `data-` attributes.
5. **The cart keeps only ids and counts.** Never a price or a name. The system design (§14.4) says the browser never
   sends money; prices come from the server in step 26b. A price kept in `localStorage` would also be wrong the day the
   shop changes it.
6. **Text trimmed like Figma (`text-box: trim-both cap alphabetic`).** Figma measures the space between texts from the
   top of the capital letters to the baseline, not from the line box. With the same CSS property, the browser
   measures the same way and the page matches Figma to the pixel (see the numbers at the top). Only the desktop
   texts are trimmed, because only the desktop frames in Figma are. A browser without the property (Firefox today)
   shows a few pixels more space; nothing breaks.
7. **One `<picture>` per banner.** Desktop and phone show different pictures. Two `<img>` elements, one hidden,
   would make the phone download both; `<picture>` with a `<source media>` downloads only the one that matches.
8. **The import rules are a test, not a dependency-cruiser rule.** dependency-cruiser cannot read `.astro` files. A
   rule there passed while a page imported the mock (tried on purpose). `src/boundaries.spec.ts` reads every `.ts`
   and `.astro` file as text and checks the imports.
9. **`@emnapi/runtime` pinned to 1.11.3.** `astro check` turns `.astro` files into TypeScript with a WebAssembly
   program (`@astrojs/astro2tsx`). It needs `@emnapi/runtime` 1.x next to `@emnapi/core` 1.x. Rolldown's own
   WebAssembly fallback asks for the 2.0 beta, and pnpm gave that beta to both, so `astro check` stopped at once with
   "this.bridge.setLastError is not a function", reported as "@astrojs/check is not installed". The override puts
   both on 1.11.3.
10. **Prettier formats `.astro` files.** Without `prettier-plugin-astro`, `pnpm format` skips `.astro` files
    silently. The plugin is imported in the shared config (not named as a string), so Prettier finds it inside
    `packages/config` wherever the command runs.
11. **The mock data follows Figma, with two names changed.** Figma shows "Himalaya Anti-Dandruff Soothing &
    Moisturizing…" twice and "Zero Cal Stevia 30 Sachets" twice, at different prices. Two products with one name
    would confuse a shopper and need one slug, so the second of each is "…, twin pack" and "…, gift box".

## What to export from Figma

The mock needs pictures. Put each file at the path in the first column (inside `apps/shop/public/`). Export at 2x.
Tell me when you have them, or send them and I will check the names.

| File | Figma | How |
|---|---|---|
| `mock/banners/hero-desktop.png` | `Group 1` (37:3125) in the hero | PNG, the group alone (522×313) |
| `mock/banners/hero-phone.jpg` | `hero` (138:790) on `home_page_mobile` | JPG, with `hero-content` (138:791) hidden, so only the photo is in the file |
| `mock/banners/mega-sale-desktop.png` | `Frame 35` (37:3244) | PNG, the whole banner with its words (1280×280) |
| `mock/banners/mega-sale-phone.jpg` | `mega-sale` (138:841) | JPG, the whole banner with "MEGA SALE" and its dark layer (361×140) |
| `shapes/footer-glow-left.svg` | `Vector 2` (136:1251) in `footer` | SVG of the vector alone, clipped to the footer frame (555×304) |
| `shapes/footer-glow-right.svg` | `Vector 3` (136:1252) in `footer` | SVG of the vector alone, clipped to the footer frame (528×289) |
| `mock/products/<slug>.png` (20 files) | the `image …` layer inside each card's `product_img_slot` | PNG with a transparent or white background; the slugs are in the table below |

| Slug | Figma layer |
|---|---|
| `sprite-cold-drink-500ml` | 37:3181 |
| `domex-lime-fresh-750ml` | 37:3195 |
| `tresemme-hair-fall-defense-580ml` | 37:3209 |
| `davidoff-espresso-coffee` | 37:3223 |
| `aci-pure-turmeric-200gm` | 37:3237 |
| `himalaya-vitamin-c-face-wash-100ml` | 37:3265 |
| `himalaya-anti-dandruff-shampoo-180ml` | 37:3279 |
| `himalaya-anti-dandruff-twin-pack` | 37:3292 |
| `himalaya-oil-control-lemon-face-wash-100ml` | 37:3306 |
| `himalaya-anti-hair-fall-shampoo-180ml` | 37:3320 |
| `ispahani-mirzapore-bestleaf-400gm` | 37:3341 |
| `seylon-family-blend-tea-400gm` | 37:3355 |
| `ispahani-mirzapore-bestleaf-200gm` | 37:3369 |
| `pusti-plus-full-cream-milk-1kg` | 37:3383 |
| `dano-daily-pushti-milk-1kg` | 37:3397 |
| `cyprina-apple-juice-1ltr` | 37:3418 |
| `zero-cal-stevia-30-sachets` | 37:3432 |
| `sis-low-gi-sugar-350gm` | 37:3446 |
| `zero-cal-stevia-box` | 37:3460 |
| `cyprina-mango-orange-apple-juice-1ltr` | 37:3474 |

The discount ribbon and the hero's slanted panel need no file: they are drawn in code from Figma's own shapes.

These are brand product photos (Sprite, Himalaya…). They are fine as mock data on your machine. Do not ship them in a
public demo: a real shop's photos come from its own listings in step 26b.

---

## 26a.1 — The workspace

### `pnpm-workspace.yaml`

Add at the end:

```yaml
overrides:
  # Step 26a: @astrojs/check's .astro-to-TypeScript converter runs as WebAssembly and needs
  # @emnapi/runtime 1.x next to @emnapi/core 1.x. rolldown's own WebAssembly fallback asks for the
  # 2.0 beta, and pnpm handed that beta to both, so `astro check` crashed on start.
  '@emnapi/runtime': 1.11.3
```

`overrides` replaces a package's version everywhere in the tree, for every package that asks for it. That is what is
needed here: the bad combination comes from pnpm sharing one peer version between two unrelated packages. The comment
says why, so whoever removes it later (when Astro's tools move to emnapi 2) knows what to test: `astro check` must
start.

### `.gitignore`

```gitignore
# Astro writes its generated types here on every `astro check` / `astro dev`
.astro/
```

`astro check` and `astro dev` write `apps/shop/.astro/` each time. It is output, like `dist/`. In git it would change
in every commit that touches a page.

### `packages/config/eslint/index.js`

In the `ignores` list, after `'**/mockServiceWorker.js',`:

```js
      // Step 26a: Astro's generated types (apps/shop/.astro), rewritten by every `astro check`
      '**/.astro/**',
```

ESLint reads `.d.ts` files too. Astro's generated files use triple-slash references and `import()` types, which our
strict rules refuse (27 errors before this line). They are not our code, so they are left out, like `dist/`.

### `packages/config/prettier/index.js`

The whole file:

```js
// Step 26a: imported here, not named as a string, so Prettier finds the plugin in this package's
// node_modules wherever the command runs from (a string is looked up from the working directory)
import * as astroPlugin from 'prettier-plugin-astro';

/** @type {import("prettier").Config} */
export default {
  semi: true,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',
  // The shop's .astro files: without the plugin Prettier cannot parse them, and `pnpm format`
  // skips them without a word
  plugins: [astroPlugin],
  overrides: [{ files: '*.astro', options: { parser: 'astro' } }],
};
```

- **Why an import:** with `plugins: ['prettier-plugin-astro']`, Prettier looks for the package from the folder you
  run it in (the repo root), where it is not installed, and stops with "Cannot find package". An imported module is
  already found, from this file's own `node_modules`.
- **Why the override:** it tells Prettier which parser a `.astro` file needs, so `prettier --check .` checks them
  instead of skipping them.

### `packages/config/package.json`

In `devDependencies`, after `"prettier"`:

```json
    "prettier-plugin-astro": "^1.1.2",
```

Then run `pnpm install` at the root (also after 26a.4, which adds the shop's own packages).

---

## 26a.2 — `packages/contracts`: the shop's data

### `src/storefront.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { isMoneyAmount } from './money.js';
import { LANGUAGE_CODES } from './preferences.js';

// Step 26a: what the public shop reads. Today the shop's mock data has this shape; from step 26b on,
// the public API (/public/v1) sends exactly this, so the pages never change when the data goes live.
// Nothing here is a form: the browser never sends a price, so every schema is an answer, not input.

// A shop price: a decimal string like the rest of the app (CLAUDE.md → Money), never a number
const shopMoneySchema = z.string().refine(isMoneyAmount, errorCode('money_format'));

// A CSS color for the tenant's theme and a banner's colors: #rrggbb only, so it can go straight
// into a style attribute without any chance of injecting other CSS
const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

// A path on the shop's own site or an absolute https URL. Never javascript: or data: links, because
// banner links come from the tenant and end up in an <a href>
const linkSchema = z.string().regex(/^(\/(?!\/)|https:\/\/)/);

// A picture and the words a screen reader says for it. The alt text is required: a product photo
// is the main content of a shop, and an empty alt would hide it from blind shoppers
export const shopImageSchema = z.object({
  url: linkSchema,
  alt: z.string().min(1),
});

export const shopThemeSchema = z.object({
  // CLAUDE.md → Storefront: only these two come from the tenant; every other color is fixed
  brand: hexColorSchema,
  accent: hexColorSchema,
});

export const publicShopSchema = z.object({
  name: z.string().min(1),
  // null: the shop has no logo of its own, so the Omnivo mark is drawn next to its name
  logo: shopImageSchema.nullable(),
  language: z.enum(LANGUAGE_CODES),
  theme: shopThemeSchema,
  hotline: z.string().min(1),
  address: z.string().min(1),
  social: z.object({
    facebook: linkSchema.nullable(),
    instagram: linkSchema.nullable(),
    x: linkSchema.nullable(),
    linkedin: linkSchema.nullable(),
  }),
});

export const shopCategorySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  // null for a top category; the filter row shows the top ones and opens their children
  parentId: z.string().min(1).nullable(),
});

export const SHOP_BADGES = ['most_picked', 'new', 'buy_one_get_one'] as const;

export const shopDiscountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), value: shopMoneySchema }),
  z.object({ kind: z.literal('percent'), value: z.number().int().min(1).max(99) }),
]);

export const shopListingSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  // The pack size printed under the name ("500ml", "90(±)10gm"): words for people, not a quantity
  packSize: z.string(),
  images: z.array(shopImageSchema).min(1),
  price: shopMoneySchema,
  // The price before the sale, struck through on the product page; null when there is no sale
  compareAtPrice: shopMoneySchema.nullable(),
  saleUntil: z.iso.datetime({ offset: true }).nullable(),
  discount: shopDiscountSchema.nullable(),
  badges: z.array(z.enum(SHOP_BADGES)),
  inStock: z.boolean(),
  categoryId: z.string().min(1),
});

// The big banner at the top of the home page. Desktop and phone draw it differently (CLAUDE.md →
// Hero banner), so it carries both pictures and every word either layout shows
export const heroBannerSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('hero'),
  href: linkSchema,
  headline: z.string().min(1),
  line: z.string().nullable(),
  eyebrow: z.string().nullable(),
  buttonLabel: z.string().min(1),
  desktopImage: shopImageSchema,
  phoneImage: shopImageSchema,
  colors: z.object({
    background: hexColorSchema,
    panel: hexColorSchema,
    button: hexColorSchema,
    buttonText: hexColorSchema,
  }),
});

// A banner that is only a picture ("Mega Sale"): its words are part of the image
export const imageBannerSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('image'),
  href: linkSchema,
  desktopImage: shopImageSchema,
  phoneImage: shopImageSchema,
});

export const shopCollectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  // 'fire': the flame icon after the title, in place of the 🔥 the design used
  icon: z.enum(['fire']).nullable(),
  listings: z.array(shopListingSchema).min(1),
});

export const shopHomeSchema = z.object({
  hero: heroBannerSchema,
  // The "All Category" grid; the phone shows its first two as "Featured Products"
  featured: z.array(shopListingSchema),
  hasMoreFeatured: z.boolean(),
  blocks: z.array(
    z.discriminatedUnion('kind', [
      imageBannerSchema,
      z.object({ kind: z.literal('collection'), collection: shopCollectionSchema }),
    ]),
  ),
});

export type ShopImage = z.infer<typeof shopImageSchema>;
export type ShopTheme = z.infer<typeof shopThemeSchema>;
export type PublicShop = z.infer<typeof publicShopSchema>;
export type ShopCategory = z.infer<typeof shopCategorySchema>;
export type ShopBadge = (typeof SHOP_BADGES)[number];
export type ShopDiscount = z.infer<typeof shopDiscountSchema>;
export type ShopListing = z.infer<typeof shopListingSchema>;
export type HeroBanner = z.infer<typeof heroBannerSchema>;
export type ImageBanner = z.infer<typeof imageBannerSchema>;
export type ShopCollection = z.infer<typeof shopCollectionSchema>;
export type ShopHome = z.infer<typeof shopHomeSchema>;
export type ShopHomeBlock = ShopHome['blocks'][number];
```

Why each part is written this way:

- **`shopMoneySchema` reuses `isMoneyAmount`** from `money.ts`, the same check the ERP's forms use (up to 15 digits,
  up to 4 decimals). A shop price and an invoice price follow one rule. `errorCode('money_format')` gives the code
  the rest of the contracts use; a plain string here would be an error message written in code, which CLAUDE.md
  forbids.
- **`hexColorSchema` is strict on purpose.** The theme and the banner colors go into `style="…"` attributes. A value
  like `red; background: url(https://evil)` would be CSS injection. Only `#` and six hex digits can pass, so nothing
  but a color can reach the page.
- **`linkSchema` allows `/…` or `https://…` only.** Banner links are written by the tenant and end up in `<a href>`.
  `javascript:alert(1)` would run code when a shopper clicks. `(?!\/)` also refuses `//evil.com`, which a browser
  reads as "another site, same scheme".
- **`alt` is required (`min(1)`).** On a shop, the picture is the product. The API in 26b can fill it with the
  product's name when the tenant left it empty.
- **The discount is a discriminated union**, not two optional fields. `{ kind: 'amount', value: '10' }` or
  `{ kind: 'percent', value: 10 }`: the type makes "an amount with a percent" impossible, and the card can `switch`
  on `kind`. The percent is a whole number from 1 to 99 (a 0% or 100% discount is not a discount the shop shows).
- **`packSize` is a string, not a quantity.** "90(±)10gm" and "30 sachets" are words printed on the pack. The stock
  quantity stays in the ERP and is never sent to the shop (§14.2: stock is checked again at checkout).
- **`saleUntil` uses `z.iso.datetime({ offset: true })`.** The product page's countdown (26b) needs a moment, and an
  offset (`+06:00`) keeps it correct whatever the shopper's time zone.
- **`ShopHome.blocks` is a list of banners and rows**, in the order the page shows them. The tenant arranges the home
  page in step 26b's "Appearance" screen; the page only walks the list.
- **No `*InputSchema`:** the shop sends nothing back in this step. Checkout's input comes in 26b.

### `src/index.ts`

After `export * from './stock-transfers.js';` (the list is in alphabetical order):

```ts
export * from './storefront.js';
```

---

## 26a.3 — `packages/i18n`: the words

### `src/format.ts`

Right after the `NUMBER_LOCALE` line:

```ts
// Step 26a: the Intl locale for a language's numbers, for code that formats in the browser without
// loading this package (the shop's cart count is a small script, not a React island)
export function numberLocale(language: Language): string {
  return NUMBER_LOCALE[language];
}
```

The cart count is formatted in the browser (the count lives there). Importing `@omnivo/i18n` in the browser would
bring i18next and the app's English texts (decision 4). The server calls `numberLocale()` and hands the answer to the
script, so `en-IN` / `bn-BD` stays written in one place.

### `src/index.ts`

In the `export { … } from './format.js'` list, after `type MoneyFormatOptions,`:

```ts
  numberLocale,
```

### `src/locales/en.ts`

Before the comment line `// The printed quotation, order, challan, invoice and receipt (A4, the browser's Print)`
(right after the `publicDocument` group):

```ts
  // Step 26a: the tenant's public online shop (apps/shop). Its buttons keep the design's Title Case
  // ("Load More", "Sort By"), as CLAUDE.md → Storefront design system says
  shop: {
    skipToContent: 'Skip to content',
    header: {
      home: '{{shop}} home',
      search: 'Search',
      searchLabel: 'Search the shop',
      searchPlaceholder: 'Search for Cosmetics, Food',
      openSearch: 'Open search',
      closeSearch: 'Close search',
      categories: 'Categories',
      cart_one: 'Cart, {{count}} item',
      cart_other: 'Cart, {{count}} items',
      cartEmpty: 'Cart, empty',
      added: 'Added to cart',
      account: 'Account',
    },
    home: {
      title: '{{shop}}: shop online',
      allCategory: 'All Category',
      allCategories: 'All Categories',
      categoryFilters: 'Filter the products',
      all: 'All',
      offer: 'Offer',
      allFilter: 'All Filter',
      sortBy: 'Sort By',
      featured: 'Featured Products',
      viewAll: 'View All',
      loadMore: 'Load More',
      previous: 'Previous products',
      next: 'Next products',
    },
    card: {
      addToCart: 'Add to cart',
      addToCartLabel: 'Add {{name}} to cart',
      outOfStock: 'Out of Stock',
      // The ribbon's two lines: "৳10" over "OFF"
      off: 'OFF',
      // What a screen reader says for the ribbon
      discount: '{{amount}} off',
      badge: {
        most_picked: 'Most Picked',
        new: 'NEW',
        buy_one_get_one: 'Buy 1 Get 1',
      },
    },
    footer: {
      pages: 'Shop pages',
      social: '{{shop}} on social media',
      privacy: 'Privacy Policy',
      terms: 'Terms & Condition',
      about: 'About Us',
      contact: 'Contact Us',
      copyright: '©{{year}} All rights reserved by {{shop}}',
      facebook: 'Facebook',
      instagram: 'Instagram',
      x: 'X',
      linkedin: 'LinkedIn',
    },
  },
```

- **The words are Figma's, Title Case included.** CLAUDE.md's sentence-case rule is for the ERP; the storefront
  section says the shop copies Figma's copy. The comment keeps someone from "fixing" it later.
- **`cart_one` / `cart_other`:** i18next picks the form from `count` (the ERP's notifications do the same). The cart
  button needs both forms, see 26a.8.
- **`addToCartLabel` and `discount` are for screen readers.** Twenty buttons that all say "Add to cart" are twenty
  identical buttons to someone who cannot see the picture next to them; the label adds the product's name.
- **The badge keys are the contract's values** (`most_picked`…), so `t(\`shop.card.badge.${badge}\`)` type-checks:
  a new badge in `SHOP_BADGES` without its words does not compile.

### `src/locales/bn.ts`

At the same place (before `print: {`):

```ts
  shop: {
    skipToContent: 'মূল অংশে যান',
    header: {
      home: '{{shop}} হোম',
      search: 'খুঁজুন',
      searchLabel: 'দোকানে খুঁজুন',
      searchPlaceholder: 'কসমেটিকস, খাবার খুঁজুন',
      openSearch: 'খোঁজার বক্স খুলুন',
      closeSearch: 'খোঁজার বক্স বন্ধ করুন',
      categories: 'ক্যাটাগরি',
      cart_one: 'কার্ট, {{count}}টি পণ্য',
      cart_other: 'কার্ট, {{count}}টি পণ্য',
      cartEmpty: 'কার্ট, খালি',
      added: 'কার্টে যোগ হয়েছে',
      account: 'অ্যাকাউন্ট',
    },
    home: {
      title: '{{shop}}: অনলাইনে কিনুন',
      allCategory: 'সব ক্যাটাগরি',
      allCategories: 'সব ক্যাটাগরি',
      categoryFilters: 'পণ্য বাছাই করুন',
      all: 'সব',
      offer: 'অফার',
      allFilter: 'সব ফিল্টার',
      sortBy: 'সাজান',
      featured: 'বাছাই করা পণ্য',
      viewAll: 'সব দেখুন',
      loadMore: 'আরও দেখুন',
      previous: 'আগের পণ্য',
      next: 'পরের পণ্য',
    },
    card: {
      addToCart: 'কার্টে যোগ করুন',
      addToCartLabel: '{{name}} কার্টে যোগ করুন',
      outOfStock: 'স্টকে নেই',
      off: 'ছাড়',
      discount: '{{amount}} ছাড়',
      badge: {
        most_picked: 'সবচেয়ে জনপ্রিয়',
        new: 'নতুন',
        buy_one_get_one: '১টি কিনলে ১টি ফ্রি',
      },
    },
    footer: {
      pages: 'দোকানের পেজ',
      social: 'সোশ্যাল মিডিয়ায় {{shop}}',
      privacy: 'গোপনীয়তা নীতি',
      terms: 'শর্তাবলি',
      about: 'আমাদের সম্পর্কে',
      contact: 'যোগাযোগ',
      copyright: '©{{year}} সর্বস্বত্ব সংরক্ষিত, {{shop}}',
      facebook: 'Facebook',
      instagram: 'Instagram',
      x: 'X',
      linkedin: 'LinkedIn',
    },
  },
```

`bn` is typed `Messages` (the shape of `en`), so a missing key here fails the type check. The two cart forms are the
same in Bangla, but both keys must exist: `Intl.PluralRules('bn')` says "one" for 0 and 1.

---

## 26a.4 — `apps/shop`: the app

### `package.json` (new)

```json
{
  "name": "@omnivo/shop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4321",
    "build": "astro check && astro build",
    "preview": "astro preview --port 4321",
    "typecheck": "astro check",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@astrojs/react": "^7.1.4",
    "@fontsource-variable/geist": "^5.3.0",
    "@fontsource/noto-sans-bengali": "^5.3.0",
    "@hugeicons/core-free-icons": "^4.3.5",
    "@hugeicons/react": "^1.1.10",
    "@omnivo/contracts": "workspace:*",
    "@omnivo/i18n": "workspace:*",
    "astro": "^7.4.7",
    "nanostores": "^1.5.5",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.12",
    "@omnivo/config": "workspace:*",
    "@tailwindcss/vite": "^4.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "tailwindcss": "^4.3.3",
    "typescript": "^6.0.3",
    "vitest": "^5.0.1"
  }
}
```

- **`typecheck` is `astro check`.** Turbo's `typecheck` task runs every package's script, so the shop is checked with
  the rest. `astro check` checks `.astro` files and `.ts` files with the shop's `tsconfig.json`; plain `tsc` cannot
  read `.astro` files.
- **`build` checks first**, like `apps/app` (`tsc --noEmit && vite build`): a build that does not type-check never
  reaches a server.
- **Port 4321** is Astro's default and the one the build plan names (`acme.localhost:4321`). The ERP stays on its own.
- **`react` and `@astrojs/react` with no React in the browser:** the HugeIcons component is a React component, and
  Astro needs the React renderer to draw it into HTML on the build machine. Nothing is sent to the browser for it
  (decision 4). 26b's checkout form will be the first React island.
- **`@hugeicons/*` versions are the app's.** CLAUDE.md: one icon library, one version, Stroke Rounded.
- **`nanostores`** (about 1 KB) holds the cart. It is what Astro recommends for state shared between scripts and,
  later, React islands on one page (with `@nanostores/react` in 26b).

Run `pnpm install` at the root.

### `astro.config.ts` (new)

```ts
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// Step 26a: every page is built to HTML ahead of time from the mock data. Step 26b turns on
// `output: 'server'` with the Node adapter, when the pages read the public API per request.
export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
  // The shop is one site per tenant on its own domain (shop.acme.com), always at the root
  trailingSlash: 'never',
  build: { format: 'file' },
});
```

- **`astro.config.ts`, not `.mjs`:** it is type-checked like the rest, and ESLint's type-aware rules see it (the
  shop's `tsconfig.json` includes it).
- **Tailwind through its Vite plugin**, the same as `apps/app`. Astro's own Tailwind integration is for the older
  Tailwind 3.
- **`trailingSlash: 'never'` and `format: 'file'`:** `/track`, not `/track/`. One form of every URL means one cache
  entry per page on the CDN (§14.2) and no duplicate pages for search engines.

### `tsconfig.json` (new)

```json
{
  "extends": "../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["astro/client"],
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noEmit": true,
    "declaration": false
  },
  "include": [".astro/types.d.ts", "src/**/*", "astro.config.ts", "vitest.config.ts"],
  "exclude": ["dist"]
}
```

- **It extends the repo's base, not Astro's `strictest`.** The base has our rules (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`…); the shop follows the same ones as every other package. Astro's base adds only what
  is copied here.
- **`jsx: "react-jsx"`:** the React components (the icons today) compile with React's JSX. `.astro` files have their
  own syntax and ignore this.
- **`types: ["astro/client"]`** gives `import.meta.glob` (used by the boundary test) and Astro's types, and no Node
  types: shop code runs in a browser or at build time, and a `process.env` in a component should be an error.
- **`verbatimModuleSyntax`:** Astro and Vite compile each file alone. A type imported without `import type` would
  stay in the JavaScript and break at run time; this setting makes it a type error instead.
- **`.astro/types.d.ts`** is written by `astro check` / `astro dev`. Before the first run your editor may complain that
  it is missing; run `pnpm --filter @omnivo/shop typecheck` once.

### `vitest.config.ts` (new)

```ts
import { defineConfig } from 'vitest/config';

// Only the shop's plain TypeScript (data, cart). Astro components are checked by `astro check`
// and in the browser, not here.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
```

`node` is enough: the tests read data and the cart's pure functions, never the page.

---

## 26a.5 — `src/styles/shop.css` (new): the tokens

```css
/* Step 26a: the shop's own stylesheet (CLAUDE.md → Storefront design system). It does not import
   @omnivo/ui/styles.css: the shop has its own colors and type scale, and the ERP's tokens would
   clash with these names. */
@import 'tailwindcss';

/* Self-hosted like the app: a shop must not wait for Google Fonts, and 700 is here because the
   phone layout writes its titles and prices bold (Noto Sans Bengali draws the ৳ sign) */
@import '@fontsource-variable/geist';
@import '@fontsource/noto-sans-bengali/400.css';
@import '@fontsource/noto-sans-bengali/500.css';
@import '@fontsource/noto-sans-bengali/600.css';
@import '@fontsource/noto-sans-bengali/700.css';

:root {
  color-scheme: light;
  --canvas: #f6f7f7;
  --card: #ffffff;
  --card-glass: rgb(255 255 255 / 0.7);
  --cream: #f4f5ec;
  /* brand and accent are the tenant's theme. ShopLayout writes the shop's own pair on <html>,
     which wins over these defaults (the Figma colors) */
  --brand: #005859;
  --accent: #b8ef69;
  --price: #a70b1e;
  --promo: #cc3f29;
  --promo-soft: rgb(255 108 85 / 0.1);
  --muted: #707070;
  --muted-line: #949494;
  --body: #52524f;
  --rule: #dee1e1;
  --field: #e9e9e9;
  --on-brand-line: rgb(255 255 255 / 0.15);
  --overlay: rgb(0 25 25 / 0.6);
}

@theme inline {
  --color-canvas: var(--canvas);
  --color-card: var(--card);
  --color-card-glass: var(--card-glass);
  --color-cream: var(--cream);
  --color-brand: var(--brand);
  --color-accent: var(--accent);
  --color-price: var(--price);
  --color-promo: var(--promo);
  --color-promo-soft: var(--promo-soft);
  --color-muted: var(--muted);
  --color-muted-line: var(--muted-line);
  --color-body: var(--body);
  --color-rule: var(--rule);
  --color-field: var(--field);
  --color-on-brand-line: var(--on-brand-line);
  --color-overlay: var(--overlay);
  /* The variable package registers "Geist Variable", not "Geist" (CLAUDE.md → Typography) */
  --font-sans: 'Geist Variable', 'Noto Sans Bengali', 'Segoe UI', system-ui, sans-serif;
}

/* The type scale. Fixed values, so outside `inline`. text-sf-display, text-sf-body and so on */
@theme {
  --text-sf-display: 36px;
  --text-sf-display--line-height: 1.2;
  --text-sf-price-lg: 32px;
  --text-sf-price-lg--line-height: 1;
  --text-sf-title: 24px;
  --text-sf-title--line-height: 30px;
  --text-sf-subtitle: 20px;
  --text-sf-subtitle--line-height: 26px;
  --text-sf-body: 16px;
  --text-sf-body--line-height: 20px;
  --text-sf-small: 14px;
  --text-sf-small--line-height: 24px;
  --text-sf-meta: 12px;
  --text-sf-meta--line-height: 20px;
  --text-sf-tag: 10px;
  --text-sf-tag--line-height: 11px;
  /* The page's content is 1280px wide at most (CLAUDE.md → Container) */
  --container-shop: 1280px;
}

/* The discount ribbon's zigzag bottom: Figma's "Rectangle 3" (30×40, four teeth 5px deep), as a
   clip-path so the color stays a token and no image file is needed */
@utility ribbon-shape {
  clip-path: polygon(
    0 0,
    100% 0,
    100% 100%,
    87.5% 87.5%,
    75% 100%,
    62.5% 87.5%,
    50% 100%,
    37.5% 87.5%,
    25% 100%,
    12.5% 87.5%,
    0 100%
  );
}

/* The phone hero's photo darkens toward the bottom, where the white headline sits */
@utility hero-scrim {
  background-image: linear-gradient(to bottom, rgb(0 0 0 / 0), rgb(0 0 0 / 0.8));
}

/* The page's width: 1280px of content, 16px gutters on a phone and 32px from md, so a 1440px
   screen has the design's 80px on each side and nothing ever scrolls sideways */
@utility shop-container {
  margin-inline: auto;
  width: 100%;
  max-width: calc(var(--container-shop) + 64px);
  padding-inline: 16px;
  @variant md {
    padding-inline: 32px;
  }
}

/* Figma trims every text box to the cap height and the baseline (text-box-trim), and its spacing
   is measured between those edges. The same CSS property makes the browser match it; a browser
   without it (Firefox today) shows a few pixels more space, nothing breaks */
@utility trim-text {
  text-box: trim-both cap alphabetic;
}

/* A product row: one line of cards that scrolls sideways and snaps to a card. As many columns in
   view as the grid above it has (1, 3, 4, 5), each the width the grid's own columns would be. The
   scrollbar is hidden because the arrows are the visible control */
@utility row-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 100%;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  &::-webkit-scrollbar {
    display: none;
  }
  @variant md {
    grid-auto-columns: calc((100% - 2 * 16px) / 3);
  }
  @variant lg {
    grid-auto-columns: calc((100% - 3 * 16px) / 4);
  }
  @variant xl {
    grid-auto-columns: calc((100% - 4 * 16px) / 5);
  }
}

@layer base {
  body {
    background: var(--color-canvas);
    color: var(--color-brand);
    font-family: var(--font-sans);
    font-size: var(--text-sf-body);
    line-height: var(--text-sf-body--line-height);
    /* Figma's tracking on every text: -2% of the size */
    letter-spacing: -0.02em;
    -webkit-font-smoothing: antialiased;
  }

  h1,
  h2,
  h3 {
    text-wrap: balance;
  }

  /* Every clickable thing shows the hand (CLAUDE.md → Interaction) */
  button:not(:disabled),
  [role='button']:not([aria-disabled='true']),
  a[href],
  label[for],
  summary,
  select:not(:disabled),
  input[type='checkbox']:not(:disabled),
  input[type='radio']:not(:disabled) {
    cursor: pointer;
  }
  :disabled,
  [aria-disabled='true'] {
    cursor: not-allowed;
  }

  /* brand on white is 9:1; on the brand header the outline switches to accent (data-on-brand) */
  :focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }
  [data-on-brand] :focus-visible {
    outline-color: var(--color-accent);
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition: none !important;
      animation: none !important;
      scroll-behavior: auto !important;
    }
  }
}
```

- **`:root` and `@theme inline`, like `packages/ui/src/styles.css`.** `inline` makes `bg-brand` write
  `var(--brand)` into the CSS, not the color itself. That is what lets ShopLayout change the tenant's colors with one
  `style` attribute on `<html>`, with no rebuild per tenant (the system design says one build serves every shop).
- **The values are CLAUDE.md's table**, including the two contrast fixes (`--muted` `#707070`, `--promo`
  `#cc3f29`) and Figma's dialog overlay (`#001919` at 60%), which 26b's dialog uses.
- **The font sizes are tokens, not `text-[36px]`:** CLAUDE.md's rule for the app, kept here. A few sizes appear
  only once and only on one screen size (the phone hero's 28px, the logo's word); those stay as arbitrary values next
  to their Figma node, so they are easy to find.
- **Noto Sans Bengali weight 700:** the phone frame writes prices bold, and the `৳` sign comes from this font (Geist
  has no `৳`). Without 700, the browser would fake a bold `৳` by smearing the 400.
- **`ribbon-shape`:** the 11 points are Figma's path (`M0 0H30V40L26.25 35L22.5 40…`) turned into percentages of
  30×40. A `clip-path` keeps the color a token (`bg-price`); an exported SVG would carry its own red.
- **`shop-container`:** `max-width: 1280px + 2 × 32px` with 32px padding gives exactly 1280px of content and 80px
  margins at 1440px, Figma's numbers. Under 1344px the content shrinks instead of the page scrolling sideways.
- **`row-track` columns are the grid's columns.** `(100% − 4 gaps) / 5` is exactly what `grid-cols-5 gap-4` makes, so
  a row of cards lines up with the grid above it at every width. `scroll-snap-type: x mandatory` stops a swipe on a
  card's edge; `overscroll-behavior-x: contain` keeps a sideways swipe at the end of a row from turning into the
  browser's "back" gesture.
- **`trim-text`:** decision 6. It is used with `md:` almost everywhere, because Figma's phone frame is not trimmed.
- **The base layer** repeats the app's interaction rules (CLAUDE.md applies them to the shop). The focus outline is
  `accent` inside the header: a `brand` outline on the `brand` header would be invisible.

---

## 26a.6 — `src/data`: the data door and the mock

### `src/data/types.ts` (new)

```ts
import type { PublicShop, ShopCategory, ShopHome } from '@omnivo/contracts';

// What every data source answers. Its own file, so the mock can implement it without importing
// source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
export interface ShopSource {
  shop(): Promise<PublicShop>;
  categories(): Promise<ShopCategory[]>;
  home(): Promise<ShopHome>;
}
```

Promises, although the mock answers at once: the real source waits for the network, and pages written with `await`
today need no change when it arrives.

### `src/data/source.ts` (new)

```ts
import { mockSource } from './mock/mock-source';
import type { ShopSource } from './types';

// Step 26a: the only door the pages use to get data. Today it is the mock; step 26b adds a source
// that reads the public API (/public/v1) for the shop the request's Host names, and this file picks
// it. No page or component imports the mock directly (src/boundaries.spec.ts), so swapping the
// source cannot leave one page on fake data.
export const shopSource: ShopSource = mockSource;
```

The annotation `: ShopSource` matters: the mock must have every method the real source will have, or this line fails.

### `src/data/mock/shop.ts` (new)

```ts
import type { PublicShop, ShopCategory } from '@omnivo/contracts';

// Step 26a: a made-up shop with the words and colors of the Figma design. Its name is the tenant's
// shop name; the Figma file shows "Omnivo" there, so the mock uses it too.
export const mockShop = {
  name: 'Omnivo',
  logo: null,
  language: 'en',
  theme: { brand: '#005859', accent: '#b8ef69' },
  hotline: '+880 1786 120356',
  address: 'Amigo 14 Square, House No :59/C-61/C Suite No : B-2, Level-2, Asad Ave, Dhaka 1207.',
  social: {
    facebook: 'https://facebook.com/',
    instagram: 'https://instagram.com/',
    x: 'https://x.com/',
    linkedin: 'https://linkedin.com/',
  },
} satisfies PublicShop;

export const mockCategories = [
  { id: 'cat-food', slug: 'food', name: 'Food', parentId: null },
  { id: 'cat-cosmetics', slug: 'cosmetics', name: 'Cosmetics', parentId: null },
  { id: 'cat-beverages', slug: 'beverages', name: 'Beverages', parentId: null },
  { id: 'cat-household', slug: 'household', name: 'Household', parentId: null },
  { id: 'cat-tea', slug: 'tea', name: 'Tea', parentId: 'cat-beverages' },
  { id: 'cat-diabetic', slug: 'diabetic-care', name: 'Diabetic care', parentId: 'cat-food' },
] satisfies ShopCategory[];
```

- **`satisfies`, not `: PublicShop`:** the object is checked against the type, but keeps its own narrower type.
  Change `language` to `'bn'` and run `pnpm --filter @omnivo/shop dev` to see the whole shop in Bangla.
- **`logo: null`** shows the Omnivo mark, as you asked (CLAUDE.md → Logo).
- **Two child categories** (Tea, Diabetic care) are there so the filter row's "top categories only" has something to
  leave out.

### `src/data/mock/listings.ts` (new)

```ts
import type { ShopBadge, ShopListing } from '@omnivo/contracts';

// Step 26a: the products of the Figma design, with their names, pack sizes and prices. The photos
// are files in public/mock/products/, named after the slug (the guide lists them).
interface MockProduct {
  slug: string;
  name: string;
  packSize: string;
  price: string;
  categoryId: string;
  badges?: ShopBadge[];
  // undefined: the design's "৳10 OFF" ribbon, which almost every card has; null: no ribbon
  discount?: ShopListing['discount'];
  inStock?: boolean;
}

function listing(product: MockProduct): ShopListing {
  return {
    id: `lst-${product.slug}`,
    slug: product.slug,
    name: product.name,
    packSize: product.packSize,
    images: [{ url: `/mock/products/${product.slug}.png`, alt: product.name }],
    price: product.price,
    compareAtPrice: null,
    saleUntil: null,
    discount: product.discount === undefined ? { kind: 'amount', value: '10' } : product.discount,
    badges: product.badges ?? [],
    inStock: product.inStock ?? true,
    categoryId: product.categoryId,
  };
}

const PICKED: ShopBadge[] = ['most_picked'];

export const featuredListings: ShopListing[] = [
  listing({
    slug: 'sprite-cold-drink-500ml',
    name: 'Cold drinks (Sprite)',
    packSize: '500ml',
    price: '50',
    categoryId: 'cat-beverages',
    badges: PICKED,
  }),
  listing({
    slug: 'domex-lime-fresh-750ml',
    name: 'Domex Lime Fresh Toilet Cleaner',
    packSize: '750ml',
    price: '98',
    categoryId: 'cat-household',
  }),
  listing({
    slug: 'tresemme-hair-fall-defense-580ml',
    name: 'TRESemmé HD Hair Fall Defense Shampoo',
    packSize: '580ml',
    price: '850',
    categoryId: 'cat-cosmetics',
    badges: PICKED,
  }),
  listing({
    slug: 'davidoff-espresso-coffee',
    name: 'Davidoff Espresso Coffee',
    packSize: '90(±)10gm',
    price: '1199',
    categoryId: 'cat-beverages',
  }),
  listing({
    slug: 'aci-pure-turmeric-200gm',
    name: 'ACI Pure Turmeric (Holud) Powder',
    packSize: '200gm',
    price: '130',
    categoryId: 'cat-food',
    badges: PICKED,
  }),
];

export const himalayaListings: ShopListing[] = [
  listing({
    slug: 'himalaya-vitamin-c-face-wash-100ml',
    name: 'Himalaya Brightening Vitamin-C Orange Face Wash',
    packSize: '100ml',
    price: '159',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-shampoo-180ml',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
    packSize: '180(±)10ml',
    price: '229',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-dandruff-twin-pack',
    name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo, twin pack',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-cosmetics',
    badges: ['new', 'buy_one_get_one'],
    discount: null,
  }),
  listing({
    slug: 'himalaya-oil-control-lemon-face-wash-100ml',
    name: 'Himalaya Oil Control Lemon Face Wash',
    packSize: '100ml',
    price: '200',
    categoryId: 'cat-cosmetics',
  }),
  listing({
    slug: 'himalaya-anti-hair-fall-shampoo-180ml',
    name: 'Himalaya Anti Hair Fall Shampoo',
    packSize: '180(±)10ml',
    price: '270',
    categoryId: 'cat-cosmetics',
  }),
];

export const trendingListings: ShopListing[] = [
  listing({
    slug: 'ispahani-mirzapore-bestleaf-400gm',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '400gm',
    price: '248',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'seylon-family-blend-tea-400gm',
    name: 'Seylon Family Blend Tea',
    packSize: '400gm',
    price: '205',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'ispahani-mirzapore-bestleaf-200gm',
    name: 'Ispahani Mirzapore Bestleaf',
    packSize: '200gm',
    price: '126',
    categoryId: 'cat-tea',
    badges: PICKED,
  }),
  listing({
    slug: 'pusti-plus-full-cream-milk-1kg',
    name: 'Pusti Plus Instant Full Cream Milk Powder',
    packSize: '1kg',
    price: '950',
    categoryId: 'cat-food',
    badges: PICKED,
  }),
  // Out of stock on purpose, so the disabled button is on the page
  listing({
    slug: 'dano-daily-pushti-milk-1kg',
    name: 'Dano Daily Pushti Milk',
    packSize: '1kg',
    price: '780',
    categoryId: 'cat-food',
    badges: PICKED,
    inStock: false,
  }),
];

export const diabeticListings: ShopListing[] = [
  listing({
    slug: 'cyprina-apple-juice-1ltr',
    name: 'Cyprina Apple Juice',
    packSize: '1ltr',
    price: '625',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'zero-cal-stevia-30-sachets',
    name: 'Zero Cal Stevia 30 Sachets',
    packSize: '30 sachets',
    price: '120',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'sis-low-gi-sugar-350gm',
    name: 'SIS Low GI Sugar Singapore',
    packSize: '350gm',
    price: '860',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'zero-cal-stevia-box',
    name: 'Zero Cal Stevia 30 Sachets, gift box',
    packSize: '30 sachets',
    price: '950',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
  listing({
    slug: 'cyprina-mango-orange-apple-juice-1ltr',
    name: 'Cyprina Natural Mango Orange & Apple Juice',
    packSize: '1ltr',
    price: '780',
    categoryId: 'cat-diabetic',
    badges: PICKED,
  }),
];
```

- **`listing()` fills what every mock product has the same way** (an id from the slug, one photo, no sale), so the 20
  entries only say what differs. `discount: undefined` means "the usual ৳10 ribbon" and `null` means "no ribbon";
  that is why the check is `=== undefined`, not `??`, which would turn `null` into a ribbon too.
- **Prices are strings without a comma** (`'1199'`, not `'1,199'`): money is a decimal string; the comma is
  formatting, added by `formatMoney`.
- **One out-of-stock product** (Dano) puts the disabled button on the page, so you can see its look while you build.
- **Two names differ from Figma** (decision 11).

### `src/data/mock/home.ts` (new)

```ts
import type { ShopHome } from '@omnivo/contracts';

import { diabeticListings, featuredListings, himalayaListings, trendingListings } from './listings';

// Step 26a: the home page of the Figma design, top to bottom
export const mockHome = {
  hero: {
    id: 'bnr-cashback',
    kind: 'hero',
    href: '/c/cosmetics',
    headline: 'Get 10% Cash-back on Shopping ৳150',
    line: 'Shop your favorite brands and save big this season.',
    eyebrow: 'Exclusive offer',
    buttonLabel: 'Get 10% Cashback',
    desktopImage: { url: '/mock/banners/hero-desktop.png', alt: 'Make-up and skin care products' },
    phoneImage: { url: '/mock/banners/hero-phone.jpg', alt: 'Make-up and skin care products' },
    colors: { background: '#eee0d8', panel: '#54260a', button: '#e7d1b2', buttonText: '#8b471f' },
  },
  featured: featuredListings,
  hasMoreFeatured: true,
  blocks: [
    {
      id: 'bnr-mega-sale',
      kind: 'image',
      href: '/c/cosmetics',
      desktopImage: { url: '/mock/banners/mega-sale-desktop.png', alt: 'Himalaya mega sale' },
      phoneImage: { url: '/mock/banners/mega-sale-phone.jpg', alt: 'Himalaya mega sale' },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-himalaya',
        title: 'Refresh with Himalaya',
        icon: null,
        listings: himalayaListings,
      },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-trending',
        title: 'Hot & Trending Right Now',
        icon: 'fire',
        listings: trendingListings,
      },
    },
    {
      kind: 'collection',
      collection: {
        id: 'col-diabetic',
        title: 'Diabetic Corner',
        icon: null,
        listings: diabeticListings,
      },
    },
  ],
} satisfies ShopHome;
```

- **`৳150`, not `$150`:** your decision on Figma's dollar signs.
- **The hero's colors are Figma's:** the background `#EEE0D8`, the button `#E7D1B2` with `#8B471F` text, and the
  panel `#54260A` (the dark brown of Figma's "Rectangle 4"). They are banner data, not tokens (CLAUDE.md), because
  each banner a tenant uploads has its own.
- **"Exclusive offer" is written in normal case** and the phone hero shows it in capitals with CSS (`uppercase`). A
  screen reader then reads a phrase, not the letters "E-X-C…".

### `src/data/mock/mock-source.ts` (new)

```ts
import type { ShopSource } from '../types';
import { mockHome } from './home';
import { mockCategories, mockShop } from './shop';

// The mock answers at once. Still a promise, so the pages are written for the real source, which
// waits for the network
export const mockSource: ShopSource = {
  shop: () => Promise.resolve(mockShop),
  categories: () => Promise.resolve(mockCategories),
  home: () => Promise.resolve(mockHome),
};
```

`Promise.resolve(…)` instead of `async () => mockShop`: an `async` function with no `await` inside fails our ESLint
rule `require-await`.

### `src/data/mock/mock.spec.ts` (new)

```ts
import { publicShopSchema, shopCategorySchema, shopHomeSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockHome } from './home';
import { mockCategories, mockShop } from './shop';

// `satisfies` checks the shape at compile time, but not what only runtime sees: a price like
// "1,199" is a string to TypeScript and still wrong. The schemas the real API will be checked
// against catch it here, so the mock can never teach the pages something the API won't send.
describe('the mock shop', () => {
  it('matches the public contract', () => {
    expect(() => publicShopSchema.parse(mockShop)).not.toThrow();
    expect(() => shopCategorySchema.array().parse(mockCategories)).not.toThrow();
    expect(() => shopHomeSchema.parse(mockHome)).not.toThrow();
  });

  it('gives every listing a unique id and slug', () => {
    const listings = [
      ...mockHome.featured,
      ...mockHome.blocks.flatMap((block) =>
        block.kind === 'collection' ? block.collection.listings : [],
      ),
    ];
    expect(new Set(listings.map((listing) => listing.id)).size).toBe(listings.length);
    expect(new Set(listings.map((listing) => listing.slug)).size).toBe(listings.length);
  });

  it('puts every listing in a known category', () => {
    const ids = new Set(mockCategories.map((category) => category.id));
    for (const listing of mockHome.featured) expect(ids.has(listing.categoryId)).toBe(true);
  });
});
```

The unique-slug test is what found decision 11: two products with the same name would get one URL (`/p/<slug>`) in
26b. The `flatMap` returns `[]` for banners, so TypeScript narrows `block` to a collection inside the other branch.

---

## 26a.7 — `src/lib`: words and the cart

### `src/lib/locale.ts` (new)

```ts
import { formatMoney, i18n, setLanguage, type Language } from '@omnivo/i18n';

// Step 26a: the words and number format of one page, worked out once in the page and handed to
// every component. The shop speaks its own language (PublicShop.language), not the shopper's last
// choice in the ERP, so the stored preference is neither read nor written here.
export async function shopLocale(language: Language) {
  // Loads the language's words (Bangla is a chunk of its own). It also makes it the current
  // language, which step 26b's React islands render with on the server. remember: false, so the
  // build never writes a preference
  await setLanguage(language, { remember: false });
  // A t() fixed to this language: the components never depend on which language is current
  const t = i18n.getFixedT(language);
  return {
    t,
    language,
    money: (value: string) => shopMoney(value, language),
  };
}

export type ShopLocale = Awaited<ReturnType<typeof shopLocale>>;

// A shop price is a unit price: whole taka when it is whole ("৳1,199"), paisa only when it has
// them ("৳49.50"). CLAUDE.md → Money keeps decimals for unit prices only; this keeps a shelf of
// whole prices from showing ".00" on every card.
export function shopMoney(value: string, language: Language): string {
  const hasPaisa = /\.\d*[1-9]/.test(value);
  return formatMoney(value, language, { decimals: hasPaisa ? 2 : 0 });
}
```

- **Why not `useLocale()`:** that is a React hook. `.astro` files run once on the build machine (later per request);
  they cannot use hooks. `setLanguage` is how `@omnivo/i18n` loads a language (Bangla is a separate chunk), and
  `getFixedT(language)` gives a `t` that always speaks that language. In 26b, when one server answers many shops in
  different languages at the same time, the fixed `t` keeps one request's words from leaking into another's.
- **The return type is inferred** (`ShopLocale`), so `t` keeps i18next's typed keys: `t('shop.home.viewAl')` is a type
  error in every `.astro` file (tried on purpose, see the top).
- **`shopMoney`:** `/\.\d*[1-9]/` is true only when a non-zero digit follows the point. `'1199'`, `'1199.00'` and
  `'1199.0000'` (the API sends 4 decimals, like NUMERIC(19,4)) all show `৳1,199`; `'49.50'` shows `৳49.50`.

### `src/lib/cart.ts` (new)

```ts
import { atom, computed, onMount } from 'nanostores';

// Step 26a: the cart, kept in this browser. Only the listing and how many: never a price or a
// name. Step 26b asks the server for the prices (system design §14.4: the browser never sends
// money), and a price kept here would go stale the day the shop changes it.
const STORAGE_KEY = 'omnivo.shop.cart';
export const MAX_QUANTITY = 99;

export interface CartLine {
  listingId: string;
  quantity: number;
}

// Anything can be in localStorage: an older version's format, a hand edit, another script on the
// same domain. A hand-written guard instead of a Zod schema: Zod would add 25 KB gz to every page
// for this one check.
function isCartLine(value: unknown): value is CartLine {
  if (typeof value !== 'object' || value === null) return false;
  const { listingId, quantity } = value as Record<string, unknown>;
  return (
    typeof listingId === 'string' &&
    listingId !== '' &&
    typeof quantity === 'number' &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_QUANTITY
  );
}

export function parseCart(raw: string | null): CartLine[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    // All or nothing: one bad line means the stored cart is not ours, so start empty
    return Array.isArray(value) && value.every(isCartLine) ? value : [];
  } catch {
    return [];
  }
}

function readStored(): CartLine[] {
  try {
    return parseCart(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode or blocked storage: an empty cart that still works for this page view
    return [];
  }
}

function writeStored(lines: CartLine[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    // Not saved: the cart lives until the tab closes, which is still better than an error
  }
}

export const $cart = atom<CartLine[]>([]);

export const $cartCount = computed($cart, (lines) =>
  lines.reduce((count, line) => count + line.quantity, 0),
);

let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  $cart.set(readStored());
}

// The first subscriber (the header's cart count) loads the stored cart and follows other tabs:
// adding in one tab updates the count in every tab of the shop.
onMount($cart, () => {
  load();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) $cart.set(readStored());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
  };
});

export function addLine(lines: CartLine[], listingId: string): CartLine[] {
  const existing = lines.find((line) => line.listingId === listingId);
  if (!existing) return [...lines, { listingId, quantity: 1 }];
  return lines.map((line) =>
    line.listingId === listingId
      ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY) }
      : line,
  );
}

export function addToCart(listingId: string): void {
  // A click can come before anything has subscribed; without this it would write a cart of one
  // line over the stored one
  load();
  const next = addLine($cart.get(), listingId);
  $cart.set(next);
  writeStored(next);
}
```

- **`value as Record<string, unknown>`** is the one cast in this step. After `typeof value === 'object' && value !==
  null`, TypeScript knows only `object`, which has no properties to read. `Record<string, unknown>` lets us read
  `listingId` and `quantity` as `unknown` and check each one; nothing is trusted without a check. It is not `any`.
- **Every `localStorage` call is in a `try`.** Safari's private mode, a full disk or blocked site data make it throw.
  The shop must still sell; the cart then lives for this page view.
- **`$cart` starts empty and loads on the first subscriber (`onMount`).** The server draws "Cart, empty"; the browser
  fills in the stored count right after. Loading at import time would also work today, but in 26b a React island
  rendered on the server would then show a different count than its HTML (a hydration error). Writing it this way now
  saves a rewrite.
- **`load()` inside `addToCart`, and the `loaded` flag:** if a click came before the count subscribed (a very fast
  click on a slow phone), `$cart.get()` would be `[]` and the write would erase the stored cart. The flag stops a
  second `load()` from undoing a change made in between.
- **The `storage` event** fires in the *other* tabs when one tab writes. Two open tabs keep one count.
- **`addLine` is a pure function, exported:** the test checks it without a browser.
- **99 at most:** a line is one product. More than 99 of one item from a shop page is a mistake or a script; 26b's
  server will check stock anyway.

### `src/lib/cart.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import { addLine, MAX_QUANTITY, parseCart } from './cart';

describe('parseCart', () => {
  it('reads a cart this code wrote', () => {
    const raw = JSON.stringify([{ listingId: 'lst-a', quantity: 2 }]);
    expect(parseCart(raw)).toEqual([{ listingId: 'lst-a', quantity: 2 }]);
  });

  it('starts empty for nothing stored, broken JSON or a foreign shape', () => {
    expect(parseCart(null)).toEqual([]);
    expect(parseCart('{not json')).toEqual([]);
    expect(parseCart('{"listingId":"lst-a","quantity":1}')).toEqual([]);
    // An older format that kept prices: one bad line drops the whole cart
    expect(
      parseCart(
        JSON.stringify([
          { listingId: 'lst-a', quantity: 1 },
          { listingId: 'lst-b', quantity: '2' },
        ]),
      ),
    ).toEqual([]);
  });

  it('refuses quantities a shopper cannot have', () => {
    for (const quantity of [0, -1, 1.5, MAX_QUANTITY + 1]) {
      expect(parseCart(JSON.stringify([{ listingId: 'lst-a', quantity }]))).toEqual([]);
    }
  });
});

describe('addLine', () => {
  it('adds a new line with one, and one more to a line already there', () => {
    const once = addLine([], 'lst-a');
    expect(once).toEqual([{ listingId: 'lst-a', quantity: 1 }]);
    expect(addLine(once, 'lst-a')).toEqual([{ listingId: 'lst-a', quantity: 2 }]);
    expect(addLine(once, 'lst-b')).toEqual([
      { listingId: 'lst-a', quantity: 1 },
      { listingId: 'lst-b', quantity: 1 },
    ]);
  });

  it('stops at the most a line can hold', () => {
    const full = [{ listingId: 'lst-a', quantity: MAX_QUANTITY }];
    expect(addLine(full, 'lst-a')).toEqual(full);
  });
});
```

Importing `cart.ts` in Node is safe: `onMount` only runs when something subscribes, and the tests never subscribe, so
`window` and `localStorage` are never touched.

---

## 26a.8 — The frame: layout, header, logo, cart button, footer

### `src/layouts/ShopLayout.astro` (new)

```astro
---
import '../styles/shop.css';

import type { PublicShop } from '@omnivo/contracts';

import Footer from '../components/Footer.astro';
import Header from '../components/Header.astro';
import type { ShopLocale } from '../lib/locale';

// Step 26a: the frame of every shop page: <html> in the shop's language and colors, the header,
// the page, the footer. A page passes the shop and its locale, worked out once in the page.
interface Props {
  shop: PublicShop;
  locale: ShopLocale;
  title: string;
}

const { shop, locale, title } = Astro.props;
const { t } = locale;

// The tenant's two theme colors win over the stylesheet's defaults. They are #rrggbb (the contract
// checks that), so nothing else can be written into this style attribute.
const theme = `--brand: ${shop.theme.brand}; --accent: ${shop.theme.accent}`;
---

<!doctype html>
<html lang={locale.language} style={theme}>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content={shop.theme.brand} />
    <title>{title}</title>
  </head>
  <body>
    <a
      href="#main"
      class="sr-only rounded-lg bg-card px-4 py-2 font-semibold focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      {t('shop.skipToContent')}
    </a>
    <div class="shop-container">
      <Header shop={shop} locale={locale} />
      <main id="main">
        <slot />
      </main>
      <Footer shop={shop} locale={locale} />
    </div>

    <script>
      import { addToCart } from '../lib/cart';

      // One listener for every "Add to cart" on the page, instead of an island per card: a home
      // page has 20 cards, and each island would load React for one click.
      document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest<HTMLButtonElement>('[data-add-to-cart]');
        const listingId = button?.dataset.addToCart;
        if (listingId) addToCart(listingId);
      });
    </script>
  </body>
</html>
```

- **`import '../styles/shop.css'` in the frontmatter:** Astro bundles the CSS and puts one `<link>` in the page.
- **`lang` and the theme on `<html>`:** the screen reader's voice, the browser's font choice for Bangla and every
  `var(--brand)` on the page follow from these two attributes.
- **`theme-color`:** Chrome on Android paints its address bar in the shop's color, as in the Figma phone frame's top.
- **The skip link** is the first thing a keyboard reaches; it jumps past the header to `<main>`.
- **One click listener on `document`** (event delegation). The Load More button and the cards of 26c's next page get
  it for free, with no wiring per card. `closest()` finds the button when the click lands on its icon. `event.target
  instanceof Element` narrows the type (a click on text can have a text node as its target in old browsers).
- **`dataset.addToCart`** reads `data-add-to-cart`. With `noUncheckedIndexedAccess` its type is
  `string | undefined`, so the `if (listingId)` is required, and it also skips an empty value.

### `src/components/Logo.astro` (new)

```astro
---
import type { PublicShop } from '@omnivo/contracts';

// The shop's logo (CLAUDE.md → Storefront → Logo). A shop without its own logo gets the Omnivo mark:
// two offset rounded squares, a filled one and an outlined one. The mark is drawn in `em`, so one
// font-size per place sets its whole size (header 36px, phone header 24px, footer 48px / 24px).
interface Props {
  shop: PublicShop;
  place: 'header' | 'footer';
}

const { shop, place } = Astro.props;
const onBrand = place === 'header';
---

<span class:list={['inline-flex items-center', onBrand ? 'gap-2 md:gap-1' : 'gap-2 md:gap-[5px]']}>
  {shop.logo ? (
    <img
      src={shop.logo.url}
      alt=""
      class:list={[onBrand ? 'size-6 md:size-9' : 'size-6 md:size-12', 'object-contain']}
    />
  ) : (
    <span
      aria-hidden="true"
      class:list={[
        'relative block size-[1em] shrink-0',
        onBrand ? 'text-[24px] md:text-[36px]' : 'text-[24px] md:text-[48px]',
      ]}
    >
      <span
        class:list={[
          'absolute top-0 left-0 size-[0.615em] rounded-[0.19em]',
          onBrand ? 'bg-accent' : 'bg-brand',
        ]}
      />
      <span
        class:list={[
          'absolute right-0 bottom-0 size-[0.615em] rounded-[0.19em] border-[0.077em]',
          onBrand ? 'border-accent bg-brand' : 'border-brand bg-card',
        ]}
      />
    </span>
  )}
  <span
    class:list={[
      'font-bold whitespace-nowrap md:font-semibold',
      onBrand ? 'text-[20px] text-white md:text-[24px]' : 'text-[24px] text-brand md:text-[32px]',
    ]}
  >
    {shop.name}
  </span>
</span>
```

- **The mark's proportions are the app's Logo** (`packages/ui`: two 16px squares in a 26px box, radius 5px, a 2px
  border), divided by 26: 0.615, 0.19 and 0.077. In `em`, the font-size alone scales it to Figma's 24, 36 and 48px.
- **The outlined square has a fill** (`bg-brand` on the header, `bg-card` in the footer): where the squares overlap,
  the outlined one must cover the filled one, as in the ERP's logo.
- **`alt=""` on the tenant's logo:** the shop's name is written right next to it; reading it twice is noise. The link
  around it (in Header) has the label.
- **`class:list`** is Astro's built-in way to join classes from conditions. The shop has no `cn()` yet, because no
  shop component takes a `className` from outside; 26b adds one with its first React component.

### `src/components/CartButton.astro` (new)

```astro
---
import { ShoppingCart01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { numberLocale } from '@omnivo/i18n';

import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Header: the cart button and its count badge. The count lives in this
// browser, so the server draws an empty cart and the script below fills it in. A script, not a
// React island: an island would ship React and the app's translations (about 150 KB gz) for one
// number. The words it needs are worked out here and handed over in data attributes.
// Step 26b makes the button open the cart drawer.
interface Props {
  locale: ShopLocale;
}

const { locale } = Astro.props;
const { t } = locale;
---

<cart-button
  class="block"
  data-locale={numberLocale(locale.language)}
  data-label-empty={t('shop.header.cartEmpty')}
  data-label-one={t('shop.header.cart', { count: 1, replace: { count: '{{count}}' } })}
  data-label-other={t('shop.header.cart', { count: 2, replace: { count: '{{count}}' } })}
  data-label-added={t('shop.header.added')}
>
  <button
    type="button"
    aria-label={t('shop.header.cartEmpty')}
    class="relative grid size-10 place-items-center rounded-xl bg-card text-brand transition-colors duration-150 md:size-[42px] md:border md:border-on-brand-line md:bg-transparent md:text-white md:hover:bg-white/10"
  >
    <HugeiconsIcon
      icon={ShoppingCart01Icon}
      strokeWidth={1.5}
      className="size-5 md:size-6"
      aria-hidden="true"
    />
    {/* The label above says the count; the badge is only for the eye */}
    <span
      data-badge
      hidden
      aria-hidden="true"
      class="trim-text absolute -top-2 -left-2.5 rounded-full border border-accent bg-brand p-1 text-sf-meta font-semibold text-white tabular-nums"
    ></span>
  </button>
  {/* "Added to cart" for a screen reader: the badge changing is only seen, not heard */}
  <span data-status role="status" class="sr-only"></span>
</cart-button>

<script>
  import { $cartCount } from '../lib/cart';

  // A custom element: the browser runs connectedCallback for every <cart-button> on the page, and
  // the subscription ends when one is removed, with no global bookkeeping
  class CartButton extends HTMLElement {
    private unsubscribe: (() => void) | undefined;

    connectedCallback(): void {
      const button = this.querySelector('button');
      const badge = this.querySelector<HTMLElement>('[data-badge]');
      const status = this.querySelector<HTMLElement>('[data-status]');
      if (!button || !badge || !status) return;

      const {
        locale = 'en-IN',
        labelEmpty = '',
        labelOne = '',
        labelOther = '',
        labelAdded = '',
      } = this.dataset;
      const plural = new Intl.PluralRules(locale);
      const number = new Intl.NumberFormat(locale);
      let previous: number | undefined;
      let timer: number | undefined;

      this.unsubscribe = $cartCount.subscribe((count) => {
        const template = plural.select(count) === 'one' ? labelOne : labelOther;
        button.setAttribute(
          'aria-label',
          count === 0 ? labelEmpty : template.replace('{{count}}', number.format(count)),
        );
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? '99+' : number.format(count);

        // The first value is the stored cart arriving, not something the shopper did now
        if (previous !== undefined && count > previous) {
          status.textContent = labelAdded;
          window.clearTimeout(timer);
          // Cleared, so the same words are said again on the next add
          timer = window.setTimeout(() => {
            status.textContent = '';
          }, 3000);
        }
        previous = count;
      });
    }

    disconnectedCallback(): void {
      this.unsubscribe?.();
    }
  }

  customElements.define('cart-button', CartButton);
</script>
```

- **The label templates:** `t('shop.header.cart', { count: 1, replace: { count: '{{count}}' } })`. `count: 1` makes
  i18next pick the `_one` form; `replace` puts the text `{{count}}` back where the number goes. The script fills in
  the real number later. So the browser gets both plural forms in the shop's language without i18next.
- **`Intl.PluralRules` picks the form in the browser**, with the same rules i18next uses (it is built on them).
- **`numberLocale()`** makes the badge `১২` in a Bangla shop (decision 4 and 26a.3).
- **A custom element** (`<cart-button>`), not a loose `querySelector` at the top of the script. If 26b's page ever
  draws the header twice, or swaps it, each copy subscribes and unsubscribes on its own. `class="block"`: a custom
  element is inline by default.
- **The badge is `hidden` in the server's HTML** and `aria-hidden`. The button's label carries the count for a
  screen reader ("Cart, 2 items"); the badge would only repeat "2".
- **`role="status"`** is a polite live region: a screen reader says "Added to cart" after its current sentence. It
  is emptied after 3s, because a live region only speaks when its text *changes*; the second add would otherwise be
  silent.
- **`previous === undefined` on the first value:** the first value the store sends is the stored cart loading. Without
  this check, every page load would announce "Added to cart".
- **`-top-2 -left-2.5`:** Figma's badge (37:3115) sits 8px above and 10px left of the button.

### `src/components/Header.astro` (new)

```astro
---
import { Cancel01Icon, Menu01Icon, Search01Icon, User02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PublicShop } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';
import CartButton from './CartButton.astro';
import Logo from './Logo.astro';

// CLAUDE.md → Storefront → Header: one bar for both sizes. Desktop (Figma 37:3084): menu, logo,
// the search bar in the middle, cart and account. Phone (Figma 138:774): logo, then search, cart
// and account as white 40px buttons; the search button opens the search bar over the whole header.
interface Props {
  shop: PublicShop;
  locale: ShopLocale;
}

const { shop, locale } = Astro.props;
const { t } = locale;
---

<header
  data-on-brand
  data-shop-header
  class="group relative mt-4 grid h-16 grid-cols-[1fr_auto] items-center rounded-2xl bg-brand p-3 md:mt-5 md:h-18 md:grid-cols-[1fr_auto_1fr] md:px-6 md:py-0"
>
  <div class="flex items-center gap-9">
    {/* Opens the category drawer in step 26c. The phone has no menu (Figma 138:774) */}
    <button
      type="button"
      aria-label={t('shop.header.categories')}
      class="hidden text-white md:block"
    >
      <HugeiconsIcon icon={Menu01Icon} size={30} strokeWidth={1.5} aria-hidden="true" />
    </button>
    <a href="/" aria-label={t('shop.header.home', { shop: shop.name })}>
      <Logo shop={shop} place="header" />
    </a>
  </div>

  {/* On the phone the form is hidden until the search button opens it; then it covers the bar */}
  <form
    action="/search"
    method="get"
    role="search"
    class="absolute inset-0 hidden items-center gap-2 rounded-2xl bg-brand p-3 group-data-[search-open]:flex md:static md:flex md:w-80 md:p-0 lg:w-[420px]"
  >
    <label class="relative block h-10 flex-1">
      <span class="sr-only">{t('shop.header.searchLabel')}</span>
      <input
        type="search"
        name="q"
        required
        placeholder={t('shop.header.searchPlaceholder')}
        class="h-full w-full rounded-full bg-card pr-14 pl-5 text-sf-body font-medium text-brand placeholder:text-muted focus-visible:outline-accent"
      />
      <button
        type="submit"
        aria-label={t('shop.header.search')}
        class="absolute top-0.5 right-0.5 grid h-9 w-[47px] place-items-center rounded-r-full bg-accent text-brand"
      >
        <HugeiconsIcon icon={Search01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </label>
    <button
      type="button"
      data-search-close
      aria-label={t('shop.header.closeSearch')}
      class="grid size-10 place-items-center rounded-xl bg-card text-brand md:hidden"
    >
      <HugeiconsIcon icon={Cancel01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
    </button>
  </form>

  <div class="flex items-center justify-end gap-2">
    <button
      type="button"
      data-search-open
      aria-label={t('shop.header.openSearch')}
      class="grid size-10 place-items-center rounded-xl bg-card text-brand md:hidden"
    >
      <HugeiconsIcon icon={Search01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
    </button>
    <CartButton locale={locale} />
    {/* Step 26c: the order tracking page. The design's customer name needs a sign-in the shop does not have */}
    <a
      href="/track"
      class="grid size-10 place-items-center rounded-xl bg-card text-brand md:size-[42px] md:border md:border-on-brand-line md:bg-transparent md:text-white md:transition-colors md:duration-150 md:hover:bg-white/10 lg:flex lg:w-auto lg:gap-1 lg:py-2 lg:pr-2.5 lg:pl-2"
    >
      <HugeiconsIcon
        icon={User02Icon}
        strokeWidth={1.5}
        className="size-5 md:size-6"
        aria-hidden="true"
      />
      <span class="sr-only font-semibold lg:not-sr-only">{t('shop.header.account')}</span>
    </a>
  </div>
</header>

<script>
  // The phone's search button: open the search over the bar and put the cursor in it; the close
  // button or Escape puts the bar back and the focus on the search button
  for (const header of document.querySelectorAll<HTMLElement>('[data-shop-header]')) {
    const open = header.querySelector<HTMLButtonElement>('[data-search-open]');
    const close = header.querySelector<HTMLButtonElement>('[data-search-close]');
    const input = header.querySelector<HTMLInputElement>('input[type="search"]');
    if (!open || !close || !input) continue;

    const setOpen = (value: boolean): void => {
      header.toggleAttribute('data-search-open', value);
      if (value) input.focus();
      else open.focus();
    };
    open.addEventListener('click', () => {
      setOpen(true);
    });
    close.addEventListener('click', () => {
      setOpen(false);
    });
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && header.hasAttribute('data-search-open')) setOpen(false);
    });
  }
</script>
```

- **A three-column grid on desktop (`1fr auto 1fr`)** keeps the search bar in the exact middle (Figma: x 430–850 of
  1280, centered on 640) however wide the logo or the right side is. On the phone it is two columns, and the form is
  taken out of the grid (`absolute`).
- **Below `lg` the search is 320px and "Account" is an icon.** At 900px wide, the 420px bar touched the logo (seen in
  the screenshots). From `lg` (1024px) the header is Figma's.
- **`className` on `HugeiconsIcon`, not `class`:** it is a React component; Astro passes props as they are, and React
  wants `className`.
- **`size={…}` or `className="size-5 md:size-6"`:** `size` when the icon has one size, classes when it changes with
  the screen (the phone's 20px, the desktop's 24px).
- **A real `<form action="/search" method="get">`:** search works with the keyboard's Enter and without JavaScript.
  `required` stops an empty search; `role="search"` names the region for screen readers.
- **`group-data-[search-open]:flex`:** the script only toggles one attribute on the header; the CSS shows the form.
- **The account link goes to `/track`.** Figma shows a customer's name; the shop has no customer sign-in (§14: a
  phone number and a code per order). 26c builds the tracking page.
- **The script's `for … of` over every header** follows the same idea as the cart button: no global state, nothing
  breaks if there are two.

### `src/components/Footer.astro` (new)

```astro
---
import {
  Facebook01Icon,
  InstagramIcon,
  Linkedin01Icon,
  NewTwitterIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PublicShop } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';
import Logo from './Logo.astro';

// CLAUDE.md → Storefront → Footer. Desktop (Figma 37:3481): a 16px-round card, the content 440px wide
// and centered, two soft lime glows at the bottom, the copyright under the card. Phone (Figma
// 138:923): only the top corners round, the copyright inside, no glows.
interface Props {
  shop: PublicShop;
  locale: ShopLocale;
}

const { shop, locale } = Astro.props;
const { t } = locale;
const year = new Date().getFullYear();

// Only the networks the shop has filled in; the order is the design's
const social = [
  { url: shop.social.facebook, icon: Facebook01Icon, label: t('shop.footer.facebook') },
  { url: shop.social.instagram, icon: InstagramIcon, label: t('shop.footer.instagram') },
  { url: shop.social.x, icon: NewTwitterIcon, label: t('shop.footer.x') },
  { url: shop.social.linkedin, icon: Linkedin01Icon, label: t('shop.footer.linkedin') },
].flatMap((network) => (network.url === null ? [] : [{ ...network, url: network.url }]));

// Step 26c builds these pages
const pages = [
  { href: '/pages/privacy', label: t('shop.footer.privacy') },
  { href: '/pages/terms', label: t('shop.footer.terms') },
  { href: '/pages/about', label: t('shop.footer.about') },
  { href: '/pages/contact', label: t('shop.footer.contact') },
];

const copyright = t('shop.footer.copyright', { year, shop: shop.name });
---

<footer class="mt-4 md:mt-20">
  <div class="relative overflow-hidden rounded-t-3xl bg-card py-8 md:rounded-2xl md:pt-16 md:pb-16">
    {/* Figma's Vector 2 and Vector 3: blurred lime strokes, each exported clipped to the footer frame,
        so each sits in its own bottom corner at its own size (see the asset list) */}
    <img
      src="/shapes/footer-glow-left.svg"
      alt=""
      aria-hidden="true"
      loading="lazy"
      class="pointer-events-none absolute bottom-0 left-0 hidden md:block"
    />
    <img
      src="/shapes/footer-glow-right.svg"
      alt=""
      aria-hidden="true"
      loading="lazy"
      class="pointer-events-none absolute right-0 bottom-0 hidden md:block"
    />
    <div class="relative mx-auto flex max-w-[440px] flex-col items-center gap-6 md:gap-12">
      <Logo shop={shop} place="footer" />
      <div class="flex w-full flex-col items-center gap-6">
        <div class="flex flex-col items-center gap-6 md:flex-col-reverse">
          {/* The phone puts the address above the social links, the desktop below them */}
          <p class="text-center text-sf-small text-muted md:trim-text md:text-sf-body md:leading-6">
            {shop.address}
          </p>
          {social.length > 0 && (
            <ul
              aria-label={t('shop.footer.social', { shop: shop.name })}
              class="flex gap-4 md:gap-[14.6px]"
            >
              {social.map((network) => (
                <li>
                  <a
                    href={network.url}
                    rel="noopener"
                    target="_blank"
                    aria-label={network.label}
                    class="grid size-10 place-items-center rounded-full bg-cream text-brand transition-colors duration-150 hover:bg-accent"
                  >
                    <HugeiconsIcon
                      icon={network.icon}
                      strokeWidth={1.5}
                      className="size-[18px] md:size-[15px]"
                      aria-hidden="true"
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <nav aria-label={t('shop.footer.pages')}>
          {/* A paragraph of links, not a flex list: text-box trim works on a block of text only */}
          <p class="text-center text-sf-small text-brand md:trim-text md:text-sf-body md:leading-6">
            {pages.map((page, index) => (
              <>
                {index > 0 && (
                  <span aria-hidden="true" class="px-1 text-muted">
                    |
                  </span>
                )}
                <a href={page.href} class="underline-offset-3 hover:underline">
                  {page.label}
                </a>
              </>
            ))}
          </p>
        </nav>
        <p class="text-sf-meta font-normal text-muted md:hidden">{copyright}</p>
      </div>
    </div>
  </div>
  <p class="mt-[35px] mb-[34px] hidden text-center text-sf-body leading-6 md:block md:trim-text">
    {copyright}
  </p>
  <div class="h-6 md:hidden"></div>
</footer>
```

- **The `flatMap` filter:** `network.url === null ? [] : [{ ...network, url: network.url }]` drops the networks the
  shop left empty, and the spread with `url: network.url` tells TypeScript that `url` is now a `string`. A `.filter()`
  would keep the type `string | null`.
- **`md:flex-col-reverse`:** Figma puts the address above the icons on the phone and below them on desktop. One
  markup order, two visual orders; a screen reader reads the address first in both.
- **The links are a `<p>`, not a `<ul class="flex">`.** `text-box-trim` trims a block of text; on a flex list each
  item is its own box and nothing is trimmed. Measured: with the list, the footer was 26px taller than Figma's 358;
  with the paragraph, 359.
- **The separators are `aria-hidden`:** a screen reader would say "vertical line" between the links.
- **`rel="noopener"` with `target="_blank"`:** the opened page cannot reach back into the shop's tab.
- **The copyright appears twice** (inside the card on the phone, under it on desktop), each hidden on the other size.
  One element with two positions would need fragile absolute positioning.
- **Two glow images, each pinned to a bottom corner:** each SVG was exported clipped to the footer frame, so the
  left one starts at the frame's left and bottom edges (555×304) and the right one ends at its right and bottom
  edges (528×289). At 1280px they land exactly where Figma draws them. One 1280×358 image with `object-cover` would
  crop its sides on a narrower card (at 768px it cuts about 256px from each side, which removes the left glow).
- **No size classes on the glows:** the SVGs carry their own `width` and `height`, so they keep their real size and
  the blur never stretches. `bottom-0` (not `top-[54px]`) keeps them on the bottom edge when a long address makes
  the card taller.
- **The glow images are lazy and `md:block`:** they are decoration, below the fold, and the phone design has none,
  so a phone never downloads them.
- **`md:mt-20` (80px):** the space between Load More and the footer in Figma (3344 → 3424).

---

## 26a.9 — The home page

### `src/components/HeroBanner.astro` (new)

```astro
---
import type { HeroBanner } from '@omnivo/contracts';

// CLAUDE.md → Storefront → Hero banner. One element for both layouts:
// - desktop (Figma 37:3118): the banner's background color, Figma's slanted panel on the left with
//   the headline and a pill button, the product picture on the right;
// - phone (Figma 138:790): the phone photo fills the banner under a dark scrim, the eyebrow pill
//   at the top, the headline and its line at the bottom, and the whole banner is the link.
// The colors are the banner's data (#rrggbb, checked by the contract), so they go in style attributes.
interface Props {
  hero: HeroBanner;
}

const { hero } = Astro.props;
---

<section
  class="relative mt-4 h-55 overflow-hidden rounded-2xl md:h-70"
  style={`background-color: ${hero.colors.background}`}
>
  {/* One <picture>: the browser downloads only the source that matches, never both */}
  <picture>
    <source media="(min-width: 768px)" srcset={hero.desktopImage.url} />
    <img
      src={hero.phoneImage.url}
      alt={hero.phoneImage.alt}
      fetchpriority="high"
      class="absolute inset-0 size-full object-cover md:max-lg:hidden md:inset-auto md:-top-6 md:right-[47px] md:h-[313px] md:w-[522px] md:object-contain"
    />
  </picture>
  <div class="hero-scrim absolute inset-0 md:hidden"></div>

  {/* Figma's "Rectangle 4": the panel's path, drawn in the banner's panel color */}
  <svg
    aria-hidden="true"
    viewBox="0 0 588.819 280"
    class="absolute top-0 left-0 hidden h-70 w-[589px] md:block"
  >
    <path
      d="M0 0L438.603 0C456.754 0 473.93 8.21725 485.32 22.3505L571.108 128.801C588.994 150.994 593.72 181.028 583.515 207.643L555.769 280H0V0Z"
      fill={hero.colors.panel}
    ></path>
  </svg>

  <div class="relative flex h-full flex-col items-start justify-between p-5 md:absolute md:top-1/2 md:left-[102px] md:h-auto md:w-[360px] md:-translate-y-1/2 md:justify-start md:gap-9 md:p-0">
    {hero.eyebrow && (
      <p class="rounded-full bg-accent px-3 py-1.5 text-sf-meta leading-none font-bold text-brand uppercase md:hidden">
        {hero.eyebrow}
      </p>
    )}
    <div class="flex flex-col gap-2">
      <h2 class="text-[28px] leading-tight font-bold text-white md:text-sf-display md:font-semibold">
        {hero.headline}
      </h2>
      {hero.line && <p class="text-sf-small text-white/80 md:hidden">{hero.line}</p>}
    </div>
    <a
      href={hero.href}
      class="hidden rounded-full px-6 py-4 text-sf-body font-semibold md:block"
      style={`background-color: ${hero.colors.button}; color: ${hero.colors.buttonText}`}
    >
      {hero.buttonLabel}
    </a>
  </div>

  {/* The phone has no button: the whole banner is one link, named by its headline */}
  <a href={hero.href} class="absolute inset-0 md:hidden" aria-label={hero.headline}></a>
</section>
```

- **Sizes are Figma's:** 280px high on desktop (`h-70`), 220 on the phone (`h-55`); the text block 102px from the
  left and centered; the picture group 522×313, 47px from the right, 24px above the top (it is cut by the rounded
  corner, as in Figma).
- **The headline box is 360px, not Figma's 303.** Geist is wider than Roboto; at 303px the headline broke into three
  lines ("Cash-" alone at the end of one). At 360px it is Figma's two lines.
- **`fetchpriority="high"` and not lazy:** the hero is the largest thing on the first screen (the LCP element). The
  system design's target is LCP under 2.5s on 3G.
- **`md:max-lg:hidden` on the picture:** between 768 and 1024px, the 589px panel and the 522px picture would cover
  each other. There the banner shows only the panel and its words.
- **The panel is an inline `<svg>` with Figma's path**, filled with the banner's color. A CSS shape could not draw
  the rounded corners of that path exactly. (Figma also has a thin light edge on the slant, a gradient; it is not
  drawn, because a gradient is not a banner color the tenant can set.)
- **On the phone, a full-size invisible link sits on top**, named by the headline. Figma's phone hero has no button;
  the whole picture is what a thumb taps.
- **The headline is an `<h2>`;** the page's `<h1>` is the shop's name (in index.astro), so the outline of the page
  reads "Omnivo → Get 10% Cash-back… → All Category → …".

### `src/components/ImageBanner.astro` (new)

```astro
---
import type { ImageBanner } from '@omnivo/contracts';

// CLAUDE.md → Storefront → Image banner ("Mega Sale"): only a picture, its words drawn into it.
// 280px on desktop (Figma 37:3244), 140px on the phone (Figma 138:841), each with its own picture.
interface Props {
  banner: ImageBanner;
}

const { banner } = Astro.props;
---

<a href={banner.href} class="mt-4 block overflow-hidden rounded-2xl md:mt-12">
  <picture>
    <source media="(min-width: 768px)" srcset={banner.desktopImage.url} />
    <img
      src={banner.phoneImage.url}
      alt={banner.desktopImage.alt}
      loading="lazy"
      class="h-35 w-full object-cover md:h-70"
    />
  </picture>
</a>
```

The phone's "MEGA SALE" in Pacifico is part of the exported picture (see the asset list), so the phone looks like
Figma without loading another font family (CLAUDE.md allows only Geist and Noto Sans Bengali). `loading="lazy"`: it
is below the first screen.

### `src/components/CategoryFilters.astro` (new)

```astro
---
import { ArrowDown01Icon, FilterHorizontalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCategory } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Filter row. Desktop (Figma 37:3131): square chips with a chevron and
// "Sort By" on the right. Phone (Figma 138:799): round pills that wrap, categories only.
// Step 26a: every chip is a link to its category page (step 26c). The chevrons' menus, the filter
// panel and the sort menu come with that page; until then they lead to it.
interface Props {
  categories: ShopCategory[];
  locale: ShopLocale;
}

const { categories, locale } = Astro.props;
const { t } = locale;
const top = categories.filter((category) => category.parentId === null);

const chip =
  'flex h-[38px] items-center gap-2 rounded-lg px-3 text-sf-body whitespace-nowrap transition-colors duration-150';
// 36px like Figma's pills: the 1px border is inside that height, so 9px of padding, not 10
const pill =
  'block rounded-full border px-4 py-[9px] text-sf-small leading-4 transition-colors duration-150';
---

<nav aria-label={t('shop.home.categoryFilters')}>
  {/* Desktop */}
  <div class="hidden items-start justify-between md:flex">
    <ul class="flex flex-wrap items-center gap-4">
      <li>
        <a
          href="/c/all"
          aria-current="true"
          class:list={[chip, 'bg-brand font-medium text-accent']}
        >
          {t('shop.home.allCategories')}
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
        </a>
      </li>
      {top.map((category) => (
        <li>
          <a href={`/c/${category.slug}`} class:list={[chip, 'bg-card hover:bg-cream']}>
            {category.name}
            <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </li>
      ))}
      <li>
        <a href="/c/all?offer=1" class:list={[chip, 'bg-card hover:bg-cream']}>
          {t('shop.home.offer')}
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
        </a>
      </li>
      <li>
        <a href="/c/all" class:list={[chip, 'bg-card hover:bg-cream']}>
          {t('shop.home.allFilter')}
          <HugeiconsIcon
            icon={FilterHorizontalIcon}
            size={14}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </a>
      </li>
    </ul>
    <a href="/c/all" class:list={[chip, 'border border-brand font-medium hover:bg-cream']}>
      {t('shop.home.sortBy')}
      <HugeiconsIcon icon={FilterHorizontalIcon} size={14} strokeWidth={1.5} aria-hidden="true" />
    </a>
  </div>

  {/* Phone */}
  <ul class="flex flex-wrap gap-2 md:hidden">
    <li>
      <a
        href="/c/all"
        aria-current="true"
        class:list={[pill, 'border-brand bg-brand font-semibold text-accent']}
      >
        {t('shop.home.all')}
      </a>
    </li>
    {top.map((category) => (
      <li>
        <a href={`/c/${category.slug}`} class:list={[pill, 'border-rule bg-card']}>
          {category.name}
        </a>
      </li>
    ))}
  </ul>
</nav>
```

- **The chips are links, so they work today** (to pages 26c builds) and stay correct when 26c adds the chevrons'
  menus: a link that also opens a menu on its chevron.
- **Figma's "Review" chip is gone** with the reviews; the shop's top categories take its place, then "Offer" and "All
  Filter" as in Figma.
- **`aria-current="true"` on the selected chip:** "the current one of a set". `"page"` would be wrong: the home page
  is not `/c/all`.
- **Two bugs found by measuring, and their fixes:**
  - the phone pills first measured 48px for two rows instead of Figma's 80. An `<a>` is inline, and an inline box's
    vertical padding does not take up layout space. `block` fixes it;
  - then they measured 38px each: the 1px border adds 2px. Figma counts the border inside the 36px, so the padding is
    9px, and the selected pill gets a border too (`border-brand`) so all pills are the same height.
- **`whitespace-nowrap`:** at 900px wide, "Sort By" broke into two lines.
- **The selected phone pill uses `accent` text**, not Figma's white: CLAUDE.md keeps it the same as desktop.

### `src/components/ProductCard.astro` (new)

```astro
---
import { Add01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopListing } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Product card. Desktop (Figma 37:3174): 243×458, centered, the ribbon on
// the card's top edge, the picture 54px down. Phone (Figma 138:815): full width, left-aligned, the
// picture in a 160px box with the ribbon and badge inside it. One "media" box carries the ribbon
// and badge in both, so they are placed relative to it.
interface Props {
  listing: ShopListing;
  locale: ShopLocale;
}

const { listing, locale } = Astro.props;
const { t } = locale;

const discount = listing.discount;
const discountText =
  discount === null
    ? null
    : discount.kind === 'amount'
      ? locale.money(discount.value)
      : `${String(discount.value)}%`;

// NEW sits at the left when the left is free (no ribbon); the first other badge sits at the right
const newOnLeft = discountText === null && listing.badges.includes('new');
const rightBadge = listing.badges.find((badge) => !(newOnLeft && badge === 'new'));
const image = listing.images[0];
---

<article class="flex h-full flex-col gap-3 rounded-xl bg-card p-3 md:gap-0 md:overflow-hidden md:rounded-lg md:p-0 md:text-center">
  <div class="relative h-40 overflow-hidden rounded-lg bg-canvas md:h-auto md:rounded-none md:bg-card md:px-2.5 md:pt-13.5">
    {image && (
      <img
        src={image.url}
        alt={image.alt}
        loading="lazy"
        class="size-full object-contain mix-blend-multiply md:h-50"
      />
    )}
    {discountText !== null && (
      <p class="ribbon-shape absolute top-0 left-2 flex h-10 w-[30px] flex-col items-center bg-price pt-2.5 text-sf-tag font-bold text-white md:left-4">
        <span aria-hidden="true">{discountText}</span>
        <span aria-hidden="true">{t('shop.card.off')}</span>
        <span class="sr-only">{t('shop.card.discount', { amount: discountText })}</span>
      </p>
    )}
    {newOnLeft && (
      <p class="trim-text absolute top-2 left-2 rounded-full bg-brand p-[7px] text-sf-tag font-bold text-accent md:top-2.5 md:left-2.5">
        {t('shop.card.badge.new')}
      </p>
    )}
    {rightBadge && (
      <p
        class:list={[
          'trim-text absolute top-2 right-2 rounded-full p-[7px] text-sf-tag font-bold md:top-2.5 md:right-2.5',
          rightBadge === 'new' ? 'bg-brand text-accent' : 'bg-promo text-white',
        ]}
      >
        {t(`shop.card.badge.${rightBadge}`)}
      </p>
    )}
  </div>

  <div class="flex flex-col gap-1 md:mt-4 md:gap-[23px] md:px-2.5">
    <div class="flex flex-col gap-1 md:gap-4">
      {/* Desktop only: Figma trims the desktop text boxes, not the phone ones. line-clamp makes the
          block a -webkit-box, which keeps the top trim but drops the bottom one (5px at 16/20); the
          margin gives it back, and min-h keeps two lines' room for a one-line name, so the size and
          the price sit where Figma has them on every card */}
      <h3 class="line-clamp-2 text-sf-body leading-[19px] font-semibold md:-mb-[5px] md:min-h-9 md:trim-text md:leading-5">
        <a href={`/p/${listing.slug}`} class="hover:underline">
          {listing.name}
        </a>
      </h3>
      <p class="text-sf-small leading-4 text-muted md:trim-text md:text-sf-meta md:font-semibold">
        {listing.packSize}
      </p>
    </div>
    <p class="text-[18px] leading-[21px] font-bold text-price tabular-nums md:trim-text md:text-sf-title md:leading-5 md:font-semibold">
      {locale.money(listing.price)}
    </p>
  </div>

  {/* mt-auto: the button sits at the card's bottom, so a row of cards lines its buttons up */}
  <div class="mt-auto md:py-6">
    {listing.inStock ? (
      <button
        type="button"
        data-add-to-cart={listing.id}
        aria-label={t('shop.card.addToCartLabel', { name: listing.name })}
        class="flex h-11 w-full items-center justify-center gap-1 rounded-sm bg-accent pr-4 pl-2.5 text-sf-body font-semibold text-brand transition-colors duration-150 hover:bg-brand hover:text-accent md:mx-auto md:w-[195px]"
      >
        <HugeiconsIcon icon={Add01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
        {t('shop.card.addToCart')}
      </button>
    ) : (
      <button
        type="button"
        disabled
        class="flex h-11 w-full items-center justify-center rounded-sm bg-canvas text-sf-body font-semibold text-muted md:mx-auto md:w-[195px]"
      >
        {t('shop.card.outOfStock')}
      </button>
    )}
  </div>
</article>
```

This is the component the page repeats 20 times, so every number in it was measured against Figma's 37:3174 and
138:815 (desktop: 458 high, ribbon 0/40, badge 10/21, pack size 317, price 349, button 390; phone: 316 high):

- **One "media" box for both layouts.** On desktop it is the top 254px of the card (54px padding, then the 200px
  picture); on the phone it is the 160px grey box. The ribbon and the badge are positioned inside it, with one set of
  offsets per screen size, instead of two copies of the card.
- **`object-contain` and `mix-blend-multiply`:** a packshot keeps its whole shape (Figma's phone shows lifestyle
  photos cut with `cover`; a packshot would lose its cap, see CLAUDE.md). `multiply` makes a white photo background
  disappear on the grey phone box, as it does on Figma's white desktop card.
- **The text trim is desktop only**, and the name needs a correction: `line-clamp-2` turns the `<h3>` into a
  `-webkit-box`, and the browser then trims its top but not its bottom (measured: 36.4px for two lines, against 31.4
  without the clamp). `md:-mb-[5px]` gives the 5px back. `md:min-h-9` (36px, the clamped height) keeps a one-line
  name ("Cold drinks (Sprite)") as tall as a two-line one, so the size and the price sit at the same height on every
  card, as in Figma, where every name has two lines.
- **The button's wrapper has `mt-auto`;** the button itself has no margin. The first version had `mt-auto` on the
  button and `md:mt-6`, and the second replaced the first on desktop: a card with a one-line name had its button
  higher than its neighbours. Now `md:py-6` gives Figma's 24px above and below, and `mt-auto` pushes the whole block
  to the bottom of a card stretched to its row's height (`h-full`).
- **The ribbon's words:** `৳10` and `OFF` are hidden from screen readers and replaced by one phrase, "৳10 off". Read
  as two lines it would be "taka ten, O-F-F".
- **The badge logic:** Figma's "Buy 1 Get 1" card has a NEW tag at the left, where the ribbon usually is, and no
  ribbon. So `NEW` goes left only when there is no ribbon; otherwise it is just another badge at the right. One badge
  at the right at most, as in every Figma card.
- **`t(\`shop.card.badge.${rightBadge}\`)` is type-checked:** `rightBadge` is a `ShopBadge`, so the key is one of three
  known keys.
- **`data-add-to-cart={listing.id}`** is all the click needs (ShopLayout's listener). The disabled button has none,
  so it can never add.
- **The name links to `/p/<slug>`** (26b). The whole card is not a link: it would contain the button, and a button
  inside a link is invalid HTML.

### `src/components/ProductRow.astro` (new)

```astro
---
import { ArrowLeft01Icon, ArrowRight01Icon, FireIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCollection } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';
import ProductCard from './ProductCard.astro';

// CLAUDE.md → Storefront → Section header and Product rows. A titled row of cards that scrolls
// sideways inside itself: 5 cards in view at xl, 4 at lg, 3 at md, 1 on the phone. The arrows move
// it by what is in view (one card on the phone); a swipe or a trackpad works too.
interface Props {
  collection: ShopCollection;
  locale: ShopLocale;
}

const { collection, locale } = Astro.props;
const { t } = locale;
const headingId = `row-${collection.id}`;
---

<section data-product-row aria-labelledby={headingId} class="mt-4 md:mt-12">
  <div class="flex h-10 items-center justify-between md:h-[86px] md:border-b md:border-rule md:bg-canvas">
    <h2
      id={headingId}
      class="flex items-center gap-2 text-sf-subtitle leading-[23px] font-bold md:trim-text md:text-sf-display md:font-semibold"
    >
      {collection.title}
      {collection.icon === 'fire' && (
        <HugeiconsIcon
          icon={FireIcon}
          strokeWidth={1.5}
          className="size-5 text-promo md:size-8"
          aria-hidden="true"
        />
      )}
    </h2>
    <div class="flex gap-2 md:gap-4">
      <button
        type="button"
        data-row-previous
        disabled
        aria-label={t('shop.home.previous')}
        class="grid size-10 place-items-center rounded-full bg-card text-brand transition-colors duration-150 enabled:hover:bg-accent disabled:opacity-60"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-row-next
        aria-label={t('shop.home.next')}
        class="grid size-10 place-items-center rounded-full bg-card text-brand transition-colors duration-150 enabled:hover:bg-accent disabled:opacity-60"
      >
        <HugeiconsIcon icon={ArrowRight01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  </div>

  <ul data-row-track class="row-track mt-4 md:mt-9">
    {collection.listings.map((listing) => (
      <li class="snap-start">
        <ProductCard listing={listing} locale={locale} />
      </li>
    ))}
  </ul>
</section>

<script>
  // Astro bundles this once for every row on the page. Each row: the arrows scroll by the width
  // in view, and are disabled at either end, so a shopper never presses a button that does nothing.
  for (const row of document.querySelectorAll<HTMLElement>('[data-product-row]')) {
    const track = row.querySelector<HTMLElement>('[data-row-track]');
    const previous = row.querySelector<HTMLButtonElement>('[data-row-previous]');
    const next = row.querySelector<HTMLButtonElement>('[data-row-next]');
    if (!track || !previous || !next) continue;

    const update = (): void => {
      // 1px of slack: a zoomed page can leave the last scroll position a fraction short
      previous.disabled = track.scrollLeft <= 1;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
    };
    const move = (direction: 1 | -1): void => {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      track.scrollBy({ left: direction * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    };

    previous.addEventListener('click', () => {
      move(-1);
    });
    next.addEventListener('click', () => {
      move(1);
    });
    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }
</script>
```

- **The fire icon replaces the 🔥** (your decision), in `promo` like Figma's emoji colour, 32px on desktop and 20px on
  the phone. It is decoration (`aria-hidden`), so the heading reads "Hot & Trending Right Now".
- **"Previous" starts `disabled` in the HTML:** a row always starts at its beginning, and Figma draws that arrow at
  60% (the `disabled:opacity-60`). The script then decides for "next" (a row with fewer cards than fit has nothing to
  scroll to).
- **`scrollBy(clientWidth)` and snap:** one press moves a whole screen of cards (one card on the phone). The 16px gap
  after the last visible card means the scroll lands 16px short of the next card's start; `scroll-snap-type:
  mandatory` finishes the move onto the card's edge.
- **`enabled:hover:bg-accent`:** a disabled arrow does not light up under the mouse.
- **Smooth scrolling only without reduced motion**, which CLAUDE.md asks for every movement.
- **`aria-labelledby` on the `<section>`:** the region is named by its title in a screen reader's list of landmarks.
- **Phone: a 40px header row without a rule; desktop: 86px on `canvas` with a 1px `rule` line.** Both are Figma's
  (138:845 and 37:3252).

### `src/pages/index.astro` (new)

```astro
---
import CategoryFilters from '../components/CategoryFilters.astro';
import HeroBanner from '../components/HeroBanner.astro';
import ImageBanner from '../components/ImageBanner.astro';
import ProductCard from '../components/ProductCard.astro';
import ProductRow from '../components/ProductRow.astro';
import { shopSource } from '../data/source';
import ShopLayout from '../layouts/ShopLayout.astro';
import { shopLocale } from '../lib/locale';

// Step 26a: the home page (Figma 37:3083 on desktop, 138:234 on the phone)
const shop = await shopSource.shop();
const [locale, categories, home] = await Promise.all([
  shopLocale(shop.language),
  shopSource.categories(),
  shopSource.home(),
]);
const { t } = locale;
---

<ShopLayout shop={shop} locale={locale} title={t('shop.home.title', { shop: shop.name })}>
  <h1 class="sr-only">{shop.name}</h1>

  <HeroBanner hero={home.hero} />

  {/* Desktop "All Category" (Figma 37:3128); phone "All Categories" and "Featured Products" (138:797, 138:810) */}
  <section aria-labelledby="all-category" class="mt-4 md:mt-16">
    <h2
      id="all-category"
      class="text-sf-subtitle leading-[23px] font-bold md:trim-text md:text-sf-display md:font-semibold"
    >
      <span class="md:hidden">{t('shop.home.allCategories')}</span>
      <span class="hidden md:inline">{t('shop.home.allCategory')}</span>
    </h2>
    <div class="mt-3 md:mt-9">
      <CategoryFilters categories={categories} locale={locale} />
    </div>

    <div class="mt-4 flex items-center justify-between md:hidden">
      <h3 class="text-sf-subtitle leading-[23px] font-bold">{t('shop.home.featured')}</h3>
      <a href="/c/all" class="text-sf-small font-semibold underline-offset-3 hover:underline">
        {t('shop.home.viewAll')}
      </a>
    </div>
    <ul class="mt-4 grid gap-4 md:mt-9 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {home.featured.map((listing, index) => (
        // The phone shows the first two (Figma 138:814); "View All" leads to the rest
        <li class:list={[index >= 2 && 'max-md:hidden']}>
          <ProductCard listing={listing} locale={locale} />
        </li>
      ))}
    </ul>
  </section>

  {home.blocks.map((block) =>
    block.kind === 'image' ? (
      <ImageBanner banner={block} />
    ) : (
      <ProductRow collection={block.collection} locale={locale} />
    ),
  )}

  {home.hasMoreFeatured && (
    <div class="mt-4 flex justify-center pt-2 pb-6 md:mt-12 md:p-0">
      {/* Step 26c: the full list; the button's "Loading" state belongs to that page */}
      <a
        href="/c/all"
        class="flex h-[38px] items-center rounded-lg bg-card px-4 font-medium transition-colors duration-150 hover:bg-cream"
      >
        {t('shop.home.loadMore')}
      </a>
    </div>
  )}
</ShopLayout>
```

- **The shop first, then the rest in parallel.** The locale needs the shop's language; the categories and the home
  page do not wait for each other. In 26b these are three network calls, and `Promise.all` makes the page wait for
  the slowest one, not for all three in a row.
- **The vertical rhythm is the margins:** desktop 16px under the header, 64px to "All Category", 36px inside a
  section, 48px between blocks, 80px to the footer; the phone 16px everywhere. These are Figma's numbers, and the
  measured page matches them (see the top).
- **"All Category" / "All Categories":** Figma names the same block differently on each size; two spans, one per size,
  in one heading.
- **The phone shows the first two cards** of the same list (`max-md:hidden` from the third) under "Featured
  Products", which is Figma's phone frame. One list, so a product added to the grid appears on both.
- **The blocks are drawn in the data's order** with one `kind` check. TypeScript narrows `block` in each branch: an
  `ImageBanner` in the first, a collection block in the second.
- **Load More is a link for now.** Its "Loading" look (Figma's `loading_button`, `click` state) belongs to the page
  that loads more in place, 26c's category page.
- **Phone Load More: `pt-2 pb-6`:** Figma's phone puts the button 8px into a 70px block.

---

## 26a.10 — `src/boundaries.spec.ts` (new): the import rules

```ts
import { describe, expect, it } from 'vitest';

// Step 26a: the shop's import rules. They live here and not in .dependency-cruiser.cjs, because
// dependency-cruiser cannot read .astro files, and the pages are .astro files: a rule there would
// pass while a page broke it. Vite's import.meta.glob reads every source file as text.
const files = import.meta.glob<string>(['./**/*.{ts,astro}', '!./**/*.spec.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// The module names in `import x from '...'`, `import '...'` and `export ... from '...'`
const IMPORT = /^\s*(?:import|export)\s(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('shop imports', () => {
  it('reads the source files', () => {
    // A broken glob would find nothing and pass every rule below
    expect(Object.keys(files).length).toBeGreaterThan(10);
  });

  it('reaches the mock only through data/source.ts', () => {
    // A page that imports the mock would stay on fake data when source.ts switches to the API
    const offenders = Object.entries(files)
      .filter(([path]) => !path.startsWith('./data/'))
      .filter(([, source]) => importsOf(source).some((name) => name.includes('/mock/')))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('never imports the ERP app or the API', () => {
    // The shop is a public site: their code would bring signed-in screens and server code into it
    const offenders = Object.entries(files)
      .filter(([, source]) =>
        importsOf(source).some((name) => /(^@omnivo\/(app|api)\b)|\/apps\/(app|api)\//.test(name)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
```

- **`import.meta.glob` with `?raw`** is Vite's way to load files as text at build time. Vitest runs on Vite, so it
  works in the test with no Node file APIs (the shop's tsconfig has no Node types, 26a.4).
- **The first test guards the others.** A typo in the glob would find no files, and the two rules would pass on
  nothing.
- **Only the import lines are read** (`^\s*import … from '…'`), so a comment that mentions `/mock/` (like the one in
  `source.ts`) is not an import. The `^` with the `m` flag means "at the start of a line"; the frontmatter's imports
  in `.astro` files start lines too.
- **Files in `data/` may import the mock:** `source.ts` must, and the mock's files import each other.
- **Tried on purpose:** with `import { mockShop } from '../data/mock/shop'` added to `index.astro`, the test failed
  with `expected [ './pages/index.astro' ] to deeply equal []`. dependency-cruiser, with the same rule, passed.

---

## 26a.11 — Run it and check it

```sh
pnpm install
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build   # the shop reads their dist/
pnpm --filter @omnivo/shop typecheck      # astro check: 0 errors, 0 warnings, 0 hints
pnpm --filter @omnivo/shop test           # 11 tests: mock (3), cart (5), boundaries (3)
pnpm --filter @omnivo/shop dev            # http://localhost:4321
```

Then, for the whole repo (the step changed shared packages):

```sh
pnpm typecheck
pnpm lint
pnpm format        # now also checks the .astro files
pnpm test
pnpm boundaries
pnpm build
```

### What you should see

At 1440px wide (a laptop at 100% zoom, or the browser's device toolbar), next to Figma's `home_page`:

- [ ] The header 20px from the top, 72px high, the search bar in the middle, the cart and "Account" on the right.
- [ ] The hero 16px under it: the brown panel with "Get 10% Cash-back on Shopping ৳150" on two lines and the beige
      button; the make-up picture on the right.
- [ ] "All Category", the chips (All Categories selected in teal with lime text) and "Sort By" at the right.
- [ ] Five cards in a row: the red zigzag ribbon "৳10 OFF" at the top left, "Most Picked" in coral on three of them,
      the name in two lines, the pack size, the price in crimson, the lime "Add to cart". Every button in the row at
      the same height.
- [ ] The Mega Sale banner, then three rows. "Hot & Trending Right Now" ends with a coral flame. The left arrow is
      faded; the right one turns lime under the mouse.
- [ ] "Dano Daily Pushti Milk" has a grey "Out of Stock" that cannot be clicked.
- [ ] Load More, then the footer with the logo, the four social circles, the address and the four links, and the
      copyright under the footer.
- [ ] Click "Add to cart" twice: a "2" badge appears at the cart's top left. Reload: still 2. Open a second tab: 2 there
      too. Add in one tab: the other updates.
- [ ] Press Tab from the top: "Skip to content" appears first; every button and link shows a visible outline (lime
      inside the header).

At 393px wide (an iPhone 15 in the device toolbar), next to `home_page_mobile`:

- [ ] The header 16px from the top: logo on the left, three white square buttons. The search button opens a search
      box over the header; Escape or the close button puts the header back.
- [ ] The hero photo with "EXCLUSIVE OFFER", the headline and the line under it at the bottom; tapping anywhere on
      it follows the link.
- [ ] "All Categories" and the pills on two rows; "Featured Products" with "View All" and two full-width cards.
- [ ] Each row shows one card; a swipe snaps to the next card, and the arrows do the same.
- [ ] Nothing scrolls sideways.

Change `language` in `src/data/mock/shop.ts` to `'bn'`: every word, the prices (`৳১০`) and the cart count turn
Bangla. Put it back to `'en'`.

### Known differences from Figma

All of them are decisions written in CLAUDE.md → Storefront design system:

- Geist and Noto Sans Bengali in place of Roboto, Helvetica and Inter, so the hero headline box is 360px wide.
- `#707070` grey and `#CC3F29` coral for contrast.
- The cart icon in place of the bell, "Account" in place of a name, the Omnivo mark in place of the bag.
- No "Review" chip; no 🔥.
- One badge style on both sizes; packshots (`contain`) in the phone cards.
- The phone footer is 316px high (Figma 311): Figma's phone text uses Inter's line height.
- In Firefox, which does not support `text-box` yet, the desktop text sits a few pixels lower.

## What comes next

- **26b — the product page, the cart drawer and checkout:** `/p/[slug]` (Figma `product_details`, 37:3521), the cart
  drawer, `/checkout` (`checkout_process`, 37:3765) with the separate Delivery Location and Payment Method groups,
  the phone code, and the "Order Confirmed" dialog (`confirmation_status`, 41:4066). The first React island (the
  checkout form, with `@nanostores/react` and `react-hook-form` + Zod) and the server's price quote contract. I will ask
  you for the product page's gallery images and the dialog's `tick-double-03` illustration then.
- **26c — the rest:** category and search pages with the chip menus, filters, sort and the Load More "Loading" state;
  order details and tracking; the text pages; empty states; and the first Playwright tests for the shop.
- **Later, in step 26's real place in the plan:** the `storefront` module in the API, `/public/v1`, the tenant from the
  `Host` header, and `output: 'server'`.
