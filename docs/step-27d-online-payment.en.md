# Step 27d: Checkout and orders, part 4 — paying online with SSLCommerz

> The implementation guide for "Phase 10 → Step 27", the fourth part, of [build-plan.bn.md](build-plan.bn.md). Step
> 27 has four parts:
>
> - **27a:** orders in the database, the stock they hold, the phone code by SMS, the tracking link and the API's
>   limits ([step-27a-shop-orders.en.md](step-27a-shop-orders.en.md)).
> - **27b:** the ERP's Storefront → Shop orders screens and the ERP documents an order makes
>   ([step-27b-shop-orders-erp.en.md](step-27b-shop-orders-erp.en.md)).
> - **27c:** the shop's coupons ([step-27c-coupons.en.md](step-27c-coupons.en.md)).
> - **27d (this guide):** online payment with SSLCommerz, with the shop's own encrypted credentials, a money receipt
>   for every paid order, and a fake gateway for development and CI.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `db69571`, "fix lint") and
> checked on 2026-11-22: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, `pnpm typecheck`, `pnpm test` (1,572,
> of them 667 in `packages/contracts`, 274 in `apps/shop`, 239 in `apps/app` and 223 in `apps/api`),
> `pnpm test:integration` (880 in 51 files) and `pnpm test:tenant-leak` (183 in 26 files) on Testcontainers, all
> clean on the first run, `pnpm boundaries`, `pnpm test:openapi`, `pnpm test:bundle-size` (first load 246.4 KB gz,
> budget 250 after 27d.8; the Shop settings page 131.9 KB and the shop order page 112.2 KB, budget 155), the app's
> Playwright suite on a computer and on a phone (456 passed and 3 skipped on purpose; 19 timed out while the machine
> was busy, none of them in a file this guide changed but one, and all 19 passed when run again one at a time), the
> PWA suite (4) and the shop's Playwright tests (50, 2 skipped on purpose, as before). ESLint ran in the three runs
> `pnpm lint` makes, each with 6 GB of memory: no errors. The migrations were also checked on a throwaway Postgres
> with their own script (27d.2). The whole way was then run on the real API, its worker and the built shop (27d.8):
> the ERP screens set the gateway up, the shop took two orders paid on the fake page, and the books got their money
> receipts with the fee.
>
> **There is no SSLCommerz sandbox account yet.** `SslcommerzGateway` was written from SSLCommerz's own documentation
> and is checked against the answers that documentation shows (27d.3's unit tests). Everything else runs on the fake
> gateway (`PAYMENT_GATEWAY=fake`), which answers in the same shapes. Before the first live shop, run the steps of
> 27d.8's "Try it" once with a sandbox store (`PAYMENT_GATEWAY=sslcommerz`, Store: Sandbox).

## Goal

🏷️ **A shopper pays online, and the books show the money the moment it arrives.** Until now the shop's "Mobile
Banking" card is hidden (step 27a's `offeredMethods`), because nothing could take the money. After 27d the tenant
saves its own SSLCommerz store in Shop settings → Payment, ticks "Pay online", and the checkout sends the shopper to
SSLCommerz's page. The API asks SSLCommerz itself whether the money came, confirms the order with no phone code, and
the worker posts a money receipt into the account the tenant picked, with SSLCommerz's fee as its own expense. A try
that fails can be tried again or turned into cash on delivery; the money always goes to the tenant's account, never
Omnivo's.

## Decisions

Agreed with the user on 2026-11-22 (all ten as recommended; the gateway's fee posted by itself from SSLCommerz's
`store_amount` into a fee account). They detail 27c's decisions 6–10.

1. **Placing an online order** makes a pending order with its stock held (as 27a does) and a first payment try with
   its own transaction id. The API asks the gateway for a payment page only after that transaction commits, and
   answers `next: 'pay'` with the page's address (a third answer of `shopOrderPlacedSchema`).
2. **The gateway comes back to the shop.** SSLCommerz posts the shopper's browser to the shop (success, fail, cancel)
   and calls the shop's server on its own (the IPN). Both go to one `auth: 'shop'` API route that asks SSLCommerz
   about the payment (by `val_id`, else by `tran_id`) and checks the status, the amount, the currency and the
   transaction id before it records anything, with the try's row locked, so a second call changes nothing. Astro
   refuses a POST from another site (`checkOrigin`), and the order's cookie is `SameSite=Lax`, so it is not sent on
   that POST: the shop turns `checkOrigin` off and does the same check in its middleware, with only the two gateway
   paths as exceptions, and the return path sends the browser on to a GET page (`/checkout/paid`) where the cookie
   works.
3. **A try that did not pay** shows "Try again" (a new try for the same order and hold, three at most) and "Pay on
   delivery" (the order becomes cash on delivery and gets its phone code).
4. **The credentials** live in their own table: the store id, the password encrypted with AES-256-GCM under a new
   `CREDENTIALS_KEY` (with a key version), and sandbox or live. Only the API's own role reads them, never the shop's.
   The password box is write-only; "Test connection" asks SSLCommerz's transaction query; `storefront.manage`, and
   the audit log never has the secret. "Pay online" can be ticked only once the gateway and its two accounts are
   saved; unticking it hides it at checkout within the shop's one-minute cache, and payments already on their way
   still settle.
5. **A payment that arrives late** (after the hold ended) still confirms the order: the money came. The stock is
   checked again at Packed. The sweep asks the gateway before it deletes a pending online order.
6. **A paid order gets a posted money receipt** (an advance) into the money account picked in the settings, with
   SSLCommerz's transaction number and the way the shopper paid as its reference; the invoice takes it at
   Delivered. SSLCommerz's fee (`amount − store_amount`) is posted by itself to a fee account picked in the settings.
7. **A paid order that is cancelled** shows a notice and a "Record refund" link to step 15d's refund. Refunding
   through SSLCommerz's own API comes in step 28.
8. **A fake gateway** (`PAYMENT_GATEWAY=fake|sslcommerz`, fake refused in production) with a page of its own on the
   shop (Pay, Fail, Cancel), used by development, CI and the shop's mock source.
9. **Words:** "Mobile Banking" becomes "Pay online". The ERP gets a Payment card in Shop settings, and the order page
   a Payments card.
10. **One guide, 27d.1–27d.9**, with a mockup before the screens. The gateway's code is written so that step 24's
    subscription billing can use it too.

Mine, made while writing (each explained where its code is):

11. **A try's statuses** are started, not_opened, paid, failed and cancelled; only paid is final, so a payment the
    gateway confirms after a failure or a cancel still counts (decision 5) (27d.1).
12. **The transaction id is ours and random** (20 upper-case letters and digits), not the order's number: a pending
    order has no number yet (27d.1).
13. **The shop's server reads only `tran_id` and `val_id`** from the gateway's post; everything else in it is asked
    of the gateway again (27d.1).
14. **`paymentUrl: null`** when the gateway opens no page: the order and its hold stay, and the shopper lands on the
    "Try again / Pay on delivery" page instead of an error (27d.1).
15. **The Payment card is its own form with its own routes and version**, not part of the shop's settings form, and
    "Test connection" tests what is saved, so the password never travels for a test (27d.1).
16. **The receipt's error is kept per payment try**, with its own "Make the receipt" route, like 27b's "Make the
    sales order" (27d.1).
17. **The fake gateway's `val_id` names the try and the amount**, so a test can pay a wrong amount by changing the
    page's address (27d.1).
18. **`routes` has a written type** (`Routes`), because the new routes made its inferred type longer than
    TypeScript writes into a declaration file (27d.1).

## 27d.1 — Contracts

Everything both sides must agree on before any code pays: what Confirm Order answers for an online order, what the
gateway posts back and what the shop's server passes on, what `/checkout/paid` draws, the ERP's Payment card and the
order page's payment tries. Plus the error codes, the audit actions and their words.

### The shop's side

```diff
@@ -373,8 +373,10 @@ export type ShopCouponResult = z.infer<typeof shopCouponResultSchema>;
 // Step 26c: checkout, the phone code and the order.
 
 // How the shopper pays. The system design's payment_method is cod | online; "online" is the
-// tenant's own gateway (SSLCommerz, bKash), which step 27 connects. The checkout calls it
-// "Mobile Banking", as Figma does.
+// tenant's own gateway account (SSLCommerz), which step 27d connects. Figma calls it "Mobile
+// Banking"; the shop says "Pay online" (step 27d's decision 9), because SSLCommerz's page takes
+// cards and internet banking as well as bKash and Nagad. The value stays `online`: it is saved on
+// every order already, and it never was the words.
 export const SHOP_PAYMENT_METHODS = ['cod', 'online'] as const;
 
 // A delivery zone the shop delivers to, with its charge ("Inside Dhaka — ৳80")
@@ -472,12 +474,24 @@ export function maskPhone(phone: string): string {
   return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
 }
 
+// Step 27d: the payment page the shopper is sent to. SSLCommerz's own page (GatewayPageURL, always
+// https), or in development and CI the shop's fake gateway page (SHOP_FAKE_GATEWAY_PATH), which is
+// http on localhost. Only http and https: the shop puts it in `location`, and a `javascript:`
+// address there would run on the shop's page
+export const shopPaymentUrlSchema = z.url({ protocol: /^https?$/ });
+
 // What Confirm Order answers. Which page comes next depends on the payment method:
 // - verify: Cash on Delivery. The order waits for the phone code; the browser goes to
 //   /checkout/verify, which says where the code went ("+880 17•• ••• 356": the middle is hidden, so
 //   a screenshot of the page does not give away the number)
-// - confirmed: the order needs no code (Mobile Banking in the mock; in the API from step 27c, once
-//   the shop's gateway says it is paid). The checkout opens the "Order Confirmed" dialog
+// - pay (step 27d): Pay online. The order waits for its payment, with no phone code (27c's
+//   decision 8: a card or a wallet proves more than an SMS). The browser goes to the gateway's
+//   page. paymentUrl is null when the gateway did not open a page (it was down, or it refused the
+//   shop's account): the order still exists and holds its stock, and the browser goes to
+//   /checkout/paid, which offers "Try again" and "Pay on delivery"
+// - confirmed: the order needs no code and is paid already. Only the mock answered it (26c); the
+//   API never does now, because an online order is confirmed when its payment arrives. Kept, so
+//   the checkout's dialog code stays the one place that opens "Order Confirmed"
 // The order's secret token is not in the body: the route sets it as an httpOnly cookie, so no
 // script on the page can read it (decisions 4 and 5).
 export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
@@ -486,6 +500,10 @@ export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
     maskedPhone: z.string().min(1),
     resendInSeconds: z.number().int().min(0),
   }),
+  z.object({
+    next: z.literal('pay'),
+    paymentUrl: shopPaymentUrlSchema.nullable(),
+  }),
   z.object({
     next: z.literal('confirmed'),
     orderNo: z.string().min(1),
@@ -524,6 +542,139 @@ export const shopCodeWaitSchema = z.object({
   listingIds: z.array(listingIdSchema).min(1).max(SHOP_CART_MAX_LINES),
 });
 
+// ---------------------------------------------------------------------------------------------
+// Step 27d: paying online. An online order is placed like any other (pending, holding its stock),
+// then waits for its payment instead of a phone code. Each visit to the gateway's page is one try
+// (a payment row in the API, with its own transaction id); the first one starts at Confirm Order.
+
+// A payment try's life:
+// - started: the gateway opened its page and the shopper is (or was) on it
+// - not_opened: the gateway did not open a page (down, or it refused the shop's account)
+// - paid: the gateway said, when the API asked it, that the money arrived in full. Final: no later
+//   answer moves it back
+// - failed, cancelled: the gateway said the bank refused it, or the shopper pressed Cancel there.
+//   Not final: a payment the gateway confirms later still makes it paid (decision 5: money that
+//   arrived is never left unrecorded)
+export const SHOP_PAYMENT_STATUSES = [
+  'started',
+  'not_opened',
+  'paid',
+  'failed',
+  'cancelled',
+] as const;
+
+// An order gets at most 3 tries, like its 3 phone codes: each one is a page the gateway makes, and
+// someone pressing "Try again" all evening is not paying. After the third the shopper can still pay
+// on delivery (when the shop takes it) or place the order again
+export const SHOP_PAYMENT_TRIES = 3;
+
+// The transaction id the API gives each try, and the gateway sends back (SSLCommerz's tran_id).
+// Not the order's number: a pending order has none yet (27a's decision 20). 20 upper-case letters
+// and digits, random: SSLCommerz takes up to 30 alphanumeric characters, and an id nobody can
+// guess means a made-up post to the return path names no try. The API never trusts what the post
+// says about it either way; it asks the gateway (shopGatewayPostSchema)
+export const shopPaymentTranIdSchema = z.string().regex(/^[A-Z0-9]{20}$/);
+
+// Where the gateway sends the shopper and its own server back to, on the shop's address. The API
+// builds the gateway's URLs from these when it opens a payment page (the success, fail and cancel
+// URLs all go to the return path; the server-to-server notice, SSLCommerz's IPN, to the notice
+// path), and the shop's middleware lets only these two take a POST from another site (decision 2)
+export const SHOP_PAYMENT_RETURN_PATH = '/checkout/pay/return';
+export const SHOP_PAYMENT_NOTICE_PATH = '/api/payments/notice';
+
+// What the gateway posts to both paths, as form fields with SSLCommerz's own names. Only the two
+// ids are read. Everything else in the post (status, amount, card_type) is what the browser or a
+// stranger sent, so the API asks the gateway itself, by val_id when there is one (a paid try) and
+// by tran_id when there is not (a failed or cancelled one). An empty val_id is none
+export const shopGatewayPostSchema = z.object({
+  tran_id: shopPaymentTranIdSchema,
+  val_id: z
+    .string()
+    .max(64)
+    .optional()
+    .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim())),
+});
+
+// The shop's server passes the two ids on, from either path. The API answers the try's status
+// after it asked the gateway; the return path then sends the browser to /checkout/paid, and the
+// notice path answers the gateway 200
+export const shopPaymentSettleRequestSchema = z.object({
+  tranId: shopPaymentTranIdSchema,
+  valId: z.string().min(1).max(64).nullable(),
+});
+export const shopPaymentSettledSchema = z.object({
+  status: z.enum(SHOP_PAYMENT_STATUSES),
+});
+
+// Why the last try did not pay, in the shopper's words on /checkout/paid:
+// - failed, cancelled: the gateway's answer
+// - not_opened: the payment page did not open
+// - not_finished: the try was started, and the gateway knows no payment for it: the shopper came
+//   back without paying (the browser's Back button), or the page is still open in another tab
+export const SHOP_PAYMENT_PROBLEMS = ['failed', 'cancelled', 'not_opened', 'not_finished'] as const;
+
+// What /checkout/paid draws for this browser's online order (by the cookie's token, like the
+// verify page):
+// - paid: the order is confirmed. The page takes its listings out of the cart (as a right phone
+//   code does) and opens "Order Confirmed"
+// - checking: the gateway could not be asked just now, or says the payment is still being
+//   processed. The page asks again after a few seconds
+// - unpaid: the last try did not pay. "Try again" while tries are left, "Pay on delivery" when the
+//   shop takes it now. The total is the one the shopper agreed to; it never changes on this page
+export const shopPaymentWaitSchema = z.discriminatedUnion('state', [
+  z.object({
+    state: z.literal('paid'),
+    orderNo: z.string().min(1),
+    phone: z.string().min(1),
+    listingIds: z.array(listingIdSchema).min(1).max(SHOP_CART_MAX_LINES),
+  }),
+  z.object({
+    state: z.literal('checking'),
+  }),
+  z.object({
+    state: z.literal('unpaid'),
+    problem: z.enum(SHOP_PAYMENT_PROBLEMS),
+    triesLeft: z
+      .number()
+      .int()
+      .min(0)
+      .max(SHOP_PAYMENT_TRIES - 1),
+    payOnDelivery: z.boolean(),
+    total: shopMoneySchema,
+  }),
+]);
+
+// "Try again" answers the new try's page, null when the gateway did not open one (the page then
+// says so, and the try counts: it is a row the API keeps)
+export const shopPaymentRetrySchema = z.object({
+  paymentUrl: shopPaymentUrlSchema.nullable(),
+});
+
+// Development and CI: the fake gateway (PAYMENT_GATEWAY=fake in the API, and the shop's mock
+// source) opens this page on the shop instead of SSLCommerz's. It shows the amount and three
+// buttons, and posts what SSLCommerz posts to SHOP_PAYMENT_RETURN_PATH. Its val_id carries the
+// try and the amount it says was paid, so a test can pay a wrong amount by changing the address.
+// The API refuses PAYMENT_GATEWAY=fake in production, and the real gateway asks SSLCommerz about a
+// val_id, so one of these typed into a live shop pays nothing
+export const SHOP_FAKE_GATEWAY_PATH = '/checkout/fake-gateway';
+export const FAKE_GATEWAY_OUTCOMES = ['paid', 'failed', 'cancelled'] as const;
+
+export const fakeGatewayParamsSchema = z.object({
+  tranId: shopPaymentTranIdSchema,
+  amount: shopMoneySchema,
+});
+
+export function fakeValId(tranId: string, amount: string): string {
+  return `FAKE_${tranId}_${amount}`;
+}
+
+// The try and the amount a fake val_id names, or null for anything else (a real SSLCommerz val_id)
+export function readFakeValId(valId: string): { tranId: string; amount: string } | null {
+  const match = /^FAKE_([A-Z0-9]{20})_(\d{1,12}(?:\.\d{1,4})?)$/.exec(valId);
+  if (match?.[1] === undefined || match[2] === undefined) return null;
+  return { tranId: match[1], amount: match[2] };
+}
+
 // An order's life (system design §14.3 storefront_orders.status). Cancelled and returned end it
 export const SHOP_ORDER_STATUSES = [
   'pending',
@@ -580,6 +731,15 @@ export type ShopCodeWait = z.infer<typeof shopCodeWaitSchema>;
 export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
 export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
 export type ShopOrder = z.infer<typeof shopOrderSchema>;
+export type ShopPaymentStatus = (typeof SHOP_PAYMENT_STATUSES)[number];
+export type ShopPaymentProblem = (typeof SHOP_PAYMENT_PROBLEMS)[number];
+export type ShopGatewayPost = z.infer<typeof shopGatewayPostSchema>;
+export type ShopPaymentSettleRequest = z.infer<typeof shopPaymentSettleRequestSchema>;
+export type ShopPaymentSettled = z.infer<typeof shopPaymentSettledSchema>;
+export type ShopPaymentWait = z.infer<typeof shopPaymentWaitSchema>;
+export type ShopPaymentRetry = z.infer<typeof shopPaymentRetrySchema>;
+export type FakeGatewayOutcome = (typeof FAKE_GATEWAY_OUTCOMES)[number];
+export type FakeGatewayParams = z.infer<typeof fakeGatewayParamsSchema>;
 
 // ---------------------------------------------------------------------------------------------
 // Step 26d: the category and search pages (/c/<slug>, /search).
@@ -1067,4 +1227,53 @@ export const publicStorefrontRoutes = {
     body: shopTrackRequestSchema,
     response: shopTrackingSchema,
   }),
+
+  // Step 27d. The gateway came back (the shopper's browser on the return path, or the gateway's
+  // own server on the notice path): the API asks the gateway and settles the try. The same call
+  // twice, or the browser and the notice at once, settle it once. 404 not_found for a transaction
+  // id that is not this shop's
+  settlePayment: defineRoute({
+    method: 'POST',
+    path: '/public/v1/payments/settle',
+    summary: 'Ask the gateway about a payment try and record what it says (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: shopPaymentSettleRequestSchema,
+    response: shopPaymentSettledSchema,
+  }),
+  // /checkout/paid, by the cookie's token. 404 shop_payment_no_order when no online order waits
+  // in this browser (it was dropped after its hour, or the cookie is gone)
+  paymentWait: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/payment',
+    summary: "This browser's online order and where its payment is (shop server only)",
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema,
+    response: shopPaymentWaitSchema,
+  }),
+  // "Try again". 422 shop_payment_tries_used after SHOP_PAYMENT_TRIES; 409 shop_payment_settled
+  // when it is paid already, or moved to cash on delivery
+  retryPayment: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/payment/retry',
+    summary: 'Open a new payment page for the online order (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema,
+    response: shopPaymentRetrySchema,
+  }),
+  // "Pay on delivery": the order becomes Cash on Delivery and gets its phone code, then goes on as
+  // any such order does (/checkout/verify). 422 shop_payment_unavailable when the shop does not
+  // take it; 409 shop_payment_settled when it is paid already
+  payOnDelivery: defineRoute({
+    method: 'POST',
+    path: '/public/v1/orders/payment/cod',
+    summary:
+      'Turn the online order into cash on delivery and send its phone code (shop server only)',
+    auth: 'shop',
+    status: 200,
+    body: orderTokenBodySchema,
+    response: shopCodeWaitSchema,
+  }),
 };
```

Why each part is written this way:

- **`SHOP_PAYMENT_METHODS` keeps `online`.** Only the comment changes: every saved order already has `cod` or
  `online`, and the words the shopper reads come from the locales (27d.5), so "Pay online" (decision 9) needs no
  change to the data.
- **`shopPaymentUrlSchema` takes `http` and `https` only.** The checkout puts the address in `window.location`
  (27d.7). A plain `z.url()` would also take `javascript:alert(1)`, which would run on the shop's own page if the
  API ever sent one. `http` stays allowed because the fake gateway's page is on `http://nirvor.localhost:4321` in
  development (decision 8).
- **The `pay` answer has `paymentUrl: … .nullable()`** (decision 14). SSLCommerz can be down, or refuse a store that
  was switched off. Throwing an error then would leave a pending order holding stock that the shopper cannot see or
  pay. With `null` the browser goes to `/checkout/paid`, which says the page did not open and offers "Try again" and
  "Pay on delivery". The `confirmed` answer stays for the mock and for the checkout's one place that opens "Order
  Confirmed"; the API never answers it now.
- **`SHOP_PAYMENT_STATUSES`** (decision 11). `paid` is the only final status. A `failed` or `cancelled` try can still
  become `paid` when the gateway says so later (a bank's slow answer, the shopper paying in a second tab): money
  that arrived must always reach the books (decision 5). `not_opened` is its own status, not a `failed` one, so the
  Payments card and `/checkout/paid` can say "the page did not open" instead of "the bank refused".
- **`SHOP_PAYMENT_TRIES = 3`**, like the phone codes' three sends: each try is a page SSLCommerz makes, and the third
  failure is a better moment to offer cash on delivery than a fourth page.
- **`shopPaymentTranIdSchema`** (decision 12): SSLCommerz needs a `tran_id` it has never seen for this store, at most
  30 characters. A pending order has no number until it is confirmed (27a's decision 20), and one order can have
  three tries, so each try gets its own random id. Random and long enough that a post with a made-up id names no
  try; the API still trusts nothing the post says.
- **The two paths** live here because both sides need them: the API builds SSLCommerz's `success_url`, `fail_url`,
  `cancel_url` (all the return path) and `ipn_url` (the notice path) from the shop's address, and the shop's
  middleware lets only these two take a POST from another site (decision 2). The notice path is under `/api/`, next
  to the shop's other server routes, because the gateway's server calls it, not a browser.
- **`shopGatewayPostSchema` reads two fields** (decision 13). SSLCommerz posts about twenty (`status`, `amount`,
  `card_type`, `verify_sign`…). A browser can post anything to the return path, so none of them is believed: the API
  asks SSLCommerz with the `val_id` (its validation API answers the status, the amount and the currency) or, for a
  failed or cancelled try that has no `val_id`, with the `tran_id`. An empty `val_id` is `null`, because SSLCommerz
  sends the field empty on a failure.
- **`shopPaymentSettleRequestSchema` and `shopPaymentSettledSchema`:** the shop's server passes the two ids on in
  camelCase, like every other body it sends, and gets the try's status back. The return path does not need it (it
  sends the browser on either way); a test and the notice path's log line do.
- **`SHOP_PAYMENT_PROBLEMS` adds `not_finished`** to the three statuses that did not pay: a try that is still
  `started` and that SSLCommerz knows no payment for. That is a shopper who pressed the browser's Back button on
  SSLCommerz's page, or one who still has it open in another tab, so the words say "not finished", not "failed".
- **`shopPaymentWaitSchema`**, what `/checkout/paid` draws, by the cookie's token like the verify page. `paid` has
  the listing ids so the page can take them out of the cart, as a right phone code does (26c's decision 23).
  `checking` is for a moment when SSLCommerz could not be asked or says the bank is still processing: the page asks
  again. `unpaid` has `triesLeft` (at most 2: the first try is used before this page ever shows), whether the shop
  takes cash on delivery now, and the total, which never changes on this page.
- **The fake gateway** (decisions 8 and 17). The page lives on the shop at `SHOP_FAKE_GATEWAY_PATH`, so the mock
  source (no API) and the API's fake gateway use the same page. Its `val_id` is `FAKE_<tran_id>_<amount>`:
  `readFakeValId` reads them back, so the API's fake gateway can answer "paid this amount" without a table of its
  own, and a test can pay too little by changing the amount in the page's address. `readFakeValId` matches the
  whole string (`^…$`), so `FAKE_…_12a` is not read as ৳12. A fake `val_id` typed into a live shop pays nothing:
  the real gateway asks SSLCommerz, which has never heard of it, and the API refuses `PAYMENT_GATEWAY=fake` in
  production (27d.3).
- **Four routes, all `auth: 'shop'` and POST with the token in the body**, like 27a's: `settlePayment` (both paths),
  `paymentWait` (`/checkout/paid`), `retryPayment` ("Try again") and `payOnDelivery` ("Pay on delivery", which
  answers the verify page's shape, so the browser goes on to `/checkout/verify` as any cash order does).

### The ERP's Payment card

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';

// Step 27d: the shop's own payment gateway account, as the ERP's Shop settings → Payment card reads
// and saves it. The money goes straight to the tenant's SSLCommerz account (system design §14:
// Omnivo keeps the keys and makes the calls, never the money). The password is saved encrypted
// (CREDENTIALS_KEY, decision 4) and never comes back: the card shows that one is saved, and an
// empty box keeps it.

// The gateways the shop can use. One now; a second (bKash's own API) adds a value here and a class
// in the API, and the rest of the shop only knows `online`
export const PAYMENT_GATEWAY_PROVIDERS = ['sslcommerz'] as const;

// SSLCommerz gives every merchant a sandbox store (test cards, no real money) and, after its own
// checks, a live one. Each has its own store id and password, and its own address
export const PAYMENT_GATEWAY_MODES = ['sandbox', 'live'] as const;

// "Test connection" asks the gateway something harmless with the saved account (SSLCommerz's
// transaction query). Its answers:
// - rejected: the gateway answered and refused the store id or the password, or the store is not
//   active (a sandbox store id in live mode is refused the same way)
// - unreachable: no answer in time, or one that is not the gateway's
export const PAYMENT_GATEWAY_TEST_PROBLEMS = ['rejected', 'unreachable'] as const;

// SSLCommerz's store ids are letters and digits ("nirvo67412bc0d9f1e"); the dash and underscore
// cover other gateways' ids. Trimmed: a store id copied from an email often brings a space. The
// pattern takes an empty box (`*`), because Zod runs every check: with `+` an empty box would say
// "required" and "letters and digits" at once
const storeIdSchema = z
  .string()
  .trim()
  .min(1, errorCode('required'))
  .max(64, errorCode('too_long'))
  .regex(/^[A-Za-z0-9_-]*$/, errorCode('storefront_gateway_store_id_format'));

// Not trimmed: a space at the end may be part of a password, and changing what was pasted would
// save a password that never works. 128 is far more than SSLCommerz's own
const passwordSchema = z.string().max(128, errorCode('too_long'));

const gatewayFieldsSchema = z.object({
  storeId: storeIdSchema,
  mode: z.enum(PAYMENT_GATEWAY_MODES),
  // Where a paid order's money receipt goes: an account that holds money ("SSLCommerz merchant
  // balance", under the bank accounts), because SSLCommerz pays the tenant's bank later in one
  // transfer. The select's "Pick an account" sends '', which is this error. Whether it holds money,
  // the API checks (moneyAccountIds), as for any money receipt
  moneyAccountId: z.uuid(errorCode('storefront_gateway_money_account_invalid')),
  // SSLCommerz keeps its fee from each payment (store_amount is what it pays out). The fee is
  // posted to this expense account (decision 6: Dr fee, Cr the money account), so the money
  // account's balance is what SSLCommerz really owes
  feeAccountId: z.uuid(errorCode('storefront_gateway_fee_account_invalid')),
});

// The first save needs a password; a later one keeps the saved password when the box is empty.
// Two schemas, as for the shop's settings: the first save has no version, a later one must
export const createStorefrontPaymentGatewayInputSchema = gatewayFieldsSchema.extend({
  password: passwordSchema.min(1, errorCode('storefront_gateway_password_required')),
});
export const updateStorefrontPaymentGatewayInputSchema = gatewayFieldsSchema.extend({
  password: passwordSchema,
  version: versionSchema,
});

export type CreateStorefrontPaymentGatewayInput = z.infer<
  typeof createStorefrontPaymentGatewayInputSchema
>;
export type UpdateStorefrontPaymentGatewayInput = z.infer<
  typeof updateStorefrontPaymentGatewayInputSchema
>;
export type StorefrontPaymentGatewayFormValues = z.input<
  typeof updateStorefrontPaymentGatewayInputSchema
>;
```

- **One provider and two modes.** `PAYMENT_GATEWAY_PROVIDERS` has only `sslcommerz`; a second gateway later adds a
  value here and a class in the API. Sandbox and live each have their own store id, password and address at
  SSLCommerz, so the mode is saved with them.
- **The store id is trimmed, the password is not.** A store id pasted from SSLCommerz's email often brings a space;
  a password may end in one, and trimming it would save a password that never works. The store id's pattern takes
  an empty string (`*`, not `+`) because Zod 4 runs every check: with `+`, an empty box would show "required" and
  "letters and digits" at once.
- **Two account selects** (decision 6). The money account must hold money (`moneyAccountIds`, the same rule as every
  money receipt), because SSLCommerz pays the tenant's bank later in one transfer, and until then the money is with
  SSLCommerz: an account like "SSLCommerz merchant balance" under the bank accounts. The fee account is an expense.
  The select's "Pick an account" sends `''`, which fails `z.uuid` with the account's own error, so the error says
  which account to pick. Whether the accounts really fit, only the API knows (27d.3).
- **Create and update are two schemas**, as for the shop's settings (decision 15). The first save must have a
  password; a later one keeps the saved password when the box is empty, which is how a write-only box works.

```ts

export const storefrontPaymentGatewaySchema = z.object({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
  storeId: z.string(),
  mode: z.enum(PAYMENT_GATEWAY_MODES),
  moneyAccountId: z.uuid(),
  feeAccountId: z.uuid(),
  // Both accounts still fit: the money account is active and holds money, the fee account is an
  // active expense account. Archiving one later makes this false, and then "Pay online" cannot be
  // ticked (storefront_online_not_ready) and the checkout stops offering it
  ready: z.boolean(),
  // The last "Test connection": when, and what went wrong (null: it worked). null: never tested.
  // Saving new values clears it, because it said something about the old ones
  lastTest: z
    .object({
      at: z.iso.datetime(),
      problem: z.enum(PAYMENT_GATEWAY_TEST_PROBLEMS).nullable(),
    })
    .nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontPaymentGateway = z.infer<typeof storefrontPaymentGatewaySchema>;

// An account the selects offer, "1150 · SSLCommerz merchant balance"
const accountChoiceSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
export type StorefrontAccountChoice = z.infer<typeof accountChoiceSchema>;

// The Payment card's one read: the saved account (null before the first save) and what the two
// selects offer. The choices come here, not from the accounts list, because storefront.manage does
// not read the chart of accounts (the same reason as 27b's deliveryChoices)
export const storefrontPaymentSetupSchema = z.object({
  gateway: storefrontPaymentGatewaySchema.nullable(),
  moneyAccounts: z.array(accountChoiceSchema),
  feeAccounts: z.array(accountChoiceSchema),
});
export type StorefrontPaymentSetup = z.infer<typeof storefrontPaymentSetupSchema>;

// All four need storefront.manage: whoever sets up the shop sets up where its money goes. There is
// no delete: unticking "Pay online" in the shop's settings stops new online payments, and the saved
// account is what settles the payments that are already on their way
export const storefrontPaymentRoutes = {
  getPaymentGateway: defineRoute({
    method: 'GET',
    path: '/storefront/payment-gateway',
    summary: "The shop's payment gateway account (never its password) and the account choices",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontPaymentSetupSchema,
  }),
  createPaymentGateway: defineRoute({
    method: 'POST',
    path: '/storefront/payment-gateway',
    summary: "Save the shop's payment gateway account the first time",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontPaymentGatewayInputSchema,
    response: storefrontPaymentGatewaySchema,
  }),
  updatePaymentGateway: defineRoute({
    method: 'PUT',
    path: '/storefront/payment-gateway',
    summary: "Change the shop's payment gateway account; an empty password keeps the saved one",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: updateStorefrontPaymentGatewayInputSchema,
    response: storefrontPaymentGatewaySchema,
  }),
  // No body: it tests what is saved, so the password never travels for a test. The answer is the
  // account with its new lastTest, a 200 whether the test worked or not (a refusal by the gateway
  // is an answer to show, not an error of this call)
  testPaymentGateway: defineRoute({
    method: 'POST',
    path: '/storefront/payment-gateway/test',
    summary: 'Ask the gateway whether it accepts the saved store id and password',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: storefrontPaymentGatewaySchema,
  }),
};
```

- **The saved gateway has no password field at all.** Not even a masked one: `z.object` drops unknown keys, so a
  server that sent one by mistake would still not reach a page (a test checks it).
- **`ready`** is worked out by the API: the gateway is saved and both accounts still fit. An account archived later
  makes it false, and then the checkout stops offering "Pay online" and the settings refuse to tick it
  (`storefront_online_not_ready`).
- **`lastTest`** says when "Test connection" last ran and what went wrong. Saving new values clears it (27d.3),
  because it described the old ones.
- **The account choices come with the read**, like 27b's `deliveryChoices`: `storefront.manage` does not read the
  chart of accounts.
- **Four routes, no delete** (decision 15). Unticking "Pay online" stops new payments, and the saved account is
  what settles the payments still on their way. The test has no body: it tests what is saved, so the password is
  sent once, when it is saved, and never again.

```diff
@@ -187,7 +187,9 @@ const settingsFieldsSchema = z.object({
     .max(STOREFRONT_ZONES_MAX, errorCode('too_long')),
   freeDeliveryFrom: optionalAmountSchema,
   minimumOrder: optionalAmountSchema,
-  // At least one way to pay, or no order can be placed. Ticked twice is once
+  // At least one way to pay, or no order can be placed. Ticked twice is once. Step 27d: `online`
+  // only once the payment gateway is saved with accounts that fit (storefront_online_not_ready);
+  // only the API knows that, so it checks
   paymentMethods: z
     .array(z.enum(SHOP_PAYMENT_METHODS))
     .min(1, errorCode('storefront_payment_required'))
```

Only a comment: whether `online` may be ticked depends on the saved gateway, which only the API can read.

### The order page's payment tries

```diff
@@ -14,6 +14,8 @@ import {
   SHOP_CART_MAX_QUANTITY,
   SHOP_ORDER_STATUSES,
   SHOP_PAYMENT_METHODS,
+  SHOP_PAYMENT_STATUSES,
+  SHOP_PAYMENT_TRIES,
 } from './storefront.js';
 
 // Step 27b: the ERP's side of the shop's orders. storefront.ts is what the shop's server sends and
@@ -109,6 +111,34 @@ export const storefrontOrderLineSchema = z.object({
 });
 export type StorefrontOrderLine = z.infer<typeof storefrontOrderLineSchema>;
 
+// Step 27d: one payment try of an online order, for the order page's Payments card. Every try is
+// listed, the ones that did not pay too: when a shopper says "I paid", the staff see each visit to
+// the gateway with its transaction id, which SSLCommerz's own panel searches by
+export const storefrontOrderPaymentSchema = z.object({
+  id: z.uuid(),
+  // Our id for the try, sent to the gateway as tran_id (shopPaymentTranIdSchema)
+  tranId: z.string(),
+  status: z.enum(SHOP_PAYMENT_STATUSES),
+  // The order's total when the try started: what the gateway was asked to take
+  amount: z.string(),
+  startedAt: z.iso.datetime(),
+  // When the gateway's answer was recorded (paid, failed or cancelled). null while started
+  settledAt: z.iso.datetime().nullable(),
+  // What the gateway said about a paid try: the way the shopper paid ("BKASH-BKash",
+  // "VISA-Dutch Bangla"), the bank's or wallet's own transaction number, and what the gateway pays
+  // out after its fee (the fee is amount − storeAmount). null until it is paid
+  cardType: z.string().nullable(),
+  bankTranId: z.string().nullable(),
+  storeAmount: z.string().nullable(),
+  // The money receipt a paid try made (decision 6: posted, an advance until the invoice takes it
+  // at Delivered). null before it is paid, or while it could not be made
+  receipt: documentRefSchema.nullable(),
+  // Why the receipt could not be made ("receipt_account_invalid": the money account was archived
+  // after the gateway was saved). The page shows it with "Make the receipt", which tries again
+  receiptError: z.enum(ERROR_CODES).nullable(),
+});
+export type StorefrontOrderPayment = z.infer<typeof storefrontOrderPaymentSchema>;
+
 export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
   address: z.string(),
   // When each step happened, oldest first, the shop's timeline's shape (shopOrderSchema.history).
@@ -132,6 +162,10 @@ export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
   // Why the sales order could not be made (decision 1): the error the sales order's own rules
   // gave ("sales_variant_archived"). The page shows it with "Make the sales order"
   documentError: z.enum(ERROR_CODES).nullable(),
+  // Step 27d: the payment tries, oldest first. Empty for a Cash on Delivery order that never tried
+  // to pay online. A paid online order has one paid try; two paid ones mean the shopper paid twice
+  // (a second tab), and the page says one of them is to be refunded
+  payments: z.array(storefrontOrderPaymentSchema).max(SHOP_PAYMENT_TRIES),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
 });
@@ -255,6 +289,7 @@ export type CancelStorefrontOrderFormValues = z.input<typeof cancelStorefrontOrd
 // Routes
 
 const idParamsSchema = z.object({ id: z.uuid() });
+const paymentParamsSchema = z.object({ id: z.uuid(), paymentId: z.uuid() });
 
 export const storefrontOrderRoutes = {
   listOrders: defineRoute({
@@ -342,6 +377,18 @@ export const storefrontOrderRoutes = {
     body: storefrontOrderVersionInputSchema,
     response: storefrontOrderSchema,
   }),
+  // Step 27d: "Make the receipt", after the receipt of a paid try could not be made
+  makePaymentReceipt: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/payments/:paymentId/receipt',
+    summary: 'Make the money receipt of a paid online payment again, after it failed',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: paymentParamsSchema,
+    body: storefrontOrderVersionInputSchema,
+    response: storefrontOrderSchema,
+  }),
   cancelOrder: defineRoute({
     method: 'POST',
     path: '/storefront/orders/:id/cancel',
```

- **Every try is listed**, the ones that did not pay too. When a shopper calls to say "I paid", the staff can read
  the transaction ids and look them up in SSLCommerz's own panel.
- **`amount` is the order's total when the try started**; `storeAmount` is what SSLCommerz pays out after its fee.
  The card shows the fee as their difference, which is also what the fee journal posts (decision 6).
- **`receipt` and `receiptError` per try** (decision 16). The receipt needs the customer that the sales order found
  or made (27b's decision 2), and an account archived since the gateway was saved makes it fail. A try is the unit
  that pays, so the error sits on it, and "Make the receipt" (`makePaymentReceipt`, `storefront.order.manage`) tries
  that one again. Two paid tries are possible (a second tab); the order page then says one of them is to be
  refunded.
- **`payments` has at most three**, the tries an order may have.

### The routes' type

```diff
@@ -23,6 +23,7 @@ import { storefrontRoutes } from './storefront-admin.js';
 import { storefrontAppearanceRoutes } from './storefront-appearance.js';
 import { storefrontCouponRoutes } from './storefront-coupons.js';
 import { storefrontOrderRoutes } from './storefront-orders.js';
+import { storefrontPaymentRoutes } from './storefront-payments.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
@@ -81,9 +82,99 @@ export const healthRoutes = {
   }),
 };
 
+// The type is written out, one `typeof` per group, because TypeScript would otherwise spell every
+// route's whole type into the declaration file, and since step 27d that is longer than it agrees
+// to write (TS7056). Each line names its group, so the declaration stays small and the type is the
+// same as the one TypeScript worked out. A new group needs its line here and in the object below:
+// leaving one out of either is a type error. Not an interface: the API and the OpenAPI writer take
+// `routes` as a Record of groups, and an interface fits a Record only with an index signature,
+// which would let `routes.storefrnt` type-check. Readonly, because nothing ever replaces a group
+type Routes = Readonly<{
+  health: typeof healthRoutes;
+  auth: typeof authRoutes;
+  me: typeof meRoutes;
+  members: typeof memberRoutes;
+  invitations: typeof invitationRoutes;
+  roles: typeof roleRoutes;
+  settings: typeof settingsRoutes;
+  branches: typeof branchRoutes;
+  numberSeries: typeof numberSeriesRoutes;
+  audit: typeof auditRoutes;
+  attachments: typeof attachmentRoutes;
+  setup: typeof setupRoutes;
+  notifications: typeof notificationRoutes;
+  accounts: typeof accountRoutes;
+  journal: typeof journalRoutes;
+  ledger: typeof ledgerRoutes;
+  openingBalances: typeof openingBalanceRoutes;
+  periodLock: typeof periodLockRoutes;
+  reports: typeof reportRoutes;
+  fiscalYears: typeof fiscalYearRoutes;
+  reportExports: typeof reportExportRoutes;
+  dashboard: typeof dashboardRoutes;
+  tradeReports: typeof tradeReportRoutes;
+  aging: typeof agingRoutes;
+  vatReport: typeof vatReportRoutes;
+  stockMovementReport: typeof stockMovementReportRoutes;
+  reportSchedules: typeof reportScheduleRoutes;
+  units: typeof unitRoutes;
+  productCategories: typeof productCategoryRoutes;
+  customFields: typeof customFieldRoutes;
+  products: typeof productRoutes;
+  productImports: typeof productImportRoutes;
+  warehouses: typeof warehouseRoutes;
+  stock: typeof stockRoutes;
+  stockAdjustments: typeof stockAdjustmentRoutes;
+  stockTransfers: typeof stockTransferRoutes;
+  stockRevaluations: typeof stockRevaluationRoutes;
+  stockAccounts: typeof stockAccountRoutes;
+  taxRates: typeof taxRateRoutes;
+  customers: typeof customerRoutes;
+  customerGroups: typeof customerGroupRoutes;
+  priceLists: typeof priceListRoutes;
+  salesPrices: typeof salesPriceRoutes;
+  quotations: typeof quotationRoutes;
+  salesOrders: typeof salesOrderRoutes;
+  deliveries: typeof deliveryRoutes;
+  invoices: typeof invoiceRoutes;
+  receipts: typeof receiptRoutes;
+  salesReturns: typeof salesReturnRoutes;
+  creditNotes: typeof creditNoteRoutes;
+  refunds: typeof refundRoutes;
+  salesAccounts: typeof salesAccountRoutes;
+  documentOutput: typeof documentOutputRoutes;
+  publicDocuments: typeof publicDocumentRoutes;
+  suppliers: typeof supplierRoutes;
+  supplierGroups: typeof supplierGroupRoutes;
+  approvalRules: typeof approvalRuleRoutes;
+  approvals: typeof approvalRoutes;
+  purchaseCosts: typeof purchaseCostRoutes;
+  requisitions: typeof requisitionRoutes;
+  requisitionLines: typeof requisitionLineRoutes;
+  purchaseOrders: typeof purchaseOrderRoutes;
+  goodsReceipts: typeof goodsReceiptRoutes;
+  bills: typeof billRoutes;
+  supplierPayments: typeof supplierPaymentRoutes;
+  purchaseAccounts: typeof purchaseAccountRoutes;
+  purchaseReturns: typeof purchaseReturnRoutes;
+  debitNotes: typeof debitNoteRoutes;
+  supplierRefunds: typeof supplierRefundRoutes;
+  sync: typeof syncRoutes;
+  devices: typeof deviceRoutes;
+  pos: typeof posRoutes;
+  posShifts: typeof posShiftRoutes;
+  posReturns: typeof posReturnRoutes;
+  publicStorefront: typeof publicStorefrontRoutes;
+  storefront: typeof storefrontRoutes;
+  storefrontAppearance: typeof storefrontAppearanceRoutes;
+  storefrontOrders: typeof storefrontOrderRoutes;
+  storefrontCoupons: typeof storefrontCouponRoutes;
+  storefrontPayments: typeof storefrontPaymentRoutes;
+}>;
+
 // API-র প্রতিটা endpoint এখানে। নতুন মডিউল = এখানে এক লাইন; API-র টেস্ট দেখে যে Nest-এর রুট আর
 // এই তালিকা হুবহু মেলে, আর OpenAPI স্পেক এই তালিকা থেকেই লেখা হয়
-export const routes = {
+export const routes: Routes = {
   health: healthRoutes,
   auth: authRoutes,
   me: meRoutes,
@@ -163,4 +254,5 @@ export const routes = {
   storefrontAppearance: storefrontAppearanceRoutes,
   storefrontOrders: storefrontOrderRoutes,
   storefrontCoupons: storefrontCouponRoutes,
+  storefrontPayments: storefrontPaymentRoutes,
 };
```

With the new routes, `tsc` stopped building the contracts with TS7056 ("The inferred type of this node exceeds the
maximum length the compiler will serialize"). Without a written type, TypeScript writes every route's whole type
into `routes.d.ts`; 27c left it just under the limit. The written `Routes` names each group by `typeof`, so the
declaration file is small again and the type is the same (decision 18):

- **A type alias, not an interface.** The API's contract test and its docs page take `routes` as a
  `Record<string, Record<string, RouteDef>>`. An interface fits a `Record` only with an index signature, and that
  would let `routes.storefrnt` type-check. The repo's lint rule asks for interfaces over plain object types, so the
  alias is `Readonly<{ … }>`, which is also true: no code replaces a group.
- **A group left out of either list is a type error:** the object must have every key of the type, and an object
  literal may not have one the type does not.

```diff
@@ -67,6 +67,7 @@ export * from './storefront-coupons.js';
 export * from './storefront-admin.js';
 export * from './storefront-appearance.js';
 export * from './storefront-orders.js';
+export * from './storefront-payments.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

### Error codes and audit actions

```diff
@@ -731,6 +731,24 @@ export const ERROR_CODES = [
   'storefront_coupon_dates',
   'storefront_coupon_up_to',
   'storefront_coupon_limit_format',
+  // Step 27d: paying online. In the shop: no online order waits for its payment in this browser
+  // (dropped after its hour, or the cookie is gone), all three tries of an order used, and "Try
+  // again" or "Pay on delivery" on an order that is paid already or moved to cash on delivery
+  'shop_payment_no_order',
+  'shop_payment_tries_used',
+  'shop_payment_settled',
+  // In the ERP's Payment card: a store id with other characters, the first save without a
+  // password, a money account that does not hold money (or is not this workspace's active one), a
+  // fee account that is not an active expense account, a second first save, a change or a test
+  // before the first save; and "Pay online" ticked in the shop's settings while the gateway is not
+  // saved or one of its accounts no longer fits
+  'storefront_gateway_store_id_format',
+  'storefront_gateway_password_required',
+  'storefront_gateway_money_account_invalid',
+  'storefront_gateway_fee_account_invalid',
+  'storefront_gateway_set_up_already',
+  'storefront_gateway_not_set_up',
+  'storefront_online_not_ready',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Three codes for the shop and seven for the ERP. `shop_payment_unavailable` (27a) already covers "the shop does not
take this method" for both Confirm Order and "Pay on delivery", so it is reused.

```diff
@@ -295,6 +295,13 @@ export const AUDIT_ACTIONS = [
   'storefront_coupon.updated',
   'storefront_coupon.archived',
   'storefront_coupon.restored',
+  // Step 27d: the shop's payment gateway account (entity = storefront_payment_gateway, entityId =
+  // the tenant's id: a workspace has one). The password is never in the changes, only that it
+  // changed. A payment writes nothing here: the money receipt it makes writes its own entry, with
+  // the order's number in its changes
+  'storefront_payment_gateway.created',
+  'storefront_payment_gateway.updated',
+  'storefront_payment_gateway.tested',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -360,6 +367,7 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront_collection',
   'storefront_order',
   'storefront_coupon',
+  'storefront_payment_gateway',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

One entity, `storefront_payment_gateway`, with the tenant's id as its id (a workspace has one gateway). `tested` is
an action too: a test changes what the card shows, and who tested a live store, and when, is worth keeping. A
payment writes nothing here; the money receipt it makes writes its own entry, as 27b's documents do.

```diff
@@ -6785,6 +6785,7 @@ export const en = {
       storefront_collection: 'Shop collections',
       storefront_order: 'Shop orders',
       storefront_coupon: 'Shop coupons',
+      storefront_payment_gateway: 'Shop payment gateway',
     },
     columns: {
       when: 'When',
@@ -7158,6 +7159,12 @@ export const en = {
         archived: 'Archived a shop coupon',
         restored: 'Gave an archived shop coupon back to the shop',
       },
+      // Step 27d
+      storefront_payment_gateway: {
+        created: 'Saved the shop’s payment gateway',
+        updated: 'Changed the shop’s payment gateway',
+        tested: 'Tested the shop’s payment gateway',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -7401,6 +7408,13 @@ export const en = {
       terms: 'Terms & Condition',
       about: 'About Us',
       contact: 'Contact Us',
+      // Step 27d: the shop's payment gateway. The password's change says only "changed"
+      storeId: 'Store ID',
+      mode: 'Sandbox or live',
+      moneyAccount: 'Account the money goes into',
+      feeAccount: 'Gateway fee account',
+      password: 'Password',
+      testResult: 'Test result',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -8334,6 +8348,22 @@ export const en = {
     storefront_coupon_up_to: 'Only a percent coupon has an “up to” amount. Leave it empty.',
     storefront_coupon_limit_format:
       'Type a whole number of orders from 1 to 1,000,000, or leave it empty for no limit.',
+    // Step 27d
+    shop_payment_no_order: 'No order is waiting for a payment. Place the order again.',
+    shop_payment_tries_used:
+      'This order has used its three tries to pay online. Pay on delivery, or place the order again.',
+    shop_payment_settled: 'This order is paid already, or it is now cash on delivery.',
+    storefront_gateway_store_id_format:
+      'Type the store ID as SSLCommerz sent it: letters and digits, with no spaces.',
+    storefront_gateway_password_required: 'Type the store password SSLCommerz sent you.',
+    storefront_gateway_money_account_invalid:
+      'Pick an active account that holds money, like a bank account for SSLCommerz.',
+    storefront_gateway_fee_account_invalid: 'Pick an active expense account for the gateway’s fee.',
+    storefront_gateway_set_up_already:
+      'The payment gateway is saved already. Reload the page to change it.',
+    storefront_gateway_not_set_up: 'Save the payment gateway first.',
+    storefront_online_not_ready:
+      'Save the payment gateway with its two accounts before you tick Pay online.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6275,6 +6275,7 @@ export const bn: Messages = {
       storefront_collection: 'শপের কালেকশন',
       storefront_order: 'শপের অর্ডার',
       storefront_coupon: 'শপের কুপন',
+      storefront_payment_gateway: 'শপের পেমেন্ট গেটওয়ে',
     },
     columns: {
       when: 'কখন',
@@ -6636,6 +6637,12 @@ export const bn: Messages = {
         archived: 'শপের কুপন আর্কাইভ করেছেন',
         restored: 'আর্কাইভ করা কুপন আবার শপে দিয়েছেন',
       },
+      // Step 27d
+      storefront_payment_gateway: {
+        created: 'শপের পেমেন্ট গেটওয়ে সেভ করেছেন',
+        updated: 'শপের পেমেন্ট গেটওয়ে বদলেছেন',
+        tested: 'শপের পেমেন্ট গেটওয়ে পরীক্ষা করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -6870,6 +6877,13 @@ export const bn: Messages = {
       terms: 'শর্তাবলি',
       about: 'আমাদের সম্পর্কে',
       contact: 'যোগাযোগ',
+      // Step 27d: the shop's payment gateway. The password's change says only "changed"
+      storeId: 'স্টোর আইডি',
+      mode: 'স্যান্ডবক্স না লাইভ',
+      moneyAccount: 'টাকা যে অ্যাকাউন্টে যায়',
+      feeAccount: 'গেটওয়ের ফি-এর অ্যাকাউন্ট',
+      password: 'পাসওয়ার্ড',
+      testResult: 'পরীক্ষার ফল',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -7756,6 +7770,22 @@ export const bn: Messages = {
     storefront_coupon_up_to: '“সর্বোচ্চ” শুধু শতাংশের কুপনে থাকে। ঘরটা ফাঁকা রাখুন।',
     storefront_coupon_limit_format:
       '১ থেকে ১০,০০,০০০-এর মধ্যে অর্ডারের একটা পূর্ণ সংখ্যা লিখুন, অথবা কোনো সীমা না চাইলে ফাঁকা রাখুন।',
+    // Step 27d
+    shop_payment_no_order: 'কোনো অর্ডার পেমেন্টের অপেক্ষায় নেই। আবার অর্ডার দিন।',
+    shop_payment_tries_used:
+      'এই অর্ডারে অনলাইনে পেমেন্টের তিনটা চেষ্টাই শেষ। ডেলিভারির সময় টাকা দিন, অথবা আবার অর্ডার দিন।',
+    shop_payment_settled: 'এই অর্ডারের পেমেন্ট হয়ে গেছে, অথবা এটা এখন ক্যাশ অন ডেলিভারি।',
+    storefront_gateway_store_id_format:
+      'SSLCommerz যেভাবে পাঠিয়েছে সেভাবে স্টোর আইডি লিখুন: অক্ষর আর অঙ্ক, কোনো স্পেস ছাড়া।',
+    storefront_gateway_password_required: 'SSLCommerz-এর পাঠানো স্টোর পাসওয়ার্ড লিখুন।',
+    storefront_gateway_money_account_invalid:
+      'টাকা রাখা হয় এমন একটা চালু অ্যাকাউন্ট বাছুন, যেমন SSLCommerz-এর জন্য একটা ব্যাংক অ্যাকাউন্ট।',
+    storefront_gateway_fee_account_invalid: 'গেটওয়ের ফি-এর জন্য একটা চালু খরচের অ্যাকাউন্ট বাছুন।',
+    storefront_gateway_set_up_already:
+      'পেমেন্ট গেটওয়ে আগেই সেভ করা আছে। বদলাতে পেজটা আবার লোড করুন।',
+    storefront_gateway_not_set_up: 'আগে পেমেন্ট গেটওয়ে সেভ করুন।',
+    storefront_online_not_ready:
+      'অনলাইনে পেমেন্টে টিক দেওয়ার আগে দুটো অ্যাকাউন্টসহ পেমেন্ট গেটওয়ে সেভ করুন।',
   },
   ui: {
     dataTable: {
```

The error words, the audit actions and the entity, and six field names for the audit log's changes. The password's
change is written as `changed`, never the value (27d.3). The words of the screens come in 27d.5.

### Tests

```diff
@@ -2,6 +2,16 @@ import { describe, expect, it } from 'vitest';
 
 import {
   addressKey,
+  fakeGatewayParamsSchema,
+  fakeValId,
+  readFakeValId,
+  SHOP_PAYMENT_NOTICE_PATH,
+  SHOP_PAYMENT_RETURN_PATH,
+  SHOP_PAYMENT_TRIES,
+  shopGatewayPostSchema,
+  shopPaymentSettleRequestSchema,
+  shopPaymentTranIdSchema,
+  shopPaymentWaitSchema,
   listingParamsFromQuery,
   maskPhone,
   publicOrderPlacedSchema,
@@ -378,6 +388,23 @@ describe('order placed', () => {
     });
     expect(parsed).not.toHaveProperty('token');
   });
+
+  // Step 27d
+  it('sends an online order to the payment page, or says it did not open', () => {
+    const pay = { next: 'pay', paymentUrl: 'https://sandbox.sslcommerz.com/EasyCheckOut/abc' };
+    expect(shopOrderPlacedSchema.parse(pay)).toEqual(pay);
+    expect(shopOrderPlacedSchema.parse({ next: 'pay', paymentUrl: null })).toEqual({
+      next: 'pay',
+      paymentUrl: null,
+    });
+    // The fake gateway's page in development is plain http on this computer
+    const fake = 'http://nirvor.localhost:4321/checkout/fake-gateway?tranId=A';
+    expect(shopOrderPlacedSchema.safeParse({ next: 'pay', paymentUrl: fake }).success).toBe(true);
+    // The shop puts it in `location`: a script address would run on the shop's page
+    expect(
+      shopOrderPlacedSchema.safeParse({ next: 'pay', paymentUrl: 'javascript:alert(1)' }).success,
+    ).toBe(false);
+  });
 });
 
 describe('phone code', () => {
@@ -718,7 +745,21 @@ describe("the shop server's order routes (step 27a.1)", () => {
         .map(([name]) => name)
         .sort();
     expect(byAuth('shop')).toEqual(
-      ['codeWait', 'order', 'placeOrder', 'resendCode', 'track', 'tracking', 'verifyCode'].sort(),
+      [
+        'codeWait',
+        'order',
+        'placeOrder',
+        'resendCode',
+        'track',
+        'tracking',
+        'verifyCode',
+        // Step 27d: a payment's answer from the gateway is the API's to check, and the other three
+        // answer with an order or change one
+        'settlePayment',
+        'paymentWait',
+        'retryPayment',
+        'payOnDelivery',
+      ].sort(),
     );
     expect(byAuth('public')).toEqual(
       [
@@ -783,6 +824,78 @@ describe("the shop server's order routes (step 27a.1)", () => {
   });
 });
 
+describe('paying online (step 27d.1)', () => {
+  const TRAN = 'K7Q2M4X9B1C3D5E6F8G0';
+  const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
+
+  it("takes the gateway's post by its two ids only, with an empty val_id as none", () => {
+    // What SSLCommerz posts: much more than the ids, all of it typed by whoever sent the post
+    const post = { tran_id: TRAN, val_id: '2611221045371uQe8kz1lO', status: 'VALID', amount: '1' };
+    expect(shopGatewayPostSchema.parse(post)).toEqual({
+      tran_id: TRAN,
+      val_id: '2611221045371uQe8kz1lO',
+    });
+    // A failed or cancelled payment has no val_id, or an empty one
+    expect(shopGatewayPostSchema.parse({ tran_id: TRAN, val_id: ' ' }).val_id).toBeNull();
+    expect(shopGatewayPostSchema.parse({ tran_id: TRAN }).val_id).toBeNull();
+    // A transaction id not in our shape names no try: refused before the API is asked
+    expect(shopGatewayPostSchema.safeParse({ tran_id: 'W-000123' }).success).toBe(false);
+    expect(shopPaymentTranIdSchema.safeParse(TRAN.toLowerCase()).success).toBe(false);
+  });
+
+  it("passes the ids on with the shop server's body", () => {
+    expect(shopPaymentSettleRequestSchema.parse({ tranId: TRAN, valId: null })).toEqual({
+      tranId: TRAN,
+      valId: null,
+    });
+    expect(shopPaymentSettleRequestSchema.safeParse({ tranId: TRAN }).success).toBe(false);
+  });
+
+  it('keeps the return and notice paths on the shop, apart from its pages', () => {
+    expect(SHOP_PAYMENT_RETURN_PATH).toBe('/checkout/pay/return');
+    expect(SHOP_PAYMENT_NOTICE_PATH.startsWith('/api/')).toBe(true);
+  });
+
+  it('draws the three states of /checkout/paid, with the tries it has left', () => {
+    const unpaid = {
+      state: 'unpaid',
+      problem: 'cancelled',
+      triesLeft: 2,
+      payOnDelivery: true,
+      total: '1199.0000',
+    };
+    expect(shopPaymentWaitSchema.parse(unpaid)).toEqual(unpaid);
+    expect(shopPaymentWaitSchema.parse({ state: 'checking' })).toEqual({ state: 'checking' });
+    const paid = { state: 'paid', orderNo: 'W-000124', phone: '01786120356', listingIds: ['l1'] };
+    expect(shopPaymentWaitSchema.parse(paid)).toEqual(paid);
+    // The first try is used before the page ever shows, so at most 2 are left
+    expect(
+      shopPaymentWaitSchema.safeParse({ ...unpaid, triesLeft: SHOP_PAYMENT_TRIES }).success,
+    ).toBe(false);
+    expect(shopPaymentWaitSchema.safeParse({ ...unpaid, problem: 'expired' }).success).toBe(false);
+  });
+
+  it("takes the cookie's token on the three payment routes, in a POST body", () => {
+    for (const name of ['paymentWait', 'retryPayment', 'payOnDelivery'] as const) {
+      const route = publicStorefrontRoutes[name];
+      expect(route.body.parse({ token: TOKEN })).toEqual({ token: TOKEN });
+      expect(route.body.safeParse({}).success).toBe(false);
+    }
+  });
+
+  it("reads back the fake gateway's val_id, and nothing else", () => {
+    const valId = fakeValId(TRAN, '1199.0000');
+    expect(readFakeValId(valId)).toEqual({ tranId: TRAN, amount: '1199.0000' });
+    // A real SSLCommerz val_id is not a fake one
+    expect(readFakeValId('2611221045371uQe8kz1lO')).toBeNull();
+    expect(readFakeValId(`FAKE_${TRAN}_12a`)).toBeNull();
+    expect(readFakeValId(`FAKE_${TRAN.slice(1)}_12`)).toBeNull();
+    expect(fakeGatewayParamsSchema.safeParse({ tranId: TRAN, amount: '1,199' }).success).toBe(
+      false,
+    );
+  });
+});
+
 describe('public API answers (step 26f.3)', () => {
   it('takes a photo from storage over https, a path, or plain http on this computer only', () => {
     const ok = (url: string) => shopImageSchema.safeParse({ url, alt: 'Neem face wash' }).success;
```

- 27a's list of shop-server routes has the four new ones: a test that forgot one would let a route with a token
  slip out from behind the shop's key.
- The `pay` answer with a page, with `null`, with the fake page on `http`, and refused with a `javascript:` address.
- The gateway's post read down to its two ids, an empty `val_id` as none, and a `tran_id` in another shape refused.
- `/checkout/paid`'s three states, `triesLeft` never 3, and an unknown problem refused.
- The three token routes take the token in the body, and the fake `val_id` reads back, but not a real one, a broken
  amount or a short id.

```ts
import { describe, expect, it } from 'vitest';

import {
  createStorefrontPaymentGatewayInputSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentRoutes,
  updateStorefrontPaymentGatewayInputSchema,
  type StorefrontPaymentGatewayFormValues,
} from './storefront-payments.js';

// The field paths and codes of a failed parse, the way the forms show them
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) {
    const key = issue.path.map(String).join('.');
    errors[key] = [...(errors[key] ?? []), issue.message];
  }
  return errors;
}

const MONEY = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const FEE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

// A sandbox store, as SSLCommerz's sign-up email sends it. FIRST is the first save, FORM a later one
const FIRST = {
  storeId: 'nirvo67412bc0d9f1e',
  password: 'nirvo67412bc0d9f1e@ssl',
  mode: 'sandbox',
  moneyAccountId: MONEY,
  feeAccountId: FEE,
} as const;
const FORM: StorefrontPaymentGatewayFormValues = { ...FIRST, version: 3 };

describe('the payment gateway form', () => {
  it('needs a password the first time, and keeps the saved one when the box is empty later', () => {
    expect(createStorefrontPaymentGatewayInputSchema.parse(FIRST)).toEqual(FIRST);
    expect(
      errorsOf(createStorefrontPaymentGatewayInputSchema.safeParse({ ...FIRST, password: '' })),
    ).toEqual({ password: ['storefront_gateway_password_required'] });
    expect(updateStorefrontPaymentGatewayInputSchema.parse({ ...FORM, password: '' })).toEqual({
      ...FORM,
      password: '',
    });
  });

  it('trims the store id but never the password', () => {
    const parsed = updateStorefrontPaymentGatewayInputSchema.parse({
      ...FORM,
      storeId: '  nirvo67412bc0d9f1e ',
      password: ' secret with spaces ',
    });
    expect(parsed.storeId).toBe('nirvo67412bc0d9f1e');
    expect(parsed.password).toBe(' secret with spaces ');
  });

  it('refuses a store id with other characters, and an empty one', () => {
    expect(
      errorsOf(updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, storeId: 'nir vo' })),
    ).toEqual({ storeId: ['storefront_gateway_store_id_format'] });
    expect(
      errorsOf(updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, storeId: ' ' })),
    ).toEqual({ storeId: ['required'] });
  });

  it("says which account to pick when a select is left on 'Pick an account'", () => {
    expect(
      errorsOf(
        updateStorefrontPaymentGatewayInputSchema.safeParse({
          ...FORM,
          moneyAccountId: '',
          feeAccountId: '',
        }),
      ),
    ).toEqual({
      moneyAccountId: ['storefront_gateway_money_account_invalid'],
      feeAccountId: ['storefront_gateway_fee_account_invalid'],
    });
  });

  it('takes sandbox or live only, and a later save needs its version', () => {
    expect(
      updateStorefrontPaymentGatewayInputSchema.safeParse({ ...FORM, mode: 'test' }).success,
    ).toBe(false);
    expect(updateStorefrontPaymentGatewayInputSchema.safeParse(FIRST).success).toBe(false);
  });
});

describe('the saved gateway', () => {
  it('never has a password field', () => {
    expect(Object.keys(storefrontPaymentGatewaySchema.shape)).not.toContain('password');
    const parsed = storefrontPaymentGatewaySchema.parse({
      provider: 'sslcommerz',
      storeId: 'nirvo67412bc0d9f1e',
      mode: 'live',
      moneyAccountId: MONEY,
      feeAccountId: FEE,
      ready: true,
      lastTest: { at: '2026-11-22T04:00:00.000Z', problem: null },
      version: 4,
      updatedAt: '2026-11-22T04:00:00.000Z',
      // A server that sent one by mistake: the parse drops it, so no page ever shows it
      password: 'leaked',
    });
    expect(parsed).not.toHaveProperty('password');
  });
});

describe('the routes', () => {
  it('all need storefront.manage, under /storefront/payment-gateway', () => {
    for (const route of Object.values(storefrontPaymentRoutes)) {
      expect(route.auth).toBe('bearer');
      expect(route.permission).toBe('storefront.manage');
      expect(route.path.startsWith('/storefront/payment-gateway')).toBe(true);
    }
  });

  it('tests what is saved, so the test sends no password', () => {
    expect('body' in storefrontPaymentRoutes.testPaymentGateway).toBe(false);
  });
});
```

The form: the first save needs a password and a later one keeps it, the store id trimmed and the password not, the
store id's two errors one at a time, both account errors at once, the mode and the version. The saved gateway drops
a password a server sent by mistake. Every route is `storefront.manage`, and the test has no body.

```diff
@@ -5,6 +5,7 @@ import {
   cancelStorefrontOrderInputSchema,
   packStorefrontOrderInputSchema,
   STOREFRONT_ORDER_STATUSES,
+  storefrontOrderPaymentSchema,
   storefrontOrderQuerySchema,
   storefrontOrderRoutes,
   type PackStorefrontOrderFormValues,
@@ -124,6 +125,35 @@ describe('Cancel', () => {
   });
 });
 
+// Step 27d
+describe('a payment try', () => {
+  const PAID = {
+    id: '9f2e3d4c-5b6a-4798-8a1b-2c3d4e5f6a7b',
+    tranId: 'K7Q2M4X9B1C3D5E6F8G0',
+    status: 'paid',
+    amount: '1199.0000',
+    startedAt: '2026-11-22T04:10:00.000Z',
+    settledAt: '2026-11-22T04:12:30.000Z',
+    cardType: 'BKASH-BKash',
+    bankTranId: '2611220412BK7XQ2M4',
+    storeAmount: '1169.0300',
+    receipt: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', number: 'MR-2026-27-0042' },
+    receiptError: null,
+  };
+
+  it("keeps the gateway's answer and the receipt it made", () => {
+    expect(storefrontOrderPaymentSchema.parse(PAID)).toEqual(PAID);
+  });
+
+  it('says why the receipt could not be made, with an error code', () => {
+    const failed = { ...PAID, receipt: null, receiptError: 'receipt_account_invalid' };
+    expect(storefrontOrderPaymentSchema.parse(failed).receiptError).toBe('receipt_account_invalid');
+    expect(
+      storefrontOrderPaymentSchema.safeParse({ ...failed, receiptError: 'no such code' }).success,
+    ).toBe(false);
+  });
+});
+
 describe('the routes', () => {
   const routes = Object.values(storefrontOrderRoutes);
 
```

A paid try with its receipt, and a receipt error that must be a known code. The new route's permission is covered by
27b's test of every route (a POST needs `storefront.order.manage`).

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/contracts test        # 667 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
```

Three things fail until later parts, on purpose:

- `pnpm --filter @omnivo/api typecheck`: the order view (`storefront-orders.service.ts`) has no `payments` yet
  (27d.3). `apps/api/src/contract.spec.ts` also fails: the contract has 9 routes the API does not serve yet.
- `pnpm --filter @omnivo/app typecheck`: the mock order (`mocks/storefront-order-data.ts`) has no `payments` (27d.7).
- `pnpm --filter @omnivo/shop typecheck`: three places treat every answer that is not `verify` as `confirmed`
  (`islands/checkout/CheckoutForm.tsx` and `server/orders.ts`). The type system now makes them handle `pay` (27d.7).

Broken on purpose while this part was written, each caught:

- `shopPaymentUrlSchema` as a plain `z.url()`: "sends an online order to the payment page, or says it did not open"
  fails on the `javascript:` address.
- `readFakeValId` without the `$` at the end of its pattern: "reads back the fake gateway's val_id, and nothing
  else" fails on `FAKE_…_12a`.

## 27d.2 — Database

Two new tables: `storefront_payment_gateways` (the shop's SSLCommerz account) and `storefront_payments` (one row
for each visit to the gateway's page). The order's pending rule changes too, because an online order waits for
its payment, not for a phone code. Two migrations, as in 27a and 27c: drizzle-kit writes the tables, the keys and
the checks (0075); a hand-written one gives the tables their tenant rules, lets the shop's order routes record a
try, answers "can the shop take online payment now?" without showing the account, and keeps a paid try for good
(0076).

Mine, made while writing this part:

19. **The password is sealed by the API, never by the database.** One `bytea` holds the nonce, the tag and the
    ciphertext of AES-256-GCM, with the number of the key that sealed it. Postgres never sees the password or
    `CREDENTIALS_KEY`, so a database dump, a backup or a slow-query log gives neither. `pgcrypto` (19b) would have
    put the key into SQL statements.
20. **A try keeps the gateway and the mode it was started with.** The API asks about a try at the address it was
    started at (sandbox or live), even if the tenant switches the mode while a shopper is paying.
21. **The try's number is the database's count of an order's tries.** `try_no` is 1 to 3, and unique per order:
    two "Try again" presses at the same moment both ask for try 2, and the second one fails on the key. No
    trigger and no lock are needed for "three at most".
22. **One function says whether online payment is ready** (`storefront_online_ready()`), for the checkout and for
    the Payment card's `ready`. The two then never disagree, and the shop, which may not read the account or the
    chart of accounts, still gets the answer.
23. **The two tables check their values against the contracts' lists** (status, gateway, mode, test problem).
    The repo's other tables leave that to TypeScript; here the mode picks the gateway's address and the status
    decides what counts as paid, so a value nobody knows must not get in.
24. **A paid try is kept by the database**: its answer never changes, it is never deleted, and so a pending order
    with a paid try cannot be deleted either (decision 5).
25. **An order's payment method changes only while it is pending.** "Pay on delivery" and a late payment change
    it; after the confirm it is what the rider goes by.
26. **The `storefront.payment_paid` outbox event comes in 27d.3**, with its payload, its handler and its queue. The
    event list is in `packages/db`, but the API's three maps of events are exhaustive (`Record<OutboxEventType, …>`),
    so the type alone would stop the API from type-checking.

### The gateway account

```ts
import {
  PAYMENT_GATEWAY_MODES,
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_GATEWAY_TEST_PROBLEMS,
  SHOP_PAYMENT_STATUSES,
  SHOP_PAYMENT_TRIES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { receipts } from './receipts.js';
import { storefrontOrders } from './storefront-orders.js';
import { tenants } from './tenants.js';

// Step 27d: online payment. The shop's own gateway account, and one row for every visit a shopper
// makes to the gateway's page. The money goes to the tenant's SSLCommerz account; Omnivo keeps the
// keys and makes the calls (system design §14). Migration 0076 gives both tables their rules.

// Raw bytes, as in sync.ts: drizzle 0.45 has no bytea column, and the postgres driver reads and
// writes one as a Buffer
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// A list from the contracts as SQL ('started', 'not_opened', …). Written by code only, never by a
// person, so sql.raw is safe here
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

// AES-256-GCM's nonce and tag are 12 and 16 bytes; the password is at most 128 characters
// (createStorefrontPaymentGatewayInputSchema), at most 512 bytes in UTF-8
const SEALED_MIN_BYTES = 12 + 16 + 1;
const SEALED_MAX_BYTES = 12 + 16 + 512;

// The workspace's gateway account (decision 4). One row per workspace, so the tenant's id is the
// key: the Payment card has nothing to pick between, and the audit log names it by the tenant's id
// (27d.1). Only omnivo_app reads it (0076 grants the shop's roles nothing): the shop's server never
// holds the password, not even encrypted
export const storefrontPaymentGateways = pgTable(
  'storefront_payment_gateways',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    provider: text('provider', { enum: PAYMENT_GATEWAY_PROVIDERS }).notNull(),
    storeId: text('store_id').notNull(),
    mode: text('mode', { enum: PAYMENT_GATEWAY_MODES }).notNull(),
    // The store password, sealed by the API with AES-256-GCM under CREDENTIALS_KEY: the nonce, the
    // tag and the ciphertext in one value (27d.3). The database never sees the password or the key,
    // so a leaked dump or backup gives neither
    passwordSealed: bytea('password_sealed').notNull(),
    // Which CREDENTIALS_KEY sealed it. A new key gets the next number; the API opens a row with
    // the key of its number, so the keys can be changed one row at a time
    keyVersion: smallint('key_version').notNull(),
    // Where a paid order's money receipt goes, and where the gateway's fee is posted (decision 6).
    // Whether they still fit (not archived, holds money, an expense) is storefront_online_ready()
    // in 0076, because an account can be archived after the gateway was saved
    moneyAccountId: uuid('money_account_id').notNull(),
    feeAccountId: uuid('fee_account_id').notNull(),
    // The last "Test connection": when, and what went wrong (NULL: it worked). Both NULL: never
    // tested. Saving new values empties both (27d.1's lastTest)
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestProblem: text('last_test_problem', { enum: PAYMENT_GATEWAY_TEST_PROBLEMS }),
  },
  (table) => [
    // Accounts of this workspace. No ON DELETE: an account is deleted for real only when nothing
    // uses it, and the gateway uses these two
    foreignKey({
      name: 'storefront_payment_gateways_money_account_fk',
      columns: [table.tenantId, table.moneyAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payment_gateways_fee_account_fk',
      columns: [table.tenantId, table.feeAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // drizzle's enum is a TypeScript type only. Here the database says it too: the mode picks the
    // gateway's address, so an unknown one must not be saved (mine 23)
    check(
      'storefront_payment_gateways_values_check',
      sql`${table.provider} IN (${sqlList(PAYMENT_GATEWAY_PROVIDERS)})
        AND ${table.mode} IN (${sqlList(PAYMENT_GATEWAY_MODES)})
        AND (${table.lastTestProblem} IS NULL OR ${table.lastTestProblem} IN (${sqlList(PAYMENT_GATEWAY_TEST_PROBLEMS)}))`,
    ),
    // The form's store id rule (27d.1), after its trim
    check(
      'storefront_payment_gateways_store_id_check',
      sql`${table.storeId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    // Something the API sealed: at least a nonce, a tag and one byte. A row with an empty value
    // would look saved and never work
    check(
      'storefront_payment_gateways_sealed_check',
      sql`octet_length(${table.passwordSealed}) BETWEEN ${sql.raw(String(SEALED_MIN_BYTES))} AND ${sql.raw(String(SEALED_MAX_BYTES))}
        AND ${table.keyVersion} >= 1`,
    ),
    // The money and its fee in one account would post the fee against itself: the money account's
    // balance would no longer be what SSLCommerz owes
    check(
      'storefront_payment_gateways_accounts_check',
      sql`${table.moneyAccountId} <> ${table.feeAccountId}`,
    ),
    check(
      'storefront_payment_gateways_test_check',
      sql`${table.lastTestProblem} IS NULL OR ${table.lastTestedAt} IS NOT NULL`,
    ),
  ],
);
```

- **`bytea` is defined again here**, as `sync.ts` does for the device key. Drizzle 0.45 has no `bytea` column; the
  postgres driver reads and writes one as a `Buffer`, so 27d.3's crypto works on bytes with no base64 step.
- **`sqlList()`** turns a contracts list into `'started', 'not_opened', …` for a check. `sql.raw` puts the text
  into the SQL as it is, which is safe only because the values come from code, never from a person.
- **The key is the tenant's id.** A workspace has one gateway account, so the Payment card has nothing to pick, and
  the audit log names it by the tenant's id (27d.1). The second insert for a workspace fails on the primary key.
- **No id, no `created_by`, no `deleted_at`.** There is no delete (27d.1: unticking "Pay online" stops new payments,
  and the saved account still settles the ones on their way), and the audit log says who saved it.
- **`password_sealed` and `key_version`** (mine 19). The check asks for at least 29 bytes (12 for the nonce, 16 for
  the tag, 1 for the shortest password) and at most 540 (a 128-character password is at most 512 bytes in UTF-8).
  An empty value would look saved and never work. `key_version` starts at 1; a new `CREDENTIALS_KEY` gets the next
  number, and the API opens each row with the key of its number, so the keys can be changed one row at a time.
- **The two accounts** are foreign keys into this workspace's chart (`tenant_id` in both), with no `ON DELETE`: an
  account is deleted for real only when nothing uses it, and the gateway uses these two. Whether they still fit
  (not archived, holds money, an expense) is not a foreign key's job, because an account can be archived after the
  gateway was saved: `storefront_online_ready()` reads it each time (0076). The money and the fee in one account
  is refused: the fee would be posted against the money itself, and the account's balance would no longer be what
  SSLCommerz owes.
- **`last_tested_at` and `last_test_problem`**: a problem needs a time. Both empty means "never tested".
- **`storefront_payment_gateways_values_check`** (mine 23). Drizzle's `text(…, { enum })` is a TypeScript type only;
  the database would take `mode = 'test'`. The check writes the contracts' lists into SQL.

### The payment tries

```ts
// One payment try (decision 1): placing an online order makes the first, "Try again" the next,
// at most SHOP_PAYMENT_TRIES per order. The shop's server writes it as omnivo_shop (the try and
// the gateway's answer); the worker adds the money receipt as omnivo_app. A paid try is never
// deleted and its answer never changes (0076's guard): it is the record that money came
export const storefrontPayments = pgTable(
  'storefront_payments',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    // 1 to SHOP_PAYMENT_TRIES, in the order the tries were made. With the unique key below it is
    // the database's count of an order's tries (mine 21)
    tryNo: smallint('try_no').notNull(),
    // Our id for the try, sent to the gateway as tran_id (shopPaymentTranIdSchema)
    tranId: text('tran_id').notNull(),
    // The gateway and the mode the try was started with. The answer is asked at the same address
    // (sandbox or live), even if the tenant switches the mode while the shopper is paying (mine 20)
    provider: text('provider', { enum: PAYMENT_GATEWAY_PROVIDERS }).notNull(),
    mode: text('mode', { enum: PAYMENT_GATEWAY_MODES }).notNull(),
    status: text('status', { enum: SHOP_PAYMENT_STATUSES }).notNull().default('started'),
    // The order's total when the try started: what the gateway was asked to take, and what its
    // answer must say (decision 2)
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    // When the gateway's answer was recorded (paid, failed or cancelled)
    settledAt: timestamp('settled_at', { withTimezone: true }),
    // From the gateway's own answer, never from the post (27d.1's shopGatewayPostSchema), and only
    // on a paid try: the validation id, the way the shopper paid ("BKASH-BKash"), the bank's or
    // wallet's transaction number, and what the gateway pays out after its fee
    valId: text('val_id'),
    cardType: text('card_type'),
    bankTranId: text('bank_tran_id'),
    storeAmount: numeric('store_amount', { precision: 19, scale: 4 }),
    // The posted money receipt the worker made for a paid try (decision 6), or why it could not
    // (an error code, like an order's document_error). Neither while the worker has not run
    receiptId: uuid('receipt_id'),
    receiptError: text('receipt_error'),
  },
  (table) => [
    // An order's tries, oldest first (the order page's Payments card and /checkout/paid), and at
    // most one try of each number: two "Try again" at the same moment both ask for try 2, and the
    // second fails here. A constraint, so the API answers by its name
    unique('storefront_payments_try_key').on(table.tenantId, table.orderId, table.tryNo),
    // The gateway's calls name the try by its tran_id: settle looks it up here, in the workspace
    // the shop's host names. Random, so it never collides; unique all the same, so a bug that
    // gave two tries one id fails here instead of paying both with one payment
    uniqueIndex('storefront_payments_tran_id_idx').on(table.tenantId, table.tranId),
    // One validation is one payment: a val_id that paid one try cannot pay a second
    uniqueIndex('storefront_payments_val_id_idx')
      .on(table.tenantId, table.valId)
      .where(sql`${table.valId} IS NOT NULL`),
    // One receipt, one payment: a worker that ran twice cannot link a second payment's receipt
    uniqueIndex('storefront_payments_receipt_idx')
      .on(table.tenantId, table.receiptId)
      .where(sql`${table.receiptId} IS NOT NULL`),
    // A pending order's tries go with it (the sweep, five wrong codes after "Pay on delivery").
    // Never a paid one: 0076's guard refuses that delete, and so the order's delete too
    foreignKey({
      name: 'storefront_payments_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_payments_receipt_fk',
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.id],
    }),
    // The contracts' lists, for the gateway's reason above. The status most of all: the guard in
    // 0076 and the checks below read 'paid' and 'started', and a status nobody knows would pass
    // them all
    check(
      'storefront_payments_values_check',
      sql`${table.status} IN (${sqlList(SHOP_PAYMENT_STATUSES)})
        AND ${table.provider} IN (${sqlList(PAYMENT_GATEWAY_PROVIDERS)})
        AND ${table.mode} IN (${sqlList(PAYMENT_GATEWAY_MODES)})`,
    ),
    check(
      'storefront_payments_try_no_check',
      sql`${table.tryNo} BETWEEN 1 AND ${sql.raw(String(SHOP_PAYMENT_TRIES))}`,
    ),
    check('storefront_payments_tran_id_check', sql`${table.tranId} ~ '^[A-Z0-9]{20}$'`),
    // To the paisa, like every amount the books post: the API rounds the gateway's store_amount
    // before it writes it (27d.3). The fee (amount − store_amount) is then never below zero
    check(
      'storefront_payments_amounts_check',
      sql`${table.amount} > 0 AND ${table.amount} = round(${table.amount}, 2)
        AND (${table.storeAmount} IS NULL OR (${table.storeAmount} >= 0
          AND ${table.storeAmount} <= ${table.amount}
          AND ${table.storeAmount} = round(${table.storeAmount}, 2)))`,
    ),
    // Each status with its columns, exactly. Started and not_opened have no answer yet; failed and
    // cancelled have an answer and no money; paid has the validation and the payout. The receipt
    // and its error belong to a paid try, never both
    check(
      'storefront_payments_status_check',
      sql`(${table.status} IN ('started', 'not_opened')) = (${table.settledAt} IS NULL)
        AND (${table.status} = 'paid') = (${table.valId} IS NOT NULL AND ${table.storeAmount} IS NOT NULL)
        AND (${table.status} = 'paid' OR num_nonnulls(${table.valId}, ${table.storeAmount}, ${table.cardType}, ${table.bankTranId}, ${table.receiptId}, ${table.receiptError}) = 0)
        AND num_nonnulls(${table.receiptId}, ${table.receiptError}) <= 1`,
    ),
    // The gateway's words, short enough for a page: the API cuts a longer one before it writes
    // it (27d.3), so a payment is never left unrecorded for a long card name
    check(
      'storefront_payments_text_check',
      sql`(${table.valId} IS NULL OR char_length(${table.valId}) BETWEEN 1 AND 64)
        AND (${table.cardType} IS NULL OR char_length(${table.cardType}) BETWEEN 1 AND 100)
        AND (${table.bankTranId} IS NULL OR char_length(${table.bankTranId}) BETWEEN 1 AND 100)`,
    ),
    // An error code in snake_case, never a message, for storefront_orders_document_error_check's
    // reason
    check(
      'storefront_payments_receipt_error_check',
      sql`${table.receiptError} IS NULL OR ${table.receiptError} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  ],
);
```

- **The columns are the contract's `storefrontOrderPaymentSchema` (27d.1)**, plus `try_no`, `provider`, `mode` and
  `val_id`, which the API needs and the page does not show. `started_at` is the row's creation time; there is no
  `updated_at` or `version`, because no form edits a try: the shop's server and the worker write it.
- **`storefront_payments_try_key` (`tenant_id`, `order_id`, `try_no`)** does two jobs (mine 21): it is the order
  page's and `/checkout/paid`'s read, oldest try first, and it stops a fourth try or a second "try 2". It is a
  constraint, so 27d.3 can answer by its name.
- **`tran_id` is unique per workspace**, like every other key in the repo. SSLCommerz asks for a unique `tran_id`
  per store, and each workspace has its own store. The id is random (27d.1), so two never meet; the index makes a
  bug that gave two tries one id fail at once instead of paying both with one payment. Settle finds the try by this
  index, in the workspace the shop's host names (no function across workspaces is needed).
- **A `val_id` pays one try only** (a partial unique index), and **a receipt belongs to one payment** (another): a
  worker that ran twice cannot link one receipt to two payments.
- **The order's foreign key has `ON DELETE CASCADE`**, like its lines and holds: the worker's sweep and five wrong
  codes (after "Pay on delivery") drop a pending order with its tries. A paid try stops that delete (0076).
- **`storefront_payments_amounts_check`**: every amount to the paisa, and the payout (`store_amount`) between 0 and
  the amount, so the fee (`amount − store_amount`) is never below zero. SSLCommerz's answer is a string; 27d.3 rounds
  it to the paisa before it writes it, so the check never leaves a real payment unrecorded.
- **`storefront_payments_status_check`** gives each status exactly its columns, in three lines:
  - started and not_opened have no answer yet (`settled_at` is NULL); every other status has one;
  - paid ⇔ the validation id and the payout are there;
  - a try that is not paid has none of the gateway's details and no receipt. The receipt and its error never both.
- **`storefront_payments_text_check`**: the gateway's words are short enough for a page. 27d.3 cuts a longer card
  name before it writes it, for the same reason as the rounding.
- **`storefront_payments_receipt_error_check`**: an error code, never an exception's message, for 27b's
  `document_error` reason: the page shows it with `t('errors.…')`.

### The order's pending rule

```diff
@@ -170,13 +170,16 @@ export const storefrontOrders = pgTable(
         AND (${table.trackingTokenHash} IS NULL OR ${table.trackingTokenHash} ~ '${sql.raw(HASH_PATTERN)}')
         AND (${table.codeHash} IS NULL OR ${table.codeHash} ~ '${sql.raw(HASH_PATTERN)}')`,
     ),
-    // Two exact cases. Pending: every code column, and no number, no tracking token, no
-    // confirmed_at. Anything after it: the other way round. So a confirmed order can never still
-    // answer a code, and a pending one can never be tracked
+    // Two exact cases. Pending: no number, no tracking token, no confirmed_at, and every code
+    // column when it waits for its phone code (Cash on Delivery), none when it waits for its
+    // payment (step 27d: an online order skips the code). Anything after it: no code column and
+    // all three of the others. So a confirmed order can never still answer a code, and a pending
+    // one can never be tracked
     check(
       'storefront_orders_pending_check',
       sql`(${table.status} = 'pending'
-          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 5
+          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft})
+            = CASE ${table.paymentMethod} WHEN 'cod' THEN 5 ELSE 0 END
           AND num_nonnulls(${table.orderNo}, ${table.trackingTokenHash}, ${table.confirmedAt}) = 0)
         OR (${table.status} <> 'pending'
           AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 0
```

27a's rule said a pending order has all five code columns. An online order skips the phone code (27c's decision
8), so while it waits for its payment it has none of them. The rule now asks for five with Cash on Delivery and none
with online, and the rest is unchanged: no number, no tracking token and no `confirmed_at` while pending, and the
other way round after. "Pay on delivery" (decision 3) is then one `UPDATE` that sets the method and the five code
columns together; setting only one of them fails here. No order breaks when the migration adds the new check: 27a's
API refuses an online order, so every pending order in a database is a Cash on Delivery one with its code.

```diff
@@ -55,3 +55,4 @@ export * from './report-schedules.js';
 export * from './storefront.js';
 export * from './storefront-orders.js';
 export * from './storefront-coupons.js';
+export * from './storefront-payments.js';
```

### The tables' migration

```sql
CREATE TABLE "storefront_payment_gateways" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"store_id" text NOT NULL,
	"mode" text NOT NULL,
	"password_sealed" "bytea" NOT NULL,
	"key_version" smallint NOT NULL,
	"money_account_id" uuid NOT NULL,
	"fee_account_id" uuid NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_problem" text,
	CONSTRAINT "storefront_payment_gateways_values_check" CHECK ("storefront_payment_gateways"."provider" IN ('sslcommerz')
        AND "storefront_payment_gateways"."mode" IN ('sandbox', 'live')
        AND ("storefront_payment_gateways"."last_test_problem" IS NULL OR "storefront_payment_gateways"."last_test_problem" IN ('rejected', 'unreachable'))),
	CONSTRAINT "storefront_payment_gateways_store_id_check" CHECK ("storefront_payment_gateways"."store_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "storefront_payment_gateways_sealed_check" CHECK (octet_length("storefront_payment_gateways"."password_sealed") BETWEEN 29 AND 540
        AND "storefront_payment_gateways"."key_version" >= 1),
	CONSTRAINT "storefront_payment_gateways_accounts_check" CHECK ("storefront_payment_gateways"."money_account_id" <> "storefront_payment_gateways"."fee_account_id"),
	CONSTRAINT "storefront_payment_gateways_test_check" CHECK ("storefront_payment_gateways"."last_test_problem" IS NULL OR "storefront_payment_gateways"."last_tested_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "storefront_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"try_no" smallint NOT NULL,
	"tran_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"val_id" text,
	"card_type" text,
	"bank_tran_id" text,
	"store_amount" numeric(19, 4),
	"receipt_id" uuid,
	"receipt_error" text,
	CONSTRAINT "storefront_payments_try_key" UNIQUE("tenant_id","order_id","try_no"),
	CONSTRAINT "storefront_payments_values_check" CHECK ("storefront_payments"."status" IN ('started', 'not_opened', 'paid', 'failed', 'cancelled')
        AND "storefront_payments"."provider" IN ('sslcommerz')
        AND "storefront_payments"."mode" IN ('sandbox', 'live')),
	CONSTRAINT "storefront_payments_try_no_check" CHECK ("storefront_payments"."try_no" BETWEEN 1 AND 3),
	CONSTRAINT "storefront_payments_tran_id_check" CHECK ("storefront_payments"."tran_id" ~ '^[A-Z0-9]{20}$'),
	CONSTRAINT "storefront_payments_amounts_check" CHECK ("storefront_payments"."amount" > 0 AND "storefront_payments"."amount" = round("storefront_payments"."amount", 2)
        AND ("storefront_payments"."store_amount" IS NULL OR ("storefront_payments"."store_amount" >= 0
          AND "storefront_payments"."store_amount" <= "storefront_payments"."amount"
          AND "storefront_payments"."store_amount" = round("storefront_payments"."store_amount", 2)))),
	CONSTRAINT "storefront_payments_status_check" CHECK (("storefront_payments"."status" IN ('started', 'not_opened')) = ("storefront_payments"."settled_at" IS NULL)
        AND ("storefront_payments"."status" = 'paid') = ("storefront_payments"."val_id" IS NOT NULL AND "storefront_payments"."store_amount" IS NOT NULL)
        AND ("storefront_payments"."status" = 'paid' OR num_nonnulls("storefront_payments"."val_id", "storefront_payments"."store_amount", "storefront_payments"."card_type", "storefront_payments"."bank_tran_id", "storefront_payments"."receipt_id", "storefront_payments"."receipt_error") = 0)
        AND num_nonnulls("storefront_payments"."receipt_id", "storefront_payments"."receipt_error") <= 1),
	CONSTRAINT "storefront_payments_text_check" CHECK (("storefront_payments"."val_id" IS NULL OR char_length("storefront_payments"."val_id") BETWEEN 1 AND 64)
        AND ("storefront_payments"."card_type" IS NULL OR char_length("storefront_payments"."card_type") BETWEEN 1 AND 100)
        AND ("storefront_payments"."bank_tran_id" IS NULL OR char_length("storefront_payments"."bank_tran_id") BETWEEN 1 AND 100)),
	CONSTRAINT "storefront_payments_receipt_error_check" CHECK ("storefront_payments"."receipt_error" IS NULL OR "storefront_payments"."receipt_error" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "storefront_orders" DROP CONSTRAINT "storefront_orders_pending_check";--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_money_account_fk" FOREIGN KEY ("tenant_id","money_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payment_gateways" ADD CONSTRAINT "storefront_payment_gateways_fee_account_fk" FOREIGN KEY ("tenant_id","fee_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payments" ADD CONSTRAINT "storefront_payments_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_tran_id_idx" ON "storefront_payments" USING btree ("tenant_id","tran_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_val_id_idx" ON "storefront_payments" USING btree ("tenant_id","val_id") WHERE "storefront_payments"."val_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_payments_receipt_idx" ON "storefront_payments" USING btree ("tenant_id","receipt_id") WHERE "storefront_payments"."receipt_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_pending_check" CHECK (("storefront_orders"."status" = 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left")
            = CASE "storefront_orders"."payment_method" WHEN 'cod' THEN 5 ELSE 0 END
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 0)
        OR ("storefront_orders"."status" <> 'pending'
          AND num_nonnulls("storefront_orders"."code_hash", "storefront_orders"."code_expires_at", "storefront_orders"."code_sent_at", "storefront_orders"."code_sends", "storefront_orders"."code_tries_left") = 0
          AND num_nonnulls("storefront_orders"."order_no", "storefront_orders"."tracking_token_hash", "storefront_orders"."confirmed_at") = 3));
```

Made by drizzle-kit from the schema files:

```bash
pnpm --filter @omnivo/db generate --name storefront-payments
```

It also writes `meta/0075_snapshot.json` and a line in `meta/_journal.json`; both are drizzle-kit's own and not
shown. The order's rule is dropped and added again (Postgres cannot change a check in place).

### The rules

```sql
-- Custom SQL migration file, put your code below! --
-- Step 27d: who may read and write online payments. 0075 made the gateway account, the payment
-- tries and the order's new pending rule; this file gives the two tables their tenant rules, lets
-- the shop's order routes record a try and the gateway's answer, tells the shop whether it can take
-- online payment without showing it the account, and keeps a paid try for good.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Payment card, the worker's receipt) and omnivo_shop
--    (the tries) both set app.tenant_id to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['storefront_payment_gateways', 'storefront_payments'])
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

-- 2) The gateway account: no grant to omnivo_public or omnivo_shop (decision 4). The shop's server
--    and every shop page run as one of them, and none of them needs the store id or the sealed
--    password: the API reads the account as omnivo_app when it calls the gateway (27d.3). Nothing
--    is written here on purpose: a new table is closed to both until a grant opens it (0064, 0071)

-- 3) What omnivo_shop may do with the tries. Placing an online order and "Try again" make one
--    (INSERT); /checkout/paid reads them (SELECT); settle records the gateway's answer, and only
--    these columns of it. Not the receipt's columns (the worker's, as omnivo_app), and not the
--    amount, the tran_id or the mode: a bug in the shop's routes cannot make a try ask for less
--    money or point at another payment. No DELETE: a pending order's tries go with it through
--    the foreign key's CASCADE, which Postgres runs as the table's owner
GRANT SELECT, INSERT ON storefront_payments TO omnivo_shop;
GRANT UPDATE (status, settled_at, val_id, card_type, bank_tran_id, store_amount)
  ON storefront_payments TO omnivo_shop;
-- "Pay on delivery" (decision 3) turns a pending online order into Cash on Delivery, with its
-- phone code, in one UPDATE; a late payment turns it back (27d.3). The code's columns were granted
-- in 0071; the method was not, because until now nothing changed it
GRANT UPDATE (payment_method) ON storefront_orders TO omnivo_shop;

-- 4) Whether the shop can take online payment now (decision 4): a gateway is saved, its money
--    account is a posting account that is not archived and holds money (itself or a group above
--    it, as contracts' moneyAccountIds() reads the tree), and its fee account is an expense
--    posting account that is not archived. The checkout offers "Pay online" only while this is
--    true, and the Payment card's `ready` is the same answer, so the two never disagree (mine 22).
--    SECURITY DEFINER, because the shop's pages run as omnivo_public, which may read neither the
--    gateway nor the chart of accounts: this answers true or false and nothing else. FORCE RLS
--    holds for the owner too, so tenant_isolation keeps it inside the caller's workspace, and the
--    tenant filter is written out as well, for 0074's reason. UNION, not UNION ALL, so a broken
--    tree with a loop still ends. search_path is fixed for 0064's reason
CREATE FUNCTION storefront_online_ready()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM storefront_payment_gateways g
    JOIN ledger_accounts f ON f.tenant_id = g.tenant_id AND f.id = g.fee_account_id
    WHERE g.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      AND f.type = 'expense' AND NOT f.is_group AND f.archived_at IS NULL
      AND EXISTS (
        WITH RECURSIVE up AS (
          SELECT a.parent_id, a.holds_money
          FROM ledger_accounts a
          WHERE a.tenant_id = g.tenant_id AND a.id = g.money_account_id
            AND NOT a.is_group AND a.archived_at IS NULL
          UNION
          SELECT p.parent_id, p.holds_money
          FROM ledger_accounts p
          JOIN up ON p.tenant_id = g.tenant_id AND p.id = up.parent_id
        )
        SELECT 1 FROM up WHERE up.holds_money
      )
  )
$$;

-- The shop's pages and the order routes (omnivo_public, and omnivo_shop through it) and the
-- Payment card and the settings' save (omnivo_app, whose membership in omnivo_public does not
-- inherit). Every role may run a new function (PUBLIC), so that right goes first
REVOKE EXECUTE ON FUNCTION storefront_online_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_online_ready() TO omnivo_public, omnivo_app;

-- 5) A paid try is the record that money came (decision 5). The trigger keeps it:
--    - a try's own columns never change: it is always the same order, number, id, gateway, mode
--      and amount (storefront_payments_fixed)
--    - once paid, the gateway's answer never changes, and the try is never deleted, so a pending
--      order with a paid try cannot be swept away either: the CASCADE from the order's delete
--      runs this trigger too, and the whole delete fails (storefront_payments_paid_kept)
--    - a receipt, once linked, stays linked: a receipt is voided, never deleted, and the link says
--      which payment it was (storefront_payments_receipt_kept)
--    - a try that was answered never goes back to started (storefront_payments_not_restarted):
--      "Try again" is a new try, with a new tran_id
--    A trigger and not checks, because the rules compare the row before and after. The CONSTRAINT
--    names are what the API's database-error mapping reads (18c's pattern)
CREATE FUNCTION storefront_payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'payment % was paid, so it is kept', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_paid_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.order_id, NEW.try_no, NEW.tran_id, NEW.provider, NEW.mode,
      NEW.amount, NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.order_id, OLD.try_no, OLD.tran_id, OLD.provider,
      OLD.mode, OLD.amount, OLD.started_at) THEN
    RAISE EXCEPTION 'payment % keeps its order, number, id, gateway and amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_fixed';
  END IF;
  IF OLD.status = 'paid'
     AND (NEW.status, NEW.settled_at, NEW.val_id, NEW.card_type, NEW.bank_tran_id, NEW.store_amount)
       IS DISTINCT FROM (OLD.status, OLD.settled_at, OLD.val_id, OLD.card_type, OLD.bank_tran_id,
         OLD.store_amount) THEN
    RAISE EXCEPTION 'payment % was paid, so it is kept', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_paid_kept';
  END IF;
  IF OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id THEN
    RAISE EXCEPTION 'payment % keeps its receipt', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_receipt_kept';
  END IF;
  IF NEW.status = 'started' AND OLD.status <> 'started' THEN
    RAISE EXCEPTION 'payment % was answered, so it cannot start again', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payments_not_restarted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_payments_guard
  BEFORE UPDATE OR DELETE ON storefront_payments
  FOR EACH ROW EXECUTE FUNCTION storefront_payments_guard();

-- 6) An order's payment method changes only while it is pending ("Pay on delivery", or a late
--    payment that comes before the phone code was typed), the confirming UPDATE included. After
--    that it is what the rider and the books go by: a confirmed Cash on Delivery order that turned
--    "online" would send the rider out with nothing to collect
--    (storefront_orders_payment_method_kept). omnivo_shop's grant above is a column, not a rule
--    about when, and omnivo_app may write every column, so the rule is the database's
CREATE FUNCTION storefront_orders_payment_method_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'order % keeps its payment method once confirmed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_orders_payment_method_kept';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_orders_payment_method_guard
  BEFORE UPDATE OF payment_method ON storefront_orders
  FOR EACH ROW EXECUTE FUNCTION storefront_orders_payment_method_guard();
```

Made empty by drizzle-kit, then written by hand:

```bash
pnpm --filter @omnivo/db generate --custom --name storefront-payments-rules
```

Block by block:

1. **The tenant rules**, as every tenant table has them since 0002: row security on, forced (so it holds for the
   table's owner too), and `tenant_isolation` with no `TO`, for every role.
2. **No grant on the gateway account to the shop's roles** (decision 4). A new table is closed to `omnivo_public`
   and `omnivo_shop` until a grant opens it (they have no default privileges, 0064 and 0071), so the block is only a
   comment that says so on purpose. The shop's server never holds the store id or the sealed password; the API reads
   them as `omnivo_app` when it calls the gateway (27d.3). `omnivo_app` gets every right on both tables from the
   migrator's default privileges, as on every table.
3. **What the shop's order routes may do with the tries.** `INSERT` (placing an online order, "Try again"),
   `SELECT` (`/checkout/paid`), and `UPDATE` on the gateway's answer only: the status, its time, the validation id,
   the way the shopper paid, the bank's number and the payout. Not the amount, the `tran_id` or the mode, so a bug in
   the shop's routes cannot make a try ask for less money or point at another payment; and not the receipt's
   columns, which are the worker's. No `DELETE`: an order's tries go with it through the foreign key's `CASCADE`,
   which Postgres runs as the table's owner, as 27a's lines and holds do. The method of an order is a new column
   grant, for "Pay on delivery" and a late payment (27d.3); until now nothing changed it.
4. **`storefront_online_ready()`** (mine 22), true when a gateway is saved and both its accounts still fit:
   - **the money account** is a posting account, not archived, that holds money itself or under a group that does.
     The recursive part walks up the tree the way the contracts' `moneyAccountIds()` does (step 15c), so the
     Payment card's account choices (27d.3, from `moneyAccountIds()`) and this answer agree. `UNION` and not `UNION
     ALL`, so a tree with a loop would still end (the chart refuses loops already, `account_parent_loop`).
   - **the fee account** is an expense posting account that is not archived.
   - **`SECURITY DEFINER`**, because the checkout runs as `omnivo_public`, which may read neither the gateway nor
     the chart of accounts. It answers `true` or `false`, nothing else. `FORCE` row security holds for its owner
     too, so `tenant_isolation` keeps it inside the caller's workspace; the `tenant_id` filter is written out as
     well, as in 27c's `storefront_coupon_uses()`. `search_path` is fixed so a caller cannot slip in a table of its
     own named `ledger_accounts`. `STABLE`: one answer inside one statement.
   - **Who may run it:** `omnivo_public` (and `omnivo_shop` through it) for the checkout and the order routes, and
     `omnivo_app` for the Payment card and the save of the shop's settings ("Pay online" can be ticked only while
     it is true). `PUBLIC`'s default right to run a new function goes first.
5. **The guard on the tries** (mine 24). A trigger and not checks, because each rule compares the row before and
   after:
   - **`storefront_payments_fixed`**: a try's own columns never change (its order, number, id, gateway, mode,
     amount and start). `omnivo_app` may write every column, so the grant in block 3 is not enough.
   - **`storefront_payments_paid_kept`**: once paid, the gateway's answer never changes, and the try is never
     deleted. The order's delete runs this trigger too, through the `CASCADE`, so a pending order that has a paid
     try cannot be swept away: the whole `DELETE` fails. This is the database's half of decision 5 (money that came
     is never left unrecorded); 27d.3's half is that settle confirms the order in the same transaction.
   - **`storefront_payments_receipt_kept`**: a receipt, once linked, stays linked. A receipt is voided, never
     deleted, and the link says which payment it was.
   - **`storefront_payments_not_restarted`**: an answered try never goes back to started. "Try again" makes a new
     try with a new `tran_id`, so the gateway's answer about the old one can never be read as the new one's.
   - The `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = …` is 18c's pattern: the API's database-error
     mapping reads the constraint name, as for a real check.
6. **The guard on an order's payment method** (mine 25). It may change only while the order is pending, the
   confirming `UPDATE` included (a late payment confirms an order that had switched to Cash on Delivery, and turns
   it back to online in the same statement). After that the method is what the rider and the books go by: a
   confirmed Cash on Delivery order that turned online would send the rider out with nothing to collect. `BEFORE
   UPDATE OF payment_method`, so the trigger runs only when a statement names that column.

### Check this part

```bash
pnpm --filter @omnivo/db build && pnpm --filter @omnivo/db typecheck
pnpm exec eslint packages/db/src
pnpm db:migrate                            # 0075 and 0076
```

`pnpm --filter @omnivo/api typecheck` still fails as after 27d.1 (the order view's `payments`, 27d.3), and only
there. The new outbox event is not in this part on purpose (mine 26).

What was checked on a throwaway Postgres 17, migrated to the end, with two shops (Acme and Beta), Acme's chart (an
"SSLCommerz balance" account under a "Cash and bank" group that holds money, a stock account, a fee account, a
payable), two Acme money receipts, Acme's gateway, and orders in both shops: Acme's pending online ones, a pending
Cash on Delivery one with its code, a confirmed one, and Beta's pending online one with its own try. As `omnivo_app`:

- the pending rule: an online order with a code, a Cash on Delivery order without one, and a switch to Cash on
  Delivery without the code are each refused by `storefront_orders_pending_check`;
- the gateway: a store id with a space or empty, a sealed value of 28 or 541 bytes, key version 0, one account for
  both, a problem with no time, the mode `test`, Beta's account, a gateway for Beta (row security) and a second
  one for Acme (the primary key) are each refused; a sealed value of 540 bytes is kept;
- `storefront_online_ready()` is true, and false with the fee account archived, a liability, or a group, and with
  the money account the stock account, a group, archived, or with no money flag on it or above it; true again with
  the flag on the account itself;
- the tries: try 0 or 4, a short or lower-case `tran_id`, ৳577.555, ৳0, a payout over the amount or of ৳563.551, a
  started try with an answer time, a failed one without, a paid one without its validation id, a failed one with a
  card name, a cancelled one with a receipt error, a paid one with a receipt and an error, a validation id of 65
  characters, a card name of 101, an error that is a sentence, the mode `test` and a `tran_id` already used are each
  refused by their own check or index; Beta's order from Acme is refused by the foreign key, a try for Beta by row
  security; Beta's `tran_id` in Acme is kept (one per workspace);
- the guard: started → failed → paid is kept (a late payment); failed → started is refused; a paid try's payout,
  status or card name, any try's amount, mode, `tran_id` or order are refused; the same `val_id` on a second try is
  refused; a receipt error, then the receipt in its place, is kept, but both at once is not; another receipt or
  none after it, and the same receipt on a second payment, are refused; deleting a paid try, or its pending order,
  is refused by `storefront_payments_paid_kept`; deleting a pending order with only a failed and a started try
  takes them with it;
- the method: a confirmed order cannot change it; a pending online order becomes Cash on Delivery with its code,
  and is then confirmed as online in one `UPDATE`, after which it cannot change back.

From Beta the function is false and Acme's gateway is not there; with no workspace set, the function is false and
no try is seen. As `omnivo_public`: the function is true for Acme, and the gateway and the tries are refused
(42501). As `omnivo_shop`: the function is true, the gateway is refused (a read, a column, an update); it places an
online order with its first try, locks the try (`FOR UPDATE`), records "cancelled" and then "paid", cannot change
the amount, the mode, the receipt or its error, cannot delete a try; its "Pay on delivery" works; it cannot drop the
order once its try is paid, and drops another pending online order with its try. As `omnivo_worker`: the two tables
and the function are refused.

Three races, each with two real connections:

- **Two "Try again" at once.** Both insert try 2 of the same order; the first holds its transaction for 2 seconds;
  the second waits on the unique key and fails with `storefront_payments_try_key`. The order has tries 1 and 2.
- **Two settles at once** (the browser's return and SSLCommerz's IPN). Both lock the try with `FOR UPDATE`; the first
  records paid and holds for 2 seconds; the second waits, reads `paid`, and its `UPDATE … WHERE status <> 'paid'`
  changes nothing. Written without that `WHERE`, it is refused by `storefront_payments_paid_kept`. The try keeps the
  first answer.
- **Settle against the sweep.** Settle records the try paid and confirms the order, and holds for 2 seconds; the
  sweep's `DELETE … WHERE status = 'pending'` waits for the order's row, then re-reads it as confirmed and deletes
  nothing.

Broken on purpose, each caught:

- the tries' guard dropped: "failed → started is refused" fails;
- `GRANT UPDATE (amount) … TO omnivo_shop`: the shop's change of the amount is refused by the guard
  (`storefront_payments_fixed`) instead of by its rights, and the check says so;
- `GRANT SELECT ON storefront_payment_gateways TO omnivo_public`: the shop's pages can read the gateway;
- the function as `SECURITY INVOKER`: "permission denied for table ledger_accounts";
- the function without the walk up the tree: the money account under "Cash and bank" is not ready;
- the method's guard dropped: a confirmed order can change its method;
- 27a's pending rule with "0 or 5 code columns" for any method: an online order with a code is kept.

## 27d.3 — API

The API side of paying online: the gateway (an interface, SSLCommerz and a fake one), the sealed password, the
Payment card's four routes, the shop's four payment routes, the online branch of Confirm Order, the money receipt
with the gateway's fee, the advance paid into the invoice at Delivered, and the sweep that asks the gateway before
it drops an unpaid order. Two small contract changes come with it (the fake gateway's failed and cancelled
answers, and one error code), and the `storefront.payment_paid` event that 27d.2 left for this part.

The order of the work, and why it is in this order:

1. **The config and the key**, because everything else asks for the gateway or the key.
2. **The gateway layer** (`apps/api/src/payments/`), with no word about shops in it.
3. **The Payment card**, which saves the account the rest of the work reads.
4. **The shop's side**: confirming an order (moved out of the phone code's code), recording the gateway's answer,
   opening a page, and the four routes.
5. **The money side**: the fee in the receipt's entry, the receipt job, the advance at Delivered, and the order
   page's Payments list.
6. **The sweep and the wiring.**

Mine, made while writing this part:

27. **The fake gateway's `val_id` also says "failed" and "cancelled"** (`FAKE_<tran_id>_FAILED`,
    `FAKE_<tran_id>_CANCELLED`). 27d.1's form named only a paid amount. The fake gateway keeps no table, so without
    this the API could not tell "the bank refused it" from "the shopper never paid", and the fake page's Fail and
    Cancel buttons would both read as "You came back without paying".
28. **`CREDENTIALS_KEY` is optional.** Without it, the Payment card refuses to save a password with a new error
    code, `storefront_gateway_key_missing`, and nothing else changes. A required key would stop every server that
    takes no online payment (staging today) from starting. `PAYMENT_GATEWAY` is `fake` outside production and
    `sslcommerz` in production, and `fake` in production stops the API at start.
29. **The gateway layer knows nothing about shops** (decision 10). It opens a page, asks about a payment, and tests
    an account. What an answer means for an order is the shop's code. Step 24's subscription billing can use the
    same layer.
30. **The fields SSLCommerz requires and the shop does not ask** get harmless values: the email is
    `shopper@omnivo.invalid` (the `.invalid` domain can never receive mail, so no stranger gets the shopper's
    receipt), the city is the delivery zone's name, the postcode is `1000`, and `shipping_method` is `NO` (the shop
    delivers by itself, so no `ship_*` fields are needed).
31. **SSLCommerz's `risk_level` is not read.** A `VALID` payment is money that arrived, whatever its risk (decision
    5). Staff who doubt one can cancel the order and refund it (decision 7). A review flag can come with step 28's
    refunds.
32. **Every writer of an order's tries locks the order's row first, then the try's.** Settle, "Try again", "Pay on
    delivery", the sweep and the receipt job then never wait for each other in a circle.
33. **A "paid" answer that is not this try's payment records nothing**: another `tran_id`, another currency, another
    amount, or a payout above the amount. It is logged with the `tran_id`, and the try stays as it was, so staff can
    find it in SSLCommerz's own panel.
34. **The receipt is made once the order has its sales order**, because the sales order names the customer. The
    receipt is dated the day it is made, its method comes from SSLCommerz's `card_type` (a wallet, a card, or the
    bank), and its reference is the bank's or wallet's own number and the way the shopper paid.
35. **The gateway's fee is a second debit line in the receipt's own entry** (Dr money for the payout, Dr fee for the
    fee, Cr receivable for the whole amount). One entry: voiding the receipt reverses the fee with it, and no new
    journal source is needed.
36. **The invoice posted at Delivered takes the order's advances at once**, oldest try first. A receipt made after
    the invoice (a second payment, or one that came very late) goes to the invoice when it is made. A second
    payment of a paid order finds nothing left to pay and stays an advance.
37. **"Pay online" ticked for the first time needs a ready gateway; one already ticked does not.** When an account is
    archived later, the checkout hides "Pay online" by itself, and the shop's other settings can still be saved.
38. **The sweep gives an order with payment tries one more hour**, then asks the gateway about every try that may
    still pay (started, failed, cancelled). It keeps the order when the gateway is still processing, cannot be
    asked, or said "paid" for another amount. It sends no confirm SMS when it confirms a late payment: the worker
    has no shop address to put in the link. The shopper still has `/checkout/paid` and `/track`.
39. **Settle for an unknown `tran_id` answers 404 and logs the id**, so money that arrived for an order already
    dropped can be found in SSLCommerz's panel and paid back.
40. **"Pay on delivery" pressed twice gives the same answer** (the verify page's), with no second SMS.
41. **"Try again" with no gateway account to use** (removed from the checkout, or the password does not open) is
    refused with `shop_payment_unavailable`, and no try is spent.
42. **The Payment card's last test is cleared only when the store id, the password or the mode changes**, the three
    things a test says something about. A password typed again unchanged is no change. A test does not move the
    version, so a form open in another tab can still be saved.
43. **`/checkout/paid` asks the gateway about a last try that is still "started"** (the shopper came back with the
    Back button, before the gateway's post). Unreachable or still processing answers "checking"; a refused account
    answers "not finished", so the shopper can pay on delivery instead of waiting for ever.

### The config and the key

```diff
@@ -22,48 +22,74 @@ const storageEnvSchema = z.object({
   S3_SECRET_ACCESS_KEY: z.string().min(1),
 });
 
-// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
-const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
-  PORT: z.coerce.number().int().positive().default(3000),
-  API_BASE_URL: z.url(),
-  BETTER_AUTH_SECRET: z.string().min(32),
-  JWT_SECRET: z.string().min(32),
-  // "true" only when a proxy you run (Caddy on staging) is the one thing that can reach the API.
-  // Fastify then takes the client's address from X-Forwarded-For, so the audit log records the
-  // person's IP, not the proxy's. Left off, a client could write any IP into that header.
-  TRUST_PROXY: z.stringbool().default(false),
-  // Step 26f: the domain every shop's address ends with. A shop's subdomain is put before it:
-  // "acme" + "localhost" = acme.localhost (dev), "acme" + "omnivo.shop" = acme.omnivo.shop. One
-  // DNS name, lower case, no port and no dot at either end
-  SHOP_BASE_DOMAIN: z
+// Step 27d: online payment. Both processes use it: the API opens payment pages and asks the
+// gateway about payments, and the worker's sweep asks it before it deletes an unpaid online order.
+const paymentEnvSchema = z.object({
+  // Which gateway the API talks to. fake: the shop's own fake page (SHOP_FAKE_GATEWAY_PATH), for
+  // development, CI and the tests; it pays nothing and is refused in production (paymentConfig).
+  // Left out: sslcommerz in production, fake everywhere else
+  PAYMENT_GATEWAY: z.enum(['fake', 'sslcommerz']).optional(),
+  // The key that seals each shop's gateway password in the database (decision 4): 32 random bytes,
+  // base64 (openssl rand -base64 32). Its own secret, not derived from JWT_SECRET: changing the JWT
+  // secret signs everyone out, and must not also make every saved password unreadable. Left out:
+  // the Payment card cannot save a password (storefront_gateway_key_missing), and nothing else in
+  // the API changes, so a server that takes no online payments needs no key
+  CREDENTIALS_KEY: z
     .string()
-    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/)
-    .default('localhost'),
-  // Step 26f: the public address of the storage's storefront/ folder's parent, as a shopper's
-  // browser reaches it. Left out: the storage's own address and bucket (S3_ENDPOINT/S3_BUCKET),
-  // which is right for MinIO in dev and on staging. Cloudflare R2 serves public files from another
-  // address than its API, so production sets it
-  STOREFRONT_MEDIA_URL: z.url().optional(),
-  // Step 26g: the port in a shop's own address, which the Storefront screens link to ("View
-  // shop"). In dev the shop's server has its own port (apps/shop runs on 4321); behind a proxy the
-  // address has none. Left out: 4321 outside production, none in production
-  SHOP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
-  // Step 27a: the key the shop's server sends in X-Shop-Key on the order routes (27a's decision
-  // 13); the shop's own SHOP_API_KEY has the same value. Long and random, like the JWT secret
-  // (openssl rand -base64 32). Left out: the order routes answer 401 to everyone, so a shop with
-  // no key set can show its pages but take no orders, and nothing else in the API changes
-  STOREFRONT_SHOP_KEY: z.string().min(32).optional(),
+    .refine((value) => Buffer.from(value, 'base64').length === 32, {
+      message: 'CREDENTIALS_KEY must be 32 bytes in base64 (openssl rand -base64 32)',
+    })
+    .optional(),
 });
 
-const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
-  // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
-  // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
-  WORKER_DATABASE_URL: z.url(),
-  // ইমেইল: dev-এ docker-compose-এর Mailpit (smtp://localhost:1025, সব চিঠি http://localhost:8025-এ),
-  // production-এ আসল SMTP (smtps://user:pass@host:465)। পাসওয়ার্ড URL-এর ভেতরেই — একটাই secret
-  SMTP_URL: z.url(),
-  MAIL_FROM: z.string().min(3).default('Omnivo <no-reply@omnivo.app>'),
-});
+// process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
+const envSchema = sharedEnvSchema
+  .extend(storageEnvSchema.shape)
+  .extend(paymentEnvSchema.shape)
+  .extend({
+    PORT: z.coerce.number().int().positive().default(3000),
+    API_BASE_URL: z.url(),
+    BETTER_AUTH_SECRET: z.string().min(32),
+    JWT_SECRET: z.string().min(32),
+    // "true" only when a proxy you run (Caddy on staging) is the one thing that can reach the API.
+    // Fastify then takes the client's address from X-Forwarded-For, so the audit log records the
+    // person's IP, not the proxy's. Left off, a client could write any IP into that header.
+    TRUST_PROXY: z.stringbool().default(false),
+    // Step 26f: the domain every shop's address ends with. A shop's subdomain is put before it:
+    // "acme" + "localhost" = acme.localhost (dev), "acme" + "omnivo.shop" = acme.omnivo.shop. One
+    // DNS name, lower case, no port and no dot at either end
+    SHOP_BASE_DOMAIN: z
+      .string()
+      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/)
+      .default('localhost'),
+    // Step 26f: the public address of the storage's storefront/ folder's parent, as a shopper's
+    // browser reaches it. Left out: the storage's own address and bucket (S3_ENDPOINT/S3_BUCKET),
+    // which is right for MinIO in dev and on staging. Cloudflare R2 serves public files from another
+    // address than its API, so production sets it
+    STOREFRONT_MEDIA_URL: z.url().optional(),
+    // Step 26g: the port in a shop's own address, which the Storefront screens link to ("View
+    // shop"). In dev the shop's server has its own port (apps/shop runs on 4321); behind a proxy the
+    // address has none. Left out: 4321 outside production, none in production
+    SHOP_PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
+    // Step 27a: the key the shop's server sends in X-Shop-Key on the order routes (27a's decision
+    // 13); the shop's own SHOP_API_KEY has the same value. Long and random, like the JWT secret
+    // (openssl rand -base64 32). Left out: the order routes answer 401 to everyone, so a shop with
+    // no key set can show its pages but take no orders, and nothing else in the API changes
+    STOREFRONT_SHOP_KEY: z.string().min(32).optional(),
+  });
+
+const workerEnvSchema = sharedEnvSchema
+  .extend(storageEnvSchema.shape)
+  .extend(paymentEnvSchema.shape)
+  .extend({
+    // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
+    // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
+    WORKER_DATABASE_URL: z.url(),
+    // ইমেইল: dev-এ docker-compose-এর Mailpit (smtp://localhost:1025, সব চিঠি http://localhost:8025-এ),
+    // production-এ আসল SMTP (smtps://user:pass@host:465)। পাসওয়ার্ড URL-এর ভেতরেই — একটাই secret
+    SMTP_URL: z.url(),
+    MAIL_FROM: z.string().min(3).default('Omnivo <no-reply@omnivo.app>'),
+  });
 
 const DAY = 24 * 60 * 60;
 
@@ -82,6 +108,30 @@ function storageConfig(e: z.output<typeof storageEnvSchema> & { NODE_ENV: string
 
 export type StorageConfig = ReturnType<typeof storageConfig>;
 
+// Step 27d: the gateway and the sealing key, for the API and the worker alike. The key's version is
+// 1 for now: a second key (a key change) gets 2, and each sealed password says which one sealed it
+// (storefront_payment_gateways.key_version)
+function paymentConfig(e: z.output<typeof paymentEnvSchema> & { NODE_ENV: string }) {
+  const production = e.NODE_ENV === 'production';
+  const gateway = e.PAYMENT_GATEWAY ?? (production ? 'sslcommerz' : 'fake');
+  // The fake gateway says "paid" to any val_id that names an amount: on a live shop that would be
+  // goods for nothing. Refused here, before the API takes a single request
+  if (production && gateway === 'fake') {
+    throw new Error(
+      'Invalid environment — PAYMENT_GATEWAY=fake pays nothing for real, so production cannot use it.',
+    );
+  }
+  return {
+    gateway,
+    credentialsKey:
+      e.CREDENTIALS_KEY === undefined
+        ? null
+        : { version: 1, key: Buffer.from(e.CREDENTIALS_KEY, 'base64') },
+  };
+}
+
+export type PaymentsConfig = ReturnType<typeof paymentConfig>;
+
 function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
   const parsed = schema.safeParse(env);
   if (!parsed.success) {
@@ -129,6 +179,8 @@ export function loadConfig(env: Record<string, string | undefined>) {
     // localhost-এ http, তাই dev-এ Secure cookie বন্ধ; production-এ বাধ্যতামূলক
     secureCookies: e.NODE_ENV === 'production',
     storage: storageConfig(e),
+    // Step 27d: the payment gateway and the key that seals its passwords
+    payments: paymentConfig(e),
     // Step 26f: the public shop API (storefront/)
     storefront: {
       baseDomain: e.SHOP_BASE_DOMAIN,
@@ -171,6 +223,8 @@ export function loadWorkerConfig(env: Record<string, string | undefined>) {
     },
     // The report exports (step 11) go to the same bucket as the uploads
     storage: storageConfig(e),
+    // Step 27d: the sweep asks the gateway before it deletes an unpaid online order
+    payments: paymentConfig(e),
     relay: {
       // How long the relay sleeps when it found nothing to publish. One second keeps an invitation
       // email about a second behind the click, for one cheap index read per second.
```

- **`paymentEnvSchema` is shared by the API's and the worker's schema**, like the storage's. The worker needs both
  values: its sweep asks the gateway, and asking needs the password.
- **`CREDENTIALS_KEY` is checked as 32 bytes after base64**, not as a string length. AES-256 needs exactly 32 bytes;
  a key of the wrong size would fail on the first seal, long after the server started. Checked here, the server
  says so at start, with the command that makes a good one.
- **Its own secret, not derived from `JWT_SECRET`.** Step 27a derived the phone code's key with HKDF because a
  changed key only spoils the next 10 minutes of codes. A changed password key spoils every saved password for good.
  Changing the JWT secret (which signs everyone out) must not also do that.
- **`paymentConfig()` refuses `fake` in production** (mine 28). The fake gateway says "paid" to any `val_id` that
  names an amount, so on a live shop it would give goods away. A thrown error here stops the server before it takes
  a request, the same way as the photos' http address above.
- **`credentialsKey` carries its version, 1 for now.** The sealed row stores the version that sealed it (27d.2), so
  a later key change can open old rows with the old key while new rows get the new one.

```diff
@@ -100,3 +100,30 @@ describe('order keys', () => {
     expect(other.storefront.codeKey.equals(codeKey)).toBe(false);
   });
 });
+
+// Step 27d.3: the gateway and the key that seals its passwords
+describe('payment config', () => {
+  const production = { NODE_ENV: 'production', STOREFRONT_MEDIA_URL: 'https://files.example.com' };
+  const key = Buffer.alloc(32, 7).toString('base64');
+
+  it('uses the fake gateway outside production and SSLCommerz in production', () => {
+    expect(loadConfig(env({})).payments.gateway).toBe('fake');
+    expect(loadConfig(env(production)).payments.gateway).toBe('sslcommerz');
+    expect(loadConfig(env({ PAYMENT_GATEWAY: 'sslcommerz' })).payments.gateway).toBe('sslcommerz');
+  });
+
+  it('refuses the fake gateway in production', () => {
+    expect(() => loadConfig(env({ ...production, PAYMENT_GATEWAY: 'fake' }))).toThrow(
+      /PAYMENT_GATEWAY=fake/,
+    );
+  });
+
+  it('has no key until one is set, and takes only 32 bytes', () => {
+    expect(loadConfig(env({})).payments.credentialsKey).toBeNull();
+    const { credentialsKey } = loadConfig(env({ CREDENTIALS_KEY: key })).payments;
+    expect(credentialsKey?.version).toBe(1);
+    expect(credentialsKey?.key.equals(Buffer.alloc(32, 7))).toBe(true);
+    const short = Buffer.alloc(16, 7).toString('base64');
+    expect(() => loadConfig(env({ CREDENTIALS_KEY: short }))).toThrow(/Invalid environment/);
+  });
+});
```

The production test sets `STOREFRONT_MEDIA_URL` to an https address, because production also refuses photos on plain
http; without it the test would fail for the wrong reason.

```diff
@@ -11,3 +11,8 @@ export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
 
 // The worker's second database pool, as omnivo_worker: only the outbox relay and its cleanup use it
 export const RELAY_DB = Symbol('RELAY_DB');
+
+// Step 27d: the payment part of the config (the API's and the worker's), and the gateway made from
+// it (payments/gateway.ts)
+export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');
+export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
```
```diff
@@ -13,7 +13,18 @@ import { createWithTenant } from '../common/tenant/with-tenant.js';
 import { createWithUser } from '../common/tenant/with-user.js';
 import type { Config } from '../config.js';
 import { StorageService } from '../storage/storage.service.js';
-import { AUTH, CONFIG, DB, REDIS, STORAGE_CONFIG, WITH_TENANT, WITH_USER } from './tokens.js';
+import { createGateway } from '../payments/create-gateway.js';
+import {
+  AUTH,
+  CONFIG,
+  DB,
+  PAYMENT_GATEWAY,
+  PAYMENTS_CONFIG,
+  REDIS,
+  STORAGE_CONFIG,
+  WITH_TENANT,
+  WITH_USER,
+} from './tokens.js';
 
 function createRedis(url: string): Redis {
   const redis = new Redis(url, {
@@ -52,8 +63,21 @@ export class InfraModule implements OnApplicationShutdown {
         { provide: AUTH, inject: [DB], useFactory: (db: Db) => createAuth({ db, ...config.auth }) },
         { provide: STORAGE_CONFIG, useValue: config.storage },
         StorageService,
+        // Step 27d: the gateway for the shop's payments and the Payment card's test
+        { provide: PAYMENTS_CONFIG, useValue: config.payments },
+        { provide: PAYMENT_GATEWAY, useFactory: () => createGateway(config.payments) },
+      ],
+      exports: [
+        CONFIG,
+        DB,
+        WITH_TENANT,
+        WITH_USER,
+        REDIS,
+        AUTH,
+        StorageService,
+        PAYMENTS_CONFIG,
+        PAYMENT_GATEWAY,
       ],
-      exports: [CONFIG, DB, WITH_TENANT, WITH_USER, REDIS, AUTH, StorageService],
     };
   }
 
```

`PAYMENTS_CONFIG` is only the payment part of the config, like `STORAGE_CONFIG`: the worker has its own config type,
and code that both processes run (the gateway accounts, the sweep) must not depend on the API's `Config`. The
gateway is made once per process from that part and exported, so every module gets the same one.

```diff
@@ -10,6 +10,10 @@ import { WorkerModule } from '../worker/worker.module.js';
 // Step 27a: the shop server's key in the tests, sent in X-Shop-Key on the order routes
 export const TEST_SHOP_KEY = 'test-shop-key-that-is-at-least-32-bytes';
 
+// Step 27d: the key that seals gateway passwords in the tests (32 bytes, base64). The gateway is
+// the fake one (PAYMENT_GATEWAY's default outside production)
+export const TEST_CREDENTIALS_KEY = Buffer.alloc(32, 27).toString('base64');
+
 // .env না পড়ে টেস্টের নিজস্ব মান — loadConfig দিয়ে গেলে production-এর একই যাচাই চলে
 // storageUrl না দিলে অচল ঠিকানা — যে টেস্ট ফাইল ছোঁয় না তার জন্য MinIO container তুলতে হয় না
 export function testConfig(urls: {
@@ -29,6 +33,7 @@ export function testConfig(urls: {
     S3_ACCESS_KEY_ID: 'omnivo',
     S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
     STOREFRONT_SHOP_KEY: TEST_SHOP_KEY,
+    CREDENTIALS_KEY: TEST_CREDENTIALS_KEY,
   });
 }
 
@@ -65,6 +70,7 @@ export function testWorkerConfig(urls: {
     S3_ENDPOINT: urls.storageUrl ?? 'http://127.0.0.1:1',
     S3_ACCESS_KEY_ID: 'omnivo',
     S3_SECRET_ACCESS_KEY: 'omnivo-dev-secret',
+    CREDENTIALS_KEY: TEST_CREDENTIALS_KEY,
   });
   return {
     ...config,
```

The tests get their own key, so the integration tests of 27d.4 can save a gateway. The gateway is the fake one,
because `NODE_ENV` is `test`.

```diff
@@ -39,6 +39,13 @@ SHOP_BASE_DOMAIN=localhost
 # SHOP_API_KEY must have the same value. Left out, the API takes no orders (every order route
 # answers 401). At least 32 characters; make a real one with: openssl rand -base64 32
 STOREFRONT_SHOP_KEY=dev-only-shop-key-change-me-0123456789abcdef
+# Step 27d: online payment, read by the API and the worker. PAYMENT_GATEWAY is fake (the shop's own
+# fake page, pays nothing) or sslcommerz; left out, fake outside production and sslcommerz in
+# production, which refuses fake. CREDENTIALS_KEY seals each shop's gateway password: 32 random
+# bytes in base64 (openssl rand -base64 32), its own secret. Left out, the Payment card cannot
+# save a password. Changing it later makes every saved password unreadable until it is typed again
+# PAYMENT_GATEWAY=fake
+CREDENTIALS_KEY=ZGV2LW9ubHktY3JlZGVudGlhbHMta2V5LTMyYnl0ZXM=
 # Step 26f.5: the shop's server (apps/shop) reads these, not the API. Left out, it shows the mock
 # shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
 # SHOP_API_KEY=<STOREFRONT_SHOP_KEY above> pnpm --filter @omnivo/shop dev, then open
```

The dev key in `.env.example` is 32 bytes in base64 and says "dev only" when decoded, like the dev shop key above it.

### Sealing the password

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { PaymentsConfig } from '../config.js';

// Step 27d (decision 4): a gateway password, sealed with AES-256-GCM before it reaches the
// database, and opened only in this process when the API calls the gateway. GCM gives secrecy and
// a check in one: a sealed value changed by one bit, or moved to another workspace's row, does not
// open at all, instead of opening to a wrong password.

export type CredentialsKey = NonNullable<PaymentsConfig['credentialsKey']>;

// GCM's usual sizes: a 12-byte nonce (random for every seal, so the same password sealed twice
// gives two different values) and its 16-byte tag
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// What the seal is tied to, besides the key: the table and the workspace. GCM checks this
// "additional data" on opening without storing it, so a sealed password copied into another
// workspace's row (a bug, or someone with database access) fails to open there
function contextOf(tenantId: string): Buffer {
  return Buffer.from(`omnivo storefront_payment_gateways ${tenantId}`, 'utf8');
}

// One bytea: nonce ‖ tag ‖ ciphertext (27d.2's storefront_payment_gateways_sealed_check counts on
// this order and these sizes)
export function sealSecret(
  key: CredentialsKey,
  tenantId: string,
  secret: string,
): { sealed: Buffer; keyVersion: number } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(contextOf(tenantId));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { sealed: Buffer.concat([nonce, cipher.getAuthTag(), body]), keyVersion: key.version };
}

// The password, or null when it cannot be opened: sealed by another key (a key change the server
// has not caught up with), changed in the database, or another workspace's. The caller logs which
// workspace, never the value. Never throws: a payment page that does not open is an answer the
// shop can show ("Try again", "Pay on delivery"), a 500 is not
export function openSecret(
  key: CredentialsKey,
  tenantId: string,
  sealed: Buffer,
  keyVersion: number,
): string | null {
  if (keyVersion !== key.version || sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(contextOf(tenantId));
    decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // final() throws when the tag does not match: the value or its context was changed
    return null;
  }
}
```

- **AES-256-GCM** gives secrecy and a check in one. A sealed value that was changed by one bit does not open at all,
  instead of opening to a wrong password that would then be sent to SSLCommerz.
- **A new random nonce for every seal.** The same password sealed twice gives two different values, so two
  workspaces with the same password cannot be told apart in a dump. A nonce reused with the same key would break
  GCM's secrecy, and 12 random bytes make that practically impossible.
- **The tenant's id is the "additional data"** (`setAAD`). GCM checks it on opening without storing it. A sealed
  password copied into another workspace's row, by a bug or by someone with database access, does not open there.
- **One `bytea`: nonce, tag, ciphertext**, in that order. 27d.2's check counts on these sizes (at least 29 bytes).
- **`openSecret()` returns `null`, never throws.** The callers are the shop's routes and the sweep: a password that
  does not open must become "the page did not open" or "checking", not a 500. `final()` is the step that throws on
  a wrong tag; the `catch` turns it into `null`.
- **A version other than the key's is `null` without trying**: that row was sealed by another key, and trying this
  one would only fail the tag check.

```ts
import { describe, expect, it } from 'vitest';

import { type CredentialsKey, openSecret, sealSecret } from './credentials.js';

const KEY: CredentialsKey = { version: 1, key: Buffer.alloc(32, 1) };
const TENANT = '0196f3b0-0000-7000-8000-000000000001';
const OTHER = '0196f3b0-0000-7000-8000-000000000002';

describe('gateway password seal (step 27d.3)', () => {
  it('opens what it sealed, and seals the same password differently each time', () => {
    const first = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
    const second = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
    expect(first.keyVersion).toBe(1);
    expect(first.sealed.equals(second.sealed)).toBe(false);
    expect(openSecret(KEY, TENANT, first.sealed, 1)).toBe('nirvo67412bc0d9f1e@ssl');
    // The database's check: nonce + tag + at least one byte
    expect(first.sealed.length).toBe(12 + 16 + 'nirvo67412bc0d9f1e@ssl'.length);
  });

  it('keeps a space and Bangla letters as they were typed', () => {
    const { sealed } = sealSecret(KEY, TENANT, ' পাসওয়ার্ড ');
    expect(openSecret(KEY, TENANT, sealed, 1)).toBe(' পাসওয়ার্ড ');
  });

  it('does not open in another workspace, with another key, or once a bit changed', () => {
    const { sealed } = sealSecret(KEY, TENANT, 'secret');
    expect(openSecret(KEY, OTHER, sealed, 1)).toBeNull();
    expect(openSecret({ version: 1, key: Buffer.alloc(32, 2) }, TENANT, sealed, 1)).toBeNull();
    expect(openSecret(KEY, TENANT, sealed, 2)).toBeNull();
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(openSecret(KEY, TENANT, changed, 1)).toBeNull();
    expect(openSecret(KEY, TENANT, sealed.subarray(0, 28), 1)).toBeNull();
  });
});
```

The third test changes the last byte, cuts the value to 28 bytes, and opens it in another workspace, with another
key and with another version: each must give `null`.

### The gateway layer

```ts
import {
  multiplyMoney,
  type PaymentGatewayMode,
  type PaymentGatewayProvider,
  type PaymentGatewayTestProblem,
} from '@omnivo/contracts';

// Step 27d: what the API needs from a payment gateway, with nothing about shops in it (decision
// 10): step 24's subscription billing opens pages and asks about payments the same way. The shop's
// code (storefront/orders/shop-payments.service.ts) decides what an answer means for an order;
// this layer only talks to the gateway and says what it answered.

// The account a call is made with: the tenant's own store, opened from its sealed row
// (storefront/gateway-accounts.ts). The password lives in memory only for the call
export interface GatewayAccount {
  provider: PaymentGatewayProvider;
  mode: PaymentGatewayMode;
  storeId: string;
  password: string;
}

// One payment page. The amount is in taka (BDT), a decimal string; the addresses are where the
// gateway sends the shopper's browser back (success, fail and cancel all go to returnUrl) and where
// its own server posts the outcome (noticeUrl, SSLCommerz's IPN)
export interface PaymentPageRequest {
  tranId: string;
  amount: string;
  returnUrl: string;
  noticeUrl: string;
  customer: { name: string; phone: string; address: string; area: string };
  // What the payment is for, in the gateway's own report: "Order from Nirvor Pharmacy"
  description: string;
  items: number;
}

// rejected: the gateway answered and refused (the store id or password is wrong, the store is
// inactive). unreachable: no answer in time, or one that is not the gateway's
export type GatewayProblem = PaymentGatewayTestProblem;

export type PaymentPage = { ok: true; url: string } | { ok: false; problem: GatewayProblem };

// What the gateway says about one payment, asked by its validation id or by our transaction id:
// - paid: the money arrived. Every field from the gateway's own answer; the caller still checks
//   the transaction id, the amount and the currency against the try (decision 2)
// - failed / cancelled: the bank refused it, or the shopper pressed Cancel
// - pending: the gateway is still processing it; ask again later
// - none: the gateway knows no payment for it (never paid, expired, or never opened)
// - problem: the gateway could not be asked (GatewayProblem)
export type GatewayAnswer =
  | {
      kind: 'paid';
      tranId: string;
      valId: string;
      amount: string;
      currency: string;
      storeAmount: string;
      cardType: string | null;
      bankTranId: string | null;
    }
  | { kind: 'failed' | 'cancelled' | 'pending' | 'none' }
  | { kind: 'problem'; problem: GatewayProblem };

export interface PaymentGateway {
  openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage>;
  // By the val_id the gateway gave the shopper's browser (and its IPN): the paid case
  validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer>;
  // By our own transaction id: a failed or cancelled try (no val_id), a shopper who came back
  // with the Back button, and the sweep's last look before it deletes an order
  find(account: GatewayAccount, tranId: string): Promise<GatewayAnswer>;
  // "Test connection": null when the gateway accepts the account
  test(account: GatewayAccount): Promise<GatewayProblem | null>;
}

// A gateway's amount as our money string, to the paisa. Gateways send "578.00", 578 or "563.5500";
// a value with more than 4 decimals is cut to 4 first (anything under a paisa is noise), then
// rounded to the paisa like every amount the books post (27d.2's storefront_payments_amounts_check).
// null for anything that is not a plain positive amount
export function paisaOf(value: string | number): string | null {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (match?.[1] === undefined) return null;
  const fraction = (match[2] ?? '').slice(0, 4);
  return multiplyMoney('1', fraction === '' ? match[1] : `${match[1]}.${fraction}`);
}

// A gateway's word for a column of ours: trimmed, null when empty, and cut to the column's 100
// characters (storefront_payments_text_check), so a long card name never leaves a payment
// unrecorded
export function gatewayText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return text === '' ? null : text.slice(0, 100);
}
```

- **`GatewayAccount` is the account opened for one call.** The password lives in memory only while the call runs.
- **One return path for success, fail and cancel.** What happened is asked of the gateway, never read from which
  address it posted to (27d.1's mine 13). Three paths would only give three places to get it wrong.
- **`GatewayAnswer` is a discriminated union.** `paid` carries every field the API checks and stores; `failed`,
  `cancelled`, `pending` and `none` carry nothing; `problem` says why the gateway could not be asked. A `switch` on
  `kind` then lets TypeScript check that every case is handled.
- **`paisaOf()`** turns a gateway's amount into our money string. SSLCommerz sends `"578.00"`, sometimes a number;
  anything past 4 decimals is cut first (`multiplyMoney` takes at most 4), then it is rounded to the paisa, as
  27d.2's check wants. A negative or grouped amount (`1,000`) is `null`, which the caller treats as "not a real
  answer". Money stays a string: `multiplyMoney('1', …)` rounds without a JavaScript number.
- **`gatewayText()`** cuts a gateway's words to the column's 100 characters. Without it a long card name would fail
  27d.2's text check, and a real payment would be left unrecorded.

```ts
import type { PaymentsConfig } from '../config.js';
import { FakeGateway } from './fake-gateway.js';
import type { PaymentGateway } from './gateway.js';
import { SslcommerzGateway } from './sslcommerz-gateway.js';

// Step 27d: the one gateway of this process, by PAYMENT_GATEWAY (config.ts). Its own file, so the
// two classes can import gateway.ts's types and helpers without a circle. The API's InfraModule
// and the WorkerModule both provide it as PAYMENT_GATEWAY; a test puts its own in its place
export function createGateway(config: PaymentsConfig): PaymentGateway {
  return config.gateway === 'fake' ? new FakeGateway() : new SslcommerzGateway();
}
```

`createGateway()` lives in its own file. In `gateway.ts` it would import the two classes, which import `gateway.ts`
for its types and helpers: a circle of imports, which the boundary check refuses and which can leave a class
`undefined` at load time.

### SSLCommerz

```ts
import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { shopPaymentUrlSchema } from '@omnivo/contracts';
import { z } from 'zod';

import {
  type GatewayAccount,
  type GatewayAnswer,
  gatewayText,
  type GatewayProblem,
  paisaOf,
  type PaymentGateway,
  type PaymentPage,
  type PaymentPageRequest,
} from './gateway.js';

// Step 27d: SSLCommerz's API v4 (developer.sslcommerz.com/doc/v4). Checked against its documented
// requests and answers only: there was no sandbox store to try it on (the guide says so). Three
// calls: the session (a payment page), the validation by val_id, and the transaction query by
// tran_id, which "Test connection" uses too.

const ADDRESSES = {
  sandbox: 'https://sandbox.sslcommerz.com',
  live: 'https://securepay.sslcommerz.com',
} as const;

// Long enough for SSLCommerz on a slow day, short enough that the shopper's Confirm Order does not
// hang: after this the page did not open, and the shop offers "Try again"
const TIMEOUT_MS = 10_000;

// SSLCommerz's answers carry many more fields; only these are read, and everything else is left
// alone (zod objects drop unknown keys). Amounts come as strings, sometimes as numbers
const amountSchema = z.union([z.string(), z.number()]);
const textSchema = z.string().nullish();

const sessionSchema = z.object({
  status: z.string(),
  failedreason: textSchema,
  GatewayPageURL: textSchema,
});

const paymentSchema = z.object({
  status: z.string(),
  tran_id: textSchema,
  val_id: textSchema,
  amount: amountSchema.nullish(),
  currency: textSchema,
  store_amount: amountSchema.nullish(),
  card_type: textSchema,
  bank_tran_id: textSchema,
});
type SslPayment = z.infer<typeof paymentSchema>;

const querySchema = z.object({
  APIConnect: z.string(),
  element: z.array(paymentSchema).nullish(),
});

// "578.0000" as "578.00". The try's amount is to the paisa already (27d.2's amounts check), so
// this only drops the two zeros Postgres adds; a string all the way, never a JavaScript number
function twoDecimals(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

// VALID: paid, first look. VALIDATED: paid, and asked about before (the return and the IPN both
// ask, so the second one sees this). Both are money that arrived
const PAID = new Set(['VALID', 'VALIDATED']);

// A paid payment as our answer, or a problem when a field is missing or not an amount: an answer
// that says "VALID" without its amount is not one the API can check, so it records nothing
function paidOf(payment: SslPayment): GatewayAnswer {
  const amount = payment.amount == null ? null : paisaOf(payment.amount);
  const storeAmount = payment.store_amount == null ? null : paisaOf(payment.store_amount);
  if (
    payment.tran_id == null ||
    payment.val_id == null ||
    payment.currency == null ||
    amount === null ||
    storeAmount === null
  ) {
    return { kind: 'problem', problem: 'unreachable' };
  }
  return {
    kind: 'paid',
    tranId: payment.tran_id,
    valId: payment.val_id,
    amount,
    currency: payment.currency.toUpperCase(),
    storeAmount,
    cardType: gatewayText(payment.card_type),
    bankTranId: gatewayText(payment.bank_tran_id),
  };
}

export class SslcommerzGateway implements PaymentGateway {
  private readonly logger = new Logger(SslcommerzGateway.name);

  // fetch is a parameter so the unit test can answer for SSLCommerz
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage> {
    const form = new URLSearchParams({
      store_id: account.storeId,
      store_passwd: account.password,
      total_amount: twoDecimals(request.amount),
      currency: 'BDT',
      tran_id: request.tranId,
      // Success, fail and cancel all come back to one path: what happened is asked of SSLCommerz,
      // never read from which address it posted to (27d.1's shopGatewayPostSchema)
      success_url: request.returnUrl,
      fail_url: request.returnUrl,
      cancel_url: request.returnUrl,
      ipn_url: request.noticeUrl,
      cus_name: request.customer.name.slice(0, 50),
      // SSLCommerz requires an email, and the shop asks for none (a phone is enough to deliver).
      // A reserved .invalid address (RFC 2606) can never receive mail, so no stranger gets the
      // shopper's receipt (mine)
      cus_email: 'shopper@omnivo.invalid',
      cus_phone: request.customer.phone,
      cus_add1: request.customer.address.replace(/\s+/g, ' ').slice(0, 50),
      // The delivery zone stands in for the city; the shop has no postcode, and SSLCommerz wants
      // the field, so it gets Dhaka's GPO code as a placeholder (mine)
      cus_city: request.customer.area.slice(0, 50),
      cus_postcode: '1000',
      cus_country: 'Bangladesh',
      // The shop delivers by itself (or by its courier, step 28), not through SSLCommerz, so no
      // ship_* fields are needed
      shipping_method: 'NO',
      num_of_item: String(request.items),
      product_name: request.description.slice(0, 255),
      product_category: 'General',
      product_profile: 'general',
    });
    const answer = await this.call(`${ADDRESSES[account.mode]}/gwprocess/v4/api.php`, {
      method: 'POST',
      body: form,
    });
    if (answer === null) return { ok: false, problem: 'unreachable' };
    const session = sessionSchema.safeParse(answer);
    if (!session.success) return { ok: false, problem: 'unreachable' };
    // A page only from SSLCommerz's own https address: the shop puts it in `location`
    const url = shopPaymentUrlSchema.safeParse(session.data.GatewayPageURL);
    if (session.data.status.toUpperCase() === 'SUCCESS' && url.success) {
      return { ok: true, url: url.data };
    }
    // The reason is SSLCommerz's own words ("Store Credential Error Or Store is De-active"),
    // logged for whoever reads the logs; the shop only says the page did not open
    this.logger.warn(`SSLCommerz refused a session: ${session.data.failedreason ?? 'no reason'}`);
    return { ok: false, problem: 'rejected' };
  }

  async validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer> {
    const answer = await this.call(
      this.query(account, '/validator/api/validationserverAPI.php', { val_id: valId }),
    );
    if (answer === null) return { kind: 'problem', problem: 'unreachable' };
    const payment = paymentSchema.safeParse(answer);
    if (!payment.success) return { kind: 'problem', problem: 'unreachable' };
    if (PAID.has(payment.data.status.toUpperCase())) return paidOf(payment.data);
    // INVALID_TRANSACTION: no payment under this val_id. The caller asks by tran_id next, which
    // says whether the try failed, was cancelled or was never paid
    return { kind: 'none' };
  }

  async find(account: GatewayAccount, tranId: string): Promise<GatewayAnswer> {
    const answer = await this.transactions(account, tranId);
    if (answer.kind === 'problem') return answer;
    const statuses = answer.payments.map((payment) => payment.status.toUpperCase());
    // One tran_id can have several attempts on SSLCommerz's side (the shopper tried a card, then
    // bKash). Any paid one is the answer: money that arrived is never left unrecorded (decision 5)
    const paid = answer.payments.find((payment) => PAID.has(payment.status.toUpperCase()));
    if (paid !== undefined) return paidOf(paid);
    if (statuses.includes('PENDING')) return { kind: 'pending' };
    if (statuses.includes('FAILED')) return { kind: 'failed' };
    if (statuses.includes('CANCELLED')) return { kind: 'cancelled' };
    // None found, or only EXPIRED / UNATTEMPTED: the page was opened and nothing was paid
    return { kind: 'none' };
  }

  // A transaction query for an id that cannot exist: SSLCommerz answers APIConnect DONE with
  // nothing found when it accepts the store, and FAILED (or INACTIVE) when it does not. Nothing
  // is paid or changed by it
  async test(account: GatewayAccount): Promise<GatewayProblem | null> {
    const answer = await this.transactions(
      account,
      `TEST${randomBytes(8).toString('hex').toUpperCase()}`,
    );
    return answer.kind === 'problem' ? answer.problem : null;
  }

  private async transactions(
    account: GatewayAccount,
    tranId: string,
  ): Promise<
    { kind: 'found'; payments: SslPayment[] } | { kind: 'problem'; problem: GatewayProblem }
  > {
    const answer = await this.call(
      this.query(account, '/validator/api/merchantTransIDvalidationAPI.php', { tran_id: tranId }),
    );
    if (answer === null) return { kind: 'problem', problem: 'unreachable' };
    const query = querySchema.safeParse(answer);
    if (!query.success) return { kind: 'problem', problem: 'unreachable' };
    // DONE: the store was accepted. INVALID_REQUEST, FAILED (wrong store id or password) and
    // INACTIVE: refused
    if (query.data.APIConnect.toUpperCase() !== 'DONE')
      return { kind: 'problem', problem: 'rejected' };
    return { kind: 'found', payments: query.data.element ?? [] };
  }

  // SSLCommerz's two validator APIs take the store's password in the address (its own design).
  // The address is therefore never logged, here or by the error below
  private query(account: GatewayAccount, path: string, params: Record<string, string>): string {
    const search = new URLSearchParams({
      ...params,
      store_id: account.storeId,
      store_passwd: account.password,
      v: '1',
      format: 'json',
    });
    return `${ADDRESSES[account.mode]}${path}?${search.toString()}`;
  }

  // The answer's JSON, or null when there is none to read: no connection, a timeout, an HTTP
  // error, or a body that is not JSON (a proxy's error page). Never throws
  private async call(url: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(`SSLCommerz answered HTTP ${String(response.status)}`);
        return null;
      }
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      this.logger.warn(
        `SSLCommerz did not answer: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return null;
    }
  }
}
```

- **Checked against SSLCommerz's documented API v4 only.** There was no sandbox store to try it on, so the guide's
  verification note says so (27d.8). The addresses and the field names are the documentation's.
- **`TIMEOUT_MS` is 10 seconds.** The shopper is waiting on Confirm Order while the session is made. After that the
  page "did not open", and the shop offers "Try again" and "Pay on delivery".
- **The zod schemas read only the fields the API uses.** SSLCommerz's answers have dozens more; zod objects drop
  unknown keys, so a new field on SSLCommerz's side changes nothing here. Every field is `nullish`: a missing one is
  a missing value, not a crash.
- **`twoDecimals()`** writes `"578.0000"` as `"578.00"` with string work only. `Number(amount).toFixed(2)` would put
  money through a JavaScript number, which the money rules forbid.
- **`VALID` and `VALIDATED` are both paid.** The second is SSLCommerz's answer when the payment was asked about
  before: the browser's return and the IPN both ask, so one of them always sees `VALIDATED`.
- **`paidOf()` refuses a "paid" answer without its ids, its currency or a readable amount** (it becomes a
  `problem`). The API cannot check such an answer against the try, so it records nothing (mine 33).
- **The session's page must pass `shopPaymentUrlSchema`** (http or https only, 27d.1). The shop puts it in the
  browser's `location`; anything else from a broken or tampered answer must not get there.
- **`failedreason` is logged; the shop only learns "rejected".** SSLCommerz's words ("Store Credential Error Or
  Store is De-active") help whoever reads the logs, not the shopper.
- **`validate()` answers `none` for `INVALID_TRANSACTION`.** The caller then asks by `tran_id`, which says whether
  the try failed, was cancelled or was never paid.
- **`find()` takes any paid attempt first.** One `tran_id` can have several attempts on SSLCommerz's side (a card,
  then bKash). Money that arrived is never left unrecorded, so a paid attempt wins over a failed one; then
  `PENDING`, then `FAILED`, then `CANCELLED`. `EXPIRED` and `UNATTEMPTED` mean nothing was paid: `none`.
- **`test()` queries a `tran_id` that cannot exist.** SSLCommerz answers `APIConnect: DONE` when it accepts the
  store, and `FAILED`, `INACTIVE` or `INVALID_REQUEST` when it does not. Nothing is paid or changed by it.
- **The validator APIs take the password in the address.** That is SSLCommerz's own design. The address is
  therefore never logged, and the error log names only the error's type.
- **`call()` never throws.** No connection, a timeout, an HTTP error and a body that is not JSON (a proxy's error
  page) all become `null`, which every caller turns into `unreachable`.
- **`fetch` is a constructor parameter**, so the unit test can answer for SSLCommerz without a network.

### The fake gateway

```diff
@@ -653,9 +653,10 @@ export const shopPaymentRetrySchema = z.object({
 // Development and CI: the fake gateway (PAYMENT_GATEWAY=fake in the API, and the shop's mock
 // source) opens this page on the shop instead of SSLCommerz's. It shows the amount and three
 // buttons, and posts what SSLCommerz posts to SHOP_PAYMENT_RETURN_PATH. Its val_id carries the
-// try and the amount it says was paid, so a test can pay a wrong amount by changing the address.
-// The API refuses PAYMENT_GATEWAY=fake in production, and the real gateway asks SSLCommerz about a
-// val_id, so one of these typed into a live shop pays nothing
+// try and what happened: the amount it says was paid (so a test can pay a wrong amount by changing
+// the address), or that the bank refused it or the shopper cancelled. The API refuses
+// PAYMENT_GATEWAY=fake in production, and the real gateway asks SSLCommerz about a val_id, so one
+// of these typed into a live shop pays nothing
 export const SHOP_FAKE_GATEWAY_PATH = '/checkout/fake-gateway';
 export const FAKE_GATEWAY_OUTCOMES = ['paid', 'failed', 'cancelled'] as const;
 
@@ -664,15 +665,33 @@ export const fakeGatewayParamsSchema = z.object({
   amount: shopMoneySchema,
 });
 
-export function fakeValId(tranId: string, amount: string): string {
-  return `FAKE_${tranId}_${amount}`;
+// What one press on the fake page says. Step 27d.3: failed and cancelled are in the val_id too.
+// SSLCommerz says them in its own answer to the API; the fake gateway keeps no table, so without
+// this the API could not tell "the bank refused it" from "the shopper never paid"
+export type FakeGatewayAnswer =
+  | { tranId: string; outcome: 'paid'; amount: string }
+  | { tranId: string; outcome: 'failed' | 'cancelled' };
+
+const FAKE_REFUSALS = { failed: 'FAILED', cancelled: 'CANCELLED' } as const;
+
+export function fakeValId(
+  tranId: string,
+  answer: { outcome: 'paid'; amount: string } | { outcome: 'failed' | 'cancelled' },
+): string {
+  return answer.outcome === 'paid'
+    ? `FAKE_${tranId}_${answer.amount}`
+    : `FAKE_${tranId}_${FAKE_REFUSALS[answer.outcome]}`;
 }
 
-// The try and the amount a fake val_id names, or null for anything else (a real SSLCommerz val_id)
-export function readFakeValId(valId: string): { tranId: string; amount: string } | null {
-  const match = /^FAKE_([A-Z0-9]{20})_(\d{1,12}(?:\.\d{1,4})?)$/.exec(valId);
-  if (match?.[1] === undefined || match[2] === undefined) return null;
-  return { tranId: match[1], amount: match[2] };
+// The try and the answer a fake val_id names, or null for anything else (a real SSLCommerz val_id)
+export function readFakeValId(valId: string): FakeGatewayAnswer | null {
+  const match = /^FAKE_([A-Z0-9]{20})_(\d{1,12}(?:\.\d{1,4})?|FAILED|CANCELLED)$/.exec(valId);
+  const tranId = match?.[1];
+  const said = match?.[2];
+  if (tranId === undefined || said === undefined) return null;
+  if (said === FAKE_REFUSALS.failed) return { tranId, outcome: 'failed' };
+  if (said === FAKE_REFUSALS.cancelled) return { tranId, outcome: 'cancelled' };
+  return { tranId, outcome: 'paid', amount: said };
 }
 
 // An order's life (system design §14.3 storefront_orders.status). Cancelled and returned end it
```

`fakeValId()` now takes the outcome (mine 27): the paid form is the same as in 27d.1, and the two refusals end in
`FAILED` or `CANCELLED`. `readFakeValId()` still matches the whole string, so `FAKE_…_PAID` or `FAKE_…_12a` are
nothing. The shop's fake page (27d.7) posts one of the three.

```diff
@@ -884,8 +884,18 @@ describe('paying online (step 27d.1)', () => {
   });
 
   it("reads back the fake gateway's val_id, and nothing else", () => {
-    const valId = fakeValId(TRAN, '1199.0000');
-    expect(readFakeValId(valId)).toEqual({ tranId: TRAN, amount: '1199.0000' });
+    const valId = fakeValId(TRAN, { outcome: 'paid', amount: '1199.0000' });
+    expect(readFakeValId(valId)).toEqual({ tranId: TRAN, outcome: 'paid', amount: '1199.0000' });
+    // Step 27d.3: Fail and Cancel on the fake page say so too
+    expect(readFakeValId(fakeValId(TRAN, { outcome: 'failed' }))).toEqual({
+      tranId: TRAN,
+      outcome: 'failed',
+    });
+    expect(readFakeValId(fakeValId(TRAN, { outcome: 'cancelled' }))).toEqual({
+      tranId: TRAN,
+      outcome: 'cancelled',
+    });
+    expect(readFakeValId(`FAKE_${TRAN}_PAID`)).toBeNull();
     // A real SSLCommerz val_id is not a fake one
     expect(readFakeValId('2611221045371uQe8kz1lO')).toBeNull();
     expect(readFakeValId(`FAKE_${TRAN}_12a`)).toBeNull();
```

```ts
import {
  percentOfMoney,
  readFakeValId,
  SHOP_FAKE_GATEWAY_PATH,
  subtractMoney,
} from '@omnivo/contracts';

import {
  type GatewayAccount,
  type GatewayAnswer,
  type GatewayProblem,
  type PaymentGateway,
  type PaymentPage,
  type PaymentPageRequest,
} from './gateway.js';

// What the fake gateway keeps as its fee: 2.5%, about SSLCommerz's own, so a paid fake order posts
// a fee line and the books look like the real thing's (decision 6)
const FAKE_FEE_PERCENT = '2.5';

// Step 27d (decision 8): the gateway of development, CI and the tests. It keeps nothing: its page
// is the shop's own (SHOP_FAKE_GATEWAY_PATH), and the val_id that page posts back says what
// happened (27d.1's fakeValId). Refused in production (config.ts), because a val_id anyone can
// write would pay for anything.
export class FakeGateway implements PaymentGateway {
  // On the shop's own address: the return path's origin is the shop's, so the page opens where
  // the shopper already is, in dev on http://<shop>.localhost:4321
  openPage(account: GatewayAccount, request: PaymentPageRequest): Promise<PaymentPage> {
    const problem = fakeProblem(account);
    if (problem !== null) return Promise.resolve({ ok: false, problem });
    const url = new URL(SHOP_FAKE_GATEWAY_PATH, request.returnUrl);
    url.search = new URLSearchParams({ tranId: request.tranId, amount: request.amount }).toString();
    return Promise.resolve({ ok: true, url: url.toString() });
  }

  validate(account: GatewayAccount, valId: string): Promise<GatewayAnswer> {
    const problem = fakeProblem(account);
    if (problem !== null) return Promise.resolve({ kind: 'problem', problem });
    const answer = readFakeValId(valId);
    if (answer === null) return Promise.resolve({ kind: 'none' });
    if (answer.outcome !== 'paid') return Promise.resolve({ kind: answer.outcome });
    return Promise.resolve({
      kind: 'paid',
      tranId: answer.tranId,
      valId,
      amount: answer.amount,
      currency: 'BDT',
      storeAmount: subtractMoney(answer.amount, percentOfMoney(answer.amount, FAKE_FEE_PERCENT)),
      cardType: 'BKASH-BKash',
      bankTranId: `FAKE${answer.tranId.slice(0, 12)}`,
    });
  }

  // It keeps no table, so it knows no payment by its tran_id: a try whose val_id never came back
  // (the shopper closed the fake page) is never paid
  find(account: GatewayAccount): Promise<GatewayAnswer> {
    const problem = fakeProblem(account);
    return Promise.resolve(problem === null ? { kind: 'none' } : { kind: 'problem', problem });
  }

  test(account: GatewayAccount): Promise<GatewayProblem | null> {
    return Promise.resolve(fakeProblem(account));
  }
}

// Two store ids that make the fake gateway answer like SSLCommerz on a bad day, so the Payment
// card's "Test connection" and a page that does not open can be tried by hand and in the tests
function fakeProblem(account: GatewayAccount): GatewayProblem | null {
  if (account.storeId === 'fake_rejected') return 'rejected';
  if (account.storeId === 'fake_unreachable') return 'unreachable';
  return null;
}
```

- **Its page is on the shop's own address**: the origin of the return path. In dev that is
  `http://<shop>.localhost:4321`, where the shopper already is.
- **A fee of 2.5%**, about SSLCommerz's own, so a paid fake order posts a fee line and the books look like the real
  thing's. `percentOfMoney` rounds to the paisa; ৳538 gives a fee of ৳13.45.
- **`find()` always answers `none`.** It keeps no table, so a fake try whose page was closed is never paid.
- **Two special store ids** (`fake_rejected`, `fake_unreachable`) make it answer like SSLCommerz on a bad day, so the
  Payment card's test and a page that does not open can be tried by hand and in the e2e tests.

```ts
import { fakeValId, SHOP_FAKE_GATEWAY_PATH } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { FakeGateway } from './fake-gateway.js';
import { type GatewayAccount, paisaOf, type PaymentPageRequest } from './gateway.js';
import { SslcommerzGateway } from './sslcommerz-gateway.js';

const TRAN = 'K7Q2M4X9B1C3D5E6F8G0';
const ACCOUNT: GatewayAccount = {
  provider: 'sslcommerz',
  mode: 'sandbox',
  storeId: 'nirvo67412bc0d9f1e',
  password: 'nirvo67412bc0d9f1e@ssl',
};
const REQUEST: PaymentPageRequest = {
  tranId: TRAN,
  amount: '578.0000',
  returnUrl: 'http://nirvor.localhost:4321/checkout/pay/return',
  noticeUrl: 'http://nirvor.localhost:4321/api/payments/notice',
  customer: {
    name: 'Sadia Rahman',
    phone: '01786120356',
    address: 'House 12\nRoad 4',
    area: 'Inside Dhaka',
  },
  description: 'Order from Nirvor Pharmacy',
  items: 3,
};

// A fetch that answers one JSON body and remembers what it was asked
function answering(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    // The gateway passes a plain string address; the other two forms are fetch's own type
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetchFn };
}

describe('gateway amounts (step 27d.3)', () => {
  it('reads a gateway amount to the paisa, and nothing that is not one', () => {
    expect(paisaOf('578.00')).toBe('578.0000');
    expect(paisaOf(578)).toBe('578.0000');
    expect(paisaOf('563.555')).toBe('563.5600');
    expect(paisaOf('563.554999')).toBe('563.5500');
    expect(paisaOf('-1')).toBeNull();
    expect(paisaOf('1,000')).toBeNull();
    expect(paisaOf('')).toBeNull();
  });
});

describe('SSLCommerz gateway (step 27d.3)', () => {
  it('opens a session with every return on one path and the amount with 2 decimals', async () => {
    const { calls, fetchFn } = answering({
      status: 'SUCCESS',
      GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde1',
    });
    const page = await new SslcommerzGateway(fetchFn).openPage(ACCOUNT, REQUEST);
    expect(page).toEqual({ ok: true, url: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde1' });
    expect(calls[0]?.url).toBe('https://sandbox.sslcommerz.com/gwprocess/v4/api.php');
    const form = calls[0]?.init?.body;
    expect(form).toBeInstanceOf(URLSearchParams);
    if (!(form instanceof URLSearchParams)) return;
    expect(form.get('total_amount')).toBe('578.00');
    expect(form.get('currency')).toBe('BDT');
    expect(form.get('success_url')).toBe(REQUEST.returnUrl);
    expect(form.get('fail_url')).toBe(REQUEST.returnUrl);
    expect(form.get('cancel_url')).toBe(REQUEST.returnUrl);
    expect(form.get('ipn_url')).toBe(REQUEST.noticeUrl);
    expect(form.get('cus_add1')).toBe('House 12 Road 4');
    expect(form.get('cus_email')).toMatch(/\.invalid$/);
  });

  it('says rejected when SSLCommerz refuses, and unreachable when it does not answer', async () => {
    const refused = answering({ status: 'FAILED', failedreason: 'Store Credential Error' });
    expect(await new SslcommerzGateway(refused.fetchFn).openPage(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      problem: 'rejected',
    });
    // A page that is not SSLCommerz's https address is no page
    const strange = answering({ status: 'SUCCESS', GatewayPageURL: 'javascript:alert(1)' });
    expect((await new SslcommerzGateway(strange.fetchFn).openPage(ACCOUNT, REQUEST)).ok).toBe(
      false,
    );
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(await new SslcommerzGateway(down).openPage(ACCOUNT, REQUEST)).toEqual({
      ok: false,
      problem: 'unreachable',
    });
    const error = answering({ message: 'Bad gateway' }, 502);
    expect(await new SslcommerzGateway(error.fetchFn).validate(ACCOUNT, 'v1')).toEqual({
      kind: 'problem',
      problem: 'unreachable',
    });
  });

  it('reads a paid validation from its own answer, and asks with the store in the address', async () => {
    const { calls, fetchFn } = answering({
      status: 'VALID',
      tran_id: TRAN,
      val_id: '2611221045371uQe8kz1lO',
      amount: '578.00',
      currency: 'BDT',
      store_amount: '563.55',
      card_type: 'BKASH-BKash',
      bank_tran_id: '2611221045371',
    });
    expect(
      await new SslcommerzGateway(fetchFn).validate(ACCOUNT, '2611221045371uQe8kz1lO'),
    ).toEqual({
      kind: 'paid',
      tranId: TRAN,
      valId: '2611221045371uQe8kz1lO',
      amount: '578.0000',
      currency: 'BDT',
      storeAmount: '563.5500',
      cardType: 'BKASH-BKash',
      bankTranId: '2611221045371',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/validator/api/validationserverAPI.php');
    expect(url.searchParams.get('val_id')).toBe('2611221045371uQe8kz1lO');
    expect(url.searchParams.get('store_id')).toBe(ACCOUNT.storeId);
  });

  it('does not call a VALID answer without its amount paid', async () => {
    const { fetchFn } = answering({
      status: 'VALID',
      tran_id: TRAN,
      val_id: 'v1',
      currency: 'BDT',
    });
    expect((await new SslcommerzGateway(fetchFn).validate(ACCOUNT, 'v1')).kind).toBe('problem');
    const invalid = answering({ status: 'INVALID_TRANSACTION' });
    expect(await new SslcommerzGateway(invalid.fetchFn).validate(ACCOUNT, 'v1')).toEqual({
      kind: 'none',
    });
  });

  it('finds a try by tran_id: paid first, then pending, failed, cancelled, else none', async () => {
    const find = async (statuses: string[]) => {
      const { fetchFn } = answering({
        APIConnect: 'DONE',
        no_of_trans_found: statuses.length,
        element: statuses.map((status) => ({
          status,
          tran_id: TRAN,
          val_id: `v-${status}`,
          amount: '578.00',
          currency: 'BDT',
          store_amount: '563.55',
        })),
      });
      return (await new SslcommerzGateway(fetchFn).find(ACCOUNT, TRAN)).kind;
    };
    expect(await find(['FAILED', 'VALIDATED'])).toBe('paid');
    expect(await find(['FAILED', 'PENDING'])).toBe('pending');
    expect(await find(['CANCELLED', 'FAILED'])).toBe('failed');
    expect(await find(['CANCELLED'])).toBe('cancelled');
    expect(await find(['EXPIRED'])).toBe('none');
    expect(await find([])).toBe('none');
  });

  it('tests the account with a transaction query that finds nothing', async () => {
    const accepted = answering({ APIConnect: 'DONE', no_of_trans_found: 0 });
    expect(await new SslcommerzGateway(accepted.fetchFn).test(ACCOUNT)).toBeNull();
    const refused = answering({ APIConnect: 'FAILED' });
    expect(await new SslcommerzGateway(refused.fetchFn).test(ACCOUNT)).toBe('rejected');
    const inactive = answering({ APIConnect: 'INACTIVE' });
    expect(await new SslcommerzGateway(inactive.fetchFn).find(ACCOUNT, TRAN)).toEqual({
      kind: 'problem',
      problem: 'rejected',
    });
    const live = answering({ APIConnect: 'DONE' });
    await new SslcommerzGateway(live.fetchFn).test({ ...ACCOUNT, mode: 'live' });
    expect(live.calls[0]?.url.startsWith('https://securepay.sslcommerz.com/')).toBe(true);
  });
});

describe('fake gateway (step 27d.3)', () => {
  const fake = new FakeGateway();

  it("opens the shop's own fake page with the try and the amount", async () => {
    const page = await fake.openPage(ACCOUNT, REQUEST);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const url = new URL(page.url);
    expect(url.origin).toBe('http://nirvor.localhost:4321');
    expect(url.pathname).toBe(SHOP_FAKE_GATEWAY_PATH);
    expect(url.searchParams.get('tranId')).toBe(TRAN);
    expect(url.searchParams.get('amount')).toBe('578.0000');
  });

  it('pays what its val_id says, less a 2.5% fee, and knows nothing by tran_id', async () => {
    const paid = await fake.validate(
      ACCOUNT,
      fakeValId(TRAN, { outcome: 'paid', amount: '578.0000' }),
    );
    expect(paid).toMatchObject({
      kind: 'paid',
      tranId: TRAN,
      amount: '578.0000',
      storeAmount: '563.5500',
    });
    expect(await fake.validate(ACCOUNT, fakeValId(TRAN, { outcome: 'cancelled' }))).toEqual({
      kind: 'cancelled',
    });
    expect(await fake.validate(ACCOUNT, '2611221045371uQe8kz1lO')).toEqual({ kind: 'none' });
    expect(await fake.find(ACCOUNT)).toEqual({ kind: 'none' });
  });

  it('answers like a bad day for its two special store ids', async () => {
    expect(await fake.test(ACCOUNT)).toBeNull();
    expect(await fake.test({ ...ACCOUNT, storeId: 'fake_rejected' })).toBe('rejected');
    expect(await fake.openPage({ ...ACCOUNT, storeId: 'fake_unreachable' }, REQUEST)).toEqual({
      ok: false,
      problem: 'unreachable',
    });
  });
});
```

The SSLCommerz tests answer with a fake `fetch` and check what was sent: all three return addresses on one path,
the amount with two decimals, the address on one line, the `.invalid` email, the validator's address with the
store in its query, and the live address for a live account. The `find()` test lists the attempts in the order
that must lose (`FAILED` before `VALIDATED`), so a `find()` that took the first attempt fails it.

### The account reader and readiness

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PaymentGatewayMode } from '@omnivo/contracts';
import { storefrontPaymentGateways } from '@omnivo/db';
import { eq } from 'drizzle-orm';

import type { PaymentsConfig } from '../config.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { PAYMENTS_CONFIG, WITH_TENANT } from '../infra/tokens.js';
import { openSecret } from '../payments/credentials.js';
import type { GatewayAccount } from '../payments/gateway.js';

// A workspace's gateway account, opened for one call, with the two accounts its money goes to
export interface OpenGatewayAccount extends GatewayAccount {
  moneyAccountId: string;
  feeAccountId: string;
}

// Step 27d (decision 4): the one place that reads a shop's gateway account and opens its password.
// As omnivo_app, inside the shop's workspace: the shop's own roles (omnivo_public, omnivo_shop)
// have no grant on the table (27d.2), so the order routes, which run as omnivo_shop, come here for
// it in a transaction of their own. The API's routes and the worker's sweep both use it.
@Injectable()
export class GatewayAccounts {
  private readonly logger = new Logger(GatewayAccounts.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
  ) {}

  // The account, or null: none saved, or its password cannot be opened (no CREDENTIALS_KEY on this
  // server, or one other than the key that sealed it). A payment then waits, it is never refused
  // with a 500. `mode` is a try's own: its answer is asked where it was started (27d.2's mine 20)
  async open(tenantId: string, mode?: PaymentGatewayMode): Promise<OpenGatewayAccount | null> {
    const row = await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const [found] = await tx
          .select()
          .from(storefrontPaymentGateways)
          .where(eq(storefrontPaymentGateways.tenantId, tenantId));
        return found;
      }),
    );
    if (row === undefined) return null;
    const key = this.config.credentialsKey;
    const password =
      key === null ? null : openSecret(key, tenantId, row.passwordSealed, row.keyVersion);
    if (password === null) {
      // The workspace and why, never the value
      this.logger.error(
        `The gateway password of tenant ${tenantId} cannot be opened (${key === null ? 'no CREDENTIALS_KEY' : `key version ${String(row.keyVersion)}`})`,
      );
      return null;
    }
    return {
      provider: row.provider,
      mode: mode ?? row.mode,
      storeId: row.storeId,
      password,
      moneyAccountId: row.moneyAccountId,
      feeAccountId: row.feeAccountId,
    };
  }
}
```

- **The one place that reads the gateway account and opens its password**, as `omnivo_app` inside the shop's
  workspace (`runWithTenant` then `withTenant`). The shop's own roles have no grant on the table (27d.2), so the
  order routes, which run as `omnivo_shop`, come here in a transaction of their own.
- **`mode` is the try's own** (27d.2's mine 20): the answer is asked where the page was opened.
- **`null` for "cannot use it now"**: none saved, no key on this server, or a key other than the one that sealed
  it. The log names the workspace and the reason, never the value.

```ts
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';

const readySchema = z.object({ ready: z.boolean() });

// Step 27d: whether the shop of this transaction's workspace can take online payment now (mine
// 22): its gateway is saved and both of its accounts still fit. The database's own function
// (0076), because the shop's pages run as omnivo_public, which may read neither the gateway nor
// the chart of accounts. The checkout (offeredMethods), the Payment card's `ready` and the
// settings' save all ask here, so they never disagree
export async function onlineReady(tx: Transaction): Promise<boolean> {
  const [row] = z
    .array(readySchema)
    .parse(await tx.execute(sql`SELECT storefront_online_ready() AS ready`));
  return row?.ready ?? false;
}
```

`storefront_online_ready()` (27d.2) is read in three places: the checkout's methods, the Payment card's `ready`,
and the settings' save. One helper keeps them asking the same question.

### The Payment card

```diff
@@ -25,6 +25,11 @@ export const PAYMENT_GATEWAY_MODES = ['sandbox', 'live'] as const;
 // - unreachable: no answer in time, or one that is not the gateway's
 export const PAYMENT_GATEWAY_TEST_PROBLEMS = ['rejected', 'unreachable'] as const;
 
+// Step 27d.3: the three lists as types, for the API's gateway code (payments/gateway.ts)
+export type PaymentGatewayProvider = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
+export type PaymentGatewayMode = (typeof PAYMENT_GATEWAY_MODES)[number];
+export type PaymentGatewayTestProblem = (typeof PAYMENT_GATEWAY_TEST_PROBLEMS)[number];
+
 // SSLCommerz's store ids are letters and digits ("nirvo67412bc0d9f1e"); the dash and underscore
 // cover other gateways' ids. Trimmed: a store id copied from an email often brings a space. The
 // pattern takes an empty box (`*`), because Zod runs every check: with `+` an empty box would say
```

The three lists as types, for the gateway code. Written from the lists (`(typeof …)[number]`), so a new mode is one
change.

```diff
@@ -749,6 +749,9 @@ export const ERROR_CODES = [
   'storefront_gateway_set_up_already',
   'storefront_gateway_not_set_up',
   'storefront_online_not_ready',
+  // Step 27d.3: the server has no CREDENTIALS_KEY, so it cannot seal a gateway password (or open
+  // one). Said on the Payment card instead of failing with a 500
+  'storefront_gateway_key_missing',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```
```diff
@@ -8364,6 +8364,8 @@ export const en = {
     storefront_gateway_not_set_up: 'Save the payment gateway first.',
     storefront_online_not_ready:
       'Save the payment gateway with its two accounts before you tick Pay online.',
+    storefront_gateway_key_missing:
+      'This server cannot keep a gateway password yet. Ask whoever runs Omnivo for you to set CREDENTIALS_KEY.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```
```diff
@@ -7786,6 +7786,8 @@ export const bn: Messages = {
     storefront_gateway_not_set_up: 'আগে পেমেন্ট গেটওয়ে সেভ করুন।',
     storefront_online_not_ready:
       'অনলাইনে পেমেন্টে টিক দেওয়ার আগে দুটো অ্যাকাউন্টসহ পেমেন্ট গেটওয়ে সেভ করুন।',
+    storefront_gateway_key_missing:
+      'এই সার্ভার এখনো পেমেন্ট গেটওয়ের পাসওয়ার্ড রাখতে পারে না। যিনি আপনার Omnivo চালান, তাঁকে CREDENTIALS_KEY সেট করতে বলুন।',
   },
   ui: {
     dataTable: {
```

The one new error code (mine 28). The words say who can fix it: the person who runs the server, not the shop's
staff.

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateStorefrontPaymentGatewayInput,
  type ErrorCode,
  moneyAccountIds,
  type PaymentGatewayTestProblem,
  type StorefrontAccountChoice,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  type UpdateStorefrontPaymentGatewayInput,
} from '@omnivo/contracts';
import { ledgerAccounts, storefrontPaymentGateways } from '@omnivo/db';
import { asc, eq, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { AppError, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { PaymentsConfig } from '../../config.js';
import { PAYMENT_GATEWAY, PAYMENTS_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { type CredentialsKey, openSecret, sealSecret } from '../../payments/credentials.js';
import type { PaymentGateway } from '../../payments/gateway.js';
import { onlineReady } from '../online-ready.js';

type GatewayRow = typeof storefrontPaymentGateways.$inferSelect;

function notSetUp(): AppError {
  return new AppError(409, 'storefront_gateway_not_set_up', 'Save the payment gateway first.');
}

function accountError(field: 'moneyAccountId' | 'feeAccountId', code: ErrorCode): AppError {
  return new AppError(422, code, 'Pick another account.', { fieldErrors: { [field]: [code] } });
}

// The chart as the two selects need it: every account, small enough to read whole (a few hundred
// at most, as for the receipt form's moneyAccountIds)
async function chartOf(tx: Transaction) {
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      parentId: ledgerAccounts.parentId,
      isGroup: ledgerAccounts.isGroup,
      holdsMoney: ledgerAccounts.holdsMoney,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, getTenantId()))
    .orderBy(asc(ledgerAccounts.code));
  const money = moneyAccountIds(
    rows.map((row) => ({ ...row, archivedAt: row.archivedAt?.toISOString() ?? null })),
  );
  const choice = (row: (typeof rows)[number]): StorefrontAccountChoice => ({
    id: row.id,
    code: row.code,
    name: row.name,
  });
  return {
    // What storefront_online_ready() accepts, read the same way: a money account is a posting
    // account that holds money (itself or a group above it); a fee account an active expense one
    moneyAccounts: rows.filter((row) => money.has(row.id)).map(choice),
    feeAccounts: rows
      .filter((row) => row.type === 'expense' && !row.isGroup && row.archivedAt === null)
      .map(choice),
    codeOf: new Map(rows.map((row) => [row.id, row.code])),
  };
}

// The audit's view: plain values only, and never the password. A changed password is written as
// the word "changed" under its own field, so the log says that it changed and nothing more
function snapshot(row: GatewayRow, codes: ReadonlyMap<string, string>) {
  return {
    storeId: row.storeId,
    mode: row.mode,
    moneyAccount: codes.get(row.moneyAccountId) ?? row.moneyAccountId,
    feeAccount: codes.get(row.feeAccountId) ?? row.feeAccountId,
  };
}

// Step 27d: Shop settings → Payment (decision 4). One row per workspace: the first save makes it
// (POST), later saves change it (PUT, with the version), "Test connection" asks the gateway with
// what is saved. The password is sealed here (CREDENTIALS_KEY) and never answered.
@Injectable()
export class StorefrontPaymentGatewayService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  setup(): Promise<StorefrontPaymentSetup> {
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, false);
      const chart = await chartOf(tx);
      return {
        gateway: row === null ? null : await this.toGateway(tx, row),
        moneyAccounts: chart.moneyAccounts,
        feeAccounts: chart.feeAccounts,
      };
    });
  }

  create(input: CreateStorefrontPaymentGatewayInput): Promise<StorefrontPaymentGateway> {
    const key = this.key();
    return this.withTenant(async (tx) => {
      const chart = await this.checkAccounts(tx, input);
      const { sealed, keyVersion } = sealSecret(key, getTenantId(), input.password);
      const [row] = await tx
        .insert(storefrontPaymentGateways)
        .values({
          tenantId: getTenantId(),
          provider: 'sslcommerz',
          storeId: input.storeId,
          mode: input.mode,
          passwordSealed: sealed,
          keyVersion,
          moneyAccountId: input.moneyAccountId,
          feeAccountId: input.feeAccountId,
          updatedBy: currentPrincipal().userId,
        })
        // Two tabs, or a double click: the second first save finds the row (as the shop's own
        // settings do). Not an upsert, which would overwrite the other save without its version
        .onConflictDoNothing({ target: storefrontPaymentGateways.tenantId })
        .returning();
      if (row === undefined) {
        throw new AppError(
          409,
          'storefront_gateway_set_up_already',
          'The payment gateway is saved already.',
        );
      }
      await audit(tx, {
        action: 'storefront_payment_gateway.created',
        entityType: 'storefront_payment_gateway',
        entityId: row.tenantId,
        changes: created({ ...snapshot(row, chart.codeOf), password: 'changed' }),
      });
      return this.toGateway(tx, row);
    });
  }

  update(input: UpdateStorefrontPaymentGatewayInput): Promise<StorefrontPaymentGateway> {
    // An empty box keeps the saved password, so only a new one needs the key
    const key = input.password === '' ? null : this.key();
    return this.withTenant(async (tx) => {
      const before = await this.find(tx, true);
      if (before === null) throw notSetUp();
      if (before.version !== input.version) throw versionConflict();
      const chart = await this.checkAccounts(tx, input);
      const sealed = key === null ? null : sealSecret(key, getTenantId(), input.password);
      // A new password that is the old one is no change (the audit and the last test agree). Only
      // checkable when the saved one opens; when it does not, the new one is a change anyway
      const passwordChanged =
        sealed !== null &&
        (key === null ||
          openSecret(key, getTenantId(), before.passwordSealed, before.keyVersion) !==
            input.password);
      // The last test said something about the store id, the password and the address (mode);
      // a change to any of them makes it say nothing any more. The accounts are not tested
      const reach =
        passwordChanged || input.storeId !== before.storeId || input.mode !== before.mode;
      const [after] = await tx
        .update(storefrontPaymentGateways)
        .set({
          storeId: input.storeId,
          mode: input.mode,
          moneyAccountId: input.moneyAccountId,
          feeAccountId: input.feeAccountId,
          ...(passwordChanged
            ? { passwordSealed: sealed.sealed, keyVersion: sealed.keyVersion }
            : {}),
          ...(reach ? { lastTestedAt: null, lastTestProblem: null } : {}),
          version: sql`${storefrontPaymentGateways.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(eq(storefrontPaymentGateways.tenantId, getTenantId()))
        .returning();
      if (after === undefined) throw notSetUp();
      await audit(tx, {
        action: 'storefront_payment_gateway.updated',
        entityType: 'storefront_payment_gateway',
        entityId: after.tenantId,
        changes: {
          ...diff(snapshot(before, chart.codeOf), snapshot(after, chart.codeOf)),
          ...(passwordChanged ? { password: { from: null, to: 'changed' } } : {}),
        },
      });
      return this.toGateway(tx, after);
    });
  }

  // "Test connection" (decision 4): the saved store id and password, at the saved mode's address.
  // The answer is kept (lastTest), and a refusal is an answer, not an error of this call
  async test(): Promise<StorefrontPaymentGateway> {
    const key = this.key();
    const saved = await this.withTenant((tx) => this.find(tx, false));
    if (saved === null) throw notSetUp();
    const password = openSecret(key, saved.tenantId, saved.passwordSealed, saved.keyVersion);
    // A password this key cannot open (sealed by another key) cannot reach the gateway either:
    // it is refused, and saving it again seals it with this server's key
    const problem: PaymentGatewayTestProblem | null =
      password === null
        ? 'rejected'
        : await this.gateway.test({
            provider: saved.provider,
            mode: saved.mode,
            storeId: saved.storeId,
            password,
          });
    // The gateway is asked outside the transaction: no row stays locked while SSLCommerz thinks
    return this.withTenant(async (tx) => {
      const row = await this.find(tx, true);
      if (row === null) throw notSetUp();
      const testedAt = new Date();
      const [after] = await tx
        .update(storefrontPaymentGateways)
        // No version bump: a test changes no value the form holds, so a form open in another tab
        // can still be saved
        .set({ lastTestedAt: testedAt, lastTestProblem: problem })
        .where(eq(storefrontPaymentGateways.tenantId, getTenantId()))
        .returning();
      if (after === undefined) throw notSetUp();
      await audit(tx, {
        action: 'storefront_payment_gateway.tested',
        entityType: 'storefront_payment_gateway',
        entityId: after.tenantId,
        changes: created({ testResult: problem ?? 'ok' }),
      });
      return this.toGateway(tx, after);
    });
  }

  // The two selects' answers, checked like the readiness function reads them
  private async checkAccounts(
    tx: Transaction,
    input: { moneyAccountId: string; feeAccountId: string },
  ) {
    const chart = await chartOf(tx);
    if (!chart.moneyAccounts.some((account) => account.id === input.moneyAccountId)) {
      throw accountError('moneyAccountId', 'storefront_gateway_money_account_invalid');
    }
    // Never the money account itself: the fee would be posted against the money it came out of
    // (27d.2's accounts check). A money account is never an expense, so the list check covers it
    if (!chart.feeAccounts.some((account) => account.id === input.feeAccountId)) {
      throw accountError('feeAccountId', 'storefront_gateway_fee_account_invalid');
    }
    return chart;
  }

  private key(): CredentialsKey {
    const key = this.config.credentialsKey;
    if (key === null) {
      throw new AppError(
        422,
        'storefront_gateway_key_missing',
        'This server has no CREDENTIALS_KEY, so it cannot keep a gateway password.',
      );
    }
    return key;
  }

  private async find(tx: Transaction, lock: boolean): Promise<GatewayRow | null> {
    const query = tx
      .select()
      .from(storefrontPaymentGateways)
      .where(eq(storefrontPaymentGateways.tenantId, getTenantId()));
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
  }

  private async toGateway(tx: Transaction, row: GatewayRow): Promise<StorefrontPaymentGateway> {
    return {
      provider: row.provider,
      storeId: row.storeId,
      mode: row.mode,
      moneyAccountId: row.moneyAccountId,
      feeAccountId: row.feeAccountId,
      ready: await onlineReady(tx),
      lastTest:
        row.lastTestedAt === null
          ? null
          : { at: row.lastTestedAt.toISOString(), problem: row.lastTestProblem },
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
```

- **`chartOf()` reads the whole chart once** and filters it the way `storefront_online_ready()` reads it: money
  accounts through `moneyAccountIds()` (posting accounts that hold money, themselves or through a group above
  them), fee accounts as active expense posting accounts. The selects then offer only what the save accepts. It
  also gives the codes the audit log writes instead of ids.
- **The snapshot never has the password.** A changed password is written as the word "changed" under its own field,
  so the log says that it changed and nothing more (27d.1's audit words).
- **`create()` asks for the key before the transaction.** With no key there is nothing to seal; the refusal comes
  before any database work.
- **`onConflictDoNothing` on the tenant's id**, as the shop's own settings do: a second first save (two tabs, a
  double click) finds the row and is refused with `storefront_gateway_set_up_already`. An upsert would overwrite the
  other save without its version.
- **`update()` keeps the saved password when the box is empty**, and needs the key only for a new one. A new
  password that is the same as the saved one is no change (mine 42); this can be checked only when the saved one
  opens.
- **The last test is cleared only when the store id, the password or the mode changes** (mine 42). The accounts are
  not tested, so changing them leaves the test standing.
- **`test()` asks the gateway outside any transaction.** It reads the row, asks SSLCommerz (up to 10 seconds), then
  locks the row in a second transaction to write the answer. No row stays locked while SSLCommerz thinks.
- **A password this server cannot open is "rejected"**, without asking: it could not reach the gateway either, and
  saving it again seals it with this server's key.
- **A test does not move the version**: it changes nothing the form holds, so a form open in another tab can still
  be saved.
- **`checkAccounts()`** refuses each select with its own field error. The money account can never also be the fee
  account here: a money account is never an expense, so the fee list leaves it out.
- **`toGateway()` reads `ready` from the database function**, so the card and the checkout agree.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontPaymentGatewayService } from './payment-gateway.service.js';

type Routes = typeof routes.storefrontPayments;

// Step 27d: Shop settings → Payment. The contract names the permission (storefront.manage) and
// the guard checks it before any of these runs
@Controller()
export class StorefrontPaymentsController {
  constructor(private readonly gateways: StorefrontPaymentGatewayService) {}

  @Endpoint(routes.storefrontPayments.getPaymentGateway)
  getPaymentGateway(): Promise<RouteResponse<Routes['getPaymentGateway']>> {
    return this.gateways.setup();
  }

  @Endpoint(routes.storefrontPayments.createPaymentGateway)
  createPaymentGateway({
    body,
  }: RouteInput<Routes['createPaymentGateway']>): Promise<
    RouteResponse<Routes['createPaymentGateway']>
  > {
    return this.gateways.create(body);
  }

  @Endpoint(routes.storefrontPayments.updatePaymentGateway)
  updatePaymentGateway({
    body,
  }: RouteInput<Routes['updatePaymentGateway']>): Promise<
    RouteResponse<Routes['updatePaymentGateway']>
  > {
    return this.gateways.update(body);
  }

  @Endpoint(routes.storefrontPayments.testPaymentGateway)
  testPaymentGateway(): Promise<RouteResponse<Routes['testPaymentGateway']>> {
    return this.gateways.test();
  }
}
```

### Settings and the checkout

```diff
@@ -5,6 +5,7 @@ import {
   type CreateStorefrontSettingsInput,
   defaultLineDescription,
   type ShopDeliveryZone,
+  type ShopPaymentMethod,
   type StorefrontReadiness,
   type StorefrontSettings,
   type StorefrontSetup,
@@ -28,6 +29,7 @@ import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-contex
 import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
 import type { Config } from '../../config.js';
 import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
+import { onlineReady } from '../online-ready.js';
 import { shopUrl } from '../shop-url.js';
 
 type SettingsRow = typeof storefrontSettings.$inferSelect;
@@ -128,6 +130,24 @@ function snapshot(row: SettingsRow) {
   };
 }
 
+// Step 27d (decision 4): Pay online can be newly ticked only while the gateway is ready. One that
+// was ticked already and is not ready now (an account archived since) stays as it is: the checkout
+// hides it by itself (offeredMethods), and a save of the shop's other settings is not refused for it
+async function checkOnline(
+  tx: Transaction,
+  methods: readonly ShopPaymentMethod[],
+  before: readonly ShopPaymentMethod[],
+): Promise<void> {
+  if (!methods.includes('online') || before.includes('online')) return;
+  if (await onlineReady(tx)) return;
+  throw new AppError(
+    422,
+    'storefront_online_not_ready',
+    'Save the payment gateway with its two accounts first.',
+    { fieldErrors: { paymentMethods: ['storefront_online_not_ready'] } },
+  );
+}
+
 // Step 26g: the shop's settings and its launch (decision 1). One row per workspace: the first
 // save makes it (POST), later saves change it (PUT, with the version), and "Open the shop" sets
 // launched_at once. Nothing here closes a shop again (step 26e: a shop is always open).
@@ -175,6 +195,7 @@ export class StorefrontSettingsService {
       return await this.withTenant(async (tx) => {
         await this.checkWarehouse(tx, input.defaultWarehouseId);
         const delivery = await this.checkDelivery(tx, input.deliveryVariantId, null);
+        await checkOnline(tx, input.paymentMethods, []);
         const [row] = await tx
           .insert(storefrontSettings)
           .values({
@@ -225,6 +246,7 @@ export class StorefrontSettingsService {
           await this.checkWarehouse(tx, input.defaultWarehouseId);
         }
         const delivery = await this.checkDelivery(tx, input.deliveryVariantId, before);
+        await checkOnline(tx, input.paymentMethods, before.paymentMethods);
         const [after] = await tx
           .update(storefrontSettings)
           .set({
```

`checkOnline()` refuses "Pay online" ticked for the first time while the gateway is not ready (mine 37), on the
checkbox group (`fieldErrors.paymentMethods`). One already ticked is left alone: the checkout hides it while it is
not ready, and refusing the whole save would stop the staff from changing anything else in the shop.

```diff
@@ -52,6 +52,7 @@ import {
 } from './listing-sql.js';
 import { quotedCoupon } from './coupon-sql.js';
 import { shopImage, type StorefrontImageSize } from './media.js';
+import { onlineReady } from './online-ready.js';
 import { quoteCart, type QuotedListing } from './quote.js';
 import { ShopDb, type ShopScope, storefrontNotFound } from './shop-db.js';
 
@@ -414,17 +415,21 @@ export async function checkoutSettingsOf(
     // A launched shop has one to six (storefront_settings_launch_check and zones_check); each
     // zone's shape is checked here, because jsonb holds whatever was written
     zones: z.array(shopDeliveryZoneSchema).parse(settings.zones),
-    paymentMethods: offeredMethods(settings.paymentMethods),
+    paymentMethods: offeredMethods(settings.paymentMethods, await onlineReady(tx)),
     freeDeliveryFrom: settings.freeDeliveryFrom,
     minimumOrder: settings.minimumOrder,
   };
 }
 
-// Step 27a: the payment methods the checkout offers. Mobile Banking needs the shop's own gateway,
-// which step 27c connects; until then an online order would only fail, so the checkout does not
-// show it. A shop that ticked Mobile Banking alone keeps it (the contract needs at least one
-// method), and placing such an order is refused as shop_payment_unavailable, which is true
-export function offeredMethods(methods: readonly ShopPaymentMethod[]): ShopPaymentMethod[] {
-  const working = methods.filter((method) => method !== 'online');
+// Step 27a: the payment methods the checkout offers. Step 27d: Pay online only while the shop's
+// gateway is ready (storefront_online_ready(): saved, and both accounts still fit), so unticking it
+// or archiving one of its accounts takes it off the checkout within the shop's one-minute cache. A
+// shop that ticked Pay online alone keeps it (the contract needs at least one method), and placing
+// such an order is refused as shop_payment_unavailable, which is true
+export function offeredMethods(
+  methods: readonly ShopPaymentMethod[],
+  onlineReady: boolean,
+): ShopPaymentMethod[] {
+  const working = methods.filter((method) => method !== 'online' || onlineReady);
   return working.length > 0 ? working : [...methods];
 }
```

`offeredMethods()` now takes the readiness. 27a dropped `online` always, because there was no gateway yet; now it
stays while the gateway is ready. The shop's one-minute cache means an unticked or broken gateway leaves the
checkout within a minute. The rule "a shop that ticked only online keeps it" stays, because the contract needs at
least one method; placing such an order is then refused.

### Confirming an order

```ts
import { type ShopPaymentMethod } from '@omnivo/contracts';
import { storefrontOrderCounters, storefrontOrders, storefrontStockHolds } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { emit } from '../../common/outbox/outbox.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { newToken, tokenHash } from './order-secrets.js';

// W-000123: W for web (26c's decision 3), counted per shop (27a's decision 20)
function orderNumber(value: number): string {
  return `W-${String(value).padStart(6, '0')}`;
}

// Step 27d.3: a pending order becomes confirmed, by a right phone code (27a) or by its payment
// (27d). Moved here out of ShopOrdersService.checkCode, so both take the same number, the same
// tracking token and the same events. The caller holds the order's row lock and knows it is
// pending. `paymentMethod` is set in the same UPDATE when the payment confirms an order that had
// turned into Cash on Delivery (decision 3): the method guard (27d.2) lets it change only while the
// row is still pending, which it is until this statement
export async function confirmPendingOrder(
  tx: Transaction,
  tenantId: string,
  orderId: string,
  now: Date,
  paymentMethod?: ShopPaymentMethod,
): Promise<{ orderNo: string; trackingToken: string }> {
  // The shop's next number. INSERT … ON CONFLICT: the first order of a shop makes its counter
  // row. The row's lock holds until this transaction ends, so two confirms in one shop take
  // turns, and a confirm that rolls back gives its number back (27a's decision 20)
  const [counter] = await tx
    .insert(storefrontOrderCounters)
    .values({ tenantId, lastValue: 1 })
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
      confirmedAt: now,
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      codeHash: null,
      codeExpiresAt: null,
      codeSentAt: null,
      codeSends: null,
      codeTriesLeft: null,
      version: sql`${storefrontOrders.version} + 1`,
    })
    .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)));
  // The stock stays held, now with no end, until 27b's challan takes it out for real
  await tx
    .update(storefrontStockHolds)
    .set({ expiresAt: null })
    .where(
      and(eq(storefrontStockHolds.tenantId, tenantId), eq(storefrontStockHolds.orderId, orderId)),
    );
  // In the same transaction (common/outbox): the bell now, and 27b's sales order
  await emit(tx, 'storefront.order_confirmed', { orderId });
  return { orderNo, trackingToken };
}
```

The end of 27a's `checkCode()`, moved here unchanged, so a right phone code and a payment confirm an order the same
way: the same counter, the same tracking token, the holds kept, the same event. One thing is new:
`paymentMethod`. An order that turned into Cash on Delivery ("Pay on delivery") and is then paid on the gateway's
page goes back to `online` in the same `UPDATE`. 27d.2's method guard allows that change only while the row is still
pending, which it is until this very statement.

```diff
@@ -19,9 +19,9 @@ import {
   type ShopTrackRequest,
 } from '@omnivo/contracts';
 import {
-  storefrontOrderCounters,
   storefrontOrderLines,
   storefrontOrders,
+  storefrontPayments,
   storefrontSettings,
   storefrontStockHolds,
   storefrontListings,
@@ -30,44 +30,41 @@ import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { AppError, notFound } from '../../common/http/app-error.js';
-import { emit } from '../../common/outbox/outbox.js';
 import type { Transaction } from '../../common/tenant/with-tenant.js';
 import type { Config } from '../../config.js';
 import { CONFIG } from '../../infra/tokens.js';
 import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
 import { SmsQueue } from '../../sms/sms-queue.js';
 import { lockedCoupon, markOrdered, usedByPhone } from '../coupon-sql.js';
+import { GatewayAccounts } from '../gateway-accounts.js';
 import { checkoutSettingsOf, quotedListings } from '../public-storefront.service.js';
 import { quoteCart } from '../quote.js';
 import { ShopDb, type ShopScope } from '../shop-db.js';
 import { shopUrl } from '../shop-url.js';
+import { confirmPendingOrder } from './confirm-order.js';
 import { codeHash, codeMatches, newCode, newToken, tokenHash } from './order-secrets.js';
 import { orderOf, type OrderRow, trackingOf } from './order-view.js';
+import { PaymentPages, tryValues } from './payment-pages.js';
 import { ShopLimits } from './shop-limits.js';
 
 const MINUTE_MS = 60 * 1000;
 
 const uuidSchema = z.uuid();
 
-function minutesAfter(at: Date, minutes: number): Date {
+export function minutesAfter(at: Date, minutes: number): Date {
   return new Date(at.getTime() + minutes * MINUTE_MS);
 }
 
 // Whole seconds from now until `at`, 0 once it has passed. Rounded up: "wait 0 seconds" would let
 // the next try in a moment too early
-function secondsUntil(at: Date, now: Date): number {
+export function secondsUntil(at: Date, now: Date): number {
   return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000));
 }
 
-// W-000123: W for web (26c's decision 3), counted per shop (27a's decision 20)
-function orderNumber(value: number): string {
-  return `W-${String(value).padStart(6, '0')}`;
-}
-
 // The answers a shopper can get wrong. Each status as the shop's mock answered it (26c's
 // server/orders.ts), so the shop's pages need no change: 409 for "look again, something
 // changed", 422 for "this cannot be done", 429 for "wait"
-function refused(
+export function refused(
   status: 404 | 409 | 422 | 429,
   code: ErrorCode,
   detail: string,
@@ -81,12 +78,12 @@ function noOrder(): AppError {
 }
 
 // What the shop's SMS need to know about the shop: its name and language
-interface ShopWords {
+export interface ShopWords {
   name: string;
   language: LanguageCode;
 }
 
-async function shopWords(tx: Transaction, shop: ShopScope): Promise<ShopWords> {
+export async function shopWords(tx: Transaction, shop: ShopScope): Promise<ShopWords> {
   const [settings] = await tx
     .select({ name: storefrontSettings.name, language: storefrontSettings.language })
     .from(storefrontSettings)
@@ -101,7 +98,7 @@ async function shopWords(tx: Transaction, shop: ShopScope): Promise<ShopWords> {
 // again by then (the holds' expires_at), so it can no longer be confirmed. `lock` takes the row for
 // this transaction (FOR UPDATE), so two codes typed at once are checked one after the other, and
 // five wrong ones cannot become six
-async function waitingOrder(
+export async function waitingOrder(
   tx: Transaction,
   shop: ShopScope,
   token: string,
@@ -157,12 +154,15 @@ export class ShopOrdersService {
     private readonly shopDb: ShopDb,
     private readonly sms: SmsQueue,
     private readonly limits: ShopLimits,
+    private readonly accounts: GatewayAccounts,
+    private readonly pages: PaymentPages,
     @Inject(CONFIG) private readonly config: Config,
   ) {
     this.mediaUrl = config.storefront.mediaUrl;
   }
 
-  // Confirm Order (27a's decision 2: Cash on Delivery waits for the phone code)
+  // Confirm Order (27a's decision 2: Cash on Delivery waits for the phone code). Step 27d: Pay
+  // online waits for its payment instead, on the gateway's page
   async place(
     host: string | undefined,
     client: string,
@@ -179,17 +179,26 @@ export class ShopOrdersService {
     const token = newToken();
     const orderTokenHash = tokenHash(token);
     const code = newCode();
-
-    const shop = await this.shopDb.orders(host, async (tx, scope) => {
+    const online = request.paymentMethod === 'online';
+    // Step 27d: the gateway account, before the order's transaction. It is read as omnivo_app (the
+    // shop's role may not), and the try's row copies its provider and mode. null: online payment
+    // cannot be taken now, which the transaction below refuses
+    const account = online
+      ? await this.shopDb
+          .read(host, (_tx, scope) => Promise.resolve(scope.tenantId))
+          .then((tenantId) => this.accounts.open(tenantId))
+      : null;
+
+    const placed = await this.shopDb.orders(host, async (tx, scope) => {
       const settings = await checkoutSettingsOf(tx, scope);
       const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
       if (!zone)
         throw refused(422, 'shop_zone_unknown', 'The delivery zone is not one the shop has.');
-      // Mobile Banking waits for step 27c's gateway; checkoutSettingsOf may still list it for a
-      // shop that ticked only that (offeredMethods)
+      // Step 27d: Pay online once the gateway is ready (offeredMethods) and its password opens.
+      // checkoutSettingsOf may still list it for a shop that ticked only that
       if (
-        request.paymentMethod === 'online' ||
-        !settings.paymentMethods.includes(request.paymentMethod)
+        !settings.paymentMethods.includes(request.paymentMethod) ||
+        (online && account === null)
       ) {
         throw refused(
           422,
@@ -286,11 +295,17 @@ export class ShopOrdersService {
           deliveryCharge: quote.deliveryCharge ?? '0',
           total: quote.total,
           orderTokenHash,
-          codeHash: codeHash(this.config.storefront.codeKey, orderTokenHash, code),
-          codeSentAt: scope.now,
-          codeExpiresAt: minutesAfter(scope.now, SHOP_CODE_VALID_MINUTES),
-          codeSends: 1,
-          codeTriesLeft: SHOP_CODE_TRIES,
+          // Step 27d: an online order waits for its payment, not for a code, so it has none of the
+          // five code columns (storefront_orders_pending_check, 27d.2)
+          ...(online
+            ? {}
+            : {
+                codeHash: codeHash(this.config.storefront.codeKey, orderTokenHash, code),
+                codeSentAt: scope.now,
+                codeExpiresAt: minutesAfter(scope.now, SHOP_CODE_VALID_MINUTES),
+                codeSends: 1,
+                codeTriesLeft: SHOP_CODE_TRIES,
+              }),
         })
         .returning({ id: storefrontOrders.id });
       // INSERT … RETURNING always gives the row it wrote; the check is for TypeScript
@@ -339,11 +354,41 @@ export class ShopOrdersService {
           expiresAt: until,
         })),
       );
-      return shopWords(tx, scope);
+      // Step 27d: the first payment try, in the same transaction as its order: an online order
+      // without one could never be paid
+      const [payment] =
+        account === null
+          ? []
+          : await tx
+              .insert(storefrontPayments)
+              .values(tryValues(scope.tenantId, order.id, 1, quote.total, account, scope.now))
+              .returning();
+      return {
+        words: await shopWords(tx, scope),
+        payment,
+        subdomain: scope.subdomain,
+        items: sold.reduce((sum, line) => sum + line.quantity, 0),
+        zoneName: zone.name,
+      };
     });
+    const shop = placed.words;
 
-    // Committed: now it counts, and now the code goes out
+    // Committed: now it counts
     await this.limits.countOrder(request.phone, client);
+    if (placed.payment !== undefined && account !== null) {
+      // Pay online: the gateway's page, asked for only now (decision 1). null when it did not
+      // open: the shop sends the browser to /checkout/paid, which offers "Try again"
+      const paymentUrl = await this.pages.open(host, placed.subdomain, account, placed.payment, {
+        customerName: request.name,
+        phone: request.phone,
+        address: request.address,
+        zoneName: placed.zoneName,
+        items: placed.items,
+        shopName: shop.name,
+      });
+      return { answer: { next: 'pay', paymentUrl }, token };
+    }
+    // Cash on Delivery: now the code goes out
     await this.sms.send({ to: request.phone, text: codeSms(shop.language, shop.name, code) });
     return {
       answer: {
@@ -449,50 +494,12 @@ export class ShopOrdersService {
       };
     }
 
-    // The shop's next number. INSERT … ON CONFLICT: the first order of a shop makes its counter
-    // row. The row's lock holds until this transaction ends, so two confirms in one shop take
-    // turns, and a confirm that rolls back gives its number back (27a's decision 20)
-    const [counter] = await tx
-      .insert(storefrontOrderCounters)
-      .values({ tenantId: shop.tenantId, lastValue: 1 })
-      .onConflictDoUpdate({
-        target: storefrontOrderCounters.tenantId,
-        set: { lastValue: sql`${storefrontOrderCounters.lastValue} + 1` },
-      })
-      .returning({ value: storefrontOrderCounters.lastValue });
-    if (counter === undefined) throw new Error('The order counter was not written');
-    const orderNo = orderNumber(counter.value);
-
-    // The tracking link's token is made now (27a's decision 9): a pending order is never tracked.
-    // Every code column is emptied in the same UPDATE (storefront_orders_pending_check)
-    const trackingToken = newToken();
-    await tx
-      .update(storefrontOrders)
-      .set({
-        status: 'confirmed',
-        orderNo,
-        trackingTokenHash: tokenHash(trackingToken),
-        confirmedAt: shop.now,
-        codeHash: null,
-        codeExpiresAt: null,
-        codeSentAt: null,
-        codeSends: null,
-        codeTriesLeft: null,
-        version: sql`${storefrontOrders.version} + 1`,
-      })
-      .where(where);
-    // The stock stays held, now with no end, until 27b's challan takes it out for real
-    await tx
-      .update(storefrontStockHolds)
-      .set({ expiresAt: null })
-      .where(
-        and(
-          eq(storefrontStockHolds.tenantId, shop.tenantId),
-          eq(storefrontStockHolds.orderId, order.id),
-        ),
-      );
-    // In the same transaction (common/outbox): the bell now, and 27b's sales order
-    await emit(tx, 'storefront.order_confirmed', { orderId: order.id });
+    const { orderNo, trackingToken } = await confirmPendingOrder(
+      tx,
+      shop.tenantId,
+      order.id,
+      shop.now,
+    );
 
     return {
       ok: true,
```

- **`checkCode()` now calls `confirmPendingOrder()`**, and `orderNumber()` moved with it.
- **Six helpers are exported** (`minutesAfter`, `secondsUntil`, `refused`, `ShopWords`, `shopWords`,
  `waitingOrder`) for the payment routes. They stay in this file, and the payment service imports them, never the
  other way round: two services that import each other would be a circle.
- **The gateway account is read before the order's transaction**: first the shop's tenant (a short read as
  `omnivo_public`), then the account as `omnivo_app`. The try's row copies its provider and mode, and the shop's
  role cannot read the account inside its own transaction.
- **An online order has none of the five code columns**, which 27d.2's pending rule asks for, and no code SMS.
- **The first try is written in the order's transaction.** An online order without a try could never be paid, and a
  try without its order cannot exist.
- **The page is asked for after the commit** (decision 1), so the order's locks are not held while SSLCommerz makes
  a session. The limits count the order before the page opens: a page that did not open is still an order placed.

### Recording the gateway's answer

```ts
import type { Logger } from '@nestjs/common';
import { compareMoney, type ShopPaymentStatus } from '@omnivo/contracts';
import { storefrontOrders, storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { emit } from '../../common/outbox/outbox.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { GatewayAnswer } from '../../payments/gateway.js';
import { confirmPendingOrder } from './confirm-order.js';

export type PaymentRow = typeof storefrontPayments.$inferSelect;

// What recording an answer did: the try's status after it, and, when this call confirmed the
// order, what the confirm SMS needs (the caller sends it once the transaction has committed)
export interface SettleResult {
  status: ShopPaymentStatus;
  confirmed: { orderNo: string; trackingToken: string; phone: string } | null;
}

// Why a "paid" answer is not this try's payment, or null when it is (decision 2). Each is a
// gateway answer the API refuses to believe: another try's payment, another amount, another
// currency. Never in the shopper's words: it is logged, and the try stays as it was, so the staff
// can look at it in SSLCommerz's own panel by its tran_id
function mismatch(
  payment: PaymentRow,
  answer: Extract<GatewayAnswer, { kind: 'paid' }>,
): string | null {
  if (answer.tranId !== payment.tranId) return 'another tran_id';
  if (answer.currency !== 'BDT') return `currency ${answer.currency}`;
  if (compareMoney(answer.amount, payment.amount) !== 0) return `amount ${answer.amount}`;
  // What the gateway pays out cannot be more than what it took (27d.2's amounts check); a store
  // amount above it would make a negative fee
  if (compareMoney(answer.storeAmount, answer.amount) > 0) return 'store_amount over the amount';
  return null;
}

// Step 27d: records what the gateway said about one try, in the caller's transaction. Three
// callers, on two roles: settle and /checkout/paid (ShopDb.orders, as omnivo_shop) and the
// worker's sweep (as omnivo_app). Both may write every column this writes (0076's grants).
//
// The order's row is locked first, then the try's: every other writer of an order's tries ("Try
// again", "Pay on delivery", the receipt job) locks the order first too, so two of them never wait
// for each other in a circle. With both locks held, a second call for the same payment (the
// browser's return and the IPN at once) finds the try paid already and changes nothing.
//
// null: the try is gone (its order was dropped with it)
export async function settleLocked(
  tx: Transaction,
  tenantId: string,
  paymentId: string,
  answer: GatewayAnswer,
  now: Date,
  logger: Logger,
): Promise<SettleResult | null> {
  const [found] = await tx
    .select({ orderId: storefrontPayments.orderId })
    .from(storefrontPayments)
    .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.id, paymentId)));
  if (found === undefined) return null;
  const [order] = await tx
    .select()
    .from(storefrontOrders)
    .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, found.orderId)))
    .for('update');
  const where = and(
    eq(storefrontPayments.tenantId, tenantId),
    eq(storefrontPayments.id, paymentId),
  );
  const [payment] = await tx.select().from(storefrontPayments).where(where).for('update');
  if (order === undefined || payment === undefined) return null;

  // Paid is final (27d.1's mine 11): the second of two calls, or a late "failed" after the money
  // came, changes nothing
  if (payment.status === 'paid') return { status: 'paid', confirmed: null };

  if (answer.kind === 'failed' || answer.kind === 'cancelled') {
    if (payment.status !== answer.kind) {
      await tx.update(storefrontPayments).set({ status: answer.kind, settledAt: now }).where(where);
    }
    return { status: answer.kind, confirmed: null };
  }
  // pending, none or a problem: nothing to record yet. A try that was started stays started, so a
  // later look (the IPN, /checkout/paid, the sweep) can still find it paid
  if (answer.kind !== 'paid') return { status: payment.status, confirmed: null };

  const wrong = mismatch(payment, answer);
  if (wrong !== null) {
    logger.error(
      `Payment ${payment.tranId} (tenant ${tenantId}): the gateway said paid, but ${wrong}`,
    );
    return { status: payment.status, confirmed: null };
  }

  await tx
    .update(storefrontPayments)
    .set({
      status: 'paid',
      settledAt: now,
      valId: answer.valId,
      cardType: answer.cardType,
      bankTranId: answer.bankTranId,
      storeAmount: answer.storeAmount,
    })
    .where(where);
  // The receipt is the worker's (decision 6), from the try's own row
  await emit(tx, 'storefront.payment_paid', { paymentId });

  // Still pending: this payment confirms it, even after its hold ended (decision 5: the money
  // came; the stock is checked again at Packed). An order that turned into Cash on Delivery and
  // was not confirmed yet goes back to online in the same UPDATE. An order confirmed already (the
  // shopper paid twice, or paid after typing the phone code) stays as it is: the receipt makes the
  // money an advance, and the order page says what to refund
  if (order.status !== 'pending') return { status: 'paid', confirmed: null };
  const confirmed = await confirmPendingOrder(
    tx,
    tenantId,
    order.id,
    now,
    order.paymentMethod === 'online' ? undefined : 'online',
  );
  return { status: 'paid', confirmed: { ...confirmed, phone: order.phone } };
}
```

- **Three callers on two roles**: settle and `/checkout/paid` as `omnivo_shop`, the sweep as `omnivo_app`. Every
  column this writes is in `omnivo_shop`'s grant (27d.2), so the same function works for both.
- **The order first, then the try** (mine 32). The try's order id is read first without a lock, then the order is
  locked, then the try. Every other writer of an order's tries takes the order's lock first, so no two of them can
  each hold one lock and wait for the other's.
- **Paid is final.** With both locks held, the second of two calls (the browser's return and the IPN at once) reads
  `paid` and changes nothing. This is 27d.2's second race.
- **Failed and cancelled are written only when they change something**, with the time of the answer.
- **`pending`, `none` and `problem` record nothing.** A started try stays started, so a later look can still find
  it paid.
- **`mismatch()`** (mine 33): the answer must name this try's `tran_id`, be in taka, be for the try's amount, and pay
  out no more than it took. A "paid" answer that fails any of these is logged and records nothing.
- **The event comes before the confirm**, in the same transaction: the receipt job (below) reads the try's row.
- **Still pending: the payment confirms it, even after the hold** (decision 5). An order confirmed already (paid
  twice, or paid after the phone code) stays as it is; its new receipt is an advance.

### Opening a page

```ts
import { randomInt } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';
import { storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { Config } from '../../config.js';
import { CONFIG, PAYMENT_GATEWAY } from '../../infra/tokens.js';
import type { PaymentGateway } from '../../payments/gateway.js';
import type { OpenGatewayAccount } from '../gateway-accounts.js';
import { ShopDb } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';

const TRAN_ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// 20 letters and digits from the OS's random source (27d.1's mine 12): about 103 bits, so a
// stranger cannot guess one. randomInt draws each one without the modulo bias of a byte % 36
export function newTranId(): string {
  let id = '';
  for (let index = 0; index < 20; index += 1) id += TRAN_ID_LETTERS[randomInt(36)] ?? '';
  return id;
}

// A try's row as placing an order and "Try again" write it. The account's provider and mode are
// copied, so the answer is asked where the page was opened (27d.2's mine 20)
export function tryValues(
  tenantId: string,
  orderId: string,
  tryNo: number,
  amount: string,
  account: OpenGatewayAccount,
  now: Date,
): typeof storefrontPayments.$inferInsert {
  return {
    tenantId,
    orderId,
    tryNo,
    tranId: newTranId(),
    provider: account.provider,
    mode: account.mode,
    amount,
    startedAt: now,
  };
}

// What the gateway's page shows about the order, from the order's own row
export interface PageOrder {
  customerName: string;
  phone: string;
  address: string;
  zoneName: string;
  items: number;
  shopName: string;
}

// Step 27d (decision 1): asks the gateway for a payment page, after the try's transaction has
// committed, so a slow SSLCommerz never holds the order's locks. A page that did not open marks
// the try not_opened (27d.1's mine 14): the order and its hold stay, and /checkout/paid offers
// "Try again" and "Pay on delivery".
@Injectable()
export class PaymentPages {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: Config,
    private readonly shopDb: ShopDb,
  ) {}

  async open(
    host: string | undefined,
    subdomain: string,
    account: OpenGatewayAccount,
    payment: { id: string; tranId: string; amount: string },
    order: PageOrder,
  ): Promise<string | null> {
    // On the shop's own address (decision 2): the gateway posts the browser back there, and the
    // shop's server passes the two ids on to the API
    const page = await this.gateway.openPage(account, {
      tranId: payment.tranId,
      amount: payment.amount,
      returnUrl: shopUrl(this.config.storefront, subdomain, SHOP_PAYMENT_RETURN_PATH),
      noticeUrl: shopUrl(this.config.storefront, subdomain, SHOP_PAYMENT_NOTICE_PATH),
      customer: {
        name: order.customerName,
        phone: order.phone,
        address: order.address,
        area: order.zoneName,
      },
      description: `Order from ${order.shopName}`,
      items: order.items,
    });
    if (page.ok) return page.url;
    // Only while it is still started: an answer that came in the meantime (it cannot, with no
    // page, but the rule costs nothing) is never overwritten
    await this.shopDb.orders(host, async (tx, shop) => {
      await tx
        .update(storefrontPayments)
        .set({ status: 'not_opened' })
        .where(
          and(
            eq(storefrontPayments.tenantId, shop.tenantId),
            eq(storefrontPayments.id, payment.id),
            eq(storefrontPayments.status, 'started'),
          ),
        );
    });
    return null;
  }
}
```

- **`newTranId()`** draws 20 characters with `randomInt(36)`, about 103 bits. `randomBytes` with `% 36` would make
  some letters more likely than others.
- **`tryValues()`** is the try's row as placing an order and "Try again" both write it.
- **The return and notice addresses are the shop's own** (decision 2), built from the shop's subdomain.
- **A page that did not open marks the try `not_opened`** (27d.1's mine 14), only while it is still `started`.
  The order and its hold stay, and `/checkout/paid` offers "Try again" and "Pay on delivery".

### The shop's payment routes

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  maskPhone,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_TRIES,
  SHOP_CODE_VALID_MINUTES,
  SHOP_ORDER_HOLD_MINUTES,
  SHOP_PAYMENT_TRIES,
  type ShopCodeWait,
  type ShopPaymentProblem,
  type ShopPaymentRetry,
  type ShopPaymentSettled,
  type ShopPaymentSettleRequest,
  type ShopPaymentWait,
} from '@omnivo/contracts';
import { storefrontOrderLines, storefrontOrders, storefrontPayments } from '@omnivo/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { notFound } from '../../common/http/app-error.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, PAYMENT_GATEWAY } from '../../infra/tokens.js';
import type { GatewayAnswer, PaymentGateway } from '../../payments/gateway.js';
import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { GatewayAccounts } from '../gateway-accounts.js';
import { checkoutSettingsOf } from '../public-storefront.service.js';
import { ShopDb, type ShopScope } from '../shop-db.js';
import { shopUrl } from '../shop-url.js';
import { codeHash, newCode, tokenHash } from './order-secrets.js';
import { PaymentPages, tryValues } from './payment-pages.js';
import { type PaymentRow, type SettleResult, settleLocked } from './payment-settle.js';
import { minutesAfter, refused, shopWords, waitingOrder } from './shop-orders.service.js';

type OrderRow = typeof storefrontOrders.$inferSelect;

function noPaymentOrder() {
  return refused(404, 'shop_payment_no_order', 'No online order waits for its payment here.');
}

function settledAlready() {
  return refused(409, 'shop_payment_settled', 'The order is paid, or it is cash on delivery now.');
}

// The words /checkout/paid uses for a try that did not pay
const PROBLEM_OF = {
  not_opened: 'not_opened',
  failed: 'failed',
  cancelled: 'cancelled',
  started: 'not_finished',
} as const satisfies Record<Exclude<PaymentRow['status'], 'paid'>, ShopPaymentProblem>;

// Step 27d: the four 'shop' routes of paying online (27d.1) and the gateway's answers. Like the
// phone code's routes, every write runs inside ShopDb.orders as omnivo_shop, and the gateway is
// asked outside any transaction, so no lock waits for SSLCommerz. The gateway account is read
// as omnivo_app (GatewayAccounts), because the shop's roles may not read it.
@Injectable()
export class ShopPaymentsService {
  private readonly logger = new Logger(ShopPaymentsService.name);

  constructor(
    private readonly shopDb: ShopDb,
    private readonly accounts: GatewayAccounts,
    private readonly pages: PaymentPages,
    private readonly sms: SmsQueue,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  // The return path and the notice (decision 2). Unknown tran_id: 404, as the contract says. The
  // API answers only the status: the shop's return path then sends the browser to /checkout/paid,
  // which asks paymentWait with the cookie
  async settle(
    host: string | undefined,
    { tranId, valId }: ShopPaymentSettleRequest,
  ): Promise<ShopPaymentSettled> {
    const found = await this.shopDb.orders(
      host,
      async (tx, shop) => {
        const [payment] = await tx
          .select()
          .from(storefrontPayments)
          .where(
            and(
              eq(storefrontPayments.tenantId, shop.tenantId),
              eq(storefrontPayments.tranId, tranId),
            ),
          );
        return payment === undefined ? null : { payment, tenantId: shop.tenantId };
      },
      { readOnly: true },
    );
    if (found === null) {
      // The order was dropped (the sweep, five wrong codes after "Pay on delivery") or the id was
      // made up. Logged with the id, so money that arrived for a dropped order can be found in
      // SSLCommerz's panel and paid back (mine)
      this.logger.warn(`The gateway came back for an unknown tran_id ${tranId}`);
      throw notFound('Payment');
    }
    if (found.payment.status === 'paid') return { status: 'paid' };
    const answer = await this.ask(found.tenantId, found.payment, valId);
    const result = await this.record(host, found.payment.id, answer);
    return { status: result?.status ?? found.payment.status };
  }

  // /checkout/paid (27d.1's shopPaymentWaitSchema). A try that is still started is asked about
  // first: the shopper may come back with the Back button, before or instead of the gateway's post
  async wait(host: string | undefined, token: string, asked = false): Promise<ShopPaymentWait> {
    const view = await this.shopDb.orders(host, (tx, shop) => this.view(tx, shop, token), {
      readOnly: true,
    });
    if (view === null) throw noPaymentOrder();
    const { order, payments, listingIds, payOnDelivery, now } = view;
    if (order.status !== 'pending') {
      // Confirmed by a payment: the page shows "Order Confirmed". An order confirmed by its phone
      // code is the verify page's, not this one's
      if (order.orderNo === null || !payments.some((payment) => payment.status === 'paid')) {
        throw noPaymentOrder();
      }
      return { state: 'paid', orderNo: order.orderNo, phone: order.phone, listingIds };
    }
    // An order that became Cash on Delivery waits for its code on /checkout/verify; one past its
    // hold can no longer be paid from here (a payment already on its way still settles it)
    if (
      order.paymentMethod !== 'online' ||
      order.createdAt <= minutesAfter(now, -SHOP_ORDER_HOLD_MINUTES)
    ) {
      throw noPaymentOrder();
    }
    const last = payments.at(-1);
    if (last?.status === 'started' && !asked) {
      const answer = await this.ask(order.tenantId, last, null);
      if (
        answer.kind === 'pending' ||
        (answer.kind === 'problem' && answer.problem === 'unreachable')
      ) {
        return { state: 'checking' };
      }
      const result = await this.record(host, last.id, answer);
      // Something changed: draw the page from the rows again, once
      if (result !== null && result.status !== 'started') return this.wait(host, token, true);
    }
    // A pending order's last try is never paid (a paid try confirms it in the same transaction);
    // an online order always has its first try (place order writes both together)
    const status = last === undefined || last.status === 'paid' ? 'started' : last.status;
    return {
      state: 'unpaid',
      problem: PROBLEM_OF[status],
      triesLeft: Math.max(0, SHOP_PAYMENT_TRIES - payments.length),
      payOnDelivery,
      total: order.total,
    };
  }

  // "Try again" (decision 3): a new try for the same order and hold
  async retry(host: string | undefined, token: string): Promise<ShopPaymentRetry> {
    const scope = await this.shopDb.read(host, (_tx, shop) => Promise.resolve(shop));
    const account = await this.accounts.open(scope.tenantId);
    let made: { payment: PaymentRow; order: OrderRow; items: number; shopName: string };
    try {
      made = await this.shopDb.orders(host, async (tx, shop) => {
        const order = await waitingOrder(tx, shop, token, { lock: true });
        if (order === undefined) throw noPaymentOrder();
        if (order.paymentMethod !== 'online') throw settledAlready();
        const payments = await this.paymentsOf(tx, shop, order.id);
        if (payments.some((payment) => payment.status === 'paid')) throw settledAlready();
        if (payments.length >= SHOP_PAYMENT_TRIES) {
          throw refused(422, 'shop_payment_tries_used', 'This order has used all its tries.');
        }
        // The gateway was removed from the shop, or its password no longer opens: a page could
        // not open, so no try is spent on it
        const settings = await checkoutSettingsOf(tx, shop);
        if (account === null || !settings.paymentMethods.includes('online')) {
          throw refused(
            422,
            'shop_payment_unavailable',
            'The shop does not take this payment now.',
          );
        }
        const [payment] = await tx
          .insert(storefrontPayments)
          .values(
            tryValues(shop.tenantId, order.id, payments.length + 1, order.total, account, shop.now),
          )
          .returning();
        if (payment === undefined) throw new Error('The payment try was not written');
        return {
          payment,
          order,
          items: await this.itemsOf(tx, shop, order.id),
          shopName: (await shopWords(tx, shop)).name,
        };
      });
    } catch (error) {
      // Two "Try again" at once wait for each other on the order's lock, so the second counts the
      // first one's try; the unique key is the database's word on it all the same (27d.2)
      if (isUniqueViolation(error, 'storefront_payments_try_key')) throw settledAlready();
      throw error;
    }
    // account is not null here: the transaction refused the request otherwise
    if (account === null) throw new Error('The gateway account went away');
    const paymentUrl = await this.pages.open(host, scope.subdomain, account, made.payment, {
      customerName: made.order.customerName,
      phone: made.order.phone,
      address: made.order.address,
      zoneName: made.order.zoneName,
      items: made.items,
      shopName: made.shopName,
    });
    return { paymentUrl };
  }

  // "Pay on delivery" (decision 3): the order becomes Cash on Delivery and gets its phone code.
  // A try that is still on its way may pay later all the same; settle then confirms the order as
  // online (payment-settle.ts)
  async payOnDelivery(host: string | undefined, token: string): Promise<ShopCodeWait> {
    const code = newCode();
    const result = await this.shopDb.orders(host, async (tx, shop) => {
      const order = await waitingOrder(tx, shop, token, { lock: true });
      if (order === undefined) throw noPaymentOrder();
      const listingIds = (await this.linesOf(tx, shop, order.id)).map((line) => line.listingId);
      // A second press (a double click, the Back button): it is Cash on Delivery already, and its
      // code went out. The answer is the verify page's again, with no new SMS
      if (order.paymentMethod === 'cod' && order.codeSentAt !== null) {
        return { sent: false as const, order, listingIds, words: null };
      }
      const payments = await this.paymentsOf(tx, shop, order.id);
      if (payments.some((payment) => payment.status === 'paid')) throw settledAlready();
      const settings = await checkoutSettingsOf(tx, shop);
      if (!settings.paymentMethods.includes('cod')) {
        throw refused(422, 'shop_payment_unavailable', 'The shop does not take cash on delivery.');
      }
      // The method and every code column in one UPDATE: storefront_orders_pending_check wants a
      // pending Cash on Delivery order with all five (27d.2)
      await tx
        .update(storefrontOrders)
        .set({
          paymentMethod: 'cod',
          codeHash: codeHash(this.config.storefront.codeKey, order.orderTokenHash, code),
          codeSentAt: shop.now,
          codeExpiresAt: minutesAfter(shop.now, SHOP_CODE_VALID_MINUTES),
          codeSends: 1,
          codeTriesLeft: SHOP_CODE_TRIES,
          version: sql`${storefrontOrders.version} + 1`,
        })
        .where(
          and(eq(storefrontOrders.tenantId, shop.tenantId), eq(storefrontOrders.id, order.id)),
        );
      return { sent: true as const, order, listingIds, words: await shopWords(tx, shop) };
    });
    if (result.sent) {
      await this.sms.send({
        to: result.order.phone,
        text: codeSms(result.words.language, result.words.name, code),
      });
    }
    return {
      next: 'verify',
      maskedPhone: maskPhone(result.order.phone),
      resendInSeconds: SHOP_CODE_RESEND_SECONDS,
      listingIds: result.listingIds,
    };
  }

  // What the gateway says about a try: by the val_id when the post brought one (the paid case),
  // else by our tran_id (a failed or cancelled try, or none). A val_id that is not a payment
  // (INVALID_TRANSACTION) is asked about by tran_id too. No account to ask with (the password does
  // not open): a problem the gateway's refusal stands for, so the shopper is not left "checking"
  async ask(tenantId: string, payment: PaymentRow, valId: string | null): Promise<GatewayAnswer> {
    const account = await this.accounts.open(tenantId, payment.mode);
    if (account === null) return { kind: 'problem', problem: 'rejected' };
    if (valId !== null) {
      const answer = await this.gateway.validate(account, valId);
      if (answer.kind !== 'none') return answer;
    }
    return this.gateway.find(account, payment.tranId);
  }

  // Records the answer as omnivo_shop, then sends the confirm SMS when this call confirmed the
  // order, after the commit (as a right phone code does)
  private async record(
    host: string | undefined,
    paymentId: string,
    answer: GatewayAnswer,
  ): Promise<SettleResult | null> {
    const result = await this.shopDb.orders(host, async (tx, shop) => {
      const settled = await settleLocked(
        tx,
        shop.tenantId,
        paymentId,
        answer,
        shop.now,
        this.logger,
      );
      return settled === null
        ? null
        : { settled, words: settled.confirmed === null ? null : await shopWords(tx, shop), shop };
    });
    if (result === null) return null;
    const { settled, words, shop } = result;
    if (settled.confirmed !== null && words !== null) {
      const link = shopUrl(
        this.config.storefront,
        shop.subdomain,
        `/t/${settled.confirmed.trackingToken}`,
      );
      await this.sms.send({
        to: settled.confirmed.phone,
        text: confirmedSms(words.language, words.name, settled.confirmed.orderNo, link),
      });
    }
    return settled;
  }

  // The order this browser's cookie names, in any status, with its tries, its listings and
  // whether the shop takes cash on delivery now
  private async view(tx: Transaction, shop: ShopScope, token: string) {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, shop.tenantId),
          eq(storefrontOrders.orderTokenHash, tokenHash(token)),
        ),
      );
    if (order === undefined) return null;
    const settings = await checkoutSettingsOf(tx, shop);
    return {
      order,
      payments: await this.paymentsOf(tx, shop, order.id),
      listingIds: (await this.linesOf(tx, shop, order.id)).map((line) => line.listingId),
      payOnDelivery: settings.paymentMethods.includes('cod'),
      now: shop.now,
    };
  }

  private paymentsOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select()
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, shop.tenantId),
          eq(storefrontPayments.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontPayments.tryNo));
  }

  private linesOf(tx: Transaction, shop: ShopScope, orderId: string) {
    return tx
      .select({
        listingId: storefrontOrderLines.listingId,
        quantity: storefrontOrderLines.quantity,
      })
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, shop.tenantId),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }

  // The pieces in the order, for the gateway's num_of_item
  private async itemsOf(tx: Transaction, shop: ShopScope, orderId: string): Promise<number> {
    const lines = await this.linesOf(tx, shop, orderId);
    return lines.reduce((sum, line) => sum + line.quantity, 0);
  }
}
```

- **`PROBLEM_OF`** maps a try that did not pay to the words of `/checkout/paid`. `satisfies Record<…>` makes a new
  status without its line here a type error.
- **`settle()`** finds the try in a read-only transaction, asks the gateway outside any transaction, then records
  the answer in a second one. A try paid already answers at once, without asking. An unknown `tran_id` is a 404 and
  a warning in the log (mine 39).
- **`wait()`** draws `/checkout/paid`. A confirmed order with a paid try is `paid`; a confirmed order without one
  was confirmed by its phone code, which is the verify page's business. A pending order that is Cash on Delivery
  now, or past its hold, is "no order" here (a payment already on its way still settles by its `tran_id`). A last
  try that is still `started` is asked about first (mine 43). When something changed, the page is drawn again from
  the rows, once (`asked`), so the answer is what the database now says.
- **`retry()`** reads the account before the transaction, like placing an order. Inside it: the order locked, the
  method still online, no paid try, fewer than three tries, and the gateway still offered (mine 41). Two presses at
  once take turns on the order's lock, so the second counts the first one's try; the unique key's error is mapped
  all the same, in case a future change drops the lock.
- **`payOnDelivery()`** writes the method and all five code columns in one `UPDATE`, which 27d.2's pending rule wants
  for a pending Cash on Delivery order. A second press finds it Cash on Delivery with its code sent, and answers the
  same verify page with no new SMS (mine 40). A try already on its way may still pay; settle then confirms the order
  as online.
- **`ask()`** validates by `val_id` when the post brought one, and asks by `tran_id` when it did not or when the
  `val_id` is no payment. No account to ask with answers `rejected`, so `/checkout/paid` shows "not finished"
  instead of "checking" for ever.
- **`record()`** sends the confirm SMS after the commit, as a right phone code does: an SMS for a confirm that
  rolled back would give out a tracking link for nothing.

```diff
@@ -5,6 +5,7 @@ import { Endpoint } from '../../common/http/endpoint.js';
 import { ShopClient } from '../shop-client.decorator.js';
 import { ShopHost } from '../shop-host.decorator.js';
 import { ShopOrdersService } from './shop-orders.service.js';
+import { ShopPaymentsService } from './shop-payments.service.js';
 
 type Routes = typeof routes.publicStorefront;
 
@@ -14,7 +15,10 @@ type Routes = typeof routes.publicStorefront;
 // an order or a tracking answer in a shared cache would be one buyer's details given to another.
 @Controller()
 export class ShopOrdersController {
-  constructor(private readonly orders: ShopOrdersService) {}
+  constructor(
+    private readonly orders: ShopOrdersService,
+    private readonly payments: ShopPaymentsService,
+  ) {}
 
   @Endpoint(routes.publicStorefront.placeOrder)
   @Header('Cache-Control', 'no-store')
@@ -80,4 +84,42 @@ export class ShopOrdersController {
   ): Promise<RouteResponse<Routes['track']>> {
     return this.orders.track(host, client, body);
   }
+
+  // Step 27d: paying online. The gateway's return and notice (settle), /checkout/paid (wait),
+  // "Try again" and "Pay on delivery"
+  @Endpoint(routes.publicStorefront.settlePayment)
+  @Header('Cache-Control', 'no-store')
+  settlePayment(
+    { body }: RouteInput<Routes['settlePayment']>,
+    @ShopHost() host: string | undefined,
+  ): Promise<RouteResponse<Routes['settlePayment']>> {
+    return this.payments.settle(host, body);
+  }
+
+  @Endpoint(routes.publicStorefront.paymentWait)
+  @Header('Cache-Control', 'no-store')
+  paymentWait(
+    { body }: RouteInput<Routes['paymentWait']>,
+    @ShopHost() host: string | undefined,
+  ): Promise<RouteResponse<Routes['paymentWait']>> {
+    return this.payments.wait(host, body.token);
+  }
+
+  @Endpoint(routes.publicStorefront.retryPayment)
+  @Header('Cache-Control', 'no-store')
+  retryPayment(
+    { body }: RouteInput<Routes['retryPayment']>,
+    @ShopHost() host: string | undefined,
+  ): Promise<RouteResponse<Routes['retryPayment']>> {
+    return this.payments.retry(host, body.token);
+  }
+
+  @Endpoint(routes.publicStorefront.payOnDelivery)
+  @Header('Cache-Control', 'no-store')
+  payOnDelivery(
+    { body }: RouteInput<Routes['payOnDelivery']>,
+    @ShopHost() host: string | undefined,
+  ): Promise<RouteResponse<Routes['payOnDelivery']>> {
+    return this.payments.payOnDelivery(host, body.token);
+  }
 }
```

The four routes, `no-store` like the other order routes: a payment's answer in a shared cache would be one
shopper's order given to another.

### The money receipt and the fee

```diff
@@ -1,5 +1,10 @@
 import { Injectable } from '@nestjs/common';
-import { type EntryRef, isZeroMoney, type SalesJournalSource } from '@omnivo/contracts';
+import {
+  type EntryRef,
+  isZeroMoney,
+  type SalesJournalSource,
+  subtractMoney,
+} from '@omnivo/contracts';
 import { journalEntries, journalLines, ledgerAccounts, tenantSettings } from '@omnivo/db';
 import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
 
@@ -72,14 +77,32 @@ export class SalesBooksService {
   // A money receipt: Dr the cash, bank or wallet account / Cr Accounts receivable (the customer),
   // both with the receipt's branch. The receivable comes down whether or not the money is applied
   // to an invoice: what the customer owes is the books' number, not the invoices'.
+  // Step 27d: a shop's online payment keeps the gateway's fee out of the money (decision 6). The
+  // fee is a second debit, to the fee account, in the receipt's own entry: Dr the money account for
+  // what the gateway pays out / Dr the fee account for its fee / Cr Accounts receivable for the
+  // whole amount. One entry, so voiding the receipt reverses the fee with it, and the receipt's
+  // source stays sales_receipt
   async receipt(
     tx: Transaction,
     document: DocumentRef,
-    input: { customerId: string; branchId: string; accountId: string; amount: string },
+    input: {
+      customerId: string;
+      branchId: string;
+      accountId: string;
+      amount: string;
+      fee?: { accountId: string; amount: string } | null;
+    },
   ): Promise<EntryRef> {
     const accounts = await this.accounts(tx);
+    const fee = input.fee == null || isZeroMoney(input.fee.amount) ? null : input.fee;
     return this.write(tx, document, 'sales_receipt', `Money receipt ${document.number}`, [
-      debit(input.accountId, input.branchId, null, input.amount),
+      debit(
+        input.accountId,
+        input.branchId,
+        null,
+        fee === null ? input.amount : subtractMoney(input.amount, fee.amount),
+      ),
+      ...(fee === null ? [] : [debit(fee.accountId, input.branchId, null, fee.amount)]),
       credit(accounts.receivable, input.branchId, input.customerId, input.amount),
     ]);
   }
```

`receipt()` takes an optional fee (mine 35). The money account gets what the gateway pays out, the fee account the
fee, and the receivable the whole amount, so the entry still balances and the customer's advance is the whole
amount the shopper paid. A fee of zero writes no line.

```diff
@@ -1,5 +1,6 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  compareMoney,
   overAllocated,
   type PartyRef,
   type Receipt,
@@ -18,7 +19,7 @@ import { datedAllocations, workspaceToday } from '../common/db/applied-on.js';
 import { isCheckViolation } from '../common/db/pg-errors.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { currentActorId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
@@ -117,55 +118,7 @@ export class ReceiptsService {
   async create(input: ReceiptInput): Promise<Receipt> {
     try {
       return await this.withTenant(async (tx) => {
-        const customer = await assertCustomer(tx, input.customerId);
-        await assertBranch(tx, input.branchId);
-        await assertMoneyAccount(tx, input.accountId, 'receipt_account_invalid');
-        const number = await this.numbering.next(tx, 'sales.receipt', input.date);
-        const [row] = await tx
-          .insert(receipts)
-          .values({
-            tenantId: getTenantId(),
-            number,
-            date: input.date,
-            customerId: customer.id,
-            amount: input.amount,
-            accountId: input.accountId,
-            method: input.method,
-            reference: input.reference,
-            branchId: input.branchId,
-            note: input.note,
-            createdBy: currentPrincipal().userId,
-            updatedBy: currentPrincipal().userId,
-          })
-          .returning();
-        if (!row) throw new Error('Receipt insert returned no row');
-        // The books first: a closed period refuses here, before any invoice is touched
-        const entry = await this.books.receipt(
-          tx,
-          { id: row.id, number, date: row.date },
-          {
-            customerId: customer.id,
-            branchId: row.branchId,
-            accountId: row.accountId,
-            amount: row.amount,
-          },
-        );
-        // Paid on the receipt's own day, like the books (step 21b, decision 25)
-        await this.apply(tx, row, input.allocations, row.date);
-        await audit(tx, {
-          action: 'receipt.created',
-          entityType: 'receipt',
-          entityId: row.id,
-          changes: created({
-            number,
-            date: row.date,
-            customer: customer.code,
-            amount: row.amount,
-            method: row.method,
-            entry: entry.number,
-            invoices: input.allocations.length,
-          }),
-        });
+        const row = await this.insert(tx, input, null);
         return this.read(tx, row.id);
       });
     } catch (error) {
@@ -173,6 +126,64 @@ export class ReceiptsService {
     }
   }
 
+  // Step 27d: a shop order's online payment (decision 6), made by the worker in the caller's
+  // transaction: posted at once, an advance (no invoice yet), with the gateway's fee in its entry.
+  // Refused with the receipt's own error codes (a closed period, a money account archived since)
+  async createForShop(
+    tx: Transaction,
+    input: ReceiptInput,
+    fee: { accountId: string; amount: string } | null,
+  ): Promise<string> {
+    return (await this.insert(tx, input, fee)).id;
+  }
+
+  // Step 27d: a receipt's money that is still free goes to a new invoice, as much as it still
+  // owes: a shop order's advance when its invoice is posted at Delivered. Like allocate(), but in
+  // the caller's transaction and for one invoice more, with the person or the worker as the actor.
+  // A voided receipt, or one with nothing left, applies nothing
+  async applyIn(tx: Transaction, receiptId: string, invoiceId: string): Promise<void> {
+    const [row] = await tx
+      .select()
+      .from(receipts)
+      .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, receiptId)))
+      .for('update');
+    if (row?.status !== 'posted') return;
+    const free = subtractMoney(subtractMoney(row.amount, row.refunded), row.applied);
+    const [invoice] = await tx
+      .select({
+        total: invoices.total,
+        paid: invoices.amountPaid,
+        credited: invoices.amountCredited,
+      })
+      .from(invoices)
+      .where(and(eq(invoices.tenantId, getTenantId()), eq(invoices.id, invoiceId)));
+    if (invoice === undefined) throw notFound('Invoice');
+    const due = subtractMoney(subtractMoney(invoice.total, invoice.paid), invoice.credited);
+    const amount = compareMoney(free, due) < 0 ? free : due;
+    if (compareMoney(amount, '0') <= 0) return;
+    const before = await this.allocationsOf(tx, receiptId);
+    // The allocations it has (none, for a shop's advance) and this invoice; checkAllocations()
+    // locks the invoice and checks the customer and the amount like the form's
+    const wanted = [
+      ...before.map((allocation) => ({
+        invoiceId: allocation.invoiceId,
+        amount: allocation.amount,
+      })),
+      { invoiceId, amount },
+    ];
+    await this.apply(tx, row, wanted, await workspaceToday(tx));
+    await tx
+      .update(receipts)
+      .set({ version: sql`${receipts.version} + 1`, updatedBy: currentActorId() })
+      .where(and(eq(receipts.tenantId, getTenantId()), eq(receipts.id, receiptId)));
+    await audit(tx, {
+      action: 'receipt.allocated',
+      entityType: 'receipt',
+      entityId: receiptId,
+      changes: allocationChanges(before, await this.allocationsOf(tx, receiptId)),
+    });
+  }
+
   // The whole list as the person left it: the money of an advance applied to a new invoice, or
   // moved from one invoice to another. Nothing in the books changes — the receivable is one
   // number per customer — only what each invoice still owes.
@@ -315,6 +326,68 @@ export class ReceiptsService {
     );
   }
 
+  // A new receipt, its entry, its allocations and its audit row: the form's (create) and a shop
+  // payment's (createForShop, step 27d). currentActorId(): the person, or null for the worker
+  private async insert(
+    tx: Transaction,
+    input: ReceiptInput,
+    fee: { accountId: string; amount: string } | null,
+  ): Promise<ReceiptRow> {
+    const customer = await assertCustomer(tx, input.customerId);
+    await assertBranch(tx, input.branchId);
+    await assertMoneyAccount(tx, input.accountId, 'receipt_account_invalid');
+    const number = await this.numbering.next(tx, 'sales.receipt', input.date);
+    const [row] = await tx
+      .insert(receipts)
+      .values({
+        tenantId: getTenantId(),
+        number,
+        date: input.date,
+        customerId: customer.id,
+        amount: input.amount,
+        accountId: input.accountId,
+        method: input.method,
+        reference: input.reference,
+        branchId: input.branchId,
+        note: input.note,
+        createdBy: currentActorId(),
+        updatedBy: currentActorId(),
+      })
+      .returning();
+    if (!row) throw new Error('Receipt insert returned no row');
+    // The books first: a closed period refuses here, before any invoice is touched
+    const entry = await this.books.receipt(
+      tx,
+      { id: row.id, number, date: row.date },
+      {
+        customerId: customer.id,
+        branchId: row.branchId,
+        accountId: row.accountId,
+        amount: row.amount,
+        fee,
+      },
+    );
+    // Paid on the receipt's own day, like the books (step 21b, decision 25)
+    await this.apply(tx, row, input.allocations, row.date);
+    await audit(tx, {
+      action: 'receipt.created',
+      entityType: 'receipt',
+      entityId: row.id,
+      changes: created({
+        number,
+        date: row.date,
+        customer: customer.code,
+        amount: row.amount,
+        method: row.method,
+        entry: entry.number,
+        invoices: input.allocations.length,
+        // Step 27d: the gateway's fee, only when there is one
+        ...(fee === null ? {} : { fee: fee.amount }),
+      }),
+    });
+    return row;
+  }
+
   // FOR UPDATE: an allocate and a void of one receipt take turns. A voided receipt is final.
   private async lock(tx: Transaction, id: string, version: number): Promise<ReceiptRow> {
     const [row] = await tx
```

- **`insert()`** is the old `create()`'s body, shared by the form and the shop. It uses `currentActorId()`, which is
  the person on a route and `null` in the worker (27b's rule for code both reach). The audit row names the fee when
  there is one.
- **`createForShop()`** runs in the caller's transaction, so the receipt and the try's link to it commit together.
- **`applyIn()`** gives a receipt's free money to one more invoice, as much as it still owes. It is `allocate()`
  without the version and the person: the worker and the order page call it inside their own transactions.
  `checkAllocations()` still locks the invoice and checks the customer and the amount, as for the form.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { isZeroMoney, type PaymentMethod, subtractMoney } from '@omnivo/contracts';
import {
  ledgerAccounts,
  salesOrders,
  storefrontOrders,
  storefrontPaymentGateways,
  storefrontPayments,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';

import { workspaceToday } from '../../common/db/applied-on.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { ReceiptsService } from '../../sales/receipts.service.js';
import type { PaymentRow } from './payment-settle.js';

type OrderRow = typeof storefrontOrders.$inferSelect;

// SSLCommerz's card_type says how the shopper paid ("BKASH-BKash", "VISA-Dutch Bangla",
// "DBBLMOBILEB-Dbbl Mobile Banking"). The receipt's method is the nearest of ours: a wallet, a
// card, or else the bank (internet banking). Only the words before the dash are read
const WALLETS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'MCASH', 'TCASH', 'DBBLMOBILEB', 'OKWALLET'];
const CARDS = ['VISA', 'MASTER', 'AMEX', 'UNIONPAY', 'NEXUS', 'DBBL', 'QCASH'];

export function receiptMethodOf(cardType: string | null): PaymentMethod {
  const brand = (cardType ?? '').split('-')[0]?.toUpperCase().replace(/\s+/g, '') ?? '';
  if (WALLETS.some((wallet) => brand.startsWith(wallet))) return 'mobile_wallet';
  if (CARDS.some((card) => brand.startsWith(card))) return 'card';
  return 'bank_transfer';
}

// Step 27d (decision 6): a paid try's posted money receipt, with the gateway's fee in its entry,
// made by the worker (payment_paid, and the order's confirm after its sales order) and by "Make
// the receipt" on the order's page. Like 27b's sales order: a refusal by the receipt's own rules
// is kept on the try as its code, and the page's button is the retry.
@Injectable()
export class ShopPaymentReceipts {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly receipts: ReceiptsService,
  ) {}

  // Every paid try of the order that has no receipt and no error yet. Called once the order has
  // its sales order, which names the customer the receipt is for
  async makeAll(orderId: string): Promise<void> {
    const tenantId = getTenantId();
    const waiting = await this.withTenant((tx) =>
      tx
        .select({ id: storefrontPayments.id })
        .from(storefrontPayments)
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.orderId, orderId),
            eq(storefrontPayments.status, 'paid'),
            isNull(storefrontPayments.receiptId),
            isNull(storefrontPayments.receiptError),
          ),
        )
        .orderBy(asc(storefrontPayments.tryNo)),
    );
    // One transaction each: a second payment's refusal must not take the first one's receipt
    for (const { id } of waiting) await this.makeOne(orderId, id);
  }

  // One try's receipt, in its own transaction, the error kept when the receipt's rules refuse it.
  // Anything else (the database went away) is thrown, and the queue runs the job again
  async makeOne(orderId: string, paymentId: string): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const locked = await this.lock(tx, orderId, paymentId);
        if (locked === null) return;
        const { order, payment } = locked;
        // A second run, a try that is not paid, one whose receipt failed (the page's button makes
        // it), or an order whose sales order is not made yet (its confirm job comes back here)
        if (payment.status !== 'paid' || payment.receiptId !== null) return;
        if (payment.receiptError !== null || order.salesOrderId === null) return;
        await this.makeIn(tx, order, payment);
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.keepError(paymentId, error.code);
    }
  }

  // The order and the try, both locked: the order first, as every writer of its tries does
  // (payment-settle.ts says why)
  async lock(
    tx: Transaction,
    orderId: string,
    paymentId: string,
  ): Promise<{ order: OrderRow; payment: PaymentRow } | null> {
    const tenantId = getTenantId();
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)))
      .for('update');
    const [payment] = await tx
      .select()
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, tenantId),
          eq(storefrontPayments.id, paymentId),
          eq(storefrontPayments.orderId, orderId),
        ),
      )
      .for('update');
    return order === undefined || payment === undefined ? null : { order, payment };
  }

  // The receipt itself, in the caller's transaction. The caller holds both locks and has checked
  // that the try is paid with no receipt, and that the order has its sales order. Throws the
  // receipt's own AppError when its rules refuse
  async makeIn(tx: Transaction, order: OrderRow, payment: PaymentRow): Promise<string> {
    const tenantId = getTenantId();
    if (order.salesOrderId === null || payment.storeAmount === null) {
      throw new Error(`Payment ${payment.id} has no sales order or no payout to receive`);
    }
    const [gateway] = await tx
      .select({
        moneyAccountId: storefrontPaymentGateways.moneyAccountId,
        feeAccountId: storefrontPaymentGateways.feeAccountId,
      })
      .from(storefrontPaymentGateways)
      .where(eq(storefrontPaymentGateways.tenantId, tenantId));
    // A paid try always had a gateway (it opened the page), and nothing deletes one (27d.1)
    if (gateway === undefined) {
      throw new AppError(409, 'storefront_gateway_not_set_up', 'Save the payment gateway first.');
    }
    const fee = subtractMoney(payment.amount, payment.storeAmount);
    if (!isZeroMoney(fee)) await this.checkFeeAccount(tx, gateway.feeAccountId);
    // The customer and the branch of the sales order: the invoice at Delivered is for the same
    // customer, so it can take this advance
    const [salesOrder] = await tx
      .select({ customerId: salesOrders.customerId, branchId: warehouses.branchId })
      .from(salesOrders)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, salesOrders.tenantId),
          eq(warehouses.id, salesOrders.warehouseId),
        ),
      )
      .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, order.salesOrderId)));
    if (salesOrder === undefined) throw new Error(`Sales order ${order.salesOrderId} is missing`);

    const receiptId = await this.receipts.createForShop(
      tx,
      {
        customerId: salesOrder.customerId,
        // The day it is made, in the workspace's time zone: usually the payment's own day (the
        // job runs seconds later), and a retry after a closed period lands in an open one
        date: await workspaceToday(tx),
        amount: payment.amount,
        accountId: gateway.moneyAccountId,
        method: receiptMethodOf(payment.cardType),
        // The bank's or wallet's own number, which the shopper's SMS from bKash shows, and how
        // they paid; the receipt's box holds 60 characters
        reference: [payment.bankTranId ?? payment.tranId, payment.cardType]
          .filter((part) => part !== null)
          .join(' · ')
          .slice(0, 60),
        branchId: salesOrder.branchId,
        note: `Paid online for shop order ${order.orderNo ?? ''} (SSLCommerz ${payment.tranId})`,
        allocations: [],
      },
      isZeroMoney(fee) ? null : { accountId: gateway.feeAccountId, amount: fee },
    );
    await tx
      .update(storefrontPayments)
      .set({ receiptId, receiptError: null })
      .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.id, payment.id)));
    // Paid after it was delivered (a second payment, or one that came very late): the invoice is
    // there already, so the money goes to it now, as much as it still owes
    if (order.invoiceId !== null) await this.receipts.applyIn(tx, receiptId, order.invoiceId);
    return receiptId;
  }

  // Decision 6: the invoice posted at Delivered takes the advances of the order's paid tries, the
  // oldest first. A second payment (the shopper paid twice) finds nothing left to pay and stays an
  // advance, which the order page says to refund
  async applyToInvoice(tx: Transaction, orderId: string, invoiceId: string): Promise<void> {
    const paid = await tx
      .select({ receiptId: storefrontPayments.receiptId })
      .from(storefrontPayments)
      .where(
        and(
          eq(storefrontPayments.tenantId, getTenantId()),
          eq(storefrontPayments.orderId, orderId),
          isNotNull(storefrontPayments.receiptId),
        ),
      )
      .orderBy(asc(storefrontPayments.tryNo));
    for (const { receiptId } of paid) {
      if (receiptId !== null) await this.receipts.applyIn(tx, receiptId, invoiceId);
    }
  }

  // Kept only while the try has no receipt: the page's retry may have made it in the meantime
  async keepError(paymentId: string, code: string): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      await tx
        .update(storefrontPayments)
        .set({ receiptError: code })
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.id, paymentId),
            isNull(storefrontPayments.receiptId),
          ),
        );
    });
  }

  // The fee account as storefront_online_ready() wants it: an active expense posting account. One
  // archived after the payment refuses the receipt with the Payment card's own code
  private async checkFeeAccount(tx: Transaction, accountId: string): Promise<void> {
    const [account] = await tx
      .select({
        type: ledgerAccounts.type,
        isGroup: ledgerAccounts.isGroup,
        archivedAt: ledgerAccounts.archivedAt,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, getTenantId()), eq(ledgerAccounts.id, accountId)))
      .for('share');
    if (account?.type !== 'expense' || account.isGroup || account.archivedAt !== null) {
      throw new AppError(
        409,
        'storefront_gateway_fee_account_invalid',
        'The gateway fee account is no longer an active expense account.',
      );
    }
  }
}
```

- **`receiptMethodOf()`** maps SSLCommerz's `card_type` to the receipt's method: wallets (bKash, Nagad, Rocket,
  Upay…), cards (Visa, Mastercard, DBBL Nexus…), and the bank for the rest (internet banking). Only the words before
  the dash are read: the part after it is the bank's name.
- **`makeAll()` makes each receipt in its own transaction**, so one refused receipt does not take another's with it.
- **`makeOne()` skips** a try that is not paid, has a receipt already, has an error (the page's button retries it),
  or whose order has no sales order yet (the confirm job comes back here after it makes one). An `AppError` from the
  receipt's own rules (a closed period, an archived account) is kept on the try; anything else is thrown, and the
  queue runs the job again.
- **`lock()` takes the order first, then the try** (mine 32).
- **`makeIn()`**: the fee account is checked only when there is a fee; the customer and the branch come from the
  sales order, so the invoice at Delivered is for the same customer and can take this advance; the date is the day
  the receipt is made (mine 34); the reference fits the receipt's 60 characters. A receipt made after the invoice is
  applied to it at once (mine 36).
- **`applyToInvoice()`** applies the order's receipts to its new invoice, oldest try first.
- **`keepError()`** writes the error only while the try has no receipt: the page's retry may have made one in the
  meantime.

```diff
@@ -28,6 +28,9 @@ export const OUTBOX_EVENT_TYPES = [
   // Step 27a: a shop order got its right phone code. The worker rings the bell of the members who
   // read the orders; 27b also makes the customer and the sales order from it
   'storefront.order_confirmed',
+  // Step 27d: a payment try of a shop order was paid. The worker makes its money receipt (and the
+  // gateway's fee) once the order has its sales order (27d.2's mine 26)
+  'storefront.payment_paid',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```
```diff
@@ -58,6 +58,9 @@ export const outboxPayloadSchemas = {
   // the bell (and, from 27b, makes the sales order). Never the tracking token: that is a secret,
   // and it went to the buyer by SMS, straight from the API
   'storefront.order_confirmed': z.object({ orderId: z.uuid() }),
+  // Step 27d: one payment try was paid. Its row has the rest (amount, the gateway's numbers); the
+  // worker makes the posted money receipt. Never the val_id or the store's account
+  'storefront.payment_paid': z.object({ paymentId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```
```diff
@@ -32,6 +32,7 @@ const QUEUE_OF = {
   'report.schedule_due': 'jobs',
   'storefront.image_uploaded': 'jobs',
   'storefront.order_confirmed': 'jobs',
+  'storefront.payment_paid': 'jobs',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
```
```diff
@@ -21,6 +21,7 @@ import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
 import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
+import { PaymentPaidHandler } from '../storefront/orders/payment-paid.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
 // handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
@@ -52,6 +53,7 @@ export class EventHandlers {
     scheduleEmail: ReportScheduleEmailHandler,
     storefrontImage: StorefrontImageHandler,
     orderConfirmed: OrderConfirmedHandler,
+    paymentPaid: PaymentPaidHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -73,6 +75,7 @@ export class EventHandlers {
       'report.schedule_email': scheduleEmail,
       'storefront.image_uploaded': storefrontImage,
       'storefront.order_confirmed': orderConfirmed,
+      'storefront.payment_paid': paymentPaid,
     };
   }
 
```

The event 27d.2 left for this part (its mine 26): its name, its payload (only the try's id, never the `val_id` or
the account), its queue and its handler. The three maps are exhaustive, so the four lines go in together.

```ts
import { Inject, Injectable } from '@nestjs/common';
import { storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { ShopPaymentReceipts } from './payment-receipts.js';

// Step 27d (decision 6): a try was paid; make its money receipt. The order the payment confirmed
// has its order_confirmed job too, which makes the sales order and then the receipts: when this
// job comes first there is no sales order yet, makeOne does nothing, and that job makes it. A
// payment for an order confirmed long ago (the shopper paid twice) has its sales order, and this
// job is the one that makes its receipt
@Injectable()
export class PaymentPaidHandler implements EventHandler<'storefront.payment_paid'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly paymentReceipts: ShopPaymentReceipts,
  ) {}

  async handle(event: OutboxEvent<'storefront.payment_paid'>): Promise<void> {
    const tenantId = getTenantId();
    const [payment] = await this.withTenant((tx) =>
      tx
        .select({ orderId: storefrontPayments.orderId })
        .from(storefrontPayments)
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.id, event.payload.paymentId),
          ),
        ),
    );
    if (payment === undefined) return;
    await this.paymentReceipts.makeOne(payment.orderId, event.payload.paymentId);
  }
}
```
```diff
@@ -15,6 +15,7 @@ import { getTenantId } from '../../common/tenant/tenant-context.js';
 import type { WithTenant } from '../../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../../infra/tokens.js';
 import { notify } from '../../notifications/notify.js';
+import { ShopPaymentReceipts } from './payment-receipts.js';
 import { ShopSalesOrderMaker } from './sales-order-maker.js';
 
 // Step 27a: "New shop order W-000123 for ৳578" in the bell of the owners and of everyone who may
@@ -27,10 +28,16 @@ export class OrderConfirmedHandler implements EventHandler<'storefront.order_con
   constructor(
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
     private readonly maker: ShopSalesOrderMaker,
+    private readonly paymentReceipts: ShopPaymentReceipts,
   ) {}
 
   async handle(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
     await this.makeSalesOrder(event.payload.orderId);
+    // Step 27d: then the money receipts of its paid tries, which need the sales order's customer.
+    // The payment_paid job may have run before the sales order was made and done nothing; this
+    // one comes after it, so a paid order always gets its receipt (makeAll skips a try that has
+    // one already)
+    await this.paymentReceipts.makeAll(event.payload.orderId);
     await this.ring(event);
   }
 
```

Two jobs can make a receipt, because the two events of one settle can run in either order. When `payment_paid`
runs first, the order has no sales order yet and `makeOne()` does nothing; the confirm job then makes the sales
order and calls `makeAll()`. When the confirm job runs first, it makes both, and `payment_paid` finds the receipt
there. A payment for an order confirmed long ago (paid twice) has no confirm job, and `payment_paid` makes its
receipt. The order's row lock and 27d.2's unique receipt index make sure it is made once.

### The order page

```diff
@@ -30,6 +30,7 @@ import {
   parties,
   products,
   productVariants,
+  receipts,
   salesOrderLines,
   salesOrders,
   salesReturns,
@@ -37,6 +38,7 @@ import {
   storefrontImages,
   storefrontOrderLines,
   storefrontOrders,
+  storefrontPayments,
   storefrontSettings,
   storefrontStockHolds,
   tenantSettings,
@@ -63,6 +65,7 @@ import { SmsQueue } from '../../sms/sms-queue.js';
 import { isoText } from '../listing-sql.js';
 import { shopImage } from '../media.js';
 import { historyOf, type OrderLineRow, type OrderRow } from './order-view.js';
+import { ShopPaymentReceipts } from './payment-receipts.js';
 import { ShopSalesOrderMaker } from './sales-order-maker.js';
 
 type Query = z.output<typeof storefrontOrderQuerySchema>;
@@ -207,6 +210,7 @@ export class StorefrontOrdersService {
     private readonly invoices: InvoicesService,
     private readonly salesReturns: SalesReturnsService,
     private readonly sms: SmsQueue,
+    private readonly paymentReceipts: ShopPaymentReceipts,
   ) {
     this.mediaUrl = config.storefront.mediaUrl;
   }
@@ -274,11 +278,10 @@ export class StorefrontOrdersService {
   // the answer is the refusal itself, so the page shows what is still wrong
   async makeSalesOrder(id: string, version: number): Promise<StorefrontOrder> {
     try {
-      return await this.withTenant(async (tx) => {
+      await this.withTenant(async (tx) => {
         const order = await this.lock(tx, id, version);
         if (order.status !== 'confirmed' || order.salesOrderId !== null) throw stepInvalid();
         await this.maker.make(tx, order);
-        return this.read(tx, id);
       });
     } catch (error) {
       if (error instanceof AppError && error.code !== 'storefront_order_step_invalid') {
@@ -286,6 +289,55 @@ export class StorefrontOrdersService {
       }
       throw error;
     }
+    // Step 27d: the paid tries' receipts waited for the customer the sales order names. Each in
+    // its own transaction, after the sales order's commit: a refused receipt keeps its error on
+    // its try and leaves the sales order made
+    await this.paymentReceipts.makeAll(id);
+    return this.get(id);
+  }
+
+  // Step 27d: "Make the receipt", after a paid try's receipt was refused (receiptError). The same
+  // receipt the worker makes, in this request's transaction, by the member who pressed it
+  async makePaymentReceipt(
+    id: string,
+    paymentId: string,
+    version: number,
+  ): Promise<StorefrontOrder> {
+    try {
+      return await this.withTenant(async (tx) => {
+        const order = await this.lock(tx, id, version);
+        const locked = await this.paymentReceipts.lock(tx, id, paymentId);
+        if (locked === null) throw notFound('Payment');
+        const { payment } = locked;
+        // Not paid, made already (the worker's retry won), or no sales order to name the customer
+        if (
+          payment.status !== 'paid' ||
+          payment.receiptId !== null ||
+          order.salesOrderId === null
+        ) {
+          throw stepInvalid();
+        }
+        await this.paymentReceipts.makeIn(tx, order, payment);
+        // The page's version moves on, so another tab that still shows the error reloads first
+        await tx
+          .update(storefrontOrders)
+          .set({
+            version: sql`${storefrontOrders.version} + 1`,
+            updatedBy: currentPrincipal().userId,
+          })
+          .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, id)));
+        return this.read(tx, id);
+      });
+    } catch (error) {
+      // The receipt's own refusal is kept, as the worker keeps it; a stale page or a wrong id is not
+      if (
+        error instanceof AppError &&
+        !['storefront_order_step_invalid', 'version_conflict', 'not_found'].includes(error.code)
+      ) {
+        await this.paymentReceipts.keepError(paymentId, error.code);
+      }
+      throw error;
+    }
   }
 
   // Decision 14: what the Packed dialog opens with. A read, but behind storefront.order.manage:
@@ -510,6 +562,8 @@ export class StorefrontOrdersService {
         // moves the amount from "on order" to "owed" and adds nothing (CreditService.check)
         overrideCreditLimit: false,
       });
+      // Step 27d (decision 6): a paid online order's advance pays its invoice at once
+      await this.paymentReceipts.applyToInvoice(tx, order.id, invoiceId);
       await this.move(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
       return this.read(tx, id);
     });
@@ -897,6 +951,19 @@ export class StorefrontOrdersService {
       return row ?? null;
     };
     const documentError = order.documentError;
+    // Step 27d: every try, oldest first, with the number of the receipt a paid one made
+    const payments = await tx
+      .select({ payment: storefrontPayments, receiptNumber: receipts.number })
+      .from(storefrontPayments)
+      .leftJoin(
+        receipts,
+        and(
+          eq(receipts.tenantId, storefrontPayments.tenantId),
+          eq(receipts.id, storefrontPayments.receiptId),
+        ),
+      )
+      .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.orderId, id)))
+      .orderBy(asc(storefrontPayments.tryNo));
     return {
       ...summaryOf(
         order,
@@ -940,6 +1007,26 @@ export class StorefrontOrdersService {
       // Stored only as an error code (storefront_orders_document_error_check); one this API no
       // longer knows reads as none rather than breaking the page
       documentError: isErrorCode(documentError) ? documentError : null,
+      payments: payments.map(({ payment, receiptNumber }) => ({
+        id: payment.id,
+        tranId: payment.tranId,
+        status: payment.status,
+        amount: payment.amount,
+        startedAt: payment.startedAt.toISOString(),
+        settledAt: payment.settledAt?.toISOString() ?? null,
+        cardType: payment.cardType,
+        bankTranId: payment.bankTranId,
+        storeAmount: payment.storeAmount,
+        receipt:
+          payment.receiptId === null || receiptNumber === null
+            ? null
+            : { id: payment.receiptId, number: receiptNumber },
+        // Kept as a code only (storefront_payments_receipt_error_check), read like documentError
+        receiptError:
+          payment.receiptError !== null && isErrorCode(payment.receiptError)
+            ? payment.receiptError
+            : null,
+      })),
       version: order.version,
       updatedAt: order.updatedAt.toISOString(),
     };
```

- **`makeSalesOrder()`** makes the receipts after the sales order's transaction has committed, each in its own
  (27b's "Make the sales order" is the retry for a refused sales order; the paid tries' receipts waited for it).
- **`makePaymentReceipt()`** is "Make the receipt": the order by its version, the try locked, then the same
  `makeIn()` the worker uses. The order's version moves on, so another tab that still shows the error reloads first.
  A refusal by the receipt's rules is kept on the try; a stale page, a wrong id or a step that does not fit is not.
- **`deliver()`** applies the advances right after the invoice is posted (decision 6), in the same transaction.
- **`read()`** lists every try with its receipt's number. The receipt error is read like `documentError`: a code
  this API no longer knows reads as none.

```diff
@@ -71,6 +71,17 @@ export class StorefrontOrdersController {
     return this.orders.deliver(params.id, body.version);
   }
 
+  // Step 27d: "Make the receipt" on the Payments card
+  @Endpoint(routes.storefrontOrders.makePaymentReceipt)
+  makePaymentReceipt({
+    params,
+    body,
+  }: RouteInput<Routes['makePaymentReceipt']>): Promise<
+    RouteResponse<Routes['makePaymentReceipt']>
+  > {
+    return this.orders.makePaymentReceipt(params.id, params.paymentId, body.version);
+  }
+
   @Endpoint(routes.storefrontOrders.cancelOrder)
   cancelOrder({
     params,
```

### The sweep

```diff
@@ -1,11 +1,23 @@
 import { Inject, Injectable, Logger } from '@nestjs/common';
 import { SHOP_ORDER_HOLD_MINUTES } from '@omnivo/contracts';
-import { type Db, storefrontOrders } from '@omnivo/db';
-import { and, eq, lt } from 'drizzle-orm';
+import { type Db, storefrontOrders, storefrontPayments } from '@omnivo/db';
+import { and, eq, inArray, lt, notInArray } from 'drizzle-orm';
 
 import { getTenantId, runWithTenant } from '../../common/tenant/tenant-context.js';
 import type { WithTenant } from '../../common/tenant/with-tenant.js';
-import { RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';
+import { PAYMENT_GATEWAY, RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';
+import type { PaymentGateway } from '../../payments/gateway.js';
+import { GatewayAccounts } from '../gateway-accounts.js';
+import { settleLocked } from './payment-settle.js';
+
+const MINUTE_MS = 60 * 1000;
+
+// Step 27d: an order with a payment try is given one more hour after its hold before the sweep
+// looks at it. A shopper can sit on the gateway's page (an OTP from the bank, a slow bKash app)
+// after the hold ended, and a payment that comes then still confirms the order (decision 5). The
+// later the sweep, the smaller the window in which money arrives for an order already dropped
+// (mine)
+const PAYMENT_GRACE_MINUTES = 60;
 
 // Step 27a: deletes the orders that never got their code (27a's decision 19), every 5 minutes. Two
 // halves on two roles, like the report schedules' sweep:
@@ -13,9 +25,12 @@ import { RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';
 //    Migration 0071 lets it read three columns of the pending rows only, never a name or a phone
 // 2. as omnivo_app, inside each of those workspaces: delete them. Their lines and holds go with
 //    them (ON DELETE CASCADE)
-// Nothing waits on this: an order past its hour can no longer be confirmed (waitingOrder in
-// shop-orders.service.ts), and its stock is free again by the holds' own expires_at. The sweep
-// only stops keeping a phone number that was never confirmed. Provided by WorkerModule only.
+// Step 27d: before the delete, an order with payment tries is asked about (decision 5): a try the
+// gateway says is paid is recorded, which confirms the order, so the delete passes it by; one the
+// gateway is still processing, or cannot be asked about now, keeps its order for the next sweep.
+// Nothing waits on this: an order past its hour can no longer be confirmed by its code (waitingOrder
+// in shop-orders.service.ts), and its stock is free again by the holds' own expires_at. Provided
+// by WorkerModule only.
 @Injectable()
 export class PendingOrderSweep {
   private readonly logger = new Logger(PendingOrderSweep.name);
@@ -23,12 +38,14 @@ export class PendingOrderSweep {
   constructor(
     @Inject(RELAY_DB) private readonly relayDb: Db,
     @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
+    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
+    private readonly accounts: GatewayAccounts,
   ) {}
 
   // The number of orders deleted. One clock for both halves: the JavaScript one, as the orders'
   // times were written with it (ShopDb's now)
   async run(now: Date = new Date()): Promise<number> {
-    const before = new Date(now.getTime() - SHOP_ORDER_HOLD_MINUTES * 60 * 1000);
+    const before = new Date(now.getTime() - SHOP_ORDER_HOLD_MINUTES * MINUTE_MS);
     // The policy shows omnivo_worker only pending rows; the status in the WHERE says so here too,
     // and it is what the partial index (storefront_orders_pending_idx) is for
     const tenants = await this.relayDb
@@ -39,9 +56,11 @@ export class PendingOrderSweep {
     let deleted = 0;
     for (const { tenantId } of tenants) {
       try {
-        deleted += await runWithTenant(tenantId, () =>
-          this.withTenant(async (tx) => {
-            // pending again: an order confirmed between the two halves is kept
+        deleted += await runWithTenant(tenantId, async () => {
+          const kept = await this.settleTries(now, before);
+          return this.withTenant(async (tx) => {
+            // pending again: an order confirmed between the two halves (or by its payment just
+            // now) is kept
             const rows = await tx
               .delete(storefrontOrders)
               .where(
@@ -49,12 +68,13 @@ export class PendingOrderSweep {
                   eq(storefrontOrders.tenantId, getTenantId()),
                   eq(storefrontOrders.status, 'pending'),
                   lt(storefrontOrders.createdAt, before),
+                  kept.length === 0 ? undefined : notInArray(storefrontOrders.id, kept),
                 ),
               )
               .returning({ id: storefrontOrders.id });
             return rows.length;
-          }),
-        );
+          });
+        });
       } catch (error) {
         // One workspace's failure must not stop the others; the next sweep tries again
         this.logger.warn(`pending orders (tenant ${tenantId}): ${String(error)}`);
@@ -62,4 +82,72 @@ export class PendingOrderSweep {
     }
     return deleted;
   }
+
+  // The ids of the pending orders past their hold that must stay for now. Every try that may still
+  // pay is asked about: started, and failed or cancelled too, because only paid is final (27d.1's
+  // mine 11). A not_opened try had no page, so nothing can come for it
+  private async settleTries(now: Date, before: Date): Promise<string[]> {
+    const tenantId = getTenantId();
+    const tries = await this.withTenant((tx) =>
+      tx
+        .select({
+          id: storefrontPayments.id,
+          tranId: storefrontPayments.tranId,
+          mode: storefrontPayments.mode,
+          orderId: storefrontOrders.id,
+          createdAt: storefrontOrders.createdAt,
+        })
+        .from(storefrontPayments)
+        .innerJoin(
+          storefrontOrders,
+          and(
+            eq(storefrontOrders.tenantId, storefrontPayments.tenantId),
+            eq(storefrontOrders.id, storefrontPayments.orderId),
+          ),
+        )
+        .where(
+          and(
+            eq(storefrontPayments.tenantId, tenantId),
+            eq(storefrontOrders.status, 'pending'),
+            lt(storefrontOrders.createdAt, before),
+            inArray(storefrontPayments.status, ['started', 'failed', 'cancelled']),
+          ),
+        ),
+    );
+    const graceBefore = new Date(before.getTime() - PAYMENT_GRACE_MINUTES * MINUTE_MS);
+    const kept = new Set<string>();
+    for (const payment of tries) {
+      // Too soon for an order with a try: next sweeps, until its grace hour is over
+      if (payment.createdAt >= graceBefore) {
+        kept.add(payment.orderId);
+        continue;
+      }
+      if (kept.has(payment.orderId)) continue;
+      const account = await this.accounts.open(tenantId, payment.mode);
+      const answer =
+        account === null
+          ? ({ kind: 'problem', problem: 'rejected' } as const)
+          : await this.gateway.find(account, payment.tranId);
+      if (answer.kind === 'paid' || answer.kind === 'failed' || answer.kind === 'cancelled') {
+        // As omnivo_app, with the same rules as the shop's own settle. A paid answer confirms the
+        // order (no confirm SMS from here: the worker has no shop address to put in it; the shopper
+        // still has /checkout/paid and /track)
+        const result = await this.withTenant((tx) =>
+          settleLocked(tx, tenantId, payment.id, answer, now, this.logger),
+        );
+        // A "paid" answer that is not this try's (another amount: settleLocked logged it) keeps
+        // the order, so the staff still find it next to the gateway's record
+        if (answer.kind === 'paid' && result?.status !== 'paid') kept.add(payment.orderId);
+      } else if (answer.kind === 'pending' || answer.kind === 'problem') {
+        // Still being processed, or the gateway (or the account) cannot answer now: keep it. An
+        // account that never opens again keeps its orders until someone fixes the key, which the
+        // log says
+        kept.add(payment.orderId);
+        if (answer.kind === 'problem') {
+          this.logger.warn(`Could not ask about payment ${payment.tranId} (tenant ${tenantId})`);
+        }
+      }
+    }
+    return [...kept];
+  }
 }
```

- **`settleTries()` runs before the delete** and returns the orders to keep (mine 38). A `not_opened` try is not
  asked about: it had no page, so nothing can come for it.
- **`PAYMENT_GRACE_MINUTES`**: an order with a try is left alone for one more hour after its hold. A shopper can
  still be on the gateway's page (a bank's OTP, a slow wallet app) after the hold ended, and the later the sweep,
  the smaller the window in which money arrives for an order already dropped.
- **Paid, failed and cancelled answers are recorded** with the shop's own `settleLocked()`, as `omnivo_app`. A paid
  one confirms the order, so the delete's `status = 'pending'` passes it by. A "paid" answer for another amount
  keeps the order next to the gateway's record.
- **Pending and problem keep the order** for the next sweep. An account that never opens again keeps its orders
  until someone fixes the key, which the log says.
- **The delete leaves out the kept ids** (`notInArray`). With none kept the condition is left out, because
  `NOT IN ()` is not valid SQL.

### Wiring

```diff
@@ -14,6 +14,12 @@ import { StorefrontSettingsService } from './admin/settings.service.js';
 import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
 import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
 import { StorefrontCouponsController } from './admin/storefront-coupons.controller.js';
+import { StorefrontPaymentGatewayService } from './admin/payment-gateway.service.js';
+import { StorefrontPaymentsController } from './admin/storefront-payments.controller.js';
+import { GatewayAccounts } from './gateway-accounts.js';
+import { PaymentPages } from './orders/payment-pages.js';
+import { ShopPaymentReceipts } from './orders/payment-receipts.js';
+import { ShopPaymentsService } from './orders/shop-payments.service.js';
 import { SmsQueue } from '../sms/sms-queue.js';
 import { ShopLimits } from './orders/shop-limits.js';
 import { ShopOrdersController } from './orders/shop-orders.controller.js';
@@ -35,7 +41,10 @@ import { ShopDb } from './shop-db.js';
 // documents with the sales services (SalesModule), and the "Delivery charge" service with
 // ProductsService. Step 27c adds Coupons (admin/coupons.service.ts, its own controller); the
 // quote and placing an order read a coupon through coupon-sql.ts, never through that service, for
-// the reason above
+// the reason above. Step 27d adds paying online: the shop's payment routes (orders/shop-payments.*,
+// as omnivo_shop), the Payment card (admin/payment-gateway.*), and the money receipt of a paid try
+// (orders/payment-receipts.ts), which "Make the receipt" shares with the worker. The gateway itself
+// comes from InfraModule (PAYMENT_GATEWAY)
 @Module({
   imports: [AttachmentsModule, SalesModule, ProductsModule],
   controllers: [
@@ -45,6 +54,7 @@ import { ShopDb } from './shop-db.js';
     StorefrontAppearanceController,
     StorefrontOrdersController,
     StorefrontCouponsController,
+    StorefrontPaymentsController,
   ],
   providers: [
     ShopDb,
@@ -62,6 +72,11 @@ import { ShopDb } from './shop-db.js';
     ShopSalesOrderMaker,
     StorefrontOrdersService,
     StorefrontCouponsService,
+    GatewayAccounts,
+    PaymentPages,
+    ShopPaymentsService,
+    ShopPaymentReceipts,
+    StorefrontPaymentGatewayService,
   ],
 })
 export class StorefrontModule {}
```
```diff
@@ -7,7 +7,18 @@ import { DocumentEmailHandler } from '../documents/email.handler.js';
 import { DocumentFileHandler } from '../documents/file.handler.js';
 import { DocumentFileMaker } from '../documents/file-maker.js';
 import type { WorkerConfig } from '../config.js';
-import { CONFIG, DB, REDIS, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
+import {
+  CONFIG,
+  DB,
+  PAYMENT_GATEWAY,
+  PAYMENTS_CONFIG,
+  REDIS,
+  RELAY_DB,
+  STORAGE_CONFIG,
+  WITH_TENANT,
+} from '../infra/tokens.js';
+import { PostingService } from '../journal/posting.service.js';
+import { createGateway } from '../payments/create-gateway.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
@@ -25,6 +36,8 @@ import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
 import { BalanceAccess } from '../sales/balance-access.js';
 import { CreditService } from '../sales/credit.service.js';
 import { CustomersService } from '../sales/customers.service.js';
+import { ReceiptsService } from '../sales/receipts.service.js';
+import { SalesBooksService } from '../sales/sales-books.service.js';
 import { SalesOrdersService } from '../sales/sales-orders.service.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
@@ -35,7 +48,10 @@ import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
 import { SMS_SENDER, MailSmsSender } from '../sms/sms-sender.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
+import { GatewayAccounts } from '../storefront/gateway-accounts.js';
 import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
+import { PaymentPaidHandler } from '../storefront/orders/payment-paid.handler.js';
+import { ShopPaymentReceipts } from '../storefront/orders/payment-receipts.js';
 import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
 import { ShopSalesOrderMaker } from '../storefront/orders/sales-order-maker.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
@@ -123,6 +139,16 @@ export class WorkerModule implements OnApplicationShutdown {
         CreditService,
         BalanceAccess,
         PermissionService,
+        // Step 27d: the money receipt of a paid try, and the sweep's look at the gateway before it
+        // drops an unpaid online order
+        { provide: PAYMENTS_CONFIG, useValue: config.payments },
+        { provide: PAYMENT_GATEWAY, useFactory: () => createGateway(config.payments) },
+        GatewayAccounts,
+        PaymentPaidHandler,
+        ShopPaymentReceipts,
+        ReceiptsService,
+        SalesBooksService,
+        PostingService,
         { provide: REDIS, useFactory: () => new Redis(config.redisUrl, { lazyConnect: true }) },
       ],
     };
```

The worker gets the gateway and the accounts (the sweep), the receipt job, and the receipt service with what it
needs (`SalesBooksService`, `PostingService`; `NumberingService` was there already).

Then regenerate the API's description, which now has the nine new routes of 27d.1:

```sh
pnpm --filter @omnivo/contracts build
node packages/contracts/scripts/gen-openapi.ts
```

`pnpm gen:openapi` from the root runs every package's build first, and the shop does not build until 27d.7; the
contracts' own script is enough here.

### Check this part

```sh
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/api exec tsc --noEmit -p .
pnpm --filter @omnivo/api test
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n test
pnpm exec eslint apps/api/src packages/contracts/src
pnpm exec prettier --check apps/api/src packages/contracts/src packages/i18n/src
pnpm boundaries
```

All pass: API 223 unit tests (16 new: the seal, the two gateways, the config), contracts 667, i18n 21, no
boundary violation. The shop does not type-check until 27d.7 (27d.1's `pay` answer), and the app until 27d.7 (its
mock order needs `payments`).

The storefront and sales integration suites (`apps/api/src/storefront`, `sales/invoices`, `sales/sales-documents`,
the outbox relay) still pass: 276 tests, two of which timed out under load and passed alone.

A throwaway end-to-end run on the fake gateway (not part of the repo; 27d.4 writes the real tests) went through:
the Payment card's save and test, the password not in the answer and not readable in the row, an online order
answering `next: 'pay'` with the fake page, `/checkout/paid` saying "not finished" with 2 tries left, a wrong amount
refused, the payment recorded once (a second settle changes nothing), the order confirmed with
`payment_method = online`, its receipt MR-2026-27-0001 with the entry Dr cash ৳524.55, Dr fee ৳13.45,
Cr receivable ৳538, and the invoice at Delivered paid in full by the advance. A second order: cancelled on the
gateway, "Try again", then "Pay on delivery" and its phone code, confirmed as Cash on Delivery; the retried try then
paid late is kept as paid with its own receipt, as an advance.

Broken on purpose, each caught by that run:

- the amount check in `mismatch()` dropped: the wrong amount is recorded as paid;
- `applyToInvoice()` dropped from `deliver()`: the invoice stays unpaid.

## 27d.4 — Tests

27d.3 was checked by one throwaway smoke test. This part replaces it with real tests: a new integration file for the
Payment card and for everything the shop does with an online order, and a new tenant-leak file. Both run against
the real stack: Postgres, Redis, Mailpit, the API and the worker, on the fake gateway (`PAYMENT_GATEWAY`'s default
outside production). The fake gateway's `val_id` says what happened (27d.1's `fakeValId`), so each test decides
what the gateway answers.

One bug of 27d.3 was found and fixed here: deleting a ledger account that the Payment card uses answered 500. The
database refused the delete with its foreign key, as it should, but the accounts service did not know that key's
name, so the error went out as "Something went wrong". The fix is a new error code and two lines in the accounts
service. Every other test passed against the 27d.3 code as it was.

Mine, made while writing this part:

44. **An account the Payment card uses cannot be deleted, but it can be archived.** A delete is refused with
    `account_used_by_shop` ("Choose another one in Shop settings → Payment first, or archive it"), like an account
    chosen in Settings → Purchase. Archiving stays allowed: the gateway is then not ready, and the checkout stops
    offering Pay online by itself (27d.3). Refusing the archive too would make a workspace that wants to stop online
    payments find the Payment card first, for no gain.
45. **The tests without `CREDENTIALS_KEY` start a second API in the same file.** It shares the database with the
    first one and differs only in its config (`credentialsKey: null`). A test file of its own would start a second
    set of containers for three requests.

### The error for an account the shop uses

```diff
@@ -752,6 +752,9 @@ export const ERROR_CODES = [
   // Step 27d.3: the server has no CREDENTIALS_KEY, so it cannot seal a gateway password (or open
   // one). Said on the Payment card instead of failing with a 500
   'storefront_gateway_key_missing',
+  // Step 27d.4: a delete refused because the account is chosen on the shop's Payment card (the
+  // money or the fee account). Archiving it is allowed: Pay online then leaves the checkout
+  'account_used_by_shop',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

A new code at the end of the list, with a comment that says when it is sent. The list is the source of every error
code the API may send; the words come from `en.ts` and `bn.ts`.

```diff
@@ -8366,6 +8366,8 @@ export const en = {
       'Save the payment gateway with its two accounts before you tick Pay online.',
     storefront_gateway_key_missing:
       'This server cannot keep a gateway password yet. Ask whoever runs Omnivo for you to set CREDENTIALS_KEY.',
+    account_used_by_shop:
+      'The shop’s online payments use this account. Choose another one in Shop settings → Payment first, or archive it.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -7788,6 +7788,8 @@ export const bn: Messages = {
       'অনলাইনে পেমেন্টে টিক দেওয়ার আগে দুটো অ্যাকাউন্টসহ পেমেন্ট গেটওয়ে সেভ করুন।',
     storefront_gateway_key_missing:
       'এই সার্ভার এখনো পেমেন্ট গেটওয়ের পাসওয়ার্ড রাখতে পারে না। যিনি আপনার Omnivo চালান, তাঁকে CREDENTIALS_KEY সেট করতে বলুন।',
+    account_used_by_shop:
+      'শপের অনলাইন পেমেন্ট এই অ্যাকাউন্ট ব্যবহার করে। আগে শপের সেটিংস → পেমেন্ট থেকে অন্য একটা বাছুন, অথবা এটা আর্কাইভ করুন।',
   },
   ui: {
     dataTable: {
```

The words say both ways out: choose another account on the Payment card, or archive this one. Both files must have
the key, or `satisfies Record<ErrorCode, string>` fails the type check.

```diff
@@ -108,6 +108,16 @@ async function assertNotSalesAccount(tx: Transaction, accountId: string): Promis
   if (used) throw usedBySales();
 }
 
+// Step 27d.4: chosen on the shop's Payment card. Only a delete is refused: an archived money or fee
+// account makes the gateway not ready, and the checkout stops offering Pay online by itself
+function usedByShop(): AppError {
+  return new AppError(
+    409,
+    'account_used_by_shop',
+    'The shop’s online payments use this account. Choose another one in Shop settings → Payment first.',
+  );
+}
+
 function usedByPurchase(): AppError {
   return new AppError(
     409,
@@ -403,6 +413,13 @@ export class AccountsService {
       ) {
         throw usedByPurchase();
       }
+      // Chosen on the shop's Payment card (step 27d)
+      if (
+        isForeignKeyViolation(error, 'storefront_payment_gateways_money_account_fk') ||
+        isForeignKeyViolation(error, 'storefront_payment_gateways_fee_account_fk')
+      ) {
+        throw usedByShop();
+      }
       throw error;
     }
   }
```

- **No "is it used?" query before the delete.** The two foreign keys of `storefront_payment_gateways` (27d.2) are
  the check, as for every other place that names an account. A query first would leave a gap: a Payment card saved
  between the query and the delete would still meet the key.
- **The constraint's name, not only the error code.** 23503 is any foreign key. Each name gets the answer that
  tells the person where the account is chosen; an unknown one is still thrown as it is, so a new use that nobody
  mapped shows up as a 500 in a test, as this one did.
- **Only the delete.** `archive()` is not changed (decision 44).

`packages/contracts/openapi.json` is generated again (`node packages/contracts/scripts/gen-openapi.ts`): the error
code lists in it gain `account_used_by_shop`.

### The payment tests

The file is long, so it is shown in parts. First the helpers:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  accountListSchema,
  accountSchema,
  type CreateStorefrontPaymentGatewayInput,
  fakeValId,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  publicOrderPlacedSchema,
  roleSchema,
  type ShopPaymentMethod,
  type ShopPaymentWait,
  shopCheckoutSettingsSchema,
  shopCodeWaitSchema,
  shopPaymentRetrySchema,
  shopPaymentSettledSchema,
  shopPaymentWaitSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentSetupSchema,
  storefrontSetupSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Config } from '../../config.js';
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
import { bearer, logIn, type SignedIn, signUp } from '../../testing/http.js';
import {
  clientAddress,
  codeFor,
  deliveryServiceUpdate,
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  shopHeaders,
  shopPost,
  smsAddress,
  trackingTokenFor,
} from '../../testing/shop-orders.js';
import { joinWithoutRoles } from '../../testing/workspace.js';
import { PendingOrderSweep } from './pending-order-sweep.js';

// Step 27d: paying online against the real stack, on the fake gateway (PAYMENT_GATEWAY's default
// outside production, 27d.3). First the ERP's Payment card and the shop settings' "Pay online";
// then the shop's side as a shopper goes through it: the order placed, the gateway's page, its
// answer posted back (once, or twice at the same moment), /checkout/paid with "Try again" and "Pay
// on delivery", the money receipt with the gateway's fee, the invoice that takes it at Delivered,
// and the sweep that asks the gateway before it deletes an unpaid order. The fake gateway's val_id
// says what happened (fakeValId), so a test decides what the gateway answers. Every test has its
// own phones and shopper addresses: the limits count them across the file.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let config: Config;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read only: may read the orders, and nothing of the Payment card
let reader: SignedIn;
let shop: OrderShop;
// The zone the orders name. The shop settings' save gives the launch's zone a new id (27b's
// deliveryServiceUpdate says why), so it is read again after that save
let zoneId = 'inside_dhaka';
// The Payment card's two accounts: Cash in hand, and an expense account of the test's own for the
// gateway's fee
let cash: { id: string; code: string };
let feeAccount: { id: string; code: string };
// What the Payment card is saved with. The space at the end is part of the password: a password
// is never trimmed (27d.1)
const STORE_ID = 'nirvor67412bc';
const PASSWORD = 'Bkash-store-2026 ';

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  who = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// A request that must be refused with this status; its problem's code and field errors
async function refused(res: Promise<{ statusCode: number; body: string }>, status: number) {
  const answer = await res;
  expect(answer.statusCode, answer.body).toBe(status);
  return refusalSchema.parse(JSON.parse(answer.body));
}

// The Payment card's form, as the page sends it
function gatewayForm(extra: Partial<CreateStorefrontPaymentGatewayInput> = {}) {
  return {
    storeId: STORE_ID,
    password: PASSWORD,
    mode: 'sandbox',
    moneyAccountId: cash.id,
    feeAccountId: feeAccount.id,
    ...extra,
  } satisfies CreateStorefrontPaymentGatewayInput;
}

async function gateway() {
  const res = await send('GET', '/storefront/payment-gateway');
  expect(res.statusCode, res.body).toBe(200);
  const setup = storefrontPaymentSetupSchema.parse(res.json());
  if (setup.gateway === null) throw new Error('the gateway is not saved');
  return setup.gateway;
}

// The sealed password as the row keeps it, in hex: a test compares it before and after a save
async function sealedPassword(): Promise<string> {
  const [row] = z.array(z.object({ sealed: z.string(), version: z.number() })).parse(
    await sql`
        SELECT encode(password_sealed, 'hex') AS sealed, key_version AS version
        FROM storefront_payment_gateways WHERE tenant_id = ${shop.tenantId}`,
  );
  if (row === undefined) throw new Error('no gateway row');
  return row.sealed;
}

// The Payment card's audit rows, oldest first, as JSON text: a test looks for the password in it
async function gatewayAudit() {
  return z.array(z.object({ action: z.string(), text: z.string() })).parse(
    await sql`
      SELECT action, payload::text AS text FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_type = 'storefront_payment_gateway'
      ORDER BY created_at, id`,
  );
}

async function checkoutMethods(): Promise<ShopPaymentMethod[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/public/v1/checkout-settings',
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCheckoutSettingsSchema.parse(res.json()).paymentMethods;
}

// The shop's settings form as it is saved, with these payment methods ticked. The delivery
// charge's service stays as it is: once an order used one, it can't be emptied (27b)
async function saveMethods(methods: ShopPaymentMethod[]) {
  const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
  if (setup.shop === null) throw new Error('the shop is not set up');
  return send('PUT', '/storefront/settings', {
    ...deliveryServiceUpdate(setup.shop, setup.shop.deliveryVariantId ?? ''),
    paymentMethods: methods,
  });
}

async function setArchived(account: { id: string }, archived: boolean): Promise<void> {
  const current = accountSchema.parse((await send('GET', `/accounts/${account.id}`)).json());
  const res = await send('POST', `/accounts/${account.id}/${archived ? 'archive' : 'restore'}`, {
    version: current.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The headers of shopper n, at Nirvor
function shopper(n: number): Record<string, string> {
  return shopHeaders(shop.host, clientAddress(n));
}

// Two face washes (৳229 each) and the ৳80 delivery charge
const TWO = '538';

interface OnlineOrder {
  n: number;
  phone: string;
  token: string;
  // The gateway's page, or null when it did not open
  paymentUrl: string | null;
}

// An online order of two face washes by shopper n, placed as the checkout places it
async function placeOnline(n: number): Promise<OnlineOrder> {
  const res = await shopPost(app, '/orders', shopper(n), {
    ...orderRequest(shop.listingId, 2, phoneOf(n), TWO),
    zoneId,
    paymentMethod: 'online',
  });
  expect(res.statusCode, res.body).toBe(201);
  const { answer, token } = publicOrderPlacedSchema.parse(res.json());
  if (answer.next !== 'pay') throw new Error(`the order answered ${answer.next}`);
  return { n, phone: phoneOf(n), token, paymentUrl: answer.paymentUrl };
}

// The try a payment page is for, read from the fake page's address (27d.3's FakeGateway)
function pageOf(paymentUrl: string | null): { tranId: string; amount: string } {
  if (paymentUrl === null) throw new Error('no payment page');
  const url = new URL(paymentUrl);
  return {
    tranId: url.searchParams.get('tranId') ?? '',
    amount: url.searchParams.get('amount') ?? '',
  };
}

// What the fake page posts back when the shopper pays: the val_id that says paid, this amount
function paidValId(page: { tranId: string; amount: string }): string {
  return fakeValId(page.tranId, { outcome: 'paid', amount: page.amount });
}

// The gateway's post (the browser's return or the IPN), as the shop's server passes it on
function settle(n: number, tranId: string, valId: string | null) {
  return shopPost(app, '/payments/settle', shopper(n), { tranId, valId });
}

async function settled(n: number, tranId: string, valId: string | null): Promise<string> {
  const res = await settle(n, tranId, valId);
  expect(res.statusCode, res.body).toBe(200);
  return shopPaymentSettledSchema.parse(res.json()).status;
}

// /checkout/paid's question
async function waitOf(order: OnlineOrder): Promise<ShopPaymentWait> {
  const res = await shopPost(app, '/orders/payment', shopper(order.n), { token: order.token });
  expect(res.statusCode, res.body).toBe(200);
  return shopPaymentWaitSchema.parse(res.json());
}

function retry(order: OnlineOrder) {
  return shopPost(app, '/orders/payment/retry', shopper(order.n), { token: order.token });
}

function payOnDelivery(order: OnlineOrder) {
  return shopPost(app, '/orders/payment/cod', shopper(order.n), { token: order.token });
}
```

- **Two accounts of the test's own choosing.** The money account is Cash in hand (1110), and the fee account is a
  new expense account, 5999 "Online payment charges". The test makes it rather than taking the chart's first
  expense account, so a test can archive it or try to delete it without touching an account other documents use.
- **The password ends with a space.** A password is never trimmed (27d.1). If a later change trimmed it, the
  sealed length check below would fail.
- **`gatewayForm()`** is typed with `satisfies CreateStorefrontPaymentGatewayInput`: the result keeps its literal
  `mode`, so a test may spread it and change one box, and a wrong box name does not type-check.
- **`sealedPassword()`** reads the sealed bytes in hex. A test compares them before and after a save to see that an
  empty password box kept the password as it was.
- **`gatewayAudit()`** reads each audit row's whole `payload` as text, so a test can check that the password is
  nowhere in it, under any field.
- **`saveMethods()`** saves the shop's settings form with only the payment methods changed. It uses 27b's
  `deliveryServiceUpdate()` with the delivery service the shop has now: once an order used one, it can't be
  emptied again. The save gives the launch's zone a new id, so the test reads the zone id again after its first
  save (`zoneId`).
- **`placeOnline()`** places two face washes (৳538) with `paymentMethod: 'online'` and expects the `pay` answer.
  **`pageOf()`** reads the try's `tranId` and `amount` from the fake page's address, the way the shop's fake page
  does; **`paidValId()`** is what that page posts back when the shopper presses Pay.
- **`settle()`** is the gateway's post as the shop's server passes it on (the browser's return or the IPN); it
  returns the answer as it is, for the tests that expect a refusal. **`settled()`** expects a 200 and returns the
  status.

```ts
const orderRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  payment_method: z.string(),
  order_no: z.string().nullable(),
  has_code: z.boolean(),
});

async function orderRowOf(phone: string) {
  const rows = z.array(orderRowSchema).parse(
    await sql`
      SELECT id::text, status, payment_method, order_no, code_hash IS NOT NULL AS has_code
      FROM storefront_orders WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`,
  );
  return rows;
}

async function onlyOrderOf(phone: string) {
  const [row, ...more] = await orderRowOf(phone);
  if (row === undefined || more.length > 0) throw new Error(`not one order from ${phone}`);
  return row;
}

// The order's tries, oldest first
async function triesOf(phone: string) {
  return z.array(z.object({ try_no: z.number(), status: z.string(), tran_id: z.string() })).parse(
    await sql`
        SELECT p.try_no, p.status, p.tran_id FROM storefront_payments p
        JOIN storefront_orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
        WHERE o.tenant_id = ${shop.tenantId} AND o.phone = ${phone}
        ORDER BY p.try_no`,
  );
}

// The order as if placed `minutes` ago
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders SET created_at = created_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

// The order as the Shop orders page sees it, once `check` holds (the worker makes its sales order
// and its receipts a moment after the confirm)
async function erpOrder(
  phone: string,
  check: (order: StorefrontOrder) => void = () => undefined,
): Promise<StorefrontOrder> {
  const { id } = await onlyOrderOf(phone);
  return eventually(async () => {
    const res = await send('GET', `/storefront/orders/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const order = storefrontOrderSchema.parse(res.json());
    check(order);
    return order;
  }, 10_000);
}

const mailboxSchema = z.object({
  messages: z.array(z.object({ To: z.array(z.object({ Address: z.string() })) })),
});

// How many SMS went to this phone (Mailpit lists 50 at a time by default)
async function smsCount(phone: string): Promise<number> {
  const res = await fetch(`${mail.apiUrl}/api/v1/messages?limit=1000`);
  const { messages } = mailboxSchema.parse(await res.json());
  return messages.filter((message) => message.To.some((to) => to.Address === smsAddress(phone)))
    .length;
}

// Sends requests "at the same moment" for sure, and in a known order (27c's storefront-coupons
// spec says how): a transaction of the test's own locks `table`, and the next request is sent only
// once the one before it waits
async function inTurn<T>(table: string, sends: (() => Promise<T>)[]): Promise<T[]> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent: Promise<T>[] = [];
    for (const next of sends) {
      sent.push(next());
      await eventually(async () => {
        const [row] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
        expect(row?.n).toBe(sent.length);
      });
    }
    return { all: Promise.all(sent) };
  });
  return gate.all;
}

// A user with a workspace of their own, who then joins Nirvor with a role of these permissions
async function member(email: string, fullName: string, permissions: PermissionKey[]) {
  const password = 'Mirpur-depot-2026';
  await signUp(app, {
    companyName: `${fullName} Store`,
    workspaceSlug: email.split('@')[0] ?? 'store',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'nirvor' });
  const made = await send('POST', '/roles', { name: `${fullName}'s role`, description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'nirvor', email, password, keepSignedIn: false });
}

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  config = testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url });
  app = await createTestApp(config);
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  // Three: the gate's transaction, and the reads a test makes while the gate is shut
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 200 });
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cashInHand = chart.find((account) => account.code === '1110');
  // The fee goes under the expenses' first group that is not cost of goods sold
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cashInHand === undefined || expenses === undefined) throw new Error('no 1110 or no group');
  cash = cashInHand;
  const made = await send('POST', '/accounts', {
    parentId: expenses.id,
    code: '5999',
    name: 'Online payment charges',
    isGroup: false,
    holdsMoney: false,
    description: '',
  });
  expect(made.statusCode, made.body).toBe(201);
  feeAccount = accountSchema.parse(made.json());
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});
```

- **`orderRowOf()`** reads the order's row in SQL, with `code_hash IS NOT NULL` as a boolean: the hash is a
  `bytea`, and only whether there is one matters here.
- **`erpOrder()`** reads the order as the Shop orders page does, and waits until `check` holds: the worker makes
  the sales order and then the receipt a moment after the confirm.
- **`smsCount()`** counts the SMS to a phone in Mailpit, asking for up to 1,000 messages: Mailpit lists 50 by
  default, and this file sends more than that. A test counts only after it has waited for the SMS it expects, so
  "one SMS" means that no second one was sent.
- **`inTurn()`** is 27c's gate (decision 27 there): a transaction of the test's own locks a table in `SHARE`
  mode, and the next request is sent only once the one before it waits.
- **`member()`** is 27b's: a user signs up for a workspace of their own, joins Nirvor with no role, and gets a role
  through the roles API.

The shop has one product, Neem Face Wash, with 200 pieces. `sql` has three connections: the gate holds one for its
whole transaction, and the gate's own reads and a test's reads need the others.

```ts
describe('the Payment card', () => {
  it('starts empty, lists the accounts it may use, and Pay online cannot be ticked yet', async () => {
    const setup = storefrontPaymentSetupSchema.parse(
      (await send('GET', '/storefront/payment-gateway')).json(),
    );
    expect(setup.gateway).toBeNull();
    expect(setup.moneyAccounts.map((account) => account.code)).toContain('1110');
    expect(setup.feeAccounts.map((account) => account.code)).toContain('5999');
    // Never a money account as the fee's, and never a group
    expect(setup.feeAccounts.map((account) => account.id)).not.toContain(cash.id);
    const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
    const groups = new Set(chart.filter((account) => account.isGroup).map((account) => account.id));
    expect(setup.feeAccounts.some((account) => groups.has(account.id))).toBe(false);
    expect(setup.moneyAccounts.some((account) => groups.has(account.id))).toBe(false);

    expect((await refused(send('POST', '/storefront/payment-gateway/test'), 409)).code).toBe(
      'storefront_gateway_not_set_up',
    );
    expect(
      (
        await refused(
          send('PUT', '/storefront/payment-gateway', { ...gatewayForm(), version: 1 }),
          409,
        )
      ).code,
    ).toBe('storefront_gateway_not_set_up');
    expect(await refused(saveMethods(['cod', 'online']), 422)).toEqual({
      code: 'storefront_online_not_ready',
      fieldErrors: { paymentMethods: ['storefront_online_not_ready'] },
    });
    expect(await checkoutMethods()).toEqual(['cod']);
  });

  it('refuses an account that does not fit and a store id it cannot send, under their boxes', async () => {
    const path = '/storefront/payment-gateway';
    expect(
      await refused(send('POST', path, gatewayForm({ moneyAccountId: feeAccount.id })), 422),
    ).toEqual({
      code: 'storefront_gateway_money_account_invalid',
      fieldErrors: { moneyAccountId: ['storefront_gateway_money_account_invalid'] },
    });
    expect(await refused(send('POST', path, gatewayForm({ feeAccountId: cash.id })), 422)).toEqual({
      code: 'storefront_gateway_fee_account_invalid',
      fieldErrors: { feeAccountId: ['storefront_gateway_fee_account_invalid'] },
    });
    const bad = await refused(
      send('POST', path, gatewayForm({ storeId: 'nirvor 674', password: '' })),
      400,
    );
    expect(bad.fieldErrors).toEqual({
      storeId: ['storefront_gateway_store_id_format'],
      password: ['storefront_gateway_password_required'],
    });
    // Nothing was saved by any of them
    const [row] = await sql`SELECT count(*)::int AS n FROM storefront_payment_gateways`;
    expect(row?.n).toBe(0);
  });

  it('saves the gateway with its password sealed, never in an answer or the audit log', async () => {
    const res = await send('POST', '/storefront/payment-gateway', gatewayForm());
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain('Bkash-store');
    expect(storefrontPaymentGatewaySchema.parse(res.json())).toMatchObject({
      provider: 'sslcommerz',
      storeId: STORE_ID,
      mode: 'sandbox',
      moneyAccountId: cash.id,
      feeAccountId: feeAccount.id,
      ready: true,
      lastTest: null,
      version: 1,
    });
    // nonce (12) + tag (16) + the password's 17 bytes, and no plain text in it
    const sealed = await sealedPassword();
    expect(sealed).toHaveLength((12 + 16 + PASSWORD.length) * 2);
    expect(sealed).not.toContain(Buffer.from('Bkash').toString('hex'));
    // A second first save (another tab) is refused, and changes nothing
    expect(
      (
        await refused(
          send('POST', '/storefront/payment-gateway', gatewayForm({ storeId: 'other' })),
          409,
        )
      ).code,
    ).toBe('storefront_gateway_set_up_already');
    expect((await gateway()).storeId).toBe(STORE_ID);

    const rows = await gatewayAudit();
    expect(rows.map((row) => row.action)).toEqual(['storefront_payment_gateway.created']);
    expect(rows[0]?.text).toContain('"changed"');
    expect(rows[0]?.text).toContain('1110');
    expect(rows[0]?.text).not.toContain('Bkash-store');
  });

  it('keeps the password when its box is left empty, and a change to where it reaches clears the test', async () => {
    const path = '/storefront/payment-gateway';
    const tested = storefrontPaymentGatewaySchema.parse(
      (await send('POST', `${path}/test`)).json(),
    );
    // A test answers what the gateway said, and moves no version: a form open elsewhere still saves
    expect(tested.lastTest?.problem).toBeNull();
    expect(tested.version).toBe(1);
    const before = await sealedPassword();

    // The password box left empty: the saved one stays, sealed as it was
    const kept = await send('PUT', path, { ...gatewayForm({ password: '' }), version: 1 });
    expect(kept.statusCode, kept.body).toBe(200);
    const keptGateway = storefrontPaymentGatewaySchema.parse(kept.json());
    expect(keptGateway.version).toBe(2);
    // Nothing the test reached changed, so its answer stays
    expect(keptGateway.lastTest).toEqual(tested.lastTest);
    expect(await sealedPassword()).toBe(before);
    // The same password typed again is no change either
    const same = await send('PUT', path, { ...gatewayForm(), version: 2 });
    expect(same.statusCode, same.body).toBe(200);
    expect(await sealedPassword()).toBe(before);
    // A form opened before those saves is refused
    expect((await refused(send('PUT', path, { ...gatewayForm(), version: 1 }), 409)).code).toBe(
      'version_conflict',
    );

    // A store id the gateway refuses: saved, and the test says so; the last test was cleared first
    const rejected = await send('PUT', path, {
      ...gatewayForm({ storeId: 'fake_rejected', password: '' }),
      version: 3,
    });
    expect(storefrontPaymentGatewaySchema.parse(rejected.json()).lastTest).toBeNull();
    const refusedTest = storefrontPaymentGatewaySchema.parse(
      (await send('POST', `${path}/test`)).json(),
    );
    expect(refusedTest.lastTest?.problem).toBe('rejected');
    // A new password: sealed again, with a new nonce
    const back = await send('PUT', path, {
      ...gatewayForm({ password: 'New-store-pass-2026' }),
      version: 4,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await sealedPassword()).not.toBe(before);
    const reset = await send('PUT', path, { ...gatewayForm(), version: 5 });
    expect(reset.statusCode, reset.body).toBe(200);

    const rows = await gatewayAudit();
    expect(rows.map((row) => row.action)).toEqual([
      'storefront_payment_gateway.created',
      'storefront_payment_gateway.tested',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.tested',
      'storefront_payment_gateway.updated',
      'storefront_payment_gateway.updated',
    ]);
    // The two saves that kept the password say nothing about it; the two new ones say "changed"
    expect(rows.map((row) => row.text.includes('"password"'))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(
      rows.some((row) => row.text.includes('Bkash-store') || row.text.includes('New-store')),
    ).toBe(false);
    expect(rows[5]?.text).toContain('rejected');
  });

  it('lets Pay online be ticked once the gateway is ready, and keeps it when an account is archived', async () => {
    const saved = await saveMethods(['cod', 'online']);
    expect(saved.statusCode, saved.body).toBe(200);
    zoneId =
      shopCheckoutSettingsSchema.parse(
        (
          await app.inject({
            method: 'GET',
            url: '/public/v1/checkout-settings',
            headers: { 'x-shop-host': shop.host },
          })
        ).json(),
      ).zones[0]?.id ?? '';
    expect(await checkoutMethods()).toEqual(['cod', 'online']);

    // The fee account archived: the gateway is not ready, so the checkout stops offering it
    await setArchived(feeAccount, true);
    try {
      expect((await gateway()).ready).toBe(false);
      expect(await checkoutMethods()).toEqual(['cod']);
      // An order placed now with it is refused
      const res = await shopPost(app, '/orders', shopper(1), {
        ...orderRequest(shop.listingId, 2, phoneOf(1), TWO),
        zoneId,
        paymentMethod: 'online',
      });
      expect((await refused(Promise.resolve(res), 422)).code).toBe('shop_payment_unavailable');
      // Ticked already: a save of the other settings keeps it, and is not refused for it
      const again = await saveMethods(['cod', 'online']);
      expect(again.statusCode, again.body).toBe(200);
      // Unticked, it can't be ticked again while the gateway is not ready
      expect((await saveMethods(['cod'])).statusCode).toBe(200);
      expect((await refused(saveMethods(['cod', 'online']), 422)).code).toBe(
        'storefront_online_not_ready',
      );
    } finally {
      await setArchived(feeAccount, false);
    }
    expect((await saveMethods(['cod', 'online'])).statusCode).toBe(200);
    expect(await checkoutMethods()).toEqual(['cod', 'online']);
  });

  it('keeps an account the gateway uses from being deleted', async () => {
    const current = accountSchema.parse((await send('GET', `/accounts/${feeAccount.id}`)).json());
    const res = await send(
      'DELETE',
      `/accounts/${feeAccount.id}?version=${String(current.version)}`,
    );
    expect((await refused(Promise.resolve(res), 409)).code).toBe('account_used_by_shop');
  });

  it('needs CREDENTIALS_KEY for a new password and for a test, and takes no online order without it', async () => {
    const keyless = await createTestApp({
      ...config,
      payments: { ...config.payments, credentialsKey: null },
    });
    try {
      const path = '/storefront/payment-gateway';
      const version = (await gateway()).version;
      const asKeyless = (method: 'POST' | 'PUT', url: string, payload?: object) =>
        keyless.inject({
          method,
          url,
          headers: bearer(owner.accessToken),
          ...(payload === undefined ? {} : { payload }),
        });
      expect(
        (
          await refused(
            asKeyless('PUT', path, { ...gatewayForm({ password: 'Another-pass-1' }), version }),
            422,
          )
        ).code,
      ).toBe('storefront_gateway_key_missing');
      expect((await refused(asKeyless('POST', `${path}/test`), 422)).code).toBe(
        'storefront_gateway_key_missing',
      );
      // The password box left empty needs no key: the accounts may still change
      const kept = await asKeyless('PUT', path, { ...gatewayForm({ password: '' }), version });
      expect(kept.statusCode, kept.body).toBe(200);
      // The password can't be opened, so the shop's order is refused, not a 500
      const res = await keyless.inject({
        method: 'POST',
        url: '/public/v1/orders',
        headers: shopper(2),
        payload: {
          ...orderRequest(shop.listingId, 2, phoneOf(2), TWO),
          zoneId,
          paymentMethod: 'online',
        },
      });
      expect((await refused(Promise.resolve(res), 422)).code).toBe('shop_payment_unavailable');
      expect(await orderRowOf(phoneOf(2))).toEqual([]);
    } finally {
      await keyless.close();
    }
  });

  it('is for storefront.manage only', async () => {
    const path = '/storefront/payment-gateway';
    const version = (await gateway()).version;
    for (const res of [
      send('GET', path, undefined, reader),
      send('POST', path, gatewayForm(), reader),
      send('PUT', path, { ...gatewayForm(), version }, reader),
      send('POST', `${path}/test`, undefined, reader),
    ]) {
      expect((await res).statusCode).toBe(403);
    }
    expect((await gateway()).version).toBe(version);
  });
});
```

The Payment card, in the order a workspace goes through it. The tests share the one gateway row of the workspace,
so they run in this order.

- **Before the first save.** The card has no gateway. Its two lists hold Cash in hand and the new fee account, and
  no group in either; the fee list never has a money account. "Test connection" and a change are refused with
  `storefront_gateway_not_set_up`. Ticking Pay online in the shop's settings is refused with
  `storefront_online_not_ready`, under the payment methods, and the checkout offers cash on delivery only.
- **Wrong boxes.** The fee account as the money account, and the money account as the fee account: each refused
  under its own box. A store id with a space and an empty password come back in one answer, each under its box (a
  400: the request's own schema refuses them). After all of it, the table is still empty.
- **The first save.** The answer is the card, ready, version 1, with no test yet, and the password is nowhere in
  it. The row holds 12 + 16 + 17 bytes (nonce, tag, the password), and the password's text is not in them. A second
  first save is refused with `storefront_gateway_set_up_already`, and the saved store id stays. The audit row says
  `changed` under the password and names the money account by its code, never by the password.
- **Changes.** A test answers "no problem" and moves no version. A save with the password box empty keeps the
  sealed bytes as they were, and keeps the last test, because nothing the test reached changed. The same password
  typed again is no change either. A form opened before those saves is refused with `version_conflict`. A new store
  id clears the last test; `fake_rejected` makes the fake gateway refuse, and the next test says `rejected`. A new
  password is sealed again with a new nonce, so its bytes change. In the audit log, only the two saves with a new
  password have a `password` field, and no row has a password's text.
- **Pay online.** Once the gateway is ready, ticking it is saved and the checkout offers it. With the fee account
  archived, the gateway is not ready: the checkout stops offering it, and an order placed with it is refused with
  `shop_payment_unavailable`. A save of the settings with Pay online still ticked goes through (it was ticked
  already); once it is unticked, it can't be ticked again until the account is back.
- **Delete.** The fee account cannot be deleted: `account_used_by_shop`, the fix above.
- **No `CREDENTIALS_KEY`.** A second API with `credentialsKey: null` (decision 45). A new password and a test are
  refused with `storefront_gateway_key_missing`; a save with the password box empty needs no key and goes through.
  An online order through that API is refused with `shop_payment_unavailable` and writes no order: the password
  cannot be opened, so no page could be.
- **Permissions.** A member with `storefront.order.read` only gets 403 on all four routes, and the card's version
  does not move.

```ts
describe('placing an online order', () => {
  it('opens the fake page on the shop address and sends no phone code', async () => {
    const order = await placeOnline(10);
    const page = pageOf(order.paymentUrl);
    expect(order.paymentUrl).toBe(
      `http://nirvor.localhost:4321/checkout/fake-gateway?tranId=${page.tranId}&amount=538.0000`,
    );
    expect(page.tranId).toMatch(/^[A-Z0-9]{20}$/);
    // Waiting for its payment, not for a code: none of the code columns
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'pending',
      payment_method: 'online',
      order_no: null,
      has_code: false,
    });
    expect(await triesOf(order.phone)).toEqual([
      { try_no: 1, status: 'started', tran_id: page.tranId },
    ]);
    // The phone code's routes know no such order
    for (const url of ['/orders/verify', '/orders/resend']) {
      const res = await shopPost(app, url, shopper(10), { token: order.token, code: '123456' });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
    }
    // Paid: the only SMS is the confirmation
    expect(await settled(10, page.tranId, paidValId(page))).toBe('paid');
    await trackingTokenFor(mail.apiUrl, order.phone);
    expect(await smsCount(order.phone)).toBe(1);
  });

  it('keeps a try whose page did not open, and says "checking" while the gateway cannot answer', async () => {
    await sql`UPDATE storefront_payment_gateways SET store_id = 'fake_unreachable'`;
    let order: OnlineOrder;
    try {
      order = await placeOnline(11);
      // The order and its hold stay; /checkout/paid says the page did not open
      expect(order.paymentUrl).toBeNull();
      expect(await triesOf(order.phone)).toMatchObject([{ try_no: 1, status: 'not_opened' }]);
      expect(await waitOf(order)).toEqual({
        state: 'unpaid',
        problem: 'not_opened',
        triesLeft: 2,
        payOnDelivery: true,
        total: '538.0000',
      });
    } finally {
      await sql`UPDATE storefront_payment_gateways SET store_id = ${STORE_ID}`;
    }
    // Try again opens one
    const page = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await triesOf(order.phone)).toMatchObject([
      { try_no: 1, status: 'not_opened' },
      { try_no: 2, status: 'started', tran_id: page.tranId },
    ]);
    // The gateway can't be asked now: the page waits and asks again
    await sql`UPDATE storefront_payment_gateways SET store_id = 'fake_unreachable'`;
    try {
      expect(await waitOf(order)).toEqual({ state: 'checking' });
      // The return post cannot be checked either: the try stays started
      expect(await settled(11, page.tranId, paidValId(page))).toBe('started');
    } finally {
      await sql`UPDATE storefront_payment_gateways SET store_id = ${STORE_ID}`;
    }
    expect(await waitOf(order)).toMatchObject({
      state: 'unpaid',
      problem: 'not_finished',
      triesLeft: 1,
    });
  });
});
```

- **The page.** The answer's address is the fake page on the shop's own address, with the try's 20-letter
  `tranId` and the amount. The order waits with `payment_method = online`, no number and no code, and has one try,
  started. The phone code's routes (verify, resend) do not know it: 404. After the payment, the only SMS the phone
  got is the confirmation.
- **A page that does not open.** The gateway row's store id is set to `fake_unreachable` in SQL, which makes the
  fake gateway answer like SSLCommerz on a bad day. The order is placed all the same, with its hold; the try is
  `not_opened`, and `/checkout/paid` says so, with 2 tries left. "Try again", with the store id back, opens a page.
  With `fake_unreachable` again, `/checkout/paid` says "checking", and the gateway's post leaves the try started:
  nothing can be checked, so nothing is recorded. Back to normal, the page says "not finished" with 1 try left.

Each change of the store id is undone in `finally`, so a failing test does not break the tests after it.

```ts
describe('the gateway coming back', () => {
  it('records a payment once, even when the return and the IPN come at the same moment', async () => {
    const order = await placeOnline(20);
    const page = pageOf(order.paymentUrl);
    // The browser's return first, with the val_id; the IPN a moment later, waiting for the order
    const results = await inTurn('storefront_payments', [
      () => settle(20, page.tranId, paidValId(page)),
      () => settle(20, page.tranId, paidValId(page)),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(results.map((res) => shopPaymentSettledSchema.parse(res.json()).status)).toEqual([
      'paid',
      'paid',
    ]);
    const row = await onlyOrderOf(order.phone);
    expect(row).toMatchObject({ status: 'confirmed', payment_method: 'online' });
    expect(row.order_no).toMatch(/^W-\d{6}$/);
    // One event for the receipt, one receipt, one confirm SMS
    const [events] = await sql`
      SELECT count(*)::int AS n FROM outbox_events
      WHERE tenant_id = ${shop.tenantId} AND type = 'storefront.payment_paid'
        AND payload ->> 'paymentId' = (
          SELECT id::text FROM storefront_payments WHERE tran_id = ${page.tranId})`;
    expect(events?.n).toBe(1);
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments[0]?.receipt).not.toBeNull();
    });
    expect(erp.payments).toHaveLength(1);
    await trackingTokenFor(mail.apiUrl, order.phone);
    expect(await smsCount(order.phone)).toBe(1);
    // A later post changes nothing, whatever it says
    expect(await settled(20, page.tranId, fakeValId(page.tranId, { outcome: 'failed' }))).toBe(
      'paid',
    );
    // /checkout/paid shows "Order Confirmed"
    expect(await waitOf(order)).toEqual({
      state: 'paid',
      orderNo: row.order_no,
      phone: order.phone,
      listingIds: [shop.listingId],
    });
  });

  it('believes no payment of another amount or another try, and knows no made-up tran_id', async () => {
    const order = await placeOnline(21);
    const page = pageOf(order.paymentUrl);
    const other = pageOf((await placeOnline(22)).paymentUrl);
    // Another amount, and the other order's payment posted for this try: both stay started
    expect(
      await settled(21, page.tranId, fakeValId(page.tranId, { outcome: 'paid', amount: '1.0000' })),
    ).toBe('started');
    expect(await settled(21, page.tranId, paidValId(other))).toBe('started');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'pending' });
    // A tran_id nobody made
    const unknown = await settle(21, 'ABCDEFGHIJ0123456789', null);
    expect(unknown.statusCode, unknown.body).toBe(404);
    // A post with no val_id is asked about by the tran_id; the fake gateway knows none
    expect(await settled(21, page.tranId, null)).toBe('started');
    // The real one still pays it
    expect(await settled(21, page.tranId, paidValId(page))).toBe('paid');
  });

  it('confirms an order whose payment came after its hold, because the money came', async () => {
    const order = await placeOnline(23);
    const page = pageOf(order.paymentUrl);
    await ageOrder(order.phone, 61);
    // /checkout/paid no longer offers anything for it
    const res = await shopPost(app, '/orders/payment', shopper(23), { token: order.token });
    expect(res.statusCode, res.body).toBe(404);
    expect(await settled(23, page.tranId, paidValId(page))).toBe('paid');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'confirmed' });
  });
});
```

- **The return and the IPN at the same moment.** The browser's return is sent first and waits, at the payments
  table, while it holds the order's lock; the IPN is sent next and waits for that lock. When the gate opens, the
  return records the payment and confirms the order; the IPN then finds the try paid and changes nothing. Both
  answer `paid`. There is one outbox event for the receipt, one receipt, one payment on the order page and one
  confirm SMS. A later "failed" post changes nothing: paid is final. `/checkout/paid` then shows the order's number,
  the phone and the listings, for "Order Confirmed".
- **Answers that are not this payment.** Another amount, and the other order's payment posted for this try, both
  leave the try started and the order pending: settle checks the answer against the try (decision 2). A `tran_id`
  nobody made is a 404. A post with no `val_id` is asked about by the `tran_id`, which the fake gateway knows
  nothing about. The real answer still pays it.
- **After the hold.** An order placed 61 minutes ago can no longer use `/checkout/paid` (404), but its payment still
  confirms it: the money came (decision 5).

```ts
describe('/checkout/paid and its two buttons', () => {
  it('says what went wrong, and Try again opens a new page, three times at most', async () => {
    const order = await placeOnline(30);
    expect(await waitOf(order)).toEqual({
      state: 'unpaid',
      problem: 'not_finished',
      triesLeft: 2,
      payOnDelivery: true,
      total: '538.0000',
    });
    const first = pageOf(order.paymentUrl);
    expect(await settled(30, first.tranId, fakeValId(first.tranId, { outcome: 'failed' }))).toBe(
      'failed',
    );
    expect(await waitOf(order)).toMatchObject({ problem: 'failed', triesLeft: 2 });

    const second = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(second.tranId).not.toBe(first.tranId);
    expect(
      await settled(30, second.tranId, fakeValId(second.tranId, { outcome: 'cancelled' })),
    ).toBe('cancelled');
    expect(await waitOf(order)).toMatchObject({ problem: 'cancelled', triesLeft: 1 });

    const third = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await waitOf(order)).toMatchObject({ problem: 'not_finished', triesLeft: 0 });
    expect((await refused(retry(order), 422)).code).toBe('shop_payment_tries_used');
    expect((await triesOf(order.phone)).map((row) => row.status)).toEqual([
      'failed',
      'cancelled',
      'started',
    ]);
    // A failed try is not final: its payment, if it came after all, still counts
    expect(await settled(30, first.tranId, paidValId(first))).toBe('paid');
    expect((await triesOf(order.phone)).map((row) => row.status)).toEqual([
      'paid',
      'cancelled',
      'started',
    ]);
    expect(third.tranId).toMatch(/^[A-Z0-9]{20}$/);
  });

  it('turns the order into cash on delivery once, with one phone code', async () => {
    const order = await placeOnline(31);
    const page = pageOf(order.paymentUrl);
    const first = await payOnDelivery(order);
    expect(first.statusCode, first.body).toBe(200);
    expect(shopCodeWaitSchema.parse(first.json())).toMatchObject({ next: 'verify' });
    const { code } = await codeFor(mail.apiUrl, order.phone);
    // A second press answers the same, and sends no second code
    const second = await payOnDelivery(order);
    expect(second.statusCode, second.body).toBe(200);
    expect(await smsCount(order.phone)).toBe(1);
    // Try again is no longer offered, and /checkout/paid sends the shopper to the code
    expect((await refused(retry(order), 409)).code).toBe('shop_payment_settled');
    expect(
      (await shopPost(app, '/orders/payment', shopper(31), { token: order.token })).statusCode,
    ).toBe(404);

    const verified = await shopPost(app, '/orders/verify', shopper(31), {
      token: order.token,
      code,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'confirmed',
      payment_method: 'cod',
    });
    // The page the shopper left open pays after all: kept as paid, and the order stays cash on
    // delivery, so the order page says the rider collects nothing (27d.6)
    expect(await settled(31, page.tranId, paidValId(page))).toBe('paid');
    expect(await onlyOrderOf(order.phone)).toMatchObject({ payment_method: 'cod' });
  });

  it('confirms as online an order that turned into cash on delivery and was paid before its code', async () => {
    const order = await placeOnline(32);
    const page = pageOf(order.paymentUrl);
    expect((await payOnDelivery(order)).statusCode).toBe(200);
    const { code } = await codeFor(mail.apiUrl, order.phone);
    expect(await settled(32, page.tranId, paidValId(page))).toBe('paid');
    // Back to online, with every code column empty again (storefront_orders_pending_check)
    expect(await onlyOrderOf(order.phone)).toMatchObject({
      status: 'confirmed',
      payment_method: 'online',
    });
    const [codes] = await sql`
      SELECT count(*)::int AS n FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${order.phone} AND code_sends IS NOT NULL`;
    expect(codes?.n).toBe(0);
    // The code is no longer asked for
    const verified = await shopPost(app, '/orders/verify', shopper(32), {
      token: order.token,
      code,
    });
    expect(verified.statusCode, verified.body).toBe(404);
    expect(await waitOf(order)).toMatchObject({ state: 'paid' });
  });

  it('offers neither button on a paid order, nor a way the shop no longer takes', async () => {
    const paid = await placeOnline(33);
    const page = pageOf(paid.paymentUrl);
    expect(await settled(33, page.tranId, paidValId(page))).toBe('paid');
    // Confirmed: no order waits for either button
    expect((await payOnDelivery(paid)).statusCode).toBe(404);
    expect((await retry(paid)).statusCode).toBe(404);

    const order = await placeOnline(34);
    await sql`UPDATE storefront_settings SET payment_methods = '{online}' WHERE tenant_id = ${shop.tenantId}`;
    try {
      expect(await waitOf(order)).toMatchObject({ payOnDelivery: false });
      expect((await refused(payOnDelivery(order), 422)).code).toBe('shop_payment_unavailable');
    } finally {
      await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}' WHERE tenant_id = ${shop.tenantId}`;
    }
    await sql`UPDATE storefront_settings SET payment_methods = '{cod}' WHERE tenant_id = ${shop.tenantId}`;
    try {
      // Pay online unticked: no try is spent on a page that cannot open
      expect((await refused(retry(order), 422)).code).toBe('shop_payment_unavailable');
      expect(await triesOf(order.phone)).toHaveLength(1);
    } finally {
      await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}' WHERE tenant_id = ${shop.tenantId}`;
    }
  });
});
```

- **Three tries.** "Not finished" with 2 tries left at first. A failed try says "failed"; "Try again" opens a page
  with a new `tranId`; a cancelled one says "cancelled" with 1 left; a third try leaves 0, and a fourth "Try again"
  is refused with `shop_payment_tries_used`. Then the first, failed try is paid after all: it is recorded, because
  only paid is final (27d.1's mine 11).
- **Pay on delivery.** The answer is the verify page's, and the code SMS comes. A second press answers the same and
  sends no second SMS (mine 40). "Try again" is then refused with `shop_payment_settled`, and `/checkout/paid` has
  nothing to show (404: the shopper is on the verify page now). The right code confirms the order as cash on
  delivery. The page the shopper left open is then paid after all: kept as paid, and the order stays cash on
  delivery. 27d.6's order page says the rider collects nothing.
- **Paid before the code.** The order turned into cash on delivery, and its first page is paid before the code is
  typed: the order is confirmed as online, with every code column empty (27d.3's `confirmPendingOrder`), and the
  code it got is no longer asked for (404).
- **No button.** A paid order has no order waiting for either button (404). A shop that takes only online payment
  says `payOnDelivery: false`, and "Pay on delivery" is refused with `shop_payment_unavailable`. A shop that took
  Pay online off the checkout refuses "Try again" the same way, and writes no try for a page that could not open.

```ts
describe('the money receipt', () => {
  // Packs, ships and delivers an order, as the Shop orders page does
  async function deliver(order: StorefrontOrder): Promise<StorefrontOrder> {
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const packed = await send('POST', `/storefront/orders/${order.id}/pack`, {
      version: order.version,
      lines: plan.lines.map((line) => ({
        position: line.position,
        picks: line.picks.map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
      })),
    });
    expect(packed.statusCode, packed.body).toBe(200);
    const shipped = await send('POST', `/storefront/orders/${order.id}/ship`, {
      version: storefrontOrderSchema.parse(packed.json()).version,
    });
    expect(shipped.statusCode, shipped.body).toBe(200);
    const delivered = await send('POST', `/storefront/orders/${order.id}/deliver`, {
      version: storefrontOrderSchema.parse(shipped.json()).version,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    return storefrontOrderSchema.parse(delivered.json());
  }

  const receiptSchema = z.object({
    number: z.string(),
    amount: z.string(),
    applied: z.string(),
    method: z.string(),
    reference: z.string().nullable(),
    account: z.string(),
  });

  async function receiptOf(id: string) {
    const [row] = z.array(receiptSchema).parse(
      await sql`
        SELECT r.number, r.amount::text, r.applied::text, r.method, r.reference, a.code AS account
        FROM receipts r JOIN ledger_accounts a ON a.tenant_id = r.tenant_id AND a.id = r.account_id
        WHERE r.tenant_id = ${shop.tenantId} AND r.id = ${id}`,
    );
    if (row === undefined) throw new Error(`no receipt ${id}`);
    return row;
  }

  // The receipt's journal lines: account code, debit, credit
  async function entryOf(receiptId: string) {
    return z.array(z.object({ code: z.string(), debit: z.string(), credit: z.string() })).parse(
      await sql`
          SELECT a.code, l.debit::text, l.credit::text FROM journal_lines l
          JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
          JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
          WHERE e.tenant_id = ${shop.tenantId} AND e.source = 'sales_receipt'
            AND e.document_id = ${receiptId}
          ORDER BY l.debit DESC, a.code`,
    );
  }

  async function invoiceOf(order: StorefrontOrder) {
    const id = order.invoice?.id;
    if (id === undefined) throw new Error('no invoice');
    const [row] = z.array(z.object({ total: z.string(), amount_paid: z.string() })).parse(
      await sql`
          SELECT total::text, amount_paid::text FROM invoices
          WHERE tenant_id = ${shop.tenantId} AND id = ${id}`,
    );
    return row;
  }

  it('posts the payment with the gateway fee, and the invoice at Delivered takes it', async () => {
    const order = await placeOnline(40);
    const page = pageOf(order.paymentUrl);
    expect(await settled(40, page.tranId, paidValId(page))).toBe('paid');
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments[0]?.receipt).not.toBeNull();
    });
    // The fake gateway keeps 2.5%: ৳13.45 of ৳538
    expect(erp.payments[0]).toMatchObject({
      tranId: page.tranId,
      status: 'paid',
      amount: '538.0000',
      cardType: 'BKASH-BKash',
      storeAmount: '524.5500',
      receiptError: null,
    });
    const receiptId = erp.payments[0]?.receipt?.id ?? '';
    expect(await receiptOf(receiptId)).toEqual({
      number: erp.payments[0]?.receipt?.number,
      amount: '538.0000',
      applied: '0.0000',
      method: 'mobile_wallet',
      reference: `FAKE${page.tranId.slice(0, 12)} · BKASH-BKash`,
      account: '1110',
    });
    // One entry: the payout into the money account, the fee as an expense, the customer's money
    expect(await entryOf(receiptId)).toEqual([
      { code: '1110', debit: '524.5500', credit: '0.0000' },
      { code: '5999', debit: '13.4500', credit: '0.0000' },
      { code: '1140', debit: '0.0000', credit: '538.0000' },
    ]);

    const delivered = await deliver(erp);
    expect(await invoiceOf(delivered)).toEqual({ total: '538.0000', amount_paid: '538.0000' });
    expect((await receiptOf(receiptId)).applied).toBe('538.0000');
  });

  it("keeps the receipt's refusal on its try, and Make the receipt makes it later", async () => {
    const order = await placeOnline(41);
    const page = pageOf(order.paymentUrl);
    // The fee account archived after the page opened: the receipt cannot post its fee line
    await setArchived(feeAccount, true);
    let erp: StorefrontOrder;
    try {
      expect(await settled(41, page.tranId, paidValId(page))).toBe('paid');
      erp = await erpOrder(order.phone, (found) => {
        expect(found.payments[0]?.receiptError).not.toBeNull();
      });
      expect(erp.payments[0]).toMatchObject({
        status: 'paid',
        receipt: null,
        receiptError: 'storefront_gateway_fee_account_invalid',
      });
      const path = `/storefront/orders/${erp.id}/payments/${erp.payments[0]?.id ?? ''}/receipt`;
      // Pressed while the account is still archived: refused again, the error kept
      expect((await refused(send('POST', path, { version: erp.version }), 409)).code).toBe(
        'storefront_gateway_fee_account_invalid',
      );
    } finally {
      await setArchived(feeAccount, false);
    }
    const path = `/storefront/orders/${erp.id}/payments/${erp.payments[0]?.id ?? ''}/receipt`;
    // A page that is not the newest is refused
    expect((await refused(send('POST', path, { version: erp.version - 1 }), 409)).code).toBe(
      'version_conflict',
    );
    // By someone who may read the orders only: 403
    expect((await send('POST', path, { version: erp.version }, reader)).statusCode).toBe(403);
    const made = await send('POST', path, { version: erp.version });
    expect(made.statusCode, made.body).toBe(200);
    const after = storefrontOrderSchema.parse(made.json());
    expect(after.version).toBe(erp.version + 1);
    expect(after.payments[0]?.receipt?.number).toMatch(/^MR-/);
    expect(after.payments[0]?.receiptError).toBeNull();
    // Pressed again (another tab): nothing more to make
    expect((await refused(send('POST', path, { version: after.version }), 409)).code).toBe(
      'storefront_order_step_invalid',
    );
  });

  it('keeps a second payment of the same order as an advance', async () => {
    const order = await placeOnline(42);
    const first = pageOf(order.paymentUrl);
    // The shopper opens a second page (Try again) and pays there, then the first one pays too
    const second = pageOf(shopPaymentRetrySchema.parse((await retry(order)).json()).paymentUrl);
    expect(await settled(42, second.tranId, paidValId(second))).toBe('paid');
    expect(await settled(42, first.tranId, paidValId(first))).toBe('paid');
    const erp = await erpOrder(order.phone, (found) => {
      expect(found.payments.map((payment) => payment.receipt === null)).toEqual([false, false]);
    });
    expect(erp.payments.map((payment) => payment.status)).toEqual(['paid', 'paid']);
    const delivered = await deliver(erp);
    // The invoice takes the oldest try's receipt; the other stays the customer's advance
    expect(await invoiceOf(delivered)).toEqual({ total: '538.0000', amount_paid: '538.0000' });
    const applied = await Promise.all(
      erp.payments.map(async (payment) => (await receiptOf(payment.receipt?.id ?? '')).applied),
    );
    expect(applied).toEqual(['538.0000', '0.0000']);
  });
});
```

- **The receipt and its fee.** The fake gateway keeps 2.5%, so of ৳538 it pays out ৳524.55. The order page's
  payment has the card type `BKASH-BKash` and that payout. The receipt is ৳538 into Cash in hand, not applied
  yet, with the method `mobile_wallet` (from the card type) and the bank's number and the card type as its
  reference. Its one journal entry is Dr Cash in hand ৳524.55, Dr 5999 ৳13.45, Cr Accounts receivable ৳538. At
  Delivered, the invoice is paid in full and the receipt is applied in full.
- **A refused receipt.** The fee account archived after the page opened: the payment is still recorded (settle
  does not look at the accounts), and the worker's receipt is refused. The try keeps the reason,
  `storefront_gateway_fee_account_invalid`, and has no receipt. "Make the receipt" while the account is still
  archived is refused with the same code. With the account back, a page that is not the newest is refused
  (`version_conflict`), a reader gets 403, and the owner's press makes the receipt and moves the order's version.
  A second press (another tab) finds nothing to make: `storefront_order_step_invalid`.
- **Paid twice.** The shopper opens a second page and pays there, and then pays on the first one too. Both tries
  are paid, each with its receipt. At Delivered, the invoice takes the oldest try's receipt; the other one stays the
  customer's advance (applied 0), for the staff to refund.

```ts
describe('the sweep', () => {
  it('gives an online order an hour more, then deletes it once the gateway knows no payment', async () => {
    const order = await placeOnline(50);
    const cod = phoneOf(51);
    const placed = await shopPost(app, '/orders', shopper(51), {
      ...orderRequest(shop.listingId, 2, cod, TWO),
      zoneId,
    });
    expect(placed.statusCode, placed.body).toBe(201);
    // Both past their hold: the cash on delivery one goes, the online one has its grace hour
    await ageOrder(order.phone, 61);
    await ageOrder(cod, 61);
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(cod)).toEqual([]);
    expect(await triesOf(order.phone)).toHaveLength(1);
    // Past the grace hour: the gateway is asked, knows nothing, and the order goes with its try
    await ageOrder(order.phone, 60);
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(order.phone)).toEqual([]);
    const [tries] = await sql`
      SELECT count(*)::int AS n FROM storefront_payments WHERE tran_id = ${pageOf(order.paymentUrl).tranId}`;
    expect(tries?.n).toBe(0);
    // The gateway's late post for it: unknown now, logged with its tran_id
    const late = await settle(
      50,
      pageOf(order.paymentUrl).tranId,
      paidValId(pageOf(order.paymentUrl)),
    );
    expect(late.statusCode, late.body).toBe(404);
  });

  it('keeps an online order while the gateway cannot be asked', async () => {
    const order = await placeOnline(52);
    await ageOrder(order.phone, 125);
    // A password this server cannot open (another key's version): the gateway can't be asked
    await sql`UPDATE storefront_payment_gateways SET key_version = 2`;
    try {
      await worker.get(PendingOrderSweep).run();
      expect(await orderRowOf(order.phone)).toHaveLength(1);
    } finally {
      await sql`UPDATE storefront_payment_gateways SET key_version = 1`;
    }
    await worker.get(PendingOrderSweep).run();
    expect(await orderRowOf(order.phone)).toEqual([]);
  });

  it('never deletes an order a paid try confirmed', async () => {
    const order = await placeOnline(53);
    const page = pageOf(order.paymentUrl);
    await ageOrder(order.phone, 125);
    expect(await settled(53, page.tranId, paidValId(page))).toBe('paid');
    await worker.get(PendingOrderSweep).run();
    expect(await onlyOrderOf(order.phone)).toMatchObject({ status: 'confirmed' });
    // The database's own wall: a paid try is never deleted, not even with its order
    const error: unknown = await sql`
      DELETE FROM storefront_orders WHERE phone = ${order.phone}`.catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(postgres.PostgresError);
    expect(error instanceof postgres.PostgresError ? error.constraint_name : null).toBe(
      'storefront_payments_paid_kept',
    );
  });
});
```

- **The grace hour.** An online order and a cash on delivery order, both 61 minutes old: the sweep deletes the
  cash on delivery one and keeps the online one, which has one more hour (27d.3's `PAYMENT_GRACE_MINUTES`). An hour
  later, the sweep asks the fake gateway, which knows no payment, and the order goes with its try. The gateway's
  late post for it is then a 404 (the log names the `tran_id`).
- **A gateway that cannot be asked.** The row's `key_version` set to 2 in SQL: this server's key is version 1, so
  the password does not open, and the sweep cannot ask. It keeps the order; with the version back, the next sweep
  deletes it.
- **A paid order.** Paid after its hold, the order is confirmed, and the sweep leaves it. Then the database's own
  wall: deleting that order as the superuser (which skips the row rules, not a trigger) is refused by
  `storefront_payments_paid_kept`, because the delete would take a paid try with it.

### The tenant-leak tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  fakeValId,
  publicOrderPlacedSchema,
  shopCheckoutSettingsSchema,
  shopPaymentSettledSchema,
  type StorefrontPaymentGateway,
  storefrontOrderSchema,
  storefrontPaymentGatewaySchema,
  storefrontPaymentSetupSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

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
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  shopHeaders,
  shopPost,
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';

// Step 27d: a payment is a workspace's own. Two launched shops, Nirvor and Acme, each with its own
// gateway on the Payment card and Pay online ticked. The ERP must show and change only its own
// card, and take no other workspace's account for it; a shop must settle, show and retry only its
// own orders' payments, whatever tran_id or token it is sent; a sealed password must open only in
// the workspace that sealed it; and the shop's database roles must never read a gateway's row.
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
let nirvorGateway: StorefrontPaymentGateway;
let acmeGateway: StorefrontPaymentGateway;

// Two face washes (৳229 each) and the ৳80 delivery charge
const TWO = '538';

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// The Payment card saved with the workspace's Cash in hand and its first fee account
async function saveGateway(who: SignedIn, storeId: string): Promise<StorefrontPaymentGateway> {
  const setup = storefrontPaymentSetupSchema.parse(
    (await send(who, 'GET', '/storefront/payment-gateway')).json(),
  );
  const res = await send(who, 'POST', '/storefront/payment-gateway', {
    storeId,
    password: `${storeId}-password`,
    mode: 'sandbox',
    moneyAccountId: setup.moneyAccounts.find((account) => account.code === '1110')?.id ?? '',
    feeAccountId: setup.feeAccounts[0]?.id ?? '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontPaymentGatewaySchema.parse(res.json());
}

async function cardOf(who: SignedIn): Promise<StorefrontPaymentGateway | null> {
  const res = await send(who, 'GET', '/storefront/payment-gateway');
  expect(res.statusCode, res.body).toBe(200);
  return storefrontPaymentSetupSchema.parse(res.json()).gateway;
}

// An online order of two face washes by shopper n at this shop: its token and its try
async function placeOnline(shop: OrderShop, n: number) {
  const res = await shopPost(app, '/orders', shopHeaders(shop.host, clientAddress(n)), {
    ...orderRequest(shop.listingId, 2, phoneOf(n), TWO),
    paymentMethod: 'online',
  });
  expect(res.statusCode, res.body).toBe(201);
  const { answer, token } = publicOrderPlacedSchema.parse(res.json());
  if (answer.next !== 'pay' || answer.paymentUrl === null) throw new Error('no payment page');
  const url = new URL(answer.paymentUrl);
  return {
    token,
    tranId: url.searchParams.get('tranId') ?? '',
    amount: url.searchParams.get('amount') ?? '',
  };
}

async function tryStatus(tranId: string): Promise<string | undefined> {
  const [row] = z
    .array(z.object({ status: z.string() }))
    .parse(await sql`SELECT status FROM storefront_payments WHERE tran_id = ${tranId}`);
  return row?.status;
}

async function checkoutMethods(shop: OrderShop) {
  const res = await app.inject({
    method: 'GET',
    url: '/public/v1/checkout-settings',
    headers: { 'x-shop-host': shop.host },
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCheckoutSettingsSchema.parse(res.json()).paymentMethods;
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
  nirvorGateway = await saveGateway(nirvorOwner, 'nirvor67412bc');
  acmeGateway = await saveGateway(acmeOwner, 'acme5521de');
  // Pay online ticked in both. The settings form's own check is the other file's: here only the
  // row matters
  await sql`UPDATE storefront_settings SET payment_methods = '{cod,online}'`;
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Payment card', () => {
  it("shows and changes each workspace's own gateway, and takes none of the other's accounts", async () => {
    expect(await cardOf(nirvorOwner)).toMatchObject({ storeId: 'nirvor67412bc', version: 1 });
    expect(await cardOf(acmeOwner)).toMatchObject({ storeId: 'acme5521de', version: 1 });

    // Nirvor's own accounts on Acme's card: not Acme's, so not a choice
    const changed = await send(acmeOwner, 'PUT', '/storefront/payment-gateway', {
      storeId: 'acme5521de',
      password: '',
      mode: 'sandbox',
      moneyAccountId: nirvorGateway.moneyAccountId,
      feeAccountId: nirvorGateway.feeAccountId,
      version: acmeGateway.version,
    });
    expect(changed.statusCode, changed.body).toBe(422);
    // Acme's test and save touch Acme's row only
    const tested = await send(acmeOwner, 'POST', '/storefront/payment-gateway/test');
    expect(tested.statusCode, tested.body).toBe(200);
    expect(await cardOf(nirvorOwner)).toMatchObject({ lastTest: null, version: 1 });
    const audit = z.array(z.object({ action: z.string(), tenant: z.string() })).parse(
      await sql`
          SELECT action, tenant_id::text AS tenant FROM audit_logs
          WHERE entity_type = 'storefront_payment_gateway' ORDER BY created_at, id`,
    );
    expect(audit).toEqual([
      { action: 'storefront_payment_gateway.created', tenant: nirvor.tenantId },
      { action: 'storefront_payment_gateway.created', tenant: acme.tenantId },
      { action: 'storefront_payment_gateway.tested', tenant: acme.tenantId },
    ]);
  });

  it('opens a sealed password only in the workspace that sealed it', async () => {
    const [saved] = z.array(z.object({ sealed: z.instanceof(Buffer) })).parse(
      await sql`
          SELECT password_sealed AS sealed FROM storefront_payment_gateways
          WHERE tenant_id = ${acme.tenantId}`,
    );
    if (saved === undefined) throw new Error("no Acme's gateway");
    // Nirvor's sealed bytes copied into Acme's row: the same key, but the workspace is part of
    // what was sealed (AAD = tenant id), so it does not open there
    await sql`
      UPDATE storefront_payment_gateways SET password_sealed = (
        SELECT password_sealed FROM storefront_payment_gateways WHERE tenant_id = ${nirvor.tenantId})
      WHERE tenant_id = ${acme.tenantId}`;
    try {
      const tested = storefrontPaymentGatewaySchema.parse(
        (await send(acmeOwner, 'POST', '/storefront/payment-gateway/test')).json(),
      );
      expect(tested.lastTest?.problem).toBe('rejected');
      // And the shop can't open a page with it: the order is refused, not paid at Nirvor's store
      const res = await shopPost(app, '/orders', shopHeaders(acme.host, clientAddress(971)), {
        ...orderRequest(acme.listingId, 2, phoneOf(971), TWO),
        paymentMethod: 'online',
      });
      expect(res.statusCode, res.body).toBe(422);
    } finally {
      await sql`
        UPDATE storefront_payment_gateways SET password_sealed = ${saved.sealed}
        WHERE tenant_id = ${acme.tenantId}`;
    }
  });

  it("is ready for each shop on that workspace's own accounts", async () => {
    const acmeFee = acmeGateway.feeAccountId;
    await sql`UPDATE ledger_accounts SET archived_at = now() WHERE id = ${acmeFee}`;
    try {
      expect(await checkoutMethods(acme)).toEqual(['cod']);
      expect(await checkoutMethods(nirvor)).toEqual(['cod', 'online']);
    } finally {
      await sql`UPDATE ledger_accounts SET archived_at = NULL WHERE id = ${acmeFee}`;
    }
    expect(await checkoutMethods(acme)).toEqual(['cod', 'online']);
  });
});

describe("the shops' payment routes", () => {
  it("settle, show and retry only their own orders' payments", async () => {
    const order = await placeOnline(nirvor, 972);
    const atAcme = shopHeaders(acme.host, clientAddress(972));
    const paid = fakeValId(order.tranId, { outcome: 'paid', amount: order.amount });
    // Nirvor's tran_id and token sent through Acme's shop: unknown there
    const calls = [
      shopPost(app, '/payments/settle', atAcme, { tranId: order.tranId, valId: paid }),
      shopPost(app, '/orders/payment', atAcme, { token: order.token }),
      shopPost(app, '/orders/payment/retry', atAcme, { token: order.token }),
      shopPost(app, '/orders/payment/cod', atAcme, { token: order.token }),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
    expect(await tryStatus(order.tranId)).toBe('started');
    const [tries] = await sql`
      SELECT count(*)::int AS n FROM storefront_payments WHERE tenant_id = ${acme.tenantId}`;
    expect(tries?.n).toBe(0);

    // At its own shop it settles, and the receipt is Nirvor's
    const res = await shopPost(
      app,
      '/payments/settle',
      shopHeaders(nirvor.host, clientAddress(972)),
      {
        tranId: order.tranId,
        valId: paid,
      },
    );
    expect(shopPaymentSettledSchema.parse(res.json()).status).toBe('paid');
    await eventually(async () => {
      const rows = z
        .array(z.object({ tenant: z.string() }))
        .parse(await sql`SELECT tenant_id::text AS tenant FROM receipts`);
      expect(rows).toEqual([{ tenant: nirvor.tenantId }]);
    }, 10_000);
  });

  it("make no receipt from the other workspace's order page", async () => {
    const [row] = z.array(z.object({ order: z.string(), payment: z.string() })).parse(
      await sql`
          SELECT order_id::text AS order, id::text AS payment FROM storefront_payments
          WHERE tenant_id = ${nirvor.tenantId} AND status = 'paid' LIMIT 1`,
    );
    if (row === undefined) throw new Error("no Nirvor's paid try");
    const own = storefrontOrderSchema.parse(
      (await send(nirvorOwner, 'GET', `/storefront/orders/${row.order}`)).json(),
    );
    expect((await send(acmeOwner, 'GET', `/storefront/orders/${row.order}`)).statusCode).toBe(404);
    const made = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${row.order}/payments/${row.payment}/receipt`,
      { version: own.version },
    );
    expect(made.statusCode, made.body).toBe(404);
  });
});

describe("the shop's database roles", () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.host, (tx) => tx.execute(query));
  }

  it("never read a gateway's row, not even their own workspace's", async () => {
    const query = drizzleSql`SELECT store_id FROM storefront_payment_gateways`;
    for (const as of [asPublic, asShop]) {
      expect(pgErrorOf(await as(query).catch((caught: unknown) => caught))).toEqual({
        code: '42501',
        message: 'permission denied for table storefront_payment_gateways',
      });
    }
  });

  it("reach no other workspace's payment, and change no amount of their own", async () => {
    const order = await placeOnline(acme, 973);
    // Acme's try, from Nirvor's order role: not there to read or to mark paid
    const seen = await asShop(
      drizzleSql`SELECT id FROM storefront_payments WHERE tran_id = ${order.tranId}`,
    );
    expect(Array.from(seen)).toEqual([]);
    const marked = await asShop(drizzleSql`
      UPDATE storefront_payments SET status = 'paid', settled_at = now(), store_amount = 0
      WHERE tran_id = ${order.tranId} RETURNING id`);
    expect(Array.from(marked)).toEqual([]);
    expect(await tryStatus(order.tranId)).toBe('started');
    // The amount is the order's, never the shop role's to write
    const error = await asShop(drizzleSql`UPDATE storefront_payments SET amount = 1`).catch(
      (caught: unknown) => caught,
    );
    expect(pgErrorOf(error)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_payments',
    });
  });
});
```

Two launched shops, Nirvor and Acme, the same product at the same price in both, each with its own gateway and
Pay online ticked (in SQL: the settings form's own check is the other file's).

- **The Payment card.** Each owner sees their own store id. Nirvor's money and fee accounts on Acme's card are
  refused (422): they are not in Acme's chart. Acme's test changes Acme's row only, and the audit log has each row
  under its own workspace.
- **The sealed password.** Nirvor's sealed bytes copied into Acme's row, as someone with database access could do:
  the key is the same, but the workspace is part of what was sealed (27d.3's AAD), so it does not open. Acme's test
  says `rejected`, and an online order at Acme is refused: it never pays into Nirvor's store. Acme's bytes are put
  back in `finally`.
- **Readiness.** With Acme's fee account archived, Acme's checkout offers cash on delivery only and Nirvor's still
  offers both: `storefront_online_ready()` looks at the caller's workspace.
- **The shop's routes.** Nirvor's `tran_id` and order token sent through Acme's shop: settle, `/checkout/paid`, "Try
  again" and "Pay on delivery" are all 404. Nirvor's try is still started and Acme has no try. Through Nirvor's own
  shop the payment settles, and the receipt is Nirvor's.
- **The order page.** Acme's owner with Nirvor's order and payment ids: 404 for the order and for "Make the receipt".
- **The database roles.** Both of the shop's roles (`omnivo_public` through `ShopDb.read`, `omnivo_shop` through
  `ShopDb.orders`) get "permission denied" for the gateways table, even in their own workspace: the password is
  read only as `omnivo_app` (27d.2). From Nirvor, `omnivo_shop` neither sees Acme's try nor marks it paid, and
  writing an amount is refused for the table: the amount is never the shop role's to set.

### Check this part

```bash
pnpm turbo build --filter=@omnivo/contracts --filter=@omnivo/i18n
pnpm --filter @omnivo/api exec tsc --noEmit -p .
pnpm --filter @omnivo/i18n exec tsc --noEmit
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/storefront/orders apps/api/src/accounts packages/contracts/src/errors.ts packages/i18n/src/locales
node packages/contracts/scripts/gen-openapi.ts
cd apps/api
npx vitest run src/storefront/orders/shop-payments src/accounts --maxWorkers=1
```

All pass: contracts 667, i18n 21, API 223 unit tests. The last line runs the two new files (23 and 7 tests, about
10 seconds each after the containers start) and the accounts suites (16). The payment file passed three runs in a
row: the gate does not depend on luck. The shop and the app still do not type-check until 27d.7.

Broken on purpose, to see that the tests notice:

- The accounts service's two new lines taken out: the delete test fails (500 instead of 409). This is how the bug
  was found.
- "Paid is final" taken out of `settleLocked()`: the race test fails. The IPN records the payment again, and the
  database's guard refuses the change, so it answers 500.
- The three-tries check in "Try again" taken out: the tries test fails. The fourth try's insert meets the
  database's `try_no` check, and the answer is a 500 instead of `shop_payment_tries_used`.
- The hold check in `/checkout/paid` taken out: the test of a payment after the hold fails (200 instead of 404).
- The workspace taken out of the seal's AAD (every workspace sealing with the same words): the sealed-password leak
  test fails, because Nirvor's password opens in Acme's row.

One break did **not** fail a test, on purpose, and shows the second wall:

- The `tenant_id` filter taken out of settle's read of the try: the leak tests still pass. Row security on
  `storefront_payments` keeps `omnivo_shop` inside the shop's workspace, so Nirvor's `tran_id` is still unknown at
  Acme. Both walls must go before a payment leaks.

## 27d.5 — `packages/i18n`: the words of the payment screens

The screens of 27d.6 (the ERP) and 27d.7 (the shop) need their words in English and Bangla, so they come first.
27d.1 already gave the errors and the audit log their words, and 27d.4 added `account_used_by_shop`. This part adds
the Shop settings card for the gateway, the order page's Payments card and its notices, "Pay online" in place of
"Mobile Banking", the shop's `/checkout/paid` page and the fake gateway's page.

These words come before the mockup. If the mockup in 27d.6 changes a screen, the words change with it, and the diffs
below show them as they are at the end of the step.

Five decisions came up while writing the words (mine):

46. **The gateway's card is called "Online payment"**, and the settings form's card stays "Payment" (the checkbox
    group "Ways to pay"). They are two forms (decision 15), so they need two names a person can tell apart. The two
    errors that name the card (`storefront_online_not_ready` from 27d.1 and `account_used_by_shop` from 27d.4) now
    say "Online payment card" and "Shop settings → Online payment", so the error points at the card that fixes it.
47. **Two words for one method: "Pay online" and "Paid online".** "Pay online" is what the shopper is offered: the
    settings checkbox and the checkout's radio card. "Paid online" is how a placed order was paid: the orders list's
    column, the order page, the shop's order page and the tracking page. An online order is confirmed only once its
    money arrives (decision 1), so every online order anyone can see is paid, and "Pay online" on an order would
    read like a job still to do. `paymentMethod` stays `online` on both sides; only the words differ.
48. **Three notices, one action.** A paid order that is cancelled, an order paid online twice, and an order paid
    online that then became cash on delivery all mean the same thing for the staff: money to give back. Each one
    says why in its own sentence and ends with the same "Record refund" link (decision 7). The cash on delivery one
    says first to tell the rider to take no cash, because that is the cheapest fix while the parcel is still out.
49. **The fake gateway's page is translated.** It is meant for development and CI, where English would do, but the
    demo shop on staging runs the mock source (26g's choice), so real visitors land on it. A Bangla shop that jumps
    to an English page looks broken. Its first line says plainly that it is a test page and that no money moves.
50. **`/checkout/paid` promises no time.** Its line says the order "is still here" and its items "are set aside",
    not "for 30 minutes". How long is left depends on the hold, the sweep's run and its hour of grace (decision 5),
    and a clock on the page would be wrong as often as right.

### `locales/en.ts`

```diff
@@ -5236,7 +5236,13 @@ export const en = {
     needsConnection: 'The shop’s menu works on the server. Connect to the internet to use it.',
     statuses: { published: 'In the shop', draft: 'Draft' },
     badges: { most_picked: 'Most Picked', new: 'New', buy_one_get_one: 'Buy 1 Get 1' },
-    payments: { cod: 'Cash on Delivery', online: 'Mobile Banking' },
+    // Step 27d (decision 9): "Pay online" in place of Figma's "Mobile Banking", because
+    // SSLCommerz's page takes cards and internet banking too. The checkbox in Shop settings
+    // says what the shopper is offered
+    payments: { cod: 'Cash on Delivery', online: 'Pay online' },
+    // Step 27d: how an order that is placed was paid (the orders list's column, the order
+    // page). An online order is confirmed only once its money arrives, so it is always paid
+    orderPayments: { cod: 'Cash on Delivery', online: 'Paid online' },
     moveUp: 'Move up',
     moveDown: 'Move down',
     // Step 26g.6: the save bar under a long form, while it has changes (the mockup's bar)
```

`payments` is the checkbox and the checkout's word (decision 9), and the new `orderPayments` is the word for an
order that is placed (decision 47). The orders list and the order page switch to `orderPayments` in 27d.6; the
settings page keeps `payments`. Both lists have exactly the keys of `SHOP_PAYMENT_METHODS`, so a template-literal
key (`storefront.orderPayments.${order.paymentMethod}`) type-checks, and a third method fails the type check until
it has its words in both.

```diff
@@ -5375,7 +5381,11 @@ export const en = {
       deliveryProductOption: '{{name}} · {{sku}}',
       paymentTitle: 'Payment',
       payments: 'Ways to pay',
-      paymentsHint: 'Mobile Banking is bKash or Nagad, paid before the parcel leaves.',
+      paymentsHint:
+        'Pay online sends the shopper to your SSLCommerz store’s page: bKash, Nagad, a card or internet banking. The order is confirmed when the money arrives.',
+      // Step 27d (decision 4): the Pay online box stays disabled until the gateway is ready
+      paymentsOnlineNotReady:
+        'To offer Pay online, save the Online payment card with both of its accounts.',
       create: 'Set up the shop',
       created: 'Shop set up. Open it when the checklist is done.',
       updated: 'Shop settings saved',
```

The checkbox group's hint now says what "Pay online" takes (not only bKash and Nagad) and when the order is
confirmed, because a shop owner deciding whether to tick it needs to know the shopper pays first. The second line,
`paymentsOnlineNotReady`, is for 27d.6: the "Pay online" box is disabled (the checkbox option's `disabled`) until
the gateway is ready, and the hint says what to do. Without it, a disabled box gives no reason; with only the API's
`storefront_online_not_ready`, the person would learn it after pressing Save.

```diff
@@ -5407,6 +5417,61 @@ export const en = {
       // date = the launch day in the workspace's time zone
       openSince: 'Open since {{date}} at {{url}}',
     },
+    // Step 27d: Shop settings → Online payment (decisions 4 and 15), the tenant's own SSLCommerz
+    // store. Its own form with its own footer, beside the settings form. The password never
+    // comes back from the API
+    gateway: {
+      title: 'Online payment',
+      description:
+        'Your SSLCommerz store. Shoppers pay on its page, and the money goes to your SSLCommerz account.',
+      // The card's pill: nothing saved, ready, or an account that no longer fits (ready: false)
+      statuses: { notSaved: 'Not set up', ready: 'Ready', notReady: 'Needs an account' },
+      notReady:
+        'One of the two accounts is archived or no longer fits. Pick another one and save. Until then the checkout does not offer Pay online.',
+      provider: 'Gateway',
+      providers: { sslcommerz: 'SSLCommerz' },
+      mode: 'Store',
+      modes: { sandbox: 'Sandbox', live: 'Live' },
+      modeHint:
+        'A sandbox store takes test cards and moves no real money. Switch to live with the live store’s ID and password once SSLCommerz approves your shop.',
+      storeId: 'Store ID',
+      storeIdPlaceholder: 'nirvo67412bc0d9f1e',
+      storeIdHint: 'From the email SSLCommerz sent when it opened your store.',
+      password: 'Store password',
+      passwordHint:
+        'The API password from the same email, not the one you sign in to SSLCommerz with.',
+      // A saved gateway: the box starts empty, and an empty box keeps the saved password
+      passwordSavedPlaceholder: 'Saved',
+      passwordSavedHint:
+        'A password is saved and never shown. Leave this empty to keep it, or type a new one.',
+      moneyAccount: 'Account the money goes into',
+      moneyAccountPlaceholder: 'Pick an account',
+      moneyAccountHint:
+        'An account that holds money, like “SSLCommerz balance” under your bank accounts. SSLCommerz pays your bank later, in one transfer.',
+      feeAccount: 'Gateway fee account',
+      feeAccountPlaceholder: 'Pick an expense account',
+      feeAccountHint:
+        'SSLCommerz keeps its fee from each payment. The fee is posted here, so the money account shows what SSLCommerz will pay you.',
+      // code · name, like the other account selects
+      accountOption: '{{code}} · {{name}}',
+      noMoneyAccounts:
+        'No active account holds money yet. Add one under the bank accounts in the chart of accounts.',
+      noFeeAccounts: 'No active expense account yet. Add one in the chart of accounts.',
+      test: 'Test connection',
+      testing: 'Testing…',
+      // Decision 15: the test uses what is saved, so it waits while the form has changes
+      testSaveFirst: 'Save your changes first. The test uses what is saved.',
+      // The last test's line (lastTest). date = the date and time in the workspace's time zone
+      neverTested: 'Not tested yet.',
+      testWorked: 'SSLCommerz accepted the store. Tested {{date}}.',
+      testRejected:
+        'SSLCommerz refused the store ID or the password, or the store is not active. Check them, and that the store is Sandbox or Live as SSLCommerz says. Tested {{date}}.',
+      testUnreachable: 'SSLCommerz did not answer. Try again in a few minutes. Tested {{date}}.',
+      create: 'Save gateway',
+      created: 'Payment gateway saved. Tick Pay online under Payment to offer it.',
+      updated: 'Payment gateway saved',
+      loadFailed: "Couldn't load the payment gateway. Refresh the page to try again.",
+    },
     categories: {
       title: 'Shop categories',
       description: 'How the shop groups its listings, in the order its menu shows them',
```

The new `gateway` block, the Online payment card (decision 46), right after the launch checklist's words:

- **`statuses`** are the card's pill: nothing saved yet, ready, or saved but `ready: false`. `notReady` is the
  `warn` notice for the last case. It names both causes the API checks (an archived account, or one that no longer
  fits: a money account moved out of the money tree) and the effect: the checkout stops offering Pay online. That is
  the first thing a shop owner wants to know when online orders stop.
- **`providers` and `modes` have exactly the keys of their contract lists** (`PAYMENT_GATEWAY_PROVIDERS`,
  `PAYMENT_GATEWAY_MODES`), so 27d.6 can type them with `satisfies Record<…>`. "SSLCommerz" is a name and stays the
  same in Bangla.
- **`modeHint`** says what a sandbox store is (test cards, no real money) and when to switch. SSLCommerz gives
  every merchant a sandbox store first, and a live store id typed into sandbox mode, or the other way round, is
  refused like a wrong password (27d.1's `rejected`); `testRejected` says to check this too.
- **`storeIdPlaceholder`** is an id in SSLCommerz's own shape, so the person knows what to copy from the email.
- **`passwordHint`** says it is the API password, not the panel's sign-in password. SSLCommerz sends two passwords,
  and the sign-in one is the one people remember; with it, every payment page would fail to open.
- **`passwordSavedPlaceholder` / `passwordSavedHint`** stand in once a gateway is saved. The box is empty (the API
  never sends the password back, decision 4), and an empty box keeps the saved one (27d.1's update schema). Without
  the hint, an empty box reads as "no password", and someone would type it again on every save.
- **`moneyAccountHint` and `feeAccountHint`** say why there are two accounts, in money words: SSLCommerz pays the
  bank later in one transfer, and keeps a fee from each payment (decision 6). "SSLCommerz balance" is the account
  most shops make for this; the hint names it so the person knows to make one.
- **`noMoneyAccounts` / `noFeeAccounts`** are the selects' empty lines. The choices come from the API, not the
  chart of accounts (storefront.manage does not read it), so an empty select needs to say where the fix is.
- **`testSaveFirst`**: "Test connection" tests what is saved (decision 15), so it waits while the form has changes,
  like the launch checklist's `saveFirst`. A test of the old values while the new ones are on the screen would say
  "works" about something nobody sees.
- **`neverTested`, `testWorked`, `testRejected`, `testUnreachable`** are the card's last-test line (`lastTest`),
  with the time. The line stays on the card, not in a toast, because the next person to open the card needs it too.
  The two problems say different things to do: check the values, or wait.
- **`created`** tells the next step: saving the gateway does not offer it yet; ticking "Pay online" does
  (decision 4: the tenant turns it on).

```diff
@@ -5935,6 +6000,19 @@ export const en = {
           'The invoice waits for its money. Record the cash when the rider brings it back.',
       },
       recordPayment: 'Record payment',
+      // Step 27d (decision 6): a delivered order paid online. The invoice took its receipt
+      deliveredPaid: 'The invoice is paid: it took the online payment’s money receipt.',
+      // Step 27d (decision 7): money the shop has to give back. Each notice ends with "Record
+      // refund", a new refund for the order's customer. amount = one payment try's amount
+      paidCancelled:
+        'The shopper paid {{amount}} online for this order. Pay it back from your SSLCommerz panel, then record the refund.',
+      // Two paid tries: the shopper paid in two tabs. Both tries are for the same total
+      paidTwice:
+        'The shopper paid online twice, {{amount}} each time. Pay one back from your SSLCommerz panel, then record the refund.',
+      // A cash on delivery order with a paid try: the shopper paid, then chose to pay on delivery
+      paidOnCod:
+        'The shopper paid {{amount}} online too, then chose cash on delivery. Tell the rider to take no cash. If the rider took it as well, pay one back.',
+      recordRefund: 'Record refund',
       // Decision 1: the crit notice. reason = the error's own words (errors.*), a whole sentence
       documentError: 'The sales order could not be made. {{reason}}',
       // Decision 29: an order confirmed before 27b has no sales order and no error
```

The order page's notices:

- **`deliveredPaid`** replaces `next.delivered` ("The invoice waits for its money…") on an order paid online. The
  invoice took the receipt at Delivered (27d.3), so asking for cash would be wrong. It is its own key, not a sixth
  entry in `next`, because `next` has one entry per status.
- **`paidCancelled`, `paidTwice`, `paidOnCod`** are decision 48. `amount` is one try's amount; two paid tries are
  for the same total (the total never changes once the order is placed), so `paidTwice` says "each time".
- **`recordRefund`** is the link at the end of each, to a new refund for the order's customer (step 15d). The money
  itself goes back through SSLCommerz's panel until step 28 calls its refund API; the notices say so, because
  "Record refund" alone could be read as "this sends the money".

```diff
@@ -5991,6 +6069,38 @@ export const en = {
       },
       // Under the cancelled step: what the member typed (decision 19, staff only)
       cancelReason: 'Why: {{reason}}',
+      // Step 27d: the Payments card, one row per try, oldest first (storefrontOrderPaymentSchema).
+      // Only for an order with a try: a cash on delivery order that never tried has no card
+      payments: {
+        title: 'Payments',
+        description:
+          'Each visit to the SSLCommerz page. Its own panel finds one by the transaction ID.',
+        // number = the try's place, from 1
+        try: 'Try {{number}}',
+        // The pill (SHOP_PAYMENT_STATUSES)
+        statuses: {
+          started: 'Started',
+          not_opened: 'Page did not open',
+          paid: 'Paid',
+          failed: 'Failed',
+          cancelled: 'Cancelled',
+        },
+        tranId: 'Transaction ID',
+        started: 'Started {{date}}',
+        settled: 'Answered {{date}}',
+        amount: 'Amount',
+        // As SSLCommerz writes them: "BKASH-BKash", and the wallet's or the bank's own number
+        cardType: 'Paid with',
+        bankTranId: 'Bank’s transaction ID',
+        // fee = amount − storeAmount, worked out by the page
+        fee: 'Gateway fee',
+        storeAmount: 'SSLCommerz pays out',
+        receipt: 'Money receipt',
+        // reason = the error's own words (errors.*), a whole sentence
+        receiptError: 'The money receipt could not be made. {{reason}}',
+        makeReceipt: 'Make the receipt',
+        receiptMade: 'Money receipt {{receipt}} made',
+      },
       // Decision 35: Delivered posts an invoice, so it asks first. Shipped does not
       deliverTitle: 'Mark {{number}} delivered?',
       deliverBody:
```

The Payments card, one row per try (`storefrontOrderPaymentSchema`):

- **`statuses`** has exactly the keys of `SHOP_PAYMENT_STATUSES`. "Page did not open" is the shopper's side of
  `not_opened`: the gateway made no page, so no money could have moved.
- **`tranId`** is the label of our transaction id, in `Geist Mono` on the page. The description says why it is
  there: SSLCommerz's panel searches by it, so when a shopper says "I paid", the staff copy it from here.
- **`cardType` and `bankTranId`** are labels, not a sentence with both values, because either can be missing from a
  gateway's answer, and a sentence with an empty hole reads as broken.
- **`fee`** is worked out by the page (`amount − storeAmount`, with `decimal.js`); the card shows the three amounts
  so they visibly add up, like the receipt's journal entry does (Dr money, Dr fee, Cr receivable).
- **`receiptError`** takes the error's own words, like 27b's `documentError`, and `makeReceipt` is the button that
  calls 27d.1's `makePaymentReceipt` route (decision 16).

```diff
@@ -8363,11 +8473,11 @@ export const en = {
       'The payment gateway is saved already. Reload the page to change it.',
     storefront_gateway_not_set_up: 'Save the payment gateway first.',
     storefront_online_not_ready:
-      'Save the payment gateway with its two accounts before you tick Pay online.',
+      'Save the Online payment card with both of its accounts before you tick Pay online.',
     storefront_gateway_key_missing:
       'This server cannot keep a gateway password yet. Ask whoever runs Omnivo for you to set CREDENTIALS_KEY.',
     account_used_by_shop:
-      'The shop’s online payments use this account. Choose another one in Shop settings → Payment first, or archive it.',
+      'The shop’s online payments use this account. Choose another one in Shop settings → Online payment first, or archive it.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

The two errors that now name the card (decision 46).

### `locales/bn.ts`

```diff
@@ -4882,7 +4882,8 @@ export const bn: Messages = {
     needsConnection: 'শপের মেনু সার্ভারে চলে। ব্যবহার করতে ইন্টারনেটে যুক্ত হন।',
     statuses: { published: 'শপে আছে', draft: 'ড্রাফট' },
     badges: { most_picked: 'সবচেয়ে জনপ্রিয়', new: 'নতুন', buy_one_get_one: '১টি কিনলে ১টি ফ্রি' },
-    payments: { cod: 'ক্যাশ অন ডেলিভারি', online: 'মোবাইল ব্যাংকিং' },
+    payments: { cod: 'ক্যাশ অন ডেলিভারি', online: 'অনলাইনে পেমেন্ট' },
+    orderPayments: { cod: 'ক্যাশ অন ডেলিভারি', online: 'অনলাইনে পেমেন্ট হয়েছে' },
     moveUp: 'উপরে সরান',
     moveDown: 'নিচে সরান',
     unsaved: 'পরিবর্তন এখনো সেভ হয়নি',
@@ -5001,7 +5002,10 @@ export const bn: Messages = {
       deliveryProductOption: '{{name}} · {{sku}}',
       paymentTitle: 'পেমেন্ট',
       payments: 'পেমেন্টের উপায়',
-      paymentsHint: 'মোবাইল ব্যাংকিং মানে bKash বা Nagad, পার্সেল রওনা হওয়ার আগে পেমেন্ট।',
+      paymentsHint:
+        'অনলাইনে পেমেন্ট ক্রেতাকে আপনার SSLCommerz স্টোরের পেজে পাঠায়: bKash, Nagad, কার্ড বা ইন্টারনেট ব্যাংকিং। টাকা এলে অর্ডার নিশ্চিত হয়।',
+      paymentsOnlineNotReady:
+        'অনলাইনে পেমেন্ট দিতে চাইলে আগে দুটো অ্যাকাউন্টসহ অনলাইন পেমেন্ট কার্ডটা সেভ করুন।',
       create: 'শপ সেট আপ করুন',
       created: 'শপ সেট আপ হয়েছে। চেকলিস্ট শেষ হলে খুলুন।',
       updated: 'শপের সেটিংস সেভ হয়েছে',
@@ -5029,6 +5033,53 @@ export const bn: Messages = {
       openTitle: 'শপ খোলা আছে',
       openSince: '{{date}} থেকে {{url}}-এ খোলা',
     },
+    gateway: {
+      title: 'অনলাইন পেমেন্ট',
+      description:
+        'আপনার SSLCommerz স্টোর। ক্রেতা এর পেজে টাকা দেন, আর টাকা যায় আপনার SSLCommerz অ্যাকাউন্টে।',
+      statuses: { notSaved: 'সেট আপ হয়নি', ready: 'প্রস্তুত', notReady: 'অ্যাকাউন্ট দরকার' },
+      notReady:
+        'দুটো অ্যাকাউন্টের একটা আর্কাইভ করা, অথবা আর খাটে না। অন্য একটা বেছে সেভ করুন। ততক্ষণ চেকআউটে অনলাইনে পেমেন্ট থাকবে না।',
+      provider: 'গেটওয়ে',
+      providers: { sslcommerz: 'SSLCommerz' },
+      mode: 'স্টোর',
+      modes: { sandbox: 'স্যান্ডবক্স', live: 'লাইভ' },
+      modeHint:
+        'স্যান্ডবক্স স্টোর টেস্ট কার্ড নেয়, আসল টাকা নড়ে না। SSLCommerz আপনার শপ অনুমোদন করলে লাইভ স্টোরের আইডি আর পাসওয়ার্ড দিয়ে লাইভে যান।',
+      storeId: 'স্টোর আইডি',
+      storeIdPlaceholder: 'nirvo67412bc0d9f1e',
+      storeIdHint: 'SSLCommerz আপনার স্টোর খোলার সময় যে ইমেইল পাঠিয়েছে, সেখান থেকে।',
+      password: 'স্টোর পাসওয়ার্ড',
+      passwordHint: 'একই ইমেইলের API পাসওয়ার্ড, SSLCommerz-এ সাইন ইন করার পাসওয়ার্ড নয়।',
+      passwordSavedPlaceholder: 'সেভ করা আছে',
+      passwordSavedHint:
+        'একটা পাসওয়ার্ড সেভ করা আছে, সেটা কখনো দেখানো হয় না। রেখে দিতে বক্স খালি রাখুন, বদলাতে নতুনটা লিখুন।',
+      moneyAccount: 'টাকা যে অ্যাকাউন্টে যায়',
+      moneyAccountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+      moneyAccountHint:
+        'টাকা রাখা হয় এমন একটা অ্যাকাউন্ট, যেমন ব্যাংক অ্যাকাউন্টের নিচে “SSLCommerz ব্যালান্স”। SSLCommerz পরে একবারে আপনার ব্যাংকে টাকা পাঠায়।',
+      feeAccount: 'গেটওয়ের ফি-এর অ্যাকাউন্ট',
+      feeAccountPlaceholder: 'একটা খরচের অ্যাকাউন্ট বাছুন',
+      feeAccountHint:
+        'প্রতিটা পেমেন্ট থেকে SSLCommerz তার ফি রেখে দেয়। ফি এখানে পোস্ট হয়, তাই টাকার অ্যাকাউন্ট দেখায় SSLCommerz আপনাকে কত দেবে।',
+      accountOption: '{{code}} · {{name}}',
+      noMoneyAccounts:
+        'টাকা রাখা হয় এমন কোনো চালু অ্যাকাউন্ট এখনো নেই। চার্ট অব অ্যাকাউন্টসে ব্যাংক অ্যাকাউন্টের নিচে একটা যোগ করুন।',
+      noFeeAccounts: 'কোনো চালু খরচের অ্যাকাউন্ট এখনো নেই। চার্ট অব অ্যাকাউন্টসে একটা যোগ করুন।',
+      test: 'কানেকশন পরীক্ষা করুন',
+      testing: 'পরীক্ষা হচ্ছে…',
+      testSaveFirst: 'আগে বদলগুলো সেভ করুন। পরীক্ষা হয় যা সেভ করা আছে তা দিয়ে।',
+      neverTested: 'এখনো পরীক্ষা হয়নি।',
+      testWorked: 'SSLCommerz স্টোরটা মেনে নিয়েছে। পরীক্ষা: {{date}}।',
+      testRejected:
+        'SSLCommerz স্টোর আইডি বা পাসওয়ার্ড মানেনি, অথবা স্টোরটা চালু নেই। এগুলো দেখুন, আর SSLCommerz যেমন বলেছে স্টোরটা স্যান্ডবক্স না লাইভ, তা মিলিয়ে নিন। পরীক্ষা: {{date}}।',
+      testUnreachable:
+        'SSLCommerz কোনো উত্তর দেয়নি। কয়েক মিনিট পরে আবার চেষ্টা করুন। পরীক্ষা: {{date}}।',
+      create: 'গেটওয়ে সেভ করুন',
+      created: 'পেমেন্ট গেটওয়ে সেভ হয়েছে। দিতে চাইলে পেমেন্টের নিচে অনলাইনে পেমেন্টে টিক দিন।',
+      updated: 'পেমেন্ট গেটওয়ে সেভ হয়েছে',
+      loadFailed: 'পেমেন্ট গেটওয়ে আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
     categories: {
       title: 'শপের ক্যাটাগরি',
       description: 'শপ তার লিস্টিংগুলো যেভাবে সাজায়, মেনুতে যে ক্রমে দেখায়',
@@ -5494,6 +5545,14 @@ export const bn: Messages = {
         delivered: 'ইনভয়েসটা টাকার অপেক্ষায়। রাইডার টাকা নিয়ে ফিরলে সেটা লিখে রাখুন।',
       },
       recordPayment: 'টাকা জমা লিখুন',
+      deliveredPaid: 'ইনভয়েসের টাকা শোধ হয়েছে: অনলাইন পেমেন্টের মানি রিসিট এতে ধরা হয়েছে।',
+      paidCancelled:
+        'ক্রেতা এই অর্ডারের জন্য অনলাইনে {{amount}} দিয়েছেন। আপনার SSLCommerz প্যানেল থেকে টাকাটা ফেরত দিন, তারপর রিফান্ড লিখুন।',
+      paidTwice:
+        'ক্রেতা অনলাইনে দুবার টাকা দিয়েছেন, প্রতিবার {{amount}}। আপনার SSLCommerz প্যানেল থেকে একটা ফেরত দিন, তারপর রিফান্ড লিখুন।',
+      paidOnCod:
+        'ক্রেতা অনলাইনেও {{amount}} দিয়েছেন, তারপর ক্যাশ অন ডেলিভারি বেছেছেন। রাইডারকে নগদ না নিতে বলুন। রাইডার নগদও নিয়ে থাকলে একটা ফেরত দিন।',
+      recordRefund: 'রিফান্ড লিখুন',
       documentError: 'সেলস অর্ডার বানানো যায়নি। {{reason}}',
       noSalesOrder: 'এই অর্ডারের এখনো সেলস অর্ডার নেই। মাল প্যাকের আগে বানান।',
       linesTitle: 'পণ্য',
@@ -5537,6 +5596,31 @@ export const bn: Messages = {
         returned: 'ফেরত এসেছে',
       },
       cancelReason: 'কারণ: {{reason}}',
+      payments: {
+        title: 'পেমেন্ট',
+        description:
+          'SSLCommerz-এর পেজে প্রতিবার যাওয়া। এর নিজের প্যানেল ট্রানজ্যাকশন আইডি দিয়ে খুঁজে পায়।',
+        try: '{{number}} নম্বর চেষ্টা',
+        statuses: {
+          started: 'শুরু হয়েছে',
+          not_opened: 'পেজ খোলেনি',
+          paid: 'টাকা এসেছে',
+          failed: 'ব্যর্থ',
+          cancelled: 'বাতিল',
+        },
+        tranId: 'ট্রানজ্যাকশন আইডি',
+        started: '{{date}} শুরু',
+        settled: '{{date}} উত্তর এসেছে',
+        amount: 'পরিমাণ',
+        cardType: 'যেভাবে দিয়েছেন',
+        bankTranId: 'ব্যাংকের ট্রানজ্যাকশন আইডি',
+        fee: 'গেটওয়ের ফি',
+        storeAmount: 'SSLCommerz দেবে',
+        receipt: 'মানি রিসিট',
+        receiptError: 'মানি রিসিট বানানো যায়নি। {{reason}}',
+        makeReceipt: 'রিসিট বানান',
+        receiptMade: 'মানি রিসিট {{receipt}} বানানো হয়েছে',
+      },
       deliverTitle: '{{number}} পৌঁছেছে বলে চিহ্ন দেবেন?',
       deliverBody:
         'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে। টাকা জমা না লেখা পর্যন্ত এটা বাকি থাকে।',
@@ -7785,11 +7869,11 @@ export const bn: Messages = {
       'পেমেন্ট গেটওয়ে আগেই সেভ করা আছে। বদলাতে পেজটা আবার লোড করুন।',
     storefront_gateway_not_set_up: 'আগে পেমেন্ট গেটওয়ে সেভ করুন।',
     storefront_online_not_ready:
-      'অনলাইনে পেমেন্টে টিক দেওয়ার আগে দুটো অ্যাকাউন্টসহ পেমেন্ট গেটওয়ে সেভ করুন।',
+      'অনলাইনে পেমেন্টে টিক দেওয়ার আগে দুটো অ্যাকাউন্টসহ অনলাইন পেমেন্ট কার্ডটা সেভ করুন।',
     storefront_gateway_key_missing:
       'এই সার্ভার এখনো পেমেন্ট গেটওয়ের পাসওয়ার্ড রাখতে পারে না। যিনি আপনার Omnivo চালান, তাঁকে CREDENTIALS_KEY সেট করতে বলুন।',
     account_used_by_shop:
-      'শপের অনলাইন পেমেন্ট এই অ্যাকাউন্ট ব্যবহার করে। আগে শপের সেটিংস → পেমেন্ট থেকে অন্য একটা বাছুন, অথবা এটা আর্কাইভ করুন।',
+      'শপের অনলাইন পেমেন্ট এই অ্যাকাউন্ট ব্যবহার করে। আগে শপের সেটিংস → অনলাইন পেমেন্ট থেকে অন্য একটা বাছুন, অথবা এটা আর্কাইভ করুন।',
   },
   ui: {
     dataTable: {
```

The same keys in Bangla; the type check fails if one is missing. "অনলাইনে পেমেন্ট" is the word 27d.1's errors already
use for Pay online, "টাকা যে অ্যাকাউন্টে যায়" and "গেটওয়ের ফি-এর অ্যাকাউন্ট" are the audit log's field names, and
"চার্ট অব অ্যাকাউন্টস" and "মানি রিসিট" are the words the accounting pages use, so the card, the log and the books say
one thing. Store, sandbox and live stay close to the English (স্টোর, স্যান্ডবক্স, লাইভ), because they are the words
on SSLCommerz's own panel.

### The shop's words

```diff
@@ -124,13 +124,18 @@ export const shopEn = {
     couponAppliedUpTo: '{{code}} applied: {{off}} off, up to {{upTo}}',
     payment: 'Payment Method',
     cod: 'Cash on Delivery',
-    online: 'Mobile Banking',
+    // Step 27d (decision 9): SSLCommerz's page takes cards and internet banking too
+    online: 'Pay online',
+    // Under the two cards while Pay online is picked
+    onlineHint: 'You pay on SSLCommerz’s page with bKash, Nagad, a card or internet banking.',
     // Three parts, because the link sits inside the sentence and Bangla puts it first
     termsBefore: 'I agree with the ',
     termsLink: 'Terms and Conditions',
     termsAfter: '',
     confirm: 'Confirm Order',
     placing: 'Placing the order…',
+    // Step 27d: the button's words while an online order goes to the payment page
+    openingPayment: 'Opening the payment page…',
     // No answer from the server: the order may not have reached it
     orderFailed: 'The order was not sent. Check the connection, then try again.',
     belowMinimum: 'Orders start at {{minimum}}. Add {{more}} more to order.',
@@ -167,6 +172,8 @@ export const shopEn = {
   },
   // Step 26c: /order/<no>
   order: {
+    // Step 27d: how a placed order was paid. An online order is confirmed only once it is paid
+    paymentMethods: { cod: 'Cash on Delivery', online: 'Paid online' },
     title: 'Order Details',
     // The browser tab: the number, then the shop
     pageTitle: 'Order {{orderNo}} | {{shop}}',
@@ -189,6 +196,57 @@ export const shopEn = {
     // The Delivery Charge row of an order that went out for free
     free: 'Free',
   },
+  // Step 27d: /checkout/paid, where the gateway sends the shopper back (found by the order's
+  // cookie). Paid opens the "Order Confirmed" dialog (`confirmed`); these are the other states
+  paid: {
+    pageTitle: 'Payment | {{shop}}',
+    checkingTitle: 'Checking your payment',
+    checkingText:
+      'SSLCommerz is telling us about your payment. This page looks again by itself in a few seconds.',
+    // Without a script the page cannot look again by itself, so it has a link to itself
+    checkAgain: 'Check again',
+    // The unpaid state's title and line, by why the last try did not pay (SHOP_PAYMENT_PROBLEMS)
+    titles: {
+      failed: 'The payment did not go through',
+      cancelled: 'The payment was cancelled',
+      not_opened: 'The payment page did not open',
+      not_finished: 'The payment is not finished',
+    },
+    texts: {
+      failed: 'SSLCommerz says your bank or wallet refused the payment.',
+      cancelled: 'You cancelled on the payment page, so nothing was paid.',
+      not_opened: 'SSLCommerz did not answer just now, so nothing was paid.',
+      not_finished:
+        'SSLCommerz has no payment for this order yet. If its page is still open in another tab, finish there.',
+    },
+    // total = the order's total, which never changes on this page
+    kept: 'Your order for {{total}} is still here, and its items are set aside for you.',
+    triesLeft_one: 'You can try {{count}} more time.',
+    triesLeft_other: 'You can try {{count}} more times.',
+    noTriesLeft: 'You have used all three tries to pay online.',
+    tryAgain: 'Try again',
+    opening: 'Opening the payment page…',
+    // Decision 3: the order becomes cash on delivery and gets its phone code
+    payOnDelivery: 'Pay on delivery instead',
+    payOnDeliveryHint: 'We send a code to your phone, and you pay the rider in cash.',
+    sendingCode: 'Sending the code…',
+    // Nothing left to press: no tries, and the shop does not take cash on delivery now
+    startAgain: 'Back to checkout',
+    // No answer from the server: the press may not have reached it
+    failed: 'That did not reach the shop. Check the connection, then try again.',
+  },
+  // Step 27d: the fake gateway's page (SHOP_FAKE_GATEWAY_PATH) in development, CI and the demo
+  // shop (decision 8). It stands where SSLCommerz's page stands, so it says plainly what it is
+  fakeGateway: {
+    pageTitle: 'Test payment | {{shop}}',
+    title: 'Test payment',
+    notice: 'This is a test page, not SSLCommerz. No money moves, whichever button you press.',
+    amount: 'Amount',
+    tranId: 'Transaction',
+    pay: 'Pay {{amount}}',
+    fail: 'Fail the payment',
+    cancel: 'Cancel the payment',
+  },
   // Step 26e: tracking. The /track form, and the view it shares with a tracking link (/t/<token>)
   track: {
     title: 'Track Order',
@@ -212,7 +270,7 @@ export const shopEn = {
     total: 'Total',
     // Cash on Delivery, until it is delivered: what to keep ready for the rider
     payOnDelivery: 'Keep {{amount}} ready in cash for the rider.',
-    paidOnline: 'Paid with Mobile Banking.',
+    paidOnline: 'Paid online.',
     parcel: 'Parcel',
     // "Steadfast · SFR2611120042"
     courierLine: '{{courier}} · {{code}}',
```

- **`checkout.online`** is "Pay online" (decision 9), and **`onlineHint`** says what the gateway's page takes, under
  the two cards while Pay online is picked. Without it, a shopper with only a card would not know the option is for
  them.
- **`openingPayment`** is the Confirm Order button's busy words for an online order. The next thing the shopper
  sees is another site's page, and "Placing the order…" would not say why the page changes.
- **`order.paymentMethods`** is decision 47 on the shop's order page (`/order/<no>`, which shows
  `shop.checkout.${method}` today; 27d.7 changes it). **`track.paidOnline`** drops "Mobile Banking" the same way.
- **`paid`** is `/checkout/paid`. Its paid state opens the "Order Confirmed" dialog with the existing `confirmed`
  words, so only the other two states need words here:
  - `checkingTitle` / `checkingText`, and `checkAgain` for a browser without scripts, which cannot look again by
    itself (the page is a plain link to itself then).
  - `titles` and `texts` have exactly the keys of `SHOP_PAYMENT_PROBLEMS`: one title and one line for each reason
    the last try did not pay. Each line says whether money moved, because that is the shopper's first worry. A
    failed try's line does not say "nothing was paid": a bank can take the money and the gateway confirm it later
    (decision 5), and then the order is confirmed anyway.
  - `kept` is decision 50. `total` is the wait answer's total, the one the shopper agreed to.
  - `triesLeft_one` / `_other` and `noTriesLeft` come from the answer's `triesLeft`. Only "Try again" uses a try,
    so the count sits next to that button.
  - `payOnDelivery` and its hint say what happens next (a phone code, cash to the rider), because the button turns
    the order into cash on delivery (decision 3) and the next page asks for a code.
  - `startAgain` is for the dead end: no tries left and the shop does not take cash on delivery now.
- **`fakeGateway`** is decision 49. The three buttons say what each one makes happen; `pay` names the amount, which
  a test can change in the address (decision 17) to pay a wrong amount.

```diff
@@ -108,12 +108,14 @@ export const shopBn: ShopMessages = {
     couponAppliedUpTo: '{{code}} প্রয়োগ হয়েছে: {{off}} ছাড়, সর্বোচ্চ {{upTo}}',
     payment: 'পেমেন্টের উপায়',
     cod: 'ক্যাশ অন ডেলিভারি',
-    online: 'মোবাইল ব্যাংকিং',
+    online: 'অনলাইনে পেমেন্ট',
+    onlineHint: 'SSLCommerz-এর পেজে bKash, Nagad, কার্ড বা ইন্টারনেট ব্যাংকিংয়ে টাকা দেবেন।',
     termsBefore: 'আমি ',
     termsLink: 'শর্তাবলি',
     termsAfter: ' মেনে নিচ্ছি',
     confirm: 'অর্ডার নিশ্চিত করুন',
     placing: 'অর্ডার দেওয়া হচ্ছে…',
+    openingPayment: 'পেমেন্টের পেজ খোলা হচ্ছে…',
     orderFailed: 'অর্ডারটি পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
     belowMinimum: 'সবচেয়ে ছোট অর্ডার {{minimum}}। অর্ডার করতে আরও {{more}}-এর পণ্য যোগ করুন।',
     emptyTitle: 'আপনার কার্ট খালি',
@@ -143,6 +145,7 @@ export const shopBn: ShopMessages = {
     continueShopping: 'কেনাকাটা চালিয়ে যান',
   },
   order: {
+    paymentMethods: { cod: 'ক্যাশ অন ডেলিভারি', online: 'অনলাইনে পেমেন্ট হয়েছে' },
     title: 'অর্ডারের বিস্তারিত',
     pageTitle: 'অর্ডার {{orderNo}} | {{shop}}',
     placedOn: '{{date}} তারিখে দেওয়া',
@@ -163,6 +166,47 @@ export const shopBn: ShopMessages = {
     subtotal: 'সাবটোটাল',
     free: 'ফ্রি',
   },
+  paid: {
+    pageTitle: 'পেমেন্ট | {{shop}}',
+    checkingTitle: 'আপনার পেমেন্ট মেলানো হচ্ছে',
+    checkingText:
+      'SSLCommerz আপনার পেমেন্টের খবর জানাচ্ছে। কয়েক সেকেন্ড পরে এই পেজ নিজেই আবার দেখবে।',
+    checkAgain: 'আবার দেখুন',
+    titles: {
+      failed: 'পেমেন্ট হয়নি',
+      cancelled: 'পেমেন্ট বাতিল করা হয়েছে',
+      not_opened: 'পেমেন্টের পেজ খোলেনি',
+      not_finished: 'পেমেন্ট শেষ হয়নি',
+    },
+    texts: {
+      failed: 'SSLCommerz বলছে আপনার ব্যাংক বা ওয়ালেট পেমেন্টটি নেয়নি।',
+      cancelled: 'আপনি পেমেন্টের পেজে বাতিল করেছেন, তাই কোনো টাকা যায়নি।',
+      not_opened: 'SSLCommerz এইমাত্র উত্তর দেয়নি, তাই কোনো টাকা যায়নি।',
+      not_finished:
+        'SSLCommerz-এ এই অর্ডারের কোনো পেমেন্ট এখনো নেই। এর পেজ অন্য ট্যাবে খোলা থাকলে সেখানে শেষ করুন।',
+    },
+    kept: '{{total}}-এর আপনার অর্ডারটি আছে, আর এর পণ্যগুলো আপনার জন্য আলাদা করে রাখা আছে।',
+    triesLeft_one: 'আর {{count}} বার চেষ্টা করা যাবে।',
+    triesLeft_other: 'আর {{count}} বার চেষ্টা করা যাবে।',
+    noTriesLeft: 'অনলাইনে পেমেন্টের তিনটি চেষ্টাই শেষ।',
+    tryAgain: 'আবার চেষ্টা করুন',
+    opening: 'পেমেন্টের পেজ খোলা হচ্ছে…',
+    payOnDelivery: 'বদলে ডেলিভারির সময় টাকা দিন',
+    payOnDeliveryHint: 'আপনার ফোনে একটি কোড পাঠাব, আর রাইডারকে নগদে টাকা দেবেন।',
+    sendingCode: 'কোড পাঠানো হচ্ছে…',
+    startAgain: 'চেকআউটে ফিরে যান',
+    failed: 'শপে পৌঁছায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
+  },
+  fakeGateway: {
+    pageTitle: 'টেস্ট পেমেন্ট | {{shop}}',
+    title: 'টেস্ট পেমেন্ট',
+    notice: 'এটি টেস্ট পেজ, SSLCommerz নয়। যে বাটনই চাপুন, কোনো টাকা নড়ে না।',
+    amount: 'পরিমাণ',
+    tranId: 'ট্রানজ্যাকশন',
+    pay: '{{amount}} দিন',
+    fail: 'পেমেন্ট ব্যর্থ করুন',
+    cancel: 'পেমেন্ট বাতিল করুন',
+  },
   track: {
     title: 'অর্ডার ট্র্যাক করুন',
     pageTitle: 'অর্ডার ট্র্যাক করুন | {{shop}}',
@@ -181,7 +225,7 @@ export const shopBn: ShopMessages = {
     items_other: '{{count}}টি পণ্য',
     total: 'মোট',
     payOnDelivery: 'রাইডারের জন্য {{amount}} নগদ তৈরি রাখুন।',
-    paidOnline: 'মোবাইল ব্যাংকিংয়ে পরিশোধ করা হয়েছে।',
+    paidOnline: 'অনলাইনে পরিশোধ করা হয়েছে।',
     parcel: 'পার্সেল',
     courierLine: '{{courier}} · {{code}}',
     openCourier: '{{courier}}-এর সাইটে দেখুন',
```

The shop's Bangla, in the shop's own style (একটি, টি), which is a little more formal than the ERP's. "আবার চেষ্টা
করুন" and "চেকআউটে ফিরে যান" are the cart's and the verify page's words.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/shop typecheck
```

The i18n checks pass. The i18n tests include the check that every Bangla string keeps the English one's
`{{placeholders}}`, so a Bangla line that dropped `{{amount}}` fails here, not on the screen. The app and the shop
type checks still fail, and only with the errors 27d.1 expected (the app's mock order has no `payments`; the shop
treats every answer that is not `verify` as confirmed), which 27d.7 fixes. The words are not used by any screen yet:
27d.6 and 27d.7 use them, and 27d.8 looks for words no screen uses and takes them out.

Broken on purpose, to see that the checks notice:

- `makeReceipt` taken out of the Bangla Payments card: the i18n type check fails (`Property 'makeReceipt' is
  missing`).
- `{{amount}}` taken out of the fake gateway's Bangla Pay button: the placeholder test fails for the shop's words.

## 27d.6 — The ERP screens: the Online payment card and the order's payments

The screens follow the mockup approved in this part (local HTML and pictures, no Artifact). Three places change:

- **Shop settings** gets the Online payment card under the Payment card, and the "Pay online" box stays disabled
  until that card is ready.
- **The shop order page** gets a Payments card under the items, a notice when money has to go back, and a timeline
  step that says the payment confirmed the order.
- **The orders list** says "Paid online" in its Payment column.

The mockup found one gap in 27d.5's words: the timeline's "Confirmed with the phone code" is wrong for an online
order, which never gets a code. This part adds that word, and changes the orders page's description, which said
"from the phone code".

Six decisions came up while building the screens (mine):

51. **The Online payment card shows only once the shop is set up.** Before the first save there is no shop to take
    money for, and the first save already has a long form and its own "Set up the shop" button. A second form with
    a second primary button under it would make it unclear which one to press. The API does not need a shop for the
    gateway, so this is only a screen rule.
52. **A ticked "Pay online" box stays enabled when the gateway is not ready.** The box is disabled only while it is
    unticked and the gateway is not ready. If an account was archived after Pay online was ticked, the person must
    still be able to untick it. The API checks only a newly ticked box (27d.3), so saving the settings with it still
    ticked works too.
53. **A saved account that is no longer offered starts empty, with its error under the box at once.** The select
    has no option for an archived account, and a native select with a value it has no option for shows the first
    option anyway, which would look like a choice was made. So the box starts empty and says "Pick an active
    expense account" before anyone presses Save.
54. **"Record refund" refunds the latest paid try's receipt.** Step 15d's refund page starts from a receipt
    (`/refunds/new?receiptId=`), and each paid try has its own receipt. The link shows only with
    `sales.refund.manage` and only when a receipt exists (one that failed has nothing to refund yet). The notice
    itself shows to everyone who can read the order: the packer needs to know the rider takes no cash too. A
    cancelled order and a cash on delivery order name the sum of every paid try (all of it goes back, or none is
    owed by the rider); an order paid twice names one try's amount ("each time").
55. **The timeline picks its word from the order's method.** `confirmed` on an online order reads "Confirmed when
    the payment arrived" with a `CreditCardAccept` icon. A cash on delivery order keeps "Confirmed with the phone
    code", even when a try was paid later, because the code is what confirmed it.
56. **The Payments card is its own file.** The order page is 750 lines already, and the card, its pill and its
    notices are one idea. The page imports it like the pills file.

### The words the mockup asked for

```diff
@@ -5912,7 +5912,7 @@ export const en = {
     // pages show storefront.needsConnection, like the rest of the menu
     orders: {
       title: 'Shop orders',
-      description: 'Orders from your online shop, from the phone code to the shopper’s door',
+      description: 'Orders from your online shop, from the checkout to the shopper’s door',
       searchLabel: 'Search the orders',
       searchPlaceholder: 'Order number, name or phone',
       view: 'Show',
@@ -6061,6 +6061,8 @@ export const en = {
       history: {
         pending: 'Placed in the shop',
         confirmed: 'Confirmed with the phone code',
+        // Step 27d: an online order is confirmed by its payment, not by a code
+        confirmedOnline: 'Confirmed when the payment arrived',
         packed: 'Packed',
         shipped: 'Shipped',
         delivered: 'Delivered',
```

`confirmedOnline` sits next to `confirmed` in `history`. The page builds the key from a word it picks (decision 55),
not from `step.status` alone, so the extra key does not need a status of its own. The description now says "from the
checkout", which is true for both ways to pay.

```diff
@@ -5469,7 +5469,7 @@ export const bn: Messages = {
     // ধাপ ২৭b: শপের অর্ডার (/storefront/orders, সিদ্ধান্ত ১০)
     orders: {
       title: 'শপের অর্ডার',
-      description: 'অনলাইন শপের অর্ডার, ফোনের কোড থেকে ক্রেতার দরজা পর্যন্ত',
+      description: 'অনলাইন শপের অর্ডার, চেকআউট থেকে ক্রেতার দরজা পর্যন্ত',
       searchLabel: 'অর্ডার খুঁজুন',
       searchPlaceholder: 'অর্ডার নম্বর, নাম বা ফোন',
       view: 'দেখান',
@@ -5589,6 +5589,7 @@ export const bn: Messages = {
       history: {
         pending: 'শপে অর্ডার দেওয়া হয়েছে',
         confirmed: 'ফোনের কোডে কনফার্ম হয়েছে',
+        confirmedOnline: 'পেমেন্ট আসার পর কনফার্ম হয়েছে',
         packed: 'প্যাক হয়েছে',
         shipped: 'পাঠানো হয়েছে',
         delivered: 'পৌঁছেছে',
```

The same two changes in Bangla. The type check fails if `bn.ts` misses `confirmedOnline`.

### The query

```diff
@@ -41,6 +41,15 @@ export function storefrontSetupQuery(tenantId: string) {
   });
 }
 
+// Step 27d: the Online payment card's read (the saved gateway, never its password, and the two
+// account selects' choices). Under the same ['storefront', tenantId] key, so a save refreshes it
+export function storefrontPaymentSetupQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['storefront', tenantId, 'payment-gateway'],
+    queryFn: () => call(routes.storefrontPayments.getPaymentGateway),
+  });
+}
+
 export function storefrontCategoriesQuery(tenantId: string) {
   return queryOptions({
     queryKey: ['storefront', tenantId, 'categories'],
```

The card's read is under `['storefront', tenantId]` like every Storefront read, so the menu's one refresh after a
save also refreshes it. It is a query of its own, not a part of the settings read: the settings read is also what the
shop's other pages load, and they do not need the gateway or the account lists.

### The Online payment card

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Coins01Icon,
  InformationCircleIcon,
  LockKeyholeIcon,
  MinusSignCircleIcon,
  Plug01Icon,
  Store01Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  createStorefrontPaymentGatewayInputSchema,
  PAYMENT_GATEWAY_MODES,
  type PaymentGatewayMode,
  routes,
  type StorefrontAccountChoice,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  updateStorefrontPaymentGatewayInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  Field,
  FormAlert,
  Pill,
  SegmentedControl,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';

import { DocumentNotice } from './document-notice';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useTimeZone } from '../lib/workspace';

// Step 27d (decisions 4 and 9): the shop's SSLCommerz store, under the Payment card of Shop settings.
// Its own form with its own footer, not a part of the settings form: it saves to its own route with
// its own version, and its password must never ride along with the shop's other settings. The
// password box always starts empty; once one is saved, an empty box keeps it. "Test connection"
// tests what is saved (the password never travels for a test), so it waits while the form has
// changes.

const FIELDS = ['storeId', 'mode', 'password', 'moneyAccountId', 'feeAccountId'] as const;

// The first save has no version and needs a password. The form keeps one shape for both saves
// (a version of 0 that the first save leaves out), so this is the create schema with the update
// schema's version: the same values, the create schema's password rule
const FIRST_SAVE_SCHEMA = createStorefrontPaymentGatewayInputSchema.extend({
  version: updateStorefrontPaymentGatewayInputSchema.shape.version,
});
```

The card is a component file, not a part of `storefront-settings.tsx`. It is a second form, and a form cannot sit
inside another form in HTML: the browser would send the inner one's fields with the outer one on Enter.

`FIRST_SAVE_SCHEMA` is the create schema with the update schema's `version` (27d.7 changes that `version` rule: the
update schema's is `min(1)`, and the first save's form holds 0; see "The card's first save" there). One form handles both saves, so it
needs one value shape. With the update schema alone, an empty password would pass on the first save and the API
would answer `storefront_gateway_password_required` only after the round trip. With the create schema alone, the
form would have no `version` and the second save would need a different form.

```tsx
type GatewayStatus = 'notSaved' | 'ready' | 'notReady';

const STATUS_PILLS = {
  notSaved: { tone: 'neutral', icon: MinusSignCircleIcon },
  ready: { tone: 'good', icon: CheckmarkCircle02Icon },
  notReady: { tone: 'warn', icon: Alert02Icon },
} as const satisfies Record<
  GatewayStatus,
  { tone: 'neutral' | 'good' | 'warn'; icon: IconSvgElement }
>;

// A saved account that is no longer offered (archived, or no longer a money or an expense
// account) starts empty, so the select never shows a value it has no option for, and the box says
// to pick another one
function choiceOrEmpty(id: string, choices: readonly StorefrontAccountChoice[]): string {
  return choices.some((choice) => choice.id === id) ? id : '';
}

function formValues(setup: StorefrontPaymentSetup) {
  const gateway = setup.gateway;
  return {
    storeId: gateway?.storeId ?? '',
    mode: gateway?.mode ?? 'sandbox',
    password: '',
    moneyAccountId: gateway ? choiceOrEmpty(gateway.moneyAccountId, setup.moneyAccounts) : '',
    feeAccountId: gateway ? choiceOrEmpty(gateway.feeAccountId, setup.feeAccounts) : '',
    version: gateway?.version ?? 0,
  };
}

// The last test, in the footer's left. Each answer in its own colour and with its own icon, so the
// colour is never the only sign
function TestLine({ gateway, dirty }: { gateway: StorefrontPaymentGateway; dirty: boolean }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const line = (tone: string, icon: IconSvgElement, text: string) => (
    <p className={cn('flex items-start gap-1.5 text-label', tone)}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
  if (dirty)
    return line('text-ink-3', InformationCircleIcon, t('storefront.gateway.testSaveFirst'));
  const test = gateway.lastTest;
  if (test === null)
    return line('text-ink-3', InformationCircleIcon, t('storefront.gateway.neverTested'));
  const date = format.dateTime(new Date(test.at), timeZone);
  switch (test.problem) {
    case null:
      return line('text-good', CheckmarkCircle02Icon, t('storefront.gateway.testWorked', { date }));
    case 'rejected':
      return line('text-crit', Alert02Icon, t('storefront.gateway.testRejected', { date }));
    case 'unreachable':
      return line('text-warn', Alert02Icon, t('storefront.gateway.testUnreachable', { date }));
  }
}
```

- **`STATUS_PILLS`** uses `satisfies Record<GatewayStatus, …>`, so a fourth status fails the type check until it has
  a tone and an icon. "Not set up" is neutral (nothing is wrong yet), "Needs an account" is `warn` (the shop stopped
  offering Pay online, and someone must act).
- **`choiceOrEmpty`** is decision 53. Without it the select would show "Pick an account" for a saved account that is
  archived, but the form's value would still be the old id, and Save would send it and get a 422.
- **`formValues`** starts the password empty every time. The API never sends it back (decision 4), and a box that
  showed dots for a saved password would have to send something on the next save.
- **`TestLine`** has a colour and an icon for each answer: `good` for worked, `crit` for refused, `warn` for no
  answer (try again later is not an error of the shop's values), and `ink-3` for never tested. While the form has
  changes it says to save first instead, because the test uses what is saved (decision 15); showing the old result
  next to new values would describe values nobody sees.

```tsx
export function GatewayCard({
  setup,
  onSaved,
}: {
  setup: StorefrontPaymentSetup;
  // The page puts the answer in its cache: the Payment card's "Pay online" box reads `ready`
  onSaved: (gateway: StorefrontPaymentGateway) => void;
}) {
  const { t } = useLocale();
  const gateway = setup.gateway;
  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver:
      gateway === null
        ? zodResolver(FIRST_SAVE_SCHEMA, { error: contractErrorMap })
        : zodResolver(updateStorefrontPaymentGatewayInputSchema, { error: contractErrorMap }),
    defaultValues: formValues(setup),
  });

  // A saved account that no longer fits started empty (formValues): say so under its box at once,
  // with the same words the API would answer on a save
  useEffect(() => {
    if (gateway === null) return;
    if (!setup.moneyAccounts.some((choice) => choice.id === gateway.moneyAccountId)) {
      setError('moneyAccountId', { message: 'storefront_gateway_money_account_invalid' });
    }
    if (!setup.feeAccounts.some((choice) => choice.id === gateway.feeAccountId)) {
      setError('feeAccountId', { message: 'storefront_gateway_fee_account_invalid' });
    }
  }, [gateway, setup.moneyAccounts, setup.feeAccounts, setError]);

  const test = useMutation({
    mutationFn: () => call(routes.storefrontPayments.testPaymentGateway),
    onSuccess: onSaved,
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const { version, ...fields } = values;
      const saved =
        gateway === null
          ? await call(routes.storefrontPayments.createPaymentGateway, { body: fields })
          : await call(routes.storefrontPayments.updatePaymentGateway, {
              body: { ...fields, version },
            });
      test.reset();
      onSaved(saved);
      toast(t(gateway === null ? 'storefront.gateway.created' : 'storefront.gateway.updated'));
      // The page's key starts the card again from the new version; this reset is for the moment
      // in between, so the save bar does not flash back
      reset(formValues({ ...setup, gateway: saved }));
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });

  const status: GatewayStatus =
    gateway === null ? 'notSaved' : gateway.ready ? 'ready' : 'notReady';
  const pill = STATUS_PILLS[status];
  const accountOptions = (choices: readonly StorefrontAccountChoice[], placeholder: string) => [
    { value: '', label: placeholder },
    ...choices.map((choice) => ({
      value: choice.id,
      label: t('storefront.gateway.accountOption', { code: choice.code, name: choice.name }),
    })),
  ];
  const serverError = errors.root?.server?.message;
  const testError =
    test.error instanceof ApiRequestError ? test.error.code : test.error ? 'unknown_error' : null;
```

- **Two resolvers**, picked by whether a gateway is saved. The page gives the card a new `key` after every save, so
  the card never switches from one to the other while it is mounted.
- **The `useEffect`** shows decision 53's error at once. It sets the same error code the schema would
  (`storefront_gateway_fee_account_invalid`), so the words are the ones the API and the schema use. It runs again
  only when the saved gateway or the choices change.
- **`test`** posts with no body and puts the answer in the page's cache through `onSaved`. The answer has the new
  `lastTest`, and the page's key includes it, so the card starts again with the new line. A refused store is a 200
  answer with `problem: 'rejected'`, not an error: only a real failure (no `CREDENTIALS_KEY` on the server) lands in
  `testError`.
- **`onSubmit`** drops `version` from the first save (the create body has none), and calls `test.reset()`, so an old
  test error does not stay under the new values.
- **The error fields** list the five boxes the API can name. A 422 for `moneyAccountId` lands under that select.

```tsx
  return (
    <Card>
      <form
        id="storefront-gateway"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        aria-label={t('storefront.gateway.title')}
      >
        <div className="flex items-start justify-between gap-4">
          <CardHeader
            title={t('storefront.gateway.title')}
            subtitle={t('storefront.gateway.description')}
          />
          {/* The card header's own padding on the right, its top line */}
          <span className="shrink-0 pt-[18px] pr-5">
            <Pill tone={pill.tone} icon={pill.icon}>
              {t(`storefront.gateway.statuses.${status}`)}
            </Pill>
          </span>
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:gap-x-4">
          {status === 'notReady' && (
            <div className="sm:col-span-2">
              <DocumentNotice tone="warn" icon={Alert02Icon}>
                {t('storefront.gateway.notReady')}
              </DocumentNotice>
            </div>
          )}
          {serverError !== undefined && (
            <div className="sm:col-span-2">
              <FormAlert message={serverError} />
            </div>
          )}
          {/* One gateway for now (PAYMENT_GATEWAY_PROVIDERS), so a fact, not a select */}
          <p className="flex items-baseline gap-3 sm:col-span-2">
            <span className="text-label font-medium text-ink">
              {t('storefront.gateway.provider')}
            </span>
            <span className="text-body text-ink-2">
              {t(`storefront.gateway.providers.${gateway?.provider ?? 'sslcommerz'}`)}
            </span>
          </p>
          <div className="sm:col-span-2">
            <Controller
              control={control}
              name="mode"
              render={({ field }) => (
                <Field
                  id="gateway-mode"
                  label={t('storefront.gateway.mode')}
                  hint={t('storefront.gateway.modeHint')}
                  error={errors.mode?.message}
                >
                  <div>
                    <SegmentedControl
                      label={t('storefront.gateway.mode')}
                      value={field.value}
                      options={PAYMENT_GATEWAY_MODES.map((value) => ({
                        value,
                        label: t(`storefront.gateway.modes.${value}`),
                      }))}
                      onChange={(next: PaymentGatewayMode) => {
                        field.onChange(next);
                      }}
                    />
                  </div>
                </Field>
              )}
            />
          </div>
          <TextField
            label={t('storefront.gateway.storeId')}
            icon={Store01Icon}
            placeholder={t('storefront.gateway.storeIdPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            hint={t('storefront.gateway.storeIdHint')}
            {...register('storeId')}
            error={errors.storeId?.message}
          />
          {/* new-password: the browser must not fill in the member's own Omnivo password here */}
          <TextField
            label={t('storefront.gateway.password')}
            icon={LockKeyholeIcon}
            type="password"
            autoComplete="new-password"
            placeholder={
              gateway === null ? undefined : t('storefront.gateway.passwordSavedPlaceholder')
            }
            hint={
              gateway === null
                ? t('storefront.gateway.passwordHint')
                : t('storefront.gateway.passwordSavedHint')
            }
            {...register('password')}
            error={errors.password?.message}
          />
          <SelectField
            label={t('storefront.gateway.moneyAccount')}
            icon={Wallet01Icon}
            options={accountOptions(
              setup.moneyAccounts,
              t('storefront.gateway.moneyAccountPlaceholder'),
            )}
            hint={
              setup.moneyAccounts.length === 0
                ? t('storefront.gateway.noMoneyAccounts')
                : t('storefront.gateway.moneyAccountHint')
            }
            {...register('moneyAccountId')}
            error={errors.moneyAccountId?.message}
          />
          <SelectField
            label={t('storefront.gateway.feeAccount')}
            icon={Coins01Icon}
            options={accountOptions(
              setup.feeAccounts,
              t('storefront.gateway.feeAccountPlaceholder'),
            )}
            hint={
              setup.feeAccounts.length === 0
                ? t('storefront.gateway.noFeeAccounts')
                : t('storefront.gateway.feeAccountHint')
            }
            {...register('feeAccountId')}
            error={errors.feeAccountId?.message}
          />
        </div>
        {/* The footer: the last test on the left, the buttons on the right. Before the first save
            there is nothing to test, so only "Save gateway" */}
        <footer className="grid gap-3 border-t border-line px-5 py-4 sm:flex sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-2">
            {gateway !== null && <TestLine gateway={gateway} dirty={isDirty} />}
            {testError !== null && <FormAlert message={testError} />}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {gateway !== null && (
              <Button
                variant="secondary"
                disabled={isDirty || test.isPending}
                onClick={() => {
                  test.mutate();
                }}
              >
                <HugeiconsIcon icon={Plug01Icon} size={17} strokeWidth={1.5} />
                {test.isPending ? t('storefront.gateway.testing') : t('storefront.gateway.test')}
              </Button>
            )}
            {gateway !== null && isDirty && (
              <Button
                variant="secondary"
                onClick={() => {
                  reset();
                }}
              >
                {t('storefront.discard')}
              </Button>
            )}
            {(gateway === null || isDirty) && (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t('common.saving')
                  : gateway === null
                    ? t('storefront.gateway.create')
                    : t('common.save')}
              </Button>
            )}
          </div>
        </footer>
      </form>
    </Card>
  );
}
```

- **The pill sits beside the card header**, at the header's own top padding, as in the mockup. `CardHeader` has no
  slot for it.
- **The gateway is a fact, not a select.** There is one gateway (`PAYMENT_GATEWAY_PROVIDERS`), and a select with one
  option asks a question with no choice.
- **Store is a segmented control** in a `Field`, so it gets the same label and hint as the boxes. Sandbox and Live
  are two choices that are always both visible, which a select would hide.
- **The password box** is `type="password"` with `autoComplete="new-password"`. Without it, the browser offers the
  member's own Omnivo password, and a person in a hurry would save it as the store password.
- **The selects' hints** become the "no account yet" lines when a list is empty, so the empty select says where to
  fix it (the chart of accounts).
- **The footer** follows the mockup: before the first save, only "Save gateway". After it, "Test connection" always,
  disabled while the form has changes; "Discard changes" and "Save changes" only while it has some. The buttons wrap
  under the test line on a phone.

### Shop settings

```diff
@@ -4,6 +4,7 @@ import {
   Delete02Icon,
   Facebook01Icon,
   Globe02Icon,
+  InformationCircleIcon,
   Instagram,
   LanguageSkillIcon,
   Linkedin01Icon,
@@ -23,6 +24,7 @@ import {
   routes,
   SHOP_PAYMENT_METHODS,
   STOREFRONT_ZONES_MAX,
+  type StorefrontPaymentGateway,
   type StorefrontSettings,
   type StorefrontSetup,
   todayIn,
@@ -54,6 +56,7 @@ import { useEffect, useMemo, useState } from 'react';
 import { Controller, type Path, useFieldArray, useForm } from 'react-hook-form';
 
 import { DocumentNotice } from '../components/document-notice';
+import { GatewayCard } from '../components/storefront-gateway-card';
 import {
   SaveBar,
   ShopLine,
@@ -65,7 +68,11 @@ import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { rowPath } from '../lib/products';
 import { warehousesQuery } from '../lib/queries';
-import { settingsFormValues, storefrontSetupQuery } from '../lib/storefront';
+import {
+  settingsFormValues,
+  storefrontPaymentSetupQuery,
+  storefrontSetupQuery,
+} from '../lib/storefront';
 import { useOnline } from '../lib/use-online';
 import { useTenantId, useTimeZone } from '../lib/workspace';
 
@@ -91,10 +98,14 @@ function fieldNames(zoneCount: number): Path<SettingsValues>[] {
 
 function SettingsForm({
   setup,
+  onlineReady,
   onSaved,
   onDirtyChange,
 }: {
   setup: StorefrontSetup;
+  // Step 27d (decision 4): whether the Online payment card is saved with both accounts. Until it
+  // is, "Pay online" cannot be ticked (the API refuses it too: storefront_online_not_ready)
+  onlineReady: boolean;
   onSaved: (saved: StorefrontSettings) => void;
   // The checklist beside the form waits while the form has changes
   onDirtyChange: (dirty: boolean) => void;
```

The imports, and the new `onlineReady` prop of the settings form. It is a prop, not a second query inside the form,
because the page already reads the gateway for the card, and both must agree.

```diff
@@ -169,9 +180,13 @@ function SettingsForm({
     })),
   ];
   const languageOptions = LANGUAGES.map((item) => ({ value: item.code, label: item.label }));
+  const ticked = watch('paymentMethods');
+  // A box already ticked stays enabled even when the gateway is not ready (an account archived
+  // since): the member must be able to untick it. The API checks only a newly ticked one
   const paymentOptions = SHOP_PAYMENT_METHODS.map((method) => ({
     value: method,
     label: t(`storefront.payments.${method}`),
+    disabled: method === 'online' && !onlineReady && !ticked.includes('online'),
   }));
 
   return (
@@ -414,6 +429,17 @@ function SettingsForm({
               />
             )}
           />
+          {!onlineReady && (
+            <p className="mt-2 flex items-start gap-1.5 text-label text-ink-3">
+              <HugeiconsIcon
+                icon={InformationCircleIcon}
+                size={15}
+                strokeWidth={1.5}
+                className="mt-0.5 shrink-0"
+              />
+              {t('storefront.settings.paymentsOnlineNotReady')}
+            </p>
+          )}
         </div>
       </Card>
 
```

Decision 52: `disabled` only while the box is unticked and the gateway is not ready. `watch('paymentMethods')` makes
the box follow the form, so unticking Pay online on a not-ready gateway disables it at once. Under the group, while
the gateway is not ready, a line with an `InformationCircle` icon says what to do (`paymentsOnlineNotReady`). A
disabled box with no reason next to it reads as a bug.

```diff
@@ -634,6 +660,12 @@ export function StorefrontSettingsPage() {
   const queryClient = useQueryClient();
   const refresh = useStorefrontRefresh();
   const { data: setup, isError } = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
+  // Step 27d: the Online payment card, once the shop is set up (decision 51): before that there is
+  // no shop to take money for, and the first save has enough boxes of its own
+  const payment = useQuery({
+    ...storefrontPaymentSetupQuery(tenantId),
+    enabled: online && setup?.shop != null,
+  });
   // Whether the form has changes, for the checklist (the form reports it)
   const [formDirty, setFormDirty] = useState(false);
   const shop = setup?.shop ?? null;
@@ -646,6 +678,15 @@ export function StorefrontSettingsPage() {
     void refresh();
   };
 
+  const gatewaySaved = (gateway: StorefrontPaymentGateway) => {
+    if (payment.data) {
+      queryClient.setQueryData(storefrontPaymentSetupQuery(tenantId).queryKey, {
+        ...payment.data,
+        gateway,
+      });
+    }
+  };
+
   return (
     <div className="grid max-w-6xl grid-cols-1 gap-5">
       <PageHeader
@@ -670,12 +711,26 @@ export function StorefrontSettingsPage() {
           <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
             {/* key: a new version (the first save, the launch) starts the form again from it, so
                 the next save sends that version */}
-            <SettingsForm
-              key={`${tenantId}-${String(shop?.version ?? 0)}`}
-              setup={setup}
-              onSaved={saved}
-              onDirtyChange={setFormDirty}
-            />
+            <div className="grid min-w-0 gap-5">
+              <SettingsForm
+                key={`${tenantId}-${String(shop?.version ?? 0)}`}
+                setup={setup}
+                onlineReady={payment.data?.gateway?.ready === true}
+                onSaved={saved}
+                onDirtyChange={setFormDirty}
+              />
+              {payment.isError && (
+                <p className="text-body-sm text-crit">{t('storefront.gateway.loadFailed')}</p>
+              )}
+              {/* key: a new version (a save, a test) starts the card again from what is saved */}
+              {payment.data && (
+                <GatewayCard
+                  key={`${tenantId}-${String(payment.data.gateway?.version ?? 0)}-${payment.data.gateway?.lastTest?.at ?? ''}`}
+                  setup={payment.data}
+                  onSaved={gatewaySaved}
+                />
+              )}
+            </div>
             <div className="grid gap-5 lg:sticky lg:top-5">
               {shop?.launchedAt != null ? (
                 <OpenCard shop={shop} />
```

- **The gateway query waits for the shop** (decision 51) and for a connection, like the settings read.
- **`gatewaySaved`** writes the answer into the cache. The settings form reads `ready` from the same entry, so
  saving the gateway enables the Pay online box at once, without a second request.
- **The card's key** has the version and the last test's time. A save changes the version; a test may change only
  `lastTest`, and the card must start again from it either way, or its form would hold the old version.
- **The left column is a grid** of the settings form and the card. The settings form's sticky save bar stays inside
  its own form, so it stops at the end of the settings and never covers the gateway card.

### The order's payments

```tsx
import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CreditCardNotAcceptIcon,
  MoneyRemove01Icon,
  Unlink04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  routes,
  type ShopPaymentStatus,
  type StorefrontOrder,
  type StorefrontOrderPayment,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, FormAlert, Pill, toast } from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { DocumentNotice } from './document-notice';
import { useShopMoney } from './storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { useTimeZone } from '../lib/workspace';

// Step 27d: what the order page shows of the online payment. The Payments card lists every visit
// to the gateway (a "try"), the ones that did not pay too: when a shopper says "I paid", the staff
// find the visit by its transaction ID in SSLCommerz's own panel. The notice says when money has to
// go back (decision 7: the refund is made by hand in the gateway's panel, then recorded here).

// Started is work in progress (brand); a page that did not open, a failed and a cancelled try are
// over and ask nothing of the staff, so neutral, each with its own picture
const PAYMENT_PILLS = {
  started: { tone: 'brand', icon: Clock01Icon },
  not_opened: { tone: 'neutral', icon: Unlink04Icon },
  paid: { tone: 'good', icon: CheckmarkCircle02Icon },
  failed: { tone: 'neutral', icon: CreditCardNotAcceptIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<
  ShopPaymentStatus,
  { tone: 'brand' | 'good' | 'neutral'; icon: IconSvgElement }
>;

function PaymentPill({ status }: { status: ShopPaymentStatus }) {
  const { t } = useLocale();
  const pill = PAYMENT_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.order.payments.statuses.${status}`)}
    </Pill>
  );
}

function paidTries(order: StorefrontOrder): StorefrontOrderPayment[] {
  return order.payments.filter((payment) => payment.status === 'paid');
}

// A delivered online order whose invoice took the payment's receipt (decision 6): the page says
// so in place of "Record the cash when the rider brings it back"
export function invoiceTookPayment(order: StorefrontOrder): boolean {
  return (
    order.status === 'delivered' &&
    order.paymentMethod === 'online' &&
    paidTries(order).some((payment) => payment.receipt !== null)
  );
}

// Decision 7: why the shop has to give money back, or null. Three cases, in this order:
// - cancelled: the order was cancelled (or returned) after the shopper paid;
// - cod: a cash on delivery order with a paid try (the shopper paid, then chose to pay the rider);
// - twice: an online order paid twice (two tabs).
export function refundCase(order: StorefrontOrder): 'cancelled' | 'cod' | 'twice' | null {
  const paid = paidTries(order);
  if (paid.length === 0) return null;
  if (order.status === 'cancelled' || order.status === 'returned') return 'cancelled';
  if (order.paymentMethod === 'cod') return 'cod';
  return paid.length > 1 ? 'twice' : null;
}

// The notice for refundCase. "Record refund" opens a new refund of the latest paid try's receipt,
// for someone who may write refunds; a try whose receipt could not be made has nothing to refund
// yet, so no link
export function RefundNotice({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  const money = useShopMoney();
  const can = useCan();
  const kind = refundCase(order);
  if (kind === null) return null;
  const paid = paidTries(order);
  // Every try asks for the order's total, so "twice" names one try's amount; the others name
  // everything paid
  const amount = money(
    kind === 'twice' ? (paid[0]?.amount ?? '0') : sumMoney(paid.map((payment) => payment.amount)),
  );
  const text = {
    cancelled: t('storefront.order.paidCancelled', { amount }),
    cod: t('storefront.order.paidOnCod', { amount }),
    twice: t('storefront.order.paidTwice', { amount }),
  }[kind];
  const withReceipt = paid.filter((payment) => payment.receipt !== null);
  const receipt = withReceipt[withReceipt.length - 1]?.receipt ?? null;
  const action = receipt !== null && can('sales.refund.manage') && (
    <Link
      to="/refunds/new"
      search={{ receiptId: receipt.id }}
      className="font-medium text-brand underline-offset-3 hover:underline"
    >
      {t('storefront.order.recordRefund')}
    </Link>
  );
  return (
    <DocumentNotice tone="warn" icon={MoneyRemove01Icon} action={action}>
      {text}
    </DocumentNotice>
  );
}
```

- **`PAYMENT_PILLS`** follows the mockup: Started is work in progress (`brand`, `Clock01`); a page that did not
  open, a failed and a cancelled try are over and ask nothing of the staff, so they are neutral, each with its own
  icon (`Unlink04`, `CreditCardNotAccept`, `CancelCircle`). Failed is not `crit`: a shopper whose card was declined
  is the shop's normal day, not an error of the shop.
- **`invoiceTookPayment`** asks for a paid try with a receipt. A paid try whose receipt failed left the invoice
  unpaid, so the page keeps the usual "Record the cash" line until the receipt is made.
- **`refundCase`** is a plain function, so the page can ask whether there is a notice before it adds one. If the
  page always added the component and it rendered nothing, the notices' wrapper would still be there and add an
  empty 20px gap.
- **`RefundNotice`** is decision 54. The receipt is the last paid try's that has one. The amount uses `sumMoney`
  (whole paisa, no floats), and the shop's own money style (paisa only when there is some), like the rest of the
  page.

```tsx
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm break-words text-ink">{children}</dd>
    </div>
  );
}

function PaymentRow({
  order,
  payment,
  number,
  onMade,
}: {
  order: StorefrontOrder;
  payment: StorefrontOrderPayment;
  number: number;
  onMade: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t, format, errorText } = useLocale();
  const timeZone = useTimeZone();
  const money = useShopMoney();
  const can = useCan();
  // "Make the receipt" tries again after the worker could not (decision 6: an account archived
  // since the gateway was saved, a closed day). The order's version guards it like every move
  const make = useMutation({
    mutationFn: () =>
      call(routes.storefrontOrders.makePaymentReceipt, {
        params: { id: order.id, paymentId: payment.id },
        body: { version: order.version },
      }),
    onSuccess: async (saved) => {
      await onMade(saved);
      const made = saved.payments.find((item) => item.id === payment.id)?.receipt;
      toast(t('storefront.order.payments.receiptMade', { receipt: made?.number ?? '' }));
    },
  });
  const makeError =
    make.error instanceof ApiRequestError ? make.error.code : make.error ? 'unknown_error' : null;
  const time = (at: string) => format.dateTime(new Date(at), timeZone);
  const paid = payment.status === 'paid';
  return (
    <li className="grid gap-3 border-t border-line px-5 py-4">
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-body-sm font-medium text-ink">
            {t('storefront.order.payments.try', { number })}
          </span>
          <PaymentPill status={payment.status} />
          <span className="ml-auto text-body-sm font-medium tabular-nums">
            {money(payment.amount)}
          </span>
        </div>
        <p className="text-caption text-ink-3 tabular-nums">
          {t('storefront.order.payments.started', { date: time(payment.startedAt) })}
          {payment.settledAt !== null &&
            ` · ${t('storefront.order.payments.settled', { date: time(payment.settledAt) })}`}
        </p>
      </div>
      {/* Three facts a row from sm, two on a phone; a try that did not pay has only its ID */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label={t('storefront.order.payments.tranId')}>
          <span className="font-mono">{payment.tranId}</span>
        </Fact>
        {paid && payment.cardType !== null && (
          <Fact label={t('storefront.order.payments.cardType')}>{payment.cardType}</Fact>
        )}
        {paid && payment.bankTranId !== null && (
          <Fact label={t('storefront.order.payments.bankTranId')}>
            <span className="font-mono">{payment.bankTranId}</span>
          </Fact>
        )}
        {paid && payment.storeAmount !== null && (
          <>
            <Fact label={t('storefront.order.payments.fee')}>
              <span className="tabular-nums">
                {money(subtractMoney(payment.amount, payment.storeAmount))}
              </span>
            </Fact>
            <Fact label={t('storefront.order.payments.storeAmount')}>
              <span className="tabular-nums">{money(payment.storeAmount)}</span>
            </Fact>
          </>
        )}
        {payment.receipt !== null && (
          <Fact label={t('storefront.order.payments.receipt')}>
            <Link
              to="/receipts/$receiptId"
              params={{ receiptId: payment.receipt.id }}
              className="font-mono font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {payment.receipt.number ?? '—'}
            </Link>
          </Fact>
        )}
      </dl>
      {payment.receiptError !== null && (
        <div className="grid justify-items-start gap-3 rounded-control bg-subtle p-3">
          <p className="flex items-start gap-1.5 text-label text-crit">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={15}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0"
            />
            {t('storefront.order.payments.receiptError', {
              reason: errorText(payment.receiptError),
            })}
          </p>
          {makeError !== null && <FormAlert message={makeError} />}
          {can('storefront.order.manage') && (
            <Button
              variant="secondary"
              size="sm"
              disabled={make.isPending}
              onClick={() => {
                make.mutate();
              }}
            >
              {t('storefront.order.payments.makeReceipt')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

// Only for an order with a try: a cash on delivery order that never tried has no card
export function PaymentsCard({
  order,
  onMade,
}: {
  order: StorefrontOrder;
  onMade: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  if (order.payments.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t('storefront.order.payments.title')}
        subtitle={t('storefront.order.payments.description')}
      />
      <ol className="mt-3">
        {order.payments.map((payment, index) => (
          <PaymentRow
            key={payment.id}
            order={order}
            payment={payment}
            number={index + 1}
            onMade={onMade}
          />
        ))}
      </ol>
    </Card>
  );
}
```

- **A try that did not pay shows only its transaction ID.** The other facts are null until the gateway says paid,
  and empty labels would make the shopper's failed tries look like half-recorded payments.
- **The fee** is `amount − storeAmount`, with `subtractMoney` from the contracts (whole paisa, not floats). The three
  amounts add up on the screen, like the receipt's entry: Dr money, Dr fee, Cr receivable.
- **The facts grid** is two columns on a phone and three from `sm`. `break-words` keeps a long bank id inside its
  column on a 390px screen.
- **"Make the receipt"** sends the order's version, like every move, so a second tab that already made it gets a
  version conflict instead of a second receipt. The button shows only with `storefront.order.manage`; a reader sees
  the error and no button. On success the page takes the order's new answer (`onMade` is the page's `applyMove`),
  which also refreshes the sales and journal reads the receipt changed.
- **`PaymentsCard` returns nothing for an order with no tries.** A cash on delivery order that never tried to pay
  online has nothing to show, and an empty card would ask "where did the payments go?".

### The order page

```diff
@@ -3,6 +3,7 @@ import {
   AlertCircleIcon,
   ArrowLeft01Icon,
   CancelCircleIcon,
+  CreditCardAcceptIcon,
   DeliveryTruck01Icon,
   Image01Icon,
   PackageDeliveredIcon,
@@ -45,6 +46,12 @@ import { useForm } from 'react-hook-form';
 import { CancelDraftDialog } from '../components/cancel-draft-dialog';
 import { DocumentNotice } from '../components/document-notice';
 import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
+import {
+  invoiceTookPayment,
+  PaymentsCard,
+  refundCase,
+  RefundNotice,
+} from '../components/storefront-order-payments';
 import { StorefrontOffline, useShopMoney } from '../components/storefront-parts';
 import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
@@ -83,6 +90,14 @@ const STEP_ICONS = {
   returned: PackageReceiveIcon,
 } as const satisfies Record<ShopOrderStatus, IconSvgElement>;
 
+// Step 27d: an online order is confirmed by its payment, not by a code. A cash on delivery order
+// keeps the phone's step even when a try was paid later (the code confirmed it)
+function stepOf(order: StorefrontOrder, status: ShopOrderStatus) {
+  return status === 'confirmed' && order.paymentMethod === 'online'
+    ? ({ word: 'confirmedOnline', icon: CreditCardAcceptIcon } as const)
+    : { word: status, icon: STEP_ICONS[status] };
+}
+
 const STEP_BUTTONS = {
   makeSalesOrder: Agreement01Icon,
   pack: PackageIcon,
```

`stepOf` is decision 55. The `as const` keeps `'confirmedOnline'` a literal: without it the word widens to `string`,
and `t(\`storefront.order.history.${word}\`)` no longer type-checks against the word list.

```diff
@@ -243,7 +258,7 @@ function ShopperCard({ order }: { order: StorefrontOrder }) {
         <div className="grid grid-cols-2 gap-4">
           <Fact label={t('storefront.order.zone')}>{order.zoneName}</Fact>
           <Fact label={t('storefront.order.payment')}>
-            {t(`storefront.payments.${order.paymentMethod}`)}
+            {t(`storefront.orderPayments.${order.paymentMethod}`)}
           </Fact>
         </div>
         <Fact label={t('storefront.order.customer')}>
@@ -365,44 +380,47 @@ function TimelineCard({ order }: { order: StorefrontOrder }) {
     <Card>
       <CardHeader title={t('storefront.order.timelineTitle')} />
       <ol className="grid px-5 pt-4 pb-5">
-        {order.history.map((step, index) => (
-          <li
-            key={`${step.status}-${step.at}`}
-            className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
-          >
-            {/* The line down to the next step, behind the dots; none after the last one */}
-            {index < last && (
+        {order.history.map((step, index) => {
+          const shown = stepOf(order, step.status);
+          return (
+            <li
+              key={`${step.status}-${step.at}`}
+              className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
+            >
+              {/* The line down to the next step, behind the dots; none after the last one */}
+              {index < last && (
+                <span
+                  aria-hidden="true"
+                  className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line"
+                />
+              )}
+              {/* The step the order is at is brand; the earlier ones are done and step back */}
               <span
                 aria-hidden="true"
-                className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line"
-              />
-            )}
-            {/* The step the order is at is brand; the earlier ones are done and step back */}
-            <span
-              aria-hidden="true"
-              className={cn(
-                'grid size-6 place-items-center rounded-full',
-                index === last ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
-              )}
-            >
-              <HugeiconsIcon icon={STEP_ICONS[step.status]} size={14} strokeWidth={1.5} />
-            </span>
-            <span className="grid min-w-0">
-              <span className="text-body-sm font-medium text-ink">
-                {t(`storefront.order.history.${step.status}`)}
-              </span>
-              <span className="text-caption text-ink-3 tabular-nums">
-                {format.dateTime(new Date(step.at), timeZone)}
+                className={cn(
+                  'grid size-6 place-items-center rounded-full',
+                  index === last ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
+                )}
+              >
+                <HugeiconsIcon icon={shown.icon} size={14} strokeWidth={1.5} />
               </span>
-              {/* Decision 19: the staff's reason, under the step it explains */}
-              {step.status === 'cancelled' && order.cancelReason !== null && (
-                <span className="mt-1 text-body-sm text-ink-2">
-                  {t('storefront.order.cancelReason', { reason: order.cancelReason })}
+              <span className="grid min-w-0">
+                <span className="text-body-sm font-medium text-ink">
+                  {t(`storefront.order.history.${shown.word}`)}
                 </span>
-              )}
-            </span>
-          </li>
-        ))}
+                <span className="text-caption text-ink-3 tabular-nums">
+                  {format.dateTime(new Date(step.at), timeZone)}
+                </span>
+                {/* Decision 19: the staff's reason, under the step it explains */}
+                {step.status === 'cancelled' && order.cancelReason !== null && (
+                  <span className="mt-1 text-body-sm text-ink-2">
+                    {t('storefront.order.cancelReason', { reason: order.cancelReason })}
+                  </span>
+                )}
+              </span>
+            </li>
+          );
+        })}
       </ol>
     </Card>
   );
```

The shopper card says "Paid online" (27d.5's `orderPayments`, decision 47), and the timeline uses `stepOf`.

```diff
@@ -555,7 +573,20 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         {t('storefront.order.noSalesOrder')}
       </DocumentNotice>,
     );
-  } else if (canManage && order.status !== 'cancelled' && order.status !== 'returned') {
+  }
+  // Step 27d (decision 7): money to give back. For every reader: the one who packs needs to know
+  // the rider takes no cash too
+  if (refundCase(order) !== null) notices.push(<RefundNotice key="refund" order={order} />);
+  // The two notices above say what comes first; the step's own line only after them
+  const blocked = order.documentError !== null || step === 'makeSalesOrder';
+  if (!blocked && invoiceTookPayment(order)) {
+    // Step 27d (decision 6): nothing to record, the invoice took the online payment's receipt
+    notices.push(
+      <DocumentNotice key="next" tone="neutral">
+        {t('storefront.order.deliveredPaid')}
+      </DocumentNotice>,
+    );
+  } else if (!blocked && canManage && order.status !== 'cancelled' && order.status !== 'returned') {
     // Decision 7: a delivered order's money comes in as an ordinary receipt for its invoice, for
     // someone who may write one
     const receipt = order.status === 'delivered' &&
```

The notices, in the order they matter: the sales order's error first (nothing can happen before it is made), then the
refund notice, then the step's own line. `blocked` keeps the step's line away while one of the first two says what
comes first. On a delivered order paid online, `deliveredPaid` takes the place of "Record the cash", and it has no
"Record payment" link, because there is nothing to record.

```diff
@@ -644,15 +675,22 @@ function OrderView({ order }: { order: StorefrontOrder }) {
           <div className="order-1">
             <LinesCard order={order} />
           </div>
-          <div className="order-4">
+          {/* Step 27d: under the lines, the gateway's visits (none: no card, and the empty
+              wrapper takes no gap, being `contents` on a phone and empty in the xl grid) */}
+          {order.payments.length > 0 && (
+            <div className="order-2">
+              <PaymentsCard order={order} onMade={applyMove} />
+            </div>
+          )}
+          <div className="order-5">
             <TimelineCard order={order} />
           </div>
         </div>
         <div className="contents xl:grid xl:gap-5">
-          <div className="order-2">
+          <div className="order-3">
             <ShopperCard order={order} />
           </div>
-          <div className="order-3">
+          <div className="order-4">
             <DocumentsCard order={order} />
           </div>
         </div>
```

The Payments card sits under the items, as in the mockup. On a phone the cards are one stack ordered by `order-*`,
so the numbers move up by one: items, payments, address, documents, timeline. The payments come right after the
items because "did they pay?" is the packer's next question.

### The orders list

```diff
@@ -138,10 +138,10 @@ export function StorefrontOrdersPage() {
         column.accessor('paymentMethod', {
           header: t('storefront.orders.columns.payment'),
           enableSorting: false,
-          // No meta.card, so not on a phone's card: every order is Cash on Delivery until step 27c
-          // brings online payment, and the line would say the same on every card (27b.7)
+          // No meta.card, so not on a phone's card (the user's choice in 27b.7). Step 27d: the
+          // list's own words, "Paid online", since an online order is only listed once it is paid
           cell: ({ getValue }) => (
-            <span className="text-ink-2">{t(`storefront.payments.${getValue()}`)}</span>
+            <span className="text-ink-2">{t(`storefront.orderPayments.${getValue()}`)}</span>
           ),
         }),
         column.accessor('total', {
```

The column uses the list's words, "Paid online". It stays off the phone's card, as the user chose in 27b.7.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm --filter @omnivo/app typecheck
pnpm exec eslint apps/app/src/components/storefront-gateway-card.tsx apps/app/src/components/storefront-order-payments.tsx apps/app/src/routes/storefront-order.tsx apps/app/src/routes/storefront-orders.tsx apps/app/src/routes/storefront-settings.tsx apps/app/src/lib/storefront.ts
pnpm exec prettier --check apps/app/src packages/i18n/src
```

The i18n checks, ESLint and Prettier pass. The app's type check has one error left, the one 27d.1 expected: the mock
order in `src/mocks/storefront-order-data.ts` has no `payments`. 27d.7 fixes it, with the mock API for the gateway
card. Until then the mock app cannot show these screens (the order page would read `payments` of a mock order that
has none), so the screens are checked against the mockup in 27d.7, with Playwright.

## 27d.7 — The shop's payment pages, the mock API and the browser tests

This part connects the shop to the payment routes of 27d.3, and gives the ERP's mock API what the 27d.6 screens read.
Three groups of files:

- **The shop (`apps/shop`):** the origin check that lets SSLCommerz post back, the gateway's two paths, the
  "Try again" and "Pay on delivery" routes, the `/checkout/paid` page, the fake gateway's page, the checkout's
  "Pay online" branch, and the mock source's online orders.
- **The ERP's mock API (`apps/app/src/mocks`):** the Online payment card's four routes, the orders' tries and their
  money receipts, and "Make the receipt".
- **The tests:** unit tests for every new shop file, Playwright for the shop (the whole online payment, and a post
  from another site) and for the ERP (the card and the Payments card).

Ten decisions came up while building it (mine):

57. **The shop runs Astro's origin check itself.** Astro's `security.checkOrigin` answers 403 to any form another
    site posts, and SSLCommerz sends the shopper back by posting a form from its own site (decision 2). Astro's check
    cannot leave one path out, so the config turns it off and the middleware runs a copy of its rules, with exactly
    two paths let through: the return path and the notice path. The copy keeps Astro 7.4's rules line for line, so
    every other form is refused as before.
58. **The return path always ends in a 303 to `/checkout/paid`.** It settles the try first when the post has the ids,
    so the page usually has the answer at once. When it could not (the API was down, or the post was not one it can
    read), the page asks the API itself, and the gateway's notice brings the answer too. The 303 turns the POST into
    a GET, so a reload never posts again, and the GET brings the `SameSite=Lax` checkout cookie, which the
    cross-site POST did not.
59. **The notice path answers for the gateway:** 200 once settled, 400 for a post with no usable transaction id, 404
    for an id no try has, and 500 when the API was down. SSLCommerz sends a notice again after an error, so only a
    real failure is a 500.
60. **"Try again" and "Pay on delivery" are JSON routes that read the checkout cookie**, like "Resend code". Neither
    clears the cookie: after "Pay on delivery" the same token names an order that waits for its phone code, and the
    verify page needs it.
61. **`/checkout/paid` writes the cookies itself when the order is paid.** The order moves into this browser's orders
    cookie, as a right phone code moves it, and the checkout cookie goes. So "View Order Details" opens the order,
    and a reload goes to `/checkout` instead of opening the dialog twice. "Checking" looks again after 4 seconds
    with `location.replace()`, so the Back button does not walk through every look. After any refusal of a button,
    the page is drawn again from the server: it says more than a message could (paid meanwhile, Cash on Delivery in
    another tab, no tries left).
62. **The fake gateway's page is a page of every shop.** The shop cannot know whether the API runs the fake gateway or
    SSLCommerz. On a shop whose API asks SSLCommerz, a fake `val_id` pays nothing (SSLCommerz knows no such payment),
    so the page is harmless there. It says plainly what it is, is `noindex`, and answers 404 for an address that is
    not a try's. One form with three submit buttons: the pressed button's `name` and `value` go with the post, so it
    needs no script.
63. **`placeOrder()` and `retryPayment()` take the shop's own origin.** The contract wants a whole address for the
    payment page (`shopPaymentUrlSchema`), and the checkout checks the answer with it. The first version of the mock
    answered a path (`/checkout/fake-gateway?…`), and the checkout said "The order was not sent" (the shop's
    Playwright test found it). The routes pass `url.origin`, which is the shop's address as the browser sees it,
    behind the proxy too. Only the mock uses it: the API builds the address from its own settings.
64. **The mock shop keeps the API's payment rules:** an online order has no phone code (the mock's `123456` must not
    confirm an unpaid order), paid is final, a payment for another amount or another try is not believed, a payment
    after the hour still confirms the order (decision 5), and a payment that arrives after "Pay on delivery" confirms
    the order as online if its code was not typed yet.
65. **The ERP mock's shop takes Cash on Delivery only until its Online payment card is saved.** The API refuses Pay
    online without a ready gateway, so the seed cannot tick it without one. The shop orders' seed connects a sandbox
    store (money to `1121 Dutch-Bangla Bank`, fees to `5410 Bank charges`), because its orders were paid online, and
    seeds a try for each case the Payments card shows: paid and taken by the invoice (W-000001), refused then paid
    and cancelled (W-000002), paid after the phone code (W-000004), and paid twice with the second receipt failed
    (W-000006). Every other order and test stays as it was.
66. **The mock's money receipt carries the gateway's fee line**, as the API's `createForShop` does: the money account
    gets what SSLCommerz pays out, and the fee goes to its account, in the receipt's own entry.

One bug in 27d.6's code came out of this part's Playwright test, and is fixed here: the Online payment card's first
save did nothing. See "The card's first save" below.

### The origin check

```diff
@@ -34,7 +34,12 @@ export default defineConfig({
   // can be on any domain. That is safe only while nothing but the proxy can reach the server, and
   // the proxy writes X-Forwarded-For itself (infra/staging/Caddyfile → the shop), never passing on
   // one the visitor sent
-  security: { allowedDomains: [{}] },
+  // Step 27d (decision 2): checkOrigin off, because SSLCommerz posts the shopper back from its own
+  // site, and Astro's check would answer that post 403 with no way to leave one path out. The
+  // middleware runs the same check itself, with only the gateway's two paths let through
+  // (src/server/origin-check.ts). Never turn this off without that: every form here would take a
+  // post from any site
+  security: { allowedDomains: [{}], checkOrigin: false },
   build: { format: 'file' },
   // Step 26f.5: where the data comes from (src/data/config.ts). "secret" is Astro's word for "read
   // when the server runs, never written into the build": a public server value would be fixed when
```

`checkOrigin: false` is safe only together with the middleware below. The comment says so, because removing the
middleware's two lines later would leave every form of the shop open to a post from any site, with no error
anywhere.

```ts
import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';

// Step 27d (decision 2): the shop's own copy of Astro's origin check (security.checkOrigin), with
// two paths let through. Astro's check stops a form that another site posts to this server (CSRF):
// without it, a page anywhere could post the /track form or "Resend code" in a shopper's name. But
// SSLCommerz sends the shopper back to the shop by posting a form from its own site, which the
// check refuses with 403, and Astro's check cannot leave one path out. So astro.config.ts turns it
// off, and the middleware runs this instead, for every request, before any page or route.
//
// The rules are Astro 7.4's (astro/dist/core/app/origin-check.js), so nothing else changes:
// - GET, HEAD and OPTIONS are never refused: they change nothing
// - only the bodies a plain HTML form can send are checked (or no Content-Type at all). JSON from
//   another site needs the browser to ask this server first (CORS), and this server allows no one
// - Sec-Fetch-Site says where the request came from in every current browser; Origin is the
//   answer for older ones (Safari before 16.4), compared with the request's own origin
// - neither header: not a browser's form (a server, curl), so nothing to protect a cookie from

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The only paths another site may post to. Both read no cookie and settle nothing on the post's
// word: the API asks the gateway about the two ids (server/payments.ts), so a stranger's post can
// at most make the API ask SSLCommerz about a payment that does not exist
export const CROSS_SITE_PATHS: ReadonlySet<string> = new Set([
  SHOP_PAYMENT_RETURN_PATH,
  SHOP_PAYMENT_NOTICE_PATH,
]);

function isFormLike(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return FORM_TYPES.some((formType) => type.includes(formType));
}

// true: refuse with 403, as Astro would. `url` is the request's own address as Astro sees it
// (Astro.url), behind the proxy too (security.allowedDomains)
export function isForbiddenCrossSite(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  // The exact path only: trailingSlash is 'never', so "/checkout/pay/return/" is not the page
  if (CROSS_SITE_PATHS.has(url.pathname)) return false;
  const contentType = request.headers.get('content-type');
  if (contentType && !isFormLike(contentType)) return false;
  switch (request.headers.get('sec-fetch-site')) {
    case null:
    case '':
      break;
    case 'same-origin':
    case 'none':
      return false;
    // same-site too: another shop on omnivosoft.com is another tenant, not this one
    default:
      return true;
  }
  const origin = request.headers.get('origin');
  if (!origin) return false;
  return origin !== url.origin;
}

// Astro's own answer, word for word, so a refused post looks the same as before
export function crossSiteForbidden(request: Request): Response {
  return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
    status: 403,
  });
}
```

- **`SAFE_METHODS`**: a GET changes nothing, so it is never refused. This is also why the 303's GET to
  `/checkout/paid` passes.
- **`CROSS_SITE_PATHS`** is checked before the headers, and by the exact path. `trailingSlash: 'never'` means
  `/checkout/pay/return/` is not the page, so it must not be let through either: a test checks it.
- **The Content-Type rule** is Astro's: only what a plain HTML form can send is checked (or no Content-Type at all,
  a body-less post). JSON from another site needs the browser to ask this server first (CORS), and the shop allows
  no one, so the JSON routes are safe without the check.
- **`same-site` is refused.** Another tenant's shop on `omnivosoft.com` is the same site to a browser, but it is
  another tenant: a form there must not post to this shop in a shopper's name.
- **Neither header** means the request did not come from a browser's form (a server, curl, the gateway's notice).
  There is no shopper's cookie to protect then, so it passes, as in Astro.
- **`crossSiteForbidden`** answers Astro's own words, so a refused post looks the same as before the change.

```diff
@@ -2,12 +2,19 @@ import { defineMiddleware } from 'astro:middleware';
 
 import { ShopMissingError } from './data/api/shop-api';
 import { sourceFor } from './data/source';
+import { crossSiteForbidden, isForbiddenCrossSite } from './server/origin-check';
 import { problemResponse } from './server/problem';
 
 // Step 26f.5: runs before every page and API route. It gives the request its data source (the one
 // for the shop its host names), and stops a host that is no launched shop before any page runs,
 // because every page draws the shop's header and footer and would fail without a shop.
 export const onRequest = defineMiddleware(async (context, next) => {
+  // Step 27d: Astro's origin check, with the gateway's two paths let through (decision 2). First,
+  // so a refused post costs no request to the API
+  if (isForbiddenCrossSite(context.request, context.url)) {
+    return crossSiteForbidden(context.request);
+  }
+
   const source = sourceFor(context.url);
   context.locals.source = source;
 
```

The check runs first, before the shop is looked up, so a refused post costs no request to the API.

```diff
@@ -89,8 +89,8 @@ interface BodySchema<T> {
 // Step 26c: the first lines of every POST route, in one place. The body must say it is JSON, be
 // JSON, and pass the schema; anything else is the response to send back as it is.
 // The Content-Type check matters for the routes that read cookies: a form on another site can post
-// text/plain to this server, and Astro's origin check (security.checkOrigin, on by default) is the
-// only thing that refuses it. JSON can only come from a script, which the browser stops from
+// text/plain to this server, and the origin check is the only thing that refuses it (Astro's until
+// step 27d, the middleware's since: server/origin-check.ts). JSON can only come from a script, which the browser stops from
 // another site unless the server allows it (CORS), and this server allows no one.
 export async function readBody<T>(
   request: Request,
```

Only a comment: it named Astro's check as the thing that refuses a cross-site text/plain post.

### The data source

```diff
@@ -13,6 +13,10 @@ import type {
   ShopOrder,
   ShopOrderConfirmed,
   ShopOrderRequest,
+  ShopPaymentRetry,
+  ShopPaymentSettled,
+  ShopPaymentSettleRequest,
+  ShopPaymentWait,
   ShopProductPage,
   ShopTextPage,
   ShopTextPageSlug,
@@ -37,7 +41,22 @@ export type ShopRefusalCode =
   | 'shop_code_expired'
   | 'shop_code_sends_used'
   // Step 27c: a once-per-mobile-number coupon this phone has an order with (27c's decision 3)
-  | 'shop_coupon_used_by_phone';
+  | 'shop_coupon_used_by_phone'
+  // Step 27d: "Try again" and "Pay on delivery" on /checkout/paid. shop_payment_unavailable above
+  // is reused: the shop stopped taking the method the button asks for
+  | 'shop_payment_no_order'
+  | 'shop_payment_tries_used'
+  | 'shop_payment_settled';
+
+// Step 27d: what the two buttons on /checkout/paid may be refused with. Their own lists, as for
+// verifyCode(): "Pay on delivery" never uses up tries, so it has no reason to get that refusal
+export type ShopRetryRefusal =
+  | 'shop_payment_no_order'
+  | 'shop_payment_tries_used'
+  | 'shop_payment_settled'
+  | 'shop_payment_unavailable';
+export type ShopPayOnDeliveryRefusal =
+  'shop_payment_no_order' | 'shop_payment_settled' | 'shop_payment_unavailable';
 
 // Step 27a: the /track form's refusals. Their own list, not ShopRefusalCode: the form is a page,
 // not one of the order routes, and draws them itself (server/track.ts), so they need no status in
@@ -89,8 +108,15 @@ export interface ShopSource {
   // Step 26c: the checkout. The routes check every request with its schema first, as for quote()
   checkoutSettings(): Promise<ShopCheckoutSettings>;
   // Step 27a: `address` is the shopper's own (Astro's clientAddress). The API counts the orders
-  // from one connection with it (SHOP_ORDERS_PER_ADDRESS); the mock has no such limit
-  placeOrder(request: ShopOrderRequest, address: string): Promise<SourceResult<PlacedOrder>>;
+  // from one connection with it (SHOP_ORDERS_PER_ADDRESS); the mock has no such limit.
+  // Step 27d: `origin` is this shop's own address as the shopper's browser sees it (Astro.url's
+  // origin, behind the proxy too). Only the mock reads it, to build its fake gateway page's whole
+  // address (shopPaymentUrlSchema); the API builds that address from its own settings
+  placeOrder(
+    request: ShopOrderRequest,
+    address: string,
+    origin: string,
+  ): Promise<SourceResult<PlacedOrder>>;
   // The order that waits for its phone code, found by the token from the cookie. null: none
   // waits (never placed, confirmed already, dropped, or past its hour). Step 27a: the type is the
   // API's answer (shopCodeWaitSchema), so the verify page draws exactly what the API sends
@@ -104,6 +130,22 @@ export interface ShopSource {
   // shop: its code goes only to the phone
   readonly testCode: string | null;
 
+  // Step 27d: paying online. The gateway came back with a try's ids (the return path or the
+  // notice); the source asks the gateway and records the answer. null: no try of this shop has the
+  // transaction id (a made-up post, or an order dropped since)
+  settlePayment(request: ShopPaymentSettleRequest): Promise<ShopPaymentSettled | null>;
+  // /checkout/paid, by the checkout cookie's token. null: no online order waits in this browser
+  // (it became Cash on Delivery, was dropped, or the cookie names none)
+  paymentWait(token: string): Promise<ShopPaymentWait | null>;
+  // "Try again": a new payment page for the same order and hold
+  retryPayment(
+    token: string,
+    origin: string,
+  ): Promise<SourceResult<ShopPaymentRetry, ShopRetryRefusal>>;
+  // "Pay on delivery instead": the order becomes Cash on Delivery and gets its phone code. The
+  // answer is the verify page's (codeWait's)
+  payOnDelivery(token: string): Promise<SourceResult<ShopCodeWait, ShopPayOnDeliveryRefusal>>;
+
   // Step 26e: tracking. The order a tracking link names, or null for "no such order", never an
   // error: an old link is normal traffic, like an unknown slug in product(). The page checks the
   // token's shape first (shopTrackingTokenSchema), so a source never sees a cut or edited link
```

- **Three refusals join `ShopRefusalCode`.** The routes give each refusal its HTTP status in `REFUSALS`
  (`server/orders.ts`), and its `satisfies Record<ShopRefusalCode, …>` fails the type check until each has one.
- **`ShopRetryRefusal` and `ShopPayOnDeliveryRefusal`** are the closed lists for the two buttons, as `verifyCode()`
  has its own. "Pay on delivery" never uses up tries, so it cannot be refused with `shop_payment_tries_used`.
- **`settlePayment()` and `paymentWait()` answer `null`** for "no such try" and "no online order waits here". Both are
  normal traffic (a made-up post, an order that became Cash on Delivery), not errors, like `product()`'s null.
- **`origin`** is decision 63.

```diff
@@ -1,11 +1,14 @@
 import {
   compareMoney,
   maskPhone,
+  readFakeValId,
   SHOP_CODE_RESEND_SECONDS,
   SHOP_CODE_SENDS,
   SHOP_CODE_TRIES,
   SHOP_CODE_VALID_MINUTES,
+  SHOP_FAKE_GATEWAY_PATH,
   SHOP_ORDER_HOLD_MINUTES,
+  SHOP_PAYMENT_TRIES,
   type ShopCartQuote,
   type ShopCheckoutSettings,
   type ShopCodeResent,
@@ -15,12 +18,22 @@ import {
   type ShopOrderConfirmed,
   type ShopOrderLine,
   type ShopOrderRequest,
+  type ShopPaymentRetry,
+  type ShopPaymentSettled,
+  type ShopPaymentSettleRequest,
+  type ShopPaymentStatus,
+  type ShopPaymentWait,
   type ShopShipment,
   type ShopTracking,
   type ShopTrackRequest,
 } from '@omnivo/contracts';
 
-import type { PlacedOrder, SourceResult } from '../types';
+import type {
+  PlacedOrder,
+  ShopPayOnDeliveryRefusal,
+  ShopRetryRefusal,
+  SourceResult,
+} from '../types';
 
 // Step 26c: the mock's orders, kept in memory (decision 3). Everything here is what step 26's API
 // will do with tables; the shape of the answers is the same, so the pages never change.
@@ -38,6 +51,16 @@ export const MOCK_CODE = '123456';
 const WAIT_MS = SHOP_ORDER_HOLD_MINUTES * 60 * 1000;
 const CODE_MS = SHOP_CODE_VALID_MINUTES * 60 * 1000;
 
+// Step 27d: one visit to the payment page of an online order, as the API's storefront_payments row
+// keeps it. The mock's gateway is the fake one (decision 8): its page is the shop's own
+// (SHOP_FAKE_GATEWAY_PATH), and the val_id it posts back says what happened, so the mock keeps no
+// more than this
+interface MockPayment {
+  tranId: string;
+  status: ShopPaymentStatus;
+  amount: string;
+}
+
 interface MockOrder {
   token: string;
   order: ShopOrder;
@@ -52,6 +75,8 @@ interface MockOrder {
   // order gets 3 at most
   codeExpiresAt: number;
   codeSends: number;
+  // Step 27d: an online order's tries, oldest first. Empty for Cash on Delivery
+  payments: MockPayment[];
 }
 
 // Step 26e: an order the mock starts with (demo-orders.ts), so a tracking link and the /track form
@@ -90,6 +115,24 @@ function newToken(): string {
   return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 }
 
+// Step 27d: a try's transaction id, in the API's shape (shopPaymentTranIdSchema): 20 upper-case
+// letters and digits. 2^32 is not a multiple of 36, so the first letters come up a little more
+// often than the last; for a mock id nobody pays with, that does not matter
+const TRAN_ID_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
+function newTranId(): string {
+  const numbers = crypto.getRandomValues(new Uint32Array(20));
+  return Array.from(numbers, (value) => TRAN_ID_LETTERS[value % 36] ?? 'A').join('');
+}
+
+// Step 27d: the fake gateway's page for one try, on the shop the browser is on (`origin`, from the
+// route), as the API's FakeGateway puts it on the shop's own address. A whole address, because the
+// contract wants one (shopPaymentUrlSchema), and the checkout checks the answer with it
+function fakePage(origin: string, tranId: string, amount: string): string {
+  const url = new URL(SHOP_FAKE_GATEWAY_PATH, origin);
+  url.search = new URLSearchParams({ tranId, amount }).toString();
+  return url.toString();
+}
+
 // W-000123: W for web, so a shop order is never mistaken for an ERP sales order (decision 3)
 function orderNumber(sequence: number): string {
   return `W-${String(sequence).padStart(6, '0')}`;
@@ -121,6 +164,7 @@ export function createOrderBook(
       expiresAt: 0,
       codeExpiresAt: 0,
       codeSends: 0,
+      payments: [],
     });
     byTrackingToken.set(trackingToken, key);
   }
@@ -145,6 +189,34 @@ export function createOrderBook(
     return entry;
   }
 
+  // Step 27d: a waiting order that has a phone code: Cash on Delivery only. An online order waits
+  // for its payment and has no code, so the code's routes do not know it, as in the API (where its
+  // code columns are empty, 27d.2). Without this, the mock's 123456 would confirm an unpaid order
+  function waitingForCode(token: string): MockOrder | null {
+    const entry = waiting(token);
+    return entry?.order.paymentMethod === 'cod' ? entry : null;
+  }
+
+  // Step 27d: the order and try a transaction id names, in any status. Not through waiting(): a
+  // payment that arrives after the hour still confirms the order (decision 5)
+  function byTranId(tranId: string): { entry: MockOrder; payment: MockPayment } | null {
+    for (const entry of byToken.values()) {
+      const payment = entry.payments.find((candidate) => candidate.tranId === tranId);
+      if (payment !== undefined) return { entry, payment };
+    }
+    return null;
+  }
+
+  // The verify page's answer for an order that has its code
+  function codeWaitOf(entry: MockOrder): ShopCodeWait {
+    return {
+      next: 'verify',
+      maskedPhone: maskPhone(entry.order.phone),
+      resendInSeconds: secondsUntil(entry.resendAt),
+      listingIds: entry.order.lines.map((line) => line.listingId),
+    };
+  }
+
   // Step 27c: an order that holds a use of its coupon now (27c's decision 3): every order but a
   // cancelled one, and one that waits for its phone code only inside its hour. The API's
   // storefront_coupon_uses() counts the same orders. A dropped order (five wrong codes, or its hour
@@ -180,6 +252,7 @@ export function createOrderBook(
       quote: ShopCartQuote,
       settings: ShopCheckoutSettings,
       coupons: readonly ShopCouponRule[],
+      origin: string,
     ): SourceResult<PlacedOrder> {
       const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
       if (!zone) return { ok: false, code: 'shop_zone_unknown' };
@@ -273,16 +346,26 @@ export function createOrderBook(
         expiresAt: placedAt.getTime() + WAIT_MS,
         codeExpiresAt: placedAt.getTime() + CODE_MS,
         codeSends: 1,
+        payments: [],
       };
       byToken.set(token, entry);
 
-      // Mobile Banking needs no code in the mock (decision 4): confirmed at once. Its number is in
-      // the answer; a Cash on Delivery order's is not, as in the API, where it has none yet. (The
-      // mock numbers an order when it is placed, which the shopper never sees: a dropped order
-      // only leaves a gap in a book that is forgotten at the next restart)
+      // Step 27d: Pay online waits for its payment, with no code (27c's decision 8), as in the API.
+      // Its first try starts now, and the browser goes to the fake gateway's page. 26c's "confirmed
+      // at once" is gone: an unpaid order is never confirmed. (The mock numbers an order when it
+      // is placed, which the shopper never sees: a dropped order only leaves a gap in a book that
+      // is forgotten at the next restart)
       if (request.paymentMethod === 'online') {
-        const confirmed = confirm(entry);
-        return { ok: true, value: { answer: { next: 'confirmed', ...confirmed }, token } };
+        entry.codeSends = 0;
+        const tranId = newTranId();
+        entry.payments.push({ tranId, status: 'started', amount: order.total });
+        return {
+          ok: true,
+          value: {
+            answer: { next: 'pay', paymentUrl: fakePage(origin, tranId, order.total) },
+            token,
+          },
+        };
       }
       return {
         ok: true,
@@ -298,18 +381,12 @@ export function createOrderBook(
     },
 
     codeWait(token: string): ShopCodeWait | null {
-      const entry = waiting(token);
-      if (!entry) return null;
-      return {
-        next: 'verify',
-        maskedPhone: maskPhone(entry.order.phone),
-        resendInSeconds: secondsUntil(entry.resendAt),
-        listingIds: entry.order.lines.map((line) => line.listingId),
-      };
+      const entry = waitingForCode(token);
+      return entry === null ? null : codeWaitOf(entry);
     },
 
     verify(token: string, code: string): SourceResult<ShopOrderConfirmed> {
-      const entry = waiting(token);
+      const entry = waitingForCode(token);
       if (!entry) return { ok: false, code: 'shop_code_no_order' };
       // Step 27a: a code past its 10 minutes is refused before it is compared, as the API does: it
       // cannot be right any more, so it costs no try
@@ -331,7 +408,7 @@ export function createOrderBook(
     },
 
     resend(token: string): SourceResult<ShopCodeResent> {
-      const entry = waiting(token);
+      const entry = waitingForCode(token);
       if (!entry) return { ok: false, code: 'shop_code_no_order' };
       // Step 27a: the third code was the last, before any wait: waiting would not help
       if (entry.codeSends >= SHOP_CODE_SENDS) return { ok: false, code: 'shop_code_sends_used' };
@@ -348,6 +425,107 @@ export function createOrderBook(
       return { ok: true, value: { resendInSeconds: SHOP_CODE_RESEND_SECONDS } };
     },
 
+    // Step 27d: the gateway came back. The fake gateway's val_id says what happened, so this is
+    // what the API's FakeGateway and settleLocked do together (apps/api/src/storefront/orders/
+    // payment-settle.ts): paid is final, a paid answer for another try or another amount is not
+    // believed, and "no val_id" is "the gateway knows no payment", which changes nothing
+    settle({ tranId, valId }: ShopPaymentSettleRequest): ShopPaymentSettled | null {
+      const found = byTranId(tranId);
+      if (found === null) return null;
+      const { entry, payment } = found;
+      if (payment.status === 'paid') return { status: 'paid' };
+      const answer = valId === null ? null : readFakeValId(valId);
+      // No answer, or one for another try
+      if (answer?.tranId !== tranId) return { status: payment.status };
+      if (answer.outcome !== 'paid') {
+        payment.status = answer.outcome;
+        return { status: payment.status };
+      }
+      if (compareMoney(answer.amount, payment.amount) !== 0) return { status: payment.status };
+      payment.status = 'paid';
+      // Still waiting: this payment confirms it, as an online order, even when the shopper had
+      // switched to Cash on Delivery in the meantime. An order confirmed already keeps its status:
+      // the money is one more payment, which the ERP's order page says to refund
+      if (entry.order.status === 'pending') {
+        entry.order.paymentMethod = 'online';
+        confirm(entry);
+      }
+      return { status: 'paid' };
+    },
+
+    // Step 27d: /checkout/paid. The fake gateway answers at once, so the mock is never "checking"
+    paymentWait(token: string, settings: ShopCheckoutSettings): ShopPaymentWait | null {
+      const entry = byToken.get(token);
+      if (entry === undefined) return null;
+      const { order } = entry;
+      if (order.status !== 'pending') {
+        // Confirmed by a payment: "Order Confirmed". One confirmed by its phone code is the verify
+        // page's
+        if (!entry.payments.some((payment) => payment.status === 'paid')) return null;
+        return {
+          state: 'paid',
+          orderNo: order.orderNo,
+          phone: order.phone,
+          listingIds: order.lines.map((line) => line.listingId),
+        };
+      }
+      // Cash on Delivery now, or past its hour (waiting() drops it then)
+      if (order.paymentMethod !== 'online' || waiting(token) === null) return null;
+      const last = entry.payments.at(-1)?.status ?? 'started';
+      return {
+        state: 'unpaid',
+        // A try that is still started has no answer from the fake gateway: the shopper came back
+        // without pressing a button there
+        problem: last === 'started' || last === 'paid' ? 'not_finished' : last,
+        triesLeft: Math.max(0, SHOP_PAYMENT_TRIES - entry.payments.length),
+        payOnDelivery: settings.paymentMethods.includes('cod'),
+        total: order.total,
+      };
+    },
+
+    // Step 27d: "Try again", with the API's refusals in the API's order
+    retry(
+      token: string,
+      settings: ShopCheckoutSettings,
+      origin: string,
+    ): SourceResult<ShopPaymentRetry, ShopRetryRefusal> {
+      const entry = waiting(token);
+      if (entry === null) return { ok: false, code: 'shop_payment_no_order' };
+      if (entry.order.paymentMethod !== 'online')
+        return { ok: false, code: 'shop_payment_settled' };
+      if (entry.payments.length >= SHOP_PAYMENT_TRIES) {
+        return { ok: false, code: 'shop_payment_tries_used' };
+      }
+      if (!settings.paymentMethods.includes('online')) {
+        return { ok: false, code: 'shop_payment_unavailable' };
+      }
+      const tranId = newTranId();
+      entry.payments.push({ tranId, status: 'started', amount: entry.order.total });
+      return { ok: true, value: { paymentUrl: fakePage(origin, tranId, entry.order.total) } };
+    },
+
+    // Step 27d: "Pay on delivery instead". A second press (a double click, the Back button) gets
+    // the verify page's answer again, with no new code, as in the API
+    payOnDelivery(
+      token: string,
+      settings: ShopCheckoutSettings,
+    ): SourceResult<ShopCodeWait, ShopPayOnDeliveryRefusal> {
+      const entry = waiting(token);
+      if (entry === null) return { ok: false, code: 'shop_payment_no_order' };
+      if (entry.order.paymentMethod === 'cod') return { ok: true, value: codeWaitOf(entry) };
+      if (!settings.paymentMethods.includes('cod')) {
+        return { ok: false, code: 'shop_payment_unavailable' };
+      }
+      // The code is "sent" now: its 45 seconds, its 10 minutes, its five tries start here
+      const at = now().getTime();
+      entry.order.paymentMethod = 'cod';
+      entry.codeSends = 1;
+      entry.wrongCodes = 0;
+      entry.resendAt = at + SHOP_CODE_RESEND_SECONDS * 1000;
+      entry.codeExpiresAt = at + CODE_MS;
+      return { ok: true, value: codeWaitOf(entry) };
+    },
+
     // Decision 5: the number and the token must belong together, and only a confirmed order is
     // shown. An order still waiting for its code is not one yet
     find(orderNo: string, token: string): ShopOrder | null {
```

- **`MockPayment`** keeps only what the mock needs: the transaction id, the status and the amount. The fake
  gateway's `val_id` says what happened, so there is nothing else to keep.
- **`newTranId()`** makes the API's shape (20 upper-case letters and digits) from Web Crypto, which runs wherever the
  shop's server runs. Its small bias (2^32 is not a multiple of 36) does not matter for an id nobody pays with; the
  API's own `randomInt` has none.
- **`fakePage()`** builds a whole address on `origin` (decision 63), with `URLSearchParams`, so the amount's dot and
  the id are written correctly.
- **`waitingForCode()`** is the rule that keeps `123456` from confirming an unpaid online order. `codeWait()`,
  `verify()` and `resend()` use it in place of `waiting()`; the API gets the same rule from its empty code columns.
- **`byTranId()`** does not go through `waiting()`: a payment after the hour still confirms the order (decision 5).
- **`place()`**: an online order starts its first try and answers `next: 'pay'`. `codeSends` is set back to 0, because
  no code was sent. 26c's "confirmed at once" is gone.
- **`settle()`** is what the API's `FakeGateway` and `settleLocked()` do together, in the same order: paid is final,
  no `val_id` or one for another try changes nothing, failed and cancelled are written, and a paid answer must be for
  the try's amount. A pending order is confirmed, and its method set to online (it may have become Cash on Delivery
  in the meantime). A confirmed order stays as it is: the second payment is one more advance in the ERP.
- **`paymentWait()`**: a confirmed order is `paid` only when a try paid it; one confirmed by its phone code is the
  verify page's, so `null`. The mock is never `checking`: its fake gateway answers at once. A try still `started`
  means the shopper came back without pressing anything, `not_finished`.
- **`retry()` and `payOnDelivery()`** check in the API's order, so the mock gives the same refusal the API would.
  A second "Pay on delivery" answers the verify page's wait again, with no new code. The switch starts the code's
  clocks (45 seconds, 10 minutes) and its five tries now.

```diff
@@ -69,9 +69,15 @@ export function createMockSource(
     // The order is priced again here from its own lines, zone and coupon, never from anything the
     // browser says it costs (decision 10). The shopper's address is not used: the mock has no order
     // limits (data/mock/orders.ts)
-    placeOrder: (request) =>
+    placeOrder: (request, _address, origin) =>
       Promise.resolve(
-        orders.place(request, quoteCart(request, context()), mockCheckoutSettings, mockCoupons),
+        orders.place(
+          request,
+          quoteCart(request, context()),
+          mockCheckoutSettings,
+          mockCoupons,
+          origin,
+        ),
       ),
     codeWait: (token) => Promise.resolve(orders.codeWait(token)),
     verifyCode: (token, code) => Promise.resolve(orders.verify(token, code)),
@@ -79,6 +85,14 @@ export function createMockSource(
     order: (orderNo, token) => Promise.resolve(orders.find(orderNo, token)),
     testCode: MOCK_CODE,
 
+    // Step 27d: paying online, against the fake gateway (decision 8). The shop's settings decide
+    // which buttons /checkout/paid offers, as the API's do
+    settlePayment: (request) => Promise.resolve(orders.settle(request)),
+    paymentWait: (token) => Promise.resolve(orders.paymentWait(token, mockCheckoutSettings)),
+    retryPayment: (token, origin) =>
+      Promise.resolve(orders.retry(token, mockCheckoutSettings, origin)),
+    payOnDelivery: (token) => Promise.resolve(orders.payOnDelivery(token, mockCheckoutSettings)),
+
     // Step 26e
     tracking: (token) => Promise.resolve(orders.trackByLink(token)),
     // Step 27a: the limit first, as 26e's form did: once it is reached, nothing is looked up, so a
```

The shop's own settings decide which buttons `/checkout/paid` offers, as the API's do. `_address` keeps its place in
the arrow's parameters: the mock has no order limits, and the underscore tells ESLint it is unused on purpose.

```diff
@@ -131,6 +131,37 @@ export function createApiSource(api: ShopApi): ShopSource {
     // A real shop's code goes only to the phone, by SMS
     testCode: null,
 
+    // Step 27d. not_found: no try of this shop has the transaction id (ShopSource.settlePayment)
+    async settlePayment(request) {
+      return orNull(await api.post(routes.settlePayment, request), 'not_found', 'settle payment');
+    },
+    async paymentWait(token) {
+      return orNull(
+        await api.post(routes.paymentWait, { token }),
+        'shop_payment_no_order',
+        'payment wait',
+      );
+    },
+    async retryPayment(token) {
+      return answerOf(
+        await api.post(routes.retryPayment, { token }),
+        [
+          'shop_payment_no_order',
+          'shop_payment_tries_used',
+          'shop_payment_settled',
+          'shop_payment_unavailable',
+        ],
+        'retry payment',
+      );
+    },
+    async payOnDelivery(token) {
+      return answerOf(
+        await api.post(routes.payOnDelivery, { token }),
+        ['shop_payment_no_order', 'shop_payment_settled', 'shop_payment_unavailable'],
+        'pay on delivery',
+      );
+    },
+
     async tracking(token) {
       return orNull(await api.post(routes.tracking, { token }), 'not_found', 'tracking');
     },
```

Each route lists the refusals the page knows. Any other refusal throws, and the route answers `internal_error`: a
refusal the page has no words for is a mistake on one side, not something to show a shopper. `origin` is not sent:
the API builds its addresses itself.

### The routes

```diff
@@ -19,7 +19,7 @@ import { problemResponse, readBody, sourceFailed, type ProblemStatus } from './p
 // - 409: the cart changed under the shopper; asking again with a new quote can work
 // - 422: the request is well formed but breaks a rule (no such zone, under the minimum, wrong code)
 // - 429: asked for a new code too soon, or (step 27a) too many orders; Retry-After says when
-// - 404: no order waits for a code in this browser
+// - 404: no order waits for a code (step 27d: or for its payment) in this browser
 // Step 27a: the API answers the same statuses (shop-orders.service.ts), so a shopper's browser
 // gets the same answer from either source
 const REFUSALS = {
@@ -35,9 +35,14 @@ const REFUSALS = {
   shop_code_expired: [422, 'The code has expired. Ask for a new one.'],
   shop_code_sends_used: [422, 'This order has had all its codes.'],
   shop_coupon_used_by_phone: [422, 'This mobile number has an order with this coupon already.'],
+  // Step 27d: the API's statuses for the two buttons on /checkout/paid (shop-payments.service.ts)
+  shop_payment_no_order: [404, 'No online order waits for its payment in this browser.'],
+  shop_payment_tries_used: [422, 'This order has used all its tries.'],
+  shop_payment_settled: [409, 'The order is paid, or it is cash on delivery now.'],
 } as const satisfies Record<ShopRefusalCode, readonly [ProblemStatus, string]>;
 
-function refused(
+// Step 27d: exported for the payment routes (server/payments.ts), which answer the same way
+export function refused(
   result: Extract<SourceResult<unknown>, { ok: false }>,
   headers: Headers = new Headers(),
 ): Response {
@@ -63,11 +68,12 @@ function noOrder(options: CookieOptions): Response {
 }
 
 // Confirm Order. Step 27a: `address` is the shopper's (Astro's clientAddress), which the API
-// counts orders under
+// counts orders under. Step 27d: `origin` is the shop's own (ShopSource.placeOrder)
 export async function answerPlaceOrder(
   request: Request,
   source: ShopSource,
   address: string,
+  origin: string,
   options: CookieOptions,
 ): Promise<Response> {
   const body = await readBody(request, shopOrderRequestSchema);
@@ -75,7 +81,7 @@ export async function answerPlaceOrder(
 
   let result;
   try {
-    result = await source.placeOrder(body.data, address);
+    result = await source.placeOrder(body.data, address, origin);
   } catch (error) {
     return sourceFailed('place order', error);
   }
@@ -83,11 +89,16 @@ export async function answerPlaceOrder(
 
   const { answer, token } = result.value;
   const headers = new Headers({ 'Cache-Control': 'no-store' });
-  if (answer.next === 'verify') {
-    // The order waits for its code; /checkout/verify finds it by this cookie
+  if (answer.next === 'verify' || answer.next === 'pay') {
+    // The order waits for its code, or (step 27d) for its payment. /checkout/verify and
+    // /checkout/paid find it by this cookie. The gateway's own post back to the shop does not
+    // bring it (it comes from another site, and the cookie is SameSite=Lax): the return path
+    // settles by the transaction id and sends the browser on to /checkout/paid, whose plain GET
+    // does bring it (server/payments.ts)
     headers.append('Set-Cookie', checkoutCookie(token, options));
   } else {
-    // Confirmed at once (Mobile Banking in the mock): this browser may now open /order/<no>.
+    // Confirmed at once (the API never answers this since step 27d; the type keeps it, see
+    // shopOrderPlacedSchema): this browser may now open /order/<no>.
     // An older order that was still waiting for its code is forgotten: the shopper chose to start
     // again, and the verify page must not offer the old one. Step 27a: the number comes from the
     // answer, the only place a confirmed order's number is
```

`pay` takes the same cookie as `verify`: `/checkout/paid` finds the order by it. `refused` is exported for the
payment routes, so both files answer a refusal the same way (status, `Retry-After`, problem JSON).

```ts
import { SHOP_PAYMENT_RETURN_PATH, shopGatewayPostSchema } from '@omnivo/contracts';

import type { ShopSource } from '../data/types';
import { checkoutToken } from './cookies';
import { refused } from './orders';
import { problemResponse, sourceFailed } from './problem';

// Step 27d: the shop's payment routes, without Astro around them, like orders.ts. Two kinds:
// - the gateway's two paths (SHOP_PAYMENT_RETURN_PATH and SHOP_PAYMENT_NOTICE_PATH). SSLCommerz
//   posts a form to them from its own site, so they read no cookie and trust nothing in the post
//   but the two ids, which the source checks with the gateway itself. The middleware lets only
//   these two take a post from another site (server/origin-check.ts)
// - "Try again" and "Pay on delivery" on /checkout/paid, which the shop's own page posts as JSON,
//   for the order in this browser's checkout cookie, like "Resend code"

// Where the browser goes after the gateway: the page that reads the cookie and draws the answer
export const PAYMENT_PAGE = '/checkout/paid';

// The two ids from the gateway's form post, or null when the post has none we can use. A post
// that is not a form, is cut, or names a transaction id of the wrong shape is never passed on:
// the API would refuse it with 400 anyway
export async function gatewayIds(
  request: Request,
): Promise<{ tranId: string; valId: string | null } | null> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^(application\/x-www-form-urlencoded|multipart\/form-data)\b/i.test(type)) return null;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return null;
  }
  // FormData.get is a string, a File (a multipart field with a file name) or null. Only text is
  // an id; a missing val_id is undefined, which the schema makes null like an empty one
  const text = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const parsed = shopGatewayPostSchema.safeParse({
    tran_id: text('tran_id'),
    val_id: text('val_id'),
  });
  return parsed.success ? { tranId: parsed.data.tran_id, valId: parsed.data.val_id } : null;
}

// The shopper's browser, back from the gateway's page (paid, failed or cancelled, all to one
// path). Whatever happens here, the browser goes on to /checkout/paid with 303, which turns the
// POST into a GET: a reload there asks again and never posts the form twice. Settling first means
// the page usually has the answer at once; when it could not (the API was down, or the post was
// not one we can read), the page asks the API itself, and the IPN brings the answer too
export async function answerGatewayReturn(request: Request, source: ShopSource): Promise<Response> {
  const ids = await gatewayIds(request);
  if (ids !== null) {
    try {
      await source.settlePayment(ids);
    } catch (error) {
      console.error(`settle payment ${ids.tranId} on ${SHOP_PAYMENT_RETURN_PATH} failed`, error);
    }
  }
  return new Response(null, {
    status: 303,
    headers: { Location: PAYMENT_PAGE, 'Cache-Control': 'no-store' },
  });
}

// The gateway's own server (SSLCommerz's IPN). Its answer is for the gateway only: 200 once the
// try is settled, a 4xx for a post that can never settle (the gateway may stop trying then), and
// 500 when the API was down, so the gateway sends it again later
export async function answerGatewayNotice(request: Request, source: ShopSource): Promise<Response> {
  const ids = await gatewayIds(request);
  if (ids === null) {
    return problemResponse(400, 'invalid_input', 'The post has no transaction id.');
  }
  let settled;
  try {
    settled = await source.settlePayment(ids);
  } catch (error) {
    return sourceFailed('settle payment notice', error);
  }
  if (settled === null) return problemResponse(404, 'not_found', 'No payment has this id.');
  return Response.json(settled, { headers: { 'Cache-Control': 'no-store' } });
}

// "Try again". No body: the cookie says which order. The cookie is never cleared here: an order
// that is not waiting for a payment any more may be waiting for its phone code ("Pay on delivery"
// in another tab), and /checkout/verify needs the same cookie
export async function answerRetryPayment(
  request: Request,
  source: ShopSource,
  origin: string,
): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return refused({ ok: false, code: 'shop_payment_no_order' });
  let result;
  try {
    result = await source.retryPayment(token, origin);
  } catch (error) {
    return sourceFailed('retry payment', error);
  }
  if (!result.ok) return refused(result);
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}

// "Pay on delivery instead". The same cookie: the order is the same, it only waits for a code now
export async function answerPayOnDelivery(request: Request, source: ShopSource): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return refused({ ok: false, code: 'shop_payment_no_order' });
  let result;
  try {
    result = await source.payOnDelivery(token);
  } catch (error) {
    return sourceFailed('pay on delivery', error);
  }
  if (!result.ok) return refused(result);
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}
```

- **`gatewayIds()`** reads the two ids and nothing else. Everything else in SSLCommerz's post (status, amount,
  card_type) is what the browser or a stranger sent; the API asks the gateway itself. `form.get()` can be a `File`
  in a multipart post, so only a string counts. A post whose `tran_id` has the wrong shape is never passed on: the
  API would refuse it with 400 anyway.
- **`answerGatewayReturn()`** logs a failed settle and goes on (decision 58). The shopper must never see an error
  page between SSLCommerz and the shop: the next page asks again.
- **`answerGatewayNotice()`** is decision 59.
- **`answerRetryPayment()` and `answerPayOnDelivery()`** are decision 60. A missing cookie is
  `shop_payment_no_order` (404), the same answer as an order that is gone.

```ts
import type { APIRoute } from 'astro';

import { answerGatewayReturn, PAYMENT_PAGE } from '../../../server/payments';

// Step 27d: SHOP_PAYMENT_RETURN_PATH. SSLCommerz posts the shopper's browser here after its page:
// paid, failed and cancelled all come to this one path (27d.1). The middleware lets this path take
// a post from another site (server/origin-check.ts)
export const POST: APIRoute = ({ request, locals }) => answerGatewayReturn(request, locals.source);

// A GET here is a reload of the address bar, or a gateway that sends the browser back without a
// form: nothing to settle, so the page that reads the cookie answers
export const GET: APIRoute = () =>
  new Response(null, { status: 303, headers: { Location: PAYMENT_PAGE } });
```

The GET answers a reload of the address bar, or a gateway that sends the browser back without a form. There is
nothing to settle, so it sends the browser to the page that reads the cookie.

```ts
import type { APIRoute } from 'astro';

import { answerGatewayNotice } from '../../../server/payments';

// Step 27d: SHOP_PAYMENT_NOTICE_PATH, SSLCommerz's IPN: its server posts the outcome here too, so
// a payment is recorded even when the shopper closes the tab before coming back
export const POST: APIRoute = ({ request, locals }) => answerGatewayNotice(request, locals.source);
```

```ts
import type { APIRoute } from 'astro';

import { answerRetryPayment } from '../../../server/payments';

// Step 27d: "Try again" on /checkout/paid. POST, not GET: it opens a payment page at the gateway
// and uses up one of the order's three tries
export const POST: APIRoute = ({ request, locals, url }) =>
  answerRetryPayment(request, locals.source, url.origin);
```

```ts
import type { APIRoute } from 'astro';

import { answerPayOnDelivery } from '../../../server/payments';

// Step 27d: "Pay on delivery instead" on /checkout/paid. POST: it changes the order and sends an SMS
export const POST: APIRoute = ({ request, locals }) => answerPayOnDelivery(request, locals.source);
```

Both buttons are POST: one opens a payment page and uses a try, the other changes the order and sends an SMS. A GET
could be fired by a link preview or a prefetch.

```diff
@@ -5,6 +5,10 @@ import { answerPlaceOrder } from '../../../server/orders';
 // Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
 // plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
 // exception for localhost, Safari does not). Step 27a: clientAddress is the shopper's address (the
-// proxy's X-Forwarded-For, astro.config.ts → security), for the API's orders-per-connection limit
-export const POST: APIRoute = ({ request, locals, clientAddress }) =>
-  answerPlaceOrder(request, locals.source, clientAddress, { secure: import.meta.env.PROD });
+// proxy's X-Forwarded-For, astro.config.ts → security), for the API's orders-per-connection limit.
+// Step 27d: url.origin is the shop's address as the browser sees it (the proxy's X-Forwarded-Host
+// and -Proto, the same setting), for the mock's fake gateway page
+export const POST: APIRoute = ({ request, locals, clientAddress, url }) =>
+  answerPlaceOrder(request, locals.source, clientAddress, url.origin, {
+    secure: import.meta.env.PROD,
+  });
```

`url.origin` is the shop's address as the browser sees it. Behind the proxy that is the shopper's host, because
`security.allowedDomains` trusts the proxy's `X-Forwarded-Host` and `-Proto` (26e).

### `/checkout/paid`

```ts
// Step 27d: what the /checkout/paid page's script reads from the shop's own two routes. Hand-written
// guards, not Zod, like lib/verify.ts: the page has no other use for Zod in the browser.

// Where "Try again" sends the browser, from the route's answer:
// - a string: the new payment page
// - null: the gateway did not open one (the page then shows "The payment page did not open")
// - undefined: not an answer of the route (a proxy's page), so the press failed
// Only an http(s) address is believed. The address goes into location.assign(), where a
// `javascript:` one would run on the shop's page; the API checks it already (shopPaymentUrlSchema),
// and this keeps the browser safe whatever reached it
export function paymentUrlOf(body: unknown): string | null | undefined {
  if (typeof body !== 'object' || body === null || !('paymentUrl' in body)) return undefined;
  const { paymentUrl } = body;
  if (paymentUrl === null) return null;
  if (typeof paymentUrl !== 'string') return undefined;
  try {
    const url = new URL(paymentUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// "Pay on delivery" answered the verify page's wait: the browser goes there
export function isCodeWait(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'next' in body && body.next === 'verify';
}
```

`paymentUrlOf()` believes only an `http` or `https` address. The address goes into `location.assign()`, where a
`javascript:` address would run on the shop's page. The API checks it already; this keeps the browser safe whatever
reached it. A path is refused too: `new URL()` without a base throws on it, and decision 63 makes every answer a
whole address.

```
---
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { numberLocale } from '@omnivo/i18n';

import OrderConfirmedDialog from '../../components/OrderConfirmedDialog.astro';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';
import { spacedPhone } from '../../lib/phone';
import { checkoutToken, clearCheckoutCookie, ordersCookie } from '../../server/cookies';

// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
const { source } = Astro.locals;

// Step 27d: where an online order's payment is, for this browser's checkout cookie, like the
// verify page. The shopper lands here from the gateway (the return path's 303), from "Try again"
// when no page opened, and from a reload. The cookie came with this GET even after SSLCommerz's
// cross-site post: a SameSite=Lax cookie is sent on a top-level GET from another site, only not on
// its POST (decision 2)
const options = { secure: import.meta.env.PROD };
const token = checkoutToken(Astro.request);
// No checkout cookie: nothing was placed in this browser, or the order is done (a reload after
// the dialog, whose answer cleared it below)
if (token === null) return Astro.redirect('/checkout');
const wait = await source.paymentWait(token);
// No online order waits. The usual reason is "Pay on delivery" (in this tab or another): the same
// cookie now names an order that waits for its phone code, and the verify page finds it. The verify
// page sends the browser on to /checkout when nothing waits there either
if (wait === null) return Astro.redirect('/checkout/verify');

// Step 26d.4: the categories for the header's drawer
const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
const locale = await shopLocale(shop.language);
const { t, money } = locale;
const numbers = new Intl.NumberFormat(numberLocale(locale.language));

if (wait.state === 'paid') {
  // The order is confirmed: it moves from "waiting" to this browser's orders, as a right phone
  // code moves it (server/orders.ts → answerVerifyCode), so "View Order Details" opens it. The
  // checkout cookie goes, so a reload of this page goes to /checkout and the dialog does not open
  // twice. Two Set-Cookie lines: Headers.append keeps both
  Astro.response.headers.append(
    'Set-Cookie',
    ordersCookie(Astro.request, wait.orderNo, token, options),
  );
  Astro.response.headers.append('Set-Cookie', clearCheckoutCookie(options));
}
// The page is this shopper's own (their cookie), so no cache may keep it
Astro.response.headers.set('Cache-Control', 'no-store');

const title =
  wait.state === 'paid'
    ? t('shop.confirmed.title')
    : wait.state === 'checking'
      ? t('shop.paid.checkingTitle')
      : t(`shop.paid.titles.${wait.problem}`);

// The words of the two buttons while they wait, and the line for a press that failed. Only what
// the script writes; the rest is drawn here
const words = {
  tryAgain: t('shop.paid.tryAgain'),
  opening: t('shop.paid.opening'),
  payOnDelivery: t('shop.paid.payOnDelivery'),
  sendingCode: t('shop.paid.sendingCode'),
  failed: t('shop.paid.failed'),
};

const button =
  'flex items-center justify-center rounded-sm font-semibold transition-colors duration-150';
const primary = `${button} h-16 w-full bg-accent text-[18px] not-aria-disabled:hover:bg-brand not-aria-disabled:hover:text-accent aria-disabled:bg-canvas aria-disabled:text-muted`;
const secondary = `${button} h-11 w-full bg-cream not-aria-disabled:hover:bg-accent aria-disabled:text-muted`;
---
```

- **No cookie → `/checkout`**, and **no online order → `/checkout/verify`**. The usual reason for the second is
  "Pay on delivery": the same cookie now names an order that waits for its code. The verify page sends the browser on
  to `/checkout` when nothing waits there either, so the page needs no second question to the API.
- **The cookies of a paid order** are decision 61. `Headers.append` keeps both `Set-Cookie` lines; `set` would keep
  only the last one.
- **`numbers`** writes the tries in the shop's digits ("১ বার" in Bangla). `replace` puts the formatted number where
  `{{count}}` goes, and `count` still picks the `_one` or `_other` word.
- **`words`** are only what the script writes: the two buttons' busy words and the failure line. Everything else is
  drawn on the server.

```
<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.paid.pageTitle', { shop: shop.name })}
  categories={categories}
>
  <payment-wait
    data-state={wait.state}
    data-words={JSON.stringify(words)}
    data-listing-ids={wait.state === 'paid' ? JSON.stringify(wait.listingIds) : undefined}
    data-order-no={wait.state === 'paid' ? wait.orderNo : undefined}
    data-phone={wait.state === 'paid' ? wait.phone : undefined}
  >
    {/* The verify page's card: 560px, the checkout's 4px glass frame and its 160px to the footer */}
    <div class="mx-auto mt-4 max-w-[560px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
      <div class="rounded-t-xl bg-cream p-6 text-center">
        <h1 class="trim-text text-sf-title font-semibold">{title}</h1>
      </div>
      <div class="flex flex-col gap-8 p-5 md:p-9">
        {wait.state === 'paid' && (
          // What the dialog says, for a page without its script and for after the dialog is
          // closed by "View Order Details" in another tab. The dialog opens over it
          <>
            <p class="text-body">
              {t('shop.confirmed.textBefore')}
              <span class="font-medium whitespace-nowrap tabular-nums">
                {spacedPhone(wait.phone)}
              </span>
              {t('shop.confirmed.textAfter')}
            </p>
            <a href={`/order/${encodeURIComponent(wait.orderNo)}`} class={secondary}>
              {t('shop.confirmed.details')}
            </a>
          </>
        )}

        {wait.state === 'checking' && (
          <>
            {/* role="status": the script reloads the page by itself; this says why it waits */}
            <p role="status" class="text-body">
              {t('shop.paid.checkingText')}
            </p>
            {/* A link to this page: it works without the script too */}
            <a href="/checkout/paid" class={secondary}>
              {t('shop.paid.checkAgain')}
            </a>
          </>
        )}

        {wait.state === 'unpaid' && (
          <>
            <div class="flex flex-col gap-3">
              <p class="text-body">{t(`shop.paid.texts.${wait.problem}`)}</p>
              <p class="text-body">{t('shop.paid.kept', { total: money(wait.total) })}</p>
              {/* The count in the shop's digits ("১ বার" in Bangla): `replace` writes the
                    formatted number where {{count}} goes, `count` still picks _one or _other */}
              <p class="font-semibold">
                {wait.triesLeft > 0
                  ? t('shop.paid.triesLeft', {
                      count: wait.triesLeft,
                      replace: { count: numbers.format(wait.triesLeft) },
                    })
                  : t('shop.paid.noTriesLeft')}
              </p>
            </div>

            <div class="flex flex-col">
              {/* role="alert": the shopper pressed a button and waits. In the page from the
                    start, so a screen reader hears the line when it shows; 24px above the buttons
                    only then, like the verify page's error line */}
              <div role="alert" class="has-[>p:not([hidden])]:pb-6">
                <p
                  data-error
                  hidden
                  class="flex items-start gap-1.5 text-sf-small font-medium text-promo"
                >
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    size={16}
                    strokeWidth={1.5}
                    className="mt-1 shrink-0"
                    aria-hidden="true"
                  />
                  <span data-error-text />
                </p>
              </div>
              <div class="flex flex-col gap-6">
                {/* aria-disabled while a press waits, not disabled: a disabled button loses the
                    focus. The first button the shopper can press is the one to press: a new try */}
                {wait.triesLeft > 0 && (
                  <button type="button" data-retry class={primary}>
                    {words.tryAgain}
                  </button>
                )}
                {wait.payOnDelivery && (
                  <div class="flex flex-col gap-3">
                    <button
                      type="button"
                      data-cod
                      aria-describedby="paid-cod-hint"
                      class={wait.triesLeft > 0 ? secondary : primary}
                    >
                      {words.payOnDelivery}
                    </button>
                    <p id="paid-cod-hint" class="text-center text-sf-small text-muted">
                      {t('shop.paid.payOnDeliveryHint')}
                    </p>
                  </div>
                )}
                {/* Nothing left to press: the cart is still in this browser, so a new order is a
                    tap away. The order here is dropped after its hour, with its stock */}
                {wait.triesLeft === 0 && !wait.payOnDelivery && (
                  <a href="/checkout" class={secondary}>
                    {t('shop.paid.startAgain')}
                  </a>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  </payment-wait>

  {wait.state === 'paid' && <OrderConfirmedDialog locale={locale} />}
</ShopLayout>
```

- **The paid card** repeats what the dialog says, with "View Order Details". The dialog opens over it; without the
  script, the card is the answer.
- **"Check again"** is a link to the page itself, so it works without the script.
- **The error line** sits in a block of its own above the buttons, in the page from the start, so a screen reader
  hears it when it shows (`role="alert"`), and it takes its 24px only when it says something, like the verify page's.
- **The buttons**: "Try again" is the primary button while tries are left; with none left, "Pay on delivery" becomes
  the primary one. "Back to checkout" shows only when neither button is there.

```
<script>
  import { removeFromCart } from '../../lib/cart';
  import { announceOrderConfirmed } from '../../lib/order-events';
  import { isCodeWait, paymentUrlOf } from '../../lib/payment';

  const WORD_KEYS = ['tryAgain', 'opening', 'payOnDelivery', 'sendingCode', 'failed'] as const;
  type WordKey = (typeof WORD_KEYS)[number];

  // How long "checking" waits before it asks again. Long enough not to ask the gateway in a loop,
  // short enough that a shopper who just paid is not left looking at it
  const CHECK_AGAIN_MS = 4000;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  async function bodyOf(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  class PaymentWait extends HTMLElement {
    private words: Record<string, unknown> = {};
    private busy = false;
    private timer: number | undefined;

    connectedCallback(): void {
      const words: unknown = JSON.parse(this.dataset.words ?? '{}');
      this.words = isRecord(words) ? words : {};
      // Every word is read once now, so a missing one fails when the page opens
      for (const key of WORD_KEYS) this.word(key);

      const state = this.dataset.state;
      if (state === 'paid') this.paid();
      if (state === 'checking') {
        // replace(), not reload(): the address stays /checkout/paid, and the Back button does not
        // walk through every look
        this.timer = window.setTimeout(() => {
          window.location.replace('/checkout/paid');
        }, CHECK_AGAIN_MS);
      }
      this.querySelector('[data-retry]')?.addEventListener('click', () => {
        void this.retry();
      });
      this.querySelector('[data-cod]')?.addEventListener('click', () => {
        void this.payOnDelivery();
      });
    }

    disconnectedCallback(): void {
      window.clearTimeout(this.timer);
    }

    private word(key: WordKey): string {
      const word = this.words[key];
      if (typeof word !== 'string') throw new Error(`payment wait: word ${key} is missing`);
      return word;
    }

    // The order is real now: its lines leave this browser's cart (as after a right phone code),
    // and the dialog opens over the page
    private paid(): void {
      const ids: unknown = JSON.parse(this.dataset.listingIds ?? '[]');
      removeFromCart(
        new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []),
      );
      const { orderNo, phone } = this.dataset;
      if (orderNo !== undefined && phone !== undefined) announceOrderConfirmed({ orderNo, phone });
    }

    private buttons(): HTMLButtonElement[] {
      return [...this.querySelectorAll<HTMLButtonElement>('[data-retry], [data-cod]')];
    }

    // One press at a time: both buttons wait, and the one pressed says what it does
    private setBusy(pressed: HTMLButtonElement | null, text: string | null): void {
      this.busy = pressed !== null;
      for (const button of this.buttons()) {
        button.setAttribute('aria-disabled', String(this.busy));
      }
      if (pressed !== null && text !== null) pressed.textContent = text;
    }

    private showError(): void {
      const line = this.querySelector<HTMLElement>('[data-error]');
      const text = this.querySelector('[data-error-text]');
      if (line === null || text === null) return;
      text.textContent = this.word('failed');
      line.hidden = false;
    }

    // The press reached the server and was refused, or answered something unexpected: the page is
    // drawn again from the server's own state (paid meanwhile, Cash on Delivery in another tab, no
    // tries left), which says more than any message here could
    private redraw(): void {
      window.location.replace('/checkout/paid');
    }

    private async post(url: string): Promise<{ response: Response; body: unknown } | null> {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        });
        return { response, body: await bodyOf(response) };
      } catch (error) {
        console.error(error);
        return null;
      }
    }

    private async retry(): Promise<void> {
      const button = this.querySelector<HTMLButtonElement>('[data-retry]');
      if (this.busy || button === null) return;
      this.setBusy(button, this.word('opening'));
      const answer = await this.post('/api/payments/retry');
      if (answer === null) {
        // No answer: the press may not have reached the shop. The buttons work again
        this.setBusy(null, null);
        button.textContent = this.word('tryAgain');
        this.showError();
        return;
      }
      const url = answer.response.ok ? paymentUrlOf(answer.body) : undefined;
      // The gateway's page. The button keeps "Opening the payment page…" until it opens
      if (typeof url === 'string') window.location.assign(url);
      // null: no page opened (the try counts); anything else: see redraw()
      else this.redraw();
    }

    private async payOnDelivery(): Promise<void> {
      const button = this.querySelector<HTMLButtonElement>('[data-cod]');
      if (this.busy || button === null) return;
      this.setBusy(button, this.word('sendingCode'));
      const answer = await this.post('/api/payments/cod');
      if (answer === null) {
        this.setBusy(null, null);
        button.textContent = this.word('payOnDelivery');
        this.showError();
        return;
      }
      // The order waits for its code now, with the same cookie
      if (answer.response.ok && isCodeWait(answer.body)) window.location.assign('/checkout/verify');
      else this.redraw();
    }
  }

  customElements.define('payment-wait', PaymentWait);
</script>
```

- **`paid()`** takes the order's listings out of this browser's cart and announces the order, which opens the
  dialog, as a right phone code does.
- **`setBusy()`** disables both buttons with `aria-disabled` (a disabled button loses the focus), so a second press
  cannot open a second try or switch the order while the first press waits.
- **No answer at all** (the network): the buttons work again and the line says to check the connection. The press
  may not have reached the shop, so the page does not guess.
- **`paymentUrlOf()` answered a string**: the browser goes to the payment page, and the button keeps "Opening the
  payment page…" until it does. Anything else is `redraw()`, decision 61.

### The fake gateway's page

```
---
import { InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { fakeGatewayParamsSchema, fakeValId, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';

import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';

// Step 26f.5: the data source for the shop this request's host names (src/middleware.ts)
const { source } = Astro.locals;

// Step 27d (decision 8): the fake gateway's page, where SSLCommerz's page would be. The mock
// source and the API's FakeGateway (PAYMENT_GATEWAY=fake: development, CI, the demo shop) send the
// browser here. It posts what SSLCommerz posts to the return path, with a val_id that says what
// happened (fakeValId). On a shop whose API asks the real SSLCommerz, such a val_id pays nothing
// (the gateway knows no payment by it), so the page is harmless there, and it says plainly what
// it is. Nothing here is checked against an order: the API checks the post, as it does SSLCommerz's.
const params = fakeGatewayParamsSchema.safeParse({
  tranId: Astro.url.searchParams.get('tranId'),
  amount: Astro.url.searchParams.get('amount'),
});
// Not a page a try opened: the shop's own 404
if (!params.success) return Astro.rewrite('/404');
const { tranId, amount } = params.data;

const [shop, categories] = await Promise.all([source.shop(), source.categories()]);
const locale = await shopLocale(shop.language);
const { t, money } = locale;

// A test page is never one for a search engine, and it names a try: no cache keeps it
Astro.response.headers.set('Cache-Control', 'no-store');
Astro.response.headers.set('X-Robots-Tag', 'noindex');

const button =
  'flex items-center justify-center rounded-sm font-semibold transition-colors duration-150';
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.fakeGateway.pageTitle', { shop: shop.name })}
  categories={categories}
>
  <div class="mx-auto mt-4 max-w-[560px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
    <div class="rounded-t-xl bg-cream p-6 text-center">
      <h1 class="trim-text text-sf-title font-semibold">{t('shop.fakeGateway.title')}</h1>
    </div>
    {/* One form, three submit buttons: the pressed button's name and value go with the post, so
        each says its own val_id and the page needs no script */}
    <form method="post" action={SHOP_PAYMENT_RETURN_PATH} class="flex flex-col gap-8 p-5 md:p-9">
      <input type="hidden" name="tran_id" value={tranId} />
      <p class="flex items-start gap-2 rounded-lg bg-canvas px-4 py-3 text-sf-small text-body">
        <HugeiconsIcon
          icon={InformationCircleIcon}
          size={20}
          strokeWidth={1.5}
          className="mt-0.5 shrink-0 text-brand"
          aria-hidden="true"
        />
        {t('shop.fakeGateway.notice')}
      </p>
      <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
        <dt class="font-semibold">{t('shop.fakeGateway.amount')}</dt>
        <dd class="text-right font-semibold text-price tabular-nums">{money(amount)}</dd>
        <dt class="font-semibold">{t('shop.fakeGateway.tranId')}</dt>
        {/* break-all: 20 letters with no space would push the card wider than a phone */}
        <dd class="text-right font-mono break-all text-body">{tranId}</dd>
      </dl>
      <div class="flex flex-col gap-3">
        <button
          type="submit"
          name="val_id"
          value={fakeValId(tranId, { outcome: 'paid', amount })}
          class={`${button} h-16 bg-accent text-[18px] hover:bg-brand hover:text-accent`}
        >
          {t('shop.fakeGateway.pay', { amount: money(amount) })}
        </button>
        <button
          type="submit"
          name="val_id"
          value={fakeValId(tranId, { outcome: 'failed' })}
          class={`${button} h-11 bg-cream hover:bg-accent`}
        >
          {t('shop.fakeGateway.fail')}
        </button>
        <button
          type="submit"
          name="val_id"
          value={fakeValId(tranId, { outcome: 'cancelled' })}
          class={`${button} h-11 bg-cream hover:bg-accent`}
        >
          {t('shop.fakeGateway.cancel')}
        </button>
      </div>
    </form>
  </div>
</ShopLayout>
```

Decision 62. `fakeGatewayParamsSchema` checks the address the same way the API made it, so a hand-typed address that
is not a try's shape is a 404, not a page with a broken amount. `break-all` on the transaction id: 20 letters with
no space would push the card wider than a phone's screen.

### The checkout

```diff
@@ -50,6 +50,9 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
       upTo: '{{upTo}}',
     }),
     payment: t('shop.checkout.payment'),
+    // Step 27d: Pay online's hint under the cards, and the button on the way to the gateway
+    onlineHint: t('shop.checkout.onlineHint'),
+    openingPayment: t('shop.checkout.openingPayment'),
     termsBefore: t('shop.checkout.termsBefore'),
     termsLink: t('shop.checkout.termsLink'),
     termsAfter: t('shop.checkout.termsAfter'),
```

```diff
@@ -95,6 +95,8 @@ export default function CheckoutForm({
   });
   const zoneId = useWatch({ control, name: 'zoneId' });
   const termsAccepted = useWatch({ control, name: 'termsAccepted' });
+  // Step 27d: the hint under the payment cards, and the button's words on the way to the gateway
+  const paymentMethod = useWatch({ control, name: 'paymentMethod' });
 
   const cart = useCart();
   // The promo box's text, and the code sent with every quote since Apply (decision 2)
@@ -105,8 +107,9 @@ export default function CheckoutForm({
   // The quote the shopper saw when Confirm Order was refused with shop_order_changed
   const [refusedQuote, setRefusedQuote] = useState<ShopCartQuote | null>(null);
   const [submitError, setSubmitError] = useState<string | null>(null);
-  // Going to /checkout/verify: the button keeps saying "Placing the order…" until the page goes
-  const [leaving, setLeaving] = useState(false);
+  // Going to /checkout/verify (step 27d: or to the payment page): the button keeps saying what is
+  // happening until the page goes, so a second press cannot place a second order
+  const [leaving, setLeaving] = useState<'verify' | 'pay' | null>(null);
 
   // No more quotes once the order is placed: the cart is empty then, and the screen stays as it was
   const { state, pricing, retry, refresh } = useCheckoutQuote(
@@ -142,7 +145,7 @@ export default function CheckoutForm({
       ? quote.coupon
       : null;
   const applying = couponCode !== undefined && couponResult === null && state.status !== 'failed';
-  const busy = isSubmitting || leaving;
+  const busy = isSubmitting || leaving !== null;
   // Confirm Order waits for an answer for this exact cart, zone and code. Every reason it is
   // disabled is on screen: the terms box, the grey amounts, the out-of-stock line, the minimum
   const canOrder =
@@ -217,12 +220,21 @@ export default function CheckoutForm({
     if (answer.next === 'verify') {
       // Cash on Delivery: the order waits for its code. The cart stays until the code is right,
       // so a shopper who gives up on the code still has it
-      setLeaving(true);
+      setLeaving('verify');
       window.location.assign('/checkout/verify');
       return;
     }
-    // Confirmed at once (Mobile Banking in the mock): the screen stays as it is, the ordered
-    // lines leave the cart, and the "Order Confirmed" dialog (26c.5) hears the event
+    if (answer.next === 'pay') {
+      // Step 27d: Pay online. The browser goes to the gateway's page, or, when none opened, to
+      // /checkout/paid, which says so and offers "Try again". The cart stays until the payment
+      // arrives, for the same reason as above. The address came from the API through the shop's
+      // own route and was checked there (shopPaymentUrlSchema: http or https only)
+      setLeaving('pay');
+      window.location.assign(answer.paymentUrl ?? '/checkout/paid');
+      return;
+    }
+    // Confirmed at once (only the mock did this, before step 27d): the screen stays as it is, the
+    // ordered lines leave the cart, and the "Order Confirmed" dialog (26c.5) hears the event
     setPlaced({ quote, lines });
     removeFromCart(new Set(lines.map((line) => line.listingId)));
     announceOrderConfirmed({ orderNo: answer.orderNo, phone: answer.phone });
@@ -357,6 +369,12 @@ export default function CheckoutForm({
             choices={payments}
             field={register('paymentMethod')}
             error={errorOf(errors.paymentMethod?.message)}
+            // Step 27d: where the shopper pays, before they press the button that takes them there
+            hint={
+              paymentMethod === 'online' && (
+                <p className="trim-text mt-3 text-sf-small text-muted">{words.onlineHint}</p>
+              )
+            }
           />
         </div>
 
@@ -401,7 +419,7 @@ export default function CheckoutForm({
               disabled={!canOrder}
               className="h-16 w-full rounded-sm bg-accent text-[18px] font-semibold transition-colors duration-150 not-disabled:hover:bg-brand not-disabled:hover:text-accent disabled:bg-canvas disabled:text-muted"
             >
-              {busy ? words.placing : words.confirm}
+              {leaving === 'pay' ? words.openingPayment : busy ? words.placing : words.confirm}
             </button>
           </div>
         </div>
```

- **`leaving`** says where the browser is going, not only that it is going, so the button says "Opening the payment
  page…" for Pay online and "Placing the order…" for the code. It also keeps the button disabled until the page goes,
  so a second press cannot place a second order.
- **`answer.paymentUrl ?? '/checkout/paid'`**: no page opened, but the order exists and holds its stock, so the
  shopper goes to the page that says so and offers "Try again".
- **The hint** under the payment cards says where the money is taken, before the button takes the shopper there.

```diff
@@ -45,6 +45,8 @@ Astro.response.headers.set('Cache-Control', 'no-store');
     language={locale.language}
     numberLocale={numberLocale(locale.language)}
   />
-  {/* Step 26c.5: opens when the island announces a confirmed order (Mobile Banking) */}
+  {/* Step 26c.5: opens when the island announces a confirmed order. Step 27d: no order is
+      confirmed here any more (Pay online confirms on /checkout/paid); the island keeps the event
+      for the contract's `confirmed` answer */}
   <OrderConfirmedDialog locale={locale} />
 </ShopLayout>
```

```diff
@@ -5,8 +5,8 @@ import { HugeiconsIcon } from '@hugeicons/react';
 import type { ShopLocale } from '../lib/locale';
 
 // Step 26c: "Order Confirmed" (Figma confirmation_status 41:4066; CLAUDE.md → Order confirmed
-// dialog). It opens over the page that confirmed the order: the checkout (Mobile Banking) or the
-// verify page (a right code). Neither page opens it: they send the shop:order-confirmed event, and
+// dialog). It opens over the page that confirmed the order: the verify page (a right code) or
+// (step 27d) /checkout/paid (the payment arrived). Neither page opens it: they send the shop:order-confirmed event, and
 // this listens on the document (decision 24). Only those two pages draw it.
 // A native <dialog> in a custom element, like the cart drawer: showModal() gives the focus trap,
 // Escape, the inert page and the backdrop, with a few lines of script and no React.
```

```diff
@@ -1,8 +1,9 @@
 import type { ShopOrderConfirmed } from '@omnivo/contracts';
 
 // Step 26c: the checkout tells the page that an order is confirmed with a DOM event, not a React
-// prop. Two places confirm an order: the checkout island (Mobile Banking, no code) and the verify
-// page's script (a right code, 26c.5). One "Order Confirmed" dialog listens on the document, so it
+// prop. Two places confirm an order: the verify page's script (a right code, 26c.5) and, since step
+// 27d, /checkout/paid's (the payment arrived). The checkout island still can, for the contract's
+// `confirmed` answer. One "Order Confirmed" dialog listens on the document, so it
 // does not care which of them sent it, and neither imports the dialog's code.
 export const ORDER_CONFIRMED_EVENT = 'shop:order-confirmed';
 
```

Comments only: the checkout no longer confirms an order; `/checkout/paid` does.

```diff
@@ -38,7 +38,8 @@ const details = [
   { label: t('shop.checkout.phone'), value: spacedPhone(order.phone) },
   { label: t('shop.checkout.address'), value: order.address },
   { label: t('shop.checkout.zone'), value: order.zoneName },
-  { label: t('shop.order.payment'), value: t(`shop.checkout.${order.paymentMethod}`) },
+  // Step 27d: "Paid online", not the checkout's "Pay online": a confirmed online order is paid
+  { label: t('shop.order.payment'), value: t(`shop.order.paymentMethods.${order.paymentMethod}`) },
 ];
 const heading = 'font-semibold';
 ---
```

A confirmed online order is paid, so the order page says "Paid online", not the checkout's "Pay online" (27d.5's
`order.paymentMethods`).

```diff
@@ -45,7 +45,7 @@ const PRIVACY = `<section>
 
 const TERMS = `<section>
 <h2>Orders</h2>
-<p>An order is placed when you confirm it with the code we send to your mobile number, or when you pay with Mobile Banking. Prices are the ones on the checkout page when you confirm.</p>
+<p>An order is placed when you confirm it with the code we send to your mobile number, or when your online payment arrives. Prices are the ones on the checkout page when you confirm.</p>
 </section>
 <section>
 <h2>Delivery</h2>
```

```diff
@@ -117,7 +117,7 @@ export const PAGES: Readonly<Record<ShopTextPageSlug, StorefrontSection[]>> = {
   terms: [
     {
       heading: 'Orders',
-      body: 'An order is placed when you confirm it with the code we send to your mobile number, or when you pay with Mobile Banking. Prices are the ones on the checkout page when you confirm.',
+      body: 'An order is placed when you confirm it with the code we send to your mobile number, or when your online payment arrives. Prices are the ones on the checkout page when you confirm.',
     },
     {
       heading: 'Delivery',
```

```diff
@@ -100,7 +100,7 @@ function demoOrder(input: DemoInput): MockDemoOrder {
 }
 
 export const mockDemoOrders: readonly MockDemoOrder[] = [
-  // Delivered in Dhaka, paid with Mobile Banking. The first booking (RedX) was cancelled before its
+  // Delivered in Dhaka, paid online. The first booking (RedX) was cancelled before its
   // rider came, and the shop booked Pathao instead: the page's "Earlier parcel". Over ৳1,000, so
   // the delivery was free. Step 27c: with EID100's only use (৳100 off), so that code answers
   // "used up" in the shop from the start
```

The test shop's Terms page and the API seed's say "when your online payment arrives". The demo order's comment
follows the new words.

### The shop's tests

```ts
import { fakeGatewayParamsSchema, fakeValId, type FakeGatewayOutcome } from '@omnivo/contracts';

import type { PlacedOrder, ShopSource } from '../types';

// Step 27d: for the tests. What a press on the fake gateway's page does (pages/checkout/
// fake-gateway.astro): the page's address names the try and its amount, and the button posts its
// val_id to the return path, which settles the try. The tests of the mock, of the routes and of
// tracking pay this way, so each one says only what it checks.

// The try and the amount on a payment page's address
export function fakePageOf(paymentUrl: string | null): { tranId: string; amount: string } {
  if (paymentUrl === null) throw new Error('No payment page opened');
  const url = new URL(paymentUrl);
  return fakeGatewayParamsSchema.parse({
    tranId: url.searchParams.get('tranId'),
    amount: url.searchParams.get('amount'),
  });
}

// Presses one of the page's buttons for the order's newest try. `amount` changes what "Pay" says
// was paid, as a tester can by editing the address
export async function pressOnFakePage(
  source: ShopSource,
  paymentUrl: string | null,
  outcome: FakeGatewayOutcome = 'paid',
  amount?: string,
) {
  const page = fakePageOf(paymentUrl);
  const valId =
    outcome === 'paid'
      ? fakeValId(page.tranId, { outcome, amount: amount ?? page.amount })
      : fakeValId(page.tranId, { outcome });
  return source.settlePayment({ tranId: page.tranId, valId });
}

// Places nothing: pays an order placed with Pay online, and gives back its number
export async function payPlaced(source: ShopSource, placed: PlacedOrder): Promise<string> {
  if (placed.answer.next !== 'pay') throw new Error(`The order answered ${placed.answer.next}`);
  await pressOnFakePage(source, placed.answer.paymentUrl);
  const wait = await source.paymentWait(placed.token);
  if (wait?.state !== 'paid') throw new Error('The payment did not confirm the order');
  return wait.orderNo;
}
```

A helper for the tests: what a press on the fake page does, so each test says only what it checks. It is not a spec
file, so Vitest does not run it, and only spec files import it.

```diff
@@ -1,5 +1,6 @@
 import {
   SHOP_CODE_TRIES,
+  SHOP_FAKE_GATEWAY_PATH,
   shopOrderSchema,
   shopOrderTokenSchema,
   type ShopOrderRequest,
@@ -7,6 +8,7 @@ import {
 import { describe, expect, it } from 'vitest';
 
 import type { PlacedOrder, ShopSource } from '../types';
+import { fakePageOf, payPlaced, pressOnFakePage } from './fake-payment';
 import { createMockSource } from './mock-source';
 import { MOCK_CODE } from './orders';
 
@@ -28,6 +30,8 @@ const ORDER: ShopOrderRequest = {
 
 // The shopper's address. The mock has no order limits, so any address does
 const ADDRESS = '203.0.113.7';
+// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
+const ORIGIN = 'http://shop.test';
 
 // A source whose clock the test moves
 function withClock() {
@@ -43,15 +47,17 @@ function withClock() {
 }
 
 async function placed(source: ShopSource, request: ShopOrderRequest = ORDER) {
-  const result = await source.placeOrder(request, ADDRESS);
+  const result = await source.placeOrder(request, ADDRESS, ORIGIN);
   if (!result.ok) throw new Error(`refused: ${result.code}`);
   return result.value;
 }
 
-// Step 27a: a confirmed order's number is only in its answer
-function numberOf({ answer }: PlacedOrder): string {
-  if (answer.next !== 'confirmed') throw new Error('The order waits for its code');
-  return answer.orderNo;
+const ONLINE: ShopOrderRequest = { ...ORDER, paymentMethod: 'online' };
+
+// Step 27d: an online order's page, which every placed online order has in the mock
+function pageOf({ answer }: PlacedOrder): string | null {
+  if (answer.next !== 'pay') throw new Error(`The order answered ${answer.next}`);
+  return answer.paymentUrl;
 }
 
 describe('the mock’s orders', () => {
@@ -98,13 +104,161 @@ describe('the mock’s orders', () => {
     expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
   });
 
-  it('confirms Mobile Banking at once, with the next number', async () => {
+  it('waits for an online payment, with no phone code', async () => {
+    const { source } = withClock();
+    const order = await placed(source, ONLINE);
+    // The fake gateway's page on this shop, for the order's total (৳687 + ৳80)
+    expect(pageOf(order)).toMatch(
+      new RegExp(`^${ORIGIN}${SHOP_FAKE_GATEWAY_PATH}\\?tranId=[A-Z0-9]{20}&amount=767\\.0000$`),
+    );
+    // Not an order yet, and the code's routes do not know it: the mock's 123456 must not confirm
+    // an unpaid order
+    expect(await source.order('W-000001', order.token)).toBeNull();
+    expect(await source.codeWait(order.token)).toBeNull();
+    expect(await source.verifyCode(order.token, MOCK_CODE)).toMatchObject({
+      code: 'shop_code_no_order',
+    });
+    // Back without pressing anything on the page: not finished, two more tries
+    expect(await source.paymentWait(order.token)).toEqual({
+      state: 'unpaid',
+      problem: 'not_finished',
+      triesLeft: 2,
+      payOnDelivery: true,
+      total: '767.0000',
+    });
+  });
+
+  it('confirms an online order when its payment arrives, once', async () => {
     const { source } = withClock();
     await placed(source);
-    const order = await placed(source, { ...ORDER, paymentMethod: 'online' });
-    expect(order.answer).toEqual({ next: 'confirmed', orderNo: 'W-000002', phone: '01786120356' });
-    expect(numberOf(order)).toBe('W-000002');
-    expect((await source.order('W-000002', order.token))?.status).toBe('confirmed');
+    const order = await placed(source, ONLINE);
+    expect(await pressOnFakePage(source, pageOf(order))).toEqual({ status: 'paid' });
+    expect(await source.paymentWait(order.token)).toEqual({
+      state: 'paid',
+      orderNo: 'W-000002',
+      phone: '01786120356',
+      listingIds: [NEEM],
+    });
+    // The browser and the gateway's notice both settle it: the second changes nothing
+    expect(await pressOnFakePage(source, pageOf(order), 'failed')).toEqual({ status: 'paid' });
+    const shown = await source.order('W-000002', order.token);
+    expect(shown).toMatchObject({ status: 'confirmed', paymentMethod: 'online' });
+    expect(shown?.history.map((step) => step.status)).toEqual(['pending', 'confirmed']);
+  });
+
+  it('does not believe a payment for another amount or another try', async () => {
+    const { source } = withClock();
+    const order = await placed(source, ONLINE);
+    expect(await pressOnFakePage(source, pageOf(order), 'paid', '1')).toEqual({
+      status: 'started',
+    });
+    // Another try's val_id on this try's id
+    const { tranId } = fakePageOf(pageOf(order));
+    const other = fakePageOf(pageOf(await placed(source, ONLINE)));
+    expect(await source.settlePayment({ tranId, valId: `FAKE_${other.tranId}_767.0000` })).toEqual({
+      status: 'started',
+    });
+    // No val_id: the fake gateway knows no payment by the transaction id alone
+    expect(await source.settlePayment({ tranId, valId: null })).toEqual({ status: 'started' });
+    // A transaction id no try has
+    expect(await source.settlePayment({ tranId: 'A'.repeat(20), valId: null })).toBeNull();
+    expect(await source.paymentWait(order.token)).toMatchObject({ state: 'unpaid' });
+  });
+
+  it('gives an order three tries, each with its own page', async () => {
+    const { source } = withClock();
+    const order = await placed(source, ONLINE);
+    expect(await pressOnFakePage(source, pageOf(order), 'failed')).toEqual({ status: 'failed' });
+    expect(await source.paymentWait(order.token)).toMatchObject({
+      problem: 'failed',
+      triesLeft: 2,
+    });
+
+    const second = await source.retryPayment(order.token, ORIGIN);
+    if (!second.ok) throw new Error(second.code);
+    expect(fakePageOf(second.value.paymentUrl).tranId).not.toBe(fakePageOf(pageOf(order)).tranId);
+    expect(await pressOnFakePage(source, second.value.paymentUrl, 'cancelled')).toEqual({
+      status: 'cancelled',
+    });
+    const third = await source.retryPayment(order.token, ORIGIN);
+    if (!third.ok) throw new Error(third.code);
+    expect(await source.paymentWait(order.token)).toMatchObject({
+      problem: 'not_finished',
+      triesLeft: 0,
+    });
+    expect(await source.retryPayment(order.token, ORIGIN)).toEqual({
+      ok: false,
+      code: 'shop_payment_tries_used',
+    });
+    // The third page still pays
+    await pressOnFakePage(source, third.value.paymentUrl);
+    expect(await source.paymentWait(order.token)).toMatchObject({ state: 'paid' });
+    expect(await source.retryPayment(order.token, ORIGIN)).toEqual({
+      ok: false,
+      code: 'shop_payment_no_order',
+    });
+  });
+
+  it('turns an online order into Cash on Delivery with its phone code', async () => {
+    const { source } = withClock();
+    const order = await placed(source, ONLINE);
+    const cod = await source.payOnDelivery(order.token);
+    expect(cod).toEqual({
+      ok: true,
+      value: {
+        next: 'verify',
+        maskedPhone: '+880 17•• ••• 356',
+        resendInSeconds: 45,
+        listingIds: [NEEM],
+      },
+    });
+    // A second press is the same answer, and "Try again" is over
+    expect(await source.payOnDelivery(order.token)).toEqual(cod);
+    expect(await source.retryPayment(order.token, ORIGIN)).toEqual({
+      ok: false,
+      code: 'shop_payment_settled',
+    });
+    expect(await source.paymentWait(order.token)).toBeNull();
+    expect(await source.verifyCode(order.token, MOCK_CODE)).toMatchObject({ ok: true });
+    expect(await source.order('W-000001', order.token)).toMatchObject({ paymentMethod: 'cod' });
+
+    // The first page was still open and paid after the code: the money is kept, the order stays
+    // Cash on Delivery (the ERP's order page says to refund one)
+    expect(await pressOnFakePage(source, pageOf(order))).toEqual({ status: 'paid' });
+    expect(await source.order('W-000001', order.token)).toMatchObject({
+      status: 'confirmed',
+      paymentMethod: 'cod',
+    });
+  });
+
+  it('confirms as online an order paid while it waited for its phone code', async () => {
+    const { source } = withClock();
+    const order = await placed(source, ONLINE);
+    await source.payOnDelivery(order.token);
+    await pressOnFakePage(source, pageOf(order));
+    expect(await source.codeWait(order.token)).toBeNull();
+    expect(await source.order('W-000001', order.token)).toMatchObject({
+      status: 'confirmed',
+      paymentMethod: 'online',
+    });
+  });
+
+  it('confirms a payment that arrives after the hour, which the page no longer offers', async () => {
+    const { source, wait } = withClock();
+    const order = await placed(source, ONLINE);
+    wait(61 * 60);
+    // Decision 5: the money came, so the order is confirmed; the stock is checked at Packed
+    expect(await pressOnFakePage(source, pageOf(order))).toEqual({ status: 'paid' });
+    expect(await source.order('W-000001', order.token)).toMatchObject({ status: 'confirmed' });
+
+    // An order that was never paid is gone after its hour
+    const late = await placed(source, ONLINE);
+    wait(61 * 60);
+    expect(await source.paymentWait(late.token)).toBeNull();
+    expect(await source.payOnDelivery(late.token)).toEqual({
+      ok: false,
+      code: 'shop_payment_no_order',
+    });
   });
 
   it('drops the order after five wrong codes', async () => {
@@ -198,7 +352,7 @@ describe('the mock’s orders', () => {
 
   it('refuses what the shop does not offer', async () => {
     const { source } = withClock();
-    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' }, ADDRESS)).toEqual({
+    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' }, ADDRESS, ORIGIN)).toEqual({
       ok: false,
       code: 'shop_zone_unknown',
     });
@@ -208,7 +362,7 @@ describe('the mock’s orders', () => {
     const { source } = withClock();
     // One face wash: ৳229 of items, ৳80 delivery
     const small = { ...ORDER, lines: [{ listingId: NEEM, quantity: 1 }], expectedTotal: '309' };
-    expect(await source.placeOrder(small, ADDRESS)).toEqual({
+    expect(await source.placeOrder(small, ADDRESS, ORIGIN)).toEqual({
       ok: false,
       code: 'shop_order_below_minimum',
       params: { minimum: '300' },
@@ -218,13 +372,15 @@ describe('the mock’s orders', () => {
   it('refuses an order whose total or stock changed since the last quote', async () => {
     const { source } = withClock();
     // Decision 10: the shopper saw ৳747 (an old price); the server's total is ৳767
-    expect(await source.placeOrder({ ...ORDER, expectedTotal: '747' }, ADDRESS)).toMatchObject({
+    expect(
+      await source.placeOrder({ ...ORDER, expectedTotal: '747' }, ADDRESS, ORIGIN),
+    ).toMatchObject({
       code: 'shop_order_changed',
     });
     // A line went out of stock: the total of what is left might still match, so it is checked
     // on its own
     const withMilk = { ...ORDER, lines: [...ORDER.lines, { listingId: DANO, quantity: 1 }] };
-    expect(await source.placeOrder(withMilk, ADDRESS)).toMatchObject({
+    expect(await source.placeOrder(withMilk, ADDRESS, ORIGIN)).toMatchObject({
       code: 'shop_order_changed',
     });
   });
@@ -233,12 +389,11 @@ describe('the mock’s orders', () => {
     const { source } = withClock();
     // ৳687 − 10% (৳68.70) + ৳80
     const placedOrder = await placed(source, {
-      ...ORDER,
+      ...ONLINE,
       couponCode: 'WELCOME10',
-      paymentMethod: 'online',
       expectedTotal: '698.30',
     });
-    const order = await source.order(numberOf(placedOrder), placedOrder.token);
+    const order = await source.order(await payPlaced(source, placedOrder), placedOrder.token);
     expect(order).toMatchObject({
       couponCode: 'WELCOME10',
       discount: '68.7000',
@@ -257,7 +412,7 @@ describe('the mock’s orders', () => {
     const welcome = { ...ORDER, couponCode: 'WELCOME10', expectedTotal: '698.30' };
     // Cash on Delivery: it waits for its code, and already holds the use
     await placed(source, welcome);
-    expect(await source.placeOrder(welcome, ADDRESS)).toEqual({
+    expect(await source.placeOrder(welcome, ADDRESS, ORIGIN)).toEqual({
       ok: false,
       code: 'shop_coupon_used_by_phone',
     });
@@ -281,7 +436,9 @@ describe('the mock’s orders', () => {
     expect((await source.quote({ lines: ORDER.lines, couponCode: 'EID100' })).coupon).toMatchObject(
       { status: 'refused', reason: 'shop_coupon_used_up' },
     );
-    expect(await source.placeOrder({ ...eid, phone: '01711284519' }, ADDRESS)).toMatchObject({
+    expect(
+      await source.placeOrder({ ...eid, phone: '01711284519' }, ADDRESS, ORIGIN),
+    ).toMatchObject({
       ok: false,
       code: 'shop_order_changed',
     });
```

26c's "confirms Mobile Banking at once" is replaced by the online order's whole life: no code, paid once, a wrong
amount or another try's `val_id` not believed, three tries, "Pay on delivery" and a payment after it, and a payment
after the hour.

```diff
@@ -12,6 +12,7 @@ import {
 import { describe, expect, it } from 'vitest';
 
 import { mockDemoOrders } from './demo-orders';
+import { payPlaced } from './fake-payment';
 import { createMockSource } from './mock-source';
 
 // Step 26e: the demo orders, tracking by link and by the form, and the text pages
@@ -28,6 +29,8 @@ const asked = (phone: string, orderNo: string) => shopTrackRequestSchema.parse({
 
 // Step 27a: the shopper's address, which the mock counts misses under
 const ADDRESS = '203.0.113.7';
+// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
+const ORIGIN = 'http://shop.test';
 
 // Two face washes, inside Dhaka: ৳458 + ৳80, over the shop's ৳300 minimum
 function order(paymentMethod: ShopOrderRequest['paymentMethod']): ShopOrderRequest {
@@ -113,9 +116,10 @@ describe('tracking in the mock', () => {
 
   it('numbers new orders after the demo ones, and tracks them with no parcel', async () => {
     const source = demoSource();
-    const placed = await source.placeOrder(order('online'), ADDRESS);
+    const placed = await source.placeOrder(order('online'), ADDRESS, ORIGIN);
     if (!placed.ok) throw new Error(placed.code);
-    expect(placed.value.answer).toMatchObject({ next: 'confirmed', orderNo: 'W-000124' });
+    // Step 27d: confirmed once it is paid on the fake gateway's page
+    expect(await payPlaced(source, placed.value)).toBe('W-000124');
 
     const tracked = await source.track(asked('01786120356', 'W-000124'), ADDRESS);
     expect(tracked).toMatchObject({ ok: true, value: { status: 'confirmed', shipments: [] } });
@@ -123,7 +127,7 @@ describe('tracking in the mock', () => {
 
   it('does not track an order that waits for its code', async () => {
     const source = demoSource();
-    const placed = await source.placeOrder(order('cod'), ADDRESS);
+    const placed = await source.placeOrder(order('cod'), ADDRESS, ORIGIN);
     if (!placed.ok) throw new Error(placed.code);
     // The mock numbers its orders as they are placed: the next one after the demo orders
     expect(await source.track(asked('01786120356', 'W-000124'), ADDRESS)).toMatchObject({
```

```diff
@@ -8,6 +8,7 @@ import {
   shopOrderNoSchema,
   shopOrderRequestSchema,
   shopOrderTokenSchema,
+  shopPaymentSettleRequestSchema,
   shopTrackingTokenSchema,
   shopTrackRequestSchema,
   shopVerifyCodeRequestSchema,
@@ -17,6 +18,7 @@ import { describe, expect, it } from 'vitest';
 import { z } from 'zod';
 
 import { mockDemoOrders } from '../mock/demo-orders';
+import { fakePageOf, pressOnFakePage } from '../mock/fake-payment';
 import { mockHome } from '../mock/home';
 import { createMockSource } from '../mock/mock-source';
 import { MOCK_CODE } from '../mock/orders';
@@ -34,6 +36,8 @@ const API = 'http://api.test';
 // Step 27a: the shop server's key (SHOP_API_KEY) and the shopper's address
 const KEY = 'test-shop-key-0123456789abcdef0123456789';
 const ADDRESS = '203.0.113.7';
+// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
+const ORIGIN = 'http://shop.test';
 const STEVIA = 'lst-zero-cal-stevia-30-sachets';
 const NEEM = 'himalaya-purifying-neem-face-wash-150ml';
 
@@ -53,6 +57,9 @@ const STATUS: Record<string, number> = {
   shop_track_too_many: 429,
   shop_code_no_order: 404,
   shop_track_not_found: 404,
+  // Step 27d (shop-payments.service.ts)
+  shop_payment_no_order: 404,
+  shop_payment_settled: 409,
 };
 
 function answered<T>(result: SourceResult<T, string>, status = 200): Response {
@@ -78,7 +85,10 @@ function fakeApi(data: ShopSource = createMockSource()) {
     }
     // Step 27a: the order routes, behind the key like the API's ShopKeyGuard. The mock behind them
     // keeps the API's rules for the code (data/mock/orders.ts)
-    if (request.method === 'POST' && /^\/(?:orders|tracking|track)(?:\/|$)/.test(path)) {
+    if (
+      request.method === 'POST' &&
+      /^\/(?:orders|tracking|track|payments\/settle)(?:\/|$)/.test(path)
+    ) {
       if (request.headers.get(SHOP_KEY_HEADER) !== KEY) {
         return problem(401, 'storefront_shop_key_invalid');
       }
@@ -110,7 +120,24 @@ function fakeApi(data: ShopSource = createMockSource()) {
     const address = request.headers.get(SHOP_CLIENT_ADDRESS_HEADER) ?? 'no address';
     switch (path) {
       case '/orders':
-        return answered(await data.placeOrder(shopOrderRequestSchema.parse(json), address), 201);
+        // Step 27d: the API builds the fake gateway's page on the shop's address; so does the mock
+        return answered(
+          await data.placeOrder(shopOrderRequestSchema.parse(json), address, `http://${HOST}`),
+          201,
+        );
+      // Step 27d
+      case '/payments/settle': {
+        const settled = await data.settlePayment(shopPaymentSettleRequestSchema.parse(json));
+        return settled === null ? problem(404, 'not_found') : Response.json(settled);
+      }
+      case '/orders/payment': {
+        const wait = await data.paymentWait(tokenBody.parse(json).token);
+        return wait === null ? problem(404, 'shop_payment_no_order') : Response.json(wait);
+      }
+      case '/orders/payment/retry':
+        return answered(await data.retryPayment(tokenBody.parse(json).token, `http://${HOST}`));
+      case '/orders/payment/cod':
+        return answered(await data.payOnDelivery(tokenBody.parse(json).token));
       case '/orders/code-wait': {
         const wait = await data.codeWait(tokenBody.parse(json).token);
         return wait === null ? problem(404, 'shop_code_no_order') : Response.json(wait);
@@ -337,6 +364,7 @@ describe('orders on the API source', () => {
     const placed = await source.placeOrder(
       { ...order, expectedTotal: await expectedTotal() },
       ADDRESS,
+      ORIGIN,
     );
     if (!placed.ok) throw new Error(`refused: ${placed.code}`);
     return placed.value;
@@ -390,12 +418,64 @@ describe('orders on the API source', () => {
     expect(api.paths().some((path) => path.includes(token))).toBe(false);
   });
 
-  it('passes on the refusals the pages know, with their params', async () => {
+  // Step 27d: the four payment routes, with the token in the body as for the code
+  it('pays online through the API, and turns an order into Cash on Delivery', async () => {
     const { source, api } = setup();
-    expect(await source.placeOrder({ ...order, expectedTotal: '1.0000' }, ADDRESS)).toEqual({
+    const placed = await source.placeOrder(
+      { ...order, paymentMethod: 'online', expectedTotal: await expectedTotal() },
+      ADDRESS,
+      ORIGIN,
+    );
+    if (!placed.ok || placed.value.answer.next !== 'pay') throw new Error('not an online order');
+    const { token } = placed.value;
+    const { paymentUrl } = placed.value.answer;
+    expect(paymentUrl).toMatch(/^http:\/\/nirvor\.omnivo\.test\/checkout\/fake-gateway\?/);
+    expect(await source.paymentWait(token)).toMatchObject({ state: 'unpaid', triesLeft: 2 });
+
+    const second = await source.retryPayment(token, ORIGIN);
+    if (!second.ok) throw new Error(second.code);
+    expect(await pressOnFakePage(source, second.value.paymentUrl, 'failed')).toEqual({
+      status: 'failed',
+    });
+    expect(await source.paymentWait(token)).toMatchObject({ problem: 'failed', triesLeft: 1 });
+    expect(await pressOnFakePage(source, paymentUrl)).toEqual({ status: 'paid' });
+    expect(await source.paymentWait(token)).toMatchObject({ state: 'paid', orderNo: 'W-000001' });
+    expect(await source.retryPayment(token, ORIGIN)).toEqual({
+      ok: false,
+      code: 'shop_payment_no_order',
+    });
+    // An id no try has is null, not an error: a made-up post is normal traffic
+    expect(await source.settlePayment({ tranId: 'Z'.repeat(20), valId: null })).toBeNull();
+    expect(sentTo(api, '/payments/settle')[0]?.headers.get(SHOP_KEY_HEADER)).toBe(KEY);
+
+    const other = await source.placeOrder(
+      { ...order, paymentMethod: 'online', expectedTotal: await expectedTotal() },
+      ADDRESS,
+      ORIGIN,
+    );
+    if (!other.ok) throw new Error(other.code);
+    expect(await source.payOnDelivery(other.value.token)).toMatchObject({
+      ok: true,
+      value: { next: 'verify', listingIds: [STEVIA] },
+    });
+    expect(await source.retryPayment(other.value.token, ORIGIN)).toEqual({
       ok: false,
-      code: 'shop_order_changed',
+      code: 'shop_payment_settled',
     });
+    expect(await source.paymentWait(other.value.token)).toBeNull();
+    // The tokens went in bodies only
+    expect(api.paths().some((path) => path.includes(token))).toBe(false);
+    expect(fakePageOf(paymentUrl).amount).toBe(await expectedTotal());
+  });
+
+  it('passes on the refusals the pages know, with their params', async () => {
+    const { source, api } = setup();
+    expect(await source.placeOrder({ ...order, expectedTotal: '1.0000' }, ADDRESS, ORIGIN)).toEqual(
+      {
+        ok: false,
+        code: 'shop_order_changed',
+      },
+    );
     const { token } = await place(source);
     expect(await source.verifyCode(token, '000000')).toEqual({
       ok: false,
@@ -408,7 +488,7 @@ describe('orders on the API source', () => {
       params: { seconds: 45 },
     });
     api.failWith(problem(429, 'shop_order_limit', { minutes: 12 }));
-    expect(await source.placeOrder({ ...order, expectedTotal: '1' }, ADDRESS)).toEqual({
+    expect(await source.placeOrder({ ...order, expectedTotal: '1' }, ADDRESS, ORIGIN)).toEqual({
       ok: false,
       code: 'shop_order_limit',
       params: { minutes: 12 },
@@ -430,8 +510,8 @@ describe('orders on the API source', () => {
         })
       ).total,
     };
-    expect((await source.placeOrder(welcome, ADDRESS)).ok).toBe(true);
-    expect(await source.placeOrder(welcome, ADDRESS)).toEqual({
+    expect((await source.placeOrder(welcome, ADDRESS, ORIGIN)).ok).toBe(true);
+    expect(await source.placeOrder(welcome, ADDRESS, ORIGIN)).toEqual({
       ok: false,
       code: 'shop_coupon_used_by_phone',
     });
@@ -448,7 +528,7 @@ describe('orders on the API source', () => {
   it('names the setting to fix when the API refuses the key', async () => {
     const { source } = setup({ key: 'not-the-api-key-0123456789abcdef01234' });
     await expect(
-      source.placeOrder({ ...order, expectedTotal: await expectedTotal() }, ADDRESS),
+      source.placeOrder({ ...order, expectedTotal: await expectedTotal() }, ADDRESS, ORIGIN),
     ).rejects.toThrow(/SHOP_API_KEY/);
     // The read routes need no key, so the shop's pages still work
     expect(await source.shop()).toEqual(mockShop);
```

The tests' fake API gets the four payment routes behind the key, so the API source is tested against the same answers
as the mock. The tokens still travel in bodies only.

```diff
@@ -15,6 +15,8 @@ const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
 const OPTIONS = { secure: false };
 // The shopper's address, which the route passes on to the source (the API counts orders by it)
 const ADDRESS = '203.0.113.7';
+// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
+const ORIGIN = 'http://shop.test';
 
 // What the checkout sends: the phone as the shopper typed it
 const ORDER: ShopOrderRequestInput = {
@@ -68,7 +70,13 @@ function withClock() {
 
 // Places a Cash on Delivery order and gives back the cookie the browser keeps
 async function placeCod(source: ShopSource): Promise<string> {
-  const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, OPTIONS);
+  const response = await answerPlaceOrder(
+    post('/api/orders', ORDER),
+    source,
+    ADDRESS,
+    ORIGIN,
+    OPTIONS,
+  );
   expect(response.status).toBe(201);
   return sentBack(cookiesOf(response).get('shop_checkout'));
 }
@@ -76,7 +84,13 @@ async function placeCod(source: ShopSource): Promise<string> {
 describe('POST /api/orders', () => {
   it('places a Cash on Delivery order and keeps its token out of reach of scripts', async () => {
     const { source } = withClock();
-    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, OPTIONS);
+    const response = await answerPlaceOrder(
+      post('/api/orders', ORDER),
+      source,
+      ADDRESS,
+      ORIGIN,
+      OPTIONS,
+    );
     expect(response.status).toBe(201);
     expect(response.headers.get('Cache-Control')).toBe('no-store');
 
@@ -97,32 +111,33 @@ describe('POST /api/orders', () => {
 
   it('marks the cookies Secure in production', async () => {
     const { source } = withClock();
-    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, {
+    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, ADDRESS, ORIGIN, {
       secure: true,
     });
     expect(cookiesOf(response).get('shop_checkout')).toMatch(/; Secure$/);
   });
 
-  it('confirms Mobile Banking at once and remembers the order in this browser', async () => {
+  // Step 27d: Pay online waits for its payment, as Cash on Delivery waits for its code
+  it('sends Pay online to the payment page, with the order in the checkout cookie', async () => {
     const { source } = withClock();
     const response = await answerPlaceOrder(
       post('/api/orders', { ...ORDER, paymentMethod: 'online' }),
       source,
       ADDRESS,
+      ORIGIN,
       OPTIONS,
     );
     expect(response.status).toBe(201);
-    expect(await response.json()).toEqual({
-      next: 'confirmed',
-      orderNo: 'W-000001',
-      phone: '01786120356',
-    });
-    const cookies = cookiesOf(response);
-    expect(cookies.get('shop_orders')).toMatch(
-      /^shop_orders=W-000001:[A-Za-z0-9_-]{22}; Path=\/; Max-Age=2592000;/,
+    const answer = shopOrderPlacedSchema.parse(await response.json());
+    if (answer.next !== 'pay') throw new Error(`The order answered ${answer.next}`);
+    // On this shop's own address (ORIGIN), as the API's fake gateway puts it
+    expect(answer.paymentUrl).toMatch(
+      /^http:\/\/shop\.test\/checkout\/fake-gateway\?tranId=[A-Z0-9]{20}&/,
     );
-    // A code that was still waiting from an earlier try is forgotten
-    expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=; Path=\/; Max-Age=0;/);
+    const cookies = cookiesOf(response);
+    expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=[A-Za-z0-9_-]{22}; Path=\//);
+    // Not this browser's order yet: /order/<no> opens only once it is paid
+    expect(cookies.has('shop_orders')).toBe(false);
   });
 
   it('names the fields the shopper must fix', async () => {
@@ -136,6 +151,7 @@ describe('POST /api/orders', () => {
       }),
       source,
       ADDRESS,
+      ORIGIN,
       OPTIONS,
     );
     expect(response.status).toBe(400);
@@ -154,7 +170,7 @@ describe('POST /api/orders', () => {
       headers: { 'Content-Type': 'text/plain' },
       body: JSON.stringify(ORDER),
     });
-    const response = await answerPlaceOrder(request, source, ADDRESS, OPTIONS);
+    const response = await answerPlaceOrder(request, source, ADDRESS, ORIGIN, OPTIONS);
     expect(response.status).toBe(400);
     expect((await problemOf(response)).code).toBe('malformed_request');
   });
@@ -165,6 +181,7 @@ describe('POST /api/orders', () => {
       post('/api/orders', { ...ORDER, expectedTotal: '700' }),
       source,
       ADDRESS,
+      ORIGIN,
       OPTIONS,
     );
     expect(response.status).toBe(409);
@@ -181,6 +198,7 @@ describe('POST /api/orders', () => {
       }),
       source,
       ADDRESS,
+      ORIGIN,
       OPTIONS,
     );
     expect(response.status).toBe(422);
@@ -194,12 +212,12 @@ describe('POST /api/orders', () => {
     const addresses: string[] = [];
     const watched: ShopSource = {
       ...source,
-      placeOrder: (request, address) => {
+      placeOrder: (request, address, origin) => {
         addresses.push(address);
-        return source.placeOrder(request, address);
+        return source.placeOrder(request, address, origin);
       },
     };
-    await answerPlaceOrder(post('/api/orders', ORDER), watched, ADDRESS, OPTIONS);
+    await answerPlaceOrder(post('/api/orders', ORDER), watched, ADDRESS, ORIGIN, OPTIONS);
     expect(addresses).toEqual([ADDRESS]);
   });
 
@@ -209,7 +227,13 @@ describe('POST /api/orders', () => {
       placeOrder: () =>
         Promise.resolve({ ok: false, code: 'shop_order_limit', params: { minutes: 12 } }),
     };
-    const response = await answerPlaceOrder(post('/api/orders', ORDER), limited, ADDRESS, OPTIONS);
+    const response = await answerPlaceOrder(
+      post('/api/orders', ORDER),
+      limited,
+      ADDRESS,
+      ORIGIN,
+      OPTIONS,
+    );
     expect(response.status).toBe(429);
     // Retry-After is in seconds; the words say minutes
     expect(response.headers.get('Retry-After')).toBe('720');
@@ -224,8 +248,14 @@ describe('POST /api/orders', () => {
     const source = createMockSource();
     // ৳687 − 10% (৳68.70) + ৳80. The first order holds the use while it waits for its code
     const welcome = { ...ORDER, couponCode: 'WELCOME10', expectedTotal: '698.30' };
-    await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, OPTIONS);
-    const response = await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, OPTIONS);
+    await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, ORIGIN, OPTIONS);
+    const response = await answerPlaceOrder(
+      post('/api/orders', welcome),
+      source,
+      ADDRESS,
+      ORIGIN,
+      OPTIONS,
+    );
     expect(response.status).toBe(422);
     expect(await problemOf(response)).toMatchObject({ code: 'shop_coupon_used_by_phone' });
   });
@@ -238,7 +268,13 @@ describe('POST /api/orders', () => {
     const quiet = console.error;
     console.error = () => undefined;
     try {
-      const response = await answerPlaceOrder(post('/api/orders', ORDER), down, ADDRESS, OPTIONS);
+      const response = await answerPlaceOrder(
+        post('/api/orders', ORDER),
+        down,
+        ADDRESS,
+        ORIGIN,
+        OPTIONS,
+      );
       expect(response.status).toBe(500);
       expect(JSON.stringify(await problemOf(response))).not.toContain('10.0.0.5');
     } finally {
```

```ts
import {
  fakeValId,
  type ShopOrderRequestInput,
  SHOP_PAYMENT_NOTICE_PATH,
  SHOP_PAYMENT_RETURN_PATH,
  shopPaymentRetrySchema,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { fakePageOf } from '../data/mock/fake-payment';
import { createMockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { answerPlaceOrder } from './orders';
import {
  answerGatewayNotice,
  answerGatewayReturn,
  answerPayOnDelivery,
  answerRetryPayment,
  gatewayIds,
} from './payments';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const OPTIONS = { secure: false };
const ADDRESS = '203.0.113.7';
// Step 27d: the shop's own address, for the mock's fake gateway page (ShopSource.placeOrder)
const ORIGIN = 'http://shop.test';

const ONLINE: ShopOrderRequestInput = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'online',
  termsAccepted: true,
  expectedTotal: '767',
};

// What SSLCommerz posts: a form, with more fields than the two the shop reads
function gatewayPost(path: string, fields: Record<string, string>, type = 'form'): Request {
  const body = new URLSearchParams({ status: 'VALID', amount: '1.00', ...fields });
  return new Request(`http://shop.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': type === 'form' ? 'application/x-www-form-urlencoded' : type,
    },
    body: body.toString(),
  });
}

function withCookie(path: string, cookie: string | null): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie !== null) headers.set('Cookie', cookie);
  return new Request(`http://shop.test${path}`, { method: 'POST', headers });
}

// Places an online order through the route and gives back its cookie and page
async function placeOnline(source: ShopSource) {
  const response = await answerPlaceOrder(
    new Request('http://shop.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ONLINE),
    }),
    source,
    ADDRESS,
    ORIGIN,
    OPTIONS,
  );
  const body: unknown = await response.json();
  const line = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('shop_checkout='));
  if (line === undefined || typeof body !== 'object' || body === null || !('paymentUrl' in body)) {
    throw new Error('Not an online order');
  }
  const paymentUrl = typeof body.paymentUrl === 'string' ? body.paymentUrl : null;
  return { cookie: line.slice(0, line.indexOf(';')), page: fakePageOf(paymentUrl) };
}

describe('the gateway’s post (step 27d)', () => {
  it('reads only the two ids, from a form', async () => {
    const tranId = 'A'.repeat(20);
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId, val_id: ' V1 ' }))).toEqual({
      tranId,
      valId: 'V1',
    });
    // Failed and cancelled posts bring an empty val_id
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId, val_id: '' }))).toEqual({
      tranId,
      valId: null,
    });
    expect(await gatewayIds(gatewayPost('/', { tran_id: 'W-000001' }))).toBeNull();
    expect(await gatewayIds(gatewayPost('/', { tran_id: tranId }, 'application/json'))).toBeNull();
  });

  it('settles the try on the return path, then sends the browser to /checkout/paid', async () => {
    const source = createMockSource();
    const { page } = await placeOnline(source);
    const response = await answerGatewayReturn(
      gatewayPost(SHOP_PAYMENT_RETURN_PATH, {
        tran_id: page.tranId,
        val_id: fakeValId(page.tranId, { outcome: 'paid', amount: page.amount }),
      }),
      source,
    );
    // 303: the browser asks /checkout/paid with GET, so a reload never posts the form again
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/checkout/paid');
    // Settled already: a second post changes nothing
    expect(await source.settlePayment({ tranId: page.tranId, valId: null })).toEqual({
      status: 'paid',
    });
  });

  it('still sends the browser on when the post cannot settle anything', async () => {
    const source = createMockSource();
    for (const fields of [{ tran_id: 'A'.repeat(20) }, { nothing: 'here' }]) {
      const response = await answerGatewayReturn(
        gatewayPost(SHOP_PAYMENT_RETURN_PATH, fields),
        source,
      );
      expect(response.status).toBe(303);
    }
  });

  it('answers the gateway’s notice for the gateway', async () => {
    const source = createMockSource();
    const { page } = await placeOnline(source);
    const paid = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, {
        tran_id: page.tranId,
        val_id: fakeValId(page.tranId, { outcome: 'paid', amount: page.amount }),
      }),
      source,
    );
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ status: 'paid' });
    const unknown = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, { tran_id: 'B'.repeat(20) }),
      source,
    );
    expect(unknown.status).toBe(404);
    const broken = await answerGatewayNotice(gatewayPost(SHOP_PAYMENT_NOTICE_PATH, {}), source);
    expect(broken.status).toBe(400);
  });

  it('answers 500 when the source is down, so the gateway posts again', async () => {
    const down: ShopSource = {
      ...createMockSource(),
      settlePayment: () => Promise.reject(new Error('API down')),
    };
    const response = await answerGatewayNotice(
      gatewayPost(SHOP_PAYMENT_NOTICE_PATH, { tran_id: 'C'.repeat(20) }),
      down,
    );
    expect(response.status).toBe(500);
  });
});

describe('the buttons on /checkout/paid (step 27d)', () => {
  it('opens a new page with "Try again", and refuses after the third try', async () => {
    const source = createMockSource();
    const { cookie, page } = await placeOnline(source);
    const second = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    const { paymentUrl } = shopPaymentRetrySchema.parse(await second.json());
    // A new try: its own transaction id
    expect(paymentUrl).toContain('/checkout/fake-gateway?');
    expect(paymentUrl).not.toContain(page.tranId);

    await answerRetryPayment(withCookie('/api/payments/retry', cookie), source, ORIGIN);
    const fourth = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(fourth.status).toBe(422);
    expect(await fourth.json()).toMatchObject({ code: 'shop_payment_tries_used' });
  });

  it('turns the order into Cash on Delivery and keeps the cookie for the verify page', async () => {
    const source = createMockSource();
    const { cookie } = await placeOnline(source);
    const response = await answerPayOnDelivery(withCookie('/api/payments/cod', cookie), source);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ next: 'verify', resendInSeconds: 45 });
    expect(response.headers.getSetCookie()).toEqual([]);
    // "Try again" is over for it
    const retry = await answerRetryPayment(
      withCookie('/api/payments/retry', cookie),
      source,
      ORIGIN,
    );
    expect(retry.status).toBe(409);
  });

  it('needs the checkout cookie', async () => {
    const source = createMockSource();
    const answers = [
      (request: Request) => answerRetryPayment(request, source, ORIGIN),
      (request: Request) => answerPayOnDelivery(request, source),
    ];
    for (const answer of answers) {
      const response = await answer(withCookie('/api/payments/x', null));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'shop_payment_no_order' });
    }
  });
});
```

```ts
import { SHOP_PAYMENT_NOTICE_PATH, SHOP_PAYMENT_RETURN_PATH } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { crossSiteForbidden, isForbiddenCrossSite } from './origin-check';

const SHOP = 'https://nirvor.omnivosoft.com';

// A request as a browser sends it. `site` is Sec-Fetch-Site, `origin` the Origin header
function request(
  path: string,
  {
    method = 'POST',
    type = 'application/x-www-form-urlencoded',
    site,
    origin,
  }: { method?: string; type?: string | null; site?: string; origin?: string } = {},
): [Request, URL] {
  const headers = new Headers();
  if (type !== null) headers.set('Content-Type', type);
  if (site !== undefined) headers.set('Sec-Fetch-Site', site);
  if (origin !== undefined) headers.set('Origin', origin);
  const url = new URL(path, SHOP);
  return [new Request(url, { method, headers }), url];
}

describe('the origin check (step 27d)', () => {
  it('refuses a form another site posts, as Astro did', () => {
    expect(isForbiddenCrossSite(...request('/track', { site: 'cross-site' }))).toBe(true);
    expect(
      isForbiddenCrossSite(
        ...request('/api/orders/resend', { type: 'text/plain', site: 'cross-site' }),
      ),
    ).toBe(true);
    // Another tenant's shop on the same domain is another site for this one
    expect(isForbiddenCrossSite(...request('/track', { site: 'same-site' }))).toBe(true);
    // No Content-Type at all is a form too (a body-less post)
    expect(
      isForbiddenCrossSite(...request('/api/payments/retry', { type: null, site: 'cross-site' })),
    ).toBe(true);
    // Older Safari: no Sec-Fetch-Site, so Origin decides
    expect(isForbiddenCrossSite(...request('/track', { origin: 'https://evil.example' }))).toBe(
      true,
    );
  });

  it('lets this shop’s own forms, JSON, safe methods and servers through', () => {
    expect(isForbiddenCrossSite(...request('/track', { site: 'same-origin' }))).toBe(false);
    expect(isForbiddenCrossSite(...request('/track', { site: 'none' }))).toBe(false);
    expect(isForbiddenCrossSite(...request('/track', { origin: SHOP }))).toBe(false);
    // JSON needs a CORS preflight first, which the shop never allows
    expect(
      isForbiddenCrossSite(
        ...request('/api/orders', { type: 'application/json', site: 'cross-site' }),
      ),
    ).toBe(false);
    expect(
      isForbiddenCrossSite(...request('/track', { method: 'GET', site: 'cross-site', type: null })),
    ).toBe(false);
    // curl or a server: no browser, no cookie to protect
    expect(isForbiddenCrossSite(...request('/track'))).toBe(false);
  });

  it('lets the gateway post to its two paths, and only those exact paths', () => {
    for (const path of [SHOP_PAYMENT_RETURN_PATH, SHOP_PAYMENT_NOTICE_PATH]) {
      expect(isForbiddenCrossSite(...request(path, { site: 'cross-site' }))).toBe(false);
      expect(
        isForbiddenCrossSite(...request(path, { origin: 'https://sandbox.sslcommerz.com' })),
      ).toBe(false);
    }
    expect(
      isForbiddenCrossSite(...request(`${SHOP_PAYMENT_RETURN_PATH}/`, { site: 'cross-site' })),
    ).toBe(true);
    expect(isForbiddenCrossSite(...request('/checkout/pay', { site: 'cross-site' }))).toBe(true);
  });

  it('answers 403 with Astro’s words', async () => {
    const response = crossSiteForbidden(new Request(SHOP, { method: 'POST' }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Cross-site POST form submissions are forbidden');
  });
});
```

```ts
import { describe, expect, it } from 'vitest';

import { isCodeWait, paymentUrlOf } from './payment';

describe('paymentUrlOf (step 27d)', () => {
  it('believes an http(s) address', () => {
    const page = 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde123';
    expect(paymentUrlOf({ paymentUrl: page })).toBe(page);
    expect(paymentUrlOf({ paymentUrl: 'http://nirvor.localhost:4321/checkout/fake-gateway' })).toBe(
      'http://nirvor.localhost:4321/checkout/fake-gateway',
    );
    expect(paymentUrlOf({ paymentUrl: null })).toBeNull();
  });

  it('refuses anything that could leave the shop for a script or another site', () => {
    expect(paymentUrlOf({ paymentUrl: 'javascript:alert(1)' })).toBeUndefined();
    // A path has no protocol of its own: new URL() refuses it
    expect(paymentUrlOf({ paymentUrl: '/checkout/fake-gateway' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: '//evil.example/pay' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: 'not a url' })).toBeUndefined();
    expect(paymentUrlOf({ paymentUrl: 42 })).toBeUndefined();
    expect(paymentUrlOf({ code: 'internal_error' })).toBeUndefined();
    expect(paymentUrlOf(null)).toBeUndefined();
  });
});

describe('isCodeWait', () => {
  it('knows the verify page’s answer', () => {
    expect(isCodeWait({ next: 'verify', maskedPhone: '+880 17•• ••• 356' })).toBe(true);
    expect(isCodeWait({ next: 'pay' })).toBe(false);
    expect(isCodeWait('verify')).toBe(false);
  });
});
```

```diff
@@ -71,11 +71,15 @@ describe('shop imports', () => {
     // may import that one module, like an API route. Named page by page, not "any page": a page
     // has <script>s too, and the rule should stay as narrow as what needs it
     // Step 26f.5: the middleware answers /api/* for a host with no shop with problem JSON, like
-    // the routes, so it may import server/problem.ts. It runs only on the server
+    // the routes, so it may import server/problem.ts. It runs only on the server.
+    // Step 27d: the middleware runs the origin check (server/origin-check.ts), and the gateway's
+    // return path is a route outside pages/api/ (it is SHOP_PAYMENT_RETURN_PATH, on /checkout)
     const pageMay = (path: string, name: string) =>
       (path.startsWith('./pages/') && name.endsWith('/server/cookies')) ||
       (path === './pages/track.astro' && name.endsWith('/server/track')) ||
-      (path === './middleware.ts' && name.endsWith('/server/problem'));
+      (path === './middleware.ts' && name.endsWith('/server/problem')) ||
+      (path === './middleware.ts' && name.endsWith('/server/origin-check')) ||
+      (path === './pages/checkout/pay/return.ts' && name.endsWith('/server/payments'));
     const offenders = Object.entries(files)
       .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
       .filter(([path, source]) =>
```

The middleware may import the origin check, and the return path is a route outside `pages/api/`, so it may import
`server/payments.ts`.

```ts
import { expect, test, type Page } from '@playwright/test';

import { expectNoSideScroll } from './helpers.js';

// Step 27d: paying online in the test shop, whose gateway is the fake one (decision 8): its page is
// the shop's own /checkout/fake-gateway, and its buttons post to the return path as SSLCommerz
// posts. The unit tests check the order book and the routes; this checks that the checkout, the
// gateway's page, /checkout/paid, the verify page and the dialog hand over to each other, and that
// a post from another site reaches the return path with the shopper's order (decision 2).

const SHAMPOO = {
  slug: 'himalaya-anti-dandruff-shampoo-180ml',
  name: 'Himalaya Anti-Dandruff Soothing & Moisturizing Shampoo',
};

// Two shampoos (৳229 each, over the shop's ৳300 minimum) and the checkout filled in for Pay online, as shopping.e2e.ts fills it. Its own
// phone per test: nothing here counts phones, but it keeps each test's orders apart in the book
async function checkoutOnline(page: Page, phone: string): Promise<void> {
  await page.goto(`/p/${SHAMPOO.slug}`);
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.goto('/checkout');
  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
  await expect(page.getByRole('main').locator('form')).not.toHaveAttribute('inert');
  await page.getByRole('textbox', { name: 'Full Name' }).fill('Nusrat Jahan');
  await page.getByRole('textbox', { name: 'Mobile Number' }).fill(phone);
  await page.getByRole('textbox', { name: 'Delivery Address' }).fill('House 12, Road 5, Dhanmondi');
  await page.getByRole('radio', { name: 'Inside Dhaka — ৳80' }).check();
  await page.getByText('Pay online', { exact: true }).click();
  // The hint says where the money is taken, before the button takes the shopper there
  await expect(page.getByText('You pay on SSLCommerz’s page with bKash')).toBeVisible();
  await page
    .getByRole('checkbox', { name: 'I agree with the Terms and Conditions' })
    .press('Space');
  await expect(page.getByRole('main')).toContainText('Total৳538');
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?tranId=[A-Z0-9]{20}&amount=538/);
}

test('Pay online: the payment page, then "Order Confirmed" and the order', async ({ page }) => {
  await checkoutOnline(page, '01786120356');
  await expect(page.getByRole('heading', { name: 'Test payment' })).toBeVisible();
  await expect(page.getByText('This is a test page, not SSLCommerz.')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Pay ৳538' }).click();

  // The return path's 303 lands here; the dialog opens over the page, and the cart is empty
  await expect(page).toHaveURL('/checkout/paid');
  const dialog = page.getByRole('dialog', { name: 'Order Confirmed' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('01786 120356');
  await expect(page.getByRole('button', { name: 'Cart, empty' })).toBeAttached();
  await expectNoSideScroll(page);
  await dialog.getByRole('link', { name: 'View Order Details' }).click();
  await expect(page).toHaveURL(/\/order\/W-\d{6}$/);
  await expect(page.getByRole('main')).toContainText('Paid online');

  // The order is done: /checkout/paid has nothing to show this browser any more
  await page.goto('/checkout/paid');
  await expect(page).toHaveURL('/checkout');
});

test('a refused payment, "Try again", then "Pay on delivery" with the phone code', async ({
  page,
}) => {
  await checkoutOnline(page, '01711284519');
  await page.getByRole('button', { name: 'Fail the payment' }).click();
  await expect(page).toHaveURL('/checkout/paid');
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'The payment did not go through' })).toBeVisible();
  await expect(main).toContainText('Your order for ৳538 is still here');
  await expect(main).toContainText('You can try 2 more times.');
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?/);
  await page.getByRole('button', { name: 'Cancel the payment' }).click();
  await expect(page.getByRole('heading', { name: 'The payment was cancelled' })).toBeVisible();
  await expect(main).toContainText('You can try 1 more time.');

  // Back from the third page without pressing anything: "not finished", and no tries left
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/checkout\/fake-gateway\?/);
  await page.goBack();
  await page.goto('/checkout/paid');
  await expect(page.getByRole('heading', { name: 'The payment is not finished' })).toBeVisible();
  await expect(main).toContainText('You have used all three tries to pay online.');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Pay on delivery instead' }).click();
  await expect(page).toHaveURL('/checkout/verify');
  await page.getByRole('textbox', { name: '6-digit code' }).fill('123456');
  await page.getByRole('button', { name: 'Confirm Order' }).click();
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();
});

test('the gateway’s post from its own site reaches the order, and no other path takes one', async ({
  page,
  baseURL,
}) => {
  await checkoutOnline(page, '01911223344');
  // The fake page's own form, copied onto another site: what SSLCommerz's page does
  const form = page.locator('form');
  const tranId = await form.locator('input[name="tran_id"]').inputValue();
  const valId = await page.getByRole('button', { name: 'Pay ৳538' }).getAttribute('value');
  const gateway = 'http://gateway.test';
  await page.route(`${gateway}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Gateway</title>
        <form method="post" action="${String(baseURL)}/checkout/pay/return">
          <input name="tran_id" value="${tranId}"><input name="val_id" value="${String(valId)}">
          <input name="status" value="VALID"><button>Back to the shop</button>
        </form>
        <form method="post" action="${String(baseURL)}/track">
          <input name="phone" value="01911223344"><button>Post to the shop</button>
        </form>`,
    }),
  );
  await page.goto(`${gateway}/pay`);
  await page.getByRole('button', { name: 'Back to the shop' }).click();
  // The shop's SameSite=Lax cookie is not sent with this cross-site POST, so the return path
  // settles by the transaction id; the 303's GET does bring the cookie
  await expect(page).toHaveURL('/checkout/paid');
  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();

  // Any other form from that site is refused, as Astro's own check refused it
  await page.goto(`${gateway}/pay`);
  const [response] = await Promise.all([
    page.waitForResponse(`${String(baseURL)}/track`),
    page.getByRole('button', { name: 'Post to the shop' }).click(),
  ]);
  expect(response.status()).toBe(403);
});

test('the fake gateway’s page needs a try’s address', async ({ page }) => {
  const response = await page.goto('/checkout/fake-gateway?tranId=abc&amount=1');
  expect(response?.status()).toBe(404);
});
```

- **Two shampoos**: the test shop's minimum order is ৳300, and one shampoo is ৳229.
- **The third test** serves a page for `http://gateway.test` from Playwright's router: a real other site to the
  browser. Its form posts to the return path as SSLCommerz's page does. The browser does not send the `SameSite=Lax`
  cookie with that POST, so the test proves decision 58: the return path settles by the id, and the 303's GET brings
  the cookie. The same page's form to `/track` gets 403, so the origin check still works for every other path.

```diff
@@ -192,19 +192,6 @@ test('the code page says when a code expired and when no more codes can come', a
   await expect(page.getByRole('link', { name: 'Back to checkout' })).toBeVisible();
 });
 
-test('Mobile Banking needs no phone code in the test shop', async ({ page }) => {
-  await page.goto(`/p/${SHAMPOO.slug}`);
-  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
-  await page.goto('/checkout');
-  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
-  await fillDetails(page);
-  await page.getByText('Mobile Banking', { exact: true }).click();
-  await page.getByRole('button', { name: 'Confirm Order' }).click();
-  // Straight to the dialog, over the checkout page: the mock asks no code for Mobile Banking
-  await expect(page.getByRole('dialog', { name: 'Order Confirmed' })).toBeVisible();
-  await expect(page).toHaveURL('/checkout');
-});
-
 test('nothing typed into the checkout before its script runs is lost', async ({ page }) => {
   await page.goto(`/p/${SHAMPOO.slug}`);
   await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
```

```diff
@@ -21,7 +21,7 @@ test.describe('a tracking link', () => {
 
     const main = page.getByRole('main');
     await expect(main).toContainText(DELIVERED.orderNo);
-    await expect(main).toContainText('Paid with Mobile Banking.');
+    await expect(main).toContainText('Paid online.');
     // The order's road reads top to bottom, oldest first; a parcel's events newest first
     // (decision 23), and the parcel that delivered comes before the cancelled booking
     const timeline = page.getByRole('list', { name: 'Order status' }).getByRole('listitem');
@@ -159,6 +159,6 @@ test.describe('the /track form', () => {
     ).toBeVisible();
     await page.getByRole('link', { name: `Tracking link of ${DELIVERED.orderNo}` }).click();
     await expect(page).toHaveURL(`/t/${DELIVERED.token}`);
-    await expect(page.getByRole('main')).toContainText('Paid with Mobile Banking.');
+    await expect(page.getByRole('main')).toContainText('Paid online.');
   });
 });
```

The Mobile Banking test is gone (payments.e2e.ts tests Pay online), and the demo order's line says "Paid online."

### The ERP's mock API

```diff
@@ -1,7 +1,11 @@
 import {
   type ErrorCode,
+  type PaymentGatewayMode,
+  type PaymentGatewayProvider,
+  type PaymentGatewayTestProblem,
   type ShopCouponRule,
   type ShopPaymentMethod,
+  type ShopPaymentStatus,
   type ShopTextPageSlug,
   slugFromName,
   STOREFRONT_DEFAULT_THEME,
@@ -161,6 +165,40 @@ export interface MockShopOrder {
   invoiceId: string | null;
   salesReturnId: string | null;
   documentError: ErrorCode | null;
+  // Step 27d: the order's visits to the payment page, oldest first (27d.2's storefront_payments).
+  // Empty for a Cash on Delivery order that never tried to pay online
+  payments: MockShopPayment[];
+  version: number;
+  updatedAt: string;
+}
+
+// Step 27d: one try, as the API's row keeps it. The receipt is kept by id, like the order's other
+// documents, and looked up on read
+export interface MockShopPayment {
+  id: string;
+  tranId: string;
+  status: ShopPaymentStatus;
+  amount: string;
+  startedAt: string;
+  settledAt: string | null;
+  cardType: string | null;
+  bankTranId: string | null;
+  storeAmount: string | null;
+  receiptId: string | null;
+  receiptError: ErrorCode | null;
+}
+
+// Step 27d: the shop's SSLCommerz account, as the API's storefront_payment_gateways row keeps it.
+// The mock keeps the password in plain text: it has no key to seal it with, and it never answers it
+// (storefront-payment-data.ts → toGateway)
+export interface MockGateway {
+  provider: PaymentGatewayProvider;
+  storeId: string;
+  mode: PaymentGatewayMode;
+  password: string;
+  moneyAccountId: string;
+  feeAccountId: string;
+  lastTest: { at: string; problem: PaymentGatewayTestProblem | null } | null;
   version: number;
   updatedAt: string;
 }
@@ -195,6 +233,8 @@ export interface MockStorefront {
   orders: MockShopOrder[];
   // Step 27c: the shop's coupons, archived ones too, in the order they were made
   coupons: MockCoupon[];
+  // Step 27d: null until the Online payment card is saved the first time
+  gateway: MockGateway | null;
 }
 
 export function emptyStorefront(): MockStorefront {
@@ -212,6 +252,7 @@ export function emptyStorefront(): MockStorefront {
     pages: new Map(),
     orders: [],
     coupons: [],
+    gateway: null,
   };
 }
 
@@ -292,7 +333,11 @@ const POLO_SECTIONS: StorefrontSection[] = [
 export function seedStorefront(data: WorkspaceData, garments: boolean): void {
   if (!garments) return;
   const main = data.stock.warehouses.find((place) => place.code === 'MAIN');
-  const payments: ShopPaymentMethod[] = ['cod', 'online'];
+  // Step 27d: Cash on Delivery only. Pay online needs the Online payment card saved first (the API
+  // refuses it otherwise, storefront_online_not_ready), and a new shop has not connected SSLCommerz
+  // yet. The shop orders' seed connects it (storefront-payment-data.ts → seedGateway), because its
+  // orders were paid online
+  const payments: ShopPaymentMethod[] = ['cod'];
   const logo = seedPicture(data, drawnLogo(), { width: 400, height: 400 }, 'Rahman Fashion logo');
   data.storefront.shop = {
     subdomain: 'rahman-fashion',
```

The mock keeps the password in plain text: it has no key to seal it with, and it never answers it. The shop takes
Cash on Delivery only (decision 65).

```diff
@@ -882,7 +882,14 @@ const RECEIPT_CODES = { invoice: 'receipt_invoice_invalid', over: 'receipt_over_
 // Saved = posted: numbered, booked (Dr the money account / Cr Accounts receivable with the
 // customer), then applied. The handler runs it in a transaction(): a refused allocation leaves no
 // receipt and no entry.
-export function createReceipt(data: WorkspaceData, input: ReceiptInput): MockReceipt {
+// Step 27d: `fee` is the gateway's fee of a shop order paid online (the API's createForShop): the
+// money account gets what the gateway pays out, and the fee goes to its expense account, in the
+// receipt's own entry, so a void reverses the fee too
+export function createReceipt(
+  data: WorkspaceData,
+  input: ReceiptInput,
+  fee: { accountId: string; amount: string } | null = null,
+): MockReceipt {
   const customer = customerOf(data, input.customerId, null);
   assertBranch(data, input.branchId);
   // Exactly the list the form offers (contracts' moneyAccountIds)
@@ -901,7 +908,10 @@ export function createReceipt(data: WorkspaceData, input: ReceiptInput): MockRec
       date: input.date,
       narration: `Money receipt ${number}`,
       lines: [
-        side(input.accountId, input.branchId, null, { debit: amount }),
+        side(input.accountId, input.branchId, null, {
+          debit: fee === null ? amount : subtractMoney(amount, fee.amount),
+        }),
+        ...(fee === null ? [] : [side(fee.accountId, input.branchId, null, { debit: fee.amount })]),
         side(accounts.receivable, input.branchId, customer.id, { credit: amount }),
       ],
     },
```

Decision 66. `fee` defaults to `null`, so every other caller of `createReceipt()` is unchanged.

```ts
import {
  addMoney,
  compareMoney,
  type CreateStorefrontPaymentGatewayInput,
  type ErrorCode,
  isZeroMoney,
  moneyAccountIds,
  type PaymentMethod,
  percentOfMoney,
  type ShopPaymentMethod,
  type StorefrontAccountChoice,
  type StorefrontOrderPayment,
  type StorefrontPaymentGateway,
  type StorefrontPaymentSetup,
  subtractMoney,
  sumMoney,
  todayIn,
  type UpdateStorefrontPaymentGatewayInput,
} from '@omnivo/contracts';

import {
  allocateReceipt,
  createReceipt,
  dueOn,
  findInvoice,
  findReceipt,
  refundedFrom,
} from './invoice-data';
import { MockProblem } from './mock';
import { findOrder } from './sales-document-data';
import { branchOf } from './stock-data';
import type { MockGateway, MockShopOrder, MockShopPayment } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27d: the shop's online payment in the ERP, with the API's rules: the Online payment card
// (apps/api/src/storefront/admin/payment-gateway.service.ts) and the money receipt each paid try
// makes (storefront/orders/payment-receipts.ts). The mock has no gateway to ask: its orders' tries
// are seeded as the API would have left them, and "Test connection" answers like the API's
// FakeGateway (the store ids fake_rejected and fake_unreachable).
//
// This file imports no other storefront mock file but the seed's types: storefront-data.ts (the
// settings' Pay online check) and storefront-order-data.ts (the order's view, Delivered) import it,
// and workspace-data.ts seeds through them. The audit rows are the handlers' (handlers.ts).

function now(): string {
  return new Date().toISOString();
}

// 422, as the API answers these (storefront-data.ts's own fieldProblem answers 409)
function fieldProblem(code: ErrorCode, field: string): MockProblem {
  return new MockProblem(422, code, { [field]: [code] });
}

function notSetUp(): MockProblem {
  return new MockProblem(404, 'storefront_gateway_not_set_up');
}

// ---------------------------------------------------------------------------------------------
// The Online payment card

// What the two selects offer, read like the API's chartOf(): a money account is a posting account
// that holds money (itself or a group above it); a fee account an active expense posting account
function chartOf(data: WorkspaceData): {
  moneyAccounts: StorefrontAccountChoice[];
  feeAccounts: StorefrontAccountChoice[];
} {
  const accounts = [...data.accounts].sort((a, b) => a.code.localeCompare(b.code));
  const money = moneyAccountIds(accounts);
  const choice = ({ id, code, name }: (typeof accounts)[number]) => ({ id, code, name });
  return {
    moneyAccounts: accounts.filter((account) => money.has(account.id)).map(choice),
    feeAccounts: accounts
      .filter(
        (account) => account.type === 'expense' && !account.isGroup && account.archivedAt === null,
      )
      .map(choice),
  };
}

// storefront_online_ready(): the gateway is saved and both its accounts still fit
export function onlineReady(data: WorkspaceData): boolean {
  const gateway = data.storefront.gateway;
  if (gateway === null) return false;
  const chart = chartOf(data);
  return (
    chart.moneyAccounts.some((account) => account.id === gateway.moneyAccountId) &&
    chart.feeAccounts.some((account) => account.id === gateway.feeAccountId)
  );
}

// The shop's settings: Pay online may be ticked only once the card is ready. Only a newly ticked
// box is checked, so a shop whose account was archived since can still save its other settings
// (and untick it)
export function checkOnline(
  data: WorkspaceData,
  methods: readonly ShopPaymentMethod[],
  before: readonly ShopPaymentMethod[],
): void {
  if (!methods.includes('online') || before.includes('online') || onlineReady(data)) return;
  throw fieldProblem('storefront_online_not_ready', 'paymentMethods');
}

// Never the password: the card shows only that one is saved
export function toGateway(data: WorkspaceData, gateway: MockGateway): StorefrontPaymentGateway {
  return {
    provider: gateway.provider,
    storeId: gateway.storeId,
    mode: gateway.mode,
    moneyAccountId: gateway.moneyAccountId,
    feeAccountId: gateway.feeAccountId,
    ready: onlineReady(data),
    lastTest: gateway.lastTest,
    version: gateway.version,
    updatedAt: gateway.updatedAt,
  };
}

export function gatewaySetup(data: WorkspaceData): StorefrontPaymentSetup {
  const chart = chartOf(data);
  const gateway = data.storefront.gateway;
  return {
    gateway: gateway === null ? null : toGateway(data, gateway),
    moneyAccounts: chart.moneyAccounts,
    feeAccounts: chart.feeAccounts,
  };
}

function checkAccounts(
  data: WorkspaceData,
  input: { moneyAccountId: string; feeAccountId: string },
) {
  const chart = chartOf(data);
  if (!chart.moneyAccounts.some((account) => account.id === input.moneyAccountId)) {
    throw fieldProblem('storefront_gateway_money_account_invalid', 'moneyAccountId');
  }
  if (!chart.feeAccounts.some((account) => account.id === input.feeAccountId)) {
    throw fieldProblem('storefront_gateway_fee_account_invalid', 'feeAccountId');
  }
}

// The audit's view, as the API's snapshot(): never the password
export function gatewaySnapshot(gateway: MockGateway) {
  return {
    storeId: gateway.storeId,
    mode: gateway.mode,
    moneyAccount: gateway.moneyAccountId,
    feeAccount: gateway.feeAccountId,
  };
}

export function createGateway(
  data: WorkspaceData,
  input: CreateStorefrontPaymentGatewayInput,
): MockGateway {
  if (data.storefront.gateway !== null) {
    throw new MockProblem(409, 'storefront_gateway_set_up_already');
  }
  checkAccounts(data, input);
  const gateway: MockGateway = {
    provider: 'sslcommerz',
    storeId: input.storeId,
    mode: input.mode,
    password: input.password,
    moneyAccountId: input.moneyAccountId,
    feeAccountId: input.feeAccountId,
    lastTest: null,
    version: 1,
    updatedAt: now(),
  };
  data.storefront.gateway = gateway;
  return gateway;
}

// An empty password keeps the saved one. A change to what the last test reached (the store id,
// the password, the mode) clears that test: it said something about the old values
export function updateGateway(
  data: WorkspaceData,
  input: UpdateStorefrontPaymentGatewayInput,
): { before: MockGateway; after: MockGateway; passwordChanged: boolean } {
  const before = data.storefront.gateway;
  if (before === null) throw notSetUp();
  if (before.version !== input.version) throw new MockProblem(409, 'version_conflict');
  checkAccounts(data, input);
  const passwordChanged = input.password !== '' && input.password !== before.password;
  const reach = passwordChanged || input.storeId !== before.storeId || input.mode !== before.mode;
  const after: MockGateway = {
    ...before,
    storeId: input.storeId,
    mode: input.mode,
    password: passwordChanged ? input.password : before.password,
    moneyAccountId: input.moneyAccountId,
    feeAccountId: input.feeAccountId,
    lastTest: reach ? null : before.lastTest,
    version: before.version + 1,
    updatedAt: now(),
  };
  data.storefront.gateway = after;
  return { before, after, passwordChanged };
}

// "Test connection", as the API's FakeGateway answers it: two store ids stand for SSLCommerz on a
// bad day, every other one works. A refusal is an answer, kept on the card, not an error. The test
// is not a change of the account, so its version stays
export function testGateway(data: WorkspaceData): MockGateway {
  const gateway = data.storefront.gateway;
  if (gateway === null) throw notSetUp();
  const problem =
    gateway.storeId === 'fake_rejected'
      ? 'rejected'
      : gateway.storeId === 'fake_unreachable'
        ? 'unreachable'
        : null;
  gateway.lastTest = { at: now(), problem };
  return gateway;
}
```

- **The imports**: this file imports no other storefront mock file but the seed's types. `storefront-data.ts` and
  `storefront-order-data.ts` import it, and `workspace-data.ts` seeds through them, so an import back would be a
  circle. The audit rows are the handlers', for the same reason.
- **`fieldProblem()` answers 422**, as the API answers these codes (`storefront-data.ts`'s own helper answers 409).
- **`chartOf()` and `onlineReady()`** read the chart the way the API's `chartOf()` and `storefront_online_ready()` do,
  so the card's `ready` and the settings' check agree.
- **`checkOnline()`** checks only a newly ticked box, as the API does: a shop whose account was archived since can
  still save its other settings.
- **`updateGateway()`**: a new password, store id or mode clears the last test, because it said something about the
  old values. The accounts are not part of the test.
- **`testGateway()`** answers like the API's `FakeGateway`, and does not move the version: a test is not a change.

```ts
// ---------------------------------------------------------------------------------------------
// The order's tries and their receipts

export function toPayment(data: WorkspaceData, payment: MockShopPayment): StorefrontOrderPayment {
  const receipt =
    payment.receiptId === null
      ? undefined
      : data.billing.receipts.find((item) => item.id === payment.receiptId);
  return {
    id: payment.id,
    tranId: payment.tranId,
    status: payment.status,
    amount: payment.amount,
    startedAt: payment.startedAt,
    settledAt: payment.settledAt,
    cardType: payment.cardType,
    bankTranId: payment.bankTranId,
    storeAmount: payment.storeAmount,
    receipt: receipt === undefined ? null : { id: receipt.id, number: receipt.number },
    receiptError: payment.receiptError,
  };
}

// The API's receiptMethodOf(): SSLCommerz's card_type starts with the brand ("BKASH-BKash",
// "VISA-Dutch Bangla"); a wallet or a card, else a bank transfer (internet banking)
const WALLETS = ['BKASH', 'NAGAD', 'ROCKET', 'UPAY', 'MCASH', 'TCASH', 'DBBLMOBILEB', 'OKWALLET'];
const CARDS = ['VISA', 'MASTER', 'AMEX', 'UNIONPAY', 'NEXUS', 'DBBL', 'QCASH'];

function receiptMethodOf(cardType: string | null): PaymentMethod {
  const brand = (cardType ?? '').split('-')[0]?.toUpperCase().replace(/\s+/g, '') ?? '';
  if (WALLETS.some((wallet) => brand.startsWith(wallet))) return 'mobile_wallet';
  if (CARDS.some((card) => brand.startsWith(card))) return 'card';
  return 'bank_transfer';
}

// What is left of a receipt to apply: its amount less what invoices took and refunds paid back
function leftOf(data: WorkspaceData, receiptId: string): string {
  const receipt = findReceipt(data, receiptId);
  const applied = sumMoney(receipt.allocations.map((allocation) => allocation.amount));
  return subtractMoney(
    subtractMoney(receipt.amount, applied),
    refundedFrom(data, 'receipt', receiptId),
  );
}

// Applies the paid tries' advances to the order's invoice, the oldest first, each as much as the
// invoice still owes. A second payment finds nothing left and stays an advance (decision 6)
export function applyPaymentsToInvoice(
  data: WorkspaceData,
  order: MockShopOrder,
  invoiceId: string,
): void {
  const invoice = findInvoice(data, invoiceId);
  for (const payment of order.payments) {
    if (payment.receiptId === null) continue;
    const due = dueOn(data, invoice);
    if (!(compareMoney(due, '0') > 0)) return;
    const left = leftOf(data, payment.receiptId);
    const amount = compareMoney(left, due) < 0 ? left : due;
    if (!(compareMoney(amount, '0') > 0)) continue;
    const receipt = findReceipt(data, payment.receiptId);
    allocateReceipt(data, receipt, [...receipt.allocations, { invoiceId, amount }]);
  }
}

// One paid try's posted receipt (the API's makeIn): the sales order's customer and branch, the
// gateway's money account, the bank's own number as the reference, the fee to the fee account.
// Throws the receipt's own refusal, which the caller keeps on the try
function makeReceiptIn(
  data: WorkspaceData,
  order: MockShopOrder,
  payment: MockShopPayment,
  at: string,
): string {
  const gateway = data.storefront.gateway;
  if (gateway === null || order.salesOrderId === null) {
    throw new MockProblem(409, 'storefront_order_step_invalid');
  }
  const salesOrder = findOrder(data, order.salesOrderId);
  const branchId = branchOf(data, salesOrder.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
  const fee = subtractMoney(payment.amount, payment.storeAmount ?? payment.amount);
  const receipt = createReceipt(
    data,
    {
      customerId: salesOrder.customer.id,
      date: todayIn(data.settings.timezone, new Date(at)),
      amount: addMoney(payment.amount, '0'),
      accountId: gateway.moneyAccountId,
      method: receiptMethodOf(payment.cardType),
      reference: [payment.bankTranId ?? payment.tranId, payment.cardType]
        .filter((part) => part !== null)
        .join(' · ')
        .slice(0, 60),
      branchId,
      note: `Paid online for shop order ${order.orderNo} (SSLCommerz ${payment.tranId})`,
      allocations: [],
    },
    isZeroMoney(fee) ? null : { accountId: gateway.feeAccountId, amount: fee },
  );
  payment.receiptId = receipt.id;
  payment.receiptError = null;
  // Paid after it was delivered: the invoice is there already, so the money goes to it now
  if (order.invoiceId !== null) applyPaymentsToInvoice(data, order, order.invoiceId);
  return receipt.id;
}

// The API's makeAll(), once the order has its sales order: every paid try with no receipt and no
// error yet. A refusal is kept on its try, and the others still go
export function makePaymentReceipts(data: WorkspaceData, order: MockShopOrder, at: string): void {
  for (const payment of order.payments) {
    if (payment.status !== 'paid' || payment.receiptId !== null || payment.receiptError !== null) {
      continue;
    }
    try {
      makeReceiptIn(data, order, payment, at);
    } catch (error) {
      if (!(error instanceof MockProblem)) throw error;
      payment.receiptError = error.code;
    }
  }
}

// "Make the receipt" on the order's page (the API's makePaymentReceipt), after the version and
// the step are checked by the caller (storefront-order-data.ts). The receipt's own refusal is kept
// on the try and still answered
export function retryPaymentReceipt(
  data: WorkspaceData,
  order: MockShopOrder,
  paymentId: string,
  at: string = now(),
): string {
  const payment = order.payments.find((item) => item.id === paymentId);
  if (payment === undefined) throw new MockProblem(404, 'not_found');
  if (payment.status !== 'paid' || payment.receiptId !== null || order.salesOrderId === null) {
    throw new MockProblem(409, 'storefront_order_step_invalid');
  }
  try {
    return makeReceiptIn(data, order, payment, at);
  } catch (error) {
    if (error instanceof MockProblem) payment.receiptError = error.code;
    throw error;
  }
}
```

- **`receiptMethodOf()`** is a copy of the API's: the app cannot import API code.
- **`applyPaymentsToInvoice()`** takes the oldest advance first, each as much as the invoice still owes. A second
  payment finds nothing left and stays an advance, which the order page says to refund.
- **`makeReceiptIn()`** follows the API's `makeIn()`: the sales order's customer and branch, the gateway's money
  account, the bank's own number as the reference (cut to the box's 60 characters), and the fee. A receipt made after
  Delivered goes to the invoice at once.
- **`makePaymentReceipts()`** keeps a refusal on its try and goes on with the others, as the API's worker does.

```ts
// ---------------------------------------------------------------------------------------------
// The seed (storefront-order-data.ts → seedShopOrders)

// Rahman Fashion's SSLCommerz sandbox store, saved and tested: the money goes to the Dutch-Bangla
// account (SSLCommerz pays out into it), the fee to Bank charges. Pay online is ticked with it
export function seedGateway(data: WorkspaceData, at: string): void {
  const byCode = (code: string) => data.accounts.find((account) => account.code === code)?.id;
  const moneyAccountId = byCode('1121');
  const feeAccountId = byCode('5410');
  const shop = data.storefront.shop;
  if (moneyAccountId === undefined || feeAccountId === undefined || shop === null) return;
  data.storefront.gateway = {
    provider: 'sslcommerz',
    storeId: 'rahmanfashion_sandbox',
    mode: 'sandbox',
    password: 'rahmanfashion@ssl',
    moneyAccountId,
    feeAccountId,
    lastTest: { at, problem: null },
    version: 1,
    updatedAt: at,
  };
  if (!shop.paymentMethods.includes('online'))
    shop.paymentMethods = [...shop.paymentMethods, 'online'];
}

// A try as the API leaves it. `paid` is SSLCommerz's answer: how the shopper paid and its fee
// (2.5%, as the API's fake gateway keeps)
export function seedTry(
  order: MockShopOrder,
  startedAt: string,
  outcome:
    | { status: 'paid'; cardType: string; bankTranId: string; settledAt: string }
    | { status: 'failed' | 'cancelled'; settledAt: string }
    | { status: 'started' | 'not_opened' },
): MockShopPayment {
  const tranId = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(byte % 36),
  ).join('');
  const paid = outcome.status === 'paid';
  const payment: MockShopPayment = {
    id: crypto.randomUUID(),
    tranId,
    status: outcome.status,
    amount: order.total,
    startedAt,
    settledAt: 'settledAt' in outcome ? outcome.settledAt : null,
    cardType: paid ? outcome.cardType : null,
    bankTranId: paid ? outcome.bankTranId : null,
    storeAmount: paid ? subtractMoney(order.total, percentOfMoney(order.total, '2.5')) : null,
    receiptId: null,
    receiptError: null,
  };
  order.payments.push(payment);
  return payment;
}
```

The seed's store and tries (decision 65). The fee is 2.5% with `percentOfMoney()`, as the API's fake gateway keeps
it, never a JavaScript number.

```diff
@@ -37,6 +37,7 @@ import { MockProblem } from './mock';
 import { pageOf } from './sales-document-data';
 import { balancesOf, findVariant } from './stock-data';
 import { checkDeliveryService, deliveryChoicesOf } from './storefront-order-data';
+import { checkOnline } from './storefront-payment-data';
 import {
   type MockCategory,
   type MockListing,
@@ -210,6 +211,8 @@ export function createShop(
   assertWarehouse(data, input.defaultWarehouseId);
   assertSubdomainFree(input.subdomain);
   checkDeliveryService(data, input.deliveryVariantId);
+  // Step 27d: Pay online needs the Online payment card ready
+  checkOnline(data, input.paymentMethods, []);
   const shop: MockShop = {
     ...fieldsOf(input, []),
     launchedAt: null,
@@ -242,6 +245,7 @@ export function updateShop(
   }
   if (input.subdomain !== before.subdomain) assertSubdomainFree(input.subdomain);
   checkDeliveryService(data, input.deliveryVariantId);
+  checkOnline(data, input.paymentMethods, before.paymentMethods);
   const after: MockShop = {
     ...before,
     ...fieldsOf(input, before.deliveryZones),
```

```diff
@@ -12,6 +12,7 @@ import {
   productInputSchema,
   type SalesLineInput,
   type ShopDeliveryZone,
+  type ShopPaymentMethod,
   type StorefrontImage,
   type StorefrontOrder,
   type StorefrontOrderCounts,
@@ -45,6 +46,14 @@ import {
   saveDelivery,
 } from './sales-document-data';
 import { balancesOf, branchOf, findVariant, postAdjustment, saveAdjustment } from './stock-data';
+import {
+  applyPaymentsToInvoice,
+  makePaymentReceipts,
+  retryPaymentReceipt,
+  seedGateway,
+  seedTry,
+  toPayment,
+} from './storefront-payment-data';
 import {
   type MockCategory,
   type MockListing,
@@ -221,6 +230,8 @@ export function toShopOrder(data: WorkspaceData, order: MockShopOrder): Storefro
     invoice: refOf(data.billing.invoices.find((item) => item.id === order.invoiceId)),
     salesReturn: refOf(data.returns.salesReturns.find((item) => item.id === order.salesReturnId)),
     documentError: order.documentError,
+    // Step 27d
+    payments: order.payments.map((payment) => toPayment(data, payment)),
     version: order.version,
     updatedAt: order.updatedAt,
   };
@@ -422,6 +433,8 @@ export function makeShopSalesOrder(
     version: order.version + 1,
     updatedAt: at,
   });
+  // Step 27d: the paid tries' receipts need the sales order's customer (the API's makeAll)
+  makePaymentReceipts(data, order, at);
   return {
     salesOrder,
     customerId: customer.id,
@@ -431,6 +444,21 @@ export function makeShopSalesOrder(
   };
 }
 
+// Step 27d: "Make the receipt" on a paid try whose receipt failed. The version moves on, so another
+// tab that still shows the error reloads first. The handler calls it outside transaction(): the
+// try's error must stay when the receipt is refused again
+export function makeShopPaymentReceipt(
+  data: WorkspaceData,
+  id: string,
+  paymentId: string,
+  version: number,
+): { order: MockShopOrder; receiptId: string } {
+  const order = lockShopOrder(data, id, version);
+  const receiptId = retryPaymentReceipt(data, order, paymentId);
+  Object.assign(order, { version: order.version + 1, updatedAt: now() });
+  return { order, receiptId };
+}
+
 // "Make the sales order" (decision 1's retry): a refusal is kept on the order, as the handler
 // keeps it, and still answered. The handler calls it outside transaction(): the order's error must
 // stay when the sales order is refused
@@ -690,6 +718,8 @@ export function deliverShopOrder(
   // Never over the limit: it moves the amount from "on order" to "owed" and adds nothing
   postInvoice(data, draft, false);
   move(order, 'delivered', at, { invoiceId: draft.id });
+  // Step 27d (decision 6): the invoice takes the advances of the paid tries
+  applyPaymentsToInvoice(data, order, draft.id);
   return { order, invoiceId: draft.id };
 }
 
@@ -812,6 +842,8 @@ interface OrderSpec {
   lines: { listing: MockListing; quantity: number }[];
   // Minutes ago the code confirmed it; the shopper placed it two minutes before
   confirmed: number;
+  // Step 27d: Cash on Delivery unless it says so
+  paymentMethod?: ShopPaymentMethod;
 }
 
 // The shop's price now (the listing's own, or the variant's, less a running sale)
@@ -863,7 +895,7 @@ function placeOrder(
     phone: spec.phone,
     address: spec.address,
     zoneName: spec.zone.name,
-    paymentMethod: 'cod',
+    paymentMethod: spec.paymentMethod ?? 'cod',
     lines,
     subtotal,
     discount: '0.0000',
@@ -877,6 +909,7 @@ function placeOrder(
     invoiceId: null,
     salesReturnId: null,
     documentError: null,
+    payments: [],
     version: 1,
     updatedAt: confirmed,
   };
@@ -1041,6 +1074,60 @@ function seedAccessories(data: WorkspaceData, warehouseId: string): MockListing[
   ];
 }
 
+// Step 27d: the online tries of the seeded orders, as the API leaves them, so the order page shows
+// each of the Payments card's cases:
+// - W-000001 (delivered): paid with bKash; its receipt was the advance its invoice took
+// - W-000002 (cancelled): a card refused, then paid by Visa; the money has to go back
+// - W-000004 (packed, Cash on Delivery): paid with Nagad after the phone code confirmed it, so the
+//   rider must collect nothing and one of the two is refunded
+// - W-000006 (new): paid twice in two tabs; the second receipt failed (the money account was
+//   archived for a moment) and waits for "Make the receipt"
+function seedTries(
+  delivered: MockShopOrder,
+  cancelled: MockShopOrder,
+  packed: MockShopOrder,
+  twice: MockShopOrder,
+): void {
+  const placed = (order: MockShopOrder) => order.history[0]?.at ?? now();
+  const later = (at: string, minutes: number) =>
+    new Date(Date.parse(at) + minutes * 60_000).toISOString();
+  seedTry(delivered, placed(delivered), {
+    status: 'paid',
+    cardType: 'BKASH-BKash',
+    bankTranId: 'BK7XQ2M4PL',
+    settledAt: confirmedAt(delivered),
+  });
+  seedTry(cancelled, placed(cancelled), {
+    status: 'failed',
+    settledAt: later(placed(cancelled), 1),
+  });
+  seedTry(cancelled, later(placed(cancelled), 1), {
+    status: 'paid',
+    cardType: 'VISA-Dutch Bangla',
+    bankTranId: '2611120042VD',
+    settledAt: confirmedAt(cancelled),
+  });
+  seedTry(packed, placed(packed), {
+    status: 'paid',
+    cardType: 'NAGAD-Nagad',
+    bankTranId: 'NG73LQ9X0A',
+    settledAt: later(confirmedAt(packed), 30),
+  });
+  seedTry(twice, placed(twice), {
+    status: 'paid',
+    cardType: 'BKASH-BKash',
+    bankTranId: 'BK9TR4C2ZE',
+    settledAt: confirmedAt(twice),
+  });
+  const second = seedTry(twice, placed(twice), {
+    status: 'paid',
+    cardType: 'BKASH-BKash',
+    bankTranId: 'BK9TR4C3WD',
+    settledAt: confirmedAt(twice),
+  });
+  second.receiptError = 'receipt_account_invalid';
+}
+
 // Rahman Fashion's orders: one delivered (its invoice waits for the rider's cash), one cancelled
 // before packing, one on its way, one packed, and three new ones. Of the new ones, W-000005 has a
 // line of each kind for the Packed dialog (a batch, a serial, an untracked polo), W-000006 is a
@@ -1052,6 +1139,9 @@ export function seedShopOrders(data: WorkspaceData): void {
   const warehouseId = shop?.defaultWarehouseId ?? null;
   const [inside, outside] = shop?.deliveryZones ?? [];
   if (shop === null || warehouseId === null || !inside || !outside) return;
+  // Step 27d: the shop was paid online, so its SSLCommerz store is saved (before the orders: their
+  // receipts go to its money account)
+  seedGateway(data, minutesAgo(13 * 24 * 60));
   const [attar, watch] = seedAccessories(data, warehouseId);
   const bySlug = (slug: string) => data.storefront.listings.find((item) => item.slug === slug);
   const poloM = bySlug('pique-polo-navy-m');
@@ -1067,7 +1157,13 @@ export function seedShopOrders(data: WorkspaceData): void {
   const hours = (count: number) => count * 60;
   const days = (count: number) => count * 24 * 60;
   const specs: OrderSpec[] = [
-    { ...farhana, zone: inside, lines: [{ listing: poloM, quantity: 2 }], confirmed: days(9) },
+    {
+      ...farhana,
+      zone: inside,
+      lines: [{ listing: poloM, quantity: 2 }],
+      confirmed: days(9),
+      paymentMethod: 'online',
+    },
     {
       name: 'Sabbir Hossain',
       phone: '01819556677',
@@ -1075,6 +1171,7 @@ export function seedShopOrders(data: WorkspaceData): void {
       zone: inside,
       lines: [{ listing: tee, quantity: 1 }],
       confirmed: days(7),
+      paymentMethod: 'online',
     },
     {
       name: 'Tanvir Ahmed',
@@ -1112,6 +1209,7 @@ export function seedShopOrders(data: WorkspaceData): void {
       zone: outside,
       lines: [{ listing: poloL, quantity: 1 }],
       confirmed: 50,
+      paymentMethod: 'online',
     },
     {
       name: 'Shirin Sultana',
@@ -1123,8 +1221,9 @@ export function seedShopOrders(data: WorkspaceData): void {
     },
   ];
   const orders = specs.map((spec, index) => placeOrder(data, index + 1, spec, warehouseId));
-  const [delivered, cancelled, shipped, packed, , , refused] = orders;
-  if (!delivered || !cancelled || !shipped || !packed || !refused) return;
+  const [delivered, cancelled, shipped, packed, , twice, refused] = orders;
+  if (!delivered || !cancelled || !shipped || !packed || !twice || !refused) return;
+  seedTries(delivered, cancelled, packed, twice);
   // The handler made each sales order when the code confirmed the order, except W-000007's
   for (const order of orders) {
     if (order === refused) continue;
```

- **`makeShopSalesOrder()`** makes the paid tries' receipts once the sales order names the customer, like the API's
  `makeAll()` after the sales order.
- **`deliverShopOrder()`** applies the advances to the invoice it posts.
- **`makeShopPaymentReceipt()`** checks the version, then moves it on, so another tab that still shows the error
  reloads first.
- **`seedTries()`** is decision 65. The second try of W-000006 gets its error before its sales order is made, so
  `makePaymentReceipts()` leaves it for "Make the receipt".

```diff
@@ -223,6 +223,7 @@ import {
   deliverShopOrder,
   findShopOrder,
   type MadeSalesOrder,
+  makeShopPaymentReceipt,
   packPlanOf,
   packShopOrder,
   retrySalesOrder,
@@ -231,6 +232,14 @@ import {
   shopOrderPage,
   toShopOrder,
 } from './storefront-order-data';
+import {
+  createGateway,
+  gatewaySetup,
+  gatewaySnapshot,
+  testGateway,
+  toGateway,
+  updateGateway,
+} from './storefront-payment-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -6233,6 +6242,88 @@ export const handlers = [
     }),
   ),
 
+  // Step 27d: "Make the receipt". Not in transaction(): a refusal is kept on the try (its
+  // receiptError) and still answered, as for "Make the sales order"
+  mock(
+    routes.storefrontOrders.makePaymentReceipt,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.makePaymentReceipt.permission);
+      const { id, paymentId } = routes.storefrontOrders.makePaymentReceipt.params.parse(params);
+      const { version } = await readBody(routes.storefrontOrders.makePaymentReceipt.body, request);
+      const { order, receiptId } = makeShopPaymentReceipt(data, id, paymentId, version);
+      record(data, 'receipt.created', 'receipt', receiptId);
+      return reply(routes.storefrontOrders.makePaymentReceipt, toShopOrder(data, order));
+    }),
+  ),
+
+  // --- Step 27d: the Online payment card (storefront-payment-data.ts) ---------------------------
+  // storefront.manage, like the shop's settings. The audit rows never hold the password: a new
+  // one is written as "changed" (the API's snapshot)
+
+  mock(
+    routes.storefrontPayments.getPaymentGateway,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.storefrontPayments.getPaymentGateway, gatewaySetup(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayments.createPaymentGateway,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontPayments.createPaymentGateway.body, request);
+      const gateway = createGateway(data, body);
+      record(
+        data,
+        'storefront_payment_gateway.created',
+        'storefront_payment_gateway',
+        workspace.tenantId,
+        diff({}, { ...gatewaySnapshot(gateway), password: 'changed' }),
+      );
+      return reply(routes.storefrontPayments.createPaymentGateway, toGateway(data, gateway));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayments.updatePaymentGateway,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontPayments.updatePaymentGateway.body, request);
+      const { before, after, passwordChanged } = updateGateway(data, body);
+      record(
+        data,
+        'storefront_payment_gateway.updated',
+        'storefront_payment_gateway',
+        workspace.tenantId,
+        {
+          ...diff(gatewaySnapshot(before), gatewaySnapshot(after)),
+          ...(passwordChanged ? { password: { from: null, to: 'changed' } } : {}),
+        },
+      );
+      return reply(routes.storefrontPayments.updatePaymentGateway, toGateway(data, after));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayments.testPaymentGateway,
+    guarded(async () => {
+      const data = shopData();
+      // A real test waits for SSLCommerz; the button's "Testing…" shows for a moment
+      await delay();
+      const gateway = testGateway(data);
+      record(
+        data,
+        'storefront_payment_gateway.tested',
+        'storefront_payment_gateway',
+        workspace.tenantId,
+        diff({}, { testResult: gateway.lastTest?.problem ?? 'ok' }),
+      );
+      return reply(routes.storefrontPayments.testPaymentGateway, toGateway(data, gateway));
+    }),
+  ),
+
   // --- Step 27c: Shop coupons (storefront-coupon-data.ts) --------------------------------------
   // storefront.manage, like every Storefront route but Shop orders (shopData())
 
```

"Make the receipt" is not inside `transaction()`: a refusal is kept on the try and still answered, as for "Make the
sales order". The audit rows never hold the password: a new one is written as "changed".

### The card's first save

```diff
@@ -39,6 +39,7 @@ import {
 import { useMutation } from '@tanstack/react-query';
 import { useEffect } from 'react';
 import { Controller, useForm } from 'react-hook-form';
+import { z } from 'zod';
 
 import { DocumentNotice } from './document-notice';
 import { ApiRequestError, call } from '../lib/api';
@@ -55,10 +56,12 @@ import { useTimeZone } from '../lib/workspace';
 const FIELDS = ['storeId', 'mode', 'password', 'moneyAccountId', 'feeAccountId'] as const;
 
 // The first save has no version and needs a password. The form keeps one shape for both saves
-// (a version of 0 that the first save leaves out), so this is the create schema with the update
-// schema's version: the same values, the create schema's password rule
+// (a version of 0 that the first save leaves out), so this is the create schema with any whole
+// number there. Not the update schema's version: it is min(1), so the 0 would fail on a box the form
+// does not draw, and "Save gateway" would do nothing and say nothing (27d.7's Playwright test found
+// it). A number, not z.literal(0): both resolvers must give the form one type of values
 const FIRST_SAVE_SCHEMA = createStorefrontPaymentGatewayInputSchema.extend({
-  version: updateStorefrontPaymentGatewayInputSchema.shape.version,
+  version: z.number().int(),
 });
 
 type GatewayStatus = 'notSaved' | 'ready' | 'notReady';
```

27d.6 gave `FIRST_SAVE_SCHEMA` the update schema's `version`, which is `min(1)`. The form holds 0 before the first
save, so the check failed on a field the form does not draw: "Save gateway" did nothing and showed nothing. The
version is any whole number now. Not `z.literal(0)`: both resolvers must give the form one type of values, and a
literal makes the two types differ (the type check says so).

### The ERP's browser tests

```diff
@@ -299,6 +299,61 @@ test('warns before an open shop moves to a new address', async ({ page }) => {
   await expect(page.getByText(/at http:\/\/rahman-outlet\.localhost:4321$/)).toBeVisible();
 });
 
+// Step 27d: the Online payment card (mocks/storefront-payment-data.ts). The test shop takes Cash on
+// Delivery only until the card is saved; its "Test connection" answers like the API's fake gateway
+// (fake_rejected is refused, any other store id works)
+test('connects an SSLCommerz store, tests it, then offers Pay online', async ({ page }) => {
+  await start(page);
+  await openFromNav(page, 'Shop settings');
+  const card = page.getByRole('form', { name: 'Online payment' });
+  await expect(card.getByText('Not set up')).toBeVisible();
+  const online = page.getByRole('checkbox', { name: 'Pay online' });
+  await expect(online).toBeDisabled();
+  await expect(
+    page.getByText('To offer Pay online, save the Online payment card with both of its accounts.'),
+  ).toBeVisible();
+  await expectNoSideScroll(page);
+
+  await card.getByRole('textbox', { name: 'Store ID' }).fill('fake_rejected');
+  await card.getByLabel('Store password').fill('rahman@ssl');
+  await card.getByLabel('Account the money goes into').selectOption({
+    label: '1121 · Dutch-Bangla Bank CD A/C 1234',
+  });
+  await card.getByLabel('Gateway fee account').selectOption({ label: '5410 · Bank charges' });
+  await card.getByRole('button', { name: 'Save gateway' }).click();
+  await toastShown(page, 'Payment gateway saved. Tick Pay online under Payment to offer it.');
+  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
+  await expect(card.getByText('Not tested yet.')).toBeVisible();
+  // The password is never shown again: the box starts empty, and empty keeps it
+  await expect(card.getByLabel('Store password')).toHaveValue('');
+
+  await card.getByRole('button', { name: 'Test connection' }).click();
+  await expect(card.getByText(/^SSLCommerz refused the store ID or the password/)).toBeVisible();
+
+  // The test uses what is saved: while the form has changes, it waits
+  await card.getByRole('textbox', { name: 'Store ID' }).fill('rahmanfashion_sandbox');
+  await expect(
+    card.getByText('Save your changes first. The test uses what is saved.'),
+  ).toBeVisible();
+  await expect(card.getByRole('button', { name: 'Test connection' })).toBeDisabled();
+  await card.getByRole('button', { name: 'Save changes' }).click();
+  await toastShown(page, 'Payment gateway saved');
+  // A new store id makes the old test say nothing
+  await expect(card.getByText('Not tested yet.')).toBeVisible();
+  await card.getByRole('button', { name: 'Test connection' }).click();
+  await expect(card.getByText(/^SSLCommerz accepted the store\. Tested /)).toBeVisible();
+
+  await expect(online).toBeEnabled();
+  await online.check();
+  // The shop's settings are their own form: the card's button is gone (nothing changed there)
+  await expect(card.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
+  await page.getByRole('button', { name: 'Save changes' }).click();
+  await toastShown(page, 'Shop settings saved');
+  // The answer is the saved settings: the box stays ticked, with nothing left to save
+  await expect(online).toBeChecked();
+  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
+});
+
 test('hides the Storefront menu from a role without storefront.manage', async ({ page }) => {
   await actAs(page, { name: 'Store keeper', permissions: ['inventory.stock.adjust'] });
   await start(page);
```

```diff
@@ -290,3 +290,57 @@ test('picks the service the delivery charge is billed as', async ({ page }) => {
   await expect(page.getByText('Changes not saved yet')).toBeHidden();
   await expect(select.locator('option:checked')).toHaveText('Logo embroidery · SVC-EMB');
 });
+
+// Step 27d: the Payments card and the refund notices of the seeded online orders
+// (mocks/storefront-order-data.ts → seedTries)
+test('shows each online payment, the refund to make, and makes a failed receipt', async ({
+  page,
+}) => {
+  await start(page);
+  await showTab(page, 'All');
+  await openOrder(page, 'W-000001');
+  // How it was paid, in the shopper's card (the list's Payment column is not on a phone's card)
+  await expect(page.getByText('Paid online', { exact: true })).toBeVisible();
+  const payments = page
+    .locator('section')
+    .filter({ has: page.getByRole('heading', { name: 'Payments' }) });
+  await expect(payments.getByRole('listitem')).toHaveCount(1);
+  await expect(payments).toContainText('BKASH-BKash');
+  await expect(payments).toContainText('BK7XQ2M4PL');
+  await expect(
+    page.getByText('The invoice is paid: it took the online payment’s money receipt.'),
+  ).toBeVisible();
+  // The timeline says the payment confirmed it, not a phone code
+  await expect(page.getByText('Confirmed when the payment arrived')).toBeVisible();
+  await expectNoSideScroll(page);
+
+  // Cancelled after it was paid: the money goes back, and the link opens the refund of its receipt
+  await backToList(page);
+  await showTab(page, 'All');
+  await openOrder(page, 'W-000002');
+  await expect(payments.getByRole('listitem')).toHaveCount(2);
+  await expect(payments.getByRole('listitem').first()).toContainText('Failed');
+  await expect(page.getByText(/^The shopper paid ৳[\d,]+ online for this order\./)).toBeVisible();
+  await page.getByRole('link', { name: 'Record refund' }).click();
+  await expect(page).toHaveURL(/\/refunds\/new\?receiptId=/);
+
+  // Paid twice: the second receipt failed, and "Make the receipt" makes it now
+  await page.goto('/');
+  await openFromNav(page, 'Shop orders');
+  await openOrder(page, 'W-000006');
+  await expect(page.getByText(/^The shopper paid online twice, ৳[\d,]+ each time\./)).toBeVisible();
+  const second = payments.getByRole('listitem').nth(1);
+  await expect(second.getByText(/^The money receipt could not be made\./)).toBeVisible();
+  await second.getByRole('button', { name: 'Make the receipt' }).click();
+  await toastShown(page, /^Money receipt .+ made$/);
+  await expect(second.getByText(/^The money receipt could not be made\./)).toHaveCount(0);
+
+  // Cash on Delivery with a paid try: the rider takes no cash
+  await backToList(page);
+  await showTab(page, 'All');
+  await openOrder(page, 'W-000004');
+  await expect(
+    page.getByText(/^The shopper paid ৳[\d,]+ online too, then chose cash on delivery\./),
+  ).toBeVisible();
+  await expect(page.getByText('Confirmed with the phone code')).toBeVisible();
+});
```

The orders' test checks how the order was paid on the order page, not in the list: the list's Payment column is not
on a phone's card (27b.7).

### Check this part

```bash
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test                              # 273 tests
pnpm --filter @omnivo/shop test:e2e                          # 50 passed, 2 skipped
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                               # 239 tests
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts storefront
pnpm exec eslint apps/shop/src apps/shop/e2e apps/shop/scripts apps/app/src/mocks apps/app/e2e
pnpm exec prettier --check apps/shop apps/app/src apps/app/e2e
pnpm boundaries
```

All of them pass. The ERP's four storefront Playwright files (54 tests) passed with two workers; five of them timed
out once while the machine was busy and passed when run again.

The screens were compared with 27d.6's mockup: they match. One small difference is left: the mockup draws the Store ID
box in `Geist Mono`, and `@omnivo/ui`'s input has no way to change its font yet. That is a change to the shared
component, not to this step.

Broken on purpose, to see that the checks notice:

- The return path taken out of `CROSS_SITE_PATHS`: the origin check's test fails.
- `waitingForCode()` returning every waiting order: the mock's "waits for an online payment, with no phone code"
  fails (the mock's `123456` would confirm an unpaid order).

## 27d.8 — Run it and check it

Every check ran once on the whole repo, then the whole way ran on the real API with the fake gateway. The run found
three things the parts missed. Two are small code changes, one is a note for the staging server.

### `pnpm seed:shop` saved Pay online without a gateway

Decisions made in this part:

67. **The seed's shop takes Cash on Delivery only.** 26h's seed copies the mock's checkout settings, and the mock
    offers Pay online. Since 27d.3 the API lets a shop tick Pay online only once its Online payment card is saved with
    both accounts (`storefront_online_not_ready`), so the seed stopped at "Set up the shop". The seed does not save a
    gateway: it would need a store id and a password, and in production the gateway is SSLCommerz, which would refuse
    made-up ones. The developer sets it up on the card, like a tenant does.
68. **The first-load budget is 250 KB** (you chose this). 27d's words and contracts took the first load to 246.4 KB.

```diff
@@ -195,7 +195,10 @@ export function settingsBody(subdomain: string, warehouseId: string): SettingsBo
     })),
     freeDeliveryFrom: mockCheckoutSettings.freeDeliveryFrom,
     minimumOrder: mockCheckoutSettings.minimumOrder,
-    paymentMethods: [...mockCheckoutSettings.paymentMethods],
+    // Step 27d: Cash on Delivery only. The mock offers Pay online too, but the API lets a shop tick
+    // it only once the Online payment card is saved with its two accounts (storefront_online_not_ready),
+    // and the seed has no gateway account to save. Set it up in Shop settings to see Pay online
+    paymentMethods: ['cod'],
     // Step 27b: none picked, so the first order with a charge makes "Delivery charge" itself
     deliveryVariantId: null,
   };
```

The other settings still come from the mock, so the real checkout charges what the mock's does. The unit tests check
each part of the seed against its contract, but a contract cannot know whether the workspace has a gateway: that is
the database's answer (`storefront_online_ready()`), so only a real run found it. The new test keeps the seed from
asking for Pay online again:

```diff
@@ -116,6 +116,10 @@ describe('the shop', () => {
     expect(parsed.error?.issues).toBeUndefined();
   });
 
+  it('settings ask for Cash on Delivery only (Pay online needs a saved gateway, step 27d)', () => {
+    expect(settingsBody('demo-shop', randomUUID()).paymentMethods).toEqual(['cod']);
+  });
+
   it('categories come after their parent and pass the form', () => {
     const made = new Set<string>();
     for (const category of seedCategories) {
```

A dev database seeded before 27d keeps Pay online ticked. That is allowed (decision 4: a box ticked already stays
ticked), and the checkout does not offer it until the card is saved and ready, because `offeredMethods` asks
`storefront_online_ready()` on every read.

### The first load is over 245 KB

```diff
@@ -20,7 +20,10 @@ import { z } from 'zod';
 // Storefront menu's words (26g.5) and its sidebar group took it to 237.2 KB; its four pages are
 // lazy chunks. Step 26h: 245 KB (you chose this). The words of Shop appearance and Shop pages
 // (26h.5) took it to 241.1 KB, with or without their two sidebar items; the six pages are lazy.
-const INITIAL_BUDGET = 245 * 1024;
+// Step 27d: 250 KB (you chose this). The online payment's words (27d.5) and its contracts (the
+// Online payment card, the order's payment tries and the shop's payment routes, which the route
+// table carries) took it to 246.4 KB; the card and the order page stay in their lazy chunks.
+const INITIAL_BUDGET = 250 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

The growth is in the two things every page loads at first: the English words (27d.5) and the contracts' route table,
which now has the Online payment card's routes and the order's payment tries. The card and the order page themselves
are in their lazy chunks (131.9 KB and 112.2 KB of 155). The real fix is still the one the budget's comment names:
load each module's words and routes with its own pages.

### Staging

```diff
@@ -218,7 +218,9 @@ services:
   # <subdomain>.<SHOP_BASE_DOMAIN>, and staging has one fixed SHOP_HOST. Switching to the API needs a
   # wildcard host (DNS, the tunnel and Caddy) first, then SHOP_SOURCE=api, SHOP_API_URL, SHOP_API_KEY
   # and the API's SHOP_BASE_DOMAIN and STOREFRONT_SHOP_KEY (the same value as SHOP_API_KEY; step
-  # 27a). It needs nothing else in the stack. `web` does not wait for it either:
+  # 27a). Paying online (step 27d) also needs CREDENTIALS_KEY on api and worker: production uses
+  # SSLCommerz (PAYMENT_GATEWAY), and without the key the Online payment card cannot save a store.
+  # It needs nothing else in the stack. `web` does not wait for it either:
   # if the shop fails, the ERP app keeps working and only the shop's address answers 502.
   shop:
     image: ${REGISTRY}/omnivo-shop:${IMAGE_TAG}
```

Only a comment. The staging server runs in production mode, so its gateway is SSLCommerz, and it has no
`CREDENTIALS_KEY`: the Online payment card there answers "This server cannot keep a gateway password yet…" until one
is set on `api` and `worker` (the same value on both, from `openssl rand -base64 32`). The staging shop still shows the
mock (26g.8), whose own fake gateway works without any of this.

### The run on the real API

Not part of the repo: a script started a throwaway Postgres, Valkey, MinIO and Mailpit on other ports, the built API
and worker (`PAYMENT_GATEWAY=fake`), ran `pnpm seed:shop`, started the built shop with `SHOP_SOURCE=api`, and drove the
ERP's production build and the shop in one browser:

- The Online payment card on Shop settings: Pay online disabled at first; saved with the store id `fake_rejected`,
  "Test connection" refused; saved again with another store id, the test passed; Pay online ticked and saved. The
  database holds 37 sealed bytes and no plain password, and the four audit rows do not hold it either.
- The shop offered Pay online within its cache's minute. Two shampoos, Inside Dhaka, Pay online: the fake page, "Pay
  ৳538", then `/checkout/paid` with "Order Confirmed" and the order's page saying "Paid online".
- A second order: "Fail the payment", "You can try 2 more times.", "Try again", paid. Its tries are `1:failed,2:paid`.
- A form posted from another site: the return path answers 303 to `/checkout/paid`, `/track` answers 403.
- The worker made both money receipts. The first one's entry: Dr 1110 ৳524.55 (what SSLCommerz pays out), Dr 5410 Bank
  charges ৳13.45 (the fake gateway's 2.5%), Cr 1140 ৳538.
- The ERP's order page showed the Payments card with the receipt's number and "Confirmed when the payment arrived".
  Packed, shipped and delivered: the invoice of ৳538 was paid by the receipt, and the page said so.

### Try it

Your `.env` needs the new line from `.env.example` (27d.3): `CREDENTIALS_KEY`. `PAYMENT_GATEWAY` can stay out: outside
production it is the fake gateway.

```bash
pnpm install
pnpm db:migrate        # 0075 and 0076
pnpm dev
pnpm seed:shop         # once, if your dev database has no demo shop yet (26h.8)
```

Start a second shop on the API, as in 27a.6 (the key is the API's `STOREFRONT_SHOP_KEY` from your `.env`):

```bash
SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 \
SHOP_API_KEY=dev-only-shop-key-change-me-0123456789abcdef \
pnpm --filter @omnivo/shop dev --port 4322
```

Sign in to the ERP as the shop's owner (`owner@demo-shop.test`, `Demo-shop-2026`), then go through the list. The
phone codes are in Mailpit (`http://localhost:8025`).

- [ ] Storefront → Shop settings has the **Online payment** card, "Not set up". Pay online under Payment cannot be
      ticked, and says why.
- [ ] Save the card with Store ID `fake_rejected`, any password, Sandbox, `1110 · Cash in hand` (or a bank account)
      and a fee account: "Ready". "Test connection" says SSLCommerz refused the store. Change the Store ID to
      `demoshop_sandbox`, save, test again: "SSLCommerz accepted the store". The password box is empty again.
- [ ] Tick Pay online and save. Within a minute `http://demo-shop.localhost:4322/checkout` offers it, with the hint
      about SSLCommerz's page.
- [ ] Two shampoos, Inside Dhaka, Pay online, Confirm Order: the "Test payment" page. "Pay ৳538": "Order Confirmed",
      and "View Order Details" says "Paid online". No phone code was asked.
- [ ] Shop orders: the order is New. Its Payments card has Try 1, Paid, the fee ৳13.45, "SSLCommerz pays out
      ৳524.55" and a money receipt. The receipt's journal entry has the fee on its own line.
- [ ] Order again and press "Fail the payment": "The payment did not go through", 2 tries left. "Try again", then
      "Cancel the payment", then "Pay on delivery instead": the phone code from Mailpit confirms it as cash on delivery.
- [ ] Pack, ship and deliver the paid order: "The invoice is paid: it took the online payment’s money receipt."
- [ ] Pay a third order, then cancel it on its Shop orders page: the page says the shopper paid online and shows
      "Record refund", which opens a refund of that receipt.
- [ ] Untick Pay online and save: within a minute the checkout offers Cash on Delivery only.

## What comes next

- **27d.9 (on request):** the docs: CLAUDE.md (the Online payment card, the order's Payments card, "Pay online", the
  `/checkout/paid` and fake gateway pages, `PAYMENT_GATEWAY` and `CREDENTIALS_KEY`), system-design §14 and build-plan
  ২৭d with section ৯.
- **Before a live shop:** one run of the list above with an SSLCommerz sandbox store, then the live store.
- **Step 28:** courier bookings and their events on the tracking page, and SSLCommerz's refund API in place of
  "Record refund" by hand.
- **Step 24:** the platform's own billing can use the same gateway layer (`apps/api/src/payments/`).
- **Small:** the Store ID box in `Geist Mono`, as the mockup draws it, once `@omnivo/ui`'s input can take a font.
