# Step 26c: Storefront, part 3 — checkout, the phone code and the order

> The implementation guide for "Phase 10 → Step 26", the third part, of [build-plan.bn.md](build-plan.bn.md). Step 26
> has four parts:
>
> - **26a (done):** `apps/shop`, the tokens, the data contract, the mock, the header, the footer and the home page.
> - **26b (done):** server mode, the product page `/p/<slug>` and the cart drawer.
> - **26c (this guide):** the checkout `/checkout`, the phone code `/checkout/verify`, the "Order Confirmed" dialog and
>   the order page `/order/<no>`.
> - **26d:** the category and search pages (chip menus, filters, sort, Load More), tracking, the text pages, the empty
>   states and the first Playwright tests.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `1abeae9`, "server
> requirement") and checked on 2026-11-12: `pnpm dedupe --check`, `pnpm build`, `pnpm typecheck`, `pnpm lint`,
> `pnpm format`, `pnpm test` (1,100, of them 113 in `apps/shop` and 456 in `packages/contracts`), `pnpm boundaries`,
> `pnpm test:bundle-size` and `pnpm test:openapi`, all clean.
>
> **Not run:** `test:integration`, `test:tenant-leak` and the e2e suites. This step changes no code in `apps/api` or
> `apps/app`. The shared packages it touches only gain schemas, error codes and words, and the unit tests, the type
> check and the build of both apps cover them. The shop has no Playwright tests yet (26d).
>
> Also checked:
>
> - **The checkout against Figma, measured in Chromium** (Playwright, against the built server). At 1440px: the card
>   at 296,128 (848 wide), its header 65px tall, the labels at y 233, the inputs at y 256 (380×48, at x 332 and 728),
>   the location cards at y 467 (380×64). Figma: the same, ±1px. Below them everything is 22px lower than in Figma:
>   that is the line "Free delivery on orders over ৳1,000", which `CLAUDE.md` adds and Figma does not have. From there
>   the gaps are Figma's again: the line at y 589 (155×130 photo), the rules at 749 and 810, the promo box at 897, the
>   payment cards at 1032, Confirm Order at 1188 (776×64), and the footer 160px under the card. At 900px the same
>   layout is 764px wide; at 390px it is one column. Nothing scrolls sideways at any width.
> - **The dialog:** 440×500 at 1440px, as in Figma; the title 212px, the sentence 253px and the buttons 352px from its
>   top; the focus on "Continue shopping".
> - **The whole way:** Cash on Delivery → `/checkout/verify` → `123456` → the dialog → "View Order Details" →
>   `/order/W-000001`; Mobile Banking → the dialog over the checkout. The order page and the verify page also end
>   160px above the footer.
> - **In Bangla** (`language: 'bn'` in the mock): the checkout's words and amounts (৳৫৭৮), a phone typed in Bangla
>   digits, the code typed as `১২৩৪৫৬`, the dialog, and the order page with Bangla dates (`১২ নভে, ২০২৬, ১০:৩৫`).
> - **Broken on purpose, nineteen times** while the parts were written, each caught by a test or the type check. Each
>   part's "Check this part" lists them.
> - **JavaScript sent to the browser:** only `/checkout` loads React, as two chunks: the island (48.6 KB gzipped) and
>   React DOM (65.9 KB). The verify page's script is 2.1 KB and the dialog's 0.7 KB. The home and product pages load
>   what they loaded after 26b.

## Goal

🧾 **A shopper can order.** After 26b the cart showed today's prices, and "Checkout" opened a 404. After this step:

- **`/checkout` matches Figma** (`checkout_process`, 1440px): name, mobile number, address, the delivery location,
  the cart's lines with a stepper and delete, Delivery Charge and Total, the promo box, the payment method, the terms
  box and Confirm Order. The server prices the cart again for the zone and the coupon, with free delivery over an
  amount and a minimum order.
- **Cash on Delivery asks for a phone code** on `/checkout/verify`. Mobile Banking is confirmed at once in the mock.
- **"Order Confirmed"** (Figma `confirmation_status`) opens over the page, and **`/order/<no>`** shows the order, its
  timeline and its lines, only to the browser that placed it.
- **The checkout form is the shop's first React island**, and only `/checkout` pays for React.

## The whole picture

```
packages/contracts   storefront.ts: + zone and coupon in the quote, ShopCheckoutSettings, ShopOrderRequest,
      │               ShopOrderPlaced, ShopOrderConfirmed, ShopOrder · errors.ts: 17 shop_* codes
      ▼
apps/shop/src/data   source.ts: checkoutSettings() · quote() · placeOrder() · codeWait() · verifyCode()
      │              resendCode() · order(no, token)          mock/: zones, coupons, an order book in memory
      ├──────────────────────────────┬──────────────────────────────────┬───────────────────────────────┐
      ▼                              ▼                                  ▼                               ▼
src/pages/checkout.astro      src/pages/api/ (src/server/)       src/pages/checkout/verify.astro  src/pages/order/[no].astro
  words by t() on the server    cart/quote: + zone, coupon         the order by the checkout        the order by the orders
  <CheckoutForm client:load>    orders → 201 verify | confirmed    cookie; a box and a small        cookie, else 404; no
      │                         orders/verify, orders/resend       script                           script
      │                         (problem+json; sets the cookies)
      ▼
the browser
  islands/checkout (React, react-hook-form + Zod) ─► POST /api/orders ─┬─► verify: go to /checkout/verify
                                                                       └─► confirmed: event shop:order-confirmed
  <order-confirmed> listens on the document ─► the dialog ─► "View Order Details" ─► /order/W-000001

Thursday 12 Nov 2026, a shopper in Rajshahi has two neem face washes in the cart:
  /checkout: ৳458 and "Pick a location" … they pick Outside Dhaka ──► Delivery Charge ৳120, Total ৳578
  Cash on Delivery, Confirm Order ──► /checkout/verify: "We sent a 6-digit code to +880 17•• ••• 356"
  they type the code from the SMS ──► "Order Confirmed" ──► /order/W-000001: placed and confirmed, three steps ahead
```

## Not in this step, on purpose

- **No real SMS and no real payment.** The mock's code is always `123456` (decision 4), and Mobile Banking is
  confirmed at once. The SMS and the tenant's own payment gateway come with step 26's API and step 27.
- **No stock is held** for a waiting order (decision 6).
- **No sales order in the ERP.** A confirmed web order becomes a sales order with step 26's API; until then it lives
  in the mock's memory and is gone when the server restarts (decision 3).
- **No shopper account.** The shop takes a phone, not an email or a password. Another device finds an order with
  `/track` (26d).
- **No Playwright tests yet.** The shop's first ones come with 26d, when every screen is there.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront.ts`, `storefront.spec.ts` | The quote takes a zone and a coupon; the checkout's settings; the order, the phone code and the order page |
| `packages/contracts/src/errors.ts` | 17 `shop_*` error codes |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | `shop.checkout`, `shop.verify`, `shop.confirmed`, `shop.order` and `errors.shop_*` |
| `apps/shop/package.json`, `pnpm-lock.yaml` | `react-hook-form`, `@hookform/resolvers`, `zod`, `@fontsource-variable/geist-mono` |
| `apps/shop/src/data/types.ts`, `mock/mock-source.ts`, `mock/quote.ts` | The source's checkout methods; the mock quote prices the zone and the coupon |
| `apps/shop/src/server/problem.ts`, `cart-quote.ts` | More statuses, and one `readBody()` for every route |
| `apps/shop/src/styles/shop.css` | Geist Mono for the order number |
| `apps/shop/src/boundaries.spec.ts`, `mock/quote.spec.ts`, `lib/quote.spec.ts` | New rules (React only in `islands/`) and tests |

New: the mock's `checkout.ts` and `orders.ts`, `src/server/cookies.ts` and `orders.ts`, the three order routes,
`src/islands/checkout/`, the pages `/checkout`, `/checkout/verify` and `/order/<no>`, `OrderConfirmedDialog.astro`,
`OrderTimeline.astro`, and `lib/order-events.ts`, `phone.ts`, `verify.ts` and `order-timeline.ts`.

## The decisions behind this step

The first six were agreed before the step started. The rest were made while writing it; each says why.

1. **The checkout form is the shop's first React island**, with `react-hook-form` and the Zod schema from
   `@omnivo/contracts`. Its words do not come from i18next in the browser: the Astro page runs `t()` on the server
   and passes the words in as props. 26a measured React plus i18next at about 176 KB gz; without i18next, only the
   form's own code and Zod reach the browser, and only on `/checkout`.
2. **The quote route grows** instead of a second route: `/api/cart/quote` also takes the delivery zone and a coupon
   code, and answers the discount, the delivery charge and the total. The drawer keeps sending only its lines and
   ignores the new fields. One coupon per order; it takes money off the items, never off the delivery. The shop's
   minimum order is in this step: under it, Confirm Order is disabled and says how much more is needed.
