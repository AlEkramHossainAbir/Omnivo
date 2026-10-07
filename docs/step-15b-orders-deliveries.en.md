# Step 15b: Quotations, sales orders and deliveries — from an offer to goods out of the gate

> The implementation guide for the second part of "Phase 5 → Step 15" of [build-plan.bn.md](build-plan.bn.md):
> which file gets what code, and which command runs where. Step 15 (Sales) is split into four guides: 15a
> (customers, price lists, VAT), this one (15b), then 15c (invoice, payment, credit limit) and 15d (returns and
> credit notes).
>
> Every file in this guide was placed in a separate copy of the repo (on top of commit `130d685`, the end of
> step 15a) and checked on 2026-10-07: `pnpm dedupe --check`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (287 — 22 new), `pnpm test:integration` (278 — 22 new), `pnpm test:tenant-leak` (55 — 5 new), `pnpm build`, `pnpm test:bundle-size` (first load 188.9 KB gz, budget 200; the quotation form 88.0 KB, the sales order form 92.0 KB, the delivery form 86.4 KB), `pnpm gen:openapi` (125 paths), `pnpm test:openapi`, `pnpm boundaries` and `pnpm test:e2e` (Playwright, 132 — 18 new, desktop and 390px) — all pass, with the turbo cache bypassed (`--force`).
>
> Also checked:
>
> - **The database rules on their own**, in a throwaway Postgres: every guard of migration 0028 was tried as
>   `omnivo_app` with SQL that the API would never send (15b.2's "What we checked").
> - **The whole chain in a browser**, through the end-to-end tests on a desktop and a 390px phone: a quotation at
>   the customer's prices, the order made from it, a partial delivery and its cost of goods sold, closing the
>   rest, and a pharmacy delivery split over two batches by first expiry.
> - **Guards broken on purpose**: take out the second `checkOrderLines()` in the API's `postAndLog()` → the "second
>   draft to post" test gets a 500 from the database guard instead of `delivery_over_order`. Turn off the mock's
>   `checkOrderLines()` → the e2e test "refuses to deliver more than the order has left" fails. Each check ran its
>   whole test file, and the code was restored after it.
>
> ⚠️ **Not checked:** (1) `pnpm dev` with your own `.env` and your own dev database: run `pnpm db:migrate` first
> (migrations 0027 and 0028), or every sales document page fails. (2) The new tests on GitHub Actions. (3) The
> Bangla texts were written by me, not reviewed by a native speaker. (4) The screens were not looked at by eye in
> the dark theme; the end-to-end tests clicked through them in the light theme at both sizes. (5) How the VAT
> inside a price is rounded (per line, half up, to the paisa) follows the VAT and SD Act 2012 as I know it; please
> have your VAT consultant confirm it before 15c prints it on an invoice.

## Goal

📦 **From "how much?" to goods on the truck.** 15a told the system who the customers are and what they pay. This
step lets a company sell to them the way it really works in Bangladesh: an offer (quotation), the buyer's
confirmed order, and the delivery challan that goes with the goods. Stock leaves the warehouse with the challan,
and the cost of those goods moves from the inventory to cost of goods sold at the same moment. The invoice (the
money side) is 15c.

After this step:

- **Quotations** (`QT-2026-27-0001`): a customer, lines with a price, a discount (% or ৳) and a VAT rate, a
  "valid until" date. Open, accepted (an order was made from it) or declined. An open quotation past its date
  shows "Expired".
- **Sales orders** (`SO-2026-27-0001`): written as a draft, numbered when confirmed. A confirmed order is what the
  company promised: the warehouse it ships from, the delivery date, the buyer's PO number and the shipping
  address. It becomes "Delivered" by itself when the last goods line is delivered, or it is closed (the rest is
  dropped) or cancelled (nothing was delivered).
- **Deliveries** (delivery challans, `DC-2026-27-0001`): goods out of one warehouse for one customer, with or
  without an order, with batch and serial numbers. Posting takes the stock out at the moving average cost and
  books Dr Cost of goods sold / Cr Inventory. An order can be delivered in several challans.
- **The price a line starts with**: the customer's price list, else the product's own price for that unit, with
  the product's VAT rate. "Use this customer's prices on every line" reprices a form on request.
- **"On order"** on the stock page: what customers ordered and did not get yet, next to what is on hand. Nothing
  is held for them.
- **The stock card and the journal link to the challan** that moved the stock or wrote the entry.
- **A discount box** in `@omnivo/ui`: a number with a % / ৳ switch inside it.

## The whole picture

```
packages/contracts   sales.ts (new: the line, its arithmetic) · quotations.ts · sales-orders.ts · deliveries.ts (new)
      │               money: percentOfMoney, includedTaxOf · stock: movement kind delivery, onOrder
      │               journal: source sales_delivery · series QT + DC · 3 permissions · 23 errors · 16 audit actions
      ▼
packages/db          quotations + quotation_lines · sales_orders + sales_order_lines (delivered_quantity)
                     deliveries + delivery_lines (step 13's stock line columns + order_line_id + value)
                     0027 (drizzle, indexes moved up) · 0028 (RLS, address FKs, what may change in which status)
      │
      ▼
apps/api             sales/: PriceLookupService · QuotationsService · SalesOrdersService · DeliveriesService
                     inventory: StockBooksService.delivery() (cost of goods sold) · stock list: onOrder
                     setup: the new permissions in the role templates of a new workspace
      │
      ▼
apps/app             /quotations · /sales-orders · /deliveries (list, new, one) · a shared sales line editor
                     stock page: On order · stock card and journal: link to the challan
                     packages/ui: DiscountInput · packages/i18n: the words, in English and Bangla
                     MSW: the same rules · Playwright: quotations, sales orders, deliveries

one delivery, from the click to the books:
  Post delivery ──POST /deliveries/{id}/post──► API, one transaction:
     lock the delivery, then its order (FOR UPDATE)
     date in an open period, not in the future · the lines again: goods, batches, serial numbers, stock on hand
     checkOrderLines(): never more than the order has left (delivery_over_order)
     number DC-2026-27-0001
     StockPostingService.post(): stock out at the moving average cost ──► each line's value (step 14)
     StockBooksService.delivery(): Dr Cost of goods sold / Cr Inventory, source sales_delivery
     order lines: delivered_quantity += · every goods line done? order → delivered · order version + 1
     audit · COMMIT
  Stock page: on hand and on order both go down · Order page: "Partly delivered" · Journal: "Delivery DC-…"
```

## The decisions behind this step

You made the first four on 2026-10-07; step 15's own choices (the flexible chain, the VAT snapshot per line, one
discount per line) are in the 15a guide. The others came up while building it; please read 5–22 with care:
they are mine.

1. **The delivery books the cost of goods sold.** (You chose this.) Posting a challan writes Dr Cost of goods sold
   / Cr Inventory at the moving average cost (step 14). The invoice in 15c books only the sale: the receivable,
   the sales account and the VAT. The cost leaves the books when the goods leave the warehouse, so the stock
   value and the inventory account stay equal every day.
2. **A confirmed order holds no stock.** (You chose this.) The stock page shows "On order" next to "On hand", and
   the store keeper decides. Reservations mean releasing them on every cancel, close and date change; they can
   come later without changing these tables.
3. **A delivery is one step, and partial deliveries are allowed.** (You chose this.) Draft → posted. An order can
   go out in several challans; each order line counts what was delivered, and the rest can be closed. Batches and
   serial numbers are picked on the challan, with "Split by first expiry" from step 13.
4. **No printing in 15b.** (You chose this.) A shared print and PDF layout for sales documents comes with 15c or
   later (step 16 in the build plan).
5. **A quotation is numbered when it is saved** (`QT`), because it is sent to the customer at once. Its statuses
   are open, accepted and declined. "Expired" is not stored: it is an open quotation whose "valid until" date has
   passed, worked out by the page, so no job has to run at midnight.
6. **An order is numbered when it is confirmed** (`SO`). A draft is the salesperson's notes; the number is the
   promise. A confirmed order with no delivery at all (not even a draft) can go back to draft, keeping its number,
   and be confirmed again. A partly delivered order cannot change: close it and write a new one.
7. **A draft order that has a number cannot be deleted** (`order_numbered`). The number was sent to the buyer; a
   gap in the series would look like a lost order. Confirm it again and cancel it, so it stays in the list.
8. **A quotation is accepted by making an order from it**, not by a button. The order copies the quotation's
   lines, its customer and its "prices include VAT"; deleting that draft order makes the quotation open again.
   A draft order from a quotation, or one that has a number, keeps its customer.
9. **The line arithmetic lives in the contract**, in exact `BigInt` like step 14's money functions: quantity ×
   price, less the discount, then the VAT, rounded per line to the paisa; the totals are the sums of the lines.
   The form, the API and the mock call the same `lineAmounts()`, so the screen and the saved document never
   differ by a paisa.
10. **Each document keeps a snapshot**: its own "prices include VAT", and on each line the VAT rate's name, kind
    and percent and the line's description. The shipping address is kept as text. Changing a rate, a product or
    an address later never changes a document.
11. **Services may be quoted and ordered, but not delivered.** A "Delivery charge" line is billed by the invoice.
    An order counts as delivered when every goods line is.
12. **A challan has no prices.** It says what left and for whom; the invoice (15c) prices it. Its lines keep their
    cost, which only people with `inventory.stock.value` see.
13. **A delivery is checked against its order on every save, and again when it is posted**, under a lock on the
    order. Two drafts may each look fine alone; the second one to post is refused (`delivery_over_order`).
14. **No undo for a posted delivery.** Goods that come back are a sales return (15d), with its own document and
    its own entry. Close and cancel leave draft deliveries alone; posting one then says the order is no longer
    confirmed.
15. **The price lookup is one endpoint**, `POST /sales/price-lookup`: the customer's active price list for that
    variant and unit, else the variant's sale price × the unit's factor, else no price; and the product's VAT
    rate, else the workspace default. An archived list falls back to the product prices.
16. **Reading a sales document needs no permission**, like a stock document. Writing needs one of three new
    ones: `sales.quotation.manage`, `sales.order.manage`, `sales.delivery.manage`. In a distributor, the officer
    writes orders and the depot posts the challans.
17. **New workspaces give these permissions to the roles that do the work.** Quotations and orders go to the
    people who sell (Merchandiser, Sales representative, Sales officer, Shop manager, Manager); deliveries to the
    people who keep the stock (Store keeper, Depot manager, Shop manager, Manager). The Accountant gets neither.
18. **The database guards every status.** Migration 0028 refuses changing an answered quotation, a confirmed order
    (except its status and delivered quantities) or a posted delivery, whatever code sends it. The API checks
    first and answers with an error code; the guards are the safety net.
19. **Changing the customer on a form does not reprice its lines.** A price typed from the buyer's PO must not
    vanish. A link at the top of the lines does it on request.
20. **"Add items" adds every active variant of a product**, each in its selling unit at the looked-up price. A
    garments order is sizes and colours line by line; removing a line is quicker than adding six.
21. **One line editor for quotations and orders**, holding the lines as one controlled value. It is its own lazy
    chunk, because it pulls in `decimal.js`; the form's route stays under the 100 KB budget.
22. **The delivery form fills itself from the order**: what is left on each line, the order's warehouse and
    address. Changing the customer drops the order and its lines, since a challan cannot mix two customers.

## Not in this step, on purpose

| What | Why not now / when |
|---|---|
| Invoices, payments, the credit limit check | 15c |
| Sales returns, credit notes, undoing a posted delivery | 15d (decision 14) |
| Printing a quotation, order or challan; PDF; email | 15c or later, with one layout for every sales document (decision 4) |
| Holding stock for an order (reservation) | Decision 2; "On order" shows the need instead |
| Changing a partly delivered order | Close it and write a new order (decision 6) |
| A discount on the whole document | Later; each line has its own discount |
| Export prices in USD (FOB) | Later, with multi-currency; today every amount is in taka |
| Quantity breaks, supplementary duty (SD), Mushak 6.3 | Later, as 15a said |
| Approval of an order before it is confirmed | Step 17 brings a configurable approval workflow for purchases; sales can use it later |

## What changes in the code you already have

- **No new package**, no new `.env` line, no new database role, no new worker job.
- **`pnpm db:migrate`** adds six tables (0027) and their rules (0028), and writes the three new permissions. Then
  restart `pnpm dev` so the API has the new routes.
- **Contracts:** `money.ts` gets `requiredPriceSchema`, `isMoneyAmount()`, `percentOfMoney()` and
  `includedTaxOf()`; `stock.ts` a movement kind `delivery` and `onOrder` on each stock item; `journal.ts` the
  source `sales_delivery`; two number series (`QT`, `DC`) on the Numbering page.
- **Database:** step 13's stock line columns are exported (`stockLineColumns`), so a delivery line is a stock line;
  the journal's document check knows `sales_delivery`.
- **API:** `InventoryModule` exports `ValueAccess`; `StockBooksService` gets `delivery()`; the stock list sends
  `onOrder`; deleting a customer or a product variant that a sales document uses answers `customer_in_use` or
  `product_variant_in_use`; the role templates give the new permissions (decision 17) — for **new** workspaces.
  Existing roles do not get them; an owner ticks them on the Roles page.
- **ui:** `MoneyInput`'s typing rules move into a file-internal `DecimalInput` that the new `DiscountInput` shares.
  `SegmentedControl` scrolls inside its own box when its options are wider than the screen.
- **app:** the stock page has an "On order" column; the stock card and a journal entry link to the delivery; the
  customer picker can offer "All customers" (for list filters); the stock line row takes a note under the item;
  the journal list and the revaluation form load their date picker lazily (the 100 KB budget, 15b.6).
- **Existing tests that change:** the numbering test counts 13 series; the setup test expects the garments roles'
  new permissions; the stock unit test expects a link for `delivery`; the money tests cover the new functions;
  the sales tenant-leak test gets B's sales documents.

---

## 15b.1 — `packages/contracts`: the contract

As in every step, the contract comes first: the shapes the API sends and accepts, the permissions, the error
codes and the number series. The API and the app both read these files, so once this part type-checks, the next
parts cannot disagree about a field name.

Four new files hold the new things. `sales.ts` is the part every sales document shares: one line with a price, a
discount and a VAT rate, and the arithmetic that turns it into amounts. `quotations.ts`, `sales-orders.ts` and
`deliveries.ts` are the three documents. The other changes are small: two helpers in `money.ts`, a new kind of
stock movement, a new journal source, two number series, three permissions, the error codes and the audit actions.

### `money.ts`: a percent, and the VAT inside a price

```diff
@@ -24,6 +24,15 @@ export const priceSchema = z
   .transform((value) => (value === '' ? null : value))
   .nullable();
 
+// A price that must be there: the price on a sales line (step 15b). ৳0 is a price — a free sample
+// is a real line — but an empty box is a price nobody typed. One error per box: the format check
+// leaves an empty box to the first one.
+export const requiredPriceSchema = z
+  .string()
+  .trim()
+  .refine((value) => value !== '', errorCode('sales_price_required'))
+  .refine((value) => value === '' || MONEY.test(value), errorCode('money_format'));
+
 // The arithmetic below works in ten-thousandths of a taka, as BigInt: "18450.5" is 184505000n.
 // Exact like decimal.js for what the journal does — adding and subtracting amounts with at most
 // 4 decimals, so nothing is ever rounded — and it keeps this package on zod alone (the
@@ -49,6 +58,11 @@ function fromUnits(units: bigint): string {
   return `${units < 0n ? '-' : ''}${String(size / UNITS_PER_TAKA)}.${fraction}`;
 }
 
+// A complete amount with at most 4 decimals: what a price box must hold before a line is worked out
+export function isMoneyAmount(value: string): boolean {
+  return MONEY.test(value);
+}
+
 // '' counts as 0, so a half-filled form can be totalled while it is typed
 export function isZeroMoney(value: string): boolean {
   return value === '' || toUnits(value) === 0n;
@@ -138,3 +152,25 @@ export function unitCostOf(value: string, quantity: string): string {
   // value (10^-4) × 10^4 ÷ quantity (10^-4) = 10^-4 taka per unit
   return fromUnits(divideRounded(toUnits(value) * 10_000n, quantityUnits));
 }
+
+// ---------------------------------------------------------------------------------------------
+// Sales lines (step 15b): a percent discount and the VAT, to the paisa
+
+const HUNDRED_PERCENT = 100n * UNITS_PER_TAKA;
+
+// percent % of an amount, to the paisa: 15% of ৳1,234.50 = ৳185.18 (185.175 rounds up). A line's
+// percent discount, and the VAT on a price typed without VAT.
+export function percentOfMoney(amount: string, percent: string): string {
+  // amount (10^-4) × percent (10^-4) = 10^-8, and ÷ 100 for the percent: one paisa is 10^8 of those
+  return fromUnits(divideRounded(toUnits(amount) * toUnits(percent), 100_000_000n) * PAISA);
+}
+
+// The VAT inside an amount that includes it: ৳1,150 at 15% holds ৳150 (1,150 × 15 ÷ 115), to the
+// paisa. The rate is a percent ("7.5"), never negative.
+export function includedTaxOf(amount: string, rate: string): string {
+  const rateUnits = toUnits(rate);
+  // amount (10^-4) × rate (10^-4) ÷ (100 + rate) (10^-4) = 10^-4 taka; ÷ 100 more for the paisa
+  return fromUnits(
+    divideRounded(toUnits(amount) * rateUnits, (HUNDRED_PERCENT + rateUnits) * PAISA) * PAISA,
+  );
+}
```

- **`requiredPriceSchema`.** A sales line always has a price. Step 12's `priceSchema` turns an empty box into
  `null` ("no fixed price"), which is right for a product but wrong for a line: a line without a price cannot be
  totalled. `৳0` still passes, because a free sample is a real line with a real price of zero.
- **Two `.refine` calls, not `.min(1)` and `.regex()`.** Zod 4 runs every check on a string, even after one has
  failed. With `.min(1).regex(MONEY)`, an empty box would get two errors, and the form would show the last one,
  "Enter an amount like 1250.50", instead of "Enter a price". The second refine lets the empty box pass, so each
  box gets exactly one error.
- **`isMoneyAmount()`.** The form works out a line's total while the person types. Before it calls the
  arithmetic, it must know the price box holds a whole amount, because `"12."` would make `toUnits()` throw.
  `MONEY` stays private; this function is the one way to use it from outside.
- **`percentOfMoney()`.** A percent discount and the VAT on a price without VAT are both "x% of an amount, to the
  paisa". Like `multiplyMoney()` from step 14, it multiplies the two exact numbers as `BigInt` and rounds once, at
  the end. The comment shows the units: both values are in ten-thousandths, so their product is in 10⁻⁸; dividing
  by 100 for the percent and keeping paisa means dividing by 10⁸.
- **`includedTaxOf()`.** A shop types ৳115 and means "with VAT". The VAT inside it is `115 × 15 ÷ 115 = ৳15`, not
  15% of ৳115 (that would be ৳17.25). The formula is `amount × rate ÷ (100 + rate)`. `HUNDRED_PERCENT` is 100 in
  the same ten-thousandths as the rate, so the two can be added.
- **Why not `decimal.js` here?** CLAUDE.md says to round money with `decimal.js`. But `packages/contracts` may only
  depend on Zod (the `contracts-only-zod` boundary from step 5), because the browser loads it too. Step 14 already
  solved this with exact `BigInt` arithmetic in this file, and these two functions follow it. The results are the
  same as `decimal.js` with `ROUND_HALF_UP`, because every value here is positive or rounds half away from zero.

### `sales.ts` (new): the line every sales document shares

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import {
  addMoney,
  compareMoney,
  includedTaxOf,
  isMoneyAmount,
  multiplyMoney,
  percentOfMoney,
  requiredPriceSchema,
  subtractMoney,
  sumMoney,
} from './money.js';
import { isQuantity, quantitySchema } from './quantities.js';
import { stockUnitSchema, variantRefSchema } from './stock.js';

// What quotations and orders (step 15b) and invoices (15c) share: a line with a product, a price,
// a discount and a VAT rate, and the arithmetic that turns it into amounts. The arithmetic lives
// here, not in the API, so the form shows the same total the server stores, to the paisa.

// The most lines one quotation or order holds. A distributor's order for a pharmacy runs to a few
// hundred items. A delivery may split a line over two batches, and MAX_STOCK_LINES (500) leaves
// room for that.
export const MAX_SALES_LINES = 300;

// A discount is a percent of the line (12.5%) or an amount off the whole line (৳250)
export const DISCOUNT_TYPES = ['percent', 'amount'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

// At most 2 decimals: the line is worked out to the paisa, so ৳10.555 off could not be shown.
// '' (an empty box) is no discount.
const DISCOUNT = /^\d{1,15}(?:\.\d{1,2})?$/;

const discountSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || DISCOUNT.test(value), errorCode('money_format'))
  .transform((value) => (value === '' ? '0' : value));

// ---------------------------------------------------------------------------------------------
// The arithmetic

// What a line is worth, each to the paisa:
//   gross     quantity × price, as typed
//   discount  what the discount takes off gross
//   net       before VAT, after the discount: what the sales account gets (15c)
//   vat       the VAT on the line: what the VAT account gets (15c)
//   total     what the customer pays for the line: net + vat
export interface LineAmounts {
  gross: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
}

export interface LineAmountInput {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
  // The VAT rate in percent: "15.00"
  rate: string;
}

// pricesIncludeVat: the document's copy of the workspace setting (step 15a). A shop's price of
// ৳115 at 15% holds ৳15 of VAT; a factory's price of ৳100 gets ৳15 added. The discount comes off
// the price as typed, before the VAT is worked out, so a 10% discount is 10% of what the customer
// sees in both cases.
export function lineAmounts(line: LineAmountInput, pricesIncludeVat: boolean): LineAmounts {
  const gross = multiplyMoney(line.quantity, line.unitPrice);
  const discount =
    line.discountType === 'percent'
      ? percentOfMoney(gross, line.discount)
      : sumMoney([line.discount]);
  const afterDiscount = subtractMoney(gross, discount);
  if (pricesIncludeVat) {
    const vat = includedTaxOf(afterDiscount, line.rate);
    return { gross, discount, net: subtractMoney(afterDiscount, vat), vat, total: afterDiscount };
  }
  const vat = percentOfMoney(afterDiscount, line.rate);
  return { gross, discount, net: afterDiscount, vat, total: addMoney(afterDiscount, vat) };
}

// The same, for a line that is still being typed: null until every box holds a complete value, so
// the form's totals never throw on "1." or an empty price
export function draftLineAmounts(
  line: { quantity: string; unitPrice: string; discountType: DiscountType; discount: string },
  rate: string | null,
  pricesIncludeVat: boolean,
): LineAmounts | null {
  const discount = line.discount.trim() === '' ? '0' : line.discount.trim();
  if (
    rate === null ||
    !isQuantity(line.quantity.trim()) ||
    !isMoneyAmount(line.unitPrice.trim()) ||
    !DISCOUNT.test(discount)
  ) {
    return null;
  }
  return lineAmounts(
    {
      quantity: line.quantity.trim(),
      unitPrice: line.unitPrice.trim(),
      discountType: line.discountType,
      discount,
      rate,
    },
    pricesIncludeVat,
  );
}

export interface DocumentTotals {
  discount: string;
  net: string;
  vat: string;
  total: string;
}

// A document's totals are the sums of its lines, each already rounded. Working the VAT out once on
// the whole document could differ by a paisa from the lines, and the lines are what is printed.
export function documentTotals(lines: readonly LineAmounts[]): DocumentTotals {
  return {
    discount: sumMoney(lines.map((line) => line.discount)),
    net: sumMoney(lines.map((line) => line.net)),
    vat: sumMoney(lines.map((line) => line.vat)),
    total: sumMoney(lines.map((line) => line.total)),
  };
}

// What a line says when the person typed no description: the product, and the variant's options
// ("Polo shirt — M, Navy blue"). The API writes it; the form shows it as the box's placeholder.
export function defaultLineDescription(variant: {
  productName: string;
  optionValues: readonly string[];
}): string {
  return variant.optionValues.length === 0
    ? variant.productName
    : `${variant.productName} — ${variant.optionValues.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// What a line sends

interface DiscountFields {
  quantity: string;
  unitPrice: string;
  discountType: DiscountType;
  discount: string;
}

// A discount never takes more than the line: not over 100%, not more taka than quantity × price.
// A negative line would be a return, and returns are their own document (15d).
export function salesLineRules<T extends DiscountFields>(line: T, ctx: z.RefinementCtx<T>): void {
  // The boxes are checked by their own schemas; with a bad one there is nothing to compare yet
  if (!isQuantity(line.quantity) || !isMoneyAmount(line.unitPrice)) return;
  const limit =
    line.discountType === 'percent' ? '100' : multiplyMoney(line.quantity, line.unitPrice);
  if (compareMoney(line.discount, limit) > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['discount'],
      message: errorCode('sales_discount_too_large'),
    });
  }
}

export const salesLineFieldsSchema = z.object({
  variantId: z.uuid(errorCode('stock_variant_required')),
  // The base unit or one of the product's packs; the quantity and the price are per this unit
  unitId: z.uuid(errorCode('stock_unit_invalid')),
  quantity: quantitySchema,
  // What the line says on the document. null = the product's name with its variant's options
  // ("Polo shirt — M, Navy blue"); a garments merchandiser types "220 GSM pique, buyer's label".
  description: optionalText(300),
  // Per one of the unit, as the workspace types prices (with or without VAT)
  unitPrice: requiredPriceSchema,
  discountType: z.enum(DISCOUNT_TYPES),
  discount: discountSchema,
  taxRateId: z.uuid(errorCode('tax_rate_invalid')),
});

export const salesLineInputSchema = salesLineFieldsSchema.superRefine(salesLineRules);
export type SalesLineInput = z.infer<typeof salesLineInputSchema>;
export type SalesLineFormValues = z.input<typeof salesLineInputSchema>;

// The fields every sales document has. The customer must be an active one when the document is
// written; an existing document keeps its customer even if the customer is archived later.
export const salesDocumentFieldsSchema = z.object({
  customerId: z.uuid(errorCode('sales_customer_required')),
  date: z.iso.date(errorCode('sales_date_required')),
  note: optionalText(500),
  lines: z
    .array(salesLineInputSchema)
    .min(1, errorCode('sales_lines_required'))
    .max(MAX_SALES_LINES),
});

// ---------------------------------------------------------------------------------------------
// What the API sends

// The VAT rate a line used, copied onto the line when it was saved (a snapshot). When the NBR
// changes a rate, only new documents get the new one.
export const taxRateRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
  rate: z.string(),
});
export type TaxRateRef = z.infer<typeof taxRateRefSchema>;

// Another document this one came from or led to. number is null while that one is a draft.
export const documentRefSchema = z.object({ id: z.uuid(), number: z.string().nullable() });
export type DocumentRef = z.infer<typeof documentRefSchema>;

// A line as the API sends it: the variant now (its name, packs and tracking, for the form), and
// what the line itself keeps (its description, price, discount and VAT rate as they were saved)
export const salesLineSchema = variantRefSchema.extend({
  id: z.uuid(),
  // 'goods' or 'service' (products.ts → PRODUCT_TYPES). A service line (a delivery charge, an
  // embroidery charge) is sold but never delivered: the order page and the delivery form skip it.
  // z.string(), like the product's own type: a newer server's new type must not break an older
  // offline client.
  productType: z.string(),
  tracking: z.string(),
  hasExpiry: z.boolean(),
  units: z.array(stockUnitSchema),
  unitId: z.uuid(),
  quantity: z.string(),
  // The quantity in the base unit: what a delivery counts against
  baseQuantity: z.string(),
  description: z.string(),
  unitPrice: z.string(),
  discountType: z.enum(DISCOUNT_TYPES),
  discount: z.string(),
  taxRate: taxRateRefSchema,
  // lineAmounts() at the time it was saved
  net: z.string(),
  vat: z.string(),
  total: z.string(),
});
export type SalesLine = z.infer<typeof salesLineSchema>;

// ---------------------------------------------------------------------------------------------
// The price a line starts with

// price_list: the customer's price list has this variant in this unit. product: the variant's own
// sale price (per base unit) × the unit's factor.
export const PRICE_SOURCES = ['price_list', 'product'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const priceLookupInputSchema = z.object({
  // null = no customer chosen yet: the products' own prices
  customerId: z.uuid().nullable(),
  items: z
    .array(z.object({ variantId: z.uuid(), unitId: z.uuid() }))
    .min(1)
    .max(MAX_SALES_LINES),
});
export type PriceLookupInput = z.infer<typeof priceLookupInputSchema>;

export const priceLookupItemSchema = z.object({
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of the unit. null = no price anywhere: the person types it (a garments buyer's PO is
  // priced by hand)
  price: z.string().nullable(),
  source: z.enum(PRICE_SOURCES).nullable(),
  // The product's own active rate, or the workspace's default
  taxRateId: z.uuid(),
});
export type PriceLookupItem = z.infer<typeof priceLookupItemSchema>;

export const priceLookupSchema = z.object({
  // The workspace setting now: a new document copies it
  pricesIncludeVat: z.boolean(),
  // An item that is not a variant and unit of this workspace is left out
  items: z.array(priceLookupItemSchema),
});
export type PriceLookup = z.infer<typeof priceLookupSchema>;

// Reading prices needs no permission, like the price lists. POST, not GET: a form asks for up to
// 300 items at once, and that does not fit a URL.
export const salesPriceRoutes = {
  lookup: defineRoute({
    method: 'POST',
    path: '/sales/price-lookup',
    summary: 'The price and VAT rate new sales lines start with, for one customer',
    auth: 'bearer',
    status: 200,
    body: priceLookupInputSchema,
    response: priceLookupSchema,
  }),
};
```

- **The arithmetic lives in the contract.** The order form shows a total while the person types, and the server
  stores a total when it saves. If each side had its own code, one day they would differ by a paisa, and the
  person would see ৳3,727.55 on the screen and ৳3,727.56 on the order. With one function in the contract, both
  sides run the same code.
- **`MAX_SALES_LINES = 300`.** A distributor's order for a pharmacy can have a few hundred items. A delivery may
  split one order line over two batches, so a delivery for a full order can have more lines than the order. Step
  13's `MAX_STOCK_LINES` is 500, which leaves room for that split.
- **`DISCOUNT = ... \d{1,2}`.** A discount has at most 2 decimals. The line is kept to the paisa, so a discount of
  ৳10.555 could never be shown as it was typed. For a percent, 2 decimals (12.25%) is more than any price list
  uses.
- **`discountSchema` turns `''` into `'0'`.** An empty discount box means "no discount". We store `0`, not `NULL`,
  because there is only one kind of "no discount" (unlike a missing price, which is different from a price of 0).
- **`lineAmounts()`, the order of the steps.** First `gross = quantity × price`, rounded to the paisa. Then the
  discount comes off the price as typed. Only then is the VAT worked out. So a 10% discount is 10% of what the
  customer sees, whether the price includes VAT or not. If the VAT came first, a shop's "10% off ৳115" would not
  be ৳103.50.
- **The two VAT branches.** Without VAT in the price, `net` is the amount after the discount, and the VAT is added
  on top. With VAT in the price, `total` is the amount after the discount, and the VAT is taken out of it with
  `includedTaxOf()`; `net` is what is left. In both cases `net + vat = total` exactly, because the third value is
  always worked out from the other two by addition or subtraction, never rounded on its own.
- **`sumMoney([line.discount])` for an amount discount.** It writes the typed `"250"` as `"250.0000"`, like every
  other amount, so the response compares as a plain string.
- **`draftLineAmounts()`.** The form calls this on every key press. While a box holds `"1."` or nothing, it
  returns `null` and the line shows a dash, instead of throwing inside `toUnits()`. It also trims, because the
  form's values are not yet trimmed by Zod.
- **`documentTotals()` adds the rounded lines.** The VAT of each line is rounded on its own, and the document's
  VAT is their sum. Working out 15% of the whole document instead could give a different paisa (the test shows
  ৳0.04 against ৳0.03), and the total on the order would then not be the sum of its printed lines. The VAT invoice
  (Mushak 6.3, later) also shows the VAT per line.
- **`salesLineRules()`: a discount never takes more than the line.** Over 100%, or more taka than
  `quantity × price`, would make the line negative. A negative line is a return, and returns get their own
  document in 15d. The first `if` skips the check while the quantity or the price is still wrong: those boxes have
  their own errors, and there is nothing to compare yet.
- **`description: optionalText(300)`.** `null` means "use the product's name with its options" ("Polo shirt — M,
  Navy blue"). A garments merchandiser often needs more on a quotation ("220 GSM pique, buyer's own label"), so the
  line can say it. The server stores the final text on the line (a snapshot), so a renamed product does not change
  an old order.
- **`taxRateId` in, `taxRate` out.** The form sends only the rate's id. The server copies the rate's name, kind and
  percent onto the line (decision 5 of 15a). `taxRateRefSchema` is that copy. When the NBR changes a rate, old
  orders keep the old one.
- **`salesDocumentFieldsSchema`.** The fields all three sales documents with prices share (a quotation, an order,
  and from 15c an invoice): the customer, the date, a note and the lines. Each document extends it with its own
  fields.
- **`documentRefSchema` with a nullable `number`.** An order made from a quotation is a draft at first, and a draft
  has no number yet. The quotation's page still links to it.
- **`salesLineSchema` sends the variant as it is now, and the line as it was saved.** The product's name, packs and
  tracking come from today's product, because the form needs them to edit the line again (which units can I pick?
  is it batch-tracked?). The price, discount, VAT rate and description come from the line itself.
- **`productType` on the line** (added while building the screens in 15b.6). A service line (a delivery charge,
  an embroidery charge) is sold but never delivered. The order's page shows "A service: not delivered" on it,
  and the delivery form's "Add what is left on the order" skips it. Without the type on the line, the app would
  have to load every product to find out. It is `z.string()`, like the product's own `type`: a newer server's new
  type must not break an older offline client.
- **`defaultLineDescription()`** is the text a line gets when the person types no description ("Polo shirt — M,
  Navy blue"). It lives in the contract (moved here from the API in 15b.6) because two sides need the same
  text: the API writes it, and the form shows it as the description box's placeholder and leaves the box empty
  when a saved line says just that.
- **The price lookup, `POST /sales/price-lookup`.** It answers "what price does this customer pay for this variant
  in this unit, and which VAT rate does the line start with". `source` tells the form where the price came from,
  so it can say "Dealer price list" under the box. `price: null` means no price anywhere: the person types it. It
  is a `POST` because a form asks for up to 300 items at once, and 300 ids do not fit in a URL. It changes nothing,
  so it needs no permission, like reading a price list.
- **`pricesIncludeVat` in the lookup's answer.** A new document copies the workspace setting when it is created.
  The form needs it before saving to show the right totals, and this is the request it makes anyway.

### `quotations.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema, salesDocumentFieldsSchema, salesLineSchema } from './sales.js';
import { optionalDateSchema } from './stock.js';

// A quotation is an offer: these items at these prices, valid until a date. It moves no stock and
// posts nothing, so it is numbered as soon as it is saved (QT-2026-27-0001): the customer quotes
// that number back. It stays open (and can be changed) until the customer answers: an order made
// from it accepts it, "Declined" closes it. An open quotation past its date shows as expired; no
// job changes it, so it can still be accepted if the customer agrees late.
export const QUOTATION_STATUSES = ['open', 'accepted', 'declined'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const quotationSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  // null = no end date
  validUntil: z.iso.date().nullable(),
  customer: partyRefSchema,
  status: z.enum(QUOTATION_STATUSES),
  // The sums of the lines (sales.ts → documentTotals)
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type QuotationSummary = z.infer<typeof quotationSummarySchema>;

export const quotationSchema = quotationSummarySchema.extend({
  // The workspace setting when it was written: the lines' prices are read this way for good
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  note: z.string().nullable(),
  lines: z.array(salesLineSchema),
  // The order made from it, once accepted
  order: documentRefSchema.nullable(),
});
export type Quotation = z.infer<typeof quotationSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const quotationFieldsSchema = salesDocumentFieldsSchema.extend({
  validUntil: optionalDateSchema,
});

type QuotationRuleInput = z.output<typeof quotationFieldsSchema>;

function quotationRules(input: QuotationRuleInput, ctx: z.RefinementCtx<QuotationRuleInput>) {
  // ISO dates compare as strings
  if (input.validUntil !== null && input.validUntil < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['validUntil'],
      message: errorCode('quotation_valid_until'),
    });
  }
}

export const quotationInputSchema = quotationFieldsSchema.superRefine(quotationRules);
export type QuotationInput = z.infer<typeof quotationInputSchema>;

export const updateQuotationInputSchema = quotationFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(quotationRules);
export type UpdateQuotationInput = z.infer<typeof updateQuotationInputSchema>;
export type QuotationFormValues = z.input<typeof updateQuotationInputSchema>;

export const quotationVersionInputSchema = z.object({ version: versionSchema });

export const deleteQuotationQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const quotationListQuerySchema = pageQuerySchema.extend({
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type QuotationListQuery = z.input<typeof quotationListQuerySchema>;

export const quotationPageSchema = pageOf(quotationSummarySchema);
export type QuotationPage = z.infer<typeof quotationPageSchema>;

const quotationParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like the stock documents: a store keeper may look up what was
// offered. Writing needs sales.quotation.manage.
export const quotationRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/quotations',
    summary: 'Quotations, newest date first',
    auth: 'bearer',
    status: 200,
    query: quotationListQuerySchema,
    response: quotationPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/quotations/:id',
    summary: 'One quotation with its lines',
    auth: 'bearer',
    status: 200,
    params: quotationParamsSchema,
    response: quotationSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/quotations',
    summary: 'Write a quotation; it gets its number at once',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 201,
    body: quotationInputSchema,
    response: quotationSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/quotations/:id',
    summary: 'Change an open quotation',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: updateQuotationInputSchema,
    response: quotationSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/quotations/:id',
    summary: 'Delete an open quotation',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 204,
    params: quotationParamsSchema,
    query: deleteQuotationQuerySchema,
    response: z.void(),
  }),
  decline: defineRoute({
    method: 'POST',
    path: '/quotations/:id/decline',
    summary: 'Mark an open quotation as declined by the customer',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: quotationVersionInputSchema,
    response: quotationSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/quotations/:id/reopen',
    summary: 'Open a declined quotation again',
    auth: 'bearer',
    permission: 'sales.quotation.manage',
    status: 200,
    params: quotationParamsSchema,
    body: quotationVersionInputSchema,
    response: quotationSchema,
  }),
};
```

- **Numbered when saved, with no draft.** A quotation moves no stock and posts nothing, so a gap in its numbers
  harms nobody. The customer quotes the number back ("about your QT-2026-27-0014…"), so it needs one from the
  first save. Orders and deliveries are different: they get their numbers when confirmed or posted, like journal
  entries and stock documents, so the numbers of real documents have no gaps.
- **Three statuses.** `open` until the customer answers. `accepted` when an order is made from it. `declined` when
  the person marks it so.
- **No `expired` status.** "Expired" is just "open, and `validUntil` is before today". The app works it out when it
  shows the list. A nightly job that changed the status would add a moving part, and a customer who agrees a day
  late could not be served without reopening the quotation first.
- **`validUntil` must not be before `date`.** ISO dates (`2026-10-07`) sort the same way as strings, so `<` is
  enough. `optionalDateSchema` is step 13's: `''` from the form becomes `null` ("no end date").
- **`decline` and `reopen`.** A declined quotation can be opened again when the customer comes back. An accepted
  one cannot: it belongs to its order.
- **Reading needs no permission.** The same rule as the stock documents. A store keeper or an accountant may need
  to look up what was offered. Writing needs `sales.quotation.manage`.

### `sales-orders.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema, salesDocumentFieldsSchema, salesLineSchema } from './sales.js';
import { optionalDateSchema, optionalIdSchema } from './stock.js';

// A sales order is what the customer agreed to buy. A draft can be changed; "Confirm" gives it its
// number (SO-2026-27-0001) and from then on deliveries take goods against it. Nothing is held in
// the warehouse for it (you chose this): the stock page shows what confirmed orders still have to
// deliver, next to what is on hand.
//   draft      being written; no number
//   confirmed  waiting for deliveries, or partly delivered
//   delivered  every goods line delivered in full (set by the delivery that finished it)
//   closed     partly delivered, and the rest will not be: the customer took what was there
//   cancelled  confirmed, then called off before anything was delivered
// A confirmed order with no delivery at all (not even a draft one) can go back to draft to be
// changed; it keeps its number. A partly delivered order is not changed: close it and write a new
// one for the rest.
export const ORDER_STATUSES = ['draft', 'confirmed', 'delivered', 'closed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// ---------------------------------------------------------------------------------------------
// What the API sends

export const salesOrderSummarySchema = z.object({
  id: z.uuid(),
  // null while a draft
  number: z.string().nullable(),
  date: z.iso.date(),
  // When the customer expects the goods; null = not agreed
  deliveryDate: z.iso.date().nullable(),
  customer: partyRefSchema,
  // The customer's own number for this order: a buyer's PO number, a pharmacy's indent number
  customerReference: z.string().nullable(),
  // Where the goods are sent from, by default; a delivery may take them from another warehouse
  warehouseId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  // Confirmed, and some (not all) of it delivered
  partlyDelivered: z.boolean(),
  net: z.string(),
  vat: z.string(),
  total: z.string(),
  lineCount: z.number().int(),
  confirmedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type SalesOrderSummary = z.infer<typeof salesOrderSummarySchema>;

export const salesOrderLineSchema = salesLineSchema.extend({
  // In the base unit, by posted deliveries. A service line stays at zero: it is never delivered.
  deliveredQuantity: z.string(),
});
export type SalesOrderLine = z.infer<typeof salesOrderLineSchema>;

// A delivery made against the order, as its page lists them
export const orderDeliverySchema = z.object({
  id: z.uuid(),
  number: z.string().nullable(),
  date: z.iso.date(),
  // z.string(): a delivery's status (deliveries.ts)
  status: z.string(),
});
export type OrderDelivery = z.infer<typeof orderDeliverySchema>;

export const salesOrderSchema = salesOrderSummarySchema.extend({
  pricesIncludeVat: z.boolean(),
  discount: z.string(),
  // The address the goods go to: its id (to pick it again in the form) and its text as it was when
  // the order was saved, so a later change to the customer's addresses does not rewrite the order
  shippingAddressId: z.uuid().nullable(),
  shippingAddress: z.string().nullable(),
  note: z.string().nullable(),
  lines: z.array(salesOrderLineSchema),
  quotation: documentRefSchema.nullable(),
  deliveries: z.array(orderDeliverySchema),
});
export type SalesOrder = z.infer<typeof salesOrderSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const salesOrderFieldsSchema = salesDocumentFieldsSchema.extend({
  customerReference: optionalText(60),
  deliveryDate: optionalDateSchema,
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  // An address of this customer; '' = none
  shippingAddressId: optionalIdSchema,
  // true = "Confirm": save and confirm in one step, or nothing at all
  confirm: z.boolean(),
});

type OrderRuleInput = z.output<typeof salesOrderFieldsSchema>;

function orderRules(input: OrderRuleInput, ctx: z.RefinementCtx<OrderRuleInput>) {
  if (input.deliveryDate !== null && input.deliveryDate < input.date) {
    ctx.addIssue({
      code: 'custom',
      path: ['deliveryDate'],
      message: errorCode('order_delivery_date'),
    });
  }
}

// quotationId: the quotation the order is made from ("Make order" on the quotation's page). Saving
// the order accepts the quotation. Left out by a form that starts from nothing.
export const salesOrderInputSchema = salesOrderFieldsSchema
  .extend({ quotationId: z.uuid().nullable().default(null) })
  .superRefine(orderRules);
export type SalesOrderInput = z.infer<typeof salesOrderInputSchema>;

// An order keeps the quotation it was made from: the edit form does not send it
export const updateSalesOrderInputSchema = salesOrderFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(orderRules);
export type UpdateSalesOrderInput = z.infer<typeof updateSalesOrderInputSchema>;
export type SalesOrderFormValues = z.input<typeof updateSalesOrderInputSchema>;

export const salesOrderVersionInputSchema = z.object({ version: versionSchema });

export const deleteSalesOrderQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const salesOrderListQuerySchema = pageQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  customerId: z.uuid().optional(),
});
export type SalesOrderListQuery = z.input<typeof salesOrderListQuerySchema>;

export const salesOrderPageSchema = pageOf(salesOrderSummarySchema);
export type SalesOrderPage = z.infer<typeof salesOrderPageSchema>;

const salesOrderParamsSchema = z.object({ id: z.uuid() });

export const salesOrderRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/sales-orders',
    summary: 'Sales orders, newest date first',
    auth: 'bearer',
    status: 200,
    query: salesOrderListQuerySchema,
    response: salesOrderPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/sales-orders/:id',
    summary: 'One sales order with its lines and deliveries',
    auth: 'bearer',
    status: 200,
    params: salesOrderParamsSchema,
    response: salesOrderSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/sales-orders',
    summary: 'Write a sales order as a draft, or write and confirm it in one step',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 201,
    body: salesOrderInputSchema,
    response: salesOrderSchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/sales-orders/:id',
    summary: 'Change a draft order, and optionally confirm it',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: updateSalesOrderInputSchema,
    response: salesOrderSchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/sales-orders/:id',
    summary: 'Delete a draft order',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 204,
    params: salesOrderParamsSchema,
    query: deleteSalesOrderQuerySchema,
    response: z.void(),
  }),
  confirm: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/confirm',
    summary: 'Confirm a draft order: it gets its number and can be delivered',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  reopen: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/reopen',
    summary: 'Take a confirmed order without deliveries back to draft, to change it',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  close: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/close',
    summary: 'Stop delivering a partly delivered order',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/sales-orders/:id/cancel',
    summary: 'Call off a confirmed order that has delivered nothing',
    auth: 'bearer',
    permission: 'sales.order.manage',
    status: 200,
    params: salesOrderParamsSchema,
    body: salesOrderVersionInputSchema,
    response: salesOrderSchema,
  }),
};
```

- **Five statuses.** The comment at the top lists them. `delivered` is never set by hand: the delivery that
  delivers the last goods sets it (15b.3). `closed` and `cancelled` are both "stop", but they mean different
  things in a report: a closed order delivered something, a cancelled one delivered nothing.
- **Only a draft is changed.** A confirmed order with no delivery at all can go back to draft (`reopen`), be
  changed and be confirmed again. It keeps its number. "No delivery at all" includes draft deliveries, because a
  draft delivery's lines point at the order's lines, and changing the order would leave them pointing at nothing.
  A partly delivered order is not changed: you close it and write a new order for the rest. Changing an order that
  has already been half delivered (what if a delivered line is removed?) is a whole feature of its own, and most
  companies do not need it.
- **`partlyDelivered`.** The list shows a "Partly delivered" pill without loading the lines. It is only true while
  the order is `confirmed`.
- **`customerReference`.** The customer's own number for the order: a buyer's PO number in garments, an indent
  number at a pharmacy. People search for it and print it, so it is its own field and not part of the note.
- **`warehouseId` on the order.** Where the goods are sent from, by default. The delivery form starts with it, but a
  delivery may take the goods from another warehouse (the depot ran out, the factory sends them).
- **`shippingAddressId` in, `shippingAddress` out.** The form picks one of the customer's addresses (15a gave
  them ids for this). The server also copies the address text onto the order, so a later change to the customer's
  addresses does not rewrite where an old order went.
- **`deliveredQuantity` on the order line, in the base unit.** The order may say 10 cartons and the delivery 120
  pieces; both are counted in pieces. A service line (installation, transport) is never delivered, so it stays at
  zero and does not count when the server decides whether the order is fully delivered.
- **`deliveries` on the order.** The order's page lists its deliveries with their status, so the person sees what
  went out and what is still a draft.
- **`quotationId` only in the create schema, `.default(null)`.** "Make order" on a quotation opens the order form
  filled with the quotation's lines and sends its id. Saving the order accepts the quotation. A form that starts
  from nothing does not have to send the field. The update schema leaves it out: an order keeps the quotation it
  came from.
- **`confirm: z.boolean()`.** The same pattern as `post` on stock documents: "Confirm" on the form saves and
  confirms in one request, or does nothing at all. A separate `confirm` route exists for a draft that was saved
  earlier.

### `deliveries.ts` (new)

```ts
import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema, partyRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { documentRefSchema } from './sales.js';
import { STOCK_DOCUMENT_STATUSES } from './stock-adjustments.js';
import {
  documentSerialRules,
  MAX_STOCK_LINES,
  optionalIdSchema,
  stockLineFieldsSchema,
  stockLineRules,
  stockLineSchema,
} from './stock.js';

// A delivery (the delivery challan that goes with the truck) takes goods out of a warehouse for a
// customer. Like a stock adjustment: a draft can be changed, "Post" gives it its number
// (DC-2026-27-0001), takes the stock out and books what it cost (you chose this: cost of goods
// sold at delivery, at the moving average cost of step 14). A posted delivery is not changed;
// what comes back is a return (15d).
//
// It is made from a confirmed order (its lines point at the order's lines, and an order is
// delivered in as many deliveries as it takes), or on its own, for a customer who collects goods
// without an order. Its lines carry no prices: the invoice (15c) prices them.

// ---------------------------------------------------------------------------------------------
// What the API sends

export const deliverySummarySchema = z.object({
  id: z.uuid(),
  // null while a draft: given when it is posted, so posted numbers have no gaps
  number: z.string().nullable(),
  date: z.iso.date(),
  customer: partyRefSchema,
  order: documentRefSchema.nullable(),
  warehouseId: z.uuid(),
  status: z.enum(STOCK_DOCUMENT_STATUSES),
  // The address it went to, as it was written on the challan
  shippingAddress: z.string().nullable(),
  // The truck or van and its driver: "Dhaka Metro-Ta 11-2233, Rahim"
  vehicle: z.string().nullable(),
  note: z.string().nullable(),
  lineCount: z.number().int(),
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;

export const deliveryLineSchema = stockLineSchema.extend({
  // The order line this line delivers (null on a delivery without an order). Two lines may point
  // at the same order line: one batch ran out and the rest came from the next.
  orderLineId: z.uuid().nullable(),
  // What the goods cost, once posted (step 14); null for a draft, and without inventory.stock.value
  value: z.string().nullable(),
});
export type DeliveryLine = z.infer<typeof deliveryLineSchema>;

export const deliverySchema = deliverySummarySchema.extend({
  shippingAddressId: z.uuid().nullable(),
  lines: z.array(deliveryLineSchema),
  // The cost of goods sold entry; null for a draft, or when the goods cost nothing in the books
  entry: entryRefSchema.nullable(),
});
export type Delivery = z.infer<typeof deliverySchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

const deliveryLineInputSchema = stockLineFieldsSchema
  .extend({ orderLineId: optionalIdSchema })
  .superRefine(stockLineRules);

const deliveryFieldsSchema = z.object({
  customerId: z.uuid(errorCode('sales_customer_required')),
  // '' = a delivery without an order
  orderId: optionalIdSchema,
  date: z.iso.date(errorCode('stock_date_required')),
  warehouseId: z.uuid(errorCode('stock_warehouse_invalid')),
  shippingAddressId: optionalIdSchema,
  vehicle: optionalText(80),
  note: optionalText(300),
  lines: z
    .array(deliveryLineInputSchema)
    .min(1, errorCode('stock_lines_required'))
    .max(MAX_STOCK_LINES),
  // true = "Post": save and post in one step, or nothing at all
  post: z.boolean(),
});

type DeliveryRuleInput = z.output<typeof deliveryFieldsSchema>;

function deliveryRules(input: DeliveryRuleInput, ctx: z.RefinementCtx<DeliveryRuleInput>) {
  // A delivery from an order delivers the order's lines, and nothing else: an extra item would be
  // a sale nobody ordered. One without an order has no order lines to point at.
  input.lines.forEach((line, index) => {
    if (input.orderId !== null && line.orderLineId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'orderLineId'],
        message: errorCode('delivery_order_line_required'),
      });
    }
    if (input.orderId === null && line.orderLineId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['lines', index, 'orderLineId'],
        message: errorCode('delivery_order_line_invalid'),
      });
    }
  });
  documentSerialRules(input, ctx);
}

export const deliveryInputSchema = deliveryFieldsSchema.superRefine(deliveryRules);
export type DeliveryInput = z.infer<typeof deliveryInputSchema>;

export const updateDeliveryInputSchema = deliveryFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(deliveryRules);
export type UpdateDeliveryInput = z.infer<typeof updateDeliveryInputSchema>;
export type DeliveryFormValues = z.input<typeof updateDeliveryInputSchema>;

export const deliveryVersionInputSchema = z.object({ version: versionSchema });

export const deleteDeliveryQuerySchema = z.object({
  version: z.coerce.number<number>().int().min(1),
});

export const deliveryListQuerySchema = pageQuerySchema.extend({
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  customerId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
});
export type DeliveryListQuery = z.input<typeof deliveryListQuerySchema>;

export const deliveryPageSchema = pageOf(deliverySummarySchema);
export type DeliveryPage = z.infer<typeof deliveryPageSchema>;

const deliveryParamsSchema = z.object({ id: z.uuid() });

// Reading needs no permission, like every stock document. Writing and posting need
// sales.delivery.manage: the store keeper who loads the truck.
export const deliveryRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/deliveries',
    summary: 'Deliveries, newest date first',
    auth: 'bearer',
    status: 200,
    query: deliveryListQuerySchema,
    response: deliveryPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/deliveries/:id',
    summary: 'One delivery with its lines',
    auth: 'bearer',
    status: 200,
    params: deliveryParamsSchema,
    response: deliverySchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/deliveries',
    summary: 'Write a delivery as a draft, or write and post it in one step',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 201,
    body: deliveryInputSchema,
    response: deliverySchema,
  }),
  update: defineRoute({
    method: 'PUT',
    path: '/deliveries/:id',
    summary: 'Change a draft delivery, and optionally post it',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 200,
    params: deliveryParamsSchema,
    body: updateDeliveryInputSchema,
    response: deliverySchema,
  }),
  remove: defineRoute({
    method: 'DELETE',
    path: '/deliveries/:id',
    summary: 'Delete a draft delivery',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 204,
    params: deliveryParamsSchema,
    query: deleteDeliveryQuerySchema,
    response: z.void(),
  }),
  post: defineRoute({
    method: 'POST',
    path: '/deliveries/:id/post',
    summary: 'Post a draft delivery: it gets its number, takes the stock out and books its cost',
    auth: 'bearer',
    permission: 'sales.delivery.manage',
    status: 200,
    params: deliveryParamsSchema,
    body: deliveryVersionInputSchema,
    response: deliverySchema,
  }),
};
```

- **A stock document like an adjustment.** It reuses `STOCK_DOCUMENT_STATUSES` (`draft`, `posted`), step 13's line
  fields (variant, unit, quantity, batch, serial numbers), and its rules (`stockLineRules`, `documentSerialRules`).
  The batch and serial rules of step 13 apply to deliveries without new code.
- **One step, not two (you chose this).** `post` takes the stock out and books what it cost in one transaction.
  There is no "packed" step in between, because nothing is reserved (decision 2).
- **No prices on the lines.** A delivery challan says what was delivered, not what it costs the customer. The
  invoice (15c) prices it from the order or the price list. So a delivery has no VAT and no totals.
- **`orderLineId` on each line, and the rule in `deliveryRules()`.** A delivery from an order may only deliver that
  order's lines. Without this rule, a store keeper could add an item nobody ordered, and the invoice would have
  nothing to price it from. A delivery without an order (a customer who collects goods at the depot) has no order
  lines. The rule checks both directions, and puts the error on the line to fix.
- **Two lines may point at the same order line.** Batch `B-2310` had 40 strips and the order wanted 60, so the
  other 20 come from batch `B-2402`. That is two delivery lines for one order line. The server adds them up when it
  checks the order's remaining quantity (15b.3).
- **`vehicle`.** The truck's number and the driver. In Bangladesh a challan travels with the goods and the vehicle
  number is written on it. One text box is enough; a vehicles register can come later.
- **`value` on the line, `entry` on the delivery.** What the goods cost at the moving average, and the cost of goods
  sold entry. Both are `null` for someone without `inventory.stock.value`, like on a stock adjustment (step 14).
- **`sales.delivery.manage`.** The person who loads the truck is often not the person who takes orders, so
  delivering has its own permission.

### `stock.ts`: a delivery is a stock movement, and what is on order

```diff
@@ -10,7 +10,14 @@ import { levelSchema, quantitySchema } from './quantities.js';
 // journal source: a newer server's new kind (a sales delivery, step 15) must not break an older
 // offline client.
 // revaluation (step 14): a change of value without a change of quantity — its quantity is zero.
-export const MOVEMENT_KINDS = ['adjustment', 'transfer_out', 'transfer_in', 'revaluation'] as const;
+// delivery (step 15b): goods leaving for a customer on a delivery challan.
+export const MOVEMENT_KINDS = [
+  'adjustment',
+  'transfer_out',
+  'transfer_in',
+  'revaluation',
+  'delivery',
+] as const;
 export type MovementKind = (typeof MOVEMENT_KINDS)[number];
 
 export function isMovementKind(value: string): value is MovementKind {
@@ -32,13 +39,13 @@ export const serialNumberSchema = z
   .trim()
   .regex(/^[\x21-\x7E]{1,64}$/, errorCode('serial_number_format'));
 
-// The form's "not chosen" is ''
-const optionalIdSchema = z
+// The form's "not chosen" is '' (the sales documents of step 15b use these two as well)
+export const optionalIdSchema = z
   .union([z.uuid(), z.literal('')])
   .transform((value) => (value === '' ? null : value))
   .nullable();
 
-const optionalDateSchema = z
+export const optionalDateSchema = z
   .union([z.iso.date(), z.literal('')])
   .transform((value) => (value === '' ? null : value))
   .nullable();
@@ -142,6 +149,10 @@ export const stockItemSchema = variantRefSchema.extend({
   onHand: z.string(),
   // Sent from another warehouse and not received yet (to the chosen warehouse, or anywhere)
   inTransit: z.string(),
+  // Promised and not delivered yet (step 15b): what confirmed sales orders still have to deliver
+  // from the chosen warehouse (or from any). Nothing is held for them; it is shown next to onHand,
+  // so a salesperson sees what is already promised.
+  onOrder: z.string(),
   // At or below its reorder level in the chosen warehouse (or in any warehouse)
   low: z.boolean(),
   // Step 14, only for someone with inventory.stock.value (null for everyone else, and for a
```

- **`'delivery'` in `MOVEMENT_KINDS`.** The stock card's history shows each movement with the document that made
  it. A delivery's movements say "Delivery DC-2026-27-0003". The response sends the kind as `z.string()`, so an
  older offline app that does not know `'delivery'` still reads the page.
- **`optionalIdSchema` and `optionalDateSchema` are exported.** The sales documents need the same "the form's empty
  select is `''`" rule. Exporting the two from here is better than writing a third copy (`customers.ts` already
  has one; it stays, as moving it is not part of this step).
- **`onOrder` on a stock item (decision 2).** What confirmed orders still have to deliver from this warehouse (or
  from all of them): the ordered quantity minus what was delivered, in the base unit. Nothing is held for those
  orders, so it is only information: the stock page shows "On order" next to "On hand", and a salesperson sees
  that the 200 cartons on hand are already promised. It is a new required field, so the API's stock service
  (15b.3) and the app's mock (15b.7) must send it.

### `journal.ts`: a new source

```diff
@@ -19,6 +19,8 @@ export type JournalStatus = (typeof JOURNAL_STATUSES)[number];
 // stock_adjustment, stock_transfer, stock_revaluation (step 14): the entry a stock document makes
 // when it is posted. It points back at its document (document), and only another stock document
 // can change it — the journal's Reverse refuses it, or the books and the stock would disagree.
+// sales_delivery (step 15b): a delivery challan's cost of goods sold. A stock document like the
+// others: it moves stock and its value together.
 export const JOURNAL_SOURCES = [
   'manual',
   'opening_balance',
@@ -27,6 +29,7 @@ export const JOURNAL_SOURCES = [
   'stock_adjustment',
   'stock_transfer',
   'stock_revaluation',
+  'sales_delivery',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -39,6 +42,7 @@ export const STOCK_JOURNAL_SOURCES = [
   'stock_adjustment',
   'stock_transfer',
   'stock_revaluation',
+  'sales_delivery',
 ] as const satisfies readonly JournalSource[];
 export type StockJournalSource = (typeof STOCK_JOURNAL_SOURCES)[number];
 
```

- **`'sales_delivery'` in both lists.** A delivery's cost of goods sold entry is a stock document's entry: it is
  made when the delivery is posted, and it must agree with the stock that left. So it is also in
  `STOCK_JOURNAL_SOURCES`, and the journal's "Reverse" refuses it (step 14's `journal_is_stock`), like it refuses
  an adjustment's entry. Undoing a delivery is a return (15d), which moves the stock and its value back together.

### `numbering.ts`, `permissions.ts`, `errors.ts`, `audit.ts`

```diff
@@ -17,6 +17,8 @@ export const DOCUMENT_TYPES = [
   'inventory.transfer',
   'inventory.revaluation',
   'sales.customer',
+  'sales.quotation',
+  'sales.delivery',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -42,6 +44,9 @@ const DEFAULT_PREFIXES = {
   'inventory.transfer': 'TRF',
   'inventory.revaluation': 'REV',
   'sales.customer': 'C',
+  'sales.quotation': 'QT',
+  // A delivery challan
+  'sales.delivery': 'DC',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
```

- **`sales.quotation` (QT) and `sales.delivery` (DC).** `sales.order` (SO) has been in the list since step 6. Both
  new series use the default yearly style (`QT-2026-27-0001`), because they are documents of a year, unlike the
  customer codes of 15a. "DC" is short for delivery challan, the word people use for it in Bangladesh.

```diff
@@ -24,6 +24,9 @@ export const PERMISSION_KEYS = [
   'sales.customer.manage',
   'sales.customer.balance',
   'sales.price_list.manage',
+  'sales.quotation.manage',
+  'sales.order.manage',
+  'sales.delivery.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -62,4 +65,7 @@ export const PERMISSION_GROUP_OF = {
   'sales.customer.manage': 'sales',
   'sales.customer.balance': 'sales',
   'sales.price_list.manage': 'sales',
+  'sales.quotation.manage': 'sales',
+  'sales.order.manage': 'sales',
+  'sales.delivery.manage': 'sales',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

- **Three permissions, one per document.** In a distribution company, the sales officer writes quotations and
  orders, the sales manager may only confirm, and the depot's store keeper delivers. With three keys, an owner can
  give each person exactly their part. All three are in the `sales` group of the roles matrix.

```diff
@@ -247,6 +247,30 @@ export const ERROR_CODES = [
   'journal_party_not_allowed',
   'journal_party_invalid',
   'opening_balance_twice',
+  // quotations, orders and deliveries (step 15b)
+  'sales_customer_required',
+  'sales_customer_invalid',
+  'sales_date_required',
+  'sales_lines_required',
+  'sales_price_required',
+  'sales_discount_too_large',
+  'sales_address_invalid',
+  'sales_not_draft',
+  'sales_item_invalid',
+  'quotation_valid_until',
+  'quotation_not_open',
+  'quotation_not_declined',
+  'order_delivery_date',
+  'order_not_confirmed',
+  'order_has_deliveries',
+  'order_nothing_delivered',
+  'order_partly_delivered',
+  'order_numbered',
+  'order_quotation_invalid',
+  'delivery_order_invalid',
+  'delivery_order_line_required',
+  'delivery_order_line_invalid',
+  'delivery_over_order',
   // HTTP ও সার্ভার
   'invalid_cursor',
   'version_conflict',
```

- **The `sales_*` codes** are shared by all three documents. `sales_customer_invalid` is an unknown or archived
  customer. `sales_address_invalid` is an address that is not one of this customer's. `sales_not_draft` is a
  change to a document that is no longer a draft (or no longer open, for a quotation).
- **`order_not_confirmed`** is a delivery or a "close" for an order that is not confirmed. **`order_has_deliveries`**
  refuses "reopen" while any delivery exists. **`order_nothing_delivered`** refuses "close" on an order that has
  delivered nothing ("cancel" it instead), and **`order_partly_delivered`** refuses "cancel" on one that has
  delivered something ("close" it instead). Two codes, so the message can say which button to use.
- **Three codes came while writing the API (15b.3).** `sales_item_invalid` is an unknown or archived product on a
  quotation or order line (the stock code `stock_variant_invalid` says "stocked product", and a service may be
  sold). `order_numbered` refuses deleting a draft order that has a number (it was confirmed, then reopened).
  `order_quotation_invalid` is a quotation of another customer.
- **`delivery_over_order`** is more than the order still has to deliver. It is checked when the delivery is posted,
  because two draft deliveries for the same order may each look fine alone.
- Every new code needs its English and Bangla text in `errors.*` (15b.5); until then `pnpm typecheck` fails in
  `packages/i18n`.

```diff
@@ -98,6 +98,23 @@ export const AUDIT_ACTIONS = [
   'price_list.archived',
   'price_list.restored',
   'price_list.prices_changed',
+  // step 15b
+  'quotation.created',
+  'quotation.updated',
+  'quotation.deleted',
+  'quotation.declined',
+  'quotation.reopened',
+  'sales_order.created',
+  'sales_order.updated',
+  'sales_order.deleted',
+  'sales_order.confirmed',
+  'sales_order.reopened',
+  'sales_order.closed',
+  'sales_order.cancelled',
+  'delivery.created',
+  'delivery.updated',
+  'delivery.deleted',
+  'delivery.posted',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -131,6 +148,9 @@ export const AUDIT_ENTITY_TYPES = [
   'customer',
   'customer_group',
   'price_list',
+  'quotation',
+  'sales_order',
+  'delivery',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

- **One action per thing a person does**, as in every earlier step. `quotation.accepted` is not an action: a
  quotation is accepted by `sales_order.created`, and that row already says which quotation it came from (15b.3).
- **Three entity types**, so the audit log can be filtered to one quotation, order or delivery.

### `routes.ts` and `index.ts`

```diff
@@ -15,11 +15,15 @@ import { meRoutes } from './preferences.js';
 import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js';
 import { customFieldRoutes } from './custom-fields.js';
 import { customerGroupRoutes, customerRoutes } from './customers.js';
+import { deliveryRoutes } from './deliveries.js';
 import { priceListRoutes } from './price-lists.js';
 import { productCategoryRoutes } from './product-categories.js';
 import { productImportRoutes } from './product-imports.js';
 import { productRoutes } from './products.js';
+import { quotationRoutes } from './quotations.js';
 import { roleRoutes } from './roles.js';
+import { salesOrderRoutes } from './sales-orders.js';
+import { salesPriceRoutes } from './sales.js';
 import { settingsRoutes } from './settings.js';
 import { setupRoutes } from './setup.js';
 import { stockAccountRoutes } from './stock-accounts.js';
@@ -81,4 +85,8 @@ export const routes = {
   customers: customerRoutes,
   customerGroups: customerGroupRoutes,
   priceLists: priceListRoutes,
+  salesPrices: salesPriceRoutes,
+  quotations: quotationRoutes,
+  salesOrders: salesOrderRoutes,
+  deliveries: deliveryRoutes,
 };
```

```diff
@@ -5,6 +5,7 @@ export * from './auth.js';
 export * from './branches.js';
 export * from './custom-fields.js';
 export * from './customers.js';
+export * from './deliveries.js';
 export * from './errors.js';
 export * from './fields.js';
 export * from './http.js';
@@ -22,9 +23,12 @@ export * from './product-categories.js';
 export * from './product-imports.js';
 export * from './products.js';
 export * from './quantities.js';
+export * from './quotations.js';
 export * from './reports.js';
 export * from './roles.js';
 export * from './routes.js';
+export * from './sales.js';
+export * from './sales-orders.js';
 export * from './settings.js';
 export * from './setup.js';
 export * from './stock.js';
```

- **Four route groups.** `salesPrices` (the lookup), `quotations`, `salesOrders` and `deliveries`. The API's
  contract test (step 5) checks that Nest has exactly these routes, so 15b.3 must add a controller for each.

### Tests

```diff
@@ -5,10 +5,12 @@ import {
   addMoney,
   amountSchema,
   compareMoney,
+  includedTaxOf,
   isNegativeMoney,
   isZeroMoney,
   multiplyMoney,
   negateMoney,
+  percentOfMoney,
   prorateMoney,
   splitMoney,
   subtractMoney,
@@ -84,6 +86,21 @@ describe('money', () => {
     expect(() => unitCostOf('10', '0')).toThrow();
   });
 
+  it('works out a percent to the paisa', () => {
+    // 15% of ৳1,234.50 = ৳185.175: half a paisa rounds up
+    expect(percentOfMoney('1234.5', '15')).toBe('185.1800');
+    expect(percentOfMoney('100', '7.5')).toBe('7.5000');
+    expect(percentOfMoney('999.99', '0')).toBe('0.0000');
+  });
+
+  it('finds the VAT inside an amount that includes it', () => {
+    expect(includedTaxOf('1150', '15')).toBe('150.0000');
+    expect(includedTaxOf('107.5', '7.50')).toBe('7.5000');
+    // 100 × 15 ÷ 115 = 13.0434…
+    expect(includedTaxOf('100', '15')).toBe('13.0400');
+    expect(includedTaxOf('100', '0')).toBe('0.0000');
+  });
+
   it('compares and negates', () => {
     expect(compareMoney('10', '10.0000')).toBe(0);
     expect(compareMoney('-1', '0')).toBe(-1);
```

```ts
import { describe, expect, it } from 'vitest';

import { deliveryInputSchema } from './deliveries.js';
import { contractErrorMap } from './errors.js';
import { quotationInputSchema } from './quotations.js';
import { salesOrderInputSchema } from './sales-orders.js';
import {
  defaultLineDescription,
  documentTotals,
  draftLineAmounts,
  lineAmounts,
  salesLineInputSchema,
} from './sales.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const ORDER = '01920000-0000-7000-8000-000000000006';
const ORDER_LINE = '01920000-0000-7000-8000-000000000007';

function salesLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '3',
    description: '',
    unitPrice: '1200.50',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    ...extra,
  };
}

function deliveryLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    batchId: '',
    serialNumbers: [],
    orderLineId: ORDER_LINE,
    ...extra,
  };
}

// The error codes where the form will show them: field path → code
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('line amounts', () => {
  it('adds the VAT to a price typed without it', () => {
    // 3 × ৳1,200.50 = ৳3,601.50; 10% off = ৳360.15; VAT 15% of ৳3,241.35 = ৳486.2025 → ৳486.20
    expect(
      lineAmounts(
        {
          quantity: '3',
          unitPrice: '1200.50',
          discountType: 'percent',
          discount: '10',
          rate: '15',
        },
        false,
      ),
    ).toEqual({
      gross: '3601.5000',
      discount: '360.1500',
      net: '3241.3500',
      vat: '486.2000',
      total: '3727.5500',
    });
  });

  it('takes the VAT out of a price that includes it', () => {
    // 2 × ৳115 − ৳30 = ৳200 to pay; it holds 200 × 15 ÷ 115 = ৳26.0869… → ৳26.09 of VAT
    expect(
      lineAmounts(
        { quantity: '2', unitPrice: '115', discountType: 'amount', discount: '30', rate: '15.00' },
        true,
      ),
    ).toEqual({
      gross: '230.0000',
      discount: '30.0000',
      net: '173.9100',
      vat: '26.0900',
      total: '200.0000',
    });
  });

  it('charges nothing on an exempt line, with or without VAT in the price', () => {
    const line = {
      quantity: '10',
      unitPrice: '0.8512',
      discountType: 'amount',
      discount: '0',
      rate: '0.00',
    } as const;
    // 10 strips at ৳0.8512 = ৳8.512 → ৳8.51: the line is kept to the paisa
    expect(lineAmounts(line, false)).toMatchObject({
      net: '8.5100',
      vat: '0.0000',
      total: '8.5100',
    });
    expect(lineAmounts(line, true)).toMatchObject({
      net: '8.5100',
      vat: '0.0000',
      total: '8.5100',
    });
  });

  it('totals a document from its rounded lines', () => {
    const lines = [
      lineAmounts(
        { quantity: '1', unitPrice: '0.10', discountType: 'percent', discount: '0', rate: '15' },
        false,
      ),
      lineAmounts(
        { quantity: '1', unitPrice: '0.10', discountType: 'percent', discount: '0', rate: '15' },
        false,
      ),
    ];
    // Each line's VAT is ৳0.015 → ৳0.02, so the document's is ৳0.04 (not 15% of ৳0.20 = ৳0.03):
    // the total is what the printed lines add up to
    expect(documentTotals(lines)).toEqual({
      discount: '0.0000',
      net: '0.2000',
      vat: '0.0400',
      total: '0.2400',
    });
  });

  it('waits for complete boxes while a line is typed', () => {
    const typed = {
      quantity: '1.',
      unitPrice: '100',
      discountType: 'percent',
      discount: '',
    } as const;
    expect(draftLineAmounts(typed, '15', false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: '1' }, null, false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: '1', unitPrice: '' }, '15', false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: ' 1 ' }, '15', false)).toMatchObject({
      vat: '15.0000',
      total: '115.0000',
    });
  });
});

describe('sales line input', () => {
  it('names a line by its product, and its variant’s options', () => {
    expect(defaultLineDescription({ productName: 'Napa 500 mg', optionValues: [] })).toBe(
      'Napa 500 mg',
    );
    expect(defaultLineDescription({ productName: 'Polo shirt', optionValues: ['M', 'Navy'] })).toBe(
      'Polo shirt — M, Navy',
    );
  });

  it('turns empty boxes into "no description" and "no discount"', () => {
    const parsed = salesLineInputSchema.parse(salesLine());
    expect(parsed).toMatchObject({ description: null, discount: '0' });
  });

  it('needs a price, and takes ৳0 for a free sample', () => {
    const empty = salesLineInputSchema.safeParse(salesLine({ unitPrice: ' ' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(empty)).toEqual({ unitPrice: 'sales_price_required' });
    expect(salesLineInputSchema.safeParse(salesLine({ unitPrice: '0' })).success).toBe(true);
  });

  it('never takes more off than the line', () => {
    const percent = salesLineInputSchema.safeParse(salesLine({ discount: '100.01' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(percent)).toEqual({ discount: 'sales_discount_too_large' });
    // 3 × ৳1,200.50 = ৳3,601.50: all of it is fine, a paisa more is not
    expect(
      salesLineInputSchema.safeParse(salesLine({ discountType: 'amount', discount: '3601.50' }))
        .success,
    ).toBe(true);
    const amount = salesLineInputSchema.safeParse(
      salesLine({ discountType: 'amount', discount: '3601.51' }),
      { error: contractErrorMap },
    );
    expect(errorsOf(amount)).toEqual({ discount: 'sales_discount_too_large' });
  });

  it('keeps a discount to the paisa', () => {
    const result = salesLineInputSchema.safeParse(salesLine({ discount: '2.555' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(result)).toEqual({ discount: 'money_format' });
  });
});

describe('sales documents', () => {
  it('ends a quotation on or after its date', () => {
    const quotation = {
      customerId: CUSTOMER,
      date: '2026-10-07',
      validUntil: '2026-10-06',
      note: '',
      lines: [salesLine()],
    };
    const result = quotationInputSchema.safeParse(quotation, { error: contractErrorMap });
    expect(errorsOf(result)).toEqual({ validUntil: 'quotation_valid_until' });
    expect(quotationInputSchema.parse({ ...quotation, validUntil: '' }).validUntil).toBeNull();
  });

  it('needs a customer, a line, and a delivery date after the order', () => {
    const order = {
      customerId: '',
      date: '2026-10-07',
      customerReference: 'PO-H&M-55120',
      deliveryDate: '2026-10-01',
      warehouseId: WAREHOUSE,
      shippingAddressId: '',
      note: '',
      lines: [],
      confirm: false,
    };
    // Every mistake at once, so the form marks them all on the first save
    const result = salesOrderInputSchema.safeParse(order, { error: contractErrorMap });
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      deliveryDate: 'order_delivery_date',
      lines: 'sales_lines_required',
    });
    const parsed = salesOrderInputSchema.parse({
      ...order,
      customerId: CUSTOMER,
      deliveryDate: '',
      lines: [salesLine()],
    });
    // A form that starts from nothing does not send the quotation
    expect(parsed).toMatchObject({
      quotationId: null,
      shippingAddressId: null,
      deliveryDate: null,
    });
  });

  it('delivers order lines from an order, and only from an order', () => {
    const delivery = {
      customerId: CUSTOMER,
      orderId: ORDER,
      date: '2026-10-07',
      warehouseId: WAREHOUSE,
      shippingAddressId: '',
      vehicle: 'Dhaka Metro-Ta 11-2233',
      note: '',
      lines: [deliveryLine(), deliveryLine({ orderLineId: '' })],
      post: true,
    };
    const fromOrder = deliveryInputSchema.safeParse(delivery, { error: contractErrorMap });
    expect(errorsOf(fromOrder)).toEqual({ 'lines.1.orderLineId': 'delivery_order_line_required' });
    const withoutOrder = deliveryInputSchema.safeParse(
      { ...delivery, orderId: '' },
      { error: contractErrorMap },
    );
    expect(errorsOf(withoutOrder)).toEqual({
      'lines.0.orderLineId': 'delivery_order_line_invalid',
    });
    // One order line over two batches
    expect(
      deliveryInputSchema.safeParse({ ...delivery, lines: [deliveryLine(), deliveryLine()] })
        .success,
    ).toBe(true);
  });
});
```

- **The amounts are worked out by hand in the comments.** `3 × ৳1,200.50 = ৳3,601.50`, 10% off, 15% VAT. If
  someone changes the order of the steps in `lineAmounts()` (VAT before the discount), the first two tests fail
  with numbers a person can check on paper.
- **The `৳0.10` test** is the one that shows why the document adds rounded lines: two lines of ৳0.015 VAT each give
  ৳0.04, while 15% of ৳0.20 would give ৳0.03.
- **`'1.'` in `draftLineAmounts()`.** That is what the box holds after the person types "1" and a point. It must
  return `null`, not throw.
- **"Every mistake at once".** Zod 4 runs the order's own rule (the delivery date) even when a field has failed.
  The test keeps that behaviour: the form marks all three mistakes on the first save, not one per try.
- **The delivery test** checks both directions of the order line rule, and that one order line over two batches is
  fine.
- **`defaultLineDescription()`** is checked with and without options, because the API and the form both depend on
  the exact text.

### Check this part

```bash
pnpm --filter @omnivo/contracts typecheck
pnpm --filter @omnivo/contracts test          # 121 tests, 14 new
pnpm lint
```

`pnpm typecheck` for the whole repo **fails** after this part, and that is expected. The next parts fix it:
`packages/db` needs a description for each new permission (15b.2), the API's stock service must send `onOrder`
(15b.3), `packages/i18n` needs the new keys (15b.5), and the app's mock must send `onOrder` (15b.7).


## 15b.2 — `packages/db`: six tables, two migrations

The contract has quotations, orders and deliveries; this part gives them tables. One new schema file holds all
six: a header table and a line table for each document. Three existing files change a little: the stock line
columns are exported (a delivery line is a stock line), the journal's document check learns the new source, and
the permission catalog describes the three new permissions. Migration 0027 is generated from the schema; 0028 is
written by hand and holds what Drizzle cannot write: row-level security, two foreign keys with
`ON DELETE SET NULL (column)`, and the triggers that decide what may change in which status.

### `schema/stock-documents.ts`: the stock line columns, exported

```diff
@@ -28,7 +28,8 @@ import { warehouses } from './warehouses.js';
 // The columns every stock document line has: which variant, in which unit and how many, and the
 // same quantity in the base unit. The factor is copied from the product at the time (1 for the
 // base unit): removing or resizing a pack later never changes what an old line meant.
-function lineColumns() {
+// Exported: a delivery line (step 15b, sales-documents.ts) is a stock document line too.
+export function stockLineColumns() {
   return {
     id: baseColumns().id,
     tenantId: uuid('tenant_id')
@@ -99,7 +100,7 @@ export const stockAdjustments = pgTable(
 export const stockAdjustmentLines = pgTable(
   'stock_adjustment_lines',
   {
-    ...lineColumns(),
+    ...stockLineColumns(),
     adjustmentId: uuid('adjustment_id').notNull(),
     // An "in" line of a batch product: the lot as typed. Posting finds or makes the batch.
     lotNumber: text('lot_number'),
@@ -212,7 +213,7 @@ export const stockTransfers = pgTable(
 export const stockTransferLines = pgTable(
   'stock_transfer_lines',
   {
-    ...lineColumns(),
+    ...stockLineColumns(),
     transferId: uuid('transfer_id').notNull(),
     // Set on receipt, in the base unit: what arrived. sent − received = the shortage.
     receivedQuantity: numeric('received_quantity', { precision: 19, scale: 4 }),
```

- **Exported, not copied.** A delivery line has exactly the columns of an adjustment line: variant, unit,
  quantity, factor, base quantity, batch and serial numbers. 15b.3 posts a delivery with the same
  `StockPostingService` code as an adjustment, so the columns must be the same, and one function keeps them so.
- **Renamed to `stockLineColumns()`.** Inside its own file `lineColumns()` was clear enough. Imported into a file
  that also has sales lines (with prices), the plain name would be ambiguous.

### `schema/sales-documents.ts` (new): the line columns

```ts
import {
  DISCOUNT_TYPES,
  ORDER_STATUSES,
  QUOTATION_STATUSES,
  STOCK_DOCUMENT_STATUSES,
  TAX_RATE_KINDS,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { stockLineColumns } from './stock-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 15b: quotations, sales orders and deliveries (challans). The rules on what may change when
// (a confirmed order's lines, a posted delivery) live in migration 0028, like the stock documents'.

// The columns a quotation line and an order line share: the product, the quantity (as typed and in
// the base unit, like a stock line), the price and discount as typed, and a copy of the VAT rate.
// net, vat and total are what contracts' lineAmounts() gave when the line was saved: stored, not
// worked out on every read, so a list shows the totals without the arithmetic, and a document reads
// the same in five years whatever happens to the code.
function salesLineColumns() {
  return {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // As it will be printed: the person's own text, or the product's name when they typed none
    description: text('description').notNull(),
    // Per one of the unit, as typed: with or without VAT, as the document's prices_include_vat says
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    discountType: text('discount_type', { enum: DISCOUNT_TYPES }).notNull(),
    // As typed: 12.5 (percent) or 250 (taka off the line)
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    // The rate the line used, and a copy of it: when a rate is changed or archived, an old line
    // still says what it charged
    taxRateId: uuid('tax_rate_id').notNull(),
    taxRateName: text('tax_rate_name').notNull(),
    taxRateKind: text('tax_rate_kind', { enum: TAX_RATE_KINDS }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
    vat: numeric('vat', { precision: 19, scale: 4 }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
  };
}

// The totals every quotation and order keeps: the sums of its lines (contracts' documentTotals)
function totalColumns() {
  return {
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    net: numeric('net', { precision: 19, scale: 4 }).notNull().default('0'),
    vat: numeric('vat', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
  };
}
```

- **One file for six tables.** The three documents point at each other (an order at its quotation, a delivery at
  its order and at the order's lines), and their lines share columns. Steps 13 and 14 did the same with
  `stock-documents.ts`.
- **`net`, `vat` and `total` are stored on every line.** They are what `lineAmounts()` (15b.1) gave when the line
  was saved. Working them out on every read would be cheap, but stored values have two advantages: the list
  shows a document's totals without loading its lines, and a document from 2026 reads the same in 2031, even if
  the arithmetic in the code is changed by then. The API never computes them any other way: it calls the
  contract's function, so the form, the server and the table agree to the paisa.
- **`discount` is stored as typed, with `discount_type`.** 12.5 means 12.5% or ৳12.50 depending on the type. The
  form needs the typed value to show the line again; the amount it took off is inside `net`.
- **The VAT rate is copied onto the line** (`tax_rate_name`, `tax_rate_kind`, `tax_rate`), next to `tax_rate_id`.
  This is decision 6 of step 15: when the NBR changes a rate, or someone archives one, old lines still say what
  they charged. The id stays so a report can group by rate. `NUMERIC(5,2)`, like `tax_rates.rate`.
- **`description` is `NOT NULL`.** The contract lets the form send `null` ("use the product's name"); the API then
  writes the product's name with its options ("Polo shirt — M, Navy blue"). The line keeps the text as it was,
  like the VAT rate: renaming a product later does not rewrite old quotations.
- **`unit_price` is `NUMERIC(19,4)`**, like every amount. The contract allows 4 decimals in a unit price (a
  garments trim at ৳0.0350 a piece); the line amounts are rounded to the paisa.
- **`totalColumns()`** are the sums of the lines (`documentTotals()`), on the header, so the list needs no join and
  no `GROUP BY`. `discount` is there too: the document page shows "Discount ৳1,250.00" above the net.

### Quotations

```ts
// ---------------------------------------------------------------------------------------------
// Quotations

export const quotations = pgTable(
  'quotations',
  {
    // deleted_at is not used: an open quotation is deleted for real, an answered one never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('sales.quotation'): the customer quotes it back
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
    customerId: uuid('customer_id').notNull(),
    // The workspace setting when it was written (step 15a)
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: QUOTATION_STATUSES }).notNull().default('open'),
    note: text('note'),
    ...totalColumns(),
  },
  (table) => [
    uniqueIndex('quotations_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('quotations_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('quotations_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's quotations (the list's filter), and the customer FK's check on delete
    index('quotations_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // No ON DELETE: a customer with a quotation cannot be deleted (customer_in_use)
    foreignKey({
      name: 'quotations_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    check(
      'quotations_valid_until_check',
      sql`${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.date}`,
    ),
    check(
      'quotations_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

export const quotationLines = pgTable(
  'quotation_lines',
  {
    ...salesLineColumns(),
    quotationId: uuid('quotation_id').notNull(),
  },
  (table) => [
    uniqueIndex('quotation_lines_line_idx').on(table.tenantId, table.quotationId, table.lineNo),
    // A line blocks deleting its variant (product_variant_in_use), and finds where it is used
    index('quotation_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'quotation_lines_quotation_fk',
      columns: [table.tenantId, table.quotationId],
      foreignColumns: [quotations.tenantId, quotations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quotation_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'quotation_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'quotation_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'quotation_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The contract's rules again: a discount never takes more than the line (and so net >= 0), and
    // total is net plus VAT, to the paisa
    check(
      'quotation_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('quotation_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
  ],
);
```

- **`number` is `NOT NULL`.** A quotation is numbered when it is saved (QT-2026-27-0001), not when it is posted:
  it posts nothing, and the customer quotes the number back. So the uniqueness index never meets a `NULL`.
- **`prices_include_vat` on the document.** It is the workspace setting at the time (step 15a). If the company
  switches the setting later, the old quotation's ৳115 still means "VAT included".
- **`quotations_customer_idx` is (tenant, customer, date, id).** It serves the list filtered by customer, in the
  list's own order, and it is the index Postgres uses for the customer FK's check when a customer is deleted.
  Without it, deleting a customer would scan every quotation.
- **No `ON DELETE` on the customer FK.** A customer with a quotation cannot be deleted; the API turns the FK error
  into `customer_in_use` (15b.3). The same is true of orders and deliveries.
- **`quotations_totals_check`: `total = net + vat`.** The contract's arithmetic gives exactly this. A row that
  breaks it was written by a bug, and it is better refused than printed.
- **The line FK has `ON DELETE CASCADE`.** An open quotation is deleted with its lines in one statement. Whether
  it may be deleted at all is migration 0028's guard.
- **`quotation_lines_amounts_check`.** The contract's rules again: no negative price, a percent discount at most
  100, and `net >= 0` (a discount never takes more than the line). The rule "an amount discount at most quantity ×
  price" is not here: it is what `net >= 0` already means once the arithmetic ran.
- **The tax rate FK.** Rates are archived, never deleted (15a), so this FK never blocks anything. It keeps the id
  honest: a line cannot name a rate of another workspace, or one that does not exist.

### Sales orders

```ts
// ---------------------------------------------------------------------------------------------
// Sales orders

export const salesOrders = pgTable(
  'sales_orders',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first confirmed ('sales.order'). Kept when it goes back to draft, so the
    // number the customer was told never changes.
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    deliveryDate: date('delivery_date', { mode: 'string' }),
    customerId: uuid('customer_id').notNull(),
    // The buyer's PO number, a pharmacy's indent number
    customerReference: text('customer_reference'),
    // Where deliveries take the goods from by default, and where "on order" is counted
    warehouseId: uuid('warehouse_id').notNull(),
    // An address of this customer (the FK is in migration 0028: it needs ON DELETE SET NULL on one
    // column, which Drizzle cannot write), and its text when the order was saved
    shippingAddressId: uuid('shipping_address_id'),
    shippingAddress: text('shipping_address'),
    // The quotation it was made from
    quotationId: uuid('quotation_id'),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('draft'),
    note: text('note'),
    ...totalColumns(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
  },
  (table) => [
    uniqueIndex('sales_orders_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the delivery's FK: an order of THIS customer
    uniqueIndex('sales_orders_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('sales_orders_tenant_number_idx').on(table.tenantId, table.number),
    // A quotation becomes one order at most. NULLs never collide.
    uniqueIndex('sales_orders_quotation_idx').on(table.tenantId, table.quotationId),
    index('sales_orders_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('sales_orders_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // What confirmed orders still have to deliver, per warehouse: the stock list's "on order".
    // Partial: delivered, closed and cancelled orders (most of them, after a year) are not in it.
    index('sales_orders_open_idx')
      .on(table.tenantId, table.warehouseId)
      .where(sql`${table.status} = 'confirmed'`),
    foreignKey({
      name: 'sales_orders_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'sales_orders_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'sales_orders_quotation_fk',
      columns: [table.tenantId, table.quotationId],
      foreignColumns: [quotations.tenantId, quotations.id],
    }),
    // Out of draft ⇔ confirmed at a time. A draft may still have a number: it was confirmed once,
    // then reopened.
    check(
      'sales_orders_confirmed_check',
      sql`(${table.status} = 'draft') = (${table.confirmedAt} IS NULL) AND (${table.status} = 'draft' OR ${table.number} IS NOT NULL)`,
    ),
    check(
      'sales_orders_delivery_date_check',
      sql`${table.deliveryDate} IS NULL OR ${table.deliveryDate} >= ${table.date}`,
    ),
    check(
      'sales_orders_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    ...salesLineColumns(),
    orderId: uuid('order_id').notNull(),
    // In the base unit: the sum of the posted delivery lines that point here. Written by the
    // delivery's posting, under a lock on the order (15b.3).
    deliveredQuantity: numeric('delivered_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('sales_order_lines_line_idx').on(table.tenantId, table.orderId, table.lineNo),
    // The target of the delivery line's FK
    uniqueIndex('sales_order_lines_tenant_id_idx').on(table.tenantId, table.id),
    index('sales_order_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'sales_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sales_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'sales_order_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'sales_order_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'sales_order_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The contract's rules again: a discount never takes more than the line (and so net >= 0), and
    // total is net plus VAT, to the paisa
    check(
      'sales_order_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'sales_order_lines_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
    // Never more than was ordered: the last word on over-delivery, whatever the API checked first
    check(
      'sales_order_lines_delivered_check',
      sql`${table.deliveredQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
    ),
  ],
);
```

- **`number` is nullable, and a draft may have one.** An order gets its number when it is first confirmed. A
  confirmed order with no delivery can go back to draft to be changed (15b.1), and it keeps its number: the
  customer was told SO-2026-27-0007, and the order stays SO-2026-27-0007. So the check is not "draft ⇔ no
  number" like a journal entry's. It is two rules: out of draft ⇔ `confirmed_at` is set, and out of draft ⇒ a
  number.
- **`shipping_address_id` has no FK here.** It has one, but in migration 0028, because it needs
  `ON DELETE SET NULL (shipping_address_id)` (see there). `shipping_address` is the text at the time: what the
  order page and, later, the challan print.
- **`sales_orders_quotation_idx` is unique.** A quotation becomes at most one order. Two people pressing "Make
  order" on the same quotation at the same moment: the second insert fails here, whatever the code checked. NULLs
  never collide, so orders without a quotation are not limited.
- **`sales_orders_customer_id_idx` (tenant, customer, id) is unique.** The `id` alone is unique already, so this
  index adds no rule of its own. It exists as the target of the delivery's FK, which includes the customer: a
  delivery can only point at an order of the same customer (see deliveries).
- **`sales_orders_open_idx` is partial, `WHERE status = 'confirmed'`.** The stock list shows "on order" next to
  "on hand": what confirmed orders still have to deliver, per warehouse. After a year, almost every order is
  delivered or closed, so the index holds only the few open ones, like the transfers' `in_transit` index in
  step 13.
- **`delivered_quantity` on the order line**, in the base unit, `NOT NULL DEFAULT 0`. It is the sum of the posted
  delivery lines that point at this line. It is stored, not summed on every read, because "on order" reads it
  for every open order line of a warehouse. 15b.3 adds to it when a delivery is posted, while holding a lock on
  the order.
- **`sales_order_lines_delivered_check`: between 0 and `base_quantity`.** This is the last word on over-delivery.
  15b.3 checks first and answers `delivery_over_order` with the line; if two deliveries are ever posted at once
  past the lock, or a bug skips the check, this refuses the second one.
- **`sales_order_lines_tenant_id_idx` (tenant, id) is unique.** The target of the delivery line's FK.

### Deliveries

```ts
// ---------------------------------------------------------------------------------------------
// Deliveries (delivery challans)

export const deliveries = pgTable(
  'deliveries',
  {
    // deleted_at is not used: a draft is deleted for real, a posted delivery never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.delivery'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    // NULL = a delivery without an order
    orderId: uuid('order_id'),
    warehouseId: uuid('warehouse_id').notNull(),
    // Like the order's: an address of this customer (FK in 0028) and its text on the challan
    shippingAddressId: uuid('shipping_address_id'),
    shippingAddress: text('shipping_address'),
    vehicle: text('vehicle'),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('deliveries_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('deliveries_tenant_number_idx').on(table.tenantId, table.number),
    index('deliveries_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('deliveries_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // An order's deliveries (its page; "has it any delivery?" before a reopen)
    index('deliveries_order_idx')
      .on(table.tenantId, table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    index('deliveries_warehouse_idx').on(table.tenantId, table.warehouseId),
    foreignKey({
      name: 'deliveries_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // customer_id is in both keys: a delivery's order is always an order of the same customer
    foreignKey({
      name: 'deliveries_order_fk',
      columns: [table.tenantId, table.customerId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.customerId, salesOrders.id],
    }),
    foreignKey({
      name: 'deliveries_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check(
      'deliveries_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const deliveryLines = pgTable(
  'delivery_lines',
  {
    ...stockLineColumns(),
    deliveryId: uuid('delivery_id').notNull(),
    // The order line it delivers; NULL on a delivery without an order
    orderLineId: uuid('order_line_id'),
    // What the goods cost, at the average cost when posted (step 14); NULL while a draft
    value: numeric('value', { precision: 19, scale: 4 }),
  },
  (table) => [
    uniqueIndex('delivery_lines_line_idx').on(table.tenantId, table.deliveryId, table.lineNo),
    index('delivery_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // The order line FK's check when a draft order's lines are replaced
    index('delivery_lines_order_line_idx')
      .on(table.tenantId, table.orderLineId)
      .where(sql`${table.orderLineId} IS NOT NULL`),
    foreignKey({
      name: 'delivery_lines_delivery_fk',
      columns: [table.tenantId, table.deliveryId],
      foreignColumns: [deliveries.tenantId, deliveries.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'delivery_lines_order_line_fk',
      columns: [table.tenantId, table.orderLineId],
      foreignColumns: [salesOrderLines.tenantId, salesOrderLines.id],
    }),
    foreignKey({
      name: 'delivery_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'delivery_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'delivery_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'delivery_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check('delivery_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
  ],
);
```

- **Shaped like a stock adjustment.** A draft has no number; posting gives it one, and the check
  `deliveries_posted_check` says posted ⇔ a number and a posting time, the same as `stock_adjustments`.
  `status` uses the same `STOCK_DOCUMENT_STATUSES` (draft, posted).
- **`deliveries_order_fk` includes the customer:** (tenant, customer, order) → `sales_orders` (tenant, customer,
  id). So a delivery's order is always an order of the delivery's customer. The contract and the API check
  this too (`delivery_order_invalid`), but here it cannot be skipped. With `order_id` `NULL` (a delivery without an
  order) the FK is not checked at all: that is how a composite FK treats a `NULL` (`MATCH SIMPLE`).
- **`deliveries_order_idx` is partial (`WHERE order_id IS NOT NULL`).** It lists an order's deliveries on the
  order page, and answers "does this order have any delivery?" before a reopen. Deliveries without an order are
  not in it.
- **`delivery_lines` uses `stockLineColumns()`** plus three columns: the delivery, the order line, and `value`.
- **`order_line_id` points at the order line, not at the order.** One order line may be split over two delivery
  lines (one batch ran out). The rule "the order line belongs to the delivery's order, with the same variant" is
  the API's (`delivery_order_line_invalid`): the database would need the order id on every line to check it, a
  copy that could drift.
- **The order line FK has no `ON DELETE`.** While a delivery line points at an order line, that line cannot be
  deleted. So a confirmed order that has even a draft delivery cannot be reopened and have its lines replaced:
  the database refuses, whatever the API checked (we tried this, see "What we checked").
- **`value` is `NULL` until posted.** It is what the goods cost at the average cost when the delivery was posted
  (step 14), the amount of the cost of goods sold entry. A draft has no value yet: the average may change before
  it is posted.

### `schema/journal.ts`, `schema/index.ts`, `permission-catalog.ts`

```diff
@@ -76,10 +76,11 @@ export const journalEntries = pgTable(
       'journal_entries_reversal_check',
       sql`(${table.source} = 'reversal') = (${table.reversalOfId} IS NOT NULL)`,
     ),
-    // A stock document's entry always points at its document, and no other entry does
+    // A stock document's entry (a delivery's too, step 15b) always points at its document, and no
+    // other entry does. The list is contracts' STOCK_JOURNAL_SOURCES.
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A stock document's entries (a transfer has up to two)
     index('journal_entries_document_idx')
```

- **`sales_delivery` joins the document check.** A delivery's cost of goods sold entry points at its delivery,
  like an adjustment's entry. Without this line, 15b.3's posting would fail on `journal_entries_document_check`
  (the source is a stock source, but the check would say no document is allowed). The list is the contract's
  `STOCK_JOURNAL_SOURCES`; a check constraint cannot import it, so the comment says where it comes from.
- `drizzle-kit` turns this into `DROP CONSTRAINT` + `ADD CONSTRAINT`. Adding the constraint checks every existing
  entry, which passes: no entry has the new source yet, and the rule for the old sources has not changed.

```diff
@@ -33,3 +33,4 @@ export * from './stock-valuation.js';
 export * from './tax-rates.js';
 export * from './price-lists.js';
 export * from './parties.js';
+export * from './sales-documents.js';
```

```diff
@@ -32,6 +32,9 @@ const DESCRIPTIONS = {
   'sales.customer.manage': 'Add, edit, archive and delete customers and customer groups',
   'sales.customer.balance': 'See what customers owe, and their statements',
   'sales.price_list.manage': 'Add, edit and archive price lists, and set their prices',
+  'sales.quotation.manage': 'Write, edit, decline and delete quotations',
+  'sales.order.manage': 'Write, confirm, reopen, close and cancel sales orders',
+  'sales.delivery.manage': 'Write and post deliveries (delivery challans), which take stock out',
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

- **The three descriptions are what makes the repo type-check again** after 15b.1: `DESCRIPTIONS` must have a
  key for every `PermissionKey` (`satisfies Record<PermissionKey, string>`). `pnpm db:migrate` writes them into
  the `permissions` table (`syncPermissions`), so no migration is needed for them.

### Migration 0027 (generated — then move the indexes up)

Run `pnpm --filter @omnivo/db generate --name sales-documents`. As in every step since 9, `drizzle-kit` writes the
foreign keys before the unique indexes they point at (`sales_orders_customer_id_idx`,
`sales_order_lines_tenant_id_idx`, …), and the migration fails with "there is no unique constraint matching given
keys". Move every `CREATE INDEX` and `CREATE UNIQUE INDEX` up, before the first `ADD CONSTRAINT … FOREIGN KEY`. The
result:

```sql
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"shipping_address_id" uuid,
	"shipping_address" text,
	"vehicle" text,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	CONSTRAINT "deliveries_posted_check" CHECK (("deliveries"."status" = 'posted') = ("deliveries"."number" IS NOT NULL AND "deliveries"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"batch_id" uuid,
	"serial_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_id" uuid NOT NULL,
	"order_line_id" uuid,
	"value" numeric(19, 4),
	CONSTRAINT "delivery_lines_quantity_check" CHECK ("delivery_lines"."quantity" > 0 AND "delivery_lines"."factor" > 0 AND "delivery_lines"."base_quantity" > 0),
	CONSTRAINT "delivery_lines_value_check" CHECK ("delivery_lines"."value" IS NULL OR "delivery_lines"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "quotation_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"quotation_id" uuid NOT NULL,
	CONSTRAINT "quotation_lines_quantity_check" CHECK ("quotation_lines"."quantity" > 0 AND "quotation_lines"."factor" > 0 AND "quotation_lines"."base_quantity" > 0),
	CONSTRAINT "quotation_lines_amounts_check" CHECK ("quotation_lines"."unit_price" >= 0 AND "quotation_lines"."discount" >= 0 AND ("quotation_lines"."discount_type" = 'amount' OR "quotation_lines"."discount" <= 100) AND "quotation_lines"."net" >= 0 AND "quotation_lines"."vat" >= 0 AND "quotation_lines"."total" = "quotation_lines"."net" + "quotation_lines"."vat"),
	CONSTRAINT "quotation_lines_tax_rate_check" CHECK ("quotation_lines"."tax_rate" >= 0 AND "quotation_lines"."tax_rate" < 100)
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"valid_until" date,
	"customer_id" uuid NOT NULL,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "quotations_valid_until_check" CHECK ("quotations"."valid_until" IS NULL OR "quotations"."valid_until" >= "quotations"."date"),
	CONSTRAINT "quotations_totals_check" CHECK ("quotations"."discount" >= 0 AND "quotations"."net" >= 0 AND "quotations"."vat" >= 0 AND "quotations"."total" = "quotations"."net" + "quotations"."vat")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"factor" numeric(19, 6) NOT NULL,
	"base_quantity" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_type" text NOT NULL,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_rate_id" uuid NOT NULL,
	"tax_rate_name" text NOT NULL,
	"tax_rate_kind" text NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"vat" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	"order_id" uuid NOT NULL,
	"delivered_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_order_lines_quantity_check" CHECK ("sales_order_lines"."quantity" > 0 AND "sales_order_lines"."factor" > 0 AND "sales_order_lines"."base_quantity" > 0),
	CONSTRAINT "sales_order_lines_amounts_check" CHECK ("sales_order_lines"."unit_price" >= 0 AND "sales_order_lines"."discount" >= 0 AND ("sales_order_lines"."discount_type" = 'amount' OR "sales_order_lines"."discount" <= 100) AND "sales_order_lines"."net" >= 0 AND "sales_order_lines"."vat" >= 0 AND "sales_order_lines"."total" = "sales_order_lines"."net" + "sales_order_lines"."vat"),
	CONSTRAINT "sales_order_lines_tax_rate_check" CHECK ("sales_order_lines"."tax_rate" >= 0 AND "sales_order_lines"."tax_rate" < 100),
	CONSTRAINT "sales_order_lines_delivered_check" CHECK ("sales_order_lines"."delivered_quantity" BETWEEN 0 AND "sales_order_lines"."base_quantity")
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"date" date NOT NULL,
	"delivery_date" date,
	"customer_id" uuid NOT NULL,
	"customer_reference" text,
	"warehouse_id" uuid NOT NULL,
	"shipping_address_id" uuid,
	"shipping_address" text,
	"quotation_id" uuid,
	"prices_include_vat" boolean NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"vat" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	CONSTRAINT "sales_orders_confirmed_check" CHECK (("sales_orders"."status" = 'draft') = ("sales_orders"."confirmed_at" IS NULL) AND ("sales_orders"."status" = 'draft' OR "sales_orders"."number" IS NOT NULL)),
	CONSTRAINT "sales_orders_delivery_date_check" CHECK ("sales_orders"."delivery_date" IS NULL OR "sales_orders"."delivery_date" >= "sales_orders"."date"),
	CONSTRAINT "sales_orders_totals_check" CHECK ("sales_orders"."discount" >= 0 AND "sales_orders"."net" >= 0 AND "sales_orders"."vat" >= 0 AND "sales_orders"."total" = "sales_orders"."net" + "sales_orders"."vat")
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_id_idx" ON "deliveries" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_number_idx" ON "deliveries" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "deliveries_tenant_date_idx" ON "deliveries" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "deliveries_customer_idx" ON "deliveries" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "deliveries_order_idx" ON "deliveries" USING btree ("tenant_id","order_id") WHERE "deliveries"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "deliveries_warehouse_idx" ON "deliveries" USING btree ("tenant_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_line_idx" ON "delivery_lines" USING btree ("tenant_id","delivery_id","line_no");--> statement-breakpoint
CREATE INDEX "delivery_lines_variant_idx" ON "delivery_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE INDEX "delivery_lines_order_line_idx" ON "delivery_lines" USING btree ("tenant_id","order_line_id") WHERE "delivery_lines"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "quotation_lines_line_idx" ON "quotation_lines" USING btree ("tenant_id","quotation_id","line_no");--> statement-breakpoint
CREATE INDEX "quotation_lines_variant_idx" ON "quotation_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_tenant_id_idx" ON "quotations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_tenant_number_idx" ON "quotations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "quotations_tenant_date_idx" ON "quotations" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "quotations_customer_idx" ON "quotations" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_line_idx" ON "sales_order_lines" USING btree ("tenant_id","order_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_lines_tenant_id_idx" ON "sales_order_lines" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_order_lines_variant_idx" ON "sales_order_lines" USING btree ("tenant_id","product_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_tenant_id_idx" ON "sales_orders" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_customer_id_idx" ON "sales_orders" USING btree ("tenant_id","customer_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_tenant_number_idx" ON "sales_orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_quotation_idx" ON "sales_orders" USING btree ("tenant_id","quotation_id");--> statement-breakpoint
CREATE INDEX "sales_orders_tenant_date_idx" ON "sales_orders" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_orders_customer_idx" ON "sales_orders" USING btree ("tenant_id","customer_id","date","id");--> statement-breakpoint
CREATE INDEX "sales_orders_open_idx" ON "sales_orders" USING btree ("tenant_id","warehouse_id") WHERE "sales_orders"."status" = 'confirmed';--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_fk" FOREIGN KEY ("tenant_id","customer_id","order_id") REFERENCES "public"."sales_orders"("tenant_id","customer_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_order_line_fk" FOREIGN KEY ("tenant_id","order_line_id") REFERENCES "public"."sales_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_batch_fk" FOREIGN KEY ("tenant_id","variant_id","batch_id") REFERENCES "public"."batches"("tenant_id","variant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_fk" FOREIGN KEY ("tenant_id","quotation_id") REFERENCES "public"."quotations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."sales_orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_variant_fk" FOREIGN KEY ("tenant_id","product_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_unit_fk" FOREIGN KEY ("tenant_id","unit_id") REFERENCES "public"."units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tax_rate_fk" FOREIGN KEY ("tenant_id","tax_rate_id") REFERENCES "public"."tax_rates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_fk" FOREIGN KEY ("tenant_id","warehouse_id") REFERENCES "public"."warehouses"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_fk" FOREIGN KEY ("tenant_id","quotation_id") REFERENCES "public"."quotations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));
```

- **Six new tables, one changed constraint.** No existing row is touched.
- The snapshot (`meta/0027_snapshot.json`) and `_journal.json` are written by `drizzle-kit`; commit them as they
  are.

### Migration 0028 (custom): RLS, the address FKs, what may change when

Run `pnpm --filter @omnivo/db generate --custom --name sales-documents-rules`, then fill the file:

```sql
-- Custom SQL migration file, put your code below! --
-- 1) The six new tenant tables: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries',
      'delivery_lines'
    ])
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

-- 2) The shipping address of an order and of a delivery is an address of THAT customer:
--    customer_id is in the key, so the address of another customer cannot be named. When the
--    customer's form removes the address later, only shipping_address_id becomes NULL: the text on
--    the document stays. A plain ON DELETE SET NULL would also clear customer_id (NOT NULL, so the
--    customer's save would fail). The column list needs Postgres 15 or later, and Drizzle cannot
--    write it, so these two foreign keys live here and not in the schema.
ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_shipping_address_fk
  FOREIGN KEY (tenant_id, customer_id, shipping_address_id)
  REFERENCES party_addresses (tenant_id, party_id, id)
  ON DELETE SET NULL (shipping_address_id);

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_shipping_address_fk
  FOREIGN KEY (tenant_id, customer_id, shipping_address_id)
  REFERENCES party_addresses (tenant_id, party_id, id)
  ON DELETE SET NULL (shipping_address_id);

-- 3) A quotation can be changed or deleted only while it is open. An answered one (accepted or
--    declined) keeps what it offered; only its status may move back to open (a declined one
--    reopened, or an accepted one whose draft order was deleted). The row is compared as JSON
--    without the columns that may change, so a column added later is frozen too, without
--    anyone remembering to list it here.
CREATE FUNCTION quotations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IN ('open', OLD.status)
     AND to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'quotation % was answered and cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'quotations_answered_immutable';
END $$;

CREATE TRIGGER quotations_guard
  BEFORE UPDATE OR DELETE ON quotations
  FOR EACH ROW EXECUTE FUNCTION quotations_guard();

-- The lines: only while the quotation is open. When an open quotation is deleted its lines go by
-- ON DELETE CASCADE; the header is gone by then, so the lookup finds nothing and lets them go.
CREATE FUNCTION quotation_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM quotations
         WHERE tenant_id = OLD.tenant_id AND id = OLD.quotation_id AND status <> 'open'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM quotations
         WHERE tenant_id = NEW.tenant_id AND id = NEW.quotation_id AND status <> 'open')) THEN
    RAISE EXCEPTION 'the lines of an answered quotation cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quotation_lines_answered_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER quotation_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION quotation_lines_guard();

-- 4) A sales order goes draft → confirmed → delivered, closed or cancelled, and a confirmed one may
--    go back to draft. Nothing else:
--    - a draft is changed freely; it is deleted only while it has no number (once confirmed, the
--      customer may have its number: it is cancelled instead, so SO numbers have no gaps);
--    - a confirmed order keeps what was agreed. Only its status moves (confirmed_at and
--      confirmed_by go with it: a reopen clears them);
--    - delivered, closed and cancelled are final.
--    In every state the shipping address id may become NULL, when the customer's address is
--    removed (section 2's ON DELETE SET NULL).
CREATE FUNCTION sales_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL THEN
      RAISE EXCEPTION 'sales order % has a number and cannot be deleted; cancel it instead', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_numbered_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'confirmed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed'
     AND to_jsonb(NEW) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                               'version', 'updated_at', 'updated_by']
         = to_jsonb(OLD) - ARRAY['status', 'confirmed_at', 'confirmed_by', 'shipping_address_id',
                                 'version', 'updated_at', 'updated_by'] THEN
    RETURN NEW;
  END IF;
  IF NEW.shipping_address_id IS NULL
     AND to_jsonb(NEW) - 'shipping_address_id' = to_jsonb(OLD) - 'shipping_address_id' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sales order % is % and cannot be changed this way', OLD.id, OLD.status
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_orders_confirmed_immutable';
END $$;

CREATE TRIGGER sales_orders_guard
  BEFORE UPDATE OR DELETE ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_orders_guard();

-- The lines: free while the order is a draft. While it is confirmed, a line may only have its
-- delivered_quantity changed (by a delivery's posting), with nothing else. Once delivered, closed
-- or cancelled: frozen. When a draft is deleted, its lines cascade as above.
CREATE FUNCTION sales_order_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status
      FROM sales_orders WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    -- NULL: no such order — the foreign key gives that error
    IF v_status IS NOT NULL AND v_status <> 'draft' THEN
      RAISE EXCEPTION 'lines cannot be added to a sales order that is not a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
    FROM sales_orders WHERE tenant_id = OLD.tenant_id AND id = OLD.order_id;
  IF v_status IS NULL OR v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF v_status = 'confirmed' AND TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - 'delivered_quantity' = to_jsonb(OLD) - 'delivered_quantity' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a confirmed sales order cannot be changed, except what was delivered'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'sales_order_lines_confirmed_immutable';
END $$;

CREATE TRIGGER sales_order_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION sales_order_lines_guard();

-- 5) A posted delivery and its lines never change, like a posted stock adjustment (0022): what
--    left the warehouse left. The one change allowed is section 2's: its shipping address id
--    becomes NULL when the customer's address is removed (the text on the challan stays).
CREATE FUNCTION deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted'
     AND NOT (TG_OP = 'UPDATE' AND NEW.shipping_address_id IS NULL
              AND to_jsonb(NEW) - 'shipping_address_id' = to_jsonb(OLD) - 'shipping_address_id') THEN
    RAISE EXCEPTION 'delivery % is posted and cannot be changed or deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deliveries_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER deliveries_guard
  BEFORE UPDATE OR DELETE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION deliveries_guard();

CREATE FUNCTION delivery_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = OLD.tenant_id AND id = OLD.delivery_id AND status = 'posted'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM deliveries
         WHERE tenant_id = NEW.tenant_id AND id = NEW.delivery_id AND status = 'posted')) THEN
    RAISE EXCEPTION 'the lines of a posted delivery cannot be changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'delivery_lines_posted_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON delivery_lines
  FOR EACH ROW EXECUTE FUNCTION delivery_lines_guard();
```

Part by part:

1. **RLS on the six new tables**, exactly like 0022, 0024 and 0026. The tenant-leak suite's RLS coverage test fails
   if a table with a `tenant_id` lacks `FORCE ROW LEVEL SECURITY`.
2. **The shipping address FKs.**
   - **The key is (tenant, customer, address)** → `party_addresses` (tenant, party, id), the unique index 15a made
     for this. So an order or a delivery can only name an address of its own customer. The API checks it too
     (`sales_address_invalid`), with a readable error.
   - **`ON DELETE SET NULL (shipping_address_id)`.** The customer form (15a) deletes an address the person
     removed. The order keeps its `shipping_address` text, so nothing is lost; only the link goes. A plain
     `ON DELETE SET NULL` would set *every* column of the FK to `NULL`, `customer_id` too, which is `NOT NULL`: the
     customer's save would fail with an error about orders. The column list fixes that; it needs Postgres 15 or
     later (we run 17).
   - **Why here and not in the schema.** Drizzle's `foreignKey().onDelete()` cannot write the column list. A
     constraint that only exists in a migration is fine for `drizzle-kit`: it compares the schema with its own
     snapshots, not with the database, so it never tries to drop it. 0020's search indexes work the same way.
3. **The quotation guard.** An open quotation is free: edit, delete. An answered one (accepted or declined) may
   only move back to `open`: a declined quotation reopened, or an accepted one whose draft order was deleted. Its
   content never changes.
   - **`to_jsonb(NEW) - ARRAY[…] = to_jsonb(OLD) - ARRAY[…]`** compares the whole row except the columns that may
     change. Step 13's guards listed the frozen columns one by one instead. Here the list is the other way round,
     the few columns that may change, so a column added in a later step is frozen by default: nobody has to
     remember this trigger.
   - **`NEW.status IN ('open', OLD.status)`.** Back to open, or the same status (a save that only bumps the
     version). Accepted → declined is refused: an accepted quotation has an order.
   - **The line guard** is step 13's adjustment line guard with "posted" replaced by "not open". When an open
     quotation is deleted, its lines go by `ON DELETE CASCADE`; by then the header is gone, the lookup finds
     nothing, and the lines are let go.
4. **The order guard.** It writes down 15b.1's life cycle:
   - **Delete only a draft without a number.** A draft *with* a number was confirmed once, and the customer may
     have that number. Deleting it would leave a gap in the SO numbers, which an auditor asks about. The person
     confirms it again and cancels it instead; 15b.3 answers the delete with its own error code before the
     database has to.
   - **Draft → draft or confirmed** is free (editing, confirming). Draft → delivered is refused: an order is
     delivered only by deliveries.
   - **A confirmed order keeps what was agreed.** Only `status` moves, with `confirmed_at`/`confirmed_by` (a reopen
     clears them, the check in 0027 requires it). Which move is allowed when (cancel only if nothing was
     delivered, close only if something was) is the API's rule, with its error codes; the database only keeps
     the content fixed.
   - **Delivered, closed and cancelled are final**, except for section 2: in every state, `shipping_address_id`
     may become `NULL`. Without that branch, a customer whose old order went to an address could never remove
     that address: the `SET NULL` would hit this guard and fail.
   - **The line guard.** Free while the order is a draft. While it is confirmed, only `delivered_quantity` may
     change, which is what posting a delivery does. Then frozen.
   - **The order of writes matters for 15b.3.** The delivery that finishes an order must add the delivered
     quantities first and only then set the order to `delivered`: in the other order, the line guard sees a
     delivered order and refuses the update.
5. **The delivery guard** is step 13's adjustment guard, plus the same address exception as orders. A posted
   challan went with the truck; it is never changed, and returns are their own document (15d).

> **What we checked.** On a throwaway database with every migration up to 0028, as `omnivo_app`: a quotation and an
> order were written; a line whose total is not net + VAT, a 120% discount, a validity date before the quotation
> date, a second QT number, a second order from the same quotation, an order naming another customer's address,
> a delivery for another customer's order, and a confirmation without a number all failed on their own
> constraints. An accepted quotation refused edits to itself and its lines, refused deletion and refused
> "declined", and went back to open. A confirmed order refused edits, new lines and a price change, refused
> delivering 11 of 10, accepted delivering 4, and refused deletion; reopened, it still refused deletion (it has
> a number). Reopening it while a delivery line pointed at its line and then deleting that line failed on
> `delivery_lines_order_line_fk`. A posted delivery refused edits, line edits and deletion; posting without a
> number failed. A closed order refused going back to confirmed. Deleting the customer's address cleared the
> address id on the confirmed order and the posted delivery and kept their text. Deleting the customer failed on
> a customer FK, and deleting the variant on a variant FK. Draft orders and draft deliveries were deleted with
> their lines. A `sales_delivery` journal entry without a document failed; with one it was accepted. Another
> workspace saw none of the rows and could not write into the first. `drizzle-kit generate` then reports no
> schema changes.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck
pnpm lint
```

`pnpm typecheck` for the whole repo still fails, as expected after 15b.1: the API's stock service must send
`onOrder` (15b.3), `packages/i18n` needs the new keys (15b.5), and the app's mock must send `onOrder` (15b.7). The
`packages/db` error from 15b.1 (the permission descriptions) is gone.

Then run `pnpm db:migrate` against your dev database. It applies 0027 and 0028 and writes the three permissions.

## 15b.3 — `apps/api`: the price lookup, quotations, orders and deliveries

The contract and the tables are ready; this part writes the server. Five new files in `apps/api/src/sales/` hold
the work: one with what quotations and orders share (`sales-lines.ts`), one service per document, the price
lookup, and one controller file for all four route groups. Six existing files change a little: the inventory
module exports one more service, `StockBooksService` learns the delivery's entry, the stock list counts what is
on order, the customer and product deletes learn the new foreign keys, and the role templates of a new workspace
give out the three new permissions.

The design follows the stock documents of steps 13 and 14 on purpose. A delivery is a stock document: it is
written as a draft, checked again and posted in one transaction, and it uses the same `resolveLines()`,
`StockPostingService.post()` and `StockBooksService` as a stock adjustment "out". If you know how an adjustment
is posted, you know how a delivery is posted; the new code is only what an order adds.

### `sales/sales-lines.ts` (new): the customer, the address and the line

```ts
import {
  defaultLineDescription,
  type ErrorCode,
  fitsDecimals,
  isQuantity,
  type LineAmounts,
  lineAmounts,
  type PartyRef,
  type SalesLine,
  type SalesLineInput,
  type TaxRateKind,
  toBaseQuantity,
} from '@omnivo/contracts';
import { parties, partyAddresses, taxRates, tenantSettings } from '@omnivo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppError } from '../common/http/app-error.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';

// What quotations and orders (and 15c's invoices) do the same way: check the customer, the address
// and the lines, work the lines out with contracts' lineAmounts(), and read them back.

function fieldError(code: ErrorCode, field: string, detail: string): AppError {
  return new AppError(409, code, detail, { fieldErrors: { [field]: [code] } });
}

// The customer a document is written for: a customer of this workspace, and not archived. A draft
// that already has this customer keeps it (keptId) even if the customer was archived since, like a
// customer keeps its archived price list (15a): the person can still finish the document. FOR
// SHARE: an archive or a delete waits until we commit.
export async function assertCustomer(
  tx: Transaction,
  customerId: string,
  keptId: string | null = null,
): Promise<PartyRef> {
  const [row] = await tx
    .select({
      id: parties.id,
      code: parties.code,
      name: parties.name,
      archivedAt: parties.archivedAt,
    })
    .from(parties)
    .where(
      and(
        eq(parties.tenantId, getTenantId()),
        eq(parties.id, customerId),
        eq(parties.isCustomer, true),
      ),
    )
    .for('share');
  if (!row || (row.archivedAt !== null && row.id !== keptId)) {
    throw fieldError('sales_customer_invalid', 'customerId', 'Pick an active customer.');
  }
  return { id: row.id, code: row.code, name: row.name };
}

// An address of this customer, and its text as the document keeps it: the label, the address and
// the phone on their own lines, the way a challan prints them. null = no address chosen.
export async function shippingAddressOf(
  tx: Transaction,
  customerId: string,
  addressId: string | null,
): Promise<{ id: string; text: string } | null> {
  if (addressId === null) return null;
  const [row] = await tx
    .select({
      label: partyAddresses.label,
      address: partyAddresses.address,
      phone: partyAddresses.phone,
    })
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.tenantId, getTenantId()),
        eq(partyAddresses.partyId, customerId),
        eq(partyAddresses.id, addressId),
      ),
    );
  if (!row) {
    throw fieldError(
      'sales_address_invalid',
      'shippingAddressId',
      'Pick one of this customer’s addresses.',
    );
  }
  const text = [row.label, row.address, row.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
  return { id: addressId, text };
}

// The workspace setting now (step 15a). A new document copies it and keeps its copy: when the owner
// changes the setting, the prices on old documents still mean what they meant.
export async function pricesIncludeVatNow(tx: Transaction): Promise<boolean> {
  const [settings] = await tx
    .select({ pricesIncludeVat: tenantSettings.pricesIncludeVat })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return settings.pricesIncludeVat;
}

// The parties of some documents, for the lists: id → code and name
export async function customerRefs(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, PartyRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: parties.id, code: parties.code, name: parties.name })
    .from(parties)
    .where(and(eq(parties.tenantId, getTenantId()), inArray(parties.id, unique)));
  return new Map(rows.map((row) => [row.id, row]));
}
```

- **`assertCustomer()` with a `keptId`.** A new document needs an active customer. A draft that already has a
  customer keeps it even after the customer is archived, so the person can still finish (or delete) that draft.
  15a did the same for a customer's archived price list. The check uses `FOR SHARE`: an archive or a delete of
  the customer, which locks the row `FOR UPDATE`, waits until we commit.
- **One answer for "unknown", "another workspace's" and "archived".** Row-level security already hides other
  workspaces; the explicit `tenant_id` filter is there anyway, like in every service. All three cases get
  `sales_customer_invalid` under `customerId`, so the form shows the message under the right box.
- **`shippingAddressOf()` returns the id and the text.** The id must be an address of *this* customer: the query
  filters on `party_id`, so an address of another customer is refused, not moved. The text is the label, the
  address and the phone on separate lines, the way a challan prints them. The document keeps this text (15b.2):
  when the customer edits the address later, the challan that went with the truck still says where it went.
- **`pricesIncludeVatNow()`** reads the workspace setting once. A new quotation or order copies it; an existing one
  keeps its own copy (the update code never calls this).
- **`customerRefs()`** turns ids into `{ id, code, name }` for the audit rows. The lists do not use it: they join
  `parties` in the same query.

```ts
// The VAT rate a line used, as the line keeps it
export interface TaxRateSnapshot {
  id: string;
  name: string;
  kind: TaxRateKind;
  rate: string;
}

// A line checked against its product and its VAT rate, with its amounts worked out
export interface ResolvedSalesLine {
  variant: VariantInfo;
  unitId: string;
  quantity: string;
  factor: string;
  baseQuantity: string;
  description: string;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
  taxRate: TaxRateSnapshot;
  amounts: LineAmounts;
}

// Every rule of a sales line the contract cannot check: the variant is an active product or
// service of this workspace, the unit is its base unit or one of its packs, the quantity fits the
// unit, and the VAT rate is an active one. keptRateIds: the rates the document's lines already use;
// they stay usable after the rate is archived, so an old draft can still be saved. All problems
// come back at once, each under its own field, like resolveLines() of the stock documents.
export async function resolveSalesLines(
  tx: Transaction,
  lines: readonly SalesLineInput[],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string> = new Set(),
): Promise<ResolvedSalesLine[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
  );
  const rateIds = [...new Set(lines.map((line) => line.taxRateId))];
  const rateRows = await tx
    .select({
      id: taxRates.id,
      name: taxRates.name,
      kind: taxRates.kind,
      rate: taxRates.rate,
      archivedAt: taxRates.archivedAt,
    })
    .from(taxRates)
    .where(and(eq(taxRates.tenantId, getTenantId()), inArray(taxRates.id, rateIds)));
  const rates = new Map(rateRows.map((row) => [row.id, row]));

  const issues: LineIssue[] = [];
  const resolved: ResolvedSalesLine[] = [];
  lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
    };
    // Unknown, another workspace's or archived: the same answer. A service is fine here: it is
    // sold, just never delivered.
    const variant = variants.get(line.variantId);
    if (variant === undefined || variant.archived) {
      at('variantId', 'sales_item_invalid');
      return;
    }
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) {
      at('unitId', 'stock_unit_invalid');
      return;
    }
    if (!fitsDecimals(line.quantity, unit.decimals)) {
      at('quantity', 'stock_quantity_decimals');
      return;
    }
    const baseQuantity = toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
    if (!isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    const rate = rates.get(line.taxRateId);
    if (rate === undefined || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      at('taxRateId', 'tax_rate_invalid');
      return;
    }
    const taxRate = { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate };
    resolved.push({
      variant,
      unitId: line.unitId,
      quantity: line.quantity,
      factor: unit.factor,
      baseQuantity,
      description: line.description ?? defaultLineDescription(variant),
      unitPrice: line.unitPrice,
      discountType: line.discountType,
      discount: line.discount,
      taxRate,
      // The same function the form totals with: the server stores what the person saw
      amounts: lineAmounts(
        {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discount: line.discount,
          rate: rate.rate,
        },
        pricesIncludeVat,
      ),
    });
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved;
}
```

- **The checks the contract cannot do**, because they need the database: the variant exists and is active, the
  unit is the product's base unit or one of its packs, the quantity has no more decimals than the unit allows,
  and the VAT rate exists and is active. The quantity and unit rules are the same as `resolveLines()` in step
  13, and they give the same error codes, so the form shows the same messages on every line editor.
- **A service is allowed here.** `resolveLines()` refuses a service (it moves no stock). A quotation or an order
  may sell one ("Installation", "Delivery charge"): it is priced and invoiced, just never delivered. So this
  function has its own variant check and its own code, `sales_item_invalid`.
- **An archived product is refused, even on an old draft.** Archiving a product means "we do not sell this any
  more". The person removes the line and saves. (A delivery is different: archived goods may still leave the
  warehouse, so the remaining stock can go somewhere. That is `resolveLines()`'s rule, and the delivery uses it.)
- **`keptRateIds`.** An archived VAT rate is refused on a new document, but a draft that already uses it can be
  saved again. The caller passes the rate ids of the stored lines. The snapshot is taken from the rate row now,
  so a draft saved again gets the rate's current name and percent; a quotation or an order that is no longer
  editable never changes.
- **`description ?? defaultLineDescription(variant)`.** The form sends `null` for "no description"; the line then
  says the product's name with its options. The column is `NOT NULL` (15b.2), so the text is always there to
  print. The function is the contract's (15b.1), because the form uses the same text as its placeholder.
- **`lineAmounts()` from the contract**, not a copy of it. The form totals the lines with the same function while
  the person types, so the server stores exactly the amounts the person saw, to the paisa. This is the main
  reason the arithmetic lives in `packages/contracts`.
- **All problems at once.** Each problem is pushed under its own path (`lines.3.taxRateId`) and thrown together
  with `linesError()`, the step 13 helper. The person fixes every line in one go.

```ts
// The columns a quotation line and an order line share, for an insert
export function salesLineValues(line: ResolvedSalesLine, index: number) {
  return {
    tenantId: getTenantId(),
    lineNo: index + 1,
    productId: line.variant.productId,
    variantId: line.variant.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    factor: line.factor,
    baseQuantity: line.baseQuantity,
    description: line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: line.discount,
    taxRateId: line.taxRate.id,
    taxRateName: line.taxRate.name,
    taxRateKind: line.taxRate.kind,
    taxRate: line.taxRate.rate,
    net: line.amounts.net,
    vat: line.amounts.vat,
    total: line.amounts.total,
  };
}

// A stored quotation or order line as the API sends it
interface SalesLineRow {
  id: string;
  unitId: string;
  quantity: string;
  baseQuantity: string;
  description: string;
  unitPrice: string;
  discountType: SalesLineInput['discountType'];
  discount: string;
  taxRateId: string;
  taxRateName: string;
  taxRateKind: string;
  taxRate: string;
  net: string;
  vat: string;
  total: string;
}

export function toSalesLine(row: SalesLineRow, variant: VariantInfo): SalesLine {
  return {
    id: row.id,
    variantId: variant.variantId,
    productId: variant.productId,
    productCode: variant.productCode,
    productName: variant.productName,
    optionValues: variant.optionValues,
    sku: variant.sku,
    baseUnitId: variant.baseUnitId,
    productType: variant.type,
    tracking: variant.tracking,
    hasExpiry: variant.hasExpiry,
    units: variant.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
    unitId: row.unitId,
    quantity: row.quantity,
    baseQuantity: row.baseQuantity,
    description: row.description,
    unitPrice: row.unitPrice,
    discountType: row.discountType,
    discount: row.discount,
    taxRate: { id: row.taxRateId, name: row.taxRateName, kind: row.taxRateKind, rate: row.taxRate },
    net: row.net,
    vat: row.vat,
    total: row.total,
  };
}

// The lines of a document with their variants, in line order. The FK keeps a variant while a line
// points at it, so none is ever missing; flatMap only satisfies the Map's undefined.
export async function withVariants<TRow extends { variantId: string }>(
  tx: Transaction,
  rows: readonly TRow[],
): Promise<{ row: TRow; variant: VariantInfo }[]> {
  const variants = await loadVariants(
    tx,
    rows.map((row) => row.variantId),
  );
  return rows.flatMap((row) => {
    const variant = variants.get(row.variantId);
    return variant === undefined ? [] : [{ row, variant }];
  });
}
```

- **`salesLineValues()`** is the insert row a quotation line and an order line share. Each service adds its own
  parent column (`quotationId` or `orderId`). The net, VAT and total come from the resolved amounts.
- **`toSalesLine()`** sends the line the way the contract says: the variant as it is now (its name, packs,
  tracking and `productType`, which the form needs), and the line's own stored values (its description, price,
  discount and VAT rate as they were saved). `productType` is the product's `type` as the database has it;
  `loadVariants()` already reads it for the stock documents.
- **`withVariants()`** loads the variants of a document's lines in one query. The `flatMap` only satisfies the
  `Map`'s `undefined`: the line's foreign key keeps the variant while the line exists.

### `sales/price-lookup.service.ts` (new): the price a line starts with

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { PriceLookup, PriceLookupInput, PriceLookupItem } from '@omnivo/contracts';
import { parties, priceLists } from '@omnivo/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { pricesIncludeVatNow } from './sales-lines.js';

const rowSchema = z.object({
  variant_id: z.uuid(),
  unit_id: z.uuid(),
  list_price: z.string().nullable(),
  product_price: z.string().nullable(),
  tax_rate_id: z.uuid().nullable(),
});

// The price and VAT rate a new sales line starts with (step 15b). The person may change both on
// the line: this is only where they start.
//   price     the customer's price list, if it is active and has this variant in this unit (15a);
//             else the variant's own sale price (per base unit) × the unit's factor;
//             else none (null): the person types it
//   VAT rate  the product's own rate if it is active, else the workspace default
@Injectable()
export class PriceLookupService {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  lookup(input: PriceLookupInput): Promise<PriceLookup> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const pricesIncludeVat = await pricesIncludeVatNow(tx);
      // The customer's list, only while it is active: an archived list falls back to the products'
      // own prices, as 15a promised. Another workspace's customer (or none) has no list.
      const [customer] =
        input.customerId === null
          ? []
          : await tx
              .select({ priceListId: priceLists.id })
              .from(parties)
              .innerJoin(
                priceLists,
                and(
                  eq(priceLists.tenantId, parties.tenantId),
                  eq(priceLists.id, parties.priceListId),
                ),
              )
              .where(
                and(
                  eq(parties.tenantId, tenantId),
                  eq(parties.id, input.customerId),
                  isNull(priceLists.archivedAt),
                ),
              );
      const priceListId = customer?.priceListId ?? null;

      // One query for every item, in the order they were asked for (ord). A unit that is neither
      // the base unit nor a pack of the product drops out, like an unknown variant. The product's
      // price is worked out in Postgres: a factor has 6 decimals (a yard is 0.914400 m), and NUMERIC
      // multiplies it exactly before rounding to the 4 decimals a price keeps.
      const wanted = sql.join(
        input.items.map(
          (item, index) => sql`(${index}::int, ${item.variantId}::uuid, ${item.unitId}::uuid)`,
        ),
        sql`, `,
      );
      const rows = z.array(rowSchema).parse(
        await tx.execute(sql`
          WITH wanted(ord, variant_id, unit_id) AS (VALUES ${wanted})
          SELECT w.variant_id::text AS variant_id, w.unit_id::text AS unit_id,
                 round(pli.price, 4)::text AS list_price,
                 round(v.sale_price * CASE WHEN w.unit_id = p.base_unit_id THEN 1 ELSE pu.factor END,
                       4)::text AS product_price,
                 coalesce(own.id, d.id)::text AS tax_rate_id
            FROM wanted w
            JOIN product_variants v ON v.tenant_id = ${tenantId}::uuid AND v.id = w.variant_id
            JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
            LEFT JOIN product_units pu
              ON pu.tenant_id = p.tenant_id AND pu.product_id = p.id AND pu.unit_id = w.unit_id
            LEFT JOIN price_list_items pli
              ON pli.tenant_id = v.tenant_id AND pli.price_list_id = ${priceListId}::uuid
             AND pli.variant_id = v.id AND pli.unit_id = w.unit_id
            LEFT JOIN tax_rates own
              ON own.tenant_id = p.tenant_id AND own.id = p.tax_rate_id AND own.archived_at IS NULL
            LEFT JOIN tax_rates d ON d.tenant_id = v.tenant_id AND d.is_default
           WHERE w.unit_id = p.base_unit_id OR pu.unit_id IS NOT NULL
           ORDER BY w.ord`),
      );

      const items = rows.flatMap((row): PriceLookupItem[] => {
        // No rate at all: a workspace whose setup job has not made its rates yet
        if (row.tax_rate_id === null) return [];
        const price = row.list_price ?? row.product_price;
        return [
          {
            variantId: row.variant_id,
            unitId: row.unit_id,
            price,
            source: row.list_price !== null ? 'price_list' : price === null ? null : 'product',
            taxRateId: row.tax_rate_id,
          },
        ];
      });
      return { pricesIncludeVat, items };
    });
  }
}
```

- **Only an active price list.** The customer's list is joined with `archived_at IS NULL`. An archived list falls
  back to the products' own prices, as 15a promised. A `customerId` of another workspace finds no row, so it
  gets the products' prices too; the answer reveals nothing about the other workspace.
- **One query for all items.** A form may ask for 300 items. The items go in as a `VALUES` list with their
  position (`ord`), and the answer comes back in that order. `sql.join` builds the list with parameters, never
  with string concatenation.
- **The product's price is multiplied in Postgres.** The sale price is per base unit; a carton of 24 costs
  24 × the price. A pack's factor has 6 decimals (a yard is 0.914400 m), and the contract's money functions take
  at most 4. `NUMERIC` multiplies exactly, and `round(…, 4)` keeps the 4 decimals a price column has.
- **A unit that does not belong to the product drops out**, like an unknown variant (`WHERE w.unit_id =
  p.base_unit_id OR pu.unit_id IS NOT NULL`). The contract says so: an item that is not a variant and unit of this
  workspace is left out.
- **The VAT rate:** the product's own rate if it is active, else the workspace default. A workspace always has a
  default (15a: the default cannot be archived or unset), except for a moment while the setup job makes the
  rates; such an item is left out instead of sending an invalid id.
- **`source`** tells the form where the price came from, so it can say "From the price list" under the box.

### `sales/quotations.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type PartyRef,
  type Quotation,
  type QuotationInput,
  type QuotationStatus,
  type QuotationSummary,
  type UpdateQuotationInput,
} from '@omnivo/contracts';
import { parties, quotationLines, quotations, salesOrders } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertCustomer,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type QuotationRow = typeof quotations.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM quotation_lines l
   WHERE l.tenant_id = quotations.tenant_id AND l.quotation_id = quotations.id
)`;

function notOpen(): AppError {
  return new AppError(
    409,
    'quotation_not_open',
    'The customer has answered this quotation, so it stays as it is. Write a new one.',
  );
}

function toSummary(row: QuotationRow, customer: PartyRef, lines: number): QuotationSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    validUntil: row.validUntil,
    customer,
    status: row.status,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit log shows of a quotation: what a person recognises, not ids or every line
function snapshot(row: QuotationRow, customer: PartyRef, lines: number) {
  return {
    number: row.number,
    date: row.date,
    validUntil: row.validUntil,
    customer: customer.code,
    total: row.total,
    lines,
  };
}
```

- **`lineCount` names the table in plain SQL**, like the stock documents' line count. Inside the subquery a bare
  `id` would be the line's own column.
- **`snapshot()`** is what the audit log shows: the number, the dates, the customer's code, the total and the
  number of lines. Not every line: an audit row of 300 lines would be unreadable, and the document itself keeps
  them.

```ts
@Injectable()
export class QuotationsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: QuotationStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: QuotationSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(quotations.status, query.status),
          query.customerId === undefined ? undefined : eq(quotations.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${quotations.date}, ${quotations.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.quotation.date, last.quotation.id]);
      return {
        items: page.items.map((row) => toSummary(row.quotation, row.customer, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Quotation> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: QuotationInput): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      const pricesIncludeVat = await pricesIncludeVatNow(tx);
      const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
      // Numbered at once: a quotation moves nothing, and the customer quotes its number back. A
      // deleted open quotation leaves a gap, which is fine for an offer.
      const number = await this.numbering.next(tx, 'sales.quotation', input.date);
      const [row] = await tx
        .insert(quotations)
        .values({
          tenantId: getTenantId(),
          number,
          date: input.date,
          validUntil: input.validUntil,
          customerId: customer.id,
          pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Quotation insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'quotation.created',
        entityType: 'quotation',
        entityId: row.id,
        changes: created(snapshot(row, customer, lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateQuotationInput): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      // The quotation keeps the setting it was written with: its prices were typed that way
      const lines = await resolveSalesLines(
        tx,
        input.lines,
        before.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const [updated] = await tx
        .update(quotations)
        .set({
          date: input.date,
          validUntil: input.validUntil,
          customerId: customer.id,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${quotations.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)))
        .returning();
      if (!updated) throw notFound('Quotation');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'quotation.updated',
        entityType: 'quotation',
        entityId: id,
        changes: diff(
          snapshot(before, customerBefore, linesBefore.length),
          snapshot(updated, customer, lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockOpen(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(quotations)
        .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)));
      await audit(tx, {
        action: 'quotation.deleted',
        entityType: 'quotation',
        entityId: id,
        changes: diff(snapshot(before, customer, lines.length), {
          number: null,
          date: null,
          validUntil: null,
          customer: null,
          total: null,
          lines: null,
        }),
      });
    });
  }

  // The customer said no. Kept, not deleted: what was offered, and when, is worth knowing.
  decline(id: string, version: number): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      await this.lockOpen(tx, id, version);
      await this.setStatus(tx, id, 'declined');
      await audit(tx, { action: 'quotation.declined', entityType: 'quotation', entityId: id });
      return this.read(tx, id);
    });
  }

  // The customer came back after all. Only a declined quotation: an accepted one has its order.
  reopen(id: string, version: number): Promise<Quotation> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'declined') {
        throw new AppError(
          409,
          'quotation_not_declined',
          'Only a declined quotation can be opened again.',
        );
      }
      await this.setStatus(tx, id, 'open');
      await audit(tx, { action: 'quotation.reopened', entityType: 'quotation', entityId: id });
      return this.read(tx, id);
    });
  }
```

- **Numbered on create.** `numbering.next(tx, 'sales.quotation', date)` runs inside the same transaction as the
  insert. If anything after it fails, the number is rolled back with everything else. Deleting an open quotation
  leaves a gap in the QT numbers; for an offer that is fine (a posted delivery never leaves one: it is numbered
  when posted, and never deleted).
- **The update keeps `pricesIncludeVat`.** The quotation's prices were typed with the setting it was written
  with. Passing `before.pricesIncludeVat` to `resolveSalesLines()` means the same ৳115 keeps meaning the same,
  even if the owner changed the workspace setting since.
- **`lockOpen()`** locks the row `FOR UPDATE`, then checks the version and the status. Two saves of one
  quotation take turns, and a save and an order made from the quotation take turns (the order locks the
  quotation the same way). Only an open quotation is changed, deleted or declined: `quotation_not_open`.
- **The audit `diff()` on delete** compares the snapshot with all `null`, the way every step logs a delete: the log
  shows what was there.
- **`decline` and `reopen`** change only the status. Migration 0028 allows exactly that on an answered quotation
  (`open` again, or the same status). `reopen` accepts only a declined quotation: an accepted one has its order,
  and reopening it would let a second order accept it too.

```ts
  private async setStatus(tx: Transaction, id: string, status: QuotationStatus): Promise<void> {
    await tx
      .update(quotations)
      .set({
        status,
        version: sql`${quotations.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)));
  }

  private async writeLines(
    tx: Transaction,
    quotationId: string,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    await tx
      .delete(quotationLines)
      .where(
        and(
          eq(quotationLines.tenantId, getTenantId()),
          eq(quotationLines.quotationId, quotationId),
        ),
      );
    await tx
      .insert(quotationLines)
      .values(lines.map((line, index) => ({ ...salesLineValues(line, index), quotationId })));
  }

  // FOR UPDATE: two saves of one quotation, or a save and an order made from it, take turns
  private async lock(tx: Transaction, id: string, version: number): Promise<QuotationRow> {
    const [row] = await tx
      .select()
      .from(quotations)
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, id)))
      .for('update');
    if (!row) throw notFound('Quotation');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockOpen(tx: Transaction, id: string, version: number): Promise<QuotationRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'open') throw notOpen();
    return row;
  }

  private linesOf(tx: Transaction, quotationId: string) {
    return tx
      .select()
      .from(quotationLines)
      .where(
        and(
          eq(quotationLines.tenantId, getTenantId()),
          eq(quotationLines.quotationId, quotationId),
        ),
      )
      .orderBy(asc(quotationLines.lineNo));
  }

  // The quotations with their customers and line counts, newest first
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        quotation: quotations,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(quotations)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, quotations.tenantId), eq(parties.id, quotations.customerId)),
      )
      .where(and(eq(quotations.tenantId, getTenantId()), where))
      .orderBy(desc(quotations.date), desc(quotations.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Quotation> {
    const [found] = await this.rows(tx, eq(quotations.id, id), 1);
    if (!found) throw notFound('Quotation');
    const { quotation: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // The order made from it (sales_orders_quotation_idx: one at most)
    const [order] = await tx
      .select({ id: salesOrders.id, number: salesOrders.number })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.quotationId, id)));
    return {
      ...toSummary(row, found.customer, found.lineCount),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => toSalesLine(line, variant)),
      order: order ?? null,
    };
  }

  // The customer a quotation has, as the audit log names it. The FK keeps it.
  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }
}
```

- **`writeLines()` deletes and inserts.** Lines have no identity the person cares about; a save replaces them, the
  same as the stock documents. The quotation is open here, so 0028's line trigger lets it through.
- **`read()` finds the order through `sales_orders.quotation_id`.** The unique index `sales_orders_quotation_idx`
  allows one at most, so the first row is the only one.

### `sales/sales-orders.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type OrderStatus,
  type PartyRef,
  type SalesOrder,
  type SalesOrderInput,
  type SalesOrderSummary,
  type UpdateSalesOrderInput,
} from '@omnivo/contracts';
import {
  deliveries,
  parties,
  quotations,
  salesOrderLines,
  salesOrders,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertWarehousesActive } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertCustomer,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  shippingAddressOf,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type OrderRow = typeof salesOrders.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside these subqueries a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM sales_order_lines l
   WHERE l.tenant_id = sales_orders.tenant_id AND l.order_id = sales_orders.id
)`;

// Confirmed, and a posted delivery has taken something. A service line never counts: it stays at 0.
const partlyDelivered = sql<boolean>`(sales_orders.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM sales_order_lines l
   WHERE l.tenant_id = sales_orders.tenant_id AND l.order_id = sales_orders.id
     AND l.delivered_quantity > 0
))`;

function notDraft(): AppError {
  return new AppError(
    409,
    'sales_not_draft',
    'Only a draft order can be changed. Reopen it first, if nothing was delivered.',
  );
}

function notConfirmed(): AppError {
  return new AppError(409, 'order_not_confirmed', 'This order is not waiting for deliveries.');
}

function toSummary(
  row: OrderRow,
  customer: PartyRef,
  lines: number,
  partly: boolean,
): SalesOrderSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    deliveryDate: row.deliveryDate,
    customer,
    customerReference: row.customerReference,
    warehouseId: row.warehouseId,
    status: row.status,
    partlyDelivered: partly,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

- **`partlyDelivered`** is worked out in the list query: a confirmed order with any line whose
  `delivered_quantity` is above zero. Service lines stay at zero, so they never make an order look delivered.

```ts
@Injectable()
export class SalesOrdersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: OrderStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: SalesOrderSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(salesOrders.status, query.status),
          query.customerId === undefined ? undefined : eq(salesOrders.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${salesOrders.date}, ${salesOrders.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.order.date, last.order.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.order, row.customer, row.lineCount, row.partlyDelivered),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SalesOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: SalesOrderInput): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const quotation =
        input.quotationId === null
          ? null
          : await this.openQuotation(tx, input.quotationId, customer);
      // An order made from a quotation reads its prices the way the quotation did: the form copied
      // them from there. Otherwise the workspace setting now.
      const pricesIncludeVat = quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
      const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
      const [row] = await tx
        .insert(salesOrders)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          deliveryDate: input.deliveryDate,
          customerId: customer.id,
          customerReference: input.customerReference,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          quotationId: quotation?.id ?? null,
          pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Sales order insert returned no row');
      await this.writeLines(tx, row.id, lines);
      // The customer said yes: the quotation is accepted by the order made from it. No audit row
      // of its own: this one names it.
      if (quotation !== null) await this.setQuotationStatus(tx, quotation.id, 'accepted');
      await audit(tx, {
        action: 'sales_order.created',
        entityType: 'sales_order',
        entityId: row.id,
        changes: created({
          ...(await this.snapshot(tx, row, customer, lines.length)),
          quotation: quotation?.number ?? null,
        }),
      });
      if (input.confirm) await this.confirmAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateSalesOrderInput): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      // A reopened order keeps its customer: its number was given to this customer, and a
      // quotation of this customer may point at it
      if (before.number !== null || before.quotationId !== null) {
        if (customer.id !== before.customerId) {
          throw new AppError(
            409,
            'sales_customer_invalid',
            'This order belongs to its customer. Write a new order for another one.',
            { fieldErrors: { customerId: ['sales_customer_invalid'] } },
          );
        }
      }
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveSalesLines(
        tx,
        input.lines,
        before.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const [updated] = await tx
        .update(salesOrders)
        .set({
          date: input.date,
          deliveryDate: input.deliveryDate,
          customerId: customer.id,
          customerReference: input.customerReference,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${salesOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)))
        .returning();
      if (!updated) throw notFound('Sales order');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'sales_order.updated',
        entityType: 'sales_order',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, customerBefore, linesBefore.length),
          await this.snapshot(tx, updated, customer, lines.length),
        ),
      });
      if (input.confirm) await this.confirmAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  // Only a draft that never had a number: one the customer was told about is cancelled instead,
  // so its number never disappears (the database refuses it too: sales_orders_numbered_immutable)
  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      if (before.number !== null) {
        throw new AppError(
          409,
          'order_numbered',
          'This order has a number. Confirm it and cancel it instead.',
        );
      }
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(salesOrders)
        .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)));
      // Its quotation waits for an answer again: the order that accepted it is gone
      if (before.quotationId !== null) {
        await this.setQuotationStatus(tx, before.quotationId, 'open');
      }
      const snapshot = await this.snapshot(tx, before, customer, lines.length);
      await audit(tx, {
        action: 'sales_order.deleted',
        entityType: 'sales_order',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }
```

- **An order from a quotation takes the quotation's `pricesIncludeVat`.** "Make order" on the quotation's page
  copies its lines and prices into the form. Those prices were typed for the quotation's setting, so the order
  must read them the same way. An order from nothing takes the workspace setting now.
- **Accepting is part of creating.** `setQuotationStatus(…, 'accepted')` runs in the same transaction as the
  insert. The `sales_order.created` audit row names the quotation's number; there is no separate
  `quotation.accepted` row (15b.1).
- **`confirm: true`** saves and confirms in one transaction: the "Confirm" button on a new order. If confirming
  fails, the save is rolled back too, so the person never ends up with half of what they asked for.
- **A reopened order, or one made from a quotation, keeps its customer.** Its number was given to this customer,
  and its quotation belongs to this customer. Changing the customer would break both, so `update` refuses it with
  `sales_customer_invalid`. A plain new draft may still change customers.
- **`remove` refuses a numbered draft with `order_numbered`.** A reopened order has a number the customer was
  told. Deleting it would make the number disappear from the books' paper trail, so the person confirms it again
  and cancels it. The database refuses it too (`sales_orders_numbered_immutable`, 15b.2); the API answers first,
  with a message that says which buttons to use.
- **Deleting a draft puts its quotation back to `open`.** The order that accepted it is gone, so the quotation
  waits for an answer again. 0028 allows accepted → open.

```ts
  confirm(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.confirmAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // Back to draft, to be changed: only while no delivery points at it, not even a draft one (its
  // lines point at the order's lines, which a save replaces). The number stays.
  reopen(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      const [delivery] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.orderId, id)))
        .limit(1);
      if (delivery) {
        throw new AppError(
          409,
          'order_has_deliveries',
          'Deliveries were made for this order. Close it and write a new order instead.',
        );
      }
      // The check sales_orders_confirmed_check: a draft has no confirmation
      await this.write(tx, id, { status: 'draft', confirmedAt: null, confirmedBy: null });
      await audit(tx, { action: 'sales_order.reopened', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }

  // Partly delivered, and the rest will not be: the customer took what there was
  close(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      if (!(await this.anythingDelivered(tx, id))) {
        throw new AppError(
          409,
          'order_nothing_delivered',
          'Nothing was delivered for this order. Cancel it instead.',
        );
      }
      await this.write(tx, id, { status: 'closed' });
      await audit(tx, { action: 'sales_order.closed', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }

  // Called off before anything left the warehouse
  cancel(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      if (await this.anythingDelivered(tx, id)) {
        throw new AppError(
          409,
          'order_partly_delivered',
          'Some of this order was delivered. Close it instead.',
        );
      }
      await this.write(tx, id, { status: 'cancelled' });
      await audit(tx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }
```

- **`reopen` checks for any delivery, drafts included.** A draft delivery's lines point at the order's lines, and a
  save of the reopened order replaces those lines. The foreign key would refuse that with a database error;
  `order_has_deliveries` says it in words. The order is locked `FOR UPDATE`, and every delivery write locks the
  order too, so a delivery cannot appear between the check and the commit.
- **`confirmedAt: null, confirmedBy: null` on reopen.** The check `sales_orders_confirmed_check` says a draft has
  no confirmation time. The number stays.
- **`close` and `cancel` are two buttons with two rules.** "Close" needs something delivered
  (`order_nothing_delivered` otherwise): it ends a partly delivered order. "Cancel" needs nothing delivered
  (`order_partly_delivered` otherwise). Each refusal names the other button.
- **Draft deliveries of a closed or cancelled order stay.** They are not deleted for the person; posting one is
  refused with `order_not_confirmed`, and the person deletes it or removes the order from it.

```ts
  // The number the first time; a reopened order confirms again with the number it already has
  private async confirmAndLog(tx: Transaction, draft: OrderRow): Promise<void> {
    const number = draft.number ?? (await this.numbering.next(tx, 'sales.order', draft.date));
    await this.write(tx, draft.id, {
      status: 'confirmed',
      number,
      confirmedAt: new Date(),
      confirmedBy: currentPrincipal().userId,
    });
    await audit(tx, {
      action: 'sales_order.confirmed',
      entityType: 'sales_order',
      entityId: draft.id,
      changes: created({ number }),
    });
  }

  // The quotation an order is made from: this customer's, and still waiting for an answer. FOR
  // UPDATE: two orders made from it at once take turns, and the second finds it accepted.
  private async openQuotation(tx: Transaction, quotationId: string, customer: PartyRef) {
    const [row] = await tx
      .select({
        id: quotations.id,
        number: quotations.number,
        customerId: quotations.customerId,
        status: quotations.status,
        pricesIncludeVat: quotations.pricesIncludeVat,
      })
      .from(quotations)
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, quotationId)))
      .for('update');
    if (row?.customerId !== customer.id) {
      throw new AppError(
        409,
        'order_quotation_invalid',
        'This quotation is for another customer. Make the order from that customer’s quotation.',
        { fieldErrors: { quotationId: ['order_quotation_invalid'] } },
      );
    }
    if (row.status !== 'open') {
      throw new AppError(
        409,
        'quotation_not_open',
        'The customer has already answered this quotation.',
      );
    }
    return row;
  }

  // accepted ⇄ open: the only change migration 0028 lets through on an answered quotation
  private async setQuotationStatus(
    tx: Transaction,
    quotationId: string,
    status: 'open' | 'accepted',
  ): Promise<void> {
    await tx
      .update(quotations)
      .set({
        status,
        version: sql`${quotations.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, quotationId)));
  }

  private async anythingDelivered(tx: Transaction, orderId: string): Promise<boolean> {
    const [line] = await tx
      .select({ id: salesOrderLines.id })
      .from(salesOrderLines)
      .where(
        and(
          eq(salesOrderLines.tenantId, getTenantId()),
          eq(salesOrderLines.orderId, orderId),
          sql`${salesOrderLines.deliveredQuantity} > 0`,
        ),
      )
      .limit(1);
    return line !== undefined;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<OrderRow, 'status' | 'number' | 'confirmedAt' | 'confirmedBy'>>,
  ): Promise<void> {
    await tx
      .update(salesOrders)
      .set({
        ...fields,
        version: sql`${salesOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)));
  }

  private async writeLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    await tx
      .delete(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)),
      );
    await tx
      .insert(salesOrderLines)
      .values(lines.map((line, index) => ({ ...salesLineValues(line, index), orderId })));
  }

  // FOR UPDATE: every change to an order takes turns with the others, and with a delivery being
  // posted against it (DeliveriesService locks the order the same way)
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [row] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)))
      .for('update');
    if (!row) throw notFound('Sales order');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }

  private linesOf(tx: Transaction, orderId: string) {
    return tx
      .select()
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)))
      .orderBy(asc(salesOrderLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        order: salesOrders,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
        partlyDelivered,
      })
      .from(salesOrders)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, salesOrders.tenantId), eq(parties.id, salesOrders.customerId)),
      )
      .where(and(eq(salesOrders.tenantId, getTenantId()), where))
      .orderBy(desc(salesOrders.date), desc(salesOrders.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<SalesOrder> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(salesOrders.id, id), 1);
    if (!found) throw notFound('Sales order');
    const { order: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const [quotation] =
      row.quotationId === null
        ? []
        : await tx
            .select({ id: quotations.id, number: quotations.number })
            .from(quotations)
            .where(and(eq(quotations.tenantId, tenantId), eq(quotations.id, row.quotationId)));
    const made = await tx
      .select({
        id: deliveries.id,
        number: deliveries.number,
        date: deliveries.date,
        status: deliveries.status,
      })
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, tenantId), eq(deliveries.orderId, id)))
      .orderBy(asc(deliveries.date), asc(deliveries.id));
    return {
      ...toSummary(row, found.customer, found.lineCount, found.partlyDelivered),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      shippingAddressId: row.shippingAddressId,
      shippingAddress: row.shippingAddress,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        deliveredQuantity: line.deliveredQuantity,
      })),
      quotation: quotation ?? null,
      deliveries: made,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: OrderRow, customer: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      number: row.number,
      date: row.date,
      deliveryDate: row.deliveryDate,
      customer: customer.code,
      customerReference: row.customerReference,
      warehouse: warehouse?.code ?? null,
      total: row.total,
      lines,
    };
  }
}
```

- **`confirmAndLog()` reuses the number of a reopened order** (`draft.number ?? numbering.next(…)`). Only the
  first confirmation takes a number, so SO numbers have no gaps from reopening.
- **`openQuotation()` locks the quotation `FOR UPDATE`.** Two people making an order from the same quotation at
  the same time take turns; the second finds it accepted and gets `quotation_not_open`. Without the lock both
  would pass the check, and the second insert would fail on the unique index with a 500. A quotation of another
  customer gets `order_quotation_invalid` under `quotationId`.
- **`lock()` comments the lock order.** An order is locked by its own actions and by every delivery write. A
  delivery always locks itself first and the order second, so two transactions never wait for each other in a
  circle.

### `sales/deliveries.service.ts` (new)

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type Delivery,
  type DeliveryInput,
  type DeliverySummary,
  type PartyRef,
  type StockDocumentStatus,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  type UpdateDeliveryInput,
} from '@omnivo/contracts';
import {
  deliveries,
  deliveryLines,
  parties,
  products,
  salesOrderLines,
  salesOrders,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from '../inventory/stock-lines.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { assertCustomer, customerRefs, shippingAddressOf } from './sales-lines.js';

type DeliveryRow = typeof deliveries.$inferSelect;
type LineRow = typeof deliveryLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id
)`;

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. What comes back from a posted delivery is a return.',
  );
}

function toSummary(
  row: DeliveryRow,
  customer: PartyRef,
  order: { id: string; number: string | null } | null,
  lines: number,
): DeliverySummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    order,
    warehouseId: row.warehouseId,
    status: row.status,
    shippingAddress: row.shippingAddress,
    vehicle: row.vehicle,
    note: row.note,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as resolveLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
  };
}

// The order a delivery takes goods against, as far as the delivery needs it
interface OrderInfo {
  id: string;
  number: string | null;
}
```

- **`stock_not_draft`, not a new code.** A delivery is a stock document, and the stock pages already have this
  code and its message. The detail text says what to do instead: a return (15d).
- **`storedInput()`** turns a stored line back into what `resolveLines()` takes, so posting checks the lines again
  against their products as they are now (a pack may have been resized since the draft was saved).

```ts
@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
    private readonly access: ValueAccess,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    customerId?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: DeliverySummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(deliveries.status, query.status),
          query.customerId === undefined ? undefined : eq(deliveries.customerId, query.customerId),
          query.warehouseId === undefined
            ? undefined
            : eq(deliveries.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${deliveries.date}, ${deliveries.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.delivery.date, last.delivery.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.delivery, row.customer, row.order, row.lineCount),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Delivery> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: DeliveryInput): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const order =
        input.orderId === null ? null : await this.lockOrder(tx, input.orderId, customer.id);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveLines(tx, input.lines, 'out');
      const orderLineIds = input.lines.map((line) => line.orderLineId);
      if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);
      const [row] = await tx
        .insert(deliveries)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          customerId: customer.id,
          orderId: order?.id ?? null,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          vehicle: input.vehicle,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Delivery insert returned no row');
      await this.writeLines(tx, row.id, lines, orderLineIds);
      await audit(tx, {
        action: 'delivery.created',
        entityType: 'delivery',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, customer, order, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateDeliveryInput): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const orderBefore = await this.orderRef(tx, before.orderId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const order =
        input.orderId === null ? null : await this.lockOrder(tx, input.orderId, customer.id);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveLines(tx, input.lines, 'out');
      const orderLineIds = input.lines.map((line) => line.orderLineId);
      if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);
      const [updated] = await tx
        .update(deliveries)
        .set({
          date: input.date,
          customerId: customer.id,
          orderId: order?.id ?? null,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          vehicle: input.vehicle,
          note: input.note,
          version: sql`${deliveries.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)))
        .returning();
      if (!updated) throw notFound('Delivery');
      await this.writeLines(tx, id, lines, orderLineIds);
      await audit(tx, {
        action: 'delivery.updated',
        entityType: 'delivery',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, customerBefore, orderBefore, linesBefore.length),
          await this.snapshot(tx, updated, customer, order, lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      const order = await this.orderRef(tx, before.orderId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(deliveries)
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)));
      const snapshot = await this.snapshot(tx, before, customer, order, lines.length);
      await audit(tx, {
        action: 'delivery.deleted',
        entityType: 'delivery',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, version: number): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }
```

- **Create and update check in a fixed order:** customer, warehouse, order, address, lines, then the order lines.
  Each check that fails throws, and the transaction rolls back.
- **`resolveLines(tx, lines, 'out')`** is step 13's function. It refuses a service (`stock_variant_invalid`),
  checks batches and serial numbers, and lets archived goods leave. A delivery needs nothing else from its lines.
- **The order lines are checked on every save, not only at posting.** The person learns early that line 3
  delivers more than the order has left. Drafts hold nothing, so two drafts may each look fine; posting checks
  again under the order's lock.

```ts
  // A draft out of the warehouse, like a stock adjustment "out": the date and the warehouse
  // checked, the lines checked again against their products and (for an order) against what the
  // order still has to deliver, the number taken, the stock moved at its average cost, and the
  // cost of goods sold booked — all in the caller's transaction, so a refused line leaves nothing
  // posted and no number used.
  private async postAndLog(tx: Transaction, draft: DeliveryRow): Promise<void> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    // Locked before anything moves: two deliveries of one order post one after the other, and the
    // second sees what the first delivered. A close or cancel waits for us too.
    const order =
      draft.orderId === null ? null : await this.lockOrder(tx, draft.orderId, draft.customerId);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), 'out', { lock: true });
    const orderLineIds = stored.map((line) => line.orderLineId);
    if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);

    const number = await this.numbering.next(tx, 'sales.delivery', draft.date);
    const values = await this.posting.post(tx, {
      date: draft.date,
      kind: 'delivery',
      direction: 'out',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        variant: line.variant,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    });
    // Still a draft here: the lines may change, and take their values
    await this.writeLines(tx, draft.id, lines, orderLineIds, values);
    await tx
      .update(deliveries)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${deliveries.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, draft.id)));
    if (order !== null) await this.deliverOnOrder(tx, order.id, orderLineIds, lines);
    // The books (you chose this): Dr Cost of goods sold / Cr Inventory, at what the stock cost.
    // The invoice (15c) books the sale itself.
    const entry = await this.books.delivery(
      tx,
      { id: draft.id, number, date: draft.date },
      { warehouseId: draft.warehouseId, value: sumMoney(values) },
    );
    await audit(tx, {
      action: 'delivery.posted',
      entityType: 'delivery',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }
```

- **The same steps as an adjustment "out":** the date (open period, not in the future), the warehouse, the lines
  again with `{ lock: true }` (the products `FOR SHARE`), the number, `posting.post()`, the lines rewritten with
  their values, the status. All in the caller's transaction: a refused line leaves no movement, no number and no
  entry behind.
- **The order is locked before any stock moves.** Two deliveries of one order posting at the same time take turns;
  the second one sees what the first delivered and is refused if it would go over. A close or a cancel of the
  order waits too.
- **No value is handed in.** A move out always goes at the average cost; `posting.post()` works it out and returns
  each line's value (step 14). The lines keep them, and the entry books their sum.
- **`books.delivery()`** writes Dr Cost of goods sold / Cr Inventory (decision 1). The invoice of 15c books only
  the sale: the receivable, the sales account and the VAT. Goods that cost nothing in the books make no entry
  (`write()` returns `null`), like every stock document.

```ts
  // The order of a delivery: this customer's, and confirmed (waiting for deliveries). FOR UPDATE,
  // in every write of a delivery: a reopen of the order waits and then sees the delivery, and two
  // deliveries posting against one order take turns. The lock is always taken after the
  // delivery's own (lockDraft), never before, so two of these never wait for each other in a circle.
  private async lockOrder(
    tx: Transaction,
    orderId: string,
    customerId: string,
  ): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: salesOrders.id,
        number: salesOrders.number,
        customerId: salesOrders.customerId,
        status: salesOrders.status,
      })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, orderId)))
      .for('update');
    if (row?.customerId !== customerId) {
      throw new AppError(
        409,
        'delivery_order_invalid',
        'Pick a confirmed order of this customer, or deliver without an order.',
        { fieldErrors: { orderId: ['delivery_order_invalid'] } },
      );
    }
    if (row.status !== 'confirmed') {
      throw new AppError(
        409,
        'order_not_confirmed',
        'This order is not waiting for deliveries any more.',
        { fieldErrors: { orderId: ['order_not_confirmed'] } },
      );
    }
    return { id: row.id, number: row.number };
  }

  // Each line delivers a line of this order, of the same variant (in any of its units), and all
  // the lines together never deliver more than an order line still has to: ordered − delivered by
  // posted deliveries. Two lines may share an order line (two batches). Drafts hold nothing, so
  // two drafts may each take the whole rest; the second one to post is refused here.
  private async checkOrderLines(
    tx: Transaction,
    orderId: string,
    orderLineIds: readonly (string | null)[],
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const rows = await tx
      .select({
        id: salesOrderLines.id,
        variantId: salesOrderLines.variantId,
        baseQuantity: salesOrderLines.baseQuantity,
        deliveredQuantity: salesOrderLines.deliveredQuantity,
      })
      .from(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)),
      );
    const orderLines = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    const taken = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLineId = orderLineIds[index] ?? null;
      const orderLine = orderLineId === null ? undefined : orderLines.get(orderLineId);
      if (orderLineId === null) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'delivery_order_line_required' });
      } else if (orderLine?.variantId !== line.variant.variantId) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'delivery_order_line_invalid' });
      } else {
        taken.set(orderLineId, [...(taken.get(orderLineId) ?? []), line.baseQuantity]);
      }
    });
    for (const [orderLineId, quantities] of taken) {
      const orderLine = orderLines.get(orderLineId);
      if (!orderLine) continue;
      const left = subtractQuantity(orderLine.baseQuantity, orderLine.deliveredQuantity);
      if (compareQuantity(sumQuantity(quantities), left) <= 0) continue;
      // Under every line that takes from it: the person decides which one to cut
      orderLineIds.forEach((id, index) => {
        if (id === orderLineId) {
          issues.push({ path: linePath(index, 'quantity'), code: 'delivery_over_order' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
  }

  // What the posted lines delivered, onto their order lines; and when every goods line has all it
  // ordered, the order is delivered. The lines first: migration 0028 lets delivered_quantity change
  // only while the order is confirmed. A service line is never delivered and does not count.
  private async deliverOnOrder(
    tx: Transaction,
    orderId: string,
    orderLineIds: readonly (string | null)[],
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLineId = orderLineIds[index] ?? null;
      if (orderLineId === null) return;
      byOrderLine.set(orderLineId, [...(byOrderLine.get(orderLineId) ?? []), line.baseQuantity]);
    });
    for (const [orderLineId, quantities] of byOrderLine) {
      await tx
        .update(salesOrderLines)
        .set({
          deliveredQuantity: sql`${salesOrderLines.deliveredQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.id, orderLineId)));
    }
    const [open] = await tx
      .select({ id: salesOrderLines.id })
      .from(salesOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrderLines.orderId, orderId),
          eq(products.type, 'goods'),
          sql`${salesOrderLines.deliveredQuantity} < ${salesOrderLines.baseQuantity}`,
        ),
      )
      .limit(1);
    // A new version either way: an order page open somewhere shows old delivered quantities, and
    // its next action (close) must reload first
    await tx
      .update(salesOrders)
      .set({
        ...(open === undefined ? { status: 'delivered' as const } : {}),
        version: sql`${salesOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, orderId)));
  }
```

- **`lockOrder()` refuses an order of another customer with `delivery_order_invalid`.** The database would refuse
  it too: the delivery's FK to the order includes `customer_id` (15b.2). The API answers first, under `orderId`.
- **`checkOrderLines()`** checks three things per line: it points at an order line (`delivery_order_line_required`
  — the contract checks this too, but stored lines are checked again), the order line is of this order and of
  the same variant (`delivery_order_line_invalid`), and all lines together stay within what is left
  (`delivery_over_order`). Quantities are compared in the base unit, so an order for 10 cartons can be delivered
  as 240 pcs. Two lines may share an order line: one batch ran out, the rest came from the next.
- **`delivery_over_order` goes under every line that takes from the same order line.** The person decides which
  one to cut.
- **`deliverOnOrder()` updates the lines first, then the order.** Migration 0028 lets `delivered_quantity` change
  only while the order is confirmed. Setting the order to `delivered` first would freeze the lines and fail.
- **`::numeric` on the added quantity.** The quantity is sent as a text parameter; the cast tells Postgres to add
  it as a number, not to guess its type.
- **"Delivered" means every goods line.** The query joins `products` and looks for a goods line with something
  left. A service line is never delivered (the invoice bills it), so it must not keep the order open forever.
- **The order's version goes up on every posting**, even when it stays confirmed. An order page open in another
  tab shows old delivered quantities; its next "Close" gets `version_conflict` and reloads first.

```ts
  // The lines in the order they were written. values: set when posting has priced them.
  private async writeLines(
    tx: Transaction,
    deliveryId: string,
    lines: readonly ResolvedLine[],
    orderLineIds: readonly (string | null)[],
    values?: readonly string[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), eq(deliveryLines.deliveryId, deliveryId)));
    await tx.insert(deliveryLines).values(
      lines.map((line, index) => ({
        tenantId,
        deliveryId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        orderLineId: orderLineIds[index] ?? null,
        value: values?.[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<DeliveryRow> {
    const [row] = await tx
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)))
      .for('update');
    if (!row) throw notFound('Delivery');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, deliveryId: string) {
    return tx
      .select()
      .from(deliveryLines)
      .where(
        and(eq(deliveryLines.tenantId, getTenantId()), eq(deliveryLines.deliveryId, deliveryId)),
      )
      .orderBy(asc(deliveryLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        delivery: deliveries,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        order: { id: salesOrders.id, number: salesOrders.number },
        lineCount,
      })
      .from(deliveries)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, deliveries.tenantId), eq(parties.id, deliveries.customerId)),
      )
      .leftJoin(
        salesOrders,
        and(eq(salesOrders.tenantId, deliveries.tenantId), eq(salesOrders.id, deliveries.orderId)),
      )
      .where(and(eq(deliveries.tenantId, getTenantId()), where))
      .orderBy(desc(deliveries.date), desc(deliveries.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Delivery> {
    const [found] = await this.rows(tx, eq(deliveries.id, id), 1);
    if (!found) throw notFound('Delivery');
    const { delivery: row } = found;
    const lines = await this.linesOf(tx, id);
    const [canSee, entries, variants, batches] = await Promise.all([
      this.access.canSee(),
      this.books.entriesOf(tx, id),
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
    ]);
    return {
      ...toSummary(row, found.customer, found.order, found.lineCount),
      shippingAddressId: row.shippingAddressId,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            orderLineId: line.orderLineId,
            // Worked out from the books: needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
          },
        ];
      }),
      entry: entries[0] ?? null,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  private async orderRef(tx: Transaction, orderId: string | null): Promise<OrderInfo | null> {
    if (orderId === null) return null;
    const [row] = await tx
      .select({ id: salesOrders.id, number: salesOrders.number })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, orderId)));
    return row ?? null;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(
    tx: Transaction,
    row: DeliveryRow,
    customer: PartyRef,
    order: OrderInfo | null,
    lines: number,
  ) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      customer: customer.code,
      order: order?.number ?? null,
      warehouse: warehouse?.code ?? null,
      vehicle: row.vehicle,
      lines,
    };
  }
}
```

- **`value: canSee ? line.value : null`.** What the goods cost comes from the books, so it needs
  `inventory.stock.value` (step 14), like an adjustment's values. The store keeper who loads the truck sees the
  quantities, not the cost.
- **`order` comes from a `LEFT JOIN`.** A delivery without an order gets `null`; Drizzle types the joined object as
  nullable, so `toSummary()` needs no extra check.

### `sales/sales-documents.controller.ts` (new) and `sales/sales.module.ts`

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../common/http/endpoint.js';
import { DeliveriesService } from './deliveries.service.js';
import { PriceLookupService } from './price-lookup.service.js';
import { QuotationsService } from './quotations.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

type PriceRoutes = typeof routes.salesPrices;
type QuotationRoutes = typeof routes.quotations;
type OrderRoutes = typeof routes.salesOrders;
type DeliveryRoutes = typeof routes.deliveries;

@Controller()
export class SalesPricesController {
  constructor(private readonly prices: PriceLookupService) {}

  @Endpoint(routes.salesPrices.lookup)
  lookup({
    body,
  }: RouteInput<PriceRoutes['lookup']>): Promise<RouteResponse<PriceRoutes['lookup']>> {
    return this.prices.lookup(body);
  }
}

@Controller()
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Endpoint(routes.quotations.list)
  list({
    query,
  }: RouteInput<QuotationRoutes['list']>): Promise<RouteResponse<QuotationRoutes['list']>> {
    return this.quotations.list(query);
  }

  @Endpoint(routes.quotations.get)
  get({
    params,
  }: RouteInput<QuotationRoutes['get']>): Promise<RouteResponse<QuotationRoutes['get']>> {
    return this.quotations.get(params.id);
  }

  @Endpoint(routes.quotations.create)
  create({
    body,
  }: RouteInput<QuotationRoutes['create']>): Promise<RouteResponse<QuotationRoutes['create']>> {
    return this.quotations.create(body);
  }

  @Endpoint(routes.quotations.update)
  update({
    params,
    body,
  }: RouteInput<QuotationRoutes['update']>): Promise<RouteResponse<QuotationRoutes['update']>> {
    return this.quotations.update(params.id, body);
  }

  @Endpoint(routes.quotations.remove)
  remove({ params, query }: RouteInput<QuotationRoutes['remove']>): Promise<void> {
    return this.quotations.remove(params.id, query.version);
  }

  @Endpoint(routes.quotations.decline)
  decline({
    params,
    body,
  }: RouteInput<QuotationRoutes['decline']>): Promise<RouteResponse<QuotationRoutes['decline']>> {
    return this.quotations.decline(params.id, body.version);
  }

  @Endpoint(routes.quotations.reopen)
  reopen({
    params,
    body,
  }: RouteInput<QuotationRoutes['reopen']>): Promise<RouteResponse<QuotationRoutes['reopen']>> {
    return this.quotations.reopen(params.id, body.version);
  }
}

@Controller()
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  @Endpoint(routes.salesOrders.list)
  list({ query }: RouteInput<OrderRoutes['list']>): Promise<RouteResponse<OrderRoutes['list']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.salesOrders.get)
  get({ params }: RouteInput<OrderRoutes['get']>): Promise<RouteResponse<OrderRoutes['get']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.salesOrders.create)
  create({
    body,
  }: RouteInput<OrderRoutes['create']>): Promise<RouteResponse<OrderRoutes['create']>> {
    return this.orders.create(body);
  }

  @Endpoint(routes.salesOrders.update)
  update({
    params,
    body,
  }: RouteInput<OrderRoutes['update']>): Promise<RouteResponse<OrderRoutes['update']>> {
    return this.orders.update(params.id, body);
  }

  @Endpoint(routes.salesOrders.remove)
  remove({ params, query }: RouteInput<OrderRoutes['remove']>): Promise<void> {
    return this.orders.remove(params.id, query.version);
  }

  @Endpoint(routes.salesOrders.confirm)
  confirm({
    params,
    body,
  }: RouteInput<OrderRoutes['confirm']>): Promise<RouteResponse<OrderRoutes['confirm']>> {
    return this.orders.confirm(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.reopen)
  reopen({
    params,
    body,
  }: RouteInput<OrderRoutes['reopen']>): Promise<RouteResponse<OrderRoutes['reopen']>> {
    return this.orders.reopen(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.close)
  close({
    params,
    body,
  }: RouteInput<OrderRoutes['close']>): Promise<RouteResponse<OrderRoutes['close']>> {
    return this.orders.close(params.id, body.version);
  }

  @Endpoint(routes.salesOrders.cancel)
  cancel({
    params,
    body,
  }: RouteInput<OrderRoutes['cancel']>): Promise<RouteResponse<OrderRoutes['cancel']>> {
    return this.orders.cancel(params.id, body.version);
  }
}

@Controller()
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Endpoint(routes.deliveries.list)
  list({
    query,
  }: RouteInput<DeliveryRoutes['list']>): Promise<RouteResponse<DeliveryRoutes['list']>> {
    return this.deliveries.list(query);
  }

  @Endpoint(routes.deliveries.get)
  get({
    params,
  }: RouteInput<DeliveryRoutes['get']>): Promise<RouteResponse<DeliveryRoutes['get']>> {
    return this.deliveries.get(params.id);
  }

  @Endpoint(routes.deliveries.create)
  create({
    body,
  }: RouteInput<DeliveryRoutes['create']>): Promise<RouteResponse<DeliveryRoutes['create']>> {
    return this.deliveries.create(body);
  }

  @Endpoint(routes.deliveries.update)
  update({
    params,
    body,
  }: RouteInput<DeliveryRoutes['update']>): Promise<RouteResponse<DeliveryRoutes['update']>> {
    return this.deliveries.update(params.id, body);
  }

  @Endpoint(routes.deliveries.remove)
  remove({ params, query }: RouteInput<DeliveryRoutes['remove']>): Promise<void> {
    return this.deliveries.remove(params.id, query.version);
  }

  @Endpoint(routes.deliveries.post)
  post({
    params,
    body,
  }: RouteInput<DeliveryRoutes['post']>): Promise<RouteResponse<DeliveryRoutes['post']>> {
    return this.deliveries.post(params.id, body.version);
  }
}
```

- **One controller per route group, all thin.** Each method takes what `@Endpoint` parsed with the contract's
  schemas and calls the service. The permission (`sales.quotation.manage`, …) is in the contract's route, and
  the global `PermissionGuard` checks it from there, so there is no guard to forget here. `contract.spec.ts` fails if a route of the contract
  has no controller method.

```diff
@@ -1,5 +1,6 @@
 import { Module } from '@nestjs/common';
 
+import { InventoryModule } from '../inventory/inventory.module.js';
 import { JournalModule } from '../journal/journal.module.js';
 import { NumberingModule } from '../numbering/numbering.module.js';
 import { RbacModule } from '../rbac/rbac.module.js';
@@ -7,16 +8,45 @@ import { BalanceAccess } from './balance-access.js';
 import { CustomerGroupsService } from './customer-groups.service.js';
 import { CustomerGroupsController, CustomersController } from './customers.controller.js';
 import { CustomersService } from './customers.service.js';
+import { DeliveriesService } from './deliveries.service.js';
 import { PriceListsController } from './price-lists.controller.js';
 import { PriceListsService } from './price-lists.service.js';
+import { PriceLookupService } from './price-lookup.service.js';
+import { QuotationsService } from './quotations.service.js';
+import {
+  DeliveriesController,
+  QuotationsController,
+  SalesOrdersController,
+  SalesPricesController,
+} from './sales-documents.controller.js';
+import { SalesOrdersService } from './sales-orders.service.js';
 
 // Sales (step 15): customers, their groups and the price lists in 15a; quotations, orders,
-// deliveries, invoices and returns join in 15b–15d. NumberingModule gives the customer codes
-// (C-00042), JournalModule the LedgerService behind a customer's statement, RbacModule the
-// permission check of BalanceAccess.
+// deliveries and the price lookup in 15b; invoices and returns join in 15c–15d. NumberingModule
+// gives the codes and document numbers (C-00042, QT-, SO-, DC-), JournalModule the LedgerService
+// behind a customer's statement, RbacModule the permission check of BalanceAccess. InventoryModule
+// (15b) gives a delivery what every stock document uses: StockPostingService moves the stock,
+// StockBooksService books its cost, ValueAccess hides that cost without inventory.stock.value.
 @Module({
-  imports: [NumberingModule, JournalModule, RbacModule],
-  controllers: [CustomersController, CustomerGroupsController, PriceListsController],
-  providers: [CustomersService, CustomerGroupsService, PriceListsService, BalanceAccess],
+  imports: [NumberingModule, JournalModule, RbacModule, InventoryModule],
+  controllers: [
+    CustomersController,
+    CustomerGroupsController,
+    PriceListsController,
+    SalesPricesController,
+    QuotationsController,
+    SalesOrdersController,
+    DeliveriesController,
+  ],
+  providers: [
+    CustomersService,
+    CustomerGroupsService,
+    PriceListsService,
+    BalanceAccess,
+    PriceLookupService,
+    QuotationsService,
+    SalesOrdersService,
+    DeliveriesService,
+  ],
 })
 export class SalesModule {}
```

- **`InventoryModule` is imported** for `StockPostingService`, `StockBooksService` and `ValueAccess`. Inventory does
  not import sales, so there is no circle. The stock list reads the order tables with plain SQL (below), which
  needs no module import.

### `inventory/`: the books, the export and "on order"

```diff
@@ -24,9 +24,11 @@ import { WarehousesService } from './warehouses.service.js';
 // StockPostingService and StockBooksService are exported: purchases, sales and POS (steps 15–20)
 // import this module, call post() for the stock and its values, and write their own journal entry
 // in the same transaction, the way every module that posts to the books uses the journal's
-// PostingService. JournalModule gives StockBooksService that PostingService; RbacModule gives
-// ValueAccess the permission check. The low-stock alert's worker half (low-stock.handler.ts) is
-// wired in worker/worker.module.ts, like every handler.
+// PostingService. ValueAccess too (step 15b): a delivery shows what its goods cost only to
+// someone with inventory.stock.value, like every stock document. JournalModule gives
+// StockBooksService that PostingService; RbacModule gives ValueAccess the permission check. The
+// low-stock alert's worker half (low-stock.handler.ts) is wired in worker/worker.module.ts, like
+// every handler.
 @Module({
   imports: [NumberingModule, JournalModule, RbacModule],
   controllers: [
@@ -48,6 +50,6 @@ import { WarehousesService } from './warehouses.service.js';
     StockAccountsService,
     ValueAccess,
   ],
-  exports: [StockPostingService, StockBooksService],
+  exports: [StockPostingService, StockBooksService, ValueAccess],
 })
 export class InventoryModule {}
```

- **`ValueAccess` is exported.** The delivery hides its values with the same check as every stock document, instead
  of a second copy of it in the sales module.

```diff
@@ -31,12 +31,13 @@ interface WarehouseValue {
   value: string;
 }
 
-// The accounts a stock entry may need. inventory and equity are found by their purpose (every chart
-// has them, and they cannot be deleted or archived); the others are the choices in Settings →
-// Inventory, each of which must still be an active ledger.
+// The accounts a stock entry may need. inventory, equity and cost of goods sold are found by their
+// purpose (every chart has them, and they cannot be deleted or archived); the others are the
+// choices in Settings → Inventory, each of which must still be an active ledger.
 interface Accounts {
   inventory: string;
   openingEquity: string;
+  costOfGoodsSold: () => string;
   use: (use: StockAccountUse) => string;
 }
 
@@ -173,6 +174,24 @@ export class StockBooksService {
     ]);
   }
 
+  // A delivery (step 15b): the goods leave the inventory account at what they cost, into cost of
+  // goods sold (Dr Cost of goods sold / Cr Inventory), both with the warehouse's branch, so each
+  // branch's profit and loss carries the cost of what it sold. The sale itself is the invoice's
+  // entry (15c): the receivable, the sales account and the VAT.
+  async delivery(
+    tx: Transaction,
+    document: { id: string; number: string; date: string },
+    moved: WarehouseValue,
+  ): Promise<EntryRef | null> {
+    const accounts = await this.accounts(tx);
+    const branchOf = await this.branches(tx, [moved]);
+    const branchId = branchOf(moved.warehouseId);
+    return this.write(tx, document, 'sales_delivery', `Delivery ${document.number}`, [
+      { accountId: accounts.costOfGoodsSold(), branchId, amount: moved.value },
+      { accountId: accounts.inventory, branchId, amount: negateMoney(moved.value) },
+    ]);
+  }
+
   // The posted entries of a document, oldest first: an adjustment has at most one, a transfer two
   async entriesOf(tx: Transaction, documentId: string): Promise<EntryRef[]> {
     const rows = await tx
@@ -242,12 +261,17 @@ export class StockBooksService {
       .where(
         and(
           eq(ledgerAccounts.tenantId, tenantId),
-          inArray(ledgerAccounts.purpose, ['inventory', 'opening_balance_equity']),
+          inArray(ledgerAccounts.purpose, [
+            'inventory',
+            'opening_balance_equity',
+            'cost_of_goods_sold',
+          ]),
         ),
       )
       .for('share');
     const inventory = purposes.find((row) => row.purpose === 'inventory')?.id;
     const openingEquity = purposes.find((row) => row.purpose === 'opening_balance_equity')?.id;
+    const costOfGoodsSold = purposes.find((row) => row.purpose === 'cost_of_goods_sold')?.id;
     // A workspace whose chart is still being made by the setup job
     if (inventory === undefined) throw missing('inventory');
     if (openingEquity === undefined) throw missing('opening_balance_equity');
@@ -274,6 +298,11 @@ export class StockBooksService {
     return {
       inventory,
       openingEquity,
+      // Asked for only by a delivery: the other stock documents never needed it
+      costOfGoodsSold: () => {
+        if (costOfGoodsSold === undefined) throw missing('cost_of_goods_sold');
+        return costOfGoodsSold;
+      },
       use: (use) => {
         const id = byUse.get(use);
         if (id === undefined) throw missing(use);
```

- **Cost of goods sold is found by its purpose**, like the inventory account. Every chart template marks one
  (step 9), and a purpose account cannot be deleted or archived. It is not a Settings → Inventory choice: like the
  inventory account, the chart fixes it.
- **`costOfGoodsSold` is a function.** The other stock documents never need the account; a workspace whose chart
  somehow lacks it can still post adjustments. Only a delivery asks, and gets `stock_account_missing`.
- **Both lines carry the warehouse's branch.** Each branch's profit and loss then shows the cost of what that
  branch sold, next to its sales (15c).

```diff
@@ -69,6 +69,7 @@ const itemRowSchema = z.object({
   archived: z.boolean(),
   on_hand: z.string(),
   in_transit: z.string(),
+  on_order: z.string(),
   low: z.boolean(),
   unit_cost: z.string().nullable(),
   value: z.string().nullable(),
@@ -92,6 +93,7 @@ function toItem(row: z.output<typeof itemRowSchema>, canSee: boolean): StockItem
     archived: row.archived,
     onHand: row.on_hand,
     inTransit: row.in_transit,
+    onOrder: row.on_order,
     low: row.low,
     unitCost: canSee ? row.unit_cost : null,
     value: canSee ? row.value : null,
@@ -833,6 +835,16 @@ export class StockService {
                   JOIN stock_transfers t ON t.tenant_id = l.tenant_id AND t.id = l.transfer_id
                  WHERE l.tenant_id = v.tenant_id AND l.variant_id = v.id AND t.status = 'in_transit'
                    AND ${inWarehouse(sql`t.to_warehouse_id`)})`)} AS in_transit,
+               ${
+                 // What confirmed orders still have to deliver from the warehouse (step 15b).
+                 // l.product_id lets sales_order_lines_variant_idx find the lines; the order's
+                 // status and warehouse are sales_orders_open_idx's.
+                 quantityText(sql`(SELECT sum(l.base_quantity - l.delivered_quantity)
+                  FROM sales_order_lines l
+                  JOIN sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
+                 WHERE l.tenant_id = v.tenant_id AND l.product_id = p.id AND l.variant_id = v.id
+                   AND o.status = 'confirmed' AND ${inWarehouse(sql`o.warehouse_id`)})`)
+               } AS on_order,
                ${lowCondition(warehouseId)} AS low,
                round(sv.unit_cost, 4)::text AS unit_cost,
                ${
```

- **`on_order` is a subquery like `in_transit`:** confirmed orders' lines, ordered minus delivered, in the base
  unit, for the chosen warehouse (or all). The list already keeps to goods (`p.type = 'goods'`), so service
  lines never count.
- **`l.product_id = p.id`** is redundant for the result (a variant has one product) but lets Postgres use
  `sales_order_lines_variant_idx`, which starts with `(tenant_id, product_id, …)`.
- **The order's warehouse counts**, not the warehouse a delivery will use. "On order" is a promise of the order's
  warehouse; a delivery from another one is the exception.
- The stock card uses the same `items()` query, so it shows `onOrder` too.

### `products/` and `sales/customers.service.ts`: the new foreign keys

```diff
@@ -58,6 +58,10 @@ const VARIANT_IN_USE = [
   'stock_balances_variant_fk',
   'stock_adjustment_lines_variant_fk',
   'stock_transfer_lines_variant_fk',
+  // step 15b
+  'quotation_lines_variant_fk',
+  'sales_order_lines_variant_fk',
+  'delivery_lines_variant_fk',
 ] as const;
 
 // The list's orders. Each sorts by one key and then the id, so the order is total and a cursor
```

```diff
@@ -77,6 +77,15 @@ interface Snapshot {
   addresses: number;
 }
 
+// Rows that hold on to a customer. Deleting it is refused while one exists (customer_in_use).
+const CUSTOMER_IN_USE = [
+  'journal_lines_party_fk',
+  // step 15b
+  'quotations_customer_fk',
+  'sales_orders_customer_fk',
+  'deliveries_customer_fk',
+] as const;
+
 function codeTaken(): AppError {
   return new AppError(409, 'customer_code_taken', 'Another customer uses this code.', {
     fieldErrors: { code: ['customer_code_taken'] },
@@ -290,12 +299,12 @@ export class CustomersService {
         });
       });
     } catch (error) {
-      // No "is it used?" query first: the FK is the check. Step 15b adds the sales documents' FKs.
-      if (isForeignKeyViolation(error, 'journal_lines_party_fk')) {
+      // No "is it used?" query first: the FK is the check, here and on every sales document
+      if (CUSTOMER_IN_USE.some((constraint) => isForeignKeyViolation(error, constraint))) {
         throw new AppError(
           409,
           'customer_in_use',
-          'This customer has entries. Archive it instead.',
+          'Entries or sales documents use this customer. Archive it instead.',
         );
       }
       throw error;
```

- **No "is it used?" query.** The foreign key is the check, as before: deleting a product variant or a customer
  that a quotation, an order or a delivery uses fails on the FK, and the API turns the FK's name into
  `product_variant_in_use` or `customer_in_use`. A new document type adds its FK name to the list.
- **A warehouse needs nothing.** Warehouses are archived, never deleted, so their FKs never fire.

### `setup/templates.ts`: who gets the new permissions in a new workspace

```diff
@@ -100,6 +100,12 @@ export interface IndustryTemplate {
 const SELLING = ['sales.customer.manage', 'sales.customer.balance'] as const;
 const SALES_ADMIN = [...SELLING, 'sales.price_list.manage'] as const;
 
+// Step 15b. The people who sell write quotations and orders; the people who keep the stock post
+// the deliveries (challans). The accountant gets neither: reading a sales document needs no
+// permission, and the books get the delivery's entry without anyone posting it by hand.
+const ORDERING = ['sales.quotation.manage', 'sales.order.manage'] as const;
+const DELIVERING = ['sales.delivery.manage'] as const;
+
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
 const ACCOUNTANT: RoleTemplate = {
@@ -128,7 +134,7 @@ const STOCK_WORK = ['inventory.stock.adjust', 'inventory.stock.transfer'] as con
 const STORE_KEEPER: RoleTemplate = {
   name: 'Store keeper',
   description: 'Receives goods and writes GRNs',
-  permissions: ['inventory.product.manage', ...STOCK_WORK],
+  permissions: ['inventory.product.manage', ...STOCK_WORK, ...DELIVERING],
 };
 
 function group(
@@ -330,7 +336,12 @@ export const INDUSTRY_TEMPLATES = {
         name: 'Merchandiser',
         description: 'Buyer POs, LCs and shipment dates',
         // The buyers are the merchandiser's customers
-        permissions: ['core.user.read', 'inventory.product.manage', 'sales.customer.manage'],
+        permissions: [
+          'core.user.read',
+          'inventory.product.manage',
+          'sales.customer.manage',
+          ...ORDERING,
+        ],
       },
       STORE_KEEPER,
     ],
@@ -390,12 +401,13 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
+          ...DELIVERING,
         ],
       },
       {
         name: 'Sales representative',
         description: 'Orders from pharmacies',
-        permissions: ['sales.customer.manage'],
+        permissions: ['sales.customer.manage', ...ORDERING],
       },
     ],
     chart: standardChart({
@@ -459,12 +471,13 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.product.manage',
           'inventory.warehouse.manage',
           ...STOCK_WORK,
+          ...DELIVERING,
         ],
       },
       {
         name: 'Sales officer',
         description: 'Orders and collections from retailers',
-        permissions: [...SELLING],
+        permissions: [...SELLING, ...ORDERING],
       },
     ],
     chart: standardChart({
@@ -557,6 +570,8 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.warehouse.manage',
           ...STOCK_WORK,
           ...SALES_ADMIN,
+          ...ORDERING,
+          ...DELIVERING,
         ],
       },
       { name: 'Cashier', description: 'Sells at the counter', permissions: [] },
@@ -603,6 +618,8 @@ export const INDUSTRY_TEMPLATES = {
           'inventory.warehouse.manage',
           ...STOCK_WORK,
           ...SALES_ADMIN,
+          ...ORDERING,
+          ...DELIVERING,
         ],
       },
     ],
```

- **The file promised this.** Its comment says each module's step adds its permissions to the role templates, and
  15a did it for customers. Without this change, a new garments workspace's Merchandiser could add a buyer but
  not write the buyer's quotation, and only the owner could post a challan.
- **`ORDERING` goes to the people who sell**: the Merchandiser (garments: the buyer's PO becomes a sales order),
  the pharma Sales representative, the distribution Sales officer, the Shop manager and the general Manager.
- **`DELIVERING` goes to the people who keep the stock**: the Store keeper (garments, manufacturing), both Depot
  managers (pharma, distribution), the Shop manager and the general Manager. The person who hands the goods over
  at the gate is the one who posts the challan, and the delivery's stock and cost entry follow from it.
- **The Accountant gets neither.** Reading any sales document needs no permission, and the delivery's journal
  entry is posted by the delivery itself. An accountant who writes orders would also be the person who checks
  them later.
- **Only new workspaces.** A template is used once, when a workspace is set up. Existing roles keep what they
  have; the owner ticks the new permissions on the Roles page ("Run it" says so).

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/db build
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm lint
```

The API type-checks, and its unit tests pass (`contract.spec.ts` finds a controller for every new route). The
stock integration tests (`stock.int.spec.ts`) still pass with the new `on_order` column. The tests for the new
documents come in 15b.4. `pnpm typecheck` for the whole repo still fails in `packages/i18n` (15b.5) and in the
app's stock mock (15b.7), as expected.

## 15b.4 — `apps/api`: the tests

This part adds one test file, extends another, and changes the expected lists of two more (the number series and
a new workspace's roles). They run against a real Postgres and the real worker, like every integration test since
step 5:

- `sales/sales-documents.int.spec.ts` (new) follows one distributor from the price a line starts with, through a
  quotation and an order, to the deliveries that empty the order.
- `sales/sales.tenant-leak.int.spec.ts` gets a second `describe`: workspace A must never see, change or use
  workspace B's quotations, orders and deliveries.
- `numbering/numbering.int.spec.ts` counts the number series, and 15b adds two.

The 15b.3 code passed these tests as written, so no code above was changed by this part.

### `sales/sales-documents.int.spec.ts` (new): the setup

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  type Customer,
  customerSchema,
  type Delivery,
  type DeliveryFormValues,
  deliveryPageSchema,
  deliverySchema,
  journalEntrySchema,
  type PriceList,
  priceListSchema,
  priceLookupSchema,
  type Product,
  type ProductFormValues,
  productSchema,
  problemSchema,
  type Quotation,
  type QuotationFormValues,
  quotationPageSchema,
  quotationSchema,
  type SalesLineFormValues,
  type SalesOrder,
  type SalesOrderFormValues,
  salesOrderPageSchema,
  salesOrderSchema,
  type Settings,
  settingsSchema,
  setupSchema,
  stockCardSchema,
  stockMovementPageSchema,
  stockPageSchema,
  type TaxRate,
  taxRateListSchema,
  taxRateSchema,
  type Unit,
  unitListSchema,
  type Warehouse,
  warehouseListSchema,
} from '@omnivo/contracts';
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
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

// Step 15b: quotation → order → delivery, for one distributor. Juice sold by the piece, the 6-pack
// and the 24-bottle case (a dealer price list has two of them); Napa in batches; phones by IMEI; a
// delivery charge that is a service. Bhairab Bazar Traders buys on the dealer list, Ashulia Super
// Shop at the products' own prices. Each test builds on the ones before it, like the stock tests.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// A member with no role: reads every sales document, writes none, sees no cost
let viewer: SignedIn;
let units: Unit[];
let accounts: Account[];
let rates: TaxRate[];
let main: Warehouse;
let juice: Product;
let napa: Product;
let phone: Product;
let carriage: Product;
let dealer: PriceList;
let bhairab: Customer;
let ashulia: Customer;
let quotation: Quotation;
// The order the deliveries take goods against
let order: SalesOrder;

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

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function unitId(code: string): string {
  const found = units.find((unit) => unit.code === code);
  if (!found) throw new Error(`no unit ${code}`);
  return found.id;
}

function rateId(name: string): string {
  const found = rates.find((rate) => rate.name === name);
  if (!found) throw new Error(`no VAT rate ${name}`);
  return found.id;
}

function codeOf(id: string): string {
  return accounts.find((account) => account.id === id)?.code ?? id;
}

function variantOf(product: Product): string {
  const [variant] = product.variants;
  if (!variant) throw new Error(`${product.name} has no variant`);
  return variant.id;
}

function addressOf(customer: Customer): string {
  const [address] = customer.addresses;
  if (!address) throw new Error(`${customer.name} has no address`);
  return address.id;
}

// The order line of a product, for a delivery line to point at
function orderLine(saved: SalesOrder, product: Product): string {
  const found = saved.lines.find((item) => item.variantId === variantOf(product));
  if (!found) throw new Error(`no ${product.name} on ${saved.number ?? 'the order'}`);
  return found.id;
}
```

- **One workspace, one story.** Each test builds on the ones before it (the quotation from the first test is the
  one an order accepts later; the order's first delivery decides what the next one may take). This is how the
  stock tests of step 13 work too. It keeps the file short, and every number in it can be followed by hand from
  the opening stock. The cost is that one failing test can make later ones fail too: read the first failure first.
- **`viewer` is a member with no role.** Reading a sales document needs no permission, writing needs one of the
  three new ones, and the cost of the goods needs `inventory.stock.value`. One person with no role checks all
  three answers.
- **`orderLine()` finds the order line by its product.** A delivery line points at an order line by its id, and
  the id is only known after the order is saved. Finding it by product keeps the tests readable ("the juice line
  of the order") and fails loudly if the line is not there.

```ts
async function addProduct(name: string, extra: Partial<ProductFormValues> = {}) {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: unitId('pcs'),
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'none',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
    ],
    units: [],
    customFields: {},
    ...extra,
  } satisfies ProductFormValues);
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

function salePrice(price: string) {
  return [{ id: null, sku: '', optionValues: [], barcode: '', salePrice: price, archived: false }];
}

async function addCustomer(name: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

function settingsForm(settings: Settings, pricesIncludeVat: boolean) {
  return {
    version: settings.version,
    companyName: settings.companyName,
    legalName: settings.legalName ?? '',
    bin: settings.bin ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    address: settings.address ?? '',
    baseCurrency: settings.baseCurrency,
    fiscalYearStartMonth: settings.fiscalYearStartMonth,
    timezone: settings.timezone,
    allowNegativeStock: settings.allowNegativeStock,
    pricesIncludeVat,
  };
}

async function setPricesIncludeVat(on: boolean): Promise<void> {
  const settings = settingsSchema.parse((await send('GET', '/settings')).json());
  const res = await send('PUT', '/settings', settingsForm(settings, on));
  expect(res.statusCode, res.body).toBe(200);
}

// A line as the form sends it: by the piece, at 15% VAT, no discount, the product's own name
function salesLine(
  product: Product,
  quantity: string,
  unitPrice: string,
  extra: Partial<SalesLineFormValues> = {},
): SalesLineFormValues {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    description: '',
    unitPrice,
    discountType: 'percent',
    discount: '',
    taxRateId: rateId('VAT 15%'),
    ...extra,
  };
}

function quotationForm(
  lines: SalesLineFormValues[],
  extra: Partial<QuotationFormValues> = {},
): Omit<QuotationFormValues, 'version'> {
  return {
    customerId: bhairab.id,
    date: '2026-10-01',
    validUntil: '2026-10-15',
    note: '',
    lines,
    ...extra,
  };
}

async function quoted(body: object): Promise<Quotation> {
  const res = await send('POST', '/quotations', body);
  expect(res.statusCode, res.body).toBe(201);
  return quotationSchema.parse(res.json());
}

function orderForm(
  lines: SalesLineFormValues[],
  extra: Partial<SalesOrderFormValues> & { quotationId?: string } = {},
) {
  return {
    customerId: bhairab.id,
    date: '2026-10-02',
    deliveryDate: '',
    customerReference: '',
    warehouseId: main.id,
    shippingAddressId: '',
    note: '',
    lines,
    confirm: false,
    ...extra,
  };
}

async function ordered(body: object): Promise<SalesOrder> {
  const res = await send('POST', '/sales-orders', body);
  expect(res.statusCode, res.body).toBe(201);
  return salesOrderSchema.parse(res.json());
}

async function orderNow(id: string): Promise<SalesOrder> {
  return salesOrderSchema.parse((await send('GET', `/sales-orders/${id}`)).json());
}

function deliveryLine(product: Product, quantity: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    serialNumbers: [],
    orderLineId: '',
    ...extra,
  };
}

function deliveryForm(lines: object[], extra: Partial<DeliveryFormValues> = {}) {
  return {
    customerId: bhairab.id,
    orderId: order.id,
    date: '2026-10-05',
    warehouseId: main.id,
    shippingAddressId: '',
    vehicle: '',
    note: '',
    lines,
    post: true,
    ...extra,
  };
}

async function delivered(body: object): Promise<Delivery> {
  const res = await send('POST', '/deliveries', body);
  expect(res.statusCode, res.body).toBe(201);
  return deliverySchema.parse(res.json());
}

async function postDraft(draft: Delivery) {
  return send('POST', `/deliveries/${draft.id}/post`, { version: draft.version });
}

// A journal entry as [account code, debit, credit] rows — what an accountant reads
async function entryLines(id: string) {
  const entry = journalEntrySchema.parse((await send('GET', `/journal-entries/${id}`)).json());
  return entry.lines.map((item) => [codeOf(item.accountId), item.debit, item.credit]);
}

// What /stock shows for the main warehouse: on hand and still to deliver, per product name
async function stockNow() {
  const page = stockPageSchema.parse((await send('GET', `/stock?warehouseId=${main.id}`)).json());
  return Object.fromEntries(
    page.items.map((item) => [item.productName, [item.onHand, item.onOrder]]),
  );
}

async function batchOf(product: Product, lotNumber: string): Promise<string> {
  const card = stockCardSchema.parse(
    (await send('GET', `/stock/variants/${variantOf(product)}`)).json(),
  );
  const found = card.batches.find((batch) => batch.lotNumber === lotNumber);
  if (!found) throw new Error(`no batch ${lotNumber}`);
  return found.batchId;
}

// A line of the opening stock adjustment: by the piece unless extra says otherwise
function openingLine(product: Product, quantity: string, unitCost: string, extra: object = {}) {
  return {
    variantId: variantOf(product),
    unitId: unitId('pcs'),
    quantity,
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    unitCost,
    ...extra,
  };
}

function lookup(customerId: string | null, items: { variantId: string; unitId: string }[]) {
  return send('POST', '/sales/price-lookup', { customerId, items });
}
```

- **The form builders (`salesLine`, `quotationForm`, `orderForm`, `deliveryLine`, `deliveryForm`) send every
  field.** The contracts make every field of these forms required (an empty box is `''`), because the app always
  sends the whole form. A test that left a field out would get a 400 for that, not for what it means to test.
- **`salesLine` is typed with `SalesLineFormValues`**, the contract's input type. A field renamed in the contract
  then breaks the type check here, not a test at run time. The document builders use `Partial<…FormValues>` for
  their extras for the same reason.
- **`salesLine` defaults to 15% VAT and no discount**, and each test sets only what it is about. Napa passes
  `taxRateId: rateId('Exempt')` because its product uses the Exempt rate.
- **`settingsForm()` copies the whole settings form**, like the stock tests do, and changes only
  `pricesIncludeVat`. The settings route also takes the whole form, so sending one field would be a 400.
- **`entryLines()` turns an entry into `[account code, debit, credit]` rows.** That is how an accountant reads it,
  and the codes come from the distribution chart of accounts (`5110` Cost of goods sold, `1150` Inventory).
- **`stockNow()` reads `/stock` for one warehouse** and keeps, per product, what is on hand and what is on order.
  Most delivery tests end by checking both, because "on order" is the one number on the stock page that 15b adds.
- **`batchOf()` asks the stock card for a lot's batch id.** A delivery of a batch-tracked item names the batch
  (the app suggests the one that expires first); the tests pick it by its lot number, like a store keeper reading
  the box.

```ts
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
  owner = await signUp(app, {
    companyName: 'Meghna Distributors',
    workspaceSlug: 'meghna-distributors',
    fullName: 'Shafiq Ahmed',
    email: 'shafiq@meghnadistributors.com',
    password: 'Narsingdi-depot-2026',
  });
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  units = unitListSchema.parse((await send('GET', '/units')).json()).items;
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
  const [first] = warehouseListSchema.parse((await send('GET', '/warehouses')).json()).items;
  if (!first) throw new Error('sign-up made no warehouse');
  main = first;

  juice = await addProduct('Mango juice 250 ml', {
    variants: salePrice('25'),
    units: [
      { unitId: unitId('pack'), factor: '6', barcode: '' },
      { unitId: unitId('case'), factor: '24', barcode: '' },
    ],
  });
  napa = await addProduct('Napa 500 mg', {
    tracking: 'batch',
    hasExpiry: true,
    taxRateId: rateId('Exempt'),
    variants: salePrice('1.2'),
  });
  // Priced by hand on every order: no sale price
  phone = await addProduct('Walton Primo NH5', { tracking: 'serial' });
  carriage = await addProduct('Delivery charge', { type: 'service', variants: salePrice('500') });

  dealer = priceListSchema.parse(
    (await send('POST', '/price-lists', { name: 'Dealer', description: '' })).json(),
  );
  const priced = await send('PUT', `/price-lists/${dealer.id}/items`, {
    changes: [
      { variantId: variantOf(juice), unitId: unitId('pcs'), price: '22' },
      { variantId: variantOf(juice), unitId: unitId('case'), price: '504' },
    ],
  });
  expect(priced.statusCode, priced.body).toBe(200);
  bhairab = await addCustomer('Bhairab Bazar Traders', {
    priceListId: dealer.id,
    addresses: [
      {
        id: null,
        kind: 'shipping',
        label: 'Bhairab godown',
        address: 'Station Road, Bhairab, Kishoreganj',
        phone: '01712-334455',
      },
    ],
  });
  ashulia = await addCustomer('Ashulia Super Shop', {
    addresses: [
      { id: null, kind: 'shipping', label: '', address: 'Baipail, Ashulia, Savar', phone: '' },
    ],
  });

  // Opening stock: 10 cases of juice at ৳1,200 a case (৳50 a piece), Napa in two lots at ৳0.80,
  // two phones at ৳18,000
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-10-01',
    warehouseId: main.id,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      openingLine(juice, '10', '1200', { unitId: unitId('case') }),
      openingLine(napa, '120', '0.80', { lotNumber: 'NP24090', expiresOn: '2027-01-31' }),
      openingLine(napa, '100', '0.80', { lotNumber: 'NP24117', expiresOn: '2027-06-30' }),
      openingLine(phone, '2', '18000', { serialNumbers: ['356938035643809', '356938035643817'] }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);

  await signUp(app, {
    companyName: 'Rina Store',
    workspaceSlug: 'rina-store',
    fullName: 'Rina Akter',
    email: 'rina@meghnadistributors.com',
    password: 'Counter-cash-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'rina@meghnadistributors.com',
    workspace: 'meghna-distributors',
  });
  viewer = await logIn(app, {
    workspace: 'meghna-distributors',
    email: 'rina@meghnadistributors.com',
    password: 'Counter-cash-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});
```

- **The products cover every kind of line.** Juice has two packs, so the unit factor (6 and 24) shows up in
  prices and in quantities. Napa is batch-tracked with its own VAT rate. The phone is serial-tracked and has no
  sale price, so the lookup has nothing to offer. The delivery charge is a service: it can be sold, never
  delivered.
- **Only Bhairab Bazar Traders has a price list**, and the dealer list has the juice by the piece and by the case,
  not by the 6-pack. That one setup checks all three answers of the price lookup.
- **The opening stock has typed costs** (৳1,200 a case = ৳50 a piece, ৳0.80 a tablet, ৳18,000 a phone). The cost
  of goods sold of every delivery can then be checked as a plain multiplication.
- **Two Napa lots with different expiry dates**, so the last delivery can take the end of one lot and the start
  of the next on a single order line.
- **The viewer signs up for their own workspace first**, then joins this one with no role (`joinWithoutRoles`), as
  in the step 14 tests. A user must exist before a membership can point at them.

### The price lookup

```ts
describe('price lookup', () => {
  it("starts a line at the customer's list price, else the product's price for the unit", async () => {
    const res = await lookup(bhairab.id, [
      { variantId: variantOf(juice), unitId: unitId('pcs') },
      { variantId: variantOf(juice), unitId: unitId('case') },
      // Not on the dealer list: the product's ৳25 × 6
      { variantId: variantOf(juice), unitId: unitId('pack') },
      { variantId: variantOf(napa), unitId: unitId('pcs') },
      { variantId: variantOf(phone), unitId: unitId('pcs') },
      // Napa is never sold by the case, and the last one is no product at all: both left out
      { variantId: variantOf(napa), unitId: unitId('case') },
      { variantId: '01939d1c-0000-7000-8000-000000000000', unitId: unitId('pcs') },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const prices = priceLookupSchema.parse(res.json());
    expect(prices.pricesIncludeVat).toBe(false);
    expect(prices.items.map((item) => [item.price, item.source, item.taxRateId])).toEqual([
      ['22.0000', 'price_list', rateId('VAT 15%')],
      ['504.0000', 'price_list', rateId('VAT 15%')],
      ['150.0000', 'product', rateId('VAT 15%')],
      ['1.2000', 'product', rateId('Exempt')],
      // Nobody set a price: the person types it
      [null, null, rateId('VAT 15%')],
    ]);
  });

  it("uses the products' own prices with no customer, and while the customer's list is archived", async () => {
    const juicePiece = [{ variantId: variantOf(juice), unitId: unitId('pcs') }];
    const anyone = priceLookupSchema.parse((await lookup(null, juicePiece)).json());
    expect(anyone.items[0]).toMatchObject({ price: '25.0000', source: 'product' });

    dealer = priceListSchema.parse((await send('GET', `/price-lists/${dealer.id}`)).json());
    const archived = await send('POST', `/price-lists/${dealer.id}/archive`, {
      version: dealer.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const fallback = priceLookupSchema.parse((await lookup(bhairab.id, juicePiece)).json());
    expect(fallback.items[0]).toMatchObject({ price: '25.0000', source: 'product' });
    const restored = await send('POST', `/price-lists/${dealer.id}/restore`, {
      version: priceListSchema.parse(archived.json()).version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const back = priceLookupSchema.parse((await lookup(bhairab.id, juicePiece)).json());
    expect(back.items[0]).toMatchObject({ price: '22.0000', source: 'price_list' });
  });

  it("falls back to the default VAT rate while the product's own rate is archived", async () => {
    const exempt = rates.find((rate) => rate.id === rateId('Exempt'));
    if (!exempt) throw new Error('no Exempt rate');
    const archived = await send('POST', `/tax-rates/${exempt.id}/archive`, {
      version: exempt.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const napaPiece = [{ variantId: variantOf(napa), unitId: unitId('pcs') }];
    const prices = priceLookupSchema.parse((await lookup(null, napaPiece)).json());
    expect(prices.items[0]?.taxRateId).toBe(rateId('VAT 15%'));
    const restored = await send('POST', `/tax-rates/${exempt.id}/restore`, {
      version: taxRateSchema.parse(archived.json()).version,
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });
});
```

- **One request checks every source of a price.** The dealer's price for the piece and the case
  (`price_list`), the product's ৳25 × 6 for the pack (`product`), Napa's own price and rate, and the phone with no
  price at all (`null`, so the person types it). The answer keeps the order of the request, which the form relies
  on to fill its lines.
- **Items the lookup cannot price are left out, not refused.** Napa by the case (not one of its units) and a
  made-up variant are simply missing from the answer. A form that asks for an item that was just archived or
  changed should not fail as a whole.
- **An archived price list falls back to the products' prices**, as 15a promised, and the dealer price comes back
  when the list is restored. The list is read again before archiving it, because setting its prices in the setup
  changed its version.
- **An archived VAT rate falls back to the workspace default.** A new line must never start with a rate that
  cannot be saved (`tax_rate_invalid`). The test restores the rate afterwards, because later tests sell Napa at
  Exempt.

### Quotations

```ts
describe('quotations', () => {
  it('get their number when saved, and work each line out to the paisa', async () => {
    quotation = await quoted(
      quotationForm([
        // 2 cases at the dealer's ৳504, 10% off: ৳1,008 − ৳100.80 = ৳907.20, + 15% VAT ৳136.08
        salesLine(juice, '2', '504', { unitId: unitId('case'), discount: '10' }),
        // 200 tablets at ৳1.20, ৳40 off: ৳200, exempt
        salesLine(napa, '200', '1.2', {
          discountType: 'amount',
          discount: '40',
          taxRateId: rateId('Exempt'),
          description: 'Napa 500 mg, 10 × 10 strips',
        }),
      ]),
    );
    expect(quotation).toMatchObject({
      number: 'QT-2026-27-0001',
      status: 'open',
      pricesIncludeVat: false,
      customer: { id: bhairab.id, name: 'Bhairab Bazar Traders' },
      discount: '140.8000',
      net: '1107.2000',
      vat: '136.0800',
      total: '1243.2800',
      lineCount: 2,
      order: null,
    });
    expect(
      quotation.lines.map((item) => [item.description, item.baseQuantity, item.net, item.vat]),
    ).toEqual([
      // No description typed: the product's name
      ['Mango juice 250 ml', '48.0000', '907.2000', '136.0800'],
      ['Napa 500 mg, 10 × 10 strips', '200.0000', '200.0000', '0.0000'],
    ]);
    expect(quotation.lines[1]?.taxRate).toMatchObject({ name: 'Exempt', kind: 'exempt' });

    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=quotation&entityId=${quotation.id}`)).json(),
    );
    expect(log[0]?.action).toBe('quotation.created');
  });

  it('refuse every line they cannot use, each under its own field', async () => {
    const res = await send(
      'POST',
      '/quotations',
      quotationForm([
        salesLine(juice, '1', '22'),
        { ...salesLine(juice, '1', '22'), variantId: '01939d1c-0000-7000-8000-000000000000' },
        salesLine(napa, '1', '120', { unitId: unitId('case') }),
        salesLine(juice, '1', '22', { taxRateId: '01939d1c-0000-7000-8000-000000000001' }),
      ]),
    );
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.variantId': ['sales_item_invalid'],
      'lines.2.unitId': ['stock_unit_invalid'],
      'lines.3.taxRateId': ['tax_rate_invalid'],
    });

    // The form's own rules: a discount larger than the line, an offer that ends before it starts
    const form = await send(
      'POST',
      '/quotations',
      quotationForm([salesLine(juice, '2', '22', { discountType: 'amount', discount: '45' })], {
        validUntil: '2026-09-30',
      }),
    );
    expect(form.statusCode).toBe(400);
    expect(problemOf(form).fieldErrors).toEqual({
      validUntil: ['quotation_valid_until'],
      'lines.0.discount': ['sales_discount_too_large'],
    });
  });

  it('change while open; declined, they wait for the customer to come back', async () => {
    const stale = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: quotation.version + 1,
    });
    expect(problemOf(stale).code).toBe('version_conflict');

    const declined = quotationSchema.parse(
      (
        await send('POST', `/quotations/${quotation.id}/decline`, { version: quotation.version })
      ).json(),
    );
    expect(declined.status).toBe('declined');
    const edit = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: declined.version,
    });
    expect(edit.statusCode).toBe(409);
    expect(problemOf(edit).code).toBe('quotation_not_open');

    const reopened = quotationSchema.parse(
      (
        await send('POST', `/quotations/${quotation.id}/reopen`, { version: declined.version })
      ).json(),
    );
    expect(reopened.status).toBe('open');
    const again = await send('POST', `/quotations/${quotation.id}/reopen`, {
      version: reopened.version,
    });
    expect(problemOf(again).code).toBe('quotation_not_declined');

    // The same quotation, with the juice by the piece now: the totals follow the lines
    const changed = await send('PUT', `/quotations/${quotation.id}`, {
      ...quotationForm([salesLine(juice, '24', '22')]),
      version: reopened.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    quotation = quotationSchema.parse(changed.json());
    expect(quotation).toMatchObject({
      number: 'QT-2026-27-0001',
      net: '528.0000',
      vat: '79.2000',
      total: '607.2000',
    });
  });

  it('are deleted while open, and the next one takes the next number', async () => {
    const spare = await quoted(quotationForm([salesLine(juice, '6', '22')]));
    expect(spare.number).toBe('QT-2026-27-0002');
    const res = await send('DELETE', `/quotations/${spare.id}?version=${String(spare.version)}`);
    expect(res.statusCode).toBe(204);
    expect((await send('GET', `/quotations/${spare.id}`)).statusCode).toBe(404);
    const page = quotationPageSchema.parse((await send('GET', '/quotations?status=open')).json());
    expect(page.items.map((item) => item.number)).toEqual(['QT-2026-27-0001']);
  });
});
```

- **The first test checks the arithmetic to the paisa**, with both kinds of discount. Two cases at ৳504 with 10%
  off is ৳907.20 net and ৳136.08 VAT. 200 tablets at ৳1.20 with ৳40 off is ৳200, with no VAT. The header totals
  are the sums of the lines. The API works the lines out with the contracts' `lineAmounts()`, the same function
  the form uses, so these numbers are also what the form shows.
- **A line without a description gets the product's name**, and a typed description is kept. The VAT rate is
  stored on the line as it was (name and kind too), which is what the invoice will print.
- **All bad lines come back at once, each under its own field** (`lines.1.variantId`, `lines.2.unitId`,
  `lines.3.taxRateId`). The first line is good and gets no error. The form can then mark every box to fix in one
  round.
- **The form's own rules are a 400, from the contract:** a discount larger than the line, and a "valid until"
  before the quotation's date. The two errors arrive together, because the document-level rule runs even when a
  line failed.
- **Declined, a quotation cannot be changed** (`quotation_not_open`), and only a declined one can be reopened
  (`quotation_not_declined`). The stale version is tried first, so a page that was open for a while cannot
  overwrite a newer save.
- **A deleted quotation leaves a gap in the numbers.** The next one is `QT-2026-27-0002` and the deleted one is
  gone. That is fine for an offer, and it is why quotations, unlike deliveries, can be numbered when saved.

### Sales orders

```ts
describe('sales orders', () => {
  it('accept the quotation they are made from, and give it back when the draft is deleted', async () => {
    const fromQuotation = await ordered(
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(fromQuotation).toMatchObject({
      number: null,
      status: 'draft',
      quotation: { id: quotation.id, number: 'QT-2026-27-0001' },
    });
    let answered = quotationSchema.parse((await send('GET', `/quotations/${quotation.id}`)).json());
    expect(answered).toMatchObject({
      status: 'accepted',
      order: { id: fromQuotation.id, number: null },
    });

    // Accepted once: a second order from it, or one for another customer, is refused
    const twice = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(problemOf(twice).code).toBe('quotation_not_open');
    const otherCustomer = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '24', '25')], {
        customerId: ashulia.id,
        quotationId: quotation.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({
      quotationId: ['order_quotation_invalid'],
    });

    const removed = await send(
      'DELETE',
      `/sales-orders/${fromQuotation.id}?version=${String(fromQuotation.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    answered = quotationSchema.parse((await send('GET', `/quotations/${quotation.id}`)).json());
    expect(answered).toMatchObject({ status: 'open', order: null });
  });

  it("read prices the quotation's way, whatever the workspace says now", async () => {
    await setPricesIncludeVat(true);
    // Written when prices were without VAT: ৳528 + ৳79.20, as the quotation said
    const fromQuotation = await ordered(
      orderForm([salesLine(juice, '24', '22')], { quotationId: quotation.id }),
    );
    expect(fromQuotation).toMatchObject({ pricesIncludeVat: false, total: '607.2000' });
    // A new order takes the setting now: ৳504 holds ৳65.74 of VAT
    const fresh = await ordered(
      orderForm([salesLine(juice, '1', '504', { unitId: unitId('case') })]),
    );
    expect(fresh).toMatchObject({
      pricesIncludeVat: true,
      net: '438.2600',
      vat: '65.7400',
      total: '504.0000',
    });
    await setPricesIncludeVat(false);

    const { items: log } = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=sales_order&entityId=${fromQuotation.id}`)).json(),
    );
    expect(log[0]).toMatchObject({ action: 'sales_order.created' });
    expect(log[0]?.changes).toMatchObject({ quotation: { from: null, to: 'QT-2026-27-0001' } });
    const gone = await send('DELETE', `/sales-orders/${fresh.id}?version=${String(fresh.version)}`);
    expect(gone.statusCode).toBe(204);
  });

  it('get their number when confirmed, and keep the shipping address as text', async () => {
    const wrongAddress = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '1', '22')], { shippingAddressId: addressOf(ashulia) }),
    );
    expect(problemOf(wrongAddress).fieldErrors).toEqual({
      shippingAddressId: ['sales_address_invalid'],
    });
    const early = await send(
      'POST',
      '/sales-orders',
      orderForm([salesLine(juice, '1', '22')], { deliveryDate: '2026-10-01' }),
    );
    expect(problemOf(early).fieldErrors).toEqual({ deliveryDate: ['order_delivery_date'] });

    // Five cases of juice, Napa, a phone and the delivery charge, written and confirmed at once
    order = await ordered(
      orderForm(
        [
          salesLine(juice, '5', '504', { unitId: unitId('case') }),
          salesLine(napa, '150', '1.2', { taxRateId: rateId('Exempt') }),
          salesLine(phone, '1', '21500'),
          salesLine(carriage, '1', '500'),
        ],
        {
          shippingAddressId: addressOf(bhairab),
          customerReference: 'PO-BBT-0915',
          deliveryDate: '2026-10-08',
          confirm: true,
        },
      ),
    );
    expect(order).toMatchObject({
      number: 'SO-2026-27-0001',
      status: 'confirmed',
      partlyDelivered: false,
      shippingAddressId: addressOf(bhairab),
      shippingAddress: 'Bhairab godown\nStation Road, Bhairab, Kishoreganj\n01712-334455',
      customerReference: 'PO-BBT-0915',
    });
    expect(order.confirmedAt).not.toBeNull();
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '0.0000',
      '0.0000',
      '0.0000',
      '0.0000',
    ]);
  });

  it('go back to draft while nothing is delivered, keeping their number and customer', async () => {
    const small = await ordered(orderForm([salesLine(juice, '12', '22')], { confirm: true }));
    expect(small.number).toBe('SO-2026-27-0002');
    const edit = await send('PUT', `/sales-orders/${small.id}`, {
      ...orderForm([salesLine(juice, '24', '22')]),
      version: small.version,
    });
    expect(problemOf(edit).code).toBe('sales_not_draft');

    const reopened = salesOrderSchema.parse(
      (await send('POST', `/sales-orders/${small.id}/reopen`, { version: small.version })).json(),
    );
    expect(reopened).toMatchObject({
      status: 'draft',
      number: 'SO-2026-27-0002',
      confirmedAt: null,
    });
    // Its number was given out: cancelled, never deleted, and never moved to another customer
    const removed = await send(
      'DELETE',
      `/sales-orders/${small.id}?version=${String(reopened.version)}`,
    );
    expect(problemOf(removed).code).toBe('order_numbered');
    const moved = await send('PUT', `/sales-orders/${small.id}`, {
      ...orderForm([salesLine(juice, '24', '25')], { customerId: ashulia.id }),
      version: reopened.version,
    });
    expect(problemOf(moved).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });

    const confirmed = salesOrderSchema.parse(
      (
        await send('PUT', `/sales-orders/${small.id}`, {
          ...orderForm([salesLine(juice, '24', '22')], { confirm: true }),
          version: reopened.version,
        })
      ).json(),
    );
    expect(confirmed).toMatchObject({ status: 'confirmed', number: 'SO-2026-27-0002' });

    // Nothing delivered: cancelled, not closed; and a cancelled order stays cancelled
    const close = await send('POST', `/sales-orders/${small.id}/close`, {
      version: confirmed.version,
    });
    expect(problemOf(close).code).toBe('order_nothing_delivered');
    const cancelled = salesOrderSchema.parse(
      (
        await send('POST', `/sales-orders/${small.id}/cancel`, { version: confirmed.version })
      ).json(),
    );
    expect(cancelled.status).toBe('cancelled');
    const again = await send('POST', `/sales-orders/${small.id}/cancel`, {
      version: cancelled.version,
    });
    expect(problemOf(again).code).toBe('order_not_confirmed');
  });

  it('show what confirmed orders still have to deliver next to the stock', async () => {
    // The draft from the quotation and the cancelled order hold nothing; the service is not stock
    expect(await stockNow()).toEqual({
      'Mango juice 250 ml': ['240.0000', '120.0000'],
      'Napa 500 mg': ['220.0000', '150.0000'],
      'Walton Primo NH5': ['2.0000', '1.0000'],
    });
    const page = salesOrderPageSchema.parse(
      (await send('GET', '/sales-orders?status=confirmed')).json(),
    );
    expect(page.items.map((item) => item.number)).toEqual(['SO-2026-27-0001']);
  });
});
```

- **An order made from a quotation accepts it**, and the quotation shows the order (with no number yet: it is a
  draft). A second order from the same quotation gets `quotation_not_open`. An order for another customer gets
  `order_quotation_invalid` on the `quotationId` field. Deleting the draft order puts the quotation back to open.
- **An order from a quotation reads prices the quotation's way.** The workspace switches to prices with VAT, and
  the order from the old quotation still says ৳528 + ৳79.20. A new order takes the new setting: ৳504 for a case
  now holds ৳65.74 of VAT. The setting is switched back at the end, because the later tests count without VAT.
- **The audit row of the order names its quotation** (`quotation: 'QT-2026-27-0001'`). There is no separate
  "quotation accepted" row; this one says it.
- **The shipping address is stored as text** (label, address and phone on their own lines). An address of
  another customer is `sales_address_invalid`, and a delivery date before the order date is a 400 from the
  contract.
- **`confirm: true` saves and confirms in one request**, so the big order gets `SO-2026-27-0001`. Drafts never
  take a number, so the drafts deleted above used none.
- **Reopen keeps the number.** The small order is confirmed, reopened, refused a delete (`order_numbered`) and a
  change of customer (`sales_customer_invalid`), and confirmed again with the same number. A confirmed order
  cannot be edited (`sales_not_draft`) until it is reopened.
- **Nothing delivered: cancel, not close.** `close` says `order_nothing_delivered`. A cancelled order stays
  cancelled (`order_not_confirmed`).
- **"On order" counts only confirmed orders**: the draft made from the quotation and the cancelled order hold
  nothing, and the delivery charge is not stock at all.

### Deliveries

```ts
describe('deliveries', () => {
  it('take part of an order out at its average cost, and book the cost of goods sold', async () => {
    const first = await delivered(
      deliveryForm(
        [
          deliveryLine(juice, '2', {
            unitId: unitId('case'),
            orderLineId: orderLine(order, juice),
          }),
          // The lot that expires first
          deliveryLine(napa, '100', {
            batchId: await batchOf(napa, 'NP24090'),
            orderLineId: orderLine(order, napa),
          }),
          deliveryLine(phone, '1', {
            serialNumbers: ['356938035643809'],
            orderLineId: orderLine(order, phone),
          }),
        ],
        { shippingAddressId: addressOf(bhairab), vehicle: 'Dhaka Metro-Ta 11-2233, Rahim' },
      ),
    );
    expect(first).toMatchObject({
      number: 'DC-2026-27-0001',
      status: 'posted',
      order: { id: order.id, number: 'SO-2026-27-0001' },
      shippingAddress: 'Bhairab godown\nStation Road, Bhairab, Kishoreganj\n01712-334455',
    });
    // 48 pieces at ৳50, 100 tablets at ৳0.80, one phone at ৳18,000
    expect(first.lines.map((item) => [item.baseQuantity, item.value])).toEqual([
      ['48.0000', '2400.0000'],
      ['100.0000', '80.0000'],
      ['1.0000', '18000.0000'],
    ]);
    if (!first.entry) throw new Error('expected a cost of goods sold entry');
    expect(await entryLines(first.entry.id)).toEqual([
      ['5110', '20480.0000', '0.0000'],
      ['1150', '0.0000', '20480.0000'],
    ]);

    order = await orderNow(order.id);
    expect(order).toMatchObject({ status: 'confirmed', partlyDelivered: true });
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '48.0000',
      '100.0000',
      '1.0000',
      // The delivery charge is never delivered
      '0.0000',
    ]);
    expect(order.deliveries).toEqual([
      { id: first.id, number: 'DC-2026-27-0001', date: '2026-10-05', status: 'posted' },
    ]);
    expect(await stockNow()).toEqual({
      'Mango juice 250 ml': ['192.0000', '72.0000'],
      'Napa 500 mg': ['120.0000', '50.0000'],
      'Walton Primo NH5': ['1.0000', '0.0000'],
    });
    const history = stockMovementPageSchema.parse(
      (await send('GET', `/stock/variants/${variantOf(juice)}/movements`)).json(),
    );
    expect(history.items.at(-1)).toMatchObject({
      kind: 'delivery',
      documentNumber: 'DC-2026-27-0001',
      quantity: '-48.0000',
    });
  });

  it('never deliver more than the order still has to, at save and again at posting', async () => {
    const juiceLine = orderLine(order, juice);
    // 72 pieces left: four cases is 96
    const tooMuch = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '4', { unitId: unitId('case'), orderLineId: juiceLine })]),
    );
    expect(tooMuch.statusCode).toBe(409);
    expect(problemOf(tooMuch).fieldErrors).toEqual({ 'lines.0.quantity': ['delivery_over_order'] });
    // Two lines on one order line count together, and both are marked
    const split = await send(
      'POST',
      '/deliveries',
      deliveryForm([
        deliveryLine(juice, '2', { unitId: unitId('case'), orderLineId: juiceLine }),
        deliveryLine(juice, '2', { unitId: unitId('case'), orderLineId: juiceLine }),
      ]),
    );
    expect(problemOf(split).fieldErrors).toEqual({
      'lines.0.quantity': ['delivery_over_order'],
      'lines.1.quantity': ['delivery_over_order'],
    });

    // Drafts hold nothing: two of them may each take all 72. The second to post is refused.
    const draft = (quantity: string) =>
      delivered(
        deliveryForm(
          [deliveryLine(juice, quantity, { unitId: unitId('case'), orderLineId: juiceLine })],
          { post: false },
        ),
      );
    const one = await draft('3');
    const two = await draft('3');
    expect([one.number, two.number]).toEqual([null, null]);
    const posted = await postDraft(one);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(deliverySchema.parse(posted.json()).number).toBe('DC-2026-27-0002');
    const late = await postDraft(two);
    expect(late.statusCode).toBe(409);
    expect(problemOf(late).fieldErrors).toEqual({ 'lines.0.quantity': ['delivery_over_order'] });
    // Nothing of it moved, and no number was used
    const still = deliverySchema.parse((await send('GET', `/deliveries/${two.id}`)).json());
    expect(still).toMatchObject({ status: 'draft', number: null });
    const removed = await send('DELETE', `/deliveries/${two.id}?version=${String(still.version)}`);
    expect(removed.statusCode).toBe(204);
  });

  it("deliver only the order's goods, for the order's customer", async () => {
    // A juice line pointing at the Napa line of the order
    const wrongLine = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, napa) })]),
    );
    expect(problemOf(wrongLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_invalid'],
    });
    const otherCustomer = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })], {
        customerId: ashulia.id,
      }),
    );
    expect(problemOf(otherCustomer).fieldErrors).toEqual({ orderId: ['delivery_order_invalid'] });
    // The form's rule: from an order, every line names its order line; without one, none does
    const noLine = await send('POST', '/deliveries', deliveryForm([deliveryLine(juice, '1')]));
    expect(noLine.statusCode).toBe(400);
    expect(problemOf(noLine).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_required'],
    });
    // A service never leaves a warehouse, and a batch-tracked item names its batch
    const service = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(carriage, '1', { orderLineId: orderLine(order, carriage) })]),
    );
    expect(problemOf(service).fieldErrors).toEqual({
      'lines.0.variantId': ['stock_variant_invalid'],
    });
    const noBatch = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(napa, '10', { orderLineId: orderLine(order, napa) })]),
    );
    expect(problemOf(noBatch).fieldErrors).toEqual({ 'lines.0.batchId': ['stock_batch_required'] });
  });
```

- **The first delivery takes part of every goods line**: two cases of juice, 100 tablets from the lot that
  expires first, and one phone by its IMEI. Posting gives `DC-2026-27-0001` and values each line at the average
  cost (48 × ৳50, 100 × ৳0.80, 1 × ৳18,000).
- **The entry is one debit and one credit of ৳20,480**: cost of goods sold against inventory. The sale itself is
  not booked here; that is the invoice in 15c.
- **The order follows**: each line's `deliveredQuantity` moves, the order stays confirmed and is now partly
  delivered, and it lists the delivery. The service line stays at zero. On the stock page, on hand and on order
  both fall by what left.
- **The stock history shows the delivery** as a movement of kind `delivery` with the DC number, like any other
  stock document.
- **Over-delivery is refused at save**, on the quantity box of every line that takes from the same order line
  (two lines of two cases each count together).
- **Drafts hold nothing.** Two drafts may each take all 72 pieces that are left, and both save. The first to post
  wins; the second gets `delivery_over_order` at posting. It stays a draft with no number, so posting a refused
  delivery uses no number and moves no stock. (Without this check, the database guard of 15b.2 still refuses the
  posting, but as a 500. The test found that when the check was turned off on purpose.)
- **A delivery delivers only its order's goods, for its order's customer.** A juice line pointing at the Napa
  order line is `delivery_order_line_invalid`. The order of another customer is `delivery_order_invalid` on the
  `orderId` field. A line with no order line on an order's delivery is a 400 from the contract. A service is
  `stock_variant_invalid`, as on any stock document, and a batch-tracked item without a batch is
  `stock_batch_required`.

```ts
  it('finish the order with the last delivery; the service line does not count', async () => {
    // Every posting against it gave the order a new version
    order = await orderNow(order.id);
    const reopen = await send('POST', `/sales-orders/${order.id}/reopen`, {
      version: order.version,
    });
    expect(problemOf(reopen).code).toBe('order_has_deliveries');
    order = await orderNow(order.id);
    const cancel = await send('POST', `/sales-orders/${order.id}/cancel`, {
      version: order.version,
    });
    expect(problemOf(cancel).code).toBe('order_partly_delivered');

    // The last 50 tablets: the 20 left of the first lot and 30 of the next, on one order line
    const last = await delivered(
      deliveryForm([
        deliveryLine(napa, '20', {
          batchId: await batchOf(napa, 'NP24090'),
          orderLineId: orderLine(order, napa),
        }),
        deliveryLine(napa, '30', {
          batchId: await batchOf(napa, 'NP24117'),
          orderLineId: orderLine(order, napa),
        }),
      ]),
    );
    expect(last.number).toBe('DC-2026-27-0003');
    order = await orderNow(order.id);
    expect(order).toMatchObject({ status: 'delivered', partlyDelivered: false });
    expect(order.lines.map((item) => item.deliveredQuantity)).toEqual([
      '120.0000',
      '150.0000',
      '1.0000',
      '0.0000',
    ]);
    // The line says it is a service, so the order page and the delivery form can skip it (15b.6)
    expect(order.lines.map((item) => item.productType)).toEqual([
      'goods',
      'goods',
      'goods',
      'service',
    ]);
    expect(order.deliveries.map((item) => item.number)).toEqual([
      'DC-2026-27-0001',
      'DC-2026-27-0002',
      'DC-2026-27-0003',
    ]);
    const after = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })]),
    );
    expect(problemOf(after).fieldErrors).toEqual({ orderId: ['order_not_confirmed'] });
  });

  it('close a partly delivered order; a draft left on it cannot be posted', async () => {
    const shopOrder = await ordered(
      orderForm([salesLine(juice, '2', '600', { unitId: unitId('case') })], {
        customerId: ashulia.id,
        confirm: true,
      }),
    );
    const lineId = orderLine(shopOrder, juice);
    await delivered(
      deliveryForm([deliveryLine(juice, '1', { unitId: unitId('case'), orderLineId: lineId })], {
        customerId: ashulia.id,
        orderId: shopOrder.id,
      }),
    );
    const leftOver = await delivered(
      deliveryForm([deliveryLine(juice, '1', { unitId: unitId('case'), orderLineId: lineId })], {
        customerId: ashulia.id,
        orderId: shopOrder.id,
        post: false,
      }),
    );
    const now = await orderNow(shopOrder.id);
    const closed = salesOrderSchema.parse(
      (await send('POST', `/sales-orders/${shopOrder.id}/close`, { version: now.version })).json(),
    );
    expect(closed.status).toBe('closed');
    const late = await postDraft(leftOver);
    expect(problemOf(late).fieldErrors).toEqual({ orderId: ['order_not_confirmed'] });
    const removed = await send(
      'DELETE',
      `/deliveries/${leftOver.id}?version=${String(leftOver.version)}`,
    );
    expect(removed.statusCode).toBe(204);
  });

  it('go out without an order, to a customer who collects the goods', async () => {
    const counter = await delivered(
      deliveryForm([deliveryLine(juice, '6')], {
        customerId: ashulia.id,
        orderId: '',
        vehicle: 'Customer’s own van',
      }),
    );
    expect(counter).toMatchObject({ order: null, status: 'posted', vehicle: 'Customer’s own van' });
    expect(counter.lines[0]).toMatchObject({ orderLineId: null, value: '300.0000' });
    // An order line on a delivery without an order is the form's mistake
    const stray = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1', { orderLineId: orderLine(order, juice) })], {
        orderId: '',
      }),
    );
    expect(problemOf(stray).fieldErrors).toEqual({
      'lines.0.orderLineId': ['delivery_order_line_invalid'],
    });
    // 240 − 48 − 72 − 24 − 6
    expect((await stockNow())['Mango juice 250 ml']).toEqual(['90.0000', '0.0000']);
    const page = deliveryPageSchema.parse(
      (await send('GET', `/deliveries?customerId=${ashulia.id}`)).json(),
    );
    expect(page.items).toHaveLength(2);
  });

  it('stay as they are once posted', async () => {
    const [posted] = deliveryPageSchema.parse(
      (await send('GET', '/deliveries?status=posted&limit=1')).json(),
    ).items;
    if (!posted) throw new Error('no posted delivery');
    const attempts = [
      send('PUT', `/deliveries/${posted.id}`, {
        ...deliveryForm([deliveryLine(juice, '1')], { customerId: ashulia.id, orderId: '' }),
        version: posted.version,
      }),
      send('POST', `/deliveries/${posted.id}/post`, { version: posted.version }),
      send('DELETE', `/deliveries/${posted.id}?version=${String(posted.version)}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(409);
      expect(problemOf(res).code).toBe('stock_not_draft');
    }
  });

  it('refuse a date in the future and a date in closed books', async () => {
    const counter = { customerId: ashulia.id, orderId: '' };
    const future = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1')], { ...counter, date: '2099-01-01' }),
    );
    expect(problemOf(future).fieldErrors).toEqual({ date: ['stock_date_future'] });
    expect(
      (await send('PUT', '/period-lock', { lockDate: '2026-09-30', version: 0 })).statusCode,
    ).toBe(200);
    const locked = await send(
      'POST',
      '/deliveries',
      deliveryForm([deliveryLine(juice, '1')], { ...counter, date: '2026-09-20' }),
    );
    expect(problemOf(locked).code).toBe('journal_period_locked');
  });
});
```

- **The order is read again first.** Every posting against it gave it a new version, and sending an old version
  would get `version_conflict` instead of the answer the test is about.
- **A partly delivered order is neither reopened (`order_has_deliveries`) nor cancelled
  (`order_partly_delivered`).**
- **The last delivery splits one order line over two lots**: the 20 tablets left of NP24090 and 30 of NP24117.
  The order is then `delivered`, even though the delivery charge was never delivered. A delivery against a
  delivered order is `order_not_confirmed`.
- **The lines say which one is the service** (`productType`). The order's page and the delivery form rely on it
  to skip that line (15b.6).
- **Close, then post a draft that was left behind**: `order_not_confirmed`. Close and cancel do not delete the
  order's drafts (the person decides what happens to them), but those drafts can never be posted against it.
- **A delivery without an order** has no order lines. A line that names one anyway is a 400 from the contract. The
  juice's stock at the end is a sum anyone can check: 240 − 48 − 72 − 24 − 6 = 90.
- **A posted delivery is not changed, posted again or deleted** (`stock_not_draft`), like every posted stock
  document.
- **The date rules are the stock documents' rules**: a date in the future is refused, and so is a date on or
  before the period lock. This test sets the lock, so it runs last among the deliveries.

### Permissions and foreign keys

```ts
describe('who may do what', () => {
  it('lets anyone read sales documents, but not write them or see what the goods cost', async () => {
    const [first] = deliveryPageSchema
      .parse((await send('GET', `/deliveries?customerId=${bhairab.id}`, undefined, viewer)).json())
      .items.slice(-1);
    if (!first) throw new Error('no delivery');
    const seen = deliverySchema.parse(
      (await send('GET', `/deliveries/${first.id}`, undefined, viewer)).json(),
    );
    expect(seen.number).toBe('DC-2026-27-0001');
    expect(seen.lines.map((item) => item.value)).toEqual([null, null, null]);
    expect((await send('GET', `/sales-orders/${order.id}`, undefined, viewer)).statusCode).toBe(
      200,
    );
    expect((await send('GET', '/quotations', undefined, viewer)).statusCode).toBe(200);
    const prices = await lookup(bhairab.id, [
      { variantId: variantOf(juice), unitId: unitId('pcs') },
    ]);
    expect(prices.statusCode).toBe(200);

    const writes = [
      send('POST', '/quotations', quotationForm([salesLine(juice, '1', '22')]), viewer),
      send('POST', '/sales-orders', orderForm([salesLine(juice, '1', '22')]), viewer),
      send(
        'POST',
        '/deliveries',
        deliveryForm([deliveryLine(juice, '1')], { orderId: '', post: false }),
        viewer,
      ),
      send('POST', `/sales-orders/${order.id}/close`, { version: order.version }, viewer),
    ];
    for (const res of await Promise.all(writes)) expect(res.statusCode).toBe(403);
  });
});

describe('what sales documents hold on to', () => {
  it('keeps a customer or a product that a document names', async () => {
    // A customer with nothing but a quotation
    const pharmacy = await addCustomer('Narsingdi Pharmacy');
    await quoted(quotationForm([salesLine(juice, '6', '25')], { customerId: pharmacy.id }));
    const customer = await send(
      'DELETE',
      `/customers/${pharmacy.id}?version=${String(pharmacy.version)}`,
    );
    expect(customer.statusCode).toBe(409);
    expect(problemOf(customer).code).toBe('customer_in_use');
    // The delivery charge is only on an order line
    const product = await send(
      'DELETE',
      `/products/${carriage.id}?version=${String(carriage.version)}`,
    );
    expect(product.statusCode).toBe(409);
    expect(problemOf(product).code).toBe('product_in_use');
  });
});
```

- **The viewer reads every document but sees no cost**: the delivery's line values are `null`. The price lookup
  works for them too (reading prices needs no permission). Every write is a 403, decided by the route's
  permission before the service runs.
- **The viewer picks the oldest delivery** (`slice(-1)` of a list sorted newest first). The three deliveries of
  the big order share a date, and their ids (UUIDv7) are in the order they were made.
- **A customer named only on a quotation cannot be deleted** (`customer_in_use`), and neither can the delivery
  charge, which is named only on an order line (`product_in_use`). Both come from the new foreign keys of 15b.2
  through the lists in 15b.3; nothing queries "is it used?" first.

### `sales/sales.tenant-leak.int.spec.ts`: B's sales documents

```diff
@@ -9,17 +9,29 @@ import {
   customerGroupSchema,
   customerPageSchema,
   customerSchema,
+  type Delivery,
+  deliveryPageSchema,
+  deliverySchema,
   type PriceList,
   priceListListSchema,
   priceListSchema,
+  priceLookupSchema,
   type Product,
   productSchema,
   problemSchema,
+  type Quotation,
+  quotationPageSchema,
+  quotationSchema,
+  type SalesOrder,
+  salesOrderPageSchema,
+  salesOrderSchema,
   setupSchema,
   type TaxRate,
   taxRateListSchema,
   type Unit,
   unitListSchema,
+  type Warehouse,
+  warehouseListSchema,
 } from '@omnivo/contracts';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 
@@ -54,6 +66,11 @@ let customerOfB: Customer;
 let listOfB: PriceList;
 let productOfB: Product;
 let rateOfB: TaxRate;
+// Step 15b: B's quotation, its confirmed order and a draft delivery against it
+let quotationOfB: Quotation;
+let orderOfB: SalesOrder;
+let deliveryOfB: Delivery;
+let warehouseOfB: Warehouse;
 
 function as(
   who: SignedIn,
@@ -381,3 +398,286 @@ describe('customer isolation over HTTP', () => {
     expect(customerSchema.parse(res.json()).code).toBe(customerOfB.code);
   });
 });
+
+describe('sales document isolation over HTTP', () => {
+  let customerOfA: Customer;
+  let productOfA: Product;
+  let warehouseOfA: Warehouse;
+  let rateOfA: string;
+
+  function lineOf(product: Product, taxRateId: string) {
+    return {
+      variantId: product.variants[0]?.id,
+      unitId: product.baseUnitId,
+      quantity: '12',
+      description: '',
+      unitPrice: '22',
+      discountType: 'percent',
+      discount: '',
+      taxRateId,
+    };
+  }
+
+  function orderBody(customerId: string, warehouseId: string, line: object, extra: object = {}) {
+    return {
+      customerId,
+      date: '2026-10-02',
+      deliveryDate: '',
+      customerReference: '',
+      warehouseId,
+      shippingAddressId: '',
+      note: '',
+      lines: [line],
+      confirm: false,
+      ...extra,
+    };
+  }
+
+  function deliveryBody(customerId: string, orderId: string, warehouseId: string, line: object) {
+    return {
+      customerId,
+      orderId,
+      date: '2026-10-05',
+      warehouseId,
+      shippingAddressId: '',
+      vehicle: '',
+      note: '',
+      lines: [line],
+      post: false,
+    };
+  }
+
+  beforeAll(async () => {
+    // B: a quotation, the order made from it (confirmed), and a draft delivery of half of it
+    const [warehouse] = warehouseListSchema.parse(
+      (await as(tenantB, 'GET', '/warehouses')).json(),
+    ).items;
+    if (!warehouse) throw new Error('B has no warehouse');
+    warehouseOfB = warehouse;
+    const quote = await as(tenantB, 'POST', '/quotations', {
+      customerId: customerOfB.id,
+      date: '2026-10-01',
+      validUntil: '',
+      note: '',
+      lines: [lineOf(productOfB, rateOfB.id)],
+    });
+    expect(quote.statusCode, quote.body).toBe(201);
+    quotationOfB = quotationSchema.parse(quote.json());
+    const order = await as(
+      tenantB,
+      'POST',
+      '/sales-orders',
+      orderBody(customerOfB.id, warehouseOfB.id, lineOf(productOfB, rateOfB.id), {
+        quotationId: quotationOfB.id,
+        confirm: true,
+      }),
+    );
+    expect(order.statusCode, order.body).toBe(201);
+    orderOfB = salesOrderSchema.parse(order.json());
+    // Accepted by the order: a new version. A's attempts below send the current one, so only the
+    // tenant check stands between them and B's rows.
+    quotationOfB = quotationSchema.parse(
+      (await as(tenantB, 'GET', `/quotations/${quotationOfB.id}`)).json(),
+    );
+    const delivery = await as(
+      tenantB,
+      'POST',
+      '/deliveries',
+      deliveryBody(customerOfB.id, orderOfB.id, warehouseOfB.id, {
+        variantId: productOfB.variants[0]?.id,
+        unitId: productOfB.baseUnitId,
+        quantity: '6',
+        batchId: '',
+        serialNumbers: [],
+        orderLineId: orderOfB.lines[0]?.id,
+      }),
+    );
+    expect(delivery.statusCode, delivery.body).toBe(201);
+    deliveryOfB = deliverySchema.parse(delivery.json());
+
+    // A: its own customer, product, warehouse and VAT rate
+    customerOfA = customerSchema.parse(
+      (await as(tenantA, 'POST', '/customers', customerForm('Lindqvist Knitwear AB'))).json(),
+    );
+    const product = await as(
+      tenantA,
+      'POST',
+      '/products',
+      productForm('Knit polo shirt', unitsOfA, {
+        variants: [
+          { id: null, sku: '', optionValues: [], barcode: '', salePrice: '450', archived: false },
+        ],
+      }),
+    );
+    expect(product.statusCode, product.body).toBe(201);
+    productOfA = productSchema.parse(product.json());
+    const [own] = warehouseListSchema.parse((await as(tenantA, 'GET', '/warehouses')).json()).items;
+    if (!own) throw new Error('A has no warehouse');
+    warehouseOfA = own;
+    const rates = taxRateListSchema.parse((await as(tenantA, 'GET', '/tax-rates')).json()).items;
+    const standard = rates.find((rate) => rate.isDefault);
+    if (!standard) throw new Error('A has no default rate');
+    rateOfA = standard.id;
+  });
+
+  it("never lists or reads B's quotations, orders or deliveries", async () => {
+    const quotations = quotationPageSchema.parse((await as(tenantA, 'GET', '/quotations')).json());
+    expect(quotations.items).toEqual([]);
+    const orders = salesOrderPageSchema.parse((await as(tenantA, 'GET', '/sales-orders')).json());
+    expect(orders.items).toEqual([]);
+    const deliveries = deliveryPageSchema.parse((await as(tenantA, 'GET', '/deliveries')).json());
+    expect(deliveries.items).toEqual([]);
+    // Not even when A filters by B's customer
+    const byCustomer = await as(tenantA, 'GET', `/sales-orders?customerId=${customerOfB.id}`);
+    expect(salesOrderPageSchema.parse(byCustomer.json()).items).toEqual([]);
+    for (const url of [
+      `/quotations/${quotationOfB.id}`,
+      `/sales-orders/${orderOfB.id}`,
+      `/deliveries/${deliveryOfB.id}`,
+    ]) {
+      expect((await as(tenantA, 'GET', url)).statusCode, url).toBe(404);
+    }
+  });
+
+  it('cannot change, answer, confirm, deliver, post or delete any of them', async () => {
+    const line = lineOf(productOfA, rateOfA);
+    const quotation = { version: quotationOfB.version };
+    const order = { version: orderOfB.version };
+    const attempts = [
+      as(tenantA, 'PUT', `/quotations/${quotationOfB.id}`, {
+        customerId: customerOfA.id,
+        date: '2026-10-01',
+        validUntil: '',
+        note: '',
+        lines: [line],
+        ...quotation,
+      }),
+      as(tenantA, 'POST', `/quotations/${quotationOfB.id}/decline`, quotation),
+      as(tenantA, 'POST', `/quotations/${quotationOfB.id}/reopen`, quotation),
+      as(tenantA, 'DELETE', `/quotations/${quotationOfB.id}?version=1`),
+      as(tenantA, 'PUT', `/sales-orders/${orderOfB.id}`, {
+        ...orderBody(customerOfA.id, warehouseOfA.id, line),
+        ...order,
+      }),
+      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/confirm`, order),
+      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/reopen`, order),
+      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/close`, order),
+      as(tenantA, 'POST', `/sales-orders/${orderOfB.id}/cancel`, order),
+      as(tenantA, 'DELETE', `/sales-orders/${orderOfB.id}?version=1`),
+      as(tenantA, 'PUT', `/deliveries/${deliveryOfB.id}`, {
+        ...deliveryBody(customerOfA.id, '', warehouseOfA.id, {
+          variantId: productOfA.variants[0]?.id,
+          unitId: productOfA.baseUnitId,
+          quantity: '1',
+          batchId: '',
+          serialNumbers: [],
+          orderLineId: '',
+        }),
+        version: deliveryOfB.version,
+      }),
+      as(tenantA, 'POST', `/deliveries/${deliveryOfB.id}/post`, { version: deliveryOfB.version }),
+      as(tenantA, 'DELETE', `/deliveries/${deliveryOfB.id}?version=1`),
+    ];
+    for (const res of await Promise.all(attempts)) expect(res.statusCode, res.body).toBe(404);
+
+    // B's documents are as B left them
+    const quotationNow = quotationSchema.parse(
+      (await as(tenantB, 'GET', `/quotations/${quotationOfB.id}`)).json(),
+    );
+    expect(quotationNow).toMatchObject({ status: 'accepted', version: quotationOfB.version });
+    const orderNow = salesOrderSchema.parse(
+      (await as(tenantB, 'GET', `/sales-orders/${orderOfB.id}`)).json(),
+    );
+    expect(orderNow).toMatchObject({ status: 'confirmed', version: orderOfB.version });
+    const deliveryNow = deliverySchema.parse(
+      (await as(tenantB, 'GET', `/deliveries/${deliveryOfB.id}`)).json(),
+    );
+    expect(deliveryNow).toMatchObject({ status: 'draft', version: deliveryOfB.version });
+  });
+
+  it("cannot write its own documents with B's customer, item, VAT rate, quotation or order", async () => {
+    const quotation = (customerId: string, line: object) =>
+      as(tenantA, 'POST', '/quotations', {
+        customerId,
+        date: '2026-10-01',
+        validUntil: '',
+        note: '',
+        lines: [line],
+      });
+    const forB = await quotation(customerOfB.id, lineOf(productOfA, rateOfA));
+    expect(problemOf(forB).fieldErrors).toEqual({ customerId: ['sales_customer_invalid'] });
+    const itemOfB = await quotation(customerOfA.id, lineOf(productOfB, rateOfA));
+    expect(problemOf(itemOfB).fieldErrors).toEqual({ 'lines.0.variantId': ['sales_item_invalid'] });
+    const vatOfB = await quotation(customerOfA.id, lineOf(productOfA, rateOfB.id));
+    expect(problemOf(vatOfB).fieldErrors).toEqual({ 'lines.0.taxRateId': ['tax_rate_invalid'] });
+
+    const fromQuotationOfB = await as(
+      tenantA,
+      'POST',
+      '/sales-orders',
+      orderBody(customerOfA.id, warehouseOfA.id, lineOf(productOfA, rateOfA), {
+        quotationId: quotationOfB.id,
+      }),
+    );
+    expect(problemOf(fromQuotationOfB).fieldErrors).toEqual({
+      quotationId: ['order_quotation_invalid'],
+    });
+    const fromWarehouseOfB = await as(
+      tenantA,
+      'POST',
+      '/sales-orders',
+      orderBody(customerOfA.id, warehouseOfB.id, lineOf(productOfA, rateOfA)),
+    );
+    expect(problemOf(fromWarehouseOfB).fieldErrors).toEqual({
+      warehouseId: ['stock_warehouse_invalid'],
+    });
+
+    const againstOrderOfB = await as(
+      tenantA,
+      'POST',
+      '/deliveries',
+      deliveryBody(customerOfA.id, orderOfB.id, warehouseOfA.id, {
+        variantId: productOfA.variants[0]?.id,
+        unitId: productOfA.baseUnitId,
+        quantity: '1',
+        batchId: '',
+        serialNumbers: [],
+        orderLineId: orderOfB.lines[0]?.id,
+      }),
+    );
+    expect(problemOf(againstOrderOfB).fieldErrors).toEqual({ orderId: ['delivery_order_invalid'] });
+  });
+
+  it("prices nothing from B's price lists or items", async () => {
+    const res = await as(tenantA, 'POST', '/sales/price-lookup', {
+      customerId: customerOfB.id,
+      items: [
+        { variantId: productOfB.variants[0]?.id, unitId: productOfB.baseUnitId },
+        { variantId: productOfA.variants[0]?.id, unitId: productOfA.baseUnitId },
+      ],
+    });
+    expect(res.statusCode, res.body).toBe(200);
+    // B's juice is left out; A's shirt has its own price, never one from B's dealer list
+    expect(priceLookupSchema.parse(res.json()).items).toEqual([
+      {
+        variantId: productOfA.variants[0]?.id,
+        unitId: productOfA.baseUnitId,
+        price: '450.0000',
+        source: 'product',
+        taxRateId: rateOfA,
+      },
+    ]);
+  });
+
+  it("numbers its sales documents on its own: B's numbers take nothing from A", async () => {
+    const res = await as(tenantA, 'POST', '/quotations', {
+      customerId: customerOfA.id,
+      date: '2026-10-01',
+      validUntil: '',
+      note: '',
+      lines: [lineOf(productOfA, rateOfA)],
+    });
+    expect(res.statusCode, res.body).toBe(201);
+    expect(quotationSchema.parse(res.json()).number).toBe(quotationOfB.number);
+  });
+});
```

- **B's documents are made in the `describe`'s own `beforeAll`**: a quotation, an order made from it and
  confirmed, and a draft delivery of half of it. A draft is enough: it needs no stock, and it is the only kind of
  delivery that can still be changed or posted, so A's attempts have something to try.
- **B's quotation is read again after the order accepted it.** A's attempts then send B's current versions, so
  only the tenant check stands between A and B's rows. With an old version, a leak would hide behind a
  `version_conflict`.
- **`deliveryBody()` takes the warehouse.** B's delivery is made before A's setup, and each side uses its own
  warehouse.
- **Every read and every write is a 404**: list, get, change, decline, reopen, confirm, close, cancel, post and
  delete. Afterwards B's three documents are exactly as B left them (status and version).
- **A cannot use B's records in its own documents.** B's customer, variant and VAT rate get the same answers as an
  id that does not exist (`sales_customer_invalid`, `sales_item_invalid`, `tax_rate_invalid`). B's quotation is
  `order_quotation_invalid`, B's warehouse `stock_warehouse_invalid`, B's order `delivery_order_invalid`.
- **The price lookup prices nothing of B's.** B's variant is left out of the answer, and with B's customer A's
  own shirt gets A's own price (`product`), never a price from B's list.
- **Numbers are per workspace**: A's first quotation has the same number as B's.

The RLS coverage test (`rls-coverage.tenant-leak.int.spec.ts`) needs no change: it finds the six new tables by
their `tenant_id` column and checks that each has row-level security turned on and forced, with a policy.

### `numbering/numbering.int.spec.ts`: two more number series

```diff
@@ -101,7 +101,17 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(11);
+    expect(items.map((series) => series.documentType)).toHaveLength(13);
+    // Quotations and deliveries (step 15b): numbered by fiscal year. A quotation takes its number
+    // when it is saved, a delivery when it is posted; this list only shows the next one.
+    expect(items.find((series) => series.documentType === 'sales.quotation')).toMatchObject({
+      prefix: 'QT',
+      nextNumber: `QT-${today}-0001`,
+    });
+    expect(items.find((series) => series.documentType === 'sales.delivery')).toMatchObject({
+      prefix: 'DC',
+      nextNumber: `DC-${today}-0001`,
+    });
     // Customer codes (step 15a): like product codes, no year and five digits
     expect(items.find((series) => series.documentType === 'sales.customer')).toMatchObject({
       prefix: 'C',
```

- **13 series, not 11.** The list has one row per document type in the contract, and 15b.1 added
  `sales.quotation` (QT) and `sales.delivery` (DC). `sales.order` (SO) was in the list long before 15b, so it is
  not new.
- **The two new rows are checked like the older ones**: the prefix, and the next number with the fiscal year in
  it. Reading the list never uses a number up, so both still start at `0001`.

### `setup/setup.int.spec.ts`: the garments roles

```diff
@@ -146,10 +146,24 @@ describe('starting the setup', () => {
           'sales.price_list.manage',
         ],
       ],
-      ['Merchandiser', ['core.user.read', 'inventory.product.manage', 'sales.customer.manage']],
+      [
+        'Merchandiser',
+        [
+          'core.user.read',
+          'inventory.product.manage',
+          'sales.customer.manage',
+          'sales.order.manage',
+          'sales.quotation.manage',
+        ],
+      ],
       [
         'Store keeper',
-        ['inventory.product.manage', 'inventory.stock.adjust', 'inventory.stock.transfer'],
+        [
+          'inventory.product.manage',
+          'inventory.stock.adjust',
+          'inventory.stock.transfer',
+          'sales.delivery.manage',
+        ],
       ],
     ]);
     const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
```

- **The test sets up a garments workspace and reads its roles back**, so it sees the two garments roles 15b.3
  changed: the Merchandiser now writes quotations and orders, and the Store keeper posts deliveries. The API sends
  each role's permissions sorted by key, which is why `sales.order.manage` comes before `sales.quotation.manage`.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api exec vitest run src/sales src/numbering src/setup --maxWorkers=3
pnpm --filter @omnivo/api test:tenant-leak
```

The `vitest` line runs only the files this part touches (about a minute). `pnpm test:integration` runs all of them;
part 15b.8 runs every check once at the end.

> **What we checked in this part.** The API type-checks, and ESLint and Prettier are clean. All API integration
> and tenant-leak tests pass: 24 integration files (278 tests) and 13 tenant-leak files (55 tests), run with two
> and three workers. One test was also checked by breaking the code on purpose: without the second
> `checkOrderLines()` in `postAndLog()`, the "second draft to post" test gets a 500 from the database guard
> instead of `delivery_over_order`, and the "last delivery" test finds four deliveries instead of three.

## 15b.5 — `packages/i18n` and `packages/ui`: the words, and a discount box

The pages of 15b.6 need their words in English and Bangla, and one new control: a discount box that can hold a
percent or an amount. Both come before the app, because the app cannot type-check without them. After this part
the app has one type error left, in the MSW mock (`onOrder` on a stock item), which 15b.7 fixes. No error is about a
missing word.

### `locales/en.ts`

```diff
@@ -72,6 +72,9 @@ export const en = {
     customers: 'Customers',
     customerGroups: 'Customer groups',
     priceLists: 'Price lists',
+    quotations: 'Quotations',
+    salesOrders: 'Sales orders',
+    deliveries: 'Deliveries',
   },
   auth: {
     workspace: 'Workspace',
@@ -205,7 +208,13 @@ export const en = {
       next: 'Next number',
     },
     documents: {
-      sales: { invoice: 'Sales invoice', order: 'Sales order', customer: 'Customer code' },
+      sales: {
+        invoice: 'Sales invoice',
+        order: 'Sales order',
+        customer: 'Customer code',
+        quotation: 'Quotation',
+        delivery: 'Delivery challan',
+      },
       purchase: { order: 'Purchase order', bill: 'Supplier bill' },
       inventory: {
         receipt: 'Goods receipt (GRN)',
@@ -421,6 +430,7 @@ export const en = {
       stock_adjustment: 'Stock adjustment',
       stock_transfer: 'Stock transfer',
       stock_revaluation: 'Stock revaluation',
+      sales_delivery: 'Delivery',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -947,6 +957,7 @@ export const en = {
       product: 'Product',
       onHand: 'On hand',
       inTransit: 'In transit',
+      onOrder: 'On order',
       unitCost: 'Average cost',
       value: 'Value',
       status: 'Status',
@@ -954,6 +965,8 @@ export const en = {
     statuses: { low: 'Low', out: 'Out of stock', negative: 'Below zero', archived: 'Archived' },
     newAdjustment: 'New adjustment',
     newTransfer: 'New transfer',
+    // Under the "On order" column header: why it is not taken off "On hand"
+    onOrderHint: 'Ordered by customers, not delivered yet. Nothing is held for it.',
     emptyTitle: 'No stock yet',
     emptyBody:
       'Post your opening stock with an adjustment: every product counted on your first day, warehouse by warehouse.',
@@ -1016,6 +1029,7 @@ export const en = {
       transfer_out: 'Sent',
       transfer_in: 'Received',
       revaluation: 'Revaluation',
+      delivery: 'Delivered',
     },
     historyEmpty: 'No movement in these dates.',
   },
@@ -1340,6 +1354,7 @@ export const en = {
     searchPlaceholder: 'Name, code, contact person or phone',
     group: 'Group',
     allGroups: 'All groups',
+    allCustomers: 'All customers',
     show: 'Show',
     statuses: { active: 'Active', archived: 'Archived' },
     columns: {
@@ -1549,6 +1564,238 @@ export const en = {
     itemsNoMatchBody: 'Check the spelling, or add the item.',
     itemsLoadFailed: "Couldn't load the prices. Refresh the page to try again.",
   },
+  // What the three sales documents share: the line editor, its "Add items" dialog and the totals
+  salesLines: {
+    items: 'Items',
+    addItems: 'Add items',
+    pickerTitle: 'Add items',
+    pickerDescription:
+      'Search products and services. Each click adds a line in its selling unit, at this customer’s price.',
+    pickerSearch: 'Search products and services',
+    pickerEmpty: 'No active product matches. Check the spelling, or search by code or SKU.',
+    add: 'Add',
+    added: 'Added',
+    service: 'Service',
+    line: 'Line {{number}}',
+    remove: 'Remove line {{number}}',
+    item: 'Item',
+    description: 'Description',
+    quantity: 'Quantity',
+    unit: 'Unit',
+    price: 'Price',
+    priceWithVat: 'Price with VAT',
+    priceWithoutVat: 'Price before VAT',
+    discount: 'Discount',
+    vatRate: 'VAT rate',
+    amount: 'Amount',
+    // Where a new line's price came from (the price lookup)
+    fromPriceList: 'From their price list',
+    fromProduct: 'Product price',
+    noPrice: 'No price set: type one',
+    reprice: 'Use this customer’s prices on every line',
+    repriced: 'Prices updated',
+    noLines: 'No items yet. Add what the customer asked for.',
+    tooMany: 'A document holds up to {{max}} lines. Write a second one for the rest.',
+    lineCount_one: '{{count}} item',
+    lineCount_other: '{{count}} items',
+    lineDiscounts: 'Line discounts',
+    net: 'Before VAT',
+    vat: 'VAT',
+    total: 'Total',
+    pricesWithVat: 'Prices include VAT',
+    pricesWithoutVat: 'Prices before VAT',
+  },
+  quotations: {
+    title: 'Quotations',
+    description: 'Offers to customers: these items, at these prices, until a date',
+    new: 'New quotation',
+    newTitle: 'New quotation',
+    back: 'Quotations',
+    show: 'Show',
+    all: 'All',
+    statuses: { open: 'Open', accepted: 'Accepted', declined: 'Declined' },
+    // An open quotation past its "valid until" date. Worked out by the app, not stored.
+    expired: 'Expired',
+    columns: {
+      number: 'Number',
+      customer: 'Customer',
+      validUntil: 'Valid until',
+      total: 'Total',
+      status: 'Status',
+    },
+    customer: 'Customer',
+    date: 'Date',
+    validUntil: 'Valid until',
+    validUntilHint: 'Leave it empty if the offer has no end date.',
+    noEndDate: 'No end date',
+    note: 'Note',
+    notePlaceholder: 'Prices ex-factory Gazipur. Delivery within 15 days of the order.',
+    save: 'Save quotation',
+    saved: '{{number}} saved',
+    makeOrder: 'Make order',
+    edit: 'Edit',
+    decline: 'Mark declined',
+    declined: '{{number}} marked declined',
+    reopen: 'Open again',
+    reopened: '{{number}} is open again',
+    delete: 'Delete quotation',
+    confirmDelete: 'Delete {{number}}',
+    deleteWarning: 'This cannot be undone. Its number is not used again.',
+    deleted: '{{number}} deleted',
+    expiredNotice:
+      'This offer ended on {{date}}. If the customer still accepts it, make the order as usual.',
+    acceptedOn: 'Accepted on {{number}}',
+    acceptedOnDraft: 'Accepted on a draft order',
+    declinedNotice: 'The customer said no. Open it again if they change their mind.',
+    cantWrite:
+      'You can view quotations. Ask a workspace owner for the sales.quotation.manage permission to write them.',
+    notFound: "This quotation doesn't exist, or it was deleted.",
+    emptyTitle: 'No quotations yet',
+    emptyBody:
+      'Write one when a buyer asks for prices, like 2,000 polo shirts for a Gulshan retailer. Make it an order when they say yes.',
+    loadFailed: "Couldn't load the quotations. Refresh the page to try again.",
+  },
+  salesOrders: {
+    title: 'Sales orders',
+    description: 'What customers ordered, and how much of it has gone out',
+    new: 'New order',
+    newTitle: 'New sales order',
+    draftTitle: 'Draft order',
+    back: 'Sales orders',
+    show: 'Show',
+    all: 'All',
+    statuses: {
+      draft: 'Draft',
+      confirmed: 'Confirmed',
+      delivered: 'Delivered',
+      closed: 'Closed',
+      cancelled: 'Cancelled',
+    },
+    partlyDelivered: 'Partly delivered',
+    // Confirmed, and its delivery date has passed
+    late: 'Late',
+    columns: {
+      number: 'Number',
+      customer: 'Customer',
+      deliveryDate: 'Delivery date',
+      total: 'Total',
+      status: 'Status',
+    },
+    customer: 'Customer',
+    customerLocked: 'The customer stays: this order has a number, or comes from a quotation.',
+    date: 'Order date',
+    deliveryDate: 'Delivery date',
+    deliveryDateHint: 'When the customer expects the goods',
+    customerReference: 'Customer’s reference',
+    customerReferenceHint: 'Their PO or indent number, to quote on the challan and the invoice',
+    customerReferencePlaceholder: 'PO-HM-2026-1187',
+    warehouse: 'Send from',
+    warehouseHint: 'A delivery can still take the goods from another warehouse.',
+    shippingAddress: 'Send to',
+    noShippingAddress: 'No address',
+    note: 'Note',
+    notePlaceholder: '12 pieces per carton, the buyer’s hangtag on each',
+    quotation: 'Quotation',
+    saveDraft: 'Save draft',
+    confirm: 'Confirm order',
+    confirming: 'Confirming…',
+    confirmed: '{{number}} confirmed',
+    draftSaved: 'Draft saved',
+    confirmHint:
+      'Confirming gives the order its number, and deliveries can then take goods against it. Nothing is held in the warehouse.',
+    numberedDraft:
+      'This draft keeps its number {{number}}. Confirm it again when the changes are done.',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning:
+      'A deleted draft cannot be brought back. The quotation it came from is open again.',
+    deleted: 'Draft deleted',
+    deliver: 'New delivery',
+    reopen: 'Back to draft',
+    reopenTitle: 'Take {{number}} back to draft',
+    reopenBody: 'You can then change it and confirm it again. It keeps its number.',
+    reopened: '{{number}} is a draft again',
+    close: 'Close order',
+    closeTitle: 'Close {{number}}',
+    closeBody:
+      'What is not delivered yet is dropped: the customer keeps what they got. Draft deliveries of this order can no longer be posted.',
+    closed: '{{number}} closed',
+    cancel: 'Cancel order',
+    cancelTitle: 'Cancel {{number}}',
+    cancelBody: 'The order is called off. It stays in the list as cancelled.',
+    cancelled: '{{number}} cancelled',
+    keepOrder: 'Keep the order',
+    delivered: 'Delivered',
+    left: 'Left to deliver',
+    serviceLine: 'A service: not delivered',
+    deliveriesTitle: 'Deliveries',
+    deliveriesSubtitle: 'Challans that took goods against this order',
+    noDeliveries: 'Nothing delivered yet.',
+    confirmedOn: 'Confirmed {{date}}',
+    cantWrite:
+      'You can view sales orders. Ask a workspace owner for the sales.order.manage permission to write them.',
+    notFound: "This order doesn't exist, or it was a draft that was deleted.",
+    emptyTitle: 'No sales orders yet',
+    emptyBody:
+      'Write an order when a customer says what they want, like 400 cartons of mango juice for the Mirpur depot, or make one from a quotation.',
+    loadFailed: "Couldn't load the sales orders. Refresh the page to try again.",
+  },
+  deliveries: {
+    title: 'Deliveries',
+    description: 'Delivery challans: goods that leave a warehouse for a customer',
+    new: 'New delivery',
+    newTitle: 'New delivery',
+    draftTitle: 'Draft delivery',
+    back: 'Deliveries',
+    show: 'Show',
+    all: 'All',
+    statuses: { draft: 'Draft', posted: 'Posted' },
+    columns: {
+      number: 'Number',
+      customer: 'Customer',
+      order: 'Order',
+      warehouse: 'Warehouse',
+      lines: 'Items',
+      status: 'Status',
+    },
+    customer: 'Customer',
+    order: 'Sales order',
+    noOrder: 'No order',
+    orderHint: 'A confirmed order of this customer, or none for goods they collect without one.',
+    date: 'Date',
+    warehouse: 'From warehouse',
+    shippingAddress: 'Send to',
+    noShippingAddress: 'No address',
+    vehicle: 'Vehicle and driver',
+    vehiclePlaceholder: 'Dhaka Metro-Ta 11-2233, Rahim',
+    note: 'Note',
+    notePlaceholder: 'Received by the depot manager. 2 cartons dented.',
+    fillFromOrder: 'Add what is left on the order',
+    nothingLeft: 'Nothing is left to deliver on this order.',
+    ordered: 'Ordered {{quantity}}',
+    leftOnOrder: '{{quantity}} left on the order',
+    saveDraft: 'Save draft',
+    post: 'Post delivery',
+    posting: 'Posting…',
+    posted: '{{number}} posted',
+    draftSaved: 'Draft saved',
+    deleteDraft: 'Delete draft',
+    confirmDelete: 'Delete this draft',
+    deleteWarning: 'A deleted draft cannot be brought back.',
+    deleted: 'Draft deleted',
+    postHint:
+      'Posting takes the stock out and books what it cost. A posted delivery never changes: goods that come back are a return.',
+    cantWrite:
+      'You can view deliveries. Ask a workspace owner for the sales.delivery.manage permission to write and post them.',
+    postedOn: 'Posted {{date}}',
+    entry: 'Journal entry',
+    noEntry: 'No journal entry: the goods had no cost in the books',
+    notFound: 'This delivery no longer exists. A draft may have been deleted.',
+    emptyTitle: 'No deliveries yet',
+    emptyBody:
+      'Deliver a confirmed order from its page, or write a delivery for a customer who collects goods without an order.',
+    loadFailed: "Couldn't load the deliveries. Refresh the page to try again.",
+  },
   yearEnd: {
     title: 'Year-end close',
     description: "Move each year's profit into retained earnings and close its dates",
@@ -1718,6 +1965,9 @@ export const en = {
         balance: 'See what customers owe, and their statements',
       },
       price_list: { manage: 'Add price lists and change their prices' },
+      quotation: { manage: 'Write quotations, and mark them declined' },
+      order: { manage: 'Write, confirm, close and cancel sales orders' },
+      delivery: { manage: 'Write and post deliveries: goods leave the warehouse' },
     },
   },
   invite: {
@@ -1769,6 +2019,9 @@ export const en = {
       customer: 'Customers',
       customer_group: 'Customer groups',
       price_list: 'Price lists',
+      quotation: 'Quotations',
+      sales_order: 'Sales orders',
+      delivery: 'Deliveries',
     },
     columns: {
       when: 'When',
@@ -1912,6 +2165,28 @@ export const en = {
         restored: 'Restored a price list',
         prices_changed: 'Changed prices in a price list',
       },
+      quotation: {
+        created: 'Wrote a quotation',
+        updated: 'Edited a quotation',
+        deleted: 'Deleted a quotation',
+        declined: 'Marked a quotation declined',
+        reopened: 'Opened a declined quotation again',
+      },
+      sales_order: {
+        created: 'Wrote a sales order',
+        updated: 'Edited a draft order',
+        deleted: 'Deleted a draft order',
+        confirmed: 'Confirmed a sales order',
+        reopened: 'Took a sales order back to draft',
+        closed: 'Closed a sales order',
+        cancelled: 'Cancelled a sales order',
+      },
+      delivery: {
+        created: 'Wrote a delivery',
+        updated: 'Edited a draft delivery',
+        deleted: 'Deleted a draft delivery',
+        posted: 'Posted a delivery',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -2000,6 +2275,13 @@ export const en = {
       customers: 'Customers',
       set: 'Prices set',
       removed: 'Prices removed',
+      customer: 'Customer',
+      validUntil: 'Valid until',
+      quotation: 'Quotation',
+      deliveryDate: 'Delivery date',
+      customerReference: 'Customer’s reference',
+      order: 'Sales order',
+      vehicle: 'Vehicle',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
@@ -2350,6 +2632,37 @@ export const en = {
     journal_party_invalid: 'Pick an active customer. This one is archived or was deleted.',
     opening_balance_twice:
       'This account is here twice. Put the amount on one line, or pick another customer.',
+    sales_customer_required: 'Pick the customer.',
+    sales_customer_invalid:
+      'Pick an active customer. An order that has a number, or comes from a quotation, keeps its customer.',
+    sales_date_required: 'Enter the date.',
+    sales_lines_required: 'Add at least one item.',
+    sales_price_required: 'Enter a price. Type 0 for a free item.',
+    sales_discount_too_large:
+      'The discount is more than the line: at most 100%, or the line’s amount.',
+    sales_address_invalid: 'Pick one of this customer’s addresses.',
+    sales_not_draft: 'This is no longer a draft. Reload the page to see it as it is now.',
+    sales_item_invalid: 'Pick an active product. This one is archived or was deleted.',
+    quotation_valid_until: 'The offer cannot end before the quotation’s date.',
+    quotation_not_open:
+      'Only an open quotation can be changed, declined or made an order. Reload the page to see it as it is now.',
+    quotation_not_declined: 'Only a declined quotation can be opened again.',
+    order_delivery_date: 'The delivery date cannot be before the order date.',
+    order_not_confirmed:
+      'Only a confirmed order can be delivered, closed or cancelled. Reload the page to see where it is now.',
+    order_has_deliveries:
+      'This order has a delivery, so it stays confirmed. Delete its draft deliveries first; if goods went out, close it and write a new order.',
+    order_nothing_delivered: 'Nothing is delivered yet. Cancel the order instead.',
+    order_partly_delivered: 'Part of this order is delivered. Close it instead.',
+    order_numbered:
+      'This order has a number, so it cannot be deleted. Confirm it again, then cancel it.',
+    order_quotation_invalid: 'Pick an open quotation of this customer.',
+    delivery_order_invalid: 'Pick a confirmed order of this customer.',
+    delivery_order_line_required:
+      'This item is not on the order. Remove the line, or deliver it without an order.',
+    delivery_order_line_invalid:
+      'This line does not match the chosen order. Remove it, and add it again from the order.',
+    delivery_over_order: 'This is more than the order has left to deliver. Lower the quantity.',
     import_options_without_code:
       'Give rows with options a code: rows with the same code are one product.',
     invalid_cursor: 'This list has changed. Reload the page and try again.',
@@ -2382,5 +2695,8 @@ export const en = {
       loading: 'Searching…',
       empty: 'Nothing matches',
     },
+    discountInput: {
+      type: 'Discount in percent or taka',
+    },
   },
 };
```

- **New keys go into `en.ts` first** (CLAUDE.md → Language). `bn.ts` has the type `Messages`, which is taken from
  `en`, so a key that is missing in Bangla fails the type check. The `errors` object ends with
  `satisfies Record<ErrorCode, string>`: the 23 error codes that 15b.1 and 15b.3 added must all be here, or the
  i18n package itself does not compile. That was the only error in this package when this part started.
- **Keys built from contract values.** The numbering page calls `` t(`numbering.documents.${type}`) ``, the journal
  `` t(`journal.sources.${source}`) ``, the stock card `` t(`stock.kinds.${kind}`) ``, the roles matrix
  `` t(`permissions.${key}`) `` and the audit log `` t(`audit.actions.${action}`) `` and
  `` t(`audit.entityTypes.${type}`) ``. These template strings are typed from the contract's unions, so the two new
  number series (QT, DC), the new journal source `sales_delivery`, the new movement kind `delivery`, the three
  permissions, the 16 audit actions and the three entity types each need a key here. Without one, the app fails
  to type-check, which is better than a raw key on the screen.
- **`numbering.documents.sales` is now one key per line.** It had three keys on one line; with five, Prettier
  splits it. `sales.order` was there long before 15b, so only `quotation` and `delivery` are new.
- **`stock.kinds.delivery` is "Delivered".** The stock card's history names each movement by what happened to the
  goods ("Sent", "Received"), so a delivery line says "Delivered", and its document number links the challan.
- **`stock.columns.onOrder` and `stock.onOrderHint`.** "On order" is a new column on the stock page (15b.3 sends
  `onOrder` with every stock item). It is not taken off "On hand": you chose not to hold stock for an order. The
  hint, a line above the table, says exactly that, because a store keeper would otherwise read "On hand 120, On
  order 80" as "40 left for others" and refuse a walk-in buyer.
- **`customers.allCustomers`** is the first option of the customer filter on the three lists. It sits with the
  customer words because the quotations, orders and deliveries lists all use it.
- **`salesLines`: the words of the line editor**, shared by the quotation and the order form, like `stockLines` is
  shared by the stock documents. A delivery uses `stockLines` instead: its lines are stock lines with an order
  line, and carry no price.
- **`priceWithVat` / `priceWithoutVat`** label the price column, chosen by the document's own `pricesIncludeVat`,
  not the workspace setting: an order made from an old quotation keeps the quotation's way of writing prices. The
  same number means two different prices, so the header says which one it is.
- **`fromPriceList`, `fromProduct` and `noPrice`** go under a new line's price and say where it came from (the
  `source` of the price lookup). `noPrice` is not an error: a garments buyer's PO is often priced by hand.
- **`reprice` and `repriced`.** When the person changes the customer on a form that already has lines, the old
  prices stay (they may have been typed by hand). A text link at the top of the lines asks for the new customer's
  prices on every line; the form only reprices when it is clicked.
- **`tooMany`** is for `MAX_SALES_LINES` (300): the "Add items" dialog stops adding at that number and says why,
  instead of letting the person build a form the API refuses.
- **`lineDiscounts`, `net`, `vat` and `total` are the totals block.** "Before VAT" is the net amount in plain words;
  "net" is an accountant's word, and with prices that include VAT it is a number the customer never sees on the
  shelf. `lineDiscounts` shows only when a line has a discount, so the person can see what was given away.
- **`quotations.edit`** ("Edit") was added in 15b.6: an open quotation is shown as the customer got it, and this
  button turns the page into the form.
- **`quotations.expired` is not a status.** The contract has three statuses (open, accepted, declined). "Expired"
  is an open quotation whose `validUntil` has passed, worked out on the page. `expiredNotice` says the quotation
  can still be accepted: the customer often answers late, and the order is still the right document.
- **`acceptedOn` and `acceptedOnDraft`.** An accepted quotation links to its order. A draft order has no number yet,
  so the link needs words of its own instead of an empty "Accepted on".
- **`salesOrders.late`** is a pill for a confirmed order whose delivery date has passed. Like "expired", it is
  worked out by the page; nothing in the database changes when the date passes.
- **`salesOrders.customerLocked`** explains why the customer box is read only on a draft that has a number or comes
  from a quotation (decision of 15b.3). Without it, a disabled box looks like a bug.
- **`numberedDraft`** is shown on a reopened draft instead of the "Delete draft" button: such a draft cannot be
  deleted (`order_numbered`, decision of 15b.2), so the page says what to do instead.
- **Close and cancel each have a title, a body and their own toast.** They cannot be undone, so each one asks
  first, in a dialog that says what happens to the rest of the order. `keepOrder` is the dialog's "No" button:
  `common.cancel` ("Cancel") next to "Cancel order" would mean two opposite things.
- **`closeBody` mentions draft deliveries.** Closing leaves them, and posting one then fails with
  `order_not_confirmed` (15b.3). The person reads this before they click, not after.
- **`serviceLine`.** A service line (a delivery charge, an embroidery charge) is never delivered and does not count
  for "Delivered". The order page says so on the line, instead of showing "0 of 1 delivered" forever.
- **`deliveries.ordered` and `leftOnOrder`** go under the item on a delivery line made from an order, so the store
  keeper can see how much is still due. `fillFromOrder` adds one line per goods line that still has something
  left; `nothingLeft` is its answer when there is none.
- **`deliveries.vehiclePlaceholder`** is a real Dhaka number plate and a driver's name, the way a challan is filled
  in by hand today.
- **`deliveries.postHint` says what posting does to the books.** A delivery is the first sales document that posts
  a journal entry (the cost of goods sold), so the person learns it before the first post, not from the journal.
- **The audit words.** `audit.fields` are the field names of the snapshots 15b.3 writes (`customer`, `validUntil`,
  `quotation`, `deliveryDate`, `customerReference`, `order`, `vehicle`). The fields that were already there
  (`number`, `date`, `total`, `lines`, `warehouse`, `entry`) are reused. There is no "quotation accepted" action:
  `sales_order.created` names the quotation instead (15b.1).
- **Each error message says how to fix the problem** (CLAUDE.md → Copy). A few carry two meanings, because the API
  uses one code for both: `sales_customer_invalid` is an archived customer, or a customer change on an order that
  keeps its customer, so the message names both. `order_has_deliveries` tells the two cases apart (only drafts:
  delete them; goods went out: close and write a new order). `sales_not_draft`, `quotation_not_open` and
  `order_not_confirmed` mean someone else changed the document while the page was open, so they say to reload.
- **`ui.discountInput.type`** is the default name of the new control's select, for screen readers (below).

### `locales/bn.ts`

```diff
@@ -72,6 +72,9 @@ export const bn: Messages = {
     customers: 'গ্রাহক',
     customerGroups: 'গ্রাহকের গ্রুপ',
     priceLists: 'দামের তালিকা',
+    quotations: 'কোটেশন',
+    salesOrders: 'সেলস অর্ডার',
+    deliveries: 'ডেলিভারি',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -205,7 +208,13 @@ export const bn: Messages = {
       next: 'পরের নম্বর',
     },
     documents: {
-      sales: { invoice: 'বিক্রয় ইনভয়েস', order: 'সেলস অর্ডার', customer: 'গ্রাহক কোড' },
+      sales: {
+        invoice: 'বিক্রয় ইনভয়েস',
+        order: 'সেলস অর্ডার',
+        customer: 'গ্রাহক কোড',
+        quotation: 'কোটেশন',
+        delivery: 'ডেলিভারি চালান',
+      },
       purchase: { order: 'পারচেজ অর্ডার (PO)', bill: 'সাপ্লায়ারের বিল' },
       inventory: {
         receipt: 'মাল গ্রহণ (GRN)',
@@ -417,6 +426,7 @@ export const bn: Messages = {
       stock_adjustment: 'স্টক অ্যাডজাস্টমেন্ট',
       stock_transfer: 'স্টক ট্রান্সফার',
       stock_revaluation: 'স্টকের পুনর্মূল্যায়ন',
+      sales_delivery: 'ডেলিভারি',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -942,6 +952,7 @@ export const bn: Messages = {
       product: 'প্রোডাক্ট',
       onHand: 'হাতে আছে',
       inTransit: 'পথে আছে',
+      onOrder: 'অর্ডারে আছে',
       unitCost: 'গড় খরচ',
       value: 'মূল্য',
       status: 'অবস্থা',
@@ -949,6 +960,7 @@ export const bn: Messages = {
     statuses: { low: 'কম', out: 'স্টক শেষ', negative: 'শূন্যের নিচে', archived: 'আর্কাইভ' },
     newAdjustment: 'নতুন অ্যাডজাস্টমেন্ট',
     newTransfer: 'নতুন ট্রান্সফার',
+    onOrderHint: 'গ্রাহক অর্ডার দিয়েছেন, এখনো ডেলিভারি হয়নি। এর জন্য কিছু আটকে রাখা হয় না।',
     emptyTitle: 'এখনো কোনো স্টক নেই',
     emptyBody:
       'একটা অ্যাডজাস্টমেন্ট দিয়ে ওপেনিং স্টক পোস্ট করুন: প্রথম দিনে গোনা প্রতিটা প্রোডাক্ট, গুদাম ধরে ধরে।',
@@ -1011,6 +1023,7 @@ export const bn: Messages = {
       transfer_out: 'পাঠানো',
       transfer_in: 'গ্রহণ',
       revaluation: 'পুনর্মূল্যায়ন',
+      delivery: 'ডেলিভারি',
     },
     historyEmpty: 'এই তারিখগুলোর মধ্যে কোনো মুভমেন্ট নেই।',
   },
@@ -1331,6 +1344,7 @@ export const bn: Messages = {
     searchPlaceholder: 'নাম, কোড, যোগাযোগের মানুষ বা ফোন',
     group: 'গ্রুপ',
     allGroups: 'সব গ্রুপ',
+    allCustomers: 'সব গ্রাহক',
     show: 'দেখান',
     statuses: { active: 'চালু', archived: 'আর্কাইভ' },
     columns: {
@@ -1535,6 +1549,232 @@ export const bn: Messages = {
     itemsNoMatchBody: 'বানান দেখুন, অথবা আইটেমটা যোগ করুন।',
     itemsLoadFailed: 'দাম আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
+  salesLines: {
+    items: 'আইটেম',
+    addItems: 'আইটেম যোগ করুন',
+    pickerTitle: 'আইটেম যোগ করুন',
+    pickerDescription:
+      'প্রোডাক্ট আর সার্ভিস খুঁজুন। প্রতিটা ক্লিকে বিক্রির ইউনিটে, এই গ্রাহকের দামে একটা লাইন যোগ হয়।',
+    pickerSearch: 'প্রোডাক্ট আর সার্ভিস খুঁজুন',
+    pickerEmpty: 'কোনো চালু প্রোডাক্ট মেলেনি। বানান দেখুন, বা কোড বা SKU দিয়ে খুঁজুন।',
+    add: 'যোগ করুন',
+    added: 'যোগ হয়েছে',
+    service: 'সার্ভিস',
+    line: 'লাইন {{number}}',
+    remove: 'লাইন {{number}} সরান',
+    item: 'আইটেম',
+    description: 'বিবরণ',
+    quantity: 'পরিমাণ',
+    unit: 'ইউনিট',
+    price: 'দাম',
+    priceWithVat: 'VAT-সহ দাম',
+    priceWithoutVat: 'VAT ছাড়া দাম',
+    discount: 'ছাড়',
+    vatRate: 'VAT হার',
+    amount: 'টাকা',
+    fromPriceList: 'তার দামের তালিকা থেকে',
+    fromProduct: 'প্রোডাক্টের দাম',
+    noPrice: 'কোনো দাম নেই: একটা লিখুন',
+    reprice: 'প্রতিটা লাইনে এই গ্রাহকের দাম বসান',
+    repriced: 'দাম বদলানো হয়েছে',
+    noLines: 'এখনো কোনো আইটেম নেই। গ্রাহক যা চেয়েছেন তা যোগ করুন।',
+    tooMany: 'একটা ডকুমেন্টে সর্বোচ্চ {{max}}টা লাইন থাকে। বাকিগুলোর জন্য আরেকটা লিখুন।',
+    lineCount_one: '{{count}}টা আইটেম',
+    lineCount_other: '{{count}}টা আইটেম',
+    lineDiscounts: 'লাইনের ছাড়',
+    net: 'VAT-এর আগে',
+    vat: 'VAT',
+    total: 'মোট',
+    pricesWithVat: 'দামে VAT ধরা',
+    pricesWithoutVat: 'দাম VAT ছাড়া',
+  },
+  quotations: {
+    title: 'কোটেশন',
+    description: 'গ্রাহককে দেওয়া অফার: এই আইটেমগুলো, এই দামে, একটা তারিখ পর্যন্ত',
+    new: 'নতুন কোটেশন',
+    newTitle: 'নতুন কোটেশন',
+    back: 'কোটেশন',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { open: 'খোলা', accepted: 'গৃহীত', declined: 'প্রত্যাখ্যাত' },
+    expired: 'মেয়াদ শেষ',
+    columns: {
+      number: 'নম্বর',
+      customer: 'গ্রাহক',
+      validUntil: 'যতদিন বৈধ',
+      total: 'মোট',
+      status: 'অবস্থা',
+    },
+    customer: 'গ্রাহক',
+    date: 'তারিখ',
+    validUntil: 'যতদিন বৈধ',
+    validUntilHint: 'অফারের শেষ তারিখ না থাকলে ফাঁকা রাখুন।',
+    noEndDate: 'শেষ তারিখ নেই',
+    note: 'নোট',
+    notePlaceholder: 'দাম গাজীপুর কারখানা থেকে। অর্ডারের ১৫ দিনের মধ্যে ডেলিভারি।',
+    save: 'কোটেশন সেভ করুন',
+    saved: '{{number}} সেভ হয়েছে',
+    makeOrder: 'অর্ডার বানান',
+    edit: 'বদলান',
+    decline: 'প্রত্যাখ্যাত হিসেবে চিহ্নিত করুন',
+    declined: '{{number}} প্রত্যাখ্যাত হিসেবে চিহ্নিত হয়েছে',
+    reopen: 'আবার খুলুন',
+    reopened: '{{number}} আবার খোলা',
+    delete: 'কোটেশন মুছুন',
+    confirmDelete: '{{number}} মুছুন',
+    deleteWarning: 'এটা আর ফেরানো যায় না। এর নম্বর আর ব্যবহার হবে না।',
+    deleted: '{{number}} মুছে ফেলা হয়েছে',
+    expiredNotice:
+      'এই অফার {{date}}-এ শেষ হয়েছে। গ্রাহক তবুও রাজি হলে স্বাভাবিকভাবে অর্ডার বানান।',
+    acceptedOn: '{{number}}-এ গৃহীত',
+    acceptedOnDraft: 'একটা খসড়া অর্ডারে গৃহীত',
+    declinedNotice: 'গ্রাহক রাজি হননি। মত বদলালে এটা আবার খুলুন।',
+    cantWrite:
+      'আপনি কোটেশন দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে sales.quotation.manage permission চান।',
+    notFound: 'এই কোটেশন নেই, অথবা মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো কোটেশন নেই',
+    emptyBody:
+      'বায়ার দাম জানতে চাইলে একটা লিখুন, যেমন গুলশানের এক রিটেইলারের জন্য ২,০০০ পোলো শার্ট। তারা রাজি হলে সেটা থেকে অর্ডার বানান।',
+    loadFailed: 'কোটেশনগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  salesOrders: {
+    title: 'সেলস অর্ডার',
+    description: 'গ্রাহকেরা কী অর্ডার দিয়েছেন, আর তার কতটা পাঠানো হয়েছে',
+    new: 'নতুন অর্ডার',
+    newTitle: 'নতুন সেলস অর্ডার',
+    draftTitle: 'খসড়া অর্ডার',
+    back: 'সেলস অর্ডার',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: {
+      draft: 'খসড়া',
+      confirmed: 'কনফার্ম করা',
+      delivered: 'ডেলিভারি হয়েছে',
+      closed: 'বন্ধ',
+      cancelled: 'বাতিল',
+    },
+    partlyDelivered: 'কিছুটা ডেলিভারি হয়েছে',
+    late: 'দেরি',
+    columns: {
+      number: 'নম্বর',
+      customer: 'গ্রাহক',
+      deliveryDate: 'ডেলিভারির তারিখ',
+      total: 'মোট',
+      status: 'অবস্থা',
+    },
+    customer: 'গ্রাহক',
+    customerLocked: 'গ্রাহক বদলাবে না: এই অর্ডারের নম্বর আছে, অথবা এটা একটা কোটেশন থেকে এসেছে।',
+    date: 'অর্ডারের তারিখ',
+    deliveryDate: 'ডেলিভারির তারিখ',
+    deliveryDateHint: 'গ্রাহক কবে মাল চান',
+    customerReference: 'গ্রাহকের রেফারেন্স',
+    customerReferenceHint: 'তাদের PO বা ইনডেন্ট নম্বর, চালান আর ইনভয়েসে লেখার জন্য',
+    customerReferencePlaceholder: 'PO-HM-2026-1187',
+    warehouse: 'যেখান থেকে যাবে',
+    warehouseHint: 'ডেলিভারির সময় অন্য গুদাম থেকেও মাল নেওয়া যায়।',
+    shippingAddress: 'যেখানে যাবে',
+    noShippingAddress: 'ঠিকানা নেই',
+    note: 'নোট',
+    notePlaceholder: 'প্রতি কার্টনে ১২ পিস, প্রতিটায় বায়ারের হ্যাংট্যাগ',
+    quotation: 'কোটেশন',
+    saveDraft: 'খসড়া সেভ করুন',
+    confirm: 'অর্ডার কনফার্ম করুন',
+    confirming: 'কনফার্ম হচ্ছে…',
+    confirmed: '{{number}} কনফার্ম হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    confirmHint:
+      'কনফার্ম করলে অর্ডার তার নম্বর পায়, তারপর ডেলিভারি এর বিপরীতে মাল নিতে পারে। গুদামে কিছু আটকে রাখা হয় না।',
+    numberedDraft: 'এই খসড়া তার নম্বর {{number}} রাখবে। বদল শেষ হলে আবার কনফার্ম করুন।',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না। যে কোটেশন থেকে এসেছিল সেটা আবার খোলা হবে।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    deliver: 'নতুন ডেলিভারি',
+    reopen: 'খসড়ায় ফেরান',
+    reopenTitle: '{{number}} খসড়ায় ফেরান',
+    reopenBody: 'তারপর বদলে আবার কনফার্ম করতে পারবেন। নম্বর একই থাকবে।',
+    reopened: '{{number}} আবার খসড়া',
+    close: 'অর্ডার বন্ধ করুন',
+    closeTitle: '{{number}} বন্ধ করুন',
+    closeBody:
+      'যা এখনো ডেলিভারি হয়নি তা বাদ যাবে: গ্রাহক যা পেয়েছেন তা-ই থাকবে। এই অর্ডারের খসড়া ডেলিভারি আর পোস্ট করা যাবে না।',
+    closed: '{{number}} বন্ধ হয়েছে',
+    cancel: 'অর্ডার বাতিল করুন',
+    cancelTitle: '{{number}} বাতিল করুন',
+    cancelBody: 'অর্ডারটা বাতিল হবে। তালিকায় বাতিল হিসেবে থেকে যাবে।',
+    cancelled: '{{number}} বাতিল হয়েছে',
+    keepOrder: 'অর্ডার রাখুন',
+    delivered: 'ডেলিভারি হয়েছে',
+    left: 'ডেলিভারি বাকি',
+    serviceLine: 'সার্ভিস: ডেলিভারি হয় না',
+    deliveriesTitle: 'ডেলিভারি',
+    deliveriesSubtitle: 'যে চালানগুলো এই অর্ডারের বিপরীতে মাল নিয়েছে',
+    noDeliveries: 'এখনো কিছু ডেলিভারি হয়নি।',
+    confirmedOn: '{{date}}-এ কনফার্ম হয়েছে',
+    cantWrite:
+      'আপনি সেলস অর্ডার দেখতে পারেন। লিখতে একজন workspace owner-এর কাছে sales.order.manage permission চান।',
+    notFound: 'এই অর্ডার নেই, অথবা এটা একটা খসড়া ছিল যা মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো সেলস অর্ডার নেই',
+    emptyBody:
+      'গ্রাহক কী চান বললে একটা অর্ডার লিখুন, যেমন মিরপুর ডিপোর জন্য ৪০০ কার্টন আমের জুস, অথবা কোটেশন থেকে বানান।',
+    loadFailed: 'সেলস অর্ডারগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
+  deliveries: {
+    title: 'ডেলিভারি',
+    description: 'ডেলিভারি চালান: যে মাল গ্রাহকের জন্য গুদাম থেকে বের হয়',
+    new: 'নতুন ডেলিভারি',
+    newTitle: 'নতুন ডেলিভারি',
+    draftTitle: 'খসড়া ডেলিভারি',
+    back: 'ডেলিভারি',
+    show: 'দেখান',
+    all: 'সব',
+    statuses: { draft: 'খসড়া', posted: 'পোস্ট করা' },
+    columns: {
+      number: 'নম্বর',
+      customer: 'গ্রাহক',
+      order: 'অর্ডার',
+      warehouse: 'গুদাম',
+      lines: 'আইটেম',
+      status: 'অবস্থা',
+    },
+    customer: 'গ্রাহক',
+    order: 'সেলস অর্ডার',
+    noOrder: 'অর্ডার নেই',
+    orderHint: 'এই গ্রাহকের একটা কনফার্ম করা অর্ডার, অথবা অর্ডার ছাড়া মাল নিলে কিছুই না।',
+    date: 'তারিখ',
+    warehouse: 'যে গুদাম থেকে',
+    shippingAddress: 'যেখানে যাবে',
+    noShippingAddress: 'ঠিকানা নেই',
+    vehicle: 'গাড়ি আর চালক',
+    vehiclePlaceholder: 'ঢাকা মেট্রো-ট ১১-২২৩৩, রহিম',
+    note: 'নোট',
+    notePlaceholder: 'ডিপো ম্যানেজার বুঝে নিয়েছেন। ২টা কার্টন টোল খাওয়া।',
+    fillFromOrder: 'অর্ডারে যা বাকি আছে যোগ করুন',
+    nothingLeft: 'এই অর্ডারে ডেলিভারির আর কিছু বাকি নেই।',
+    ordered: 'অর্ডার {{quantity}}',
+    leftOnOrder: 'অর্ডারে {{quantity}} বাকি',
+    saveDraft: 'খসড়া সেভ করুন',
+    post: 'ডেলিভারি পোস্ট করুন',
+    posting: 'পোস্ট হচ্ছে…',
+    posted: '{{number}} পোস্ট হয়েছে',
+    draftSaved: 'খসড়া সেভ হয়েছে',
+    deleteDraft: 'খসড়া মুছুন',
+    confirmDelete: 'এই খসড়া মুছুন',
+    deleteWarning: 'মুছে ফেলা খসড়া আর ফেরানো যায় না।',
+    deleted: 'খসড়া মুছে ফেলা হয়েছে',
+    postHint:
+      'পোস্ট করলে স্টক বের হয় আর তার খরচ হিসাবে ওঠে। পোস্ট করা ডেলিভারি আর বদলায় না: ফেরত আসা মাল একটা রিটার্ন।',
+    cantWrite:
+      'আপনি ডেলিভারি দেখতে পারেন। লিখতে আর পোস্ট করতে একজন workspace owner-এর কাছে sales.delivery.manage permission চান।',
+    postedOn: '{{date}}-এ পোস্ট হয়েছে',
+    entry: 'জার্নাল এন্ট্রি',
+    noEntry: 'জার্নাল এন্ট্রি নেই: হিসাবে মালের কোনো খরচ ছিল না',
+    notFound: 'এই ডেলিভারি আর নেই। খসড়াটা হয়তো মুছে ফেলা হয়েছে।',
+    emptyTitle: 'এখনো কোনো ডেলিভারি নেই',
+    emptyBody:
+      'কনফার্ম করা অর্ডারের পেজ থেকে ডেলিভারি দিন, অথবা অর্ডার ছাড়া মাল নিতে আসা গ্রাহকের জন্য একটা ডেলিভারি লিখুন।',
+    loadFailed: 'ডেলিভারিগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+  },
   yearEnd: {
     title: 'বছর শেষের ক্লোজিং',
     description: 'প্রতিটা বছরের লাভ রিটেইনড আর্নিংসে নিন আর সেই বছরের তারিখগুলো বন্ধ করুন',
@@ -1702,6 +1942,9 @@ export const bn: Messages = {
         balance: 'গ্রাহকদের কাছে কত পাওনা আর তাদের স্টেটমেন্ট দেখা',
       },
       price_list: { manage: 'দামের তালিকা যোগ করা আর তার দাম বদলানো' },
+      quotation: { manage: 'কোটেশন লেখা, আর প্রত্যাখ্যাত হিসেবে চিহ্নিত করা' },
+      order: { manage: 'সেলস অর্ডার লেখা, কনফার্ম, বন্ধ আর বাতিল করা' },
+      delivery: { manage: 'ডেলিভারি লেখা আর পোস্ট করা: মাল গুদাম থেকে বের হয়' },
     },
   },
   invite: {
@@ -1753,6 +1996,9 @@ export const bn: Messages = {
       customer: 'গ্রাহক',
       customer_group: 'গ্রাহকের গ্রুপ',
       price_list: 'দামের তালিকা',
+      quotation: 'কোটেশন',
+      sales_order: 'সেলস অর্ডার',
+      delivery: 'ডেলিভারি',
     },
     columns: {
       when: 'কখন',
@@ -1894,6 +2140,28 @@ export const bn: Messages = {
         restored: 'একটা দামের তালিকা ফিরিয়ে এনেছেন',
         prices_changed: 'একটা দামের তালিকার দাম বদলেছেন',
       },
+      quotation: {
+        created: 'একটা কোটেশন লিখেছেন',
+        updated: 'একটা কোটেশন বদলেছেন',
+        deleted: 'একটা কোটেশন মুছেছেন',
+        declined: 'একটা কোটেশন প্রত্যাখ্যাত হিসেবে চিহ্নিত করেছেন',
+        reopened: 'একটা প্রত্যাখ্যাত কোটেশন আবার খুলেছেন',
+      },
+      sales_order: {
+        created: 'একটা সেলস অর্ডার লিখেছেন',
+        updated: 'একটা খসড়া অর্ডার বদলেছেন',
+        deleted: 'একটা খসড়া অর্ডার মুছেছেন',
+        confirmed: 'একটা সেলস অর্ডার কনফার্ম করেছেন',
+        reopened: 'একটা সেলস অর্ডার খসড়ায় ফিরিয়েছেন',
+        closed: 'একটা সেলস অর্ডার বন্ধ করেছেন',
+        cancelled: 'একটা সেলস অর্ডার বাতিল করেছেন',
+      },
+      delivery: {
+        created: 'একটা ডেলিভারি লিখেছেন',
+        updated: 'একটা খসড়া ডেলিভারি বদলেছেন',
+        deleted: 'একটা খসড়া ডেলিভারি মুছেছেন',
+        posted: 'একটা ডেলিভারি পোস্ট করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -1981,6 +2249,13 @@ export const bn: Messages = {
       customers: 'গ্রাহক',
       set: 'দাম বসানো',
       removed: 'দাম সরানো',
+      customer: 'গ্রাহক',
+      validUntil: 'যতদিন বৈধ',
+      quotation: 'কোটেশন',
+      deliveryDate: 'ডেলিভারির তারিখ',
+      customerReference: 'গ্রাহকের রেফারেন্স',
+      order: 'সেলস অর্ডার',
+      vehicle: 'গাড়ি',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -2320,6 +2595,35 @@ export const bn: Messages = {
     journal_party_invalid: 'একজন চালু গ্রাহক বাছুন। এই গ্রাহক আর্কাইভ করা বা মুছে ফেলা।',
     opening_balance_twice:
       'এই অ্যাকাউন্ট এখানে দুবার আছে। টাকাটা এক লাইনে দিন, অথবা অন্য গ্রাহক বাছুন।',
+    sales_customer_required: 'গ্রাহক বাছুন।',
+    sales_customer_invalid:
+      'একজন চালু গ্রাহক বাছুন। যে অর্ডারের নম্বর আছে, বা যেটা কোটেশন থেকে এসেছে, তার গ্রাহক বদলায় না।',
+    sales_date_required: 'তারিখ দিন।',
+    sales_lines_required: 'অন্তত একটা আইটেম যোগ করুন।',
+    sales_price_required: 'দাম লিখুন। ফ্রি আইটেমের জন্য 0 লিখুন।',
+    sales_discount_too_large: 'ছাড় লাইনের চেয়ে বেশি: সর্বোচ্চ 100%, বা লাইনের টাকা।',
+    sales_address_invalid: 'এই গ্রাহকের একটা ঠিকানা বাছুন।',
+    sales_not_draft: 'এটা আর খসড়া নেই। এখনকার অবস্থা দেখতে পেজটা রিলোড করুন।',
+    sales_item_invalid: 'একটা চালু প্রোডাক্ট বাছুন। এটা আর্কাইভ করা বা মুছে ফেলা হয়েছে।',
+    quotation_valid_until: 'অফার কোটেশনের তারিখের আগে শেষ হতে পারে না।',
+    quotation_not_open:
+      'শুধু খোলা কোটেশন বদলানো, প্রত্যাখ্যাত করা বা অর্ডারে নেওয়া যায়। এখনকার অবস্থা দেখতে পেজটা রিলোড করুন।',
+    quotation_not_declined: 'শুধু প্রত্যাখ্যাত কোটেশন আবার খোলা যায়।',
+    order_delivery_date: 'ডেলিভারির তারিখ অর্ডারের তারিখের আগে হতে পারে না।',
+    order_not_confirmed:
+      'শুধু কনফার্ম করা অর্ডার ডেলিভারি, বন্ধ বা বাতিল করা যায়। এখন কোথায় আছে দেখতে পেজটা রিলোড করুন।',
+    order_has_deliveries:
+      'এই অর্ডারের ডেলিভারি আছে, তাই এটা কনফার্ম করাই থাকবে। আগে খসড়া ডেলিভারিগুলো মুছুন; মাল বের হয়ে থাকলে অর্ডারটা বন্ধ করে নতুন অর্ডার লিখুন।',
+    order_nothing_delivered: 'এখনো কিছু ডেলিভারি হয়নি। এর বদলে অর্ডারটা বাতিল করুন।',
+    order_partly_delivered: 'এই অর্ডারের কিছুটা ডেলিভারি হয়েছে। এর বদলে অর্ডারটা বন্ধ করুন।',
+    order_numbered: 'এই অর্ডারের নম্বর আছে, তাই মোছা যায় না। আবার কনফার্ম করে বাতিল করুন।',
+    order_quotation_invalid: 'এই গ্রাহকের একটা খোলা কোটেশন বাছুন।',
+    delivery_order_invalid: 'এই গ্রাহকের একটা কনফার্ম করা অর্ডার বাছুন।',
+    delivery_order_line_required:
+      'এই আইটেম অর্ডারে নেই। লাইনটা সরান, অথবা অর্ডার ছাড়া ডেলিভারি দিন।',
+    delivery_order_line_invalid:
+      'এই লাইন বাছাই করা অর্ডারের সাথে মেলে না। সরিয়ে অর্ডার থেকে আবার যোগ করুন।',
+    delivery_over_order: 'অর্ডারে যা ডেলিভারি বাকি তার চেয়ে বেশি। পরিমাণ কমান।',
     import_options_without_code:
       'অপশনওয়ালা সারিতে কোড দিন: একই কোডের সারিগুলো মিলে একটা প্রোডাক্ট।',
     invalid_cursor: 'তালিকাটা বদলে গেছে। পেজটা রিলোড করে আবার চেষ্টা করুন।',
@@ -2350,5 +2654,8 @@ export const bn: Messages = {
       loading: 'খোঁজা হচ্ছে…',
       empty: 'কিছু মেলেনি',
     },
+    discountInput: {
+      type: 'ছাড় শতাংশে না টাকায়',
+    },
   },
 };
```

- **The words follow the existing Bangla text.** "সেলস অর্ডার" was already the name of the SO number series, "গুদাম"
  is warehouse and "খসড়া" draft, as on the stock documents. Quotation stays "কোটেশন" and challan "চালান": these
  are the words on the printed forms in Bangladeshi offices. Workspace, PO and the permission keys stay in English
  inside the Bangla sentences (CLAUDE.md → Language).
- **"ছাড়" for discount.** It is the word on a shop's sign ("১০% ছাড়"), and a salesperson reads it at once.
- **"কনফার্ম" for confirm.** Offices write it this way in Bangla; "নিশ্চিত" would be correct, but nobody says
  "অর্ডার নিশ্চিত করুন" at a sales desk.
- **Typed examples use ASCII digits**: `PO-HM-2026-1187`, "0 লিখুন" and "100%" in the error messages. The inputs
  always show ASCII digits (CLAUDE.md → Money input), so the example looks like what the person will type. Plain
  text, like the number plate in `vehiclePlaceholder` or "১২ পিস", uses Bangla digits.
- **`_one` and `_other` have the same text.** Bangla does not change the noun for a plural. Both keys still have
  to exist, because `Messages` has both.

### `components/money-input.tsx`: the typing rules, shared

```diff
@@ -4,9 +4,9 @@ import { useState } from 'react';
 import { isMoneyDraft, normalizeMoneyInput, toCanonicalMoney } from '../lib/money.js';
 import { Input, type InputProps } from './field.js';
 
-interface MoneyInputProps extends Omit<
+export interface DecimalInputProps extends Omit<
   InputProps,
-  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'prefix' | 'align'
+  'value' | 'defaultValue' | 'onChange' | 'type' | 'inputMode' | 'align'
 > {
   // টাকা কখনো number না — string, যেমন DB-র NUMERIC(19,4) আর contracts-এর schema
   value: string;
@@ -15,14 +15,17 @@ interface MoneyInputProps extends Omit<
   scale?: number;
 }
 
-export function MoneyInput({
+// The money box's typing rules for any decimal: Bangla digits accepted, grouped when not focused,
+// the form value always a canonical string. MoneyInput adds the ৳; DiscountInput adds its % / ৳
+// select. Not exported from the package: a page uses one of those two.
+export function DecimalInput({
   value,
   onChange,
   onFocus,
   onBlur,
   scale = 2,
   ...props
-}: MoneyInputProps) {
+}: DecimalInputProps) {
   // null = এখন লেখা হচ্ছে না, তাই গোছানো রূপ দেখাও; string = ইউজার যা টাইপ করছে হুবহু
   const [draft, setDraft] = useState<string | null>(null);
 
@@ -37,7 +40,6 @@ export function MoneyInput({
       // ফোনে সংখ্যার কীবোর্ড, দশমিক বিন্দু সহ (system-design §৮.১)
       inputMode="decimal"
       autoComplete="off"
-      prefix="৳"
       align="end"
       value={display}
       onFocus={(event) => {
@@ -62,3 +64,9 @@ export function MoneyInput({
     />
   );
 }
+
+type MoneyInputProps = Omit<DecimalInputProps, 'prefix'>;
+
+export function MoneyInput(props: MoneyInputProps) {
+  return <DecimalInput {...props} prefix="৳" />;
+}
```

- **Why split it.** A discount box needs exactly the money box's typing rules: Bangla digits typed on a Bangla
  keyboard become ASCII, a third decimal or a letter is ignored, the value is grouped when the box loses the
  focus, and the form always gets a canonical string. Those rules live in `lib/money.ts`, which the package does
  not export. Copying the 30 lines into a second component would make two places to fix the next time a rule
  changes.
- **`DecimalInput` is the old body, with the `৳` taken out.** Its props no longer omit `prefix`, so a caller may
  give one. `MoneyInput` is now a three-line wrapper that always adds `৳`, and its props omit `prefix`, as before:
  every page that uses it compiles unchanged.
- **`DecimalInput` is exported from the file, not from the package** (`index.ts` does not list it). A page should
  use a box that says what it holds, money or a discount; a bare decimal box would invite a quantity box without a
  unit.

### `components/discount-input.tsx` (new)

```tsx
import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useLocale } from '@omnivo/i18n';

import { DecimalInput, type DecimalInputProps } from './money-input.js';

// The two ways a sales line takes a discount off: the same values as DISCOUNT_TYPES in
// @omnivo/contracts (this package does not depend on the contracts)
export type DiscountType = 'percent' | 'amount';

interface DiscountInputProps extends Omit<
  DecimalInputProps,
  'prefix' | 'suffix' | 'trailing' | 'scale'
> {
  discountType: DiscountType;
  onDiscountTypeChange: (discountType: DiscountType) => void;
  // The select's name for screen readers; the default says what it switches
  typeLabel?: string | undefined;
}

// A discount box: the amount, then a small select that says what the amount means. The select
// sits inside the box, so one column of a line editor holds both, and the box's focus ring
// (focus-within) shows while either part has the focus.
export function DiscountInput({
  discountType,
  onDiscountTypeChange,
  typeLabel,
  disabled,
  ...props
}: DiscountInputProps) {
  const { t } = useLocale();
  return (
    <DecimalInput
      {...props}
      disabled={disabled}
      // A discount is kept to 2 decimals, as a percent (12.25) or as taka (contracts' DISCOUNT)
      scale={2}
      trailing={
        <span className="relative flex shrink-0 items-center border-l border-line pl-2">
          <select
            aria-label={typeLabel ?? t('ui.discountInput.type')}
            value={discountType}
            disabled={disabled}
            onChange={(event) => {
              // Narrowed by comparison, not cast: an option this code did not write cannot slip in
              onDiscountTypeChange(event.target.value === 'amount' ? 'amount' : 'percent');
            }}
            // appearance-none + pr-5: our arrow instead of the browser's, like Select
            className="appearance-none bg-transparent py-1 pr-5 text-body-sm font-medium text-ink-2 outline-none"
          >
            <option value="percent">%</option>
            <option value="amount">৳</option>
          </select>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={16}
            strokeWidth={1.5}
            className="pointer-events-none absolute right-0 text-ink-3"
          />
        </span>
      }
    />
  );
}
```

- **One box, two parts.** A line editor has one narrow column for the discount. A separate select for "% or ৳"
  would need its own column, and its own label on a phone. Inside the box, the select is also the unit: "10 %"
  or "250 ৳" reads as one value. That is why there is no `৳` prefix in amount mode: it would show twice.
- **`DiscountType` is declared here.** `@omnivo/ui` does not depend on `@omnivo/contracts`, so it cannot import
  `DISCOUNT_TYPES`. The two unions have the same members, so a form passes the contract's value straight in, and
  the type checker would catch it if either side changed.
- **`scale={2}`.** The contract keeps a discount to 2 decimals, as a percent or as taka (`DISCOUNT` in 15b.1), so
  the box refuses a third decimal while the person types, instead of showing an error after.
- **The select narrows by comparison**: `event.target.value === 'amount' ? 'amount' : 'percent'`. The DOM gives
  a plain `string`; a cast would let any string through, while this can only produce one of the two values.
- **`typeLabel`.** The select has no visible label, so it gets an `aria-label`. The default says what it switches.
  In the line editor no other name is needed: each row is a `role="group"` labelled "Line 3" (CLAUDE.md → Line
  editor), and a screen reader reads that group's name before the select's.
- **The focus ring.** The box's class (`controlBoxClass`) uses `focus-within`, so the brand ring shows while either
  the number or the select has the focus. The select itself has `outline-none` for that reason. Its pointer
  cursor comes from the global rule for `select:not(:disabled)`.
- **`disabled` is passed to both parts.** A read-only line must not let the select change while the number is
  locked.

```diff
@@ -16,6 +16,7 @@ export {
   type SortingState,
 } from './components/data-table.js';
 export { DatePicker } from './components/date-picker.js';
+export { DiscountInput, type DiscountType } from './components/discount-input.js';
 export { Dialog, DialogClose, DialogContent, DialogTrigger } from './components/dialog.js';
 export {
   DropdownMenu,
```

CLAUDE.md's design system lists every control, so the discount box gets its own entry there (15b.9): "If something
is missing, extend this section first, then use it."

### Check this part

```bash
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/i18n typecheck
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/ui typecheck
pnpm --filter @omnivo/ui build
```

Build `@omnivo/i18n` before you type-check `@omnivo/ui`: the ui package reads the i18n package's built types, so
until then `t('ui.discountInput.type')` is an unknown key.

> **What we checked in this part.** `packages/i18n` and `packages/ui` type-check, and ESLint and Prettier are clean.
> The i18n unit tests pass (11), and both packages build. The app has one type error left: the MSW mock's stock
> items have no `onOrder` (15b.7). No error is about a missing translation key.

## 15b.6 — `apps/app`: the screens

Three lists, three documents and one line editor: Sales → Quotations, Sales orders and Deliveries. A quotation is
shown as the customer got it, with "Make order", "Edit", "Mark declined" and "Delete" while it is open. An order
is a form while it is a draft and a page with its deliveries once it is confirmed. A delivery is a stock document
with a customer, so its form reuses the stock lines of step 13 (batch, "Split by first expiry", serial numbers).
The stock page gets its "On order" column, and the stock card and the journal link to the deliveries.

Two earlier parts changed while the screens were built: the sales line now says whether its product is a service
(`productType`, in 15b.1 and 15b.3), and the default line description moved into the contract. Their bullets are
in those parts. After this part, the app has one type error left: the MSW mock's stock items have no `onOrder`
(15b.7).

### `lib/sales.ts` (new): the parts without React

```ts
import {
  compareQuantity,
  defaultLineDescription,
  type DocumentTotals,
  documentTotals,
  draftLineAmounts,
  isZeroMoney,
  isZeroQuantity,
  type LineAmounts,
  plainQuantity,
  type PriceSource,
  type SalesLine,
  type SalesLineFormValues,
  type SalesOrderLine,
  subtractQuantity,
  sumQuantity,
} from '@omnivo/contracts';

// The pure parts of the sales pages: no React, so they are unit-tested (sales.spec.ts) and shared
// by the forms and the views. The line editor's helpers live here too, not in
// sales-line-editor.tsx: the forms need them at once, and the editor is a lazy chunk of its own.

// A saved discount comes back as "10.0000". The box takes at most 2 decimals (contracts' DISCOUNT),
// so it gets "10"; no discount at all is an empty box, not "0", on every line.
export function formDiscount(value: string): string {
  return isZeroMoney(value) ? '' : plainQuantity(value);
}

// An open quotation whose offer has ended. Not a status: nothing changes in the database when the
// date passes, and the customer may still accept it. ISO dates compare as strings.
export function isExpired(
  quotation: { status: string; validUntil: string | null },
  today: string,
): boolean {
  return (
    quotation.status === 'open' && quotation.validUntil !== null && quotation.validUntil < today
  );
}

// A confirmed order whose delivery date has passed: attention, not a status
export function isLate(
  order: { status: string; deliveryDate: string | null },
  today: string,
): boolean {
  return order.status === 'confirmed' && order.deliveryDate !== null && order.deliveryDate < today;
}

// A service line (a delivery charge) is sold but never delivered
export function isServiceLine(line: { productType: string }): boolean {
  return line.productType === 'service';
}

// What an order line still has to deliver, in the base unit. A service line has nothing to deliver;
// a line delivered in full has nothing left, never less than nothing.
export function leftToDeliver(line: SalesOrderLine): string {
  if (isServiceLine(line)) return '0.0000';
  const left = subtractQuantity(line.baseQuantity, line.deliveredQuantity);
  return compareQuantity(left, '0') > 0 ? left : '0.0000';
}

// A delivery line made from an order line: what it sends to the API
export interface FillLine {
  orderLineId: string;
  variantId: string;
  unitId: string;
  quantity: string;
}

// "Add what is left on the order": one line per goods line that still has something to deliver,
// minus what the form already holds for it (`onForm`: base quantities by order line). A line
// nothing went out for yet keeps the order's unit and quantity (3 case); a partly delivered one
// asks for the rest in the base unit (24 pcs), because the rest is rarely whole cases.
export function fillFromOrder(
  lines: readonly SalesOrderLine[],
  onForm: ReadonlyMap<string, string>,
): FillLine[] {
  return lines.flatMap((line) => {
    const already = onForm.get(line.id) ?? '0';
    const left = subtractQuantity(leftToDeliver(line), already);
    if (compareQuantity(left, '0') <= 0) return [];
    const untouched = isZeroQuantity(line.deliveredQuantity) && isZeroQuantity(already);
    return [
      {
        orderLineId: line.id,
        variantId: line.variantId,
        unitId: untouched ? line.unitId : line.baseUnitId,
        quantity: untouched ? plainQuantity(line.quantity) : plainQuantity(left),
      },
    ];
  });
}

// The base quantities a form holds per order line, from each line's base quantity (null while a
// line's quantity is not a quantity yet: it counts as nothing)
export function baseByOrderLine(
  lines: readonly { orderLineId: string; base: string | null }[],
): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of lines) {
    if (line.orderLineId === '' || line.base === null) continue;
    sums.set(line.orderLineId, sumQuantity([sums.get(line.orderLineId) ?? '0', line.base]));
  }
  return sums;
}

// What a form's lines are worth while they are typed: each line's amounts (null until its boxes
// hold complete values) and the totals of the complete ones. The same contracts functions the API
// stores with, so the form shows the saved total to the paisa.
export function formTotals(
  lines: readonly SalesLineFormValues[],
  rateOf: (taxRateId: string) => string | null,
  pricesIncludeVat: boolean,
): { amounts: (LineAmounts | null)[]; totals: DocumentTotals } {
  const amounts = lines.map((line) =>
    draftLineAmounts(line, rateOf(line.taxRateId), pricesIncludeVat),
  );
  return {
    amounts,
    totals: documentTotals(amounts.filter((amount): amount is LineAmounts => amount !== null)),
  };
}

// ---------------------------------------------------------------------------------------------
// The line editor's data

// What a line needs to know about its product, beside what the form sends
export type SalesItem = Pick<
  SalesLine,
  | 'variantId'
  | 'productId'
  | 'productCode'
  | 'productName'
  | 'optionValues'
  | 'sku'
  | 'baseUnitId'
  | 'units'
  | 'productType'
>;

// What the editor keeps per line, beside the form value, at the same index
export interface LineMeta {
  // React's key: stays with the line when a line above it is removed
  key: string;
  item: SalesItem;
  // Where a new line's price came from (the price lookup). undefined for a saved line: nothing new
  // to say about it.
  source: PriceSource | null | undefined;
  // The customer the price was looked up for ('' = none chosen yet). When the form's customer is
  // another one, the editor offers to reprice.
  pricedFor: string;
}

// The fields of a line the server may name in an error ("lines.3.unitPrice"); each form adds
// them to its own list for applyApiError
export const SALES_LINE_FIELDS = [
  'variantId',
  'unitId',
  'quantity',
  'description',
  'unitPrice',
  'discount',
  'taxRateId',
] as const;

function salesItemOf(line: SalesLine): SalesItem {
  return {
    variantId: line.variantId,
    productId: line.productId,
    productCode: line.productCode,
    productName: line.productName,
    optionValues: line.optionValues,
    sku: line.sku,
    baseUnitId: line.baseUnitId,
    units: line.units,
    productType: line.productType,
  };
}

// A saved line, as the form holds it. A description that is just the product's name is shown as
// an empty box (with the name as its placeholder), so the next save keeps following the product.
export function toFormLine(line: SalesLine): SalesLineFormValues {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: plainQuantity(line.quantity),
    description: line.description === defaultLineDescription(line) ? '' : line.description,
    unitPrice: line.unitPrice,
    discountType: line.discountType,
    discount: formDiscount(line.discount),
    taxRateId: line.taxRate.id,
  };
}

// The form's starting lines and the editor's meta for a saved document (or the quotation an order
// is made from)
export function savedLines(
  lines: readonly SalesLine[],
  customerId: string,
): { values: SalesLineFormValues[]; meta: LineMeta[] } {
  return {
    values: lines.map(toFormLine),
    meta: lines.map((line) => ({
      key: line.id,
      item: salesItemOf(line),
      source: undefined,
      pricedFor: customerId,
    })),
  };
}
```

- **Pure functions, in their own file.** No React, so `sales.spec.ts` tests them without a browser, and the forms,
  the views and the editor share them. The line editor's data (`SalesItem`, `LineMeta`, `toFormLine()`,
  `savedLines()`) lives here too, and not in `sales-line-editor.tsx`: the forms need it at once, while the
  editor is a lazy chunk of its own (see the forms below). Importing anything from the editor's file would put
  the whole editor back into the form's chunk.
- **`formDiscount()`.** The API sends a discount as `"10.0000"`, but the contract's `DISCOUNT` takes at most 2
  decimals. Sent back unchanged, every saved line would fail with `money_format` on the next save. `"0.0000"`
  becomes an empty box: a line with no discount should not show `0.00`.
- **`isExpired()` and `isLate()` compare ISO dates as strings.** `"2026-10-06" < "2026-10-07"` is true as text,
  so there is no `Date` and no time zone to get wrong. `today` comes from `useToday()`, the company's time zone.
- **`leftToDeliver()` never goes below zero.** The API never delivers more than ordered, but the page should not
  show "−2 left" if it ever did. A service line has nothing to deliver.
- **`fillFromOrder()` and the unit.** A line nothing went out for keeps the order's unit and quantity: "3 case"
  reads like the order. Once part of it went out, the rest is asked for in the base unit (24 pcs), because the
  rest is rarely whole cases. `onForm` subtracts what the delivery form already holds, so a second click on "Add
  what is left on the order" adds only what is missing.
- **`baseByOrderLine()`** skips lines without an order line and lines whose quantity is still being typed
  (`base: null`). Counting a half-typed "1." as something would hide a line the person still needs.
- **`formTotals()`** runs the contract's `draftLineAmounts()` and `documentTotals()`, the functions the API saves
  with (15b.1). A line that is not complete yet is `null` and left out of the totals, so the totals never throw
  while the person types.
- **`LineMeta`.** The form holds only what is sent to the API. The editor needs more for each line: the product
  (its name, packs and type), where the price came from, which customer it was priced for, and a React key.
  `source: undefined` means a saved line: there is nothing new to say about its price.
- **`toFormLine()` empties a description that is just the product's name.** The API wrote that text because the
  person left the box empty (`defaultLineDescription()`). Showing it in the box would freeze it: after a later
  rename of the product, the next save would still send the old name.

```ts
import type { SalesLineFormValues, SalesOrderLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  baseByOrderLine,
  fillFromOrder,
  formDiscount,
  formTotals,
  isExpired,
  isLate,
  leftToDeliver,
  savedLines,
  toFormLine,
} from './sales';

// An order line as the API sends it: 2 cases of 24 (48 pcs), nothing delivered yet
function orderLine(extra: Partial<SalesOrderLine> = {}): SalesOrderLine {
  return {
    id: 'line-juice',
    variantId: 'juice',
    productId: 'p-juice',
    productCode: 'P-00012',
    productName: 'Mango juice 250 ml',
    optionValues: [],
    sku: 'P-00012',
    baseUnitId: 'pcs',
    productType: 'goods',
    tracking: 'none',
    hasExpiry: false,
    units: [{ unitId: 'case', factor: '24.000000' }],
    unitId: 'case',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: 'Mango juice 250 ml',
    unitPrice: '504.0000',
    discountType: 'percent',
    discount: '0.0000',
    taxRate: { id: 'vat15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '1008.0000',
    vat: '151.2000',
    total: '1159.2000',
    deliveredQuantity: '0.0000',
    ...extra,
  };
}

function formLine(extra: Partial<SalesLineFormValues> = {}): SalesLineFormValues {
  return {
    variantId: 'juice',
    unitId: 'case',
    quantity: '2',
    description: '',
    unitPrice: '504.00',
    discountType: 'percent',
    discount: '10.00',
    taxRateId: 'vat15',
    ...extra,
  };
}

describe('sales helpers', () => {
  it('shows a saved discount the way the box takes it', () => {
    expect(formDiscount('0.0000')).toBe('');
    expect(formDiscount('10.0000')).toBe('10');
    expect(formDiscount('12.5000')).toBe('12.5');
    expect(formDiscount('250.7500')).toBe('250.75');
  });

  it('marks an open quotation expired the day after its date, and nothing else', () => {
    const open = { status: 'open', validUntil: '2026-10-06' };
    expect(isExpired(open, '2026-10-06')).toBe(false);
    expect(isExpired(open, '2026-10-07')).toBe(true);
    expect(isExpired({ ...open, validUntil: null }, '2027-01-01')).toBe(false);
    expect(isExpired({ ...open, status: 'accepted' }, '2026-10-07')).toBe(false);
  });

  it('marks only a confirmed order late', () => {
    const order = { status: 'confirmed', deliveryDate: '2026-10-06' };
    expect(isLate(order, '2026-10-07')).toBe(true);
    expect(isLate({ ...order, status: 'delivered' }, '2026-10-07')).toBe(false);
    expect(isLate({ ...order, deliveryDate: null }, '2026-10-07')).toBe(false);
  });

  it('works out what an order line has left, never below zero, nothing for a service', () => {
    expect(leftToDeliver(orderLine({ deliveredQuantity: '20.0000' }))).toBe('28.0000');
    expect(leftToDeliver(orderLine({ deliveredQuantity: '48.0000' }))).toBe('0.0000');
    expect(leftToDeliver(orderLine({ productType: 'service', baseUnitId: 'job' }))).toBe('0.0000');
  });

  it('fills a delivery from the order: whole lines in their unit, the rest in the base unit', () => {
    const napa = orderLine({
      id: 'line-napa',
      variantId: 'napa',
      unitId: 'pcs',
      quantity: '200.0000',
      baseQuantity: '200.0000',
      deliveredQuantity: '150.0000',
    });
    const carriage = orderLine({ id: 'line-carriage', productType: 'service' });
    expect(fillFromOrder([orderLine(), napa, carriage], new Map())).toEqual([
      { orderLineId: 'line-juice', variantId: 'juice', unitId: 'case', quantity: '2' },
      { orderLineId: 'line-napa', variantId: 'napa', unitId: 'pcs', quantity: '50' },
    ]);
    // A second click adds only what the form does not hold yet
    const onForm = baseByOrderLine([
      { orderLineId: 'line-juice', base: '24.0000' },
      { orderLineId: 'line-napa', base: '50.0000' },
      { orderLineId: '', base: '5.0000' },
      { orderLineId: 'line-juice', base: null },
    ]);
    expect(fillFromOrder([orderLine(), napa], onForm)).toEqual([
      { orderLineId: 'line-juice', variantId: 'juice', unitId: 'pcs', quantity: '24' },
    ]);
  });

  it('puts a saved line back in the form the way its boxes take it', () => {
    expect(toFormLine(orderLine({ discount: '10.0000' }))).toEqual({
      variantId: 'juice',
      unitId: 'case',
      quantity: '2',
      // Just the product's name: the box stays empty and keeps following the product
      description: '',
      unitPrice: '504.0000',
      discountType: 'percent',
      discount: '10',
      taxRateId: 'vat15',
    });
    expect(
      toFormLine(orderLine({ description: 'Mango juice, Mirpur depot carton' })).description,
    ).toBe('Mango juice, Mirpur depot carton');
    const { meta } = savedLines([orderLine()], 'customer-1');
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      key: 'line-juice',
      item: { variantId: 'juice', productType: 'goods' },
      source: undefined,
      pricedFor: 'customer-1',
    });
  });

  it('totals the complete lines with the contract’s arithmetic', () => {
    const rateOf = (id: string) => (id === 'vat15' ? '15.00' : null);
    const { amounts, totals } = formTotals(
      [formLine(), formLine({ quantity: '' }), formLine({ taxRateId: '' })],
      rateOf,
      false,
    );
    expect(amounts.map((amount) => amount?.total ?? null)).toEqual(['1043.2800', null, null]);
    // 2 cases × ৳504 − 10% = ৳907.20, VAT 15% = ৳136.08 (15b.4's quotation)
    expect(totals).toEqual({
      discount: '100.8000',
      net: '907.2000',
      vat: '136.0800',
      total: '1043.2800',
    });
  });
});
```

- **The numbers are the API test's numbers** (15b.4): 2 cases at ৳504 with 10% off is ৳907.20, and 15% VAT on it
  is ৳136.08. If the form and the API ever disagreed, both tests would point at the same story.
- **The fill test** has a whole line, a partly delivered line and a service. The second call holds part of the
  juice already, so only the rest comes back, in pieces.

### `lib/queries.ts`: the sales documents

```diff
@@ -5,9 +5,11 @@ import {
   type CustomerStatus,
   type JournalStatus,
   type MemberSort,
+  type OrderStatus,
   type ProductSort,
   type ProductStatus,
   type ProfitAndLossQuery,
+  type QuotationStatus,
   routes,
   type StockDocumentStatus,
   type StockFilter,
@@ -698,3 +700,106 @@ export function productSearchQuery(tenantId: string, search: string) {
     placeholderData: keepPreviousData,
   });
 }
+
+// ---------------------------------------------------------------------------------------------
+// Quotations, sales orders and deliveries (step 15b). Everything starts with ['sales', tenantId]:
+// one invalidate after a save refreshes the lists and the documents together. A delivery changes
+// its order (what is delivered) as well, which is one more reason for one prefix.
+
+// The lists' filters: a status ('' = all) and a customer ('' = all)
+export interface SalesListFilter<TStatus extends string> {
+  status: TStatus | '';
+  customerId: string;
+}
+
+export function quotationsQuery(tenantId: string, filter: SalesListFilter<QuotationStatus>) {
+  return infiniteQueryOptions({
+    queryKey: ['sales', tenantId, 'quotations', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.quotations.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function quotationQuery(tenantId: string, quotationId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'quotation', quotationId],
+    queryFn: () => call(routes.quotations.get, { params: { id: quotationId } }),
+    retry: false,
+  });
+}
+
+export function salesOrdersQuery(tenantId: string, filter: SalesListFilter<OrderStatus>) {
+  return infiniteQueryOptions({
+    queryKey: ['sales', tenantId, 'orders', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.salesOrders.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+// The delivery form's order box: the customer's confirmed orders, the ones a delivery can take
+// goods against. 100 at most: a customer with more open orders than that is a problem of its own.
+export function openOrdersQuery(tenantId: string, customerId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'orders', 'open', customerId],
+    queryFn: async () =>
+      (
+        await call(routes.salesOrders.list, {
+          query: { limit: 100, status: 'confirmed', customerId },
+        })
+      ).items,
+  });
+}
+
+export function salesOrderQuery(tenantId: string, orderId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'order', orderId],
+    queryFn: () => call(routes.salesOrders.get, { params: { id: orderId } }),
+    retry: false,
+  });
+}
+
+export function deliveriesQuery(tenantId: string, filter: SalesListFilter<StockDocumentStatus>) {
+  return infiniteQueryOptions({
+    queryKey: ['sales', tenantId, 'deliveries', filter],
+    queryFn: ({ pageParam }: { pageParam: string | null }) =>
+      call(routes.deliveries.list, {
+        query: {
+          limit: 50,
+          ...(filter.status !== '' && { status: filter.status }),
+          ...(filter.customerId !== '' && { customerId: filter.customerId }),
+          ...(pageParam !== null && { cursor: pageParam }),
+        },
+      }),
+    initialPageParam: null,
+    getNextPageParam: (page) => page.nextCursor,
+    placeholderData: keepPreviousData,
+  });
+}
+
+export function deliveryQuery(tenantId: string, deliveryId: string) {
+  return queryOptions({
+    queryKey: ['sales', tenantId, 'delivery', deliveryId],
+    queryFn: () => call(routes.deliveries.get, { params: { id: deliveryId } }),
+    retry: false,
+  });
+}
```

- **One prefix, `['sales', tenantId]`.** Posting a delivery changes the delivery, its order (what is delivered)
  and the lists. One invalidate of the prefix refreshes them all, like `['stock', tenantId]` in step 13.
- **`SalesListFilter<TStatus>`.** The three lists filter the same way: a status (`''` for all) and a customer
  (`''` for all). The generic keeps each status typed: the order list cannot be asked for `'posted'`.
- **`openOrdersQuery()`** feeds the delivery form's order box: the customer's confirmed orders, which are the only
  ones a delivery can take goods against. 100 at most, in one request, because a native select needs every
  option at once. Its key starts with `['sales', tenantId, 'orders']`, so confirming an order refreshes it too.
- **`retry: false` on the single documents.** A missing document (a deleted draft) is an answer, not a network
  hiccup; the page shows "not found" at once instead of after three retries.

### `components/sales-parts.tsx` (new)

```tsx
import {
  Agreement01Icon,
  ArrowLeft01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  DeliveryTruck01Icon,
  FileEditIcon,
  HourglassIcon,
  PackageDeliveredIcon,
  StopCircleIcon,
  Time04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type CustomerAddress,
  type DocumentTotals,
  isZeroMoney,
  type OrderStatus,
  type PartyRef,
  type QuotationStatus,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

import { partyLabel } from '../lib/customers';
import { isExpired, isLate } from '../lib/sales';
import { useTenantId } from './stock-parts';

// Shared by the quotation, order and delivery pages. Here, not in a route file: a route file is its
// own lazy chunk, and importing from one would pull that whole page into the others.

// After a save. Everything under ['sales', tenant] (the lists, the documents), and the stock and
// the books: confirming an order changes "on order" on the stock page, and posting a delivery
// takes stock out and writes a journal entry. One hook for the three documents, so none forgets one.
export function useSalesRefresh(): () => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['sales', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['stock', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
    ]);
  }, [queryClient, tenantId]);
}

export function SalesBackLink({
  to,
  label,
}: {
  to: '/quotations' | '/sales-orders' | '/deliveries';
  label: string;
}) {
  return (
    <Link
      to={to}
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {label}
    </Link>
  );
}

// "C-00042 · Rahman Traders", linking to the customer's page (everyone may read customers)
export function CustomerLink({ customer }: { customer: PartyRef }) {
  return (
    <Link
      to="/customers/$customerId"
      params={{ customerId: customer.id }}
      className="font-medium text-brand underline-offset-3 hover:underline"
    >
      {partyLabel(customer)}
    </Link>
  );
}

// "Mirpur depot — House 12, Road 3, Mirpur 10": how an address reads in a form's select (its first
// line; the document keeps the whole text)
export function addressLabel(address: CustomerAddress): string {
  const firstLine = address.address.split('\n')[0] ?? address.address;
  return address.label === null ? firstLine : `${address.label} — ${firstLine}`;
}

// Open, Expired (open, but the offer has ended: attention), Accepted, Declined. Never colour alone.
export function QuotationStatusPill({
  quotation,
  today,
}: {
  quotation: { status: QuotationStatus; validUntil: string | null };
  today: string;
}) {
  const { t } = useLocale();
  if (isExpired(quotation, today)) {
    return (
      <Pill tone="warn" icon={HourglassIcon}>
        {t('quotations.expired')}
      </Pill>
    );
  }
  if (quotation.status === 'accepted') {
    return (
      <Pill tone="good" icon={CheckmarkCircle02Icon}>
        {t('quotations.statuses.accepted')}
      </Pill>
    );
  }
  if (quotation.status === 'declined') {
    return (
      <Pill tone="neutral" icon={CancelCircleIcon}>
        {t('quotations.statuses.declined')}
      </Pill>
    );
  }
  return (
    <Pill tone="brand" icon={Clock01Icon}>
      {t('quotations.statuses.open')}
    </Pill>
  );
}

const ORDER_PILLS = {
  draft: { tone: 'neutral', icon: FileEditIcon },
  confirmed: { tone: 'brand', icon: Agreement01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  closed: { tone: 'neutral', icon: StopCircleIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const;

// The status, and beside it what a confirmed order is up to: partly delivered (brand: work in
// progress, not a problem) and late (warn: its delivery date has passed)
export function OrderStatusPills({
  order,
  today,
}: {
  order: { status: OrderStatus; partlyDelivered: boolean; deliveryDate: string | null };
  today: string;
}) {
  const { t } = useLocale();
  const pill = ORDER_PILLS[order.status];
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {order.partlyDelivered ? (
        <Pill tone="brand" icon={DeliveryTruck01Icon}>
          {t('salesOrders.partlyDelivered')}
        </Pill>
      ) : (
        <Pill tone={pill.tone} icon={pill.icon}>
          {t(`salesOrders.statuses.${order.status}`)}
        </Pill>
      )}
      {isLate(order, today) && (
        <Pill tone="warn" icon={Time04Icon}>
          {t('salesOrders.late')}
        </Pill>
      )}
    </span>
  );
}

export function DeliveryStatusPill({ status }: { status: StockDocumentStatus }) {
  const { t } = useLocale();
  return status === 'draft' ? (
    <Pill tone="neutral" icon={FileEditIcon}>
      {t('deliveries.statuses.draft')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('deliveries.statuses.posted')}
    </Pill>
  );
}

// The totals under a quotation's or an order's lines, in the form and on the page. Line discounts
// show only when something was given away. Paisa: an accounting document's totals must visibly
// add up (CLAUDE.md → Money).
export function SalesTotals({
  totals,
  pricesIncludeVat,
}: {
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
}) {
  const { t, format } = useLocale();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t border-line bg-subtle px-5 py-4">
      <span className="text-caption text-ink-3">
        {pricesIncludeVat ? t('salesLines.pricesWithVat') : t('salesLines.pricesWithoutVat')}
      </span>
      <dl className="ml-auto grid min-w-[16rem] grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-body-sm">
        {!isZeroMoney(totals.discount) && (
          <>
            <dt className="text-ink-2">{t('salesLines.lineDiscounts')}</dt>
            <dd className="text-right tabular-nums">−{money(totals.discount)}</dd>
          </>
        )}
        <dt className="text-ink-2">{t('salesLines.net')}</dt>
        <dd className="text-right tabular-nums">{money(totals.net)}</dd>
        <dt className="text-ink-2">{t('salesLines.vat')}</dt>
        <dd className="text-right tabular-nums">{money(totals.vat)}</dd>
        <dt className="font-medium text-ink">{t('salesLines.total')}</dt>
        <dd className="text-right font-medium tabular-nums">{money(totals.total)}</dd>
      </dl>
    </div>
  );
}
```

- **Shared parts in a component file, not a route file.** Each route file is its own lazy chunk; importing from
  one would pull that whole page into the others (the stock pages' rule).
- **`useSalesRefresh()` refreshes three prefixes.** Confirming an order changes "On order" on the stock page, and
  posting a delivery takes stock out and writes a journal entry. One hook for every sales save, so no page
  forgets the stock or the books.
- **`addressLabel()`** shows the label and the address's first line in a select. The document keeps the whole
  text (15b.3); the select only needs to tell the addresses apart.
- **The pills.** "Expired" (warn, hourglass) wins over "Open" because the person must act on it. A partly
  delivered order shows "Partly delivered" (brand, truck) instead of "Confirmed": it is work in progress, not a
  problem, so it is not `warn`. "Late" is a second pill next to it, `warn`, because it needs attention. Every
  pill has an icon and a word (CLAUDE.md: never colour alone).
- **`ORDER_PILLS` is typed by `as const` and indexed by `OrderStatus`.** A sixth status in the contract would be
  a type error here, not a pill without an icon.
- **`SalesTotals` shows paisa.** A quotation and an order are documents whose total must visibly add up (CLAUDE.md
  → Money). "Line discounts" shows only when something was given away. The left side says whether the prices
  include VAT, the document's own setting, so nobody reads ৳115 as "plus VAT".

### `components/sales-line-editor.tsx` (new): the lines of a quotation and an order

```tsx
import {
  Alert02Icon,
  Delete02Icon,
  PackageSearchIcon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  defaultLineDescription,
  MAX_SALES_LINES,
  type PriceLookupItem,
  type Product,
  type ProductSummary,
  routes,
  type SalesLineFormValues,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DiscountInput,
  EmptyState,
  IconButton,
  Input,
  MoneyInput,
  Pill,
  Select,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { FieldErrors } from 'react-hook-form';

import { call } from '../lib/api';
import { formTotals, isServiceLine, type LineMeta, type SalesItem } from '../lib/sales';
import { basePreview, unitChoices } from '../lib/stock';
import { taxRateOptions, useRateText } from '../lib/tax-rates';
import { productQuery, productSearchQuery, taxRatesQuery, unitsQuery } from '../lib/queries';
import { useDebounced } from '../lib/use-debounced';
import { failureOf, LineError } from './journal-parts';
import { SalesTotals } from './sales-parts';
import { useQuantity, useTenantId, VariantCell } from './stock-parts';

// The lines of a quotation or an order: one editor for both. The form holds the lines as one
// controlled value (a Controller on "lines"), and this editor changes that array. A field array
// would need the form's own type here, and the two forms have different types; one array value has
// the same type in both (SalesLineFormValues[]), so neither form needs a cast.

export type SalesLinesErrors = FieldErrors<{ lines: SalesLineFormValues[] }>['lines'];

let lastKey = 0;
function nextKey(): string {
  lastKey += 1;
  return `new-${String(lastKey)}`;
}

const keyOf = (variantId: string, unitId: string) => `${variantId}:${unitId}`;

// One template for the header and every line on a wide card. @5xl (64rem), not the @3xl of the
// stock lines: seven columns of controls do not fit in 48rem. Below it, each control shows its
// label.
const COLUMNS =
  '@5xl:grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_8.5rem_8.5rem_8.5rem_7.5rem_2.25rem] @5xl:items-start @5xl:gap-2';

// LineField's look, with the label hidden at @5xl (LineField hides it at @3xl)
function SalesField({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid grid-cols-1 content-start gap-1.5', className)}>
      <label htmlFor={id} className="text-label font-medium text-ink @5xl:sr-only">
        {label}
      </label>
      {children}
      <LineError id={id} error={error} />
    </div>
  );
}
```

- **Why the lines are one controlled value.** The stock forms use `useFieldArray`, which needs the form's own
  type. The quotation form and the order form have different types, so one editor for both would need
  `Control<…>` of one of them, or a cast. Instead each form puts a `Controller` on `lines`, and the editor gets
  `SalesLineFormValues[]` and an `onChange`. That type is the same in both forms (both take their lines from
  `salesLineInputSchema`), so neither form needs a cast. The editor makes every change as a new array.
- **`SalesLinesErrors`** is the error type of that array, written once from the same line type. Both forms'
  `errors.lines` fit it for the same reason.
- **`nextKey()`.** A new line needs a React key before it has an id. A counter is enough: keys only have to be
  unique on this page. A saved line uses its id.
- **`COLUMNS` and `@5xl`.** Item, unit, quantity, price, discount, VAT rate and amount do not fit in 48rem (the
  `@3xl` of the stock lines). At `@5xl` (64rem) they share one template with the header. Below it, each control
  shows its label and the line wraps into two columns. It is a container query, so the sidebar's 244px is
  counted.
- **`SalesField`** is `LineField` (step 10) with the label hidden at `@5xl` instead of `@3xl`. A screen reader
  still reads each label.

```tsx
export function SalesLinesEditor({
  lines,
  onChange,
  getLines,
  initialMeta,
  customerId,
  pricesIncludeVat,
  errors,
}: {
  lines: SalesLineFormValues[];
  onChange: (lines: SalesLineFormValues[]) => void;
  // The form's lines right now (react-hook-form's getValues): an add that waited for the price
  // lookup appends to these, not to the lines of the render that started it
  getLines: () => SalesLineFormValues[];
  initialMeta: LineMeta[];
  customerId: string;
  pricesIncludeVat: boolean;
  errors: SalesLinesErrors;
}) {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const quantityText = useQuantity();
  const rateText = useRateText();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const [meta, setMeta] = useState<LineMeta[]>(initialMeta);
  const [picking, setPicking] = useState(false);
  const [repricing, setRepricing] = useState(false);
  // The meta of the last render, for the async handlers (a unit change waits for its price)
  const metaRef = useRef(meta);
  useEffect(() => {
    metaRef.current = meta;
  });

  const rateOf = (id: string) => rates?.find((rate) => rate.id === id)?.rate ?? null;
  const { amounts, totals } = formTotals(lines, rateOf, pricesIncludeVat);
  // The rates a line may pick: the active ones, and the line's own if it was archived since
  const rateOptions = useMemo(
    () => (keep: string) => [
      { value: '', label: t('salesLines.vatRate') },
      ...taxRateOptions(rates ?? [], rateText, keep),
    ],
    [rates, rateText, t],
  );
  const repriceable =
    customerId !== '' && meta.some((line) => line.pricedFor !== customerId) && lines.length > 0;

  // Prices and rates for some variants in some units, for this customer
  const lookUp = async (items: { variantId: string; unitId: string }[]) => {
    const answer = await call(routes.salesPrices.lookup, {
      body: { customerId: customerId === '' ? null : customerId, items },
    });
    return new Map<string, PriceLookupItem>(
      answer.items.map((item) => [keyOf(item.variantId, item.unitId), item]),
    );
  };

  // "Add": every active variant of the product, in its selling unit, at the looked-up price.
  // false = the document would hold too many lines; nothing is added.
  const addProduct = async (product: Product): Promise<boolean> => {
    const variants = product.variants.filter((variant) => variant.archivedAt === null);
    if (getLines().length + variants.length > MAX_SALES_LINES) return false;
    const unitId = product.salesUnitId ?? product.baseUnitId;
    const prices = await lookUp(variants.map((variant) => ({ variantId: variant.id, unitId })));
    const added = variants.map((variant) => {
      const found = prices.get(keyOf(variant.id, unitId));
      const line: SalesLineFormValues = {
        variantId: variant.id,
        unitId,
        quantity: '',
        description: '',
        unitPrice: found?.price ?? '',
        discountType: 'percent',
        discount: '',
        // Left empty when the lookup had no rate (no default rate): the box says to pick one
        taxRateId: found?.taxRateId ?? '',
      };
      const item: SalesItem = {
        variantId: variant.id,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        optionValues: variant.optionValues,
        sku: variant.sku,
        baseUnitId: product.baseUnitId,
        units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
        productType: product.type,
      };
      return {
        line,
        meta: { key: nextKey(), item, source: found?.source ?? null, pricedFor: customerId },
      };
    });
    onChange([...getLines(), ...added.map((entry) => entry.line)]);
    setMeta((before) => [...before, ...added.map((entry) => entry.meta)]);
    return true;
  };

  const remove = (index: number) => {
    onChange(lines.filter((_, at) => at !== index));
    setMeta((before) => before.filter((_, at) => at !== index));
  };

  const update = (index: number, patch: Partial<SalesLineFormValues>) => {
    onChange(lines.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  };

  // A price is per unit: a carton has its own price on a price list. A new unit asks for its
  // price; a unit with no price anywhere keeps what was typed.
  const changeUnit = async (index: number, unitId: string) => {
    update(index, { unitId });
    const key = meta[index]?.key;
    const variantId = lines[index]?.variantId;
    if (key === undefined || variantId === undefined) return;
    try {
      const found = (await lookUp([{ variantId, unitId }])).get(keyOf(variantId, unitId));
      // The line may have moved (a line above it removed) or gone while we waited
      const at = metaRef.current.findIndex((line) => line.key === key);
      const now = getLines()[at];
      const price = found?.price ?? null;
      if (at === -1 || now?.unitId !== unitId || price === null) return;
      onChange(getLines().map((line, i) => (i === at ? { ...line, unitPrice: price } : line)));
      setMeta((before) =>
        before.map((line, i) =>
          i === at ? { ...line, source: found?.source ?? null, pricedFor: customerId } : line,
        ),
      );
    } catch {
      // The typed price stays; the person can type the new one
    }
  };

  // "Use this customer's prices on every line": only lines with a price somewhere change
  const reprice = async () => {
    setRepricing(true);
    try {
      const prices = await lookUp(
        lines.map((line) => ({ variantId: line.variantId, unitId: line.unitId })),
      );
      onChange(
        getLines().map((line) => {
          const price = prices.get(keyOf(line.variantId, line.unitId))?.price ?? null;
          return price === null ? line : { ...line, unitPrice: price };
        }),
      );
      setMeta((before) =>
        before.map((line, at) => {
          const now = lines[at];
          const found = now ? prices.get(keyOf(now.variantId, now.unitId)) : undefined;
          return { ...line, source: found?.source ?? null, pricedFor: customerId };
        }),
      );
      toast(t('salesLines.repriced'));
    } catch (error) {
      toast(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setRepricing(false);
    }
  };

  const listError = errors?.root?.message ?? errors?.message;
```

- **`getLines()`.** Adding a product waits for the price lookup. A store keeper may click "Add" on three products
  quickly; each answer must append to the lines as they are then, not to the lines of the render that started
  it, or the second answer would drop the first. `getValues('lines')` from the form is always current.
- **`metaRef`** gives the same for the editor's own state. It is updated in an effect (writing a ref during
  render is not allowed), and only the async unit change reads it.
- **`rateOptions(keep)`**: the active rates, plus the line's own rate if it was archived since. Without it, the
  select would silently show another rate, and the next save would change the line's VAT.
- **`repriceable`.** The link shows only when some line was priced for another customer (or for none).
  Changing the customer never reprices by itself: a price typed by hand from the buyer's PO must not vanish.
- **`addProduct()` adds every active variant**, each in the product's selling unit (step 12's `salesUnitId`) at
  the looked-up price. A garments order lists sizes and colours line by line; the person removes what is not
  ordered. It returns `false` instead of adding when the document would pass `MAX_SALES_LINES`, so the dialog can
  say why (`tooMany`) instead of letting the person build a form the API refuses.
- **An empty `taxRateId`** when the lookup has no rate (a workspace without a default rate). The select then shows
  "VAT rate" and the contract's `tax_rate_invalid` asks for one. A guessed rate would be worse.
- **`changeUnit()` asks for the price again.** A price list has a price per unit; a carton is not 24 times a piece.
  The line is found again by its key after the wait, and nothing changes if the line was removed, its unit was
  changed once more, or no price exists for the new unit (the typed price stays).
- **`reprice()` changes only lines that have a price somewhere.** A line with no price on the list or the product
  keeps what was typed. The source under each price is updated, so the page says where each price now comes
  from.

```tsx
  return (
    <Card
      className="@container grid grid-cols-1 overflow-hidden"
      aria-label={t('salesLines.items')}
    >
      {repriceable && (
        <div className="border-b border-line px-5 py-3">
          <button
            type="button"
            disabled={repricing}
            onClick={() => void reprice()}
            className="text-label font-medium text-brand underline-offset-3 hover:underline"
          >
            {t('salesLines.reprice')}
          </button>
        </div>
      )}
      {lines.length === 0 ? (
        <p className="px-5 py-6 text-body-sm text-ink-2">{t('salesLines.noLines')}</p>
      ) : (
        <div
          aria-hidden="true"
          className={cn(
            'hidden bg-subtle px-5 py-2 text-caption font-medium text-ink-3 @5xl:grid',
            COLUMNS,
          )}
        >
          <span>{t('salesLines.item')}</span>
          <span>{t('salesLines.unit')}</span>
          <span className="text-right">{t('salesLines.quantity')}</span>
          <span className="text-right">
            {pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')}
          </span>
          <span className="text-right">{t('salesLines.discount')}</span>
          <span>{t('salesLines.vatRate')}</span>
          <span className="text-right">{t('salesLines.amount')}</span>
        </div>
      )}
      {lines.map((line, index) => {
        const lineMeta = meta[index];
        if (!lineMeta) return null;
        const { item } = lineMeta;
        const number = index + 1;
        const lineErrors = errors?.[index];
        const id = (field: string) => `lines.${String(index)}.${field}`;
        const preview = basePreview(item, line.unitId, line.quantity, units);
        const amount = amounts[index];
        const removeButton = (
          <IconButton
            icon={Delete02Icon}
            label={t('salesLines.remove', { number })}
            onClick={() => {
              remove(index);
            }}
          />
        );
        return (
          <div
            key={lineMeta.key}
            role="group"
            aria-label={t('salesLines.line', { number })}
            className={cn('grid grid-cols-2 gap-3 border-t border-line px-5 py-4', COLUMNS)}
          >
            <div className="col-span-2 grid min-w-0 gap-2 @5xl:col-span-1">
              <div className="flex items-start justify-between gap-3">
                <span className="grid min-w-0 gap-1">
                  <VariantCell item={item} />
                  {isServiceLine(item) && (
                    <span>
                      <Pill tone="neutral" icon={Wrench01Icon}>
                        {t('salesLines.service')}
                      </Pill>
                    </span>
                  )}
                </span>
                <span className="@5xl:hidden">{removeButton}</span>
              </div>
              <SalesField
                id={id('description')}
                label={t('salesLines.description')}
                error={lineErrors?.description?.message}
              >
                <Input
                  id={id('description')}
                  autoComplete="off"
                  placeholder={defaultLineDescription(item)}
                  value={line.description ?? ''}
                  invalid={lineErrors?.description !== undefined}
                  onChange={(event) => {
                    update(index, { description: event.target.value });
                  }}
                />
              </SalesField>
            </div>
            <SalesField
              id={id('unitId')}
              label={t('salesLines.unit')}
              error={lineErrors?.unitId?.message}
            >
              <Select
                id={id('unitId')}
                options={unitChoices(item, units)}
                value={line.unitId}
                invalid={lineErrors?.unitId !== undefined}
                onChange={(event) => void changeUnit(index, event.target.value)}
              />
            </SalesField>
            <SalesField
              id={id('quantity')}
              label={t('salesLines.quantity')}
              error={lineErrors?.quantity?.message}
            >
              <Input
                id={id('quantity')}
                inputMode="decimal"
                autoComplete="off"
                align="end"
                value={line.quantity}
                invalid={lineErrors?.quantity !== undefined}
                aria-describedby={lineErrors?.quantity ? `${id('quantity')}-error` : undefined}
                onChange={(event) => {
                  update(index, { quantity: event.target.value });
                }}
              />
              {preview !== null && (
                <span className="text-right text-caption text-ink-3 tabular-nums">
                  {t('stockLines.equals', { quantity: quantityText(preview, item.baseUnitId) })}
                </span>
              )}
            </SalesField>
            <SalesField
              id={id('unitPrice')}
              label={
                pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')
              }
              error={lineErrors?.unitPrice?.message}
            >
              <MoneyInput
                id={id('unitPrice')}
                value={line.unitPrice}
                invalid={lineErrors?.unitPrice !== undefined}
                aria-describedby={lineErrors?.unitPrice ? `${id('unitPrice')}-error` : undefined}
                onChange={(value) => {
                  update(index, { unitPrice: value });
                }}
              />
              {lineMeta.source !== undefined && (
                <span className="text-right text-caption text-ink-3">
                  {lineMeta.source === 'price_list'
                    ? t('salesLines.fromPriceList')
                    : lineMeta.source === 'product'
                      ? t('salesLines.fromProduct')
                      : t('salesLines.noPrice')}
                </span>
              )}
            </SalesField>
            <SalesField
              id={id('discount')}
              label={t('salesLines.discount')}
              error={lineErrors?.discount?.message}
            >
              <DiscountInput
                id={id('discount')}
                value={line.discount}
                discountType={line.discountType}
                invalid={lineErrors?.discount !== undefined}
                aria-describedby={lineErrors?.discount ? `${id('discount')}-error` : undefined}
                onChange={(value) => {
                  update(index, { discount: value });
                }}
                onDiscountTypeChange={(discountType) => {
                  update(index, { discountType });
                }}
              />
            </SalesField>
            <SalesField
              id={id('taxRateId')}
              label={t('salesLines.vatRate')}
              error={lineErrors?.taxRateId?.message}
            >
              <Select
                id={id('taxRateId')}
                options={rateOptions(line.taxRateId)}
                value={line.taxRateId}
                invalid={lineErrors?.taxRateId !== undefined}
                onChange={(event) => {
                  update(index, { taxRateId: event.target.value });
                }}
              />
            </SalesField>
            <div className="grid content-start gap-1.5">
              <span className="text-label font-medium text-ink @5xl:sr-only">
                {t('salesLines.amount')}
              </span>
              {/* Quantity × price, less the discount: the line in the price's own terms (with VAT
                  when prices include it). The VAT is in the totals below. */}
              <span className="py-2.5 text-right text-body-sm font-medium tabular-nums">
                {amount
                  ? format.money(pricesIncludeVat ? amount.total : amount.net, { decimals: 2 })
                  : '—'}
              </span>
            </div>
            <div className="hidden @5xl:block @5xl:pt-1">{removeButton}</div>
          </div>
        );
      })}
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
      <div className="border-t border-line px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setPicking(true);
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
          {t('salesLines.addItems')}
        </Button>
      </div>
      {lines.length > 0 && <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />}

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && <SalesItemPicker onAdd={addProduct} />}
      </Dialog>
    </Card>
  );
}
```

- **The header says which price it is**: "Price with VAT" or "Price before VAT", from the document's own setting.
  The same number means two prices.
- **The description box's placeholder is `defaultLineDescription(item)`**, the text the API writes for an empty
  box. The person sees what the document will say without typing it.
- **The price's source under the box** ("From their price list", "Product price", "No price set: type one")
  shows only for lines added or repriced here. A saved line has `source: undefined` and shows nothing.
- **The amount is quantity × price less the discount, in the price's own terms**: with VAT when prices include
  it, before VAT when they do not. That is the number a salesperson checks against the buyer's PO. The VAT is in
  the totals.
- **`listError`** is the array's own error ("Add at least one item"). react-hook-form keeps it on `lines.root`
  when it comes from the server, and on `lines` when it comes from the resolver.
- **The dialog renders the picker only while open** (`{picking && …}`), so its search query does not run in the
  background.

```tsx
// "Add items": search the products and services, then add one. The dialog stays open, so a long
// order is put together without closing it; each click adds the product's lines at once.
function SalesItemPicker({ onAdd }: { onAdd: (product: Product) => Promise<boolean> }) {
  const { t, errorText } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 250);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: products } = useQuery(productSearchQuery(tenantId, settled));

  // The list sends a summary; the variants, the packs and the selling unit come with the product
  const add = async (summary: ProductSummary) => {
    setLoading(summary.id);
    setProblem(null);
    try {
      const fits = await onAdd(await queryClient.query(productQuery(tenantId, summary.id)));
      if (fits) setAdded((before) => new Set(before).add(summary.id));
      else setProblem(t('salesLines.tooMany', { max: MAX_SALES_LINES }));
    } catch (error) {
      setProblem(errorText(failureOf(error instanceof Error ? error : null) ?? 'unknown_error'));
    } finally {
      setLoading(null);
    }
  };

  return (
    <DialogContent
      title={t('salesLines.pickerTitle')}
      description={t('salesLines.pickerDescription')}
    >
      <div className="grid grid-cols-1 gap-4">
        <Input
          type="search"
          icon={Search01Icon}
          aria-label={t('salesLines.pickerSearch')}
          placeholder={t('products.searchPlaceholder')}
          autoFocus
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />
        {problem !== null && (
          <p role="status" className="flex items-center gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
            {problem}
          </p>
        )}
        {products?.length === 0 ? (
          <EmptyState
            icon={PackageSearchIcon}
            title={t('salesLines.pickerEmpty')}
            description={t('salesLines.pickerDescription')}
          />
        ) : (
          <ul className="grid max-h-[min(420px,55dvh)] grid-cols-1 gap-px overflow-y-auto">
            {products?.map((product) => (
              <li
                key={product.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-subtle"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-body-sm font-medium">{product.name}</span>
                  <span className="truncate text-caption text-ink-3">
                    <span className="font-mono tabular-nums">{product.code}</span>
                    {product.hasVariants &&
                      ` · ${t('products.variantCount', { count: product.variantCount })}`}
                  </span>
                </span>
                {isServiceLine({ productType: product.type }) && (
                  <Pill tone="neutral" icon={Wrench01Icon}>
                    {t('salesLines.service')}
                  </Pill>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading === product.id}
                  onClick={() => void add(product)}
                >
                  <HugeiconsIcon
                    icon={added.has(product.id) ? Tick02Icon : PlusSignIcon}
                    size={16}
                    strokeWidth={1.5}
                  />
                  {added.has(product.id) ? t('salesLines.added') : t('salesLines.add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DialogContent>
  );
}
```

- **Products, not stock items.** The stock search (`ItemPicker`) lists goods with their stock. A quotation also
  sells services ("Delivery charge"), so this picker searches the products, like the price list's picker
  (15a), and marks a service with a pill.
- **`queryClient.query(productQuery(…))`.** The list sends a summary; the variants, packs and selling unit come
  with the product. Going through the query cache means a product added twice is fetched once.
- **Problems stay in the dialog** (`role="status"`), next to the button that caused them. A toast would vanish
  behind the dialog.

### `components/sales-lines-table.tsx` (new): the lines, read only

```tsx
import {
  defaultLineDescription,
  type DocumentTotals,
  isZeroMoney,
  plainQuantity,
  type SalesLine,
  type SalesOrderLine,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card } from '@omnivo/ui';

import { isServiceLine, leftToDeliver } from '../lib/sales';
import { variantName } from '../lib/stock';
import { useRateText } from '../lib/tax-rates';
import { SalesTotals } from './sales-parts';
import { useQuantity } from './stock-parts';

// The lines of a quotation or an order that is no longer edited here: a real <table> in a card,
// scrolling inside its own box on a phone, with the document's totals under it. An order's lines
// (`delivered`) also say how much went out and how much is left.
export function SalesLinesTable({
  lines,
  totals,
  pricesIncludeVat,
  delivered = false,
}: {
  lines: readonly (SalesLine | SalesOrderLine)[];
  totals: DocumentTotals;
  pricesIncludeVat: boolean;
  delivered?: boolean;
}) {
  const { t, format } = useLocale();
  const quantity = useQuantity();
  const rateText = useRateText();
  const money = (value: string) => format.money(value, { decimals: 2 });
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-body-sm">
          <caption className="sr-only">{t('salesLines.items')}</caption>
          <thead>
            <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.item')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.quantity')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {pricesIncludeVat ? t('salesLines.priceWithVat') : t('salesLines.priceWithoutVat')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.discount')}
              </th>
              <th scope="col" className="px-5 py-2.5">
                {t('salesLines.vatRate')}
              </th>
              <th scope="col" className="px-5 py-2.5 text-right">
                {t('salesLines.amount')}
              </th>
              {delivered && (
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('salesOrders.delivered')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-line align-top">
                <td className="px-5 py-3">
                  <span className="grid max-w-[24rem] min-w-0">
                    <span className="font-medium text-ink">{line.description}</span>
                    {/* The product too, when the line says something else ("220 GSM pique") */}
                    <span className="truncate text-caption text-ink-3">
                      {line.description !== defaultLineDescription(line) &&
                        `${variantName(line)} · `}
                      <span className="font-mono">{line.sku}</span>
                    </span>
                  </span>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {quantity(line.quantity, line.unitId)}
                  {line.unitId !== line.baseUnitId && (
                    <span className="block text-caption text-ink-3">
                      {t('stockLines.equals', {
                        quantity: quantity(line.baseQuantity, line.baseUnitId),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {money(line.unitPrice)}
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                  {isZeroMoney(line.discount)
                    ? '—'
                    : line.discountType === 'percent'
                      ? `${format.number(plainQuantity(line.discount), 2)}%`
                      : money(line.discount)}
                </td>
                <td className="px-5 py-3 whitespace-nowrap">
                  {line.taxRate.name}
                  <span className="block text-caption text-ink-3 tabular-nums">
                    {rateText(line.taxRate.rate)}
                  </span>
                </td>
                <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                  {money(pricesIncludeVat ? line.total : line.net)}
                </td>
                {delivered && 'deliveredQuantity' in line && (
                  <td className="px-5 py-3 text-right whitespace-nowrap tabular-nums">
                    {isServiceLine(line) ? (
                      <span className="text-caption text-ink-3">
                        {t('salesOrders.serviceLine')}
                      </span>
                    ) : (
                      <>
                        {quantity(line.deliveredQuantity, line.baseUnitId)}
                        <span className="block text-caption text-ink-3">
                          {t('salesOrders.left')}: {quantity(leftToDeliver(line), line.baseUnitId)}
                        </span>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SalesTotals totals={totals} pricesIncludeVat={pricesIncludeVat} />
    </Card>
  );
}
```

- **A real `<table>`** in a card, scrolling sideways inside its own box on a phone (CLAUDE.md → Table). The page
  body never scrolls sideways.
- **The product line under the description** shows only when the description says something else ("220 GSM
  pique, buyer's label"), so the reader still knows which product it is.
- **The discount column** shows "10%" or "৳250.00", the way it was given. A dash means none.
- **The VAT rate is the line's own copy** (`line.taxRate`), not today's rate: a confirmed order keeps the VAT it
  was agreed with.
- **`delivered`** adds the order's "Delivered" column with what is left under it, and says "A service: not
  delivered" on a service line. The `'deliveredQuantity' in line` check narrows the union without a cast.

### `components/customer-picker.tsx`: a filter can mean "every customer"

```diff
@@ -24,13 +24,15 @@ interface CustomerPickerProps {
   disabled?: boolean | undefined;
   'aria-label'?: string | undefined;
   'aria-describedby'?: string | undefined;
+  // A list's filter (step 15b): the first option, '' = every customer, and the empty box's text
+  allLabel?: string | undefined;
 }
 
 // The customer box of a journal line and of the opening balances (step 15a): ui's Combobox with
 // the search on the server. Active customers only, like the API takes them on a new line.
 // `...box`: id, name, onBlur, ref and the aria props go to the Combobox as they came. Spread, not
 // one by one: with exactOptionalPropertyTypes, `name={name}` would pass an explicit undefined.
-export function CustomerPicker({ value, saved, onChange, ...box }: CustomerPickerProps) {
+export function CustomerPicker({ value, saved, onChange, allLabel, ...box }: CustomerPickerProps) {
   const { t } = useLocale();
   const tenantId = useSession((state) => state.me?.tenant.id) ?? '';
   const [search, setSearch] = useState('');
@@ -41,13 +43,16 @@ export function CustomerPicker({ value, saved, onChange, ...box }: CustomerPicke
   const [picked, setPicked] = useState<{ value: string; label: string } | null>(null);
 
   const options = useMemo<ComboboxOption[]>(
-    () =>
-      (data ?? []).map((customer) => ({
+    () => [
+      // A filter can go back to "every customer"; a form's box cannot be emptied this way
+      ...(allLabel === undefined ? [] : [{ value: '', label: allLabel }]),
+      ...(data ?? []).map((customer) => ({
         value: customer.id,
         label: customer.name,
         detail: [customer.code, customer.phone].filter((part) => part !== null).join(' · '),
       })),
-    [data],
+    ],
+    [data, allLabel],
   );
 
   const selectedLabel =
@@ -75,7 +80,7 @@ export function CustomerPicker({ value, saved, onChange, ...box }: CustomerPicke
       // Searching for the next word: the old matches stay, marked busy
       loading={isFetching}
       icon={UserIcon}
-      placeholder={t('journal.customerPlaceholder')}
+      placeholder={allLabel ?? t('journal.customerPlaceholder')}
       searchPlaceholder={t('customers.pickerSearch')}
       emptyText={t('customers.pickerEmpty')}
     />
```

- **`allLabel`.** The three lists filter by customer with the same combobox the forms use: a distributor has
  thousands of customers, too many for a select. With `allLabel`, the first option is `''`, "All customers",
  and the empty box says the same. A form's box has no such option, so a form can never send an empty customer
  by mistake.

### The lists: `routes/quotations.tsx`, `routes/sales-orders.tsx`, `routes/deliveries.tsx` (new)

```tsx
import { Note01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { QUOTATION_STATUSES, type QuotationStatus, type QuotationSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { CustomerPicker } from '../components/customer-picker';
import { QuotationStatusPill } from '../components/sales-parts';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { quotationsQuery } from '../lib/queries';

const column = dataTableColumns<QuotationSummary>();

export function QuotationsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.quotation.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [status, setStatus] = useState<QuotationStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    quotationsQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('quotations.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">{row.original.number}</span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((quotation) => quotation.customer.name, {
          id: 'customer',
          header: t('quotations.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('validUntil', {
          header: t('quotations.columns.validUntil'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const until = getValue();
            return until === null ? t('quotations.noEndDate') : isoDate(until);
          },
        }),
        column.accessor('total', {
          header: t('quotations.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka (CLAUDE.md → Money); the quotation's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('status', {
          header: t('quotations.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <QuotationStatusPill quotation={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/quotations/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('quotations.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('quotations.title')}
        description={t('quotations.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="quotations-customer"
            aria-label={t('quotations.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('quotations.show')}
          value={status}
          options={[
            { value: '', label: t('quotations.all') },
            ...QUOTATION_STATUSES.map((value) => ({
              value,
              label: t(`quotations.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('quotations.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('quotations.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/quotations/$quotationId', params: { quotationId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={Note01Icon}
              title={t('quotations.emptyTitle')}
              description={t('quotations.emptyBody')}
              action={write}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

- **The stock documents' list**, with a customer filter next to the status. The server filters and pages
  (`quotationsQuery`); 50 at a time, the next page when the end scrolls into view.
- **Whole taka in the total column.** A list shows whole taka (CLAUDE.md → Money); the quotation's page shows
  paisa.
- **The status pill gets `today`**, so an open quotation past its date shows "Expired" in the list too.
- **`write` is the "New quotation" button, or `false`.** It is used twice, in the header and in the empty state,
  and only for someone with `sales.quotation.manage`. Everyone else may read the list (reading needs no
  permission, 15b.1).

```tsx
import { PlusSignIcon, ShoppingCart01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { ORDER_STATUSES, type OrderStatus, type SalesOrderSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { CustomerPicker } from '../components/customer-picker';
import { OrderStatusPills } from '../components/sales-parts';
import { useIsoDate, useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { salesOrdersQuery } from '../lib/queries';

const column = dataTableColumns<SalesOrderSummary>();

export function SalesOrdersPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.order.manage');
  const isoDate = useIsoDate();
  const today = useToday();
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    salesOrdersQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('salesOrders.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('salesOrders.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((order) => order.customer.name, {
          id: 'customer',
          header: t('salesOrders.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              {/* The buyer's PO number is how the customer asks about the order */}
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customerReference ?? row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('deliveryDate', {
          header: t('salesOrders.columns.deliveryDate'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const date = getValue();
            return date === null ? '—' : isoDate(date);
          },
        }),
        column.accessor('total', {
          header: t('salesOrders.columns.total'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          // A list shows whole taka (CLAUDE.md → Money); the order's page shows paisa
          cell: ({ getValue }) => format.money(getValue()),
        }),
        column.accessor('status', {
          header: t('salesOrders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => <OrderStatusPills order={row.original} today={today} />,
        }),
      ]),
    [t, format, isoDate, today],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/sales-orders/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('salesOrders.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('salesOrders.title')}
        description={t('salesOrders.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="orders-customer"
            aria-label={t('salesOrders.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('salesOrders.show')}
          value={status}
          options={[
            { value: '', label: t('salesOrders.all') },
            ...ORDER_STATUSES.map((value) => ({
              value,
              label: t(`salesOrders.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('salesOrders.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('salesOrders.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/sales-orders/$orderId', params: { orderId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={ShoppingCart01Icon}
              title={t('salesOrders.emptyTitle')}
              description={t('salesOrders.emptyBody')}
              action={write}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

- **The customer's reference under the name.** A buyer asks about "PO-HM-2026-1187", not about SO-2026-27-0042,
  so the list shows their number where it has one.
- **A draft says "Draft"** in the number column: it has no number until it is confirmed.

```tsx
import { DeliveryTruck01Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  type DeliverySummary,
  STOCK_DOCUMENT_STATUSES,
  type StockDocumentStatus,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
} from '@omnivo/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { CustomerPicker } from '../components/customer-picker';
import { DeliveryStatusPill } from '../components/sales-parts';
import { useIsoDate, useTenantId, useWarehouses, warehouseLabel } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { deliveriesQuery } from '../lib/queries';

const column = dataTableColumns<DeliverySummary>();

export function DeliveriesPage() {
  const { t } = useLocale();
  const navigate = useNavigate();
  const canWrite = useCan()('sales.delivery.manage');
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  const [status, setStatus] = useState<StockDocumentStatus | ''>('');
  const [customerId, setCustomerId] = useState('');
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    deliveriesQuery(useTenantId(), { status, customerId }),
  );
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('deliveries.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              <span className="font-mono font-medium tabular-nums">
                {row.original.number ?? t('deliveries.statuses.draft')}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {isoDate(row.original.date)}
              </span>
            </span>
          ),
        }),
        column.accessor((delivery) => delivery.customer.name, {
          id: 'customer',
          header: t('deliveries.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0 max-w-[18rem]">
              <span className="truncate">{row.original.customer.name}</span>
              <span className="truncate font-mono text-caption text-ink-3">
                {row.original.customer.code}
              </span>
            </span>
          ),
        }),
        column.accessor('order', {
          header: t('deliveries.columns.order'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => {
            const order = getValue();
            // A delivery without an order; or one whose order is a draft again (no number)
            return order === null ? (
              <span className="text-ink-3">{t('deliveries.noOrder')}</span>
            ) : (
              <span className="font-mono tabular-nums">
                {order.number ?? t('salesOrders.statuses.draft')}
              </span>
            );
          },
        }),
        column.accessor('warehouseId', {
          header: t('deliveries.columns.warehouse'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => warehouseLabel(byId.get(getValue())),
        }),
        column.accessor('lineCount', {
          header: t('deliveries.columns.lines'),
          enableSorting: false,
          meta: { align: 'end', card: 'detail' },
          cell: ({ getValue }) => t('salesLines.lineCount', { count: getValue() }),
        }),
        column.accessor('status', {
          header: t('deliveries.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ getValue }) => <DeliveryStatusPill status={getValue()} />,
        }),
      ]),
    [t, isoDate, byId],
  );

  const write = canWrite && (
    <Button onClick={() => void navigate({ to: '/deliveries/new' })}>
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('deliveries.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('deliveries.title')}
        description={t('deliveries.description')}
        actions={write}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 basis-72">
          <CustomerPicker
            id="deliveries-customer"
            aria-label={t('deliveries.customer')}
            value={customerId}
            saved={null}
            onChange={setCustomerId}
            allLabel={t('customers.allCustomers')}
          />
        </div>
        <SegmentedControl
          label={t('deliveries.show')}
          value={status}
          options={[
            { value: '', label: t('deliveries.all') },
            ...STOCK_DOCUMENT_STATUSES.map((value) => ({
              value,
              label: t(`deliveries.statuses.${value}`),
            })),
          ]}
          onChange={setStatus}
        />
      </div>
      {isError && <p className="text-body-sm text-crit">{t('deliveries.loadFailed')}</p>}
      {rows && (
        <DataTable
          label={t('deliveries.title')}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          onRowClick={(row) =>
            void navigate({ to: '/deliveries/$deliveryId', params: { deliveryId: row.id } })
          }
          onEndReached={loadMore}
          empty={
            <EmptyState
              icon={DeliveryTruck01Icon}
              title={t('deliveries.emptyTitle')}
              description={t('deliveries.emptyBody')}
              action={write}
            />
          }
          footer={
            isFetchingNextPage && (
              <p className="text-caption text-ink-3">{t('common.loadingMore')}</p>
            )
          }
        />
      )}
    </div>
  );
}
```

- **The order column** says "No order" for goods a customer collected without one. `documentRef`'s number may be
  `null` (a draft order has none), but a delivery's order always has one: only confirmed orders are delivered,
  and an order with a delivery never goes back to draft. "Draft" is only the fallback the type asks for.
- **The warehouse** is in the list because the same customer is often served from two depots.

### Quotations: `components/quotation-form.tsx`, `components/quotation-view.tsx`, `routes/quotation.tsx` (new)

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Quotation,
  type QuotationFormValues,
  routes,
  updateQuotationInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  DatePicker,
  FormField,
  PageHeader,
  TextField,
  toast,
} from '@omnivo/ui';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { type LineMeta, SALES_LINE_FIELDS, savedLines } from '../lib/sales';
import { CustomerPicker } from './customer-picker';
import { SalesBackLink, useSalesRefresh } from './sales-parts';

// The quotation form: its own chunk (loaded by routes/quotation.tsx), because the form library, the
// date picker and the line editor are only needed to write.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money and discount boxes (cost-input.tsx says the same of the adjustment form), and inside this
// chunk it took the form over its 100 KB budget
const SalesLinesEditor = lazy(async () => ({
  default: (await import('./sales-line-editor')).SalesLinesEditor,
}));

type FormValues = QuotationFormValues;

// The server's field names for the errors it can send: one set per line
function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'validUntil',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// Writing a new quotation, or changing an open one. It gets its number on the first save.
export function QuotationForm({
  quotation,
  today,
  pricesIncludeVat,
  onClose,
}: {
  quotation: Quotation | null;
  today: string;
  // The quotation's own copy of the setting, or the workspace's now for a new one
  pricesIncludeVat: boolean;
  // Back to the quotation's page (an edit); a new quotation goes to its page instead
  onClose?: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const refresh = useSalesRefresh();
  const [start] = useState(() =>
    quotation
      ? savedLines(quotation.lines, quotation.customer.id)
      : { values: [], meta: [] as LineMeta[] },
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateQuotationInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: quotation?.customer.id ?? '',
      date: quotation?.date ?? today,
      validUntil: quotation?.validUntil ?? '',
      note: quotation?.note ?? '',
      lines: start.values,
      // A new quotation has no version; 1 passes the schema, and the create route never reads it
      version: quotation?.version ?? 1,
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const lineCount = useWatch({ control, name: 'lines' }).length;

  const onSubmit = handleSubmit(async ({ version, ...values }) => {
    try {
      const saved = quotation
        ? await call(routes.quotations.update, {
            params: { id: quotation.id },
            body: { ...values, version },
          })
        : await call(routes.quotations.create, { body: values });
      await refresh();
      toast(t('quotations.saved', { number: saved.number }));
      if (quotation) onClose?.();
      else {
        void navigate({
          to: '/quotations/$quotationId',
          params: { quotationId: saved.id },
          replace: true,
        });
      }
    } catch (error) {
      applyApiError(error, fieldNames(lineCount), setError);
    }
  });

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/quotations" label={t('quotations.back')} />
      <PageHeader
        title={quotation ? quotation.number : t('quotations.newTitle')}
        description={t('quotations.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {errors.root?.server?.message && <FormAlert message={errors.root.server.message} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-[minmax(0,1.6fr)_13rem_13rem]">
          <FormField control={control} name="customerId" label={t('quotations.customer')}>
            {(field) => (
              <CustomerPicker
                {...field}
                saved={quotation?.customer ?? null}
                aria-label={t('quotations.customer')}
              />
            )}
          </FormField>
          <FormField control={control} name="date" label={t('quotations.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <FormField
            control={control}
            name="validUntil"
            label={t('quotations.validUntil')}
            optional
            hint={t('quotations.validUntilHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('quotations.note')}
              optional
              placeholder={t('quotations.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Controller
          control={control}
          name="lines"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <SalesLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                customerId={customerId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {onClose && (
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('quotations.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
```

- **The editor is a lazy chunk.** It brings `MoneyInput` and `DiscountInput`, and with them decimal.js (about
  13 KB gzipped). Inside the form's chunk it took the form to 110 KB, over the 100 KB budget. The adjustment
  form did the same with its cost box in step 14 (`cost-input.tsx`). The fallback is an empty card, so the
  page does not jump much when the editor arrives a moment later.
- **`fieldNames()` lists every path the server may name**, the line fields from `SALES_LINE_FIELDS`. `rowPath()`
  builds `lines.3.unitPrice` with the type react-hook-form wants, so the list type-checks against this form.
- **`start` is kept in state.** `savedLines()` builds new objects on every call; kept once, the form's default
  lines and the editor's meta are made from the same call and stay in step.
- **`version: 1` for a new quotation** passes the schema; the create route never reads it (the journal's rule).
- **After a save**: a new quotation goes to its page (`replace`, so "Back" does not open an empty form); an edit
  closes the form (`onClose`), and the page shows the saved quotation.

```tsx
import {
  Delete02Icon,
  HourglassIcon,
  InformationCircleIcon,
  PencilEdit02Icon,
  ShoppingCart01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Quotation, routes } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, FormAlert, PageHeader, toast } from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { isExpired } from '../lib/sales';
import { Fact } from './adjustment-view';
import { failureOf } from './journal-parts';
import { SalesLinesTable } from './sales-lines-table';
import { CustomerLink, QuotationStatusPill, SalesBackLink, useSalesRefresh } from './sales-parts';
import { useIsoDate } from './stock-parts';

// A notice above a document: what its state means and what to do next. Icon plus words, never
// colour alone; warn for an offer that has ended, neutral otherwise.
export function DocumentNotice({
  tone,
  children,
}: {
  tone: 'warn' | 'neutral';
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === 'warn'
          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
      }
    >
      <HugeiconsIcon
        icon={tone === 'warn' ? HourglassIcon : InformationCircleIcon}
        size={17}
        strokeWidth={1.5}
        className="mt-px shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}

// A quotation as the customer got it, with what can be done with it next: make the order, change
// it, mark it declined or delete it while it is open; open it again once declined.
export function QuotationView({
  quotation,
  today,
  onEdit,
}: {
  quotation: Quotation;
  today: string;
  onEdit: () => void;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const refresh = useSalesRefresh();
  const can = useCan();
  const canWrite = can('sales.quotation.manage');
  const canOrder = can('sales.order.manage');
  const [confirming, setConfirming] = useState(false);
  const open = quotation.status === 'open';
  const { version } = quotation;

  const decline = useMutation({
    mutationFn: () =>
      call(routes.quotations.decline, { params: { id: quotation.id }, body: { version } }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('quotations.declined', { number: saved.number }));
    },
  });
  const reopen = useMutation({
    mutationFn: () =>
      call(routes.quotations.reopen, { params: { id: quotation.id }, body: { version } }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('quotations.reopened', { number: saved.number }));
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      call(routes.quotations.remove, { params: { id: quotation.id }, query: { version } }),
    onSuccess: async () => {
      await refresh();
      toast(t('quotations.deleted', { number: quotation.number }));
      void navigate({ to: '/quotations' });
    },
  });
  const failure = failureOf(decline.error) ?? failureOf(reopen.error) ?? failureOf(remove.error);
  const busy = decline.isPending || reopen.isPending || remove.isPending;

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/quotations" label={t('quotations.back')} />
      <PageHeader
        title={quotation.number}
        description={quotation.customer.name}
        actions={<QuotationStatusPill quotation={quotation} today={today} />}
      />
      {failure && <FormAlert message={failure} />}
      {isExpired(quotation, today) && quotation.validUntil !== null && (
        <DocumentNotice tone="warn">
          {t('quotations.expiredNotice', { date: isoDate(quotation.validUntil) })}
        </DocumentNotice>
      )}
      {quotation.status === 'declined' && (
        <DocumentNotice tone="neutral">{t('quotations.declinedNotice')}</DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('quotations.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={quotation.customer} />
          </span>
        </div>
        <Fact label={t('quotations.date')} value={isoDate(quotation.date)} />
        <Fact
          label={t('quotations.validUntil')}
          value={
            quotation.validUntil === null
              ? t('quotations.noEndDate')
              : isoDate(quotation.validUntil)
          }
        />
        {quotation.order !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('quotations.statuses.accepted')}
            </span>
            <Link
              to="/sales-orders/$orderId"
              params={{ orderId: quotation.order.id }}
              className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            >
              {quotation.order.number === null
                ? t('quotations.acceptedOnDraft')
                : t('quotations.acceptedOn', { number: quotation.order.number })}
            </Link>
          </div>
        )}
        {quotation.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('quotations.note')} value={quotation.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={quotation.lines}
        totals={quotation}
        pricesIncludeVat={quotation.pricesIncludeVat}
      />

      {canWrite && open && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Left, away from the rest. Two clicks: a deleted quotation cannot come back. */}
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                if (confirming) remove.mutate();
                else setConfirming(true);
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
              {confirming
                ? t('quotations.confirmDelete', { number: quotation.number })
                : t('quotations.delete')}
            </Button>
            {confirming && (
              <span className="text-body-sm text-ink-2">{t('quotations.deleteWarning')}</span>
            )}
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              decline.mutate();
            }}
          >
            {t('quotations.decline')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onEdit}>
            <HugeiconsIcon icon={PencilEdit02Icon} size={17} strokeWidth={1.5} />
            {t('quotations.edit')}
          </Button>
          {canOrder && (
            <Button
              disabled={busy}
              onClick={() =>
                void navigate({
                  to: '/sales-orders/new',
                  search: { quotationId: quotation.id },
                })
              }
            >
              <HugeiconsIcon icon={ShoppingCart01Icon} size={17} strokeWidth={1.5} />
              {t('quotations.makeOrder')}
            </Button>
          )}
        </div>
      )}
      {canWrite && quotation.status === 'declined' && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              reopen.mutate();
            }}
          >
            {t('quotations.reopen')}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- **An open quotation is shown as sent, not as a form.** "Make order" must start from what the customer got. If
  the page were the form, a half-edited, unsaved price could be what the person thinks is being ordered. "Edit"
  turns the page into the form until it is saved or cancelled.
- **`DocumentNotice`** says what the state means and what to do next: an expired offer can still be accepted (the
  customer often answers late), and a declined one can be opened again. Warn for the first, neutral for the
  second, each with its icon.
- **"Make order" needs `sales.order.manage`**, not the quotation permission. It is the primary button: the next
  step in the chain. It is a link with `?quotationId=`, so the order form loads the saved quotation itself.
- **Delete is two clicks, on the left**, away from "Make order", with the warning beside it. A quotation number is
  never used again, and the warning says so.
- **`totals={quotation}`.** A quotation has `discount`, `net`, `vat` and `total`, so it is a `DocumentTotals` as
  it is; nothing is added up again on the page.
- **The accepted link** names the order's number, or says "Accepted on a draft order" while the order has none.

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { quotationQuery, settingsQuery, taxRatesQuery, unitsQuery } from '../lib/queries';

// The page only loads the data and picks the form or the view, each a lazy chunk of its own (the
// stock documents' pattern): reading a quotation needs neither the form library nor the editor.
const QuotationForm = lazy(async () => ({
  default: (await import('../components/quotation-form')).QuotationForm,
}));
const QuotationView = lazy(async () => ({
  default: (await import('../components/quotation-view')).QuotationView,
}));

// What every quotation page needs before it draws: the units, the VAT rates (a line's rate and
// its totals) and the settings (whether a new quotation's prices include VAT)
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  if (units === undefined || rates === undefined || settings === undefined) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

export function NewQuotationPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.quotation.manage');
  const today = useToday();
  const ready = useReady();
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/quotations" label={t('quotations.back')} />
        <p className="text-body-sm text-ink-3">{t('quotations.cantWrite')}</p>
      </div>
    );
  }
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <QuotationForm quotation={null} today={today} pricesIncludeVat={ready.pricesIncludeVat} />
    </Suspense>
  );
}

export function QuotationPage() {
  const { t } = useLocale();
  const { quotationId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.quotation.manage');
  const today = useToday();
  const ready = useReady();
  // An open quotation is shown as sent; "Edit" turns the page into the form until it is saved
  const [editing, setEditing] = useState(false);
  const { data: quotation, isError } = useQuery({
    ...quotationQuery(useTenantId(), quotationId),
    enabled: quotationId !== '',
  });

  if (isError) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/quotations" label={t('quotations.back')} />
        <EmptyState
          icon={AlertCircleIcon}
          title={t('quotations.title')}
          description={t('quotations.notFound')}
        />
      </div>
    );
  }
  if (!quotation || !ready) return null;
  if (editing && canWrite && quotation.status === 'open') {
    return (
      <Suspense fallback={null}>
        <QuotationForm
          key={`${quotation.id}-${String(quotation.version)}`}
          quotation={quotation}
          today={today}
          pricesIncludeVat={quotation.pricesIncludeVat}
          onClose={() => {
            setEditing(false);
          }}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <QuotationView
        quotation={quotation}
        today={today}
        onEdit={() => {
          setEditing(true);
        }}
      />
    </Suspense>
  );
}
```

- **The route file loads the data and picks the form or the view**, each a lazy chunk (the stock documents'
  pattern). Reading a quotation needs neither the form library nor the editor.
- **`useReady()` waits for the units, the VAT rates and the settings.** The editor needs the first two for every
  line, and a new quotation takes its "prices include VAT" from the settings. Drawing the form before them would
  show lines with no unit codes and a total of ৳0.
- **`editing` is page state**, not a route. An edit belongs to this visit: after a reload the page shows the
  quotation as it is saved.
- **The form only for an open quotation** and only with the permission. A declined or accepted quotation never
  becomes a form, even if `editing` is still true from before someone else declined it.

### Sales orders: `components/sales-order-form.tsx`, `components/sales-order-view.tsx`, `routes/sales-order.tsx` (new)

```tsx
import { Delete02Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type CustomerAddress,
  type Quotation,
  routes,
  type SalesOrder,
  type SalesOrderFormValues,
  updateSalesOrderInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  FormAlert,
  DatePicker,
  FormField,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { SALES_LINE_FIELDS, savedLines } from '../lib/sales';
import { customerQuery } from '../lib/queries';
import { CustomerPicker } from './customer-picker';
import { failureOf } from './journal-parts';
import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
import { useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The order form: its own chunk (loaded by routes/sales-order.tsx), like the quotation's.

// The line editor as a chunk of its own, loaded as the form opens: it brings decimal.js with its
// money and discount boxes (cost-input.tsx says the same of the adjustment form), and inside this
// chunk it took the form over its 100 KB budget
const SalesLinesEditor = lazy(async () => ({
  default: (await import('./sales-line-editor')).SalesLinesEditor,
}));

type FormValues = SalesOrderFormValues;

function fieldNames(lineCount: number): Path<FormValues>[] {
  return [
    'customerId',
    'date',
    'deliveryDate',
    'customerReference',
    'warehouseId',
    'shippingAddressId',
    'note',
    'lines',
    ...Array.from({ length: lineCount }, (_, index) =>
      SALES_LINE_FIELDS.map((field) => rowPath('lines', index, field)),
    ).flat(),
  ];
}

// The addresses goods can go to: the shipping ones (the first is the default)
function shippingAddresses(addresses: readonly CustomerAddress[]): CustomerAddress[] {
  return addresses.filter((address) => address.kind === 'shipping');
}
```

- **The same lazy editor** as the quotation form, for the same reason.
- **`shippingAddresses()`**: only the customer's shipping addresses go in the select. The billing address is
  where the invoice goes (15c), not where a truck goes.

```tsx
// Writing a new order (from nothing, or from a quotation), or changing a draft. "Save draft" keeps
// it a draft; "Confirm order" saves and confirms in one request, all or nothing.
export function SalesOrderForm({
  order,
  quotation,
  today,
  pricesIncludeVat,
}: {
  order: SalesOrder | null;
  // The quotation a new order is made from ("Make order"); null otherwise
  quotation: Quotation | null;
  today: string;
  // The order's own copy, the quotation's (an order keeps its quotation's prices), or the
  // workspace's now
  pricesIncludeVat: boolean;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = useSalesRefresh();
  const { active } = useWarehouses();
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => {
    if (order) return savedLines(order.lines, order.customer.id);
    if (quotation) return savedLines(quotation.lines, quotation.customer.id);
    return { values: [], meta: [] };
  });
  // A draft that has a number, or comes from a quotation, keeps its customer (the API refuses a
  // change): the box is read only and says why
  const customerLocked =
    quotation !== null || (order !== null && (order.number !== null || order.quotation !== null));
  const savedCustomer = order?.customer ?? quotation?.customer ?? null;
  // A reopened draft keeps its number (15b.3)
  const keptNumber = order?.number ?? null;
  const onlyWarehouse = active?.length === 1 ? active[0]?.id : undefined;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateSalesOrderInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      date: order?.date ?? today,
      deliveryDate: order?.deliveryDate ?? '',
      customerReference: order?.customerReference ?? '',
      warehouseId: order?.warehouseId ?? onlyWarehouse ?? '',
      shippingAddressId: order?.shippingAddressId ?? '',
      note: order?.note ?? '',
      lines: start.values,
      confirm: false,
      version: order?.version ?? 1,
    },
  });
  const customerId = useWatch({ control, name: 'customerId' });
  const lineCount = useWatch({ control, name: 'lines' }).length;
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  const addresses = shippingAddresses(customer?.addresses ?? []);
  // The address the draft was saved with, if it is no longer one of the customer's shipping
  // addresses: it still shows as chosen, by the text the order kept
  const keptId = order?.shippingAddressId ?? null;
  const keptAddress =
    order !== null &&
    keptId !== null &&
    customerId === order.customer.id &&
    !addresses.some((address) => address.id === keptId)
      ? { value: keptId, label: order.shippingAddress ?? '' }
      : null;

  // A new customer: their first shipping address, or none
  const changeCustomer = async (next: string) => {
    setValue('customerId', next, { shouldValidate: errors.customerId !== undefined });
    setValue('shippingAddressId', '');
    if (next === '') return;
    const picked = await queryClient.query(customerQuery(tenantId, next));
    if (getValues('customerId') !== next) return;
    setValue('shippingAddressId', shippingAddresses(picked.addresses)[0]?.id ?? '');
  };

  const save = (confirm: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, confirm };
        const saved = order
          ? await call(routes.salesOrders.update, {
              params: { id: order.id },
              body: { ...body, version },
            })
          : await call(routes.salesOrders.create, {
              body: { ...body, quotationId: quotation?.id ?? null },
            });
        await refresh();
        toast(
          saved.status === 'confirmed'
            ? t('salesOrders.confirmed', { number: saved.number ?? '' })
            : t('salesOrders.draftSaved'),
        );
        if (!order) {
          void navigate({
            to: '/sales-orders/$orderId',
            params: { orderId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lineCount), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: SalesOrder) =>
      call(routes.salesOrders.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('salesOrders.deleted'));
      void navigate({ to: '/sales-orders' });
    },
  });

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
```

- **`pricesIncludeVat` comes from the caller**: the order's own copy, the quotation's (an order made from a
  quotation keeps its way of writing prices, 15b.3), or the workspace's setting now.
- **`customerLocked`.** A draft that has a number (it was confirmed once) or comes from a quotation keeps its
  customer (15b.3). The box is disabled, and its hint says why; a disabled box without a reason looks like a bug.
- **`onlyWarehouse`.** A company with one warehouse should not have to pick it on every order.
- **`keptAddress`.** A draft's address that is no longer a shipping address (the customer changed it since) still
  shows as chosen, with the text the order kept. Otherwise the select would show "No address", and the next save
  would drop the address without the person noticing.
- **`changeCustomer()` sets the first shipping address** once the customer's details arrive. It checks that the
  customer is still the one picked: a person who picks two customers quickly gets the second one's address. The
  details come through the query cache, so the address select's own query finds them there.
- **`save(confirm)`.** "Save draft" and "Confirm order" send the same form, with `confirm` false or true. The API
  saves and confirms in one transaction, so a refused confirm leaves nothing half saved. `quotationId` goes only
  in the create body: the contract's update schema has no such field (an order keeps its quotation).
- **The toast says what happened**: "SO-2026-27-0042 confirmed", or "Draft saved".

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <PageHeader
        title={order ? (order.number ?? t('salesOrders.draftTitle')) : t('salesOrders.newTitle')}
        description={
          quotation
            ? `${t('salesOrders.quotation')}: ${quotation.number}`
            : t('salesOrders.description')
        }
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        {keptNumber !== null && (
          <p className="text-body-sm text-ink-2">
            {t('salesOrders.numberedDraft', { number: keptNumber })}
          </p>
        )}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField
            control={control}
            name="customerId"
            label={t('salesOrders.customer')}
            hint={customerLocked ? t('salesOrders.customerLocked') : undefined}
          >
            {(field) => (
              <CustomerPicker
                {...field}
                saved={savedCustomer}
                disabled={customerLocked}
                onChange={(next) => void changeCustomer(next)}
              />
            )}
          </FormField>
          <FormField control={control} name="date" label={t('salesOrders.date')}>
            {(field) => <DatePicker {...field} />}
          </FormField>
          <FormField
            control={control}
            name="deliveryDate"
            label={t('salesOrders.deliveryDate')}
            optional
            hint={t('salesOrders.deliveryDateHint')}
          >
            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
          </FormField>
          <TextField
            label={t('salesOrders.customerReference')}
            optional
            hint={t('salesOrders.customerReferenceHint')}
            placeholder={t('salesOrders.customerReferencePlaceholder')}
            {...register('customerReference')}
            error={errors.customerReference?.message}
          />
          <SelectField
            label={t('salesOrders.warehouse')}
            hint={t('salesOrders.warehouseHint')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <SelectField
            label={t('salesOrders.shippingAddress')}
            optional
            options={[
              { value: '', label: t('salesOrders.noShippingAddress') },
              ...addresses.map((address) => ({ value: address.id, label: addressLabel(address) })),
              ...(keptAddress ? [keptAddress] : []),
            ]}
            {...register('shippingAddressId')}
            error={errors.shippingAddressId?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('salesOrders.note')}
              optional
              placeholder={t('salesOrders.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Controller
          control={control}
          name="lines"
          render={({ field }) => (
            <Suspense fallback={<Card className="min-h-24" />}>
              <SalesLinesEditor
                lines={field.value}
                onChange={field.onChange}
                getLines={() => getValues('lines')}
                initialMeta={start.meta}
                customerId={customerId}
                pricesIncludeVat={pricesIncludeVat}
                errors={errors.lines}
              />
            </Suspense>
          )}
        />

        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* A reopened draft keeps its number and cannot be deleted (it says so above) */}
          {order?.number === null && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(order);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('salesOrders.confirmDelete') : t('salesOrders.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('salesOrders.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('salesOrders.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || lineCount === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('salesOrders.confirming') : t('salesOrders.confirm')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('salesOrders.confirmHint')}</p>
      </form>
    </div>
  );
}
```

- **`numberedDraft`** replaces the Delete button on a draft that has a number. Such a draft cannot be deleted
  (`order_numbered`, 15b.2); the text says to confirm it again and cancel it, so the person is not left
  guessing.
- **`confirmHint`** under the buttons says that confirming gives the number and that nothing is held in the
  warehouse (you chose this). A salesperson must not promise the goods because the order is confirmed.

```tsx
import { DeliveryTruck01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { routes, type SalesOrder, type StockDocumentStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  PageHeader,
  toast,
} from '@omnivo/ui';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { Fact } from './adjustment-view';
import { failureOf } from './journal-parts';
import { SalesLinesTable } from './sales-lines-table';
import {
  CustomerLink,
  DeliveryStatusPill,
  OrderStatusPills,
  SalesBackLink,
  useSalesRefresh,
} from './sales-parts';
import { useIsoDate, useWarehouses, warehouseLabel } from './stock-parts';

// What the three order actions that cannot be undone are called, and what they say before they run
type Action = 'reopen' | 'close' | 'cancel';

// The deliveries list on the order sends a status as a plain string (sales-orders.ts); only the
// two a delivery has are shown as a pill
function deliveryStatus(status: string): StockDocumentStatus | null {
  return status === 'draft' || status === 'posted' ? status : null;
}

// An order that is not edited here (confirmed, delivered, closed, cancelled — or a draft for
// someone who may not write orders): its lines with what went out, its deliveries, and what can be
// done next.
export function SalesOrderView({ order, today }: { order: SalesOrder; today: string }) {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const isoDate = useIsoDate();
  const refresh = useSalesRefresh();
  const { byId } = useWarehouses();
  const can = useCan();
  const canWrite = can('sales.order.manage');
  const canDeliver = can('sales.delivery.manage');
  const [asking, setAsking] = useState<Action | null>(null);
  const number = order.number ?? '';

  const act = useMutation({
    mutationFn: (action: Action) =>
      call(routes.salesOrders[action], {
        params: { id: order.id },
        body: { version: order.version },
      }),
    onSuccess: async (saved, action) => {
      setAsking(null);
      await refresh();
      const done = { reopen: 'reopened', close: 'closed', cancel: 'cancelled' } as const;
      toast(t(`salesOrders.${done[action]}`, { number: saved.number ?? '' }));
    },
  });

  const confirmed = order.status === 'confirmed';
  // Back to draft only with no delivery at all, drafts included (the API's order_has_deliveries)
  const canReopen = confirmed && order.deliveries.length === 0;
  // Something went out: the rest is closed. Nothing went out: the order is cancelled.
  const endAction: Action = order.partlyDelivered ? 'close' : 'cancel';

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <PageHeader
        title={order.number ?? t('salesOrders.draftTitle')}
        description={order.customer.name}
        actions={<OrderStatusPills order={order} today={today} />}
      />
      {failureOf(act.error) && asking === null && (
        <FormAlert message={failureOf(act.error) ?? ''} />
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('salesOrders.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={order.customer} />
          </span>
        </div>
        <Fact label={t('salesOrders.date')} value={isoDate(order.date)} />
        <Fact
          label={t('salesOrders.deliveryDate')}
          value={order.deliveryDate === null ? '—' : isoDate(order.deliveryDate)}
        />
        {order.customerReference !== null && (
          <Fact label={t('salesOrders.customerReference')} value={order.customerReference} />
        )}
        <Fact
          label={t('salesOrders.warehouse')}
          value={warehouseLabel(byId.get(order.warehouseId))}
        />
        {order.shippingAddress !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('salesOrders.shippingAddress')}
            </span>
            {/* The address as it was saved, one part per line (label, address, phone) */}
            <span className="text-body-sm whitespace-pre-line text-ink">
              {order.shippingAddress}
            </span>
          </div>
        )}
        {order.quotation !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('salesOrders.quotation')}
            </span>
            <Link
              to="/quotations/$quotationId"
              params={{ quotationId: order.quotation.id }}
              className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {order.quotation.number}
            </Link>
          </div>
        )}
        {order.confirmedAt !== null && (
          <Fact
            label={t('salesOrders.statuses.confirmed')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('salesOrders.confirmedOn', { date: format.date(new Date(order.confirmedAt)) })}
          />
        )}
        {order.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('salesOrders.note')} value={order.note} />
          </div>
        )}
      </Card>
      <SalesLinesTable
        lines={order.lines}
        totals={order}
        pricesIncludeVat={order.pricesIncludeVat}
        delivered={order.status !== 'draft'}
      />
      {order.status !== 'draft' && (
        <Card className="overflow-hidden">
          <CardHeader
            title={t('salesOrders.deliveriesTitle')}
            subtitle={t('salesOrders.deliveriesSubtitle')}
          />
          {order.deliveries.length === 0 ? (
            <p className="px-5 pt-3 pb-5 text-body-sm text-ink-2">
              {t('salesOrders.noDeliveries')}
            </p>
          ) : (
            <ul className="mt-3 grid grid-cols-1">
              {order.deliveries.map((delivery) => {
                const status = deliveryStatus(delivery.status);
                return (
                  <li key={delivery.id} className="border-t border-line">
                    <Link
                      to="/deliveries/$deliveryId"
                      params={{ deliveryId: delivery.id }}
                      className="flex flex-wrap items-center gap-3 px-5 py-3 text-body-sm hover:bg-subtle"
                    >
                      <span className="font-mono font-medium text-brand tabular-nums">
                        {delivery.number ?? t('deliveries.statuses.draft')}
                      </span>
                      <span className="text-ink-3 tabular-nums">{isoDate(delivery.date)}</span>
                      <span className="ml-auto">
                        {status !== null && <DeliveryStatusPill status={status} />}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {confirmed && (canWrite || canDeliver) && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canWrite && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setAsking(endAction);
                }}
              >
                {t(`salesOrders.${endAction}`)}
              </Button>
            </div>
          )}
          {canWrite && canReopen && (
            <Button
              variant="secondary"
              onClick={() => {
                setAsking('reopen');
              }}
            >
              {t('salesOrders.reopen')}
            </Button>
          )}
          {canDeliver && (
            <Button
              onClick={() =>
                void navigate({ to: '/deliveries/new', search: { orderId: order.id } })
              }
            >
              <HugeiconsIcon icon={DeliveryTruck01Icon} size={17} strokeWidth={1.5} />
              {t('salesOrders.deliver')}
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        {asking !== null && (
          <DialogContent
            title={t(`salesOrders.${asking}Title`, { number })}
            description={t(`salesOrders.${asking}Body`)}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="secondary">
                    {asking === 'reopen' ? t('common.cancel') : t('salesOrders.keepOrder')}
                  </Button>
                </DialogClose>
                <Button
                  disabled={act.isPending}
                  onClick={() => {
                    act.mutate(asking);
                  }}
                >
                  {t(`salesOrders.${asking}`)}
                </Button>
              </>
            }
          >
            {failureOf(act.error) && <FormAlert message={failureOf(act.error) ?? ''} />}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
```

- **`act` is one mutation for three actions.** `routes.salesOrders[action]` picks the route; the three have the
  same shape (a version in, an order out), so TypeScript accepts the union without a cast. The toast's key comes
  from a `const` map, so a fourth action would be a type error until it has its words.
- **Each action asks first.** Close and cancel cannot be undone, and "Back to draft" changes a document a customer
  may already have. The dialog's title, body and buttons come from the keys of 15b.5; "Keep the order" is the
  "No" of close and cancel, because "Cancel" next to "Cancel order" would mean two opposite things.
- **Which actions show.** "Back to draft" only with no delivery at all, drafts included (the API's
  `order_has_deliveries`). "Close order" when something went out, "Cancel order" when nothing did; the page
  never offers the action the API would refuse. "New delivery" needs `sales.delivery.manage`, the store
  keeper's permission, so it shows even for someone who may not change orders.
- **`deliveryStatus()`** narrows the deliveries' plain `string` status (the contract keeps it a string, 15b.1) to
  the two the pill knows. An unknown status from a newer server shows no pill instead of breaking the page.
- **Confirmed and posted times are moments**, not dates: `format.date(new Date(…))` shows them in the reader's
  time zone. `slice(0, 10)` of the UTC text would show the day before for an order confirmed between midnight
  and 6 am in Dhaka (UTC+6).
- **The shipping address keeps its line breaks** (`whitespace-pre-line`): label, address and phone, as the
  challan prints them.

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import {
  quotationQuery,
  salesOrderQuery,
  settingsQuery,
  taxRatesQuery,
  unitsQuery,
} from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own
const SalesOrderForm = lazy(async () => ({
  default: (await import('../components/sales-order-form')).SalesOrderForm,
}));
const SalesOrderView = lazy(async () => ({
  default: (await import('../components/sales-order-view')).SalesOrderView,
}));

// The units, the VAT rates, the warehouses and the settings: the form and the view need them all
function useReady(): { pricesIncludeVat: boolean } | null {
  const tenantId = useTenantId();
  const units = useQuery(unitsQuery(tenantId)).data;
  const rates = useQuery(taxRatesQuery(tenantId)).data;
  const settings = useQuery(settingsQuery(tenantId)).data;
  const { active } = useWarehouses();
  if (units === undefined || rates === undefined || settings === undefined || !active) return null;
  return { pricesIncludeVat: settings.pricesIncludeVat };
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('salesOrders.title')} description={message} />
    </div>
  );
}

// A new order; "Make order" on a quotation comes here with ?quotationId=
export function NewSalesOrderPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.order.manage');
  const today = useToday();
  const ready = useReady();
  const { quotationId = '' } = useSearch({ strict: false });
  const { data: quotation, isError } = useQuery({
    ...quotationQuery(useTenantId(), quotationId),
    enabled: quotationId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/sales-orders" label={t('salesOrders.back')} />
        <p className="text-body-sm text-ink-3">{t('salesOrders.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('quotations.notFound')} />;
  if (!ready || (quotationId !== '' && !quotation)) return null;
  return (
    <Suspense fallback={null}>
      <SalesOrderForm
        order={null}
        quotation={quotation ?? null}
        today={today}
        // An order keeps its quotation's way of writing prices (decision of 15b.3)
        pricesIncludeVat={quotation?.pricesIncludeVat ?? ready.pricesIncludeVat}
      />
    </Suspense>
  );
}

export function SalesOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.order.manage');
  const today = useToday();
  const ready = useReady();
  const { data: order, isError } = useQuery({
    ...salesOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });

  if (isError) return <CantFind message={t('salesOrders.notFound')} />;
  if (!order || !ready) return null;
  if (order.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <SalesOrderForm
          key={`${order.id}-${String(order.version)}`}
          order={order}
          quotation={null}
          today={today}
          pricesIncludeVat={order.pricesIncludeVat}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <SalesOrderView order={order} today={today} />
    </Suspense>
  );
}
```

- **`?quotationId=` is read with `useSearch`.** The router's `validateSearch` (below) already dropped anything
  that is not a UUID, so the page asks the API only for a real id.
- **The form waits for the quotation** when there is one. Drawing an empty order and filling it a moment later
  would let the person start typing into a form that is about to be replaced.
- **A draft is a form only for someone who may write orders.** Everyone else sees the draft read only, without
  the "Delivered" column (nothing can be delivered yet).

### Deliveries: `components/delivery-form.tsx`, `components/delivery-view.tsx`, `routes/delivery.tsx` (new)

```tsx
import {
  Calendar03Icon,
  Delete02Icon,
  PlusSignIcon,
  TaskDone01Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type Delivery,
  type DeliveryFormValues,
  plainQuantity,
  routes,
  type SalesOrder,
  type StockItem,
  updateDeliveryInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  Dialog,
  FormAlert,
  FormField,
  Input,
  PageHeader,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';
import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import { customerQuery, openOrdersQuery, salesOrderQuery, unitsQuery } from '../lib/queries';
import { baseByOrderLine, fillFromOrder, leftToDeliver } from '../lib/sales';
import { basePreview, fefoSplit, firstMessage, serialPath } from '../lib/stock';
import { ItemPicker } from './item-picker';
import { failureOf, LineField } from './journal-parts';
import { addressLabel, SalesBackLink, useSalesRefresh } from './sales-parts';
import { SerialNumbersInput } from './serial-numbers-input';
import { type LineItem, StockLineRow, StockLinesHeader, toLineItem } from './stock-line-row';
import { useIsoDate, useQuantity, useTenantId, useWarehouses, warehouseLabel } from './stock-parts';

// The delivery form: its own chunk (loaded by routes/delivery.tsx), like the stock documents'
// forms. A delivery is a stock document with a customer: its lines are the stock lines of step 13
// (batch, FEFO, serial numbers), and a line made from an order also names its order line.

// The customer and date boxes as chunks of their own, loaded as the form opens: both bring the
// popover (date-input.tsx says why that matters), and with it inside, this chunk stood at its
// 100 KB budget. customer-picker.tsx is already a module of its own.
const CustomerPicker = lazy(async () => ({
  default: (await import('./customer-picker')).CustomerPicker,
}));
const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));

type FormValues = DeliveryFormValues;
type LineValues = FormValues['lines'][number];

function emptyLine(item: LineItem, orderLineId = ''): LineValues {
  return {
    variantId: item.variantId,
    unitId: item.baseUnitId,
    quantity: '',
    batchId: '',
    serialNumbers: [],
    orderLineId,
  };
}

function fieldNames(lines: readonly LineValues[]): Path<FormValues>[] {
  return [
    'customerId',
    'orderId',
    'date',
    'warehouseId',
    'shippingAddressId',
    'vehicle',
    'note',
    'lines',
    ...lines.flatMap((line, index) => [
      rowPath('lines', index, 'variantId'),
      rowPath('lines', index, 'unitId'),
      rowPath('lines', index, 'quantity'),
      rowPath('lines', index, 'batchId'),
      rowPath('lines', index, 'serialNumbers'),
      rowPath('lines', index, 'orderLineId'),
      ...line.serialNumbers.map((_, serial) => serialPath(index, serial)),
    ]),
  ];
}

// The lines of an order as delivery lines: what is still left, and the items they need
function linesFrom(
  order: SalesOrder,
  onForm: ReadonlyMap<string, string>,
): { lines: LineValues[]; items: LineItem[] } {
  const fill = fillFromOrder(order.lines, onForm);
  return {
    lines: fill.map((line) => ({
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      batchId: '',
      serialNumbers: [],
      orderLineId: line.orderLineId,
    })),
    items: order.lines.map(toLineItem),
  };
}

// The first shipping address of a customer, the default a delivery goes to
function firstShipping(addresses: readonly { id: string; kind: string }[]): string {
  return addresses.find((address) => address.kind === 'shipping')?.id ?? '';
}
```

- **The customer box and the date picker are lazy.** Both bring the popover. With them inside, this chunk stood at
  99.4 KB of its 100 KB budget, and the next contract change (15c) would have pushed it over. `customer-picker.tsx`
  is already a module of its own, so `lazy()` can load it directly; the date picker comes through
  `date-input.tsx` (15a). The fallbacks are the same boxes, empty and disabled.
- **A delivery uses `useFieldArray`.** Unlike the sales lines, these lines belong to one form only, so the stock
  forms' way works without a cast.
- **`emptyLine(item, orderLineId)`.** A line split by "Split by first expiry" keeps its order line: one order line
  may go out from two batches.
- **`linesFrom(order, onForm)`** turns what is left on an order into delivery lines, and returns the items those
  lines need (name, packs, tracking). A sales order line carries the same fields as a stock line, which is why
  `toLineItem()` now takes a `LineItem` (below).
- **`firstShipping()`** is the customer's first shipping address: the default the customer's own page sets
  (15a), and the order form's default too.

```tsx
// Writing a new delivery (from an order, or for goods without one), or changing a draft. "Save
// draft" keeps it a draft; "Post delivery" saves and posts in one request: the stock goes out and
// its cost is booked, all or nothing.
export function DeliveryForm({
  delivery,
  order,
  today,
}: {
  delivery: Delivery | null;
  // The order a new delivery starts from ("New delivery" on the order's page); null otherwise
  order: SalesOrder | null;
  today: string;
}) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const refresh = useSalesRefresh();
  const quantityText = useQuantity();
  const isoDate = useIsoDate();
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [start] = useState(() => (order ? linesFrom(order, new Map()) : null));
  const [items, setItems] = useState<ReadonlyMap<string, LineItem>>(
    () =>
      new Map(
        [...(delivery?.lines ?? []), ...(start?.items ?? [])].map((line) => [
          line.variantId,
          toLineItem(line),
        ]),
      ),
  );
  const savedCustomer = delivery?.customer ?? order?.customer ?? null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(updateDeliveryInputSchema, { error: contractErrorMap }),
    defaultValues: {
      customerId: savedCustomer?.id ?? '',
      orderId: delivery?.order?.id ?? order?.id ?? '',
      date: delivery?.date ?? today,
      warehouseId: delivery?.warehouseId ?? order?.warehouseId ?? '',
      shippingAddressId: delivery?.shippingAddressId ?? order?.shippingAddressId ?? '',
      vehicle: delivery?.vehicle ?? '',
      note: delivery?.note ?? '',
      lines:
        delivery?.lines.map((line) => ({
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: plainQuantity(line.quantity),
          batchId: line.batchId ?? '',
          serialNumbers: line.serialNumbers,
          orderLineId: line.orderLineId ?? '',
        })) ??
        start?.lines ??
        [],
      post: false,
      version: delivery?.version ?? 1,
    },
  });
  const { fields, append, remove, insert, replace } = useFieldArray({ control, name: 'lines' });
  const lines = useWatch({ control, name: 'lines' });
  const customerId = useWatch({ control, name: 'customerId' });
  const orderId = useWatch({ control, name: 'orderId' }) ?? '';
  const warehouseId = useWatch({ control, name: 'warehouseId' });
  const { active } = useWarehouses();
  const units = useQuery(unitsQuery(tenantId)).data ?? [];
  const customer = useQuery({
    ...customerQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  const openOrders = useQuery({
    ...openOrdersQuery(tenantId, customerId),
    enabled: customerId !== '',
  }).data;
  // The chosen order with its lines: what each line was ordered and has left
  const chosenOrder = useQuery({
    ...salesOrderQuery(tenantId, orderId),
    enabled: orderId !== '',
  }).data;
  const orderLines = new Map(chosenOrder?.lines.map((line) => [line.id, line]));

  // The order box: the customer's confirmed orders, and the draft's own order if it is no longer
  // confirmed (posting then says why: order_not_confirmed)
  const savedOrder = delivery?.order ?? null;
  const orderOptions = [
    { value: '', label: t('deliveries.noOrder') },
    ...(openOrders ?? []).map((open) => ({
      value: open.id,
      label: [open.number ?? '', isoDate(open.date), open.customerReference]
        .filter((part) => part !== null && part !== '')
        .join(' · '),
    })),
    ...(savedOrder !== null &&
    customerId === delivery?.customer.id &&
    !(openOrders ?? []).some((open) => open.id === savedOrder.id)
      ? [{ value: savedOrder.id, label: savedOrder.number ?? t('salesOrders.statuses.draft') }]
      : []),
  ];
  const addresses = (customer?.addresses ?? []).filter((address) => address.kind === 'shipping');
  // The draft's address, if it is no longer one of the customer's shipping addresses
  const keptId = delivery?.shippingAddressId ?? null;
  const keptAddress =
    delivery !== null &&
    keptId !== null &&
    customerId === delivery.customer.id &&
    !addresses.some((address) => address.id === keptId)
      ? { value: keptId, label: delivery.shippingAddress ?? '' }
      : null;

  // The base quantity each line holds, for "what is left" (null while a quantity is being typed)
  const baseOf = (line: LineValues): string | null => {
    const item = items.get(line.variantId);
    if (!item) return null;
    return line.unitId === item.baseUnitId
      ? line.quantity.trim() === ''
        ? null
        : line.quantity.trim()
      : basePreview(item, line.unitId, line.quantity, units);
  };

  const addItems = (next: readonly LineItem[]) => {
    setItems((before) => {
      const map = new Map(before);
      for (const item of next) map.set(item.variantId, toLineItem(item));
      return map;
    });
  };

  // Another customer: the order (theirs) and its lines go, and the address is the new customer's
  const changeCustomer = async (next: string) => {
    setValue('customerId', next, { shouldValidate: errors.customerId !== undefined });
    if (getValues('orderId') !== '') {
      setValue('orderId', '');
      replace([]);
    }
    setValue('shippingAddressId', '');
    if (next === '') return;
    const picked = await queryClient.query(customerQuery(tenantId, next));
    if (getValues('customerId') === next) {
      setValue('shippingAddressId', firstShipping(picked.addresses));
    }
  };

  // Another order: its warehouse, its address and what it has left replace what was there. Lines
  // of the old order, or without an order, cannot stay (the contract's delivery rules).
  const changeOrder = async (next: string) => {
    setValue('orderId', next);
    replace([]);
    if (next === '') return;
    const picked = await queryClient.query(salesOrderQuery(tenantId, next));
    if (getValues('orderId') !== next) return;
    setValue('warehouseId', picked.warehouseId);
    setValue('shippingAddressId', picked.shippingAddressId ?? '');
    const filled = linesFrom(picked, new Map());
    addItems(filled.items);
    replace(filled.lines);
  };

  // "Add what is left on the order": only what the form does not hold yet
  const fillRest = () => {
    if (!chosenOrder) return;
    const onForm = baseByOrderLine(
      getValues('lines').map((line) => ({
        orderLineId: line.orderLineId ?? '',
        base: baseOf(line),
      })),
    );
    const filled = linesFrom(chosenOrder, onForm);
    if (filled.lines.length === 0) {
      toast(t('deliveries.nothingLeft'));
      return;
    }
    addItems(filled.items);
    append(filled.lines);
  };
```

- **The defaults come from the draft, or from the order** ("New delivery" on the order's page): its customer,
  warehouse, address and what is left.
- **`orderOptions`** are the customer's confirmed orders, by number, date and the customer's reference. A draft
  whose order is no longer confirmed (closed since) still shows that order, so the box does not silently
  switch to "No order"; posting then says `order_not_confirmed`.
- **`baseOf()`** is a line's quantity in the base unit, the way the API counts it. It is `null` while the box
  holds no quantity yet.
- **`changeCustomer()` drops the order and its lines.** The order belongs to the old customer (the API's
  `delivery_order_invalid`). Lines without an order stay: goods the new customer also collects.
- **`changeOrder()` replaces everything that came from the old order.** The contract does not allow a line with
  an order line on a delivery without an order, or the other way round, so mixed lines cannot stay. The new
  order's warehouse and address become the delivery's, but both can still be changed: a delivery may go from
  another warehouse (15b.1).
- **The order is read through the query cache** (`queryClient.query`), so the "Ordered / left" notes find it there
  at once. The check after the wait ignores an answer for an order the person has already changed again.
- **`fillRest()`** adds only what the form does not hold yet, and says "Nothing is left to deliver on this
  order." instead of doing nothing.

```tsx
  const save = (post: boolean) =>
    handleSubmit(async ({ version, ...values }) => {
      try {
        const body = { ...values, post };
        const saved = delivery
          ? await call(routes.deliveries.update, {
              params: { id: delivery.id },
              body: { ...body, version },
            })
          : await call(routes.deliveries.create, { body });
        await refresh();
        toast(
          saved.status === 'posted'
            ? t('deliveries.posted', { number: saved.number ?? '' })
            : t('deliveries.draftSaved'),
        );
        if (!delivery) {
          void navigate({
            to: '/deliveries/$deliveryId',
            params: { deliveryId: saved.id },
            replace: true,
          });
        }
      } catch (error) {
        applyApiError(error, fieldNames(lines), setError);
      }
    });

  const removeDraft = useMutation({
    mutationFn: (draft: Delivery) =>
      call(routes.deliveries.remove, {
        params: { id: draft.id },
        query: { version: draft.version },
      }),
    onSuccess: async () => {
      await refresh();
      toast(t('deliveries.deleted'));
      void navigate({ to: '/deliveries' });
    },
  });

  // FEFO, as in the stock forms. The split lines keep the order line: one order line may be
  // delivered from two batches.
  const split = (index: number, batches: readonly { batchId: string; quantity: string }[]) => {
    const line = getValues(rowPath('lines', index, 'variantId'));
    const item = items.get(line);
    const now = getValues('lines')[index];
    if (!item || !now) return;
    const wanted = baseOf(now);
    if (wanted === null) return;
    const { picks, missing } = fefoSplit(batches, wanted);
    if (picks.length === 0) return;
    remove(index);
    insert(
      index,
      picks.map((pick) => ({
        ...emptyLine(item, now.orderLineId ?? ''),
        quantity: pick.quantity,
        batchId: pick.batchId,
      })),
    );
    if (missing !== '0.0000')
      toast(t('stockLines.fefoShort', { quantity: plainQuantity(missing) }));
  };

  const failure = errors.root?.server?.message ?? failureOf(removeDraft.error);
  const linesError = errors.lines?.root?.message ?? errors.lines?.message;
```

- **`save(post)`** is the stock documents' save: "Save draft" or "Post delivery" in one request, all or nothing.
  The API checks the order again under a lock when it posts (15b.3), so two store keepers posting against the
  same order at once cannot deliver more than was ordered.
- **`split()` is the stock forms' FEFO**, with one difference: each new line keeps the order line of the line it
  came from.

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <PageHeader
        title={delivery ? t('deliveries.draftTitle') : t('deliveries.newTitle')}
        description={t('deliveries.description')}
      />
      <form
        noValidate
        onSubmit={(event) => void save(false)(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <FormField control={control} name="customerId" label={t('deliveries.customer')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={UserIcon} disabled />}>
                <CustomerPicker
                  {...field}
                  saved={savedCustomer}
                  onChange={(next) => void changeCustomer(next)}
                />
              </Suspense>
            )}
          </FormField>
          <Controller
            control={control}
            name="orderId"
            render={({ field, fieldState }) => (
              <SelectField
                label={t('deliveries.order')}
                hint={t('deliveries.orderHint')}
                options={orderOptions}
                name={field.name}
                ref={field.ref}
                value={field.value ?? ''}
                disabled={customerId === ''}
                onChange={(event) => void changeOrder(event.target.value)}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
              />
            )}
          />
          <FormField control={control} name="date" label={t('deliveries.date')}>
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <SelectField
            label={t('deliveries.warehouse')}
            options={[
              { value: '', label: t('stockLines.pickWarehouse') },
              ...(active ?? []).map((place) => ({ value: place.id, label: warehouseLabel(place) })),
            ]}
            {...register('warehouseId')}
            error={errors.warehouseId?.message}
          />
          <SelectField
            label={t('deliveries.shippingAddress')}
            optional
            options={[
              { value: '', label: t('deliveries.noShippingAddress') },
              ...addresses.map((address) => ({ value: address.id, label: addressLabel(address) })),
              ...(keptAddress ? [keptAddress] : []),
            ]}
            {...register('shippingAddressId')}
            error={errors.shippingAddressId?.message}
          />
          <TextField
            label={t('deliveries.vehicle')}
            optional
            placeholder={t('deliveries.vehiclePlaceholder')}
            {...register('vehicle')}
            error={errors.vehicle?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('deliveries.note')}
              optional
              placeholder={t('deliveries.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        <Card
          className="@container grid grid-cols-1 overflow-hidden"
          aria-label={t('stockLines.items')}
        >
          {fields.length === 0 ? (
            <p className="px-5 py-6 text-body-sm text-ink-2">{t('stockLines.noLines')}</p>
          ) : (
            <StockLinesHeader />
          )}
          {fields.map((field, index) => {
            const item = items.get(field.variantId);
            if (!item) return null;
            const lineErrors = errors.lines?.[index];
            const serials = rowPath('lines', index, 'serialNumbers');
            const orderLine = orderLines.get(lines[index]?.orderLineId ?? '');
            return (
              <StockLineRow
                key={field.id}
                index={index}
                item={item}
                mode="out"
                warehouseId={warehouseId}
                unitId={lines[index]?.unitId ?? item.baseUnitId}
                quantity={lines[index]?.quantity ?? ''}
                fields={{
                  unitId: register(rowPath('lines', index, 'unitId')),
                  quantity: register(rowPath('lines', index, 'quantity')),
                  batchId: register(rowPath('lines', index, 'batchId')),
                }}
                note={
                  orderLine && (
                    <span className="text-caption text-ink-3 tabular-nums">
                      {t('deliveries.ordered', {
                        quantity: quantityText(orderLine.quantity, orderLine.unitId),
                      })}{' '}
                      ·{' '}
                      {t('deliveries.leftOnOrder', {
                        quantity: quantityText(leftToDeliver(orderLine), orderLine.baseUnitId),
                      })}
                    </span>
                  )
                }
                serials={
                  <Controller
                    control={control}
                    name={serials}
                    render={({ field: serialField }) => {
                      const error = firstMessage(lineErrors?.serialNumbers);
                      return (
                        <LineField id={serials} label={t('stockLines.serials')} error={error}>
                          <SerialNumbersInput
                            id={serials}
                            name={serialField.name}
                            ref={serialField.ref}
                            value={serialField.value}
                            onChange={serialField.onChange}
                            onBlur={serialField.onBlur}
                            invalid={error !== undefined}
                          />
                          <span className="text-caption text-ink-3">
                            {t('stockLines.serialsHint')}
                          </span>
                        </LineField>
                      );
                    }}
                  />
                }
                errors={{
                  unitId: lineErrors?.unitId?.message,
                  // The order line's own problems (not on the order, over what is left) show
                  // under the quantity, the box the person changes to fix them
                  quantity: lineErrors?.quantity?.message ?? lineErrors?.orderLineId?.message,
                  batchId: lineErrors?.batchId?.message,
                }}
                onRemove={() => {
                  remove(index);
                }}
                onSplit={(batches) => {
                  split(index, batches);
                }}
              />
            );
          })}
          {linesError && (
            <div className="border-t border-line px-5 py-3">
              <FormAlert message={linesError} />
            </div>
          )}
          <div className="border-t border-line px-5 py-3">
            {orderId === '' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={warehouseId === ''}
                onClick={() => {
                  setPicking(true);
                }}
              >
                <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
                {t('stockLines.addItems')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled={!chosenOrder} onClick={fillRest}>
                <HugeiconsIcon icon={TaskDone01Icon} size={16} strokeWidth={1.5} />
                {t('deliveries.fillFromOrder')}
              </Button>
            )}
            {orderId === '' && warehouseId === '' && (
              <p className="mt-2 text-label text-ink-3">{t('stockLines.pickWarehouse')}</p>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {delivery && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={removeDraft.isPending}
                onClick={() => {
                  if (confirming) removeDraft.mutate(delivery);
                  else setConfirming(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} size={17} strokeWidth={1.5} />
                {confirming ? t('deliveries.confirmDelete') : t('deliveries.deleteDraft')}
              </Button>
              {confirming && (
                <span className="text-body-sm text-ink-2">{t('deliveries.deleteWarning')}</span>
              )}
            </div>
          )}
          <Button type="submit" variant="secondary" disabled={isSubmitting}>
            {t('deliveries.saveDraft')}
          </Button>
          <Button disabled={isSubmitting || fields.length === 0} onClick={() => void save(true)()}>
            {isSubmitting ? t('deliveries.posting') : t('deliveries.post')}
          </Button>
        </div>
        <p className="text-right text-label text-ink-3">{t('deliveries.postHint')}</p>
      </form>

      <Dialog open={picking} onOpenChange={setPicking}>
        {picking && (
          <ItemPicker
            warehouseId={warehouseId}
            // An archived product's last stock may still go out (the API's rule, 15b.3)
            allowArchived
            onAdd={(item: StockItem) => {
              addItems([item]);
              append(emptyLine(item));
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
```

- **The order box is a controlled select** (`Controller`, not `register`): picking an order replaces the lines in
  the same change, which a registered select cannot wait for. It is disabled until a customer is chosen, because
  the options are that customer's orders.
- **"Ordered 3 case · 24 pcs left on the order"** under the item, through `StockLineRow`'s new `note` slot. The
  "left" is the order's own count of posted deliveries; the store keeper sees it while typing the quantity.
- **An order line's errors show under the quantity.** `delivery_over_order` arrives on `lines.N.quantity`; the
  contract's `delivery_order_line_required` and `_invalid` arrive on `lines.N.orderLineId`, which has no box of
  its own. The quantity is the box the person changes, or the line they remove.
- **"Add items" or "Add what is left on the order".** Without an order, the stock search adds any goods, archived
  ones too: the API lets an archived product's last stock go out (15b.3), as the transfer form does. With an
  order, only the order's lines can be on the delivery (the contract's rule), so the button fills from the order
  instead.
- **`postHint`** says what posting does to the books before the first post: the stock goes out and its cost is
  booked.

```tsx
import type { Delivery } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Card, PageHeader } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';

import { Fact } from './adjustment-view';
import { EntryLinks } from './entry-links';
import { CustomerLink, DeliveryStatusPill, SalesBackLink } from './sales-parts';
import { StockLinesTable } from './stock-lines-table';
import { useIsoDate, useWarehouses, warehouseLabel } from './stock-parts';

// A posted delivery (or a draft for someone who may not write deliveries), read only. A posted one
// never changes: goods that come back are a return (15d).
export function DeliveryView({ delivery }: { delivery: Delivery }) {
  const { t, format } = useLocale();
  const isoDate = useIsoDate();
  const { byId } = useWarehouses();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <PageHeader
        title={delivery.number ?? t('deliveries.draftTitle')}
        description={delivery.customer.name}
        actions={<DeliveryStatusPill status={delivery.status} />}
      />
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('deliveries.customer')}</span>
          <span className="text-body-sm">
            <CustomerLink customer={delivery.customer} />
          </span>
        </div>
        <div className="grid min-w-0 gap-0.5">
          <span className="text-caption font-medium text-ink-3">{t('deliveries.order')}</span>
          {delivery.order === null ? (
            <span className="text-body-sm text-ink-3">{t('deliveries.noOrder')}</span>
          ) : (
            <Link
              to="/sales-orders/$orderId"
              params={{ orderId: delivery.order.id }}
              className="font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline"
            >
              {delivery.order.number ?? t('salesOrders.statuses.draft')}
            </Link>
          )}
        </div>
        <Fact label={t('deliveries.date')} value={isoDate(delivery.date)} />
        <Fact
          label={t('deliveries.warehouse')}
          value={warehouseLabel(byId.get(delivery.warehouseId))}
        />
        {delivery.shippingAddress !== null && (
          <div className="grid min-w-0 gap-0.5">
            <span className="text-caption font-medium text-ink-3">
              {t('deliveries.shippingAddress')}
            </span>
            <span className="text-body-sm whitespace-pre-line text-ink">
              {delivery.shippingAddress}
            </span>
          </div>
        )}
        {delivery.vehicle !== null && (
          <Fact label={t('deliveries.vehicle')} value={delivery.vehicle} />
        )}
        {delivery.postedAt !== null && (
          <Fact
            label={t('deliveries.statuses.posted')}
            // A moment, not a date: shown in the reader's own time zone
            value={t('deliveries.postedOn', { date: format.date(new Date(delivery.postedAt)) })}
          />
        )}
        {delivery.status === 'posted' && (
          <EntryLinks
            label={t('deliveries.entry')}
            entries={delivery.entry ? [delivery.entry] : []}
            none={t('deliveries.noEntry')}
          />
        )}
        {delivery.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('deliveries.note')} value={delivery.note} />
          </div>
        )}
      </Card>
      <StockLinesTable lines={delivery.lines} />
    </div>
  );
}
```

- **`StockLinesTable`**, the stock documents' table, now also takes delivery lines (below). The value column shows
  the cost of goods sold for someone with `inventory.stock.value`, and is left out for everyone else.
- **`EntryLinks`** links the cost of goods sold entry for someone who reads the journal, and shows the plain number
  for everyone else (step 14). A delivery whose goods cost nothing in the books has no entry, and says so.

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';

import { SalesBackLink } from '../components/sales-parts';
import { useTenantId, useToday, useWarehouses } from '../components/stock-parts';
import { useCan } from '../lib/permissions';
import { deliveryQuery, salesOrderQuery, unitsQuery } from '../lib/queries';

// The page loads the data and picks the form or the view, each a lazy chunk of its own (the stock
// documents' pattern)
const DeliveryForm = lazy(async () => ({
  default: (await import('../components/delivery-form')).DeliveryForm,
}));
const DeliveryView = lazy(async () => ({
  default: (await import('../components/delivery-view')).DeliveryView,
}));

function useReady(): boolean {
  const units = useQuery(unitsQuery(useTenantId())).data;
  const { active } = useWarehouses();
  return units !== undefined && active !== undefined;
}

function CantFind({ message }: { message: string }) {
  const { t } = useLocale();
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
      <EmptyState icon={AlertCircleIcon} title={t('deliveries.title')} description={message} />
    </div>
  );
}

// A new delivery; "New delivery" on an order comes here with ?orderId=
export function NewDeliveryPage() {
  const { t } = useLocale();
  const canWrite = useCan()('sales.delivery.manage');
  const today = useToday();
  const ready = useReady();
  const { orderId = '' } = useSearch({ strict: false });
  const { data: order, isError } = useQuery({
    ...salesOrderQuery(useTenantId(), orderId),
    enabled: orderId !== '',
  });
  if (!canWrite) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <SalesBackLink to="/deliveries" label={t('deliveries.back')} />
        <p className="text-body-sm text-ink-3">{t('deliveries.cantWrite')}</p>
      </div>
    );
  }
  if (isError) return <CantFind message={t('salesOrders.notFound')} />;
  if (!ready || (orderId !== '' && !order)) return null;
  return (
    <Suspense fallback={null}>
      <DeliveryForm delivery={null} order={order ?? null} today={today} />
    </Suspense>
  );
}

export function DeliveryPage() {
  const { t } = useLocale();
  const { deliveryId = '' } = useParams({ strict: false });
  const canWrite = useCan()('sales.delivery.manage');
  const today = useToday();
  const ready = useReady();
  const { data: delivery, isError } = useQuery({
    ...deliveryQuery(useTenantId(), deliveryId),
    enabled: deliveryId !== '',
  });

  if (isError) return <CantFind message={t('deliveries.notFound')} />;
  if (!delivery || !ready) return null;
  if (delivery.status === 'draft' && canWrite) {
    // key: a saved draft comes back with a new version, and the form starts from it again
    return (
      <Suspense fallback={null}>
        <DeliveryForm
          key={`${delivery.id}-${String(delivery.version)}`}
          delivery={delivery}
          order={null}
          today={today}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <DeliveryView delivery={delivery} />
    </Suspense>
  );
}
```

- **The same shape as the order's route.** `?orderId=` comes from "New delivery" on the order's page; the form
  waits for that order, so its lines arrive filled.

### The stock line row and table: a note, and delivery lines

```diff
@@ -1,6 +1,6 @@
 import { Delete02Icon, Layers01Icon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
-import { plainQuantity, type StockItem, type StockLine } from '@omnivo/contracts';
+import { plainQuantity, type StockItem } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { cn, IconButton, Input, Select } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
@@ -28,7 +28,9 @@ export type LineItem = Pick<
   | 'units'
 >;
 
-export function toLineItem(source: StockItem | StockLine): LineItem {
+// LineItem in, not StockItem | StockLine: a sales order's line (step 15b) carries the same fields
+// and fills a delivery's lines
+export function toLineItem(source: LineItem): LineItem {
   return {
     variantId: source.variantId,
     productId: source.productId,
@@ -94,6 +96,7 @@ export function StockLineRow({
   dates,
   serials,
   cost,
+  note,
   errors,
   onRemove,
   onSplit,
@@ -119,6 +122,8 @@ export function StockLineRow({
   // Step 14: the unit cost box of a line that brings stock in, already in its LineField. Given =
   // the row has the cost column (the header must say costed too).
   cost?: ReactNode;
+  // Step 15b: a line under the item, such as what the order asked for and what it has left
+  note?: ReactNode;
   errors: LineErrors;
   onRemove: () => void;
   onSplit: (batches: readonly { batchId: string; quantity: string }[]) => void;
@@ -160,6 +165,7 @@ export function StockLineRow({
               {t('stockLines.inStock', { quantity: quantityText(here.onHand, item.baseUnitId) })}
             </span>
           )}
+          {note}
         </span>
         <span className="@3xl:hidden">{removeButton}</span>
       </div>
```

- **`toLineItem()` takes a `LineItem`.** It used to take a `StockItem` or a `StockLine`. A sales order line has the
  same fields, and a parameter of the narrow type accepts all three without a union that grows with every
  document.
- **`note`** is one more slot under the item, like `cost` and `serials` before it: the row stays free of any one
  form's types.

```diff
@@ -2,6 +2,7 @@ import { Alert02Icon } from '@hugeicons/core-free-icons';
 import {
   type AdjustmentLine,
   compareQuantity,
+  type DeliveryLine,
   subtractMoney,
   subtractQuantity,
   sumMoney,
@@ -12,24 +13,28 @@ import { Card, Pill } from '@omnivo/ui';
 
 import { useIsoDate, useQuantity, useUnitCode, useValue, VariantCell } from './stock-parts';
 
+// A line of any stock document this table shows; a delivery's (step 15b) has a value and no cost
+type DocumentLine = AdjustmentLine | TransferLine | DeliveryLine;
+
 // Step 14: what a line was worth (null without inventory.stock.value), and on an adjustment the
-// cost a person typed. Read from either kind of line.
-function valueOf(line: AdjustmentLine | TransferLine): string | null {
+// cost a person typed. Read from any kind of line.
+function valueOf(line: DocumentLine): string | null {
   return line.value;
 }
 
-function typedCostOf(line: AdjustmentLine | TransferLine): string | null {
+function typedCostOf(line: DocumentLine): string | null {
   return 'unitCost' in line ? line.unitCost : null;
 }
 
-// The lines of a posted adjustment or a sent transfer: a real <table> in a card, scrolling inside
-// its own box on a phone. What was typed (3 case), the base quantity it was (72 pcs), the batch
-// with its expiry or the serial numbers — and for a received transfer, what arrived.
+// The lines of a posted adjustment, a sent transfer or a posted delivery: a real <table> in a
+// card, scrolling inside its own box on a phone. What was typed (3 case), the base quantity it was
+// (72 pcs), the batch with its expiry or the serial numbers — and for a received transfer, what
+// arrived.
 export function StockLinesTable({
   lines,
   received = false,
 }: {
-  lines: readonly (AdjustmentLine | TransferLine)[];
+  lines: readonly DocumentLine[];
   received?: boolean;
 }) {
   const { t } = useLocale();
```

- **`DocumentLine` adds `DeliveryLine`.** A delivery line has a `value` and no `unitCost`, and `typedCostOf()`
  already returns `null` for a line without one, so nothing else changes.

### `router.tsx` and `routes/app-shell.tsx`

```diff
@@ -377,6 +377,74 @@ const priceListRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/price-list'), 'PriceListPage'),
 });
 
+// Quotations, sales orders and deliveries (step 15b). '/…/new' beats '/…/$id', like the stock
+// documents. A new order may start from a quotation, and a new delivery from an order: the id comes
+// in the search, so "Make order" and "New delivery" are plain links. A search value that is not a
+// UUID is dropped here, and the page starts empty instead of asking the API for nonsense.
+const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
+
+const quotationsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/quotations',
+  component: lazyRouteComponent(() => import('./routes/quotations'), 'QuotationsPage'),
+});
+
+const newQuotationRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/quotations/new',
+  component: lazyRouteComponent(() => import('./routes/quotation'), 'NewQuotationPage'),
+});
+
+const quotationRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/quotations/$quotationId',
+  component: lazyRouteComponent(() => import('./routes/quotation'), 'QuotationPage'),
+});
+
+const salesOrdersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/sales-orders',
+  component: lazyRouteComponent(() => import('./routes/sales-orders'), 'SalesOrdersPage'),
+});
+
+const newSalesOrderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/sales-orders/new',
+  validateSearch: (search: Record<string, unknown>): { quotationId?: string } => ({
+    ...(typeof search.quotationId === 'string' &&
+      UUID.test(search.quotationId) && { quotationId: search.quotationId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/sales-order'), 'NewSalesOrderPage'),
+});
+
+const salesOrderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/sales-orders/$orderId',
+  component: lazyRouteComponent(() => import('./routes/sales-order'), 'SalesOrderPage'),
+});
+
+const deliveriesRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/deliveries',
+  component: lazyRouteComponent(() => import('./routes/deliveries'), 'DeliveriesPage'),
+});
+
+const newDeliveryRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/deliveries/new',
+  validateSearch: (search: Record<string, unknown>): { orderId?: string } => ({
+    ...(typeof search.orderId === 'string' &&
+      UUID.test(search.orderId) && { orderId: search.orderId }),
+  }),
+  component: lazyRouteComponent(() => import('./routes/delivery'), 'NewDeliveryPage'),
+});
+
+const deliveryRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/deliveries/$deliveryId',
+  component: lazyRouteComponent(() => import('./routes/delivery'), 'DeliveryPage'),
+});
+
 const customFieldsRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/custom-fields',
@@ -462,6 +530,15 @@ const routeTree = rootRoute.addChildren([
     customerGroupsRoute,
     priceListsRoute,
     priceListRoute,
+    quotationsRoute,
+    newQuotationRoute,
+    quotationRoute,
+    salesOrdersRoute,
+    newSalesOrderRoute,
+    salesOrderRoute,
+    deliveriesRoute,
+    newDeliveryRoute,
+    deliveryRoute,
     customFieldsRoute,
     teamRoute,
     rolesRoute,
```

- **`/…/new` beats `/…/$id`.** The router ranks a fixed segment above a parameter, so "new" is never read as an
  id, as with the products and the stock documents.
- **`validateSearch` with `UUID`.** `?quotationId=` and `?orderId=` come from links, but a person can type
  anything into the address bar. A value that is not a UUID is dropped here, and the page starts empty instead
  of asking the API for an id that cannot exist. The typed result (`{ quotationId?: string }`) is what
  `navigate({ search })` checks against.

```diff
@@ -7,6 +7,7 @@ import {
   ChartIncreaseIcon,
   Coins01Icon,
   DashboardSquare01Icon,
+  DeliveryTruck01Icon,
   FileDownloadIcon,
   FileImportIcon,
   FolderTreeIcon,
@@ -16,6 +17,7 @@ import {
   LeftToRightListNumberIcon,
   Logout01Icon,
   MoneyExchange01Icon,
+  Note01Icon,
   Notebook02Icon,
   PackageIcon,
   PackageOutOfStockIcon,
@@ -23,6 +25,7 @@ import {
   RulerIcon,
   SecurityCheckIcon,
   Settings02Icon,
+  ShoppingCart01Icon,
   Store01Icon,
   TableIcon,
   Tag01Icon,
@@ -295,8 +298,19 @@ export function AppShell() {
             </NavGroup>
           )}
           {/* Sales (step 15a): everyone reads the customers and the price lists — every sales
-              document picks them. Changing them is checked on the pages and by the API. */}
+              document picks them. Changing them is checked on the pages and by the API. Step 15b:
+              the documents come first, in the order they follow each other; everyone reads them
+              too (a store keeper looks up an order before loading the truck). */}
           <NavGroup label={t('nav.sales')}>
+            <NavLink to="/quotations" icon={Note01Icon}>
+              {t('nav.quotations')}
+            </NavLink>
+            <NavLink to="/sales-orders" icon={ShoppingCart01Icon}>
+              {t('nav.salesOrders')}
+            </NavLink>
+            <NavLink to="/deliveries" icon={DeliveryTruck01Icon}>
+              {t('nav.deliveries')}
+            </NavLink>
             <NavLink to="/customers" icon={UserMultiple02Icon}>
               {t('nav.customers')}
             </NavLink>
```

- **The documents come first in the Sales group**, in the order they follow each other: quotations, orders,
  deliveries, then the customers and price lists that feed them. Everyone sees them, because reading needs no
  permission; the pages hide the buttons a person may not use.

### The stock page, the stock card and the journal

```diff
@@ -133,6 +133,21 @@ export function StockPage() {
               </span>
             ),
         }),
+        // Step 15b: what confirmed orders still have to deliver from here. Next to "On hand",
+        // not taken off it: nothing is held for an order (the hint above the table says so).
+        column.accessor('onOrder', {
+          header: t('stock.columns.onOrder'),
+          enableSorting: false,
+          meta: { align: 'end', card: 'detail' },
+          cell: ({ row }) =>
+            isZeroQuantity(row.original.onOrder) ? (
+              <span className="text-ink-3">—</span>
+            ) : (
+              <span className="tabular-nums">
+                {quantity(row.original.onOrder, row.original.baseUnitId)}
+              </span>
+            ),
+        }),
         ...(canSeeValues
           ? [
               // A list: whole taka, like every list and dashboard (CLAUDE.md → Money)
@@ -252,6 +267,9 @@ export function StockPage() {
         />
       </div>
       {isError && <p className="text-body-sm text-crit">{t('stock.loadFailed')}</p>}
+      <p className="text-caption text-ink-3">
+        {t('stock.columns.onOrder')}: {t('stock.onOrderHint')}
+      </p>
       {items && (
         <DataTable
           label={t('stock.title')}
```

- **"On order" next to "In transit", not taken off "On hand".** Nothing is held for an order (you chose this). The
  line above the table says so in words, because "On hand 120, On order 80" would otherwise be read as "40
  free".

```diff
@@ -104,11 +104,14 @@ export function documentRoute(
   | '/stock/adjustments/$adjustmentId'
   | '/stock/transfers/$transferId'
   | '/stock/revaluations/$revaluationId'
+  | '/deliveries/$deliveryId'
   | null {
   if (kind === 'adjustment') return '/stock/adjustments/$adjustmentId';
   if (kind === 'transfer_out' || kind === 'transfer_in') return '/stock/transfers/$transferId';
   // Step 14: a change of value, without a change of quantity
   if (kind === 'revaluation') return '/stock/revaluations/$revaluationId';
+  // Step 15b: goods that left for a customer, on a delivery challan
+  if (kind === 'delivery') return '/deliveries/$deliveryId';
   return null;
 }
 
```

```diff
@@ -98,7 +98,8 @@ describe('stock helpers', () => {
     expect(documentRoute('adjustment')).toBe('/stock/adjustments/$adjustmentId');
     expect(documentRoute('transfer_in')).toBe('/stock/transfers/$transferId');
     expect(documentRoute('revaluation')).toBe('/stock/revaluations/$revaluationId');
-    expect(documentRoute('sales_delivery')).toBeNull();
+    expect(documentRoute('delivery')).toBe('/deliveries/$deliveryId');
+    expect(documentRoute('sales_invoice')).toBeNull();
   });
 });
 
```

```diff
@@ -403,6 +403,8 @@ export function StockCardPage() {
                 void navigate({ to: route, params: { transferId: movement.documentId } });
               } else if (route === '/stock/revaluations/$revaluationId') {
                 void navigate({ to: route, params: { revaluationId: movement.documentId } });
+              } else if (route === '/deliveries/$deliveryId') {
+                void navigate({ to: route, params: { deliveryId: movement.documentId } });
               }
             }}
             onEndReached={loadMore}
```

- **A delivery row on the stock card opens the delivery.** `documentRoute()` maps the movement kind `delivery` to
  `/deliveries/$deliveryId`, and the card navigates with the matching parameter. Each route has its own `if`,
  because each needs its own parameter name; one shared `navigate` would need a cast.

```diff
@@ -104,7 +104,7 @@ function ReverseForm({
 }
 
 // A posted entry (read only, with Reverse), or a draft for someone who may post but not edit
-// The stock document a stock entry came from (step 14): its page, by the entry's source
+// The document a stock entry came from (step 14), or a delivery's (15b): its page, by the source
 function documentLinkOf(entry: JournalEntry) {
   const id = entry.document?.id;
   if (id === undefined) return null;
@@ -117,6 +117,10 @@ function documentLinkOf(entry: JournalEntry) {
   if (entry.source === 'stock_revaluation') {
     return { to: '/stock/revaluations/$revaluationId', params: { revaluationId: id } } as const;
   }
+  // Step 15b: the cost of goods sold of a delivery
+  if (entry.source === 'sales_delivery') {
+    return { to: '/deliveries/$deliveryId', params: { deliveryId: id } } as const;
+  }
   return null;
 }
 
```

- **The cost of goods sold entry links back to its delivery**, by its source `sales_delivery`, like the stock
  documents' entries (step 14).

### The 100 KB budget: `routes/journal.tsx` and `components/revaluation-form.tsx`

```diff
@@ -1,4 +1,9 @@
-import { Notebook02Icon, PlusSignIcon, SquareLock02Icon } from '@hugeicons/core-free-icons';
+import {
+  Calendar03Icon,
+  Notebook02Icon,
+  PlusSignIcon,
+  SquareLock02Icon,
+} from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -14,20 +19,20 @@ import {
   Button,
   DataTable,
   dataTableColumns,
-  DatePicker,
   Dialog,
   DialogClose,
   DialogContent,
   EmptyState,
   FormAlert,
   FormField,
+  Input,
   PageHeader,
   SegmentedControl,
   toast,
 } from '@omnivo/ui';
 import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
 import { useNavigate } from '@tanstack/react-router';
-import { useCallback, useMemo, useState } from 'react';
+import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
 import { useForm } from 'react-hook-form';
 
 import { JournalStatusPill, useIsoDate } from '../components/journal-parts';
@@ -37,6 +42,13 @@ import { useCan } from '../lib/permissions';
 import { journalListQuery, periodLockQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 
+// The lock date's picker, loaded when the lock dialog opens (date-input.tsx says why). With the
+// popover inside, this page went over its 100 KB budget once the sales documents of step 15b grew
+// the contracts every page shares.
+const DatePicker = lazy(async () => ({
+  default: (await import('../components/date-input')).DatePicker,
+}));
+
 const column = dataTableColumns<JournalEntrySummary>();
 const LOCK_FIELDS = periodLockInputSchema.keyof().options;
 const FILTERS = ['all', 'draft', 'posted'] as const;
@@ -102,7 +114,11 @@ function LockDateForm({ lock, onDone }: { lock: PeriodLock; onDone: () => void }
             label={t('journal.lock.field')}
             hint={t('journal.lock.hint')}
           >
-            {(field) => <DatePicker {...field} value={field.value ?? ''} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} value={field.value ?? ''} />
+              </Suspense>
+            )}
           </FormField>
           {/* Clearing the date opens every period again; it is saved like any other date */}
           <Button
```

```diff
@@ -1,4 +1,4 @@
-import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
+import { Calendar03Icon, Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
@@ -17,18 +17,18 @@ import {
   Button,
   Card,
   cn,
-  DatePicker,
   Dialog,
   FormAlert,
   FormField,
   IconButton,
+  Input,
   MoneyInput,
   PageHeader,
   TextField,
   toast,
 } from '@omnivo/ui';
 import { useNavigate } from '@tanstack/react-router';
-import { useState } from 'react';
+import { lazy, Suspense, useState } from 'react';
 import { Controller, type Path, useFieldArray, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
@@ -49,6 +49,10 @@ import {
 // item: what it has now (its stock and average cost, company-wide), the new cost per base unit, and
 // the difference that will go to the books. Posted when it is saved.
 
+// The date's picker as a chunk of its own (date-input.tsx says why): with the popover inside, this
+// chunk went over its 100 KB budget once step 15b grew the contracts every page shares
+const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
+
 type FormValues = StockRevaluationFormValues;
 
 // One template for the header and every row on a wide card: the item, its cost now, the new cost,
@@ -125,7 +129,11 @@ export function RevaluationForm({ today }: { today: string }) {
         {failure && <FormAlert message={failure} />}
         <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-x-4">
           <FormField control={control} name="date" label={t('revaluations.date')}>
-            {(field) => <DatePicker {...field} />}
+            {(field) => (
+              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
+                <DatePicker {...field} />
+              </Suspense>
+            )}
           </FormField>
           <TextField
             label={t('revaluations.note')}
```

- **Why these two pages change.** Every page that calls the API imports `routes` from the contracts, and with it
  every schema: about 20 KB gzipped, in a chunk every page shares. 15b.1 added the quotation, order and delivery
  schemas, and the journal list and the revaluation form, which stood at 99.7 KB after 15a, went to 101.4 KB.
  `pnpm test:bundle-size` fails above 100 KB.
- **The date picker becomes its own chunk**, through `date-input.tsx`, as the product form did in 15a. Neither
  page has another popover (the journal list needs one only in the lock dialog), so the popover leaves their
  chunks: both are now at 90 KB.
- **The fallback is the same box, empty and disabled**, with the calendar icon, for the moment the chunk loads.

### `routes/kitchen-sink.tsx`: the discount box

```diff
@@ -24,6 +24,7 @@ import {
   DataTable,
   dataTableColumns,
   DatePicker,
+  DiscountInput,
   EmptyState,
   FormField,
   IconButton,
@@ -193,6 +194,9 @@ const lcSchema = z.object({
   shipBy: z.string().min(1, 'Pick the latest shipment date.'),
   buyer: z.string().min(1, 'Pick the buyer who opens the LC.'),
   bank: z.string().trim(),
+  // DiscountInput (step 15b): a percent or an amount, the type beside it
+  discount: z.string(),
+  discountType: z.enum(['percent', 'amount']),
   partialShipment: z.boolean(),
 });
 
@@ -210,6 +214,9 @@ function LetterOfCreditForm() {
       shipBy: '',
       buyer: '',
       bank: '',
+      discount: '',
+      // as const: the literal, not string, so it matches the schema's enum
+      discountType: 'percent' as const,
       partialShipment: false,
     },
   });
@@ -246,6 +253,22 @@ function LetterOfCreditForm() {
         <FormField control={control} name="shipBy" label="Latest shipment date">
           {(field) => <DatePicker {...field} />}
         </FormField>
+        <Controller
+          control={control}
+          name="discountType"
+          render={({ field: typeField }) => (
+            <FormField control={control} name="discount" label="Buyer's discount" optional>
+              {(field) => (
+                <DiscountInput
+                  {...field}
+                  placeholder="0.00"
+                  discountType={typeField.value}
+                  onDiscountTypeChange={typeField.onChange}
+                />
+              )}
+            </FormField>
+          )}
+        />
         <FormField control={control} name="buyer" label="Applicant (buyer)">
           {(field) => (
             <Combobox
```

- **One `Controller` for the type, one `FormField` for the amount.** `DiscountInput` holds two values; the kitchen
  sink shows how a form wires both, the way the line editor does.
- **`'percent' as const`.** Without it the default is a `string`, and the form's type no longer matches the
  schema's `'percent' | 'amount'`. `as const` only keeps the literal; it is not a cast to another type.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/i18n build
pnpm --filter @omnivo/app exec tsc --noEmit
pnpm --filter @omnivo/app test
pnpm --filter @omnivo/app exec vite build
pnpm --filter @omnivo/app test:bundle-size
```

The type check shows one error, in `mocks/stock-data.ts` (`onOrder`); 15b.7 fixes it. Build the contracts first:
the app reads their built types, and `productType` is new.

> **What we checked in this part.** The app type-checks except for the one known mock error, and ESLint and
> Prettier are clean. The app's unit tests pass (52, 7 of them new in `sales.spec.ts`), and so do the contracts'
> `sales.spec.ts` (13) and the API's `sales-documents.int.spec.ts` (22, with the new `productType` check). The
> app builds, and every chunk is inside its budget: the first load is 188.9 KB of 200 KB, the largest lazy chunk
> 99.2 KB (the year-end page, unchanged by 15b), and the new pages 44–92 KB. The end-to-end tests of 15b.7 then
> clicked through every screen on a desktop and a phone. Nothing in this part's files needed a change; the one
> layout problem they found was in the shared segmented control (15b.7).

## 15b.7 — `apps/app`: the mock API and the end-to-end tests

`pnpm dev:mock` and the Playwright tests run the app on MSW, a fake API inside the browser (step 4). This part
teaches the mock the three sales documents and the price lookup, with the API's rules, shortened. Then three
test files click through the screens of 15b.6 on a desktop and on a phone: write a quotation at the customer's
prices, make it an order, confirm it, deliver part of it, book its cost, close the rest, and split a pharmacy
delivery over two batches.

This was the first time the 15b screens ran in a browser. They worked as built, with one exception: on a phone
the sales order list scrolled sideways, because its status filter has six options. The fix is in the shared
`SegmentedControl` (below).

Decisions made while building this part (you were not asked):

- **The mock's sales documents live in their own file**, `mocks/sales-document-data.ts`, and in a new
  `salesDocuments` field of the mock workspace. `sales-data.ts` (customers, price lists) was already 780 lines.
- **The seeds post no delivery.** A posted delivery writes a journal entry, and the journal, report and
  customer tests read the seeded books to the taka. The fixture workspaces get quotations and orders only; the
  tests post their own deliveries.
- **A save that also posts is all or nothing in the mock too.** If "Post delivery" fails, the mock removes the
  draft it just saved (or puts back the one it changed), as the API's transaction does. The mock's stock
  adjustments (step 13) do not do this; deliveries do, because the delivery form shows the problem on the same
  page and a left-over draft would be a surprise.
- **No end-to-end test of the read-only views.** The mock always signs in as the owner, who has every permission.
  The API's tests (15b.4) check the 403 answers.

### `mocks/stock-data.ts`: helpers shared, and "on order"

```diff
@@ -194,7 +194,7 @@ export function warehouse(
 
 // --- Variants -----------------------------------------------------------------------------------
 
-function findVariant(
+export function findVariant(
   data: WorkspaceData,
   variantId: string,
 ): { product: Product; variant: ProductVariant } | undefined {
@@ -205,7 +205,7 @@ function findVariant(
   return undefined;
 }
 
-function decimalsOf(data: WorkspaceData, unitId: string): number {
+export function decimalsOf(data: WorkspaceData, unitId: string): number {
   return data.catalog.units.find((unit) => unit.id === unitId)?.decimals ?? 0;
 }
 
@@ -249,6 +249,24 @@ function inTransit(stock: MockStock, variantId: string, toWarehouseId: string |
   );
 }
 
+// What confirmed orders still have to deliver from the warehouse (or from any): ordered − delivered,
+// goods lines only (step 15b, the API's sales_orders_open_idx query). Nothing is held for it.
+function onOrder(data: WorkspaceData, variantId: string, warehouseId: string | undefined): string {
+  return sumQuantity(
+    data.salesDocuments.orders
+      .filter(
+        (order) =>
+          order.status === 'confirmed' &&
+          (warehouseId === undefined || order.warehouseId === warehouseId),
+      )
+      .flatMap((order) =>
+        order.lines
+          .filter((line) => line.variantId === variantId && line.productType === 'goods')
+          .map((line) => subtractQuantity(line.baseQuantity, line.deliveredQuantity)),
+      ),
+  );
+}
+
 function isLow(
   stock: MockStock,
   balances: ReturnType<typeof balancesOf>,
@@ -266,7 +284,7 @@ function isLow(
   );
 }
 
-function refOf(product: Product, variant: ProductVariant) {
+export function refOf(product: Product, variant: ProductVariant) {
   return {
     variantId: variant.id,
     productId: product.id,
@@ -294,6 +312,7 @@ function itemOf(
     archived: product.archivedAt !== null || variant.archivedAt !== null,
     onHand: onHand(stock, balances, variant.id, warehouseId),
     inTransit: inTransit(stock, variant.id, warehouseId),
+    onOrder: onOrder(data, variant.id, warehouseId),
     low: isLow(stock, balances, variant.id, warehouseId),
     ...valueFields(stock, balances, variant.id, warehouseId),
   };
@@ -565,7 +584,7 @@ interface LineInput {
   unitCost?: string | null;
 }
 
-function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
+export function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
   const fieldErrors: Record<string, ErrorCode[]> = {};
   for (const issue of issues) (fieldErrors[issue.path] ??= []).push(issue.code);
   return new MockProblem(409, issues[0]?.code ?? 'invalid_input', fieldErrors);
@@ -573,7 +592,7 @@ function issuesError(issues: { path: string; code: ErrorCode }[]): MockProblem {
 
 // The API's line rules (stock-lines.ts), shortened: a stocked product, its unit, the decimals,
 // and what its tracking asks for. Returns the lines as the API stores them.
-function resolveLines(
+export function resolveLines(
   data: WorkspaceData,
   lines: readonly LineInput[],
   mode: 'in' | 'out',
@@ -657,7 +676,10 @@ function resolveLines(
   return resolved;
 }
 
-function assertWarehouses(data: WorkspaceData, places: { field: string; id: string }[]): void {
+export function assertWarehouses(
+  data: WorkspaceData,
+  places: { field: string; id: string }[],
+): void {
   const bad = places.filter(
     (place) => !data.stock.warehouses.some((row) => row.id === place.id && row.archivedAt === null),
   );
@@ -670,7 +692,7 @@ function assertWarehouses(data: WorkspaceData, places: { field: string; id: stri
   }
 }
 
-function assertDate(data: WorkspaceData, date: string): void {
+export function assertDate(data: WorkspaceData, date: string): void {
   if (date > todayIn(data.settings.timezone)) {
     throw new MockProblem(409, 'stock_date_future', { date: ['stock_date_future'] });
   }
@@ -710,7 +732,7 @@ interface Move {
 // The API's StockPostingService.post(), shortened: serial numbers and stock checked, the values
 // worked out (step 14), then the movements written (one per serial number for a serial product).
 // Returns each move's value.
-function postMoves(
+export function postMoves(
   data: WorkspaceData,
   posting: {
     date: string;
@@ -830,7 +852,7 @@ function postMoves(
 
 // --- The books (step 14, the API's StockBooksService) --------------------------------------------
 
-function branchOf(data: WorkspaceData, warehouseId: string): string | null {
+export function branchOf(data: WorkspaceData, warehouseId: string): string | null {
   return data.stock.warehouses.find((place) => place.id === warehouseId)?.branchId ?? null;
 }
 
```

- **Exported, not copied.** A delivery is a stock document. It checks its lines (`resolveLines`), its warehouse
  (`assertWarehouses`) and its date (`assertDate`) the way an adjustment does, and moves the stock with the same
  `postMoves()`: batch balances, serial numbers, and the value at the moving average cost (step 14). One copy of
  these rules means a fix to one fixes both.
- **`onOrder()` reads the sales orders directly.** It sums ordered − delivered over confirmed orders, goods lines
  only, from the chosen warehouse (or all). This is the API's query on `sales_orders_open_idx`. A draft, closed or
  cancelled order promises nothing, and a service line is never delivered, so neither counts.
- **No import from the sales file.** `stock-data.ts` reads `data.salesDocuments` through the `WorkspaceData` type
  only. Importing a function from `sales-document-data.ts` would make the two files import each other.

### `mocks/sales-document-data.ts` (new): the shapes and the numbers

```ts
import {
  addMoney,
  addQuantity,
  compareQuantity,
  defaultLineDescription,
  defaultNumberFormat,
  type Delivery,
  type DeliveryInput,
  documentTotals,
  type DocumentType,
  type ErrorCode,
  fitsDecimals,
  formatDocumentNumber,
  isZeroQuantity,
  type LineAmounts,
  lineAmounts,
  negateMoney,
  type PartyRef,
  periodOf,
  type PriceLookup,
  type PriceLookupInput,
  type PriceLookupItem,
  type Quotation,
  type QuotationInput,
  type SalesLine,
  type SalesLineInput,
  type SalesOrder,
  type SalesOrderInput,
  type StockLine,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  todayIn,
} from '@omnivo/contracts';

import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  assertDate,
  assertWarehouses,
  branchOf,
  decimalsOf,
  findVariant,
  issuesError,
  postMoves,
  refOf,
  resolveLines,
} from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 15b: quotations, sales orders, deliveries, and the price a new line starts with.
// The API's rules (quotations.service.ts, sales-orders.service.ts, deliveries.service.ts,
// price-lookup.service.ts) on plain arrays, shortened, so `pnpm dev:mock` and the e2e tests walk
// the same paths as the real API. The line arithmetic is contracts' lineAmounts(): the same
// function the form and the API use, so the mock's totals match theirs to the paisa.

// A quotation as stored: the order that accepted it is looked up on read
export type MockQuotation = Omit<Quotation, 'order'>;

// An order as stored, with the quotation it was made from. "Partly delivered" and the order's
// deliveries are worked out on read, like the API's subqueries, so a posted delivery shows at once.
export type MockOrder = Omit<SalesOrder, 'partlyDelivered' | 'quotation' | 'deliveries'> & {
  quotationId: string | null;
};

// A delivery as stored, with its order's id: the order's number is looked up on read
export type MockDelivery = Omit<Delivery, 'order'> & { orderId: string | null };

export interface MockSalesDocuments {
  quotations: MockQuotation[];
  orders: MockOrder[];
  deliveries: MockDelivery[];
  // The last number given from each series. One counter per series, like the mock's stock
  // documents; the API starts again each fiscal year.
  counters: { quotation: number; order: number; delivery: number };
}

export function emptySalesDocuments(): MockSalesDocuments {
  return {
    quotations: [],
    orders: [],
    deliveries: [],
    counters: { quotation: 0, order: 0, delivery: 0 },
  };
}

function now(): string {
  return new Date().toISOString();
}

function fieldProblem(code: ErrorCode, field: string): MockProblem {
  return new MockProblem(409, code, { [field]: [code] });
}

// The mock's cursor is an offset, like its other lists
export function pageOf<T>(
  all: readonly T[],
  query: { cursor?: string | undefined; limit: number },
): { items: T[]; nextCursor: string | null } {
  const start = query.cursor === undefined ? 0 : Number(query.cursor);
  const items = all.slice(start, start + query.limit);
  const end = start + items.length;
  return { items, nextCursor: end < all.length ? String(end) : null };
}

// Newest date first, like the API. Two documents of one day keep the array's order: a new one is
// put first, so it comes first, like the API's uuidv7 ids.
function newestFirst<T extends { date: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => b.date.localeCompare(a.date));
}

type Series = keyof MockSalesDocuments['counters'];

const SERIES = {
  quotation: 'sales.quotation',
  order: 'sales.order',
  delivery: 'sales.delivery',
} as const satisfies Record<Series, DocumentType>;

// The next number of a series, in the format saved on the Numbering page (or the default one)
function nextNumber(data: WorkspaceData, series: Series, date: string): string {
  const type = SERIES[series];
  const format = data.series.get(type) ?? defaultNumberFormat(type);
  data.salesDocuments.counters[series] += 1;
  return formatDocumentNumber(
    format,
    periodOf(date, format.yearStyle, data.settings.fiscalYearStartMonth),
    data.salesDocuments.counters[series],
  );
}
```

- **Stored shapes leave out what the API works out on read.** A quotation's `order`, an order's `partlyDelivered`,
  `quotation` and `deliveries`, and a delivery's `order` are joins in the API. The mock stores the ids
  (`quotationId`, `orderId`) and builds these fields in `toQuotation()`, `toOrder()` and `toDelivery()`. So a
  delivery posted a second ago shows on its order at once, and a confirmed order's new number shows on its
  quotation.
- **`pageOf()` uses an offset as the cursor**, like the mock's other lists. The client treats the cursor as an
  opaque string, so it cannot tell the difference.
- **`newestFirst()` sorts by date only.** New documents are put first in the array, and `toSorted` is stable, so
  two documents of the same day show newest first. The API gets the same order from its uuidv7 ids.
- **One counter per series, not per year**, like the mock's stock documents. The number is formatted with the
  format saved on the Numbering page (`data.series`), so a changed prefix shows on the next document, as with the
  API. `usedNumbers()` in `workspace-data.ts` reads the same counters, so the Numbering page's "next number" is
  right.

### What every sales document checks

```ts
// --- What every sales document checks -----------------------------------------------------------

// An active customer. A draft keeps its customer (keptId) even after the customer is archived,
// like the API's assertCustomer(), so the person can still finish it.
function customerOf(data: WorkspaceData, customerId: string, keptId: string | null): PartyRef {
  const found = data.sales.customers.find((item) => item.id === customerId);
  if (!found || (found.archivedAt !== null && found.id !== keptId)) {
    throw fieldProblem('sales_customer_invalid', 'customerId');
  }
  return { id: found.id, code: found.code, name: found.name };
}

// One of the customer's addresses, as the document keeps it: the label, the address and the phone
// on their own lines, the way a challan prints them
function shippingAddressOf(
  data: WorkspaceData,
  customerId: string,
  addressId: string | null,
): { id: string; text: string } | null {
  if (addressId === null) return null;
  const address = data.sales.customers
    .find((item) => item.id === customerId)
    ?.addresses.find((item) => item.id === addressId);
  if (!address) throw fieldProblem('sales_address_invalid', 'shippingAddressId');
  const text = [address.label, address.address, address.phone]
    .filter((part): part is string => part !== null)
    .join('\n');
  return { id: address.id, text };
}

interface ResolvedLine {
  line: SalesLine;
  amounts: LineAmounts;
}

// The API's resolveSalesLines(): an active product or service, its unit, the decimals, and an
// active VAT rate (or one the document's lines already use: keptRateIds). Every problem at once,
// each under its own field.
function resolveSalesLines(
  data: WorkspaceData,
  lines: readonly SalesLineInput[],
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string>,
): ResolvedLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const resolved = lines.flatMap((input, index): ResolvedLine[] => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const found = findVariant(data, input.variantId);
    if (found?.product.archivedAt !== null || found.variant.archivedAt !== null) {
      at('variantId', 'sales_item_invalid');
      return [];
    }
    const { product, variant } = found;
    const factor =
      input.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === input.unitId)?.factor;
    if (factor === undefined) {
      at('unitId', 'stock_unit_invalid');
      return [];
    }
    if (!fitsDecimals(input.quantity, decimalsOf(data, input.unitId))) {
      at('quantity', 'stock_quantity_decimals');
      return [];
    }
    const rate = data.sales.taxRates.find((item) => item.id === input.taxRateId);
    if (!rate || (rate.archivedAt !== null && !keptRateIds.has(rate.id))) {
      at('taxRateId', 'tax_rate_invalid');
      return [];
    }
    const amounts = lineAmounts(
      {
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        discountType: input.discountType,
        discount: input.discount,
        rate: rate.rate,
      },
      pricesIncludeVat,
    );
    const ref = refOf(product, variant);
    return [
      {
        amounts,
        line: {
          ...ref,
          id: crypto.randomUUID(),
          productType: product.type,
          tracking: product.tracking,
          hasExpiry: product.hasExpiry,
          units: product.units.map((pack) => ({ unitId: pack.unitId, factor: pack.factor })),
          unitId: input.unitId,
          // "2" → "2.0000": the way Postgres sends NUMERIC(19,4)
          quantity: addQuantity(input.quantity, '0'),
          baseQuantity: toBaseQuantity(
            input.quantity,
            factor,
            decimalsOf(data, product.baseUnitId),
          ),
          description: input.description ?? defaultLineDescription(ref),
          unitPrice: addMoney(input.unitPrice, '0'),
          discountType: input.discountType,
          discount: addMoney(input.discount, '0'),
          taxRate: { id: rate.id, name: rate.name, kind: rate.kind, rate: rate.rate },
          net: amounts.net,
          vat: amounts.vat,
          total: amounts.total,
        },
      },
    ];
  });
  if (issues.length > 0) throw issuesError(issues);
  return resolved;
}

function totalsOf(resolved: readonly ResolvedLine[]) {
  return documentTotals(resolved.map((item) => item.amounts));
}

// The VAT rates a document's lines use now: they stay usable on it after they are archived
function ratesOf(lines: readonly SalesLine[]): Set<string> {
  return new Set(lines.map((line) => line.taxRate.id));
}
```

- **`customerOf(…, keptId)`.** An archived customer is refused, except the one a draft already has: the person
  can still finish that draft. This is the API's `assertCustomer()`.
- **The address text is built once, when the document is saved:** label, address and phone on their own lines.
  The document keeps this text, so a later change to the customer's addresses does not rewrite a challan.
- **`resolveSalesLines()` uses `lineAmounts()` from the contracts**, the same function as the form and the API.
  The mock's totals are then the form's totals to the paisa, and a test can assert "৳5,133.75".
- **Every problem at once.** Each line's problem is collected under its own field (`lines.1.taxRateId`) and
  thrown together at the end, like the API. The form then marks every wrong box after one click.
- **`addQuantity(x, '0')` and `addMoney(x, '0')`** turn "2" into "2.0000", the way Postgres sends `NUMERIC(19,4)`.
  The screens never see a value shaped differently from the real API's.
- **`ratesOf()`**: a VAT rate archived after a draft was saved stays usable on that draft, as in the API.

### The price a line starts with

```ts
// --- The price a line starts with ---------------------------------------------------------------

// The API's PriceLookupService: the customer's active price list, else the variant's own price ×
// the unit's factor, else none; and the product's own active VAT rate, else the default one
export function lookupPrices(data: WorkspaceData, input: PriceLookupInput): PriceLookup {
  const { sales } = data;
  const customer =
    input.customerId === null
      ? undefined
      : sales.customers.find((item) => item.id === input.customerId);
  // An archived list falls back to the products' own prices, as 15a promised
  const list = sales.priceLists.find(
    (item) => item.id === customer?.priceListId && item.archivedAt === null,
  );
  const fallbackRate = sales.taxRates.find((rate) => rate.isDefault);
  const items = input.items.flatMap((item): PriceLookupItem[] => {
    const found = findVariant(data, item.variantId);
    if (!found) return [];
    const { product, variant } = found;
    const factor =
      item.unitId === product.baseUnitId
        ? '1'
        : product.units.find((pack) => pack.unitId === item.unitId)?.factor;
    // A unit that is not this product's is left out, like an unknown variant
    if (factor === undefined) return [];
    const rate =
      sales.taxRates.find((row) => row.id === product.taxRateId && row.archivedAt === null) ??
      fallbackRate;
    if (!rate) return [];
    const listPrice =
      list === undefined
        ? undefined
        : sales.priceItems.find(
            (price) =>
              price.priceListId === list.id &&
              price.variantId === variant.id &&
              price.unitId === item.unitId,
          )?.price;
    // The price per base unit × the pack's factor, rounded to the 4 decimals a price keeps, like
    // the API's NUMERIC round(…, 4). toBaseQuantity() is exactly that sum: a number with 4 decimals
    // times a factor with 6, rounded half up.
    const productPrice =
      variant.salePrice === null ? null : toBaseQuantity(variant.salePrice, factor, 4);
    const price = listPrice ?? productPrice;
    return [
      {
        variantId: variant.id,
        unitId: item.unitId,
        price,
        source: listPrice !== undefined ? 'price_list' : price === null ? null : 'product',
        taxRateId: rate.id,
      },
    ];
  });
  return { pricesIncludeVat: data.settings.pricesIncludeVat, items };
}
```

- **The same order of choices as the API:** the customer's price list (only while it is active), then the
  variant's own price × the unit's factor, then none. The VAT rate is the product's own (if active), else the
  default.
- **`toBaseQuantity(price, factor, 4)` for the pack price.** The API multiplies in Postgres `NUMERIC` and rounds to
  4 decimals. `multiplyMoney()` would round to the paisa instead, and a price × a yard's factor (0.9144) would
  differ in the third decimal. `toBaseQuantity()` is exactly "a 4-decimal number × a 6-decimal factor, rounded
  half up to N decimals", so it is used here even though its name is about quantities.
- **An unknown variant, or a unit that is not the product's, is left out** of the answer, not an error, as the
  contract says.

### Quotations

```ts
// --- Quotations ---------------------------------------------------------------------------------

export function findQuotation(data: WorkspaceData, id: string): MockQuotation {
  const found = data.salesDocuments.quotations.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toQuotation(data: WorkspaceData, stored: MockQuotation): Quotation {
  const order = data.salesDocuments.orders.find((item) => item.quotationId === stored.id);
  return { ...stored, order: order ? { id: order.id, number: order.number } : null };
}

export function listQuotations(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): Quotation[] {
  return newestFirst(data.salesDocuments.quotations)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toQuotation(data, item));
}

// A new quotation gets its number at once; an open one can be changed, keeping its number, its
// customer (even if archived since) and its way of reading prices
export function saveQuotation(
  data: WorkspaceData,
  input: QuotationInput,
  existing?: MockQuotation,
): MockQuotation {
  if (existing && existing.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  const pricesIncludeVat = existing?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const resolved = resolveSalesLines(
    data,
    input.lines,
    pricesIncludeVat,
    ratesOf(existing?.lines ?? []),
  );
  const saved: MockQuotation = {
    id: existing?.id ?? crypto.randomUUID(),
    // Taken last: a refused quotation uses no number
    number: existing?.number ?? nextNumber(data, 'quotation', input.date),
    date: input.date,
    validUntil: input.validUntil,
    customer,
    status: 'open',
    pricesIncludeVat,
    ...totalsOf(resolved),
    note: input.note,
    lines: resolved.map((item) => item.line),
    lineCount: resolved.length,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
  };
  const { quotations } = data.salesDocuments;
  data.salesDocuments.quotations = existing
    ? quotations.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...quotations];
  return saved;
}

export function removeQuotation(data: WorkspaceData, target: MockQuotation): void {
  if (target.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  data.salesDocuments.quotations = data.salesDocuments.quotations.filter(
    (item) => item.id !== target.id,
  );
}

// "Mark declined" on an open one, "Open again" on a declined one. Accepted is set by an order.
export function answerQuotation(target: MockQuotation, action: 'decline' | 'reopen'): void {
  if (action === 'decline' && target.status !== 'open') {
    throw new MockProblem(409, 'quotation_not_open');
  }
  if (action === 'reopen' && target.status !== 'declined') {
    throw new MockProblem(409, 'quotation_not_declined');
  }
  Object.assign(target, {
    status: action === 'decline' ? 'declined' : 'open',
    version: target.version + 1,
    updatedAt: now(),
  });
}
```

- **The number is taken last.** `nextNumber()` runs after the customer and the lines are checked, so a refused
  quotation does not use up a number.
- **Only an open quotation changes.** Edit, delete and decline answer `quotation_not_open` otherwise; reopen
  answers `quotation_not_declined` for anything but a declined one. "Accepted" is set only by an order made from
  the quotation.

### Sales orders

```ts
// --- Sales orders -------------------------------------------------------------------------------

type OrderFields = Omit<SalesOrderInput, 'confirm' | 'quotationId'>;

export function findOrder(data: WorkspaceData, id: string): MockOrder {
  const found = data.salesDocuments.orders.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function anythingDelivered(order: MockOrder): boolean {
  return order.lines.some((line) => !isZeroQuantity(line.deliveredQuantity));
}

export function toOrder(data: WorkspaceData, stored: MockOrder): SalesOrder {
  const { quotationId, ...order } = stored;
  const quotation = data.salesDocuments.quotations.find((item) => item.id === quotationId);
  return {
    ...order,
    partlyDelivered: stored.status === 'confirmed' && anythingDelivered(stored),
    quotation: quotation ? { id: quotation.id, number: quotation.number } : null,
    // Drafts too, oldest first: the order page lists every challan made against it
    deliveries: data.salesDocuments.deliveries
      .filter((item) => item.orderId === stored.id)
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({ id: item.id, number: item.number, date: item.date, status: item.status })),
  };
}

export function listOrders(
  data: WorkspaceData,
  query: { status?: string | undefined; customerId?: string | undefined },
): SalesOrder[] {
  return newestFirst(data.salesDocuments.orders)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId),
    )
    .map((item) => toOrder(data, item));
}

// What a new order and a changed draft share: the warehouse, the address and the lines, checked
function orderParts(
  data: WorkspaceData,
  input: OrderFields,
  customer: PartyRef,
  pricesIncludeVat: boolean,
  keptRateIds: ReadonlySet<string>,
) {
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const address = shippingAddressOf(data, customer.id, input.shippingAddressId);
  const resolved = resolveSalesLines(data, input.lines, pricesIncludeVat, keptRateIds);
  return {
    date: input.date,
    deliveryDate: input.deliveryDate,
    customer,
    customerReference: input.customerReference,
    warehouseId: input.warehouseId,
    shippingAddressId: address?.id ?? null,
    shippingAddress: address?.text ?? null,
    note: input.note,
    pricesIncludeVat,
    ...totalsOf(resolved),
    lineCount: resolved.length,
    lines: resolved.map((item) => ({ ...item.line, deliveredQuantity: '0.0000' })),
  };
}

// The quotation an order is made from: this customer's, and still waiting for an answer
function openQuotation(data: WorkspaceData, quotationId: string, customerId: string) {
  const quotation = data.salesDocuments.quotations.find((item) => item.id === quotationId);
  if (quotation?.customer.id !== customerId) {
    throw fieldProblem('order_quotation_invalid', 'quotationId');
  }
  if (quotation.status !== 'open') throw new MockProblem(409, 'quotation_not_open');
  return quotation;
}

export function createOrder(
  data: WorkspaceData,
  input: OrderFields,
  quotationId: string | null,
): MockOrder {
  const customer = customerOf(data, input.customerId, null);
  const quotation = quotationId === null ? null : openQuotation(data, quotationId, customer.id);
  // An order made from a quotation reads its prices the way the quotation did
  const pricesIncludeVat = quotation?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
  const created: MockOrder = {
    id: crypto.randomUUID(),
    number: null,
    status: 'draft',
    confirmedAt: null,
    quotationId: quotation?.id ?? null,
    ...orderParts(data, input, customer, pricesIncludeVat, new Set()),
    version: 1,
    updatedAt: now(),
  };
  data.salesDocuments.orders = [created, ...data.salesDocuments.orders];
  // The customer said yes: the order accepts its quotation
  if (quotation) {
    Object.assign(quotation, {
      status: 'accepted',
      version: quotation.version + 1,
      updatedAt: now(),
    });
  }
  return created;
}

export function updateOrder(data: WorkspaceData, target: MockOrder, input: OrderFields): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  const customer = customerOf(data, input.customerId, target.customer.id);
  // A reopened order keeps its customer: its number was given to this customer, and a quotation
  // of this customer may point at it
  if (
    (target.number !== null || target.quotationId !== null) &&
    customer.id !== target.customer.id
  ) {
    throw fieldProblem('sales_customer_invalid', 'customerId');
  }
  Object.assign(
    target,
    orderParts(data, input, customer, target.pricesIncludeVat, ratesOf(target.lines)),
    { version: target.version + 1, updatedAt: now() },
  );
}

// The number the first time; a reopened order confirms again with the number it already has
export function confirmOrder(data: WorkspaceData, target: MockOrder): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  Object.assign(target, {
    status: 'confirmed',
    number: target.number ?? nextNumber(data, 'order', target.date),
    confirmedAt: now(),
    version: target.version + 1,
    updatedAt: now(),
  });
}

// Only a draft that never had a number; its quotation waits for an answer again
export function removeOrder(data: WorkspaceData, target: MockOrder): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'sales_not_draft');
  if (target.number !== null) throw new MockProblem(409, 'order_numbered');
  data.salesDocuments.orders = data.salesDocuments.orders.filter((item) => item.id !== target.id);
  const quotation = data.salesDocuments.quotations.find((item) => item.id === target.quotationId);
  if (quotation) {
    Object.assign(quotation, { status: 'open', version: quotation.version + 1, updatedAt: now() });
  }
}

// Back to draft (no delivery at all, not even a draft one), close (something delivered) or cancel
// (nothing delivered): the API's three rules
export function changeOrderStatus(
  data: WorkspaceData,
  target: MockOrder,
  action: 'reopen' | 'close' | 'cancel',
): void {
  if (target.status !== 'confirmed') throw new MockProblem(409, 'order_not_confirmed');
  if (
    action === 'reopen' &&
    data.salesDocuments.deliveries.some((item) => item.orderId === target.id)
  ) {
    throw new MockProblem(409, 'order_has_deliveries');
  }
  if (action === 'close' && !anythingDelivered(target)) {
    throw new MockProblem(409, 'order_nothing_delivered');
  }
  if (action === 'cancel' && anythingDelivered(target)) {
    throw new MockProblem(409, 'order_partly_delivered');
  }
  const status = action === 'reopen' ? 'draft' : action === 'close' ? 'closed' : 'cancelled';
  Object.assign(target, {
    status,
    ...(action === 'reopen' && { confirmedAt: null }),
    version: target.version + 1,
    updatedAt: now(),
  });
}
```

- **An order made from a quotation copies the quotation's `pricesIncludeVat`**, not the setting now: the lines
  were priced that way.
- **Saving the order accepts the quotation; deleting the draft order opens it again.** This is how the
  quotations test sees "Accepted" after "Make order".
- **A reopened order keeps its number and its customer.** `confirmOrder()` gives a number only when there is none,
  and `updateOrder()` refuses a new customer for an order that has a number or a quotation. `removeOrder()`
  refuses a draft with a number (`order_numbered`): the customer was given that number.
- **`changeOrderStatus()` holds the three rules of the API:** back to draft only with no delivery at all (drafts
  count, because their lines point at the order's lines), close only when something was delivered, cancel only
  when nothing was.

### Deliveries

```ts
// --- Deliveries ---------------------------------------------------------------------------------

type DeliveryFields = Omit<DeliveryInput, 'post'>;

export function findDelivery(data: WorkspaceData, id: string): MockDelivery {
  const found = data.salesDocuments.deliveries.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

export function toDelivery(data: WorkspaceData, stored: MockDelivery): Delivery {
  const { orderId, ...delivery } = stored;
  const order = data.salesDocuments.orders.find((item) => item.id === orderId);
  return { ...delivery, order: order ? { id: order.id, number: order.number } : null };
}

export function listDeliveries(
  data: WorkspaceData,
  query: {
    status?: string | undefined;
    customerId?: string | undefined;
    warehouseId?: string | undefined;
  },
): Delivery[] {
  return newestFirst(data.salesDocuments.deliveries)
    .filter(
      (item) =>
        (query.status === undefined || item.status === query.status) &&
        (query.customerId === undefined || item.customer.id === query.customerId) &&
        (query.warehouseId === undefined || item.warehouseId === query.warehouseId),
    )
    .map((item) => toDelivery(data, item));
}

// The order of a delivery: this customer's, and confirmed (waiting for deliveries)
function deliverableOrder(data: WorkspaceData, orderId: string, customerId: string): MockOrder {
  const order = data.salesDocuments.orders.find((item) => item.id === orderId);
  if (order?.customer.id !== customerId) throw fieldProblem('delivery_order_invalid', 'orderId');
  if (order.status !== 'confirmed') throw fieldProblem('order_not_confirmed', 'orderId');
  return order;
}

// Each line delivers a line of the order, of the same variant, and the lines together never take
// more than an order line has left: ordered − delivered by posted deliveries. Drafts hold
// nothing, so two drafts may each take the whole rest; the second one to post is refused here.
function checkOrderLines(
  order: MockOrder,
  orderLineIds: readonly (string | null)[],
  lines: readonly StockLine[],
): void {
  const issues: { path: string; code: ErrorCode }[] = [];
  const taken = new Map<string, string[]>();
  lines.forEach((line, index) => {
    const path = (field: string) => `lines.${String(index)}.${field}`;
    const orderLineId = orderLineIds[index] ?? null;
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (orderLineId === null) {
      issues.push({ path: path('orderLineId'), code: 'delivery_order_line_required' });
    } else if (orderLine?.variantId !== line.variantId) {
      issues.push({ path: path('orderLineId'), code: 'delivery_order_line_invalid' });
    } else {
      taken.set(orderLineId, [...(taken.get(orderLineId) ?? []), line.baseQuantity]);
    }
  });
  for (const [orderLineId, quantities] of taken) {
    const orderLine = order.lines.find((item) => item.id === orderLineId);
    if (!orderLine) continue;
    const left = subtractQuantity(orderLine.baseQuantity, orderLine.deliveredQuantity);
    if (compareQuantity(sumQuantity(quantities), left) <= 0) continue;
    // Under every line that takes from it: the person decides which one to cut
    orderLineIds.forEach((id, index) => {
      if (id === orderLineId) {
        issues.push({ path: `lines.${String(index)}.quantity`, code: 'delivery_over_order' });
      }
    });
  }
  if (issues.length > 0) throw issuesError(issues);
}

export function saveDelivery(
  data: WorkspaceData,
  input: DeliveryFields,
  existing?: MockDelivery,
): MockDelivery {
  if (existing && existing.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  const customer = customerOf(data, input.customerId, existing?.customer.id ?? null);
  assertWarehouses(data, [{ field: 'warehouseId', id: input.warehouseId }]);
  const order = input.orderId === null ? null : deliverableOrder(data, input.orderId, customer.id);
  const address = shippingAddressOf(data, customer.id, input.shippingAddressId);
  const lines = resolveLines(data, input.lines, 'out');
  const orderLineIds = input.lines.map((line) => line.orderLineId);
  if (order) checkOrderLines(order, orderLineIds, lines);
  const saved: MockDelivery = {
    id: existing?.id ?? crypto.randomUUID(),
    number: null,
    date: input.date,
    customer,
    orderId: order?.id ?? null,
    warehouseId: input.warehouseId,
    status: 'draft',
    shippingAddressId: address?.id ?? null,
    shippingAddress: address?.text ?? null,
    vehicle: input.vehicle,
    note: input.note,
    lineCount: lines.length,
    postedAt: null,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now(),
    lines: lines.map((line, index) => ({
      ...line,
      orderLineId: orderLineIds[index] ?? null,
      value: null,
    })),
    entry: null,
  };
  const { deliveries } = data.salesDocuments;
  data.salesDocuments.deliveries = existing
    ? deliveries.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...deliveries];
  return saved;
}

export function removeDelivery(data: WorkspaceData, target: MockDelivery): void {
  if (target.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  data.salesDocuments.deliveries = data.salesDocuments.deliveries.filter(
    (item) => item.id !== target.id,
  );
}

// The accounts a delivery posts to: Dr cost of goods sold / Cr inventory
function deliveryAccounts(data: WorkspaceData) {
  const usable = (purpose: string) =>
    data.accounts.find(
      (account) => account.purpose === purpose && !account.isGroup && account.archivedAt === null,
    )?.id;
  const inventory = usable('inventory');
  const costOfGoodsSold = usable('cost_of_goods_sold');
  if (inventory === undefined) throw new MockProblem(409, 'stock_account_missing');
  if (costOfGoodsSold === undefined) {
    throw new MockProblem(409, 'stock_account_missing', undefined, { use: 'cost_of_goods_sold' });
  }
  return { inventory, costOfGoodsSold };
}

// What the posted lines delivered goes onto their order lines; when every goods line has all it
// ordered, the order is delivered. A service line never counts.
function deliverOnOrder(
  order: MockOrder,
  orderLineIds: readonly (string | null)[],
  lines: readonly StockLine[],
): void {
  lines.forEach((line, index) => {
    const orderLine = order.lines.find((item) => item.id === orderLineIds[index]);
    if (orderLine) {
      orderLine.deliveredQuantity = addQuantity(orderLine.deliveredQuantity, line.baseQuantity);
    }
  });
  const done = order.lines.every(
    (line) =>
      line.productType !== 'goods' ||
      compareQuantity(line.deliveredQuantity, line.baseQuantity) >= 0,
  );
  // A new version either way: an order page open somewhere shows old delivered quantities
  Object.assign(order, {
    ...(done && { status: 'delivered' }),
    version: order.version + 1,
    updatedAt: now(),
  });
}

// The API's postAndLog(): the date, the warehouse and the order checked again, the number taken,
// the stock moved at its average cost (step 14), the cost of goods sold booked, and the order's
// delivered quantities moved on. A refused posting changes nothing and uses no number.
export function postDelivery(data: WorkspaceData, draft: MockDelivery): MockDelivery {
  if (draft.status !== 'draft') throw new MockProblem(409, 'stock_not_draft');
  assertDate(data, draft.date);
  // Before anything moves, like the API's StockPostingService.assertDate()
  if (data.journal.lockDate !== null && draft.date <= data.journal.lockDate) {
    throw fieldProblem('journal_period_locked', 'date');
  }
  assertWarehouses(data, [{ field: 'warehouseId', id: draft.warehouseId }]);
  const order =
    draft.orderId === null ? null : deliverableOrder(data, draft.orderId, draft.customer.id);
  const orderLineIds = draft.lines.map((line) => line.orderLineId);
  // Again: another delivery of this order may have been posted since this one was saved
  if (order) checkOrderLines(order, orderLineIds, draft.lines);
  const accounts = deliveryAccounts(data);
  const number = nextNumber(data, 'delivery', draft.date);
  let values: string[];
  try {
    values = postMoves(
      data,
      { date: draft.date, kind: 'delivery', direction: 'out', documentId: draft.id, number },
      draft.lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        stockLine: line,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    );
  } catch (error) {
    // The API's transaction gives the number back; so does the mock
    data.salesDocuments.counters.delivery -= 1;
    throw error;
  }
  const total = sumMoney(values);
  const branchId = branchOf(data, draft.warehouseId);
  const entry = postStockEntry(data, {
    date: draft.date,
    source: 'sales_delivery',
    document: { id: draft.id, number },
    narration: `Delivery ${number}`,
    amounts: [
      { accountId: accounts.costOfGoodsSold, branchId, amount: total },
      { accountId: accounts.inventory, branchId, amount: negateMoney(total) },
    ],
  });
  Object.assign(draft, {
    lines: draft.lines.map((line, index) => ({ ...line, value: values[index] ?? null })),
    entry,
    number,
    status: 'posted',
    postedAt: now(),
    version: draft.version + 1,
    updatedAt: now(),
  });
  if (order) deliverOnOrder(order, orderLineIds, draft.lines);
  return draft;
}
```

- **`checkOrderLines()` runs at save and again at posting.** At save it gives the early error under the quantity.
  At posting it catches the second of two drafts that each took the whole rest: drafts hold nothing.
- **The over-order error goes under every line that takes from the same order line.** Two lines may share an
  order line (two batches); the person picks which one to lower.
- **The lock date is checked before anything moves.** The journal posting would refuse a locked date too, but
  only after `postMoves()` had written the stock movements. The early check keeps a refused posting from
  changing anything, like the API's `StockPostingService.assertDate()`.
- **The number is given back if the stock moves fail**, as the API's transaction does: posted numbers have no gaps.
- **Dr cost of goods sold / Cr inventory, at the value `postMoves()` worked out.** `postStockEntry()` (step 14)
  writes the entry with the source `sales_delivery`, so the journal links back to the delivery.
- **`deliverOnOrder()` updates the order lines first, then the order's status**, and bumps the order's version
  every time. A page that shows the order from before the delivery then gets `version_conflict` if it tries to
  close it, and reloads.

### The seeds

```ts
// --- Seed ---------------------------------------------------------------------------------------

function daysFromToday(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// What a fixture workspace starts with, so every list and pill has something to show. Garments:
// a declined quotation (H&M), an expired one (Primark), an open one (Aarong), H&M's confirmed
// export order, and a draft for Aarong. Pharma: Lazz Pharma's confirmed order for 40 boxes of
// Napa, more than the batch that expires first holds, so a delivery splits it (FEFO). No delivery
// is posted: the seeded books (reports, journal) stay as they were before step 15b.
export function seedSalesDocuments(data: WorkspaceData, garments: boolean): void {
  const today = todayIn(data.settings.timezone);
  const day = (days: number) => daysFromToday(today, days);
  const customer = (name: string) => {
    const found = data.sales.customers.find((item) => item.name === name);
    if (!found) throw new Error(`The mock has no customer ${name}`);
    return found;
  };
  const rate = (name: string) => {
    const found = data.sales.taxRates.find((item) => item.name === name);
    if (!found) throw new Error(`The mock has no VAT rate ${name}`);
    return found.id;
  };
  const unit = (code: string) => {
    const found = data.catalog.units.find((item) => item.code === code);
    if (!found) throw new Error(`The mock has no unit ${code}`);
    return found.id;
  };
  const line = (
    code: string,
    options: string[],
    unitCode: string,
    quantity: string,
    unitPrice: string,
    rateName: string,
    discount = '0',
  ): SalesLineInput => {
    const variant = data.catalog.products
      .find((item) => item.code === code)
      ?.variants.find((item) => item.optionValues.join('|') === options.join('|'));
    if (!variant) throw new Error(`The mock has no ${code} ${options.join(', ')}`);
    return {
      variantId: variant.id,
      unitId: unit(unitCode),
      quantity,
      description: null,
      unitPrice,
      discountType: 'percent',
      discount,
      taxRateId: rate(rateName),
    };
  };
  const quotation = (input: QuotationInput) => saveQuotation(data, input);
  const [main] = data.stock.warehouses;
  if (!main) return;

  if (garments) {
    const hm = customer('H&M Hennes & Mauritz GBC AB');
    const aarong = customer('Aarong');
    answerQuotation(
      quotation({
        customerId: hm.id,
        date: day(-30),
        validUntil: day(-16),
        note: null,
        lines: [
          line('ST-118', ['M', 'Navy blue'], 'dozen', '40', '6900', 'Zero-rated'),
          line('ST-118', ['L', 'Navy blue'], 'dozen', '40', '6900', 'Zero-rated'),
        ],
      }),
      'decline',
    );
    quotation({
      customerId: customer('Primark Stores Ltd.').id,
      date: day(-20),
      validUntil: day(-6),
      note: 'FOB Chattogram. Shipment 45 days after the LC opens.',
      lines: [line('P-00001', [], 'pcs', '2400', '300', 'Zero-rated')],
    });
    quotation({
      customerId: aarong.id,
      date: day(-3),
      validUntil: day(11),
      note: null,
      lines: [
        line('P-00001', [], 'pcs', '200', '290', 'VAT 15%'),
        line('P-00004', [], 'carton', '2', '2750', 'VAT 15%', '5'),
      ],
    });
    const port = hm.addresses.find((address) => address.kind === 'shipping');
    confirmOrder(
      data,
      createOrder(
        data,
        {
          customerId: hm.id,
          date: day(-10),
          deliveryDate: day(20),
          customerReference: 'PO-HM-2026-1187',
          warehouseId: main.id,
          shippingAddressId: port?.id ?? null,
          note: '12 pieces per carton, the buyer’s hangtag on each',
          lines: [
            line('ST-118', ['M', 'Navy blue'], 'dozen', '5', '6900', 'Zero-rated'),
            line('ST-118', ['L', 'Navy blue'], 'dozen', '5', '6900', 'Zero-rated'),
          ],
        },
        null,
      ),
    );
    createOrder(
      data,
      {
        customerId: aarong.id,
        date: day(-1),
        deliveryDate: null,
        customerReference: null,
        warehouseId: main.id,
        shippingAddressId: null,
        note: null,
        lines: [line('P-00001', [], 'pcs', '100', '290', 'VAT 15%')],
      },
      null,
    );
    return;
  }
  const lazz = customer('Lazz Pharma Ltd.');
  confirmOrder(
    data,
    createOrder(
      data,
      {
        customerId: lazz.id,
        date: day(-2),
        deliveryDate: day(1),
        customerReference: 'IND-0915',
        warehouseId: main.id,
        shippingAddressId:
          lazz.addresses.find((address) => address.kind === 'shipping')?.id ?? null,
        note: null,
        lines: [line('P-00001', [], 'box', '40', '102', 'Exempt')],
      },
      null,
    ),
  );
}
```

- **Made with the same functions the handlers use** (`saveQuotation`, `createOrder`, `confirmOrder`), as the stock
  seeds use `saveAdjustment()`. A seed that breaks a rule fails at once, instead of showing data the real API
  could never hold.
- **One of each state the pages show:** a declined quotation, an expired one ("Expired" is worked out from the
  date), an open one, a confirmed order, a draft order. The Primark quotation is the expired one, and Bengal
  Buying House gets no document, because the customers test deletes Bengal Buying House.
- **The pharmacy order is for 40 boxes, 4,000 tablets.** The batch that expires first holds 3,000, so "Split by
  first expiry" has two batches to use.

### `mocks/workspace-data.ts` and `mocks/sales-data.ts`

```diff
@@ -29,6 +29,11 @@ import { type People, seedPeople } from './people-data';
 import { emptyCatalog, garmentsCatalog, type MockCatalog, pharmaCatalog } from './product-data';
 import type { MockExport } from './report-data';
 import { emptySales, type MockSales, seedSales } from './sales-data';
+import {
+  emptySalesDocuments,
+  type MockSalesDocuments,
+  seedSalesDocuments,
+} from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
 
 // mock সার্ভারের এক workspace-এর ডেটা — শুধু এই ট্যাবের memory-তে, reload করলে আবার শুরু থেকে।
@@ -55,6 +60,8 @@ export interface WorkspaceData {
   stockAccounts: StockAccounts;
   // VAT rates, customers and their groups, price lists (step 15a)
   sales: MockSales;
+  // Quotations, sales orders and deliveries (step 15b)
+  salesDocuments: MockSalesDocuments;
 }
 
 function now(): string {
@@ -114,12 +121,15 @@ function seed(workspace: Workspace): WorkspaceData {
     catalog: garments ? garmentsCatalog() : pharmaCatalog(),
     stock: emptyStock(),
     sales: emptySales(),
+    salesDocuments: emptySalesDocuments(),
   };
   data.stockAccounts = seedStockAccounts(data.accounts, garments ? 'garments' : 'pharma');
   // Before the journal: its receivable lines name the customers
   seedSales(data, garments);
   if (garments) seedJournal(data);
   seedStock(data, garments);
+  // After the stock: an order is sent from a warehouse
+  seedSalesDocuments(data, garments);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
@@ -252,6 +262,9 @@ function usedNumbers(data: WorkspaceData, documentType: DocumentType, period: st
   if (documentType === 'inventory.transfer') return data.stock.counters.transfer;
   if (documentType === 'inventory.revaluation') return data.stock.counters.revaluation;
   if (documentType === 'sales.customer') return data.sales.lastCode;
+  if (documentType === 'sales.quotation') return data.salesDocuments.counters.quotation;
+  if (documentType === 'sales.order') return data.salesDocuments.counters.order;
+  if (documentType === 'sales.delivery') return data.salesDocuments.counters.delivery;
   return 0;
 }
 
```

- **The sales documents are seeded after the stock**: an order is sent from a warehouse, and the warehouses are
  made by `seedStock()`.

```diff
@@ -581,22 +581,28 @@ export function saveCustomer(
   };
 }
 
-// The journal keeps a party's code and name on each line (the API joins them on read): after a
-// rename the lines show the new name, like the API's
+// The journal keeps a party's code and name on each line, and so does each sales document (step
+// 15b); the API joins them on read. After a rename they show the new name, like the API's.
 export function refreshPartyRefs(data: WorkspaceData, saved: MockCustomer): void {
+  const ref = { id: saved.id, code: saved.code, name: saved.name };
   for (const entry of data.journal.entries) {
     for (const line of entry.lines) {
-      if (line.party?.id === saved.id)
-        line.party = { id: saved.id, code: saved.code, name: saved.name };
+      if (line.party?.id === saved.id) line.party = ref;
     }
   }
+  const { quotations, orders, deliveries } = data.salesDocuments;
+  for (const document of [...quotations, ...orders, ...deliveries]) {
+    if (document.customer.id === saved.id) document.customer = ref;
+  }
 }
 
-// Only a customer no entry names, drafts included (the API's journal_lines_party_fk)
+// Only a customer no entry and no sales document names, drafts included (the API's
+// journal_lines_party_fk, and step 15b's quotations/sales_orders/deliveries_customer_fk)
 export function assertCustomerUnused(data: WorkspaceData, id: string): void {
-  const used = data.journal.entries.some((entry) =>
-    entry.lines.some((line) => line.party?.id === id),
-  );
+  const { quotations, orders, deliveries } = data.salesDocuments;
+  const used =
+    data.journal.entries.some((entry) => entry.lines.some((line) => line.party?.id === id)) ||
+    [...quotations, ...orders, ...deliveries].some((document) => document.customer.id === id);
   if (used) throw new MockProblem(409, 'customer_in_use');
 }
 
```

- **A customer named on a sales document cannot be deleted**, drafts included: `customer_in_use`, as the API's
  three new foreign keys answer. The customer can still be archived.
- **The check walks `data.salesDocuments` here, not through a helper in `sales-document-data.ts`.** That file
  imports `journal-data.ts` (a delivery posts its cost of goods sold), and `journal-data.ts` imports this file
  (a journal line's customer). One import back would close a circle, and `pnpm boundaries` refuses circular
  imports (`no-circular`). A circle also decides which module's top-level code runs first, which breaks in ways
  that are hard to see. Found in 15b.8.
- **A renamed customer shows its new name on the documents too.** The API joins the name on read; the mock keeps
  a copy, so it updates the copies.

### `mocks/handlers.ts`: the routes

```diff
@@ -97,6 +97,30 @@ import {
   toPriceList,
   updateTaxRate,
 } from './sales-data';
+import {
+  answerQuotation,
+  changeOrderStatus,
+  confirmOrder,
+  createOrder,
+  findDelivery,
+  findOrder,
+  findQuotation,
+  listDeliveries,
+  listOrders,
+  listQuotations,
+  lookupPrices,
+  pageOf,
+  postDelivery,
+  removeDelivery,
+  removeOrder,
+  removeQuotation,
+  saveDelivery,
+  saveQuotation,
+  toDelivery,
+  toOrder,
+  toQuotation,
+  updateOrder,
+} from './sales-document-data';
 import { settleSetup, startSetup } from './setup-data';
 import {
   batchReport,
@@ -2387,4 +2411,287 @@ export const handlers = [
       return reply(routes.priceLists.setItems, toPriceList(data.sales, target));
     }),
   ),
+
+  // Quotations, sales orders and deliveries (step 15b). The audit rows carry no field changes:
+  // the audit page shows what happened and to which document, which is what the e2e tests read.
+
+  mock(routes.salesPrices.lookup, async ({ request }) => {
+    const body = await readBody(routes.salesPrices.lookup.body, request);
+    return reply(routes.salesPrices.lookup, lookupPrices(current(), body));
+  }),
+
+  mock(routes.quotations.list, ({ request }) => {
+    const query = readQuery(routes.quotations.list.query, request);
+    return reply(routes.quotations.list, pageOf(listQuotations(current(), query), query));
+  }),
+
+  mock(
+    routes.quotations.get,
+    guarded(({ params }) => {
+      const { id } = routes.quotations.get.params.parse(params);
+      const data = current();
+      return reply(routes.quotations.get, toQuotation(data, findQuotation(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.quotations.create,
+    guarded(async ({ request }) => {
+      const body = await readBody(routes.quotations.create.body, request);
+      const data = current();
+      const saved = saveQuotation(data, body);
+      record(data, 'quotation.created', 'quotation', saved.id);
+      await delay();
+      return reply(routes.quotations.create, toQuotation(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.quotations.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.quotations.update.params.parse(params);
+      const { version, ...input } = await readBody(routes.quotations.update.body, request);
+      const data = current();
+      const target = findQuotation(data, id);
+      checkVersion(target.version, version);
+      const saved = saveQuotation(data, input, target);
+      record(data, 'quotation.updated', 'quotation', id);
+      await delay();
+      return reply(routes.quotations.update, toQuotation(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.quotations.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.quotations.remove.params.parse(params);
+      const { version } = readQuery(routes.quotations.remove.query, request);
+      const data = current();
+      const target = findQuotation(data, id);
+      checkVersion(target.version, version);
+      removeQuotation(data, target);
+      record(data, 'quotation.deleted', 'quotation', id);
+      return reply(routes.quotations.remove, undefined);
+    }),
+  ),
+
+  ...(['decline', 'reopen'] as const).map((action) =>
+    mock(
+      routes.quotations[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.quotations[action].params.parse(params);
+        const { version } = await readBody(routes.quotations[action].body, request);
+        const data = current();
+        const target = findQuotation(data, id);
+        checkVersion(target.version, version);
+        answerQuotation(target, action);
+        record(
+          data,
+          action === 'decline' ? 'quotation.declined' : 'quotation.reopened',
+          'quotation',
+          id,
+        );
+        return reply(routes.quotations[action], toQuotation(data, target));
+      }),
+    ),
+  ),
+
+  mock(routes.salesOrders.list, ({ request }) => {
+    const query = readQuery(routes.salesOrders.list.query, request);
+    return reply(routes.salesOrders.list, pageOf(listOrders(current(), query), query));
+  }),
+
+  mock(
+    routes.salesOrders.get,
+    guarded(({ params }) => {
+      const { id } = routes.salesOrders.get.params.parse(params);
+      const data = current();
+      return reply(routes.salesOrders.get, toOrder(data, findOrder(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.salesOrders.create,
+    guarded(async ({ request }) => {
+      const { confirm, quotationId, ...input } = await readBody(
+        routes.salesOrders.create.body,
+        request,
+      );
+      const data = current();
+      const saved = createOrder(data, input, quotationId);
+      record(data, 'sales_order.created', 'sales_order', saved.id);
+      // "Confirm order" on a new form: saved and confirmed in one step, like the API
+      if (confirm) {
+        confirmOrder(data, saved);
+        record(data, 'sales_order.confirmed', 'sales_order', saved.id);
+      }
+      await delay();
+      return reply(routes.salesOrders.create, toOrder(data, saved));
+    }),
+  ),
+
+  mock(
+    routes.salesOrders.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.salesOrders.update.params.parse(params);
+      const { confirm, version, ...input } = await readBody(
+        routes.salesOrders.update.body,
+        request,
+      );
+      const data = current();
+      const target = findOrder(data, id);
+      checkVersion(target.version, version);
+      updateOrder(data, target, input);
+      record(data, 'sales_order.updated', 'sales_order', id);
+      if (confirm) {
+        confirmOrder(data, target);
+        record(data, 'sales_order.confirmed', 'sales_order', id);
+      }
+      await delay();
+      return reply(routes.salesOrders.update, toOrder(data, target));
+    }),
+  ),
+
+  mock(
+    routes.salesOrders.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.salesOrders.remove.params.parse(params);
+      const { version } = readQuery(routes.salesOrders.remove.query, request);
+      const data = current();
+      const target = findOrder(data, id);
+      checkVersion(target.version, version);
+      removeOrder(data, target);
+      record(data, 'sales_order.deleted', 'sales_order', id);
+      return reply(routes.salesOrders.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.salesOrders.confirm,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.salesOrders.confirm.params.parse(params);
+      const { version } = await readBody(routes.salesOrders.confirm.body, request);
+      const data = current();
+      const target = findOrder(data, id);
+      checkVersion(target.version, version);
+      confirmOrder(data, target);
+      record(data, 'sales_order.confirmed', 'sales_order', id);
+      return reply(routes.salesOrders.confirm, toOrder(data, target));
+    }),
+  ),
+
+  ...(['reopen', 'close', 'cancel'] as const).map((action) =>
+    mock(
+      routes.salesOrders[action],
+      guarded(async ({ request, params }) => {
+        const { id } = routes.salesOrders[action].params.parse(params);
+        const { version } = await readBody(routes.salesOrders[action].body, request);
+        const data = current();
+        const target = findOrder(data, id);
+        checkVersion(target.version, version);
+        changeOrderStatus(data, target, action);
+        const done = {
+          reopen: 'sales_order.reopened',
+          close: 'sales_order.closed',
+          cancel: 'sales_order.cancelled',
+        } as const;
+        record(data, done[action], 'sales_order', id);
+        return reply(routes.salesOrders[action], toOrder(data, target));
+      }),
+    ),
+  ),
+
+  mock(routes.deliveries.list, ({ request }) => {
+    const query = readQuery(routes.deliveries.list.query, request);
+    return reply(routes.deliveries.list, pageOf(listDeliveries(current(), query), query));
+  }),
+
+  mock(
+    routes.deliveries.get,
+    guarded(({ params }) => {
+      const { id } = routes.deliveries.get.params.parse(params);
+      const data = current();
+      return reply(routes.deliveries.get, toDelivery(data, findDelivery(data, id)));
+    }),
+  ),
+
+  mock(
+    routes.deliveries.create,
+    guarded(async ({ request }) => {
+      const { post, ...input } = await readBody(routes.deliveries.create.body, request);
+      const data = current();
+      const draft = saveDelivery(data, input);
+      record(data, 'delivery.created', 'delivery', draft.id);
+      // "Post delivery" on a new form: saved and posted in one step, or nothing at all, like the
+      // API's transaction
+      if (post) {
+        try {
+          postDelivery(data, draft);
+        } catch (error) {
+          removeDelivery(data, draft);
+          data.audit.shift();
+          throw error;
+        }
+        record(data, 'delivery.posted', 'delivery', draft.id);
+      }
+      await delay();
+      return reply(routes.deliveries.create, toDelivery(data, draft));
+    }),
+  ),
+
+  mock(
+    routes.deliveries.update,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.deliveries.update.params.parse(params);
+      const { post, version, ...input } = await readBody(routes.deliveries.update.body, request);
+      const data = current();
+      const target = findDelivery(data, id);
+      checkVersion(target.version, version);
+      const draft = saveDelivery(data, input, target);
+      record(data, 'delivery.updated', 'delivery', id);
+      if (post) {
+        try {
+          postDelivery(data, draft);
+        } catch (error) {
+          // Back to the draft as it was before this save
+          data.salesDocuments.deliveries = data.salesDocuments.deliveries.map((item) =>
+            item.id === id ? target : item,
+          );
+          data.audit.shift();
+          throw error;
+        }
+        record(data, 'delivery.posted', 'delivery', id);
+      }
+      await delay();
+      return reply(routes.deliveries.update, toDelivery(data, draft));
+    }),
+  ),
+
+  mock(
+    routes.deliveries.remove,
+    guarded(({ request, params }) => {
+      const { id } = routes.deliveries.remove.params.parse(params);
+      const { version } = readQuery(routes.deliveries.remove.query, request);
+      const data = current();
+      const target = findDelivery(data, id);
+      checkVersion(target.version, version);
+      removeDelivery(data, target);
+      record(data, 'delivery.deleted', 'delivery', id);
+      return reply(routes.deliveries.remove, undefined);
+    }),
+  ),
+
+  mock(
+    routes.deliveries.post,
+    guarded(async ({ request, params }) => {
+      const { id } = routes.deliveries.post.params.parse(params);
+      const { version } = await readBody(routes.deliveries.post.body, request);
+      const data = current();
+      const target = findDelivery(data, id);
+      checkVersion(target.version, version);
+      postDelivery(data, target);
+      record(data, 'delivery.posted', 'delivery', id);
+      return reply(routes.deliveries.post, toDelivery(data, target));
+    }),
+  ),
 ];
```

- **Every handler follows the stock documents' pattern:** parse the body with the contract's schema, check the
  version, call the data function, write an audit row, reply through `reply()`, which checks the answer against
  the contract's response schema. A handler that sends a wrong shape fails in the test, not later in a screen.
- **The audit rows carry no field changes.** The audit page shows what happened and to which document; the API's
  field-by-field changes are tested in 15b.4.
- **`confirm: true` and `post: true` write two audit rows**, created (or updated) and then confirmed (or posted),
  like the API.
- **`delay()` on the saves** makes "Saving…" and "Posting…" visible in `pnpm dev:mock`, as on the other forms.

### `packages/ui`: `components/segmented-control.tsx`

```diff
@@ -19,13 +19,16 @@ export function SegmentedControl<TValue extends string>({
 }: SegmentedControlProps<TValue>) {
   const name = useId();
   return (
-    <fieldset className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
+    // A fieldset is never narrower than its content unless told (min-w-0). With many options
+    // (a sales order has six statuses) the control scrolls inside its own box on a phone, like
+    // the nav row, instead of pushing the page sideways.
+    <fieldset className="inline-flex max-w-full min-w-0 overflow-x-auto rounded-lg border border-line-strong bg-surface p-0.5">
       <legend className="sr-only">{label}</legend>
       {options.map((option) => (
         <label
           key={option.value}
           className={cn(
-            'cursor-pointer rounded-md px-3 py-1.5 text-body-sm font-medium transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand',
+            'shrink-0 cursor-pointer rounded-md px-3 py-1.5 text-body-sm font-medium whitespace-nowrap transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand',
             // CLAUDE.md: বাছাই করা segment-এ subtle পটভূমি
             option.value === value ? 'bg-subtle text-ink' : 'text-ink-2 hover:text-ink',
           )}
```

- **Found by the phone test of the order list.** The six order statuses are wider than a 390 px phone, and the
  page scrolled sideways by 58 px. CLAUDE.md says the page never scrolls sideways.
- **`min-w-0` is the key.** A `<fieldset>` is never narrower than its content by default (browsers give it
  `min-inline-size: min-content`). With `min-w-0` and `max-w-full` it fits its row, and `overflow-x-auto` lets the
  options scroll inside it, like the phone nav row.
- **`shrink-0` and `whitespace-nowrap` on each option** keep "Partly delivered" on one line instead of squeezing
  the options. Controls with few options look exactly as before.

### `e2e/helpers.ts`: a toast that closes

```diff
@@ -25,3 +25,11 @@ export async function expectNoSideScroll(page: Page): Promise<void> {
   );
   expect(overflow).toBeLessThanOrEqual(0);
 }
+
+// A toast, then wait for it to close. On a phone it sits over the buttons at the bottom of the
+// page, and it stays open while the pointer that just clicked rests on it: move the pointer away.
+export async function toastShown(page: Page, text: string | RegExp): Promise<void> {
+  await expect(page.getByText(text)).toBeVisible();
+  await page.mouse.move(0, 0);
+  await expect(page.getByText(text)).toBeHidden();
+}
```

- **On a phone the toast sits over the buttons at the bottom of the page**, and Sonner keeps a toast open while
  the pointer is over it. The pointer that clicked "Save" rests there, so the next click waits for 30 seconds.
  `journal.e2e.ts` worked around this once; the helper does it for every new test: see the toast, move the
  pointer away, wait until the toast is gone.

### `e2e/quotations.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b in the mock garments workspace: three quotations. QT-…-0001 (H&M) was declined,
// QT-…-0002 (Primark) is open but its date has passed, QT-…-0003 (Aarong) is open. Aarong buys
// on the "Local wholesale" price list: the T-shirt at ৳290 a piece, the mailer bags at ৳2,750 a
// carton. The workspace quotes before VAT.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

// Search the picker, add the product, and close the dialog. The row is found by its name: the
// list shows other products until the search has settled.
async function addItem(page: Page, search: string, name: string) {
  await page.getByRole('button', { name: 'Add items' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search products and services' }).fill(search);
  const row = dialog.getByRole('listitem').filter({ hasText: name });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeVisible();
  await page.keyboard.press('Escape');
}

async function pickCustomer(page: Page, search: string, name: RegExp) {
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill(search);
  await page.getByRole('option', { name }).click();
}

test('lists the quotations with their status, and filters them', async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toContainText('Aarong');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toContainText('Open');
  // Open, but its "valid until" date has passed: worked out by the page
  await expect(listItem(page, /QT-\d{4}-\d{2}-0002/)).toContainText('Expired');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0001/)).toContainText('Declined');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Declined' }).check({ force: true });
  await expect(listItem(page, /QT-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(listItem(page, /QT-\d{4}-\d{2}-0003/)).toHaveCount(0);
});

test("writes a quotation at the customer's prices, and makes it an order", async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await page.getByRole('button', { name: 'New quotation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New quotation' })).toBeVisible();
  await pickCustomer(page, 'aarong', /Aarong/);

  await addItem(page, 'crew-neck', 'Basic crew-neck T-shirt');
  await expect(line(page, 1).getByLabel('Price before VAT')).toHaveValue('290.00');
  await expect(line(page, 1).getByText('From their price list')).toBeVisible();
  await line(page, 1).getByLabel('Quantity').fill('100');

  // The mailer bags are sold by the piece at the product's price; in cartons the list has them
  await addItem(page, 'mailer', 'Poly mailer bag 10x14');
  await expect(line(page, 2).getByText('Product price')).toBeVisible();
  await line(page, 2).getByLabel('Unit').selectOption({ label: 'carton = 500 pcs' });
  await expect(line(page, 2).getByLabel('Price before VAT')).toHaveValue('2,750.00');
  await line(page, 2).getByLabel('Quantity').fill('2');
  await line(page, 2).getByLabel('Discount', { exact: true }).fill('5');

  // 100 × 290 + 2 × 2,750 − 5% = 34,225 before VAT; 15% VAT = 5,133.75
  await expect(page.getByText('৳34,225.00')).toBeVisible();
  await expect(page.getByText('৳5,133.75')).toBeVisible();
  await expect(page.getByText('৳39,358.75')).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Save quotation' }).click();
  await toastShown(page, /QT-\d{4}-\d{2}-0004 saved/);
  await expect(page.getByRole('heading', { level: 1, name: /QT-\d{4}-\d{2}-0004/ })).toBeVisible();

  await page.getByRole('button', { name: 'Make order' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New sales order' })).toBeVisible();
  await expect(line(page, 2).getByLabel('Quantity')).toHaveValue('2');
  // The quotation's customer stays: the order accepts that customer's offer
  await expect(page.getByRole('button', { name: 'Customer', exact: true })).toBeDisabled();
  await page.getByLabel('Send from').selectOption({ label: 'MAIN · Main store' });
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText(/SO-\d{4}-\d{2}-0002 confirmed/)).toBeVisible();

  await openFromNav(page, 'Quotations');
  await expect(listItem(page, /QT-\d{4}-\d{2}-0004/)).toContainText('Accepted');
});

test('marks an open quotation declined, and opens it again', async ({ page }) => {
  await openFromNav(page, 'Quotations');
  await listItem(page, /QT-\d{4}-\d{2}-0003/).click();
  await expect(page.getByRole('heading', { level: 1, name: /QT-\d{4}-\d{2}-0003/ })).toBeVisible();

  await page.getByRole('button', { name: 'Mark declined' }).click();
  await toastShown(page, /QT-\d{4}-\d{2}-0003 marked declined/);
  await expect(
    page.getByText('The customer said no. Open it again if they change their mind.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make order' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open again' }).click();
  await expect(page.getByText(/QT-\d{4}-\d{2}-0003 is open again/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make order' })).toBeVisible();
});
```

- **`addItem()` finds the picker row by the product's name.** The picker lists every product until the search
  settles (250 ms debounce). Clicking the first "Add" at once would add the wrong product.
- **The totals in the test are worked out by hand in the comment** (34,225 before VAT, 5,133.75 VAT). If the line
  arithmetic changes, this test says so in taka.
- **"Make order" opens the order form with the quotation's lines and customer.** The test checks that the
  customer box is disabled, then picks the warehouse (the garments workspace has three, so there is no default),
  confirms, and finds the quotation "Accepted" in the list.

### `e2e/sales-orders.e2e.ts` (new)

```ts
import { expect, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b in the mock garments workspace: SO-…-0001 is H&M's confirmed export order (5 dozen
// polo shirts in M and in L, nothing delivered yet), and Aarong has a draft order without a
// number. Numbers are given when an order is confirmed.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('lists the orders, and filters them by status and customer', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('H&M Hennes & Mauritz');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('Confirmed');
  await expect(listItem(page, /Aarong/)).toContainText('Draft');
  await expectNoSideScroll(page);

  await page.getByRole('radio', { name: 'Draft' }).check({ force: true });
  await expect(listItem(page, /Aarong/)).toBeVisible();
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toHaveCount(0);

  await page.getByRole('radio', { name: 'All' }).check({ force: true });
  await page.getByRole('button', { name: 'Customer', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search customers' }).fill('h&m');
  await page.getByRole('option', { name: /H&M/ }).click();
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toBeVisible();
  await expect(listItem(page, /Aarong/)).toHaveCount(0);
});

test('confirms a draft, and takes it back to draft with its number', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /Aarong/).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Draft order' })).toBeVisible();

  await page.getByRole('button', { name: 'Confirm order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 confirmed/);
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0002/ })).toBeVisible();
  await expect(page.getByText('Confirmed', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Back to draft' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Take SO-\d{4}-\d{2}-0002 back to draft/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to draft' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0002 is a draft again/);
  // A numbered draft is not deleted: the customer was given that number
  await expect(page.getByText(/This draft keeps its number SO-\d{4}-\d{2}-0002/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete draft' })).toHaveCount(0);
  await expectNoSideScroll(page);
});

test('cancels a confirmed order that delivered nothing', async ({ page }) => {
  await openFromNav(page, 'Sales orders');
  await listItem(page, /SO-\d{4}-\d{2}-0001/).click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('PO-HM-2026-1187')).toBeVisible();
  // Nothing went out yet: "Close" (stop delivering the rest) is for a partly delivered order
  await expect(page.getByRole('button', { name: 'Close order' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The order is called off.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0001 cancelled/);
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'New delivery' })).toHaveCount(0);
});
```

- **Back to draft keeps the number.** The test confirms the seeded draft (it gets SO-…-0002), takes it back, and
  checks the "keeps its number" hint and that "Delete draft" is gone.
- **Cancel is offered, Close is not**, for an order that delivered nothing. The deliveries test checks the
  opposite.

### `e2e/deliveries.e2e.ts` (new)

```ts
import { expect, type Page, test } from '@playwright/test';

import { expectNoSideScroll, listItem, openFromNav, toastShown } from './helpers.js';

// Step 15b: deliveries (challans) against the seeded confirmed orders. Garments: H&M's
// SO-…-0001, 5 dozen polo shirts in M and in L (Navy blue), from the Main store, which holds 120
// of each. Pharma: Lazz Pharma's SO-…-0001, 40 boxes of Napa (4,000 tablets); the batch that
// expires first, NP24090, holds only 3,000.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const line = (page: Page, number: number) =>
  page.getByRole('group', { name: `Line ${String(number)}` });

async function deliverOrder(page: Page, number: RegExp) {
  await openFromNav(page, 'Sales orders');
  await listItem(page, number).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
  await page.getByRole('button', { name: 'New delivery' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'New delivery' })).toBeVisible();
}

test('delivers part of an order, books its cost, and closes the rest', async ({ page }) => {
  // Promised, not delivered: shown next to what is on hand, nothing held
  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('ST-118-M-NAV');
  await expect(listItem(page, /Pique polo shirt/)).toContainText('60 pcs');

  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  // The form starts with what is left on the order, from the order's warehouse
  await expect(line(page, 1).getByText('Ordered 5 dozen')).toBeVisible();
  await expect(line(page, 2)).toBeVisible();
  await line(page, 2).getByRole('button', { name: 'Remove line 2' }).click();
  await page.getByLabel('Vehicle and driver (optional)').fill('Chatto Metro-Ta 14-2210, Rahim');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByRole('heading', { level: 1, name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Cost of goods sold at the moving average: 60 pieces at ৳410
  await expect(page.getByRole('link', { name: /JV-\d{4}-\d{2}-\d{4}/ })).toBeVisible();
  await expect(page.getByText('৳24,600.00').first()).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: /SO-\d{4}-\d{2}-0001/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /SO-\d{4}-\d{2}-0001/ })).toBeVisible();
  await expect(page.getByText('Partly delivered').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /DC-\d{4}-\d{2}-0001/ })).toBeVisible();
  // Something went out, so the order is closed, not cancelled
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close order' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close order' }).click();
  await toastShown(page, /SO-\d{4}-\d{2}-0001 closed/);
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();

  // 60 of the 120 left the Main store; the closed rest is no longer on order
  await openFromNav(page, 'Stock on hand');
  await page.getByRole('searchbox', { name: 'Search stock' }).fill('ST-118-M-NAV');
  await expect(listItem(page, /Pique polo shirt/)).toContainText('60 pcs');
  await expect(listItem(page, /Pique polo shirt/)).not.toContainText('120 pcs');
  await openFromNav(page, 'Deliveries');
  await expect(listItem(page, /DC-\d{4}-\d{2}-0001/)).toContainText('Posted');
});

test('refuses to deliver more than the order has left', async ({ page }) => {
  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  await line(page, 1).getByLabel('Quantity').fill('6');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await expect(
    line(page, 1).getByText('This is more than the order has left to deliver. Lower the quantity.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'New delivery' })).toBeVisible();
});

test('splits a delivery over batches, first expiry first', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch workspace' }).first().click();
  await page.getByRole('menuitemradio', { name: 'Karim Pharma' }).click();
  await toastShown(page, 'Switched to Karim Pharma');

  await deliverOrder(page, /SO-\d{4}-\d{2}-0001/);
  await expect(line(page, 1).getByText('Napa 500 mg')).toBeVisible();
  await line(page, 1).getByRole('button', { name: 'Split by first expiry' }).click();
  // 3,000 tablets from the batch that expires first, the other 1,000 from the next one
  await expect(line(page, 1).getByLabel('Quantity')).toHaveValue('3000');
  await expect(line(page, 2).getByLabel('Quantity')).toHaveValue('1000');
  await page.getByRole('button', { name: 'Post delivery' }).click();
  await toastShown(page, /DC-\d{4}-\d{2}-0001 posted/);
  await expect(page.getByText('NP24090').first()).toBeVisible();
  await expect(page.getByText('NP24117').first()).toBeVisible();

  // Everything on the order went out: the delivery finished it
  await openFromNav(page, 'Sales orders');
  await expect(listItem(page, /SO-\d{4}-\d{2}-0001/)).toContainText('Delivered');
});
```

- **The first test is the whole chain:** "On order" on the stock page, a delivery made from the order with one
  line removed, its cost of goods sold (60 pieces at the ৳410 opening cost = ৳24,600), "Partly delivered" on the
  order, Close, and the stock and the deliveries list afterwards.
- **The search `ST-118-M-NAV` is the variant's SKU**, so the stock list shows exactly one row.
- **The FEFO test switches to the pharmacy workspace** through the workspace menu, not with `page.goto`: a page load
  starts the mock again from its seeds.

### Check this part

```bash
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts quotations sales-orders deliveries
```

Build `@omnivo/ui` first: the app reads its built files, and the segmented control changed. The last line runs the
three new test files on both screen sizes (18 tests, about a minute). Part 15b.8 runs the whole suite once more.

> **What we checked in this part.** The app type-checks with no errors left (the `onOrder` error of 15b.6 is
> gone), and ESLint and Prettier are clean in `src/mocks`, `e2e` and the segmented control. The app's unit tests
> pass (52). All 132 end-to-end tests pass on desktop and phone, the 18 new ones included. One test was also
> checked by breaking the mock on purpose: without `checkOrderLines()` in the mock, "refuses to deliver more than
> the order has left" fails.

---

## 15b.8 — Root files, the OpenAPI document, and every check once

No root file changes: no new package, no new script, no new `.env` line. Generate the API document again and
commit it:

```bash
pnpm gen:openapi      # packages/contracts/openapi.json — 125 paths (111 before)
```

The 14 new paths are `/sales/price-lookup`, `/quotations` (list and create, one, plus `/decline` and `/reopen`),
`/sales-orders` (list and create, one, plus `/confirm`, `/reopen`, `/close` and `/cancel`) and `/deliveries`
(list and create, one, plus `/post`). `pnpm test:openapi` fails if the committed file and the routes disagree, so
a route added later without running this command is caught in CI.

The Drizzle snapshots (`migrations/meta/0027_snapshot.json`, `0028_snapshot.json`, `_journal.json`) are written by
`drizzle-kit generate`; commit them as they are.

Then run the whole checklist (at the end of this guide) once. Each part ran only its own package's checks; this is
the first time everything runs together. In the copy of the repo it found two things that the part checks could
not see, and both are fixed in the parts above:

- **`pnpm boundaries` found a circle of imports in the mock** (`no-circular`): `sales-data.ts` →
  `sales-document-data.ts` → `journal-data.ts` → `sales-data.ts`. No single part's check runs dependency-cruiser.
  The fix is in 15b.7: the customer delete walks the sales documents itself.
- **The role templates had no sales document permissions** (15b.3, decision 17). Nothing failed: a new workspace
  simply gave nobody but the owner the right to write a quotation. It was found by reading `templates.ts`, whose
  comment asks every module's step to add its permissions.

---

## 15b.9 — Doc updates

After you implement this (ask me and I can do these):

**CLAUDE.md** — under "Components". 15b.5 promised the discount box an entry: the design system lists every
control, and a control that is not listed there does not exist for the next screen. After "Money input":

> - **Discount input:** `DiscountInput` from `@omnivo/ui`, the money input's box with a number (right-aligned,
>   `tabular-nums`, 2 decimals) and a native `%` / `৳` select inside it on the right, after a 1px `line` divider,
>   13.5px/500 `ink-2` with an `ArrowDown01` icon. The select is the unit, so there is no `৳` prefix. The ring
>   shows while either part has the focus. The form value is a decimal string plus a type (`percent` | `amount`).

After "Line editor":

> - **Sales line editor (quotations, orders):** `SalesLinesEditor`, a card that is a container (`@container`) and
>   its own lazy chunk. The lines are one controlled form value (a `Controller` on `lines`), so two form types
>   share it. On a wide card (`@5xl`) item, unit, quantity, price, discount, VAT rate and amount share one grid
>   template with a caption header; on a narrow card each control shows its label. The price column says "Price
>   with VAT" or "Price before VAT" from the document's own setting. A new line shows where its price came from
>   under the box (12px `ink-3`: "From their price list", "Product price", "No price set: type one"). When a line
>   was priced for another customer, a text link at the top offers "Use this customer's prices on every line";
>   changing the customer never reprices by itself. Under the lines, a totals block on `subtle` (line discounts
>   only when there are any, before VAT, VAT, total at 500) with paisa, and on the left whether prices include VAT.
> - **Sales document statuses:** quotation Open (`brand`, `Clock01`), Accepted (`good`, `CheckmarkCircle02`),
>   Declined (neutral, `CancelCircle`), Expired (`warn`, `Hourglass`, worked out by the page: open and past its
>   date). Order Draft (neutral, `FileEdit`), Confirmed (`brand`, `Agreement01`), Partly delivered (`brand`,
>   `DeliveryTruck01`), Delivered (`good`, `PackageDelivered`), Closed (neutral, `StopCircle`), Cancelled (neutral,
>   `CancelCircle`), plus a second `warn` "Late" pill (`Time04`) for a confirmed order past its delivery date.
>   Delivery Draft (neutral, `FileEdit`), Posted (`good`, `CheckmarkCircle02`). Work in progress is `brand`, not
>   `warn`; `warn` is for something the person must act on.
> - **Document notice:** a line above a document that says what its state means and what to do next: radius
>   10px, 13.5px text, a 17px icon, `warn-bg` with `warn` text and an `Hourglass` icon for an offer that has ended,
>   `subtle` with `ink-2` text and an `InformationCircle` icon otherwise.

And in "Filter chips / segmented control", add one sentence at the end:

> With more options than fit (a sales order has six statuses), the control scrolls inside its own box on a
> phone; the page never scrolls sideways.

**build-plan.bn.md** — in the "ধাপ ১৫: Sales — চারটা গাইডে" block, replace the line that starts with
`**১৫b** quotation → order → delivery ·` with:

> **১৫b (quotation → order → delivery):** quotation (QT, save করলেই নম্বর; open/accepted/declined, মেয়াদ পেরোলে
> "Expired" — পেজ নিজে হিসাব করে), sales order (confirm করলে SO নম্বর; delivered/closed/cancelled), delivery challan
> (DC, post করলে স্টক বের হয়, একটা order কয়েক challan-এ; batch/serial, FEFO)। Delivery post করলেই moving average
> cost-এ Dr Cost of goods sold / Cr Inventory; স্টক hold হয় না, স্টক পেজে "On order"। লাইনের হিসাব (discount, তারপর
> VAT, লাইন ধরে paisa-তে round) contracts-এ, form-API-mock একই function; price lookup: কাস্টমারের price list → প্রোডাক্টের
> দাম। প্রিন্ট নেই (১৫c বা পরে)।
> **১৫c** invoice, payment, credit limit · **১৫d** return ও credit note।

**COMMANDS.md** — in "Look at the data", after the stock queries:

````markdown
```sh
# confirmed sales orders still waiting for goods, by delivery date (lines_left = goods lines not fully delivered)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, p.name AS customer, o.delivery_date, count(*) FILTER (WHERE l.delivered_quantity < l.base_quantity) AS lines_left FROM sales_orders o JOIN tenants t ON t.id = o.tenant_id JOIN parties p ON p.tenant_id = o.tenant_id AND p.id = o.customer_id JOIN sales_order_lines l ON l.tenant_id = o.tenant_id AND l.order_id = o.id JOIN products pr ON pr.tenant_id = l.tenant_id AND pr.id = l.product_id WHERE o.status = 'confirmed' AND pr.type = 'goods' GROUP BY t.slug, o.number, p.name, o.delivery_date ORDER BY o.delivery_date NULLS LAST"
# order lines delivered past what was ordered (should print nothing; the API refuses it under a lock)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, o.number, l.line_no, l.base_quantity, l.delivered_quantity FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id = l.tenant_id AND o.id = l.order_id JOIN tenants t ON t.id = l.tenant_id WHERE l.delivered_quantity > l.base_quantity"
# posted deliveries whose goods had a cost but no cost of goods sold entry (should print nothing)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, d.number, d.date FROM deliveries d JOIN tenants t ON t.id = d.tenant_id WHERE d.status = 'posted' AND EXISTS (SELECT 1 FROM delivery_lines l WHERE l.tenant_id = d.tenant_id AND l.delivery_id = d.id AND l.value > 0) AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.tenant_id = d.tenant_id AND e.source = 'sales_delivery' AND e.document_id = d.id)"
```
````

The three queries were run against a database migrated to 0028. The last two are checks, like step 14's: if one
of them ever prints a row, something wrote to the tables without going through the API.

---

## 15b.10 — Run it

```bash
pnpm install
pnpm db:migrate                               # 0027 + 0028: six tables, their rules, three permissions
pnpm gen:openapi                              # commit it
pnpm dev                                      # restart it: the API has new routes
```

In `pnpm db:psql`:

```sql
SELECT relname, relforcerowsecurity FROM pg_class
 WHERE relname IN ('quotations', 'quotation_lines', 'sales_orders', 'sales_order_lines', 'deliveries', 'delivery_lines');  -- t
SELECT key FROM permissions WHERE key LIKE 'sales.%' ORDER BY key;   -- six keys: 15a's three and 15b's three
```

### What you will see

1. **Your existing roles do not have the new permissions.** As the owner you have them all. For your team: Roles
   → Sales → tick "Write, edit, decline and delete quotations" and "Write, confirm, reopen, close and cancel sales
   orders" for the people who sell, and "Write and post deliveries (delivery challans), which take stock out" for
   the store keeper.
2. **Settings → Numbering** has two new series: Quotation (`QT`) and Delivery challan (`DC`).
3. **Sales → Quotations → New quotation**: pick a customer, **Add items**, search a product, **Add**. Every variant
   comes in its selling unit, priced from the customer's list ("From their price list") or the product. Give one
   line a 10% discount; the totals show the line discounts, the VAT and the total in paisa. **Save**: `QT-…-0001`.
4. **Make order** on the quotation: the order form has its lines and customer (the customer box is locked). Pick
   the warehouse, type the buyer's PO number, **Confirm order**: `SO-…-0001`. The quotation now says "Accepted".
5. **Inventory → Stock**: the "On order" column shows what the order is waiting for; "On hand" has not changed.
6. **New delivery** on the order: the challan has what is left on each line. Remove a line, pick batches with
   "Split by first expiry" if the product has them, **Post delivery**: `DC-…-0001`. The order says "Partly
   delivered", and its deliveries card lists the challan.
7. **Accounting → Journal**: an entry "Delivery DC-…", Dr Cost of goods sold / Cr Inventory, at the average cost.
   Its document link opens the challan, and so does the stock card's row.
8. **Close order** on the order: the rest is dropped, and "On order" goes back to zero for it.
9. **Bangla** and **390px**: the line editor stacks each line's controls with their labels, the lists become
   cards, and no page scrolls sideways.

---

## Checklist

```bash
pnpm dedupe --check
pnpm lint
pnpm format
pnpm typecheck
pnpm test                    # 287: contracts 122 + api 76 + app 52 + ui 19 + i18n 11 + auth 7
pnpm test:integration        # 278 — 22 new
pnpm test:tenant-leak        # 55 — 5 new
pnpm test:e2e                # 132: 66 flows × desktop and 390px
pnpm build
pnpm test:bundle-size        # first load 188.9 KB gz; quotation form 88.0, order form 92.0, delivery form 86.4
pnpm test:openapi
pnpm boundaries
```

## What we found on the way

All of these are fixed in the guide — if you get stuck at the same place, you will recognise it:

- **Zod 4 runs every check on a string, even after one failed.** An empty price box got two errors, and the form
  showed the wrong one. `requiredPriceSchema` uses two `.refine()` calls, so each box gets one error (15b.1).
- **Zod 4 also runs a document's own rule when a field failed** (the order's delivery date next to a bad line).
  Good for the person, who sees every mistake at once, but the rule must not assume the fields are valid (15b.1).
- **The migration's foreign keys came before their indexes** (15b.2). The seventh step in a row: `drizzle-kit`
  always writes them in this order.
- **A sales line did not say whether it was a service** (15b.6). The order page must skip services when it counts
  what is delivered, and the delivery form must not offer them. `productType` was added to the contract's line,
  and the API sends it (15b.1 and 15b.3 show the final code).
- **Two old pages went over the 100 KB budget without being touched** (15b.6). Every page shares the contracts'
  `routes` chunk, and the three new documents' schemas made it bigger: the journal list and the revaluation form
  went from 99.7 to 101.4 KB. Their date pickers now load lazily.
- **The quotation form was 110 KB** with the line editor inside it (`decimal.js` alone is about 13 KB). The editor
  is its own lazy chunk; the delivery form also loads its customer box and date picker lazily, because it stood
  at 99.4 KB (15b.6).
- **The sales order list scrolled sideways on a phone**: six status options do not fit 390px. The shared
  `SegmentedControl` now scrolls inside its own box (15b.7).
- **A circle of imports in the mock** (15b.8): the customer delete asked `sales-document-data.ts`, which already
  depends on `sales-data.ts` through the journal. Only `pnpm boundaries` sees it.
- **New workspaces gave the new permissions to nobody** (15b.8, decision 17).
- **No bug in the API was found by its tests** (15b.4): every failure while writing them was in the test itself.
  The two "break it on purpose" checks show the tests can fail.

---

## Notes left for later steps

**Step 15c (invoice, payment, credit limit):**

- **An invoice prices a challan.** A delivery has no prices (decision 12); the invoice takes its lines from the
  delivery's order lines (price, discount, VAT snapshot) or, without an order, from the price lookup. Call
  `lineAmounts()` and `documentTotals()` from the contracts, never your own arithmetic.
- **The invoice books only the sale**: Dr Accounts receivable (with the customer, 15a's party rule) / Cr Sales /
  Cr VAT payable. The cost of goods sold was booked by the delivery (decision 1). A direct invoice that also
  delivers (step 15's flexible chain) must post a delivery in the same transaction, so the cost is booked once.
- **What is invoiced, per order line**, needs its own column (like `delivered_quantity`), or a challan can be
  billed twice.
- **The print layout** (decision 4): one layout for quotation, order, challan and invoice. The documents already
  keep the address text and each line's description and VAT snapshot, so a print never reads today's data.
- **The bundle budget**: `year-end.tsx` is at 99.2 KB, the journal entry form at 97.9 KB and the opening balances
  at 96.7 KB. 15c's contracts will grow the shared `routes` chunk again; split those pages first (the lazy date
  picker pattern of `date-input.tsx`).

**Step 15d (returns and credit notes):**

- **A return is probably a stock movement in** at the cost the goods left with (the delivery line's `value` ÷ its base
  quantity), not today's average, and it reverses that part of the cost of goods sold.
- **The order's `delivered_quantity` does not go down** on a return: the order was delivered; the return is a new
  event. Say so on the screen.

**Notes for any step:**

- **Run `pnpm boundaries` while building, not only at the end**: no package's own check runs it, and an import
  circle shows up only there.
- **A module's role-template permissions** are part of its step. Check `apps/api/src/setup/templates.ts` whenever
  a step adds a permission.
