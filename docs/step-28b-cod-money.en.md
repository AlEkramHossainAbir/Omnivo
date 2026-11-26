# Step 28b: Courier automation, part 2 — the courier's COD money, partial deliveries and returns

> The implementation guide for "Phase 10 → Step 28", the second part, of [build-plan.bn.md](build-plan.bn.md).
> Step 28 now has four parts (decision 1):
>
> - **28a (done):** courier accounts, booking a packed order's parcel, the courier's news by webhook and by poll.
>   Guide: [step-28a-couriers.en.md](step-28a-couriers.en.md).
> - **28b (this guide):** a COD account for each courier account, a money receipt into it at Delivered, what the
>   rider really collected, a partly delivered order, and a parcel that came back.
> - **28c:** the courier's payout: a document that takes the COD money out of the courier's account into the bank,
>   with the courier's charges on their own line, and matching the courier's payout CSV.
> - **28d:** Pathao, which needs the address as its own city, zone and area.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `3c4bc93`, "courier
> automation") and checked on 2026-11-24: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, the three ESLint runs,
> `pnpm typecheck`, `pnpm test` (1,628, of them 692 in `packages/contracts`, 274 in `apps/shop`, 246 in `apps/api` and
> 247 in `apps/app`), `pnpm test:integration` (920 in 53 files; two COD tests failed on the first run because one of
> them had vitest's 5-second limit, fixed in 28b.8, and the file then passed alone: 15 of 15) and
> `pnpm test:tenant-leak` (193 in 27 files) on Testcontainers, `pnpm boundaries`, `pnpm test:openapi`,
> `pnpm test:bundle-size` (first load 251.0 KB gz, budget now 255; the shop order page 134.9 KB, the dialogs of what
> came back 141.3 KB, Shop couriers 135.4 KB, budget 155), the app's Playwright suite on a computer and on a phone
> (469 passed and 3 skipped on purpose; 30 timed out while the machine was busy, in files all over the app, and all
> 30 passed when run again on one worker, on both projects), the PWA tests (4) and the shop's Playwright suite (50
> passed, 2 skipped). Then the whole way ran on the real API with the fake courier (28b.8). The real Steadfast API was
> not called: there is no test account (see "Try it").

## Goal

🏷️ **The cash the rider collects lands in the books by itself, in the courier's own account.** Until now a
delivered shop order posts an unpaid invoice, and someone types a money receipt when the courier's payout arrives,
often days later and for many parcels at once. Nobody can say how much of the shop's money each courier holds. After
28b each courier account names a COD account ("Cash with Steadfast"). When the courier says a parcel was delivered,
the invoice is posted and a money receipt for what the rider collected goes into that account, paying the invoice at
once. The account's balance is what the courier owes the shop, and the Shop couriers page shows it per account. A
shopper who keeps only part of the parcel, or sends all of it back, is recorded by a member once the goods are on
the shelf: a sales return of what came back, then the invoice of the rest, or the order Returned. The courier's
payout itself is 28c.

## Decisions

Agreed with the user on 2026-11-24 (all twelve as recommended):

1. **Four guides.** 28b the COD money at the door, partly delivered and returned; 28c the payout and CSV matching;
   28d Pathao.
2. **A COD account per courier account:** an account that holds money, picked on the courier account. Empty means no
   automatic receipt, as before. The design's "Dr COD receivable / Cr AR at Shipped" does not fit our flow: the
   invoice (and so the receivable) comes at Delivered, not at Shipped. A money account per courier also shows in the
   trial balance and the ledger what each courier holds, with no new posting code.
3. **A charge account per courier account:** an active expense account for the courier's charges, used by the payout
   in 28c.
4. **A posted money receipt at Delivered,** into the COD account, applied to the invoice, with a new method `courier`
   ("Courier COD"). In a savepoint, so a receipt that fails never loses the courier's news; the order then needs
   attention and has "Make the receipt". "Mark delivered" by hand does the same.
5. **What the rider collected and the courier's charge are kept on the parcel,** from the courier's notice
   (Steadfast's `cod_amount` and `delivery_charge`). The receipt is for what was collected, else the parcel's
   `codAmount`. A manual parcel's Delivered asks for the amount, starting with `codAmount`.
6. **Partly delivered:** the order stays Shipped with a notice. Once the goods are back, a member records what came
   back: a sales return of those lines before the invoice (15d's "return before billing"), then the invoice of the
   rest and the delivery charge, then the COD receipt. A difference stays on the invoice as owed or as an advance.
7. **Returned:** the courier's word only marks the parcel. "Receive the return" by a member makes a sales return of
   the whole challan, closes the sales order, moves the order to Returned and texts the shopper. Stock never comes
   back on the courier's word alone: a parcel lost on the way would come back into stock.
8. **The courier's return charge** is an expense, recorded with the payout in 28c. 28b posts nothing for it.
9. **The payout document (28c):** its lines are parcels; Dr bank (net) and Dr courier charges / Cr COD account;
   posted when saved, voided like a receipt; never below zero; a new permission `storefront.payout.manage`.
10. **CSV matching (28c):** a column-mapping step with a Steadfast preset, saved per account; unmatched, already paid
    and different rows listed apart; a payout by ticking parcels works too. No Steadfast payout file was available,
    so the preset is a guess from Steadfast's documentation.
11. **Orders delivered before 28b stay as they are.** A payout takes only parcels whose receipt went into the COD
    account.
12. **The Shop couriers page says what each courier holds:** "Holds ৳45,200 · 18 parcels".

Mine, made while writing (each says why where it is used):

13. **`courier` is a receipt's method only** (`RECEIPT_METHODS`), not one of `PAYMENT_METHODS`. Refunds, supplier
    payments and the receipt form share `PAYMENT_METHODS`, and none of them should offer "by courier".
14. **The COD receipt belongs to the parcel,** not to the order: the payout's line is a parcel (28c), and an order can
    have more than one parcel. Its error sits on the parcel too.
15. **What was collected is never more than the parcel's `codAmount`,** the amount the courier was told to collect.
    Zero is allowed and makes no receipt.
16. **"Record what came back" sends only the lines that came back.** None is refused (that is Mark delivered), and
    every piece is refused (that is Receive the return), each with its own words.
17. **Delivered, what came back and the COD receipt are their own route group,** `storefrontOrderDeliveryRoutes`.
    With them in the order's group, TypeScript cannot write the group's type (TS7056): every route repeats the
    order's answer, which grew in 28b. So Delivered's address in the app's client moves to
    `storefrontOrderDeliveries`.
18. **A Returned tab, and the newest parcel's status on the list,** so the Shipped tab can show which orders wait for
    the staff (partly delivered, coming back, returned).
19. **A new bell, `storefront.cod_receipt_failed`:** the courier's news delivered the order with nobody watching, so
    a receipt that fails must ring (§14.6: never fail quietly).
20. **The courier account's two account fields have no default** in the form's input: a page from before 28b that
    saves would otherwise clear them without anyone seeing.

## 28b.1 — Contracts

What both sides must agree on before any code makes a COD receipt: the courier account's two accounts and what the
courier holds, what a parcel keeps of the rider's money, Delivered with the collected amount, what came back, the
receipt's new method, the error codes, audit actions, the bell and their words.

### The courier account's money

```diff
@@ -102,8 +102,9 @@ export const storefrontPaymentGatewaySchema = z.object({
 });
 export type StorefrontPaymentGateway = z.infer<typeof storefrontPaymentGatewaySchema>;
 
-// An account the selects offer, "1150 · SSLCommerz merchant balance"
-const accountChoiceSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
+// An account the selects offer, "1150 · SSLCommerz merchant balance". Step 28b: exported, for the
+// courier account's two selects (shipping.ts), which storefront.manage fills the same way
+export const accountChoiceSchema = z.object({ id: z.uuid(), code: z.string(), name: z.string() });
 export type StorefrontAccountChoice = z.infer<typeof accountChoiceSchema>;
 
 // The Payment card's one read: the saved account (null before the first save) and what the two
```

```diff
@@ -3,8 +3,11 @@ import { z } from 'zod';
 import { ERROR_CODES, errorCode } from './errors.js';
 import { versionSchema } from './fields.js';
 import { defineRoute } from './http.js';
+import { priceSchema } from './money.js';
+import { documentRefSchema } from './sales.js';
 import { optionalIdSchema } from './stock.js';
 import { SHOP_COURIERS, SHOP_SHIPMENT_STATUSES } from './storefront.js';
+import { accountChoiceSchema } from './storefront-payments.js';
 
 // Step 28a: couriers (system design §14.6). The shop's own courier accounts, as the ERP's
 // Storefront → Shop couriers page reads and saves them, and the parcels a shop order is sent in.
@@ -55,15 +58,30 @@ const courierKeySchema = z
   .max(200, errorCode('too_long'))
   .regex(/^[A-Za-z0-9_-]*$/, errorCode('courier_key_format'));
 
+// Step 28b: the two accounts of the courier's money, the same for both providers (a courier booked
+// by hand collects COD too):
+// - codAccountId (decision 2): where the rider's cash waits until the courier pays it out, an
+//   account that holds money ("Cash with Steadfast", under the current assets). Delivered posts a
+//   money receipt into it, so its balance is what this courier owes the shop. '' = none: the cash
+//   is a money receipt typed by hand, as before 28b
+// - chargeAccountId (decision 3): the expense account the courier's charges go to when it pays out
+//   (step 28c). '' = none yet; nothing in 28b posts to it
+// Whether each is an active account of the right kind only the API knows (the chart is not in the
+// form): courier_cod_account_invalid and courier_charge_account_invalid
+const courierMoneyFieldsSchema = z.object({
+  codAccountId: optionalIdSchema,
+  chargeAccountId: optionalIdSchema,
+});
+
 // The first save needs both keys; a later one keeps a saved key when its box is empty. The form
 // of a manual account has no keys at all: there is nothing to call
-const steadfastCreateSchema = z.object({
+const steadfastCreateSchema = courierMoneyFieldsSchema.extend({
   provider: z.literal('steadfast'),
   name: accountNameSchema,
   apiKey: courierKeySchema.min(1, errorCode('courier_key_required')),
   secretKey: courierKeySchema.min(1, errorCode('courier_key_required')),
 });
-const manualCreateSchema = z.object({
+const manualCreateSchema = courierMoneyFieldsSchema.extend({
   provider: z.literal('manual'),
   name: accountNameSchema,
   // Whose website the shop books on. The select's "Pick a courier" sends '', which is this error
@@ -118,6 +136,17 @@ export const courierAccountSchema = z.object({
       problem: z.enum(COURIER_TEST_PROBLEMS).nullable(),
     })
     .nullable(),
+  // Step 28b: the two accounts above, as saved. A saved one may have been archived since: the
+  // form then starts its select empty with the error shown, like the payment gateway's card
+  codAccountId: z.uuid().nullable(),
+  chargeAccountId: z.uuid().nullable(),
+  // Step 28b (decision 12): what this courier holds of the shop's money now, the page's "Holds
+  // ৳45,200 · 18 parcels": the parcels whose COD receipt went into the COD account and that no
+  // payout has taken yet (28c). The sum of what the riders collected, with paisa
+  holds: z.object({
+    amount: z.string(),
+    parcels: z.number().int().min(0),
+  }),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
 });
@@ -135,9 +164,14 @@ export type CourierAccountSaved = z.infer<typeof courierAccountSavedSchema>;
 // The page's one read: every account, archived ones too (the page has an Active / Archived
 // control), and the default. The default is what the Packed dialog starts with (decision 2): with
 // none, it starts at "Don't book now", so a shop with its own riders works as before
+// Step 28b: and what the two account selects offer, here for the same reason as the payment
+// gateway's (storefront.manage does not read the chart of accounts): the active accounts that hold
+// money, and the active expense accounts, neither a group, "1160 · Cash with Steadfast"
 export const courierSetupSchema = z.object({
   accounts: z.array(courierAccountSchema),
   defaultAccountId: z.uuid().nullable(),
+  codAccounts: z.array(accountChoiceSchema),
+  chargeAccounts: z.array(accountChoiceSchema),
 });
 export type CourierSetup = z.infer<typeof courierSetupSchema>;
 
@@ -192,12 +226,25 @@ export const shipmentEventSchema = z.object({
   note: z.string().nullable(),
 });
 
+// Step 28b: what the rider collected, as the courier says it (Steadfast's cod_amount) or a member
+// types it at Delivered: a shop amount, so whole paisa. '' = not typed: the API takes what the
+// courier said, else the parcel's codAmount. Zero is real: a shopper who paid nothing at the door
+// (a partial delivery of what was paid online, say). At most the parcel's codAmount, which only
+// the API knows (storefront_order_collected_over)
+export const collectedAmountSchema = priceSchema.refine(
+  (value) => value === null || /^\d+(?:\.\d{1,2})?$/.test(value),
+  errorCode('money_format'),
+);
+
 export const storefrontShipmentSchema = z.object({
   id: z.uuid(),
   account: z.object({
     id: z.uuid(),
     name: z.string(),
     provider: z.enum(COURIER_PROVIDERS),
+    // Step 28b: the account has a COD account, so Delivered makes the COD receipt (decision 4).
+    // The Delivered and partly delivered dialogs ask what the rider collected only then
+    hasCodAccount: z.boolean(),
   }),
   courier: z.enum(SHOP_COURIERS),
   status: z.enum(SHIPMENT_STATUSES),
@@ -208,6 +255,18 @@ export const storefrontShipmentSchema = z.object({
   // What the rider collects: the order's total less what was paid online, fixed when it was
   // booked (the courier was told this amount)
   codAmount: z.string(),
+  // Step 28b (decision 5): what the rider really collected and what the courier charges for the
+  // parcel, as its notice said (Steadfast's cod_amount and delivery_charge), with paisa. A partial
+  // delivery collects less than codAmount. null until the courier says, or for a manual parcel
+  // until Delivered (collected) and the payout (the charge, step 28c)
+  collectedAmount: z.string().nullable(),
+  courierCharge: z.string().nullable(),
+  // Step 28b (decision 4): the COD receipt Delivered made for collectedAmount, into the account's
+  // COD account. null before Delivered, with no COD account, for nothing collected, or while it
+  // could not be made: then receiptError says why ("receipt_account_invalid": the COD account was
+  // archived since), the order needs attention, and the page has "Make the receipt"
+  receipt: documentRefSchema.nullable(),
+  receiptError: z.enum(ERROR_CODES).nullable(),
   // When the courier gave it a tracking code. null while booking
   bookedAt: z.iso.datetime().nullable(),
   // Calls made to book it, and why the last one failed (courier_rejected_parcel: the courier said
@@ -287,6 +346,11 @@ export const steadfastWebhookSchema = z.looseObject({
   consignment_id: z.union([z.string(), z.number()]).optional(),
   invoice: z.string().optional(),
   status: z.string().optional(),
+  // Step 28b: on delivery_status, what the rider collected and Steadfast's charge for the parcel
+  // (decision 5). Numbers in Steadfast's documentation ("cod_amount": 1500.00); a string too, since
+  // a courier's JSON is not ours to trust. The adapter reads them as money or not at all
+  cod_amount: z.union([z.number(), z.string()]).optional(),
+  delivery_charge: z.union([z.number(), z.string()]).optional(),
   tracking_message: z.string().optional(),
   updated_at: z.string().optional(),
 });
```

Why each part is written this way:

- **`accountChoiceSchema` is exported** from the payment gateway's file, and the courier setup uses the same shape.
  The selects are filled by the courier page's own read, not by the chart of accounts: `storefront.manage` does not
  read the chart (27d's reason).
- **`courierMoneyFieldsSchema` is shared by both providers** (decision 2). A manual courier collects cash at the door
  too, so a shop that books Pathao by hand gets the same COD receipt.
- **Both fields are `optionalIdSchema` with no `.default()`** (decision 20). `''` means none and becomes `null`.
  Whether a picked account is active and of the right kind needs the chart, so only the API checks it, with
  `courier_cod_account_invalid` and `courier_charge_account_invalid`.
- **The saved account has the two ids, not their names.** The form's selects have the names already; a saved id
  that the select no longer offers (an archived account) starts the select empty with its error, like 27d's card.
- **`holds`** (decision 12) is worked out by the API from the parcels whose COD receipt went into the COD account and
  that no payout took yet. It is a sum of what the riders collected, with paisa.
- **`collectedAmountSchema` is `priceSchema` with a paisa rule.** An empty box is `null` ("not typed": the API then
  takes what the courier said, else `codAmount`), zero is a real amount, and more than two decimals is refused: a
  shop amount has whole paisa. Whether it is over `codAmount` only the API knows (decision 15).
- **`hasCodAccount` on the parcel's account** tells the Delivered and partly delivered dialogs whether to ask what
  was collected at all. Without a COD account no receipt is made, so the box would mean nothing.
- **`collectedAmount` and `courierCharge`** (decision 5) are what the courier's notice said, kept on the parcel.
  `courierCharge` is read now and used by the payout (28c).
- **`receipt` and `receiptError` on the parcel** (decision 14), the same pair as 27d's payment try, so the order page
  shows the error with "Make the receipt" in the same way.
- **Steadfast's webhook gains `cod_amount` and `delivery_charge`.** Steadfast's documentation shows them as numbers
  (`"cod_amount": 1500.00`); the union takes a string too, because a courier's JSON is not ours to trust. The schema
  stays loose (28a's decision 22).

### The receipt's method

```diff
@@ -42,6 +42,14 @@ export const PAYMENT_METHODS = [
 ] as const;
 export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
 
+// Step 28b (decision 4): a receipt's method may also be `courier`, the cash a courier's rider
+// collected at the door. Only Delivered on a shop order makes one (into the courier account's COD
+// account), so the receipt's own form never offers it (receiptInputSchema keeps PAYMENT_METHODS),
+// and neither do refunds and supplier payments, which share PAYMENT_METHODS: money never goes back
+// to a shopper, or out to a supplier, "by courier". A receipt read from the API may say it
+export const RECEIPT_METHODS = [...PAYMENT_METHODS, 'courier'] as const;
+export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];
+
 // What is left of a receipt's (or a credit note's) money to apply or to pay back: the amount less
 // what is applied to invoices and what refunds paid back (step 15d)
 export function unappliedOf(money: { amount: string; applied: string; refunded: string }): string {
@@ -79,7 +87,7 @@ export const receiptSummarySchema = z.object({
   // unappliedOf() is what is left.
   applied: z.string(),
   refunded: z.string(),
-  method: z.enum(PAYMENT_METHODS),
+  method: z.enum(RECEIPT_METHODS),
   // The cheque number, the bKash TrxID, the bank's transfer reference
   reference: z.string().nullable(),
   // The money account it went into (accounts.ts → moneyAccountIds)
```

- **`RECEIPT_METHODS` adds `courier` to `PAYMENT_METHODS`** (decision 13). A receipt read from the API may say it, so
  `receiptSummarySchema.method` uses it. `receiptInputSchema` keeps `PAYMENT_METHODS`: the receipt form never offers
  it, and only a shop order's Delivered writes one.

### The order's moves at the door

```diff
@@ -9,11 +9,18 @@ import { quantitySchema } from './quantities.js';
 import { documentRefSchema } from './sales.js';
 import {
   bookShipmentInputSchema,
+  collectedAmountSchema,
   courierChoicesSchema,
   courierExportSchema,
+  SHIPMENT_STATUSES,
   storefrontShipmentSchema,
 } from './shipping.js';
-import { MAX_SERIALS_PER_LINE, optionalIdSchema, serialNumberSchema } from './stock.js';
+import {
+  MAX_SERIALS_PER_LINE,
+  MAX_STOCK_LINES,
+  optionalIdSchema,
+  serialNumberSchema,
+} from './stock.js';
 import { storefrontImageViewSchema } from './storefront-admin.js';
 import {
   SHOP_CART_MAX_LINES,
@@ -42,14 +49,15 @@ export const STOREFRONT_ORDER_STATUSES = SHOP_ORDER_STATUSES.filter(
 );
 export type StorefrontOrderStatus = (typeof STOREFRONT_ORDER_STATUSES)[number];
 
-// The list's tabs. "New" is a confirmed order: nobody has packed it yet. Returned has no tab until
-// step 28 brings the courier's returns; it shows under All
+// The list's tabs. "New" is a confirmed order: nobody has packed it yet. Step 28b: Returned has its
+// own tab now that an order can get there (Receive the return), after Cancelled
 export const STOREFRONT_ORDER_VIEWS = [
   'confirmed',
   'packed',
   'shipped',
   'delivered',
   'cancelled',
+  'returned',
   'all',
 ] as const;
 export type StorefrontOrderView = (typeof STOREFRONT_ORDER_VIEWS)[number];
@@ -81,8 +89,13 @@ export const storefrontOrderSummarySchema = z.object({
   itemCount: z.number().int().min(1),
   total: z.string(),
   // The sales order could not be made (decision 1), or (step 28a) its parcel's booking failed five
-  // times: the list shows a crit "Needs attention" pill
+  // times, or (step 28b) its COD receipt could not be made: the list shows a crit "Needs
+  // attention" pill
   needsAttention: z.boolean(),
+  // Step 28b: where the order's newest parcel is, so the Shipped tab can say which orders wait for
+  // the staff: a partly delivered or returned parcel needs "Record what came back" or "Receive the
+  // return" on the order's page. null: no parcel
+  parcelStatus: z.enum(SHIPMENT_STATUSES).nullable(),
 });
 export type StorefrontOrderSummary = z.infer<typeof storefrontOrderSummarySchema>;
 
@@ -165,6 +178,8 @@ export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
   salesOrder: documentRefSchema.nullable(),
   delivery: documentRefSchema.nullable(),
   invoice: documentRefSchema.nullable(),
+  // The sales return of a cancelled packed order (27b); step 28b: also of a returned order (the
+  // whole challan) and of a partly delivered one (what came back, made before its invoice)
   salesReturn: documentRefSchema.nullable(),
   // Why the sales order could not be made (decision 1): the error the sales order's own rules
   // gave ("sales_variant_archived"). The page shows it with "Make the sales order"
@@ -294,10 +309,118 @@ export const packStorefrontOrderInputSchema = z
 export type PackStorefrontOrderInput = z.infer<typeof packStorefrontOrderInputSchema>;
 export type PackStorefrontOrderFormValues = z.input<typeof packStorefrontOrderInputSchema>;
 
-// Shipped, Delivered and "Make the sales order": the version is all they need
+// Shipped and "Make the sales order": the version is all they need
 export const storefrontOrderVersionInputSchema = z.object({ version: versionSchema });
 export type StorefrontOrderVersionInput = z.infer<typeof storefrontOrderVersionInputSchema>;
 
+// Delivered. Step 28b (decision 5): and what the rider collected, for the COD receipt, when the
+// parcel's account has a COD account (the dialog asks only then, starting with what the courier
+// said). '' or left out = what the courier said, else the parcel's codAmount, so a page loaded
+// before 28b delivers as before
+export const deliverStorefrontOrderInputSchema = z.object({
+  version: versionSchema,
+  collectedAmount: collectedAmountSchema.default(null),
+});
+export type DeliverStorefrontOrderInput = z.infer<typeof deliverStorefrontOrderInputSchema>;
+export type DeliverStorefrontOrderFormValues = z.input<typeof deliverStorefrontOrderInputSchema>;
+
+// ---------------------------------------------------------------------------------------------
+// Step 28b: what came back (decisions 6 and 7)
+
+// What the "Record what came back" dialog opens with: the challan's lines, one row per batch (a
+// line packed from two batches is two rows), each with what it took and its serial numbers. The
+// goods go back into the warehouse they left from, at what they cost (15d's rule)
+export const storefrontReturnPlanSchema = z.object({
+  warehouse: z.object({ id: z.uuid(), name: z.string() }),
+  lines: z.array(
+    z.object({
+      deliveryLineId: z.uuid(),
+      position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
+      name: z.string(),
+      packSize: z.string(),
+      sku: z.string(),
+      unitCode: z.string(),
+      // What the challan line took, in the base unit
+      quantity: z.string(),
+      tracking: z.enum(TRACKING_MODES),
+      batch: z.object({ lotNumber: z.string(), expiresOn: z.iso.date().nullable() }).nullable(),
+      // The pieces in the box, for a serial product: the member ticks the ones that came back
+      serialNumbers: z.array(z.string()),
+    }),
+  ),
+});
+export type StorefrontReturnPlan = z.infer<typeof storefrontReturnPlanSchema>;
+
+// One challan line that came back, whole or in part. A serial product names its pieces, and the
+// quantity is their count (15d's returnLineRules, which the sales return runs again)
+const cameBackLineInputSchema = z.object({
+  deliveryLineId: z.uuid(),
+  quantity: quantitySchema,
+  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
+});
+
+// "Record what came back" on a shipped order the shopper kept part of (decision 6): a sales return
+// of these lines before the invoice, then the invoice of the rest and the delivery charge, then the
+// COD receipt for what was collected, in one transaction: the order is Delivered. Only the lines
+// that came back are sent; none is storefront_order_return_nothing (that is Mark delivered), and
+// every piece is storefront_order_return_everything (that is Receive the return), which only the
+// API can tell: it has the challan
+export const partlyDeliverStorefrontOrderInputSchema = z
+  .object({
+    version: versionSchema,
+    lines: z
+      .array(cameBackLineInputSchema)
+      .min(1, errorCode('storefront_order_return_nothing'))
+      .max(MAX_STOCK_LINES),
+    collectedAmount: collectedAmountSchema.default(null),
+    // Why it came back ("Wrong size"), kept on the sales return's note for the staff
+    reason: optionalText(200),
+  })
+  .superRefine((input, ctx) => {
+    // A challan line once, and a serial number once, as on a sales return (its own rules say the
+    // same again in the API; here the error lands on the dialog's box)
+    const lines = new Set<string>();
+    const serials = new Set<string>();
+    input.lines.forEach((line, lineIndex) => {
+      if (lines.has(line.deliveryLineId)) {
+        ctx.addIssue({
+          code: 'custom',
+          path: ['lines', lineIndex, 'deliveryLineId'],
+          message: errorCode('return_line_twice'),
+        });
+      }
+      lines.add(line.deliveryLineId);
+      line.serialNumbers.forEach((serial, serialIndex) => {
+        if (serials.has(serial)) {
+          ctx.addIssue({
+            code: 'custom',
+            path: ['lines', lineIndex, 'serialNumbers', serialIndex],
+            message: errorCode('stock_serial_twice'),
+          });
+        }
+        serials.add(serial);
+      });
+    });
+  });
+export type PartlyDeliverStorefrontOrderInput = z.infer<
+  typeof partlyDeliverStorefrontOrderInputSchema
+>;
+export type PartlyDeliverStorefrontOrderFormValues = z.input<
+  typeof partlyDeliverStorefrontOrderInputSchema
+>;
+
+// "Receive the return" (decision 7): the whole parcel is back in the shop. A sales return of the
+// whole challan, the sales order closed, the order Returned and the shopper's SMS. The member
+// presses it once the goods are on the shelf, never the courier's news alone: a parcel lost on the
+// way must not come back into stock
+export const returnStorefrontOrderInputSchema = z.object({
+  version: versionSchema,
+  // Why it came back ("Customer refused the parcel"), for the staff only, like a cancel's reason
+  reason: optionalText(200),
+});
+export type ReturnStorefrontOrderInput = z.infer<typeof returnStorefrontOrderInputSchema>;
+export type ReturnStorefrontOrderFormValues = z.input<typeof returnStorefrontOrderInputSchema>;
+
 // Cancel (decision 8): a reason is kept on the order for the staff, never sent to the shopper
 export const cancelStorefrontOrderInputSchema = z.object({
   version: versionSchema,
@@ -410,17 +533,6 @@ export const storefrontOrderRoutes = {
     body: storefrontOrderVersionInputSchema,
     response: storefrontOrderSchema,
   }),
-  deliverOrder: defineRoute({
-    method: 'POST',
-    path: '/storefront/orders/:id/deliver',
-    summary: 'Delivered: post the invoice for the challan and the delivery charge',
-    auth: 'bearer',
-    permission: 'storefront.order.manage',
-    status: 200,
-    params: idParamsSchema,
-    body: storefrontOrderVersionInputSchema,
-    response: storefrontOrderSchema,
-  }),
   // Step 27d: "Make the receipt", after the receipt of a paid try could not be made
   makePaymentReceipt: defineRoute({
     method: 'POST',
@@ -461,7 +573,8 @@ export const storefrontOrderRoutes = {
   }),
   // Step 28a: a booked parcel nobody has picked up yet is cancelled with the order (the API asks
   // the courier to cancel it, or says to cancel it on the courier's panel); once the courier has
-  // it, the order is refused (storefront_order_parcel_on_its_way): it comes back as a return (28b)
+  // it, the order is refused (storefront_order_parcel_on_its_way): it comes back as a return
+  // (step 28b's returnOrder)
   cancelOrder: defineRoute({
     method: 'POST',
     path: '/storefront/orders/:id/cancel',
@@ -474,3 +587,70 @@ export const storefrontOrderRoutes = {
     response: storefrontOrderSchema,
   }),
 };
+
+// Step 28b: the moves at the shopper's door, a group of their own: Delivered (27b, which 28b gives
+// the collected amount), what came back, and the COD receipt. With them in the group above, its
+// inferred type is more than TypeScript will write into the declaration file (TS7056, as for the
+// route table in 27d): each route repeats the order's answer. Same rules: storefront.order.manage,
+// the order in the answer
+export const storefrontOrderDeliveryRoutes = {
+  deliverOrder: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/deliver',
+    summary:
+      "Delivered: post the invoice for the challan and the delivery charge, and the rider's COD receipt",
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: idParamsSchema,
+    body: deliverStorefrontOrderInputSchema,
+    response: storefrontOrderSchema,
+  }),
+  // The challan's lines for "Record what came back"
+  getReturnPlan: defineRoute({
+    method: 'GET',
+    path: '/storefront/orders/:id/return-plan',
+    summary:
+      'What the "Record what came back" dialog opens with: the challan lines and their pieces',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: idParamsSchema,
+    response: storefrontReturnPlanSchema,
+  }),
+  partlyDeliverOrder: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/partly-deliver',
+    summary:
+      'Partly delivered: a sales return of what came back, the invoice of the rest, the COD receipt',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: idParamsSchema,
+    body: partlyDeliverStorefrontOrderInputSchema,
+    response: storefrontOrderSchema,
+  }),
+  returnOrder: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/return',
+    summary: 'Receive the return: the whole parcel came back, a sales return of the whole challan',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: idParamsSchema,
+    body: returnStorefrontOrderInputSchema,
+    response: storefrontOrderSchema,
+  }),
+  // "Make the receipt", after a delivered parcel's COD receipt could not be made
+  makeCodReceipt: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/shipments/:shipmentId/receipt',
+    summary: "Make a delivered parcel's COD receipt again, after it failed",
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: shipmentParamsSchema,
+    body: storefrontOrderVersionInputSchema,
+    response: storefrontOrderSchema,
+  }),
+};
```

- **The Returned tab** comes after Cancelled (decision 18). An order can get there now.
- **`parcelStatus` on the list's row** is the newest parcel's status, so the Shipped tab can put a second pill on the
  orders that wait for the staff, without loading each order.
- **`deliverStorefrontOrderInputSchema`** adds the collected amount with `.default(null)`. Unlike decision 20 this
  default is safe: a page from before 28b sends only the version, and `null` means "what the courier said, else
  `codAmount`", which is what that page would have meant.
- **`storefrontReturnPlanSchema` has one row per challan line,** not per order line: a line packed from two batches
  is two challan lines, and a sales return names a challan line (15d). Each row carries its batch and its serial
  numbers, so the dialog can offer exactly the pieces in the box.
- **`partlyDeliverStorefrontOrderInputSchema` sends only what came back** (decision 16). The empty list gets its own
  code on the list's box. A challan line twice and a serial number twice are refused on the second one, the same
  rules the sales return runs again in the API; here the error lands on the dialog's box. "Everything came back"
  needs the challan, so only the API can say it.
- **`returnStorefrontOrderInputSchema` has only a reason** (decision 7): the whole challan comes back, so there is
  nothing to pick.
- **The four routes and Delivered are their own group** (decision 17). The comment in the file says why, so nobody
  moves them back.
- **`makeCodReceipt` sits under the parcel** (`/shipments/:shipmentId/receipt`), because the receipt is the
  parcel's (decision 14).

### Error codes, audit actions and the bell

```diff
@@ -796,6 +796,23 @@ export const ERROR_CODES = [
   // The courier's webhook with no token or the wrong one, or for an account that is not an API
   // account of this provider. A 401, so the courier's panel shows that something is wrong
   'courier_webhook_token_invalid',
+  // Step 28b: the courier's COD money. On the courier account: a COD account that is not an active
+  // account holding money (or is a group), and a charge account that is not an active expense
+  // account (or is a group)
+  'courier_cod_account_invalid',
+  'courier_charge_account_invalid',
+  // At Delivered: more than the parcel's codAmount typed as collected (the courier was told to
+  // collect that much, never more), and, for a partial delivery, nothing typed and nothing said by
+  // the courier while a COD receipt is to be made (codAmount would be the wrong amount: the
+  // shopper kept only part)
+  'storefront_order_collected_over',
+  'storefront_order_collected_required',
+  // "Record what came back" with nothing ticked (that is Mark delivered) or with every piece
+  // ticked (that is Receive the return)
+  'storefront_order_return_nothing',
+  'storefront_order_return_everything',
+  // "Make the receipt" on a parcel whose COD receipt did not fail
+  'storefront_cod_receipt_not_failed',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

```diff
@@ -316,6 +316,12 @@ export const AUDIT_ACTIONS = [
   'storefront.default_courier_set',
   'storefront_order.shipment_booked',
   'storefront_order.shipment_retried',
+  // Step 28b: the order's two ends after the courier: partly delivered (with what came back, the
+  // collected amount and the documents) and returned (Receive the return, with the reason). The
+  // COD receipt writes its own receipt entry; cod_receipt_made is the member's retry of a failed one
+  'storefront_order.partly_delivered',
+  'storefront_order.returned',
+  'storefront_order.cod_receipt_made',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
```

```diff
@@ -33,6 +33,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // storefront.shipment_failed: params { id, number, courier } — five tries did not book a shop
 // order's parcel (step 28a, decision 4); sent to the owners and the people with
 // storefront.order.manage, and the bell opens the order. courier = the account's name
+// storefront.cod_receipt_failed: params { id, number, courier } — a delivered shop order's COD
+// receipt could not be made (step 28b, decision 4: the courier's news delivered it, nobody was
+// there to see the error); sent like shipment_failed, and the bell opens the order
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -53,6 +56,7 @@ export const NOTIFICATION_TYPES = [
   'pos.shift_variance',
   'storefront.order_confirmed',
   'storefront.shipment_failed',
+  'storefront.cod_receipt_failed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

```diff
@@ -22,7 +22,7 @@ import { stockMovementReportRoutes } from './stock-movement-report.js';
 import { storefrontRoutes } from './storefront-admin.js';
 import { storefrontAppearanceRoutes } from './storefront-appearance.js';
 import { storefrontCouponRoutes } from './storefront-coupons.js';
-import { storefrontOrderRoutes } from './storefront-orders.js';
+import { storefrontOrderDeliveryRoutes, storefrontOrderRoutes } from './storefront-orders.js';
 import { shippingRoutes } from './shipping.js';
 import { storefrontPaymentRoutes } from './storefront-payments.js';
 import { publicStorefrontRoutes } from './storefront.js';
@@ -169,6 +169,7 @@ type Routes = Readonly<{
   storefront: typeof storefrontRoutes;
   storefrontAppearance: typeof storefrontAppearanceRoutes;
   storefrontOrders: typeof storefrontOrderRoutes;
+  storefrontOrderDeliveries: typeof storefrontOrderDeliveryRoutes;
   storefrontCoupons: typeof storefrontCouponRoutes;
   storefrontPayments: typeof storefrontPaymentRoutes;
   shipping: typeof shippingRoutes;
@@ -255,6 +256,7 @@ export const routes: Routes = {
   storefront: storefrontRoutes,
   storefrontAppearance: storefrontAppearanceRoutes,
   storefrontOrders: storefrontOrderRoutes,
+  storefrontOrderDeliveries: storefrontOrderDeliveryRoutes,
   storefrontCoupons: storefrontCouponRoutes,
   storefrontPayments: storefrontPaymentRoutes,
   shipping: shippingRoutes,
```

- **`storefront_order_collected_over`** carries `{{amount}}` (the parcel's `codAmount`), so the message says the
  limit. **`storefront_order_collected_required`** is for a partial delivery only: there `codAmount` is the wrong
  amount, because the shopper kept only part.
- **The two return codes** say which button to use instead (decision 16).
- **Three audit actions.** The documents (the sales return, the invoice, the receipt) write their own entries; the
  order's entry says which move made them. `cod_receipt_made` is the member's retry.
- **`storefront.cod_receipt_failed`** (decision 19) has the same params as `shipment_failed`, so the bell's code
  can treat the two alike.
- **The new route group needs its line in `Routes`** (27d.1's note in routes.ts).

```diff
@@ -3032,6 +3032,8 @@ export const en = {
       cheque: 'Cheque',
       mobile_wallet: 'Mobile wallet',
       card: 'Card',
+      // Step 28b: the cash a courier's rider collected, made by a shop order's Delivered only
+      courier: 'Courier COD',
     },
     columns: {
       number: 'Number',
@@ -7524,6 +7526,10 @@ export const en = {
         // Step 28a
         shipment_booked: 'Booked a shop order’s parcel with a courier',
         shipment_retried: 'Booked a shop order’s parcel again after it failed',
+        // Step 28b
+        partly_delivered: 'Recorded what came back of a partly delivered shop order',
+        returned: 'Received a returned shop order back',
+        cod_receipt_made: 'Made a delivered shop order’s COD receipt again',
       },
       // Step 27c
       storefront_coupon: {
@@ -7922,6 +7928,9 @@ export const en = {
         // Step 28a: {{courier}} is the account's name ("Steadfast")
         shipment_failed:
           '{{courier}} did not book the parcel of {{number}}. Open the order to book it again.',
+        // Step 28b: {{courier}} is the account's name, as above
+        cod_receipt_failed:
+          '{{number}} was delivered by {{courier}}, but its COD receipt could not be made. Open the order to make it.',
       },
     },
   },
@@ -8793,6 +8802,19 @@ export const en = {
       'The courier already has a parcel with this order’s number. Find it on the courier’s panel and cancel it there, then book again.',
     courier_webhook_token_invalid:
       'This webhook token is not right. Paste the token from Shop couriers.',
+    // Step 28b
+    courier_cod_account_invalid:
+      'Pick an active account that holds money, like Cash with Steadfast, or none.',
+    courier_charge_account_invalid:
+      'Pick an active expense account, like Courier charges, or none.',
+    storefront_order_collected_over:
+      'The rider collects at most {{amount}} for this parcel. Type what the courier says was collected.',
+    storefront_order_collected_required:
+      'Type what the rider collected. The courier has not said it yet.',
+    storefront_order_return_nothing:
+      'Tick what came back. If the shopper kept everything, use Mark delivered.',
+    storefront_order_return_everything: 'Everything came back. Use Receive the return instead.',
+    storefront_cod_receipt_not_failed: 'This parcel’s COD receipt did not fail. Reload the order.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -2840,6 +2840,7 @@ export const bn: Messages = {
       cheque: 'চেক',
       mobile_wallet: 'মোবাইল ওয়ালেট',
       card: 'কার্ড',
+      courier: 'কুরিয়ারের COD',
     },
     columns: {
       number: 'নম্বর',
@@ -6946,6 +6947,10 @@ export const bn: Messages = {
         // Step 28a
         shipment_booked: 'শপের অর্ডারের পার্সেল কুরিয়ারে বুক করেছেন',
         shipment_retried: 'বুকিং ব্যর্থ হওয়ার পর শপের অর্ডারের পার্সেল আবার বুক করেছেন',
+        // Step 28b
+        partly_delivered: 'শপের আংশিক পৌঁছানো অর্ডারের ফেরত আসা মাল লিখেছেন',
+        returned: 'শপের ফেরত আসা অর্ডার বুঝে নিয়েছেন',
+        cod_receipt_made: 'শপের পৌঁছানো অর্ডারের COD রসিদ আবার বানিয়েছেন',
       },
       // Step 27c
       storefront_coupon: {
@@ -7322,6 +7327,9 @@ export const bn: Messages = {
         // Step 28a: {{courier}} is the account's name ("Steadfast")
         shipment_failed:
           '{{courier}} {{number}}-এর পার্সেল বুক করেনি। আবার বুক করতে অর্ডারটা খুলুন।',
+        // Step 28b
+        cod_receipt_failed:
+          '{{courier}} {{number}} পৌঁছে দিয়েছে, কিন্তু COD রসিদ বানানো যায়নি। বানাতে অর্ডারটা খুলুন।',
       },
     },
   },
@@ -8160,6 +8168,19 @@ export const bn: Messages = {
       'এই অর্ডারের নম্বরে কুরিয়ারের কাছে আগেই একটা পার্সেল আছে। কুরিয়ারের প্যানেলে সেটা খুঁজে বাতিল করুন, তারপর আবার বুক করুন।',
     courier_webhook_token_invalid:
       'এই webhook token ঠিক না। শপের কুরিয়ার পেজ থেকে token পেস্ট করুন।',
+    // Step 28b
+    courier_cod_account_invalid:
+      'টাকা রাখে এমন একটা সক্রিয় অ্যাকাউন্ট বাছুন, যেমন Cash with Steadfast, বা কোনোটাই না।',
+    courier_charge_account_invalid:
+      'একটা সক্রিয় খরচের অ্যাকাউন্ট বাছুন, যেমন Courier charges, বা কোনোটাই না।',
+    storefront_order_collected_over:
+      'এই পার্সেলে রাইডার সর্বোচ্চ {{amount}} তোলে। কুরিয়ার যত তুলেছে বলেছে, তত লিখুন।',
+    storefront_order_collected_required: 'রাইডার কত তুলেছে লিখুন। কুরিয়ার এখনো বলেনি।',
+    storefront_order_return_nothing:
+      'কী ফেরত এসেছে টিক দিন। ক্রেতা সব রেখে দিলে Mark delivered চাপুন।',
+    storefront_order_return_everything: 'সবই ফেরত এসেছে। এর বদলে Receive the return চাপুন।',
+    storefront_cod_receipt_not_failed:
+      'এই পার্সেলের COD রসিদ ব্যর্থ হয়নি। অর্ডারটা আবার লোড করুন।',
   },
   ui: {
     dataTable: {
```

The words of every new code, action, bell kind and the receipt's new method. They go in now, because
`satisfies Record<ErrorCode, string>` fails the i18n type check the moment a code has no words, and
`receipts.methods` is read with the method as its key.

### Tests

```diff
@@ -2,6 +2,7 @@ import { describe, expect, it } from 'vitest';
 
 import {
   bookShipmentInputSchema,
+  collectedAmountSchema,
   courierAccountSchema,
   createCourierAccountInputSchema,
   isOpenShipment,
@@ -12,7 +13,7 @@ import {
   updateCourierAccountInputSchema,
 } from './shipping.js';
 import { SHOP_SHIPMENT_STATUSES } from './storefront.js';
-import { storefrontOrderRoutes } from './storefront-orders.js';
+import { storefrontOrderDeliveryRoutes, storefrontOrderRoutes } from './storefront-orders.js';
 
 // The field paths and codes of a failed parse, the way the forms show them
 function errorsOf(result: {
@@ -28,6 +29,7 @@ function errorsOf(result: {
 }
 
 const ACCOUNT = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';
+const COD_ACCOUNT = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b';
 
 // Keys as Steadfast's panel shows them (made up, the same shape)
 const STEADFAST = {
@@ -35,6 +37,9 @@ const STEADFAST = {
   name: 'Steadfast',
   apiKey: 'xk2j9tqlm4n8vbc0r7pd',
   secretKey: 'h6s1w3fz9ye2u5ia8og0',
+  // Step 28b: no COD or charge account yet, as the select sends it
+  codAccountId: '',
+  chargeAccountId: '',
 } as const;
 
 describe('the courier account form', () => {
@@ -60,7 +65,12 @@ describe('the courier account form', () => {
   });
 
   it('asks a manual account for its courier, never for keys', () => {
-    const manual = { provider: 'manual', name: 'Pathao (by hand)' };
+    const manual = {
+      provider: 'manual',
+      name: 'Pathao (by hand)',
+      codAccountId: '',
+      chargeAccountId: '',
+    };
     expect(errorsOf(createCourierAccountInputSchema.safeParse({ ...manual, courier: '' }))).toEqual(
       { courier: ['courier_pick_one'] },
     );
@@ -72,6 +82,27 @@ describe('the courier account form', () => {
     expect(parsed).not.toHaveProperty('apiKey');
   });
 
+  // Step 28b: the select's "No COD account" is '' and becomes null; whether a picked one fits is
+  // the API's (courier_cod_account_invalid)
+  it('takes the COD and charge accounts for both kinds, and none as null', () => {
+    const steadfast = createCourierAccountInputSchema.parse({
+      ...STEADFAST,
+      codAccountId: COD_ACCOUNT,
+    });
+    expect(steadfast).toMatchObject({ codAccountId: COD_ACCOUNT, chargeAccountId: null });
+    const manual = createCourierAccountInputSchema.parse({
+      provider: 'manual',
+      name: 'Pathao (by hand)',
+      courier: 'pathao',
+      codAccountId: COD_ACCOUNT,
+      chargeAccountId: '',
+    });
+    expect(manual).toMatchObject({ codAccountId: COD_ACCOUNT, chargeAccountId: null });
+    expect(
+      createCourierAccountInputSchema.safeParse({ ...STEADFAST, codAccountId: 'cash' }).success,
+    ).toBe(false);
+  });
+
   it('refuses a provider it does not know', () => {
     expect(
       createCourierAccountInputSchema.safeParse({ ...STEADFAST, provider: 'redx' }).success,
@@ -91,6 +122,9 @@ describe('the saved account', () => {
       hasWebhookToken: true,
       lastWebhookAt: null,
       lastTest: null,
+      codAccountId: COD_ACCOUNT,
+      chargeAccountId: null,
+      holds: { amount: '45200.00', parcels: 18 },
       version: 1,
       updatedAt: '2026-11-22T10:00:00.000Z',
       apiKey: 'leaked',
@@ -132,6 +166,17 @@ describe('a parcel', () => {
   });
 });
 
+// Step 28b
+describe('what the rider collected', () => {
+  it('is a shop amount in whole paisa, zero too, and an empty box is "not typed"', () => {
+    expect(collectedAmountSchema.parse('')).toBeNull();
+    expect(collectedAmountSchema.parse(' 538.5 ')).toBe('538.5');
+    expect(collectedAmountSchema.parse('0')).toBe('0');
+    expect(errorsOf(collectedAmountSchema.safeParse('538.255'))).toEqual({ '': ['money_format'] });
+    expect(collectedAmountSchema.safeParse('-1').success).toBe(false);
+  });
+});
+
 describe("Steadfast's webhook", () => {
   it('keeps the fields it does not know, and takes the consignment id as a number', () => {
     const parsed = steadfastWebhookSchema.parse({
@@ -145,6 +190,19 @@ describe("Steadfast's webhook", () => {
     expect(parsed).toHaveProperty('cod_amount', 578);
   });
 
+  // Step 28b (decision 5): what the rider collected and the charge, as numbers or as strings
+  it("keeps what the rider collected and Steadfast's charge, a number or a string", () => {
+    const parsed = steadfastWebhookSchema.parse({
+      notification_type: 'delivery_status',
+      consignment_id: 1424107,
+      status: 'partial_delivered',
+      cod_amount: 300.5,
+      delivery_charge: '130.00',
+    });
+    expect(parsed).toMatchObject({ cod_amount: 300.5, delivery_charge: '130.00' });
+    expect(steadfastWebhookSchema.safeParse({ cod_amount: true }).success).toBe(false);
+  });
+
   it('never refuses a notice for its shape: the handler keeps an unknown one raw', () => {
     expect(steadfastWebhookSchema.safeParse({}).success).toBe(true);
     expect(steadfastWebhookSchema.safeParse({ status: 7 }).success).toBe(false);
@@ -173,4 +231,13 @@ describe('the routes', () => {
       expect(route.permission).toBe('storefront.order.manage');
     }
   });
+
+  // Step 28b: the moves at the door, their own group (TS7056) with the same rules
+  it('deliver, take what came back and make the COD receipt with storefront.order.manage', () => {
+    for (const route of Object.values(storefrontOrderDeliveryRoutes)) {
+      expect(route.auth).toBe('bearer');
+      expect(route.permission).toBe('storefront.order.manage');
+      expect(route.path.startsWith('/storefront/orders/:id/')).toBe(true);
+    }
+  });
 });
```

The account form with and without the two accounts (and a box that is not an id), the saved account with its
accounts and `holds`, the collected amount (empty, trimmed, zero, three decimals, a minus), Steadfast's two new
fields as a number and as a string, and the new group's permission.

```diff
@@ -3,7 +3,10 @@ import { describe, expect, it } from 'vitest';
 import { SHOP_ORDER_STATUSES } from './storefront.js';
 import {
   cancelStorefrontOrderInputSchema,
+  deliverStorefrontOrderInputSchema,
   packStorefrontOrderInputSchema,
+  partlyDeliverStorefrontOrderInputSchema,
+  returnStorefrontOrderInputSchema,
   STOREFRONT_ORDER_STATUSES,
   storefrontOrderPaymentSchema,
   storefrontOrderQuerySchema,
@@ -64,6 +67,11 @@ describe('the statuses the ERP shows', () => {
   it('has no tab for orders that wait for their code', () => {
     expect(storefrontOrderQuerySchema.safeParse({ view: 'pending' }).success).toBe(false);
   });
+
+  // Step 28b: an order can be returned now, so it has a tab
+  it('has a Returned tab after Cancelled', () => {
+    expect(storefrontOrderQuerySchema.parse({ view: 'returned' }).view).toBe('returned');
+  });
 });
 
 describe('Packed', () => {
@@ -140,6 +148,65 @@ describe('Cancel', () => {
   });
 });
 
+// Step 28b
+describe('Delivered', () => {
+  it('takes what the rider collected, and none (a page from before 28b) as null', () => {
+    expect(deliverStorefrontOrderInputSchema.parse({ version: 5 })).toEqual({
+      version: 5,
+      collectedAmount: null,
+    });
+    expect(
+      deliverStorefrontOrderInputSchema.parse({ version: 5, collectedAmount: '578' })
+        .collectedAmount,
+    ).toBe('578');
+  });
+});
+
+describe('Record what came back', () => {
+  const LINE_A = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
+  const LINE_B = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
+
+  it('takes the lines that came back, what was collected and why', () => {
+    const parsed = partlyDeliverStorefrontOrderInputSchema.parse({
+      version: 6,
+      lines: [{ deliveryLineId: LINE_A, quantity: '1', serialNumbers: [] }],
+      collectedAmount: '300',
+      reason: 'Wrong size',
+    });
+    expect(parsed).toMatchObject({ collectedAmount: '300', reason: 'Wrong size' });
+  });
+
+  it('needs at least one line: nothing back is Mark delivered', () => {
+    expect(
+      errorsOf(
+        partlyDeliverStorefrontOrderInputSchema.safeParse({ version: 6, lines: [], reason: '' }),
+      ),
+    ).toEqual({ lines: ['storefront_order_return_nothing'] });
+  });
+
+  it('refuses a challan line twice and a serial number twice, on the second one', () => {
+    const result = partlyDeliverStorefrontOrderInputSchema.safeParse({
+      version: 6,
+      lines: [
+        { deliveryLineId: LINE_A, quantity: '1', serialNumbers: ['356938035643809'] },
+        { deliveryLineId: LINE_B, quantity: '1', serialNumbers: ['356938035643809'] },
+        { deliveryLineId: LINE_A, quantity: '1', serialNumbers: [] },
+      ],
+      reason: '',
+    });
+    expect(errorsOf(result)).toEqual({
+      'lines.1.serialNumbers.0': ['stock_serial_twice'],
+      'lines.2.deliveryLineId': ['return_line_twice'],
+    });
+  });
+});
+
+describe('Receive the return', () => {
+  it('keeps no reason as null', () => {
+    expect(returnStorefrontOrderInputSchema.parse({ version: 7, reason: '' }).reason).toBeNull();
+  });
+});
+
 // Step 27d
 describe('a payment try', () => {
   const PAID = {
```

The Returned tab, Delivered from a page before 28b, what came back (the lines, nothing, a line and a serial number
twice), and Receive the return's empty reason.

```diff
@@ -3,6 +3,8 @@ import { describe, expect, it } from 'vitest';
 import { contractErrorMap } from './errors.js';
 import {
   overAllocated,
+  PAYMENT_METHODS,
+  RECEIPT_METHODS,
   receiptAllocationsInputSchema,
   receiptInputSchema,
   voidReceiptInputSchema,
@@ -42,6 +44,15 @@ function errorsOf(result: {
   );
 }
 
+// Step 28b (decision 4): only a shop order's Delivered writes a courier receipt
+describe("a receipt's method", () => {
+  it('may be courier when read, but the form never takes it', () => {
+    expect(RECEIPT_METHODS).toEqual([...PAYMENT_METHODS, 'courier']);
+    expect(PAYMENT_METHODS).not.toContain('courier');
+    expect(receiptInputSchema.safeParse(receipt({ method: 'courier' })).success).toBe(false);
+  });
+});
+
 describe('receipt input', () => {
   it('takes a receipt applied in full, in part, or not at all (an advance)', () => {
     expect(receiptInputSchema.safeParse(receipt()).success).toBe(true);
```

A receipt may say `courier`, but the form never takes it.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/contracts test        # 692 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
```

These fail until later parts, on purpose:

- `pnpm --filter @omnivo/api typecheck`: the courier accounts service and the parcel view have no new fields yet,
  the order list has no `parcelStatus`, the controller still serves Delivered from the old group, the audit and bell
  calls do not know the new kinds, and the receipt documents' method words (`documents/copy.ts`) have no `courier`
  (28b.3).
- `pnpm --filter @omnivo/app typecheck`: the bell's link map, the courier form, the order page and the mocks (28b.6
  and 28b.7).

Broken on purpose while this part was written, each caught:

- `collectedAmountSchema` without its paisa rule: "is a shop amount in whole paisa" fails.
- `receiptInputSchema` with `RECEIPT_METHODS`: "may be courier when read, but the form never takes it" fails.

## 28b.2 — Database

No new table. The courier account gets its two accounts, a parcel gets what the rider collected, the courier's charge
and its COD receipt, a receipt may say `courier`, and an order may now have a sales return when it was partly
delivered or Returned. Two migrations, as in 28a: drizzle-kit writes the columns, the keys and the checks (0080); a
hand-written one keeps a parcel's receipt and makes sure it is the parcel's own money (0081).

Mine, made while writing this part:

21. **What the rider collected is never more than `cod_amount` in the database too** (mine 15). A courier's notice
    that says more (a merchant who changed the amount on the courier's own panel) is cut to `cod_amount` by the API
    in 28b.3; the event row keeps the courier's own body in `raw`, and 28c's matching lists the parcel as
    "different". The books then never hold money the invoice does not ask for.
22. **The receipt's rules are a second trigger,** not a new version of 0078's `storefront_shipments_guard`. Writing
    that function again here would repeat 28a's rules in this guide and in the database's history, and the two
    triggers never disagree.
23. **The receipt is checked against the parcel when it is linked:** posted, by `courier`, for exactly what was
    collected, into the COD account of the parcel's courier account. Later the parcel may still move (the courier
    says a delivered parcel came back) and the account may get another COD account; the receipt stays what it was
    when it was made.
24. **`receipts.method` stays a type, with no check,** as it was: no table of methods has a check, and the receipt
    form still offers only `PAYMENT_METHODS`.
25. **A Returned order has a sales return and no invoice.** The whole challan came back, so nothing was billed. A
    return after the invoice is a credit note (15d), not this order's column.
26. **A voided COD receipt stays linked,** as a voided online payment's receipt does (27d). What a courier holds
    (decision 12) and 28c's payout count posted receipts only.

### The courier account and the parcel

```diff
@@ -25,12 +25,15 @@ import {
   uuid,
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
+import { ledgerAccounts } from './ledger-accounts.js';
+import { receipts } from './receipts.js';
 import { storefrontOrders } from './storefront-orders.js';
 import { tenants } from './tenants.js';
 
 // Step 28a: couriers (system design §14.6). The shop's courier accounts, the parcels its orders
 // are sent in, and what the courier said about each parcel. Migration 0078 gives the three tables
-// their rules.
+// their rules. Step 28b: the courier's COD money (each account's two accounts, and what each
+// parcel collected and its receipt); migration 0081 adds their rules.
 
 // Raw bytes, as in storefront-payments.ts and sync.ts: drizzle 0.45 has no bytea column
 const bytea = customType<{ data: Buffer; driverData: Buffer }>({
@@ -93,10 +96,36 @@ export const courierAccounts = pgTable(
     lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
     lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
     lastTestProblem: text('last_test_problem', { enum: COURIER_TEST_PROBLEMS }),
+    // Step 28b. The money account the rider's cash goes into at Delivered ("Cash with
+    // Steadfast", decision 2), and the expense account of the courier's charges (decision 3, used
+    // by 28c's payout). NULL: none, so Delivered makes no receipt, as before 28b. Whether they
+    // still fit (a posting account that holds money, an expense) is the API's check, because an
+    // account can be archived after it was picked (27d's reason)
+    codAccountId: uuid('cod_account_id'),
+    chargeAccountId: uuid('charge_account_id'),
   },
   (table) => [
     // The target of the parcels' foreign key (a constraint, for 0070's reason)
     unique('courier_accounts_tenant_id_key').on(table.tenantId, table.id),
+    // Accounts of this workspace. No ON DELETE: an account is deleted for real only when nothing
+    // uses it, and these two are used (27d's gateway)
+    foreignKey({
+      name: 'courier_accounts_cod_account_fk',
+      columns: [table.tenantId, table.codAccountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    foreignKey({
+      name: 'courier_accounts_charge_account_fk',
+      columns: [table.tenantId, table.chargeAccountId],
+      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
+    }),
+    // The charges in the COD account would post them against the money they come out of: its
+    // balance would no longer be what the courier holds (27d's two accounts)
+    check(
+      'courier_accounts_money_accounts_check',
+      sql`${table.codAccountId} IS NULL OR ${table.chargeAccountId} IS NULL
+        OR ${table.codAccountId} <> ${table.chargeAccountId}`,
+    ),
     // One default per workspace. A second one fails here, so the API clears the old one first
     uniqueIndex('courier_accounts_default_idx')
       .on(table.tenantId)
@@ -177,6 +206,15 @@ export const storefrontShipments = pgTable(
     errorDetail: text('error_detail'),
     // When the courier last told us anything (the webhook or the poll)
     lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
+    // Step 28b (decision 5). What the rider collected (the courier's notice, or what the member
+    // typed at Delivered), never more than cod_amount (mine 15), and the courier's charge for the
+    // parcel as its notice said it (28c's payout uses it). NULL: not known yet
+    collectedAmount: numeric('collected_amount', { precision: 19, scale: 4 }),
+    courierCharge: numeric('courier_charge', { precision: 19, scale: 4 }),
+    // The posted COD receipt Delivered made for this parcel (decision 4, mine 14), or why it
+    // could not (an error code, like a payment try's receipt_error). Neither: none was due
+    receiptId: uuid('receipt_id'),
+    receiptError: text('receipt_error'),
   },
   (table) => [
     unique('storefront_shipments_tenant_id_key').on(table.tenantId, table.id),
@@ -213,6 +251,21 @@ export const storefrontShipments = pgTable(
       columns: [table.tenantId, table.courierAccountId],
       foreignColumns: [courierAccounts.tenantId, courierAccounts.id],
     }),
+    // Step 28b. One receipt, one parcel: a news handler that ran twice cannot link a second
+    // parcel to the same money. No ON DELETE: a receipt is voided, never deleted
+    uniqueIndex('storefront_shipments_receipt_idx')
+      .on(table.tenantId, table.receiptId)
+      .where(sql`${table.receiptId} IS NOT NULL`),
+    foreignKey({
+      name: 'storefront_shipments_receipt_fk',
+      columns: [table.tenantId, table.receiptId],
+      foreignColumns: [receipts.tenantId, receipts.id],
+    }),
+    // What each courier account holds (decision 12) and 28c's payout read the parcels with a COD
+    // receipt, per account. Partial: most parcels of a shop that takes online payment have none
+    index('storefront_shipments_cod_idx')
+      .on(table.tenantId, table.courierAccountId)
+      .where(sql`${table.receiptId} IS NOT NULL`),
     check(
       'storefront_shipments_values_check',
       sql`${table.status} IN (${sqlList(SHIPMENT_STATUSES)})
@@ -245,6 +298,24 @@ export const storefrontShipments = pgTable(
       sql`${table.codAmount} >= 0 AND ${table.codAmount} = round(${table.codAmount}, 2)
         AND ${table.attempts} >= 0`,
     ),
+    // Step 28b. The rider's money to the paisa, and never more than the courier was told to
+    // collect (mine 15). A receipt is for what was collected, so it needs more than zero (zero
+    // makes none; coalesce, because NULL > 0 is NULL and a check passes on NULL); the receipt and its error are never both. A parcel the courier has not taken
+    // yet has none of them. When a receipt may be linked, and that it is this parcel's money, is
+    // 0081's guard: a check cannot read the receipt
+    check(
+      'storefront_shipments_cod_check',
+      sql`(${table.collectedAmount} IS NULL OR (${table.collectedAmount} >= 0
+          AND ${table.collectedAmount} = round(${table.collectedAmount}, 2)
+          AND ${table.collectedAmount} <= ${table.codAmount}))
+        AND (${table.courierCharge} IS NULL OR (${table.courierCharge} >= 0
+          AND ${table.courierCharge} = round(${table.courierCharge}, 2)))
+        AND (${table.receiptId} IS NULL OR coalesce(${table.collectedAmount}, 0) > 0)
+        AND num_nonnulls(${table.receiptId}, ${table.receiptError}) <= 1
+        AND (${table.receiptError} IS NULL OR ${table.receiptError} ~ '^[a-z][a-z0-9_]{0,63}$')
+        AND (${table.status} NOT IN ('booking', 'booking_failed')
+          OR num_nonnulls(${table.collectedAmount}, ${table.courierCharge}, ${table.receiptId}, ${table.receiptError}) = 0)`,
+    ),
   ],
 );
 
```

- **`cod_account_id` and `charge_account_id` are nullable** (decision 2): an account saved before 28b has neither,
  and so makes no receipt, as before. Whether each still fits (a posting account that holds money; an active
  expense account) is the API's check when the account is saved and again when a receipt is made, for 27d's reason:
  an account can be archived after it was picked, and a check cannot read the chart.
- **The two foreign keys include `tenant_id`,** so an account of another workspace is refused by the key itself.
  No `ON DELETE`: an account that a courier account names cannot be deleted for real (only archived).
- **`courier_accounts_money_accounts_check`:** the charges in the COD account would post against the money they
  come out of, and its balance would no longer be what the courier holds. Either may be empty.
- **`collected_amount` and `courier_charge`** (decision 5) are NULL until the courier (or the member at Delivered)
  says them. NULL is "not known", which is not the same as zero: zero means the rider collected nothing.
- **`receipt_id` and `receipt_error`** are 27d's pair on the payment try: the receipt, or an error code saying why
  it could not be made, never both. The order page shows the error with "Make the receipt" (decision 4).
- **`storefront_shipments_receipt_idx`:** one receipt, one parcel. The news handler and a member's "Make the
  receipt" at the same moment cannot both link the same money (0081's trigger stops two receipts on one parcel).
- **`storefront_shipments_cod_idx`** is the read of "what each courier holds" (decision 12) and of 28c's payout:
  per courier account, only the parcels with a receipt.
- **`storefront_shipments_cod_check`:** the collected amount to the paisa and never above `cod_amount` (mine 21);
  the charge to the paisa; a receipt only with more than zero collected (zero makes no receipt, mine 15); the error
  a code, never a message; and nothing of it on a parcel the courier has not taken yet. The `coalesce` matters:
  `NULL > 0` is NULL, and a check passes on NULL, so without it a receipt with no collected amount would pass. A
  break-on-purpose run found that (below).

### The receipt's method

```diff
@@ -1,4 +1,4 @@
-import { PAYMENT_METHODS, RECEIPT_STATUSES } from '@omnivo/contracts';
+import { RECEIPT_METHODS, RECEIPT_STATUSES } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
   check,
@@ -43,7 +43,9 @@ export const receipts = pgTable(
     refunded: numeric('refunded', { precision: 19, scale: 4 }).notNull().default('0'),
     // The cash, bank or wallet account it went into (a money account: the API checks that)
     accountId: uuid('account_id').notNull(),
-    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
+    // Step 28b: RECEIPT_METHODS, so a shop order's COD receipt can say `courier` (mine 13). A type
+    // only: the column has no check, as before, and the receipt form still offers PAYMENT_METHODS
+    method: text('method', { enum: RECEIPT_METHODS }).notNull(),
     reference: text('reference'),
     branchId: uuid('branch_id').notNull(),
     note: text('note'),
```

- **`RECEIPT_METHODS`** (mine 13 and 24). The column's type now says `courier` may come back from the database, so
  every place that reads a receipt's method must know it: 28b.3 adds its words to the receipt documents. No SQL
  changes: drizzle-kit writes nothing for a text enum.

### The order's documents

```diff
@@ -117,7 +117,8 @@ export const storefrontOrders = pgTable(
     deliveryId: uuid('delivery_id'),
     // The posted invoice made at Delivered (decision 7)
     invoiceId: uuid('invoice_id'),
-    // The posted sales return made when a packed order is cancelled (decision 8)
+    // The posted sales return made when a packed order is cancelled (decision 8). Step 28b: also
+    // what came back of a partly delivered order (before its invoice) and a returned one's
     salesReturnId: uuid('sales_return_id'),
     // Why the handler could not make the sales order (decision 16): an error code
     // ("sales_variant_archived"), never a message. The page shows it with t('errors.…')
@@ -252,12 +253,17 @@ export const storefrontOrders = pgTable(
     // sales order, an invoice and a return only with a challan. Packed, Shipped and Delivered
     // always have their challan, Delivered its invoice, and a cancel after Packed its return. A
     // pending order has none of them: omnivo_shop may INSERT whole rows, and this keeps it from
-    // placing an order that points at a sales order
+    // placing an order that points at a sales order. Step 28b: a return also on a partly
+    // delivered order (Delivered, decision 6) and always on a Returned one, which has no invoice
+    // (decision 7): the whole challan came back, so nothing was billed. A return after the
+    // invoice is a credit note (15d), not this column
     check(
       'storefront_orders_documents_check',
       sql`(${table.deliveryId} IS NULL OR ${table.salesOrderId} IS NOT NULL)
         AND (${table.invoiceId} IS NULL OR ${table.deliveryId} IS NOT NULL)
-        AND (${table.salesReturnId} IS NULL OR (${table.deliveryId} IS NOT NULL AND ${table.status} = 'cancelled'))
+        AND (${table.salesReturnId} IS NULL OR (${table.deliveryId} IS NOT NULL
+          AND ${table.status} IN ('cancelled', 'delivered', 'returned')))
+        AND (${table.status} <> 'returned' OR (${table.salesReturnId} IS NOT NULL AND ${table.invoiceId} IS NULL))
         AND (${table.status} NOT IN ('packed', 'shipped', 'delivered') OR ${table.deliveryId} IS NOT NULL)
         AND (${table.status} <> 'delivered' OR ${table.invoiceId} IS NOT NULL)
         AND (${table.status} <> 'cancelled' OR ${table.packedAt} IS NULL OR ${table.salesReturnId} IS NOT NULL)
```

- **A sales return also on Delivered and Returned** (decisions 6 and 7). A partly delivered order is Delivered with
  the return of what came back and the invoice of the rest; a Returned one has the return of the whole challan.
- **Returned always has its return and never an invoice** (mine 25). An order moved to Returned without a return
  would have its goods out of stock for good.
- **Shipped with a return is still refused:** what came back is recorded in the same transaction as the invoice, so
  there is no moment when the order is Shipped with a return.

### The columns' migration

```sql
ALTER TABLE "storefront_orders" DROP CONSTRAINT "storefront_orders_documents_check";--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "cod_account_id" uuid;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "charge_account_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "collected_amount" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "courier_charge" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "receipt_error" text;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_cod_account_fk" FOREIGN KEY ("tenant_id","cod_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_charge_account_fk" FOREIGN KEY ("tenant_id","charge_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_receipt_idx" ON "storefront_shipments" USING btree ("tenant_id","receipt_id") WHERE "storefront_shipments"."receipt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "storefront_shipments_cod_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id") WHERE "storefront_shipments"."receipt_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_documents_check" CHECK (("storefront_orders"."delivery_id" IS NULL OR "storefront_orders"."sales_order_id" IS NOT NULL)
        AND ("storefront_orders"."invoice_id" IS NULL OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."sales_return_id" IS NULL OR ("storefront_orders"."delivery_id" IS NOT NULL
          AND "storefront_orders"."status" IN ('cancelled', 'delivered', 'returned')))
        AND ("storefront_orders"."status" <> 'returned' OR ("storefront_orders"."sales_return_id" IS NOT NULL AND "storefront_orders"."invoice_id" IS NULL))
        AND ("storefront_orders"."status" NOT IN ('packed', 'shipped', 'delivered') OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'delivered' OR "storefront_orders"."invoice_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'cancelled' OR "storefront_orders"."packed_at" IS NULL OR "storefront_orders"."sales_return_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'pending' OR num_nonnulls("storefront_orders"."sales_order_id", "storefront_orders"."document_error") = 0));--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_money_accounts_check" CHECK ("courier_accounts"."cod_account_id" IS NULL OR "courier_accounts"."charge_account_id" IS NULL
        OR "courier_accounts"."cod_account_id" <> "courier_accounts"."charge_account_id");--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_cod_check" CHECK (("storefront_shipments"."collected_amount" IS NULL OR ("storefront_shipments"."collected_amount" >= 0
          AND "storefront_shipments"."collected_amount" = round("storefront_shipments"."collected_amount", 2)
          AND "storefront_shipments"."collected_amount" <= "storefront_shipments"."cod_amount"))
        AND ("storefront_shipments"."courier_charge" IS NULL OR ("storefront_shipments"."courier_charge" >= 0
          AND "storefront_shipments"."courier_charge" = round("storefront_shipments"."courier_charge", 2)))
        AND ("storefront_shipments"."receipt_id" IS NULL OR coalesce("storefront_shipments"."collected_amount", 0) > 0)
        AND num_nonnulls("storefront_shipments"."receipt_id", "storefront_shipments"."receipt_error") <= 1
        AND ("storefront_shipments"."receipt_error" IS NULL OR "storefront_shipments"."receipt_error" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("storefront_shipments"."status" NOT IN ('booking', 'booking_failed')
          OR num_nonnulls("storefront_shipments"."collected_amount", "storefront_shipments"."courier_charge", "storefront_shipments"."receipt_id", "storefront_shipments"."receipt_error") = 0));
```

Made by drizzle-kit from the schema files:

```bash
pnpm --filter @omnivo/db generate --name storefront-cod
```

It drops and adds `storefront_orders_documents_check` (a changed check is always written this way), adds the
columns, the keys, the two indexes and the two new checks. Postgres checks every row against the new checks, so a
database with orders and parcels from before 28b migrates without a change: they have no return on Delivered and no
money columns. It also writes `meta/0080_snapshot.json` and a line in `meta/_journal.json`.

### The rules

```sql
-- Custom SQL migration file, put your code below! --
-- Step 28b: the rules of the courier's COD money. 0080 gave each courier account its COD and
-- charge accounts, and each parcel what the rider collected, the courier's charge and its COD
-- receipt; this file keeps a parcel's receipt for good and makes sure it is the parcel's money.

-- 1) No grant for the shop. omnivo_shop reads the parcels by column (0078 and 0079), so the four
--    new columns are closed to it without a line here: the tracking page never shows money, and a
--    tracking link can be forwarded. Nothing is written here on purpose. omnivo_app writes them
--    (Delivered, the courier's news, "Make the receipt"), with every column, as for every table.
--    The worker's poll reads only the workspace and the status of the open parcels (0078), and a
--    parcel with a receipt is no longer open

-- 2) A parcel's COD receipt (decision 4, mine 14):
--    - once linked, it stays linked, and what was collected stays what the receipt says: a receipt
--      is voided, never deleted, and 28c's payout pays a parcel by its receipt
--      (storefront_shipments_receipt_kept)
--    - it is linked only while the parcel is delivered or partly delivered, and only a receipt
--      that is this parcel's money: posted, by `courier`, for exactly what was collected, into the
--      COD account of the parcel's courier account (storefront_shipments_receipt_match). A bug that
--      linked another receipt, or the right one for the wrong amount, would put money in the
--      courier's balance (decision 12) that the courier never collected. 0080's check cannot read
--      the receipt or the account, so a trigger does, when the link is made. Later the parcel may
--      still move (a delivered parcel the courier says came back) and the account may get another
--      COD account: the receipt stays what it was when it was made
--    Its own trigger, next to 0078's storefront_shipments_guard, so that guard is not written
--    again here. Triggers on one table run in the order of their names; the two never disagree,
--    so the order does not matter. The CONSTRAINT names are what the API's database-error mapping
--    reads (18c's pattern)
CREATE FUNCTION storefront_shipments_cod_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.receipt_id IS NOT NULL
     AND (NEW.receipt_id, NEW.collected_amount) IS DISTINCT FROM (OLD.receipt_id, OLD.collected_amount) THEN
    RAISE EXCEPTION 'parcel % keeps its COD receipt and what was collected', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_kept';
  END IF;
  IF NEW.receipt_id IS NOT NULL AND OLD.receipt_id IS NULL THEN
    IF NEW.status NOT IN ('delivered', 'partly_delivered') THEN
      RAISE EXCEPTION 'parcel % is %, so it has no COD receipt', NEW.id, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_match';
    END IF;
    PERFORM 1
    FROM receipts r
    JOIN courier_accounts a ON a.tenant_id = NEW.tenant_id AND a.id = NEW.courier_account_id
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.receipt_id
      AND r.status = 'posted' AND r.method = 'courier'
      AND r.amount = NEW.collected_amount AND r.account_id = a.cod_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'receipt % is not parcel %''s COD money', NEW.receipt_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_receipt_match';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_shipments_cod_guard
  BEFORE UPDATE ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_cod_guard();
```

Made empty with `pnpm --filter @omnivo/db generate --custom --name storefront-cod-rules`, then written by hand:

1. **No grant for the shop.** 0078 gave `omnivo_shop` the parcel's columns one by one, so the four new ones are
   closed to it without a line. The tracking page never shows money, and a tracking link can be forwarded. The
   section is a comment only, so nobody adds a grant later thinking it was forgotten.
2. **The parcel's COD receipt** (mine 22 and 23). `receipt_kept`: once linked, the receipt and the collected amount
   never change, because 28c's payout pays a parcel by its receipt. `receipt_match`: a receipt is linked only while
   the parcel is delivered or partly delivered, and only one that is this parcel's money. The `PERFORM … IF NOT
   FOUND` reads the receipt and the courier account in one query; a courier account with no COD account finds
   nothing (`r.account_id = NULL` is never true), so it takes no receipt. A `BEFORE` trigger runs before the
   checks, so a link with no collected amount is refused here first, with `receipt_match`.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck && pnpm --filter @omnivo/db build
pnpm exec eslint packages/db/src
```

Then the migrations on a throwaway Postgres (never the dev database: its compose project would be reused), with a
fixture of two workspaces (28a.2's, plus four accounts and seven receipts, inserted with
`session_replication_role = replica` so their own foreign keys and triggers need no customers or branches; checks
still run in that mode), and a script of checks run as each role in one transaction that is rolled back:

```bash
docker run -d --name omnivo28b2-pg -p 55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=omnivo -v "$PWD/infra/docker/postgres/init:/docker-entrypoint-initdb.d:ro" postgres:17-alpine
MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@localhost:55432/omnivo \
  pnpm --filter @omnivo/db migrate
```

What was checked (all passed):

- **The courier account:** the same account for COD and charges, another workspace's account and an unknown id are
  refused; one of them alone, both, and a manual account's COD account work. An account a courier account names
  cannot be deleted.
- **The parcel's money:** on a parcel still booking, a charge, a collected amount and an error are refused. A
  collected amount over `cod_amount`, with a third decimal or below zero, a charge with a third decimal or below
  zero, and an error that is a sentence are refused.
- **The receipt:** with no collected amount, with zero, before delivered (booked, out for delivery), beside an
  error, by cash, for ৳500 of ৳578, voided, into another account, and another workspace's: each refused. The right
  one works. Then clearing it, changing it, changing the collected amount and adding an error are refused; the
  charge and the status (delivered → returned) still change. The same receipt on a second parcel fails on
  `storefront_shipments_receipt_idx`. A partly delivered parcel takes its own ৳300 receipt. A parcel of a courier
  account with no COD account takes none. The posted receipts per account read ৳578 and ৳300.
- **The order:** Returned with its return and no invoice works; with an invoice, or without the return, is refused.
  Delivered with a return and an invoice works; Shipped with a return is still refused.
- **The shop** (`omnivo_shop` in Acme) may not read the four money columns or the courier account's COD account,
  and still sees the three parcels it saw.
- **A race:** two receipts linked to one parcel at the same moment (the news handler and "Make the receipt"): the
  second waits for the first and fails on `receipt_kept`. One receipt.

Broken on purpose, each caught:

- `storefront_shipments_cod_guard` dropped: the first receipt check is refused by the check, not by the guard, and
  the run stops there. The first time, before the `coalesce`, that check was not refused at all: the guard was the
  only thing stopping a receipt with no collected amount. The check now holds on its own.
- `storefront_orders_documents_check` without its Returned line: Returned with an invoice is not refused.
- `storefront_shipments_receipt_idx` dropped: the same receipt on two parcels is not refused.

## 28b.3 — API

The money at the shopper's door, in the API. No new route file and no new queue: Delivered, the courier's news and
the order page's buttons already meet in `orders/order-moves.ts` (28a), so the COD receipt goes in there, once, and
the button, the webhook and the worker's poll all make it the same way.

How a delivered parcel's money lands in the books, end to end:

1. **The courier's notice** (Steadfast's `delivery_status`) brings `cod_amount` and `delivery_charge`. The adapter
   reads them as money; the shop's code keeps the charge on the parcel, and the collected amount only from a
   delivered or partly delivered step, never more than the parcel's `codAmount`.
2. **Delivered** (the courier's step, or Mark delivered) posts the invoice as before, applies any payment made
   online, then writes what was collected on the parcel and makes a posted money receipt by `courier` into the
   courier account's COD account, applied to the invoice. The receipt has a savepoint of its own: a refusal leaves
   the order Delivered with the error on the parcel, the order needs attention, the bell rings, and **Make the
   receipt** tries again.
3. **Partly delivered:** the courier's step marks the parcel only. **Record what came back** makes a sales return
   of the lines that came back, then step 2 with the invoice of what was kept, then closes the sales order.
4. **Came back whole:** the courier's step marks the parcel only. **Receive the return** makes a sales return of the
   whole challan, cancels the sales order, marks the parcel returned and the order Returned, and texts the shopper.

Mine, made while writing this part:

27. **Mark delivered moves the parcel too, an API parcel as well** (with a member step). 0081 links a receipt only
    to a delivered or partly delivered parcel, and a member who presses Mark delivered because the courier's news
    is late wants the money recorded now. The courier's later "delivered" adds its own step to the same status.
    `followOrder` now follows Mark shipped only.
28. **A parcel the courier says came back is not at the door.** Mark delivered on such an order (a member who knows
    better than the courier) makes no COD receipt: there is no parcel that may take one. The money is then a
    receipt typed by hand, as before 28b.
29. **Receive the return cancels the sales order; Record what came back closes it.** Decision 7 says "closes", but
    after a return of the whole challan the sales order has nothing delivered, and the sales rules call that a
    cancel (Close refuses it with `order_nothing_delivered`). 27b's cancel of a packed order does the same. A partly
    delivered order did deliver something, so it is closed.
30. **The courier's charge comes from any status notice; what was collected only from a delivered or partly
    delivered one.** On the other steps Steadfast's `cod_amount` is what is still to collect, so reading it there
    would put the full amount on a parcel that is still on its way.
31. **The bell rings for every refused COD receipt at Delivered, one per parcel,** also when a member pressed Mark
    delivered: the others who move orders learn of it too, and the parcel's id as the bell's event keeps it one.
32. **A kept line keeps its share of the coupon in proportion.** 1 of 2 pieces kept keeps half of the line's
    discount, so the invoice bills what the shopper paid for what they kept.
33. **The COD and charge accounts are checked on every save,** a saved one too, like the payment gateway's: an
    account archived since is no place for new money, and the form then starts its select empty with the error.
34. **A COD receipt's reference is the courier's tracking code** (else the invoice). It is what the courier's
    payout statement lists, so 28c's matching and a person reading the receipt find the parcel by it.

### The courier's notice

```diff
@@ -84,7 +84,12 @@ export type StatusAnswer =
 
 // One webhook body, read. The courier names the parcel by its own id or by our invoice (or both);
 // the caller finds it with either, only inside the account's own workspace
-//  - status: the parcel moved, with the courier's note and time when it gave them
+//  - status: the parcel moved, with the courier's note and time when it gave them. Step 28b: and
+//    the money it named, as decimal strings to the paisa, or null when it named none (the poll's
+//    answer never does): `collected`, what the notice says the rider collected (Steadfast's
+//    cod_amount), and `charge`, the courier's charge for the parcel (its delivery_charge). The
+//    adapter only reads them; the shop's code decides what they mean (shipment-news.ts: a
+//    collected amount counts only on a delivered or partly delivered step)
 //  - note: words about the parcel with no new status ("Received at Sylhet hub")
 //  - unread: a body this adapter cannot read. Kept raw on the parcel (decision 22), never refused
 export type CourierNotice = {
@@ -92,7 +97,14 @@ export type CourierNotice = {
   invoice: string | null;
   raw: Record<string, unknown>;
 } & (
-  | { kind: 'status'; status: ShopShipmentStatus | null; note: string | null; at: Date | null }
+  | {
+      kind: 'status';
+      status: ShopShipmentStatus | null;
+      note: string | null;
+      at: Date | null;
+      collected: string | null;
+      charge: string | null;
+    }
   | { kind: 'note'; note: string; at: Date | null }
   | { kind: 'unread' }
 );
@@ -126,6 +138,25 @@ export function courierId(value: unknown): string | null {
   return typeof text === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(text.trim()) ? text.trim() : null;
 }
 
+// Step 28b: an amount a courier sent, as our money text: a number (Steadfast's JSON has 1500.00 as
+// 1500) or a numeric string, zero or more, to the paisa at most ("578", "578.50"). null for
+// anything else (a minus, a third decimal, "N/A"): a sum we cannot read is no sum, and the raw
+// body still has it. A number goes through toFixed(2) first, so 0.1 + 0.2's float noise never
+// reaches the books; a number with real paisa beyond two places is refused like the string
+export function courierMoney(value: unknown): string | null {
+  let text: string;
+  if (typeof value === 'number') {
+    if (!Number.isFinite(value) || value < 0 || value >= 1e13) return null;
+    text = value.toFixed(2);
+    if (Math.abs(Number(text) - value) > 1e-6) return null;
+  } else if (typeof value === 'string') {
+    text = value.trim();
+  } else {
+    return null;
+  }
+  return /^\d{1,13}(?:\.\d{1,2})?$/.test(text) ? text : null;
+}
+
 // The API's own key for one step of a parcel (28a.2's mine 26): the same status, time and note is
 // the same step, whether the webhook said it twice or the webhook and the poll both did. The time
 // is the courier's own as it sent it (null when it sent none), never one we worked out: the same
```

- **`collected` and `charge` on a status notice only.** A note ("Received at Sylhet hub") and an unread body carry no
  money. Both are `null` when the courier named none, so the caller never has to tell "not said" from zero.
- **`courierMoney`** is the one place a courier's sum becomes ours. A number goes through `toFixed(2)` because
  JSON's `1500.5` and float noise (`0.1 + 0.2`) must become exact paisa before they reach a `numeric` column; the
  check after it refuses a number that really has a third decimal (`578.555`), which would otherwise be rounded
  without anyone seeing. A string is taken as it is, trimmed, and must already be to the paisa. Anything else
  (a minus, words like "N/A", an object) is `null`: a sum we cannot read is no sum, and the event's raw body still
  has what the courier sent.

```diff
@@ -7,6 +7,7 @@ import {
   type CourierAdapter,
   courierId,
   type CourierKeys,
+  courierMoney,
   type CourierNotice,
   type CourierProblem,
   courierText,
@@ -223,7 +224,18 @@ export class SteadfastAdapter implements CourierAdapter {
     const status = statusOf(notice.status);
     return status === null
       ? { ...ids, kind: 'unread' }
-      : { ...ids, kind: 'status', status, note, at };
+      : {
+          ...ids,
+          kind: 'status',
+          status,
+          note,
+          at,
+          // Step 28b (decision 5): Steadfast's two sums. On a delivered or partly delivered
+          // notice cod_amount is what the rider collected; on the others it is what is still to
+          // collect, which the shop's code leaves alone
+          collected: courierMoney(notice.cod_amount),
+          charge: courierMoney(notice.delivery_charge),
+        };
   }
 
   // Steadfast's balance: it reads, changes nothing, and needs both keys
```

The adapter only reads the two fields. It does not decide that `cod_amount` means "collected": that depends on the
step, and the step's meaning is the shop's code (mine 30).

```diff
@@ -115,6 +115,9 @@ export class ShipmentPoll {
                 // time also keeps its key apart from an earlier step with the same status (in
                 // transit, on hold, in transit again)
                 at: new Date(),
+                // Step 28b: a status answer names no money; the webhook's notice brings it
+                collected: null,
+                charge: null,
               },
             ];
       const sms = await this.withTenant((tx) => this.news.apply(tx, parcel.id, news, 'poll'));
```

The poll's answer is a status and nothing else, so its notice names no money. The webhook brings it.

### The courier's news keeps the money

```diff
@@ -1,5 +1,5 @@
 import { Injectable, Logger } from '@nestjs/common';
-import { type ShipmentStatus, type ShopShipmentStatus } from '@omnivo/contracts';
+import { compareMoney, type ShipmentStatus, type ShopShipmentStatus } from '@omnivo/contracts';
 import { storefrontSettings, storefrontShipmentEvents, storefrontShipments } from '@omnivo/db';
 import { and, desc, eq, isNotNull } from 'drizzle-orm';
 
@@ -58,6 +58,31 @@ function keptRaw(raw: Record<string, unknown>): Record<string, unknown> {
   return Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 8000 ? raw : { tooLarge: true };
 }
 
+// Step 28b (decision 5): the money a status notice names, as the parcel keeps it.
+// - The courier's charge from any status notice that names one: it is the courier's own figure
+//   for the parcel, known from the booking on, and 28c's payout checks it.
+// - What the rider collected only from a delivered or partly delivered step: on the other steps
+//   Steadfast's cod_amount is what is still to collect. Never more than the parcel's codAmount
+//   (mine 21: the raw body keeps what the courier said), and never once the parcel has its COD
+//   receipt (0081's receipt_kept): the receipt was made for the amount known then
+// A parcel the courier never booked has no money (0080's check); stepOf keeps its notices raw,
+// with no status, so they never reach here
+function moneyOf(
+  parcel: ParcelRow,
+  money: { collectedAmount: string | null; courierCharge: string | null },
+  status: ShopShipmentStatus,
+  notice: Extract<CourierNotice, { kind: 'status' }>,
+): { collectedAmount: string | null; courierCharge: string | null } {
+  const atDoor = status === 'delivered' || status === 'partly_delivered';
+  const collected =
+    !atDoor || notice.collected === null || parcel.receiptId !== null
+      ? money.collectedAmount
+      : compareMoney(notice.collected, parcel.codAmount) > 0
+        ? parcel.codAmount
+        : notice.collected;
+  return { collectedAmount: collected, courierCharge: notice.charge ?? money.courierCharge };
+}
+
 // Step 28a: what the courier said about one parcel, from its webhook (in the API) or the 15-minute
 // poll (in the worker), written the same way:
 // 1. the order, then the parcel, are locked (the buttons' order, so the two take turns)
@@ -66,7 +91,9 @@ function keptRaw(raw: Record<string, unknown>): Record<string, unknown> {
 // 3. the parcel's status is its newest step's, by the courier's clock (kept between the booking
 //    and now): a webhook that comes late does not take the parcel back
 // 4. the order follows: Shipped once the goods have left, then Delivered, which posts the invoice
-//    (decision 5, the buttons' own code in order-moves.ts)
+//    (decision 5, the buttons' own code in order-moves.ts). Step 28b: and the rider's COD receipt,
+//    from the collected amount step 3 kept on the parcel. A partly delivered or returned parcel
+//    moves only itself: the goods that came back are recorded by a member (decisions 6 and 7)
 // It answers the SMS to send once the caller's transaction has committed (decision 11), never
 // before: an SMS for news that rolled back would tell the shopper something that did not happen.
 @Injectable()
@@ -101,6 +128,7 @@ export class ShipmentNews {
     if (parcel === undefined) return null;
 
     let current: ShipmentStatus = parcel.status;
+    let money = { collectedAmount: parcel.collectedAmount, courierCharge: parcel.courierCharge };
     for (const notice of notices) {
       const step = this.stepOf(parcel, current, notice, now);
       await tx
@@ -108,12 +136,15 @@ export class ShipmentNews {
         .values({ tenantId, shipmentId, ...step, source, receivedAt: now })
         .onConflictDoNothing();
       if (step.status !== null) current = step.status;
+      if (step.status !== null && notice.kind === 'status') {
+        money = moneyOf(parcel, money, step.status, notice);
+      }
     }
 
     const status = SETTLED.has(parcel.status) ? parcel.status : await this.newest(tx, parcel);
     await tx
       .update(storefrontShipments)
-      .set({ status, lastSyncedAt: now, updatedAt: now })
+      .set({ status, ...money, lastSyncedAt: now, updatedAt: now })
       .where(
         and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
       );
@@ -198,7 +229,9 @@ export class ShipmentNews {
 
   // Delivered posts the invoice, in a savepoint: an invoice the sales rules refuse (a product
   // archived since, a lock date) must not lose the courier's news with it. The order stays
-  // Shipped, and Mark delivered on its page shows the reason to the member who can fix it
+  // Shipped, and Mark delivered on its page shows the reason to the member who can fix it. Step
+  // 28b: the COD receipt is made inside it with no typed amount (the parcel's collected amount,
+  // written above, else its codAmount), and has a savepoint of its own (cod-receipts.ts)
   private async deliver(tx: Transaction, orderId: string): Promise<void> {
     const order = await lockOrder(tx, orderId);
     if (order.status !== 'shipped') return;
```

- **`moneyOf` runs per notice, in arrival order,** and starts from what the parcel has. A later notice with a new
  charge replaces the old one; one with no charge keeps it.
- **The collected amount is cut to `codAmount`** (mine 21). 0080's check would refuse a larger one with a database
  error, and the whole notice would be lost with it; cutting keeps the step, and the raw body keeps the courier's
  own figure for 28c's "different" list.
- **Never once the parcel has its receipt.** 0081's `receipt_kept` refuses a change of the collected amount after
  the link; a courier that sends "delivered" twice with another figure must not make the notice fail.
- **One UPDATE with the status.** The money and the status move together, so the Delivered that follows in the same
  transaction reads the collected amount this notice brought.

### The receipts' method

```diff
@@ -5,6 +5,7 @@ import {
   type PartyRef,
   type Receipt,
   type ReceiptInput,
+  type ReceiptMethod,
   type ReceiptStatus,
   type ReceiptSummary,
   subtractMoney,
@@ -27,6 +28,10 @@ import { type Allocation, allocationChanges, checkAllocations } from './allocati
 import { SalesBooksService } from './sales-books.service.js';
 import { assertBranch, assertCustomer, assertMoneyAccount } from './sales-lines.js';
 
+// Step 28b: what insert() takes: the form's receipt, or a shop's with any of RECEIPT_METHODS. The
+// form's input (ReceiptInput) is one of these, so create() passes it as it is
+type ShopReceiptInput = Omit<ReceiptInput, 'method'> & { method: ReceiptMethod };
+
 type ReceiptRow = typeof receipts.$inferSelect;
 
 const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);
@@ -128,10 +133,12 @@ export class ReceiptsService {
 
   // Step 27d: a shop order's online payment (decision 6), made by the worker in the caller's
   // transaction: posted at once, an advance (no invoice yet), with the gateway's fee in its entry.
-  // Refused with the receipt's own error codes (a closed period, a money account archived since)
+  // Refused with the receipt's own error codes (a closed period, a money account archived since).
+  // Step 28b: and a delivered parcel's COD money, by `courier` (RECEIPT_METHODS), which the form's
+  // own input (ReceiptInput, PAYMENT_METHODS) never takes
   async createForShop(
     tx: Transaction,
-    input: ReceiptInput,
+    input: ShopReceiptInput,
     fee: { accountId: string; amount: string } | null,
   ): Promise<string> {
     return (await this.insert(tx, input, fee)).id;
@@ -330,7 +337,7 @@ export class ReceiptsService {
   // payment's (createForShop, step 27d). currentActorId(): the person, or null for the worker
   private async insert(
     tx: Transaction,
-    input: ReceiptInput,
+    input: ShopReceiptInput,
     fee: { accountId: string; amount: string } | null,
   ): Promise<ReceiptRow> {
     const customer = await assertCustomer(tx, input.customerId);
```

`createForShop` and the private `insert` take `ShopReceiptInput`: the form's input with the method widened to
`RECEIPT_METHODS`. The form's own `create` still takes `ReceiptInput`, so a person can never post a `courier` receipt
by hand (mine 13). No cast: `ReceiptInput` is assignable to `ShopReceiptInput`, so `create` passes it as it is.

```diff
@@ -2,7 +2,7 @@ import {
   type CreditNoteReason,
   type LanguageCode,
   type OutputDocument,
-  type PaymentMethod,
+  type ReceiptMethod,
   SHARE_LINK_DAYS,
 } from '@omnivo/contracts';
 
@@ -78,7 +78,9 @@ export interface DocumentCopy {
   reference: string;
   allocationColumns: { invoice: string; date: string; total: string; amount: string };
   advance: string;
-  methods: Record<PaymentMethod, string>;
+  // Step 28b: a receipt's methods (RECEIPT_METHODS), so a courier's COD receipt prints its own
+  // words; refunds and supplier payments read the same words by their PAYMENT_METHODS
+  methods: Record<ReceiptMethod, string>;
   reasons: Record<CreditNoteReason, string>;
   note: string;
   inWords: (words: string) => string;
@@ -166,6 +168,7 @@ export const DOCUMENT_COPY = {
       cheque: 'Cheque',
       mobile_wallet: 'Mobile wallet',
       card: 'Card',
+      courier: 'Courier COD',
     },
     reasons: {
       goods_returned: 'Goods came back',
@@ -269,6 +272,7 @@ export const DOCUMENT_COPY = {
       cheque: 'চেক',
       mobile_wallet: 'মোবাইল ওয়ালেট',
       card: 'কার্ড',
+      courier: 'কুরিয়ারের COD',
     },
     reasons: {
       goods_returned: 'মাল ফেরত এসেছে',
```

The receipt's PDF prints "Paid by: Courier COD". The words are a `Record` over the methods, so this file stopped
compiling when 28b.2 widened the column's type, which is the point of the `Record`.

### Closing a sales order inside another move

```diff
@@ -306,21 +306,28 @@ export class SalesOrdersService {
   // "delivered" by itself.
   close(id: string, version: number): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
-      const row = await this.lock(tx, id, version);
-      if (row.status !== 'confirmed') throw notConfirmed();
-      if (!(await this.anythingDelivered(tx, id)) && !(await this.anythingInvoiced(tx, id))) {
-        throw new AppError(
-          409,
-          'order_nothing_delivered',
-          'Nothing was delivered or billed for this order. Cancel it instead.',
-        );
-      }
-      await this.write(tx, id, { status: 'closed' });
-      await audit(tx, { action: 'sales_order.closed', entityType: 'sales_order', entityId: id });
+      await this.closeIn(tx, id, version);
       return this.read(tx, id);
     });
   }
 
+  // Step 28b: the close itself, in the caller's transaction, like cancelIn below: the order page's
+  // Close above, and a partly delivered shop order (StorefrontOrdersService), whose return of what
+  // came back opened its sales order again for goods that will never go out
+  async closeIn(tx: Transaction, id: string, version: number | null): Promise<void> {
+    const row = await this.lock(tx, id, version);
+    if (row.status !== 'confirmed') throw notConfirmed();
+    if (!(await this.anythingDelivered(tx, id)) && !(await this.anythingInvoiced(tx, id))) {
+      throw new AppError(
+        409,
+        'order_nothing_delivered',
+        'Nothing was delivered or billed for this order. Cancel it instead.',
+      );
+    }
+    await this.write(tx, id, { status: 'closed' });
+    await audit(tx, { action: 'sales_order.closed', entityType: 'sales_order', entityId: id });
+  }
+
   // Called off before anything left the warehouse
   cancel(id: string, version: number): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
```

`closeIn` is `close` without its own transaction, like 27b's `cancelIn`. The shop order holds its own lock and
passes `null` for the version: the member saw the shop order's version, not the sales order's. Close's rules are
unchanged (confirmed only, something delivered or billed).

### The COD receipt

```ts
import { Injectable, Logger } from '@nestjs/common';
import { compareMoney, isOpenShipment, isZeroMoney, type ShipmentStatus } from '@omnivo/contracts';
import {
  courierAccounts,
  salesOrders,
  storefrontShipments,
  storefrontOrders,
  warehouses,
} from '@omnivo/db';
import { and, desc, eq, notInArray } from 'drizzle-orm';

import { workspaceToday } from '../../common/db/applied-on.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { notify } from '../../notifications/notify.js';
import { membersWhoMay } from '../../notifications/recipients.js';
import { ReceiptsService } from '../../sales/receipts.service.js';
import { memberEvent } from './shipments.js';

type OrderRow = typeof storefrontOrders.$inferSelect;
type ParcelRow = typeof storefrontShipments.$inferSelect;

// Where the rider left the parcel: the two steps that take a COD receipt (0081's receipt_match)
export type DoorStatus = 'delivered' | 'partly_delivered';

// The parcel a Delivered is about, with what its account says about the money
interface DoorParcel {
  parcel: ParcelRow;
  accountName: string;
  codAccountId: string | null;
}

export function collectedOver(codAmount: string): AppError {
  return new AppError(
    422,
    'storefront_order_collected_over',
    'The rider cannot have collected more than the parcel’s COD amount.',
    {
      params: { amount: codAmount },
      fieldErrors: { collectedAmount: ['storefront_order_collected_over'] },
    },
  );
}

function collectedRequired(): AppError {
  return new AppError(
    422,
    'storefront_order_collected_required',
    'Type what the rider collected.',
    { fieldErrors: { collectedAmount: ['storefront_order_collected_required'] } },
  );
}

// Step 28b (decisions 4 and 5, mine 14): a delivered parcel's COD money. At Delivered (the
// member's button, or the courier's news through the same ShopOrderMoves.deliver), after the
// invoice is posted: what the rider collected is written on the parcel, and a posted money receipt
// for it goes into the courier account's COD account, by `courier`, paying the invoice. The
// receipt is made in a savepoint, so a receipt the books refuse (a closed period, a COD account
// archived since) never takes the Delivered and the courier's news with it: its error code stays
// on the parcel, the order needs attention, the bell rings, and "Make the receipt" (retry) makes
// it later. Plain methods over the caller's transaction, which has locked the order first.
@Injectable()
export class ShopCodReceipts {
  private readonly logger = new Logger(ShopCodReceipts.name);

  constructor(private readonly receipts: ReceiptsService) {}

  // `typed`: what the member typed in the Delivered or partly delivered dialog, or null (the
  // courier's news, or an empty box). The amount is, in this order: what was typed, what the
  // courier's notice said (kept on the parcel by shipment-news.ts), and for a whole delivery the
  // parcel's codAmount, the amount the courier was told to collect. A partial delivery has no such
  // fallback: codAmount is for the whole parcel, so with a COD account it must be typed
  async settle(
    tx: Transaction,
    order: OrderRow,
    invoiceId: string,
    typed: string | null,
    at: DoorStatus,
  ): Promise<void> {
    const door = await this.doorParcel(tx, order.id);
    // No courier (the shop's own rider), or a parcel the courier says came back (mine 28): there is
    // no parcel at the door to keep money on. A typed amount says nothing then
    if (door === null) return;
    const { parcel, codAccountId } = door;
    // Delivered once: a parcel with its receipt keeps it and its amount (0081's receipt_kept)
    if (parcel.receiptId !== null) return;
    const collected =
      typed ?? parcel.collectedAmount ?? (at === 'delivered' ? parcel.codAmount : null);
    if (collected === null && codAccountId !== null) throw collectedRequired();
    // Never more than the courier was told to collect (mine 15)
    if (collected !== null && compareMoney(collected, parcel.codAmount) > 0) {
      throw collectedOver(parcel.codAmount);
    }
    // The parcel follows the order (mine 27): a manual parcel always, and an API parcel whose
    // courier's news is late. A receipt links only to a delivered or partly delivered parcel
    const now = new Date();
    const moved = isOpenShipment(parcel.status);
    const status: ShipmentStatus = moved ? at : parcel.status;
    await tx
      .update(storefrontShipments)
      .set({ status, collectedAmount: collected, updatedAt: now })
      .where(
        and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, parcel.id)),
      );
    if (moved) await memberEvent(tx, parcel.id, at, now);
    // No COD account (decision 2: the cash is a receipt typed by hand, as before 28b), or nothing
    // collected (paid online, or the shopper paid nothing at the door): no receipt
    if (codAccountId === null || collected === null || isZeroMoney(collected)) return;

    try {
      await tx.transaction((inner) =>
        this.make(inner, order, { ...parcel, status, collectedAmount: collected }, invoiceId),
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.logger.warn(`Shop order ${order.id}: its COD receipt was refused (${error.code})`);
      await this.keepError(tx, order, door, error.code);
    }
  }

  // "Make the receipt" (StorefrontOrdersService.makeCodReceipt): a delivered parcel whose receipt
  // failed, in the member's transaction. Throws the receipt's own AppError when it is refused
  // again; the caller keeps that code in a transaction of its own, as for a payment's receipt
  async retry(tx: Transaction, order: OrderRow, shipmentId: string): Promise<void> {
    const [parcel] = await tx
      .select()
      .from(storefrontShipments)
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.id, shipmentId),
          eq(storefrontShipments.orderId, order.id),
        ),
      )
      .for('update');
    if (
      parcel?.receiptError == null ||
      parcel.receiptId !== null ||
      parcel.collectedAmount === null ||
      order.invoiceId === null
    ) {
      throw new AppError(
        409,
        'storefront_cod_receipt_not_failed',
        'This parcel’s COD receipt did not fail. Reload the page.',
      );
    }
    await this.make(tx, order, parcel, order.invoiceId);
  }

  // The receipt, linked to the parcel and applied to the invoice. The parcel's collected amount
  // is written already (0081's receipt_match compares it with the receipt's amount)
  private async make(
    tx: Transaction,
    order: OrderRow,
    parcel: ParcelRow,
    invoiceId: string,
  ): Promise<void> {
    const tenantId = getTenantId();
    if (order.salesOrderId === null || parcel.collectedAmount === null) {
      throw new Error(`Parcel ${parcel.id} has no sales order or nothing collected`);
    }
    // The COD account the account names now: one archived since is refused by the receipt's own
    // check (assertMoneyAccount: receipt_account_invalid), which the order page shows
    const [account] = await tx
      .select({ codAccountId: courierAccounts.codAccountId, name: courierAccounts.name })
      .from(courierAccounts)
      .where(
        and(
          eq(courierAccounts.tenantId, tenantId),
          eq(courierAccounts.id, parcel.courierAccountId),
        ),
      )
      .for('share');
    if (account?.codAccountId == null) {
      throw new AppError(
        409,
        'receipt_account_invalid',
        'This courier account has no COD account now. Pick one on Shop couriers.',
      );
    }
    // The customer and the branch of the sales order, as for a payment's receipt (27d)
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
        // The day it is made: the delivery's day, or a retry's in an open period
        date: await workspaceToday(tx),
        amount: parcel.collectedAmount,
        accountId: account.codAccountId,
        method: 'courier',
        // The courier's code, which its payout statement lists (step 28c's matching), else ours
        reference: (parcel.trackingCode ?? parcel.invoice).slice(0, 60),
        branchId: salesOrder.branchId,
        note: `COD for shop order ${order.orderNo ?? ''} (${account.name} ${parcel.invoice})`,
        allocations: [],
      },
      null,
    );
    // The receipt and no error, in one UPDATE (0080's check: never both)
    await tx
      .update(storefrontShipments)
      .set({ receiptId, receiptError: null, updatedAt: new Date() })
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, parcel.id)),
      );
    // As much as the invoice still owes, after any payment made online (decision 6): a rider who
    // collected more than is owed leaves an advance, one who collected less leaves the invoice
    // partly paid
    await this.receipts.applyIn(tx, receiptId, invoiceId);
  }

  // The refusal on the parcel, and the bell (mine 19): the courier's news delivered the order with
  // nobody there to see it. One bell per parcel (its id is the event): a retry that fails again is
  // seen by the member who pressed it
  private async keepError(
    tx: Transaction,
    order: OrderRow,
    door: DoorParcel,
    code: string,
  ): Promise<void> {
    await tx
      .update(storefrontShipments)
      .set({ receiptError: code })
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.id, door.parcel.id),
        ),
      );
    if (order.orderNo === null) return;
    for (const member of await membersWhoMay(tx, 'storefront.order.manage')) {
      await notify(tx, {
        userId: member.userId,
        type: 'storefront.cod_receipt_failed',
        params: { id: order.id, number: order.orderNo, courier: door.accountName },
        eventId: door.parcel.id,
      });
    }
  }

  // The order's newest parcel the courier took: not one still booking or failed (the courier never
  // had it), not a cancelled booking, and not one the courier says came back (mine 28). Locked:
  // the order is locked already, so this waits for nobody
  private async doorParcel(tx: Transaction, orderId: string): Promise<DoorParcel | null> {
    const [row] = await tx
      .select({
        parcel: storefrontShipments,
        accountName: courierAccounts.name,
        codAccountId: courierAccounts.codAccountId,
      })
      .from(storefrontShipments)
      .innerJoin(
        courierAccounts,
        and(
          eq(courierAccounts.tenantId, storefrontShipments.tenantId),
          eq(courierAccounts.id, storefrontShipments.courierAccountId),
        ),
      )
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.orderId, orderId),
          notInArray(storefrontShipments.status, [
            'booking',
            'booking_failed',
            'cancelled',
            'returned',
          ]),
        ),
      )
      .orderBy(desc(storefrontShipments.parcelNo))
      .limit(1)
      .for('update', { of: storefrontShipments });
    return row ?? null;
  }
}
```

- **`settle` is called by Delivered only, after the invoice and after the online payments' advances** (order-moves.ts
  below). The advances go first: they were paid before the rider came, and the COD receipt then pays what they
  left. A rider who collected more than that leaves an advance on the customer, one who collected less leaves the
  invoice partly paid (decision 6). `applyIn` takes the smaller of what is free and what is owed, so neither case
  needs its own code.
- **The amount's three sources, in order** (decision 5): what the member typed, what the courier's notice said,
  then for a whole delivery the parcel's `codAmount`. A partial delivery has no third source: `codAmount` is the
  whole parcel's, so with a COD account and nothing said, `storefront_order_collected_required` asks for it. With no
  COD account nothing is asked: no receipt will be made.
- **`collectedOver` before anything is written.** The check is the API's, not only 0080's: a database error would
  be a 500 with no field to show it under; this is a 422 on the dialog's box with the amount in its words.
- **The parcel is written before the savepoint,** its status and its collected amount, so a refused receipt still
  leaves the parcel delivered with what the rider collected: the retry needs that amount, and 0081 compares the
  receipt with it.
- **The savepoint** (`tx.transaction` inside the caller's): only the receipt's own refusals (`AppError`) are kept.
  Anything else (the database went away) is thrown, and the whole Delivered rolls back, as it should.
- **`make` reads the COD account again, `FOR SHARE`,** at the moment it is used: an account changed or archived
  after the parcel was booked is the one that counts now. An account with no COD account any more is refused with
  `receipt_account_invalid`, the same code the receipt's own `assertMoneyAccount` gives for an archived one, so the
  order page has one sentence for both.
- **The receipt and `receiptError: null` in one UPDATE:** 0080's check refuses both at once, and a retry must clear
  the old error as it links.
- **`keepError` rings the bell for every member who may move orders,** with the order's number and the account's
  name, never the shopper's (a bell is seen over a shoulder, 28a's rule). The parcel's id is the bell's event, so a
  second refusal of the same parcel rings no second time (mine 31).
- **`doorParcel`** is the order's newest parcel the courier took. Still booking, failed, cancelled and returned are
  left out (mine 28). It is locked `FOR UPDATE` after the order: every writer of a parcel locks the order first
  (28a), so this waits for nobody.

### Delivered, with what came back

```diff
@@ -1,7 +1,11 @@
 import { Injectable } from '@nestjs/common';
 import {
+  type AuditAction,
+  billableQuantity,
   compareMoney,
+  compareQuantity,
   multiplyMoney,
+  prorateMoney,
   spreadMoney,
   type StorefrontOrderStatus,
   todayIn,
@@ -22,6 +26,7 @@ import { AppError, notFound } from '../../common/http/app-error.js';
 import { currentActorId, getTenantId } from '../../common/tenant/tenant-context.js';
 import type { Transaction } from '../../common/tenant/with-tenant.js';
 import { InvoicesService } from '../../sales/invoices.service.js';
+import { ShopCodReceipts } from '../shipping/cod-receipts.js';
 import type { OrderLineRow, OrderRow } from './order-view.js';
 import { ShopPaymentReceipts } from './payment-receipts.js';
 
@@ -51,6 +56,7 @@ export type OrderMove = Partial<
     | 'deliveredAt'
     | 'cancelledAt'
     | 'cancelReason'
+    | 'returnedAt'
     | 'deliveryId'
     | 'invoiceId'
     | 'salesReturnId'
@@ -58,11 +64,14 @@ export type OrderMove = Partial<
 > & { status: StorefrontOrderStatus };
 
 // The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
-// reads them together), the version up, and the audit row of the move
+// reads them together), the version up, and the audit row of the move. Step 28b: `note` names
+// another action for the same status (a partly delivered order is Delivered, with its own audit
+// action) and adds what the audit row should say about it
 export async function moveOrder(
   tx: Transaction,
   before: OrderRow,
   fields: OrderMove,
+  note: { action?: AuditAction; changes?: Record<string, string | number | null> } = {},
 ): Promise<void> {
   await tx
     .update(storefrontOrders)
@@ -78,9 +87,10 @@ export async function moveOrder(
     shipped: 'storefront_order.shipped',
     delivered: 'storefront_order.delivered',
     cancelled: 'storefront_order.cancelled',
-    returned: null,
-  } as const satisfies Record<StorefrontOrderStatus, string | null>;
-  const name = action[fields.status];
+    // Step 28b: Receive the return
+    returned: 'storefront_order.returned',
+  } as const satisfies Record<StorefrontOrderStatus, AuditAction | null>;
+  const name = note.action ?? action[fields.status];
   if (name === null) throw new Error(`No audit action for ${fields.status}`);
   await audit(tx, {
     action: name,
@@ -92,6 +102,7 @@ export async function moveOrder(
         order: before.orderNo,
         status: fields.status,
         ...(fields.cancelReason === undefined ? {} : { reason: fields.cancelReason }),
+        ...note.changes,
       },
     ),
   });
@@ -169,6 +180,7 @@ export class ShopOrderMoves {
   constructor(
     private readonly invoices: InvoicesService,
     private readonly paymentReceipts: ShopPaymentReceipts,
+    private readonly codReceipts: ShopCodReceipts,
   ) {}
 
   // 27b's decision 6: a status only. Step 28a: the courier's "picked up" calls it too
@@ -179,8 +191,20 @@ export class ShopOrderMoves {
 
   // 27b's decision 7: a posted invoice for what the challan took and the delivery charge, dated
   // today (decision 21) and unpaid: the cash the rider brings back is a money receipt. Step 28a:
-  // the courier's "delivered" calls it too
-  async deliver(tx: Transaction, order: OrderRow): Promise<void> {
+  // the courier's "delivered" calls it too. Step 28b: then the rider's COD receipt (decision 4,
+  // cod-receipts.ts) for `collected` (what the member typed, or null), and with `partial` (the
+  // sales return of what came back, made just before in this transaction) the invoice bills only
+  // what the shopper kept (decision 6), the order's audit row says partly delivered, and the
+  // parcel is partly delivered
+  async deliver(
+    tx: Transaction,
+    order: OrderRow,
+    collected: string | null = null,
+    partial: {
+      salesReturnId: string;
+      changes: Record<string, string | number | null>;
+    } | null = null,
+  ): Promise<void> {
     if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
     const salesOrder = await salesOrderOf(tx, order);
     const orderLines = await orderLinesOf(tx, order.id);
@@ -207,25 +231,37 @@ export class ShopOrderMoves {
     // Each challan line at its order line's price and VAT rate; then the delivery charge, the
     // sales order's lines after the order's own (the maker added it last). Step 27c: and with
     // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
-    // would bill more than the shopper pays
+    // would bill more than the shopper pays. Step 28b: what a line bills is what did not come back
+    // before the invoice (billableQuantity, the invoice's own rule, 15d), with its discount cut in
+    // the same proportion: 1 of 2 pieces kept keeps half the coupon. A shop's challan is in the
+    // base unit (the maker's sales order is), so the quantity is the base quantity. A line that
+    // came back whole is not billed at all
     const discounts = challanDiscounts(challan, soLineById);
-    const goods = challan.map((line) => {
+    const goods = challan.flatMap((line) => {
       const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
       if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
-      return {
-        variantId: line.variantId,
-        unitId: line.unitId,
-        quantity: line.quantity,
-        description: soLine.description,
-        unitPrice: soLine.unitPrice,
-        discountType: 'amount' as const,
-        discount: discounts.get(line.id) ?? '0',
-        taxRateId: soLine.taxRateId,
-        deliveryLineId: line.id,
-        orderLineId: null,
-        batchId: null,
-        serialNumbers: [],
-      };
+      const kept = billableQuantity(line);
+      if (compareQuantity(kept, '0') <= 0) return [];
+      const share = discounts.get(line.id) ?? '0';
+      return [
+        {
+          variantId: line.variantId,
+          unitId: line.unitId,
+          quantity: kept,
+          description: soLine.description,
+          unitPrice: soLine.unitPrice,
+          discountType: 'amount' as const,
+          discount:
+            compareQuantity(kept, line.baseQuantity) === 0
+              ? share
+              : prorateMoney(share, kept, line.baseQuantity),
+          taxRateId: soLine.taxRateId,
+          deliveryLineId: line.id,
+          orderLineId: null,
+          batchId: null,
+          serialNumbers: [],
+        },
+      ];
     });
     const charges = soLines.slice(orderLines.length).map((soLine) => ({
       variantId: soLine.variantId,
@@ -258,7 +294,27 @@ export class ShopOrderMoves {
     });
     // Step 27d (decision 6): a paid online order's advance pays its invoice at once
     await this.paymentReceipts.applyToInvoice(tx, order.id, invoiceId);
-    await moveOrder(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
+    await moveOrder(
+      tx,
+      order,
+      {
+        status: 'delivered',
+        deliveredAt: new Date(),
+        invoiceId,
+        ...(partial === null ? {} : { salesReturnId: partial.salesReturnId }),
+      },
+      partial === null
+        ? {}
+        : { action: 'storefront_order.partly_delivered', changes: partial.changes },
+    );
+    // Step 28b: the rider's money, after the advances: the COD receipt pays what they left
+    await this.codReceipts.settle(
+      tx,
+      order,
+      invoiceId,
+      collected,
+      partial === null ? 'delivered' : 'partly_delivered',
+    );
   }
 }
 
```

- **`moveOrder`'s `note`:** a partly delivered order is Delivered (the status the documents check knows), but its
  audit row says `storefront_order.partly_delivered` with what came back. Returned now has its action too.
  `AuditAction` in the `satisfies` makes a typo in the table a compile error, which `string` did not.
- **`billableQuantity(line)`** is the invoice's own rule (15d): what the challan line took less what came back before
  it was billed. The invoice refuses any other quantity on a challan line (`invoice_delivery_line_invalid`), so the
  shop's invoice uses the same function instead of working it out again. A line that came back whole is not
  billed: a zero quantity is no line.
- **The discount follows the kept quantity** (mine 32). `prorateMoney` rounds to the paisa; the full quantity takes
  the share as it is, so an order with nothing back bills exactly what it did before 28b.
- **`settle` after `moveOrder`.** The order is Delivered in this transaction before the receipt is made, so the
  receipt's audit row and the order's agree on the moment; a refused receipt does not undo the move (its
  savepoint).

### The shipments' view, the list's pills

```diff
@@ -5,11 +5,13 @@ import {
   isErrorCode,
   isOpenShipment,
   OPEN_SHIPMENT_STATUSES,
+  type ShipmentStatus,
   type ShopShipmentStatus,
   type StorefrontShipment,
 } from '@omnivo/contracts';
 import {
   courierAccounts,
+  receipts,
   storefrontOrders,
   storefrontPayments,
   storefrontShipmentEvents,
@@ -90,8 +92,9 @@ async function parcelsOf(tx: Transaction, orderId: string, lock: boolean): Promi
 }
 
 // One step a member took for a parcel (a manual parcel's booking, a cancel): the same row the
-// courier's news writes, so the order page and the tracking page draw it the same way
-async function memberEvent(
+// courier's news writes, so the order page and the tracking page draw it the same way. Step 28b:
+// exported for Delivered and what came back (cod-receipts.ts, the return)
+export async function memberEvent(
   tx: Transaction,
   shipmentId: string,
   status: ShopShipmentStatus,
@@ -279,14 +282,15 @@ export async function cancelShipments(tx: Transaction, order: OrderRow): Promise
   await memberEvent(tx, open.id, 'cancelled', now);
 }
 
-// Mark shipped and Mark delivered on an order whose parcel was booked by hand (decision 5: a
-// manual parcel keeps the buttons): the parcel follows, so the tracking page shows the step too.
-// An API parcel is moved by its courier only; the buttons still move its order (a courier whose
-// news stopped), and the courier's later news adds its own steps
+// Mark shipped on an order whose parcel was booked by hand (decision 5: a manual parcel keeps the
+// buttons): the parcel follows, so the tracking page shows the step too. An API parcel is moved by
+// its courier only; the button still moves its order (a courier whose news stopped), and the
+// courier's later news adds its own steps. Step 28b: Mark delivered moves the parcel itself
+// (cod-receipts.ts), an API parcel too, because its COD receipt needs a delivered parcel (mine 27)
 export async function followOrder(
   tx: Transaction,
   orderId: string,
-  status: 'picked_up' | 'delivered',
+  status: 'picked_up',
 ): Promise<void> {
   const [open] = await tx
     .select({ id: storefrontShipments.id })
@@ -328,6 +332,9 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
       parcel: storefrontShipments,
       accountName: courierAccounts.name,
       provider: courierAccounts.provider,
+      codAccountId: courierAccounts.codAccountId,
+      // Step 28b: the COD receipt's number, for the parcel card's link
+      receiptNumber: receipts.number,
     })
     .from(storefrontShipments)
     .innerJoin(
@@ -337,6 +344,13 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
         eq(courierAccounts.id, storefrontShipments.courierAccountId),
       ),
     )
+    .leftJoin(
+      receipts,
+      and(
+        eq(receipts.tenantId, storefrontShipments.tenantId),
+        eq(receipts.id, storefrontShipments.receiptId),
+      ),
+    )
     .where(
       and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
     )
@@ -361,14 +375,28 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
       ),
     )
     .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
-  return rows.map(({ parcel, accountName, provider }) => ({
+  return rows.map(({ parcel, accountName, provider, codAccountId, receiptNumber }) => ({
     id: parcel.id,
-    account: { id: parcel.courierAccountId, name: accountName, provider },
+    account: {
+      id: parcel.courierAccountId,
+      name: accountName,
+      provider,
+      hasCodAccount: codAccountId !== null,
+    },
     courier: parcel.courier,
     status: parcel.status,
     consignmentId: parcel.consignmentId,
     trackingCode: parcel.trackingCode,
     codAmount: parcel.codAmount,
+    // Step 28b (decisions 4 and 5)
+    collectedAmount: parcel.collectedAmount,
+    courierCharge: parcel.courierCharge,
+    receipt:
+      parcel.receiptId === null || receiptNumber === null
+        ? null
+        : { id: parcel.receiptId, number: receiptNumber },
+    receiptError:
+      parcel.receiptError !== null && isErrorCode(parcel.receiptError) ? parcel.receiptError : null,
     bookedAt: parcel.bookedAt?.toISOString() ?? null,
     attempts: parcel.attempts,
     error: parcel.error !== null && isErrorCode(parcel.error) ? parcel.error : null,
@@ -389,8 +417,9 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
 // The list's "Needs attention" (28a.1): a packed order whose last parcel failed to book. A
 // correlated EXISTS over the order's few parcels (storefront_shipments_parcel_key finds them).
 // storefront_orders is written out, as 27b's itemCount does: in a select's fields Drizzle writes a
-// column without its table, and an unqualified "tenant_id" in the subquery would be its own row's
-export const parcelNeedsAttention = sql<boolean>`(storefront_orders.status = 'packed' AND EXISTS (
+// column without its table, and an unqualified "tenant_id" in the subquery would be its own row's.
+// Step 28b: or a parcel of any status whose COD receipt could not be made (decision 4)
+export const parcelNeedsAttention = sql<boolean>`((storefront_orders.status = 'packed' AND EXISTS (
   SELECT 1 FROM storefront_shipments s
   WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
     AND s.status = 'booking_failed'
@@ -398,8 +427,20 @@ export const parcelNeedsAttention = sql<boolean>`(storefront_orders.status = 'pa
       SELECT 1 FROM storefront_shipments t
       WHERE t.tenant_id = s.tenant_id AND t.order_id = s.order_id AND t.parcel_no > s.parcel_no
     )
+)) OR EXISTS (
+  SELECT 1 FROM storefront_shipments c
+  WHERE c.tenant_id = storefront_orders.tenant_id AND c.order_id = storefront_orders.id
+    AND c.receipt_error IS NOT NULL
 ))`;
 
+// Step 28b (mine 18): the list's parcelStatus, the status of the order's newest parcel, or NULL.
+// Written out like parcelNeedsAttention. The column's check keeps it one of SHIPMENT_STATUSES
+export const newestParcelStatus = sql<ShipmentStatus | null>`(
+  SELECT s.status FROM storefront_shipments s
+  WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
+  ORDER BY s.parcel_no DESC LIMIT 1
+)`;
+
 // Step 28a.6: what the Packed dialog and Book courier offer (courierChoicesSchema). Active
 // accounts only, by name. The default comes from the same rows: 28a.2's check keeps it an active
 // API account, so it is always one of them
```

- **`memberEvent` is exported** for the COD receipt and Receive the return: a step a member took is the same row as
  the courier's, so the tracking page and the order page draw it the same way.
- **`followOrder` takes `picked_up` only** (mine 27). Its type says so, so a caller that still passed `delivered`
  would not compile.
- **The view's new fields** read the receipt's number with a left join (a parcel without a receipt still shows), and
  the stored error code like the payment's: one this API no longer knows reads as none.
- **`parcelNeedsAttention`'s second half:** a parcel of any status with a refused COD receipt. An order is
  Delivered by then, so the first half (packed, booking failed) does not cover it.
- **`newestParcelStatus`** is the list's `parcelStatus` (mine 18), the order's newest parcel by `parcel_no`, written
  out with the table's name for 28a's reason (a bare `tenant_id` in a select's subquery is the subquery's own).

### The order's routes

```diff
@@ -1,13 +1,18 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
+  billableQuantity,
   type BookShipmentInput,
   compareQuantity,
+  type DeliverStorefrontOrderInput,
   type CourierChoices,
   type CourierExport,
   type DocumentRef,
   type ErrorCode,
   isErrorCode,
   type PackStorefrontOrderInput,
+  type PartlyDeliverStorefrontOrderInput,
+  type ReturnStorefrontOrderInput,
+  type ShipmentStatus,
   type StorefrontOrder,
   type StorefrontOrderCounts,
   type StorefrontOrderPage,
@@ -17,6 +22,7 @@ import {
   type StorefrontOrderStatus,
   type StorefrontOrderSummary,
   type StorefrontPackPlan,
+  type StorefrontReturnPlan,
   storefrontImageSchema,
   sumQuantity,
   subtractQuantity,
@@ -31,6 +37,7 @@ import {
   productVariants,
   receipts,
   salesOrders,
+  salesOrderLines,
   salesReturns,
   stockBalances,
   courierAccounts,
@@ -39,13 +46,27 @@ import {
   storefrontOrders,
   storefrontPayments,
   storefrontSettings,
+  storefrontShipments,
   storefrontStockHolds,
   units,
   warehouses,
 } from '@omnivo/db';
-import { and, asc, eq, gt, inArray, ne, type SQL, sql } from 'drizzle-orm';
+import {
+  and,
+  asc,
+  desc,
+  eq,
+  gt,
+  inArray,
+  isNull,
+  ne,
+  notInArray,
+  type SQL,
+  sql,
+} from 'drizzle-orm';
 import { z } from 'zod';
 
+import { audit, created } from '../../common/audit/audit.js';
 import { containsPattern } from '../../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
 import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
@@ -56,7 +77,7 @@ import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
 import { DeliveriesService } from '../../sales/deliveries.service.js';
 import { SalesOrdersService } from '../../sales/sales-orders.service.js';
 import { SalesReturnsService } from '../../sales/sales-returns.service.js';
-import { cancelledSms } from '../../sms/shop-sms.js';
+import { cancelledSms, returnedSms } from '../../sms/shop-sms.js';
 import { SmsQueue } from '../../sms/sms-queue.js';
 import { isoText } from '../listing-sql.js';
 import { shopImage } from '../media.js';
@@ -71,11 +92,14 @@ import {
   stepInvalid,
 } from './order-moves.js';
 import { codAmountOf, historyOf, type OrderRow } from './order-view.js';
+import { ShopCodReceipts } from '../shipping/cod-receipts.js';
 import {
   cancelShipments,
   courierChoicesOf,
   courierExportRows,
   followOrder,
+  memberEvent,
+  newestParcelStatus,
   parcelNeedsAttention,
   retryShipment,
   shipmentsOf,
@@ -153,11 +177,13 @@ function numberOf(order: OrderRow): string {
 }
 
 // Step 28a: parcelAttention is the parcel's half of "Needs attention" (its last booking failed),
-// worked out by the caller: in SQL for the list, from the parcels for the order page
+// worked out by the caller: in SQL for the list, from the parcels for the order page. Step 28b:
+// parcelStatus, the newest parcel's status (or null), the same way
 function summaryOf(
   order: OrderRow,
   items: number,
   parcelAttention: boolean,
+  parcelStatus: ShipmentStatus | null,
 ): StorefrontOrderSummary {
   return {
     id: order.id,
@@ -172,6 +198,7 @@ function summaryOf(
     itemCount: items,
     total: order.total,
     needsAttention: order.documentError !== null || parcelAttention,
+    parcelStatus,
   };
 }
 
@@ -225,6 +252,7 @@ export class StorefrontOrdersService {
     private readonly sms: SmsQueue,
     private readonly paymentReceipts: ShopPaymentReceipts,
     private readonly moves: ShopOrderMoves,
+    private readonly codReceipts: ShopCodReceipts,
   ) {
     this.mediaUrl = config.storefront.mediaUrl;
   }
@@ -259,6 +287,7 @@ export class StorefrontOrdersService {
           items: itemCount,
           sortKey: sort.text,
           parcelAttention: parcelNeedsAttention,
+          parcelStatus: newestParcelStatus,
         })
         .from(storefrontOrders)
         .where(and(...filters))
@@ -266,7 +295,9 @@ export class StorefrontOrdersService {
         .limit(q.limit + 1);
       const page = toPage(rows, q.limit, (last) => [q.sort, last.sortKey, last.order.id]);
       return {
-        items: page.items.map((row) => summaryOf(row.order, row.items, row.parcelAttention)),
+        items: page.items.map((row) =>
+          summaryOf(row.order, row.items, row.parcelAttention, row.parcelStatus),
+        ),
         nextCursor: page.nextCursor,
       };
     });
@@ -540,16 +571,233 @@ export class StorefrontOrdersService {
     });
   }
 
-  // Decision 7: the invoice (order-moves.ts)
-  deliver(id: string, version: number): Promise<StorefrontOrder> {
+  // Decision 7: the invoice (order-moves.ts). Step 28b: and the rider's COD receipt for what the
+  // member typed (decision 5); the parcel follows inside (cod-receipts.ts), so no followOrder
+  deliver(id: string, input: DeliverStorefrontOrderInput): Promise<StorefrontOrder> {
     return this.withTenant(async (tx) => {
-      const order = await this.lock(tx, id, version);
-      await this.moves.deliver(tx, order);
-      await followOrder(tx, id, 'delivered');
+      const order = await this.lock(tx, id, input.version);
+      await this.moves.deliver(tx, order, input.collectedAmount);
       return this.read(tx, id);
     });
   }
 
+  // Step 28b: what "Record what came back" opens with: the challan's lines, one per batch, with
+  // what each took and, for a serial product, its pieces. Like packPlan, a read behind
+  // storefront.order.manage
+  returnPlan(id: string): Promise<StorefrontReturnPlan> {
+    return this.withTenant(async (tx) => {
+      const order = await this.find(tx, id);
+      if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
+      const [warehouse] = await tx
+        .select({ id: warehouses.id, name: warehouses.name })
+        .from(deliveries)
+        .innerJoin(
+          warehouses,
+          and(
+            eq(warehouses.tenantId, deliveries.tenantId),
+            eq(warehouses.id, deliveries.warehouseId),
+          ),
+        )
+        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, order.deliveryId)));
+      if (!warehouse) throw new Error(`Challan ${order.deliveryId} is missing`);
+      const lines = await this.challanLinesOf(tx, order);
+      return {
+        warehouse,
+        // The plan's own fields only: the ids the return needs stay in the API
+        lines: lines.map((line) => ({
+          deliveryLineId: line.deliveryLineId,
+          position: line.position,
+          name: line.name,
+          packSize: line.packSize,
+          sku: line.sku,
+          unitCode: line.unitCode,
+          quantity: line.quantity,
+          tracking: line.tracking,
+          batch: line.batch,
+          serialNumbers: line.serialNumbers,
+        })),
+      };
+    });
+  }
+
+  // Step 28b (decision 6): the shopper kept part of the parcel. In one transaction: a posted sales
+  // return of what came back (before the invoice, so 15d's rule bills only what was kept), the
+  // invoice of the rest and the delivery charge, the COD receipt for what the rider collected,
+  // then the sales order closed (the return opened it again for goods that will not go out). The
+  // order is Delivered, with its return
+  partlyDeliver(id: string, input: PartlyDeliverStorefrontOrderInput): Promise<StorefrontOrder> {
+    return this.withTenant(async (tx) => {
+      const order = await this.lock(tx, id, input.version);
+      if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
+      const challan = await this.challanLinesOf(tx, order);
+      const byId = new Map(challan.map((line) => [line.deliveryLineId, line]));
+      // Only the challan's own lines (the return's rules would say the same as
+      // return_delivery_line_invalid, but under its own line numbers; here it is the dialog's)
+      const fieldErrors: Record<string, ErrorCode[]> = {};
+      input.lines.forEach((line, index) => {
+        if (!byId.has(line.deliveryLineId)) {
+          fieldErrors[`lines.${String(index)}.deliveryLineId`] = ['storefront_order_line_missing'];
+        }
+      });
+      const [first] = Object.values(fieldErrors);
+      if (first?.[0] !== undefined) throw linesError(first[0], fieldErrors);
+      // Every piece back is Receive the return (mine 16): that order is Returned, not Delivered
+      const back = new Map(input.lines.map((line) => [line.deliveryLineId, line.quantity]));
+      if (
+        challan.every(
+          (line) => compareQuantity(back.get(line.deliveryLineId) ?? '0', line.quantity) >= 0,
+        )
+      ) {
+        throw new AppError(
+          409,
+          'storefront_order_return_everything',
+          'Every piece came back. Use Receive the return instead.',
+        );
+      }
+      const salesReturnId = await this.salesReturns.createIn(tx, {
+        customerId: (await salesOrderOf(tx, order)).customerId,
+        date: await shopToday(tx),
+        warehouseId: (await this.challanWarehouse(tx, order.deliveryId)).id,
+        reason: 'other',
+        note: input.reason,
+        // In the dialog's order, so the return's own field errors (a quantity over what the line
+        // took, a serial number that was not in the box) land under the dialog's rows
+        lines: input.lines.map((line) => {
+          const from = byId.get(line.deliveryLineId);
+          if (from === undefined) throw new Error(`Challan line ${line.deliveryLineId} is missing`);
+          return {
+            variantId: from.variantId,
+            unitId: from.unitId,
+            quantity: line.quantity,
+            batchId: from.batchId,
+            serialNumbers: line.serialNumbers,
+            deliveryLineId: line.deliveryLineId,
+          };
+        }),
+        post: true,
+      });
+      await this.moves.deliver(tx, order, input.collectedAmount, {
+        salesReturnId,
+        changes: { cameBack: input.lines.length, reason: input.reason },
+      });
+      if (order.salesOrderId !== null) {
+        await this.salesOrders.closeIn(tx, order.salesOrderId, null);
+      }
+      return this.read(tx, id);
+    });
+  }
+
+  // Step 28b (decision 7): the whole parcel is back on the shelf. A posted sales return of the
+  // whole challan, the sales order cancelled (mine 29: after the return it has nothing delivered,
+  // which the sales rules call a cancel), the parcel returned, the order Returned, and the
+  // shopper's SMS once it has committed. Never on the courier's word alone: the member presses it
+  async returnOrder(id: string, input: ReturnStorefrontOrderInput): Promise<StorefrontOrder> {
+    const { order, sms } = await this.withTenant(async (tx) => {
+      const before = await this.lock(tx, id, input.version);
+      if (before.status !== 'shipped') throw stepInvalid();
+      const salesReturnId = await this.returnChallan(tx, before, input.reason);
+      if (before.salesOrderId !== null) {
+        await this.salesOrders.cancelIn(tx, before.salesOrderId, null);
+      }
+      // The parcel the courier had, unless the courier said returned already. A delivered one
+      // the courier was wrong about comes back too (0078's guard lets it); its COD receipt, if
+      // any, stays: the money was posted and is voided by hand (mine 26)
+      const [parcel] = await tx
+        .select({ id: storefrontShipments.id, status: storefrontShipments.status })
+        .from(storefrontShipments)
+        .where(
+          and(
+            eq(storefrontShipments.tenantId, getTenantId()),
+            eq(storefrontShipments.orderId, id),
+            notInArray(storefrontShipments.status, ['booking', 'booking_failed', 'cancelled']),
+          ),
+        )
+        .orderBy(desc(storefrontShipments.parcelNo))
+        .limit(1)
+        .for('update');
+      if (parcel !== undefined && parcel.status !== 'returned') {
+        const now = new Date();
+        await tx
+          .update(storefrontShipments)
+          .set({ status: 'returned', updatedAt: now })
+          .where(
+            and(
+              eq(storefrontShipments.tenantId, getTenantId()),
+              eq(storefrontShipments.id, parcel.id),
+            ),
+          );
+        await memberEvent(tx, parcel.id, 'returned', now);
+      }
+      await moveOrder(
+        tx,
+        before,
+        { status: 'returned', returnedAt: new Date(), salesReturnId },
+        { changes: { reason: input.reason } },
+      );
+      const [shop] = await tx
+        .select({
+          language: storefrontSettings.language,
+          name: storefrontSettings.name,
+          hotline: storefrontSettings.hotline,
+        })
+        .from(storefrontSettings)
+        .where(eq(storefrontSettings.tenantId, getTenantId()));
+      return {
+        order: await this.read(tx, id),
+        sms:
+          shop === undefined
+            ? null
+            : {
+                to: before.phone,
+                text: returnedSms(shop.language, shop.name, numberOf(before), shop.hotline),
+              },
+      };
+    });
+    // After the commit, as for a cancel
+    if (sms !== null) await this.sms.send(sms);
+    return order;
+  }
+
+  // Step 28b: "Make the receipt" on a parcel whose COD receipt was refused (decision 4). The same
+  // receipt Delivered makes, in this request's transaction; a refusal is kept on the parcel again,
+  // in its own transaction (this one rolls back), as makePaymentReceipt keeps a payment's
+  async makeCodReceipt(id: string, shipmentId: string, version: number): Promise<StorefrontOrder> {
+    try {
+      return await this.withTenant(async (tx) => {
+        const order = await this.lock(tx, id, version);
+        await this.codReceipts.retry(tx, order, shipmentId);
+        // The version moves on, so another tab that still shows the error reloads first
+        await tx
+          .update(storefrontOrders)
+          .set({
+            version: sql`${storefrontOrders.version} + 1`,
+            updatedBy: currentPrincipal().userId,
+          })
+          .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, id)));
+        await audit(tx, {
+          action: 'storefront_order.cod_receipt_made',
+          entityType: 'storefront_order',
+          entityId: id,
+          changes: created({ order: numberOf(order) }),
+        });
+        return this.read(tx, id);
+      });
+    } catch (error) {
+      if (
+        error instanceof AppError &&
+        ![
+          'storefront_cod_receipt_not_failed',
+          'version_conflict',
+          'not_found',
+          'storefront_order_step_invalid',
+        ].includes(error.code)
+      ) {
+        await this.keepCodError(shipmentId, error.code);
+      }
+      throw error;
+    }
+  }
+
   // Decision 8: a new order's sales order is cancelled and its hold ends; a packed one's goods
   // come back on a posted sales return of the whole challan first, and then its sales order (which
   // the return opened again, with nothing delivered) is cancelled. After shipping it is step 28's
@@ -611,8 +859,13 @@ export class StorefrontOrdersService {
     return order;
   }
 
-  // The whole challan back, into the warehouse it left from, at what it cost (15d's rule)
-  private async returnChallan(tx: Transaction, order: OrderRow): Promise<string> {
+  // The whole challan back, into the warehouse it left from, at what it cost (15d's rule). Step
+  // 28b: Receive the return too, with the member's reason on the return's note
+  private async returnChallan(
+    tx: Transaction,
+    order: OrderRow,
+    note: string | null = null,
+  ): Promise<string> {
     if (order.deliveryId === null || order.salesOrderId === null) throw stepInvalid();
     const [challan] = await tx
       .select({ customerId: deliveries.customerId, warehouseId: deliveries.warehouseId })
@@ -636,7 +889,7 @@ export class StorefrontOrdersService {
       // The return's own list of reasons has no "order cancelled"; the shop order's page says
       // why, and the return's audit row names the order through its challan
       reason: 'other',
-      note: null,
+      note,
       lines: lines.map((line) => ({
         variantId: line.variantId,
         unitId: line.unitId,
@@ -665,6 +918,108 @@ export class StorefrontOrdersService {
     });
   }
 
+  // Step 28b: a refused COD receipt's code, kept only while the parcel has no receipt (a second
+  // tab's retry may have made it meanwhile)
+  private async keepCodError(shipmentId: string, code: ErrorCode): Promise<void> {
+    await this.withTenant(async (tx) => {
+      await tx
+        .update(storefrontShipments)
+        .set({ receiptError: code })
+        .where(
+          and(
+            eq(storefrontShipments.tenantId, getTenantId()),
+            eq(storefrontShipments.id, shipmentId),
+            isNull(storefrontShipments.receiptId),
+          ),
+        );
+    });
+  }
+
+  private async challanWarehouse(tx: Transaction, deliveryId: string) {
+    const [challan] = await tx
+      .select({ id: deliveries.warehouseId })
+      .from(deliveries)
+      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, deliveryId)));
+    if (!challan) throw new Error(`Challan ${deliveryId} is missing`);
+    return challan;
+  }
+
+  // Step 28b: the challan's lines as the return plan shows them, in the challan's order, each with
+  // the order line it was packed for (the sales order's line i + 1 is the order's line i, the
+  // maker's rule), what the variant is now and its batch
+  private async challanLinesOf(tx: Transaction, order: OrderRow) {
+    if (order.deliveryId === null || order.salesOrderId === null) throw stepInvalid();
+    const tenantId = getTenantId();
+    const rows = await tx
+      .select({
+        line: deliveryLines,
+        lineNo: salesOrderLines.lineNo,
+        sku: productVariants.sku,
+        unitCode: units.code,
+        tracking: products.tracking,
+        lotNumber: batches.lotNumber,
+        expiresOn: batches.expiresOn,
+      })
+      .from(deliveryLines)
+      .innerJoin(
+        salesOrderLines,
+        and(
+          eq(salesOrderLines.tenantId, deliveryLines.tenantId),
+          eq(salesOrderLines.id, deliveryLines.orderLineId),
+        ),
+      )
+      .innerJoin(
+        productVariants,
+        and(
+          eq(productVariants.tenantId, deliveryLines.tenantId),
+          eq(productVariants.id, deliveryLines.variantId),
+        ),
+      )
+      .innerJoin(
+        products,
+        and(
+          eq(products.tenantId, productVariants.tenantId),
+          eq(products.id, productVariants.productId),
+        ),
+      )
+      .innerJoin(
+        units,
+        and(eq(units.tenantId, products.tenantId), eq(units.id, products.baseUnitId)),
+      )
+      .leftJoin(
+        batches,
+        and(eq(batches.tenantId, deliveryLines.tenantId), eq(batches.id, deliveryLines.batchId)),
+      )
+      .where(
+        and(eq(deliveryLines.tenantId, tenantId), eq(deliveryLines.deliveryId, order.deliveryId)),
+      )
+      .orderBy(asc(deliveryLines.lineNo));
+    const orderLines = new Map(
+      (await orderLinesOf(tx, order.id)).map((line) => [line.position, line]),
+    );
+    return rows.map(({ line, lineNo, sku, unitCode, tracking, lotNumber, expiresOn }) => {
+      const ordered = orderLines.get(lineNo);
+      if (ordered === undefined) throw new Error(`Challan line ${line.id} has no shop order line`);
+      return {
+        deliveryLineId: line.id,
+        position: ordered.position,
+        name: ordered.name,
+        packSize: ordered.packSize,
+        sku,
+        unitCode,
+        // What is still out: a challan line of a shipped order has nothing back yet
+        quantity: billableQuantity(line),
+        tracking,
+        batch: lotNumber === null ? null : { lotNumber, expiresOn },
+        serialNumbers: line.serialNumbers,
+        // For partlyDeliver's return lines, not the plan's answer
+        variantId: line.variantId,
+        unitId: line.unitId,
+        batchId: line.batchId,
+      };
+    });
+  }
+
   // Step 28a: Packed books with an active API account only (28a.1's packStorefrontOrderInputSchema):
   // a manual parcel needs the courier's code, which does not exist before the box is handed over
   private async bookableAtPack(tx: Transaction, accountId: string): Promise<void> {
@@ -861,7 +1216,10 @@ export class StorefrontOrdersService {
       ...summaryOf(
         order,
         lines.reduce((count, { line }) => count + line.quantity, 0),
-        order.status === 'packed' && last?.status === 'booking_failed',
+        // Step 28b: or a parcel's COD receipt was refused (parcelNeedsAttention's second half)
+        (order.status === 'packed' && last?.status === 'booking_failed') ||
+          shipments.some((shipment) => shipment.receiptError !== null),
+        last?.status ?? null,
       ),
       address: order.address,
       history: historyOf(order),
```

- **`summaryOf` takes `parcelStatus`** from the caller: the list's SQL, or the order page's parcels.
- **`deliver` takes the input** with the typed amount. The parcel moves inside `settle`, so the old `followOrder(…,
  'delivered')` is gone.
- **`returnPlan`** answers only the plan's fields: the ids the return needs (variant, unit, batch) stay in the API,
  and an answer with more than its schema would leak them to the page.
- **`partlyDeliver`:**
  - The lines are checked against this order's challan first, with the dialog's own line numbers. The sales return
    would refuse another challan's line too, but as its own field error, under a line the dialog does not have.
  - **Every piece back is refused** (`storefront_order_return_everything`, mine 16): that order is Returned, with no
    invoice, which Record what came back cannot make.
  - The return's lines keep the dialog's order, so the return's own field errors (a quantity over what the line
    took, a serial number that was not in the box) land under the dialog's rows.
  - **The return before the invoice, in one transaction.** The invoice reads `returned_quantity`, which the posted
    return has just raised; the order goes from Shipped to Delivered with both, and 28b.2's documents check never
    sees a Shipped order with a return.
  - **The sales order is closed after it** (mine 29): the return opened it again for goods that will never go out.
- **`returnOrder`:** the whole challan comes back through 27b's `returnChallan` (now with the member's reason on the
  return's note), the sales order is cancelled, then the parcel. A parcel the courier already said returned is left
  as it is; any other (on its way back, on hold, even delivered) becomes returned with a member step, which 0078's
  guard allows. A COD receipt it may have stays (mine 26): the money was posted, and a person voids it. The SMS goes
  after the commit, as the cancel's does.
- **`makeCodReceipt`** is 27d's `makePaymentReceipt` for a parcel: the receipt in the request's transaction, the
  order's version up so another tab reloads, an audit row; a refusal is kept on the parcel in a transaction of its
  own (the request's rolls back). A stale page, a wrong id, and a parcel whose receipt did not fail are not kept:
  they say nothing about the receipt.
- **`challanLinesOf`** joins each challan line to its sales order line, and the sales order line's number to the
  shop order's position (the maker wrote line `i + 1` for position `i`), for the name and pack size the shopper saw.
- **No database error is mapped.** Every writer of a parcel locks its order first, so two receipts for one parcel
  (`storefront_shipments_receipt_idx`) or a change after the link (`receipt_kept`) cannot be reached by a person;
  if one ever is, it is a bug, and a 500 says so loudly.

```diff
@@ -5,6 +5,8 @@ import { Endpoint } from '../../common/http/endpoint.js';
 import { StorefrontOrdersService } from './storefront-orders.service.js';
 
 type Routes = typeof routes.storefrontOrders;
+// Step 28b: Delivered, what came back and the COD receipt, a route group of their own (mine 17)
+type DeliveryRoutes = typeof routes.storefrontOrderDeliveries;
 
 // Step 27b: Storefront → Shop orders, the ERP's side of the shop's orders. The contract names each
 // route's permission (storefront.order.read or .manage) and the guard checks it; each route hands
@@ -75,12 +77,53 @@ export class StorefrontOrdersController {
     return this.orders.ship(params.id, body.version);
   }
 
-  @Endpoint(routes.storefrontOrders.deliverOrder)
+  @Endpoint(routes.storefrontOrderDeliveries.deliverOrder)
   deliverOrder({
     params,
     body,
-  }: RouteInput<Routes['deliverOrder']>): Promise<RouteResponse<Routes['deliverOrder']>> {
-    return this.orders.deliver(params.id, body.version);
+  }: RouteInput<DeliveryRoutes['deliverOrder']>): Promise<
+    RouteResponse<DeliveryRoutes['deliverOrder']>
+  > {
+    return this.orders.deliver(params.id, body);
+  }
+
+  @Endpoint(routes.storefrontOrderDeliveries.getReturnPlan)
+  getReturnPlan({
+    params,
+  }: RouteInput<DeliveryRoutes['getReturnPlan']>): Promise<
+    RouteResponse<DeliveryRoutes['getReturnPlan']>
+  > {
+    return this.orders.returnPlan(params.id);
+  }
+
+  @Endpoint(routes.storefrontOrderDeliveries.partlyDeliverOrder)
+  partlyDeliverOrder({
+    params,
+    body,
+  }: RouteInput<DeliveryRoutes['partlyDeliverOrder']>): Promise<
+    RouteResponse<DeliveryRoutes['partlyDeliverOrder']>
+  > {
+    return this.orders.partlyDeliver(params.id, body);
+  }
+
+  @Endpoint(routes.storefrontOrderDeliveries.returnOrder)
+  returnOrder({
+    params,
+    body,
+  }: RouteInput<DeliveryRoutes['returnOrder']>): Promise<
+    RouteResponse<DeliveryRoutes['returnOrder']>
+  > {
+    return this.orders.returnOrder(params.id, body);
+  }
+
+  @Endpoint(routes.storefrontOrderDeliveries.makeCodReceipt)
+  makeCodReceipt({
+    params,
+    body,
+  }: RouteInput<DeliveryRoutes['makeCodReceipt']>): Promise<
+    RouteResponse<DeliveryRoutes['makeCodReceipt']>
+  > {
+    return this.orders.makeCodReceipt(params.id, params.shipmentId, body.version);
   }
 
   // Step 27d: "Make the receipt" on the Payments card
```

The five routes of `storefrontOrderDeliveries` in the same controller, typed by their own group. Each has two or
more segments after `orders`, so none can be caught by `getOrder` (`/storefront/orders/:id`), and their place in the
class does not matter. Only a one-segment path like `/storefront/orders/counts` must come before `getOrder` (27b).

### The SMS

```diff
@@ -1,6 +1,6 @@
 import { type LanguageCode, SHOP_CODE_VALID_MINUTES, type ShopCourier } from '@omnivo/contracts';
 
-// Step 27a: the shop's two SMS (27b adds a third, 28a a fourth), in the shop's language (storefront_settings.language). Written
+// Step 27a: the shop's two SMS (27b adds a third, 28a a fourth, 28b a fifth), in the shop's language (storefront_settings.language). Written
 // here, side by side, like the emails' words (mail/invitation-email.ts): @omnivo/i18n is the
 // browser's. satisfies makes a third language a compile error until it has its words.
 //
@@ -78,3 +78,19 @@ export function pickedUpSms(
   } satisfies Record<LanguageCode, string>;
   return words[language];
 }
+
+// Step 28b (decision 7): Receive the return, the parcel is back in the shop. Like the cancel's: the
+// hotline, never the staff's reason. Sent only once a member has the goods, so it never says
+// "returned" for a parcel that is still on its way back
+export function returnedSms(
+  language: LanguageCode,
+  shopName: string,
+  orderNo: string,
+  hotline: string,
+): string {
+  const words = {
+    en: `${shopName}: order ${orderNo} came back to us and is closed. Questions? Call ${hotline}.`,
+    bn: `${shopName}: অর্ডার ${orderNo} ফেরত এসেছে, অর্ডারটি বন্ধ করা হলো। কিছু জানতে কল করুন ${hotline}।`,
+  } satisfies Record<LanguageCode, string>;
+  return words[language];
+}
```

Like the cancel's: the hotline, never the staff's reason. "Came back to us" is sent only by Receive the return, when
a member has the goods, never by the courier's word.

### The courier accounts

```diff
@@ -33,8 +33,9 @@ function accountError(field: 'moneyAccountId' | 'feeAccountId', code: ErrorCode)
 }
 
 // The chart as the two selects need it: every account, small enough to read whole (a few hundred
-// at most, as for the receipt form's moneyAccountIds)
-async function chartOf(tx: Transaction) {
+// at most, as for the receipt form's moneyAccountIds). Step 28b: exported for the courier
+// account's COD and charge accounts (courier-accounts.service.ts), the same two kinds
+export async function chartOf(tx: Transaction) {
   const rows = await tx
     .select({
       id: ledgerAccounts.id,
```

`chartOf` is exported: the courier account's two selects are the gateway's two kinds (an account that holds money,
an active expense account), read the same way, so the two pages can never disagree about which accounts fit.

```diff
@@ -6,11 +6,12 @@ import {
   type CourierSetup,
   type CourierTestProblem,
   type CreateCourierAccountInput,
+  type ErrorCode,
   routes,
   type UpdateCourierAccountInput,
 } from '@omnivo/contracts';
-import { courierAccounts } from '@omnivo/db';
-import { and, asc, eq, or, sql } from 'drizzle-orm';
+import { courierAccounts, receipts, storefrontShipments } from '@omnivo/db';
+import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../../common/audit/audit.js';
 import { isCheckViolation } from '../../common/db/pg-errors.js';
@@ -25,6 +26,7 @@ import {
   type CourierAdapters,
   isApiProvider,
 } from '../../shipping/courier.js';
+import { chartOf } from '../admin/payment-gateway.service.js';
 import { newToken, tokenHash } from '../orders/order-secrets.js';
 import { openKeys, sealKeys } from './courier-keys.js';
 
@@ -54,16 +56,28 @@ function notBookable(field: string): AppError {
 }
 
 // The audit's view: plain values, never a key or a token. A change of keys or token is written as
-// the word "changed" under its own field, like the gateway's password (27d)
-function snapshot(row: AccountRow) {
+// the word "changed" under its own field, like the gateway's password (27d). Step 28b: the two
+// accounts by their codes, as the gateway's audit names its accounts
+function snapshot(row: AccountRow, codes: ReadonlyMap<string, string>) {
+  const code = (id: string | null) => (id === null ? null : (codes.get(id) ?? id));
   return {
     name: row.name,
     provider: row.provider,
     courier: row.courier,
     status: row.archivedAt === null ? 'active' : 'archived',
+    codAccount: code(row.codAccountId),
+    chargeAccount: code(row.chargeAccountId),
   };
 }
 
+function accountError(field: 'codAccountId' | 'chargeAccountId', code: ErrorCode): AppError {
+  return new AppError(422, code, 'Pick another account.', { fieldErrors: { [field]: [code] } });
+}
+
+// What a courier holds (decision 12), per account: none yet
+const NOTHING_HELD = { amount: '0.0000', parcels: 0 };
+type Holds = ReadonlyMap<string, { amount: string; parcels: number }>;
+
 // Step 28a: Storefront → Shop couriers (decisions 7, 8, 13 and 14). storefront.manage on every
 // route (the contract says so and the guard checks it). An API account's keys are sealed here and
 // never answered; its webhook token is made here, answered once, and only its hash is kept. A
@@ -89,6 +103,7 @@ export class CourierAccountsService {
     return this.withTenant(async (tx) => {
       const tenantId = getTenantId();
       const userId = currentPrincipal().userId;
+      const codes = await this.checkAccounts(tx, input);
       // The token is made with the account (28a.2's secrets check wants its hash at once)
       const token = input.provider === 'manual' ? null : newToken();
       const values =
@@ -103,7 +118,14 @@ export class CourierAccountsService {
             };
       const [row] = await tx
         .insert(courierAccounts)
-        .values({ tenantId, ...values, createdBy: userId, updatedBy: userId })
+        .values({
+          tenantId,
+          ...values,
+          codAccountId: input.codAccountId,
+          chargeAccountId: input.chargeAccountId,
+          createdBy: userId,
+          updatedBy: userId,
+        })
         .returning();
       if (row === undefined) throw new Error('Courier account insert returned no row');
       await audit(tx, {
@@ -111,11 +133,12 @@ export class CourierAccountsService {
         entityType: 'courier_account',
         entityId: row.id,
         changes: created({
-          ...snapshot(row),
+          ...snapshot(row, codes),
           ...(row.provider === 'manual' ? {} : { keys: 'changed', webhookToken: 'changed' }),
         }),
       });
-      return { account: this.toAccount(row), webhookToken: token };
+      // A new account holds nothing yet
+      return { account: this.toAccount(row, new Map()), webhookToken: token };
     });
   }
 
@@ -134,6 +157,7 @@ export class CourierAccountsService {
           'A courier account keeps its provider. Add a new account for another one.',
         );
       }
+      const codes = await this.checkAccounts(tx, input);
       let keys: { keysSealed: Buffer; keyVersion: number } | null = null;
       if (input.provider !== 'manual' && key !== null) {
         // One box for both keys: a box with one new key needs the other one from the saved box
@@ -157,6 +181,8 @@ export class CourierAccountsService {
         .set({
           name: input.name,
           ...(input.provider === 'manual' ? { courier: input.courier } : {}),
+          codAccountId: input.codAccountId,
+          chargeAccountId: input.chargeAccountId,
           // The last test said something about the old keys only
           ...(keys === null ? {} : { ...keys, lastTestedAt: null, lastTestProblem: null }),
           version: sql`${courierAccounts.version} + 1`,
@@ -170,11 +196,11 @@ export class CourierAccountsService {
         entityType: 'courier_account',
         entityId: id,
         changes: {
-          ...diff(snapshot(before), snapshot(after)),
+          ...diff(snapshot(before, codes), snapshot(after, codes)),
           ...(keys === null ? {} : { keys: { from: null, to: 'changed' } }),
         },
       });
-      return this.toAccount(after);
+      return this.toAccount(after, await holdsOf(tx, [id]));
     });
   }
 
@@ -204,7 +230,7 @@ export class CourierAccountsService {
         entityId: id,
         changes: created({ testResult: problem ?? 'ok' }),
       });
-      return this.toAccount(after);
+      return this.toAccount(after, await holdsOf(tx, [id]));
     });
   }
 
@@ -231,7 +257,7 @@ export class CourierAccountsService {
         entityId: id,
         changes: { webhookToken: { from: null, to: 'changed' } },
       });
-      return { account: this.toAccount(after), webhookToken: token };
+      return { account: this.toAccount(after, await holdsOf(tx, [id])), webhookToken: token };
     });
   }
 
@@ -302,7 +328,9 @@ export class CourierAccountsService {
     return this.withTenant(async (tx) => {
       const before = await this.lock(tx, id, version);
       // Already as asked: no change, no audit row (a second tab's click)
-      if ((before.archivedAt !== null) === archive) return this.toAccount(before);
+      if ((before.archivedAt !== null) === archive) {
+        return this.toAccount(before, await holdsOf(tx, [id]));
+      }
       const [after] = await tx
         .update(courierAccounts)
         .set({
@@ -318,13 +346,15 @@ export class CourierAccountsService {
         action: archive ? 'courier_account.archived' : 'courier_account.restored',
         entityType: 'courier_account',
         entityId: id,
-        changes: diff(snapshot(before), snapshot(after)),
+        // Only the status changes here, so the accounts need no codes
+        changes: diff(snapshot(before, new Map()), snapshot(after, new Map())),
       });
-      return this.toAccount(after);
+      return this.toAccount(after, await holdsOf(tx, [id]));
     });
   }
 
-  // Active ones first, then by name: the page's two tabs read one list
+  // Active ones first, then by name: the page's two tabs read one list. Step 28b: with what each
+  // holds, and the two selects' choices (decisions 2, 3 and 12)
   private async read(tx: Transaction): Promise<CourierSetup> {
     const rows = await tx
       .select()
@@ -335,12 +365,40 @@ export class CourierAccountsService {
         asc(courierAccounts.name),
         asc(courierAccounts.id),
       );
+    const holds = await holdsOf(
+      tx,
+      rows.map((row) => row.id),
+    );
+    const chart = await chartOf(tx);
     return {
-      accounts: rows.map((row) => this.toAccount(row)),
+      accounts: rows.map((row) => this.toAccount(row, holds)),
       defaultAccountId: rows.find((row) => row.isDefault)?.id ?? null,
+      codAccounts: chart.moneyAccounts,
+      chargeAccounts: chart.feeAccounts,
     };
   }
 
+  // Step 28b: the COD account must be an active posting account that holds money, the charge
+  // account an active expense posting account, each when given (decisions 2 and 3): the same two
+  // lists the selects offer, read the payment gateway's way. Checked on every save, a saved one
+  // too: an account archived since is no place for new money (the form then starts it empty, with
+  // this error). The two lists never share an account, so one account for both is refused here
+  // too (0080's courier_accounts_money_accounts_check is the last word). The codes go to the audit
+  private async checkAccounts(
+    tx: Transaction,
+    input: { codAccountId: string | null; chargeAccountId: string | null },
+  ): Promise<ReadonlyMap<string, string>> {
+    const chart = await chartOf(tx);
+    const { codAccountId, chargeAccountId } = input;
+    if (codAccountId !== null && !chart.moneyAccounts.some((row) => row.id === codAccountId)) {
+      throw accountError('codAccountId', 'courier_cod_account_invalid');
+    }
+    if (chargeAccountId !== null && !chart.feeAccounts.some((row) => row.id === chargeAccountId)) {
+      throw accountError('chargeAccountId', 'courier_charge_account_invalid');
+    }
+    return chart.codeOf;
+  }
+
   private sealed(
     key: CredentialsKey,
     tenantId: string,
@@ -385,7 +443,7 @@ export class CourierAccountsService {
     return row;
   }
 
-  private toAccount(row: AccountRow): CourierAccount {
+  private toAccount(row: AccountRow, holds: Holds): CourierAccount {
     const base = this.config.apiBaseUrl.replace(/\/+$/, '');
     return {
       id: row.id,
@@ -402,8 +460,43 @@ export class CourierAccountsService {
         row.lastTestedAt === null
           ? null
           : { at: row.lastTestedAt.toISOString(), problem: row.lastTestProblem },
+      codAccountId: row.codAccountId,
+      chargeAccountId: row.chargeAccountId,
+      holds: holds.get(row.id) ?? NOTHING_HELD,
       version: row.version,
       updatedAt: row.updatedAt.toISOString(),
     };
   }
 }
+
+// Step 28b (decision 12, mine 26): what each courier holds of the shop's money, the page's "Holds
+// ৳45,200 · 18 parcels": the parcels whose COD receipt is posted (a voided one stays linked and
+// counts no more). storefront_shipments_cod_idx finds them per account. Step 28c's payout takes
+// its parcels out of this sum
+async function holdsOf(tx: Transaction, accountIds: readonly string[]): Promise<Holds> {
+  if (accountIds.length === 0) return new Map();
+  const rows = await tx
+    .select({
+      accountId: storefrontShipments.courierAccountId,
+      amount: sql<string>`coalesce(sum(${storefrontShipments.collectedAmount}), 0)::text`,
+      parcels: sql<number>`count(*)::int`,
+    })
+    .from(storefrontShipments)
+    .innerJoin(
+      receipts,
+      and(
+        eq(receipts.tenantId, storefrontShipments.tenantId),
+        eq(receipts.id, storefrontShipments.receiptId),
+      ),
+    )
+    .where(
+      and(
+        eq(storefrontShipments.tenantId, getTenantId()),
+        inArray(storefrontShipments.courierAccountId, [...accountIds]),
+        isNotNull(storefrontShipments.receiptId),
+        eq(receipts.status, 'posted'),
+      ),
+    )
+    .groupBy(storefrontShipments.courierAccountId);
+  return new Map(rows.map((row) => [row.accountId, { amount: row.amount, parcels: row.parcels }]));
+}
```

- **`checkAccounts` on create and update** (mine 33), before anything is written. The two lists never share an
  account, so "the same account for both" is refused by the lists; 0080's check is the last word.
- **The audit names the accounts by their codes**, as the gateway's does: an id in the log means nothing to a
  person. Archive and restore change only the status, so they pass no codes.
- **`holdsOf`** sums the collected amounts of the parcels whose receipt is posted (mine 26: a voided one counts no
  more), one grouped query for the whole page. A new account holds nothing, so `create` does not ask.
- **The page's read answers the two selects' choices,** for the gateway's reason: `storefront.manage` does not read
  the chart of accounts.

### Wiring

```diff
@@ -30,6 +30,7 @@ import { StorefrontOrdersService } from './orders/storefront-orders.service.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
 import { ShopOrderMoves } from './orders/order-moves.js';
+import { ShopCodReceipts } from './shipping/cod-receipts.js';
 import { CourierAccountsController } from './shipping/courier-accounts.controller.js';
 import { CourierAccountsService } from './shipping/courier-accounts.service.js';
 import { CourierWebhooks } from './shipping/courier-webhooks.js';
@@ -88,6 +89,8 @@ import { ShopDb } from './shop-db.js';
     ShopPaymentReceipts,
     StorefrontPaymentGatewayService,
     ShopOrderMoves,
+    // Step 28b: Delivered's COD receipt (ShopOrderMoves needs it)
+    ShopCodReceipts,
     CourierAccountsService,
     CourierWebhooks,
     ShipmentNews,
```

```diff
@@ -65,6 +65,7 @@ import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
 import { ShopSalesOrderMaker } from '../storefront/orders/sales-order-maker.js';
 import { ShopOrderMoves } from '../storefront/orders/order-moves.js';
 import { ShipmentBookingHandler } from '../storefront/shipping/booking.handler.js';
+import { ShopCodReceipts } from '../storefront/shipping/cod-receipts.js';
 import { ShipmentNews } from '../storefront/shipping/shipment-news.js';
 import { ShipmentPoll } from '../storefront/shipping/shipment-poll.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
@@ -173,6 +174,8 @@ export class WorkerModule implements OnApplicationShutdown {
         ShipmentPoll,
         ShipmentNews,
         ShopOrderMoves,
+        // Step 28b: the courier's "delivered" makes the rider's COD receipt too
+        ShopCodReceipts,
         InvoicesService,
         DeliveriesService,
         StockPostingService,
```

`ShopCodReceipts` in both modules: `ShopOrderMoves` needs it in the API (the buttons, the webhook) and in the worker
(the poll's "delivered"). The worker already had `ReceiptsService` for 27d's payment receipts.

### Unit tests

```diff
@@ -3,7 +3,7 @@ import { describe, expect, it } from 'vitest';
 import { stepStatusOf } from '../storefront/shipping/shipment-news.js';
 import { bearerOf } from '../storefront/shipping/courier-webhooks.js';
 import { invoiceOf } from '../storefront/shipping/shipments.js';
-import { courierId, courierText, eventKeyOf, type ParcelRequest } from './courier.js';
+import { courierId, courierMoney, courierText, eventKeyOf, type ParcelRequest } from './courier.js';
 import { FAKE_REFUSED_PHONE, FakeCourier } from './fake-courier.js';
 import { SteadfastAdapter, steadfastTime } from './steadfast-adapter.js';
 
@@ -181,6 +181,24 @@ describe('Steadfast adapter (step 28a.3)', () => {
       status: 'delivered',
       note: 'Delivered to the customer',
       at: new Date('2026-11-23T08:05:09.000Z'),
+      // Step 28b: what the rider collected and Steadfast's charge, as our money text
+      collected: '578.00',
+      charge: '80.00',
+    });
+    // Step 28b: a sum Steadfast sent as a string, and one we cannot read, which is no sum
+    expect(
+      adapter.readNotice({
+        notification_type: 'delivery_status',
+        invoice: 'W-000123',
+        status: 'partial_delivered',
+        cod_amount: '300.5',
+        delivery_charge: 'N/A',
+      }),
+    ).toMatchObject({
+      kind: 'status',
+      status: 'partly_delivered',
+      collected: '300.5',
+      charge: null,
     });
     expect(
       adapter.readNotice({
@@ -300,3 +318,26 @@ describe('courier helpers (step 28a.3)', () => {
     expect(bearerOf(undefined)).toBeNull();
   });
 });
+
+describe('courierMoney (step 28b)', () => {
+  it('reads a courier’s sum to the paisa, or not at all', () => {
+    expect(courierMoney(578)).toBe('578.00');
+    expect(courierMoney(1500.5)).toBe('1500.50');
+    expect(courierMoney(0)).toBe('0.00');
+    // A float's noise is not paisa
+    expect(courierMoney(0.1 + 0.2)).toBe('0.30');
+    expect(courierMoney(' 578.50 ')).toBe('578.50');
+    expect(courierMoney('578')).toBe('578');
+    // A minus, a third decimal, words, nothing: no sum
+    expect(courierMoney(-1)).toBeNull();
+    expect(courierMoney(578.555)).toBeNull();
+    expect(courierMoney('578.555')).toBeNull();
+    expect(courierMoney('-578')).toBeNull();
+    expect(courierMoney('N/A')).toBeNull();
+    expect(courierMoney(Number.NaN)).toBeNull();
+    expect(courierMoney(Number.POSITIVE_INFINITY)).toBeNull();
+    expect(courierMoney(null)).toBeNull();
+    expect(courierMoney(undefined)).toBeNull();
+    expect(courierMoney({ amount: 578 })).toBeNull();
+  });
+});
```

`courierMoney`'s edges, and Steadfast's two sums read from a delivered and a partly delivered notice, a sum as a
string and one we cannot read.

```diff
@@ -1,6 +1,6 @@
 import { describe, expect, it } from 'vitest';
 
-import { cancelledSms, codeSms, confirmedSms } from './shop-sms.js';
+import { cancelledSms, codeSms, confirmedSms, returnedSms } from './shop-sms.js';
 
 describe('the shop SMS', () => {
   it('puts the code first, in ASCII digits in both languages', () => {
@@ -28,4 +28,14 @@ describe('the shop SMS', () => {
       'নির্ভর: অর্ডার W-000123 বাতিল করা হয়েছে। কিছু জানতে কল করুন 09610-123456।',
     );
   });
+
+  // Step 28b: Receive the return, like the cancel: the hotline, never the staff's reason
+  it('says the order came back and where to ask', () => {
+    expect(returnedSms('en', 'Nirvor', 'W-000123', '09610-123456')).toBe(
+      'Nirvor: order W-000123 came back to us and is closed. Questions? Call 09610-123456.',
+    );
+    expect(returnedSms('bn', 'নির্ভর', 'W-000123', '09610-123456')).toBe(
+      'নির্ভর: অর্ডার W-000123 ফেরত এসেছে, অর্ডারটি বন্ধ করা হলো। কিছু জানতে কল করুন 09610-123456।',
+    );
+  });
 });
```

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src
pnpm --filter @omnivo/api test
```

What ran on commit 7b1fa0f:

- **Typecheck, lint, prettier:** clean.
- **Unit tests:** 31 files, 246 tests, all pass (244 before this part, plus the two new ones).
- **The storefront and sales integration suites** (`storefront-orders`, `shop-payments`, `storefront-coupons`,
  `returns`, `sales-documents`): all pass, so Delivered with nothing back bills and pays as before. `couriers.int`
  fails in 25 tests, all for one reason: decision 20 made the two account fields required, and 28a's request bodies
  do not send them (400 `invalid_input`). 28b.4 adds them.
- **A smoke scenario on the real stack** (Postgres, Redis, Mailpit, the API and the worker, the fake courier), kept
  for 28b.4 in `.guide/work/smoke28b3/`. All six cases passed:
  - the two accounts saved, a charge account offered as the COD account refused, the choices listed;
  - the courier's "delivered" with `cod_amount` 900 on a ৳538 parcel: collected cut to ৳538, a `courier` receipt into
    the COD account, the invoice paid, the account holds ৳538 in 1 parcel, the list says `delivered`;
  - a manual parcel's Mark delivered with ৳600 refused (`storefront_order_collected_over`), with ৳500 taken (the
    invoice partly paid);
  - the courier's partial delivery (৳309): the order stays Shipped; every piece back refused; one of two back makes a
    sales return, a ৳309 invoice paid in full, the sales order closed, one piece back in stock, the audit row;
  - the courier's cancel after pickup (returning), then Receive the return: Returned, the return, no invoice, the
    parcel returned, the stock as before, the sales order cancelled, the SMS;
  - the COD account archived before "delivered": the order Delivered, `receipt_account_invalid` on the parcel, needs
    attention, the bell; Make the receipt refused while archived, made once restored, then refused as not failed.

## 28b.4 — API tests

The tests run the COD money on the real stack, the way 28a's courier tests do: Postgres, Redis, Mailpit, the API and
the worker, with the fake courier. They found two bugs in the code of 28b.3 and 28a, fixed in this part first.

Mine, made while writing this part:

35. **The webhook records its time in a transaction of its own, before the news.** 28a's webhook updated
    `courier_accounts.last_webhook_at` and then, in the same transaction, waited for the parcel's order. Mark
    delivered holds the order, and its COD receipt reads the courier account `FOR SHARE`, so each waited for the
    other. Postgres saw the deadlock and killed the webhook (a 500; the courier sends it again later). The race test
    found it. 28a had the same cycle with Packed and Book courier, but only for an order the courier was also sending
    news about, which almost never happens; at the door it is the normal case: the rider delivers while a member
    presses the button. With the time committed first, the news transaction takes the order first, like every
    member's move. A webhook whose news then fails still counts as arrived, which is what "Last arrived" means.
36. **A notice that names money keeps its body in `raw`.** Decision 21 says the event row keeps the courier's own
    figure when the parcel keeps less; 28a kept `raw` only for a notice it could not read. Only a status notice with a
    collected amount or a charge keeps it, so the other events stay as small as before.
37. **The receipt's savepoint has no test that can fail.** Breaking it on purpose (making the receipt in the order's
    transaction) still passes every test: each refusal the books make today (the customer, the branch, the COD
    account) comes before the receipt's first write, and a closed period stops the invoice before the receipt is
    reached. The savepoint stays, so a later check after the first write cannot leave half a receipt behind.

### The two fixes

```diff
@@ -37,8 +37,8 @@ export function bearerOf(header: string | undefined): string | null {
 //    account and a wrong token: the caller learns nothing about which ids exist
 // 2. the token is compared with the hash in constant time, before the body is read at all
 // 3. inside the workspace: the account's last webhook time (the page shows it, decision 16), then
-//    the parcel by the courier's id or by our invoice, only among this account's parcels. The
-//    body never says which workspace or account it is for
+//    in a transaction of its own the parcel by the courier's id or by our invoice, only among this
+//    account's parcels. The body never says which workspace or account it is for
 // A body we cannot read, or one about a parcel we do not know, is answered "success" all the same:
 // a refusal would only make the courier send it again and again, and then stop sending.
 @Injectable()
@@ -72,13 +72,22 @@ export class CourierWebhooks {
 
     const notice = this.couriers[provider].readNotice(body);
     const tenantId = found.data.tenant_id;
-    const sms = await runWithTenant(tenantId, () =>
+    const now = new Date();
+    // Step 28b: the last webhook time commits on its own, before the news. The UPDATE locks the
+    // account's row, and the news then waits for the parcel's order; a member's move on that order
+    // (Mark delivered's COD receipt, Packed, Book courier) holds the order and reads the account
+    // FOR SHARE. In one transaction the two waited for each other, and Postgres killed the webhook
+    // (found by cod.int.spec.ts's race). A webhook whose news then fails still arrived
+    await runWithTenant(tenantId, () =>
       this.withTenant(async (tx) => {
-        const now = new Date();
         await tx
           .update(courierAccounts)
           .set({ lastWebhookAt: now })
           .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.id, accountId)));
+      }),
+    );
+    const sms = await runWithTenant(tenantId, () =>
+      this.withTenant(async (tx) => {
         const by =
           notice.consignmentId !== null
             ? eq(storefrontShipments.consignmentId, notice.consignmentId)
```

- **`now` moves out of the transaction,** because both transactions use it: the account's time and the events'
  `received_at` stay the same moment, as before.
- **The first `withTenant` only updates the account and commits.** Nothing else is in it, so it holds the account's
  row for one statement. Two webhooks of one account still take turns there, for a moment, not for a whole delivery.
- **The second transaction is 28a's, without the update.** It takes the parcel's order first (`ShipmentNews.apply`),
  as Mark delivered, Packed and Book courier do, so the two can only queue behind each other.

```diff
@@ -205,7 +205,12 @@ export class ShipmentNews {
       note: notice.note,
       occurredAt: at,
       eventKey: eventKeyOf(notice.kind, status, notice.at, notice.note),
-      raw: null,
+      // Step 28b (mine 21): a notice that names money keeps its body, so the courier's own
+      // figure is still there when the parcel keeps less (moneyOf cuts it to the COD amount)
+      raw:
+        notice.kind === 'status' && (notice.collected !== null || notice.charge !== null)
+          ? keptRaw(notice.raw)
+          : null,
     };
   }
 
```

`raw` is the courier's body as it came, cut to the size the column allows (`keptRaw`, 28a). A notice with no money
(a "pending", a note) keeps `null` there, as in 28a, so nothing else changes in the events.

### 28a's tests and the two new fields

```diff
@@ -82,6 +82,10 @@ let manual: CourierAccount;
 
 const API_KEY = 'sf-api-7k2m9q4x';
 const SECRET_KEY = 'sf-secret-4n8p1x6w';
+// 28b: a courier account's two money accounts (the COD account and the charge account) have no
+// default, so every body sends both. These tests are about the rest of the account: both stay
+// empty, and cod.int.spec.ts tests them
+const NO_COD = { codAccountId: '', chargeAccountId: '' };
 
 // Two face washes (৳229 each) and the ৳80 delivery charge
 const TOTAL = '538';
@@ -431,6 +435,7 @@ describe('Shop couriers', () => {
   it('adds an API account with its webhook token once, and keeps its keys sealed', async () => {
     const saved = await addAccount({
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast',
       apiKey: API_KEY,
       secretKey: SECRET_KEY,
@@ -470,7 +475,12 @@ describe('Shop couriers', () => {
     }
 
     // A manual account: a name and a courier, no keys, no webhook
-    const byHand = await addAccount({ provider: 'manual', name: 'RedX by hand', courier: 'redx' });
+    const byHand = await addAccount({
+      ...NO_COD,
+      provider: 'manual',
+      name: 'RedX by hand',
+      courier: 'redx',
+    });
     expect(byHand.webhookToken).toBeNull();
     expect(byHand.account).toMatchObject({
       provider: 'manual',
@@ -494,6 +504,7 @@ describe('Shop couriers', () => {
     // Both boxes empty: the keys stay, so does the last test
     const renamed = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast Mirpur',
       apiKey: '',
       secretKey: '',
@@ -510,6 +521,7 @@ describe('Shop couriers', () => {
     // A form opened before that save
     const stale = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast',
       apiKey: '',
       secretKey: '',
@@ -521,6 +533,7 @@ describe('Shop couriers', () => {
     // Only the API key: the secret key comes from the saved box, in a new box
     const newKey = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast Mirpur',
       apiKey: 'fake_rejected',
       secretKey: '',
@@ -539,6 +552,7 @@ describe('Shop couriers', () => {
     const sealedNow = (await accountRow(steadfast.id)).sealed;
     const same = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast Mirpur',
       apiKey: 'fake_rejected',
       secretKey: SECRET_KEY,
@@ -550,6 +564,7 @@ describe('Shop couriers', () => {
     // Back to the good keys for the tests after this one
     const back = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast',
       apiKey: API_KEY,
       secretKey: '',
@@ -569,6 +584,7 @@ describe('Shop couriers', () => {
     // A manual account stays manual, and has nothing to test
     const fixed = await send('PUT', `/storefront/couriers/${manual.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'RedX by hand',
       apiKey: API_KEY,
       secretKey: SECRET_KEY,
@@ -581,6 +597,7 @@ describe('Shop couriers', () => {
     expect(notTestable.json()).toMatchObject({ code: 'courier_account_not_bookable' });
     const otherCourier = await send('PUT', `/storefront/couriers/${manual.id}`, {
       provider: 'manual',
+      ...NO_COD,
       name: 'Paperfly by hand',
       courier: 'paperfly',
       version: manual.version,
@@ -606,6 +623,7 @@ describe('Shop couriers', () => {
     const spare = (
       await addAccount({
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast spare',
         apiKey: 'k2',
         secretKey: 's2',
@@ -641,6 +659,7 @@ describe('Shop couriers', () => {
     expect(restored.status).toBe('active');
     const edit = await send('PUT', `/storefront/couriers/${spare.id}`, {
       provider: 'steadfast',
+      ...NO_COD,
       name: 'Steadfast spare',
       apiKey: '',
       secretKey: '',
@@ -716,6 +735,7 @@ describe('Shop couriers', () => {
       const [before] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
       const added = await as('POST', '/storefront/couriers', {
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast Sylhet',
         apiKey: 'k3',
         secretKey: 's3',
@@ -726,6 +746,7 @@ describe('Shop couriers', () => {
       expect(after?.n).toBe(before?.n);
       const byHand = await as('POST', '/storefront/couriers', {
         provider: 'manual',
+        ...NO_COD,
         name: 'eCourier by hand',
         courier: 'ecourier',
       });
@@ -735,6 +756,7 @@ describe('Shop couriers', () => {
       const current = await accountOf(steadfast.id);
       const typed = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast',
         apiKey: 'k4',
         secretKey: '',
@@ -743,6 +765,7 @@ describe('Shop couriers', () => {
       expect(typed.json()).toMatchObject({ code: 'courier_key_missing' });
       const named = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast',
         apiKey: '',
         secretKey: '',
@@ -766,7 +789,11 @@ describe('Shop couriers', () => {
     ]);
     for (const [method, url, body] of [
       ['GET', '/storefront/couriers', undefined],
-      ['POST', '/storefront/couriers', { provider: 'manual', name: 'RedX', courier: 'redx' }],
+      [
+        'POST',
+        '/storefront/couriers',
+        { ...NO_COD, provider: 'manual', name: 'RedX', courier: 'redx' },
+      ],
       ['PUT', '/storefront/couriers', { accountId: '' }],
       ['POST', `/storefront/couriers/${steadfast.id}/test`, undefined],
     ] as const) {
@@ -1016,6 +1043,7 @@ describe('booking a parcel', () => {
     const sylhet = (
       await addAccount({
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast Sylhet',
         apiKey: 'k5',
         secretKey: 's5',
@@ -1038,6 +1066,7 @@ describe('booking a parcel', () => {
     const old = (
       await addAccount({
         provider: 'steadfast',
+        ...NO_COD,
         name: 'Steadfast old keys',
         apiKey: 'fake_rejected',
         secretKey: 's6',
```

Decision 20 gives the two accounts no default, so a body without them is a 400. 28a's tests are about the rest of the
account, so they send both empty through one `NO_COD` spread instead of two more lines in every body. The spread goes
after `provider` in the long bodies and first in the short ones, where prettier then puts one key on each line; the
order of keys does not matter to the API.

### The COD tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierSetupSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  receiptSchema,
  roleSchema,
  type ShopOrderRequestInput,
  storefrontOrderPageSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  storefrontReturnPlanSchema,
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
import { lastMailTo } from '../../testing/mailpit.js';
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
  smsAddress,
} from '../../testing/shop-orders.js';
import { addListing } from '../../testing/storefront.js';
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 28b: a shop order's cash on delivery, on the real stack (Postgres, Redis, Mailpit, the API
// and the worker, with the fake courier). A courier account names the ledger account its COD money
// goes into; at Delivered (the courier's "delivered", or the member's button) the rider's money is
// written on the parcel and a posted money receipt by `courier` takes it into that account and pays
// the invoice. A parcel the shopper kept only part of is recorded by a member (partly delivered),
// and one that came back whole is received by a member (Returned). A receipt the books refuse
// stays on the parcel as an error, rings the bell, and is made again with "Make the receipt".
// Every test places its own orders, with its own phone and shopper address (n), so the shop's
// limits never stop a test.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read only: sees the parcel money, moves nothing
let reader: SignedIn;
let shop: OrderShop;
// The two ledger accounts of the courier accounts: a money account the riders' cash goes into,
// and an expense account for the courier's charge
let codAccount: Account;
let chargeAccount: Account;
// Steadfast by its API, with both accounts; Pathao by hand, with the COD account; RedX by hand,
// with none (the cash is a receipt typed by hand, as before 28b)
let steadfast: CourierAccount;
let steadfastToken: string;
let pathao: CourierAccount;
let redx: CourierAccount;
// A serial product (three hair dryers, HD-1001 to HD-1003), listed in the shop
let dryer: { product: Product; listingId: string };

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
const API_KEY = 'sf-api-7k2m9q4x';
const SECRET_KEY = 'sf-secret-4n8p1x6w';

const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true, params: true });

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(id: string): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must go through
async function move(id: string, step: string, body: object): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must be refused with this status: the problem's code, field errors and params
async function refused(id: string, step: string, body: object, status: number) {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(status);
  return refusalSchema.parse(res.json());
}

// Placed by shopper n, confirmed with the code from Mailpit, and given its sales order by the
// worker: ready to pack
async function confirm(n: number, request?: ShopOrderRequestInput): Promise<StorefrontOrder> {
  const phone = phoneOf(n);
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(
    app,
    headers,
    request ?? orderRequest(shop.listingId, 2, phone, TOTAL),
  );
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  return eventually(async () => {
    const order = await getOrder(row.id);
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

// Packed, and booked with this API account by the worker
async function bookedWith(
  order: StorefrontOrder,
  account: CourierAccount,
  lines: object[] = WHOLE,
) {
  await move(order.id, 'pack', { version: order.version, lines, courierAccountId: account.id });
  return eventually(async () => {
    const now = await getOrder(order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
}

// Packed, booked by hand with this manual account, and marked shipped: the rider has it
async function shippedBy(order: StorefrontOrder, account: CourierAccount, lines: object[] = WHOLE) {
  const packed = await move(order.id, 'pack', {
    version: order.version,
    lines,
    courierAccountId: '',
  });
  const booked = await move(order.id, 'shipments', {
    version: packed.version,
    accountId: account.id,
    trackingCode: `PTH-${order.orderNo}`,
  });
  return move(order.id, 'ship', { version: booked.version });
}

// Steadfast's webhook for this order's newest parcel, as the courier sends it
function webhook(order: StorefrontOrder, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${steadfast.id}`,
    headers: { authorization: `Bearer ${steadfastToken}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(order.shipments.at(-1)?.consignmentId),
      ...body,
    },
  });
}

// A webhook the API must take
async function notice(order: StorefrontOrder, body: object) {
  const res = await webhook(order, body);
  expect(res.statusCode, res.body).toBe(200);
}

// The fake courier gives no time, so a step's time is the moment it reached the API, and the
// parcel's newest step wins by it (28a). A test waits a second between two steps of one parcel,
// so no two are at the same second. A test that does this more than once needs more than vitest's
// 5 seconds (COURIER_CLOCK)
function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}
const COURIER_CLOCK = 20_000;

async function invoiceOf(order: StorefrontOrder) {
  const res = await send('GET', `/invoices/${order.invoice?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return invoiceSchema.parse(res.json());
}

// What a courier account holds now: the page's "Holds ৳538 · 1 parcel"
async function holdsOf(id: string) {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found.holds;
}

// The workspace's COD receipts, as the database keeps them
async function codReceipts() {
  return z
    .array(z.object({ id: z.string(), amount: z.string(), account: z.string(), ref: z.string() }))
    .parse(
      await sql`SELECT id::text, amount::text, account_id::text AS account, reference AS ref
        FROM receipts WHERE tenant_id = ${shop.tenantId} AND method = 'courier'
        ORDER BY created_at, id`,
    );
}

async function stockOf(variantId: string): Promise<number> {
  const [row] = z.array(z.object({ q: z.string() })).parse(
    await sql`SELECT coalesce(sum(quantity), 0)::text AS q FROM stock_balances
      WHERE tenant_id = ${shop.tenantId} AND variant_id = ${variantId}`,
  );
  return Number(row?.q);
}

async function salesOrderStatus(order: StorefrontOrder): Promise<string | undefined> {
  const [row] = z
    .array(z.object({ status: z.string() }))
    .parse(await sql`SELECT status FROM sales_orders WHERE id = ${order.salesOrder?.id ?? ''}`);
  return row?.status;
}

// A ledger account of the test's own, under the group of an account the seed chart has
async function ledgerAccount(
  parentId: string,
  code: string,
  name: string,
  holdsMoney: boolean,
): Promise<Account> {
  const res = await send('POST', '/accounts', {
    parentId,
    code,
    name,
    isGroup: false,
    holdsMoney,
    description: '',
  });
  expect(res.statusCode, res.body).toBe(201);
  return accountSchema.parse(res.json());
}

async function setArchived(id: string, archived: boolean): Promise<void> {
  const current = accountSchema.parse((await send('GET', `/accounts/${id}`)).json());
  const res = await send('POST', `/accounts/${id}/${archived ? 'archive' : 'restore'}`, {
    version: current.version,
  });
  expect(res.statusCode, res.body).toBe(200);
}

// A member of Nirvor with a role of exactly these permissions
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
  if (found === undefined) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'nirvor', email, password, keepSignedIn: false });
}

// Sends requests "at the same moment" for sure (28a's couriers.int.spec.ts): a transaction of the
// test's own locks `table`, and each request is sent only once the ones before it wait for a lock.
// The first one sent holds the order's row lock and waits at `table`; the next waits for the
// order's row. When the gate opens, they run in the order they were sent
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
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 200 });

  // The COD account sits next to Cash in hand (1110); 1160 is the seed chart's own already. The
  // charge account under the first expense group
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  codAccount = await ledgerAccount(cash.parentId, '1191', 'Cash with couriers', true);
  chargeAccount = await ledgerAccount(expenses.id, '5998', 'Courier charges', false);

  // The dryers come in by a posted stock adjustment: a serial number exists only once stock
  // brought it in
  const made = await send('POST', '/products', {
    code: '',
    name: 'Hair dryer 1200 W',
    type: 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: 'serial',
    hasExpiry: false,
    taxRateId: '',
    options: [],
    variants: [
      { id: null, sku: '', optionValues: [], barcode: '', salePrice: '1800', archived: false },
    ],
    units: [],
    customFields: {},
  });
  expect(made.statusCode, made.body).toBe(201);
  const product = productSchema.parse(made.json());
  const opening = await send('POST', '/stock-adjustments', {
    date: '2026-11-01',
    warehouseId: shop.warehouseId,
    direction: 'in',
    reason: 'opening',
    note: '',
    post: true,
    lines: [
      {
        variantId: product.variants[0]?.id ?? '',
        unitId: shop.unitId,
        quantity: '3',
        batchId: '',
        lotNumber: '',
        expiresOn: '',
        manufacturedOn: '',
        serialNumbers: ['HD-1001', 'HD-1002', 'HD-1003'],
        unitCost: '1200',
      },
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  dryer = {
    product,
    listingId: await addListing(sql, shop.tenantId, {
      product,
      categoryId: shop.categoryId,
      slug: 'hair-dryer',
      publishedDaysAgo: 1,
    }),
  };
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the money accounts', () => {
  it('saves a COD account and a charge account, and refuses ones that cannot hold them', async () => {
    // The choices: money accounts for the COD money, expense accounts for the charge
    const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
    const cod = setup.codAccounts.map((account) => account.code);
    const charge = setup.chargeAccounts.map((account) => account.code);
    expect(cod).toEqual(expect.arrayContaining(['1110', '1191']));
    expect(cod).not.toContain('5998');
    expect(charge).toContain('5998');
    expect(charge).not.toContain('1191');

    const body = {
      provider: 'steadfast',
      name: 'Steadfast Dhaka',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      codAccountId: codAccount.id,
      chargeAccountId: chargeAccount.id,
    };
    // Each one under its own box, and nothing saved
    for (const [wrong, field, code] of [
      [{ codAccountId: chargeAccount.id }, 'codAccountId', 'courier_cod_account_invalid'],
      [{ chargeAccountId: codAccount.id }, 'chargeAccountId', 'courier_charge_account_invalid'],
      [
        { codAccountId: '00000000-0000-4000-8000-000000000000' },
        'codAccountId',
        'courier_cod_account_invalid',
      ],
    ] as const) {
      const res = await send('POST', '/storefront/couriers', { ...body, ...wrong });
      expect(res.statusCode, res.body).toBe(422);
      expect(refusalSchema.parse(res.json())).toMatchObject({
        code,
        fieldErrors: { [field]: [code] },
      });
    }
    const [none] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
    expect(none?.n).toBe(0);

    const saved = await send('POST', '/storefront/couriers', body);
    expect(saved.statusCode, saved.body).toBe(201);
    const made = courierAccountSavedSchema.parse(saved.json());
    steadfast = made.account;
    steadfastToken = made.webhookToken ?? '';
    expect(steadfast).toMatchObject({
      codAccountId: codAccount.id,
      chargeAccountId: chargeAccount.id,
      holds: { amount: '0.0000', parcels: 0 },
    });
    // The audit row names the two accounts by their codes, which a reader of the log knows
    const [audit] = z.array(z.object({ text: z.string() })).parse(
      await sql`SELECT payload::text AS text FROM audit_logs
        WHERE entity_type = 'courier_account' AND entity_id = ${steadfast.id}`,
    );
    expect(audit?.text).toContain('1191');
    expect(audit?.text).toContain('5998');

    const byHand = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'Pathao by hand',
      courier: 'pathao',
      codAccountId: codAccount.id,
      chargeAccountId: '',
    });
    expect(byHand.statusCode, byHand.body).toBe(201);
    pathao = courierAccountSavedSchema.parse(byHand.json()).account;
    const plain = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: '',
      chargeAccountId: '',
    });
    expect(plain.statusCode, plain.body).toBe(201);
    redx = courierAccountSavedSchema.parse(plain.json()).account;
    expect(redx).toMatchObject({ codAccountId: null, chargeAccountId: null });
  });

  it('checks the accounts again on every save: an archived one is refused', async () => {
    const cash = accountListSchema
      .parse((await send('GET', '/accounts')).json())
      .items.find((account) => account.code === '1110');
    if (cash?.parentId == null) throw new Error('no Cash in hand');
    const spare = await ledgerAccount(cash.parentId, '1192', 'Cash with RedX', true);
    await setArchived(spare.id, true);
    const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
    expect(setup.codAccounts.map((account) => account.id)).not.toContain(spare.id);
    const res = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: spare.id,
      chargeAccountId: '',
      version: redx.version,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(refusalSchema.parse(res.json()).code).toBe('courier_cod_account_invalid');
    // Restored, it is a COD account again; RedX stays without one for the tests after this
    await setArchived(spare.id, false);
    const fine = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: spare.id,
      chargeAccountId: '',
      version: redx.version,
    });
    expect(fine.statusCode, fine.body).toBe(200);
    const back = await send('PUT', `/storefront/couriers/${redx.id}`, {
      provider: 'manual',
      name: 'RedX by hand',
      courier: 'redx',
      codAccountId: '',
      chargeAccountId: '',
      version: courierAccountSchema.parse(fine.json()).version,
    });
    expect(back.statusCode, back.body).toBe(200);
    redx = courierAccountSchema.parse(back.json());
  });
});

describe("the courier's delivered", () => {
  it(
    'keeps what the rider collected, cut to the COD amount, and pays the invoice with it',
    async () => {
      const order = await bookedWith(await confirm(1), steadfast);
      const parcel = order.shipments.at(-1);
      await later();
      // Steadfast says the rider took ৳900: more than the ৳538 it was told to collect
      await notice(order, { status: 'delivered', cod_amount: 900, delivery_charge: 80 });
      const delivered = await getOrder(order.id);
      expect(delivered.status).toBe('delivered');
      expect(delivered.needsAttention).toBe(false);
      expect(delivered.shipments.at(-1)).toMatchObject({
        status: 'delivered',
        collectedAmount: '538.0000',
        courierCharge: '80.0000',
        receiptError: null,
      });
      // The courier's own figure stays in the event's body, for whoever checks the payout
      const [event] = z.array(z.object({ raw: z.string() })).parse(
        await sql`SELECT raw::text AS raw FROM storefront_shipment_events
        WHERE shipment_id = ${parcel?.id ?? ''} AND status = 'delivered'`,
      );
      expect(event?.raw).toContain('900');
      // One receipt: by courier, into the COD account, with the courier's tracking code
      const receipts = await codReceipts();
      expect(receipts).toEqual([
        {
          id: delivered.shipments.at(-1)?.receipt?.id,
          amount: '538.0000',
          account: codAccount.id,
          ref: parcel?.trackingCode,
        },
      ]);
      const invoice = await invoiceOf(delivered);
      expect(invoice).toMatchObject({ total: '538.0000', amountPaid: '538.0000' });
      expect(await holdsOf(steadfast.id)).toEqual({ amount: '538.0000', parcels: 1 });
      const list = storefrontOrderPageSchema.parse(
        (await send('GET', '/storefront/orders?view=delivered')).json(),
      );
      expect(list.items.find((item) => item.id === order.id)?.parcelStatus).toBe('delivered');

      // Steadfast says delivered again, with another figure: the parcel keeps its receipt and its
      // amount (0081's receipt_kept would refuse a change), and nothing is refused
      await later();
      await notice(order, { status: 'delivered', cod_amount: 100, delivery_charge: 90 });
      const again = await getOrder(order.id);
      expect(again.shipments.at(-1)).toMatchObject({
        collectedAmount: '538.0000',
        courierCharge: '90.0000',
      });
      expect(await codReceipts()).toHaveLength(1);
    },
    COURIER_CLOCK,
  );

  // A shipped order the courier is about to deliver, and the member's page of it
  async function atTheDoor(n: number): Promise<StorefrontOrder> {
    const order = await bookedWith(await confirm(n), steadfast);
    await later();
    await notice(order, { status: 'pending' });
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    await later();
    return shipped;
  }

  it(
    'takes turns with Mark delivered: the courier first, and the button is refused',
    async () => {
      const order = await atTheDoor(2);
      const before = (await codReceipts()).length;
      // Both lock the order first. The courier's news holds it and waits at the invoice; the button
      // waits for the order, then finds it moved on (version_conflict), and makes nothing
      const [news, button] = await inTurn('invoices', [
        () => webhook(order, { status: 'delivered', cod_amount: 538 }),
        () =>
          send('POST', `/storefront/orders/${order.id}/deliver`, {
            version: order.version,
            collectedAmount: '500',
          }),
      ]);
      expect(news?.statusCode, news?.body).toBe(200);
      expect(button?.statusCode, button?.body).toBe(409);
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.collectedAmount).toBe('538.0000');
      expect(await codReceipts()).toHaveLength(before + 1);
    },
    COURIER_CLOCK,
  );

  it(
    "takes turns with Mark delivered: the button first, and the courier's figure is too late",
    async () => {
      const order = await atTheDoor(3);
      const before = (await codReceipts()).length;
      // The courier's delivered then finds the order delivered and the parcel with its receipt: it
      // keeps the member's ৳500 (0081's receipt_kept), and is still taken (200), as every notice is
      const [button, news] = await inTurn('invoices', [
        () =>
          send('POST', `/storefront/orders/${order.id}/deliver`, {
            version: order.version,
            collectedAmount: '500',
          }),
        () => webhook(order, { status: 'delivered', cod_amount: 538 }),
      ]);
      expect(button?.statusCode, button?.body).toBe(200);
      expect(news?.statusCode, news?.body).toBe(200);
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.collectedAmount).toBe('500.0000');
      expect((await invoiceOf(after)).amountPaid).toBe('500.0000');
      expect(await codReceipts()).toHaveLength(before + 1);
      const [invoices] = await sql`SELECT count(*)::int AS n FROM invoices
      WHERE tenant_id = ${shop.tenantId} AND customer_reference = ${order.orderNo}`;
      expect(invoices?.n).toBe(1);
    },
    COURIER_CLOCK,
  );
});

describe('Mark delivered by hand', () => {
  it(
    'takes what the member typed, up to the COD amount, and the whole amount when the box is empty',
    async () => {
      const shipped = await shippedBy(await confirm(4), pathao);
      const over = await refused(
        shipped.id,
        'deliver',
        { version: shipped.version, collectedAmount: '600' },
        422,
      );
      expect(over).toMatchObject({
        code: 'storefront_order_collected_over',
        fieldErrors: { collectedAmount: ['storefront_order_collected_over'] },
        params: { amount: '538.0000' },
      });
      // The button moves the manual parcel too, with a member's step
      const holds = await holdsOf(pathao.id);
      const delivered = await move(shipped.id, 'deliver', {
        version: shipped.version,
        collectedAmount: null,
      });
      const parcel = delivered.shipments.at(-1);
      expect(parcel).toMatchObject({ status: 'delivered', collectedAmount: '538.0000' });
      expect(parcel?.events.at(-1)).toMatchObject({ status: 'delivered' });
      expect((await invoiceOf(delivered)).amountPaid).toBe('538.0000');
      expect(await holdsOf(pathao.id)).toEqual({
        amount: (Number(holds.amount) + 538).toFixed(4),
        parcels: holds.parcels + 1,
      });

      // Nothing collected (the shopper paid nothing at the door): no receipt, the invoice stays due
      const none = await shippedBy(await confirm(5), pathao);
      const kept = await move(none.id, 'deliver', { version: none.version, collectedAmount: '0' });
      expect(kept.shipments.at(-1)).toMatchObject({ collectedAmount: '0.0000', receipt: null });
      expect((await invoiceOf(kept)).amountPaid).toBe('0.0000');
      expect(kept.needsAttention).toBe(false);
    },
    COURIER_CLOCK,
  );

  // Two orders and seven moves: more than vitest's 5 seconds on a busy machine (28b.8)
  it(
    'makes no receipt for a courier account without a COD account, nor for an order with no parcel',
    async () => {
      const before = (await codReceipts()).length;
      const shipped = await shippedBy(await confirm(6), redx);
      const delivered = await move(shipped.id, 'deliver', {
        version: shipped.version,
        collectedAmount: null,
      });
      // The amount is still kept on the parcel (the page shows it); the cash is a receipt by hand
      expect(delivered.shipments.at(-1)).toMatchObject({
        status: 'delivered',
        collectedAmount: '538.0000',
        receipt: null,
        receiptError: null,
      });
      expect((await invoiceOf(delivered)).amountPaid).toBe('0.0000');

      // The shop's own rider: no parcel to keep money on, so a typed amount says nothing
      const order = await confirm(7);
      const packed = await move(order.id, 'pack', {
        version: order.version,
        lines: WHOLE,
        courierAccountId: '',
      });
      const shippedOwn = await move(order.id, 'ship', { version: packed.version });
      const own = await move(order.id, 'deliver', {
        version: shippedOwn.version,
        collectedAmount: '538',
      });
      expect(own.status).toBe('delivered');
      expect(own.shipments).toEqual([]);
      expect(await codReceipts()).toHaveLength(before);
    },
    COURIER_CLOCK,
  );
});

describe('Record what came back', () => {
  it(
    "returns part of a parcel, bills what was kept and takes the courier's figure",
    async () => {
      const before = await stockOf(shop.variantId);
      let order = await bookedWith(await confirm(8), steadfast);
      // Not before the rider has it
      expect((await send('GET', `/storefront/orders/${order.id}/return-plan`)).statusCode).toBe(
        409,
      );
      await later();
      await notice(order, { status: 'pending' });
      await later();
      await notice(order, { status: 'partial_delivered', cod_amount: 309, delivery_charge: 80 });
      // The courier's word moves the parcel only: what came back is the member's to record
      order = await getOrder(order.id);
      expect(order.status).toBe('shipped');
      expect(order.shipments.at(-1)).toMatchObject({
        status: 'partly_delivered',
        collectedAmount: '309.0000',
        receipt: null,
      });
      const plan = storefrontReturnPlanSchema.parse(
        (await send('GET', `/storefront/orders/${order.id}/return-plan`)).json(),
      );
      const line = plan.lines[0];
      expect(plan.lines).toHaveLength(1);
      expect(line).toMatchObject({ quantity: '2.0000', tracking: 'none', serialNumbers: [] });
      const body = (lines: object[]) => ({
        version: order.version,
        lines,
        collectedAmount: null,
        reason: 'Wrong size',
      });

      // A line of another challan, nothing, and everything are each refused
      expect(
        await refused(
          order.id,
          'partly-deliver',
          body([
            {
              deliveryLineId: '00000000-0000-4000-8000-000000000000',
              quantity: '1',
              serialNumbers: [],
            },
          ]),
          409,
        ),
      ).toMatchObject({
        code: 'storefront_order_line_missing',
        fieldErrors: { 'lines.0.deliveryLineId': ['storefront_order_line_missing'] },
      });
      expect((await refused(order.id, 'partly-deliver', body([]), 400)).fieldErrors).toMatchObject({
        lines: ['storefront_order_return_nothing'],
      });
      expect(
        (
          await refused(
            order.id,
            'partly-deliver',
            body([{ deliveryLineId: line?.deliveryLineId, quantity: '2', serialNumbers: [] }]),
            409,
          )
        ).code,
      ).toBe('storefront_order_return_everything');

      const done = await move(
        order.id,
        'partly-deliver',
        body([{ deliveryLineId: line?.deliveryLineId, quantity: '1', serialNumbers: [] }]),
      );
      expect(done.status).toBe('delivered');
      expect(done.salesReturn?.number).toMatch(/^SR-/);
      expect(done.shipments.at(-1)).toMatchObject({
        status: 'partly_delivered',
        collectedAmount: '309.0000',
      });
      // One face wash and the delivery charge, paid by the rider's ৳309
      const invoice = await invoiceOf(done);
      expect(invoice).toMatchObject({ total: '309.0000', amountPaid: '309.0000' });
      expect(await salesOrderStatus(done)).toBe('closed');
      // Two went out, one came back
      expect(await stockOf(shop.variantId)).toBe(before - 1);
      const [audit] = await sql`SELECT payload::text AS text FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.partly_delivered'`;
      expect(audit?.text).toContain('Wrong size');
    },
    COURIER_CLOCK,
  );

  it("needs the amount when the courier gave none, and cuts a coupon's discount with the goods", async () => {
    const coupon = await send('POST', '/storefront/coupons', {
      code: 'WELCOME10',
      kind: 'percent',
      value: '10',
      upTo: '',
      minimum: '',
      startsOn: '',
      lastDay: '',
      usageLimit: '',
      onePerPhone: false,
    });
    expect(coupon.statusCode, coupon.body).toBe(201);
    // Two face washes with 10% off (৳45.80) and the ৳80 delivery charge
    const request = {
      ...orderRequest(shop.listingId, 2, phoneOf(9), '492.2'),
      couponCode: 'WELCOME10',
    };
    const order = await shippedBy(await confirm(9, request), pathao);
    expect(order.shipments.at(-1)?.codAmount).toBe('492.2000');
    const plan = storefrontReturnPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/return-plan`)).json(),
    );
    const lines = [
      { deliveryLineId: plan.lines[0]?.deliveryLineId, quantity: '1', serialNumbers: [] },
    ];
    // A manual parcel has no courier's figure, and the COD amount is for the whole parcel
    expect(
      await refused(
        order.id,
        'partly-deliver',
        { version: order.version, lines, collectedAmount: null, reason: '' },
        422,
      ),
    ).toMatchObject({
      code: 'storefront_order_collected_required',
      fieldErrors: { collectedAmount: ['storefront_order_collected_required'] },
    });
    // Nothing of it was written: the return and the invoice rolled back with the refusal
    const still = await getOrder(order.id);
    expect(still).toMatchObject({ status: 'shipped', salesReturn: null, invoice: null });

    const done = await move(order.id, 'partly-deliver', {
      version: order.version,
      lines,
      collectedAmount: '286.1',
      reason: '',
    });
    // One face wash keeps half the discount: ৳229 − ৳22.90 + ৳80
    const invoice = await invoiceOf(done);
    expect(invoice).toMatchObject({ total: '286.1000', amountPaid: '286.1000' });
    expect(done.shipments.at(-1)?.receipt?.number).toMatch(/^MR-/);
  });

  it('takes back the serial numbers of the pieces that came back', async () => {
    // Two dryers (৳3,600): free delivery
    const order = await confirm(10, orderRequest(dryer.listingId, 2, phoneOf(10), '3600'));
    const shipped = await shippedBy(order, redx, [
      {
        position: 1,
        picks: [{ batchId: '', quantity: '2', serialNumbers: ['HD-1001', 'HD-1003'] }],
      },
    ]);
    const plan = storefrontReturnPlanSchema.parse(
      (await send('GET', `/storefront/orders/${shipped.id}/return-plan`)).json(),
    );
    expect(plan.lines[0]).toMatchObject({
      tracking: 'serial',
      serialNumbers: ['HD-1001', 'HD-1003'],
    });
    const back = (serialNumbers: string[]) => ({
      version: shipped.version,
      lines: [{ deliveryLineId: plan.lines[0]?.deliveryLineId, quantity: '1', serialNumbers }],
      collectedAmount: '1800',
      reason: '',
    });
    // HD-1002 never left the shelf: it cannot come back with this parcel
    expect(
      (await refused(shipped.id, 'partly-deliver', back(['HD-1002']), 409)).fieldErrors,
    ).toMatchObject({ 'lines.0.serialNumbers': ['return_serial_invalid'] });
    const done = await move(shipped.id, 'partly-deliver', back(['HD-1003']));
    expect((await invoiceOf(done)).total).toBe('1800.0000');
    const shelf = z
      .array(z.object({ s: z.string() }))
      .parse(
        await sql`SELECT serial_number AS s FROM serials
          WHERE tenant_id = ${shop.tenantId} AND warehouse_id IS NOT NULL ORDER BY serial_number`,
      )
      .map((row) => row.s);
    expect(shelf).toEqual(['HD-1002', 'HD-1003']);
  });
});

describe('Receive the return', () => {
  it(
    'puts a parcel the courier brought back on the shelf, with no invoice',
    async () => {
      const before = await stockOf(shop.variantId);
      let order = await bookedWith(await confirm(11), steadfast);
      // Packed, not shipped: there is nothing to receive yet
      expect(
        (await refused(order.id, 'return', { version: order.version, reason: '' }, 409)).code,
      ).toBe('storefront_order_step_invalid');
      await later();
      await notice(order, { status: 'pending' });
      await later();
      await notice(order, { status: 'cancelled' });
      order = await getOrder(order.id);
      expect(order).toMatchObject({ status: 'shipped', parcelStatus: 'returning' });
      expect(order.shipments.at(-1)?.status).toBe('returning');

      const returned = await move(order.id, 'return', {
        version: order.version,
        reason: 'Customer refused the parcel',
      });
      expect(returned).toMatchObject({ status: 'returned', invoice: null });
      expect(returned.salesReturn?.number).toMatch(/^SR-/);
      expect(returned.shipments.at(-1)?.status).toBe('returned');
      expect(await stockOf(shop.variantId)).toBe(before);
      // The sales order delivered nothing in the end: the sales rules call that cancelled
      expect(await salesOrderStatus(returned)).toBe('cancelled');
      const tab = storefrontOrderPageSchema.parse(
        (await send('GET', '/storefront/orders?view=returned')).json(),
      );
      expect(tab.items.map((item) => item.id)).toContain(order.id);
      // The shopper hears of it by SMS, without the staff's reason
      await eventually(async () => {
        const sms = await lastMailTo(mail.apiUrl, smsAddress(phoneOf(11)));
        expect(sms.text).toContain('came back to us');
        expect(sms.text).not.toContain('refused');
      });
    },
    COURIER_CLOCK,
  );

  it('takes a manual parcel back from the rider, with a member step', async () => {
    const shipped = await shippedBy(await confirm(12), pathao);
    const returned = await move(shipped.id, 'return', { version: shipped.version, reason: '' });
    const parcel = returned.shipments.at(-1);
    expect(parcel).toMatchObject({ status: 'returned', collectedAmount: null, receipt: null });
    expect(parcel?.events.at(-1)?.status).toBe('returned');
  });
});

describe('Make the receipt', () => {
  it(
    'keeps a refused COD receipt on the parcel, rings once, and makes it again',
    async () => {
      const order = await bookedWith(await confirm(13), steadfast);
      const parcelId = order.shipments.at(-1)?.id ?? '';
      // The COD account archived since the account was saved: the receipt's own check refuses it
      await setArchived(codAccount.id, true);
      try {
        await later();
        await notice(order, { status: 'delivered', cod_amount: 538 });
        // The Delivered and the invoice stand: only the receipt failed
        const delivered = await getOrder(order.id);
        expect(delivered).toMatchObject({ status: 'delivered', needsAttention: true });
        expect(delivered.shipments.at(-1)).toMatchObject({
          collectedAmount: '538.0000',
          receipt: null,
          receiptError: 'receipt_account_invalid',
        });
        expect((await invoiceOf(delivered)).amountPaid).toBe('0.0000');
        const bells = await sql`SELECT user_id FROM notifications
        WHERE type = 'storefront.cod_receipt_failed' AND params->>'id' = ${order.id}`;
        expect(bells).toHaveLength(1);
        const list = storefrontOrderPageSchema.parse(
          (await send('GET', '/storefront/orders?view=delivered')).json(),
        );
        expect(list.items.find((item) => item.id === order.id)?.needsAttention).toBe(true);

        // Pressed while it is still archived: refused again, the error kept, no second bell
        const again = await send(
          'POST',
          `/storefront/orders/${order.id}/shipments/${parcelId}/receipt`,
          { version: delivered.version },
        );
        expect(again.statusCode, again.body).toBe(409);
        expect((await getOrder(order.id)).shipments.at(-1)?.receiptError).toBe(
          'receipt_account_invalid',
        );
        const rang = await sql`SELECT 1 FROM notifications
        WHERE type = 'storefront.cod_receipt_failed' AND params->>'id' = ${order.id}`;
        expect(rang).toHaveLength(1);
      } finally {
        await setArchived(codAccount.id, false);
      }

      const current = await getOrder(order.id);
      const made = await move(order.id, `shipments/${parcelId}/receipt`, {
        version: current.version,
      });
      expect(made.needsAttention).toBe(false);
      expect(made.version).toBe(current.version + 1);
      expect(made.shipments.at(-1)).toMatchObject({ receiptError: null });
      expect(made.shipments.at(-1)?.receipt?.number).toMatch(/^MR-/);
      expect((await invoiceOf(made)).amountPaid).toBe('538.0000');
      const [audit] = await sql`SELECT 1 FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.cod_receipt_made'`;
      expect(audit).toBeDefined();
      // Twice is refused: the parcel has its receipt
      expect(
        (await refused(order.id, `shipments/${parcelId}/receipt`, { version: made.version }, 409))
          .code,
      ).toBe('storefront_cod_receipt_not_failed');
    },
    COURIER_CLOCK,
  );

  it(
    'stops counting a voided COD receipt in what the courier holds, and keeps it linked',
    async () => {
      const order = await bookedWith(await confirm(14), steadfast);
      await later();
      await notice(order, { status: 'delivered', cod_amount: 538 });
      const delivered = await getOrder(order.id);
      const receiptId = delivered.shipments.at(-1)?.receipt?.id ?? '';
      const holds = await holdsOf(steadfast.id);
      const receipt = receiptSchema.parse((await send('GET', `/receipts/${receiptId}`)).json());
      const voided = await send('POST', `/receipts/${receiptId}/void`, {
        version: receipt.version,
        date: receipt.date,
        reason: 'The rider handed in the wrong parcel',
      });
      expect(voided.statusCode, voided.body).toBe(200);
      expect(await holdsOf(steadfast.id)).toEqual({
        amount: (Number(holds.amount) - 538).toFixed(4),
        parcels: holds.parcels - 1,
      });
      // The parcel still names its receipt (now voided), so there is nothing to make again: a new
      // receipt for the money is typed by hand (a known limit of 28b)
      const after = await getOrder(order.id);
      expect(after.shipments.at(-1)?.receipt?.id).toBe(receiptId);
      expect(
        (
          await refused(
            order.id,
            `shipments/${after.shipments.at(-1)?.id ?? ''}/receipt`,
            { version: after.version },
            409,
          )
        ).code,
      ).toBe('storefront_cod_receipt_not_failed');
    },
    COURIER_CLOCK,
  );
});

describe('permissions', () => {
  it('lets storefront.order.read see the parcel money and move nothing', async () => {
    const order = await shippedBy(await confirm(15), pathao);
    const seen = await send('GET', `/storefront/orders/${order.id}`, undefined, reader);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(storefrontOrderSchema.parse(seen.json()).shipments.at(-1)?.codAmount).toBe('538.0000');
    const parcelId = order.shipments.at(-1)?.id ?? '';
    for (const [method, url, body] of [
      ['POST', 'deliver', { version: order.version, collectedAmount: null }],
      [
        'POST',
        'partly-deliver',
        { version: order.version, lines: [], collectedAmount: null, reason: '' },
      ],
      ['POST', 'return', { version: order.version, reason: '' }],
      ['GET', 'return-plan', undefined],
      ['POST', `shipments/${parcelId}/receipt`, { version: order.version }],
    ] as const) {
      const res = await send(method, `/storefront/orders/${order.id}/${url}`, body, reader);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await getOrder(order.id)).status).toBe('shipped');
  });
});
```

The file's helpers, in order:

- **`refusalSchema` keeps `params` too,** because `storefront_order_collected_over` says the COD amount in it, and the
  page's error text needs that number.
- **`confirm(n, request?)`** places the order as a shopper does (the code from Mailpit) and waits for the worker's
  sales order. A test may pass its own request (the coupon's, the dryers'); `n` still picks the phone and the
  address, so no two tests share the shop's limits.
- **`bookedWith` and `shippedBy`** are the two ways a parcel leaves: by the API (the worker books it, so the test
  waits for `booked`) or by hand (Book courier with a tracking code, then Mark shipped). `lines` is typed `object[]`:
  the dryers' pick has serial numbers, while `WHOLE`'s are an empty array, which TypeScript reads as `never[]`.
- **`webhook` and `notice`:** `webhook` is the courier's request and its answer, for the race, where a test checks
  the status itself; `notice` is a webhook that must be taken.
- **`later` and `COURIER_CLOCK`:** the fake courier sends no time, so a step's time is the moment it reached the API
  and the parcel's newest step wins by it. Two steps in the same second could tie, so a test waits a second between
  them. A test that waits more than once needs more than vitest's 5 seconds; `COURIER_CLOCK` (20 s) is its timeout.
  Without it a slow test is stopped half way, its last requests still run, and the next test counts their receipts.
- **`codReceipts`** reads the receipts by `method = 'courier'` straight from the database: the method is what says a
  receipt came from a parcel, and a test counts them to prove "none twice".
- **`holdsOf`** is the Shop couriers page's own number, so the tests check what a person sees. A test compares it
  with the value before the test, never with a fixed sum: the tests share one shop.
- **`inTurn`** is 28a's gate. Here it locks `invoices`: both the webhook and Mark delivered lock the order first and
  then post an invoice, so the first request sent holds the order and waits at `invoices`, and the second waits for
  the order. When the gate opens they run in the order they were sent, which makes "who came first" certain.
- **The dryers come in by a posted stock adjustment,** not by `setStock`: a serial number exists only once stock
  brought it in, as in 27b's tests.

What each test proves:

- **The money accounts.** The choices are the right kinds (money accounts for COD, expense accounts for the charge);
  a wrong kind or an unknown id is refused under its own box, and nothing is saved; the audit row names the accounts
  by their codes. The second test proves mine 33: an account archived since is refused on the next save, a restored
  one is taken again. RedX ends without a COD account, for the test that needs one with none.
- **The courier's delivered.** ৳900 named on a ৳538 parcel is cut to ৳538 (mine 15), while the event keeps the 900
  (mine 36); one receipt by `courier` into the COD account with the tracking code as its reference (mine 34); the
  invoice paid; the account holds it; the list's pill. A second "delivered" with another figure changes only the
  charge: the receipt's amount is kept (0081's `receipt_kept`), and the webhook is still answered 200.
- **The two races.** The courier first: the button's page is out of date, so it is refused (409) and makes nothing.
  The button first: the courier's later "delivered" keeps the member's ৳500 and is still taken. Each makes one
  receipt and one invoice. The second one is the test that found mine 35.
- **Mark delivered by hand.** Over the COD amount is refused under the box with the amount; an empty box takes the
  whole COD amount; the manual parcel moves with a member's step; ৳0 makes no receipt and leaves the invoice due. A
  courier account without a COD account keeps the amount on the parcel and makes no receipt; an order with no parcel
  (the shop's own rider) ignores a typed amount.
- **Record what came back.** Before the rider has the parcel the plan is refused; a line of another challan, no line
  and every line are refused with their own codes (no line is the contract's `min(1)`, so it is a 400 with the code
  under `lines`); one of two back bills ৳309 and the rider's ৳309 pays it, the sales order is closed, one piece is
  back in stock, the audit row has the reason. With a coupon, the amount is needed (no courier's figure, and the COD
  amount is for the whole parcel), the refusal leaves nothing written, and the kept face wash keeps half the
  discount (mine 32: ৳229 − ৳22.90 + ৳80). With serial numbers, only a piece that went in the parcel can come back.
- **Receive the return.** Not before the parcel left; after the courier's cancel (returning) it puts the stock back,
  makes no invoice, cancels the sales order (mine 29), lists the order under Returned and texts the shopper without
  the staff's reason. A manual parcel comes back with a member's step.
- **Make the receipt.** The COD account archived before the courier's "delivered": the order is Delivered and its
  invoice posted, the error is on the parcel, the order needs attention (on the page and in the list), one bell.
  Pressed again while archived: refused, the error kept, no second bell (mine 31: the member who pressed sees it).
  Restored: the receipt is made, the order's version moves on (another tab reloads first), the audit row, and twice
  is refused.
- **A voided COD receipt** stops counting in what the courier holds (mine 26) and stays linked, so Make the receipt
  is refused: the money is then a receipt typed by hand. The guide's known limit.
- **Permissions.** `storefront.order.read` sees the parcel's money and gets 403 from every 28b route, including the
  return plan, which is a read only a member who moves orders needs.

### Tenant leak

```diff
@@ -1,6 +1,8 @@
 import type { INestApplicationContext } from '@nestjs/common';
 import type { NestFastifyApplication } from '@nestjs/platform-fastify';
 import {
+  accountListSchema,
+  accountSchema,
   type CourierAccount,
   courierAccountSavedSchema,
   courierAccountSchema,
@@ -74,6 +76,12 @@ let nirvorOrder: StorefrontOrder;
 let acmeOrder: StorefrontOrder;
 
 const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
+// An id no row has: the 404 comes before any line is looked at
+const ZERO_ID = '00000000-0000-4000-8000-000000000000';
+// 28b: a courier account's two money accounts (the COD account and the charge account) have no
+// default, so every body sends both. These tests are about the rest of the account: both stay
+// empty, and cod.int.spec.ts tests them
+const NO_COD = { codAccountId: '', chargeAccountId: '' };
 
 function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
   return app.inject({
@@ -87,6 +95,7 @@ function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payloa
 async function addSteadfast(who: SignedIn, apiKey: string) {
   const res = await send(who, 'POST', '/storefront/couriers', {
     provider: 'steadfast',
+    ...NO_COD,
     name: 'Steadfast',
     apiKey,
     secretKey: `${apiKey}-secret`,
@@ -248,7 +257,7 @@ describe('Shop couriers', () => {
       [
         'PUT',
         `/storefront/couriers/${id}`,
-        { provider: 'steadfast', name: 'Taken', apiKey: '', secretKey: '', ...version },
+        { ...NO_COD, provider: 'steadfast', name: 'Taken', apiKey: '', secretKey: '', ...version },
       ],
       ['POST', `/storefront/couriers/${id}/test`, undefined],
       ['POST', `/storefront/couriers/${id}/webhook-token`, version],
@@ -443,7 +452,16 @@ describe('the database roles', () => {
       code: '42501',
       message: 'permission denied for table storefront_shipments',
     });
-    for (const column of ['cod_amount', 'consignment_id', 'error_detail']) {
+    // Step 28b: and none of the parcel's money
+    for (const column of [
+      'cod_amount',
+      'consignment_id',
+      'error_detail',
+      'collected_amount',
+      'courier_charge',
+      'receipt_id',
+      'receipt_error',
+    ]) {
       expect(
         await deniedAs(
           asShop,
@@ -520,3 +538,123 @@ describe('the database roles', () => {
     }
   });
 });
+
+// Step 28b: a workspace's COD money is its own. Nirvor's Steadfast account gets a COD account and
+// delivers one parcel by the courier's news; Acme must not name Nirvor's ledger account, nor move,
+// read or "make the receipt" of Nirvor's order, and what Acme's account holds counts only Acme's
+// parcels
+describe('COD money', () => {
+  it("never names another workspace's ledger account, nor moves or counts its parcels", async () => {
+    const chart = accountListSchema.parse(
+      (await send(nirvorOwner, 'GET', '/accounts')).json(),
+    ).items;
+    const cash = chart.find((account) => account.code === '1110');
+    if (cash?.parentId == null) throw new Error('no Cash in hand');
+    const made = await send(nirvorOwner, 'POST', '/accounts', {
+      parentId: cash.parentId,
+      code: '1191',
+      name: 'Cash with Steadfast',
+      isGroup: false,
+      holdsMoney: true,
+      description: '',
+    });
+    expect(made.statusCode, made.body).toBe(201);
+    const nirvorCash = accountSchema.parse(made.json());
+
+    // Acme cannot put Nirvor's account on its courier account, new or saved
+    const acmeNow = courierSetupSchema.parse(
+      (await send(acmeOwner, 'GET', '/storefront/couriers')).json(),
+    ).accounts[0];
+    for (const [method, url, extra] of [
+      ['POST', '/storefront/couriers', { apiKey: 'acme-2', secretKey: 'acme-2-secret' }],
+      [
+        'PUT',
+        `/storefront/couriers/${acmeAccount.id}`,
+        { apiKey: '', secretKey: '', version: acmeNow?.version },
+      ],
+    ] as const) {
+      const res = await send(acmeOwner, method, url, {
+        provider: 'steadfast',
+        name: 'Steadfast',
+        codAccountId: nirvorCash.id,
+        chargeAccountId: '',
+        ...extra,
+      });
+      expect(res.statusCode, `${method} ${url}`).toBe(422);
+      expect(res.json()).toMatchObject({ code: 'courier_cod_account_invalid' });
+    }
+
+    // Nirvor's account takes its own, and a parcel delivered by the courier's news gets its receipt
+    const own = courierSetupSchema
+      .parse((await send(nirvorOwner, 'GET', '/storefront/couriers')).json())
+      .accounts.find((account) => account.id === nirvorAccount.id);
+    const saved = await send(nirvorOwner, 'PUT', `/storefront/couriers/${nirvorAccount.id}`, {
+      provider: 'steadfast',
+      name: 'Steadfast',
+      apiKey: '',
+      secretKey: '',
+      codAccountId: nirvorCash.id,
+      chargeAccountId: '',
+      version: own?.version,
+    });
+    expect(saved.statusCode, saved.body).toBe(200);
+    const order = await confirmAt(nirvor, nirvorOwner, 1006);
+    expect((await packWith(nirvorOwner, order, nirvorAccount.id)).statusCode).toBe(200);
+    const booked = await bookedAt(nirvorOwner, order.id);
+    // A second later, so the delivered step is newer than the booking by the courier's clock
+    await new Promise((resolve) => setTimeout(resolve, 1100));
+    const res = await webhook(nirvorAccount.id, nirvorToken, {
+      notification_type: 'delivery_status',
+      consignment_id: Number(booked.shipments.at(-1)?.consignmentId),
+      status: 'delivered',
+      cod_amount: 538,
+    });
+    expect(res.statusCode, res.body).toBe(200);
+    const delivered = await getOrder(nirvorOwner, order.id);
+    const parcel = delivered.shipments.at(-1);
+    expect(parcel?.receipt?.number).toMatch(/^MR-/);
+    const holds = async (who: SignedIn) =>
+      courierSetupSchema
+        .parse((await send(who, 'GET', '/storefront/couriers')).json())
+        .accounts.map((account) => account.holds);
+    expect(await holds(nirvorOwner)).toContainEqual({ amount: '538.0000', parcels: 1 });
+    expect(await holds(acmeOwner)).toEqual([{ amount: '0.0000', parcels: 0 }]);
+
+    // Nirvor's order from Acme: not there, for every 28b route
+    const version = { version: delivered.version };
+    for (const [method, url, body] of [
+      ['GET', 'return-plan', undefined],
+      ['POST', 'deliver', { ...version, collectedAmount: null }],
+      [
+        'POST',
+        'partly-deliver',
+        {
+          ...version,
+          lines: [{ deliveryLineId: ZERO_ID, quantity: '1', serialNumbers: [] }],
+          collectedAmount: null,
+          reason: '',
+        },
+      ],
+      ['POST', 'return', { ...version, reason: '' }],
+      ['POST', `shipments/${parcel?.id ?? ''}/receipt`, version],
+    ] as const) {
+      const answer = await send(acmeOwner, method, `/storefront/orders/${order.id}/${url}`, body);
+      expect(answer.statusCode, `${method} ${url}`).toBe(404);
+    }
+    // Acme's own order with Nirvor's parcel: there is no such parcel on it, and Nirvor's parcel
+    // keeps its receipt and no error
+    const acmeOwn = await getOrder(acmeOwner, acmeOrder.id);
+    const mixed = await send(
+      acmeOwner,
+      'POST',
+      `/storefront/orders/${acmeOwn.id}/shipments/${parcel?.id ?? ''}/receipt`,
+      { version: acmeOwn.version },
+    );
+    expect(mixed.statusCode).toBe(409);
+    expect(mixed.json()).toMatchObject({ code: 'storefront_cod_receipt_not_failed' });
+    expect((await getOrder(nirvorOwner, order.id)).shipments.at(-1)).toMatchObject({
+      receipt: { id: parcel?.receipt?.id },
+      receiptError: null,
+    });
+  });
+});
```

- **The shop's roles** read none of the parcel's four new columns. 0080 granted them nothing; the test keeps it so
  when a later migration grants the tracking page more.
- **COD money:** Acme cannot name Nirvor's ledger account on a new or a saved courier account (the chart the check
  reads is Acme's own, under RLS); Nirvor's account takes its own, and a parcel delivered by the courier's news gets
  its receipt; Nirvor holds ৳538 and Acme's account holds nothing; every 28b route with Nirvor's order answers 404 to
  Acme; and Acme's own order with Nirvor's parcel id finds no such parcel (409, as for a parcel with no failed
  receipt), with Nirvor's parcel left as it was. `ZERO_ID` is an id no row has: the 404 comes before any line is
  read, so the line's id does not matter.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src
pnpm --filter @omnivo/api test
cd apps/api
npx vitest run src/storefront/shipping/ src/storefront/orders/ src/sales/returns.int.spec.ts \
  src/sales/sales-documents.int.spec.ts --maxWorkers=3
```

What ran on commit c331801:

- **Typecheck, lint, prettier:** clean.
- **Unit tests:** 31 files, 246 tests, all pass.
- **`cod.int.spec.ts`:** 15 tests pass. **`couriers.tenant-leak`:** 10 pass (9 before, plus COD money).
- **28a's `couriers.int`, the storefront orders suites (with their leak suites), returns and sales documents:** 13
  files, 184 tests, all pass, so the webhook's second transaction changed nothing 28a tests.
- **Broken on purpose,** one at a time, each with `cod.int.spec.ts`:
  1. the webhook's update back inside the news transaction: the "button first" race fails with a 500 (mine 35);
  2. no `raw` on a money notice: the delivered test fails (mine 36);
  3. no cut to the COD amount in `moneyOf`: the delivered test fails (the parcel keeps ৳900);
  4. no `receiptId` check in `moneyOf`: the delivered test and the "button first" race fail (0081's `receipt_kept`
     refuses the change, a 500);
  5. the receipt made without its savepoint: every test still passes (mine 37).
- **Not tested:** an order paid online and then delivered by a courier with a COD account (its COD amount is ৳0, the
  same branch as the ৳0 test), the poll's "delivered" (the poll names no money, and it moves the order with the same
  `ShopOrderMoves.deliver` as the webhook), and a second parcel of one order.

## 28b.5 — `packages/i18n`: the words of the COD screens

The screens of 28b.6 need their words in English and Bangla, so they come first. 28b.1 already gave the errors, the
audit log's actions, the bell and the receipt's new method their words. This part adds the courier account dialog's
two account selects, the Shop couriers page's "Holds" column, the orders list's Returned tab and its second pill,
the order page's two new buttons, its notices and toasts, Mark delivered's amount box, the "Record what came back"
and "Receive the return" dialogs, the parcel card's money facts, and the audit log's names for the new fields. The
shop's words do not change: its tracking page already says Delivered, Partly delivered and Returned (26e).

These words come before the mockup. If the mockup in 28b.6 changes a screen, the words change with it, and the
diffs below show them as they are at the end of the step.

Six decisions came up while writing the words (mine):

38. **An empty account select says what empty means.** Its first option is "None: record the rider's cash by hand"
    (and "None yet" for the charges), never "Pick an account". Decision 20 gives the two fields no default, and no
    COD account is a real choice (decision 2: the cash is then typed as a receipt, as before 28b). "Pick an
    account" would read as a missing step, like 28a's "Don't book at Packed" (28a's decision 44).
39. **28b.1's Bangla words now use the app's own terms:** মানি রিসিট (not রসিদ), চালু (not সক্রিয়), the rider
    নেন the cash as on the parcel card ("রাইডার নেবেন"), and the two buttons by their Bangla names in quotes. An
    error that names a button the screen calls by another name sends the person looking for a button that is not
    there. The English errors already matched.
40. **The list's second pill is for two parcel steps only:** Partly delivered and Coming back. They are the two that
    wait for the staff (decisions 6 and 7). The courier's other steps are its own work, and a parcel is Returned only
    after Receive the return, which moves the order to Returned as well.
41. **Mark delivered's dialog has three bodies:** with no COD account, the invoice stays unpaid until the money is
    recorded (as before); with one, a money receipt goes into it too; on an order paid online, the invoice takes
    that payment's receipt and is paid. Since 27d the one body said "stays unpaid" on a paid online order too. That
    was wrong, and it is fixed here because the dialog's words change anyway.
42. **"Receive the return" says to check the shelf in its own line** (`check`), not inside the body. Decision 7
    (stock comes back only once the parcel is here) is the one thing a member must not skip, so it gets a line of
    its own that the screen can show as a notice.
43. **`storefront_order_line_missing` keeps its packing words.** In "Record what came back" it can only come from a
    request the dialog never sends: its rows come from the return plan, and a posted challan's lines never change.
    The other errors the dialog can show (`return_serial_invalid`, `return_over_delivered`, `return_line_twice`)
    read well there as they are.

### `locales/en.ts`

```diff
@@ -5506,6 +5506,8 @@ export const en = {
         account: 'Account',
         news: 'Courier’s news',
         test: 'Last test',
+        // Step 28b (decision 12)
+        holds: 'Holds',
         status: 'Status',
         // 28a.6: the row menu's column, read by screen readers only
         actions: 'Actions',
@@ -5522,6 +5524,14 @@ export const en = {
       testWorked: 'Keys accepted {{date}}',
       testRejected: 'Keys refused {{date}}',
       testUnreachable: 'No answer {{date}}',
+      // Step 28b (decision 12): what the courier holds of the shop's cash, the posted COD
+      // receipts of its parcels (a voided one drops out). amount = whole taka, count = the
+      // parcels
+      holds_one: '{{amount}} · {{formatted}} parcel',
+      holds_other: '{{amount}} · {{formatted}} parcels',
+      holdsNothing: 'Nothing yet',
+      // No COD account: the rider's cash is a receipt typed by hand, as before 28b
+      holdsNoAccount: 'No COD account',
       // The row menu
       actionsFor: 'Actions for {{name}}',
       edit: 'Edit',
```

The Shop couriers page's new column (decision 12). `holds_*` uses `{{formatted}}` with `count`, like `items_*`, so
the number is in the reader's digits and the plural follows the count; `amount` is whole taka, like every list. It
counts posted receipts only, so a receipt voided by hand drops out (mine 26). An account with nothing in it says
"Nothing yet", and one with no COD account says so in place of a ৳0 that would look like a courier that owes
nothing.

```diff
@@ -5581,6 +5591,23 @@ export const en = {
         courier: 'Courier',
         courierPlaceholder: 'Pick a courier',
         courierHint: 'Whose website or app you book on. The tracking page names it.',
+        // Step 28b (decisions 2, 3 and 20): active accounts only, code · name. Empty is a real
+        // choice, so its option says what it means
+        codAccount: 'COD account',
+        codAccountNone: 'None: record the rider’s cash by hand',
+        codAccountHint:
+          'An account that holds money, like “Cash with Steadfast”. When a parcel is delivered, a money receipt for what the rider collected goes into it. Its balance is what the courier owes you.',
+        // Editing an account that has one: the receipts already made stay where they went
+        codAccountSavedHint:
+          'A change counts for the next receipts only. The receipts already made stay in the account they went into.',
+        chargeAccount: 'Courier charges account',
+        chargeAccountNone: 'None yet',
+        chargeAccountHint:
+          'An expense account, like “Courier charges”. The courier’s delivery and return charges go here when its payout is recorded.',
+        accountOption: '{{code}} · {{name}}',
+        noCodAccounts:
+          'No active account holds money yet. Add one, like “Cash with Steadfast”, under the cash accounts in the chart of accounts.',
+        noChargeAccounts: 'No active expense account yet. Add one in the chart of accounts.',
         create: 'Add account',
         save: 'Save changes',
         created: 'Courier account {{name}} added',
```

The courier account dialog's two selects (decisions 2, 3 and 20, mine 38). Each hint says what the account is for
in the shop's own words: the COD account's balance is what the courier owes, and the charges account is used when
the courier's payout is recorded (28c). `codAccountSavedHint` shows when editing an account that has one: a change
moves no money, so a tenant who switches accounts is not surprised that the old account keeps its receipts.
`noCodAccounts` says where to add one, because a fresh chart of accounts has no "Cash with Steadfast". The option
is `code · name`, the gateway card's format.

```diff
@@ -6063,13 +6090,14 @@ export const en = {
       searchPlaceholder: 'Order number, name or phone',
       view: 'Show',
       // The tabs (STOREFRONT_ORDER_VIEWS). "New" is a confirmed order nobody has packed yet
-      // (decision 13); returned has no tab until step 28, it shows under All
+      // (decision 13). Step 28b (mine 18): Returned, the orders received back
       views: {
         confirmed: 'New',
         packed: 'Packed',
         shipped: 'Shipped',
         delivered: 'Delivered',
         cancelled: 'Cancelled',
+        returned: 'Returned',
         all: 'All',
       },
       // The status pill (STOREFRONT_ORDER_STATUSES), the tab's own word
@@ -6083,6 +6111,9 @@ export const en = {
       },
       // A second, crit pill: the sales order could not be made (decision 16)
       needsAttention: 'Needs attention',
+      // Step 28b (mine 18): a second, warn pill on a shipped order whose newest parcel did not
+      // all reach the shopper (parcelStatus). The staff act once the goods are back
+      parcelPills: { partly_delivered: 'Partly delivered', returning: 'Coming back' },
       columns: {
         order: 'Order',
         confirmed: 'Confirmed',
@@ -6106,6 +6137,8 @@ export const en = {
         shipped: 'No order is on its way.',
         delivered: 'No order is delivered yet.',
         cancelled: 'No order was cancelled.',
+        // Step 28b
+        returned: 'No order came back.',
       },
       noMatchTitle: 'No order matches',
       noMatchBody: 'Check the number or the phone. The search looks in this tab only.',
```

The orders list: the Returned tab (mine 18) with its empty line, and the second pill of decision 40. The tab and
the pill have exactly the keys the type check needs: `views` has the keys of `STOREFRONT_ORDER_VIEWS` (the router's
`satisfies` reads them), and `parcelPills` only the two statuses the list shows.

```diff
@@ -6140,6 +6173,9 @@ export const en = {
       cancel: 'Cancel order',
       // Step 28a: on a packed order with no parcel on its way (or one that was cancelled)
       book: 'Book courier',
+      // Step 28b (decisions 6 and 7): on a shipped order, once the goods are back on the shelf
+      recordCameBack: 'Record what came back',
+      receiveReturn: 'Receive the return',
       // The toasts. number = the order's (W-000123), the others the documents' own
       salesOrderMade: 'Sales order {{salesOrder}} made for {{number}}',
       packed: '{{number}} packed. Challan {{delivery}} posted.',
@@ -6152,6 +6188,15 @@ export const en = {
       bookingStarted: 'Booking {{number}}’s parcel with {{courier}}',
       booked: '{{number}} booked with {{courier}}, code {{code}}',
       bookingAgain: 'Booking {{number}}’s parcel again',
+      // Step 28b. receipt = the COD money receipt's number, salesReturn = the return's
+      deliveredWithReceipt:
+        '{{number}} delivered. Invoice {{invoice}} and money receipt {{receipt}} posted.',
+      partlyDelivered:
+        '{{number}} partly delivered. Sales return {{salesReturn}} and invoice {{invoice}} posted.',
+      partlyDeliveredWithReceipt:
+        '{{number}} partly delivered. Sales return {{salesReturn}}, invoice {{invoice}} and money receipt {{receipt}} posted.',
+      returnReceived:
+        '{{number}} returned. Sales return {{salesReturn}} posted. The shopper gets an SMS.',
       // The neutral document notice under the header: what the next step does
       next: {
         confirmed:
```

The two buttons and the toasts. Each toast names the documents the move posted, like 27b's "Invoice {{invoice}}
posted": a member who sees the sales return's number knows the stock came back. The `WithReceipt` toasts are used
only when a COD receipt was made, so a toast never names a receipt that is not there. `returnReceived` says the SMS
went, like the cancel's toast.

```diff
@@ -6165,6 +6210,12 @@ export const en = {
       recordPayment: 'Record payment',
       // Step 27d (decision 6): a delivered order paid online. The invoice took its receipt
       deliveredPaid: 'The invoice is paid: it took the online payment’s money receipt.',
+      // Step 28b (decision 4): what came in at the door. They replace next.delivered. receipt =
+      // the COD receipt's number, courier = the account's name
+      nextDeliveredCod:
+        'The rider’s cash came in on money receipt {{receipt}}, into {{courier}}’s COD account. Its payout to your bank is recorded later.',
+      nextDeliveredNothing:
+        'The rider collected nothing, so no money receipt was made. Record the money when it comes.',
       // Step 27d (decision 7): money the shop has to give back. Each notice ends with "Record
       // refund", a new refund for the order's customer. amount = one payment try's amount
       paidCancelled:
@@ -6175,6 +6226,10 @@ export const en = {
       // A cash on delivery order with a paid try: the shopper paid, then chose to pay on delivery
       paidOnCod:
         'The shopper paid {{amount}} online too, then chose cash on delivery. Tell the rider to take no cash. If the rider took it as well, pay one back.',
+      // Step 28b: a partly delivered order paid online. Its invoice took only what the shopper
+      // kept, so the rest of the payment is left over, to pay back
+      paidPartly:
+        'The shopper paid {{amount}} online, and part of the parcel came back. The invoice took only what they kept. Pay the rest back from your SSLCommerz panel, then record the refund.',
       recordRefund: 'Record refund',
       // Step 28a: the next step's line once the order has a parcel (decision 5). courier = the
       // account's name. They replace next.packed and next.shipped
@@ -6186,6 +6241,12 @@ export const en = {
         'The order moves to Delivered by itself when {{courier}} delivers it. That posts the invoice.',
       // A parcel booked by hand: the staff move the order, as before
       nextManual: 'Mark it shipped when {{courier}} picks the parcel up.',
+      // Step 28b (decisions 6 and 7): a shipped order whose parcel did not all reach the
+      // shopper (the newest parcel's status). They replace nextShipped
+      nextPartly:
+        '{{courier}} delivered part of the parcel. Once the goods that came back are on the shelf, record what came back. That posts a sales return of them and the invoice of the rest.',
+      nextReturning:
+        '{{courier}} is bringing the parcel back. Once it is on the shelf, receive the return. That brings the goods back into stock and texts the shopper.',
       // The crit notice of a booking that failed (decision 4). reason = the error's own words
       parcelFailed: '{{courier}} did not book the parcel. {{reason}}',
       bookAgain: 'Book again',
```

The notice under the header:

- **`nextDeliveredCod`** replaces `next.delivered` once the COD receipt is made. The old line said "Record the cash
  when the rider brings it back", which is now wrong: the cash is in the books already, and the payout (28c) moves
  it to the bank. `nextDeliveredNothing` is the ৳0 case (mine 15).
- **`paidPartly`** is the refund notice of a partly delivered order paid online. Its invoice took only what the
  shopper kept, so part of the online payment is left over as an advance. The order's answer has no invoice total,
  so the line names what was paid and says the rest goes back; the refund form shows the exact amount left.
- **`nextPartly` and `nextReturning`** replace `nextShipped` when the newest parcel is partly delivered or coming
  back. Each says to wait for the goods on the shelf (decisions 6 and 7) and what the button then posts.

```diff
@@ -6283,6 +6344,18 @@ export const en = {
       deliverTitle: 'Mark {{number}} delivered?',
       deliverBody:
         'This posts an invoice for {{total}}, dated today. It stays unpaid until you record the money.',
+      // Step 28b (decisions 4 and 5): the parcel's courier account has a COD account. courier =
+      // the account's name
+      deliverBodyCod:
+        'This posts an invoice for {{total}}, dated today, and a money receipt into {{courier}}’s COD account for what the rider collected.',
+      // An order paid online: the invoice takes that payment's receipt (27d), so it is not unpaid
+      deliverBodyPaid:
+        'This posts an invoice for {{total}}, dated today. It takes the online payment’s money receipt, so it is paid.',
+      // The amount box: only with a COD account and something to collect. amount = the
+      // parcel's codAmount, what the courier was told to collect
+      collected: 'What the rider collected',
+      collectedHint:
+        'The rider was to collect {{amount}}. Type less if the shopper paid less: the rest stays owed on the invoice. With nothing collected, no receipt is made.',
       // Step 28a: one card per parcel, newest first (storefrontShipmentSchema)
       parcels: {
         title: 'Parcel',
```

Mark delivered's dialog (mine 41) and its amount box (decision 5). The box shows only when the parcel's account has
a COD account and the rider has something to collect, so a paid online order and a shop with no COD account see the
dialog as before. The hint names the amount the courier was told to collect, says that less is fine (the rest stays
owed on the invoice: decision 6), and that nothing collected makes no receipt (mine 15).

```diff
@@ -6313,6 +6386,14 @@ export const en = {
         bookedAt: 'Booked',
         lastSynced: 'Last news',
         neverSynced: 'None yet',
+        // Step 28b (decision 5): from the courier's notice, or what the member typed
+        collected: 'Rider collected',
+        charge: 'Courier’s charge',
+        receipt: 'Money receipt',
+        // Mine 14: the COD receipt's error sits on its parcel. reason = the error's own words
+        receiptError: 'The COD receipt could not be made. {{reason}}',
+        makeReceipt: 'Make the receipt',
+        receiptMade: 'Money receipt {{receipt}} made',
         // While booking. count = the calls made so far (attempts)
         bookingNow: 'Booking with {{courier}}…',
         bookingRetry_one: 'Tried {{formatted}} time. Omnivo tries again by itself.',
```

The parcel card's money facts (decision 5, mine 14). "Rider collected" sits next to 28a's "Rider collects", so the
two amounts read as a pair: what was asked and what came in. `receiptError` and `makeReceipt` follow the Payments
card (27d): the error's own words after one sentence of ours, and a button that tries again.

```diff
@@ -6389,6 +6470,46 @@ export const en = {
         submit: 'Mark packed',
         loadFailed: "Couldn't load what to pack. Close this and try again.",
       },
+      // Step 28b (decision 6, mine 16): the "Record what came back" dialog (partlyDeliverOrder).
+      // Its rows are the challan's lines (getReturnPlan), in the challan's order
+      cameBack: {
+        title: 'Record what came back of {{number}}',
+        description:
+          'Tick the goods that came back. A sales return brings them back into {{warehouse}}, and the invoice bills only what the shopper kept.',
+        // The line's checkbox. name = the product's name
+        take: 'Came back: {{name}}',
+        // quantity = what the challan line took, with its unit ("3 pcs")
+        sent: '{{quantity}} sent',
+        batch: 'Batch {{lot}}',
+        batchExpires: 'Batch {{lot}} · expires {{date}}',
+        quantity: 'How many came back',
+        // A serial product: one tick per serial number that left on the line
+        serials: 'Serial numbers that came back',
+        collected: 'What the rider collected',
+        // amount = the parcel's codAmount, for the whole parcel
+        collectedHint:
+          'For what the shopper kept. The rider was to collect {{amount}} for the whole parcel. With nothing collected, no receipt is made.',
+        // The courier's notice named it (collectedAmount), and the box starts with it
+        collectedFromCourier: '{{courier}} says the rider collected {{amount}}.',
+        reason: 'Why it came back',
+        reasonPlaceholder: 'The shopper did not want the second face wash',
+        reasonHint: 'Only your team sees this. It goes on the sales return.',
+        submit: 'Record what came back',
+        loadFailed: "Couldn't load what the parcel took. Close this and try again.",
+      },
+      // Step 28b (decision 7): the "Receive the return" dialog (returnOrder). delivery = the
+      // challan's number
+      receiving: {
+        title: 'Receive {{number}} back?',
+        body: 'A sales return brings everything on challan {{delivery}} back into stock, and the sales order is cancelled. The order moves to Returned, and the shopper gets an SMS.',
+        // Decision 7: stock comes back only once the parcel is here
+        check: 'Do this once the parcel is on your shelf, not on the courier’s word alone.',
+        reason: 'Why it came back',
+        reasonPlaceholder: 'The shopper did not answer the phone',
+        reasonHint: 'Only your team sees this. It goes on the sales return.',
+        keep: 'Not yet',
+        submit: 'Receive the return',
+      },
       // The Cancel dialog (decisions 8 and 19)
       cancelling: {
         title: 'Cancel {{number}}?',
```

The two dialogs:

- **`cameBack`** (decision 6, mine 16). Each line is a checkbox named by its product ("Came back: Neem face wash"),
  so a screen reader says what is ticked. `sent` is what the challan line took, so the member knows the most that
  can come back; a serial product shows one tick per serial number that left (the return plan lists them), so no
  number is typed by hand. The amount box has its own hint: for a partial delivery the courier's `codAmount` is for
  the whole parcel, so it is a limit, not a guess (`storefront_order_collected_required`). When the courier's
  notice named the amount, `collectedFromCourier` says where the box's first value came from. The reason is the
  sales return's note, and the hint says only the team sees it.
- **`receiving`** (decision 7, mine 42). The body names the challan, because that is what the sales return brings
  back whole, and says what else happens (the sales order is cancelled, the order is Returned, the SMS). "Not yet"
  is the cancel button: the member is waiting for the parcel, not refusing it.

```diff
@@ -7811,6 +7932,10 @@ export const en = {
       webhookToken: 'Webhook token',
       defaultCourier: 'Books first',
       trackingCode: 'Tracking code',
+      // Step 28b: a courier account's two accounts (by code), and what came back
+      codAccount: 'COD account',
+      chargeAccount: 'Courier charges account',
+      cameBack: 'Lines that came back',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

The audit log's names for what 28b.3 writes into `changes`: a courier account's two accounts (by their codes) and
the number of lines that came back. `reason` and `order` already had words.

### `locales/bn.ts`

```diff
@@ -5108,6 +5108,8 @@ export const bn: Messages = {
         account: 'অ্যাকাউন্ট',
         news: 'কুরিয়ারের খবর',
         test: 'শেষ পরীক্ষা',
+        // Step 28b
+        holds: 'কাছে আছে',
         status: 'অবস্থা',
         actions: 'কাজ',
       },
@@ -5120,6 +5122,11 @@ export const bn: Messages = {
       testWorked: 'key মেনেছে {{date}}',
       testRejected: 'key মানেনি {{date}}',
       testUnreachable: 'উত্তর আসেনি {{date}}',
+      // Step 28b
+      holds_one: '{{amount}} · {{formatted}}টা পার্সেল',
+      holds_other: '{{amount}} · {{formatted}}টা পার্সেল',
+      holdsNothing: 'এখনো কিছু না',
+      holdsNoAccount: 'COD অ্যাকাউন্ট নেই',
       actionsFor: '{{name}}-এর কাজ',
       edit: 'বদলান',
       test: 'কানেকশন পরীক্ষা করুন',
@@ -5175,6 +5182,22 @@ export const bn: Messages = {
         courier: 'কুরিয়ার',
         courierPlaceholder: 'একটা কুরিয়ার বাছুন',
         courierHint: 'যার ওয়েবসাইট বা অ্যাপে বুক করেন। ট্র্যাকিং পেজে এর নাম দেখায়।',
+        // Step 28b
+        codAccount: 'COD অ্যাকাউন্ট',
+        codAccountNone: 'কোনোটা না: রাইডারের টাকা হাতে লিখুন',
+        codAccountHint:
+          'টাকা রাখা হয় এমন একটা অ্যাকাউন্ট, যেমন “Steadfast-এর কাছে নগদ”। পার্সেল পৌঁছালে রাইডার যা নিয়েছেন তার একটা মানি রিসিট এতে জমা হয়। এর ব্যালান্সই কুরিয়ারের কাছে আপনার পাওনা।',
+        codAccountSavedHint:
+          'বদলালে শুধু পরের রিসিটগুলো বদলায়। আগে বানানো রিসিট যে অ্যাকাউন্টে গেছে, সেখানেই থাকে।',
+        chargeAccount: 'কুরিয়ার চার্জের অ্যাকাউন্ট',
+        chargeAccountNone: 'এখনো কোনোটা না',
+        chargeAccountHint:
+          'একটা খরচের অ্যাকাউন্ট, যেমন “কুরিয়ার চার্জ”। কুরিয়ারের পেআউট লেখার সময় তার ডেলিভারি আর ফেরতের চার্জ এখানে যায়।',
+        accountOption: '{{code}} · {{name}}',
+        noCodAccounts:
+          'টাকা রাখা হয় এমন কোনো চালু অ্যাকাউন্ট এখনো নেই। চার্ট অব অ্যাকাউন্টসে নগদ অ্যাকাউন্টের নিচে একটা যোগ করুন, যেমন “Steadfast-এর কাছে নগদ”।',
+        noChargeAccounts:
+          'কোনো চালু খরচের অ্যাকাউন্ট এখনো নেই। চার্ট অব অ্যাকাউন্টসে একটা যোগ করুন।',
         create: 'অ্যাকাউন্ট যোগ করুন',
         save: 'বদল সেভ করুন',
         created: 'কুরিয়ার অ্যাকাউন্ট {{name}} যোগ হয়েছে',
@@ -5608,6 +5631,7 @@ export const bn: Messages = {
         shipped: 'পাঠানো হয়েছে',
         delivered: 'পৌঁছেছে',
         cancelled: 'বাতিল',
+        returned: 'ফেরত এসেছে',
         all: 'সব',
       },
       statuses: {
@@ -5619,6 +5643,8 @@ export const bn: Messages = {
         returned: 'ফেরত এসেছে',
       },
       needsAttention: 'নজর দিন',
+      // Step 28b
+      parcelPills: { partly_delivered: 'আংশিক পৌঁছেছে', returning: 'ফেরত আসছে' },
       columns: {
         order: 'অর্ডার',
         confirmed: 'কনফার্ম হয়েছে',
@@ -5641,6 +5667,7 @@ export const bn: Messages = {
         shipped: 'পথে কোনো অর্ডার নেই।',
         delivered: 'এখনো কোনো অর্ডার পৌঁছায়নি।',
         cancelled: 'কোনো অর্ডার বাতিল হয়নি।',
+        returned: 'কোনো অর্ডার ফেরত আসেনি।',
       },
       noMatchTitle: 'কোনো অর্ডার মেলেনি',
       noMatchBody: 'নম্বর বা ফোন মিলিয়ে দেখুন। খোঁজা হয় শুধু এই ট্যাবে।',
@@ -5671,6 +5698,9 @@ export const bn: Messages = {
       cancel: 'অর্ডার বাতিল করুন',
       // Step 28a
       book: 'কুরিয়ারে বুক করুন',
+      // Step 28b
+      recordCameBack: 'যা ফেরত এসেছে তা লিখুন',
+      receiveReturn: 'ফেরত মাল বুঝে নিন',
       salesOrderMade: '{{number}}-এর সেলস অর্ডার {{salesOrder}} বানানো হয়েছে',
       packed: '{{number}} প্যাক হয়েছে। চালান {{delivery}} পোস্ট হয়েছে।',
       shipped: '{{number}} পাঠানো হয়েছে',
@@ -5682,6 +5712,15 @@ export const bn: Messages = {
       bookingStarted: '{{number}}-এর পার্সেল {{courier}}-এ বুক হচ্ছে',
       booked: '{{number}} {{courier}}-এ বুক হয়েছে, কোড {{code}}',
       bookingAgain: '{{number}}-এর পার্সেল আবার বুক হচ্ছে',
+      // Step 28b
+      deliveredWithReceipt:
+        '{{number}} পৌঁছেছে। ইনভয়েস {{invoice}} আর মানি রিসিট {{receipt}} পোস্ট হয়েছে।',
+      partlyDelivered:
+        '{{number}} আংশিক পৌঁছেছে। সেলস রিটার্ন {{salesReturn}} আর ইনভয়েস {{invoice}} পোস্ট হয়েছে।',
+      partlyDeliveredWithReceipt:
+        '{{number}} আংশিক পৌঁছেছে। সেলস রিটার্ন {{salesReturn}}, ইনভয়েস {{invoice}} আর মানি রিসিট {{receipt}} পোস্ট হয়েছে।',
+      returnReceived:
+        '{{number}} ফেরত এসেছে। সেলস রিটার্ন {{salesReturn}} পোস্ট হয়েছে। ক্রেতা একটা SMS পাবেন।',
       next: {
         confirmed:
           'মাল প্যাক করে প্যাক হয়েছে বলে চিহ্ন দিন। তাতে চালান পোস্ট হয়, স্টক বের হয়, আর আটকে রাখা স্টক ছাড়া পায়।',
@@ -5691,12 +5730,20 @@ export const bn: Messages = {
       },
       recordPayment: 'টাকা জমা লিখুন',
       deliveredPaid: 'ইনভয়েসের টাকা শোধ হয়েছে: অনলাইন পেমেন্টের মানি রিসিট এতে ধরা হয়েছে।',
+      // Step 28b
+      nextDeliveredCod:
+        'রাইডারের টাকা মানি রিসিট {{receipt}}-এ {{courier}}-এর COD অ্যাকাউন্টে জমা হয়েছে। আপনার ব্যাংকে এর পেআউট পরে লেখা হয়।',
+      nextDeliveredNothing:
+        'রাইডার কিছু নেননি, তাই কোনো মানি রিসিট বানানো হয়নি। টাকা এলে সেটা লিখে রাখুন।',
       paidCancelled:
         'ক্রেতা এই অর্ডারের জন্য অনলাইনে {{amount}} দিয়েছেন। আপনার SSLCommerz প্যানেল থেকে টাকাটা ফেরত দিন, তারপর রিফান্ড লিখুন।',
       paidTwice:
         'ক্রেতা অনলাইনে দুবার টাকা দিয়েছেন, প্রতিবার {{amount}}। আপনার SSLCommerz প্যানেল থেকে একটা ফেরত দিন, তারপর রিফান্ড লিখুন।',
       paidOnCod:
         'ক্রেতা অনলাইনেও {{amount}} দিয়েছেন, তারপর ক্যাশ অন ডেলিভারি বেছেছেন। রাইডারকে নগদ না নিতে বলুন। রাইডার নগদও নিয়ে থাকলে একটা ফেরত দিন।',
+      // Step 28b
+      paidPartly:
+        'ক্রেতা অনলাইনে {{amount}} দিয়েছেন, আর পার্সেলের একটা অংশ ফেরত এসেছে। ইনভয়েসে ধরা হয়েছে শুধু যা তিনি রেখেছেন। বাকি টাকা আপনার SSLCommerz প্যানেল থেকে ফেরত দিন, তারপর রিফান্ড লিখুন।',
       recordRefund: 'রিফান্ড লিখুন',
       // Step 28a
       nextNoParcel:
@@ -5707,6 +5754,11 @@ export const bn: Messages = {
       nextShipped:
         '{{courier}} পৌঁছে দিলে অর্ডার নিজে থেকেই পৌঁছেছে-তে যাবে। তাতে ইনভয়েস পোস্ট হয়।',
       nextManual: '{{courier}} পার্সেল নিয়ে গেলে পাঠানো হয়েছে বলে চিহ্ন দিন।',
+      // Step 28b
+      nextPartly:
+        '{{courier}} পার্সেলের একটা অংশ পৌঁছে দিয়েছে। ফেরত আসা মাল দোকানের তাকে উঠলে যা ফেরত এসেছে তা লিখুন। তাতে সেগুলোর সেলস রিটার্ন আর বাকিটার ইনভয়েস পোস্ট হয়।',
+      nextReturning:
+        '{{courier}} পার্সেলটা ফেরত আনছে। দোকানের তাকে উঠলে ফেরত মাল বুঝে নিন। তাতে মাল স্টকে ফেরে আর ক্রেতা একটা SMS পান।',
       parcelFailed: '{{courier}} পার্সেলটা বুক করেনি। {{reason}}',
       bookAgain: 'আবার বুক করুন',
       documentError: 'সেলস অর্ডার বানানো যায়নি। {{reason}}',
@@ -5781,6 +5833,14 @@ export const bn: Messages = {
       deliverTitle: '{{number}} পৌঁছেছে বলে চিহ্ন দেবেন?',
       deliverBody:
         'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে। টাকা জমা না লেখা পর্যন্ত এটা বাকি থাকে।',
+      // Step 28b
+      deliverBodyCod:
+        'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে, আর রাইডার যা নিয়েছেন তার একটা মানি রিসিট {{courier}}-এর COD অ্যাকাউন্টে জমা হবে।',
+      deliverBodyPaid:
+        'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে। অনলাইন পেমেন্টের মানি রিসিট এতে ধরা হবে, তাই এটা শোধ থাকবে।',
+      collected: 'রাইডার যা নিয়েছেন',
+      collectedHint:
+        'রাইডারের নেওয়ার কথা ছিল {{amount}}। ক্রেতা কম দিলে কম লিখুন: বাকিটা ইনভয়েসে পাওনা থাকে। কিছু না নিলে কোনো রিসিট বানানো হয় না।',
       // Step 28a
       parcels: {
         title: 'পার্সেল',
@@ -5808,6 +5868,13 @@ export const bn: Messages = {
         bookedAt: 'বুক হয়েছে',
         lastSynced: 'শেষ খবর',
         neverSynced: 'এখনো আসেনি',
+        // Step 28b
+        collected: 'রাইডার নিয়েছেন',
+        charge: 'কুরিয়ারের চার্জ',
+        receipt: 'মানি রিসিট',
+        receiptError: 'COD রিসিট বানানো যায়নি। {{reason}}',
+        makeReceipt: 'রিসিট বানান',
+        receiptMade: 'মানি রিসিট {{receipt}} বানানো হয়েছে',
         bookingNow: '{{courier}}-এ বুক হচ্ছে…',
         bookingRetry_one: '{{formatted}} বার চেষ্টা হয়েছে। Omnivo নিজে থেকেই আবার চেষ্টা করবে।',
         bookingRetry_other: '{{formatted}} বার চেষ্টা হয়েছে। Omnivo নিজে থেকেই আবার চেষ্টা করবে।',
@@ -5870,6 +5937,37 @@ export const bn: Messages = {
         submit: 'প্যাক হয়েছে বলে চিহ্ন দিন',
         loadFailed: 'কী প্যাক করতে হবে তা আনা যায়নি। এটা বন্ধ করে আবার চেষ্টা করুন।',
       },
+      // Step 28b
+      cameBack: {
+        title: '{{number}}-এর যা ফেরত এসেছে তা লিখুন',
+        description:
+          'যে মাল ফেরত এসেছে তাতে টিক দিন। একটা সেলস রিটার্ন সেগুলো {{warehouse}}-এ ফেরত আনবে, আর ইনভয়েসে ধরা হবে শুধু যা ক্রেতা রেখেছেন।',
+        take: 'ফেরত এসেছে: {{name}}',
+        sent: '{{quantity}} পাঠানো হয়েছিল',
+        batch: 'ব্যাচ {{lot}}',
+        batchExpires: 'ব্যাচ {{lot}} · মেয়াদ {{date}}',
+        quantity: 'কতগুলো ফেরত এসেছে',
+        serials: 'যে সিরিয়াল নম্বরগুলো ফেরত এসেছে',
+        collected: 'রাইডার যা নিয়েছেন',
+        collectedHint:
+          'ক্রেতা যা রেখেছেন তার জন্য। পুরো পার্সেলের জন্য রাইডারের নেওয়ার কথা ছিল {{amount}}। কিছু না নিলে কোনো রিসিট বানানো হয় না।',
+        collectedFromCourier: '{{courier}} বলছে রাইডার {{amount}} নিয়েছেন।',
+        reason: 'কেন ফেরত এসেছে',
+        reasonPlaceholder: 'ক্রেতা দ্বিতীয় ফেস ওয়াশটা চাননি',
+        reasonHint: 'শুধু আপনার টিম এটা দেখে। এটা সেলস রিটার্নে লেখা থাকে।',
+        submit: 'যা ফেরত এসেছে তা লিখুন',
+        loadFailed: 'পার্সেলে কী গিয়েছিল তা আনা যায়নি। এটা বন্ধ করে আবার চেষ্টা করুন।',
+      },
+      receiving: {
+        title: '{{number}} ফেরত বুঝে নেবেন?',
+        body: 'একটা সেলস রিটার্ন চালান {{delivery}}-এর সব মাল স্টকে ফেরত আনবে, আর সেলস অর্ডার বাতিল হবে। অর্ডারটা ফেরত এসেছে-তে যাবে, আর ক্রেতা একটা SMS পাবেন।',
+        check: 'পার্সেল দোকানের তাকে উঠলে তবেই এটা করুন, শুধু কুরিয়ারের কথায় নয়।',
+        reason: 'কেন ফেরত এসেছে',
+        reasonPlaceholder: 'ক্রেতা ফোন ধরেননি',
+        reasonHint: 'শুধু আপনার টিম এটা দেখে। এটা সেলস রিটার্নে লেখা থাকে।',
+        keep: 'এখন না',
+        submit: 'ফেরত মাল বুঝে নিন',
+      },
       cancelling: {
         title: '{{number}} বাতিল করবেন?',
         bodyConfirmed:
@@ -6950,7 +7048,7 @@ export const bn: Messages = {
         // Step 28b
         partly_delivered: 'শপের আংশিক পৌঁছানো অর্ডারের ফেরত আসা মাল লিখেছেন',
         returned: 'শপের ফেরত আসা অর্ডার বুঝে নিয়েছেন',
-        cod_receipt_made: 'শপের পৌঁছানো অর্ডারের COD রসিদ আবার বানিয়েছেন',
+        cod_receipt_made: 'শপের পৌঁছানো অর্ডারের COD রিসিট আবার বানিয়েছেন',
       },
       // Step 27c
       storefront_coupon: {
@@ -7222,6 +7320,10 @@ export const bn: Messages = {
       webhookToken: 'Webhook token',
       defaultCourier: 'প্রথমে যেটায় বুক হয়',
       trackingCode: 'ট্র্যাকিং কোড',
+      // Step 28b
+      codAccount: 'COD অ্যাকাউন্ট',
+      chargeAccount: 'কুরিয়ার চার্জের অ্যাকাউন্ট',
+      cameBack: 'যে লাইনগুলো ফেরত এসেছে',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
@@ -7329,7 +7431,7 @@ export const bn: Messages = {
           '{{courier}} {{number}}-এর পার্সেল বুক করেনি। আবার বুক করতে অর্ডারটা খুলুন।',
         // Step 28b
         cod_receipt_failed:
-          '{{courier}} {{number}} পৌঁছে দিয়েছে, কিন্তু COD রসিদ বানানো যায়নি। বানাতে অর্ডারটা খুলুন।',
+          '{{courier}} {{number}} পৌঁছে দিয়েছে, কিন্তু এর COD রিসিট বানানো যায়নি। বানাতে অর্ডারটা খুলুন।',
       },
     },
   },
@@ -8170,17 +8272,17 @@ export const bn: Messages = {
       'এই webhook token ঠিক না। শপের কুরিয়ার পেজ থেকে token পেস্ট করুন।',
     // Step 28b
     courier_cod_account_invalid:
-      'টাকা রাখে এমন একটা সক্রিয় অ্যাকাউন্ট বাছুন, যেমন Cash with Steadfast, বা কোনোটাই না।',
+      'টাকা রাখা হয় এমন একটা চালু অ্যাকাউন্ট বাছুন, যেমন “Steadfast-এর কাছে নগদ”, অথবা কোনোটাই না।',
     courier_charge_account_invalid:
-      'একটা সক্রিয় খরচের অ্যাকাউন্ট বাছুন, যেমন Courier charges, বা কোনোটাই না।',
+      'একটা চালু খরচের অ্যাকাউন্ট বাছুন, যেমন “কুরিয়ার চার্জ”, অথবা কোনোটাই না।',
     storefront_order_collected_over:
-      'এই পার্সেলে রাইডার সর্বোচ্চ {{amount}} তোলে। কুরিয়ার যত তুলেছে বলেছে, তত লিখুন।',
-    storefront_order_collected_required: 'রাইডার কত তুলেছে লিখুন। কুরিয়ার এখনো বলেনি।',
+      'এই পার্সেলে রাইডার সর্বোচ্চ {{amount}} নিতে পারেন। কুরিয়ার যত নিয়েছে বলছে, তত লিখুন।',
+    storefront_order_collected_required: 'রাইডার কত নিয়েছেন লিখুন। কুরিয়ার এখনো বলেনি।',
     storefront_order_return_nothing:
-      'কী ফেরত এসেছে টিক দিন। ক্রেতা সব রেখে দিলে Mark delivered চাপুন।',
-    storefront_order_return_everything: 'সবই ফেরত এসেছে। এর বদলে Receive the return চাপুন।',
+      'কী ফেরত এসেছে টিক দিন। ক্রেতা সব রেখে দিলে "পৌঁছেছে বলে চিহ্ন দিন" চাপুন।',
+    storefront_order_return_everything: 'সবই ফেরত এসেছে। এর বদলে "ফেরত মাল বুঝে নিন" চাপুন।',
     storefront_cod_receipt_not_failed:
-      'এই পার্সেলের COD রসিদ ব্যর্থ হয়নি। অর্ডারটা আবার লোড করুন।',
+      'এই পার্সেলের COD রিসিট ব্যর্থ হয়নি। অর্ডারটা আবার লোড করুন।',
   },
   ui: {
     dataTable: {
```

The same keys in Bangla; the type check fails if one is missing. The end of the diff rewrites 28b.1's Bangla error,
audit and bell words to the app's terms (mine 39). COD stays in English, like 27d's SSLCommerz words: it is the word
shops use. "কাছে আছে" is the Holds column, and "ফেরত মাল বুঝে নিন" is Receive the return, the same name the error
`storefront_order_return_everything` now gives it.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/app typecheck
```

The i18n checks and the shop type check pass. The app type check still fails, and only with the errors 28b.1
expected (the bell's link map, the mocks without the new fields, the router's tabs, and Delivered's address in the
old route group), which 28b.6 and 28b.7 fix. No screen uses the words yet: 28b.6 uses them, and 28b.8 looks for
words no screen uses and takes them out.

Broken on purpose, to see that the checks notice:

- `returning` taken out of the Bangla `parcelPills`: the i18n type check fails (`Property 'returning' is missing`).
- `{{receipt}}` taken out of the Bangla `deliveredWithReceipt`: the placeholder test fails
  (`storefront.order.deliveredWithReceipt: en [invoice, number, receipt] / bn [invoice, number]`).

## 28b.6 — The ERP screens

This part puts the COD money on the screens: the courier account's two accounts, what each courier holds, the orders
list's Returned tab and its new pill, and the order page at the shopper's door: Mark delivered with what the rider
collected, Record what came back, Receive the return, the parcel's money and a COD receipt that failed. The shop
does not change.

The screens follow a mockup the user approved before any code was written (local HTML and PNG files, all seven
proposals "as drawn"). Every word comes from 28b.5, except one added here (mine 49).

Decisions made while building the screens (mine):

44. **The primary button stays last.** The mockup drew the shipped order's primary button where the move sits in the
    row (Record what came back first). Every page header in the app puts its primary action last, after the
    secondary ones, and the phone layout (two secondary buttons on the first row, the primary on the second) needs
    that order anyway. So the two secondary moves come first, in their fixed order, and the primary is last.
45. **"Record what came back" starts its amount box empty** unless the courier named the amount. The parcel's
    `codAmount` is for the whole parcel, so it would be wrong for the part the shopper kept. Empty makes the API
    ask for it (`storefront_order_collected_required`), which is the right question.
46. **Mark delivered is its own small form now,** not 27b's confirm dialog (`CancelDraftDialog`). The amount box
    needs a form, field errors and the contract's schema. The page keeps one shape for every dialog: a `Dialog`
    whose content is mounted only while it is open, so each opening starts fresh.
47. **A COD receipt that failed comes before "the invoice took the online payment".** It is the one thing a member
    must act on, so it takes the step line's place, like a failed booking in 28a.
48. **The Holds column is a card's detail on a phone,** under the account's name, before the courier's news. The
    status pill keeps the subtitle.
49. **A ticked serial line with no serial number ticked has its own words:** "Tick the serial numbers that came
    back." Its count would be 0, which the contract refuses as a quantity ("Enter a number above zero"), and those
    words make no sense under a list of ticks. It is one new word in en and bn (`cameBack.serialsNone`).

### The Shop couriers page

```diff
@@ -447,6 +447,42 @@ export function StorefrontCouriersPage() {
           );
         },
       }),
+      // Step 28b (decision 12, approved with the mockup): what the courier holds of the shop's
+      // money, right after the account, because it is what a person comes here to check. Whole
+      // taka, as a list shows money. Posted COD receipts only (the API's holdsOf): a voided one
+      // drops out. Without a COD account the rider's cash is typed by hand, so there is nothing
+      // to count
+      column.accessor('holds', {
+        header: t('storefront.couriers.columns.holds'),
+        enableSorting: false,
+        meta: { card: 'detail' },
+        cell: ({ row }) => {
+          const account = row.original;
+          if (account.codAccountId === null) {
+            return (
+              <span className="text-body-sm text-ink-3">
+                {t('storefront.couriers.holdsNoAccount')}
+              </span>
+            );
+          }
+          if (account.holds.parcels === 0) {
+            return (
+              <span className="text-body-sm text-ink-3">
+                {t('storefront.couriers.holdsNothing')}
+              </span>
+            );
+          }
+          return (
+            <span className="text-body-sm whitespace-nowrap text-ink tabular-nums">
+              {t('storefront.couriers.holds', {
+                amount: format.money(account.holds.amount, { decimals: 0 }),
+                count: account.holds.parcels,
+                formatted: format.number(account.holds.parcels),
+              })}
+            </span>
+          );
+        },
+      }),
       column.accessor('lastWebhookAt', {
         header: t('storefront.couriers.columns.news'),
         enableSorting: false,
@@ -707,6 +743,10 @@ export function StorefrontCouriersPage() {
         <Suspense fallback={null}>
           <AccountDialog
             account={acting.kind === 'new' ? null : acting.account}
+            // Step 28b: what the two account selects offer (the page's own read; a member with
+            // storefront.manage may not read the chart of accounts)
+            codAccounts={setup?.codAccounts ?? []}
+            chargeAccounts={setup?.chargeAccounts ?? []}
             onClose={close}
             onSaved={async (saved) => {
               await refresh();
```

The Holds column sits right after the account (approved with the mockup), because what a courier holds is what a
person opens this page to check. The amount is whole taka, as every list shows money; the API sends it with paisa
and `format.money(…, { decimals: 0 })` rounds it for the screen. The count goes through `count` and `formatted`,
so the plural follows the number and the digits follow the language. There are three cases, and each says what it
means:

- **No COD account** (`codAccountId === null`): the rider's cash is typed by hand, so there is nothing to count.
  "No COD account" says why the cell is empty, where a ৳0 would read as "this courier owes nothing".
- **A COD account, no parcel yet** (`holds.parcels === 0`): "Nothing yet".
- **Something held:** "৳45,200 · 18 parcels".

The second hunk passes the page's own read of the account choices into the dialog. The dialog cannot ask for them
itself: a member with `storefront.manage` may not read the chart of accounts, which is why 28b.1 put
`codAccounts` and `chargeAccounts` into the page's setup answer.

### The courier account dialog

```diff
@@ -1,10 +1,12 @@
 import {
+  Coins01Icon,
   Edit02Icon,
   Key01Icon,
   LockKeyholeIcon,
   Plug01Icon,
   ShippingTruck01Icon,
   Tag01Icon,
+  Wallet01Icon,
 } from '@hugeicons/core-free-icons';
 import {
   contractErrorMap,
@@ -14,6 +16,7 @@ import {
   createCourierAccountInputSchema,
   routes,
   SHOP_COURIERS,
+  type StorefrontAccountChoice,
   updateCourierAccountInputSchema,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
@@ -28,6 +31,7 @@ import {
   TextField,
   toast,
 } from '@omnivo/ui';
+import { useEffect } from 'react';
 import { type Resolver, useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
@@ -46,26 +50,47 @@ interface AccountForm {
   secretKey: string;
   // '' = "Pick a courier" (courier_pick_one)
   courier: string;
+  // Step 28b (decisions 2 and 3): '' = none, a real choice whose option says what it means
+  codAccountId: string;
+  chargeAccountId: string;
   version: number;
 }
 
-const FIELDS = ['provider', 'name', 'apiKey', 'secretKey', 'courier'] as const;
+const FIELDS = [
+  'provider',
+  'name',
+  'apiKey',
+  'secretKey',
+  'courier',
+  'codAccountId',
+  'chargeAccountId',
+] as const;
 
 // The union's body for the provider picked. unknown: the schema below checks it (an empty courier
-// is its error, not a type error here)
+// is its error, not a type error here). Step 28b: the two accounts go with both providers, always
+// (mine 20: the schema has no default, so a body without them is refused instead of clearing them)
 function bodyOf(values: AccountForm, isNew: boolean): unknown {
   const version = isNew ? {} : { version: values.version };
+  const money = { codAccountId: values.codAccountId, chargeAccountId: values.chargeAccountId };
   return values.provider === 'manual'
-    ? { provider: 'manual', name: values.name, courier: values.courier, ...version }
+    ? { provider: 'manual', name: values.name, courier: values.courier, ...money, ...version }
     : {
         provider: values.provider,
         name: values.name,
         apiKey: values.apiKey,
         secretKey: values.secretKey,
+        ...money,
         ...version,
       };
 }
 
+// A saved account that is no longer offered (archived since, or no longer of its kind) starts
+// empty, and the form says so under its box at once (the payment gateway card's way): sending the
+// old id would only be refused
+function choiceOrEmpty(id: string | null, choices: readonly StorefrontAccountChoice[]): string {
+  return id !== null && choices.some((choice) => choice.id === id) ? id : '';
+}
+
 function schemaOf(isNew: boolean) {
   return isNew ? createCourierAccountInputSchema : updateCourierAccountInputSchema;
 }
@@ -85,10 +110,17 @@ function resolverOf(isNew: boolean): Resolver<AccountForm> {
   };
 }
 
+interface AccountChoices {
+  codAccounts: readonly StorefrontAccountChoice[];
+  chargeAccounts: readonly StorefrontAccountChoice[];
+}
+
 function AccountForm({
   account,
+  codAccounts,
+  chargeAccounts,
   onSaved,
-}: {
+}: AccountChoices & {
   account: CourierAccount | null;
   onSaved: (saved: CourierAccountSaved) => Promise<void>;
 }) {
@@ -111,11 +143,44 @@ function AccountForm({
       apiKey: '',
       secretKey: '',
       courier: account?.provider === 'manual' ? account.courier : '',
+      codAccountId: choiceOrEmpty(account?.codAccountId ?? null, codAccounts),
+      chargeAccountId: choiceOrEmpty(account?.chargeAccountId ?? null, chargeAccounts),
       version: account?.version ?? 0,
     },
   });
   const provider = useWatch({ control, name: 'provider' });
 
+  // The saved account that started empty above: its error under the box at once, in the words the
+  // API would answer on the save. Once, on open (the dialog is keyed by the account)
+  useEffect(() => {
+    if (account === null) return;
+    if (account.codAccountId !== null && choiceOrEmpty(account.codAccountId, codAccounts) === '') {
+      setError('codAccountId', { message: 'courier_cod_account_invalid' });
+    }
+    if (
+      account.chargeAccountId !== null &&
+      choiceOrEmpty(account.chargeAccountId, chargeAccounts) === ''
+    ) {
+      setError('chargeAccountId', { message: 'courier_charge_account_invalid' });
+    }
+  }, [account, codAccounts, chargeAccounts, setError]);
+
+  const accountOptions = (choices: readonly StorefrontAccountChoice[], none: string) => [
+    { value: '', label: none },
+    ...choices.map((choice) => ({
+      value: choice.id,
+      label: t('storefront.couriers.form.accountOption', { code: choice.code, name: choice.name }),
+    })),
+  ];
+  // The COD box's hint: where to add an account when there is none to pick; on an account that
+  // has one, that a change counts for the next receipts only (the receipts made stay put)
+  const codHint =
+    codAccounts.length === 0
+      ? t('storefront.couriers.form.noCodAccounts')
+      : account !== null && account.codAccountId !== null
+        ? t('storefront.couriers.form.codAccountSavedHint')
+        : t('storefront.couriers.form.codAccountHint');
+
   const onSubmit = handleSubmit(async (values) => {
     try {
       // The resolver checked it; parse again for the typed body
@@ -266,6 +331,28 @@ function AccountForm({
             />
           </>
         )}
+        {/* Step 28b (approved with the mockup): after the keys or the courier, for both
+            providers. Native selects: a short list of the workspace's accounts, "code · name" */}
+        <SelectField
+          label={t('storefront.couriers.form.codAccount')}
+          icon={Wallet01Icon}
+          options={accountOptions(codAccounts, t('storefront.couriers.form.codAccountNone'))}
+          hint={codHint}
+          {...register('codAccountId')}
+          error={errors.codAccountId?.message}
+        />
+        <SelectField
+          label={t('storefront.couriers.form.chargeAccount')}
+          icon={Coins01Icon}
+          options={accountOptions(chargeAccounts, t('storefront.couriers.form.chargeAccountNone'))}
+          hint={
+            chargeAccounts.length === 0
+              ? t('storefront.couriers.form.noChargeAccounts')
+              : t('storefront.couriers.form.chargeAccountHint')
+          }
+          {...register('chargeAccountId')}
+          error={errors.chargeAccountId?.message}
+        />
       </form>
     </DialogContent>
   );
@@ -273,9 +360,11 @@ function AccountForm({
 
 export function AccountDialog({
   account,
+  codAccounts,
+  chargeAccounts,
   onClose,
   onSaved,
-}: {
+}: AccountChoices & {
   account: CourierAccount | null;
   onClose: () => void;
   onSaved: (saved: CourierAccountSaved) => Promise<void>;
@@ -287,7 +376,13 @@ export function AccountDialog({
         if (!open) onClose();
       }}
     >
-      <AccountForm key={account?.id ?? 'new'} account={account} onSaved={onSaved} />
+      <AccountForm
+        key={account?.id ?? 'new'}
+        account={account}
+        codAccounts={codAccounts}
+        chargeAccounts={chargeAccounts}
+        onSaved={onSaved}
+      />
     </Dialog>
   );
 }
```

The two account fields join the form's flat shape and its `FIELDS` list, so an API error such as
`courier_cod_account_invalid` lands under its own select.

`bodyOf` sends both fields for both providers, always. Mine 20 gave them no default in the contract: a page from
before 28b that saved an account would otherwise clear its accounts without anyone seeing. So the form must send
them every time, even unchanged.

`choiceOrEmpty` and the `useEffect` after it follow the payment gateway card (27d). A saved account may have been
archived since, or may no longer be of its kind. Sending its old id would only be refused, so the select starts
empty, and the error the API would give shows under the box at once, before the member saves. The effect runs on
open only: the dialog is keyed by the account, so a different account is a new form.

The two selects are native, like the gateway's: a short list of the workspace's accounts, "code · name". Their first
option is the empty one, and its words say what empty means (mine 38). The COD hint changes with the case:

- no account to pick: where to add one;
- editing an account that has a COD account: a change counts for the next receipts only;
- otherwise: what the account is for.

`Wallet01` and `Coins01` are the gateway card's icons for the same two kinds of account.

### The bell, the router and the list

```diff
@@ -64,6 +64,9 @@ const TARGET = {
   // Step 28a: a parcel that failed to book five times. The order's page has Book again; an old
   // notification without the id opens the list
   'storefront.shipment_failed': '/storefront/orders',
+  // Step 28b: a delivered parcel whose COD receipt could not be made. The order's page has "Make
+  // the receipt"; the list for a notification without the id
+  'storefront.cod_receipt_failed': '/storefront/orders',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
@@ -135,12 +138,14 @@ function shiftOf(notification: Notification): string | null {
 }
 
 // Step 27b: the new-order bell opens its order. Its id is the order's (27a's handler sends it).
-// Step 28a: so does a failed booking's (28a.3's handler sends the order's id too)
+// Step 28a: so does a failed booking's (28a.3's handler sends the order's id too). Step 28b: and a
+// failed COD receipt's (cod-receipts.ts sends the order's id, one bell per parcel)
 function shopOrderOf(notification: Notification): string | null {
   const { id } = notification.params;
   const opensOrder =
     notification.type === 'storefront.order_confirmed' ||
-    notification.type === 'storefront.shipment_failed';
+    notification.type === 'storefront.shipment_failed' ||
+    notification.type === 'storefront.cod_receipt_failed';
   return opensOrder && typeof id === 'string' && id !== '' ? id : null;
 }
 
```

The new bell (mine 19) gets a fallback link, which the link map's `satisfies` demands. It also joins `shopOrderOf`,
because its `id` is the order's (`cod-receipts.ts` sends `{ id, number, courier }`), so the bell opens the order
that has "Make the receipt".

```diff
@@ -1039,6 +1039,8 @@ const ORDER_VIEWS: readonly StorefrontOrderView[] = Object.values({
   shipped: 'shipped',
   delivered: 'delivered',
   cancelled: 'cancelled',
+  // Step 28b (mine 18): the orders received back
+  returned: 'returned',
   all: 'all',
 } as const satisfies { [View in StorefrontOrderView]: View });
 
```

The route keeps its own list of the tabs it accepts in the address. The `satisfies` mapped type makes the type check
fail when a view is missing, which is how 28b.1's new `returned` view showed up here.

```diff
@@ -2,13 +2,15 @@ import {
   Alert02Icon,
   CancelCircleIcon,
   Clock01Icon,
+  DeliveryReturn01Icon,
   DeliveryTruck01Icon,
   PackageDeliveredIcon,
   PackageIcon,
   PackageReceiveIcon,
+  PackageRemoveIcon,
 } from '@hugeicons/core-free-icons';
 import type { IconSvgElement } from '@hugeicons/react';
-import type { StorefrontOrderStatus } from '@omnivo/contracts';
+import type { ShipmentStatus, StorefrontOrderStatus } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import { Pill } from '@omnivo/ui';
 
@@ -50,3 +52,29 @@ export function NeedsAttentionPill() {
     </Pill>
   );
 }
+
+// Step 28b (mine 40, approved with the mockup): a second, warn pill on a shipped order whose newest
+// parcel did not all reach the shopper. The staff act once the goods are back (Record what came
+// back, Receive the return), so warn. The parcel card's icons, so a step reads the same in both
+// places. Only these two: the courier's other steps are its own work
+const PARCEL_WAIT_PILLS = {
+  partly_delivered: PackageRemoveIcon,
+  returning: DeliveryReturn01Icon,
+} as const satisfies Partial<Record<ShipmentStatus, IconSvgElement>>;
+
+export function ParcelWaitPill({
+  status,
+  parcelStatus,
+}: {
+  status: StorefrontOrderStatus;
+  parcelStatus: ShipmentStatus | null;
+}) {
+  const { t } = useLocale();
+  if (status !== 'shipped') return null;
+  if (parcelStatus !== 'partly_delivered' && parcelStatus !== 'returning') return null;
+  return (
+    <Pill tone="warn" icon={PARCEL_WAIT_PILLS[parcelStatus]}>
+      {t(`storefront.orders.parcelPills.${parcelStatus}`)}
+    </Pill>
+  );
+}
```

```diff
@@ -24,7 +24,11 @@ import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
 import { useNavigate, useSearch } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
-import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
+import {
+  NeedsAttentionPill,
+  OrderStatusPill,
+  ParcelWaitPill,
+} from '../components/storefront-order-pills';
 import { StorefrontOffline, useShopMoney, ViewShopLink } from '../components/storefront-parts';
 import { ApiRequestError, call } from '../lib/api';
 import { useCan } from '../lib/permissions';
@@ -214,6 +218,12 @@ export function StorefrontOrdersPage() {
           cell: ({ row }) => (
             <span className="inline-flex flex-wrap justify-end gap-1.5 min-[860px]:justify-start">
               <OrderStatusPill status={row.original.status} />
+              {/* Step 28b: a shipped order that waits for the staff (partly delivered, coming
+                  back), so the Shipped tab says which ones need the order's page */}
+              <ParcelWaitPill
+                status={row.original.status}
+                parcelStatus={row.original.parcelStatus}
+              />
               {row.original.needsAttention && <NeedsAttentionPill />}
             </span>
           ),
```

The second pill (mine 40) appears only on a shipped order, and only for the two parcel steps that wait for the
staff. It is warn because someone must act once the goods are back. It uses the parcel card's icons
(`PackageRemove`, `DeliveryReturn01`), so a step looks the same on the list and on the order. The component returns
`null` for every other case, so the list's cell needs no condition of its own.

### The order's helpers

```diff
@@ -3,8 +3,10 @@ import {
   type CourierExportRow,
   isOpenShipment,
   isQuantity,
+  isZeroMoney,
   type PackStorefrontOrderFormValues,
   routes,
+  type ShipmentStatus,
   type StorefrontOrder,
   type StorefrontOrderSort,
   type StorefrontOrderView,
@@ -80,6 +82,18 @@ export function storefrontCourierChoicesQuery(tenantId: string) {
   });
 }
 
+// Step 28b: what the "Record what came back" dialog opens with, asked each time it opens like the
+// pack plan (the challan does not change, but an order moved in another tab would answer 409)
+export function storefrontReturnPlanQuery(tenantId: string, orderId: string) {
+  return queryOptions({
+    queryKey: ['storefront', tenantId, 'orders', 'return-plan', orderId],
+    queryFn: () =>
+      call(routes.storefrontOrderDeliveries.getReturnPlan, { params: { id: orderId } }),
+    staleTime: 0,
+    gcTime: 0,
+  });
+}
+
 // ---------------------------------------------------------------------------------------------
 // One order
 
```

The return plan is asked for each time the dialog opens, like the pack plan (`staleTime: 0`, `gcTime: 0`). Its key
sits under the order's prefix, so the page's refresh after a move would ask for it again. `useApplyMove` therefore
leaves it out, as it already leaves out the pack plan: a refresh while the dialog closes would ask for the plan of an
order that is delivered now, and the API answers 409.

```diff
@@ -230,6 +244,57 @@ export function canBook(order: StorefrontOrder): boolean {
   return order.status === 'packed' && openParcel(order) === null;
 }
 
+// ---------------------------------------------------------------------------------------------
+// Step 28b: the parcel at the shopper's door
+
+// The parcel the courier took to the door, by the API's own rule (cod-receipts.ts doorParcel): the
+// newest one that is not still booking or failed (the courier never had it), not a cancelled
+// booking, and not one received back. Delivered asks what its rider collected, and its COD receipt
+// is the one the page talks about
+export function doorParcel(order: StorefrontOrder): StorefrontShipment | null {
+  const skip: readonly ShipmentStatus[] = ['booking', 'booking_failed', 'cancelled', 'returned'];
+  return parcelsNewestFirst(order).find((parcel) => !skip.includes(parcel.status)) ?? null;
+}
+
+// Whether Delivered (and Record what came back) asks what the rider collected: only when a COD
+// receipt will be made, so the parcel's account has a COD account and the rider had something to
+// collect (an order paid online has codAmount 0)
+export function asksCollected(parcel: StorefrontShipment | null): parcel is StorefrontShipment {
+  return parcel !== null && parcel.account.hasCodAccount && !isZeroMoney(parcel.codAmount);
+}
+
+// What the amount box starts with: what the courier said the rider collected, else what the rider
+// was to collect. Shown as the shop writes money ("538", "247.50"): the API keeps four decimals
+export function collectedStart(parcel: StorefrontShipment): string {
+  return plainMoney(parcel.collectedAmount ?? parcel.codAmount);
+}
+
+// "538.0000" → "538", "247.5000" → "247.50": what a person would type in a money box
+export function plainMoney(amount: string): string {
+  const [whole = '0', fraction = ''] = amount.split('.');
+  const paisa = fraction.padEnd(2, '0').slice(0, 2);
+  return paisa === '00' ? whole : `${whole}.${paisa}`;
+}
+
+// The three moves of a shipped order (approved with the mockup), and which one is the primary
+// button: the one the newest parcel asks for. The courier said part of it came back → Record what
+// came back; it is bringing it back (or says it is back) → Receive the return; else Mark delivered.
+// A manual parcel never says, so the three are always there
+export type DoorMove = 'cameBack' | 'receive' | 'deliver';
+
+export function primaryDoorMove(order: StorefrontOrder): DoorMove {
+  const status = order.shipments.at(-1)?.status;
+  if (status === 'partly_delivered') return 'cameBack';
+  if (status === 'returning' || status === 'returned') return 'receive';
+  return 'deliver';
+}
+
+// A delivered parcel whose COD receipt could not be made (mine 14: the error sits on the parcel).
+// The newest one: "Make the receipt" fixes one at a time
+export function receiptFailed(order: StorefrontOrder): StorefrontShipment | null {
+  return parcelsNewestFirst(order).find((parcel) => parcel.receiptError !== null) ?? null;
+}
+
 // ---------------------------------------------------------------------------------------------
 // Step 28a: the export for a courier's bulk upload (decision 19)
 
```

- **`doorParcel`** follows the API's own rule (`cod-receipts.ts`), so the screen and the server always talk about the
  same parcel. A parcel still booking or failed never reached the courier, a cancelled booking went nowhere, and a
  returned one is back on the shelf (mine 28).
- **`asksCollected`** decides whether the amount box shows. Only when a COD receipt will be made: the account has a
  COD account, and the rider has something to collect. An order paid online has a `codAmount` of 0. It is a type
  guard, so after it TypeScript knows the parcel is not `null`, and the dialogs read `door.codAmount` without a
  check.
- **`collectedStart`** fills the box with what the courier said, else the whole amount. It uses `??`, not `||`:
  a courier that said ৳0 said something, and the box must show 0.
- **`plainMoney`** writes the API's four decimals the way a person types (`538`, `247.50`). The box shows what it
  holds as typed, and a `538.0000` there would look like a mistake.
- **`primaryDoorMove`** reads the newest parcel. `returned` counts with `returning`: a courier can say the parcel is
  back before anyone received it.
- **`receiptFailed`** finds the newest parcel with a receipt error. "Make the receipt" fixes one parcel at a time.

```diff
@@ -8,17 +8,23 @@ import {
 import { describe, expect, it } from 'vitest';
 
 import {
+  asksCollected,
   canBook,
   canCancel,
+  collectedStart,
   courierCsv,
   decimalsOf,
+  doorParcel,
   nextStep,
   openParcel,
   packFormValues,
   parcelFailed,
   parcelsNewestFirst,
   pickedOf,
+  plainMoney,
   plainQuantity,
+  primaryDoorMove,
+  receiptFailed,
   toPackInput,
 } from './storefront-orders';
 
@@ -231,6 +237,76 @@ describe('the parcels', () => {
   });
 });
 
+// Step 28b.6. A parcel at the door, with only the money the helpers read
+function moneyParcel(
+  id: string,
+  status: StorefrontShipment['status'],
+  money: Partial<
+    Pick<StorefrontShipment, 'codAmount' | 'collectedAmount' | 'receiptError'> & {
+      hasCodAccount: boolean;
+    }
+  > = {},
+): StorefrontShipment {
+  return {
+    id,
+    status,
+    account: { hasCodAccount: money.hasCodAccount ?? true },
+    codAmount: money.codAmount ?? '538.0000',
+    collectedAmount: money.collectedAmount ?? null,
+    receiptError: money.receiptError ?? null,
+  } as StorefrontShipment;
+}
+
+describe('the parcel at the door', () => {
+  it('is the newest one the courier took, never a failed, cancelled or received one', () => {
+    const failed = moneyParcel('p1', 'booking_failed');
+    const delivered = moneyParcel('p2', 'delivered');
+    expect(doorParcel(withParcels('delivered', [failed, delivered]))).toBe(delivered);
+    // The courier took the second parcel: it is the one at the door
+    const second = moneyParcel('p3', 'out_for_delivery');
+    expect(doorParcel(withParcels('shipped', [delivered, second]))).toBe(second);
+    // Received back (mine 28) or a booking that never reached the courier: none
+    expect(doorParcel(withParcels('returned', [moneyParcel('p4', 'returned')]))).toBeNull();
+    expect(doorParcel(withParcels('packed', [failed, moneyParcel('p5', 'cancelled')]))).toBeNull();
+  });
+
+  it('asks what the rider collected only when a COD receipt will be made', () => {
+    expect(asksCollected(moneyParcel('p1', 'in_transit'))).toBe(true);
+    // No COD account: the receipt is typed by hand, as before 28b
+    expect(asksCollected(moneyParcel('p1', 'in_transit', { hasCodAccount: false }))).toBe(false);
+    // Paid online: the rider collects nothing
+    expect(asksCollected(moneyParcel('p1', 'in_transit', { codAmount: '0.0000' }))).toBe(false);
+    expect(asksCollected(null)).toBe(false);
+  });
+
+  it('starts the box with what the courier said, else what the rider was to collect', () => {
+    expect(collectedStart(moneyParcel('p1', 'in_transit'))).toBe('538');
+    expect(
+      collectedStart(moneyParcel('p1', 'partly_delivered', { collectedAmount: '247.5000' })),
+    ).toBe('247.50');
+    // Zero is what the courier said, not "nothing said"
+    expect(collectedStart(moneyParcel('p1', 'delivered', { collectedAmount: '0.0000' }))).toBe('0');
+    expect(plainMoney('1240')).toBe('1240');
+  });
+
+  it('makes the button the parcel asks for the primary one', () => {
+    const shipped = (status: StorefrontShipment['status']) =>
+      withParcels('shipped', [moneyParcel('p1', status)]);
+    expect(primaryDoorMove(shipped('in_transit'))).toBe('deliver');
+    expect(primaryDoorMove(shipped('partly_delivered'))).toBe('cameBack');
+    expect(primaryDoorMove(shipped('returning'))).toBe('receive');
+    expect(primaryDoorMove(shipped('returned'))).toBe('receive');
+    // A manual parcel, or none: the member decides, Mark delivered first
+    expect(primaryDoorMove(withParcels('shipped', []))).toBe('deliver');
+  });
+
+  it('finds the parcel whose COD receipt failed', () => {
+    const failed = moneyParcel('p1', 'delivered', { receiptError: 'receipt_account_invalid' });
+    expect(receiptFailed(withParcels('delivered', [failed]))).toBe(failed);
+    expect(receiptFailed(withParcels('delivered', [moneyParcel('p2', 'delivered')]))).toBeNull();
+  });
+});
+
 describe('the courier export file', () => {
   const row: CourierExportRow = {
     orderId: '0193a1b2-0000-7000-8000-0000000000c1',
```

The tests build a parcel with only the fields the helpers read, as 28a's tests do. Each case is one a person meets:
a second parcel at the door, a parcel paid online, a courier that said ৳0, and the three buttons' primary.

### The parcel card

```diff
@@ -40,7 +40,8 @@ import {
   TextField,
 } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
-import { useEffect, useRef } from 'react';
+import { Link } from '@tanstack/react-router';
+import { type ReactNode, useEffect, useRef } from 'react';
 import { createPortal } from 'react-dom';
 import { useForm, useWatch } from 'react-hook-form';
 
@@ -49,6 +50,7 @@ import { applyApiError } from '../lib/field-errors';
 import { settingsQuery } from '../lib/queries';
 import { parcelsNewestFirst, storefrontCourierChoicesQuery } from '../lib/storefront-orders';
 import { useTenantId, useTimeZone } from '../lib/workspace';
+import { useShopMoney } from './storefront-parts';
 
 // Step 28a.6: a shop order's parcels on its page (approved with the mockup), the Book courier
 // dialog and the parcel's label. A file of its own, loaded with the order page: the list never
@@ -98,7 +100,7 @@ function useCollect(): (amount: string) => string {
   };
 }
 
-function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
+function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
   return (
     <div className="grid min-w-0 gap-0.5">
       <dt className="text-caption text-ink-3">{label}</dt>
@@ -126,6 +128,7 @@ function ParcelCard({
   const { t, format, errorText } = useLocale();
   const timeZone = useTimeZone();
   const collect = useCollect();
+  const money = useShopMoney();
   const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
   const byApi = parcel.account.provider !== 'manual';
   const courier = t(`storefront.couriers.names.${parcel.courier}`);
@@ -133,7 +136,7 @@ function ParcelCard({
   // Only an API parcel has news; a manual one moves with the order's buttons
   const events = [...parcel.events].reverse();
 
-  const facts: { label: string; value: string; mono?: boolean }[] = [];
+  const facts: { label: string; value: ReactNode; mono?: boolean }[] = [];
   if (parcel.trackingCode !== null) {
     facts.push({ label: t('storefront.order.parcels.courier'), value: courier });
     facts.push({
@@ -150,6 +153,33 @@ function ParcelCard({
     });
   }
   facts.push({ label: t('storefront.order.parcels.cod'), value: collect(parcel.codAmount) });
+  // Step 28b (decision 5, approved with the mockup): what the courier's notice said, or what the
+  // member typed at Delivered, beside what the rider was to collect. As the shop writes money
+  // (paisa only when there is some); zero is real (nothing collected), so money(), not collect()
+  if (parcel.collectedAmount !== null) {
+    facts.push({
+      label: t('storefront.order.parcels.collected'),
+      value: money(parcel.collectedAmount),
+    });
+  }
+  if (parcel.courierCharge !== null) {
+    facts.push({ label: t('storefront.order.parcels.charge'), value: money(parcel.courierCharge) });
+  }
+  // Decision 4: the COD receipt, as a link (every member reads the sales documents)
+  if (parcel.receipt !== null) {
+    facts.push({
+      label: t('storefront.order.parcels.receipt'),
+      value: (
+        <Link
+          to="/receipts/$receiptId"
+          params={{ receiptId: parcel.receipt.id }}
+          className="font-mono text-[13px] font-medium text-brand underline-offset-3 hover:underline"
+        >
+          {parcel.receipt.number ?? '—'}
+        </Link>
+      ),
+    });
+  }
   if (parcel.bookedAt !== null) {
     facts.push({ label: t('storefront.order.parcels.bookedAt'), value: when(parcel.bookedAt) });
     if (byApi) {
@@ -227,6 +257,18 @@ function ParcelCard({
             </span>
           </p>
         )}
+        {/* Step 28b (mine 14, approved with the mockup): the COD receipt's error sits on its
+            parcel. The button is in the page's notice ("Make the receipt"), as Book again is */}
+        {parcel.receiptError !== null && (
+          <p className="flex items-start gap-1.5 text-label text-crit">
+            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-0.5" />
+            <span>
+              {t('storefront.order.parcels.receiptError', {
+                reason: errorText(parcel.receiptError),
+              })}
+            </span>
+          </p>
+        )}
         {!byApi && parcel.status === 'booked' && (
           <p className="text-body-sm text-ink-2">{t('storefront.order.parcels.manual')}</p>
         )}
```

`Fact` now takes a `ReactNode`, so the money receipt can be a link. Every member reads the sales documents, so the
link needs no permission check.

"Rider collected" uses the shop's own money format (`useShopMoney`), not `collect()`. `collect()` writes zero as
"Nothing: paid online", which is right for what the rider *was to* collect, but wrong for what the rider *did*
collect: a ৳0 there means the shopper paid nothing at the door.

The receipt's error shows on its parcel with the error's own words (mine 14). The button is not on the card but in
the page's notice, the same split as 28a's failed booking (approved with the mockup). Two buttons for one fix would
make a member wonder which one to press.

### The payments notice

```diff
@@ -74,10 +74,17 @@ export function invoiceTookPayment(order: StorefrontOrder): boolean {
 // - cancelled: the order was cancelled (or returned) after the shopper paid;
 // - cod: a cash on delivery order with a paid try (the shopper paid, then chose to pay the rider);
 // - twice: an online order paid twice (two tabs).
-export function refundCase(order: StorefrontOrder): 'cancelled' | 'cod' | 'twice' | null {
+// Step 28b: and
+// - partly: an online order whose parcel came back in part. Its invoice took only what the shopper
+//   kept (the sales return came before it), so the rest of the payment waits to be paid back.
+//   Before twice: a return and a second payment both mean money back, and this one names it all.
+export function refundCase(
+  order: StorefrontOrder,
+): 'cancelled' | 'cod' | 'twice' | 'partly' | null {
   const paid = paidTries(order);
   if (paid.length === 0) return null;
   if (order.status === 'cancelled' || order.status === 'returned') return 'cancelled';
+  if (order.status === 'delivered' && order.salesReturn !== null) return 'partly';
   if (order.paymentMethod === 'cod') return 'cod';
   return paid.length > 1 ? 'twice' : null;
 }
@@ -101,6 +108,7 @@ export function RefundNotice({ order }: { order: StorefrontOrder }) {
     cancelled: t('storefront.order.paidCancelled', { amount }),
     cod: t('storefront.order.paidOnCod', { amount }),
     twice: t('storefront.order.paidTwice', { amount }),
+    partly: t('storefront.order.paidPartly', { amount }),
   }[kind];
   const withReceipt = paid.filter((payment) => payment.receipt !== null);
   const receipt = withReceipt[withReceipt.length - 1]?.receipt ?? null;
```

A new refund case, `partly`: an order paid online whose parcel came back in part. Its invoice took only what the
shopper kept, because the sales return came before the invoice (decision 6), so the rest of the payment is left
over. The case is checked before `cod` and `twice` because it covers everything paid. A delivered order with a
sales return can only be a partly delivered one: a cancelled packed order is Cancelled, not Delivered.

### Mark delivered and Receive the return

```tsx
import { InformationCircleIcon } from '@hugeicons/core-free-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  deliverStorefrontOrderInputSchema,
  returnStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DialogClose,
  DialogContent,
  FormAlert,
  FormField,
  MoneyInput,
  TextAreaField,
} from '@omnivo/ui';
import { useForm } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { asksCollected, collectedStart, doorParcel } from '../lib/storefront-orders';
import { DocumentNotice } from './document-notice';
import { useShopMoney } from './storefront-parts';

// Step 28b.6: the two small dialogs of a shipped order at the shopper's door (approved with the
// mockup): Mark delivered, which now asks what the rider collected, and Receive the return. They
// load with the order page: both are a few boxes. "Record what came back" has lists and its own
// read, so it is a chunk of its own (storefront-came-back.tsx).

// The toast after Delivered or Record what came back: it names the COD receipt only when one was
// made (a COD account and something collected). The door parcel of the answer, the delivered one
export function deliveredToast(
  t: ReturnType<typeof useLocale>['t'],
  saved: StorefrontOrder,
): string {
  const receipt = doorParcel(saved)?.receipt?.number ?? null;
  const words = { number: saved.orderNo, invoice: saved.invoice?.number ?? '' };
  if (saved.salesReturn !== null) {
    const partly = { ...words, salesReturn: saved.salesReturn.number ?? '' };
    return receipt === null
      ? t('storefront.order.partlyDelivered', partly)
      : t('storefront.order.partlyDeliveredWithReceipt', { ...partly, receipt });
  }
  return receipt === null
    ? t('storefront.order.delivered', words)
    : t('storefront.order.deliveredWithReceipt', { ...words, receipt });
}

const DELIVER_FIELDS = ['collectedAmount'] as const;

// Mark delivered (decisions 4 and 5, mine 41). Three bodies: a COD receipt will be made (the box
// asks what the rider collected), the order was paid online (the invoice takes that receipt), or
// neither (the invoice stays unpaid, 27b's words). The box starts with what the courier said, else
// what the rider was to collect
export function DeliverDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const door = doorParcel(order);
  const asks = asksCollected(door);
  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(deliverStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, collectedAmount: asks ? collectedStart(door) : '' },
  });
  const total = money(order.total);
  const body = asks
    ? t('storefront.order.deliverBodyCod', { total, courier: door.account.name })
    : order.paymentMethod === 'online'
      ? t('storefront.order.deliverBodyPaid', { total })
      : t('storefront.order.deliverBody', { total });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrderDeliveries.deliverOrder, {
        params: { id: order.id },
        body: values,
      });
      await onDone(saved);
    } catch (error) {
      applyApiError(error, DELIVER_FIELDS, setError);
    }
  });

  return (
    <DialogContent
      title={t('storefront.order.deliverTitle', { number: order.orderNo })}
      description={body}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="deliver-shop-order" disabled={isSubmitting}>
            {t('storefront.order.deliver')}
          </Button>
        </>
      }
    >
      <form
        id="deliver-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        {asks && (
          <FormField
            control={control}
            name="collectedAmount"
            label={t('storefront.order.collected')}
            hint={t('storefront.order.collectedHint', { amount: money(door.codAmount) })}
          >
            {/* The form keeps '' for an empty box: the schema makes it null, and the API then
                takes what the courier said, else the whole amount */}
            {(field) => <MoneyInput {...field} value={field.value ?? ''} />}
          </FormField>
        )}
      </form>
    </DialogContent>
  );
}

// Receive the return (decision 7, mine 42): the whole parcel is back. The body says what it posts;
// the check that the goods are on the shelf is its own neutral notice, so it is not lost in the body
export function ReceiveDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(returnStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, reason: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrderDeliveries.returnOrder, {
        params: { id: order.id },
        body: values,
      });
      await onDone(saved);
    } catch (error) {
      applyApiError(error, ['reason'], setError);
    }
  });
  return (
    <DialogContent
      title={t('storefront.order.receiving.title', { number: order.orderNo })}
      description={t('storefront.order.receiving.body', {
        delivery: order.delivery?.number ?? '',
      })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('storefront.order.receiving.keep')}</Button>
          </DialogClose>
          <Button type="submit" form="receive-shop-order" disabled={isSubmitting}>
            {t('storefront.order.receiving.submit')}
          </Button>
        </>
      }
    >
      <form
        id="receive-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
          {t('storefront.order.receiving.check')}
        </DocumentNotice>
        <TextAreaField
          label={t('storefront.order.receiving.reason')}
          optional
          placeholder={t('storefront.order.receiving.reasonPlaceholder')}
          hint={t('storefront.order.receiving.reasonHint')}
          maxLength={200}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
```

A small file that loads with the order page: both dialogs are a few boxes each. The bigger dialog has its own chunk
(below).

**`deliveredToast`** serves both Delivered and Record what came back, because both answer with a delivered order.
A sales return on the answer means part of the parcel came back. It names the receipt only when one was made: with
no COD account, or nothing collected, a toast that names no receipt is the truth.

**`DeliverDialog`** (mine 41, 46) chooses its body in the order that matters:

1. a COD receipt will be made (the box shows);
2. the order was paid online (the invoice takes that receipt);
3. otherwise 27b's words: the invoice stays unpaid.

The form's resolver is the contract's own schema, so an amount with three decimals is refused under the box before
any request. The `FormField` gives `MoneyInput` its label, hint and error. `field.value ?? ''` is needed because the
schema's input type allows `null` (an empty box), while the box shows a string. When the box is not shown, the
form sends `''`, which the schema turns into `null`. The API then uses what the courier said, else the whole
amount, so a shop with no COD account delivers exactly as before.

**`ReceiveDialog`** (mine 42) shows the shelf check as its own neutral notice inside the dialog, so it is not lost in
the body. "Not yet" is the button that closes it: the member is waiting for the parcel, not refusing it.

### Record what came back

```tsx
import {
  Alert02Icon,
  InformationCircleIcon,
  MinusSignIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  addQuantity,
  compareQuantity,
  contractErrorMap,
  isQuantity,
  partlyDeliverStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
  type StorefrontReturnPlan,
  subtractQuantity,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  MoneyInput,
  parseIsoDate,
  TextAreaField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import {
  asksCollected,
  decimalsOf,
  doorParcel,
  plainMoney,
  plainQuantity,
  storefrontReturnPlanQuery,
} from '../lib/storefront-orders';
import { useTenantId } from '../lib/workspace';
import { useShopMoney } from './storefront-parts';

// Step 28b.6: "Record what came back" (decision 6, approved with the mockup), a chunk of its own,
// loaded when the button is pressed: most shipped orders are delivered whole. One row per challan
// line (the return plan), in the challan's order. A ticked row says how many came back (a stepper,
// 1 to what the line took) or, for a serial product, which pieces (one tick each). Only the ticked
// rows are sent (mine 16). The POS return's line rows, without its money: what the shopper kept is
// worked out by the API from the order's own prices.

type PlanLine = StorefrontReturnPlan['lines'][number];

// What a ticked row holds: the box's text as typed, and the serial numbers ticked
interface Pick {
  quantity: string;
  serials: string[];
}

// Errors by the API's path ("lines", "lines.0.quantity", "collectedAmount"), as codes. The paths
// of the lines are by the place in the body, which has only the ticked rows: `sent` maps them back
type Errors = Record<string, string>;

function firstPick(line: PlanLine): Pick {
  // A serial line starts with nothing ticked (the member names the pieces); another with one
  return line.tracking === 'serial'
    ? { quantity: '0', serials: [] }
    : { quantity: '1', serials: [] };
}

export function CameBackDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const { data: plan, isError } = useQuery(storefrontReturnPlanQuery(useTenantId(), order.id));
  return (
    <DialogContent
      // The Packed dialog's width: a row has a name, a batch and a stepper
      className="max-w-[560px]"
      title={t('storefront.order.cameBack.title', { number: order.orderNo })}
      description={
        plan
          ? t('storefront.order.cameBack.description', { warehouse: plan.warehouse.name })
          : undefined
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="came-back" disabled={!plan}>
            {t('storefront.order.cameBack.submit')}
          </Button>
        </>
      }
    >
      {isError ? (
        <FormAlert message={t('storefront.order.cameBack.loadFailed')} />
      ) : (
        plan && <CameBackForm order={order} plan={plan} onDone={onDone} />
      )}
    </DialogContent>
  );
}

function CameBackForm({
  order,
  plan,
  onDone,
}: {
  order: StorefrontOrder;
  plan: StorefrontReturnPlan;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const money = useShopMoney();
  const door = doorParcel(order);
  const asks = asksCollected(door);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  // What the courier said the rider collected for what the shopper kept. Without it the box starts
  // empty: the whole parcel's amount would be wrong for a part of it, and the API asks for it
  // (storefront_order_collected_required)
  const [collected, setCollected] = useState(
    asks && door.collectedAmount !== null ? plainMoney(door.collectedAmount) : '',
  );
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [sending, setSending] = useState(false);
  // The ticked rows in the order they were sent, so "lines.1.quantity" finds its row
  const [sent, setSent] = useState<string[]>([]);
  // Ticked serial rows with no piece ticked (mine 49). Their count would be 0, which the contract
  // refuses as a quantity ("Enter a number above zero"), words that make no sense under ticks
  const [noSerials, setNoSerials] = useState<string[]>([]);

  const pick = (line: PlanLine, next: Pick | null) => {
    const others = Object.fromEntries(
      Object.entries(picks).filter(([id]) => id !== line.deliveryLineId),
    );
    setPicks(next ? { ...others, [line.deliveryLineId]: next } : others);
  };

  // The body, from the ticked rows in the challan's order. A serial row's quantity is its count
  const body = () => {
    const ticked = plan.lines.filter((line) => picks[line.deliveryLineId] !== undefined);
    return {
      ids: ticked.map((line) => line.deliveryLineId),
      input: {
        version: order.version,
        lines: ticked.map((line) => {
          const chosen = picks[line.deliveryLineId] ?? firstPick(line);
          return line.tracking === 'serial'
            ? {
                deliveryLineId: line.deliveryLineId,
                quantity: String(chosen.serials.length),
                serialNumbers: chosen.serials,
              }
            : {
                deliveryLineId: line.deliveryLineId,
                quantity: chosen.quantity.trim(),
                serialNumbers: [],
              };
        }),
        // Not asked (no COD account, or nothing to collect): left to the API
        collectedAmount: asks ? collected : '',
        reason,
      },
    };
  };

  const submit = async () => {
    const { ids, input } = body();
    setSent(ids);
    const empty = plan.lines
      .filter(
        (line) => line.tracking === 'serial' && picks[line.deliveryLineId]?.serials.length === 0,
      )
      .map((line) => line.deliveryLineId);
    setNoSerials(empty);
    if (empty.length > 0) {
      setErrors({});
      return;
    }
    // The contract's own rules first (nothing ticked, a box that is not a quantity), with the
    // same paths as the API's answer
    const parsed = partlyDeliverStorefrontOrderInputSchema.safeParse(input, {
      error: contractErrorMap,
    });
    if (!parsed.success) {
      const found: Errors = {};
      for (const issue of parsed.error.issues) found[issue.path.join('.')] ??= issue.message;
      setErrors(found);
      return;
    }
    setErrors({});
    setSending(true);
    try {
      const saved = await call(routes.storefrontOrderDeliveries.partlyDeliverOrder, {
        params: { id: order.id },
        body: parsed.data,
      });
      await onDone(saved);
    } catch (error) {
      if (!(error instanceof ApiRequestError)) {
        setErrors({ '': 'unknown_error' });
      } else {
        const fieldErrors = Object.entries(error.problem.fieldErrors ?? {}).flatMap(
          ([path, codes]) => (codes[0] === undefined ? [] : [[path, codes[0]] as const]),
        );
        setErrors(fieldErrors.length > 0 ? Object.fromEntries(fieldErrors) : { '': error.code });
      }
    } finally {
      setSending(false);
    }
  };

  // A row's own error: its quantity or its serial numbers, by its place in what was sent
  const rowError = (line: PlanLine): string | undefined => {
    const index = sent.indexOf(line.deliveryLineId);
    if (index === -1) return undefined;
    return Object.entries(errors).find(([path]) => path.startsWith(`lines.${String(index)}.`))?.[1];
  };

  return (
    <form
      id="came-back"
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sending) void submit();
      }}
    >
      {errors[''] !== undefined && <FormAlert message={errors['']} />}
      <div className="grid gap-1.5">
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {plan.lines.map((line) => (
            <CameBackRow
              key={line.deliveryLineId}
              line={line}
              pick={picks[line.deliveryLineId] ?? null}
              onPick={(next) => {
                pick(line, next);
              }}
              error={rowError(line)}
              noSerials={noSerials.includes(line.deliveryLineId)}
            />
          ))}
        </ul>
        {/* storefront_order_return_nothing / return_everything: about the lines as a whole */}
        {errors.lines !== undefined && <LinesError code={errors.lines} />}
      </div>
      {asks && (
        <Field
          id="came-back-collected"
          label={t('storefront.order.cameBack.collected')}
          hint={t('storefront.order.cameBack.collectedHint', { amount: money(door.codAmount) })}
          error={errors.collectedAmount}
        >
          <MoneyInput
            id="came-back-collected"
            value={collected}
            onChange={setCollected}
            invalid={errors.collectedAmount !== undefined}
          />
          {door.collectedAmount !== null && (
            <p className="flex items-start gap-1.5 text-label text-ink-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                size={15}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-ink-3"
              />
              {t('storefront.order.cameBack.collectedFromCourier', {
                courier: door.account.name,
                amount: money(door.collectedAmount),
              })}
            </p>
          )}
        </Field>
      )}
      <TextAreaField
        id="came-back-reason"
        label={t('storefront.order.cameBack.reason')}
        optional
        placeholder={t('storefront.order.cameBack.reasonPlaceholder')}
        hint={t('storefront.order.cameBack.reasonHint')}
        maxLength={200}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        error={errors.reason}
      />
    </form>
  );
}

function LinesError({ code }: { code: string }) {
  const { errorText } = useLocale();
  return <p className="text-label text-crit">{errorText(code)}</p>;
}

function CameBackRow({
  line,
  pick,
  onPick,
  error,
  noSerials,
}: {
  line: PlanLine;
  pick: Pick | null;
  onPick: (pick: Pick | null) => void;
  error: string | undefined;
  noSerials: boolean;
}) {
  const { t, format, errorText } = useLocale();
  const id = `came-back-${line.deliveryLineId}`;
  const sentQuantity = plainQuantity(line.quantity);
  const decimals = decimalsOf(line.quantity);
  const expires = line.batch?.expiresOn ? parseIsoDate(line.batch.expiresOn) : undefined;
  const details = [
    t('storefront.order.cameBack.sent', {
      quantity: `${format.number(sentQuantity, decimals)} ${line.unitCode}`,
    }),
    line.batch === null
      ? ''
      : expires
        ? t('storefront.order.cameBack.batchExpires', {
            lot: line.batch.lotNumber,
            date: format.date(expires),
          })
        : t('storefront.order.cameBack.batch', { lot: line.batch.lotNumber }),
  ].filter((part) => part !== '');

  // The arrows move by one piece, never below one, never above what the line took
  const step = (by: number) => {
    if (!pick) return;
    const now = isQuantity(pick.quantity) ? pick.quantity : '0';
    const next = by > 0 ? addQuantity(now, '1') : subtractQuantity(now, '1');
    if (compareQuantity(next, '1') < 0 || compareQuantity(next, line.quantity) > 0) return;
    onPick({ ...pick, quantity: plainQuantity(next) });
  };

  return (
    <li className="grid gap-2.5 px-3.5 py-3">
      <div className="flex items-start gap-2.5">
        {/* The checkbox's name says the product ("Came back: Neem face wash"); the visible
            label beside it is the name and the details, so the label is for screen readers */}
        <Checkbox
          id={id}
          label={t('storefront.order.cameBack.take', { name: line.name })}
          hideLabel
          checked={pick !== null}
          onCheckedChange={(checked) => {
            onPick(checked === true ? firstPick(line) : null);
          }}
        />
        <label htmlFor={id} className="grid min-w-0 flex-1">
          <span className="text-body-sm font-medium text-ink">{line.name}</span>
          <span className="text-caption text-ink-3 tabular-nums">
            <span className="font-mono">{line.sku}</span>
            {line.packSize !== '' && ` · ${line.packSize}`}
            {` · ${details.join(' · ')}`}
          </span>
        </label>
      </div>
      {pick && line.tracking !== 'serial' && (
        <div className="flex flex-wrap items-center gap-2.5 pl-[27px]">
          <label htmlFor={`${id}-quantity`} className="text-label font-medium text-ink-2">
            {t('storefront.order.cameBack.quantity')}
          </label>
          <span className="inline-flex items-center rounded-control border border-line-strong bg-surface">
            <button
              type="button"
              aria-label={`${t('storefront.order.cameBack.quantity')} −1`}
              onClick={() => {
                step(-1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.5} />
            </button>
            <input
              id={`${id}-quantity`}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={error !== undefined}
              value={pick.quantity}
              onChange={(event) => {
                onPick({ ...pick, quantity: event.target.value });
              }}
              className="w-14 bg-transparent text-center text-body-sm font-medium tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label={`${t('storefront.order.cameBack.quantity')} +1`}
              onClick={() => {
                step(1);
              }}
              className="grid size-8 place-items-center text-ink-2 hover:text-ink"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.5} />
            </button>
          </span>
          <span className="text-label text-ink-3">{line.unitCode}</span>
          {error !== undefined && (
            <span className="w-full text-label text-crit">{errorText(error)}</span>
          )}
        </div>
      )}
      {pick && line.tracking === 'serial' && (
        <div className="pl-[27px]">
          <CheckboxGroup
            legend={t('storefront.order.cameBack.serials')}
            options={line.serialNumbers.map((serial) => ({
              value: serial,
              label: <span className="font-mono">{serial}</span>,
            }))}
            value={pick.serials}
            onChange={(serials) => {
              onPick({ ...pick, serials });
            }}
            error={error}
          />
          {noSerials && error === undefined && (
            // The look of a field's error (CheckboxGroup's own takes an error code only)
            <p className="mt-1.5 flex items-center gap-1.5 text-label text-crit">
              <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
              {t('storefront.order.cameBack.serialsNone')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
```

This dialog has its own chunk, loaded when the button is pressed. It has lists and its own read, and most shipped
orders are delivered whole, so most visits to an order never load it.

It uses the POS return's line rows (20c): a checkbox per line, a stepper once it is ticked, and one tick per serial
number for a serial product. It drops the POS rows' money: what the shopper kept is priced by the API from the
order's own lines.

The form is plain React state, not react-hook-form, as in the POS return. The rows are a map from the challan line
to its pick, and only the ticked rows are sent (mine 16).

The errors come back by the request's paths (`lines.1.quantity`). The body has only the ticked rows, so index 1 is
the second *ticked* row, not the second row on screen. `sent` keeps the ticked rows in the order they were sent,
so `rowError` can find a row's error by its place in that list.

The contract's schema runs first, with `contractErrorMap`. It gives the same codes and paths as the API, so ticking
nothing shows `storefront_order_return_nothing` under the lines without a request. A serial row with no piece
ticked is stopped even earlier (mine 49).

The amount box starts empty unless the courier named the amount (mine 45). When the courier did name it, a line under
the box says where the first value came from.

### The order page

```diff
@@ -10,6 +10,7 @@ import {
   PackageDeliveredIcon,
   PackageIcon,
   PackageReceiveIcon,
+  PackageRemoveIcon,
   ShippingTruck01Icon,
   ShoppingCart01Icon,
   SmartPhone01Icon,
@@ -46,8 +47,8 @@ import { Link, useParams } from '@tanstack/react-router';
 import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react';
 import { useForm } from 'react-hook-form';
 
-import { CancelDraftDialog } from '../components/cancel-draft-dialog';
 import { DocumentNotice } from '../components/document-notice';
+import { DeliverDialog, deliveredToast, ReceiveDialog } from '../components/storefront-order-door';
 import {
   BookCourierDialog,
   ParcelCards,
@@ -67,10 +68,14 @@ import { useCan } from '../lib/permissions';
 import {
   canBook,
   canCancel,
+  type DoorMove,
+  doorParcel,
   nextStep,
   openParcel,
   type OrderStep,
   parcelFailed,
+  primaryDoorMove,
+  receiptFailed,
   storefrontOrderQuery,
 } from '../lib/storefront-orders';
 import { useOnline } from '../lib/use-online';
@@ -89,6 +94,14 @@ const PackDialog = lazy(() =>
   })),
 );
 
+// Step 28b.6: "Record what came back" too: a list with its own read, and most shipped orders are
+// delivered whole
+const CameBackDialog = lazy(() =>
+  import('../components/storefront-came-back').then((module) => ({
+    default: module.CameBackDialog,
+  })),
+);
+
 // The timeline's icon per status, the same pictures as the status pills, plus the shop's own two
 // steps: the cart for the moment it was placed, the phone for the code
 const STEP_ICONS = {
@@ -116,7 +129,16 @@ const STEP_BUTTONS = {
   deliver: PackageDeliveredIcon,
 } as const satisfies Record<OrderStep, IconSvgElement>;
 
-type Dialogs = 'pack' | 'deliver' | 'cancel' | 'book' | null;
+// Step 28b: a shipped order's three moves at the door (approved with the mockup). The primary
+// button is the one the parcel asks for (primaryDoorMove); the other two are secondary
+const DOOR_BUTTONS = {
+  cameBack: { icon: PackageRemoveIcon, word: 'recordCameBack' },
+  receive: { icon: PackageReceiveIcon, word: 'receiveReturn' },
+  deliver: { icon: PackageDeliveredIcon, word: 'deliver' },
+} as const satisfies Record<DoorMove, { icon: IconSvgElement; word: string }>;
+const DOOR_MOVES = ['cameBack', 'receive', 'deliver'] as const satisfies readonly DoorMove[];
+
+type Dialogs = 'pack' | 'cancel' | 'book' | DoorMove | null;
 
 // After a move: the order's own answer at once, then every read the move changed. The orders (the
 // list, the sidebar's count), and the sales, stock, books and customers, because Packed posts a
@@ -134,8 +156,10 @@ function useApplyMove(): (saved: StorefrontOrder) => Promise<void> {
             queryKey: [area, tenantId],
             // Not the Packed dialog's plan: it is asked again each time the dialog opens (gcTime
             // 0), and refreshed here, while the dialog is still open, it would ask for the plan
-            // of an order that is packed now, which the API refuses (409)
-            predicate: (query) => query.queryKey[3] !== 'pack-plan',
+            // of an order that is packed now, which the API refuses (409). Step 28b: nor the
+            // return plan, for the same reason (the order is delivered now)
+            predicate: (query) =>
+              query.queryKey[3] !== 'pack-plan' && query.queryKey[3] !== 'return-plan',
           }),
         ),
       );
```

`CameBackDialog` is lazy, like the Packed dialog. `DOOR_BUTTONS` keeps each move's icon and word in one table, and
`satisfies Record<DoorMove, …>` makes the type check fail if a move is added without a button. The `Dialogs` type
gains the three moves, so the page still has one `dialog` state for every dialog.

```diff
@@ -524,7 +548,6 @@ function CancelDialog({
 function OrderView({ order }: { order: StorefrontOrder }) {
   const { t, errorText, format } = useLocale();
   const timeZone = useTimeZone();
-  const money = useShopMoney();
   const can = useCan();
   const canManage = can('storefront.order.manage');
   const applyMove = useApplyMove();
@@ -550,11 +573,26 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         ? t('storefront.order.nextManual', { courier })
         : t('storefront.order.nextBooked', { courier });
     }
+    // Step 28b (decisions 6 and 7): the courier said part of it, or all of it, is coming back.
+    // The newest parcel's word, as the list's pill (a parcel coming back is no longer "open")
+    const newest = order.shipments.at(-1);
+    if (order.status === 'shipped' && newest !== undefined) {
+      const courier = newest.account.name;
+      if (newest.status === 'partly_delivered')
+        return t('storefront.order.nextPartly', { courier });
+      if (newest.status === 'returning' || newest.status === 'returned') {
+        return t('storefront.order.nextReturning', { courier });
+      }
+    }
     if (order.status === 'shipped' && open !== null && open.account.provider !== 'manual') {
       return t('storefront.order.nextShipped', { courier: open.account.name });
     }
     return null;
   })();
+  // Step 28b: the parcel at the door, and a COD receipt that could not be made (mine 14)
+  const door = doorParcel(order);
+  const noReceipt = receiptFailed(order);
+  const doorPrimary = primaryDoorMove(order);
 
   // Step 28a: "Book again" on a parcel that failed five times books the same parcel (the same
   // invoice) once more, in the worker
```

The step line of a shipped order now reads the newest parcel first. If the courier delivered only part of it, or is
bringing it back, that is what the member must hear (decisions 6 and 7). These lines come before 28a's "moves to
Delivered by itself", because a parcel coming back is no longer open, and `openParcel` would not find it.
`money` left `OrderView` with 27b's Delivered body, which moved into `DeliverDialog`.

```diff
@@ -570,11 +608,26 @@ function OrderView({ order }: { order: StorefrontOrder }) {
     },
   });
 
-  // The two moves with no dialog of their own (Make the sales order, Shipped), and Delivered's
-  // confirm. Their refusals (version_conflict, storefront_order_step_invalid, a sales error on the
-  // retry) belong to no box, so they show above the cards, or in the Delivered dialog
+  // Step 28b (mine 14): "Make the receipt" after a delivered parcel's COD receipt failed. The
+  // answer's parcel has the receipt now (or the error again, which the notice shows)
+  const makeReceipt = useMutation({
+    mutationFn: (parcel: StorefrontShipment) =>
+      call(routes.storefrontOrderDeliveries.makeCodReceipt, {
+        params: { id: order.id, shipmentId: parcel.id },
+        body: { version: order.version },
+      }),
+    onSuccess: async (saved, parcel) => {
+      await applyMove(saved);
+      const made = saved.shipments.find((one) => one.id === parcel.id)?.receipt?.number ?? '';
+      toast(t('storefront.order.parcels.receiptMade', { receipt: made }));
+    },
+  });
+
+  // The two moves with no dialog of their own (Make the sales order, Shipped). Their refusals
+  // (version_conflict, storefront_order_step_invalid, a sales error on the retry) belong to no
+  // box, so they show above the cards. Step 28b: Delivered has its own dialog now (the amount)
   const move = useMutation({
-    mutationFn: (kind: 'makeSalesOrder' | 'ship' | 'deliver') => {
+    mutationFn: (kind: 'makeSalesOrder' | 'ship') => {
       const body = { version: order.version };
       const params = { id: order.id };
       switch (kind) {
@@ -582,8 +635,6 @@ function OrderView({ order }: { order: StorefrontOrder }) {
           return call(routes.storefrontOrders.makeSalesOrder, { params, body });
         case 'ship':
           return call(routes.storefrontOrders.shipOrder, { params, body });
-        case 'deliver':
-          return call(routes.storefrontOrders.deliverOrder, { params, body });
       }
     },
     onSuccess: async (saved, kind) => {
@@ -595,12 +646,7 @@ function OrderView({ order }: { order: StorefrontOrder }) {
               number: saved.orderNo,
               salesOrder: saved.salesOrder?.number ?? '',
             })
-          : kind === 'ship'
-            ? t('storefront.order.shipped', { number: saved.orderNo })
-            : t('storefront.order.delivered', {
-                number: saved.orderNo,
-                invoice: saved.invoice?.number ?? '',
-              }),
+          : t('storefront.order.shipped', { number: saved.orderNo }),
       );
     },
   });
@@ -618,6 +664,10 @@ function OrderView({ order }: { order: StorefrontOrder }) {
     if (next === 'pack' || next === 'deliver') setDialog(next);
     else move.mutate(next);
   };
+  // Step 28b: the three buttons of a shipped order, the primary last (every page header's order)
+  // and the two others in their fixed order before it
+  const doorMoves =
+    step === 'deliver' ? [...DOOR_MOVES.filter((one) => one !== doorPrimary), doorPrimary] : [];
 
   // The notice under the header (decision 1, 29 and the `next` lines). A failed sales order comes
   // first: nothing else can happen before it is made
```

"Make the receipt" is a mutation of the page, like 28a's "Book again". Its toast reads the receipt's number from the
answer's parcel. The `move` mutation loses Delivered (it has a form now) and so also its `deliverOrder` call on the
old route group, which was 28b.1's expected type error. `doorMoves` puts the two other moves first and the primary
last (mine 44).

```diff
@@ -640,7 +690,36 @@ function OrderView({ order }: { order: StorefrontOrder }) {
   if (refundCase(order) !== null) notices.push(<RefundNotice key="refund" order={order} />);
   // The two notices above say what comes first; the step's own line only after them
   const blocked = order.documentError !== null || step === 'makeSalesOrder';
-  if (!blocked && invoiceTookPayment(order)) {
+  if (!blocked && noReceipt !== null) {
+    // Step 28b (mine 14, approved with the mockup): the COD receipt failed. crit, like a failed
+    // booking: the rider's cash is in no account until someone makes it. Its reason is the
+    // error's own words, the same as on the parcel card
+    notices.push(
+      <DocumentNotice
+        key="next"
+        tone="crit"
+        icon={Alert02Icon}
+        action={
+          canManage && (
+            <button
+              type="button"
+              disabled={makeReceipt.isPending}
+              className="font-medium text-brand underline-offset-3 hover:underline"
+              onClick={() => {
+                makeReceipt.mutate(noReceipt);
+              }}
+            >
+              {t('storefront.order.parcels.makeReceipt')}
+            </button>
+          )
+        }
+      >
+        {t('storefront.order.parcels.receiptError', {
+          reason: errorText(noReceipt.receiptError ?? 'unknown_error'),
+        })}
+      </DocumentNotice>,
+    );
+  } else if (!blocked && invoiceTookPayment(order)) {
     // Step 27d (decision 6): nothing to record, the invoice took the online payment's receipt
     notices.push(
       <DocumentNotice key="next" tone="neutral">
@@ -683,9 +762,26 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         {parcelText}
       </DocumentNotice>,
     );
+  } else if (!blocked && canManage && order.status === 'delivered' && door?.receipt) {
+    // Step 28b (decision 4): the rider's cash came in on the COD receipt, so nothing to record
+    notices.push(
+      <DocumentNotice key="next" tone="neutral">
+        {t('storefront.order.nextDeliveredCod', {
+          receipt: door.receipt.number ?? '',
+          courier: door.account.name,
+        })}
+      </DocumentNotice>,
+    );
   } else if (!blocked && canManage && order.status !== 'cancelled' && order.status !== 'returned') {
     // Decision 7: a delivered order's money comes in as an ordinary receipt for its invoice, for
-    // someone who may write one
+    // someone who may write one. Step 28b: with a COD account and nothing collected, the line
+    // says why no receipt was made
+    const nothingCollected =
+      order.status === 'delivered' &&
+      door !== null &&
+      door.account.hasCodAccount &&
+      door.collectedAmount !== null &&
+      isZeroMoney(door.collectedAmount);
     const receipt = order.status === 'delivered' &&
       order.invoice !== null &&
       order.customer !== null &&
@@ -700,7 +796,9 @@ function OrderView({ order }: { order: StorefrontOrder }) {
       );
     notices.push(
       <DocumentNotice key="next" tone="neutral" action={receipt}>
-        {t(`storefront.order.next.${order.status}`)}
+        {nothingCollected
+          ? t('storefront.order.nextDeliveredNothing')
+          : t(`storefront.order.next.${order.status}`)}
       </DocumentNotice>,
     );
   }
```

The notices, in the order that matters (mine 47):

1. a failed receipt, crit, with "Make the receipt" for a member who may move orders;
2. the online payment's receipt (27d);
3. a failed booking (28a);
4. the parcel's line;
5. the delivered lines.

A delivered order with a COD receipt says where the cash went and has no "Record payment" link: there is nothing to
record. A COD account with ৳0 collected says no receipt was made, and keeps the link, because the money is still
owed.

```diff
@@ -761,7 +859,23 @@ function OrderView({ order }: { order: StorefrontOrder }) {
                 {t('storefront.order.book')}
               </Button>
             )}
-            {step !== null && (
+            {/* Step 28b: a shipped order's three moves (approved with the mockup). On a phone
+                the two secondary ones share the first row and the primary takes the second */}
+            {doorMoves.map((one) => (
+              <Button
+                key={one}
+                variant={one === doorPrimary ? 'primary' : 'secondary'}
+                className={cn(one === doorPrimary && 'col-span-2')}
+                onClick={() => {
+                  move.reset();
+                  setDialog(one);
+                }}
+              >
+                <HugeiconsIcon icon={DOOR_BUTTONS[one].icon} size={17} strokeWidth={1.5} />
+                {t(`storefront.order.${DOOR_BUTTONS[one].word}`)}
+              </Button>
+            ))}
+            {step !== null && step !== 'deliver' && (
               <Button
                 className={cn(
                   (!cancellable || bookable) && 'col-span-2',
@@ -780,6 +894,13 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         )}
       </header>
       {moveError !== null && dialog === null && <FormAlert message={moveError} />}
+      {makeReceipt.error !== null && (
+        <FormAlert
+          message={
+            makeReceipt.error instanceof ApiRequestError ? makeReceipt.error.code : 'unknown_error'
+          }
+        />
+      )}
       {retry.error !== null && (
         <FormAlert
           message={retry.error instanceof ApiRequestError ? retry.error.code : 'unknown_error'}
@@ -821,24 +942,57 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         </div>
       </div>
 
-      {dialog === 'deliver' && (
-        // Decision 35: Delivered posts an invoice, so it asks first. The dialog of a cancelled
-        // draft, with this step's words
-        <CancelDraftDialog
-          title={t('storefront.order.deliverTitle', { number: order.orderNo })}
-          body={t('storefront.order.deliverBody', { total: money(order.total) })}
-          keep={t('common.cancel')}
-          confirm={t('storefront.order.deliver')}
-          pending={move.isPending}
-          error={moveError ?? undefined}
-          onConfirm={() => {
-            move.mutate('deliver');
-          }}
-          onClose={() => {
-            setDialog(null);
-          }}
-        />
-      )}
+      {/* Decision 35: Delivered posts an invoice, so it asks first. Step 28b: its own dialog, which
+          asks what the rider collected when a COD receipt will be made */}
+      <Dialog
+        open={dialog === 'deliver'}
+        onOpenChange={(open) => {
+          if (!open) setDialog(null);
+        }}
+      >
+        {dialog === 'deliver' && (
+          <DeliverDialog
+            order={order}
+            onDone={(saved) => afterDialog(saved, deliveredToast(t, saved))}
+          />
+        )}
+      </Dialog>
+      <Dialog
+        open={dialog === 'cameBack'}
+        onOpenChange={(open) => {
+          if (!open) setDialog(null);
+        }}
+      >
+        {dialog === 'cameBack' && (
+          <Suspense fallback={null}>
+            <CameBackDialog
+              order={order}
+              onDone={(saved) => afterDialog(saved, deliveredToast(t, saved))}
+            />
+          </Suspense>
+        )}
+      </Dialog>
+      <Dialog
+        open={dialog === 'receive'}
+        onOpenChange={(open) => {
+          if (!open) setDialog(null);
+        }}
+      >
+        {dialog === 'receive' && (
+          <ReceiveDialog
+            order={order}
+            onDone={(saved) =>
+              afterDialog(
+                saved,
+                t('storefront.order.returnReceived', {
+                  number: saved.orderNo,
+                  salesReturn: saved.salesReturn?.number ?? '',
+                }),
+              )
+            }
+          />
+        )}
+      </Dialog>
       <Dialog
         open={dialog === 'cancel'}
         onOpenChange={(open) => {
```

The shipped order's three buttons share the header's grid. On a phone the two secondary buttons take the first row
and the primary takes the whole second row (`col-span-2`), as the mockup showed. The step button below them skips
`deliver`, because the door buttons now carry it. The three dialogs follow the page's pattern: the `Dialog` is always
there, and its content is mounted only while it is open, so each opening starts from the order as it is now.

### The new word

```diff
@@ -6485,6 +6485,8 @@ export const en = {
         quantity: 'How many came back',
         // A serial product: one tick per serial number that left on the line
         serials: 'Serial numbers that came back',
+        // Step 28b.6 (mine 49): a ticked serial line with no serial number ticked
+        serialsNone: 'Tick the serial numbers that came back.',
         collected: 'What the rider collected',
         // amount = the parcel's codAmount, for the whole parcel
         collectedHint:
```

```diff
@@ -5948,6 +5948,7 @@ export const bn: Messages = {
         batchExpires: 'ব্যাচ {{lot}} · মেয়াদ {{date}}',
         quantity: 'কতগুলো ফেরত এসেছে',
         serials: 'যে সিরিয়াল নম্বরগুলো ফেরত এসেছে',
+        serialsNone: 'যে সিরিয়াল নম্বরগুলো ফেরত এসেছে সেগুলোতে টিক দিন।',
         collected: 'রাইডার যা নিয়েছেন',
         collectedHint:
           'ক্রেতা যা রেখেছেন তার জন্য। পুরো পার্সেলের জন্য রাইডারের নেওয়ার কথা ছিল {{amount}}। কিছু না নিলে কোনো রিসিট বানানো হয় না।',
```

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test   # 247 tests
pnpm exec eslint apps/app/src packages/i18n/src
pnpm exec prettier --check apps/app/src packages/i18n/src
```

All of these pass except the app's type check, which fails only in `src/mocks/`: the mock API's orders and courier
accounts do not have 28b's fields yet. 28b.7 adds them, with the mock's own Delivered, what came back, Receive the
return and Make the receipt, and the browser tests.

Broken on purpose, to see that the tests notice:

- `primaryDoorMove` without `returned`: "makes the button the parcel asks for the primary one" fails.
- `asksCollected` without the zero check: "asks what the rider collected only when a COD receipt will be made" fails.

The screens have not been seen in a browser yet: there is no mock data for them until 28b.7, which compares them
with the mockup.

## 28b.7 — The mock API and the browser tests

This part gives the mock API (`pnpm dev:mock` and the browser tests) the API's COD rules, so the screens of 28b.6 work
without a server, and adds the browser tests. It also fixes one bug in 28b.6's two dialogs, found by these tests.
The shop does not change: its tracking page already draws a returned parcel (26e).

Decisions made while building the mock (mine):

50. **The mock answers Steadfast's webhook.** A partly delivered or returning parcel needs news from the courier, and
    the mock had no way to get it. Seeding more orders in those states would change the counts that 28a's tests read
    on the Shipped tab. Instead, a test does what a member and Steadfast do: it makes a new webhook token on Shop
    couriers, reads the address and the token from the dialog, and posts Steadfast's own `delivery_status` body to
    that address. The mock keeps the token in plain text (the API keeps only its hash), as it already keeps the keys.
    This also tests the money read from a notice: what was collected, cut to the COD amount, and the charge.
51. **The seed's chart gets three accounts, only with the shop orders:** 1191 Cash with Steadfast and 1192 Cash with
    Pathao (each holds money), and 5420 Courier charges. Both Steadfast accounts pay into 1191; Pathao counter has none,
    so a test can pick 1192. Other tests read the chart, and they run without the shop orders, so they do not change.
52. **In the mock, the shop order moves last.** The mock's `transaction()` puts back the documents of a refused move,
    but not the shop's own rows. So every refusal (the invoice's, the collected amount's) comes before the order or
    the parcel changes. The courier's Delivered runs in a `transaction()` of its own in the handler: refused, the
    order stays Shipped and the news are kept, like the API's savepoint.
53. **Bug fixed in 28b.6's dialogs:** "The rider collects at most {{amount}} for this parcel." showed the placeholder
    itself. A `Field` shows an error code without its params. The two dialogs now write this one error out with its
    amount, as `credit-parts.tsx` writes out the credit limit's.

### The seed's types

```diff
@@ -212,8 +212,9 @@ export interface MockGateway {
 
 // Step 28a: a courier account, as the API's courier_accounts row keeps it. The mock keeps the keys
 // in plain text, as it keeps the gateway's password: it has no key to seal them with, and it never
-// answers them (storefront-shipping-data.ts → toCourierAccount). The webhook token is not kept at
-// all: the API keeps only its hash, and the mock has no courier to post with it
+// answers them (storefront-shipping-data.ts → toCourierAccount). Step 28b: the webhook token too,
+// in plain text where the API keeps only its hash: the mock's webhook (handlers.ts) compares the
+// token a test posts with, and the page still sees only whether there is one
 export interface MockCourierAccount {
   id: string;
   provider: CourierProvider;
@@ -221,7 +222,11 @@ export interface MockCourierAccount {
   courier: ShopCourier;
   // null for a manual account
   keys: { apiKey: string; secretKey: string } | null;
-  hasWebhookToken: boolean;
+  // null for a manual account
+  webhookToken: string | null;
+  // Step 28b: where the rider's cash goes, and where the courier's charges will (null = none)
+  codAccountId: string | null;
+  chargeAccountId: string | null;
   isDefault: boolean;
   archivedAt: string | null;
   lastWebhookAt: string | null;
@@ -249,6 +254,13 @@ export interface MockShipment {
   events: { status: ShopShipmentStatus; at: string; note: string | null }[];
   lastSyncedAt: string | null;
   bookUntil: string | null;
+  // Step 28b: what the rider collected and the courier's charge, as its notice said or a member
+  // typed at Delivered; the COD receipt made for it (looked up by id, like the order's documents),
+  // or why it could not be made
+  collectedAmount: string | null;
+  courierCharge: string | null;
+  receiptId: string | null;
+  receiptError: ErrorCode | null;
 }
 
 // Step 27c: a coupon as the table keeps it (storefront-coupon-data.ts has the rules). The mock has
```

A courier account keeps its webhook token and its two money accounts. A parcel keeps what was collected, the
courier's charge, and its COD receipt by id (looked up on read, like the order's other documents) or the receipt's
error.

### The receipt's method and the payment card's chart

```diff
@@ -23,6 +23,7 @@ import {
   type Receipt,
   type ReceiptAllocation,
   type ReceiptInput,
+  type ReceiptMethod,
   type RefundSourceType,
   type StockLine,
   subtractMoney,
@@ -884,10 +885,11 @@ const RECEIPT_CODES = { invoice: 'receipt_invoice_invalid', over: 'receipt_over_
 // receipt and no entry.
 // Step 27d: `fee` is the gateway's fee of a shop order paid online (the API's createForShop): the
 // money account gets what the gateway pays out, and the fee goes to its expense account, in the
-// receipt's own entry, so a void reverses the fee too
+// receipt's own entry, so a void reverses the fee too. Step 28b: and the `courier` method of a
+// delivered parcel's COD receipt, which only the API makes (the form's ReceiptInput never has it)
 export function createReceipt(
   data: WorkspaceData,
-  input: ReceiptInput,
+  input: Omit<ReceiptInput, 'method'> & { method: ReceiptMethod },
   fee: { accountId: string; amount: string } | null = null,
 ): MockReceipt {
   const customer = customerOf(data, input.customerId, null);
```

The form's `ReceiptInput` keeps the five methods people pick (28b.1). The mock's `createReceipt` takes any
`ReceiptMethod`, so the COD receipt can say `courier`. Only the mock's own code calls it with `courier`.

```diff
@@ -59,8 +59,10 @@ function notSetUp(): MockProblem {
 // The Online payment card
 
 // What the two selects offer, read like the API's chartOf(): a money account is a posting account
-// that holds money (itself or a group above it); a fee account an active expense posting account
-function chartOf(data: WorkspaceData): {
+// that holds money (itself or a group above it); a fee account an active expense posting account.
+// Step 28b: exported for a courier account's two selects, which offer the same two lists (the
+// API's courier-accounts.service.ts reads its chartOf too)
+export function chartOf(data: WorkspaceData): {
   moneyAccounts: StorefrontAccountChoice[];
   feeAccounts: StorefrontAccountChoice[];
 } {
```

`chartOf` is exported so the courier accounts offer the same two lists as the payment card, as the API's
`courier-accounts.service.ts` does with its own `chartOf`. It imports no other storefront mock file, so there is no
import cycle.

### Courier accounts: the two money accounts and what each holds

```diff
@@ -1,4 +1,5 @@
 import {
+  addMoney,
   compareMoney,
   COURIER_EXPORT_MAX_ROWS,
   COURIER_OF_PROVIDER,
@@ -12,7 +13,9 @@ import {
   type ErrorCode,
   isOpenShipment,
   routes,
+  type ShipmentStatus,
   type ShopShipmentStatus,
+  steadfastWebhookSchema,
   type StorefrontShipment,
   subtractMoney,
   sumMoney,
@@ -20,7 +23,9 @@ import {
 } from '@omnivo/contracts';
 
 import { API_URL } from '../lib/api';
+import { codeOf } from './accounting-data';
 import { MockProblem } from './mock';
+import { chartOf } from './storefront-payment-data';
 import type { MockCourierAccount, MockShipment, MockShopOrder } from './storefront-seed';
 import type { WorkspaceData } from './workspace-data';
 
@@ -31,9 +36,15 @@ import type { WorkspaceData } from './workspace-data';
 // the first time anything reads the shop's orders after that: the order page asks again every 3
 // seconds while a parcel books, so it sees the answer as it would see the worker's.
 //
-// This file imports no other storefront mock file but the seed's types, like
-// storefront-payment-data.ts: storefront-order-data.ts imports it. The audit rows are the
-// handlers' (handlers.ts).
+// This file imports no other storefront mock file but the seed's types and (step 28b) the payment
+// card's chartOf, which imports none either: storefront-order-data.ts imports it. The audit rows
+// are the handlers' (handlers.ts).
+//
+// Step 28b: the courier's money (apps/api/src/storefront/shipping/cod-receipts.ts and
+// shipment-news.ts). An account's two money accounts and what it holds; a parcel's collected
+// amount, charge and COD receipt; and the Steadfast webhook, which the mock answers so a test can
+// send the courier's news the way Steadfast sends it (courierNotice). The order's moves after the
+// news, and the COD receipt, are storefront-order-data.ts's: they make documents.
 
 // How long the pretend worker takes to book. The API's first try runs within a second or two
 export const MOCK_BOOK_MS = 2000;
@@ -126,8 +137,28 @@ function lockAccount(data: WorkspaceData, id: string, version: number): MockCour
   return account;
 }
 
+// Step 28b (decision 12): what a courier holds now, the API's holdsOf: the parcels whose COD
+// receipt is posted (a voided one went back out of the COD account), and what their riders
+// collected
+function holdsOf(data: WorkspaceData, accountId: string): CourierAccount['holds'] {
+  const held = data.storefront.orders
+    .flatMap((order) => order.shipments)
+    .filter(
+      (parcel) =>
+        parcel.accountId === accountId &&
+        parcel.receiptId !== null &&
+        data.billing.receipts.some(
+          (receipt) => receipt.id === parcel.receiptId && receipt.status === 'posted',
+        ),
+    );
+  return {
+    amount: sumMoney(held.map((parcel) => parcel.collectedAmount ?? '0')),
+    parcels: held.length,
+  };
+}
+
 // Never the keys, and never a token: only whether one is saved
-export function toCourierAccount(account: MockCourierAccount): CourierAccount {
+export function toCourierAccount(data: WorkspaceData, account: MockCourierAccount): CourierAccount {
   return {
     id: account.id,
     provider: account.provider,
@@ -138,21 +169,27 @@ export function toCourierAccount(account: MockCourierAccount): CourierAccount {
       account.provider === 'manual'
         ? null
         : `${API_URL}${routes.shipping.steadfastWebhook.path.replace(':id', account.id)}`,
-    hasWebhookToken: account.hasWebhookToken,
+    hasWebhookToken: account.webhookToken !== null,
     lastWebhookAt: account.lastWebhookAt,
     lastTest: account.lastTest,
+    codAccountId: account.codAccountId,
+    chargeAccountId: account.chargeAccountId,
+    holds: holdsOf(data, account.id),
     version: account.version,
     updatedAt: account.updatedAt,
   };
 }
 
-// The audit's view (the API's snapshot): plain values, never a key or a token
-export function courierSnapshot(account: MockCourierAccount) {
+// The audit's view (the API's snapshot): plain values, never a key or a token. Step 28b: the two
+// money accounts by their codes
+export function courierSnapshot(data: WorkspaceData, account: MockCourierAccount) {
   return {
     name: account.name,
     provider: account.provider,
     courier: account.courier,
     status: account.archivedAt === null ? 'active' : 'archived',
+    codAccount: codeOf(data.accounts, account.codAccountId),
+    chargeAccount: codeOf(data.accounts, account.chargeAccountId),
   };
 }
 
@@ -164,12 +201,36 @@ export function courierSetup(data: WorkspaceData): CourierSetup {
       a.name.localeCompare(b.name) ||
       a.id.localeCompare(b.id),
   );
+  // Step 28b: the two selects offer the payment card's two lists (decisions 2 and 3)
+  const chart = chartOf(data);
   return {
-    accounts: accounts.map(toCourierAccount),
+    accounts: accounts.map((account) => toCourierAccount(data, account)),
     defaultAccountId: accounts.find((account) => account.isDefault)?.id ?? null,
+    codAccounts: chart.moneyAccounts,
+    chargeAccounts: chart.feeAccounts,
   };
 }
 
+// Step 28b: each money account, when given, from its select's list, checked on every save (an
+// account archived since is no place for new money)
+function checkMoneyAccounts(
+  data: WorkspaceData,
+  input: { codAccountId: string | null; chargeAccountId: string | null },
+): void {
+  const chart = chartOf(data);
+  const { codAccountId, chargeAccountId } = input;
+  if (codAccountId !== null && !chart.moneyAccounts.some((row) => row.id === codAccountId)) {
+    throw new MockProblem(422, 'courier_cod_account_invalid', {
+      codAccountId: ['courier_cod_account_invalid'],
+    });
+  }
+  if (chargeAccountId !== null && !chart.feeAccounts.some((row) => row.id === chargeAccountId)) {
+    throw new MockProblem(422, 'courier_charge_account_invalid', {
+      chargeAccountId: ['courier_charge_account_invalid'],
+    });
+  }
+}
+
 // What the Packed dialog and Book courier offer the packer: active accounts by name
 export function courierChoicesOf(data: WorkspaceData): CourierChoices {
   const active = data.storefront.couriers
```

`holdsOf` is the API's rule: the parcels whose COD receipt is posted. A voided receipt took its money back out of the
COD account, so it does not count. `toCourierAccount` and `courierSnapshot` now take the workspace's data: the holds
need the receipts, and the audit names the two accounts by their codes. `checkMoneyAccounts` checks each account
against its select's list on every save, so an account archived since is refused (decision 2).

```diff
@@ -186,6 +247,7 @@ export function createCourier(
   data: WorkspaceData,
   input: CreateCourierAccountInput,
 ): { account: MockCourierAccount; saved: CourierAccountSaved } {
+  checkMoneyAccounts(data, input);
   const at = now();
   const token = input.provider === 'manual' ? null : newToken();
   const account: MockCourierAccount = {
@@ -194,7 +256,9 @@ export function createCourier(
     name: input.name,
     courier: input.provider === 'manual' ? input.courier : COURIER_OF_PROVIDER[input.provider],
     keys: input.provider === 'manual' ? null : { apiKey: input.apiKey, secretKey: input.secretKey },
-    hasWebhookToken: token !== null,
+    webhookToken: token,
+    codAccountId: input.codAccountId,
+    chargeAccountId: input.chargeAccountId,
     isDefault: false,
     archivedAt: null,
     lastWebhookAt: null,
@@ -203,7 +267,7 @@ export function createCourier(
     updatedAt: at,
   };
   data.storefront.couriers.push(account);
-  return { account, saved: { account: toCourierAccount(account), webhookToken: token } };
+  return { account, saved: { account: toCourierAccount(data, account), webhookToken: token } };
 }
 
 // An empty key box keeps the saved key. New keys clear the last test: it was about the old ones
@@ -215,6 +279,7 @@ export function updateCourier(
   const account = lockAccount(data, id, input.version);
   if (account.archivedAt !== null) throw archived();
   if (input.provider !== account.provider) throw new MockProblem(409, 'courier_provider_fixed');
+  checkMoneyAccounts(data, input);
   const before = { ...account };
   let keysChanged = false;
   if (input.provider !== 'manual') {
@@ -225,7 +290,13 @@ export function updateCourier(
   } else {
     account.courier = input.courier;
   }
-  Object.assign(account, { name: input.name, version: account.version + 1, updatedAt: now() });
+  Object.assign(account, {
+    name: input.name,
+    codAccountId: input.codAccountId,
+    chargeAccountId: input.chargeAccountId,
+    version: account.version + 1,
+    updatedAt: now(),
+  });
   return { before, after: account, keysChanged };
 }
 
@@ -246,8 +317,9 @@ export function renewCourierToken(
   const account = lockAccount(data, id, version);
   if (account.provider === 'manual') throw notBookable('id');
   if (account.archivedAt !== null) throw archived();
-  Object.assign(account, { hasWebhookToken: true, version: account.version + 1, updatedAt: now() });
-  return { account: toCourierAccount(account), webhookToken: newToken() };
+  const token = newToken();
+  Object.assign(account, { webhookToken: token, version: account.version + 1, updatedAt: now() });
+  return { account: toCourierAccount(data, account), webhookToken: token };
 }
 
 // Archived: not offered for new parcels, and no longer the default. changed is false when it was
```

The token a new account or "New webhook token" makes is kept, so the mock's webhook can compare it. The answer still
holds it only this once.

### Parcels: their money, and the step exported

```diff
@@ -302,9 +374,13 @@ export function codAmountOf(order: MockShopOrder): string {
   return compareMoney(left, '0') > 0 ? left : '0.0000';
 }
 
-// The list's "Needs attention": a packed order whose last parcel failed to book
+// The list's "Needs attention": a packed order whose last parcel failed to book. Step 28b: or a
+// parcel of any status whose COD receipt could not be made
 export function parcelNeedsAttention(order: MockShopOrder): boolean {
-  return order.status === 'packed' && order.shipments.at(-1)?.status === 'booking_failed';
+  return (
+    (order.status === 'packed' && order.shipments.at(-1)?.status === 'booking_failed') ||
+    order.shipments.some((parcel) => parcel.receiptError !== null)
+  );
 }
 
 export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): StorefrontShipment[] {
@@ -312,12 +388,22 @@ export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): Storefro
     const account = findAccount(data, parcel.accountId);
     return {
       id: parcel.id,
-      account: { id: account.id, name: account.name, provider: account.provider },
+      account: {
+        id: account.id,
+        name: account.name,
+        provider: account.provider,
+        hasCodAccount: account.codAccountId !== null,
+      },
       courier: parcel.courier,
       status: parcel.status,
       consignmentId: parcel.consignmentId,
       trackingCode: parcel.trackingCode,
       codAmount: parcel.codAmount,
+      // Step 28b
+      collectedAmount: parcel.collectedAmount,
+      courierCharge: parcel.courierCharge,
+      receipt: receiptRefOf(data, parcel.receiptId),
+      receiptError: parcel.receiptError,
       bookedAt: parcel.bookedAt,
       attempts: parcel.attempts,
       error: parcel.error,
@@ -328,7 +414,18 @@ export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): Storefro
   });
 }
 
-function step(parcel: MockShipment, status: ShopShipmentStatus, at: string, note: string | null) {
+function receiptRefOf(data: WorkspaceData, id: string | null) {
+  const receipt = id === null ? undefined : data.billing.receipts.find((item) => item.id === id);
+  return receipt === undefined ? null : { id: receipt.id, number: receipt.number };
+}
+
+// Exported for Delivered and what came back (storefront-order-data.ts), like the API's memberEvent
+export function step(
+  parcel: MockShipment,
+  status: ShopShipmentStatus,
+  at: string,
+  note: string | null,
+): void {
   parcel.events.push({ status, at, note });
 }
 
@@ -440,6 +537,10 @@ export function startShipment(
     events: [],
     lastSyncedAt: null,
     bookUntil: manual ? null : later(at, MOCK_BOOK_MS),
+    collectedAmount: null,
+    courierCharge: null,
+    receiptId: null,
+    receiptError: null,
   };
   if (manual) step(parcel, 'booked', at, null);
   order.shipments.push(parcel);
@@ -482,12 +583,13 @@ export function cancelShipments(order: MockShopOrder, at: string = now()): void
   step(open, 'cancelled', at, null);
 }
 
-// Mark shipped and Mark delivered move a parcel booked by hand with them. An API parcel moves
-// with its courier's news only
+// Mark shipped moves a parcel booked by hand with it. An API parcel moves with its courier's news
+// only. Step 28b: Mark delivered moves the parcel itself, an API one too (storefront-order-data.ts
+// → settleCod), because its COD receipt needs a delivered parcel
 export function followOrder(
   data: WorkspaceData,
   order: MockShopOrder,
-  status: 'picked_up' | 'delivered',
+  status: 'picked_up',
   at: string = now(),
 ): void {
   const open = order.shipments.find(
```

"Needs attention" also counts a parcel whose COD receipt failed, of any status (the API's `parcelNeedsAttention`).
`step` is exported for Delivered and Receive the return, like the API's `memberEvent`. `followOrder` keeps only
picked up: Mark delivered moves the parcel itself now (`settleCod`, below), an API parcel too.

### The Steadfast webhook

```diff
@@ -499,6 +601,138 @@ export function followOrder(
   step(open, status, at, null);
 }
 
+// ---------------------------------------------------------------------------------------------
+// Step 28b: the Steadfast webhook (the API's CourierWebhooks.receive and ShipmentNews.apply)
+
+// Steadfast's words and ours (the API's steadfast-adapter.ts STEADFAST_WORDS)
+const STEADFAST_WORDS: Readonly<Record<string, ShopShipmentStatus>> = {
+  in_review: 'booked',
+  pending: 'in_transit',
+  hold: 'on_hold',
+  delivered_approval_pending: 'out_for_delivery',
+  partial_delivered_approval_pending: 'out_for_delivery',
+  cancelled_approval_pending: 'returning',
+  unknown_approval_pending: 'on_hold',
+  delivered: 'delivered',
+  partial_delivered: 'partly_delivered',
+  cancelled: 'cancelled',
+  unknown: 'on_hold',
+};
+
+// Any of these means the goods left the shop, so a packed order is Shipped
+const LEFT_THE_SHOP: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
+  'picked_up',
+  'in_transit',
+  'out_for_delivery',
+  'delivered',
+  'partly_delivered',
+  'on_hold',
+  'returning',
+  'returned',
+]);
+
+// The API's courierMoney(): a number or a numeric string, to the paisa at most, else nothing
+export function courierMoney(value: unknown): string | null {
+  let text: string;
+  if (typeof value === 'number') {
+    if (!Number.isFinite(value) || value < 0 || value >= 1e13) return null;
+    text = value.toFixed(2);
+    if (Math.abs(Number(text) - value) > 1e-6) return null;
+  } else if (typeof value === 'string') {
+    text = value.trim();
+  } else {
+    return null;
+  }
+  return /^\d{1,13}(?:\.\d{1,2})?$/.test(text) ? text : null;
+}
+
+// What the order does after the news: storefront-order-data.ts moves it (Shipped, then Delivered
+// with its invoice and COD receipt), because those moves make documents
+export interface CourierNews {
+  order: MockShopOrder;
+  shipped: boolean;
+  delivered: boolean;
+}
+
+// One Steadfast notice, as the API reads it: the same 401 for an unknown account, a manual one
+// and a wrong token; a body it cannot read, or about a parcel it does not know, is answered
+// "success" and changes nothing (null). The courier's own time is not read: the mock's news are
+// always the newest step. The mock has no other workspace, so the account is the signed-in one's
+export function courierNotice(
+  data: WorkspaceData,
+  accountId: string,
+  authorization: string | null,
+  body: unknown,
+  at: string = now(),
+): CourierNews | null {
+  const token = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1] ?? null;
+  const account = data.storefront.couriers.find((item) => item.id === accountId);
+  if (
+    token === null ||
+    account === undefined ||
+    account.provider === 'manual' ||
+    account.webhookToken !== token
+  ) {
+    throw new MockProblem(401, 'courier_webhook_token_invalid');
+  }
+  account.lastWebhookAt = at;
+  const parsed = steadfastWebhookSchema.safeParse(body);
+  if (!parsed.success) return null;
+  const notice = parsed.data;
+  const consignmentId =
+    notice.consignment_id === undefined ? null : String(notice.consignment_id).trim();
+  const invoice = notice.invoice?.trim() ?? null;
+  const matches = (parcel: MockShipment) =>
+    parcel.accountId === account.id &&
+    (consignmentId !== null ? parcel.consignmentId === consignmentId : parcel.invoice === invoice);
+  const order = data.storefront.orders.find((item) => item.shipments.some(matches));
+  const parcel = order?.shipments.find(matches);
+  if (order === undefined || parcel === undefined) return null;
+  // A parcel with no code yet keeps its news raw in the API, with no step
+  const current = parcel.status;
+  if (current === 'booking' || current === 'booking_failed') return null;
+  const note = notice.tracking_message?.trim() ?? '';
+  let said: ShopShipmentStatus;
+  if (notice.notification_type?.trim().toLowerCase() === 'tracking_update') {
+    if (note === '') return null;
+    said = current;
+  } else {
+    const word = STEADFAST_WORDS[notice.status?.trim().toLowerCase() ?? ''];
+    if (word === undefined) return null;
+    // Cancelled before anyone picked it up is a cancelled booking; after, it is coming back
+    said =
+      word !== 'cancelled' || current === 'booked' || current === 'cancelled' ? word : 'returning';
+  }
+  const last = parcel.events.at(-1);
+  // The same step twice is one row (the API's event key)
+  if (last?.status !== said || last.note !== (note === '' ? null : note)) {
+    step(parcel, said, at, note === '' ? null : note);
+  }
+  parcel.lastSyncedAt = at;
+  // A cancelled or returned parcel stays where it is (0078's guard)
+  if (current === 'cancelled' || current === 'returned') {
+    return { order, shipped: false, delivered: false };
+  }
+  // The money (mine 21): the charge from any notice, what was collected only at the door, never
+  // over the COD amount, and never once the COD receipt is made
+  const collected = courierMoney(notice.cod_amount);
+  const charge = courierMoney(notice.delivery_charge);
+  const atDoor = said === 'delivered' || said === 'partly_delivered';
+  if (atDoor && collected !== null && parcel.receiptId === null) {
+    parcel.collectedAmount =
+      compareMoney(collected, parcel.codAmount) > 0 ? parcel.codAmount : addMoney(collected, '0');
+  }
+  if (charge !== null) parcel.courierCharge = addMoney(charge, '0');
+  parcel.status = said;
+  return {
+    order,
+    shipped: LEFT_THE_SHOP.has(said) && order.status === 'packed',
+    delivered: said === 'delivered',
+  };
+}
+
+// ---------------------------------------------------------------------------------------------
+
 function packedAt(order: MockShopOrder): string {
   return order.history.find((entry) => entry.status === 'packed')?.at ?? order.updatedAt;
 }
```

`courierNotice` is the API's `CourierWebhooks.receive` and `ShipmentNews.apply` in one, for the parts a test needs:

- **The same 401 for everything wrong** (an unknown account, a manual one, a wrong token), so a caller learns nothing
  about which ids exist.
- **A body it cannot read, or about a parcel it does not know, changes nothing** and is still answered "success", as
  the API does: a refusal would only make the courier send it again.
- **Steadfast's words map to ours** with the adapter's own table. `cancelled` after the rider picked the parcel up
  means it is coming back (the API's `stepStatusOf`).
- **The money (mine 21):** the charge from any notice; what was collected only from a delivered or partly delivered
  step, never more than the COD amount, and never once the parcel has its receipt. `courierMoney` is the API's
  function, so `1500.5` and `"1500.50"` read the same and `"N/A"` reads as nothing.
- **A cancelled or returned parcel stays where it is** (0078's guard), but its event is still kept.

The courier's own time is not read: the mock's news are always the newest step. The order's moves after the news
make documents, so they are in `storefront-order-data.ts`.

### The seed: the money accounts and the parcels' money

```diff
@@ -545,13 +779,16 @@ export function courierExportOf(data: WorkspaceData): CourierExport {
 // (and whose keys the fake courier does not answer, so booking with it fails and Test connection
 // says so), Pathao booked by hand at the counter, and an archived RedX account
 export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccount[] {
+  const money = seedCodAccounts(data, at);
   const account = (
     fields: Pick<MockCourierAccount, 'provider' | 'name' | 'courier' | 'keys'> &
       Partial<MockCourierAccount>,
   ): MockCourierAccount => {
     const item: MockCourierAccount = {
       id: crypto.randomUUID(),
-      hasWebhookToken: fields.provider !== 'manual',
+      webhookToken: fields.provider === 'manual' ? null : newToken(),
+      codAccountId: null,
+      chargeAccountId: null,
       isDefault: false,
       archivedAt: null,
       lastWebhookAt: null,
@@ -569,6 +806,7 @@ export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccoun
       name: 'Steadfast Dhaka',
       courier: 'steadfast',
       keys: { apiKey: 'sf7k2qd9xw', secretKey: 'sfs81mzp0c' },
+      ...money,
       isDefault: true,
       lastWebhookAt: later(now(), -25 * 60_000),
       lastTest: { at: later(now(), -26 * 60 * 60_000), problem: null },
@@ -578,6 +816,7 @@ export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccoun
       name: 'Steadfast Chattogram',
       courier: 'steadfast',
       keys: { apiKey: 'fake_unreachable', secretKey: 'sfs40ctg7q' },
+      ...money,
     }),
     account({ provider: 'manual', name: 'Pathao counter', courier: 'pathao', keys: null }),
     account({
@@ -591,14 +830,53 @@ export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccoun
   ];
 }
 
+// Step 28b: the chart's accounts for the courier's money, as the shop's accountant added them:
+// "Cash with Steadfast" and "Cash with Pathao" under the current assets (each holds money), and
+// "Courier charges" under the finance costs. Both Steadfast accounts pay into the first; Pathao
+// counter has none yet (its cash is a receipt typed by hand), so a test can pick the second
+function seedCodAccounts(
+  data: WorkspaceData,
+  at: string,
+): { codAccountId: string | null; chargeAccountId: string | null } {
+  const add = (parentCode: string, code: string, name: string, holdsMoney: boolean) => {
+    const parent = data.accounts.find((item) => item.code === parentCode);
+    if (parent === undefined) return null;
+    const id = crypto.randomUUID();
+    data.accounts.push({
+      id,
+      parentId: parent.id,
+      code,
+      name,
+      type: parent.type,
+      isGroup: false,
+      purpose: null,
+      holdsMoney,
+      description: null,
+      archivedAt: null,
+      version: 1,
+      updatedAt: at,
+    });
+    return id;
+  };
+  const steadfast = add('1100', '1191', 'Cash with Steadfast', true);
+  add('1100', '1192', 'Cash with Pathao', true);
+  const charges = add('5400', '5420', 'Courier charges', false);
+  return { codAccountId: steadfast, chargeAccountId: charges };
+}
+
 // A seeded parcel booked with an API account, with the courier's own id and code and the steps it
-// sent since (the seed's story is the real Steadfast, not the fake courier)
+// sent since (the seed's story is the real Steadfast, not the fake courier). Step 28b: and the
+// money its notices named (Steadfast's cod_amount at the door and its delivery_charge)
 export function seedParcel(
   order: MockShopOrder,
   account: MockCourierAccount,
   codes: { consignmentId: string; trackingCode: string },
   bookedAt: string,
   steps: { status: ShopShipmentStatus; at: string; note: string | null }[],
+  money: { collectedAmount: string | null; courierCharge: string | null } = {
+    collectedAmount: null,
+    courierCharge: null,
+  },
 ): MockShipment {
   const parcel: MockShipment = {
     id: crypto.randomUUID(),
@@ -616,6 +894,9 @@ export function seedParcel(
     events: [{ status: 'booked', at: bookedAt, note: null }, ...steps],
     lastSyncedAt: steps.at(-1)?.at ?? bookedAt,
     bookUntil: null,
+    ...money,
+    receiptId: null,
+    receiptError: null,
   };
   order.shipments.push(parcel);
   return parcel;
```

The three chart accounts are added inside `seedCouriers`, which runs only with the shop orders (mine 51). W-000001 was
paid online, so its rider collected ৳0, and Steadfast charged ৳60 inside Dhaka. W-000003 is still on its way, so only
its ৳130 charge is known.

### Shop orders: the list's pill and Delivered

```diff
@@ -1,15 +1,21 @@
 import {
   addMoney,
+  billableQuantity,
   type BookShipmentInput,
   compareMoney,
   compareQuantity,
   type CustomerInput,
+  type DeliverStorefrontOrderInput,
   type DocumentRef,
   type ErrorCode,
+  isOpenShipment,
   isTrackingMode,
+  isZeroMoney,
   listingPricing,
   multiplyMoney,
   type PackStorefrontOrderInput,
+  type PartlyDeliverStorefrontOrderInput,
+  type ReturnStorefrontOrderInput,
   productInputSchema,
   type SalesLineInput,
   type ShopDeliveryZone,
@@ -21,6 +27,7 @@ import {
   type StorefrontOrderSort,
   type StorefrontOrderSummary,
   type StorefrontPackPlan,
+  type StorefrontReturnPlan,
   type StorefrontSetup,
   subtractQuantity,
   sumMoney,
@@ -29,7 +36,15 @@ import {
 } from '@omnivo/contracts';
 import type { z } from 'zod';
 
-import { confirmWithCredit, postInvoice, saveInvoice } from './invoice-data';
+import {
+  allocateReceipt,
+  confirmWithCredit,
+  createReceipt,
+  dueOn,
+  findInvoice,
+  postInvoice,
+  saveInvoice,
+} from './invoice-data';
 import { MockProblem } from './mock';
 import { saveProduct } from './product-data';
 import { postReturn, saveReturn } from './return-data';
@@ -59,6 +74,7 @@ import {
   bookableAtPack,
   cancelShipments,
   codAmountOf,
+  courierNotice,
   followOrder,
   parcelNeedsAttention,
   retryShipment,
@@ -67,11 +83,13 @@ import {
   settleBookings,
   shipmentsOf,
   startShipment,
+  step,
 } from './storefront-shipping-data';
 import {
   type MockCategory,
   type MockCourierAccount,
   type MockListing,
+  type MockShipment,
   type MockShopOrder,
   type MockShopOrderLine,
   seedPhoto,
@@ -132,8 +150,10 @@ function summaryOf(order: MockShopOrder): StorefrontOrderSummary {
     paymentMethod: order.paymentMethod,
     itemCount: itemCount(order),
     total: order.total,
-    // Step 28a: or its last parcel failed to book
+    // Step 28a: or its last parcel failed to book (step 28b: or a COD receipt failed)
     needsAttention: order.documentError !== null || parcelNeedsAttention(order),
+    // Step 28b: the newest parcel's status, for the Shipped tab's second pill
+    parcelStatus: order.shipments.at(-1)?.status ?? null,
   };
 }
 
```

`parcelStatus` is the newest parcel's status, for the Shipped tab's second pill (mine 18).

```diff
@@ -713,37 +733,66 @@ export function shipShopOrder(
   return order;
 }
 
-// A posted invoice for what the challan took, at the sales order's prices, and the delivery
-// charge after it; dated that day and unpaid (the rider's cash is a money receipt)
+// What a Delivered made, for the handler's audit rows
+export interface DeliveredShopOrder {
+  order: MockShopOrder;
+  invoiceId: string;
+  receiptId: string | null;
+}
+
+// Mark delivered: a posted invoice for what the challan took, at the sales order's prices, and the
+// delivery charge after it, dated that day. Step 28b: and the rider's COD receipt for what was
+// collected (settleCod)
 export function deliverShopOrder(
   data: WorkspaceData,
   id: string,
-  version: number,
+  input: Pick<DeliverStorefrontOrderInput, 'version' | 'collectedAmount'>,
   at: string = now(),
-): { order: MockShopOrder; invoiceId: string } {
-  const order = lockShopOrder(data, id, version);
+): DeliveredShopOrder {
+  const order = lockShopOrder(data, id, input.version);
+  return { order, ...deliverIn(data, order, input.collectedAmount, null, at) };
+}
+
+// The move itself, after the lock: Mark delivered, Record what came back (`salesReturnId`: the
+// sales return of what came back, posted just before) and the courier's news. The order is moved
+// last: transaction() puts back the documents of a refused move, not the shop's own rows, so every
+// refusal (the invoice's, the collected amount's) comes before the order changes
+function deliverIn(
+  data: WorkspaceData,
+  order: MockShopOrder,
+  collected: string | null,
+  salesReturnId: string | null,
+  at: string,
+): { invoiceId: string; receiptId: string | null } {
   if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
   const salesOrder = salesOrderOf(data, order);
   const challan = findDelivery(data, order.deliveryId);
   const branchId = branchOf(data, salesOrder.warehouseId);
   if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
-  const goods = challan.lines.map((line) => {
+  // Step 28b: what did not come back before the invoice (the invoice's own rule, 15d); a line
+  // that came back whole is not billed. The mock's shop orders have no coupon, so no discount
+  const goods = challan.lines.flatMap((line) => {
     const soLine = salesOrder.lines.find((item) => item.id === line.orderLineId);
     if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
-    return {
-      variantId: line.variantId,
-      unitId: line.unitId,
-      quantity: line.quantity,
-      description: soLine.description,
-      unitPrice: soLine.unitPrice,
-      discountType: 'amount' as const,
-      discount: '0',
-      taxRateId: soLine.taxRate.id,
-      deliveryLineId: line.id,
-      orderLineId: null,
-      batchId: null,
-      serialNumbers: [],
-    };
+    const kept = billableQuantity(line);
+    if (compareQuantity(kept, '0') <= 0) return [];
+    return [
+      {
+        variantId: line.variantId,
+        unitId: line.unitId,
+        // A shop's challan is in the base unit, so what is kept is the line's quantity
+        quantity: compareQuantity(kept, line.baseQuantity) === 0 ? line.quantity : kept,
+        description: soLine.description,
+        unitPrice: soLine.unitPrice,
+        discountType: 'amount' as const,
+        discount: '0',
+        taxRateId: soLine.taxRate.id,
+        deliveryLineId: line.id,
+        orderLineId: null,
+        batchId: null,
+        serialNumbers: [],
+      },
+    ];
   });
   const charges = salesOrder.lines.slice(order.lines.length).map((soLine) => ({
     variantId: soLine.variantId,
```

`deliverIn` is the move after the lock, used by Mark delivered, Record what came back and the courier's news, as the
API's `ShopOrderMoves.deliver` is. A line bills what did not come back before the invoice (`billableQuantity`), and a
line that came back whole is not billed. The mock's shop orders have no coupon, so there is no discount to share
out. The order moves last (mine 52).

### The COD receipt, what came back, and the courier's news

```diff
@@ -771,11 +820,344 @@ export function deliverShopOrder(
   });
   // Never over the limit: it moves the amount from "on order" to "owed" and adds nothing
   postInvoice(data, draft, false);
-  move(order, 'delivered', at, { invoiceId: draft.id });
-  followOrder(data, order, 'delivered', at);
   // Step 27d (decision 6): the invoice takes the advances of the paid tries
   applyPaymentsToInvoice(data, order, draft.id);
-  return { order, invoiceId: draft.id };
+  // Step 28b: then the rider's money, which pays what the advances left
+  const receiptId = settleCod(
+    data,
+    order,
+    draft.id,
+    collected,
+    salesReturnId === null ? 'delivered' : 'partly_delivered',
+    at,
+  );
+  move(order, 'delivered', at, {
+    invoiceId: draft.id,
+    ...(salesReturnId === null ? {} : { salesReturnId }),
+  });
+  return { invoiceId: draft.id, receiptId };
+}
+
+// ---------------------------------------------------------------------------------------------
+// Step 28b: the COD receipt (the API's cod-receipts.ts)
+
+// The parcel the courier took to the door: the newest one not still booking or failed, not a
+// cancelled booking, and not one received back
+function doorParcelOf(order: MockShopOrder): MockShipment | undefined {
+  const skip = ['booking', 'booking_failed', 'cancelled', 'returned'];
+  return order.shipments.toReversed().find((parcel) => !skip.includes(parcel.status));
+}
+
+// What the rider collected goes on the parcel, and a posted receipt for it into the courier
+// account's COD account, paying the invoice. The amount: what was typed, else what the courier
+// said, else (a whole delivery) the parcel's codAmount. A receipt the books refuse is kept on the
+// parcel as its error and rings the bell: the Delivered stays (the API's savepoint)
+function settleCod(
+  data: WorkspaceData,
+  order: MockShopOrder,
+  invoiceId: string,
+  typed: string | null,
+  door: 'delivered' | 'partly_delivered',
+  at: string,
+): string | null {
+  const parcel = doorParcelOf(order);
+  // No parcel at the door (undefined !== null too), or one that has its receipt already
+  if (parcel?.receiptId !== null) return null;
+  const account = data.storefront.couriers.find((item) => item.id === parcel.accountId);
+  const codAccountId = account?.codAccountId ?? null;
+  const collected =
+    typed ?? parcel.collectedAmount ?? (door === 'delivered' ? parcel.codAmount : null);
+  if (collected === null && codAccountId !== null) {
+    throw new MockProblem(422, 'storefront_order_collected_required', {
+      collectedAmount: ['storefront_order_collected_required'],
+    });
+  }
+  if (collected !== null && compareMoney(collected, parcel.codAmount) > 0) {
+    throw new MockProblem(
+      422,
+      'storefront_order_collected_over',
+      { collectedAmount: ['storefront_order_collected_over'] },
+      { amount: parcel.codAmount },
+    );
+  }
+  // The parcel follows the order: a manual one always, an API one whose news is late
+  if (isOpenShipment(parcel.status)) {
+    parcel.status = door;
+    step(parcel, door, at, null);
+  }
+  parcel.collectedAmount = collected === null ? null : addMoney(collected, '0');
+  if (account === undefined || codAccountId === null || collected === null) return null;
+  if (isZeroMoney(collected)) return null;
+  try {
+    return makeCodReceiptIn(data, order, parcel, invoiceId, at);
+  } catch (error) {
+    if (!(error instanceof MockProblem)) throw error;
+    parcel.receiptError = error.code;
+    data.notifications.unshift({
+      id: crypto.randomUUID(),
+      type: 'storefront.cod_receipt_failed',
+      params: { id: order.id, number: order.orderNo, courier: account.name },
+      readAt: null,
+      createdAt: at,
+    });
+    return null;
+  }
+}
+
+// The receipt (the API's make): the sales order's customer and branch, the COD account the
+// courier account names now, the courier's code as the reference (its payout lists it), then as
+// much of it as the invoice still owes. Throws the receipt's own refusal
+function makeCodReceiptIn(
+  data: WorkspaceData,
+  order: MockShopOrder,
+  parcel: MockShipment,
+  invoiceId: string,
+  at: string,
+): string {
+  const account = data.storefront.couriers.find((item) => item.id === parcel.accountId);
+  if (account?.codAccountId == null || parcel.collectedAmount === null) {
+    throw new MockProblem(409, 'receipt_account_invalid');
+  }
+  const salesOrder = salesOrderOf(data, order);
+  const branchId = branchOf(data, salesOrder.warehouseId);
+  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
+  const receipt = createReceipt(data, {
+    customerId: salesOrder.customer.id,
+    date: dayOf(data, at),
+    amount: parcel.collectedAmount,
+    accountId: account.codAccountId,
+    method: 'courier',
+    reference: (parcel.trackingCode ?? parcel.invoice).slice(0, 60),
+    branchId,
+    note: `COD for shop order ${order.orderNo} (${account.name} ${parcel.invoice})`,
+    allocations: [],
+  });
+  parcel.receiptId = receipt.id;
+  parcel.receiptError = null;
+  // More than is owed stays an advance; less leaves the invoice partly paid
+  const due = dueOn(data, findInvoice(data, invoiceId));
+  if (compareMoney(due, '0') > 0) {
+    const amount = compareMoney(receipt.amount, due) < 0 ? receipt.amount : due;
+    allocateReceipt(data, receipt, [{ invoiceId, amount }]);
+  }
+  return receipt.id;
+}
+
+// "Make the receipt" on a parcel whose COD receipt was refused. The handler calls it outside
+// transaction(): a refusal again is kept on the parcel and still answered
+export function makeShopCodReceipt(
+  data: WorkspaceData,
+  id: string,
+  shipmentId: string,
+  version: number,
+  at: string = now(),
+): { order: MockShopOrder; receiptId: string } {
+  const order = lockShopOrder(data, id, version);
+  const parcel = order.shipments.find((item) => item.id === shipmentId);
+  if (
+    parcel?.receiptError == null ||
+    parcel.receiptId !== null ||
+    parcel.collectedAmount === null ||
+    order.invoiceId === null
+  ) {
+    throw new MockProblem(409, 'storefront_cod_receipt_not_failed');
+  }
+  try {
+    const receiptId = makeCodReceiptIn(data, order, parcel, order.invoiceId, at);
+    Object.assign(order, { version: order.version + 1, updatedAt: at });
+    return { order, receiptId };
+  } catch (error) {
+    if (error instanceof MockProblem) parcel.receiptError = error.code;
+    throw error;
+  }
+}
+
+// ---------------------------------------------------------------------------------------------
+// Step 28b: what came back (decisions 6 and 7)
+
+// The challan's lines as the return plan shows them, each with the shop order line it was packed
+// for (the sales order's line i is the order's line i, the maker's rule)
+function challanLinesOf(data: WorkspaceData, order: MockShopOrder) {
+  if (order.deliveryId === null) throw stepInvalid();
+  const salesOrder = salesOrderOf(data, order);
+  const challan = findDelivery(data, order.deliveryId);
+  return {
+    challan,
+    lines: challan.lines.map((line) => {
+      const index = salesOrder.lines.findIndex((item) => item.id === line.orderLineId);
+      const ordered = order.lines[index];
+      if (ordered === undefined) throw new Error(`Challan line ${line.id} has no shop order line`);
+      return { line, ordered };
+    }),
+  };
+}
+
+export function returnPlanOf(data: WorkspaceData, id: string): StorefrontReturnPlan {
+  const order = findShopOrder(data, id);
+  if (order.status !== 'shipped') throw stepInvalid();
+  const { challan, lines } = challanLinesOf(data, order);
+  const warehouse = data.stock.warehouses.find((place) => place.id === challan.warehouseId);
+  if (!warehouse) throw new Error(`Warehouse ${challan.warehouseId} is missing`);
+  return {
+    warehouse: { id: warehouse.id, name: warehouse.name },
+    lines: lines.map(({ line, ordered }) => {
+      const { product, variant, unitCode } = variantOf(data, ordered);
+      return {
+        deliveryLineId: line.id,
+        position: ordered.position,
+        name: ordered.name,
+        packSize: ordered.packSize,
+        sku: variant.sku,
+        unitCode,
+        quantity: billableQuantity(line),
+        tracking: isTrackingMode(product.tracking) ? product.tracking : 'none',
+        batch:
+          line.lotNumber === null ? null : { lotNumber: line.lotNumber, expiresOn: line.expiresOn },
+        serialNumbers: line.serialNumbers,
+      };
+    }),
+  };
+}
+
+// What "Record what came back" and "Receive the return" made, for the audit rows
+export interface CameBackShopOrder {
+  order: MockShopOrder;
+  salesReturnId: string;
+  salesOrderId: string | null;
+}
+
+// A posted sales return of what came back, dated that day, into the warehouse the goods left from
+function returnOf(
+  data: WorkspaceData,
+  order: MockShopOrder,
+  lines: { deliveryLineId: string; quantity: string; serialNumbers: string[] }[],
+  note: string | null,
+  at: string,
+): string {
+  const { challan } = challanLinesOf(data, order);
+  const draft = saveReturn(data, {
+    customerId: challan.customer.id,
+    date: dayOf(data, at),
+    warehouseId: challan.warehouseId,
+    reason: 'other',
+    note,
+    lines: lines.map((back) => {
+      const line = challan.lines.find((item) => item.id === back.deliveryLineId);
+      if (line === undefined) throw new Error(`Challan line ${back.deliveryLineId} is missing`);
+      return {
+        variantId: line.variantId,
+        unitId: line.unitId,
+        quantity: back.quantity,
+        batchId: line.batchId,
+        serialNumbers: back.serialNumbers,
+        deliveryLineId: line.id,
+      };
+    }),
+  });
+  postReturn(data, draft);
+  return draft.id;
+}
+
+// Record what came back (decision 6): the sales return of the ticked lines, in the dialog's order
+// (its errors land under the dialog's rows), then Delivered with the invoice of the rest and the
+// COD receipt, then the sales order closed. Every piece back is Receive the return
+export function partlyDeliverShopOrder(
+  data: WorkspaceData,
+  id: string,
+  input: PartlyDeliverStorefrontOrderInput,
+  at: string = now(),
+): CameBackShopOrder & { invoiceId: string; receiptId: string | null } {
+  const order = lockShopOrder(data, id, input.version);
+  if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
+  const { lines } = challanLinesOf(data, order);
+  const fieldErrors: Record<string, ErrorCode[]> = {};
+  input.lines.forEach((line, index) => {
+    if (!lines.some((item) => item.line.id === line.deliveryLineId)) {
+      fieldErrors[`lines.${String(index)}.deliveryLineId`] = ['storefront_order_line_missing'];
+    }
+  });
+  if (Object.keys(fieldErrors).length > 0) {
+    throw new MockProblem(409, 'storefront_order_line_missing', fieldErrors);
+  }
+  const back = new Map(input.lines.map((line) => [line.deliveryLineId, line.quantity]));
+  if (
+    lines.every(
+      ({ line }) => compareQuantity(back.get(line.id) ?? '0', billableQuantity(line)) >= 0,
+    )
+  ) {
+    throw new MockProblem(409, 'storefront_order_return_everything');
+  }
+  const salesReturnId = returnOf(data, order, input.lines, input.reason, at);
+  const delivered = deliverIn(data, order, input.collectedAmount, salesReturnId, at);
+  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
+  if (salesOrder) changeOrderStatus(data, salesOrder, 'close');
+  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null, ...delivered };
+}
+
+// Receive the return (decision 7): a sales return of the whole challan, the sales order cancelled,
+// the parcel returned, the order Returned. The SMS to the shopper is the API's: the mock sends none
+export function returnShopOrder(
+  data: WorkspaceData,
+  id: string,
+  input: ReturnStorefrontOrderInput,
+  at: string = now(),
+): CameBackShopOrder {
+  const order = lockShopOrder(data, id, input.version);
+  if (order.status !== 'shipped') throw stepInvalid();
+  const { lines } = challanLinesOf(data, order);
+  const salesReturnId = returnOf(
+    data,
+    order,
+    lines.map(({ line }) => ({
+      deliveryLineId: line.id,
+      quantity: billableQuantity(line),
+      serialNumbers: line.serialNumbers,
+    })),
+    input.reason,
+    at,
+  );
+  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
+  if (salesOrder) changeOrderStatus(data, salesOrder, 'cancel');
+  // The parcel the courier had, unless it says returned already
+  const parcel = order.shipments
+    .toReversed()
+    .find((item) => !['booking', 'booking_failed', 'cancelled'].includes(item.status));
+  if (parcel !== undefined && parcel.status !== 'returned') {
+    parcel.status = 'returned';
+    step(parcel, 'returned', at, null);
+  }
+  move(order, 'returned', at, { salesReturnId });
+  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null };
+}
+
+// ---------------------------------------------------------------------------------------------
+// Step 28b: the courier's news (storefront-shipping-data.ts reads the notice)
+
+// The order follows the parcel: Shipped once the goods left. `deliver` says the courier delivered
+// it: the handler then runs courierDeliver in a transaction() of its own, the API's savepoint
+export function shopCourierNews(
+  data: WorkspaceData,
+  accountId: string,
+  authorization: string | null,
+  body: unknown,
+  at: string = now(),
+): { order: MockShopOrder; shipped: boolean; deliver: boolean } | null {
+  const news = courierNotice(data, accountId, authorization, body, at);
+  if (news === null) return null;
+  const { order } = news;
+  if (news.shipped) move(order, 'shipped', at);
+  return { order, shipped: news.shipped, deliver: news.delivered && order.status === 'shipped' };
+}
+
+// The courier's Delivered: the invoice and the COD receipt for what its notice said. A Delivered
+// the books refuse leaves the order Shipped (the handler's transaction() puts its documents
+// back), and Mark delivered then shows why
+export function courierDeliver(
+  data: WorkspaceData,
+  order: MockShopOrder,
+  at: string = now(),
+): { invoiceId: string; receiptId: string | null } {
+  return deliverIn(data, order, null, null, at);
 }
 
 export interface CancelledShopOrder {
```

**`settleCod`** follows the API's `ShopCodReceipts.settle` step by step:

1. the parcel at the door, or nothing to do;
2. the amount: what was typed, else what the courier said, else (a whole delivery) the COD amount;
3. the two refusals, before anything changes;
4. the parcel follows the order when it is still open;
5. no receipt with no COD account or nothing collected;
6. the receipt, where a refusal is kept on the parcel and rings the bell, and the Delivered stays.

`makeCodReceiptIn` reads the COD account the courier account names *now*, so "Make the receipt" works once a member
points the account at an active one. It applies only as much as the invoice still owes, so a rider who collected
more leaves an advance.

**`makeShopCodReceipt`** is "Make the receipt". The handler calls it outside `transaction()`, so a refusal again stays
on the parcel, as "Make the sales order" keeps its error.

**`returnPlanOf`, `partlyDeliverShopOrder` and `returnShopOrder`** follow the API's service. A challan line finds its
shop order line through the sales order's line (the maker's rule: line i is line i). The sales return of what came
back is posted before the invoice, in the dialog's order, so the return's own field errors land under the dialog's
rows. A partly delivered order's sales order is closed; a returned order's is cancelled.

**`shopCourierNews`** moves a packed order to Shipped once the goods left. `courierDeliver` is the courier's Delivered,
which the handler runs in its own `transaction()` (mine 52).

```diff
@@ -1295,7 +1677,12 @@ export function seedShopOrders(data: WorkspaceData): void {
 
   packAsPlanned(data, delivered, after(delivered, 90));
   shipShopOrder(data, delivered.id, delivered.version, after(delivered, 180));
-  deliverShopOrder(data, delivered.id, delivered.version, after(delivered, days(1)));
+  deliverShopOrder(
+    data,
+    delivered.id,
+    { version: delivered.version, collectedAmount: null },
+    after(delivered, days(1)),
+  );
   cancelShopOrder(
     data,
     cancelled.id,
@@ -1321,6 +1708,8 @@ export function seedShopOrders(data: WorkspaceData): void {
       { status: 'out_for_delivery', at: after(delivered, days(1) - 150), note: null },
       { status: 'delivered', at: after(delivered, days(1)), note: null },
     ],
+    // Step 28b: paid online, so the rider collected nothing; Steadfast's charge inside Dhaka
+    { collectedAmount: '0.0000', courierCharge: '60.0000' },
   );
   seedParcel(
     shipped,
@@ -1331,6 +1720,8 @@ export function seedShopOrders(data: WorkspaceData): void {
       { status: 'picked_up', at: after(shipped, 240), note: 'Picked up from Rahman Fashion' },
       { status: 'in_transit', at: after(shipped, 600), note: 'Reached the Chattogram hub' },
     ],
+    // Step 28b: outside Dhaka, Steadfast charges more; nothing collected yet
+    { collectedAmount: null, courierCharge: '130.0000' },
   );
 
   // The bell of the newest order that is not refused, unread (27a's handler rings it)
```

The seed's delivered order now passes the input the new `deliverShopOrder` takes, and its two parcels get their
money.

### The handlers

```diff
@@ -220,16 +220,22 @@ import {
 } from './storefront-coupon-data';
 import {
   cancelShopOrder,
+  courierDeliver,
   deliverShopOrder,
   findShopOrder,
   bookShopOrder,
   type MadeSalesOrder,
+  makeShopCodReceipt,
   makeShopPaymentReceipt,
   packPlanOf,
   packShopOrder,
+  partlyDeliverShopOrder,
   retrySalesOrder,
   retryShopParcel,
+  returnPlanOf,
+  returnShopOrder,
   shipShopOrder,
+  shopCourierNews,
   shopOrderCounts,
   shopOrderPage,
   toShopOrder,
@@ -567,6 +573,13 @@ function recordShopMove(
   );
 }
 
+// Step 28b: a Delivered's documents: the invoice, and the COD receipt when one was made
+function recordDelivered(data: WorkspaceData, invoiceId: string, receiptId: string | null): void {
+  record(data, 'invoice.created', 'invoice', invoiceId);
+  record(data, 'invoice.posted', 'invoice', invoiceId);
+  if (receiptId !== null) record(data, 'receipt.created', 'receipt', receiptId);
+}
+
 // What making a shop order's sales order writes in the audit log: the customer and the "Delivery
 // charge" service when they were made, the sales order, the credit override, and the link
 function recordSalesOrderMade(
```

`recordDelivered` writes a Delivered's audit rows: the invoice, and the COD receipt when one was made.

```diff
@@ -6260,17 +6273,111 @@ export const handlers = [
     }),
   ),
 
+  // Step 28b: the moves at the shopper's door have their own route group (the contract's TS7056
+  // note). Delivered makes the rider's COD receipt too, when the parcel's account has a COD account
   mock(
-    routes.storefrontOrders.deliverOrder,
+    routes.storefrontOrderDeliveries.deliverOrder,
     guarded(async ({ request, params }) => {
-      const data = shopOrderData(routes.storefrontOrders.deliverOrder.permission);
-      const { id } = routes.storefrontOrders.deliverOrder.params.parse(params);
-      const { version } = await readBody(routes.storefrontOrders.deliverOrder.body, request);
-      const { order, invoiceId } = transaction(data, () => deliverShopOrder(data, id, version));
-      record(data, 'invoice.created', 'invoice', invoiceId);
-      record(data, 'invoice.posted', 'invoice', invoiceId);
+      const data = shopOrderData(routes.storefrontOrderDeliveries.deliverOrder.permission);
+      const { id } = routes.storefrontOrderDeliveries.deliverOrder.params.parse(params);
+      const body = await readBody(routes.storefrontOrderDeliveries.deliverOrder.body, request);
+      const { order, invoiceId, receiptId } = transaction(data, () =>
+        deliverShopOrder(data, id, body),
+      );
+      recordDelivered(data, invoiceId, receiptId);
       recordShopMove(data, 'storefront_order.delivered', order, 'shipped');
-      return reply(routes.storefrontOrders.deliverOrder, toShopOrder(data, order));
+      return reply(routes.storefrontOrderDeliveries.deliverOrder, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrderDeliveries.getReturnPlan,
+    guarded(async ({ params }) => {
+      const data = shopOrderData(routes.storefrontOrderDeliveries.getReturnPlan.permission);
+      const { id } = routes.storefrontOrderDeliveries.getReturnPlan.params.parse(params);
+      await delay();
+      return reply(routes.storefrontOrderDeliveries.getReturnPlan, returnPlanOf(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrderDeliveries.partlyDeliverOrder,
+    guarded(async ({ request, params }) => {
+      const route = routes.storefrontOrderDeliveries.partlyDeliverOrder;
+      const data = shopOrderData(route.permission);
+      const { id } = route.params.parse(params);
+      const body = await readBody(route.body, request);
+      const made = transaction(data, () => partlyDeliverShopOrder(data, id, body));
+      record(data, 'sales_return.created', 'sales_return', made.salesReturnId);
+      record(data, 'sales_return.posted', 'sales_return', made.salesReturnId);
+      recordDelivered(data, made.invoiceId, made.receiptId);
+      if (made.salesOrderId !== null) {
+        record(data, 'sales_order.closed', 'sales_order', made.salesOrderId);
+      }
+      record(
+        data,
+        'storefront_order.partly_delivered',
+        'storefront_order',
+        made.order.id,
+        diff(
+          { order: made.order.orderNo, status: 'shipped' },
+          {
+            order: made.order.orderNo,
+            status: 'delivered',
+            cameBack: body.lines.length,
+            reason: body.reason,
+          },
+        ),
+      );
+      return reply(route, toShopOrder(data, made.order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrderDeliveries.returnOrder,
+    guarded(async ({ request, params }) => {
+      const route = routes.storefrontOrderDeliveries.returnOrder;
+      const data = shopOrderData(route.permission);
+      const { id } = route.params.parse(params);
+      const body = await readBody(route.body, request);
+      const made = transaction(data, () => returnShopOrder(data, id, body));
+      record(data, 'sales_return.created', 'sales_return', made.salesReturnId);
+      record(data, 'sales_return.posted', 'sales_return', made.salesReturnId);
+      if (made.salesOrderId !== null) {
+        record(data, 'sales_order.cancelled', 'sales_order', made.salesOrderId);
+      }
+      record(
+        data,
+        'storefront_order.returned',
+        'storefront_order',
+        made.order.id,
+        diff(
+          { order: made.order.orderNo, status: 'shipped' },
+          { order: made.order.orderNo, status: 'returned', reason: body.reason },
+        ),
+      );
+      return reply(route, toShopOrder(data, made.order));
+    }),
+  ),
+
+  // Not in transaction(): a refusal is kept on the parcel (its receiptError) and still answered
+  mock(
+    routes.storefrontOrderDeliveries.makeCodReceipt,
+    guarded(async ({ request, params }) => {
+      const route = routes.storefrontOrderDeliveries.makeCodReceipt;
+      const data = shopOrderData(route.permission);
+      const { id, shipmentId } = route.params.parse(params);
+      const { version } = await readBody(route.body, request);
+      const { order, receiptId } = makeShopCodReceipt(data, id, shipmentId, version);
+      record(data, 'receipt.created', 'receipt', receiptId);
+      record(
+        data,
+        'storefront_order.cod_receipt_made',
+        'storefront_order',
+        order.id,
+        diff({}, { order: order.orderNo }),
+      );
+      return reply(route, toShopOrder(data, order));
     }),
   ),
 
```

The door's routes come from their own route group (28b.1's TS7056 note). Each move runs in `transaction()`, except
"Make the receipt" (above). The audit rows are the API's: the documents, then the order's own row, with how many lines
came back and why.

```diff
@@ -6372,7 +6479,7 @@ export const handlers = [
         diff(
           {},
           {
-            ...courierSnapshot(account),
+            ...courierSnapshot(data, account),
             ...(account.provider === 'manual' ? {} : { keys: 'changed', webhookToken: 'changed' }),
           },
         ),
@@ -6389,10 +6496,10 @@ export const handlers = [
       const body = await readBody(routes.shipping.updateCourier.body, request);
       const { before, after, keysChanged } = updateCourier(data, id, body);
       record(data, 'courier_account.updated', 'courier_account', id, {
-        ...diff(courierSnapshot(before), courierSnapshot(after)),
+        ...diff(courierSnapshot(data, before), courierSnapshot(data, after)),
         ...(keysChanged ? { keys: { from: null, to: 'changed' } } : {}),
       });
-      return reply(routes.shipping.updateCourier, toCourierAccount(after));
+      return reply(routes.shipping.updateCourier, toCourierAccount(data, after));
     }),
   ),
 
@@ -6411,7 +6518,7 @@ export const handlers = [
         id,
         diff({}, { testResult: account.lastTest?.problem ?? 'ok' }),
       );
-      return reply(routes.shipping.testCourier, toCourierAccount(account));
+      return reply(routes.shipping.testCourier, toCourierAccount(data, account));
     }),
   ),
 
@@ -6442,10 +6549,10 @@ export const handlers = [
           'courier_account.archived',
           'courier_account',
           id,
-          diff(courierSnapshot(before), courierSnapshot(after)),
+          diff(courierSnapshot(data, before), courierSnapshot(data, after)),
         );
       }
-      return reply(routes.shipping.archiveCourier, toCourierAccount(after));
+      return reply(routes.shipping.archiveCourier, toCourierAccount(data, after));
     }),
   ),
 
@@ -6462,10 +6569,10 @@ export const handlers = [
           'courier_account.restored',
           'courier_account',
           id,
-          diff(courierSnapshot(before), courierSnapshot(after)),
+          diff(courierSnapshot(data, before), courierSnapshot(data, after)),
         );
       }
-      return reply(routes.shipping.restoreCourier, toCourierAccount(after));
+      return reply(routes.shipping.restoreCourier, toCourierAccount(data, after));
     }),
   ),
 
```

The courier account calls pass the data, for the holds and the account codes.

```diff
@@ -6484,6 +6591,38 @@ export const handlers = [
     }),
   ),
 
+  // Step 28b: Steadfast's webhook, no login: the account's id in the address and its token in the
+  // Authorization header (the mock keeps the token plain, storefront-seed.ts). A test posts the
+  // courier's news here the way Steadfast posts them. Like the API, a body it cannot read or
+  // about a parcel it does not know is "success" too. The courier's Delivered runs in a
+  // transaction() of its own: refused, the order stays Shipped and the news are kept
+  mock(
+    routes.shipping.steadfastWebhook,
+    guarded(async ({ request, params }) => {
+      const data = current();
+      const { id } = routes.shipping.steadfastWebhook.params.parse(params);
+      const body: unknown = await request.json().catch(() => null);
+      const news = shopCourierNews(data, id, request.headers.get('authorization'), body);
+      if (news !== null) {
+        const { order } = news;
+        if (news.shipped) recordShopMove(data, 'storefront_order.shipped', order, 'packed');
+        if (news.deliver) {
+          try {
+            const made = transaction(data, () => courierDeliver(data, order));
+            recordDelivered(data, made.invoiceId, made.receiptId);
+            recordShopMove(data, 'storefront_order.delivered', order, 'shipped');
+          } catch (error) {
+            if (!(error instanceof MockProblem)) throw error;
+          }
+        }
+      }
+      return reply(routes.shipping.steadfastWebhook, {
+        status: 'success',
+        message: 'Webhook received',
+      });
+    }),
+  ),
+
   // --- Step 27d: the Online payment card (storefront-payment-data.ts) ---------------------------
   // storefront.manage, like the shop's settings. The audit rows never hold the password: a new
   // one is written as "changed" (the API's snapshot)
```

The webhook has no login, like the public document page. Its body is read as `unknown` and never refused for its
shape (`courierNotice` reads it). The account is looked up in the signed-in workspace: the mock has no other
workspace with couriers.

### The fix in the two dialogs

```diff
@@ -19,7 +19,7 @@ import {
 } from '@omnivo/ui';
 import { useForm } from 'react-hook-form';
 
-import { call } from '../lib/api';
+import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { asksCollected, collectedStart, doorParcel } from '../lib/storefront-orders';
 import { DocumentNotice } from './document-notice';
@@ -51,6 +51,11 @@ export function deliveredToast(
 
 const DELIVER_FIELDS = ['collectedAmount'] as const;
 
+// The API refused the amount as more than the parcel's COD amount (both door dialogs)
+export function collectedOver(error: unknown): boolean {
+  return error instanceof ApiRequestError && error.code === 'storefront_order_collected_over';
+}
+
 // Mark delivered (decisions 4 and 5, mine 41). Three bodies: a COD receipt will be made (the box
 // asks what the rider collected), the order was paid online (the invoice takes that receipt), or
 // neither (the invoice stays unpaid, 27b's words). The box starts with what the courier said, else
@@ -62,7 +67,7 @@ export function DeliverDialog({
   order: StorefrontOrder;
   onDone: (saved: StorefrontOrder) => Promise<void>;
 }) {
-  const { t } = useLocale();
+  const { t, errorText } = useLocale();
   const money = useShopMoney();
   const door = doorParcel(order);
   const asks = asksCollected(door);
@@ -91,6 +96,14 @@ export function DeliverDialog({
       await onDone(saved);
     } catch (error) {
       applyApiError(error, DELIVER_FIELDS, setError);
+      // Its words name the parcel's COD amount, and a field shows a code without its params
+      // ("at most {{amount}}", found by storefront-cod.e2e.ts): written out here, as
+      // credit-parts.tsx writes out the credit limit's
+      if (collectedOver(error) && door !== null) {
+        setError('collectedAmount', {
+          message: errorText('storefront_order_collected_over', { amount: money(door.codAmount) }),
+        });
+      }
     }
   });
 
```

```diff
@@ -42,6 +42,7 @@ import {
   storefrontReturnPlanQuery,
 } from '../lib/storefront-orders';
 import { useTenantId } from '../lib/workspace';
+import { collectedOver } from './storefront-order-door';
 import { useShopMoney } from './storefront-parts';
 
 // Step 28b.6: "Record what came back" (decision 6, approved with the mockup), a chunk of its own,
@@ -118,7 +119,7 @@ function CameBackForm({
   plan: StorefrontReturnPlan;
   onDone: (saved: StorefrontOrder) => Promise<void>;
 }) {
-  const { t } = useLocale();
+  const { t, errorText } = useLocale();
   const money = useShopMoney();
   const door = doorParcel(order);
   const asks = asksCollected(door);
@@ -212,7 +213,16 @@ function CameBackForm({
         const fieldErrors = Object.entries(error.problem.fieldErrors ?? {}).flatMap(
           ([path, codes]) => (codes[0] === undefined ? [] : [[path, codes[0]] as const]),
         );
-        setErrors(fieldErrors.length > 0 ? Object.fromEntries(fieldErrors) : { '': error.code });
+        const found: Errors =
+          fieldErrors.length > 0 ? Object.fromEntries(fieldErrors) : { '': error.code };
+        // Written out with its amount, as Mark delivered does (storefront-order-door.tsx): the
+        // Field shows a code without its params
+        if (collectedOver(error) && door !== null) {
+          found.collectedAmount = errorText('storefront_order_collected_over', {
+            amount: money(door.codAmount),
+          });
+        }
+        setErrors(found);
       }
     } finally {
       setSending(false);
```

`applyApiError` puts the code `storefront_order_collected_over` under the box, and `Field` translates a code without
params, so the words showed "{{amount}}" (mine 53). The page knows the amount (the door parcel's `codAmount`), so it
writes the error out with `errorText` and the formatted amount. `Field` shows text that is not a code as it is. The
trade-off: a language change while the error shows does not change it until the next try. `collectedOver` lives in
the door file, which loads with the order page, so the lazy came-back chunk reuses it at no cost.

### The browser tests

```ts
import type { Page } from '@playwright/test';

import { expect, expectNoSideScroll, listItem, openFromNav, test, toastShown } from './helpers.js';

// Step 28b: the courier's COD money on the mock (mocks/storefront-order-data.ts → settleCod).
// Rahman Fashion's two Steadfast accounts pay the riders' cash into 1191 Cash with Steadfast, and
// their charges go to 5420 Courier charges; Pathao counter has no COD account yet. W-000003 is on
// its way to Chattogram with Steadfast Dhaka (consignment 148920331), Cash on Delivery. The
// courier's news are sent to the mock's Steadfast webhook the way Steadfast sends them, with the
// token the "New webhook token" dialog shows once. Moving between pages goes through the menu: a
// reload starts the mock again.
test.use({ shopOrders: true });

const W3_CONSIGNMENT = '148920331';

interface Hook {
  url: string;
  token: string;
}

// An account's row (a card on a phone), as in storefront-couriers.e2e.ts
function accountRow(page: Page, name: string) {
  const start = new RegExp(`^${name}`);
  return page.getByRole('row', { name: start }).or(page.getByRole('button', { name: start }));
}

async function rowAction(page: Page, account: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${account}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

// Steadfast Dhaka's webhook address and a new token, read from the dialog that shows them once
async function steadfastHook(page: Page): Promise<Hook> {
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Dhaka', 'New webhook token');
  await page
    .getByRole('dialog', { name: 'Make a new webhook token for Steadfast Dhaka?' })
    .getByRole('button', { name: 'Make new token' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Paste the webhook into Steadfast' });
  const url = await dialog.getByLabel('Callback URL').inputValue();
  const token = await dialog.getByLabel('Auth token (Bearer)').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return { url, token };
}

// One delivery_status notice, as Steadfast posts it (its documented body), from the page so the
// mock's worker answers it. Returns the HTTP status
async function courierSays(
  page: Page,
  hook: Hook,
  notice: Record<string, string | number>,
  token: string = hook.token,
): Promise<number> {
  return page.evaluate(
    async ({ url, token: bearer, body }) => {
      const answer = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return answer.status;
    },
    {
      url: hook.url,
      token,
      body: {
        notification_type: 'delivery_status',
        consignment_id: Number(W3_CONSIGNMENT),
        invoice: 'W-000003',
        updated_at: '2026-11-24 15:40:00',
        ...notice,
      },
    },
  );
}

async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openShipped(page: Page, number: string): Promise<void> {
  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

function parcelCard(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: /^Parcel/ }) })
    .last();
}

// The page header's buttons: the primary one is the last (approved with the mockup)
function headerButtons(page: Page) {
  return page.locator('header').getByRole('button', {
    name: /^(Record what came back|Receive the return|Mark delivered)$/,
  });
}

test('a courier account keeps where the rider’s cash goes, and shows what it holds', async ({
  page,
}) => {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('Nothing yet');
  await expect(accountRow(page, 'Pathao counter')).toContainText('No COD account');
  await expectNoSideScroll(page);

  await rowAction(page, 'Pathao counter', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Pathao counter' });
  const cod = edit.getByLabel('COD account');
  await expect(cod.locator('option:checked')).toHaveText('None: record the rider’s cash by hand');
  // Only accounts that hold money; the charges only expense accounts
  await expect(cod.locator('option', { hasText: 'Courier charges' })).toHaveCount(0);
  await cod.selectOption({ label: '1192 · Cash with Pathao' });
  await edit
    .getByLabel('Courier charges account')
    .selectOption({ label: '5420 · Courier charges' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');
  await expect(accountRow(page, 'Pathao counter')).toContainText('Nothing yet');

  // Saved: the form opens with them, and says a change counts for the next receipts only
  await rowAction(page, 'Pathao counter', 'Edit');
  await expect(edit.getByLabel('COD account').locator('option:checked')).toHaveText(
    '1192 · Cash with Pathao',
  );
  await expect(edit.getByText(/^A change counts for the next receipts only\./)).toBeVisible();
});

test('Mark delivered asks what the rider collected and posts the COD receipt', async ({ page }) => {
  await page.goto('/');
  await openShipped(page, 'W-000003');
  // A parcel on its way: Mark delivered is the primary, the other two are there too
  await expect(headerButtons(page)).toHaveText([
    'Record what came back',
    'Receive the return',
    'Mark delivered',
  ]);
  await expect(parcelCard(page).getByText('Courier’s charge')).toBeVisible();

  await page.getByRole('button', { name: 'Mark delivered' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark W-000003 delivered?' });
  await expect(
    dialog.getByText(/and a money receipt into Steadfast Dhaka’s COD account/),
  ).toBeVisible();
  const box = dialog.getByLabel('What the rider collected');
  // It starts with what the rider was to collect (the courier has not said), grouped until focused
  await expect(box).toHaveValue(/^[\d,]+\.00$/);
  await box.fill('99999');
  await dialog.getByRole('button', { name: 'Mark delivered' }).click();
  await expect(
    dialog.getByText(/^The rider collects at most ৳[\d,]+ for this parcel\./),
  ).toBeVisible();

  await box.fill('500');
  await dialog.getByRole('button', { name: 'Mark delivered' }).click();
  await toastShown(page, /^W-000003 delivered\. Invoice .+ and money receipt .+ posted\.$/);
  await expect(
    page.getByText(
      /^The rider’s cash came in on money receipt .+, into Steadfast Dhaka’s COD account\./,
    ),
  ).toBeVisible();
  const parcel = parcelCard(page);
  await expect(parcel.getByText('৳500', { exact: true })).toBeVisible();
  await expect(parcel.getByText('Delivered').first()).toBeVisible();
  const receipt = parcel.getByRole('link', { name: /^MR-/ });
  await expect(receipt).toBeVisible();
  await expectNoSideScroll(page);

  // The courier holds it until its payout (step 28c)
  await openFromNav(page, 'Shop couriers');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('৳500 · 1 parcel');
});

test('the courier says part came back; Record what came back bills the rest', async ({ page }) => {
  await page.goto('/');
  const hook = await steadfastHook(page);
  // A wrong token is refused, and changes nothing
  expect(await courierSays(page, hook, { status: 'partial_delivered' }, 'wrongtoken')).toBe(401);
  expect(
    await courierSays(page, hook, {
      status: 'partial_delivered',
      cod_amount: 300,
      delivery_charge: 130,
    }),
  ).toBe(200);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await expect(listItem(page, /W-000003/)).toContainText('Partly delivered');
  await listItem(page, /W-000003/).click();
  await expect(headerButtons(page).last()).toHaveText('Record what came back');
  await expect(page.getByText(/^Steadfast Dhaka delivered part of the parcel\./)).toBeVisible();

  await page.getByRole('button', { name: 'Record what came back' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record what came back of W-000003' });
  await expect(dialog.getByText('Steadfast Dhaka says the rider collected ৳300.')).toBeVisible();
  await expect(dialog.getByLabel('What the rider collected')).toHaveValue('300.00');
  // Nothing ticked is Mark delivered
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await expect(dialog.getByText(/^Tick what came back\./)).toBeVisible();

  await dialog.getByRole('checkbox', { name: /^Came back: .*T-shirt/i }).check();
  await dialog.getByLabel('Why it came back').fill('The shopper kept one T-shirt');
  // More than the whole parcel's COD amount is refused, with the amount in the words
  await dialog.getByLabel('What the rider collected').fill('99999');
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await expect(
    dialog.getByText(/^The rider collects at most ৳[\d,]+ for this parcel\./),
  ).toBeVisible();
  await dialog.getByLabel('What the rider collected').fill('300');
  await dialog.getByRole('button', { name: 'Record what came back' }).click();
  await toastShown(
    page,
    /^W-000003 partly delivered\. Sales return .+, invoice .+ and money receipt .+ posted\.$/,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'W-000003' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^SR-/ })).toBeVisible();
  await expect(parcelCard(page).getByText('৳300', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record what came back' })).toHaveCount(0);
});

test('the courier is bringing it back; Receive the return puts it in Returned', async ({
  page,
}) => {
  await page.goto('/');
  const hook = await steadfastHook(page);
  // Cancelled after the rider picked it up: the parcel is coming back
  expect(await courierSays(page, hook, { status: 'cancelled' })).toBe(200);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Shipped');
  await expect(listItem(page, /W-000003/)).toContainText('Coming back');
  await listItem(page, /W-000003/).click();
  await expect(headerButtons(page).last()).toHaveText('Receive the return');
  await expect(page.getByText(/^Steadfast Dhaka is bringing the parcel back\./)).toBeVisible();

  await page.getByRole('button', { name: 'Receive the return' }).click();
  const dialog = page.getByRole('dialog', { name: 'Receive W-000003 back?' });
  await expect(
    dialog.getByText('Do this once the parcel is on your shelf, not on the courier’s word alone.'),
  ).toBeVisible();
  await dialog.getByLabel('Why it came back').fill('The shopper did not answer the phone');
  await dialog.getByRole('button', { name: 'Receive the return' }).click();
  await toastShown(
    page,
    /^W-000003 returned\. Sales return .+ posted\. The shopper gets an SMS\.$/,
  );
  await expect(parcelCard(page).getByText('Returned').first()).toBeVisible();
  await expect(headerButtons(page)).toHaveCount(0);

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Returned');
  await expect(listItem(page, /W-000003/)).toBeVisible();
  await expectNoSideScroll(page);
});

test('a COD receipt the books refuse waits for Make the receipt, and the bell says so', async ({
  page,
}) => {
  await page.goto('/');
  // The COD account is archived for a moment. First, so Shop couriers reads the chart after it
  // (its list stays 30 seconds in the app's cache)
  await openFromNav(page, 'Chart of accounts');
  await page
    .getByRole('list', { name: 'Chart of accounts' })
    .getByRole('button', { name: 'Cash with Steadfast', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Edit 1191' })
    .getByRole('button', { name: 'Archive' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const hook = await steadfastHook(page);

  // Steadfast delivers it with nobody watching: the order is Delivered, its receipt is not
  expect(await courierSays(page, hook, { status: 'delivered', cod_amount: 900 })).toBe(200);
  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Delivered');
  await expect(listItem(page, /W-000003/)).toContainText('Needs attention');
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await expect(
    page.getByText(
      'W-000003 was delivered by Steadfast Dhaka, but its COD receipt could not be made. Open the order to make it.',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await listItem(page, /W-000003/).click();
  await expect(page.getByText(/^The COD receipt could not be made\./).first()).toBeVisible();

  // Point the courier at another account; the saved one is archived, so the form says so
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Dhaka', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Dhaka' });
  await expect(
    edit.getByText('Pick an active account that holds money, like Cash with Steadfast, or none.'),
  ).toBeVisible();
  await edit.getByLabel('COD account').selectOption({ label: '1192 · Cash with Pathao' });
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');

  await openFromNav(page, 'Shop orders');
  await showTab(page, 'Delivered');
  await listItem(page, /W-000003/).click();
  await page.getByRole('button', { name: 'Make the receipt' }).click();
  await toastShown(page, /^Money receipt .+ made$/);
  await expect(page.getByText(/^The COD receipt could not be made\./)).toHaveCount(0);
  await expect(page.getByText('Needs attention')).toHaveCount(0);
  // The courier's 900 was cut to what the rider was to collect
  await expect(parcelCard(page).getByRole('link', { name: /^MR-/ })).toBeVisible();
});
```

Five tests, each on the desktop and the phone:

1. **A courier account's two accounts:** the selects offer only their own kind; a saved account shows "A change counts
   for the next receipts only"; the Holds column.
2. **Mark delivered by hand:** the box starts with the whole amount, grouped until focused (`1,368.00`); more than that
   is refused with the amount in the words (mine 53); ৳500 posts the receipt; the parcel card links it; Shop couriers
   says Steadfast Dhaka holds "৳500 · 1 parcel".
3. **Partly delivered by the courier:** a wrong token is 401; the Shipped tab's pill; Record what came back is the
   primary; the box starts with the courier's ৳300; nothing ticked and too much collected are refused; the toast
   names the sales return, the invoice and the receipt.
4. **Coming back:** Steadfast's `cancelled` after pickup; Receive the return; the Returned tab.
5. **A refused COD receipt:** the COD account is archived first, because Shop couriers' list stays 30 seconds in the
   app's cache. Steadfast delivers it; the list says "Needs attention"; the bell rings; the courier's edit form shows
   the archived account's error; a new account; Make the receipt.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/app typecheck            # also checks e2e/
pnpm --filter @omnivo/app test                 # 247 tests
pnpm --filter @omnivo/app exec playwright test --config e2e/playwright.config.ts storefront notifications receipts --workers=2
pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
```

The app's type check passes again, for the first time since 28b.1. The browser tests: 84 passed (every storefront
file, the notifications and the receipts, on both projects), 10 of them the new file's.

Broken on purpose, to see that the tests notice: the mock's over-amount rule turned off makes "Mark delivered asks
what the rider collected" fail.

The screens were compared with the approved mockup, desktop and phone. They match it, except that the primary button
is last (mine 44), and the phone page never scrolls sideways.

## 28b.8 — Run it and check it

Every check ran once on the whole repo, then the whole way ran on the real API with the fake courier. Two things
change: one of 28b.4's tests gets more time, and the first load's budget grows by 5 KB. The run on the real API found
no bug.

Decisions made in this part:

54. **Bug fixed in 28b.4's tests:** "makes no receipt for a courier account without a COD account, nor for an order
    with no parcel" had vitest's own 5 seconds, while every other test in `cod.int.spec.ts` that moves an order has
    `COURIER_CLOCK` (20 seconds). It makes two orders and moves them seven times, so on a busy machine it ran out of
    time. vitest does not stop a test that ran out of time: its moves went on in the background and took stock while
    the next test ("returns part of a parcel…") counted the shampoo's stock, which then came out 2 pieces short. The
    test now has `COURIER_CLOCK` too. The file in 28b.4 above already has this change; the code it tests did not
    change.
55. **The first load's budget is 255 KB (you chose this).** All the English words load with the first page, and the
    contracts' route table with them (see the comment in `check-bundle-size.ts`). 28b.5's words for the COD screens
    and 28b.1's four new order routes took the first load from 249.7 KB to 251.0 KB. The screens themselves stay in
    their lazy chunks: the dialogs of what came back are a chunk of their own (141.3 KB), and the order page is 134.9
    KB. Loading each module's words with its pages is still the real fix, a step of its own.

### The test's timeout

The change is in 28b.4's `cod.int.spec.ts` above (decision 54): the test is written as `it(name, async () => { … },
COURIER_CLOCK)`, like the others, with a one-line comment that says why.

### The bundle budget

```diff
@@ -23,7 +23,9 @@ import { z } from 'zod';
 // Step 27d: 250 KB (you chose this). The online payment's words (27d.5) and its contracts (the
 // Online payment card, the order's payment tries and the shop's payment routes, which the route
 // table carries) took it to 246.4 KB; the card and the order page stay in their lazy chunks.
-const INITIAL_BUDGET = 250 * 1024;
+// Step 28b: 255 KB (you chose this). The COD screens' words (28b.5) and the order's four new routes
+// took it to 251.0 KB; the dialogs of what came back are a lazy chunk of their own.
+const INITIAL_BUDGET = 255 * 1024;
 // Step 17d: a lazy chunk is 105 KB for now. Almost every page loads the contracts' whole route
 // table (about 28 KB gz) to call the API, and 17d's three documents grew it enough to push pages
 // that 17d never touched (team, units) over 100 KB. Loading each module's routes with its own
```

Only the number and one more line of the comment that keeps the history of this budget, so the next person to raise
it can see why each step did.

### The API description

`packages/contracts/openapi.json` is generated again, as in 28a.8:

```bash
node packages/contracts/scripts/gen-openapi.ts
pnpm test:openapi
```

It adds the four new paths of the order (`return-plan`, `partly-deliver`, `return`, and the parcel's `receipt`), moves
`deliver` with them into the new route group (decision 17), and adds the new fields: the courier account's two
accounts and what it holds, the parcel's collected amount, courier charge, receipt and receipt error, and the receipt
method `courier`. The file is not shown here: it is long, and nobody writes it by hand.

### The run on the real API

Not part of the repo: a script started a throwaway Postgres, Valkey, MinIO and Mailpit on other ports, the built API
and worker (`COURIER_MODE=fake`), ran `pnpm seed:shop`, started the built shop with `SHOP_SOURCE=api`, and drove the
ERP's production build and the shop in one browser:

- Shop couriers: "Steadfast Dhaka" added with its keys, COD account `1110 · Cash in hand` (the demo shop's only
  account that holds money) and courier charges account `5240 · Transport and conveyance`, then made the one that
  books first. Its row said "Nothing yet".
- Four Cash on Delivery orders on the shop (two shampoos each, ৳538 with delivery), confirmed with the codes from
  Mailpit, each packed and booked by the worker with the fake courier. Steadfast's `pending` moved all four to
  Shipped.
- **W-000001:** Steadfast's `delivered` with `cod_amount` 538 and `delivery_charge` 70. With nobody on the page, the
  order was Delivered with invoice `INV-2026-27-0001` of ৳538, and the parcel kept collected ৳538, charge ৳70 and
  money receipt `MR-2026-27-0001` (৳538, method `courier`, into 1110). Its journal entry: Dr 1110 ৳538, Cr 1140
  (receivables) ৳538. The order page said "The rider's cash came in on money receipt MR-2026-27-0001, into Steadfast
  Dhaka's COD account."
- **W-000002:** `partial_delivered` with `cod_amount` 309. The page said Steadfast Dhaka delivered part of the
  parcel. "Record what came back" started with "Steadfast Dhaka says the rider collected ৳309." and ৳309.00 in the
  box. One of the two shampoos ticked as back: a sales return of 1 piece, invoice `INV-2026-27-0002` of ৳309 (one
  shampoo and the delivery charge), and receipt `MR-2026-27-0002` of ৳309.
- **W-000003:** `cancelled` after the pick-up: the page said Steadfast Dhaka is bringing the parcel back. "Receive the
  return": a sales return of everything, no invoice and no receipt, the order Returned, and the shopper's SMS
  "Omnivo: order W-000003 came back to us and is closed. Questions? Call +880 1786 120356."
- **W-000004:** Mark delivered by hand with ৳500 collected: invoice of ৳538 and receipt `MR-2026-27-0003` of ৳500, so
  ৳38 of the invoice is still due (decision 15).
- Shop couriers then said "৳1,347 · 3 parcels" for Steadfast Dhaka: 538 + 309 + 500. No page had a script error.

### Try it

28b adds no setting to `.env`. Run the migrations; 0077–0079 are 28a's, if your database does not have them yet:

```bash
pnpm install
pnpm db:migrate        # 0080 and 0081 (and 0077–0079 from 28a)
pnpm dev
```

Sign in to the demo shop's ERP as in 28a.8 (`owner@demo-shop.test`, `Demo-shop-2026`). First, in the chart of
accounts, add "Cash with Steadfast" under your cash accounts with "Holds money" ticked, and "Courier charges" under
the expenses. With the fake courier, a parcel moves only when you post its webhook (28a.8 shows the `curl`); add
`"cod_amount":538,"delivery_charge":70` to the body for the money.

- [ ] Shop couriers → Edit the Steadfast account: the COD account offers only accounts that hold money, the charges
      account only expense accounts. Pick both and save. The row says "Nothing yet".
- [ ] Order on the shop, pack, then post `pending` and `delivered` with a `cod_amount`. The order is Delivered, the
      invoice Paid, and the parcel card shows Rider collected, Courier's charge and the money receipt. The receipt's
      ledger is "Cash with Steadfast". The Shop couriers row says what it holds.
- [ ] Post `delivered` again: nothing changes, and there is still one receipt.
- [ ] Another order: `partial_delivered`. "Record what came back": tick one line, keep the courier's amount. The
      order has a sales return, an invoice of the rest and a receipt.
- [ ] Another order: `cancelled` after `pending`. "Receive the return": the order is in the Returned tab, and the
      shopper's SMS says it came back.
- [ ] Another order: Mark delivered by hand, with less than the COD amount. The invoice is Partly paid.
- [ ] Archive "Cash with Steadfast", then deliver one more parcel by webhook: the order needs attention, the bell
      rings once, and the order page says why. Point the courier at another account, then "Make the receipt".
- [ ] Void one of the COD receipts: the Shop couriers row holds less, and the receipt stays linked to its parcel
      (decision 26).

Before the first live shop, with a real Steadfast account:

- [ ] Deliver one real parcel fully and one partly. Check that `cod_amount` in Steadfast's `delivered` and
      `partial_delivered` notices is what the rider collected (not the amount booked), and that `delivery_charge` is
      Steadfast's charge for that parcel. Both are read in `steadfast-adapter.ts` (`collected` and `charge` of a notice).
- [ ] Note what Steadfast's payout report looks like (a CSV or its payments list): 28c's matching is built on a
      guess until then.

## What comes next

- **28b.9 (on request):** the docs: CLAUDE.md (the courier account dialog's two accounts, Shop couriers' Holds
  column, the order page's Mark delivered with the collected amount, "Record what came back", "Receive the return",
  the parcel card's money, "Make the receipt", the Returned tab and the Shipped tab's second pill, the bell), the
  storefront paragraph, system-design §14.6 and build-plan ২৮b with section ৯.
- **Before a live shop:** the Steadfast list above, with 28a.8's.
- **28c:** the courier's payout: a document that moves the COD money from the courier's account into the bank, with
  the courier's charges on their own line, and matching the courier's payout CSV.
- **28d:** Pathao, with the address as its own city, zone and area.
- **Known limits:** a voided COD receipt stays linked to its parcel, so "Make the receipt" does not offer a new one
  (decision 26); record the money with a normal money receipt. The words of every module still load with the first
  page (decision 55).