3. **The mock keeps orders in memory** (a `Map` in the Astro server), lost when the server restarts. Order numbers look
   like `W-000123`, so they are never mistaken for the ERP's sales order numbers: a shop order is a request that may
   be spam (system design §14.3), and it becomes a sales order only when it is confirmed (step 26's API).
4. **The phone code (Cash on Delivery)** is asked on `/checkout/verify`. The page finds its order by a random token in
   an httpOnly cookie, never by the order number, which is short and easy to guess. The mock's code is always
   `123456`, and the page says so only in the mock. A new code can be asked for every 45 seconds; after 5 wrong codes
   the order is dropped and the shopper starts again. Mobile Banking skips the code in the mock (26b's decision 3).
5. **`/order/<no>` is shown only to the browser that placed the order** (another httpOnly cookie holds that browser's
   order tokens). It shows a phone number and a home address. Anyone else gets "page not found", the same as for a
   number that does not exist, so the page does not even say the order exists. Another device uses `/track` with the
   phone and the number (26d).
6. **No stock is held for an order in the mock.** The real hold (60 minutes, or until the order is confirmed) belongs
   to step 26's API, which has the stock tables.
7. **The checkout's settings are their own answer** (`ShopCheckoutSettings`), not part of `PublicShop`: every page
   loads the shop for its header and footer, and only `/checkout` needs the zones, the payment methods and the
   amounts. The quote applies the same settings on the server; the page only shows them.
8. **Free delivery and the minimum order compare with the subtotal**, the items before the coupon. Then a coupon never
   takes free delivery away and never pushes an order under the minimum, which would feel like a trick. The shop
   gives away a little more; the rule is one sentence a shopper can understand.
9. **A coupon that does not apply never fails the quote.** The cart is priced as if no code was sent, and the answer
   says why (`unknown`, `expired`, or under its own minimum, with the amount). A failed request would show "The prices
   did not load", which is not what happened.
10. **Confirm Order sends the total the shopper saw** (`expectedTotal`). The server never uses it as money: it works the
    order out again, and when its total is different (a price, the stock or the coupon changed since the last quote)
    it refuses with `shop_order_changed`. The checkout then prices the cart again, so the shopper never pays a total
    they did not see.
11. **The phone is made plain in the schema.** "+880 1786-120356", "8801786120356" and Bangla digits all become
    `01786120356`, so one phone is one phone in the orders, in the code's limits and in the SMS. Only Bangladeshi
    mobile numbers are taken: the code goes by SMS, and the courier calls the number.
12. **Payment methods are `cod` and `online`**, as `storefront_orders.payment_method` in the system design. "Online" is
    the tenant's own gateway (step 27); the checkout calls it "Mobile Banking", as Figma does.
13. **An order's lines are copies** (name, photo, price at that moment), not links to the listing. A listing's price
    or name may change the next day; the order must still say what was bought and for how much.
14. **Figma's "Delivery Method" group is the payment group.** Figma draws three cards (Free Delivary, Cash on Delivery,
    Mobile Banking) under "Delivery Method". `CLAUDE.md` (approved 2026-11-07) already makes it "Payment Method" with
    two cards; free delivery is not a choice but the result of the subtotal (decision 8).
15. **A Discount row is added** above Delivery Charge, only while a coupon is applied. Figma has no row for it, but an
    applied coupon that changes the total without saying so would look like a wrong total.
16. **A zone the shop does not have is "no zone" in the quote**, and an error only at Confirm Order. An old checkout
    tab, open while the shop removed a zone, then says "Pick a location" instead of "The prices did not load".
17. **An order waits 60 minutes for its code**, the system design's stock hold (§14.4), and the checkout cookie lives
    as long. The mock drops an order that waited too long when someone asks for it, and sweeps the old ones away when
    a new order comes in, so it needs no timer and a script cannot fill its memory.
18. **A new code does not forgive the wrong ones.** Five wrong codes per order, however many SMS were sent; otherwise
    "Resend code" would give a guesser five more tries every 45 seconds.
19. **`/order/<no>` shows confirmed orders only.** An order still waiting for its code is not an order yet: it may
    never be confirmed, and it would be dropped within the hour.
20. **The browser keeps its 20 newest orders for 30 days** in the orders cookie. That is about 2 KB, half of what a
    browser keeps for one cookie. An older order is reached with `/track` (26d).
21. **Confirm Order checks in the order a shopper can act on:** the zone, the payment method, every line still
    sold, the minimum order, then the total. A shopper under the minimum is told how much more to add, not "the
    total changed".
22. **No delivery zone is picked for the shopper.** Figma shows one picked, but a guess would show a delivery charge
    that may be wrong, and the shopper would pay it without looking. Until a zone is picked, the Delivery Charge row
    says "Pick a location", and Confirm Order shows that error under the group. The payment method does start on the
    shop's first one: both cost the same, so a default changes no amount.
23. **A Cash on Delivery order keeps the cart until its code is right.** A shopper who closes the verify page has not
    ordered anything yet, and must not find the cart empty. An order confirmed at once (Mobile Banking) takes its lines
    out of the cart at once, and the checkout stays on screen behind the dialog, as Figma draws it.
24. **The checkout says "order confirmed" with a DOM event** (`shop:order-confirmed`), not by rendering the dialog
    itself. The verify page (26c.5) confirms orders too; one dialog listens on the document for both, and neither page
    imports it.
25. **The island checks every answer with its contract's Zod schema.** The drawer's hand-written guard exists only to
    keep Zod off every page; the checkout's chunk has Zod anyway, so the full contract is checked for free.
26. **A refused coupon stays in the quote requests until it is removed.** A code under its minimum ("needs items worth
    ৳500") starts to work by itself when the shopper adds items, which is what they were told to do.
27. **Confirm Order is disabled only for reasons the page shows next to it:** the terms box, grey amounts (a newer cart
    is being priced), an out-of-stock line, the minimum order. Empty fields and no zone are not a reason to disable
    it: the shopper presses it and each field says what is missing, which a grey button never could.
28. **The terms link opens in a new tab**, so reading the terms does not lose what the shopper typed.
29. **The verify page is Astro plus a small script, not a second React island.** It has one box and two buttons; its
    script is 2.1 KB gzipped, where React would add 114 KB for the same page.
30. **`/checkout/verify` with no order waiting goes to `/checkout`**, without an error page. It happens after a reload
    once the dialog is open, after five wrong codes, or after the hour; in each case the checkout is where the shopper
    can act, and the cart is still there (decision 23).
31. **A right code takes out of the cart exactly the order's listings**, which the server knows, not the whole cart.
    Something the shopper added in another tab while the SMS came stays in the cart.
32. **The dialog is drawn only by the checkout and the verify page**, not by `ShopLayout`. No other page confirms an
    order, so no other page needs its markup or its script.
33. **Closing the dialog any way goes to the home page** (`CLAUDE.md`: closing it is "Continue shopping"). The page
    behind it is an order that is done, with an empty cart; leaving it there would invite a second Confirm Order.
34. **`/order/<no>` is drawn on the server with no script.** It changes only when the shop moves the order, and a
    reload shows that. Its timeline's rules are in `lib/order-timeline.ts` so 26d's `/track` uses the same ones.
35. **A delivered order's last dot is "done", not "current"**: nothing more will happen to it. A cancelled or returned
    order shows only the steps it really went through, ending on the cancel; drawing "Delivered" as a step still ahead
    would promise something that will not come.
36. **The order page adds a Subtotal row** above Delivery Charge. On the checkout the lines' totals are right above
    it; on the order page the shopper reads the order later and needs the sum before the charges.
37. **The shop loads Geist Mono** for the order number (`CLAUDE.md`: in Geist Mono, never broken). A `@font-face`
    downloads nothing until a page uses it, so only `/order/<no>` pays for the file.
38. **The verify page and the order page end 160px above the footer, like the checkout.** Figma draws only the
    checkout, with 160px under its card; the two other pages use the same card (`CLAUDE.md`), so they keep its
    distance too, and the footer does not jump when the shopper goes from one to the next.

## The pictures from Figma

This step needs no new pictures. The dialog's two-tone tick, `public/shapes/order-confirmed.svg`, was downloaded with
26b, and the checkout's lines show 26b's product photos. Figma has the checkout (`checkout_process`, 37:3765) and the
dialog (`confirmation_status`, 41:4066) at 1440px only, with no phone frames: the phone layout follows the storefront
rules in `CLAUDE.md`, and the verify page and the order page are not in Figma at all.

## 26c.1 — `packages/contracts`: the checkout, the order and the phone code

### `src/storefront.ts`

```diff
@@ -190,29 +190,26 @@ export const SHOP_CART_MAX_LINES = 50;
 
 const listingIdSchema = z.string().min(1).max(64);
 
-// What the browser sends to get its cart priced: ids and counts, in the cart's order. Never a
-// price, a name or a total: those come back from the server (system design §14.4). It is the one
-// input in this file, so it is strict about what it takes.
-export const shopCartQuoteRequestSchema = z
-  .object({
-    lines: z
-      .array(
-        z.object({
-          listingId: listingIdSchema,
-          quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
-        }),
-      )
-      .max(SHOP_CART_MAX_LINES),
-  })
-  .superRefine((request, ctx) => {
+// The cart's lines as the browser sends them: ids and counts, in the cart's order. Never a price, a
+// name or a total: those come back from the server (system design §14.4). Step 26c: its own schema,
+// because the quote and the order both send it.
+const cartLinesSchema = z
+  .array(
+    z.object({
+      listingId: listingIdSchema,
+      quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
+    }),
+  )
+  .max(SHOP_CART_MAX_LINES)
+  .superRefine((lines, ctx) => {
     // The cart adds to a line instead of making a second one (cart.ts → addLine). Two lines for one
     // listing would be priced twice, so a request that has them is not from our cart
     const seen = new Set<string>();
-    request.lines.forEach((line, index) => {
+    lines.forEach((line, index) => {
       if (seen.has(line.listingId)) {
         ctx.addIssue({
           code: 'custom',
-          path: ['lines', index, 'listingId'],
+          path: [index, 'listingId'],
           message: errorCode('invalid_input'),
         });
       }
@@ -220,6 +217,29 @@ export const shopCartQuoteRequestSchema = z
     });
   });
 
+// A delivery zone's id ("inside_dhaka"). Short, because it only names one of the shop's own zones
+const zoneIdSchema = z.string().min(1).max(32);
+
+// A coupon code as the shopper typed it. Trimmed and upper-cased here, so " welcome10 " and
+// "WELCOME10" are one code, and the server never compares two spellings of it. Letters, digits and
+// dashes only: a code is printed on a flyer and typed on a phone
+export const SHOP_COUPON_MAX_LENGTH = 20;
+const couponCodeSchema = z
+  .string()
+  .trim()
+  .toUpperCase()
+  .regex(/^[A-Z0-9-]{1,20}$/, errorCode('shop_coupon_format'));
+
+// What the browser sends to get its cart priced. The drawer sends only the lines; the checkout
+// (step 26c) also sends the delivery zone the shopper picked and the coupon they applied, so the
+// answer carries the delivery charge, the discount and the total. Both are optional, never
+// required: an old drawer that sends `{ lines }` still gets its subtotal.
+export const shopCartQuoteRequestSchema = z.object({
+  lines: cartLinesSchema,
+  zoneId: zoneIdSchema.optional(),
+  couponCode: couponCodeSchema.optional(),
+});
+
 // The parts of a listing a cart line draws: the 96×80 image box, the name (a link to its page) and
 // the pack size
 const quoteLineListingSchema = z.object({
@@ -250,12 +270,52 @@ export const shopCartQuoteLineSchema = z.discriminatedUnion('status', [
   z.object({ status: z.literal('unavailable'), listingId: listingIdSchema }),
 ]);
 
-// The answer. The subtotal and the item count are the server's sums of the available lines, so the
-// drawer never adds money in the browser. Step 26c adds the delivery zone, the coupon and the total
+// What happened to the coupon the request sent. A coupon that does not apply never fails the quote:
+// the cart is still priced, and the promo box says why the code did nothing.
+// - none: no code was sent
+// - applied: the code took money off; `discount` says how, so the promo box can say "10% off" or
+//   "৳50 off" next to the code
+// - refused: the code did nothing. `reason` is an error code the promo box turns into words:
+//   unknown (no such code), expired (its last day has passed) or below its minimum (the items
+//   are worth less than `minimum`, which the words name)
+export const shopCouponResultSchema = z.discriminatedUnion('status', [
+  z.object({ status: z.literal('none') }),
+  z.object({
+    status: z.literal('applied'),
+    code: couponCodeSchema,
+    discount: shopDiscountSchema,
+  }),
+  z.object({
+    status: z.literal('refused'),
+    code: couponCodeSchema,
+    reason: z.enum(['shop_coupon_unknown', 'shop_coupon_expired', 'shop_coupon_minimum']),
+    // Only for shop_coupon_minimum: "Add ৳120 more to use this code" needs the amount
+    minimum: shopMoneySchema.nullable(),
+  }),
+]);
+
+// The answer. Every amount is the server's: the subtotal and the item count are sums of the
+// available lines, so the drawer and the checkout never add money in the browser.
+// Step 26c adds the rest of the bill:
+// - discount: what the coupon took off the subtotal ('0' without one). Never off the delivery
+// - deliveryCharge: the zone's charge, '0' when the order gets free delivery, null when no zone
+//   was sent (the drawer, or a checkout before the shopper picks one)
+// - freeDelivery: the subtotal reached the shop's free-delivery amount, so the Delivery Charge row
+//   says "Free" instead of "৳0"
+// - total: subtotal − discount + delivery charge. Without a zone it is the items only, and the
+//   checkout does not offer Confirm Order until a zone is picked
+// - belowMinimum: the subtotal is under the shop's minimum order; Confirm Order is disabled and
+//   says how much more is needed (the shop's settings have the minimum)
 export const shopCartQuoteSchema = z.object({
   lines: z.array(shopCartQuoteLineSchema),
   itemCount: z.number().int().min(0),
   subtotal: shopMoneySchema,
+  discount: shopMoneySchema,
+  coupon: shopCouponResultSchema,
+  deliveryCharge: shopMoneySchema.nullable(),
+  freeDelivery: z.boolean(),
+  total: shopMoneySchema,
+  belowMinimum: z.boolean(),
 });
 
 export type ShopProduct = z.infer<typeof shopProductSchema>;
@@ -263,3 +323,178 @@ export type ShopProductPage = z.infer<typeof shopProductPageSchema>;
 export type ShopCartQuoteRequest = z.infer<typeof shopCartQuoteRequestSchema>;
 export type ShopCartQuoteLine = z.infer<typeof shopCartQuoteLineSchema>;
 export type ShopCartQuote = z.infer<typeof shopCartQuoteSchema>;
+export type ShopCouponResult = z.infer<typeof shopCouponResultSchema>;
+
+// ---------------------------------------------------------------------------------------------
+// Step 26c: checkout, the phone code and the order.
+
+// How the shopper pays. The system design's payment_method is cod | online; "online" is the
+// tenant's own gateway (SSLCommerz, bKash), which step 27 connects. The checkout calls it
+// "Mobile Banking", as Figma does.
+export const SHOP_PAYMENT_METHODS = ['cod', 'online'] as const;
+
+// A delivery zone the shop delivers to, with its charge ("Inside Dhaka — ৳80")
+export const shopDeliveryZoneSchema = z.object({
+  id: zoneIdSchema,
+  name: z.string().min(1),
+  charge: shopMoneySchema,
+});
+
+// What /checkout needs before the first quote: the zones and payment methods to offer, and the
+// amounts the page explains ("Free delivery on orders over ৳1,000"). Its own answer, not part of
+// the shop: only this page uses it, and every other page loads the shop. The quote applies the same
+// settings on the server; the page only shows them.
+export const shopCheckoutSettingsSchema = z.object({
+  // At least one, or nothing can be delivered. Six fit the radio cards' two columns on one screen
+  zones: z.array(shopDeliveryZoneSchema).min(1).max(6),
+  paymentMethods: z.array(z.enum(SHOP_PAYMENT_METHODS)).min(1),
+  // null: the shop never delivers for free / takes an order of any size. Compared with the
+  // subtotal (the items before the coupon), so a coupon never takes free delivery away
+  freeDeliveryFrom: shopMoneySchema.nullable(),
+  minimumOrder: shopMoneySchema.nullable(),
+});
+
+const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
+
+function asciiDigits(value: string): string {
+  return value.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)));
+}
+
+// A Bangladeshi mobile number, the way a courier and an SMS gateway need it: 01 then the operator
+// digit (3–9) then 8 digits, 11 in all ("01786120356"). The shopper may type it any common way:
+// "+880 1786-120356", "8801786120356", Bangla digits from a Bangla keyboard. All of them become
+// the same 11 digits here, so one phone is one phone in the orders, the code's limits and the
+// SMS. A landline or a foreign number is refused: the code goes by SMS, and the courier calls it.
+export const shopPhoneSchema = z
+  .string()
+  .transform((value) => {
+    const digits = asciiDigits(value).replace(/[\s-]/g, '');
+    return digits.replace(/^(?:\+?880)(?=1)/, '0');
+  })
+  .refine((value) => /^01[3-9]\d{8}$/.test(value), errorCode('shop_phone_format'));
+
+// What Confirm Order sends. The same lines, zone and coupon as the last quote, plus the delivery
+// details and the payment method. Never an amount the server trusts:
+// - expectedTotal is the total the shopper saw on the screen. The server works the order out again
+//   and refuses it (shop_order_changed) when its total is different, because a price, the stock or
+//   the coupon changed after the last quote. The shopper then sees the new total before paying it
+// - termsAccepted must be true; the button is disabled until the box is ticked, and the server
+//   checks again, because the shop owner may need to show that the shopper agreed
+export const shopOrderRequestSchema = z.object({
+  lines: cartLinesSchema.min(1, errorCode('shop_cart_empty')),
+  zoneId: zoneIdSchema,
+  couponCode: couponCodeSchema.optional(),
+  name: z.string().trim().min(1, errorCode('required')).max(80, errorCode('too_long')),
+  phone: shopPhoneSchema,
+  // Long enough for "House 12, Road 5, Block C, Mirpur 10, Dhaka", short enough for a label
+  address: z
+    .string()
+    .trim()
+    .min(10, errorCode('shop_address_too_short'))
+    .max(300, errorCode('too_long')),
+  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
+  termsAccepted: z.literal(true, errorCode('shop_terms_required')),
+  expectedTotal: shopMoneySchema,
+});
+
+// The phone code's rules (system design §14.4: Cash on Delivery always confirms the phone)
+export const SHOP_CODE_LENGTH = 6;
+export const SHOP_CODE_TRIES = 5;
+export const SHOP_CODE_RESEND_SECONDS = 45;
+
+// What Confirm Order answers. Which page comes next depends on the payment method:
+// - verify: Cash on Delivery. The order waits for the phone code; the browser goes to
+//   /checkout/verify, which says where the code went ("+880 17•• ••• 356": the middle is hidden, so
+//   a screenshot of the page does not give away the number)
+// - confirmed: the order needs no code (Mobile Banking in the mock, until step 27's gateway). The
+//   checkout opens the "Order Confirmed" dialog
+// The order's secret token is not in the body: the route sets it as an httpOnly cookie, so no
+// script on the page can read it (decisions 4 and 5).
+export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
+  z.object({
+    next: z.literal('verify'),
+    maskedPhone: z.string().min(1),
+    resendInSeconds: z.number().int().min(0),
+  }),
+  z.object({
+    next: z.literal('confirmed'),
+    orderNo: z.string().min(1),
+    phone: z.string().min(1),
+  }),
+]);
+
+// What /checkout/verify sends: the six digits. Bangla digits are accepted, like the phone
+export const shopVerifyCodeRequestSchema = z.object({
+  code: z
+    .string()
+    .transform((value) => asciiDigits(value).replace(/\s/g, ''))
+    .refine((value) => /^\d{6}$/.test(value), errorCode('shop_code_format')),
+});
+
+// A right code confirms the order: the same answer as an order that needed no code, so the page
+// opens the same dialog
+export const shopOrderConfirmedSchema = z.object({
+  orderNo: z.string().min(1),
+  phone: z.string().min(1),
+});
+
+// "Resend code" answers when the next one may be asked for
+export const shopCodeResentSchema = z.object({
+  resendInSeconds: z.number().int().min(0),
+});
+
+// An order's life (system design §14.3 storefront_orders.status). Cancelled and returned end it
+export const SHOP_ORDER_STATUSES = [
+  'pending',
+  'confirmed',
+  'packed',
+  'shipped',
+  'delivered',
+  'cancelled',
+  'returned',
+] as const;
+
+// One line of a placed order, priced as it was at that moment. A copy, not the listing: the
+// listing's price, name or photo may change later, and the order must still say what was bought
+const shopOrderLineSchema = quoteLineListingSchema.extend({
+  quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
+  unitPrice: shopMoneySchema,
+  lineTotal: shopMoneySchema,
+});
+
+// What /order/<no> shows. Only the browser that placed the order gets it (decision 5): it has the
+// shopper's phone and address
+export const shopOrderSchema = z.object({
+  orderNo: z.string().min(1),
+  placedAt: z.iso.datetime({ offset: true }),
+  status: z.enum(SHOP_ORDER_STATUSES),
+  // When each step happened, oldest first: the timeline draws a done dot with its date for each,
+  // and the steps still ahead without one. Starts with pending at placedAt
+  history: z
+    .array(z.object({ status: z.enum(SHOP_ORDER_STATUSES), at: z.iso.datetime({ offset: true }) }))
+    .min(1),
+  name: z.string().min(1),
+  phone: z.string().min(1),
+  address: z.string().min(1),
+  zoneName: z.string().min(1),
+  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
+  lines: z.array(shopOrderLineSchema).min(1),
+  subtotal: shopMoneySchema,
+  discount: shopMoneySchema,
+  couponCode: couponCodeSchema.nullable(),
+  deliveryCharge: shopMoneySchema,
+  total: shopMoneySchema,
+});
+
+export type ShopPaymentMethod = (typeof SHOP_PAYMENT_METHODS)[number];
+export type ShopDeliveryZone = z.infer<typeof shopDeliveryZoneSchema>;
+export type ShopCheckoutSettings = z.infer<typeof shopCheckoutSettingsSchema>;
+export type ShopOrderRequest = z.infer<typeof shopOrderRequestSchema>;
+export type ShopOrderRequestInput = z.input<typeof shopOrderRequestSchema>;
+export type ShopOrderPlaced = z.infer<typeof shopOrderPlacedSchema>;
+export type ShopVerifyCodeRequest = z.infer<typeof shopVerifyCodeRequestSchema>;
+export type ShopOrderConfirmed = z.infer<typeof shopOrderConfirmedSchema>;
+export type ShopCodeResent = z.infer<typeof shopCodeResentSchema>;
+export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
+export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
+export type ShopOrder = z.infer<typeof shopOrderSchema>;
```

Three things change in 26b's part of the file, and a new section is added at the end.

- **`cartLinesSchema`** is the lines of 26b's quote request, moved into a constant of their own, because the order
  sends the same lines. The `superRefine` that refuses one listing on two lines moved with them. Its issue path is
  now `[index, 'listingId']`: a refinement on the array sees paths from the array, and Zod puts `lines` in front when
  the array sits in an object. 26b's test still finds the issue at `['lines', 2, 'listingId']`, so the path did not
  change for the client.
- **`zoneIdSchema`** is short (32): an id names one of the shop's own zones (`inside_dhaka`). A long string here can
  only be a mistake or an attack, and the request should not carry it to the source.
- **`couponCodeSchema`** trims and upper-cases before it checks. A shopper types " welcome10 " from a flyer on a phone
  keyboard that capitalised nothing; the shop stores `WELCOME10`. Doing it in the schema means the server never
  compares two spellings of one code, and the code the answer sends back is the one the promo box shows. Letters,
  digits and dashes only: anything else cannot be a code, so it is refused with `shop_coupon_format` before the source
  looks it up.
- **`zoneId` and `couponCode` are `optional()`, not `nullable()`.** The drawer still sends `{ lines }` and must keep
  getting its subtotal. `optional()` lets the key be missing; the checkout leaves it out until a zone is picked or a
  code applied.
- **`shopCouponResultSchema`** is a discriminated union on `status`, so each case has only its own fields: `none` has
  no code, `applied` has the discount (the same `shopDiscountSchema` a listing uses, so the promo box can print
  "10% off" or "৳50 off" with 26a's formatting), `refused` has a reason. The reason is an `enum` of three error
  codes, not any `ErrorCode`: the promo box has words for exactly these three, and the test proves that a server
  sending `internal_error` there is refused, not shown as a coupon problem. `minimum` is `nullable()` because only one
  reason has an amount.
- **The new quote fields** each have one job, and the comment above the schema says it. Two of them are worth
  repeating. `deliveryCharge` is `null` (not `'0'`) when no zone was sent, because "no charge yet" and "free" are
  different: the row says "Pick a location" for the first and "Free" for the second. `freeDelivery` is its own
  boolean, not "the charge is 0", because a shop could have a zone that costs nothing (a pick-up point) without any
  free-delivery rule; "Free" would be the wrong word there.
- **`total` without a zone** is the items only. The checkout never offers Confirm Order before a zone is picked, so a
  total without delivery is never what the shopper pays.

The new section at the end, in the order a checkout uses it:

- **`SHOP_PAYMENT_METHODS`** is a `const` tuple, so `z.enum` and the `ShopPaymentMethod` type come from one list.
- **`shopCheckoutSettingsSchema`** (decision 7). `zones` has at least one (a shop that delivers nowhere cannot take an
  order; the page would have no radio to pick) and at most six (three rows of the two-column radio cards). The
  amounts are `nullable()`: `null` is "no such rule", which is different from `'0'` ("free delivery on every order").
- **`asciiDigits`** turns Bangla digits into ASCII ones, the same rule as the ERP's PIN and money boxes. It is not
  exported: two schemas in this file use it, and the shop's browser code has its own copy (Zod never reaches the
  browser scripts, 26b's boundaries test).
- **`shopPhoneSchema`** (decision 11) is a `transform` then a `refine`. The transform runs first, so the check sees
  the plain 11 digits. `(?=1)` in `^(?:\+?880)(?=1)` replaces the country code only when a `1` follows it, so
  "880 1786…" becomes "01786…", and a string that merely starts with 880 and goes on with another digit is left for
  the check to refuse. The check is `^01[3-9]\d{8}$`: Bangladesh's mobile numbers start with 013 to 019 (there is no
  012 operator), and the test keeps that rule.
- **`shopOrderRequestSchema`** (decision 10). `lines` has at least one: an empty cart has nothing to order, and the
  code `shop_cart_empty` tells the checkout to show the empty state. `name` and `address` are trimmed, so a name of
  three spaces is "required", not a name. `address` needs at least 10 characters: "Sylhet" alone gets an order to
  the city but not to the door. `termsAccepted: z.literal(true, …)` refuses `false` with its own code; the shop owner
  may have to show that the shopper agreed.
- **`SHOP_CODE_LENGTH`, `SHOP_CODE_TRIES`, `SHOP_CODE_RESEND_SECONDS`** are the numbers of decision 4, named once
  here so the route, the page and the tests use the same ones.
- **`shopOrderPlacedSchema`** says which page comes next. The order's secret token is not in it: the route sets it as
  an httpOnly cookie (26c.3), which no script can read, so a script injected into the page could not steal it. The
  test parses an answer with a `token` and checks it is dropped. `maskedPhone` hides the middle digits, because a
  shopper shares a screenshot of a waiting page more often than they think.
- **`shopVerifyCodeRequestSchema`** strips spaces as well as converting digits: an SMS app that copies "123 456"
  pastes it with the space.
- **`shopOrderConfirmedSchema`** is the answer to a right code, and the same fields as the `confirmed` case of
  `shopOrderPlacedSchema`, so one dialog serves both ways an order is confirmed.
- **`SHOP_ORDER_STATUSES`** is the system design's list (§14.3). The shop only shows them; the ERP moves an order along
  (step 26's API).
- **`shopOrderLineSchema`** is `quoteLineListingSchema` plus the price at that moment (decision 13). It reuses the
  quote line's listing part, so the order page can draw a line with the same component as the checkout.
- **`shopOrderSchema`** carries `history`, oldest first, so the timeline can put a date under each step that happened
  and leave the steps ahead without one. `couponCode` is `nullable()`: the order page writes "Discount (WELCOME10)"
  only when there was one.
- **`ShopOrderRequestInput`** is `z.input`, not `z.infer`: the form holds what the shopper typed ("+880 1786-120356"),
  and the schema's output is the plain phone. `react-hook-form` needs the input type for its values (26c.4).

### `src/errors.ts`

```diff
@@ -600,6 +600,32 @@ export const ERROR_CODES = [
   'pin_format',
   'pin_too_easy',
   'pin_mismatch',
+  // Step 26c: the shop's checkout. The form's own rules (a coupon with other characters, a phone
+  // that is not a Bangladeshi mobile, an address too short for a courier, the terms not ticked, a
+  // code that is not six digits) and what a coupon can answer in the quote
+  'shop_coupon_format',
+  'shop_coupon_unknown',
+  'shop_coupon_expired',
+  'shop_coupon_minimum',
+  'shop_phone_format',
+  'shop_address_too_short',
+  'shop_terms_required',
+  'shop_code_format',
+  // Confirm Order refused: the cart is empty, the zone or the payment method is not offered (any
+  // more), the order is under the shop's minimum, or its total is not the one the shopper saw
+  // (a price, the stock or the coupon changed: the checkout prices the cart again)
+  'shop_cart_empty',
+  'shop_zone_unknown',
+  'shop_payment_unavailable',
+  'shop_order_below_minimum',
+  'shop_order_changed',
+  // The phone code: wrong (the problem says how many tries are left), too many wrong ones (the
+  // order is dropped and the shopper starts again), asked again too soon, or no order waits for a
+  // code in this browser (the cookie is gone, or it was confirmed already)
+  'shop_code_wrong',
+  'shop_code_too_many',
+  'shop_code_resend_wait',
+  'shop_code_no_order',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Seventeen new codes, in three groups with a comment each. They are codes, not messages: the words live in
`errors.*` in `en.ts` and `bn.ts` (26c.2), and both the shop and, later, the ERP's own order screens
show them. `shop_code_wrong` will carry `params.triesLeft` in its problem, and `shop_order_below_minimum` carries
`params.minimum`, so the words can say how many tries are left and how much is needed.

### `src/storefront.spec.ts`

```diff
@@ -7,7 +7,13 @@ import {
   shopCartQuoteLineSchema,
   shopCartQuoteRequestSchema,
   shopCartQuoteSchema,
+  shopCheckoutSettingsSchema,
+  shopOrderPlacedSchema,
+  shopOrderRequestSchema,
+  shopOrderSchema,
+  shopPhoneSchema,
   shopProductSchema,
+  shopVerifyCodeRequestSchema,
 } from './storefront.js';
 
 // A shopper in Sylhet with two face washes and a tea in her cart
@@ -133,6 +139,19 @@ describe('cart quote request', () => {
   });
 });
 
+// Step 26c: a quote with nothing in it, for the tests that change one field
+const EMPTY_QUOTE = {
+  lines: [],
+  itemCount: 0,
+  subtotal: '0.0000',
+  discount: '0.0000',
+  coupon: { status: 'none' },
+  deliveryCharge: null,
+  freeDelivery: false,
+  total: '0.0000',
+  belowMinimum: false,
+};
+
 describe('cart quote', () => {
   const image = NEEM_PRODUCT.images[0];
 
@@ -163,6 +182,12 @@ describe('cart quote', () => {
       ],
       itemCount: 2,
       subtotal: '458.0000',
+      discount: '0.0000',
+      coupon: { status: 'none' },
+      deliveryCharge: null,
+      freeDelivery: false,
+      total: '458.0000',
+      belowMinimum: false,
     };
     expect(shopCartQuoteSchema.parse(quote)).toEqual(quote);
   });
@@ -182,7 +207,204 @@ describe('cart quote', () => {
   });
 
   it('refuses a total written for people', () => {
-    const result = shopCartQuoteSchema.safeParse({ lines: [], itemCount: 0, subtotal: '1,199' });
+    const result = shopCartQuoteSchema.safeParse({ ...EMPTY_QUOTE, subtotal: '1,199' });
     expect(result.success).toBe(false);
   });
+
+  it('says why a coupon did nothing, with the minimum when that is the reason', () => {
+    const coupon = {
+      status: 'refused',
+      code: 'FLAT50',
+      reason: 'shop_coupon_minimum',
+      minimum: '500',
+    };
+    expect(shopCartQuoteSchema.parse({ ...EMPTY_QUOTE, coupon }).coupon).toEqual(coupon);
+  });
+
+  it('never refuses a coupon with a reason it has no words for', () => {
+    const coupon = { status: 'refused', code: 'FLAT50', reason: 'internal_error', minimum: null };
+    expect(shopCartQuoteSchema.safeParse({ ...EMPTY_QUOTE, coupon }).success).toBe(false);
+  });
+});
+
+describe('cart quote request at the checkout', () => {
+  it('takes the zone and a coupon, written the way the shop stores it', () => {
+    const parsed = shopCartQuoteRequestSchema.parse({
+      lines: [{ listingId: NEEM, quantity: 2 }],
+      zoneId: 'outside_dhaka',
+      couponCode: ' welcome10 ',
+    });
+    expect(parsed).toEqual({
+      lines: [{ listingId: NEEM, quantity: 2 }],
+      zoneId: 'outside_dhaka',
+      couponCode: 'WELCOME10',
+    });
+  });
+
+  it.each([
+    ['a space inside', 'WELCOME 10'],
+    ['an empty code', '   '],
+    ['a code longer than any flyer prints', 'A'.repeat(21)],
+  ])('refuses a coupon with %s', (_, couponCode) => {
+    const result = shopCartQuoteRequestSchema.safeParse({ lines: [], couponCode });
+    expect(result.error?.issues).toMatchObject([
+      { path: ['couponCode'], message: 'shop_coupon_format' },
+    ]);
+  });
+});
+
+describe('checkout settings', () => {
+  const SETTINGS = {
+    zones: [
+      { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' },
+      { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120' },
+    ],
+    paymentMethods: ['cod', 'online'],
+    freeDeliveryFrom: '1000',
+    minimumOrder: null,
+  };
+
+  it('reads the zones and the payment methods', () => {
+    expect(shopCheckoutSettingsSchema.parse(SETTINGS)).toEqual(SETTINGS);
+  });
+
+  it('refuses a shop that delivers nowhere', () => {
+    expect(shopCheckoutSettingsSchema.safeParse({ ...SETTINGS, zones: [] }).success).toBe(false);
+  });
+});
+
+describe('mobile number', () => {
+  it.each([
+    ['as it is written on a card', '01786120356'],
+    ['with the country code', '+8801786120356'],
+    ['with spaces and a dash', '+880 1786-120356'],
+    ['without the plus', '8801786120356'],
+    ['in Bangla digits', '০১৭৮৬১২০৩৫৬'],
+  ])('reads a number %s', (_, phone) => {
+    expect(shopPhoneSchema.parse(phone)).toBe('01786120356');
+  });
+
+  it.each([
+    ['a Dhaka landline', '029123456'],
+    ['an operator digit that does not exist', '01286120356'],
+    ['a digit short', '0178612035'],
+    ['a foreign number', '+447911123456'],
+    ['letters', '01786I20356'],
+  ])('refuses %s', (_, phone) => {
+    expect(shopPhoneSchema.safeParse(phone).error?.issues).toMatchObject([
+      { message: 'shop_phone_format' },
+    ]);
+  });
+});
+
+describe('order request', () => {
+  const ORDER = {
+    lines: [{ listingId: NEEM, quantity: 2 }],
+    zoneId: 'outside_dhaka',
+    name: 'Shamim Ahmed',
+    phone: '+880 1786-120356',
+    address: 'House 12, Road 5, Zindabazar, Sylhet',
+    paymentMethod: 'cod',
+    termsAccepted: true,
+    expectedTotal: '578',
+  };
+
+  it('takes the delivery details, with the phone made plain', () => {
+    expect(shopOrderRequestSchema.parse(ORDER)).toEqual({ ...ORDER, phone: '01786120356' });
+  });
+
+  it('drops an amount the browser tried to set', () => {
+    const parsed = shopOrderRequestSchema.parse({ ...ORDER, deliveryCharge: '0', discount: '578' });
+    expect(parsed).not.toHaveProperty('deliveryCharge');
+    expect(parsed).not.toHaveProperty('discount');
+  });
+
+  it.each([
+    ['an empty cart', { lines: [] }, 'lines', 'shop_cart_empty'],
+    ['no name', { name: '   ' }, 'name', 'required'],
+    ['an address no courier can find', { address: 'Sylhet' }, 'address', 'shop_address_too_short'],
+    ['the terms not ticked', { termsAccepted: false }, 'termsAccepted', 'shop_terms_required'],
+  ])('refuses %s', (_, change, field, code) => {
+    const result = shopOrderRequestSchema.safeParse({ ...ORDER, ...change });
+    expect(result.error?.issues).toMatchObject([{ path: [field], message: code }]);
+  });
+
+  it('refuses a payment method the shop has no word for', () => {
+    expect(shopOrderRequestSchema.safeParse({ ...ORDER, paymentMethod: 'card' }).success).toBe(
+      false,
+    );
+  });
+});
+
+describe('order placed', () => {
+  it('sends a cash order to the phone code without its number in full', () => {
+    const placed = { next: 'verify', maskedPhone: '+880 17•• ••• 356', resendInSeconds: 45 };
+    expect(shopOrderPlacedSchema.parse(placed)).toEqual(placed);
+  });
+
+  it('never carries the order token', () => {
+    const parsed = shopOrderPlacedSchema.parse({
+      next: 'confirmed',
+      orderNo: 'W-000123',
+      phone: '01786120356',
+      token: 'secret',
+    });
+    expect(parsed).not.toHaveProperty('token');
+  });
+});
+
+describe('phone code', () => {
+  it.each([
+    ['six digits', '123456'],
+    ['Bangla digits', '১২৩৪৫৬'],
+    ['digits a phone pasted with spaces', '123 456'],
+  ])('reads %s', (_, code) => {
+    expect(shopVerifyCodeRequestSchema.parse({ code })).toEqual({ code: '123456' });
+  });
+
+  it.each([
+    ['five digits', '12345'],
+    ['a letter', '12345O'],
+  ])('refuses %s', (_, code) => {
+    expect(shopVerifyCodeRequestSchema.safeParse({ code }).error?.issues).toMatchObject([
+      { path: ['code'], message: 'shop_code_format' },
+    ]);
+  });
+});
+
+describe('order', () => {
+  it('reads a placed order with its history', () => {
+    const order = {
+      orderNo: 'W-000123',
+      placedAt: '2026-11-11T15:20:00+06:00',
+      status: 'confirmed',
+      history: [
+        { status: 'pending', at: '2026-11-11T15:20:00+06:00' },
+        { status: 'confirmed', at: '2026-11-11T15:21:30+06:00' },
+      ],
+      name: 'Shamim Ahmed',
+      phone: '01786120356',
+      address: 'House 12, Road 5, Zindabazar, Sylhet',
+      zoneName: 'Outside Dhaka',
+      paymentMethod: 'cod',
+      lines: [
+        {
+          listingId: NEEM,
+          slug: NEEM_PRODUCT.slug,
+          name: NEEM_PRODUCT.name,
+          packSize: '150ml',
+          image: NEEM_PRODUCT.images[0],
+          quantity: 2,
+          unitPrice: '229',
+          lineTotal: '458.0000',
+        },
+      ],
+      subtotal: '458.0000',
+      discount: '0.0000',
+      couponCode: null,
+      deliveryCharge: '120',
+      total: '578.0000',
+    };
+    expect(shopOrderSchema.parse(order)).toEqual(order);
+  });
 });
```

26b's quote test gets the new fields, and the new tests follow the checkout from the first quote to the order page.

- **`EMPTY_QUOTE`** is a quote with nothing in it. Each test that is about one field spreads it and changes that one,
  so the test says what it is about.
- **"takes the zone and a coupon, written the way the shop stores it"** proves the trim and the upper-case. The code
  that comes back is `WELCOME10`.
- **The phone tests** are the ways a shopper in Bangladesh writes their number, and the ways it can be wrong: a Dhaka
  landline (a courier can call it, but no SMS reaches it), the 012 that no operator has, a digit short, a UK number,
  and a capital I typed for a 1.
- **"drops an amount the browser tried to set"** is 26b's price test for the order: a `deliveryCharge` or a
  `discount` in the request is gone after parsing, so no code can read it by mistake.
- **"never carries the order token"** guards decision 4: if someone adds the token to the answer schema "to make the
  client simpler", this test fails.

## 26c.2 — `packages/i18n`: the words

### `src/locales/en.ts`

```diff
@@ -5535,6 +5535,102 @@ export const en = {
       emptyText: 'Add products with “Add to cart” and they wait for you here.',
       continueShopping: 'Continue shopping',
     },
+    // Step 26c: /checkout (Figma checkout_process). The words of the React island come from here
+    // too: the page translates them on the server and hands them over as props
+    checkout: {
+      title: 'Checkout',
+      // The browser tab: the page, then the shop
+      pageTitle: 'Checkout | {{shop}}',
+      heading: 'Shipping & Contact Details',
+      name: 'Full Name',
+      phone: 'Mobile Number',
+      address: 'Delivery Address',
+      zone: 'Delivery Location',
+      zoneOption: '{{name}} — {{charge}}',
+      freeDeliveryFrom: 'Free delivery on orders over {{amount}}',
+      items: 'Your items',
+      outOfStock: 'Out of stock: remove it to order',
+      // Under a line whose price changed after Confirm Order was refused (shop_order_changed)
+      priceChanged: 'Was {{old}}',
+      deliveryCharge: 'Delivery Charge',
+      free: 'Free',
+      // In the Delivery Charge row before a location is picked
+      pickZone: 'Pick a location',
+      discount: 'Discount ({{code}})',
+      total: 'Total',
+      promo: 'Promo code',
+      promoPlaceholder: 'Add Promo',
+      apply: 'Apply Coupon',
+      applying: 'Applying…',
+      removeCoupon: 'Remove the code',
+      couponApplied: '{{code}} applied: {{off}} off',
+      payment: 'Payment Method',
+      cod: 'Cash on Delivery',
+      online: 'Mobile Banking',
+      // Three parts, because the link sits inside the sentence and Bangla puts it first
+      termsBefore: 'I agree with the ',
+      termsLink: 'Terms and Conditions',
+      termsAfter: '',
+      confirm: 'Confirm Order',
+      placing: 'Placing the order…',
+      // No answer from the server: the order may not have reached it
+      orderFailed: 'The order was not sent. Check the connection, then try again.',
+      belowMinimum: 'Orders start at {{minimum}}. Add {{more}} more to order.',
+      emptyTitle: 'Your cart is empty',
+      emptyText: 'Add products to your cart, then come back here to order them.',
+    },
+    // Step 26c: /checkout/verify, the phone code for Cash on Delivery
+    verify: {
+      title: 'Verify Your Phone',
+      pageTitle: 'Verify your phone | {{shop}}',
+      sent: 'We sent a 6-digit code to {{phone}}',
+      code: '6-digit code',
+      triesLeft_one: '{{count}} try left.',
+      triesLeft_other: '{{count}} tries left.',
+      resend: 'Resend code',
+      resendIn: 'in {{time}}',
+      resent: 'A new code is on its way.',
+      checking: 'Checking the code…',
+      // No answer from the server: the code may not have reached it
+      failed: 'The code was not sent. Check the connection, then try again.',
+      // Only in the mock shop, which sends no SMS
+      mockCode: 'Test shop: no SMS is sent. The code is {{code}}.',
+      startAgain: 'Back to checkout',
+    },
+    // Step 26c: the dialog after the order (Figma confirmation_status)
+    confirmed: {
+      title: 'Order Confirmed',
+      // The phone sits between two parts, in weight 500
+      textBefore: 'We have received your order. We’ll send updates by SMS to ',
+      textAfter: '.',
+      close: 'Close',
+      details: 'View Order Details',
+      continueShopping: 'Continue shopping',
+    },
+    // Step 26c: /order/<no>
+    order: {
+      title: 'Order Details',
+      // The browser tab: the number, then the shop
+      pageTitle: 'Order {{orderNo}} | {{shop}}',
+      placedOn: 'Placed on {{date}}',
+      timeline: 'Order status',
+      statuses: {
+        pending: 'Order placed',
+        confirmed: 'Confirmed',
+        packed: 'Packed',
+        shipped: 'On the way',
+        delivered: 'Delivered',
+        cancelled: 'Cancelled',
+        returned: 'Returned',
+      },
+      delivery: 'Delivery details',
+      payment: 'Payment',
+      items: 'Items',
+      lineQuantity: '{{quantity}} × {{price}}',
+      subtotal: 'Subtotal',
+      // The Delivery Charge row of an order that went out for free
+      free: 'Free',
+    },
     footer: {
       pages: 'Shop pages',
       social: '{{shop}} on social media',
@@ -7265,6 +7361,24 @@ export const en = {
     pin_format: 'Use exactly 6 digits.',
     pin_too_easy: 'Pick a PIN that is harder to guess than 123456 or 000000.',
     pin_mismatch: 'The two PINs are different. Type the same 6 digits in both boxes.',
+    // Step 26c: the shop's checkout and phone code
+    shop_coupon_format: 'A code has only letters, digits and dashes, up to 20.',
+    shop_coupon_unknown: 'This code does not exist. Check how it is spelled.',
+    shop_coupon_expired: 'This code has expired.',
+    shop_coupon_minimum: 'This code needs items worth {{minimum}} or more.',
+    shop_phone_format: 'Type a Bangladeshi mobile number, like 01786 120356.',
+    shop_address_too_short: 'Write the house, the road and the area, so the courier can find you.',
+    shop_terms_required: 'Tick the box to agree with the terms.',
+    shop_code_format: 'Type the 6 digits from the SMS.',
+    shop_cart_empty: 'Your cart is empty. Add a product first.',
+    shop_zone_unknown: 'Pick a delivery location.',
+    shop_payment_unavailable: 'This payment method is not offered now. Pick another one.',
+    shop_order_below_minimum: 'Orders start at {{minimum}}. Add more items to order.',
+    shop_order_changed: 'A price or the stock changed. Check the new total, then confirm again.',
+    shop_code_wrong: 'That code is wrong. Check the SMS and type it again.',
+    shop_code_too_many: 'Too many wrong codes. Place the order again to get a new code.',
+    shop_code_resend_wait: 'Wait a little, then ask for a new code.',
+    shop_code_no_order: 'No order is waiting for a code. Place the order again.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

Four new groups under `shop`, after `cart`, and the error words.

- **The checkout keeps Figma's capitals** ("Full Name", "Confirm Order", "Apply Coupon"), like 26a and 26b: the
  storefront follows Figma's copy, not the ERP's sentence case. New words that Figma does not have ("Pick a location",
  "Placing the order…") are written the same way as their neighbours.
- **`termsBefore`, `termsLink`, `termsAfter`** are three keys because the link sits inside the sentence. A React
  island cannot put a link inside a translated string without a library for it, and the order of the parts differs:
  Bangla puts the link first ("আমি শর্তাবলি মেনে নিচ্ছি"), so `termsAfter` is empty in English and not in Bangla.
- **`confirmed.textBefore` / `textAfter`** are split around the phone for the same reason: Figma draws the phone at
  weight 500 in `body`, inside the sentence.
- **`verify.triesLeft_one` / `_other`** is a plural pair, shown after `errors.shop_code_wrong` ("That code is wrong.
  Check the SMS and type it again. 2 tries left."). The error says what to do; the count says how careful to be.
- **`verify.mockCode`** is shown only by the mock shop, which sends no SMS. It still goes through `t()` (every string
  the shopper can see does), and it says plainly that this is a test shop.
- **`order.statuses`** are the shopper's words for the system design's statuses: `shipped` is "On the way", because a
  shopper does not ship anything; `pending` is "Order placed", because to the shopper nothing is pending.
- **The error words say how to fix the problem**, per `CLAUDE.md` → Copy: "Write the house, the road and the area, so
  the courier can find you" instead of "Address too short". `shop_phone_format` shows a number in the shape it wants.
- **Three words came with the checkout's screen (26c.4)** and are in this diff too: `checkout.pageTitle` (the browser
  tab, "Checkout | Omnivo", the same shape as the product page's title), `checkout.priceChanged` ("Was ৳229", under a
  line whose price moved after Confirm Order was refused) and `checkout.orderFailed` (no answer at all from the server,
  where `errors.internal_error`'s "on our side" would be a guess).
- **Five words came with the verify and order pages (26c.5):** `verify.pageTitle` and `order.pageTitle` (the browser
  tab; the order's carries its number, so two open orders can be told apart), `verify.checking` (the button while
  the code is checked), `verify.failed` (no answer from the server, like `checkout.orderFailed`) and `order.free`
  (the Delivery Charge row of an order that went out for free: an order keeps the charge, not the reason).

### `src/locales/bn.ts`

```diff
@@ -5167,6 +5167,87 @@ export const bn: Messages = {
       emptyText: '"কার্টে যোগ করুন" চাপলে পণ্য এখানে অপেক্ষা করবে।',
       continueShopping: 'কেনাকাটা চালিয়ে যান',
     },
+    checkout: {
+      title: 'চেকআউট',
+      pageTitle: 'চেকআউট | {{shop}}',
+      heading: 'ডেলিভারি ও যোগাযোগের তথ্য',
+      name: 'পুরো নাম',
+      phone: 'মোবাইল নম্বর',
+      address: 'ডেলিভারির ঠিকানা',
+      zone: 'ডেলিভারির এলাকা',
+      zoneOption: '{{name}} — {{charge}}',
+      freeDeliveryFrom: '{{amount}}-এর বেশি অর্ডারে ডেলিভারি ফ্রি',
+      items: 'আপনার পণ্য',
+      outOfStock: 'স্টকে নেই: অর্ডার করতে এটি সরান',
+      priceChanged: 'আগে ছিল {{old}}',
+      deliveryCharge: 'ডেলিভারি চার্জ',
+      free: 'ফ্রি',
+      pickZone: 'এলাকা বেছে নিন',
+      discount: 'ছাড় ({{code}})',
+      total: 'মোট',
+      promo: 'প্রোমো কোড',
+      promoPlaceholder: 'প্রোমো কোড লিখুন',
+      apply: 'কুপন প্রয়োগ করুন',
+      applying: 'প্রয়োগ হচ্ছে…',
+      removeCoupon: 'কোডটি সরান',
+      couponApplied: '{{code}} প্রয়োগ হয়েছে: {{off}} ছাড়',
+      payment: 'পেমেন্টের উপায়',
+      cod: 'ক্যাশ অন ডেলিভারি',
+      online: 'মোবাইল ব্যাংকিং',
+      termsBefore: 'আমি ',
+      termsLink: 'শর্তাবলি',
+      termsAfter: ' মেনে নিচ্ছি',
+      confirm: 'অর্ডার নিশ্চিত করুন',
+      placing: 'অর্ডার দেওয়া হচ্ছে…',
+      orderFailed: 'অর্ডারটি পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
+      belowMinimum: 'সবচেয়ে ছোট অর্ডার {{minimum}}। অর্ডার করতে আরও {{more}}-এর পণ্য যোগ করুন।',
+      emptyTitle: 'আপনার কার্ট খালি',
+      emptyText: 'কার্টে পণ্য যোগ করে এখানে ফিরে এসে অর্ডার করুন।',
+    },
+    verify: {
+      title: 'ফোন নম্বর যাচাই করুন',
+      pageTitle: 'ফোন নম্বর যাচাই | {{shop}}',
+      sent: '{{phone}} নম্বরে ৬ অঙ্কের একটি কোড পাঠিয়েছি',
+      code: '৬ অঙ্কের কোড',
+      triesLeft_one: 'আর {{count}} বার চেষ্টা করা যাবে।',
+      triesLeft_other: 'আর {{count}} বার চেষ্টা করা যাবে।',
+      resend: 'আবার কোড পাঠান',
+      resendIn: '{{time}} পরে',
+      resent: 'নতুন কোড পাঠানো হয়েছে।',
+      checking: 'কোড মেলানো হচ্ছে…',
+      failed: 'কোডটি পাঠানো যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
+      mockCode: 'টেস্ট শপ: কোনো SMS যায় না। কোড হলো {{code}}।',
+      startAgain: 'চেকআউটে ফিরে যান',
+    },
+    confirmed: {
+      title: 'অর্ডার নিশ্চিত হয়েছে',
+      textBefore: 'আপনার অর্ডার পেয়েছি। ',
+      textAfter: ' নম্বরে SMS-এ অর্ডারের খবর পাঠাব।',
+      close: 'বন্ধ করুন',
+      details: 'অর্ডারের বিস্তারিত দেখুন',
+      continueShopping: 'কেনাকাটা চালিয়ে যান',
+    },
+    order: {
+      title: 'অর্ডারের বিস্তারিত',
+      pageTitle: 'অর্ডার {{orderNo}} | {{shop}}',
+      placedOn: '{{date}} তারিখে দেওয়া',
+      timeline: 'অর্ডারের অবস্থা',
+      statuses: {
+        pending: 'অর্ডার দেওয়া হয়েছে',
+        confirmed: 'নিশ্চিত হয়েছে',
+        packed: 'প্যাক হয়েছে',
+        shipped: 'পথে আছে',
+        delivered: 'ডেলিভারি হয়েছে',
+        cancelled: 'বাতিল হয়েছে',
+        returned: 'ফেরত এসেছে',
+      },
+      delivery: 'ডেলিভারির তথ্য',
+      payment: 'পেমেন্ট',
+      items: 'পণ্য',
+      lineQuantity: '{{quantity}} × {{price}}',
+      subtotal: 'সাবটোটাল',
+      free: 'ফ্রি',
+    },
     footer: {
       pages: 'দোকানের পেজ',
       social: 'সোশ্যাল মিডিয়ায় {{shop}}',
@@ -6823,6 +6904,23 @@ export const bn: Messages = {
     pin_format: 'ঠিক ৬টা অঙ্ক লিখুন।',
     pin_too_easy: '123456 বা 000000-এর মতো সহজে আন্দাজ করা যায়, এমন PIN না দিয়ে অন্য একটা বাছুন।',
     pin_mismatch: 'দুটো PIN আলাদা হয়েছে। দুই ঘরেই একই ৬টা অঙ্ক লিখুন।',
+    shop_coupon_format: 'কোডে শুধু অক্ষর, অঙ্ক আর ড্যাশ থাকে, সর্বোচ্চ ২০টি।',
+    shop_coupon_unknown: 'এই কোডটি নেই। বানান ঠিক আছে কিনা দেখুন।',
+    shop_coupon_expired: 'এই কোডের মেয়াদ শেষ।',
+    shop_coupon_minimum: 'এই কোড ব্যবহার করতে কমপক্ষে {{minimum}}-এর পণ্য লাগবে।',
+    shop_phone_format: 'বাংলাদেশের একটি মোবাইল নম্বর লিখুন, যেমন 01786 120356।',
+    shop_address_too_short: 'বাড়ি, রাস্তা আর এলাকা লিখুন, যাতে কুরিয়ার আপনাকে খুঁজে পায়।',
+    shop_terms_required: 'শর্তাবলি মেনে নিতে ঘরে টিক দিন।',
+    shop_code_format: 'SMS-এর ৬টি অঙ্ক লিখুন।',
+    shop_cart_empty: 'আপনার কার্ট খালি। আগে একটি পণ্য যোগ করুন।',
+    shop_zone_unknown: 'ডেলিভারির এলাকা বেছে নিন।',
+    shop_payment_unavailable: 'এই পেমেন্টের উপায় এখন নেওয়া হচ্ছে না। অন্য একটি বেছে নিন।',
+    shop_order_below_minimum: 'অর্ডার শুরু {{minimum}} থেকে। অর্ডার করতে আরও পণ্য যোগ করুন।',
+    shop_order_changed: 'দাম বা স্টক বদলে গেছে। নতুন মোট দেখে আবার নিশ্চিত করুন।',
+    shop_code_wrong: 'কোডটি ভুল। SMS দেখে আবার লিখুন।',
+    shop_code_too_many: 'অনেকবার ভুল কোড দেওয়া হয়েছে। নতুন কোড পেতে আবার অর্ডার দিন।',
+    shop_code_resend_wait: 'একটু অপেক্ষা করে নতুন কোড চান।',
+    shop_code_no_order: 'কোনো অর্ডার কোডের অপেক্ষায় নেই। আবার অর্ডার দিন।',
   },
   ui: {
     dataTable: {
```

The same keys in Bangla. `bn.ts` is typed against `en.ts`, and `errors` against `ErrorCode`, so a missing key fails
`tsc`. SMS, PO-style office words and the example phone number stay as they are.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm exec eslint packages/contracts/src packages/i18n/src/locales
```

The contracts are built first because `@omnivo/i18n` reads them from `dist/`: without the build, `en.ts` fails with
"`shop_coupon_format` does not exist in type `Record<ErrorCode, string>`" (seen while writing this step).

`pnpm --filter @omnivo/shop typecheck` fails after this part, on purpose and in one place:
`src/data/mock/quote.ts` does not return the quote's new fields yet. 26c.3 gives the mock the zones, the coupons and
the rest, and the shop type-checks again.

## 26c.3 — `apps/shop`: the checkout's server

This part gives the mock shop what a checkout needs: delivery zones, coupons, a minimum order, and somewhere to keep
orders. Then three API routes place an order, check its phone code and send a new code. No page changes yet; 26c.4
draws the checkout, and 26c.5 the verify page, the dialog and the order page.

Everything the routes do goes through `ShopSource`, as in 26b. The mock source does it in memory; step 26's API will
do it with tables, and only `data/source.ts` changes then.

### `src/data/mock/checkout.ts`

```ts
import type { ShopCheckoutSettings, ShopDiscount } from '@omnivo/contracts';

// Step 26c: what the mock shop offers at checkout. The zones and charges are Figma's
// (checkout_process: Inside Dhaka ৳80, Outside Dhaka ৳120); the amounts are the ones CLAUDE.md's
// storefront section uses in its examples ("Free delivery on orders over ৳1,000").
export const mockCheckoutSettings = {
  zones: [
    { id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' },
    { id: 'outside_dhaka', name: 'Outside Dhaka', charge: '120' },
  ],
  paymentMethods: ['cod', 'online'],
  freeDeliveryFrom: '1000',
  // Low enough that one face wash and a tea pack reach it, high enough that a test can go under it
  minimumOrder: '300',
} satisfies ShopCheckoutSettings;

// A coupon as the shop keeps it. Not a contract: the shopper never sees a coupon list, only what
// one code did to their cart (ShopCouponResult). The real coupons live in step 26's API.
export interface MockCoupon {
  // Upper case, as couponCodeSchema leaves the shopper's code
  code: string;
  discount: ShopDiscount;
  // The items must be worth at least this much (the subtotal, decision 8). null: any amount
  minimum: string | null;
  // The last day it works, in the shop's time zone (ISO date). null: it never expires
  lastDay: string | null;
}

// One of each case the promo box has words for: a percent, a fixed amount with a minimum, and an
// expired code. Any other code is unknown
export const mockCoupons: MockCoupon[] = [
  { code: 'WELCOME10', discount: { kind: 'percent', value: 10 }, minimum: null, lastDay: null },
  { code: 'FLAT50', discount: { kind: 'amount', value: '50' }, minimum: '500', lastDay: null },
  {
    code: 'OLD2025',
    discount: { kind: 'percent', value: 20 },
    minimum: null,
    lastDay: '2025-12-31',
  },
];
```

- **`mockCheckoutSettings`** uses `satisfies ShopCheckoutSettings`, not a type annotation. The schema's rules (one to
  six zones, money as strings) are checked at compile time, and the value keeps its literal type, so a test can read
  `mockCheckoutSettings.zones[0].charge` without a "possibly undefined".
- **`minimumOrder: '300'`** is low enough that one face wash and a tea pack reach it, and high enough that a test can
  go under it with two sachets of stevia (৳240).
- **`MockCoupon` is not a contract.** The shopper never sees a list of coupons, only what one code did to their cart
  (`ShopCouponResult`, 26c.1). The real coupons will be a table in step 26's API, with fields this mock does not need
  (how many times a code may be used, which products it covers).
- **`lastDay` is a date, not a moment.** A shop owner says "the code works until 31 December", meaning the end of that
  day in Dhaka. Storing `2025-12-31T23:59:59Z` instead would end it at 6 am on 1 January in Dhaka, or, written in
  local time by hand, be one more thing to get wrong.
- **One coupon per case the promo box has words for:** a percent (`WELCOME10`), a fixed amount with a minimum
  (`FLAT50` from ৳500), and an expired one (`OLD2025`). Any other code is unknown. 26c.4's checkout is tried with
  these four cases by hand.

### `src/data/mock/quote.ts`

```diff
@@ -1,17 +1,38 @@
 import {
+  compareMoney,
   multiplyMoney,
+  percentOfMoney,
+  subtractMoney,
   sumMoney,
+  todayIn,
   type ShopCartQuote,
   type ShopCartQuoteLine,
   type ShopCartQuoteRequest,
+  type ShopCheckoutSettings,
+  type ShopCouponResult,
+  type ShopDiscount,
   type ShopListing,
 } from '@omnivo/contracts';
 
+import type { MockCoupon } from './checkout';
+
+// Step 26c: what the quote needs besides the request: the listings, the shop's checkout settings
+// and coupons, the shop's time zone and the moment (a coupon's last day is a day in Dhaka, not in
+// UTC). One object, so a test changes only the part it is about.
+export interface QuoteContext {
+  catalog: ShopListing[];
+  settings: ShopCheckoutSettings;
+  coupons: MockCoupon[];
+  timeZone: string;
+  now: Date;
+}
+
 // Step 26b: the mock's cart prices, worked out the way the real API will (step 26): each line at
 // the listing's price today, summed on the server. Never with JavaScript numbers: 3 × ৳49.90 is
 // 149.70000000000002 in floating point, so the money helpers work in whole ten-thousandths.
-export function quoteCart(request: ShopCartQuoteRequest, catalog: ShopListing[]): ShopCartQuote {
-  const byId = new Map(catalog.map((listing) => [listing.id, listing]));
+// Step 26c: also the coupon, the delivery charge, the total and the minimum order.
+export function quoteCart(request: ShopCartQuoteRequest, context: QuoteContext): ShopCartQuote {
+  const byId = new Map(context.catalog.map((listing) => [listing.id, listing]));
 
   const lines = request.lines.map((line): ShopCartQuoteLine => {
     const listing = byId.get(line.listingId);
@@ -40,9 +61,63 @@ export function quoteCart(request: ShopCartQuoteRequest, catalog: ShopListing[])
 
   // Only what can be sold counts: an out-of-stock line stays on screen but adds nothing
   const sold = lines.filter((line) => line.status === 'available');
+  const subtotal = sumMoney(sold.map((line) => line.lineTotal));
+
+  const coupon = couponResult(request.couponCode, subtotal, context);
+  const discount = coupon.status === 'applied' ? discountOf(coupon.discount, subtotal) : '0.0000';
+
+  const { settings } = context;
+  // Decision 8: both rules look at the subtotal, the items before the coupon
+  const freeDelivery =
+    settings.freeDeliveryFrom !== null && compareMoney(subtotal, settings.freeDeliveryFrom) >= 0;
+  const belowMinimum =
+    settings.minimumOrder !== null && compareMoney(subtotal, settings.minimumOrder) < 0;
+
+  // A zone id the shop does not have (any more) is treated as no zone: the checkout then says
+  // "Pick a location", which is what the shopper must do. Confirm Order refuses it on its own
+  const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
+  const deliveryCharge = zone ? (freeDelivery ? '0.0000' : sumMoney([zone.charge])) : null;
+
   return {
     lines,
     itemCount: sold.reduce((count, line) => count + line.quantity, 0),
-    subtotal: sumMoney(sold.map((line) => line.lineTotal)),
+    subtotal,
+    discount,
+    coupon,
+    deliveryCharge,
+    freeDelivery,
+    total: sumMoney([subtractMoney(subtotal, discount), deliveryCharge ?? '0']),
+    belowMinimum,
   };
 }
+
+// Decision 9: a code that does not apply is an answer, never an error. The checks go from "no such
+// code" to "not any more" to "not for this cart", so the reason given is the one that matters most
+function couponResult(
+  code: string | undefined,
+  subtotal: string,
+  context: QuoteContext,
+): ShopCouponResult {
+  if (code === undefined) return { status: 'none' };
+
+  const coupon = context.coupons.find((candidate) => candidate.code === code);
+  if (!coupon) return { status: 'refused', code, reason: 'shop_coupon_unknown', minimum: null };
+
+  // Today in the shop's time zone: at 1 am on 1 January in Dhaka it is still 31 December in UTC,
+  // and a code that ended on the 31st must not work then. ISO dates compare correctly as strings
+  if (coupon.lastDay !== null && todayIn(context.timeZone, context.now) > coupon.lastDay) {
+    return { status: 'refused', code, reason: 'shop_coupon_expired', minimum: null };
+  }
+  if (coupon.minimum !== null && compareMoney(subtotal, coupon.minimum) < 0) {
+    return { status: 'refused', code, reason: 'shop_coupon_minimum', minimum: coupon.minimum };
+  }
+  return { status: 'applied', code, discount: coupon.discount };
+}
+
+// What a coupon takes off the subtotal, to the paisa. A fixed amount never takes off more than the
+// items cost: ৳50 off a ৳30 cart is ৳30 off, so the total never goes below the delivery charge
+function discountOf(discount: ShopDiscount, subtotal: string): string {
+  if (discount.kind === 'percent') return percentOfMoney(subtotal, String(discount.value));
+  const amount = sumMoney([discount.value]);
+  return compareMoney(amount, subtotal) > 0 ? subtotal : amount;
+}
```

26b priced the lines and summed them. The rest of the bill is added after the subtotal, in the order a receipt
reads.

- **`QuoteContext`** replaces 26b's `catalog` argument. The quote now needs the settings, the coupons, the shop's
  time zone and the time, and five arguments in a row are easy to pass in the wrong order. As one object, a test
  changes only the part it is about (`{ ...context, coupons: [...] }`).
- **`now` is in the context**, not read with `new Date()` inside. Whether a coupon has expired depends on the time,
  and a test that depends on today's date passes today and fails next year.
- **The discount is worked out from the subtotal, then the rules.** `freeDelivery` and `belowMinimum` compare the
  subtotal, not the subtotal after the discount (decision 8).
- **`zone ? … : null`**: an unknown zone id gives `null`, the same as no zone (decision 16). `request.zoneId` may be
  `undefined`; `find` with `candidate.id === undefined` simply finds nothing, so no separate check is needed.
- **`sumMoney([zone.charge])`** rewrites `'80'` as `'80.0000'`. Every amount in the answer then has the same shape,
  and a test can compare strings. (`unitPrice` stays the listing's own string, as in 26b: it is the price as the shop
  typed it, not a sum.)
- **`total`** is `subtotal − discount + (deliveryCharge ?? '0')`. Without a zone it is the items only; the checkout
  does not offer Confirm Order then, so this total is never paid.
- **`couponResult`** checks in the order of what matters most: no such code, then expired, then under its minimum. A
  code that is both expired and under its minimum says "expired", because adding items would not help.
- **`todayIn(context.timeZone, context.now)`** is the contracts' helper the ERP uses for document dates. It gives the
  date in Dhaka as `YYYY-MM-DD`, and ISO dates compare correctly as strings, so `>` is enough. With
  `now.toISOString().slice(0, 10)` (the date in UTC), a code would still work for the first six hours of the next day
  in Dhaka; the test "ends a code at midnight in Dhaka" fails then (tried while writing this step).
- **`discountOf`** caps a fixed amount at the subtotal. Without the cap, ৳1,000 off a ৳120 cart would make the total
  negative before the delivery charge, and the order would pay the shopper.

### `src/data/types.ts`

```diff
@@ -3,10 +3,50 @@ import type {
   ShopCartQuote,
   ShopCartQuoteRequest,
   ShopCategory,
+  ShopCheckoutSettings,
+  ShopCodeResent,
   ShopHome,
+  ShopOrder,
+  ShopOrderConfirmed,
+  ShopOrderPlaced,
+  ShopOrderRequest,
   ShopProductPage,
 } from '@omnivo/contracts';
 
+// Step 26c: the reasons a source may refuse an order or a phone code. A closed list, not any
+// ErrorCode: the routes give each one its HTTP status (server/orders.ts), and a reason added here
+// without a status there fails the type check
+export type ShopRefusalCode =
+  | 'shop_zone_unknown'
+  | 'shop_payment_unavailable'
+  | 'shop_order_below_minimum'
+  | 'shop_order_changed'
+  | 'shop_code_wrong'
+  | 'shop_code_too_many'
+  | 'shop_code_resend_wait'
+  | 'shop_code_no_order';
+
+// What a source answers when it may say no. A refusal is a normal answer (a wrong code, a price
+// that changed), not an exception: `throw` stays for a source that is down, which the routes turn
+// into internal_error. `params` go into the error's words ("2 tries left", "Orders start at ৳300")
+export type SourceResult<T> =
+  | { ok: true; value: T }
+  | { ok: false; code: ShopRefusalCode; params?: Record<string, string | number> };
+
+// A placed order and its secret token. The token never reaches the browser's scripts: the route
+// puts it in an httpOnly cookie (decision 4), and only `answer` goes into the body
+export interface PlacedOrder {
+  answer: ShopOrderPlaced;
+  orderNo: string;
+  token: string;
+}
+
+// What /checkout/verify draws for the order that waits: the same as the `verify` answer, plus the
+// listings it holds. Step 26c.5: a right code takes them out of this browser's cart (decision 23),
+// and the page cannot know them otherwise: the order is on the server, and the cart may have
+// changed in another tab since Confirm Order
+export type ShopCodeWait = Extract<ShopOrderPlaced, { next: 'verify' }> & { listingIds: string[] };
+
 // What every data source answers. Its own file, so the mock can implement it without importing
 // source.ts, which imports the mock (a circle .dependency-cruiser.cjs refuses)
 export interface ShopSource {
@@ -19,4 +59,19 @@ export interface ShopSource {
   // Step 26b: today's prices for a cart. The route checks the request first
   // (shopCartQuoteRequestSchema), so a source never sees a quantity of 0 or one listing twice
   quote(request: ShopCartQuoteRequest): Promise<ShopCartQuote>;
+
+  // Step 26c: the checkout. The routes check every request with its schema first, as for quote()
+  checkoutSettings(): Promise<ShopCheckoutSettings>;
+  placeOrder(request: ShopOrderRequest): Promise<SourceResult<PlacedOrder>>;
+  // The order that waits for its phone code, found by the token from the cookie. null: none
+  // waits (never placed, confirmed already, dropped, or past its hour)
+  codeWait(token: string): Promise<ShopCodeWait | null>;
+  verifyCode(token: string, code: string): Promise<SourceResult<ShopOrderConfirmed>>;
+  resendCode(token: string): Promise<SourceResult<ShopCodeResent>>;
+  // A confirmed order for /order/<no>. Both must match: the number alone is easy to guess, and the
+  // page shows a phone and an address (decision 5). null for anything else
+  order(orderNo: string, token: string): Promise<ShopOrder | null>;
+  // The code a test shop takes, which the verify page shows because no SMS is sent. null for a real
+  // shop: its code goes only to the phone
+  readonly testCode: string | null;
 }
```

- **`ShopRefusalCode`** is a closed list of the eight ways a source may say no. It is not `ErrorCode`: every refusal
  needs an HTTP status, and `server/orders.ts` maps each one with `satisfies Record<ShopRefusalCode, …>`. A ninth code
  added here without a status fails the type check there (tried: adding `shop_cart_empty` gives two errors in
  `orders.ts`).
- **`SourceResult<T>`** is a result, not an exception, for the answers a shopper causes: a wrong code is normal
  traffic. A `throw` stays for a source that is down, which the routes turn into `internal_error`. Keeping the two
  apart means a route never has to guess whether an error is the shopper's or the server's.
- **`PlacedOrder`** carries the token next to the answer, never inside it. The route puts the token in a cookie and
  sends only `answer` as the body.
- **`ShopCodeWait`** is `Extract<ShopOrderPlaced, { next: 'verify' }>` plus `listingIds`: the verify page (26c.5)
  shows exactly what the `verify` answer has, so that part is taken from the contract, not written again. The ids
  were added in 26c.5: a right code must take the ordered lines out of the browser's cart (decision 23), and only the
  server knows which they were. They are not in the contract's answer, because no browser script asks for them: the
  page's server code reads them and writes them into the HTML.
- **`codeWait`**, **`verifyCode`**, **`resendCode`** take the token from the cookie, never an order number. **`order`**
  takes both: the number picks the order, and the token proves the browser placed it (decision 5).
- **`testCode`** is a property, not a check for "is this the mock" in the page. The verify page shows "The code is
  123456" when it is not `null`, and the real source sets it to `null`; nothing else needs to know which source runs.

### `src/data/mock/orders.ts`

```ts
import {
  compareMoney,
  SHOP_CODE_RESEND_SECONDS,
  SHOP_CODE_TRIES,
  type ShopCartQuote,
  type ShopCheckoutSettings,
  type ShopCodeResent,
  type ShopOrder,
  type ShopOrderConfirmed,
  type ShopOrderLine,
  type ShopOrderRequest,
} from '@omnivo/contracts';

import type { PlacedOrder, ShopCodeWait, SourceResult } from '../types';

// Step 26c: the mock's orders, kept in memory (decision 3). Everything here is what step 26's API
// will do with tables; the shape of the answers is the same, so the pages never change.

// The code the mock takes. It sends no SMS, so the verify page shows it (ShopSource.testCode)
export const MOCK_CODE = '123456';

// How long an order waits for its code: the system design's stock hold (60 minutes, §14.4). After
// that it is dropped, and the checkout cookie with the same life is gone too
const WAIT_MS = 60 * 60 * 1000;

interface MockOrder {
  token: string;
  order: ShopOrder;
  // Only while it waits for the code
  wrongCodes: number;
  resendAt: number;
  expiresAt: number;
}

// A token nobody can guess: 32 random bytes as 64 hex digits. Web Crypto, not node:crypto, so it
// runs wherever the shop's server runs (Node today, a worker runtime maybe later)
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// "01786120356" → "+880 17•• ••• 356". The first two digits say the operator and the last three
// let the shopper see it is their number; the rest stays off a screenshot
export function maskPhone(phone: string): string {
  return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
}

// W-000123: W for web, so a shop order is never mistaken for an ERP sales order (decision 3)
function orderNumber(sequence: number): string {
  return `W-${String(sequence).padStart(6, '0')}`;
}

// One order book per mock source. `now` is passed in so the tests can move time; the real clock
// otherwise
export function createOrderBook(now: () => Date = () => new Date()) {
  const byToken = new Map<string, MockOrder>();
  let sequence = 0;

  function secondsUntil(at: number): number {
    return Math.max(0, Math.ceil((at - now().getTime()) / 1000));
  }

  // The order that waits for a code under this token, or nothing. One past its hour is dropped
  // here, when someone asks for it, so the mock needs no timer
  function waiting(token: string): MockOrder | null {
    const entry = byToken.get(token);
    // A confirmed order, or none under this token: nothing waits
    if (entry?.order.status !== 'pending') return null;
    if (entry.expiresAt <= now().getTime()) {
      byToken.delete(token);
      return null;
    }
    return entry;
  }

  function confirm(entry: MockOrder): ShopOrderConfirmed {
    const at = now().toISOString();
    entry.order.status = 'confirmed';
    entry.order.history.push({ status: 'confirmed', at });
    return { orderNo: entry.order.orderNo, phone: entry.order.phone };
  }

  return {
    // Confirm Order. `quote` is the cart priced again on the server from the request's own lines,
    // zone and coupon; this only decides whether the order may be placed with it
    place(
      request: ShopOrderRequest,
      quote: ShopCartQuote,
      settings: ShopCheckoutSettings,
    ): SourceResult<PlacedOrder> {
      const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
      if (!zone) return { ok: false, code: 'shop_zone_unknown' };
      if (!settings.paymentMethods.includes(request.paymentMethod)) {
        return { ok: false, code: 'shop_payment_unavailable' };
      }

      // Every line must be sold as it is in the cart. A line out of stock or gone since the last
      // quote would leave the shopper with less than they chose, so the order is refused, and the
      // checkout prices the cart again and shows what changed (decision 10)
      const lines: ShopOrderLine[] = [];
      for (const line of quote.lines) {
        if (line.status !== 'available') return { ok: false, code: 'shop_order_changed' };
        lines.push({
          listingId: line.listingId,
          slug: line.slug,
          name: line.name,
          packSize: line.packSize,
          image: line.image,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        });
      }
      if (quote.belowMinimum && settings.minimumOrder !== null) {
        return {
          ok: false,
          code: 'shop_order_below_minimum',
          params: { minimum: settings.minimumOrder },
        };
      }
      // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
      const deliveryCharge = quote.deliveryCharge ?? '0';
      if (compareMoney(quote.total, request.expectedTotal) !== 0) {
        return { ok: false, code: 'shop_order_changed' };
      }

      // Orders that never got their code are dropped once their hour is over. Done here, on the
      // way in, so a script that places orders all day cannot fill the server's memory with them
      for (const [key, waitingEntry] of byToken) {
        if (waitingEntry.order.status === 'pending' && waitingEntry.expiresAt <= now().getTime()) {
          byToken.delete(key);
        }
      }

      sequence += 1;
      const placedAt = now();
      const token = newToken();
      const order: ShopOrder = {
        orderNo: orderNumber(sequence),
        placedAt: placedAt.toISOString(),
        status: 'pending',
        history: [{ status: 'pending', at: placedAt.toISOString() }],
        name: request.name,
        phone: request.phone,
        address: request.address,
        zoneName: zone.name,
        paymentMethod: request.paymentMethod,
        lines,
        subtotal: quote.subtotal,
        discount: quote.discount,
        // A refused code is not kept: the order says only what took money off
        couponCode: quote.coupon.status === 'applied' ? quote.coupon.code : null,
        deliveryCharge,
        total: quote.total,
      };
      const entry: MockOrder = {
        token,
        order,
        wrongCodes: 0,
        // The first code was "sent" just now, so a new one waits the same 45 seconds
        resendAt: placedAt.getTime() + SHOP_CODE_RESEND_SECONDS * 1000,
        expiresAt: placedAt.getTime() + WAIT_MS,
      };
      byToken.set(token, entry);

      // Mobile Banking needs no code in the mock (decision 4): confirmed at once
      if (request.paymentMethod === 'online') {
        const confirmed = confirm(entry);
        return {
          ok: true,
          value: { answer: { next: 'confirmed', ...confirmed }, orderNo: order.orderNo, token },
        };
      }
      return {
        ok: true,
        value: {
          answer: {
            next: 'verify',
            maskedPhone: maskPhone(order.phone),
            resendInSeconds: SHOP_CODE_RESEND_SECONDS,
          },
          orderNo: order.orderNo,
          token,
        },
      };
    },

    codeWait(token: string): ShopCodeWait | null {
      const entry = waiting(token);
      if (!entry) return null;
      return {
        next: 'verify',
        maskedPhone: maskPhone(entry.order.phone),
        resendInSeconds: secondsUntil(entry.resendAt),
        listingIds: entry.order.lines.map((line) => line.listingId),
      };
    },

    verify(token: string, code: string): SourceResult<ShopOrderConfirmed> {
      const entry = waiting(token);
      if (!entry) return { ok: false, code: 'shop_code_no_order' };
      if (code === MOCK_CODE) return { ok: true, value: confirm(entry) };

      entry.wrongCodes += 1;
      // The fifth wrong code drops the order: guessing six digits five times has a 1 in 200,000
      // chance, and the shopper starts again with a new order and a new code (decision 4)
      if (entry.wrongCodes >= SHOP_CODE_TRIES) {
        byToken.delete(token);
        return { ok: false, code: 'shop_code_too_many' };
      }
      return {
        ok: false,
        code: 'shop_code_wrong',
        params: { triesLeft: SHOP_CODE_TRIES - entry.wrongCodes },
      };
    },

    resend(token: string): SourceResult<ShopCodeResent> {
      const entry = waiting(token);
      if (!entry) return { ok: false, code: 'shop_code_no_order' };
      const wait = secondsUntil(entry.resendAt);
      // Every SMS costs the shop money, and a page that resends on every click could be used to
      // flood someone's phone. The wait is the server's; the button's countdown only shows it
      if (wait > 0) return { ok: false, code: 'shop_code_resend_wait', params: { seconds: wait } };
      entry.resendAt = now().getTime() + SHOP_CODE_RESEND_SECONDS * 1000;
      // The wrong codes are not forgiven: a new SMS must not give a guesser five more tries
      return { ok: true, value: { resendInSeconds: SHOP_CODE_RESEND_SECONDS } };
    },

    // Decision 5: the number and the token must belong together, and only a confirmed order is
    // shown. An order still waiting for its code is not one yet
    find(orderNo: string, token: string): ShopOrder | null {
      const entry = byToken.get(token);
      if (entry?.order.orderNo !== orderNo || entry.order.status === 'pending') return null;
      // A copy: the page that draws it must not be able to change the book
      return structuredClone(entry.order);
    },
  };
}

export type MockOrderBook = ReturnType<typeof createOrderBook>;
```

The mock's orders, in a `Map` from token to order (decision 3).

- **`WAIT_MS`** is the system design's stock hold, 60 minutes (decision 17).
- **`newToken`** makes 32 random bytes with Web Crypto (`crypto.getRandomValues`), written as 64 hex digits.
  `Math.random()` is not for secrets: its output can be predicted from earlier output. Web Crypto, not
  `node:crypto`, because the shop's `tsconfig` has no Node types and the code then runs in any server runtime.
- **`maskPhone`** keeps the operator digits and the last three. That is enough for the shopper to see it is their
  number, and too little for someone who sees a screenshot.
- **`createOrderBook(now)`** returns an object of functions that share one `Map` and one counter. It is not a class
  because nothing outside needs `this`, and the functions can be passed around without `bind`.
- **`waiting(token)`** is the one place that decides whether an order still waits for its code. `verify`, `resend`
  and `codeWait` all go through it, so the hour runs out the same way for all three. It deletes an expired order when
  it is asked for, so no timer runs in the server.
- **`confirm`** pushes `confirmed` onto `history`, so the order page's timeline (26c.5) has a date for both steps.
- **`codeWait`** works out `resendInSeconds` from `resendAt`, so a reload of the verify page shows the wait that is
  really left, not 45 again. `listingIds` are the order's own lines, not the cart's.
- **`place`** checks in the order of decision 21. Notes on the checks:
  - **`settings.paymentMethods.includes(...)`**: the schema allows `cod` and `online`, but a shop may offer only one.
  - **The line loop refuses any line that is not `available`.** The total alone is not enough: if a ৳120 line went
    out of stock and another line's price went up by ৳120, the total would still match, but the shopper would get
    less than they chose (the test "refuses an order whose total or stock changed" covers the out-of-stock part).
  - **The lines are copied field by field** (decision 13), so a listing's later change cannot change the order.
  - **`quote.belowMinimum && settings.minimumOrder !== null`**: the second part is always true when the first is,
    but TypeScript cannot know that, and `params.minimum` needs the string.
  - **`compareMoney(quote.total, request.expectedTotal) !== 0`**, not `!==` on the strings: the browser sends `'767'`
    or `'767.00'`, the quote says `'767.0000'`, and those are the same amount.
- **The sweep at the start of a new order** deletes every waiting order past its hour. Without it, an order that is
  never asked for again stays in memory until the server restarts, and a script placing orders all day would fill it.
- **`resendAt` starts 45 seconds after placing**, because the first code was "sent" with the order.
- **`verify`**: the fifth wrong code deletes the order and answers `shop_code_too_many`. Five guesses at a six-digit
  code succeed once in 200,000 orders. The fourth wrong code answers `triesLeft: 1`, so the page can warn before the
  last try.
- **`resend`** answers `shop_code_resend_wait` with the seconds left. The wait is the server's rule; the page's
  countdown only shows it, so a script that calls the route directly gets no more SMS than the button would. It does
  not reset `wrongCodes` (decision 18).
- **`find`** returns `structuredClone(entry.order)`. The page that draws the order gets a copy, so nothing it does can
  change the book. It returns `null` for an order still waiting (decision 19).

### `src/data/mock/mock-source.ts`

```diff
@@ -1,15 +1,50 @@
 import type { ShopSource } from '../types';
+import { mockCheckoutSettings, mockCoupons } from './checkout';
 import { mockHome } from './home';
+import { createOrderBook, MOCK_CODE } from './orders';
 import { mockCatalog, mockProductPage } from './products';
-import { quoteCart } from './quote';
+import { quoteCart, type QuoteContext } from './quote';
 import { mockCategories, mockShop } from './shop';
 
-// The mock answers at once. Still a promise, so the pages are written for the real source, which
-// waits for the network
-export const mockSource: ShopSource = {
-  shop: () => Promise.resolve(mockShop),
-  categories: () => Promise.resolve(mockCategories),
-  home: () => Promise.resolve(mockHome),
-  product: (slug) => Promise.resolve(mockProductPage(slug, new Date())),
-  quote: (request) => Promise.resolve(quoteCart(request, mockCatalog)),
-};
+// Step 26c: everything the mock prices a cart with, at one moment. Exported for the tests, which
+// price carts without a source
+export function mockQuoteContext(now: Date): QuoteContext {
+  return {
+    catalog: mockCatalog,
+    settings: mockCheckoutSettings,
+    coupons: mockCoupons,
+    timeZone: mockShop.timeZone,
+    now,
+  };
+}
+
+// Step 26c: a mock source with its own order book and clock. The shop uses one (mockSource below);
+// a test makes its own, so its orders and its time are its own and no test sees another's orders
+export function createMockSource(now: () => Date = () => new Date()): ShopSource {
+  const orders = createOrderBook(now);
+  const context = () => mockQuoteContext(now());
+
+  // The mock answers at once. Still a promise, so the pages are written for the real source, which
+  // waits for the network
+  return {
+    shop: () => Promise.resolve(mockShop),
+    categories: () => Promise.resolve(mockCategories),
+    home: () => Promise.resolve(mockHome),
+    product: (slug) => Promise.resolve(mockProductPage(slug, now())),
+    quote: (request) => Promise.resolve(quoteCart(request, context())),
+
+    checkoutSettings: () => Promise.resolve(mockCheckoutSettings),
+    // The order is priced again here from its own lines, zone and coupon, never from anything the
+    // browser says it costs (decision 10)
+    placeOrder: (request) =>
+      Promise.resolve(orders.place(request, quoteCart(request, context()), mockCheckoutSettings)),
+    codeWait: (token) => Promise.resolve(orders.codeWait(token)),
+    verifyCode: (token, code) => Promise.resolve(orders.verify(token, code)),
+    resendCode: (token) => Promise.resolve(orders.resend(token)),
+    order: (orderNo, token) => Promise.resolve(orders.find(orderNo, token)),
+    testCode: MOCK_CODE,
+  };
+}
+
+// The one the shop uses (data/source.ts). Its orders live as long as the server process
+export const mockSource: ShopSource = createMockSource();
```

- **`mockQuoteContext(now)`** builds the quote's context from the mock's data. The source uses it, and so do the
  tests that price a cart without a source.
- **`createMockSource(now)`** makes a source with its own order book and clock. The shop uses one (`mockSource`); each
  test makes its own, so one test's orders and time never leak into another. `product` now uses the same clock as
  everything else.
- **`placeOrder` prices the order with `quoteCart(request, …)`**: the order's own lines, zone and coupon, worked out
  again on the server (decision 10). `ShopOrderRequest` has every field `ShopCartQuoteRequest` has, so it can be passed
  as it is.

### `src/server/problem.ts`

```diff
@@ -4,13 +4,31 @@ import { contractErrorMap, isErrorCode, type ErrorCode, type Problem } from '@om
 // details, apps/api/src/common/http/problem.ts): a code the browser translates with
 // t('errors.<code>'), never English text it would show. One shape, so one client reads both.
 
-const TITLES = { 400: 'Bad Request', 500: 'Internal Server Error' } as const;
+// Step 26c: the order routes also refuse with 404, 409, 422 and 429 (server/orders.ts says which)
+const TITLES = {
+  400: 'Bad Request',
+  404: 'Not Found',
+  409: 'Conflict',
+  422: 'Unprocessable Content',
+  429: 'Too Many Requests',
+  500: 'Internal Server Error',
+} as const;
+
+export type ProblemStatus = keyof typeof TITLES;
+
+// Step 26c: what else a problem may carry. `params` go into the words ("2 tries left"); `headers`
+// are added to the response (Set-Cookie when a refusal also ends the order, Retry-After)
+interface ProblemOptions {
+  fieldErrors?: Record<string, ErrorCode[]>;
+  params?: Record<string, string | number>;
+  headers?: HeadersInit;
+}
 
 export function problemResponse(
-  status: keyof typeof TITLES,
+  status: ProblemStatus,
   code: ErrorCode,
   detail: string,
-  fieldErrors?: Record<string, ErrorCode[]>,
+  options: ProblemOptions = {},
 ): Response {
   const body: Problem = {
     title: TITLES[status],
@@ -18,12 +36,13 @@ export function problemResponse(
     detail,
     code,
     // Left out, not `undefined`, when there are none (exactOptionalPropertyTypes)
-    ...(fieldErrors ? { fieldErrors } : {}),
+    ...(options.params ? { params: options.params } : {}),
+    ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
   };
-  return Response.json(body, {
-    status,
-    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
-  });
+  const headers = new Headers(options.headers);
+  headers.set('Content-Type', 'application/problem+json');
+  headers.set('Cache-Control', 'no-store');
+  return Response.json(body, { status, headers });
 }
 
 // Only what invalidInput reads from a ZodError. Written out so the shop needs no direct `zod`
@@ -43,8 +62,59 @@ export function invalidInput(error: ParseError): Response {
     const code = isErrorCode(issue.message) ? issue.message : 'invalid_value';
     (fieldErrors[field] ??= []).push(code);
   }
-  return problemResponse(400, 'invalid_input', 'Check the request and try again.', fieldErrors);
+  return problemResponse(400, 'invalid_input', 'Check the request and try again.', {
+    fieldErrors,
+  });
 }
 
 // Parse with this, so Zod's own issues carry our codes ('too_large') instead of English
 export const parseOptions = { error: contractErrorMap };
+
+// Step 26c: what readBody needs from a schema. Zod's safeParse fits it; written out for the same
+// reason as ParseError
+interface BodySchema<T> {
+  safeParse(
+    input: unknown,
+    options: typeof parseOptions,
+  ): { success: true; data: T } | { success: false; error: ParseError };
+}
+
+// Step 26c: the first lines of every POST route, in one place. The body must say it is JSON, be
+// JSON, and pass the schema; anything else is the response to send back as it is.
+// The Content-Type check matters for the routes that read cookies: a form on another site can post
+// text/plain to this server, and Astro's origin check (security.checkOrigin, on by default) is the
+// only thing that refuses it. JSON can only come from a script, which the browser stops from
+// another site unless the server allows it (CORS), and this server allows no one.
+export async function readBody<T>(
+  request: Request,
+  schema: BodySchema<T>,
+): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
+  const type = request.headers.get('Content-Type') ?? '';
+  if (!/^application\/json\b/i.test(type)) {
+    return {
+      ok: false,
+      response: problemResponse(400, 'malformed_request', 'The body must be JSON.'),
+    };
+  }
+  let body: unknown;
+  try {
+    body = await request.json();
+  } catch {
+    // Not JSON, or bigger than the adapter's bodySizeLimit (reading it throws then): the same
+    // code the ERP's API sends for a body it cannot read
+    return {
+      ok: false,
+      response: problemResponse(400, 'malformed_request', 'The body must be JSON.'),
+    };
+  }
+  const parsed = schema.safeParse(body, parseOptions);
+  if (!parsed.success) return { ok: false, response: invalidInput(parsed.error) };
+  return { ok: true, data: parsed.data };
+}
+
+// The source threw: the real one calls the API, which can be down. Logged here with its details;
+// the shopper gets a code the page turns into "Try again", never the error's text
+export function sourceFailed(what: string, error: unknown): Response {
+  console.error(`${what} failed`, error);
+  return problemResponse(500, 'internal_error', 'Something went wrong on our side.');
+}
```

- **`TITLES` gets 404, 409, 422 and 429**, the statuses the order routes send (see `orders.ts` below).
- **`problemResponse` takes an options object** instead of a fourth `fieldErrors` argument: a problem may now also
  carry `params` and extra headers (a `Set-Cookie` that ends the order, `Retry-After`). The spreads keep
  `params` and `fieldErrors` out of the body when there are none (`exactOptionalPropertyTypes`).
- **`new Headers(options.headers)` then `set(...)`**: the caller's headers first, then the two every problem has. A
  caller can add headers but cannot make a problem cacheable by mistake.
- **`readBody`** is the three checks every POST route starts with: the body says it is JSON, is JSON, and passes the
  schema. The first one is new. A form on another site can post `text/plain` to this server without asking the
  browser first; Astro's origin check (`security.checkOrigin`, on by default) refuses that, and this check refuses it
  again for the routes that read cookies. `application/json` can only come from a script, and the browser does not
  let another site's script post it here, because this server sends no CORS headers. (Seen on the built server: a
  `text/plain` post with another site's `Origin` gets 403 from Astro before the route runs.)
- **`BodySchema<T>`** is the part of a Zod schema `readBody` calls, written out because the shop has no direct `zod`
  dependency, like `ParseError` in 26b.
- **`sourceFailed`** is 26b's catch block, shared: the details go to the server's log, the shopper gets
  `internal_error`.

### `src/server/cart-quote.ts`

```diff
@@ -1,31 +1,20 @@
 import { shopCartQuoteRequestSchema } from '@omnivo/contracts';
 
 import type { ShopSource } from '../data/types';
-import { invalidInput, parseOptions, problemResponse } from './problem';
+import { readBody, sourceFailed } from './problem';
 
 // Step 26b: POST /api/cart/quote, without Astro around it. The route file only passes the request
 // and the source in, so this can be tested with a plain Request and the mock source, no server.
 export async function answerCartQuote(request: Request, source: ShopSource): Promise<Response> {
-  let body: unknown;
-  try {
-    body = await request.json();
-  } catch {
-    // Not JSON, or bigger than the adapter's bodySizeLimit (reading it throws then): the same
-    // code the ERP's API sends for a body it cannot read
-    return problemResponse(400, 'malformed_request', 'The body must be JSON.');
-  }
-
-  const parsed = shopCartQuoteRequestSchema.safeParse(body, parseOptions);
-  if (!parsed.success) return invalidInput(parsed.error);
+  // Step 26c: the reading and checking moved to readBody, which the order routes share
+  const body = await readBody(request, shopCartQuoteRequestSchema);
+  if (!body.ok) return body.response;
 
   try {
-    const quote = await source.quote(parsed.data);
+    const quote = await source.quote(body.data);
     // Prices change and the answer belongs to one cart: no browser or proxy may keep it
     return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } });
   } catch (error) {
-    // The real source calls the API, which can be down. Logged here with its details; the
-    // shopper gets a code the drawer turns into "Retry", never the error's text
-    console.error('cart quote failed', error);
-    return problemResponse(500, 'internal_error', 'Something went wrong on our side.');
+    return sourceFailed('cart quote', error);
   }
 }
```

The route now starts with `readBody` and ends with `sourceFailed`. It behaves as before for the drawer, which sends
`Content-Type: application/json` already (26b's `lib/quote.ts`).

### `src/server/cookies.ts`

```ts
// Step 26c: the shop's two cookies. Both hold secret tokens and nothing else: no name, no phone, no
// cart. Both are httpOnly, so no script on the page can read them (an injected script could not
// steal an order), SameSite=Lax, so another site's form or script never sends them, and Secure in
// production, so they never travel over plain http.
//
// - shop_checkout: the token of the order that waits for its phone code (decision 4). It lives as
//   long as the order waits (60 minutes) and is cleared when the order is confirmed or dropped
// - shop_orders: "W-000123:<token>" pairs for the orders this browser placed, newest last
//   (decision 5). /order/<no> takes the token paired with <no>, so it asks the source once

export const CHECKOUT_COOKIE = 'shop_checkout';
export const ORDERS_COOKIE = 'shop_orders';

// The same 60 minutes the mock keeps a waiting order (data/mock/orders.ts)
const CHECKOUT_MAX_AGE = 60 * 60;
// Long enough to come back to "View Order Details" from the SMS a few days later. After that, the
// shopper uses /track with the phone and the number (26d)
const ORDERS_MAX_AGE = 30 * 24 * 60 * 60;
// About 2 KB with today's tokens, well under the 4 KB a browser keeps for one cookie. The oldest
// order is forgotten first
const ORDERS_KEPT = 20;

// A token is what a source made (64 hex digits in the mock). The pattern is looser, for the real
// API's tokens, but it still refuses anything that could break the cookie: ; , = and spaces
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ORDER_NO = /^[A-Za-z0-9-]{1,32}$/;

export interface CookieOptions {
  // import.meta.env.PROD in the routes. Off in `astro dev`, which serves plain http on localhost
  secure: boolean;
}

function serialize(name: string, value: string, maxAge: number, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${String(maxAge)}`, 'HttpOnly'];
  parts.push('SameSite=Lax');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// One cookie's value from the request's Cookie header, or null. The browser sends "a=1; b=2"
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// The waiting order's token, or null when there is none or it is not one of ours (an edited cookie
// is never passed on to the source)
export function checkoutToken(request: Request): string | null {
  const value = readCookie(request, CHECKOUT_COOKIE);
  return value !== null && TOKEN.test(value) ? value : null;
}

export function checkoutCookie(token: string, options: CookieOptions): string {
  return serialize(CHECKOUT_COOKIE, token, CHECKOUT_MAX_AGE, options);
}

// Max-Age=0 tells the browser to delete it now
export function clearCheckoutCookie(options: CookieOptions): string {
  return serialize(CHECKOUT_COOKIE, '', 0, options);
}

// This browser's orders, number → token, in the cookie's order. A pair that does not look right
// is skipped, not an error: the rest of the cookie still works
export function orderTokens(request: Request): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const pair of (readCookie(request, ORDERS_COOKIE) ?? '').split('.')) {
    const at = pair.indexOf(':');
    const orderNo = pair.slice(0, at);
    const token = pair.slice(at + 1);
    if (at > 0 && ORDER_NO.test(orderNo) && TOKEN.test(token)) tokens.set(orderNo, token);
  }
  return tokens;
}

// The orders cookie with one more order. It is written whole each time (a cookie cannot be
// appended to), so the request's cookie is read first
export function ordersCookie(
  request: Request,
  orderNo: string,
  token: string,
  options: CookieOptions,
): string {
  const tokens = orderTokens(request);
  // Deleted first, so a number that is already there moves to the end, as the newest
  tokens.delete(orderNo);
  tokens.set(orderNo, token);
  const pairs = [...tokens].slice(-ORDERS_KEPT).map(([no, value]) => `${no}:${value}`);
  return serialize(ORDERS_COOKIE, pairs.join('.'), ORDERS_MAX_AGE, options);
}
```

The shop's two cookies, written by hand: Astro's own `cookies` object exists only inside Astro, and these helpers are
used from plain functions that the tests call with a `Request`.

- **`HttpOnly`** keeps the tokens away from every script on the page. If a script were ever injected (a bad
  description from a tenant, a third-party widget), it still could not read an order token and open the order
  somewhere else.
- **`SameSite=Lax`**: the browser sends the cookies when the shopper follows a link to the shop, but not with a POST
  from another site. Another site cannot make a shopper's browser resend codes or confirm an order.
- **`Secure`** only when `options.secure` is set. The routes pass `import.meta.env.PROD`: on, in the built server;
  off in `astro dev`, which serves plain http. (Chrome and Firefox accept a Secure cookie over http on `localhost`;
  Safari does not, so a developer on Safari would otherwise never get past Confirm Order.)
- **`Path=/`**: the routes are under `/api/orders`, but the verify and order pages (26c.5) read the cookies too.
- **No `Domain`**: the cookie belongs to this shop's exact host only, never to its other subdomains.
- **`readCookie`** splits at the first `=` only, because a value may contain `=` (not ours, but another cookie's).
- **`checkoutToken`** passes on only a value that looks like a token. An edited cookie with `;`, spaces or a
  megabyte of text never reaches the source.
- **`orderTokens`** skips a pair that does not look right and keeps the others. One broken pair (an old format, a
  hand edit) should not lose the shopper every other order.
- **The pair format `W-000123:<token>`, joined by `.`** uses only characters a cookie value may hold without
  escaping (RFC 6265 forbids `,`, `;`, spaces and quotes). JSON would need URL-encoding and a schema to read it back.
- **`ordersCookie`** writes the whole cookie again with one more pair, because a cookie cannot be appended to.
  `tokens.delete(orderNo)` before `set` moves a number that is already there to the end, so "the newest 20" really
  are the newest (decision 20).

### `src/server/orders.ts`

```ts
import { shopOrderRequestSchema, shopVerifyCodeRequestSchema } from '@omnivo/contracts';

import type { ShopRefusalCode, ShopSource, SourceResult } from '../data/types';
import {
  checkoutCookie,
  checkoutToken,
  clearCheckoutCookie,
  ordersCookie,
  type CookieOptions,
} from './cookies';
import { problemResponse, readBody, sourceFailed, type ProblemStatus } from './problem';

// Step 26c: POST /api/orders, /api/orders/verify and /api/orders/resend, without Astro around
// them, like cart-quote.ts. The route files pass the request, the source and whether the cookies
// are Secure.

// Each refusal's HTTP status. `satisfies Record<ShopRefusalCode, …>` makes a new refusal in
// data/types.ts fail the type check here until it has one.
// - 409: the cart changed under the shopper; asking again with a new quote can work
// - 422: the request is well formed but breaks a rule (no such zone, under the minimum, wrong code)
// - 429: asked for a new code too soon; Retry-After says when
// - 404: no order waits for a code in this browser
const REFUSALS = {
  shop_zone_unknown: [422, 'The delivery zone is not one the shop has.'],
  shop_payment_unavailable: [422, 'The shop does not take this payment method.'],
  shop_order_below_minimum: [422, 'The order is under the shop’s minimum.'],
  shop_order_changed: [409, 'The cart’s prices or stock changed since the last quote.'],
  shop_code_wrong: [422, 'The code is wrong.'],
  shop_code_too_many: [422, 'Too many wrong codes; the order was dropped.'],
  shop_code_resend_wait: [429, 'A new code cannot be sent yet.'],
  shop_code_no_order: [404, 'No order waits for a code in this browser.'],
} as const satisfies Record<ShopRefusalCode, readonly [ProblemStatus, string]>;

function refused(
  result: Extract<SourceResult<unknown>, { ok: false }>,
  headers: Headers = new Headers(),
): Response {
  const [status, detail] = REFUSALS[result.code];
  // The standard header for "try again in N seconds", next to the same number in params
  if (result.code === 'shop_code_resend_wait' && typeof result.params?.seconds === 'number') {
    headers.set('Retry-After', String(result.params.seconds));
  }
  return problemResponse(status, result.code, detail, {
    headers,
    ...(result.params ? { params: result.params } : {}),
  });
}

function noOrder(options: CookieOptions): Response {
  // The cookie is cleared with the answer, so the verify page stops offering a form that can only
  // fail. Harmless when there was no cookie
  const headers = new Headers({ 'Set-Cookie': clearCheckoutCookie(options) });
  return refused({ ok: false, code: 'shop_code_no_order' }, headers);
}

// Confirm Order
export async function answerPlaceOrder(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  const body = await readBody(request, shopOrderRequestSchema);
  if (!body.ok) return body.response;

  let result;
  try {
    result = await source.placeOrder(body.data);
  } catch (error) {
    return sourceFailed('place order', error);
  }
  if (!result.ok) return refused(result);

  const { answer, orderNo, token } = result.value;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (answer.next === 'verify') {
    // The order waits for its code; /checkout/verify finds it by this cookie
    headers.append('Set-Cookie', checkoutCookie(token, options));
  } else {
    // Confirmed at once (Mobile Banking in the mock): this browser may now open /order/<no>.
    // An older order that was still waiting for its code is forgotten: the shopper chose to start
    // again, and the verify page must not offer the old one
    headers.append('Set-Cookie', ordersCookie(request, orderNo, token, options));
    headers.append('Set-Cookie', clearCheckoutCookie(options));
  }
  // 201: an order was made. The body says which page comes next; the token is only in the cookie
  return Response.json(answer, { status: 201, headers });
}

// The six digits on /checkout/verify
export async function answerVerifyCode(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  // The cookie first: without it no code can be right, whatever the body says
  const token = checkoutToken(request);
  if (token === null) return noOrder(options);

  const body = await readBody(request, shopVerifyCodeRequestSchema);
  if (!body.ok) return body.response;

  let result;
  try {
    result = await source.verifyCode(token, body.data.code);
  } catch (error) {
    return sourceFailed('verify code', error);
  }
  if (!result.ok) {
    // Too many wrong codes ends the order, so its cookie goes with it
    if (result.code === 'shop_code_too_many' || result.code === 'shop_code_no_order') {
      return refused(result, new Headers({ 'Set-Cookie': clearCheckoutCookie(options) }));
    }
    return refused(result);
  }

  // The order moves from "waiting" to "this browser's orders": the same token, now in the cookie
  // that /order/<no> reads
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', ordersCookie(request, result.value.orderNo, token, options));
  headers.append('Set-Cookie', clearCheckoutCookie(options));
  return Response.json(result.value, { headers });
}

// "Resend code". No body: the cookie says which order
export async function answerResendCode(
  request: Request,
  source: ShopSource,
  options: CookieOptions,
): Promise<Response> {
  const token = checkoutToken(request);
  if (token === null) return noOrder(options);

  let result;
  try {
    result = await source.resendCode(token);
  } catch (error) {
    return sourceFailed('resend code', error);
  }
  if (!result.ok) {
    if (result.code === 'shop_code_no_order') return noOrder(options);
    return refused(result);
  }
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}
```

The three routes, as plain functions like `cart-quote.ts`.

- **`REFUSALS`** gives each refusal its status and an English `detail` for logs:
  - **409** for `shop_order_changed`: the request was right when the shopper made it, and asking again after a new
    quote can work.
  - **422** for a well-formed request that breaks a rule (a wrong code, under the minimum).
  - **429** with `Retry-After` for a code asked for too soon: the standard header, next to the same seconds in
    `params`, so a client that knows HTTP and one that reads the problem both see it.
  - **404** for `shop_code_no_order`: there is nothing to verify.
- **`noOrder` clears the checkout cookie** with the answer, so the verify page stops showing a form that can only
  fail. Clearing a cookie the browser does not have is harmless.
- **`answerPlaceOrder`** answers **201 Created**: an order was made. A `verify` answer sets the checkout cookie. A
  `confirmed` answer adds the order to the orders cookie and clears the checkout cookie, because an order that was
  still waiting from an earlier try must not show up on the verify page now.
- **`headers.append('Set-Cookie', …)`**, never `set`: two cookies need two `Set-Cookie` lines, and `set` would keep
  only the last. (Checked on the built server: both lines arrive.)
- **`answerVerifyCode` reads the cookie before the body.** Without a waiting order no code can be right, and the
  shopper should hear that, not "type 6 digits".
- **A code of the wrong shape is refused by the schema** (400), before the source counts it. "12345" is a typo, not
  a guess, and must not cost a try (the test "refuses a code that is not six digits before asking the source").
- **A right code moves the token** from the checkout cookie to the orders cookie. It is the same token: the order
  is the same, only its state changed.
- **`answerResendCode` has no body**: the cookie says which order. It is a POST anyway, because it sends an SMS; a
  GET could be fired by a link preview, a prefetch or an image tag on another site.

### `src/pages/api/orders/index.ts`, `verify.ts`, `resend.ts`

```ts
import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerPlaceOrder } from '../../../server/orders';

// Step 26c: Confirm Order. The cookies are Secure in a production build only: `astro dev` serves
// plain http, and a browser drops a Secure cookie that arrives over it (Chrome and Firefox make an
// exception for localhost, Safari does not)
export const POST: APIRoute = ({ request }) =>
  answerPlaceOrder(request, shopSource, { secure: import.meta.env.PROD });
```

```ts
import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerVerifyCode } from '../../../server/orders';

// Step 26c: the phone code from /checkout/verify. The order comes from the cookie, never the body
export const POST: APIRoute = ({ request }) =>
  answerVerifyCode(request, shopSource, { secure: import.meta.env.PROD });
```

```ts
import type { APIRoute } from 'astro';

import { shopSource } from '../../../data/source';
import { answerResendCode } from '../../../server/orders';

// Step 26c: "Resend code". POST, not GET: it sends an SMS, and a GET could be fired by a link
// preview, a prefetch or an <img> on another site
export const POST: APIRoute = ({ request }) =>
  answerResendCode(request, shopSource, { secure: import.meta.env.PROD });
```

One line each, like 26b's quote route: the request, the source, and `secure: import.meta.env.PROD`. `orders/index.ts`
answers `POST /api/orders`, next to `orders/verify.ts` and `orders/resend.ts` in the same folder.

### `src/data/mock/quote.spec.ts`

```diff
@@ -1,68 +1,228 @@
-import { shopCartQuoteSchema } from '@omnivo/contracts';
+import { shopCartQuoteSchema, type ShopCartQuoteRequest } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
+import { mockQuoteContext } from './mock-source';
 import { mockCatalog } from './products';
-import { quoteCart } from './quote';
+import { quoteCart, type QuoteContext } from './quote';
 
 const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
 const STEVIA = 'lst-zero-cal-stevia-30-sachets'; // ৳120
 const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock
 
+// 11 Nov 2026, 10 am in Dhaka
+const NOW = new Date('2026-11-11T10:00:00+06:00');
+const context = mockQuoteContext(NOW);
+
+// The context with Stevia at another price, for carts that must land on an exact amount
+function steviaAt(price: string): QuoteContext {
+  return {
+    ...context,
+    catalog: mockCatalog.map((listing) =>
+      listing.id === STEVIA ? { ...listing, price } : listing,
+    ),
+  };
+}
+
+function quote(request: ShopCartQuoteRequest, at: QuoteContext = context) {
+  const answer = quoteCart(request, at);
+  // Every answer must be what the real API will send: the drawer and the checkout trust it as it is
+  expect(() => shopCartQuoteSchema.parse(answer)).not.toThrow();
+  return answer;
+}
+
 describe('quoteCart', () => {
   it('prices each line at today’s price and sums them on the server', () => {
-    const quote = quoteCart(
-      {
-        lines: [
-          { listingId: NEEM, quantity: 3 },
-          { listingId: STEVIA, quantity: 1 },
-        ],
-      },
-      mockCatalog,
-    );
-    expect(quote.lines).toMatchObject([
+    const answer = quote({
+      lines: [
+        { listingId: NEEM, quantity: 3 },
+        { listingId: STEVIA, quantity: 1 },
+      ],
+    });
+    expect(answer.lines).toMatchObject([
       { status: 'available', listingId: NEEM, unitPrice: '229', lineTotal: '687.0000' },
       { status: 'available', listingId: STEVIA, unitPrice: '120', lineTotal: '120.0000' },
     ]);
-    expect(quote.itemCount).toBe(4);
-    expect(quote.subtotal).toBe('807.0000');
-    // The drawer trusts this answer as it is, so it must be what the real API will send
-    expect(() => shopCartQuoteSchema.parse(quote)).not.toThrow();
+    expect(answer.itemCount).toBe(4);
+    expect(answer.subtotal).toBe('807.0000');
   });
 
   it('keeps the cart’s order and leaves out what cannot be sold', () => {
-    const quote = quoteCart(
-      {
-        lines: [
-          { listingId: DANO, quantity: 2 },
-          { listingId: 'lst-gone', quantity: 1 },
-          { listingId: STEVIA, quantity: 2 },
-        ],
-      },
-      mockCatalog,
-    );
-    expect(quote.lines.map((line) => line.status)).toEqual([
+    const answer = quote({
+      lines: [
+        { listingId: DANO, quantity: 2 },
+        { listingId: 'lst-gone', quantity: 1 },
+        { listingId: STEVIA, quantity: 2 },
+      ],
+    });
+    expect(answer.lines.map((line) => line.status)).toEqual([
       'out_of_stock',
       'unavailable',
       'available',
     ]);
     // A gone listing says only its id: the browser drops it, and there is nothing else to show
-    expect(quote.lines[1]).toEqual({ status: 'unavailable', listingId: 'lst-gone' });
+    expect(answer.lines[1]).toEqual({ status: 'unavailable', listingId: 'lst-gone' });
     // The out-of-stock 2 are not counted, and add no money
-    expect(quote.itemCount).toBe(2);
-    expect(quote.subtotal).toBe('240.0000');
+    expect(answer.itemCount).toBe(2);
+    expect(answer.subtotal).toBe('240.0000');
   });
 
   it('answers an empty cart with nothing to pay', () => {
-    const quote = quoteCart({ lines: [] }, mockCatalog);
-    expect(quote).toEqual({ lines: [], itemCount: 0, subtotal: '0.0000' });
+    expect(quote({ lines: [] })).toEqual({
+      lines: [],
+      itemCount: 0,
+      subtotal: '0.0000',
+      discount: '0.0000',
+      coupon: { status: 'none' },
+      deliveryCharge: null,
+      freeDelivery: false,
+      total: '0.0000',
+      // Under the shop's ৳300: the checkout says how much more is needed
+      belowMinimum: true,
+    });
   });
 
   it('never adds money as floating point', () => {
     // 3 × 49.90 is 149.70000000000002 with JavaScript numbers
-    const catalog = mockCatalog.map((listing) =>
-      listing.id === STEVIA ? { ...listing, price: '49.90' } : listing,
+    const answer = quote({ lines: [{ listingId: STEVIA, quantity: 3 }] }, steviaAt('49.90'));
+    expect(answer.subtotal).toBe('149.7000');
+  });
+});
+
+describe('quoteCart: delivery', () => {
+  const lines = [{ listingId: NEEM, quantity: 3 }]; // ৳687
+
+  it('has no charge and the items as the total until a zone is picked', () => {
+    // The drawer's request: the 26b answer, with the rest of the bill still empty
+    const answer = quote({ lines });
+    expect(answer.deliveryCharge).toBeNull();
+    expect(answer.total).toBe('687.0000');
+  });
+
+  it('adds the zone’s charge', () => {
+    expect(quote({ lines, zoneId: 'inside_dhaka' })).toMatchObject({
+      deliveryCharge: '80.0000',
+      freeDelivery: false,
+      total: '767.0000',
+    });
+    expect(quote({ lines, zoneId: 'outside_dhaka' }).total).toBe('807.0000');
+  });
+
+  it('treats a zone the shop does not have as no zone', () => {
+    // An old checkout tab after the shop removed a zone: "Pick a location", not an error
+    expect(quote({ lines, zoneId: 'chattogram' }).deliveryCharge).toBeNull();
+  });
+
+  it('delivers free from the shop’s amount, the amount itself included', () => {
+    const below = quote(
+      { lines: [{ listingId: STEVIA, quantity: 2 }], zoneId: 'outside_dhaka' },
+      steviaAt('499.99'),
+    );
+    expect(below).toMatchObject({ subtotal: '999.9800', freeDelivery: false });
+    expect(below.deliveryCharge).toBe('120.0000');
+
+    const at = quote(
+      { lines: [{ listingId: STEVIA, quantity: 2 }], zoneId: 'outside_dhaka' },
+      steviaAt('500'),
+    );
+    expect(at).toMatchObject({ freeDelivery: true, deliveryCharge: '0.0000', total: '1000.0000' });
+  });
+
+  it('keeps free delivery when a coupon takes the items under the amount', () => {
+    // Decision 8: ৳1,000 of items, ৳100 off. Free delivery looks at the ৳1,000
+    const answer = quote(
+      {
+        lines: [{ listingId: STEVIA, quantity: 2 }],
+        zoneId: 'inside_dhaka',
+        couponCode: 'WELCOME10',
+      },
+      steviaAt('500'),
+    );
+    expect(answer).toMatchObject({
+      discount: '100.0000',
+      freeDelivery: true,
+      deliveryCharge: '0.0000',
+      total: '900.0000',
+    });
+  });
+
+  it('says when the items are under the shop’s minimum order', () => {
+    expect(quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }).belowMinimum).toBe(true);
+    // ৳300 exactly is enough
+    expect(
+      quote({ lines: [{ listingId: STEVIA, quantity: 2 }] }, steviaAt('150')).belowMinimum,
+    ).toBe(false);
+  });
+});
+
+describe('quoteCart: coupons', () => {
+  const lines = [
+    { listingId: NEEM, quantity: 3 },
+    { listingId: STEVIA, quantity: 1 },
+  ]; // ৳807
+
+  it('takes a percent off the items, never off the delivery', () => {
+    const answer = quote({ lines, zoneId: 'inside_dhaka', couponCode: 'WELCOME10' });
+    expect(answer).toMatchObject({
+      coupon: { status: 'applied', code: 'WELCOME10', discount: { kind: 'percent', value: 10 } },
+      // 10% of ৳807, to the paisa
+      discount: '80.7000',
+      deliveryCharge: '80.0000',
+      total: '806.3000',
+    });
+  });
+
+  it('takes a fixed amount once its minimum is reached', () => {
+    expect(quote({ lines, couponCode: 'FLAT50' })).toMatchObject({
+      coupon: { status: 'applied', code: 'FLAT50' },
+      discount: '50.0000',
+      total: '757.0000',
+    });
+  });
+
+  it('refuses a code under its minimum and says the amount', () => {
+    const answer = quote({ lines: [{ listingId: STEVIA, quantity: 2 }], couponCode: 'FLAT50' });
+    // Decision 9: the cart is still priced, as if no code was sent
+    expect(answer).toMatchObject({
+      coupon: { status: 'refused', code: 'FLAT50', reason: 'shop_coupon_minimum', minimum: '500' },
+      discount: '0.0000',
+      total: '240.0000',
+    });
+  });
+
+  it('refuses a code that does not exist', () => {
+    expect(quote({ lines, couponCode: 'FREEBIES' }).coupon).toEqual({
+      status: 'refused',
+      code: 'FREEBIES',
+      reason: 'shop_coupon_unknown',
+      minimum: null,
+    });
+  });
+
+  it('ends a code at midnight in Dhaka, not in UTC', () => {
+    // OLD2025's last day is 31 Dec 2025. 11:30 pm that day in Dhaka: it still works
+    const lastEvening = mockQuoteContext(new Date('2025-12-31T23:30:00+06:00'));
+    expect(quote({ lines, couponCode: 'OLD2025' }, lastEvening).coupon.status).toBe('applied');
+
+    // 0:30 am on 1 January in Dhaka is 6:30 pm on 31 December in UTC. The shop's day has ended
+    const nextMorning = mockQuoteContext(new Date('2026-01-01T00:30:00+06:00'));
+    expect(quote({ lines, couponCode: 'OLD2025' }, nextMorning).coupon).toMatchObject({
+      status: 'refused',
+      reason: 'shop_coupon_expired',
+    });
+  });
+
+  it('never takes off more than the items cost', () => {
+    const generous: QuoteContext = {
+      ...context,
+      coupons: [
+        { code: 'BIG', discount: { kind: 'amount', value: '1000' }, minimum: null, lastDay: null },
+      ],
+    };
+    const answer = quote(
+      { lines: [{ listingId: STEVIA, quantity: 1 }], zoneId: 'inside_dhaka', couponCode: 'BIG' },
+      generous,
     );
-    const quote = quoteCart({ lines: [{ listingId: STEVIA, quantity: 3 }] }, catalog);
-    expect(quote.subtotal).toBe('149.7000');
+    // ৳120 of items, ৳120 off, and the delivery is still paid
+    expect(answer).toMatchObject({ discount: '120.0000', total: '80.0000' });
   });
 });
```

26b's four tests stay, now with `mockQuoteContext`, and each answer is parsed with `shopCartQuoteSchema` in the
`quote` helper, so every case is also a contract check. New:

- **`steviaAt(price)`** gives a catalog with one price changed, for carts that must land on an exact amount
  (৳999.98, ৳1,000).
- **"delivers free from the shop's amount, the amount itself included"** tests both sides of the edge. With `>`
  instead of `>=` it fails (tried).
- **"keeps free delivery when a coupon takes the items under the amount"** is decision 8 as a test.
- **"ends a code at midnight in Dhaka, not in UTC"** uses two moments 1 hour apart around midnight in Dhaka, both
  still 31 December in UTC.
- **"never takes off more than the items cost"** uses its own coupon list in the context; it fails without the cap in
  `discountOf` (tried).

### `src/data/mock/orders.spec.ts`

```ts
import { shopOrderSchema, type ShopOrderRequest, SHOP_CODE_TRIES } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import type { ShopSource } from '../types';
import { createMockSource } from './mock-source';
import { maskPhone, MOCK_CODE } from './orders';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const DANO = 'lst-dano-daily-pushti-milk-1kg'; // out of stock

// What the route hands the source: the request after shopOrderRequestSchema, phone made plain
const ORDER: ShopOrderRequest = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
  // ৳687 of face wash and ৳80 delivery
  expectedTotal: '767',
};

// A source whose clock the test moves
function withClock() {
  let now = new Date('2026-11-11T10:00:00+06:00');
  const source = createMockSource(() => now);
  return {
    source,
    // An arrow, not a method: the tests take it out of the object (`const { wait } = …`)
    wait: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

async function placed(source: ShopSource, request: ShopOrderRequest = ORDER) {
  const result = await source.placeOrder(request);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.value;
}

describe('the mock’s orders', () => {
  it('hides the middle of the phone', () => {
    expect(maskPhone('01786120356')).toBe('+880 17•• ••• 356');
  });

  it('asks Cash on Delivery for the phone code', async () => {
    const { source } = withClock();
    const order = await placed(source);
    expect(order.answer).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 45,
    });
    expect(order.orderNo).toBe('W-000001');
    expect(order.token).toMatch(/^[0-9a-f]{64}$/);
    // Not an order yet: /order/<no> does not show it, even with the right token
    expect(await source.order(order.orderNo, order.token)).toBeNull();
  });

  it('confirms a right code, and the order then shows with its token only', async () => {
    const { source } = withClock();
    const { orderNo, token } = await placed(source);
    expect(await source.verifyCode(token, MOCK_CODE)).toEqual({
      ok: true,
      value: { orderNo, phone: '01786120356' },
    });

    const order = await source.order(orderNo, token);
    expect(() => shopOrderSchema.parse(order)).not.toThrow();
    expect(order).toMatchObject({
      status: 'confirmed',
      zoneName: 'Inside Dhaka',
      subtotal: '687.0000',
      deliveryCharge: '80.0000',
      total: '767.0000',
      couponCode: null,
    });
    expect(order?.history.map((step) => step.status)).toEqual(['pending', 'confirmed']);

    // Decision 5: the number with another order's token, or a made-up token, finds nothing
    const other = await placed(source, { ...ORDER, paymentMethod: 'online' });
    expect(await source.order(orderNo, other.token)).toBeNull();
    expect(await source.order(orderNo, 'f'.repeat(64))).toBeNull();
    // And the code cannot confirm it twice
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
  });

  it('confirms Mobile Banking at once, with the next number', async () => {
    const { source } = withClock();
    await placed(source);
    const order = await placed(source, { ...ORDER, paymentMethod: 'online' });
    expect(order.answer).toEqual({ next: 'confirmed', orderNo: 'W-000002', phone: '01786120356' });
    expect((await source.order('W-000002', order.token))?.status).toBe('confirmed');
  });

  it('drops the order after five wrong codes', async () => {
    const { source } = withClock();
    const { token } = await placed(source);
    for (let triesLeft = SHOP_CODE_TRIES - 1; triesLeft > 0; triesLeft -= 1) {
      expect(await source.verifyCode(token, '000000')).toEqual({
        ok: false,
        code: 'shop_code_wrong',
        params: { triesLeft },
      });
    }
    expect(await source.verifyCode(token, '000000')).toEqual({
      ok: false,
      code: 'shop_code_too_many',
    });
    // Gone: even the right code is too late now
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
    expect(await source.codeWait(token)).toBeNull();
  });

  it('sends a new code only after 45 seconds, and keeps the wrong codes', async () => {
    const { source, wait } = withClock();
    const { token } = await placed(source);
    await source.verifyCode(token, '000000');

    wait(30);
    expect(await source.resendCode(token)).toEqual({
      ok: false,
      code: 'shop_code_resend_wait',
      params: { seconds: 15 },
    });
    expect((await source.codeWait(token))?.resendInSeconds).toBe(15);

    wait(15);
    expect(await source.resendCode(token)).toEqual({ ok: true, value: { resendInSeconds: 45 } });
    // A new SMS does not give a guesser five new tries
    expect(await source.verifyCode(token, '000000')).toMatchObject({ params: { triesLeft: 3 } });
  });

  it('forgets an order that waited more than an hour', async () => {
    const { source, wait } = withClock();
    const { token } = await placed(source);
    wait(59 * 60);
    // Still waiting, with what the verify page needs: where the code went and what was ordered
    expect(await source.codeWait(token)).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 0,
      listingIds: [NEEM],
    });
    wait(60);
    expect(await source.codeWait(token)).toBeNull();
    expect(await source.verifyCode(token, MOCK_CODE)).toMatchObject({ code: 'shop_code_no_order' });
  });

  it('refuses what the shop does not offer', async () => {
    const { source } = withClock();
    expect(await source.placeOrder({ ...ORDER, zoneId: 'chattogram' })).toEqual({
      ok: false,
      code: 'shop_zone_unknown',
    });
  });

  it('refuses an order under the minimum, with the amount', async () => {
    const { source } = withClock();
    // One face wash: ৳229 of items, ৳80 delivery
    const small = { ...ORDER, lines: [{ listingId: NEEM, quantity: 1 }], expectedTotal: '309' };
    expect(await source.placeOrder(small)).toEqual({
      ok: false,
      code: 'shop_order_below_minimum',
      params: { minimum: '300' },
    });
  });

  it('refuses an order whose total or stock changed since the last quote', async () => {
    const { source } = withClock();
    // Decision 10: the shopper saw ৳747 (an old price); the server's total is ৳767
    expect(await source.placeOrder({ ...ORDER, expectedTotal: '747' })).toMatchObject({
      code: 'shop_order_changed',
    });
    // A line went out of stock: the total of what is left might still match, so it is checked
    // on its own
    const withMilk = { ...ORDER, lines: [...ORDER.lines, { listingId: DANO, quantity: 1 }] };
    expect(await source.placeOrder(withMilk)).toMatchObject({ code: 'shop_order_changed' });
  });

  it('keeps the coupon that took money off, and copies the lines', async () => {
    const { source } = withClock();
    // ৳687 − 10% (৳68.70) + ৳80
    const { orderNo, token } = await placed(source, {
      ...ORDER,
      couponCode: 'WELCOME10',
      paymentMethod: 'online',
      expectedTotal: '698.30',
    });
    const order = await source.order(orderNo, token);
    expect(order).toMatchObject({
      couponCode: 'WELCOME10',
      discount: '68.7000',
      total: '698.3000',
    });
    // Decision 13: the line carries what was bought and for how much, not just the listing's id
    expect(order?.lines).toMatchObject([
      { listingId: NEEM, quantity: 3, unitPrice: '229', lineTotal: '687.0000' },
    ]);
  });
});
```

The order book through the mock source, with a clock the test moves (`withClock`).

- **`wait` is an arrow property, not a method**, because the tests take it out of the object
  (`const { wait } = withClock()`); the lint rule `unbound-method` refuses a method used that way.
- **"confirms a right code, and the order then shows with its token only"** is decision 5: the same number with
  another order's token, or a made-up one, finds nothing, and a confirmed order cannot be confirmed twice.
- **"drops the order after five wrong codes"** counts `triesLeft` down from 4 to 1, then expects
  `shop_code_too_many`, then `shop_code_no_order` even for the right code. With the limit raised it fails (tried).
- **"sends a new code only after 45 seconds, and keeps the wrong codes"** is decision 18.
- **"forgets an order that waited more than an hour"** also checks the whole `codeWait` answer a minute before the
  end: the masked phone, a wait of 0 (the 45 seconds are long over) and the ordered listing.
- **"refuses an order whose total or stock changed"** has a case where only the stock changed. Ignoring
  out-of-stock lines in `place` makes it fail (tried).

### `src/server/orders.spec.ts`

```ts
import {
  problemSchema,
  shopOrderConfirmedSchema,
  shopOrderPlacedSchema,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { createMockSource } from '../data/mock/mock-source';
import type { ShopSource } from '../data/types';
import { orderTokens, ordersCookie } from './cookies';
import { answerPlaceOrder, answerResendCode, answerVerifyCode } from './orders';

const NEEM = 'lst-himalaya-purifying-neem-face-wash-150ml'; // ৳229
const OPTIONS = { secure: false };

// What the checkout sends: the phone as the shopper typed it
const ORDER: ShopOrderRequestInput = {
  lines: [{ listingId: NEEM, quantity: 3 }],
  zoneId: 'inside_dhaka',
  name: 'Nusrat Jahan',
  phone: '+880 1786-120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
  expectedTotal: '767',
};

function post(path: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie !== undefined) headers.set('Cookie', cookie);
  return new Request(`http://shop.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function problemOf(response: Response) {
  expect(response.headers.get('Content-Type')).toBe('application/problem+json');
  return problemSchema.parse(await response.json());
}

// The Set-Cookie lines by cookie name, and the "name=value" a browser would send back
function cookiesOf(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((line) => [line.slice(0, line.indexOf('=')), line]),
  );
}

function sentBack(setCookie: string | undefined): string {
  if (setCookie === undefined) throw new Error('no such cookie');
  return setCookie.slice(0, setCookie.indexOf(';'));
}

function withClock() {
  let now = new Date('2026-11-11T10:00:00+06:00');
  return {
    source: createMockSource(() => now),
    // An arrow, not a method: the tests take it out of the object (`const { wait } = …`)
    wait: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

// Places a Cash on Delivery order and gives back the cookie the browser keeps
async function placeCod(source: ShopSource): Promise<string> {
  const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
  expect(response.status).toBe(201);
  return sentBack(cookiesOf(response).get('shop_checkout'));
}

describe('POST /api/orders', () => {
  it('places a Cash on Delivery order and keeps its token out of reach of scripts', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, OPTIONS);
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const text = await response.clone().text();
    expect(shopOrderPlacedSchema.parse(JSON.parse(text))).toEqual({
      next: 'verify',
      maskedPhone: '+880 17•• ••• 356',
      resendInSeconds: 45,
    });

    const cookie = cookiesOf(response).get('shop_checkout') ?? '';
    expect(cookie).toMatch(
      /^shop_checkout=[0-9a-f]{64}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
    );
    // The token is only in the cookie, never in the body a script can read
    expect(text).not.toContain(sentBack(cookie).split('=')[1]);
  });

  it('marks the cookies Secure in production', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(post('/api/orders', ORDER), source, { secure: true });
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/; Secure$/);
  });

  it('confirms Mobile Banking at once and remembers the order in this browser', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, paymentMethod: 'online' }),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      next: 'confirmed',
      orderNo: 'W-000001',
      phone: '01786120356',
    });
    const cookies = cookiesOf(response);
    expect(cookies.get('shop_orders')).toMatch(
      /^shop_orders=W-000001:[0-9a-f]{64}; Path=\/; Max-Age=2592000;/,
    );
    // A code that was still waiting from an earlier try is forgotten
    expect(cookies.get('shop_checkout')).toMatch(/^shop_checkout=; Path=\/; Max-Age=0;/);
  });

  it('names the fields the shopper must fix', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', {
        ...ORDER,
        phone: '02 9876543',
        termsAccepted: false,
        address: 'Dhaka',
      }),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).fieldErrors).toEqual({
      phone: ['shop_phone_format'],
      address: ['shop_address_too_short'],
      termsAccepted: ['shop_terms_required'],
    });
  });

  it('refuses a body that does not say it is JSON', async () => {
    // What a form on another site can send without asking (text/plain needs no CORS preflight)
    const { source } = withClock();
    const request = new Request('http://shop.test/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(ORDER),
    });
    const response = await answerPlaceOrder(request, source, OPTIONS);
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('malformed_request');
  });

  it('answers 409 when the total is not the one the shopper saw', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', { ...ORDER, expectedTotal: '700' }),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(409);
    expect((await problemOf(response)).code).toBe('shop_order_changed');
  });

  it('says the minimum order in the problem', async () => {
    const { source } = withClock();
    const response = await answerPlaceOrder(
      post('/api/orders', {
        ...ORDER,
        lines: [{ listingId: NEEM, quantity: 1 }],
        expectedTotal: '309',
      }),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    const problem = await problemOf(response);
    expect(problem).toMatchObject({ code: 'shop_order_below_minimum', params: { minimum: '300' } });
  });

  it('hides a failing source behind internal_error', async () => {
    const down: ShopSource = {
      ...createMockSource(),
      placeOrder: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:3000')),
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const response = await answerPlaceOrder(post('/api/orders', ORDER), down, OPTIONS);
      expect(response.status).toBe(500);
      expect(JSON.stringify(await problemOf(response))).not.toContain('10.0.0.5');
    } finally {
      console.error = quiet;
    }
  });
});

