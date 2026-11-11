# Step 26b: Storefront, part 2 — the product page and the cart drawer

> The implementation guide for "Phase 10 → Step 26", the second part, of [build-plan.bn.md](build-plan.bn.md). Step 26
> now has four parts (26a's "What comes next" said three; this replaces it):
>
> - **26a (done):** `apps/shop`, the tokens, the data contract, the mock, the header, the footer and the home page.
> - **26b (this guide):** server mode, the product page `/p/<slug>`, and the cart drawer with prices from the server.
> - **26c:** checkout, the phone code (`/checkout/verify`), the "Order Confirmed" dialog and order details `/order/<no>`.
> - **26d:** the category and search pages (chip menus, filters, sort, Load More), tracking, the text pages, the empty
>   states and the first Playwright tests.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `7e83207`, "reports completed")
> and checked on 2026-11-11: `pnpm dedupe --check`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format`,
> `pnpm test` (995, of them 41 in `apps/shop`, 423 in `packages/contracts`), `pnpm boundaries`,
> `pnpm test:bundle-size` and `pnpm test:openapi`, all clean.
>
> **Not run:** `test:integration`, `test:tenant-leak` and the e2e suites. This step changes no code in `apps/api` or
> `apps/app`; the shared packages it touches (`contracts`, `i18n`) only gain new schemas, words and an entry, and the
> unit tests, the type check and the build of both apps cover them. The shop has no Playwright tests yet (26d).
>
> Also checked:
>
> - **The page against Figma, measured in Chromium** (Playwright, against `pnpm --filter @omnivo/shop start`). At
>   1440px: the gallery at 80,108 (524×440), the thumbnails at y 564 (119×92, x 80 / 215 / 350 / 485), the name at
>   656,184, the two buttons at y 402 (195×44), the Overview card at y 728, "Related Products" at 2304, the footer at
>   3051, the page 3490 high. Figma: the same, ±1px. At 900px the cards stack with the gallery 524px wide and
>   centered; at 393px the gallery is 361px wide and the buttons share the width. Nothing scrolls sideways at any
>   width.
> - **The cart:** "Add to cart" then "Place Order" leaves one in the cart and opens `/checkout`; the drawer shows
>   ৳229, three quick clicks on "one more" make one request and show ৳916; Escape closes it. Every drawer state
>   (empty, failed and "Try again", out of stock, a listing that is gone, the phone) is in 26b.5's checks.
> - **In Bangla** (`language: 'bn'` in the mock): the clock, the "sale ends" sentence and the drawer's amounts
>   (`৳২২৯`).
> - **Plain and missing pages:** `/p/zero-cal-stevia-30-sachets` has no countdown, thumbnails or Overview;
>   `/p/nope` answers 404.
> - **Broken on purpose, five times,** each caught by a test: the cart's quantity limit different from the contracts',
>   a component importing `src/server/`, a browser script importing the main `@omnivo/i18n` entry, `bn.ts` missing
>   `shop.product.placeOrder`, and `withLine` returning a copy.
> - **JavaScript sent to the browser:** the drawer's script is 3.0 KB gz. No React and no Zod reach the browser.

## Goal

🛍️ **A shopper can open a product, read about it, and see their cart with today's prices.** 26a drew the home page;
every "Add to cart" only raised a number. After this step:

- **`/p/<slug>` matches Figma** (`product_details`, 1440px): the gallery with four thumbnails, the info card (sale
  countdown, name, size, price, Place Order, Add to cart, stock and SKU, hotline), the Overview card and "Related
  Products". Figma has no phone frame for this page; the phone layout follows the storefront rules in `CLAUDE.md`.
- **The cart button opens a drawer** with the lines, a stepper, delete, the subtotal and "Checkout".
- **Prices come from the server.** The shop runs as a server now (`output: 'server'`), and an API route prices the
  cart. The browser still keeps only ids and counts.

## The whole picture

```
packages/contracts   storefront.ts: + ShopProduct, ShopProductPage, ShopCartQuoteRequest, ShopCartQuote (Zod)
      │
      ▼
