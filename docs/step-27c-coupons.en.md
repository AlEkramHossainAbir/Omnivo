# Step 27c: Checkout and orders, part 3 — coupons

> The implementation guide for "Phase 10 → Step 27", the third part, of [build-plan.bn.md](build-plan.bn.md). Step
> 27 has four parts:
>
> - **27a:** orders in the database, the stock they hold, the phone code by SMS, the tracking link and the API's
>   limits ([step-27a-shop-orders.en.md](step-27a-shop-orders.en.md)).
> - **27b:** the ERP's Storefront → Shop orders screens and the ERP documents an order makes
>   ([step-27b-shop-orders-erp.en.md](step-27b-shop-orders-erp.en.md)).
> - **27c (this guide):** the shop's coupons: the ERP's Coupons page, the quote that applies a code, and the
>   discount on the sales order.
> - **27d:** online payment with SSLCommerz, with the shop's own encrypted credentials.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `37b9f21`, "shop order done")
> and checked on 2026-11-19: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (1,516, of them 650 in `packages/contracts`, 251 in `apps/shop`, 239 in `apps/app` and 207 in `apps/api`),
> `pnpm test:integration` (857 in 50 files) and `pnpm test:tenant-leak` (176 in 25 files) on Testcontainers,
> `pnpm boundaries`, `pnpm test:bundle-size` (first load 244.7 KB gz, budget 245; the Coupons page 133.3 KB and its
> form 131.2 KB, budget 155), `pnpm test:openapi` (after 27c.8's `gen:openapi`), the app's Playwright suite on a
> computer and on a phone (all 471 that run pass; two timed out while the machine was busy and passed when run again
> on their own), the PWA suite (4) and the shop's Playwright tests (44, 2 skipped on purpose, as before), all clean.
> Ten integration and tenant-leak files (none of them changed by this guide) timed out in the whole run, with the
> machine's load above 30, and passed when run again on their own (148 tests). `pnpm lint` runs out of its 6 GB of
> memory on the whole repo on this machine (8 GB), so ESLint ran folder by folder with the same config (`apps/api`,
> `apps/app`, `apps/shop`, `packages` and the root's config files): no errors. The migrations were also checked on a
> throwaway Postgres with their own script (27c.2).
>
> Also checked:
>
> - **The whole way on the real API** (27c.8): throwaway Postgres, Valkey, Mailpit and MinIO, the built API and
>   worker, `pnpm seed:shop`, the built shop with `SHOP_SOURCE=api`, and a production build of the app. `smoke10`
>   was made on the Coupons page (10% off, up to ৳50, 2 orders, once per mobile number) and saved as `SMOKE10`. In
>   the shop, two shampoos and a face wash (৳617) with Inside Dhaka came to ৳647 with the code (৳61.70 cut to ৳50).
>   `W-000001` was placed with the code from Mailpit; the worker's sales order had ৳37.12 and ৳12.88 off the goods
>   lines and nothing off the delivery line, a total of ৳647.00 like the shop's. The same number was refused at
>   Confirm Order with the checkout's words; a second number took the last use (`W-000002`); a third got "used as
>   many times as the shop allows". The page said "2 of 2 used" and showed the code locked. Cancelling `W-000002`
>   gave the use back ("1 of 2 used", and the third number got the discount). `W-000001` packed, shipped and
>   delivered posted an invoice of ৳647.00 with the same discounts. Archived, the code was "does not exist" in the
>   shop. The page did not scroll sideways at 390px, no stock was held, the journal's debits and credits were equal,
>   and the audit log had the coupon's created and archived rows only (orders add none).
> - **Broken on purpose** while the parts were written, each caught by a test: the not-started check, the spread's
>   largest remainder, the database's code guard, the hold window in the use count, the archived policy, the shop's
>   role allowed to change a discount, the use count as SECURITY INVOKER, the invoice's share given to one line, the
>   quote without its "up to", once per number turned off (API and mock), the count read before the lock (the race
>   for the last use), the spread by unit price, a cancelled order counted, the tenant filter and FORCE RLS off
>   together, a Bangla word missing, a status pill missing, and the row menu's click guard. Each part's "Check this
>   part" lists them.

## Goal

🏷️ **A coupon code takes money off a shop order, and the books agree to the paisa.** Until now the shop's promo box
answers "This code does not exist" to every code, because the ERP has no coupons. After 27c the tenant makes coupons
in Storefront → Coupons ("WELCOME10: 10% off, up to ৳200, once per mobile number"; "FLAT50: ৳50 off orders of ৳500
or more"), the shop's quote applies them, the order keeps the code and what it took off, and the sales order the
worker makes for the order spreads that discount over its lines, so the ERP's total is still the shop's total.

## Decisions

Agreed with the user on 2026-11-19 (all eleven as recommended). Decisions 6–10 are about online payment and are done
in 27d; they are kept here so the numbers match the discussion.

1. **Two guides:** 27c coupons, 27d SSLCommerz. Each has its own contracts, database, API, ERP screens and shop work;
   one guide for both would be bigger than 27b's.
2. **One table of coupons, for the whole cart.** A coupon has a code (one per workspace, upper case), a percent
   (with an optional "up to") or an amount, an optional minimum for the items, an optional first and last day (whole
   days in the workspace's time zone, both included), an optional number of orders, and an optional "once per mobile
   number". Once an order has the code it can't change, and a coupon is never deleted, only archived. Coupons for
   one product or one category can come later.
3. **A use counts from the moment the order is placed:** the orders that wait for their phone code and the confirmed
   ones, not the cancelled ones (a cancel gives the use back). The limit is checked with the coupon's row locked, so
   two shoppers cannot both take the last use. Two new refusals: `shop_coupon_used_up` in the quote, and
   `shop_coupon_used_by_phone` when the order is placed (only then is the phone known). A coupon that has not started
   yet answers "unknown", so the promo box does not announce a sale early. Counting at confirm would tell a shopper
   "used up" after they typed the phone code.
4. **The discount is spread over the goods lines** of the sales order as amount discounts, in proportion to each
   line's total, to the paisa, with the largest remainder rule for the paisa left over. Never on the delivery line.
   The sales order, the challan and the invoice then add up to the shop's total. Giving every sales document a
   discount of its own for the whole document would change steps 15b–15d; this changes nothing there.
5. **An ERP page, Storefront → Coupons** (`storefront.manage`): a data table (code, discount, minimum, days, "12 of
   100 used", status) and a dialog form. A mockup comes before the screens.
6. *(27d)* A `PaymentGateway` interface with an SSLCommerz gateway and a fake gateway for development and CI.
7. *(27d)* The gateway's credentials encrypted with AES-256-GCM and a new `CREDENTIALS_KEY`; "Test connection".
8. *(27d)* An online order needs no phone code; SSLCommerz's calls land on the shop; the API checks each payment
   with SSLCommerz itself; one row per payment attempt.
9. *(27d)* A paid order gets a posted money receipt (an advance) into a clearing account, applied when the invoice
   posts.
10. *(27d)* A paid order that is cancelled is refunded by hand in SSLCommerz, then recorded with "Record refund".
11. *(27d)* "Mobile Banking" becomes "Pay online".

Mine, made while writing (each explained where its code is):

12. **`spreadMoney` in `money.ts`** shares a value over weights to the paisa with the largest remainder rule, and
    throws on anything it cannot share exactly (27c.1).
13. **A coupon's amounts are to the paisa** (2 decimals, like a sales line's discount), so the spread never meets a
    fraction of a paisa (27c.1).
14. **The rule lives in the contracts** (`judgeShopCoupon`, `shopCouponDiscount`): the API's quote and the mock shop
    judge a code with the same functions (27c.1).
15. **The reasons go from "no such code" to "not any more" to "not for this cart":** unknown, expired, used up,
    minimum (27c.1).
16. **`codeLocked` is its own field:** any order ever placed with the code locks it, a cancelled one too, while
    `used` counts only the orders that hold a use now (27c.1).
17. **The form has a kind select and one value box**, and refuses a zero minimum or "up to" instead of reading it as
    "none" (the empty box says none). The listings' sale words are reused for the percent and the zero (27c.1).
18. **No delete:** archive and restore, with two tabs (Current, Archived), newest first, searched by part of the code
    (27c.1).

## 27c.1 — Contracts

Everything about a coupon that both sides must agree on: what a code does to a cart, how the discount is shared over
the sales order's lines, and what the ERP's Coupons page reads and sends. Plus the shop's two new refusals, the
form's error codes and the audit actions.

### Sharing a value to the paisa

```diff
@@ -144,6 +144,47 @@ export function splitMoney(value: string, count: number): string[] {
   );
 }
 
+// A value shared over a few weights in proportion, to the paisa, so the pieces add up to the value
+// exactly (step 27c: a coupon's ৳100 over lines of ৳300 and ৳200 is ৳60 and ৳40). Each weight gets
+// its share rounded down; the paisa that rounding left over go one each to the weights whose share
+// lost the most, the earlier one first on a tie (the largest remainder rule). So a piece is never
+// more than its weight, as long as the value is not more than all the weights together: a coupon
+// never takes more off a line than the line costs. The value and the weights are whole paisa (a
+// coupon's discount and the lines' totals are), the weights positive.
+export function spreadMoney(value: string, weights: readonly string[]): string[] {
+  const valuePaisa = paisaOf(value);
+  const weightPaisa = weights.map(paisaOf);
+  if (weightPaisa.some((weight) => weight <= 0n)) throw new Error('Every weight must be positive');
+  const whole = weightPaisa.reduce((sum, weight) => sum + weight, 0n);
+  if (valuePaisa < 0n || valuePaisa > whole) {
+    throw new Error(`Cannot spread "${value}" over weights worth less`);
+  }
+  const shares = weightPaisa.map((weight) => ({
+    paisa: (valuePaisa * weight) / whole,
+    remainder: (valuePaisa * weight) % whole,
+  }));
+  let left = valuePaisa - shares.reduce((sum, share) => sum + share.paisa, 0n);
+  // Largest remainder first. sort() is stable, so equal remainders keep the lines' order. Fewer
+  // paisa are left than there are weights, so one round is always enough
+  const byRemainder = [...shares].sort((a, b) =>
+    a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1,
+  );
+  for (const share of byRemainder) {
+    if (left === 0n) break;
+    share.paisa += 1n;
+    left -= 1n;
+  }
+  return shares.map((share) => fromUnits(share.paisa * PAISA));
+}
+
+// A whole number of paisa, or an error: spreadMoney works in paisa, and a value with a fraction of
+// a paisa would lose it without anyone noticing
+function paisaOf(value: string): bigint {
+  const units = toUnits(value);
+  if (units % PAISA !== 0n) throw new Error(`Not a whole number of paisa: "${value}"`);
+  return units / PAISA;
+}
+
 // What one unit costs: value ÷ quantity, to 4 decimals (৳1,000 for 3 pieces = ৳333.3333). The
 // quantity must be positive.
 export function unitCostOf(value: string, quantity: string): string {
```

`spreadMoney(value, weights)` is what the sales order maker (27c.3) calls with the coupon's discount and the goods
lines' totals (decision 4). Why each part is written this way:

- **It works in whole paisa (`paisaOf`).** A sales line's discount has at most 2 decimals (`discountSchema` in
  `sales.ts`), so a share of `0.0033` could not be saved. The coupon's discount is always whole paisa (decision 13,
  and `percentOfMoney` rounds to the paisa), and so are the lines' totals (`multiplyMoney` rounds to the paisa). A
  value with a fraction of a paisa is a bug somewhere else, so it throws instead of losing the fraction quietly.
- **Rounded down first, then the largest remainder.** Rounding every share to the nearest paisa can miss the total
  by a paisa or two (three shares of ৳3.333… are ৳9.99). Rounding down always leaves 0 to `weights.length − 1` paisa
  over; giving them one each to the shares that lost the most makes the sum exact and keeps every share within a
  paisa of its true value. `splitMoney` (step 14) puts the rest on the last piece instead, which is fine for equal
  pieces but not for a ৳2 line next to a ৳2,000 one.
- **A share never passes its weight.** A share only gets a paisa when it was rounded down, so it never goes above
  its exact value rounded up, which is at most the weight. With the value at most the weights' sum (checked), no
  line ends with a negative amount. `shopCouponDiscount` below makes sure the discount is never more than the items.
- **A stable sort keeps ties in the lines' order**, so the same order always gets the same split: the shop's order
  page and the sales order never disagree from one run to the next.
- **Zero or negative weights throw:** a line worth nothing cannot carry a share, and the maker never passes the
  delivery line (decision 4).

```diff
@@ -15,6 +15,7 @@ import {
   percentOfWhole,
   prorateMoney,
   splitMoney,
+  spreadMoney,
   subtractMoney,
   sumMoney,
   unitCostOf,
@@ -82,6 +83,27 @@ describe('money', () => {
     expect(splitMoney('5', 1)).toEqual(['5.0000']);
   });
 
+  it('spreads a value over weights in proportion, to the paisa, adding up exactly', () => {
+    expect(spreadMoney('100', ['300', '200'])).toEqual(['60.0000', '40.0000']);
+    // ৳10 over three equal lines: 3.33 each, and the paisa left over goes to the first
+    expect(spreadMoney('10', ['50', '50', '50'])).toEqual(['3.3400', '3.3300', '3.3300']);
+    // The largest remainder wins the paisa, not the first line: 0.05 × 2/3 = 0.0333… and
+    // 0.05 × 1/3 = 0.0166…, so the second share lost more to rounding down (0.0066… > 0.0033…)
+    expect(spreadMoney('0.05', ['2', '1'])).toEqual(['0.0300', '0.0200']);
+    const pieces = spreadMoney('57.89', ['229', '1.50', '999.99', '48.25']);
+    expect(sumMoney(pieces)).toBe('57.8900');
+    // The whole value over the weights takes each weight exactly; nothing takes nothing
+    expect(spreadMoney('230.50', ['229', '1.50'])).toEqual(['229.0000', '1.5000']);
+    expect(spreadMoney('0', ['229', '1.50'])).toEqual(['0.0000', '0.0000']);
+  });
+
+  it('refuses to spread more than the weights, a fraction of a paisa, or over nothing', () => {
+    expect(() => spreadMoney('231', ['229', '1.50'])).toThrow();
+    expect(() => spreadMoney('10.005', ['229'])).toThrow();
+    expect(() => spreadMoney('10', ['229', '0'])).toThrow();
+    expect(() => spreadMoney('10', [])).toThrow();
+  });
+
   it('works out a unit cost to 4 decimals', () => {
     expect(unitCostOf('1000', '3')).toBe('333.3333');
     expect(unitCostOf('8.512', '10')).toBe('0.8512');
```

The tests: an exact split, a three-way tie (the first line gets the paisa), a case where the second line wins the
paisa because its share lost more to rounding, a sum check with odd amounts, the whole value and nothing, and the four
refusals.

### The shop's side: the code, the refusals and "up to"

```diff
@@ -252,9 +252,11 @@ const zoneIdSchema = z.string().min(1).max(32);
 
 // A coupon code as the shopper typed it. Trimmed and upper-cased here, so " welcome10 " and
 // "WELCOME10" are one code, and the server never compares two spellings of it. Letters, digits and
-// dashes only: a code is printed on a flyer and typed on a phone
+// dashes only: a code is printed on a flyer and typed on a phone. Step 27c: exported, because the
+// ERP's coupon form saves a code with the same rule (storefront-coupons.ts), so a code the tenant
+// saves is always one a shopper can type
 export const SHOP_COUPON_MAX_LENGTH = 20;
-const couponCodeSchema = z
+export const shopCouponCodeSchema = z
   .string()
   .trim()
   .toUpperCase()
@@ -267,7 +269,7 @@ const couponCodeSchema = z
 export const shopCartQuoteRequestSchema = z.object({
   lines: cartLinesSchema,
   zoneId: zoneIdSchema.optional(),
-  couponCode: couponCodeSchema.optional(),
+  couponCode: shopCouponCodeSchema.optional(),
 });
 
 // The parts of a listing a cart line draws: the 96×80 image box, the name (a link to its page) and
@@ -304,21 +306,33 @@ export const shopCartQuoteLineSchema = z.discriminatedUnion('status', [
 // the cart is still priced, and the promo box says why the code did nothing.
 // - none: no code was sent
 // - applied: the code took money off; `discount` says how, so the promo box can say "10% off" or
-//   "৳50 off" next to the code
+//   "৳50 off" next to the code. Step 27c: `upTo` is the most a percent coupon takes off ("10%
+//   off, up to ৳200"); null for an amount, or a percent with no such limit
 // - refused: the code did nothing. `reason` is an error code the promo box turns into words:
 //   unknown (no such code), expired (its last day has passed) or below its minimum (the items
-//   are worth less than `minimum`, which the words name)
+//   are worth less than `minimum`, which the words name). Step 27c adds used up: the tenant
+//   allowed it a number of orders, and that many have it. A code that starts on a later day is
+//   unknown, so a sale the tenant has not announced yet does not leak through the promo box
+export const SHOP_COUPON_REFUSALS = [
+  'shop_coupon_unknown',
+  'shop_coupon_expired',
+  'shop_coupon_used_up',
+  'shop_coupon_minimum',
+] as const;
+export type ShopCouponRefusal = (typeof SHOP_COUPON_REFUSALS)[number];
+
 export const shopCouponResultSchema = z.discriminatedUnion('status', [
   z.object({ status: z.literal('none') }),
   z.object({
     status: z.literal('applied'),
-    code: couponCodeSchema,
+    code: shopCouponCodeSchema,
     discount: shopDiscountSchema,
+    upTo: shopMoneySchema.nullable(),
   }),
   z.object({
     status: z.literal('refused'),
-    code: couponCodeSchema,
-    reason: z.enum(['shop_coupon_unknown', 'shop_coupon_expired', 'shop_coupon_minimum']),
+    code: shopCouponCodeSchema,
+    reason: z.enum(SHOP_COUPON_REFUSALS),
     // Only for shop_coupon_minimum: "Add ৳120 more to use this code" needs the amount
     minimum: shopMoneySchema.nullable(),
   }),
@@ -413,7 +427,7 @@ export const shopPhoneSchema = z
 export const shopOrderRequestSchema = z.object({
   lines: cartLinesSchema.min(1, errorCode('shop_cart_empty')),
   zoneId: zoneIdSchema,
-  couponCode: couponCodeSchema.optional(),
+  couponCode: shopCouponCodeSchema.optional(),
   name: z.string().trim().min(1, errorCode('required')).max(80, errorCode('too_long')),
   phone: shopPhoneSchema,
   // Long enough for "House 12, Road 5, Block C, Mirpur 10, Dhaka", short enough for a label
@@ -548,7 +562,7 @@ export const shopOrderSchema = z.object({
   lines: z.array(shopOrderLineSchema).min(1),
   subtotal: shopMoneySchema,
   discount: shopMoneySchema,
-  couponCode: couponCodeSchema.nullable(),
+  couponCode: shopCouponCodeSchema.nullable(),
   deliveryCharge: shopMoneySchema,
   total: shopMoneySchema,
 });
```

- `shopCouponCodeSchema` is exported, renamed from `couponCodeSchema` to match the other `shop*` exports. The ERP's
  form saves a code with the same rule, so every saved code is one a shopper can type: upper case, letters, digits
  and dashes, at most 20.
- `SHOP_COUPON_REFUSALS` adds `shop_coupon_used_up` (decision 3). A list, not four literals inside `z.enum`, so the
  shop's promo box can map every reason to words with `satisfies Record<ShopCouponRefusal, string>` and a fifth
  reason later fails the type check there.
- `upTo` on the applied answer: the promo box says "10% off, up to ৳200". It is `nullable`, not optional, so the
  quote always says it, and the mock and the API cannot drift apart by leaving it out.
- `shop_coupon_used_by_phone` is not a quote refusal: the quote never knows the phone. It is an error of Confirm
  Order, in the error codes below.

### The rule

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { compareMoney, isZeroMoney, percentOfMoney, sumMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { optionalDateSchema } from './stock.js';
import {
  SHOP_COUPON_MAX_LENGTH,
  shopCouponCodeSchema,
  shopDiscountSchema,
  type ShopCouponResult,
  type ShopDiscount,
} from './storefront.js';

// Step 27c: the shop's coupons. Two halves:
// - the rule: what a code does to a cart. The API's quote and the mock shop (apps/shop, step 26c)
//   both judge a code with the functions below, so the mock can never promise what the real shop
//   refuses
// - the ERP's Coupons page (Storefront → Coupons, storefront.manage): the list, the form and the
//   routes
// A coupon takes money off the items of the whole cart (decision 2), never off the delivery
// charge, and the free delivery and the minimum order still look at the items before the coupon
// (step 26c's decision 8).

// ---------------------------------------------------------------------------------------------
// The rule

// A coupon as the quote needs it. The API reads it from storefront_coupons; the mock keeps a few
// in memory. An archived coupon is never passed in: to the shopper it does not exist.
// - discount: "10% off" or "৳50 off" (the listings' ShopDiscount: a whole percent, or taka)
// - upTo: the most a percent coupon takes off ("10%, up to ৳200"); null = no limit. Always null
//   for an amount, which is its own limit
// - minimum: the items must be worth at least this much; null = any amount
// - startsOn / lastDay: the first and the last day it works, in the shop's time zone (ISO dates,
//   both days included); null = from now on / for good
// - usageLimit: how many orders may have it; null = as many as come
// - onePerPhone: one order per mobile number. The quote cannot check it (the shopper has not typed
//   a phone yet), so the order checks it when it is placed (shop_coupon_used_by_phone)
export interface ShopCouponRule {
  code: string;
  discount: ShopDiscount;
  upTo: string | null;
  minimum: string | null;
  startsOn: string | null;
  lastDay: string | null;
  usageLimit: number | null;
  onePerPhone: boolean;
}

// What the quote knows besides the coupon: the items' worth before the coupon, today in the shop's
// time zone (todayIn() in numbering.ts), and how many orders have the coupon now (decision 3: the
// orders waiting for their phone code count too, so the last use cannot go to two shoppers)
export interface ShopCouponCheck {
  subtotal: string;
  today: string;
  used: number;
}

// What a code does to a cart. `rule` is the coupon with that code, or undefined when the shop has
// none (or only an archived one). A code that does not apply is an answer, never an error (step
// 26c's decision 9). The checks go from "no such code" to "not any more" to "not for this cart", so
// the reason given is the one that matters most: a shopper with an expired code should not be told
// to add items first. ISO dates compare correctly as strings.
export function judgeShopCoupon(
  code: string | undefined,
  rule: ShopCouponRule | undefined,
  check: ShopCouponCheck,
): ShopCouponResult {
  if (code === undefined) return { status: 'none' };
  // Not started yet is "unknown" (decision 3): the promo box must not announce a sale early
  if (rule === undefined || (rule.startsOn !== null && check.today < rule.startsOn)) {
    return { status: 'refused', code, reason: 'shop_coupon_unknown', minimum: null };
  }
  if (rule.lastDay !== null && check.today > rule.lastDay) {
    return { status: 'refused', code, reason: 'shop_coupon_expired', minimum: null };
  }
  if (rule.usageLimit !== null && check.used >= rule.usageLimit) {
    return { status: 'refused', code, reason: 'shop_coupon_used_up', minimum: null };
  }
  if (rule.minimum !== null && compareMoney(check.subtotal, rule.minimum) < 0) {
    return { status: 'refused', code, reason: 'shop_coupon_minimum', minimum: rule.minimum };
  }
  return { status: 'applied', code, discount: rule.discount, upTo: rule.upTo };
}

// What an applied coupon takes off the items, to the paisa. A percent is of the items' worth, cut
// to `upTo`; an amount is the amount. Neither takes off more than the items cost: ৳50 off a ৳30
// cart is ৳30 off, so the total never goes below the delivery charge, and spreadMoney() can share
// the discount over the lines without a line going below zero.
export function shopCouponDiscount(
  applied: { discount: ShopDiscount; upTo: string | null },
  subtotal: string,
): string {
  let discount =
    applied.discount.kind === 'percent'
      ? percentOfMoney(subtotal, String(applied.discount.value))
      : sumMoney([applied.discount.value]);
  if (applied.upTo !== null && compareMoney(discount, applied.upTo) > 0) {
    discount = sumMoney([applied.upTo]);
  }
  return compareMoney(discount, subtotal) > 0 ? sumMoney([subtotal]) : discount;
}
```

- **`ShopCouponRule`** is the coupon as the quote needs it. It uses the listings' `ShopDiscount` (a whole percent as
  a number, or taka as a string), so the promo box draws a coupon's discount with the code it already has for a
  sale.
- **`ShopCouponCheck.used`** is passed in, not counted here: the API counts it in the database with the coupon's row
  locked (27c.3), and the mock counts its own orders.
- **`judgeShopCoupon`** goes through the reasons in the order of decision 15. The order matters: a shopper with an
  expired code who is told "add ৳120 more" would add the items and then hear the code is expired. A code that has
  not started is `unknown`, not a new reason, so nobody learns of next week's sale by guessing codes (decision 3).
  ISO dates (`2026-11-19`) compare correctly as strings, and the caller passes today in the shop's time zone, so at
  1 am on 1 December in Dhaka a code that ended on 30 November has ended, although it is still 30 November in UTC.
- **`shopCouponDiscount`** applies "up to" after the percent, then caps everything at the items' worth. The cap is
  what keeps `spreadMoney`'s precondition true and the total never below the delivery charge (step 26c's rule). The
  answers are `sumMoney`'d so they always have the 4 decimals the database sends, and two results compare as plain
  strings in tests.

### The ERP's list

```ts

// ---------------------------------------------------------------------------------------------
// The ERP's coupons

export const SHOP_COUPON_KINDS = ['percent', 'amount'] as const;
export type ShopCouponKind = (typeof SHOP_COUPON_KINDS)[number];

// How many orders a coupon may be allowed: a big number, but a number (the column is an integer,
// and a typo of nine digits is a mistake, not a plan)
export const STOREFRONT_COUPON_MAX_USES = 1_000_000;

// What the list's status pill says, worked out by the API from the dates, the uses and the
// archive (storefrontCouponStatus below):
// - scheduled: its first day is later (brand)
// - active: a shopper can use it today (good)
// - ended: its last day has passed, or every use is taken (neutral)
// - archived: the tenant took it away (neutral)
export const STOREFRONT_COUPON_STATUSES = ['active', 'scheduled', 'ended', 'archived'] as const;
export type StorefrontCouponStatus = (typeof STOREFRONT_COUPON_STATUSES)[number];

export function storefrontCouponStatus(
  coupon: {
    archivedAt: string | null;
    startsOn: string | null;
    lastDay: string | null;
    usageLimit: number | null;
    used: number;
  },
  today: string,
): StorefrontCouponStatus {
  if (coupon.archivedAt !== null) return 'archived';
  if (coupon.lastDay !== null && today > coupon.lastDay) return 'ended';
  if (coupon.usageLimit !== null && coupon.used >= coupon.usageLimit) return 'ended';
  if (coupon.startsOn !== null && today < coupon.startsOn) return 'scheduled';
  return 'active';
}

// The list's two tabs: the coupons in play (active, scheduled and ended ones) and the archived
export const STOREFRONT_COUPON_VIEWS = ['current', 'archived'] as const;
export type StorefrontCouponView = (typeof STOREFRONT_COUPON_VIEWS)[number];

// Newest first, paged: a shop that runs a coupon a week has hundreds after a few years
export const storefrontCouponQuerySchema = pageQuerySchema.extend({
  // Part of the code: "WEL" finds WELCOME10. Upper-cased like the code itself
  search: z.string().trim().toUpperCase().max(SHOP_COUPON_MAX_LENGTH).optional(),
  view: z.enum(STOREFRONT_COUPON_VIEWS).default('current'),
});
export type StorefrontCouponQuery = z.input<typeof storefrontCouponQuerySchema>;

export const storefrontCouponSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  discount: shopDiscountSchema,
  upTo: z.string().nullable(),
  minimum: z.string().nullable(),
  startsOn: z.iso.date().nullable(),
  lastDay: z.iso.date().nullable(),
  usageLimit: z.number().int().min(1).nullable(),
  onePerPhone: z.boolean(),
  // The orders that have it now: confirmed and later (not cancelled), plus those still waiting for
  // their phone code (decision 3). "12 of 100 used" in the list
  used: z.number().int().min(0),
  // An order has had this code, even one cancelled since: the code can no longer change, because
  // that order's page and its documents say the old code (storefront_coupon_code_locked)
  codeLocked: z.boolean(),
  status: z.enum(STOREFRONT_COUPON_STATUSES),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontCoupon = z.infer<typeof storefrontCouponSchema>;

export const storefrontCouponPageSchema = pageOf(storefrontCouponSchema);
export type StorefrontCouponPage = z.infer<typeof storefrontCouponPageSchema>;
```

- **The status is worked out, not stored** (`storefrontCouponStatus`): a coupon ends by itself at midnight or with its
  last use, and a stored status would need a job to keep it true. The API calls it with today in the workspace's time
  zone. Archived wins over everything, then "ended" (a coupon past its last day is ended even if it never started),
  then "scheduled".
- **`used` and `codeLocked` are two fields** (decision 16). `used` falls when an order waiting for its code is dropped
  or an order is cancelled, so "no order uses it now" is not "no order ever had it". An order's page and its sales
  documents keep the code as it was typed; changing the coupon's code afterwards would make them name a code that
  does not exist.
- **The query** pages newest first with a search on part of the code, upper-cased like the codes, so "wel" finds
  WELCOME10. Two tabs (decision 18): Current (active, scheduled and ended) and Archived.

### The form

```ts

// ---------------------------------------------------------------------------------------------
// The form

// Taka to the paisa at most, like a sales line's discount: the coupon's discount is spread over
// the sales order's lines to the paisa (decision 4), so ৳10.555 could not be given exactly
const COUPON_MONEY = /^\d{1,15}(?:\.\d{1,2})?$/;

// An amount box that may be empty: '' = no limit (null). Zero is refused rather than read as "no
// limit": a minimum of ৳0 or "up to ৳0" is a typo, and the empty box already says "none"
const optionalCouponMoneySchema = z
  .string()
  .trim()
  .refine((value) => value === '' || COUPON_MONEY.test(value), errorCode('money_format'))
  .refine(
    (value) => !COUPON_MONEY.test(value) || !isZeroMoney(value),
    errorCode('storefront_sale_zero'),
  )
  .transform((value) => (value === '' ? null : value));

// '' = as many orders as come (null). Digits only, so "1e3" or "12.5" never become a number
const usageLimitSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === '' ||
      (/^\d{1,7}$/.test(value) &&
        Number(value) >= 1 &&
        Number(value) <= STOREFRONT_COUPON_MAX_USES),
    errorCode('storefront_coupon_limit_format'),
  )
  .transform((value) => (value === '' ? null : Number(value)));

// The form's boxes as typed. kind and value are two boxes (a select and a number), not the
// ShopDiscount union, so the form has one value box that keeps what was typed when the select
// changes; the rules below check the value for the kind, and the output joins them.
const couponFieldsSchema = z.object({
  code: shopCouponCodeSchema,
  kind: z.enum(SHOP_COUPON_KINDS),
  value: z.string().trim(),
  upTo: optionalCouponMoneySchema,
  minimum: optionalCouponMoneySchema,
  startsOn: optionalDateSchema,
  lastDay: optionalDateSchema,
  usageLimit: usageLimitSchema,
  onePerPhone: z.boolean(),
});
type CouponFields = z.output<typeof couponFieldsSchema>;

function couponRules(input: CouponFields, ctx: z.RefinementCtx<CouponFields>) {
  // A percent is whole, 1 to 99, like a listing's sale and the shop's "10% OFF" (100% gives the
  // goods away). An amount is taka above zero. The listings' words fit both
  if (input.kind === 'percent' && !/^[1-9]\d?$/.test(input.value)) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: errorCode('storefront_sale_percent'),
    });
  }
  if (input.kind === 'amount') {
    if (!COUPON_MONEY.test(input.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: errorCode('money_format') });
    } else if (isZeroMoney(input.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: errorCode('storefront_sale_zero') });
    }
    // "৳50 off, up to ৳30" says two things; the form hides the box for an amount, so only
    // another client gets here
    if (input.upTo !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['upTo'],
        message: errorCode('storefront_coupon_up_to'),
      });
    }
  }
  // Both days are included, so one day (the same date twice) is a coupon for that day
  if (input.startsOn !== null && input.lastDay !== null && input.lastDay < input.startsOn) {
    ctx.addIssue({
      code: 'custom',
      path: ['lastDay'],
      message: errorCode('storefront_coupon_dates'),
    });
  }
}

// The checked boxes as the API saves them: the kind and the value as one ShopDiscount (a percent
// as a number, like the listings' ShopDiscount)
function asCoupon<T extends CouponFields>(input: T) {
  const { kind, value, ...rest } = input;
  const discount: ShopDiscount =
    kind === 'percent' ? { kind, value: Number(value) } : { kind, value };
  return { ...rest, discount };
}

export const createStorefrontCouponInputSchema = couponFieldsSchema
  .superRefine(couponRules)
  .transform(asCoupon);
export type CreateStorefrontCouponInput = z.output<typeof createStorefrontCouponInputSchema>;

export const updateStorefrontCouponInputSchema = couponFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(couponRules)
  .transform(asCoupon);
export type UpdateStorefrontCouponInput = z.output<typeof updateStorefrontCouponInputSchema>;
// The form's values: what the boxes hold before the schema checks them
export type StorefrontCouponFormValues = z.input<typeof createStorefrontCouponInputSchema>;

export const storefrontCouponVersionInputSchema = z.object({ version: versionSchema });
```

- **Kind and value are two boxes** (decision 17). A `z.discriminatedUnion` would make react-hook-form drop or keep
  the value box's text in odd ways when the select changes; one string box checked in `couponRules` for the kind
  keeps what was typed. `asCoupon` joins them into a `ShopDiscount` on the way out, so the API gets the shape it
  saves.
- **Amounts are to the paisa** (`COUPON_MONEY`, decision 13), unlike a listing's sale (4 decimals): the discount is
  spread over sales lines that take 2.
- **An empty box is "none", zero is an error.** `minimum: ''` is null (no minimum); `minimum: '0'` is refused with the
  sale's "Type an amount above ৳0", because a typed zero is a typo, and two ways to say "none" would show up as two
  different values in the audit log.
- **The number of orders** is digits only (`/^\d{1,7}$/`), checked before `Number()`, so `1e3` and `12.5` are refused
  instead of becoming 1000 and 12.5. 1,000,000 is the top (`STOREFRONT_COUPON_MAX_USES`): an integer column, and a
  nine-digit number is a typo, not a plan.
- **"Up to" on an amount is an error**, not ignored. The form hides the box for an amount (27c.6), so only another
  client can send it, and silently dropping a value someone sent hides their mistake.
- **The days:** `optionalDateSchema` (step 13's: `''` or an ISO date), the last day on or after the first. The same
  date twice is a coupon for one day (both days are included).
- `couponRules` runs after the field schemas, on their output (`z.RefinementCtx<CouponFields>`), so it sees `null`
  for an empty box and the upper-cased code. The update schema extends the fields with `version` before the rules,
  because a refined schema can't be extended.
- `StorefrontCouponFormValues` is the input type, what the boxes hold (strings), for the form's `useForm`.

### The routes

```ts

// ---------------------------------------------------------------------------------------------
// The routes. All storefront.manage: a coupon is the shop's price, like a listing's sale

const idParamsSchema = z.object({ id: z.uuid() });

export const storefrontCouponRoutes = {
  listCoupons: defineRoute({
    method: 'GET',
    path: '/storefront/coupons',
    summary: "The shop's coupons, newest first, with how many orders have each",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    query: storefrontCouponQuerySchema,
    response: storefrontCouponPageSchema,
  }),
  getCoupon: defineRoute({
    method: 'GET',
    path: '/storefront/coupons/:id',
    summary: 'One coupon',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontCouponSchema,
  }),
  createCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons',
    summary: 'Make a coupon the shop takes from its first day',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontCouponInputSchema,
    response: storefrontCouponSchema,
  }),
  updateCoupon: defineRoute({
    method: 'PUT',
    path: '/storefront/coupons/:id',
    summary: 'Change a coupon; its code only while no order has had it',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontCouponInputSchema,
    response: storefrontCouponSchema,
  }),
  archiveCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons/:id/archive',
    summary: 'Take a coupon away: the shop no longer knows its code',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontCouponVersionInputSchema,
    response: storefrontCouponSchema,
  }),
  restoreCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons/:id/restore',
    summary: 'Give an archived coupon back to the shop',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontCouponVersionInputSchema,
    response: storefrontCouponSchema,
  }),
};
```

Six routes, all `storefront.manage`, like a listing's sale: whoever sets the shop's prices sets its coupons. Archive
and restore send the version, like every other archive in the app, so two people working on one coupon get a
`version_conflict` instead of undoing each other.

```diff
@@ -63,6 +63,7 @@ export * from './stock-revaluations.js';
 export * from './stock-transfers.js';
 export * from './storefront.js';
 export * from './storefront-content.js';
+export * from './storefront-coupons.js';
 export * from './storefront-admin.js';
 export * from './storefront-appearance.js';
 export * from './storefront-orders.js';
```

```diff
@@ -21,6 +21,7 @@ import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js
 import { stockMovementReportRoutes } from './stock-movement-report.js';
 import { storefrontRoutes } from './storefront-admin.js';
 import { storefrontAppearanceRoutes } from './storefront-appearance.js';
+import { storefrontCouponRoutes } from './storefront-coupons.js';
 import { storefrontOrderRoutes } from './storefront-orders.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
@@ -161,4 +162,5 @@ export const routes = {
   storefront: storefrontRoutes,
   storefrontAppearance: storefrontAppearanceRoutes,
   storefrontOrders: storefrontOrderRoutes,
+  storefrontCoupons: storefrontCouponRoutes,
 };
```

### Error codes and audit actions

```diff
@@ -719,6 +719,18 @@ export const ERROR_CODES = [
   // workspace, or emptied after the first order made it (decision 4)
   'storefront_delivery_product_invalid',
   'storefront_delivery_product_required',
+  // Step 27c: coupons. In the shop: a code every allowed order has taken already (the quote's
+  // refusal), and a once-per-phone code this mobile number has used on another order (Confirm
+  // Order's refusal: the quote does not know the phone yet). In the ERP's form: a code another
+  // coupon of the workspace has (archived ones too), a code changed after an order had it, a last
+  // day before the first, "up to" on an amount coupon, a number of uses that is not 1 to 1,000,000
+  'shop_coupon_used_up',
+  'shop_coupon_used_by_phone',
+  'storefront_coupon_code_taken',
+  'storefront_coupon_code_locked',
+  'storefront_coupon_dates',
+  'storefront_coupon_up_to',
+  'storefront_coupon_limit_format',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Two codes for the shop and five for the form. The form reuses three it already had: `money_format`,
`storefront_sale_percent` ("Type a whole percent from 1 to 99") and `storefront_sale_zero` ("Type an amount above
৳0"), whose words fit a coupon as they are.

```diff
@@ -289,6 +289,12 @@ export const AUDIT_ACTIONS = [
   'storefront_order.shipped',
   'storefront_order.delivered',
   'storefront_order.cancelled',
+  // Step 27c: the shop's coupons (entity = storefront_coupon). An order that uses one writes
+  // nothing here: the order itself keeps the code and the discount
+  'storefront_coupon.created',
+  'storefront_coupon.updated',
+  'storefront_coupon.archived',
+  'storefront_coupon.restored',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -353,6 +359,7 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront_banner',
   'storefront_collection',
   'storefront_order',
+  'storefront_coupon',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

Four actions on a new entity, `storefront_coupon`. An order that uses a coupon writes nothing here: the order keeps
the code and the discount itself, and the shop's checkout writes no audit rows (step 27a).

```diff
@@ -6681,6 +6681,7 @@ export const en = {
       storefront_banner: 'Shop banners',
       storefront_collection: 'Shop collections',
       storefront_order: 'Shop orders',
+      storefront_coupon: 'Shop coupons',
     },
     columns: {
       when: 'When',
@@ -7047,6 +7048,13 @@ export const en = {
         delivered: 'Marked a shop order delivered',
         cancelled: 'Cancelled a shop order',
       },
+      // Step 27c
+      storefront_coupon: {
+        created: 'Made a shop coupon',
+        updated: 'Edited a shop coupon',
+        archived: 'Archived a shop coupon',
+        restored: 'Gave an archived shop coupon back to the shop',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -7245,6 +7253,14 @@ export const en = {
       paymentMethods: 'Ways to pay',
       // Step 27b
       deliveryVariantId: 'Delivery charge’s service',
+      // Step 27c: a coupon (code above is its code)
+      discount: 'Takes off',
+      upTo: 'Up to',
+      minimum: 'Items worth at least',
+      startsOn: 'First day',
+      lastDay: 'Last day',
+      usageLimit: 'Orders allowed',
+      onePerPhone: 'Once per mobile number',
       launched: 'Open',
       position: 'Place in the list',
       packSize: 'Pack size',
@@ -8205,6 +8221,16 @@ export const en = {
     storefront_delivery_product_invalid: 'Pick an active service, like Delivery charge.',
     storefront_delivery_product_required:
       'Orders already use a delivery charge service. Pick one; it can be another service.',
+    shop_coupon_used_up: 'This code has been used as many times as the shop allows.',
+    shop_coupon_used_by_phone:
+      'This code works once per mobile number, and this number has used it. Remove the code to order.',
+    storefront_coupon_code_taken: 'Another coupon has this code. Type a different one.',
+    storefront_coupon_code_locked:
+      'An order has used this code, so it can’t change. Make a new coupon for a new code.',
+    storefront_coupon_dates: 'Pick a last day on or after the first day, or leave it empty.',
+    storefront_coupon_up_to: 'Only a percent coupon has an “up to” amount. Leave it empty.',
+    storefront_coupon_limit_format:
+      'Type a whole number of orders from 1 to 1,000,000, or leave it empty for no limit.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6184,6 +6184,7 @@ export const bn: Messages = {
       storefront_banner: 'শপের ব্যানার',
       storefront_collection: 'শপের কালেকশন',
       storefront_order: 'শপের অর্ডার',
+      storefront_coupon: 'শপের কুপন',
     },
     columns: {
       when: 'কখন',
@@ -6538,6 +6539,13 @@ export const bn: Messages = {
         delivered: 'শপের অর্ডার পৌঁছেছে বলে চিহ্ন দিয়েছেন',
         cancelled: 'শপের অর্ডার বাতিল করেছেন',
       },
+      // Step 27c
+      storefront_coupon: {
+        created: 'শপের কুপন বানিয়েছেন',
+        updated: 'শপের কুপন বদলেছেন',
+        archived: 'শপের কুপন আর্কাইভ করেছেন',
+        restored: 'আর্কাইভ করা কুপন আবার শপে দিয়েছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -6729,6 +6737,14 @@ export const bn: Messages = {
       paymentMethods: 'পেমেন্টের উপায়',
       // ধাপ ২৭b
       deliveryVariantId: 'ডেলিভারি চার্জের সার্ভিস',
+      // Step 27c: a coupon (code above is its code)
+      discount: 'ছাড়',
+      upTo: 'সর্বোচ্চ',
+      minimum: 'কমপক্ষে যত টাকার পণ্য',
+      startsOn: 'প্রথম দিন',
+      lastDay: 'শেষ দিন',
+      usageLimit: 'কয়টা অর্ডারে চলবে',
+      onePerPhone: 'একটা মোবাইল নম্বরে একবার',
       launched: 'খোলা',
       position: 'তালিকায় জায়গা',
       packSize: 'প্যাকের সাইজ',
@@ -7640,6 +7656,16 @@ export const bn: Messages = {
     storefront_delivery_product_invalid: 'একটা চালু সার্ভিস বাছুন, যেমন ডেলিভারি চার্জ।',
     storefront_delivery_product_required:
       'অর্ডারে আগে থেকেই একটা ডেলিভারি চার্জের সার্ভিস আছে। একটা বাছুন, অন্য সার্ভিসও হতে পারে।',
+    shop_coupon_used_up: 'শপ যতবার দেয়, এই কোড ততবার ব্যবহার হয়ে গেছে।',
+    shop_coupon_used_by_phone:
+      'এই কোড একটা মোবাইল নম্বরে একবারই চলে, আর এই নম্বরে চলেছে। অর্ডার করতে কোডটা সরান।',
+    storefront_coupon_code_taken: 'আরেকটা কুপনের এই কোড আছে। অন্য একটা লিখুন।',
+    storefront_coupon_code_locked:
+      'একটা অর্ডারে এই কোড ব্যবহার হয়েছে, তাই এটা বদলানো যাবে না। নতুন কোডের জন্য নতুন কুপন বানান।',
+    storefront_coupon_dates: 'প্রথম দিন বা তার পরের একটা শেষ দিন বাছুন, অথবা ফাঁকা রাখুন।',
+    storefront_coupon_up_to: '“সর্বোচ্চ” শুধু শতাংশের কুপনে থাকে। ঘরটা ফাঁকা রাখুন।',
+    storefront_coupon_limit_format:
+      '১ থেকে ১০,০০,০০০-এর মধ্যে অর্ডারের একটা পূর্ণ সংখ্যা লিখুন, অথবা কোনো সীমা না চাইলে ফাঁকা রাখুন।',
   },
   ui: {
     dataTable: {
```

The error words, the audit actions and the entity, and seven field names for the audit log's changes (`code`
already had one). The words of the Coupons page come in 27c.5.

### Tests

```ts
import { describe, expect, it } from 'vitest';

import { shopCartQuoteSchema } from './storefront.js';
import {
  createStorefrontCouponInputSchema,
  judgeShopCoupon,
  shopCouponDiscount,
  storefrontCouponQuerySchema,
  storefrontCouponRoutes,
  storefrontCouponStatus,
  updateStorefrontCouponInputSchema,
  type ShopCouponRule,
  type StorefrontCouponFormValues,
} from './storefront-coupons.js';

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

// "10% off, up to ৳200, on items worth ৳500 or more, in November, 100 orders"
const RULE: ShopCouponRule = {
  code: 'WELCOME10',
  discount: { kind: 'percent', value: 10 },
  upTo: '200',
  minimum: '500',
  startsOn: '2026-11-01',
  lastDay: '2026-11-30',
  usageLimit: 100,
  onePerPhone: true,
};
const CHECK = { subtotal: '1000.0000', today: '2026-11-19', used: 12 };

describe('judgeShopCoupon', () => {
  it('applies a code that fits, with what the promo box names', () => {
    expect(judgeShopCoupon('WELCOME10', RULE, CHECK)).toEqual({
      status: 'applied',
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '200',
    });
    expect(judgeShopCoupon(undefined, RULE, CHECK)).toEqual({ status: 'none' });
  });

  it('calls a missing code and one that has not started yet unknown', () => {
    expect(judgeShopCoupon('NOPE', undefined, CHECK)).toMatchObject({
      reason: 'shop_coupon_unknown',
    });
    // The day before its first day: the sale is not announced through the promo box
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-10-31' })).toMatchObject({
      reason: 'shop_coupon_unknown',
    });
    // Its first and last days both count
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-11-01' }).status).toBe(
      'applied',
    );
    expect(judgeShopCoupon('WELCOME10', RULE, { ...CHECK, today: '2026-11-30' }).status).toBe(
      'applied',
    );
  });

  it('gives the reason that matters most: expired, then used up, then the minimum', () => {
    const late = { ...CHECK, today: '2026-12-01', used: 100, subtotal: '100.0000' };
    expect(judgeShopCoupon('WELCOME10', RULE, late)).toMatchObject({
      reason: 'shop_coupon_expired',
      minimum: null,
    });
    expect(judgeShopCoupon('WELCOME10', RULE, { ...late, today: '2026-11-19' })).toMatchObject({
      reason: 'shop_coupon_used_up',
    });
    expect(judgeShopCoupon('WELCOME10', RULE, { ...late, today: '2026-11-19', used: 99 })).toEqual({
      status: 'refused',
      code: 'WELCOME10',
      reason: 'shop_coupon_minimum',
      minimum: '500',
    });
  });

  it('answers in the quote’s own shape', () => {
    const coupon = judgeShopCoupon('WELCOME10', RULE, CHECK);
    const quote = {
      lines: [],
      itemCount: 0,
      subtotal: '1000.0000',
      discount: '100.0000',
      coupon,
      deliveryCharge: null,
      freeDelivery: false,
      total: '900.0000',
      belowMinimum: false,
    };
    expect(shopCartQuoteSchema.safeParse(quote).success).toBe(true);
  });
});

describe('shopCouponDiscount', () => {
  it('takes a percent of the items, to the paisa, cut to its "up to"', () => {
    const tenPercent = { discount: { kind: 'percent', value: 10 } as const, upTo: null };
    expect(shopCouponDiscount(tenPercent, '1234.5600')).toBe('123.4600');
    expect(shopCouponDiscount({ ...tenPercent, upTo: '200' }, '5000.0000')).toBe('200.0000');
    expect(shopCouponDiscount({ ...tenPercent, upTo: '200' }, '1500.0000')).toBe('150.0000');
  });

  it('never takes more than the items cost', () => {
    const fifty = { discount: { kind: 'amount', value: '50' } as const, upTo: null };
    expect(shopCouponDiscount(fifty, '458.0000')).toBe('50.0000');
    expect(shopCouponDiscount(fifty, '30.0000')).toBe('30.0000');
  });
});

describe('storefrontCouponStatus', () => {
  const coupon = { archivedAt: null, startsOn: null, lastDay: null, usageLimit: null, used: 0 };

  it('works the pill out from the archive, the days and the uses', () => {
    expect(storefrontCouponStatus(coupon, '2026-11-19')).toBe('active');
    expect(storefrontCouponStatus({ ...coupon, startsOn: '2026-11-20' }, '2026-11-19')).toBe(
      'scheduled',
    );
    expect(storefrontCouponStatus({ ...coupon, lastDay: '2026-11-18' }, '2026-11-19')).toBe(
      'ended',
    );
    expect(storefrontCouponStatus({ ...coupon, usageLimit: 5, used: 5 }, '2026-11-19')).toBe(
      'ended',
    );
    expect(
      storefrontCouponStatus(
        { ...coupon, archivedAt: '2026-11-01T04:00:00.000Z', startsOn: '2026-12-01' },
        '2026-11-19',
      ),
    ).toBe('archived');
  });
});

const FORM: StorefrontCouponFormValues = {
  code: ' welcome10 ',
  kind: 'percent',
  value: '10',
  upTo: '200',
  minimum: '',
  startsOn: '2026-11-01',
  lastDay: '',
  usageLimit: '100',
  onePerPhone: true,
};

describe('the coupon form', () => {
  it('saves the boxes as the API keeps them', () => {
    expect(createStorefrontCouponInputSchema.parse(FORM)).toEqual({
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '200',
      minimum: null,
      startsOn: '2026-11-01',
      lastDay: null,
      usageLimit: 100,
      onePerPhone: true,
    });
    expect(
      createStorefrontCouponInputSchema.parse({ ...FORM, kind: 'amount', value: '50.5', upTo: '' })
        .discount,
    ).toEqual({ kind: 'amount', value: '50.5' });
    expect(updateStorefrontCouponInputSchema.parse({ ...FORM, version: 3 }).version).toBe(3);
  });

  it('checks the value for its kind', () => {
    const errors = (values: Partial<StorefrontCouponFormValues>) =>
      errorsOf(createStorefrontCouponInputSchema.safeParse({ ...FORM, ...values }));
    expect(errors({ value: '100' })).toEqual({ value: ['storefront_sale_percent'] });
    expect(errors({ value: '12.5' })).toEqual({ value: ['storefront_sale_percent'] });
    expect(errors({ kind: 'amount', upTo: '', value: '0' })).toEqual({
      value: ['storefront_sale_zero'],
    });
    // To the paisa: the discount is spread over the sales order's lines to the paisa
    expect(errors({ kind: 'amount', upTo: '', value: '10.555' })).toEqual({
      value: ['money_format'],
    });
    expect(errors({ kind: 'amount', value: '50' })).toEqual({ upTo: ['storefront_coupon_up_to'] });
  });

  it('refuses empty-looking limits, odd uses and days in the wrong order', () => {
    const errors = (values: Partial<StorefrontCouponFormValues>) =>
      errorsOf(createStorefrontCouponInputSchema.safeParse({ ...FORM, ...values }));
    expect(errors({ minimum: '0', upTo: '0.00' })).toEqual({
      minimum: ['storefront_sale_zero'],
      upTo: ['storefront_sale_zero'],
    });
    expect(errors({ usageLimit: '0' })).toEqual({ usageLimit: ['storefront_coupon_limit_format'] });
    expect(errors({ usageLimit: '1e3' })).toEqual({
      usageLimit: ['storefront_coupon_limit_format'],
    });
    expect(errors({ usageLimit: '1000001' })).toEqual({
      usageLimit: ['storefront_coupon_limit_format'],
    });
    expect(errors({ lastDay: '2026-10-31' })).toEqual({ lastDay: ['storefront_coupon_dates'] });
    // One day: the same date twice
    expect(errors({ lastDay: '2026-11-01' })).toEqual({});
    expect(errors({ code: 'EID SALE' })).toEqual({ code: ['shop_coupon_format'] });
  });
});

describe('the coupons list', () => {
  it('searches by part of the code, current coupons first', () => {
    expect(storefrontCouponQuerySchema.parse({ search: ' wel ' })).toMatchObject({
      search: 'WEL',
      view: 'current',
    });
  });

  it('asks storefront.manage on every route', () => {
    for (const route of Object.values(storefrontCouponRoutes)) {
      expect(route.permission).toBe('storefront.manage');
    }
  });
});
```

- The rule: applied with its "up to", no code, unknown and not started, both end days included, the reasons in their
  order, and an answer the quote's own schema accepts.
- The discount: a percent to the paisa, cut by "up to", and an amount cut by the items' worth.
- The status: each of the four pills, and archived over a later start.
- The form: the output shape, the value checked for its kind, the zero and format refusals, the days, and a code with a
  space.
- The routes: every one asks `storefront.manage`.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test        # 650 tests
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/db build              # its audit types come from the contracts
pnpm --filter @omnivo/api typecheck         # clean
pnpm --filter @omnivo/app typecheck         # clean
```

Two things fail until later parts, on purpose:

- `pnpm --filter @omnivo/shop typecheck`: the mock's quote (`apps/shop/src/data/mock/quote.ts`) answers an applied
  coupon without `upTo`. 27c.7 moves the mock onto `judgeShopCoupon`.
- `apps/api/src/contract.spec.ts`: the contract has 6 routes the API does not serve yet (27c.3).

Broken on purpose while this part was written, each caught:

- `judgeShopCoupon` with the "not started" check turned off: "calls a missing code and one that has not started yet
  unknown" fails.
- `spreadMoney` without the largest-remainder sort (the paisa go to the first lines): "spreads a value over weights in
  proportion" fails. The first version of that test did not catch it: its case gave the paisa to the first line
  either way, so the test now has a case where the second line must win.

## 27c.2 — Database

One new table, `storefront_coupons`, and the order's link to it. Two migrations, as in 27a: drizzle-kit writes the
table, the column, the keys and the checks (0073); a hand-written one gives the table its tenant rules, lets the
shop's roles read and lock coupons, counts a coupon's uses, and freezes a code once an order has it (0074).

Mine, made while writing this part:

19. **A coupon's uses are counted when they are asked for, by one function** (`storefront_coupon_uses`), not kept
    in a counter column. A counter kept by triggers would still count a pending order past its hold until the
    worker's sweep deletes it (up to 5 minutes later), and a counter can drift from the orders after a bug. The
    count is exact, reads one small index, and is the same for the quote, placing an order and the Coupons page.
20. **`first_ordered_at` is the one column the shop may write.** Postgres lets a role lock a row (`FOR UPDATE`)
    only if it may update one of its columns, so this column is what gives the shop the lock decision 3 asks for.
    Placing an order sets it while it holds that lock, and it is `codeLocked` (decision 16). A guard trigger freezes
    the code once it is set, and keeps the time.
21. **The order's foreign key names the code as well as the id**, so the code an order says is always its coupon's.
22. **An archived coupon is hidden from the shop by the database** (a restrictive policy), not only by the API.

### The coupons table

```ts
import { SHOP_COUPON_KINDS, STOREFRONT_COUPON_MAX_USES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Step 27c: the shop's coupons (decision 2). One table, for the whole cart: a coupon takes money
// off the items, never off the delivery charge. The ERP's Coupons page writes it as omnivo_app;
// the shop's quote reads it as omnivo_public, and placing an order locks its row as omnivo_shop
// (migration 0074). A coupon is never deleted: an order points at it, so it is archived instead.
export const storefrontCoupons = pgTable(
  'storefront_coupons',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "WELCOME10", as shopCouponCodeSchema writes it: upper case, so one code is one row
    code: text('code').notNull(),
    // The discount as two columns, like a listing's sale (ShopDiscount): a whole percent or taka
    discountKind: text('discount_kind', { enum: SHOP_COUPON_KINDS }).notNull(),
    discountValue: numeric('discount_value', { precision: 19, scale: 4 }).notNull(),
    // The most a percent takes off ("10%, up to ৳200"). NULL = no limit
    upTo: numeric('up_to', { precision: 19, scale: 4 }),
    // The items must be worth at least this much. NULL = any amount
    minimum: numeric('minimum', { precision: 19, scale: 4 }),
    // Whole days in the workspace's time zone, both included. NULL = from now on / for good
    startsOn: date('starts_on', { mode: 'string' }),
    lastDay: date('last_day', { mode: 'string' }),
    // How many orders may have it. NULL = as many as come
    usageLimit: integer('usage_limit'),
    onePerPhone: boolean('one_per_phone').notNull().default(false),
    // When the first order was placed with it (decision 16). Set by placing an order, while it
    // holds the row's lock (27c.3), and never changed again: from then on the code is frozen,
    // because that order's page and its documents say this code. The guard in 0074 keeps both
    // rules
    firstOrderedAt: timestamp('first_ordered_at', { withTimezone: true }),
    // NULL = the shop knows it. Archived = to the shop it does not exist (0074's policy)
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One code per workspace, archived ones included (storefront_coupon_code_taken): restoring an
    // archived WELCOME10 must not meet a second one. A constraint, so the API answers by its name
    unique('storefront_coupons_code_key').on(table.tenantId, table.code),
    // The target of the orders' foreign key, which names the code as well as the id: the code an
    // order says is then always its coupon's code. A constraint, not an index, for 27a's reason
    // (drizzle writes it inside CREATE TABLE, before the foreign key that needs it)
    unique('storefront_coupons_order_key').on(table.tenantId, table.id, table.code),
    // The Coupons page: one workspace, newest first
    index('storefront_coupons_list_idx').on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // shopCouponCodeSchema's pattern
    check('storefront_coupons_code_check', sql`${table.code} ~ '^[A-Z0-9-]{1,20}$'`),
    // The form's rules again (createStorefrontCouponInputSchema), so a row the API did not write
    // is still one judgeShopCoupon() and spreadMoney() can use. Every amount is above zero and to
    // the paisa (decision 13): numeric(19,4) keeps four places, so "= round(x, 2)" is the test. A
    // percent is whole, 1 to 99; "up to" belongs to a percent only
    check(
      'storefront_coupons_discount_check',
      sql`${table.discountValue} > 0
        AND CASE ${table.discountKind}
          WHEN 'percent' THEN ${table.discountValue} = trunc(${table.discountValue}) AND ${table.discountValue} <= 99
          ELSE ${table.discountValue} = round(${table.discountValue}, 2) AND ${table.upTo} IS NULL END
        AND (${table.upTo} IS NULL OR (${table.upTo} > 0 AND ${table.upTo} = round(${table.upTo}, 2)))
        AND (${table.minimum} IS NULL OR (${table.minimum} > 0 AND ${table.minimum} = round(${table.minimum}, 2)))`,
    ),
    // The same day twice is a one-day coupon
    check(
      'storefront_coupons_days_check',
      sql`${table.startsOn} IS NULL OR ${table.lastDay} IS NULL OR ${table.lastDay} >= ${table.startsOn}`,
    ),
    check(
      'storefront_coupons_usage_limit_check',
      sql`${table.usageLimit} IS NULL OR ${table.usageLimit} BETWEEN 1 AND ${sql.raw(String(STOREFRONT_COUPON_MAX_USES))}`,
    ),
  ],
);
```

- **The discount is two columns, `discount_kind` and `discount_value`**, like a listing's sale (`sale_kind`,
  `sale_value`). The contract's `ShopDiscount` is a union of the two kinds; the API joins the columns into it when it
  reads a row, and splits it when it writes one. A `jsonb` column would hold the same, but then the checks below
  could not see the value as a number.
- **No `deleted_at` and no `created_by`.** A coupon is archived, never deleted (decision 2), and the audit log
  already says who made it (`storefront_coupon.created`, 27c.1), as for the listings.
- **`first_ordered_at`** is set by the first order placed with the code, and never again (decision 20). From then on
  the code is frozen: that order's page, its SMS and its sales order say this code. A pending order that is dropped
  later had the code too, so a column on the coupon, which stays when the order goes, says it better than "is there
  an order now".
- **`storefront_coupons_code_key` is unique across archived coupons too.** Restoring an archived `WELCOME10` must not
  meet a second `WELCOME10`, and the shop must never have to choose between two. It is a constraint, so 27c.3 can
  answer `storefront_coupon_code_taken` by its name.
- **`storefront_coupons_order_key` (`tenant_id`, `id`, `code`)** is the target of the orders' foreign key below.
  The id alone is already unique; the code is in it so the order's foreign key can name the code. It is a
  constraint and not a `uniqueIndex` for 27a's reason: drizzle writes a constraint inside `CREATE TABLE`, before the
  foreign key that needs it.
- **`storefront_coupons_list_idx`** is the Coupons page: one workspace, newest first, with the id as the tie-break
  the keyset cursor needs. The code search (`LIKE '%WEL%'`) has no index of its own, for 27b.2's reason: under row
  security Postgres never uses a trigram index. A shop has hundreds of coupons, not millions.
- **The checks write the form's rules again** (`createStorefrontCouponInputSchema`, 27c.1), so a row the API did not
  write (a script, a hand-written `UPDATE`) is still one `judgeShopCoupon()` and `spreadMoney()` can use. Every
  amount is above zero and to the paisa (decision 13). The columns are `numeric(19,4)` like every amount, so
  `scale()` is always 4; `x = round(x, 2)` is the test that the last two places are zero. A percent is whole and 1 to
  99, like a listing's sale. "Up to" belongs to a percent only: the `ELSE` branch (an amount) asks for `up_to IS
  NULL`.
- **`storefront_coupons_days_check`**: the last day may be the first day (a one-day coupon), never before it.
- **`storefront_coupons_usage_limit_check`** takes its top from `STOREFRONT_COUPON_MAX_USES`, so the database and the
  form say the same number.

### The order's coupon

```diff
@@ -29,6 +29,7 @@ import { invoices } from './invoices.js';
 import { productVariants } from './products.js';
 import { deliveries, salesOrders } from './sales-documents.js';
 import { salesReturns } from './sales-returns.js';
+import { storefrontCoupons } from './storefront-coupons.js';
 import { tenants } from './tenants.js';
 import { warehouses } from './warehouses.js';
 
@@ -73,10 +74,13 @@ export const storefrontOrders = pgTable(
     zoneId: text('zone_id').notNull(),
     zoneName: text('zone_name').notNull(),
     paymentMethod: text('payment_method', { enum: SHOP_PAYMENT_METHODS }).notNull(),
-    // The server's own sums, never the browser's (system design §14.4). discount and coupon_code
-    // stay '0' and NULL until coupons come in 27c
+    // The server's own sums, never the browser's (system design §14.4). discount is what the
+    // coupon took off the items (shopCouponDiscount), '0' without one
     subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull(),
     discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
+    // Step 27c: the coupon the order was placed with, and its code as the shopper typed it (upper
+    // case). Both or neither; the foreign key below names the pair, so the code is the coupon's
+    couponId: uuid('coupon_id'),
     couponCode: text('coupon_code'),
     deliveryCharge: numeric('delivery_charge', { precision: 19, scale: 4 }).notNull(),
     total: numeric('total', { precision: 19, scale: 4 }).notNull(),
```

27a already had `discount` and `coupon_code`, kept at `'0'` and NULL until now. The new `coupon_id` says which coupon
the order took a use of. `coupon_code` stays: the order page, the tracking page and the SMS read the code from the
order, and the foreign key below makes sure it is the coupon's.

```diff
@@ -270,6 +274,27 @@ export const storefrontOrders = pgTable(
       sql`${table.cancelReason} IS NULL OR (${table.status} = 'cancelled'
         AND char_length(${table.cancelReason}) BETWEEN 1 AND 200)`,
     ),
+    // Step 27c: the coupon of this workspace, with the code it has. MATCH SIMPLE skips the key when
+    // either column is NULL, so the check below makes it both or neither. No ON DELETE (a coupon is
+    // archived, never deleted) and no ON UPDATE: while an order points at it, the code cannot
+    // change, which 0074's guard says first, with a name the API can answer by
+    foreignKey({
+      name: 'storefront_orders_coupon_fk',
+      columns: [table.tenantId, table.couponId, table.couponCode],
+      foreignColumns: [storefrontCoupons.tenantId, storefrontCoupons.id, storefrontCoupons.code],
+    }),
+    // No coupon, no discount. A coupon may still take ৳0 off: 1% of ৳0.40 is less than a paisa
+    check(
+      'storefront_orders_coupon_check',
+      sql`(${table.couponId} IS NULL) = (${table.couponCode} IS NULL)
+        AND (${table.couponId} IS NOT NULL OR ${table.discount} = 0)`,
+    ),
+    // How many orders hold a use of a coupon (storefront_coupon_uses() in 0074): the quote asks it
+    // for every cart with a code, so it reads this index and not the orders. Partial: most orders
+    // have no coupon
+    index('storefront_orders_coupon_idx')
+      .on(table.tenantId, table.couponId, table.status, table.createdAt)
+      .where(sql`${table.couponId} IS NOT NULL`),
   ],
 );
 
```

- **`storefront_orders_coupon_fk` names three columns: `tenant_id`, `coupon_id` and `coupon_code`.** With the
  workspace in it, another workspace's coupon matches nothing. With the code in it, an order cannot say `FLAT50`
  while it took a use of `WELCOME10`. And because it has no `ON UPDATE`, a coupon's code cannot change while an order
  points at it; 0074's guard says that first, with a name the API answers by.
- **No `ON DELETE`.** A coupon is never deleted; if a script tried, the orders would stop it.
- **`storefront_orders_coupon_check`.** A composite foreign key is skipped when any of its columns is NULL (`MATCH
  SIMPLE`, Postgres's default), so the id without the code, or the code without the id, would pass it unchecked. The
  check makes them both or neither. And no coupon means no discount. The other way does not hold: a coupon may take
  ৳0 off (1% of ৳0.40 is less than a paisa), and the order still took a use of it.
- **`storefront_orders_coupon_idx`** is what `storefront_coupon_uses()` reads: one workspace, one coupon, and the two
  columns the count filters on, so Postgres answers from the index alone ("index only scan", checked below). Partial
  on `coupon_id IS NOT NULL`: most orders have no coupon, and leaving them out keeps it small.

```diff
@@ -54,3 +54,4 @@ export * from './pos.js';
 export * from './report-schedules.js';
 export * from './storefront.js';
 export * from './storefront-orders.js';
+export * from './storefront-coupons.js';
```

### The table's migration

```sql
CREATE TABLE "storefront_coupons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"discount_kind" text NOT NULL,
	"discount_value" numeric(19, 4) NOT NULL,
	"up_to" numeric(19, 4),
	"minimum" numeric(19, 4),
	"starts_on" date,
	"last_day" date,
	"usage_limit" integer,
	"one_per_phone" boolean DEFAULT false NOT NULL,
	"first_ordered_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "storefront_coupons_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "storefront_coupons_order_key" UNIQUE("tenant_id","id","code"),
	CONSTRAINT "storefront_coupons_code_check" CHECK ("storefront_coupons"."code" ~ '^[A-Z0-9-]{1,20}$'),
	CONSTRAINT "storefront_coupons_discount_check" CHECK ("storefront_coupons"."discount_value" > 0
        AND CASE "storefront_coupons"."discount_kind"
          WHEN 'percent' THEN "storefront_coupons"."discount_value" = trunc("storefront_coupons"."discount_value") AND "storefront_coupons"."discount_value" <= 99
          ELSE "storefront_coupons"."discount_value" = round("storefront_coupons"."discount_value", 2) AND "storefront_coupons"."up_to" IS NULL END
        AND ("storefront_coupons"."up_to" IS NULL OR ("storefront_coupons"."up_to" > 0 AND "storefront_coupons"."up_to" = round("storefront_coupons"."up_to", 2)))
        AND ("storefront_coupons"."minimum" IS NULL OR ("storefront_coupons"."minimum" > 0 AND "storefront_coupons"."minimum" = round("storefront_coupons"."minimum", 2)))),
	CONSTRAINT "storefront_coupons_days_check" CHECK ("storefront_coupons"."starts_on" IS NULL OR "storefront_coupons"."last_day" IS NULL OR "storefront_coupons"."last_day" >= "storefront_coupons"."starts_on"),
	CONSTRAINT "storefront_coupons_usage_limit_check" CHECK ("storefront_coupons"."usage_limit" IS NULL OR "storefront_coupons"."usage_limit" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_coupons" ADD CONSTRAINT "storefront_coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_coupons_list_idx" ON "storefront_coupons" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_coupon_fk" FOREIGN KEY ("tenant_id","coupon_id","coupon_code") REFERENCES "public"."storefront_coupons"("tenant_id","id","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_orders_coupon_idx" ON "storefront_orders" USING btree ("tenant_id","coupon_id","status","created_at") WHERE "storefront_orders"."coupon_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_coupon_check" CHECK (("storefront_orders"."coupon_id" IS NULL) = ("storefront_orders"."coupon_code" IS NULL)
        AND ("storefront_orders"."coupon_id" IS NOT NULL OR "storefront_orders"."discount" = 0));
```

Made by drizzle-kit from the schema files:

```bash
pnpm --filter @omnivo/db generate --name storefront-coupons
```

It also writes `meta/0073_snapshot.json` and a line in `meta/_journal.json`; both are drizzle-kit's own and not
shown. The new column is NULL, and every order placed under 27a and 27b has no coupon and a discount of 0, so the new
check passes on the rows already there.

### The rules

```sql
-- Custom SQL migration file, put your code below! --
-- Step 27c: who may read and write the shop's coupons. 0073 made the table and the order's link
-- to it; this file gives it the tenant rules every table has, lets the shop's quote read the
-- coupons and count their uses without reading an order, lets placing an order lock a coupon,
-- and freezes a code once an order has it.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Coupons page), omnivo_public (the quote) and
--    omnivo_shop (placing an order) all set app.tenant_id to one workspace first
ALTER TABLE storefront_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_coupons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON storefront_coupons
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2) The quote reads the coupon a cart names (judgeShopCoupon needs every rule column). The whole
--    table, as 0064 gave the other storefront tables: a coupon has no name, phone or address.
--    Two RESTRICTIVE policies, like a listing's: only while the shop is launched, and never an
--    archived coupon. To the shop an archived code does not exist (decision 2), and this way no
--    bug in a quote or an order can take one. omnivo_shop inherits both (0071, INHERIT TRUE), so
--    placing an order cannot lock an archived coupon either
GRANT SELECT ON storefront_coupons TO omnivo_public;
CREATE POLICY storefront_public_launched ON storefront_coupons
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (EXISTS (
    SELECT 1 FROM storefront_settings s WHERE s.tenant_id = storefront_coupons.tenant_id
  ));
CREATE POLICY storefront_public_current ON storefront_coupons
  AS RESTRICTIVE FOR SELECT TO omnivo_public
  USING (archived_at IS NULL);

-- 3) Placing an order takes the coupon's row lock (decision 3): two shoppers who want the last
--    use are then counted one after the other. Postgres asks for UPDATE on at least one column
--    even for SELECT … FOR UPDATE, and the one column the shop has a reason to write is the
--    first order's time (decision 16). Not updated_at or version: an order is not an edit, and a
--    new version would make every open Coupons form fail with a version conflict
GRANT UPDATE (first_ordered_at) ON storefront_coupons TO omnivo_shop;

-- 4) How many orders hold a use of a coupon now (decision 3): the confirmed and later ones and
--    the ones still waiting for their phone code, but not the cancelled ones (a cancel gives the
--    use back), and not a pending order past its hold (SHOP_ORDER_HOLD_MINUTES): it can no longer
--    be confirmed, so its use is free again even before the worker's sweep deletes it, as its
--    stock is (27a's holds). With p_phone, only that mobile number's orders: once per phone.
--    p_since is "now minus the hold" from the API, so the minutes stay in the contracts and a
--    test's clock is the clock here too.
--    One function, so the quote, placing an order and the Coupons page count a use the same way.
--    SECURITY DEFINER, because the quote runs as omnivo_public, which may not read an order
--    (names, phones and addresses): this answers a number and nothing else. FORCE RLS holds for
--    the owner too, so tenant_isolation keeps it inside the caller's workspace; the tenant
--    filter is written out as well, so it would stay inside even if the owner skipped row
--    security one day. search_path is fixed for 0064's reason
CREATE FUNCTION storefront_coupon_uses(p_coupon_id uuid, p_since timestamptz, p_phone text DEFAULT NULL)
  RETURNS integer
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::integer
  FROM storefront_orders o
  WHERE o.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    AND o.coupon_id = p_coupon_id
    AND o.status <> 'cancelled'
    AND (o.status <> 'pending' OR o.created_at > p_since)
    AND (p_phone IS NULL OR o.phone = p_phone)
$$;

-- Every role may run a new function (PUBLIC). The quote (omnivo_public, and omnivo_shop through
-- it) and the Coupons page (omnivo_app, whose membership in omnivo_public does not inherit)
REVOKE EXECUTE ON FUNCTION storefront_coupon_uses(uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION storefront_coupon_uses(uuid, timestamptz, text) TO omnivo_public, omnivo_app;

-- 5) A code with an order is frozen (decision 2). The order's foreign key (0073) already refuses
--    a new code while that order exists, but a pending order that was dropped had the code too,
--    and so did a cancelled one that may be deleted one day; first_ordered_at remembers them all.
--    A trigger and not a CHECK, because the rule compares the row before and after. It reads the
--    row as it is when the UPDATE runs: when the Coupons page saves a new code while an order is
--    being placed, the save waits for the order's row lock and then sees its first_ordered_at.
--    The CONSTRAINT names are what the API answers by (storefront_coupon_code_locked)
CREATE FUNCTION storefront_coupons_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_ordered_at IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'coupon % has orders, so its code cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_coupons_code_locked';
  END IF;
  -- Once set, kept: set back to NULL, it would let the code change after all
  IF OLD.first_ordered_at IS NOT NULL
     AND NEW.first_ordered_at IS DISTINCT FROM OLD.first_ordered_at THEN
    RAISE EXCEPTION 'coupon % keeps the time of its first order', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_coupons_first_ordered_kept';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_coupons_guard
  BEFORE UPDATE ON storefront_coupons
  FOR EACH ROW EXECUTE FUNCTION storefront_coupons_guard();
```

Made empty by drizzle-kit, then written by hand:

```bash
pnpm --filter @omnivo/db generate --custom --name storefront-coupons-rules
```

Block by block:

1. **The tenant rules**, as every tenant table has them since 0002: row security on, forced (so it holds for the
   table's owner too), and `tenant_isolation` with no `TO`, for every role.
2. **What the shop's pages read.** The quote needs every rule column, and a coupon has no name, phone or address,
   so `omnivo_public` gets the whole table, as 0064 gave it the listings. Two restrictive policies narrow it, both
   `TO omnivo_public`: only while the shop is launched (the same `EXISTS` as on every storefront table), and only
   coupons that are not archived (decision 22). The second one means the quote and placing an order cannot take an
   archived code even with a bug in the API: for them the row is not there. `omnivo_shop` gets both policies, because
   0071 made it a member of `omnivo_public` with `INHERIT TRUE`, and a policy for a role holds for the roles that
   inherit from it.
3. **The lock.** Decision 3 says two shoppers who want the last use are counted one after the other, with the
   coupon's row locked. Postgres asks for `UPDATE` on at least one column of a table even for `SELECT … FOR UPDATE`,
   so `omnivo_shop` needs one. `first_ordered_at` is the column it has a reason to write (decision 20): 27c.3 writes
   `UPDATE storefront_coupons SET first_ordered_at = coalesce(first_ordered_at, …)`, which takes the lock and records
   the first order in one statement. Not `updated_at` or `version`: an order is not an edit of the coupon, and a new
   version would make every Coupons form that is open at that moment fail with a version conflict. The shop's role
   can change nothing else of a coupon (checked below).
4. **`storefront_coupon_uses(coupon, since, phone)`** counts the orders that hold a use now (decision 3, mine 19):
   - **Not the cancelled ones**: a cancel gives the use back.
   - **Not a pending order past its hold.** A pending order older than `SHOP_ORDER_HOLD_MINUTES` can no longer be
     confirmed (27a's `waitingOrder`), and its stock is already free again through the holds' `expires_at`, even
     before the worker's sweep deletes it. Its coupon use is free at the same moment. The function takes `since`
     ("now minus the hold") from the API instead of writing 60 minutes into SQL, so the number stays in the contracts,
     and a test that moves the API's clock moves this one too.
   - **With a phone, only that number's orders**: once per mobile number (`shop_coupon_used_by_phone`, 27c.3).
   - **`SECURITY DEFINER`**: the quote runs as `omnivo_public`, which may not read an order (names, phones,
     addresses). The function runs as its owner, the migrator, and gives back one number. `FORCE` row security holds
     for the owner too, so `tenant_isolation` keeps the count inside the caller's workspace; the `tenant_id` filter is
     also written out, so the count would stay inside even if the owner skipped row security one day. `search_path` is
     fixed for 0064's reason: a caller cannot slip in a table of its own called `storefront_orders`.
   - **`STABLE`**: it only reads, and inside one statement it gives one answer. A `SECURITY DEFINER` function is never
     inlined into the caller's query, so it always runs as its owner.
   - **Who may run it:** `omnivo_public` (and `omnivo_shop` through it) and `omnivo_app`, for the Coupons page's
     "12 of 100 used". `omnivo_app` gets its own grant, because its membership in `omnivo_public` does not inherit
     (0064). `PUBLIC`'s default right to run a new function is taken away first.
5. **The guard.** Decision 2 says a code with an order can't change. The foreign key already refuses a new code while
   an order points at the coupon, but a pending order that was dropped had the code too. `first_ordered_at`
   remembers every order, so the trigger refuses a new code once it is set (`storefront_coupons_code_locked`), and
   refuses any change to `first_ordered_at` itself once it is set (`storefront_coupons_first_ordered_kept`), because
   setting it back to NULL would open the code again. A trigger and not a check, because the rule compares the row
   before and after. `RAISE … USING ERRCODE = 'check_violation', CONSTRAINT = …` is 18c's pattern: the API's
   database-error mapping reads the constraint name, as for a real check.
   - **The race it closes:** the tenant saves a new code at the moment a shopper places the first order with the old
     one. Placing the order holds the coupon's row lock until it commits. The tenant's `UPDATE` waits for that lock,
     and then Postgres runs it on the row as the order left it (in `READ COMMITTED`, an `UPDATE` that waited re-reads
     the newest version of its row). The trigger sees `first_ordered_at` and refuses the new code. A check in the API
     before the `UPDATE` ("does it have an order?") would have read the row before the order committed, and let the
     code change under an order that says the old one (checked below).

No other grant is needed. `omnivo_app` gets every right on a new table by the migrator's default privileges (the
Coupons page, the sales order maker, the order screens). `omnivo_shop` already has `INSERT` on the whole of
`storefront_orders` (0071, a table grant, which covers a column added later), so it can place an order with
`coupon_id`, and its column `UPDATE` grants do not reach `coupon_id`: a confirmed order's coupon cannot be changed by
the shop. A foreign key is checked by Postgres itself and skips row security, so an order keeps pointing at its coupon
after the coupon is archived.

### A test fixture

```diff
@@ -28,6 +28,7 @@ function order(overrides: Partial<OrderRow> = {}): OrderRow {
     paymentMethod: 'cod',
     subtotal: '498.0000',
     discount: '0.0000',
+    couponId: null,
     couponCode: null,
     deliveryCharge: '80.0000',
     total: '578.0000',
```

27a's order-view unit test builds a whole order row with drizzle's row type, so the new column has to be in it, or the
API stops type-checking. `null` is "no coupon", as every order before 27c.

### Check this part

```bash
pnpm --filter @omnivo/db build && pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/api typecheck        # clean again (the fixture above)
pnpm --filter @omnivo/app typecheck        # clean
pnpm db:migrate                            # 0073 and 0074
```

`pnpm --filter @omnivo/shop typecheck` still fails as after 27c.1 (the mock's quote, 27c.7), and so does
`apps/api/src/contract.spec.ts` (the 6 coupon routes, 27c.3).

What was checked on a throwaway Postgres 17, migrated to the end, with 27a.2's two launched shops (Acme and Beta), four
Acme coupons (`WELCOME10` with 3 uses allowed and an order, `FLAT50` with none, `OLD10` archived, and one with an
order but no `first_ordered_at`), Beta's own `WELCOME10`, and Acme orders with `WELCOME10`: confirmed, pending and
fresh, pending and 2 hours old, and cancelled. As `omnivo_app`:

- a lower-case code, a code with a space, a percent of 10.5 or 100, an amount of ৳10.555 or ৳0, an amount with "up
  to", "up to" ৳0, a minimum of ৳499.999, a last day before the first, and 0 or 1,000,001 uses are each refused by
  their check; a one-day coupon, ৳25.50 off, 99% up to ৳200.50 from ৳0.01 with one use are kept;
- `OLD10` again is refused even though the old one is archived, Beta's `WELCOME10` does not collide, and a coupon for
  Beta is refused by `tenant_isolation`;
- an order with the id but not the code, or with no coupon but a discount, is refused by
  `storefront_orders_coupon_check`; an order with `FLAT50` as the code of `WELCOME10`, or Beta's coupon, by
  `storefront_orders_coupon_fk`; a coupon order with a discount of ৳0 is kept;
- `WELCOME10`'s code cannot change (`storefront_coupons_code_locked`), nor its `first_ordered_at`, to NULL or to
  another time (`storefront_coupons_first_ordered_kept`); its discount, its limit and its archive can; `FLAT50`'s code
  can change and change back; the coupon with an order but no `first_ordered_at` still cannot change its code (the
  foreign key);
- `storefront_coupon_uses` gives 2 for `WELCOME10` (the confirmed and the fresh pending one), 1 for the phone of the
  confirmed one (its old pending order is past the hold), 1 for the fresh pending one's phone, 0 for the cancelled
  one's, 3 with a 3-hour hold, and 0 for Beta's coupon asked from Acme.

As `omnivo_public`: it sees the five current coupons and not `OLD10`, gets the same count of 2, cannot read
`storefront_orders` at all (not even `coupon_id`), and cannot write a coupon. With the shop not launched, it sees no
coupon.

As `omnivo_shop`: it can lock `WELCOME10` (`FOR UPDATE`) and not `OLD10` (no row), can set `FLAT50`'s
`first_ordered_at`, cannot change a coupon's discount, code or limit, or delete one (42501); an order it places with
`WELCOME10` makes the count 3, and one that names `FLAT50` as `WELCOME10`'s code is refused by the foreign key.

Two races, each with two real connections:

- **The last use.** `WELCOME10` has 3 uses and 2 are taken. Two shoppers place an order at once; each takes the lock,
  then inserts its order only when `storefront_coupon_uses(…) < usage_limit`. The first holds the lock for 2 seconds;
  the second waits, then counts 3 and inserts nothing. One order got the last use.
- **A new code under a first order.** The shop's role sets `FLAT50`'s `first_ordered_at` and holds the lock for 2
  seconds; the Coupons page's `UPDATE … SET code = 'FLAT-50'` starts half a second later, waits, and is refused by
  `storefront_coupons_code_locked`.

With 5,000 Acme orders that have `WELCOME10` and 20,000 without a coupon, the count's query, run as the function's
owner under row security, is an index only scan of `storefront_orders_coupon_idx`.

Broken on purpose, each caught:

- the guard trigger dropped: `WELCOME10`'s new code is refused by the foreign key, not by
  `storefront_coupons_code_locked`, and the check says so (and the dropped pending orders would no longer lock it);
- the function without the hold (every pending order counts): "WELCOME10 has 2 uses" fails;
- the archived policy dropped: `omnivo_public` sees `OLD10`;
- `GRANT UPDATE (discount_value) … TO omnivo_shop`: the shop's role can change a discount;
- the function as `SECURITY INVOKER`: `omnivo_public` gets "permission denied for table storefront_orders".

## 27c.3 — API

The API now knows coupons in four places: the Coupons page's six routes, the shop's quote, placing an order, and
the ERP documents an order makes. Everything the shop does with a coupon goes through one small file,
`coupon-sql.ts`, so the rules about locks and counts are written once.

Mine, made while writing this part:

23. **A coupon may be made before the shop is set up or open.** The shop's policies hide every coupon until the shop
    is launched (27c.2), so a tenant can have `WELCOME10` ready for the first day. The Catalog needs a shop first
    because a listing needs a shop category; a coupon needs nothing.
24. **Placing an order locks the cart's variants first and the coupon last.** Every order takes its locks in that
    one order, so two orders can never wait for each other in a circle.
25. **A code the checkout already showed as refused does not stop the order.** It takes nothing off in the quote,
    so the total matches, and the order is placed without the code (the promo box said why). Only an applied code
    is kept on the order.
26. **The invoice carries the discount too.** 27b's Delivered step built the invoice lines with a discount of 0,
    because a shop order had none. Each challan line now gets its share of its sales order line's discount, so the
    invoice bills what the shopper pays.

### The shop's coupon reads

```ts
import {
  DEFAULT_SETTINGS,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopCouponRule,
  todayIn,
} from '@omnivo/contracts';
import { storefrontCoupons, tenantSettings } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { ShopScope } from './shop-db.js';

type CouponRow = typeof storefrontCoupons.$inferSelect;

// Step 27c: a coupon as the shop's side of the API reads it: the quote (omnivo_public) and placing
// an order (omnivo_shop). The ERP's Coupons page has its own service (admin/coupons.service.ts),
// but counts a use with the same database function.

// A coupon the shop knows, with what judgeShopCoupon() needs. `id` and `code` go on the order
export interface ShopCoupon {
  id: string;
  rule: ShopCouponRule;
  used: number;
}

// What quoteCart() gets besides the cart: the coupon with the code the cart names (undefined when
// the cart names none, or the shop has no such coupon), and today in the shop's time zone, for its
// first and last day
export interface QuoteCoupon {
  coupon: ShopCoupon | undefined;
  today: string;
}

const usedSchema = z.array(z.object({ used: z.number().int() }));

// The start of the hold: a pending order older than this has lost its stock and its use
// (storefront_coupon_uses, 0074). The same rule as the verify page's waitingOrder()
export function holdStart(shop: ShopScope): Date {
  return new Date(shop.now.getTime() - SHOP_ORDER_HOLD_MINUTES * 60 * 1000);
}

// Today in the shop's time zone, by ShopDb's clock (the one the order and its hold use)
export async function shopToday(tx: Transaction, shop: ShopScope): Promise<string> {
  const [workspace] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, shop.tenantId));
  return todayIn(workspace?.timezone ?? DEFAULT_SETTINGS.timezone, shop.now);
}

function ruleOf(row: CouponRow): ShopCouponRule {
  return {
    code: row.code,
    // A percent is a whole number in a numeric(19,4) column ("10.0000"), and ShopDiscount keeps it
    // as a number, as the listings' sale does
    discount:
      row.discountKind === 'percent'
        ? { kind: 'percent', value: Number(row.discountValue) }
        : { kind: 'amount', value: row.discountValue },
    upTo: row.upTo,
    minimum: row.minimum,
    startsOn: row.startsOn,
    lastDay: row.lastDay,
    usageLimit: row.usageLimit,
    onePerPhone: row.onePerPhone,
  };
}

// The quote's read: the coupon and its uses in one statement. Archived coupons, and every coupon
// of a shop that is not launched, are hidden from omnivo_public by 0074's policies, so they are
// "unknown" here without a word of TypeScript. The code is compared as typed:
// shopCouponCodeSchema upper-cased it, like the column
export async function quotedCoupon(
  tx: Transaction,
  shop: ShopScope,
  code: string | undefined,
): Promise<QuoteCoupon> {
  const today = await shopToday(tx, shop);
  if (code === undefined) return { coupon: undefined, today };
  const [row] = await tx
    .select({
      coupon: storefrontCoupons,
      used: sql<number>`storefront_coupon_uses(${storefrontCoupons.id}, ${holdStart(shop).toISOString()}::timestamptz)`.mapWith(
        Number,
      ),
    })
    .from(storefrontCoupons)
    .where(and(eq(storefrontCoupons.tenantId, shop.tenantId), eq(storefrontCoupons.code, code)));
  return {
    coupon:
      row === undefined
        ? undefined
        : { id: row.coupon.id, rule: ruleOf(row.coupon), used: row.used },
    today,
  };
}

async function usesOf(
  tx: Transaction,
  shop: ShopScope,
  couponId: string,
  phone: string | null,
): Promise<number> {
  const [row] = usedSchema.parse(
    await tx.execute(
      sql`SELECT storefront_coupon_uses(${couponId}::uuid, ${holdStart(shop).toISOString()}::timestamptz, ${phone}::text) AS used`,
    ),
  );
  // A function call always answers one row; the check is for TypeScript
  if (row === undefined) throw new Error('storefront_coupon_uses answered no row');
  return row.used;
}

// Placing an order's read (decision 3). Two statements, on purpose:
// 1. the coupon's row FOR UPDATE: a second shopper with the same code waits here until the first
//    one's order is committed (or rolled back). omnivo_shop may lock it because it may UPDATE one
//    of its columns (first_ordered_at, 0074)
// 2. the uses, in a NEW statement. Under READ COMMITTED each statement sees what was committed
//    when it started: a count in the locking statement would be the snapshot from before the wait,
//    and would miss the order the first shopper just placed. The second statement sees it, so two
//    shoppers can never both take the last use
// The caller has locked the cart's variants already; every order takes the variants first and the
// coupon last, so two orders never wait for each other in a circle
export async function lockedCoupon(
  tx: Transaction,
  shop: ShopScope,
  code: string | undefined,
): Promise<QuoteCoupon> {
  const today = await shopToday(tx, shop);
  if (code === undefined) return { coupon: undefined, today };
  const [row] = await tx
    .select()
    .from(storefrontCoupons)
    .where(and(eq(storefrontCoupons.tenantId, shop.tenantId), eq(storefrontCoupons.code, code)))
    .for('update');
  if (row === undefined) return { coupon: undefined, today };
  return {
    coupon: { id: row.id, rule: ruleOf(row), used: await usesOf(tx, shop, row.id, null) },
    today,
  };
}

// Once per mobile number: has this phone an order that holds a use of the coupon now? A cancelled
// one gave its use back, and so did a pending one past its hold. Only placing an order asks: the
// quote does not know the phone yet
export async function usedByPhone(
  tx: Transaction,
  shop: ShopScope,
  couponId: string,
  phone: string,
): Promise<boolean> {
  return (await usesOf(tx, shop, couponId, phone)) > 0;
}

// The first order with the code freezes it (decision 16, 0074's guard). Raw SQL, not drizzle's
// update(): the table's updated_at has $onUpdate, so drizzle would set it as well, and omnivo_shop
// may UPDATE first_ordered_at only (42501). Only while it is still empty: the guard refuses to
// change it once set, and a later order has nothing to add. The row is locked already
// (lockedCoupon), so no other order can set it in between
export async function markOrdered(tx: Transaction, shop: ShopScope, couponId: string) {
  await tx.execute(
    sql`UPDATE storefront_coupons SET first_ordered_at = ${shop.now.toISOString()}::timestamptz
         WHERE tenant_id = ${shop.tenantId}::uuid AND id = ${couponId}::uuid
           AND first_ordered_at IS NULL`,
  );
}
```

- **`ShopCoupon` keeps the id next to the rule.** The rule (`ShopCouponRule`, 27c.1) is what the contracts judge;
  the id is what the order stores and what the count asks for. The rule has no id on purpose: the shop's mock
  judges coupons with the same type and has no database ids to give.
- **`holdStart()` is "now minus the hold", from ShopDb's clock.** The count function (27c.2) takes it as an
  argument, so the minutes stay in the contracts (`SHOP_ORDER_HOLD_MINUTES`), and the order, its stock hold and its
  use of the coupon all end at the same moment. The date goes into SQL as an ISO string with a `::timestamptz` cast:
  a raw `sql` template does not know the column type, and a string with a cast is read the same way by every
  driver.
- **`shopToday()` passes `shop.now` to `todayIn()`.** A coupon's first and last days are whole days in the shop's
  time zone. Using ShopDb's own clock (not a second `new Date()`) means a request a few milliseconds before midnight
  judges the days and stamps the order with the same time.
- **`ruleOf()` turns the percent into a number.** The column is `numeric(19,4)`, so a 10% coupon reads back as
  `"10.0000"`; `ShopDiscount` keeps a percent as a number, like a listing's sale. The database check (whole
  numbers 1 to 99) makes `Number()` exact here.
- **The quote reads the coupon and its uses in one statement.** No lock: a quote promises nothing, and placing the
  order judges the code again. Archived coupons, and every coupon of a shop that is not launched, are hidden from
  `omnivo_public` by 0074's policies, so they come back as "no row", which is "unknown" to the shopper, without any
  check in TypeScript. The code is compared as it is: `shopCouponCodeSchema` already upper-cased what was typed.
- **`lockedCoupon()` is two statements, and the comment says why.** Under READ COMMITTED, the default, each
  statement sees the data committed when it started. The `FOR UPDATE` statement waits for a second shopper's lock and
  then re-reads only the locked row; a count in that same statement would still use the old snapshot and miss the
  order the first shopper just committed. The count in a new statement sees it. This is what makes "two shoppers
  can never both take the last use" true; 27c.4 tests it with two real requests.
- **`omnivo_shop` may lock the row because it may update one column** (`first_ordered_at`, 0074). Postgres asks for
  UPDATE on at least one column before it allows `SELECT … FOR UPDATE`.
- **`usedByPhone()` reuses the same function with the phone.** Once per mobile number counts only the orders that
  hold a use now: a cancelled order gave its use back, and a pending one past its hold lost it. The phone is
  already in the shop's 11-digit form (`shopPhoneSchema`), the form the orders store.
- **`markOrdered()` is raw SQL, not drizzle's `update()`.** The table's `updated_at` has `$onUpdate`, so drizzle
  would set it too, and `omnivo_shop` may update `first_ordered_at` only: the query would fail with "permission
  denied" (42501). It sets the time only while it is empty, because the guard refuses to change it once set. The row
  is already locked, so no other order can set it in between.

### The quote

```diff
@@ -1,18 +1,21 @@
 import {
   compareMoney,
   compareQuantity,
+  judgeShopCoupon,
   multiplyMoney,
+  shopCouponDiscount,
   subtractMoney,
   sumMoney,
   type ShopCartQuote,
   type ShopCartQuoteLine,
   type ShopCartQuoteRequest,
   type ShopCheckoutSettings,
-  type ShopCouponResult,
   type ShopImage,
   type ShopListing,
 } from '@omnivo/contracts';
 
+import type { QuoteCoupon } from './coupon-sql.js';
+
 // A listing as the quote needs it: the card (price, stock) and the photo a cart line draws. The
 // line's photo is the small size (media.ts), the same as the card's, so it is the card's own.
 // Step 27a: and how much is free to sell (on hand minus held, in the base unit), as a decimal string
@@ -24,9 +27,11 @@ export interface QuotedListing {
 
 // Step 26f: the cart's prices, the same rules as the shop's mock (apps/shop/src/data/mock/quote.ts,
 // step 26c), so the drawer and the checkout do not change when the shop moves to this API. Each
-// line at the listing's price now, summed with the money helpers (never JavaScript numbers). Only
-// coupons differ: the ERP has none until step 27c, so a code is always refused as unknown. Step
+// line at the listing's price now, summed with the money helpers (never JavaScript numbers). Step
 // 27a: placing an order prices it with this same function, so the order and the last quote agree.
+// Step 27c: and the coupon is judged here too, with the contracts' rule (judgeShopCoupon), which
+// the shop's mock uses as well. `coupon` is the one the cart's code names, read by the caller
+// (quotedCoupon or lockedCoupon in coupon-sql.ts), so this function stays free of SQL.
 //
 // `listings` has only what the shop shows now: a listing that is unpublished, deleted, archived in
 // the ERP or without a price is not in it, and its line is 'unavailable'.
@@ -34,6 +39,7 @@ export function quoteCart(
   request: ShopCartQuoteRequest,
   listings: ReadonlyMap<string, QuotedListing>,
   settings: ShopCheckoutSettings,
+  { coupon: found, today }: QuoteCoupon,
 ): ShopCartQuote {
   const lines = request.lines.map((line): ShopCartQuoteLine => {
     const found = listings.get(line.listingId);
@@ -64,18 +70,14 @@ export function quoteCart(
   const sold = lines.filter((line) => line.status === 'available');
   const subtotal = sumMoney(sold.map((line) => line.lineTotal));
 
-  // No coupon takes anything off yet (see above). The promo box then says "This code does not
-  // exist", which is true of every code in a shop with no coupons
-  const coupon: ShopCouponResult =
-    request.couponCode === undefined
-      ? { status: 'none' }
-      : {
-          status: 'refused',
-          code: request.couponCode,
-          reason: 'shop_coupon_unknown',
-          minimum: null,
-        };
-  const discount = '0.0000';
+  // The reasons in their order (decision 15), on the items before the coupon. A refused code is an
+  // answer, never an error: the promo box says why, and the order goes ahead without it
+  const coupon = judgeShopCoupon(request.couponCode, found?.rule, {
+    subtotal,
+    today,
+    used: found?.used ?? 0,
+  });
+  const discount = coupon.status === 'applied' ? shopCouponDiscount(coupon, subtotal) : '0.0000';
 
   // Both rules look at the subtotal, the items before the coupon (step 26c's decision 8)
   const freeDelivery =
```

- **`quoteCart()` gets the coupon as an argument and stays free of SQL.** The caller reads it (`quotedCoupon` for
  the quote, `lockedCoupon` for an order), so the same pure function prices both, and its unit test needs no
  database.
- **`judgeShopCoupon()` and `shopCouponDiscount()` come from the contracts** (decision 14), the same functions the
  shop's mock uses in 27c.7. The rule looks at `subtotal`, the items before the coupon; the free delivery and the
  minimum order below still look at it too (26c's decision 8), so a coupon never takes a cart below the free-delivery
  line.
- **No coupon, or a refused one, takes `'0.0000'` off.** That keeps the order's database check (no coupon, no
  discount) true, and the total stays the old formula.

```diff
@@ -50,6 +50,7 @@ import {
   listingWith,
   selectListings,
 } from './listing-sql.js';
+import { quotedCoupon } from './coupon-sql.js';
 import { shopImage, type StorefrontImageSize } from './media.js';
 import { quoteCart, type QuotedListing } from './quote.js';
 import { ShopDb, type ShopScope, storefrontNotFound } from './shop-db.js';
@@ -202,7 +203,14 @@ export class PublicStorefrontService {
   quote(host: string | undefined, request: ShopCartQuoteRequest): Promise<ShopCartQuote> {
     return this.shopDb.read(host, async (tx, shop) => {
       const listings = await quotedListings(tx, shop, request.lines, this.mediaUrl);
-      return quoteCart(request, listings, await checkoutSettingsOf(tx, shop));
+      // Step 27c: the coupon the code names, with its uses now. No lock: a quote promises nothing,
+      // and placing the order judges the code again under the coupon's lock
+      return quoteCart(
+        request,
+        listings,
+        await checkoutSettingsOf(tx, shop),
+        await quotedCoupon(tx, shop, request.couponCode),
+      );
     });
   }
 
```

The quote route reads the coupon inside the same read-only transaction as the listings, so the price and the
coupon are from one moment.

### Placing an order

```diff
@@ -36,6 +36,7 @@ import type { Config } from '../../config.js';
 import { CONFIG } from '../../infra/tokens.js';
 import { codeSms, confirmedSms } from '../../sms/shop-sms.js';
 import { SmsQueue } from '../../sms/sms-queue.js';
+import { lockedCoupon, markOrdered, usedByPhone } from '../coupon-sql.js';
 import { checkoutSettingsOf, quotedListings } from '../public-storefront.service.js';
 import { quoteCart } from '../quote.js';
 import { ShopDb, type ShopScope } from '../shop-db.js';
@@ -217,11 +218,14 @@ export class ShopOrdersService {
               )
               .orderBy(asc(storefrontListings.variantId));
       for (const { variantId } of variants) await lockVariant(tx, scope.tenantId, variantId);
+      // Step 27c: then the coupon's row, and its uses counted after the lock (lockedCoupon says
+      // why in two statements). A second shopper with the same code waits here for the first
+      const found = await lockedCoupon(tx, scope, request.couponCode);
 
       // The order is priced by the quote's own function from the rows a quote reads, so it is
       // exactly what the checkout showed, or it is refused
       const listings = await quotedListings(tx, scope, request.lines, this.mediaUrl);
-      const quote = quoteCart(request, listings, settings);
+      const quote = quoteCart(request, listings, settings, found);
       // Every line as it is in the cart: one out of stock or gone since the last quote would leave
       // the shopper with less than they chose (26c's decision 10). The checkout quotes again and
       // shows what changed
@@ -235,9 +239,28 @@ export class ShopOrdersService {
         });
       }
       // The total the shopper saw. A price or a sale that changed since the last quote shows here
+      // Step 27c: so is a coupon the last use of which went to another order a moment ago: the
+      // total without it is not the one the shopper saw, and the checkout's new quote says "used
+      // up". A code that was refused already in the checkout takes nothing off either way, and the
+      // order goes ahead without it (the promo box said why)
       if (compareMoney(quote.total, request.expectedTotal) !== 0) {
         throw refused(409, 'shop_order_changed', "The cart's prices or stock changed.");
       }
+      // The coupon the order keeps: only an applied one
+      const coupon = quote.coupon.status === 'applied' ? found.coupon : undefined;
+      // Once per mobile number, now that the phone is known. A thrown refusal rolls the whole
+      // transaction back, so no lock or mark outlives it
+      if (
+        coupon?.rule.onePerPhone === true &&
+        (await usedByPhone(tx, scope, coupon.id, request.phone))
+      ) {
+        throw refused(
+          422,
+          'shop_coupon_used_by_phone',
+          'This mobile number has an order with this coupon already.',
+        );
+      }
+      if (coupon !== undefined) await markOrdered(tx, scope, coupon.id);
 
       const [order] = await tx
         .insert(storefrontOrders)
@@ -255,8 +278,10 @@ export class ShopOrdersService {
           paymentMethod: request.paymentMethod,
           subtotal: quote.subtotal,
           discount: quote.discount,
-          // Coupons come in 27c; until then the quote applies none
-          couponCode: null,
+          // Step 27c: the id and the code together; the foreign key checks that they are one
+          // coupon's, so the order's page and its documents always say the coupon's own code
+          couponId: coupon?.id ?? null,
+          couponCode: coupon?.rule.code ?? null,
           // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
           deliveryCharge: quote.deliveryCharge ?? '0',
           total: quote.total,
```

- **The coupon's lock comes after the variants' locks** (decision 24). A second shopper with the same code waits
  at `lockedCoupon` until the first order is committed or rolled back, then counts again.
- **A use taken a moment ago shows as a changed total.** If the quote said "applied" and the last use is now gone,
  `quoteCart` refuses the code, the discount is 0, and the total is not the `expectedTotal` the shopper saw: the
  answer is 409 `shop_order_changed`, the same as a price that changed. The checkout quotes again and the promo box
  then says "used up". No new kind of answer was needed for the race.
- **Only an applied coupon goes on the order** (decision 25). `found.coupon` exists for a refused code too (an
  expired one, say), so the order takes it only when `quote.coupon.status === 'applied'`.
- **Once per phone is checked after the total**, because only an applied coupon can be "used". The refusal is 422
  `shop_coupon_used_by_phone`. It is thrown inside the transaction, so the coupon's lock, the variants' locks and
  anything written so far are rolled back with it.
- **`markOrdered()` runs only when the order goes ahead.** A refused order leaves the code free to change.
- **The order stores the id and the code together.** The foreign key from 27c.2 names both, so the code the order
  says is always its coupon's code.

### The sales order and the invoice

```diff
@@ -4,6 +4,7 @@ import {
   type CustomerInput,
   productInputSchema,
   type SalesLineInput,
+  spreadMoney,
   todayIn,
 } from '@omnivo/contracts';
 import {
@@ -167,14 +168,17 @@ export class ShopSalesOrderMaker {
   }
 
   // One sales order line per shop line, in the cart's order (its line number = the position), in
-  // the product's base unit at the shop's unit price (decision 3). No line discount: the shop's
-  // price is already what the shopper pays
+  // the product's base unit at the shop's unit price (decision 3). Step 27c: a coupon's discount is
+  // spread over these lines as amount discounts, in proportion to each line's total (decision 4),
+  // so the sales order's total is still the shop's. The delivery line gets none: a coupon never
+  // takes money off the delivery charge
   private async goodsLines(tx: Transaction, order: OrderRow): Promise<SalesLineInput[]> {
     const rows = await tx
       .select({
         variantId: storefrontOrderLines.variantId,
         quantity: storefrontOrderLines.quantity,
         unitPrice: storefrontOrderLines.unitPrice,
+        lineTotal: storefrontOrderLines.lineTotal,
         unitId: products.baseUnitId,
         taxRateId: rateOf,
       })
@@ -193,7 +197,11 @@ export class ShopSalesOrderMaker {
         ),
       )
       .orderBy(asc(storefrontOrderLines.position));
-    return rows.map((row) => ({
+    const discounts = lineDiscounts(
+      order.discount,
+      rows.map((row) => row.lineTotal),
+    );
+    return rows.map((row, index) => ({
       variantId: row.variantId,
       unitId: row.unitId,
       quantity: String(row.quantity),
@@ -201,7 +209,7 @@ export class ShopSalesOrderMaker {
       description: null,
       unitPrice: row.unitPrice,
       discountType: 'amount',
-      discount: '0',
+      discount: discounts[index] ?? '0',
       taxRateId: requireRate(row.taxRateId),
     }));
   }
@@ -325,6 +333,17 @@ export class ShopSalesOrderMaker {
   }
 }
 
+// A shop order's discount as one amount per goods line, to the paisa (spreadMoney: the largest
+// remainder rule, so the pieces add up to the discount exactly and none is more than its line).
+// A sales line's discount has at most 2 decimals (discountSchema), which spreadMoney's pieces
+// always have, and a line's total is quantity × price to the paisa (multiplyMoney), so the weights
+// are whole paisa too. No coupon, no spread: every line gets '0', as before step 27c.
+// Exported for its unit test
+export function lineDiscounts(discount: string, lineTotals: readonly string[]): string[] {
+  if (compareMoney(discount, '0') === 0) return lineTotals.map(() => '0');
+  return spreadMoney(discount, lineTotals);
+}
+
 // A product with no rate of its own in a workspace with no default rate: the sales order's own
 // error for a line without a valid rate, so the order page says what to fix
 function requireRate(taxRateId: string | null): string {
```

- **`goodsLines()` reads each shop line's total** and asks `lineDiscounts()` for the discounts. The delivery line
  is added after, with no discount: a coupon never takes money off the delivery charge (decision 2).
- **`lineDiscounts()` uses `spreadMoney()`** (decision 12): the shares add up to the discount exactly and none is
  more than its line, so the sales line check `sales_discount_too_large` can never fire. The weights are whole
  paisa because a line's total is `multiplyMoney()` (rounded to the paisa), and the shares have at most 2 decimals,
  which a sales line's discount needs (`discountSchema`).
- **The sales order's prices include VAT** (`createForShop`, 27b), and `lineAmounts()` takes the discount off the
  price as typed, before the VAT. So the sales order's total is subtotal − discount + delivery, which is the shop's
  total. A unit test checks this with real numbers.
- **No discount, no spread:** every line gets `'0'`, as before 27c, so an order without a coupon makes exactly the
  same sales order as in 27b.

```diff
@@ -1,9 +1,11 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  compareMoney,
   compareQuantity,
   type DocumentRef,
   type ErrorCode,
   isErrorCode,
+  multiplyMoney,
   type PackStorefrontOrderInput,
   type StorefrontOrder,
   type StorefrontOrderCounts,
@@ -15,6 +17,7 @@ import {
   type StorefrontOrderSummary,
   type StorefrontPackPlan,
   storefrontImageSchema,
+  spreadMoney,
   sumQuantity,
   subtractQuantity,
   todayIn,
@@ -456,7 +459,10 @@ export class StorefrontOrdersService {
       if (!branch) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
 
       // Each challan line at its order line's price and VAT rate; then the delivery charge, the
-      // sales order's lines after the order's own (the maker added it last)
+      // sales order's lines after the order's own (the maker added it last). Step 27c: and with
+      // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
+      // would bill more than the shopper pays
+      const discounts = challanDiscounts(challan, soLineById);
       const goods = challan.map((line) => {
         const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
         if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
@@ -467,7 +473,7 @@ export class StorefrontOrdersService {
           description: soLine.description,
           unitPrice: soLine.unitPrice,
           discountType: 'amount' as const,
-          discount: '0',
+          discount: discounts.get(line.id) ?? '0',
           taxRateId: soLine.taxRateId,
           deliveryLineId: line.id,
           orderLineId: null,
@@ -957,3 +963,33 @@ function fefo(
   }
   return picks;
 }
+
+// Step 27c: each challan line's share of its sales order line's discount, by challan line id. A
+// line packed from two batches is two challan lines of one order line, so the order line's
+// discount is spread over them by what each is worth at the order's price (spreadMoney: to the
+// paisa, adding up to the discount exactly). One challan line per order line, the usual case,
+// takes the whole discount. The maker wrote every discount of a shop's sales order as an amount
+// (sales-order-maker.ts); a line without one gets none. Exported for its unit test
+export function challanDiscounts(
+  challan: readonly { id: string; orderLineId: string | null; quantity: string }[],
+  orderLines: ReadonlyMap<string, { discountType: string; discount: string; unitPrice: string }>,
+): Map<string, string> {
+  const byOrderLine = new Map<string, { id: string; quantity: string }[]>();
+  for (const line of challan) {
+    if (line.orderLineId === null) continue;
+    byOrderLine.set(line.orderLineId, [...(byOrderLine.get(line.orderLineId) ?? []), line]);
+  }
+  const shares = new Map<string, string>();
+  for (const [orderLineId, lines] of byOrderLine) {
+    const orderLine = orderLines.get(orderLineId);
+    if (orderLine?.discountType !== 'amount' || compareMoney(orderLine.discount, '0') === 0) {
+      continue;
+    }
+    const pieces = spreadMoney(
+      orderLine.discount,
+      lines.map((line) => multiplyMoney(line.quantity, orderLine.unitPrice)),
+    );
+    lines.forEach((line, index) => shares.set(line.id, pieces[index] ?? '0'));
+  }
+  return shares;
+}
```

- **Without this change the invoice would bill more than the shopper pays** (decision 26). 27b built each invoice
  line from its challan line with a discount of 0.
- **`challanDiscounts()` groups the challan lines by their order line.** A product packed from two batches is two
  challan lines of one order line, so that line's discount is spread over them by what each is worth at the order's
  price. One challan line per order line, the usual case, takes the whole discount.
- **Only amount discounts are spread.** The maker writes every discount of a shop's sales order as an amount, so a
  percent can only come from a sales order made by hand, which this path never bills.
- **The delivery charge's line keeps a discount of 0**: its sales order line has none.

### The Coupons page

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  addMoney,
  type CreateStorefrontCouponInput,
  DEFAULT_SETTINGS,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopDiscount,
  type StorefrontCoupon,
  type StorefrontCouponPage,
  type storefrontCouponQuerySchema,
  storefrontCouponStatus,
  todayIn,
  type UpdateStorefrontCouponInput,
} from '@omnivo/contracts';
import { storefrontCoupons, tenantSettings } from '@omnivo/db';
import { and, desc, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../../common/audit/audit.js';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '../../common/db/pg-errors.js';
import { containsPattern } from '../../common/db/search.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { isoText } from '../listing-sql.js';

type CouponRow = typeof storefrontCoupons.$inferSelect;
type CouponQuery = z.output<typeof storefrontCouponQuerySchema>;
// What the form saves: the same boxes for a new coupon and a change (less the version)
type CouponFields = Omit<UpdateStorefrontCouponInput, 'version'>;

// [created_at as text, id]: newest first. The time as Postgres's own text to the microsecond
// (isoText): a JavaScript Date keeps milliseconds only, and a cursor cut to the millisecond would
// show a coupon made in the same millisecond on two pages, or on none
const cursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

// The orders that hold a use now, counted by the database function the shop uses (0074), so the
// list's "12 of 100 used" is the number the quote judges by. A pending order counts only inside
// its hold, measured from the database's clock here (the ERP has no ShopDb clock)
const used =
  sql<number>`storefront_coupon_uses(${storefrontCoupons.id}, now() - make_interval(mins => ${SHOP_ORDER_HOLD_MINUTES}))`.mapWith(
    Number,
  );

function codeTaken(): AppError {
  return new AppError(409, 'storefront_coupon_code_taken', 'Another coupon has this code.', {
    fieldErrors: { code: ['storefront_coupon_code_taken'] },
  });
}

function codeLocked(): AppError {
  return new AppError(
    409,
    'storefront_coupon_code_locked',
    'An order has had this code, so it can no longer change.',
    { fieldErrors: { code: ['storefront_coupon_code_locked'] } },
  );
}

// The database's answers in the form's words. The code's unique key covers archived coupons too.
// A new code after an order had the old one is refused twice over: by 0074's guard (any order
// ever placed, first_ordered_at) and by the orders' foreign key, which names the code (an order
// that still exists). The check below in TypeScript gives the same answer first; these catch the
// race in which the first order lands while the form is being saved
function mapped(error: unknown): unknown {
  if (isUniqueViolation(error, 'storefront_coupons_code_key')) return codeTaken();
  if (
    isCheckViolation(error, 'storefront_coupons_code_locked') ||
    isForeignKeyViolation(error, 'storefront_orders_coupon_fk')
  ) {
    return codeLocked();
  }
  return error;
}

// The discount for the audit log as one short value, "percent 10" or "amount 50.0000", like a
// listing's sale, so a change reads "percent 10 → percent 15"
function discountText(discount: ShopDiscount): string {
  return discount.kind === 'percent'
    ? `percent ${String(discount.value)}`
    : `amount ${addMoney(discount.value, '0')}`;
}

function discountOf(row: CouponRow): ShopDiscount {
  // A percent is a whole number in a numeric(19,4) column ("10.0000")
  return row.discountKind === 'percent'
    ? { kind: 'percent', value: Number(row.discountValue) }
    : { kind: 'amount', value: row.discountValue };
}

// Plain values only (auditValueSchema). The amounts through addMoney, so "50" typed and "50.0000"
// read back are one value and an unchanged box is no change
function snapshot(coupon: CouponFields) {
  return {
    code: coupon.code,
    discount: discountText(coupon.discount),
    upTo: coupon.upTo === null ? null : addMoney(coupon.upTo, '0'),
    minimum: coupon.minimum === null ? null : addMoney(coupon.minimum, '0'),
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
  };
}

function fieldsOf(row: CouponRow): CouponFields {
  return {
    code: row.code,
    discount: discountOf(row),
    upTo: row.upTo,
    minimum: row.minimum,
    startsOn: row.startsOn,
    lastDay: row.lastDay,
    usageLimit: row.usageLimit,
    onePerPhone: row.onePerPhone,
  };
}

// The columns the form writes, from the checked input
function columnsOf(input: CouponFields) {
  return {
    code: input.code,
    discountKind: input.discount.kind,
    discountValue: String(input.discount.value),
    upTo: input.upTo,
    minimum: input.minimum,
    startsOn: input.startsOn,
    lastDay: input.lastDay,
    usageLimit: input.usageLimit,
    onePerPhone: input.onePerPhone,
  };
}

// Step 27c: Storefront → Coupons (decision 5, storefront.manage). A coupon may be made before the
// shop is set up or open: the shop's policies hide every coupon until it is launched, so a tenant
// can have WELCOME10 ready for the first day. Never deleted (decision 18): an order points at it.
@Injectable()
export class StorefrontCouponsService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  list(q: CouponQuery): Promise<StorefrontCouponPage> {
    return this.withTenant(async (tx) => {
      const today = await this.today(tx);
      const filters: SQL[] = [
        eq(storefrontCoupons.tenantId, getTenantId()),
        q.view === 'archived'
          ? isNotNull(storefrontCoupons.archivedAt)
          : isNull(storefrontCoupons.archivedAt),
      ];
      // Part of the code. The schema upper-cased it like the codes, and containsPattern lower-
      // cases it again, so the column is compared lower-cased too (and LIKE's % and _ are literal)
      if (q.search !== undefined && q.search !== '') {
        filters.push(sql`lower(${storefrontCoupons.code}) LIKE ${containsPattern(q.search)}`);
      }
      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [createdAt, id] = cursor;
        filters.push(
          sql`(${storefrontCoupons.createdAt}, ${storefrontCoupons.id}) < (${createdAt}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = await tx
        .select({
          coupon: storefrontCoupons,
          used,
          createdKey: isoText(sql`${storefrontCoupons.createdAt}`).mapWith(String),
        })
        .from(storefrontCoupons)
        .where(and(...filters))
        // storefront_coupons_list_idx
        .orderBy(desc(storefrontCoupons.createdAt), desc(storefrontCoupons.id))
        .limit(q.limit + 1);
      const page = toPage(rows, q.limit, (last) => [last.createdKey, last.coupon.id]);
      return {
        items: page.items.map((row) => couponOf(row.coupon, row.used, today)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<StorefrontCoupon> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: CreateStorefrontCouponInput): Promise<StorefrontCoupon> {
    try {
      return await this.withTenant(async (tx) => {
        const [row] = await tx
          .insert(storefrontCoupons)
          .values({
            tenantId: getTenantId(),
            ...columnsOf(input),
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Coupon insert returned no row');
        await audit(tx, {
          action: 'storefront_coupon.created',
          entityType: 'storefront_coupon',
          entityId: row.id,
          changes: created(snapshot(input)),
        });
        return couponOf(row, 0, await this.today(tx));
      });
    } catch (error) {
      throw mapped(error);
    }
  }

  async update(id: string, input: UpdateStorefrontCouponInput): Promise<StorefrontCoupon> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lock(tx, id);
        if (before.version !== input.version) throw versionConflict();
        // Decision 2: once an order has had the code, the code stays. The rest may change: a
        // later last day, a bigger limit. An order already placed keeps what it was given
        if (before.firstOrderedAt !== null && input.code !== before.code) throw codeLocked();
        await this.write(tx, id, columnsOf(input));
        await audit(tx, {
          action: 'storefront_coupon.updated',
          entityType: 'storefront_coupon',
          entityId: id,
          changes: diff(snapshot(fieldsOf(before)), snapshot(input)),
        });
        return this.read(tx, id);
      });
    } catch (error) {
      throw mapped(error);
    }
  }

  // Archived: the shop no longer knows the code (0074's policy), so the quote answers "unknown".
  // An order placed with it keeps its discount. Restoring gives it back with its uses as they are
  setArchived(id: string, version: number, archived: boolean): Promise<StorefrontCoupon> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== version) throw versionConflict();
      if ((before.archivedAt !== null) !== archived) {
        await this.write(tx, id, { archivedAt: archived ? new Date() : null });
        await audit(tx, {
          action: archived ? 'storefront_coupon.archived' : 'storefront_coupon.restored',
          entityType: 'storefront_coupon',
          entityId: id,
        });
      }
      return this.read(tx, id);
    });
  }

  // FOR UPDATE: two saves of one coupon take turns, and the version check sees the first one's.
  // Placing an order locks the same row, so a code change waits for an order that is being placed
  private async lock(tx: Transaction, id: string): Promise<CouponRow> {
    const [row] = await tx
      .select()
      .from(storefrontCoupons)
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)))
      .for('update');
    if (!row) throw notFound('Coupon');
    return row;
  }

  // Every ERP change moves the version, so a form open elsewhere reloads first. Placing an order
  // never does (markOrdered sets first_ordered_at only): the form may still save, and a new code
  // is then refused on its own (codeLocked)
  private async write(
    tx: Transaction,
    id: string,
    columns: Partial<ReturnType<typeof columnsOf>> & { archivedAt?: Date | null },
  ): Promise<void> {
    await tx
      .update(storefrontCoupons)
      .set({
        ...columns,
        version: sql`${storefrontCoupons.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)));
  }

  private async read(tx: Transaction, id: string): Promise<StorefrontCoupon> {
    const [row] = await tx
      .select({ coupon: storefrontCoupons, used })
      .from(storefrontCoupons)
      .where(and(eq(storefrontCoupons.tenantId, getTenantId()), eq(storefrontCoupons.id, id)));
    if (!row) throw notFound('Coupon');
    return couponOf(row.coupon, row.used, await this.today(tx));
  }

  // The status pill's today: the workspace's, like the coupon's days (decision 2)
  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? DEFAULT_SETTINGS.timezone);
  }
}

function couponOf(row: CouponRow, usedNow: number, today: string): StorefrontCoupon {
  const archivedAt = row.archivedAt?.toISOString() ?? null;
  return {
    id: row.id,
    ...fieldsOf(row),
    used: usedNow,
    // Decision 16: any order ever placed with the code, a cancelled or dropped one too
    codeLocked: row.firstOrderedAt !== null,
    status: storefrontCouponStatus(
      {
        archivedAt,
        startsOn: row.startsOn,
        lastDay: row.lastDay,
        usageLimit: row.usageLimit,
        used: usedNow,
      },
      today,
    ),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

- **The cursor uses Postgres's own text of `created_at`** (`isoText`, to the microsecond). A JavaScript `Date` keeps
  milliseconds only: two coupons made in the same millisecond, or a cursor cut to the millisecond, would show a
  coupon on two pages or on none.
- **`used` is counted by the same function the shop uses**, so "12 of 100 used" is the number the quote judges by.
  The hold is measured from the database's clock (`now()`) here, because the ERP has no ShopDb clock; inside one
  transaction `now()` is one moment.
- **The search compares `lower(code)`**, because `containsPattern()` lower-cases the pattern (and escapes `%` and
  `_`), as every other searched list does.
- **`mapped()` turns three database refusals into the form's words.** The code's unique key covers archived
  coupons too (`storefront_coupon_code_taken`). A new code after an order is refused by the guard trigger and, while
  that order exists, by the order's foreign key: both mean `storefront_coupon_code_locked`.
- **`update()` checks the code in TypeScript first.** The answer is the same as the database's, but it comes before
  any write; the database's checks catch the race in which a first order lands while the form is being saved. Only
  the code is frozen: the last day, the limit and the discount may change, and an order already placed keeps what
  it was given.
- **Every ERP change moves the version**, so a form open in another tab must reload first. Placing an order never
  moves it (`markOrdered` sets one column), so a form may still save after an order; a new code is then refused on
  its own.
- **The audit snapshot is plain values** (`auditValueSchema`): the discount as "percent 10" or "amount 50.0000",
  the amounts through `addMoney`, so `"50"` typed and `"50.0000"` read back are one value and an unchanged box is not
  a change.
- **`codeLocked` is `first_ordered_at IS NOT NULL`** (decision 16): a cancelled order, or a pending one that was
  dropped, also had the code.
- **The status uses the workspace's today**, the same days as the shop.

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontCouponsService } from './coupons.service.js';

type Routes = typeof routes.storefrontCoupons;

// Step 27c: Storefront → Coupons, 6 routes behind storefront.manage (the contract says so; the
// guard reads it). Its own controller, as the contract has its own group, like 26h's. Thin on
// purpose: each one hands its parsed input to the service
@Controller()
export class StorefrontCouponsController {
  constructor(private readonly coupons: StorefrontCouponsService) {}

  @Endpoint(routes.storefrontCoupons.listCoupons)
  listCoupons({
    query,
  }: RouteInput<Routes['listCoupons']>): Promise<RouteResponse<Routes['listCoupons']>> {
    return this.coupons.list(query);
  }

  @Endpoint(routes.storefrontCoupons.getCoupon)
  getCoupon({
    params,
  }: RouteInput<Routes['getCoupon']>): Promise<RouteResponse<Routes['getCoupon']>> {
    return this.coupons.get(params.id);
  }

  @Endpoint(routes.storefrontCoupons.createCoupon)
  createCoupon({
    body,
  }: RouteInput<Routes['createCoupon']>): Promise<RouteResponse<Routes['createCoupon']>> {
    return this.coupons.create(body);
  }

  @Endpoint(routes.storefrontCoupons.updateCoupon)
  updateCoupon({
    params,
    body,
  }: RouteInput<Routes['updateCoupon']>): Promise<RouteResponse<Routes['updateCoupon']>> {
    return this.coupons.update(params.id, body);
  }

  @Endpoint(routes.storefrontCoupons.archiveCoupon)
  archiveCoupon({
    params,
    body,
  }: RouteInput<Routes['archiveCoupon']>): Promise<RouteResponse<Routes['archiveCoupon']>> {
    return this.coupons.setArchived(params.id, body.version, true);
  }

  @Endpoint(routes.storefrontCoupons.restoreCoupon)
  restoreCoupon({
    params,
    body,
  }: RouteInput<Routes['restoreCoupon']>): Promise<RouteResponse<Routes['restoreCoupon']>> {
    return this.coupons.setArchived(params.id, body.version, false);
  }
}
```

Its own controller, because the contract has its own group (`routes.storefrontCoupons`), like 26h's Appearance
controller. The guard reads `storefront.manage` from the contract.

```diff
@@ -6,12 +6,14 @@ import { SalesModule } from '../sales/sales.module.js';
 import { StorefrontAppearanceService } from './admin/appearance.service.js';
 import { StorefrontCategoriesService } from './admin/categories.service.js';
 import { StorefrontCollectionsService } from './admin/collections.service.js';
+import { StorefrontCouponsService } from './admin/coupons.service.js';
 import { StorefrontImagesService } from './admin/images.service.js';
 import { StorefrontListingsService } from './admin/listings.service.js';
 import { StorefrontPagesService } from './admin/pages.service.js';
 import { StorefrontSettingsService } from './admin/settings.service.js';
 import { StorefrontAdminController } from './admin/storefront-admin.controller.js';
 import { StorefrontAppearanceController } from './admin/storefront-appearance.controller.js';
+import { StorefrontCouponsController } from './admin/storefront-coupons.controller.js';
 import { SmsQueue } from '../sms/sms-queue.js';
 import { ShopLimits } from './orders/shop-limits.js';
 import { ShopOrdersController } from './orders/shop-orders.controller.js';
@@ -31,7 +33,9 @@ import { ShopDb } from './shop-db.js';
 // adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send. Step 27b
 // adds Shop orders, the ERP's side of them (orders/storefront-orders.*): its moves make sales
 // documents with the sales services (SalesModule), and the "Delivery charge" service with
-// ProductsService
+// ProductsService. Step 27c adds Coupons (admin/coupons.service.ts, its own controller); the
+// quote and placing an order read a coupon through coupon-sql.ts, never through that service, for
+// the reason above
 @Module({
   imports: [AttachmentsModule, SalesModule, ProductsModule],
   controllers: [
@@ -40,6 +44,7 @@ import { ShopDb } from './shop-db.js';
     StorefrontAdminController,
     StorefrontAppearanceController,
     StorefrontOrdersController,
+    StorefrontCouponsController,
   ],
   providers: [
     ShopDb,
@@ -56,6 +61,7 @@ import { ShopDb } from './shop-db.js';
     StorefrontPagesService,
     ShopSalesOrderMaker,
     StorefrontOrdersService,
+    StorefrontCouponsService,
   ],
 })
 export class StorefrontModule {}
```

### Tests

```diff
@@ -6,6 +6,7 @@ import {
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
+import type { QuoteCoupon, ShopCoupon } from './coupon-sql.js';
 import { quoteCart, type QuotedListing } from './quote.js';
 
 const NEEM = '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a01';
@@ -49,8 +50,41 @@ const SETTINGS: ShopCheckoutSettings = {
   minimumOrder: '300.0000',
 };
 
-function quote(request: ShopCartQuoteRequest, settings = SETTINGS) {
-  const answer = quoteCart(request, LISTINGS, settings);
+// Step 27c: a cart that names no coupon, or one the shop does not have
+const TODAY = '2026-11-19';
+const NO_COUPON: QuoteCoupon = { coupon: undefined, today: TODAY };
+
+// WELCOME10: 10% off, up to ৳50, 3 orders, once per phone. FLAT50: ৳50 off from ৳300
+const WELCOME10: ShopCoupon = {
+  id: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a20',
+  rule: {
+    code: 'WELCOME10',
+    discount: { kind: 'percent', value: 10 },
+    upTo: '50.0000',
+    minimum: null,
+    startsOn: null,
+    lastDay: null,
+    usageLimit: 3,
+    onePerPhone: true,
+  },
+  used: 1,
+};
+const FLAT50: ShopCoupon = {
+  id: '7c1e5d1a-1d1f-4f4e-9b65-3a0f7f1c2a21',
+  rule: {
+    ...WELCOME10.rule,
+    code: 'FLAT50',
+    discount: { kind: 'amount', value: '50.0000' },
+    upTo: null,
+    minimum: '300.0000',
+    usageLimit: null,
+    onePerPhone: false,
+  },
+  used: 0,
+};
+
+function quote(request: ShopCartQuoteRequest, settings = SETTINGS, coupon = NO_COUPON) {
+  const answer = quoteCart(request, LISTINGS, settings, coupon);
   // Every answer goes out through the contract, so a test answer must pass it too
   expect(() => shopCartQuoteSchema.parse(answer)).not.toThrow();
   return answer;
@@ -81,7 +115,8 @@ describe('quoteCart (public API)', () => {
       [NEEM, quoted(NEEM, 'Himalaya Purifying Neem Face Wash', '229.0000', '2.0000')],
     ]);
     const lines = (quantity: number) =>
-      quoteCart({ lines: [{ listingId: NEEM, quantity }] }, few, SETTINGS).lines[0]?.status;
+      quoteCart({ lines: [{ listingId: NEEM, quantity }] }, few, SETTINGS, NO_COUPON).lines[0]
+        ?.status;
     expect(lines(2)).toBe('available');
     expect(lines(3)).toBe('out_of_stock');
   });
@@ -110,7 +145,7 @@ describe('quoteCart (public API)', () => {
     ).toBe(false);
   });
 
-  it('refuses every coupon as unknown, and takes nothing off', () => {
+  it('refuses a code the shop does not have as unknown, and takes nothing off', () => {
     const answer = quote({ lines: [{ listingId: NEEM, quantity: 1 }], couponCode: 'WELCOME10' });
     expect(answer.coupon).toEqual({
       status: 'refused',
@@ -120,4 +155,82 @@ describe('quoteCart (public API)', () => {
     });
     expect(answer).toMatchObject({ discount: '0.0000', total: '229.0000' });
   });
+
+  // Step 27c: the coupon off the items; the delivery charge and its free-delivery line stay on
+  // the items before the coupon (26c's decision 8)
+  it('takes an applied coupon off the items, cut to its "up to"', () => {
+    const welcome = { coupon: WELCOME10, today: TODAY };
+    // 10% of ৳458 = ৳45.80, under ৳50
+    expect(
+      quote(
+        {
+          lines: [{ listingId: NEEM, quantity: 2 }],
+          couponCode: 'WELCOME10',
+          zoneId: 'inside_dhaka',
+        },
+        SETTINGS,
+        welcome,
+      ),
+    ).toMatchObject({
+      coupon: { status: 'applied', code: 'WELCOME10', upTo: '50.0000' },
+      subtotal: '458.0000',
+      discount: '45.8000',
+      deliveryCharge: '80.0000',
+      total: '492.2000',
+    });
+    // 10% of ৳1,145 = ৳114.50, cut to ৳50; free delivery from ৳1,000 looks at the ৳1,145
+    expect(
+      quote(
+        {
+          lines: [{ listingId: NEEM, quantity: 5 }],
+          couponCode: 'WELCOME10',
+          zoneId: 'inside_dhaka',
+        },
+        SETTINGS,
+        welcome,
+      ),
+    ).toMatchObject({ discount: '50.0000', freeDelivery: true, total: '1095.0000' });
+  });
+
+  it('gives the reason a coupon does not apply, and takes nothing off', () => {
+    const cart = { lines: [{ listingId: STEVIA, quantity: 2 }], couponCode: 'FLAT50' };
+    // ৳240 of items, under FLAT50's ৳300
+    expect(quote(cart, SETTINGS, { coupon: FLAT50, today: TODAY })).toMatchObject({
+      coupon: { status: 'refused', reason: 'shop_coupon_minimum', minimum: '300.0000' },
+      discount: '0.0000',
+      total: '240.0000',
+    });
+    // Every use taken: used up, before the minimum
+    const usedUp = { ...FLAT50, rule: { ...FLAT50.rule, usageLimit: 4 }, used: 4 };
+    expect(quote(cart, SETTINGS, { coupon: usedUp, today: TODAY }).coupon).toMatchObject({
+      reason: 'shop_coupon_used_up',
+    });
+    // Its first day is tomorrow: unknown, so the box does not announce the sale
+    const tomorrow = { ...FLAT50, rule: { ...FLAT50.rule, startsOn: '2026-11-20' } };
+    expect(quote(cart, SETTINGS, { coupon: tomorrow, today: TODAY }).coupon).toMatchObject({
+      reason: 'shop_coupon_unknown',
+    });
+  });
+
+  it('never takes more off than the items cost', () => {
+    const big = {
+      ...FLAT50,
+      rule: {
+        ...FLAT50.rule,
+        discount: { kind: 'amount' as const, value: '500.0000' },
+        minimum: null,
+      },
+    };
+    expect(
+      quote(
+        {
+          lines: [{ listingId: STEVIA, quantity: 1 }],
+          couponCode: 'FLAT50',
+          zoneId: 'inside_dhaka',
+        },
+        SETTINGS,
+        { coupon: big, today: TODAY },
+      ),
+    ).toMatchObject({ subtotal: '120.0000', discount: '120.0000', total: '80.0000' });
+  });
 });
```

The old test "refuses every coupon as unknown" becomes "a code the shop does not have". New ones: an applied coupon
cut to its "up to" (with the free delivery still judged on the items before the coupon), the reasons in their order
(minimum, used up, not started = unknown), and a coupon worth more than the cart.

```ts
import { documentTotals, lineAmounts, sumMoney } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { lineDiscounts } from './sales-order-maker.js';
import { challanDiscounts } from './storefront-orders.service.js';

// Step 27c: a coupon's discount on the ERP's documents (decision 4)
describe('lineDiscounts (sales order)', () => {
  it('gives every line ৳0 when the order has no discount', () => {
    expect(lineDiscounts('0.0000', ['458.0000', '120.0000'])).toEqual(['0', '0']);
  });

  it('spreads the discount by line total, to the paisa, and the totals still agree', () => {
    // 2 × ৳229 and 1 × ৳120, WELCOME10 takes ৳57.80 off ৳578
    const lines = [
      { quantity: '2', unitPrice: '229.0000', lineTotal: '458.0000' },
      { quantity: '1', unitPrice: '120.0000', lineTotal: '120.0000' },
    ];
    const discounts = lineDiscounts(
      '57.8000',
      lines.map((line) => line.lineTotal),
    );
    expect(discounts).toEqual(['45.8000', '12.0000']);
    // The sales order prices include VAT (createForShop), so its total is the shop's ৳520.20
    const amounts = lines.map((line, index) =>
      lineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: 'amount',
          discount: discounts[index] ?? '0',
          rate: '15.00',
        },
        true,
      ),
    );
    expect(documentTotals(amounts)).toMatchObject({ discount: '57.8000', total: '520.2000' });
  });

  it('gives the left-over paisa to the line that lost the most', () => {
    // ৳10 over three lines of ৳50: 3.33 each, and the paisa left goes to the first (a tie)
    expect(lineDiscounts('10.0000', ['50.0000', '50.0000', '50.0000'])).toEqual([
      '3.3400',
      '3.3300',
      '3.3300',
    ]);
  });
});

describe('challanDiscounts (invoice)', () => {
  const orderLines = new Map([
    ['so-1', { discountType: 'amount', discount: '45.8000', unitPrice: '229.0000' }],
    ['so-2', { discountType: 'amount', discount: '0.0000', unitPrice: '120.0000' }],
  ]);

  it("gives a challan line its order line's discount, and none to a line without one", () => {
    const shares = challanDiscounts(
      [
        { id: 'dl-1', orderLineId: 'so-1', quantity: '2.0000' },
        { id: 'dl-2', orderLineId: 'so-2', quantity: '1.0000' },
      ],
      orderLines,
    );
    expect(shares.get('dl-1')).toBe('45.8000');
    expect(shares.has('dl-2')).toBe(false);
  });

  it('spreads it over the batches one order line was packed from, adding up exactly', () => {
    const shares = challanDiscounts(
      [
        { id: 'dl-1', orderLineId: 'so-1', quantity: '1.0000' },
        { id: 'dl-2', orderLineId: 'so-1', quantity: '1.0000' },
      ],
      new Map([['so-1', { discountType: 'amount', discount: '45.8100', unitPrice: '229.0000' }]]),
    );
    expect([shares.get('dl-1'), shares.get('dl-2')]).toEqual(['22.9100', '22.9000']);
    expect(sumMoney([...shares.values()])).toBe('45.8100');
  });
});
```

The spread on the sales order (with the sales order's own `lineAmounts` and `documentTotals`, so the total is
checked the way the sales order works it out) and on the invoice (one challan line, and two batches of one line).

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test             # unit tests, contract.spec now clean (the 6 routes)
pnpm exec eslint apps/api/src/storefront
pnpm --filter @omnivo/contracts gen:openapi
```

`gen:openapi` writes the six routes of 27c.1 into `packages/contracts/openapi.json` (a generated file: commit it,
never edit it by hand). CI's `pnpm test:openapi` fails while the file is older than the contracts.

`pnpm --filter @omnivo/shop typecheck` still fails as after 27c.1 (the mock's quote, 27c.7).

What was checked, besides the unit tests: the three storefront integration suites of 27a, 27b and 26f (57 tests)
still pass, and a throwaway integration test ran the whole path on the real stack: a coupon made on the Coupons
page, quoted (৳45.80 off two face washes), placed and confirmed with the phone code, the same phone refused, the
code change refused, the sales order with ৳45.80 on the goods line and ৳0 on the delivery line and a total of
৳492.20, packed, shipped and delivered, the invoice at ৳492.20, the second phone taking the last use, the third
quote "used up", the list's search, two pages by cursor, and an archived code answered as unknown. 27c.4 turns this
into the real tests, with the race for the last use.

Broken on purpose, each caught: the invoice's share given to the first challan line only (the batch test fails);
the quote without its "up to" (the up-to test fails); the once-per-phone check turned off (the throwaway test gets
201, not 422).

## 27c.4 — Tests

27c.3 was checked by one throwaway smoke test. This part replaces it with real tests: a new integration file for the
Coupons page and for everything the shop does with a code, and a new tenant-leak file. Both run against the real
stack. An order is placed and confirmed the way a shopper does it (the phone code comes from Mailpit), and the
worker's handler makes its sales order.

No code of 27c.3 changed: every test passed against it as it was.

Mine, made while writing this part:

27. **Races are sent in turn, not only together.** 27a's `atOnce()` lets any of the requests win, which is enough
    when all of them are the same. Here the two requests are different (two products, or an order and a save on
    the Coupons page), and the test must know which one got the lock first. `inTurn()` sends the next request only
    once the one before it waits.
28. **No free delivery in the coupon tests.** The test turns the shop's free delivery off once, so every order has
    a delivery line, and every test checks that the coupon leaves it alone.

### The coupon tests

The file is long, so it is shown in parts. First the helpers:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DEFAULT_SETTINGS,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  type ShopCartQuote,
  shopCartQuoteSchema,
  type ShopOrderRequestInput,
  type StorefrontCoupon,
  type StorefrontCouponFormValues,
  storefrontCouponPageSchema,
  storefrontCouponSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  todayIn,
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
} from '../../testing/shop-orders.js';
import { addListing } from '../../testing/storefront.js';
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 27c: the shop's coupons against the real stack. The Coupons page's six routes as the owner,
// as a member with storefront.manage and as one who may only read the orders; then the shop's side:
// the quote's reasons, a use counted from the order placed, once per phone, the last use and a code
// change when two requests come at the same moment, and the discount spread to the paisa from the
// order through the sales order, a challan of two batches and the invoice. Phones and shopper
// addresses start at 900 (phoneOf, clientAddress): the limits count per phone and per address, so
// no two tests share one.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.manage only: the Coupons page, and nothing of the orders
let manager: SignedIn;
// storefront.order.read only: the orders, and no coupon
let reader: SignedIn;
let shop: OrderShop;
// A batch product with two batches (SS-A 3 pieces, SS-B 10), so one line leaves in two challan lines
let sunscreen: { product: Product; listingId: string };
// A second product with stock of its own, for the race: two orders of one product would meet at
// the variant's lock and never at the coupon's
let tea: { listingId: string };

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });
const idSchema = z.array(z.object({ id: z.uuid() }));
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

// The coupon form as the page sends it: every box a string, '' for "none". 10% off with no cap,
// no minimum, no days and no limit, once per phone off, unless a test says otherwise
function form(code: string, extra: Partial<StorefrontCouponFormValues> = {}) {
  return {
    code,
    kind: 'percent',
    value: '10',
    upTo: '',
    minimum: '',
    startsOn: '',
    lastDay: '',
    usageLimit: '',
    onePerPhone: false,
    ...extra,
  } satisfies StorefrontCouponFormValues;
}

async function makeCoupon(
  code: string,
  extra: Partial<StorefrontCouponFormValues> = {},
  who = owner,
): Promise<StorefrontCoupon> {
  const res = await send('POST', '/storefront/coupons', form(code, extra), who);
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCouponSchema.parse(res.json());
}

async function getCoupon(id: string): Promise<StorefrontCoupon> {
  const res = await send('GET', `/storefront/coupons/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontCouponSchema.parse(res.json());
}

// A request that must be refused with this status; its problem's code and field errors
async function refused(res: Promise<{ statusCode: number; body: string }>, status: number) {
  const answer = await res;
  expect(answer.statusCode, answer.body).toBe(status);
  return refusalSchema.parse(JSON.parse(answer.body));
}

// Two face washes (৳229 each) plus the ৳80 delivery charge: ৳538, or ৳492.20 with 10% off
const TWO = '538';
const TWO_TEN_OFF = '492.2';

function twoNeem(n: number, couponCode?: string): ShopOrderRequestInput {
  const total = couponCode === undefined ? TWO : TWO_TEN_OFF;
  const request = orderRequest(shop.listingId, 2, phoneOf(n), total);
  return couponCode === undefined ? request : { ...request, couponCode };
}

// The checkout's quote of two face washes with this code. The quote has no phone, so its address
// is the same in every test; the quote route has no limit
async function quote(
  couponCode: string,
  lines = [{ listingId: shop.listingId, quantity: 2 }],
): Promise<ShopCartQuote> {
  const res = await shopPost(app, '/cart/quote', shopHeaders(shop.host, clientAddress(900)), {
    lines,
    zoneId: 'inside_dhaka',
    couponCode,
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCartQuoteSchema.parse(res.json());
}

// Places an order as shopper n; the answer as it is, for a test that expects a refusal
function place(n: number, request: ShopOrderRequestInput) {
  return shopPost(app, '/orders', shopHeaders(shop.host, clientAddress(n)), request);
}

async function orderIdOf(phone: string): Promise<string> {
  const [row] = idSchema.parse(
    await sql`
      SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`no order from ${phone}`);
  return row.id;
}

// Placed and confirmed with the code from Mailpit, as a shopper does it; the order once the
// worker's handler has made its sales order
async function confirmed(n: number, request: ShopOrderRequestInput): Promise<StorefrontOrder> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, request);
  const { code } = await codeFor(mail.apiUrl, request.phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const id = await orderIdOf(request.phone);
  return eventually(async () => {
    const order = storefrontOrderSchema.parse(
      (await send('GET', `/storefront/orders/${id}`)).json(),
    );
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

async function cancel(order: StorefrontOrder): Promise<void> {
  const res = await send('POST', `/storefront/orders/${order.id}/cancel`, {
    version: order.version,
    reason: 'Customer did not answer the phone',
  });
  expect(res.statusCode, res.body).toBe(200);
}

// The order as if placed `minutes` ago: a pending one past its hold (60 minutes) can no longer be
// confirmed, so its use is free again before any sweep deletes it
async function ageOrder(phone: string, minutes: number): Promise<void> {
  const by = `${String(minutes)} minutes`;
  await sql`
    UPDATE storefront_orders SET created_at = created_at - ${by}::interval
    WHERE tenant_id = ${shop.tenantId} AND phone = ${phone}`;
}

// Sends requests "at the same moment" for sure, and in a known order (27a's shop-orders.int.spec.ts
// has the long story of atOnce). A transaction of the test's own locks `table`; the first request
// is sent, and the next one only once the first waits for a lock (at that table, or at a lock the
// one before it holds). Once all of them wait, the gate opens. The first one sent is the first to
// reach the lock that matters, so the test knows which one wins
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
    // Wrapped: a promise returned alone (or in an array) would be awaited before the gate opens,
    // and the requests behind it would wait for ever
    return { all: Promise.all(sent) };
  });
  return gate.all;
}

// A day `days` after an ISO date, by the calendar (no time zone: the date has none)
function dayAfter(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const auditRowSchema = z.object({ action: z.string(), changes: z.unknown() });

async function auditOf(entityId: string) {
  return z.array(auditRowSchema).parse(
    await sql`
      SELECT action, payload -> 'changes' AS changes FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_id = ${entityId}
      ORDER BY created_at, id`,
  );
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

// Stock in with a cost, through a posted stock adjustment: the challan prices what leaves at the
// average cost, and a batch exists only once stock brought it in
function stockLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: product.variants[0]?.id ?? '',
    unitId: shop.unitId,
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost: '150',
    ...extra,
  };
}
```

- **Three people.** The owner; a manager with `storefront.manage` and nothing else; and a reader with
  `storefront.order.read` only. `member()` is 27b's: a user signs up for a workspace of their own, joins Nirvor with no
  role, and gets a role through the roles API. A role made in SQL could hold a permission the API would never give.
- **`form()`** is the Coupons form's body, typed with `satisfies StorefrontCouponFormValues`. The type is the form's
  input type, so every box is a string, as the page sends it, and a test that sends a wrong value on purpose (a
  percent of `100`) still type-checks. `satisfies` and not a type annotation: the result keeps `kind: 'percent'` as a
  literal, so a test may spread it and change one box.
- **`twoNeem()`** is the order most tests place: two face washes at ৳229 and the ৳80 delivery charge, ৳538, or
  ৳492.20 with 10% off. The expected total is part of the request, as the checkout sends it, so a coupon that takes
  off a different amount than the quote did is refused.
- **`quote()`** always uses the same shopper address (900): the quote route counts nothing, and it has no phone.
- **`place()`** returns the answer as it is, for the tests that expect a refusal. **`confirmed()`** places, reads the
  code from Mailpit, confirms, and waits until the worker's handler has made the sales order: a cancel needs the
  order as the Shop orders page sees it, with its version.
- **`ageOrder()`** moves only `created_at` back. That is all `storefront_coupon_uses()` looks at for a pending order
  (27c.2): a pending order older than the hold (60 minutes) no longer holds a use.
- **`inTurn()`** is the gate (decision 27). Like 27a's `atOnce()`, a transaction of the test's own locks a table in
  `SHARE` mode, so a request that writes there waits. The first request is sent, and the gate waits until one lock
  is not granted; then the next one, until two are not granted; and so on. The second request waits for a lock the
  first one holds (the coupon's row), so the order in which they get it is the order in which they were sent. The
  promises go back wrapped in an object: a promise returned on its own from `sql.begin()` would be awaited before
  the transaction ends, and the gate would never open.
- **`dayAfter()`** works on the calendar in UTC. The ISO day has no time zone, so this cannot move it by one day the
  way a local-time `Date` could near midnight.
- **`auditOf()`** reads `payload -> 'changes'`: the audit row keeps its changes inside the `payload` column.

```ts
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
  // Three: the gate's transaction, and the reads a test makes while the gate is shut
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 0 });
  // No free delivery: every order here has a delivery line, which a coupon must never touch
  await sql`
    UPDATE storefront_settings SET free_delivery_from = NULL WHERE tenant_id = ${shop.tenantId}`;
  const made = await send('POST', '/products', {
    code: '',
    name: 'Sunscreen SPF 50',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '450', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const sunscreenProduct = productSchema.parse(made.json());
  const neem = productSchema.parse((await send('GET', `/products/${shop.productId}`)).json());
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-11-01',
    warehouseId: shop.warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      stockLine(neem, '200'),
      // FEFO takes SS-A first: it expires first
      stockLine(sunscreenProduct, '3', { lotNumber: 'SS-A', expiresOn: '2027-03-31' }),
      stockLine(sunscreenProduct, '10', { lotNumber: 'SS-B', expiresOn: '2027-09-30' }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  sunscreen = {
    product: sunscreenProduct,
    listingId: await addListing(sql, shop.tenantId, {
      product: sunscreenProduct,
      categoryId: shop.categoryId,
      slug: 'sunscreen-spf-50',
      publishedDaysAgo: 1,
    }),
  };
  tea = await addShopProduct(app, sql, owner, shop, {
    name: 'Tulsi Green Tea',
    slug: 'tulsi-green-tea',
    price: '420',
    stock: 50,
  });
  manager = await member('sumi@nirvor.com', 'Sumi Akter', ['storefront.manage']);
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});
```

The shop sells three products. Neem Face Wash (200 pieces) is the one most tests order. Sunscreen SPF 50 has two
batches, `SS-A` (3 pieces) and `SS-B` (10), so four sunscreens leave in two challan lines. Tulsi Green Tea is only
for the race: two orders of the same product would wait at the product's own lock (`lockVariant`, 27a) and never
reach the coupon's row together. The free delivery is turned off with one `UPDATE` (decision 28).

`sql` has three connections: the gate holds one for its whole transaction, and the gate's own reads and a test's
reads need the others.

```ts
describe('the Coupons page', () => {
  it('makes, changes, archives and restores a coupon, and the audit log has each step', async () => {
    const coupon = await makeCoupon('welcome10', { upTo: '50', usageLimit: '100' });
    // The code upper-cased, the money to 4 decimals as the column keeps it, the percent a number
    expect(coupon).toMatchObject({
      code: 'WELCOME10',
      discount: { kind: 'percent', value: 10 },
      upTo: '50.0000',
      minimum: null,
      startsOn: null,
      lastDay: null,
      usageLimit: 100,
      onePerPhone: false,
      used: 0,
      codeLocked: false,
      status: 'active',
      version: 1,
    });
    expect(await getCoupon(coupon.id)).toEqual(coupon);

    // A start day after today is "scheduled"; the version moves on every save
    const today = todayIn(DEFAULT_SETTINGS.timezone);
    const changed = await send('PUT', `/storefront/coupons/${coupon.id}`, {
      ...form('WELCOME10', { upTo: '50', usageLimit: '100' }),
      startsOn: dayAfter(today, 1),
      lastDay: dayAfter(today, 30),
      version: coupon.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(storefrontCouponSchema.parse(changed.json())).toMatchObject({
      status: 'scheduled',
      version: 2,
    });
    // A form opened before that save: reload first
    const stale = await refused(
      send('PUT', `/storefront/coupons/${coupon.id}`, { ...form('WELCOME10'), version: 1 }),
      409,
    );
    expect(stale.code).toBe('version_conflict');

    const archived = await send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 2 });
    expect(storefrontCouponSchema.parse(archived.json())).toMatchObject({
      status: 'archived',
      version: 3,
    });
    // A second click changes nothing: no new version, no audit row
    const again = await send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 3 });
    expect(storefrontCouponSchema.parse(again.json()).version).toBe(3);
    const ids = async (view: string) =>
      storefrontCouponPageSchema
        .parse((await send('GET', `/storefront/coupons?view=${view}&search=WELCOME`)).json())
        .items.map((item) => item.id);
    expect(await ids('archived')).toEqual([coupon.id]);
    expect(await ids('current')).toEqual([]);
    const restored = await send('POST', `/storefront/coupons/${coupon.id}/restore`, { version: 3 });
    expect(storefrontCouponSchema.parse(restored.json())).toMatchObject({
      status: 'scheduled',
      version: 4,
    });

    const rows = await auditOf(coupon.id);
    expect(rows.map((row) => row.action)).toEqual([
      'storefront_coupon.created',
      'storefront_coupon.updated',
      'storefront_coupon.archived',
      'storefront_coupon.restored',
    ]);
    // The change lists only the two boxes that changed; the discount as one short value
    expect(rows[0]?.changes).toMatchObject({ discount: { from: null, to: 'percent 10' } });
    expect(rows[1]?.changes).toEqual({
      startsOn: { from: null, to: dayAfter(today, 1) },
      lastDay: { from: null, to: dayAfter(today, 30) },
    });

    // A coupon this workspace does not have
    expect((await send('GET', `/storefront/coupons/${UNKNOWN}`)).statusCode).toBe(404);
    const missing = await send('PUT', `/storefront/coupons/${UNKNOWN}`, {
      ...form('NOBODY'),
      version: 1,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a code another coupon has, an archived one's too, and the boxes the form checks", async () => {
    const flat = await makeCoupon('FLAT50', { kind: 'amount', value: '50' });
    await send('POST', `/storefront/coupons/${flat.id}/archive`, { version: flat.version });
    // Archived, it still has its code: an order may point at it, and a restore must not clash
    const taken = await refused(send('POST', '/storefront/coupons', form('flat50')), 409);
    expect(taken).toEqual({
      code: 'storefront_coupon_code_taken',
      fieldErrors: { code: ['storefront_coupon_code_taken'] },
    });
    const other = await makeCoupon('EID25');
    const renamed = await refused(
      send('PUT', `/storefront/coupons/${other.id}`, { ...form('FLAT50'), version: other.version }),
      409,
    );
    expect(renamed.code).toBe('storefront_coupon_code_taken');

    // The rules between boxes: a whole percent from 1 to 99, a cap only on a percent, the last
    // day not before the first
    const rules = await refused(
      send('POST', '/storefront/coupons', form('RULES', { value: '100' })),
      400,
    );
    expect(rules.fieldErrors).toEqual({ value: ['storefront_sale_percent'] });
    const amount = await refused(
      send(
        'POST',
        '/storefront/coupons',
        form('RULES', {
          kind: 'amount',
          value: '0',
          upTo: '50',
          startsOn: '2026-12-10',
          lastDay: '2026-12-01',
        }),
      ),
      400,
    );
    expect(amount.fieldErrors).toEqual({
      value: ['storefront_sale_zero'],
      upTo: ['storefront_coupon_up_to'],
      lastDay: ['storefront_coupon_dates'],
    });
    // Each box on its own
    const boxes = await refused(
      send(
        'POST',
        '/storefront/coupons',
        form('WEL COME', { minimum: '300.505', usageLimit: '0', upTo: '0' }),
      ),
      400,
    );
    expect(boxes.fieldErrors).toEqual({
      code: ['shop_coupon_format'],
      minimum: ['money_format'],
      usageLimit: ['storefront_coupon_limit_format'],
      upTo: ['storefront_sale_zero'],
    });
  });

  it('lists the newest first a page at a time, and finds a code by any part of it', async () => {
    const made: StorefrontCoupon[] = [];
    for (const code of ['PUJA-5', 'PUJA-10', 'PUJA-15']) made.push(await makeCoupon(code));
    const page = async (query: string) =>
      storefrontCouponPageSchema.parse((await send('GET', `/storefront/coupons?${query}`)).json());
    const first = await page('search=puja&limit=2');
    const second = await page(`search=puja&limit=2&cursor=${first.nextCursor ?? ''}`);
    expect([...first.items, ...second.items].map((item) => item.code)).toEqual([
      'PUJA-15',
      'PUJA-10',
      'PUJA-5',
    ]);
    expect(second.nextCursor).toBeNull();
    // Any part, in any case. LIKE's own signs, % and _, are matched as typed: no code has one
    expect((await page('search=ja-1')).items.map((item) => item.code)).toEqual([
      'PUJA-15',
      'PUJA-10',
    ]);
    expect((await page('search=%25')).items).toEqual([]);
    expect((await page('search=PUJA_5')).items).toEqual([]);
  });

  it('is for storefront.manage only, and works before the shop is set up', async () => {
    const coupon = await makeCoupon('STAFF5', {}, manager);
    expect((await send('GET', '/storefront/coupons', undefined, manager)).statusCode).toBe(200);
    const calls = [
      send('GET', '/storefront/coupons', undefined, reader),
      send('GET', `/storefront/coupons/${coupon.id}`, undefined, reader),
      send('POST', '/storefront/coupons', form('READER'), reader),
      send('PUT', `/storefront/coupons/${coupon.id}`, { ...form('STAFF5'), version: 1 }, reader),
      send('POST', `/storefront/coupons/${coupon.id}/archive`, { version: 1 }, reader),
      send('POST', `/storefront/coupons/${coupon.id}/restore`, { version: 1 }, reader),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403,
    ]);
    // A workspace with no shop yet may get WELCOME10 ready for its first day
    const depot = await signUp(app, {
      companyName: 'Mirpur Depot',
      workspaceSlug: 'mirpur',
      fullName: 'Tanvir Hasan',
      email: 'tanvir@mirpur.com',
      password: 'Mirpur-depot-2026',
    });
    expect((await makeCoupon('WELCOME10', {}, depot)).status).toBe('active');
  });
});
```

- **A coupon's life.** `welcome10` is made and comes back as `WELCOME10` (the schema upper-cases it), the money with
  4 decimals as the column keeps it, the percent as a number, version 1. A start day tomorrow makes it "scheduled".
  A form opened before that save is refused with `version_conflict`. Archive moves it to the Archived tab; a second
  archive click changes nothing (same version, no audit row). Restore brings it back, still "scheduled". The audit
  log has four rows; the change row lists only the two days that changed, and the discount reads `percent 10`. An id
  the workspace does not have is a 404 for a read and for a change.
- **Codes.** `FLAT50` is archived and then made again in small letters: refused with `storefront_coupon_code_taken`,
  under the code box. An archived coupon keeps its code because an order may still point at it, and a restore must
  not meet a second `FLAT50`. A change to a taken code is refused the same way.
- **The form's rules.** Each request checks what one kind of rule refuses. A percent of 100 fails the rule between
  the boxes. An amount of 0 with an "up to" and the days the wrong way round fails three rules at once, each under
  its own box. A code with a space, a minimum with three decimals, a limit of 0 and an "up to" of 0 fail the boxes
  on their own. Every error comes back in one answer, each under its box, so the form can show them all at once.
- **The list.** Three `PUJA` codes are read two at a time, newest first, and the cursor of the second page is
  `null`. A search finds any part of the code in any case (`ja-1`). `%` and `_` are matched as typed: `PUJA_5` finds
  nothing, though LIKE would read `_` as any one sign.
- **Permissions.** The manager may make and list coupons. The reader gets 403 on all six routes. A workspace with no
  shop at all may make a coupon (decision 23).

```ts
describe("the shop's quote", () => {
  it('says why a code takes nothing off, and an order with such a code has no coupon', async () => {
    const today = todayIn(DEFAULT_SETTINGS.timezone);
    await makeCoupon('LATER', { startsOn: dayAfter(today, 1) });
    await makeCoupon('GONE', { lastDay: dayAfter(today, -1) });
    await makeCoupon('BIGCART', { minimum: '1000' });
    const archived = await makeCoupon('OLD10');
    await send('POST', `/storefront/coupons/${archived.id}/archive`, { version: 1 });
    // The first and the last day are both days of the coupon
    await makeCoupon('TODAY', { kind: 'amount', value: '50', startsOn: today, lastDay: today });

    const reason = async (code: string) => (await quote(code)).coupon;
    // A coupon that has not started looks like no coupon at all: the shop does not tell what
    // is coming. An archived one does not exist for the shop (0074's policy)
    expect(await reason('NOPE')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('LATER')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('OLD10')).toMatchObject({ reason: 'shop_coupon_unknown' });
    expect(await reason('GONE')).toMatchObject({ reason: 'shop_coupon_expired' });
    expect(await reason('BIGCART')).toEqual({
      status: 'refused',
      code: 'BIGCART',
      reason: 'shop_coupon_minimum',
      minimum: '1000.0000',
    });
    // ৳458 − ৳50 + ৳80; typed in small letters, as a shopper may
    expect(await quote('today')).toMatchObject({
      coupon: { status: 'applied', code: 'TODAY', upTo: null },
      discount: '50.0000',
      total: '488.0000',
    });

    // The promo box said why; the order goes ahead at the full price, with no coupon on it
    const res = await place(901, { ...twoNeem(901), couponCode: 'GONE' });
    expect(res.statusCode, res.body).toBe(201);
    const [order] = z
      .array(z.object({ coupon_id: z.string().nullable(), discount: z.string() }))
      .parse(
        await sql`
          SELECT coupon_id::text, discount::text FROM storefront_orders
          WHERE tenant_id = ${shop.tenantId} AND phone = ${phoneOf(901)}`,
      );
    expect(order).toEqual({ coupon_id: null, discount: '0.0000' });
  });
});
```

The quote's reasons on the real database. A code nobody made, one that starts tomorrow, and an archived one are
all "unknown": the shop never says what is coming, and to the shop an archived code does not exist (the database's
policy hides it, 27c.2). Yesterday's last day is "expired". A minimum of ৳1,000 on a ৳458 cart is "minimum" with the
amount, which the promo box shows. A coupon whose first and last day are today is applied: both days are the
coupon's. The code is typed in small letters, as a shopper may.

Then an order with the expired code and the full price as its expected total: it is placed (decision 25), and the
row has no coupon and no discount.

```ts
describe('a use', () => {
  it('counts from the order placed: a pending one inside its hold only, and a cancel gives it back', async () => {
    const coupon = await makeCoupon('HOLD1', { usageLimit: '1' });
    // Placed, not confirmed yet: the order holds the use while it may still be confirmed
    expect((await place(911, twoNeem(911, 'HOLD1'))).statusCode).toBe(201);
    expect((await quote('HOLD1')).coupon).toMatchObject({ reason: 'shop_coupon_used_up' });
    expect(await getCoupon(coupon.id)).toMatchObject({
      used: 1,
      status: 'ended',
      codeLocked: true,
    });

    // An hour later it can no longer be confirmed: the use is free again, before any sweep. The
    // code stays frozen: an order had it
    await ageOrder(phoneOf(911), 61);
    expect((await quote('HOLD1')).coupon.status).toBe('applied');
    expect(await getCoupon(coupon.id)).toMatchObject({
      used: 0,
      status: 'active',
      codeLocked: true,
    });

    const order = await confirmed(912, twoNeem(912, 'HOLD1'));
    expect(order).toMatchObject({ couponCode: 'HOLD1', discount: '45.8000', total: '492.2000' });
    expect((await getCoupon(coupon.id)).used).toBe(1);
    await cancel(order);
    expect((await getCoupon(coupon.id)).used).toBe(0);
    expect((await quote('HOLD1')).coupon.status).toBe('applied');
    // An order is not an edit: no audit row and no new version for the coupon
    expect((await auditOf(coupon.id)).map((row) => row.action)).toEqual([
      'storefront_coupon.created',
    ]);
    expect((await getCoupon(coupon.id)).version).toBe(1);
  });

  it('is once per mobile number when the coupon says so, and again after that order was cancelled', async () => {
    await makeCoupon('ONCE', { onePerPhone: true });
    const first = await confirmed(921, twoNeem(921, 'ONCE'));
    // The same phone from another address: the phone is what counts
    const again = await refused(place(924, twoNeem(921, 'ONCE')), 422);
    expect(again.code).toBe('shop_coupon_used_by_phone');
    // The quote has no phone, so it still says "applied"; another phone may use it
    expect((await quote('ONCE')).coupon.status).toBe('applied');
    expect((await place(922, twoNeem(922, 'ONCE'))).statusCode).toBe(201);
    await cancel(first);
    expect((await place(925, twoNeem(921, 'ONCE'))).statusCode).toBe(201);

    // Without the box, one phone may use it twice
    await makeCoupon('TWICE');
    expect((await place(926, twoNeem(923, 'TWICE'))).statusCode).toBe(201);
    expect((await place(927, twoNeem(923, 'TWICE'))).statusCode).toBe(201);
  });
});
```

- **When a use counts.** `HOLD1` has one use. A placed order that waits for its phone code takes it: the quote says
  "used up" and the Coupons page says 1 used, "ended", and the code is locked. An hour later that order can no
  longer be confirmed, so the use is free again, before any sweep deletes the order; the code stays locked, because
  an order had it (decision 16). A confirmed order takes the use again; its cancel gives it back. The coupon has
  only its "created" audit row and is still version 1: an order is not an edit of the coupon.
- **Once per phone.** The phone that has an order with `ONCE` is refused (`shop_coupon_used_by_phone`, 422) from
  another address too: the phone is what counts. The quote still says "applied", because it has no phone. Another
  phone may use it, and so may the first phone once its order is cancelled. `TWICE`, without the box, takes two
  orders from one phone.

```ts
describe('at the same moment', () => {
  it('gives the last use to one of two shoppers', async () => {
    const coupon = await makeCoupon('LAST1', { usageLimit: '1' });
    // Two products, so the orders pass their variants' locks and meet at the coupon's row. The
    // first one waits at its holds' INSERT with the row locked; the second waits for that lock.
    // Counted in the locking statement, the second would still see no use and take one too
    const [first, second] = await inTurn('storefront_stock_holds', [
      () => place(931, twoNeem(931, 'LAST1')),
      // ৳420 + ৳80 − ৳42
      () =>
        place(932, { ...orderRequest(tea.listingId, 1, phoneOf(932), '458'), couponCode: 'LAST1' }),
    ]);
    expect(first?.statusCode, first?.body).toBe(201);
    // The total without the coupon is not the one the shopper saw; the checkout quotes again
    expect(second?.statusCode, second?.body).toBe(409);
    expect(refusalSchema.parse(second?.json()).code).toBe('shop_order_changed');
    expect((await getCoupon(coupon.id)).used).toBe(1);
    expect(
      (await quote('LAST1', [{ listingId: tea.listingId, quantity: 1 }])).coupon,
    ).toMatchObject({ reason: 'shop_coupon_used_up' });
  });

  it('never gives an order a code that changed while it was placed, and keeps a code an order took', async () => {
    const eid = await makeCoupon('EIDSALE');
    // The page saves first: it holds the coupon's row and waits at the table for its UPDATE. The
    // order waits for that row; once the save is in, the row no longer has the code it asked for
    const [saved, order] = await inTurn('storefront_coupons', [
      () =>
        send('PUT', `/storefront/coupons/${eid.id}`, { ...form('EID-SALE'), version: eid.version }),
      () => place(941, twoNeem(941, 'EIDSALE')),
    ]);
    expect(saved?.statusCode, saved?.body).toBe(200);
    expect(order?.statusCode, order?.body).toBe(409);
    expect(await getCoupon(eid.id)).toMatchObject({ code: 'EID-SALE', used: 0, codeLocked: false });
    expect((await quote('EIDSALE')).coupon).toMatchObject({ reason: 'shop_coupon_unknown' });

    // The order first: it holds the row while it waits at its holds; the save waits for the row
    // and then sees the order's first_ordered_at
    const puja = await makeCoupon('PUJA25');
    const [placed, renamed] = await inTurn('storefront_stock_holds', [
      () => place(942, twoNeem(942, 'PUJA25')),
      () =>
        send('PUT', `/storefront/coupons/${puja.id}`, {
          ...form('PUJA-25'),
          version: puja.version,
        }),
    ]);
    expect(placed?.statusCode, placed?.body).toBe(201);
    expect(renamed?.statusCode, renamed?.body).toBe(409);
    expect(refusalSchema.parse(renamed?.json())).toEqual({
      code: 'storefront_coupon_code_locked',
      fieldErrors: { code: ['storefront_coupon_code_locked'] },
    });
    // Everything but the code may still change: a later last day, a bigger limit
    const later = await send('PUT', `/storefront/coupons/${puja.id}`, {
      ...form('PUJA25', { usageLimit: '500' }),
      version: puja.version,
    });
    expect(later.statusCode, later.body).toBe(200);
  });
});
```

- **The last use.** The first order (face washes) locks the coupon's row, takes the use, and waits at its stock
  holds' `INSERT` behind the gate. The second order (tea) passes its own product's lock and waits for the coupon's
  row. When the gate opens, the first one commits; the second one then counts the uses in a new statement
  (`lockedCoupon`, 27c.3), sees one, and its quote has no discount. Its total is no longer the one the shopper saw,
  so it is refused with `shop_order_changed`, and the checkout's next quote says "used up".
- **A code that changes during an order.** The Coupons page saves first: its `FOR UPDATE` passes the gate's `SHARE`
  lock (the two do not conflict), and its `UPDATE` waits at the table. The order then waits for the row. Once the
  save is in, Postgres checks the locked row again, sees that its code is no longer `EIDSALE`, and the order finds
  no coupon: it is refused, and never gets a code the coupon no longer has. The coupon is `EID-SALE`, not locked,
  and the old code is unknown to the quote.
- **An order during a save.** The other way round: the order holds the row, and the save waits for it. Once the order
  is in, the save reads the row with its `first_ordered_at` and refuses the new code with
  `storefront_coupon_code_locked`, under the code box. Every other box may still change.

```ts
describe('the database', () => {
  it('keeps a code an order had, and the time of the first order, even past the page', async () => {
    const coupon = await makeCoupon('GUARD');
    expect((await place(945, twoNeem(945, 'GUARD'))).statusCode).toBe(201);
    // As the superuser, which skips the row rules but not the trigger (0074): a bug or a hand fix
    const caught = async (query: Promise<unknown>) => {
      const error = await query.then(
        () => null,
        (caughtError: unknown) => caughtError,
      );
      return z.object({ code: z.string(), constraint_name: z.string() }).parse(error);
    };
    expect(
      await caught(sql`UPDATE storefront_coupons SET code = 'GUARD-2' WHERE id = ${coupon.id}`),
    ).toMatchObject({ code: '23514', constraint_name: 'storefront_coupons_code_locked' });
    expect(
      await caught(
        sql`UPDATE storefront_coupons SET first_ordered_at = NULL WHERE id = ${coupon.id}`,
      ),
    ).toMatchObject({ code: '23514', constraint_name: 'storefront_coupons_first_ordered_kept' });
  });
});
```

The database's guard on its own. As the superuser, which skips the row rules but not a trigger, a new code for a
coupon that had an order is refused with `storefront_coupons_code_locked`, and setting `first_ordered_at` back to
`NULL` with `storefront_coupons_first_ordered_kept`. This is what holds if a later bug or a hand fix skips the
Coupons page's own check.

```ts
describe('the documents', () => {
  it('spread the discount to the paisa over the sales order, a challan of two batches and the invoice', async () => {
    await makeCoupon('FLAT100', { kind: 'amount', value: '100' });
    // One face wash (৳229) and four sunscreens (৳1,800): ৳2,029 + ৳80 − ৳100 = ৳2,009
    const request: ShopOrderRequestInput = {
      ...orderRequest(shop.listingId, 1, phoneOf(951), '2009'),
      lines: [
        { listingId: shop.listingId, quantity: 1 },
        { listingId: sunscreen.listingId, quantity: 4 },
      ],
      couponCode: 'FLAT100',
    };
    const order = await confirmed(951, request);
    const so = salesOrderSchema.parse(
      (await send('GET', `/sales-orders/${order.salesOrder?.id ?? ''}`)).json(),
    );
    // ৳100 by the lines' shares: 11.2863… and 88.7136…; the paisa left over goes to the larger
    // remainder (the face wash). The delivery line gets nothing
    expect(so.lines.map((line) => line.discount)).toEqual(['11.2900', '88.7100', '0.0000']);
    expect(so.total).toBe('2009.0000');

    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const picks = plan.lines[1]?.picks ?? [];
    expect(picks.map((pick) => pick.quantity)).toEqual(['3.0000', '1.0000']);
    const packed = await send('POST', `/storefront/orders/${order.id}/pack`, {
      version: order.version,
      lines: [
        { position: 1, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
        {
          position: 2,
          picks: picks.map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
        },
      ],
    });
    expect(packed.statusCode, packed.body).toBe(200);
    const shipped = await send('POST', `/storefront/orders/${order.id}/ship`, {
      version: storefrontOrderSchema.parse(packed.json()).version,
    });
    const delivered = await send('POST', `/storefront/orders/${order.id}/deliver`, {
      version: storefrontOrderSchema.parse(shipped.json()).version,
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
    const invoiceId = storefrontOrderSchema.parse(delivered.json()).invoice?.id ?? '';
    const invoice = invoiceSchema.parse((await send('GET', `/invoices/${invoiceId}`)).json());
    // The sunscreen line's ৳88.71 over SS-A's 3 and SS-B's 1 (66.5325 and 22.1775): the paisa to
    // the larger remainder, SS-B's. The invoice bills what the shopper pays, to the paisa
    expect(invoice.lines.map((line) => line.discount)).toEqual([
      '11.2900',
      '66.5300',
      '22.1800',
      '0.0000',
    ]);
    expect(invoice.total).toBe('2009.0000');
  });
});
```

The discount to the paisa, from the order to the invoice. `FLAT100` takes ৳100 off one face wash (৳229) and four
sunscreens (৳1,800):

- On the sales order, ৳100 is shared by the lines' totals: 11.2863… and 88.7136…. Cut to the paisa that is 11.28
  and 88.71, one paisa short; it goes to the larger remainder, the face wash. So the lines say 11.29, 88.71 and 0
  for the delivery line, and the total is ৳2,009, the shop's.
- The pack plan takes 3 sunscreens from `SS-A` and 1 from `SS-B`, so the challan has two lines for the one order
  line. The invoice shares that line's ৳88.71 by the challan lines' totals (৳1,350 and ৳450): 66.5325 and 22.1775,
  cut to 66.53 and 22.17, and the paisa left goes to `SS-B`. The invoice's lines say 11.29, 66.53, 22.18 and 0, and
  its total is ৳2,009 to the paisa.

The numbers are worked out by hand here, not with `spreadMoney()`: a test that called the function under test would
agree with any bug in it.

### The tenant-leak tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  shopCartQuoteSchema,
  type ShopCouponResult,
  type StorefrontCoupon,
  storefrontCouponPageSchema,
  storefrontCouponSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createTestApp,
  createTestWorker,
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

// Step 27c: a coupon is a workspace's own. Two launched shops, Nirvor and Acme, each with a coupon
// WELCOME10 (a code is unique per workspace, not across them), and ACME20 at Acme only. The ERP
// must open, change and archive none of the other workspace's coupons; a shop must know only its
// own codes; and a use, or a phone's use, at one shop must never count at the other. Then the
// database's walls: the counting function is SECURITY DEFINER, so it must stay inside the caller's
// workspace on its own, and the shop's roles must reach no other workspace's coupon.
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
let nirvorWelcome: StorefrontCoupon;
let acmeWelcome: StorefrontCoupon;
let acmeTwenty: StorefrontCoupon;

// Two face washes (৳229 each) plus the ৳80 delivery charge, with WELCOME10's 10% off
const TEN_OFF = '492.2';

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function makeCoupon(who: SignedIn, code: string): Promise<StorefrontCoupon> {
  const res = await send(who, 'POST', '/storefront/coupons', {
    code,
    kind: 'percent',
    value: '10',
    upTo: '',
    minimum: '',
    startsOn: '',
    lastDay: '',
    // One use each and once per phone: a use or a phone that crossed over would show at once
    usageLimit: '1',
    onePerPhone: true,
  });
  expect(res.statusCode, res.body).toBe(201);
  return storefrontCouponSchema.parse(res.json());
}

async function usedOf(who: SignedIn, id: string): Promise<number> {
  const res = await send(who, 'GET', `/storefront/coupons/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontCouponSchema.parse(res.json()).used;
}

async function couponAt(shop: OrderShop, couponCode: string): Promise<ShopCouponResult> {
  const res = await shopPost(app, '/cart/quote', shopHeaders(shop.host, clientAddress(960)), {
    lines: [{ listingId: shop.listingId, quantity: 2 }],
    zoneId: 'inside_dhaka',
    couponCode,
  });
  expect(res.statusCode, res.body).toBe(200);
  return shopCartQuoteSchema.parse(res.json()).coupon;
}

const countSchema = z.array(z.object({ n: z.number() }));

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
  // One code in two workspaces: both are made
  nirvorWelcome = await makeCoupon(nirvorOwner, 'WELCOME10');
  acmeWelcome = await makeCoupon(acmeOwner, 'WELCOME10');
  acmeTwenty = await makeCoupon(acmeOwner, 'ACME20');
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the Coupons page', () => {
  it("lists each workspace's own coupons, and opens, changes or archives none of the other's", async () => {
    const codes = async (who: SignedIn) =>
      storefrontCouponPageSchema
        .parse((await send(who, 'GET', '/storefront/coupons')).json())
        .items.map((item) => item.id);
    expect(await codes(nirvorOwner)).toEqual([nirvorWelcome.id]);
    expect((await codes(acmeOwner)).sort()).toEqual([acmeWelcome.id, acmeTwenty.id].sort());

    // Acme's owner with Nirvor's coupon id: as if it did not exist
    const id = nirvorWelcome.id;
    const version = { version: nirvorWelcome.version };
    const calls = [
      send(acmeOwner, 'GET', `/storefront/coupons/${id}`),
      send(acmeOwner, 'PUT', `/storefront/coupons/${id}`, {
        code: 'HACKED',
        kind: 'amount',
        value: '9999',
        upTo: '',
        minimum: '',
        startsOn: '',
        lastDay: '',
        usageLimit: '',
        onePerPhone: false,
        ...version,
      }),
      send(acmeOwner, 'POST', `/storefront/coupons/${id}/archive`, version),
      send(acmeOwner, 'POST', `/storefront/coupons/${id}/restore`, version),
    ];
    expect((await Promise.all(calls)).map((res) => res.statusCode)).toEqual([404, 404, 404, 404]);
    // Nirvor's coupon as it was: no new version, no audit row but its own
    const after = storefrontCouponSchema.parse(
      (await send(nirvorOwner, 'GET', `/storefront/coupons/${id}`)).json(),
    );
    expect(after).toMatchObject({ code: 'WELCOME10', version: 1, status: 'active' });
    const actions = z
      .array(z.object({ action: z.string() }))
      .parse(await sql`SELECT action FROM audit_logs WHERE entity_id = ${id}`);
    expect(actions.map((row) => row.action)).toEqual(['storefront_coupon.created']);
  });
});

describe('the shops', () => {
  it("know only their own codes: Acme's code at Nirvor takes nothing off", async () => {
    expect(await couponAt(acme, 'ACME20')).toMatchObject({ status: 'applied' });
    expect(await couponAt(nirvor, 'ACME20')).toMatchObject({ reason: 'shop_coupon_unknown' });
    // The order goes ahead at the full price, with no coupon on it
    const res = await shopPost(app, '/orders', shopHeaders(nirvor.host, clientAddress(961)), {
      ...orderRequest(nirvor.listingId, 2, phoneOf(961), '538'),
      couponCode: 'ACME20',
    });
    expect(res.statusCode, res.body).toBe(201);
    const rows = z.array(z.object({ coupon_id: z.string().nullable() })).parse(
      await sql`
        SELECT coupon_id::text FROM storefront_orders
        WHERE tenant_id = ${nirvor.tenantId} AND phone = ${phoneOf(961)}`,
    );
    expect(rows).toEqual([{ coupon_id: null }]);
  });

  it("count each workspace's uses apart, and a phone's use too", async () => {
    // One phone takes Acme's only use of WELCOME10
    const phone = phoneOf(962);
    const atAcme = await shopPost(app, '/orders', shopHeaders(acme.host, clientAddress(962)), {
      ...orderRequest(acme.listingId, 2, phone, TEN_OFF),
      couponCode: 'WELCOME10',
    });
    expect(atAcme.statusCode, atAcme.body).toBe(201);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);
    expect(await couponAt(acme, 'WELCOME10')).toMatchObject({ reason: 'shop_coupon_used_up' });

    // Nirvor's WELCOME10 is untouched, and the same phone may still use it there
    expect(await usedOf(nirvorOwner, nirvorWelcome.id)).toBe(0);
    expect(await couponAt(nirvor, 'WELCOME10')).toMatchObject({ status: 'applied' });
    const atNirvor = await shopPost(app, '/orders', shopHeaders(nirvor.host, clientAddress(963)), {
      ...orderRequest(nirvor.listingId, 2, phone, TEN_OFF),
      couponCode: 'WELCOME10',
    });
    expect(atNirvor.statusCode, atNirvor.body).toBe(201);
    expect(await usedOf(nirvorOwner, nirvorWelcome.id)).toBe(1);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);
  });
});

describe("the shop's database roles", () => {
  // ShopDb.read: SET LOCAL ROLE omnivo_public in Nirvor's workspace, the quote's way in
  function asPublic(query: SQL): Promise<unknown> {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }

  it("count no use of the other workspace's coupon, even with its id", async () => {
    // Acme's WELCOME10 has a use (the test before). The function is SECURITY DEFINER, so the
    // workspace's own rows are all it must count, by its own filter
    const uses = countSchema.parse(
      await asPublic(drizzleSql`
        SELECT storefront_coupon_uses(${acmeWelcome.id}::uuid, now() - interval '1 hour') AS n
        UNION ALL
        SELECT storefront_coupon_uses(${nirvorWelcome.id}::uuid, now() - interval '1 hour')`),
    );
    expect(uses.map((row) => row.n)).toEqual([0, 1]);
    expect(await usedOf(acmeOwner, acmeWelcome.id)).toBe(1);

    const seen = countSchema.parse(
      await asPublic(drizzleSql`
        SELECT (SELECT count(*) FROM storefront_coupons)::int AS n
        UNION ALL
        SELECT (SELECT count(*) FROM storefront_coupons WHERE tenant_id = ${acme.tenantId})::int`),
    );
    expect(seen.map((row) => row.n)).toEqual([1, 0]);
  });

  // The quote's role writes nothing whatever its grants: ShopDb.read is a read-only transaction.
  // Placing an order's role is the one that may write, so its walls are the ones to check
  it("change no coupon's discount as the order's role, and reach no other workspace's coupon", async () => {
    // ShopDb.orders: omnivo_shop in Nirvor's workspace. The discount is never the shop's to set
    const discountError = await app
      .get(ShopDb)
      .orders(nirvor.host, (tx) =>
        tx.execute(drizzleSql`UPDATE storefront_coupons SET discount_value = 99`),
      )
      .catch((caught: unknown) => caught);
    expect(pgErrorOf(discountError)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_coupons',
    });
    // The one column it may write, aimed at Acme's coupon: the row is not there for it
    const reached = await app.get(ShopDb).orders(nirvor.host, (tx) =>
      tx.execute(drizzleSql`
          UPDATE storefront_coupons SET first_ordered_at = now()
          WHERE id = ${acmeWelcome.id}::uuid RETURNING id`),
    );
    expect(Array.from(reached)).toEqual([]);
  });
});
```

Two launched shops, Nirvor and Acme, each with `WELCOME10` (one use, once per phone), and `ACME20` at Acme only. A
code is unique per workspace, so both `WELCOME10`s are made. One use each and once per phone make any use that
crosses over show at once.

- **The Coupons page.** Each workspace lists only its own coupons. Acme's owner with Nirvor's coupon id gets 404 for
  a read, a change, an archive and a restore, and Nirvor's coupon is as it was: version 1, one audit row.
- **The shops.** `ACME20` is applied at Acme and unknown at Nirvor; an order at Nirvor with it is placed at the full
  price, with no coupon.
- **The uses.** One phone takes Acme's only use of `WELCOME10`; Acme's quote says "used up". Nirvor's `WELCOME10`
  still has no use, and the same phone may use it at Nirvor: once per phone is per workspace too.
- **The counting function.** `storefront_coupon_uses()` is `SECURITY DEFINER` (27c.2), so it reads orders the quote's
  role may not. As the quote's role at Nirvor, with Acme's coupon id, it counts 0, though Acme's coupon has a use;
  with Nirvor's own id, 1. The quote's role sees one coupon (Nirvor's) and none of Acme's.
- **The order's role.** `omnivo_shop` may write one column, `first_ordered_at`. A change of the discount is refused
  for the table. Aimed at Acme's coupon, the one column it may write changes nothing: the row is not there for it.
  The quote's role is not tried: `ShopDb.read()` is a read-only transaction, so Postgres refuses any write there
  before it looks at a grant (`25006`), and such a test would prove nothing about the grants.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/storefront/orders
cd apps/api
npx vitest run src/storefront/orders/storefront-coupons --maxWorkers=1
```

The last line runs both new files (11 and 5 tests, about 12 seconds each after the containers start).
`pnpm --filter @omnivo/shop typecheck` still fails as after 27c.1 (the mock's quote, 27c.7).

The coupon file passed three runs in a row: the two gates do not depend on luck.

Broken on purpose, to see that the tests notice:

- The uses counted before the coupon's row is locked: the last-use race fails (both orders 201).
- The sales order's discount shared by unit price, not by line total: the documents test fails (33.73 and 66.27).
- `o.status <> 'cancelled'` taken out of `storefront_coupon_uses()`: two tests fail (a cancel no longer gives the use
  back, and the phone stays refused).
- The function's tenant filter taken out, and FORCE row security off on `storefront_orders`: the leak test fails
  (Acme's use counted at Nirvor).

Two breaks did **not** fail a test, on purpose, and show the second wall of each pair:

- The Coupons page's own "code locked" check taken out: every test still passes. The database's guard refuses the
  new code, and the service turns its error into the same 409. Taking out both the check and that mapping does fail
  (500 instead of 409).
- The function's tenant filter taken out alone: the leak test still passes, because row security on
  `storefront_orders` keeps the function inside the caller's workspace. Both walls must go before anything leaks.

## 27c.5 — `packages/i18n`: the Coupons page's words

The Coupons page of 27c.6 needs its words in English and Bangla, so they come first. 27c.1 already gave the errors
(the two new refusals and the form's five codes) and the audit log their words, and 27b's order page already has
"Discount (WELCOME10)". This part adds the sidebar's item, the list, the form's dialog, and the shop's promo line for
a coupon with an "up to".

These words come before the mockup. If the mockup in 27c.6 changes the page, the words change with it, and the diffs
below show them as they are at the end of the step.

Four decisions came up while writing the words (mine):

29. **"Shop coupons" comes right after Catalog** in the Storefront group. Both set what the shop charges, and the
    same person (`storefront.manage`) looks after both. It says "Shop" like the other items, because the phone's nav
    row has no group labels.
30. **The list writes the discount the way the shopper reads it:** "10% off, up to ৳200" or "৳50 off". "Once per
    mobile number" sits under the code, only when it is on, so a plain coupon's row stays one line. The uses column
    says "12 of 100 used", or "12 used" when there is no limit.
31. **Archive asks first, restore does not.** Archiving takes the code away from shoppers at once (to them it does
    not exist, 27c.2's policy), and a shopper may already have it in an SMS or a Facebook post. Restore only gives
    back what was there.
32. **The shop's applied line names the "up to"** ("WELCOME10 applied: 10% off, up to ৳200") as its own whole
    sentence, not "10% off" plus a piece glued on. Without it, a shopper with a ৳3,000 cart expects ৳300 off and
    sees ৳200 with no reason. A whole sentence lets the Bangla put the words in its own order.

### `locales/en.ts`

```diff
@@ -159,6 +159,9 @@ export const en = {
     storefrontPages: 'Shop pages',
     // Step 27b: the shop's orders, first in the group (decision 34)
     storefrontOrders: 'Shop orders',
+    // Step 27c: after Catalog, both about the shop's prices (decision 29). "Shop" for the phone's
+    // nav row, like the others
+    storefrontCoupons: 'Shop coupons',
   },
   auth: {
     workspace: 'Workspace',
```

The sidebar's item (decision 29).

```diff
@@ -6034,6 +6037,104 @@ export const en = {
         submit: 'Cancel order',
       },
     },
+    // Step 27c: the shop's coupons (/storefront/coupons, decision 5), storefront.manage. Online
+    // only, like the rest of the menu. The shop need not be set up: a coupon can wait for it
+    coupons: {
+      title: 'Coupons',
+      description: 'Codes shoppers type in the promo box to take money off their order',
+      add: 'Add coupon',
+      searchLabel: 'Search coupons',
+      searchPlaceholder: 'Code',
+      view: 'Show',
+      // The tabs (STOREFRONT_COUPON_VIEWS, decision 18)
+      views: { current: 'Current', archived: 'Archived' },
+      // The pill (STOREFRONT_COUPON_STATUSES), worked out by the API from the days and the uses
+      statuses: {
+        active: 'Active',
+        scheduled: 'Scheduled',
+        ended: 'Ended',
+        archived: 'Archived',
+      },
+      columns: {
+        code: 'Code',
+        discount: 'Takes off',
+        minimum: 'Minimum order',
+        days: 'Days',
+        used: 'Used',
+        status: 'Status',
+      },
+      // The discount column (decision 30). percent in the page's digits, upTo and amount with ৳
+      percentOff: '{{percent}}% off',
+      percentOffUpTo: '{{percent}}% off, up to {{upTo}}',
+      amountOff: '{{amount}} off',
+      // Under the code, only when it is on
+      onePerPhone: 'Once per mobile number',
+      // The minimum column: "From ৳500", or none
+      minimumFrom: 'From {{amount}}',
+      anyAmount: 'Any amount',
+      // The days column, both days included (dates already formatted)
+      daysBetween: '{{from}} – {{to}}',
+      daysFrom: 'From {{from}}',
+      daysUntil: 'Until {{to}}',
+      anyDay: 'Any day',
+      // The uses column: count = used for the plural, formatted/limit in the page's digits
+      usedOf: '{{formatted}} of {{limit}} used',
+      used_one: '{{formatted}} used',
+      used_other: '{{formatted}} used',
+      // The row's menu (an icon button needs a name)
+      actions: 'Actions for {{code}}',
+      edit: 'Edit',
+      archive: 'Archive',
+      restore: 'Restore',
+      // Decision 31: archive asks first, restore does not
+      confirmArchive: 'Archive {{code}}?',
+      archiveBody:
+        'The shop stops taking it at once: a shopper who types it is told the code does not exist. Orders that have it keep their discount.',
+      archivedToast: '{{code}} archived',
+      restoredToast: '{{code}} restored',
+      emptyTitle: 'No coupons yet',
+      emptyBody:
+        'Make a code for a sale, like WELCOME10 for 10% off a first order, or FLAT50 for ৳50 off orders of ৳500 or more.',
+      emptyArchivedTitle: 'No archived coupons',
+      emptyArchivedBody:
+        'Archive a coupon to stop the shop taking it. Orders that used it keep their discount.',
+      noMatchTitle: 'No coupon matches',
+      noMatchBody: 'Check the code. The search looks in this tab only.',
+      loadFailed: "Couldn't load the coupons. Refresh the page to try again.",
+    },
+    // Step 27c: the coupon's dialog form (StorefrontCouponFormValues)
+    coupon: {
+      newTitle: 'Add a coupon',
+      editTitle: 'Edit {{code}}',
+      description: 'A coupon takes money off the items of the whole cart, never off delivery.',
+      code: 'Code',
+      codePlaceholder: 'WELCOME10',
+      codeHint: 'Up to 20 letters, digits or hyphens. Shoppers may type it in small letters too.',
+      // codeLocked: the box is shown read-only (storefront_coupon_code_locked)
+      codeLockedHint: 'An order has used this code, so it can’t change.',
+      kind: 'Discount',
+      kinds: { percent: 'Percent off', amount: 'Taka off' },
+      // The value box's label follows the kind (decision 17)
+      values: { percent: 'Percent off (1 to 99)', amount: 'Amount off' },
+      percentPlaceholder: '10',
+      upTo: 'Up to (optional)',
+      upToHint: 'The most it takes off one order. Empty means no limit.',
+      minimum: 'Minimum order (optional)',
+      minimumHint: 'What the items must cost before delivery. Empty means any amount.',
+      startsOn: 'First day (optional)',
+      lastDay: 'Last day (optional)',
+      daysHint:
+        'Whole days in your workspace’s time zone, both days included. Before the first day the shop says the code does not exist.',
+      usageLimit: 'Number of orders (optional)',
+      usageLimitHint:
+        'How many orders may use it in all. An order waiting for its phone code holds a use; a cancelled one gives it back.',
+      onePerPhone: 'Once per mobile number',
+      onePerPhoneHint: 'A second order from the same number is refused with this code.',
+      submitNew: 'Add coupon',
+      submitEdit: 'Save changes',
+      created: '{{code}} added',
+      updated: 'Changes to {{code}} saved',
+    },
   },
   approvals: {
     title: 'Approvals',
```

Two blocks after the order page's, `coupons` for the list and `coupon` for the dialog:

- **`views` and `statuses` have exactly the keys of their contract lists** (`STOREFRONT_COUPON_VIEWS`,
  `STOREFRONT_COUPON_STATUSES`), so 27c.6 can type them with `satisfies Record<…>`, and a status added later fails
  the type check until it has its word. The status is the API's (`storefrontCouponStatus`), so the page never works
  out "ended" itself.
- **`percentOff` takes the percent as a value, not inside the word.** The page formats it with the page's digits, so
  the Bangla list says ১০% ছাড়. `upTo` and `amount` come in already formatted as money (`৳200`).
- **`minimumFrom` / `anyAmount` and the four `days…` words** fill the two columns that may be empty. An empty cell
  would read as "not loaded"; "Any amount" and "Any day" say what an empty box in the form means.
- **`usedOf` has no plural form; `used_one` / `used_other` have one.** With a limit the sentence is "12 of 100 used"
  whatever the count. Without one, i18next picks the form by `count` and the page passes the digits as `formatted`,
  like the sync line's words.
- **`actions`** names the row's menu button for a screen reader ("Actions for WELCOME10"): an icon button always has
  a label.
- **`archiveBody`** says what the shopper sees and what stays (decision 31): orders already placed keep their
  discount, because the sales order has it on its lines (decision 4).
- **The empty states use real codes** (WELCOME10, FLAT50), the two shapes a coupon has: a percent for a first order
  and an amount above a minimum. The archived tab's empty state says what archiving is for, since it is the only
  place someone looks for that.
- **`noMatchBody`** says the search looks in the open tab only, like the shop orders' list: the contract's `view`
  and `search` go together.
- **The dialog's labels say "(optional)"** for every box that may stay empty, as the design system asks, and each
  hint says what empty means. "Up to" and "Minimum order" are amounts, so their hints say whose amount: one order's
  discount, and the items before delivery (the minimum never counts the delivery charge, step 26c's decision 8).
- **`values` follows `kinds`**, the listing sale's pattern: one value box whose label changes with the select
  (decision 17), so the label always says what the number means.
- **`daysHint`** says both days are included and that before the first day the shop answers "does not exist"
  (decision 3). Without it, someone testing a coupon that starts tomorrow would think it is broken.
- **`usageLimitHint`** says that an order waiting for its phone code holds a use and that a cancel gives it back
  (decision 3), so "99 of 100 used" with only 98 orders in the list is not a surprise.
- **`codeLockedHint`** stands in for `codeHint` when an order has used the code: the box is read-only, and the hint
  says why before anyone gets the `storefront_coupon_code_locked` error.

### `locales/bn.ts`

```diff
@@ -138,6 +138,8 @@ export const bn: Messages = {
     storefrontPages: 'শপের পেজ',
     // ধাপ ২৭b: শপের অর্ডার, গ্রুপে প্রথমে (সিদ্ধান্ত ৩৪)
     storefrontOrders: 'শপের অর্ডার',
+    // ধাপ ২৭c: ক্যাটালগের পরে, দুটোই শপের দাম নিয়ে (সিদ্ধান্ত ২৯)
+    storefrontCoupons: 'শপের কুপন',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -5572,6 +5574,92 @@ export const bn: Messages = {
         submit: 'অর্ডার বাতিল করুন',
       },
     },
+    // ধাপ ২৭c: শপের কুপন (/storefront/coupons, সিদ্ধান্ত ৫)
+    coupons: {
+      title: 'কুপন',
+      description: 'প্রোমো বক্সে ক্রেতা যে কোড লিখে অর্ডারে ছাড় পান',
+      add: 'কুপন যোগ করুন',
+      searchLabel: 'কুপন খুঁজুন',
+      searchPlaceholder: 'কোড',
+      view: 'দেখান',
+      views: { current: 'চালু', archived: 'আর্কাইভ করা' },
+      statuses: {
+        active: 'চালু',
+        scheduled: 'শুরু হবে',
+        ended: 'শেষ',
+        archived: 'আর্কাইভ করা',
+      },
+      columns: {
+        code: 'কোড',
+        discount: 'ছাড়',
+        minimum: 'কমপক্ষে অর্ডার',
+        days: 'দিন',
+        used: 'ব্যবহার',
+        status: 'অবস্থা',
+      },
+      percentOff: '{{percent}}% ছাড়',
+      percentOffUpTo: '{{percent}}% ছাড়, সর্বোচ্চ {{upTo}}',
+      amountOff: '{{amount}} ছাড়',
+      onePerPhone: 'একটা মোবাইল নম্বরে একবার',
+      minimumFrom: '{{amount}} থেকে',
+      anyAmount: 'যেকোনো অঙ্ক',
+      daysBetween: '{{from}} – {{to}}',
+      daysFrom: '{{from}} থেকে',
+      daysUntil: '{{to}} পর্যন্ত',
+      anyDay: 'যেকোনো দিন',
+      usedOf: '{{limit}}-এর মধ্যে {{formatted}} ব্যবহার হয়েছে',
+      used_one: '{{formatted}} বার ব্যবহার হয়েছে',
+      used_other: '{{formatted}} বার ব্যবহার হয়েছে',
+      actions: '{{code}}-এর কাজ',
+      edit: 'বদলান',
+      archive: 'আর্কাইভ করুন',
+      restore: 'ফিরিয়ে আনুন',
+      confirmArchive: '{{code}} আর্কাইভ করবেন?',
+      archiveBody:
+        'শপ এখনই এটা নেওয়া বন্ধ করবে: কেউ লিখলে বলা হবে কোডটি নেই। যেসব অর্ডারে এটা আছে, সেগুলোর ছাড় থাকবে।',
+      archivedToast: '{{code}} আর্কাইভ করা হয়েছে',
+      restoredToast: '{{code}} ফিরিয়ে আনা হয়েছে',
+      emptyTitle: 'এখনো কোনো কুপন নেই',
+      emptyBody:
+        'অফারের জন্য একটা কোড বানান, যেমন প্রথম অর্ডারে ১০% ছাড়ের WELCOME10, বা ৳৫০০ বা বেশির অর্ডারে ৳৫০ ছাড়ের FLAT50।',
+      emptyArchivedTitle: 'কোনো আর্কাইভ করা কুপন নেই',
+      emptyArchivedBody:
+        'শপ যেন কোনো কুপন আর না নেয়, তাহলে সেটা আর্কাইভ করুন। যেসব অর্ডারে এটা ব্যবহার হয়েছে, সেগুলোর ছাড় থাকবে।',
+      noMatchTitle: 'কোনো কুপন মেলেনি',
+      noMatchBody: 'কোডটা মিলিয়ে দেখুন। খোঁজা হয় শুধু এই ট্যাবে।',
+      loadFailed: 'কুপন আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    // ধাপ ২৭c: কুপনের ডায়ালগ ফর্ম
+    coupon: {
+      newTitle: 'কুপন যোগ করুন',
+      editTitle: '{{code}} বদলান',
+      description: 'কুপন পুরো কার্টের পণ্যের দাম থেকে ছাড় দেয়, ডেলিভারি চার্জ থেকে কখনো না।',
+      code: 'কোড',
+      codePlaceholder: 'WELCOME10',
+      codeHint: 'সর্বোচ্চ ২০টি অক্ষর, অঙ্ক বা ড্যাশ। ক্রেতা ছোট হাতের অক্ষরেও লিখতে পারেন।',
+      codeLockedHint: 'একটা অর্ডারে এই কোড ব্যবহার হয়েছে, তাই এটা আর বদলানো যায় না।',
+      kind: 'ছাড়',
+      kinds: { percent: 'শতাংশ ছাড়', amount: 'টাকা ছাড়' },
+      values: { percent: 'শতাংশ ছাড় (১ থেকে ৯৯)', amount: 'কত টাকা ছাড়' },
+      percentPlaceholder: '10',
+      upTo: 'সর্বোচ্চ (ঐচ্ছিক)',
+      upToHint: 'একটা অর্ডারে সবচেয়ে বেশি যত ছাড়। ফাঁকা মানে কোনো সীমা নেই।',
+      minimum: 'কমপক্ষে অর্ডার (ঐচ্ছিক)',
+      minimumHint: 'ডেলিভারি চার্জ ছাড়া পণ্যের দাম অন্তত এত হতে হবে। ফাঁকা মানে যেকোনো অঙ্ক।',
+      startsOn: 'প্রথম দিন (ঐচ্ছিক)',
+      lastDay: 'শেষ দিন (ঐচ্ছিক)',
+      daysHint:
+        'ওয়ার্কস্পেসের টাইম জোনে পুরো দিন, দুই দিনই ধরে। প্রথম দিনের আগে শপ বলবে কোডটি নেই।',
+      usageLimit: 'কয়টা অর্ডারে চলবে (ঐচ্ছিক)',
+      usageLimitHint:
+        'মোট কয়টা অর্ডারে এটা ব্যবহার করা যাবে। ফোনের কোডের অপেক্ষায় থাকা অর্ডার একটা ব্যবহার ধরে রাখে; বাতিল হলে সেটা ফেরত আসে।',
+      onePerPhone: 'একটা মোবাইল নম্বরে একবার',
+      onePerPhoneHint: 'একই নম্বর থেকে দ্বিতীয় অর্ডারে এই কোড নেওয়া হবে না।',
+      submitNew: 'কুপন যোগ করুন',
+      submitEdit: 'পরিবর্তন সেভ করুন',
+      created: '{{code}} যোগ হয়েছে',
+      updated: '{{code}}-এর পরিবর্তন সেভ হয়েছে',
+    },
   },
   approvals: {
     title: 'অনুমোদন',
```

The same keys in Bangla; the type check fails if one is missing. "আর্কাইভ করুন", "ফিরিয়ে আনুন" and "বদলান" are
the words the other Storefront pages use, and "সর্বোচ্চ" is the word 27c.1's audit field and error already use for
"up to", so the form, the list and the audit log say one thing.

### The shop's promo line

```diff
@@ -120,6 +120,8 @@ export const shopEn = {
     applying: 'Applying…',
     removeCoupon: 'Remove the code',
     couponApplied: '{{code}} applied: {{off}} off',
+    // Step 27c: a percent coupon with a most it takes off ("10%, up to ৳200")
+    couponAppliedUpTo: '{{code}} applied: {{off}} off, up to {{upTo}}',
     payment: 'Payment Method',
     cod: 'Cash on Delivery',
     online: 'Mobile Banking',
```

```diff
@@ -105,6 +105,7 @@ export const shopBn: ShopMessages = {
     applying: 'প্রয়োগ হচ্ছে…',
     removeCoupon: 'কোডটি সরান',
     couponApplied: '{{code}} প্রয়োগ হয়েছে: {{off}} ছাড়',
+    couponAppliedUpTo: '{{code}} প্রয়োগ হয়েছে: {{off}} ছাড়, সর্বোচ্চ {{upTo}}',
     payment: 'পেমেন্টের উপায়',
     cod: 'ক্যাশ অন ডেলিভারি',
     online: 'মোবাইল ব্যাংকিং',
```

`couponAppliedUpTo` is decision 32. The two refusals the shop can now show (`shop_coupon_used_up` in the promo box,
`shop_coupon_used_by_phone` when the order is placed) are `errors.*` words from 27c.1; 27c.7 adds them to the
checkout island's word list.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm --filter @omnivo/app typecheck
```

The i18n tests include the check that every Bangla string keeps the English one's `{{placeholders}}`, so a Bangla
line that dropped `{{formatted}}` fails here, not on the screen. The shop's type check still fails on the mock quote
(`upTo` missing) until 27c.7. The words are not used by any screen yet: 27c.6 uses them, and 27c.8 looks for words no
screen uses and takes them out.

## 27c.6 — `apps/app`: the Coupons page

The ERP gets its Coupons page: Storefront → Shop coupons, for people with `storefront.manage`. It is a data table of
the shop's codes a page at a time, with a Current and an Archived tab and a search by code. One dialog form makes a
new coupon or changes one, and Archive asks first. The page follows the mockup approved before this part
(`.guide/work/mockup-27c6/`, 13 screens). Like every Storefront page it works online only.

Six decisions came up while building the screens (mine):

33. **The form is its own lazy chunk** (`components/storefront-coupon-form.tsx`), loaded the first time the dialog
    opens. With the form inside it, the page's chunk was 166.9 KB, over the 155 KB lazy budget: it carried the data
    table and the money boxes, the date picker and the form library together. Split, the page is 133.2 KB and the
    form 128.5 KB, and the budget stays where it was. The schedule dialog (step 21c) and the device dialogs (step 18c)
    were split the same way.
34. **The form sends its boxes as typed** (`zodResolver(…, { raw: true })`). The routes' body is the schema's input:
    the code, the kind and the value apart, every amount and the limit as strings. The schema's output is different
    (one `discount` object, a number or null), and the API parses the body itself. So the form checks the boxes with
    the same schema and then sends what they hold.
35. **An archived coupon opens nothing.** Its row has no click, and its menu has only Restore. An archived code is
    out of play: a change would be made to something the shop does not know, and Restore comes first.
36. **Switching to "Taka off" empties "Up to".** The box goes away, and the schema refuses an "up to" on an amount
    (`storefront_coupon_up_to`). Without this, a hidden box would keep its old value and block Save with an error
    nobody can see. The value box keeps its number (decision 17).
37. **On a phone, the row is the data table's own card**: the code as the title (with "Once per mobile number" under
    it), the status pill under it, the menu on the right, and the four facts (takes off, minimum order, days, used)
    as the card's labelled details. The mockup drew its own three-line card. One card component for every list
    keeps the phone views alike and needs no new code in `@omnivo/ui`.
38. **One more word, `storefront.coupons.columns.actions`**, the menu column's header for screen readers. 27c.5 had
    the menu button's name ("Actions for WELCOME10") but not the column's.

### `lib/storefront.ts`: the list's query

```diff
@@ -10,6 +10,7 @@ import {
   routes,
   shiftIsoDate,
   type StorefrontCategory,
+  type StorefrontCouponView,
   type StorefrontListing,
   type StorefrontListingSort,
   type StorefrontSale,
@@ -76,6 +77,33 @@ export function storefrontListingsQuery(tenantId: string, filter: ListingFilter)
   });
 }
 
+// Step 27c: the Coupons page, a page at a time, newest first (the contract's only order). The key
+// is under ['storefront', tenantId] like the rest of the menu, so useStorefrontRefresh() after a
+// save, an archive or a restore reads it again
+export interface CouponFilter {
+  view: StorefrontCouponView;
+  search: string;
+}
+
+export function storefrontCouponsQuery(tenantId: string, filter: CouponFilter) {
+  return infiniteQueryOptions({
+    queryKey: ['storefront', tenantId, 'coupons', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.storefrontCoupons.listCoupons, {
+        query: {
+          limit: 50,
+          view: filter.view,
+          ...(filter.search !== '' && { search: filter.search }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    // The other tab keeps the old rows until its first page comes: no flash of an empty table
+    placeholderData: keepPreviousData,
+  });
+}
+
 export function storefrontListingQuery(tenantId: string, listingId: string) {
   return queryOptions({
     queryKey: ['storefront', tenantId, 'listing', listingId],
```

The list is an infinite query like the catalog's: 50 coupons a page, the next page by the cursor. The key starts
with `['storefront', tenantId]`, so `useStorefrontRefresh()` after a save, an archive or a restore reads the list
again, and the tab and the search are part of the key, so each has its own pages. The search is sent only when there
is one: an empty `search` would still be a filter the API has to read. `keepPreviousData` keeps the old rows on the
screen while the other tab's first page loads, so the table does not flash empty.

### `routes/storefront-coupons.tsx`: the page

```tsx
import {
  Archive02Icon,
  ArchiveRestoreIcon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  CouponPercentIcon,
  Edit02Icon,
  HourglassIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  routes,
  STOREFRONT_COUPON_VIEWS,
  type StorefrontCoupon,
  type StorefrontCouponStatus,
  type StorefrontCouponView,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
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
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  toast,
} from '@omnivo/ui';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { failureOf } from '../components/journal-parts';
import {
  StorefrontOffline,
  useShopMoney,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { call } from '../lib/api';
import { storefrontCouponsQuery, storefrontSetupQuery } from '../lib/storefront';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 27c: Storefront → Shop coupons (decision 5), storefront.manage like the rest of the menu.
// The codes shoppers type in the checkout's promo box. A data table a page at a time (Current and
// Archived), one dialog form for a new coupon and a change, and an archive that asks first.
// Online only, like every storefront page. No "Changes show in the shop" line: the shop's quote
// reads the coupons fresh on every cart (step 27c.3), so a change works at once.

const column = dataTableColumns<StorefrontCoupon>();

// The form's chunk loads the first time Add coupon or a row is opened (storefront-coupon-form.tsx)
const CouponDialog = lazy(async () => ({
  default: (await import('../components/storefront-coupon-form')).CouponDialog,
}));

// The pill (STOREFRONT_COUPON_STATUSES, approved with the mockup): taken today = good, later =
// brand (work waiting to happen, not a problem), over = neutral, never warn: nothing to act on
const STATUS_PILLS = {
  active: { tone: 'good', icon: CheckmarkCircle02Icon },
  scheduled: { tone: 'brand', icon: Calendar03Icon },
  ended: { tone: 'neutral', icon: HourglassIcon },
  archived: { tone: 'neutral', icon: Archive02Icon },
} as const satisfies Record<StorefrontCouponStatus, { tone: string; icon: unknown }>;

function CouponStatusPill({ status }: { status: StorefrontCouponStatus }) {
  const { t } = useLocale();
  const pill = STATUS_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.coupons.statuses.${status}`)}
    </Pill>
  );
}

// The list's words for a coupon, shared by the table's cells and the dialog's titles. The money as
// the shop shows it (paisa only when there is some), the days as the app shows a date. An ISO day
// is read with local parts, never as UTC midnight, which is the day before west of Greenwich
function useCouponWords() {
  const { t, format } = useLocale();
  const money = useShopMoney();
  return useMemo(() => {
    const day = (isoDate: string) => format.date(new Date(`${isoDate}T00:00:00`));
    return {
      discount: ({ discount, upTo }: StorefrontCoupon) => {
        if (discount.kind === 'amount') {
          return t('storefront.coupons.amountOff', { amount: money(discount.value) });
        }
        const percent = format.number(discount.value);
        return upTo === null
          ? t('storefront.coupons.percentOff', { percent })
          : t('storefront.coupons.percentOffUpTo', { percent, upTo: money(upTo) });
      },
      minimum: ({ minimum }: StorefrontCoupon) =>
        minimum === null
          ? t('storefront.coupons.anyAmount')
          : t('storefront.coupons.minimumFrom', { amount: money(minimum) }),
      days: ({ startsOn, lastDay }: StorefrontCoupon) => {
        if (startsOn !== null && lastDay !== null) {
          return t('storefront.coupons.daysBetween', { from: day(startsOn), to: day(lastDay) });
        }
        if (startsOn !== null) return t('storefront.coupons.daysFrom', { from: day(startsOn) });
        if (lastDay !== null) return t('storefront.coupons.daysUntil', { to: day(lastDay) });
        return t('storefront.coupons.anyDay');
      },
      used: ({ used, usageLimit }: StorefrontCoupon) =>
        usageLimit === null
          ? t('storefront.coupons.used', { count: used, formatted: format.number(used) })
          : t('storefront.coupons.usedOf', {
              formatted: format.number(used),
              limit: format.number(usageLimit),
            }),
    };
  }, [t, format, money]);
}
```

- **`CouponDialog` is `lazy`** (decision 33). `lazy` needs a default export, so the import maps the named one.
- **`STATUS_PILLS` uses `satisfies Record<StorefrontCouponStatus, …>`.** A status added to the contract fails the
  type check here until it has a pill. The tones are the mockup's: Active is `good`, Scheduled `brand` (it will
  start, nothing to fix), Ended and Archived neutral. None is `warn`: no coupon needs someone to act.
- **`useCouponWords()` makes the four columns' words in one place.** The money goes through `useShopMoney()`, so a
  coupon shows taka the way the shop does (`৳50`, or `৳47.50` when it has paisa). The percent goes through
  `format.number`, so the Bangla page writes ১০%. `used` passes `count` for the plural and `formatted` for the
  digits, as 27c.5 set up.
- **A day is read as `new Date(`${iso}T00:00:00`)`**, a local date. `new Date('2026-12-31')` is UTC midnight, which
  is 30 Dec in any time zone west of Greenwich. The listing page's sale days are read the same way.

```tsx
// Decision 31: an archive asks first (the shop stops taking the code at once); a restore does not
function ArchiveDialog({ coupon, onDone }: { coupon: StorefrontCoupon; onDone: () => void }) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const archive = useMutation({
    mutationFn: () =>
      call(routes.storefrontCoupons.archiveCoupon, {
        params: { id: coupon.id },
        body: { version: coupon.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.coupons.archivedToast', { code: saved.code }));
      onDone();
    },
  });
  const failure = failureOf(archive.error);
  return (
    <DialogContent
      title={t('storefront.coupons.confirmArchive', { code: coupon.code })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={archive.isPending}
            onClick={() => {
              archive.mutate();
            }}
          >
            {t('storefront.coupons.archive')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {/* version_conflict: someone changed it meanwhile; Cancel and the list shows the new one */}
        {failure && <FormAlert message={failure} />}
        <p className="text-body-sm text-ink-2">{t('storefront.coupons.archiveBody')}</p>
      </div>
    </DialogContent>
  );
}

type Acting =
  | null
  | { kind: 'new' }
  | { kind: 'edit'; coupon: StorefrontCoupon }
  | { kind: 'archive'; coupon: StorefrontCoupon };
```

The archive dialog asks first (decision 31). Its text says what the shopper sees and that placed orders keep their
discount. It sends the coupon's `version`, so an archive over someone else's change is refused with
`version_conflict`, and the error shows in the dialog. `Acting` is one union for the three things the page may have
open, so two dialogs can never be open at once.

```tsx
export function StorefrontCouponsPage() {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const online = useOnline();
  const refresh = useStorefrontRefresh();
  const words = useCouponWords();
  const [view, setView] = useState<StorefrontCouponView>('current');
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [acting, setActing] = useState<Acting>(null);

  // "View shop" once the shop has an address. A coupon does not need the shop (the approved
  // mockup's last screen): it can be made before the shop is set up and waits for it
  const setup = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online });
  const shop = setup.data?.shop ?? null;
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontCouponsQuery(tenantId, { view, search: settled }),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const restore = useMutation({
    mutationFn: (coupon: StorefrontCoupon) =>
      call(routes.storefrontCoupons.restoreCoupon, {
        params: { id: coupon.id },
        body: { version: coupon.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.coupons.restoredToast', { code: saved.code }));
    },
    // No dialog to show it in: the toast says what went wrong (a version conflict)
    onError: (error) => {
      toast(errorText(failureOf(error) ?? 'unknown_error'));
    },
  });
  // mutate is stable; the mutation object is new on every render and would rebuild the columns
  const { mutate: restoreCoupon, isPending: restoring } = restore;

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('code', {
          header: t('storefront.coupons.columns.code'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* A code is typed by shoppers letter by letter: Geist Mono, like an order number */}
              <span className="font-mono font-medium whitespace-nowrap text-ink">
                {row.original.code}
              </span>
              {row.original.onePerPhone && (
                <span className="text-caption font-normal text-ink-3">
                  {t('storefront.coupons.onePerPhone')}
                </span>
              )}
            </span>
          ),
        }),
        column.accessor('discount', {
          header: t('storefront.coupons.columns.discount'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => <span className="tabular-nums">{words.discount(row.original)}</span>,
        }),
        column.accessor('minimum', {
          header: t('storefront.coupons.columns.minimum'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="text-ink-2 tabular-nums">{words.minimum(row.original)}</span>
          ),
        }),
        column.display({
          id: 'days',
          header: t('storefront.coupons.columns.days'),
          meta: { card: 'detail' },
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {words.days(row.original)}
            </span>
          ),
        }),
        column.accessor('used', {
          header: t('storefront.coupons.columns.used'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {words.used(row.original)}
            </span>
          ),
        }),
        column.accessor('status', {
          header: t('storefront.coupons.columns.status'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ getValue }) => <CouponStatusPill status={getValue()} />,
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">{t('storefront.coupons.columns.actions')}</span>,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ row }) => {
            const coupon = row.original;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.coupons.actions', { code: coupon.code })}
                    className="-my-1"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {coupon.status === 'archived' ? (
                    <DropdownMenuItem
                      icon={ArchiveRestoreIcon}
                      disabled={restoring}
                      onSelect={() => {
                        restoreCoupon(coupon);
                      }}
                    >
                      {t('storefront.coupons.restore')}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        icon={Edit02Icon}
                        onSelect={() => {
                          setActing({ kind: 'edit', coupon });
                        }}
                      >
                        {t('storefront.coupons.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        icon={Archive02Icon}
                        onSelect={() => {
                          setActing({ kind: 'archive', coupon });
                        }}
                      >
                        {t('storefront.coupons.archive')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }),
      ]),
    [t, words, restoreCoupon, restoring],
  );
```

- **The setup query is read only for "View shop".** A coupon does not need the shop (decision 23): it can be made
  before the shop is set up and waits for it. Without a shop the header has only "Add coupon" (the mockup's
  screen 11).
- **Both queries wait for `online`.** Offline the page shows `StorefrontOffline` and sends nothing.
- **The search waits 300 ms** (`useDebounced`) and is trimmed, so each key typed is not a request.
- **Restore has no dialog**, so its error (a version conflict) is a toast. `mutate` and `isPending` are taken out of
  the mutation, because the mutation object is new on every render and would rebuild the columns each time.
- **No column is sortable** (`enableSorting: false` on each one): newest first is the contract's only order. Without
  it, the data table would sort the loaded page in the browser and show sort buttons that lie.
- **The code is in Geist Mono**: shoppers type it letter by letter, as with an order number.
- **The menu changes with the status**: Edit and Archive, or Restore alone on an archived coupon (decision 35).

```tsx
  const add = (
    <Button
      onClick={() => {
        setActing({ kind: 'new' });
      }}
    >
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('storefront.coupons.add')}
    </Button>
  );

  // Why the table is empty: a search that found nothing first (it looks in this tab only), then
  // the tab itself. Only the first tab offers Add coupon: an empty Archived tab is good news
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('storefront.coupons.noMatchTitle')}
        description={t('storefront.coupons.noMatchBody')}
      />
    ) : view === 'archived' ? (
      <EmptyState
        icon={Archive02Icon}
        title={t('storefront.coupons.emptyArchivedTitle')}
        description={t('storefront.coupons.emptyArchivedBody')}
      />
    ) : (
      <EmptyState
        icon={CouponPercentIcon}
        title={t('storefront.coupons.emptyTitle')}
        description={t('storefront.coupons.emptyBody')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setActing({ kind: 'new' });
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
            {t('storefront.coupons.add')}
          </Button>
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.coupons.title')}
        description={t('storefront.coupons.description')}
        actions={
          online && (
            <>
              {shop !== null && <ViewShopLink href={shop.shopUrl} />}
              {add}
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.coupons.searchLabel')}
                placeholder={t('storefront.coupons.searchPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.coupons.view')}
              value={view}
              options={STOREFRONT_COUPON_VIEWS.map((value) => ({
                value,
                label: t(`storefront.coupons.views.${value}`),
              }))}
              onChange={setView}
            />
          </div>
          {isError && (
            <p role="alert" className="text-body-sm text-crit">
              {t('storefront.coupons.loadFailed')}
            </p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.coupons.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              // An archived coupon opens nothing: it is out of play, and Restore (its menu) comes
              // before a change
              onRowClick={
                view === 'current'
                  ? (coupon) => {
                      setActing({ kind: 'edit', coupon });
                    }
                  : undefined
              }
              onEndReached={loadMore}
              empty={empty}
              footer={
                isFetchingNextPage && (
                  <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
                )
              }
            />
          )}
        </>
      )}
      {acting?.kind === 'archive' && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActing(null);
          }}
        >
          <ArchiveDialog
            coupon={acting.coupon}
            onDone={() => {
              setActing(null);
            }}
          />
        </Dialog>
      )}
      {(acting?.kind === 'new' || acting?.kind === 'edit') && (
        // fallback null: the chunk comes in a moment, and an empty dialog frame would flash first
        <Suspense fallback={null}>
          <CouponDialog
            coupon={acting.kind === 'new' ? null : acting.coupon}
            onClose={() => {
              setActing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
```

- **The empty state says why the table is empty**, in this order: a search found nothing (it looks in the open tab
  only, `noMatchBody`), the Archived tab is empty, or there are no coupons yet. Only the last one offers "Add
  coupon": an empty Archived tab is good news.
- **The row click opens the form only on the Current tab** (decision 35).
- **The archive dialog and the form are separate `Dialog`s.** The form's dialog lives in the lazy chunk, and
  `Suspense` has `fallback={null}`: the chunk takes a moment the first time, and an empty dialog frame would flash
  before the form.

### `components/storefront-coupon-form.tsx`: the dialog form

```tsx
import { LockKeyholeIcon, CouponPercentIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  routes,
  SHOP_COUPON_KINDS,
  type ShopCouponKind,
  type StorefrontCoupon,
  updateStorefrontCouponInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  DatePicker,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  FormField,
  MoneyInput,
  SegmentedControl,
  TextField,
  toast,
} from '@omnivo/ui';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useStorefrontRefresh } from './storefront-parts';

// Step 27c: the coupon's dialog form, for a new coupon and a change. Its own lazy chunk, loaded the
// first time the dialog opens (like the schedule dialog, step 21c): the money boxes and the date
// picker would take the Coupons page over its lazy budget, and most visits only read the list.

// One form for both, the update schema: the create schema plus the version. A new coupon sends
// everything but the version. `raw: true` below: the API's body is what the boxes hold (strings,
// the kind and the value apart, z.input), so the form sends its own values after the schema has
// checked them, not the schema's output (one `discount` object and a number limit), which the
// route would refuse
const formSchema = updateStorefrontCouponInputSchema;
type FormValues = z.input<typeof formSchema>;

// The boxes the API may name in a refusal (storefront_coupon_code_taken lands under the code)
const FIELD_NAMES = [
  'code',
  'kind',
  'value',
  'upTo',
  'minimum',
  'startsOn',
  'lastDay',
  'usageLimit',
  'onePerPhone',
] as const satisfies readonly Path<FormValues>[];

// What the boxes hold for a coupon (or a new one). Everything is a string, like the form: '' is
// "none" for the optional boxes, and the schema turns it into null
function formValues(coupon: StorefrontCoupon | null): FormValues {
  if (coupon === null) {
    return {
      code: '',
      // Percent first: "10% off" is what most shops run
      kind: 'percent',
      value: '',
      upTo: '',
      minimum: '',
      startsOn: '',
      lastDay: '',
      usageLimit: '',
      onePerPhone: false,
      version: 1,
    };
  }
  return {
    code: coupon.code,
    kind: coupon.discount.kind,
    value: String(coupon.discount.value),
    upTo: coupon.upTo ?? '',
    minimum: coupon.minimum ?? '',
    startsOn: coupon.startsOn ?? '',
    lastDay: coupon.lastDay ?? '',
    usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
    onePerPhone: coupon.onePerPhone,
    version: coupon.version,
  };
}
```

- **One schema for both forms, the update schema** (the create schema plus `version`). A new coupon sends the fields
  without the version.
- **`FIELD_NAMES` lists every box the API may name**, so `applyApiError` puts `storefront_coupon_code_taken` under
  the code box and `storefront_coupon_dates` under the last day, and anything else at the top of the form.
- **`formValues()` writes every box as a string.** An empty optional box is `''`, which the schema reads as "none"
  (null); the API sends null, so the form turns it back into `''`. A percent comes back from the API as a number and
  goes into the box as text. A new coupon starts as a percent: "10% off" is what most shops run.

```tsx
function CouponForm({
  coupon: current,
  onDone,
}: {
  coupon: StorefrontCoupon | null;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const refresh = useStorefrontRefresh();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(formSchema, { error: contractErrorMap }, { raw: true }),
    defaultValues: formValues(current),
  });
  // The value box's label and control follow the kind; Up to is for a percent only
  const kind = useWatch({ control, name: 'kind' });

  const onSubmit = handleSubmit(async ({ version, ...fields }) => {
    try {
      const saved = current
        ? await call(routes.storefrontCoupons.updateCoupon, {
            params: { id: current.id },
            body: { ...fields, version },
          })
        : await call(routes.storefrontCoupons.createCoupon, { body: fields });
      await refresh();
      toast(
        t(current ? 'storefront.coupon.updated' : 'storefront.coupon.created', {
          code: saved.code,
        }),
      );
      onDone();
    } catch (error) {
      applyApiError(error, FIELD_NAMES, setError);
    }
  });

  return (
    <DialogContent
      title={
        current
          ? t('storefront.coupon.editTitle', { code: current.code })
          : t('storefront.coupon.newTitle')
      }
      description={t('storefront.coupon.description')}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="coupon-form" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : current
                ? t('storefront.coupon.submitEdit')
                : t('storefront.coupon.submitNew')}
          </Button>
        </>
      }
    >
      <form
        id="coupon-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        {current?.codeLocked ? (
          // Decision 16 (27c.1): an order has had the code, and its page and documents say it, so
          // the code is shown, not offered. The form still sends it (the default value): the API
          // compares it with the saved one and refuses only a change
          <Field
            id="coupon-code"
            label={t('storefront.coupon.code')}
            hint={t('storefront.coupon.codeLockedHint')}
          >
            <p
              id="coupon-code"
              aria-describedby="coupon-code-hint"
              className="flex min-h-[42px] items-center gap-2.5 rounded-control border border-line bg-subtle px-3 font-mono text-body text-ink"
            >
              <HugeiconsIcon
                icon={LockKeyholeIcon}
                size={17}
                strokeWidth={1.5}
                className="shrink-0 text-ink-3"
              />
              {current.code}
            </p>
          </Field>
        ) : (
          <TextField
            label={t('storefront.coupon.code')}
            icon={CouponPercentIcon}
            placeholder={t('storefront.coupon.codePlaceholder')}
            hint={t('storefront.coupon.codeHint')}
            // A code is a word to copy, not a sentence: no capital first letter, no spelling marks
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            {...register('code')}
            error={errors.code?.message}
          />
```

- **`raw: true`** (decision 34): `handleSubmit` gets the boxes as typed, after the schema has checked them.
- **The code box is read-only when `codeLocked`** (decision 16). It is a `subtle` box with a `LockKeyhole` icon, as
  in the mockup, not a disabled input: a disabled input looks like it might become editable. The form still holds
  the code as a value and sends it; the API compares it with the saved one and refuses only a change.
- **The code box has `autoCapitalize="characters"` and no spell check.** A code is a word to copy, not a sentence:
  a phone keyboard would capitalize only the first letter, and spelling marks under WELCOME10 are noise. The schema
  upper-cases it anyway.

```tsx
        )}
        <Controller
          control={control}
          name="kind"
          render={({ field }) => (
            <Field id="coupon-kind" label={t('storefront.coupon.kind')}>
              <SegmentedControl
                label={t('storefront.coupon.kind')}
                value={field.value}
                options={SHOP_COUPON_KINDS.map((value) => ({
                  value,
                  label: t(`storefront.coupon.kinds.${value}`),
                }))}
                onChange={(next: ShopCouponKind) => {
                  field.onChange(next);
                  // "৳50 off, up to ৳30" says two things, and the schema refuses an Up to on an
                  // amount: the box goes, and so does what it held. The value box keeps its
                  // number (decision 17): 10 typed as a percent is ৳10 as an amount
                  if (next === 'amount') setValue('upTo', '');
                }}
              />
            </Field>
          )}
        />
        {kind === 'percent' ? (
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
            <TextField
              label={t('storefront.coupon.values.percent')}
              inputMode="numeric"
              autoComplete="off"
              align="end"
              suffix="%"
              placeholder={t('storefront.coupon.percentPlaceholder')}
              {...register('value')}
              error={errors.value?.message}
            />
            <FormField
              control={control}
              name="upTo"
              label={t('storefront.coupon.upTo')}
              hint={t('storefront.coupon.upToHint')}
            >
              {(field) => <MoneyInput {...field} />}
            </FormField>
          </div>
        ) : (
          <FormField control={control} name="value" label={t('storefront.coupon.values.amount')}>
            {(field) => <MoneyInput {...field} />}
          </FormField>
        )}
        <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
          <FormField
            control={control}
            name="minimum"
            label={t('storefront.coupon.minimum')}
            hint={t('storefront.coupon.minimumHint')}
          >
            {(field) => <MoneyInput {...field} />}
          </FormField>
          <TextField
            label={t('storefront.coupon.usageLimit')}
            hint={t('storefront.coupon.usageLimitHint')}
            inputMode="numeric"
            autoComplete="off"
            align="end"
            {...register('usageLimit')}
            error={errors.usageLimit?.message}
          />
        </div>
        <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
          <FormField control={control} name="startsOn" label={t('storefront.coupon.startsOn')}>
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <FormField control={control} name="lastDay" label={t('storefront.coupon.lastDay')}>
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <p className="-mt-2 text-label text-ink-3 sm:col-span-2">
            {t('storefront.coupon.daysHint')}
          </p>
        </div>
        <Controller
          control={control}
          name="onePerPhone"
          render={({ field }) => (
            <div className="grid gap-1.5">
              <Checkbox
                id="coupon-one-per-phone"
                label={t('storefront.coupon.onePerPhone')}
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
                aria-describedby="coupon-one-per-phone-hint"
              />
              <p id="coupon-one-per-phone-hint" className="pl-[27px] text-label text-ink-3">
                {t('storefront.coupon.onePerPhoneHint')}
              </p>
            </div>
          )}
        />
      </form>
    </DialogContent>
  );
}
```

- **The kind is a segmented control**, the mockup's two choices side by side. Its `onChange` empties "Up to" when it
  becomes an amount (decision 36).
- **A percent is a plain number box with `%`** (whole numbers, 1 to 99), and an amount is a `MoneyInput` with `৳`.
  Both are the `value` field, so the number typed stays when the kind changes (decision 17). The listing page's sale
  works the same way.
- **The minimum and the limit sit side by side from `sm`**, and so do the two days, with the days' hint under both
  (it is about both).
- **"Once per mobile number" is a checkbox with its hint under it.** The hint is tied to the checkbox with
  `aria-describedby`, so a screen reader reads it with the label. `pl-[27px]` lines the hint up with the label's
  words (17 px box plus the 10 px gap).

```tsx
// The dialog itself, so the page renders nothing of the form until it is needed. `coupon` null =
// a new coupon. The key makes each coupon a fresh form: the boxes never keep the last one's values
export function CouponDialog({
  coupon,
  onClose,
}: {
  coupon: StorefrontCoupon | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CouponForm key={coupon?.id ?? 'new'} coupon={coupon} onDone={onClose} />
    </Dialog>
  );
}
```

`CouponDialog` owns its `Dialog`, so the page renders nothing of the form until it is needed. The `key` makes each
coupon a new form: opening FLAT50 after WELCOME10 never shows WELCOME10's boxes for a moment.

### The route and the sidebar

```diff
@@ -1079,6 +1079,17 @@ const storefrontListingRoute = createRoute({
   ),
 });
 
+// Step 27c: the shop's coupons (decision 5), behind storefront.manage like the catalog. One page:
+// a coupon opens in a dialog, so it has no address of its own
+const storefrontCouponsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/coupons',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-coupons'),
+    'StorefrontCouponsPage',
+  ),
+});
+
 const storefrontCategoriesRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/storefront/categories',
@@ -1292,6 +1303,7 @@ const routeTree = rootRoute.addChildren([
     storefrontOrderRoute,
     storefrontListingsRoute,
     storefrontListingRoute,
+    storefrontCouponsRoute,
     storefrontCategoriesRoute,
     storefrontSettingsRoute,
     storefrontAppearanceRoute,
```

One page with no address of its own for a coupon: a coupon opens in a dialog. The route sits after the listing's in
the tree, the same order as the sidebar.

```diff
@@ -11,6 +11,7 @@ import {
   CheckmarkBadge01Icon,
   Coins01Icon,
   ComputerPhoneSyncIcon,
+  CouponPercentIcon,
   DashboardSquare01Icon,
   DeliveryReturn01Icon,
   DeliveryTruck01Icon,
@@ -694,6 +695,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
                   <NavLink to="/storefront/listings" icon={Store04Icon}>
                     {t('nav.storefrontCatalog')}
                   </NavLink>
+                  {/* Step 27c (decision 29): after Catalog, both about the shop's prices */}
+                  <NavLink to="/storefront/coupons" icon={CouponPercentIcon}>
+                    {t('nav.storefrontCoupons')}
+                  </NavLink>
                   <NavLink to="/storefront/categories" icon={FolderLibraryIcon}>
                     {t('nav.storefrontCategories')}
                   </NavLink>
```

"Shop coupons" with the `CouponPercent` icon, right after Catalog (decision 29), inside the `storefront.manage`
block: someone with only `storefront.order.read` never sees it, and the API refuses the reads for them anyway.

### The column's word

```diff
@@ -6062,6 +6062,8 @@ export const en = {
         days: 'Days',
         used: 'Used',
         status: 'Status',
+        // The row menu's column: a header for screen readers only (27c.6)
+        actions: 'Actions',
       },
       // The discount column (decision 30). percent in the page's digits, upTo and amount with ৳
       percentOff: '{{percent}}% off',
```

```diff
@@ -5596,6 +5596,8 @@ export const bn: Messages = {
         days: 'দিন',
         used: 'ব্যবহার',
         status: 'অবস্থা',
+        // The row menu's column: a header for screen readers only (27c.6)
+        actions: 'কাজ',
       },
       percentOff: '{{percent}}% ছাড়',
       percentOffUpTo: '{{percent}}% ছাড়, সর্বোচ্চ {{upTo}}',
```

Decision 38. The type check fails if `bn.ts` lacks it.

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app typecheck
pnpm exec eslint apps/app/src/routes/storefront-coupons.tsx apps/app/src/components/storefront-coupon-form.tsx apps/app/src/lib/storefront.ts apps/app/src/router.tsx apps/app/src/routes/app-shell.tsx
pnpm exec prettier --check apps/app/src packages/i18n/src
pnpm --filter @omnivo/app test                      # 239 tests
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
```

The bundle check should print `initial JS 244.7 KB gz (budget 245.0 KB)`, the page at 133.2 KB and the form at
128.5 KB (budget 155 KB). The page cannot open in mock mode yet: its MSW handlers come in 27c.7, with the Playwright
tests that open it at 1440 px and 390 px and compare it with the mockup.

Two checks broken on purpose, then put back:

- the Bangla `actions` word taken out: the i18n type check fails;
- the `archived` pill taken out of `STATUS_PILLS`: the app's type check fails at the `satisfies`.

## 27c.7 — The shop's coupons, the mock Coupons page and the browser tests

Three pieces: the shop's own mock (`apps/shop`) judges a code with the contracts' rule instead of its own copy, and
the shop learns the new refusal `shop_coupon_used_by_phone`; the ERP's mock (`apps/app/src/mocks`) gets the six coupon
routes and the mockup's coupons; and Playwright walks both, in the shop and in the ERP, at desktop width and at 390 px.
Running the Coupons page in a browser for the first time found two mistakes in 27c.6's code, both fixed here.

Mine, made in this part:

39. **The shop's mock coupons are `ShopCouponRule`s, judged by `judgeShopCoupon()`**, and their uses are counted from
    the mock's order book, not kept as a number. The API counts its orders table the same way (decision 3), so a
    pending order holds a use only inside its hour, and a dropped one gives it back.
40. **`EID100` is used up from the start, by the demo order W-000121.** The shop's server is shared by every
    Playwright test in a run, so a test that used up a coupon would change every later test. A demo order that
    holds the only use shows "used up" from the first page load, and nothing a test does changes that.
41. **The ERP's mock keeps `used` and `codeLocked` on each coupon.** The ERP's mock has no shop checkout, so no
    order ever carries a code there; the numbers stand for the orders the API would count. The seeded days are
    counted from today, so an "Active" coupon never turns "Ended" on a later day and breaks a test.
42. **Fix (27c.6): the form writes the API's amounts as a person would.** The API sends `200.0000` (Postgres keeps
    `numeric(19,4)`), and the form's schema takes 2 decimals at most (decision 13). Put into the box as it came, the
    amount failed the schema, so a coupon with an "up to", a minimum or a taka amount could not be saved without
    retyping it. `plainAmount()` (from 26g, the listing's sale) turns `200.0000` into `200`.
43. **Fix (27c.6): the row menu no longer opens the row.** The row opens the form on a click or Enter, and React
    passes a menu's events up its own component tree, through the menu's portal too. A click on "Archive" reached
    the row, and the Edit form opened in place of the archive dialog. One wrapper around the menu stops both events.
44. **"(optional)" comes from `Field`'s `optional` prop**, in `ink-3` as CLAUDE.md asks, not from the words. 27c.5
    wrote it into five labels, so it was drawn in `ink` like the label. The words lose it; the form passes
    `optional`. The accessible name is the same ("Up to (optional)").
45. **The kind control keeps the app's `SegmentedControl`** (segments as wide as their words). The mockup drew two
    equal halves; one control everywhere matters more than this one's width.

### The shop's mock coupons

```diff
@@ -1,4 +1,4 @@
-import type { ShopCheckoutSettings, ShopDiscount } from '@omnivo/contracts';
+import type { ShopCheckoutSettings, ShopCouponRule } from '@omnivo/contracts';
 
 // Step 26c: what the mock shop offers at checkout. The zones and charges are Figma's
 // (checkout_process: Inside Dhaka ৳80, Outside Dhaka ৳120); the amounts are the ones CLAUDE.md's
@@ -14,27 +14,66 @@ export const mockCheckoutSettings = {
   minimumOrder: '300',
 } satisfies ShopCheckoutSettings;
 
-// A coupon as the shop keeps it. Not a contract: the shopper never sees a coupon list, only what
-// one code did to their cart (ShopCouponResult). The real coupons live in step 26's API.
-export interface MockCoupon {
-  // Upper case, as couponCodeSchema leaves the shopper's code
-  code: string;
-  discount: ShopDiscount;
-  // The items must be worth at least this much (the subtotal, decision 8). null: any amount
-  minimum: string | null;
-  // The last day it works, in the shop's time zone (ISO date). null: it never expires
-  lastDay: string | null;
-}
-
-// One of each case the promo box has words for: a percent, a fixed amount with a minimum, and an
-// expired code. Any other code is unknown
-export const mockCoupons: MockCoupon[] = [
-  { code: 'WELCOME10', discount: { kind: 'percent', value: 10 }, minimum: null, lastDay: null },
-  { code: 'FLAT50', discount: { kind: 'amount', value: '50' }, minimum: '500', lastDay: null },
+// Step 27c: the mock's coupons, as the API's quote reads them (ShopCouponRule in the contracts),
+// judged with the same judgeShopCoupon(). How many orders have each one is not kept here: the mock
+// counts its own order book (orders.ts → couponUses), like the API counts its orders table.
+// One of each case the promo box has words for:
+// - WELCOME10: a percent with a most it takes off, once per mobile number (the ERP mockup's)
+// - FLAT50: a fixed amount from a minimum
+// - OLD2025: ended (its last day has passed)
+// - EID100: used up from the start, by the demo order W-000121 (demo-orders.ts). A coupon a test
+//   uses up would be used up for every later test: the shop's server is shared by all of them
+// - SOON: not started, which the shopper is told is unknown (27c's decision 3)
+// Any other code is unknown
+export const mockCoupons: ShopCouponRule[] = [
+  {
+    code: 'WELCOME10',
+    discount: { kind: 'percent', value: 10 },
+    upTo: '200',
+    minimum: null,
+    startsOn: null,
+    lastDay: null,
+    usageLimit: null,
+    onePerPhone: true,
+  },
+  {
+    code: 'FLAT50',
+    discount: { kind: 'amount', value: '50' },
+    upTo: null,
+    minimum: '500',
+    startsOn: null,
+    lastDay: null,
+    usageLimit: null,
+    onePerPhone: false,
+  },
   {
     code: 'OLD2025',
     discount: { kind: 'percent', value: 20 },
+    upTo: null,
     minimum: null,
+    startsOn: null,
     lastDay: '2025-12-31',
+    usageLimit: null,
+    onePerPhone: false,
+  },
+  {
+    code: 'EID100',
+    discount: { kind: 'amount', value: '100' },
+    upTo: null,
+    minimum: null,
+    startsOn: null,
+    lastDay: null,
+    usageLimit: 1,
+    onePerPhone: false,
+  },
+  {
+    code: 'SOON',
+    discount: { kind: 'percent', value: 15 },
+    upTo: null,
+    minimum: null,
+    startsOn: '2099-01-01',
+    lastDay: null,
+    usageLimit: null,
+    onePerPhone: false,
   },
 ];
```

The mock's own `MockCoupon` type goes: a coupon is the contracts' `ShopCouponRule`, the shape the API's quote reads
from `storefront_coupons`. Each case the promo box has words for has one code (decision 40 for `EID100`). `SOON`
starts in 2099, so the mock shows what a coupon that has not started looks like to a shopper: "This code does not
exist" (decision 3). `WELCOME10` gets the mockup's "up to ৳200" and "once per mobile number"; every earlier test
priced carts under ৳2,000 with it, so its 10% never reaches the cap there and their totals stay the same.

```diff
@@ -1,7 +1,8 @@
 import {
   compareMoney,
+  judgeShopCoupon,
   multiplyMoney,
-  percentOfMoney,
+  shopCouponDiscount,
   subtractMoney,
   sumMoney,
   todayIn,
@@ -9,20 +10,20 @@ import {
   type ShopCartQuoteLine,
   type ShopCartQuoteRequest,
   type ShopCheckoutSettings,
-  type ShopCouponResult,
-  type ShopDiscount,
+  type ShopCouponRule,
   type ShopListing,
 } from '@omnivo/contracts';
 
-import type { MockCoupon } from './checkout';
-
 // Step 26c: what the quote needs besides the request: the listings, the shop's checkout settings
 // and coupons, the shop's time zone and the moment (a coupon's last day is a day in Dhaka, not in
 // UTC). One object, so a test changes only the part it is about.
+// Step 27c: the coupons are the contracts' ShopCouponRule, and `used` says how many orders have a
+// code now (the order book's count, orders.ts → couponUses)
 export interface QuoteContext {
   catalog: ShopListing[];
   settings: ShopCheckoutSettings;
-  coupons: MockCoupon[];
+  coupons: readonly ShopCouponRule[];
+  used: (code: string) => number;
   timeZone: string;
   now: Date;
 }
@@ -63,8 +64,22 @@ export function quoteCart(request: ShopCartQuoteRequest, context: QuoteContext):
   const sold = lines.filter((line) => line.status === 'available');
   const subtotal = sumMoney(sold.map((line) => line.lineTotal));
 
-  const coupon = couponResult(request.couponCode, subtotal, context);
-  const discount = coupon.status === 'applied' ? discountOf(coupon.discount, subtotal) : '0.0000';
+  // Step 27c: judged by the contracts' rule, the one the API's quote uses, so the mock can never
+  // apply a code the real shop refuses. The reasons go from "no such code" to "not any more" to
+  // "not for this cart" (27c's decision 15)
+  const code = request.couponCode;
+  const coupon = judgeShopCoupon(
+    code,
+    context.coupons.find((candidate) => candidate.code === code),
+    {
+      subtotal,
+      // Today in the shop's time zone: at 1 am on 1 January in Dhaka it is still 31 December in
+      // UTC, and a code that ended on the 31st must not work then
+      today: todayIn(context.timeZone, context.now),
+      used: code === undefined ? 0 : context.used(code),
+    },
+  );
+  const discount = coupon.status === 'applied' ? shopCouponDiscount(coupon, subtotal) : '0.0000';
 
   const { settings } = context;
   // Decision 8: both rules look at the subtotal, the items before the coupon
@@ -90,34 +105,3 @@ export function quoteCart(request: ShopCartQuoteRequest, context: QuoteContext):
     belowMinimum,
   };
 }
-
-// Decision 9: a code that does not apply is an answer, never an error. The checks go from "no such
-// code" to "not any more" to "not for this cart", so the reason given is the one that matters most
-function couponResult(
-  code: string | undefined,
-  subtotal: string,
-  context: QuoteContext,
-): ShopCouponResult {
-  if (code === undefined) return { status: 'none' };
-
-  const coupon = context.coupons.find((candidate) => candidate.code === code);
-  if (!coupon) return { status: 'refused', code, reason: 'shop_coupon_unknown', minimum: null };
-
-  // Today in the shop's time zone: at 1 am on 1 January in Dhaka it is still 31 December in UTC,
-  // and a code that ended on the 31st must not work then. ISO dates compare correctly as strings
-  if (coupon.lastDay !== null && todayIn(context.timeZone, context.now) > coupon.lastDay) {
-    return { status: 'refused', code, reason: 'shop_coupon_expired', minimum: null };
-  }
-  if (coupon.minimum !== null && compareMoney(subtotal, coupon.minimum) < 0) {
-    return { status: 'refused', code, reason: 'shop_coupon_minimum', minimum: coupon.minimum };
-  }
-  return { status: 'applied', code, discount: coupon.discount };
-}
-
-// What a coupon takes off the subtotal, to the paisa. A fixed amount never takes off more than the
-// items cost: ৳50 off a ৳30 cart is ৳30 off, so the total never goes below the delivery charge
-function discountOf(discount: ShopDiscount, subtotal: string): string {
-  if (discount.kind === 'percent') return percentOfMoney(subtotal, String(discount.value));
-  const amount = sumMoney([discount.value]);
-  return compareMoney(amount, subtotal) > 0 ? subtotal : amount;
-}
```

- **`judgeShopCoupon()` and `shopCouponDiscount()` replace the mock's `couponResult()` and `discountOf()`.** The rule
  now lives in one place, the contracts (decision 14). Before this, the mock had its own copy, which knew nothing of
  "up to", the first day, the limit or once per phone.
- **`used` is a function in the context**, not a number: the quote asks for the count of the one code it judges,
  when it judges it. A context made for a test, with no order book, counts none.
- **`today` is the shop's day** (`todayIn(timeZone, now)`), as before: a code that ends on 31 December must not work
  at 1 am on 1 January in Dhaka, which is still 31 December in UTC.

```diff
@@ -10,6 +10,7 @@ import {
   type ShopCheckoutSettings,
   type ShopCodeResent,
   type ShopCodeWait,
+  type ShopCouponRule,
   type ShopOrder,
   type ShopOrderConfirmed,
   type ShopOrderLine,
@@ -144,6 +145,22 @@ export function createOrderBook(
     return entry;
   }
 
+  // Step 27c: an order that holds a use of its coupon now (27c's decision 3): every order but a
+  // cancelled one, and one that waits for its phone code only inside its hour. The API's
+  // storefront_coupon_uses() counts the same orders. A dropped order (five wrong codes, or its hour
+  // over) is no longer in the book, so it gives its use back too
+  function holdsUse(entry: MockOrder, code: string): boolean {
+    const { order } = entry;
+    if (order.couponCode !== code || order.status === 'cancelled') return false;
+    return order.status !== 'pending' || entry.expiresAt > now().getTime();
+  }
+
+  function couponUses(code: string): number {
+    let uses = 0;
+    for (const entry of byToken.values()) if (holdsUse(entry, code)) uses += 1;
+    return uses;
+  }
+
   function confirm(entry: MockOrder): ShopOrderConfirmed {
     const at = now().toISOString();
     entry.order.status = 'confirmed';
@@ -152,12 +169,17 @@ export function createOrderBook(
   }
 
   return {
+    // Step 27c: what the quote's `used` reads (mock-source.ts)
+    couponUses,
+
     // Confirm Order. `quote` is the cart priced again on the server from the request's own lines,
-    // zone and coupon; this only decides whether the order may be placed with it
+    // zone and coupon; this only decides whether the order may be placed with it.
+    // Step 27c: `coupons` are the shop's, for the rule of the code the quote applied
     place(
       request: ShopOrderRequest,
       quote: ShopCartQuote,
       settings: ShopCheckoutSettings,
+      coupons: readonly ShopCouponRule[],
     ): SourceResult<PlacedOrder> {
       const zone = settings.zones.find((candidate) => candidate.id === request.zoneId);
       if (!zone) return { ok: false, code: 'shop_zone_unknown' };
@@ -191,9 +213,25 @@ export function createOrderBook(
       }
       // The zone was found, so the quote has its charge; `?? '0'` only satisfies the type
       const deliveryCharge = quote.deliveryCharge ?? '0';
+      // Step 27c: a coupon whose last use went to another order since the shopper's quote shows
+      // here too: the quote above says "used up" and takes nothing off, so its total is not the
+      // one the shopper saw. The checkout prices the cart again and the promo box says why
       if (compareMoney(quote.total, request.expectedTotal) !== 0) {
         return { ok: false, code: 'shop_order_changed' };
       }
+      // Step 27c: once per mobile number, now that the phone is known, after the total as in the
+      // API. Only for a code that took money off: a refused one is not kept on the order anyway
+      const applied = quote.coupon.status === 'applied' ? quote.coupon.code : null;
+      const rule = coupons.find((candidate) => candidate.code === applied);
+      if (
+        applied !== null &&
+        rule?.onePerPhone === true &&
+        [...byToken.values()].some(
+          (entry) => entry.order.phone === request.phone && holdsUse(entry, applied),
+        )
+      ) {
+        return { ok: false, code: 'shop_coupon_used_by_phone' };
+      }
 
       // Orders that never got their code are dropped once their hour is over. Done here, on the
       // way in, so a script that places orders all day cannot fill the server's memory with them
```

- **`holdsUse()` is the API's `storefront_coupon_uses()` in TypeScript**: every order with the code but a cancelled
  one, and a pending one only before its hour ends. An order dropped after five wrong codes, or past its hour, is
  deleted from the book, so it gives its use back without a rule of its own.
- **`couponUses` is returned by the book**, so the source can hand it to the quote (below).
- **Once per mobile number is checked after the total**, in the same order as the API (27c.3): a shopper whose cart
  changed is told that first. Only an applied code is checked; a refused one is not kept on the order anyway.
- **A last use taken by someone else is not a refusal of its own.** The quote made here, when the order is placed,
  already counts the other order and answers "used up", so its total is not the one the shopper saw and the order
  is refused with `shop_order_changed`. The checkout then prices the cart again, and the promo box says why. The
  API answers the same way.

```diff
@@ -13,12 +13,17 @@ import { createRateLimiter } from './rate-limit';
 import { mockCategories, mockShop } from './shop';
 
 // Step 26c: everything the mock prices a cart with, at one moment. Exported for the tests, which
-// price carts without a source
-export function mockQuoteContext(now: Date): QuoteContext {
+// price carts without a source. Step 27c: `used` counts a code's orders; a test without an order
+// book has none
+export function mockQuoteContext(
+  now: Date,
+  used: (code: string) => number = () => 0,
+): QuoteContext {
   return {
     catalog: mockCatalog,
     settings: mockCheckoutSettings,
     coupons: mockCoupons,
+    used,
     timeZone: mockShop.timeZone,
     now,
   };
@@ -40,7 +45,8 @@ export function createMockSource(
   demo: readonly MockDemoOrder[] = [],
 ): ShopSource {
   const orders = createOrderBook(now, demo);
-  const context = () => mockQuoteContext(now());
+  // Step 27c: each quote counts the coupon's orders in this source's own book
+  const context = () => mockQuoteContext(now(), orders.couponUses);
   // Step 27a: the /track form's misses, moved here from server/track.ts. The source's own clock, so
   // a test that moves time moves the window too
   const trackLimiter = createRateLimiter({
@@ -64,7 +70,9 @@ export function createMockSource(
     // browser says it costs (decision 10). The shopper's address is not used: the mock has no order
     // limits (data/mock/orders.ts)
     placeOrder: (request) =>
-      Promise.resolve(orders.place(request, quoteCart(request, context()), mockCheckoutSettings)),
+      Promise.resolve(
+        orders.place(request, quoteCart(request, context()), mockCheckoutSettings, mockCoupons),
+      ),
     codeWait: (token) => Promise.resolve(orders.codeWait(token)),
     verifyCode: (token, code) => Promise.resolve(orders.verify(token, code)),
     resendCode: (token) => Promise.resolve(orders.resend(token)),
```

The quote counts uses in the source's own book, so a test's source counts only its own orders, and the shop's one
source counts what its shoppers placed. `mockQuoteContext()` keeps a default of no uses for the tests that price
carts without a source.

```diff
@@ -1,6 +1,6 @@
 import type { ShopOrder, ShopOrderLine, ShopPaymentMethod, ShopShipment } from '@omnivo/contracts';
 
-import { mockCheckoutSettings } from './checkout';
+import { mockCheckoutSettings, mockCoupons } from './checkout';
 import type { MockDemoOrder } from './orders';
 import { mockCatalog } from './products';
 import { quoteCart } from './quote';
@@ -21,6 +21,9 @@ interface DemoInput {
   paymentMethod: ShopPaymentMethod;
   // [slug, quantity]: the listing as the catalog has it today
   items: readonly (readonly [string, number])[];
+  // Step 27c: the code the shopper typed, if any. It must apply: a code the quote refuses is a
+  // mistake in this file, like a slug the catalog does not have
+  couponCode?: string;
   shipments: ShopShipment[];
   trackingToken: string;
 }
@@ -39,15 +42,21 @@ function demoOrder(input: DemoInput): MockDemoOrder {
     {
       lines: input.items.map(([slug, quantity]) => ({ listingId: `lst-${slug}`, quantity })),
       zoneId: input.zoneId,
+      ...(input.couponCode === undefined ? {} : { couponCode: input.couponCode }),
     },
     {
       catalog: mockCatalog,
       settings: mockCheckoutSettings,
-      coupons: [],
+      // Step 27c: the shop's coupons, each with no use yet: priced as when it was placed
+      coupons: mockCoupons,
+      used: () => 0,
       timeZone: mockShop.timeZone,
       now: new Date(first.at),
     },
   );
+  if (input.couponCode !== undefined && quote.coupon.status !== 'applied') {
+    throw new Error(`${input.orderNo}: ${input.couponCode} does not apply`);
+  }
   // A slug that is not in the catalog, or a listing out of stock, is a mistake in this file: it
   // fails here, when the module loads, and every test fails with it. The fields are the ones
   // orders.ts's place() copies from a quote line
@@ -80,7 +89,7 @@ function demoOrder(input: DemoInput): MockDemoOrder {
       lines,
       subtotal: quote.subtotal,
       discount: quote.discount,
-      couponCode: null,
+      couponCode: quote.coupon.status === 'applied' ? quote.coupon.code : null,
       // The zone was given, so the quote has its charge; `?? '0'` only satisfies the type
       deliveryCharge: quote.deliveryCharge ?? '0',
       total: quote.total,
@@ -93,7 +102,8 @@ function demoOrder(input: DemoInput): MockDemoOrder {
 export const mockDemoOrders: readonly MockDemoOrder[] = [
   // Delivered in Dhaka, paid with Mobile Banking. The first booking (RedX) was cancelled before its
   // rider came, and the shop booked Pathao instead: the page's "Earlier parcel". Over ৳1,000, so
-  // the delivery was free
+  // the delivery was free. Step 27c: with EID100's only use (৳100 off), so that code answers
+  // "used up" in the shop from the start
   demoOrder({
     orderNo: 'W-000121',
     history: [
@@ -112,6 +122,7 @@ export const mockDemoOrders: readonly MockDemoOrder[] = [
       ['davidoff-espresso-coffee', 1],
       ['sprite-cold-drink-500ml', 2],
     ],
+    couponCode: 'EID100',
     shipments: [
       {
         courier: 'redx',
```

A demo order may name a coupon. It must apply: a code the quote refuses is a mistake in this file, and it throws
when the module loads, like a slug the catalog does not have. W-000121 (delivered, over ৳1,000) gets `EID100`, so its
total is ৳1,199 now; its delivery stays free, because the free delivery looks at the items before the coupon.

### The shop's new refusal

```diff
@@ -35,7 +35,9 @@ export type ShopRefusalCode =
   // Step 27a: the API's own limits (27a's decision 17)
   | 'shop_order_limit'
   | 'shop_code_expired'
-  | 'shop_code_sends_used';
+  | 'shop_code_sends_used'
+  // Step 27c: a once-per-mobile-number coupon this phone has an order with (27c's decision 3)
+  | 'shop_coupon_used_by_phone';
 
 // Step 27a: the /track form's refusals. Their own list, not ShopRefusalCode: the form is a page,
 // not one of the order routes, and draws them itself (server/track.ts), so they need no status in
```

```diff
@@ -34,6 +34,7 @@ const REFUSALS = {
   shop_order_limit: [429, 'Too many orders from this phone or connection.'],
   shop_code_expired: [422, 'The code has expired. Ask for a new one.'],
   shop_code_sends_used: [422, 'This order has had all its codes.'],
+  shop_coupon_used_by_phone: [422, 'This mobile number has an order with this coupon already.'],
 } as const satisfies Record<ShopRefusalCode, readonly [ProblemStatus, string]>;
 
 function refused(
```

```diff
@@ -97,6 +97,9 @@ export function createApiSource(api: ShopApi): ShopSource {
           'shop_order_below_minimum',
           'shop_order_changed',
           'shop_order_limit',
+          // Step 27c: without it here, the API's 422 would be a mistake (internal_error), and the
+          // shopper would never learn to take the code out
+          'shop_coupon_used_by_phone',
         ],
         'place order',
       );
```

`shop_coupon_used_by_phone` goes in three places, and each one matters:

- **`ShopRefusalCode`**: a source may answer it.
- **`REFUSALS` in `server/orders.ts`**: its HTTP status, 422 like the API (a rule broken, not a cart that changed).
  The `satisfies Record<ShopRefusalCode, …>` makes the type check fail until it has one.
- **The API source's list for `placeOrder`**: a refusal not in the list is treated as a mistake, so it throws and
  the shopper gets `internal_error`. Without this line, a shopper on a real shop would never learn that the code is
  the problem, only that "something went wrong".

### The promo box and the checkout's words

```diff
@@ -43,6 +43,12 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
     applying: t('shop.checkout.applying'),
     removeCoupon: t('shop.checkout.removeCoupon'),
     couponApplied: t('shop.checkout.couponApplied', { code: '{{code}}', off: '{{off}}' }),
+    // Step 27c: a percent with a most it takes off ("WELCOME10 applied: 10% off, up to ৳200")
+    couponAppliedUpTo: t('shop.checkout.couponAppliedUpTo', {
+      code: '{{code}}',
+      off: '{{off}}',
+      upTo: '{{upTo}}',
+    }),
     payment: t('shop.checkout.payment'),
     termsBefore: t('shop.checkout.termsBefore'),
     termsLink: t('shop.checkout.termsLink'),
@@ -65,7 +71,7 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
     removedOne: t('shop.cart.removed', { count: 1, replace: { count: '{{count}}' } }),
     removedOther: t('shop.cart.removed', { count: 2, replace: { count: '{{count}}' } }),
     // The error codes the checkout can show: the form's own checks, the order route's refusals
-    // and the promo box. 19 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
+    // and the promo box. 21 sentences, not the 400 of `errors.*`. `satisfies`: each key must be
     // a real error code, so a typo is a type error, not a missing sentence
     errors: {
       required: t('errors.required'),
@@ -88,6 +94,9 @@ export function checkoutWords({ t, money }: ShopLocale, settings: ShopCheckoutSe
       shop_coupon_unknown: t('errors.shop_coupon_unknown'),
       shop_coupon_expired: t('errors.shop_coupon_expired'),
       shop_coupon_minimum: t('errors.shop_coupon_minimum', MINIMUM),
+      // Step 27c: the quote's "every use is taken", and Confirm Order's "this phone had it"
+      shop_coupon_used_up: t('errors.shop_coupon_used_up'),
+      shop_coupon_used_by_phone: t('errors.shop_coupon_used_by_phone'),
     } satisfies Partial<Record<ErrorCode, string>>,
   };
 }
```

The two new error sentences join the 19 the checkout can show. `couponAppliedUpTo` is the 27c.5 word, sent to the
island with its placeholders kept, like `couponApplied`.

```diff
@@ -100,10 +100,17 @@ export function PromoBox({
                 strokeWidth={1.5}
                 aria-hidden="true"
               />
-              {fill(words.couponApplied, {
-                code: result.code,
-                off: discountText(result.discount, money),
-              })}
+              {/* Step 27c: a cap is part of the offer, so the line names it */}
+              {result.upTo === null
+                ? fill(words.couponApplied, {
+                    code: result.code,
+                    off: discountText(result.discount, money),
+                  })
+                : fill(words.couponAppliedUpTo, {
+                    code: result.code,
+                    off: discountText(result.discount, money),
+                    upTo: money(result.upTo),
+                  })}
             </span>
             {remove}
           </p>
```

"WELCOME10 applied: 10% off, up to ৳200": the cap is part of the offer (decision 32), so the shopper with a big cart
is not surprised that the discount is ৳200 and not ৳250. A refusal needs no change here: `errorText()` finds
`shop_coupon_used_up` in the words like any other reason. `shop_coupon_used_by_phone` comes from Confirm Order, not
from the quote, and `showRefusal()` shows it above the button like every refusal that names no box.

### The shop's tests

```diff
@@ -163,8 +163,13 @@ describe('quoteCart: coupons', () => {
   it('takes a percent off the items, never off the delivery', () => {
     const answer = quote({ lines, zoneId: 'inside_dhaka', couponCode: 'WELCOME10' });
     expect(answer).toMatchObject({
-      coupon: { status: 'applied', code: 'WELCOME10', discount: { kind: 'percent', value: 10 } },
-      // 10% of ৳807, to the paisa
+      coupon: {
+        status: 'applied',
+        code: 'WELCOME10',
+        discount: { kind: 'percent', value: 10 },
+        upTo: '200',
+      },
+      // 10% of ৳807, to the paisa, under its ৳200
       discount: '80.7000',
       deliveryCharge: '80.0000',
       total: '806.3000',
@@ -215,7 +220,16 @@ describe('quoteCart: coupons', () => {
     const generous: QuoteContext = {
       ...context,
       coupons: [
-        { code: 'BIG', discount: { kind: 'amount', value: '1000' }, minimum: null, lastDay: null },
+        {
+          code: 'BIG',
+          discount: { kind: 'amount', value: '1000' },
+          upTo: null,
+          minimum: null,
+          startsOn: null,
+          lastDay: null,
+          usageLimit: null,
+          onePerPhone: false,
+        },
       ],
     };
     const answer = quote(
@@ -225,4 +239,32 @@ describe('quoteCart: coupons', () => {
     // ৳120 of items, ৳120 off, and the delivery is still paid
     expect(answer).toMatchObject({ discount: '120.0000', total: '80.0000' });
   });
+
+  // Step 27c: the rules the contracts' judgeShopCoupon() added
+  it('takes no more than a percent coupon’s “up to”', () => {
+    // 10% of ৳2,500 is ৳250; WELCOME10 takes ৳200 at most
+    const answer = quote(
+      { lines: [{ listingId: STEVIA, quantity: 5 }], couponCode: 'WELCOME10' },
+      steviaAt('500'),
+    );
+    expect(answer).toMatchObject({ discount: '200.0000', total: '2300.0000' });
+  });
+
+  it('refuses a code every use of which is taken, counted by the order book', () => {
+    // EID100 may be on one order. With one order holding it, the next cart is refused
+    const used = mockQuoteContext(NOW, (code) => (code === 'EID100' ? 1 : 0));
+    expect(quote({ lines, couponCode: 'EID100' }, used)).toMatchObject({
+      coupon: { status: 'refused', code: 'EID100', reason: 'shop_coupon_used_up', minimum: null },
+      discount: '0.0000',
+    });
+    expect(quote({ lines, couponCode: 'EID100' }).coupon.status).toBe('applied');
+  });
+
+  it('answers “unknown” for a code that has not started yet', () => {
+    // SOON starts in 2099: the promo box must not announce a sale early (decision 3)
+    expect(quote({ lines, couponCode: 'SOON' }).coupon).toMatchObject({
+      status: 'refused',
+      reason: 'shop_coupon_unknown',
+    });
+  });
 });
```

The applied coupon now has `upTo`, and the custom coupon in "never takes off more than the items cost" has every
field of a rule. Three new cases: the cap (10% of ৳2,500 is ৳250, WELCOME10 takes ৳200), used up (a context that
counts one use of `EID100`, and the same cart without it applies), and a coupon that has not started.

```diff
@@ -249,4 +249,48 @@ describe('the mock’s orders', () => {
       { listingId: NEEM, quantity: 3, unitPrice: '229', lineTotal: '687.0000' },
     ]);
   });
+
+  // Step 27c: the coupon's uses, counted from the book as the API counts its orders table
+  it('takes a once-per-number code once per mobile number, counting an order still waiting', async () => {
+    const { source, wait } = withClock();
+    // ৳687 − 10% (৳68.70) + ৳80
+    const welcome = { ...ORDER, couponCode: 'WELCOME10', expectedTotal: '698.30' };
+    // Cash on Delivery: it waits for its code, and already holds the use
+    await placed(source, welcome);
+    expect(await source.placeOrder(welcome, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_coupon_used_by_phone',
+    });
+    // Another number may, and the same number may order without the code
+    await placed(source, { ...welcome, phone: '01711284519' });
+    await placed(source);
+
+    // The first order never got its code: after its hour it is dropped and gives the use back
+    wait(61 * 60);
+    await placed(source, welcome);
+  });
+
+  it('gives the last use to the first order, and back when that order is dropped', async () => {
+    const { source } = withClock();
+    // EID100 may be on one order: ৳687 − ৳100 + ৳80
+    const eid = { ...ORDER, couponCode: 'EID100', expectedTotal: '667' };
+    const { token } = await placed(source, eid);
+
+    // The next shopper's quote says "used up". One who saw ৳667 before is refused: the total
+    // without the code is not the one they saw, and the checkout prices the cart again
+    expect((await source.quote({ lines: ORDER.lines, couponCode: 'EID100' })).coupon).toMatchObject(
+      { status: 'refused', reason: 'shop_coupon_used_up' },
+    );
+    expect(await source.placeOrder({ ...eid, phone: '01711284519' }, ADDRESS)).toMatchObject({
+      ok: false,
+      code: 'shop_order_changed',
+    });
+
+    // Five wrong codes drop the first order, and the use is free again
+    for (let tries = 0; tries < SHOP_CODE_TRIES; tries += 1)
+      await source.verifyCode(token, '000000');
+    expect((await source.quote({ lines: ORDER.lines, couponCode: 'EID100' })).coupon.status).toBe(
+      'applied',
+    );
+  });
 });
```

- **Once per number counts an order still waiting for its code**: the first order is Cash on Delivery and never gets
  its code, and the second is already refused. Another number may, and the same number may order without the code.
  An hour later the first order is dropped, and the number may use the code again.
- **The last use goes to the first order**: the next quote says "used up", and a shopper who saw the discounted
  total is refused with `shop_order_changed`. Five wrong codes drop the first order, and the code applies again.

```diff
@@ -219,6 +219,17 @@ describe('POST /api/orders', () => {
     });
   });
 
+  // Step 27c
+  it('answers a coupon this mobile number has had with 422', async () => {
+    const source = createMockSource();
+    // ৳687 − 10% (৳68.70) + ৳80. The first order holds the use while it waits for its code
+    const welcome = { ...ORDER, couponCode: 'WELCOME10', expectedTotal: '698.30' };
+    await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, OPTIONS);
+    const response = await answerPlaceOrder(post('/api/orders', welcome), source, ADDRESS, OPTIONS);
+    expect(response.status).toBe(422);
+    expect(await problemOf(response)).toMatchObject({ code: 'shop_coupon_used_by_phone' });
+  });
+
   it('hides a failing source behind internal_error', async () => {
     const down: ShopSource = {
       ...createMockSource(),
```

```diff
@@ -415,6 +415,28 @@ describe('orders on the API source', () => {
     });
   });
 
+  // Step 27c: the API's 422 for a once-per-number coupon is an answer the checkout has words for,
+  // not a mistake. The fake API is the mock, which keeps the same rule
+  it('passes on a coupon this mobile number has had', async () => {
+    const { source } = setup();
+    const welcome = {
+      ...order,
+      couponCode: 'WELCOME10',
+      expectedTotal: (
+        await createMockSource().quote({
+          lines: order.lines,
+          zoneId: order.zoneId,
+          couponCode: 'WELCOME10',
+        })
+      ).total,
+    };
+    expect((await source.placeOrder(welcome, ADDRESS)).ok).toBe(true);
+    expect(await source.placeOrder(welcome, ADDRESS)).toEqual({
+      ok: false,
+      code: 'shop_coupon_used_by_phone',
+    });
+  });
+
   it('throws on a refusal the page has no words for', async () => {
     const { source, api } = setup();
     const { token } = await place(source);
```

The route answers 422 with the code, and the API source passes the API's 422 on as an answer. The fake API in the
source's tests is made of the mock, which now keeps the rule, so the test uses the real refusal, not a made-up one.

```diff
@@ -54,9 +54,11 @@ describe('the mock’s demo orders', () => {
 
   it('are priced like the checkout prices an order', () => {
     const [dhaka, chattogram, sylhet] = mockDemoOrders.map(({ order: demo }) => demo);
-    // Over ৳1,000 of items, so its delivery was free
+    // Over ৳1,000 of items, so its delivery was free. Step 27c: less EID100's ৳100. The free
+    // delivery still looks at the items before the coupon (26c's decision 8)
     expect(compareMoney(dhaka?.deliveryCharge ?? '', '0')).toBe(0);
-    expect(compareMoney(dhaka?.total ?? '', '1299')).toBe(0);
+    expect(dhaka).toMatchObject({ couponCode: 'EID100', discount: '100.0000' });
+    expect(compareMoney(dhaka?.total ?? '', '1199')).toBe(0);
     expect(compareMoney(chattogram?.total ?? '', '520')).toBe(0);
     // The contracts' fixture: ৳458 of items and ৳120 outside Dhaka
     expect(compareMoney(sylhet?.total ?? '', '578')).toBe(0);
```

W-000121's total with `EID100`'s ৳100 off.

```diff
@@ -20,10 +20,12 @@ async function waitForCheckout(page: Page): Promise<void> {
   await expect(page.getByRole('main').locator('form')).not.toHaveAttribute('inert');
 }
 
-async function fillDetails(page: Page): Promise<void> {
+// Step 27c: `phone` for a test whose orders must not meet another test's (a coupon that works once
+// per mobile number)
+async function fillDetails(page: Page, phone = '01786120356'): Promise<void> {
   await waitForCheckout(page);
   await page.getByRole('textbox', { name: 'Full Name' }).fill('Nusrat Jahan');
-  await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
+  await page.getByRole('textbox', { name: 'Mobile Number' }).fill(phone);
   await page.getByRole('textbox', { name: 'Delivery Address' }).fill('House 12, Road 5, Dhanmondi');
   await page.getByRole('radio', { name: 'Inside Dhaka — ৳80' }).check();
   // The box is sr-only under its icon (CLAUDE.md → Checkout lines), so a click on it is a click on
@@ -234,3 +236,53 @@ test('nothing typed into the checkout before its script runs is lost', async ({
   await page.getByRole('textbox', { name: 'Mobile Number' }).fill('01786120356');
   await expect(name).toHaveValue('Nusrat Jahan');
 });
+
+// Step 27c: the promo box with the mock's coupons (data/mock/checkout.ts), judged by the contracts'
+// rule. WELCOME10 is 10% off, up to ৳200, once per mobile number; EID100's one use is taken by the
+// demo order W-000121
+test('a coupon takes money off once per mobile number, and a used-up one says so', async ({
+  page,
+}) => {
+  // A number no other test (or an earlier try of this one) has ordered with: the shop's server,
+  // and its order book, live as long as the whole run
+  const phone = `0171${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
+  await page.goto(`/p/${SHAMPOO.slug}`);
+  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
+  await page.goto('/checkout');
+  await page.getByRole('button', { name: `One more ${SHAMPOO.name}` }).click();
+  await fillDetails(page, phone);
+  const main = page.getByRole('main');
+  const promo = page.getByRole('textbox', { name: 'Promo code' });
+  const status = page.getByRole('status').filter({ hasText: /code|applied/ });
+
+  await promo.fill('eid100');
+  await page.getByRole('button', { name: 'Apply Coupon' }).click();
+  await expect(status).toContainText('This code has been used as many times as the shop allows.');
+  await expect(main).toContainText('Total৳538');
+
+  await page.getByRole('button', { name: 'Remove the code' }).click();
+  await promo.fill('welcome10');
+  await page.getByRole('button', { name: 'Apply Coupon' }).click();
+  // ৳458 − 10% (৳45.80) + ৳80. The line names the cap, which this cart does not reach
+  await expect(status).toContainText('WELCOME10 applied: 10% off, up to ৳200');
+  await expect(main).toContainText('Total৳492.20');
+  await expectNoSideScroll(page);
+  await page.getByRole('button', { name: 'Confirm Order' }).click();
+  // The order waits for its code, and holds the use already: the cart is still there
+  await expect(page).toHaveURL('/checkout/verify');
+
+  // The same number again, with the same code: refused when the order is placed, the only moment
+  // the shop knows the phone
+  await page.goto('/checkout');
+  await fillDetails(page, phone);
+  await promo.fill('WELCOME10');
+  await page.getByRole('button', { name: 'Apply Coupon' }).click();
+  await expect(main).toContainText('Total৳492.20');
+  await page.getByRole('button', { name: 'Confirm Order' }).click();
+  await expect(
+    page.getByText(
+      'This code works once per mobile number, and this number has used it. Remove the code to order.',
+    ),
+  ).toBeVisible();
+  await expect(page).toHaveURL('/checkout');
+});
```

- **`fillDetails()` takes the phone**, so this test's orders never meet another test's.
- **The phone is random**: the shop's server, and its order book, live as long as the whole run. A retry of this
  test with a fixed number would find its own first order and be refused.
- **`EID100` first**: the box says it is used up, and the total is the cart without it.
- **`WELCOME10` then**: the line names the cap, and the total is ৳458 − ৳45.80 + ৳80. Confirm Order goes to the code
  page: the order waits for its code and holds the use already.
- **The same number again**: refused at Confirm Order, with the sentence that says to remove the code, and the page
  stays on the checkout.

### The ERP's mock: what it keeps

```diff
@@ -1,5 +1,6 @@
 import {
   type ErrorCode,
+  type ShopCouponRule,
   type ShopPaymentMethod,
   type ShopTextPageSlug,
   slugFromName,
@@ -164,6 +165,20 @@ export interface MockShopOrder {
   updatedAt: string;
 }
 
+// Step 27c: a coupon as the table keeps it (storefront-coupon-data.ts has the rules). The mock has
+// no shop checkout, so the orders that have a code are not real orders here:
+// - used: how many orders hold a use now (the API counts them with storefront_coupon_uses())
+// - codeLocked: an order has had the code (the API's first_ordered_at)
+export interface MockCoupon extends ShopCouponRule {
+  id: string;
+  used: number;
+  codeLocked: boolean;
+  archivedAt: string | null;
+  version: number;
+  createdAt: string;
+  updatedAt: string;
+}
+
 export interface MockStorefront {
   shop: MockShop | null;
   categories: MockCategory[];
@@ -178,6 +193,8 @@ export interface MockStorefront {
   pages: Map<ShopTextPageSlug, MockPage>;
   // Step 27b: the shop's confirmed orders, newest first (storefront-order-data.ts)
   orders: MockShopOrder[];
+  // Step 27c: the shop's coupons, archived ones too, in the order they were made
+  coupons: MockCoupon[];
 }
 
 export function emptyStorefront(): MockStorefront {
@@ -194,6 +211,7 @@ export function emptyStorefront(): MockStorefront {
     home: [],
     pages: new Map(),
     orders: [],
+    coupons: [],
   };
 }
 
```

`MockCoupon` is the rule plus what the table keeps (decision 41). The type sits beside the other storefront rows,
because `MockStorefront` lists it, and the seed file imports only types from the files that import it.

```ts
import {
  addMoney,
  type CreateStorefrontCouponInput,
  type ShopDiscount,
  type StorefrontCoupon,
  type storefrontCouponQuerySchema,
  storefrontCouponStatus,
  todayIn,
  type UpdateStorefrontCouponInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { MockProblem } from './mock';
import { pageOf } from './sales-document-data';
import type { MockCoupon } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27c: Storefront → Coupons with the API's rules (apps/api/src/storefront/admin/
// coupons.service.ts). Like storefront-order-data.ts, this file imports workspace-data.ts's type
// only, because workspace-data.ts imports the seed below; the audit rows are written by the
// handlers (handlers.ts), with the snapshots made here.
//
// The garments workspace has the mockup's coupons (27c.6): four in play (WELCOME10 and
// DIABETIC-CARE once per mobile number, FLAT50 until a day 6 weeks away, WINTER15 starting in 12
// days), two ended (PUJA20 by its last day, FIRST100 by its 100 uses) and two archived. Their days
// are counted from today, so the statuses stay the same on any day the tests run. The pharma
// workspace has none.

type CouponQuery = z.output<typeof storefrontCouponQuerySchema>;
// What the form saves: the same boxes for a new coupon and a change (less the version)
type CouponFields = Omit<UpdateStorefrontCouponInput, 'version'>;

function now(): string {
  return new Date().toISOString();
}

// Amounts as Postgres keeps them ("50.0000"), so the page reads what the API would send
function money(value: string): string {
  return addMoney(value, '0');
}

// An ISO day a number of days from another, counted on the calendar (UTC noon, so no clock change
// moves it a day)
function dayFrom(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// The pill's today: the workspace's, like the coupon's days (decision 2)
function todayOf(data: WorkspaceData): string {
  return todayIn(data.settings.timezone);
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

// The two refusals that belong to the code box (the API's codeTaken() and codeLocked())
function codeProblem(code: 'storefront_coupon_code_taken' | 'storefront_coupon_code_locked') {
  return new MockProblem(409, code, { code: [code] });
}

function findCoupon(data: WorkspaceData, id: string): MockCoupon {
  const coupon = data.storefront.coupons.find((candidate) => candidate.id === id);
  if (!coupon) throw notFound();
  return coupon;
}

// The code's unique key covers archived coupons too: restoring one must not meet its own code
// on another coupon
function assertCodeFree(data: WorkspaceData, code: string, except?: string): void {
  if (data.storefront.coupons.some((coupon) => coupon.code === code && coupon.id !== except)) {
    throw codeProblem('storefront_coupon_code_taken');
  }
}

export function toCoupon(data: WorkspaceData, coupon: MockCoupon): StorefrontCoupon {
  return {
    id: coupon.id,
    code: coupon.code,
    discount: coupon.discount,
    upTo: coupon.upTo,
    minimum: coupon.minimum,
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
    used: coupon.used,
    codeLocked: coupon.codeLocked,
    status: storefrontCouponStatus(coupon, todayOf(data)),
    version: coupon.version,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}
```

- **`workspace-data.ts` is imported for its type only.** `workspace-data.ts` imports `seedCoupons()` from this file,
  so a value import back would be an import cycle, which `pnpm boundaries` refuses. The audit rows are written by
  the handlers, which may import both. 27b's order file works the same way.
- **`money()` keeps amounts as Postgres does** (`50.0000`), so the page reads what the real API sends. That is how
  27c.6's form mistake showed up here (decision 42): a mock that sent `50` would have hidden it.
- **`dayFrom()` counts calendar days at noon UTC**, so no clock change moves a day.
- **The code is checked against every coupon, archived ones too**: the API's unique key covers them, so restoring
  an archived coupon can never meet its own code on another one.
- **`toCoupon()` works out the status with the contracts' `storefrontCouponStatus()`**, from the workspace's today,
  like the API.

```ts
// ---------------------------------------------------------------------------------------------
// The audit's view (the API's snapshot()): plain values, the discount as one short text

function discountText(discount: ShopDiscount): string {
  return discount.kind === 'percent'
    ? `percent ${String(discount.value)}`
    : `amount ${money(discount.value)}`;
}

export function couponSnapshot(coupon: CouponFields) {
  return {
    code: coupon.code,
    discount: discountText(coupon.discount),
    upTo: coupon.upTo === null ? null : money(coupon.upTo),
    minimum: coupon.minimum === null ? null : money(coupon.minimum),
    startsOn: coupon.startsOn,
    lastDay: coupon.lastDay,
    usageLimit: coupon.usageLimit,
    onePerPhone: coupon.onePerPhone,
  };
}

// The form's fields as the table keeps them: the amounts to 4 decimals, as Postgres does
function fieldsOf(input: CouponFields): CouponFields {
  return {
    code: input.code,
    discount:
      input.discount.kind === 'amount'
        ? { kind: 'amount', value: money(input.discount.value) }
        : input.discount,
    upTo: input.upTo === null ? null : money(input.upTo),
    minimum: input.minimum === null ? null : money(input.minimum),
    startsOn: input.startsOn,
    lastDay: input.lastDay,
    usageLimit: input.usageLimit,
    onePerPhone: input.onePerPhone,
  };
}

// ---------------------------------------------------------------------------------------------
// The routes

// Newest first, one tab at a time, by part of the code. The schema upper-cased the search, like
// the codes, so `includes` finds "WEL" in WELCOME10 and reads % and _ as themselves
export function couponPage(
  data: WorkspaceData,
  query: CouponQuery,
): { items: StorefrontCoupon[]; nextCursor: string | null } {
  const archived = query.view === 'archived';
  const search = query.search ?? '';
  const found = data.storefront.coupons
    .filter((coupon) => (coupon.archivedAt !== null) === archived)
    .filter((coupon) => search === '' || coupon.code.includes(search))
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const page = pageOf(found, query);
  return { items: page.items.map((coupon) => toCoupon(data, coupon)), nextCursor: page.nextCursor };
}

export function couponOf(data: WorkspaceData, id: string): StorefrontCoupon {
  return toCoupon(data, findCoupon(data, id));
}

// A coupon needs no shop (decision 23): it can be made before the shop is set up, and waits
export function createCoupon(data: WorkspaceData, input: CreateStorefrontCouponInput): MockCoupon {
  assertCodeFree(data, input.code);
  const at = now();
  const coupon: MockCoupon = {
    id: crypto.randomUUID(),
    ...fieldsOf(input),
    used: 0,
    codeLocked: false,
    archivedAt: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  data.storefront.coupons.push(coupon);
  return coupon;
}

// The version first, then the locked code (decision 16), then the code's owner: the API's order
export function updateCoupon(
  data: WorkspaceData,
  id: string,
  input: UpdateStorefrontCouponInput,
): { coupon: MockCoupon; before: CouponFields } {
  const coupon = findCoupon(data, id);
  if (coupon.version !== input.version) throw new MockProblem(409, 'version_conflict');
  if (coupon.codeLocked && input.code !== coupon.code) {
    throw codeProblem('storefront_coupon_code_locked');
  }
  assertCodeFree(data, input.code, id);
  const before = fieldsOf(coupon);
  Object.assign(coupon, fieldsOf(input), { version: coupon.version + 1, updatedAt: now() });
  return { coupon, before };
}

// Archive and restore. Asking for the state it is in already answers the coupon as it is, with no
// new version and no audit row (`changed`), like the API
export function setCouponArchived(
  data: WorkspaceData,
  id: string,
  version: number,
  archived: boolean,
): { coupon: MockCoupon; changed: boolean } {
  const coupon = findCoupon(data, id);
  if (coupon.version !== version) throw new MockProblem(409, 'version_conflict');
  if ((coupon.archivedAt !== null) === archived) return { coupon, changed: false };
  coupon.archivedAt = archived ? now() : null;
  coupon.version += 1;
  coupon.updatedAt = now();
  return { coupon, changed: true };
}
```

- **`couponSnapshot()` is the API's `snapshot()`**: the discount as one short text ("percent 10", "amount
  50.0000"), so the audit log shows "percent 10 → percent 15", and an amount typed as `50` is no change from
  `50.0000`.
- **The search is `includes`** on the code: the query's schema upper-cased it, like the codes. `%` and `_` are
  themselves, as in the API, where `containsPattern()` escapes them.
- **The update checks in the API's order**: the version, then the locked code, then whether another coupon has the
  code.
- **Archiving an archived coupon is no change**: it answers the coupon as it is, with no new version and no audit
  row (`changed`), like the API.

```ts
// ---------------------------------------------------------------------------------------------
// The seed

interface SeedCoupon {
  fields: CouponFields;
  used: number;
  // Days ago it was made, and archived (null: in play)
  madeDaysAgo: number;
  archivedDaysAgo: number | null;
}

export function seedCoupons(data: WorkspaceData): void {
  const today = todayOf(data);
  const day = (days: number) => dayFrom(today, days);
  const coupon = (fields: Partial<CouponFields> & Pick<CouponFields, 'code' | 'discount'>) => ({
    upTo: null,
    minimum: null,
    startsOn: null,
    lastDay: null,
    usageLimit: null,
    onePerPhone: false,
    ...fields,
  });
  const seeds: SeedCoupon[] = [
    {
      fields: coupon({
        code: 'WELCOME10',
        discount: { kind: 'percent', value: 10 },
        upTo: '200',
        usageLimit: 500,
        onePerPhone: true,
      }),
      used: 37,
      madeDaysAgo: 1,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'FLAT50',
        discount: { kind: 'amount', value: '50' },
        minimum: '500',
        lastDay: day(42),
      }),
      used: 112,
      madeDaysAgo: 9,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'WINTER15',
        discount: { kind: 'percent', value: 15 },
        upTo: '300',
        minimum: '1000',
        startsOn: day(12),
        lastDay: day(73),
      }),
      used: 0,
      madeDaysAgo: 14,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'DIABETIC-CARE',
        discount: { kind: 'amount', value: '100' },
        minimum: '1500',
        startsOn: day(-18),
        usageLimit: 100,
        onePerPhone: true,
      }),
      used: 18,
      madeDaysAgo: 20,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'PUJA20',
        discount: { kind: 'percent', value: 20 },
        minimum: '800',
        startsOn: day(-41),
        lastDay: day(-35),
      }),
      used: 64,
      madeDaysAgo: 60,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'FIRST100',
        discount: { kind: 'amount', value: '100' },
        minimum: '700',
        usageLimit: 100,
        onePerPhone: true,
      }),
      used: 100,
      madeDaysAgo: 120,
      archivedDaysAgo: null,
    },
    {
      fields: coupon({
        code: 'BOISHAKH25',
        discount: { kind: 'percent', value: 25 },
        upTo: '500',
        minimum: '1200',
        startsOn: day(-219),
        lastDay: day(-213),
      }),
      used: 41,
      madeDaysAgo: 230,
      archivedDaysAgo: 200,
    },
    {
      fields: coupon({ code: 'TEST5', discount: { kind: 'percent', value: 5 } }),
      used: 0,
      madeDaysAgo: 240,
      archivedDaysAgo: 235,
    },
  ];
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  data.storefront.coupons = seeds.map((seed) => ({
    id: crypto.randomUUID(),
    ...fieldsOf(seed.fields),
    used: seed.used,
    // A coupon with a use has had an order; one without (WINTER15, TEST5) may still change its code
    codeLocked: seed.used > 0,
    archivedAt: seed.archivedDaysAgo === null ? null : daysAgo(seed.archivedDaysAgo),
    version: 1,
    createdAt: daysAgo(seed.madeDaysAgo),
    updatedAt: daysAgo(seed.archivedDaysAgo ?? seed.madeDaysAgo),
  }));
}
```

The mockup's eight coupons, newest first in the order the mockup lists them. The days are counted from today
(decision 41): FLAT50 ends in 6 weeks, WINTER15 starts in 12 days, PUJA20 ended last month. A coupon with a use is
locked (it has had an order); WINTER15 and TEST5 never had one, so their codes can still change.

```diff
@@ -64,6 +64,7 @@ import {
   seedSalesDocuments,
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
+import { seedCoupons } from './storefront-coupon-data';
 import { seedShopOrders } from './storefront-order-data';
 import { emptyStorefront, type MockStorefront, seedStorefront } from './storefront-seed';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
@@ -249,6 +250,9 @@ function seed(workspace: Workspace): WorkspaceData {
   seedStorefront(data, garments);
   // Step 27b: after the shop it sells from (storefront-order-data.ts, fixtures.ts → seedsShopOrders)
   if (garments && seedsShopOrders()) seedShopOrders(data);
+  // Step 27c: the mockup's coupons (storefront-coupon-data.ts). A coupon needs no shop, but only
+  // the garments workspace has one to run them
+  if (garments) seedCoupons(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
```

Only the garments workspace, Rahman Fashion, has coupons. The pharma workspace has no shop and none, so the tests can
check the page before the shop is set up.

### The ERP's mock: the routes

```diff
@@ -209,6 +209,15 @@ import {
   updateCollection,
   updateTheme,
 } from './storefront-appearance-data';
+import {
+  couponOf,
+  couponPage,
+  couponSnapshot,
+  createCoupon,
+  setCouponArchived,
+  toCoupon,
+  updateCoupon,
+} from './storefront-coupon-data';
 import {
   cancelShopOrder,
   deliverShopOrder,
@@ -6223,4 +6232,86 @@ export const handlers = [
       return reply(routes.storefrontOrders.cancelOrder, toShopOrder(data, order));
     }),
   ),
+
+  // --- Step 27c: Shop coupons (storefront-coupon-data.ts) --------------------------------------
+  // storefront.manage, like every Storefront route but Shop orders (shopData())
+
+  mock(
+    routes.storefrontCoupons.listCoupons,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const query = readQuery(routes.storefrontCoupons.listCoupons.query, request);
+      await delay();
+      return reply(routes.storefrontCoupons.listCoupons, couponPage(data, query));
+    }),
+  ),
+
+  mock(
+    routes.storefrontCoupons.getCoupon,
+    guarded(async ({ params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontCoupons.getCoupon.params.parse(params);
+      await delay();
+      return reply(routes.storefrontCoupons.getCoupon, couponOf(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefrontCoupons.createCoupon,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.storefrontCoupons.createCoupon.body, request);
+      const coupon = createCoupon(data, body);
+      record(
+        data,
+        'storefront_coupon.created',
+        'storefront_coupon',
+        coupon.id,
+        diff({}, couponSnapshot(coupon)),
+      );
+      return reply(routes.storefrontCoupons.createCoupon, toCoupon(data, coupon));
+    }),
+  ),
+
+  mock(
+    routes.storefrontCoupons.updateCoupon,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontCoupons.updateCoupon.params.parse(params);
+      const body = await readBody(routes.storefrontCoupons.updateCoupon.body, request);
+      const { coupon, before } = updateCoupon(data, id, body);
+      record(
+        data,
+        'storefront_coupon.updated',
+        'storefront_coupon',
+        id,
+        diff(couponSnapshot(before), couponSnapshot(coupon)),
+      );
+      return reply(routes.storefrontCoupons.updateCoupon, toCoupon(data, coupon));
+    }),
+  ),
+
+  mock(
+    routes.storefrontCoupons.archiveCoupon,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontCoupons.archiveCoupon.params.parse(params);
+      const { version } = await readBody(routes.storefrontCoupons.archiveCoupon.body, request);
+      const { coupon, changed } = setCouponArchived(data, id, version, true);
+      if (changed) record(data, 'storefront_coupon.archived', 'storefront_coupon', id);
+      return reply(routes.storefrontCoupons.archiveCoupon, toCoupon(data, coupon));
+    }),
+  ),
+
+  mock(
+    routes.storefrontCoupons.restoreCoupon,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.storefrontCoupons.restoreCoupon.params.parse(params);
+      const { version } = await readBody(routes.storefrontCoupons.restoreCoupon.body, request);
+      const { coupon, changed } = setCouponArchived(data, id, version, false);
+      if (changed) record(data, 'storefront_coupon.restored', 'storefront_coupon', id);
+      return reply(routes.storefrontCoupons.restoreCoupon, toCoupon(data, coupon));
+    }),
+  ),
 ];
```

Six routes, each behind `shopData()` (`storefront.manage`, like the API's guard). The handlers write the audit rows
with the snapshots from the data file: `created` with every field, `updated` with what changed, and `archived` or
`restored` only when something changed.

### Two fixes in 27c.6's code

```diff
@@ -30,6 +30,7 @@ import type { z } from 'zod';
 
 import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
+import { plainAmount } from '../lib/storefront';
 import { useStorefrontRefresh } from './storefront-parts';
 
 // Step 27c: the coupon's dialog form, for a new coupon and a change. Its own lazy chunk, loaded the
@@ -58,7 +59,10 @@ const FIELD_NAMES = [
 ] as const satisfies readonly Path<FormValues>[];
 
 // What the boxes hold for a coupon (or a new one). Everything is a string, like the form: '' is
-// "none" for the optional boxes, and the schema turns it into null
+// "none" for the optional boxes, and the schema turns it into null. The API sends amounts as
+// Postgres keeps them, "200.0000", and the schema takes 2 decimals at most (decision 13), so
+// plainAmount() writes them as a person would ("200", "47.5"): else a coupon could not be saved
+// without retyping every amount (found by 27c.7's Playwright test)
 function formValues(coupon: StorefrontCoupon | null): FormValues {
   if (coupon === null) {
     return {
@@ -78,9 +82,12 @@ function formValues(coupon: StorefrontCoupon | null): FormValues {
   return {
     code: coupon.code,
     kind: coupon.discount.kind,
-    value: String(coupon.discount.value),
-    upTo: coupon.upTo ?? '',
-    minimum: coupon.minimum ?? '',
+    value:
+      coupon.discount.kind === 'amount'
+        ? plainAmount(coupon.discount.value)
+        : String(coupon.discount.value),
+    upTo: coupon.upTo === null ? '' : plainAmount(coupon.upTo),
+    minimum: coupon.minimum === null ? '' : plainAmount(coupon.minimum),
     startsOn: coupon.startsOn ?? '',
     lastDay: coupon.lastDay ?? '',
     usageLimit: coupon.usageLimit === null ? '' : String(coupon.usageLimit),
@@ -238,6 +245,7 @@ function CouponForm({
               control={control}
               name="upTo"
               label={t('storefront.coupon.upTo')}
+              optional
               hint={t('storefront.coupon.upToHint')}
             >
               {(field) => <MoneyInput {...field} />}
@@ -253,12 +261,14 @@ function CouponForm({
             control={control}
             name="minimum"
             label={t('storefront.coupon.minimum')}
+            optional
             hint={t('storefront.coupon.minimumHint')}
           >
             {(field) => <MoneyInput {...field} />}
           </FormField>
           <TextField
             label={t('storefront.coupon.usageLimit')}
+            optional
             hint={t('storefront.coupon.usageLimitHint')}
             inputMode="numeric"
             autoComplete="off"
@@ -268,10 +278,20 @@ function CouponForm({
           />
         </div>
         <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
-          <FormField control={control} name="startsOn" label={t('storefront.coupon.startsOn')}>
+          <FormField
+            control={control}
+            name="startsOn"
+            label={t('storefront.coupon.startsOn')}
+            optional
+          >
             {(field) => <DatePicker {...field} value={field.value ?? ''} />}
           </FormField>
-          <FormField control={control} name="lastDay" label={t('storefront.coupon.lastDay')}>
+          <FormField
+            control={control}
+            name="lastDay"
+            label={t('storefront.coupon.lastDay')}
+            optional
+          >
             {(field) => <DatePicker {...field} value={field.value ?? ''} />}
           </FormField>
           <p className="-mt-2 text-label text-ink-3 sm:col-span-2">
```

Decision 42 (the amounts) and decision 44 (`optional`). A percent is a whole number and needs no change.

```diff
@@ -289,47 +289,62 @@ export function StorefrontCouponsPage() {
           cell: ({ row }) => {
             const coupon = row.original;
             return (
-              <DropdownMenu>
-                <DropdownMenuTrigger asChild>
-                  <IconButton
-                    icon={MoreHorizontalIcon}
-                    label={t('storefront.coupons.actions', { code: coupon.code })}
-                    className="-my-1"
-                  />
-                </DropdownMenuTrigger>
-                <DropdownMenuContent align="end">
-                  {coupon.status === 'archived' ? (
-                    <DropdownMenuItem
-                      icon={ArchiveRestoreIcon}
-                      disabled={restoring}
-                      onSelect={() => {
-                        restoreCoupon(coupon);
-                      }}
-                    >
-                      {t('storefront.coupons.restore')}
-                    </DropdownMenuItem>
-                  ) : (
-                    <>
-                      <DropdownMenuItem
-                        icon={Edit02Icon}
-                        onSelect={() => {
-                          setActing({ kind: 'edit', coupon });
-                        }}
-                      >
-                        {t('storefront.coupons.edit')}
-                      </DropdownMenuItem>
+              // The row opens the form on a click or Enter. React passes a menu's events up its
+              // own tree, through the menu's portal too, so without this wrapper a click on the
+              // button or on "Archive" also reached the row, and the Edit form opened in place of
+              // the archive dialog (found by 27c.7's Playwright test). `contents`: the wrapper
+              // draws no box
+              <div
+                className="contents"
+                onClick={(event) => {
+                  event.stopPropagation();
+                }}
+                onKeyDown={(event) => {
+                  event.stopPropagation();
+                }}
+              >
+                <DropdownMenu>
+                  <DropdownMenuTrigger asChild>
+                    <IconButton
+                      icon={MoreHorizontalIcon}
+                      label={t('storefront.coupons.actions', { code: coupon.code })}
+                      className="-my-1"
+                    />
+                  </DropdownMenuTrigger>
+                  <DropdownMenuContent align="end">
+                    {coupon.status === 'archived' ? (
                       <DropdownMenuItem
-                        icon={Archive02Icon}
+                        icon={ArchiveRestoreIcon}
+                        disabled={restoring}
                         onSelect={() => {
-                          setActing({ kind: 'archive', coupon });
+                          restoreCoupon(coupon);
                         }}
                       >
-                        {t('storefront.coupons.archive')}
+                        {t('storefront.coupons.restore')}
                       </DropdownMenuItem>
-                    </>
-                  )}
-                </DropdownMenuContent>
-              </DropdownMenu>
+                    ) : (
+                      <>
+                        <DropdownMenuItem
+                          icon={Edit02Icon}
+                          onSelect={() => {
+                            setActing({ kind: 'edit', coupon });
+                          }}
+                        >
+                          {t('storefront.coupons.edit')}
+                        </DropdownMenuItem>
+                        <DropdownMenuItem
+                          icon={Archive02Icon}
+                          onSelect={() => {
+                            setActing({ kind: 'archive', coupon });
+                          }}
+                        >
+                          {t('storefront.coupons.archive')}
+                        </DropdownMenuItem>
+                      </>
+                    )}
+                  </DropdownMenuContent>
+                </DropdownMenu>
+              </div>
             );
           },
         }),
```

Decision 43. Most of the diff is the menu moving one level in. `className="contents"` makes the wrapper draw no box,
so the menu button sits where it did. It stops the keyboard too: Enter on the menu button, or on a menu item, would
otherwise also reach the row's Enter and open the form.

```diff
@@ -6119,15 +6119,15 @@ export const en = {
       // The value box's label follows the kind (decision 17)
       values: { percent: 'Percent off (1 to 99)', amount: 'Amount off' },
       percentPlaceholder: '10',
-      upTo: 'Up to (optional)',
+      upTo: 'Up to',
       upToHint: 'The most it takes off one order. Empty means no limit.',
-      minimum: 'Minimum order (optional)',
+      minimum: 'Minimum order',
       minimumHint: 'What the items must cost before delivery. Empty means any amount.',
-      startsOn: 'First day (optional)',
-      lastDay: 'Last day (optional)',
+      startsOn: 'First day',
+      lastDay: 'Last day',
       daysHint:
         'Whole days in your workspace’s time zone, both days included. Before the first day the shop says the code does not exist.',
-      usageLimit: 'Number of orders (optional)',
+      usageLimit: 'Number of orders',
       usageLimitHint:
         'How many orders may use it in all. An order waiting for its phone code holds a use; a cancelled one gives it back.',
       onePerPhone: 'Once per mobile number',
```

```diff
@@ -5644,15 +5644,15 @@ export const bn: Messages = {
       kinds: { percent: 'শতাংশ ছাড়', amount: 'টাকা ছাড়' },
       values: { percent: 'শতাংশ ছাড় (১ থেকে ৯৯)', amount: 'কত টাকা ছাড়' },
       percentPlaceholder: '10',
-      upTo: 'সর্বোচ্চ (ঐচ্ছিক)',
+      upTo: 'সর্বোচ্চ',
       upToHint: 'একটা অর্ডারে সবচেয়ে বেশি যত ছাড়। ফাঁকা মানে কোনো সীমা নেই।',
-      minimum: 'কমপক্ষে অর্ডার (ঐচ্ছিক)',
+      minimum: 'কমপক্ষে অর্ডার',
       minimumHint: 'ডেলিভারি চার্জ ছাড়া পণ্যের দাম অন্তত এত হতে হবে। ফাঁকা মানে যেকোনো অঙ্ক।',
-      startsOn: 'প্রথম দিন (ঐচ্ছিক)',
-      lastDay: 'শেষ দিন (ঐচ্ছিক)',
+      startsOn: 'প্রথম দিন',
+      lastDay: 'শেষ দিন',
       daysHint:
         'ওয়ার্কস্পেসের টাইম জোনে পুরো দিন, দুই দিনই ধরে। প্রথম দিনের আগে শপ বলবে কোডটি নেই।',
-      usageLimit: 'কয়টা অর্ডারে চলবে (ঐচ্ছিক)',
+      usageLimit: 'কয়টা অর্ডারে চলবে',
       usageLimitHint:
         'মোট কয়টা অর্ডারে এটা ব্যবহার করা যাবে। ফোনের কোডের অপেক্ষায় থাকা অর্ডার একটা ব্যবহার ধরে রাখে; বাতিল হলে সেটা ফেরত আসে।',
       onePerPhone: 'একটা মোবাইল নম্বরে একবার',
```

Decision 44: the five labels lose "(optional)"; `Field` adds `common.optional` in `ink-3`.

### The ERP's Playwright tests

```ts
import type { Page } from '@playwright/test';

import {
  expect,
  expectNoSideScroll,
  pinAnswered,
  test,
  toastShown,
  waitForCopy,
} from './helpers.js';

// Step 27c: Storefront → Shop coupons on the mock (mocks/storefront-coupon-data.ts). Rahman
// Fashion has the mockup's coupons: WELCOME10 (10% off, up to ৳200, once per mobile number, 37 of
// 500 used), FLAT50 (৳50 off from ৳500), WINTER15 (scheduled), DIABETIC-CARE, PUJA20 (ended by its
// last day), FIRST100 (ended by its 100 uses), and BOISHAKH25 and TEST5 archived. Every coupon but
// WINTER15 and TEST5 has had an order, so its code is locked. Karim Pharma has no shop and none.

// The nav item says "Shop coupons" (the phone's nav row has no group labels); the page's title is
// "Coupons", so openFromNav() (link name = heading) does not fit
async function openCoupons(page: Page): Promise<void> {
  await pinAnswered(page);
  await page.getByRole('navigation').getByRole('link', { name: 'Shop coupons' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Coupons' })).toBeVisible();
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await waitForCopy(page);
  await openCoupons(page);
}

// The tabs are a segmented control ("Show"): its radios are hidden, their words are the labels.
// Inside the control: "Archived" is a status pill in the table too
async function showTab(page: Page, name: 'Current' | 'Archived'): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

// A coupon's row (a card on a phone), by the code it starts with. listItem(page, /WELCOME10/) would
// also find the row's menu button, "Actions for WELCOME10"
function coupon(page: Page, code: string) {
  const name = new RegExp(`^${code} `);
  return page.getByRole('row', { name }).or(page.getByRole('button', { name }));
}

// `exact`: on a phone the card is a button too, and its name has the menu button's in it
async function rowMenu(page: Page, code: string, item: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${code}`, exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('lists the coupons, finds one by its code and adds one', async ({ page }) => {
  await start(page);
  await expectNoSideScroll(page);

  // The nav item sits right after Catalog (decision 29)
  const items = await page.getByRole('navigation').getByRole('link').allTextContents();
  const catalog = items.findIndex((text) => text.startsWith('Catalog'));
  expect(items[catalog + 1]).toBe('Shop coupons');

  // Newest first; each fact in the page's words
  await expect(coupon(page, 'WELCOME10')).toContainText('10% off, up to ৳200');
  await expect(coupon(page, 'WELCOME10')).toContainText('Once per mobile number');
  await expect(coupon(page, 'WELCOME10')).toContainText('37 of 500 used');
  await expect(coupon(page, 'FLAT50')).toContainText('From ৳500');
  await expect(coupon(page, 'WINTER15')).toContainText('Scheduled');
  await expect(coupon(page, 'PUJA20')).toContainText('Ended');
  await expect(coupon(page, 'FIRST100')).toContainText('100 of 100 used');
  await expect(page.getByText('BOISHAKH25')).toHaveCount(0);

  // Part of the code, in small letters too
  const search = page.getByRole('searchbox', { name: 'Search coupons' });
  await search.fill('wel');
  await expect(coupon(page, 'FLAT50')).toHaveCount(0);
  await expect(coupon(page, 'WELCOME10')).toBeVisible();
  await search.fill('EID');
  await expect(page.getByText('No coupon matches')).toBeVisible();
  await search.fill('');

  await page.getByRole('button', { name: 'Add coupon' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a coupon' });
  await expectNoSideScroll(page);
  await dialog.getByRole('textbox', { name: 'Code' }).fill('flat50');
  // Taka off: "Up to" goes away, the value box keeps its number (decision 36)
  await dialog.getByRole('textbox', { name: 'Percent off (1 to 99)' }).fill('25');
  await dialog.getByText('Taka off', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Up to (optional)' })).toHaveCount(0);
  // The money box shows its amount grouped, with 2 decimals, while it has no focus
  await expect(dialog.getByRole('textbox', { name: 'Amount off' })).toHaveValue('25.00');
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  // The code is the shop's own: the API's answer, under the box
  await expect(
    dialog.getByText('Another coupon has this code. Type a different one.'),
  ).toBeVisible();

  // A percent with a cap, from ৳1,000, two orders a number at most once each
  await dialog.getByRole('textbox', { name: 'Code' }).fill('eid25');
  await dialog.getByText('Percent off', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Up to (optional)' }).fill('500');
  await dialog.getByRole('textbox', { name: 'Minimum order (optional)' }).fill('1000');
  await dialog.getByRole('textbox', { name: 'Number of orders (optional)' }).fill('300');
  await dialog.getByRole('checkbox', { name: 'Once per mobile number' }).check();
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  await toastShown(page, 'EID25 added');
  await expect(coupon(page, 'EID25')).toContainText('25% off, up to ৳500');
  await expect(coupon(page, 'EID25')).toContainText('From ৳1,000');
  await expect(coupon(page, 'EID25')).toContainText('0 of 300 used');
  await expect(coupon(page, 'EID25')).toContainText('Active');
});

test('keeps a used code, archives a coupon and restores it', async ({ page }) => {
  await start(page);

  // An order has had WELCOME10: its code is shown, not a box. The rest may change
  await coupon(page, 'WELCOME10').click();
  const edit = page.getByRole('dialog', { name: 'Edit WELCOME10' });
  await expect(edit.getByText('An order has used this code, so it can’t change.')).toBeVisible();
  await expect(edit.getByRole('textbox', { name: 'Code' })).toHaveCount(0);
  await expectNoSideScroll(page);
  await edit.getByRole('textbox', { name: 'Number of orders (optional)' }).fill('600');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Changes to WELCOME10 saved');
  await expect(coupon(page, 'WELCOME10')).toContainText('37 of 600 used');

  // No order has had WINTER15 yet: its code is still a box
  await coupon(page, 'WINTER15').click();
  await expect(
    page.getByRole('dialog', { name: 'Edit WINTER15' }).getByRole('textbox', { name: 'Code' }),
  ).toHaveValue('WINTER15');
  await page.keyboard.press('Escape');

  // The row menu by keyboard opens the menu only, never the row's form
  await page.getByRole('button', { name: 'Actions for PUJA20', exact: true }).press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Archive asks first and says what the shopper sees
  await rowMenu(page, 'FLAT50', 'Archive');
  const ask = page.getByRole('dialog', { name: 'Archive FLAT50?' });
  await expect(ask).toContainText('Orders that have it keep their discount.');
  await ask.getByRole('button', { name: 'Archive' }).click();
  await toastShown(page, 'FLAT50 archived');
  await expect(coupon(page, 'FLAT50')).toHaveCount(0);

  // The Archived tab: no row opens a form, the menu has Restore only (decision 35)
  await showTab(page, 'Archived');
  await expect(page.getByText('BOISHAKH25')).toBeVisible();
  await expect(page.getByText('TEST5')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for FLAT50', exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Restore']);
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await toastShown(page, 'FLAT50 restored');
  await expect(page.getByText('FLAT50')).toHaveCount(0);
  await showTab(page, 'Current');
  await expect(coupon(page, 'FLAT50')).toContainText('Active');
});

test('works before the shop is set up', async ({ page }) => {
  await page.goto('/');
  await waitForCopy(page);
  await pinAnswered(page);
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');
  await openCoupons(page);

  // No shop to view yet; a coupon can still be made and waits for the shop (decision 23)
  await expect(page.getByRole('link', { name: 'View shop' })).toHaveCount(0);
  await expect(page.getByText('No coupons yet')).toBeVisible();
  await expectNoSideScroll(page);
  await page.getByRole('button', { name: 'Add coupon' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a coupon' });
  await dialog.getByRole('textbox', { name: 'Code' }).fill('WELCOME10');
  await dialog.getByRole('textbox', { name: 'Percent off (1 to 99)' }).fill('10');
  await dialog.getByRole('button', { name: 'Add coupon' }).click();
  await toastShown(page, 'WELCOME10 added');
  await expect(coupon(page, 'WELCOME10')).toContainText('0 used');
});
```

- **`openCoupons()` is the file's own**: the nav item says "Shop coupons" and the page's title "Coupons", and
  `openFromNav()` expects the two to be the same.
- **`coupon()` finds a row by the code it starts with.** `listItem(page, /WELCOME10/)` also finds the row's menu
  button, "Actions for WELCOME10", and Playwright refuses a locator that finds two things.
- **The menu button is found with `exact: true`**: on a phone the card is a button too, and its name includes the
  menu button's.
- **The first test** checks the nav item's place (right after Catalog), the list's words, the search (part of the
  code, in small letters, and "No coupon matches"), the switch to "Taka off" (Up to goes, the number stays, shown
  as `25.00` while the box has no focus), the code taken by FLAT50 under the code box, and a new coupon with every
  box filled.
- **The second test** edits WELCOME10 (its code is shown, not a box) and saves a new limit (the 27c.6 form could not:
  decision 42), opens the menu by keyboard (decision 43), archives FLAT50 (the dialog, the toast, gone from Current),
  and restores it from the Archived tab, whose menu has Restore only.
- **The third test** switches to Karim Pharma, which has no shop: no "View shop", the empty state, and a coupon
  made anyway (decision 23).

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/shop test                      # 251 tests
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                       # 239 tests
pnpm --filter @omnivo/i18n test                      # 21 tests
pnpm exec eslint apps/shop/src apps/shop/e2e apps/app/src/mocks apps/app/src/routes/storefront-coupons.tsx apps/app/src/components/storefront-coupon-form.tsx apps/app/e2e/storefront-coupons.e2e.ts
pnpm exec prettier --check apps/app/src apps/app/e2e apps/shop/src apps/shop/e2e packages/i18n/src
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
pnpm boundaries
pnpm --filter @omnivo/shop test:e2e -- e2e/shopping.e2e.ts                 # 14 tests
pnpm --filter @omnivo/app test:e2e -- e2e/storefront-coupons.e2e.ts --workers=2   # 6 tests
pnpm --filter @omnivo/app test:e2e -- e2e/storefront.e2e.ts e2e/storefront-appearance.e2e.ts e2e/storefront-orders.e2e.ts --workers=2   # 44 tests
```

The shop's type check passes again: 27c.1 gave the applied coupon an `upTo`, and the old mock quote did not send one.
The bundle check prints `initial JS 244.7 KB gz (budget 245.0 KB)`, the same as 27c.6 (the mocks are not in the
production build), the page 133.3 KB and the form 131.2 KB (budget 155 KB): `plainAmount()` brings a little of
`lib/storefront.ts` into the form's chunk.

The page was also drawn at 1440 px and 390 px and compared with the mockup: the same columns, words, pills and
order. The differences are decisions 37 (the phone card), 44 (now the same) and 45.

Two checks broken on purpose, then put back:

- the once-per-number check in the shop's mock turned off: three shop tests fail (the order book, the route's 422,
  and the API source);
- the row menu's click guard taken out: the ERP's archive test fails, because the Edit form opens in place of the
  archive dialog.

## 27c.8 — Run it and check it

The whole run found one thing the parts missed: `packages/contracts/openapi.json` was still the file of 27b, so
`pnpm test:openapi` failed. It is a generated file, so the fix is the command, not an edit:

```bash
pnpm --filter @omnivo/contracts gen:openapi
```

27c.3's "Check this part" now has it too. Nothing else changed: the code of 27c.1–27c.7 passed every check as it is.

### Try it

```bash
pnpm install
pnpm db:migrate        # 0073 and 0074
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

- [ ] The Storefront group has **Shop coupons** right after Catalog. The page is empty at first, with "Add coupon".
- [ ] Add `welcome10`: Percent off 10, Up to 50, Number of orders 2, Once per mobile number. The toast says
      "WELCOME10 added" (the code is upper case), and the row says "10% off, up to ৳50", "0 of 2 used", Active.
- [ ] At `http://demo-shop.localhost:4322`, put two shampoos (৳458) and a vitamin C face wash (৳159) in the cart,
      pick Inside Dhaka, and apply `welcome10`: "WELCOME10 applied: 10% off, up to ৳50", Total ৳647 (৳61.70 is cut to
      ৳50). Confirm the order with the code from Mailpit.
- [ ] The order's sales order has ৳37.12 off the shampoo line, ৳12.88 off the face wash and nothing off the delivery
      line, and its total is ৳647.00, like the shop's.
- [ ] Order again from the same mobile number with the same code: the checkout says "This code works once per mobile
      number, and this number has used it. Remove the code to order."
- [ ] Order from a second number (the last use), then apply the code from a third: "This code has been used as many
      times as the shop allows." The Coupons page says "2 of 2 used", and the edit form shows the code with "An
      order has used this code, so it can’t change."
- [ ] Cancel the second order on its Shop orders page: the page says "1 of 2 used", and the third number gets the
      discount again.
- [ ] Pack, ship and deliver the first order: the invoice has the same ৳37.12 and ৳12.88 off, and its total is ৳647.
- [ ] Archive WELCOME10 (it asks first): the shop now says "This code does not exist. Check how it is spelled." The
      Archived tab has it, with Restore.

## What comes next

- **27d:** online payment with SSLCommerz: a gateway interface with a fake one for development and CI, the shop's own
  encrypted credentials with "Test connection", payment without a phone code, a money receipt for a paid order, and
  "Pay online" in place of Mobile Banking (decisions 6–11).
- **Later:** coupons for one product or one category, if shops ask for them (decision 2).
- **Step 28:** courier bookings and their events on the tracking page and the order's timeline.