describe('POST /api/orders/verify', () => {
  it('confirms the order with the code typed in Bangla digits', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '১২৩ ৪৫৬' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(200);
    expect(shopOrderConfirmedSchema.parse(await response.json())).toEqual({
      orderNo: 'W-000001',
      phone: '01786120356',
    });

    // The token moves from the waiting cookie to this browser's orders, and the order shows
    const cookies = cookiesOf(response);
    expect(cookies.get('shop_checkout')).toMatch(/Max-Age=0/);
    const orders = sentBack(cookies.get('shop_orders'));
    const token = checkout.split('=')[1] ?? '';
    expect(orders).toBe(`shop_orders=W-000001:${token}`);
    expect(await source.order('W-000001', token)).not.toBeNull();
  });

  it('says how many tries are left after a wrong code', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '000000' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(422);
    expect(await problemOf(response)).toMatchObject({
      code: 'shop_code_wrong',
      params: { triesLeft: 4 },
    });
    // The order still waits: its cookie is not touched
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('clears the cookie when the fifth wrong code drops the order', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    let response = new Response();
    for (let i = 0; i < 5; i += 1) {
      response = await answerVerifyCode(
        post('/api/orders/verify', { code: '000000' }, checkout),
        source,
        OPTIONS,
      );
    }
    expect((await problemOf(response)).code).toBe('shop_code_too_many');
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/Max-Age=0/);
  });

  it('answers 404 without a cookie, or with one it never made', async () => {
    const { source } = withClock();
    for (const cookie of [
      undefined,
      'shop_checkout=not-a-token',
      `shop_checkout=${'a'.repeat(64)}`,
    ]) {
      const response = await answerVerifyCode(
        post('/api/orders/verify', { code: '123456' }, cookie),
        source,
        OPTIONS,
      );
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe('shop_code_no_order');
    }
  });

  it('refuses a code that is not six digits before asking the source', async () => {
    const { source } = withClock();
    const checkout = await placeCod(source);
    const response = await answerVerifyCode(
      post('/api/orders/verify', { code: '12345' }, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(400);
    expect((await problemOf(response)).fieldErrors).toEqual({ code: ['shop_code_format'] });
    // Not counted as a wrong code: a typo of length is not a guess
    const right = await answerVerifyCode(
      post('/api/orders/verify', { code: '000000' }, checkout),
      source,
      OPTIONS,
    );
    expect((await problemOf(right)).params).toEqual({ triesLeft: 4 });
  });
});

