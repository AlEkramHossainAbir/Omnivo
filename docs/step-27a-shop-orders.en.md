# Step 27a: Checkout and orders, part 1 — real orders, the phone code and tracking

> The implementation guide for "Phase 10 → Step 27", the first part, of [build-plan.bn.md](build-plan.bn.md). Step 27
> has three parts:
>
> - **27a (this guide):** orders in the database, the stock they hold, the phone code by SMS, the tracking link and
>   the API's limits. The shop's `api` source stops using the mock order book.
> - **27b:** the ERP's Storefront → Orders screens, and the ERP documents an order makes (customer and sales order at
>   confirm, challan at Packed, invoice at Delivered).
> - **27c:** coupons and online payment (SSLCommerz, with the shop's own encrypted credentials).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `3c18f00`, "store front menu
> added") and checked on 2026-11-18: `pnpm dedupe --check`, `pnpm build`, `pnpm lint`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (1,465, of them 625 in `packages/contracts`, 244 in `apps/shop`, 229 in `apps/app` and 198 in
> `apps/api`), `pnpm test:integration` (828 in 48 files) and `pnpm test:tenant-leak` (167 in 24 files) on
> Testcontainers, `pnpm boundaries`, `pnpm test:bundle-size` (first load 241.3 KB gz, budget 245; the listing editor
> 149.8 KB, budget 150), `pnpm test:openapi`, the app's Playwright suite on a computer and on a phone (all 449 that
> run pass; six timed out while the machine was busy and passed when run again on their own), the PWA suite (4) and
> the shop's Playwright tests (42, 2 skipped on purpose, as before), all clean. The two migrations were also checked
> on a throwaway Postgres with their own script (27a.2).
>
> Also checked:
>
> - **A whole order on the real API** (27a.6): throwaway Postgres, Valkey, Mailpit and MinIO, the built API and
>   worker, `pnpm seed:shop`, then the built shop with `SHOP_SOURCE=api`. A Cash on Delivery order for ৳538 was
>   placed in a browser; it waited with no number and held 2 pieces. The code came from Mailpit; a wrong code said
>   "4 tries left."; the right one gave `W-000001` and kept the hold with no end. Then `/order/W-000001`, the
>   tracking link from the second SMS on a phone (no name, no phone, `no-store`), `/track`, the owner's bell, a
>   second order as `W-000002`, and a shop with a wrong key, which took no order and said why in its log. This run
>   found one bug from 26f, fixed in 27a.6.
> - **Broken on purpose** while the parts were written, each caught by a test: an order route made public, the
>   variant lock taken out (the last piece sold five times), the right code sent twice confirming twice, another
>   order's token opening an order, the order routes run as `omnivo_app`, an `UPDATE` grant on the whole orders
>   table, the shop sending its key on every route, and more. Each part's "Check this part" lists them.

## Goal

🛒 **An order placed in a real shop is a real order.** Since 26f a launched shop read its products and prices from
the ERP, but Confirm Order still went to a mock order book in the shop's own memory: the "code" was always shown on
the page, nothing held the stock, and a restart lost every order. After 27a, Confirm Order writes the order and its
lines into the ERP's database and holds the stock it needs. The shopper gets a 6-digit code by SMS (in development an
email in Mailpit). The right code confirms the order: it gets its number (`W-000001`, counted per shop), the stock
stays held until 27b's challan, the shopper gets a second SMS with a private tracking link, and the shop's staff hear
the bell. An order that never gets its code is deleted after 60 minutes, and its stock is free again. Only the shop's
own server may call these routes (a key), and the API limits orders per phone and per connection, so nobody can empty
a shop's shelves or its SMS balance with a script.

The ERP has no Orders screen yet (27b): the bell opens the overview for now.

## The whole picture

```
packages/contracts   storefront.ts: 7 order routes with auth 'shop' (x-shop-key + x-shop-client-address),
                     the code's rules (10 minutes, 3 codes, 60-minute hold), the order limits (5 per phone,
                     20 per connection, an hour), shopOrderTokenSchema, maskPhone(), addressKey()
                     http.ts: a third auth kind     errors: 4 codes     permissions: storefront.order.read/.manage
packages/db          0070 storefront_orders · _order_lines · _stock_holds · _order_counters (RLS)
                     0071 role omnivo_shop (omnivo_public + the order tables), column grants, the worker's view
      │
      ▼
apps/api
   ShopKeyGuard        every 'shop' route: STOREFRONT_SHOP_KEY, else 401 storefront_shop_key_invalid
   ShopDb.orders       one transaction as omnivo_shop inside the shop's workspace
   listing-sql/quote   free = on hand − held; a line asking for more than is free is out of stock
   shop-orders.service place (a lock per variant, holds for 60 min, code SMS) → verify (5 tries; W-000123 from
                       the shop's counter, holds kept, tracking token, confirm SMS, outbox event) → resend
                       find (/order/<no>) · tracking (/t/<token>) · track (/track form, misses limited)
   shop-limits         Redis counters under hashed keys
   sms/                SmsSender; the dev one mails <phone>@sms.invalid to Mailpit; its own 'sms' queue
   worker              the bell (storefront.order_confirmed) · the sweep of pending orders every 5 minutes
      │  x-shop-key, x-shop-client-address, tokens in POST bodies
      ▼
apps/shop   SHOP_SOURCE=api + SHOP_API_KEY: api-source.ts calls the 7 routes, the mock order book is gone
            verify page: "code expired", "no more codes"    checkout: "too many orders, wait N minutes"
            the mock source keeps the same code rules, for pnpm dev and the Playwright tests

Tuesday 17 Nov 2026, a shopper in Dhanmondi on her phone:
  2 × Himalaya shampoo, Inside Dhaka → Confirm Order: order saved, 2 pieces held, SMS "482913 is your
  Omnivo order code…" → types 482913 → "Order Confirmed", W-000001; SMS "…order W-000001 is confirmed.
  Track it here: http://demo-shop.localhost:4321/t/…" → the owner's bell: "New shop order W-000001 for ৳538."
  Another shopper who never types the code: the order and its hold are gone an hour later
```

## Not in this step, on purpose

- **The ERP's Orders screens and documents** (27b): the list with status tabs, Packed / Shipped / Delivered /
  Cancelled, and the customer, sales order, challan and invoice an order makes (decisions 3–5 and 10). Until then a
  confirmed order is in the database and holds its stock, and the bell tells the staff.
- **Coupons and online payment** (27c). The checkout offers Cash on Delivery only (decision 29), and a coupon is
  still refused as unknown.
- **A real SMS provider.** The `SmsSender` in this step mails each SMS to Mailpit. The provider (BulkSMSBD, SSL
  Wireless or Alpha SMS) is chosen before staging sends real SMS; it is one new class.
- **Couriers, their events on the tracking page and returns** (step 28). The tracking page shows the order's own
  steps, and says no courier has the parcel yet.
- **Staging on the real API.** Staging keeps the mock shop until it has a wildcard shop host (26g.8).

## What changes in the code you already have

| File | Change |
|---|---|
| `.env.example`, `infra/staging/compose.yml` | `STOREFRONT_SHOP_KEY` for the API, `SHOP_API_KEY` for the shop |
| `packages/contracts/src/storefront.ts` (+ spec) | The code's rules and limits, the order token, `maskPhone()`, `addressKey()`, `ShopCodeWait`, the two headers, the 7 routes |
| `packages/contracts/src/http.ts`, `openapi.ts` (+ spec) | `auth: 'shop'` and the `shopKey` security scheme |
| `packages/contracts/src/errors.ts`, `permissions.ts`, `notifications.ts` | 4 error codes, `storefront.order.read` / `.manage`, the `storefront.order_confirmed` bell |
| `packages/contracts/openapi.json` | Regenerated with the 7 routes |
| `packages/db/src/schema/index.ts`, `outbox-events.ts`, `permission-catalog.ts` | The new tables, the outbox event, the two permissions |
| `packages/db/migrations/meta/_journal.json` | Migrations 0070 and 0071 |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The errors, the permissions and the bell's words |
| `apps/api/src/config.ts` (+ spec) | `storefront.shopKey` and the code's HMAC key |
| `apps/api/src/app.module.ts`, `auth/auth.guard.ts`, `rbac/permission.guard.ts` | `ShopKeyGuard` between the two guards; both let `'shop'` routes through to it |
| `apps/api/src/storefront/shop-db.ts` | `orders()` beside `read()`, as `omnivo_shop` |
| `apps/api/src/storefront/listing-sql.ts`, `quote.ts` (+ spec), `public-storefront.service.ts` | Free stock = on hand − held; Mobile Banking hidden until 27c |
| `apps/api/src/storefront/storefront.module.ts` | The orders controller and services |
| `apps/api/src/common/outbox/outbox.ts`, `worker/*` (4 files) | The confirm event, the `sms` queue, the sweep, the handlers |
| `.dependency-cruiser.cjs` | `sms/sms-queue.ts` may add jobs to BullMQ (decision 42) |
| `apps/shop/src/lib/quote.ts` (+ spec) | The cart drawer takes the photo addresses the contract takes, so it works on the API in development (a bug from 26f, found in 27a.6) |
| `apps/api/src/setup/templates.ts` | The two shop roles get the order permissions |
| `apps/api/src/testing/app.ts` | `TEST_SHOP_KEY` |
| `apps/app/src/components/notification-bell.tsx` | The new bell's words and link |
| `apps/shop/astro.config.ts`, `src/data/config.ts` (+ spec) | `SHOP_API_KEY`, required with `SHOP_SOURCE=api` |
| `apps/shop/src/data/types.ts`, `source.ts` | The new refusals, the shopper's address as an argument, no mock order book |
| `apps/shop/src/data/api/shop-api.ts`, `api-source.ts` (+ spec) | The key and the address on `'shop'` routes; the 7 routes |
| `apps/shop/src/data/mock/*` | The API's code rules; the `/track` limiter moved in from `server/` |
| `apps/shop/src/server/cookies.ts`, `orders.ts`, `track.ts` (+ specs) | One token shape; the new refusals; no limiter in the form |
| `apps/shop/src/pages/api/orders/index.ts`, `checkout/verify.astro`, `track.astro` | The address; "code expired" and "no more codes" |
| `apps/shop/src/islands/checkout/CheckoutForm.tsx`, `words.ts` | "Too many orders, wait N minutes" |
| `apps/shop/e2e/shopping.e2e.ts`, `scripts/seed-shop.ts` | Two tests for the new verify states; the seed's hint names `SHOP_API_KEY` |

New: `packages/db/src/schema/storefront-orders.ts`; migrations 0070 and 0071; in `apps/api/src/`: `sms/` (five
files), `worker/sms-runner.ts`, `storefront/shop-key.ts`, `shop-key.guard.ts` and `shop-client.decorator.ts`, `storefront/orders/` (the
service, controller, limits, secrets, view, bell handler, sweep and their tests) and `testing/shop-orders.ts`.

## Decisions

Agreed with the user on 2026-11-17 (all twelve as recommended):

1. **Three guides:** 27a orders, phone code, SMS, stock hold, tracking token and limits; 27b the ERP's Orders screens
   and documents; 27c coupons and online payment. Each one is small enough to check in full, and the riskiest part, a
   payment gateway, comes last, after Cash on Delivery works end to end.
2. **The right phone code confirms the order by itself.** The shop already tells the shopper "Order Confirmed" at that
   moment, and the code is what stops most fake Cash on Delivery orders. The shop's staff can still cancel it. An
   order that waits for its code is not shown to the staff, and it is dropped after 60 minutes or 5 wrong codes.
3. **ERP documents follow the parcel** (27b): confirmed makes the customer and a sales order, Packed makes the challan
   (stock out and its cost), Delivered makes the invoice. Cash on Delivery parcels often come back from the door, and
   an invoice made before delivery would need a credit note each time.
4. **The customer is found by phone** (27b): the same `01XXXXXXXXX` is the same customer, otherwise a new one in an
   "Online shop" group. An order never changes an existing customer's name or address; its own address goes on the
   sales order.
5. **The delivery charge is a service product** (27b), one line on the sales order, so sales documents need no new
   kind of charge.
6. **Stock is held in its own table.** A waiting order holds its stock for 60 minutes; a confirmed one holds it with
   no end until its challan is posted. The shop shows what is on hand minus what is held. Orders take a lock per
   variant, and a test races two orders for the last piece.
7. **The phone code:** 6 digits, only a keyed hash stored, 10 minutes, 5 tries, a new code after 45 seconds, at most
   3 codes per order. Limits per phone and per connection live in Redis.
8. **SMS goes through one `SmsSender`.** In development and CI it is an email to Mailpit, so it shows in the Mailpit
   page we already use. The real SMS provider is chosen later, before staging sends real SMS.
9. **The tracking link's token is made at confirm**, only its hash is stored, and it goes to the buyer by SMS. Order
   numbers are `W-000123`, counted per shop.
10. **Orders are a data table with status tabs** (27b), not a kanban board: it works for hundreds of orders and on a
    phone.
11. **Two new permissions,** `storefront.order.read` and `storefront.order.manage`, apart from `storefront.manage`: a
    packer has no reason to change the shop's prices, and an order holds a phone and an address.
12. **Not now:** couriers, automatic returns, remittance (step 28); orders from Facebook or typed by hand; email to the
    shopper; refunds of online payments.

Decided while writing (the user may still object):

13. **The order routes need the shop server's key.** The read routes stay open, because a shop's pages show them to
    anyone. The routes that place an order, send an SMS or answer with an order are `auth: 'shop'`: the shop's
    server sends a key (`x-shop-key`) that only it and the API know. Without it, anyone who finds the API's address
    could fill a shop with orders and spend its SMS balance.
14. **The shopper's address comes in a header** (`x-shop-client-address`), because the API sees only the shop's
    server. It is trusted only next to a right key.
15. **Every token travels in a POST body,** never in a path or a query, for the reason 26e kept the phone out of the
    `/track` address: addresses end up in logs and `Referer` headers.
16. **Two tokens per order:** the browser's (in the httpOnly cookie, it opens `/order/<no>` with the phone and the
    address) and the tracking link's (sent by SMS and forwarded, it opens only the page without them). Both are 128
    random bits, and only their hashes are stored.
17. **The limits:** 5 orders per phone and 20 per connection in an hour (`shop_order_limit`, with the minutes to
    wait). A code works for 10 minutes (`shop_code_expired`); a fourth code is refused (`shop_code_sends_used`).
18. **`maskPhone()` and `ShopCodeWait` move into `@omnivo/contracts`,** because the API now writes the verify page's
    answer too.
19. **A pending order that is dropped is deleted, not kept as cancelled.** Five wrong codes delete it at once; the
    worker's sweep deletes the ones older than 60 minutes. Its phone was never confirmed, so keeping it would keep
    a stranger's number, or a number someone typed to annoy its owner, for no use. The stock it held is free again
    in the same statement.
20. **The order number is given at confirm, from the shop's own counter.** A dropped order then leaves no gap in
    `W-000123`. Not the ERP's `number_series`: a tenant may change a document's prefix in Settings → Numbering, and
    the shop's `/track` form reads `W-` and digits only.
21. **An order line keeps its listing as a copy, with no foreign key.** The listing may be deleted later, and that
    must not be refused because someone once ordered it. The stock item (the variant) does have a foreign key, as
    on every document line.
22. **The order routes write as a new role, `omnivo_shop`.** It can do what `omnivo_public` does, plus the order
    tables, and nothing else. `omnivo_public` stays read-only for every page of every shop.

## 27a.1 — Contracts

The contract comes first, as in every step: the API, the shop and the tests all read the same schemas, so a shape
that is wrong here fails the type check everywhere at once.

### The phone code's rules and the order limits

```diff
@@ -431,13 +431,39 @@ export const shopOrderRequestSchema = z.object({
 export const SHOP_CODE_LENGTH = 6;
 export const SHOP_CODE_TRIES = 5;
 export const SHOP_CODE_RESEND_SECONDS = 45;
+// Step 27a: the rest of the code's rules, kept by the API.
+// - A code works for 10 minutes. An SMS can arrive late, but a code that works for an hour is an
+//   hour for a guesser
+// - An order gets at most 3 codes: the first and two resends. Each SMS costs the shop money, and
+//   a phone that has not got 3 codes will not get a fourth
+// - An order and the stock it holds wait 60 minutes for the right code (system design §14.4), then
+//   the order is dropped and the stock is free again
+export const SHOP_CODE_VALID_MINUTES = 10;
+export const SHOP_CODE_SENDS = 3;
+export const SHOP_ORDER_HOLD_MINUTES = 60;
+
+// Step 27a: how many orders may be placed in one hour. Each one sends an SMS and holds stock, so
+// these limits are what stop a script from emptying a shop's shelves or its SMS balance:
+// - 5 from one phone: more than any real shopper places in an hour
+// - 20 from one connection: a shop's own office, or a mobile operator's shared address, can
+//   place several, so it is higher than the phone's
+export const SHOP_ORDERS_PER_PHONE = 5;
+export const SHOP_ORDERS_PER_ADDRESS = 20;
+export const SHOP_ORDER_WINDOW_MINUTES = 60;
+
+// "01786120356" → "+880 17•• ••• 356". The first two digits say the operator and the last three
+// let the shopper see it is their number; the rest stays off a screenshot. Step 27a: moved here
+// from the shop's mock, because the API now writes the verify page's line too
+export function maskPhone(phone: string): string {
+  return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
+}
 
 // What Confirm Order answers. Which page comes next depends on the payment method:
 // - verify: Cash on Delivery. The order waits for the phone code; the browser goes to
 //   /checkout/verify, which says where the code went ("+880 17•• ••• 356": the middle is hidden, so
 //   a screenshot of the page does not give away the number)
-// - confirmed: the order needs no code (Mobile Banking in the mock, until step 27's gateway). The
-//   checkout opens the "Order Confirmed" dialog
+// - confirmed: the order needs no code (Mobile Banking in the mock; in the API from step 27c, once
+//   the shop's gateway says it is paid). The checkout opens the "Order Confirmed" dialog
 // The order's secret token is not in the body: the route sets it as an httpOnly cookie, so no
 // script on the page can read it (decisions 4 and 5).
 export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
```

26c wrote the code's length, tries and resend wait; the mock kept the rest in its own memory. Now the API keeps them,
so they become shared constants, and the shop's pages and the API's tests use the same numbers.

- `SHOP_CODE_VALID_MINUTES = 10`. A code that works for an hour is an hour for someone guessing. Ten minutes is
  enough for an SMS that arrives late.
- `SHOP_CODE_SENDS = 3`. Each SMS costs the shop money. A phone that did not get three codes will not get a fourth,
  so the fourth is refused, and the shopper places the order again.
- `SHOP_ORDER_HOLD_MINUTES = 60`. The system design's stock hold (§14.4). The order and the stock it holds wait this
  long for the right code.
- `SHOP_ORDERS_PER_PHONE = 5` and `SHOP_ORDERS_PER_ADDRESS = 20` in `SHOP_ORDER_WINDOW_MINUTES = 60`. Every order
  sends an SMS and holds stock, so without a limit, a script could empty a shop's shelves for an hour, or its SMS
  balance, with one request a second. The connection's limit is higher than the phone's, because many people can
  share one address: a shop's own office, or a mobile operator's shared IP.
- `maskPhone()` was the mock's own function. The API now answers the verify page, so the function moves here, and
  the API and the mock show the same `+880 17•• ••• 356`.

The comment on the `confirmed` answer also changes. In the API, only a paid online order skips the code, and that
comes in 27c.

### What the verify page waits for

```diff
@@ -473,6 +499,17 @@ export const shopCodeResentSchema = z.object({
   resendInSeconds: z.number().int().min(0),
 });
 
+// Step 27a: what /checkout/verify draws for the order that waits: the same as the `verify` answer,
+// plus the listings it holds. A right code takes them out of this browser's cart (26c's decision
+// 23), and the page cannot know them otherwise: the cart may have changed in another tab since
+// Confirm Order. It was the shop's own type (ShopCodeWait); it is here now because the API answers it
+export const shopCodeWaitSchema = z.object({
+  next: z.literal('verify'),
+  maskedPhone: z.string().min(1),
+  resendInSeconds: z.number().int().min(0),
+  listingIds: z.array(listingIdSchema).min(1).max(SHOP_CART_MAX_LINES),
+});
+
 // An order's life (system design §14.3 storefront_orders.status). Cancelled and returned end it
 export const SHOP_ORDER_STATUSES = [
   'pending',
@@ -525,6 +562,7 @@ export type ShopOrderPlaced = z.infer<typeof shopOrderPlacedSchema>;
 export type ShopVerifyCodeRequest = z.infer<typeof shopVerifyCodeRequestSchema>;
 export type ShopOrderConfirmed = z.infer<typeof shopOrderConfirmedSchema>;
 export type ShopCodeResent = z.infer<typeof shopCodeResentSchema>;
+export type ShopCodeWait = z.infer<typeof shopCodeWaitSchema>;
 export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
 export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
 export type ShopOrder = z.infer<typeof shopOrderSchema>;
```

`ShopCodeWait` was a type in the shop (`apps/shop/src/data/types.ts`), built from the `verify` answer plus the
listing ids. It becomes a schema here, because the API now sends it and the shop must check it, like every answer
that comes over the network. The ids are at least one (an order has lines) and at most `SHOP_CART_MAX_LINES`.

### The order's own token

```diff
@@ -630,6 +668,12 @@ export const SHOP_TRACK_WINDOW_MINUTES = 15;
 // is the key, and the page checks the shape before it asks the source for anything
 export const shopTrackingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
 
+// Step 27a: the order's other token, the one in the browser's cookies (26c's decisions 4 and 5).
+// The same shape, but a different value from the tracking link's: this one opens /order/<no>, which
+// shows the buyer's phone and address, and it never leaves the browser that placed the order. The
+// tracking link goes by SMS and gets forwarded, so it opens only the page without them
+export const shopOrderTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
+
 // The couriers the system design's adapters cover (§14.6). Their own names are brand names and the
 // same in every language; the shop still writes them through t() (shop.track.couriers)
 export const SHOP_COURIERS = ['pathao', 'steadfast', 'redx', 'ecourier', 'paperfly'] as const;
```

The same shape as the tracking link's token (22 base64url characters, 128 random bits), but a separate schema with
its own name, because the two tokens open different things. The cookie's token opens `/order/<no>`, which shows the
buyer's phone and address, and it never leaves the browser. The tracking link goes by SMS and gets forwarded, so it
opens only the page without them (decision 16). Giving them separate names keeps a later change from passing one
where the other belongs. The mock's 64-hex tokens do not match on purpose: the shop never sends a mock token to the
API.

### The header, the bodies and the placed order

```diff
@@ -807,9 +851,39 @@ export function listingParamsFromQuery(query: ShopListingQuery): PublicListingPa
   return params;
 }
 
-// Orders, the phone code and tracking are not here: they stay in the shop's mock until step 27
-// stores orders (decision 1). The quote is here already: the cart drawer and the checkout need
-// today's prices and stock, and it only reads.
+// ---------------------------------------------------------------------------------------------
+// Step 27a: the shop server's calls for orders, the phone code and tracking.
+
+// The shop's server proves it is the shop's server with this header: a key only it and the API
+// know (the API's STOREFRONT_SHOP_KEY, the shop's SHOP_API_KEY). The routes below place orders,
+// send SMS and answer with a buyer's phone and address, so they are not for anyone who finds the
+// API's address, as the read routes above are. auth: 'shop' in the route says so
+export const SHOP_KEY_HEADER = 'x-shop-key';
+
+// The shopper's own address (IP), as the shop's server got it from its proxy. The API sees only the
+// shop's server, so the order limits (SHOP_ORDERS_PER_ADDRESS) and the /track limit need this.
+// Trusted only next to a right SHOP_KEY_HEADER: anyone else could send any address
+export const SHOP_CLIENT_ADDRESS_HEADER = 'x-shop-client-address';
+
+// The bodies that carry a token. Every one is a POST with the token in its body, never in the
+// path or the query: an address ends up in logs, a proxy's history and a Referer header, and these
+// tokens open a buyer's order (26e's decision 3 kept the /track form's phone out of addresses for
+// the same reason)
+const orderTokenBodySchema = z.object({ token: shopOrderTokenSchema });
+
+// What Confirm Order answers to the shop's server: the shopper's answer, and the token the server
+// puts in the httpOnly cookie. The token is only in this answer, never in the shopper's: the API
+// keeps only its hash, so this is the one moment it exists outside the cookie
+export const publicOrderPlacedSchema = z.object({
+  answer: shopOrderPlacedSchema,
+  token: shopOrderTokenSchema,
+});
+
+export type PublicOrderPlaced = z.infer<typeof publicOrderPlacedSchema>;
+
+// Orders, the phone code and tracking (step 27a) are under auth: 'shop', the read routes under
+// 'public'. The quote stays public: the cart drawer needs today's prices and stock, and it only
+// reads.
 export const publicStorefrontRoutes = {
   shop: defineRoute({
     method: 'GET',
```

- `SHOP_KEY_HEADER` is the shop server's proof (decision 13). The API's value is `STOREFRONT_SHOP_KEY`, the shop's
  `SHOP_API_KEY` (27a.3 and 27a.5 add them to the env files).
- `SHOP_CLIENT_ADDRESS_HEADER` carries the shopper's IP (decision 14). Without it, every order would come from the
  shop server's address, and the per-connection limit would stop the whole shop after 20 orders.
- `orderTokenBodySchema` is the body every token route shares. It is not exported: each route builds its body from
  it, and nothing else needs it.
- `publicOrderPlacedSchema` is what Confirm Order answers to the shop's server: the shopper's answer plus the token.
  The API keeps only the token's hash, so this answer is the one moment the token exists outside the cookie. The
  shop's server puts it in the cookie and sends only `answer` on to the browser (`server/orders.ts` already does
  this for the mock).

### The routes

```diff
@@ -880,4 +954,78 @@ export const publicStorefrontRoutes = {
     params: z.object({ slug: z.enum(SHOP_TEXT_PAGES) }),
     response: shopTextPageSchema,
   }),
+
+  // Step 27a. Confirm Order: the API prices the order again, holds its stock and sends the phone
+  // code. 201, as an order was made, even though it still waits for its code
+  placeOrder: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders',
+    summary: 'Place an order: price it, hold its stock and send the phone code (shop server only)',
+    auth: 'shop',
+    status: 201,
+    body: shopOrderRequestSchema,
+    response: publicOrderPlacedSchema,
+  }),
+  // The verify page's order, by the cookie's token. 404 shop_code_no_order when none waits
+  codeWait: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/code-wait',
+    summary: 'The order that waits for its phone code, by its token (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema,
+    response: shopCodeWaitSchema,
+  }),
+  verifyCode: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/verify',
+    summary: 'Check the phone code; a right one confirms the order (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema.extend(shopVerifyCodeRequestSchema.shape),
+    response: shopOrderConfirmedSchema,
+  }),
+  resendCode: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/resend',
+    summary: 'Send the phone code again (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema,
+    response: shopCodeResentSchema,
+  }),
+  // /order/<no>: both must match (26c's decision 5). 404 not_found for anything else
+  order: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/find',
+    summary:
+      'A confirmed order for the browser that placed it, by number and token (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema.extend({ orderNo: shopOrderNoSchema }),
+    response: shopOrderSchema,
+  }),
+  // A tracking link (/t/<token>). 404 not_found for a link that names no order
+  tracking: defineRoute({
+    method: 'POST',
+    path: '/public/v1/tracking',
+    summary:
+      "An order's tracking by its link's token: no name, phone or address (shop server only)",
+    auth: 'shop',
+    status: 200,
+    body: z.object({ token: shopTrackingTokenSchema }),
+    response: shopTrackingSchema,
+  }),
+  // The /track form. 404 shop_track_not_found for any wrong pair, 429 shop_track_too_many past
+  // SHOP_TRACK_TRIES misses from one address
+  track: defineRoute({
+    method: 'POST',
+    path: '/public/v1/track',
+    summary:
+      "An order's tracking by its number and the phone it was placed with (shop server only)",
+    auth: 'shop',
+    status: 200,
+    body: shopTrackRequestSchema,
+    response: shopTrackingSchema,
+  }),
 };
```

Seven routes, each answering a shape 26c or 26e already defined, so the shop's pages do not change:

| Route | What the shop's server asks | Answer |
|---|---|---|
| `POST /public/v1/orders` | Confirm Order | `publicOrderPlacedSchema` (201) |
| `POST /public/v1/orders/code-wait` | the verify page, by the cookie's token | `shopCodeWaitSchema` |
| `POST /public/v1/orders/verify` | the six digits, with the token | `shopOrderConfirmedSchema` |
| `POST /public/v1/orders/resend` | "Resend code" | `shopCodeResentSchema` |
| `POST /public/v1/orders/find` | `/order/<no>`, number and token | `shopOrderSchema` |
| `POST /public/v1/tracking` | a tracking link, by its token | `shopTrackingSchema` |
| `POST /public/v1/track` | the `/track` form, number and phone | `shopTrackingSchema` |

Every one is a `POST`, even the ones that only read, because each one carries a token or a phone, and those belong
in a body (decision 15). The verify body is built with `extend(shopVerifyCodeRequestSchema.shape)`, so its code is
cleaned the same way as the shop's form (Bangla digits, spaces). The find body uses `shopOrderNoSchema`, so
`w000123` is `W-000123`, as on `/track`.

### A third kind of route

```diff
@@ -13,7 +13,9 @@ export interface RouteDef {
   // OpenAPI-র এক লাইনের বিবরণ
   summary: string;
   // 'public' = লগইন ছাড়া; বাকি সব Bearer টোকেন চায় (API-র global AuthGuard)
-  auth: 'public' | 'bearer';
+  // Step 27a: 'shop' = no login either, but only the shop's own server may call it: it sends the
+  // key in SHOP_KEY_HEADER (storefront.ts), which the API checks before anything else
+  auth: 'public' | 'shop' | 'bearer';
   // এই কাজে কোন permission লাগে। API-র @Endpoint এখান থেকেই guard বসায় (আলাদা decorator নেই, তাই
   // চুক্তি আর পাহারা কখনো আলাদা হয় না), আর OpenAPI-তে x-permission হয়ে দেখায়। না থাকলে = শুধু লগইন
   permission?: PermissionKey;
```

```diff
@@ -43,7 +43,10 @@ function operation(tag: string, name: string, route: RouteDef) {
     tags: [tag],
     summary: route.summary,
     // খালি array = লগইন লাগে না; নাহলে global Bearer
-    security: route.auth === 'public' ? [] : [{ bearer: [] }],
+    // Step 27a: 'shop' routes name the shop server's key, so a reader of the document sees that
+    // they are not open to everyone like the 'public' ones
+    security:
+      route.auth === 'public' ? [] : route.auth === 'shop' ? [{ shopKey: [] }] : [{ bearer: [] }],
     // OpenAPI-র নিজের "কোন permission" ঘর নেই; x- দিয়ে শুরু হওয়া extension যেকোনো tool মেনে নেয়।
     // description-এও লেখা, কারণ Scalar-এর মতো viewer extension দেখায় না
     ...(route.permission !== undefined && {
@@ -98,6 +101,9 @@ export function buildOpenApiDocument(registry: RouteRegistry, options: OpenApiOp
     components: {
       securitySchemes: {
         bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
+        // The header's name is written out, not imported from storefront.ts: this file knows only
+        // routes, and openapi.spec.ts checks that the two names agree
+        shopKey: { type: 'apiKey', in: 'header', name: 'x-shop-key' },
       },
       schemas: { Problem: jsonSchema(problemSchema, 'output') },
       responses: {
```

`auth` had two values: `public` (no login) and `bearer` (the ERP's login). The shop's routes are neither: no person
logs in, but not everyone may call them. A third value says that in the contract itself, so the API's endpoint
builder (27a.3) puts the key check on exactly these routes, the same way `permission` puts the permission guard on
a route. Nobody has to remember a separate decorator.

The OpenAPI document gets a `shopKey` security scheme (`apiKey` in a header) and names it on these routes. A reader
of the API's docs then sees that they are not open like the read routes. The header's name is written out in
`openapi.ts`, because that file knows only routes, not the storefront. The test below checks that it is the same as
`SHOP_KEY_HEADER`, so the two cannot drift apart.

### Error codes

```diff
@@ -626,6 +626,12 @@ export const ERROR_CODES = [
   'shop_code_too_many',
   'shop_code_resend_wait',
   'shop_code_no_order',
+  // Step 27a: the API's own limits. Too many orders from one phone or one connection in an hour
+  // (params.minutes says how long to wait); a code typed after its 10 minutes (the shopper asks for
+  // a new one); all three codes of an order sent already (the shopper places the order again)
+  'shop_order_limit',
+  'shop_code_expired',
+  'shop_code_sends_used',
   // Step 26e: the /track form. An order number in another shape, no order with this number and
   // phone (one code for both: the form never says which of the two is wrong), and too many tries
   // from one connection (the problem's params.minutes says how long to wait)
@@ -636,6 +642,9 @@ export const ERROR_CODES = [
   // workspace has turned the shop off), and a listing's sale as the ERP's form sends it: a
   // percent that is not a whole 1 to 99, an amount of zero, an end not after its start
   'storefront_not_found',
+  // Step 27a: a call to a shop-server route without the shop server's key (SHOP_KEY_HEADER), or
+  // with a wrong one. 401: no shopper ever sees it, only a misconfigured shop server or a stranger
+  'storefront_shop_key_invalid',
   'storefront_sale_percent',
   'storefront_sale_zero',
   'storefront_sale_dates',
```

- `shop_order_limit`: too many orders from this phone or this connection. Its problem has `params.minutes`, like
  `shop_track_too_many`, so the words can say how long to wait.
- `shop_code_expired`: a code typed after its 10 minutes. The words say to ask for a new one, which the verify page
  offers right below.
- `shop_code_sends_used`: a fourth code. The order cannot be finished, so the words say to place it again.
- `storefront_shop_key_invalid`: 401 to a call without the key or with a wrong one. No shopper ever sees it. The
  words name `SHOP_API_KEY`, because the only person who meets it is the one who set up the shop's server.

```diff
@@ -7895,11 +7895,17 @@ export const en = {
     shop_code_too_many: 'Too many wrong codes. Place the order again to get a new code.',
     shop_code_resend_wait: 'Wait a little, then ask for a new code.',
     shop_code_no_order: 'No order is waiting for a code. Place the order again.',
+    // Step 27a: the API's limits on orders and codes
+    shop_order_limit: 'Too many orders from here. Wait {{minutes}} minutes, then try again.',
+    shop_code_expired: 'This code has expired. Ask for a new code.',
+    shop_code_sends_used: 'No more codes can be sent for this order. Place the order again.',
     shop_order_no_format: 'Type the order number from the SMS, like W-000123.',
     shop_track_not_found: 'No order has this number and mobile number. Check both, then try again.',
     shop_track_too_many: 'Too many tries. Wait {{minutes}} minutes, then try again.',
     storefront_not_found:
       'This address is not a shop. Check the address, or ask the shop for its link.',
+    storefront_shop_key_invalid:
+      'The shop’s server sent no key or a wrong key. Check SHOP_API_KEY.',
     storefront_sale_percent: 'Type a whole percent from 1 to 99.',
     storefront_sale_zero: 'Type an amount above ৳0.',
     storefront_sale_dates: 'Pick an end after the start, or leave the end empty.',
```

```diff
@@ -7375,11 +7375,17 @@ export const bn: Messages = {
     shop_code_too_many: 'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড পেতে আবার অর্ডার দিন।',
     shop_code_resend_wait: 'একটু অপেক্ষা করে নতুন কোড চান।',
     shop_code_no_order: 'কোনো অর্ডার কোডের অপেক্ষায় নেই। আবার অর্ডার দিন।',
+    shop_order_limit:
+      'এখান থেকে অনেকগুলো অর্ডার হয়েছে। {{minutes}} মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
+    shop_code_expired: 'এই কোডের মেয়াদ শেষ। নতুন কোড চান।',
+    shop_code_sends_used: 'এই অর্ডারের জন্য আর কোড পাঠানো যাবে না। আবার অর্ডার দিন।',
     shop_order_no_format: 'SMS-এর অর্ডার নম্বরটি লিখুন, যেমন W-000123।',
     shop_track_not_found:
       'এই নম্বর আর মোবাইল নম্বরের কোনো অর্ডার নেই। দুটোই দেখে আবার চেষ্টা করুন।',
     shop_track_too_many: 'অনেকবার চেষ্টা হয়েছে। {{minutes}} মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
     storefront_not_found: 'এই ঠিকানায় কোনো শপ নেই। ঠিকানাটা দেখুন, অথবা শপের কাছে লিংক চেয়ে নিন।',
+    storefront_shop_key_invalid:
+      'শপের সার্ভার কোনো key পাঠায়নি, বা ভুল key পাঠিয়েছে। SHOP_API_KEY দেখুন।',
     storefront_sale_percent: '১ থেকে ৯৯-এর মধ্যে একটা পূর্ণ শতাংশ লিখুন।',
     storefront_sale_zero: '৳০-এর বেশি একটা অঙ্ক লিখুন।',
     storefront_sale_dates: 'শুরুর পরের একটা শেষ সময় বাছুন, অথবা শেষ সময় ফাঁকা রাখুন।',
```

Error words live in `en.ts` and `bn.ts` with the other error codes (CLAUDE.md, "Language"), not in the shop's own
locale. `bn.ts` must have every key that `en.ts` has, or the type check fails.

### Tests

```diff
@@ -2,6 +2,11 @@ import { describe, expect, it } from 'vitest';
 
 import {
   listingParamsFromQuery,
+  maskPhone,
+  publicOrderPlacedSchema,
+  SHOP_KEY_HEADER,
+  shopCodeWaitSchema,
+  shopOrderTokenSchema,
   listingQueryFromParams,
   publicListingParamsSchema,
   publicShopSchema,
@@ -693,12 +698,90 @@ describe('public API', () => {
 
   it('has no login on any route, and every path under /public/v1', () => {
     for (const route of Object.values(publicStorefrontRoutes)) {
-      expect(route.auth).toBe('public');
+      expect(route.auth).not.toBe('bearer');
       expect(route.path.startsWith('/public/v1/')).toBe(true);
     }
   });
 });
 
+describe("the shop server's order routes (step 27a.1)", () => {
+  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
+
+  it("keeps every route that writes or shows an order behind the shop server's key", () => {
+    // The read routes stay open: a shop's pages show them to anyone. Everything that places an
+    // order, sends an SMS or answers with an order needs the key, so a stranger who finds the API
+    // cannot fill a shop with orders or walk its tracking links
+    const byAuth = (auth: 'public' | 'shop') =>
+      Object.entries(publicStorefrontRoutes)
+        .filter(([, route]) => route.auth === auth)
+        .map(([name]) => name)
+        .sort();
+    expect(byAuth('shop')).toEqual(
+      ['codeWait', 'order', 'placeOrder', 'resendCode', 'track', 'tracking', 'verifyCode'].sort(),
+    );
+    expect(byAuth('public')).toEqual(
+      [
+        'categories',
+        'checkoutSettings',
+        'home',
+        'listings',
+        'product',
+        'quote',
+        'shop',
+        'textPage',
+      ].sort(),
+    );
+    expect(SHOP_KEY_HEADER).toBe('x-shop-key');
+  });
+
+  it('never puts a token or a phone in an address', () => {
+    // POST with a body for every shop route: a path or a query ends up in logs and Referer headers
+    for (const route of Object.values(publicStorefrontRoutes)) {
+      if (route.auth !== 'shop') continue;
+      expect(route.method).toBe('POST');
+      expect(route.path).not.toContain(':');
+      expect('query' in route).toBe(false);
+    }
+  });
+
+  it("takes a 22-character base64url token, like a tracking link's", () => {
+    expect(shopOrderTokenSchema.safeParse(TOKEN).success).toBe(true);
+    expect(shopOrderTokenSchema.safeParse(`${TOKEN}A`).success).toBe(false);
+    // The mock's 64 hex digits are not the API's: the shop never sends one to the API
+    expect(shopOrderTokenSchema.safeParse('a'.repeat(64)).success).toBe(false);
+    expect(shopOrderTokenSchema.safeParse('AbCdEfGhIjKlMnOpQrSt+/').success).toBe(false);
+  });
+
+  it('checks the code and the token together on verify', () => {
+    const body = publicStorefrontRoutes.verifyCode.body;
+    expect(body.parse({ token: TOKEN, code: '১২৩ ৪৫৬' })).toEqual({ token: TOKEN, code: '123456' });
+    expect(body.safeParse({ code: '123456' }).success).toBe(false);
+  });
+
+  it('finds an order by its number however it was typed, with its token', () => {
+    const body = publicStorefrontRoutes.order.body;
+    expect(body.parse({ token: TOKEN, orderNo: 'w000123' })).toEqual({
+      token: TOKEN,
+      orderNo: 'W-000123',
+    });
+  });
+
+  it("answers the placed order with its token beside the shopper's answer", () => {
+    const placed = {
+      answer: { next: 'verify', maskedPhone: maskPhone('01786120356'), resendInSeconds: 45 },
+      token: TOKEN,
+    };
+    expect(publicOrderPlacedSchema.parse(placed)).toEqual(placed);
+    expect(placed.answer.maskedPhone).toBe('+880 17•• ••• 356');
+  });
+
+  it('says which listings the waiting order holds', () => {
+    const wait = { next: 'verify', maskedPhone: '+880 17•• ••• 356', resendInSeconds: 0 };
+    expect(shopCodeWaitSchema.safeParse({ ...wait, listingIds: ['l1'] }).success).toBe(true);
+    expect(shopCodeWaitSchema.safeParse({ ...wait, listingIds: [] }).success).toBe(false);
+  });
+});
+
 describe('public API answers (step 26f.3)', () => {
   it('takes a photo from storage over https, a path, or plain http on this computer only', () => {
     const ok = (url: string) => shopImageSchema.safeParse({ url, alt: 'Neem face wash' }).success;
```

```diff
@@ -2,6 +2,7 @@ import { describe, expect, it } from 'vitest';
 
 import { buildOpenApiDocument } from './openapi.js';
 import { routes } from './routes.js';
+import { SHOP_KEY_HEADER } from './storefront.js';
 
 const document = buildOpenApiDocument(routes, { version: '0.0.0' });
 
@@ -33,6 +34,16 @@ describe('OpenAPI document', () => {
     expect(logout?.responses['204']).toEqual({ description: 'No content' });
   });
 
+  it("marks the shop server's routes with its key, and names the key's header", () => {
+    expect(document.paths['/public/v1/orders']?.post?.security).toEqual([{ shopKey: [] }]);
+    expect(document.paths['/public/v1/shop']?.get?.security).toEqual([]);
+    expect(document.components.securitySchemes.shopKey).toEqual({
+      type: 'apiKey',
+      in: 'header',
+      name: SHOP_KEY_HEADER,
+    });
+  });
+
   it('names the permission a route needs, for tools and for people', () => {
     const invite = document.paths['/invitations']?.post;
     expect(invite).toMatchObject({
```

- The old test said every storefront route is `public`. It now says no route is `bearer`, and a new test lists
  which routes are `shop` and which are `public` by name. A new route has to be put on one list on purpose.
- "Never puts a token or a phone in an address" checks every `shop` route: `POST`, no `:param` in the path, no query.
  A later route that sends a token in its path fails here, before it reaches any log.
- The token test checks the length and the alphabet, and that the mock's 64-hex token is refused.
- The OpenAPI test checks the security on one `shop` route and one `public` route, and that the scheme's header is
  `SHOP_KEY_HEADER`.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test        # 622 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/shop typecheck        # still clean: the shop does not use the new routes yet
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/api typecheck
```

`apps/api/src/contract.spec.ts` now fails: the contract has 7 routes the API does not serve yet. 27a.3 adds them, and
`pnpm test:openapi` waits for 27a.3 as well, because `openapi.json` is written from the API's routes.

Broken on purpose while this part was written, each caught:

- `placeOrder` set to `auth: 'public'`: the route-list test and the OpenAPI test fail.
- `resendCode`'s path changed to `/public/v1/orders/resend/:token`: "never puts a token or a phone in an address"
  fails.

## 27a.2 — Database

Four new tables and one new role. The tables hold the order, its lines, the stock it holds and each shop's last
order number. The role is what the shop's order routes become, so a bug in them reaches the orders and nothing
else of the ERP.

### Permissions and the outbox event

```diff
@@ -55,6 +55,10 @@ export const PERMISSION_KEYS = [
   'pos.return.create',
   // Step 26g: everything in the Storefront menu, from the settings and the launch to the listings
   'storefront.manage',
+  // Step 27a: the shop's orders, apart from running the shop (decision 11). A packer reads them and
+  // moves them on without changing the shop's prices, and an order holds a phone and an address
+  'storefront.order.read',
+  'storefront.order.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -132,4 +136,6 @@ export const PERMISSION_GROUP_OF = {
   'pos.shift.manage': 'pos',
   'pos.return.create': 'pos',
   'storefront.manage': 'storefront',
+  'storefront.order.read': 'storefront',
+  'storefront.order.manage': 'storefront',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

```diff
@@ -70,6 +70,9 @@ const DESCRIPTIONS = {
     'Take goods back at a POS register and pay the money back, or use it for an exchange',
   'storefront.manage':
     'Run the online shop: its settings, categories, listings and photos, its look and pages, and open it to shoppers',
+  'storefront.order.read': "See the online shop's orders, with the buyers' phones and addresses",
+  'storefront.order.manage':
+    "Move the online shop's orders on (packed, shipped, delivered) and cancel them",
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

The two permissions of decision 11, in the `storefront` group that 26g made, so the Roles page shows them under the
same heading as `storefront.manage`. `syncPermissions()` writes them into the `permissions` table at every
`pnpm db:migrate`, so no migration inserts them. Nobody has them yet: 27a.3 adds them to the role templates for new
workspaces, and an owner gives them to a role in Settings → Roles.

```diff
@@ -6389,6 +6389,11 @@ export const en = {
     storefront: {
       manage:
         'Run the online shop: its settings, categories, listings and photos, its look and pages, and open it',
+      // Step 27a
+      order: {
+        read: 'See the shop’s orders, with the buyers’ phones and addresses',
+        manage: 'Move the shop’s orders on and cancel them',
+      },
     },
   },
   invite: {
```

```diff
@@ -5930,6 +5930,11 @@ export const bn: Messages = {
     },
     storefront: {
       manage: 'অনলাইন শপ চালানো: সেটিংস, ক্যাটাগরি, লিস্টিং আর ছবি, শপের চেহারা আর পেজ, আর শপ খোলা',
+      // Step 27a
+      order: {
+        read: 'শপের অর্ডার দেখা, ক্রেতার ফোন আর ঠিকানাসহ',
+        manage: 'শপের অর্ডার এগিয়ে নেওয়া আর বাতিল করা',
+      },
     },
   },
   invite: {
```

The Roles page writes each permission's name with `t('permissions.<key>')`, so a key without words would not
type-check in the app.

```diff
@@ -25,6 +25,9 @@ export const OUTBOX_EVENT_TYPES = [
   'report.schedule_due',
   'report.schedule_email',
   'storefront.image_uploaded',
+  // Step 27a: a shop order got its right phone code. The worker rings the bell of the members who
+  // read the orders; 27b also makes the customer and the sales order from it
+  'storefront.order_confirmed',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```

The confirm writes this event in its own transaction. 27a.3's handler rings the bell of the members with
`storefront.order.read`; 27b adds the customer and the sales order to the same event. Not the SMS: an SMS that
carries the code or the tracking link carries a secret, and an outbox row is kept in the database, so those go on
a queue of their own after the commit (27a.3).

`apps/api` stops type-checking here, as in 26g: the API's outbox needs a payload schema, a queue and a handler for
every event type. 27a.3 adds them.

### The order

```ts
import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_ORDER_STATUSES,
  SHOP_PAYMENT_METHODS,
  type StorefrontImage,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// Step 27a: the shop's orders. A shopper's request, not an ERP document (system design §14.3):
// it may be fake or cancelled, so it lives apart from sales_orders, and step 27b makes the sales
// order only once the order is confirmed. The shop's server writes these tables as omnivo_shop
// (migration 0071), the ERP's screens (27b) as omnivo_app.

// A SHA-256 or HMAC-SHA256 in lower-case hex, as document_shares keeps its token's hash
const HASH_PATTERN = '^[0-9a-f]{64}$';

// One order. It is "pending" while it waits for the phone code: then it has the code's columns and
// no number. The right code confirms it (decision 2): it gets its number and its tracking token,
// and the code's columns are emptied. A pending order is never kept: five wrong codes delete it at
// once, and the worker's sweep deletes the ones older than SHOP_ORDER_HOLD_MINUTES (decision 19)
export const storefrontOrders = pgTable(
  'storefront_orders',
  {
    id: baseColumns().id,
    // When the shopper pressed Confirm Order: the "Placed on" date and the first dot of the
    // timeline (shopOrderSchema.placedAt)
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    // The member who last changed it in the ERP (27b); NULL while only the shopper has
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "W-000123", given at confirm (decision 20). NULL while pending
    orderNo: text('order_no'),
    status: text('status', { enum: SHOP_ORDER_STATUSES }).notNull().default('pending'),
    // The delivery details as the shopper typed them. The checkout's rules (shopOrderRequestSchema)
    // again in the checks below, so a row the API did not write is still one the courier can use
    customerName: text('customer_name').notNull(),
    // 11 digits, "01786120356": shopPhoneSchema's form. The SMS, the limits and /track compare it
    // as it is, so one phone is always written one way
    phone: text('phone').notNull(),
    address: text('address').notNull(),
    // The zone the shopper picked, with its name and charge as they were. Copies: the tenant may
    // rename or remove a zone later, and the order must still say where it goes and what it cost
    zoneId: text('zone_id').notNull(),
    zoneName: text('zone_name').notNull(),
    paymentMethod: text('payment_method', { enum: SHOP_PAYMENT_METHODS }).notNull(),
    // The server's own sums, never the browser's (system design §14.4). discount and coupon_code
    // stay '0' and NULL until coupons come in 27c
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull(),
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    couponCode: text('coupon_code'),
    deliveryCharge: numeric('delivery_charge', { precision: 19, scale: 4 }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
    // The browser's token, kept in its httpOnly cookie (decision 16). Only its SHA-256 is here:
    // a leaked database dump cannot be turned back into cookies that open the orders
    orderTokenHash: text('order_token_hash').notNull(),
    // The tracking link's token (decision 9), made at confirm and sent by SMS. NULL while pending
    trackingTokenHash: text('tracking_token_hash'),
    // The phone code (decision 7), only while pending. The hash is an HMAC with the API's own key
    // over the order's id and the code: with a plain SHA-256, a leaked dump would give the code
    // back after a million tries, which takes a laptop a second
    codeHash: text('code_hash'),
    // When the code stops working (SHOP_CODE_VALID_MINUTES after it was sent)
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    // When the last code was sent: "Resend code" opens SHOP_CODE_RESEND_SECONDS after it
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    // How many codes were sent (1 to SHOP_CODE_SENDS), and how many wrong ones may still come
    codeSends: smallint('code_sends'),
    codeTriesLeft: smallint('code_tries_left'),
    // When each step happened: the order's history (shopOrderSchema.history) is read from these,
    // so there is no table of events to keep in step with the status
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    packedAt: timestamp('packed_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
  },
```

A new file, not more of `storefront.ts`: that file is what the shop shows, and these tables are what shoppers send.
They have different readers (section 3 of the rules migration below).

- **No number while pending** (decision 20). `order_no` is NULL until the right code. The page that waits for the
  code shows the masked phone, never a number, so nothing is lost.
- **`customer_name`, not `name`**, as in the system design (§14.3): 27b puts orders and customers on one screen, and
  "name" alone would be unclear there.
- **Copies of the zone.** `zone_id`, `zone_name` and the charge (in `delivery_charge`) are what the shopper picked.
  The tenant may rename a zone or change its charge tomorrow, and the order must still show what was agreed.
- **`discount` and `coupon_code` are here already.** The order page's answer (`shopOrderSchema`) has both, so the
  API reads them from the row. They stay `'0'` and NULL until 27c adds coupons.
- **Two token hashes** (decision 16). Text in hex, like `document_shares.token_hash`. Only the hash is stored: the
  cookie and the SMS hold the tokens, and a leaked database dump cannot open an order.
- **The code's columns.** `code_hash` is an HMAC keyed by the API's secret over the order's id and the code. A plain
  SHA-256 of six digits is no protection: a million guesses take a laptop about a second. With the key, a dump alone
  is not enough. The id in the HMAC makes the same code on two orders two different hashes. `code_sent_at` is when the
  last code went out: "Resend code" opens 45 seconds after it. `code_sends` counts the codes (at most 3) and
  `code_tries_left` the wrong ones still allowed.
- **One time column per step.** The order page's timeline (`history`) is built from these columns, oldest first, so
  there is no events table that could disagree with `status`. `created_at` is the "Placed on" date.

```ts
  (table) => [
    // The target of the lines' and the holds' FKs. A constraint, not a uniqueIndex like the other
    // tables' (tenant_id, id): drizzle writes a constraint inside CREATE TABLE, but an index after
    // every ALTER TABLE … ADD FOREIGN KEY, and Postgres refuses an FK whose target has no unique
    // index yet (42830). The lines and the holds are in the same migration, so the order matters
    unique('storefront_orders_tenant_id_key').on(table.tenantId, table.id),
    // One number, one order, in each shop. NULLs (pending orders) never collide
    uniqueIndex('storefront_orders_order_no_idx').on(table.tenantId, table.orderNo),
    // The cookie's and the link's lookups. A token is 128 random bits, so two orders never share
    // one; unique all the same, so a bug that wrote one twice fails here instead of opening
    // another person's order
    uniqueIndex('storefront_orders_order_token_idx').on(table.tenantId, table.orderTokenHash),
    uniqueIndex('storefront_orders_tracking_token_idx')
      .on(table.tenantId, table.trackingTokenHash)
      .where(sql`${table.trackingTokenHash} IS NOT NULL`),
    // The worker's sweep looks for old pending orders in EVERY workspace, so this index does not
    // start with tenant_id, like the outbox's. Partial: only the few pending rows are in it
    index('storefront_orders_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    check(
      'storefront_orders_order_no_check',
      sql`${table.orderNo} IS NULL OR ${table.orderNo} ~ '^W-[0-9]{6,9}$'`,
    ),
    check('storefront_orders_phone_check', sql`${table.phone} ~ '^01[3-9][0-9]{8}$'`),
    check(
      'storefront_orders_text_check',
      sql`char_length(${table.customerName}) BETWEEN 1 AND 80
        AND char_length(${table.address}) BETWEEN 10 AND 300
        AND char_length(${table.zoneId}) BETWEEN 1 AND 32
        AND char_length(${table.zoneName}) >= 1`,
    ),
    // The bill adds up: the total is what the courier collects, so it must be the parts' sum
    check(
      'storefront_orders_amounts_check',
      sql`${table.subtotal} > 0 AND ${table.discount} >= 0 AND ${table.discount} <= ${table.subtotal}
        AND ${table.deliveryCharge} >= 0
        AND ${table.total} = ${table.subtotal} - ${table.discount} + ${table.deliveryCharge}`,
    ),
    check(
      'storefront_orders_hashes_check',
      sql`${table.orderTokenHash} ~ '${sql.raw(HASH_PATTERN)}'
        AND (${table.trackingTokenHash} IS NULL OR ${table.trackingTokenHash} ~ '${sql.raw(HASH_PATTERN)}')
        AND (${table.codeHash} IS NULL OR ${table.codeHash} ~ '${sql.raw(HASH_PATTERN)}')`,
    ),
    // Two exact cases. Pending: every code column, and no number, no tracking token, no
    // confirmed_at. Anything after it: the other way round. So a confirmed order can never still
    // answer a code, and a pending one can never be tracked
    check(
      'storefront_orders_pending_check',
      sql`(${table.status} = 'pending'
          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 5
          AND num_nonnulls(${table.orderNo}, ${table.trackingTokenHash}, ${table.confirmedAt}) = 0)
        OR (${table.status} <> 'pending'
          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 0
          AND num_nonnulls(${table.orderNo}, ${table.trackingTokenHash}, ${table.confirmedAt}) = 3)`,
    ),
    // The code's counts stay inside the contract's rules. SHOP_CODE_TRIES wrong codes delete the
    // order, so a pending row has at least one try left
    check(
      'storefront_orders_code_check',
      sql`${table.codeSends} IS NULL OR (
        ${table.codeSends} BETWEEN 1 AND ${sql.raw(String(SHOP_CODE_SENDS))}
        AND ${table.codeTriesLeft} BETWEEN 1 AND ${sql.raw(String(SHOP_CODE_TRIES))}
        AND ${table.codeExpiresAt} > ${table.codeSentAt})`,
    ),
    // The time of the status the order is in is always known, and the two ends (cancelled,
    // returned) only on an order that ended that way. Which step may follow which is the API's
    // rule (27b), not the database's: a parcel can come back before or after it was delivered
    check(
      'storefront_orders_steps_check',
      sql`CASE ${table.status}
          WHEN 'packed' THEN ${table.packedAt} IS NOT NULL
          WHEN 'shipped' THEN ${table.shippedAt} IS NOT NULL
          WHEN 'delivered' THEN ${table.deliveredAt} IS NOT NULL
          ELSE true END
        AND (${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL)
        AND (${table.status} = 'returned') = (${table.returnedAt} IS NOT NULL)`,
    ),
  ],
);
```

- **`unique()`, not `uniqueIndex()`, for `(tenant_id, id)`.** Every other table here uses an index as the target of
  its composite foreign keys. drizzle-kit writes an index after all the `ALTER TABLE … ADD FOREIGN KEY` lines of a
  migration, and Postgres refuses a foreign key whose target has no unique index yet (error 42830). The lines and
  the holds point at the order in the same migration, so this one is a constraint: drizzle writes it inside
  `CREATE TABLE`, before any foreign key. 26h hit the same problem and solved it with two migrations; one
  constraint is simpler.
- **Unique token hashes.** 128 random bits never repeat by chance, so a second row with the same hash can only be a
  bug. Unique makes that bug fail, instead of letting a cookie open another person's order.
- **`storefront_orders_pending_idx` does not start with `tenant_id`.** The worker's sweep looks for old pending
  orders in every workspace at once, like the outbox relay. Partial: only the few pending rows are in it.
- **The checks repeat the checkout's rules** (`shopOrderRequestSchema`): the phone's 11 digits, the address's 10 to
  300 characters, the name's 80. The API checks first and answers with an error code; the database makes sure a
  row written any other way still holds what a courier can use.
- **`storefront_orders_amounts_check`.** The total is what the rider collects at the door, so it must be
  subtotal − discount + delivery. A rounding bug in the API then fails here instead of on the doorstep.
- **`storefront_orders_pending_check` has two exact cases**, like 26g's image states. Pending has all five code
  columns and no number, no tracking token, no confirm time. Every other status has the opposite. So a confirmed
  order can never answer a code, and a pending one can never be tracked or opened by number.
- **`storefront_orders_code_check`.** At least one try left: the fifth wrong code deletes the order, so a row with
  none cannot exist.
- **`storefront_orders_steps_check`** says the time of the current step is known, and that `cancelled_at` and
  `returned_at` are set only on an order that ended that way. It does not say which step may follow which: a parcel
  can come back before or after it was delivered, and 27b's API owns those rules.

### The lines

```ts

// What was bought, priced at the moment of the order. Copies of the listing (its name, link name,
// pack size and first photo), because the listing may change or go, and the order must still say
// what it was (shopOrderSchema's lines). Written once with the order, never changed.
export const storefrontOrderLines = pgTable(
  'storefront_order_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    // 1 = the cart's first line, so the order page lists them as the cart did
    position: smallint('position').notNull(),
    // The listing it came from, as a copy with no FK (decision 21): an FK would stop the tenant
    // from deleting a listing that was ever ordered, and the order needs only its id and words
    listingId: uuid('listing_id').notNull(),
    // The stock item. A real FK: 27b's sales order and challan need it, and a product that was
    // ordered cannot be deleted (it is archived instead), like every other document line
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    packSize: text('pack_size').notNull(),
    // The listing's first photo then (StorefrontImage: id and alt text)
    image: jsonb('image').$type<StorefrontImage>().notNull(),
    // In the product's base unit: a listing is priced per base unit ("Per Piece")
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'storefront_order_lines_pkey',
      columns: [table.tenantId, table.orderId, table.position],
    }),
    // A cart has each listing once (cartLinesSchema), so an order does too
    uniqueIndex('storefront_order_lines_listing_idx').on(
      table.tenantId,
      table.orderId,
      table.listingId,
    ),
    // A pending order's lines go with it
    foreignKey({
      name: 'storefront_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'storefront_order_lines_position_check',
      sql`${table.position} BETWEEN 1 AND ${sql.raw(String(SHOP_CART_MAX_LINES))}`,
    ),
    check(
      'storefront_order_lines_quantity_check',
      sql`${table.quantity} BETWEEN 1 AND ${sql.raw(String(SHOP_CART_MAX_QUANTITY))}`,
    ),
    check(
      'storefront_order_lines_amounts_check',
      sql`${table.unitPrice} > 0 AND ${table.lineTotal} > 0`,
    ),
    check(
      'storefront_order_lines_text_check',
      sql`char_length(${table.slug}) >= 1 AND char_length(${table.name}) >= 1 AND jsonb_typeof(${table.image}) = 'object'`,
    ),
  ],
);
```

- **The listing is a copy** (decision 21): its id, link name, name, pack size and first photo, as they were. A
  foreign key to `storefront_listings` would refuse "Delete listing" on any listing that was ever ordered, and the
  order page needs only these words. The link on the order page may later lead to "page not found"; the line still
  says what was bought.
- **The variant has a real foreign key.** 27b's sales order and challan need the stock item, and a product that was
  ordered is archived, never deleted, as with every document line.
- **`quantity` is an integer in the base unit.** A listing is priced per base unit ("Per Piece"), and the cart counts
  whole pieces from 1 to 99.
- **Position and one line per listing.** The order page lists them in the cart's order, and a cart has each listing
  once (`cartLinesSchema`).
- **CASCADE from the order.** When a pending order is dropped, its lines go in the same statement.

### The stock holds

```ts

// The stock an order holds (decision 6). The shop shows what is on hand in its warehouse minus
// what is held there, so the last piece is sold once. A pending order's hold ends at expires_at
// (SHOP_ORDER_HOLD_MINUTES after the order); confirm sets it to NULL, and the hold then lasts
// until 27b's challan takes the stock out for real. Its own table, not a column on the lines:
// omnivo_public reads it to count what is free, and it holds no name, phone or address.
export const storefrontStockHolds = pgTable(
  'storefront_stock_holds',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The shop's warehouse when the order was placed. A copy: if the tenant picks another
    // warehouse later, an order already confirmed is still picked where its stock was held
    warehouseId: uuid('warehouse_id').notNull(),
    // In the base unit, like stock_balances.quantity, so the two subtract with no conversion
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    // NULL = held until the challan (a confirmed order)
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    // One hold per variant per order: the lines are one per listing, a listing one per variant
    primaryKey({
      name: 'storefront_stock_holds_pkey',
      columns: [table.tenantId, table.orderId, table.variantId],
    }),
    // "How much of this variant is held in this warehouse": the shop's cards, the quote and every
    // order placed read this sum
    index('storefront_stock_holds_variant_idx').on(
      table.tenantId,
      table.warehouseId,
      table.variantId,
    ),
    // A dropped order frees its stock in the same statement
    foreignKey({
      name: 'storefront_stock_holds_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_stock_holds_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'storefront_stock_holds_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('storefront_stock_holds_quantity_check', sql`${table.quantity} > 0`),
  ],
);
```

Decision 6 in a table. The shop shows "In stock" when what is on hand in its warehouse, minus what is held there, is
above zero; 27a.3 changes `listing-sql.ts` and the quote to subtract this sum, and placing an order checks it under
a lock per variant.

- **`expires_at`.** A pending order's hold ends 60 minutes after the order. The sum counts a hold only while
  `expires_at` is NULL or in the future, so a dropped order frees its stock at that minute even before the sweep
  deletes it. Confirm sets it to NULL: the stock stays held until 27b's challan takes it out for real.
- **Its own table, not columns on the lines.** The shop's pages (`omnivo_public`) read the holds to count what is
  free. A hold has no name, phone or address, so the pages can read it without reading anything about the buyer.
- **The warehouse is a copy.** If the tenant picks another warehouse for the shop later, a confirmed order is still
  picked where its stock was held.
- **`quantity` is `numeric`,** like `stock_balances.quantity`, so the two subtract with no conversion.
- **The index** answers "how much of this variant is held in this warehouse", which every card, quote and order asks.

### The order numbers

```ts

// The last order number each shop gave (decision 20). Not number_series: a tenant may change an
// ERP document's prefix and year in Settings → Numbering, but the shop's /track form and links
// read "W-" and digits only (shopOrderNoSchema). Not a SEQUENCE either, for number_series'
// reason: a sequence does not roll back, and a confirm that failed would leave a gap. The row
// goes up inside the confirm's own transaction, and its row lock puts two confirms in a line.
export const storefrontOrderCounters = pgTable(
  'storefront_order_counters',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    lastValue: integer('last_value').notNull(),
  },
  (table) => [
    // W- and 6 to 9 digits: the number after 999,999,999 could not be written
    check('storefront_order_counters_value_check', sql`${table.lastValue} BETWEEN 1 AND 999999999`),
  ],
);
```

Decision 20. One row per shop, made by its first confirm. 27a.3 counts up with one statement:

```sql
-- The first confirm makes the row; every later one counts up. The row lock makes a second confirm
-- in the same shop wait for this one's commit, so two orders never get the same number
INSERT INTO storefront_order_counters (tenant_id, last_value) VALUES ($1, 1)
ON CONFLICT (tenant_id) DO UPDATE SET last_value = storefront_order_counters.last_value + 1
RETURNING last_value;
```

It is inside the confirm's transaction, so a confirm that fails gives its number back. That is why it is not a
`SEQUENCE`: a sequence never rolls back, and a gap in `W-000123` makes a shop owner ask where an order went.

```diff
@@ -53,3 +53,4 @@ export * from './sync.js';
 export * from './pos.js';
 export * from './report-schedules.js';
 export * from './storefront.js';
+export * from './storefront-orders.js';
```

### The migrations

```sql
CREATE TABLE "storefront_order_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "storefront_order_counters_value_check" CHECK ("storefront_order_counters"."last_value" BETWEEN 1 AND 999999999)
);
--> statement-breakpoint
CREATE TABLE "storefront_order_lines" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"listing_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"pack_size" text NOT NULL,
	"image" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"line_total" numeric(19, 4) NOT NULL,
	CONSTRAINT "storefront_order_lines_pkey" PRIMARY KEY("tenant_id","order_id","position"),
	CONSTRAINT "storefront_order_lines_position_check" CHECK ("storefront_order_lines"."position" BETWEEN 1 AND 50),
	CONSTRAINT "storefront_order_lines_quantity_check" CHECK ("storefront_order_lines"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "storefront_order_lines_amounts_check" CHECK ("storefront_order_lines"."unit_price" > 0 AND "storefront_order_lines"."line_total" > 0),
	CONSTRAINT "storefront_order_lines_text_check" CHECK (char_length("storefront_order_lines"."slug") >= 1 AND char_length("storefront_order_lines"."name") >= 1 AND jsonb_typeof("storefront_order_lines"."image") = 'object')
);
--> statement-breakpoint
CREATE TABLE "storefront_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_no" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"customer_name" text NOT NULL,
	"phone" text NOT NULL,
	"address" text NOT NULL,
	"zone_id" text NOT NULL,
	"zone_name" text NOT NULL,
	"payment_method" text NOT NULL,
	"subtotal" numeric(19, 4) NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"coupon_code" text,
	"delivery_charge" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"order_token_hash" text NOT NULL,
	"tracking_token_hash" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_sent_at" timestamp with time zone,
	"code_sends" smallint,
	"code_tries_left" smallint,
	"confirmed_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	CONSTRAINT "storefront_orders_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_orders_order_no_check" CHECK ("storefront_orders"."order_no" IS NULL OR "storefront_orders"."order_no" ~ '^W-[0-9]{6,9}$'),
	CONSTRAINT "storefront_orders_phone_check" CHECK ("storefront_orders"."phone" ~ '^01[3-9][0-9]{8}$'),
	CONSTRAINT "storefront_orders_text_check" CHECK (char_length("storefront_orders"."customer_name") BETWEEN 1 AND 80
        AND char_length("storefront_orders"."address") BETWEEN 10 AND 300
        AND char_length("storefront_orders"."zone_id") BETWEEN 1 AND 32
        AND char_length("storefront_orders"."zone_name") >= 1),
	CONSTRAINT "storefront_orders_amounts_check" CHECK ("storefront_orders"."subtotal" > 0 AND "storefront_orders"."discount" >= 0 AND "storefront_orders"."discount" <= "storefront_orders"."subtotal"
        AND "storefront_orders"."delivery_charge" >= 0
        AND "storefront_orders"."total" = "storefront_orders"."subtotal" - "storefront_orders"."discount" + "storefront_orders"."delivery_charge"),
	CONSTRAINT "storefront_orders_hashes_check" CHECK ("storefront_orders"."order_token_hash" ~ '^[0-9a-f]{64}$'
        AND ("storefront_orders"."tracking_token_hash" IS NULL OR "storefront_orders"."tracking_token_hash" ~ '^[0-9a-f]{64}$')
        AND ("storefront_orders"."code_hash" IS NULL OR "storefront_orders"."code_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "storefront_orders_pending_check" CHECK (("storefront_orders"."status" = 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 5
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 0)
        OR ("storefront_orders"."status" <> 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 0
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 3)),
	CONSTRAINT "storefront_orders_code_check" CHECK ("storefront_orders"."code_sends" IS NULL OR (
        "storefront_orders"."code_sends" BETWEEN 1 AND 3
        AND "storefront_orders"."code_tries_left" BETWEEN 1 AND 5
        AND "storefront_orders"."code_expires_at" > "storefront_orders"."code_sent_at")),
	CONSTRAINT "storefront_orders_steps_check" CHECK (CASE "storefront_orders"."status"
          WHEN 'packed' THEN "storefront_orders"."packed_at" IS NOT NULL
          WHEN 'shipped' THEN "storefront_orders"."shipped_at" IS NOT NULL
          WHEN 'delivered' THEN "storefront_orders"."delivered_at" IS NOT NULL
          ELSE true END
        AND ("storefront_orders"."status" = 'cancelled') = ("storefront_orders"."cancelled_at" IS NOT NULL)
        AND ("storefront_orders"."status" = 'returned') = ("storefront_orders"."returned_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "storefront_stock_holds" (
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "storefront_stock_holds_pkey" PRIMARY KEY("tenant_id","order_id","variant_id"),
	CONSTRAINT "storefront_stock_holds_quantity_check" CHECK ("storefront_stock_holds"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "storefront_order_counters" ADD CONSTRAINT "storefront_order_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_order_lines" ADD CONSTRAINT "storefront_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_stock_holds" ADD CONSTRAINT "storefront_stock_holds_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_order_lines_listing_idx" ON "storefront_order_lines" USING btree ("tenant_id","order_id","listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_order_no_idx" ON "storefront_orders" USING btree ("tenant_id","order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_order_token_idx" ON "storefront_orders" USING btree ("tenant_id","order_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_tracking_token_idx" ON "storefront_orders" USING btree ("tenant_id","tracking_token_hash") WHERE "storefront_orders"."tracking_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "storefront_orders_pending_idx" ON "storefront_orders" USING btree ("created_at") WHERE "storefront_orders"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "storefront_stock_holds_variant_idx" ON "storefront_stock_holds" USING btree ("tenant_id","warehouse_id","variant_id");
```

Made by drizzle-kit from the schema file:

```bash
pnpm --filter @omnivo/db generate --name storefront-orders
```

Check that `storefront_orders_tenant_id_key` is inside `CREATE TABLE "storefront_orders"`, before the `ALTER TABLE`
lines that add `storefront_order_lines_order_fk` and `storefront_stock_holds_order_fk`.

```sql
-- Custom SQL migration file, put your code below! --
-- Step 27a: who may read and write the shop's orders. 0070 made the four tables; this file gives
-- them the tenant rules every table has, lets the shop's pages count the held stock, and makes the
-- role the shop's order routes write as: omnivo_shop.

-- 1) The four new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002).
--    No TO, so it holds for every role: omnivo_app (the ERP's screens, 27b), omnivo_shop and
--    omnivo_public all set app.tenant_id to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_orders', 'storefront_order_lines', 'storefront_stock_holds',
      'storefront_order_counters'])
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

-- 2) The shop's pages count what is free: on hand minus held (decision 6). omnivo_public reads the
--    holds for that, and only the columns the sum needs: which order holds them is not its
--    business. A hold has no name, phone or address, which is why the holds are a table of their
--    own and not columns on the order lines. Only while the shop is launched, like every
--    storefront table it reads (0064)
GRANT SELECT (tenant_id, warehouse_id, variant_id, quantity, expires_at) ON storefront_stock_holds
  TO omnivo_public;
CREATE POLICY storefront_public_launched ON storefront_stock_holds
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_settings s WHERE s.tenant_id = storefront_stock_holds.tenant_id
  ));

-- 3) The role the order routes write as (decision 22). omnivo_public stays read-only: every page
--    of every shop reads as it, and none of them should ever be able to write. The order routes
--    (place, verify, resend, the order page, tracking) run in their own transaction as
--    omnivo_shop, which can do what omnivo_public does plus the orders, and nothing else in the
--    ERP. NOLOGIN, made here, and IF NOT EXISTS, for 0064's reasons
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'omnivo_shop') THEN
    CREATE ROLE omnivo_shop NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO omnivo_shop;
-- INHERIT TRUE: omnivo_shop gets omnivo_public's grants AND its RESTRICTIVE policies (a policy TO a
-- role holds for the roles that inherit from it). So placing an order sees exactly the listings,
-- prices and stock a shopper sees: a draft listing or another warehouse's stock cannot be ordered
-- by a bug, because the database does not show them. It also gets storefront_tenant_for_subdomain
GRANT omnivo_public TO omnivo_shop WITH INHERIT TRUE;
-- The API becomes it with SET LOCAL ROLE, like omnivo_public. INHERIT FALSE for 0064's reason: the
-- ERP must not get these rights, or the policies above, by being a member
GRANT omnivo_shop TO omnivo_app WITH INHERIT FALSE, SET TRUE;

-- 4) What omnivo_shop may write. No default privileges, so a table added later is closed to it.
-- An order: placed (INSERT), dropped after five wrong codes (DELETE; its lines and holds go by
-- CASCADE), and only these columns changed: the code's, and the confirm's. Packed, shipped,
-- delivered and cancelled are the ERP's (27b): a bug in the shop's routes cannot set them, nor
-- change an order's address or amounts after it was placed
GRANT SELECT, INSERT, DELETE ON storefront_orders TO omnivo_shop;
GRANT UPDATE (status, order_no, tracking_token_hash, confirmed_at, code_hash, code_expires_at,
  code_sent_at, code_sends, code_tries_left, updated_at, version) ON storefront_orders TO omnivo_shop;
-- Lines are written once, with the order
GRANT SELECT, INSERT ON storefront_order_lines TO omnivo_shop;
-- Holds: made with the order; confirm ends their expiry. SELECT on every column (the grant to
-- omnivo_public above has five): the confirm finds an order's holds by order_id
GRANT SELECT, INSERT ON storefront_stock_holds TO omnivo_shop;
GRANT UPDATE (expires_at) ON storefront_stock_holds TO omnivo_shop;
-- The number at confirm: INSERT … ON CONFLICT DO UPDATE, which needs all three
GRANT SELECT, INSERT, UPDATE ON storefront_order_counters TO omnivo_shop;
-- Confirm writes storefront.order_confirmed in the same transaction (the bell, and 27b's sales
-- order). INSERT only, as for omnivo_app since 0012: the outbox is the worker's to read
GRANT INSERT ON outbox_events TO omnivo_shop;

-- 5) The worker's sweep (decision 19) drops the pending orders older than SHOP_ORDER_HOLD_MINUTES
--    in EVERY workspace, so tenant_isolation alone would show it nothing. As in 0062: it reads as
--    omnivo_worker, three columns of the pending rows only, enough to know which workspaces have
--    one to drop. The DELETE then runs as omnivo_app inside each workspace. The worker never sees
--    a name, a phone, or a confirmed order
GRANT SELECT (tenant_id, status, created_at) ON storefront_orders TO omnivo_worker;
CREATE POLICY storefront_order_sweep ON storefront_orders
  FOR SELECT
  TO omnivo_worker
  USING (status = 'pending');
```

Written by hand: drizzle-kit cannot write row security, roles or grants. Start it with

```bash
pnpm --filter @omnivo/db generate --custom --name storefront-orders-rules
```

and replace its one comment line with the file above.

1. **The tenant rules,** as on every tenant table since 0002. `FORCE` keeps the table's owner inside them too.
2. **`omnivo_public` reads five columns of the holds**, the ones the "free stock" sum needs. Not `order_id`: which
   order holds what is not the shop pages' business. The `RESTRICTIVE` policy is 0064's "only while the shop is
   launched", as on every storefront table the role reads.
3. **The new role, `omnivo_shop`** (decision 22). It is a member of `omnivo_public` `WITH INHERIT TRUE`, so it gets
   that role's grants and its restrictive policies: placing an order sees exactly the listings, prices and stock
   a shopper sees. A draft listing, an archived product or the factory's stock cannot be ordered by a bug, because
   the database does not show them to this role. The API becomes it with `SET LOCAL ROLE omnivo_shop`, as it
   becomes `omnivo_public` today. `omnivo_app` is a member `WITH INHERIT FALSE`, for 0064's reason: if `omnivo_app`
   inherited it, the shop's restrictive policies would hold for the ERP's own screens too, and the ERP would stop
   seeing every product that is not in the shop.
4. **What it may write.** It places an order (INSERT), drops one after five wrong codes (DELETE), and changes only
   the code's and the confirm's columns. Column grants, not a table grant: the shop's routes cannot change an
   order's address or amounts after it was placed, nor set `packed_at` or `cancelled_at`. It may write `status`,
   but `storefront_orders_steps_check` then needs a time it cannot write, so in practice it can only confirm.
   Lines are written once; holds get only their expiry changed. It has no DELETE on lines or holds: when it deletes
   an order, the `ON DELETE CASCADE` removes them anyway, because Postgres runs a foreign key's action as the
   table's owner. It may add outbox rows and never read them, like `omnivo_app` since 0012.
5. **The worker's sweep** reads three columns of the pending rows of every workspace, as `omnivo_worker`, with a
   policy for that role only (0062 did the same for the report schedules). That is enough to know which workspaces
   have an order to drop. The `DELETE` then runs as `omnivo_app` inside each workspace (27a.3). The worker never
   sees a name, a phone or a confirmed order.

### Check this part

```bash
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/contracts test   # 622 tests
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n test             # 21 tests
pnpm --filter @omnivo/db build && pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/app typecheck
pnpm db:migrate
```

`pnpm --filter @omnivo/api typecheck` fails until 27a.3, with `storefront.order_confirmed` missing from the
outbox's maps (`outbox.ts`, `queues.ts`, `handlers.ts`, `job-runner.ts`).

What was checked on a throwaway Postgres 17, migrated to the end, with two launched shops and a confirmed order
in one of them. As `omnivo_app` becoming `omnivo_shop`:

- an order, its line and its hold are placed; the role sees one order (not the other shop's), one variant (not the
  draft listing's), and 5 pieces of stock (the shop's warehouse, not the factory's 7). It cannot read a variant's
  `option_values`.
- on hand minus the held 2 is 3;
- a bad hash, a 10-digit phone, a total that does not add up, and zero tries left are each refused by their own
  check; a pending order with a number, or a confirmed one that still has its code, by
  `storefront_orders_pending_check`;
- it cannot change the address, the total or `packed_at`, a hold's quantity, a line, or a listing (42501), and
  cannot read the outbox;
- the counter gives 1; the confirm passes, and Acme's `W-000001` lives beside the other shop's `W-000001`;
  `delivered` and `cancelled` are refused by `storefront_orders_steps_check`; a row for the other workspace is
  refused by row security;
- the same order token twice and the same listing twice are refused; deleting a pending order takes its line and
  hold with it.

As `omnivo_public`: it sums the confirmed hold, cannot read `order_id`, the orders or the lines, and cannot write
a hold. As `omnivo_app` itself: it sees every variant (the shop's policies do not hold for it) and can move an order
to packed. As `omnivo_worker`: it sees only the one old pending order of all three, cannot read a phone, cannot
delete.

Broken on purpose, each caught:

- `GRANT omnivo_shop TO omnivo_app WITH INHERIT TRUE`: `omnivo_app` sees one variant instead of two.
- `GRANT UPDATE ON storefront_orders TO omnivo_shop` (the whole table): changing the address works.

## 27a.3 — The API

The seven routes of 27a.1 now work. The shop's server calls them with its key; each one runs as `omnivo_shop`
(27a.2) inside the shop's workspace; the phone code and the tracking link go out by SMS after the transaction
commits; the worker rings a bell for each confirmed order and deletes the orders that never got their code.

Decided while writing this part (the user may still object):

23. **The phone code's key comes from `JWT_SECRET`**, through HKDF with its own label, not from a new secret. HKDF
    gives a key that says nothing about the JWT secret and cannot sign a token. Changing `JWT_SECRET` signs everyone
    out anyway; here it only spoils the codes of the next 10 minutes.
24. **`STOREFRONT_SHOP_KEY` is optional.** Without it every order route answers 401, so an API with no shop set up
    starts and works as before, and staging (still on the mock shop) needs nothing new.
25. **The key is checked by its own global guard,** `ShopKeyGuard`, between `AuthGuard` and `PermissionGuard`, read
    from the contract like the other two. Not inside `AuthGuard`, which knows nothing of the config and is used
    alone in a unit test.
26. **The SMS goes on its own BullMQ queue,** `sms`, never through the outbox: an outbox row carries ids, and these
    texts carry a code or a link. The job is deleted from Redis once it is sent or has failed for good. A lost SMS
    never fails the answer: the order is already saved, and the shopper can ask for the code again.
27. **A line asks for more than is free → `out_of_stock` in the quote.** The quote has no "only 3 left", and calling
    it available would make Confirm Order fail on it again and again.
28. **The limits count per phone and per connection across all shops,** under hashed keys, and only orders that were
    placed count. Redis down is an error (500), never "no limits".
29. **The checkout stops offering Mobile Banking until 27c** connects a gateway, unless it is the shop's only method
    (the contract needs one); placing such an order is refused as `shop_payment_unavailable`.
30. **The bell** (`storefront.order_confirmed`) goes to the owners and to everyone with `storefront.order.read`, and
    opens the overview until 27b's Orders page exists.
31. **A code past its 10 minutes costs no try,** and "Resend code" says that all codes are used before it says to
    wait: no wait would help.
32. **The two roles that run a shop get both order permissions** in the role templates of new workspaces.
42. **One exception to `queue-only-in-worker`, for `sms/sms-queue.ts`** (added in 27a.6, your choice). `pnpm
    boundaries` refused the API's SMS producer and the SMS runner. The runner moved into `worker/`; the producer stays
    in the API, named in the rule with the reason. The other way, an outbox event with the code and the link stored
    encrypted on the order, would change the database, the API and the tests for one benefit (an SMS that survives
    Redis being down at that moment), and the shopper can already ask for the code again.

### The shop server's key

```diff
@@ -1,3 +1,5 @@
+import { hkdfSync } from 'node:crypto';
+
 import { z } from 'zod';
 
 // Both processes (API and worker) read the same .env, but each checks only what it uses. So the
@@ -46,6 +48,11 @@ const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
   // shop"). In dev the shop's server has its own port (apps/shop runs on 4321); behind a proxy the
   // address has none. Left out: 4321 outside production, none in production
   SHOP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
+  // Step 27a: the key the shop's server sends in X-Shop-Key on the order routes (27a's decision
+  // 13); the shop's own SHOP_API_KEY has the same value. Long and random, like the JWT secret
+  // (openssl rand -base64 32). Left out: the order routes answer 401 to everyone, so a shop with
+  // no key set can show its pages but take no orders, and nothing else in the API changes
+  STOREFRONT_SHOP_KEY: z.string().min(32).optional(),
 });
 
 const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
@@ -100,6 +107,14 @@ function storefrontMediaUrl(e: z.output<typeof envSchema>): string {
   return url;
 }
 
+// Step 27a: the key of the phone code's HMAC (storefront/orders/order-secrets.ts), derived from
+// JWT_SECRET with HKDF instead of being one more secret to set. HKDF with its own label gives a key
+// that tells nothing about the JWT secret, and that no JWT can be signed with. Changing JWT_SECRET
+// signs everyone out anyway; here it only spoils the codes of the next 10 minutes
+function phoneCodeKey(jwtSecret: string): Buffer {
+  return Buffer.from(hkdfSync('sha256', jwtSecret, '', 'omnivo storefront phone code', 32));
+}
+
 export function loadConfig(env: Record<string, string | undefined>) {
   const e = parseEnv(envSchema, env);
   return {
@@ -122,6 +137,9 @@ export function loadConfig(env: Record<string, string | undefined>) {
       // production, where the browser would refuse a shop on plain http anyway
       shopScheme: e.NODE_ENV === 'production' ? 'https' : 'http',
       shopPort: e.SHOP_PUBLIC_PORT ?? (e.NODE_ENV === 'production' ? null : 4321),
+      // Step 27a: null = no shop server may call the order routes (STOREFRONT_SHOP_KEY above)
+      shopKey: e.STOREFRONT_SHOP_KEY ?? null,
+      codeKey: phoneCodeKey(e.JWT_SECRET),
     },
     auth: {
       betterAuthSecret: e.BETTER_AUTH_SECRET,
```

- `STOREFRONT_SHOP_KEY` is at least 32 characters, like the JWT secret, so it cannot be guessed. It is optional
  (decision 24): `shopKey` is `null` without it, and `ShopKeyGuard` below then refuses every call.
- `phoneCodeKey()` derives the code's HMAC key from `JWT_SECRET` (decision 23). `hkdfSync` returns an
  `ArrayBuffer`; `Buffer.from` makes it the `Buffer` that `createHmac` takes. The label (`'omnivo storefront phone
  code'`) is what makes this key different from any other key derived from the same secret later.

```diff
@@ -23,7 +23,7 @@ function env(extra: Record<string, string>): Record<string, string> {
 describe('storefront config', () => {
   it('serves the photos from the storage bucket in dev, on localhost', () => {
     const { storefront } = loadConfig(env({}));
-    expect(storefront).toEqual({
+    expect(storefront).toMatchObject({
       baseDomain: 'localhost',
       mediaUrl: 'http://localhost:9000/omnivo',
       shopScheme: 'http',
@@ -39,7 +39,7 @@ describe('storefront config', () => {
         STOREFRONT_MEDIA_URL: 'https://media.omnivo.shop/',
       }),
     );
-    expect(storefront).toEqual({
+    expect(storefront).toMatchObject({
       baseDomain: 'omnivo.shop',
       mediaUrl: 'https://media.omnivo.shop',
       shopScheme: 'https',
@@ -79,3 +79,24 @@ describe('storefront config', () => {
     }
   });
 });
+
+// Step 27a: the shop server's key and the phone code's key
+describe('order keys', () => {
+  it('has no shop key until one is set, and refuses a short one', () => {
+    expect(loadConfig(env({})).storefront.shopKey).toBeNull();
+    const key = 'a-shop-key-of-at-least-thirty-two-chars';
+    expect(loadConfig(env({ STOREFRONT_SHOP_KEY: key })).storefront.shopKey).toBe(key);
+    expect(() => loadConfig(env({ STOREFRONT_SHOP_KEY: 'short' }))).toThrow(/Invalid environment/);
+  });
+
+  it('derives the code key from JWT_SECRET: 32 bytes, never the secret itself', () => {
+    const { codeKey } = loadConfig(env({})).storefront;
+    expect(codeKey).toHaveLength(32);
+    expect(codeKey.toString('utf8')).not.toContain('test-jwt-secret');
+    // The same secret gives the same key (a code sent before a restart still works) …
+    expect(loadConfig(env({})).storefront.codeKey.equals(codeKey)).toBe(true);
+    // … and another secret another key
+    const other = loadConfig(env({ JWT_SECRET: 'another-jwt-secret-that-is-32-bytes-long' }));
+    expect(other.storefront.codeKey.equals(codeKey)).toBe(false);
+  });
+});
```

The first two tests used `toEqual` on the whole `storefront` object, which now also has the two keys, so they use
`toMatchObject`: they are about the addresses, not the keys. The new tests check that a short key is refused, and
that the code key is 32 bytes, stable for one secret (a code sent before a restart still works after it), and
different for another.

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

import { AppError } from '../common/http/app-error.js';

// Step 27a: is this call from the shop's own server? (27a's decision 13.) The shop's server sends
// the key in SHOP_KEY_HEADER on every order route; the API's is STOREFRONT_SHOP_KEY.
//
// Both sides are hashed first, then compared with timingSafeEqual: a plain === stops at the first
// different character, so the time it takes tells a patient stranger how much of a guess was
// right. timingSafeEqual needs two buffers of one length, and two SHA-256 digests always are, so
// the length of the guess tells nothing either.
export function shopKeyMatches(sent: string | undefined, expected: string | null): boolean {
  // No key set on this API: no shop server may call the order routes (config.ts)
  if (expected === null || sent === undefined) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(sent), digest(expected));
}

// The one answer for a missing or a wrong key. 401: the call is not from someone the API knows
export function shopKeyInvalid(): AppError {
  return new AppError(
    401,
    'storefront_shop_key_invalid',
    "This route is for the shop's server, with its key in X-Shop-Key.",
  );
}
```

Both sides are hashed before the compare. `timingSafeEqual` needs two buffers of the same length; two SHA-256
digests always are, so neither the time nor a thrown "different length" error tells a stranger how close a guess
was. A plain `===` stops at the first wrong character, and that is measurable over many tries.

```ts
import { describe, expect, it } from 'vitest';

import { shopKeyMatches } from './shop-key.js';

const KEY = 'a-shop-key-of-at-least-thirty-two-chars';

describe('shopKeyMatches', () => {
  it('takes only the exact key', () => {
    expect(shopKeyMatches(KEY, KEY)).toBe(true);
    expect(shopKeyMatches(`${KEY} `, KEY)).toBe(false);
    expect(shopKeyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(shopKeyMatches('', KEY)).toBe(false);
  });

  it('refuses every call when no key was sent, or none is set', () => {
    expect(shopKeyMatches(undefined, KEY)).toBe(false);
    expect(shopKeyMatches(KEY, null)).toBe(false);
  });
});
```

```ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { SHOP_KEY_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

import { routeOf } from '../common/http/endpoint.js';
import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { shopKeyInvalid, shopKeyMatches } from './shop-key.js';

// Step 27a: the guard of the routes the contract marks auth: 'shop' (27a's decision 13). Global,
// between AuthGuard and PermissionGuard (app.module.ts), like them read from the contract: a route
// is guarded because its contract says 'shop', never because someone remembered a decorator. Every
// other route passes straight through. It runs before the body is parsed, so a call without the
// key costs no database work and learns nothing about the shop.
@Injectable()
export class ShopKeyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    if (routeOf(context)?.auth !== 'shop') return true;
    const sent = context.switchToHttp().getRequest<FastifyRequest>().headers[SHOP_KEY_HEADER];
    // A header sent twice arrives as an array, which is no key at all
    if (
      !shopKeyMatches(typeof sent === 'string' ? sent : undefined, this.config.storefront.shopKey)
    ) {
      throw shopKeyInvalid();
    }
    return true;
  }
}
```

The guard reads the route's contract with `routeOf`, like `PermissionGuard`. So a route is guarded because its
contract says `auth: 'shop'`, and a new shop route needs nothing more. Guards run before the body is parsed
(`ContractInput` runs with the handler), so a call without the key costs no parsing and no database work.

```diff
@@ -39,6 +39,7 @@ import { RolesModule } from './roles/roles.module.js';
 import { SalesModule } from './sales/sales.module.js';
 import { SettingsModule } from './settings/settings.module.js';
 import { SetupModule } from './setup/setup.module.js';
+import { ShopKeyGuard } from './storefront/shop-key.guard.js';
 import { StorefrontModule } from './storefront/storefront.module.js';
 import { SyncModule } from './sync/sync.module.js';
 import { TaxModule } from './tax/tax.module.js';
@@ -82,6 +83,8 @@ export class AppModule implements NestModule {
       providers: [
         // ক্রম গুরুত্বপূর্ণ: আগে "কে" (AuthGuard → 401), তারপর "কী করতে পারে" (PermissionGuard → 403)
         { provide: APP_GUARD, useClass: AuthGuard },
+        // Step 27a: "who" for the shop's server: its key, on the 'shop' routes only (→ 401)
+        { provide: APP_GUARD, useClass: ShopKeyGuard },
         { provide: APP_GUARD, useClass: PermissionGuard },
         // প্রতিটা response চুক্তির schema দিয়ে যাচাই আর অচেনা ফিল্ড ছাঁটাই
         { provide: APP_INTERCEPTOR, useClass: ContractInterceptor },
```

```diff
@@ -2,6 +2,7 @@ import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/com
 import { Reflector } from '@nestjs/core';
 
 import { AppError } from '../common/http/app-error.js';
+import { routeOf } from '../common/http/endpoint.js';
 import { tenantStorage } from '../common/tenant/tenant-context.js';
 import { IS_PUBLIC_KEY } from './public.decorator.js';
 
@@ -10,6 +11,10 @@ export class AuthGuard implements CanActivate {
   constructor(private readonly reflector: Reflector) {}
 
   canActivate(context: ExecutionContext): boolean {
+    // Step 27a: a route the contract marks auth: 'shop' is called by the shop's server, not by a
+    // person, so it has no token to look for. ShopKeyGuard, the next guard, checks its key instead
+    if (routeOf(context)?.auth === 'shop') return true;
+
     // method-এর decorator আগে, না থাকলে class-এর
     const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
       context.getHandler(),
```

```diff
@@ -14,8 +14,9 @@ export class PermissionGuard implements CanActivate {
 
   async canActivate(context: ExecutionContext): Promise<boolean> {
     const route = routeOf(context);
-    // চুক্তির বাইরের রুট (/docs) আর public রুট (লগইন) — এখানে দেখার কিছু নেই
-    if (!route || route.auth === 'public') return true;
+    // চুক্তির বাইরের রুট (/docs) আর public রুট (লগইন) — এখানে দেখার কিছু নেই। Step 27a: nor a
+    // 'shop' route: the shop's server is no member of any workspace, and ShopKeyGuard checked its key
+    if (route?.auth !== 'bearer') return true;
 
     // প্রতিটা লগইন-করা request-এ, permission চাক বা না চাক: বাদ পড়া সদস্যের টোকেন আরও ১৫ মিনিট বৈধ,
     // কিন্তু সে সেই সময়ে ব্রাঞ্চের তালিকাও পড়তে পারবে না। দাম: প্রতি request-এ একটা Redis GET
```

- `AuthGuard` lets a `shop` route through: the shop's server has no person's token. It does not mark the routes
  `Public()`: a route that is public in one guard and keyed in another would be easy to misread later.
- `PermissionGuard` now looks only at `bearer` routes. Before, it returned early for `public` only, so a `shop` route
  would have asked for a workspace member and failed with `access_revoked`.

Why a new guard and not a check inside `AuthGuard`: `auth.middleware.spec.ts` builds a small app with `AuthGuard`
and no config. A guard that needs the config would break that test, and the config has nothing to do with tokens.

```diff
@@ -7,6 +7,9 @@ import { type Config, loadConfig, loadWorkerConfig, type WorkerConfig } from '..
 import { configureApp, createAdapter } from '../configure-app.js';
 import { WorkerModule } from '../worker/worker.module.js';
 
+// Step 27a: the shop server's key in the tests, sent in X-Shop-Key on the order routes
+export const TEST_SHOP_KEY = 'test-shop-key-that-is-at-least-32-bytes';
+
 // .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
 // storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
 export function testConfig(urls: {
@@ -25,6 +28,7 @@ export function testConfig(urls: {
     S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
     S3_ACCESS_KEY_ID: 'omnivo',
     S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
+    STOREFRONT_SHOP_KEY: TEST_SHOP_KEY,
   });
 }
 
```

```diff
@@ -35,6 +35,10 @@ SHOP_BASE_DOMAIN=localhost
 # Step 26g: the port in a shop's address for the Storefront screens' "View shop" link. Left out:
 # 4321 (the shop's dev server) outside production, none in production
 # SHOP_PUBLIC_PORT=4321
+# Step 27a: the key the shop's server sends on the order routes (X-Shop-Key). The shop's own
+# SHOP_API_KEY must have the same value. Left out, the API takes no orders (every order route
+# answers 401). At least 32 characters; make a real one with: openssl rand -base64 32
+STOREFRONT_SHOP_KEY=dev-only-shop-key-change-me-0123456789abcdef
 # Step 26f.5: the shop's server (apps/shop) reads these two, not the API. Left out, it shows the
 # mock shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
 # pnpm --filter @omnivo/shop dev, then open http://<subdomain>.localhost:4321
```

The tests and the dev `.env` get a key, so the order routes work out of the box. `TEST_SHOP_KEY` is exported for
27a.4's tests, which send it in `x-shop-key`. CI copies `.env.example`, so it gets the same dev key.

### The shopper's address

```diff
@@ -668,6 +668,31 @@ export const SHOP_TRACK_WINDOW_MINUTES = 15;
 // is the key, and the page checks the shape before it asks the source for anything
 export const shopTrackingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
 
+// Step 27a: the key a connection's limits are counted under (the /track form's misses, the orders
+// per connection). Moved here from the shop's server (26e's rate-limit.ts), because the API now
+// keeps both limits. An IPv4 address is its own key; an IPv6 address counts by its /64, because
+// one home or phone gets a whole /64 and could change the last half of its address at will.
+export function addressKey(address: string): string {
+  // "%en0" is a link-local address's interface name, not part of the address
+  const plain = address.trim().toLowerCase().replace(/%.*$/, '');
+  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7"), which Node gives on a server that
+  // listens on both
+  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
+  if (mapped?.[1] !== undefined) return mapped[1];
+  if (!plain.includes(':')) return plain;
+
+  // "2001:db8::7" leaves out the groups that are zero. Put them back, so "2001:db8::7" and
+  // "2001:db8:0:0::8" give the same /64
+  const [head = '', tail] = plain.split('::');
+  const headGroups = head === '' ? [] : head.split(':');
+  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
+  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
+  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
+  // Leading zeros dropped too ("0db8" and "db8" are the same group)
+  const block = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
+  return `${block.join(':')}::/64`;
+}
+
 // Step 27a: the order's other token, the one in the browser's cookies (26c's decisions 4 and 5).
 // The same shape, but a different value from the tracking link's: this one opens /order/<no>, which
 // shows the buyer's phone and address, and it never leaves the browser that placed the order. The
```

`addressKey()` moves from the shop's server (26e's `rate-limit.ts`) into the contracts, because the API now keeps
both limits that use it. An IPv6 address counts by its /64: one home or phone gets a whole /64 and can change the
last half of its address at will. 27a.5 deletes the shop's copy.

```diff
@@ -1,6 +1,7 @@
 import { describe, expect, it } from 'vitest';
 
 import {
+  addressKey,
   listingParamsFromQuery,
   maskPhone,
   publicOrderPlacedSchema,
@@ -803,3 +804,24 @@ describe('public API answers (step 26f.3)', () => {
     ).toBe(true);
   });
 });
+
+// Step 27a: moved from the shop's server (26e), with its cases, because the API counts by it now
+describe('addressKey', () => {
+  it('keeps an IPv4 address as it is, also when Node writes it as IPv6', () => {
+    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
+    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
+  });
+
+  it('counts an IPv6 address by its /64 block, however it is written', () => {
+    const block = addressKey('2001:db8:1:2::a');
+    expect(block).toBe('2001:db8:1:2::/64');
+    expect(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe(block);
+    expect(addressKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
+    expect(addressKey('2001:db8::7')).toBe('2001:db8:0:0::/64');
+    expect(addressKey('::1')).toBe('0:0:0:0::/64');
+  });
+
+  it('gives two neighbouring blocks two keys', () => {
+    expect(addressKey('2001:db8:1:2::a')).not.toBe(addressKey('2001:db8:1:3::a'));
+  });
+});
```

```ts
import { isIP } from 'node:net';

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { SHOP_CLIENT_ADDRESS_HEADER } from '@omnivo/contracts';
import type { FastifyRequest } from 'fastify';

// Step 27a: the shopper's own address (27a's decision 14), for the order and /track limits. The
// shop's server sends it in SHOP_CLIENT_ADDRESS_HEADER. Only the order routes read it, and
// ShopKeyGuard has checked the shop's key before this runs, so a stranger cannot pick an address to
// be counted under. Anything that is not one IP address (a list, a name, nothing) is not used: the
// limits then count the caller itself, the shop's server, which is stricter, never looser
export const ShopClient = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const value = request.headers[SHOP_CLIENT_ADDRESS_HEADER];
  return typeof value === 'string' && isIP(value.trim()) !== 0 ? value.trim() : request.ip;
});
```

`isIP()` returns 0 for anything that is not one address: a list ("1.2.3.4, 5.6.7.8"), a name, an empty string.
Then the decorator falls back to `request.ip`, the shop's server. That is stricter, never looser: all shoppers
would share one limit. A stranger cannot set this header to dodge the limit, because `ShopKeyGuard` has already
refused anyone without the key.

### One way in, two roles

```diff
@@ -1,6 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import { type Db, storefrontSettings } from '@omnivo/db';
-import { eq, sql } from 'drizzle-orm';
+import { eq, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { AppError } from '../common/http/app-error.js';
@@ -19,6 +19,8 @@ export function storefrontNotFound(): AppError {
 // What every public read knows about its shop once it is found
 export interface ShopScope {
   tenantId: string;
+  // Step 27a: the shop's own label ("nirvor"), for the tracking link the confirm SMS carries
+  subdomain: string;
   // Where the shop counts its stock (decision 3)
   warehouseId: string;
   // One clock for the whole answer: a sale that ends during the request is either on in every
@@ -31,6 +33,9 @@ const tenantRowSchema = z.object({ tenant_id: z.uuid().nullable() });
 // Step 26f: how the public API reads the database (decision 15). Every public request is one
 // read-only transaction that first becomes omnivo_public (migration 0064), so even a bug in this
 // module reads only what the shop's own pages show, and writes nothing.
+//
+// Step 27a: the order routes go through orders() instead, as omnivo_shop (0071, 27a's decision
+// 22): the public reads plus the order tables, and nothing else. Both find the shop the same way.
 @Injectable()
 export class ShopDb {
   constructor(
@@ -41,6 +46,27 @@ export class ShopDb {
   read<T>(
     host: string | undefined,
     fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
+  ): Promise<T> {
+    // READ ONLY on top of the role's SELECT-only grants: a write here fails twice over
+    return this.run(host, sql`omnivo_public`, 'read only', fn);
+  }
+
+  // Step 27a: placing an order, its phone code, and the order and tracking pages. Read-write only
+  // where it writes: the pages that only show an order pass readOnly, so a bug there cannot change
+  // one either
+  orders<T>(
+    host: string | undefined,
+    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
+    { readOnly = false }: { readOnly?: boolean } = {},
+  ): Promise<T> {
+    return this.run(host, sql`omnivo_shop`, readOnly ? 'read only' : 'read write', fn);
+  }
+
+  private run<T>(
+    host: string | undefined,
+    role: SQL,
+    accessMode: 'read only' | 'read write',
+    fn: (tx: Transaction, shop: ShopScope) => Promise<T>,
   ): Promise<T> {
     // Before any database work: a host that cannot be a shop of ours costs nothing
     const label = subdomainOf(host, this.config.storefront.baseDomain);
@@ -49,8 +75,9 @@ export class ShopDb {
     return this.db.transaction(
       async (tx) => {
         // LOCAL: only until this transaction ends. The pooled connection is omnivo_app again for
-        // the next request, as with set_config(…, true) in setTenantContext
-        await tx.execute(sql`SET LOCAL ROLE omnivo_public`);
+        // the next request, as with set_config(…, true) in setTenantContext. The role is one of
+        // the two written above, never a value from the request
+        await tx.execute(sql`SET LOCAL ROLE ${role}`);
         // The one look across workspaces, through the database's own function: it answers one id
         // for a launched shop, or NULL
         const [found] = z
@@ -73,10 +100,14 @@ export class ShopDb {
         // all would mean the shop's launch was undone between the two queries: the same 404
         if (settings?.warehouseId == null) throw storefrontNotFound();
 
-        return fn(tx, { tenantId, warehouseId: settings.warehouseId, now: new Date() });
+        return fn(tx, {
+          tenantId,
+          subdomain: label,
+          warehouseId: settings.warehouseId,
+          now: new Date(),
+        });
       },
-      // READ ONLY on top of the role's SELECT-only grants: a write here fails twice over
-      { accessMode: 'read only' },
+      { accessMode },
     );
   }
 }
```

`read()` and the new `orders()` share one `run()`: the subdomain check, the role, the tenant lookup and the warehouse
are the same code, so the two can never find a shop differently. The role is an `SQL` value written in this file,
never text from the request, so `SET LOCAL ROLE ${role}` cannot be turned into another statement.

`orders()` is read-write by default, and `readOnly` for the pages that only show an order. A bug in those pages
then cannot change an order even though `omnivo_shop` could.

`ShopScope` gets the shop's `subdomain`: the confirm SMS links to `https://<subdomain>.<base domain>/t/<token>`.

### On hand minus held

```diff
@@ -41,13 +41,10 @@ function shownListings(shop: ShopScope): SQL {
     SELECT l.id, l.slug, l.name, l.pack_size, l.category_id, l.badges, l.images, l.published_at,
            l.description_sections, l.seo_title, l.seo_description,
            l.sale_kind, l.sale_value, l.sale_starts_at, l.sale_ends_at,
+           l.product_id, l.variant_id,
            v.sku, u.name AS unit_name, r.regular, s.on_sale,
            CASE WHEN s.on_sale THEN r.regular - o.off ELSE r.regular END AS price,
-           -- Decision 3: in stock = more than nothing in the shop's warehouse. Summed over the
-           -- batches, so a batch below zero (step 20a's sold-short) takes from the others
-           (SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
-             WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
-               AND b.warehouse_id = ${shop.warehouseId}::uuid) > 0 AS in_stock
+           f.free, f.free > 0 AS in_stock
       FROM storefront_listings l
       JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
       JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
@@ -70,6 +67,20 @@ function shownListings(shop: ShopScope): SQL {
       CROSS JOIN LATERAL (
         SELECT coalesce(o.running AND o.off > 0 AND r.regular - o.off > 0, false) AS on_sale
       ) s
+      -- 26f's decision 3: in stock = more than nothing in the shop's warehouse. Summed over the
+      -- batches, so a batch below zero (step 20a's sold-short) takes from the others. Step 27a:
+      -- minus what orders hold there (27a's decision 6). A waiting order's hold counts until its
+      -- expires_at, a confirmed order's (NULL) until its challan. Same clock as the price: one
+      -- answer never shows a hold as both on and over
+      CROSS JOIN LATERAL (
+        SELECT (SELECT coalesce(sum(b.quantity), 0) FROM stock_balances b
+                 WHERE b.tenant_id = l.tenant_id AND b.variant_id = l.variant_id
+                   AND b.warehouse_id = ${shop.warehouseId}::uuid)
+             - (SELECT coalesce(sum(h.quantity), 0) FROM storefront_stock_holds h
+                 WHERE h.tenant_id = l.tenant_id AND h.variant_id = l.variant_id
+                   AND h.warehouse_id = ${shop.warehouseId}::uuid
+                   AND (h.expires_at IS NULL OR h.expires_at > ${now})) AS free
+      ) f
      WHERE l.tenant_id = ${shop.tenantId}::uuid
        AND l.published_at IS NOT NULL
        AND v.archived_at IS NULL AND p.archived_at IS NULL
@@ -90,7 +101,8 @@ const LISTING_COLUMNS = sql`
   shown.seo_description, shown.regular::text, shown.sale_kind, shown.sale_value::text,
   ${isoText(sql`shown.sale_starts_at`)} AS sale_starts_at,
   ${isoText(sql`shown.sale_ends_at`)} AS sale_ends_at,
-  ${isoText(sql`shown.published_at`)} AS published_at, shown.price::text, shown.in_stock`;
+  ${isoText(sql`shown.published_at`)} AS published_at, shown.price::text, shown.in_stock,
+  shown.product_id::text, shown.variant_id::text, shown.free::text`;
 
 const isoSchema = z.iso.datetime();
 
@@ -118,6 +130,11 @@ const listingRowSchema = z.object({
   published_at: isoSchema,
   price: z.string(),
   in_stock: z.boolean(),
+  // Step 27a: the stock item and how much of it is free (on hand minus held), for the quote and
+  // the order. Never on a card: the shop says only "in stock", not how many (26f's decision 3)
+  product_id: z.uuid(),
+  variant_id: z.uuid(),
+  free: z.string(),
 });
 
 export type ListingRow = z.infer<typeof listingRowSchema>;
```

- The stock moves into a `LATERAL` subquery that gives `free`: on hand in the shop's warehouse minus the holds
  there that have not ended. `in_stock` is `free > 0`, so the cards, the filters and the quote all see held stock
  as gone (decision 6).
- A hold counts while `expires_at` is `NULL` (a confirmed order) or later than `now`. `now` is the same value the
  price uses (`shop.now`), so one answer never counts a hold as both on and over.
- `product_id`, `variant_id` and `free` join the row: placing an order writes the first two on its lines and holds,
  and checks `free`. They never reach a card: `listingWith` picks the card's fields by name.

```diff
@@ -1,5 +1,6 @@
 import {
   compareMoney,
+  compareQuantity,
   multiplyMoney,
   subtractMoney,
   sumMoney,
@@ -13,16 +14,19 @@ import {
 } from '@omnivo/contracts';
 
 // A listing as the quote needs it: the card (price, stock) and the photo a cart line draws. The
-// line's photo is the small size (media.ts), the same as the card's, so it is the card's own
+// line's photo is the small size (media.ts), the same as the card's, so it is the card's own.
+// Step 27a: and how much is free to sell (on hand minus held, in the base unit), as a decimal string
 export interface QuotedListing {
   listing: ShopListing;
   image: ShopImage;
+  free: string;
 }
 
 // Step 26f: the cart's prices, the same rules as the shop's mock (apps/shop/src/data/mock/quote.ts,
 // step 26c), so the drawer and the checkout do not change when the shop moves to this API. Each
 // line at the listing's price now, summed with the money helpers (never JavaScript numbers). Only
-// coupons differ: the ERP has none until step 27, so a code is always refused as unknown.
+// coupons differ: the ERP has none until step 27c, so a code is always refused as unknown. Step
+// 27a: placing an order prices it with this same function, so the order and the last quote agree.
 //
 // `listings` has only what the shop shows now: a listing that is unpublished, deleted, archived in
 // the ERP or without a price is not in it, and its line is 'unavailable'.
@@ -34,7 +38,7 @@ export function quoteCart(
   const lines = request.lines.map((line): ShopCartQuoteLine => {
     const found = listings.get(line.listingId);
     if (found === undefined) return { status: 'unavailable', listingId: line.listingId };
-    const { listing, image } = found;
+    const { listing, image, free } = found;
     const shown = {
       listingId: listing.id,
       slug: listing.slug,
@@ -43,9 +47,12 @@ export function quoteCart(
       image,
       quantity: line.quantity,
     };
-    // Decision 3: the shop knows only "in stock" (one or more in the shop's warehouse). Whether
-    // there are as many as the cart asks for is step 27's question, when an order holds the stock
-    if (!listing.inStock) return { ...shown, status: 'out_of_stock' };
+    // Step 27a: as many as the cart asks for must be free, because placing the order holds that
+    // many (27a's decision 6). Fewer is out of stock for this line: the quote has no "only 3
+    // left", and calling it available would let Confirm Order fail on it again and again
+    if (!listing.inStock || compareQuantity(free, String(line.quantity)) < 0) {
+      return { ...shown, status: 'out_of_stock' };
+    }
     return {
       ...shown,
       status: 'available',
```

A line is `out_of_stock` when fewer are free than it asks for (decision 27). `compareQuantity` compares the two as
decimal strings: `free` is `numeric(19,4)` from the database ("3.0000").

```diff
@@ -13,7 +13,7 @@ const STEVIA = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a02';
 const DANO = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a03';
 const GONE = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a04';
 
-function quoted(id: string, name: string, price: string, inStock = true): QuotedListing {
+function quoted(id: string, name: string, price: string, free = '10.0000'): QuotedListing {
   const image = { url: `https://media.example.com/storefront/${id}/small.webp`, alt: name };
   const listing: ShopListing = {
     id,
@@ -26,17 +26,17 @@ function quoted(id: string, name: string, price: string, inStock = true): Quoted
     saleUntil: null,
     discount: null,
     badges: [],
-    inStock,
+    inStock: Number(free) > 0,
     categoryId: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a10',
   };
-  return { listing, image };
+  return { listing, image, free };
 }
 
 // What the database gives: numeric(19,4), so every amount has four decimals
 const LISTINGS = new Map([
   [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000')],
   [STEVIA, quoted(STEVIA, 'Zero Cal Stevia 30 Sachets', '120.0000')],
-  [DANO, quoted(DANO, 'Dano Daily Pushti Milk 1kg', '780.0000', false)],
+  [DANO, quoted(DANO, 'Dano Daily Pushti Milk 1kg', '780.0000', '0.0000')],
 ]);
 
 const SETTINGS: ShopCheckoutSettings = {
@@ -75,6 +75,17 @@ describe('quoteCart (public API)', () => {
     expect(answer).toMatchObject({ itemCount: 3, subtotal: '687.0000', belowMinimum: false });
   });
 
+  // Step 27a: an order holds as many as its line asks for, so fewer free is out of stock for it
+  it('calls a line out of stock when fewer are free than it asks for', () => {
+    const few = new Map([
+      [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000', '2.0000')],
+    ]);
+    const lines = (quantity: number) =>
+      quoteCart({ lines: [{ listingId: NEEM, quantity }] }, few, SETTINGS).lines[0]?.status;
+    expect(lines(2)).toBe('available');
+    expect(lines(3)).toBe('out_of_stock');
+  });
+
   it('adds the zone charge, and none from the free-delivery amount on', () => {
     expect(
       quote({ lines: [{ listingId: STEVIA, quantity: 3 }], zoneId: 'outside_dhaka' }),
```

```diff
@@ -18,6 +18,7 @@ import {
   type ShopHome,
   type ShopHomeBlock,
   type ShopListingPage,
+  type ShopPaymentMethod,
   type ShopProductPage,
   type ShopTextPage,
   type ShopTextPageSlug,
@@ -41,7 +42,14 @@ import { notFound } from '../common/http/app-error.js';
 import type { Transaction } from '../common/tenant/with-tenant.js';
 import type { Config } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
-import { idIn, listingOf, listingPage, listingWith, selectListings } from './listing-sql.js';
+import {
+  idIn,
+  listingOf,
+  listingPage,
+  type ListingRow,
+  listingWith,
+  selectListings,
+} from './listing-sql.js';
 import { shopImage, type StorefrontImageSize } from './media.js';
 import { quoteCart, type QuotedListing } from './quote.js';
 import { ShopDb, type ShopScope, storefrontNotFound } from './shop-db.js';
@@ -193,18 +201,7 @@ export class PublicStorefrontService {
 
   quote(host: string | undefined, request: ShopCartQuoteRequest): Promise<ShopCartQuote> {
     return this.shopDb.read(host, async (tx, shop) => {
-      const ids = request.lines
-        .map((line) => line.listingId)
-        .filter((id) => uuidSchema.safeParse(id).success);
-      const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
-      const listings = new Map<string, QuotedListing>();
-      for (const row of rows) {
-        const listing = listingOf(row, shop, this.mediaUrl);
-        // The card's photo (the first, small) is the cart line's photo too. It is always there
-        // (listingRowSchema: at least one); TypeScript only cannot know it
-        const [image] = listing.images;
-        if (image !== undefined) listings.set(row.id, { listing, image });
-      }
+      const listings = await quotedListings(tx, shop, request.lines, this.mediaUrl);
       return quoteCart(request, listings, await checkoutSettingsOf(tx, shop));
     });
   }
@@ -368,8 +365,33 @@ async function categoriesOf(tx: Transaction, shop: ShopScope): Promise<ShopCateg
     );
 }
 
-// The checkout's settings, also what the quote applies
-async function checkoutSettingsOf(tx: Transaction, shop: ShopScope): Promise<ShopCheckoutSettings> {
+// The cart's listings as the quote needs them, by id. Step 27a: shared with placing an order
+// (orders/shop-orders.service.ts), so the order is priced from exactly the rows a quote reads.
+// The cart's ids are checked first: anything that is not a uuid is a listing that cannot exist
+export async function quotedListings(
+  tx: Transaction,
+  shop: ShopScope,
+  lines: readonly { listingId: string }[],
+  mediaUrl: string,
+): Promise<Map<string, QuotedListing & { row: ListingRow }>> {
+  const ids = lines.map((line) => line.listingId).filter((id) => uuidSchema.safeParse(id).success);
+  const rows = await selectListings(tx, shop, sql`WHERE ${idIn(sql`shown.id`, ids)}`);
+  const listings = new Map<string, QuotedListing & { row: ListingRow }>();
+  for (const row of rows) {
+    const listing = listingOf(row, shop, mediaUrl);
+    // The card's photo (the first, small) is the cart line's photo too. It is always there
+    // (listingRowSchema: at least one); TypeScript only cannot know it
+    const [image] = listing.images;
+    if (image !== undefined) listings.set(row.id, { listing, image, free: row.free, row });
+  }
+  return listings;
+}
+
+// The checkout's settings, also what the quote applies. Step 27a: exported for placing an order
+export async function checkoutSettingsOf(
+  tx: Transaction,
+  shop: ShopScope,
+): Promise<ShopCheckoutSettings> {
   const [settings] = await tx
     .select({
       zones: storefrontSettings.deliveryZones,
@@ -384,8 +406,17 @@ async function checkoutSettingsOf(tx: Transaction, shop: ShopScope): Promise<Sho
     // A launched shop has one to six (storefront_settings_launch_check and zones_check); each
     // zone's shape is checked here, because jsonb holds whatever was written
     zones: z.array(shopDeliveryZoneSchema).parse(settings.zones),
-    paymentMethods: settings.paymentMethods,
+    paymentMethods: offeredMethods(settings.paymentMethods),
     freeDeliveryFrom: settings.freeDeliveryFrom,
     minimumOrder: settings.minimumOrder,
   };
 }
+
+// Step 27a: the payment methods the checkout offers. Mobile Banking needs the shop's own gateway,
+// which step 27c connects; until then an online order would only fail, so the checkout does not
+// show it. A shop that ticked Mobile Banking alone keeps it (the contract needs at least one
+// method), and placing such an order is refused as shop_payment_unavailable, which is true
+export function offeredMethods(methods: readonly ShopPaymentMethod[]): ShopPaymentMethod[] {
+  const working = methods.filter((method) => method !== 'online');
+  return working.length > 0 ? working : [...methods];
+}
```

- `quotedListings()` is the quote's old loop, moved out and exported, so placing an order reads exactly the rows a
  quote reads. Each entry also carries its `row`, for the ids and the photo the order keeps.
- `checkoutSettingsOf()` is exported for the same reason.
- `offeredMethods()` hides Mobile Banking until 27c (decision 29). The quote and the checkout settings use it, so
  the checkout never offers what would fail.

### The order's secrets

```ts
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { SHOP_CODE_LENGTH } from '@omnivo/contracts';

// Step 27a: the order's two tokens and its phone code. Only hashes reach the database
// (storefront_orders_hashes_check: 64 lower-case hex characters).

// A token: 16 random bytes as base64url, 22 characters (shopOrderTokenSchema and
// shopTrackingTokenSchema). 128 bits cannot be guessed, so the token alone opens what it opens
export function newToken(): string {
  return randomBytes(16).toString('base64url');
}

// What the database keeps of a token: its SHA-256 (as document_shares does since step 16). A
// plain hash is enough here, unlike the code's: 128 random bits cannot be found by trying them
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Six digits, every one of the million equally likely. randomInt, never Math.random: the code is
// what stands between a stranger and an order placed in someone else's name
export function newCode(): string {
  return String(randomInt(0, 10 ** SHOP_CODE_LENGTH)).padStart(SHOP_CODE_LENGTH, '0');
}

// What the database keeps of a code: an HMAC with the API's own key (config.storefront.codeKey)
// over the order's token hash and the code. A plain SHA-256 of six digits is undone by trying all
// million, which a laptop does in a second; without the key, a leaked dump gives nothing. The
// token hash binds the code to its order, so a code's hash copied onto another order is no use
export function codeHash(key: Buffer, orderTokenHash: string, code: string): string {
  return createHmac('sha256', key).update(`${orderTokenHash}:${code}`).digest('hex');
}

// Compared in constant time, like the shop key (shop-key.ts). Both are 64 hex characters, so the
// buffers have one length; a stored value of another length is a broken row, and never matches
export function codeMatches(
  key: Buffer,
  orderTokenHash: string,
  code: string,
  stored: string,
): boolean {
  const sent = Buffer.from(codeHash(key, orderTokenHash, code), 'hex');
  const kept = Buffer.from(stored, 'hex');
  return sent.length === kept.length && timingSafeEqual(sent, kept);
}
```

- `newToken()` is the share links' rule: 16 random bytes, 22 base64url characters.
- `newCode()` uses `randomInt`, which is cryptographically random. `Math.random` is not, and its next values can be
  worked out from a few earlier ones.
- `codeHash()` is an HMAC over the order's token hash and the code. The token hash is used instead of the order's
  id because the hash is known before the row is written (the id is made by the insert). It still binds the code to
  one order: the same six digits give another hash on every other order.
- `codeMatches()` checks the lengths first: `timingSafeEqual` throws on two lengths, and a broken stored value must
  answer "wrong", not 500.

```ts
import { shopOrderTokenSchema, shopTrackingTokenSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { codeHash, codeMatches, newCode, newToken, tokenHash } from './order-secrets.js';

const KEY = Buffer.alloc(32, 7);
const ORDER = tokenHash('order-token');

describe('order secrets', () => {
  it('makes tokens the contract takes, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 100 }, newToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(shopOrderTokenSchema.safeParse(token).success).toBe(true);
      expect(shopTrackingTokenSchema.safeParse(token).success).toBe(true);
    }
  });

  it('hashes a token to the 64 hex characters the database checks', () => {
    expect(tokenHash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash('abc')).toBe(tokenHash('abc'));
  });

  it('makes six-digit codes, leading zeros kept', () => {
    for (let i = 0; i < 200; i += 1) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it('matches only the right code of the right order with the right key', () => {
    const stored = codeHash(KEY, ORDER, '042317');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(codeMatches(KEY, ORDER, '042317', stored)).toBe(true);
    expect(codeMatches(KEY, ORDER, '042318', stored)).toBe(false);
    expect(codeMatches(KEY, tokenHash('another order'), '042317', stored)).toBe(false);
    expect(codeMatches(Buffer.alloc(32, 8), ORDER, '042317', stored)).toBe(false);
    // A broken stored value never matches, and never throws
    expect(codeMatches(KEY, ORDER, '042317', 'abc')).toBe(false);
  });
});
```

### The SMS

```ts
import { z } from 'zod';

// Step 27a: one SMS, as the API hands it to the worker. Not an outbox event: an outbox row carries
// ids, never secrets (common/outbox/outbox.ts), and these texts carry the phone code or a tracking
// link. So the API puts the job on its own BullMQ queue right after its transaction commits, and
// the queue deletes the job as soon as it is sent, or has failed for good (sms-queue.ts).

export const SMS_QUEUE = 'sms';
export const SMS_JOB = 'sms.send';

// The worker checks the job like any data from Redis. The phone is shopPhoneSchema's form, the
// only one the orders keep. 480 characters: three SMS parts in English, about seven in Bangla
// (a Bangla SMS part holds 70 characters), far more than any of ours
export const smsJobSchema = z.object({
  to: z.string().regex(/^01[3-9]\d{8}$/),
  text: z.string().min(1).max(480),
});

export type SmsJob = z.infer<typeof smsJobSchema>;
```

The worker checks every job's data with `smsJobSchema`, because Redis is outside the program. The phone must be the
11-digit form, so a bug cannot send an SMS to a number in another shape.

```ts
import { Inject, Injectable } from '@nestjs/common';

import { escapeHtml } from '../mail/layout.js';
import { MailService } from '../mail/mail.service.js';
import type { SmsJob } from './sms-job.js';

// Step 27a: the one way an SMS leaves Omnivo (27a's decision 8). The worker asks for SMS_SENDER,
// never for a class, so the real provider (chosen before staging sends real SMS) is one new class
// and one line in worker.module.ts.
export interface SmsSender {
  // Throws when the message was not taken; the queue then tries again (worker/sms-runner.ts)
  send(message: SmsJob): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

// The text as the phone would show it: its own lines, in a font that has Bangla
const PRE_STYLE = 'font: 15px/1.5 system-ui, sans-serif; white-space: pre-wrap';

// Development, CI and staging for now: each SMS is an email to Mailpit, which the team already
// opens for the invitation emails, so the code can be read there and typed into the shop. The
// address is under .invalid, a name no real mail server delivers to (RFC 2606): if this sender were
// ever left on with a real SMTP server, the messages would bounce instead of reaching a stranger.
@Injectable()
export class MailSmsSender implements SmsSender {
  constructor(@Inject(MailService) private readonly mail: MailService) {}

  async send({ to, text }: SmsJob): Promise<void> {
    await this.mail.send({
      to: `${to}@sms.invalid`,
      subject: `SMS to ${to}`,
      text,
      html: `<pre style="${PRE_STYLE}">${escapeHtml(text)}</pre>`,
    });
  }
}
```

`SmsSender` is an interface with a token, `SMS_SENDER`, so the real provider later is one class and one line in
`worker.module.ts` (decision 8). `MailSmsSender` sends each SMS as an email to `<phone>@sms.invalid`: Mailpit takes
any address and shows it, and `.invalid` is a name no real mail server delivers to, so a real SMTP server would
bounce it instead of mailing a stranger.

```ts
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import type { Config } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { SMS_JOB, SMS_QUEUE, type SmsJob, smsJobSchema } from './sms-job.js';

// How long one hand-over to Redis may take. BullMQ waits for its connection before it adds a job,
// so with Redis away an add would wait as long as the shopper does; this ends it, as the outbox
// relay's publishTimeoutMs does
const ADD_TIMEOUT_MS = 3_000;

// Step 27a: the API's side of the SMS queue. Only the order routes use it, and only after their
// transaction has committed: an SMS for an order that rolled back would carry a code for nothing.
@Injectable()
export class SmsQueue implements OnApplicationShutdown {
  private readonly logger = new Logger(SmsQueue.name);
  private queue: Queue | null = null;

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  // Made on the first SMS, not when the API starts: most API processes never send one, and a queue
  // made at start would hold a Redis connection open (and try it in tests that have no Redis)
  private get sms(): Queue {
    if (this.queue === null) {
      this.queue = new Queue(SMS_QUEUE, {
        connection: { url: this.config.redisUrl, enableOfflineQueue: false },
      });
      // As in worker/queues.ts: without a listener, every failed reconnect is an unhandled error
      this.queue.on('error', (error) => {
        this.logger.warn(`queue ${SMS_QUEUE}: ${error.message}`);
      });
    }
    return this.queue;
  }

  // Never throws. The order is saved by now, and the shopper can ask for the code again after
  // SHOP_CODE_RESEND_SECONDS (or track the order with /track): failing the whole answer for a lost
  // SMS would only make them place the order twice. The log never names the phone or the text
  async send(message: SmsJob): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.sms.add(SMS_JOB, smsJobSchema.parse(message), {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          // Gone from Redis the moment it is sent, or has failed for good: the text is a secret
          removeOnComplete: true,
          removeOnFail: true,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`no answer from Redis in ${String(ADD_TIMEOUT_MS)} ms`));
          }, ADD_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch (error) {
      this.logger.error(
        `An SMS was not queued: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
  }
}
```

- The queue is made on the first SMS, not at start. Most API processes never send one, and `contract.spec.ts`
  starts the API with no Redis at all.
- `removeOnComplete` and `removeOnFail` are `true`, not an age like the outbox's jobs: the job's data is a code or a
  tracking link, and it must not stay in Redis for a day.
- `send()` never throws (decision 26). BullMQ waits for its connection before an add, so the add gets a time limit,
  like the outbox relay's publish; without it, a shopper would wait as long as Redis is away.
- The log line never names the phone or the text.

```ts
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import type { WorkerConfig } from '../config.js';
import { CONFIG } from '../infra/tokens.js';
import { SMS_QUEUE, smsJobSchema } from '../sms/sms-job.js';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender.js';

// Step 27a: the worker's side of the SMS queue. Its own BullMQ worker next to the outbox queues
// (job-runner.ts): an SMS job is not an outbox event, and a slow SMS provider must not hold up the
// emails or the jobs. It lives in worker/, not in sms/, because only worker/ may run a BullMQ
// Worker (.dependency-cruiser.cjs, queue-only-in-worker).
@Injectable()
export class SmsRunner implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SmsRunner.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: WorkerConfig,
    @Inject(SMS_SENDER) private readonly sender: SmsSender,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker(SMS_QUEUE, (job) => this.process(job), {
      connection: { url: this.config.redisUrl },
      concurrency: 5,
    });
    this.worker.on('error', (error) => {
      this.logger.warn(`queue ${SMS_QUEUE}: ${error.message}`);
    });
    // The job's id only: its data is a phone and a code
    this.worker.on('failed', (job, error) => {
      this.logger.warn(`SMS ${String(job?.id)} failed: ${error.message}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job): Promise<void> {
    const message = smsJobSchema.safeParse(job.data);
    // A job we cannot read will never become readable: no retries
    if (!message.success) throw new UnrecoverableError(`SMS ${String(job.id)} has broken data`);
    await this.sender.send(message.data);
  }
}
```

Its own BullMQ worker, not a branch in `JobRunner`: an SMS is not an outbox event, and a slow SMS provider must not
hold up the emails and the jobs. The `failed` log names only the job's id. It sits in `worker/`, next to
`job-runner.ts`, not in `sms/`: only `worker/` may run BullMQ (the rule below), and `worker.module.ts` is the only
place that uses it.

```diff
@@ -52,7 +52,15 @@ module.exports = {
         'The API hands work to the worker by writing an outbox row with emit(), in the same transaction as the change. A job put on the queue straight from a request is lost when that transaction rolls back after it, or runs before the data it needs is committed.',
       from: {
         path: '^apps/api/src/',
-        pathNot: ['^apps/api/src/worker/', '^apps/api/src/worker\\.ts$', '\\.spec\\.ts$'],
+        pathNot: [
+          '^apps/api/src/worker/',
+          '^apps/api/src/worker\\.ts$',
+          '\\.spec\\.ts$',
+          // Step 27a: the one exception. An SMS carries a phone code or a tracking link, so it never
+          // goes into the outbox table; SmsQueue adds it only after the order's transaction has
+          // committed, so the rollback this rule guards against cannot happen to it
+          '^apps/api/src/sms/sms-queue\\.ts$',
+        ],
       },
       to: { path: 'node_modules/bullmq/' },
     },
```

The rule `queue-only-in-worker` keeps BullMQ out of the API's code, because a job added during a request is lost when
the request's transaction rolls back, or runs before its data is committed. That is why everything else goes through
the outbox. `sms-queue.ts` is the one file allowed (decision 42): it adds a job only after the transaction has
committed, so neither problem can happen, and the outbox is not an option for an SMS, because its row would keep the
code or the link in a table. The exception names this one file, not the folder, so a second producer still needs its
own reason.

```ts
import { type LanguageCode, SHOP_CODE_VALID_MINUTES } from '@omnivo/contracts';

// Step 27a: the shop's two SMS, in the shop's language (storefront_settings.language). Written
// here, side by side, like the emails' words (mail/invitation-email.ts): @omnivo/i18n is the
// browser's. satisfies makes a third language a compile error until it has its words.
//
// Short on purpose. A Bangla SMS part holds 70 characters, an English one 160, and each part costs
// the shop money. The code comes first in its message: Android and iOS offer the first number of
// an SMS as "fill in the code", and the shopper may see only the first line on the lock screen.

function bnDigits(value: number): string {
  return new Intl.NumberFormat('bn-BD').format(value);
}

// The code stays in ASCII digits in Bangla too: it is typed into a box that takes either, and the
// phone's "fill in the code" reads ASCII digits only
export function codeSms(language: LanguageCode, shopName: string, code: string): string {
  const words = {
    en: `${code} is your ${shopName} order code. It works for ${String(SHOP_CODE_VALID_MINUTES)} minutes. Do not share it.`,
    bn: `${code} আপনার ${shopName} অর্ডারের কোড। ${bnDigits(SHOP_CODE_VALID_MINUTES)} মিনিট কাজ করবে। কাউকে বলবেন না।`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}

// After the right code: the number and the tracking link (27a's decision 9). The link is the only
// copy of its token: the database keeps its hash
export function confirmedSms(
  language: LanguageCode,
  shopName: string,
  orderNo: string,
  link: string,
): string {
  const words = {
    en: `${shopName}: order ${orderNo} is confirmed. Track it here: ${link}`,
    bn: `${shopName}: অর্ডার ${orderNo} নিশ্চিত হয়েছে। এখানে দেখুন: ${link}`,
  } satisfies Record<LanguageCode, string>;
  return words[language];
}
```

```ts
import { describe, expect, it } from 'vitest';

import { codeSms, confirmedSms } from './shop-sms.js';

describe('the shop SMS', () => {
  it('puts the code first, in ASCII digits in both languages', () => {
    expect(codeSms('en', 'Nirvor', '042317')).toBe(
      '042317 is your Nirvor order code. It works for 10 minutes. Do not share it.',
    );
    expect(codeSms('bn', 'নির্ভর', '042317')).toMatch(
      /^042317 আপনার নির্ভর অর্ডারের কোড। ১০ মিনিট/,
    );
  });

  it('carries the number and the link after the right code', () => {
    const link = 'https://nirvor.omnivo.shop/t/AbCdEfGhIjKlMnOpQrStUv';
    expect(confirmedSms('en', 'Nirvor', 'W-000123', link)).toBe(
      `Nirvor: order W-000123 is confirmed. Track it here: ${link}`,
    );
    expect(confirmedSms('bn', 'Nirvor', 'W-000123', link)).toContain(link);
  });
});
```

The words sit next to each other in two languages, like the emails', because `@omnivo/i18n` is for the browser.
The code comes first: Android and iOS offer the first number of an SMS as "fill in the code", and a lock screen
may show only the first line. The code stays in ASCII digits in the Bangla SMS, because the phone's code filler reads
only those.

### The limits

```ts
import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  addressKey,
  SHOP_ORDER_WINDOW_MINUTES,
  SHOP_ORDERS_PER_ADDRESS,
  SHOP_ORDERS_PER_PHONE,
  SHOP_TRACK_TRIES,
  SHOP_TRACK_WINDOW_MINUTES,
} from '@omnivo/contracts';
import type { Redis } from 'ioredis';

import { REDIS } from '../../infra/tokens.js';

// One limit: so many in a window. Each key's window starts at its first count and ends
// windowMinutes later, like the shop's own limiter (26e). Two numbers per key, kept by Redis with
// its own expiry, so nothing here needs a timer or a cleanup job
interface Limit {
  name: string;
  max: number;
  windowMinutes: number;
}

const ORDERS_BY_PHONE: Limit = {
  name: 'orders-phone',
  max: SHOP_ORDERS_PER_PHONE,
  windowMinutes: SHOP_ORDER_WINDOW_MINUTES,
};
const ORDERS_BY_ADDRESS: Limit = {
  name: 'orders-address',
  max: SHOP_ORDERS_PER_ADDRESS,
  windowMinutes: SHOP_ORDER_WINDOW_MINUTES,
};
const TRACK_MISSES: Limit = {
  name: 'track-misses',
  max: SHOP_TRACK_TRIES,
  windowMinutes: SHOP_TRACK_WINDOW_MINUTES,
};

// The Redis key. The phone or the address is hashed: the limits need to tell two phones apart,
// not to read them, and a Redis dump should not be a list of who ordered in the last hour. Not per
// shop: a script that sends one phone a code from every shop on the platform is still one phone
function keyOf(limit: Limit, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `shop-limit:${limit.name}:${digest}`;
}

// Step 27a: the API's limits on the shop's order routes (27a's decisions 7 and 17), in Redis so
// every API process counts together. Each answer is the minutes to wait, 0 when there is none: the
// problem's params.minutes, which the shop's words put in "try again in 12 minutes".
//
// Redis down is an error here, so the route answers 500 and places nothing. Letting orders through
// without limits would let a script through too, and the code's SMS needs Redis anyway.
@Injectable()
export class ShopLimits {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // Before an order: whichever of its phone or its connection is over its limit, the longer wait
  async orderWait(phone: string, address: string): Promise<number> {
    const waits = await Promise.all([
      this.wait(ORDERS_BY_PHONE, phone),
      this.wait(ORDERS_BY_ADDRESS, addressKey(address)),
    ]);
    return Math.max(...waits);
  }

  // After an order was placed. Only a placed one counts: an order refused because its price
  // changed sent no SMS and holds no stock, and the shopper must be able to try again at once
  async countOrder(phone: string, address: string): Promise<void> {
    await Promise.all([
      this.count(ORDERS_BY_PHONE, phone),
      this.count(ORDERS_BY_ADDRESS, addressKey(address)),
    ]);
  }

  // The /track form: only its misses count (26e's decision 3), so a shopper who looks at their
  // own order ten times is never stopped
  trackWait(address: string): Promise<number> {
    return this.wait(TRACK_MISSES, addressKey(address));
  }

  async trackMiss(address: string): Promise<void> {
    await this.count(TRACK_MISSES, addressKey(address));
  }

  private async wait(limit: Limit, value: string): Promise<number> {
    const key = keyOf(limit, value);
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count < limit.max) return 0;
    // The seconds left of the key's window. -1 (no expiry, which count() never leaves) or -2 (gone
    // since the get) wait one minute: never "wait 0 minutes" to someone who was just refused
    const seconds = await this.redis.ttl(key);
    return Math.max(1, Math.ceil(seconds / 60));
  }

  // INCR then EXPIRE … NX in one round trip: the first count starts the window, and later counts
  // do not move its end (NX: only when the key has no expiry yet)
  private async count(limit: Limit, value: string): Promise<void> {
    const key = keyOf(limit, value);
    await this.redis
      .multi()
      .incr(key)
      .expire(key, limit.windowMinutes * 60, 'NX')
      .exec();
  }
}
```

- A fixed window per key: `INCR`, then `EXPIRE … NX` in the same `MULTI`. `NX` sets the expiry only on the first
  count, so later counts do not push the window's end back.
- The key holds a hash of the phone or the address, not the value: the limit needs to tell two apart, not to read
  them.
- `orderWait()` runs before the order and `countOrder()` after it commits (decision 28): a refused order sent no SMS
  and holds no stock.
- `wait()` answers at least one minute once the limit is reached, so the words never say "try again in 0 minutes".

### Placing an order

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type ErrorCode,
  type LanguageCode,
  maskPhone,
  type PublicOrderPlaced,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopCodeResent,
  type ShopCodeWait,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderRequest,
  type ShopTracking,
  type ShopTrackRequest,
} from '@omnivo/contracts';
import {
  storefrontOrderCounters,
  storefrontOrderLines,
  storefrontOrders,
  storefrontSettings,
  storefrontStockHolds,
  storefrontListings,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError, notFound } from '../../common/http/app-error.js';
import { emit } from '../../common/outbox/outbox.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG } from '../../infra/tokens.js';
import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { checkoutSettingsOf, quotedListings } from '../public-storefront.service.js';
import { quoteCart } from '../quote.js';
import { ShopDb, type ShopScope } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';
import { codeHash, codeMatches, newCode, newToken, tokenHash } from './order-secrets.js';
import { orderOf, type OrderRow, trackingOf } from './order-view.js';
import { ShopLimits } from './shop-limits.js';

const MINUTE_MS = 60 * 1000;

const uuidSchema = z.uuid();

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * MINUTE_MS);
}

// Whole seconds from now until `at`, 0 once it has passed. Rounded up: "wait 0 seconds" would let
// the next try in a moment too early
function secondsUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
}

// W-000123: W for web (26c's decision 3), counted per shop (27a's decision 20)
function orderNumber(value: number): string {
  return `W-${String(value).padStart(6, '0')}`;
}

// The answers a shopper can get wrong. Each status as the shop's mock answered it (26c's
// server/orders.ts), so the shop's pages need no change: 409 for "look again, something
// changed", 422 for "this cannot be done", 429 for "wait"
function refused(
  status: 404 | 409 | 422 | 429,
  code: ErrorCode,
  detail: string,
  params?: Record<string, string | number>,
): AppError {
  return new AppError(status, code, detail, params === undefined ? {} : { params });
}

function noOrder(): AppError {
  return refused(404, 'shop_code_no_order', 'No order waits for a code under this token.');
}

// What the shop's SMS need to know about the shop: its name and language
interface ShopWords {
  name: string;
  language: LanguageCode;
}

async function shopWords(tx: Transaction, shop: ShopScope): Promise<ShopWords> {
  const [settings] = await tx
    .select({ name: storefrontSettings.name, language: storefrontSettings.language })
    .from(storefrontSettings)
    .where(eq(storefrontSettings.tenantId, shop.tenantId));
  // ShopDb found the shop through this row a moment ago, in the same transaction
  if (settings === undefined) throw new Error(`storefront_settings missing for ${shop.tenantId}`);
  return settings;
}

// The order that waits for its code under this token, or none. One older than its hold
// (SHOP_ORDER_HOLD_MINUTES) is none, even before the worker's sweep deletes it: its stock is free
// again by then (the holds' expires_at), so it can no longer be confirmed. `lock` takes the row for
// this transaction (FOR UPDATE), so two codes typed at once are checked one after the other, and
// five wrong ones cannot become six
async function waitingOrder(
  tx: Transaction,
  shop: ShopScope,
  token: string,
  { lock }: { lock: boolean },
): Promise<OrderRow | undefined> {
  const query = tx
    .select()
    .from(storefrontOrders)
    .where(
      and(
        eq(storefrontOrders.tenantId, shop.tenantId),
        eq(storefrontOrders.orderTokenHash, tokenHash(token)),
        eq(storefrontOrders.status, 'pending'),
        gt(storefrontOrders.createdAt, minutesAfter(shop.now, -SHOP_ORDER_HOLD_MINUTES)),
      ),
    );
  const [order] = lock ? await query.for('update') : await query;
  return order;
}

// One variant's lock, for placing an order (27a's decision 6). Two shoppers who order the last
// piece at the same moment are put in a line here: the second one reads the stock only after the
// first one's hold is committed, and finds it gone. A transaction lock: it ends with the
// transaction, so nothing can leave one behind. The key names the workspace and the variant, so
// two shops never wait for each other
async function lockVariant(tx: Transaction, tenantId: string, variantId: string): Promise<void> {
  const key = `storefront-hold:${tenantId}:${variantId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// The result of checking a code. A wrong code is written down (one try less, or the order deleted)
// and then refused, so its transaction must commit before the refusal is thrown: a refusal thrown
// inside would roll the count back, and a guesser would get unlimited tries
type CodeCheck =
  | { ok: false; error: AppError }
  | {
      ok: true;
      orderNo: string;
      phone: string;
      trackingToken: string;
      shop: ShopWords;
      subdomain: string;
    };

// Step 27a: the shop's orders, the phone code and tracking (the seven 'shop' routes). Every one
// runs inside ShopDb.orders, as omnivo_shop in the shop's workspace. The SMS go out only after the
// transaction commits (SmsQueue), and only an order's hashes are stored.
```

- `waitingOrder()` is the one query for "the order that waits for its code". It leaves out an order older than its
  hold, even before the sweep deletes it: its stock is free again by then (the hold's `expires_at`), so confirming it
  would confirm stock that may be sold. `lock: true` adds `FOR UPDATE`: two codes typed at once are checked one
  after the other, so five wrong codes cannot become six.
- `lockVariant()` takes a transaction-level advisory lock per variant. Two shoppers who order the last piece at once
  wait in line here; the second reads the stock only after the first one's hold is committed. The key has the
  workspace in it, so two shops never wait for each other.
- `CodeCheck` exists because of one rule: a wrong code must be written down before it is refused. An `AppError`
  thrown inside the transaction would roll back the lost try, and a guesser would get unlimited tries. So the
  transaction returns the result, and `verify()` throws after the commit.

```ts
@Injectable()
export class ShopOrdersService {
  private readonly mediaUrl: string;

  constructor(
    private readonly shopDb: ShopDb,
    private readonly sms: SmsQueue,
    private readonly limits: ShopLimits,
    @Inject(CONFIG) private readonly config: Config,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }

  // Confirm Order (27a's decision 2: Cash on Delivery waits for the phone code)
  async place(
    host: string | undefined,
    client: string,
    request: ShopOrderRequest,
  ): Promise<PublicOrderPlaced> {
    // The limits first, before any database work: a script that is over them costs one Redis read
    const wait = await this.limits.orderWait(request.phone, client);
    if (wait > 0) {
      throw refused(429, 'shop_order_limit', 'Too many orders from this phone or connection.', {
        minutes: wait,
      });
    }

    const token = newToken();
    const orderTokenHash = tokenHash(token);
    const code = newCode();

    const shop = await this.shopDb.orders(host, async (tx, scope) => {
      const settings = await checkoutSettingsOf(tx, scope);
      const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
      if (!zone)
        throw refused(422, 'shop_zone_unknown', 'The delivery zone is not one the shop has.');
      // Mobile Banking waits for step 27c's gateway; checkoutSettingsOf may still list it for a
      // shop that ticked only that (offeredMethods)
      if (
        request.paymentMethod === 'online' ||
        !settings.paymentMethods.includes(request.paymentMethod)
      ) {
        throw refused(
          422,
          'shop_payment_unavailable',
          'The shop does not take this payment method.',
        );
      }

      // Lock the cart's variants, in one order for everyone (by id), so two orders that share two
      // variants can never each hold one lock and wait for the other's. The listings are read
      // again after the locks, so the free stock below counts every hold committed before them
      const ids = request.lines
        .map((line) => line.listingId)
        .filter((id) => uuidSchema.safeParse(id).success);
      const variants =
        ids.length === 0
          ? []
          : await tx
              .selectDistinct({ variantId: storefrontListings.variantId })
              .from(storefrontListings)
              .where(
                and(
                  eq(storefrontListings.tenantId, scope.tenantId),
                  inArray(storefrontListings.id, ids),
                ),
              )
              .orderBy(asc(storefrontListings.variantId));
      for (const { variantId } of variants) await lockVariant(tx, scope.tenantId, variantId);

      // The order is priced by the quote's own function from the rows a quote reads, so it is
      // exactly what the checkout showed, or it is refused
      const listings = await quotedListings(tx, scope, request.lines, this.mediaUrl);
      const quote = quoteCart(request, listings, settings);
      // Every line as it is in the cart: one out of stock or gone since the last quote would leave
      // the shopper with less than they chose (26c's decision 10). The checkout quotes again and
      // shows what changed
      const sold = quote.lines.flatMap((line) => (line.status === 'available' ? [line] : []));
      if (sold.length !== quote.lines.length) {
        throw refused(409, 'shop_order_changed', "The cart's prices or stock changed.");
      }
      if (quote.belowMinimum && settings.minimumOrder !== null) {
        throw refused(422, 'shop_order_below_minimum', "The order is under the shop's minimum.", {
          minimum: settings.minimumOrder,
        });
      }
      // The total the shopper saw. A price or a sale that changed since the last quote shows here
      if (compareMoney(quote.total, request.expectedTotal) !== 0) {
        throw refused(409, 'shop_order_changed', "The cart's prices or stock changed.");
      }
```

- The limits come first, before any database work.
- The token and the code are made before the transaction, so the code's hash can go into the same `INSERT`.
- The variants are locked in one order (by id) for everyone. Two orders that share two variants could otherwise
  each hold one lock and wait for the other's forever.
- After the locks, `quotedListings()` and `quoteCart()` price the order with the quote's own code. Every line must
  be `available`, and the total must equal what the shopper saw (`compareMoney`, so "538" and "538.0000" are one
  amount). Any difference is `shop_order_changed`, and the checkout quotes again and shows it.

```ts

      const [order] = await tx
        .insert(storefrontOrders)
        .values({
          tenantId: scope.tenantId,
          // One clock for the order: ShopDb's. The holds and the code are counted from it too
          createdAt: scope.now,
          updatedAt: scope.now,
          status: 'pending',
          customerName: request.name,
          phone: request.phone,
          address: request.address,
          zoneId: zone.id,
          zoneName: zone.name,
          paymentMethod: request.paymentMethod,
          subtotal: quote.subtotal,
          discount: quote.discount,
          // Coupons come in 27c; until then the quote applies none
          couponCode: null,
          // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
          deliveryCharge: quote.deliveryCharge ?? '0',
          total: quote.total,
          orderTokenHash,
          codeHash: codeHash(this.config.storefront.codeKey, orderTokenHash, code),
          codeSentAt: scope.now,
          codeExpiresAt: minutesAfter(scope.now, SHOP_CODE_VALID_MINUTES),
          codeSends: 1,
          codeTriesLeft: SHOP_CODE_TRIES,
        })
        .returning({ id: storefrontOrders.id });
      // INSERT … RETURNING always gives the row it wrote; the check is for TypeScript
      if (order === undefined) throw new Error('The order was not written');

      const until = minutesAfter(scope.now, SHOP_ORDER_HOLD_MINUTES);
      const rows = sold.map((line, index) => {
        // Every sold line came from a row of `listings` (quoteCart reads nothing else), and every
        // shown listing has a photo (listingRowSchema); the checks are for TypeScript
        const row = listings.get(line.listingId)?.row;
        const image = row?.images[0];
        if (row === undefined || image === undefined) {
          throw new Error(`Listing ${line.listingId} has no row or photo`);
        }
        return { line, row, image, position: index + 1 };
      });
      await tx.insert(storefrontOrderLines).values(
        rows.map(({ line, row, image, position }) => ({
          tenantId: scope.tenantId,
          orderId: order.id,
          position,
          listingId: line.listingId,
          productId: row.product_id,
          variantId: row.variant_id,
          slug: line.slug,
          name: line.name,
          packSize: line.packSize,
          // The listing's first photo as the database keeps it (id and alt), not its address: the
          // address is made when the order is shown, so it follows a later move of the storage
          image,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        })),
      );
      // One hold per line: a listing is one variant (storefront_listings_variant_idx), and a cart
      // has each listing once. In the base unit, like the stock it is taken from
      await tx.insert(storefrontStockHolds).values(
        rows.map(({ line, row }) => ({
          tenantId: scope.tenantId,
          orderId: order.id,
          productId: row.product_id,
          variantId: row.variant_id,
          warehouseId: scope.warehouseId,
          quantity: String(line.quantity),
          expiresAt: until,
        })),
      );
      return shopWords(tx, scope);
    });

    // Committed: now it counts, and now the code goes out
    await this.limits.countOrder(request.phone, client);
    await this.sms.send({ to: request.phone, text: codeSms(shop.language, shop.name, code) });
    return {
      answer: {
        next: 'verify',
        maskedPhone: maskPhone(request.phone),
        resendInSeconds: SHOP_CODE_RESEND_SECONDS,
      },
      token,
    };
  }
```

- Every time is `scope.now` (ShopDb's clock), including `createdAt`. The order's hour, its code's 10 minutes and its
  hold all start at the same moment.
- The line keeps the listing's first photo as `{ id, alt }`, not its address: the address is built when the order is
  shown, so it follows a later change of `STOREFRONT_MEDIA_URL`.
- One hold per line: a listing is one variant (`storefront_listings_variant_idx`) and a cart has each listing once,
  so the holds' primary key (order, variant) cannot collide.
- After the commit: the limit counts, then the SMS is queued. The answer has the token once; the API keeps only its
  hash.

### The phone code

```ts

  // The verify page's order, by the cookie's token
  codeWait(host: string | undefined, token: string): Promise<ShopCodeWait> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const order = await waitingOrder(tx, shop, token, { lock: false });
        if (order?.codeSentAt == null) throw noOrder();
        const lines = await tx
          .select({ listingId: storefrontOrderLines.listingId })
          .from(storefrontOrderLines)
          .where(
            and(
              eq(storefrontOrderLines.tenantId, shop.tenantId),
              eq(storefrontOrderLines.orderId, order.id),
            ),
          )
          .orderBy(asc(storefrontOrderLines.position));
        return {
          next: 'verify',
          maskedPhone: maskPhone(order.phone),
          resendInSeconds: secondsUntil(
            new Date(order.codeSentAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000),
            shop.now,
          ),
          listingIds: lines.map((line) => line.listingId),
        };
      },
      { readOnly: true },
    );
  }

  // The six digits (27a's decisions 2 and 7). A right code confirms the order at once
  async verify(host: string | undefined, token: string, code: string): Promise<ShopOrderConfirmed> {
    const result = await this.shopDb.orders(host, (tx, shop) =>
      this.checkCode(tx, shop, token, code),
    );
    if (!result.ok) throw result.error;

    // Committed: the order is confirmed whether or not this SMS goes out. The buyer still has the
    // dialog, and /track with the number and the phone
    const link = shopUrl(this.config.storefront, result.subdomain, `/t/${result.trackingToken}`);
    await this.sms.send({
      to: result.phone,
      text: confirmedSms(result.shop.language, result.shop.name, result.orderNo, link),
    });
    return { orderNo: result.orderNo, phone: result.phone };
  }
```

`codeWait()` is read-only. `verify()` sends the confirm SMS only after the commit: a confirm that rolled back must
not tell the buyer a number that does not exist.

```ts

  private async checkCode(
    tx: Transaction,
    shop: ShopScope,
    token: string,
    code: string,
  ): Promise<CodeCheck> {
    const order = await waitingOrder(tx, shop, token, { lock: true });
    if (order?.codeHash == null || order.codeExpiresAt === null || order.codeTriesLeft === null) {
      return { ok: false, error: noOrder() };
    }
    const where = and(
      eq(storefrontOrders.tenantId, shop.tenantId),
      eq(storefrontOrders.id, order.id),
    );

    // A code past its 10 minutes is refused before it is compared: it cannot be right any more,
    // so it costs no try. The shopper asks for a new one, which the verify page offers below
    if (order.codeExpiresAt <= shop.now) {
      return {
        ok: false,
        error: refused(422, 'shop_code_expired', 'The code has expired. Ask for a new one.'),
      };
    }

    if (!codeMatches(this.config.storefront.codeKey, order.orderTokenHash, code, order.codeHash)) {
      const triesLeft = order.codeTriesLeft - 1;
      // The fifth wrong code drops the order (27a's decision 19): five guesses at six digits have
      // a 1 in 200,000 chance. Its lines and holds go with it (ON DELETE CASCADE), so its stock is
      // free again in this same statement
      if (triesLeft === 0) {
        await tx.delete(storefrontOrders).where(where);
        return {
          ok: false,
          error: refused(422, 'shop_code_too_many', 'Too many wrong codes; the order was dropped.'),
        };
      }
      await tx
        .update(storefrontOrders)
        .set({ codeTriesLeft: triesLeft, version: sql`${storefrontOrders.version} + 1` })
        .where(where);
      return {
        ok: false,
        error: refused(422, 'shop_code_wrong', 'The code is wrong.', { triesLeft }),
      };
    }

    // The shop's next number. INSERT … ON CONFLICT: the first order of a shop makes its counter
    // row. The row's lock holds until this transaction ends, so two confirms in one shop take
    // turns, and a confirm that rolls back gives its number back (27a's decision 20)
    const [counter] = await tx
      .insert(storefrontOrderCounters)
      .values({ tenantId: shop.tenantId, lastValue: 1 })
      .onConflictDoUpdate({
        target: storefrontOrderCounters.tenantId,
        set: { lastValue: sql`${storefrontOrderCounters.lastValue} + 1` },
      })
      .returning({ value: storefrontOrderCounters.lastValue });
    if (counter === undefined) throw new Error('The order counter was not written');
    const orderNo = orderNumber(counter.value);

    // The tracking link's token is made now (27a's decision 9): a pending order is never tracked.
    // Every code column is emptied in the same UPDATE (storefront_orders_pending_check)
    const trackingToken = newToken();
    await tx
      .update(storefrontOrders)
      .set({
        status: 'confirmed',
        orderNo,
        trackingTokenHash: tokenHash(trackingToken),
        confirmedAt: shop.now,
        codeHash: null,
        codeExpiresAt: null,
        codeSentAt: null,
        codeSends: null,
        codeTriesLeft: null,
        version: sql`${storefrontOrders.version} + 1`,
      })
      .where(where);
    // The stock stays held, now with no end, until 27b's challan takes it out for real
    await tx
      .update(storefrontStockHolds)
      .set({ expiresAt: null })
      .where(
        and(
          eq(storefrontStockHolds.tenantId, shop.tenantId),
          eq(storefrontStockHolds.orderId, order.id),
        ),
      );
    // In the same transaction (common/outbox): the bell now, and 27b's sales order
    await emit(tx, 'storefront.order_confirmed', { orderId: order.id });

    return {
      ok: true,
      orderNo,
      phone: order.phone,
      trackingToken,
      shop: await shopWords(tx, shop),
      subdomain: shop.subdomain,
    };
  }
```

- An expired code is refused before the compare and costs no try (decision 31).
- The fifth wrong code deletes the order (decision 19). Its lines and holds go by `ON DELETE CASCADE`, so its stock is
  free in the same statement.
- The number: `INSERT … ON CONFLICT DO UPDATE … RETURNING` on the counter. The first confirm of a shop makes its row;
  every later one adds 1. The row's lock lasts until the commit, so two confirms take turns, and a rollback gives the
  number back (decision 20).
- One `UPDATE` sets the confirmed columns and empties every code column, because `storefront_orders_pending_check`
  allows only the two exact shapes.
- The holds lose their end: a confirmed order holds its stock until 27b's challan.
- `emit()` writes `storefront.order_confirmed` in the same transaction, so a confirmed order always gets its bell
  (and in 27b its sales order), and a rolled-back confirm never does.

```ts

  // "Resend code" (27a's decision 7): after SHOP_CODE_RESEND_SECONDS, at most SHOP_CODE_SENDS in
  // all. The wrong codes are not forgiven: a new SMS must not give a guesser five more tries
  async resend(host: string | undefined, token: string): Promise<ShopCodeResent> {
    const code = newCode();
    const sent = await this.shopDb.orders(host, async (tx, shop) => {
      const order = await waitingOrder(tx, shop, token, { lock: true });
      if (order?.codeSentAt == null || order.codeSends === null) throw noOrder();
      // All codes used: no wait would help, so this comes before the wait
      if (order.codeSends >= SHOP_CODE_SENDS) {
        throw refused(422, 'shop_code_sends_used', 'This order has had all its codes.');
      }
      const wait = secondsUntil(
        new Date(order.codeSentAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000),
        shop.now,
      );
      if (wait > 0) {
        throw refused(429, 'shop_code_resend_wait', 'A new code cannot be sent yet.', {
          seconds: wait,
        });
      }
      // The new code replaces the old one: only the last SMS works
      await tx
        .update(storefrontOrders)
        .set({
          codeHash: codeHash(this.config.storefront.codeKey, order.orderTokenHash, code),
          codeSentAt: shop.now,
          codeExpiresAt: minutesAfter(shop.now, SHOP_CODE_VALID_MINUTES),
          codeSends: order.codeSends + 1,
          version: sql`${storefrontOrders.version} + 1`,
        })
        .where(
          and(eq(storefrontOrders.tenantId, shop.tenantId), eq(storefrontOrders.id, order.id)),
        );
      return { phone: order.phone, shop: await shopWords(tx, shop) };
    });
    await this.sms.send({
      to: sent.phone,
      text: codeSms(sent.shop.language, sent.shop.name, code),
    });
    return { resendInSeconds: SHOP_CODE_RESEND_SECONDS };
  }
```

The new code replaces the old one, so only the last SMS works. `codeTriesLeft` does not change: a new SMS must not
give a guesser five more tries.

### The order and tracking pages

```ts

  // /order/<no>: the number and the cookie's token must belong to one confirmed order (26c's
  // decision 5). Anything else is the same 404, so a guess learns nothing
  find(host: string | undefined, orderNo: string, token: string): Promise<ShopOrder> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.orderNo, orderNo),
              eq(storefrontOrders.orderTokenHash, tokenHash(token)),
              ne(storefrontOrders.status, 'pending'),
            ),
          );
        if (order === undefined) throw notFound('Order');
        return orderOf(order, await this.linesOf(tx, shop, order.id), this.mediaUrl);
      },
      { readOnly: true },
    );
  }

  // A tracking link. Only a confirmed order has a tracking hash (storefront_orders_pending_check)
  tracking(host: string | undefined, token: string): Promise<ShopTracking> {
    return this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.trackingTokenHash, tokenHash(token)),
            ),
          );
        if (order === undefined) throw notFound('Order');
        return trackingOf(order, await this.linesOf(tx, shop, order.id));
      },
      { readOnly: true },
    );
  }

  // The /track form (26e). The limit first: once it is reached nothing is looked up, so a guesser
  // learns nothing more until the window ends. Only a miss counts (26e's decision 3)
  async track(
    host: string | undefined,
    client: string,
    { phone, orderNo }: ShopTrackRequest,
  ): Promise<ShopTracking> {
    const wait = await this.limits.trackWait(client);
    if (wait > 0) {
      throw refused(429, 'shop_track_too_many', 'Too many tries from this connection.', {
        minutes: wait,
      });
    }
    const tracking = await this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(
            and(
              eq(storefrontOrders.tenantId, shop.tenantId),
              eq(storefrontOrders.orderNo, orderNo),
              eq(storefrontOrders.phone, phone),
              ne(storefrontOrders.status, 'pending'),
            ),
          );
        return order === undefined
          ? null
          : trackingOf(order, await this.linesOf(tx, shop, order.id));
      },
      { readOnly: true },
    );
    if (tracking === null) {
      await this.limits.trackMiss(client);
      // One answer for a wrong number and a wrong phone: the form never says which
      throw refused(404, 'shop_track_not_found', 'No order has this number and mobile number.');
    }
    return tracking;
  }

  private linesOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select()
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, shop.tenantId),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }
}
```

- `find()` needs the number and the cookie's token together, and a confirmed order; anything else is the same 404.
- `tracking()` finds the order by its link's hash. Only a confirmed order has one.
- `track()` checks the limit first, so once it is reached a guesser learns nothing more, however right the next
  guess is. Only a miss counts, and a wrong number and a wrong phone get the same answer.

```ts
import {
  SHOP_ORDER_STATUSES,
  storefrontImageSchema,
  type ShopOrder,
  type ShopOrderStatus,
  type ShopTracking,
} from '@omnivo/contracts';
import type { storefrontOrderLines, storefrontOrders } from '@omnivo/db';

import { shopImage } from '../media.js';

// Step 27a: an order as the shop's pages show it, from its rows. Pure functions, so the unit test
// covers every case without a database.

export type OrderRow = typeof storefrontOrders.$inferSelect;
export type OrderLineRow = typeof storefrontOrderLines.$inferSelect;

// Each status and the column that says when the order reached it. A Record over the statuses, so a
// status added to the contract without its column here does not compile
const STEP_AT = {
  pending: 'createdAt',
  confirmed: 'confirmedAt',
  packed: 'packedAt',
  shipped: 'shippedAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
  returned: 'returnedAt',
} as const satisfies Record<ShopOrderStatus, keyof OrderRow>;

// The timeline, oldest first (shopOrderSchema.history): every step the order has a time for. Read
// from the columns, not kept as a list of events, so it can never disagree with them (27a.2). Two
// steps at the same moment keep the life's own order: sort() is stable, and the list starts in
// SHOP_ORDER_STATUSES' order
export function historyOf(order: OrderRow): ShopOrder['history'] {
  return SHOP_ORDER_STATUSES.flatMap((status) => {
    const at = order[STEP_AT[status]];
    return at === null ? [] : [{ status, at: at.toISOString() }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// A confirmed order always has its number (storefront_orders_pending_check). The routes never show
// a pending order, so a missing number here is a bug, and a loud one is better than "W-null"
function numberOf(order: OrderRow): string {
  if (order.orderNo === null) throw new Error(`Order ${order.id} has no number yet`);
  return order.orderNo;
}

// What /order/<no> shows: everything, for the browser that placed the order (decision 16). Lines in
// the cart's order. Each photo is the small one, the size a checkout line draws; the jsonb is
// checked like a banner's (public-storefront.service.ts), because the database checks only that
// it is an object
export function orderOf(
  order: OrderRow,
  lines: readonly OrderLineRow[],
  mediaUrl: string,
): ShopOrder {
  return {
    orderNo: numberOf(order),
    placedAt: order.createdAt.toISOString(),
    status: order.status,
    history: historyOf(order),
    name: order.customerName,
    phone: order.phone,
    address: order.address,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        listingId: line.listingId,
        slug: line.slug,
        name: line.name,
        packSize: line.packSize,
        image: shopImage(mediaUrl, storefrontImageSchema.parse(line.image), 'small'),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    subtotal: order.subtotal,
    discount: order.discount,
    couponCode: order.couponCode,
    deliveryCharge: order.deliveryCharge,
    total: order.total,
  };
}

// What a tracking link and the /track form show (26e's shopTrackingSchema): no name, phone,
// address or line, because the link gets forwarded. Each field picked by name, never `...order`.
// No parcel yet: couriers come in step 28
export function trackingOf(order: OrderRow, lines: readonly OrderLineRow[]): ShopTracking {
  return {
    orderNo: numberOf(order),
    placedAt: order.createdAt.toISOString(),
    status: order.status,
    history: historyOf(order),
    // Pieces, not lines: two face washes and a tea are 3 items
    itemCount: lines.reduce((count, line) => count + line.quantity, 0),
    total: order.total,
    paymentMethod: order.paymentMethod,
    shipments: [],
  };
}
```

```ts
import { shopOrderSchema, shopTrackingSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { historyOf, type OrderLineRow, orderOf, type OrderRow, trackingOf } from './order-view.js';

const TENANT = '0193a000-0000-7000-8000-000000000001';
const ORDER = '0193a000-0000-7000-8000-000000000002';
const MEDIA = 'https://media.example.com';

const PLACED = new Date('2026-11-17T04:00:00.000Z');
const CONFIRMED = new Date('2026-11-17T04:02:10.000Z');

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    createdAt: PLACED,
    updatedAt: CONFIRMED,
    updatedBy: null,
    version: 2,
    tenantId: TENANT,
    orderNo: 'W-000123',
    status: 'confirmed',
    customerName: 'Nusrat Jahan',
    phone: '01786120356',
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    zoneId: 'inside_dhaka',
    zoneName: 'Inside Dhaka',
    paymentMethod: 'cod',
    subtotal: '498.0000',
    discount: '0.0000',
    couponCode: null,
    deliveryCharge: '80.0000',
    total: '578.0000',
    orderTokenHash: 'a'.repeat(64),
    trackingTokenHash: 'b'.repeat(64),
    codeHash: null,
    codeExpiresAt: null,
    codeSentAt: null,
    codeSends: null,
    codeTriesLeft: null,
    confirmedAt: CONFIRMED,
    packedAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    returnedAt: null,
    ...overrides,
  };
}

function line(position: number, quantity: number, name: string): OrderLineRow {
  return {
    tenantId: TENANT,
    orderId: ORDER,
    position,
    listingId: `0193a000-0000-7000-8000-00000000010${String(position)}`,
    productId: '0193a000-0000-7000-8000-000000000201',
    variantId: '0193a000-0000-7000-8000-000000000301',
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    packSize: '150ml',
    image: { id: '0193a000-0000-7000-8000-000000000401', alt: name },
    quantity,
    unitPrice: '229.0000',
    lineTotal: (229 * quantity).toFixed(4),
  };
}

// Out of their order on purpose: the page lists them as the cart did
const LINES = [line(2, 1, 'Stevia'), line(1, 2, 'Neem face wash')];

describe('order view', () => {
  it('reads the timeline from the step columns, oldest first', () => {
    expect(historyOf(order())).toEqual([
      { status: 'pending', at: PLACED.toISOString() },
      { status: 'confirmed', at: CONFIRMED.toISOString() },
    ]);
    // A return before the delivery (a parcel refused at the door): by time, not by the list
    const returned = order({
      status: 'returned',
      shippedAt: new Date('2026-11-18T05:00:00.000Z'),
      returnedAt: new Date('2026-11-19T09:00:00.000Z'),
    });
    expect(historyOf(returned).map((step) => step.status)).toEqual([
      'pending',
      'confirmed',
      'shipped',
      'returned',
    ]);
  });

  it('gives the browser that placed it the whole order, lines in the cart order', () => {
    const answer = shopOrderSchema.parse(orderOf(order(), LINES, MEDIA));
    expect(answer).toMatchObject({ orderNo: 'W-000123', phone: '01786120356', total: '578.0000' });
    expect(answer.lines.map((item) => item.name)).toEqual(['Neem face wash', 'Stevia']);
    expect(answer.lines[0]?.image.url).toBe(
      `${MEDIA}/storefront/0193a000-0000-7000-8000-000000000401/small.webp`,
    );
  });

  it('gives a tracking link no name, phone, address or line', () => {
    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES));
    expect(answer).toEqual({
      orderNo: 'W-000123',
      placedAt: PLACED.toISOString(),
      status: 'confirmed',
      history: historyOf(order()),
      itemCount: 3,
      total: '578.0000',
      paymentMethod: 'cod',
      shipments: [],
    });
  });

  it('refuses to show an order without a number', () => {
    expect(() => trackingOf(order({ orderNo: null }), LINES)).toThrow(/no number/);
  });
});
```

- `STEP_AT` maps each status to its time column, with `satisfies Record<ShopOrderStatus, …>`: a new status without
  its column does not compile.
- `historyOf()` sorts by time, with the life's order kept for ties (`sort` is stable). A parcel can come back before
  it was delivered, so the list's order alone would be wrong.
- `trackingOf()` picks each field by name, never `...order`: the link gets forwarded, so it must not carry the
  name, the phone or the address. The parcels come with the couriers in step 28.

### The routes

```ts
import { Controller, Header } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { ShopClient } from '../shop-client.decorator.js';
import { ShopHost } from '../shop-host.decorator.js';
import { ShopOrdersService } from './shop-orders.service.js';

type Routes = typeof routes.publicStorefront;

// Step 27a: the seven routes only the shop's server may call (auth: 'shop', checked by ShopKeyGuard
// before any of these runs). Their own controller, next to the public reads': these write, send
// SMS and answer with a buyer's details. Every answer is no-store, like the reads', and more so:
// an order or a tracking answer in a shared cache would be one buyer's details given to another.
@Controller()
export class ShopOrdersController {
  constructor(private readonly orders: ShopOrdersService) {}

  @Endpoint(routes.publicStorefront.placeOrder)
  @Header('Cache-Control', 'no-store')
  placeOrder(
    { body }: RouteInput<Routes['placeOrder']>,
    @ShopHost() host: string | undefined,
    @ShopClient() client: string,
  ): Promise<RouteResponse<Routes['placeOrder']>> {
    return this.orders.place(host, client, body);
  }

  @Endpoint(routes.publicStorefront.codeWait)
  @Header('Cache-Control', 'no-store')
  codeWait(
    { body }: RouteInput<Routes['codeWait']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['codeWait']>> {
    return this.orders.codeWait(host, body.token);
  }

  @Endpoint(routes.publicStorefront.verifyCode)
  @Header('Cache-Control', 'no-store')
  verifyCode(
    { body }: RouteInput<Routes['verifyCode']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['verifyCode']>> {
    return this.orders.verify(host, body.token, body.code);
  }

  @Endpoint(routes.publicStorefront.resendCode)
  @Header('Cache-Control', 'no-store')
  resendCode(
    { body }: RouteInput<Routes['resendCode']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['resendCode']>> {
    return this.orders.resend(host, body.token);
  }

  @Endpoint(routes.publicStorefront.order)
  @Header('Cache-Control', 'no-store')
  order(
    { body }: RouteInput<Routes['order']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['order']>> {
    return this.orders.find(host, body.orderNo, body.token);
  }

  @Endpoint(routes.publicStorefront.tracking)
  @Header('Cache-Control', 'no-store')
  tracking(
    { body }: RouteInput<Routes['tracking']>,
    @ShopHost() host: string | undefined,
  ): Promise<RouteResponse<Routes['tracking']>> {
    return this.orders.tracking(host, body.token);
  }

  @Endpoint(routes.publicStorefront.track)
  @Header('Cache-Control', 'no-store')
  track(
    { body }: RouteInput<Routes['track']>,
    @ShopHost() host: string | undefined,
    @ShopClient() client: string,
  ): Promise<RouteResponse<Routes['track']>> {
    return this.orders.track(host, client, body);
  }
}
```

```diff
@@ -10,6 +10,10 @@ import { StorefrontPagesService } from './admin/pages.service.js';
 import { StorefrontSettingsService } from './admin/settings.service.js';
 import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
 import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
+import { SmsQueue } from '../sms/sms-queue.js';
+import { ShopLimits } from './orders/shop-limits.js';
+import { ShopOrdersController } from './orders/shop-orders.controller.js';
+import { ShopOrdersService } from './orders/shop-orders.service.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
 import { ShopDb } from './shop-db.js';
@@ -18,17 +22,22 @@ import { ShopDb } from './shop-db.js';
 // ERP's Storefront screens' routes (admin/), behind storefront.manage. The two halves share the
 // tables and the photo addresses (media.ts), never a service: the public half runs as
 // omnivo_public in a read-only transaction, the admin half as the signed-in member. Step 26h adds
-// Appearance and the text pages, with their own controller (the contract's own group)
+// Appearance and the text pages, with their own controller (the contract's own group). Step 27a
+// adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send
 @Module({
   imports: [AttachmentsModule],
   controllers: [
     PublicStorefrontController,
+    ShopOrdersController,
     StorefrontAdminController,
     StorefrontAppearanceController,
   ],
   providers: [
     ShopDb,
     PublicStorefrontService,
+    ShopOrdersService,
+    ShopLimits,
+    SmsQueue,
     StorefrontSettingsService,
     StorefrontCategoriesService,
     StorefrontImagesService,
```

The controller is its own class: these routes write, send SMS and answer with a buyer's details, and the public
reads' controller should stay a list of reads. `ShopLimits` and `SmsQueue` are providers of this module only; no
other module sends a shop SMS.

### The bell

```diff
@@ -54,6 +54,10 @@ export const outboxPayloadSchemas = {
   // Step 26g: a shop photo's upload was confirmed. Its storefront_images row (processing) and its
   // attachment say everything; the worker makes the shop's WebP files from the original
   'storefront.image_uploaded': z.object({ imageId: z.uuid() }),
+  // Step 27a: a shop order got its right phone code. The order's row has the rest; the worker rings
+  // the bell (and, from 27b, makes the sales order). Never the tracking token: that is a secret,
+  // and it went to the buyer by SMS, straight from the API
+  'storefront.order_confirmed': z.object({ orderId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

```diff
@@ -27,6 +27,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // so it stopped; sent to the person who made the schedule
 // report.schedule_failed: params { report, format } — one person's file or email could not be made
 // or sent; sent to the person who made the schedule
+// storefront.order_confirmed: params { id, number, total } — a shop order got its phone code
+// (step 27a); sent to the owners and the people with storefront.order.read. total is the amount
+// as a decimal string, which the bell writes as money
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -45,6 +48,7 @@ export const NOTIFICATION_TYPES = [
   'approval.rejected',
   'pos.sold_short',
   'pos.shift_variance',
+  'storefront.order_confirmed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  storefrontOrders,
} from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { notify } from '../../notifications/notify.js';

// Step 27a: "New shop order W-000123 for ৳578" in the bell of the owners and of everyone who may
// read the shop's orders (storefront.order.read). 27b adds the sales order to this event. Like
// SoldShortHandler: the order is read when the job runs, and the event's id is each notification's
// key, so a second run of the job adds nothing.
@Injectable()
export class OrderConfirmedHandler implements EventHandler<'storefront.order_confirmed'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [order] = await tx
        .select({
          id: storefrontOrders.id,
          orderNo: storefrontOrders.orderNo,
          total: storefrontOrders.total,
        })
        .from(storefrontOrders)
        .where(
          and(
            eq(storefrontOrders.tenantId, tenantId),
            eq(storefrontOrders.id, event.payload.orderId),
          ),
        );
      // Gone (27b may let staff delete a test order) or, which cannot happen, without a number
      if (order?.orderNo == null) return;

      const recipients = await tx
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(
          membershipRoles,
          and(
            eq(membershipRoles.tenantId, memberships.tenantId),
            eq(membershipRoles.membershipId, memberships.id),
            isNull(membershipRoles.deletedAt),
          ),
        )
        .innerJoin(
          roles,
          and(
            eq(roles.tenantId, membershipRoles.tenantId),
            eq(roles.id, membershipRoles.roleId),
            isNull(roles.deletedAt),
          ),
        )
        .leftJoin(
          rolePermissions,
          and(
            eq(rolePermissions.tenantId, roles.tenantId),
            eq(rolePermissions.roleId, roles.id),
            isNull(rolePermissions.deletedAt),
          ),
        )
        .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            isNull(memberships.deletedAt),
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'storefront.order.read')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'storefront.order_confirmed',
          // The amount as it is stored ("578.0000"): the bell writes it as money in the reader's
          // language. Never the buyer's name or phone: a bell is seen over a shoulder
          params: { id: order.id, number: order.orderNo, total: order.total },
          eventId: event.id,
        });
      }
    });
  }
}
```

The handler reads the order when it runs, and the event's id is each notification's key, so a job that runs twice
rings once. The bell carries the number and the total, never the buyer's name or phone: a bell is seen over a
shoulder.

```diff
@@ -7177,6 +7177,10 @@ export const en = {
         shift_variance:
           '{{number}} on {{register}} closed {{difference}}. Open the shift to see the count.',
       },
+      // Step 27a: a shop order got its phone code. {{total}} arrives as money ("৳578")
+      storefront: {
+        order_confirmed: 'New shop order {{number}} for {{total}}.',
+      },
     },
   },
   // API-র error code → লেখা। satisfies: contracts-এর ERROR_CODES-এ নতুন code এলে এখানে না লেখা
```

```diff
@@ -6686,6 +6686,10 @@ export const bn: Messages = {
         shift_variance:
           '{{register}}-এর {{number}} বন্ধ হয়েছে {{difference}} নিয়ে। গোনাটা দেখতে শিফটটা খুলুন।',
       },
+      // Step 27a: a shop order got its phone code. {{total}} arrives as money ("৳578")
+      storefront: {
+        order_confirmed: 'শপে নতুন অর্ডার {{number}}, মোট {{total}}।',
+      },
     },
   },
   errors: {
```

```diff
@@ -58,6 +58,9 @@ const TARGET = {
   // Step 20b: the list, for an old notification without the shift's id; one with it opens the
   // shift (shiftOf below)
   'pos.shift_variance': '/pos/shifts',
+  // Step 27a: a new shop order. The Orders page comes in step 27b, and opens the order then; until
+  // it does, the overview, where the person was most likely to be
+  'storefront.order_confirmed': '/',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
@@ -139,9 +142,11 @@ function badgeText(count: number): string {
 function useWords() {
   const { t, format: locale } = useLocale();
   return (params: NotificationParams): NotificationParams => {
-    const { report, format, document: kind, difference } = params;
+    const { report, format, document: kind, difference, total } = params;
     return {
       ...params,
+      // Step 27a: a shop order's total arrives as a decimal string ("578.0000"): money, whole taka
+      ...(typeof total === 'string' && isMoneyAmount(total) && { total: locale.money(total) }),
       // Step 20b (decision 66): the variance bell's signed difference becomes "৳520 short"
       ...(typeof difference === 'string' &&
         isMoneyAmount(difference.replace(/^-/, '')) && {
```

The total arrives as a decimal string and the bell writes it as money in the reader's language. The click opens the
overview for now (decision 30); `TARGET`'s `satisfies` made this line necessary.

### The worker

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SHOP_ORDER_HOLD_MINUTES } from '@omnivo/contracts';
import { type Db, storefrontOrders } from '@omnivo/db';
import { and, eq, lt } from 'drizzle-orm';

import { getTenantId, runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';

// Step 27a: deletes the orders that never got their code (27a's decision 19), every 5 minutes. Two
// halves on two roles, like the report schedules' sweep:
// 1. as omnivo_worker (RELAY_DB): which workspaces have a pending order older than its hold.
//    Migration 0071 lets it read three columns of the pending rows only, never a name or a phone
// 2. as omnivo_app, inside each of those workspaces: delete them. Their lines and holds go with
//    them (ON DELETE CASCADE)
// Nothing waits on this: an order past its hour can no longer be confirmed (waitingOrder in
// shop-orders.service.ts), and its stock is free again by the holds' own expires_at. The sweep
// only stops keeping a phone number that was never confirmed. Provided by WorkerModule only.
@Injectable()
export class PendingOrderSweep {
  private readonly logger = new Logger(PendingOrderSweep.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // The number of orders deleted. One clock for both halves: the JavaScript one, as the orders'
  // times were written with it (ShopDb's now)
  async run(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SHOP_ORDER_HOLD_MINUTES * 60 * 1000);
    // The policy shows omnivo_worker only pending rows; the status in the WHERE says so here too,
    // and it is what the partial index (storefront_orders_pending_idx) is for
    const tenants = await this.relayDb
      .selectDistinct({ tenantId: storefrontOrders.tenantId })
      .from(storefrontOrders)
      .where(and(eq(storefrontOrders.status, 'pending'), lt(storefrontOrders.createdAt, before)));

    let deleted = 0;
    for (const { tenantId } of tenants) {
      try {
        deleted += await runWithTenant(tenantId, () =>
          this.withTenant(async (tx) => {
            // pending again: an order confirmed between the two halves is kept
            const rows = await tx
              .delete(storefrontOrders)
              .where(
                and(
                  eq(storefrontOrders.tenantId, getTenantId()),
                  eq(storefrontOrders.status, 'pending'),
                  lt(storefrontOrders.createdAt, before),
                ),
              )
              .returning({ id: storefrontOrders.id });
            return rows.length;
          }),
        );
      } catch (error) {
        // One workspace's failure must not stop the others; the next sweep tries again
        this.logger.warn(`pending orders (tenant ${tenantId}): ${String(error)}`);
      }
    }
    return deleted;
  }
}
```

The same two halves as the report schedules' sweep: `omnivo_worker` finds the workspaces (migration 0071 shows it
three columns of the pending rows only), then `omnivo_app` deletes inside each one. The `DELETE` checks `pending`
and the time again: an order confirmed between the two halves is kept.

```diff
@@ -31,6 +31,7 @@ const QUEUE_OF = {
   'pos.shift_variance': 'jobs',
   'report.schedule_due': 'jobs',
   'storefront.image_uploaded': 'jobs',
+  'storefront.order_confirmed': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
@@ -40,6 +41,9 @@ export const OUTBOX_CLEANUP = 'outbox.cleanup';
 // cleanup, a scheduler adds it, not a request.
 export const REPORT_SCHEDULE_SWEEP = 'report-schedules.sweep';
 
+// Step 27a: every 5 minutes, delete the shop orders that never got their phone code (decision 19)
+export const PENDING_ORDER_SWEEP = 'storefront-orders.sweep';
+
 // What a job carries: the outbox row minus its bookkeeping. The job name is the event type.
 // Redis is data from outside this process, so the worker checks this shape before using it.
 export const eventJobDataSchema = z.object({
@@ -133,6 +137,16 @@ export class Queues implements OnApplicationShutdown {
     );
   }
 
+  // Step 27a: the same, for the shop's pending orders. Every 5 minutes: an order is kept at most
+  // that long past its hour, and nothing depends on the minute it goes
+  async schedulePendingOrderSweep(): Promise<void> {
+    await this.queues.jobs.upsertJobScheduler(
+      'storefront-orders-sweep',
+      { every: SWEEP_MS },
+      { name: PENDING_ORDER_SWEEP },
+    );
+  }
+
   async onApplicationShutdown(): Promise<void> {
     await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
   }
```

```diff
@@ -18,6 +18,7 @@ import { runWithTenant } from '../common/tenant/tenant-context.js';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
 import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
+import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { OutboxRelay } from './outbox-relay.js';
@@ -26,6 +27,7 @@ import {
   type EventJobData,
   isOutboxEventType,
   OUTBOX_CLEANUP,
+  PENDING_ORDER_SWEEP,
   QUEUE_NAMES,
   Queues,
   REPORT_SCHEDULE_SWEEP,
@@ -48,6 +50,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     private readonly relay: OutboxRelay,
     private readonly syncLog: SyncLogCleanup,
     private readonly reportSweep: ReportScheduleSweep,
+    private readonly orderSweep: PendingOrderSweep,
   ) {}
 
   async onApplicationBootstrap(): Promise<void> {
@@ -65,6 +68,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     });
     await this.queues.scheduleCleanup();
     await this.queues.scheduleReportSweep();
+    await this.queues.schedulePendingOrderSweep();
   }
 
   // close() stops taking new jobs and waits for the running ones, before the database closes
@@ -90,6 +94,12 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
       if (handed > 0) this.logger.log(`report schedules: ${String(handed)} runs handed over`);
       return;
     }
+    // Step 27a: like the report sweep, no retries of its own; the next one is 5 minutes later
+    if (job.name === PENDING_ORDER_SWEEP) {
+      const deleted = await this.orderSweep.run();
+      if (deleted > 0) this.logger.log(`shop orders: ${String(deleted)} without a code deleted`);
+      return;
+    }
     // A job we cannot read will never become readable: no retries
     if (!isOutboxEventType(job.name)) throw new UnrecoverableError(`Unknown job ${job.name}`);
     const data = eventJobDataSchema.safeParse(job.data);
```

```diff
@@ -20,6 +20,7 @@ import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
+import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
 // handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
@@ -50,6 +51,7 @@ export class EventHandlers {
     scheduleRun: ReportScheduleRunHandler,
     scheduleEmail: ReportScheduleEmailHandler,
     storefrontImage: StorefrontImageHandler,
+    orderConfirmed: OrderConfirmedHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -70,6 +72,7 @@ export class EventHandlers {
       'report.schedule_due': scheduleRun,
       'report.schedule_email': scheduleEmail,
       'storefront.image_uploaded': storefrontImage,
+      'storefront.order_confirmed': orderConfirmed,
     };
   }
 
```

```diff
@@ -26,12 +26,16 @@ import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
+import { SMS_SENDER, MailSmsSender } from '../sms/sms-sender.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
+import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
+import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
 import { OutboxRelay } from './outbox-relay.js';
 import { Queues } from './queues.js';
+import { SmsRunner } from './sms-runner.js';
 
 // The worker process: no HTTP server, no controllers — the relay and the queue workers. It does
 // not import InfraModule: that one brings the API's things (auth, the permission cache) which the
@@ -91,6 +95,13 @@ export class WorkerModule implements OnApplicationShutdown {
         ReportScheduleEmailHandler,
         // Step 26g: a shop photo's WebP files
         StorefrontImageHandler,
+        // Step 27a: the shop's orders. The bell for a confirmed one, the sweep for the ones that
+        // never got their code, and the SMS queue's consumer with its sender (Mailpit until the
+        // real provider: that one line changes then)
+        OrderConfirmedHandler,
+        PendingOrderSweep,
+        { provide: SMS_SENDER, useClass: MailSmsSender },
+        SmsRunner,
       ],
     };
   }
```

### Roles

```diff
@@ -194,6 +194,9 @@ const SCHEDULING_REPORTS = ['core.report.schedule'] as const;
 // run a shop, the retail shop manager and the general manager; the distributors and makers sell
 // to businesses, and their owner can give it to a role when they open a shop
 const RUNNING_THE_SHOP = ['storefront.manage'] as const;
+// Step 27a: the shop's orders, for the same two roles (27a's decision 11). Apart from
+// storefront.manage, so an owner can give a packer the orders without the shop's prices
+const SHOP_ORDERS = ['storefront.order.read', 'storefront.order.manage'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -762,6 +765,7 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_REPORTS,
           ...SCHEDULING_REPORTS,
           ...RUNNING_THE_SHOP,
+          ...SHOP_ORDERS,
         ],
       },
       {
@@ -841,6 +845,7 @@ export const INDUSTRY_TEMPLATES = {
           ...STOCK_REPORTS,
           ...SCHEDULING_REPORTS,
           ...RUNNING_THE_SHOP,
+          ...SHOP_ORDERS,
         ],
       },
     ],
```

### The OpenAPI document

```bash
pnpm gen:openapi   # packages/contracts/openapi.json: the seven routes, the shopKey scheme, the bell's type
```

### Check this part

```bash
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/contracts test   # 625 tests
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n test             # 21 tests
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test                                                  # 198 tests, contract.spec too
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/shop typecheck
pnpm test:openapi
pnpm exec eslint apps/api/src/storefront apps/api/src/sms apps/api/src/worker apps/api/src/auth apps/api/src/rbac
pnpm exec depcruise apps/api packages                                           # queue-only-in-worker
```

`contract.spec.ts` passes again: the API serves every route of the contract.

Also run, with Docker (`--maxWorkers=3`): `public-storefront.int.spec.ts`, `storefront.tenant-leak.int.spec.ts`,
`rls-coverage.tenant-leak.int.spec.ts` and `notifications.int.spec.ts` — 32 tests, all passing with the new stock
query and `ShopDb`.

A smoke test, end to end against Postgres, Redis and Mailpit (27a.4 turns it into the real tests): no key → 401;
an order of 2 → 201, and with 3 on hand a quote for 2 more is out of stock and a second order is refused (409); the
code read from Mailpit; resend too early → 429; a wrong code → 422 with 4 tries left; the right code → `W-000001`;
the tracking link from the second SMS opens the tracking; `/orders/find` with `w000001` and `/track` with
"+880 1786-120356" both answer; the owner's bell has the order; the sweep deletes a waiting order an hour later and
not before; five wrong codes delete an order; the sixth order from one phone in an hour → 429 with 60 minutes.

Broken on purpose, each caught by the smoke test:

- `ShopKeyGuard` lets every call through: the keyless call gets 400 (its body checked) instead of 401.
- The wrong-code refusal thrown inside the transaction: the fifth wrong code still says `shop_code_wrong`, because
  every lost try was rolled back.

## 27a.4 — Tests

27a.3 was checked by one long smoke test. This part replaces it with real tests: one integration file for what a
shopper can do and what the API refuses, and one tenant-leak file for what one shop must never see of another.
Both run against the real stack: Postgres, Redis, Mailpit and the worker in the test's own process.

Decided while writing this part (the user may still object):

33. **Requests that race are held at a lock, not sent "together" and hoped for.** An order's transaction takes a
    few milliseconds, so five requests sent at once often run one after the other, and a test of the variant lock
    passed with the lock removed. The test now opens its own transaction that locks the table the requests write
    to, waits until all of them wait, and only then lets them go (`atOnce`). With the lock in the code, one goes
    through; without it, all five have already read the same free stock.
34. **Every test has its own phones and its own shopper address.** The limits count a phone and an address across
    the whole API (decision 28), and Mailpit keeps one inbox per phone, so two tests that shared either would
    fail each other.

### What the order tests share

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  publicOrderPlacedSchema,
  type ShopOrderRequestInput,
  setupSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import type postgres from 'postgres';
import { expect } from 'vitest';

import { eventually, TEST_SHOP_KEY } from './app.js';
import { bearer, type SignedIn } from './http.js';
import { lastMailTo } from './mailpit.js';
import { addCategory, addListing, createProduct, launchShop, tenantIdOf } from './storefront.js';

// Step 27a: what the order tests share. The order routes are the shop server's (auth: 'shop'), so
// every call here sends the key and a shopper's address, the way apps/shop's server will (27a.5).

// The headers the shop's server sends for one shopper. Each test gives its own address: the
// limits count per address across the whole API (Redis), so two tests must never share one
export function shopHeaders(host: string, client: string): Record<string, string> {
  return { 'x-shop-host': host, 'x-shop-key': TEST_SHOP_KEY, 'x-shop-client-address': client };
}

// A shopper's IPv4 address of its own for each n (10.0.2.89 for 601). A real address, built from
// whole bytes: "203.0.113.601" is not an IP address, so the API would not use it (ShopClient) and
// every such test would count under one address, the test process's own. Not IPv6: the limits
// count a whole /64 as one shopper (addressKey), so 2001:db8::1 and ::2 would be one
export function clientAddress(n: number): string {
  return `10.0.${String(Math.floor(n / 256))}.${String(n % 256)}`;
}

export function shopPost(
  app: NestFastifyApplication,
  url: string,
  headers: Record<string, string>,
  payload: object,
) {
  return app.inject({ method: 'POST', url: `/public/v1${url}`, headers, payload });
}

// A whole order request. Only the cart, the phone and the total change from test to test
export function orderRequest(
  listingId: string,
  quantity: number,
  phone: string,
  expectedTotal: string,
): ShopOrderRequestInput {
  return {
    lines: [{ listingId, quantity }],
    zoneId: 'inside_dhaka',
    name: 'Nusrat Jahan',
    phone,
    address: 'House 12, Road 5, Mirpur 10, Dhaka',
    paymentMethod: 'cod',
    termsAccepted: true,
    expectedTotal,
  };
}

// Places an order that must succeed, and gives back its token (the shop keeps it in a cookie)
export async function placeOrder(
  app: NestFastifyApplication,
  headers: Record<string, string>,
  request: ShopOrderRequestInput,
): Promise<string> {
  const res = await shopPost(app, '/orders', headers, request);
  expect(res.statusCode, res.body).toBe(201);
  return publicOrderPlacedSchema.parse(res.json()).token;
}

// A Bangladeshi mobile number of its own for each n (01711000001, 01711000002, …), so every test
// has phones no other test uses: the phone limit and the SMS inbox are per phone
export function phoneOf(n: number): string {
  return `01711${String(n).padStart(6, '0')}`;
}

// The SMS go to Mailpit as emails to <phone>@sms.invalid (MailSmsSender)
export function smsAddress(phone: string): string {
  return `${phone}@sms.invalid`;
}

// The six digits of the newest code SMS to this phone. `after`: the id of an SMS already read, to
// wait for the next one (a resend) instead of reading the old one again
export async function codeFor(
  mailUrl: string,
  phone: string,
  after?: string,
): Promise<{ code: string; id: string }> {
  return eventually(async () => {
    const sms = await lastMailTo(mailUrl, smsAddress(phone));
    if (after !== undefined) expect(sms.id).not.toBe(after);
    // The code is the first thing in its SMS, in ASCII digits in both languages (shop-sms.ts)
    const code = /^(\d{6}) /.exec(sms.text)?.[1];
    expect(code, sms.text).toBeDefined();
    return { code: code ?? '', id: sms.id };
  });
}

// The tracking token from the confirm SMS: the link's last part
export async function trackingTokenFor(mailUrl: string, phone: string): Promise<string> {
  return eventually(async () => {
    const sms = await lastMailTo(mailUrl, smsAddress(phone));
    const token = /\/t\/([\w-]{22})$/.exec(sms.text.trim())?.[1];
    expect(token, sms.text).toBeDefined();
    return token ?? '';
  });
}

// Any six digits but this one
export function wrongCode(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

export interface OrderShop {
  tenantId: string;
  host: string;
  warehouseId: string;
  // Neem Face Wash at ৳229, with `stock` pieces in the shop's warehouse
  listingId: string;
  productId: string;
  variantId: string;
  // For a test that lists one more product of its own (addShopProduct)
  unitId: string;
  categoryId: string;
}

// A workspace set up as a retail business, with a launched shop at <slug>.localhost (one zone,
// Inside Dhaka at ৳80, minimum order ৳300, free delivery from ৳1,000: launchShop) that lists one
// product with `stock` pieces on hand
export async function orderShop(
  app: NestFastifyApplication,
  sql: postgres.Sql,
  who: SignedIn,
  shop: { slug: string; name: string; stock: number },
): Promise<OrderShop> {
  const auth = { headers: bearer(who.accessToken) };
  const setup = await app.inject({
    method: 'POST',
    url: '/setup',
    payload: { industry: 'retail' },
    ...auth,
  });
  expect(setup.statusCode, setup.body).toBe(200);
  await eventually(async () => {
    const res = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(res.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  const warehouseId = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  const pcs =
    unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  const tenantId = await tenantIdOf(sql, shop.slug);
  await launchShop(sql, { tenantId, subdomain: shop.slug, name: shop.name, warehouseId });
  const face = await addCategory(sql, tenantId, { slug: 'face-wash', name: 'Face wash' });
  const product = await createProduct(app, who, pcs, 'Neem Face Wash', '229');
  const variantId = product.variants[0]?.id ?? '';
  await setStock(sql, { tenantId, warehouseId, productId: product.id, variantId }, shop.stock);
  const listingId = await addListing(sql, tenantId, {
    product,
    categoryId: face,
    slug: 'neem-face-wash',
    publishedDaysAgo: 1,
  });
  return {
    tenantId,
    host: `${shop.slug}.localhost:4331`,
    warehouseId,
    listingId,
    productId: product.id,
    variantId,
    unitId: pcs,
    categoryId: face,
  };
}

// One more listed product with `stock` pieces, for a test that must know every hold on it: the
// shop's first product is held by every other test's orders
export async function addShopProduct(
  app: NestFastifyApplication,
  sql: postgres.Sql,
  who: SignedIn,
  shop: OrderShop,
  product: { name: string; slug: string; price: string; stock: number },
): Promise<{ listingId: string; productId: string; variantId: string }> {
  const made = await createProduct(app, who, shop.unitId, product.name, product.price);
  const variantId = made.variants[0]?.id ?? '';
  await setStock(
    sql,
    { tenantId: shop.tenantId, warehouseId: shop.warehouseId, productId: made.id, variantId },
    product.stock,
  );
  const listingId = await addListing(sql, shop.tenantId, {
    product: made,
    categoryId: shop.categoryId,
    slug: product.slug,
    publishedDaysAgo: 1,
  });
  return { listingId, productId: made.id, variantId };
}

// The pieces on hand, straight in stock_balances: the shop only reads them, and the tests need a
// known number without a goods receipt. A product without batches has one row per warehouse
// (batch_id NULL; the key treats NULLs as equal), so a second call changes that row
export async function setStock(
  sql: postgres.Sql,
  at: { tenantId: string; warehouseId: string; productId: string; variantId: string },
  quantity: number,
): Promise<void> {
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${at.tenantId}, ${at.warehouseId}, ${at.productId}, ${at.variantId}, ${quantity})
    ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE SET quantity = EXCLUDED.quantity`;
}
```

- `shopHeaders()` sends what the shop's server will send in 27a.5: the host, the key and the shopper's address.
- `clientAddress()` makes a real IPv4 address from a number. The first draft used `203.0.113.${n}`, which is not an
  address once `n` is over 255. `ShopClient` then ignored it (correctly) and counted the caller instead, so every
  such test shared one address and the twenty-orders limit stopped the later tests. Not IPv6: the limits count a
  whole /64 as one shopper, so `2001:db8::1` and `2001:db8::2` would be the same shopper.
- `phoneOf()` gives each test numbers no other test uses (`01711000101`); they pass `shopPhoneSchema` and the
  table's phone check.
- `codeFor()` reads the newest SMS to a phone from Mailpit, inside `eventually()`, because the worker sends it a
  moment after the answer. `after` waits for a newer SMS than one already read, which is how a resend is tested.
  The code is read from the start of the text, where `shop-sms.ts` puts it in both languages.
- `trackingTokenFor()` takes the token from the end of the confirm SMS. It is the only copy: the database keeps a
  hash.
- `orderShop()` builds a launched shop the way 26f's tests do (`launchShop`, `addListing`), with one product and a
  known stock. `setStock()` writes `stock_balances` directly: the shop only reads it, and a goods receipt would
  bring in purchasing for no reason. `ON CONFLICT ON CONSTRAINT stock_balances_key` changes the one row a product
  without batches has.
- `addShopProduct()` lists one more product for a test that must know every hold on it. The first product is held
  by every other test's orders.

### The order tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  problemSchema,
  publicOrderPlacedSchema,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_ORDER_WINDOW_MINUTES,
  SHOP_ORDERS_PER_ADDRESS,
  SHOP_ORDERS_PER_PHONE,
  SHOP_TRACK_TRIES,
  SHOP_TRACK_WINDOW_MINUTES,
  shopCartQuoteSchema,
  shopCheckoutSettingsSchema,
  shopCodeResentSchema,
  shopCodeWaitSchema,
  shopOrderConfirmedSchema,
  shopOrderSchema,
  shopProductPageSchema,
  shopTrackingSchema,
} from '@omnivo/contracts';
import type { Redis } from 'ioredis';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REDIS } from '../../infra/tokens.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  TEST_SHOP_KEY,
  testConfig,
  testWorkerConfig,
} from '../../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../../testing/http.js';
import { lastMailTo } from '../../testing/mailpit.js';
import {
  addShopProduct,
  clientAddress,
  codeFor,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  placeOrder,
  shopHeaders,
  shopPost,
  smsAddress,
  trackingTokenFor,
  wrongCode,
} from '../../testing/shop-orders.js';
import { tokenHash } from './order-secrets.js';
import { PendingOrderSweep } from './pending-order-sweep.js';

// Step 27a: the shop's orders against the real stack: Postgres (omnivo_shop, the holds, the
// counter), Redis (the limits, the SMS queue), the worker (the SMS to Mailpit, the bell, the
// sweep). Every test has its own phones (phoneOf) and its own shopper address, because the limits
// count per phone and per address across the whole API, and the SMS inbox is per phone. Times are
// moved by writing the order's own columns as the superuser, never by waiting.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let shop: OrderShop;

// 2 × ৳229 + ৳80 delivery: over the shop's ৳300 minimum, under its ৳1,000 free delivery
const TWO_NEEM = '538';

// A shopper of this test, with an address of their own
function shopper(n: number): Record<string, string> {
  return shopHeaders(shop.host, clientAddress(n));
}

// One order of two face washes from this phone, that must be placed
function placeTwo(headers: Record<string, string>, phone: string): Promise<string> {
  return placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TWO_NEEM));
}

const orderRowSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  order_no: z.string().nullable(),
  order_token_hash: z.string(),
  tracking_token_hash: z.string().nullable(),
  code_hash: z.string().nullable(),
  code_sends: z.number().nullable(),
  code_tries_left: z.number().nullable(),
  // to_json: the times as ISO text, so the minutes between them can be compared exactly
  created_at: z.string(),
  code_expires_at: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  total: z.string(),
});

// The orders of this phone in the shop, newest first, read as the superuser (no RLS)
async function ordersOf(phone: string) {
  return z.array(orderRowSchema).parse(
    await sql`
      SELECT id::text, status, order_no, order_token_hash, tracking_token_hash, code_hash,
        code_sends, code_tries_left, to_json(created_at) #>> '{}' AS created_at,
        to_json(code_expires_at) #>> '{}' AS code_expires_at,
        to_json(confirmed_at) #>> '{}' AS confirmed_at, total::text
      FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}
      ORDER BY created_at DESC`,
  );
}

async function onlyOrderOf(phone: string) {
  const [row, ...more] = await ordersOf(phone);
  expect(more).toHaveLength(0);
  if (row === undefined) throw new Error(`no order from ${phone}`);
  return row;
}

const holdRowSchema = z.object({ quantity: z.string(), expires_at: z.string().nullable() });

async function holdsOf(orderId: string) {
  return z.array(holdRowSchema).parse(
    await sql`
      SELECT quantity::text, to_json(expires_at) #>> '{}' AS expires_at
      FROM storefront_stock_holds WHERE order_id = ${orderId}`,
  );
}

// The clock, moved for one order: its placing, its code and its holds, `minutes` earlier. Every
// time column moves by the same amount, so the table's checks (code_expires_at > code_sent_at)
// still hold
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders
    SET created_at = created_at - ${by}::interval,
      code_sent_at = code_sent_at - ${by}::interval,
      code_expires_at = code_expires_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
  await sql`
    UPDATE storefront_stock_holds h SET expires_at = h.expires_at - ${by}::interval
    FROM storefront_orders o
    WHERE h.order_id = o.id AND o.tenant_id = ${shop.tenantId} AND o.phone = ${phone}`;
}

// Only the last code's send time moves back: "Resend code" may be pressed again
async function ageCode(phone: string, seconds: number): Promise<void> {
  const by = `${String(seconds)} seconds`;
  await sql`
    UPDATE storefront_orders
    SET code_sent_at = code_sent_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

function problemOf(res: { json: () => unknown }) {
  return problemSchema.parse(res.json());
}

async function productInStock(slug: string): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: `/public/v1/products/${slug}`,
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopProductPageSchema.parse(res.json()).product.inStock;
}

// Sends requests "at the same moment" for sure, not by luck: a request's transaction is a few
// milliseconds, so ones sent together could just as well run one after the other. A transaction
// of the test's own locks `table`, so each request runs up to its first write there and waits.
// Only once `waiting` of them wait for a lock (at that table, or at a lock of the API's own that
// the first one holds) does the gate open
async function atOnce<T>(table: string, waiting: number, send: () => Promise<T>): Promise<T> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent = send();
    await eventually(async () => {
      const [row] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      expect(row?.n).toBe(waiting);
    });
    // Wrapped: a promise returned alone (or in an array) would be awaited before the gate opens,
    // and the requests behind it would wait for ever
    return { sent };
  });
  return gate.sent;
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
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
  // Plenty of face washes: the tests that run out of stock use a product of their own
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 1000 });
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe("the shop server's key", () => {
  it('refuses a call with no key, a wrong key or the key twice, before reading the body', async () => {
    const host = { 'x-shop-host': shop.host };
    const calls = [
      host,
      { ...host, 'x-shop-key': 'a-key-that-is-long-enough-but-not-the-one' },
      // Sent twice, the header is a list: no key at all, even when both copies are right
      { ...host, 'x-shop-key': [TEST_SHOP_KEY, TEST_SHOP_KEY] },
    ];
    for (const headers of calls) {
      // An empty body: 401, not 400, shows the key is checked before the body
      const res = await app.inject({
        method: 'POST',
        url: '/public/v1/orders',
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
      expect(problemOf(res).code).toBe('storefront_shop_key_invalid');
    }
  });

  it('refuses every order route when the API has no key set', async () => {
    const config = testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url });
    const keyless = await createTestApp({
      ...config,
      storefront: { ...config.storefront, shopKey: null },
    });
    try {
      const res = await keyless.inject({
        method: 'POST',
        url: '/public/v1/track',
        headers: shopper(1),
        payload: { phone: phoneOf(1), orderNo: 'W-000001' },
      });
      expect(res.statusCode).toBe(401);
      expect(problemOf(res).code).toBe('storefront_shop_key_invalid');
      // The public reads do not need the key, with or without one set
      const read = await keyless.inject({
        method: 'GET',
        url: '/public/v1/shop',
        headers: { 'x-shop-host': shop.host },
      });
      expect(read.statusCode, read.body).toBe(200);
    } finally {
      await keyless.close();
    }
  });
});

describe('placing an order', () => {
  it('writes a pending order with no number, only hashes, and a one-hour hold', async () => {
    const phone = phoneOf(101);
    const res = await shopPost(
      app,
      '/orders',
      shopper(101),
      orderRequest(shop.listingId, 2, '+880 1711-000101', TWO_NEEM),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { answer, token } = publicOrderPlacedSchema.parse(res.json());
    expect(answer).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 101',
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
    });

    // The phone as one form (01…), no number yet, the token and the code only as hashes
    const order = await onlyOrderOf(phone);
    expect(order).toMatchObject({
      status: 'pending',
      order_no: null,
      tracking_token_hash: null,
      code_sends: 1,
      code_tries_left: 5,
      total: '538.0000',
    });
    expect(order.order_token_hash).toBe(tokenHash(token));
    const { code } = await codeFor(mail.apiUrl, phone);
    // Only the HMAC: the code itself is in the SMS and nowhere else
    expect(order.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(order.code_expires_at ?? '') - Date.parse(order.created_at)).toBe(
      10 * 60 * 1000,
    );
    const [hold, ...more] = await holdsOf(order.id);
    expect(more).toHaveLength(0);
    expect(hold?.quantity).toBe('2.0000');
    expect(Date.parse(hold?.expires_at ?? '') - Date.parse(order.created_at)).toBe(60 * 60 * 1000);

    // The SMS in the shop's language, the code first
    const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
    expect(sms.text.trim()).toBe(
      `${code} is your Nirvor order code. It works for 10 minutes. Do not share it.`,
    );
    // The code and the phone never pass through the outbox table (decision 8): the SMS goes on its
    // own queue after the commit
    const outbox = await sql`SELECT payload::text AS payload FROM outbox_events`;
    for (const row of outbox) {
      expect(String(row.payload)).not.toContain(code);
      expect(String(row.payload)).not.toContain(phone);
    }
  });

  it('refuses Mobile Banking until step 27c, and the checkout does not offer it', async () => {
    await sql`
      UPDATE storefront_settings SET payment_methods = '{cod,online}'
      WHERE tenant_id = ${shop.tenantId}`;
    try {
      const settings = await app.inject({
        method: 'GET',
        url: '/public/v1/checkout-settings',
        headers: { 'x-shop-host': shop.host },
      });
      expect(shopCheckoutSettingsSchema.parse(settings.json()).paymentMethods).toEqual(['cod']);
      const res = await shopPost(app, '/orders', shopper(102), {
        ...orderRequest(shop.listingId, 2, phoneOf(102), TWO_NEEM),
        paymentMethod: 'online',
      });
      expect(res.statusCode).toBe(422);
      expect(problemOf(res).code).toBe('shop_payment_unavailable');
    } finally {
      await sql`
        UPDATE storefront_settings SET payment_methods = '{cod}'
        WHERE tenant_id = ${shop.tenantId}`;
    }
  });

  it('refuses an unknown zone, an order under the minimum and a total the shopper did not see', async () => {
    const phone = phoneOf(103);
    const zone = await shopPost(app, '/orders', shopper(103), {
      ...orderRequest(shop.listingId, 2, phone, TWO_NEEM),
      zoneId: 'outside_dhaka',
    });
    expect(zone.statusCode).toBe(422);
    expect(problemOf(zone).code).toBe('shop_zone_unknown');

    // One face wash is ৳229, under the ৳300 minimum
    const small = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest(shop.listingId, 1, phone, '309'),
    );
    expect(small.statusCode).toBe(422);
    expect(problemOf(small)).toMatchObject({ code: 'shop_order_below_minimum' });

    // The price went up since the checkout's quote
    const changed = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest(shop.listingId, 2, phone, '500'),
    );
    expect(changed.statusCode).toBe(409);
    expect(problemOf(changed).code).toBe('shop_order_changed');

    // A listing that is not in the shop (any more) is a change too
    const gone = await shopPost(
      app,
      '/orders',
      shopper(103),
      orderRequest('00000000-0000-4000-8000-000000000000', 2, phone, TWO_NEEM),
    );
    expect(gone.statusCode).toBe(409);
    expect(problemOf(gone).code).toBe('shop_order_changed');

    // Nothing was written, and none of the refusals counted towards the phone's limit: five more
    // orders from this phone are still taken
    expect(await ordersOf(phone)).toHaveLength(0);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) await placeTwo(shopper(103), phone);
  });
});

describe('the stock an order holds', () => {
  it('holds the last piece while the code is awaited, and frees it after an hour', async () => {
    const gel = await addShopProduct(app, sql, owner, shop, {
      name: 'Aloe Vera Gel',
      slug: 'aloe-vera-gel',
      price: '350',
      stock: 1,
    });
    const phone = phoneOf(201);
    expect(await productInStock('aloe-vera-gel')).toBe(true);
    const token = await placeOrder(app, shopper(201), orderRequest(gel.listingId, 1, phone, '430'));

    // 1 on hand, 1 held: the shop shows it sold out, the quote says so, and a second order fails
    expect(await productInStock('aloe-vera-gel')).toBe(false);
    const quote = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: { 'x-shop-host': shop.host },
      payload: { lines: [{ listingId: gel.listingId, quantity: 1 }] },
    });
    expect(shopCartQuoteSchema.parse(quote.json()).lines[0]?.status).toBe('out_of_stock');
    const second = await shopPost(
      app,
      '/orders',
      shopper(202),
      orderRequest(gel.listingId, 1, phoneOf(202), '430'),
    );
    expect(second.statusCode).toBe(409);

    // An hour later the hold has ended, before any sweep: the piece is for sale again, and the
    // order can no longer be confirmed, even with the right code
    const { code } = await codeFor(mail.apiUrl, phone);
    await ageOrder(phone, 61);
    expect(await productInStock('aloe-vera-gel')).toBe(true);
    const late = await shopPost(app, '/orders/verify', shopper(201), { token, code });
    expect(late.statusCode).toBe(404);
    expect(problemOf(late).code).toBe('shop_code_no_order');
    expect((await shopPost(app, '/orders/code-wait', shopper(201), { token })).statusCode).toBe(
      404,
    );
  });

  it('sells the last piece once when five shoppers order it at the same moment', async () => {
    const tea = await addShopProduct(app, sql, owner, shop, {
      name: 'Tulsi Green Tea',
      slug: 'tulsi-green-tea',
      price: '420',
      stock: 1,
    });
    // Each order reads the stock, then waits at its hold's INSERT: one at the table and four at
    // the variant's lock (shop-orders.service.ts). Without that lock all five would wait at the
    // table, each having read one free piece
    const results = await atOnce('storefront_stock_holds', 5, () =>
      Promise.all(
        // 420 + 80
        [211, 212, 213, 214, 215].map((n) =>
          shopPost(app, '/orders', shopper(n), orderRequest(tea.listingId, 1, phoneOf(n), '500')),
        ),
      ),
    );
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    const held = await sql`
      SELECT coalesce(sum(quantity), 0)::text AS held FROM storefront_stock_holds
      WHERE variant_id = ${tea.variantId}`;
    expect(held[0]?.held).toBe('1.0000');

    // The confirm keeps the hold, now with no end: the piece stays sold until 27b's challan
    const winner = results.findIndex((res) => res.statusCode === 201);
    const phone = phoneOf(211 + winner);
    const token = publicOrderPlacedSchema.parse(results[winner]?.json()).token;
    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(211 + winner), { token, code });
    expect(right.statusCode, right.body).toBe(200);
    const order = await onlyOrderOf(phone);
    expect(await holdsOf(order.id)).toEqual([{ quantity: '1.0000', expires_at: null }]);
    await ageOrder(phone, 120);
    expect(await productInStock('tulsi-green-tea')).toBe(false);
  });
});

describe('the phone code', () => {
  it('confirms the order with the right code: a number, the tracking SMS and the bell', async () => {
    const phone = phoneOf(301);
    const token = await placeTwo(shopper(301), phone);

    const wait = await shopPost(app, '/orders/code-wait', shopper(301), { token });
    expect(wait.statusCode, wait.body).toBe(200);
    const waiting = shopCodeWaitSchema.parse(wait.json());
    expect(waiting).toMatchObject({
      maskedPhone: '+880 17•• ••• 301',
      listingIds: [shop.listingId],
    });
    expect(waiting.resendInSeconds).toBeGreaterThan(0);
    expect(waiting.resendInSeconds).toBeLessThanOrEqual(SHOP_CODE_RESEND_SECONDS);

    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(301), { token, code });
    expect(right.statusCode, right.body).toBe(200);
    const { orderNo } = shopOrderConfirmedSchema.parse(right.json());
    expect(orderNo).toMatch(/^W-\d{6}$/);
    expect(right.json()).toEqual({ orderNo, phone });

    // Every code column is gone; the number, the tracking hash and the time are there
    const order = await onlyOrderOf(phone);
    expect(order).toMatchObject({
      status: 'confirmed',
      order_no: orderNo,
      code_hash: null,
      code_sends: null,
      code_tries_left: null,
      code_expires_at: null,
    });
    expect(order.confirmed_at).not.toBeNull();

    // The second SMS: the number and the link, whose token only the SMS has. The link is made from
    // the API's own settings (SHOP_PUBLIC_PORT: 4321 outside production), never from the host the
    // request named
    const link = await trackingTokenFor(mail.apiUrl, phone);
    expect(order.tracking_token_hash).toBe(tokenHash(link));
    const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
    expect(sms.text.trim()).toBe(
      `Nirvor: order ${orderNo} is confirmed. Track it here: http://nirvor.localhost:4321/t/${link}`,
    );

    // The code is used up: the same code again finds no order
    const again = await shopPost(app, '/orders/verify', shopper(301), { token, code });
    expect(again.statusCode).toBe(404);

    // The bell: the number and the total, never the buyer's name or phone
    await eventually(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: bearer(owner.accessToken),
      });
      const bell = notificationPageSchema
        .parse(res.json())
        .items.find(
          (item) => item.type === 'storefront.order_confirmed' && item.params.number === orderNo,
        );
      expect(bell?.params).toEqual({ id: order.id, number: orderNo, total: '538.0000' });
    });
  });

  it('counts each wrong code, and drops the order and its hold at the fifth', async () => {
    const phone = phoneOf(302);
    const token = await placeTwo(shopper(302), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const { id } = await onlyOrderOf(phone);

    for (let triesLeft = 4; triesLeft >= 1; triesLeft -= 1) {
      const res = await shopPost(app, '/orders/verify', shopper(302), {
        token,
        code: wrongCode(code),
      });
      expect(res.statusCode).toBe(422);
      expect(problemOf(res)).toMatchObject({ code: 'shop_code_wrong', params: { triesLeft } });
      // Written down, not rolled back with the refusal
      expect((await onlyOrderOf(phone)).code_tries_left).toBe(triesLeft);
    }
    const last = await shopPost(app, '/orders/verify', shopper(302), {
      token,
      code: wrongCode(code),
    });
    expect(last.statusCode).toBe(422);
    expect(problemOf(last).code).toBe('shop_code_too_many');
    expect(await ordersOf(phone)).toHaveLength(0);
    expect(await holdsOf(id)).toHaveLength(0);
    // Not even the right code brings it back
    expect((await shopPost(app, '/orders/verify', shopper(302), { token, code })).statusCode).toBe(
      404,
    );
  });

  it('refuses a code past its 10 minutes without spending a try', async () => {
    const phone = phoneOf(303);
    const token = await placeTwo(shopper(303), phone);
    const { code, id } = await codeFor(mail.apiUrl, phone);
    await ageOrder(phone, 11);

    const expired = await shopPost(app, '/orders/verify', shopper(303), { token, code });
    expect(expired.statusCode).toBe(422);
    expect(problemOf(expired).code).toBe('shop_code_expired');
    expect((await onlyOrderOf(phone)).code_tries_left).toBe(5);

    // A new code works: the order still has 49 of its 60 minutes
    const resent = await shopPost(app, '/orders/resend', shopper(303), { token });
    expect(resent.statusCode, resent.body).toBe(200);
    const fresh = await codeFor(mail.apiUrl, phone, id);
    const right = await shopPost(app, '/orders/verify', shopper(303), { token, code: fresh.code });
    expect(right.statusCode, right.body).toBe(200);
  });

  it('resends after 45 seconds, three codes at most, and only the newest one works', async () => {
    const phone = phoneOf(304);
    const token = await placeTwo(shopper(304), phone);
    const first = await codeFor(mail.apiUrl, phone);

    const early = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(early.statusCode).toBe(429);
    const wait = problemOf(early);
    expect(wait.code).toBe('shop_code_resend_wait');
    expect(wait.params?.seconds).toBeGreaterThan(0);

    await ageCode(phone, SHOP_CODE_RESEND_SECONDS + 1);
    const second = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(second.statusCode, second.body).toBe(200);
    expect(shopCodeResentSchema.parse(second.json())).toEqual({
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
    });
    const newer = await codeFor(mail.apiUrl, phone, first.id);
    // The first code stopped working when the second was sent (unless the two happen to match)
    if (first.code !== newer.code) {
      const old = await shopPost(app, '/orders/verify', shopper(304), { token, code: first.code });
      expect(problemOf(old)).toMatchObject({ code: 'shop_code_wrong', params: { triesLeft: 4 } });
    }

    await ageCode(phone, SHOP_CODE_RESEND_SECONDS + 1);
    expect((await shopPost(app, '/orders/resend', shopper(304), { token })).statusCode).toBe(200);
    const third = await codeFor(mail.apiUrl, phone, newer.id);
    expect((await onlyOrderOf(phone)).code_sends).toBe(3);

    // The third was the last: no wait helps any more, so it says so even before the 45 seconds
    const used = await shopPost(app, '/orders/resend', shopper(304), { token });
    expect(used.statusCode).toBe(422);
    expect(problemOf(used).code).toBe('shop_code_sends_used');

    const right = await shopPost(app, '/orders/verify', shopper(304), { token, code: third.code });
    expect(right.statusCode, right.body).toBe(200);
  });

  it('confirms once when the right code arrives twice at the same moment', async () => {
    const phone = phoneOf(305);
    const token = await placeTwo(shopper(305), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    // One waits at the order counter, the other at the order's row lock (FOR UPDATE). Without
    // that lock both would have checked the code and wait at the counter, and both would confirm
    const [a, b] = await atOnce('storefront_order_counters', 2, () =>
      Promise.all([
        shopPost(app, '/orders/verify', shopper(305), { token, code }),
        shopPost(app, '/orders/verify', shopper(305), { token, code }),
      ]),
    );
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    expect((await onlyOrderOf(phone)).status).toBe('confirmed');
  });

  it('numbers two orders confirmed at the same moment one after the other', async () => {
    const phones = [phoneOf(306), phoneOf(307)];
    const tokens = await Promise.all(phones.map((phone, i) => placeTwo(shopper(306 + i), phone)));
    const codes = await Promise.all(phones.map((phone) => codeFor(mail.apiUrl, phone)));
    // Both wait at the counter, then take its row one after the other
    const answers = await atOnce('storefront_order_counters', 2, () =>
      Promise.all(
        phones.map((_, i) =>
          shopPost(app, '/orders/verify', shopper(306 + i), {
            token: tokens[i] ?? '',
            code: codes[i]?.code ?? '',
          }),
        ),
      ),
    );
    for (const res of answers) expect(res.statusCode, res.body).toBe(200);
    const numbers = answers
      .map((res) => Number(shopOrderConfirmedSchema.parse(res.json()).orderNo.slice(2)))
      .sort((x, y) => x - y);
    expect(numbers[1]).toBe((numbers[0] ?? 0) + 1);
  });
});

describe('the order and tracking pages', () => {
  it('shows a confirmed order to its token with its number, and to its number with its phone', async () => {
    const phone = phoneOf(401);
    const token = await placeTwo(shopper(401), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const right = await shopPost(app, '/orders/verify', shopper(401), { token, code });
    const { orderNo } = shopOrderConfirmedSchema.parse(right.json());

    // The number as a shopper may type it: any case, no dash
    const found = await shopPost(app, '/orders/find', shopper(401), {
      token,
      orderNo: orderNo.replace('W-', 'w'),
    });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.headers['cache-control']).toBe('no-store');
    expect(shopOrderSchema.parse(found.json())).toMatchObject({
      orderNo,
      status: 'confirmed',
      phone,
    });
    // Another order's token with this number: the same 404 as a number that does not exist
    const other = await placeTwo(shopper(401), phoneOf(402));
    const wrong = await shopPost(app, '/orders/find', shopper(401), { token: other, orderNo });
    expect(wrong.statusCode).toBe(404);

    const tracking = await shopPost(app, '/tracking', shopper(401), {
      token: await trackingTokenFor(mail.apiUrl, phone),
    });
    expect(tracking.statusCode, tracking.body).toBe(200);
    expect(shopTrackingSchema.parse(tracking.json())).toMatchObject({
      orderNo,
      itemCount: 2,
      total: '538.0000',
    });
    // A tracking answer names no one: no phone, no address (26e's decision)
    expect(tracking.body).not.toContain(phone.slice(3));
    expect(tracking.body).not.toContain('Mirpur');

    // The /track form, with the phone typed another way
    const track = await shopPost(app, '/track', shopper(401), {
      phone: '+880 1711-000401',
      orderNo,
    });
    expect(track.statusCode, track.body).toBe(200);
  });

  it('never shows a pending order on /track', async () => {
    const phone = phoneOf(403);
    await placeTwo(shopper(403), phone);
    // A pending order has no number; the counter's next one is not its
    const res = await shopPost(app, '/track', shopper(403), { phone, orderNo: 'W-999999' });
    expect(res.statusCode).toBe(404);
    expect(problemOf(res).code).toBe('shop_track_not_found');
  });

  it('stops an address after ten misses on /track, and a hit never counts', async () => {
    const phone = phoneOf(404);
    const token = await placeTwo(shopper(404), phone);
    const { code } = await codeFor(mail.apiUrl, phone);
    const { orderNo } = shopOrderConfirmedSchema.parse(
      (await shopPost(app, '/orders/verify', shopper(404), { token, code })).json(),
    );
    const hit = { phone, orderNo };
    const miss = { phone: phoneOf(405), orderNo };

    for (let i = 0; i < SHOP_TRACK_TRIES + 2; i += 1) {
      expect((await shopPost(app, '/track', shopper(404), hit)).statusCode).toBe(200);
    }
    for (let i = 0; i < SHOP_TRACK_TRIES; i += 1) {
      expect((await shopPost(app, '/track', shopper(404), miss)).statusCode).toBe(404);
    }
    // Over the limit, even the right pair is refused: a guesser learns nothing more
    const stopped = await shopPost(app, '/track', shopper(404), hit);
    expect(stopped.statusCode).toBe(429);
    expect(problemOf(stopped)).toMatchObject({
      code: 'shop_track_too_many',
      params: { minutes: SHOP_TRACK_WINDOW_MINUTES },
    });
    // Another shopper is not stopped
    expect((await shopPost(app, '/track', shopper(406), hit)).statusCode).toBe(200);
  });

  it('counts the shop server itself when the address header is not one address', async () => {
    // A list (a proxy's X-Forwarded-For copied as it is) is not used: the misses count under the
    // caller's own address, which every call without the header shares
    const listed = shopHeaders(shop.host, `${clientAddress(408)}, 10.9.9.9`);
    for (let i = 0; i < SHOP_TRACK_TRIES; i += 1) {
      const res = await shopPost(app, '/track', listed, {
        phone: phoneOf(407),
        orderNo: 'W-999999',
      });
      expect(res.statusCode).toBe(404);
    }
    const bare = { 'x-shop-host': shop.host, 'x-shop-key': TEST_SHOP_KEY };
    const res = await shopPost(app, '/track', bare, { phone: phoneOf(407), orderNo: 'W-999999' });
    expect(res.statusCode).toBe(429);
    // …and not under the first address of the list
    const first = await shopPost(app, '/track', shopper(408), {
      phone: phoneOf(407),
      orderNo: 'W-999999',
    });
    expect(first.statusCode).toBe(404);
  });
});

describe('the order limits', () => {
  it(`takes ${String(SHOP_ORDERS_PER_PHONE)} orders an hour from one phone, from any address`, async () => {
    const phone = phoneOf(501);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) await placeTwo(shopper(510 + i), phone);
    const sixth = await shopPost(
      app,
      '/orders',
      shopper(519),
      orderRequest(shop.listingId, 2, phone, TWO_NEEM),
    );
    expect(sixth.statusCode).toBe(429);
    expect(problemOf(sixth)).toMatchObject({
      code: 'shop_order_limit',
      params: { minutes: SHOP_ORDER_WINDOW_MINUTES },
    });
    expect(await ordersOf(phone)).toHaveLength(SHOP_ORDERS_PER_PHONE);
  });

  it(`takes ${String(SHOP_ORDERS_PER_ADDRESS)} orders an hour from one address, from any phone`, async () => {
    for (let i = 0; i < SHOP_ORDERS_PER_ADDRESS; i += 1)
      await placeTwo(shopper(520), phoneOf(520 + i));
    const over = await shopPost(
      app,
      '/orders',
      shopper(520),
      orderRequest(shop.listingId, 2, phoneOf(549), TWO_NEEM),
    );
    expect(over.statusCode).toBe(429);
    expect(problemOf(over).code).toBe('shop_order_limit');
    // The same phone from another address is taken
    await placeTwo(shopper(521), phoneOf(549));
  });

  it('keeps no phone number and no address in Redis', async () => {
    const keys = await app.get<Redis>(REDIS).keys('shop-limit:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^shop-limit:[a-z-]+:[0-9a-f]{32}$/);
    }
  });
});

describe('the SMS', () => {
  it("writes both SMS in the shop's language", async () => {
    await sql`UPDATE storefront_settings SET language = 'bn' WHERE tenant_id = ${shop.tenantId}`;
    try {
      const phone = phoneOf(601);
      const token = await placeTwo(shopper(601), phone);
      const { code } = await codeFor(mail.apiUrl, phone);
      const sms = await lastMailTo(mail.apiUrl, smsAddress(phone));
      expect(sms.text.trim()).toBe(
        `${code} আপনার Nirvor অর্ডারের কোড। ১০ মিনিট কাজ করবে। কাউকে বলবেন না।`,
      );
      const right = await shopPost(app, '/orders/verify', shopper(601), { token, code });
      const { orderNo } = shopOrderConfirmedSchema.parse(right.json());
      const link = await trackingTokenFor(mail.apiUrl, phone);
      const confirmed = await lastMailTo(mail.apiUrl, smsAddress(phone));
      expect(confirmed.text.trim()).toBe(
        `Nirvor: অর্ডার ${orderNo} নিশ্চিত হয়েছে। এখানে দেখুন: http://nirvor.localhost:4321/t/${link}`,
      );
    } finally {
      await sql`UPDATE storefront_settings SET language = 'en' WHERE tenant_id = ${shop.tenantId}`;
    }
  });
});

describe('the sweep', () => {
  it('deletes the orders that waited for their code over an hour, and nothing else', async () => {
    const waiting = phoneOf(701);
    const old = phoneOf(702);
    const done = phoneOf(703);
    await placeTwo(shopper(701), waiting);
    await placeTwo(shopper(702), old);
    const token = await placeTwo(shopper(703), done);
    const { code } = await codeFor(mail.apiUrl, done);
    expect((await shopPost(app, '/orders/verify', shopper(703), { token, code })).statusCode).toBe(
      200,
    );
    // Two orders over their hour: one still pending, one confirmed
    await ageOrder(old, 61);
    await ageOrder(done, 61);

    await worker.get(PendingOrderSweep).run();
    expect(await ordersOf(waiting)).toHaveLength(1);
    expect(await ordersOf(old)).toHaveLength(0);
    expect((await onlyOrderOf(done)).status).toBe('confirmed');
  });
});
```

How the file works:

- **Time is moved in the database, never waited for.** `ageOrder()` moves an order's placing, its code times and
  its holds back by the same number of minutes, so `storefront_orders_code_check` (`code_expires_at >
  code_sent_at`) still holds. `ageCode()` moves only the last send, for "Resend code". Both run as the superuser,
  who is not stopped by RLS.
- **`atOnce()`** is decision 33. `LOCK TABLE … IN SHARE MODE` lets the requests read but stops their first write to
  that table. The test counts the waiting locks in `pg_locks` and opens the gate when the number is right. The
  promise of the requests is returned inside an object: postgres.js awaits a promise (or an array of them) that
  `begin()`'s callback returns, before it commits, so returning it bare would wait for requests that wait for the
  commit, for ever.
- Rows are read back with `to_json(…) #>> '{}'`, so times arrive as ISO text and the minutes between them can be
  compared exactly, and every row is parsed with a Zod schema, as any answer from outside the program is.

What each group proves:

- **The shop server's key.** No key, a wrong key and the key sent twice all get 401 with an empty body. A 401 and
  not a 400 shows that the key is checked before the body. A second app with `shopKey: null` refuses every order
  route but still serves the public reads (decision 24).
- **Placing an order.** The phone is stored in its one form; the order has no number; the token and the code exist
  only as hashes; the code works 10 minutes and the hold 60, both counted from the order's own clock. The SMS is in
  English, code first. No outbox row holds the code or the phone (decision 26). Mobile Banking is neither offered
  nor taken (decision 29). An unknown zone, an order under the minimum, a changed total and a listing that is gone
  are refused, write nothing, and do not count towards the phone's limit: five orders from that phone still go
  through afterwards.
- **The stock an order holds.** With one piece on hand, a waiting order makes the product sold out on its page, in
  the quote and for a second order. An hour later the piece is for sale again before any sweep, and the right code
  no longer confirms. Five shoppers who order the last piece at once (held by `atOnce`) get one 201 and four 409,
  and one piece is held in all. The confirm keeps the hold, with no end, even two hours later.
- **The phone code.** The right code confirms: a `W-` number, every code column empty, the tracking hash equal to
  the hash of the token in the SMS, and the bell with the id, the number and the total only. The same code again
  finds nothing. Each wrong code is written down (4, 3, 2, 1 tries left) and the fifth deletes the order and its
  hold. An expired code is refused without spending a try, and a new code still confirms. "Resend code" waits 45
  seconds, sends at most three codes, the newest replaces the older one, and the fourth ask says all codes are
  used. The right code sent twice at once confirms once (200 and 404), and two orders confirmed at once get two
  numbers in a row.
- **The order and tracking pages.** `/orders/find` takes the number in any case and without the dash, but only
  with the order's own token. The tracking answer names no one. `/track` takes the phone typed another way, never
  shows a pending order, stops an address after ten misses (hits never count, and the stop also refuses the right
  pair), and does not stop another address. A header with a list of addresses is not used: the misses count under
  the caller's own address.
- **The order limits.** Five orders an hour from one phone from any address, twenty from one address with any
  phone; the answer gives the minutes to wait. Redis keys are `shop-limit:<name>:<32 hex>`, so no phone number or
  address is kept there.
- **The SMS.** A shop set to Bangla sends both SMS in Bangla. The tracking link uses the API's own setting
  (`SHOP_PUBLIC_PORT`, 4321 outside production), never the host the request named.
- **The sweep.** An order over its hour that still waits is deleted; one that waits less, and a confirmed one over
  its hour, are kept.

### The tenant-leak tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  notificationPageSchema,
  problemSchema,
  SHOP_ORDERS_PER_PHONE,
  shopOrderConfirmedSchema,
} from '@omnivo/contracts';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Transaction } from '../../common/tenant/with-tenant.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../../testing/app.js';
import {
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../../testing/http.js';
import {
  clientAddress,
  codeFor,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  placeOrder,
  shopHeaders,
  shopPost,
  trackingTokenFor,
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';

// Step 27a: an order is a buyer's name, phone and address, reached with no login, by a token and a
// host. Two launched shops, Nirvor and Acme, each with an order: a token, a number or a phone of
// one must open nothing in the other, each shop counts its own numbers, and each workspace's bell
// rings for its own orders only. Then the database's walls: omnivo_shop sees the orders of the
// shop it was given and nothing of the ERP, and omnivo_public sees no order at all.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let nirvorOwner: SignedIn;
let acmeOwner: SignedIn;
let nirvor: OrderShop;
let acme: OrderShop;

// One confirmed order in each shop, made in the first test
interface Placed {
  phone: string;
  token: string;
  orderNo: string;
  trackingToken: string;
}
let nirvorOrder: Placed;
let acmeOrder: Placed;

const TWO = '538';

function problemOf(res: { json: () => unknown }) {
  return problemSchema.parse(res.json());
}

// drizzle wraps the driver's error (DrizzleQueryError); Postgres's own one is on a .cause
function pgErrorOf(error: unknown): { code: string; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return { code: current.code, message: current.message };
    }
  }
  return null;
}

// Refused for this table, not earlier. 42501 alone could come from the shop's lookup function or
// SET ROLE, and a test that only checked the code would pass with the whole way in broken
function expectDenied(error: unknown, table: string): void {
  expect(pgErrorOf(error)).toEqual({
    code: '42501',
    message: `permission denied for table ${table}`,
  });
}

async function placeAndConfirm(shop: OrderShop, n: number): Promise<Placed> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TWO));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const { orderNo } = shopOrderConfirmedSchema.parse(res.json());
  return { phone, token, orderNo, trackingToken: await trackingTokenFor(mail.apiUrl, phone) };
}

const countSchema = z.array(z.object({ n: z.number() }));

async function ordersIn(tenantId: string): Promise<number> {
  const rows = countSchema.parse(
    await sql`SELECT count(*)::int AS n FROM storefront_orders WHERE tenant_id = ${tenantId}`,
  );
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  nirvorOwner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  acmeOwner = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  // The same product, slug and price in both shops, so only the host tells the orders apart
  nirvor = await orderShop(app, sql, nirvorOwner, { slug: 'nirvor', name: 'Nirvor', stock: 100 });
  acme = await orderShop(app, sql, acmeOwner, { slug: 'acme', name: 'Acme', stock: 100 });
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops', () => {
  it('count their order numbers each from W-000001', async () => {
    nirvorOrder = await placeAndConfirm(nirvor, 1);
    acmeOrder = await placeAndConfirm(acme, 2);
    expect(nirvorOrder.orderNo).toBe('W-000001');
    expect(acmeOrder.orderNo).toBe('W-000001');
  });

  it("open nothing with the other shop's tokens, numbers or phones", async () => {
    const atAcme = shopHeaders(acme.host, clientAddress(10));
    // Nirvor's confirmed order, asked for at Acme's address. Acme has a W-000001 too
    const found = await shopPost(app, '/orders/find', atAcme, {
      token: nirvorOrder.token,
      orderNo: nirvorOrder.orderNo,
    });
    expect(found.statusCode).toBe(404);
    const tracking = await shopPost(app, '/tracking', atAcme, {
      token: nirvorOrder.trackingToken,
    });
    expect(tracking.statusCode).toBe(404);
    const track = await shopPost(app, '/track', atAcme, {
      phone: nirvorOrder.phone,
      orderNo: nirvorOrder.orderNo,
    });
    expect(track.statusCode).toBe(404);
    expect(problemOf(track).code).toBe('shop_track_not_found');
    // The same three at Nirvor: the 404s above are the wall, not broken requests
    const atNirvor = shopHeaders(nirvor.host, clientAddress(10));
    expect(
      (
        await shopPost(app, '/orders/find', atNirvor, {
          token: nirvorOrder.token,
          orderNo: nirvorOrder.orderNo,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await shopPost(app, '/tracking', atNirvor, { token: nirvorOrder.trackingToken })).statusCode,
    ).toBe(200);
  });

  it('cannot confirm, resend or read a waiting order through the other shop', async () => {
    const atNirvor = shopHeaders(nirvor.host, clientAddress(20));
    const atAcme = shopHeaders(acme.host, clientAddress(20));
    const phone = phoneOf(20);
    const token = await placeOrder(app, atNirvor, orderRequest(nirvor.listingId, 2, phone, TWO));
    const { code } = await codeFor(mail.apiUrl, phone);

    for (const [url, body] of [
      ['/orders/code-wait', { token }],
      ['/orders/verify', { token, code }],
      ['/orders/resend', { token }],
    ] as const) {
      const res = await shopPost(app, url, atAcme, body);
      expect(res.statusCode, url).toBe(404);
      expect(problemOf(res).code).toBe('shop_code_no_order');
    }
    // Still waiting at Nirvor, with every try left, and its code still works there
    const [row] = z
      .array(z.object({ status: z.string(), code_tries_left: z.number().nullable() }))
      .parse(
        await sql`SELECT status, code_tries_left FROM storefront_orders WHERE phone = ${phone}`,
      );
    expect(row).toEqual({ status: 'pending', code_tries_left: 5 });
    const right = await shopPost(app, '/orders/verify', atNirvor, { token, code });
    expect(right.statusCode, right.body).toBe(200);
    expect(shopOrderConfirmedSchema.parse(right.json()).orderNo).toBe('W-000002');
  });

  it("ring each workspace's bell for its own orders only", async () => {
    const bells = async (who: SignedIn) => {
      const res = await app.inject({
        method: 'GET',
        url: '/notifications',
        headers: bearer(who.accessToken),
      });
      return notificationPageSchema
        .parse(res.json())
        .items.filter((item) => item.type === 'storefront.order_confirmed')
        .map((item) => item.params.id);
    };
    const ids = async (tenantId: string) =>
      z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`
            SELECT id::text FROM storefront_orders
            WHERE tenant_id = ${tenantId} AND status = 'confirmed'`,
        )
        .map((row) => row.id)
        .sort();
    await eventually(async () => {
      expect((await bells(nirvorOwner)).sort()).toEqual(await ids(nirvor.tenantId));
      expect((await bells(acmeOwner)).sort()).toEqual(await ids(acme.tenantId));
    });
  });

  it('share the order limits: they count a phone on the whole platform, on purpose', async () => {
    // A script that sends one phone a code from every shop is still one phone (shop-limits.ts)
    const phone = phoneOf(30);
    for (let i = 0; i < SHOP_ORDERS_PER_PHONE; i += 1) {
      await placeOrder(
        app,
        shopHeaders(nirvor.host, clientAddress(30 + i)),
        orderRequest(nirvor.listingId, 2, phone, TWO),
      );
    }
    const res = await shopPost(
      app,
      '/orders',
      shopHeaders(acme.host, clientAddress(39)),
      orderRequest(acme.listingId, 2, phone, TWO),
    );
    expect(res.statusCode).toBe(429);
    expect(problemOf(res).code).toBe('shop_order_limit');
  });
});

describe('the omnivo_shop role', () => {
  // ShopDb.orders is the API's own way in: SET LOCAL ROLE omnivo_shop, Nirvor's workspace. The
  // queries below are ones the order routes never write, as a bug might
  function asShop<T>(query: (tx: Transaction) => Promise<T>, host = nirvor.host): Promise<T> {
    return app.get(ShopDb).orders(host, (tx) => query(tx));
  }

  it("sees its own shop's orders, lines and holds, and none of the other shop's", async () => {
    const seen = countSchema.parse(
      await asShop((tx) =>
        tx.execute(drizzleSql`
          SELECT (SELECT count(*) FROM storefront_orders)::int AS n
          UNION ALL SELECT (SELECT count(*) FROM storefront_orders WHERE tenant_id = ${acme.tenantId})::int
          UNION ALL SELECT (SELECT count(*) FROM storefront_order_lines WHERE tenant_id = ${acme.tenantId})::int
          UNION ALL SELECT (SELECT count(*) FROM storefront_stock_holds WHERE tenant_id = ${acme.tenantId})::int`),
      ),
    );
    expect(seen.map((row) => row.n)).toEqual([await ordersIn(nirvor.tenantId), 0, 0, 0]);
    expect(await ordersIn(acme.tenantId)).toBeGreaterThan(0);
  });

  it("cannot read the ERP's tables, nor change an order's money, phone, lines or holds", async () => {
    // Each query with the table it must be refused on
    const forbidden = [
      // Customers and suppliers, their invoices, the books, the ERP's own orders
      [drizzleSql`SELECT count(*) FROM parties`, 'parties'],
      [drizzleSql`SELECT count(*) FROM invoices`, 'invoices'],
      [drizzleSql`SELECT count(*) FROM journal_entries`, 'journal_entries'],
      [drizzleSql`SELECT count(*) FROM sales_orders`, 'sales_orders'],
      // Only the code and confirm columns may change (0071): never what the buyer agreed to pay,
      // where it goes, or what was bought
      [drizzleSql`UPDATE storefront_orders SET total = 1`, 'storefront_orders'],
      [drizzleSql`UPDATE storefront_orders SET phone = '01700000000'`, 'storefront_orders'],
      [drizzleSql`UPDATE storefront_order_lines SET quantity = 9`, 'storefront_order_lines'],
      [drizzleSql`UPDATE storefront_stock_holds SET quantity = 1`, 'storefront_stock_holds'],
      [drizzleSql`DELETE FROM storefront_stock_holds`, 'storefront_stock_holds'],
      [drizzleSql`DELETE FROM storefront_order_lines`, 'storefront_order_lines'],
    ] as const;
    for (const [query, table] of forbidden) {
      expectDenied(
        await asShop((tx) => tx.execute(query)).catch((caught: unknown) => caught),
        table,
      );
    }
  });

  it('sees no order at all as omnivo_public, the role of the public reads', async () => {
    const forbidden = [
      [drizzleSql`SELECT count(*) FROM storefront_orders`, 'storefront_orders'],
      [drizzleSql`SELECT count(*) FROM storefront_order_lines`, 'storefront_order_lines'],
      [drizzleSql`SELECT count(*) FROM storefront_order_counters`, 'storefront_order_counters'],
      // The holds: how much is held where, never by which order
      [drizzleSql`SELECT order_id FROM storefront_stock_holds`, 'storefront_stock_holds'],
    ] as const;
    for (const [query, table] of forbidden) {
      const error = await app
        .get(ShopDb)
        .read(nirvor.host, (tx) => tx.execute(query))
        .catch((caught: unknown) => caught);
      expectDenied(error, table);
    }
  });
});
```

Two launched shops, Nirvor and Acme, with the same product, slug and price, so only the host tells them apart.

- Each shop's first order is `W-000001` (decision 20: one counter per shop).
- Nirvor's token, number, tracking token and phone open nothing at Acme's address, although Acme has a `W-000001`
  too. The same calls at Nirvor answer, so the 404s are the wall and not broken requests.
- A waiting Nirvor order cannot be checked, confirmed or resent through Acme, and keeps all its tries.
- Each owner's bell has exactly their own workspace's confirmed orders.
- The phone limit is shared by the two shops, on purpose (decision 28). The test says so, so nobody "fixes" it.
- As `omnivo_shop` through `ShopDb.orders`, Nirvor sees its own orders and none of Acme's lines, holds or orders,
  even when the query names Acme's id. It cannot read the ERP's people, invoices, books or sales orders, and cannot
  change an order's total or phone, a line, or a hold's quantity.
- As `omnivo_public` (the public reads) no order, line or counter can be read, nor which order holds stock.

`expectDenied()` checks the whole message, `permission denied for table <name>`, not only the code 42501. With the
code alone, a test of forbidden queries also passed when `ShopDb.orders` ran as the wrong role: the shop's lookup
function was refused first, with the same code, and every forbidden query "failed" for that reason.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test                                       # 198 unit tests, unchanged
pnpm exec eslint apps/api/src/storefront/orders apps/api/src/testing
pnpm exec prettier --check apps/api/src/storefront/orders apps/api/src/testing
cd apps/api
npx vitest run src/storefront/orders/shop-orders.int.spec.ts --maxWorkers=3            # 22 tests
npx vitest run src/storefront/orders/shop-orders.tenant-leak.int.spec.ts --maxWorkers=3 # 8 tests
npx vitest run src/storefront rls-coverage --maxWorkers=3                              # 16 files, 176 tests
```

No code of 27a.3 changed: every test passed against it as it was.

Broken on purpose, each caught (and put back):

- The variant lock removed from `place()`: the last piece is sold five times. Without `atOnce` this was not caught.
- `FOR UPDATE` removed from `waitingOrder()`: the right code sent twice confirms twice.
- `/orders/find` without the token check: another order's token opens the order.
- `/track` counting hits too: the shopper who looks at their own order is stopped.
- `ShopDb.orders` as `omnivo_app`: five leak tests fail.
- Migration 0071 granting `UPDATE` on the whole `storefront_orders` table: the leak test of forbidden writes fails.

## 27a.5 — The shop

Until now the shop's `api` source read products and prices from the API, but kept orders, the phone code and
tracking in a mock order book in its own memory (26f.5). This part connects those to the routes of 27a.3. After it, an
order placed in a real shop is a row in the ERP's tables, its code comes by SMS, and `/track` asks the API.

The mock source stays for `pnpm dev`, the Playwright tests and the staging demo. It learns the API's new rules for the
code, so the pages are tested against the same answers. Nothing here changes the API or the contracts.

Decided while writing this part (the user may still object):

35. **The shopper's address is an argument, not part of the source.** `placeOrder(request, address)` and
    `track(request, address)` take it, because those two are the ones that count a shopper. The middleware stays as it
    is, and the mock source, which is one object for the whole process, can still count `/track` misses by address.
36. **`SHOP_API_KEY` is required with `SHOP_SOURCE=api`.** Without it the shop would show its products and then fail
    at Confirm Order, after the shopper filled in the whole form. The first request fails instead, with the setting's
    name in the message, as a missing `SHOP_API_URL` already does.
37. **The key and the address go only on routes with `auth: 'shop'`.** The route definition decides, not each call.
    A read route never carries the key, and an order route never goes without it.
38. **One token shape for both sources.** 26c's cookies took tokens of 32 to 128 characters, "for the real API's tokens"
    that did not exist yet. The API's are 22 (27a.1), so every checkout on the API source would have lost its cookie.
    The cookies now check `shopOrderTokenSchema`, and the mock makes tokens of the same shape.
39. **The mock keeps the API's code rules, not its order limits.** A code works 10 minutes and an order gets 3 codes,
    as in the API. The mock has no orders-per-phone limit: the Playwright tests place many orders from one address and
    one phone, and the API's own tests check that limit.
40. **The `/track` limit lives in the source.** The API counts misses in Redis (27a.3), so the shop's form no longer
    counts them itself. The mock source keeps 26e's limiter, which moves from `server/` into `data/mock/`.
41. **"No more codes" keeps the code box.** The third code may still be on its way, or still work for a few minutes.
    So "Resend code" goes, the box and Confirm Order stay, and "Back to checkout" shows under them. An expired code
    keeps the order too: the shopper asks for a new code.

### The shop server's settings

```diff
@@ -51,6 +51,9 @@ export default defineConfig({
         default: 'mock',
       }),
       SHOP_API_URL: envField.string({ context: 'server', access: 'secret', optional: true }),
+      // Step 27a: the key for the order routes (src/data/config.ts). This one is a secret in both
+      // senses: anyone who has it can place orders and send SMS in any shop's name
+      SHOP_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
     },
   },
 });
```

`SHOP_API_KEY` is read at run time, like the other two (`access: 'secret'`). Here it is also a secret in the usual
sense: anyone who has it can place orders and send SMS in any shop's name. It is optional in the schema, because the
mock source does not need it; `config.ts` decides when it is required.

```diff
@@ -2,10 +2,16 @@
 // - SHOP_SOURCE: 'mock' (the default: `pnpm dev`, the e2e tests and the staging demo) or 'api'
 // - SHOP_API_URL: the ERP API's address as the shop's server reaches it ("http://api:3000" inside
 //   the deploy's network). Only read with SHOP_SOURCE=api
-// A plain function of the two values, so the tests check the rules without Astro's env module.
-export type ShopConfig = { source: 'mock' } | { source: 'api'; apiUrl: string };
+// - SHOP_API_KEY (step 27a): the key the shop's server sends on the order routes (SHOP_KEY_HEADER).
+//   The API's STOREFRONT_SHOP_KEY has the same value. Only read with SHOP_SOURCE=api
+// A plain function of the values, so the tests check the rules without Astro's env module.
+export type ShopConfig = { source: 'mock' } | { source: 'api'; apiUrl: string; apiKey: string };
 
-export function shopConfigOf(source: 'mock' | 'api', apiUrl: string | undefined): ShopConfig {
+export function shopConfigOf(
+  source: 'mock' | 'api',
+  apiUrl: string | undefined,
+  apiKey: string | undefined,
+): ShopConfig {
   if (source === 'mock') return { source };
   // Without an address every page would fail with "fetch failed" and nothing to say why. The
   // first request fails here instead, with the setting to fix in the message
@@ -23,7 +29,14 @@ export function shopConfigOf(source: 'mock' | 'api', apiUrl: string | undefined)
   if (url.protocol !== 'http:' && url.protocol !== 'https:') {
     throw new Error(`SHOP_API_URL must start with http:// or https://, not ${url.protocol}`);
   }
+  // Step 27a: without the key the shop would show its products and then fail at Confirm Order,
+  // after the shopper filled in the whole form. The first request fails here instead. Only its
+  // presence is checked: the API alone knows the right value, and says so with a 401
+  // (shop-api.ts names the setting in that error too)
+  if (apiKey === undefined || apiKey === '') {
+    throw new Error('SHOP_SOURCE=api needs SHOP_API_KEY (the API’s STOREFRONT_SHOP_KEY)');
+  }
   // A path is kept ("https://erp.example.com/api" behind a proxy); the "/" at its end is dropped,
   // so a route's "/public/v1/…" never makes "//"
-  return { source, apiUrl: url.href.replace(/\/+$/, '') };
+  return { source, apiUrl: url.href.replace(/\/+$/, ''), apiKey };
 }
```

- The `api` variant of `ShopConfig` now carries `apiKey`, so code that has an `api` config always has a key. The type
  makes it impossible to build the API source without one.
- The key is checked for presence only. The shop cannot know the right value: the API answers a wrong one with 401
  `storefront_shop_key_invalid`, and `shop-api.ts` below turns that into an error that names both settings.
- With `SHOP_SOURCE=mock` the key is ignored, like the address, so a key left over in a `.env` does not switch the
  source.

```diff
@@ -1,10 +1,9 @@
-import { SHOP_API_URL, SHOP_SOURCE } from 'astro:env/server';
+import { SHOP_API_KEY, SHOP_API_URL, SHOP_SOURCE } from 'astro:env/server';
 
 import { createAnswerCache } from './api/answer-cache';
 import { createApiSource } from './api/api-source';
 import { createShopApi } from './api/shop-api';
 import { shopConfigOf } from './config';
-import { createOrderBook, type MockOrderBook } from './mock/orders';
 import { mockSource } from './mock/mock-source';
 import type { ShopSource } from './types';
 
@@ -14,27 +13,16 @@ import type { ShopSource } from './types';
 // names, so src/middleware.ts asks sourceFor() once per request and puts the answer in
 // Astro.locals.source, which every page and route reads.
 
-// Read once, when the server starts. astro:env reads both at run time ("secret" in
+// Read once, when the server starts. astro:env reads them at run time ("secret" in
 // astro.config.ts), so one built image serves the mock or the API by its environment
-const config = shopConfigOf(SHOP_SOURCE, SHOP_API_URL);
+const config = shopConfigOf(SHOP_SOURCE, SHOP_API_URL, SHOP_API_KEY);
 
 // One cache for the whole server, every shop's answers in it, keyed by host (decision 24):
 // 30 seconds, so a price changed in the ERP shows within half a minute, and at most 1,000 answers
 const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 1_000 });
 
-// 26f.5's decision b: each shop's orders in its own book, so one shop's W-000001 is never another
-// shop's. Made at the first order, and only for a launched shop: the middleware stops every other
-// host before a page runs. They live as long as the process, as the mock's do
-const books = new Map<string, MockOrderBook>();
-
-function bookFor(host: string): MockOrderBook {
-  let book = books.get(host);
-  if (book === undefined) {
-    book = createOrderBook();
-    books.set(host, book);
-  }
-  return book;
-}
+// Step 27a: no mock order books here any more (26f.5's decision b kept one per host). The API keeps
+// every shop's orders in its own tables, numbered per shop
 
 export function sourceFor(url: URL): ShopSource {
   if (config.source === 'mock') return mockSource;
@@ -42,7 +30,5 @@ export function sourceFor(url: URL): ShopSource {
   // "acme.localhost" are one shop. URL has made it lower case already. Behind the proxy this is the
   // shopper's host, not the proxy's (security.allowedDomains in astro.config.ts)
   const host = url.hostname;
-  return createApiSource(createShopApi({ apiUrl: config.apiUrl, host, cache }), () =>
-    bookFor(host),
-  );
+  return createApiSource(createShopApi({ apiUrl: config.apiUrl, key: config.apiKey, host, cache }));
 }
```

The per-host mock order books of 26f.5 are gone. `createApiSource()` takes only the `ShopApi` now, and the key goes
into `createShopApi()`. The cache is unchanged: order routes are POSTs, which are never cached.

```diff
@@ -39,11 +39,13 @@ SHOP_BASE_DOMAIN=localhost
 # SHOP_API_KEY must have the same value. Left out, the API takes no orders (every order route
 # answers 401). At least 32 characters; make a real one with: openssl rand -base64 32
 STOREFRONT_SHOP_KEY=dev-only-shop-key-change-me-0123456789abcdef
-# Step 26f.5: the shop's server (apps/shop) reads these two, not the API. Left out, it shows the
-# mock shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
-# pnpm --filter @omnivo/shop dev, then open http://<subdomain>.localhost:4321
+# Step 26f.5: the shop's server (apps/shop) reads these, not the API. Left out, it shows the mock
+# shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
+# SHOP_API_KEY=<STOREFRONT_SHOP_KEY above> pnpm --filter @omnivo/shop dev, then open
+# http://<subdomain>.localhost:4321. Step 27a: SHOP_API_KEY is required with SHOP_SOURCE=api
 # SHOP_SOURCE=api
 # SHOP_API_URL=http://localhost:3000
+# SHOP_API_KEY=dev-only-shop-key-change-me-0123456789abcdef
 
 # Email — only the worker sends it (invitations, welcome). Dev: docker-compose's Mailpit; every
 # email lands at http://localhost:8025
```

The example names the dev key that 27a.3 put into `STOREFRONT_SHOP_KEY`, so the two match when someone uncomments the
three lines.

```diff
@@ -344,8 +344,9 @@ async function seed(): Promise<void> {
 
   console.log(
     `\nSign in to the ERP: workspace ${SLUG}, ${OWNER.email}, password ${OWNER.password}\n` +
-      `See the shop from this API (the shop's dev server reads the mock unless told otherwise):\n` +
-      `  SHOP_SOURCE=api SHOP_API_URL=${API_URL} pnpm --filter @omnivo/shop dev\n` +
+      `See the shop from this API (the shop's dev server reads the mock unless told otherwise).\n` +
+      `SHOP_API_KEY is the API's STOREFRONT_SHOP_KEY (.env.example has the dev one):\n` +
+      `  SHOP_SOURCE=api SHOP_API_URL=${API_URL} SHOP_API_KEY=… pnpm --filter @omnivo/shop dev\n` +
       `  then open ${launched.shopUrl}`,
   );
 }
```

```diff
@@ -216,8 +216,9 @@ services:
   # prices and orders are made up, and an order lives in this container's memory only, so a restart
   # forgets it. Since 26g a workspace can launch a real shop, but it lives at
   # <subdomain>.<SHOP_BASE_DOMAIN>, and staging has one fixed SHOP_HOST. Switching to the API needs a
-  # wildcard host (DNS, the tunnel and Caddy) first, then SHOP_SOURCE=api, SHOP_API_URL and the API's
-  # SHOP_BASE_DOMAIN. It needs nothing else in the stack. `web` does not wait for it either:
+  # wildcard host (DNS, the tunnel and Caddy) first, then SHOP_SOURCE=api, SHOP_API_URL, SHOP_API_KEY
+  # and the API's SHOP_BASE_DOMAIN and STOREFRONT_SHOP_KEY (the same value as SHOP_API_KEY; step
+  # 27a). It needs nothing else in the stack. `web` does not wait for it either:
   # if the shop fails, the ERP app keeps working and only the shop's address answers 502.
   shop:
     image: ${REGISTRY}/omnivo-shop:${IMAGE_TAG}
```

The seed script's last message and the staging compose file's comment now name the key too. Staging still shows the
mock shop (26g.8), so nothing changes there yet; the comment lists everything the switch to the API will need.

### The source's types

```diff
@@ -1,16 +1,17 @@
 import type {
+  PublicOrderPlaced,
   PublicShop,
   ShopCartQuote,
   ShopCartQuoteRequest,
   ShopCategory,
   ShopCheckoutSettings,
   ShopCodeResent,
+  ShopCodeWait,
   ShopHome,
   ShopListingPage,
   ShopListingQuery,
   ShopOrder,
   ShopOrderConfirmed,
-  ShopOrderPlaced,
   ShopOrderRequest,
   ShopProductPage,
   ShopTextPage,
@@ -30,28 +31,30 @@ export type ShopRefusalCode =
   | 'shop_code_wrong'
   | 'shop_code_too_many'
   | 'shop_code_resend_wait'
-  | 'shop_code_no_order';
+  | 'shop_code_no_order'
+  // Step 27a: the API's own limits (27a's decision 17)
+  | 'shop_order_limit'
+  | 'shop_code_expired'
+  | 'shop_code_sends_used';
+
+// Step 27a: the /track form's refusals. Their own list, not ShopRefusalCode: the form is a page,
+// not one of the order routes, and draws them itself (server/track.ts), so they need no status in
+// server/orders.ts
+export type ShopTrackRefusal = 'shop_track_not_found' | 'shop_track_too_many';
 
 // What a source answers when it may say no. A refusal is a normal answer (a wrong code, a price
 // that changed), not an exception: `throw` stays for a source that is down, which the routes turn
-// into internal_error. `params` go into the error's words ("2 tries left", "Orders start at ৳300")
-export type SourceResult<T> =
-  | { ok: true; value: T }
-  | { ok: false; code: ShopRefusalCode; params?: Record<string, string | number> };
-
-// A placed order and its secret token. The token never reaches the browser's scripts: the route
-// puts it in an httpOnly cookie (decision 4), and only `answer` goes into the body
-export interface PlacedOrder {
-  answer: ShopOrderPlaced;
-  orderNo: string;
-  token: string;
-}
+// into internal_error. `params` go into the error's words ("2 tries left", "Orders start at ৳300").
+// Step 27a: `C` is the list of refusals the method may give; the order routes' list by default
+export type SourceResult<T, C extends string = ShopRefusalCode> =
+  { ok: true; value: T } | { ok: false; code: C; params?: Record<string, string | number> };
 
-// What /checkout/verify draws for the order that waits: the same as the `verify` answer, plus the
-// listings it holds. Step 26c.5: a right code takes them out of this browser's cart (decision 23),
-// and the page cannot know them otherwise: the order is on the server, and the cart may have
-// changed in another tab since Confirm Order
-export type ShopCodeWait = Extract<ShopOrderPlaced, { next: 'verify' }> & { listingIds: string[] };
+// A placed order is the API's answer as it is (27a.1's PublicOrderPlaced): what the shopper is told
+// (`answer`) and the order's secret token. The token never reaches the browser's scripts: the route
+// puts it in an httpOnly cookie (decision 4), and only `answer` goes into the body. Step 27a: there
+// is no order number next to them any more. An order that waits for its code has none yet (27a's
+// decision 20); one confirmed at once has it in `answer`
+export type PlacedOrder = PublicOrderPlaced;
 
 // Step 26e: an order a test shop starts with, and how to track it. The verify page shows a test
 // shop's code (testCode); the /track page shows these, because a test shop sends no SMS with the
@@ -83,9 +86,12 @@ export interface ShopSource {
 
   // Step 26c: the checkout. The routes check every request with its schema first, as for quote()
   checkoutSettings(): Promise<ShopCheckoutSettings>;
-  placeOrder(request: ShopOrderRequest): Promise<SourceResult<PlacedOrder>>;
+  // Step 27a: `address` is the shopper's own (Astro's clientAddress). The API counts the orders
+  // from one connection with it (SHOP_ORDERS_PER_ADDRESS); the mock has no such limit
+  placeOrder(request: ShopOrderRequest, address: string): Promise<SourceResult<PlacedOrder>>;
   // The order that waits for its phone code, found by the token from the cookie. null: none
-  // waits (never placed, confirmed already, dropped, or past its hour)
+  // waits (never placed, confirmed already, dropped, or past its hour). Step 27a: the type is the
+  // API's answer (shopCodeWaitSchema), so the verify page draws exactly what the API sends
   codeWait(token: string): Promise<ShopCodeWait | null>;
   verifyCode(token: string, code: string): Promise<SourceResult<ShopOrderConfirmed>>;
   resendCode(token: string): Promise<SourceResult<ShopCodeResent>>;
@@ -96,14 +102,19 @@ export interface ShopSource {
   // shop: its code goes only to the phone
   readonly testCode: string | null;
 
-  // Step 26e: tracking. Both answer null for "no such order", never an error: a mistyped number and
-  // an old link are normal traffic, like an unknown slug in product().
-  // The order a tracking link names. The page checks the token's shape first
-  // (shopTrackingTokenSchema), so a source never sees a cut or edited link
+  // Step 26e: tracking. The order a tracking link names, or null for "no such order", never an
+  // error: an old link is normal traffic, like an unknown slug in product(). The page checks the
+  // token's shape first (shopTrackingTokenSchema), so a source never sees a cut or edited link
   tracking(token: string): Promise<ShopTracking | null>;
   // The /track form: the order with this number, only when it was placed with this phone. Both come
-  // from shopTrackRequestSchema, so the phone is 01XXXXXXXXX and the number W-000123
-  track(request: ShopTrackRequest): Promise<ShopTracking | null>;
+  // from shopTrackRequestSchema, so the phone is 01XXXXXXXXX and the number W-000123.
+  // Step 27a: a refusal, not null, because there are two: no such pair, and too many misses from
+  // this `address` (the shopper's, as for placeOrder). The limit moved into the source: the API
+  // keeps it in Redis, next to the orders, and the mock in its own memory (mock/rate-limit.ts)
+  track(
+    request: ShopTrackRequest,
+    address: string,
+  ): Promise<SourceResult<ShopTracking, ShopTrackRefusal>>;
   // A footer page. null: the shop has not written it, and the page answers 404
   textPage(slug: ShopTextPageSlug): Promise<ShopTextPage | null>;
   // A test shop's demo orders (ShopTestTracking); null for a real shop
```

- `ShopRefusalCode` gets the API's three new refusals (decision 17). `server/orders.ts` gives each refusal its HTTP
  status in a `satisfies Record<ShopRefusalCode, …>`, so adding them here fails the type check there until they have
  one.
- `ShopTrackRefusal` is its own list. The `/track` form is a page, not one of the order routes, and draws its two
  refusals itself, so putting them in `ShopRefusalCode` would force made-up statuses into `server/orders.ts`.
- `SourceResult` gets a second type parameter for the refusal list. The default keeps every existing use as it was.
- `PlacedOrder` is now the API's `PublicOrderPlaced`. The old `orderNo` beside the answer is gone: a Cash on Delivery
  order has no number until its code is right (decision 20), and an order confirmed at once has it in `answer`.
- `ShopCodeWait` comes from the contracts (decision 18), so the verify page draws exactly what the API sends.
- `track()` answers a `SourceResult`, not `ShopTracking | null`. There are two "no" answers now (no such pair, too
  many misses), and only the source knows the second.

### Calling the order routes

```diff
@@ -4,7 +4,9 @@ import {
   isErrorCode,
   problemSchema,
   type RouteDef,
+  SHOP_CLIENT_ADDRESS_HEADER,
   SHOP_HOST_HEADER,
+  SHOP_KEY_HEADER,
 } from '@omnivo/contracts';
 import type { z } from 'zod';
 
@@ -38,9 +40,16 @@ export class ShopMissingError extends Error {
 
 // What a route may answer: its value, or a refusal the caller decides about ("no such product"
 // is a normal answer for product(), a mistake for shop()). `code` is null for a code this shop
-// does not know, from an API newer than the shop
+// does not know, from an API newer than the shop. Step 27a: `params` are the problem's own
+// ("triesLeft", "seconds", "minutes"), for the words the shopper reads; {} when it has none
 export type ShopApiResult<T> =
-  { ok: true; value: T } | { ok: false; status: number; code: ErrorCode | null };
+  | { ok: true; value: T }
+  | {
+      ok: false;
+      status: number;
+      code: ErrorCode | null;
+      params: Record<string, string | number>;
+    };
 
 // The query as the API reads it: every value a string, the ones not set left out
 type Query = Record<string, string | undefined>;
@@ -50,9 +59,12 @@ export interface ShopApi {
     route: RouteDef & { method: 'GET'; response: S },
     input?: { params?: Record<string, string>; query?: Query },
   ): Promise<ShopApiResult<z.output<S>>>;
+  // Step 27a: `clientAddress` is the shopper's address, for the routes that count a shopper
+  // (placeOrder, track). It is sent only on a route with auth 'shop', next to the key
   post<S extends z.ZodType, B extends z.ZodType>(
     route: RouteDef & { method: 'POST'; response: S; body: B },
     body: z.input<B>,
+    options?: { clientAddress?: string },
   ): Promise<ShopApiResult<z.output<S>>>;
 }
 
@@ -60,6 +72,8 @@ export interface ShopApiOptions {
   apiUrl: string;
   // The shop's host, as the shopper's browser asked for it (acme.omnivosoft.com)
   host: string;
+  // Step 27a: SHOP_API_KEY, sent on the order routes only (auth: 'shop')
+  key: string;
   cache: AnswerCache;
   // How long a page waits for the API. Long enough for a slow query, short enough that a shopper
   // sees an error page instead of a browser that spins forever
@@ -71,14 +85,21 @@ export interface ShopApiOptions {
 export function createShopApi({
   apiUrl,
   host,
+  key,
   cache,
   timeoutMs = 8_000,
   fetch: send = fetch,
 }: ShopApiOptions): ShopApi {
   // One request, read to the end: the status and the JSON body (null when it is not JSON, such as
-  // a proxy's own HTML error page). A network failure or the timeout is a ShopApiError
-  async function ask(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiAnswer> {
-    const headers = new Headers({ accept: 'application/json', [SHOP_HOST_HEADER]: host });
+  // a proxy's own HTML error page). A network failure or the timeout is a ShopApiError.
+  // `extra` are the order routes' own headers (the key and the shopper's address)
+  async function ask(
+    method: 'GET' | 'POST',
+    path: string,
+    body?: unknown,
+    extra: Record<string, string> = {},
+  ): Promise<ApiAnswer> {
+    const headers = new Headers({ accept: 'application/json', [SHOP_HOST_HEADER]: host, ...extra });
     if (body !== undefined) headers.set('content-type', 'application/json');
     let response: Response;
     try {
@@ -119,13 +140,32 @@ export function createShopApi({
       );
     }
     if (problem.data.code === 'storefront_not_found') throw new ShopMissingError(host);
+    // Step 27a: a wrong key is a setup mistake, never a shopper's. The message names both settings,
+    // because the log is the only place anyone reads it: the shopper sees the checkout's "try again"
+    if (problem.data.code === 'storefront_shop_key_invalid') {
+      throw new ShopApiError(
+        answer.status,
+        `${route.method} ${path}: the API refused the shop's key. SHOP_API_KEY must be the API's STOREFRONT_SHOP_KEY`,
+      );
+    }
     return {
       ok: false,
       status: answer.status,
       code: isErrorCode(problem.data.code) ? problem.data.code : null,
+      params: problem.data.params ?? {},
     };
   }
 
+  // Step 27a: what an order route sends besides the host. Decided by the route's own `auth`, so a
+  // read route never carries the key (it would end up in the read routes' logs and cache for no
+  // reason) and an order route never goes without it
+  function shopHeaders(route: RouteDef, clientAddress: string | undefined): Record<string, string> {
+    if (route.auth !== 'shop') return {};
+    const headers: Record<string, string> = { [SHOP_KEY_HEADER]: key };
+    if (clientAddress !== undefined) headers[SHOP_CLIENT_ADDRESS_HEADER] = clientAddress;
+    return headers;
+  }
+
   return {
     async get(route, input = {}) {
       const search = new URLSearchParams();
@@ -138,10 +178,11 @@ export function createShopApi({
       const answer = await cache.read(`${host} ${path}`, () => ask('GET', path));
       return readAnswer(route, path, answer);
     },
-    async post(route, body) {
-      // Never kept: a POST asks about one cart, and its answer is today's prices
+    async post(route, body, options = {}) {
+      // Never kept: a POST asks about one cart or one order, and its answer is for now only
       const path = buildPath(route.path);
-      return readAnswer(route, path, await ask('POST', path, body));
+      const headers = shopHeaders(route, options.clientAddress);
+      return readAnswer(route, path, await ask('POST', path, body, headers));
     },
   };
 }
```

- A refusal now carries the problem's `params` (`triesLeft`, `seconds`, `minutes`). The pages put them into their
  words ("2 tries left", "Wait 12 minutes"). `{}` when there are none, so callers never check for `undefined`.
- `shopHeaders()` reads `route.auth`. Only `'shop'` routes get the key and, when the caller gives one, the shopper's
  address. Deciding it from the route means a new order route in the contracts gets the key without anyone
  remembering to add it.
- `storefront_shop_key_invalid` throws a `ShopApiError` that names `SHOP_API_KEY` and `STOREFRONT_SHOP_KEY`. Nobody but
  the person who set up the servers can fix it, and the log is the only place they look; the shopper sees the
  checkout's "try again".
- `post()` takes the address as an option. `ask()` takes the extra headers, so the host header and the JSON headers
  stay in one place.

```diff
@@ -4,39 +4,50 @@ import {
   type ShopCartQuoteRequest,
 } from '@omnivo/contracts';
 
-import { MOCK_CODE, type MockOrderBook } from '../mock/orders';
-import type { ShopSource } from '../types';
+import type { ShopSource, SourceResult } from '../types';
 import { ShopApiError, type ShopApi, type ShopApiResult } from './shop-api';
 
 // Step 26f.5: the shop's data from the ERP's public API, for the one shop the ShopApi asks for.
-// Browsing and the cart's prices come from the API. Orders, the phone code and tracking have no
-// API until step 27 (decision 1), so they stay in a mock order book, one per shop (26f.5's
-// decision b), priced with the API's quote.
+// Step 27a: everything comes from the API now, orders, the phone code and tracking too. The mock
+// order book is gone from this source: an order placed here is a real one, in the ERP's tables.
+
+function refusedError(result: Extract<ShopApiResult<unknown>, { ok: false }>, what: string) {
+  return new ShopApiError(result.status, `${what} was refused (${result.code ?? 'unknown code'})`);
+}
 
 // A refusal where the page has no use for one: shop() refused is not "no shop" (that is a
 // ShopMissingError already), it is an API that breaks its own contract
 function must<T>(result: ShopApiResult<T>, what: string): T {
   if (result.ok) return result.value;
-  throw new ShopApiError(result.status, `${what} was refused (${result.code ?? 'unknown code'})`);
+  throw refusedError(result, what);
 }
 
-// `orders` is called only when an order is placed or looked up, so a shop nobody orders from never
-// gets a book (data/source.ts keeps one per host)
-export function createApiSource(api: ShopApi, orders: () => MockOrderBook): ShopSource {
-  // Only what the quote asks: the lines, the zone and the coupon. An order request also carries
-  // the shopper's name, phone and address, and those have no reason to reach the API (or its
-  // logs) before step 27 stores orders
-  async function quote(request: ShopCartQuoteRequest) {
-    const body: ShopCartQuoteRequest = { lines: request.lines };
-    if (request.zoneId !== undefined) body.zoneId = request.zoneId;
-    if (request.couponCode !== undefined) body.couponCode = request.couponCode;
-    return must(await api.post(routes.quote, body), 'cart quote');
-  }
+// Step 27a: the API's answer as a source's answer. A refusal in `codes` is one the page knows how to
+// tell the shopper (a wrong code, a changed price); any other is a mistake on one side or the
+// other, so it throws, and the route answers internal_error. `codes` is a list, not "any
+// ShopRefusalCode": verify() has no reason to get shop_order_limit, and a page that got it would
+// show words that do not fit
+function answerOf<T, C extends string>(
+  result: ShopApiResult<T>,
+  codes: readonly C[],
+  what: string,
+): SourceResult<T, C> {
+  if (result.ok) return { ok: true, value: result.value };
+  const code = codes.find((candidate) => candidate === result.code);
+  if (code === undefined) throw refusedError(result, what);
+  // `params` only when there are any, as the mock answers: the routes copy them into the problem
+  return Object.keys(result.params).length === 0
+    ? { ok: false, code }
+    : { ok: false, code, params: result.params };
+}
 
-  async function checkoutSettings() {
-    return must(await api.get(routes.checkoutSettings), 'checkout settings');
-  }
+// The answer, or null for the one refusal that means "no such order" for this route
+function orNull<T>(result: ShopApiResult<T>, notFound: string, what: string): T | null {
+  if (!result.ok && result.code === notFound) return null;
+  return must(result, what);
+}
 
+export function createApiSource(api: ShopApi): ShopSource {
   return {
     shop: async () => must(await api.get(routes.shop), 'shop'),
     categories: async () => must(await api.get(routes.categories), 'categories'),
@@ -51,7 +62,15 @@ export function createApiSource(api: ShopApi, orders: () => MockOrderBook): Shop
       return must(result, 'product');
     },
 
-    quote,
+    // Only what the quote asks: the lines, the zone and the coupon. The checkout's island sends its
+    // whole form to the shop's own route, and the name, phone and address have no reason to reach
+    // the API's quote (or its logs). Only placeOrder sends them, to store them
+    async quote(request: ShopCartQuoteRequest) {
+      const body: ShopCartQuoteRequest = { lines: request.lines };
+      if (request.zoneId !== undefined) body.zoneId = request.zoneId;
+      if (request.couponCode !== undefined) body.couponCode = request.couponCode;
+      return must(await api.post(routes.quote, body), 'cart quote');
+    },
 
     async listings(query) {
       // Only what is set (decision 13), so the first page of /c/all is one cache entry for every
@@ -63,25 +82,59 @@ export function createApiSource(api: ShopApi, orders: () => MockOrderBook): Shop
       return must(result, 'listings');
     },
 
-    checkoutSettings,
+    checkoutSettings: async () => must(await api.get(routes.checkoutSettings), 'checkout settings'),
 
-    // The order is priced again here, by the API, from its own lines, zone and coupon, never from
-    // what the browser says it costs (26c's decision 10). The book only decides whether the order
-    // may be placed with that price, as it does for the mock
-    async placeOrder(request) {
-      const [priced, settings] = await Promise.all([quote(request), checkoutSettings()]);
-      return orders().place(request, priced, settings);
+    // Step 27a: the API prices the order again from its own lines, zone and coupon (26c's decision
+    // 10), holds its stock and sends the code. The shop's server no longer asks for a quote first:
+    // the price that counts is the one the API takes in the same transaction as the hold
+    async placeOrder(request, address) {
+      const result = await api.post(routes.placeOrder, request, { clientAddress: address });
+      return answerOf(
+        result,
+        [
+          'shop_zone_unknown',
+          'shop_payment_unavailable',
+          'shop_order_below_minimum',
+          'shop_order_changed',
+          'shop_order_limit',
+        ],
+        'place order',
+      );
+    },
+    async codeWait(token) {
+      return orNull(await api.post(routes.codeWait, { token }), 'shop_code_no_order', 'code wait');
     },
-    codeWait: (token) => Promise.resolve(orders().codeWait(token)),
-    verifyCode: (token, code) => Promise.resolve(orders().verify(token, code)),
-    resendCode: (token) => Promise.resolve(orders().resend(token)),
-    order: (orderNo, token) => Promise.resolve(orders().find(orderNo, token)),
-    // No SMS is sent before step 27, so the verify page shows the code, as the mock's does. The
-    // orders are not real yet either: nothing reaches the ERP
-    testCode: MOCK_CODE,
+    async verifyCode(token, code) {
+      return answerOf(
+        await api.post(routes.verifyCode, { token, code }),
+        ['shop_code_no_order', 'shop_code_expired', 'shop_code_wrong', 'shop_code_too_many'],
+        'verify code',
+      );
+    },
+    async resendCode(token) {
+      return answerOf(
+        await api.post(routes.resendCode, { token }),
+        ['shop_code_no_order', 'shop_code_sends_used', 'shop_code_resend_wait'],
+        'resend code',
+      );
+    },
+    async order(orderNo, token) {
+      // The number comes from the orders cookie, which the browser can edit. One the API would
+      // refuse with 400 ("abc") cannot be an order of this browser's: the same null as a wrong one,
+      // as product() does for a slug, and the page answers 404
+      if (!routes.order.body.shape.orderNo.safeParse(orderNo).success) return null;
+      return orNull(await api.post(routes.order, { orderNo, token }), 'not_found', 'order');
+    },
+    // A real shop's code goes only to the phone, by SMS
+    testCode: null,
 
-    tracking: (token) => Promise.resolve(orders().trackByLink(token)),
-    track: (request) => Promise.resolve(orders().track(request)),
+    async tracking(token) {
+      return orNull(await api.post(routes.tracking, { token }), 'not_found', 'tracking');
+    },
+    async track(request, address) {
+      const result = await api.post(routes.track, request, { clientAddress: address });
+      return answerOf(result, ['shop_track_not_found', 'shop_track_too_many'], 'track');
+    },
     async textPage(slug) {
       const result = await api.get(routes.textPage, { params: { slug } });
       if (!result.ok && result.code === 'not_found') return null;
```

- `answerOf()` turns the API's answer into a source's answer. It takes the list of refusals this method may give, so
  `verifyCode()` cannot hand the verify page `shop_order_limit`, which has no words there. Anything outside the list
  throws, and the route answers `internal_error`, as for an API that is down. `params` are passed on only when there
  are any, the same shape the mock answers, so the routes and their tests treat both sources alike.
- `orNull()` is for the routes where one refusal means "no such order": `code-wait` (`shop_code_no_order`), `find` and
  `tracking` (`not_found`). The pages already treat `null` as "nothing here".
- `placeOrder()` sends the whole request to the API, with the address. It no longer asks for a quote first: the API
  prices the order inside the same transaction that holds the stock, and that is the price that counts. `quote()`
  still sends only the lines, the zone and the coupon.
- `order()` checks the number with the route's own schema before asking. The number comes from a cookie, which the
  browser can edit; `abc` would get a 400 from the API, and the page would show a 500 instead of its 404.
- `testCode` is `null`: a real shop's code goes only to the phone.

### The cookies

```diff
@@ -1,3 +1,5 @@
+import { shopOrderTokenSchema } from '@omnivo/contracts';
+
 // Step 26c: the shop's two cookies. Both hold secret tokens and nothing else: no name, no phone, no
 // cart. Both are httpOnly, so no script on the page can read them (an injected script could not
 // steal an order), SameSite=Lax, so another site's form or script never sends them, and Secure in
@@ -16,13 +18,17 @@ const CHECKOUT_MAX_AGE = 60 * 60;
 // Long enough to come back to "View Order Details" from the SMS a few days later. After that, the
 // shopper uses /track with the phone and the number (26d)
 const ORDERS_MAX_AGE = 30 * 24 * 60 * 60;
-// About 2 KB with today's tokens, well under the 4 KB a browser keeps for one cookie. The oldest
-// order is forgotten first
+// About 640 bytes with 22-character tokens, well under the 4 KB a browser keeps for one cookie.
+// The oldest order is forgotten first
 const ORDERS_KEPT = 20;
 
-// A token is what a source made (64 hex digits in the mock). The pattern is looser, for the real
-// API's tokens, but it still refuses anything that could break the cookie: ; , = and spaces
-const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
+// Step 27a: a token has one shape for both sources, the API's (shopOrderTokenSchema: 22 base64url
+// characters; the mock makes the same). 26c's looser pattern (32 to 128 characters, for "the real
+// API's tokens" not yet known) refused the API's 22: every checkout would have lost its cookie.
+// The shape also keeps out anything that could break the cookie: ; , = and spaces
+function isToken(value: string): boolean {
+  return shopOrderTokenSchema.safeParse(value).success;
+}
 const ORDER_NO = /^[A-Za-z0-9-]{1,32}$/;
 
 export interface CookieOptions {
@@ -52,7 +58,7 @@ export function readCookie(request: Request, name: string): string | null {
 // is never passed on to the source)
 export function checkoutToken(request: Request): string | null {
   const value = readCookie(request, CHECKOUT_COOKIE);
-  return value !== null && TOKEN.test(value) ? value : null;
+  return value !== null && isToken(value) ? value : null;
 }
 
 export function checkoutCookie(token: string, options: CookieOptions): string {
@@ -72,7 +78,7 @@ export function orderTokens(request: Request): Map<string, string> {
     const at = pair.indexOf(':');
     const orderNo = pair.slice(0, at);
     const token = pair.slice(at + 1);
-    if (at > 0 && ORDER_NO.test(orderNo) && TOKEN.test(token)) tokens.set(orderNo, token);
+    if (at > 0 && ORDER_NO.test(orderNo) && isToken(token)) tokens.set(orderNo, token);
   }
   return tokens;
 }
```

Decision 38. `isToken()` uses the contracts' schema, so the cookie, the API's body schema and the mock all agree on
one shape. A cookie in the old shape (64 hex digits, from a browser that ordered before this change) is treated like
no cookie: the verify page sends the shopper back to the checkout, where the cart still is. Twenty orders now take
about 640 bytes of the orders cookie, not 2 KB.

### The mock

```diff
@@ -1,10 +1,15 @@
 import {
   compareMoney,
+  maskPhone,
   SHOP_CODE_RESEND_SECONDS,
+  SHOP_CODE_SENDS,
   SHOP_CODE_TRIES,
+  SHOP_CODE_VALID_MINUTES,
+  SHOP_ORDER_HOLD_MINUTES,
   type ShopCartQuote,
   type ShopCheckoutSettings,
   type ShopCodeResent,
+  type ShopCodeWait,
   type ShopOrder,
   type ShopOrderConfirmed,
   type ShopOrderLine,
@@ -14,17 +19,23 @@ import {
   type ShopTrackRequest,
 } from '@omnivo/contracts';
 
-import type { PlacedOrder, ShopCodeWait, SourceResult } from '../types';
+import type { PlacedOrder, SourceResult } from '../types';
 
 // Step 26c: the mock's orders, kept in memory (decision 3). Everything here is what step 26's API
 // will do with tables; the shape of the answers is the same, so the pages never change.
+// Step 27a: the API does it now (apps/api/src/storefront/orders/). The mock stays for `pnpm dev`,
+// the Playwright tests and the staging demo, and keeps the API's rules for the phone code, so the
+// pages are tested against the same answers. It has no order limits: a test places many orders
+// from one address, and the API's tests check those limits.
 
 // The code the mock takes. It sends no SMS, so the verify page shows it (ShopSource.testCode)
 export const MOCK_CODE = '123456';
 
 // How long an order waits for its code: the system design's stock hold (60 minutes, §14.4). After
-// that it is dropped, and the checkout cookie with the same life is gone too
-const WAIT_MS = 60 * 60 * 1000;
+// that it is dropped, and the checkout cookie with the same life is gone too. Step 27a: the API's
+// numbers, from the contracts, so the mock and the API cannot drift apart
+const WAIT_MS = SHOP_ORDER_HOLD_MINUTES * 60 * 1000;
+const CODE_MS = SHOP_CODE_VALID_MINUTES * 60 * 1000;
 
 interface MockOrder {
   token: string;
@@ -36,6 +47,10 @@ interface MockOrder {
   wrongCodes: number;
   resendAt: number;
   expiresAt: number;
+  // Step 27a: the API's rules for the code (27a's decision 17): each code works 10 minutes, and an
+  // order gets 3 at most
+  codeExpiresAt: number;
+  codeSends: number;
 }
 
 // Step 26e: an order the mock starts with (demo-orders.ts), so a tracking link and the /track form
@@ -64,17 +79,14 @@ function trackingOf({ order, shipments }: MockOrder): ShopTracking {
   };
 }
 
-// A token nobody can guess: 32 random bytes as 64 hex digits. Web Crypto, not node:crypto, so it
-// runs wherever the shop's server runs (Node today, a worker runtime maybe later)
+// A token nobody can guess. Step 27a: the API's shape (shopOrderTokenSchema): 16 random bytes (128
+// bits) as 22 base64url characters, so the cookies check one shape for both sources. Web Crypto
+// and btoa, not node:crypto or Buffer, so it runs wherever the shop's server runs
 function newToken(): string {
-  const bytes = crypto.getRandomValues(new Uint8Array(32));
-  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
-}
-
-// "01786120356" → "+880 17•• ••• 356". The first two digits say the operator and the last three
-// let the shopper see it is their number; the rest stays off a screenshot
-export function maskPhone(phone: string): string {
-  return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
+  const bytes = crypto.getRandomValues(new Uint8Array(16));
+  const base64 = btoa(String.fromCharCode(...bytes));
+  // base64 → base64url: no "+" or "/" (they would need escaping in a cookie), no "=" padding
+  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 }
 
 // W-000123: W for web, so a shop order is never mistaken for an ERP sales order (decision 3)
@@ -106,6 +118,8 @@ export function createOrderBook(
       wrongCodes: 0,
       resendAt: 0,
       expiresAt: 0,
+      codeExpiresAt: 0,
+      codeSends: 0,
     });
     byTrackingToken.set(trackingToken, key);
   }
@@ -219,16 +233,18 @@ export function createOrderBook(
         // The first code was "sent" just now, so a new one waits the same 45 seconds
         resendAt: placedAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000,
         expiresAt: placedAt.getTime() + WAIT_MS,
+        codeExpiresAt: placedAt.getTime() + CODE_MS,
+        codeSends: 1,
       };
       byToken.set(token, entry);
 
-      // Mobile Banking needs no code in the mock (decision 4): confirmed at once
+      // Mobile Banking needs no code in the mock (decision 4): confirmed at once. Its number is in
+      // the answer; a Cash on Delivery order's is not, as in the API, where it has none yet. (The
+      // mock numbers an order when it is placed, which the shopper never sees: a dropped order
+      // only leaves a gap in a book that is forgotten at the next restart)
       if (request.paymentMethod === 'online') {
         const confirmed = confirm(entry);
-        return {
-          ok: true,
-          value: { answer: { next: 'confirmed', ...confirmed }, orderNo: order.orderNo, token },
-        };
+        return { ok: true, value: { answer: { next: 'confirmed', ...confirmed }, token } };
       }
       return {
         ok: true,
@@ -238,7 +254,6 @@ export function createOrderBook(
             maskedPhone: maskPhone(order.phone),
             resendInSeconds: SHOP_CODE_RESEND_SECONDS,
           },
-          orderNo: order.orderNo,
           token,
         },
       };
@@ -258,6 +273,9 @@ export function createOrderBook(
     verify(token: string, code: string): SourceResult<ShopOrderConfirmed> {
       const entry = waiting(token);
       if (!entry) return { ok: false, code: 'shop_code_no_order' };
+      // Step 27a: a code past its 10 minutes is refused before it is compared, as the API does: it
+      // cannot be right any more, so it costs no try
+      if (entry.codeExpiresAt <= now().getTime()) return { ok: false, code: 'shop_code_expired' };
       if (code === MOCK_CODE) return { ok: true, value: confirm(entry) };
 
       entry.wrongCodes += 1;
@@ -277,11 +295,17 @@ export function createOrderBook(
     resend(token: string): SourceResult<ShopCodeResent> {
       const entry = waiting(token);
       if (!entry) return { ok: false, code: 'shop_code_no_order' };
+      // Step 27a: the third code was the last, before any wait: waiting would not help
+      if (entry.codeSends >= SHOP_CODE_SENDS) return { ok: false, code: 'shop_code_sends_used' };
       const wait = secondsUntil(entry.resendAt);
       // Every SMS costs the shop money, and a page that resends on every click could be used to
       // flood someone's phone. The wait is the server's; the button's countdown only shows it
       if (wait > 0) return { ok: false, code: 'shop_code_resend_wait', params: { seconds: wait } };
       entry.resendAt = now().getTime() + SHOP_CODE_RESEND_SECONDS * 1000;
+      // The new code works its own 10 minutes. The mock's code is always MOCK_CODE, so "the newest
+      // replaces the older one" cannot be seen here; the API's tests check it
+      entry.codeSends += 1;
+      entry.codeExpiresAt = now().getTime() + CODE_MS;
       // The wrong codes are not forgiven: a new SMS must not give a guesser five more tries
       return { ok: true, value: { resendInSeconds: SHOP_CODE_RESEND_SECONDS } };
     },
@@ -319,5 +343,3 @@ export function createOrderBook(
     },
   };
 }
-
-export type MockOrderBook = ReturnType<typeof createOrderBook>;
```

- The hold and the code's life come from the contracts (`SHOP_ORDER_HOLD_MINUTES`, `SHOP_CODE_VALID_MINUTES`), so the
  mock and the API cannot drift apart.
- `newToken()` makes 16 random bytes in base64url: 22 characters, `+` and `/` swapped for `-` and `_`, and no `=`
  padding, because those three would need escaping in a cookie. `btoa` and Web Crypto, not `Buffer`, as before.
- `maskPhone()` is imported from the contracts (27a.1 moved it there).
- `place()` answers `{ answer, token }`. The mock still numbers an order when it is placed; nobody sees the number
  before the code is right, and a dropped order only leaves a gap in a book that is forgotten at the next restart.
- `verify()` refuses an expired code before comparing it, so it costs no try, exactly as the API does.
- `resend()` refuses a fourth code before it looks at the 45-second wait: waiting would not help. Each new code gets
  its own 10 minutes.

Move `apps/shop/src/server/rate-limit.ts` and its spec into the mock (`git mv`, so the history follows):

```bash
git mv apps/shop/src/server/rate-limit.ts apps/shop/src/data/mock/rate-limit.ts
git mv apps/shop/src/server/rate-limit.spec.ts apps/shop/src/data/mock/rate-limit.spec.ts
```

Then the file is the same limiter without `addressKey()`, which 27a.3 moved into the contracts:

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
// a guesser would get `tries` from each; that is fine for one server.
//
// Step 27a: moved from server/ into the mock. The API keeps the real limit in Redis, next to the
// orders (shop-limits.ts), so only the mock source counts misses here (mock-source.ts). The key
// is made by addressKey() from @omnivo/contracts, the same function the API uses.

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
```

```diff
@@ -1,3 +1,5 @@
+import { addressKey, SHOP_TRACK_TRIES, SHOP_TRACK_WINDOW_MINUTES } from '@omnivo/contracts';
+
 import type { ShopSource } from '../types';
 import { listListings, type BrowseContext } from './browse';
 import { mockCheckoutSettings, mockCoupons } from './checkout';
@@ -7,6 +9,7 @@ import { createOrderBook, MOCK_CODE, type MockDemoOrder } from './orders';
 import { mockTextPages } from './pages';
 import { mockCatalog, mockProductPage, mockSkus } from './products';
 import { quoteCart, type QuoteContext } from './quote';
+import { createRateLimiter } from './rate-limit';
 import { mockCategories, mockShop } from './shop';
 
 // Step 26c: everything the mock prices a cart with, at one moment. Exported for the tests, which
@@ -38,6 +41,13 @@ export function createMockSource(
 ): ShopSource {
   const orders = createOrderBook(now, demo);
   const context = () => mockQuoteContext(now());
+  // Step 27a: the /track form's misses, moved here from server/track.ts. The source's own clock, so
+  // a test that moves time moves the window too
+  const trackLimiter = createRateLimiter({
+    tries: SHOP_TRACK_TRIES,
+    windowMs: SHOP_TRACK_WINDOW_MINUTES * 60 * 1000,
+    now: () => now().getTime(),
+  });
 
   // The mock answers at once. Still a promise, so the pages are written for the real source, which
   // waits for the network
@@ -51,7 +61,8 @@ export function createMockSource(
 
     checkoutSettings: () => Promise.resolve(mockCheckoutSettings),
     // The order is priced again here from its own lines, zone and coupon, never from anything the
-    // browser says it costs (decision 10)
+    // browser says it costs (decision 10). The shopper's address is not used: the mock has no order
+    // limits (data/mock/orders.ts)
     placeOrder: (request) =>
       Promise.resolve(orders.place(request, quoteCart(request, context()), mockCheckoutSettings)),
     codeWait: (token) => Promise.resolve(orders.codeWait(token)),
@@ -62,7 +73,26 @@ export function createMockSource(
 
     // Step 26e
     tracking: (token) => Promise.resolve(orders.trackByLink(token)),
-    track: (request) => Promise.resolve(orders.track(request)),
+    // Step 27a: the limit first, as 26e's form did: once it is reached, nothing is looked up, so a
+    // guesser learns nothing more until the window ends, however right the next guess is. Only a
+    // miss counts (26e's decision 3), as in the API
+    track(request, address) {
+      const key = addressKey(address);
+      const wait = trackLimiter.waitFor(key);
+      if (wait > 0) {
+        return Promise.resolve({
+          ok: false,
+          code: 'shop_track_too_many',
+          params: { minutes: Math.ceil(wait / 60) },
+        });
+      }
+      const tracking = orders.track(request);
+      if (tracking === null) {
+        trackLimiter.miss(key);
+        return Promise.resolve({ ok: false, code: 'shop_track_not_found' });
+      }
+      return Promise.resolve({ ok: true, value: tracking });
+    },
     textPage: (slug) => Promise.resolve(mockTextPages[slug] ?? null),
     // What the /track page offers a tester: the demo orders' numbers, phones and links. null
     // without them, so the page does not offer links that lead nowhere
```

The mock source owns the `/track` limiter now (decision 40). It uses the source's own clock, so a test that moves
time moves the limit's window too. The order of the checks is 26e's: the limit first, so a stopped guesser learns
nothing even with the right pair; only a miss counts. The key comes from the contracts' `addressKey()`, the same
function the API uses, so an IPv6 /64 is one shopper in both.

### The routes and the pages

```diff
@@ -18,8 +18,10 @@ import { problemResponse, readBody, sourceFailed, type ProblemStatus } from './p
 // data/types.ts fail the type check here until it has one.
 // - 409: the cart changed under the shopper; asking again with a new quote can work
 // - 422: the request is well formed but breaks a rule (no such zone, under the minimum, wrong code)
-// - 429: asked for a new code too soon; Retry-After says when
+// - 429: asked for a new code too soon, or (step 27a) too many orders; Retry-After says when
 // - 404: no order waits for a code in this browser
+// Step 27a: the API answers the same statuses (shop-orders.service.ts), so a shopper's browser
+// gets the same answer from either source
 const REFUSALS = {
   shop_zone_unknown: [422, 'The delivery zone is not one the shop has.'],
   shop_payment_unavailable: [422, 'The shop does not take this payment method.'],
@@ -29,6 +31,9 @@ const REFUSALS = {
   shop_code_too_many: [422, 'Too many wrong codes; the order was dropped.'],
   shop_code_resend_wait: [429, 'A new code cannot be sent yet.'],
   shop_code_no_order: [404, 'No order waits for a code in this browser.'],
+  shop_order_limit: [429, 'Too many orders from this phone or connection.'],
+  shop_code_expired: [422, 'The code has expired. Ask for a new one.'],
+  shop_code_sends_used: [422, 'This order has had all its codes.'],
 } as const satisfies Record<ShopRefusalCode, readonly [ProblemStatus, string]>;
 
 function refused(
@@ -40,6 +45,9 @@ function refused(
   if (result.code === 'shop_code_resend_wait' && typeof result.params?.seconds === 'number') {
     headers.set('Retry-After', String(result.params.seconds));
   }
+  if (result.code === 'shop_order_limit' && typeof result.params?.minutes === 'number') {
+    headers.set('Retry-After', String(result.params.minutes * 60));
+  }
   return problemResponse(status, result.code, detail, {
     headers,
     ...(result.params ? { params: result.params } : {}),
@@ -53,10 +61,12 @@ function noOrder(options: CookieOptions): Response {
   return refused({ ok: false, code: 'shop_code_no_order' }, headers);
 }
 
-// Confirm Order
+// Confirm Order. Step 27a: `address` is the shopper's (Astro's clientAddress), which the API
+// counts orders under
 export async function answerPlaceOrder(
   request: Request,
   source: ShopSource,
+  address: string,
   options: CookieOptions,
 ): Promise<Response> {
   const body = await readBody(request, shopOrderRequestSchema);
@@ -64,13 +74,13 @@ export async function answerPlaceOrder(
 
   let result;
   try {
-    result = await source.placeOrder(body.data);
+    result = await source.placeOrder(body.data, address);
   } catch (error) {
     return sourceFailed('place order', error);
   }
   if (!result.ok) return refused(result);
 
-  const { answer, orderNo, token } = result.value;
+  const { answer, token } = result.value;
   const headers = new Headers({ 'Cache-Control': 'no-store' });
   if (answer.next === 'verify') {
     // The order waits for its code; /checkout/verify finds it by this cookie
@@ -78,8 +88,9 @@ export async function answerPlaceOrder(
   } else {
     // Confirmed at once (Mobile Banking in the mock): this browser may now open /order/<no>.
     // An older order that was still waiting for its code is forgotten: the shopper chose to start
-    // again, and the verify page must not offer the old one
-    headers.append('Set-Cookie', ordersCookie(request, orderNo, token, options));
+    // again, and the verify page must not offer the old one. Step 27a: the number comes from the
+    // answer, the only place a confirmed order's number is
+    headers.append('Set-Cookie', ordersCookie(request, answer.orderNo, token, options));
     headers.append('Set-Cookie', clearCheckoutCookie(options));
   }
   // 201: an order was made. The body says which page comes next; the token is only in the cookie
```

- The three new refusals get the API's own statuses (429 for the order limit, 422 for the two code rules), so a
  browser gets the same answer from either source.
- `Retry-After` is in seconds, so the order limit's minutes are multiplied by 60.
- `answerPlaceOrder()` takes the address and passes it on. When an order is confirmed at once, the number comes from
  `answer.orderNo`, the only place it is.

```diff
@@ -4,6 +4,7 @@ import { answerPlaceOrder } from '../../../server/orders';
 
 // Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
 // plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
-// exception for localhost, Safari does not)
-export const POST: APIRoute = ({ request, locals }) =>
-  answerPlaceOrder(request, locals.source, { secure: import.meta.env.PROD });
+// exception for localhost, Safari does not). Step 27a: clientAddress is the shopper's address (the
+// proxy's X-Forwarded-For, astro.config.ts → security), for the API's orders-per-connection limit
+export const POST: APIRoute = ({ request, locals, clientAddress }) =>
+  answerPlaceOrder(request, locals.source, clientAddress, { secure: import.meta.env.PROD });
```

`clientAddress` is Astro's: the proxy's `X-Forwarded-For`, which 26e.2 told Astro to trust (`security.allowedDomains`).
The API checks it again (`ShopClient`, 27a.3) and uses its own view of the caller if the header is not one address.

```diff
@@ -1,14 +1,7 @@
-import {
-  SHOP_TRACK_TRIES,
-  SHOP_TRACK_WINDOW_MINUTES,
-  shopTrackRequestSchema,
-  type ErrorCode,
-  type ShopTracking,
-} from '@omnivo/contracts';
+import { shopTrackRequestSchema, type ErrorCode, type ShopTracking } from '@omnivo/contracts';
 
-import type { ShopSource } from '../data/types';
+import type { ShopSource, ShopTrackRefusal, SourceResult } from '../data/types';
 import { fieldErrorsOf, parseOptions } from './problem';
-import { addressKey, createRateLimiter, type RateLimiter } from './rate-limit';
 
 // Step 26e: the /track form's POST, without Astro around it, like orders.ts. The page (26e.3)
 // passes the request, the source, the limiter and the visitor's address, and draws what comes back.
@@ -28,7 +21,7 @@ export type TrackFieldErrors = Partial<Record<keyof TrackFormValues, ErrorCode[]
 
 // The refusals the page writes above the form. Each is an error code, so its words are
 // t('errors.<code>') like any other error
-export type TrackRefusal = 'shop_track_not_found' | 'shop_track_too_many' | 'internal_error';
+export type TrackRefusal = ShopTrackRefusal | 'internal_error';
 
 export type TrackFormAnswer =
   | { kind: 'found'; tracking: ShopTracking }
@@ -41,13 +34,6 @@ export type TrackFormAnswer =
       params?: { minutes: number };
     };
 
-// The one limiter the shop's server uses, made when the module first loads. Its memory lives as
-// long as the process, like the mock's orders
-export const trackLimiter: RateLimiter = createRateLimiter({
-  tries: SHOP_TRACK_TRIES,
-  windowMs: SHOP_TRACK_WINDOW_MINUTES * 60 * 1000,
-});
-
 // A box's value. `get` gives null for a box the form did not send and a File for a file input;
 // both count as empty, so a hand-made request cannot make the page draw a File's name
 function text(form: FormData, name: keyof TrackFormValues): string {
@@ -55,16 +41,17 @@ function text(form: FormData, name: keyof TrackFormValues): string {
   return typeof value === 'string' ? value : '';
 }
 
+// Step 27a: no limiter here any more. The limit is the source's (ShopSource.track): the API's in
+// Redis, or the mock's in memory
 interface TrackFormContext {
   source: ShopSource;
-  limiter: RateLimiter;
   // Astro.clientAddress: the visitor's IP (astro.config.mjs → security says where it comes from)
   address: string;
 }
 
 export async function answerTrackForm(
   request: Request,
-  { source, limiter, address }: TrackFormContext,
+  { source, address }: TrackFormContext,
 ): Promise<TrackFormAnswer> {
   let form: FormData;
   try {
@@ -76,29 +63,18 @@ export async function answerTrackForm(
   }
   const values = { phone: text(form, 'phone'), orderNo: text(form, 'orderNo') };
 
-  // The limit first: once it is reached, nothing is looked up, so a guesser learns nothing more
-  // until the window ends, however right the next guess is
-  const key = addressKey(address);
-  const wait = limiter.waitFor(key);
-  if (wait > 0) {
-    return {
-      kind: 'refused',
-      values,
-      code: 'shop_track_too_many',
-      params: { minutes: Math.ceil(wait / 60) },
-    };
-  }
-
   // A box typed wrong ("0178", "SO-2026") is not a miss: nothing was looked up, so it tells a
-  // guesser nothing and costs no try
+  // guesser nothing and costs no try. Step 27a: this check now comes before the limit, because the
+  // limit is the source's. A stopped guesser who types a broken number is told what to fix, which
+  // tells them nothing about any order
   const parsed = shopTrackRequestSchema.safeParse(values, parseOptions);
   if (!parsed.success) {
     return { kind: 'invalid', values, fieldErrors: fieldErrorsOf(parsed.error) };
   }
 
-  let tracking: ShopTracking | null;
+  let result: SourceResult<ShopTracking, ShopTrackRefusal>;
   try {
-    tracking = await source.track(parsed.data);
+    result = await source.track(parsed.data, address);
   } catch (error) {
     // The real source calls the API, which can be down. Logged with its details, like
     // sourceFailed in problem.ts; the shopper gets "try again", and no try is counted
@@ -106,11 +82,20 @@ export async function answerTrackForm(
     return { kind: 'refused', values, code: 'internal_error' };
   }
 
-  // Only a miss counts (decision 3). A shopper who checks their own order ten times is never
-  // stopped, and many people behind one mobile operator's address share the misses, not the looks
-  if (tracking === null) {
-    limiter.miss(key);
-    return { kind: 'refused', values, code: 'shop_track_not_found' };
+  // Only a miss counts (decision 3), in the source. A shopper who checks their own order ten times
+  // is never stopped, and many people behind one mobile operator's address share the misses, not
+  // the looks
+  if (result.ok) return { kind: 'found', tracking: result.value };
+  if (result.code === 'shop_track_too_many') {
+    // The source says how long; a missing number (an API that broke its word) still reads as "try
+    // again later" rather than "in NaN minutes"
+    const minutes = result.params?.minutes;
+    return {
+      kind: 'refused',
+      values,
+      code: result.code,
+      params: { minutes: typeof minutes === 'number' ? minutes : 1 },
+    };
   }
-  return { kind: 'found', tracking };
+  return { kind: 'refused', values, code: result.code };
 }
```

The form no longer counts misses (decision 40). It checks the boxes, asks the source, and turns the answer into what
the page draws. The box check now runs before the limit, because the limit is the source's. A stopped guesser who types
a broken number is told what to fix, which says nothing about any order. A 429 without `params.minutes` (an API that
broke its word) still reads "try again in 1 minute", never "in NaN minutes".

```diff
@@ -9,7 +9,6 @@ import { shopLocale } from '../lib/locale';
 import { spacedPhone } from '../lib/phone';
 import {
   answerTrackForm,
-  trackLimiter,
   type TrackFieldErrors,
   type TrackFormAnswer,
   type TrackFormValues,
@@ -25,9 +24,8 @@ let answer: TrackFormAnswer | null = null;
 if (Astro.request.method === 'POST') {
   answer = await answerTrackForm(Astro.request, {
     source,
-    limiter: trackLimiter,
     // The visitor's address, which astro.config.ts → security says to read from the proxy's
-    // X-Forwarded-For (26e.2)
+    // X-Forwarded-For (26e.2). Step 27a: the source counts the misses under it (the API in Redis)
     address: Astro.clientAddress,
   });
   // A browser draws the page whatever the status; the status is for scripts and logs, which can
```

```diff
@@ -39,6 +39,9 @@ const words = {
   triesOther: t('shop.verify.triesLeft', { ...count, count: 2 }),
   tooMany: t('errors.shop_code_too_many'),
   noOrder: t('errors.shop_code_no_order'),
+  // Step 27a: the API's two other code rules (27a's decision 17)
+  expired: t('errors.shop_code_expired'),
+  sendsUsed: t('errors.shop_code_sends_used'),
   format: t('errors.shop_code_format'),
   wait: t('errors.shop_code_resend_wait'),
   failed: t('shop.verify.failed'),
@@ -159,7 +162,8 @@ const textLink =
             role="status"
             class="text-center text-sf-small text-muted empty:hidden"
           ></p>
-          {/* After five wrong codes or a dropped order: the only way on is a new order */}
+          {/* After five wrong codes or a dropped order: the only way on is a new order. Step 27a:
+              also after the third code, next to the box (the last code may still work) */}
           <a
             data-start-again
             href="/checkout"
@@ -196,6 +200,8 @@ const textLink =
     'triesOther',
     'tooMany',
     'noOrder',
+    'expired',
+    'sendsUsed',
     'format',
     'wait',
     'failed',
@@ -389,6 +395,12 @@ const textLink =
         case 'shop_code_no_order':
           this.end(this.word('noOrder'));
           return;
+        // Step 27a: no try was spent. The digits go, and "Resend code" below is the way on
+        case 'shop_code_expired':
+          this.showError(this.word('expired'));
+          this.input.value = '';
+          this.input.focus();
+          return;
         // The route's own check (400) says the same as the page's check above
         case 'invalid_input':
           this.showError(this.word('format'));
@@ -422,6 +434,8 @@ const textLink =
       const problem = problemParts(body);
       if (problem?.code === 'shop_code_no_order') {
         this.end(this.word('noOrder'));
+      } else if (problem?.code === 'shop_code_sends_used') {
+        this.sendsUsed();
       } else if (problem?.code === 'shop_code_resend_wait' && seconds !== null) {
         // Another tab asked a moment ago: the server's wait is the one that counts
         this.say(this.word('wait'));
@@ -431,6 +445,17 @@ const textLink =
       }
     }
 
+    // Step 27a: the order has had its three codes. Not end(): the last code may still be on its way
+    // or still work for a few minutes, so the box and Confirm Order stay. "Resend code" goes, and
+    // the way back to the checkout shows under them, for a shopper whose phone never gets the SMS
+    private sendsUsed(): void {
+      window.clearInterval(this.timer);
+      part<HTMLElement>(this, '[data-resend-row]').hidden = true;
+      this.say('');
+      this.showError(this.word('sendsUsed'));
+      part<HTMLElement>(this, '[data-start-again]').hidden = false;
+    }
+
     private waiting(): boolean {
       return Date.now() < this.resendAt;
     }
```

- `expired` and `sendsUsed` are two more words in the page's word list. `WORD_KEYS` reads every word when the page
  opens, so a missing one fails at once, not when a shopper first meets it.
- An expired code clears the box and keeps the focus there, like a wrong one. No try was spent, and "Resend code" is
  right below.
- `sendsUsed()` is decision 41. It stops the countdown, hides the resend row, shows the error and the way back to the
  checkout, and leaves the box and Confirm Order as they are. It is not `end()`, which hides the box: the third code
  may still work.

```diff
@@ -15,6 +15,7 @@ import type { ShopLocale } from '../../lib/locale';
 // name the word's own placeholders
 const NAME = { name: '{{name}}' };
 const MINIMUM = { minimum: '{{minimum}}' };
+const MINUTES = { minutes: '{{minutes}}' };
 
 export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSettings) {
   return {
@@ -64,7 +65,7 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
     removedOne: t('shop.cart.removed', { count: 1, replace: { count: '{{count}}' } }),
     removedOther: t('shop.cart.removed', { count: 2, replace: { count: '{{count}}' } }),
     // The error codes the checkout can show: the form's own checks, the order route's refusals
-    // and the promo box. 18 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
+    // and the promo box. 19 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
     // a real error code, so a typo is a type error, not a missing sentence
     errors: {
       required: t('errors.required'),
@@ -81,6 +82,8 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
       shop_cart_empty: t('errors.shop_cart_empty'),
       shop_order_below_minimum: t('errors.shop_order_below_minimum', MINIMUM),
       shop_order_changed: t('errors.shop_order_changed'),
+      // Step 27a: the API's orders-per-hour limit, with the minutes to wait
+      shop_order_limit: t('errors.shop_order_limit', MINUTES),
       shop_coupon_format: t('errors.shop_coupon_format'),
       shop_coupon_unknown: t('errors.shop_coupon_unknown'),
       shop_coupon_expired: t('errors.shop_coupon_expired'),
```

```diff
@@ -14,6 +14,7 @@ import {
   type ShopPaymentMethod,
 } from '@omnivo/contracts';
 import type { Language } from '@omnivo/i18n';
+import { formatNumber } from '@omnivo/i18n/format';
 import { useMemo, useState } from 'react';
 import { useForm, useWatch } from 'react-hook-form';
 
@@ -184,11 +185,14 @@ export default function CheckoutForm({
       refresh();
     }
     const minimum = problem.params?.minimum;
+    // Step 27a: shop_order_limit's wait, in the shop's digits ("১২ মিনিট" in Bangla)
+    const minutes = problem.params?.minutes;
     setSubmitError(
       general === null
         ? null
         : errorText(words, general, {
             minimum: minimum === undefined ? '' : money(String(minimum)),
+            minutes: typeof minutes === 'number' ? formatNumber(minutes, language) : '',
           }),
     );
   }
```

The order limit's words keep `{{minutes}}` as a placeholder, like the minimum's `{{minimum}}`, and the island fills it
from the problem's `params`. `formatNumber()` comes from `@omnivo/i18n/format`, which the island already loads for
money, so a Bangla shop says "১২" and the island does not load i18next.

### Tests

```diff
@@ -2,33 +2,42 @@ import { describe, expect, it } from 'vitest';
 
 import { shopConfigOf } from './config';
 
+const KEY = 'dev-only-shop-key-change-me-0123456789abcdef';
+
 describe('shopConfigOf', () => {
   it('uses the mock without asking for an address', () => {
-    expect(shopConfigOf('mock', undefined)).toEqual({ source: 'mock' });
-    // An address left over from another setup does not switch the source
-    expect(shopConfigOf('mock', 'http://api:3000')).toEqual({ source: 'mock' });
+    expect(shopConfigOf('mock', undefined, undefined)).toEqual({ source: 'mock' });
+    // An address and a key left over from another setup do not switch the source
+    expect(shopConfigOf('mock', 'http://api:3000', KEY)).toEqual({ source: 'mock' });
   });
 
   it('needs the API’s address for the API', () => {
-    expect(() => shopConfigOf('api', undefined)).toThrow(/SHOP_API_URL/);
+    expect(() => shopConfigOf('api', undefined, KEY)).toThrow(/SHOP_API_URL/);
     // An empty value in a compose file ("SHOP_API_URL=") is no address either
-    expect(() => shopConfigOf('api', '')).toThrow(/SHOP_API_URL/);
+    expect(() => shopConfigOf('api', '', KEY)).toThrow(/SHOP_API_URL/);
+  });
+
+  it('needs the shop’s key for the API', () => {
+    expect(() => shopConfigOf('api', 'http://api:3000', undefined)).toThrow(/SHOP_API_KEY/);
+    expect(() => shopConfigOf('api', 'http://api:3000', '')).toThrow(/SHOP_API_KEY/);
   });
 
   it('takes http and https, and drops the "/" at the end', () => {
-    expect(shopConfigOf('api', 'http://api:3000/')).toEqual({
+    expect(shopConfigOf('api', 'http://api:3000/', KEY)).toEqual({
       source: 'api',
       apiUrl: 'http://api:3000',
+      apiKey: KEY,
     });
-    expect(shopConfigOf('api', 'https://erp.example.com/api/')).toEqual({
+    expect(shopConfigOf('api', 'https://erp.example.com/api/', KEY)).toEqual({
       source: 'api',
       apiUrl: 'https://erp.example.com/api',
+      apiKey: KEY,
     });
   });
 
   it('refuses what is not an http address', () => {
     // "api:3000" is a valid URL with the scheme "api:", so only the scheme check catches it
-    expect(() => shopConfigOf('api', 'api:3000')).toThrow(/http:\/\/ or https:\/\//);
-    expect(() => shopConfigOf('api', 'not an address')).toThrow(/not an address/);
+    expect(() => shopConfigOf('api', 'api:3000', KEY)).toThrow(/http:\/\/ or https:\/\//);
+    expect(() => shopConfigOf('api', 'not an address', KEY)).toThrow(/not an address/);
   });
 });
```

```diff
@@ -1,9 +1,14 @@
-import { shopOrderSchema, type ShopOrderRequest, SHOP_CODE_TRIES } from '@omnivo/contracts';
+import {
+  SHOP_CODE_TRIES,
+  shopOrderSchema,
+  shopOrderTokenSchema,
+  type ShopOrderRequest,
+} from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import type { ShopSource } from '../types';
+import type { PlacedOrder, ShopSource } from '../types';
 import { createMockSource } from './mock-source';
-import { maskPhone, MOCK_CODE } from './orders';
+import { MOCK_CODE } from './orders';
 
 const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
 const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock
@@ -21,6 +26,9 @@ const ORDER: ShopOrderRequest = {
   expectedTotal: '767',
 };
 
+// The shopper's address. The mock has no order limits, so any address does
+const ADDRESS = '203.0.113.7';
+
 // A source whose clock the test moves
 function withClock() {
   let now = new Date('2026-11-11T10:00:00+06:00');
@@ -35,16 +43,18 @@ function withClock() {
 }
 
 async function placed(source: ShopSource, request: ShopOrderRequest = ORDER) {
-  const result = await source.placeOrder(request);
+  const result = await source.placeOrder(request, ADDRESS);
   if (!result.ok) throw new Error(`refused: ${result.code}`);
   return result.value;
 }
 
-describe('the mock’s orders', () => {
-  it('hides the middle of the phone', () => {
-    expect(maskPhone('01786120356')).toBe('+880 17•• ••• 356');
-  });
+// Step 27a: a confirmed order's number is only in its answer
+function numberOf({ answer }: PlacedOrder): string {
+  if (answer.next !== 'confirmed') throw new Error('The order waits for its code');
+  return answer.orderNo;
+}
 
+describe('the mock’s orders', () => {
   it('asks Cash on Delivery for the phone code', async () => {
     const { source } = withClock();
     const order = await placed(source);
@@ -53,15 +63,16 @@ describe('the mock’s orders', () => {
       maskedPhone: '+880 17•• ••• 356',
       resendInSeconds: 45,
     });
-    expect(order.orderNo).toBe('W-000001');
-    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
+    // Step 27a: the API's token shape, so one cookie check serves both sources
+    expect(shopOrderTokenSchema.safeParse(order.token).success).toBe(true);
     // Not an order yet: /order/<no> does not show it, even with the right token
-    expect(await source.order(order.orderNo, order.token)).toBeNull();
+    expect(await source.order('W-000001', order.token)).toBeNull();
   });
 
   it('confirms a right code, and the order then shows with its token only', async () => {
     const { source } = withClock();
-    const { orderNo, token } = await placed(source);
+    const { token } = await placed(source);
+    const orderNo = 'W-000001';
     expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
       ok: true,
       value: { orderNo, phone: '01786120356' },
@@ -82,7 +93,7 @@ describe('the mock’s orders', () => {
     // Decision 5: the number with another order's token, or a made-up token, finds nothing
     const other = await placed(source, { ...ORDER, paymentMethod: 'online' });
     expect(await source.order(orderNo, other.token)).toBeNull();
-    expect(await source.order(orderNo, 'f'.repeat(64))).toBeNull();
+    expect(await source.order(orderNo, 'f'.repeat(22))).toBeNull();
     // And the code cannot confirm it twice
     expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
   });
@@ -92,6 +103,7 @@ describe('the mock’s orders', () => {
     await placed(source);
     const order = await placed(source, { ...ORDER, paymentMethod: 'online' });
     expect(order.answer).toEqual({ next: 'confirmed', orderNo: 'W-000002', phone: '01786120356' });
+    expect(numberOf(order)).toBe('W-000002');
     expect((await source.order('W-000002', order.token))?.status).toBe('confirmed');
   });
 
@@ -114,6 +126,41 @@ describe('the mock’s orders', () => {
     expect(await source.codeWait(token)).toBeNull();
   });
 
+  // Step 27a: the API's code rules, kept by the mock so the verify page meets them in its tests
+  it('refuses a code after its 10 minutes without spending a try', async () => {
+    const { source, wait } = withClock();
+    const { token } = await placed(source);
+    wait(10 * 60);
+    expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
+      ok: false,
+      code: 'shop_code_expired',
+    });
+    expect(await source.verifyCode(token, '000000')).toEqual({
+      ok: false,
+      code: 'shop_code_expired',
+    });
+    // A new code works its own 10 minutes, and no try was spent on the expired one
+    expect(await source.resendCode(token)).toMatchObject({ ok: true });
+    expect(await source.verifyCode(token, '000000')).toMatchObject({
+      params: { triesLeft: SHOP_CODE_TRIES - 1 },
+    });
+    wait(9 * 60);
+    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ ok: true });
+  });
+
+  it('sends three codes at most', async () => {
+    const { source, wait } = withClock();
+    const { token } = await placed(source);
+    wait(45);
+    expect(await source.resendCode(token)).toMatchObject({ ok: true });
+    wait(45);
+    expect(await source.resendCode(token)).toMatchObject({ ok: true });
+    // The first SMS and two more: the fourth ask is refused at once, not after another wait
+    expect(await source.resendCode(token)).toEqual({ ok: false, code: 'shop_code_sends_used' });
+    // The last code still works
+    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ ok: true });
+  });
+
   it('sends a new code only after 45 seconds, and keeps the wrong codes', async () => {
     const { source, wait } = withClock();
     const { token } = await placed(source);
@@ -151,7 +198,7 @@ describe('the mock’s orders', () => {
 
   it('refuses what the shop does not offer', async () => {
     const { source } = withClock();
-    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' })).toEqual({
+    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' }, ADDRESS)).toEqual({
       ok: false,
       code: 'shop_zone_unknown',
     });
@@ -161,7 +208,7 @@ describe('the mock’s orders', () => {
     const { source } = withClock();
     // One face wash: ৳229 of items, ৳80 delivery
     const small = { ...ORDER, lines: [{ listingId: NEEM, quantity: 1 }], expectedTotal: '309' };
-    expect(await source.placeOrder(small)).toEqual({
+    expect(await source.placeOrder(small, ADDRESS)).toEqual({
       ok: false,
       code: 'shop_order_below_minimum',
       params: { minimum: '300' },
@@ -171,25 +218,27 @@ describe('the mock’s orders', () => {
   it('refuses an order whose total or stock changed since the last quote', async () => {
     const { source } = withClock();
     // Decision 10: the shopper saw ৳747 (an old price); the server's total is ৳767
-    expect(await source.placeOrder({ ...ORDER, expectedTotal: '747' })).toMatchObject({
+    expect(await source.placeOrder({ ...ORDER, expectedTotal: '747' }, ADDRESS)).toMatchObject({
       code: 'shop_order_changed',
     });
     // A line went out of stock: the total of what is left might still match, so it is checked
     // on its own
     const withMilk = { ...ORDER, lines: [...ORDER.lines, { listingId: DANO, quantity: 1 }] };
-    expect(await source.placeOrder(withMilk)).toMatchObject({ code: 'shop_order_changed' });
+    expect(await source.placeOrder(withMilk, ADDRESS)).toMatchObject({
+      code: 'shop_order_changed',
+    });
   });
 
   it('keeps the coupon that took money off, and copies the lines', async () => {
     const { source } = withClock();
     // ৳687 − 10% (৳68.70) + ৳80
-    const { orderNo, token } = await placed(source, {
+    const placedOrder = await placed(source, {
       ...ORDER,
       couponCode: 'WELCOME10',
       paymentMethod: 'online',
       expectedTotal: '698.30',
     });
-    const order = await source.order(orderNo, token);
+    const order = await source.order(numberOf(placedOrder), placedOrder.token);
     expect(order).toMatchObject({
       couponCode: 'WELCOME10',
       discount: '68.7000',
```

The mock's tests check the API's code rules as the mock keeps them: an expired code costs no try and a new code
still confirms; the fourth code is refused at once and the third still works. The token test checks the contracts'
schema, not a pattern of its own. `numberOf()` reads a confirmed order's number from its answer. The `maskPhone()`
test is gone: the contracts test it (27a.1).

```ts
import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit';

// Step 26e: the misses limit. Step 27a: the address it counts by is tested in @omnivo/contracts
// (addressKey moved there), and the limiter is the mock's only (mock-source.ts)

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
```

```diff
@@ -26,6 +26,9 @@ function demoSource() {
 // The form's request after shopTrackRequestSchema, as the route hands it over
 const asked = (phone: string, orderNo: string) => shopTrackRequestSchema.parse({ phone, orderNo });
 
+// Step 27a: the shopper's address, which the mock counts misses under
+const ADDRESS = '203.0.113.7';
+
 // Two face washes, inside Dhaka: ৳458 + ৳80, over the shop's ৳300 minimum
 function order(paymentMethod: ShopOrderRequest['paymentMethod']): ShopOrderRequest {
   return {
@@ -87,35 +90,63 @@ describe('tracking in the mock', () => {
   });
 
   it('tracks with the number and the phone the order was placed with, however they are typed', async () => {
-    const tracking = await demoSource().track(asked('01786 120356', 'w-000123'));
-    expect(tracking?.orderNo).toBe('W-000123');
+    const tracked = await demoSource().track(asked('01786 120356', 'w-000123'), ADDRESS);
+    expect(tracked).toMatchObject({ ok: true, value: { orderNo: 'W-000123' } });
   });
 
-  it('answers null for the right number with another order’s phone', async () => {
+  it('refuses the right number with another order’s phone', async () => {
     // 01711284519 placed W-000121: a real buyer's phone, but not this order's
-    expect(await demoSource().track(asked('01711284519', 'W-000123'))).toBeNull();
+    expect(await demoSource().track(asked('01711284519', 'W-000123'), ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_track_not_found',
+    });
   });
 
-  it('answers null for a number no order has', async () => {
-    expect(await demoSource().track(asked('01786120356', 'W-000999'))).toBeNull();
+  it('refuses a number no order has', async () => {
+    expect(await demoSource().track(asked('01786120356', 'W-000999'), ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_track_not_found',
+    });
   });
 
   it('numbers new orders after the demo ones, and tracks them with no parcel', async () => {
     const source = demoSource();
-    const placed = await source.placeOrder(order('online'));
+    const placed = await source.placeOrder(order('online'), ADDRESS);
     if (!placed.ok) throw new Error(placed.code);
-    expect(placed.value.orderNo).toBe('W-000124');
+    expect(placed.value.answer).toMatchObject({ next: 'confirmed', orderNo: 'W-000124' });
 
-    const tracking = await source.track(asked('01786120356', 'W-000124'));
-    expect(tracking?.status).toBe('confirmed');
-    expect(tracking?.shipments).toEqual([]);
+    const tracked = await source.track(asked('01786120356', 'W-000124'), ADDRESS);
+    expect(tracked).toMatchObject({ ok: true, value: { status: 'confirmed', shipments: [] } });
   });
 
   it('does not track an order that waits for its code', async () => {
     const source = demoSource();
-    const placed = await source.placeOrder(order('cod'));
+    const placed = await source.placeOrder(order('cod'), ADDRESS);
     if (!placed.ok) throw new Error(placed.code);
-    expect(await source.track(asked('01786120356', placed.value.orderNo))).toBeNull();
+    // The mock numbers its orders as they are placed: the next one after the demo orders
+    expect(await source.track(asked('01786120356', 'W-000124'), ADDRESS)).toMatchObject({
+      ok: false,
+      code: 'shop_track_not_found',
+    });
+  });
+
+  // Step 27a: the limit moved here from the /track form's server code (server/track.spec.ts tests
+  // the form with it)
+  it('stops an address after ten misses, for the window’s 15 minutes', async () => {
+    let now = new Date('2026-11-15T10:00:00+06:00');
+    const source = createMockSource(() => now, mockDemoOrders);
+    for (let miss = 0; miss < 10; miss += 1) {
+      await source.track(asked('01711284519', 'W-000123'), ADDRESS);
+    }
+    expect(await source.track(asked('01786120356', 'W-000123'), ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_track_too_many',
+      params: { minutes: 15 },
+    });
+    now = new Date(now.getTime() + 15 * 60 * 1000);
+    expect(await source.track(asked('01786120356', 'W-000123'), ADDRESS)).toMatchObject({
+      ok: true,
+    });
   });
 
   it('cannot be changed through what it answers', async () => {
```

The `/track` limit is tested here now, through the mock source: ten misses stop the address, the right pair is
refused too, and the window's end lets it in again.

```diff
@@ -3,10 +3,10 @@ import { describe, expect, it, vi } from 'vitest';
 import type { ShopSource } from '../data/types';
 import { mockDemoOrders } from '../data/mock/demo-orders';
 import { createMockSource } from '../data/mock/mock-source';
-import { createRateLimiter } from './rate-limit';
 import { answerTrackForm } from './track';
 
-// Step 26e: the /track form's POST
+// Step 26e: the /track form's POST. Step 27a: the limit is the source's now (the mock's here), so
+// these tests check it through the mock source, as the page meets it
 
 const SYLHET = { phone: '01786 120356', orderNo: 'w-000123' };
 const HOME = '203.0.113.7';
@@ -16,14 +16,12 @@ function post(body: Record<string, string>): Request {
   return new Request('http://shop.test/track', { method: 'POST', body: new URLSearchParams(body) });
 }
 
-// Each test has its own source and limiter, so no test spends another's tries
+// Each test has its own source, and with it its own limit, so no test spends another's tries
 function context(source: ShopSource = createMockSource(undefined, mockDemoOrders)) {
-  const limiter = createRateLimiter({ tries: 10, windowMs: 15 * 60 * 1000 });
   return {
     source,
-    limiter,
     ask: (body: Record<string, string>, address = HOME) =>
-      answerTrackForm(post(body), { source, limiter, address }),
+      answerTrackForm(post(body), { source, address }),
   };
 }
 
@@ -44,13 +42,13 @@ describe('the track form', () => {
   });
 
   it('treats a body that is not a form as empty boxes', async () => {
-    const { source, limiter } = context();
+    const { source } = context();
     const request = new Request('http://shop.test/track', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(SYLHET),
     });
-    const answer = await answerTrackForm(request, { source, limiter, address: HOME });
+    const answer = await answerTrackForm(request, { source, address: HOME });
     expect(answer.kind).toBe('invalid');
     if (answer.kind === 'invalid') expect(answer.values).toEqual({ phone: '', orderNo: '' });
   });
@@ -89,17 +87,27 @@ describe('the track form', () => {
     expect((await ask(SYLHET)).kind).toBe('found');
   });
 
-  it('says try again when the source fails, and counts no miss', async () => {
+  it('says try again when the source fails', async () => {
     const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
     const broken: ShopSource = {
       ...createMockSource(),
       track: () => Promise.reject(new Error('API down')),
     };
     const { ask } = context(broken);
-    for (let attempt = 0; attempt < 11; attempt += 1) {
-      expect(await ask(SYLHET)).toMatchObject({ kind: 'refused', code: 'internal_error' });
-    }
+    expect(await ask(SYLHET)).toMatchObject({ kind: 'refused', code: 'internal_error' });
     expect(error).toHaveBeenCalledWith('track order failed', expect.any(Error));
     error.mockRestore();
   });
+
+  it('says try again in a minute when the source gives no wait', async () => {
+    // An API that broke its word (429 without params.minutes): never "in NaN minutes"
+    const stopped: ShopSource = {
+      ...createMockSource(),
+      track: () => Promise.resolve({ ok: false, code: 'shop_track_too_many' }),
+    };
+    expect(await context(stopped).ask(SYLHET)).toMatchObject({
+      code: 'shop_track_too_many',
+      params: { minutes: 1 },
+    });
+  });
 });
```

The form's tests keep their cases (the IPv6 block, the looks that never count) and run them through the mock
source's limit, which is how the page meets it.

```diff
@@ -13,6 +13,8 @@ import { answerPlaceOrder, answerResendCode, answerVerifyCode } from './orders';
 
 const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
 const OPTIONS = { secure: false };
+// The shopper's address, which the route passes on to the source (the API counts orders by it)
+const ADDRESS = '203.0.113.7';
 
 // What the checkout sends: the phone as the shopper typed it
 const ORDER: ShopOrderRequestInput = {
@@ -66,7 +68,7 @@ function withClock() {
 
 // Places a Cash on Delivery order and gives back the cookie the browser keeps
 async function placeCod(source: ShopSource): Promise<string> {
-  const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
+  const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, OPTIONS);
   expect(response.status).toBe(201);
   return sentBack(cookiesOf(response).get('shop_checkout'));
 }
@@ -74,7 +76,7 @@ async function placeCod(source: ShopSource): Promise<string> {
 describe('POST /api/orders', () => {
   it('places a Cash on Delivery order and keeps its token out of reach of scripts', async () => {
     const { source } = withClock();
-    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
+    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, OPTIONS);
     expect(response.status).toBe(201);
     expect(response.headers.get('Cache-Control')).toBe('no-store');
 
@@ -87,7 +89,7 @@ describe('POST /api/orders', () => {
 
     const cookie = cookiesOf(response).get('shop_checkout') ?? '';
     expect(cookie).toMatch(
-      /^shop_checkout=[0-9a-f]{64}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
+      /^shop_checkout=[A-Za-z0-9_-]{22}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
     );
     // The token is only in the cookie, never in the body a script can read
     expect(text).not.toContain(sentBack(cookie).split('=')[1]);
@@ -95,7 +97,9 @@ describe('POST /api/orders', () => {
 
   it('marks the cookies Secure in production', async () => {
     const { source } = withClock();
-    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, { secure: true });
+    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, {
+      secure: true,
+    });
     expect(cookiesOf(response).get('shop_checkout')).toMatch(/; Secure$/);
   });
 
@@ -104,6 +108,7 @@ describe('POST /api/orders', () => {
     const response = await answerPlaceOrder(
       post('/api/orders', { ...ORDER, paymentMethod: 'online' }),
       source,
+      ADDRESS,
       OPTIONS,
     );
     expect(response.status).toBe(201);
@@ -114,7 +119,7 @@ describe('POST /api/orders', () => {
     });
     const cookies = cookiesOf(response);
     expect(cookies.get('shop_orders')).toMatch(
-      /^shop_orders=W-000001:[0-9a-f]{64}; Path=\/; Max-Age=2592000;/,
+      /^shop_orders=W-000001:[A-Za-z0-9_-]{22}; Path=\/; Max-Age=2592000;/,
     );
     // A code that was still waiting from an earlier try is forgotten
     expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=; Path=\/; Max-Age=0;/);
@@ -130,6 +135,7 @@ describe('POST /api/orders', () => {
         address: 'Dhaka',
       }),
       source,
+      ADDRESS,
       OPTIONS,
     );
     expect(response.status).toBe(400);
@@ -148,7 +154,7 @@ describe('POST /api/orders', () => {
       headers: { 'Content-Type': 'text/plain' },
       body: JSON.stringify(ORDER),
     });
-    const response = await answerPlaceOrder(request, source, OPTIONS);
+    const response = await answerPlaceOrder(request, source, ADDRESS, OPTIONS);
     expect(response.status).toBe(400);
     expect((await problemOf(response)).code).toBe('malformed_request');
   });
@@ -158,6 +164,7 @@ describe('POST /api/orders', () => {
     const response = await answerPlaceOrder(
       post('/api/orders', { ...ORDER, expectedTotal: '700' }),
       source,
+      ADDRESS,
       OPTIONS,
     );
     expect(response.status).toBe(409);
@@ -173,6 +180,7 @@ describe('POST /api/orders', () => {
         expectedTotal: '309',
       }),
       source,
+      ADDRESS,
       OPTIONS,
     );
     expect(response.status).toBe(422);
@@ -180,6 +188,37 @@ describe('POST /api/orders', () => {
     expect(problem).toMatchObject({ code: 'shop_order_below_minimum', params: { minimum: '300' } });
   });
 
+  // Step 27a
+  it('passes the shopper’s address to the source', async () => {
+    const { source } = withClock();
+    const addresses: string[] = [];
+    const watched: ShopSource = {
+      ...source,
+      placeOrder: (request, address) => {
+        addresses.push(address);
+        return source.placeOrder(request, address);
+      },
+    };
+    await answerPlaceOrder(post('/api/orders', ORDER), watched, ADDRESS, OPTIONS);
+    expect(addresses).toEqual([ADDRESS]);
+  });
+
+  it('answers the order limit with 429 and the wait in Retry-After', async () => {
+    const limited: ShopSource = {
+      ...createMockSource(),
+      placeOrder: () =>
+        Promise.resolve({ ok: false, code: 'shop_order_limit', params: { minutes: 12 } }),
+    };
+    const response = await answerPlaceOrder(post('/api/orders', ORDER), limited, ADDRESS, OPTIONS);
+    expect(response.status).toBe(429);
+    // Retry-After is in seconds; the words say minutes
+    expect(response.headers.get('Retry-After')).toBe('720');
+    expect(await problemOf(response)).toMatchObject({
+      code: 'shop_order_limit',
+      params: { minutes: 12 },
+    });
+  });
+
   it('hides a failing source behind internal_error', async () => {
     const down: ShopSource = {
       ...createMockSource(),
@@ -188,7 +227,7 @@ describe('POST /api/orders', () => {
     const quiet = console.error;
     console.error = () => undefined;
     try {
-      const response = await answerPlaceOrder(post('/api/orders', ORDER), down, OPTIONS);
+      const response = await answerPlaceOrder(post('/api/orders', ORDER), down, ADDRESS, OPTIONS);
       expect(response.status).toBe(500);
       expect(JSON.stringify(await problemOf(response))).not.toContain('10.0.0.5');
     } finally {
@@ -253,11 +292,28 @@ describe('POST /api/orders/verify', () => {
     expect(cookiesOf(response).get('shop_checkout')).toMatch(/Max-Age=0/);
   });
 
+  // Step 27a: no try is spent, and the cookie stays: a new code still confirms the order
+  it('refuses a code after its 10 minutes and keeps the order', async () => {
+    const { source, wait } = withClock();
+    const checkout = await placeCod(source);
+    wait(10 * 60);
+    const response = await answerVerifyCode(
+      post('/api/orders/verify', { code: '123456' }, checkout),
+      source,
+      OPTIONS,
+    );
+    expect(response.status).toBe(422);
+    expect((await problemOf(response)).code).toBe('shop_code_expired');
+    expect(response.headers.getSetCookie()).toEqual([]);
+  });
+
   it('answers 404 without a cookie, or with one it never made', async () => {
     const { source } = withClock();
     for (const cookie of [
       undefined,
       'shop_checkout=not-a-token',
+      `shop_checkout=${'a'.repeat(22)}`,
+      // Step 27a: a cookie in 26c's old shape (64 hex digits) is not the API's token
       `shop_checkout=${'a'.repeat(64)}`,
     ]) {
       const response = await answerVerifyCode(
@@ -310,6 +366,30 @@ describe('POST /api/orders/resend', () => {
     expect(await sent.json()).toEqual({ resendInSeconds: 45 });
   });
 
+  // Step 27a: the first code and two more
+  it('refuses a fourth code and keeps the order', async () => {
+    const { source, wait } = withClock();
+    const checkout = await placeCod(source);
+    for (let send = 0; send < 2; send += 1) {
+      wait(45);
+      const sent = await answerResendCode(
+        post('/api/orders/resend', {}, checkout),
+        source,
+        OPTIONS,
+      );
+      expect(sent.status).toBe(200);
+    }
+    wait(45);
+    const fourth = await answerResendCode(
+      post('/api/orders/resend', {}, checkout),
+      source,
+      OPTIONS,
+    );
+    expect(fourth.status).toBe(422);
+    expect((await problemOf(fourth)).code).toBe('shop_code_sends_used');
+    expect(fourth.headers.getSetCookie()).toEqual([]);
+  });
+
   it('answers 404 and clears the cookie for an order that stopped waiting', async () => {
     const { source, wait } = withClock();
     const checkout = await placeCod(source);
@@ -325,7 +405,7 @@ describe('POST /api/orders/resend', () => {
 });
 
 describe('the orders cookie', () => {
-  const token = (n: number) => String(n).padStart(64, '0');
+  const token = (n: number) => String(n).padStart(22, '0');
 
   it('keeps the newest 20 orders', () => {
     let cookie = '';
```

New: the route hands the address to the source; the order limit is a 429 with `Retry-After: 720`; an expired code and
a fourth code are refused without touching the cookie; a cookie in 26c's old shape is no order.

```diff
@@ -1,17 +1,27 @@
 import {
   listingQueryFromParams,
   publicListingParamsSchema,
+  SHOP_CLIENT_ADDRESS_HEADER,
   SHOP_HOST_HEADER,
+  SHOP_KEY_HEADER,
   shopCartQuoteRequestSchema,
+  shopOrderNoSchema,
+  shopOrderRequestSchema,
+  shopOrderTokenSchema,
+  shopTrackingTokenSchema,
+  shopTrackRequestSchema,
+  shopVerifyCodeRequestSchema,
   type ShopTextPageSlug,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
+import { z } from 'zod';
 
+import { mockDemoOrders } from '../mock/demo-orders';
 import { mockHome } from '../mock/home';
 import { createMockSource } from '../mock/mock-source';
-import { createOrderBook, MOCK_CODE, type MockOrderBook } from '../mock/orders';
+import { MOCK_CODE } from '../mock/orders';
 import { mockCategories, mockShop } from '../mock/shop';
-import type { ShopSource } from '../types';
+import type { ShopSource, SourceResult } from '../types';
 import { createAnswerCache } from './answer-cache';
 import { createApiSource } from './api-source';
 import { createShopApi, ShopApiError, ShopMissingError } from './shop-api';
@@ -21,13 +31,37 @@ import { createShopApi, ShopApiError, ShopMissingError } from './shop-api';
 // is written down, so a test can see what the shop sent
 const HOST = 'nirvor.omnivo.test';
 const API = 'http://api.test';
+// Step 27a: the shop server's key (SHOP_API_KEY) and the shopper's address
+const KEY = 'test-shop-key-0123456789abcdef0123456789';
+const ADDRESS = '203.0.113.7';
 const STEVIA = 'lst-zero-cal-stevia-30-sachets';
 const NEEM = 'himalaya-purifying-neem-face-wash-150ml';
 
-function problem(status: number, code: string): Response {
-  return Response.json({ title: 'Refused', status, detail: code, code }, { status });
+function problem(status: number, code: string, params?: Record<string, string | number>): Response {
+  return Response.json(
+    { title: 'Refused', status, detail: code, code, ...(params ? { params } : {}) },
+    { status },
+  );
 }
 
+// Step 27a: a source's refusal as the API sends it, with the API's statuses
+// (shop-orders.service.ts)
+const STATUS: Record<string, number> = {
+  shop_order_changed: 409,
+  shop_order_limit: 429,
+  shop_code_resend_wait: 429,
+  shop_track_too_many: 429,
+  shop_code_no_order: 404,
+  shop_track_not_found: 404,
+};
+
+function answered<T>(result: SourceResult<T, string>, status = 200): Response {
+  if (result.ok) return Response.json(result.value, { status });
+  return problem(STATUS[result.code] ?? 422, result.code, result.params);
+}
+
+const tokenBody = z.object({ token: shopOrderTokenSchema });
+
 function fakeApi(data: ShopSource = createMockSource()) {
   const requests: Request[] = [];
   let failNext: Response | null = null;
@@ -42,6 +76,14 @@ function fakeApi(data: ShopSource = createMockSource()) {
       const body = shopCartQuoteRequestSchema.parse(await request.json());
       return Response.json(await data.quote(body));
     }
+    // Step 27a: the order routes, behind the key like the API's ShopKeyGuard. The mock behind them
+    // keeps the API's rules for the code (data/mock/orders.ts)
+    if (request.method === 'POST' && /^\/(?:orders|tracking|track)(?:\/|$)/.test(path)) {
+      if (request.headers.get(SHOP_KEY_HEADER) !== KEY) {
+        return problem(401, 'storefront_shop_key_invalid');
+      }
+      return orderRoute(path, request);
+    }
     if (path === '/shop') return Response.json(await data.shop());
     if (path === '/categories') return Response.json(await data.categories());
     if (path === '/home') return Response.json(await data.home());
@@ -63,6 +105,39 @@ function fakeApi(data: ShopSource = createMockSource()) {
     return problem(404, 'not_found');
   }
 
+  async function orderRoute(path: string, request: Request): Promise<Response> {
+    const json: unknown = await request.json();
+    const address = request.headers.get(SHOP_CLIENT_ADDRESS_HEADER) ?? 'no address';
+    switch (path) {
+      case '/orders':
+        return answered(await data.placeOrder(shopOrderRequestSchema.parse(json), address), 201);
+      case '/orders/code-wait': {
+        const wait = await data.codeWait(tokenBody.parse(json).token);
+        return wait === null ? problem(404, 'shop_code_no_order') : Response.json(wait);
+      }
+      case '/orders/verify': {
+        const body = tokenBody.extend(shopVerifyCodeRequestSchema.shape).parse(json);
+        return answered(await data.verifyCode(body.token, body.code));
+      }
+      case '/orders/resend':
+        return answered(await data.resendCode(tokenBody.parse(json).token));
+      case '/orders/find': {
+        const body = tokenBody.extend({ orderNo: shopOrderNoSchema }).parse(json);
+        const order = await data.order(body.orderNo, body.token);
+        return order === null ? problem(404, 'not_found') : Response.json(order);
+      }
+      case '/tracking': {
+        const body = z.object({ token: shopTrackingTokenSchema }).parse(json);
+        const tracking = await data.tracking(body.token);
+        return tracking === null ? problem(404, 'not_found') : Response.json(tracking);
+      }
+      case '/track':
+        return answered(await data.track(shopTrackRequestSchema.parse(json), address));
+      default:
+        return problem(404, 'not_found');
+    }
+  }
+
   const fetch: typeof globalThis.fetch = async (input, init) => {
     const request = new Request(input, init);
     requests.push(request.clone());
@@ -83,12 +158,11 @@ function fakeApi(data: ShopSource = createMockSource()) {
   };
 }
 
-// A shop source on the fake API, with its own cache and order book, as data/source.ts makes one
-function setup({ host = HOST, api = fakeApi(), book = createOrderBook() } = {}) {
+// A shop source on the fake API, with its own cache, as data/source.ts makes one
+function setup({ host = HOST, api = fakeApi(), key = KEY } = {}) {
   const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
   const source = createApiSource(
-    createShopApi({ apiUrl: API, host, cache, fetch: api.fetch }),
-    () => book,
+    createShopApi({ apiUrl: API, host, key, cache, fetch: api.fetch }),
   );
   return { source, api, cache };
 }
@@ -171,9 +245,7 @@ describe('the API source', () => {
     const api = fakeApi();
     const cache = createAnswerCache({ ttlMs: 30_000, maxEntries: 100 });
     const sourceOf = (host: string) =>
-      createApiSource(createShopApi({ apiUrl: API, host, cache, fetch: api.fetch }), () =>
-        createOrderBook(),
-      );
+      createApiSource(createShopApi({ apiUrl: API, host, key: KEY, cache, fetch: api.fetch }));
     await sourceOf(HOST).shop();
     await sourceOf(HOST).shop();
     // Another host is another shop: never the first one's answer
@@ -218,10 +290,11 @@ describe('the API source', () => {
     const down = createShopApi({
       apiUrl: API,
       host: HOST,
+      key: KEY,
       cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
       fetch: () => Promise.reject(new TypeError('fetch failed')),
     });
-    await expect(createApiSource(down, createOrderBook).shop()).rejects.toMatchObject({
+    await expect(createApiSource(down).shop()).rejects.toMatchObject({
       name: 'ShopApiError',
       status: 0,
     });
@@ -230,6 +303,7 @@ describe('the API source', () => {
     const hung = createShopApi({
       apiUrl: API,
       host: HOST,
+      key: KEY,
       cache: createAnswerCache({ ttlMs: 30_000, maxEntries: 10 }),
       timeoutMs: 20,
       fetch: (_input, init) =>
@@ -239,9 +313,7 @@ describe('the API source', () => {
           });
         }),
     });
-    await expect(createApiSource(hung, createOrderBook).home()).rejects.toBeInstanceOf(
-      ShopApiError,
-    );
+    await expect(createApiSource(hung).home()).rejects.toBeInstanceOf(ShopApiError);
   });
 });
 
@@ -262,43 +334,135 @@ describe('orders on the API source', () => {
   }
 
   async function place(source: ShopSource) {
-    const placed = await source.placeOrder({ ...order, expectedTotal: await expectedTotal() });
+    const placed = await source.placeOrder(
+      { ...order, expectedTotal: await expectedTotal() },
+      ADDRESS,
+    );
     if (!placed.ok) throw new Error(`refused: ${placed.code}`);
     return placed.value;
   }
 
-  it('prices the order with the API and sends it no name, phone or address', async () => {
+  const sentTo = (api: ReturnType<typeof fakeApi>, path: string) =>
+    api.requests.filter((request) => new URL(request.url).pathname === `/public/v1${path}`);
+
+  it('places an order with the API, and sends the key and the address on order routes only', async () => {
     const { source, api } = setup();
+    await source.shop();
+    await source.quote({ lines: order.lines });
     const placed = await place(source);
-    expect(placed.orderNo).toBe('W-000001');
+    expect(placed.answer).toEqual({
+      next: 'verify',
+      maskedPhone: '+880 17•• ••• 356',
+      resendInSeconds: 45,
+    });
 
-    const quote = api.requests.find((request) => request.url.endsWith('/cart/quote'));
-    expect(await quote?.json()).toEqual({ lines: order.lines, zoneId: 'inside_dhaka' });
+    // The whole order goes to the API in one request: no quote first (the API prices it itself)
+    const [sent] = sentTo(api, '/orders');
+    expect(await sent?.json()).toMatchObject({ name: 'Sumi Akter', phone: '01786120356' });
+    expect(sent?.headers.get(SHOP_KEY_HEADER)).toBe(KEY);
+    expect(sent?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBe(ADDRESS);
+    expect(sentTo(api, '/cart/quote')).toHaveLength(1);
+    // A read route carries neither
+    for (const path of ['/shop', '/cart/quote']) {
+      const [read] = sentTo(api, path);
+      expect(read?.headers.get(SHOP_KEY_HEADER)).toBeNull();
+      expect(read?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBeNull();
+    }
+  });
 
-    // The code is the mock's until step 27 sends SMS, and the page shows it
-    expect(source.testCode).toBe(MOCK_CODE);
-    const confirmed = await source.verifyCode(placed.token, MOCK_CODE);
-    expect(confirmed).toMatchObject({ ok: true, value: { orderNo: 'W-000001' } });
-    expect((await source.order('W-000001', placed.token))?.total).toBe(await expectedTotal());
+  it('confirms with the code and opens the order with its token', async () => {
+    const { source, api } = setup();
+    const { token } = await place(source);
+    expect((await source.codeWait(token))?.listingIds).toEqual([STEVIA]);
+
+    // A real shop shows no code: it goes only to the phone (the fake API is the mock, which takes
+    // MOCK_CODE)
+    expect(source.testCode).toBeNull();
+    expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
+      ok: true,
+      value: { orderNo: 'W-000001', phone: '01786120356' },
+    });
+    expect(await source.codeWait(token)).toBeNull();
+    expect((await source.order('W-000001', token))?.total).toBe(await expectedTotal());
+    // Another browser's token finds nothing
+    expect(await source.order('W-000001', 'A'.repeat(22))).toBeNull();
+    // Every token went in a body, never in an address (27a's decision 15)
+    expect(api.paths().some((path) => path.includes(token))).toBe(false);
   });
 
-  it('refuses an order whose price changed since the checkout saw it', async () => {
-    const { source } = setup();
-    const placed = await source.placeOrder({ ...order, expectedTotal: '1.0000' });
-    expect(placed).toEqual({ ok: false, code: 'shop_order_changed' });
+  it('passes on the refusals the pages know, with their params', async () => {
+    const { source, api } = setup();
+    expect(await source.placeOrder({ ...order, expectedTotal: '1.0000' }, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_order_changed',
+    });
+    const { token } = await place(source);
+    expect(await source.verifyCode(token, '000000')).toEqual({
+      ok: false,
+      code: 'shop_code_wrong',
+      params: { triesLeft: 4 },
+    });
+    expect(await source.resendCode(token)).toMatchObject({
+      ok: false,
+      code: 'shop_code_resend_wait',
+      params: { seconds: 45 },
+    });
+    api.failWith(problem(429, 'shop_order_limit', { minutes: 12 }));
+    expect(await source.placeOrder({ ...order, expectedTotal: '1' }, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_order_limit',
+      params: { minutes: 12 },
+    });
+  });
+
+  it('throws on a refusal the page has no words for', async () => {
+    const { source, api } = setup();
+    const { token } = await place(source);
+    // An order limit is not an answer to a code: a mistake on one side, not a shopper's
+    api.failWith(problem(429, 'shop_order_limit', { minutes: 12 }));
+    await expect(source.verifyCode(token, MOCK_CODE)).rejects.toBeInstanceOf(ShopApiError);
+  });
+
+  it('names the setting to fix when the API refuses the key', async () => {
+    const { source } = setup({ key: 'not-the-api-key-0123456789abcdef01234' });
+    await expect(
+      source.placeOrder({ ...order, expectedTotal: await expectedTotal() }, ADDRESS),
+    ).rejects.toThrow(/SHOP_API_KEY/);
+    // The read routes need no key, so the shop's pages still work
+    expect(await source.shop()).toEqual(mockShop);
+  });
+
+  it('does not ask for an order number the API would refuse', async () => {
+    const { source, api } = setup();
+    // From an edited cookie: the same "not found" as a wrong number, not a 500
+    expect(await source.order('abc', 'A'.repeat(22))).toBeNull();
+    expect(sentTo(api, '/orders/find')).toHaveLength(0);
   });
 
-  it('keeps each shop’s orders in its own book', async () => {
-    // data/source.ts gives each host its own book; two books here stand for two shops
-    const first: MockOrderBook = createOrderBook();
-    const second: MockOrderBook = createOrderBook();
-    const acme = setup({ book: first }).source;
-    const nirvor = setup({ book: second }).source;
-    const fromAcme = await place(acme);
-    expect((await place(nirvor)).orderNo).toBe('W-000001');
-    // The second shop cannot open the first one's order, even with its token
-    expect(await nirvor.order(fromAcme.orderNo, fromAcme.token)).toBeNull();
+  it('tracks by link and by the form, with the API’s limit', async () => {
+    const { source, api } = setup({ api: fakeApi(createMockSource(undefined, mockDemoOrders)) });
+    expect((await source.tracking('C2etI9zQb8E5ZugpwzVWyA'))?.orderNo).toBe('W-000123');
+    expect(await source.tracking('A'.repeat(22))).toBeNull();
+
+    const sylhet = shopTrackRequestSchema.parse({ phone: '01786120356', orderNo: 'W-000123' });
+    expect(await source.track(sylhet, ADDRESS)).toMatchObject({
+      ok: true,
+      value: { orderNo: 'W-000123' },
+    });
+    const wrong = shopTrackRequestSchema.parse({ phone: '01711284519', orderNo: 'W-000123' });
+    expect(await source.track(wrong, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_track_not_found',
+    });
+    // The form's misses count under the shopper's address, which only the API sees this way
+    expect(sentTo(api, '/track')[0]?.headers.get(SHOP_CLIENT_ADDRESS_HEADER)).toBe(ADDRESS);
+    api.failWith(problem(429, 'shop_track_too_many', { minutes: 14 }));
+    expect(await source.track(sylhet, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_track_too_many',
+      params: { minutes: 14 },
+    });
     // A real shop offers no demo orders on /track
-    expect(acme.testTracking).toBeNull();
+    expect(source.testTracking).toBeNull();
   });
 });
```

The fake API now serves the seven order routes too, behind the key like the API's `ShopKeyGuard`, with the mock
source behind them and the API's statuses (`STATUS`). The tests check what the shop sends and what it makes of the
answers:

- The order goes to the API in one request with the name and the phone, the key and the address; the read routes
  (`/shop`, the quote) carry neither.
- A right code confirms and opens the order; another token opens nothing; no token ever appears in an address
  (decision 15).
- The refusals the pages know come through with their `params`; one that a page has no words for throws.
- A wrong key throws an error that names `SHOP_API_KEY`, while the read routes keep working.
- An order number the API would refuse is not even asked for.
- Tracking by link and by the form, with the form's address sent and the API's 429 passed on.

```diff
@@ -117,6 +117,79 @@ test('the checkout waits for the minimum order and for the terms', async ({ page
   await expect(confirm).toBeDisabled();
 });
 
+// Step 27a: the API's own answers, which the mock never gives in a test's time (an order limit, a
+// code past its 10 minutes, a fourth code). The browser gets them as the API's source would hand
+// them over: the shop's routes answer with the same problem JSON (server/orders.ts)
+function problemBody(status: number, code: string, params?: Record<string, number>): string {
+  return JSON.stringify({ title: 'Refused', status, detail: code, code, params });
+}
+
+test('the checkout says how long to wait after too many orders', async ({ page }) => {
+  await page.goto(`/p/${SHAMPOO.slug}`);
+  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
+  await page.goto('/checkout');
+  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
+  await fillDetails(page);
+  await page.route('**/api/orders', (route) =>
+    route.fulfill({
+      status: 429,
+      contentType: 'application/problem+json',
+      body: problemBody(429, 'shop_order_limit', { minutes: 12 }),
+    }),
+  );
+  await page.getByRole('button', { name: 'Confirm Order' }).click();
+  await expect(
+    page.getByText('Too many orders from here. Wait 12 minutes, then try again.'),
+  ).toBeVisible();
+  await expect(page).toHaveURL('/checkout');
+});
+
+test('the code page says when a code expired and when no more codes can come', async ({ page }) => {
+  // The page's own clock, so "Resend code" opens without waiting 45 real seconds
+  await page.clock.install();
+  await page.goto(`/p/${SHAMPOO.slug}`);
+  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
+  await page.goto('/checkout');
+  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
+  await fillDetails(page);
+  await page.getByRole('button', { name: 'Confirm Order' }).click();
+  await expect(page).toHaveURL('/checkout/verify');
+
+  // A code past its 10 minutes: no try spent, the digits go and the box keeps the focus
+  await page.route('**/api/orders/verify', (route) =>
+    route.fulfill({
+      status: 422,
+      contentType: 'application/problem+json',
+      body: problemBody(422, 'shop_code_expired'),
+    }),
+  );
+  const box = page.getByRole('textbox', { name: '6-digit code' });
+  await box.fill('123456');
+  await page.getByRole('button', { name: 'Confirm Order' }).click();
+  await expect(page.getByText('This code has expired. Ask for a new code.')).toBeVisible();
+  await expect(box).toHaveValue('');
+  await expect(box).toBeFocused();
+
+  // The order has had its three codes: "Resend code" goes, the box stays, and the way back shows
+  await page.route('**/api/orders/resend', (route) =>
+    route.fulfill({
+      status: 422,
+      contentType: 'application/problem+json',
+      body: problemBody(422, 'shop_code_sends_used'),
+    }),
+  );
+  await page.clock.fastForward('00:46');
+  const resend = page.getByRole('button', { name: 'Resend code' });
+  await expect(resend).not.toHaveAttribute('aria-disabled', 'true');
+  await resend.click();
+  await expect(
+    page.getByText('No more codes can be sent for this order. Place the order again.'),
+  ).toBeVisible();
+  await expect(resend).toBeHidden();
+  await expect(box).toBeVisible();
+  await expect(page.getByRole('link', { name: 'Back to checkout' })).toBeVisible();
+});
+
 test('Mobile Banking needs no phone code in the test shop', async ({ page }) => {
   await page.goto(`/p/${SHAMPOO.slug}`);
   await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
```

The mock never gives these answers in a test's time (an hour of orders, ten minutes of waiting), so the two new
Playwright tests answer the shop's own routes with the problem JSON they would get from the API source
(`page.route`). The code page's test installs Playwright's clock before the page loads, so "Resend code" opens after
`fastForward('00:46')` instead of 46 real seconds.

### Check this part

```bash
pnpm --filter @omnivo/shop typecheck                         # astro check, e2e and scripts
pnpm --filter @omnivo/shop test                              # 25 files, 243 tests
pnpm exec eslint apps/shop/src apps/shop/e2e apps/shop/astro.config.ts
pnpm exec prettier --check apps/shop infra/staging/compose.yml
pnpm exec depcruise apps/shop packages/contracts
pnpm --filter @omnivo/shop test:e2e --workers=2              # 42 passed, 2 skipped (as before)
```

The Playwright tests still run on the mock source. 27a.6 places an order through the real API, with the code read
from Mailpit.

Broken on purpose, each caught (and put back):

- The cookies back to 26c's 32-to-128 pattern: nine route tests fail, because the 22-character tokens are refused.
- The key sent on every route: the "order routes only" test fails.
- `answerOf()` passing on any refusal: the "no words for" test fails.
- The mock's `/track` limiter not counting misses: three tests fail.
- The verify page without the "no more codes" branch: the new Playwright test fails on both screen sizes.


## 27a.6 — Run it and check it

```bash
pnpm install
pnpm db:migrate        # 0070 and 0071
pnpm dev
pnpm seed:shop         # once, if your dev database has no demo shop yet (26h.8)
```

`.env.example` now has a dev `STOREFRONT_SHOP_KEY`; copy that line into your `.env` before `pnpm dev`, or every order
route answers 401. `pnpm dev` starts the shop on its mock. Start a second one on the API (the same key):

```bash
SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 \
SHOP_API_KEY=dev-only-shop-key-change-me-0123456789abcdef \
pnpm --filter @omnivo/shop dev --port 4322
```

Then, at `http://demo-shop.localhost:4322`:

- [ ] Put two of one product in the cart, Checkout. Only **Cash on Delivery** is offered. Fill in the form, Confirm
      Order: the verify page says where the code went, and shows no "Test shop" line.
- [ ] Mailpit (`http://localhost:8025`) has "SMS to 01…" at `01…@sms.invalid`, the code first. Type a wrong code:
      "That code is wrong… 4 tries left." Type the right one: "Order Confirmed", and the cart is empty.
- [ ] "View Order Details" opens `/order/W-000001`. A second SMS in Mailpit has the tracking link; open it in a
      private window: the order's steps, no name and no phone. The link has the port of `SHOP_PUBLIC_PORT` (4321,
      the mock shop): change it to 4322 in the address bar, or set `SHOP_PUBLIC_PORT=4322` in `.env` first.
- [ ] `/track` with the phone and `W-000001` finds it; a wrong number gets the one "No order has…" answer.
- [ ] In the ERP, signed in as the shop's owner, the bell says "New shop order W-000001 for ৳538."
- [ ] Place an order and leave the code page. Within 65 minutes the worker's sweep deletes it with its stock hold
      (`SELECT count(*) FROM storefront_orders WHERE status = 'pending'` goes back to 0).
- [ ] Stop the shop and start it with a wrong `SHOP_API_KEY`: the products still show, Confirm Order fails, and the
      shop's log says that `SHOP_API_KEY` must be the API's `STOREFRONT_SHOP_KEY`.

### A bug this check found

The first run of the whole order on the real API stopped at the cart: the drawer said "The prices did not load" and
"Try again", every time. The quote itself was fine. The drawer refused it, because of the photo's address.

In development the API builds photo addresses from MinIO's address, `http://localhost:9000/omnivo/…` (26f). The
contract's `imageUrlSchema` was loosened in 26f to take plain `http` on this computer only. But `quote.ts` in the shop
keeps its own hand-written check (it does not load Zod, to keep 25 KB gz off every page), and that copy still took
only `/…` and `https://…`. So with `SHOP_SOURCE=api` on your computer, no cart ever showed a price. The mock source
uses `/mock/…` paths, which is why no test saw it. This was there since 26f, not new in 27a, but 27a is the first
step that asks you to order on the API in development.

```diff
@@ -14,7 +14,12 @@ function isRecord(value: unknown): value is Record<string, unknown> {
 // the drawer draws and links to, so a broken answer shows "Try again", never "undefined" or a
 // link to somewhere else.
 const MONEY = /^\d+(\.\d{1,4})?$/;
-const LINK = /^(\/(?!\/)|https:\/\/)/;
+// Step 27a.6: the contract's own rule for a picture (imageUrlSchema in @omnivo/contracts): a path,
+// an https address, or plain http on this computer. Step 26f let the API send MinIO's
+// http://localhost:9000 address in dev, and this copy kept only https, so with SHOP_SOURCE=api the
+// drawer refused every quote in dev and showed "Try again". Production still has https only: the
+// API refuses to start with an http STOREFRONT_MEDIA_URL (config.ts)
+const IMAGE_URL = /^(\/(?!\/)|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/)/;
 
 function isMoney(value: unknown): value is string {
   return typeof value === 'string' && MONEY.test(value);
@@ -32,7 +37,7 @@ function isQuoteLine(value: unknown): value is ShopCartQuoteLine {
     typeof packSize === 'string' &&
     isRecord(image) &&
     typeof image.url === 'string' &&
-    LINK.test(image.url) &&
+    IMAGE_URL.test(image.url) &&
     typeof image.alt === 'string' &&
     typeof quantity === 'number' &&
     Number.isInteger(quantity);
```

The rule is now the contract's own, character for character. `http` is still refused for any other host, and the
`(:\d{1,5})?\/` part makes sure `http://localhost.evil.com/…` does not slip through as "localhost". Production is
not loosened by this: the API refuses to start in production when `STOREFRONT_MEDIA_URL` is not `https` (26f's
`config.ts`), so an `http` photo address never reaches a real shopper.

```diff
@@ -61,4 +61,29 @@ describe('isCartQuote', () => {
     ).toBe(false);
     expect(isCartQuote({ ...quote, subtotal: 229 })).toBe(false);
   });
+
+  it("takes the contract's picture addresses: MinIO's http on this computer, never http elsewhere", () => {
+    const line = {
+      status: 'available',
+      listingId: 'lst-a',
+      slug: 'neem',
+      name: 'Neem',
+      packSize: '150ml',
+      quantity: 1,
+      unitPrice: '229.0000',
+      lineTotal: '229.0000',
+    };
+    const quoteWith = (url: string) => ({
+      lines: [{ ...line, image: { url, alt: 'Neem' } }],
+      itemCount: 1,
+      subtotal: '229.0000',
+    });
+    expect(isCartQuote(quoteWith('http://localhost:9000/omnivo/storefront/a/small.webp'))).toBe(
+      true,
+    );
+    expect(isCartQuote(quoteWith('https://media.omnivo.shop/storefront/a/small.webp'))).toBe(true);
+    expect(isCartQuote(quoteWith('http://media.omnivo.shop/storefront/a/small.webp'))).toBe(false);
+    expect(isCartQuote(quoteWith('http://localhost.evil.com/a.webp'))).toBe(false);
+    expect(isCartQuote(quoteWith('//evil.com/a.webp'))).toBe(false);
+  });
 });
```

The test names both sides: MinIO's address and an `https` CDN pass; `http` on another host, a host that only starts
with "localhost", and a protocol-relative `//…` address fail.

Check this part:

```bash
pnpm --filter @omnivo/shop test -- quote
```

## What comes next

- **27b:** the ERP's Storefront → Orders: a data table with status tabs, the order's page, Packed / Shipped /
  Delivered / Cancelled, and the customer, sales order, challan and invoice each step makes. The bell then opens the
  order.
- **27c:** coupons, and online payment with SSLCommerz (each shop's own encrypted credentials). Mobile Banking comes
  back to the checkout then.
- **Before staging sends real SMS:** a real `SmsSender` (the provider is your choice) and the shop's SMS balance.
- **Step 28:** courier bookings, their events on the tracking page, and returns.