apps/shop/src/data   source.ts ── the only door ──► mock/ (today) · /public/v1 (step 26's API)
      │                 shop() · home() · product(slug) · quote(request)
      ├──────────────────────────────────────────────┐
      ▼                                              ▼
src/pages/p/[slug].astro                       src/pages/api/cart/quote.ts  (POST, JSON in, JSON out)
  drawn per request on the server                └─► src/server/cart-quote.ts: Zod parse ─► source.quote()
  Gallery · Info card · Overview · Related             └─► 200 ShopCartQuote │ 400 problem+json
      │                                              ▲
      ▼                                              │ { lines: [{ listingId, quantity }] }
the browser                                          │ (never a price)
  cart.ts: [{ listingId, quantity }] in localStorage ┘
  <cart-drawer>: the cart button ─► <dialog> ─► fetch the quote ─► draw lines, subtotal, Checkout
  <sale-countdown> · <product-gallery> · "Add to cart" · "Place Order" ─► /checkout (26c)

Wednesday 11 Nov 2026, a shopper in Khulna opens the neem face wash:
  the photo and four thumbnails, "01 : 12 : 10 : 32" counting down, ৳229 with ৳299 struck out …
  they tap "Add to cart", then the cart button ──► the drawer asks the server ──► "Subtotal ৳229"
  they tap "one more" three times quickly ──► the box says 4 at once; one request later, "৳916"
```

## Not in this step, on purpose

- **No checkout.** "Place Order" and "Checkout" go to `/checkout`, which 26c builds.
- **No variants on the page.** A listing is one variant (system design §14.3), so the size chip shows its own pack
  size. Switching between sizes of one product needs a listing group, which no screen has yet.
- **No reviews.** `CLAUDE.md` removed the Reviews tab: the data model has no reviews.
- **No 404 page of our own.** An unknown slug answers 404 with Astro's page; 26d draws the "page not found" empty
  state.
- **No real API.** The mock still answers, now through the same door the real API will use.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront.ts` | `PublicShop.timeZone`; the product page and the cart quote schemas |
| `packages/i18n/package.json`, `src/format.ts` | A second entry, `@omnivo/i18n/format`, for browser code (decision 22) |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | `shop.product` and `shop.cart` |
| `apps/shop/package.json`, `astro.config.ts` | `@astrojs/node`, `output: 'server'`, a `start` script |
| `apps/shop/src/data/types.ts`, `mock/shop.ts`, `mock/listings.ts`, `mock/mock-source.ts` | `product(slug)` and `quote(request)` on the source; the shop's time zone |
| `apps/shop/src/lib/cart.ts` | The quote route's limits; helpers for the page and the drawer |
| `apps/shop/src/lib/locale.ts` | `shopMoney` moves to `lib/money.ts` |
| `apps/shop/src/components/ProductCard.astro`, `src/pages/index.astro` | The ribbon and badges and "Load More" move to their own components, shared with the product page |
| `apps/shop/src/components/CartButton.astro`, `src/layouts/ShopLayout.astro` | The button opens the drawer; every page has the drawer |
| `apps/shop/src/styles/shop.css` | The description's prose style; no page scroll behind an open drawer |
| `apps/shop/src/boundaries.spec.ts`, `data/mock/mock.spec.ts`, `lib/cart.spec.ts` | New rules and tests |
| `pnpm-lock.yaml` | `@astrojs/node` |

New: the product page and its components, `src/server/`, the API route, `lib/countdown.ts`, `lib/money.ts`,
`lib/quote.ts`, `CartDrawer.astro`, the mock's `products.ts` and `quote.ts`, and five pictures in `public/`.

## The decisions behind this step

1. **Four guides, not three.** 26a planned two more parts. The product page and the cart are one guide; checkout and
   the order dialog are the next one, because the checkout form is the shop's first React island and needs room.
2. **Server mode now.** The cart drawer shows prices, and a price must come from the server (26a decision 5). So the
   shop switches to `output: 'server'` with the Node adapter in this step, and an Astro API route (`/api/cart/quote`)
   answers from the mock. The browser sends exactly what it will send to the real `/public/v1` later: listing ids and
   counts. When the API arrives, only the data source changes.
3. **The product is a listing with more fields.** `shopProductSchema` extends `shopListingSchema` instead of
   repeating its fields. The card and the page then read the same `price`, `discount` and `inStock`, so they can never
   show two prices for one product.
4. **A quote line has three states.** The cart in the browser can be days old. A line is `available` (priced and
   counted), `out_of_stock` (shown with no price, not counted), or `unavailable` (the listing is gone; the answer says
   only its id and the browser drops it). A discriminated union makes the drawer handle all three: TypeScript refuses
   to read `unitPrice` on a line that has none.
5. **The server adds the money.** The answer carries `subtotal` and `itemCount`. The drawer prints them and never adds
   prices in the browser, which keeps money math in one place (and out of a 2 KB script).
6. **Four photos at most.** The thumbnail row is exactly four wide (4 × 119px + 3 × 16px = the gallery's 524px). The
   contract says so (`SHOP_GALLERY_MAX`), so a fifth photo is refused by the schema, not pushed off the card by CSS.
7. **No new error code for a bad cart request.** Two lines for one listing, a quantity of 0, a count as text: our own
   cart never sends these, so a shopper never sees the error. The request is refused with the generic
   `invalid_input`, and no `errors.*` text is added for it.
8. **The countdown is read once.** A screen reader would read a clock that changes every second over and over. The
   visible `01 : 12 : 10 : 32` is hidden from it, and it hears "Sale ends 14 Nov 2026, 6:00 pm" once instead.

9. **Every page is made per request; none is built ahead.** The real source answers for the shop that the request's
   `Host` names, so a page built at deploy time would show one tenant's shop on every domain. With the mock, this
   costs nothing. Caching the pages comes with the real API, when there is something slow to cache.
10. **The Node adapter in `standalone` mode, at a version older than a week.** `node dist/server/entry.mjs` is the
    whole server. The repo's pnpm refuses packages published in the last few days (a supply-chain rule). The newest
    adapter was one day old, and installing it would have written an exception into `pnpm-workspace.yaml`; `~11.1.11`
    needs none and is made for the same Astro 7.
11. **The route file is one line; the work is in `src/server/`.** `answerCartQuote(request, source)` takes a plain
    `Request` and a `ShopSource`, so its tests need no server and no Astro. A test in `boundaries.spec.ts` lets only
    the API routes import `src/server/`, so Zod can never reach a page's `<script>` through it.
12. **The shop's errors look like the ERP's.** A refused request is an RFC 9457 problem (`application/problem+json`)
    with a `code` and `fieldErrors` keyed like `lines.1.quantity`, the same shape `apps/api` sends. The browser
    translates the code; the English `detail` is for logs only.
13. **The quantity limit is written twice, and a test keeps the two equal.** `cart.ts` has `MAX_QUANTITY = 99` and the
    contracts have `SHOP_CART_MAX_QUANTITY = 99`. Importing the contracts in the browser would cost 25 KB gz of Zod
    on every page, so the shop keeps its own copy, and `cart.spec.ts` fails the day they differ.
14. **The mock's sale always ends 1 day 12 hours from now.** Figma's countdown says `01 : 12 : 10 : 32`. A fixed date
    would pass, and the countdown would disappear from the mock one day without any code changing (a "date bomb", the
    kind of test failure step 18a had to fix).

15. **The shop puts the description on the page as the API sends it (`set:html`), with no cleaner of its own.** The
    ERP cleans `description_html` to a few tags when the tenant saves it (step 26's API), and the contract says so.
    A second cleaner in the shop would need an HTML parser on the server (a new dependency) to protect against one
    thing: our own API sending bad HTML. The API's cleaner and its test are the one place this is guarded; step 26's
    API guide must not forget them.
16. **The page follows Figma where `CLAUDE.md` says otherwise, and `CLAUDE.md` is corrected in the docs part.**
    Measured with `get_design_context`: the description card is `card-glass`, not `card`; its sections alternate
    `canvas` and `cream` (starting with `canvas`), not `card` and `cream`; the thumbnails are radius 16 with a 2px
    border, not radius 8 with 1px. The rule "every screen must match Figma" wins over a line written before the
    frame was measured.
17. **The selected thumbnail has a 2px `brand` border.** Figma shows no selected thumbnail; its thumbnails already
    have a 2px white border. Turning that border `brand` marks the one shown without moving the photo by a pixel.
18. **"Place Order" means "buy this now".** It puts the product in the cart once (if it is there already, the count
    stays) and opens checkout with the whole cart. A second click never buys two. Checkout (26c) has the stepper.
19. **"Overview" is a label, not a tab.** With Reviews removed, one tab is left. A `role="tablist"` of one tab would
    tell a screen reader there is a choice; a plain label in the tab's look tells the truth.
20. **The cards stack below `lg`, and the gallery stays at most 524px wide there.** Figma has no tablet or phone frame
    for this page. At full width a 900px screen showed a 700px-tall photo before the price.

21. **The cart drawer is a custom element around a native `<dialog>`, not a React island.** A React island would ship
    React and the translations (about 176 KB gz, 26a decision 4) for one panel; the drawer's script is 3 KB gz.
    `showModal()` gives what a drawer needs and is easy to get wrong by hand: the focus stays inside, Escape closes it,
    the page behind cannot be clicked or reached with Tab, and the focus goes back to the cart button on close. The
    first React island is still the checkout form in 26c, which needs a real form library.
22. **The browser formats money with the ERP's own formatter, from a second entry of `@omnivo/i18n`.** The drawer gets
    amounts like `"687.0000"` and must show `৳687`, the same as the page around it. A copy of `formatMoney` in the shop
    could drift (the `৳` before the minus sign, the lakh grouping, Bangla digits). But `import … from '@omnivo/i18n'`
    starts i18next with the English words (about 150 KB gz). So the package gets a small second entry, `@omnivo/i18n/format`, that is
    only the number functions, and a shop test fails if a browser script imports the big entry (or Zod, or React).
23. **Quantities change at once; prices follow.** A click on the stepper changes the cart and the number in the box
    straight away. The drawer asks the server for prices 250ms after the last click, so five quick clicks make one
    request, and only one request is out at a time (a newer one cancels the older). Until the answer comes, the line
    totals and the subtotal turn `muted`, so a stale amount never looks final. Every time the drawer opens, it asks
    again, even for the same cart: the shop may have changed a price since.
24. **The cart keeps only what the quote route takes.** At most 50 lines, ids of at most 64 characters, one line per
    listing: the same limits as `shopCartQuoteRequestSchema`. A stored cart outside them would fail every quote. The
    51st product is not added. No message says so: no real shopper fills 50 lines, and the header's count simply does
    not go up.
25. **A line the shop cannot sell stays; a line the shop no longer has goes.** An out-of-stock line keeps its place with
    "Out of stock: not in the subtotal" and a delete button only, so the shopper sees what happened. When every line is
    out of stock, Checkout is greyed and is not a link. An `unavailable` line (unpublished or deleted) leaves the stored
    cart, and a screen reader hears "1 item is no longer sold, so it left your cart."
26. **The drawer uses the checkout's lines at drawer size.** `CLAUDE.md` says "the checkout lines (image box 96×80)".
    With 96px for the picture, about 250px is left for the rest. So the name is 16px/600 (the checkout's 20px would take
    three lines), the line total sits to the right of the name, and the stepper and delete button keep the checkout's
    sizes (40px, 60×40, 6px and 16px apart). The drawer has 24px padding (20px on a phone) and a 1px `rule` line
    between lines. The docs part writes these numbers into `CLAUDE.md`.
27. **The drawer does not slide in.** Shop transitions are color only (`CLAUDE.md`), so it appears at once, like the
    ERP's dialogs.
28. **A failed quote takes the old prices away.** If the server cannot answer, the lines go and the drawer shows "The
    prices did not load…" with "Try again". Showing the last prices would let a shopper read an amount the shop may no
    longer charge.

## The pictures from Figma

Put these files in place first: the mock data of 26b.3 names them. They come from Figma's `product_details` frame
(37:3521) and `confirmation_status` frame (41:4066). They were downloaded with the Figma MCP tools and are copied into
the repo together with this guide, so you do not export them yourself this time.

| File (in `apps/shop/public/`) | Figma | What it is |
|---|---|---|
| `mock/products/himalaya-purifying-neem-face-wash-150ml.png` | `image 25` (37:3562) in the gallery, PNG at 2x (596×842, transparent) | The main photo; also the product's card photo |
| `mock/products/himalaya-purifying-neem-face-wash-150ml-2.png` | the second thumbnail, `Frame 66` (37:3565), PNG at 4x (476×368) | The tilted tube, cut by its thumbnail frame exactly as Figma draws it |
| `mock/products/himalaya-purifying-neem-face-wash-150ml-3.png` | a hidden fill of the same image layers (1000×800) | The tube with its green name band |
| `mock/products/himalaya-purifying-neem-face-wash-150ml-4.png` | a hidden fill of the same image layers (1000×800, transparent) | The tube on its own, wider framing |
| `shapes/order-confirmed.svg` | `tick-double-03` (41:4239), SVG of its two vectors | The two-tone tick of the "Order Confirmed" dialog (26c) |

Why these four photos: Figma has only one product photo. Its four thumbnails show it twice straight and twice tilted
(1 = 3, 2 = 4). Two copies of each would look broken in a real gallery, so photos 3 and 4 are the two other pictures
the designer put into the same layers (hidden fills). The first two thumbnails match Figma; the last two do not, on
purpose (see "Known differences from Figma").

The tick is downloaded now, though 26c draws it, so all the Figma exports of step 26b–26c happen in one place. Its
colors are written in the file (`#B8EF69`, `#005859`); 26c decides how it follows a tenant's own theme.

The same warning as in 26a: these are brand photos (Himalaya). Keep them as mock data on your machine, not in a public
demo.

## 26b.1 — `packages/contracts`: the product page and the cart quote

### `src/storefront.ts`

```diff
@@ -3,10 +3,12 @@ import { z } from 'zod';
 import { errorCode } from './errors.js';
 import { isMoneyAmount } from './money.js';
 import { LANGUAGE_CODES } from './preferences.js';
+import { isTimeZone } from './settings.js';
 
 // Step 26a: what the public shop reads. Today the shop's mock data has this shape; from step 26b on,
 // the public API (/public/v1) sends exactly this, so the pages never change when the data goes live.
-// Nothing here is a form: the browser never sends a price, so every schema is an answer, not input.
+// Almost everything here is an answer. The one input is the cart quote request (step 26b): ids and
+// counts only, because the browser never sends a price.
 
 // A shop price: a decimal string like the rest of the app (CLAUDE.md → Money), never a number
 const shopMoneySchema = z.string().refine(isMoneyAmount, errorCode('money_format'));
@@ -39,6 +41,9 @@ export const publicShopSchema = z.object({
   language: z.enum(LANGUAGE_CODES),
   theme: shopThemeSchema,
   hotline: z.string().min(1),
+  // Step 26b: the workspace's time zone ('Asia/Dhaka'). A shop prints its own times (when a sale
+  // ends, when an order was placed) in it, never in the server's or the shopper's zone
+  timeZone: z.string().refine(isTimeZone),
   address: z.string().min(1),
   social: z.object({
     facebook: linkSchema.nullable(),
@@ -142,3 +147,119 @@ export type ImageBanner = z.infer<typeof imageBannerSchema>;
 export type ShopCollection = z.infer<typeof shopCollectionSchema>;
 export type ShopHome = z.infer<typeof shopHomeSchema>;
 export type ShopHomeBlock = ShopHome['blocks'][number];
+
+// ---------------------------------------------------------------------------------------------
+// Step 26b: the product page and the cart's prices.
+
+// The gallery shows four thumbnails in one row (CLAUDE.md → Product page, top: 4 × 119px + 3 gaps
+// of 16px = the gallery card's 524px). The server sends the listing's first four photos, so a fifth
+// can never push the row out of its card.
+export const SHOP_GALLERY_MAX = 4;
+
+// One listing with everything its page shows. It is a listing (the same fields as a card, so the
+// page and the card can never disagree on a price), plus the parts only the page has.
+export const shopProductSchema = shopListingSchema.extend({
+  images: z.array(shopImageSchema).min(1).max(SHOP_GALLERY_MAX),
+  // The variant's SKU. null: the product has none (a SKU is optional in step 12), so the
+  // "SKU: …" line is left out instead of saying "SKU: -"
+  sku: z.string().min(1).nullable(),
+  // The base unit's name, for "Per Piece" under the price. A name, not a code: "pcs" means
+  // nothing to a shopper
+  unitName: z.string().min(1),
+  // The description, as HTML: one <section> per block, each starting with an <h2>, then <p>, <ul>
+  // or <ol>, and <strong> for label words. The ERP cleans it to these tags when the tenant saves it
+  // (step 26's API), because the shop puts it on the page as it is. '' = no description, and the
+  // page leaves out the whole Overview card
+  descriptionHtml: z.string(),
+});
+
+// What /p/<slug> needs in one answer: the product and its "Related Products" row. The related
+// listings are cards, so they reuse the card's schema. At most 12: the row scrolls a page at a time,
+// and three pages are plenty
+export const shopProductPageSchema = z.object({
+  product: shopProductSchema,
+  related: z.array(shopListingSchema).max(12),
+});
+
+// The cart's limits. The browser's cart (apps/shop/src/lib/cart.ts) keeps the same 99 in its own
+// constant, because importing this file would bring Zod (25 KB gz) to every page; a test in the
+// shop checks that the two stay equal.
+export const SHOP_CART_MAX_QUANTITY = 99;
+// More lines than any real shopping basket, few enough that one request stays small
+export const SHOP_CART_MAX_LINES = 50;
+
+const listingIdSchema = z.string().min(1).max(64);
+
+// What the browser sends to get its cart priced: ids and counts, in the cart's order. Never a
+// price, a name or a total: those come back from the server (system design §14.4). It is the one
+// input in this file, so it is strict about what it takes.
+export const shopCartQuoteRequestSchema = z
+  .object({
+    lines: z
+      .array(
+        z.object({
+          listingId: listingIdSchema,
+          quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
+        }),
+      )
+      .max(SHOP_CART_MAX_LINES),
+  })
+  .superRefine((request, ctx) => {
+    // The cart adds to a line instead of making a second one (cart.ts → addLine). Two lines for one
+    // listing would be priced twice, so a request that has them is not from our cart
+    const seen = new Set<string>();
+    request.lines.forEach((line, index) => {
+      if (seen.has(line.listingId)) {
+        ctx.addIssue({
+          code: 'custom',
+          path: ['lines', index, 'listingId'],
+          message: errorCode('invalid_input'),
+        });
+      }
+      seen.add(line.listingId);
+    });
+  });
+
+// The parts of a listing a cart line draws: the 96×80 image box, the name (a link to its page) and
+// the pack size
+const quoteLineListingSchema = z.object({
+  listingId: listingIdSchema,
+  slug: z.string().min(1),
+  name: z.string().min(1),
+  packSize: z.string(),
+  image: shopImageSchema,
+});
+
+// One line of the answer, in the request's order. Three cases, because the cart in the browser can
+// be days old:
+// - available: priced at today's price, and counted in the subtotal
+// - out_of_stock: still shown, so the shopper sees what happened, but not counted and not sold
+// - unavailable: the listing is gone (unpublished or deleted). The answer says only its id, and the
+//   browser drops it from the stored cart
+export const shopCartQuoteLineSchema = z.discriminatedUnion('status', [
+  quoteLineListingSchema.extend({
+    status: z.literal('available'),
+    quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
+    unitPrice: shopMoneySchema,
+    lineTotal: shopMoneySchema,
+  }),
+  quoteLineListingSchema.extend({
+    status: z.literal('out_of_stock'),
+    quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
+  }),
+  z.object({ status: z.literal('unavailable'), listingId: listingIdSchema }),
+]);
+
+// The answer. The subtotal and the item count are the server's sums of the available lines, so the
+// drawer never adds money in the browser. Step 26c adds the delivery zone, the coupon and the total
+export const shopCartQuoteSchema = z.object({
+  lines: z.array(shopCartQuoteLineSchema),
+  itemCount: z.number().int().min(0),
+  subtotal: shopMoneySchema,
+});
+
+export type ShopProduct = z.infer<typeof shopProductSchema>;
+export type ShopProductPage = z.infer<typeof shopProductPageSchema>;
+export type ShopCartQuoteRequest = z.infer<typeof shopCartQuoteRequestSchema>;
+export type ShopCartQuoteLine = z.infer<typeof shopCartQuoteLineSchema>;
+export type ShopCartQuote = z.infer<typeof shopCartQuoteSchema>;
```

The file header changes because the file now has one input: until 26a every schema was something the shop reads.
One field is added to the shop itself; everything else is added at the end.

- **`timeZone` on `publicShopSchema`** is the workspace's time zone (`Asia/Dhaka`). The product page says when a sale
  ends, and 26c says when an order was placed; both must be the shop's local time, not the server's (a server in
  Frankfurt) and not a guess. `isTimeZone` is the same check the ERP's settings use: a zone `Intl` does not know
  would make every date on the shop throw a `RangeError`.
- **`SHOP_GALLERY_MAX = 4`** is a named constant, not a bare `.max(4)`: the gallery's thumbnail row is exactly four
  columns (`grid-cols-4` in 26b.4), and the constant is the one place that says why.
- **`shopListingSchema.extend({ … })`** overrides `images` (a card needs at least one photo; the page also needs at
  most four) and adds three fields. `extend` keeps the type a subtype of `ShopListing`, so a `ShopProduct` can be
  passed to anything that draws a card, such as the related row.
- **`sku` is `nullable()`**, not `optional()`. Step 12 lets a variant have no SKU. `null` says "the server looked and
  there is none"; a missing key would also be what a server bug looks like, and the schema could not tell the two
  apart.
- **`unitName`** is the unit's name ("Piece"), not its code ("pcs"), because it is printed for a shopper as "Per
  Piece". The words "Per …" come from `t()`, the name from the data.
- **`descriptionHtml`** stays HTML, as `storefront_listings.description_html` in the system design (§14.3) and the
  storefront rules in `CLAUDE.md` say ("one prose class, never per-section markup"). The comment states the tags it
  may hold: `<section>` per block is what lets the page give each block its own background (`canvas`, then `cream`,
  alternating, decision 16) with plain CSS. `''` means "no description", not "missing", for the same reason `sku` is `null`.
- **`shopProductPageSchema`** is one answer for the whole page, product and related row together, so the page makes
  one request, not two. `related` reuses `shopListingSchema`: the row's cards are the home page's cards.
- **`SHOP_CART_MAX_QUANTITY = 99`** is the same number as `MAX_QUANTITY` in `apps/shop/src/lib/cart.ts`. The shop does
  not import it, because `@omnivo/contracts` brings Zod (25 KB gz) into any page that imports it; 26b.4 adds a test
  that fails if the two numbers differ.
- **`shopCartQuoteRequestSchema`** is the one input, so it is strict: `quantity` is `z.number().int()` (a count sent
  as `"2"` is refused, not coerced, because our script sends numbers and anything else is not our script), and unknown
  keys such as a `price` are dropped by Zod's default `strip`. The test proves both.
- **The `superRefine` refuses one listing on two lines.** `addLine` in `cart.ts` adds to an existing line, so our cart
  never sends this. A server that summed both lines would still be right, but one that priced each line on its own
  could be gamed (two lines of 99 past a per-line limit). Refusing it is simpler than defining what it means. The
  issue points at the second line (`['lines', 2, 'listingId']`), so a log says which one.
- **`quoteLineListingSchema`** holds what a line draws. It is not exported: it only exists to build the union.
- **`shopCartQuoteLineSchema`** is a `z.discriminatedUnion` on `status`. Each case has only the fields it can have:
  `out_of_stock` has no `unitPrice` and no `lineTotal`, so the drawer cannot print a price for something the shop
  cannot sell; `unavailable` has only `listingId`, because the listing is gone and its name may no longer be known.
- **`shopCartQuoteSchema`** carries `itemCount` and `subtotal`: the server's sums of the `available` lines (decision
  5). `subtotal` is a money string like every other price, so `"1,199"` is refused.

### `apps/shop/src/data/mock/shop.ts`

```diff
@@ -8,6 +8,7 @@ export const mockShop = {
   language: 'en',
   theme: { brand: '#005859', accent: '#b8ef69' },
   hotline: '+880 1786 120356',
+  timeZone: 'Asia/Dhaka',
   address: 'Amigo 14 Square, House No :59/C-61/C Suite No : B-2, Level-2, Asad Ave, Dhaka 1207.',
   social: {
     facebook: 'https://facebook.com/',
```

The mock shop `satisfies PublicShop`, so it stops compiling the moment the contract has `timeZone`. It gets Dhaka's,
the zone of every workspace made with the default settings.

### `src/storefront.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import {
  publicShopSchema,
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  shopCartQuoteLineSchema,
  shopCartQuoteRequestSchema,
  shopCartQuoteSchema,
  shopProductSchema,
} from './storefront.js';

// A shopper in Sylhet with two face washes and a tea in her cart
const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml';
const TEA = 'lst-seylon-family-blend-tea-400gm';

const NEEM_PRODUCT = {
  id: NEEM,
  slug: 'himalaya-purifying-neem-face-wash-150ml',
  name: 'Himalaya Purifying Neem Face Wash 150ml',
  packSize: '150ml',
  images: [{ url: '/mock/products/neem.png', alt: 'Himalaya Purifying Neem Face Wash 150ml' }],
  price: '229',
  compareAtPrice: '299',
  saleUntil: '2026-11-14T18:00:00+06:00',
  discount: { kind: 'amount', value: '70' },
  badges: ['most_picked'],
  inStock: true,
  categoryId: 'cat-cosmetics',
  sku: 'MD2346',
  unitName: 'Piece',
  descriptionHtml: '<section><h2>Key Benefits</h2><ul><li>Controls excess oil</li></ul></section>',
};

describe('public shop', () => {
  const SHOP = {
    name: 'Shapla Pharmacy',
    logo: null,
    language: 'bn',
    theme: { brand: '#005859', accent: '#b8ef69' },
    hotline: '+880 1786 120356',
    timeZone: 'Asia/Dhaka',
    address: 'Zindabazar, Sylhet 3100',
    social: { facebook: null, instagram: null, x: null, linkedin: null },
  };

  it('takes the workspace time zone', () => {
    expect(publicShopSchema.parse(SHOP)).toEqual(SHOP);
  });

  // A made-up zone would make every date on the shop throw a RangeError in Intl
  it('refuses a time zone Intl does not know', () => {
    expect(publicShopSchema.safeParse({ ...SHOP, timeZone: 'Asia/Sylhet' }).success).toBe(false);
  });
});

describe('product page', () => {
  it('takes a listing with its SKU, unit and description', () => {
    expect(shopProductSchema.parse(NEEM_PRODUCT)).toEqual(NEEM_PRODUCT);
  });

  it('takes a product with no SKU and no description', () => {
    expect(() =>
      shopProductSchema.parse({ ...NEEM_PRODUCT, sku: null, descriptionHtml: '' }),
    ).not.toThrow();
  });

  it('refuses a fifth photo, which the thumbnail row has no room for', () => {
    const photo = NEEM_PRODUCT.images[0];
    const result = shopProductSchema.safeParse({
      ...NEEM_PRODUCT,
      images: [photo, photo, photo, photo, photo],
    });
    expect(result.success).toBe(false);
  });
});

describe('cart quote request', () => {
  it('takes ids and counts', () => {
    const request = {
      lines: [
        { listingId: NEEM, quantity: 2 },
        { listingId: TEA, quantity: 1 },
      ],
    };
    expect(shopCartQuoteRequestSchema.parse(request)).toEqual(request);
  });

  it('takes an empty cart', () => {
    expect(shopCartQuoteRequestSchema.parse({ lines: [] })).toEqual({ lines: [] });
  });

  it('drops a price the browser tried to send', () => {
    const parsed = shopCartQuoteRequestSchema.parse({
      lines: [{ listingId: NEEM, quantity: 1, price: '1' }],
      subtotal: '1',
    });
    expect(parsed).toEqual({ lines: [{ listingId: NEEM, quantity: 1 }] });
  });

  it.each([
    ['no items', 0],
    ['more than the cart allows', SHOP_CART_MAX_QUANTITY + 1],
    ['half an item', 1.5],
    ['a count as text', '2'],
  ])('refuses %s', (_, quantity) => {
    const result = shopCartQuoteRequestSchema.safeParse({
      lines: [{ listingId: NEEM, quantity }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses one listing on two lines', () => {
    const result = shopCartQuoteRequestSchema.safeParse({
      lines: [
        { listingId: NEEM, quantity: 1 },
        { listingId: TEA, quantity: 1 },
        { listingId: NEEM, quantity: 3 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { path: ['lines', 2, 'listingId'], message: 'invalid_input' },
    ]);
  });

  it('refuses more lines than any basket needs', () => {
    const lines = Array.from({ length: SHOP_CART_MAX_LINES + 1 }, (_, index) => ({
      listingId: `lst-${String(index)}`,
      quantity: 1,
    }));
    expect(shopCartQuoteRequestSchema.safeParse({ lines }).success).toBe(false);
  });
});

describe('cart quote', () => {
  const image = NEEM_PRODUCT.images[0];

  it('reads the three kinds of line', () => {
    const quote = {
      lines: [
        {
          status: 'available',
          listingId: NEEM,
          slug: NEEM_PRODUCT.slug,
          name: NEEM_PRODUCT.name,
          packSize: '150ml',
          image,
          quantity: 2,
          unitPrice: '229',
          lineTotal: '458.0000',
        },
        {
          status: 'out_of_stock',
          listingId: TEA,
          slug: 'seylon-family-blend-tea-400gm',
          name: 'Seylon Family Blend Tea',
          packSize: '400gm',
          image,
          quantity: 1,
        },
        { status: 'unavailable', listingId: 'lst-gone' },
      ],
      itemCount: 2,
      subtotal: '458.0000',
    };
    expect(shopCartQuoteSchema.parse(quote)).toEqual(quote);
  });

  it('never has a price on a line that is out of stock', () => {
    const parsed = shopCartQuoteLineSchema.parse({
      status: 'out_of_stock',
      listingId: TEA,
      slug: 'seylon-family-blend-tea-400gm',
      name: 'Seylon Family Blend Tea',
      packSize: '400gm',
      image,
      quantity: 1,
      unitPrice: '520',
    });
    expect(parsed).not.toHaveProperty('unitPrice');
  });

  it('refuses a total written for people', () => {
    const result = shopCartQuoteSchema.safeParse({ lines: [], itemCount: 0, subtotal: '1,199' });
    expect(result.success).toBe(false);
  });
});
```

The first two tests are for the shop's time zone: a real zone is kept, and `Asia/Sylhet` (not a zone) is refused.
The rest read like the drawer's life: a cart priced, a request a script tried to tamper with, and an old cart with a
product that went out of stock and one that was removed.

- **"drops a price the browser tried to send"** pins down Zod's `strip` behaviour. If someone later adds `.strict()`
  or `.passthrough()`, this test says what the request is meant to do with extra keys: ignore them, never use them.
- **`it.each` with `'2'`** is the coercion case. It keeps the schema from being "fixed" with `z.coerce.number()`,
  which would also turn `""` into 0 and `"1e2"` into 100.
- **"refuses one listing on two lines"** checks the path and the code, not only that it fails, so a change to the
  refinement that points at the wrong line is caught.
- **"never has a price on a line that is out of stock"** parses a line that does have `unitPrice` and checks it is
  gone after parsing. The drawer reads parsed data, so an old or wrong server field never reaches the screen.

## 26b.2 — `packages/i18n`: the words

### `src/locales/en.ts`

```diff
@@ -5492,6 +5492,49 @@ export const en = {
         buy_one_get_one: 'Buy 1 Get 1',
       },
     },
+    // The product page (/p/<slug>)
+    product: {
+      title: '{{name}} | {{shop}}',
+      gallery: 'Photos of {{name}}',
+      showPhoto: 'Show photo {{index}} of {{count}}',
+      // The countdown's words for a screen reader, read once: a clock that changes every second
+      // is not read out
+      saleEnds: 'Sale ends {{date}}',
+      size: 'Size',
+      // Before the struck-out price, for a screen reader: <s> alone is not read as "was"
+      wasPrice: 'Was {{price}}',
+      perUnit: 'Per {{unit}}',
+      placeOrder: 'Place Order',
+      inStock: 'Available in stock',
+      outOfStock: 'Out of stock',
+      sku: 'SKU: {{sku}}',
+      hotline: 'Hotline:',
+      callHotline: 'Call {{phone}}',
+      details: 'Product details',
+      overview: 'Overview',
+      related: 'Related Products',
+    },
+    // The cart drawer, opened from the header's cart button
+    cart: {
+      title: 'Your Cart',
+      close: 'Close cart',
+      loading: 'Getting today’s prices…',
+      failed: 'The prices did not load. Check the connection, then try again.',
+      retry: 'Try again',
+      decrease: 'One less {{name}}',
+      increase: 'One more {{name}}',
+      quantity: 'How many {{name}}',
+      remove: 'Remove {{name}}',
+      outOfStock: 'Out of stock: not in the subtotal',
+      // Said when the answer drops listings the shop no longer sells
+      removed_one: '{{count}} item is no longer sold, so it left your cart.',
+      removed_other: '{{count}} items are no longer sold, so they left your cart.',
+      subtotal: 'Subtotal',
+      checkout: 'Checkout',
+      emptyTitle: 'Your cart is empty',
+      emptyText: 'Add products with “Add to cart” and they wait for you here.',
+      continueShopping: 'Continue shopping',
+    },
     footer: {
       pages: 'Shop pages',
       social: '{{shop}} on social media',
```

Two new groups under `shop`, next to `card`. Notes on the ones that are not plain labels:

- **`product.title`** is `{{name}} | {{shop}}`: the product first, because a browser tab cuts the end of a long
  title, and the shopper needs the product's name more than the shop's.
- **`product.saleEnds`** is the countdown's words for a screen reader (decision 8). The date comes in already
  formatted, so the sentence works in both languages.
- **`product.wasPrice`**: a struck-out price inside `<s>` is not read as "was" by most screen readers; the hidden
  "Was ৳299" before it is.
- **`product.related` and `product.placeOrder`** keep Figma's capital letters ("Related Products", "Place Order"),
  like 26a's "All Category" and "Add to cart". The storefront follows Figma's copy, not the ERP's sentence case.
- **`cart.removed_one` / `cart.removed_other`** is a plural pair (i18next picks one by `count`). The drawer says it
  when the answer has `unavailable` lines, so a product does not disappear from the cart without a word.
- **`cart.failed`** says what to do (check the connection, try again), per `CLAUDE.md` → Copy.
- **`cart.decrease`, `increase`, `quantity`, `remove`** all carry the product's name. A drawer of three lines with
  three "Remove" buttons would be three identical buttons to a screen reader.

### `src/locales/bn.ts`

```diff
@@ -5130,6 +5130,43 @@ export const bn: Messages = {
         buy_one_get_one: '১টি কিনলে ১টি ফ্রি',
       },
     },
+    product: {
+      title: '{{name}} | {{shop}}',
+      gallery: '{{name}}-এর ছবি',
+      showPhoto: '{{count}}টির মধ্যে {{index}} নম্বর ছবি দেখুন',
+      saleEnds: 'অফার শেষ হবে {{date}}',
+      size: 'সাইজ',
+      wasPrice: 'আগের দাম {{price}}',
+      perUnit: 'প্রতি {{unit}}',
+      placeOrder: 'অর্ডার করুন',
+      inStock: 'স্টকে আছে',
+      outOfStock: 'স্টকে নেই',
+      sku: 'SKU: {{sku}}',
+      hotline: 'হটলাইন:',
+      callHotline: '{{phone}} নম্বরে কল করুন',
+      details: 'পণ্যের বিবরণ',
+      overview: 'বিবরণ',
+      related: 'একই রকম পণ্য',
+    },
+    cart: {
+      title: 'আপনার কার্ট',
+      close: 'কার্ট বন্ধ করুন',
+      loading: 'আজকের দাম আনা হচ্ছে…',
+      failed: 'দাম আনা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
+      retry: 'আবার চেষ্টা করুন',
+      decrease: '{{name}} একটি কমান',
+      increase: '{{name}} একটি বাড়ান',
+      quantity: '{{name}} কয়টি',
+      remove: '{{name}} সরান',
+      outOfStock: 'স্টকে নেই: সাবটোটালে ধরা হয়নি',
+      removed_one: '{{count}}টি পণ্য আর বিক্রি হয় না, তাই কার্ট থেকে সরানো হয়েছে।',
+      removed_other: '{{count}}টি পণ্য আর বিক্রি হয় না, তাই কার্ট থেকে সরানো হয়েছে।',
+      subtotal: 'সাবটোটাল',
+      checkout: 'চেকআউট',
+      emptyTitle: 'আপনার কার্ট খালি',
+      emptyText: '"কার্টে যোগ করুন" চাপলে পণ্য এখানে অপেক্ষা করবে।',
+      continueShopping: 'কেনাকাটা চালিয়ে যান',
+    },
     footer: {
       pages: 'দোকানের পেজ',
       social: 'সোশ্যাল মিডিয়ায় {{shop}}',
```

The same keys in Bangla. `bn.ts` is typed against `en.ts`, so a missing key fails `tsc` (tried on purpose: without
`placeOrder`, `tsc` stops with TS2741). `SKU` stays in English inside the Bangla text, like PO and LC in the ERP.

## 26b.3 — `apps/shop`: server mode and the cart's prices

Install the Node adapter from the repo root:

```bash
pnpm --filter @omnivo/shop add @astrojs/node@~11.1.11
```

### `package.json`

```diff
@@ -7,10 +7,12 @@
     "dev": "astro dev --port 4321",
     "build": "astro check && astro build",
     "preview": "astro preview --port 4321",
+    "start": "node dist/server/entry.mjs",
     "typecheck": "astro check",
     "test": "vitest run --passWithNoTests"
   },
   "dependencies": {
+    "@astrojs/node": "~11.1.11",
     "@astrojs/react": "^7.1.4",
     "@fontsource-variable/geist": "^5.3.0",
     "@fontsource/noto-sans-bengali": "^5.3.0",
```

- **`@astrojs/node` with `~`**, not `^`: `~` takes only patch fixes on the next `pnpm update`. A new minor of the
  adapter is a change to how the whole shop is served, so it should be a choice, not a side effect.
- **`start`** runs the built server. `preview` (Astro's own command) still works for a quick look, but `start` is what a
  real server runs: plain Node, no Astro CLI. It listens on `PORT` (4321 if unset) and `HOST`.

### `astro.config.ts`

```diff
@@ -1,11 +1,22 @@
+import node from '@astrojs/node';
 import react from '@astrojs/react';
 import tailwindcss from '@tailwindcss/vite';
 import { defineConfig } from 'astro/config';
 
-// Step 26a: every page is built to HTML ahead of time from the mock data. Step 26b turns on
-// `output: 'server'` with the Node adapter, when the pages read the public API per request.
+// Step 26b: every page is made per request on a Node server. The real source (step 26's public
+// API) answers for the shop the request's Host names, so a page built ahead of time would show one
+// shop on every domain. The server also prices the cart (/api/cart/quote): the browser never works
+// out money (system design §14.4).
 export default defineConfig({
-  output: 'static',
+  output: 'server',
+  adapter: node({
+    // `node dist/server/entry.mjs` is the whole server, with no Express around it. It reads HOST
+    // and PORT from the environment
+    mode: 'standalone',
+    // The shop takes small JSON bodies only (a cart of 50 lines is about 3 KB). The default is
+    // 1 GB, which would let anyone make the server read a huge body into memory
+    bodySizeLimit: 64 * 1024,
+  }),
   integrations: [react()],
   vite: {
     plugins: [tailwindcss()],
```

- **`output: 'server'`**: every page and route runs per request (decision 9). `index.astro` does not change: its
  frontmatter already awaits `shopSource`, which is the same code on a server.
- **`bodySizeLimit: 64 * 1024`**: the adapter's default is 1 GB. The shop only ever takes a cart (about 3 KB for 50
  lines) and, in 26c, a checkout form. A body over the limit makes `request.json()` throw, and the route answers 400
  (checked with a 70 KB body).
- **`build.format: 'file'`** stays. It only changes pages that are built ahead of time, and there are none now; keeping
  it means a page someone later marks `prerender` still gets `/about.html`, the URL style 26a chose.

### `src/data/types.ts`

```diff
@@ -1,4 +1,11 @@
-import type { PublicShop, ShopCategory, ShopHome } from '@omnivo/contracts';
+import type {
+  PublicShop,
+  ShopCartQuote,
+  ShopCartQuoteRequest,
+  ShopCategory,
+  ShopHome,
+  ShopProductPage,
+} from '@omnivo/contracts';
 
 // What every data source answers. Its own file, so the mock can implement it without importing
 // source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
@@ -6,4 +13,10 @@ export interface ShopSource {
   shop(): Promise<PublicShop>;
   categories(): Promise<ShopCategory[]>;
   home(): Promise<ShopHome>;
+  // Step 26b: one product's page. null: no published listing has this slug, so the page answers
+  // 404. Not an error: an old link or a typo is normal traffic
+  product(slug: string): Promise<ShopProductPage | null>;
+  // Step 26b: today's prices for a cart. The route checks the request first
+  // (shopCartQuoteRequestSchema), so a source never sees a quantity of 0 or one listing twice
+  quote(request: ShopCartQuoteRequest): Promise<ShopCartQuote>;
 }
```

Two new methods. **`product(slug)` answers `null`, not an error,** for an unknown slug: an old link from Facebook or a
typo is everyday traffic, and the page turns `null` into a 404. **`quote(request)` takes the parsed request type,** so a
source cannot be called with raw JSON; the route parses first.

### `src/data/mock/listings.ts`

```diff
@@ -14,7 +14,9 @@ interface MockProduct {
   inStock?: boolean;
 }
 
-function listing(product: MockProduct): ShopListing {
+// Exported in step 26b: products.ts makes the product page's listing with it, so that listing has
+// the same id and photo rules as every card
+export function listing(product: MockProduct): ShopListing {
   return {
     id: `lst-${product.slug}`,
     slug: product.slug,
```

`listing()` is exported, so the product page's listing is made by the same function as every card: the same `lst-`
id rule and the same photo path rule.

### `src/data/mock/products.ts` (new)

```ts
import type { ShopListing, ShopProduct, ShopProductPage } from '@omnivo/contracts';

import {
  diabeticListings,
  featuredListings,
  himalayaListings,
  listing,
  trendingListings,
} from './listings';

// Step 26b: the product pages. One product is the Figma design's (product_details 37:3521) with
// its four photos and its description; every other listing gets a plain page made from its card,
// so no card in the mock links to a 404.

// The design's sale ends "01 : 12 : 10 : 32" from now: 1 day, 12 hours, 10 minutes, 32 seconds
const SALE_LEFT_MS = (((1 * 24 + 12) * 60 + 10) * 60 + 32) * 1000;

const NEEM_SLUG = 'himalaya-purifying-neem-face-wash-150ml';
const NEEM_NAME = 'Himalaya Purifying Neem Face Wash';

const neemListing: ShopListing = {
  ...listing({
    slug: NEEM_SLUG,
    // Figma's page title has the size in the name; the description's first heading does not
    name: `${NEEM_NAME} 150ml`,
    packSize: '150ml',
    price: '229',
    categoryId: 'cat-cosmetics',
    badges: ['most_picked'],
    // ৳299 − ৳229: the ribbon says what the struck-out price says
    discount: { kind: 'amount', value: '70' },
  }),
  compareAtPrice: '299',
};

// The description as the ERP will send it (shopProductSchema.descriptionHtml): a <section> per
// block, each with an <h2>. The words are Figma's (37:3612). Kept as one string on purpose: it is
// what the page gets from the API, not markup the shop writes.
const NEEM_DESCRIPTION = `<section>
<h2>${NEEM_NAME}</h2>
<p>Refresh and purify your skin every day with ${NEEM_NAME}. Enriched with the natural goodness of Neem &amp; Turmeric, this soap-free face wash effectively removes impurities, controls excess oil, and helps prevent pimples while maintaining your skin's natural moisture.</p>
</section>
<section>
<h2>Specifications</h2>
<ul>
<li><strong>Product Type:</strong> Face Wash</li>
<li><strong>Brand:</strong> Himalaya</li>
<li><strong>Skin Type:</strong> Suitable for all skin types (Best for Normal, Oily &amp; Pimple-Prone Skin)</li>
<li><strong>Category:</strong> Daily Facial Cleanser</li>
<li><strong>Formula:</strong> Soap-Free Herbal Cleanser</li>
</ul>
</section>
<section>
<h2>Key Benefits</h2>
<ul>
<li>Deeply cleanses dirt, impurities, and excess oil</li>
<li>Helps prevent pimples and future breakouts</li>
<li>Controls excess oil without drying the skin</li>
<li>Maintains the skin's natural moisture balance</li>
<li>Removes dead skin cells for a fresh, healthy glow</li>
<li>Soothes irritated skin with the goodness of Turmeric</li>
<li>Leaves skin clean, refreshed, and soft after every wash</li>
</ul>
</section>
<section>
<h2>Main Ingredients</h2>
<ul>
<li><strong>Neem:</strong> Naturally antibacterial and antifungal, helps purify skin, fight acne-causing bacteria, and reduce blemishes.</li>
<li><strong>Turmeric:</strong> Known for its anti-inflammatory and antiseptic properties that soothe the skin and promote an even-looking complexion.</li>
</ul>
</section>
<section>
<h2>Why Choose ${NEEM_NAME}?</h2>
<ul>
<li>Soap-free formula for gentle daily cleansing</li>
<li>Dermatologically tested</li>
<li>Free from Parabens, SLS/SLES, Phthalates, Artificial Colors &amp; Artificial Fragrances</li>
<li>100% Cruelty-Free skincare</li>
<li>Suitable for daily morning and evening use</li>
</ul>
</section>
<section>
<h2>How to Use</h2>
<ol>
<li>Moisten your face with water.</li>
<li>Apply a small amount of ${NEEM_NAME}.</li>
<li>Gently massage using circular motions until it forms a rich lather.</li>
<li>Rinse thoroughly with water.</li>
<li>Pat your face dry with a clean towel.</li>
<li>For best results, use twice daily.</li>
</ol>
</section>
<section>
<h2>Product Details</h2>
<p>${NEEM_NAME} is a herbal, soap-free facial cleanser specially formulated to keep your skin clean, fresh, and healthy. Its unique blend of Neem and Turmeric effectively removes excess oil, dirt, and impurities while helping prevent acne and pimple breakouts. Unlike ordinary cleansers, it deeply purifies the skin without stripping away its essential moisture, making it ideal for everyday use. The gentle formula keeps your skin feeling refreshed, soft, and naturally healthy after every wash.</p>
</section>`;

const neemProduct: Omit<ShopProduct, 'saleUntil'> = {
  ...neemListing,
  images: [
    { url: `/mock/products/${NEEM_SLUG}.png`, alt: `${NEEM_NAME} 150ml, front` },
    { url: `/mock/products/${NEEM_SLUG}-2.png`, alt: `${NEEM_NAME}, tube tilted` },
    { url: `/mock/products/${NEEM_SLUG}-3.png`, alt: `${NEEM_NAME}, tube beside its 150 ml label` },
    { url: `/mock/products/${NEEM_SLUG}-4.png`, alt: `${NEEM_NAME}, tube on a plain background` },
  ],
  sku: 'MD2346',
  unitName: 'Piece',
  descriptionHtml: NEEM_DESCRIPTION,
};

// Every listing the mock shop sells: the home page's and the product page's. The quote looks a
// cart's ids up here, so a listing added to the cart from any page can be priced
export const mockCatalog: ShopListing[] = [
  ...featuredListings,
  ...himalayaListings,
  ...trendingListings,
  ...diabeticListings,
  neemListing,
];

const RELATED_MAX = 12;

// `now` is a parameter so a test can fix the clock. The mock's sale always ends 1 day 12 hours
// after the page is asked for: a fixed date would pass one day, and the countdown would vanish from
// the mock without any code changing
export function mockProductPage(slug: string, now: Date): ShopProductPage | null {
  if (slug === NEEM_SLUG) {
    return {
      product: {
        ...neemProduct,
        saleUntil: new Date(now.getTime() + SALE_LEFT_MS).toISOString(),
      },
      // The design's "Related Products" row is the Himalaya shelf of the home page
      related: himalayaListings,
    };
  }

  const found = mockCatalog.find((candidate) => candidate.slug === slug);
  if (!found) return null;
  return {
    product: {
      ...found,
      // A plain page: the card's one photo, no SKU, no description (the page leaves out the
      // Overview card for '')
      sku: null,
      unitName: 'Piece',
      descriptionHtml: '',
    },
    // The same category, as the real API will choose them, without the product itself
    related: mockCatalog
      .filter((other) => other.categoryId === found.categoryId && other.id !== found.id)
      .slice(0, RELATED_MAX),
  };
}
```

- **`SALE_LEFT_MS`** is Figma's countdown written out as days, hours, minutes and seconds, so the number can be read
  back to the design (decision 14).
- **The name is `${NEEM_NAME} 150ml`**, as Figma's page title writes it ("Himalaya Purifying Neem Face Wash 150ml");
  the description's first heading is the name without the size, so `NEEM_NAME` stays the short one.
- **`neemListing` spreads `listing(...)` and sets `compareAtPrice: '299'`.** `MockProduct` has no old price, because no
  card on the home page shows one; adding a field to it for one product would touch 20 others.
- **`discount: { kind: 'amount', value: '70' }`** is ৳299 − ৳229. The ribbon and the struck-out price must say the same
  thing; the mock is where a wrong pair would teach the page a wrong layout.
- **`NEEM_DESCRIPTION`** is Figma's text (node 37:3612), written as the ERP will send it: `<section>` + `<h2>` per block.
  `&amp;` is escaped because this is HTML, not text. "How to Use" is an `<ol>`, because its lines are steps in order.
- **`neemProduct` is `Omit<ShopProduct, 'saleUntil'>`**: the sale's end is filled in per request, so the constant must
  not hold one that could go stale.
- **`mockCatalog`** is every listing the mock sells, the product page's included. The quote looks ids up here, so a
  product added to the cart from its page can be priced even though no home shelf shows it.
- **`mockProductPage(slug, now)`** takes the clock as a parameter, so the test can fix it. Every other listing gets a
  plain page (one photo, no SKU, `descriptionHtml: ''`), so no card in the mock links to a 404. Its related row is the
  rest of its category, as the real API will choose it, and never itself.

### `src/data/mock/quote.ts` (new)

```ts
import {
  multiplyMoney,
  sumMoney,
  type ShopCartQuote,
  type ShopCartQuoteLine,
  type ShopCartQuoteRequest,
  type ShopListing,
} from '@omnivo/contracts';

// Step 26b: the mock's cart prices, worked out the way the real API will (step 26): each line at
// the listing's price today, summed on the server. Never with JavaScript numbers: 3 × ৳49.90 is
// 149.70000000000002 in floating point, so the money helpers work in whole ten-thousandths.
export function quoteCart(request: ShopCartQuoteRequest, catalog: ShopListing[]): ShopCartQuote {
  const byId = new Map(catalog.map((listing) => [listing.id, listing]));

  const lines = request.lines.map((line): ShopCartQuoteLine => {
    const listing = byId.get(line.listingId);
    // The schema needs at least one photo, so `image` is there for every listing that passed it.
    // TypeScript cannot know that (noUncheckedIndexedAccess); a listing without one is treated as
    // gone, never drawn with a broken image
    const image = listing?.images[0];
    if (!listing || !image) return { status: 'unavailable', listingId: line.listingId };

    const shown = {
      listingId: listing.id,
      slug: listing.slug,
      name: listing.name,
      packSize: listing.packSize,
      image,
      quantity: line.quantity,
    };
    if (!listing.inStock) return { ...shown, status: 'out_of_stock' };
    return {
      ...shown,
      status: 'available',
      unitPrice: listing.price,
      lineTotal: multiplyMoney(String(line.quantity), listing.price),
    };
  });

  // Only what can be sold counts: an out-of-stock line stays on screen but adds nothing
  const sold = lines.filter((line) => line.status === 'available');
  return {
    lines,
    itemCount: sold.reduce((count, line) => count + line.quantity, 0),
    subtotal: sumMoney(sold.map((line) => line.lineTotal)),
  };
}
```

- **`multiplyMoney` and `sumMoney`** from `@omnivo/contracts` work in whole ten-thousandths of a taka (`bigint`). The
  answer looks like `"687.0000"`: four decimals, the contracts' money format. The drawer formats it for display; it
  never does arithmetic on it.
- **`String(line.quantity)`**: `multiplyMoney` takes two decimal strings, because in the ERP a quantity can be `2.75 m`.
  Here it is always a whole number.
- **`listing?.images[0]` with the `!image` check**: with `noUncheckedIndexedAccess`, TypeScript types `images[0]` as
  possibly `undefined` even though the schema needs one photo. Treating a photo-less listing as gone is safer than a `!`
  assertion, which would draw a line with a broken image.
- **The `shown` object** holds the fields both drawn states share, so `out_of_stock` and `available` cannot drift
  apart. The return type `ShopCartQuoteLine` on the `map` callback makes TypeScript check each case against its union
  member: an `out_of_stock` line with a `unitPrice` would not compile.
- **`sold`** filters on `status === 'available'`, which also narrows the type, so `line.lineTotal` is known to exist in
  the sum.

### `src/data/mock/mock-source.ts`

```diff
@@ -1,5 +1,7 @@
 import type { ShopSource } from '../types';
 import { mockHome } from './home';
+import { mockCatalog, mockProductPage } from './products';
+import { quoteCart } from './quote';
 import { mockCategories, mockShop } from './shop';
 
 // The mock answers at once. Still a promise, so the pages are written for the real source, which
@@ -8,4 +10,6 @@ export const mockSource: ShopSource = {
   shop: () => Promise.resolve(mockShop),
   categories: () => Promise.resolve(mockCategories),
   home: () => Promise.resolve(mockHome),
+  product: (slug) => Promise.resolve(mockProductPage(slug, new Date())),
+  quote: (request) => Promise.resolve(quoteCart(request, mockCatalog)),
 };
```

The mock source passes `new Date()` for each page request, so every visit shows Figma's countdown from the top.

### `src/server/problem.ts` (new)

```ts
import { contractErrorMap, isErrorCode, type ErrorCode, type Problem } from '@omnivo/contracts';

// Step 26b: the shop's API routes answer errors the way the ERP's API does (RFC 9457 problem
// details, apps/api/src/common/http/problem.ts): a code the browser translates with
// t('errors.<code>'), never English text it would show. One shape, so one client reads both.

const TITLES = { 400: 'Bad Request', 500: 'Internal Server Error' } as const;

export function problemResponse(
  status: keyof typeof TITLES,
  code: ErrorCode,
  detail: string,
  fieldErrors?: Record<string, ErrorCode[]>,
): Response {
  const body: Problem = {
    title: TITLES[status],
    status,
    detail,
    code,
    // Left out, not `undefined`, when there are none (exactOptionalPropertyTypes)
    ...(fieldErrors ? { fieldErrors } : {}),
  };
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
  });
}

// Only what invalidInput reads from a ZodError. Written out so the shop needs no direct `zod`
// dependency just for a type
interface ParseError {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}

// A failed parse → 400 invalid_input with each field's codes, keyed like the ERP's API does
// ("lines.2.quantity"), so the same client code can point at the line
export function invalidInput(error: ParseError): Response {
  const fieldErrors: Record<string, ErrorCode[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || 'body';
    // The schema's own code ('invalid_input' for a repeated line) or the error map's; anything
    // else (Zod's English) becomes invalid_value
    const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
    (fieldErrors[field] ??= []).push(code);
  }
  return problemResponse(400, 'invalid_input', 'Check the request and try again.', fieldErrors);
}

// Parse with this, so Zod's own issues carry our codes ('too_large') instead of English
export const parseOptions = { error: contractErrorMap };
```

- **`TITLES` is `as const`** and `problemResponse` takes `keyof typeof TITLES`, so a status without a title (say 404)
  does not compile, instead of answering a title of `undefined`.
- **`const body: Problem`** types the answer with the contracts' own `Problem`, the one `apps/api` sends. If the
  ERP's shape changes, the shop stops compiling instead of drifting.
- **`...(fieldErrors ? { fieldErrors } : {})`**: with `exactOptionalPropertyTypes`, `fieldErrors: undefined` is not
  allowed for an optional key. The key is left out instead.
- **`interface ParseError`** is the part of a `ZodError` this reads. The shop has no direct `zod` dependency; writing
  the shape out avoids adding one for a type.
- **`issue.path.map(String).join('.')`** makes `['lines', 1, 'quantity']` into `lines.1.quantity`, the key format
  `apps/api/src/common/http/endpoint.ts` uses. `|| 'body'` covers an issue on the whole body (`null` sent).
- **`isErrorCode(issue.message)`**: our schemas put a code in the message (`errorCode('invalid_input')`), and
  `contractErrorMap` turns Zod's own issues into codes. Anything else would be English text, so it becomes
  `invalid_value` instead of reaching the browser.

### `src/server/cart-quote.ts` (new)

```ts
import { shopCartQuoteRequestSchema } from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { invalidInput, parseOptions, problemResponse } from './problem';

// Step 26b: POST /api/cart/quote, without Astro around it. The route file only passes the request
// and the source in, so this can be tested with a plain Request and the mock source, no server.
export async function answerCartQuote(request: Request, source: ShopSource): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Not JSON, or bigger than the adapter's bodySizeLimit (reading it throws then): the same
    // code the ERP's API sends for a body it cannot read
    return problemResponse(400, 'malformed_request', 'The body must be JSON.');
  }

  const parsed = shopCartQuoteRequestSchema.safeParse(body, parseOptions);
  if (!parsed.success) return invalidInput(parsed.error);

  try {
    const quote = await source.quote(parsed.data);
    // Prices change and the answer belongs to one cart: no browser or proxy may keep it
    return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // The real source calls the API, which can be down. Logged here with its details; the
    // shopper gets a code the drawer turns into "Retry", never the error's text
    console.error('cart quote failed', error);
    return problemResponse(500, 'internal_error', 'Something went wrong on our side.');
  }
}
```

- **`await request.json()` in a `try`**: a body that is not JSON, or one over `bodySizeLimit`, throws here. Both are
  `malformed_request`, the code `apps/api` sends for a body it cannot read.
- **`safeParse(body, parseOptions)`** never throws; a bad request becomes a 400 with field codes (decision 12).
- **`Cache-Control: no-store`** on the answer: prices change, and the answer belongs to one cart. Without it, a proxy
  or the browser's back button could show an old subtotal.
- **The `catch` around `source.quote`**: the real source calls the API over the network, which can fail. The error is
  logged with its details on the server, and the shopper gets `internal_error` only. The test checks that an internal
  address in the error never reaches the answer.

### `src/pages/api/cart/quote.ts` (new)

```ts
import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerCartQuote } from '../../../server/cart-quote';

// Step 26b: the cart drawer sends the stored cart's ids and counts here and draws what comes back.
// POST, not GET: a cart of 50 lines does not fit well in a URL, and a quote is never cached.
// Another site can post here too (a JSON body is not a "simple" form, but text/plain is), which is
// harmless: the answer is public prices, and the shop has no session cookie to misuse.
export const POST: APIRoute = ({ request }) => answerCartQuote(request, shopSource);
```

- **Only `POST` is exported.** Astro answers any other method with 404 (checked: `GET` gives 404).
- **POST, not GET with the cart in the query**: 50 lines would make a long URL, and URLs end up in logs.
- **No CSRF token.** Astro's own `checkOrigin` (on in server mode) already answers 403 to a cross-site form post
  (checked with `Origin: https://evil.test`). A cross-site `fetch` with a JSON body is stopped by the browser's CORS
  preflight. Even if a request got through, the answer is public prices: the shop has no session cookie to misuse.

### `src/data/mock/quote.spec.ts` (new)

```ts
import { shopCartQuoteSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockCatalog } from './products';
import { quoteCart } from './quote';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const STEVIA = 'lst-zero-cal-stevia-30-sachets'; // ৳120
const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock

describe('quoteCart', () => {
  it('prices each line at today’s price and sums them on the server', () => {
    const quote = quoteCart(
      {
        lines: [
          { listingId: NEEM, quantity: 3 },
          { listingId: STEVIA, quantity: 1 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines).toMatchObject([
      { status: 'available', listingId: NEEM, unitPrice: '229', lineTotal: '687.0000' },
      { status: 'available', listingId: STEVIA, unitPrice: '120', lineTotal: '120.0000' },
    ]);
    expect(quote.itemCount).toBe(4);
    expect(quote.subtotal).toBe('807.0000');
    // The drawer trusts this answer as it is, so it must be what the real API will send
    expect(() => shopCartQuoteSchema.parse(quote)).not.toThrow();
  });

  it('keeps the cart’s order and leaves out what cannot be sold', () => {
    const quote = quoteCart(
      {
        lines: [
          { listingId: DANO, quantity: 2 },
          { listingId: 'lst-gone', quantity: 1 },
          { listingId: STEVIA, quantity: 2 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines.map((line) => line.status)).toEqual([
      'out_of_stock',
      'unavailable',
      'available',
    ]);
    // A gone listing says only its id: the browser drops it, and there is nothing else to show
    expect(quote.lines[1]).toEqual({ status: 'unavailable', listingId: 'lst-gone' });
    // The out-of-stock 2 are not counted, and add no money
    expect(quote.itemCount).toBe(2);
    expect(quote.subtotal).toBe('240.0000');
  });

  it('answers an empty cart with nothing to pay', () => {
    const quote = quoteCart({ lines: [] }, mockCatalog);
    expect(quote).toEqual({ lines: [], itemCount: 0, subtotal: '0.0000' });
  });

  it('never adds money as floating point', () => {
    // 3 × 49.90 is 149.70000000000002 with JavaScript numbers
    const catalog = mockCatalog.map((listing) =>
      listing.id === STEVIA ? { ...listing, price: '49.90' } : listing,
    );
    const quote = quoteCart({ lines: [{ listingId: STEVIA, quantity: 3 }] }, catalog);
    expect(quote.subtotal).toBe('149.7000');
  });
});
```

- **The first test parses the answer with `shopCartQuoteSchema`.** The drawer will trust this shape, so the mock must
  send exactly what the real API will.
- **"keeps the cart's order"** mixes all three states in one cart, in a different order than the catalog, so a quote
  that sorted or grouped lines would fail.
- **"never adds money as floating point"** uses ৳49.90 × 3, which is `149.70000000000002` in JavaScript numbers. It
  stops a later "simplification" to `Number(price) * quantity`.

### `src/server/cart-quote.spec.ts` (new)

```ts
import { problemSchema, shopCartQuoteSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { answerCartQuote } from './cart-quote';

const STEVIA = 'lst-zero-cal-stevia-30-sachets';

function post(body: string): Request {
  return new Request('http://shop.test/api/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return problemSchema.parse(await response.json());
}

describe('POST /api/cart/quote', () => {
  it('answers the quote, and no one may cache it', async () => {
    const response = await answerCartQuote(
      post(JSON.stringify({ lines: [{ listingId: STEVIA, quantity: 2 }] })),
      mockSource,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const quote = shopCartQuoteSchema.parse(await response.json());
    expect(quote.subtotal).toBe('240.0000');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await answerCartQuote(post('{lines:'), mockSource);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('malformed_request');
  });

  it('names each wrong field the way the ERP’s API does', async () => {
    const response = await answerCartQuote(
      post(
        JSON.stringify({
          lines: [
            { listingId: STEVIA, quantity: 1 },
            // A price is never taken from the browser: an unknown key is dropped, so this line is
            // wrong only for its quantity
            { listingId: 'lst-b', quantity: 100, price: '1' },
            { listingId: STEVIA, quantity: 1 },
          ],
        }),
      ),
      mockSource,
    );
    expect(response.status).toBe(400);
    const problem = await problemOf(response);
    expect(problem.code).toBe('invalid_input');
    expect(problem.fieldErrors).toEqual({
      'lines.1.quantity': ['too_large'],
      'lines.2.listingId': ['invalid_input'],
    });
  });

  it('hides a failing source behind internal_error', async () => {
    const down: ShopSource = {
      ...mockSource,
      quote: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3000')),
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = await answerCartQuote(post(JSON.stringify({ lines: [] })), down);
      expect(response.status).toBe(500);
      const problem = await problemOf(response);
      expect(problem.code).toBe('internal_error');
      // The API's address must never reach the shopper
      expect(JSON.stringify(problem)).not.toContain('10.0.0.5');
    } finally {
      console.error = quiet;
    }
  });
});
```

- **`post(body: string)`** builds a real `Request`, the same object Astro hands the route. No server is started.
- **`problemOf`** checks the content type and parses with `problemSchema`, so a test fails if an error answer stops
  being an RFC 9457 problem.
- **"names each wrong field"** sends a `price` too, to show it is ignored (only the quantity is wrong on that line),
  and checks the exact `fieldErrors` keys the drawer will read.
- **"hides a failing source"** silences `console.error` for that test only and puts it back in `finally`, so a failing
  assertion cannot leave the rest of the run silent.

### `src/data/mock/mock.spec.ts`

```diff
@@ -1,7 +1,13 @@
-import { publicShopSchema, shopCategorySchema, shopHomeSchema } from '@omnivo/contracts';
+import {
+  publicShopSchema,
+  shopCategorySchema,
+  shopHomeSchema,
+  shopProductPageSchema,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import { mockHome } from './home';
+import { mockCatalog, mockProductPage } from './products';
 import { mockCategories, mockShop } from './shop';
 
 // `satisfies` checks the shape at compile time, but not what only runtime sees: a price like
@@ -30,3 +36,27 @@ describe('the mock shop', () => {
     for (const listing of mockHome.featured) expect(ids.has(listing.categoryId)).toBe(true);
   });
 });
+
+describe('the mock product pages', () => {
+  const now = new Date('2026-11-11T10:00:00+06:00');
+
+  it('has a page for every listing, in the public contract', () => {
+    // Every card links to /p/<slug>; a listing without a page would be a 404 in the mock
+    expect(new Set(mockCatalog.map((listing) => listing.id)).size).toBe(mockCatalog.length);
+    for (const listing of mockCatalog) {
+      const page = mockProductPage(listing.slug, now);
+      expect(() => shopProductPageSchema.parse(page)).not.toThrow();
+      expect(page?.related.map((related) => related.id)).not.toContain(listing.id);
+    }
+  });
+
+  it('answers null for a slug no listing has', () => {
+    expect(mockProductPage('no-such-product', now)).toBeNull();
+  });
+
+  it('ends the design’s sale 1 day 12:10:32 after the page is asked for', () => {
+    const page = mockProductPage('himalaya-purifying-neem-face-wash-150ml', now);
+    expect(page?.product.saleUntil).toBe('2026-11-12T16:10:32.000Z');
+    expect(page?.product.images).toHaveLength(4);
+  });
+});
```

- **"has a page for every listing"** parses each page with `shopProductPageSchema` and checks that a product is not in
  its own related row.
- **`now` is fixed**, so the test can check the exact end of the sale: 10:00 in Dhaka (04:00 UTC) plus 1 day 12:10:32 is
  16:10:32 UTC the next day.

### `src/boundaries.spec.ts`

Add this test at the end of the `describe` block:

```ts
  it('reaches src/server only from the API routes', () => {
    // Step 26b: server/ is request handling (Response objects, the contracts, Zod). A component
    // that imported it could pull it into a <script> and ship Zod to every shopper's browser
    const offenders = Object.entries(files)
      .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
      .filter(([, source]) => importsOf(source).some((name) => /(^|\/)server\//.test(name)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
```

The new rule lets only `src/pages/api/` (and `src/server/` itself) import `src/server/` (decision 11). Tried on
purpose: an import of `../server/problem` in `Logo.astro` fails it. (The cart drawer's part adds one more rule to this
file.)

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/shop test
pnpm --filter @omnivo/shop build
PORT=4399 pnpm --filter @omnivo/shop start
```

The contracts are built first because the shop reads them from `dist/`. With the server running, in another terminal:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"lines":[{"listingId":"lst-zero-cal-stevia-30-sachets","quantity":2}]}' \
  http://localhost:4399/api/cart/quote
```

The answer has one `available` line with `"lineTotal":"240.0000"` and `"subtotal":"240.0000"`. Change `quantity` to `0`
and the answer is a 400 with `"fieldErrors":{"lines.0.quantity":["too_small"]}`.

## 26b.4 — `apps/shop`: the product page `/p/<slug>`

Figma's frame `product_details` (37:3521) at 1440px: the header, then the gallery (524×440) and its four thumbnails on
the left, the info card (740×548) on the right, 16px apart; 72px below them the Overview card; 48px below it "Related
Products" and Load More; then the footer as on the home page. Every number below was read from the frame with
`get_design_context`, then measured in Chromium (see "Run it and check it").

### `src/lib/cart.ts`

This diff has everything step 26b changes in the cart: "Place Order" on this page, and the cart drawer's stepper and
delete button in the next part. They are shown together because the changes touch the same lines.

```diff
@@ -5,6 +5,11 @@ import { atom, computed, onMount } from 'nanostores';
 // money), and a price kept here would go stale the day the shop changes it.
 const STORAGE_KEY = 'omnivo.shop.cart';
 export const MAX_QUANTITY = 99;
+// Step 26b: the server's other limits on a quote request (packages/contracts → storefront.ts).
+// A stored cart outside them would make every quote fail, and the drawer would show "Try again"
+// forever, so the cart never holds one.
+export const MAX_LINES = 50;
+const MAX_ID_LENGTH = 64;
 
 export interface CartLine {
   listingId: string;
@@ -20,6 +25,7 @@ function isCartLine(value: unknown): value is CartLine {
   return (
     typeof listingId === 'string' &&
     listingId !== '' &&
+    listingId.length <= MAX_ID_LENGTH &&
     typeof quantity === 'number' &&
     Number.isInteger(quantity) &&
     quantity >= 1 &&
@@ -32,7 +38,10 @@ export function parseCart(raw: string | null): CartLine[] {
   try {
     const value: unknown = JSON.parse(raw);
     // All or nothing: one bad line means the stored cart is not ours, so start empty
-    return Array.isArray(value) && value.every(isCartLine) ? value : [];
+    if (!Array.isArray(value) || value.length > MAX_LINES || !value.every(isCartLine)) return [];
+    // Our cart has one line per listing (addLine adds to it); the server refuses two
+    const ids = new Set(value.map((line) => line.listingId));
+    return ids.size === value.length ? value : [];
   } catch {
     return [];
   }
@@ -82,21 +91,69 @@ onMount($cart, () => {
   };
 });
 
+// Every change goes through here: it loads the stored cart first (a click can come before anything
+// has subscribed; without this it would write a cart of one line over the stored one), and a
+// change that changes nothing returns the same array, so nothing is stored and the header's count
+// does not say "Added to cart".
+function update(change: (lines: CartLine[]) => CartLine[]): void {
+  load();
+  const current = $cart.get();
+  const next = change(current);
+  if (next === current) return;
+  $cart.set(next);
+  writeStored(next);
+}
+
 export function addLine(lines: CartLine[], listingId: string): CartLine[] {
   const existing = lines.find((line) => line.listingId === listingId);
-  if (!existing) return [...lines, { listingId, quantity: 1 }];
+  if (!existing) {
+    // Step 26b: a 51st product is not added; the server would refuse the whole cart
+    return lines.length < MAX_LINES ? [...lines, { listingId, quantity: 1 }] : lines;
+  }
+  if (existing.quantity >= MAX_QUANTITY) return lines;
   return lines.map((line) =>
-    line.listingId === listingId
-      ? { ...line, quantity: Math.min(line.quantity + 1, MAX_QUANTITY) }
-      : line,
+    line.listingId === listingId ? { ...line, quantity: line.quantity + 1 } : line,
   );
 }
 
 export function addToCart(listingId: string): void {
-  // A click can come before anything has subscribed; without this it would write a cart of one
-  // line over the stored one
-  load();
-  const next = addLine($cart.get(), listingId);
-  $cart.set(next);
-  writeStored(next);
+  update((lines) => addLine(lines, listingId));
+}
+
+// Step 26b: "Place Order" on a product page buys this product now. It puts the product in the cart
+// once: a second click (or a shopper who added it already) keeps the count as it is, because
+// checkout shows the stepper to change it. Checkout then opens with the whole cart, as one order.
+export function withLine(lines: CartLine[], listingId: string): CartLine[] {
+  if (lines.some((line) => line.listingId === listingId) || lines.length >= MAX_LINES) {
+    return lines;
+  }
+  return [...lines, { listingId, quantity: 1 }];
+}
+
+export function ensureInCart(listingId: string): void {
+  update((lines) => withLine(lines, listingId));
+}
+
+// Step 26b: the drawer's stepper and its typed quantity. Kept between 1 and the limit: 0 is not a
+// quantity (the delete button removes a line), and a typed 500 becomes 99, not an error.
+export function withQuantity(lines: CartLine[], listingId: string, quantity: number): CartLine[] {
+  const wanted = Math.min(Math.max(Math.trunc(quantity), 1), MAX_QUANTITY);
+  const existing = lines.find((line) => line.listingId === listingId);
+  // A line another tab removed a moment ago is not brought back by a click in this one
+  if (!existing || existing.quantity === wanted) return lines;
+  return lines.map((line) => (line.listingId === listingId ? { ...line, quantity: wanted } : line));
+}
+
+export function withoutLines(lines: CartLine[], listingIds: ReadonlySet<string>): CartLine[] {
+  const kept = lines.filter((line) => !listingIds.has(line.listingId));
+  return kept.length === lines.length ? lines : kept;
+}
+
+export function setQuantity(listingId: string, quantity: number): void {
+  update((lines) => withQuantity(lines, listingId, quantity));
+}
+
+// The delete button, and the listings a quote says the shop no longer sells
+export function removeFromCart(listingIds: ReadonlySet<string>): void {
+  update((lines) => withoutLines(lines, listingIds));
 }
```

- **`MAX_LINES` and the id length** are the quote route's other limits (decision 24). `parseCart` refuses a stored cart
  outside them, and also one with two lines for one listing. The route would refuse such a cart every time, and the
  drawer would show "Try again" forever; an empty cart is the better failure.
- **`update(change)`** is now the only way the cart changes. It calls `load()` first: a click can come before the
  header has subscribed, and without it a cart of one line would overwrite the stored cart (decision 18). And when the
  change returns the same array, it stores nothing and sets nothing.
- **Why "the same array" matters.** Setting the store makes every subscriber run. The header's cart button says
  "Added to cart" when the count goes up, the drawer asks the server for prices, and writing `localStorage` wakes every
  other tab of the shop. A change that changes nothing must do none of that. So every helper returns the array it got
  when nothing changes: `addLine` at 99 or at 50 lines, `withLine` when the product is in the cart already,
  `withQuantity` when the number is the same, `withoutLines` when none of the ids is there.
- **`withLine`** is "Place Order": the product goes in once; a second click keeps the count (decision 18).
- **`withQuantity`** keeps a typed number between 1 and 99 and drops a fraction (`Math.trunc`). It does not add a line
  that is not there: another tab may have removed it a moment ago, and a click in this tab must not bring it back.
- **`removeFromCart` takes a set of ids**, because it has two callers: the delete button (one id) and the quote's
  `unavailable` lines (any number at once, one store change and one write).

### `src/lib/cart.spec.ts`

```diff
@@ -1,6 +1,34 @@
+import {
+  SHOP_CART_MAX_LINES,
+  SHOP_CART_MAX_QUANTITY,
+  shopCartQuoteRequestSchema,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import { addLine, MAX_QUANTITY, parseCart } from './cart';
+import {
+  addLine,
+  MAX_LINES,
+  MAX_QUANTITY,
+  parseCart,
+  withLine,
+  withoutLines,
+  withQuantity,
+  type CartLine,
+} from './cart';
+
+// cart.ts keeps its own copy of the limit, because importing the contracts would bring Zod into
+// every page. If they drifted, the browser would keep a 100 the server refuses, and the whole
+// cart's quote would fail
+it('keeps the same limits as the server', () => {
+  expect(MAX_QUANTITY).toBe(SHOP_CART_MAX_QUANTITY);
+  expect(MAX_LINES).toBe(SHOP_CART_MAX_LINES);
+});
+
+// A full cart: as many lines as allowed, each id as long as allowed
+const fullCart: CartLine[] = Array.from({ length: MAX_LINES }, (_, index) => ({
+  listingId: String(index).padStart(64, 'x'),
+  quantity: MAX_QUANTITY,
+}));
 
 describe('parseCart', () => {
   it('reads a cart this code wrote', () => {
@@ -23,6 +51,25 @@ describe('parseCart', () => {
     ).toEqual([]);
   });
 
+  // Step 26b: whatever the cart keeps, the quote route takes. Otherwise one stored cart would fail
+  // every quote, and "Try again" could never help
+  it('keeps only carts the quote route takes', () => {
+    const parsed = parseCart(JSON.stringify(fullCart));
+    expect(parsed).toEqual(fullCart);
+    expect(shopCartQuoteRequestSchema.safeParse({ lines: parsed }).success).toBe(true);
+
+    const oneMore = [...fullCart, { listingId: 'lst-a', quantity: 1 }];
+    const longId = [{ listingId: 'x'.repeat(65), quantity: 1 }];
+    const twice = [
+      { listingId: 'lst-a', quantity: 1 },
+      { listingId: 'lst-a', quantity: 2 },
+    ];
+    for (const cart of [oneMore, longId, twice]) {
+      expect(shopCartQuoteRequestSchema.safeParse({ lines: cart }).success).toBe(false);
+      expect(parseCart(JSON.stringify(cart))).toEqual([]);
+    }
+  });
+
   it('refuses quantities a shopper cannot have', () => {
     for (const quantity of [0, -1, 1.5, MAX_QUANTITY + 1]) {
       expect(parseCart(JSON.stringify([{ listingId: 'lst-a', quantity }]))).toEqual([]);
@@ -43,6 +90,67 @@ describe('addLine', () => {
 
   it('stops at the most a line can hold', () => {
     const full = [{ listingId: 'lst-a', quantity: MAX_QUANTITY }];
-    expect(addLine(full, 'lst-a')).toEqual(full);
+    expect(addLine(full, 'lst-a')).toBe(full);
+  });
+
+  it('adds no line to a full cart', () => {
+    expect(addLine(fullCart, 'lst-a')).toBe(fullCart);
+  });
+});
+
+describe('withLine', () => {
+  it('adds the product once, with one', () => {
+    expect(withLine([], 'lst-a')).toEqual([{ listingId: 'lst-a', quantity: 1 }]);
+  });
+
+  // "Place Order" twice must not buy two: the shopper chose the count already, or will at checkout
+  it('leaves a cart that has the product as it is', () => {
+    const cart = [{ listingId: 'lst-a', quantity: 3 }];
+    expect(withLine(cart, 'lst-a')).toBe(cart);
+  });
+});
+
+describe('withQuantity', () => {
+  const cart = [
+    { listingId: 'lst-a', quantity: 2 },
+    { listingId: 'lst-b', quantity: 1 },
+  ];
+
+  it('sets one line and leaves the others', () => {
+    expect(withQuantity(cart, 'lst-a', 5)).toEqual([
+      { listingId: 'lst-a', quantity: 5 },
+      { listingId: 'lst-b', quantity: 1 },
+    ]);
+  });
+
+  // A typed 0 or 500 is fixed, not refused: the box shows what the cart really holds
+  it('keeps the quantity between 1 and the limit, in whole items', () => {
+    expect(withQuantity(cart, 'lst-a', 0)[0]).toEqual({ listingId: 'lst-a', quantity: 1 });
+    expect(withQuantity(cart, 'lst-a', 500)[0]).toEqual({
+      listingId: 'lst-a',
+      quantity: MAX_QUANTITY,
+    });
+    expect(withQuantity(cart, 'lst-a', 3.7)[0]).toEqual({ listingId: 'lst-a', quantity: 3 });
+  });
+
+  it('returns the same cart when nothing changes', () => {
+    expect(withQuantity(cart, 'lst-a', 2)).toBe(cart);
+    // Removed in another tab a moment ago: a click here does not bring it back
+    expect(withQuantity(cart, 'lst-gone', 4)).toBe(cart);
+  });
+});
+
+describe('withoutLines', () => {
+  const cart = [
+    { listingId: 'lst-a', quantity: 2 },
+    { listingId: 'lst-b', quantity: 1 },
+  ];
+
+  it('removes the lines named', () => {
+    expect(withoutLines(cart, new Set(['lst-a']))).toEqual([{ listingId: 'lst-b', quantity: 1 }]);
+  });
+
+  it('returns the same cart when none of them is there', () => {
+    expect(withoutLines(cart, new Set(['lst-gone']))).toBe(cart);
   });
 });
```

- **"keeps the same limits as the server"** keeps the two copies of each limit equal (decision 13). The spec file may
  import `@omnivo/contracts`: tests run in Node, so Zod never reaches a shopper. Tried on purpose: with
  `MAX_QUANTITY = 100`, this test fails.
- **"keeps only carts the quote route takes"** runs the server's own schema on what `parseCart` keeps. A full cart (50
  lines, 64-character ids, 99 each) must pass both; one line more, a 65-character id or a listing twice must fail the
  schema and come back from `parseCart` as an empty cart. If someone changes one side only, this test says so.
- **`toBe(...)`**, not `toEqual`, wherever a helper should change nothing: it checks that the same array comes back,
  which is what `update` depends on (see above). Tried on purpose: `withLine` returning `[...lines]` fails its test.
- **`withQuantity` with 0, 500 and 3.7** shows that a typed number is fixed, not refused: the box then shows what the
  cart really holds.

### `src/lib/countdown.ts` (new)

```ts
// Step 26b: the sale countdown's text, "01 : 12 : 10 : 32" (days : hours : minutes : seconds), as
// Figma writes it. The server draws the first value and the browser the rest, with this one
// function, so the two can never show different text at the hand-over.

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// `locale` is a number locale ('en-IN', 'bn-BD'): a Bangla shop counts down in Bangla digits.
// The time left is never below zero: a clock that ran past the end shows zeros, not "-1"
export function countdownText(msLeft: number, locale: string): string {
  const total = Math.max(0, Math.floor(msLeft / SECOND));
  const parts = [
    Math.floor(total / DAY),
    Math.floor((total % DAY) / HOUR),
    Math.floor((total % HOUR) / MINUTE),
    total % MINUTE,
  ];
  // Two digits at least, so the text does not jump in width when 10 becomes 9. A sale of 100
  // days or more shows its three digits. useGrouping off: never "1,000" days
  const two = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return parts.map((part) => two.format(part)).join(' : ');
}
```

- **One function for the server and the browser.** The server writes the first text into the page; the browser's
  script replaces it every second. If the two formatted differently (say the server wrote `1 : 12 …`), the row would
  jump at the first tick.
- **`Math.floor(msLeft / SECOND)`**: the page is drawn some milliseconds into a second. Rounding up would show one
  second more than is left; flooring matches what a clock shows.
- **`Math.max(0, …)`**: the browser's clock can be ahead of the server's. A negative time left must show zeros, never
  `-1`.
- **`minimumIntegerDigits: 2`** keeps `09` as two digits, so the text keeps its width as it counts (with
  `tabular-nums` on the row, each digit is the same width too). **`useGrouping: false`**: a three-digit day count is
  `120`, never written with a separator.
- **The locale is a number locale** (`numberLocale(language)`, `en-IN` or `bn-BD`), so a Bangla shop counts in Bangla
  digits, as every other number in a Bangla shop.

### `src/lib/countdown.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import { countdownText } from './countdown';

const DAY_12_10_32 = (((1 * 24 + 12) * 60 + 10) * 60 + 32) * 1000;

describe('countdownText', () => {
  it('writes Figma’s countdown', () => {
    expect(countdownText(DAY_12_10_32, 'en-IN')).toBe('01 : 12 : 10 : 32');
  });

  // The page asks a few hundred milliseconds into a second; the clock shows the whole seconds left
  it('drops the part of a second', () => {
    expect(countdownText(DAY_12_10_32 + 999, 'en-IN')).toBe('01 : 12 : 10 : 32');
  });

  it('counts in Bangla digits in a Bangla shop', () => {
    expect(countdownText(DAY_12_10_32, 'bn-BD')).toBe('০১ : ১২ : ১০ : ৩২');
  });

  it('shows zeros once the sale is over, never a minus', () => {
    expect(countdownText(-5000, 'en-IN')).toBe('00 : 00 : 00 : 00');
  });

  it('keeps every digit of a long sale', () => {
    expect(countdownText(120 * 24 * 3600 * 1000, 'en-IN')).toBe('120 : 00 : 00 : 00');
  });
});
```

The first test is Figma's text exactly. The others are the edges: part of a second, Bangla digits, a sale that is over
(zeros, no minus) and a sale longer than 99 days (three digits, no grouping).

### `src/components/ListingMarks.astro` (new)

```
---
import type { ShopListing } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';

// Step 26b: the discount ribbon and the badges of a listing, taken out of ProductCard so the
// product page's gallery draws exactly the same ones (Figma puts them at the same places on the
// card and on the gallery: the ribbon 16px from the left on the top edge, the badge 10px in from
// the top right). The parent is the positioned box: it needs `relative`.
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
---

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
```

The ribbon and the badges, moved out of `ProductCard` unchanged. Figma puts them on the gallery exactly where the card
has them (the ribbon 16px from the left on the top edge, "Most Picked" 10px in from the top right), so one component
draws both and the two can never drift. It renders absolutely placed elements only: the parent must be `relative`,
which the comment says, because the component cannot check it.

### `src/components/ProductCard.astro`

```diff
@@ -4,11 +4,13 @@ import { HugeiconsIcon } from '@hugeicons/react';
 import type { ShopListing } from '@omnivo/contracts';
 
 import type { ShopLocale } from '../lib/locale';
+import ListingMarks from './ListingMarks.astro';
 
 // CLAUDE.md → Storefront → Product card. Desktop (Figma 37:3174): 243×458, centered, the ribbon on
 // the card's top edge, the picture 54px down. Phone (Figma 138:815): full width, left-aligned, the
 // picture in a 160px box with the ribbon and badge inside it. One "media" box carries the ribbon
-// and badge in both, so they are placed relative to it.
+// and badge in both, so they are placed relative to it (ListingMarks, shared with the product page
+// since step 26b).
 interface Props {
   listing: ShopListing;
   locale: ShopLocale;
@@ -17,17 +19,6 @@ interface Props {
 const { listing, locale } = Astro.props;
 const { t } = locale;
 
-const discount = listing.discount;
-const discountText =
-  discount === null
-    ? null
-    : discount.kind === 'amount'
-      ? locale.money(discount.value)
-      : `${String(discount.value)}%`;
-
-// NEW sits at the left when the left is free (no ribbon); the first other badge sits at the right
-const newOnLeft = discountText === null && listing.badges.includes('new');
-const rightBadge = listing.badges.find((badge) => !(newOnLeft && badge === 'new'));
 const image = listing.images[0];
 ---
 
@@ -41,28 +32,7 @@ const image = listing.images[0];
         class="size-full object-contain mix-blend-multiply md:h-50"
       />
     )}
-    {discountText !== null && (
-      <p class="ribbon-shape absolute top-0 left-2 flex h-10 w-[30px] flex-col items-center bg-price pt-2.5 text-sf-tag font-bold text-white md:left-4">
-        <span aria-hidden="true">{discountText}</span>
-        <span aria-hidden="true">{t('shop.card.off')}</span>
-        <span class="sr-only">{t('shop.card.discount', { amount: discountText })}</span>
-      </p>
-    )}
-    {newOnLeft && (
-      <p class="trim-text absolute top-2 left-2 rounded-full bg-brand p-[7px] text-sf-tag font-bold text-accent md:top-2.5 md:left-2.5">
-        {t('shop.card.badge.new')}
-      </p>
-    )}
-    {rightBadge && (
-      <p
-        class:list={[
-          'trim-text absolute top-2 right-2 rounded-full p-[7px] text-sf-tag font-bold md:top-2.5 md:right-2.5',
-          rightBadge === 'new' ? 'bg-brand text-accent' : 'bg-promo text-white',
-        ]}
-      >
-        {t(`shop.card.badge.${rightBadge}`)}
-      </p>
-    )}
+    <ListingMarks listing={listing} locale={locale} />
   </div>
 
   <div class="flex flex-col gap-1 md:mt-4 md:gap-[23px] md:px-2.5">
```

The card keeps its media box (`relative`) and uses `ListingMarks` inside it. `t` stays, because the card still writes
the button's words.

### `src/components/LoadMoreLink.astro` (new)

```
---
// CLAUDE.md → Storefront → Load More, as a link: the page's list continues on its category page
// (26d gives that page the button's "Loading" state). Shared by the home page and the product page
// since step 26b.
interface Props {
  href: string;
  label: string;
}

const { href, label } = Astro.props;
---

<div class="mt-4 flex justify-center pt-2 pb-6 md:mt-12 md:p-0">
  <a
    href={href}
    class="flex h-[38px] items-center rounded-lg bg-card px-4 font-medium transition-colors duration-150 hover:bg-cream"
  >
    {label}
  </a>
</div>
```

The home page's Load More link, moved into a component, because the product page has the same one under "Related
Products". The margins are the home page's (48px above it from `md`), which are also Figma's on the product page
(the row ends at 2884, Load More starts at 2932).

### `src/pages/index.astro`

```diff
@@ -2,6 +2,7 @@
 import CategoryFilters from '../components/CategoryFilters.astro';
 import HeroBanner from '../components/HeroBanner.astro';
 import ImageBanner from '../components/ImageBanner.astro';
+import LoadMoreLink from '../components/LoadMoreLink.astro';
 import ProductCard from '../components/ProductCard.astro';
 import ProductRow from '../components/ProductRow.astro';
 import { shopSource } from '../data/source';
@@ -60,15 +61,5 @@ const { t } = locale;
     ),
   )}
 
-  {home.hasMoreFeatured && (
-    <div class="mt-4 flex justify-center pt-2 pb-6 md:mt-12 md:p-0">
-      {/* Step 26c: the full list; the button's "Loading" state belongs to that page */}
-      <a
-        href="/c/all"
-        class="flex h-[38px] items-center rounded-lg bg-card px-4 font-medium transition-colors duration-150 hover:bg-cream"
-      >
-        {t('shop.home.loadMore')}
-      </a>
-    </div>
-  )}
+  {home.hasMoreFeatured && <LoadMoreLink href="/c/all" label={t('shop.home.loadMore')} />}
 </ShopLayout>
```

The home page uses the component. The old comment said "Step 26c" for the list page; the list page is 26d now, and
the component's own comment says so.

### `src/styles/shop.css`

```diff
@@ -144,6 +144,68 @@
   }
 }
 
+/* Step 26b: the product description (CLAUDE.md → Product page, description; Figma 37:3620). The
+   HTML comes from the ERP, so it is styled by tag here, never with classes inside it. Each
+   <section> is one block: 8px apart, radius 8, padding 36px (20px on a phone), the backgrounds
+   alternating canvas and cream as Figma draws them. Headings and text are trimmed like every other
+   Figma text, so the 24px under a heading is Figma's gap between the two trimmed boxes. */
+@layer components {
+  .shop-prose {
+    display: flex;
+    flex-direction: column;
+    gap: 8px;
+
+    & > section {
+      border-radius: 8px;
+      padding: 20px;
+      background: var(--color-canvas);
+      @variant md {
+        padding: 36px;
+      }
+    }
+    & > section:nth-child(even) {
+      background: var(--color-cream);
+    }
+
+    & h2 {
+      font-size: var(--text-sf-subtitle);
+      line-height: 30px;
+      font-weight: 600;
+      color: var(--color-brand);
+      text-box: trim-both cap alphabetic;
+    }
+    & p,
+    & ul,
+    & ol {
+      font-size: var(--text-sf-small);
+      line-height: var(--text-sf-small--line-height);
+      color: var(--color-body);
+      text-box: trim-both cap alphabetic;
+    }
+    /* Figma: 24px under a heading; two blocks of text one after the other get 16px */
+    & section > * + * {
+      margin-top: 16px;
+    }
+    & section > h2 + * {
+      margin-top: 24px;
+    }
+    /* Preflight removes list markers; a description's lists keep Figma's discs and numbers,
+       indented 21px */
+    & ul {
+      list-style: disc;
+    }
+    & ol {
+      list-style: decimal;
+    }
+    & li {
+      margin-inline-start: 21px;
+    }
+    & strong {
+      font-weight: 600;
+    }
+  }
+}
+
 @layer base {
   body {
     background: var(--color-canvas);
```

The description's look, as one class (`shop-prose`), because the HTML is the ERP's and has no classes of its own
(`CLAUDE.md`: "one prose class, never per-section markup").

- **`@layer components`**, not `@utility`: a utility is one class with one set of declarations. This is a class that
  styles the tags inside it. In the components layer, a Tailwind utility on the same element still wins.
- **`section:nth-child(even)` is `cream`**: the backgrounds alternate `canvas`, `cream`, `canvas`… as Figma draws
  them (decision 16), so a description of any length keeps the rhythm with no class per section.
- **`@variant md`** inside the rule gives the sections Figma's 36px padding from `md` and 20px on a phone, with
  Tailwind's own breakpoint, so the number lives in one place.
- **`text-box: trim-both cap alphabetic`** on the heading and the text: the same trim as the `trim-text` utility.
  Figma's 24px between a heading and its text is measured between trimmed boxes; without the trim, the browser's line
  boxes would add about 14px.
- **`section > h2 + *` after `section > * + *`**: both have the same specificity, so the later one wins for the block
  under a heading (24px). Any other pair of blocks gets 16px.
- **`list-style`**: Tailwind's preflight removes list markers. A description's lists need them: "Key Benefits" has
  discs and "How to Use" has numbers in Figma, which is why the mock writes "How to Use" as an `<ol>`.

### `src/components/SaleCountdown.astro` (new)

```
---
import { Clock01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { formatDateTime, numberLocale } from '@omnivo/i18n';

import { countdownText } from '../lib/countdown';
import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Product page, top: the countdown row (Figma 37:3574), a 20px clock and
// "01 : 12 : 10 : 32" in `promo`, 12px apart. The server writes the first value, so the row is
// right before any script runs; the script below makes it tick.
interface Props {
  // When the sale ends. The page draws this only for a sale that has not ended yet
  until: Date;
  timeZone: string;
  locale: ShopLocale;
}

const { until, timeZone, locale } = Astro.props;
const { t } = locale;
const number = numberLocale(locale.language);
---

<sale-countdown
  class="flex items-center gap-3 text-promo"
  data-until={until.toISOString()}
  data-locale={number}
>
  <HugeiconsIcon icon={Clock01Icon} size={20} strokeWidth={1.5} aria-hidden="true" />
  {/* Hidden from a screen reader: it would read the clock again every second (decision 8) */}
  <span data-clock aria-hidden="true" class="trim-text font-semibold tabular-nums">
    {countdownText(until.getTime() - Date.now(), number)}
  </span>
  <span class="sr-only">
    {t('shop.product.saleEnds', { date: formatDateTime(until, locale.language, timeZone) })}
  </span>
</sale-countdown>

<script>
  import { countdownText } from '../lib/countdown';

  class SaleCountdown extends HTMLElement {
    private timer: number | undefined;

    connectedCallback(): void {
      const clock = this.querySelector<HTMLElement>('[data-clock]');
      const until = Date.parse(this.dataset.until ?? '');
      const locale = this.dataset.locale ?? 'en-IN';
      if (!clock || Number.isNaN(until)) return;

      const tick = (): void => {
        const left = until - Date.now();
        clock.textContent = countdownText(left, locale);
        if (left > 0) return;
        // The sale is over: the row goes, and the price on the page is the sale's until a reload.
        // The cart and checkout ask the server, so nobody pays the old sale price by mistake
        window.clearInterval(this.timer);
        this.hidden = true;
      };
      tick();
      // Every second, as the design shows seconds. Not paused under reduced motion: changing text
      // is not motion
      this.timer = window.setInterval(tick, 1000);
    }

    disconnectedCallback(): void {
      window.clearInterval(this.timer);
    }
  }

  customElements.define('sale-countdown', SaleCountdown);
</script>
```

- **The server writes the first value** (`countdownText(until - Date.now())`), so the row is correct before the
  script loads, and on a slow phone it never shows an empty clock.
- **`data-until` as an ISO string**, read with `Date.parse`, which gives `NaN` for anything wrong; the script then
  does nothing instead of counting from `NaN`.
- **Two texts**: the clock is `aria-hidden` and a hidden sentence says "Sale ends 13 Nov 2026, 18:00" once (decision
  8). The date is in the shop's `timeZone` (26b.1), with `formatDateTime`, the ERP's own "23 Sep 2026, 16:05".
- **When the time is up, the row hides itself** (`this.hidden = true`) and the timer stops. The price on the page is
  still the sale's until a reload. That is safe: the cart and checkout ask the server for prices, so nobody is charged
  a sale price that has ended.
- **Not paused under `prefers-reduced-motion`**: changing digits is not motion, and a stopped clock would be wrong.
- **`disconnectedCallback` clears the timer**, so a removed countdown does not keep a timer running.

### `src/components/ProductGallery.astro` (new)

```
---
import type { ShopProduct } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';
import ListingMarks from './ListingMarks.astro';

// CLAUDE.md → Product page, top: the gallery card (Figma 37:3556) and its thumbnails (37:3563 to
// 37:3569). Sizes are aspect ratios of Figma's 524×440 card and 119×92 thumbnails, so the column
// can be narrower than 524px (between lg and xl, and on a phone) and keep the design's shape.
interface Props {
  product: ShopProduct;
  locale: ShopLocale;
}

const { product, locale } = Astro.props;
const { t } = locale;
const { images } = product;
const first = images[0];
---

{/* Stacked (below lg) the gallery keeps Figma's 524px at most, centered: at full width a tablet
    would show a 700px-tall photo before the price */}
<product-gallery class="mx-auto block w-full max-w-[524px] lg:max-w-none">
  <div class="relative aspect-[524/440] overflow-hidden rounded-2xl bg-card">
    {first && (
      // The page's main picture: loaded first, never lazily. p-2.5: Figma's photo is 421px tall
      // in the 440px card
      <img
        data-main
        src={first.url}
        alt={first.alt}
        fetchpriority="high"
        class="size-full object-contain p-2.5 mix-blend-multiply"
      />
    )}
    <ListingMarks listing={product} locale={locale} />
  </div>

  {
    // One photo needs no row of one thumbnail: it would be a button that changes nothing
    images.length > 1 && (
      <ul
        aria-label={t('shop.product.gallery', { name: product.name })}
        class="mt-4 grid grid-cols-4 gap-4"
      >
        {images.map((image, index) => (
          <li>
            <button
              type="button"
              data-thumb
              aria-label={t('shop.product.showPhoto', { index: index + 1, count: images.length })}
              aria-pressed={index === 0 ? 'true' : 'false'}
              class="block aspect-[119/92] w-full overflow-hidden rounded-2xl border-2 border-card bg-card transition-colors duration-150 hover:border-rule aria-pressed:border-brand"
            >
              {/* The button's label names it; the photo's own words are said once, on the big one */}
              <img
                src={image.url}
                alt=""
                data-alt={image.alt}
                class="size-full object-contain mix-blend-multiply"
              />
            </button>
          </li>
        ))}
      </ul>
    )
  }
</product-gallery>

<script>
  // A thumbnail shows its photo in the big card. The photo is already in the thumbnail (same
  // file), so the switch needs no request and no list of URLs in the script
  class ProductGallery extends HTMLElement {
    connectedCallback(): void {
      const main = this.querySelector<HTMLImageElement>('[data-main]');
      const thumbs = [...this.querySelectorAll<HTMLButtonElement>('[data-thumb]')];
      if (!main) return;

      for (const thumb of thumbs) {
        thumb.addEventListener('click', () => {
          const photo = thumb.querySelector('img');
          if (!photo) return;
          main.src = photo.src;
          main.alt = photo.dataset.alt ?? '';
          for (const other of thumbs) {
            other.setAttribute('aria-pressed', other === thumb ? 'true' : 'false');
          }
        });
      }
    }
  }

  customElements.define('product-gallery', ProductGallery);
</script>
```

- **Aspect ratios, not pixel sizes**: `aspect-[524/440]` for the big card and `aspect-[119/92]` for a thumbnail. At
  1440px the column is 524px wide and they are Figma's 524×440 and 119×92 (measured); between `lg` and `xl` and on a
  phone they shrink and keep the shape.
- **`max-w-[524px]` until `lg`** (decision 20): stacked, the gallery is at most Figma's width, centered.
- **`p-2.5` on the main photo**: Figma's photo is 421px tall in the 440px card, 10px from the top. `object-contain`
  keeps a photo of any shape whole, and `mix-blend-multiply` makes a white photo background melt into the white card,
  as on the product cards.
- **`fetchpriority="high"` and no `loading="lazy"`**: it is the page's largest picture, at the top. The thumbnails are
  not lazy either: on a desktop they are on the first screen.
- **The thumbnails are buttons with `aria-pressed`**, so a screen reader hears "Show photo 2 of 4, pressed". Their
  photos have `alt=""`: the button's label already names them, and the photo's words are said once, on the big one
  (the script copies `data-alt` there).
- **`aria-pressed:border-brand`**: Tailwind's `aria-pressed` variant styles the selected thumbnail from the same
  attribute a screen reader reads, so the look and the meaning cannot disagree (decision 17).
- **No thumbnail row for one photo**: one button that changes nothing would only be one more tab stop.
- **The script copies the thumbnail's own `src`**: the big photo and the thumbnail are the same file, already loaded,
  so the switch is instant and the script needs no list of URLs.

### `src/components/ProductInfo.astro` (new)

```
---
import {
  Add01Icon,
  Alert02Icon,
  Call02Icon,
  CheckmarkBadge01Icon,
  ShoppingBag01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PublicShop, ShopProduct } from '@omnivo/contracts';

import type { ShopLocale } from '../lib/locale';
import SaleCountdown from './SaleCountdown.astro';

// CLAUDE.md → Product page, top: the info card (Figma 37:3571, 740×548). Every gap below is
// Figma's, measured between trimmed text boxes (trim-text), so the card is 548px tall at 1440px
// with the design's words.
interface Props {
  product: ShopProduct;
  shop: PublicShop;
  locale: ShopLocale;
  // Worked out by the page once per request: the sale's end, or null when there is no sale left
  saleUntil: Date | null;
}

const { product, shop, locale, saleUntil } = Astro.props;
const { t } = locale;

// tel: takes digits and a leading + only; "+880 1786 120356" is for the eye
const phoneHref = `tel:${shop.hotline.replace(/[^\d+]/g, '')}`;

// The two buttons share their look; only the fill and the icon differ. Below lg they share the
// card's width (two columns), from lg they are Figma's 195px
const button =
  'flex h-11 items-center justify-center rounded-sm pr-4 pl-2.5 font-semibold transition-colors duration-150 disabled:bg-canvas disabled:text-muted lg:w-[195px]';
---

<div class="rounded-2xl bg-card-glass px-5 pt-6 pb-7 md:px-9 md:pt-8 md:pb-9">
  {saleUntil && (
    <div class="mb-6">
      <SaleCountdown until={saleUntil} timeZone={shop.timeZone} locale={locale} />
    </div>
  )}

  {/* lg:max-w-72: Figma's title box is 288px, which breaks the name onto two lines */}
  <h1 class="trim-text text-sf-title font-semibold lg:max-w-72">{product.name}</h1>

  {product.packSize !== '' && (
    // Not a button: a listing is one size (see "Not in this step"). The chip only shows it
    <p class="mt-6 w-fit rounded-full border border-muted-line bg-card px-3 py-2 font-semibold">
      <span class="sr-only">{t('shop.product.size')}: </span>
      <span class="trim-text block">{product.packSize}</span>
    </p>
  )}

  <div class="mt-9 flex items-end gap-2">
    <p class="trim-text text-sf-price-lg font-semibold text-price tabular-nums">
      {locale.money(product.price)}
    </p>
    {product.compareAtPrice !== null && (
      <p class="trim-text font-semibold text-muted tabular-nums">
        {/* <s> alone is not read as "was" by most screen readers: they hear the sentence, the
              eye sees the struck-out price */}
        <span class="sr-only">
          {t('shop.product.wasPrice', { price: locale.money(product.compareAtPrice) })}
        </span>
        <s aria-hidden="true">{locale.money(product.compareAtPrice)}</s>
      </p>
    )}
  </div>
  <p class="trim-text mt-4 text-muted">{t('shop.product.perUnit', { unit: product.unitName })}</p>

  <div class="mt-8 grid grid-cols-2 gap-4 lg:flex">
    {/* The page's script handles both: this one puts the product in the cart and opens checkout */}
    <button
      type="button"
      data-place-order={product.id}
      disabled={!product.inStock}
      class:list={[
        button,
        'gap-2 bg-accent text-brand enabled:hover:bg-brand enabled:hover:text-accent',
      ]}
    >
      <HugeiconsIcon icon={ShoppingBag01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
      <span class="trim-text">{t('shop.product.placeOrder')}</span>
    </button>
    {/* ShopLayout's one listener adds it, as for every card ("data-add-to-cart") */}
    <button
      type="button"
      data-add-to-cart={product.id}
      disabled={!product.inStock}
      class:list={[button, 'gap-1 bg-cream text-brand enabled:hover:bg-accent']}
    >
      <HugeiconsIcon icon={Add01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
      <span class="trim-text">{t('shop.card.addToCart')}</span>
    </button>
  </div>

  <ul class="mt-9 flex flex-col gap-5 text-sf-small font-medium">
    {product.inStock ? (
      <li class="flex items-center gap-2">
        <HugeiconsIcon icon={CheckmarkBadge01Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
        <span class="trim-text">{t('shop.product.inStock')}</span>
      </li>
    ) : (
      <li class="flex items-center gap-2 text-promo">
        <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
        <span class="trim-text">{t('shop.product.outOfStock')}</span>
      </li>
    )}
    {product.sku !== null && (
      <li class="flex items-center gap-2">
        <HugeiconsIcon icon={ShoppingBag01Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
        <span class="trim-text">{t('shop.product.sku', { sku: product.sku })}</span>
      </li>
    )}
  </ul>

  <div class="mt-9 border-t border-rule"></div>

  {/* 25px: Figma's 26px is measured from a line with no height; this rule is a 1px border */}
  <p class="mt-[25px] flex items-center gap-3 font-semibold">
    <HugeiconsIcon
      icon={Call02Icon}
      size={24}
      strokeWidth={1.5}
      className="text-price"
      aria-hidden="true"
    />
    <span class="trim-text">
      <span class="text-price">{t('shop.product.hotline')}</span>{' '}
      <a
        href={phoneHref}
        aria-label={t('shop.product.callHotline', { phone: shop.hotline })}
        class="underline-offset-3 hover:underline"
      >
        {shop.hotline}
      </a>
    </span>
  </p>
</div>
```

The vertical gaps are Figma's, between trimmed text boxes (`trim-text`): countdown, 24px, name, 24px, size chip, 36px,
price, 16px, "Per Piece", 32px, buttons, 36px, stock and SKU (20px apart), 36px, the rule, 26px, the hotline. Measured
at 1440px, each row starts on Figma's pixel (title 184, chip 255, buttons 402, stock 482, rule 570).

- **`pt-8 pb-9` and `md:px-9`**: Figma's 32px on top, 36px at the sides and the bottom. On a phone 20px at the sides,
  like the description's sections.
- **`lg:max-w-72` on the title**: Figma's title box is 288px wide, which is why the name breaks after "Purifying".
  Below `lg` the title takes the card's width.
- **The size chip is a `<p>`**, not a button (no variants on the page, see "Not in this step"). A hidden "Size:" in
  front of it tells a screen reader what "150ml" is.
- **The old price**: the eye sees `<s>৳299</s>`, a screen reader hears "Was ৳299" (decision 8's idea, for prices).
- **`grid grid-cols-2 … lg:flex` on the buttons**: below `lg` they share the card's width; from `lg` they are
  Figma's 195px. `enabled:hover:` keeps a disabled button from changing color under the mouse.
- **Out of stock**: both buttons are disabled (`canvas` and `muted`, the card's out-of-stock look), and the stock line
  says "Out of stock" in `promo` with `Alert02`.
- **`data-add-to-cart`**: the same attribute as every card, so ShopLayout's one listener adds it, and the header's
  count and "Added to cart" work with no code here. **`data-place-order`** is read by the page's script.
- **The icons are Stroke Rounded**, the shop's one variant. Figma draws the stock and SKU icons solid (see "Known
  differences from Figma").
- **`mt-[25px]` before the hotline**: Figma measures 26px from a line with no thickness; here the rule is a 1px
  border, so 25px puts the hotline on Figma's pixel (measured: 26px made the card 549px tall).
- **The hotline is a `tel:` link** with only digits and `+` in its `href`, and an `aria-label` "Call +880 1786
  120356", so a screen reader does not read "Hotline: link".

### `src/components/ProductDescription.astro` (new)

```
---
import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Product page, description (Figma 37:3612): a card with a tab bar holding one tab,
// "Overview", then the description's sections. Reviews is not drawn: there are no reviews in the
// data model. With one tab there is nothing to switch, so "Overview" is a label, not a role="tab"
// (a tab list of one would tell a screen reader there is a choice when there is none).
interface Props {
  // shopProductSchema.descriptionHtml: <section>s with an <h2> each, cleaned by the ERP on save
  html: string;
  locale: ShopLocale;
}

const { html, locale } = Astro.props;
const { t } = locale;
---

<section aria-label={t('shop.product.details')} class="rounded-2xl bg-card-glass p-2">
  <div class="rounded-lg bg-cream p-2">
    <p class="flex h-12 w-40 items-center justify-center rounded-sm bg-brand font-semibold text-accent">
      <span class="trim-text">{t('shop.product.overview')}</span>
    </p>
  </div>
  {/* set:html: the text is the ERP's own cleaned HTML (decision 15), never the shopper's */}
  <div class="shop-prose mt-2" set:html={html} />
</section>
```

- **A `<section>` labelled "Product details"**, so a screen reader can jump to it. The headings inside are the
  description's own `<h2>`s, under the page's `<h1>`.
- **"Overview" is a `<p>`** in the tab's look (decision 19): `brand` fill, `accent` 16px/600, 160×48, inside the
  `cream` bar with 8px padding.
- **`set:html`** puts the ERP's HTML on the page as it is (decision 15). Astro would otherwise escape it and show the
  tags as text.

### `src/pages/p/[slug].astro` (new)

```
---
import LoadMoreLink from '../../components/LoadMoreLink.astro';
import ProductDescription from '../../components/ProductDescription.astro';
import ProductGallery from '../../components/ProductGallery.astro';
import ProductInfo from '../../components/ProductInfo.astro';
import ProductRow from '../../components/ProductRow.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';

// Step 26b: one product's page (Figma product_details 37:3521, 1440px). Figma has no phone frame
// for it, so below md it follows the storefront rules: the cards stack, 16px apart.
const slug = Astro.params.slug ?? '';
const [shop, page, categories] = await Promise.all([
  shopSource.shop(),
  shopSource.product(slug),
  shopSource.categories(),
]);

// An old link or a typo: Astro's own 404 page, with the 404 status, so a search engine drops the
// URL. 26d draws the shop's "page not found"
if (!page) return Astro.rewrite('/404');

const locale = await shopLocale(shop.language);
const { t } = locale;
const { product, related } = page;

// The countdown shows only for a sale still running. Worked out once here, so the info card and
// the countdown agree on "now"
const saleEnd = product.saleUntil === null ? null : new Date(product.saleUntil);
const saleUntil = saleEnd !== null && saleEnd.getTime() > Date.now() ? saleEnd : null;

const category = categories.find((candidate) => candidate.id === product.categoryId);
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.product.title', { name: product.name, shop: shop.name })}
>
  {/* Figma: 524px gallery + 16px + 740px info card. fr, not px, so the two keep their share
      between lg and xl; below lg they stack */}
  <div class="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,524fr)_minmax(0,740fr)]">
    <ProductGallery product={product} locale={locale} />
    <ProductInfo product={product} shop={shop} locale={locale} saleUntil={saleUntil} />
  </div>

  {product.descriptionHtml !== '' && (
    <div class="mt-4 md:mt-[72px]">
      <ProductDescription html={product.descriptionHtml} locale={locale} />
    </div>
  )}

  {related.length > 0 && (
    <ProductRow
      collection={{
        id: 'related',
        title: t('shop.product.related'),
        icon: null,
        listings: related,
      }}
      locale={locale}
    />
  )}

  {/* Figma's Load More under the row: the rest of the category, on its own page (26d) */}
  {related.length > 0 && category && (
    <LoadMoreLink href={`/c/${category.slug}`} label={t('shop.home.loadMore')} />
  )}
</ShopLayout>

<script>
  import { ensureInCart } from '../../lib/cart';

  // "Place Order": the product goes into the cart (once), then checkout (26c) opens with the cart
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-place-order]');
    const listingId = button?.dataset.placeOrder;
    if (!listingId) return;
    ensureInCart(listingId);
    window.location.assign('/checkout');
  });
</script>
```

- **`Promise.all` of the shop, the product and the categories**: none needs another's answer, so with the real API
  the three requests go out at once.
- **`return Astro.rewrite('/404')`** for an unknown slug: Astro answers with its own 404 page and the 404 status
  (checked: `/p/nope` is 404). A search engine then drops the old URL. The shop's own "page not found" comes in 26d.
- **The locale is loaded after the 404 check**: a missing product never pays for loading the Bangla words.
- **`saleUntil` is worked out here**, once: a sale that has ended (the API's data can be a few seconds old) shows no
  countdown at all, instead of a row of zeros.
- **`lg:grid-cols-[minmax(0,524fr)_minmax(0,740fr)]`**: Figma's two widths as shares of the row, so between `lg` and
  `xl` both cards shrink in proportion. `minmax(0, …)` lets a column shrink below its content's width (a grid column's
  minimum is otherwise its widest word). `items-start`: the info card keeps its own height instead of stretching.
- **`mt-4 md:mt-[72px]`** before the description: Figma's 72px below the thumbnails; 16px on a phone, the storefront's
  gap between blocks.
- **The related row is a `ProductRow`** with a collection made here, so it has the home page's header, arrows and
  scrolling with no new code. Its title is `t('shop.product.related')`.
- **Load More goes to the product's category** (`/c/cosmetics`), which 26d builds. It shows only when there is a row
  above it and the category is known.
- **The page's script** handles "Place Order": `ensureInCart`, then `/checkout` (decision 18). One listener on the
  document, like ShopLayout's, so it works for any `data-place-order` button.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/shop test
pnpm --filter @omnivo/shop build
PORT=4399 pnpm --filter @omnivo/shop start
```

The shop reads both packages from `dist/`, so they are built first (`astro check` stops on `shop.product.title` if
i18n is not). Then open `http://localhost:4399/p/himalaya-purifying-neem-face-wash-150ml`:

- The clock ticks, and a screen reader hears "Sale ends …" once.
- The second thumbnail shows the tilted tube in the big card and gets the `brand` border.
- "Add to cart" raises the header's count to 1. "Place Order" then opens `/checkout` (a 404 until 26c), and the cart
  still has one, not two.
- `/p/zero-cal-stevia-30-sachets` is a plain page: one photo and no thumbnails, no countdown, no SKU, no Overview card,
  four related products, and Load More to `/c/diabetic-care`.
- `/p/nope` answers 404.

## 26b.5 — `apps/shop`: the cart drawer

The header's cart button opens a drawer from the right: the lines with today's prices, a stepper and a delete button
per line, the subtotal and "Checkout". It is not in Figma; `CLAUDE.md` → Storefront → Cart drawer describes it, and
decision 26 fills in the sizes it leaves open.

How it works, in short: the browser keeps only ids and counts (26a). When the drawer opens, it sends them to
`/api/cart/quote` (part 26b.3) and draws the answer. Every change in the drawer changes the stored cart at once, and the
prices follow from the next answer (decision 23).

### `packages/i18n/package.json`

```diff
@@ -7,6 +7,10 @@
     ".": {
       "types": "./dist/index.d.ts",
       "default": "./dist/index.js"
+    },
+    "./format": {
+      "types": "./dist/format.d.ts",
+      "default": "./dist/format.js"
     }
   },
   "scripts": {
```

A second entry, `@omnivo/i18n/format`, next to the main one (decision 22). It points at the same built file the main
entry already re-exports, so there is nothing new to build. `package.json` cannot hold comments, so the reason is
written in `format.ts` instead.

### `packages/i18n/src/format.ts`

```diff
@@ -1,3 +1,6 @@
+// Step 26b: this file is also the package's own entry '@omnivo/i18n/format', which the shop's
+// browser scripts import to format money without i18next and its translations. So it may import
+// only types from the rest of the package: one value import would bring all of it back.
 import type { Language } from './i18n.js';
 
 // en-IN = লাখ/কোটি গ্রুপিং (18,42,600); bn-BD = একই গ্রুপিং, বাংলা অঙ্কে (১৮,৪২,৬০০)
```

The comment is the rule that keeps the entry small: `format.ts` may import only types from the rest of the package.
`import type` is removed when TypeScript compiles, so the built `format.js` imports nothing. One value import (say, of
`i18n` to read the current language) would bring i18next and the English words into the shop's browser code, and the
shop's boundaries test (below) would fail.

### `src/lib/money.ts` (new)

```ts
import { formatMoney } from '@omnivo/i18n/format';

import type { Language } from '@omnivo/i18n';

// A shop price is a unit price: whole taka when it is whole ("৳1,199"), paisa only when it has
// them ("৳49.50"). CLAUDE.md → Money keeps decimals for unit prices only; this keeps a shelf of
// whole prices from showing ".00" on every card.
// Step 26b: out of locale.ts, so the cart drawer's script can use it in the browser. It imports
// '@omnivo/i18n/format', never '@omnivo/i18n': the package's main entry starts i18next with its
// English words (about 150 KB gz), and the drawer only formats numbers.
export function shopMoney(value: string, language: Language): string {
  const hasPaisa = /\.\d*[1-9]/.test(value);
  return formatMoney(value, language, { decimals: hasPaisa ? 2 : 0 });
}
```

`shopMoney` moves here from `locale.ts`, unchanged. `locale.ts` imports `@omnivo/i18n` for `t()`, so a browser script
that imported `shopMoney` from there would bring i18next with it. Here it imports only `@omnivo/i18n/format`. The
`Language` type comes from the main entry, but as `import type`, which leaves nothing in the built file.

### `src/lib/locale.ts`

```diff
@@ -1,4 +1,6 @@
-import { formatMoney, i18n, setLanguage, type Language } from '@omnivo/i18n';
+import { i18n, setLanguage, type Language } from '@omnivo/i18n';
+
+import { shopMoney } from './money';
 
 // Step 26a: the words and number format of one page, worked out once in the page and handed to
 // every component. The shop speaks its own language (PublicShop.language), not the shopper's last
@@ -18,11 +20,3 @@ export async function shopLocale(language: Language) {
 }
 
 export type ShopLocale = Awaited<ReturnType<typeof shopLocale>>;
-
-// A shop price is a unit price: whole taka when it is whole ("৳1,199"), paisa only when it has
-// them ("৳49.50"). CLAUDE.md → Money keeps decimals for unit prices only; this keeps a shelf of
-// whole prices from showing ".00" on every card.
-export function shopMoney(value: string, language: Language): string {
-  const hasPaisa = /\.\d*[1-9]/.test(value);
-  return formatMoney(value, language, { decimals: hasPaisa ? 2 : 0 });
-}
```

`locale.money` keeps working as before; it now calls the moved function. Nothing else in the pages changes.

### `src/lib/quote.ts` (new)

```ts
import type { ShopCartQuote, ShopCartQuoteLine } from '@omnivo/contracts';

import type { CartLine } from './cart';

// Step 26b: the cart drawer's one request. The browser sends the cart's ids and counts and gets
// today's prices back (system design §14.4); it never adds money itself.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Hand-written like cart.ts's isCartLine, for the same reason: Zod would add 25 KB gz to every page.
// The answer comes from our own route, so this is not a full check of the contract. It checks what
// the drawer draws and links to, so a broken answer shows "Try again", never "undefined" or a
// link to somewhere else.
const MONEY = /^\d+(\.\d{1,4})?$/;
const LINK = /^(\/(?!\/)|https:\/\/)/;

function isMoney(value: unknown): value is string {
  return typeof value === 'string' && MONEY.test(value);
}

function isQuoteLine(value: unknown): value is ShopCartQuoteLine {
  if (!isRecord(value) || typeof value.listingId !== 'string') return false;
  if (value.status === 'unavailable') return true;
  if (value.status !== 'available' && value.status !== 'out_of_stock') return false;

  const { slug, name, packSize, image, quantity } = value;
  const shown =
    typeof slug === 'string' &&
    typeof name === 'string' &&
    typeof packSize === 'string' &&
    isRecord(image) &&
    typeof image.url === 'string' &&
    LINK.test(image.url) &&
    typeof image.alt === 'string' &&
    typeof quantity === 'number' &&
    Number.isInteger(quantity);
  if (value.status === 'out_of_stock') return shown;
  return shown && isMoney(value.unitPrice) && isMoney(value.lineTotal);
}

export function isCartQuote(value: unknown): value is ShopCartQuote {
  return (
    isRecord(value) &&
    Array.isArray(value.lines) &&
    value.lines.every(isQuoteLine) &&
    typeof value.itemCount === 'number' &&
    isMoney(value.subtotal)
  );
}

// Any answer the drawer cannot draw: no network, a 4xx/5xx problem, or a body that is not a quote.
// The drawer shows one message for all of them with "Try again"; the details are for the console.
export class QuoteFailedError extends Error {
  override name = 'QuoteFailedError';
}

export async function fetchQuote(lines: CartLine[], signal: AbortSignal): Promise<ShopCartQuote> {
  // An AbortError (the shopper changed the cart again, or closed the drawer) is passed on as it
  // is: the drawer ignores it, because a newer request is already on its way or nobody is looking
  const response = await fetch('/api/cart/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ lines }),
    signal,
  });
  if (!response.ok) {
    throw new QuoteFailedError(`quote answered ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!isCartQuote(body)) throw new QuoteFailedError('quote answer has the wrong shape');
  return body;
}
```

- **`import type` from `@omnivo/contracts`.** The types describe the answer for free; the schema itself would bring
  Zod (about 25 KB gz) into every page.
- **`isCartQuote` is hand-written**, like `isCartLine` in `cart.ts`. The answer comes from our own route, so this is
  not a second copy of the contract. It checks what the drawer draws or links to: the status, the texts, the picture,
  the quantity and the money. Without it, a broken answer (a proxy's HTML error page, an older server after a deploy)
  would draw "undefined" in the drawer.
- **`LINK` on the picture's URL** is the contract's own rule (a path on the site or `https://`). The drawer puts it in
  an `<img src>`; checking it keeps a `javascript:` or `data:` value out, whatever the server sends.
- **`MONEY`** accepts the contract's amounts, up to 4 decimals (`"687.0000"`), with no sign: a quote never has a
  negative amount.
- **`fetchQuote` lets an `AbortError` through.** When the shopper clicks again, or closes the drawer, the older request
  is cancelled. The drawer checks `signal.aborted` and ignores it; any other error becomes "Try again".
- **`QuoteFailedError`** for a 4xx/5xx answer or a body of the wrong shape. The message is for the console only; the
  shopper always sees the one sentence from `shop.cart.failed`.

### `src/lib/quote.spec.ts` (new)

```ts
import { describe, expect, it } from 'vitest';

import { mockCatalog } from '../data/mock/products';
import { quoteCart } from '../data/mock/quote';
import { isCartQuote } from './quote';

describe('isCartQuote', () => {
  // The guard is hand-written, so it is tested against what the server really sends: every kind
  // of line the mock source can answer
  it('takes the answers the quote route sends', () => {
    const inStock = mockCatalog.find((listing) => listing.inStock);
    const outOfStock = mockCatalog.find((listing) => !listing.inStock);
    if (!inStock || !outOfStock) throw new Error('the mock catalog needs both kinds');

    const quote = quoteCart(
      {
        lines: [
          { listingId: inStock.id, quantity: 3 },
          { listingId: outOfStock.id, quantity: 1 },
          { listingId: 'lst-gone', quantity: 2 },
        ],
      },
      mockCatalog,
    );
    expect(quote.lines.map((line) => line.status)).toEqual([
      'available',
      'out_of_stock',
      'unavailable',
    ]);
    expect(isCartQuote(quote)).toBe(true);
    expect(isCartQuote(quoteCart({ lines: [] }, mockCatalog))).toBe(true);
  });

  it('refuses a body it could not draw', () => {
    const line = {
      status: 'available',
      listingId: 'lst-a',
      slug: 'neem',
      name: 'Neem',
      packSize: '150ml',
      image: { url: '/mock/neem.png', alt: 'Neem' },
      quantity: 1,
      unitPrice: '229.0000',
      lineTotal: '229.0000',
    };
    const quote = { lines: [line], itemCount: 1, subtotal: '229.0000' };
    expect(isCartQuote(quote)).toBe(true);

    // A problem+json body, an unknown status, a missing price and an image on another scheme
    expect(isCartQuote({ type: 'about:blank', status: 500, code: 'internal_error' })).toBe(false);
    expect(isCartQuote({ ...quote, lines: [{ ...line, status: 'reserved' }] })).toBe(false);
    expect(isCartQuote({ ...quote, lines: [{ ...line, lineTotal: undefined }] })).toBe(false);
    expect(
      isCartQuote({
        ...quote,
        lines: [{ ...line, image: { url: 'javascript:alert(1)', alt: 'x' } }],
      }),
    ).toBe(false);
    expect(isCartQuote({ ...quote, subtotal: 229 })).toBe(false);
  });
});
```

- **"takes the answers the quote route sends"** builds real answers with the mock's `quoteCart` (one line of each
  status, and an empty cart). A hand-written guard that refused a real answer would break the drawer for every
  shopper, so this is the test that matters most.
- **"refuses a body it could not draw"**: a problem+json body, an unknown status, a missing line total, a
  `javascript:` picture and a number where a money string should be.

### `src/components/CartDrawer.astro` (new)

The file is long, so it is shown in parts. First the frame and three of the four states:

```
---
import {
  Add01Icon,
  Alert02Icon,
  Cancel01Icon,
  Delete02Icon,
  Loading03Icon,
  MinusSignIcon,
  ShoppingCart01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { numberLocale } from '@omnivo/i18n';

import type { ShopLocale } from '../lib/locale';

// CLAUDE.md → Storefront → Cart drawer (not in Figma): from the right, 420px wide (the whole width
// on a phone), the checkout's lines with a 96×80 picture, the subtotal, and Checkout. One per page,
// in ShopLayout; the header's cart button opens it.
// A custom element around a native <dialog>, not a React island (decision 21): showModal() gives
// the focus trap, Escape, the inert page behind and the backdrop for free, and the script stays a
// few KB instead of React plus the translations.
// The server draws everything that never changes: the frame, the four states and one line as a
// <template>, icons included. The script clones the template for each line and fills in the text,
// so all markup and classes stay in this file.
interface Props {
  locale: ShopLocale;
}

const { locale } = Astro.props;
const { t } = locale;

// Words with a name or a count in them go to the script as templates; it puts the value in
const name = { name: '{{name}}' };
const stepper =
  'grid size-10 place-items-center rounded-[5px] bg-cream text-brand transition-colors duration-150 not-aria-disabled:hover:bg-accent aria-disabled:text-muted';
---

<cart-drawer
  class="group/cart"
  data-language={locale.language}
  data-number-locale={numberLocale(locale.language)}
  data-label-decrease={t('shop.cart.decrease', name)}
  data-label-increase={t('shop.cart.increase', name)}
  data-label-quantity={t('shop.cart.quantity', name)}
  data-label-remove={t('shop.cart.remove', name)}
  data-label-removed-one={t('shop.cart.removed', { count: 1, replace: { count: '{{count}}' } })}
  data-label-removed-other={t('shop.cart.removed', { count: 2, replace: { count: '{{count}}' } })}
>
  {/* The native dialog is centered and padded; these classes pin it to the right edge, full
      height. `max-w-none max-h-none`: the browser's own style keeps a modal 2em off every edge */}
  <dialog
    data-cart-drawer
    aria-labelledby="cart-drawer-title"
    class="m-0 ml-auto h-dvh max-h-none w-full max-w-none border-0 bg-card p-0 text-brand backdrop:bg-overlay md:w-[420px]"
  >
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between gap-4 border-b border-rule px-5 py-4 md:px-6 md:py-5">
        <h2 id="cart-drawer-title" class="text-sf-title font-semibold">
          {t('shop.cart.title')}
        </h2>
        <button
          type="button"
          data-close
          aria-label={t('shop.cart.close')}
          class="-mr-2 grid size-10 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-canvas hover:text-brand"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {/* Only the first time: later answers keep the lines on screen and grey the amounts */}
      <div data-state="loading" class="grid flex-1 place-items-center p-6">
        <p role="status" class="flex items-center gap-2.5 font-medium text-muted">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={24}
            strokeWidth={1.5}
            className="animate-spin"
            aria-hidden="true"
          />
          {t('shop.cart.loading')}
        </p>
      </div>

      {/* role="alert": the shopper is waiting for prices, so a failure is said at once */}
      <div data-state="failed" hidden class="grid flex-1 place-items-center p-6">
        <div role="alert" class="flex max-w-80 flex-col items-center gap-6 text-center">
          <span class="grid size-16 place-items-center rounded-full bg-promo-soft text-promo">
            <HugeiconsIcon icon={Alert02Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <p class="text-body">{t('shop.cart.failed')}</p>
          <button
            type="button"
            data-retry
            class="h-11 rounded-sm bg-cream px-6 font-semibold transition-colors duration-150 hover:bg-accent"
          >
            {t('shop.cart.retry')}
          </button>
        </div>
      </div>

      {/* CLAUDE.md → Storefront → Empty state, without its card: the drawer is the card */}
      <div data-state="empty" hidden class="grid flex-1 place-items-center px-6 py-12">
        <div class="flex flex-col items-center gap-4 text-center">
          <span class="grid size-16 place-items-center rounded-full bg-cream">
            <HugeiconsIcon
              icon={ShoppingCart01Icon}
              size={28}
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </span>
          <h3 class="text-sf-title font-semibold">{t('shop.cart.emptyTitle')}</h3>
          <p class="max-w-72 text-muted">{t('shop.cart.emptyText')}</p>
          <button
            type="button"
            data-close
            data-continue
            class="mt-2 h-11 rounded-sm bg-accent px-6 font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent"
          >
            {t('shop.cart.continueShopping')}
          </button>
        </div>
      </div>
```

- **The words go to the script as templates.** `t('shop.cart.decrease', { name: '{{name}}' })` gives
  `One less {{name}}`; the script puts each line's name in. The same trick as the header's cart count (26a). The
  removed message comes in its `one` and `other` forms, and the script picks one with `Intl.PluralRules`.
- **`data-number-locale`** (`en-IN` or `bn-BD`) is for the quantity box and the count in the message; `data-language`
  is for `shopMoney`.
- **The `<dialog>` classes.** The browser's own style centers a modal dialog and keeps it 2em off every edge
  (`max-width` and `max-height`). `m-0 ml-auto` puts it at the right edge, `h-dvh max-h-none` makes it as tall as the
  screen (`dvh`, so a phone's address bar does not hide the Checkout button), `w-full md:w-[420px]` is the whole width
  on a phone and 420px from `md`. `backdrop:bg-overlay` colors the dim layer behind it, with no blur.
- **The close button is the first thing in the dialog**, so `showModal()` puts the focus there. A shopper using the
  keyboard can close at once, or Tab into the lines.
- **Four states, one shown at a time** (`data-state`): loading, failed, empty and ready. Loading is only for the first
  answer after the page loads; later the lines stay on screen while new prices come (decision 23).
- **The failed state uses `role="alert"`**: the shopper is waiting for the prices, so a failure must be said at once.
  The tile is `promo-soft`/`promo`, the shop's color for a problem.
- **The empty state is `CLAUDE.md`'s, without its card**: the drawer is already the card. Its button has both
  `data-close` (it closes the drawer) and `data-continue` (the script moves the focus to it when the last line goes).

```
      <div data-state="ready" hidden class="flex min-h-0 flex-1 flex-col">
        {/* The lines scroll; the subtotal and Checkout stay at the bottom */}
        <ul
          data-lines
          class="min-h-0 flex-1 divide-y divide-rule overflow-y-auto px-5 md:px-6"
        ></ul>
        <div class="border-t border-rule px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] md:px-6 md:pb-6">
          <p class="flex items-center justify-between gap-4">
            <span class="font-semibold">{t('shop.cart.subtotal')}</span>
            {/* Grey while a newer cart is being priced: the amount is not today's answer yet */}
            <span
              data-subtotal
              class="text-sf-subtitle font-semibold text-price tabular-nums transition-colors duration-150 group-data-pricing/cart:text-muted"
            ></span>
          </p>
          {/* A link, not a button: checkout is a page. aria-disabled (and no href) when nothing
              in the cart can be sold now */}
          <a
            href="/checkout"
            data-checkout
            class="mt-5 flex h-13 w-full items-center justify-center rounded-sm bg-accent font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent aria-disabled:bg-canvas aria-disabled:text-muted"
          >
            {t('shop.cart.checkout')}
          </a>
        </div>
      </div>

      {/* "2 items are no longer sold…": nothing on screen says it, so a screen reader hears it */}
      <p data-announce role="status" class="sr-only"></p>
    </div>

    <template data-line-template>
      <li data-line class="flex gap-4 py-5">
        {/* A block, not a grid: in a grid cell the picture's 100% height has nothing fixed to
            measure against, and a tall photo (a can) would spill out of the 80px */}
        <span class="block h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-canvas">
          {/* alt="": the name next to it says what it is */}
          <img data-image alt="" class="size-full object-contain mix-blend-multiply" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex items-start justify-between gap-3">
            <a data-name class="line-clamp-2 font-semibold hover:underline"></a>
            <span
              data-line-total
              class="shrink-0 font-semibold text-price tabular-nums transition-colors duration-150 group-data-pricing/cart:text-muted"
            ></span>
          </div>
          <p data-pack class="text-sf-meta font-semibold text-muted"></p>
          <p
            data-out-of-stock
            hidden
            class="flex items-center gap-1 text-sf-small font-medium text-promo"
          >
            <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.5} aria-hidden="true" />
            {t('shop.cart.outOfStock')}
          </p>
          <div class="mt-2 flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              {/* aria-disabled, not disabled: a disabled button loses the focus, and the shopper
                  pressing "one less" down to 1 would be thrown out of the stepper */}
              <button type="button" data-decrease class={stepper}>
                <HugeiconsIcon
                  icon={MinusSignIcon}
                  size={14}
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
              </button>
              <input
                type="text"
                inputmode="numeric"
                autocomplete="off"
                data-quantity
                class="h-10 w-15 rounded-[5px] border-[1.5px] border-cream bg-card text-center text-[20px] tabular-nums disabled:text-muted"
              />
              <button type="button" data-increase class={stepper}>
                <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              data-remove
              class="grid size-10 place-items-center rounded-[5px] bg-promo-soft text-promo transition-colors duration-150 hover:bg-promo hover:text-white"
            >
              <HugeiconsIcon icon={Delete02Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </div>
      </li>
    </template>
  </dialog>
</cart-drawer>
```

- **The list scrolls, the footer does not.** `min-h-0 flex-1 overflow-y-auto` on the list: in a column flex box a
  child is at least as tall as its content unless `min-h-0` says otherwise, and the footer would be pushed off the
  screen by a long cart.
- **`group-data-pricing/cart:text-muted`** on the subtotal and every line total. The script sets `data-pricing` on
  `<cart-drawer>` while the amounts belong to an older cart (decision 23). A named group (`/cart`), so a `group` class
  somewhere inside cannot switch it by mistake.
- **`pb-[max(20px,env(safe-area-inset-bottom))]`**: on an iPhone without a home button, the Checkout button stays
  above the home bar.
- **Checkout is a link** (`/checkout` is a page). When nothing can be sold, the script removes `href` and sets
  `aria-disabled`: a link with no `href` cannot be followed, and the `aria-disabled:` classes grey it (decision 25).
- **`data-announce`** is a `role="status"` region for the one thing the screen does not show: listings that left the
  cart.
- **The line `<template>`.** The server draws one line, icons and classes included, and the browser never shows it.
  The script copies it for each line. All the markup stays in this file, in the same Tailwind classes Tailwind scans,
  and the script only sets text and attributes.
- **The picture box is a block, not a grid.** In a grid cell, the picture's `size-full` has no fixed height to measure
  against, and a tall photo (a can) spilled out of the 80px box. Found in Chromium with the Sprite can.
- **The stepper buttons use `aria-disabled`, not `disabled`.** A disabled button loses the focus: a shopper pressing
  "one less" down to 1 would find the focus thrown to the page's start. With `aria-disabled` the focus stays, the
  screen reader says "dimmed", and the script ignores the click. `not-aria-disabled:hover:bg-accent` keeps the hover
  color off a dimmed button.
- **The quantity box is a text box with `inputmode="numeric"`**, not `type="number"`: a number box refuses Bangla
  digits, and its arrows and scroll wheel would change the cart by accident. The script reads both kinds of digits.

Then the script. Its setup, and opening and closing:

```
<script>
  import type { ShopCartQuote, ShopCartQuoteLine } from '@omnivo/contracts';
  import type { Language } from '@omnivo/i18n';

  import { $cart, MAX_QUANTITY, removeFromCart, setQuantity, type CartLine } from '../lib/cart';
  import { shopMoney } from '../lib/money';
  import { fetchQuote } from '../lib/quote';

  type State = 'loading' | 'failed' | 'empty' | 'ready';
  // The lines the drawer draws: an unavailable one has only its id, and leaves the cart
  type ShownLine = Exclude<ShopCartQuoteLine, { status: 'unavailable' }>;

  // How long the stepper waits for the next click before asking for prices: five quick clicks on
  // "one more" make one request, not five
  const QUOTE_DELAY = 250;

  // The cart as a string, to tell whether the quote on screen is the answer for this cart
  function cartKey(lines: readonly CartLine[]): string {
    return JSON.stringify(lines);
  }

  // A Bangla keyboard types ০–৯; the cart keeps ASCII numbers
  function parseQuantity(text: string): number | undefined {
    const ascii = text.replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
    return /^\d+$/.test(ascii.trim()) ? Number(ascii.trim()) : undefined;
  }

  function part<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    // The markup is in the same file: a missing part is a bug to see at once, not to skip
    if (!element) throw new Error(`cart drawer: ${selector} is missing`);
    return element;
  }

  class CartDrawer extends HTMLElement {
    private quote: ShopCartQuote | undefined;
    // The cart the quote on screen answered. '' after opening: the drawer always asks again,
    // because the shop may have changed a price since the last time it was open
    private quotedKey = '';
    private controller: AbortController | undefined;
    private timer: number | undefined;
    private unsubscribe: (() => void) | undefined;
    private language: Language = 'en';
    private number = new Intl.NumberFormat('en-IN');

    // Any [data-open-cart] on the page opens the drawer: the header's cart button today. One
    // listener on the document, like "Add to cart" in ShopLayout
    private readonly onDocumentClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-open-cart]')) this.open();
    };

    private get dialog(): HTMLDialogElement {
      return part(this, 'dialog');
    }

    private get list(): HTMLUListElement {
      return part(this, '[data-lines]');
    }

    connectedCallback(): void {
      // 'bn' or anything else: the page writes only 'en' or 'bn'
      this.language = this.dataset.language === 'bn' ? 'bn' : 'en';
      this.number = new Intl.NumberFormat(this.dataset.numberLocale ?? 'en-IN');
      const dialog = this.dialog;

      document.addEventListener('click', this.onDocumentClick);
      for (const button of this.querySelectorAll('[data-close]')) {
        button.addEventListener('click', () => {
          dialog.close();
        });
      }
      // A click on the dim backdrop lands on the <dialog> itself; a click inside lands on its
      // content, which fills the whole dialog
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      // Escape, the close button, the backdrop: every way out ends here. The browser puts the
      // focus back on the cart button by itself
      dialog.addEventListener('close', () => {
        this.stop();
      });
      part(this, '[data-retry]').addEventListener('click', () => {
        this.show('loading');
        this.requestQuote(0);
      });

      const list = this.list;
      list.addEventListener('click', (event) => {
        this.onLineClick(event);
      });
      list.addEventListener('change', (event) => {
        this.onQuantityTyped(event);
      });
    }

    disconnectedCallback(): void {
      document.removeEventListener('click', this.onDocumentClick);
      this.stop();
    }

    open(): void {
      const dialog = this.dialog;
      if (dialog.open) return;
      dialog.showModal();
      this.quotedKey = '';
      // While open only: a closed drawer has nothing to draw, and asks for no prices. subscribe()
      // calls back at once with the cart as it is now
      this.unsubscribe = $cart.subscribe((lines) => {
        this.cartChanged(lines);
      });
    }

    private stop(): void {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      window.clearTimeout(this.timer);
      // An answer that comes after closing would be drawn for nobody
      this.controller?.abort();
      this.controller = undefined;
    }

    private show(state: State): void {
      for (const element of this.querySelectorAll<HTMLElement>('[data-state]')) {
        element.hidden = element.dataset.state !== state;
      }
    }
```

- **Only types from the contracts and i18n** (decision 22); the values come from the shop's own `lib/` files.
- **`parseQuantity`** turns Bangla digits (০ is U+09E6) into ASCII and accepts only digits. `"১২"` is 12; `"abc"` and
  `""` are `undefined`, and the box goes back to the cart's number.
- **`part()` throws** when a piece of markup is missing. The markup is in the same file, so a missing piece is a bug;
  throwing shows it in the console at once instead of a drawer that silently does nothing.
- **`quotedKey`** is the cart (as a string) that the quote on screen answers. The drawer compares it with the cart now
  to know whether the amounts are current.
- **One click listener on the document** for `[data-open-cart]`, like ShopLayout's "Add to cart". Any page can add a
  button that opens the cart without knowing about the drawer.
- **The backdrop click.** A click on the dim layer is a click on the `<dialog>` element itself; a click inside lands on
  its content (the inner `div` fills the dialog), so `event.target === dialog` means "outside".
- **Everything ends in the `close` event**: Escape, the close button, the backdrop and "Continue shopping" all close the
  dialog, and `stop()` runs once for all of them. The browser puts the focus back on the cart button by itself.
- **`open()` subscribes to the cart; `stop()` unsubscribes.** A closed drawer draws nothing and asks for no prices.
  `subscribe` calls back at once, which is the first draw. `quotedKey = ''` makes that first draw ask for fresh
  prices.
- **`stop()` cancels the request.** An answer that comes after closing would be drawn for nobody.

The cart changing, and asking for prices:

```
    // The cart changed: opening the drawer, a click in it, or another tab. The new quantities show
    // at once; the prices follow when the server answers
    private cartChanged(lines: readonly CartLine[]): void {
      if (lines.length === 0) {
        window.clearTimeout(this.timer);
        this.controller?.abort();
        this.show('empty');
        return;
      }
      if (this.quote) this.render(lines);
      else this.show('loading');
      // The quote on screen answers this very cart (a line the server dropped was just removed)
      if (cartKey(lines) === this.quotedKey) return;
      // The first request after opening goes at once; the rest wait for the clicks to stop
      this.requestQuote(this.quotedKey === '' ? 0 : QUOTE_DELAY);
    }

    private requestQuote(delay: number): void {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        void this.loadQuote();
      }, delay);
    }

    private async loadQuote(): Promise<void> {
      const lines = $cart.get();
      if (lines.length === 0) return;
      // One request at a time: the older one's answer is for a cart that no longer exists
      this.controller?.abort();
      const controller = new AbortController();
      this.controller = controller;

      let quote: ShopCartQuote;
      try {
        quote = await fetchQuote(lines, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(error);
        // Old prices could be wrong now, so they go: the shopper sees why and can try again
        this.quote = undefined;
        this.show('failed');
        return;
      }
      if (controller !== this.controller) return;

      this.quote = quote;
      // Listings the shop no longer sells leave the stored cart. The rest of the answer is still
      // right without them (they add nothing to the subtotal), so the quote counts as the answer
      // for the cart that is left, and removing them asks for nothing again
      const gone = new Set(
        quote.lines.filter((line) => line.status === 'unavailable').map((line) => line.listingId),
      );
      this.quotedKey = cartKey(lines.filter((line) => !gone.has(line.listingId)));
      if (gone.size > 0) {
        this.say(gone.size);
        removeFromCart(gone);
      }
      const now = $cart.get();
      if (now.length === 0) this.show('empty');
      else this.render(now);
    }

    private say(count: number): void {
      const { labelRemovedOne = '', labelRemovedOther = '', numberLocale = 'en-IN' } = this.dataset;
      const one = new Intl.PluralRules(numberLocale).select(count) === 'one';
      part<HTMLElement>(this, '[data-announce]').textContent = (
        one ? labelRemovedOne : labelRemovedOther
      ).replace('{{count}}', this.number.format(count));
    }
```

- **`cartChanged` runs for every change**: opening, a click in the drawer, or another tab (the cart store follows the
  `storage` event, 26a). An empty cart shows the empty state at once and asks nothing. Otherwise the lines are drawn
  with the new numbers right away, and the prices are asked for.
- **The first request goes at once; later ones wait 250ms** (`QUOTE_DELAY`). Each click restarts the timer, so a burst
  of clicks makes one request.
- **`controller !== this.controller`** after the answer: a newer request was started while this one was on the way, so
  this answer is for an older cart. Usually the abort already stopped it; this catches an answer that arrived in the
  same moment.
- **On failure the quote is dropped** (`this.quote = undefined`) before showing "Try again" (decision 28).
- **Unavailable lines.** They add nothing to the subtotal, so the rest of the answer is right without them.
  `quotedKey` is set to the cart without them, and then they are removed. Removing them changes the cart, which runs
  `cartChanged`, which finds the key equal and asks for nothing more. Without this, every removal would cost a second
  request.
- **`say()`** writes the removed message into the status region, with the count in the shop's digits.

Drawing the lines:

```
    // Draws the quote's lines that are still in the cart, with the cart's quantities. Lines are
    // kept by listing and only moved when the order changed: replacing them would drop the focus
    // from the stepper button the shopper is pressing
    private render(cart: readonly CartLine[]): void {
      const quote = this.quote;
      if (!quote) return;
      const quantities = new Map(cart.map((line) => [line.listingId, line.quantity]));
      const shown = quote.lines.filter(
        (line): line is ShownLine =>
          line.status !== 'unavailable' && quantities.has(line.listingId),
      );
      // Everything in the cart came from another tab after this quote: wait for the next one
      if (shown.length === 0) {
        this.show('loading');
        return;
      }

      const list = this.list;
      const existing = new Map(
        [...list.querySelectorAll<HTMLLIElement>('[data-line]')].map((li) => [li.dataset.line, li]),
      );
      shown.forEach((line, index) => {
        const li = existing.get(line.listingId) ?? this.newLine();
        existing.delete(line.listingId);
        this.fill(li, line, quantities.get(line.listingId) ?? line.quantity);
        if (list.children[index] !== li) list.insertBefore(li, list.children[index] ?? null);
      });
      for (const li of existing.values()) li.remove();

      part(this, '[data-subtotal]').textContent = shopMoney(quote.subtotal, this.language);
      const checkout = part<HTMLAnchorElement>(this, '[data-checkout]');
      // Every line out of stock: nothing to order
      if (quote.itemCount > 0) {
        checkout.href = '/checkout';
        checkout.removeAttribute('aria-disabled');
      } else {
        checkout.removeAttribute('href');
        checkout.setAttribute('aria-disabled', 'true');
      }
      this.toggleAttribute('data-pricing', cartKey(cart) !== this.quotedKey);
      this.show('ready');
    }

    private newLine(): HTMLLIElement {
      const template = part<HTMLTemplateElement>(this, '[data-line-template]');
      // importNode, not cloneNode: same copy, but typed as the fragment it is
      return part<HTMLLIElement>(document.importNode(template.content, true), 'li');
    }

    private fill(li: HTMLLIElement, line: ShownLine, quantity: number): void {
      const {
        labelDecrease = '',
        labelIncrease = '',
        labelQuantity = '',
        labelRemove = '',
      } = this.dataset;
      const label = (template: string): string => template.replace('{{name}}', line.name);
      const inStock = line.status === 'available';
      li.dataset.line = line.listingId;

      const image = part<HTMLImageElement>(li, '[data-image]');
      // Setting the same src again would not reload it, but checking keeps the intent plain
      if (image.getAttribute('src') !== line.image.url) image.src = line.image.url;
      const name = part<HTMLAnchorElement>(li, '[data-name]');
      // The slug comes from the server; encoded, it can only ever be a path under /p/
      name.href = `/p/${encodeURIComponent(line.slug)}`;
      name.textContent = line.name;
      part(li, '[data-pack]').textContent = line.packSize;

      const total = part<HTMLElement>(li, '[data-line-total]');
      total.hidden = !inStock;
      total.textContent = inStock ? shopMoney(line.lineTotal, this.language) : '';
      part<HTMLElement>(li, '[data-out-of-stock]').hidden = inStock;

      const decrease = part<HTMLButtonElement>(li, '[data-decrease]');
      const increase = part<HTMLButtonElement>(li, '[data-increase]');
      const input = part<HTMLInputElement>(li, '[data-quantity]');
      decrease.setAttribute('aria-label', label(labelDecrease));
      increase.setAttribute('aria-label', label(labelIncrease));
      input.setAttribute('aria-label', label(labelQuantity));
      part(li, '[data-remove]').setAttribute('aria-label', label(labelRemove));
      decrease.setAttribute('aria-disabled', String(!inStock || quantity <= 1));
      increase.setAttribute('aria-disabled', String(!inStock || quantity >= MAX_QUANTITY));
      // An out-of-stock line can only be removed: its count changes nothing
      input.disabled = !inStock;
      // Not while the shopper is typing in it: the box would jump back under their fingers
      if (document.activeElement !== input) input.value = this.number.format(quantity);
    }
```

- **The lines shown are the quote's lines that are still in the cart**, with the cart's numbers. A line just deleted
  goes at once; a line added in another tab shows when its price comes.
- **Lines are kept by listing id and moved only when the order changed.** Drawing a new list on every click would
  replace the stepper button the shopper's focus is on, and the focus would fall to the page. `insertBefore` runs only
  when a line is not already in its place, because moving an element also drops its focus.
- **`document.importNode(template.content, true)`** copies the template. `cloneNode` does the same, but TypeScript
  types its result as a plain `Node`, which would need a cast.
- **`image.src` is set only when it changed**, so redrawing a line never makes the browser look at the picture again.
- **`encodeURIComponent(line.slug)`**: the link is always a path under `/p/`, whatever the slug holds.
- **The out-of-stock line** hides its total, shows the note, dims both stepper buttons and disables the box
  (decision 25). Disabling the box is fine: nobody is typing in a box that cannot change anything.
- **The box is not rewritten while it has the focus**: an answer that came in while the shopper typed "12" would put
  "1" back under their fingers.

What the shopper does in a line:

```
    private onLineClick(event: MouseEvent): void {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      const li = button?.closest<HTMLLIElement>('[data-line]');
      const id = li?.dataset.line;
      if (!button || !li || !id || button.getAttribute('aria-disabled') === 'true') return;
      const current = $cart.get().find((line) => line.listingId === id)?.quantity;
      if (current === undefined) return;

      if (button.hasAttribute('data-decrease')) setQuantity(id, current - 1);
      else if (button.hasAttribute('data-increase')) setQuantity(id, current + 1);
      else if (button.hasAttribute('data-remove')) this.removeLine(li, id);
    }

    // The focus goes to the next line's delete button (or the one before), so a shopper clearing
    // the cart from the keyboard keeps pressing Enter; with nothing left, to "Continue shopping"
    private removeLine(li: HTMLLIElement, id: string): void {
      const neighbour = li.nextElementSibling ?? li.previousElementSibling;
      const next = neighbour instanceof HTMLElement ? neighbour.dataset.line : undefined;
      removeFromCart(new Set([id]));
      // The cart's subscriber has drawn the new list by now: set() calls it straight away
      const target = next
        ? this.list.querySelector<HTMLElement>(`[data-line="${CSS.escape(next)}"] [data-remove]`)
        : this.querySelector<HTMLElement>('[data-continue]');
      target?.focus();
    }

    // 'change' fires on Enter and when the box loses the focus, not on every key: typing "12"
    // never sets the line to 1 on the way
    private onQuantityTyped(event: Event): void {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const id = input.closest<HTMLElement>('[data-line]')?.dataset.line;
      if (!id) return;
      const typed = parseQuantity(input.value);
      if (typed !== undefined) setQuantity(id, typed);
      // A typed 0 became 1 and 500 became 99; letters put the old number back
      const kept = $cart.get().find((line) => line.listingId === id)?.quantity;
      if (kept !== undefined) input.value = this.number.format(kept);
    }
  }

  customElements.define('cart-drawer', CartDrawer);
</script>
```

- **One listener for the whole list**, not one per button: lines come and go, and the listener stays.
- **The current number comes from the cart, not from the box**, so "one more" after a typed number counts from what
  the cart really holds.
- **Delete moves the focus** to the next line's delete button, or the one before, or "Continue shopping" when the cart
  is empty. A keyboard user can clear the cart by pressing Enter again and again. This works because the store calls
  its subscribers at once inside `set()`: when `removeFromCart` returns, the list is already redrawn.
- **`CSS.escape`** on the id inside the selector: an id with a quote or a bracket would break the selector otherwise.
- **The box listens to `change`, not `input`.** `change` fires on Enter and when the box loses the focus. With `input`,
  typing "12" would first set the line to 1 and ask for a price. After the change, the box shows the cart's number:
  0 became 1, 500 became 99, letters put the old number back.

### `src/components/CartButton.astro`

```diff
@@ -9,7 +9,7 @@ import type { ShopLocale } from '../lib/locale';
 // browser, so the server draws an empty cart and the script below fills it in. A script, not a
 // React island: an island would ship React and the app's translations (about 150 KB gz) for one
 // number. The words it needs are worked out here and handed over in data attributes.
-// Step 26b makes the button open the cart drawer.
+// Step 26b: data-open-cart opens the cart drawer (CartDrawer.astro listens for it).
 interface Props {
   locale: ShopLocale;
 }
@@ -28,6 +28,8 @@ const { t } = locale;
 >
   <button
     type="button"
+    data-open-cart
+    aria-haspopup="dialog"
     aria-label={t('shop.header.cartEmpty')}
     class="relative grid size-10 place-items-center rounded-xl bg-card text-brand transition-colors duration-150 md:size-[42px] md:border md:border-on-brand-line md:bg-transparent md:text-white md:hover:bg-white/10"
   >
```

`data-open-cart` is all the button needs; the drawer listens for it. `aria-haspopup="dialog"` tells a screen reader
that the button opens a dialog, before it is pressed.

### `src/layouts/ShopLayout.astro`

```diff
@@ -3,6 +3,7 @@ import '../styles/shop.css';
 
 import type { PublicShop } from '@omnivo/contracts';
 
+import CartDrawer from '../components/CartDrawer.astro';
 import Footer from '../components/Footer.astro';
 import Header from '../components/Header.astro';
 import type { ShopLocale } from '../lib/locale';
@@ -45,6 +46,9 @@ const theme = `--brand: ${shop.theme.brand}; --accent: ${shop.theme.accent}`;
       </main>
       <Footer shop={shop} locale={locale} />
     </div>
+    {/* Step 26b: one drawer for the whole page, outside the layout's box: as a modal dialog it is
+        drawn above everything anyway, and the header's cart button opens it */}
+    <CartDrawer locale={locale} />
 
     <script>
       import { addToCart } from '../lib/cart';
```

One drawer per page, after the page's box. Where it sits in the HTML does not matter for how it looks: an open modal
dialog is drawn in the browser's top layer, above everything.

### `src/styles/shop.css`

```diff
@@ -162,6 +224,14 @@
     text-wrap: balance;
   }
 
+  /* Step 26b: the page behind the open cart drawer does not scroll; a modal <dialog> blocks clicks
+     on it, not the scroll wheel. The gutter keeps the page from shifting sideways when a classic
+     scrollbar (Windows) goes away */
+  html:has(dialog[data-cart-drawer][open]) {
+    overflow: hidden;
+    scrollbar-gutter: stable;
+  }
+
   /* Every clickable thing shows the hand (CLAUDE.md → Interaction) */
   button:not(:disabled),
   [role='button']:not([aria-disabled='true']),
```

A modal dialog stops clicks on the page behind it, not the scroll wheel or a finger on a phone. `:has()` stops the
page from scrolling while the drawer is open, with no script. `scrollbar-gutter: stable` keeps the space of a classic
scrollbar (Windows), so the page does not jump sideways when the scrollbar goes away.

### `src/boundaries.spec.ts`

```diff
@@ -12,12 +12,18 @@ const files = import.meta.glob<string>(['./**/*.{ts,astro}', '!./**/*.spec.ts'],
 // The module names in `import x from '...'`, `import '...'` and `export ... from '...'`
 const IMPORT = /^\s*(?:import|export)\s(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;
 
-function importsOf(source: string): string[] {
-  return [...source.matchAll(IMPORT)].flatMap((match) =>
+function importsOf(source: string, pattern = IMPORT): string[] {
+  return [...source.matchAll(pattern)].flatMap((match) =>
     match[1] === undefined ? [] : [match[1]],
   );
 }
 
+// Step 26b: the imports that stay in the built JavaScript. `import type { X } from '...'` is
+// removed by the compiler; `import { type X } from '...'` is not (an empty import still runs the
+// module), so it counts
+const VALUE_IMPORT = /^\s*import\s(?!type\s)(?:[^'"]*\sfrom\s)?['"]([^'"]+)['"]/gm;
+const SCRIPT = /<script>([\s\S]*?)<\/script>/g;
+
 describe('shop imports', () => {
   it('reads the source files', () => {
     // A broken glob would find nothing and pass every rule below
```

`importsOf` gets the pattern as a parameter, and `VALUE_IMPORT` is the import pattern without `import type`. Note what
it still counts: `import { type X } from '…'` is a value import, because the compiler keeps an empty import, and the
module still runs. The new test, at the end of the `describe` block:

```ts
  it('keeps Zod, React and the translations out of the browser scripts', () => {
    // Step 26b: what runs in the shopper's browser is every <script> in a component and the lib
    // files those scripts import. The contracts bring Zod (25 KB gz), and '@omnivo/i18n' starts
    // i18next with its English words (about 150 KB gz); '@omnivo/i18n/format' is the small part
    // that formats numbers. Their types are free: `import type` leaves nothing behind
    const scripts = Object.entries(files)
      .filter(([path]) => path.endsWith('.astro'))
      .flatMap(([path, source]) =>
        [...source.matchAll(SCRIPT)].map((match) => ({ path, source: match[1] ?? '' })),
      );
    // '../lib/cart' in a component is ./lib/cart.ts here; then the lib files that one imports
    // ('./money'). One level is all the shop has
    const libs = new Set(
      scripts
        .flatMap(({ source }) => importsOf(source, VALUE_IMPORT))
        .flatMap((name) => /\/lib\/([\w-]+)$/.exec(name)?.[1] ?? [])
        .map((name) => `./lib/${name}.ts`),
    );
    for (const lib of [...libs]) {
      for (const name of importsOf(files[lib] ?? '', VALUE_IMPORT)) {
        const sibling = /^\.\/([\w-]+)$/.exec(name)?.[1];
        if (sibling) libs.add(`./lib/${sibling}.ts`);
      }
    }
    // A broken pattern would find nothing to check; cart, quote and money at least
    expect(libs.size).toBeGreaterThanOrEqual(3);

    const heavy = /^(zod|react|react-dom|@omnivo\/contracts|@omnivo\/i18n)$/;
    const offenders = [
      ...scripts,
      ...[...libs].map((path) => ({ path, source: files[path] ?? '' })),
    ]
      .filter(({ source }) => importsOf(source, VALUE_IMPORT).some((name) => heavy.test(name)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
```

- **What runs in the browser** is every `<script>` in a component and the `lib/` files they import, plus the `lib/`
  files those import (`cart.ts`, `money.ts`, `quote.ts`). One level is enough for the shop today; a deeper chain would
  need a loop.
- **The frontmatter is not checked.** It runs on the server, where the contracts and i18next are fine.
- **`libs.size >= 3`**: a broken pattern would find nothing and pass.
- Tried on purpose: `money.ts` importing `formatMoney` from `@omnivo/i18n` instead of `@omnivo/i18n/format` fails this
  test with `['./lib/money.ts']`.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop test
pnpm --filter @omnivo/shop build
PORT=4399 pnpm --filter @omnivo/shop start
```

i18n is built first: the shop reads `@omnivo/i18n/format` from `dist/`. Then open `http://localhost:4399/`:

- The cart button with an empty cart opens "Your cart is empty". No request goes to `/api/cart/quote` (the browser's
  Network tab). Escape closes it, and the focus is back on the cart button.
- Add two Sprites and one Domex, then open the cart: two lines, ৳100 and ৳98, subtotal ৳198. One request.
- Click "one more" on the Sprite three times quickly: the box says 5 at once, the amounts are grey for a moment, then
  ৳250 and ৳348. One request for the three clicks, and the focus is still on the button.
- Type `500` in the box and press Enter: it says 99. Type `abc` and Tab: 99 again.
- Press "one less" on Domex: at 1 the button dims, and the focus stays on it.
- Delete every line with the keyboard: the focus moves from delete button to delete button, then to "Continue
  shopping", which closes the drawer.
- In the browser's console, add a listing the shop does not have, then reload and open the cart:

  ```js
  localStorage.setItem('omnivo.shop.cart', '[{"listingId":"lst-gone","quantity":1},{"listingId":"lst-dano-daily-pushti-milk-1kg","quantity":1}]')
  ```

  The milk line says "Out of stock: not in the subtotal", Checkout is grey, and `lst-gone` is gone from the stored
  cart.
- Stop the server and press "one more": "The prices did not load…" with "Try again". Start it again and press "Try
  again": the lines come back.
- At 390px wide the drawer covers the whole screen and nothing scrolls sideways.

## 26b.6 — Doc updates

After you implement this (ask me and I can do these). Only `CLAUDE.md` changes: the system design already says the
shop is drawn on the server (§2, "Astro SSR"), and the build plan's step 26 is ticked only when step 26's API is done.

**CLAUDE.md** — in "Storefront design system":

1. In "What still applies from the rest of this file", after "money as decimal strings", add: "formatted in browser
   scripts with `@omnivo/i18n/format` (the package's main entry starts i18next with every word, so a browser script
   never imports it)".
2. In "Storefront color tokens", change three "Use" cells (decision 16):
   - `card`: "Product cards, inputs, footer, gallery card and thumbnails, the cart drawer"
   - `card-glass`: "Product info card, description card and checkout card (on `canvas`)"
   - `canvas`: "Page background, section header background, description sections (with `cream`), checkout line image
     box, promo box"
3. In **Product page, top**, replace "four 119×92 thumbnails, 16px apart, `card`, radius 8; the selected one has a 1px
   `brand` border" with "four 119×92 thumbnails, 16px apart, radius 16, with a 2px `card` border that turns `brand` on
   the one shown"; replace "(`accent`, `ShoppingBag01`, 8px gap; buys now and opens checkout)" with "(`accent`,
   `ShoppingBag01`, 8px gap; puts the product in the cart once, never a second time, and opens checkout)"; replace "a
   24px `Call02` icon" with "a 24px `price` `Call02` icon"; and replace the last sentence with "Below `lg` the two
   cards stack, the gallery stays at most 524px wide and centered, and the buttons share the width."
4. Replace **Product page, description** with:

   > - **Product page, description:** a `card-glass` card (radius 16, 8px padding) with the tab bar (`cream`, radius
   >   8, 8px padding) holding one 160×48 "Overview" label in the tab's look (`brand` fill, `accent` 16px/600, radius 4).
   >   It is a label, not a `tablist`: Reviews is removed (there are no reviews in the data model), and a list of one
   >   tab would tell a screen reader there is a choice. Then the description sections 8px apart, each radius 8,
   >   padding 36px (20px on phones), alternating `canvas` and `cream` starting with `canvas`: heading `sf-subtitle`
   >   (30px line-height) `brand`, 24px down the text 14px/24px `body`, lists with discs (numbers for an `<ol>`)
   >   indented 21px, label words at 600. The sections come from the listing's `description_html`, styled by one prose
   >   class (`shop-prose`), never per-section markup. No description: no card.

5. Replace **Cart drawer** (under "Storefront screens not in Figma") with:

   > - **Cart drawer:** opens from the cart button, from the right, 420px wide (full width on phones), `card`, with
   >   `overlay` behind it and no blur. A native `<dialog>` (`showModal()`), so the focus stays inside, Escape and a
   >   click on the backdrop close it, and the focus goes back to the cart button. It does not slide in. The header:
   >   "Your Cart" `sf-title` `brand` and a close icon button, a 1px `rule` line under it. The lines are the checkout's
   >   at drawer size, 1px `rule` lines between them: the image box 96×80 (`canvas`, radius 8), 16px gap, the name
   >   16px/600 `brand` (two lines, then an ellipsis) with the line total 16px/600 `price` to its right, the pack size
   >   (`sf-meta` `muted`), then the checkout's stepper and delete button (same sizes and gaps). An out-of-stock line
   >   says "Out of stock: not in the subtotal" in `promo` with `Alert02` and keeps only its delete button. Padding
   >   24px (20px on phones). At the bottom, above a 1px `rule` line: "Subtotal" and the amount (`sf-subtitle`
   >   `price`), and "Checkout" (full width, 52px, `accent`, radius 4, 16px/600 `brand`; greyed and not a link when
   >   every line is out of stock). The prices come from the server's quote, asked each time the drawer opens and 250ms
   >   after the last change; until the answer, the amounts are `muted`. A quantity changes at once. A failed quote
   >   shows no prices: a `promo-soft` tile, "The prices did not load…" and "Try again" (`cream`). Empty: the empty
   >   state (`ShoppingCart01`, "Continue shopping" closes the drawer).

---

## 26b.7 — Run it and check it

```bash
pnpm install
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build   # the shop reads their dist/
pnpm --filter @omnivo/shop typecheck      # astro check: 0 errors, 0 warnings, 0 hints
pnpm --filter @omnivo/shop test           # 41 tests: cart (15), mock (6), boundaries (5), countdown (5), the mock quote (4), the route (4), lib/quote (2)
pnpm --filter @omnivo/shop dev            # http://localhost:4321
```

`dev` is still the way to work on the shop. To run it the way it will run on a server:

```bash
pnpm --filter @omnivo/shop build
pnpm --filter @omnivo/shop start          # node dist/server/entry.mjs, http://localhost:4321
```

Then, for the whole repo (the step changed two shared packages):

```bash
pnpm dedupe --check
pnpm typecheck
pnpm lint
pnpm format
pnpm test                 # 995: contracts 423 + app 210 + api 156 + sync 118 + shop 41 + ui 22 + i18n 17 + auth 8
pnpm boundaries
pnpm build
pnpm test:bundle-size     # the ERP app's first load 232.1 KB gz (budget 235): the new shop words are in en.ts
pnpm test:openapi         # up to date: the storefront schemas are not in the ERP's API
```

### What you should see

At 1440px wide, `/p/himalaya-purifying-neem-face-wash-150ml` next to Figma's `product_details`:

- [ ] The gallery card at 80,108 (524×440): the red "৳70 OFF" ribbon at its top left, "Most Picked" at its top right,
      the tube in the middle. The four thumbnails 16px under it (119×92), the first with a teal border.
- [ ] The info card beside it (740 wide): the coral clock and "01 : 12 : 10 : 32" counting down, the name in two lines,
      the "150ml" chip, ৳229 in crimson with ৳299 struck out after it, "Per Piece", the lime "Place Order" and the cream
      "Add to cart", "Available in stock", "SKU: MD2346", a rule, and "Hotline: +880 1786 120356".
- [ ] The Overview card at y 728: the teal "Overview" label, then seven sections alternating grey and cream; "How to
      Use" is a numbered list.
- [ ] "Related Products" at y 2304 with its arrows, five cards, Load More, then the footer.
- [ ] Click the second thumbnail: the tilted tube fills the gallery and the border moves to it.
- [ ] "Add to cart": the header's count says 1. "Place Order": the count stays 1, and the browser opens `/checkout`
      (a 404 until 26c).
- [ ] The cart button: the drawer from the right, the face wash at ৳229, "Subtotal ৳229". "One more" three times
      quickly: the box says 4 at once, the amounts grey for a moment, then ৳916. Escape closes it.

At 900px: the two cards stack, the gallery is 524px wide and centered, and the two buttons share the width. At 393px:
the same, at the phone's width, and the drawer covers the screen. Nothing scrolls sideways at any width.

`/p/zero-cal-stevia-30-sachets` is a plain page (one photo, no countdown, no SKU, no Overview), and `/p/nope` is
Astro's 404 page with the status 404. With `language: 'bn'` in `src/data/mock/shop.ts`, the page, the countdown's
sentence and the drawer's amounts (`৳২২৯`) are Bangla.

### Known differences from Figma

- **The last two thumbnails** are other photos of the tube, not repeats of the first two (see "The pictures from
  Figma").
- **The stock and SKU icons are stroke, not solid.** Figma uses solid icons there; `CLAUDE.md` allows only Stroke
  Rounded.
- **No Reviews tab**, and "Overview" is a label (decision 19).
- **Text sits a fraction of a pixel off**, from Geist in place of Roboto: the sections add up to 1px by "Related
  Products".
- **"Account" in the header** in place of a name, as in 26a.
- **The pages below 1440px** follow the storefront rules, not a Figma frame: Figma has no phone or tablet frame for
  this page (decision 20).
- **The cart drawer** is not in Figma at all; it follows `CLAUDE.md` and decision 26.

## What comes next

- **26c — checkout:** `/checkout` (Figma `checkout_process`, 37:3765) with the shop's first React island (the form,
  with `@nanostores/react` and `react-hook-form` + Zod), delivery zones and the coupon in the quote, the phone code
  (`/checkout/verify`) for Cash on Delivery, the "Order Confirmed" dialog (`confirmation_status`, 41:4066, with
  `shapes/order-confirmed.svg` from this step), and order details `/order/<no>`. The order goes to a new API route over
  the mock, like the quote. Mobile Banking goes straight to "Order Confirmed" in the mock.
- **26d — the rest:** the category and search pages with the chip menus, filters, sort and Load More's "Loading"
  state; tracking; the text pages; the empty states (and the "page not found" page); the first Playwright tests.
- **Step 26's real place in the plan:** the `storefront` module in the API, `/public/v1`, the tenant from the `Host`
  header (one `ShopSource` that calls the API in place of the mock), and the description cleaner (decision 15).