describe('POST /api/orders/resend', () => {
  it('waits 45 seconds between codes, and says so in Retry-After', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);

    wait(40);
    const early = await answerResendCode(post('/api/orders/resend', {}, checkout), source, OPTIONS);
    expect(early.status).toBe(429);
    expect(early.headers.get('Retry-After')).toBe('5');
    expect(await problemOf(early)).toMatchObject({
      code: 'shop_code_resend_wait',
      params: { seconds: 5 },
    });

    wait(5);
    const sent = await answerResendCode(post('/api/orders/resend', {}, checkout), source, OPTIONS);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ resendInSeconds: 45 });
  });

  it('answers 404 and clears the cookie for an order that stopped waiting', async () => {
    const { source, wait } = withClock();
    const checkout = await placeCod(source);
    wait(60 * 60);
    const response = await answerResendCode(
      post('/api/orders/resend', {}, checkout),
      source,
      OPTIONS,
    );
    expect(response.status).toBe(404);
    expect(cookiesOf(response).get('shop_checkout')).toMatch(/Max-Age=0/);
  });
});

describe('the orders cookie', () => {
  const token = (n: number) => String(n).padStart(64, '0');

  it('keeps the newest 20 orders', () => {
    let cookie = '';
    for (let n = 1; n <= 21; n += 1) {
      const request = new Request('http://shop.test/', { headers: { Cookie: cookie } });
      cookie = sentBack(
        ordersCookie(request, `W-${String(n).padStart(6, '0')}`, token(n), OPTIONS),
      );
    }
    const kept = orderTokens(new Request('http://shop.test/', { headers: { Cookie: cookie } }));
    expect(kept.size).toBe(20);
    expect(kept.has('W-000001')).toBe(false);
    expect(kept.get('W-000021')).toBe(token(21));
  });

  it('skips a pair that was edited, and keeps the rest', () => {
    const request = new Request('http://shop.test/', {
      headers: {
        Cookie: `theme=x; shop_orders=W-000001:${token(1)}.W-000002:<script>.:${token(3)}`,
      },
    });
    expect([...orderTokens(request)]).toEqual([['W-000001', token(1)]]);
  });
});
```

The routes with real `Request` objects and the mock source.

- **`cookiesOf`** reads `response.headers.getSetCookie()`, which gives each `Set-Cookie` line on its own.
  `headers.get('Set-Cookie')` would join them with commas, and a cookie's expiry date can hold a comma.
- **"keeps its token out of reach of scripts"** checks the exact cookie line (`HttpOnly; SameSite=Lax`, an hour) and
  that the token is nowhere in the body. Without `HttpOnly` it fails (tried).
- **"refuses a body that does not say it is JSON"** is the cross-site form case of `readBody`.
- **"answers 404 without a cookie, or with one it never made"** tries no cookie, a malformed one and a well-formed
  token no order has.
- **"the orders cookie"** tests the 20-order limit and a cookie with broken pairs, next to another site cookie
  (`theme=x`).

### `src/lib/quote.spec.ts`

```diff
@@ -1,10 +1,13 @@
 import { describe, expect, it } from 'vitest';
 
