# Step 26e: Storefront, part 5 — tracking, the text pages, page not found and the first Playwright tests

> The implementation guide for "Phase 10 → Step 26", the fifth part, of [build-plan.bn.md](build-plan.bn.md). Step 26
> has five parts:
>
> - **26a (done):** `apps/shop`, the tokens, the data contract, the mock, the header, the footer and the home page.
> - **26b (done):** server mode, the product page `/p/<slug>` and the cart drawer.
> - **26c (done):** the checkout, the phone code, the "Order Confirmed" dialog and the order page.
> - **26d (done):** the category and search pages, the filters, Load More and the category drawer.
> - **26e (this guide):** tracking (a link `/t/<token>` and the `/track` form), the footer's text pages
>   `/pages/<slug>`, "page not found", and the shop's first Playwright tests.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `a55ddfc`, "doc created for
> nirvor shop") and checked on 2026-11-15: `pnpm dedupe --check`, `pnpm build`, `pnpm lint`, `pnpm format`,
> `pnpm typecheck`, `pnpm test` (1,221, of them 200 in `apps/shop`, 490 in `packages/contracts` and 210 in
> `apps/app`), `pnpm boundaries`, `pnpm test:bundle-size` (the ERP app's first load 231.8 KB gz, budget 235),
> `pnpm test:openapi`, and the shop's new Playwright tests (40 at two widths: 38 passed, 2 skipped on purpose), all
> clean. The changed `infra/staging/Caddyfile` passed `caddy validate` in the image staging runs (Caddy 2.10.2).
>
> **Not run:** `test:integration`, `test:tenant-leak` and the ERP app's e2e suites. This step changes no code in
> `apps/api`, and in `apps/app` only three error words in `en.ts` and `bn.ts`, which the type check, the unit tests
> and the build cover. CI's only change for the app is the `--filter=@omnivo/app` on its e2e step (decision 31),
> checked with a turbo dry run.
>
> Also checked by hand, in Chromium against the built server, at 1440 and 390px:
>
> - **The tracking link** for each of the three demo orders, a cut link and a changed one: the views, the parcels
>   and events newest first, statuses 200 and 404, the three headers of decision 24 on every answer.
> - **The `/track` form:** a match in place with the address still `/track`, Bangla digits and "w000123" in the
>   boxes, the focus on the first box to fix and on the refusal, and `429 Too Many Requests` after ten misses.
> - **The four text pages, and "page not found"** for `/nope`, `/p/nope`, `/c/nope`, `/pages/nope` and
>   `/order/W-999999`, each with status 404.
> - **In Bangla** (`language: 'bn'` in the mock), the same pages.
> - **Nothing scrolls sideways** at either width, and no console errors except the browser's own line for each 404.
> - **Broken on purpose** while the parts were written, each caught by a test, the type check or a hand check. Each
>   part's "Check this part" lists them, and 26e.6 one more.

## Goal

🚚 **A buyer can see where the order is, and every footer link opens a page.** After 26d the header's Account
button, the footer's four links and every unknown address led to Astro's plain 404. After this step:

- **`/t/<token>`** is the tracking link the shop sends the buyer: the order's timeline, then each parcel and the
  courier's events, newest first. It names no person, because a link gets forwarded.
- **`/track`** finds the same view with the mobile number and the order number, for a buyer who lost the SMS. It
  works with no script, keeps the phone out of the address, and stops a guesser after 10 misses in 15 minutes.
- **`/pages/privacy`, `terms`, `about` and `contact`** show the tenant's text in the checkout card.
- **"Page not found"** has the full layout and the storefront's empty state, with status 404.
- **The shop has its first Playwright tests** (40, at 1440px and 390px), with their own step in CI. They found one
  26c bug, which is fixed here: text typed into the checkout before its script ran was wiped.

## The whole picture

```
packages/contracts   storefront.ts: shopOrderNoSchema ("w000123" → W-000123), shopTrackRequestSchema,
                     SHOP_TRACK_TRIES (10) / SHOP_TRACK_WINDOW_MINUTES (15), shopTrackingTokenSchema (22 base64url),
                     SHOP_SHIPMENT_STATUSES (10), shopShipmentSchema, shopTrackingSchema (no name, phone or address),
                     SHOP_TEXT_PAGES, shopTextPageSchema          errors.ts: shop_order_no_format, shop_track_*
packages/i18n        shop.track, shop.pages, shop.notFound (shop/en.ts, bn.ts); the 3 error words (en.ts, bn.ts)
      │
      ▼
apps/shop/src/data   source.tracking(token) · source.track({phone, orderNo}) → ShopTracking | null
                     source.textPage(slug) → ShopTextPage | null · source.testTracking (the mock's demo line)
                     mock: 3 demo orders with fixed links (demo-orders.ts), the four pages (pages.ts)
      │
      ▼
src/server           rate-limit.ts: misses per address (IPv6: its /64)      track.ts: answerTrackForm()
src/lib              tracking-view.ts: parcels and events newest first      text-page.ts: dayInShop()
      │
      ├────────────────────────────┬─────────────────────────────┬────────────────────────────┐
      ▼                            ▼                             ▼                            ▼
/t/<token>                   /track (GET, POST)            /pages/<slug>               404.astro
  shape → source → view        form → limit → parse →        four slugs, else 404        every address with
  no-store, noindex,           lookup → view in place,       title = the footer word     no page, and every
  no-referrer; else 404        or the refusal (429)          shop-prose                  rewrite to /404
      └──── PageCard + TrackingView (OrderTimeline, parcels) ─┘

apps/shop/e2e        Playwright on the built server (127.0.0.1:4331), Chromium 1440×900 and Pixel 7 (390px)
.github/workflows    "E2E (storefront on its built server)"; the ERP app's step now names @omnivo/app
infra/staging        Caddy writes X-Forwarded-For for the shop, and astro.config.ts trusts it

Sunday 15 Nov 2026, the buyer of W-000123 in Sylhet gets an SMS with a link:
  /t/C2etI9zQb8E5ZugpwzVWyA ─► "On the way"; the Steadfast parcel SFR2611120042, newest first: "Could not deliver:
                              they will try again" with the courier's note "Customer not reachable";
                              "Keep ৳578 ready in cash for the rider." They call the shop back.
  Their brother deletes the SMS by mistake: /track, 01786120356 and "w000123" ─► the same view, in place.
```

## Not in this step, on purpose

- **No SMS is sent.** Step 27 stores the token's hash when an order is placed and sends the link. The mock has no SMS,
  so it shows its three demo links on `/track` (decision 18).
- **No real courier.** Step 28 adds the Steadfast key in the ERP's admin, the consignments, the courier's webhook and
  polling, and `shipment_events`. Here the parcels and their events are mock data in the contract's shape.
- **No customer sign-in.** The Account button still opens `/track` (decision 4).
- **No closed shop.** The shop is always open (decision 7). A workspace suspended for billing is a question for the
  billing steps.
- **No contact form.** The contact page is text only (decision 5).
- **No screenshot diffs.** The tests check what a shopper sees and does; the look is checked against Figma by eye
  (decision 8).
- **No change to 26c's checkout, verify and order pages** beyond the one `inert` line (decisions 26 and 34). Their own
  copy of the card stays.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront.ts`, `storefront.spec.ts` | The order number, the track request and its limit, the token, shipments, the tracking view, the text page |
| `packages/contracts/src/errors.ts` | `shop_order_no_format`, `shop_track_not_found`, `shop_track_too_many` |
| `packages/i18n/src/locales/shop/en.ts`, `bn.ts` | `shop.track`, `shop.pages`, `shop.notFound` |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The three error words |
| `apps/shop/src/data/types.ts` | `tracking`, `track`, `textPage` and `testTracking` on the source |
| `apps/shop/src/data/mock/orders.ts`, `mock-source.ts` | Parcels on an order, the demo orders, the lookups by link and by number |
| `apps/shop/src/server/problem.ts` | `fieldErrorsOf()` split out of `invalidInput()` |
| `apps/shop/src/lib/order-timeline.ts`, `components/OrderTimeline.astro` | `TIMELINE_DOT` moves into the lib, for the parcels too |
| `apps/shop/src/components/EmptyState.astro`, `Footer.astro` | Comments only |
| `apps/shop/src/boundaries.spec.ts` | Only `pages/track.astro` may import `src/server/track` |
| `apps/shop/src/islands/checkout/CheckoutForm.tsx` | The form is `inert` until the island runs (the 26c bug) |
| `apps/shop/astro.config.ts` | `security.allowedDomains: [{}]`: trust the proxy's headers |
| `apps/shop/package.json`, `pnpm-lock.yaml` | `@playwright/test`, `@types/node`; `typecheck` also checks `e2e/`; `test:e2e` |
| `infra/staging/Caddyfile` | `X-Forwarded-For` for the shop |
| `.github/workflows/ci.yml` | The ERP app's e2e step names `@omnivo/app`; the storefront's own e2e step |

New: in `apps/shop/src`: the mock's `demo-orders.ts`, `pages.ts` and `tracking.spec.ts`, `server/rate-limit.ts` and
`track.ts` (with their specs), `lib/tracking-view.ts` and `text-page.ts` (with their specs), the components
`PageCard` and `TrackingView`, and the pages `/t/[token]`, `/track`, `/pages/[slug]` and `404`. In `apps/shop/e2e`:
the config, the helpers and four test files.

## The decisions behind this step

The first nine were agreed before the step started, and 18 while it was written. The rest were made while writing
it; each says why.

1. **Tracking is a link the shop sends to the buyer**, not only a form. A buyer opens `/t/<token>` from the SMS (or
   an email) and sees where the order and the parcel are. The token is 16 random bytes (128 bits, 22 characters in
   base64url), made when the order is placed, and only its hash is stored, like the ERP's share links (step 16).
   26e builds the page, the contract and mock events; step 27 stores the token and sends the SMS.
2. **The page shows the order's timeline, then the courier's events** (the courier, the tracking code, each event's
   time and note). Each courier's statuses are mapped to one small set of our own. **It shows no address and no full
   phone number**, because a link in an SMS gets forwarded.
3. **The `/track` form (phone + order number) stays**, as the way back for someone who lost the SMS. It POSTs to
   itself, so the phone never goes into the address. A match draws the same tracking view in place (one shared
   component). It cannot send the shopper on to `/t/<token>`: only the token's hash is stored, so the link cannot be
   built again. Any mismatch gets the same "not found", and an in-memory limit allows 10 tries per connection in 15
   minutes.
4. **The header's Account button still goes to `/track`.** There is no customer sign-in.
5. **The footer's four pages are `/pages/<slug>`** with fixed slugs (privacy, terms, about, contact). The HTML comes
   from the source and is drawn with 26b's `shop-prose` in the 848px checkout card. Contact is text only, no form.
6. **"Page not found" is `404.astro`**: the full layout (header and footer), the storefront's empty state, status 404.
7. **There is no closed shop.** The shop is always open, so there is no `closed` field, no 503 and no `shop_closed`.
   A workspace suspended for billing is a separate question, for the billing steps.
8. **The first Playwright tests** live in `apps/shop/e2e/` and run against the built server, in Chromium at 1440px
   and 390px, with no screenshot diffs. CI runs them in their own step, `pnpm --filter @omnivo/shop test:e2e`.
9. **Nothing is removed.**
10. **The order number box forgives how it is typed.** Lower case, spaces, Bangla digits, a missing dash
    (`W000123`) and a missing letter (`000123`) all become `W-000123`. The SMS says `W-000123`, and on a phone
    keyboard the dash is the hardest part to type; a shopper who typed the right number must not be told it is wrong.
11. **Ten shipment statuses of our own**, from "booked" to "returned" (26e.1 lists them). Steadfast alone has about
    twelve statuses and Pathao more; the shop needs words for each status it can show, so the courier's adapter maps
    its own statuses to ours (step 28), and the page never sees a courier's word it has no translation for. The
    courier's own note ("Customer not reachable") is shown as it came, because it is often the most useful line.
12. **The tracking view has the item count, the total and the payment method, and nothing that names a person:** no
    name, phone, address or product lines. That is what someone at the door needs ("keep ৳578 ready for the rider"),
    and nothing a forwarded link should give away. A test proves the schema drops a name, a phone and an address.
13. **An order can have more than one parcel** (up to five). When the first courier gives a parcel back and the shop
    books it again with another, the first parcel's events still explain what happened. The system design allows one
    shipment per courier account for the same reason.
14. **The courier's own tracking page is an optional link, https only.** It comes from the courier's answer, not
    from us, and it goes into an `<a href>`, so a `javascript:` link must never reach the page.
15. **A text page's title is the footer's own word**, not a field from the source, so a footer link and the page it
    opens always say the same. A page the tenant has not written is not sent at all (the shop shows "page not
    found"), so a page is never empty. Each page has its "last updated" date, because terms and a privacy policy are
    read with their date.
16. **An unknown or broken tracking link gets its own words** ("This tracking link does not work") and a way to the
    form, still with status 404. A shopper whose SMS app cut the link needs to know what to do, which the general
    "page not found" does not say.
17. **The form's limit is in the contracts** (`SHOP_TRACK_TRIES`, `SHOP_TRACK_WINDOW_MINUTES`), like the phone code's
    numbers. The real public API (step 27) uses the same ones, and the error's words say how long to wait from the
    same number.
18. **The mock shop starts with three demo orders that have fixed tracking links.** The mock sends no SMS, so it has
    no other way to hand anyone a link. A tester (and 26e.4's Playwright tests) gets the numbers, phones and links
    from a line on the `/track` page, the way the verify page shows the test code. Orders placed in the mock get no
    link: they are tracked with the form.
19. **The mock keeps its demo tokens as they are, not hashed.** The real API keeps only a hash (decision 1, step 27),
    because a database is backed up and copied. The mock's tokens are printed on the `/track` page anyway, and its
    memory ends with the process, so a hash there would only add code.
20. **The form counts only misses**, in one 15-minute window per connection that starts at the first miss, and an
    IPv6 connection is its whole `/64` block. A shopper who looks at their own order again and again is never
    stopped, and many phones behind one mobile operator's shared IPv4 address do not use up each other's tries. A
    phone on IPv6 gets a block of addresses that are all the same person, so counting single addresses would let a
    guesser take a new one for every try. Ten misses still say nothing useful to a guesser: they need the order
    number and the phone that placed it.
21. **The shop trusts its proxy's headers** (`security.allowedDomains: [{}]` in `astro.config.ts`), and Caddy writes
    `X-Forwarded-For` itself for the shop, as it does for the API. Without this, every visitor has the proxy's
    address, so one guesser would stop the form for everyone, and an older browser's form POST gets 403 from Astro's
    origin check. Both were seen on a built server before the change (26e.2 says how).
22. **A typo costs no try, and nor does a failure on our side.** The limit is checked before anything else, a box
    typed wrong is answered before the source is asked, and a source that throws answers "try again". Only a real
    lookup that found nothing counts.
23. **A parcel's events are drawn newest first, and so are the parcels.** The shopper's question is "where is it
    now?", and on a phone the answer must be the first line, not the last of a long list. Couriers' own tracking pages
    show their events this way. The order's timeline above it stays oldest first, because it is a road with steps
    still ahead ("Delivered" is grey until it happens), which only reads top to bottom.
24. **The tracking link page sends three headers:** `Cache-Control: no-store`, `X-Robots-Tag: noindex` and
    `Referrer-Policy: no-referrer`. The token is in the address, so no cache may keep the page, a search engine may not
    list a link someone pasted on a public page, and the courier's site must not get the address in a `Referer`
    header. The link to the courier's site also says `rel="noreferrer"`.
25. **The `/track` page needs no script.** It answers its POST in place: the boxes keep what was typed, a box's error
    is under it, and the focus goes to the first box with an error, or to the refusal above the form, with
    `autofocus`. "Too many tries" answers with status 429, so logs and scripts can tell it apart.
26. **This step's three pages share one `PageCard` component** (the checkout card's frame). 26c's checkout, verify and
    order pages keep their own copy of the card, because nothing is removed in this step (decision 9).
27. **A text page's "Last updated" day is the shop's day**, worked out in the shop's time zone, like every other time
    on the shop. A server in UTC would otherwise write a change made at 00:30 in Dhaka as the day before.
28. **Only the `/track` page may import the form's server module**, named in 26c's boundary test page by page. A page
    also has `<script>`s, so "any page may import `src/server`" would be wider than what needs it.
29. **The mock's demo line has its own words** (`mockOrders`, `mockOrder`, `mockLink`), and the unused
    `trackingCode` word is not there: the parcel's line ("Steadfast · SFR2611120042") already names the code.
30. **The shop's first Playwright tests cover 26e, plus one walk through 26b–26d.** 26e's pages are tested in detail
    (the link, the form, its limit, the text pages, "page not found"). The earlier parts get one path each: a product
    into the cart, the drawer, the checkout, the phone code, the dialog and the order page; and the category page,
    Load More, search and the category drawer. The unit tests already check each piece; these check that the pages
    hand over to each other in a real browser. Visual details stay with Figma and the eye (decision 8: no screenshot
    diffs).
31. **The ERP app's e2e step in CI names the app** (`pnpm test:e2e --filter=@omnivo/app`). `pnpm test:e2e` runs every
    package's `test:e2e` through turbo, and the shop has one now, so without the filter CI would run the shop's tests
    twice: once in the app's step and once in its own (decision 8). Locally, `pnpm test:e2e` still runs both.
32. **Each test of the `/track` form is its own visitor.** The form's limit (decision 20) counts misses per address,
    and all tests reach one server. A test sends `X-Forwarded-For` with a random IPv6 `/64`, as Caddy would, so the
    test that uses up ten tries stops no other test, at either width, and not a rerun either.
33. **The tests write the English words out** ("Track Order", "Keep ৳578 ready in cash for the rider."), like the
    ERP app's tests, instead of reading them from `@omnivo/i18n`. A word renamed or lost from `en.ts` then fails a
    test, where a test that read the same key would pass with the wrong words on screen.
34. **The checkout's form is `inert` until its script runs** (the user's choice, 2026-11-15). The first full run found
    a 26c bug: on a slow phone, a name typed into the server's HTML was wiped when react-hook-form took the boxes
    over. `inert` lets no box take the focus, a tap or a key until then. The user chose "disabled until the island
    runs"; `inert` was used rather than a `<fieldset disabled>` because it does the same in one attribute, where the
    fieldset would wrap (and re-indent) the whole 170-line form, and because nothing turns grey for that moment.
35. **The tests run on `127.0.0.1:4331`**, a port of their own, so the shop's `pnpm dev` (4321) and the ERP app's
    tests (4173, 4174) can run at the same time. Locally, Playwright reuses a server already on that port, like the
    app's tests do.

## 26e.1 — `packages/contracts` and `packages/i18n`: tracking and the text pages

This part adds only shapes and words. Nothing draws them yet: 26e.2 gives the mock shop tracking links, courier
events and the four pages, and 26e.3 draws the pages.

### `packages/contracts/src/storefront.ts`

```diff
@@ -563,3 +563,139 @@ export const shopListingPageSchema = pageOf(shopListingSchema).extend({
 export type ShopSort = (typeof SHOP_SORTS)[number];
 export type ShopListingQuery = z.infer<typeof shopListingQuerySchema>;
 export type ShopListingPage = z.infer<typeof shopListingPageSchema>;
+
+// ---------------------------------------------------------------------------------------------
+// Step 26e: tracking an order, and the shop's own text pages.
+
+// An order number as the shopper types it from the SMS. Bangla digits become ASCII ones, spaces go,
+// and the letters are upper-cased, so "w-000123", "W 000123" and "W-০০০১২৩" are one number. A
+// shopper who leaves out the dash ("W000123") or the letter ("000123") gets it added: the SMS says
+// "W-000123", and a phone keyboard makes the dash the hardest part to type. "W-" goes in front of
+// anything; what follows it that is not digits ("W-SO-2026") is then refused by the check. Six to
+// nine digits: the mock counts from W-000001 (26c's decision 3), and a shop with a billion orders
+// is not a worry
+export const shopOrderNoSchema = z
+  .string()
+  .transform((value) => {
+    const plain = asciiDigits(value).replace(/\s/g, '').toUpperCase();
+    return plain.replace(/^(?:W-?)?/, 'W-');
+  })
+  .refine((value) => /^W-\d{6,9}$/.test(value), errorCode('shop_order_no_format'));
+
+// What the /track form sends: the phone the order was placed with and its number. Both must match
+// the same order; any mismatch gets the same "not found" (shop_track_not_found), so the form never
+// says that a number exists with another phone
+export const shopTrackRequestSchema = z.object({
+  phone: shopPhoneSchema,
+  orderNo: shopOrderNoSchema,
+});
+
+// The form's limit: this many tries from one connection in this many minutes. A wrong pair is the
+// only answer a guesser gets, so the limit is what keeps someone from walking the order numbers
+// with a phone they know
+export const SHOP_TRACK_TRIES = 10;
+export const SHOP_TRACK_WINDOW_MINUTES = 15;
+
+// The token in a tracking link (/t/<token>): 16 random bytes in base64url, 22 characters, the same
+// rule as the ERP's share links (document-output.ts). 128 bits cannot be guessed, so the link alone
+// is the key, and the page checks the shape before it asks the source for anything
+export const shopTrackingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
+
+// The couriers the system design's adapters cover (§14.6). Their own names are brand names and the
+// same in every language; the shop still writes them through t() (shop.track.couriers)
+export const SHOP_COURIERS = ['pathao', 'steadfast', 'redx', 'ecourier', 'paperfly'] as const;
+
+// Where a parcel is, in our own words. Each courier has its own statuses (Steadfast's
+// "in_review" and "hold", Pathao's "At the Sorting HUB" and "Assigned for Delivery"); the courier's
+// adapter maps them to this one set (step 28), so the page has words for every one, whichever
+// courier the shop uses:
+// - booked: the shop has handed the parcel's details to the courier, nobody has picked it up yet
+// - picked_up, in_transit (between the courier's hubs), out_for_delivery (a rider has it)
+// - delivered, partly_delivered (the shopper kept some items and sent the rest back)
+// - on_hold: the rider could not deliver it (nobody at home, the phone did not answer) and will try
+//   again; the courier's note says why
+// - returning, returned: the parcel goes back to the shop, and is back
+// - cancelled: the booking was cancelled before the courier picked it up
+export const SHOP_SHIPMENT_STATUSES = [
+  'booked',
+  'picked_up',
+  'in_transit',
+  'out_for_delivery',
+  'delivered',
+  'partly_delivered',
+  'on_hold',
+  'returning',
+  'returned',
+  'cancelled',
+] as const;
+
+// One step the courier reported. `note` is the courier's own words ("Customer not reachable",
+// "Received at Sylhet hub"), shown as they came: they are in the courier's language, not the
+// shop's, and they are often the most useful line on the page. null: the courier sent none
+export const shopShipmentEventSchema = z.object({
+  status: z.enum(SHOP_SHIPMENT_STATUSES),
+  at: z.iso.datetime({ offset: true }),
+  note: z.string().trim().min(1).max(300).nullable(),
+});
+
+// One parcel with a courier. An order has one, or a second one when the first courier gave it back
+// and the shop booked it again with another (the system design allows one per courier account)
+export const shopShipmentSchema = z.object({
+  courier: z.enum(SHOP_COURIERS),
+  // The courier's code for the parcel ("SFR2611150042"), which its own call centre asks for
+  trackingCode: z.string().trim().min(1).max(64),
+  // The courier's own tracking page, when it has one. https only: it goes into an <a href>, and it
+  // comes from the courier's answer, not from us
+  trackingUrl: z
+    .string()
+    .regex(/^https:\/\//)
+    .nullable(),
+  // Oldest first, as they happened, like the order's history. A parcel exists from the moment it
+  // was booked, so there is at least that event; the newest one is where the parcel is now
+  events: z.array(shopShipmentEventSchema).min(1).max(100),
+});
+
+// What a tracking link and the /track form show. Less than the order page on purpose: a link in an
+// SMS gets forwarded (to a family member, to a delivery group), so there is no address, no phone,
+// no name and no line of what was bought. The number, the timeline, how many items, what to pay,
+// and the parcel's way are what the person at the door needs
+export const shopTrackingSchema = z.object({
+  orderNo: z.string().min(1),
+  placedAt: z.iso.datetime({ offset: true }),
+  status: z.enum(SHOP_ORDER_STATUSES),
+  // The same history as the order page, so 26c's timeline draws it
+  history: shopOrderSchema.shape.history,
+  // The pieces, not the lines: two face washes and a tea are 3 items
+  itemCount: z.number().int().min(1),
+  total: shopMoneySchema,
+  // Cash on Delivery: the page says how much cash to keep ready for the rider
+  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
+  // Oldest first. Empty until the shop books the parcel with a courier
+  shipments: z.array(shopShipmentSchema).max(5),
+});
+
+// The footer's four pages, at /pages/<slug>. Fixed slugs: the footer links to exactly these, and
+// each has its title in the shop's words (shop.footer.*), so a link and the page it opens always
+// say the same
+export const SHOP_TEXT_PAGES = ['privacy', 'terms', 'about', 'contact'] as const;
+
+// One text page. The HTML is the description's kind (step 26b): <section>s with an <h2>, then <p>,
+// <ul>, <ol>, <strong> and <a>, cleaned by the ERP when the tenant saves it (step 26's API), drawn
+// as it is with the description's prose style. A page the tenant has not written does not come at
+// all (the source answers null and the shop shows "page not found"), so html is never empty
+export const shopTextPageSchema = z.object({
+  slug: z.enum(SHOP_TEXT_PAGES),
+  html: z.string().min(1),
+  // When the tenant last changed it, for "Last updated 1 Nov 2026" under the title. Terms and a
+  // privacy policy are read with their date. null: the date is not known (an imported page)
+  updatedAt: z.iso.datetime({ offset: true }).nullable(),
+});
+
+export type ShopTrackRequest = z.infer<typeof shopTrackRequestSchema>;
+export type ShopCourier = (typeof SHOP_COURIERS)[number];
+export type ShopShipmentStatus = (typeof SHOP_SHIPMENT_STATUSES)[number];
+export type ShopShipmentEvent = z.infer<typeof shopShipmentEventSchema>;
+export type ShopShipment = z.infer<typeof shopShipmentSchema>;
+export type ShopTracking = z.infer<typeof shopTrackingSchema>;
+export type ShopTextPage = z.infer<typeof shopTextPageSchema>;
+export type ShopTextPageSlug = (typeof SHOP_TEXT_PAGES)[number];
```

A new section at the end of the file, in the order the pages use it.

- **`shopOrderNoSchema`** (decision 10) is a `transform` then a `refine`, like 26c's phone. The transform makes the
  number plain: `asciiDigits` (26c's helper in the same file) turns Bangla digits into ASCII ones, spaces go, and
  `toUpperCase()` makes `w-000123` the same number as `W-000123`. Then `replace(/^(?:W-?)?/, 'W-')` puts `W-` in front
  in place of whatever of `W` and `W-` was there: `W000123`, `W-000123` and `000123` all become `W-000123`. The regex
  can always match (both parts are optional), so it also puts `W-` in front of rubbish, like `SO-2026` →
  `W-SO-2026`; that is fine, because the check after it refuses anything that is not `W-` and six to nine digits. The
  check runs on the plain value, so the error is always `shop_order_no_format`, whatever was typed.
- **`shopTrackRequestSchema`** is the form's two boxes. It reuses `shopPhoneSchema`, so a phone typed as
  `+880 1786-120356` finds the order placed as `01786120356`. Comparing two different spellings of one phone would
  make the form say "not found" to the right person.
- **`SHOP_TRACK_TRIES` and `SHOP_TRACK_WINDOW_MINUTES`** (decision 17). The limit matters because the form's only
  answer to a wrong pair is "not found". Without it, someone who knows a phone number could try every order number
  until one matches.
- **`shopTrackingTokenSchema`** is the token's shape: 22 base64url characters, the same 128 bits as the ERP's share
  links (`SHARE_TOKEN_PATTERN` in `document-output.ts`). It is its own schema, not an import of that pattern: the two
  links may change on their own later, and the storefront section of this file should not depend on the ERP's
  document section. The page checks the shape first, so a broken link (an SMS app that cut it) is answered without
  asking the source.
- **`SHOP_COURIERS`** are the five couriers the system design's adapters cover (§14.6). It is a `const` tuple, so
  `z.enum` and the `ShopCourier` type come from one list. `manual` (the shop's own rider) is not in it: a parcel
  without a courier has no tracking code and no events to show, so it stays out until a step needs it.
- **`SHOP_SHIPMENT_STATUSES`** (decision 11) are our own ten, and the comment above them says what each one means
  for the shopper. Two of them are worth a word. `on_hold` covers every "the rider tried and could not" (nobody at
  home, the phone did not answer, the shopper asked for another day): the shopper's question is the same ("will they
  come again?"), and the courier's note says the reason. `partly_delivered` is its own status, not `delivered`,
  because the shopper kept some items and the rest go back; "Delivered" would hide that.
- **`shopShipmentEventSchema`.** `note` is `trim().min(1)` then `nullable()`: a courier that sends `"  "` as its
  note would otherwise draw an empty line. `max(300)` keeps a courier's long debug text from filling the page.
- **`shopShipmentSchema`.** `events` has `min(1)`: a parcel exists from the moment it is booked, so it always has
  that first event, and "where is it now" is always the last one. The page never has to handle a parcel with no
  status. `trackingUrl` has `regex(/^https:\/\//)` (decision 14), checked by a test with a `javascript:` link.
- **`shopTrackingSchema`** (decision 12) is smaller than 26c's `shopOrderSchema` on purpose; the comment above it says
  why. `history: shopOrderSchema.shape.history` takes the order's history field as it is, so the tracking view and
  the order page can never disagree on its shape, and 26c's `OrderTimeline` draws both. `itemCount` counts pieces,
  not lines, because "3 items" is what the shopper sees at the door. `shipments` is an array (decision 13), empty
  until the shop books a courier.
- **`SHOP_TEXT_PAGES` and `shopTextPageSchema`** (decision 15). The slug is an `enum` of the footer's four, so the
  page can use it as a key into `shop.footer.*` for its title with no "what if it is another one". `html` has
  `min(1)`: a page that is not written is not sent at all, which is one rule instead of two ("no page" and "an empty
  page"). The HTML is the product description's kind (26b), so it is drawn the same way and cleaned the same way.

### `packages/contracts/src/errors.ts`

```diff
@@ -626,6 +626,12 @@ export const ERROR_CODES = [
   'shop_code_too_many',
   'shop_code_resend_wait',
   'shop_code_no_order',
+  // Step 26e: the /track form. An order number in another shape, no order with this number and
+  // phone (one code for both: the form never says which of the two is wrong), and too many tries
+  // from one connection (the problem's params.minutes says how long to wait)
+  'shop_order_no_format',
+  'shop_track_not_found',
+  'shop_track_too_many',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Three new codes, with a comment that says what each one means. `shop_track_not_found` is one code for "no such
number" and "the number exists with another phone": two codes would tell a guesser which half was right.
`shop_track_too_many` carries `params.minutes` in its problem, so the words can say how long to wait.

### `packages/contracts/src/storefront.spec.ts`

```diff
@@ -15,7 +15,12 @@ import {
   shopOrderRequestSchema,
   shopOrderSchema,
   shopPhoneSchema,
+  shopOrderNoSchema,
   shopProductSchema,
+  shopTextPageSchema,
+  shopTrackingSchema,
+  shopTrackingTokenSchema,
+  shopTrackRequestSchema,
   shopVerifyCodeRequestSchema,
 } from './storefront.js';
 
@@ -483,3 +488,146 @@ describe('listing page', () => {
     expect(shopListingPageSchema.safeParse(page).success).toBe(false);
   });
 });
+
+// Step 26e
+describe('order number', () => {
+  it.each([
+    ['W-000123', 'W-000123'],
+    ['w-000123', 'W-000123'],
+    [' W 000123 ', 'W-000123'],
+    ['W000123', 'W-000123'],
+    ['000123', 'W-000123'],
+    ['W-০০০১২৩', 'W-000123'],
+  ])('reads %s as %s', (typed, plain) => {
+    expect(shopOrderNoSchema.parse(typed)).toBe(plain);
+  });
+
+  it.each(['W-123', 'W-0001234567', 'X-000123', 'W--000123', 'SO-2026-27-0001', ''])(
+    'refuses %s',
+    (typed) => {
+      const result = shopOrderNoSchema.safeParse(typed);
+      expect(result.success).toBe(false);
+      expect(result.error?.issues[0]?.message).toBe('shop_order_no_format');
+    },
+  );
+});
+
+describe('track request', () => {
+  it('takes the phone and the number the way a shopper types them', () => {
+    expect(shopTrackRequestSchema.parse({ phone: '+880 1786-120356', orderNo: 'w000123' })).toEqual(
+      { phone: '01786120356', orderNo: 'W-000123' },
+    );
+  });
+
+  it('says which box is wrong', () => {
+    const result = shopTrackRequestSchema.safeParse({ phone: '02-9123456', orderNo: '12' });
+    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
+      ['phone', 'shop_phone_format'],
+      ['orderNo', 'shop_order_no_format'],
+    ]);
+  });
+});
+
+describe('tracking token', () => {
+  it('takes 16 random bytes in base64url', () => {
+    expect(shopTrackingTokenSchema.safeParse('kq3Xb9-T_2mVd8LwZpR4aQ').success).toBe(true);
+  });
+
+  it.each(['kq3Xb9-T_2mVd8LwZpR4a', 'kq3Xb9-T_2mVd8LwZpR4aQx', 'kq3Xb9+T/2mVd8LwZpR4aQ'])(
+    'refuses %s before the source is asked',
+    (token) => {
+      expect(shopTrackingTokenSchema.safeParse(token).success).toBe(false);
+    },
+  );
+});
+
+describe('tracking', () => {
+  // The Sylhet order of 26c, two days later: Steadfast has it, and the rider could not reach her
+  const TRACKING = {
+    orderNo: 'W-000123',
+    placedAt: '2026-11-11T15:20:00+06:00',
+    status: 'shipped',
+    history: [
+      { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
+      { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
+      { status: 'packed', at: '2026-11-12T10:05:00+06:00' },
+      { status: 'shipped', at: '2026-11-12T16:40:00+06:00' },
+    ],
+    itemCount: 3,
+    total: '578.0000',
+    paymentMethod: 'cod',
+    shipments: [
+      {
+        courier: 'steadfast',
+        trackingCode: 'SFR2611120042',
+        trackingUrl: 'https://steadfast.com.bd/t/SFR2611120042',
+        events: [
+          { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
+          { status: 'picked_up', at: '2026-11-12T16:40:00+06:00', note: 'Picked up from the shop' },
+          { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
+        ],
+      },
+    ],
+  };
+
+  it('reads an order on its way with the courier', () => {
+    expect(shopTrackingSchema.parse(TRACKING)).toEqual(TRACKING);
+  });
+
+  it('reads an order the shop has not given to a courier yet', () => {
+    const waiting = { ...TRACKING, status: 'confirmed', history: TRACKING.history.slice(0, 2) };
+    expect(shopTrackingSchema.parse({ ...waiting, shipments: [] }).shipments).toEqual([]);
+  });
+
+  it('never carries the address, the phone or the name', () => {
+    const parsed = shopTrackingSchema.parse({
+      ...TRACKING,
+      name: 'Shamim Ahmed',
+      phone: '01786120356',
+      address: 'House 12, Road 5, Zindabazar, Sylhet',
+    });
+    expect(parsed).not.toHaveProperty('name');
+    expect(parsed).not.toHaveProperty('phone');
+    expect(parsed).not.toHaveProperty('address');
+  });
+
+  it('refuses a courier link that is not https', () => {
+    const [shipment] = TRACKING.shipments;
+    const result = shopTrackingSchema.safeParse({
+      ...TRACKING,
+      shipments: [{ ...shipment, trackingUrl: 'javascript:alert(1)' }],
+    });
+    expect(result.success).toBe(false);
+  });
+
+  it('refuses a parcel with no event and a status the page has no words for', () => {
+    const [shipment] = TRACKING.shipments;
+    for (const events of [[], [{ status: 'in_review', at: TRACKING.placedAt, note: null }]]) {
+      const result = shopTrackingSchema.safeParse({
+        ...TRACKING,
+        shipments: [{ ...shipment, events }],
+      });
+      expect(result.success).toBe(false);
+    }
+  });
+});
+
+describe('text page', () => {
+  it('reads one of the four pages', () => {
+    const page = {
+      slug: 'terms',
+      html: '<section><h2>Delivery</h2><p>Inside Dhaka in 2 days.</p></section>',
+      updatedAt: '2026-11-01T10:00:00+06:00',
+    };
+    expect(shopTextPageSchema.parse(page)).toEqual(page);
+  });
+
+  it('refuses a page the footer has no link to, and an empty one', () => {
+    expect(
+      shopTextPageSchema.safeParse({ slug: 'refunds', html: '<p>x</p>', updatedAt: null }).success,
+    ).toBe(false);
+    expect(shopTextPageSchema.safeParse({ slug: 'about', html: '', updatedAt: null }).success).toBe(
+      false,
+    );
+  });
+});
```

- **The order number tests** are the ways a shopper types the number from the SMS, and the ways it can be wrong: too
  few digits, too many, another letter, two dashes, an ERP sales order number, and nothing at all. Each refusal is
  checked for its code, not only for "it failed", so a test also catches the schema sending a generic `invalid_format`.
- **"says which box is wrong"** checks the path of each issue. The form puts each error under its own box (26e.3),
  which only works when the issue's `path[0]` is the box's name.
- **The token tests** are one character short, one too many, and the `+` and `/` of plain base64 (a link with them
  breaks in an SMS, which is why base64url is used).
- **`TRACKING`** is 26c's order from Sylhet two days later: packed, picked up by Steadfast, and on hold because the
  rider could not reach her. The same fixture comes back in the mock (26e.2), so the page has a real-looking case.
- **"never carries the address, the phone or the name"** guards decision 12. If someone adds the phone to the schema
  "to make the page friendlier", this test fails and points at the reason.
- **"refuses a parcel with no event and a status the page has no words for"** uses `in_review`, a real Steadfast
  status. The adapter must map it (step 28); the schema refuses it, so a courier's own word can never reach the page
  without a translation.

### `packages/i18n/src/locales/shop/en.ts`

```diff
@@ -187,6 +187,65 @@ export const shopEn = {
     // The Delivery Charge row of an order that went out for free
     free: 'Free',
   },
+  // Step 26e: tracking. The /track form, and the view it shares with a tracking link (/t/<token>)
+  track: {
+    title: 'Track Order',
+    pageTitle: 'Track order | {{shop}}',
+    // The browser tab of a tracking link: the number, then the shop
+    linkPageTitle: 'Order {{orderNo}} | {{shop}}',
+    intro: 'Type the mobile number you ordered with and the order number from the SMS.',
+    phone: 'Mobile Number',
+    phonePlaceholder: '01786 120356',
+    orderNo: 'Order Number',
+    orderNoPlaceholder: 'W-000123',
+    submit: 'Track Order',
+    another: 'Track another order',
+    // Only in the mock shop, which sends no SMS: its demo orders, to try the form and the links
+    mockOrders: 'Test shop: no SMS is sent. Try one of these orders.',
+    // "W-000123 with 01786 120356"
+    mockOrder: '{{orderNo}} with {{phone}}',
+    mockLink: 'Tracking link of {{orderNo}}',
+    items_one: '{{count}} item',
+    items_other: '{{count}} items',
+    total: 'Total',
+    // Cash on Delivery, until it is delivered: what to keep ready for the rider
+    payOnDelivery: 'Keep {{amount}} ready in cash for the rider.',
+    paidOnline: 'Paid with Mobile Banking.',
+    parcel: 'Parcel',
+    // "Steadfast · SFR2611120042"
+    courierLine: '{{courier}} · {{code}}',
+    openCourier: 'See it on the {{courier}} site',
+    noParcel:
+      'The shop has not handed the parcel to a courier yet. Its way shows here once it has.',
+    // The second parcel, when the shop booked the order again with another courier
+    earlierParcel: 'Earlier parcel',
+    // A tracking link is a key: anyone who has it sees this page
+    linkPrivate:
+      'Anyone with this link can see this page. It shows no address and no phone number.',
+    linkGoneTitle: 'This tracking link does not work',
+    linkGoneText:
+      'Check that the whole link was copied, or track the order with its number and your phone.',
+    linkGoneAction: 'Track with the number',
+    shipmentStatuses: {
+      booked: 'Booked with the courier',
+      picked_up: 'Picked up',
+      in_transit: 'Moving between hubs',
+      out_for_delivery: 'Out for delivery',
+      delivered: 'Delivered',
+      partly_delivered: 'Partly delivered',
+      on_hold: 'Could not deliver: they will try again',
+      returning: 'Going back to the shop',
+      returned: 'Back at the shop',
+      cancelled: 'Booking cancelled',
+    },
+    couriers: {
+      pathao: 'Pathao',
+      steadfast: 'Steadfast',
+      redx: 'RedX',
+      ecourier: 'eCourier',
+      paperfly: 'Paperfly',
+    },
+  },
   // Step 26d: the category and search pages (/c/<slug>, /search)
   listing: {
     pageTitle: '{{title}} | {{shop}}',
@@ -233,6 +292,18 @@ export const shopEn = {
     // A top category's button that shows or hides the ones under it
     toggle: 'Show the categories in {{category}}',
   },
+  // Step 26e: the footer's text pages (/pages/<slug>). Their titles are the footer's own words
+  pages: {
+    pageTitle: '{{title}} | {{shop}}',
+    updatedOn: 'Last updated {{date}}',
+  },
+  // Step 26e: any address the shop has no page for
+  notFound: {
+    pageTitle: 'Page not found | {{shop}}',
+    title: 'Page not found',
+    text: 'The link may have a typo, or the page has moved. Start again from the home page.',
+    action: 'Go to the home page',
+  },
   footer: {
     pages: 'Shop pages',
     social: '{{shop}} on social media',
```

Three new groups. 26d moved the shop's words into their own file, so these reach only the shop, never the ERP's
first load.

- **`track`** has the form's words, the tracking view's words and the broken link's words (decision 16). They keep the
  storefront's Title Case for the title and the button ("Track Order"), like the rest of the shop.
- **`payOnDelivery`** is the sentence for a Cash on Delivery order that is not delivered yet: "Keep ৳578 ready in cash
  for the rider." It is the question a buyer asks most when a parcel is on its way.
- **`shipmentStatuses`** has one key per status of 26e.1's list. The type check fails if a status is added without its
  words, because the page will call `` t(`shop.track.shipmentStatuses.${status}`) `` with a `ShopShipmentStatus`.
  `in_transit` is "Moving between hubs", not "On the way": `shop.order.statuses.shipped` already says "On the way"
  in the order's timeline above it, and two lines with the same words would read as a mistake.
- **`couriers`** are brand names, the same in every language. They still go through `t()`, because `CLAUDE.md` says
  every string a user can see does, and a Bangla shop may one day want "পাঠাও".
- **`mockOrders`, `mockOrder` and `mockLink`** are the test shop's line on the `/track` page (decision 18): the
  demo orders' numbers and phones, and a link to each one's tracking page. `mockLink` has the order number in it
  ("Tracking link of W-000123"), so the three links do not all have the same name for a screen reader. There is
  no word for "Tracking code" on its own: `courierLine` ("Steadfast · SFR2611120042") already says it (decision
  29).
- **`linkPrivate`** says plainly what a link is: anyone who has it sees the page, and the page has no address and no
  phone. The ERP's public document page has a line like it under its button.
- **`pages`** has the browser tab's title and the "Last updated" line. The page's own title comes from `footer.*`
  (decision 15).
- **`notFound`** is the empty state of `404.astro`. Its text says what to do ("Start again from the home page"), as
  `CLAUDE.md` → Copy asks.

### `packages/i18n/src/locales/shop/bn.ts`

```diff
@@ -162,6 +162,55 @@ export const shopBn: ShopMessages = {
     subtotal: 'সাবটোটাল',
     free: 'ফ্রি',
   },
+  track: {
+    title: 'অর্ডার ট্র্যাক করুন',
+    pageTitle: 'অর্ডার ট্র্যাক করুন | {{shop}}',
+    linkPageTitle: 'অর্ডার {{orderNo}} | {{shop}}',
+    intro: 'যে মোবাইল নম্বর দিয়ে অর্ডার করেছেন সেটা আর SMS-এর অর্ডার নম্বর লিখুন।',
+    phone: 'মোবাইল নম্বর',
+    phonePlaceholder: '01786 120356',
+    orderNo: 'অর্ডার নম্বর',
+    orderNoPlaceholder: 'W-000123',
+    submit: 'ট্র্যাক করুন',
+    another: 'অন্য অর্ডার ট্র্যাক করুন',
+    mockOrders: 'টেস্ট শপ: কোনো SMS যায় না। এই অর্ডারগুলোর একটা দিয়ে দেখুন।',
+    mockOrder: '{{orderNo}}, মোবাইল {{phone}}',
+    mockLink: '{{orderNo}}-এর ট্র্যাকিং লিংক',
+    items_one: '{{count}}টি পণ্য',
+    items_other: '{{count}}টি পণ্য',
+    total: 'মোট',
+    payOnDelivery: 'রাইডারের জন্য {{amount}} নগদ তৈরি রাখুন।',
+    paidOnline: 'মোবাইল ব্যাংকিংয়ে পরিশোধ করা হয়েছে।',
+    parcel: 'পার্সেল',
+    courierLine: '{{courier}} · {{code}}',
+    openCourier: '{{courier}}-এর সাইটে দেখুন',
+    noParcel: 'দোকান এখনো পার্সেলটি কুরিয়ারকে দেয়নি। দেওয়ার পর এর পথ এখানে দেখা যাবে।',
+    earlierParcel: 'আগের পার্সেল',
+    linkPrivate: 'এই লিংক যার কাছে আছে, সে-ই এই পেজ দেখতে পারে। এতে কোনো ঠিকানা বা ফোন নম্বর নেই।',
+    linkGoneTitle: 'এই ট্র্যাকিং লিংকটি কাজ করছে না',
+    linkGoneText:
+      'পুরো লিংকটি কপি হয়েছে কিনা দেখুন, অথবা অর্ডার নম্বর আর আপনার ফোন দিয়ে ট্র্যাক করুন।',
+    linkGoneAction: 'নম্বর দিয়ে ট্র্যাক করুন',
+    shipmentStatuses: {
+      booked: 'কুরিয়ারে বুক হয়েছে',
+      picked_up: 'কুরিয়ার নিয়ে গেছে',
+      in_transit: 'এক হাব থেকে আরেক হাবে যাচ্ছে',
+      out_for_delivery: 'ডেলিভারির জন্য বের হয়েছে',
+      delivered: 'ডেলিভারি হয়েছে',
+      partly_delivered: 'আংশিক ডেলিভারি হয়েছে',
+      on_hold: 'ডেলিভারি হয়নি: আবার চেষ্টা করবে',
+      returning: 'দোকানে ফেরত যাচ্ছে',
+      returned: 'দোকানে ফেরত এসেছে',
+      cancelled: 'বুকিং বাতিল হয়েছে',
+    },
+    couriers: {
+      pathao: 'Pathao',
+      steadfast: 'Steadfast',
+      redx: 'RedX',
+      ecourier: 'eCourier',
+      paperfly: 'Paperfly',
+    },
+  },
   listing: {
     pageTitle: '{{title}} | {{shop}}',
     all: 'সব পণ্য',
@@ -202,6 +251,16 @@ export const shopBn: ShopMessages = {
     all: 'সব পণ্য',
     toggle: '{{category}}-এর ভেতরের ক্যাটাগরি দেখান',
   },
+  pages: {
+    pageTitle: '{{title}} | {{shop}}',
+    updatedOn: 'সর্বশেষ বদলানো হয়েছে {{date}}',
+  },
+  notFound: {
+    pageTitle: 'পেজ পাওয়া যায়নি | {{shop}}',
+    title: 'পেজ পাওয়া যায়নি',
+    text: 'লিংকে হয়তো ভুল আছে, অথবা পেজটি সরানো হয়েছে। হোম পেজ থেকে আবার শুরু করুন।',
+    action: 'হোম পেজে যান',
+  },
   footer: {
     pages: 'দোকানের পেজ',
     social: 'সোশ্যাল মিডিয়ায় {{shop}}',
```

The same keys in Bangla. `shopBn` is typed against `shopEn`, so a missing key fails `tsc`. The example phone number,
the order number and the courier names stay as they are, and SMS stays in English, as everywhere in the Bangla
words.

### `packages/i18n/src/locales/en.ts` and `bn.ts`

```diff
@@ -7179,6 +7179,9 @@ export const en = {
     shop_code_too_many: 'Too many wrong codes. Place the order again to get a new code.',
     shop_code_resend_wait: 'Wait a little, then ask for a new code.',
     shop_code_no_order: 'No order is waiting for a code. Place the order again.',
+    shop_order_no_format: 'Type the order number from the SMS, like W-000123.',
+    shop_track_not_found: 'No order has this number and mobile number. Check both, then try again.',
+    shop_track_too_many: 'Too many tries. Wait {{minutes}} minutes, then try again.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6746,6 +6746,10 @@ export const bn: Messages = {
     shop_code_too_many: 'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড পেতে আবার অর্ডার দিন।',
     shop_code_resend_wait: 'একটু অপেক্ষা করে নতুন কোড চান।',
     shop_code_no_order: 'কোনো অর্ডার কোডের অপেক্ষায় নেই। আবার অর্ডার দিন।',
+    shop_order_no_format: 'SMS-এর অর্ডার নম্বরটি লিখুন, যেমন W-000123।',
+    shop_track_not_found:
+      'এই নম্বর আর মোবাইল নম্বরের কোনো অর্ডার নেই। দুটোই দেখে আবার চেষ্টা করুন।',
+    shop_track_too_many: 'অনেকবার চেষ্টা হয়েছে। {{minutes}} মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
   },
   ui: {
     dataTable: {
```

The error words stay in the main files with every other error code (26d's rule: `errors.shop_*` are checked against
`ERROR_CODES` there). `shop_track_not_found` asks the shopper to check both boxes, because it does not say which one
is wrong. `shop_track_too_many` takes `{{minutes}}` from the problem's params.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/shop typecheck
pnpm exec eslint packages/contracts/src packages/i18n/src/locales
```

The contracts are built first, because `@omnivo/i18n` reads them from `dist/`: without the build, `en.ts` fails on
the three new error words, as in 26c (the old `ErrorCode` in `dist/` does not have them). The contracts have 490 tests after this
part (25 new). The shop still type-checks: nothing in it uses the new shapes yet.

Broken on purpose while this part was written, each caught:

- a status's Bangla word removed from `shop/bn.ts` → `tsc` fails in `@omnivo/i18n`;
- `shop_track_too_many`'s English word removed → `tsc` fails in `en.ts` and in `bn.ts`;
- the transform no longer puts `W-` in front → four order number tests fail;
- `phone` added to `shopTrackingSchema` → "never carries the address, the phone or the name" fails;
- `trackingUrl` without the https check → "refuses a courier link that is not https" fails;
- the events take any status → "refuses a parcel with no event and a status the page has no words for" fails.

## 26e.2 — `apps/shop`: demo orders, tracking, the text pages and the form's server side

This part gives the mock shop something to track and the four pages, and writes the server side of the `/track`
form. Nothing draws it yet: 26e.3 adds the pages. It also changes two files outside `src/`: the Astro config and the
staging Caddyfile, because the form's limit needs the visitor's real address (decision 21).

### `apps/shop/src/data/types.ts`

```diff
@@ -13,6 +13,10 @@ import type {
   ShopOrderPlaced,
   ShopOrderRequest,
   ShopProductPage,
+  ShopTextPage,
+  ShopTextPageSlug,
+  ShopTracking,
+  ShopTrackRequest,
 } from '@omnivo/contracts';
 
 // Step 26c: the reasons a source may refuse an order or a phone code. A closed list, not any
@@ -49,6 +53,16 @@ export interface PlacedOrder {
 // changed in another tab since Confirm Order
 export type ShopCodeWait = Extract<ShopOrderPlaced, { next: 'verify' }> & { listingIds: string[] };
 
+// Step 26e: an order a test shop starts with, and how to track it. The verify page shows a test
+// shop's code (testCode); the /track page shows these, because a test shop sends no SMS with the
+// link. Never filled for a real shop: its numbers, phones and links belong to its buyers
+export interface ShopTestTracking {
+  orderNo: string;
+  phone: string;
+  // The tracking link's token (/t/<token>)
+  token: string;
+}
+
 // What every data source answers. Its own file, so the mock can implement it without importing
 // source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
 export interface ShopSource {
@@ -81,4 +95,17 @@ export interface ShopSource {
   // The code a test shop takes, which the verify page shows because no SMS is sent. null for a real
   // shop: its code goes only to the phone
   readonly testCode: string | null;
+
+  // Step 26e: tracking. Both answer null for "no such order", never an error: a mistyped number and
+  // an old link are normal traffic, like an unknown slug in product().
+  // The order a tracking link names. The page checks the token's shape first
+  // (shopTrackingTokenSchema), so a source never sees a cut or edited link
+  tracking(token: string): Promise<ShopTracking | null>;
+  // The /track form: the order with this number, only when it was placed with this phone. Both come
+  // from shopTrackRequestSchema, so the phone is 01XXXXXXXXX and the number W-000123
+  track(request: ShopTrackRequest): Promise<ShopTracking | null>;
+  // A footer page. null: the shop has not written it, and the page answers 404
+  textPage(slug: ShopTextPageSlug): Promise<ShopTextPage | null>;
+  // A test shop's demo orders (ShopTestTracking); null for a real shop
+  readonly testTracking: readonly ShopTestTracking[] | null;
 }
```

Four new members on `ShopSource`, and the `ShopTestTracking` type.

- **`tracking(token)` and `track(request)`** both answer `ShopTracking | null`. "Not found" is a normal answer, not
  an error, like an unknown slug in `product()`: a buyer who mistypes the number, or opens a link from an old SMS,
  is normal traffic. `throw` stays for a source that is down.
- **Each one says what was checked before it is called.** The page checks the token's shape (26e.1's
  `shopTrackingTokenSchema`), and the form helper parses the boxes with `shopTrackRequestSchema`. So a source never
  sees a cut link or a phone with spaces, and the real source does not repeat those checks.
- **`textPage(slug)`** answers `null` for a page the shop has not written. The slug is `ShopTextPageSlug`, the
  footer's four, so the type says no other page can be asked for.
- **`testTracking`** is to tracking what `testCode` is to the phone code: what a test shop shows because it sends no
  SMS (decision 18). It is `null` for a real shop, so the page draws nothing.

### `apps/shop/src/data/mock/orders.ts`

```diff
@@ -9,6 +9,9 @@ import {
   type ShopOrderConfirmed,
   type ShopOrderLine,
   type ShopOrderRequest,
+  type ShopShipment,
+  type ShopTracking,
+  type ShopTrackRequest,
 } from '@omnivo/contracts';
 
 import type { PlacedOrder, ShopCodeWait, SourceResult } from '../types';
@@ -26,12 +29,41 @@ const WAIT_MS = 60 * 60 * 1000;
 interface MockOrder {
   token: string;
   order: ShopOrder;
+  // Step 26e: the parcels the shop booked for it, oldest first. Nothing in the mock books a
+  // courier, so only the demo orders have any
+  shipments: ShopShipment[];
   // Only while it waits for the code
   wrongCodes: number;
   resendAt: number;
   expiresAt: number;
 }
 
+// Step 26e: an order the mock starts with (demo-orders.ts), so a tracking link and the /track form
+// have something to show right after a restart, when the book is otherwise empty
+export interface MockDemoOrder {
+  order: ShopOrder;
+  shipments: ShopShipment[];
+  // Its tracking link's token. Fixed, so the link the /track page shows works after every restart
+  trackingToken: string;
+}
+
+// Step 26e: what tracking shows of an order. Each field is picked by name, never `...order`: the
+// order has the buyer's name, phone and address, and a tracking link gets forwarded (decision 12).
+// Copies, like find(): the page must not be able to change the book
+function trackingOf({ order, shipments }: MockOrder): ShopTracking {
+  return {
+    orderNo: order.orderNo,
+    placedAt: order.placedAt,
+    status: order.status,
+    history: structuredClone(order.history),
+    // Pieces, not lines: two face washes and a tea are 3 items
+    itemCount: order.lines.reduce((count, line) => count + line.quantity, 0),
+    total: order.total,
+    paymentMethod: order.paymentMethod,
+    shipments: structuredClone(shipments),
+  };
+}
+
 // A token nobody can guess: 32 random bytes as 64 hex digits. Web Crypto, not node:crypto, so it
 // runs wherever the shop's server runs (Node today, a worker runtime maybe later)
 function newToken(): string {
@@ -51,10 +83,35 @@ function orderNumber(sequence: number): string {
 }
 
 // One order book per mock source. `now` is passed in so the tests can move time; the real clock
-// otherwise
-export function createOrderBook(now: () => Date = () => new Date()) {
+// otherwise. Step 26e: `demo` are the orders it starts with; none unless the source passes them
+export function createOrderBook(
+  now: () => Date = () => new Date(),
+  demo: readonly MockDemoOrder[] = [],
+) {
   const byToken = new Map<string, MockOrder>();
-  let sequence = 0;
+  // Step 26e: a tracking link's token → the order's key in byToken. Only the demo orders have one.
+  // The real API makes a token when an order is placed, keeps only its hash, and sends the link by
+  // SMS (step 27). The mock sends no SMS, so a token for its own orders would reach nobody: they
+  // are tracked with the /track form. Nor does it hash: its tokens are printed on the /track page
+  // anyway, and nothing here outlives the process
+  const byTrackingToken = new Map<string, string>();
+  for (const { order, shipments, trackingToken } of demo) {
+    const key = newToken();
+    byToken.set(key, {
+      token: key,
+      // Copies, so a test that changes its fixture cannot change the book
+      order: structuredClone(order),
+      shipments: structuredClone(shipments),
+      // Read only while an order waits for its code, and a demo order never does
+      wrongCodes: 0,
+      resendAt: 0,
+      expiresAt: 0,
+    });
+    byTrackingToken.set(trackingToken, key);
+  }
+  // New orders count on from the last demo order, so the two never share a number. "W-000123" →
+  // 123; 0 with no demo orders, so the first order is still W-000001
+  let sequence = Math.max(0, ...demo.map(({ order }) => Number(order.orderNo.slice(2))));
 
   function secondsUntil(at: number): number {
     return Math.max(0, Math.ceil((at - now().getTime()) / 1000));
@@ -156,6 +213,8 @@ export function createOrderBook(now: () => Date = () => new Date()) {
       const entry: MockOrder = {
         token,
         order,
+        // The shop books a courier later (step 28); until then the order has no parcel
+        shipments: [],
         wrongCodes: 0,
         // The first code was "sent" just now, so a new one waits the same 45 seconds
         resendAt: placedAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000,
@@ -235,6 +294,29 @@ export function createOrderBook(now: () => Date = () => new Date()) {
       // A copy: the page that draws it must not be able to change the book
       return structuredClone(entry.order);
     },
+
+    // Step 26e: what a tracking link shows. null for a token no order has. An order waiting for its
+    // code is not one yet (as in find()); no demo order waits, so this only keeps the rule in one
+    // place for when the real tokens come
+    trackByLink(trackingToken: string): ShopTracking | null {
+      const key = byTrackingToken.get(trackingToken);
+      const entry = key === undefined ? undefined : byToken.get(key);
+      if (!entry || entry.order.status === 'pending') return null;
+      return trackingOf(entry);
+    },
+
+    // Step 26e: the /track form. The number finds the order and the phone must be the one it was
+    // placed with. Both were made plain by shopTrackRequestSchema, as the order's phone was by
+    // shopOrderRequestSchema, so a plain === compares them
+    track({ phone, orderNo }: ShopTrackRequest): ShopTracking | null {
+      for (const entry of byToken.values()) {
+        if (entry.order.orderNo !== orderNo) continue;
+        // One number is one order, so the search ends here, matched or not
+        if (entry.order.phone !== phone || entry.order.status === 'pending') return null;
+        return trackingOf(entry);
+      }
+      return null;
+    },
   };
 }
 
```

- **`shipments` on `MockOrder`.** A placed order starts with `[]`: nothing in the mock books a courier (that is step
  28). Only the demo orders have parcels.
- **`MockDemoOrder`** is an order, its parcels and its link's token. The token is fixed, so the link that the
  `/track` page shows still works after a restart.
- **`trackingOf()` picks every field by name.** `{ ...order, ... }` would be shorter, but it would carry the
  buyer's name, phone and address into the answer, and a tracking link gets forwarded (decision 12). The schema would
  drop them in a parse, but the mock's answer is not parsed, so the rule must hold here. A test fails if the answer
  has the phone, the name or the address in it. `structuredClone` makes copies, like `find()`: the page that draws
  the answer must not be able to change the book.
- **`itemCount` sums the quantities**, not the lines: two face washes and a tea are 3 items, as the buyer counts
  them at the door.
- **The demo orders go into `byToken` under a new key**, like any placed order, so `find()` and `track()` see them
  with no special case. `wrongCodes`, `resendAt` and `expiresAt` are only read while an order waits for its code,
  and a demo order never does, so they are zeros.
- **`byTrackingToken` keeps the token as it is** (decision 19). The comment says why, and that the real API keeps a
  hash.
- **`sequence` starts after the last demo order.** `Number(order.orderNo.slice(2))` turns `W-000123` into 123, so the
  next order is W-000124 and never takes a demo order's number. `Math.max(0, ...[])` is 0, so a book with no demo
  orders still starts at W-000001, and 26c's tests that expect W-000001 do not change.
- **`trackByLink()`** refuses an order that waits for its code, like `find()`. No demo order waits, so it changes
  nothing today; it keeps the rule in one place for when every order has a token (step 27).
- **`track()`** finds the order by its number first, then checks the phone. One number is one order, so the loop
  returns at the first match, matched or not. Both sides are plain already (`shopTrackRequestSchema` and
  `shopOrderRequestSchema` made them `01XXXXXXXXX` and `W-000123`), so `===` is enough. A wrong phone and a number
  that does not exist both give `null`, which the form shows as the same "not found" (26e.1's
  `shop_track_not_found`).

### `apps/shop/src/data/mock/demo-orders.ts`

```ts
import type { ShopOrder, ShopOrderLine, ShopPaymentMethod, ShopShipment } from '@omnivo/contracts';

import { mockCheckoutSettings } from './checkout';
import type { MockDemoOrder } from './orders';
import { mockCatalog } from './products';
import { quoteCart } from './quote';
import { mockShop } from './shop';

// Step 26e: the orders the mock shop starts with. A tracking link needs an order that a courier has
// moved, and nothing in the mock books a courier, so these three are written out: one the shop has
// not handed over yet, one on its way and on hold, and one delivered after a second booking. They
// are the cases the tracking view has words for (shop.track.*), so the page can be seen with each.

interface DemoInput {
  orderNo: string;
  history: ShopOrder['history'];
  name: string;
  phone: string;
  address: string;
  zoneId: (typeof mockCheckoutSettings.zones)[number]['id'];
  paymentMethod: ShopPaymentMethod;
  // [slug, quantity]: the listing as the catalog has it today
  items: readonly (readonly [string, number])[];
  shipments: ShopShipment[];
  trackingToken: string;
}

// The order is priced by quoteCart, the same code that prices a real one, so its subtotal, delivery
// charge and total add up the way the checkout's do, and a price changed in the catalog changes the
// demo order with it
function demoOrder(input: DemoInput): MockDemoOrder {
  const first = input.history[0];
  const last = input.history.at(-1);
  if (!first || !last) throw new Error(`${input.orderNo}: no history`);
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.id === input.zoneId);
  if (!zone) throw new Error(`${input.orderNo}: no zone ${input.zoneId}`);

  const quote = quoteCart(
    {
      lines: input.items.map(([slug, quantity]) => ({ listingId: `lst-${slug}`, quantity })),
      zoneId: input.zoneId,
    },
    {
      catalog: mockCatalog,
      settings: mockCheckoutSettings,
      coupons: [],
      timeZone: mockShop.timeZone,
      now: new Date(first.at),
    },
  );
  // A slug that is not in the catalog, or a listing out of stock, is a mistake in this file: it
  // fails here, when the module loads, and every test fails with it. The fields are the ones
  // orders.ts's place() copies from a quote line
  const lines = quote.lines.map((line): ShopOrderLine => {
    if (line.status !== 'available') throw new Error(`${input.orderNo}: ${line.listingId}`);
    return {
      listingId: line.listingId,
      slug: line.slug,
      name: line.name,
      packSize: line.packSize,
      image: line.image,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    };
  });

  return {
    order: {
      orderNo: input.orderNo,
      placedAt: first.at,
      // Where it is now: the last step of its history
      status: last.status,
      history: input.history,
      name: input.name,
      phone: input.phone,
      address: input.address,
      zoneName: zone.name,
      paymentMethod: input.paymentMethod,
      lines,
      subtotal: quote.subtotal,
      discount: quote.discount,
      couponCode: null,
      // The zone was given, so the quote has its charge; `?? '0'` only satisfies the type
      deliveryCharge: quote.deliveryCharge ?? '0',
      total: quote.total,
    },
    shipments: input.shipments,
    trackingToken: input.trackingToken,
  };
}

export const mockDemoOrders: readonly MockDemoOrder[] = [
  // Delivered in Dhaka, paid with Mobile Banking. The first booking (RedX) was cancelled before its
  // rider came, and the shop booked Pathao instead: the page's "Earlier parcel". Over ৳1,000, so
  // the delivery was free
  demoOrder({
    orderNo: 'W-000121',
    history: [
      { status: 'pending', at: '2026-11-08T11:02:00+06:00' },
      { status: 'confirmed', at: '2026-11-08T11:02:00+06:00' },
      { status: 'packed', at: '2026-11-08T15:30:00+06:00' },
      { status: 'shipped', at: '2026-11-09T10:15:00+06:00' },
      { status: 'delivered', at: '2026-11-09T17:40:00+06:00' },
    ],
    name: 'Nusrat Jahan',
    phone: '01711284519',
    address: 'House 7, Road 3, Block C, Mirpur 10, Dhaka',
    zoneId: 'inside_dhaka',
    paymentMethod: 'online',
    items: [
      ['davidoff-espresso-coffee', 1],
      ['sprite-cold-drink-500ml', 2],
    ],
    shipments: [
      {
        courier: 'redx',
        trackingCode: 'RX2611080317',
        trackingUrl: null,
        events: [
          { status: 'booked', at: '2026-11-08T15:35:00+06:00', note: null },
          { status: 'cancelled', at: '2026-11-08T18:10:00+06:00', note: 'Cancelled by merchant' },
        ],
      },
      {
        courier: 'pathao',
        trackingCode: 'DH0811259QKP7',
        trackingUrl: null,
        events: [
          { status: 'booked', at: '2026-11-08T18:20:00+06:00', note: null },
          {
            status: 'picked_up',
            at: '2026-11-09T10:15:00+06:00',
            note: 'Picked up from merchant',
          },
          { status: 'in_transit', at: '2026-11-09T12:30:00+06:00', note: 'Received at Mirpur hub' },
          { status: 'out_for_delivery', at: '2026-11-09T14:05:00+06:00', note: null },
          { status: 'delivered', at: '2026-11-09T17:40:00+06:00', note: null },
        ],
      },
    ],
    trackingToken: 'MGhXyBcrs_PytWRCRPw-6w',
  }),

  // Confirmed last night in Chattogram, Cash on Delivery, not handed to a courier yet: the page's
  // "The shop has not handed the parcel to a courier yet"
  demoOrder({
    orderNo: 'W-000122',
    history: [
      { status: 'pending', at: '2026-11-14T20:45:00+06:00' },
      { status: 'confirmed', at: '2026-11-14T20:46:10+06:00' },
    ],
    name: 'Tanvir Hasan',
    phone: '01819456723',
    address: 'Flat 4B, Road 2, Nasirabad Housing, Chattogram',
    zoneId: 'outside_dhaka',
    paymentMethod: 'cod',
    items: [
      ['himalaya-anti-hair-fall-shampoo-180ml', 1],
      ['aci-pure-turmeric-200gm', 1],
    ],
    shipments: [],
    trackingToken: '8hFQ10FlQi8U60p2Ct6OEw',
  }),

  // The contracts' fixture (storefront.spec.ts → TRACKING): Sylhet, Cash on Delivery, with
  // Steadfast, and on hold because the rider could not reach the buyer. 3 items, ৳578
  demoOrder({
    orderNo: 'W-000123',
    history: [
      { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
      { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
      { status: 'packed', at: '2026-11-12T10:05:00+06:00' },
      { status: 'shipped', at: '2026-11-12T16:40:00+06:00' },
    ],
    name: 'Shamim Ahmed',
    phone: '01786120356',
    address: 'House 12, Road 5, Zindabazar, Sylhet',
    zoneId: 'outside_dhaka',
    paymentMethod: 'cod',
    items: [
      ['himalaya-purifying-neem-face-wash-150ml', 1],
      ['himalaya-purifying-neem-face-wash-50ml', 1],
      ['aci-pure-turmeric-200gm', 1],
    ],
    shipments: [
      {
        courier: 'steadfast',
        trackingCode: 'SFR2611120042',
        trackingUrl: 'https://steadfast.com.bd/t/SFR2611120042',
        events: [
          { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
          {
            status: 'picked_up',
            at: '2026-11-12T16:40:00+06:00',
            note: 'Picked up from the shop',
          },
          { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
        ],
      },
    ],
    trackingToken: 'C2etI9zQb8E5ZugpwzVWyA',
  }),
];
```

Three orders, one for each case the tracking view has words for: no parcel yet, a parcel on its way (on hold), and
a delivered order with an earlier, cancelled parcel.

- **`demoOrder()` prices the order with `quoteCart()`**, the code that prices a real order, instead of writing the
  amounts by hand. The subtotal, the delivery charge (free over ৳1,000 for W-000121) and the total then add up the
  way the checkout's do, and the amounts have the same form (`'578.0000'`). A price changed in the catalog changes the
  demo order with it.
- **A slug that is not in the catalog throws when the module loads.** That fails every test at once, with the order
  number in the message, instead of leaving a demo order with a missing line.
- **The lines copy the same eight fields as `place()`** in `orders.ts`, not `...line`: a quote line also has its
  `status`, which an order line does not.
- **`status` is the last step of `history`**, so the two can never disagree.
- **W-000123 is the contracts' fixture** (26e.1's `TRACKING`): the same lines make 3 items and ৳578, the same
  Steadfast parcel and events. A test checks the total, so the two cannot drift apart unnoticed.
- **The couriers' notes are in their own words** ("Cancelled by merchant", "Received at Mirpur hub"), because the
  page shows them as they came (26e.1).
- **The tokens are 22 base64url characters**, made once with a random generator and written here. A test checks
  their shape against `shopTrackingTokenSchema`, so the page will not refuse its own demo links.

### `apps/shop/src/data/mock/pages.ts`

```ts
import type { ShopTextPage, ShopTextPageSlug } from '@omnivo/contracts';

import { shopMoney } from '../../lib/money';
import { mockCheckoutSettings } from './checkout';
import { mockShop } from './shop';

// Step 26e: the footer's four pages, as the ERP will send them (shopTextPageSchema): a <section>
// per block, each with an <h2>, like a product description (products.ts), so the description's
// prose style (shop-prose) draws them. The words are a small Dhaka shop's, with the mock's own
// delivery charges and hotline, so the pages agree with the checkout.

// "+880 1786 120356" → "+8801786120356" for a tel: link, which must have no spaces
const hotlineDigits = mockShop.hotline.replace(/\s/g, '');

// "Inside Dhaka: 1 to 2 days, ৳80." from the checkout's own zones, so a charge changed there changes
// the terms too. In English, the mock shop's language (mockShop.language)
function zoneLine(id: string, days: string): string {
  const zone = mockCheckoutSettings.zones.find((candidate) => candidate.id === id);
  if (!zone) throw new Error(`no zone ${id}`);
  return `<li><strong>${zone.name}:</strong> ${days}, ${shopMoney(zone.charge, 'en')}.</li>`;
}
const freeFrom = shopMoney(mockCheckoutSettings.freeDeliveryFrom, 'en');

const PRIVACY = `<section>
<h2>What we keep</h2>
<p>When you order, we keep your name, your mobile number, your delivery address and what you bought. We need them to deliver the order and to call you if the rider cannot find the address.</p>
</section>
<section>
<h2>What we use it for</h2>
<ul>
<li>To deliver your order and to send you SMS about it: the code that confirms it, and the link that tracks it.</li>
<li>To give the courier the name, number and address the parcel needs. The courier gets nothing else.</li>
<li>To answer you when you call the hotline about an order.</li>
</ul>
<p>We do not sell your details, and we do not send you offers by SMS unless you ask for them.</p>
</section>
<section>
<h2>Cookies</h2>
<p>The shop keeps your cart in your browser. Two small cookies remember the order you are confirming and the orders this browser placed, so you can open them again. They hold no name, number or address.</p>
</section>
<section>
<h2>Tracking links</h2>
<p>The link in the SMS shows where your parcel is. Anyone you forward it to can see that page, so it shows no address and no phone number.</p>
</section>`;

const TERMS = `<section>
<h2>Orders</h2>
<p>An order is placed when you confirm it with the code we send to your mobile number, or when you pay with Mobile Banking. Prices are the ones on the checkout page when you confirm.</p>
</section>
<section>
<h2>Delivery</h2>
<ul>
${zoneLine('inside_dhaka', '1 to 2 days')}
${zoneLine('outside_dhaka', '2 to 4 days')}
<li>Delivery is free on orders over ${freeFrom}.</li>
</ul>
<p>With Cash on Delivery, please keep the amount ready for the rider. You may check the parcel before you pay.</p>
</section>
<section>
<h2>Returns</h2>
<p>If an item arrives damaged, expired or is not what you ordered, tell the rider or call us within 3 days. We replace it or give the money back. Opened food and personal care items cannot be returned for any other reason.</p>
</section>
<section>
<h2>Cancelling an order</h2>
<p>Call the hotline before the parcel leaves the shop. Once it is with the courier, you can refuse it at the door instead.</p>
</section>`;

const ABOUT = `<section>
<h2>About ${mockShop.name}</h2>
<p>${mockShop.name} is an online shop in Dhaka for everyday groceries, tea and coffee, personal care and diabetic food. We buy from the brands' own distributors, so every pack is genuine and inside its expiry date.</p>
</section>
<section>
<h2>How we work</h2>
<ul>
<li>Orders placed before 4 pm are packed the same day.</li>
<li>Every parcel goes with a courier that lets you follow it from our shop to your door.</li>
<li>Cash on Delivery everywhere in Bangladesh.</li>
</ul>
</section>`;

const CONTACT = `<section>
<h2>Call or visit us</h2>
<ul>
<li><strong>Hotline:</strong> <a href="tel:${hotlineDigits}">${mockShop.hotline}</a>, Saturday to Thursday, 10 am to 8 pm</li>
<li><strong>Address:</strong> ${mockShop.address}</li>
</ul>
</section>
<section>
<h2>About an order</h2>
<p>Keep the order number from the SMS ready (it starts with W-). To see where a parcel is, open the link in the SMS, or use Track Order with the number and your mobile number.</p>
</section>`;

// Partial: a real shop may not have written every page, and the source answers null for one it has
// not (ShopSource.textPage). The mock has all four, so every footer link opens a page
export const mockTextPages: Partial<Record<ShopTextPageSlug, ShopTextPage>> = {
  privacy: { slug: 'privacy', html: PRIVACY, updatedAt: '2026-11-01T10:00:00+06:00' },
  terms: { slug: 'terms', html: TERMS, updatedAt: '2026-11-01T10:00:00+06:00' },
  // No date: the page shows none (shopTextPageSchema → updatedAt)
  about: { slug: 'about', html: ABOUT, updatedAt: null },
  contact: { slug: 'contact', html: CONTACT, updatedAt: '2026-10-20T12:00:00+06:00' },
};
```

The footer's four pages, as the ERP will send them: a `<section>` per block with an `<h2>`, so 26b's `shop-prose`
style draws them with no new CSS.

- **The words come from the mock's own settings where they can.** `zoneLine()` writes the zones' names and charges
  from `mockCheckoutSettings`, and the free-delivery amount comes from the same place, so the terms page always says
  what the checkout charges. A test checks for ৳80, ৳120 and ৳1,000. `shopMoney(…, 'en')` formats them, because
  the mock shop's language is English.
- **The hotline link drops the spaces** (`tel:+8801786120356`): a `tel:` link with spaces does not work on every
  phone.
- **The privacy page says what the shop keeps and what the cookies hold**, and that a tracking link shows no
  address or phone. The words match what 26c and 26e really do.
- **`Partial<Record<…>>`** says in the type that a page can be missing. The real source answers `null` for a page
  the tenant has not written, and the mock source writes `mockTextPages[slug] ?? null`, which only compiles because
  of the `Partial`.
- **About has `updatedAt: null`**, so 26e.3 has a page without "Last updated" to draw.

### `apps/shop/src/data/mock/mock-source.ts`

```diff
@@ -1,8 +1,10 @@
 import type { ShopSource } from '../types';
 import { listListings, type BrowseContext } from './browse';
 import { mockCheckoutSettings, mockCoupons } from './checkout';
+import { mockDemoOrders } from './demo-orders';
 import { mockHome } from './home';
-import { createOrderBook, MOCK_CODE } from './orders';
+import { createOrderBook, MOCK_CODE, type MockDemoOrder } from './orders';
+import { mockTextPages } from './pages';
 import { mockCatalog, mockProductPage, mockSkus } from './products';
 import { quoteCart, type QuoteContext } from './quote';
 import { mockCategories, mockShop } from './shop';
@@ -27,9 +29,14 @@ export const mockBrowseContext: BrowseContext = {
 };
 
 // Step 26c: a mock source with its own order book and clock. The shop uses one (mockSource below);
-// a test makes its own, so its orders and its time are its own and no test sees another's orders
-export function createMockSource(now: () => Date = () => new Date()): ShopSource {
-  const orders = createOrderBook(now);
+// a test makes its own, so its orders and its time are its own and no test sees another's orders.
+// Step 26e: `demo` are the orders its book starts with. A test passes them only when it tracks
+// orders, so the checkout's tests still get W-000001 for their first order
+export function createMockSource(
+  now: () => Date = () => new Date(),
+  demo: readonly MockDemoOrder[] = [],
+): ShopSource {
+  const orders = createOrderBook(now, demo);
   const context = () => mockQuoteContext(now());
 
   // The mock answers at once. Still a promise, so the pages are written for the real source, which
@@ -52,8 +59,24 @@ export function createMockSource(now: () => Date = () => new Date()): ShopSource
     resendCode: (token) => Promise.resolve(orders.resend(token)),
     order: (orderNo, token) => Promise.resolve(orders.find(orderNo, token)),
     testCode: MOCK_CODE,
+
+    // Step 26e
+    tracking: (token) => Promise.resolve(orders.trackByLink(token)),
+    track: (request) => Promise.resolve(orders.track(request)),
+    textPage: (slug) => Promise.resolve(mockTextPages[slug] ?? null),
+    // What the /track page offers a tester: the demo orders' numbers, phones and links. null
+    // without them, so the page does not offer links that lead nowhere
+    testTracking:
+      demo.length === 0
+        ? null
+        : demo.map(({ order, trackingToken }) => ({
+            orderNo: order.orderNo,
+            phone: order.phone,
+            token: trackingToken,
+          })),
   };
 }
 
-// The one the shop uses (data/source.ts). Its orders live as long as the server process
-export const mockSource: ShopSource = createMockSource();
+// The one the shop uses (data/source.ts). Its orders live as long as the server process; it starts
+// with the demo orders (step 26e), so tracking has something to show after every restart
+export const mockSource: ShopSource = createMockSource(undefined, mockDemoOrders);
```

- **`createMockSource(now, demo)`**: the demo orders are a second parameter that is empty by default. The checkout's
  tests make their own source and still get W-000001 for their first order. Only the shop's own `mockSource` and
  the tracking tests pass `mockDemoOrders`.
- **`testTracking` is `null` with no demo orders**, so a page never offers links that lead to "not found".
- **`mockSource = createMockSource(undefined, mockDemoOrders)`.** `undefined` keeps the default clock (the real
  time).

### `apps/shop/src/data/mock/tracking.spec.ts`

```ts
import {
  compareMoney,
  SHOP_TEXT_PAGES,
  shopOrderSchema,
  shopShipmentSchema,
  shopTextPageSchema,
  shopTrackingSchema,
  shopTrackingTokenSchema,
  shopTrackRequestSchema,
  type ShopOrderRequest,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { mockDemoOrders } from './demo-orders';
import { createMockSource } from './mock-source';

// Step 26e: the demo orders, tracking by link and by the form, and the text pages

const SYLHET_LINK = 'C2etI9zQb8E5ZugpwzVWyA'; // W-000123, on hold with Steadfast

// A source that starts with the demo orders, as the shop's does
function demoSource() {
  return createMockSource(() => new Date('2026-11-15T10:00:00+06:00'), mockDemoOrders);
}

// The form's request after shopTrackRequestSchema, as the route hands it over
const asked = (phone: string, orderNo: string) => shopTrackRequestSchema.parse({ phone, orderNo });

// Two face washes, inside Dhaka: ৳458 + ৳80, over the shop's ৳300 minimum
function order(paymentMethod: ShopOrderRequest['paymentMethod']): ShopOrderRequest {
  return {
    lines: [{ listingId: 'lst-himalaya-purifying-neem-face-wash-150ml', quantity: 2 }],
    zoneId: 'inside_dhaka',
    name: 'Nusrat Jahan',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod,
    termsAccepted: true,
    expectedTotal: '538',
  };
}

describe('the mock’s demo orders', () => {
  it('are orders and parcels the contracts accept', () => {
    for (const { order: demo, shipments } of mockDemoOrders) {
      expect(shopOrderSchema.parse(demo)).toEqual(demo);
      for (const shipment of shipments)
        expect(shopShipmentSchema.parse(shipment)).toEqual(shipment);
    }
  });

  it('are priced like the checkout prices an order', () => {
    const [dhaka, chattogram, sylhet] = mockDemoOrders.map(({ order: demo }) => demo);
    // Over ৳1,000 of items, so its delivery was free
    expect(compareMoney(dhaka?.deliveryCharge ?? '', '0')).toBe(0);
    expect(compareMoney(dhaka?.total ?? '', '1299')).toBe(0);
    expect(compareMoney(chattogram?.total ?? '', '520')).toBe(0);
    // The contracts' fixture: ৳458 of items and ৳120 outside Dhaka
    expect(compareMoney(sylhet?.total ?? '', '578')).toBe(0);
  });

  it('have links with the shape a tracking link has, each its own', () => {
    const tokens = mockDemoOrders.map(({ trackingToken }) => trackingToken);
    for (const token of tokens) expect(shopTrackingTokenSchema.safeParse(token).success).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('tracking in the mock', () => {
  it('shows the order a link names, and not who bought it', async () => {
    const tracking = await demoSource().tracking(SYLHET_LINK);
    expect(tracking).not.toBeNull();
    expect(shopTrackingSchema.parse(tracking)).toEqual(tracking);
    expect(tracking?.orderNo).toBe('W-000123');
    // Three pieces of three lines, and the rider's last try
    expect(tracking?.itemCount).toBe(3);
    expect(tracking?.shipments[0]?.events.at(-1)?.note).toBe('Customer not reachable');
    // Decision 12: nothing in the answer names the buyer or the address
    const text = JSON.stringify(tracking);
    for (const secret of ['01786120356', 'Shamim', 'Zindabazar']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers null for a link no order has', async () => {
    expect(await demoSource().tracking('AAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });

  it('tracks with the number and the phone the order was placed with, however they are typed', async () => {
    const tracking = await demoSource().track(asked('01786 120356', 'w-000123'));
    expect(tracking?.orderNo).toBe('W-000123');
  });

  it('answers null for the right number with another order’s phone', async () => {
    // 01711284519 placed W-000121: a real buyer's phone, but not this order's
    expect(await demoSource().track(asked('01711284519', 'W-000123'))).toBeNull();
  });

  it('answers null for a number no order has', async () => {
    expect(await demoSource().track(asked('01786120356', 'W-000999'))).toBeNull();
  });

  it('numbers new orders after the demo ones, and tracks them with no parcel', async () => {
    const source = demoSource();
    const placed = await source.placeOrder(order('online'));
    if (!placed.ok) throw new Error(placed.code);
    expect(placed.value.orderNo).toBe('W-000124');

    const tracking = await source.track(asked('01786120356', 'W-000124'));
    expect(tracking?.status).toBe('confirmed');
    expect(tracking?.shipments).toEqual([]);
  });

  it('does not track an order that waits for its code', async () => {
    const source = demoSource();
    const placed = await source.placeOrder(order('cod'));
    if (!placed.ok) throw new Error(placed.code);
    expect(await source.track(asked('01786120356', placed.value.orderNo))).toBeNull();
  });

  it('cannot be changed through what it answers', async () => {
    const source = demoSource();
    const first = await source.tracking(SYLHET_LINK);
    first?.shipments.splice(0);
    first?.history.splice(0);
    const again = await source.tracking(SYLHET_LINK);
    expect(again?.shipments).toHaveLength(1);
    expect(again?.history).toHaveLength(4);
  });

  it('offers the demo orders to a tester, and nothing without them', () => {
    expect(demoSource().testTracking).toEqual(
      mockDemoOrders.map(({ order: demo, trackingToken }) => ({
        orderNo: demo.orderNo,
        phone: demo.phone,
        token: trackingToken,
      })),
    );
    // The checkout's tests make a source with no demo orders: no links to offer
    expect(createMockSource().testTracking).toBeNull();
  });
});

describe('the mock’s text pages', () => {
  it('has every footer page, in the public contract', async () => {
    const source = demoSource();
    for (const slug of SHOP_TEXT_PAGES) {
      const page = await source.textPage(slug);
      expect(page).not.toBeNull();
      expect(shopTextPageSchema.parse(page)).toEqual(page);
      expect(page?.slug).toBe(slug);
    }
  });

  it('says the checkout’s own delivery charges', async () => {
    const terms = await demoSource().textPage('terms');
    for (const amount of ['৳80', '৳120', '৳1,000']) expect(terms?.html).toContain(amount);
  });
});
```

- **"are orders and parcels the contracts accept"** parses every demo order and parcel with the public schemas. The
  real API's answers will be parsed the same way, so the mock cannot drift into a shape the API never sends.
- **"are priced like the checkout prices an order"** checks the three totals and the free delivery.
- **"shows the order a link names, and not who bought it"** guards decision 12 at the source: the answer as JSON must
  not contain the phone, the name or a word of the address.
- **"answers null for the right number with another order's phone"** uses a phone that really placed a demo order
  (W-000121's), not a made-up one. That is the case a guesser with one known phone would try.
- **"numbers new orders after the demo ones"** and **"does not track an order that waits for its code"** place real
  orders through the source. The request has two face washes, because one (৳229) is under the mock's ৳300 minimum.
- **"cannot be changed through what it answers"** empties the arrays of an answer, then asks again. Without the
  copies in `trackingOf()`, the second answer would be empty too.

### `apps/shop/src/server/problem.ts`

```diff
@@ -51,9 +51,11 @@ interface ParseError {
   issues: readonly { path: readonly PropertyKey[]; message: string }[];
 }
 
-// A failed parse → 400 invalid_input with each field's codes, keyed like the ERP's API does
-// ("lines.2.quantity"), so the same client code can point at the line
-export function invalidInput(error: ParseError): Response {
+// Each field's codes from a failed parse, keyed like the ERP's API does ("lines.2.quantity"), so
+// the same client code can point at the line.
+// Step 26e: its own function, out of invalidInput, because the /track form (server/track.ts) draws
+// the same codes under its boxes instead of answering JSON
+export function fieldErrorsOf(error: ParseError): Record<string, ErrorCode[]> {
   const fieldErrors: Record<string, ErrorCode[]> = {};
   for (const issue of error.issues) {
     const field = issue.path.map(String).join('.') || 'body';
@@ -62,8 +64,13 @@ export function invalidInput(error: ParseError): Response {
     const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
     (fieldErrors[field] ??= []).push(code);
   }
+  return fieldErrors;
+}
+
+// A failed parse → 400 invalid_input with each field's codes
+export function invalidInput(error: ParseError): Response {
   return problemResponse(400, 'invalid_input', 'Check the request and try again.', {
-    fieldErrors,
+    fieldErrors: fieldErrorsOf(error),
   });
 }
 
```

`fieldErrorsOf()` is 26c's loop, moved out of `invalidInput()` so the form can use it. The form draws the same codes
under its boxes, so a phone typed wrong says the same thing on the checkout and on the track page. `invalidInput()`
now calls it and is otherwise the same.

### `apps/shop/src/server/rate-limit.ts`

```ts
// Step 26e: a limit on how often one connection may get something wrong, kept in the server's
// memory (decision 3). The /track form uses it: a wrong number and phone is the only answer a
// guesser gets, so the limit is what stops someone from walking through the order numbers with a
// phone they know.
//
// Each key has one window that starts at its first miss. When the window ends, the key starts
// again with none. A sliding window (every miss forgotten 15 minutes after it happened) would be a
// little smoother, but it has to keep every miss's time; this keeps two numbers per key, and a
// guesser still gets no more than `tries` misses in any one window.
//
// The memory is this process's. Two shop servers behind one address would each have their own, so
// a guesser would get `tries` from each; that is fine for one server, and step 27's real tracking
// moves the limit into the API, next to the orders.

interface Window {
  misses: number;
  // When the window ends (milliseconds since 1970)
  endsAt: number;
}

export interface RateLimitOptions {
  // Misses allowed in one window
  tries: number;
  windowMs: number;
  // Passed in so a test can move time
  now?: () => number;
  // How many keys it keeps at most. A key is about 100 bytes, so 50,000 is a few megabytes, even
  // when someone sends misses from a huge number of addresses
  maxKeys?: number;
}

export interface RateLimiter {
  // Seconds until this key may try again: 0 when it may try now
  waitFor(key: string): number;
  // Counts one miss for this key
  miss(key: string): void;
}

export function createRateLimiter({
  tries,
  windowMs,
  now = () => Date.now(),
  maxKeys = 50_000,
}: RateLimitOptions): RateLimiter {
  const windows = new Map<string, Window>();

  // The key's window while it lasts. An ended one is deleted when it is asked for, so the limiter
  // needs no timer
  function current(key: string): Window | undefined {
    const window = windows.get(key);
    if (window && window.endsAt <= now()) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  // Makes room for one more key by dropping the oldest window. A Map keeps its keys in the order
  // they were added, and every window has the same length, so the first key is the window that
  // ends first: it has ended already, or it is the closest to its end. If it is still open, that
  // key gets its tries back early, which is better than a server that runs out of memory
  function makeRoom(): void {
    const oldest = windows.keys().next();
    if (oldest.done !== true) windows.delete(oldest.value);
  }

  return {
    waitFor(key) {
      const window = current(key);
      if (!window || window.misses < tries) return 0;
      // Rounded up: "wait 0 seconds" would let the next try in too early
      return Math.ceil((window.endsAt - now()) / 1000);
    },

    miss(key) {
      const window = current(key);
      if (window) {
        window.misses += 1;
        return;
      }
      if (windows.size >= maxKeys) makeRoom();
      windows.set(key, { misses: 1, endsAt: now() + windowMs });
    },
  };
}

// The part of an address that names one connection. An IPv4 address is one home or one phone (or
// many phones behind a mobile operator's shared address, which is why the form counts only misses).
// An IPv6 home or phone gets a whole /64 block: 18 billion billion addresses that are all the same
// person, so the key is the block, the first four groups. Without that, every miss could come from
// a new address and the limit would never be reached.
export function addressKey(address: string): string {
  // "%en0" is a link-local address's interface name, not part of the address
  const plain = address.trim().toLowerCase().replace(/%.*$/, '');
  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7"), which Node gives on a server that
  // listens on both
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!plain.includes(':')) return plain;

  // "2001:db8::7" leaves out the groups that are zero. Put them back, so "2001:db8::7" and
  // "2001:db8:0:0::8" give the same /64
  const [head = '', tail] = plain.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  // Leading zeros dropped too ("0db8" and "db8" are the same group)
  const block = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${block.join(':')}::/64`;
}
```

A small limiter kept in memory (decision 20). It is its own module, not inside `track.ts`, because it has nothing to
do with orders, and its tests move a clock that the form's tests do not need.

- **A window starts at a key's first miss** and lasts the whole 15 minutes. The comment at the top says why it is not
  a sliding window: that would keep every miss's time, and this keeps two numbers per key.
- **`current()` deletes an ended window when it is asked for**, so the limiter needs no timer. A `setInterval` would
  keep a test process alive and would run even when nobody uses the form.
- **`waitFor()` rounds up.** With `Math.floor`, half a second before the end it would say 0 and still refuse, and the
  page would print "try again in 0 minutes".
- **`maxKeys` and `makeRoom()`** keep the memory bounded: someone who sends misses from millions of addresses could
  otherwise fill the server's memory. Every window has the same length and a `Map` keeps keys in the order they were
  added, so the first key is always the window that ends first. Dropping it gives that one key its tries back early,
  which is the smallest harm. `makeRoom()` runs only when a new key is added: a miss for a key that is already kept
  needs no room. A first version also swept every ended window first; a break-on-purpose check showed that this
  changes nothing (the oldest window is the first to end anyway), so it was taken out.
- **`addressKey()`** turns an address into what a miss counts against. `::ffff:203.0.113.7` is how Node writes an IPv4
  visitor on a server that listens on both kinds, so it is turned back into `203.0.113.7`; otherwise one visitor
  could have two keys. `%en0` (an interface name on a local address) is not part of the address. For IPv6 the zero
  groups that `::` leaves out are put back before the first four groups are taken, so `2001:db8::7` and
  `2001:0db8:0:0:1::` are the same block, and leading zeros are dropped so `0db8` and `db8` match.

### `apps/shop/src/server/rate-limit.spec.ts`

```ts
import { describe, expect, it } from 'vitest';

import { addressKey, createRateLimiter } from './rate-limit';

// Step 26e: the misses limit and the address it counts by

const MINUTE = 60 * 1000;

// A limiter whose clock the test moves: 10 misses in 15 minutes, like the /track form
function withClock(maxKeys?: number) {
  let now = 0;
  const limiter = createRateLimiter({
    tries: 10,
    windowMs: 15 * MINUTE,
    now: () => now,
    ...(maxKeys === undefined ? {} : { maxKeys }),
  });
  return {
    limiter,
    wait: (ms: number) => {
      now += ms;
    },
  };
}

function missTimes(limiter: ReturnType<typeof createRateLimiter>, key: string, times: number) {
  for (let miss = 0; miss < times; miss += 1) limiter.miss(key);
}

describe('the misses limit', () => {
  it('lets ten misses through, then says how long to wait', () => {
    const { limiter } = withClock();
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBe(0);
    limiter.miss('a');
    expect(limiter.waitFor('a')).toBe(15 * 60);
  });

  it('ends the window 15 minutes after the first miss, and counts again from none', () => {
    const { limiter, wait } = withClock();
    limiter.miss('a');
    wait(10 * MINUTE);
    missTimes(limiter, 'a', 9);
    // Five minutes are left of the window that the first miss started
    expect(limiter.waitFor('a')).toBe(5 * 60);
    wait(5 * MINUTE);
    expect(limiter.waitFor('a')).toBe(0);
    // A new window: nine misses are not ten
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBe(0);
  });

  it('rounds the wait up, so it never says 0 while it still refuses', () => {
    const { limiter, wait } = withClock();
    missTimes(limiter, 'a', 10);
    wait(15 * MINUTE - 500);
    expect(limiter.waitFor('a')).toBe(1);
  });

  it('counts each key on its own', () => {
    const { limiter } = withClock();
    missTimes(limiter, 'a', 10);
    expect(limiter.waitFor('b')).toBe(0);
  });

  it('keeps no more keys than it may, dropping the oldest window', () => {
    const { limiter, wait } = withClock(2);
    missTimes(limiter, 'old', 10);
    wait(1 * MINUTE);
    missTimes(limiter, 'newer', 10);
    // Full: 'old' is the window that ends first, so it goes, though it is still open
    missTimes(limiter, 'third', 10);
    expect(limiter.waitFor('old')).toBe(0);
    expect(limiter.waitFor('newer')).toBeGreaterThan(0);
    expect(limiter.waitFor('third')).toBeGreaterThan(0);
  });

  it('adds to a key it keeps without dropping another', () => {
    const { limiter } = withClock(2);
    limiter.miss('a');
    limiter.miss('b');
    // Two keys, the most it may keep: more misses for them must not push either out
    missTimes(limiter, 'b', 9);
    missTimes(limiter, 'a', 9);
    expect(limiter.waitFor('a')).toBeGreaterThan(0);
    expect(limiter.waitFor('b')).toBeGreaterThan(0);
  });
});

describe('the address a miss counts against', () => {
  it('keeps an IPv4 address as it is, also when Node writes it as IPv6', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts an IPv6 address by its /64 block, however it is written', () => {
    const block = addressKey('2001:db8:1:2::a');
    expect(block).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(block);
    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    // Zero groups left out before the fourth group are put back
    expect(addressKey('2001:db8::7')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('gives two neighbouring blocks two keys', () => {
    expect(addressKey('2001:db8:1:2::a')).not.toBe(addressKey('2001:db8:1:3::a'));
  });
});
```

- **The window tests** move a fake clock: ten misses stop the key for exactly 15 minutes; misses later in the window
  do not move its end; after it, counting starts again.
- **"rounds the wait up"** is the half-second case above.
- **The two `maxKeys` tests** check that the oldest window goes when a new key needs room, even while it is still
  open, and that more misses for keys already kept never push one out.
- **The address tests** write the same IPv6 block four ways, and check that two neighbouring blocks stay apart.

### `apps/shop/src/server/track.ts`

```ts
import {
  SHOP_TRACK_TRIES,
  SHOP_TRACK_WINDOW_MINUTES,
  shopTrackRequestSchema,
  type ErrorCode,
  type ShopTracking,
} from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { fieldErrorsOf, parseOptions } from './problem';
import { addressKey, createRateLimiter, type RateLimiter } from './rate-limit';

// Step 26e: the /track form's POST, without Astro around it, like orders.ts. The page (26e.3)
// passes the request, the source, the limiter and the visitor's address, and draws what comes back.
// It is a plain HTML form that posts to its own page, not a JSON route: it works without
// JavaScript, and the phone stays in the request's body, never in an address that a browser's
// history, a proxy's log or a Referer header would keep (decision 3).

// What the shopper typed, to put back in the boxes when the page is drawn again. As it was typed
// ("01786 120356", "w-123"), not as the schema made it: the shopper should see their own words
export interface TrackFormValues {
  phone: string;
  orderNo: string;
}

// The codes under each box. Only the two boxes: the form has no other field to point at
export type TrackFieldErrors = Partial<Record<keyof TrackFormValues, ErrorCode[]>>;

// The refusals the page writes above the form. Each is an error code, so its words are
// t('errors.<code>') like any other error
export type TrackRefusal = 'shop_track_not_found' | 'shop_track_too_many' | 'internal_error';

export type TrackFormAnswer =
  | { kind: 'found'; tracking: ShopTracking }
  | { kind: 'invalid'; values: TrackFormValues; fieldErrors: TrackFieldErrors }
  | {
      kind: 'refused';
      values: TrackFormValues;
      code: TrackRefusal;
      // shop_track_too_many: how long to wait, for its words ("try again in 12 minutes")
      params?: { minutes: number };
    };

// The one limiter the shop's server uses, made when the module first loads. Its memory lives as
// long as the process, like the mock's orders
export const trackLimiter: RateLimiter = createRateLimiter({
  tries: SHOP_TRACK_TRIES,
  windowMs: SHOP_TRACK_WINDOW_MINUTES * 60 * 1000,
});

// A box's value. `get` gives null for a box the form did not send and a File for a file input;
// both count as empty, so a hand-made request cannot make the page draw a File's name
function text(form: FormData, name: keyof TrackFormValues): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

interface TrackFormContext {
  source: ShopSource;
  limiter: RateLimiter;
  // Astro.clientAddress: the visitor's IP (astro.config.mjs → security says where it comes from)
  address: string;
}

export async function answerTrackForm(
  request: Request,
  { source, limiter, address }: TrackFormContext,
): Promise<TrackFormAnswer> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form body (a script that posted JSON): the same as a form with empty boxes, which the
    // schema then refuses box by box
    form = new FormData();
  }
  const values = { phone: text(form, 'phone'), orderNo: text(form, 'orderNo') };

  // The limit first: once it is reached, nothing is looked up, so a guesser learns nothing more
  // until the window ends, however right the next guess is
  const key = addressKey(address);
  const wait = limiter.waitFor(key);
  if (wait > 0) {
    return {
      kind: 'refused',
      values,
      code: 'shop_track_too_many',
      params: { minutes: Math.ceil(wait / 60) },
    };
  }

  // A box typed wrong ("0178", "SO-2026") is not a miss: nothing was looked up, so it tells a
  // guesser nothing and costs no try
  const parsed = shopTrackRequestSchema.safeParse(values, parseOptions);
  if (!parsed.success) {
    return { kind: 'invalid', values, fieldErrors: fieldErrorsOf(parsed.error) };
  }

  let tracking: ShopTracking | null;
  try {
    tracking = await source.track(parsed.data);
  } catch (error) {
    // The real source calls the API, which can be down. Logged with its details, like
    // sourceFailed in problem.ts; the shopper gets "try again", and no try is counted
    console.error('track order failed', error);
    return { kind: 'refused', values, code: 'internal_error' };
  }

  // Only a miss counts (decision 3). A shopper who checks their own order ten times is never
  // stopped, and many people behind one mobile operator's address share the misses, not the looks
  if (tracking === null) {
    limiter.miss(key);
    return { kind: 'refused', values, code: 'shop_track_not_found' };
  }
  return { kind: 'found', tracking };
}
```

The `/track` form's POST, without Astro around it, like 26c's `orders.ts`, so it can be tested with a plain
`Request`. 26e.3's page calls it and draws the answer.

- **A plain HTML form that posts to its own page** (decision 3), not a JSON route. It works without JavaScript, and
  the phone stays in the body: a GET form would put it in the address, which the browser's history, a proxy's log
  and the `Referer` header keep.
- **`TrackFormAnswer`** is a union with `kind`, so the page can `switch` on it and TypeScript knows which fields each
  case has. `found` has the tracking; `invalid` has the box errors; `refused` has an error code for the words above
  the form. `values` are the boxes as they were typed ("01786 120356", "w-123"), so the page can fill them in again
  with the shopper's own words, not the schema's.
- **`TrackRefusal` is three error codes**, not free text, because every message the shop shows comes from
  `t('errors.<code>')` (`CLAUDE.md` → Language).
- **`trackLimiter`** is made once when the module loads, so every request shares it. The page passes it in, and the
  tests make their own, so no test uses up another's tries.
- **`text()`** treats a missing box and a `File` the same as empty. A hand-made request with a file in the phone box
  would otherwise make the page write the file's name into the box.
- **`request.formData()` can throw** (a body that is not a form, such as JSON from a script). That is answered like
  empty boxes, which the schema refuses box by box, instead of a 500.
- **The order of the checks is decision 22.** The limit comes first, so once it is reached nothing is looked up, and a
  guesser learns nothing more, even with the right pair. Then the parse: a box typed wrong has not looked anything
  up, so it costs nothing. Then the lookup; a source that throws is logged and answered "try again", with no miss
  counted, because the shopper did nothing wrong. Only `null` counts a miss.
- **`minutes: Math.ceil(wait / 60)`**: the error's words say minutes (26e.1), and rounding up never says "0
  minutes".

### `apps/shop/src/server/track.spec.ts`

```ts
import { describe, expect, it, vi } from 'vitest';

import type { ShopSource } from '../data/types';
import { mockDemoOrders } from '../data/mock/demo-orders';
import { createMockSource } from '../data/mock/mock-source';
import { createRateLimiter } from './rate-limit';
import { answerTrackForm } from './track';

// Step 26e: the /track form's POST

const SYLHET = { phone: '01786 120356', orderNo: 'w-000123' };
const HOME = '203.0.113.7';

// What a browser sends for the form: URLSearchParams sets the form's Content-Type itself
function post(body: Record<string, string>): Request {
  return new Request('http://shop.test/track', { method: 'POST', body: new URLSearchParams(body) });
}

// Each test has its own source and limiter, so no test spends another's tries
function context(source: ShopSource = createMockSource(undefined, mockDemoOrders)) {
  const limiter = createRateLimiter({ tries: 10, windowMs: 15 * 60 * 1000 });
  return {
    source,
    limiter,
    ask: (body: Record<string, string>, address = HOME) =>
      answerTrackForm(post(body), { source, limiter, address }),
  };
}

describe('the track form', () => {
  it('finds the order with the number and the phone, however they are typed', async () => {
    const answer = await context().ask(SYLHET);
    expect(answer.kind).toBe('found');
    if (answer.kind === 'found') expect(answer.tracking.orderNo).toBe('W-000123');
  });

  it('puts each box’s code under it, and gives the boxes back as they were typed', async () => {
    const answer = await context().ask({ phone: '0178', orderNo: 'SO-2026' });
    expect(answer).toEqual({
      kind: 'invalid',
      values: { phone: '0178', orderNo: 'SO-2026' },
      fieldErrors: { phone: ['shop_phone_format'], orderNo: ['shop_order_no_format'] },
    });
  });

  it('treats a body that is not a form as empty boxes', async () => {
    const { source, limiter } = context();
    const request = new Request('http://shop.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SYLHET),
    });
    const answer = await answerTrackForm(request, { source, limiter, address: HOME });
    expect(answer.kind).toBe('invalid');
    if (answer.kind === 'invalid') expect(answer.values).toEqual({ phone: '', orderNo: '' });
  });

  it('says not found for a wrong pair, and stops looking after ten', async () => {
    const { ask } = context();
    for (let miss = 0; miss < 10; miss += 1) {
      const answer = await ask({ phone: '01711284519', orderNo: 'W-000123' });
      expect(answer).toMatchObject({ kind: 'refused', code: 'shop_track_not_found' });
    }
    // The right pair now gets no answer either: nothing is looked up until the window ends
    expect(await ask(SYLHET)).toMatchObject({
      kind: 'refused',
      code: 'shop_track_too_many',
      params: { minutes: 15 },
      values: SYLHET,
    });
    // Another connection is not stopped
    expect((await ask(SYLHET, '198.51.100.4')).kind).toBe('found');
  });

  it('counts the misses of one IPv6 block together', async () => {
    const { ask } = context();
    for (let miss = 0; miss < 10; miss += 1) {
      await ask({ phone: '01711284519', orderNo: 'W-000123' }, `2001:db8:1:2::${String(miss)}`);
    }
    expect(await ask(SYLHET, '2001:db8:1:2::ff')).toMatchObject({ code: 'shop_track_too_many' });
  });

  it('never counts a look that found the order, or a box typed wrong', async () => {
    const { ask } = context();
    for (let look = 0; look < 20; look += 1) {
      await ask(SYLHET);
      await ask({ phone: '0178', orderNo: '' });
    }
    expect((await ask(SYLHET)).kind).toBe('found');
  });

  it('says try again when the source fails, and counts no miss', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken: ShopSource = {
      ...createMockSource(),
      track: () => Promise.reject(new Error('API down')),
    };
    const { ask } = context(broken);
    for (let attempt = 0; attempt < 11; attempt += 1) {
      expect(await ask(SYLHET)).toMatchObject({ kind: 'refused', code: 'internal_error' });
    }
    expect(error).toHaveBeenCalledWith('track order failed', expect.any(Error));
    error.mockRestore();
  });
});
```

- **`post()`** builds the request a browser sends. A `URLSearchParams` body sets the form's `Content-Type` by
  itself, as a browser does.
- **"stops looking after ten"** sends ten wrong pairs, then the right one, which must be refused with `minutes: 15`.
  A second address still finds the order: the limit is per connection, not for the whole shop.
- **"counts the misses of one IPv6 block together"** sends each miss from a different address in one `/64`.
- **"never counts a look that found the order, or a box typed wrong"** does twenty of each and still finds the order.
- **"says try again when the source fails"** replaces only `track` on a mock source and checks that eleven failures
  never reach the limit. `console.error` is silenced and checked, so the test's output stays clean.

### `apps/shop/astro.config.ts`

```diff
@@ -23,5 +23,17 @@ export default defineConfig({
   },
   // The shop is one site per tenant on its own domain (shop.acme.com), always at the root
   trailingSlash: 'never',
+  // Step 26e: the shop runs behind a proxy (Caddy on staging), which is the only thing that can
+  // reach it. Without this, Astro trusts none of the proxy's headers, and two things go wrong:
+  // - Astro.clientAddress is the proxy's address for every visitor, so the /track form's limit
+  //   (server/track.ts) would stop everyone at once after one guesser's ten misses
+  // - Astro.url is http://localhost:4321, so a browser that sends Origin but not Sec-Fetch-Site
+  //   (Safari before 16.4, still on many older iPhones) gets 403 for every form it posts: Astro's
+  //   origin check compares the two
+  // `[{}]` trusts Host, X-Forwarded-Host, -Proto and -For from any request, because a tenant's shop
+  // can be on any domain. That is safe only while nothing but the proxy can reach the server, and
+  // the proxy writes X-Forwarded-For itself (infra/staging/Caddyfile → the shop), never passing on
+  // one the visitor sent
+  security: { allowedDomains: [{}] },
   build: { format: 'file' },
 });
```

The comment says what goes wrong without the setting and why `[{}]` (any domain) is needed: a tenant's shop can be on
any domain, so a list of domains cannot be written at build time. It also says when this is safe: only the proxy can
reach the server, and the proxy writes `X-Forwarded-For` itself.

How this was checked: a throwaway route that printed `Astro.clientAddress` and `Astro.url.origin` was added to a
built server (and removed again), and `curl` sent it what Caddy sends (`Host`, `X-Forwarded-Proto: https`,
`X-Forwarded-For`). Before the change it printed `127.0.0.1 http://localhost:4399`, and a form POST with an `Origin`
header but no `Sec-Fetch-Site` (what an older Safari sends) got 403. After it, the visitor's address and
`https://shop.example.com`, and the same POST got 200. A POST with another site's `Origin` still got 403, so the
origin check still does its job. A request straight to `localhost` (as in the Playwright tests) is unchanged.

### `infra/staging/Caddyfile`

```diff
@@ -97,8 +97,13 @@ http://{$SHOP_HOST} {
 		}
 	}
 
+	# Step 26e: the shop trusts X-Forwarded-For (astro.config.ts → security), and the /track form's
+	# limit counts misses by that address. As for the API, the header is replaced with the one
+	# address Cloudflare vouches for, so a visitor cannot get new tries by sending a made-up one.
 	handle {
-		reverse_proxy shop:4321
+		reverse_proxy shop:4321 {
+			header_up X-Forwarded-For {client_ip}
+		}
 	}
 }
 
```

The shop's `handle` gets the same `header_up X-Forwarded-For {client_ip}` as the API. Caddy trusts cloudflared (a
private address) and would otherwise add to the header the visitor sent, and Astro reads the first address in it,
which the visitor could make up. With the header replaced by the one address Cloudflare vouches for, a guesser
cannot get ten new tries by sending a new `X-Forwarded-For`. The built files under `/_astro/` do not need it: they
never read the address.

### Check this part

```bash
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop/src apps/shop/astro.config.ts
pnpm exec prettier --check apps/shop/src apps/shop/astro.config.ts
```

The shop has 190 unit tests after this part (30 new). Nothing draws the new code yet, so there is nothing to see in
the browser; 26e.3 adds the pages.

Broken on purpose while this part was written, each caught:

- `...order` added to the answer in `trackingOf()` → "shows the order a link names, and not who bought it" fails;
- `track()` no longer checks the phone → "answers null for the right number with another order's phone" fails;
- `sequence` starts at 0 again → "numbers new orders after the demo ones" fails;
- `limiter.miss(key)` removed → "stops looking after ten" fails;
- a box typed wrong counts a miss → "never counts a look that found the order, or a box typed wrong" fails;
- IPv6 counted by the full address → the address tests and "counts the misses of one IPv6 block together" fail;
- the `maxKeys` check removed → "keeps no more keys than it may" fails;
- room made on every miss, also for a key already kept → "adds to a key it keeps without dropping another" fails.

## 26e.3 — `apps/shop`: the tracking pages, the text pages and "page not found"

This part draws what 26e.1 and 26e.2 made: the tracking link `/t/<token>`, the `/track` form, the footer's four pages
and `404.astro`. The rules sit in two small `lib/` files with their own tests; the pages only draw. Nothing here needs
a script in the browser.

### `apps/shop/src/lib/tracking-view.ts`

```ts
import type {
  ShopShipment,
  ShopShipmentEvent,
  ShopShipmentStatus,
  ShopTracking,
} from '@omnivo/contracts';

import type { TimelineState } from './order-timeline';

// Step 26e: the rules of the tracking view (components/TrackingView.astro), apart from the markup
// and tested once, like 26c's order-timeline.ts. A tracking link and the /track form draw the
// same view, so the rules are written here and nowhere else.

// The order statuses in which Cash on Delivery money is still to be paid at the door. Delivered is
// paid; cancelled and returned will never be
const PAY_AT_THE_DOOR: ReadonlySet<ShopTracking['status']> = new Set([
  'pending',
  'confirmed',
  'packed',
  'shipped',
]);

// The line under the total: what the person at the door has to do about money, or null when there
// is nothing to say (a Cash on Delivery order that is delivered, cancelled or returned)
export type PaymentLine = 'payOnDelivery' | 'paidOnline' | null;

export function paymentLine(tracking: Pick<ShopTracking, 'paymentMethod' | 'status'>): PaymentLine {
  if (tracking.paymentMethod === 'online') return 'paidOnline';
  return PAY_AT_THE_DOOR.has(tracking.status) ? 'payOnDelivery' : null;
}

// Where a parcel's way ends. Its newest event is then a done step, not the current one: nothing
// more will happen to that parcel
const PARCEL_ENDS: ReadonlySet<ShopShipmentStatus> = new Set([
  'delivered',
  'partly_delivered',
  'returned',
  'cancelled',
]);

// One courier event with its dot, in the order timeline's three states (order-timeline.ts). A
// parcel's events have all happened, so none is "later"
export interface ParcelEventView {
  event: ShopShipmentEvent;
  state: Exclude<TimelineState, 'later'>;
}

// One parcel as the view draws it: its events newest first, and whether it is the one the order
// is with now. The contract keeps both lists oldest first, as they happened
export interface ParcelView {
  shipment: ShopShipment;
  events: ParcelEventView[];
  current: boolean;
}

// Newest first, for parcels and for their events: the shopper's question is "where is it now?",
// and the answer must be the first thing on a phone's screen, not at the end of a long list.
// Couriers' own tracking pages show their events this way too. `toReversed` makes a copy, so the
// tracking that came from the source is never changed
export function parcelViews(shipments: readonly ShopShipment[]): ParcelView[] {
  return shipments.toReversed().map((shipment, index) => {
    const current = index === 0;
    return {
      shipment,
      current,
      events: shipment.events.toReversed().map((event, at) => ({
        event,
        // Only the newest event of the parcel the order is with now is "current", and only while
        // its way has not ended. An earlier parcel is over, whatever its last event says
        state: current && at === 0 && !PARCEL_ENDS.has(event.status) ? 'current' : 'done',
      })),
    };
  });
}
```

The tracking view's rules, apart from its markup, like 26c's `order-timeline.ts`.

- **`paymentLine()`** says what the person at the door must do about money. An online order is "Paid with Mobile
  Banking". A Cash on Delivery order says "Keep ৳578 ready in cash for the rider" only while that is still true:
  once it is delivered, the money is paid, and once it is cancelled or returned, it never will be. "Keep ৳578 ready"
  on a delivered order would make a shopper think they still owe it.
- **`PAY_AT_THE_DOOR` is a `ReadonlySet` of `ShopTracking['status']`**, so a status that is not in the contract does
  not type-check, and nothing can add to the set by mistake.
- **`parcelViews()` puts the newest parcel and the newest event first** (decision 23). `toReversed()` makes a new
  array; `reverse()` would turn the source's own arrays around, and the mock hands out copies, but the real source
  might not.
- **Each event gets a dot state**, the order timeline's `done` and `current` (never `later`: every event has
  happened). Only the newest event of the parcel the order is with now is `current`, and only while the parcel's way
  has not ended. `PARCEL_ENDS` lists the four ends. A delivered parcel then shows all ticks, like the order
  timeline's "Delivered", and an earlier parcel (the RedX booking that was cancelled) never looks like the one that
  is moving.

### `apps/shop/src/lib/tracking-view.spec.ts`

```ts
import type { ShopShipment } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { parcelViews, paymentLine, type ParcelView } from './tracking-view';

const cancelled: ShopShipment = {
  courier: 'redx',
  trackingCode: 'RX1108A77',
  trackingUrl: null,
  events: [
    { status: 'booked', at: '2026-11-08T15:35:00+06:00', note: null },
    { status: 'cancelled', at: '2026-11-08T18:10:00+06:00', note: 'Cancelled by merchant' },
  ],
};
const delivered: ShopShipment = {
  courier: 'pathao',
  trackingCode: 'DH1108229K4',
  trackingUrl: 'https://merchant.pathao.com/tracking?consignment_id=DH1108229K4',
  events: [
    { status: 'booked', at: '2026-11-08T18:20:00+06:00', note: null },
    { status: 'delivered', at: '2026-11-09T17:40:00+06:00', note: null },
  ],
};

describe('paymentLine', () => {
  it('asks for cash at the door until a Cash on Delivery order is delivered', () => {
    for (const status of ['pending', 'confirmed', 'packed', 'shipped'] as const) {
      expect(paymentLine({ paymentMethod: 'cod', status })).toBe('payOnDelivery');
    }
  });

  it('says nothing about cash once there is nothing left to pay', () => {
    for (const status of ['delivered', 'cancelled', 'returned'] as const) {
      expect(paymentLine({ paymentMethod: 'cod', status })).toBeNull();
    }
  });

  it('says an online order is paid, whatever its status', () => {
    expect(paymentLine({ paymentMethod: 'online', status: 'shipped' })).toBe('paidOnline');
    expect(paymentLine({ paymentMethod: 'online', status: 'delivered' })).toBe('paidOnline');
  });
});

describe('parcelViews', () => {
  const statuses = (view: ParcelView | undefined) => view?.events.map(({ event }) => event.status);
  const states = (view: ParcelView | undefined) => view?.events.map(({ state }) => state);

  it('puts the newest parcel and the newest event first', () => {
    const [now, earlier] = parcelViews([cancelled, delivered]);
    expect(now?.shipment.courier).toBe('pathao');
    expect(now?.current).toBe(true);
    expect(statuses(now)).toEqual(['delivered', 'booked']);
    expect(earlier?.shipment.courier).toBe('redx');
    expect(earlier?.current).toBe(false);
    expect(statuses(earlier)).toEqual(['cancelled', 'booked']);
  });

  it('marks where the parcel is now, until its way ends', () => {
    const onHold: ShopShipment = {
      ...delivered,
      events: [
        { status: 'booked', at: '2026-11-12T10:06:00+06:00', note: null },
        { status: 'on_hold', at: '2026-11-13T13:15:00+06:00', note: 'Customer not reachable' },
      ],
    };
    expect(states(parcelViews([onHold])[0])).toEqual(['current', 'done']);
    // Delivered is the end of the way: done, like the order timeline's last step
    expect(states(parcelViews([delivered])[0])).toEqual(['done', 'done']);
    // An earlier parcel is over, even though its newest event is not an end
    expect(states(parcelViews([onHold, delivered])[1])).toEqual(['done', 'done']);
  });

  it('leaves the tracking it was given as it was', () => {
    const shipments = [cancelled, delivered];
    parcelViews(shipments);
    expect(shipments[0]).toBe(cancelled);
    expect(cancelled.events[0]?.status).toBe('booked');
  });

  it('has nothing to draw before the parcel is booked', () => {
    expect(parcelViews([])).toEqual([]);
  });
});
```

- **The `paymentLine` tests** walk every status for Cash on Delivery, so a status added to the order's list later
  must be put on one side or the other.
- **"marks where the parcel is now, until its way ends"** has the three cases of the dot rule: on hold (current),
  delivered (done), and an earlier parcel (done).
- **"leaves the tracking it was given as it was"** fails if `toReversed()` becomes `reverse()`.

### `apps/shop/src/lib/text-page.ts`

```ts
import { SHOP_TEXT_PAGES, todayIn, type ShopTextPageSlug } from '@omnivo/contracts';

// Step 26e: the footer's text pages (/pages/<slug>).

// A slug from the address, as one of the footer's four pages. A type guard, so the page can hand
// the slug to the source (textPage takes ShopTextPageSlug) without a cast. Exact: "Terms" is not
// "terms", because the footer links to the lower-case one and two addresses for one page would be
// two pages to a search engine
export function isTextPageSlug(slug: string | undefined): slug is ShopTextPageSlug {
  return SHOP_TEXT_PAGES.some((page) => page === slug);
}

// The day a page was last changed, in the shop's time zone, as a Date that formatDate() reads
// right. formatDate() reads a Date's local parts (the server's time zone), and a server in UTC
// would write 1 Nov 2026 00:30 in Dhaka as "31 Oct 2026". So the shop's calendar day is worked out
// first (todayIn, the ERP's helper), then made into midnight of that day on the server's clock
export function dayInShop(iso: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = todayIn(timeZone, new Date(iso)).split('-').map(Number);
  return new Date(year, month - 1, day);
}
```

- **`isTextPageSlug()`** is a type guard, so the page hands the slug to `textPage()` (which takes
  `ShopTextPageSlug`) with no cast. `some()` compares the address's slug with each of the four; `includes()` would
  not compile, because the list's type is the four literal slugs and the address's slug is any string. It is exact:
  `/pages/Terms` is not `/pages/terms`, because two addresses for one page are two pages to a search engine.
- **`dayInShop()`** (decision 27). `formatDate()` from `@omnivo/i18n` takes no time zone: it writes a `Date`'s
  local parts, which on a server are the server's. So the shop's calendar day is worked out first with `todayIn()`
  (the ERP's helper in the contracts, which writes `2026-11-01` in a given time zone), and then made into midnight
  of that day on the server's own clock. `formatDate()` reads it back as the same day on any server. The `= 0`,
  `= 1` defaults are only there because the type of an array item from `split()` may be `undefined`; `todayIn()`
  always gives three parts.

### `apps/shop/src/lib/text-page.spec.ts`

```ts
import { formatDate } from '@omnivo/i18n';
import { describe, expect, it } from 'vitest';

import { dayInShop, isTextPageSlug } from './text-page';

describe('isTextPageSlug', () => {
  it('knows the footer pages and nothing else', () => {
    expect(isTextPageSlug('terms')).toBe(true);
    expect(isTextPageSlug('contact')).toBe(true);
    expect(isTextPageSlug('Terms')).toBe(false);
    expect(isTextPageSlug('refunds')).toBe(false);
    expect(isTextPageSlug('')).toBe(false);
    expect(isTextPageSlug(undefined)).toBe(false);
  });
});

describe('dayInShop', () => {
  it("writes the shop's day, not the server's", () => {
    // 00:30 on 1 November in Dhaka is still 31 October in UTC
    expect(formatDate(dayInShop('2026-10-31T18:30:00Z', 'Asia/Dhaka'), 'en')).toBe('1 Nov 2026');
    expect(formatDate(dayInShop('2026-10-31T18:30:00Z', 'UTC'), 'en')).toBe('31 Oct 2026');
  });

  it('writes the day in Bangla too', () => {
    expect(formatDate(dayInShop('2026-11-01T10:00:00+06:00', 'Asia/Dhaka'), 'bn')).toBe(
      formatDate(new Date(2026, 10, 1), 'bn'),
    );
  });
});
```

**"writes the shop's day, not the server's"** uses 00:30 on 1 November in Dhaka, which is still 31 October in UTC,
and checks both time zones. It fails with `new Date(iso)` whatever time zone the test machine has: on a machine in
Dhaka (or east of it) the UTC line fails, and on one west of Dhaka the Dhaka line does.

### `apps/shop/src/lib/order-timeline.ts`

```diff
@@ -6,6 +6,15 @@ import type { ShopOrder, ShopOrderStatus } from '@omnivo/contracts';
 
 export type TimelineState = 'done' | 'current' | 'later';
 
+// The three dots of CLAUDE.md: done (brand, an accent tick), current (brand inside a 2px accent
+// ring), later (an empty 1px rule ring). Step 26e: here, not in OrderTimeline.astro, because a
+// parcel's events (TrackingView.astro) draw the same dots, and the two must never look different
+export const TIMELINE_DOT: Record<TimelineState, string> = {
+  done: 'bg-brand text-accent',
+  current: 'border-2 border-accent bg-brand',
+  later: 'border border-rule bg-card',
+};
+
 export interface TimelineStep {
   status: ShopOrderStatus;
   // When the order reached this step (ISO), or null for a step still ahead
```

The three dots' classes move here from `OrderTimeline.astro` as `TIMELINE_DOT`, because a parcel's events draw the
same dots. Two copies of a class string would drift apart the first time someone changes one. A `Record` keyed by
`TimelineState` makes the type check fail if a fourth state is added without its dot. Tailwind finds the classes in
a `.ts` file as well as in an `.astro` one, because it scans every source file of the app.

### `apps/shop/src/components/OrderTimeline.astro`

```diff
@@ -5,11 +5,11 @@ import type { ShopOrder } from '@omnivo/contracts';
 import { formatDateTime } from '@omnivo/i18n';
 
 import type { ShopLocale } from '../lib/locale';
-import { orderTimeline } from '../lib/order-timeline';
+import { orderTimeline, TIMELINE_DOT } from '../lib/order-timeline';
 
 // Step 26c: an order's status as a vertical timeline (CLAUDE.md → Track order). /order/<no> draws
-// it now; 26d's /track draws the same one. Drawn on the server, with no script: it changes only
-// when the shop moves the order, and a reload shows that.
+// it, and 26e's tracking view (TrackingView.astro) draws the same one. Drawn on the server, with
+// no script: it changes only when the shop moves the order, and a reload shows that.
 interface Props {
   order: Pick<ShopOrder, 'status' | 'history'>;
   locale: ShopLocale;
@@ -22,14 +22,6 @@ interface Props {
 const { order, locale, timeZone, labelledBy } = Astro.props;
 const { t } = locale;
 const steps = orderTimeline(order);
-
-// The three dots of CLAUDE.md: done (brand, an accent tick), current (brand inside a 2px accent
-// ring), later (an empty 1px rule ring)
-const DOT = {
-  done: 'bg-brand text-accent',
-  current: 'border-2 border-accent bg-brand',
-  later: 'border border-rule bg-card',
-} as const;
 ---
 
 <ol aria-labelledby={labelledBy} class="flex flex-col">
@@ -46,7 +38,9 @@ const DOT = {
         {/* The 2px line runs from under this dot to the next one, through the 24px gap. 11px
               from the left centers it under the 24px dot */}
         {!last && <span class={`absolute top-6 bottom-0 left-[11px] w-0.5 ${line}`} />}
-        <span class={`grid size-6 shrink-0 place-items-center rounded-full ${DOT[step.state]}`}>
+        <span
+          class={`grid size-6 shrink-0 place-items-center rounded-full ${TIMELINE_DOT[step.state]}`}
+        >
           {step.state === 'done' && (
             <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
           )}
```

Uses `TIMELINE_DOT` in place of its own `DOT`; it draws exactly what it drew before. The comment now names the
tracking view that draws it too.

### `apps/shop/src/components/PageCard.astro`

```
---
// Step 26e: the checkout card as a page's frame (CLAUDE.md → Checkout card, and the screens "not in
// Figma" that use it: Track order and the text pages). A 4px glass frame, a cream header with the
// page's title, and the page's own body in the slot. 26c's checkout, verify and order pages draw
// the same card inline; this step's three pages share it instead of a fourth and fifth copy.
interface Props {
  // The page's h1, centered in the header
  title: string;
  // A line under the title ("Last updated 1 Nov 2026"), or nothing
  note?: string | null;
  // The checkout's 848px, or the verify page's 560px
  width?: 'wide' | 'narrow';
}

const { title, note = null, width = 'wide' } = Astro.props;
---

{/* 36px under the header from md (16px on a phone), and the checkout's 160px to the footer */}
<div
  class:list={[
    'mx-auto mt-4 rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40',
    width === 'wide' ? 'max-w-[848px]' : 'max-w-[560px]',
  ]}
>
  <div class="flex flex-col items-center gap-4 rounded-t-xl bg-cream p-6 text-center">
    <h1 class="trim-text text-sf-title font-semibold">{title}</h1>
    {note !== null && <p class="trim-text text-sf-small text-muted">{note}</p>}
  </div>
  <slot />
</div>
```

The checkout card as a frame (decision 26): the 4px glass edge, the cream header with the page's `h1`, and the
page's body in the slot. The sizes are the checkout's: 36px under the header from `md`, 160px to the footer, 848px
wide, or the verify page's 560px for a short form. `note` is the line under the title ("Last updated 1 Nov 2026").
The body is the slot with no padding of its own, because the text pages want their sections at the card's edge and
the tracking view wants 36px of padding.

### `apps/shop/src/components/TrackingView.astro`

```
---
import { LinkSquare02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopTracking } from '@omnivo/contracts';
import { formatDateTime, formatNumber } from '@omnivo/i18n';

import type { ShopLocale } from '../lib/locale';
import { TIMELINE_DOT } from '../lib/order-timeline';
import { parcelViews, paymentLine } from '../lib/tracking-view';
import OrderTimeline from './OrderTimeline.astro';

// Step 26e: where an order and its parcel are (decision 2; CLAUDE.md → Track order). A tracking
// link (/t/<token>) and the /track form draw this one view (decision 3), inside the checkout card
// (PageCard). It names no person (decision 12): the number, the order's timeline, how many items,
// what to pay, and each parcel's way. Drawn on the server with no script, like the timeline.
interface Props {
  tracking: ShopTracking;
  locale: ShopLocale;
  // The shop's, so every time on the page is the time in Dhaka on any server
  timeZone: string;
}

const { tracking, locale, timeZone } = Astro.props;
const { t, money } = locale;
const when = (iso: string) => formatDateTime(new Date(iso), locale.language, timeZone);

// `count` picks the plural ("1 item", "3 items"); `replace` writes it in the shop's digits, so a
// Bangla shop says "৩টি পণ্য", not "3টি পণ্য"
const items = t('shop.track.items', {
  count: tracking.itemCount,
  replace: { count: formatNumber(tracking.itemCount, locale.language) },
});
const payment = paymentLine(tracking);
const parcels = parcelViews(tracking.shipments);
const heading = 'font-semibold';
---

<div class="flex flex-col gap-8 p-5 md:p-9">
  <div class="flex flex-col gap-1">
    {/* CLAUDE.md: the number is never broken over two lines */}
    <p class="font-mono text-sf-title font-semibold whitespace-nowrap">{tracking.orderNo}</p>
    <p class="text-sf-small text-muted">
      {t('shop.order.placedOn', { date: when(tracking.placedAt) })}
    </p>
  </div>

  {/* What the person at the door needs: how many items come, and what to pay for them */}
  <div class="flex flex-col gap-3 rounded-lg bg-canvas p-5">
    <p class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-semibold">
      <span>{items}</span>
      <span>
        {`${t('shop.track.total')} `}
        <span class="text-price tabular-nums">{money(tracking.total)}</span>
      </span>
    </p>
    {payment === 'payOnDelivery' && (
      <p class="text-sf-small text-body">
        {t('shop.track.payOnDelivery', { amount: money(tracking.total) })}
      </p>
    )}
    {payment === 'paidOnline' && (
      <p class="text-sf-small text-body">{t('shop.track.paidOnline')}</p>
    )}
  </div>

  <section class="flex flex-col gap-4">
    <h2 id="tracking-order" class={heading}>
      {t('shop.order.timeline')}
    </h2>
    <OrderTimeline
      order={tracking}
      locale={locale}
      timeZone={timeZone}
      labelledBy="tracking-order"
    />
  </section>

  {/* Before the shop books a courier, the parcel's section says so, instead of being left out:
      a shopper who opens the link from the SMS asks "has it been sent?" either way */}
  {parcels.length === 0 && (
    <section class="flex flex-col gap-4">
      <h2 class={heading}>{t('shop.track.parcel')}</h2>
      <p class="text-sf-small text-body">{t('shop.track.noParcel')}</p>
    </section>
  )}

  {parcels.map(({ shipment, events, current }, index) => {
    const id = `tracking-parcel-${String(index)}`;
    const courier = t(`shop.track.couriers.${shipment.courier}`);
    return (
      <section class="flex flex-col gap-4" aria-labelledby={id}>
        <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div class="flex flex-col gap-1">
            <h2 id={id} class={heading}>
              {current ? t('shop.track.parcel') : t('shop.track.earlierParcel')}
            </h2>
            {/* The code the courier's call centre asks for. tabular-nums, so it is easy to read
                out digit by digit */}
            <p class="text-sf-small text-muted tabular-nums">
              {t('shop.track.courierLine', { courier, code: shipment.trackingCode })}
            </p>
          </div>
          {/* noreferrer: the address of a tracking link is its key. Without it, the courier's
              site would get /t/<token> in the Referer header and could open the page too */}
          {shipment.trackingUrl !== null && (
            <a
              href={shipment.trackingUrl}
              rel="noopener noreferrer"
              class="flex items-center gap-1 text-sf-small font-semibold underline-offset-3 hover:underline"
            >
              {t('shop.track.openCourier', { courier })}
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </a>
          )}
        </div>

        {/* The order timeline's dots and line, newest event first (tracking-view.ts says why).
            Every event has happened, so the line between the dots is always brand */}
        <ol aria-labelledby={id} class="flex flex-col">
          {events.map(({ event, state }, at) => {
            const last = at === events.length - 1;
            return (
              <li
                class:list={['relative flex gap-4', !last && 'pb-6']}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                {!last && <span class="absolute top-6 bottom-0 left-[11px] w-0.5 bg-brand" />}
                <span
                  class={`grid size-6 shrink-0 place-items-center rounded-full ${TIMELINE_DOT[state]}`}
                >
                  {state === 'done' && (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={14}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span class="flex min-w-0 flex-col">
                  <span class="leading-6 font-semibold">
                    {t(`shop.track.shipmentStatuses.${event.status}`)}
                  </span>
                  <time datetime={event.at} class="text-sf-small text-muted tabular-nums">
                    {when(event.at)}
                  </time>
                  {/* The courier's own words, as they came (26e.1): often the most useful line */}
                  {event.note !== null && (
                    <span class="wrap-break-word text-sf-small text-body">{event.note}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    );
  })}

  {/* The page's own end: the link's privacy line, or "Track another order" */}
  <slot />
</div>
```

The one view a link and the form draw (decision 3).

- **The number, then "Placed on"**, as on 26c's order page. The number never breaks over two lines.
- **The item count uses `replace`** next to `count`: `count` picks the plural form, and `replace` puts the number
  in the shop's digits. Without it, a Bangla shop would say "3টি পণ্য" with an ASCII 3. The shop's other counts do
  the same (`LoadMore.astro`, `CartButton.astro`).
- **The canvas box holds what the person at the door needs**: the count, the total in `price`, and
  `paymentLine()`'s sentence. The total's label and amount are one span, with the space written as part of the text,
  because Astro drops the line break between two elements.
- **"Order status" is 26c's `OrderTimeline`**, with the tracking as its `order`: it takes only `status` and
  `history`, which the tracking has (26e.1 made `history` the order's own schema for this).
- **No parcel yet** still gets its section, with `noParcel`. A shopper who opens the link from the SMS asks "has it
  been sent?" either way, and an empty space answers nothing.
- **Each parcel is a `section` named by its heading** ("Parcel" or "Earlier parcel"), with the courier's line under
  it. The ids are numbered (`tracking-parcel-0`), because an order can have up to five parcels and each list needs
  its own label.
- **The courier's link** is drawn only when the courier gave one (26e.1 made it https only). `rel="noopener
  noreferrer"`: the page's address is its key, and a `Referer` header would give it to the courier's site (decision
  24). It opens in the same tab, so it needs no "opens in a new tab" warning, and Back returns here.
- **The events reuse the timeline's markup**: the dot, the 2px line from under it to the next dot, and the words.
  The line is always `brand`, because every event happened. The courier's note is shown as it came, under the time,
  with `wrap-break-word`, because a courier's note can be one long word (a hub's code).
- **The slot at the end** is the page's own last line: the link's privacy sentence, or "Track another order".

### `apps/shop/src/pages/t/[token].astro`

```
---
import { Unlink04Icon } from '@hugeicons/core-free-icons';
import { shopTrackingTokenSchema } from '@omnivo/contracts';

import EmptyState from '../../components/EmptyState.astro';
import PageCard from '../../components/PageCard.astro';
import TrackingView from '../../components/TrackingView.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';

// Step 26e: a tracking link, as the SMS sends it (decision 1). The token is the key: anyone who has
// the link sees the page, and the page names no person (decision 12).
const raw = Astro.params.token ?? '';
// The shape first (26e.1): a link an SMS app cut in two, or one typed by hand, is answered without
// asking the source, so the real API never sees a token that cannot be one
const token = shopTrackingTokenSchema.safeParse(raw);
const tracking = token.success ? await shopSource.tracking(token.data) : null;

const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
const locale = await shopLocale(shop.language);
const { t } = locale;

// The token is in the address, so no cache may keep the page under it, a search engine may not
// list it (a link pasted on a public page would be found), and no other site may get the address
// in a Referer header. The links on the page to the courier's site also say noreferrer; this
// header covers every link, now and later
Astro.response.headers.set('Cache-Control', 'no-store');
Astro.response.headers.set('X-Robots-Tag', 'noindex');
Astro.response.headers.set('Referrer-Policy', 'no-referrer');

// A broken or unknown link: still 404 (the page does not exist), but with its own words and the
// way to the form (decision 16), which the general "page not found" would not give. The status
// text is set too: Astro keeps "OK" from the 200 it started with, and the line would read
// "404 OK" in logs
if (tracking === null) {
  Astro.response.status = 404;
  Astro.response.statusText = 'Not Found';
}
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={
    tracking === null
      ? t('shop.notFound.pageTitle', { shop: shop.name })
      : t('shop.track.linkPageTitle', { orderNo: tracking.orderNo, shop: shop.name })
  }
  categories={categories}
>
  {tracking === null ? (
    <div class="mt-4 md:mt-9 md:mb-40">
      <EmptyState
        icon={Unlink04Icon}
        level="h1"
        title={t('shop.track.linkGoneTitle')}
        text={t('shop.track.linkGoneText')}
        action={{ href: '/track', label: t('shop.track.linkGoneAction') }}
      />
    </div>
  ) : (
    <PageCard title={t('shop.track.title')}>
      <TrackingView tracking={tracking} locale={locale} timeZone={shop.timeZone}>
        <p class="text-sf-small text-muted">{t('shop.track.linkPrivate')}</p>
      </TrackingView>
    </PageCard>
  )}
</ShopLayout>
```

- **The token's shape is checked before the source is asked** (26e.1). A link an SMS app cut in two is answered
  without a lookup, so the real API never gets a token that cannot be one.
- **The three headers of decision 24** are set before the page is drawn. They are set on the "does not work" answer
  too: a cut link is still a key, if a short one.
- **A broken or unknown link answers 404, but draws its own empty state** (decision 16), not `Astro.rewrite('/404')`:
  "This tracking link does not work" and a button to the form say what to do next, which "Page not found" does not.
  Setting `Astro.response.status` keeps the page's own markup with the 404 status. **`statusText` is set with it**
  (added in 26e.6): Astro keeps the "OK" of the 200 it started with, so the status line was `HTTP/1.1 404 OK`. A
  browser reads only the number, but logs, `curl` and proxies show the text, and "404 OK" reads like a bug. Only a
  root `404.astro` gets "Not Found" from Astro by itself. The `Unlink04` icon is a broken link.
- **The browser tab** says "Order W-000123 | Omnivo" for a working link, and the general "Page not found" title
  otherwise.

### `apps/shop/src/pages/track.astro`

```
---
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import PageCard from '../components/PageCard.astro';
import TrackingView from '../components/TrackingView.astro';
import { shopSource } from '../data/source';
import ShopLayout from '../layouts/ShopLayout.astro';
import { shopLocale } from '../lib/locale';
import { spacedPhone } from '../lib/phone';
import {
  answerTrackForm,
  trackLimiter,
  type TrackFieldErrors,
  type TrackFormAnswer,
  type TrackFormValues,
} from '../server/track';

// Step 26e: the way back for a shopper who lost the SMS (decision 3; CLAUDE.md → Track order). A
// GET draws the form. The form POSTs to this same page, so the phone stays in the request's body,
// and the answer is drawn in place: the tracking view, or the form again with what to fix.
let answer: TrackFormAnswer | null = null;
if (Astro.request.method === 'POST') {
  answer = await answerTrackForm(Astro.request, {
    source: shopSource,
    limiter: trackLimiter,
    // The visitor's address, which astro.config.ts → security says to read from the proxy's
    // X-Forwarded-For (26e.2)
    address: Astro.clientAddress,
  });
  // A browser draws the page whatever the status; the status is for scripts and logs, which can
  // then tell "slow down" from a form that worked (the text too, or the line reads "429 OK")
  if (answer.kind === 'refused' && answer.code === 'shop_track_too_many') {
    Astro.response.status = 429;
    Astro.response.statusText = 'Too Many Requests';
  }
}

const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
const locale = await shopLocale(shop.language);
const { t } = locale;

// The answer has an order (or, refused, the phone the shopper typed): no cache may keep it. The
// GET form is the same for everyone, but a cache that kept it would also need to tell it apart
// from the POST's answer, and the page is small
Astro.response.headers.set('Cache-Control', 'no-store');

const empty: TrackFormValues = { phone: '', orderNo: '' };
const values = answer === null || answer.kind === 'found' ? empty : answer.values;
const fieldErrors: TrackFieldErrors = answer?.kind === 'invalid' ? answer.fieldErrors : {};
const refusal =
  answer?.kind === 'refused'
    ? answer.code === 'shop_track_too_many'
      ? // params.minutes is there for this code (server/track.ts); 15 is the whole window, a
        // safe thing to say if it ever were not
        t('errors.shop_track_too_many', { minutes: answer.params?.minutes ?? 15 })
      : t(`errors.${answer.code}`)
    : null;

// The two boxes. The first code of a box is its message: one thing to fix at a time, like the
// checkout's fields. `as const` keeps each name a key of TrackFormValues, so values[field.name]
// and fieldErrors[field.name] below are checked
const fields = [
  {
    name: 'phone',
    label: t('shop.track.phone'),
    placeholder: t('shop.track.phonePlaceholder'),
    // tel: the phone keyboard, and the browser offers the shopper's own number
    attributes: { type: 'tel', inputmode: 'tel', autocomplete: 'tel' },
  },
  {
    name: 'orderNo',
    label: t('shop.track.orderNo'),
    placeholder: t('shop.track.orderNoPlaceholder'),
    // A code, not a word: no spell check, no autofill from other forms, and capitals on a phone
    // keyboard (the schema upper-cases it anyway, 26e.1)
    attributes: {
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
    },
  },
] as const;

const firstError = fields.find((field) => fieldErrors[field.name] !== undefined)?.name;
const errorText = (name: keyof TrackFormValues): string | null => {
  const code = fieldErrors[name]?.[0];
  return code === undefined ? null : t(`errors.${code}`);
};
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={
    answer?.kind === 'found'
      ? t('shop.track.linkPageTitle', { orderNo: answer.tracking.orderNo, shop: shop.name })
      : t('shop.track.pageTitle', { shop: shop.name })
  }
  categories={categories}
>
  <PageCard title={t('shop.track.title')} width={answer?.kind === 'found' ? 'wide' : 'narrow'}>
    {answer?.kind === 'found' ? (
      <TrackingView tracking={answer.tracking} locale={locale} timeZone={shop.timeZone}>
        {/* A GET of this page: the empty form again */}
        <a
          href="/track"
          class="flex h-11 items-center justify-center rounded-sm bg-cream font-semibold transition-colors duration-150 hover:bg-accent"
        >
          {t('shop.track.another')}
        </a>
      </TrackingView>
    ) : (
      /* noValidate: the browser's own bubbles would be in the browser's language. The server
         checks the boxes and draws its own errors, so the form works without a script */
      <form method="post" action="/track" novalidate class="flex flex-col gap-8 p-5 md:p-9">
        <div class="flex flex-col gap-3">
          <p class="text-body">{t('shop.track.intro')}</p>
          {/* Only a test shop has orders to offer (ShopSource.testTracking): the mock sends no
              SMS, so this is where a tester gets a number, its phone and its link (decision 18) */}
          {shopSource.testTracking !== null && (
            <div class="flex flex-col gap-2 rounded-lg bg-canvas px-4 py-3 text-sf-small font-medium text-body">
              <p>{t('shop.track.mockOrders')}</p>
              <ul class="flex flex-col gap-1">
                {shopSource.testTracking.map((demo) => (
                  <li class="flex flex-wrap gap-x-2 tabular-nums">
                    <span>
                      {t('shop.track.mockOrder', {
                        orderNo: demo.orderNo,
                        phone: spacedPhone(demo.phone),
                      })}
                    </span>
                    <a href={`/t/${demo.token}`} class="font-semibold underline underline-offset-3">
                      {t('shop.track.mockLink', { orderNo: demo.orderNo })}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* "No order has this number and mobile number", "Too many tries…": about both boxes, so
            above them. It takes the focus when the page opens (autofocus on a tabindex="-1"
            element), so a screen reader reads it first; role="alert" does not speak for text
            that was already in the page when it loaded */}
        {refusal !== null && (
          <p
            role="alert"
            tabindex="-1"
            autofocus
            class="flex items-start gap-1.5 font-medium text-promo focus:outline-none"
          >
            <HugeiconsIcon
              icon={Alert02Icon}
              size={16}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>{refusal}</span>
          </p>
        )}

        {/* Two columns from md, like the checkout's Full Name and Mobile Number. In the 560px
            card each box is still 230px wide, enough for "01786 120356" */}
        <div class="grid gap-6 md:grid-cols-2 md:gap-4">
          {fields.map((field) => {
            const id = `track-${field.name}`;
            const error = errorText(field.name);
            return (
              <div class="flex flex-col gap-3">
                <label for={id} class="trim-text font-semibold">
                  {field.label}
                </label>
                {/* The checkout's input (CLAUDE.md → Checkout card). The value is what the
                    shopper typed, put back as it was (server/track.ts), never the schema's */}
                <input
                  id={id}
                  name={field.name}
                  value={values[field.name]}
                  placeholder={field.placeholder}
                  {...field.attributes}
                  autofocus={field.name === firstError}
                  aria-invalid={error === null ? undefined : 'true'}
                  aria-describedby={error === null ? undefined : `${id}-error`}
                  class="h-12 w-full min-w-0 rounded-lg border border-field bg-card px-4 transition-colors duration-150 placeholder:text-muted hover:border-muted-line focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand aria-invalid:border-promo"
                />
                {error !== null && (
                  <p
                    id={`${id}-error`}
                    class="flex items-start gap-1.5 text-sf-small font-medium text-promo"
                  >
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={16}
                      strokeWidth={1.5}
                      className="mt-1 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{error}</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="submit"
          class="h-16 w-full rounded-sm bg-accent text-[18px] font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent"
        >
          {t('shop.track.submit')}
        </button>
      </form>
    )}
  </PageCard>
</ShopLayout>
```

- **One page for GET and POST.** Astro hands every method to a page that is made per request, so
  `Astro.request.method` tells the form from its answer. Any other method draws the empty form.
- **`answerTrackForm()`** is 26e.2's helper, with `Astro.clientAddress` as the address. On staging that is the
  visitor's real address only because of 26e.2's `security.allowedDomains` and the Caddy header.
- **429 for "too many tries"** (decision 25), with its `statusText` for the same reason as the tracking link's 404
  (`HTTP/1.1 429 Too Many Requests`, not `429 OK`). A browser draws the page whatever the status.
- **`Cache-Control: no-store` on every answer**, the GET included: the POST's answer has an order or a phone in it,
  and a page whose GET and POST share one address is simplest when neither is kept.
- **`values`** are what the shopper typed, from the answer, or empty for a GET and after a match. They go back into
  the boxes as they were typed ("w 000123"), never as the schema made them.
- **`refusal`** is the sentence above the form. `shop_track_too_many` needs `minutes`; the helper always sends it for
  that code, and `?? 15` (the whole window) is only there because the type says `params` may be missing.
  `` t(`errors.${answer.code}`) `` type-checks because `TrackRefusal` is three error codes, and `errors.*` has a word for
  every code.
- **`fields`** describes the two boxes, so their markup is written once. `as const` keeps each `name` a key of
  `TrackFormValues`, so `values[field.name]` and `fieldErrors[field.name]` are checked. The phone box is `type="tel"`
  (the phone keyboard, and the browser offers the shopper's own number); the order number box has no spell check,
  no autofill and capitals on a phone keyboard. Each box shows its first error only: one thing to fix at a time, like
  the checkout.
- **The focus, with no script** (decision 25). The first box with an error has `autofocus`. A refusal is about both
  boxes, so it sits above them and takes the focus itself (`tabindex="-1"` makes a `<p>` focusable, and `autofocus`
  works on any focusable element). A screen reader then reads it first; `role="alert"` alone does not speak for text
  that was already in the page when it loaded.
- **The test line** comes from `shopSource.testTracking` (decision 18), only in the mock. Each demo order has its
  number, its phone written the way people read it (`spacedPhone`, 26c) and its link.
- **The card is 560px for the form and 848px for an answer**, the verify page's width for a short form and the
  checkout's for the tracking view.
- **`novalidate`**: the browser's own error bubbles would be in the browser's language, not the shop's. The server
  checks the boxes anyway, so the form works the same without a script.

### `apps/shop/src/pages/pages/[slug].astro`

```
---
import { formatDate } from '@omnivo/i18n';

import PageCard from '../../components/PageCard.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';
import { dayInShop, isTextPageSlug } from '../../lib/text-page';

// Step 26e: the footer's four pages (decision 5; CLAUDE.md → Text pages): the checkout card at
// 848px, the title in its header, the tenant's HTML in the description's prose style.
const slug = Astro.params.slug;
// Any other slug, or a page the tenant has not written: "page not found" with the 404 status, so a
// search engine drops an old link (decision 15). The guard also narrows the slug to the four
const page = isTextPageSlug(slug) ? await shopSource.textPage(slug) : null;
if (page === null) return Astro.rewrite('/404');

const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
const locale = await shopLocale(shop.language);
const { t } = locale;

// The title is the footer's own word for the page (decision 15), so the link and the page it
// opens always say the same. The footer's keys are the four slugs, so a fifth slug added to
// SHOP_TEXT_PAGES without its footer word fails the type check here
const title = t(`shop.footer.${page.slug}`);

const updated =
  page.updatedAt === null
    ? null
    : t('shop.pages.updatedOn', {
        date: formatDate(dayInShop(page.updatedAt, shop.timeZone), locale.language),
      });
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.pages.pageTitle', { title, shop: shop.name })}
  categories={categories}
>
  <PageCard title={title} note={updated}>
    {/* set:html: the tenant's HTML, cleaned by the ERP when it was saved (26e.1), never a
        shopper's. Its sections sit in the card's 4px frame, 8px apart, like the product page's
        description sections in their card */}
    <div class="shop-prose mt-1" set:html={page.html} />
  </PageCard>
</ShopLayout>
```

- **An unknown slug and a page the tenant has not written** both answer `Astro.rewrite('/404')`, like an unknown
  product: the shop's "page not found" with the 404 status. `isTextPageSlug()` also narrows the slug, so
  `textPage(slug)` compiles with no cast.
- **The title is `` t(`shop.footer.${page.slug}`) ``** (decision 15). The footer's keys are the four slugs, so a fifth
  slug added to `SHOP_TEXT_PAGES` without its footer word fails the type check here.
- **"Last updated"** uses `dayInShop()` (decision 27), and is left out when the date is not known (the mock's About
  page).
- **`set:html`** draws the tenant's HTML as it is. That is safe only because the ERP cleans it when it is saved
  (26e.1): it is never a shopper's text. The prose style is 26b's `shop-prose`, so the sections alternate canvas and
  cream like the product page's description, inside the card's 4px frame.

### `apps/shop/src/pages/404.astro`

```
---
import { FileNotFoundIcon } from '@hugeicons/core-free-icons';

import EmptyState from '../components/EmptyState.astro';
import { shopSource } from '../data/source';
import ShopLayout from '../layouts/ShopLayout.astro';
import { shopLocale } from '../lib/locale';

// Step 26e: every address the shop has no page for (decision 6). Astro draws this page for an
// address no route matches, and for every page that answers Astro.rewrite('/404') (an unknown
// product, category, order or text page). It is the shop's own page, with the header, so a shopper
// who followed an old link can search or open a category from here. Made per request like every
// page (astro.config.ts), because it needs the shop of the request's domain. Astro answers it
// with the 404 status in both cases, so a search engine drops the old address.
const [shop, categories] = await Promise.all([shopSource.shop(), shopSource.categories()]);
const locale = await shopLocale(shop.language);
const { t } = locale;
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.notFound.pageTitle', { shop: shop.name })}
  categories={categories}
>
  {/* The checkout card's distance from the header and to the footer */}
  <div class="mt-4 md:mt-9 md:mb-40">
    <EmptyState
      icon={FileNotFoundIcon}
      level="h1"
      title={t('shop.notFound.title')}
      text={t('shop.notFound.text')}
      action={{ href: '/', label: t('shop.notFound.action') }}
    />
  </div>
</ShopLayout>
```

Astro draws this page for an address no route matches, and for every `Astro.rewrite('/404')` (an unknown product,
category, order or text page). Until now those got Astro's own plain 404 page. It is made per request like every page,
because it needs the shop of the request's domain, and it has the header, so a shopper who followed an old link can
search or open a category from here. Astro answers both cases with the 404 status by itself: a first version also
set `Astro.response.status = 404`, and a built server answered 404 for `/nope`, `/p/nope` and `/pages/refunds`
without that line, so it was taken out.

### `apps/shop/src/components/EmptyState.astro` and `Footer.astro`

```diff
@@ -3,8 +3,8 @@ import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
 
 // CLAUDE.md → Storefront screens not in Figma → Empty state: a card with a round cream tile, a
 // title, a line that says what to do, and an optional button. Step 26d.3 uses it for a list with
-// no cards; 26e for "page not found" and a closed shop. The cart drawer draws its own copy without
-// the card, because the drawer is the card
+// no cards; 26e for "page not found" and a broken tracking link. The cart drawer draws its own
+// copy without the card, because the drawer is the card
 interface Props {
   icon: IconSvgElement;
   title: string;
```

```diff
@@ -31,7 +31,7 @@ const social = [
   { url: shop.social.linkedin, icon: Linkedin01Icon, label: t('shop.footer.linkedin') },
 ].flatMap((network) => (network.url === null ? [] : [{ ...network, url: network.url }]));
 
-// Step 26c builds these pages
+// Step 26e builds these pages (pages/pages/[slug].astro)
 const pages = [
   { href: '/pages/privacy', label: t('shop.footer.privacy') },
   { href: '/pages/terms', label: t('shop.footer.terms') },
```

Comments only. The empty state is no longer for a closed shop (decision 7), and the footer's pages are built in 26e,
not 26c.

### `apps/shop/src/boundaries.spec.ts`

```diff
@@ -50,20 +50,22 @@ describe('shop imports', () => {
     expect(offenders).toEqual([]);
   });
 
-  it('reaches src/server only from the API routes, and the cookies from the pages', () => {
+  it('reaches src/server only from the API routes, the cookies and the track form from pages', () => {
     // Step 26b: server/ is request handling (Response objects, the contracts, Zod). A component
     // that imported it could pull it into a <script> and ship Zod to every shopper's browser.
     // Step 26c: a page's frontmatter runs only on the server, and /checkout/verify and
     // /order/<no> read the order cookies. They may import server/cookies.ts, which imports
-    // nothing, and only that
+    // nothing, and only that.
+    // Step 26e: /track answers its own form's POST (26e.2's server/track.ts), so that one page
+    // may import that one module, like an API route. Named page by page, not "any page": a page
+    // has <script>s too, and the rule should stay as narrow as what needs it
+    const pageMay = (path: string, name: string) =>
+      (path.startsWith('./pages/') && name.endsWith('/server/cookies')) ||
+      (path === './pages/track.astro' && name.endsWith('/server/track'));
     const offenders = Object.entries(files)
       .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
       .filter(([path, source]) =>
-        importsOf(source).some(
-          (name) =>
-            /(^|\/)server\//.test(name) &&
-            !(path.startsWith('./pages/') && name.endsWith('/server/cookies')),
-        ),
+        importsOf(source).some((name) => /(^|\/)server\//.test(name) && !pageMay(path, name)),
       )
       .map(([path]) => path);
     expect(offenders).toEqual([]);
```

26c's rule let a page import only `server/cookies.ts` from `src/server`. The `/track` page answers its own form, so
it imports `server/track.ts`, like an API route would. `pageMay()` allows that one page that one module (decision
28), and every other page and component still fails the test if it reaches into `src/server`.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop/src packages/i18n/src/locales/shop
pnpm exec prettier --check apps/shop/src packages/i18n/src/locales/shop
pnpm --filter @omnivo/shop build
```

The i18n build comes first because the shop reads the words from the package's `dist/`. The shop has 200 unit tests
after this part (10 new).

Then try it on the built server (`HOST=127.0.0.1 PORT=4399 pnpm --filter @omnivo/shop start`):

- `/track` shows the test line with the three demo orders. Type `01786 120356` and `w 000123`: the tracking view of
  W-000123 (Steadfast, on hold, "Keep ৳578 ready in cash for the rider"). Type `0178` and `SO-1`: both boxes say what
  to fix, the focus is in the phone box, and what you typed is still there.
- Ten wrong pairs, then the right one: "Too many tries. Wait 15 minutes" and status 429.
- `/t/MGhXyBcrs_PytWRCRPw-6w` is W-000121: paid online, delivered, the Pathao parcel first and the cancelled RedX
  booking under "Earlier parcel". `curl -I` shows `no-store`, `noindex` and `no-referrer`.
- A link with a character changed, or cut short, answers 404 with "This tracking link does not work".
- `/pages/terms` has "Last updated 1 Nov 2026" and the delivery charges from the checkout's settings; `/pages/about`
  has no date; `/pages/refunds` and `/pages/Terms` answer 404 with the shop's own "Page not found", as do `/nope`,
  `/p/nope` and an order page that is not this browser's.
- At 390px nothing scrolls sideways.

All of this was seen on a built server at 1440px and 390px while this part was written; 26e.4 makes it Playwright
tests.

Broken on purpose while this part was written, each caught (script `.guide/work/break-26e3.py` in the clone):

- `parcelViews()` without `toReversed()` → "puts the newest parcel and the newest event first" fails;
- `delivered` taken out of `PARCEL_ENDS` → "marks where the parcel is now, until its way ends" fails;
- every Cash on Delivery order says `payOnDelivery` → "says nothing about cash once there is nothing left to pay"
  fails;
- `dayInShop()` returns `new Date(iso)` → "writes the shop's day, not the server's" fails;
- `isTextPageSlug()` lower-cases the slug → "knows the footer pages and nothing else" fails;
- `404.astro` imports `server/track.ts` → the boundary test fails.

## 26e.4 — `apps/shop/e2e`: the first Playwright tests, and CI

The shop has had unit tests since 26a, but no test in a browser. This part adds them in `apps/shop/e2e/`, on the built
server with the mock source, in Chromium at 1440px and 390px (decision 8), and gives them their own CI step. Writing
them found one bug in 26c's checkout, fixed here (decision 34).

### `apps/shop/package.json`

```diff
@@ -8,8 +8,9 @@
     "build": "astro check && astro build",
     "preview": "astro preview --port 4321",
     "start": "node dist/server/entry.mjs",
-    "typecheck": "astro check",
-    "test": "vitest run --passWithNoTests"
+    "typecheck": "astro check && tsc --noEmit -p e2e",
+    "test": "vitest run --passWithNoTests",
+    "test:e2e": "playwright test --config e2e/playwright.config.ts"
   },
   "dependencies": {
     "@astrojs/node": "~11.1.11",
@@ -32,7 +33,9 @@
   "devDependencies": {
     "@astrojs/check": "^0.9.12",
     "@omnivo/config": "workspace:*",
+    "@playwright/test": "^1.63.0",
     "@tailwindcss/vite": "^4.3.3",
+    "@types/node": "^26.6.2",
     "@types/react": "^19.3.0",
     "@types/react-dom": "^19.3.0",
     "tailwindcss": "^4.3.3",
```

- **`@playwright/test` at `^1.63.0`**, the same range as `apps/app`. The lockfile then has one Playwright for both
  apps, so CI's one browser download serves both (see `ci.yml` below), and `pnpm dedupe --check` stays clean.
- **`@types/node`**, because the test files read `process.env` and use `node:crypto`. The shop's own code runs in
  Astro and the browser and did not need it.
- **`typecheck` also runs `tsc --noEmit -p e2e`.** `astro check` reads `apps/shop/tsconfig.json`, which covers only
  `src/`, so without this the test files would never be type-checked: with a type error put in `e2e/helpers.ts`,
  `astro check` alone still passed, and `pnpm typecheck` failed.
- **`test:e2e`** has the same name as the app's script, so turbo's `pnpm test:e2e` finds it, and CI calls it by
  name.

### `apps/shop/e2e/tsconfig.json`

```json
{
  "extends": "../../../packages/config/tsconfig/base.json",
  "compilerOptions": {
    "module": "nodenext",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["*.ts"]
}
```

A copy of `apps/app/e2e/tsconfig.json`. The tests run in Node, not in Vite or Astro, so `module: nodenext` (imports
between the test files say `./helpers.js`, as Node needs), `types: ["node"]`, and `DOM` in `lib` for the code that
runs inside the page (`page.evaluate(() => document…)`). ESLint's type-aware rules find this file by itself, so
`pnpm lint` checks the tests with no change to `eslint.config.js`.

### `apps/shop/e2e/playwright.config.ts`

```ts
import { defineConfig, devices } from '@playwright/test';

// Step 26e: the storefront's own Playwright tests, on the built server (decision 8). Its own port:
// the shop's `pnpm dev` (4321) and the ERP app's tests (4173, 4174) can run at the same time.
const PORT = 4331;

export default defineConfig({
  testDir: '.',
  // *.e2e.ts, like the ERP app: vitest picks up *.spec.ts, and these files are not vitest tests
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  // A test.only left in by mistake would quietly make the CI run small
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    // On a failure, the whole record (DOM, network, screenshots): `pnpm exec playwright show-trace`
    trace: 'retain-on-failure',
  },
  // The two widths the storefront is drawn for (CLAUDE.md → Storefront shape and layout): Figma's
  // 1440px desktop, and a 390px phone, below `md`, where the phone layout applies
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  // The built server, as staging runs it (`node dist/server/entry.mjs`), not `astro dev`: the
  // cookies are Secure only in a build (src/server/cookies.ts), and `astro dev` adds its own
  // toolbar and scripts to every page. `astro build` without `astro check`: the type check is its
  // own CI step. The mock source answers, so no API, database or Docker is needed
  webServer: {
    command: 'pnpm exec astro build && node dist/server/entry.mjs',
    cwd: '..',
    env: { HOST: '127.0.0.1', PORT: String(PORT) },
    url: `http://127.0.0.1:${String(PORT)}`,
    // Room for the build on a slow CI runner: it takes a few seconds on a laptop
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
```

- **`testMatch: '*.e2e.ts'`**, like the app. The shop's vitest reads only `src/**/*.spec.ts`, and Playwright's files
  must never be picked up by it, or `pnpm test` would try to run them.
- **`forbidOnly` and one retry on CI**, the app's rules: a `test.only` left in would quietly shrink the CI run, and
  one retry tells a slow runner from a real failure (a retried test shows as "flaky" in the summary).
- **Two projects, `desktop` at 1440×900 and `phone` at 390×844.** 1440px is Figma's desktop frame, and 390px is
  below `md`, where the phone layout applies. The phone project uses Playwright's Pixel 7 (touch, a phone's user
  agent) with the width set to 390px.
- **`webServer` builds, then starts the built server.** It is what staging runs, so the tests see the real cookies:
  `src/server/cookies.ts` makes them `Secure` only in a build. Chromium keeps `Secure` cookies on `127.0.0.1` over
  plain http, so the phone code and the order page work in the tests as on https. `astro build` runs without
  `astro check`, because the type check is its own CI step and would only make the tests wait.
- **`HOST: '127.0.0.1'`** makes the server listen on that address only, and `baseURL` and `url` use the same
  address. With `localhost`, a machine that tries IPv6 first would knock on `::1`, where nothing listens.
- **`timeout: 180_000`**: the build takes a few seconds on a laptop, but Playwright's default (60 seconds) is too
  close for a cold CI runner.
- **`reuseExistingServer` off on CI.** CI always builds the code it tests. Locally, a server you started yourself on
  4331 is reused, so stop it after a code change, or the tests run against the old build.

### `apps/shop/e2e/helpers.ts`

```ts
import { randomBytes } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

// The storefront's rule for every width: the page never scrolls sideways (CLAUDE.md → Storefront
// shape and layout). A box that is too wide shows up here as the page being wider than the screen.
export async function expectNoSideScroll(page: Page): Promise<void> {
  const extra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(extra, 'the page is wider than the screen').toBe(0);
}

// A visitor of its own for one test. The /track form's limit (26e.2) counts misses per address,
// and every test reaches one server, so tests that miss on purpose would use up each other's tries
// if they all came from 127.0.0.1. The server reads X-Forwarded-For (astro.config.ts → security),
// as it would from Caddy. IPv6 in the documentation block 2001:db8::/32, with a random /64: the
// limit counts a whole /64 as one visitor, and 32 random bits mean two tests (or a rerun against
// a server still running, which keeps its counts for 15 minutes) never meet
export function newVisitor(): Record<string, string> {
  const [a, b] = [randomBytes(2).toString('hex'), randomBytes(2).toString('hex')];
  return { 'X-Forwarded-For': `2001:db8:${a}:${b}::1` };
}
```

- **`expectNoSideScroll()`** checks the storefront's rule that the page never scrolls sideways (CLAUDE.md →
  Storefront shape and layout). `scrollWidth` larger than `clientWidth` means something is wider than the screen; at
  390px that is the usual way a layout breaks. The message names the rule, so a failure reads as what it is.
- **`newVisitor()`** gives a test its own address for the `/track` form's limit (decision 32). The server trusts
  `X-Forwarded-For` (26e.2's `astro.config.ts`), as it would trust Caddy's. The address is in `2001:db8::/32`, the
  block kept for documentation, so it can never be someone's real address, and its `/64` is random: the limit counts
  a whole `/64` as one visitor (decision 20), so the random part must be inside the first 64 bits. 32 random bits
  mean two tests never meet, even in a rerun against a server that still remembers the last run's misses for 15
  minutes.

### `apps/shop/e2e/tracking.e2e.ts`

```ts
import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll, newVisitor } from './helpers.js';

// Step 26e: the tracking link (/t/<token>) and the /track form. The orders are the mock's three
// demo orders, whose links never change (src/data/mock/demo-orders.ts, decision 18)
const DELIVERED = { orderNo: 'W-000121', phone: '01711284519', token: 'MGhXyBcrs_PytWRCRPw-6w' };
const ON_HOLD = { orderNo: 'W-000123', phone: '01786120356', token: 'C2etI9zQb8E5ZugpwzVWyA' };

test.describe('a tracking link', () => {
  test('shows the order, then its parcels newest first, and names no one', async ({ page }) => {
    const response = await page.goto(`/t/${DELIVERED.token}`);
    expect(response?.status()).toBe(200);
    // The token is in the address (decision 24)
    expect(response?.headers()).toMatchObject({
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'referrer-policy': 'no-referrer',
    });
    await expect(page).toHaveTitle(`Order ${DELIVERED.orderNo} | Omnivo`);

    const main = page.getByRole('main');
    await expect(main).toContainText(DELIVERED.orderNo);
    await expect(main).toContainText('Paid with Mobile Banking.');
    // The order's road reads top to bottom, oldest first; a parcel's events newest first
    // (decision 23), and the parcel that delivered comes before the cancelled booking
    const timeline = page.getByRole('list', { name: 'Order status' }).getByRole('listitem');
    await expect(timeline.first()).toContainText('Order placed');
    await expect(timeline.last()).toContainText('Delivered');
    const parcel = page.getByRole('region', { name: 'Parcel', exact: true });
    await expect(parcel).toContainText('Pathao · DH0811259QKP7');
    await expect(parcel.getByRole('listitem').first()).toContainText('Delivered');
    await expect(parcel.getByRole('listitem').last()).toContainText('Booked with the courier');
    const earlier = page.getByRole('region', { name: 'Earlier parcel' });
    await expect(earlier).toContainText('RedX · RX2611080317');
    await expect(earlier.getByRole('listitem').first()).toContainText('Cancelled by merchant');

    // A link gets forwarded (decision 12): the page has the order's phone and the buyer's name
    // nowhere, in either way they are written
    await expect(main).not.toContainText('01711');
    await expect(main).not.toContainText('Nusrat');
    await expectNoSideScroll(page);
  });

  test('says what the cash is for and links to the courier without the address', async ({
    page,
  }) => {
    await page.goto(`/t/${ON_HOLD.token}`);
    const main = page.getByRole('main');
    await expect(main).toContainText('Keep ৳578 ready in cash for the rider.');
    const parcel = page.getByRole('region', { name: 'Parcel', exact: true });
    // The courier's own note, as it came (decision 11)
    await expect(parcel.getByRole('listitem').first()).toContainText(
      'Could not deliver: they will try again',
    );
    await expect(parcel.getByRole('listitem').first()).toContainText('Customer not reachable');
    const courier = page.getByRole('link', { name: 'See it on the Steadfast site' });
    await expect(courier).toHaveAttribute('href', 'https://steadfast.com.bd/t/SFR2611120042');
    await expect(courier).toHaveAttribute('rel', /\bnoreferrer\b/);
  });

  test('a broken link says so with status 404 and leads to the form', async ({ page }) => {
    // Cut short (the wrong shape, answered before the source) and one character changed (the
    // right shape, but no order has it): the same page for both (decision 16)
    for (const token of [DELIVERED.token.slice(0, -1), `${DELIVERED.token.slice(0, -1)}x`]) {
      const response = await page.goto(`/t/${token}`);
      expect(response?.status()).toBe(404);
      // Not "404 OK": the page sets the status text as well (26e.6)
      expect(response?.statusText()).toBe('Not Found');
      await expect(
        page.getByRole('heading', { level: 1, name: 'This tracking link does not work' }),
      ).toBeVisible();
    }
    await page.getByRole('link', { name: 'Track with the number' }).click();
    await expect(page).toHaveURL('/track');
  });
});

test.describe('the /track form', () => {
  // Each test is its own visitor, so the limit test's misses stop no one else (helpers.ts)
  test.beforeEach(async ({ context }) => {
    await context.setExtraHTTPHeaders(newVisitor());
  });

  async function track(page: Page, phone: string, orderNo: string): Promise<number | undefined> {
    await page.getByRole('textbox', { name: 'Mobile Number' }).fill(phone);
    await page.getByRole('textbox', { name: 'Order Number' }).fill(orderNo);
    // The form POSTs to /track and the page draws the answer: its status tells "not found" from
    // "too many" for the limit test
    const answer = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/track'),
    );
    await page.getByRole('button', { name: 'Track Order' }).click();
    const status = (await answer).status();
    await page.waitForLoadState();
    return status;
  }

  test('finds an order however its number is typed, and keeps the phone out of the address', async ({
    page,
  }) => {
    await page.goto('/track');
    // A space in the phone, lower case and no dash in the number (decision 10)
    expect(await track(page, '01786 120356', 'w 000123')).toBe(200);
    const main = page.getByRole('main');
    await expect(main).toContainText(ON_HOLD.orderNo);
    await expect(main).toContainText('Keep ৳578 ready in cash for the rider.');
    await expect(page).toHaveURL('/track');
    await expect(page).toHaveTitle(`Order ${ON_HOLD.orderNo} | Omnivo`);
    await expectNoSideScroll(page);

    await page.getByRole('link', { name: 'Track another order' }).click();
    await expect(page.getByRole('textbox', { name: 'Mobile Number' })).toHaveValue('');
  });

  test('says what to fix in each box and keeps what was typed', async ({ page }) => {
    await page.goto('/track');
    expect(await track(page, '0178', 'SO-1')).toBe(200);
    const phone = page.getByRole('textbox', { name: 'Mobile Number' });
    const orderNo = page.getByRole('textbox', { name: 'Order Number' });
    await expect(phone).toHaveAccessibleDescription(
      'Type a Bangladeshi mobile number, like 01786 120356.',
    );
    await expect(orderNo).toHaveAccessibleDescription(
      'Type the order number from the SMS, like W-000123.',
    );
    // The first box to fix has the focus, and nothing typed is lost
    await expect(phone).toBeFocused();
    await expect(phone).toHaveValue('0178');
    await expect(orderNo).toHaveValue('SO-1');
  });

  test('stops a visitor after ten misses, and only that visitor', async ({ page, context }) => {
    await page.goto('/track');
    for (let miss = 1; miss <= 10; miss += 1) {
      expect(await track(page, ON_HOLD.phone, 'W-000999')).toBe(200);
      await expect(page.getByRole('alert')).toHaveText(
        'No order has this number and mobile number. Check both, then try again.',
      );
    }
    // Now even the right pair waits: a guesser cannot tell a hit from a miss any more
    expect(await track(page, ON_HOLD.phone, ON_HOLD.orderNo)).toBe(429);
    await expect(page.getByRole('alert')).toHaveText(
      'Too many tries. Wait 15 minutes, then try again.',
    );
    // The refusal took the focus, so a screen reader reads it first
    await expect(page.getByRole('alert')).toBeFocused();

    // Someone else on the same server is not stopped
    await context.setExtraHTTPHeaders(newVisitor());
    expect(await track(page, ON_HOLD.phone, ON_HOLD.orderNo)).toBe(200);
    await expect(page.getByRole('main')).toContainText('Keep ৳578 ready in cash for the rider.');
  });

  test('offers the test shop’s demo orders and their links', async ({ page }) => {
    await page.goto('/track');
    await expect(
      page.getByText('Test shop: no SMS is sent. Try one of these orders.'),
    ).toBeVisible();
    await page.getByRole('link', { name: `Tracking link of ${DELIVERED.orderNo}` }).click();
    await expect(page).toHaveURL(`/t/${DELIVERED.token}`);
    await expect(page.getByRole('main')).toContainText('Paid with Mobile Banking.');
  });
});
```

The orders are 26e.2's three demo orders, whose numbers, phones and links never change, so the tests can name them.

- **The link test reads the response's headers** (decision 24) and the page's structure: the order's timeline
  oldest first, the parcel's events newest first, the delivered Pathao parcel before the cancelled RedX booking
  (decision 23). The lists are found by their accessible names (their headings, through `aria-labelledby`), which
  is how a screen reader finds them too. `exact: true` on "Parcel", because "Earlier parcel" also contains the word.
- **"names no one"** looks for the order's phone (`01711`, its start, with or without the space the shop writes)
  and the buyer's name on the page. The contract test proves the schema drops them (26e.1); this proves no page adds them
  back from somewhere else.
- **The courier's link** must keep `rel="noreferrer"`: the header covers it today, and the attribute keeps it safe if
  the header is ever dropped. The regular expression allows other words next to it (`noopener noreferrer`).
- **The broken link** is tried both ways: cut short (the wrong shape, answered before the source is asked) and one
  character changed (the right shape, but no order has it). Both must say the same thing with status 404 (decision
  16), and the status text "Not Found" (26e.6 found `404 OK`).
- **`track()`** fills the two boxes, waits for the POST's answer and returns its status. `waitForResponse` is set up
  before the click, or a fast answer could come before the test listens for it. The status is how the limit test
  tells "not found" (200, the page with an error) from "too many" (429).
- **"however its number is typed"** types `01786 120356` and `w 000123` (decision 10) and checks that the address is
  still `/track`: the phone went in the POST's body, never in the URL.
- **"what to fix"** reads each error as the box's accessible description (`aria-describedby`), so it checks that the
  error is tied to its box, not only that the text is somewhere on the page.
- **"ten misses"** sends ten wrong pairs, then the right one: 429 and the refusal, with the focus on it. Then a new
  visitor finds the order at once. That last check is the one that fails without 26e.2's `allowedDomains`: without
  it, the server ignores `X-Forwarded-For`, every test is 127.0.0.1, and the second visitor is stopped too.
- **The demo line** is the only place a tester gets a link in the mock (decision 18), so a test follows one.

### `apps/shop/e2e/pages.e2e.ts`

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 26e: the footer's four text pages (/pages/<slug>) and "page not found" (404.astro)

test('every footer link opens its page, under the footer’s own word', async ({ page }) => {
  // The title is the footer's word (decision 15), so the link and the page always say the same
  const pages = [
    { link: 'Privacy Policy', path: '/pages/privacy' },
    { link: 'Terms & Condition', path: '/pages/terms' },
    { link: 'About Us', path: '/pages/about' },
    { link: 'Contact Us', path: '/pages/contact' },
  ];
  for (const { link, path } of pages) {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Shop pages' })
      .getByRole('link', { name: link })
      .click();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole('heading', { level: 1, name: link })).toBeVisible();
    await expect(page).toHaveTitle(`${link} | Omnivo`);
    await expectNoSideScroll(page);
  }
});

test('a page says when it was last updated, and only when that is known', async ({ page }) => {
  await page.goto('/pages/terms');
  await expect(page.getByText('Last updated 1 Nov 2026')).toBeVisible();
  // The delivery charges come from the checkout's own settings, so the terms cannot disagree
  await expect(page.getByRole('main')).toContainText('2 to 4 days, ৳120.');
  // The mock's About page has no date
  await page.goto('/pages/about');
  await expect(page.getByText(/^Last updated/)).toHaveCount(0);
});

test('an address the shop has no page for gets the shop’s own 404', async ({ page }) => {
  // No route, a product that is not sold, a text page that is not one of the four (case counts),
  // and an order page opened by a browser that did not place the order (26c)
  for (const path of ['/nope', '/p/nope', '/pages/refunds', '/pages/Terms', '/order/W-000121']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page).toHaveTitle('Page not found | Omnivo');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  }
  // The full layout: the header is there to search or open a category from
  await expect(page.getByRole('banner')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(page).toHaveURL('/');
});
```

- **The footer test** clicks each footer link from the home page and checks the page's `h1` and the tab's title
  against the link's own words (decision 15). Clicking (not `goto`) also checks that the footer links to the right
  addresses.
- **"Last updated"** is on the terms and not on the mock's About page, which has no date. `toHaveCount(0)` says "not
  there at all", which `not.toBeVisible()` would not (a hidden copy would pass it). The terms also show the checkout's
  ৳120 for outside Dhaka, from the same settings.
- **The 404 list** has one address for each way to reach "page not found": no route, a product that is not sold, a
  slug that is not one of the four, a slug in the wrong case, and an order page opened by a browser that did not
  place the order (26c). Each must answer 404 with the shop's own page and title. `expect(…, path)` puts the address
  in the failure message, so a failure says which one.

### `apps/shop/e2e/shopping.e2e.ts`

```ts
import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll, newVisitor } from './helpers.js';

// Steps 26b–26c, walked once in a real browser: a product into the cart, the cart drawer, the
// checkout, the phone code, "Order Confirmed" and the order page. Step 26e adds the end: the order
// just placed can be tracked with the /track form. The unit tests check each piece (the quote,
// the order book, the cookies); this checks that the pages hand over to each other

const SHAMPOO = {
  slug: 'himalaya-anti-dandruff-shampoo-180ml',
  name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
};

// The checkout's form is inert until its island runs (26e.4's fix in CheckoutForm.tsx), so a
// shopper's keys do nothing before then. Playwright's fill() is not a key press: it writes the
// value into the box even while the form is inert, and react-hook-form then wipes it as it starts.
// So the tests wait for the island first, as a shopper's keys would
async function waitForCheckout(page: Page): Promise<void> {
  await expect(page.getByRole('main').locator('form')).not.toHaveAttribute('inert');
}

async function fillDetails(page: Page): Promise<void> {
  await waitForCheckout(page);
  await page.getByRole('textbox', { name: 'Full Name' }).fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await page.getByRole('textbox', { name: 'Delivery Address' }).fill('House 12, Road 5, Dhanmondi');
  await page.getByRole('radio', { name: 'Inside Dhaka — ৳80' }).check();
  // The box is sr-only under its icon (CLAUDE.md → Checkout lines), so a click on it is a click on
  // the icon, which Playwright refuses. Space is how a keyboard user ticks it
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
}

test('a Cash on Delivery order, from the product page to tracking it', async ({
  page,
  context,
}) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByRole('button', { name: 'Cart, 1 item' }).click();

  // The drawer: the server's prices (26b), a stepper that changes the line at once
  const drawer = page.getByRole('dialog', { name: 'Your Cart' });
  await expect(drawer).toContainText('Subtotal৳229');
  await drawer.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(drawer.getByRole('textbox', { name: `How many ${SHAMPOO.name}` })).toHaveValue('2');
  await expect(drawer).toContainText('Subtotal৳458');
  await drawer.getByRole('link', { name: 'Checkout' }).click();

  await expect(page).toHaveURL('/checkout');
  await fillDetails(page);
  const main = page.getByRole('main');
  await expect(main).toContainText('Delivery Charge৳80');
  await expect(main).toContainText('Total৳538');
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Confirm Order' }).click();

  // Cash on Delivery asks for the phone's code (26c). The test shop prints it
  await expect(page).toHaveURL('/checkout/verify');
  await expect(main).toContainText('We sent a 6-digit code to +880 17•• ••• 356');
  const testLine = await page
    .getByText(/^Test shop: no SMS is sent\. The code is \d{6}\.$/)
    .textContent();
  const code = /\d{6}/.exec(testLine ?? '')?.[0] ?? '';
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Confirm Order' }).click();

  const confirmed = page.getByRole('dialog', { name: 'Order Confirmed' });
  await expect(confirmed).toContainText('We’ll send updates by SMS to 01786 120356.');
  // The safe way on has the focus, and the cart is empty already
  await expect(confirmed.getByRole('link', { name: 'Continue shopping' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Cart, empty' })).toBeAttached();

  const details = confirmed.getByRole('link', { name: 'View Order Details' });
  const orderNo = /W-\d{6}$/.exec((await details.getAttribute('href')) ?? '')?.[0] ?? '';
  expect(orderNo).not.toBe('');
  await details.click();
  await expect(page).toHaveURL(`/order/${orderNo}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Order Details' })).toBeVisible();
  await expect(main).toContainText(orderNo);
  await expect(main).toContainText('2 × ৳229');

  // The mock sends no SMS and gives a new order no link (decision 18), so the form finds it
  await context.setExtraHTTPHeaders(newVisitor());
  await page.goto('/track');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await page.getByRole('textbox', { name: 'Order Number' }).fill(orderNo);
  await page.getByRole('button', { name: 'Track Order' }).click();
  await expect(main).toContainText(orderNo);
  await expect(main).toContainText('Keep ৳538 ready in cash for the rider.');
  await expect(main).toContainText(
    'The shop has not handed the parcel to a courier yet. Its way shows here once it has.',
  );
});

test('the checkout waits for the minimum order and for the terms', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await fillDetails(page);
  const confirm = page.getByRole('button', { name: 'Confirm Order' });
  // ৳229 is under the mock shop's ৳300 (26c). The button is also disabled while a quote loads, so
  // the check waits for the quote with the delivery charge first: else it would pass during that
  // load even if the minimum did not count
  await expect(page.getByRole('main')).toContainText('Total৳309');
  await expect(page.getByText('Orders start at ৳300. Add ৳71 more to order.')).toBeVisible();
  await expect(confirm).toBeDisabled();
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(confirm).toBeEnabled();
  // fillDetails() ticked the terms; without them the button waits again
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
  await expect(confirm).toBeDisabled();
});

test('Mobile Banking needs no phone code in the test shop', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await fillDetails(page);
  await page.getByText('Mobile Banking', { exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  // Straight to the dialog, over the checkout page: the mock asks no code for Mobile Banking
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();
  await expect(page).toHaveURL('/checkout');
});

test('nothing typed into the checkout before its script runs is lost', async ({ page }) => {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  // A slow phone: the shop's scripts arrive only when the test lets them. The server's HTML is on
  // screen meanwhile, with every box drawn
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/_astro/*.js', async (route) => {
    await held;
    await route.continue();
  });
  // 'commit': module scripts hold DOMContentLoaded back, and they are the ones being held
  await page.goto('/checkout', { waitUntil: 'commit' });
  const box = page.locator('input[name="name"]');
  await expect(box).toBeAttached();
  // The form is inert until the island runs (26e.4's fix in CheckoutForm.tsx): a tap does not
  // focus the box and a key types nothing. Before the fix, this name was typed, then wiped
  await box.click({ force: true });
  await page.keyboard.type('Nusrat');
  await expect(box).toHaveValue('');

  release();
  // Once the island runs, what the shopper types stays
  await waitForCheckout(page);
  const name = page.getByRole('textbox', { name: 'Full Name' });
  await name.fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
  await expect(name).toHaveValue('Nusrat Jahan');
});
```

- **`waitForCheckout()`** waits until the checkout's form is no longer `inert` (decision 34). Playwright's `fill()`
  does not press keys: it writes the value into the box even while the form is inert, which no shopper can do, and
  react-hook-form then wipes it as it starts. That is the race the first full run hit. The test looks at the
  attribute, because nothing on screen changes when the island starts.
- **`fillDetails()`** ticks the terms with Space. The checkbox is `sr-only` under its icon (Figma's look), so
  Playwright's `check()` refuses to click it: the icon is on top. Space on the focused box is what a keyboard user
  does, and it goes through the same `onChange`.
- **The Cash on Delivery walk** checks each hand-over: the drawer's prices come from the server (the subtotal
  changes with the stepper), the checkout adds the zone's charge, the verify page masks the phone, and the test reads
  the code from the test shop's own line, as a tester would, instead of knowing `123456`. After the dialog, "Continue
  shopping" has the focus and the cart is empty, as 26c says. The order number comes from the dialog's link, because
  the tests run in parallel and the next number depends on which test ordered first. At the end, the new order is
  found with the `/track` form (new mock orders get no link, decision 18), with "no courier yet" because nothing
  shipped it.
- **The minimum test** waits for the total with the delivery charge (৳309) before it checks that Confirm Order is
  disabled. The button is also disabled while a quote loads, so without that wait the check passed even with the
  minimum taken out of the code; with it, that break is caught (see the list below). Then one more item makes it
  enabled, and taking the terms back disables it again.
- **Mobile Banking** goes straight to the dialog over the checkout, because the mock asks no code for it (26b). The
  card is chosen by its label's text, which is what a shopper taps.
- **"nothing typed before its script runs is lost"** holds back every script under `/_astro/` until the test lets
  it go, like a slow phone. `waitUntil: 'commit'`, because module scripts hold `DOMContentLoaded` back, and they are
  the ones held. While the form is inert, a click on the name box and real keys type nothing; before the fix, the
  name was typed here and then wiped. Once the scripts arrive, the name typed stays.

### `apps/shop/e2e/browse.e2e.ts`

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 26d, walked once in a real browser: the category page, a sub-category from a chip's menu,
// the sort in the address, Load More, search, and the category drawer

test('a category chip’s menu leads to a sub-category, and Sort By puts the sort in the address', async ({
  page,
}, testInfo) => {
  // The phone has no chips with menus and no Sort By (Figma home_page_mobile): the next test
  test.skip(testInfo.project.name === 'phone', 'desktop only');
  await page.goto('/c/all');
  await expect(page.getByRole('heading', { level: 1, name: 'All Products' })).toBeVisible();
  const filters = page.getByRole('navigation', { name: 'Filter the products' });
  await filters.getByRole('button', { name: 'Cosmetics' }).click();
  await page.getByRole('link', { name: 'Hair care' }).click();
  await expect(page).toHaveURL('/c/hair-care');
  await expect(page.getByRole('heading', { level: 1, name: 'Hair care' })).toBeVisible();

  await filters.getByRole('button', { name: 'Sort By' }).click();
  await page.getByRole('link', { name: 'Price: low to high' }).click();
  await expect(page).toHaveURL('/c/hair-care?sort=price_asc');
});

test('on a phone the categories are pills that lead to their page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone only');
  await page.goto('/c/all');
  await page
    .getByRole('navigation', { name: 'Filter the products' })
    .getByRole('link', { name: 'Cosmetics' })
    .click();
  await expect(page).toHaveURL('/c/cosmetics');
  await expect(page.getByRole('heading', { level: 1, name: 'Cosmetics' })).toBeVisible();
  await expectNoSideScroll(page);
});

test('the sort in the address orders the cards', async ({ page }) => {
  await page.goto('/c/all?sort=price_asc');
  // Each card's price, read from the card. The price is the paragraph that is only an amount:
  // the discount ribbon ("৳10 off") also starts with ৳
  const prices = await page
    .getByRole('main')
    .getByRole('article')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const price = [...card.querySelectorAll('p')]
          .map((p) => p.textContent.trim())
          .find((text) => /^৳[\d,]+(\.\d+)?$/.test(text));
        return Number((price ?? '').replace(/[৳,]/g, ''));
      }),
    );
  expect(prices).toHaveLength(20);
  // A card whose price was not found would be 0 (Number('')) and still sort; none may be
  expect(prices.every((price) => price > 0)).toBe(true);
  expect(prices).toEqual(prices.toSorted((a, b) => a - b));
});

test('Load More adds the next twenty and says so', async ({ page }) => {
  await page.goto('/c/all');
  const cards = page.getByRole('main').getByRole('article');
  await expect(cards).toHaveCount(20);
  await page.getByRole('link', { name: 'Load More' }).click();
  await expect(cards).toHaveCount(40);
  // The live region speaks, and the address stays (the next page is the link's, for no script)
  await expect(page.getByRole('main').getByRole('status')).toHaveText('20 more products');
  await expect(page).toHaveURL('/c/all');
  await expectNoSideScroll(page);
});

test('search finds by name, and a search that finds nothing says what to do', async ({ page }) => {
  await page.goto('/search?q=neem');
  await expect(page.getByRole('heading', { level: 1, name: 'Results for “neem”' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('article').first()).toContainText(/neem/i);

  await page.goto('/search?q=zzzz');
  await expect(page.getByRole('heading', { name: 'Nothing matches “zzzz”' })).toBeVisible();
  await page.getByRole('link', { name: 'See all products' }).click();
  await expect(page).toHaveURL('/c/all');
});

test('the category drawer opens from the header and leads to a category', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Categories' }).click();
  const drawer = page.getByRole('dialog', { name: 'Categories' });
  await drawer.getByRole('button', { name: 'Show the categories in Beverages' }).click();
  await drawer.getByRole('link', { name: 'Tea' }).click();
  await expect(page).toHaveURL('/c/tea');
  await expect(page.getByRole('heading', { level: 1, name: 'Tea' })).toBeVisible();
  await expectNoSideScroll(page);
});
```

- **The chip test is desktop only, the pill test phone only** (`test.skip` by project). The phone has no chips with
  menus and no "Sort By" (Figma `home_page_mobile`); its categories are pills that are plain links.
- **The sort test** reads every card's price from the page and checks that they go up. The price is the paragraph
  that is only an amount: the discount ribbon ("৳10 off") starts with ৳ too, and a first version read the ribbon,
  turned every price into `NaN`, and passed. The two checks before the sort make that impossible now: 20 prices, all
  above zero.
- **Load More** checks the 20 new cards, the live region's words, and that the address stays `/c/all`: the link's
  `?cursor=…` is for a browser without the script (26d).
- **Search** checks one search that finds something and one that finds nothing, with its way out.
- **The category drawer** opens a group with its show/hide button and follows a sub-category.

### `apps/shop/src/islands/checkout/CheckoutForm.tsx`

```diff
@@ -239,6 +239,13 @@ export default function CheckoutForm({
       {/* noValidate: the browser's own bubbles would show English on a Bangla shop */}
       <form
         noValidate
+        // Step 26e: nothing in the form can take the focus, a tap or a key until this script runs.
+        // The server draws the form, so on a slow phone a shopper could type into it before the
+        // island starts, and react-hook-form then writes its empty defaults into the boxes as it
+        // takes them over: the name they typed would be gone, with nothing to say so (26e.4's
+        // Playwright test found it). The cart is null only in the server's HTML (hooks.ts →
+        // useCart), so this is exactly "not running yet"
+        inert={cart === null}
         onSubmit={(event) => {
           void submit(event);
         }}
```

The fix for the bug the tests found (decision 34). The checkout is a React island (`client:load`), so the server
sends the whole form as HTML and the script takes it over later. On a slow phone that can be seconds. In that time a
shopper can type, and react-hook-form's `register()` writes each box's default (`''`) into it as it takes the box
over, so the name is gone and nothing says so. It was seen once in a full run, then every time with the scripts held
back for 1.5 seconds.

`inert` keeps every box from taking the focus, a tap or a key until the island runs. `cart === null` is exactly that
moment: `useCart()` gives `null` only for the server's HTML (`getServerSnapshot`), and React draws the browser's cart
right after it starts. React 19 knows `inert` as a boolean prop, so the server writes `inert=""` and the browser's
first draw removes it, with no cast. A `<fieldset disabled>` would also work, but it wraps and re-indents the whole
form, and turns every box grey for that moment.

### `.github/workflows/ci.yml`

```diff
@@ -44,12 +44,18 @@ jobs:
       - name: Install Playwright browser
         run: pnpm --filter @omnivo/app exec playwright install --with-deps chromium
 
+      # The ERP app only: the storefront's tests have their own step below
       - name: E2E (Playwright on MSW mocks)
-        run: pnpm test:e2e
+        run: pnpm test:e2e --filter=@omnivo/app
 
       - name: E2E (service worker on a production build)
         run: pnpm test:e2e:pwa
 
+      # Step 26e: the storefront on its built server, with the mock source (apps/shop/e2e). The
+      # browser from the step above serves it too: the lockfile has one @playwright/test for both apps
+      - name: E2E (storefront on its built server)
+        run: pnpm --filter @omnivo/shop test:e2e
+
       - name: Build
         run: pnpm build
 
```

- **The app's step now says `--filter=@omnivo/app`** (decision 31). A turbo dry run shows the difference:
  `pnpm test:e2e` would run `@omnivo/shop#test:e2e` too, and with the filter it runs only `@omnivo/app#test:e2e`.
- **The storefront's step** comes after the service worker step, so a failure in the ERP app's tests shows first. It
  needs no browser install of its own: the step above installs Chromium for the lockfile's one Playwright, and both
  apps use it. If the two apps ever get different Playwright versions, this step needs its own
  `playwright install`. The shop's packages (`@omnivo/contracts`, `@omnivo/i18n`) are built by then: `pnpm lint`
  and `pnpm typecheck` build them earlier in the job.

### `pnpm-lock.yaml`

The two new dev dependencies of `apps/shop`, both already in the lockfile for `apps/app`, so `pnpm install` adds
no new package. Run `pnpm install` after changing `package.json` and the lockfile is written for you.

### Check this part

```bash
pnpm install
pnpm dedupe --check
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop
pnpm exec prettier --check apps/shop .github
pnpm boundaries
pnpm --filter @omnivo/shop exec playwright install chromium
pnpm --filter @omnivo/shop test:e2e
```

`playwright install` is needed once per machine (it is the same browser as the ERP app's tests, so it may already be
there). The last command builds the shop and starts it on port 4331 itself. It runs 40 tests, 20 at each width:
38 pass and 2 are skipped (the desktop-only and the phone-only browsing tests), in about 20 seconds with the build.
The shop still has 200 unit tests. A failed test leaves a trace in `apps/shop/test-results/` (git-ignored); open it
with `pnpm --filter @omnivo/shop exec playwright show-trace <path>`.

The shopping tests were also run five times in a row (`--repeat-each=5`, 40 of 40), because the first full run had
one flaky test, which was the checkout bug above.

Broken on purpose while this part was written, each caught by the one test named (script `.guide/work/break-26e4.py`
in the clone):

- `security.allowedDomains` taken out of `astro.config.ts` → "stops a visitor after ten misses, and only that
  visitor" fails (the second visitor is stopped too);
- the `Referrer-Policy` header taken out of `/t/[token].astro` → "shows the order, then its parcels newest first"
  fails;
- a parcel's events not reversed in `tracking-view.ts` → the same test fails;
- the `autofocus` on the first box with an error taken out of `track.astro` → "says what to fix" fails;
- the text page's title as the slug instead of the footer's word → "every footer link opens its page" fails;
- `!quote.belowMinimum` taken out of `canOrder` → "waits for the minimum order" fails (it passed before the test
  waited for the ৳309 quote);
- the `inert` line taken out of `CheckoutForm.tsx` → "nothing typed before its script runs is lost" fails.

---

## 26e.5 — Doc updates

After you implement this (ask me and I can do these). Three files change. The build plan's progress list
(section ৯) is **not** ticked: the line "ধাপ ২৬–২৮" stays open until step 26's API is done, the same as after 26d.

**CLAUDE.md** (all in "Storefront design system"):

1. In **Header**, after "without a name it says "Account".", add: "Both account buttons open `/track` until the shop
   has a customer sign-in."
2. At the end of the **Checkout card** bullet, after ""Free delivery on orders over ৳1,000".", add: "The form is
   `inert` until its island has run, so nothing a shopper types before then is lost."
3. In **Empty state** ("Storefront screens not in Figma"), replace "page not found, and a shop that is closed." with
   "page not found (`FileNotFound`, "Go to the home page") and a tracking link that does not work (`Unlink04`,
   "Track with the number"). There is no closed shop: a shop is always open."
4. Replace the **Track order** bullet with these two bullets:

   - **Tracking link (`/t/<token>`):** the link the shop sends the buyer (by SMS from step 27). The token is 128 bits
     (22 base64url characters) and only its hash is stored, like a share link. The checkout card at 848px, header
     "Track Order", body padding 36px (20px on phones), 32px between blocks: the order number (`Geist Mono`
     `sf-title`, never broken) with "Placed on …" under it; a `canvas` box (radius 8, padding 20px) with "3 items"
     and the total in `price`, and "Keep ৳578 ready in cash for the rider." (Cash on Delivery, until delivered) or
     "Paid with Mobile Banking."; the order's timeline: 24px dots (done: `brand` fill with an `accent` tick; current:
     2px `accent` ring on `brand`; later: 1px `rule` ring), 2px connecting line, 16px/600 `brand` status and a 14px
     `muted` date; then one section per parcel (at most 5), newest first: "Parcel" (an older one "Earlier parcel"),
     "Steadfast · SFR2611120042" in 14px `muted` `tabular-nums`, an optional "See it on the Steadfast site" link
     (`LinkSquare02`, https only, `rel="noopener noreferrer"`), and the courier's events newest first in the same
     dots and line (status, time, and the courier's own note in 14px `body`). Each courier's statuses map to the
     shop's ten. Before a courier is booked, the parcel section says so. It ends with "Anyone with this link can
     see this page. It shows no address and no phone number." in 14px `muted`: the page names no person, because a
     link can be forwarded. Headers `Cache-Control: no-store`, `X-Robots-Tag: noindex` and
     `Referrer-Policy: no-referrer`. A broken or unknown link answers 404 with its own empty state.
   - **Track order (`/track`):** the way back for a lost SMS. The checkout card at 560px: header "Track Order", a
     16px `body` line, Mobile Number and Order Number side by side from `md` (the checkout's fields; the number
     takes "w000123" or Bangla digits too), and "Track Order" (the Confirm Order button's look). The form POSTs to
     the same page and works with no script, so the phone never goes into the address. A match draws the tracking
     link's view in place at 848px, ending with "Track another order" (`cream`, 44px, radius 4). A wrong number or
     phone, of any kind, gets one answer above the boxes ("No order has this number and mobile number…", `Alert02`,
     `promo`, it takes the focus); a box with an error says so under it, and the first one takes the focus. After
     10 misses in 15 minutes from one address (IPv6: its /64) the page answers 429, "Too many tries. Wait 15
     minutes…". It cannot send the shopper to `/t/<token>`: only the token's hash is stored. The mock shop lists
     its demo orders, their phones and their links in a `canvas` box under the line.

5. Replace the **Text pages** bullet with: "**Text pages (`/pages/privacy`, `terms`, `about`, `contact`):** the
   checkout card at 848px with the footer's own word as the title in the header ("Terms & Condition"), "Last
   updated 1 Nov 2026" under it in 14px `muted` (the day in the shop's time zone) when the page has a date, and the
   tenant's HTML in the description's prose style (`shop-prose`), its sections 8px apart in the card's 4px frame.
   Only these four; any other slug, or a page the tenant has not written, is page not found. Contact is text only,
   with no form."
6. After the **Text pages** bullet, add: "**Page not found (`404`):** the full layout (header and footer) with the
   empty state 36px under the header (16px on a phone): `FileNotFound`, "Page not found", "The link may have a
   typo, or the page has moved…", and "Go to the home page". Status 404. It answers every address with no page,
   and every page that rewrites to `/404` (an unknown product, category, order or text page)."
7. After the "Storefront screens not in Figma" list, before "## Website / Landing page", add a new part:

   ```markdown
   ### Storefront tests

   Unit tests (Vitest) sit next to the code. Browser tests are Playwright, in `apps/shop/e2e/`, against the built
   server (`astro build`, then `node dist/server/entry.mjs` on 127.0.0.1:4331), in Chromium at 1440×900 and at
   390px (Pixel 7). There are no screenshot diffs: a test checks what a shopper sees and does, and that the page
   never scrolls sideways. CI runs them in their own step, `pnpm --filter @omnivo/shop test:e2e`, and
   `pnpm --filter @omnivo/shop typecheck` checks `e2e/` too. A test that uses up `/track`'s tries sends its own
   `X-Forwarded-For`, so it does not stop the other tests.
   ```

**docs/system-design.bn.md** (§14, in Bangla like the rest of the file):

8. In the `storefront_orders` table, after the `source (web | facebook | manual), coupon_code` line, add:

   ```text
     tracking_token_hash                            ← ট্র্যাকিং লিংকের token-এর hash (ধাপ ২৭), token নিজে কোথাও রাখা হয় না
   ```
9. In the §14.4 sequence diagram, replace `W-->>C: SMS/ইমেইল: ট্র্যাকিং নম্বর` with `W-->>C: SMS: ট্র্যাকিং লিংক`.
   The diagram leaves out `/t/<token>`: Mermaid may read `<token>` as HTML and drop it.
10. In §14 → "স্ট্যাটাস আপডেট", replace the line that starts "ক্রেতা ট্র্যাকিং দেখবে `acme.omnivo.shop/track/:code`-এ"
    with:

    ```markdown
    - ক্রেতা ট্র্যাকিং দেখবে SMS-এ পাওয়া লিংকে, `acme.omnivo.shop/t/<token>` (১২৮-bit token, শুধু hash রাখা হয়;
      পেজে নাম, ঠিকানা বা পুরো ফোন নম্বর নেই, কারণ লিংক অন্যকে পাঠানো যায়), আর গুরুত্বপূর্ণ ধাপে SMS পাবে। SMS
      হারালে `/track`-এ ফোন + অর্ডার নম্বর দিয়ে একই পেজ দেখা যায় (এক IP থেকে ১৫ মিনিটে ১০ বার ভুল হলে থামে)।
    ```

**docs/build-plan.bn.md** (section ২, so the work that 26e left for later is not lost):

11. In **ধাপ ২৭**, after "`storefront_orders`, " add: "অর্ডারের সাথে ট্র্যাকিং লিংকের token (শুধু hash রাখা) আর
    ক্রেতাকে SMS-এ লিংক (`/t/<token>`, পেজটা ধাপ ২৬e-তে তৈরি), " (with the space at the end, before "অর্ডার
    বোর্ড UI").
12. In **ধাপ ২৮**, at the end of the "স্ট্যাটাস" bullet (after "`shipment_events` append-only"), add: "; ERP-র
    অ্যাডমিনে কুরিয়ারের API key, আর কুরিয়ারের ইভেন্টগুলো ট্র্যাকিং পেজে (ধাপ ২৬e-র মক ইভেন্টের জায়গায়)".

## 26e.6 — Run it and check it

```bash
pnpm install
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build   # the shop reads their dist/
pnpm --filter @omnivo/shop typecheck      # astro check, then tsc on e2e/: 0 errors, 0 warnings, 0 hints
pnpm --filter @omnivo/shop test           # 200 tests in 21 files
pnpm --filter @omnivo/shop exec playwright install chromium   # once per machine
pnpm --filter @omnivo/shop test:e2e       # builds the shop, starts it on 127.0.0.1:4331: 38 passed, 2 skipped
pnpm --filter @omnivo/shop build
pnpm --filter @omnivo/shop start          # node dist/server/entry.mjs, http://localhost:4321
```

Then, for the whole repo (the step changed two shared packages, the ERP app's words and CI):

```bash
pnpm dedupe --check
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test                 # 1,221: contracts 490 + app 210 + shop 200 + api 156 + sync 118 + ui 22 + i18n 17 + auth 8
pnpm boundaries
pnpm test:bundle-size     # the ERP app's first load 231.8 KB gz (budget 235): three error words more
pnpm test:openapi         # up to date: the storefront schemas are not in the ERP's API
```

On a laptop with 8 GB, run them one at a time and add `--concurrency=2` to the turbo ones. `pnpm test:e2e` at the
root now runs the ERP app's tests and then the shop's; CI runs them in two steps (decision 31).

The staging proxy's file changed, so check it once with Caddy itself (Docker, no server needed):

```bash
docker run --rm -v "$PWD/infra/staging/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e APP_HOST=app.example.com -e API_HOST=api.example.com -e FILES_HOST=files.example.com \
  -e MAIL_HOST=mail.example.com -e SHOP_HOST=shop.example.com \
  caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile
```

It says "Valid configuration". The image is the one `infra/docker/Dockerfile` builds `web` from, and the host names
are made up: Caddy only needs them to read the file. `caddy adapt` with the same arguments prints the JSON, where the
shop's last `reverse_proxy` sets `X-Forwarded-For` to `{http.vars.client_ip}`, as the API's does. `/_astro/*` does not
need it: no limit counts there.

### Found while finishing

The status line of a broken tracking link was `HTTP/1.1 404 OK`, and of "too many tries" `HTTP/1.1 429 OK`. Astro
keeps the status text of the 200 it started with when a page sets `Astro.response.status`. The two pages now set
`statusText` too (26e.3 shows them), and the broken-link test checks it. Broken on purpose: with the `statusText`
line taken out of `/t/[token].astro`, "a broken link says so with status 404" fails at both widths ("OK", not "Not
Found"). The 429 was checked with `curl` after ten misses.

### What you should see

The mock shop's three demo orders are listed on `/track` (decision 18): W-000121 (01711284519, delivered),
W-000122 (01819456723, no parcel yet) and W-000123 (01786120356, on hold).

At 1440px wide:

- [ ] `/t/C2etI9zQb8E5ZugpwzVWyA`: "Track Order" in the card's header, W-000123 in mono with "Placed on 11 Nov 2026,
      15:20" under it, "3 items" and "Total ৳578", "Keep ৳578 ready in cash for the rider.", the order's timeline
      oldest first with "On the way" as the current step and "Delivered" still grey, then the parcel: "Steadfast ·
      SFR2611120042", "See it on the Steadfast site", and its events newest first, "Could not deliver: they will try
      again" on top with "Customer not reachable" under it. The last line says anyone with the link can see the page.
      No name, address or phone anywhere.
- [ ] `/t/MGhXyBcrs_PytWRCRPw-6w` (W-000121): "Paid with Mobile Banking.", every step done, the Pathao parcel first
      ("Delivered" on top), then "Earlier parcel", RedX, with "Booking cancelled" on top.
- [ ] `/t/8hFQ10FlQi8U60p2Ct6OEw` (W-000122): the timeline at "Confirmed", and the parcel section says "The shop has
      not handed the parcel to a courier yet."
- [ ] `/t/nope` and a changed last letter of a real link: `404 Not Found`, "This tracking link does not work" and
      "Track with the number", which opens `/track`.
- [ ] The response headers of `/t/…` (the browser's network tab): `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
      `Referrer-Policy: no-referrer`.
- [ ] `/track`: the 560px card, the demo line, and the two boxes side by side. `01786120356` and `w000123` (or
      `০১৭৮৬১২০৩৫৬` and `w০০০১২৩`) → the W-000123 view in place at 848px, the address still `/track`, then "Track
      another order".
- [ ] "Track Order" with empty boxes → each box says what to fix under it, and the focus is in the Mobile Number box. A wrong phone with a real
      number → "No order has this number and mobile number…" above the boxes, with the focus on it. After the tenth
      wrong try: "Too many tries. Wait 15 minutes, then try again.", `429 Too Many Requests` (a right pair is refused
      too, for 15 minutes).
- [ ] The footer's four links: "Privacy Policy", "Terms & Condition", "About Us" and "Contact Us", each with that
      title in the card's header, "Last updated 1 Nov 2026" under it (20 Oct 2026 on Contact Us, none on About Us), and the text in the
      description's prose style. The checkout's terms link opens `/pages/terms` in a new tab. `/pages/nope` is page
      not found.
- [ ] `/nope`, `/p/nope`, `/c/nope`, `/pages/nope` and `/order/W-999999`: the header and footer, "Page not found" 36px
      under the header, "The link may have a typo, or the page has moved…" and "Go to the home page". Status 404.
- [ ] The header's Account button opens `/track`.

At 390px wide: the cards fill the width (358px) with 20px of body padding, the two `/track` boxes are one above the
other, the parcel lines wrap, and nothing scrolls sideways. With JavaScript turned off, `/track` still works (it has no script).
With `language: 'bn'` in `src/data/mock/shop.ts`, every page here is Bangla, with Bangla digits in the amounts and the
dates ("মোট ৳৫৭৮", "রাইডারের জন্য ৳৫৭৮ নগদ তৈরি রাখুন।"). The courier's own note ("Customer not reachable") and
the tenant's page text stay as they were written (decision 11).

### Known differences from Figma

- **None of this step's pages are in Figma.** The tracking views, the text pages and "page not found" follow
  `CLAUDE.md` → "Storefront screens not in Figma", built from the checkout card, the order page's timeline and the
  storefront's empty state, and 26e.5 writes down what they became.

## What comes next

Every screen of the shop now exists, on the mock source. What is left of the storefront is in the API and the ERP:

- **Step 26's server part:** the `storefront` module in the API and `/public/v1`; one `ShopSource` that calls it in
  place of the mock. The pages and the addresses stay as they are now.
- **Step 27:** the real checkout and orders; the tracking token is made and its hash stored when an order is placed,
  and the SMS carries the link (decision 1). `/track` asks the API the same question, with the same limit (decision 17).
- **Step 28:** the Steadfast key in the ERP's admin, consignments, the webhook and polling, `shipment_events`, and each
  courier's statuses mapped to the shop's ten (decision 11). `TrackingView` already draws what step 28 sends.

The order after this (step 22's website, from the designer's design, or step 26's server part first) is yours to
choose.