+import { mockQuoteContext } from '../data/mock/mock-source';
 import { mockCatalog } from '../data/mock/products';
 import { quoteCart } from '../data/mock/quote';
 import { isCartQuote } from './quote';
 
 describe('isCartQuote', () => {
+  const context = mockQuoteContext(new Date('2026-11-11T10:00:00+06:00'));
+
   // The guard is hand-written, so it is tested against what the server really sends: every kind
   // of line the mock source can answer
   it('takes the answers the quote route sends', () => {
@@ -20,7 +23,7 @@ describe('isCartQuote', () => {
           { listingId: 'lst-gone', quantity: 2 },
         ],
       },
-      mockCatalog,
+      context,
     );
     expect(quote.lines.map((line) => line.status)).toEqual([
       'available',
@@ -28,7 +31,7 @@ describe('isCartQuote', () => {
       'unavailable',
     ]);
     expect(isCartQuote(quote)).toBe(true);
-    expect(isCartQuote(quoteCart({ lines: [] }, mockCatalog))).toBe(true);
+    expect(isCartQuote(quoteCart({ lines: [] }, context))).toBe(true);
   });
 
   it('refuses a body it could not draw', () => {
```

The drawer's guard is tested with the new `quoteCart` signature. `lib/quote.ts` itself does not change: it checks
only what the drawer draws, and the extra fields in the answer pass through it.

### Check this part

```bash
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop/src
pnpm boundaries
```

`typecheck` passes again after this part (26c.2 left `quote.ts` failing). The shop has 81 tests.

To see the routes on a real server, build and start it on a free port:

```bash
pnpm --filter @omnivo/shop build
HOST=127.0.0.1 PORT=4399 node apps/shop/dist/server/entry.mjs
```

Then, in another terminal, place a Cash on Delivery order, keep its cookie, and send the mock's code:

```bash
curl -s -c jar -X POST http://127.0.0.1:4399/api/orders -H 'Content-Type: application/json' \
  -d '{"lines":[{"listingId":"lst-himalaya-purifying-neem-face-wash-150ml","quantity":3}],
       "zoneId":"inside_dhaka","name":"Nusrat Jahan","phone":"01786 120356",
       "address":"House 12, Road 5, Mirpur 10, Dhaka","paymentMethod":"cod",
       "termsAccepted":true,"expectedTotal":"767"}'
curl -s -i -b jar -X POST http://127.0.0.1:4399/api/orders/verify \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'
rm jar
```

The first answers `{"next":"verify","maskedPhone":"+880 17•• ••• 356","resendInSeconds":45}`. The second answers
`{"orderNo":"W-000001","phone":"01786120356"}` with two `Set-Cookie` lines: `shop_orders=W-000001:…` and
`shop_checkout=` with `Max-Age=0`. Both are `Secure`, because this is the built server.

Broken on purpose while writing this part, and caught: free delivery checked with `>` in place of `>=` (an order of
exactly ৳1,000), the coupon's last day worked out in UTC in place of the shop's time zone, a fixed discount larger than
the subtotal, no limit on wrong codes, an out-of-stock line left in the order, the cookies without `HttpOnly`, a
waiting order shown by `order()`, and a new `ShopRefusalCode` with no status (two type errors in `server/orders.ts`).

## 26c.4 — `apps/shop`: the checkout page

This part draws `/checkout` (Figma `checkout_process` 37:3765) and connects it to 26c.3's routes. The form is the
shop's first React island (decision 1). Placing a Cash on Delivery order goes to `/checkout/verify`, which 26c.5
draws; until then that address answers 404. Placing a Mobile Banking order confirms it at once and fires the event
26c.5's dialog listens for; until then nothing opens, and the checkout simply stays on screen with an empty cart.

The island lives in `src/islands/checkout/`, one folder for everything that may use React, Zod and react-hook-form.
The import rules at the end of this part keep those three inside it.

### `package.json`

```diff
@@ -15,7 +15,9 @@
     "@astrojs/node": "~11.1.11",
     "@astrojs/react": "^7.1.4",
     "@fontsource-variable/geist": "^5.3.0",
+    "@fontsource-variable/geist-mono": "^5.3.0",
     "@fontsource/noto-sans-bengali": "^5.3.0",
+    "@hookform/resolvers": "^5.9.1",
     "@hugeicons/core-free-icons": "^4.3.5",
     "@hugeicons/react": "^1.1.10",
     "@omnivo/contracts": "workspace:*",
@@ -23,7 +25,9 @@
     "astro": "^7.4.7",
     "nanostores": "^1.5.5",
     "react": "^19.3.0",
-    "react-dom": "^19.3.0"
+    "react-dom": "^19.3.0",
+    "react-hook-form": "^7.89.0",
+    "zod": "^4.6.5"
   },
   "devDependencies": {
     "@astrojs/check": "^0.9.12",
```

- **`react-hook-form` and `@hookform/resolvers`** at the versions `apps/app` uses, so the workspace has one copy of
  each (`pnpm dedupe` stays clean).
- **`zod` is a direct dependency now.** The island builds its form schema with `z.object`. It came in through
  `@omnivo/contracts` before, but pnpm only lets a package import what its own `package.json` names.

- **`@fontsource-variable/geist-mono`** is 26c.5's (the order number on `/order/<no>`); it is in this diff because the
  file is shown once. Adding it now does no harm.

Run `pnpm install` after this change; `pnpm-lock.yaml` gets the four dependencies (three lines each) in the shop's
importer.

### `src/lib/order-events.ts`

```ts
import type { ShopOrderConfirmed } from '@omnivo/contracts';

// Step 26c: the checkout tells the page that an order is confirmed with a DOM event, not a React
// prop. Two places confirm an order: the checkout island (Mobile Banking, no code) and the verify
// page's script (a right code, 26c.5). One "Order Confirmed" dialog listens on the document, so it
// does not care which of them sent it, and neither imports the dialog's code.
export const ORDER_CONFIRMED_EVENT = 'shop:order-confirmed';

export type OrderConfirmedEvent = CustomEvent<ShopOrderConfirmed>;

// Step 26c.5: TypeScript's list of the document's events gets this one, so a listener written
// `document.addEventListener(ORDER_CONFIRMED_EVENT, (event) => …)` gets an OrderConfirmedEvent,
// with a typed `detail`, and needs no cast. `as const` is not needed: a `const` string is its own
// literal type, which is what the map is looked up by
declare global {
  interface DocumentEventMap {
    [ORDER_CONFIRMED_EVENT]: OrderConfirmedEvent;
  }
}

export function announceOrderConfirmed(order: ShopOrderConfirmed): void {
  document.dispatchEvent(new CustomEvent(ORDER_CONFIRMED_EVENT, { detail: order }));
}
```

The event that says "this order is confirmed" (decision 24). A `CustomEvent` on `document` with the
`ShopOrderConfirmed` answer as its `detail`. It lives in `lib/`, not in the island's folder, because 26c.5's verify
page sends it from an Astro script, and the dialog that listens is Astro too. It imports only a type, so it is light
enough for any script.

The `declare global` block adds the event to TypeScript's `DocumentEventMap`, the list of events `document` sends with
their types. Then `document.addEventListener(ORDER_CONFIRMED_EVENT, (event) => event.detail.orderNo)` type-checks with
no cast: without it, `event` would be a plain `Event` with no `detail`. The interface's key is the constant itself, so
the name is written once.

### `src/islands/checkout/words.ts`

```ts
import type { ErrorCode, ShopCheckoutSettings, ShopPaymentMethod } from '@omnivo/contracts';

import type { ShopLocale } from '../../lib/locale';

// Step 26c (decision 1): the checkout island's words, translated on the server by the Astro page
// and handed to the island as one prop. The island never imports '@omnivo/i18n': its main entry
// starts i18next with every English word (about 150 KB gz), for a page that shows 50 of them.
// Only this file's types reach the browser (`import type` in the island); its code runs in the
// page's frontmatter.

// A word with a value that only the browser knows (a product's name, the coupon's amount) keeps
// its placeholder: t() puts '{{name}}' back where the name goes, and the island's fill() puts the
// value in. i18next does not read placeholders inside a value again, so they survive as text.
// Written out as objects, like the cart drawer's, because the typed t() checks that the options
// name the word's own placeholders
const NAME = { name: '{{name}}' };
const MINIMUM = { minimum: '{{minimum}}' };

export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSettings) {
  return {
    heading: t('shop.checkout.heading'),
    name: t('shop.checkout.name'),
    phone: t('shop.checkout.phone'),
    address: t('shop.checkout.address'),
    zone: t('shop.checkout.zone'),
    // Known on the server: the settings are part of the page
    freeDeliveryFrom:
      settings.freeDeliveryFrom === null
        ? null
        : t('shop.checkout.freeDeliveryFrom', { amount: money(settings.freeDeliveryFrom) }),
    items: t('shop.checkout.items'),
    outOfStock: t('shop.checkout.outOfStock'),
    priceChanged: t('shop.checkout.priceChanged', { old: '{{old}}' }),
    deliveryCharge: t('shop.checkout.deliveryCharge'),
    free: t('shop.checkout.free'),
    pickZone: t('shop.checkout.pickZone'),
    discount: t('shop.checkout.discount', { code: '{{code}}' }),
    total: t('shop.checkout.total'),
    promo: t('shop.checkout.promo'),
    promoPlaceholder: t('shop.checkout.promoPlaceholder'),
    apply: t('shop.checkout.apply'),
    applying: t('shop.checkout.applying'),
    removeCoupon: t('shop.checkout.removeCoupon'),
    couponApplied: t('shop.checkout.couponApplied', { code: '{{code}}', off: '{{off}}' }),
    payment: t('shop.checkout.payment'),
    termsBefore: t('shop.checkout.termsBefore'),
    termsLink: t('shop.checkout.termsLink'),
    termsAfter: t('shop.checkout.termsAfter'),
    confirm: t('shop.checkout.confirm'),
    placing: t('shop.checkout.placing'),
    orderFailed: t('shop.checkout.orderFailed'),
    belowMinimum: t('shop.checkout.belowMinimum', { minimum: '{{minimum}}', more: '{{more}}' }),
    emptyTitle: t('shop.checkout.emptyTitle'),
    emptyText: t('shop.checkout.emptyText'),
    // The cart drawer's words, for the same parts on this page
    continueShopping: t('shop.cart.continueShopping'),
    loading: t('shop.cart.loading'),
    failed: t('shop.cart.failed'),
    retry: t('shop.cart.retry'),
    decrease: t('shop.cart.decrease', NAME),
    increase: t('shop.cart.increase', NAME),
    quantity: t('shop.cart.quantity', NAME),
    remove: t('shop.cart.remove', NAME),
    removedOne: t('shop.cart.removed', { count: 1, replace: { count: '{{count}}' } }),
    removedOther: t('shop.cart.removed', { count: 2, replace: { count: '{{count}}' } }),
    // The error codes the checkout can show: the form's own checks, the order route's refusals
    // and the promo box. 18 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
    // a real error code, so a typo is a type error, not a missing sentence
    errors: {
      required: t('errors.required'),
      too_long: t('errors.too_long'),
      invalid_value: t('errors.invalid_value'),
      invalid_input: t('errors.invalid_input'),
      malformed_request: t('errors.malformed_request'),
      internal_error: t('errors.internal_error'),
      shop_phone_format: t('errors.shop_phone_format'),
      shop_address_too_short: t('errors.shop_address_too_short'),
      shop_zone_unknown: t('errors.shop_zone_unknown'),
      shop_payment_unavailable: t('errors.shop_payment_unavailable'),
      shop_terms_required: t('errors.shop_terms_required'),
      shop_cart_empty: t('errors.shop_cart_empty'),
      shop_order_below_minimum: t('errors.shop_order_below_minimum', MINIMUM),
      shop_order_changed: t('errors.shop_order_changed'),
      shop_coupon_format: t('errors.shop_coupon_format'),
      shop_coupon_unknown: t('errors.shop_coupon_unknown'),
      shop_coupon_expired: t('errors.shop_coupon_expired'),
      shop_coupon_minimum: t('errors.shop_coupon_minimum', MINIMUM),
    } satisfies Partial<Record<ErrorCode, string>>,
  };
}

export type CheckoutWords = ReturnType<typeof checkoutWords>;
export type CheckoutErrorCode = keyof CheckoutWords['errors'];

// The radio cards, with their labels worked out on the server: "Inside Dhaka — ৳80"
export interface CheckoutChoice<T extends string = string> {
  id: T;
  label: string;
}

export function checkoutChoices({ t, money }: ShopLocale, settings: ShopCheckoutSettings) {
  return {
    zones: settings.zones.map((zone): CheckoutChoice => ({
      id: zone.id,
      label: t('shop.checkout.zoneOption', { name: zone.name, charge: money(zone.charge) }),
    })),
    payments: settings.paymentMethods.map((method): CheckoutChoice<ShopPaymentMethod> => ({
      id: method,
      label: t(`shop.checkout.${method}`),
    })),
  };
}
```

The words the island shows, made on the server (decision 1). The page calls `checkoutWords()` in its frontmatter and
passes the result as a prop; Astro writes it into the HTML as JSON. The island imports only the *type*
`CheckoutWords`, so none of this file's code, and none of i18next, reaches the browser.

- **Placeholders are kept for values only the browser knows.** `t('shop.cart.decrease', { name: '{{name}}' })` gives
  back "One less {{name}}", and the island's `fill()` puts the product's name in. i18next does not read a placeholder
  inside a value again, so `{{name}}` survives as text. The drawer does the same with `data-*` attributes.
- **They are written out as objects** (`NAME`, `MINIMUM`, `{ code: '{{code}}' }`), not made by a helper. The typed
  `t()` checks that the options name the word's own placeholders; a helper that returns `Record<string, string>` loses
  the names and fails the type check, and a helper that keeps them needs a cast.
- **Words known on the server are finished on the server**: "Free delivery on orders over ৳1,000" and the zone labels
  ("Inside Dhaka — ৳80"). The island never formats an amount it does not have to.
- **`errors` is a list of 18 sentences, not all of `errors.*`.** Those are the codes this page can meet: the form's
  checks, the order route's refusals and the promo box. `satisfies Partial<Record<ErrorCode, string>>` makes each key a
  real error code, so a typo is a type error. `CheckoutErrorCode` is the keys of this object, so the list is written
  once.
- **`checkoutChoices()`** gives the radio cards their id and label. `CheckoutChoice<ShopPaymentMethod>` keeps the
  payment ids typed as `'cod' | 'online'`, so the form's default payment method type-checks against the schema.

### `src/islands/checkout/checkout.ts`

```ts
import {
  errorCode,
  shopCartQuoteRequestSchema,
  shopOrderRequestSchema,
  subtractMoney,
  type Problem,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopDiscount,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';
import { z } from 'zod';

import type { CartLine } from '../../lib/cart';
import type { CheckoutErrorCode, CheckoutWords } from './words';

// Step 26c: the checkout island's plain logic, out of the components so vitest can test it
// without a browser. Zod and the contracts are allowed here: this file is part of the checkout's
// own chunk, which only /checkout loads (decision 1, src/boundaries.spec.ts).

// The form's fields. The same rules as the order request (one schema, so a name the form accepts
// is never refused by the server), with two changes for a form that starts empty:
// - zoneId: no radio is picked at first, so the value is '' until one is. An empty zone says
//   "Pick a delivery location", not the generic "too short" that min(1) would give
// - termsAccepted: a checkbox is true or false. The request's z.literal(true) would make the
//   form's starting value `false` a type error; the button stays disabled until it is ticked,
//   and the request is only built when it is (orderRequest below)
export const checkoutFormSchema = z.object({
  name: shopOrderRequestSchema.shape.name,
  phone: shopOrderRequestSchema.shape.phone,
  address: shopOrderRequestSchema.shape.address,
  zoneId: z.string().min(1, errorCode('shop_zone_unknown')),
  paymentMethod: shopOrderRequestSchema.shape.paymentMethod,
  termsAccepted: z.boolean(),
});

// What the inputs hold (the phone as typed) and what a valid form gives (the phone made plain)
export type CheckoutFormInput = z.input<typeof checkoutFormSchema>;
export type CheckoutFormValues = z.output<typeof checkoutFormSchema>;
export type CheckoutField = keyof CheckoutFormInput;

const FIELDS = new Set<string>(Object.keys(checkoutFormSchema.shape));

function isField(name: string): name is CheckoutField {
  return FIELDS.has(name);
}

// Puts the browser's values into a word the server translated with its placeholders kept
// ("One less {{name}}" → "One less Neem Face Wash")
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function hasWords(words: CheckoutWords, code: string): code is CheckoutErrorCode {
  // hasOwn, not `in`: 'toString' is in every object
  return Object.hasOwn(words.errors, code);
}

// The sentence for an error code. A code the page has no sentence for (a newer server) falls back
// to "Enter a valid value", never to the code itself
export function errorText(
  words: CheckoutWords,
  code: string,
  values: Record<string, string> = {},
): string {
  return fill(hasWords(words, code) ? words.errors[code] : words.errors.invalid_value, values);
}

// The promo box's text, checked with the quote request's own rule (trimmed, upper case, letters,
// digits and dashes). `unwrap()` takes the rule out of its optional(). null: the box is empty, so
// Apply does nothing
const couponCodeSchema = shopCartQuoteRequestSchema.shape.couponCode.unwrap();

export function parseCouponCode(
  text: string,
): { ok: true; code: string } | { ok: false; error: 'shop_coupon_format' } | null {
  if (text.trim() === '') return null;
  const parsed = couponCodeSchema.safeParse(text);
  return parsed.success
    ? { ok: true, code: parsed.data }
    : { ok: false, error: 'shop_coupon_format' };
}

// "10%" or "৳50", the same way the discount ribbon writes them (ListingMarks.astro)
export function discountText(discount: ShopDiscount, money: (value: string) => string): string {
  return discount.kind === 'amount' ? money(discount.value) : `${String(discount.value)}%`;
}

// A quote request as a string: the quote on screen answers the request with the same key. Lines
// in the cart's order, the zone and the code exactly as sent
export function quoteKey(request: ShopCartQuoteRequest): string {
  return JSON.stringify([request.lines, request.zoneId ?? null, request.couponCode ?? null]);
}

// The quote request for the cart, the picked zone ('' = none yet) and the applied code. The keys
// are left out when there is no value (exactOptionalPropertyTypes): the route reads a missing
// zone as "no zone", and an empty string would fail its schema
export function quoteRequest(
  lines: CartLine[],
  zoneId: string,
  couponCode: string | undefined,
): ShopCartQuoteRequest {
  return {
    lines,
    ...(zoneId === '' ? {} : { zoneId }),
    ...(couponCode === undefined ? {} : { couponCode }),
  };
}

// After "A price or the stock changed" (decision 10): the lines whose price is not the one the
// shopper saw, with the old price, so each can say "Was ৳229". A line that went out of stock says
// so on its own; a line that came back in stock had no price before, so it is not "changed"
export function changedPrices(before: ShopCartQuote, after: ShopCartQuote): Map<string, string> {
  const old = new Map(
    before.lines.flatMap((line) =>
      line.status === 'available' ? [[line.listingId, line.unitPrice] as const] : [],
    ),
  );
  const changed = new Map<string, string>();
  for (const line of after.lines) {
    if (line.status !== 'available') continue;
    const was = old.get(line.listingId);
    if (was !== undefined && was !== line.unitPrice) changed.set(line.listingId, was);
  }
  return changed;
}

// "Add ৳60 more": the minimum less the items. Shown only, never sent: the server decides with its
// own numbers (belowMinimum in the quote), the browser only says by how much
export function shortBy(minimum: string, subtotal: string): string {
  return subtractMoney(minimum, subtotal);
}

// The order request: the form's checked values, the same lines, zone and code as the quote on
// screen, and that quote's total as the total the shopper saw. null while the box is not ticked:
// the request type needs `true` there, and the button is disabled then anyway
export function orderRequest(
  values: CheckoutFormValues,
  lines: CartLine[],
  couponCode: string | undefined,
  quote: ShopCartQuote,
): ShopOrderRequestInput | null {
  if (!values.termsAccepted) return null;
  return {
    lines,
    zoneId: values.zoneId,
    ...(couponCode === undefined ? {} : { couponCode }),
    name: values.name,
    phone: values.phone,
    address: values.address,
    paymentMethod: values.paymentMethod,
    termsAccepted: values.termsAccepted,
    expectedTotal: quote.total,
  };
}

// Where a refusal of Confirm Order is shown. A field's own error goes under the field; the rest
// is one line above the button. 400 invalid_input names its fields (fieldErrors, "phone"); the
// order route's refusals name none, but two of them are about one field. A list of pairs, not a
// record, so the form can hand each field to setError() without a cast
export function refusalErrors(problem: Problem): {
  fields: { field: CheckoutField; code: string }[];
  general: string | null;
} {
  const fields: { field: CheckoutField; code: string }[] = [];
  let general: string | null = null;
  for (const [name, codes] of Object.entries(problem.fieldErrors ?? {})) {
    const code = codes[0];
    if (code === undefined) continue;
    if (isField(name)) fields.push({ field: name, code });
    // A line's error ("lines.2.quantity"): the stored cart is not what the server takes. Its own
    // code ("Enter a smaller number") would point at a box the page does not have
    else general ??= 'invalid_input';
  }
  if (problem.code === 'shop_zone_unknown' || problem.code === 'shop_payment_unavailable') {
    fields.push({
      field: problem.code === 'shop_zone_unknown' ? 'zoneId' : 'paymentMethod',
      code: problem.code,
    });
  } else if (problem.code !== 'invalid_input') {
    general = problem.code;
  } else if (fields.length === 0) {
    // invalid_input that names no field of the form: say what it is once
    general ??= 'invalid_input';
  }
  return { fields, general };
}

// A Bangla keyboard types ০–৯; the cart keeps ASCII numbers (the same rule as the cart drawer)
export function parseQuantity(text: string): number | undefined {
  const ascii = text.trim().replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6));
  return /^\d+$/.test(ascii) ? Number(ascii) : undefined;
}
```

The island's plain logic, outside the components so vitest can test it in Node.

- **`checkoutFormSchema` reuses the order request's rules** for name, phone, address and payment method
  (`shopOrderRequestSchema.shape.name`), so a value the form accepts is never refused by the server for the same
  reason. Two fields differ, and the comment says why: the zone starts as `''` and needs its own message, and the
  terms box is a `boolean`, because `z.literal(true)` would make the form's starting value `false` a type error.
- **`CheckoutFormInput` and `CheckoutFormValues`** are `z.input` and `z.output`. They differ in one place: the phone
  as typed ("+880 1786-120356") and the phone made plain ("01786120356"). react-hook-form takes both types, so the
  inputs hold what the shopper typed and `handleSubmit` gets the plain one.
- **`errorText()`** falls back to "Enter a valid value" for a code the page has no sentence for, never shows the code
  itself. `hasWords()` uses `Object.hasOwn`, not `in`: `'toString' in words.errors` is `true`.
- **`parseCouponCode()`** checks the promo box with the quote request's own rule. `shape.couponCode` is
  `optional(...)`; `unwrap()` takes the rule out of it. So " welcome10 " becomes `WELCOME10` here exactly as on the
  server, and a code with a space is refused before any request.
- **`quoteRequest()` leaves out an empty zone and a missing code** instead of sending `''` or `undefined`. The route's
  schema would refuse `zoneId: ''` (it needs at least one character), and with `exactOptionalPropertyTypes` a key set
  to `undefined` is not the same type as a missing key.
- **`quoteKey()`** is the request as a string: the quote on screen answers the cart only when the keys match. The
  hook uses it to grey the amounts while a newer cart is being priced.
- **`changedPrices()`** compares the quote the shopper saw with the new one after `shop_order_changed`, and returns
  the old price of each line that moved (decision 10). A line that went out of stock is left out (it says so itself),
  and so is one that came back in stock (it had no price to compare).
- **`shortBy()`** works out "Add ৳60 more" with the contracts' money helper, in whole ten-thousandths, never with
  JavaScript numbers. It is only shown: the server decides with its own `belowMinimum`.
- **`orderRequest()`** returns `null` while the terms box is not ticked. Inside the `if`, TypeScript narrows
  `values.termsAccepted` to `true`, which is the type the request needs; no cast. `expectedTotal` is the quote's total,
  the number on the screen.
- **`refusalErrors()`** decides where each refusal is shown. A field's error goes under its field; a cart line's error
  (`lines.2.quantity`) is said once above the button as "Check the highlighted fields", because the page has no box
  for that line's limit. `shop_zone_unknown` and `shop_payment_unavailable` name no field but are about one, so they go
  under their radio group. It returns a list of `{ field, code }` pairs, not a record, so the form can pass each field
  to `setError()` typed, without `Object.keys(...) as ...`.
- **`parseQuantity()`** is the drawer's rule: ASCII or Bangla digits, nothing else.

### `src/islands/checkout/api.ts`

```ts
import {
  problemSchema,
  shopCartQuoteSchema,
  shopOrderPlacedSchema,
  type Problem,
  type ShopCartQuote,
  type ShopCartQuoteRequest,
  type ShopOrderPlaced,
  type ShopOrderRequestInput,
} from '@omnivo/contracts';

// Step 26c: the checkout's two requests. Unlike the cart drawer (lib/quote.ts, a hand-written
// guard to keep Zod off every page), the checkout already has Zod in its chunk, so each answer is
// checked against its contract: a broken answer is a failure, never a total of "undefined".

function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    // The order routes refuse anything else (server/problem.ts → readBody)
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export class CheckoutQuoteError extends Error {
  override name = 'CheckoutQuoteError';
}

// The cart priced with the zone and the coupon. An AbortError passes through as it is: the island
// ignores it, because a newer request replaced this one
export async function fetchCheckoutQuote(
  request: ShopCartQuoteRequest,
  signal: AbortSignal,
): Promise<ShopCartQuote> {
  const response = await postJson('/api/cart/quote', request, signal);
  if (!response.ok) throw new CheckoutQuoteError(`quote answered ${String(response.status)}`);
  const parsed = shopCartQuoteSchema.safeParse(await response.json());
  if (!parsed.success) throw new CheckoutQuoteError('quote answer has the wrong shape');
  return parsed.data;
}

// What Confirm Order can end in. `refused` is the server saying no with a code (a field, a changed
// price); `failed` is no usable answer at all (no network, a proxy's HTML page), where the order
// may or may not have reached the server
export type PlaceOrderResult =
  | { kind: 'placed'; answer: ShopOrderPlaced }
  | { kind: 'refused'; problem: Problem }
  | { kind: 'failed' };

export async function placeOrder(request: ShopOrderRequestInput): Promise<PlaceOrderResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await postJson('/api/orders', request);
    body = await response.json();
  } catch (error) {
    console.error(error);
    return { kind: 'failed' };
  }
  if (response.ok) {
    const placed = shopOrderPlacedSchema.safeParse(body);
    return placed.success ? { kind: 'placed', answer: placed.data } : { kind: 'failed' };
  }
  const problem = problemSchema.safeParse(body);
  return problem.success ? { kind: 'refused', problem: problem.data } : { kind: 'failed' };
}
```

The island's two requests (decision 25).

- **`fetchCheckoutQuote()`** posts to 26b's quote route with the zone and the code, and parses the answer with
  `shopCartQuoteSchema`. An AbortError passes through untouched: the hook aborts the old request when the cart changes.
- **`placeOrder()` never throws.** It returns one of three results, and the form handles each: `placed` (the body
  passed `shopOrderPlacedSchema`), `refused` (a problem body with a code), `failed` (no network, or a body that is
  neither). A `failed` order may still have reached the server, so its words say "was not sent" and ask to check the
  connection, not "try again" blindly; a second order would wait for its own code anyway.

### `src/islands/checkout/hooks.ts`

```ts
import type { ShopCartQuote } from '@omnivo/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { $cart, removeFromCart, type CartLine } from '../../lib/cart';
import { fetchCheckoutQuote } from './api';
import { quoteKey, quoteRequest } from './checkout';

// Step 26c: the checkout island's two hooks, the React side of what the cart drawer does by hand.

// The cart from the same nanostore the header and the drawer use, so a click on the stepper here
// changes the header's count at once. Without @nanostores/react: this hook is all the island
// needs from it, and useSyncExternalStore is what that package uses too.
// The server has no cart (it lives in this browser's localStorage), so the page is drawn with
// `null`, "not known yet", and the island shows "Getting today's prices…" until the browser
// takes over. An empty array would draw "Your cart is empty" for every shopper for a moment
function subscribe(onChange: () => void): () => void {
  // listen(), not subscribe(): React asks for the value itself and only wants to hear of changes.
  // The first listener also loads the stored cart (cart.ts → onMount)
  return $cart.listen(onChange);
}

const cartNow = (): CartLine[] => $cart.get();
const cartOnServer = (): null => null;

export function useCart(): CartLine[] | null {
  return useSyncExternalStore(subscribe, cartNow, cartOnServer);
}

// The same pause as the drawer: five quick clicks on "one more" make one request, not five
const QUOTE_DELAY = 250;

export type QuoteState =
  | { status: 'loading' }
  | { status: 'failed' }
  // `key` is the request this quote answers. `removed` counts the listings it said the shop no
  // longer sells, which have left the cart
  | { status: 'ready'; quote: ShopCartQuote; key: string; removed: number };

export function useCheckoutQuote(
  lines: CartLine[] | null,
  zoneId: string,
  couponCode: string | undefined,
) {
  const [state, setState] = useState<QuoteState>({ status: 'loading' });
  // Bumped by retry() and refresh() to run the effect again for the same cart
  const [attempt, setAttempt] = useState(0);
  // The request the last answer was for; null until the first one, so that one goes at once
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (lines === null || lines.length === 0) return;
    const request = quoteRequest(lines, zoneId, couponCode);
    // The quote on screen already answers this cart (a line the server dropped was just removed)
    if (answered.current === quoteKey(request)) return;

    const controller = new AbortController();
    const load = async (): Promise<void> => {
      // A failure stays on screen until a newer cart is being priced
      setState((current) => (current.status === 'failed' ? { status: 'loading' } : current));
      let quote: ShopCartQuote;
      try {
        quote = await fetchCheckoutQuote(request, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error(error);
        // Old prices could be wrong now, so they go, as in the drawer
        setState({ status: 'failed' });
        return;
      }
      // Listings the shop no longer sells leave the stored cart. The rest of the answer is still
      // right without them (they add nothing), so it answers the cart that is left, and removing
      // them asks for nothing again
      const gone = new Set(
        quote.lines.filter((line) => line.status === 'unavailable').map((line) => line.listingId),
      );
      const kept = lines.filter((line) => !gone.has(line.listingId));
      const key = quoteKey(quoteRequest(kept, zoneId, couponCode));
      answered.current = key;
      setState({ status: 'ready', quote, key, removed: gone.size });
      if (gone.size > 0) removeFromCart(gone);
    };
    // The first request goes at once; the rest wait for the clicks to stop
    const timer = window.setTimeout(
      () => {
        void load();
      },
      answered.current === null ? 0 : QUOTE_DELAY,
    );
    return () => {
      window.clearTimeout(timer);
      // An answer for a cart that no longer exists would be drawn over the newer one
      controller.abort();
    };
  }, [lines, zoneId, couponCode, attempt]);

  // "Try again" after a failure: the same cart, asked again at once
  const retry = useCallback(() => {
    answered.current = null;
    setState({ status: 'loading' });
    setAttempt((count) => count + 1);
  }, []);

  // After Confirm Order was refused because the cart changed: the answer on screen is old, so the
  // same request is asked again, and the old quote stays on screen (grey) until the new one comes
  const refresh = useCallback(() => {
    answered.current = null;
    // An empty key matches no cart, so the quote on screen counts as old until the answer
    setState((current) => (current.status === 'ready' ? { ...current, key: '' } : current));
    setAttempt((count) => count + 1);
  }, []);

  const key = lines === null ? null : quoteKey(quoteRequest(lines, zoneId, couponCode));
  // The quote on screen is for an older cart: its amounts are grey and Confirm Order waits
  const pricing = state.status === 'ready' && state.key !== key;
  return { state, pricing, retry, refresh };
}
```

- **`useCart()`** reads 26a's `$cart` store with React's `useSyncExternalStore`. That is all `@nanostores/react` does
  for one store, so the package is not added. `listen()`, not `subscribe()`: React asks for the value itself and only
  wants to hear about changes; the first listener also loads the stored cart (`cart.ts` → `onMount`).
- **The server's value is `null`, not `[]`.** The cart lives in the browser, so the server cannot know it. With `[]`
  the server would draw "Your cart is empty" and every shopper would see it flash before the browser took over. With
  `null` the page is drawn with "Getting today's prices…", which is true in both places. React uses the third
  argument (`cartOnServer`) while it hydrates, then switches to the real cart.
- **One store for the whole page.** The header's count and the drawer use the same `$cart`; Vite puts `cart.ts` in one
  shared chunk, so a click on the checkout's stepper changes the header's count at once (checked in the browser).
- **`useCheckoutQuote()`** is the drawer's quoting loop as an effect. The effect depends on the cart array, the zone
  and the code: the store gives a new array only when the cart changes, so typing in the name box does not ask for
  prices. The first request goes at once, later ones 250 ms after the last change. The cleanup aborts the request and
  the timer, so an old answer is never drawn over a newer cart.
- **`answered` is a ref, not state.** It is the request the last answer was for, read only inside the effect. As state,
  setting it would draw the page once more for nothing.
- **`setState` is only called after an `await` or a timer**, never straight in the effect's body. React's lint rule
  (`react-hooks/set-state-in-effect`) refuses the second, because it draws the page twice for one change.
- **Listings the shop no longer sells leave the cart**, as in the drawer. The answer then counts as the answer for the
  cart that is left, so removing them does not ask again. `removed` is how many, for the screen reader's sentence.
- **`refresh()`** after a refused order marks the quote on screen as old by setting its key to `''` (which matches no
  cart), and asks again. The old amounts stay on screen, grey, until the new ones come.

### `src/islands/checkout/fields.tsx`

```tsx
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

import type { CheckoutChoice } from './words';

// Step 26c: the checkout's form parts (CLAUDE.md → Storefront → Checkout card). Labels 16px/600
// brand, 12px above their control; errors under the control in `promo` with an Alert02 icon.

export function FieldError({ id, text }: { id?: string; text: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sf-small font-medium text-promo">
      {/* mt: the 16px icon sits on the first line of a 24px line height, not above it */}
      <HugeiconsIcon
        icon={Alert02Icon}
        size={16}
        strokeWidth={1.5}
        className="mt-1 shrink-0"
        aria-hidden="true"
      />
      <span>{text}</span>
    </p>
  );
}

// An input with its label and error. Everything else (register's name, onChange, onBlur and ref,
// type, autoComplete) goes to the <input> as it is: React 19 passes `ref` like any other prop
type TextFieldProps = ComponentProps<'input'> & { label: string; error: string | undefined };

export function TextField({ label, error, ...input }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-3">
      {/* Trimmed (as Figma draws it): the input starts 23px under the label's top, not 32px */}
      <label htmlFor={id} className="trim-text font-semibold">
        {label}
      </label>
      {/* Figma: 48px, white, a 1px #E9E9E9 border, radius 8. The error border is promo, so the
          field that needs fixing is found without reading every message */}
      <input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className="h-12 w-full min-w-0 rounded-lg border border-field bg-card px-4 transition-colors duration-150 placeholder:text-muted hover:border-muted-line focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand aria-invalid:border-promo"
        {...input}
      />
      {error !== undefined && <FieldError id={errorId} text={error} />}
    </div>
  );
}

// A group of radio cards: Delivery Location, Payment Method. The whole card is the <label>, so a
// tap anywhere on it picks it. The radio is a real <input type="radio">: the arrow keys move
// between the cards and a screen reader says "1 of 2", which a styled <div> would not
interface RadioCardsProps {
  legend: string;
  choices: CheckoutChoice[];
  field: UseFormRegisterReturn;
  error: string | undefined;
  // A line under the cards ("Free delivery on orders over ৳1,000")
  hint?: ReactNode;
}

export function RadioCards({ legend, choices, field, error, hint }: RadioCardsProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <fieldset aria-describedby={error === undefined ? undefined : errorId}>
      <legend className="trim-text font-semibold">{legend}</legend>
      {/* Two cards side by side from md (Figma), one column on a phone */}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {choices.map((choice) => (
          <label
            key={choice.id}
            // The focus ring goes around the card, not the 24px circle; the radio's own outline is
            // turned off below
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-cream px-[30px] py-5 font-semibold has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand"
          >
            {/* Figma: a 24px circle, a brand ring, a brand dot when picked. The dot is the
                background; a 4px inset shadow in the card's white makes the gap around it */}
            <input
              type="radio"
              value={choice.id}
              className="size-6 shrink-0 appearance-none rounded-full border-[1.5px] border-brand bg-card checked:bg-brand checked:shadow-[inset_0_0_0_4px_var(--color-card)] focus-visible:outline-none"
              {...field}
            />
            {choice.label}
          </label>
        ))}
      </div>
      {hint}
      {error !== undefined && (
        <div className="mt-3">
          <FieldError id={errorId} text={error} />
        </div>
      )}
    </fieldset>
  );
}
```

- **`TextField`** passes everything it does not use to the `<input>`, including react-hook-form's `ref`: React 19
  passes `ref` to a function component like any other prop, so no `forwardRef`. The error is linked with
  `aria-describedby`, and `aria-invalid` turns the border `promo`.
- **`RadioCards`** are real `<input type="radio">` inside a `<label>` that is the whole card. The arrow keys move
  between cards, and a screen reader says "Outside Dhaka — ৳120, radio button, 2 of 2". The circle is the input itself
  with `appearance-none`: a 1.5px `brand` ring, and when checked a `brand` fill with a 4px inset shadow in the card's
  white, which draws Figma's dot without another element. The focus ring goes around the card (`has-focus-visible:`),
  where the eye is.
- **The labels around the inputs have `cursor-pointer`** themselves: the global rule in `shop.css` covers
  `label[for]`, and these labels wrap their input instead of naming it.
- **The field's label and the group's `<legend>` are trimmed** (`trim-text`): Figma puts the input 23px under the
  label's top (11px of cap height and the 12px gap), not 32px.

### `src/islands/checkout/CheckoutLines.tsx`

```tsx
import { Add01Icon, Alert02Icon, Delete02Icon, MinusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCartQuoteLine } from '@omnivo/contracts';
import { useEffect, useRef, useState } from 'react';

import { MAX_QUANTITY, removeFromCart, setQuantity } from '../../lib/cart';
import { fill, parseQuantity } from './checkout';
import type { CheckoutWords } from './words';

// Step 26c: the cart's lines on the checkout card (CLAUDE.md → Checkout lines; Figma at y 438).
// The same parts as the cart drawer at a bigger size, written as React here because the island
// draws them; every change goes through lib/cart.ts, so the header's count and the drawer follow.

// The lines the page draws: an unavailable one has only its id, and leaves the cart
export type ShownLine = Exclude<ShopCartQuoteLine, { status: 'unavailable' }>;

interface CheckoutLinesProps {
  lines: ShownLine[];
  // The cart's own counts, which change at once; the quote's follow after the request
  quantities: ReadonlyMap<string, number>;
  // Lines whose price changed after a refused Confirm Order, with the old price
  changed: ReadonlyMap<string, string>;
  // Grey amounts while a newer cart is being priced
  pricing: boolean;
  // After the order is confirmed: the lines stay on screen behind the dialog, but cannot change
  frozen: boolean;
  words: CheckoutWords;
  money: (value: string) => string;
  count: (value: number) => string;
}

const stepButton =
  'grid size-10 shrink-0 place-items-center rounded-[5px] bg-cream transition-colors duration-150 not-aria-disabled:hover:bg-accent aria-disabled:text-muted';

export function CheckoutLines({
  lines,
  quantities,
  changed,
  pricing,
  frozen,
  words,
  money,
  count,
}: CheckoutLinesProps) {
  const list = useRef<HTMLUListElement>(null);
  // The line whose delete button should have the focus after the next drawing (see remove())
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    list.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(id)}"]`)?.focus();
  });

  // The focus goes to the next line's delete button (or the one before), so a shopper clearing
  // the cart from the keyboard keeps pressing Enter. The line is gone only after React draws the
  // new cart, so the effect above moves the focus then
  function remove(index: number, listingId: string): void {
    const neighbour = lines[index + 1] ?? lines[index - 1];
    focusNext.current = neighbour?.listingId ?? null;
    removeFromCart(new Set([listingId]));
  }

  return (
    <ul ref={list} aria-label={words.items} className="flex flex-col gap-5">
      {lines.map((line, index) => {
        const quantity = quantities.get(line.listingId) ?? line.quantity;
        const inStock = line.status === 'available';
        const name = { name: line.name };
        const was = changed.get(line.listingId);
        // Out of stock or frozen: the count cannot change; only the delete button works
        const locked = !inStock || frozen;
        return (
          <li key={line.listingId} className="flex gap-4 md:gap-5">
            {/* 155×130 from md (Figma), the drawer's 96×80 on a phone, where the stepper needs the
                width. A block, not a grid: see the drawer's note on tall photos */}
            <span className="block h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-canvas md:h-[130px] md:w-[155px]">
              <img
                src={line.image.url}
                alt=""
                className="size-full object-contain mix-blend-multiply"
              />
            </span>
            {/* Centered beside the 130px photo, as in Figma (the name 15px from its top) */}
            <div className="flex min-w-0 flex-1 flex-col gap-3 md:gap-5 md:self-center">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <a
                    href={`/p/${encodeURIComponent(line.slug)}`}
                    className="line-clamp-2 max-w-72 font-semibold hover:underline md:text-sf-subtitle"
                  >
                    {line.name}
                  </a>
                  {was !== undefined && (
                    <p className="text-sf-small font-medium text-muted">
                      {fill(words.priceChanged, { old: money(was) })}
                    </p>
                  )}
                  {!inStock && (
                    <p className="flex items-center gap-1 text-sf-small font-medium text-promo">
                      <HugeiconsIcon
                        icon={Alert02Icon}
                        size={16}
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {words.outOfStock}
                    </p>
                  )}
                </div>
                {inStock && (
                  <span
                    className={`shrink-0 font-semibold tabular-nums transition-colors duration-150 md:text-sf-subtitle ${pricing ? 'text-muted' : 'text-price'}`}
                  >
                    {money(line.lineTotal)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  {/* aria-disabled, not disabled: a disabled button loses the focus, and the
                      shopper pressing "one less" down to 1 would be thrown out of the stepper */}
                  <button
                    type="button"
                    aria-label={fill(words.decrease, name)}
                    aria-disabled={locked || quantity <= 1}
                    onClick={() => {
                      if (!locked && quantity > 1) setQuantity(line.listingId, quantity - 1);
                    }}
                    className={stepButton}
                  >
                    <HugeiconsIcon
                      icon={MinusSignIcon}
                      size={14}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </button>
                  <QuantityBox
                    quantity={quantity}
                    label={fill(words.quantity, name)}
                    disabled={locked}
                    count={count}
                    onCommit={(wanted) => {
                      setQuantity(line.listingId, wanted);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={fill(words.increase, name)}
                    aria-disabled={locked || quantity >= MAX_QUANTITY}
                    onClick={() => {
                      if (!locked && quantity < MAX_QUANTITY) {
                        setQuantity(line.listingId, quantity + 1);
                      }
                    }}
                    className={stepButton}
                  >
                    <HugeiconsIcon
                      icon={Add01Icon}
                      size={14}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <button
                  type="button"
                  data-remove={line.listingId}
                  aria-label={fill(words.remove, name)}
                  aria-disabled={frozen}
                  onClick={() => {
                    if (!frozen) remove(index, line.listingId);
                  }}
                  className="grid size-10 shrink-0 place-items-center rounded-[5px] bg-promo-soft text-promo transition-colors duration-150 not-aria-disabled:hover:bg-promo not-aria-disabled:hover:text-white"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={24}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// The typed count. It changes the cart on Enter or when the box loses the focus, not on every
// key: typing "12" never sets the line to 1 on the way. While the shopper types, the box shows
// what they typed (`draft`); otherwise the cart's number, so a click on the stepper shows here
interface QuantityBoxProps {
  quantity: number;
  label: string;
  disabled: boolean;
  count: (value: number) => string;
  onCommit: (quantity: number) => void;
}

function QuantityBox({ quantity, label, disabled, count, onCommit }: QuantityBoxProps) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit(): void {
    if (draft === null) return;
    // A typed 0 becomes 1 and 500 becomes 99 (cart.ts → withQuantity); letters put the old
    // number back
    const typed = parseQuantity(draft);
    if (typed !== undefined) onCommit(typed);
    setDraft(null);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      disabled={disabled}
      value={draft ?? count(quantity)}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        // Enter in a text box submits its form: here it only sets the count
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      }}
      className="h-10 w-15 rounded-[5px] border-[1.5px] border-cream bg-card text-center text-[20px] tabular-nums disabled:text-muted"
    />
  );
}
```

The cart's lines at the checkout's size (155×130 picture from `md`, the drawer's 96×80 on a phone, where the stepper
needs the width). Every change goes through `lib/cart.ts` (`setQuantity`, `removeFromCart`), never through React state,
so the header's count and the drawer see it too.

- **The stepper buttons use `aria-disabled`, not `disabled`**, for the drawer's reason: a disabled button loses the
  focus. The click handler checks the same condition.
- **The amounts are grey while pricing.** The quantity changes at once (it is the cart's), the line total when the
  server answers.
- **`QuantityBox` keeps a `draft`** while the shopper types and changes the cart only on Enter or when the box loses
  the focus, so typing "12" never sets the line to 1 on the way. Enter calls `preventDefault()`: in a `<form>`, Enter
  in a text box would otherwise send the whole order.
- **After a delete, the focus moves to the next line's delete button.** The line disappears only when React draws the
  new cart, so `remove()` notes which button should get the focus, and an effect with no dependency list (it runs after
  every drawing) moves it then.
- **`frozen`** is the screen after a confirmed order: everything stays, nothing changes.
- **The name and the stepper are centered beside the photo** (`md:self-center`). Figma puts the name 15px under the
  photo's top and the stepper 15px above its bottom: the 100px of text, gap and stepper, centered in 130px. A
  two-line name's line height above and below its letters is about the same, so centering the untrimmed column puts
  the letters where Figma has them.

### `src/islands/checkout/PromoBox.tsx`

```tsx
import { CheckmarkCircle02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopCouponResult } from '@omnivo/contracts';
import { useId } from 'react';

import { discountText, errorText, fill } from './checkout';
import { FieldError } from './fields';
import type { CheckoutWords } from './words';

// Step 26c: the promo box (CLAUDE.md → Checkout lines; Figma at y 743): a 60px canvas pill with
// the code box and "Apply Coupon" inside it. Not part of the react-hook-form form: a code is not
// sent with Confirm Order as typed, but as the code the last quote applied (decision 2)
interface PromoBoxProps {
  words: CheckoutWords;
  money: (value: string) => string;
  text: string;
  onTextChange: (text: string) => void;
  onApply: () => void;
  onRemove: () => void;
  // The code is being priced: the button says "Applying…" and waits
  applying: boolean;
  // What the last quote did with the applied code. null: no code, or not answered yet
  result: Exclude<ShopCouponResult, { status: 'none' }> | null;
  // The box's own check failed ("A code has only letters, digits and dashes")
  formatError: string | null;
}

export function PromoBox({
  words,
  money,
  text,
  onTextChange,
  onApply,
  onRemove,
  applying,
  result,
  formatError,
}: PromoBoxProps) {
  const id = useId();
  const statusId = `${id}-status`;
  const remove = (
    <button
      type="button"
      onClick={onRemove}
      className="font-semibold text-brand underline underline-offset-3"
    >
      {words.removeCoupon}
    </button>
  );

  return (
    <div>
      <div className="flex h-[60px] items-center gap-2 rounded-full bg-canvas p-1 pl-6 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand md:pl-9">
        {/* The placeholder ("Add Promo") is not a label: it goes away while typing */}
        <label htmlFor={id} className="sr-only">
          {words.promo}
        </label>
        <input
          id={id}
          type="text"
          value={text}
          // Codes come from a flyer: no autofill, no spelling fixes, capitals on a phone keyboard
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={words.promoPlaceholder}
          aria-describedby={statusId}
          onChange={(event) => {
            onTextChange(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Enter applies the code; without this it would submit the whole order
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onApply();
          }}
          className="h-full min-w-0 flex-1 bg-transparent font-semibold uppercase placeholder:text-muted placeholder:normal-case focus-visible:outline-none"
        />
        <button
          type="button"
          onClick={onApply}
          aria-disabled={applying}
          className="h-[52px] w-[156px] shrink-0 rounded-full bg-brand font-semibold text-accent transition-colors duration-150 not-aria-disabled:hover:bg-accent not-aria-disabled:hover:text-brand"
        >
          {applying ? words.applying : words.apply}
        </button>
      </div>
      {/* role="status": the answer comes after a request, and a screen reader says it then. The
          region is always in the page, empty or not: a live region that appears together with
          its text is often not read. Its 12px space only when it has something to say */}
      <div id={statusId} role="status" className="px-6 not-empty:pt-3 md:px-9">
        {formatError !== null ? (
          <FieldError text={formatError} />
        ) : result?.status === 'applied' ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sf-small font-medium">
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {fill(words.couponApplied, {
                code: result.code,
                off: discountText(result.discount, money),
              })}
            </span>
            {remove}
          </p>
        ) : result?.status === 'refused' ? (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sf-small">
            <FieldError
              text={errorText(words, result.reason, {
                minimum: result.minimum === null ? '' : money(result.minimum),
              })}
            />
            {remove}
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- **Not part of the react-hook-form form.** What Confirm Order sends is the code the last quote used, not the text in
  the box (decision 2). The box is plain state in the form component.
- **Enter applies the code.** Without `preventDefault()` it would submit the order.
- **The status line is a live region that is always in the page**, empty or not (`role="status"`). A region that
  appears together with its text is often not read by screen readers. `not-empty:pt-3` gives it its 12px only when it
  says something.
- **A refused code keeps its "Remove the code" button.** It is still sent (decision 26), so the shopper needs a way to
  stop sending it.

### `src/islands/checkout/CheckoutForm.tsx`

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CheckmarkSquare02Icon,
  Loading03Icon,
  ShoppingCart01Icon,
  SquareIcon,
  Alert02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  type Problem,
  type ShopCartQuote,
  type ShopPaymentMethod,
} from '@omnivo/contracts';
import type { Language } from '@omnivo/i18n';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { removeFromCart, type CartLine } from '../../lib/cart';
import { shopMoney } from '../../lib/money';
import { announceOrderConfirmed } from '../../lib/order-events';
import { placeOrder } from './api';
import {
  changedPrices,
  checkoutFormSchema,
  errorText,
  fill,
  orderRequest,
  parseCouponCode,
  refusalErrors,
  shortBy,
  type CheckoutFormInput,
  type CheckoutFormValues,
} from './checkout';
import { CheckoutLines, type ShownLine } from './CheckoutLines';
import { FieldError, RadioCards, TextField } from './fields';
import { useCart, useCheckoutQuote } from './hooks';
import { PromoBox } from './PromoBox';
import type { CheckoutChoice, CheckoutWords } from './words';

// Step 26c: /checkout's one React island (decision 1; Figma checkout_process 37:3765). Everything
// it shows comes as props from the Astro page (the words, the zones, the payment methods), so no
// translation code reaches the browser. The cart comes from this browser's storage, the prices
// from the server's quote; the island adds no money itself.
interface CheckoutFormProps {
  words: CheckoutWords;
  zones: CheckoutChoice[];
  payments: CheckoutChoice<ShopPaymentMethod>[];
  minimumOrder: string | null;
  language: Language;
  numberLocale: string;
}

// What stays on screen once the order is confirmed: the dialog opens over the checkout as it was
// (Figma confirmation_status), while the cart is already empty
interface Placed {
  quote: ShopCartQuote;
  lines: CartLine[];
}

export default function CheckoutForm({
  words,
  zones,
  payments,
  minimumOrder,
  language,
  numberLocale,
}: CheckoutFormProps) {
  const money = (value: string): string => shopMoney(value, language);
  const numbers = useMemo(() => new Intl.NumberFormat(numberLocale), [numberLocale]);
  const count = (value: number): string => numbers.format(value);

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CheckoutFormInput, unknown, CheckoutFormValues>({
    // contractErrorMap: Zod's own issues come out as our codes (`required`), so every message
    // is a code the words have a sentence for
    resolver: zodResolver(checkoutFormSchema, { error: contractErrorMap }),
    defaultValues: {
      name: '',
      phone: '',
      address: '',
      // No zone is picked for the shopper: a wrong guess would show a wrong delivery charge
      zoneId: '',
      // The first method the shop takes; the cards are the same price, so a default costs nothing
      paymentMethod: payments[0]?.id ?? 'cod',
      termsAccepted: false,
    },
  });
  const zoneId = useWatch({ control, name: 'zoneId' });
  const termsAccepted = useWatch({ control, name: 'termsAccepted' });

  const cart = useCart();
  // The promo box's text, and the code sent with every quote since Apply (decision 2)
  const [couponText, setCouponText] = useState('');
  const [couponCode, setCouponCode] = useState<string | undefined>(undefined);
  const [couponFormatError, setCouponFormatError] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // The quote the shopper saw when Confirm Order was refused with shop_order_changed
  const [refusedQuote, setRefusedQuote] = useState<ShopCartQuote | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Going to /checkout/verify: the button keeps saying "Placing the order…" until the page goes
  const [leaving, setLeaving] = useState(false);

  // No more quotes once the order is placed: the cart is empty then, and the screen stays as it was
  const { state, pricing, retry, refresh } = useCheckoutQuote(
    placed ? null : cart,
    zoneId,
    couponCode,
  );

  const quote = placed?.quote ?? (state.status === 'ready' ? state.quote : null);
  const lines = placed?.lines ?? cart;

  // A cart emptied here, in the drawer or in another tab. Not before the browser has read the
  // stored cart (null), and not after the order: its cart is emptied on purpose
  if (placed === null && lines !== null && lines.length === 0) {
    return <EmptyCheckout words={words} />;
  }

  const quantities = new Map((lines ?? []).map((line) => [line.listingId, line.quantity]));
  // The quote's lines still in the cart, in the quote's order (the cart's order)
  const shown =
    quote?.lines.filter(
      (line): line is ShownLine => line.status !== 'unavailable' && quantities.has(line.listingId),
    ) ?? [];
  const outOfStock = shown.some((line) => line.status === 'out_of_stock');
  const changed =
    refusedQuote !== null && quote !== null && !pricing
      ? changedPrices(refusedQuote, quote)
      : new Map<string, string>();

  // What the last quote did with the code in the box: only an answer for this very code counts
  const couponResult =
    quote !== null && quote.coupon.status !== 'none' && quote.coupon.code === couponCode
      ? quote.coupon
      : null;
  const applying = couponCode !== undefined && couponResult === null && state.status !== 'failed';
  const busy = isSubmitting || leaving;
  // Confirm Order waits for an answer for this exact cart, zone and code. Every reason it is
  // disabled is on screen: the terms box, the grey amounts, the out-of-stock line, the minimum
  const canOrder =
    placed === null &&
    quote !== null &&
    !pricing &&
    quote.itemCount > 0 &&
    !outOfStock &&
    !quote.belowMinimum &&
    termsAccepted &&
    !busy;

  function applyCoupon(): void {
    const parsed = parseCouponCode(couponText);
    // null: an empty box, which does nothing and says nothing
    setCouponFormatError(parsed?.ok === false);
    if (!parsed?.ok) return;
    // The box shows the code as the shop writes it ("WELCOME10")
    setCouponText(parsed.code);
    setCouponCode(parsed.code);
  }

  function removeCoupon(): void {
    setCouponText('');
    setCouponCode(undefined);
    setCouponFormatError(false);
  }

  function showRefusal(problem: Problem, seen: ShopCartQuote): void {
    const { fields, general } = refusalErrors(problem);
    fields.forEach(({ field, code }, index) => {
      // The first field with an error gets the focus, like a refusal from the form's own check
      setError(field, { type: 'server', message: code }, { shouldFocus: index === 0 });
    });
    if (problem.code === 'shop_order_changed') {
      // Price the cart again; the lines whose price moved then say what it was (decision 10)
      setRefusedQuote(seen);
      refresh();
    } else if (problem.code === 'shop_order_below_minimum' || problem.code === 'shop_cart_empty') {
      refresh();
    }
    const minimum = problem.params?.minimum;
    setSubmitError(
      general === null
        ? null
        : errorText(words, general, {
            minimum: minimum === undefined ? '' : money(String(minimum)),
          }),
    );
  }

  const submit = handleSubmit(async (values) => {
    if (lines === null || quote === null || !canOrder) return;
    const request = orderRequest(values, lines, couponCode, quote);
    if (request === null) return;
    setSubmitError(null);
    setRefusedQuote(null);

    const result = await placeOrder(request);
    if (result.kind === 'failed') {
      setSubmitError(words.orderFailed);
      return;
    }
    if (result.kind === 'refused') {
      showRefusal(result.problem, quote);
      return;
    }
    const { answer } = result;
    if (answer.next === 'verify') {
      // Cash on Delivery: the order waits for its code. The cart stays until the code is right,
      // so a shopper who gives up on the code still has it
      setLeaving(true);
      window.location.assign('/checkout/verify');
      return;
    }
    // Confirmed at once (Mobile Banking in the mock): the screen stays as it is, the ordered
    // lines leave the cart, and the "Order Confirmed" dialog (26c.5) hears the event
    setPlaced({ quote, lines });
    removeFromCart(new Set(lines.map((line) => line.listingId)));
    announceOrderConfirmed({ orderNo: answer.orderNo, phone: answer.phone });
  });

  const errorOf = (code: string | undefined): string | undefined =>
    code === undefined ? undefined : errorText(words, code);

  return (
    // Figma: 848px wide, 36px under the header (16px on a phone), a 4px glass frame. Every gap
    // below is Figma's, measured between trimmed text boxes (trim-text, as on the product page):
    // the header is 65px tall, not the 78px a 30px line would make. Figma has 160px from the card
    // to the footer: the footer's own 80px top margin collapses into this 160px, it does not add
    <div className="mx-auto mt-4 max-w-[848px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
      <div className="rounded-t-xl bg-cream p-6 text-center">
        <h1 className="trim-text text-sf-title font-semibold">{words.heading}</h1>
      </div>
      {/* noValidate: the browser's own bubbles would show English on a Bangla shop */}
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        // Figma: the body starts 36px under the header and ends 36px above the card's edge, both
        // counted from the card, so 32px inside the 4px frame at the sides and the bottom
        className="flex flex-col gap-8 p-5 md:px-8 md:pt-9 md:pb-8"
      >
        <div className="grid gap-8 md:grid-cols-2 md:gap-4">
          <TextField
            label={words.name}
            autoComplete="name"
            error={errorOf(errors.name?.message)}
            {...register('name')}
          />
          {/* type="tel": the phone keyboard. The schema takes "+880 1786-120356" or Bangla
              digits as they are, so the box asks for no format */}
          <TextField
            label={words.phone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            error={errorOf(errors.phone?.message)}
            {...register('phone')}
          />
        </div>
        <TextField
          label={words.address}
          autoComplete="street-address"
          error={errorOf(errors.address?.message)}
          {...register('address')}
        />

        <RadioCards
          legend={words.zone}
          choices={zones}
          field={register('zoneId')}
          error={errorOf(errors.zoneId?.message)}
          hint={
            words.freeDeliveryFrom !== null && (
              <p className="trim-text mt-3 text-sf-small text-muted">{words.freeDeliveryFrom}</p>
            )
          }
        />

        {quote === null || lines === null ? (
          state.status === 'failed' ? (
            <QuoteFailed words={words} onRetry={retry} />
          ) : (
            <QuoteLoading words={words} />
          )
        ) : (
          // Figma: 36px from the location cards to the lines, 4px more than the form's gap
          <div className="mt-1">
            <CheckoutLines
              lines={shown}
              quantities={quantities}
              changed={changed}
              pricing={pricing}
              frozen={placed !== null}
              words={words}
              money={money}
              count={count}
            />
            <Totals
              quote={quote}
              couponCode={couponResult?.status === 'applied' ? couponResult.code : null}
              pricing={pricing}
              minimumOrder={minimumOrder}
              words={words}
              money={money}
            />
          </div>
        )}
        {/* "2 items are no longer sold…": nothing on screen says it, so a screen reader hears it */}
        <p role="status" className="sr-only">
          {state.status === 'ready' && state.removed > 0
            ? fill(
                new Intl.PluralRules(numberLocale).select(state.removed) === 'one'
                  ? words.removedOne
                  : words.removedOther,
                { count: count(state.removed) },
              )
            : ''}
        </p>

        <PromoBox
          words={words}
          money={money}
          text={couponText}
          onTextChange={(text) => {
            setCouponText(text);
            setCouponFormatError(false);
          }}
          onApply={applyCoupon}
          onRemove={removeCoupon}
          applying={applying}
          result={couponResult}
          formatError={couponFormatError ? errorText(words, 'shop_coupon_format') : null}
        />

        {/* Figma: 48px around the payment cards, 16px more than the form's gap */}
        <div className="mt-4">
          <RadioCards
            legend={words.payment}
            choices={payments}
            field={register('paymentMethod')}
            error={errorOf(errors.paymentMethod?.message)}
          />
        </div>

        <div className="mt-4 flex flex-col gap-6">
          <label className="flex cursor-pointer items-center gap-3 text-[18px] text-body">
            {/* The real checkbox stays for the keyboard and screen readers; the 20px icon is
                what shows (CLAUDE.md: CheckmarkSquare02 when ticked) */}
            <input type="checkbox" className="peer sr-only" {...register('termsAccepted')} />
            <span className="grid size-5 shrink-0 place-items-center rounded-sm text-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand">
              <HugeiconsIcon
                icon={termsAccepted ? CheckmarkSquare02Icon : SquareIcon}
                size={20}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </span>
            {/* Trimmed, so the row is the icon's 20px, as in Figma */}
            <span className="trim-text">
              {words.termsBefore}
              {/* A new tab: following the link must not lose what the shopper typed here */}
              <a
                href="/pages/terms"
                target="_blank"
                rel="noopener"
                className="underline underline-offset-3"
              >
                {words.termsLink}
              </a>
              {words.termsAfter}
            </span>
          </label>

          <div>
            {/* role="alert": the shopper pressed the button and waits for this answer. Always in
                the page, like the promo box's status, and 12px above the button only when it
                says something */}
            <div role="alert" className="not-empty:pb-3">
              {submitError !== null && <FieldError text={submitError} />}
            </div>
            <button
              type="submit"
              disabled={!canOrder}
              className="h-16 w-full rounded-sm bg-accent text-[18px] font-semibold transition-colors duration-150 not-disabled:hover:bg-brand not-disabled:hover:text-accent disabled:bg-canvas disabled:text-muted"
            >
              {busy ? words.placing : words.confirm}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// The rows under the lines (Figma y 598–695): Discount (only with an applied code, decision 15),
// Delivery Charge between two rules, then Total. Figma has 24px between a rule and the trimmed text
// next to it, so the rows inside the rules are 24px apart too. The trim goes on the spans:
// text-box does not apply to a flex container, only to the block boxes inside it.
// The amounts are the quote's, grey while a newer cart is being priced
interface TotalsProps {
  quote: ShopCartQuote;
  couponCode: string | null;
  pricing: boolean;
  minimumOrder: string | null;
  words: CheckoutWords;
  money: (value: string) => string;
}

function Totals({ quote, couponCode, pricing, minimumOrder, words, money }: TotalsProps) {
  const amount = `tabular-nums transition-colors duration-150 ${pricing ? 'text-muted' : ''}`;
  const delivery =
    quote.deliveryCharge === null
      ? words.pickZone
      : quote.freeDelivery
        ? words.free
        : money(quote.deliveryCharge);
  return (
    // Figma: the first rule 30px under the lines, and 48px from Total to the promo box (the form's
    // 32px gap plus this 16px)
    <div className="mt-[30px] pb-4">
      <div className="flex flex-col gap-6 border-y border-rule py-6 font-semibold">
        {couponCode !== null && (
          <p className="flex items-center justify-between gap-4">
            <span className="trim-text">{fill(words.discount, { code: couponCode })}</span>
            {/* U+2212, the minus sign, not a hyphen: it is a sum, and it lines up with digits */}
            <span className={`trim-text ${amount}`}>−{money(quote.discount)}</span>
          </p>
        )}
        <p className="flex items-center justify-between gap-4">
          <span className="trim-text">{words.deliveryCharge}</span>
          <span className={`trim-text ${quote.deliveryCharge === null ? 'text-muted' : amount}`}>
            {delivery}
          </span>
        </p>
      </div>
      <p className="flex items-center justify-between gap-4 pt-6 text-sf-subtitle leading-5 font-bold">
        <span className="trim-text">{words.total}</span>
        <span className={`trim-text ${amount} ${pricing ? '' : 'text-price'}`}>
          {money(quote.total)}
        </span>
      </p>
      {/* Under the minimum: Confirm Order is disabled, and this says how much more to add */}
      {quote.belowMinimum && minimumOrder !== null && (
        <div className="mt-3">
          <FieldError
            text={fill(words.belowMinimum, {
              minimum: money(minimumOrder),
              more: money(shortBy(minimumOrder, quote.subtotal)),
            })}
          />
        </div>
      )}
    </div>
  );
}

function QuoteLoading({ words }: { words: CheckoutWords }) {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2.5 py-10 font-medium text-muted"
    >
      <HugeiconsIcon
        icon={Loading03Icon}
        size={24}
        strokeWidth={1.5}
        className="animate-spin"
        aria-hidden="true"
      />
      {words.loading}
    </p>
  );
}

// The drawer's failed state at the lines' place: without prices nothing can be ordered
function QuoteFailed({ words, onRetry }: { words: CheckoutWords; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-6 py-6 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-promo-soft text-promo">
        <HugeiconsIcon icon={Alert02Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <p className="max-w-80">{words.failed}</p>
      <button
        type="button"
        onClick={onRetry}
        className="h-11 rounded-sm bg-cream px-6 font-semibold transition-colors duration-150 hover:bg-accent"
      >
        {words.retry}
      </button>
    </div>
  );
}

// CLAUDE.md → Storefront → Empty state, at the checkout card's width
function EmptyCheckout({ words }: { words: CheckoutWords }) {
  return (
    <div className="mx-auto mt-4 flex max-w-[848px] flex-col items-center gap-4 rounded-2xl bg-card p-12 text-center md:mt-9">
      <span className="grid size-16 place-items-center rounded-full bg-cream">
        <HugeiconsIcon icon={ShoppingCart01Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <h1 className="text-sf-title font-semibold">{words.emptyTitle}</h1>
      <p className="max-w-80 text-muted">{words.emptyText}</p>
      <a
        href="/"
        className="mt-2 flex h-11 items-center rounded-sm bg-accent px-6 font-semibold transition-colors duration-150 hover:bg-brand hover:text-accent"
      >
        {words.continueShopping}
      </a>
    </div>
  );
}
```

The island itself. It is the default export, which is what Astro's React integration hydrates.

- **`useForm<CheckoutFormInput, unknown, CheckoutFormValues>`** names both types, so the handler gets the plain phone.
  `zodResolver(..., { error: contractErrorMap })` makes Zod's own issues come out as our codes (`required`), the same
  as the ERP's forms.
- **`useWatch` for the zone and the terms box**, not `watch()`: the quote hook and the button need them, and
  `useWatch` draws this component again only when they change.
- **Every hook runs before the empty-cart `return`.** Hooks must run in the same order on every drawing; a hook after
  an early `return` would be skipped on some.
- **The empty state shows only when the cart is known and empty and no order was placed** (decision 23: a confirmed
  order empties the cart on purpose).
- **`canOrder`** lists every reason Confirm Order waits (decision 27). On the server the quote is `null`, so the button
  is drawn disabled: before the island takes over, a click would post the form the browser's own way.
- **`applying`** is true while the code in use has no answer for it yet; the button says "Applying…".
- **`showRefusal()`** puts each field error under its field (the first gets the focus), asks for prices again after
  `shop_order_changed` (remembering the quote the shopper saw, for "Was ৳229"), and after `shop_order_below_minimum` or
  `shop_cart_empty`, then shows the general sentence with the amount the problem names.
- **After `next: 'verify'`** the page goes to `/checkout/verify` with `location.assign`, and `leaving` keeps the button
  saying "Placing the order…" until the new page comes. The cart stays (decision 23).
- **After `next: 'confirmed'`** the screen is kept in `placed`, the ordered lines leave the cart (only those: a line
  added in another tab meanwhile stays), and the event goes out. Passing `null` as the cart to the quote hook stops
  further quotes.
- **`noValidate`** on the form: the browser's own bubbles would speak English on a Bangla shop, and they do not know
  the shop's rules.
- **The terms checkbox** is a real `<input>` kept for the keyboard and screen readers (`sr-only`), and the 20px icon
  shows its state: `CheckmarkSquare02` or `Square`. `peer-focus-visible:` puts the focus ring on the icon.
- **The submit alert is always in the page** for the same reason as the promo box's status.
- **The gaps are Figma's, measured between trimmed text boxes.** Figma trims every text box to the cap height and the
  baseline, and its numbers are measured between those edges. The heading, the labels, the rows and the terms line use
  the shop's `trim-text` utility (26a), as the product page does. Without it, each 20px line adds about 9px of empty
  space, and the page ended 70px lower than Figma's. The trim goes on the `<span>`s of a flex row, not on the row:
  `text-box` applies to block boxes, not to a flex container.
- **The body's padding is 36px at the top and 32px at the sides and the bottom** (`md:px-8 md:pt-9 md:pb-8`). Figma
  measures it from the card's edge, and the card has its 4px glass frame (`p-1`): 32 + 4 is Figma's 36. With 36px all
  round, the fields were 8px narrower than Figma's 776px.
- **The blocks are not all 32px apart.** The form's `gap-8` is the common gap; Figma has 36px before the lines
  (`mt-1`), 30px from the lines to the first rule (`mt-[30px]`), and 48px around the promo box and the payment cards
  (`pb-4`, `mt-4`).
- **`md:mb-40`** gives Figma's 160px from the card to the footer. The footer has its own 80px top margin; two vertical
  margins that touch collapse into the larger one, so 160 and 80 make 160, not 240.
- **`Totals`** has the Discount row only with an applied code (decision 15), "Pick a location" in `muted` before a zone,
  "Free" for free delivery. The minus is U+2212, not a hyphen: it lines up with the digits. Inside the two rules the
  rows are a flex column with `gap-6` and `py-6`: 24px between a rule and the text next to it, as Figma, and 24px
  between Discount and Delivery Charge.

### `src/pages/checkout.astro`

```
---
import { numberLocale } from '@omnivo/i18n';

import OrderConfirmedDialog from '../components/OrderConfirmedDialog.astro';
import { shopSource } from '../data/source';
import CheckoutForm from '../islands/checkout/CheckoutForm';
import { checkoutChoices, checkoutWords } from '../islands/checkout/words';
import ShopLayout from '../layouts/ShopLayout.astro';
import { shopLocale } from '../lib/locale';

// Step 26c: the checkout (Figma checkout_process 37:3765, 1440px). The page draws the frame and
// the words; the form is a React island (decision 1). The cart is in the shopper's browser, so the
// server cannot know it: the island is drawn here with "Getting today's prices…" and takes over
// in the browser (client:load: a checkout is useless until it can price the cart).
const [shop, settings] = await Promise.all([shopSource.shop(), shopSource.checkoutSettings()]);
const locale = await shopLocale(shop.language);
const { t } = locale;
const choices = checkoutChoices(locale, settings);

// The page answers per shopper (their cookie may hold an order), so no cache may keep it
Astro.response.headers.set('Cache-Control', 'no-store');
---

<ShopLayout shop={shop} locale={locale} title={t('shop.checkout.pageTitle', { shop: shop.name })}>
  {/* Only what is serializable goes to an island: Astro writes these props into the HTML as
      JSON for the browser. Words, labels, amounts as strings; never a function like t() */}
  <CheckoutForm
    client:load
    words={checkoutWords(locale, settings)}
    zones={choices.zones}
    payments={choices.payments}
    minimumOrder={settings.minimumOrder}
    language={locale.language}
    numberLocale={numberLocale(locale.language)}
  />
  {/* Step 26c.5: opens when the island announces a confirmed order (Mobile Banking) */}
  <OrderConfirmedDialog locale={locale} />
</ShopLayout>
```

- **`client:load`**: a checkout is useless until it can price the cart, so the island starts as soon as the page loads.
- **The props are all plain data.** Astro writes them into the HTML as JSON for the browser, so a function such as
  `t()` cannot be passed; that is why the words are made here.
- **`Cache-Control: no-store`**: the page answers one shopper, and a proxy must not keep it.
- **`<OrderConfirmedDialog>`** is 26c.5's component. Leave its import and its line out until you write 26c.5, or the
  page does not compile; with them, the dialog opens over the checkout when the island announces a Mobile Banking
  order.

### `src/boundaries.spec.ts`

```diff
@@ -3,7 +3,8 @@ import { describe, expect, it } from 'vitest';
 // Step 26a: the shop's import rules. They live here and not in .dependency-cruiser.cjs, because
 // dependency-cruiser cannot read .astro files, and the pages are .astro files: a rule there would
 // pass while a page broke it. Vite's import.meta.glob reads every source file as text.
-const files = import.meta.glob<string>(['./**/*.{ts,astro}', '!./**/*.spec.ts'], {
+// Step 26c: .tsx too, for the checkout's React island
+const files = import.meta.glob<string>(['./**/*.{ts,tsx,astro}', '!./**/*.spec.ts'], {
   query: '?raw',
   import: 'default',
   eager: true,
@@ -49,12 +50,21 @@ describe('shop imports', () => {
     expect(offenders).toEqual([]);
   });
 
-  it('reaches src/server only from the API routes', () => {
+  it('reaches src/server only from the API routes, and the cookies from the pages', () => {
     // Step 26b: server/ is request handling (Response objects, the contracts, Zod). A component
-    // that imported it could pull it into a <script> and ship Zod to every shopper's browser
+    // that imported it could pull it into a <script> and ship Zod to every shopper's browser.
+    // Step 26c: a page's frontmatter runs only on the server, and /checkout/verify and
+    // /order/<no> read the order cookies. They may import server/cookies.ts, which imports
+    // nothing, and only that
     const offenders = Object.entries(files)
       .filter(([path]) => !path.startsWith('./pages/api/') && !path.startsWith('./server/'))
-      .filter(([, source]) => importsOf(source).some((name) => /(^|\/)server\//.test(name)))
+      .filter(([path, source]) =>
+        importsOf(source).some(
+          (name) =>
+            /(^|\/)server\//.test(name) &&
+            !(path.startsWith('./pages/') && name.endsWith('/server/cookies')),
+        ),
+      )
       .map(([path]) => path);
     expect(offenders).toEqual([]);
   });
@@ -95,4 +105,46 @@ describe('shop imports', () => {
       .map(({ path }) => path);
     expect(offenders).toEqual([]);
   });
+
+  // Step 26c (decision 1): React, Zod and the form library reach the browser only in an island,
+  // and only /checkout loads one. The rest of the shop stays plain HTML with small scripts
+  const browserHeavy = /^(react|react-dom|zod|react-hook-form|@hookform\/resolvers(\/.*)?)$/;
+
+  it('imports React, Zod and react-hook-form only in src/islands', () => {
+    // '@hugeicons/react' is not on the list: an Astro component draws its icons on the server,
+    // and nothing of it reaches the browser
+    const offenders = Object.entries(files)
+      .filter(([path]) => !path.startsWith('./islands/'))
+      .filter(([, source]) =>
+        importsOf(source, VALUE_IMPORT).some((name) => browserHeavy.test(name)),
+      )
+      .map(([path]) => path);
+    expect(offenders).toEqual([]);
+  });
+
+  it('keeps the translations out of the islands', () => {
+    // The page translates the words and passes them as props. `import type` is free; a value
+    // import of '@omnivo/i18n' (or lib/locale.ts, which starts it) would put i18next and every
+    // English word into the checkout's chunk
+    const islands = Object.entries(files).filter(([path]) => path.startsWith('./islands/'));
+    expect(islands.length).toBeGreaterThan(0);
+    const offenders = islands
+      .filter(([, source]) =>
+        importsOf(source, VALUE_IMPORT).some(
+          (name) => name === '@omnivo/i18n' || name.endsWith('/lib/locale'),
+        ),
+      )
+      .map(([path]) => path);
+    expect(offenders).toEqual([]);
+  });
+
+  it('hydrates islands only on the checkout pages', () => {
+    // client:load and the other client:* directives are what send an island's JavaScript to the
+    // browser. A product card with one would load React on every page of the shop
+    const offenders = Object.entries(files)
+      .filter(([path]) => path.endsWith('.astro') && !path.startsWith('./pages/checkout'))
+      .filter(([, source]) => /\sclient:(load|idle|visible|media|only)\b/.test(source))
+      .map(([path]) => path);
+    expect(offenders).toEqual([]);
+  });
 });
```

The glob reads `.tsx` too, and three rules are added (decision 1):

- **React, Zod and react-hook-form only in `src/islands/`.** A component or a lib that imported them could pull them
  into a script on every page. `@hugeicons/react` is not on the list: Astro components draw their icons on the server.
- **No translations in an island.** A value import of `@omnivo/i18n` or of `lib/locale.ts` would put i18next and every
  English word into the checkout's chunk. `import type` is allowed: it leaves nothing behind.
- **Only the checkout pages hydrate an island.** A `client:*` directive anywhere else would send React to that page.

The diff also has 26c.5's change to the `src/server` rule (the pages may import `server/cookies.ts`); it is explained
there. It changes nothing for this part.

### `src/islands/checkout/checkout.spec.ts`

```ts
import { contractErrorMap, type ShopCartQuote, type ShopCartQuoteLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  changedPrices,
  checkoutFormSchema,
  discountText,
  errorText,
  fill,
  orderRequest,
  parseCouponCode,
  parseQuantity,
  quoteKey,
  quoteRequest,
  refusalErrors,
  shortBy,
  type CheckoutFormValues,
} from './checkout';
import { shopLocale } from '../../lib/locale';
import { checkoutWords } from './words';

// Step 26c: the checkout island's plain logic. The island itself is checked in the browser
// (26c.4's "Check this part"); what it decides with is checked here.

const image = { url: '/images/neem.webp', alt: 'Neem face wash' };

function available(listingId: string, unitPrice: string, quantity = 1): ShopCartQuoteLine {
  return {
    status: 'available',
    listingId,
    slug: listingId,
    name: listingId,
    packSize: '150ml',
    image,
    quantity,
    unitPrice,
    lineTotal: unitPrice,
  };
}

function quote(lines: ShopCartQuoteLine[], total = '500.0000'): ShopCartQuote {
  return {
    lines,
    itemCount: lines.length,
    subtotal: total,
    discount: '0.0000',
    coupon: { status: 'none' },
    deliveryCharge: '80.0000',
    freeDelivery: false,
    total,
    belowMinimum: false,
  };
}

// The real English words, made the way the page makes them: errorText is tested with the
// sentences the shopper reads, and a word that lost its placeholder fails here
const words = checkoutWords(await shopLocale('en'), {
  zones: [{ id: 'inside_dhaka', name: 'Inside Dhaka', charge: '80' }],
  paymentMethods: ['cod'],
  freeDeliveryFrom: null,
  minimumOrder: null,
});

const values: CheckoutFormValues = {
  name: 'Nusrat Jahan',
  phone: '01786120356',
  address: 'House 12, Road 5, Mirpur 10, Dhaka',
  zoneId: 'inside_dhaka',
  paymentMethod: 'cod',
  termsAccepted: true,
};

describe('checkoutFormSchema', () => {
  const parse = (input: Record<string, unknown>) =>
    checkoutFormSchema.safeParse({ ...values, ...input }, { error: contractErrorMap });

  it('says "pick a location" for an empty zone, not "too short"', () => {
    const result = parse({ zoneId: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('shop_zone_unknown');
  });

  it('makes the phone plain, as the server will', () => {
    expect(parse({ phone: '+880 1786-120356' }).data?.phone).toBe('01786120356');
    expect(parse({ phone: '০১৭৮৬১২০৩৫৬' }).data?.phone).toBe('01786120356');
    expect(parse({ phone: '029876543' }).error?.issues[0]?.message).toBe('shop_phone_format');
  });

  it('refuses a name of spaces with the code the words have', () => {
    expect(parse({ name: '   ' }).error?.issues[0]?.message).toBe('required');
  });
});

describe('fill and errorText', () => {
  it('puts the values into their placeholders and leaves unknown ones', () => {
    expect(fill('One less {{name}} {{other}}', { name: 'Neem' })).toBe('One less Neem {{other}}');
  });

  it('falls back to "Enter a valid value" for a code without words', () => {
    expect(errorText(words, 'some_new_code')).toBe('Enter a valid value.');
    expect(errorText(words, 'shop_zone_unknown')).toBe('Pick a delivery location.');
    // hasOwn, not `in`: an object's own methods are not words
    expect(errorText(words, 'toString')).toBe('Enter a valid value.');
    expect(errorText(words, 'shop_coupon_minimum', { minimum: '৳500' })).toBe(
      'This code needs items worth ৳500 or more.',
    );
  });
});

describe('parseCouponCode', () => {
  it('reads a code the way the server does', () => {
    expect(parseCouponCode('   ')).toBeNull();
    expect(parseCouponCode(' welcome10 ')).toEqual({ ok: true, code: 'WELCOME10' });
    expect(parseCouponCode('WELCOME 10')).toEqual({ ok: false, error: 'shop_coupon_format' });
  });

  it('writes a discount like the ribbon', () => {
    const money = (value: string) => `৳${value}`;
    expect(discountText({ kind: 'percent', value: 10 }, money)).toBe('10%');
    expect(discountText({ kind: 'amount', value: '50' }, money)).toBe('৳50');
  });
});

describe('quoteRequest and quoteKey', () => {
  const lines = [{ listingId: 'neem', quantity: 2 }];

  it('leaves out an empty zone and no code, which the route would refuse', () => {
    expect(quoteRequest(lines, '', undefined)).toEqual({ lines });
    expect(quoteRequest(lines, 'inside_dhaka', 'WELCOME10')).toEqual({
      lines,
      zoneId: 'inside_dhaka',
      couponCode: 'WELCOME10',
    });
  });

  it('gives each cart, zone and code its own key', () => {
    const plain = quoteKey(quoteRequest(lines, '', undefined));
    expect(quoteKey(quoteRequest(lines, 'inside_dhaka', undefined))).not.toBe(plain);
    expect(quoteKey(quoteRequest(lines, '', 'WELCOME10'))).not.toBe(plain);
    expect(quoteKey(quoteRequest([{ listingId: 'neem', quantity: 3 }], '', undefined))).not.toBe(
      plain,
    );
    expect(quoteKey(quoteRequest([...lines], '', undefined))).toBe(plain);
  });
});

describe('changedPrices', () => {
  it('names the lines whose price moved, with the old price', () => {
    const before = quote([available('neem', '229.0000'), available('tea', '120.0000')]);
    const after = quote([available('neem', '249.0000'), available('tea', '120.0000')]);
    expect(changedPrices(before, after)).toEqual(new Map([['neem', '229.0000']]));
  });

  it('leaves out a line that went out of stock or had no price before', () => {
    const outOfStock: ShopCartQuoteLine = {
      status: 'out_of_stock',
      listingId: 'tea',
      slug: 'tea',
      name: 'tea',
      packSize: '100g',
      image,
      quantity: 1,
    };
    const before = quote([available('neem', '229.0000'), outOfStock]);
    const after = quote([
      { ...outOfStock, listingId: 'neem', slug: 'neem' },
      available('tea', '99.0000'),
    ]);
    expect(changedPrices(before, after).size).toBe(0);
  });
});

describe('orderRequest', () => {
  const lines = [{ listingId: 'neem', quantity: 2 }];
  const seen = quote([available('neem', '229.0000', 2)], '538.0000');

  it('sends the total on screen and the code the quote used', () => {
    expect(orderRequest(values, lines, 'WELCOME10', seen)).toMatchObject({
      lines,
      zoneId: 'inside_dhaka',
      couponCode: 'WELCOME10',
      termsAccepted: true,
      expectedTotal: '538.0000',
    });
    expect(orderRequest(values, lines, undefined, seen)).not.toHaveProperty('couponCode');
  });

  it('builds nothing while the terms are not ticked', () => {
    expect(orderRequest({ ...values, termsAccepted: false }, lines, undefined, seen)).toBeNull();
  });

  it('says by how much the items are under the minimum', () => {
    expect(shortBy('300', '240.0000')).toBe('60.0000');
  });
});

describe('refusalErrors', () => {
  const problem = { title: 'x', status: 400, detail: 'x' };

  it('puts a field error under its field', () => {
    expect(
      refusalErrors({
        ...problem,
        code: 'invalid_input',
        fieldErrors: { phone: ['shop_phone_format'] },
      }),
    ).toEqual({ fields: [{ field: 'phone', code: 'shop_phone_format' }], general: null });
  });

  it('says a broken cart line once, above the button', () => {
    expect(
      refusalErrors({
        ...problem,
        code: 'invalid_input',
        fieldErrors: { 'lines.0.quantity': ['too_large'] },
      }),
    ).toEqual({ fields: [], general: 'invalid_input' });
  });

  it('points the zone and payment refusals at their groups, the rest above the button', () => {
    expect(refusalErrors({ ...problem, status: 422, code: 'shop_zone_unknown' }).fields).toEqual([
      { field: 'zoneId', code: 'shop_zone_unknown' },
    ]);
    expect(refusalErrors({ ...problem, status: 422, code: 'shop_payment_unavailable' })).toEqual({
      fields: [{ field: 'paymentMethod', code: 'shop_payment_unavailable' }],
      general: null,
    });
    expect(refusalErrors({ ...problem, status: 409, code: 'shop_order_changed' })).toEqual({
      fields: [],
      general: 'shop_order_changed',
    });
  });
});

describe('parseQuantity', () => {
  it('takes ASCII and Bangla digits, nothing else', () => {
    expect(parseQuantity(' 12 ')).toBe(12);
    expect(parseQuantity('১২')).toBe(12);
    expect(parseQuantity('1.5')).toBeUndefined();
    expect(parseQuantity('two')).toBeUndefined();
  });
});
```

The plain logic, tested with the real English words: the spec makes them with `shopLocale('en')` and
`checkoutWords()`, as the page does. That also tests `words.ts`: a word that lost its placeholder fails here.

### Check this part

```bash
pnpm install
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop/src packages/i18n/src
pnpm boundaries
pnpm --filter @omnivo/shop build
```

The shop has 102 tests. The build gives `/checkout` two chunks the other pages never load: the island
(`CheckoutForm-*.js`, 48.6 KB gzipped: the form, Zod, react-hook-form and the contracts it uses) and React DOM
(`client-*.js`, 65.9 KB). The home and product pages still load only the small scripts of 26b; check it with
`curl -s http://127.0.0.1:4399/ | grep -o '_astro/[^"]*\.js'`.

Then try it in a browser on the built server (`HOST=127.0.0.1 PORT=4399 node apps/shop/dist/server/entry.mjs`):

1. Open `/checkout` with an empty cart: "Your cart is empty".
2. Add the neem face wash on its page, open `/checkout`: the line, "Pick a location", Total ৳458.
3. Press Confirm Order with empty fields (after ticking the terms): three errors, the focus in Full Name.
4. Type `flat50` in the promo box and press Enter: "This code needs items worth ৳500 or more." Press "One more": the
   header's count says 3, and the code starts to work: "FLAT50 applied: ৳50 off", a Discount row, Total ৳757 with
   Outside Dhaka.
5. Fill the form (the phone in Bangla digits works), pick Cash on Delivery, confirm: the browser goes to
   `/checkout/verify` (404 until 26c.5; with 26c.5 written, the verify page), and the cart is still there.
6. Back on `/checkout`, pick Mobile Banking and confirm: the screen stays, the header's count goes, and
   `document.addEventListener('shop:order-confirmed', …)` in the console gets `{ orderNo: 'W-000002', … }`.
7. At 390px wide: one column, nothing scrolls sideways; a cart with the out-of-stock milk keeps Confirm Order disabled
   and says "Out of stock: remove it to order".

Broken on purpose while writing this part, and caught: a `client:load` on the home page, a value import of
`@omnivo/i18n` in the island, `react` imported by `lib/money.ts` (two rules fail), `changedPrices()` marking every
line, and the zone's own message removed from the form schema.

## 26c.5 — `apps/shop`: the phone code, "Order Confirmed" and the order page

This part draws the last three screens of the checkout: `/checkout/verify` (the phone code for Cash on Delivery,
`CLAUDE.md` → Phone verification), the "Order Confirmed" dialog (Figma `confirmation_status` 41:4066) and
`/order/<no>` (`CLAUDE.md` → Order details). None of them uses React: they are Astro pages and components with small
scripts, like 26b's cart drawer (decision 29).

Some of this part's code is in files shown in earlier parts, because each file is shown once, as it ends up:

- `src/data/types.ts` and `src/data/mock/orders.ts` (26c.3): `ShopCodeWait.listingIds` and `codeWait`'s answer;
  `orders.spec.ts` checks them.
- `src/lib/order-events.ts` (26c.4): the `declare global` block that types the event on `document`.
- `src/pages/checkout.astro` (26c.4): the `<OrderConfirmedDialog>` line and its import.
- `src/boundaries.spec.ts` (26c.4): the pages may import `server/cookies.ts` (below).
- `package.json` (26c.4): `@fontsource-variable/geist-mono`.
- `en.ts` / `bn.ts` (26c.2): five words.

### `src/lib/verify.ts`

```ts
import type { ShopOrderConfirmed } from '@omnivo/contracts';

// Step 26c: the pure parts of /checkout/verify's script, here so they can be tested without a
// browser. Like quote.ts, nothing here may import Zod, the contracts' values or i18next: the
// script ships to the shopper (src/boundaries.spec.ts checks it).

// A Bangla keyboard types ০–৯; a code pasted from an SMS may hold spaces ("123 456"). The box keeps
// the ASCII digits only, at most `length` of them, so what the shopper sees is what is sent
export function codeDigits(text: string, length: number): string {
  return text
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/\D/g, '')
    .slice(0, length);
}

// "Resend code in 0:45". Minutes without a leading zero, seconds with one, in the shop's digits
// ('bn-BD' writes ০:৪৫). Never below 0:00: a timer that fires late shows zero, not "-0:01"
export function waitText(seconds: number, numberLocale: string): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = new Intl.NumberFormat(numberLocale, { useGrouping: false });
  const two = new Intl.NumberFormat(numberLocale, { minimumIntegerDigits: 2, useGrouping: false });
  return `${minutes.format(Math.floor(total / 60))}:${two.format(total % 60)}`;
}

// "{{count}} tries left." with its value. Every {{name}} is replaced, not only the first
export function fillWords(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The two parts of a problem answer (server/problem.ts) the page acts on. Anything else (a proxy's
// HTML error page, a body cut short) is null, and the page shows its "not sent" line
export interface ProblemParts {
  code: string;
  params: Record<string, unknown>;
}

export function problemParts(body: unknown): ProblemParts | null {
  if (!isRecord(body) || typeof body.code !== 'string') return null;
  return { code: body.code, params: isRecord(body.params) ? body.params : {} };
}

// A right code's answer. Hand-written for the same reason as quote.ts's guard: the order number
// goes into a link, so it must be a string, and the phone into the dialog's sentence
export function isOrderConfirmed(body: unknown): body is ShopOrderConfirmed {
  return (
    isRecord(body) &&
    typeof body.orderNo === 'string' &&
    body.orderNo !== '' &&
    typeof body.phone === 'string' &&
    body.phone !== ''
  );
}

// "Resend code" answers with the seconds until the next one; a 429 says the same in its params
export function resendSeconds(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const value = isRecord(body.params) ? body.params.seconds : body.resendInSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
```

The parts of the verify page's script that need no browser, so they can be tested. The script ships to every shopper
who orders with Cash on Delivery, so this file follows 26b's rule for browser code: no Zod, no contract values, no
i18next (`boundaries.spec.ts` checks it).

- **`codeDigits`** first turns Bangla digits into ASCII (`০` is U+09E6, so `charCodeAt(0) - 0x09e6` is the digit), then
  drops everything that is not a digit, then keeps `length` digits. The order matters: dropping non-digits first
  would drop the Bangla ones too, since `\D` in JavaScript means "not 0–9", whatever the script. A code
  pasted as "123 456" or "Your code: 123456" becomes the six digits.
- **`length` is a parameter**, not `SHOP_CODE_LENGTH` imported from the contracts: importing a value from
  `@omnivo/contracts` would bring Zod into the script. The page reads the constant on the server and passes it in.
- **`waitText`** writes "0:45". `Math.ceil` so the button never says "0:00" while it is still disabled for most of a
  second, and `Math.max(0, …)` so a timer that fires late shows zero, not "-1:59". The two formatters use the shop's
  number locale, so a Bangla shop counts "০:৪৫". `useGrouping: false` keeps a long wait from ever becoming "1,000".
- **`fillWords`** replaces every `{{name}}` with a global regex. `String.replace` with a string pattern replaces only
  the first one; a word that uses a value twice would show the second as `{{count}}`. An unknown name is left as it
  is, so a missing value is visible, not silently empty.
- **`problemParts`** reads only `code` and `params` from an error answer. Anything that is not our problem JSON (a
  proxy's HTML page, a body cut short) gives `null`, and the page shows its "not sent" line.
- **`isOrderConfirmed`** checks the right code's answer by hand, for the same reason as 26b's `isCartQuote`: the order
  number goes into a link and the phone into a sentence, so both must be non-empty strings.
- **`resendSeconds`** reads the wait from either answer: `resendInSeconds` on a 200, `params.seconds` on a 429. Both
  mean "the next code can be asked for in N seconds", so the page has one function for both.

### `src/lib/phone.ts`

```ts
// Step 26c: a phone as people read it. The orders keep the 11 digits plain ("01786120356",
// decision 11); the dialog and the order page show them as Bangladeshis write a mobile number,
// "01786 120356" (CLAUDE.md → Order confirmed dialog). Anything that is not 11 digits is shown as
// it is: a wrong space is better than a dropped digit.
export function spacedPhone(phone: string): string {
  return /^\d{11}$/.test(phone) ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone;
}
```

`spacedPhone` writes the plain 11 digits as "01786 120356" (5 + 6, as Bangladeshis write a mobile number and as
`CLAUDE.md` shows it). The dialog's script and the order page both use it, so the two never disagree. Anything that is
not 11 digits is returned as it is: a wrong space is better than a lost digit.

### `src/lib/order-timeline.ts`

```ts
import type { ShopOrder, ShopOrderStatus } from '@omnivo/contracts';

// Step 26c: the steps of an order's status timeline (CLAUDE.md → Track order: done, current and
// later dots). /order/<no> draws it now and 26d's /track draws the same one, so the rules live
// here, apart from the markup, and are tested once.

export type TimelineState = 'done' | 'current' | 'later';

export interface TimelineStep {
  status: ShopOrderStatus;
  // When the order reached this step (ISO), or null for a step still ahead
  at: string | null;
  state: TimelineState;
}

// The road an order normally takes. Cancelled and returned leave it, so they are not on it
const ROAD: readonly ShopOrderStatus[] = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];

export function orderTimeline(order: Pick<ShopOrder, 'status' | 'history'>): TimelineStep[] {
  // The last time each status was reached. An order may pass a status twice (a shop that moves it
  // back by mistake); the newest date is the true one
  const reached = new Map<ShopOrderStatus, string>();
  for (const step of order.history) reached.set(step.status, step.at);

  if (order.status === 'cancelled' || order.status === 'returned') {
    // Only what happened, in its order, ending on the cancel or the return. Steps that will never
    // come are not drawn as "later": that would promise a delivery
    return order.history.map((step, index) => ({
      status: step.status,
      at: step.at,
      state: index === order.history.length - 1 ? 'current' : 'done',
    }));
  }

  const now = ROAD.indexOf(order.status);
  return ROAD.map((status, index) => ({
    status,
    // A step behind the current one without a date (a shop that jumped from confirmed to shipped)
    // is still done: the order is past it. It just has no date to show
    at: index <= now ? (reached.get(status) ?? null) : null,
    // Delivered is the end of the road: done, not "current", since nothing more will happen
    state:
      index < now || (index === now && status === 'delivered')
        ? 'done'
        : index === now
          ? 'current'
          : 'later',
  }));
}
```

The rules of the status timeline, apart from its markup, so 26d's `/track` draws the same steps (decision 34).

- **`ROAD`** is the normal life of an order. `cancelled` and `returned` leave it, so they are not on it.
- **`reached`** keeps the last date of each status. If a shop moves an order back and forward by mistake, the newest
  date is the true one; a `find()` would take the first.
- **A cancelled or returned order** maps its own `history`, with the last step as the current one (decision 35).
- **`at` for a step behind the current one may be `null`**: a shop may move an order from confirmed straight to
  shipped. The step is still done (the order is past it); it just has no date to show.
- **`delivered` is `done` when it is the status**, not `current` (decision 35). The nested condition reads: before
  the current step, or the current step when it is the end of the road, is done; the current step otherwise is
  current; the rest is later.

### `src/components/OrderConfirmedDialog.astro`

```
---
import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import type { ShopLocale } from '../lib/locale';

// Step 26c: "Order Confirmed" (Figma confirmation_status 41:4066; CLAUDE.md → Order confirmed
// dialog). It opens over the page that confirmed the order: the checkout (Mobile Banking) or the
// verify page (a right code). Neither page opens it: they send the shop:order-confirmed event, and
// this listens on the document (decision 24). Only those two pages draw it.
// A native <dialog> in a custom element, like the cart drawer: showModal() gives the focus trap,
// Escape, the inert page and the backdrop, with a few lines of script and no React.
interface Props {
  locale: ShopLocale;
}

const { locale } = Astro.props;
const { t } = locale;

const button =
  'flex h-11 items-center justify-center rounded-sm font-medium transition-colors duration-150';
---

<order-confirmed>
  {/* 440px, the screen minus 32px on a phone. A modal <dialog> is centered by the browser
      (position fixed, margin auto); max-w-none drops the browser's own 2em limit */}
  <dialog
    aria-labelledby="order-confirmed-title"
    aria-describedby="order-confirmed-text"
    class="m-auto w-[calc(100%-32px)] max-w-[440px] rounded-2xl border-0 bg-card px-12 pt-16 pb-12 text-center text-brand backdrop:bg-overlay"
  >
    {/* A fixed <dialog> is the containing block, so `absolute` is measured from its corner */}
    <button
      type="button"
      data-close
      aria-label={t('shop.confirmed.close')}
      class="absolute top-4 right-4 grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-canvas hover:text-brand"
    >
      <HugeiconsIcon icon={Cancel01Icon} size={24} strokeWidth={1.5} aria-hidden="true" />
    </button>

    {/* Figma's two-tone tick-double-03, as Figma drew it (CLAUDE.md: a two-tone drawing is not a
        Stroke Rounded icon). Decorative: the title says the same */}
    <img src="/shapes/order-confirmed.svg" width="100" height="100" alt="" class="mx-auto" />

    {/* The title and the line are trimmed (trim-text), as Figma measures them: the dialog is
        500px tall at 1440px, not 526px */}
    <h2 id="order-confirmed-title" class="trim-text mt-12 text-sf-title font-semibold">
      {t('shop.confirmed.title')}
    </h2>
    {/* Two words around the phone, so Bangla can put it in the middle of its sentence. The
        script writes the sentence when it knows the phone: written here, the line breaks of the
        markup would put a space before the full stop */}
    <p
      id="order-confirmed-text"
      data-text
      data-before={t('shop.confirmed.textBefore')}
      data-after={t('shop.confirmed.textAfter')}
      class="trim-text mx-auto mt-6 max-w-[307px] leading-6 text-muted"
    ></p>

    <div class="mt-16 flex flex-col gap-3">
      {/* The script sets the order's address before the dialog opens */}
      <a data-details href="/" class={`${button} bg-cream hover:bg-accent`}>
        {t('shop.confirmed.details')}
      </a>
      <a data-continue href="/" class={`${button} bg-accent hover:bg-brand hover:text-accent`}>
        {t('shop.confirmed.continueShopping')}
      </a>
    </div>
  </dialog>
</order-confirmed>

<script>
  import type { ShopOrderConfirmed } from '@omnivo/contracts';

  import { ORDER_CONFIRMED_EVENT, type OrderConfirmedEvent } from '../lib/order-events';
  import { spacedPhone } from '../lib/phone';

  function part<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    // The markup is in the same file: a missing part is a bug to see at once
    if (!element) throw new Error(`order confirmed dialog: ${selector} is missing`);
    return element;
  }

  class OrderConfirmed extends HTMLElement {
    private readonly onConfirmed = (event: OrderConfirmedEvent): void => {
      this.open(event.detail);
    };

    connectedCallback(): void {
      document.addEventListener(ORDER_CONFIRMED_EVENT, this.onConfirmed);
      const dialog = part<HTMLDialogElement>(this, 'dialog');

      part(this, '[data-close]').addEventListener('click', () => {
        dialog.close();
      });
      // A click on the dim backdrop lands on the <dialog> itself (see the cart drawer)
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      // CLAUDE.md: closing it any way is "Continue shopping". The cart is already empty and the
      // page behind is an order that is done, so there is nothing to go back to. "View Order
      // Details" is a link: it leaves the page without closing the dialog, so it never gets here
      dialog.addEventListener('close', () => {
        window.location.assign('/');
      });
    }

    disconnectedCallback(): void {
      document.removeEventListener(ORDER_CONFIRMED_EVENT, this.onConfirmed);
    }

    private open(order: ShopOrderConfirmed): void {
      const dialog = part<HTMLDialogElement>(this, 'dialog');
      if (dialog.open) return;
      const text = part<HTMLElement>(this, '[data-text]');
      const phone = document.createElement('span');
      // CLAUDE.md: the number at 500 in `body`. nowrap: "01786 120356" stays on one line
      phone.className = 'font-medium whitespace-nowrap text-body tabular-nums';
      phone.textContent = spacedPhone(order.phone);
      // Text nodes, never innerHTML: the words and the phone are text, whatever they hold
      text.replaceChildren(text.dataset.before ?? '', phone, text.dataset.after ?? '');
      // encodeURIComponent: the number comes from the server, but a link is built from it
      part<HTMLAnchorElement>(this, '[data-details]').href =
        `/order/${encodeURIComponent(order.orderNo)}`;
      dialog.showModal();
      // CLAUDE.md: "Continue shopping" has the focus. showModal() would give it to the first
      // button (the close X), so it is moved here
      part<HTMLAnchorElement>(this, '[data-continue]').focus();
    }
  }

  customElements.define('order-confirmed', OrderConfirmed);
</script>
```

The dialog, as Figma draws it: 440px wide, padding 64px 48px 48px, the 100px two-tone tick, the title 48px below it,
the sentence 24px below that, and the two 44px buttons 64px lower.

- **A native `<dialog>` in a custom element**, like the cart drawer (26b's decision 21). `showModal()` makes the rest
  of the page inert, keeps the focus inside, draws the `::backdrop` (`backdrop:bg-overlay`) and closes on Escape.
- **`m-auto` and `w-[calc(100%-32px)] max-w-[440px]`**: the browser centers a modal dialog with `position: fixed` and
  automatic margins; the width is the screen minus the 16px gutters on a phone, and Figma's 440px from there on.
- **The close button is `absolute`** inside the dialog. A `position: fixed` element is the containing block for its
  absolute children, so `top-4 right-4` is 16px from the dialog's own corner.
- **The illustration is an `<img>` with `alt=""`.** It is Figma's two-tone drawing (`/shapes/order-confirmed.svg`,
  downloaded in 26b), not a Stroke Rounded icon, and it says nothing the title does not.
- **The title and the sentence are trimmed** (`trim-text`), like the checkout's text. Figma's 48px, 24px and 64px are
  measured between trimmed text boxes; untrimmed, the dialog was 526px tall instead of Figma's 500px.
- **The sentence is written by the script**, with the words in `data-before` and `data-after`. Written in the markup,
  Prettier puts the phone's `<span>` on its own line, and the line break becomes a space before the full stop
  ("120356 ."). The script joins three text nodes with no space between them. `replaceChildren` with strings makes
  text nodes, so nothing in the words or the phone can become markup.
- **The two buttons are links.** "View Order Details" is a real address the shopper may open in a new tab;
  "Continue shopping" is `/`. The script sets the first one's `href` from the order number, through
  `encodeURIComponent`.

The script:

- **The listener is typed by `DocumentEventMap`** (26c.4's `order-events.ts`), so `event.detail` is a
  `ShopOrderConfirmed` with no cast and no check. `disconnectedCallback` removes it, as the drawer does.
- **A click whose target is the `<dialog>` itself is a click on the backdrop**: the dialog's padding box is filled by
  its content, so a click inside always lands on a child.
- **The `close` event goes home** (decision 33). Escape, the X and the backdrop all end in `dialog.close()`, so one
  listener covers them. The details link leaves the page without closing the dialog, so it never gets here.
- **`open()` returns if the dialog is open already**, so a second event (two answers to one double click) changes
  nothing on screen.
- **The focus is moved to "Continue shopping"** after `showModal()` (`CLAUDE.md`). `showModal()` focuses the first
  focusable element, which is the close button.

### `src/pages/checkout/verify.astro`

```
---
import { Alert02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { numberLocale } from '@omnivo/i18n';
import { SHOP_CODE_LENGTH } from '@omnivo/contracts';

import OrderConfirmedDialog from '../../components/OrderConfirmedDialog.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';
import { waitText } from '../../lib/verify';
import { checkoutToken } from '../../server/cookies';

// Step 26c: the phone code for a Cash on Delivery order (decision 4; CLAUDE.md → Phone
// verification, not in Figma). The order is found by the token in the httpOnly checkout cookie,
// so this page can only ever show the order this browser placed.
const token = checkoutToken(Astro.request);
const wait = token === null ? null : await shopSource.codeWait(token);
// No order waits here: never placed, already confirmed (a reload after the dialog), dropped after
// five wrong codes, or past its hour. The checkout is where a shopper can do something about it,
// and their cart is still there (decision 23)
if (wait === null) return Astro.redirect('/checkout');

const shop = await shopSource.shop();
const locale = await shopLocale(shop.language);
const { t } = locale;
const numbers = numberLocale(locale.language);

// Words with a value in them go to the script as templates with their {{placeholders}} kept. Literal
// objects, not a helper: t() checks each key's values against its words, and a computed key
// would lose that
const count = { replace: { count: '{{count}}' } };
const words = {
  wrong: t('errors.shop_code_wrong'),
  triesOne: t('shop.verify.triesLeft', { ...count, count: 1 }),
  triesOther: t('shop.verify.triesLeft', { ...count, count: 2 }),
  tooMany: t('errors.shop_code_too_many'),
  noOrder: t('errors.shop_code_no_order'),
  format: t('errors.shop_code_format'),
  wait: t('errors.shop_code_resend_wait'),
  failed: t('shop.verify.failed'),
  resendIn: t('shop.verify.resendIn', { time: '{{time}}' }),
  resent: t('shop.verify.resent'),
  checking: t('shop.verify.checking'),
  confirm: t('shop.checkout.confirm'),
};

// The page is this shopper's own (their cookie), so no cache may keep it
Astro.response.headers.set('Cache-Control', 'no-store');

const textLink =
  'font-semibold text-brand underline-offset-3 transition-colors duration-150 not-aria-disabled:hover:underline aria-disabled:cursor-not-allowed aria-disabled:text-muted';
---

<ShopLayout shop={shop} locale={locale} title={t('shop.verify.pageTitle', { shop: shop.name })}>
  <verify-code
    data-length={SHOP_CODE_LENGTH}
    data-number-locale={numbers}
    data-listing-ids={JSON.stringify(wait.listingIds)}
    data-resend-in={wait.resendInSeconds}
    data-words={JSON.stringify(words)}
  >
    {/* The checkout card at 560px (CLAUDE.md), with the checkout's 4px glass frame, and the
        checkout's 160px to the footer */}
    <div class="mx-auto mt-4 max-w-[560px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
      <div class="rounded-t-xl bg-cream p-6 text-center">
        <h1 class="trim-text text-sf-title font-semibold">{t('shop.verify.title')}</h1>
      </div>
      {/* noValidate: the browser's own bubbles would be in the browser's language */}
      <form novalidate class="flex flex-col gap-8 p-5 md:p-9">
        <div class="flex flex-col gap-3">
          <p class="text-body">{t('shop.verify.sent', { phone: wait.maskedPhone })}</p>
          {/* Only a test shop has a code to show (ShopSource.testCode): the mock sends no SMS */}
          {shopSource.testCode !== null && (
            <p class="rounded-lg bg-canvas px-4 py-3 text-sf-small font-medium text-body">
              {t('shop.verify.mockCode', { code: shopSource.testCode })}
            </p>
          )}
        </div>

        {/* The box and its error line share one block: as two children of the form, the empty
            error line would still take the form's 32px gap */}
        <div class="flex flex-col">
          <div data-code-field class="flex flex-col gap-3">
            <label for="verify-code" class="trim-text font-semibold">
              {t('shop.verify.code')}
            </label>
            {/* one-time-code: a phone offers the code from the SMS above the keyboard.
              inputmode numeric: the digit keyboard; type stays text, because a number box drops
              a leading 0 and shows a spinner */}
            <input
              id="verify-code"
              name="code"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              aria-describedby="verify-error"
              class="h-12 w-full min-w-0 rounded-lg border border-field bg-card px-4 text-center text-sf-title tracking-[0.3em] tabular-nums transition-colors duration-150 hover:border-muted-line focus:border-brand focus:outline-2 focus:outline-offset-0 focus:outline-brand aria-invalid:border-promo"
            />
          </div>
          {/* role="alert": the shopper pressed the button and waits for this answer. Empty until
            there is something to say; the script fills the text and shows the line, and only
            then is it 12px under the box. It stays when the box goes (five wrong codes) */}
          <div id="verify-error" role="alert" class="has-[>p:not([hidden])]:pt-3">
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
              <span data-error-text></span>
            </p>
          </div>
        </div>

        <div class="flex flex-col gap-6">
          {/* aria-disabled, not disabled, while it waits: a disabled button loses the focus */}
          <button
            type="submit"
            data-submit
            class="h-16 w-full rounded-sm bg-accent text-[18px] font-semibold transition-colors duration-150 not-aria-disabled:hover:bg-brand not-aria-disabled:hover:text-accent aria-disabled:bg-canvas aria-disabled:text-muted"
          >
            {words.confirm}
          </button>
          <p data-resend-row class="text-center">
            <button
              type="button"
              data-resend
              aria-disabled={wait.resendInSeconds > 0 ? 'true' : undefined}
              class={textLink}
            >
              {/* The space is part of the text, so the button's name reads "Resend code in 0:45".
                  Astro drops the line break before the <span>, so a typed space would be lost */}
              {`${t('shop.verify.resend')} `}
              {/* The server's wait, drawn here first so the page does not jump when the script
                  starts; the script counts it down */}
              <span data-resend-wait class="tabular-nums" hidden={wait.resendInSeconds === 0}>
                {t('shop.verify.resendIn', { time: waitText(wait.resendInSeconds, numbers) })}
              </span>
            </button>
          </p>
          {/* "A new code is on its way." Polite: it is news, not an error */}
          <p
            data-status
            role="status"
            class="text-center text-sf-small text-muted empty:hidden"
          ></p>
          {/* After five wrong codes or a dropped order: the only way on is a new order */}
          <a
            data-start-again
            href="/checkout"
            hidden
            class="flex h-11 items-center justify-center rounded-sm bg-cream font-semibold transition-colors duration-150 hover:bg-accent"
          >
            {t('shop.verify.startAgain')}
          </a>
        </div>
      </form>
    </div>
  </verify-code>

  <OrderConfirmedDialog locale={locale} />
</ShopLayout>

<script>
  import { removeFromCart } from '../../lib/cart';
  import { announceOrderConfirmed } from '../../lib/order-events';
  import {
    codeDigits,
    fillWords,
    isOrderConfirmed,
    problemParts,
    resendSeconds,
    waitText,
    type ProblemParts,
  } from '../../lib/verify';

  // The page's words, as the server wrote them (see `words` above)
  const WORD_KEYS = [
    'wrong',
    'triesOne',
    'triesOther',
    'tooMany',
    'noOrder',
    'format',
    'wait',
    'failed',
    'resendIn',
    'resent',
    'checking',
    'confirm',
  ] as const;
  type WordKey = (typeof WORD_KEYS)[number];

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function readIds(json: string | undefined): Set<string> {
    const value: unknown = JSON.parse(json ?? '[]');
    return new Set(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
    );
  }

  function part<T extends Element>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`verify: ${selector} is missing`);
    return element;
  }

  async function post(url: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  // A body that is not JSON (a proxy's error page) is "no body", not a crash
  async function bodyOf(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  class VerifyCode extends HTMLElement {
    private words: Record<string, unknown> = {};
    private length = 6;
    private numbers = 'en-IN';
    private listingIds = new Set<string>();
    private resendAt = 0;
    private timer: number | undefined;
    private busy = false;
    private done = false;

    connectedCallback(): void {
      const words: unknown = JSON.parse(this.dataset.words ?? '{}');
      this.words = isRecord(words) ? words : {};
      // Every word is read once now, so a missing one fails when the page opens, not when a
      // shopper first types a wrong code
      for (const key of WORD_KEYS) this.word(key);
      this.length = Number(this.dataset.length ?? '6');
      this.numbers = this.dataset.numberLocale ?? 'en-IN';
      this.listingIds = readIds(this.dataset.listingIds);
      this.startWait(Number(this.dataset.resendIn ?? '0'));

      const input = this.input;
      // Bangla digits become ASCII as they are typed, and anything else is dropped (CLAUDE.md)
      input.addEventListener('input', () => {
        const digits = codeDigits(input.value, this.length);
        if (digits !== input.value) input.value = digits;
      });
      part(this, 'form').addEventListener('submit', (event) => {
        event.preventDefault();
        void this.verify();
      });
      part(this, '[data-resend]').addEventListener('click', () => {
        void this.resend();
      });
    }

    disconnectedCallback(): void {
      window.clearInterval(this.timer);
    }

    // JSON from our own page, checked anyway: a missing word would show "undefined" to a shopper
    private word(key: WordKey): string {
      const word = this.words[key];
      if (typeof word !== 'string') throw new Error(`verify: word ${key} is missing`);
      return word;
    }

    private get input(): HTMLInputElement {
      return part(this, '#verify-code');
    }

    private showError(text: string | null): void {
      const line = part<HTMLElement>(this, '[data-error]');
      part(this, '[data-error-text]').textContent = text ?? '';
      line.hidden = text === null;
      // The box is outlined in promo while its code is the problem
      if (text === null) this.input.removeAttribute('aria-invalid');
      else this.input.setAttribute('aria-invalid', 'true');
    }

    private say(text: string): void {
      part(this, '[data-status]').textContent = text;
    }

    private setBusy(busy: boolean): void {
      this.busy = busy;
      const submit = part<HTMLButtonElement>(this, '[data-submit]');
      submit.textContent = busy ? this.word('checking') : this.word('confirm');
      submit.setAttribute('aria-disabled', String(busy || this.done));
    }

    // The order can no longer get a code: too many wrong ones, or it is gone. The form goes; the
    // way back to the checkout takes its place and the focus
    private end(text: string): void {
      this.done = true;
      window.clearInterval(this.timer);
      for (const selector of ['[data-code-field]', '[data-submit]', '[data-resend-row]']) {
        part<HTMLElement>(this, selector).hidden = true;
      }
      this.say('');
      part<HTMLElement>(this, '[data-error]').hidden = false;
      part(this, '[data-error-text]').textContent = text;
      const back = part<HTMLAnchorElement>(this, '[data-start-again]');
      back.hidden = false;
      back.focus();
    }

    private async verify(): Promise<void> {
      if (this.busy || this.done) return;
      const code = codeDigits(this.input.value, this.length);
      if (code.length !== this.length) {
        this.showError(this.word('format'));
        this.input.focus();
        return;
      }
      this.showError(null);
      this.say('');
      this.setBusy(true);

      let response: Response;
      try {
        response = await post('/api/orders/verify', { code });
      } catch (error) {
        console.error(error);
        this.setBusy(false);
        this.showError(this.word('failed'));
        return;
      }
      const body = await bodyOf(response);

      if (response.ok && isOrderConfirmed(body)) {
        // The order is real now: its lines leave this browser's cart (decision 23), and the
        // dialog opens over this page. The form stays, unusable, behind it
        this.done = true;
        this.setBusy(false);
        window.clearInterval(this.timer);
        removeFromCart(this.listingIds);
        announceOrderConfirmed(body);
        return;
      }
      this.setBusy(false);
      this.refused(response.ok ? null : problemParts(body));
    }

    private refused(problem: ProblemParts | null): void {
      switch (problem?.code) {
        case 'shop_code_wrong': {
          const left = problem.params.triesLeft;
          const tries =
            typeof left === 'number'
              ? ` ${fillWords(
                  new Intl.PluralRules(this.numbers).select(left) === 'one'
                    ? this.word('triesOne')
                    : this.word('triesOther'),
                  { count: new Intl.NumberFormat(this.numbers).format(left) },
                )}`
              : '';
          this.showError(`${this.word('wrong')}${tries}`);
          // Ready for the next try: the wrong digits go, the focus stays in the box
          this.input.value = '';
          this.input.focus();
          return;
        }
        case 'shop_code_too_many':
          this.end(this.word('tooMany'));
          return;
        case 'shop_code_no_order':
          this.end(this.word('noOrder'));
          return;
        // The route's own check (400) says the same as the page's check above
        case 'invalid_input':
          this.showError(this.word('format'));
          this.input.focus();
          return;
        default:
          this.showError(this.word('failed'));
      }
    }

    private async resend(): Promise<void> {
      if (this.done || this.waiting()) return;
      this.say('');
      let response: Response;
      try {
        response = await post('/api/orders/resend');
      } catch (error) {
        console.error(error);
        this.showError(this.word('failed'));
        return;
      }
      const body = await bodyOf(response);
      const seconds = resendSeconds(body);

      if (response.ok && seconds !== null) {
        this.showError(null);
        this.say(this.word('resent'));
        this.startWait(seconds);
        return;
      }
      const problem = problemParts(body);
      if (problem?.code === 'shop_code_no_order') {
        this.end(this.word('noOrder'));
      } else if (problem?.code === 'shop_code_resend_wait' && seconds !== null) {
        // Another tab asked a moment ago: the server's wait is the one that counts
        this.say(this.word('wait'));
        this.startWait(seconds);
      } else {
        this.showError(this.word('failed'));
      }
    }

    private waiting(): boolean {
      return Date.now() < this.resendAt;
    }

    // "Resend code in 0:45", counted down from the server's number of seconds. The clock is the
    // browser's; the server checks its own clock again when the button is pressed
    private startWait(seconds: number): void {
      window.clearInterval(this.timer);
      this.resendAt = Date.now() + seconds * 1000;
      this.tick();
      if (seconds > 0) {
        this.timer = window.setInterval(() => {
          this.tick();
        }, 1000);
      }
    }

    private tick(): void {
      const left = (this.resendAt - Date.now()) / 1000;
      const button = part<HTMLButtonElement>(this, '[data-resend]');
      const label = part<HTMLElement>(this, '[data-resend-wait]');
      if (left <= 0) {
        window.clearInterval(this.timer);
        button.removeAttribute('aria-disabled');
        label.hidden = true;
        return;
      }
      button.setAttribute('aria-disabled', 'true');
      label.hidden = false;
      label.textContent = fillWords(this.word('resendIn'), {
        time: waitText(left, this.numbers),
      });
    }
  }

  customElements.define('verify-code', VerifyCode);
</script>
```

The frontmatter:

- **The order comes from the checkout cookie** (`checkoutToken`), never from the address: the page has no order number
  in it, so it cannot be opened for someone else's order (decision 4).
- **No waiting order → `Astro.redirect('/checkout')`** (decision 30). It is a 302: the page exists, it just has
  nothing to show to this browser now.
- **`words` holds every word the script may show**, as the server translated them. A word with a value keeps its
  placeholder: `t('shop.verify.resendIn', { time: '{{time}}' })` gives "in {{time}}", and the script fills it. The
  plural pair is made twice, with `count: 1` and `count: 2`, and `replace: { count: '{{count}}' }` puts the
  placeholder back, so the script picks the form with `Intl.PluralRules` and fills the number. The objects are
  written out: a helper that built `{ [name]: … }` lost the key's type, and `t()`'s types refused it.
- **`Cache-Control: no-store`**, like the checkout: the page is this shopper's.

The markup:

- **`<verify-code>` carries the data the script needs** in `data-*` attributes: the code's length, the number
  locale, the ordered listings (JSON), the seconds left before a new code, and the words (JSON).
- **The test code shows only when `shopSource.testCode` is not `null`** (26c.3): in the mock. A real shop sends the SMS
  and shows nothing.
- **The code box is `type="text"` with `inputmode="numeric"`**: the phone shows the digit keyboard, and the value
  stays text. A `type="number"` box drops a leading zero ("012345" becomes 12345) and draws a spinner.
  `autocomplete="one-time-code"` lets iOS and Android offer the code from the SMS above the keyboard.
- **The box and its error line are one block**, and the error line gets its 12px top padding only while its `<p>` is
  shown (`has-[>p:not([hidden])]:pt-3`). As two children of the form, the empty error line still took the form's
  32px gap (seen at 390px wide).
- **The error line is a `role="alert"` region that is always in the page.** A live region added to the page at the
  moment it has something to say is often not read out; one that is there from the start and changes is.
- **The buttons use `aria-disabled`, not `disabled`**, while they cannot be used: a `disabled` button loses the focus,
  and the shopper who just pressed Resend would be dropped out of the form.
- **"Resend code" and its wait are one button.** The space between them is in the text (`` `${t(…)} ` ``): Astro
  drops the line break before the `<span>`, and a CSS margin looked right but left the button's name as "Resend
  codein 0:45" for a screen reader (found with Playwright's `innerText`).
- **`data-status` is `role="status"`**: "A new code is on its way." is news, not an error, so it is polite.
  `empty:hidden` keeps the empty paragraph from taking a gap; it is one tag on one line so it is really empty.
- **"Back to checkout" is in the page but hidden** until the order can no longer get a code.
- **The card is the checkout's** (`trim-text` on the heading and the label, `md:mb-40` to the footer), so the page
  looks like the next step of the same form (decision 38).
- **`<OrderConfirmedDialog>`** opens over this page when the code is right.

The script:

- **The words are read once in `connectedCallback`**, every key, so a missing word fails when the page opens (in the
  console, for the developer), not later in front of a shopper. `word()` checks each value is a string; there is no
  cast from the JSON.
- **The `input` listener cleans the box as it is typed** (`codeDigits`): Bangla digits become ASCII at once
  (`CLAUDE.md`), and letters never show. It writes the value back only when it changed, so the caret does not jump
  on every key.
- **`verify()`** checks the length first, so a short code never costs a try on the server. Then it posts the code; the
  cookie goes with it by itself (same origin).
  - **A right code**: the ordered listings leave the cart (`removeFromCart`, decision 31), and the event opens the
    dialog. `done` stops every later click; the form stays behind the dialog.
  - **`shop_code_wrong`** shows the error and "4 tries left." in the shop's words and digits, empties the box and keeps
    the focus in it, ready for the next try.
  - **`shop_code_too_many` and `shop_code_no_order`** call `end()`: the box, the button and Resend go, the error says
    why, and "Back to checkout" appears with the focus. The cart is still there, so the checkout is one click away.
  - **`invalid_input`** is the route's own length check (400); it says the same as the page's check.
  - **Anything else**, including no answer, shows "The code was not sent…".
- **`resend()`** returns at once while the wait runs. A 200 says "A new code is on its way." and starts the wait
  again; a 429 (another tab asked a moment ago) starts the server's wait; a 404 ends the page like a dropped order.
- **The wait is counted by the browser's clock** from the server's seconds (`resendAt`). The server checks its own
  clock again on every press, so a changed browser clock can only show a wrong number, never send an SMS early.
- **`tick()`** runs every second while there is a wait, and stops its interval at zero.

### `src/components/OrderTimeline.astro`

```
---
import { Tick02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ShopOrder } from '@omnivo/contracts';
import { formatDateTime } from '@omnivo/i18n';

import type { ShopLocale } from '../lib/locale';
import { orderTimeline } from '../lib/order-timeline';

// Step 26c: an order's status as a vertical timeline (CLAUDE.md → Track order). /order/<no> draws
// it now; 26d's /track draws the same one. Drawn on the server, with no script: it changes only
// when the shop moves the order, and a reload shows that.
interface Props {
  order: Pick<ShopOrder, 'status' | 'history'>;
  locale: ShopLocale;
  // The shop's, so "11 Nov 2026, 10:02" is the time in Dhaka on any server
  timeZone: string;
  // The id of the heading that names the list
  labelledBy: string;
}

const { order, locale, timeZone, labelledBy } = Astro.props;
const { t } = locale;
const steps = orderTimeline(order);

// The three dots of CLAUDE.md: done (brand, an accent tick), current (brand inside a 2px accent
// ring), later (an empty 1px rule ring)
const DOT = {
  done: 'bg-brand text-accent',
  current: 'border-2 border-accent bg-brand',
  later: 'border border-rule bg-card',
} as const;
---

<ol aria-labelledby={labelledBy} class="flex flex-col">
  {steps.map((step, index) => {
    const last = index === steps.length - 1;
    // The line to the next dot is brand while the next step is reached, rule after that
    const next = steps[index + 1];
    const line = next !== undefined && next.state !== 'later' ? 'bg-brand' : 'bg-rule';
    return (
      <li
        class:list={['relative flex gap-4', !last && 'pb-6']}
        aria-current={step.state === 'current' ? 'step' : undefined}
      >
        {/* The 2px line runs from under this dot to the next one, through the 24px gap. 11px
              from the left centers it under the 24px dot */}
        {!last && <span class={`absolute top-6 bottom-0 left-[11px] w-0.5 ${line}`} />}
        <span class={`grid size-6 shrink-0 place-items-center rounded-full ${DOT[step.state]}`}>
          {step.state === 'done' && (
            <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.5} aria-hidden="true" />
          )}
        </span>
        <span class="flex flex-col">
          <span class="leading-6 font-semibold">{t(`shop.order.statuses.${step.status}`)}</span>
          {step.at !== null && (
            <time datetime={step.at} class="text-sf-small text-muted tabular-nums">
              {formatDateTime(new Date(step.at), locale.language, timeZone)}
            </time>
          )}
        </span>
      </li>
    );
  })}
</ol>
```

The timeline of `CLAUDE.md` → Track order, drawn on the server.

- **`DOT`** has the three looks: done is `brand` with a 14px `accent` `Tick02`, current is `brand` inside a 2px
  `accent` ring, later is an empty 1px `rule` ring. `as const` keeps the keys, so `DOT[step.state]` is checked.
- **The connecting line** is a 2px `<span>`, absolute, from 24px down (under the dot) to the bottom of the `<li>`,
  which includes its 24px bottom padding, so it meets the next dot. `left-[11px]` centers 2px under a 24px dot. It is
  `brand` while the next step is reached and `rule` after that, so the line shows how far the order got.
- **`aria-current="step"`** marks the current step for a screen reader; the dates say which steps are done.
- **`formatDateTime` with the shop's time zone**: "12 Nov 2026, 10:14" is Dhaka's time even on a server in UTC.
- **`labelledBy`** names the list from the page's heading, so the component does not need its own words.

### `src/pages/order/[no].astro`

```
---
import { compareMoney } from '@omnivo/contracts';
import { formatDateTime, formatNumber } from '@omnivo/i18n';

import OrderTimeline from '../../components/OrderTimeline.astro';
import { shopSource } from '../../data/source';
import ShopLayout from '../../layouts/ShopLayout.astro';
import { shopLocale } from '../../lib/locale';
import { spacedPhone } from '../../lib/phone';
import { orderTokens } from '../../server/cookies';

// Step 26c: one order, from "View Order Details" (CLAUDE.md → Order details, not in Figma). Only
// the browser that placed it may see it (decision 5): the number must be one of the orders cookie's,
// and the source checks that its token belongs to it.
const orderNo = Astro.params.no ?? '';
const token = orderTokens(Astro.request).get(orderNo);
const order = token === undefined ? null : await shopSource.order(orderNo, token);

// Not this browser's order, a number that does not exist, or one still waiting for its code: the
// same "page not found" for each, so the page never tells a stranger that an order exists
if (order === null) return Astro.rewrite('/404');

const shop = await shopSource.shop();
const locale = await shopLocale(shop.language);
const { t, money } = locale;
const when = (iso: string) => formatDateTime(new Date(iso), locale.language, shop.timeZone);

// A phone and a home address: no cache may keep them. A search engine never sees the page: it
// has no orders cookie, so it gets the 404 above
Astro.response.headers.set('Cache-Control', 'no-store');

const freeDelivery = compareMoney(order.deliveryCharge, '0') === 0;
const details = [
  { label: t('shop.checkout.name'), value: order.name },
  { label: t('shop.checkout.phone'), value: spacedPhone(order.phone) },
  { label: t('shop.checkout.address'), value: order.address },
  { label: t('shop.checkout.zone'), value: order.zoneName },
  { label: t('shop.order.payment'), value: t(`shop.checkout.${order.paymentMethod}`) },
];
const heading = 'font-semibold';
---

<ShopLayout
  shop={shop}
  locale={locale}
  title={t('shop.order.pageTitle', { orderNo: order.orderNo, shop: shop.name })}
>
  {/* The checkout card at 848px, read-only (CLAUDE.md), 160px above the footer like the checkout */}
  <div class="mx-auto mt-4 max-w-[848px] rounded-2xl bg-card-glass p-1 md:mt-9 md:mb-40">
    <div class="rounded-t-xl bg-cream p-6 text-center">
      <h1 class="trim-text text-sf-title font-semibold">{t('shop.order.title')}</h1>
    </div>
    <div class="flex flex-col gap-8 p-5 md:p-9">
      <div class="flex flex-col gap-1">
        {/* CLAUDE.md: the number is never broken over two lines */}
        <p class="font-mono text-sf-title font-semibold whitespace-nowrap">{order.orderNo}</p>
        <p class="text-sf-small text-muted">
          {t('shop.order.placedOn', { date: when(order.placedAt) })}
        </p>
      </div>

      <section class="flex flex-col gap-4">
        <h2 id="order-timeline" class={heading}>
          {t('shop.order.timeline')}
        </h2>
        <OrderTimeline
          order={order}
          locale={locale}
          timeZone={shop.timeZone}
          labelledBy="order-timeline"
        />
      </section>

      <section class="flex flex-col gap-4">
        <h2 class={heading}>{t('shop.order.delivery')}</h2>
        {/* Two columns from md, like the checkout's Full Name and Mobile Number */}
        <dl class="grid gap-4 md:grid-cols-2">
          {details.map(({ label, value }) => (
            <div class="flex flex-col gap-1">
              <dt class="text-sf-small font-medium text-muted">{label}</dt>
              <dd class="wrap-break-word text-body">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section class="flex flex-col gap-5">
        <h2 id="order-items" class={heading}>
          {t('shop.order.items')}
        </h2>
        {/* The checkout's lines without the stepper and the delete button: the count and the
            price as they were ordered (decision 13), not today's */}
        <ul aria-labelledby="order-items" class="flex flex-col gap-5">
          {order.lines.map((line) => (
            <li class="flex gap-4 md:gap-5">
              <span class="block h-20 w-24 shrink-0 overflow-hidden rounded-lg bg-canvas md:h-[130px] md:w-[155px]">
                <img
                  src={line.image.url}
                  alt=""
                  class="size-full object-contain mix-blend-multiply"
                />
              </span>
              <div class="flex min-w-0 flex-1 items-start justify-between gap-3">
                <div class="flex min-w-0 flex-col gap-1 md:gap-2">
                  <a
                    href={`/p/${encodeURIComponent(line.slug)}`}
                    class="line-clamp-2 max-w-72 font-semibold hover:underline md:text-sf-subtitle"
                  >
                    {line.name}
                  </a>
                  <p class="text-sf-small text-muted tabular-nums">
                    {line.packSize !== '' && <span>{line.packSize} · </span>}
                    {t('shop.order.lineQuantity', {
                      quantity: formatNumber(line.quantity, locale.language),
                      price: money(line.unitPrice),
                    })}
                  </p>
                </div>
                <span class="shrink-0 font-semibold text-price tabular-nums md:text-sf-subtitle">
                  {money(line.lineTotal)}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {/* The checkout's rows, with the Subtotal first: here nothing above them adds up */}
        <div>
          <div class="flex flex-col gap-6 border-y border-rule py-6 font-semibold">
            <p class="flex items-center justify-between gap-4">
              <span class="trim-text">{t('shop.order.subtotal')}</span>
              <span class="trim-text tabular-nums">{money(order.subtotal)}</span>
            </p>
            {order.couponCode !== null && (
              <p class="flex items-center justify-between gap-4">
                <span class="trim-text">
                  {t('shop.checkout.discount', { code: order.couponCode })}
                </span>
                {/* U+2212, the minus sign, as on the checkout */}
                <span class="trim-text tabular-nums">−{money(order.discount)}</span>
              </p>
            )}
            <p class="flex items-center justify-between gap-4">
              <span class="trim-text">{t('shop.checkout.deliveryCharge')}</span>
              <span class="trim-text tabular-nums">
                {freeDelivery ? t('shop.order.free') : money(order.deliveryCharge)}
              </span>
            </p>
          </div>
          <p class="flex items-center justify-between gap-4 pt-6 text-sf-subtitle leading-5 font-bold">
            <span class="trim-text">{t('shop.checkout.total')}</span>
            <span class="trim-text text-price tabular-nums">{money(order.total)}</span>
          </p>
        </div>
      </section>
    </div>
  </div>
</ShopLayout>
```

- **The token comes from the orders cookie, by the number in the address**, and `shopSource.order()` checks they
  belong together (decision 5). No token for the number, a wrong number, or an order still waiting: all three are
  `Astro.rewrite('/404')`, the same answer, so the page never tells a stranger that an order exists.
- **`Cache-Control: no-store`**: the page has a phone and a home address. A search engine never sees it: it has no
  cookie, so it gets the 404.
- **`freeDelivery`** compares the charge with `compareMoney`, not `=== '0'`: the order keeps `'0.0000'`.
- **`details`** reuses the checkout's labels (Full Name, Mobile Number…), so the shopper reads the order with the
  words they filled in. The payment method's label comes from `shop.checkout.cod` / `online` by its value.
- **The order number is `font-mono` and `whitespace-nowrap`** (`CLAUDE.md`: Geist Mono, never broken).
- **The lines are the checkout's at the same sizes**, without the stepper and the delete button, and with
  "150ml · 3 × ৳229" under the name: the quantity and the price as they were ordered (decision 13).
- **The rows** are the checkout's with a Subtotal first (decision 36), and the Discount row only with a coupon: the
  same `gap-6 py-6` column between the rules and the same trimmed spans. The minus is U+2212, as on the checkout.
- **`md:mb-40`** keeps the checkout's 160px to the footer (decision 38).

### `src/styles/shop.css`

```diff
@@ -6,6 +6,9 @@
 /* Self-hosted like the app: a shop must not wait for Google Fonts, and 700 is here because the
    phone layout writes its titles and prices bold (Noto Sans Bengali draws the ৳ sign) */
 @import '@fontsource-variable/geist';
+/* Step 26c: for the order number on /order/<no> (CLAUDE.md: Geist Mono). A @font-face costs nothing
+   until a page draws text in it, so the other pages never download this file */
+@import '@fontsource-variable/geist-mono';
 @import '@fontsource/noto-sans-bengali/400.css';
 @import '@fontsource/noto-sans-bengali/500.css';
 @import '@fontsource/noto-sans-bengali/600.css';
@@ -52,6 +55,8 @@
   --color-overlay: var(--overlay);
   /* The variable package registers "Geist Variable", not "Geist" (CLAUDE.md → Typography) */
   --font-sans: 'Geist Variable', 'Noto Sans Bengali', 'Segoe UI', system-ui, sans-serif;
+  /* The same stack as the app's (packages/ui/src/styles.css) */
+  --font-mono: 'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace;
 }
 
 /* The type scale. Fixed values, so outside `inline`. text-sf-display, text-sf-body and so on */
```

Geist Mono for the order number (decision 37), with the app's font stack for `--font-mono`, so Tailwind's
`font-mono` is the same face in the shop and the ERP.

### `src/boundaries.spec.ts`

The rule "reaches src/server only from the API routes" (in 26c.4's diff) now lets the pages import
`server/cookies.ts`, and nothing else from `server/`. The verify and order pages read the cookies in their
frontmatter, which runs only on the server. `cookies.ts` imports nothing, so even a page's script that imported it by
mistake would ship no Zod. A component importing it, or a page importing `server/orders.ts`, still fails (tried).

### `src/lib/verify.spec.ts` and `src/lib/order-timeline.spec.ts`

```ts
import { describe, expect, it } from 'vitest';

import { spacedPhone } from './phone';
import {
  codeDigits,
  fillWords,
  isOrderConfirmed,
  problemParts,
  resendSeconds,
  waitText,
} from './verify';

describe('codeDigits', () => {
  it('keeps six ASCII digits from what the shopper typed or pasted', () => {
    expect(codeDigits('123 456', 6)).toBe('123456');
    expect(codeDigits('১২৩৪৫৬', 6)).toBe('123456');
    expect(codeDigits('Your code: 1234567', 6)).toBe('123456');
    expect(codeDigits('abc', 6)).toBe('');
  });
});

describe('waitText', () => {
  it('writes minutes and two-digit seconds', () => {
    expect(waitText(45, 'en-IN')).toBe('0:45');
    expect(waitText(65, 'en-IN')).toBe('1:05');
    expect(waitText(9.2, 'en-IN')).toBe('0:10');
  });

  it('counts in Bangla digits and never below zero', () => {
    expect(waitText(45, 'bn-BD')).toBe('০:৪৫');
    expect(waitText(-3, 'en-IN')).toBe('0:00');
  });
});

describe('fillWords', () => {
  it('fills every placeholder and leaves an unknown one', () => {
    expect(fillWords('{{count}} of {{count}} {{other}}', { count: '2' })).toBe('2 of 2 {{other}}');
  });
});

describe('the answers the verify page reads', () => {
  it('reads a problem’s code and params', () => {
    expect(problemParts({ code: 'shop_code_wrong', params: { triesLeft: 2 } })).toEqual({
      code: 'shop_code_wrong',
      params: { triesLeft: 2 },
    });
    expect(problemParts({ code: 'shop_code_no_order' })).toEqual({
      code: 'shop_code_no_order',
      params: {},
    });
    expect(problemParts('<html>Bad gateway</html>')).toBeNull();
  });

  it('takes a confirmed order only with its number and phone', () => {
    expect(isOrderConfirmed({ orderNo: 'W-000001', phone: '01786120356' })).toBe(true);
    expect(isOrderConfirmed({ orderNo: '', phone: '01786120356' })).toBe(false);
    expect(isOrderConfirmed({ orderNo: 1, phone: '01786120356' })).toBe(false);
  });

  it('reads the wait from a resend answer and from a 429', () => {
    expect(resendSeconds({ resendInSeconds: 45 })).toBe(45);
    expect(resendSeconds({ code: 'shop_code_resend_wait', params: { seconds: 12 } })).toBe(12);
    expect(resendSeconds({ resendInSeconds: -1 })).toBeNull();
    expect(resendSeconds(null)).toBeNull();
  });
});

describe('spacedPhone', () => {
  it('writes a mobile number as 5 + 6 digits', () => {
    expect(spacedPhone('01786120356')).toBe('01786 120356');
    expect(spacedPhone('+8801786')).toBe('+8801786');
  });
});
```

```ts
import { describe, expect, it } from 'vitest';

import { orderTimeline } from './order-timeline';

describe('orderTimeline', () => {
  const at = (minute: number) => `2026-11-11T10:${String(minute).padStart(2, '0')}:00+06:00`;

  it('marks the steps behind, the one it is at, and the ones ahead', () => {
    const steps = orderTimeline({
      status: 'confirmed',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'confirmed', at: at(2) },
      ],
    });
    expect(steps.map(({ status, state }) => [status, state])).toEqual([
      ['pending', 'done'],
      ['confirmed', 'current'],
      ['packed', 'later'],
      ['shipped', 'later'],
      ['delivered', 'later'],
    ]);
    expect(steps[1]?.at).toBe(at(2));
    expect(steps[2]?.at).toBeNull();
  });

  it('draws a delivered order as all done', () => {
    const steps = orderTimeline({
      status: 'delivered',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'shipped', at: at(30) },
        { status: 'delivered', at: at(50) },
      ],
    });
    expect(steps.every((step) => step.state === 'done')).toBe(true);
    // Skipped steps are behind it, with no date
    expect(steps.find((step) => step.status === 'packed')?.at).toBeNull();
  });

  it('ends a cancelled order on the cancel, with nothing ahead', () => {
    const steps = orderTimeline({
      status: 'cancelled',
      history: [
        { status: 'pending', at: at(0) },
        { status: 'confirmed', at: at(2) },
        { status: 'cancelled', at: at(9) },
      ],
    });
    expect(steps.map(({ status, state }) => [status, state])).toEqual([
      ['pending', 'done'],
      ['confirmed', 'done'],
      ['cancelled', 'current'],
    ]);
  });
});
```

- **`codeDigits`** with a space, Bangla digits and a whole SMS sentence. Without the Bangla step it fails (tried).
- **`waitText`** rounds 9.2 seconds up to "0:10" and never goes below zero.
- **`orderTimeline`**: a confirmed order (done, current, three later), a delivered order with skipped steps (all
  done, the skipped one without a date), and a cancelled one (no steps ahead). Drawing delivered as current fails
  the second (tried).

### Check this part

```bash
pnpm install
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test
pnpm exec eslint apps/shop/src packages/i18n/src
pnpm boundaries
pnpm --filter @omnivo/shop build
```

The shop has 113 tests. The verify page's script is 2.1 KB gzipped and the dialog's 0.7 KB. Only `/checkout` loads
React, as before.

Then try it in a browser on the built server (`HOST=127.0.0.1 PORT=4399 node apps/shop/dist/server/entry.mjs`). The
mock keeps orders in memory, so restarting the server forgets them (and `/order/W-000001` is then a 404):

1. Put the neem face wash in the cart three times (৳687), fill the checkout, pick Cash on Delivery, confirm. The
   verify page says "+880 17•• ••• 356", shows the test code, and "Resend code in 0:45" counts down.
2. Type `১২৩`: the box shows `123`. Confirm: "Type the 6 digits from the SMS."
3. Type `000000`, confirm: "That code is wrong… 4 tries left.", the box is empty and has the focus.
4. Add something to the cart in another tab, then reload the verify page: the wait is what is left, not 45 again.
5. Type `123456`: "Order Confirmed" opens with "…by SMS to 01786 120356.", the focus on "Continue shopping". The cart
   now holds only what was added in step 4.
6. "View Order Details": `/order/W-000001` with the timeline (Order placed and Confirmed done, three ahead), the
   delivery details and ৳767. The same address in a private window: 404.
7. Place another Cash on Delivery order and type a wrong code five times: "Too many wrong codes…", the form goes,
   "Back to checkout" has the focus, the cart is kept. Open `/checkout/verify` again: it goes to `/checkout`.
8. Pick Mobile Banking and confirm: the dialog opens over the checkout. Press Escape: the home page.
9. Wait 45 seconds on a verify page and press "Resend code": "A new code is on its way.", and the wait starts again.
10. At 390px wide: the verify page, the dialog (358px wide) and the order page do not scroll sideways.

Broken on purpose while writing this part, and caught: the delivered step drawn as current, `codeDigits` without the
Bangla step, `codeWait` without `listingIds` (a type error in `orders.ts`), a component importing `server/cookies.ts`,
a page importing `server/orders.ts`, and the dialog's script importing a schema from `@omnivo/contracts`.

## 26c.6 — Doc updates

After you implement this (ask me and I can do these). Only `CLAUDE.md` changes: the system design already has the
shop's orders, the phone code and the order page (§14.3–14.4), and the build plan's step 26 is ticked only when step
26's API is done.

**CLAUDE.md** — in "Storefront design system":

1. At the end of "What still applies from the rest of this file", add: "Pages are Astro with small scripts; the
   checkout form is the only React island, and it gets its words from the server as props (no i18next in the
   browser)."
2. In "Storefront typography", at the end of the **Family** bullet, add: "Order numbers use `Geist Mono`
   (self-hosted, `--font-mono`), as in the app."
3. In **Checkout card**, replace "Body: 36px padding, 32px between blocks." with "Body: 36px from the card's edge
   (36px under the header, and 32px inside the 4px inset at the sides and the bottom), 32px between blocks, except
   36px before the lines and 48px around the promo box and the payment cards. Every gap is measured between trimmed
   text boxes (`trim-text`). The card ends 160px above the footer." After "…the zones come from the shop's
   settings)", add: "No location is picked at first: until one is, the Delivery Charge row says "Pick a location"
   in `muted`."
4. In **Checkout lines**:
   - after "…then the name (`sf-subtitle`, `brand`, max 288px) and 20px below it the stepper", add "(the name and the
     stepper centered beside the image)";
   - replace "1px `rule` lines above and below the Delivery Charge row (16px/600 `brand`, amount right)." with "1px
     `rule` lines above and below the Delivery Charge row (16px/600 `brand`, amount right), the first 30px under the
     lines. While a coupon is applied, a Discount row ("Discount (WELCOME10)", the amount after a minus sign) sits
     above it inside the same rules, 24px apart.";
   - replace "the link underlined, 12px apart" with "the link underlined (it opens in a new tab), 12px apart";
   - replace "disabled until the terms are ticked." with "disabled until the terms are ticked, while newer prices
     load, with an out-of-stock line, and under the shop's minimum order (a `promo` line under Total says how much
     more to add)."
5. In **Phone verification**, replace "A wrong code shows an `Alert02` line in `promo` under the input." with "A
   wrong code shows an `Alert02` line in `promo` under the input, with the tries left. After 5 wrong codes the order
   is dropped: the box goes and "Back to checkout" takes its place (the cart is kept). The page finds its order by an
   httpOnly cookie, never by the number, and with no order waiting it goes to `/checkout`. The mock shows its test
   code in a line under the sentence."
6. In **Order details**, replace "and the lines and totals as in checkout, read-only (no stepper, no delete)." with
   "and the lines and totals as in checkout, read-only (no stepper, no delete; "150ml · 2 × ৳229" under the name),
   with a Subtotal row above Delivery Charge. Only the browser that placed the order sees it (a cookie); anyone else
   gets page not found."

---

## 26c.7 — Run it and check it

```bash
pnpm install
pnpm --filter @omnivo/contracts build && pnpm --filter @omnivo/i18n build   # the shop reads their dist/
pnpm --filter @omnivo/shop typecheck      # astro check: 0 errors, 0 warnings, 0 hints
pnpm --filter @omnivo/shop test           # 113 tests in 12 files
pnpm --filter @omnivo/shop dev            # http://localhost:4321
```

To run it the way it will run on a server:

```bash
pnpm --filter @omnivo/shop build
pnpm --filter @omnivo/shop start          # node dist/server/entry.mjs, http://localhost:4321
```

The mock keeps orders in memory: restarting the server forgets them, and the next order is `W-000001` again.

Then, for the whole repo (the step changed two shared packages):

```bash
pnpm dedupe --check
pnpm typecheck
pnpm lint
pnpm format
pnpm test                 # 1,100: contracts 456 + app 210 + api 156 + sync 118 + shop 113 + ui 22 + i18n 17 + auth 8
pnpm boundaries
pnpm build
pnpm test:bundle-size     # the ERP app's first load 233.3 KB gz (budget 235): the shop's words are in en.ts
pnpm test:openapi         # up to date: the storefront schemas are not in the ERP's API
```

### What you should see

Put two neem face washes in the cart (on `/p/himalaya-purifying-neem-face-wash-150ml`), then open `/checkout` at
1440px wide next to Figma's `checkout_process`:

- [ ] The card under the header, "Shipping & Contact Details" on cream. Full Name and Mobile Number side by side,
      Delivery Address, Delivery Location with two cream cards and no card picked, "Free delivery on orders over
      ৳1,000" under them.
- [ ] The line: the photo on grey, the name in two lines, the stepper at 2, the red delete button, ৳458 on the right.
      Delivery Charge says "Pick a location"; Total ৳458.
- [ ] Pick Outside Dhaka: Delivery Charge ৳120, Total ৳578 (grey for a moment while the server answers).
- [ ] "Add Promo" with the teal "Apply Coupon" inside it. Type `welcome10` and press Enter: "WELCOME10 applied: 10%
      off", a Discount row, "Discount (WELCOME10)" and −৳45.80, Total ৳532.20 (an amount with paisa shows them).
      "Remove the code" takes it away.
- [ ] Payment Method: Cash on Delivery picked, Mobile Banking. The terms box, and a grey Confirm Order until it is
      ticked.
- [ ] Fill the form, Cash on Delivery, Confirm Order: `/checkout/verify`, "We sent a 6-digit code to +880 17•• •••
      356", the test code line, "Resend code in 0:45" counting down.
- [ ] Type `123456`: "Order Confirmed" over the page, "…by SMS to 01786 120356.", the focus on "Continue shopping".
- [ ] "View Order Details": `/order/W-000001` in Geist Mono, the timeline (placed and confirmed done), the delivery
      details, the line with "150ml · 2 × ৳229", Subtotal ৳458, Delivery Charge ৳120, Total ৳578. The same address
      in a private window: page not found.
- [ ] Back to a product, then checkout with Mobile Banking: the dialog opens over the checkout at once, and Escape
      goes to the home page with an empty cart.

At 390px wide: one column, the drawer-sized photo, the dialog 358px wide, and nothing scrolls sideways on any of the
three pages. With `language: 'bn'` in `src/data/mock/shop.ts`, every page and the dialog are Bangla (the zone names
stay as the shop wrote them: they are the shop's data).

### Known differences from Figma

- **"Free delivery on orders over ৳1,000"** under Delivery Location is not in Figma (`CLAUDE.md` has it). Everything
  under it is 22px lower than in Figma.
- **Payment Method has two cards**, not Figma's three under "Delivery Method" (decision 14).
- **No location is picked at first** (decision 22); Figma shows Outside Dhaka picked.
- **A Discount row** appears while a coupon is applied (decision 15); Figma has none.
- **Text sits a fraction of a pixel off**, from Geist in place of Roboto: about half a pixel per trimmed label, 3px by
  the end of the card.
- **The cart icon and "Account"** in the header, in place of Figma's bell and a name, as in 26a.
- **The verify page and the order page** are not in Figma; they follow `CLAUDE.md` and decision 38. Nor are the
  phone layouts: Figma has no phone frames for these screens.

## What comes next

- **26d — the rest:** the category and search pages with the chip menus, filters, sort and Load More's "Loading"
  state; `/track` (with the order page's timeline from `lib/order-timeline.ts`); the text pages (the terms link of the
  checkout goes to `/pages/terms`); the empty states and the "page not found" page; the first Playwright tests for the
  whole shop, including this checkout.
- **Watch the ERP's bundle budget.** The shop's words live in `packages/i18n/src/locales/en.ts`, which the ERP app
  loads at start: its first load is 233.3 KB gz of the 235 KB budget after this step. 26d adds more shop words, so it
  needs a decision first: move the shop's words out of the app's first load, or raise the budget.
- **Step 26's real place in the plan:** the `storefront` module in the API and `/public/v1`; the orders in
  `storefront_orders` with the 60-minute stock hold; the SMS; a confirmed order turned into a sales order; one
  `ShopSource` that calls the API in place of the mock. The browser's requests stay as they are now.
