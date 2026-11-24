# Step 27b: Checkout and orders, part 2 — the shop's orders in the ERP

> The implementation guide for "Phase 10 → Step 27", the second part, of [build-plan.bn.md](build-plan.bn.md). Step
> 27 has three parts:
>
> - **27a:** orders in the database, the stock they hold, the phone code by SMS, the tracking link and the API's
>   limits ([step-27a-shop-orders.en.md](step-27a-shop-orders.en.md)).
> - **27b (this guide):** the ERP's Storefront → Shop orders screens, and the ERP documents an order makes: the
>   customer and the sales order at confirm, the challan at Packed, the invoice at Delivered, and a sales return
>   when a packed order is cancelled.
> - **27c:** coupons and online payment (SSLCommerz, with the shop's own encrypted credentials).

> Every file in this guide was placed in a separate copy of the repo (on top of commit `adcbe49`, "storefront
> checkout done") and checked on 2026-11-18: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, `pnpm typecheck`,
> `pnpm test` (1,487, of them 636 in `packages/contracts`, 244 in `apps/shop`, 239 in `apps/app` and 199 in
> `apps/api`), `pnpm test:integration` (846 in 49 files, 5 skipped as before) and `pnpm test:tenant-leak` (171 in 24
> files) on Testcontainers, `pnpm boundaries`, `pnpm test:bundle-size` (first load 243.4 KB gz, budget 245; the
> listing editor 150.8 KB, budget 155), `pnpm test:openapi`, the app's Playwright suite on a computer and on a phone
> (all 465 that run pass; six timed out while the machine was busy and passed when run again on their own), the PWA
> suite (4) and the shop's Playwright tests (42, 2 skipped on purpose, as before), all clean. `pnpm lint` ran out of
> its 6 GB of memory on the whole repo on this machine (8 GB), so ESLint ran folder by folder with the same config
> (`apps/api`, `apps/app`, `apps/shop`, `packages` and the root's config files): no errors. The migration was also
> checked on a throwaway Postgres with its own script (27b.2).
>
> Also checked:
>
> - **The whole way on the real API** (27b.8): throwaway Postgres, Valkey, Mailpit and MinIO, the built API and
>   worker, `pnpm seed:shop`, the built shop with `SHOP_SOURCE=api`, and a production build of the app. Three Cash on
>   Delivery orders of ৳538 were placed in a browser with the codes from Mailpit. The worker made a confirmed sales
>   order for each at ৳538.00 with prices that include VAT, found one customer for the two orders from one phone, and
>   made "Delivery charge" once. In the app, the bell opened `W-000003` and the sidebar counted 3. `W-000001` was
>   packed (a posted challan `DC-2026-27-0001`, no hold left), shipped and delivered (a posted invoice for ৳538.00 with
>   2 lines, unpaid); `W-000002` was cancelled while new (its sales order cancelled, the shopper's SMS in Mailpit);
>   `W-000003` was packed, then cancelled (a posted sales return). The shampoo's stock ended exactly 2 lower, no stock
>   was held, the journal's debits and credits were equal, the order's page did not scroll sideways at 390px, Shop
>   settings showed the made service, and the shop's `/track` showed `W-000001` delivered. This run found the
>   Packed dialog's extra request, fixed in 27b.8.
> - **Broken on purpose** while the parts were written, each caught by a test: a reader allowed to ship, a line sent
>   twice in Packed, the documents check dropped, the shop's role allowed to write the sales order's link, the hold
>   left after Packed, the confirm handler dropping a refusal, an archived customer matched by the phone, the challan's
>   errors not mapped to the picks, Shipped allowed from New, the handler without its lock (two sales orders), and the
>   settings box allowed to go empty after an order used it. Each part's "Check this part" lists them.

## Goal

📦 **A shop order is work the shop's staff can do in the ERP.** After 27a a confirmed order sits in the database,
holds its stock and rings the bell, but nobody can see it, pack it or bill it. After 27b the order turns into the same
documents a phone order would, made by the system: the customer (found by the phone, or made) and a confirmed sales
order as soon as the code confirms the order; a posted challan when the packer marks it Packed, which takes the stock
out for real and ends the hold; a posted invoice when it is Delivered. A Shop orders screen lists the orders by status,
and an order's page moves it on with one button. Cancelling a new order frees its stock; cancelling a packed one
brings the goods back with a sales return. The books, the stock and the reports see a shop sale exactly like any
other sale.

## The whole picture

```
packages/contracts   storefront-orders.ts: the ERP's side of an order (list, counts, one order, the pack plan,
                     Packed's picks, cancel) and its 9 routes      storefront-admin.ts: deliveryVariantId and
                     deliveryChoices      errors: 7 codes      audit: 5 actions on storefront_order
packages/db          0072 the order's four document links, document_error, cancel_reason, the list's index and the
                     documents check; the shop's settings keep the delivery charge's service
      │
      ▼
apps/api
   worker    storefront.order_confirmed → ShopSalesOrderMaker: the customer by phone (or a new one), "Delivery
             charge" made once, a confirmed sales order with prices that include VAT → then the bell.
             A refusal is kept on the order as its error code (documentError)
   StorefrontOrdersService   (storefront.order.read to see, storefront.order.manage to move)
             list · counts · one order · make the sales order again
             pack plan (first expiry first) → Packed: a posted challan, the holds deleted, one transaction
             Shipped: a status · Delivered: a posted invoice for the challan's lines and the delivery charge
             Cancel: new → the sales order cancelled, the holds deleted; packed → a posted sales return of the
             whole challan, then the sales order cancelled; an SMS to the shopper after the commit
   the sales services   entry points inside the caller's transaction (createForShop, cancelIn,
                        postForShopOrder, createIn): a shop's challan is checked like one typed by hand
      │
      ▼
apps/app   Storefront → Shop orders, with the count of new orders: New · Packed · Shipped · Delivered ·
           Cancelled · All, and a search. An order's page: the next step's button, Cancel, the Packed dialog
           (batches, serial numbers), Items, Timeline, Deliver to, Documents. The bell opens the order.
           Shop settings: the delivery charge's service. The mocks: the 9 routes with the API's rules.

Wednesday 18 Nov 2026 at Demo Shop:
  Nusrat orders 2 shampoos for ৳538 → the worker finds her customer by 01786120356 and confirms a sales order
  for ৳538 → the packer opens W-000001 from the bell → Mark packed: a posted challan, 2 pieces leave the shelf,
  the hold ends → Mark shipped → the rider brings the cash → Mark delivered: a posted invoice for ৳538, and
  "Record payment" takes the cash in
```

## Not in this step, on purpose

- **Couriers, the courier's COD money and returns after shipping** (step 28). Shipped is only a status here, and a
  parcel that comes back is "returned", which step 28 brings with the courier's events.
- **Coupons and online payment** (27c).
- **Editing an order.** A shopper who wants something else gets the order cancelled and orders again: an edit would
  have to change a hold, a sales order and maybe a challan, and the shopper's own tracking page, at once.
- **Packing many orders in one go.** One order at a time, because each Packed needs its own batches or serial numbers.

## What changes in the code you already have

| File | Change |
|---|---|
| `packages/contracts/src/storefront-admin.ts` (+ spec) | The delivery charge's service in the shop's settings, and the choices for it |
| `packages/contracts/src/errors.ts`, `audit.ts`, `index.ts`, `routes.ts` | 7 error codes, 5 audit actions and the `storefront_order` entity, the new routes |
| `packages/i18n/src/locales/en.ts`, `bn.ts` | The new errors' and audit actions' words, then the Shop orders screens' words |
| `packages/db/src/schema/storefront-orders.ts` | The order's four document links, `document_error`, `cancel_reason`, the list's index and their checks |
| `packages/db/src/schema/storefront.ts` | The delivery charge's service (product and variant) in the shop's settings |
| `apps/shop/scripts/seed-plan.ts` | The seeded settings say "none picked" for the delivery charge's service |
| `apps/api/src/common/tenant/tenant-context.ts` | `currentActorId()`: the member, or NULL for the system's own work |
| `apps/api/src/sales/credit.service.ts` | A shop order's sales order goes over a credit limit without a member's permission, with the audit row |
| `apps/api/src/sales/sales-orders.service.ts`, `customers.service.ts`, `deliveries.service.ts`, `invoices.service.ts`, `sales-returns.service.ts`, `sales.module.ts` | Entry points inside the caller's transaction for a shop order's documents |
| `apps/api/src/products/products.service.ts`, `product-write.ts`, `products.module.ts` | A product saved inside the caller's transaction (the "Delivery charge" service) |
| `apps/api/src/storefront/orders/order-confirmed.handler.ts` | Makes the customer and the sales order before the bell; keeps a refusal's error code |
| `apps/api/src/worker/worker.module.ts` | The sales services in the worker |
| `apps/api/src/storefront/storefront.module.ts` | The Shop orders controller and service |
| `apps/api/src/storefront/admin/settings.service.ts` | The delivery charge's service box and its choices |
| `apps/api/src/sms/shop-sms.ts` (+ spec) | The cancel SMS |
| `apps/api/src/storefront/orders/order-view.spec.ts`, `storefront-admin.int.spec.ts`, `storefront-admin.tenant-leak.int.spec.ts`, `storefront-appearance.int.spec.ts` | The new columns and the settings' new box in the older tests' fixtures (the last two in 27b.8) |
| `apps/api/src/storefront/orders/shop-orders.tenant-leak.int.spec.ts`, `apps/api/src/testing/shop-orders.ts` | Four tenant-leak tests for the ERP's side, and a helper that picks the delivery charge's service |
| `packages/contracts/openapi.json` | Regenerated |
| `apps/app/src/routes/app-shell.tsx`, `lib/queries.ts` | "Shop orders" first in the Storefront group, with the count of new orders |
| `apps/app/src/router.tsx` | The list (with its tab in the address) and the order's page |
| `apps/app/src/components/document-notice.tsx` | A `crit` tone and an optional action at the end of the line |
| `apps/app/src/components/notification-bell.tsx` | The new-order bell opens its order |
| `apps/app/src/routes/storefront-settings.tsx`, `lib/storefront.ts` | The delivery charge's service box |
| `apps/app/src/mocks/storefront-data.ts`, `storefront-seed.ts` | The settings' two new fields and their checks; the seed's two accessories and seven orders |
| `apps/app/src/mocks/handlers.ts`, `fixtures.ts`, `workspace-data.ts`, `sales-document-data.ts` | The nine routes, the seed's switch, and a shop's sales order (prices with VAT, the address as text) |
| `apps/app/e2e/helpers.ts` | The `shopOrders` option |
| `apps/app/scripts/check-bundle-size.ts` | The lazy chunk budget is 155 KB |

New: `packages/contracts/src/storefront-orders.ts` (+ spec), `packages/db/migrations/0072_storefront-order-documents.sql`,
`apps/api/src/storefront/orders/sales-order-maker.ts`, `storefront-orders.service.ts`, `storefront-orders.controller.ts`,
`storefront-orders.int.spec.ts`, `apps/app/src/lib/storefront-orders.ts` (+ spec), `apps/app/src/routes/storefront-orders.tsx`,
`storefront-order.tsx`, `apps/app/src/components/storefront-order-pills.tsx`, `storefront-pack-dialog.tsx`,
`apps/app/src/mocks/storefront-order-data.ts`, `apps/app/e2e/storefront-orders.e2e.ts`.

## Decisions

Agreed with the user on 2026-11-18 (all eleven as recommended):

1. **The sales order is made by the confirm event's handler**, in the worker as `omnivo_app`. The confirm runs as
   `omnivo_shop`, which may not write the sales tables, and should not: the shopper's confirm must never fail
   because of something in the ERP. If the handler cannot make it (an archived product, say), the order page shows
   why in a `crit` notice with a "Make the sales order" button.
2. **The customer is found by the phone.** Both sides are turned into the 11 digits (`01786120356`); with several
   active customers on that phone, the oldest one; with none, a new customer with the shopper's name, phone and
   address and no credit limit. A customer over their limit still gets the shop order (like a POS sale), and the
   audit log says so. A single "Online customers" customer would be simpler, but then nobody's history or aging
   would be their own.
3. **The sales order's prices include VAT**, and each line's price is the shop's unit price. The ERP's total is then
   the shop's total to the paisa; with prices before VAT, the invoice would ask for more than the shopper paid.
4. **The delivery charge is a service product.** The first order that has a charge makes it once ("Delivery
   charge", with the workspace's default VAT rate) and keeps its id in the shop's settings, where it can be changed.
   A free delivery adds no line. Made when first needed, so the shops opened before 27b need nothing done to them.
5. **Packed is a posted challan** from the warehouse the stock is held in. "Mark packed" opens a dialog: batches
   chosen first-expiry-first (changeable), serial numbers typed or scanned. The hold ends in the same transaction,
   because the stock has now really left. If the stock is gone (a POS sale got there first), the challan's own
   stock error says so.
6. **Shipped is a status only.** The courier comes in step 28.
7. **Delivered is a posted invoice** for the challan's lines and the delivery charge, dated the day of delivery and
   unpaid. The cash on delivery is entered as an ordinary money receipt (a "Record payment" link); step 28 does it
   from the courier's payout.
8. **Cancel** works on a new order (the sales order is cancelled, the hold ends) and on a packed one (a posted sales
   return of the whole challan, then the sales order is closed; 27b.3 made it cancelled, see decision 26). Not after Shipped: that is "returned", step 28. The
   shopper gets an SMS that the order was cancelled; no other move sends one (the tracking link went at confirm).
9. **`storefront.order.manage` is enough to make the documents.** A packer needs no right to write challans or
   invoices by hand. The audit log names the shop order on each document, and the order's page links a document
   only for someone who may read that kind.
10. **The screens:** "Shop orders" in the Storefront group (the group shows with `storefront.order.read` too), a
    list with status tabs, a search and the count of new orders on the nav item, and an order's page with the next
    step's button, the documents card and the timeline. The bell opens the order's page. Online only.
11. **One guide in nine parts:** contracts, database, API, API tests, words, screens (a mockup first), mocks and
    browser tests, the finish, docs.

Made while writing this guide (the user can change any of them):

12. **The ERP's side has its own contract file**, `storefront-orders.ts`, next to `storefront-admin.ts`. 27a's
    `storefront.ts` is what the shop's server sends and gets; the ERP's answers have the shopper's phone and address,
    the documents and the version, and must never be mixed up with the shop's.
13. **The ERP never shows a pending order.** `STOREFRONT_ORDER_STATUSES` is the shop's statuses without `pending`,
    worked out from them, so a status added later reaches both. Returned has no tab until step 28; it shows under
    All.
14. **The Packed dialog gets its batches and a suggestion from its own route** (`pack-plan`). A packer has no right
    to read the stock screens, and the first-expiry-first rule is the server's, so every packer gets the same
    suggestion. A serial product gets no suggestion: only the packer knows which pieces went into the box.
15. **Packed sends each line once, split into picks** (a batch and a quantity, or serial numbers). The contract
    refuses a line twice and a serial number twice; whether the picks add up to the line, and whether a batch has
    the stock, only the API can say.
16. **A failed sales order is kept as its error code** on the order (`documentError`), shown with the error's own
    words, and the list marks the order "Needs attention". The retry is a route of its own.
17. **The delivery charge's service is picked from `deliveryChoices`** in the settings answer, the workspace's active
    services: `storefront.manage` cannot read the products list. Once an order used one, the box cannot be emptied
    again, or the next order would make a second "Delivery charge".
18. **The sidebar's count has its own small route** (`counts`), so the nav does not load a page of orders to count
    the new ones.
19. **A cancel reason is for the staff only** (200 characters), never in the shopper's SMS.
20. **Each move is an audit action on the order** (`storefront_order.packed`, …), and the documents write their own
    entries too. The sales order made at confirm has no member behind it, so its entry has no actor.
21. **Shipped and Delivered take only the version.** Their time is now, and the invoice's date is today in the
    workspace's time zone; backdating waits for step 28, where the courier says when it delivered.
22. **Work the system does has no actor.** The worker makes the sales order with no member behind it, so the
    documents it writes have `created_by` NULL. `currentActorId()` is used only on the paths both a route and the
    worker reach; everything else keeps `currentPrincipal()`, whose throw catches a route left public by mistake.
23. **The sales services get entry points inside the caller's transaction** (`createForShop`, `cancelIn`,
    `postForShopOrder`, `createIn`) instead of the shop having its own copy of their rules. A shop order's move and
    its documents are then one transaction, and a challan for the shop is checked exactly like one written by hand.
24. **The worker gets the sales services and a Redis client that never connects.** `CreditService` and
    `BalanceAccess` ask for `PermissionService`, which asks for Redis. The shop's sales order never reads a member's
    permissions, so the client is `lazyConnect` and stays closed.
25. **The sales order and the challan carry the address the shopper typed**, as text (name, address, phone), not one
    of the customer's saved addresses. A repeat customer's saved addresses are not touched; a new customer gets the
    order's address saved, for the next document written by hand.
26. **A packed order's cancel ends with its sales order cancelled, not closed** (decision 8 said closed). After the
    return brings everything back, the sales order has delivered nothing, and its own rule refuses Close then
    (`order_nothing_delivered`); Cancel is the state that is true.
27. **"Delivery charge" is made in the workspace's piece unit** (`pcs` first, any count unit of one piece next). A
    workspace without one gets `storefront_delivery_product_invalid` on the order, which sends someone to Shop
    settings to pick a service.
28. **Delivered only after Shipped.** The buttons follow the parcel; a shop that hands parcels over at its counter
    presses Shipped and Delivered one after the other.
29. **The list's "Needs attention" means a stored error.** An order confirmed under 27a has no sales order and no
    error; its page still offers "Make the sales order".
30. **The answer always has the four document links.** Whether the page links one is the page's choice by the
    reader's permissions (decision 9); the numbers alone say nothing a packer may not know.
31. **The cancel SMS gives the shop's hotline**, so the shopper can ask why; the reason stays the staff's.
32. **The pack plan's quantities stay as the API writes them.** A batch pick is a stock quantity (`3.0000`), while an
    untracked pick and the line are the order's whole number (`2`). Both are valid quantity strings, and the API's
    other answers send stock the same way. The Packed dialog (27b.6) must show each in the unit's decimals, never
    the raw string.
33. **27b's tenant-leak tests go into 27a's leak file.** That file already has two launched shops with a confirmed
    order each, and its worker now makes their sales orders. A new file would start a second set of containers to
    build the same two shops again.

## 27b.1 — Contracts

The contract comes first, as in every step: the API, the screens, the mocks and the tests read the same schemas, so a
shape that is wrong here fails the type check everywhere at once.

### The file and what it reads

```ts
import { z } from 'zod';

import { ERROR_CODES, errorCode } from './errors.js';
import { optionalText, versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { TRACKING_MODES } from './products.js';
import { quantitySchema } from './quantities.js';
import { documentRefSchema } from './sales.js';
import { MAX_SERIALS_PER_LINE, optionalIdSchema, serialNumberSchema } from './stock.js';
import { storefrontImageViewSchema } from './storefront-admin.js';
import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  SHOP_ORDER_STATUSES,
  SHOP_PAYMENT_METHODS,
} from './storefront.js';

// Step 27b: the ERP's side of the shop's orders. storefront.ts is what the shop's server sends and
// gets (27a); this file is what the ERP's Shop orders screens read and send: the list, one order,
// what Packed needs, and the four moves (Packed, Shipped, Delivered, Cancelled). Reading needs
// storefront.order.read, every move storefront.order.manage (decision 9): the ERP documents a move
// makes need no sales permission of their own.
```

The comment says who uses what: reading needs `storefront.order.read`, every move `storefront.order.manage`. The
imports show what this file builds on: the shop's statuses and limits from 27a's `storefront.ts` (an order line is
never more than `SHOP_CART_MAX_LINES` lines or `SHOP_CART_MAX_QUANTITY` pieces, because it came from a cart), the
listing photo with its address from `storefront-admin.ts`, the sales documents' `documentRefSchema` and the stock
lines' serial number and quantity rules, so a pick follows the same rules as a challan line.

### The list

```ts
// ---------------------------------------------------------------------------------------------
// The list

// The statuses the ERP shows. A pending order (it waits for its phone code) is the shopper's, not
// the shop's: it may never be confirmed, and the sweep deletes it after an hour (27a's decision
// 19), so the ERP never lists it
export const STOREFRONT_ORDER_STATUSES = SHOP_ORDER_STATUSES.filter(
  (status): status is Exclude<(typeof SHOP_ORDER_STATUSES)[number], 'pending'> =>
    status !== 'pending',
);
export type StorefrontOrderStatus = (typeof STOREFRONT_ORDER_STATUSES)[number];

// The list's tabs. "New" is a confirmed order: nobody has packed it yet. Returned has no tab until
// step 28 brings the courier's returns; it shows under All
export const STOREFRONT_ORDER_VIEWS = [
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'all',
] as const;
export type StorefrontOrderView = (typeof STOREFRONT_ORDER_VIEWS)[number];

export const STOREFRONT_ORDER_SORTS = ['-confirmed', 'confirmed', '-total', 'total'] as const;
export type StorefrontOrderSort = (typeof STOREFRONT_ORDER_SORTS)[number];

export const storefrontOrderQuerySchema = pageQuerySchema.extend({
  // Part of the number (W-000123 or 123), the shopper's name or phone. The API drops spaces and
  // dashes from a phone, so "01786 120356" finds 01786120356
  search: z.string().trim().max(100).optional(),
  view: z.enum(STOREFRONT_ORDER_VIEWS).default('confirmed'),
  sort: z.enum(STOREFRONT_ORDER_SORTS).default('-confirmed'),
});
export type StorefrontOrderQuery = z.input<typeof storefrontOrderQuerySchema>;

export const storefrontOrderSummarySchema = z.object({
  id: z.uuid(),
  orderNo: z.string(),
  status: z.enum(STOREFRONT_ORDER_STATUSES),
  // When the shopper pressed Confirm Order, and when the code confirmed it
  placedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime(),
  customerName: z.string(),
  phone: z.string(),
  zoneName: z.string(),
  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
  // The pieces in the order (the sum of the lines' quantities), as "3 items" on a phone's card
  itemCount: z.number().int().min(1),
  total: z.string(),
  // The sales order could not be made (decision 1): the list shows a crit "Needs attention" pill
  needsAttention: z.boolean(),
});
export type StorefrontOrderSummary = z.infer<typeof storefrontOrderSummarySchema>;

export const storefrontOrderPageSchema = pageOf(storefrontOrderSummarySchema);
export type StorefrontOrderPage = z.infer<typeof storefrontOrderPageSchema>;

// The sidebar's count next to "Shop orders": the orders nobody has packed yet
export const storefrontOrderCountsSchema = z.object({
  confirmed: z.number().int().min(0),
});
export type StorefrontOrderCounts = z.infer<typeof storefrontOrderCountsSchema>;
```

- `STOREFRONT_ORDER_STATUSES` is a filter over `SHOP_ORDER_STATUSES`, not a second list (decision 13). The type
  guard in the filter (`status is Exclude<…, 'pending'>`) is what makes the result's type the six statuses without
  `pending`; a plain `filter` would keep the type of all seven, and a `pending` status in an ERP answer would type
  check.
- `STOREFRONT_ORDER_VIEWS` are the tabs. `confirmed` is "New": confirmed and not packed yet. It is the default view,
  because it is the work waiting.
- The search takes a part of the number, the name or the phone. The comment says what the API does with a phone
  typed with spaces, so 27b.3 has it written down.
- `needsAttention` is a boolean in the list, not the error code: the list only needs a pill, and the code's words
  are on the order's page.
- `storefrontOrderCountsSchema` has one count, the new orders, for the nav item (decision 18). An object, not a
  number, so a second count later (returned, step 28) is not a breaking change.

### One order

```ts
// ---------------------------------------------------------------------------------------------
// One order

// One line as the shopper bought it (27a's copy of the listing), plus what the ERP knows of the
// variant now: its SKU and its base unit's code, so the page says "2 pcs"
export const storefrontOrderLineSchema = z.object({
  position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
  listingId: z.uuid(),
  name: z.string(),
  packSize: z.string(),
  // The listing's photo when the order was placed. null when that photo's file is gone (the
  // listing changed its photos and a later clean-up removed the old one)
  image: storefrontImageViewSchema.nullable(),
  productId: z.uuid(),
  variantId: z.uuid(),
  sku: z.string(),
  unitCode: z.string(),
  quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
  unitPrice: z.string(),
  lineTotal: z.string(),
});
export type StorefrontOrderLine = z.infer<typeof storefrontOrderLineSchema>;

export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
  address: z.string(),
  // When each step happened, oldest first, the shop's timeline's shape (shopOrderSchema.history).
  // Starts with pending at placedAt
  history: z.array(z.object({ status: z.enum(SHOP_ORDER_STATUSES), at: z.iso.datetime() })).min(2),
  lines: z.array(storefrontOrderLineSchema).min(1),
  subtotal: z.string(),
  discount: z.string(),
  couponCode: z.string().nullable(),
  deliveryCharge: z.string(),
  // What the member typed when cancelling ("Customer did not answer the phone"); null otherwise
  cancelReason: z.string().nullable(),
  // The ERP customer the phone matched or made (decision 2); null until the sales order is made
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  // The documents the order made. Each is null until its step. The page links one only when the
  // member may read that kind of document (decision 9)
  salesOrder: documentRefSchema.nullable(),
  delivery: documentRefSchema.nullable(),
  invoice: documentRefSchema.nullable(),
  salesReturn: documentRefSchema.nullable(),
  // Why the sales order could not be made (decision 1): the error the sales order's own rules
  // gave ("sales_variant_archived"). The page shows it with "Make the sales order"
  documentError: z.enum(ERROR_CODES).nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontOrder = z.infer<typeof storefrontOrderSchema>;
```

- A line is 27a's copy of the listing (name, pack size, photo), plus the variant's SKU and its base unit's code from
  the ERP now, so the page can say "2 pcs" and a packer can find the shelf by the SKU. The photo may be `null`: the
  copy keeps the photo's id, and a photo removed later has no file to show.
- `history` has the shop timeline's shape (`shopOrderSchema.history`) with at least two steps, because an order the
  ERP sees has always been placed and confirmed.
- `customer` is `null` until the sales order exists, because the handler finds or makes the customer in the same
  transaction as the sales order (decision 2).
- The four document references are `null` until their step (decision 5, 7, 8). They carry the number, so the
  documents card can name them; whether the page links them depends on the reader's permissions (decision 9).
- `documentError` is one of `ERROR_CODES` (decision 16), so the page can show it with `t('errors.…')` and the type
  check knows it has words.
- `version` is the optimistic lock every move sends back: two people pressing Packed at once get one challan, and
  the second gets `storefront_order_step_invalid` or a version error.

### Packed, Shipped, Delivered and Cancel

```ts
// ---------------------------------------------------------------------------------------------
// Packed (decision 5): the challan's lines

// One batch, or a run of serial numbers, of one line. A line of 3 pieces may take 2 from the batch
// that expires first and 1 from the next; a line of an untracked product has one pick with no
// batch
const packPickSchema = z.object({
  batchId: z.uuid().nullable(),
  quantity: z.string(),
  serialNumbers: z.array(z.string()),
});
export type StorefrontPackPick = z.infer<typeof packPickSchema>;

// A batch of the line's variant that has stock in the order's warehouse
const packBatchSchema = z.object({
  batchId: z.uuid(),
  lotNumber: z.string(),
  expiresOn: z.iso.date().nullable(),
  // On hand in that warehouse, in the base unit
  available: z.string(),
});

// What the Packed dialog opens with. The warehouse is the one the order's stock is held in (27a
// copied it onto the hold), not the shop's warehouse now
export const storefrontPackPlanSchema = z.object({
  warehouse: z.object({ id: z.uuid(), name: z.string() }),
  lines: z.array(
    z.object({
      position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
      name: z.string(),
      packSize: z.string(),
      sku: z.string(),
      unitCode: z.string(),
      // In the base unit, as on the order
      quantity: z.string(),
      tracking: z.enum(TRACKING_MODES),
      // Earliest expiry first, then the oldest batch: the order FEFO takes them in. Empty for an
      // untracked product
      batches: z.array(packBatchSchema),
      // The API's suggestion: FEFO over `batches` for a batch product, one pick with no batch for
      // an untracked one. Empty for a serial product: only the packer knows which pieces went in
      // the box, so the serial numbers are always typed or scanned
      picks: z.array(packPickSchema),
    }),
  ),
});
export type StorefrontPackPlan = z.infer<typeof storefrontPackPlanSchema>;

const packPickInputSchema = z.object({
  // '' = no batch (an untracked product)
  batchId: optionalIdSchema,
  quantity: quantitySchema,
  serialNumbers: z.array(serialNumberSchema).max(MAX_SERIALS_PER_LINE),
});

const packLineInputSchema = z.object({
  position: z.number().int().min(1).max(SHOP_CART_MAX_LINES),
  // A few batches at most in real life; 20 keeps a request with a mistake in it small
  picks: z.array(packPickInputSchema).min(1).max(20),
});

// What "Mark packed" sends: every line of the order once, each split into its picks. Whether the
// picks add up to the line's quantity, and whether a batch has the stock, only the API knows: it
// has the order and the stock (storefront_order_pick_total and the challan's own stock errors)
export const packStorefrontOrderInputSchema = z
  .object({
    version: versionSchema,
    lines: z.array(packLineInputSchema).min(1).max(SHOP_CART_MAX_LINES),
  })
  .superRefine((input, ctx) => {
    // Each line once: two entries for one line would pack it twice
    const positions = new Set<number>();
    // A serial number goes in the box once, whichever line or pick it was scanned on. The same
    // rule as documentSerialRules, one level deeper (lines → picks), so the error sits on the box
    // with the second copy
    const serials = new Set<string>();
    input.lines.forEach((line, lineIndex) => {
      if (positions.has(line.position)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', lineIndex, 'position'],
          message: errorCode('storefront_order_line_twice'),
        });
      }
      positions.add(line.position);
      line.picks.forEach((pick, pickIndex) => {
        pick.serialNumbers.forEach((serial, serialIndex) => {
          if (serials.has(serial)) {
            ctx.addIssue({
              code: 'custom',
              path: ['lines', lineIndex, 'picks', pickIndex, 'serialNumbers', serialIndex],
              message: errorCode('stock_serial_twice'),
            });
          }
          serials.add(serial);
        });
      });
    });
  });
export type PackStorefrontOrderInput = z.infer<typeof packStorefrontOrderInputSchema>;
export type PackStorefrontOrderFormValues = z.input<typeof packStorefrontOrderInputSchema>;

// Shipped, Delivered and "Make the sales order": the version is all they need
export const storefrontOrderVersionInputSchema = z.object({ version: versionSchema });
export type StorefrontOrderVersionInput = z.infer<typeof storefrontOrderVersionInputSchema>;

// Cancel (decision 8): a reason is kept on the order for the staff, never sent to the shopper
export const cancelStorefrontOrderInputSchema = z.object({
  version: versionSchema,
  reason: optionalText(200),
});
export type CancelStorefrontOrderInput = z.infer<typeof cancelStorefrontOrderInputSchema>;
export type CancelStorefrontOrderFormValues = z.input<typeof cancelStorefrontOrderInputSchema>;
```

- The pack plan is what the dialog opens with (decision 14). Its warehouse is the hold's, not the shop's warehouse
  now: 27a copied it onto the hold so that an order placed before the tenant moved the shop to another warehouse is
  still picked where its stock was held.
- `batches` are listed in the order first-expiry-first takes them, and `picks` is the API's suggestion over them.
  For a serial product `picks` is empty on purpose.
- The input has one entry per line, each with one to 20 picks (decision 15). `batchId: ''` is how the form says "no
  batch", turned into `null`, the same way the challan form does it (`optionalIdSchema`).
- The `superRefine` refuses a line twice (two entries would pack it twice) and a serial number twice across the
  whole order. It does not reuse `documentSerialRules`: that function knows only `lines → serialNumbers`, and here the
  serial numbers sit one level deeper, in `lines → picks`. Calling it on the flattened picks would put the error on
  a path the form does not have.
- Shipped, Delivered and "Make the sales order" send only the version (decision 21). Cancel adds a reason
  (`optionalText(200)`: an empty box is `null`), for the staff (decision 19).

### The routes

```ts
// ---------------------------------------------------------------------------------------------
// Routes

const idParamsSchema = z.object({ id: z.uuid() });

export const storefrontOrderRoutes = {
  listOrders: defineRoute({
    method: 'GET',
    path: '/storefront/orders',
    summary:
      "The shop's confirmed orders, a page at a time, by tab, searched and sorted on the server",
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    query: storefrontOrderQuerySchema,
    response: storefrontOrderPageSchema,
  }),
  countOrders: defineRoute({
    method: 'GET',
    path: '/storefront/orders/counts',
    summary: 'How many orders wait to be packed, for the sidebar',
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    response: storefrontOrderCountsSchema,
  }),
  getOrder: defineRoute({
    method: 'GET',
    path: '/storefront/orders/:id',
    summary: 'One order with its lines, its timeline and the ERP documents it made',
    auth: 'bearer',
    permission: 'storefront.order.read',
    status: 200,
    params: idParamsSchema,
    response: storefrontOrderSchema,
  }),
  makeSalesOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/sales-order',
    summary: 'Make the sales order again, after it failed when the order was confirmed',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  getPackPlan: defineRoute({
    method: 'GET',
    path: '/storefront/orders/:id/pack-plan',
    summary:
      'What the Packed dialog opens with: the warehouse, the batches and the suggested picks',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontPackPlanSchema,
  }),
  packOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/pack',
    summary: 'Packed: post the challan (stock out, cost of goods sold) and end the stock hold',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: packStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
  shipOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/ship',
    summary: 'Shipped: the parcel left the shop',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  deliverOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/deliver',
    summary: 'Delivered: post the invoice for the challan and the delivery charge',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontOrderVersionInputSchema,
    response: storefrontOrderSchema,
  }),
  cancelOrder: defineRoute({
    method: 'POST',
    path: '/storefront/orders/:id/cancel',
    summary: 'Cancel an order before it ships; a packed one gets a sales return of its challan',
    auth: 'bearer',
    permission: 'storefront.order.manage',
    status: 200,
    params: idParamsSchema,
    body: cancelStorefrontOrderInputSchema,
    response: storefrontOrderSchema,
  }),
};
```

| Route | What it does | Permission |
|---|---|---|
| `GET /storefront/orders` | the list, by tab | `storefront.order.read` |
| `GET /storefront/orders/counts` | the nav's count | `storefront.order.read` |
| `GET /storefront/orders/:id` | one order | `storefront.order.read` |
| `POST /storefront/orders/:id/sales-order` | make the sales order again | `storefront.order.manage` |
| `GET /storefront/orders/:id/pack-plan` | what the Packed dialog opens with | `storefront.order.manage` |
| `POST /storefront/orders/:id/pack` | Packed: the challan | `storefront.order.manage` |
| `POST /storefront/orders/:id/ship` | Shipped | `storefront.order.manage` |
| `POST /storefront/orders/:id/deliver` | Delivered: the invoice | `storefront.order.manage` |
| `POST /storefront/orders/:id/cancel` | Cancel | `storefront.order.manage` |

The pack plan is a `GET`, but it needs `.manage`: only someone who may pack needs it, and it lists the stock of each
batch, which a reader of orders has no reason to see. Every move answers the whole order, so the page draws the new
state from the answer with no second request.

`counts` sits beside `:id` in the same path. The API's controller must declare it first (27b.3), or Nest would try to
read `counts` as an order's id and answer 400.

```diff
@@ -65,6 +65,7 @@ export * from './storefront.js';
 export * from './storefront-content.js';
 export * from './storefront-admin.js';
 export * from './storefront-appearance.js';
+export * from './storefront-orders.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

```diff
@@ -21,6 +21,7 @@ import { fiscalYearRoutes, reportExportRoutes, reportRoutes } from './reports.js
 import { stockMovementReportRoutes } from './stock-movement-report.js';
 import { storefrontRoutes } from './storefront-admin.js';
 import { storefrontAppearanceRoutes } from './storefront-appearance.js';
+import { storefrontOrderRoutes } from './storefront-orders.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
@@ -159,4 +160,5 @@ export const routes = {
   publicStorefront: publicStorefrontRoutes,
   storefront: storefrontRoutes,
   storefrontAppearance: storefrontAppearanceRoutes,
+  storefrontOrders: storefrontOrderRoutes,
 };
```

The registry is what the API's `contract.spec.ts` compares with the routes it serves, and what writes the OpenAPI
document, so a route is real only once it is here.

### The delivery charge's service in the shop's settings

```diff
@@ -161,6 +161,14 @@ const warehouseIdSchema = z
   .transform((value) => (value === '' ? null : value))
   .nullable();
 
+// Step 27b: the service a shop order's delivery charge is sold as (decision 4). The select's
+// "Made on the first order" sends ''. Whether it is an active service, and whether it may be
+// empty (not once an order used one), the API checks
+const deliveryVariantIdSchema = z
+  .union([z.uuid(errorCode('storefront_delivery_product_invalid')), z.literal('')])
+  .transform((value) => (value === '' ? null : value))
+  .nullable();
+
 const settingsFieldsSchema = z.object({
   subdomain: storefrontSubdomainSchema,
   name: nameSchema(80),
@@ -184,6 +192,7 @@ const settingsFieldsSchema = z.object({
     .array(z.enum(SHOP_PAYMENT_METHODS))
     .min(1, errorCode('storefront_payment_required'))
     .transform((methods) => [...new Set(methods)]),
+  deliveryVariantId: deliveryVariantIdSchema,
 });
 
 // Two zones with one name would be two radio cards nobody can tell apart. Compared without case
@@ -246,6 +255,9 @@ export const storefrontSettingsSchema = z.object({
   freeDeliveryFrom: z.string().nullable(),
   minimumOrder: z.string().nullable(),
   paymentMethods: z.array(z.enum(SHOP_PAYMENT_METHODS)),
+  // Step 27b: the delivery charge's service. null until the first order makes one ("Delivery
+  // charge") or the tenant picks one
+  deliveryVariantId: z.uuid().nullable(),
   // null = not open yet: the address answers "No shop has this address"
   launchedAt: z.iso.datetime().nullable(),
   readiness: storefrontReadinessSchema,
@@ -268,6 +280,9 @@ export const storefrontSetupSchema = z.object({
     hotline: z.string(),
     address: z.string(),
   }),
+  // Step 27b: what the delivery charge select offers: the workspace's active services, by name.
+  // Here and not from the products list, because storefront.manage does not read products
+  deliveryChoices: z.array(z.object({ variantId: z.uuid(), name: z.string(), sku: z.string() })),
 });
 export type StorefrontSetup = z.infer<typeof storefrontSetupSchema>;
 
```

- `deliveryVariantId` is a variant, not a product: a sales order line names a variant, and a service is a product
  with one. Its box sends `''` for "made on the first order" (decision 4), like the warehouse select. A text that is
  not an id is `storefront_delivery_product_invalid` on the box itself.
- The settings answer has it as `null` until it is set. The setup answer gets `deliveryChoices` (decision 17).
- What the contract cannot know, the API checks: that the variant is an active service of this workspace, and that
  the box is not emptied once an order used one (`storefront_delivery_product_required`).

### Error codes and audit actions

```diff
@@ -706,6 +706,19 @@ export const ERROR_CODES = [
   'storefront_listing_invalid',
   // A text page saved with no section (Delete is the way to take a page out of the shop)
   'storefront_page_empty',
+  // Step 27b: the shop's orders in the ERP. A move the order's status does not take (Shipped on a
+  // new order, Cancel after it shipped), Packed before the sales order exists, a line of the order
+  // missing from Packed (or one it does not have, or one twice), picks that do not add up to the
+  // line's quantity
+  'storefront_order_step_invalid',
+  'storefront_order_no_sales_order',
+  'storefront_order_line_missing',
+  'storefront_order_line_twice',
+  'storefront_order_pick_total',
+  // The delivery charge's product in the shop's settings: not an active service of this
+  // workspace, or emptied after the first order made it (decision 4)
+  'storefront_delivery_product_invalid',
+  'storefront_delivery_product_required',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

- `storefront_order_step_invalid`: a move the order's status does not take. It also covers the second of two people
  pressing the same button: by the time the second one's request runs, the order has moved on, so the words say to
  reload.
- `storefront_order_no_sales_order`: Packed before the sales order exists. The challan is made from the sales order,
  so the words point at "Make the sales order".
- `storefront_order_line_missing`, `storefront_order_line_twice`, `storefront_order_pick_total`: Packed's lines.
- `storefront_delivery_product_invalid` and `storefront_delivery_product_required`: the settings box.

```diff
@@ -280,6 +280,15 @@ export const AUDIT_ACTIONS = [
   'storefront_collection.created',
   'storefront_collection.updated',
   'storefront_collection.deleted',
+  // Step 27b: a shop order's moves in the ERP (entity = storefront_order). The documents a move
+  // makes (sales order, challan, invoice, sales return) write their own entries as well, with the
+  // order's number in their changes. sales_order_made is the retry; the one made at confirm has
+  // no member, so the worker writes it with no actor
+  'storefront_order.sales_order_made',
+  'storefront_order.packed',
+  'storefront_order.shipped',
+  'storefront_order.delivered',
+  'storefront_order.cancelled',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -343,6 +352,7 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront_listing',
   'storefront_banner',
   'storefront_collection',
+  'storefront_order',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

Five actions on the order (decision 20), and `storefront_order` as an entity type, so the audit log's filter can show
an order's own history.

```diff
@@ -6475,6 +6475,7 @@ export const en = {
       storefront_listing: 'Shop listings',
       storefront_banner: 'Shop banners',
       storefront_collection: 'Shop collections',
+      storefront_order: 'Shop orders',
     },
     columns: {
       when: 'When',
@@ -6833,6 +6834,14 @@ export const en = {
         unpublished: 'Took a listing out of the shop',
         deleted: 'Deleted a shop listing',
       },
+      // Step 27b
+      storefront_order: {
+        sales_order_made: 'Made the sales order of a shop order',
+        packed: 'Marked a shop order packed',
+        shipped: 'Marked a shop order shipped',
+        delivered: 'Marked a shop order delivered',
+        cancelled: 'Cancelled a shop order',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -7978,6 +7987,17 @@ export const en = {
     storefront_listing_invalid: 'Pick a product from the shop’s catalog.',
     storefront_page_empty:
       'Write at least one section. To take the page out of the shop, delete it.',
+    storefront_order_step_invalid:
+      'This order has moved on since you opened it. Reload the page to see where it is now.',
+    storefront_order_no_sales_order:
+      'This order has no sales order yet. Choose Make the sales order first.',
+    storefront_order_line_missing: 'Pack every line of the order, and only its own lines.',
+    storefront_order_line_twice: 'This line is in the list twice. Remove one.',
+    storefront_order_pick_total:
+      'The batches and quantities must add up to what the shopper ordered for this line.',
+    storefront_delivery_product_invalid: 'Pick an active service, like Delivery charge.',
+    storefront_delivery_product_required:
+      'Orders already use a delivery charge service. Pick one; it can be another service.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6016,6 +6016,7 @@ export const bn: Messages = {
       storefront_listing: 'শপের লিস্টিং',
       storefront_banner: 'শপের ব্যানার',
       storefront_collection: 'শপের কালেকশন',
+      storefront_order: 'শপের অর্ডার',
     },
     columns: {
       when: 'কখন',
@@ -6363,6 +6364,13 @@ export const bn: Messages = {
         unpublished: 'লিস্টিং শপ থেকে সরিয়েছেন',
         deleted: 'শপের লিস্টিং মুছেছেন',
       },
+      storefront_order: {
+        sales_order_made: 'শপের অর্ডারের Sales Order বানিয়েছেন',
+        packed: 'শপের অর্ডার প্যাক হয়েছে বলে চিহ্ন দিয়েছেন',
+        shipped: 'শপের অর্ডার পাঠানো হয়েছে বলে চিহ্ন দিয়েছেন',
+        delivered: 'শপের অর্ডার পৌঁছেছে বলে চিহ্ন দিয়েছেন',
+        cancelled: 'শপের অর্ডার বাতিল করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -7453,6 +7461,16 @@ export const bn: Messages = {
     storefront_listing_twice: 'এই প্রোডাক্ট কালেকশনে দুইবার আছে। একটা সরান।',
     storefront_listing_invalid: 'শপের ক্যাটালগ থেকে একটা প্রোডাক্ট বাছুন।',
     storefront_page_empty: 'অন্তত একটা অংশ লিখুন। শপ থেকে পেজটা সরাতে চাইলে মুছে দিন।',
+    storefront_order_step_invalid:
+      'আপনি খোলার পরে অর্ডারটা এগিয়ে গেছে। এখন কোথায় আছে দেখতে পেজটা আবার লোড করুন।',
+    storefront_order_no_sales_order: 'এই অর্ডারের এখনো Sales Order নেই। আগে Sales Order বানান।',
+    storefront_order_line_missing: 'অর্ডারের প্রতিটা লাইন প্যাক করুন, শুধু এই অর্ডারের লাইন।',
+    storefront_order_line_twice: 'এই লাইন তালিকায় দুইবার আছে। একটা সরান।',
+    storefront_order_pick_total:
+      'ব্যাচ আর পরিমাণ মিলে ক্রেতা এই লাইনে যতটা চেয়েছে ঠিক ততটা হতে হবে।',
+    storefront_delivery_product_invalid: 'একটা চালু সার্ভিস বাছুন, যেমন ডেলিভারি চার্জ।',
+    storefront_delivery_product_required:
+      'অর্ডারে আগে থেকেই একটা ডেলিভারি চার্জের সার্ভিস আছে। একটা বাছুন, অন্য সার্ভিসও হতে পারে।',
   },
   ui: {
     dataTable: {
```

The type check needs words for every error code and every audit action (`satisfies Record<ErrorCode, string>` and
the audit words' own `satisfies`), so they come in this part; the screens' words come in 27b.5.

### Tests

```ts
import { describe, expect, it } from 'vitest';

import { SHOP_ORDER_STATUSES } from './storefront.js';
import {
  cancelStorefrontOrderInputSchema,
  packStorefrontOrderInputSchema,
  STOREFRONT_ORDER_STATUSES,
  storefrontOrderQuerySchema,
  storefrontOrderRoutes,
  type PackStorefrontOrderFormValues,
} from './storefront-orders.js';

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

const BATCH_A = '7d0c1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e5f';
const BATCH_B = '8e1d2f30-4b5c-4d6e-9f70-1b2c3d4e5f60';

// Two lines: 3 pieces of a batch product split over two batches, and one phone with its IMEI
const PACK: PackStorefrontOrderFormValues = {
  version: 4,
  lines: [
    {
      position: 1,
      picks: [
        { batchId: BATCH_A, quantity: '2', serialNumbers: [] },
        { batchId: BATCH_B, quantity: '1', serialNumbers: [] },
      ],
    },
    {
      position: 2,
      picks: [{ batchId: '', quantity: '1', serialNumbers: ['356938035643809'] }],
    },
  ],
};

describe('the statuses the ERP shows', () => {
  it('are every status of a shop order but pending, in the same order', () => {
    expect(STOREFRONT_ORDER_STATUSES).toEqual(
      SHOP_ORDER_STATUSES.filter((status) => status !== 'pending'),
    );
    expect(STOREFRONT_ORDER_STATUSES).not.toContain('pending');
  });

  it('opens the list on the new orders, newest first', () => {
    expect(storefrontOrderQuerySchema.parse({})).toMatchObject({
      view: 'confirmed',
      sort: '-confirmed',
    });
  });

  it('has no tab for orders that wait for their code', () => {
    expect(storefrontOrderQuerySchema.safeParse({ view: 'pending' }).success).toBe(false);
  });
});

describe('Packed', () => {
  it('takes a line split over two batches, and no batch as null', () => {
    const parsed = packStorefrontOrderInputSchema.parse(PACK);
    expect(parsed.lines[0]?.picks.map((pick) => pick.batchId)).toEqual([BATCH_A, BATCH_B]);
    expect(parsed.lines[1]?.picks[0]?.batchId).toBeNull();
  });

  it('refuses a line twice, on the second one', () => {
    const second = PACK.lines[1];
    if (second === undefined) throw new Error('PACK has two lines');
    const result = packStorefrontOrderInputSchema.safeParse({
      ...PACK,
      lines: [
        ...PACK.lines,
        { ...second, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
      ],
    });
    expect(errorsOf(result)).toEqual({ 'lines.2.position': ['storefront_order_line_twice'] });
  });

  it('refuses one serial number scanned on two lines, on the second box', () => {
    const result = packStorefrontOrderInputSchema.safeParse({
      ...PACK,
      lines: [
        PACK.lines[1],
        {
          position: 3,
          picks: [{ batchId: '', quantity: '1', serialNumbers: ['356938035643809'] }],
        },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'lines.1.picks.0.serialNumbers.0': ['stock_serial_twice'],
    });
  });

  it('refuses a pick of nothing, and a line with no pick', () => {
    const result = packStorefrontOrderInputSchema.safeParse({
      version: 4,
      lines: [
        { position: 1, picks: [{ batchId: BATCH_A, quantity: '0', serialNumbers: [] }] },
        { position: 2, picks: [] },
      ],
    });
    expect(Object.keys(errorsOf(result)).sort()).toEqual([
      'lines.0.picks.0.quantity',
      'lines.1.picks',
    ]);
  });
});

describe('Cancel', () => {
  it('keeps no reason as null, and refuses a long one', () => {
    expect(cancelStorefrontOrderInputSchema.parse({ version: 2, reason: '  ' }).reason).toBeNull();
    expect(
      cancelStorefrontOrderInputSchema.safeParse({ version: 2, reason: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('the routes', () => {
  const routes = Object.values(storefrontOrderRoutes);

  it('are all behind the ERP login, under /storefront/orders', () => {
    for (const route of routes) {
      expect(route.auth).toBe('bearer');
      expect(route.path.startsWith('/storefront/orders')).toBe(true);
    }
  });

  // Decision 9: a packer reads and moves orders without storefront.manage (the shop's prices and
  // pages), and every move is .manage, never .read
  it('read with storefront.order.read and change with storefront.order.manage', () => {
    for (const route of routes) {
      const changes = route.method !== 'GET' || route.path.endsWith('/pack-plan');
      expect([route.path, route.permission]).toEqual([
        route.path,
        changes ? 'storefront.order.manage' : 'storefront.order.read',
      ]);
    }
  });
});
```

- The statuses: every shop status but `pending`, in the same order, and no `pending` tab.
- The list's defaults: New, newest first.
- Packed: a line split over two batches, `''` as `null`, a line twice and a serial number twice with the error on the
  right box, and a pick of nothing.
- The routes: all `bearer` under `/storefront/orders`, reads with `.read`, the pack plan and every move with
  `.manage` (decision 9). A new route has to fit one of the two on purpose.

```diff
@@ -162,6 +162,7 @@ const SETTINGS = {
   freeDeliveryFrom: '',
   minimumOrder: '',
   paymentMethods: ['cod'],
+  deliveryVariantId: '',
 } as const;
 
 describe('the shop settings', () => {
@@ -171,9 +172,27 @@ describe('the shop settings', () => {
       defaultWarehouseId: null,
       freeDeliveryFrom: null,
       minimumOrder: null,
+      deliveryVariantId: null,
     });
   });
 
+  // Step 27b: the delivery charge's service (decision 4)
+  it('keeps a picked delivery service, and refuses one that is not an id', () => {
+    const variantId = '0b9f2c4e-7a51-4c3d-9e8f-1a2b3c4d5e6f';
+    expect(
+      createStorefrontSettingsInputSchema.parse({ ...SETTINGS, deliveryVariantId: variantId })
+        .deliveryVariantId,
+    ).toBe(variantId);
+    expect(
+      errorsOf(
+        createStorefrontSettingsInputSchema.safeParse({
+          ...SETTINGS,
+          deliveryVariantId: 'delivery',
+        }),
+      ),
+    ).toEqual({ deliveryVariantId: ['storefront_delivery_product_invalid'] });
+  });
+
   it('keeps a zone id when it has one, and names a new zone null', () => {
     const parsed = updateStorefrontSettingsInputSchema.parse({
       ...SETTINGS,
```

The settings fixture gets the new box, and one test checks that a picked service is kept and a text that is not an id
is refused on the box.

### Check this part

```bash
pnpm --filter @omnivo/contracts build
pnpm --filter @omnivo/contracts test        # 636 tests
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/db build              # its audit types come from the contracts
pnpm --filter @omnivo/shop typecheck        # clean: the shop does not use these routes
```

Two things fail until later parts, on purpose:

- `pnpm --filter @omnivo/api typecheck` and `pnpm --filter @omnivo/app typecheck`: the settings now have
  `deliveryVariantId` and `deliveryChoices`, which the API's settings service (27b.3) and the app's settings form and
  mocks (27b.6, 27b.7) do not fill yet.
- `apps/api/src/contract.spec.ts`: the contract has 9 routes the API does not serve yet (27b.3).

Broken on purpose while this part was written, each caught:

- `shipOrder` given `storefront.order.read`: "read with storefront.order.read and change with
  storefront.order.manage" fails.
- The line-twice check turned off: "refuses a line twice, on the second one" fails.

## 27b.2 — Database

No new table. The order gets the links to the documents it makes, the error of a sales order that could not be
made, and the cancel reason; the shop's settings get the delivery charge's service. One migration, made by
drizzle-kit: every rule here is a column, a foreign key, an index or a check, and no role gets a new right.

### The order's documents

```diff
@@ -25,7 +25,10 @@ import {
   uuid,
 } from 'drizzle-orm/pg-core';
 import { baseColumns } from '../base-columns.js';
+import { invoices } from './invoices.js';
 import { productVariants } from './products.js';
+import { deliveries, salesOrders } from './sales-documents.js';
+import { salesReturns } from './sales-returns.js';
 import { tenants } from './tenants.js';
 import { warehouses } from './warehouses.js';
 
@@ -101,6 +104,22 @@ export const storefrontOrders = pgTable(
     deliveredAt: timestamp('delivered_at', { withTimezone: true }),
     cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
     returnedAt: timestamp('returned_at', { withTimezone: true }),
+    // Step 27b: the ERP documents the order made, each NULL until its step. The link lives here
+    // and not on the documents: a sales order or a challan does not need to know it came from the
+    // shop, and the sales tables stay as every other sale writes them. The sales order (and its
+    // customer) is made by the confirm event's handler (decision 1)
+    salesOrderId: uuid('sales_order_id'),
+    // The posted challan made at Packed (decision 5)
+    deliveryId: uuid('delivery_id'),
+    // The posted invoice made at Delivered (decision 7)
+    invoiceId: uuid('invoice_id'),
+    // The posted sales return made when a packed order is cancelled (decision 8)
+    salesReturnId: uuid('sales_return_id'),
+    // Why the handler could not make the sales order (decision 16): an error code
+    // ("sales_variant_archived"), never a message. The page shows it with t('errors.…')
+    documentError: text('document_error'),
+    // What the member typed when cancelling, for the staff only (decision 19)
+    cancelReason: text('cancel_reason'),
   },
   (table) => [
     // The target of the lines' and the holds' FKs. A constraint, not a uniqueIndex like the other
```

- **The link is on the order, not on the documents.** A sales order, a challan or an invoice made for the shop is an
  ordinary document: the sales tables stay as every other sale writes them, and no screen of theirs changes. The
  order's page reads the four ids; a document's own page does not need to know where it came from, and its audit
  entry names the shop order (decision 9).
- **No `customer_id`.** The customer is the sales order's (decision 2), and both are made in one transaction, so the
  page reads it through `sales_order_id`. A second copy could only disagree.
- **`document_error` is an error code, not a message** (decision 16). The page writes it with `t('errors.…')`, in
  the reader's language. A message from an exception would be English, and might say something about the database
  that the staff has no use for.
- **`cancel_reason`** is for the staff only (decision 19): no shop route reads it into an answer, and the cancel's
  SMS (27b.3) is a fixed sentence.

```diff
@@ -181,6 +200,76 @@ export const storefrontOrders = pgTable(
         AND (${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL)
         AND (${table.status} = 'returned') = (${table.returnedAt} IS NOT NULL)`,
     ),
+    // Step 27b: the list's tabs ("New" = confirmed) and the nav's count, newest first. Partial:
+    // the ERP never shows a pending order (decision 13), and the pending ones come and go
+    index('storefront_orders_list_idx')
+      .on(table.tenantId, table.status, table.confirmedAt.desc())
+      .where(sql`${table.status} <> 'pending'`),
+    // One document belongs to one order. 27b.3 writes each link once; unique all the same, so a
+    // bug that linked one challan to two orders fails here instead of packing one parcel twice
+    uniqueIndex('storefront_orders_sales_order_idx')
+      .on(table.tenantId, table.salesOrderId)
+      .where(sql`${table.salesOrderId} IS NOT NULL`),
+    uniqueIndex('storefront_orders_delivery_idx')
+      .on(table.tenantId, table.deliveryId)
+      .where(sql`${table.deliveryId} IS NOT NULL`),
+    uniqueIndex('storefront_orders_invoice_idx')
+      .on(table.tenantId, table.invoiceId)
+      .where(sql`${table.invoiceId} IS NOT NULL`),
+    uniqueIndex('storefront_orders_sales_return_idx')
+      .on(table.tenantId, table.salesReturnId)
+      .where(sql`${table.salesReturnId} IS NOT NULL`),
+    // Documents of this workspace. No ON DELETE: a posted document is never deleted, and the
+    // sales order is made confirmed, so it is never a draft that could be
+    foreignKey({
+      name: 'storefront_orders_sales_order_fk',
+      columns: [table.tenantId, table.salesOrderId],
+      foreignColumns: [salesOrders.tenantId, salesOrders.id],
+    }),
+    foreignKey({
+      name: 'storefront_orders_delivery_fk',
+      columns: [table.tenantId, table.deliveryId],
+      foreignColumns: [deliveries.tenantId, deliveries.id],
+    }),
+    foreignKey({
+      name: 'storefront_orders_invoice_fk',
+      columns: [table.tenantId, table.invoiceId],
+      foreignColumns: [invoices.tenantId, invoices.id],
+    }),
+    foreignKey({
+      name: 'storefront_orders_sales_return_fk',
+      columns: [table.tenantId, table.salesReturnId],
+      foreignColumns: [salesReturns.tenantId, salesReturns.id],
+    }),
+    // Each document comes after the one it is made from, and at its step: a challan only with a
+    // sales order, an invoice and a return only with a challan. Packed, Shipped and Delivered
+    // always have their challan, Delivered its invoice, and a cancel after Packed its return. A
+    // pending order has none of them: omnivo_shop may INSERT whole rows, and this keeps it from
+    // placing an order that points at a sales order
+    check(
+      'storefront_orders_documents_check',
+      sql`(${table.deliveryId} IS NULL OR ${table.salesOrderId} IS NOT NULL)
+        AND (${table.invoiceId} IS NULL OR ${table.deliveryId} IS NOT NULL)
+        AND (${table.salesReturnId} IS NULL OR (${table.deliveryId} IS NOT NULL AND ${table.status} = 'cancelled'))
+        AND (${table.status} NOT IN ('packed', 'shipped', 'delivered') OR ${table.deliveryId} IS NOT NULL)
+        AND (${table.status} <> 'delivered' OR ${table.invoiceId} IS NOT NULL)
+        AND (${table.status} <> 'cancelled' OR ${table.packedAt} IS NULL OR ${table.salesReturnId} IS NOT NULL)
+        AND (${table.status} <> 'pending' OR num_nonnulls(${table.salesOrderId}, ${table.documentError}) = 0)`,
+    ),
+    // An error code in snake_case, and only while there is no sales order: once the retry made
+    // it, the error is out of date. The pattern keeps a bug from storing an exception's message,
+    // which the page would then show to the staff as it is
+    check(
+      'storefront_orders_document_error_check',
+      sql`${table.documentError} IS NULL OR (${table.salesOrderId} IS NULL
+        AND ${table.documentError} ~ '^[a-z][a-z0-9_]{0,63}$')`,
+    ),
+    // The reason belongs to a cancelled order, 1 to 200 characters (cancelStorefrontOrderInputSchema)
+    check(
+      'storefront_orders_cancel_reason_check',
+      sql`${table.cancelReason} IS NULL OR (${table.status} = 'cancelled'
+        AND char_length(${table.cancelReason}) BETWEEN 1 AND 200)`,
+    ),
   ],
 );
 
```

- **`storefront_orders_list_idx`** answers the list's tabs and the nav's count: one workspace, one status, newest
  first. Partial on `status <> 'pending'`, because the ERP never shows a pending order (decision 13), and pending rows
  come and go all day; leaving them out keeps the index small and its writes few.
- **The four unique indexes** say a document belongs to one order. 27b.3 writes each link once, inside the move's
  transaction, but a bug that linked one challan to two orders would mark two parcels packed with one box. Unique
  makes that bug fail at once. Partial on `IS NOT NULL`, like the tracking token's: most orders have no invoice yet.
- **The foreign keys are composite** (`tenant_id` and the id), as on every document line: an id from another workspace
  matches nothing and is refused, whatever the API checked. No `ON DELETE`: a posted document is never deleted, and
  the sales order is made confirmed, so it is never a draft someone could delete.
- **`storefront_orders_documents_check`** writes down the order the documents come in. A challan only with a sales
  order (it is made from it), an invoice and a return only with a challan (both are made from its lines). Packed,
  Shipped and Delivered always have their challan, Delivered its invoice, and a cancelled order that was packed its
  sales return: without it, the goods that left with the challan would be gone from the books. Which move may follow
  which is still 27b.3's (27a's `storefront_orders_steps_check` says the same): the database only refuses a state
  that cannot be true.
- **The last line of that check is for `omnivo_shop`.** That role may `INSERT` whole rows (27a.2), so without it a bug
  in the place route could write an order that points at a sales order. A pending order has no document and no
  document error.
- **`storefront_orders_document_error_check`** keeps the error only while there is no sales order: once the retry
  made it, the old error would be a lie. The pattern (`snake_case`, at most 64) is what every `ERROR_CODES` entry
  looks like. A list of the codes would need a migration for every new error; the pattern stops what matters, an
  exception's message stored by mistake.
- **`storefront_orders_cancel_reason_check`**: a reason only on a cancelled order, and the contract's 200 characters
  (`cancelStorefrontOrderInputSchema`).

**What is not here, on purpose: a search index.** The list's search looks for part of the number, the name or the
phone (`LIKE '%…%'`). The customers have trigram indexes for that (0026), and the first draft of this part added
three for the orders. A check on 5,000 and then 50,000 orders showed Postgres never uses them for the ERP: the table
has row security, a trigram index works through the `LIKE` operator, and `LIKE` is not marked *leakproof* (proved
never to show anything about a row through an error). Postgres does not run such an operator before the tenant
rule, so the only index it can use is the one on `tenant_id`. As the superuser, which skips row security, the same
query could use all three. So the search reads one workspace's orders through `storefront_orders_list_idx` and filters
them, which takes a few milliseconds at a shop's volume, and the database keeps no indexes that are never read.

### The delivery charge's service

```diff
@@ -116,6 +116,12 @@ export const storefrontSettings = pgTable(
       .$type<ShopPaymentMethod[]>()
       .notNull()
       .default(sql`'{cod}'::text[]`),
+    // Step 27b: the service product the sales order's delivery charge line names (decision 4).
+    // NULL until the first order with a charge makes "Delivery charge", or the tenant picks one.
+    // Both ids, because a sales order line names a variant by its product too (the variant FK
+    // below is the lines' own)
+    deliveryProductId: uuid('delivery_product_id'),
+    deliveryVariantId: uuid('delivery_variant_id'),
     launchedAt: timestamp('launched_at', { withTimezone: true }),
     createdAt: baseColumns().createdAt,
     updatedAt: baseColumns().updatedAt,
@@ -167,6 +173,19 @@ export const storefrontSettings = pgTable(
     // be deleted (the later unused-photo cleanup must skip it anyway). NULL skips the check, as in
     // every composite FK here. storefrontImages is defined further down; drizzle reads this list
     // only after the whole file has run
+    // A variant of this workspace. A composite FK is skipped when any of its columns is NULL, so
+    // the check makes the two ids go together: a product id alone would skip the FK and name
+    // nothing. Whether it is an active service is the API's rule (27b.3): a product can be
+    // archived later, and the next order then says so instead of failing here
+    foreignKey({
+      name: 'storefront_settings_delivery_variant_fk',
+      columns: [table.tenantId, table.deliveryProductId, table.deliveryVariantId],
+      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
+    }),
+    check(
+      'storefront_settings_delivery_check',
+      sql`(${table.deliveryProductId} IS NULL) = (${table.deliveryVariantId} IS NULL)`,
+    ),
     foreignKey({
       name: 'storefront_settings_logo_fk',
       columns: [table.tenantId, table.logoImageId],
```

- **Two ids, the product and the variant.** A sales order line names its variant by the pair
  (`sales_order_lines`' variant key), and so does this foreign key. The settings answer gives only
  `deliveryVariantId` (27b.1); the API reads the product with it.
- **`storefront_settings_delivery_check`.** A composite foreign key is skipped when any of its columns is NULL
  (`MATCH SIMPLE`, Postgres's default). Without the check, a product id with no variant would pass the foreign key and
  name nothing.
- **Whether it is an active service is not a database rule.** A product can be archived after it was picked; the next
  order's sales order then fails with the sales order's own error, shown on the order with the retry (decision 16),
  instead of every save of the settings failing here.
- The shop's pages (`omnivo_public`) can read the two new columns, because 0064 gave that role the whole settings
  table. They are two ids and say nothing a shopper could use; a column grant would mean rewriting 0064's grant for
  no gain.

### The migration

```sql
ALTER TABLE "storefront_settings" ADD COLUMN "delivery_product_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD COLUMN "delivery_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "sales_return_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "document_error" text;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_delivery_variant_fk" FOREIGN KEY ("tenant_id","delivery_product_id","delivery_variant_id") REFERENCES "public"."product_variants"("tenant_id","product_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_sales_order_fk" FOREIGN KEY ("tenant_id","sales_order_id") REFERENCES "public"."sales_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "public"."deliveries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "public"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_sales_return_fk" FOREIGN KEY ("tenant_id","sales_return_id") REFERENCES "public"."sales_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_orders_list_idx" ON "storefront_orders" USING btree ("tenant_id","status","confirmed_at" DESC NULLS LAST) WHERE "storefront_orders"."status" <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_sales_order_idx" ON "storefront_orders" USING btree ("tenant_id","sales_order_id") WHERE "storefront_orders"."sales_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_delivery_idx" ON "storefront_orders" USING btree ("tenant_id","delivery_id") WHERE "storefront_orders"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_invoice_idx" ON "storefront_orders" USING btree ("tenant_id","invoice_id") WHERE "storefront_orders"."invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_orders_sales_return_idx" ON "storefront_orders" USING btree ("tenant_id","sales_return_id") WHERE "storefront_orders"."sales_return_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "storefront_settings" ADD CONSTRAINT "storefront_settings_delivery_check" CHECK (("storefront_settings"."delivery_product_id" IS NULL) = ("storefront_settings"."delivery_variant_id" IS NULL));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_documents_check" CHECK (("storefront_orders"."delivery_id" IS NULL OR "storefront_orders"."sales_order_id" IS NOT NULL)
        AND ("storefront_orders"."invoice_id" IS NULL OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."sales_return_id" IS NULL OR ("storefront_orders"."delivery_id" IS NOT NULL AND "storefront_orders"."status" = 'cancelled'))
        AND ("storefront_orders"."status" NOT IN ('packed', 'shipped', 'delivered') OR "storefront_orders"."delivery_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'delivered' OR "storefront_orders"."invoice_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'cancelled' OR "storefront_orders"."packed_at" IS NULL OR "storefront_orders"."sales_return_id" IS NOT NULL)
        AND ("storefront_orders"."status" <> 'pending' OR num_nonnulls("storefront_orders"."sales_order_id", "storefront_orders"."document_error") = 0));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_document_error_check" CHECK ("storefront_orders"."document_error" IS NULL OR ("storefront_orders"."sales_order_id" IS NULL
        AND "storefront_orders"."document_error" ~ '^[a-z][a-z0-9_]{0,63}$'));--> statement-breakpoint
ALTER TABLE "storefront_orders" ADD CONSTRAINT "storefront_orders_cancel_reason_check" CHECK ("storefront_orders"."cancel_reason" IS NULL OR ("storefront_orders"."status" = 'cancelled'
        AND char_length("storefront_orders"."cancel_reason") BETWEEN 1 AND 200));
```

Made by drizzle-kit from the two schema files:

```bash
pnpm --filter @omnivo/db generate --name storefront-order-documents
```

It adds only NULL columns and checks that every existing row passes: an order confirmed under 27a has no document, no
error and no reason, so it stays as it is. Such an order has no sales order either, because 27a's handler only rang
the bell; 27b.3's order page offers "Make the sales order" for it, like for a failed one.

No grants. `omnivo_app` (the ERP's screens and the worker's handler) gets every column of a new table and of a new
column by the migrator's default privileges, as always. `omnivo_shop` got column `UPDATE` grants in 0071, which by
their nature do not reach a column added later: the shop's routes cannot write a document link, an error or a reason
(checked below). It keeps reading the whole row, which 27a's routes do.

### The seed script

```diff
@@ -196,6 +196,8 @@ export function settingsBody(subdomain: string, warehouseId: string): SettingsBo
     freeDeliveryFrom: mockCheckoutSettings.freeDeliveryFrom,
     minimumOrder: mockCheckoutSettings.minimumOrder,
     paymentMethods: [...mockCheckoutSettings.paymentMethods],
+    // Step 27b: none picked, so the first order with a charge makes "Delivery charge" itself
+    deliveryVariantId: null,
   };
 }
 
```

26h's seed sends the shop's settings with the API's own body type, so 27b.1's new `deliveryVariantId` made it stop
type-checking (`pnpm --filter @omnivo/shop typecheck` checks `scripts/` too). `null` is "none picked": the first
seeded order with a delivery charge makes "Delivery charge" itself, as in a real shop (decision 4).

### Check this part

```bash
pnpm --filter @omnivo/db build && pnpm --filter @omnivo/db typecheck
pnpm --filter @omnivo/shop typecheck
pnpm db:migrate
```

`pnpm --filter @omnivo/api typecheck` and `pnpm --filter @omnivo/app typecheck` still fail as after 27b.1, on the
settings' new fields, until 27b.3 and 27b.6.

What was checked on a throwaway Postgres 17, migrated to the end, with 27a.2's two shops plus a customer, a service
product, one draft of each document and two confirmed orders. As `omnivo_app`:

- an error code is kept, a sentence is refused, and so is a sales order beside an error; another workspace's sales
  order is refused by the foreign key, and one sales order on two orders by the unique index;
- a challan without a sales order, Packed without a challan, Delivered without an invoice, a return on an order that
  is not cancelled, and a packed order cancelled without a return are each refused by
  `storefront_orders_documents_check`; the same cancel with its return passes, and so do Packed, Shipped and Delivered
  with their documents;
- a reason on an order that is not cancelled, or of 201 characters, is refused; a cancel with a reason passes;
- the settings refuse a product without its variant, and a variant with another product's id; the real pair is kept.

As `omnivo_shop`: writing `sales_order_id`, `document_error` or `cancel_reason` is refused (42501), placing a pending
order with a sales order is refused by the documents check, and it still reads both orders. With 5,000 orders in one
shop, the New tab's query uses `storefront_orders_list_idx`.

Broken on purpose, each caught:

- `storefront_orders_documents_check` dropped: a challan without a sales order is kept.
- `GRANT UPDATE (sales_order_id) ON storefront_orders TO omnivo_shop`: the shop's role can write the link.
- `storefront_settings_delivery_check` dropped: a product id alone is kept.

## 27b.3 — API

The API does three things in this part. The confirm event's handler makes the order's customer and sales order in
the worker. Nine routes behind Storefront → Shop orders list the orders and move them on, each move making its ERP
documents in the same transaction as its new status. And the shop's settings get the delivery charge's service.

Nothing here writes a sales document by hand. Every document is made by the sales service that makes it from the
ERP's own screens, so a shop sale is checked, numbered, posted and booked exactly like a phone sale. Those services
open their own transaction in every public method, so this part gives each one an entry point that works inside
the caller's transaction (decision 23). That is most of the changes to code you already have.

### Work with no member behind it

```diff
@@ -35,6 +35,14 @@ export function currentPrincipal(): Principal {
   return principal;
 }
 
+// Step 27b: who did the work, for the created_by / updated_by columns: the signed-in member, or
+// null for work the system does by itself (the worker making a shop order's sales order, 27b's
+// decision 20). Only code that both a route and a background job reach uses this; everything a
+// route alone reaches keeps currentPrincipal(), whose throw catches a route left public by mistake
+export function currentActorId(): string | null {
+  return tenantStorage.getStore()?.principal?.userId ?? null;
+}
+
 // Step 18b: run one pushed command as the device's work. The tenant and the person stay as they
 // are; only the device is added, so every audit row the command's services write names it without
 // each service passing it on.
```

The worker has a tenant but no signed-in member. Every service writes `created_by` and `updated_by` with
`currentPrincipal().userId`, which throws without a member, on purpose: a route marked public by mistake fails loudly
instead of writing rows nobody made. `currentActorId()` gives NULL instead, and it is used only on the few paths the
worker reaches (decision 22). The columns already take NULL (`baseColumns()`), and `audit()` already writes a NULL
actor when there is no member, so the audit log shows these rows as the system's.

```diff
@@ -29,6 +29,11 @@ const stillToBill = sql<string>`coalesce(sum(round(
          ELSE ${salesOrderLines.invoicedQuantity} END
     - ${salesOrderLines.invoicedQuantity}, 0) / ${salesOrderLines.baseQuantity}, 2)), 0)::text`;
 
+// true: the member saw the amounts in a dialog and goes ahead (needs sales.credit.override).
+// 'storefront_order' (step 27b): a shop order's sales order, made by the worker with no member
+// behind it; over the limit it still goes through, and the audit log keeps the same row
+export type CreditOverride = boolean | 'storefront_order';
+
 // The credit limit (step 15c, you chose this): checked when an order is confirmed and when an
 // invoice is posted. What counts is the customer's exposure: what they owe now (the receivable
 // lines with them, the same number as their balance) plus what confirmed orders will still bill.
@@ -93,7 +98,7 @@ export class CreditService {
     input: {
       customerId: string;
       before: string;
-      overrideCreditLimit: boolean;
+      overrideCreditLimit: CreditOverride;
       entityType: 'sales_order' | 'invoice';
       entityId: string;
     },
@@ -114,8 +119,13 @@ export class CreditService {
         { params: { limit, exposure } },
       );
     }
-    const access = await this.permissions.ofCurrentUser();
-    if (!access.permissions.includes('sales.credit.override')) {
+    // A shop order has no member to ask: the shopper's order stands, like a POS sale (27b's
+    // decision 2), and the audit row below is how the staff find it
+    const access =
+      input.overrideCreditLimit === 'storefront_order'
+        ? null
+        : await this.permissions.ofCurrentUser();
+    if (access !== null && !access.permissions.includes('sales.credit.override')) {
       throw new AppError(
         403,
         'credit_override_forbidden',
```

- **`CreditOverride`.** `true` still means a member saw the amounts in a dialog and goes ahead, and still needs
  `sales.credit.override`. `'storefront_order'` is the shop's sales order (decision 2): there is no member to ask,
  the shopper's order must not fail for a limit the shopper never saw, and a POS sale already works this way.
- **The audit row is the same one.** A filter on `credit_limit.overridden` lists every override in the workspace, the
  shop's included; the row's actor is NULL, which is how the staff can tell it was the shop.
- **Why a third value and not a skipped check:** `check()` still works out the exposure and still writes nothing
  when the customer stays under the limit. Only the question "may this person go over?" changes.

### The sales order, the customer and the product

```diff
@@ -24,12 +24,12 @@ import { z } from 'zod';
 import { audit, created, diff } from '../common/audit/audit.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { currentActorId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { assertWarehousesActive } from '../inventory/stock-lines.js';
 import { NumberingService } from '../numbering/numbering.service.js';
-import { CreditService } from './credit.service.js';
+import { type CreditOverride, CreditService } from './credit.service.js';
 import {
   assertCustomer,
   customerRefs,
@@ -324,29 +324,57 @@ export class SalesOrdersService {
   // Called off before anything left the warehouse
   cancel(id: string, version: number): Promise<SalesOrder> {
     return this.withTenant(async (tx) => {
-      const row = await this.lock(tx, id, version);
-      if (row.status !== 'confirmed') throw notConfirmed();
-      if (await this.anythingDelivered(tx, id)) {
-        throw new AppError(
-          409,
-          'order_partly_delivered',
-          'Some of this order was delivered. Close it instead.',
-        );
-      }
-      // A billed service line: the customer owes for it, so the order did happen (step 15c)
-      if (await this.anythingInvoiced(tx, id)) throw hasInvoices();
-      await this.write(tx, id, { status: 'cancelled' });
-      await audit(tx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id });
+      await this.cancelIn(tx, id, version);
       return this.read(tx, id);
     });
   }
 
+  // Step 27b: the cancel itself, in the caller's transaction: the order page's Cancel above, and a
+  // shop order's cancel (StorefrontOrdersService), which holds the shop order's lock and passes
+  // null for the version (the member saw the shop order's version, not this one's)
+  async cancelIn(tx: Transaction, id: string, version: number | null): Promise<void> {
+    const row = await this.lock(tx, id, version);
+    if (row.status !== 'confirmed') throw notConfirmed();
+    if (await this.anythingDelivered(tx, id)) {
+      throw new AppError(
+        409,
+        'order_partly_delivered',
+        'Some of this order was delivered. Close it instead.',
+      );
+    }
+    // A billed service line: the customer owes for it, so the order did happen (step 15c)
+    if (await this.anythingInvoiced(tx, id)) throw hasInvoices();
+    await this.write(tx, id, { status: 'cancelled' });
+    await audit(tx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id });
+  }
+
+  // Step 27b: a shop order's sales order (decisions 1 to 3), in the caller's transaction, by the
+  // worker (no member: currentActorId() is null) or by "Make the sales order" (a member). Confirmed
+  // at once, with its prices including VAT whatever the workspace's setting, so its total is the
+  // shop's total to the paisa. Over the customer's credit limit it still goes (the audit log says
+  // so). `shippingAddress`: the address the shopper typed for this order, kept as the document's
+  // text; the customer's saved addresses are not touched. Returns the order's id.
+  async createForShop(
+    tx: Transaction,
+    input: SalesOrderDraftInput,
+    shippingAddress: string,
+  ): Promise<string> {
+    const row = await this.insert(tx, { ...input, quotationId: null }, null, {
+      pricesIncludeVat: true,
+      shippingAddress,
+    });
+    await this.confirmAndLog(tx, row, 'storefront_order');
+    return row.id;
+  }
+
   // A new draft, its lines and its audit row: the form's order (confirmed after, when asked) and
   // a device's draft (step 18b). `id` is the device's id, or null for the database's own.
   private async insert(
     tx: Transaction,
     input: SalesOrderDraftInput & { quotationId: string | null },
     id: string | null,
+    // Step 27b: a shop order's (createForShop)
+    shop: { pricesIncludeVat: boolean; shippingAddress: string } | null = null,
   ): Promise<OrderRow> {
     const customer = await assertCustomer(tx, input.customerId);
     await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
@@ -355,7 +383,8 @@ export class SalesOrdersService {
       input.quotationId === null ? null : await this.openQuotation(tx, input.quotationId, customer);
     // An order made from a quotation reads its prices the way the quotation did: the form copied
     // them from there. Otherwise the workspace setting now.
-    const pricesIncludeVat = quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
+    const pricesIncludeVat =
+      shop?.pricesIncludeVat ?? quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
     const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
     const [row] = await tx
       .insert(salesOrders)
@@ -368,13 +397,13 @@ export class SalesOrdersService {
         customerReference: input.customerReference,
         warehouseId: input.warehouseId,
         shippingAddressId: address?.id ?? null,
-        shippingAddress: address?.text ?? null,
+        shippingAddress: address?.text ?? shop?.shippingAddress ?? null,
         quotationId: quotation?.id ?? null,
         pricesIncludeVat,
         note: input.note,
         ...documentTotals(lines.map((line) => line.amounts)),
-        createdBy: currentPrincipal().userId,
-        updatedBy: currentPrincipal().userId,
+        createdBy: currentActorId(),
+        updatedBy: currentActorId(),
       })
       .returning();
     if (!row) throw new Error('Sales order insert returned no row');
@@ -401,7 +430,7 @@ export class SalesOrdersService {
   private async confirmAndLog(
     tx: Transaction,
     draft: OrderRow,
-    overrideCreditLimit: boolean,
+    overrideCreditLimit: CreditOverride,
   ): Promise<void> {
     const before = await this.credit.lock(tx, draft.customerId);
     const number = draft.number ?? (await this.numbering.next(tx, 'sales.order', draft.date));
@@ -409,7 +438,7 @@ export class SalesOrdersService {
       status: 'confirmed',
       number,
       confirmedAt: new Date(),
-      confirmedBy: currentPrincipal().userId,
+      confirmedBy: currentActorId(),
     });
     await audit(tx, {
       action: 'sales_order.confirmed',
@@ -533,7 +562,7 @@ export class SalesOrdersService {
       .set({
         ...fields,
         version: sql`${salesOrders.version} + 1`,
-        updatedBy: currentPrincipal().userId,
+        updatedBy: currentActorId(),
       })
       .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)));
   }
@@ -555,14 +584,15 @@ export class SalesOrdersService {
 
   // FOR UPDATE: every change to an order takes turns with the others, and with a delivery being
   // posted against it (DeliveriesService locks the order the same way)
-  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
+  // version null: no check (cancelIn from a shop order)
+  private async lock(tx: Transaction, id: string, version: number | null): Promise<OrderRow> {
     const [row] = await tx
       .select()
       .from(salesOrders)
       .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)))
       .for('update');
     if (!row) throw notFound('Sales order');
-    if (row.version !== version) throw versionConflict();
+    if (version !== null && row.version !== version) throw versionConflict();
     return row;
   }
 
```

- **`cancelIn()`** is the old `cancel()` body, moved out so a shop order's cancel can run it in its own transaction.
  `version: null` skips the version check, because the member saw the shop order's version, not this sales order's;
  the shop order's lock (taken first) is what keeps two cancels apart.
- **`createForShop()`** makes and confirms the order in one go. `insert()` gets a fourth argument, `shop`, with two
  things only a shop order sets: prices that include VAT whatever the workspace's setting (decision 3: the line's
  price is the shop's price, so the total matches the shop's to the paisa), and the address the shopper typed, kept
  as the document's text (decision 25). `confirmAndLog(…, 'storefront_order')` passes the credit mode from above.
- **`createdBy`, `updatedBy` and `confirmedBy` use `currentActorId()`** in `insert()`, `write()` and
  `confirmAndLog()`, the three the worker reaches. `update()` keeps `currentPrincipal()`: only a route reaches it.
- **`lock()` takes `number | null`.** Every other caller still passes a number, so nothing else changes.

```diff
@@ -37,7 +37,7 @@ import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors
 import { containsPattern } from '../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { currentActorId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
@@ -262,6 +262,13 @@ export class CustomersService {
     }
   }
 
+  // Step 27b: a shopper the phone matched no customer for (decision 2), in the caller's
+  // transaction: the worker's, when it makes a shop order's sales order. The code is the next
+  // number, like the form's empty box. Returns the new customer's id
+  async createForShop(tx: Transaction, input: CustomerInput): Promise<string> {
+    return (await this.insert(tx, input, null, false)).id;
+  }
+
   async update(id: string, input: UpdateCustomerInput): Promise<Customer> {
     const canSeeBalance = await this.access.canSee();
     try {
@@ -471,8 +478,8 @@ export class CustomersService {
         code,
         isCustomer: true,
         ...this.fields(input),
-        createdBy: currentPrincipal().userId,
-        updatedBy: currentPrincipal().userId,
+        createdBy: currentActorId(),
+        updatedBy: currentActorId(),
       })
       .returning({ id: parties.id });
     if (!row) throw new Error('Customer insert returned no row');
```

`createForShop()` is `insert()` with `canSeeBalance = false`: the worker reads no balance, and a check of the
balance permission would ask for a member. Like `createFromDevice()` (18b), it runs in the caller's transaction and
returns only what the caller needs, the id.

```diff
@@ -27,7 +27,7 @@ import { isForeignKeyViolation, isUniqueViolation } from '../common/db/pg-errors
 import { containsPattern } from '../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, encodeCursor } from '../common/pagination/cursor.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { currentActorId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import { NumberingService } from '../numbering/numbering.service.js';
@@ -233,36 +233,41 @@ export class ProductsService {
 
   async create(input: ProductInput): Promise<Product> {
     try {
-      return await this.withTenant(async (tx) => {
-        const context = await loadProductContext(tx);
-        const checked = checkProduct(input, context);
-        if (checked.issues.length > 0) throw issuesError(checked.issues);
-        const code = input.code ?? (await this.newCode(tx));
-        const skus = resolveSkus(input, code);
-        const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) });
-        const conflicts = takenIssues(input, code, skus, taken);
-        if (conflicts.length > 0) throw issuesError(conflicts);
-
-        const [id] = await insertProducts(
-          tx,
-          [{ input, code, skus, customFields: checked.customFields }],
-          currentPrincipal().userId,
-        );
-        if (id === undefined) throw new Error('Product insert returned no id');
-        const product = await this.read(tx, id);
-        await audit(tx, {
-          action: 'product.created',
-          entityType: 'product',
-          entityId: id,
-          changes: created(await this.snapshot(tx, product)),
-        });
-        return product;
-      });
+      return await this.withTenant((tx) => this.createIn(tx, input));
     } catch (error) {
       throw racedError(error);
     }
   }
 
+  // Step 27b: the save in the caller's transaction: create() above, and the shop's "Delivery
+  // charge" service, made by the first shop order that has a delivery charge (decision 4), in the
+  // worker with no member behind it (currentActorId() is null there)
+  async createIn(tx: Transaction, input: ProductInput): Promise<Product> {
+    const context = await loadProductContext(tx);
+    const checked = checkProduct(input, context);
+    if (checked.issues.length > 0) throw issuesError(checked.issues);
+    const code = input.code ?? (await this.newCode(tx));
+    const skus = resolveSkus(input, code);
+    const taken = await findTaken(tx, { codes: [code], skus, barcodes: barcodesOf(input) });
+    const conflicts = takenIssues(input, code, skus, taken);
+    if (conflicts.length > 0) throw issuesError(conflicts);
+
+    const [id] = await insertProducts(
+      tx,
+      [{ input, code, skus, customFields: checked.customFields }],
+      currentActorId(),
+    );
+    if (id === undefined) throw new Error('Product insert returned no id');
+    const product = await this.read(tx, id);
+    await audit(tx, {
+      action: 'product.created',
+      entityType: 'product',
+      entityId: id,
+      changes: created(await this.snapshot(tx, product)),
+    });
+    return product;
+  }
+
   async update(id: string, input: UpdateProductInput): Promise<Product> {
     const tenantId = getTenantId();
     try {
```

```diff
@@ -296,7 +296,8 @@ export function barcodeRows(
 export async function insertProducts(
   tx: Transaction,
   prepared: readonly PreparedProduct[],
-  userId: string,
+  // null: made by the system (step 27b's "Delivery charge"), not by a member
+  userId: string | null,
 ): Promise<string[]> {
   const tenantId = getTenantId();
   const ids: string[] = [];
```

```diff
@@ -21,5 +21,7 @@ import { UnitsService } from './units.service.js';
     ProductImportsController,
   ],
   providers: [UnitsService, ProductCategoriesService, ProductsService, ProductImportsService],
+  // Step 27b: the shop's "Delivery charge" service is made with ProductsService (storefront/)
+  exports: [ProductsService],
 })
 export class ProductsModule {}
```

`create()` becomes a call to `createIn()`, which is the old body unchanged except for the actor. The "Delivery
charge" service (decision 4) goes through the product form's own checks (`checkProduct`, the code series, the SKU
check), so it is a product the form could have saved and can open and change. `insertProducts()` takes
`string | null` for its actor; the CSV import still passes its member. `racedError()` stays on `create()`: the shop
makes this product once, under a lock on the shop's settings, so it never races another save of itself.

### The challan, the invoice and the sales return

```diff
@@ -391,6 +391,61 @@ export class DeliveriesService {
     return { id: row.id, number, lineIds: posted.map((line) => line.id) };
   }
 
+  // Step 27b: a shop order's Packed (decision 5): a posted challan of its sales order, in the
+  // caller's transaction (StorefrontOrdersService, which holds the shop order's lock and ends its
+  // stock hold in the same transaction). Each line names the order line it delivers; a line of the
+  // order split over two batches is two lines here, as on the form. postAndLog checks them against
+  // the order and posts, like a challan written by hand. `shippingAddress`: the shop order's
+  // address as text, the sales order's own. Returns the challan's id.
+  async postForShopOrder(
+    tx: Transaction,
+    input: {
+      customerId: string;
+      orderId: string;
+      date: string;
+      warehouseId: string;
+      shippingAddress: string | null;
+      note: string | null;
+      lines: readonly (LineInput & { orderLineId: string })[];
+    },
+  ): Promise<string> {
+    const customer = await this.customerOf(tx, input.customerId);
+    const lines = await resolveLines(tx, input.lines, 'out');
+    const orderLineIds = input.lines.map((line) => line.orderLineId);
+    const [row] = await tx
+      .insert(deliveries)
+      .values({
+        tenantId: getTenantId(),
+        date: input.date,
+        customerId: input.customerId,
+        orderId: input.orderId,
+        warehouseId: input.warehouseId,
+        shippingAddress: input.shippingAddress,
+        note: input.note,
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning();
+    if (!row) throw new Error('Delivery insert returned no row');
+    await this.writeLines(tx, row.id, lines, orderLineIds);
+    await audit(tx, {
+      action: 'delivery.created',
+      entityType: 'delivery',
+      entityId: row.id,
+      changes: created(
+        await this.snapshot(
+          tx,
+          row,
+          customer,
+          await this.orderRef(tx, input.orderId),
+          lines.length,
+        ),
+      ),
+    });
+    await this.postAndLog(tx, row);
+    return row.id;
+  }
+
   // A draft out of the warehouse, like a stock adjustment "out": the date and the warehouse
   // checked, the lines checked again against their products and (for an order) against what the
   // order still has to deliver, the number taken, the stock moved at its average cost, and the
```

`postForShopOrder()` sits next to 15c's `deliverForInvoice()` and works the same way: insert the draft and its lines,
write the audit row, then `postAndLog()`, which does everything a posted challan always does. It locks the sales
order, checks each line against the order line it names (same variant, not more than is left to deliver), takes the
number, moves the stock at its average cost, books the cost of goods sold and marks the order lines delivered. A
line split over two batches is two lines here, both naming the same order line, as on the challan form.

`shippingAddress` is a text, not an address id: the sales order kept the shopper's own address as text
(decision 25), and the challan prints the same one. A new method, not a change to `create()`, because `create()`
takes the form's shape (`DeliveryInput`, with an address id), and the form never sends a text.

```diff
@@ -240,29 +240,34 @@ export class InvoicesService {
   }
 
   create(input: InvoiceInput): Promise<Invoice> {
-    return this.withTenant(async (tx) => {
-      const customer = await assertCustomer(tx, input.customerId);
-      const fields = await this.check(tx, customer.id, input, null);
-      const [row] = await tx
-        .insert(invoices)
-        .values({
-          tenantId: getTenantId(),
-          ...fields.header,
-          createdBy: currentPrincipal().userId,
-          updatedBy: currentPrincipal().userId,
-        })
-        .returning();
-      if (!row) throw new Error('Invoice insert returned no row');
-      await this.writeLines(tx, row.id, input.lines, fields.lines, fields.sources);
-      await audit(tx, {
-        action: 'invoice.created',
-        entityType: 'invoice',
-        entityId: row.id,
-        changes: created(this.snapshot(row, customer, fields.lines.length)),
-      });
-      if (input.post) await this.postAndLog(tx, row, input.overrideCreditLimit);
-      return this.read(tx, row.id);
+    return this.withTenant(async (tx) => this.read(tx, await this.createIn(tx, input)));
+  }
+
+  // Step 27b: the save (and the post, when asked) in the caller's transaction: create() above,
+  // and a shop order's Delivered (StorefrontOrdersService), which bills its challan and its
+  // delivery charge and sets the shop order's status in the same transaction. Returns the id
+  async createIn(tx: Transaction, input: InvoiceInput): Promise<string> {
+    const customer = await assertCustomer(tx, input.customerId);
+    const fields = await this.check(tx, customer.id, input, null);
+    const [row] = await tx
+      .insert(invoices)
+      .values({
+        tenantId: getTenantId(),
+        ...fields.header,
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning();
+    if (!row) throw new Error('Invoice insert returned no row');
+    await this.writeLines(tx, row.id, input.lines, fields.lines, fields.sources);
+    await audit(tx, {
+      action: 'invoice.created',
+      entityType: 'invoice',
+      entityId: row.id,
+      changes: created(this.snapshot(row, customer, fields.lines.length)),
     });
+    if (input.post) await this.postAndLog(tx, row, input.overrideCreditLimit);
+    return row.id;
   }
 
   update(id: string, input: UpdateInvoiceInput): Promise<Invoice> {
```

```diff
@@ -240,41 +240,44 @@ export class SalesReturnsService {
 
   async create(input: SalesReturnInput): Promise<SalesReturn> {
     try {
-      return await this.withTenant(async (tx) => {
-        const customer = await assertCustomer(tx, input.customerId);
-        await assertWarehousesActive(tx, [
-          { field: 'warehouseId', warehouseId: input.warehouseId },
-        ]);
-        const checked = await this.checkLines(tx, customer.id, input.lines, false);
-        const [row] = await tx
-          .insert(salesReturns)
-          .values({
-            tenantId: getTenantId(),
-            date: input.date,
-            customerId: customer.id,
-            warehouseId: input.warehouseId,
-            reason: input.reason,
-            note: input.note,
-            createdBy: currentPrincipal().userId,
-            updatedBy: currentPrincipal().userId,
-          })
-          .returning();
-        if (!row) throw new Error('Sales return insert returned no row');
-        await this.writeLines(tx, row.id, input.lines, checked.lines);
-        await audit(tx, {
-          action: 'sales_return.created',
-          entityType: 'sales_return',
-          entityId: row.id,
-          changes: created(await this.snapshot(tx, row, customer, checked.lines.length)),
-        });
-        if (input.post) await this.postAndLog(tx, row);
-        return this.read(tx, row.id);
-      });
+      return await this.withTenant(async (tx) => this.read(tx, await this.createIn(tx, input)));
     } catch (error) {
       throw overDeliveredRace(error);
     }
   }
 
+  // Step 27b: the save (and the post, when asked) in the caller's transaction: create() above,
+  // and the cancel of a packed shop order (StorefrontOrdersService), which brings its whole challan
+  // back and cancels the shop order in the same transaction. Returns the id
+  async createIn(tx: Transaction, input: SalesReturnInput): Promise<string> {
+    const customer = await assertCustomer(tx, input.customerId);
+    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
+    const checked = await this.checkLines(tx, customer.id, input.lines, false);
+    const [row] = await tx
+      .insert(salesReturns)
+      .values({
+        tenantId: getTenantId(),
+        date: input.date,
+        customerId: customer.id,
+        warehouseId: input.warehouseId,
+        reason: input.reason,
+        note: input.note,
+        createdBy: currentPrincipal().userId,
+        updatedBy: currentPrincipal().userId,
+      })
+      .returning();
+    if (!row) throw new Error('Sales return insert returned no row');
+    await this.writeLines(tx, row.id, input.lines, checked.lines);
+    await audit(tx, {
+      action: 'sales_return.created',
+      entityType: 'sales_return',
+      entityId: row.id,
+      changes: created(await this.snapshot(tx, row, customer, checked.lines.length)),
+    });
+    if (input.post) await this.postAndLog(tx, row);
+    return row.id;
+  }
+
   async update(id: string, input: UpdateSalesReturnInput): Promise<SalesReturn> {
     try {
       return await this.withTenant(async (tx) => {
```

The same move for both: `create()` reads back what `createIn()` saved, and `createIn()` is the old body. A shop
order's Delivered calls `InvoicesService.createIn()` and its cancel calls `SalesReturnsService.createIn()`, each with
`post: true`, so they are saved and posted inside the move's transaction. `overDeliveredRace()` stays on `create()`:
the shop's cancel holds the shop order's lock and brings back a challan that no other return can have touched, and
the database's check stays the last word either way.

```diff
@@ -81,7 +81,8 @@ import { SalesReturnsService } from './sales-returns.service.js';
   ],
   // Step 16: the PDF of a quotation, an invoice, a receipt or a credit note is built from what
   // their get() returns (documents/models.service.ts). Step 18b: the sync's push runs a device's
-  // customers and order drafts through CustomersService and SalesOrdersService.
+  // customers and order drafts through CustomersService and SalesOrdersService. Step 27b: a shop
+  // order's moves make their documents with DeliveriesService and SalesReturnsService too.
   exports: [
     QuotationsService,
     InvoicesService,
@@ -89,6 +90,8 @@ import { SalesReturnsService } from './sales-returns.service.js';
     CreditNotesService,
     CustomersService,
     SalesOrdersService,
+    DeliveriesService,
+    SalesReturnsService,
   ],
 })
 export class SalesModule {}
```

### Making the sales order

```ts
import { Injectable } from '@nestjs/common';
import {
  compareMoney,
  type CustomerInput,
  productInputSchema,
  type SalesLineInput,
  todayIn,
} from '@omnivo/contracts';
import {
  parties,
  products,
  productVariants,
  storefrontOrderLines,
  storefrontOrders,
  storefrontSettings,
  storefrontStockHolds,
  tenantSettings,
  units,
} from '@omnivo/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { audit, created } from '../../common/audit/audit.js';
import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { ProductsService } from '../../products/products.service.js';
import { CustomersService } from '../../sales/customers.service.js';
import { SalesOrdersService } from '../../sales/sales-orders.service.js';

type OrderRow = typeof storefrontOrders.$inferSelect;
type SettingsRow = typeof storefrontSettings.$inferSelect;

// A phone number as its 11 digits: "+880 1786-120356" and "01786 120356" are both 01786120356.
// The digits first, then a leading 880 (Bangladesh's country code) becomes the 0 it stands for.
// The shop keeps a phone in this form already (storefront_orders_phone_check); a customer's phone
// is typed by hand in the ERP, in any form
const phoneDigits = sql<string>`CASE
  WHEN regexp_replace(coalesce(${parties.phone}, ''), '[^0-9]', '', 'g') LIKE '880%'
  THEN '0' || substr(regexp_replace(${parties.phone}, '[^0-9]', '', 'g'), 4)
  ELSE regexp_replace(coalesce(${parties.phone}, ''), '[^0-9]', '', 'g') END`;

// A product's VAT rate: its own, or the workspace's default (a product with no rate follows the
// default, step 12). NULL when neither exists: the line is refused with tax_rate_invalid
const rateOf = sql<string | null>`coalesce(${products.taxRateId}, (
  SELECT t.id FROM tax_rates t
   WHERE t.tenant_id = ${products.tenantId} AND t.is_default AND t.archived_at IS NULL))`;

// The address on the sales order and the challan: who, where and the phone on their own lines, the
// way a customer's address prints (addressText in sales-lines.ts). The shopper's own for this
// order, which may not be any address the customer has saved
export function shippingText(order: Pick<OrderRow, 'customerName' | 'address' | 'phone'>) {
  return [order.customerName, order.address, order.phone].join('\n');
}
```

- **`phoneDigits`** turns a customer's phone, as someone typed it in the ERP, into the shop's 11 digits:
  `+880 1786-120356` → `8801786120356` → `01786120356`. The shop's phone is already in that form (27a's
  `storefront_orders_phone_check`), so one side is enough. `[^0-9]` and not `\D`: the same in every Postgres
  regular-expression mode.
- **`rateOf`**: a product with no VAT rate of its own follows the workspace's default (step 12), so the line takes
  the default rate now. NULL when there is none at all, which `requireRate()` at the end turns into the sales order's
  own `tax_rate_invalid`.
- **`shippingText()`** is exported because Packed's challan reads the same text from the sales order; one function
  keeps the two the same.

```ts

// Step 27b: a shop order's customer and sales order (decisions 1 to 4). One class for both
// callers: the confirm event's handler in the worker (no member, so no actor on what it writes),
// and "Make the sales order" on the order's page (a member, after the handler failed). The caller
// holds the shop order's row lock (FOR UPDATE), so the two never make two sales orders for one
// order, and passes its transaction: the customer, the "Delivery charge" service, the sales order
// and the order's link to it are written together or not at all.
@Injectable()
export class ShopSalesOrderMaker {
  constructor(
    private readonly customers: CustomersService,
    private readonly salesOrders: SalesOrdersService,
    private readonly products: ProductsService,
  ) {}

  // Returns the sales order's id. Refused (an AppError, with the sales order's own error code)
  // when a rule of the sales order says no: an archived product, a product without a VAT rate
  async make(tx: Transaction, order: OrderRow): Promise<string> {
    const tenantId = getTenantId();
    const [shop] = await tx
      .select()
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, tenantId))
      // The lazy "Delivery charge" below: two orders confirmed at once take turns here, and the
      // second finds the service the first made, instead of making a second one
      .for('update');
    if (!shop) throw new Error(`Order ${order.id} has no shop settings`);
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const today = todayIn(settings?.timezone ?? 'Asia/Dhaka');

    const customerId = await this.customerFor(tx, order, shop);
    const lines = await this.goodsLines(tx, order);
    // A free delivery adds no line: a line of ৳0 would print a service nobody paid for
    if (compareMoney(order.deliveryCharge, '0') > 0) {
      lines.push(await this.deliveryLine(tx, shop, order.deliveryCharge));
    }
    const salesOrderId = await this.salesOrders.createForShop(
      tx,
      {
        customerId,
        date: today,
        deliveryDate: null,
        // The shop's number on the sales order, as a buyer's PO number would be: the order's page
        // and the lists show "Their reference W-000123"
        customerReference: order.orderNo,
        warehouseId: await this.warehouseOf(tx, order, shop),
        shippingAddressId: null,
        note: null,
        lines,
      },
      shippingText(order),
    );
    // The link and the error together, in one UPDATE: storefront_orders_document_error_check
    // allows an error only while there is no sales order
    await tx
      .update(storefrontOrders)
      .set({
        salesOrderId,
        documentError: null,
        version: sql`${storefrontOrders.version} + 1`,
      })
      .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, order.id)));
    await audit(tx, {
      action: 'storefront_order.sales_order_made',
      entityType: 'storefront_order',
      entityId: order.id,
      // The sales order's own rows say the rest (its customer, its lines); this one ties them to
      // the shop's number
      changes: created({ order: order.orderNo }),
    });
    return salesOrderId;
  }
```

- **The settings row is locked first (`FOR UPDATE`).** Two orders confirmed in the same second would both see "no
  delivery service yet" and each make "Delivery charge". With the lock the second waits, then finds the first one's.
- **The order's caller already holds the order's own lock.** The handler and the page's retry both take it before
  calling `make()`, so they never make two sales orders for one order.
- **`compareMoney()`, not `Number()`:** money is a decimal string end to end. A free delivery adds no line: a ৳0 line
  would print a service nobody paid for.
- **`customerReference` is the shop's number.** The sales order's page and every list then say "Their reference
  W-000123", the way a buyer's PO number is shown, and the challan and invoice copy it.
- **`deliveryDate: null`.** The shop promises no date; a date here would make the order "Late" on a guess.
- **The link and the error in one `UPDATE`.** 27b.2's check allows an error only while there is no sales order, so
  writing the link and clearing the error must be one statement. The version goes up: an order page open somewhere
  must reload before its next move.

```ts

  // Decision 2: the oldest active customer with this phone, else a new one. Archived customers
  // are left out: their documents are closed, and a new sale on one would bring it back unseen
  private async customerFor(tx: Transaction, order: OrderRow, shop: SettingsRow): Promise<string> {
    const [found] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.tenantId, getTenantId()),
          eq(parties.isCustomer, true),
          isNull(parties.archivedAt),
          sql`${phoneDigits} = ${order.phone}`,
        ),
      )
      .orderBy(asc(parties.createdAt), asc(parties.id))
      .limit(1);
    if (found) return found.id;
    const input: CustomerInput = {
      // The next number from the 'sales.customer' series, like the form's empty box
      code: null,
      name: order.customerName,
      groupId: null,
      contactPerson: null,
      phone: order.phone,
      email: null,
      // The language the shopper used the shop in: their invoices and SMS speak it too
      documentLanguage: shop.language,
      bin: null,
      paymentTermsDays: 0,
      // No limit (decision 2): a limit is a decision about someone the company knows
      creditLimit: null,
      priceListId: null,
      notes: null,
      // Saved for the next time staff write them a document by hand
      addresses: [{ id: null, kind: 'shipping', label: null, address: order.address, phone: null }],
    };
    return this.customers.createForShop(tx, input);
  }

  // One sales order line per shop line, in the cart's order (its line number = the position), in
  // the product's base unit at the shop's unit price (decision 3). No line discount: the shop's
  // price is already what the shopper pays
  private async goodsLines(tx: Transaction, order: OrderRow): Promise<SalesLineInput[]> {
    const rows = await tx
      .select({
        variantId: storefrontOrderLines.variantId,
        quantity: storefrontOrderLines.quantity,
        unitPrice: storefrontOrderLines.unitPrice,
        unitId: products.baseUnitId,
        taxRateId: rateOf,
      })
      .from(storefrontOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, storefrontOrderLines.tenantId),
          eq(products.id, storefrontOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(storefrontOrderLines.tenantId, getTenantId()),
          eq(storefrontOrderLines.orderId, order.id),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
    return rows.map((row) => ({
      variantId: row.variantId,
      unitId: row.unitId,
      quantity: String(row.quantity),
      // null: the product's name and its variant's options, as on any sales order
      description: null,
      unitPrice: row.unitPrice,
      discountType: 'amount',
      discount: '0',
      taxRateId: requireRate(row.taxRateId),
    }));
  }
```

- **The oldest active customer with the phone** (decision 2). Archived customers are left out: a sale on one would
  bring it back without anyone deciding to. The oldest, because a phone typed twice by mistake most likely belongs
  to the first customer, the one with the history.
- **A new customer** has the shopper's name, phone and address, no credit limit and the shop's language for their
  documents. `CustomerInput` is built as a typed object, not parsed: a field the contract adds later fails the type
  check here instead of being filled in silently.
- **One sales order line per shop line, in the cart's order.** Line `n` of the order is line number `n` of the sales
  order, which Packed and Delivered rely on. Each line is in the product's base unit, at the shop's unit price, with
  no discount: the shop's price is already what the shopper pays.

```ts

  // The delivery charge as one service line (decision 4): the service the shop's settings name,
  // or "Delivery charge", made now and kept in the settings
  private async deliveryLine(
    tx: Transaction,
    shop: SettingsRow,
    charge: string,
  ): Promise<SalesLineInput> {
    const variantId = shop.deliveryVariantId ?? (await this.makeDeliveryService(tx));
    const [row] = await tx
      .select({ unitId: products.baseUnitId, taxRateId: rateOf })
      .from(productVariants)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, productVariants.tenantId),
          eq(products.id, productVariants.productId),
        ),
      )
      .where(and(eq(productVariants.tenantId, getTenantId()), eq(productVariants.id, variantId)));
    if (!row) throw new Error(`Delivery charge variant ${variantId} is missing`);
    return {
      variantId,
      unitId: row.unitId,
      quantity: '1',
      description: null,
      unitPrice: charge,
      discountType: 'amount',
      discount: '0',
      taxRateId: requireRate(row.taxRateId),
    };
  }

  // A service in the workspace's piece unit, with the default VAT rate (a null rate follows the
  // default), and its ids in the shop's settings. The settings row is locked (make() above)
  private async makeDeliveryService(tx: Transaction): Promise<string> {
    const tenantId = getTenantId();
    // A count unit of one piece, "pcs" first. A workspace that deleted every such unit gets the
    // error that sends someone to the Shop settings' select, where any service can be picked
    const [unit] = await tx
      .select({ id: units.id })
      .from(units)
      .where(
        and(
          eq(units.tenantId, tenantId),
          isNull(units.archivedAt),
          eq(units.dimension, 'count'),
          sql`${units.ratio} = 1`,
        ),
      )
      .orderBy(sql`lower(${units.code}) = 'pcs' DESC`, asc(units.createdAt))
      .limit(1);
    if (!unit) {
      throw new AppError(
        409,
        'storefront_delivery_product_invalid',
        'No piece unit for the Delivery charge service. Pick a service in the shop settings.',
      );
    }
    const product = await this.products.createIn(
      tx,
      // parse: the form's own rules and defaults, so this product is one the form could have saved
      productInputSchema.parse({
        code: '',
        // Data, not a screen's words: it prints on the sales documents in the company's language
        // like any product name, and staff may rename it
        name: 'Delivery charge',
        type: 'service',
        categoryId: '',
        description: '',
        baseUnitId: unit.id,
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
      }),
    );
    const [variant] = product.variants;
    if (!variant) throw new Error('Delivery charge was made without a variant');
    // Both columns at once: storefront_settings_delivery_check wants both or neither
    await tx
      .update(storefrontSettings)
      .set({
        deliveryProductId: product.id,
        deliveryVariantId: variant.id,
        // A settings form open somewhere still says "Made on the first order": its save must
        // reload first (version_conflict), not send the empty box back over this one
        version: sql`${storefrontSettings.version} + 1`,
      })
      .where(eq(storefrontSettings.tenantId, tenantId));
    return variant.id;
  }
```

- **The delivery line uses the settings' service, or makes one.** The service's base unit and VAT rate are read like
  a product line's, so a tenant who picks "Courier charge" with its own rate gets that rate.
- **The piece unit** (decision 27): a count unit of exactly one piece, `pcs` first. A service is sold "1 time", and
  `pcs` is what every workspace has from setup. If someone deleted them all, the error sends the staff to Shop
  settings, where any service can be picked instead.
- **`productInputSchema.parse()`** gives the product the form's own defaults and rules. The name is data, not a
  screen's words: it prints on documents like any product name, in the language the company typed it, and the staff
  can rename it.
- **Both ids and a new version in the settings.** The pair check from 27b.2 wants both or neither. The version goes
  up because a settings form open somewhere still shows "Made on the first order"; without the new version, its next
  save would send the empty box back over the service just made.

```ts

  // The warehouse the order's stock is held in (27a copied the shop's warehouse onto each hold
  // when the order was placed). The shop's warehouse now only when the holds are gone, which a
  // confirmed order never is before it is packed
  private async warehouseOf(tx: Transaction, order: OrderRow, shop: SettingsRow): Promise<string> {
    const [hold] = await tx
      .select({ warehouseId: storefrontStockHolds.warehouseId })
      .from(storefrontStockHolds)
      .where(
        and(
          eq(storefrontStockHolds.tenantId, getTenantId()),
          eq(storefrontStockHolds.orderId, order.id),
        ),
      )
      .limit(1);
    const warehouseId = hold?.warehouseId ?? shop.defaultWarehouseId;
    if (warehouseId === null) throw new Error(`Order ${order.id} has no warehouse`);
    return warehouseId;
  }
}

// A product with no rate of its own in a workspace with no default rate: the sales order's own
// error for a line without a valid rate, so the order page says what to fix
function requireRate(taxRateId: string | null): string {
  if (taxRateId === null) {
    throw new AppError(409, 'tax_rate_invalid', 'Set a default VAT rate, or one on the product.');
  }
  return taxRateId;
}
```

The warehouse is the one the order's stock is held in, which 27a copied onto each hold when the order was placed. The
shop's warehouse may have changed since; the stock this order counts on is still in the old one.

### The confirm handler

```diff
@@ -7,23 +7,72 @@ import {
   roles,
   storefrontOrders,
 } from '@omnivo/db';
-import { and, eq, isNull, or } from 'drizzle-orm';
+import { and, eq, isNull, or, sql } from 'drizzle-orm';
 
+import { AppError } from '../../common/http/app-error.js';
 import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
 import { getTenantId } from '../../common/tenant/tenant-context.js';
 import type { WithTenant } from '../../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../../infra/tokens.js';
 import { notify } from '../../notifications/notify.js';
+import { ShopSalesOrderMaker } from './sales-order-maker.js';
 
 // Step 27a: "New shop order W-000123 for ৳578" in the bell of the owners and of everyone who may
-// read the shop's orders (storefront.order.read). 27b adds the sales order to this event. Like
-// SoldShortHandler: the order is read when the job runs, and the event's id is each notification's
-// key, so a second run of the job adds nothing.
+// read the shop's orders (storefront.order.read). Like SoldShortHandler: the order is read when the
+// job runs, and the event's id is each notification's key, so a second run of the job adds nothing.
+// Step 27b: first the order's customer and sales order (decision 1), here and not in the confirm,
+// which runs as omnivo_shop and must never fail for something in the ERP.
 @Injectable()
 export class OrderConfirmedHandler implements EventHandler<'storefront.order_confirmed'> {
-  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}
+  constructor(
+    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
+    private readonly maker: ShopSalesOrderMaker,
+  ) {}
 
   async handle(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
+    await this.makeSalesOrder(event.payload.orderId);
+    await this.ring(event);
+  }
+
+  // Its own transaction, before the bell's: a refused sales order must not take the bell with it.
+  // A refusal by the sales order's rules (an AppError: an archived product, no VAT rate) is kept on
+  // the order as its code, in a second transaction after the first rolled back, and the job ends
+  // there: running it again would be refused the same way until someone fixes the cause, and the
+  // order page's "Make the sales order" is the retry. Anything else (the database went away) is
+  // thrown, and the queue runs the job again later.
+  private async makeSalesOrder(orderId: string): Promise<void> {
+    const tenantId = getTenantId();
+    try {
+      await this.withTenant(async (tx) => {
+        const [order] = await tx
+          .select()
+          .from(storefrontOrders)
+          .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)))
+          // The page's retry takes the same lock: whichever comes second sees the sales order
+          .for('update');
+        // A second run of the job (made already), or an order cancelled before the job ran
+        if (order?.status !== 'confirmed' || order.salesOrderId !== null) return;
+        await this.maker.make(tx, order);
+      });
+    } catch (error) {
+      if (!(error instanceof AppError)) throw error;
+      await this.withTenant(async (tx) => {
+        await tx
+          .update(storefrontOrders)
+          .set({ documentError: error.code, version: sql`${storefrontOrders.version} + 1` })
+          .where(
+            and(
+              eq(storefrontOrders.tenantId, tenantId),
+              eq(storefrontOrders.id, orderId),
+              // Only while it has none: the page's retry may have made it in the meantime
+              isNull(storefrontOrders.salesOrderId),
+            ),
+          );
+      });
+    }
+  }
+
+  private async ring(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
     const tenantId = getTenantId();
     await this.withTenant(async (tx) => {
       const [order] = await tx
```

- **The sales order first, in its own transaction, then the bell in another.** If the sales order is refused, the
  bell still rings: the staff must know the order is there, and its page says what went wrong.
- **An `AppError` is a refusal by the sales order's rules** (an archived product, no VAT rate). It is kept on the
  order as its code, in a new transaction, because the first one has rolled back. The job then ends normally:
  running it again would be refused the same way until a person fixes the cause, and the page's "Make the sales
  order" is the retry (decision 16).
- **Anything else is thrown.** A lost database connection is not the order's fault; the queue runs the job again
  later, and the next run finds no sales order yet and tries again.
- **`FOR UPDATE` and the two early returns** make a second run harmless: a sales order already made, or an order the
  staff cancelled before the job ran, is left alone. The error is written only `WHERE sales_order_id IS NULL`, in
  case the page's retry made the sales order between the two transactions.

```diff
@@ -1,12 +1,13 @@
 import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
 import { createDb, type Db } from '@omnivo/db';
+import { Redis } from 'ioredis';
 
 import { createWithTenant } from '../common/tenant/with-tenant.js';
 import { DocumentEmailHandler } from '../documents/email.handler.js';
 import { DocumentFileHandler } from '../documents/file.handler.js';
 import { DocumentFileMaker } from '../documents/file-maker.js';
 import type { WorkerConfig } from '../config.js';
-import { CONFIG, DB, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
+import { CONFIG, DB, REDIS, RELAY_DB, STORAGE_CONFIG, WITH_TENANT } from '../infra/tokens.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
@@ -15,10 +16,16 @@ import { NumberingService } from '../numbering/numbering.service.js';
 import { ShiftVarianceHandler } from '../pos/shift-variance.handler.js';
 import { SoldShortHandler } from '../pos/sold-short.handler.js';
 import { ProductImportHandler } from '../products/import.handler.js';
+import { ProductsService } from '../products/products.service.js';
+import { PermissionService } from '../rbac/permission.service.js';
 import { ReportExportHandler } from '../reports/export.handler.js';
 import { ReportScheduleEmailHandler } from '../reports/report-schedule-email.handler.js';
 import { ReportScheduleRunHandler } from '../reports/report-schedule-run.handler.js';
 import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
+import { BalanceAccess } from '../sales/balance-access.js';
+import { CreditService } from '../sales/credit.service.js';
+import { CustomersService } from '../sales/customers.service.js';
+import { SalesOrdersService } from '../sales/sales-orders.service.js';
 import { CatalogHandler } from '../setup/catalog.handler.js';
 import { ChartHandler } from '../setup/chart.handler.js';
 import { ProvisioningHandler } from '../setup/provisioning.handler.js';
@@ -30,6 +37,7 @@ import { SMS_SENDER, MailSmsSender } from '../sms/sms-sender.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
 import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
 import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
+import { ShopSalesOrderMaker } from '../storefront/orders/sales-order-maker.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
@@ -46,6 +54,7 @@ export class WorkerModule implements OnApplicationShutdown {
   constructor(
     @Inject(DB) private readonly db: Db,
     @Inject(RELAY_DB) private readonly relayDb: Db,
+    @Inject(REDIS) private readonly redis: Redis,
   ) {}
 
   static register(config: WorkerConfig): DynamicModule {
@@ -102,12 +111,27 @@ export class WorkerModule implements OnApplicationShutdown {
         PendingOrderSweep,
         { provide: SMS_SENDER, useClass: MailSmsSender },
         SmsRunner,
+        // Step 27b: a confirmed order's customer and sales order, made by OrderConfirmedHandler
+        // with the services the ERP's screens use, so a shop sale follows the same rules
+        ShopSalesOrderMaker,
+        CustomersService,
+        SalesOrdersService,
+        ProductsService,
+        // What those services ask for. CreditService and BalanceAccess read a member's permissions,
+        // which the shop's sales order never asks (no member; 'storefront_order' skips it), so this
+        // Redis client is never used here: lazyConnect, and it never opens a connection
+        CreditService,
+        BalanceAccess,
+        PermissionService,
+        { provide: REDIS, useFactory: () => new Redis(config.redisUrl, { lazyConnect: true }) },
       ],
     };
   }
 
   // Last: the relay and the queue workers have stopped in beforeApplicationShutdown by now
   async onApplicationShutdown(): Promise<void> {
+    // disconnect(), not quit(): quit() sends a command, which would open the connection first
+    this.redis.disconnect();
     await Promise.all([this.db.$client.end(), this.relayDb.$client.end()]);
   }
 }
```

The handler needs the same services as the API (decision 24). `CreditService` and `BalanceAccess` need
`PermissionService`, which needs a Redis client. The shop's sales order never asks for a member's permissions, so
the client is made with `lazyConnect: true` and never opens a connection here. `disconnect()` at shutdown, not
`quit()`: `quit()` sends a command, and would open the connection only to close it.

### The Shop orders service

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type DocumentRef,
  type ErrorCode,
  isErrorCode,
  type PackStorefrontOrderInput,
  type StorefrontOrder,
  type StorefrontOrderCounts,
  type StorefrontOrderPage,
  type storefrontOrderQuerySchema,
  STOREFRONT_ORDER_SORTS,
  type StorefrontOrderSort,
  type StorefrontOrderStatus,
  type StorefrontOrderSummary,
  type StorefrontPackPlan,
  storefrontImageSchema,
  sumQuantity,
  subtractQuantity,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  deliveries,
  deliveryLines,
  invoices,
  parties,
  products,
  productVariants,
  salesOrderLines,
  salesOrders,
  salesReturns,
  stockBalances,
  storefrontImages,
  storefrontOrderLines,
  storefrontOrders,
  storefrontSettings,
  storefrontStockHolds,
  tenantSettings,
  units,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, gt, inArray, ne, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, diff } from '../../common/audit/audit.js';
import { containsPattern } from '../../common/db/search.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config } from '../../config.js';
import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { DeliveriesService } from '../../sales/deliveries.service.js';
import { InvoicesService } from '../../sales/invoices.service.js';
import { SalesOrdersService } from '../../sales/sales-orders.service.js';
import { SalesReturnsService } from '../../sales/sales-returns.service.js';
import { cancelledSms } from '../../sms/shop-sms.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { isoText } from '../listing-sql.js';
import { shopImage } from '../media.js';
import { historyOf, type OrderLineRow, type OrderRow } from './order-view.js';
import { ShopSalesOrderMaker } from './sales-order-maker.js';

type Query = z.output<typeof storefrontOrderQuerySchema>;
```

```ts

// The pieces in an order, for "3 items" on a phone's card. By the table's name: inside the
// subquery a bare "id" would be the line's
const itemCount = sql<number>`(
  SELECT coalesce(sum(l.quantity), 0)::int FROM storefront_order_lines l
   WHERE l.tenant_id = storefront_orders.tenant_id AND l.order_id = storefront_orders.id
)`;

// Each sort's key, like the catalog's (listings.service.ts): the key's text goes into the cursor,
// ties go by id so the order is total. "confirmed" uses the microseconds (isoText): two orders
// confirmed in one millisecond are not skipped by a cursor. A Record, so a new sort without its
// line here does not compile
const SORTS: Record<
  StorefrontOrderSort,
  { key: SQL; text: SQL; desc: boolean; valid: (key: string) => boolean }
> = {
  '-confirmed': {
    key: sql`${storefrontOrders.confirmedAt}`,
    text: isoText(sql`${storefrontOrders.confirmedAt}`),
    desc: true,
    valid: (key) => !Number.isNaN(Date.parse(key)),
  },
  confirmed: {
    key: sql`${storefrontOrders.confirmedAt}`,
    text: isoText(sql`${storefrontOrders.confirmedAt}`),
    desc: false,
    valid: (key) => !Number.isNaN(Date.parse(key)),
  },
  '-total': {
    key: sql`${storefrontOrders.total}`,
    text: sql`${storefrontOrders.total}::text`,
    desc: true,
    valid: (key) => /^\d{1,15}(?:\.\d{1,4})?$/.test(key),
  },
  total: {
    key: sql`${storefrontOrders.total}`,
    text: sql`${storefrontOrders.total}::text`,
    desc: false,
    valid: (key) => /^\d{1,15}(?:\.\d{1,4})?$/.test(key),
  },
};

// [sort, key, id]: the sort is in it, so a cursor of one order sent with another is refused
const cursorSchema = z.tuple([z.enum(STOREFRONT_ORDER_SORTS), z.string().max(40), z.uuid()]);

function invalidCursor(): AppError {
  return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
}

function stepInvalid(): AppError {
  return new AppError(
    409,
    'storefront_order_step_invalid',
    'This order has moved on since it was loaded. Reload it.',
  );
}

// The statuses the ERP shows (decision 13). The routes never read a pending order (their WHERE
// says status <> 'pending'), so one here is a bug, and a loud one
function erpStatus(order: OrderRow): StorefrontOrderStatus {
  const { status } = order;
  if (status === 'pending') throw new Error(`Order ${order.id} is still pending`);
  return status;
}

function confirmedAtOf(order: OrderRow): Date {
  if (order.confirmedAt === null) throw new Error(`Order ${order.id} has no confirmed_at`);
  return order.confirmedAt;
}

function numberOf(order: OrderRow): string {
  if (order.orderNo === null) throw new Error(`Order ${order.id} has no number`);
  return order.orderNo;
}

function summaryOf(order: OrderRow, items: number): StorefrontOrderSummary {
  return {
    id: order.id,
    orderNo: numberOf(order),
    status: erpStatus(order),
    placedAt: order.createdAt.toISOString(),
    confirmedAt: confirmedAtOf(order).toISOString(),
    customerName: order.customerName,
    phone: order.phone,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    itemCount: items,
    total: order.total,
    needsAttention: order.documentError !== null,
  };
}
```

- **`itemCount`** is a subquery per row, like the sales orders' `lineCount`: at most 20 lines per order, and only
  for the page being read.
- **`SORTS`** is the catalog's pattern (26g): each sort's key, the key as text for the cursor, and a check of a key
  that came back from the browser. `confirmed` uses microseconds, so two orders confirmed in the same millisecond
  are not skipped by a cursor. A `Record`, so a new sort in the contract does not compile until it has its line.
- **The cursor carries its sort.** A cursor from "newest first" sent with "biggest first" is refused instead of
  landing in the middle of a different list.
- **`erpStatus()`** narrows the database's seven statuses to the ERP's six. Every read says
  `status <> 'pending'`, so a pending order here is a bug, and it fails loudly rather than showing a "pending" pill.

```ts

// The challan's own errors name its lines (lines.0, lines.1 …); Packed's dialog has the order's
// lines, each split into picks. `at` maps each challan line to its line and pick, so a stock
// error ("only 2 left in this batch") shows under the pick that asked for too much. Like
// onInvoiceLines in invoices.service.ts
function onPicks(error: unknown, at: readonly { line: number; pick: number }[]): never {
  if (!(error instanceof AppError) || error.options.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.options.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const where = match === null ? undefined : at[Number(match[1])];
      const field = match?.[2];
      return [
        where === undefined || field === undefined
          ? path
          : `lines.${String(where.line)}.picks.${String(where.pick)}.${field}`,
        codes,
      ];
    }),
  );
  throw new AppError(error.status, error.code, error.message, { ...error.options, fieldErrors });
}

function linesError(code: ErrorCode, fieldErrors: Record<string, ErrorCode[]>): AppError {
  return new AppError(409, code, 'Some lines cannot be packed. Check the highlighted fields.', {
    fieldErrors,
  });
}
```

The challan's errors name its own lines (`lines.3.quantity`). The Packed dialog shows the order's lines with their
picks, so `onPicks()` maps challan line 3 back to, say, line 1, pick 2 (`lines.1.picks.2.quantity`). The stock error
"only 2 left in this batch" then shows under the pick that asked for too much.

```ts

// Step 27b: the shop's orders in the ERP (Storefront → Shop orders). Reading needs
// storefront.order.read, every move storefront.order.manage (the contract's routes say which;
// the guard checks it). A move makes its ERP documents with the sales services' own code, in one
// transaction with the order's new status (decisions 5, 7, 8), so the documents and the status
// never disagree. No sales.* permission is asked (decision 9): the services check none themselves,
// and the routes that would are not called. Every move locks the order first (FOR UPDATE), then the
// documents; the handler that makes the sales order takes the same lock first, so the two take
// turns instead of waiting for each other in a circle.
@Injectable()
export class StorefrontOrdersService {
  private readonly mediaUrl: string;

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) config: Config,
    private readonly maker: ShopSalesOrderMaker,
    private readonly salesOrders: SalesOrdersService,
    private readonly deliveries: DeliveriesService,
    private readonly invoices: InvoicesService,
    private readonly salesReturns: SalesReturnsService,
    private readonly sms: SmsQueue,
  ) {
    this.mediaUrl = config.storefront.mediaUrl;
  }

  list(q: Query): Promise<StorefrontOrderPage> {
    const sort = SORTS[q.sort];
    return this.withTenant(async (tx) => {
      const filters: SQL[] = [
        eq(storefrontOrders.tenantId, getTenantId()),
        q.view === 'all'
          ? ne(storefrontOrders.status, 'pending')
          : eq(storefrontOrders.status, q.view),
      ];
      if (q.search !== undefined && q.search !== '') {
        filters.push(this.searchFilter(q.search));
      }
      const cursor = decodeCursor(q.cursor, cursorSchema);
      if (cursor !== undefined) {
        const [cursorSort, key, id] = cursor;
        // The key goes into SQL with a cast; a bad one would be Postgres's cast error, a 500
        if (cursorSort !== q.sort || !sort.valid(key)) throw invalidCursor();
        const cast = q.sort.endsWith('confirmed') ? sql`timestamptz` : sql`numeric`;
        const op = sort.desc ? sql`<` : sql`>`;
        filters.push(
          sql`(${sort.key}, ${storefrontOrders.id}) ${op} (${key}::${cast}, ${id}::uuid)`,
        );
      }
      const direction = sort.desc ? sql`DESC` : sql`ASC`;
      const rows = await tx
        .select({ order: storefrontOrders, items: itemCount, sortKey: sort.text })
        .from(storefrontOrders)
        .where(and(...filters))
        .orderBy(sql`${sort.key} ${direction}`, sql`${storefrontOrders.id} ${direction}`)
        .limit(q.limit + 1);
      const page = toPage(rows, q.limit, (last) => [q.sort, last.sortKey, last.order.id]);
      return {
        items: page.items.map((row) => summaryOf(row.order, row.items)),
        nextCursor: page.nextCursor,
      };
    });
  }

  // Decision 18: the sidebar's number, without loading a page of orders
  counts(): Promise<StorefrontOrderCounts> {
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ confirmed: sql<number>`count(*)::int` })
        .from(storefrontOrders)
        .where(
          and(
            eq(storefrontOrders.tenantId, getTenantId()),
            eq(storefrontOrders.status, 'confirmed'),
          ),
        );
      return { confirmed: row?.confirmed ?? 0 };
    });
  }

  get(id: string): Promise<StorefrontOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }
```

- **The class comment is the part's lock rule.** Every move locks the shop order first and the documents after;
  the handler and the retry lock the shop order first too. Everyone takes the locks in the same order, so two moves
  wait for each other instead of deadlocking.
- **The list** is filtered by tab (`all` is every status but pending), by search, and after the cursor; the list's
  index from 27b.2 narrows it to the workspace and the status first. `limit + 1` rows tell whether there is a next
  page without a count.
- **`counts()`** is its own route (decision 18), so the sidebar never loads a page of orders to count them.

```ts

  // Decision 1's retry: the handler could not make the sales order (documentError), or the order
  // was confirmed before 27b and has none. The maker's refusal is kept on the order as before, and
  // the answer is the refusal itself, so the page shows what is still wrong
  async makeSalesOrder(id: string, version: number): Promise<StorefrontOrder> {
    try {
      return await this.withTenant(async (tx) => {
        const order = await this.lock(tx, id, version);
        if (order.status !== 'confirmed' || order.salesOrderId !== null) throw stepInvalid();
        await this.maker.make(tx, order);
        return this.read(tx, id);
      });
    } catch (error) {
      if (error instanceof AppError && error.code !== 'storefront_order_step_invalid') {
        await this.keepError(id, error.code);
      }
      throw error;
    }
  }

  // Decision 14: what the Packed dialog opens with. A read, but behind storefront.order.manage:
  // only someone who may pack needs the batches
  packPlan(id: string): Promise<StorefrontPackPlan> {
    return this.withTenant(async (tx) => {
      const order = await this.find(tx, id);
      if (order.status !== 'confirmed') throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const [warehouse] = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(
          and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
        );
      if (!warehouse) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
      const lines = await this.linesOf(tx, id);
      const stock = await this.batchesIn(
        tx,
        warehouse.id,
        lines.filter((line) => line.tracking === 'batch').map((line) => line.line.variantId),
      );
      return {
        warehouse,
        lines: lines.map(({ line, sku, unitCode, tracking }) => {
          const quantity = String(line.quantity);
          const available = stock.get(line.variantId) ?? [];
          return {
            position: line.position,
            name: line.name,
            packSize: line.packSize,
            sku,
            unitCode,
            quantity,
            tracking,
            batches: available,
            picks:
              tracking === 'none'
                ? [{ batchId: null, quantity, serialNumbers: [] }]
                : tracking === 'batch'
                  ? fefo(quantity, available)
                  : [],
          };
        }),
      };
    });
  }
```

- **`makeSalesOrder()`** is the retry. A refusal is kept on the order again, in its own transaction, and then
  thrown, so the page shows the error that is still there. A "step invalid" is not kept: it only means the page was
  old.
- **`packPlan()`** reads with no lock: it only fills the dialog, and Packed checks everything again. The batches come
  from `stock_balances` in the sales order's warehouse; the suggestion is `fefo()` (at the end of the file) for a
  batch product, the whole line with no batch for an untracked one, and nothing for a serial product (decision 14).

```ts

  // Decision 5: Packed = a posted challan of the sales order, from the warehouse the stock is held
  // in, and the hold ends in the same transaction (the stock has really left now)
  pack(id: string, input: PackStorefrontOrderInput): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, input.version);
      if (order.status !== 'confirmed') throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const orderLines = await this.orderLinesOf(tx, id);
      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);

      // Every line of the order once, and only its lines (the contract refused a line twice).
      // The picks of a line add up to what the shopper ordered: the challan would take whatever
      // it is given, and a short box is a mistake the packer can fix now
      const byPosition = new Map(orderLines.map((line, index) => [line.position, index]));
      const fieldErrors: Record<string, ErrorCode[]> = {};
      input.lines.forEach((line, lineIndex) => {
        const index = byPosition.get(line.position);
        const ordered = index === undefined ? undefined : orderLines[index];
        if (ordered === undefined) {
          fieldErrors[`lines.${String(lineIndex)}.position`] = ['storefront_order_line_missing'];
          return;
        }
        const picked = sumQuantity(line.picks.map((pick) => pick.quantity));
        if (compareQuantity(picked, String(ordered.quantity)) !== 0) {
          fieldErrors[`lines.${String(lineIndex)}.picks`] = ['storefront_order_pick_total'];
        }
      });
      const [first] = Object.values(fieldErrors);
      if (first?.[0] !== undefined) throw linesError(first[0], fieldErrors);
      if (input.lines.length !== orderLines.length) {
        throw new AppError(409, 'storefront_order_line_missing', 'Pack every line of the order.');
      }

      // The sales order's goods lines are the order's lines in the cart's order (the maker wrote
      // them so): line i of the order is line number i + 1 of the sales order
      const challanLines = input.lines.flatMap((line, lineIndex) => {
        const index = byPosition.get(line.position) ?? -1;
        const soLine = soLines[index];
        const ordered = orderLines[index];
        if (soLine === undefined || soLine.variantId !== ordered?.variantId) {
          throw new Error(`Order ${id} line ${String(line.position)} has no sales order line`);
        }
        return line.picks.map((pick, pickIndex) => ({
          at: { line: lineIndex, pick: pickIndex },
          line: {
            variantId: soLine.variantId,
            unitId: soLine.unitId,
            quantity: pick.quantity,
            batchId: pick.batchId,
            serialNumbers: pick.serialNumbers,
            orderLineId: soLine.id,
          },
        }));
      });

      // The hold first: from here on the stock counts as gone through the challan, not the hold
      await tx
        .delete(storefrontStockHolds)
        .where(
          and(
            eq(storefrontStockHolds.tenantId, getTenantId()),
            eq(storefrontStockHolds.orderId, id),
          ),
        );
      let deliveryId: string;
      try {
        deliveryId = await this.deliveries.postForShopOrder(tx, {
          customerId: salesOrder.customerId,
          orderId: salesOrder.id,
          date: await this.today(tx),
          warehouseId: salesOrder.warehouseId,
          shippingAddress: salesOrder.shippingAddress,
          note: null,
          lines: challanLines.map((entry) => entry.line),
        });
      } catch (error) {
        onPicks(
          error,
          challanLines.map((entry) => entry.at),
        );
      }
      await this.move(tx, order, { status: 'packed', packedAt: new Date(), deliveryId });
      return this.read(tx, id);
    });
  }
```

- **The lines are checked before anything is written.** A position the order does not have, and picks that do not
  add up to the line, come back under their boxes, all at once. A missing line is checked after: it has no box.
- **Line `n` of the order is sales order line `n`** (the maker wrote them so). The variant is compared anyway: a
  mismatch would be a bug, and it throws rather than packing the wrong product.
- **The hold is deleted before the challan posts**, in the same transaction. The challan's posting does not read the
  holds, so the order does not matter to it; the hold ends because the stock is now really gone (decision 5). If the
  posting fails (the stock went to a POS sale first), the transaction rolls back and the hold is still there.
- **`move()` writes `packed`, `packed_at` and `delivery_id` in one statement**, which 27b.2's documents check needs.

```ts

  // Decision 6: a status only. The courier comes in step 28
  ship(id: string, version: number): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, version);
      if (order.status !== 'packed') throw stepInvalid();
      await this.move(tx, order, { status: 'shipped', shippedAt: new Date() });
      return this.read(tx, id);
    });
  }

  // Decision 7: a posted invoice for what the challan took and the delivery charge, dated today
  // (decision 21) and unpaid: the cash the rider brings back is a money receipt
  deliver(id: string, version: number): Promise<StorefrontOrder> {
    return this.withTenant(async (tx) => {
      const order = await this.lock(tx, id, version);
      if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
      const salesOrder = await this.salesOrderOf(tx, order);
      const orderLines = await this.orderLinesOf(tx, id);
      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);
      const soLineById = new Map(soLines.map((line) => [line.id, line]));
      const challan = await tx
        .select()
        .from(deliveryLines)
        .where(
          and(
            eq(deliveryLines.tenantId, getTenantId()),
            eq(deliveryLines.deliveryId, order.deliveryId),
          ),
        )
        .orderBy(asc(deliveryLines.lineNo));
      const [branch] = await tx
        .select({ id: warehouses.branchId })
        .from(warehouses)
        .where(
          and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
        );
      if (!branch) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);

      // Each challan line at its order line's price and VAT rate; then the delivery charge, the
      // sales order's lines after the order's own (the maker added it last)
      const goods = challan.map((line) => {
        const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
        if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
        return {
          variantId: line.variantId,
          unitId: line.unitId,
          quantity: line.quantity,
          description: soLine.description,
          unitPrice: soLine.unitPrice,
          discountType: 'amount' as const,
          discount: '0',
          taxRateId: soLine.taxRateId,
          deliveryLineId: line.id,
          orderLineId: null,
          batchId: null,
          serialNumbers: [],
        };
      });
      const charges = soLines.slice(orderLines.length).map((soLine) => ({
        variantId: soLine.variantId,
        unitId: soLine.unitId,
        quantity: soLine.quantity,
        description: soLine.description,
        unitPrice: soLine.unitPrice,
        discountType: 'amount' as const,
        discount: '0',
        taxRateId: soLine.taxRateId,
        deliveryLineId: null,
        orderLineId: soLine.id,
        batchId: null,
        serialNumbers: [],
      }));
      const invoiceId = await this.invoices.createIn(tx, {
        customerId: salesOrder.customerId,
        date: await this.today(tx),
        note: null,
        lines: [...goods, ...charges],
        // The customer's payment terms from today: 0 days for a new shop customer
        dueDate: null,
        customerReference: order.orderNo,
        branchId: branch.id,
        warehouseId: null,
        post: true,
        // Never over the limit: the invoice bills the confirmed order at its own prices, which
        // moves the amount from "on order" to "owed" and adds nothing (CreditService.check)
        overrideCreditLimit: false,
      });
      await this.move(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
      return this.read(tx, id);
    });
  }
```

- **Shipped is a status only** (decision 6), and only after Packed.
- **Delivered only after Shipped** (decision 28). The invoice bills each challan line at its sales order line's
  price and VAT rate, so its lines are exactly what left. The delivery charge is the sales order's lines after the
  order's own, billed straight from the order (`orderLineId`), as 15c bills any service line.
- **The invoice is never over the credit limit.** It bills a confirmed order at the order's own prices, which moves
  the amount from "on order" to "owed"; `CreditService.check()` refuses only a rise. So `overrideCreditLimit: false`
  is right, and no member's permission is asked.
- **`dueDate: null`** is the customer's payment terms from today: 0 days for a new shop customer, so the unpaid
  cash-on-delivery invoice is due the day it was delivered.

```ts

  // Decision 8: a new order's sales order is cancelled and its hold ends; a packed one's goods
  // come back on a posted sales return of the whole challan first, and then its sales order (which
  // the return opened again, with nothing delivered) is cancelled. After shipping it is step 28's
  // "returned". The shopper gets an SMS once the transaction has committed
  async cancel(
    id: string,
    input: { version: number; reason: string | null },
  ): Promise<StorefrontOrder> {
    const { order, sms } = await this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.status !== 'confirmed' && before.status !== 'packed') throw stepInvalid();
      let salesReturnId: string | null = null;
      if (before.status === 'packed') {
        salesReturnId = await this.returnChallan(tx, before);
      } else {
        await tx
          .delete(storefrontStockHolds)
          .where(
            and(
              eq(storefrontStockHolds.tenantId, getTenantId()),
              eq(storefrontStockHolds.orderId, id),
            ),
          );
      }
      if (before.salesOrderId !== null) {
        await this.salesOrders.cancelIn(tx, before.salesOrderId, null);
      }
      await this.move(tx, before, {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason,
        salesReturnId,
      });
      const [shop] = await tx
        .select({
          language: storefrontSettings.language,
          name: storefrontSettings.name,
          hotline: storefrontSettings.hotline,
        })
        .from(storefrontSettings)
        .where(eq(storefrontSettings.tenantId, getTenantId()));
      return {
        order: await this.read(tx, id),
        sms:
          shop === undefined
            ? null
            : {
                to: before.phone,
                text: cancelledSms(shop.language, shop.name, numberOf(before), shop.hotline),
              },
      };
    });
    // After the commit: an SMS for a cancel that rolled back would tell the shopper a lie. Never
    // throws (SmsQueue.send): the cancel stands even when Redis is away
    if (sms !== null) await this.sms.send(sms);
    return order;
  }

  // The whole challan back, into the warehouse it left from, at what it cost (15d's rule)
  private async returnChallan(tx: Transaction, order: OrderRow): Promise<string> {
    if (order.deliveryId === null || order.salesOrderId === null) throw stepInvalid();
    const [challan] = await tx
      .select({ customerId: deliveries.customerId, warehouseId: deliveries.warehouseId })
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, order.deliveryId)));
    if (!challan) throw new Error(`Challan ${order.deliveryId} is missing`);
    const lines = await tx
      .select()
      .from(deliveryLines)
      .where(
        and(
          eq(deliveryLines.tenantId, getTenantId()),
          eq(deliveryLines.deliveryId, order.deliveryId),
        ),
      )
      .orderBy(asc(deliveryLines.lineNo));
    return this.salesReturns.createIn(tx, {
      customerId: challan.customerId,
      date: await this.today(tx),
      warehouseId: challan.warehouseId,
      // The return's own list of reasons has no "order cancelled"; the shop order's page says
      // why, and the return's audit row names the order through its challan
      reason: 'other',
      note: null,
      lines: lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        deliveryLineId: line.id,
      })),
      post: true,
    });
  }

  // A failed retry's reason, in its own transaction: the one that failed has rolled back
  private async keepError(id: string, code: ErrorCode): Promise<void> {
    await this.withTenant(async (tx) => {
      await tx
        .update(storefrontOrders)
        .set({ documentError: code, version: sql`${storefrontOrders.version} + 1` })
        .where(
          and(
            eq(storefrontOrders.tenantId, getTenantId()),
            eq(storefrontOrders.id, id),
            sql`${storefrontOrders.salesOrderId} IS NULL`,
          ),
        );
    });
  }
```

- **A packed order's cancel posts a return of the whole challan first.** The return brings the stock back at what it
  cost and, because nothing was billed yet, takes the quantities off the sales order and opens it again (15d). The
  sales order has then delivered nothing, so `cancelIn()` can cancel it (decision 26).
- **A new order's cancel deletes its hold**, and cancels the sales order if the handler made one. An order cancelled
  before the handler ran has none; the handler then finds it cancelled and does nothing.
- **The SMS goes after the commit.** An SMS for a cancel that rolled back would tell the shopper a lie. It names the
  hotline, never the reason (decisions 19 and 31). `SmsQueue.send()` never throws: the cancel stands even with Redis
  away.
- **The return's reason is `other`.** The return's own list has no "order cancelled"; the shop order's page says why.

```ts

  // The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
  // reads them together), the version up, and the audit row of the move
  private async move(
    tx: Transaction,
    before: OrderRow,
    fields: Partial<
      Pick<
        OrderRow,
        | 'status'
        | 'packedAt'
        | 'shippedAt'
        | 'deliveredAt'
        | 'cancelledAt'
        | 'cancelReason'
        | 'deliveryId'
        | 'invoiceId'
        | 'salesReturnId'
      >
    > & { status: StorefrontOrderStatus },
  ): Promise<void> {
    await tx
      .update(storefrontOrders)
      .set({
        ...fields,
        version: sql`${storefrontOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, before.id)));
    const action = {
      confirmed: null,
      packed: 'storefront_order.packed',
      shipped: 'storefront_order.shipped',
      delivered: 'storefront_order.delivered',
      cancelled: 'storefront_order.cancelled',
      returned: null,
    } as const satisfies Record<StorefrontOrderStatus, string | null>;
    const name = action[fields.status];
    if (name === null) throw new Error(`No audit action for ${fields.status}`);
    await audit(tx, {
      action: name,
      entityType: 'storefront_order',
      entityId: before.id,
      changes: diff(
        { order: before.orderNo, status: before.status },
        {
          order: before.orderNo,
          status: fields.status,
          ...(fields.cancelReason === undefined ? {} : { reason: fields.cancelReason }),
        },
      ),
    });
  }
```

`move()` is the one place a move writes the order: the new status, its time and its document in one `UPDATE`, the
version up, the member as `updated_by`, and the move's audit action. The action table is a `Record` over the
statuses, so a status added later does not compile until someone decides whether moving to it is an action.

```ts

  // FOR UPDATE, never a pending order (that one is the shopper's), and the version the page read
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, getTenantId()),
          eq(storefrontOrders.id, id),
          ne(storefrontOrders.status, 'pending'),
        ),
      )
      .for('update');
    if (!order) throw notFound('Shop order');
    if (order.version !== version) throw versionConflict();
    return order;
  }

  private async find(tx: Transaction, id: string): Promise<OrderRow> {
    const [order] = await tx
      .select()
      .from(storefrontOrders)
      .where(
        and(
          eq(storefrontOrders.tenantId, getTenantId()),
          eq(storefrontOrders.id, id),
          ne(storefrontOrders.status, 'pending'),
        ),
      );
    if (!order) throw notFound('Shop order');
    return order;
  }

  // The order's sales order, which Packed and Delivered build on
  private async salesOrderOf(tx: Transaction, order: OrderRow) {
    if (order.salesOrderId === null) {
      throw new AppError(
        409,
        'storefront_order_no_sales_order',
        'This order has no sales order yet. Make the sales order first.',
      );
    }
    const [row] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, order.salesOrderId)));
    if (!row) throw new Error(`Sales order ${order.salesOrderId} is missing`);
    return row;
  }

  private orderLinesOf(tx: Transaction, orderId: string): Promise<OrderLineRow[]> {
    return tx
      .select()
      .from(storefrontOrderLines)
      .where(
        and(
          eq(storefrontOrderLines.tenantId, getTenantId()),
          eq(storefrontOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(storefrontOrderLines.position));
  }

  private salesOrderLinesOf(tx: Transaction, salesOrderId: string) {
    return tx
      .select()
      .from(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, salesOrderId)),
      )
      .orderBy(asc(salesOrderLines.lineNo));
  }

  // The order's lines with what the ERP knows of each variant now: its SKU, its base unit's code
  // and how its stock is tracked
  private async linesOf(tx: Transaction, orderId: string) {
    const tenantId = getTenantId();
    const rows = await tx
      .select({
        line: storefrontOrderLines,
        sku: productVariants.sku,
        unitCode: units.code,
        tracking: products.tracking,
      })
      .from(storefrontOrderLines)
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.tenantId, storefrontOrderLines.tenantId),
          eq(productVariants.id, storefrontOrderLines.variantId),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.tenantId, storefrontOrderLines.tenantId),
          eq(products.id, storefrontOrderLines.productId),
        ),
      )
      .innerJoin(
        units,
        and(eq(units.tenantId, products.tenantId), eq(units.id, products.baseUnitId)),
      )
      .where(
        and(eq(storefrontOrderLines.tenantId, tenantId), eq(storefrontOrderLines.orderId, orderId)),
      )
      .orderBy(asc(storefrontOrderLines.position));
    return rows;
  }

  // The batches with stock in the warehouse, per variant: earliest expiry first (none last), then
  // the oldest batch, the order FEFO takes them in (contract: storefrontPackPlanSchema)
  private async batchesIn(tx: Transaction, warehouseId: string, variantIds: readonly string[]) {
    const byVariant = new Map<string, StorefrontPackPlan['lines'][number]['batches']>();
    if (variantIds.length === 0) return byVariant;
    const rows = await tx
      .select({
        variantId: stockBalances.variantId,
        batchId: batches.id,
        lotNumber: batches.lotNumber,
        expiresOn: batches.expiresOn,
        available: stockBalances.quantity,
      })
      .from(stockBalances)
      .innerJoin(
        batches,
        and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
      )
      .where(
        and(
          eq(stockBalances.tenantId, getTenantId()),
          eq(stockBalances.warehouseId, warehouseId),
          inArray(stockBalances.variantId, [...variantIds]),
          gt(stockBalances.quantity, '0'),
        ),
      )
      .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.createdAt), asc(batches.id));
    for (const { variantId, ...batch } of rows) {
      byVariant.set(variantId, [...(byVariant.get(variantId) ?? []), batch]);
    }
    return byVariant;
  }

  private async today(tx: Transaction): Promise<string> {
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
  }
```

- **`lock()` and `find()` never return a pending order.** That order is the shopper's: it may never be confirmed, and
  the sweep deletes it. A pending id answers 404, like an id of another workspace.
- **`salesOrderOf()`** refuses Packed and Delivered with `storefront_order_no_sales_order` until the sales order
  exists, so the page can say "Make the sales order first".
- **`batchesIn()`** orders by expiry (none last), then the oldest batch, the order the contract promises.

```ts

  // Part of the number ("W-000123", "123"), of the name, or of the phone with its spaces and
  // dashes dropped ("01786 120356"). No index helps here (a LIKE is not leakproof under RLS,
  // 27b.2): the list's index narrows to the workspace and the tab first
  private searchFilter(search: string): SQL {
    const pattern = containsPattern(search.normalize('NFC'));
    const digits = search.replace(/[\s-]/g, '');
    const byPhone = /^\d+$/.test(digits)
      ? sql` OR ${storefrontOrders.phone} LIKE ${containsPattern(digits)}`
      : sql``;
    return sql`(lower(${storefrontOrders.orderNo}) LIKE ${pattern}
      OR lower(${storefrontOrders.customerName}) LIKE ${pattern}${byPhone})`;
  }

  private async read(tx: Transaction, id: string): Promise<StorefrontOrder> {
    const tenantId = getTenantId();
    const order = await this.find(tx, id);
    const lines = await this.linesOf(tx, id);
    // A photo whose file a clean-up removed since shows no picture, not a broken one
    const imageIds = lines.map(({ line }) => storefrontImageSchema.parse(line.image).id);
    const ready = new Set(
      imageIds.length === 0
        ? []
        : (
            await tx
              .select({ id: storefrontImages.id })
              .from(storefrontImages)
              .where(
                and(
                  eq(storefrontImages.tenantId, tenantId),
                  inArray(storefrontImages.id, imageIds),
                  eq(storefrontImages.status, 'ready'),
                ),
              )
          ).map((row) => row.id),
    );
    const [salesOrder] =
      order.salesOrderId === null
        ? []
        : await tx
            .select({
              id: salesOrders.id,
              number: salesOrders.number,
              customerId: parties.id,
              customerName: parties.name,
            })
            .from(salesOrders)
            .innerJoin(
              parties,
              and(
                eq(parties.tenantId, salesOrders.tenantId),
                eq(parties.id, salesOrders.customerId),
              ),
            )
            .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, order.salesOrderId)));
    const ref = async (
      table: typeof deliveries | typeof invoices | typeof salesReturns,
      docId: string | null,
    ): Promise<DocumentRef | null> => {
      if (docId === null) return null;
      const [row] = await tx
        .select({ id: table.id, number: table.number })
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.id, docId)));
      return row ?? null;
    };
    const documentError = order.documentError;
    return {
      ...summaryOf(
        order,
        lines.reduce((count, { line }) => count + line.quantity, 0),
      ),
      address: order.address,
      history: historyOf(order),
      lines: lines.map(({ line, sku, unitCode }) => {
        const image = storefrontImageSchema.parse(line.image);
        return {
          position: line.position,
          listingId: line.listingId,
          name: line.name,
          packSize: line.packSize,
          image: ready.has(image.id)
            ? { ...image, url: shopImage(this.mediaUrl, image, 'small').url }
            : null,
          productId: line.productId,
          variantId: line.variantId,
          sku,
          unitCode,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        };
      }),
      subtotal: order.subtotal,
      discount: order.discount,
      couponCode: order.couponCode,
      deliveryCharge: order.deliveryCharge,
      cancelReason: order.cancelReason,
      customer:
        salesOrder === undefined
          ? null
          : { id: salesOrder.customerId, name: salesOrder.customerName },
      salesOrder:
        salesOrder === undefined ? null : { id: salesOrder.id, number: salesOrder.number },
      delivery: await ref(deliveries, order.deliveryId),
      invoice: await ref(invoices, order.invoiceId),
      salesReturn: await ref(salesReturns, order.salesReturnId),
      // Stored only as an error code (storefront_orders_document_error_check); one this API no
      // longer knows reads as none rather than breaking the page
      documentError: isErrorCode(documentError) ? documentError : null,
      version: order.version,
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}

// FEFO over the batches: take from the first until the line is full, then the next. A line the
// batches cannot fill keeps what they have: the dialog shows the shortfall, and the challan's own
// stock check has the last word
function fefo(
  quantity: string,
  available: StorefrontPackPlan['lines'][number]['batches'],
): StorefrontPackPlan['lines'][number]['picks'] {
  const picks: StorefrontPackPlan['lines'][number]['picks'] = [];
  let left = quantity;
  for (const batch of available) {
    if (compareQuantity(left, '0') <= 0) break;
    const take = compareQuantity(batch.available, left) < 0 ? batch.available : left;
    picks.push({ batchId: batch.batchId, quantity: sumQuantity([take]), serialNumbers: [] });
    left = subtractQuantity(left, take);
  }
  return picks;
}
```

- **The search** looks in the number, the name and, when the text is only digits once spaces and dashes are dropped,
  the phone. `containsPattern()` escapes `%` and `_`, so a search for `50%` does not match everything.
- **A line's photo** is shown only while its file is still ready; a clean-up may have removed an old one since, and a
  broken picture would look like a bug.
- **The customer comes from the sales order** (27b.2 keeps no copy on the order).
- **`documentError` is checked with `isErrorCode()`.** The database stores any snake-case text; a code this API no
  longer knows reads as none instead of failing the whole answer.
- **`fefo()`** takes from each batch until the line is full. A line the batches cannot fill keeps what they have: the
  dialog shows the shortfall, and the challan's own stock rule has the last word.

### The routes

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { StorefrontOrdersService } from './storefront-orders.service.js';

type Routes = typeof routes.storefrontOrders;

// Step 27b: Storefront → Shop orders, the ERP's side of the shop's orders. The contract names each
// route's permission (storefront.order.read or .manage) and the guard checks it; each route hands
// its parsed input to the service. countOrders is declared before getOrder: Nest matches routes in
// the order they are declared, and /storefront/orders/counts would otherwise reach getOrder with
// "counts" as the id (refused by the uuid check, but as a 400, not the count)
@Controller()
export class StorefrontOrdersController {
  constructor(private readonly orders: StorefrontOrdersService) {}

  @Endpoint(routes.storefrontOrders.listOrders)
  listOrders({
    query,
  }: RouteInput<Routes['listOrders']>): Promise<RouteResponse<Routes['listOrders']>> {
    return this.orders.list(query);
  }

  @Endpoint(routes.storefrontOrders.countOrders)
  countOrders(): Promise<RouteResponse<Routes['countOrders']>> {
    return this.orders.counts();
  }

  @Endpoint(routes.storefrontOrders.getOrder)
  getOrder({ params }: RouteInput<Routes['getOrder']>): Promise<RouteResponse<Routes['getOrder']>> {
    return this.orders.get(params.id);
  }

  @Endpoint(routes.storefrontOrders.makeSalesOrder)
  makeSalesOrder({
    params,
    body,
  }: RouteInput<Routes['makeSalesOrder']>): Promise<RouteResponse<Routes['makeSalesOrder']>> {
    return this.orders.makeSalesOrder(params.id, body.version);
  }

  @Endpoint(routes.storefrontOrders.getPackPlan)
  getPackPlan({
    params,
  }: RouteInput<Routes['getPackPlan']>): Promise<RouteResponse<Routes['getPackPlan']>> {
    return this.orders.packPlan(params.id);
  }

  @Endpoint(routes.storefrontOrders.packOrder)
  packOrder({
    params,
    body,
  }: RouteInput<Routes['packOrder']>): Promise<RouteResponse<Routes['packOrder']>> {
    return this.orders.pack(params.id, body);
  }

  @Endpoint(routes.storefrontOrders.shipOrder)
  shipOrder({
    params,
    body,
  }: RouteInput<Routes['shipOrder']>): Promise<RouteResponse<Routes['shipOrder']>> {
    return this.orders.ship(params.id, body.version);
  }

  @Endpoint(routes.storefrontOrders.deliverOrder)
  deliverOrder({
    params,
    body,
  }: RouteInput<Routes['deliverOrder']>): Promise<RouteResponse<Routes['deliverOrder']>> {
    return this.orders.deliver(params.id, body.version);
  }

  @Endpoint(routes.storefrontOrders.cancelOrder)
  cancelOrder({
    params,
    body,
  }: RouteInput<Routes['cancelOrder']>): Promise<RouteResponse<Routes['cancelOrder']>> {
    return this.orders.cancel(params.id, body);
  }
}
```

```diff
@@ -1,6 +1,8 @@
 import { Module } from '@nestjs/common';
 
 import { AttachmentsModule } from '../attachments/attachments.module.js';
+import { ProductsModule } from '../products/products.module.js';
+import { SalesModule } from '../sales/sales.module.js';
 import { StorefrontAppearanceService } from './admin/appearance.service.js';
 import { StorefrontCategoriesService } from './admin/categories.service.js';
 import { StorefrontCollectionsService } from './admin/collections.service.js';
@@ -14,6 +16,9 @@ import { SmsQueue } from '../sms/sms-queue.js';
 import { ShopLimits } from './orders/shop-limits.js';
 import { ShopOrdersController } from './orders/shop-orders.controller.js';
 import { ShopOrdersService } from './orders/shop-orders.service.js';
+import { ShopSalesOrderMaker } from './orders/sales-order-maker.js';
+import { StorefrontOrdersController } from './orders/storefront-orders.controller.js';
+import { StorefrontOrdersService } from './orders/storefront-orders.service.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
 import { ShopDb } from './shop-db.js';
@@ -23,14 +28,18 @@ import { ShopDb } from './shop-db.js';
 // tables and the photo addresses (media.ts), never a service: the public half runs as
 // omnivo_public in a read-only transaction, the admin half as the signed-in member. Step 26h adds
 // Appearance and the text pages, with their own controller (the contract's own group). Step 27a
-// adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send
+// adds the shop server's order routes (orders/), as omnivo_shop, and the SMS they send. Step 27b
+// adds Shop orders, the ERP's side of them (orders/storefront-orders.*): its moves make sales
+// documents with the sales services (SalesModule), and the "Delivery charge" service with
+// ProductsService
 @Module({
-  imports: [AttachmentsModule],
+  imports: [AttachmentsModule, SalesModule, ProductsModule],
   controllers: [
     PublicStorefrontController,
     ShopOrdersController,
     StorefrontAdminController,
     StorefrontAppearanceController,
+    StorefrontOrdersController,
   ],
   providers: [
     ShopDb,
@@ -45,6 +54,8 @@ import { ShopDb } from './shop-db.js';
     StorefrontCollectionsService,
     StorefrontAppearanceService,
     StorefrontPagesService,
+    ShopSalesOrderMaker,
+    StorefrontOrdersService,
   ],
 })
 export class StorefrontModule {}
```

The controller is thin: the contract says each route's permission and the guard checks it. `countOrders` is declared
before `getOrder`, because Nest tries routes in the order they are declared. `StorefrontModule` imports
`SalesModule` and `ProductsModule` for the services; `SalesModule` now exports `DeliveriesService` and
`SalesReturnsService` too.

### The delivery charge's service in the settings

```diff
@@ -3,6 +3,7 @@ import { Inject, Injectable } from '@nestjs/common';
 import {
   addMoney,
   type CreateStorefrontSettingsInput,
+  defaultLineDescription,
   type ShopDeliveryZone,
   type StorefrontReadiness,
   type StorefrontSettings,
@@ -10,8 +11,15 @@ import {
   storefrontSubdomainSchema,
   type UpdateStorefrontSettingsInput,
 } from '@omnivo/contracts';
-import { storefrontSettings, tenants, tenantSettings, warehouses } from '@omnivo/db';
-import { and, eq, isNull, sql } from 'drizzle-orm';
+import {
+  products,
+  productVariants,
+  storefrontSettings,
+  tenants,
+  tenantSettings,
+  warehouses,
+} from '@omnivo/db';
+import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../../common/audit/audit.js';
 import { isUniqueViolation } from '../../common/db/pg-errors.js';
@@ -37,6 +45,15 @@ function warehouseInvalid(): AppError {
   });
 }
 
+// Step 27b: the delivery charge's service (decisions 4 and 17), said on its select
+function deliveryError(
+  code: 'storefront_delivery_product_invalid' | 'storefront_delivery_product_required',
+) {
+  return new AppError(409, code, 'Pick an active service for the delivery charge.', {
+    fieldErrors: { deliveryVariantId: [code] },
+  });
+}
+
 export function notSetUp(): AppError {
   return new AppError(409, 'storefront_not_set_up', 'Save the shop settings first.');
 }
@@ -59,8 +76,13 @@ function zoneIds(input: SettingsInput['deliveryZones'], before: readonly ShopDel
 }
 
 // What the table keeps, from the form. The name in NFC (26f, decision 34): the shop's search folds
-// to NFC, so a Bangla word typed in its other form would miss
-function columnsOf(input: SettingsInput, before: readonly ShopDeliveryZone[]) {
+// to NFC, so a Bangla word typed in its other form would miss. Step 27b: the delivery charge's
+// service as both its ids, which checkDelivery() looked up (the table's FK names the pair)
+function columnsOf(
+  input: SettingsInput,
+  before: readonly ShopDeliveryZone[],
+  delivery: { productId: string; variantId: string } | null,
+) {
   return {
     subdomain: input.subdomain,
     name: input.name.normalize('NFC'),
@@ -76,6 +98,8 @@ function columnsOf(input: SettingsInput, before: readonly ShopDeliveryZone[]) {
     freeDeliveryFrom: input.freeDeliveryFrom,
     minimumOrder: input.minimumOrder,
     paymentMethods: input.paymentMethods,
+    deliveryProductId: delivery?.productId ?? null,
+    deliveryVariantId: delivery?.variantId ?? null,
   };
 }
 
@@ -100,6 +124,7 @@ function snapshot(row: SettingsRow) {
     freeDeliveryFrom: money(row.freeDeliveryFrom),
     minimumOrder: money(row.minimumOrder),
     paymentMethods: row.paymentMethods.join(', '),
+    deliveryVariantId: row.deliveryVariantId,
   };
 }
 
@@ -134,6 +159,7 @@ export class StorefrontSettingsService {
       return {
         baseDomain: this.config.storefront.baseDomain,
         shop: row === null ? null : await this.toSettings(tx, row),
+        deliveryChoices: await this.deliveryChoices(tx, row?.deliveryVariantId ?? null),
         suggested: {
           subdomain: storefrontSubdomainSchema.safeParse(slug).success ? slug : '',
           name: company?.name ?? '',
@@ -148,11 +174,12 @@ export class StorefrontSettingsService {
     try {
       return await this.withTenant(async (tx) => {
         await this.checkWarehouse(tx, input.defaultWarehouseId);
+        const delivery = await this.checkDelivery(tx, input.deliveryVariantId, null);
         const [row] = await tx
           .insert(storefrontSettings)
           .values({
             tenantId: getTenantId(),
-            ...columnsOf(input, []),
+            ...columnsOf(input, [], delivery),
             updatedBy: currentPrincipal().userId,
           })
           // A second first save (two tabs, a double click): the row is there already. Not an
@@ -197,10 +224,11 @@ export class StorefrontSettingsService {
         if (input.defaultWarehouseId !== before.defaultWarehouseId) {
           await this.checkWarehouse(tx, input.defaultWarehouseId);
         }
+        const delivery = await this.checkDelivery(tx, input.deliveryVariantId, before);
         const [after] = await tx
           .update(storefrontSettings)
           .set({
-            ...columnsOf(input, before.deliveryZones),
+            ...columnsOf(input, before.deliveryZones, delivery),
             version: sql`${storefrontSettings.version} + 1`,
             updatedBy: currentPrincipal().userId,
           })
@@ -284,6 +312,95 @@ export class StorefrontSettingsService {
     if (!found) throw warehouseInvalid();
   }
 
+  // Step 27b: the delivery charge's service, as both ids. A new choice must be an active service
+  // of this workspace; the saved one is kept even if it was archived since (like the warehouse:
+  // the next shop order's sales order then says so, and someone picks another). Emptied again
+  // (decision 17): refused once a shop order's sales order has a line of the saved one, or the
+  // next order would make a second "Delivery charge"
+  private async checkDelivery(
+    tx: Transaction,
+    variantId: string | null,
+    before: SettingsRow | null,
+  ): Promise<{ productId: string; variantId: string } | null> {
+    const tenantId = getTenantId();
+    const saved = before?.deliveryVariantId ?? null;
+    if (variantId === null) {
+      if (saved === null) return null;
+      const used = await tx.execute(sql`
+        SELECT 1 FROM storefront_orders o
+          JOIN sales_order_lines l ON l.tenant_id = o.tenant_id AND l.order_id = o.sales_order_id
+         WHERE o.tenant_id = ${tenantId}::uuid AND l.variant_id = ${saved}::uuid
+         LIMIT 1`);
+      if (used.length > 0) throw deliveryError('storefront_delivery_product_required');
+      return null;
+    }
+    const [found] = await tx
+      .select({
+        productId: products.id,
+        type: products.type,
+        archived: sql<boolean>`
+        ${products.archivedAt} IS NOT NULL OR ${productVariants.archivedAt} IS NOT NULL`,
+      })
+      .from(productVariants)
+      .innerJoin(
+        products,
+        and(
+          eq(products.tenantId, productVariants.tenantId),
+          eq(products.id, productVariants.productId),
+        ),
+      )
+      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.id, variantId)));
+    if (!found) throw deliveryError('storefront_delivery_product_invalid');
+    if (variantId !== saved && (found.type !== 'service' || found.archived)) {
+      throw deliveryError('storefront_delivery_product_invalid');
+    }
+    return { productId: found.productId, variantId };
+  }
+
+  // What the select offers (decision 17): the active services, by name, and the saved one even
+  // when it was archived since, so the select can still show what is saved. 200 at most: a
+  // workspace has a few services, not thousands
+  private async deliveryChoices(
+    tx: Transaction,
+    saved: string | null,
+  ): Promise<StorefrontSetup['deliveryChoices']> {
+    const rows = await tx
+      .select({
+        variantId: productVariants.id,
+        productName: products.name,
+        optionValues: productVariants.optionValues,
+        sku: productVariants.sku,
+      })
+      .from(productVariants)
+      .innerJoin(
+        products,
+        and(
+          eq(products.tenantId, productVariants.tenantId),
+          eq(products.id, productVariants.productId),
+        ),
+      )
+      .where(
+        and(
+          eq(productVariants.tenantId, getTenantId()),
+          or(
+            and(
+              eq(products.type, 'service'),
+              isNull(products.archivedAt),
+              isNull(productVariants.archivedAt),
+            ),
+            saved === null ? undefined : eq(productVariants.id, saved),
+          ),
+        ),
+      )
+      .orderBy(asc(sql`lower(${products.name})`), asc(productVariants.sku))
+      .limit(200);
+    return rows.map((row) => ({
+      variantId: row.variantId,
+      name: defaultLineDescription(row),
+      sku: row.sku,
+    }));
+  }
+
   // The launch checklist. The warehouse must still be active (one archived since the save would
   // show every listing out of stock), and "a published listing" is one the shop would show: its
   // product and variant not archived
@@ -333,6 +450,7 @@ export class StorefrontSettingsService {
       freeDeliveryFrom: row.freeDeliveryFrom,
       minimumOrder: row.minimumOrder,
       paymentMethods: row.paymentMethods,
+      deliveryVariantId: row.deliveryVariantId,
       launchedAt: row.launchedAt?.toISOString() ?? null,
       readiness: await this.readiness(tx, row),
       version: row.version,
```

- **`checkDelivery()`** turns the variant id into both ids for the table's pair. A new choice must be an active
  service of this workspace. The saved one is kept even after it was archived, like the warehouse: the next order's
  sales order then says so, and someone picks another.
- **Emptying the box** is refused once a shop order's sales order has a line of the saved service (decision 17):
  the next order would make a second "Delivery charge", and the reports would split the delivery income in two.
- **`deliveryChoices()`** lists the active services, plus the saved one when it was archived, so the select can still
  show what is saved. At most 200: a workspace has a few services.
- **The audit snapshot has `deliveryVariantId`**, so a change of the delivery service shows in the log.

### The cancel SMS

```diff
@@ -1,6 +1,6 @@
 import { type LanguageCode, SHOP_CODE_VALID_MINUTES } from '@omnivo/contracts';
 
-// Step 27a: the shop's two SMS, in the shop's language (storefront_settings.language). Written
+// Step 27a: the shop's two SMS (27b adds a third), in the shop's language (storefront_settings.language). Written
 // here, side by side, like the emails' words (mail/invitation-email.ts): @omnivo/i18n is the
 // browser's. satisfies makes a third language a compile error until it has its words.
 //
@@ -36,3 +36,18 @@ export function confirmedSms(
   } satisfies Record<LanguageCode, string>;
   return words[language];
 }
+
+// Step 27b: the shop cancelled the order (decision 8). The hotline, so the shopper can ask why: the
+// reason the staff typed is theirs (decision 19), and never goes in a message
+export function cancelledSms(
+  language: LanguageCode,
+  shopName: string,
+  orderNo: string,
+  hotline: string,
+): string {
+  const words = {
+    en: `${shopName}: order ${orderNo} was cancelled. Questions? Call ${hotline}.`,
+    bn: `${shopName}: অর্ডার ${orderNo} বাতিল করা হয়েছে। কিছু জানতে কল করুন ${hotline}।`,
+  } satisfies Record<LanguageCode, string>;
+  return words[language];
+}
```

```diff
@@ -1,6 +1,6 @@
 import { describe, expect, it } from 'vitest';
 
-import { codeSms, confirmedSms } from './shop-sms.js';
+import { cancelledSms, codeSms, confirmedSms } from './shop-sms.js';
 
 describe('the shop SMS', () => {
   it('puts the code first, in ASCII digits in both languages', () => {
@@ -19,4 +19,13 @@ describe('the shop SMS', () => {
     );
     expect(confirmedSms('bn', 'Nirvor', 'W-000123', link)).toContain(link);
   });
+
+  it('says the order was cancelled and where to ask, never why', () => {
+    expect(cancelledSms('en', 'Nirvor', 'W-000123', '09610-123456')).toBe(
+      'Nirvor: order W-000123 was cancelled. Questions? Call 09610-123456.',
+    );
+    expect(cancelledSms('bn', 'নির্ভর', 'W-000123', '09610-123456')).toBe(
+      'নির্ভর: অর্ডার W-000123 বাতিল করা হয়েছে। কিছু জানতে কল করুন 09610-123456।',
+    );
+  });
 });
```

Short on purpose, like 27a's two: an English SMS part holds 160 characters, a Bangla one 70, and each part costs the
shop money.

### Two fixtures

```diff
@@ -44,6 +44,13 @@ function order(overrides: Partial<OrderRow> = {}): OrderRow {
     deliveredAt: null,
     cancelledAt: null,
     returnedAt: null,
+    // Step 27b: the ERP documents and their notes; the shop's views read none of them
+    salesOrderId: null,
+    deliveryId: null,
+    invoiceId: null,
+    salesReturnId: null,
+    documentError: null,
+    cancelReason: null,
     ...overrides,
   };
 }
```

```diff
@@ -105,6 +105,8 @@ const FIRST_SAVE: Omit<StorefrontSettingsFormValues, 'version'> = {
   freeDeliveryFrom: '1000',
   minimumOrder: '',
   paymentMethods: ['cod'],
+  // Step 27b: "Made on the first order"
+  deliveryVariantId: '',
 };
 
 // The form again from a saved shop, the way the settings page fills its boxes from the answer
@@ -116,6 +118,7 @@ function formOf(shop: StorefrontSettings): StorefrontSettingsFormValues {
     deliveryZones: shop.deliveryZones.map((zone) => ({ ...zone })),
     freeDeliveryFrom: shop.freeDeliveryFrom ?? '',
     minimumOrder: shop.minimumOrder ?? '',
+    deliveryVariantId: shop.deliveryVariantId ?? '',
     version: shop.version,
   };
 }
```

The order row has 27b.2's six new columns, and the settings form has 27b.1's new box; both fixtures must say them,
or they stop type-checking.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/storefront apps/api/src/sales apps/api/src/products apps/api/src/worker apps/api/src/common/tenant apps/api/src/sms
pnpm --filter @omnivo/contracts gen:openapi
```

The API's unit tests include `contract.spec`, which now finds a handler for each of 27b.1's nine routes. `pnpm
--filter @omnivo/app typecheck` still fails on the settings' new box until 27b.6.

The integration tests of 27b.4 check this part against the real stack (Postgres, Redis, Mailpit and the worker).

Broken on purpose while building, each caught (and put back): Packed without deleting the hold, and the handler
dropping a refusal instead of keeping its code.

## 27b.4 — Tests

27b.3 was checked by one smoke test. This part replaces it with real tests: a new integration file for what staff
can do with a shop order and what the API refuses, and four more tests in 27a's tenant-leak file. Everything runs
against the real stack. An order is placed and confirmed the way a shopper does it (the code comes from Mailpit),
the worker's handler makes its customer and sales order, and the tests move it through the Shop orders routes.

No code of 27b.3 changed: every test passed against it as it was.

Decisions 32 and 33 were made while writing this part (in the list at the top).

### What the order tests share

```diff
@@ -3,6 +3,8 @@ import {
   publicOrderPlacedSchema,
   type ShopOrderRequestInput,
   setupSchema,
+  type StorefrontSettings,
+  type StorefrontSettingsFormValues,
   unitListSchema,
   warehouseListSchema,
 } from '@omnivo/contracts';
@@ -214,3 +216,35 @@ export async function setStock(
     VALUES (${at.tenantId}, ${at.warehouseId}, ${at.productId}, ${at.variantId}, ${quantity})
     ON CONFLICT ON CONSTRAINT stock_balances_key DO UPDATE SET quantity = EXCLUDED.quantity`;
 }
+
+// Step 27b: what the Shop settings form sends for a shop as it is saved, with only the delivery
+// charge's service changed ('' = "Made on the first order"). A zone keeps its id when the id is one
+// the form could send: the one launchShop writes (inside_dhaka) has an underscore, which the form's
+// rule refuses, so it goes as a new zone and the save gives it an id of its own. Read the zone's id
+// again after a save that went through
+export function deliveryServiceUpdate(
+  shop: StorefrontSettings,
+  deliveryVariantId: string,
+): StorefrontSettingsFormValues {
+  return {
+    subdomain: shop.subdomain,
+    name: shop.name,
+    language: shop.language,
+    hotline: shop.hotline,
+    address: shop.address,
+    facebookUrl: shop.facebookUrl ?? '',
+    instagramUrl: shop.instagramUrl ?? '',
+    xUrl: shop.xUrl ?? '',
+    linkedinUrl: shop.linkedinUrl ?? '',
+    defaultWarehouseId: shop.defaultWarehouseId ?? '',
+    deliveryZones: shop.deliveryZones.map((zone) => ({
+      ...zone,
+      id: /^[a-z0-9-]{1,32}$/.test(zone.id) ? zone.id : null,
+    })),
+    freeDeliveryFrom: shop.freeDeliveryFrom ?? '',
+    minimumOrder: shop.minimumOrder ?? '',
+    paymentMethods: shop.paymentMethods,
+    deliveryVariantId,
+    version: shop.version,
+  };
+}
```

`deliveryServiceUpdate()` is the Shop settings form's body for a shop as it is saved, with only the delivery service
changed. Two tests need it: one picks a service, and two others try to empty it or to pick another workspace's.

- Every field comes from the saved settings, so the save changes nothing else. A `null` from the API becomes `''`,
  which is what the form sends for an empty box.
- The zones are the tricky part. `launchShop()` writes the zone id `inside_dhaka`, but the form's rule
  (`ZONE_ID`, `/^[a-z0-9-]{1,32}$/`) has no underscore, so sending that id is refused with a 400. An id the rule
  refuses is sent as `null`, a new zone, and the API gives it a random id of its own. So after a save that went
  through, the test must read the zone's id again: an order that still says `inside_dhaka` is refused as an unknown
  zone.

### The Shop orders tests

The file is long, so it is shown in parts. First the helpers:

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  customerSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  problemSchema,
  type Product,
  productSchema,
  roleSchema,
  salesOrderSchema,
  type ShopOrderRequestInput,
  type StorefrontOrder,
  storefrontOrderCountsSchema,
  storefrontOrderPageSchema,
  storefrontOrderSchema,
  storefrontPackPlanSchema,
  storefrontSetupSchema,
  type TrackingMode,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runWithTenant } from '../../common/tenant/tenant-context.js';
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
  deliveryServiceUpdate,
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
import { OrderConfirmedHandler } from './order-confirmed.handler.js';

// Step 27b: the shop's orders in the ERP, against the real stack. An order is placed and confirmed
// the way a shopper does it (the code from Mailpit), the worker's handler makes its customer and
// sales order, and the tests move it with the routes of Storefront → Shop orders, as the owner, as a
// packer who may do nothing else, and as someone who may only read. Phones and shopper addresses
// start at 800 (phoneOf, clientAddress): the limits count per phone and per address, so no two tests
// share one. Two requests "at the same moment" are held at a table lock (atOnce), never left to luck.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.order.read and .manage, and nothing else: no sales.*, no inventory.*
let packer: SignedIn;
// storefront.order.read only
let reader: SignedIn;
let shop: OrderShop;
// The zone every order is delivered to. launchShop's own id at first; the settings test saves the
// zones again, and the save gives that zone an id of its own (deliveryServiceUpdate)
let zoneId = 'inside_dhaka';
// A batch product (two batches that expire at different times) and a serial one, each listed
let sunscreen: Listed;
let dryer: Listed;

interface Listed {
  product: Product;
  listingId: string;
}

// The order's three ways to fail a move: a step it cannot take from its status, a version the page
// read before someone else moved it, and an order this workspace cannot see
const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(id: string, who = owner): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`, undefined, who);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must go through, as `who`
async function move(
  id: string,
  step: 'pack' | 'ship' | 'deliver' | 'cancel' | 'sales-order',
  body: object,
  who = owner,
): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body, who);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// A move that must be refused with this status; the problem's code and field errors
async function refusedMove(
  id: string,
  step: 'pack' | 'ship' | 'deliver' | 'cancel' | 'sales-order',
  body: object,
  status: number,
) {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(status);
  return refusalSchema.parse(res.json());
}

// The one pick of an untracked line: the whole quantity, no batch
function whole(position: number, quantity: string) {
  return { position, picks: [{ batchId: '', quantity, serialNumbers: [] }] };
}

// Places this request with the code from Mailpit, so the order is confirmed; returns its id. The
// zone is the shop's current one, whatever the request says
async function confirm(n: number, request: ShopOrderRequestInput): Promise<string> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, { ...request, zoneId });
  const { code } = await codeFor(mail.apiUrl, request.phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`
        SELECT id::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${request.phone} AND status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`no confirmed order from ${request.phone}`);
  return row.id;
}

// Two face washes (৳229 each) plus the ৳80 delivery charge: ৳538
function twoNeem(n: number, name?: string): ShopOrderRequestInput {
  const request = orderRequest(shop.listingId, 2, phoneOf(n), '538');
  return name === undefined ? request : { ...request, name };
}

// The order once the worker's handler has made its sales order (or kept why it could not)
async function made(id: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(id);
    expect(order.salesOrder !== null || order.documentError !== null).toBe(true);
    return order;
  });
}

async function confirmedWithSalesOrder(n: number, request = twoNeem(n)): Promise<StorefrontOrder> {
  const order = await made(await confirm(n, request));
  expect(order.documentError).toBeNull();
  return order;
}

async function salesOrderOf(order: StorefrontOrder) {
  const res = await send('GET', `/sales-orders/${order.salesOrder?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return salesOrderSchema.parse(res.json());
}

const auditRowSchema = z.object({ action: z.string(), actor: z.string().nullable() });

// The order's audit rows in the order they were written, read as the superuser
async function auditOf(entityId: string) {
  return z.array(auditRowSchema).parse(
    await sql`
      SELECT action, actor_user_id::text AS actor FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_id = ${entityId}
      ORDER BY created_at, id`,
  );
}

async function userIdOf(email: string): Promise<string> {
  const [row] = z
    .array(z.object({ id: z.uuid() }))
    .parse(await sql`SELECT id::text FROM users WHERE email = ${email}`);
  if (row === undefined) throw new Error(`no user ${email}`);
  return row.id;
}

// A user with a workspace of their own, who then joins this one with a role of these permissions
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

async function addProduct(
  name: string,
  salePrice: string,
  kind: { type?: 'goods' | 'service'; tracking?: TrackingMode; hasExpiry?: boolean } = {},
): Promise<Product> {
  const res = await send('POST', '/products', {
    code: '',
    name,
    type: kind.type ?? 'goods',
    categoryId: '',
    description: '',
    baseUnitId: shop.unitId,
    salesUnitId: '',
    purchaseUnitId: '',
    tracking: kind.tracking ?? 'none',
    hasExpiry: kind.hasExpiry ?? false,
    taxRateId: '',
    options: [],
    variants: [{ id: null, sku: '', optionValues: [], barcode: '', salePrice, archived: false }],
    units: [],
    customFields: {},
  });
  expect(res.statusCode, res.body).toBe(201);
  return productSchema.parse(res.json());
}

// Stock in, with a cost, through a posted stock adjustment: the challan prices what leaves at the
// average cost, and a batch or a serial number exists only once stock brought it in
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

async function addCustomer(name: string, phone: string, extra: object = {}) {
  const res = await send('POST', '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone,
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 0,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

// Sends requests "at the same moment" for sure (27a's shop-orders.int.spec.ts has the long
// story): a transaction of the test's own locks `table`, and only once `waiting` requests wait for
// a lock does the gate open
async function atOnce<T>(table: string, waiting: number, run: () => Promise<T>): Promise<T> {
  const gate = await sql.begin(async (tx) => {
    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE`;
    const sent = run();
    await eventually(async () => {
      const [row] = await tx`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`;
      expect(row?.n).toBe(waiting);
    });
    return { sent };
  });
  return gate.sent;
}
```

- **Three people.** The owner; a packer with `storefront.order.read` and `storefront.order.manage` and nothing else;
  and a reader with `storefront.order.read` only. `member()` makes each one the way 15d's tests do: a user signs up
  for a workspace of their own, joins Nirvor with no role (`joinWithoutRoles`), and gets a new role through the
  roles API, the permission matrix and the member's roles. A role made in SQL could hold a permission the API would
  never let a role have.
- **`zoneId`** starts as `launchShop()`'s id and changes once, after the settings test saves the zones (see
  `deliveryServiceUpdate()` above). `confirm()` always sends the current one, whatever the request says.
- **`confirm()`** places the order, reads the code from Mailpit, sends it, and finds the confirmed order by its phone
  as the superuser. **`made()`** then waits until the worker's handler has either made the sales order or kept why it
  could not. It does not wait for the sales order alone, so a test of a refusal does not wait four seconds for
  nothing.
- **`refusedMove()`** reads only `code` and `fieldErrors` of the problem: the text is for people, and a test that
  checked it would break when the words change.
- **`auditOf()`** reads the audit rows in the order they were written, with the actor. The worker's rows have no
  actor (27b.3's decision 22), so `actor: null` is a real check, not a missing value.
- **`stockLine()`** brings stock in with a posted stock adjustment and a cost of ৳150. `setStock()` (27a) is not
  enough here: a challan prices what leaves at the average cost, and a batch or a serial number exists only once a
  stock document brought it in.
- **`atOnce()`** is 27a's gate (27a.4's decision 33), copied, not shared: the two files each keep their own `sql`.
  Two requests sent together often run one after the other, so the test locks a table in `SHARE` mode, waits until
  the right number of requests wait for a lock, and only then lets them go.

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
  sql = postgres(pg.superuserUrl, { max: 3 });
  owner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 0 });
  const sunscreenProduct = await addProduct('Sunscreen SPF 50', '450', {
    tracking: 'batch',
    hasExpiry: true,
  });
  const dryerProduct = await addProduct('Hair dryer 1200 W', '1800', { tracking: 'serial' });
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
      // FEFO takes SS-A first: it expires first, though it came in after SS-B
      stockLine(sunscreenProduct, '10', { lotNumber: 'SS-B', expiresOn: '2027-09-30' }),
      stockLine(sunscreenProduct, '3', { lotNumber: 'SS-A', expiresOn: '2027-03-31' }),
      stockLine(dryerProduct, '3', { serialNumbers: ['HD-1001', 'HD-1002', 'HD-1003'] }),
    ],
  });
  expect(opening.statusCode, opening.body).toBe(201);
  for (const [product, slug] of [
    [sunscreenProduct, 'sunscreen-spf-50'],
    [dryerProduct, 'hair-dryer'],
  ] as const) {
    const listingId = await addListing(sql, shop.tenantId, {
      product,
      categoryId: shop.categoryId,
      slug,
      publishedDaysAgo: 1,
    });
    if (product === sunscreenProduct) sunscreen = { product, listingId };
    else dryer = { product, listingId };
  }
  packer = await member('sumi@nirvor.com', 'Sumi Akter', [
    'storefront.order.read',
    'storefront.order.manage',
  ]);
  reader = await member('rafiq@nirvor.com', 'Rafiq Islam', ['storefront.order.read']);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});
```

The shop sells three products. Neem Face Wash (200 pieces, untracked) is the one most tests order. Sunscreen SPF 50
has two batches: `SS-B` (10, expires 30 Sep 2027) and `SS-A` (3, expires 31 Mar 2027). `SS-A` is listed second on
purpose: it came in after `SS-B`, but expires first, so a plan that took the batches in the order they arrived would
fail the FEFO test. The hair dryer has three serial numbers. Both new products are listed in the shop with
`addListing()`.

```ts
describe('an order from confirm to delivered', () => {
  it('is packed, shipped and delivered by a packer with only the storefront.order permissions', async () => {
    const id = await confirm(800, twoNeem(800));
    const order = await made(id);
    expect(order).toMatchObject({ status: 'confirmed', documentError: null, itemCount: 2 });
    const so = await salesOrderOf(order);
    expect(so).toMatchObject({
      status: 'confirmed',
      pricesIncludeVat: true,
      customerReference: order.orderNo,
      total: '538.0000',
    });
    // The face washes at the shop's price, then the delivery charge as a service (decision 4)
    expect(so.lines.map((line) => [line.productType, line.quantity, line.unitPrice])).toEqual([
      ['goods', '2.0000', '229.0000'],
      ['service', '1.0000', '80.0000'],
    ]);

    // The packer may not post a challan or an invoice of their own: the moves below need no
    // sales.* (decision 9). The guard answers before the empty body is looked at
    for (const url of ['/deliveries', '/invoices']) {
      expect((await send('POST', url, {}, packer)).statusCode, url).toBe(403);
    }
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${id}/pack-plan`, undefined, packer)).json(),
    );
    expect(plan.warehouse.id).toBe(shop.warehouseId);
    expect(plan.lines).toEqual([
      expect.objectContaining({
        position: 1,
        quantity: '2',
        tracking: 'none',
        batches: [],
        picks: [{ batchId: null, quantity: '2', serialNumbers: [] }],
      }),
    ]);
    const packed = await move(
      id,
      'pack',
      { version: order.version, lines: [whole(1, '2')] },
      packer,
    );
    expect(packed.status).toBe('packed');
    expect(packed.delivery?.number).toMatch(/^DC-/);
    // The stock has really left: the hold is gone, and the challan took the pieces off the shelf
    expect(await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${id}`).toHaveLength(0);
    const [left] = await sql`
      SELECT quantity::text AS q FROM stock_balances
      WHERE tenant_id = ${shop.tenantId} AND variant_id = ${shop.variantId}`;
    expect(left?.q).toBe('198.0000');
    // The sales order is delivered: its only goods line went out (the charge is a service)
    expect((await salesOrderOf(packed)).status).toBe('delivered');

    const shipped = await move(id, 'ship', { version: packed.version }, packer);
    const delivered = await move(id, 'deliver', { version: shipped.version }, packer);
    expect(delivered.status).toBe('delivered');
    const invoice = invoiceSchema.parse(
      (await send('GET', `/invoices/${delivered.invoice?.id ?? ''}`)).json(),
    );
    // Unpaid: the cash the rider brings back is a money receipt (decision 7)
    expect(invoice).toMatchObject({
      status: 'posted',
      total: '538.0000',
      amountPaid: '0.0000',
      customerReference: order.orderNo,
    });
    expect(invoice.lines).toHaveLength(2);
    expect(delivered.history.map((step) => step.status)).toEqual([
      'pending',
      'confirmed',
      'packed',
      'shipped',
      'delivered',
    ]);

    // Who did what: the worker made the sales order with no one behind it; the packer did the rest
    const sumi = await userIdOf('sumi@nirvor.com');
    expect(await auditOf(id)).toEqual([
      { action: 'storefront_order.sales_order_made', actor: null },
      { action: 'storefront_order.packed', actor: sumi },
      { action: 'storefront_order.shipped', actor: sumi },
      { action: 'storefront_order.delivered', actor: sumi },
    ]);

    // The first order with a charge made "Delivery charge" and saved it in the shop's settings
    const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    const saved = setup.shop?.deliveryVariantId ?? null;
    expect(saved).toBe(so.lines[1]?.variantId);
    expect(setup.deliveryChoices).toEqual([
      expect.objectContaining({ variantId: saved, name: 'Delivery charge' }),
    ]);
  });

  it('lets a reader list and open the orders, and refuses every move and the pack plan', async () => {
    const id = await confirm(801, twoNeem(801));
    const order = await made(id);
    const list = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders', undefined, reader)).json(),
    );
    expect(list.items.map((item) => item.id)).toContain(id);
    expect((await send('GET', '/storefront/orders/counts', undefined, reader)).statusCode).toBe(
      200,
    );
    expect((await getOrder(id, reader)).orderNo).toBe(order.orderNo);

    for (const [method, step, body] of [
      ['GET', 'pack-plan', undefined],
      ['POST', 'sales-order', { version: order.version }],
      ['POST', 'pack', { version: order.version, lines: [whole(1, '2')] }],
      ['POST', 'ship', { version: order.version }],
      ['POST', 'deliver', { version: order.version }],
      ['POST', 'cancel', { version: order.version, reason: '' }],
    ] as const) {
      const res = await send(method, `/storefront/orders/${id}/${step}`, body, reader);
      expect(res.statusCode, step).toBe(403);
    }
    // Nothing moved
    expect(await getOrder(id)).toMatchObject({ status: 'confirmed', version: order.version });
  });
});
```

- **The whole life, by the packer.** The handler makes a confirmed sales order with prices that include VAT, ৳538
  to the paisa, and the shop's number as the customer's reference. Its lines are the face washes at the shop's price
  and then the delivery charge as a service. The pack plan suggests the whole line from the order's warehouse.
  Packed posts a challan, ends the hold and takes the two pieces off the shelf (200 → 198); the sales order is then
  "delivered", because its only goods line went out (a service is never delivered). Shipped and Delivered follow;
  the invoice is posted, unpaid, for ৳538 with two lines and the shop's number. The audit rows show the worker's
  `sales_order_made` with no actor and the packer's three moves with the packer's id. Last, the first order with a
  charge made "Delivery charge" and saved it in the settings, and the settings' select offers it.
- **Decision 9.** The packer gets 403 on `POST /deliveries` and `POST /invoices`, so they cannot post a challan or an
  invoice of their own; yet the moves above posted both. The guard answers before the body is read, so an empty body
  is enough. `GET /sales-orders/:id` is not used for this: since step 15b any member may read a sales order (the
  route has no permission), so a 200 there proves nothing.
- **The reader** lists, counts and opens orders, and gets 403 on the pack plan and on every move. The order is not
  changed afterwards: same status, same version.

```ts
describe('the steps', () => {
  it('refuses a step the order cannot take from where it is, and a version read before a move', async () => {
    const order = await confirmedWithSalesOrder(802);
    const { id } = order;
    const step = { code: 'storefront_order_step_invalid' };
    const at = (version: number) => ({ version });

    expect(await refusedMove(id, 'ship', at(order.version), 409)).toMatchObject(step);
    expect(await refusedMove(id, 'deliver', at(order.version), 409)).toMatchObject(step);
    // It has its sales order already: "Make the sales order" is not offered, and not taken
    expect(await refusedMove(id, 'sales-order', at(order.version), 409)).toMatchObject(step);

    const packed = await move(id, 'pack', { version: order.version, lines: [whole(1, '2')] });
    // The page that still has the confirmed order: it must reload, not pack a second challan
    expect(
      await refusedMove(id, 'pack', { version: order.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject({ code: 'version_conflict' });
    expect(
      await refusedMove(id, 'pack', { version: packed.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject(step);
    // Delivered only after Shipped (decision 7)
    expect(await refusedMove(id, 'deliver', at(packed.version), 409)).toMatchObject(step);
    const planned = await send('GET', `/storefront/orders/${id}/pack-plan`);
    expect(refusalSchema.parse(planned.json())).toMatchObject(step);

    const shipped = await move(id, 'ship', at(packed.version));
    // After Shipped a cancel is a return, which is step 28's (decision 8)
    expect(
      await refusedMove(id, 'cancel', { version: shipped.version, reason: '' }, 409),
    ).toMatchObject(step);
    expect(await refusedMove(id, 'ship', at(shipped.version), 409)).toMatchObject(step);
    expect((await getOrder(id)).status).toBe('shipped');
  });

  it('shows no order that waits for its code, and moves none', async () => {
    const phone = phoneOf(803);
    await placeOrder(app, shopHeaders(shop.host, clientAddress(803)), {
      ...orderRequest(shop.listingId, 2, phone, '538'),
      zoneId,
    });
    const [row] = z
      .array(z.object({ id: z.uuid() }))
      .parse(await sql`SELECT id::text FROM storefront_orders WHERE phone = ${phone}`);
    const id = row?.id ?? '';
    expect((await send('GET', `/storefront/orders/${id}`)).statusCode).toBe(404);
    expect((await send('GET', `/storefront/orders/${id}/pack-plan`)).statusCode).toBe(404);
    expect(await refusedMove(id, 'cancel', { version: 1, reason: '' }, 404)).toMatchObject({
      code: 'not_found',
    });
    const all = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=all&limit=100')).json(),
    );
    expect(all.items.map((item) => item.id)).not.toContain(id);
  });
});
```

- **Steps.** One order is walked through its life, and at each step every move it cannot take is tried:
  Shipped and Delivered on a new order, "Make the sales order" when it has one, Packed twice, Delivered before
  Shipped (decision 7), the pack plan after Packed, and Cancel after Shipped (step 28's return). Each answers
  `storefront_order_step_invalid`. The page that still has the confirmed order and sends Packed again gets
  `version_conflict` first: the version is checked before the step, so it is told to reload.
- **An order that waits for its code** is the shopper's, not the staff's (decision 13): 404 on the page, on the
  pack plan and on a move, and it is not in the All tab.

```ts
describe('the customer', () => {
  it('is the oldest active one with the phone, typed in any form; an archived one is left out', async () => {
    // phoneOf(804), 01711000804, typed three ways. The first is the oldest, but archived
    const old = await addCustomer('Mirpur Beauty Corner', '+880 1711-000804');
    const archived = await send('POST', `/customers/${old.id}/archive`, { version: old.version });
    expect(archived.statusCode, archived.body).toBe(200);
    const oldest = await addCustomer('Sylhet Pharmacy', '01711 000804');
    await addCustomer('Sylhet Pharmacy (branch)', '01711-000-804');

    const order = await confirmedWithSalesOrder(804);
    expect(order.customer).toEqual({ id: oldest.id, name: 'Sylhet Pharmacy' });
    const [count] = await sql`
      SELECT count(*)::int AS n FROM parties
      WHERE tenant_id = ${shop.tenantId} AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE '%1711000804'`;
    expect(count?.n).toBe(3);
  });

  it('is new when no one has the phone: no credit limit, the shop language, the address saved', async () => {
    const order = await confirmedWithSalesOrder(805, twoNeem(805, 'Tanvir Hasan'));
    const customer = customerSchema.parse(
      (await send('GET', `/customers/${order.customer?.id ?? ''}`)).json(),
    );
    expect(customer).toMatchObject({
      name: 'Tanvir Hasan',
      phone: phoneOf(805),
      creditLimit: null,
      documentLanguage: 'en',
    });
    expect(customer.addresses).toEqual([
      expect.objectContaining({ kind: 'shipping', address: 'House 12, Road 5, Mirpur 10, Dhaka' }),
    ]);
  });

  it('goes over a credit limit, and the audit log has the override with no one behind it', async () => {
    const limited = await addCustomer('Uttara Cosmetics', phoneOf(806), { creditLimit: '100' });
    const order = await confirmedWithSalesOrder(806);
    expect(order.customer?.id).toBe(limited.id);
    const so = await salesOrderOf(order);
    expect(so.status).toBe('confirmed');
    expect(await auditOf(so.id)).toContainEqual({ action: 'credit_limit.overridden', actor: null });
  });
});
```

- **Found by phone.** `01711000804` is typed three ways on three customers: `+880 1711-000804`, `01711 000804` and
  `01711-000-804`. The first is the oldest but archived, so the second is used (decision 2): the oldest active one.
  No new customer is made.
- **A new customer** has the shopper's name and phone, no credit limit, the shop's language, and the address saved as
  a shipping address.
- **Over the limit.** A customer with a ৳100 limit orders ৳538. The sales order is still made and confirmed (a
  shopper's order stands, like a POS sale), and the audit log has `credit_limit.overridden` on that sales order with
  no actor: the row staff use to find every override.

```ts
describe('the delivery charge', () => {
  it('is sold as the service picked in the settings, and a free delivery adds no line', async () => {
    const before = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    if (before.shop === null) throw new Error('no shop');
    // A product that is not a service is refused
    const goods = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(before.shop, shop.variantId),
    );
    expect(refusalSchema.parse(goods.json())).toMatchObject({
      code: 'storefront_delivery_product_invalid',
      fieldErrors: { deliveryVariantId: ['storefront_delivery_product_invalid'] },
    });
    const courier = await addProduct('Courier charge', '', { type: 'service' });
    const courierVariant = courier.variants[0]?.id ?? '';
    const saved = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(before.shop, courierVariant),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const after = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    expect(after.shop?.deliveryVariantId).toBe(courierVariant);
    zoneId = after.shop?.deliveryZones[0]?.id ?? '';

    const charged = await salesOrderOf(await confirmedWithSalesOrder(807));
    expect(charged.lines.map((line) => line.variantId)).toEqual([shop.variantId, courierVariant]);
    // 5 × ৳229 = ৳1,145, over the shop's ৳1,000: no delivery charge, so no line of ৳0
    const free = await salesOrderOf(
      await confirmedWithSalesOrder(808, orderRequest(shop.listingId, 5, phoneOf(808), '1145')),
    );
    expect(free.lines.map((line) => line.variantId)).toEqual([shop.variantId]);
    expect(free.total).toBe('1145.0000');
    // Still the one "Delivery charge" the first order made: none was made for these
    const [count] = await sql`
      SELECT count(*)::int AS n FROM products
      WHERE tenant_id = ${shop.tenantId} AND name = 'Delivery charge'`;
    expect(count?.n).toBe(1);
  });
});
```

The settings refuse the face wash as the delivery service (a product that is not a service), with the error under
the select. A service made for it, "Courier charge", is accepted. The next order's sales order sells the charge as
that service. An order of five face washes (৳1,145, over the free-delivery line of ৳1,000) has no delivery line at
all, not a line of ৳0. In all of this only the one "Delivery charge" the first order made exists.

```ts
describe('packing tracked stock', () => {
  it('suggests the batch that expires first, and names the pick that asks too much of a batch', async () => {
    const order = await confirmedWithSalesOrder(
      809,
      // 5 × ৳450 = ৳2,250: free delivery
      orderRequest(sunscreen.listingId, 5, phoneOf(809), '2250'),
    );
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    const [line] = plan.lines;
    expect(line?.tracking).toBe('batch');
    expect(line?.batches.map((batch) => [batch.lotNumber, batch.available])).toEqual([
      ['SS-A', '3.0000'],
      ['SS-B', '10.0000'],
    ]);
    const [a, b] = line?.batches ?? [];
    expect(line?.picks).toEqual([
      // The quantities as the API writes stock (4 decimals); the dialog shows them in the unit's
      { batchId: a?.batchId, quantity: '3.0000', serialNumbers: [] },
      { batchId: b?.batchId, quantity: '2.0000', serialNumbers: [] },
    ]);

    // One from SS-B and four from SS-A, which has three: the error is on the second pick
    const over = await refusedMove(
      order.id,
      'pack',
      {
        version: order.version,
        lines: [
          {
            position: 1,
            picks: [
              { batchId: b?.batchId, quantity: '1', serialNumbers: [] },
              { batchId: a?.batchId, quantity: '4', serialNumbers: [] },
            ],
          },
        ],
      },
      409,
    );
    expect(over).toMatchObject({
      code: 'stock_insufficient',
      fieldErrors: { 'lines.0.picks.1.quantity': ['stock_insufficient'] },
    });
    // Picks that do not add up to the line: the packer's box is short
    const short = await refusedMove(
      order.id,
      'pack',
      {
        version: order.version,
        lines: [
          { position: 1, picks: [{ batchId: a?.batchId, quantity: '3', serialNumbers: [] }] },
        ],
      },
      409,
    );
    expect(short.fieldErrors).toEqual({ 'lines.0.picks': ['storefront_order_pick_total'] });

    const packed = await move(order.id, 'pack', {
      version: order.version,
      lines: [
        {
          position: 1,
          picks: (line?.picks ?? []).map((pick) => ({ ...pick, batchId: pick.batchId ?? '' })),
        },
      ],
    });
    expect(packed.status).toBe('packed');
    const left = await sql`
      SELECT b.lot_number AS lot, s.quantity::text AS q FROM stock_balances s
      JOIN batches b ON b.tenant_id = s.tenant_id AND b.id = s.batch_id
      WHERE s.tenant_id = ${shop.tenantId} AND s.variant_id = ${sunscreen.product.variants[0]?.id ?? ''}
      ORDER BY b.lot_number`;
    expect(
      z
        .array(z.object({ lot: z.string(), q: z.string() }))
        .parse(left)
        .map((row) => [row.lot, row.q]),
    ).toEqual([
      ['SS-A', '0.0000'],
      ['SS-B', '8.0000'],
    ]);
  });

  it('packs a serial product with the numbers the packer types, and a cancel brings them back', async () => {
    // 2 × ৳1,800: free delivery
    const order = await confirmedWithSalesOrder(
      810,
      orderRequest(dryer.listingId, 2, phoneOf(810), '3600'),
    );
    const plan = storefrontPackPlanSchema.parse(
      (await send('GET', `/storefront/orders/${order.id}/pack-plan`)).json(),
    );
    // Only the packer knows which pieces went in the box: no suggestion
    expect(plan.lines[0]).toMatchObject({ tracking: 'serial', batches: [], picks: [] });
    const pack = (serialNumbers: string[]) => ({
      version: order.version,
      lines: [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers }] }],
    });
    expect(await refusedMove(order.id, 'pack', pack(['HD-1001']), 409)).toMatchObject({
      fieldErrors: { 'lines.0.picks.0.serialNumbers': ['stock_serial_count'] },
    });
    expect(await refusedMove(order.id, 'pack', pack(['HD-1001', 'HD-9999']), 409)).toMatchObject({
      code: 'stock_serial_not_here',
    });
    const packed = await move(order.id, 'pack', pack(['HD-1001', 'HD-1003']));
    // The dryer's serial numbers on a shelf (a serial out of stock has no warehouse)
    const serials = async () =>
      z
        .array(z.object({ s: z.string() }))
        .parse(
          await sql`
            SELECT serial_number AS s FROM serials
            WHERE tenant_id = ${shop.tenantId} AND warehouse_id IS NOT NULL
            ORDER BY serial_number`,
        )
        .map((row) => row.s);
    expect(await serials()).toEqual(['HD-1002']);

    const cancelled = await move(order.id, 'cancel', {
      version: packed.version,
      reason: 'Customer did not answer the phone',
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer did not answer the phone',
    });
    expect(cancelled.salesReturn?.number).toMatch(/^SR-/);
    expect(await serials()).toEqual(['HD-1001', 'HD-1002', 'HD-1003']);
    expect((await salesOrderOf(cancelled)).status).toBe('cancelled');
    // The shopper hears of it by SMS, without the staff's reason
    await eventually(async () => {
      const sms = await lastMailTo(mail.apiUrl, smsAddress(phoneOf(810)));
      expect(sms.text).toContain(`${order.orderNo} was cancelled`);
      expect(sms.text).not.toContain('did not answer');
    });
  });
});
```

- **Batches.** For five sunscreens the plan lists `SS-A` (3) before `SS-B` (10) and suggests 3 from `SS-A` and 2
  from `SS-B`. One from `SS-B` and four from `SS-A`, which has three, is refused with `stock_insufficient` under
  `lines.0.picks.1.quantity`: the second pick of the first line, the box the packer must change. This is the
  challan's own stock check, its error path moved from the challan's lines to the order's picks by `onPicks()`.
  Picks that add up to three, not five, are refused under the line (`storefront_order_pick_total`). The plan's picks
  then go through, and the shelf has 0 of `SS-A` and 8 of `SS-B`.
- **Serial numbers.** The plan suggests nothing (only the packer knows which pieces went into the box). One number
  for two pieces is refused under the pick's serial box, a number that is not in the warehouse with
  `stock_serial_not_here`. Two right numbers go through and leave one dryer on the shelf. Cancelling the packed
  order posts a sales return, brings both numbers back, cancels the sales order, and sends the shopper an SMS that
  says the order was cancelled, without the staff's reason.

```ts
describe('a cancel before packing', () => {
  it('ends the hold and cancels the sales order', async () => {
    const order = await confirmedWithSalesOrder(811);
    const gone = await move(order.id, 'cancel', { version: order.version, reason: '' });
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: null, salesReturn: null });
    expect(
      await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${order.id}`,
    ).toHaveLength(0);
    expect((await salesOrderOf(gone)).status).toBe('cancelled');
    expect((await auditOf(order.id)).map((row) => row.action)).toEqual([
      'storefront_order.sales_order_made',
      'storefront_order.cancelled',
    ]);
  });

  it('may not empty the delivery service once an order used it', async () => {
    const setup = storefrontSetupSchema.parse((await send('GET', '/storefront/settings')).json());
    if (setup.shop === null) throw new Error('no shop');
    const emptied = await send(
      'PUT',
      '/storefront/settings',
      deliveryServiceUpdate(setup.shop, ''),
    );
    expect(refusalSchema.parse(emptied.json()).code).toBe('storefront_delivery_product_required');
  });
});

describe('a sales order that cannot be made', () => {
  it('keeps the reason, refuses to pack, and is made when the page asks again', async () => {
    // No default VAT rate and none on the product: the sales order is refused
    await sql`UPDATE tax_rates SET is_default = false WHERE tenant_id = ${shop.tenantId}`;
    const id = await confirm(812, twoNeem(812));
    const failed = await made(id);
    expect(failed).toMatchObject({ documentError: 'tax_rate_invalid', needsAttention: true });
    expect(
      await refusedMove(id, 'pack', { version: failed.version, lines: [whole(1, '2')] }, 409),
    ).toMatchObject({ code: 'storefront_order_no_sales_order' });
    // Asked again before the cause is fixed: the same reason, kept, and the version moves on
    expect(await refusedMove(id, 'sales-order', { version: failed.version }, 409)).toMatchObject({
      code: 'tax_rate_invalid',
    });
    const still = await getOrder(id);
    expect(still.documentError).toBe('tax_rate_invalid');

    await sql`
      UPDATE tax_rates SET is_default = true
      WHERE tenant_id = ${shop.tenantId} AND name = 'VAT 15%'`;
    const retried = await move(id, 'sales-order', { version: still.version });
    expect(retried).toMatchObject({ documentError: null, needsAttention: false });
    expect(retried.salesOrder?.number).toMatch(/^SO-/);
  });
});
```

- **A cancel before Packed** ends the hold and cancels the sales order, with no return. Its audit rows are the
  sales order and the cancel.
- **Emptying the delivery service** is refused once an order used it (`storefront_delivery_product_required`): an
  old order's sales order still names it.
- **A sales order that cannot be made.** With no VAT rate anywhere, the handler keeps `tax_rate_invalid` on the order,
  and the list says it needs attention. Packed is refused with `storefront_order_no_sales_order`. "Make the sales
  order" before the cause is fixed is refused with the same code, which stays on the order. With the rate back, it
  makes the sales order and the error is gone.

```ts
describe('at the same moment', () => {
  it('lets one of pack and cancel through, and the documents match the status it left', async () => {
    const order = await confirmedWithSalesOrder(813);
    // Both lock the order first; the one that gets it waits at the holds, the other at the order
    const [pack, cancel] = await atOnce('storefront_stock_holds', 2, () =>
      Promise.all([
        send('POST', `/storefront/orders/${order.id}/pack`, {
          version: order.version,
          lines: [whole(1, '2')],
        }),
        send('POST', `/storefront/orders/${order.id}/cancel`, {
          version: order.version,
          reason: '',
        }),
      ]),
    );
    const codes = [pack, cancel].map((res) => res.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    const loser = pack.statusCode === 409 ? pack : cancel;
    expect(refusalSchema.parse(loser.json()).code).toBe('version_conflict');

    const after = await getOrder(order.id);
    const so = await salesOrderOf(after);
    if (after.status === 'packed') {
      expect(after.delivery).not.toBeNull();
      // Every piece of goods went on the challan; the delivery charge is a service, never delivered
      expect(so.status).toBe('delivered');
    } else {
      expect(after.status).toBe('cancelled');
      expect(after.delivery).toBeNull();
      expect(so.status).toBe('cancelled');
    }
    expect(
      await sql`SELECT 1 FROM storefront_stock_holds WHERE order_id = ${order.id}`,
    ).toHaveLength(0);
  });

  it('makes one sales order when the job and the page make it together, and none on a second run', async () => {
    await sql`UPDATE tax_rates SET is_default = false WHERE tenant_id = ${shop.tenantId}`;
    const id = await confirm(814, twoNeem(814));
    const failed = await made(id);
    expect(failed.documentError).toBe('tax_rate_invalid');
    await sql`
      UPDATE tax_rates SET is_default = true
      WHERE tenant_id = ${shop.tenantId} AND name = 'VAT 15%'`;

    // The confirm's own event, run again by the handler as the worker would after a retry
    const [event] = z.array(z.object({ id: z.uuid() })).parse(
      await sql`
          SELECT id::text FROM outbox_events
          WHERE type = 'storefront.order_confirmed' AND payload->>'orderId' = ${id}`,
    );
    const handler = worker.get(OrderConfirmedHandler);
    const runJob = () =>
      runWithTenant(shop.tenantId, () =>
        handler.handle({
          id: event?.id ?? '',
          tenantId: shop.tenantId,
          type: 'storefront.order_confirmed',
          payload: { orderId: id },
          requestId: null,
        }),
      );
    // The one that locks the order first waits at the sales orders; the other at the order
    const [page] = await atOnce('sales_orders', 2, () =>
      Promise.all([
        send('POST', `/storefront/orders/${id}/sales-order`, { version: failed.version }),
        runJob(),
      ]),
    );
    // The page wins (200) or finds the job made it (the version moved on)
    expect([200, 409]).toContain(page.statusCode);
    await runJob();

    const after = await getOrder(id);
    const rows = await sql`
      SELECT id::text FROM sales_orders
      WHERE tenant_id = ${shop.tenantId} AND customer_reference = ${after.orderNo}`;
    expect(
      z
        .array(z.object({ id: z.uuid() }))
        .parse(rows)
        .map((row) => row.id),
    ).toEqual([after.salesOrder?.id]);
    expect(
      (await auditOf(id)).filter((row) => row.action === 'storefront_order.sales_order_made'),
    ).toHaveLength(1);
    // The bell rang once for the order, however many times the job ran
    const [bells] = await sql`
      SELECT count(*)::int AS n FROM notifications
      WHERE tenant_id = ${shop.tenantId} AND type = 'storefront.order_confirmed'
        AND params->>'id' = ${id} AND user_id = ${await userIdOf('nusrat@nirvor.com')}`;
    expect(bells?.n).toBe(1);
  });
});
```

- **Packed and Cancel at once.** Both lock the order first. The one that gets the lock goes on and waits at the
  holds (the test's gate locks `storefront_stock_holds`); the other waits for the order. When the gate opens, one
  gets 200 and the other `version_conflict`. Which one wins is up to Postgres, so the test checks the documents
  against whatever status is left: packed means a challan and a delivered sales order; cancelled means no challan
  and a cancelled sales order. Either way the hold is gone.
- **The job and the page at once.** With no VAT rate the handler fails, and the rate is put back. Then the confirm's
  own event is run again by the handler (as the worker would after a retry), at the same moment as "Make the sales
  order" on the page; the gate locks `sales_orders`. Whichever locks the order first makes the sales order; the
  other finds it made (the job returns) or finds the version moved on (the page gets 409). The handler is then run a
  third time. In the end there is one sales order with the shop's number, one `sales_order_made` row, and one bell
  for the owner: the bell's key is the event's id. `runWithTenant()` gives the handler the workspace, the way the
  worker's job runner does.

```ts
describe('the list', () => {
  it('shows each tab its own orders, and the count of new ones', async () => {
    const statusOf = z.array(z.object({ status: z.string(), n: z.number() }));
    const byStatus = new Map(
      statusOf
        .parse(
          await sql`
            SELECT status, count(*)::int AS n FROM storefront_orders
            WHERE tenant_id = ${shop.tenantId} AND status <> 'pending' GROUP BY status`,
        )
        .map((row) => [row.status, row.n]),
    );
    for (const view of ['confirmed', 'packed', 'shipped', 'delivered', 'cancelled'] as const) {
      const page = storefrontOrderPageSchema.parse(
        (await send('GET', `/storefront/orders?view=${view}&limit=100`)).json(),
      );
      expect(
        page.items.every((item) => item.status === view),
        view,
      ).toBe(true);
      expect(page.items, view).toHaveLength(byStatus.get(view) ?? 0);
    }
    const counts = storefrontOrderCountsSchema.parse(
      (await send('GET', '/storefront/orders/counts')).json(),
    );
    expect(counts.confirmed).toBe(byStatus.get('confirmed'));
  });

  it('sorts by total both ways a page at a time, and refuses the cursor of another sort', async () => {
    const all = z.array(z.object({ id: z.uuid(), total: z.string() })).parse(
      await sql`
        SELECT id::text, total::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND status <> 'pending'`,
    );
    // Two face-wash orders have one total: the id breaks the tie, the same way both directions
    const byTotal = [...all].sort(
      (a, b) => Number(a.total) - Number(b.total) || a.id.localeCompare(b.id),
    );
    const walk = async (sort: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ view: 'all', sort, limit: '3' });
        if (cursor !== null) query.set('cursor', cursor);
        const page = storefrontOrderPageSchema.parse(
          (await send('GET', `/storefront/orders?${query.toString()}`)).json(),
        );
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return ids;
    };
    expect(await walk('total')).toEqual(byTotal.map((row) => row.id));
    expect(await walk('-total')).toEqual(byTotal.map((row) => row.id).reverse());

    const first = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=all&sort=-total&limit=2')).json(),
    );
    const other = await send(
      'GET',
      `/storefront/orders?view=all&sort=confirmed&limit=2&cursor=${first.nextCursor ?? ''}`,
    );
    expect(other.statusCode).toBe(400);
    expect(refusalSchema.parse(other.json()).code).toBe('invalid_cursor');
  });

  it('finds an order by part of its number, the name, or the phone typed with spaces', async () => {
    const tanvir = await getOrder(
      z
        .array(z.object({ id: z.uuid() }))
        .parse(await sql`SELECT id::text FROM storefront_orders WHERE phone = ${phoneOf(805)}`)[0]
        ?.id ?? '',
    );
    const found = async (search: string) =>
      storefrontOrderPageSchema
        .parse(
          (
            await send('GET', `/storefront/orders?view=all&search=${encodeURIComponent(search)}`)
          ).json(),
        )
        .items.map((item) => item.id);
    expect(await found('tanvir')).toEqual([tanvir.id]);
    expect(await found('01711 000805')).toEqual([tanvir.id]);
    expect(await found(tanvir.orderNo.toLowerCase())).toEqual([tanvir.id]);
    expect(await found('Nobody by this name')).toEqual([]);
  });
});
```

- **Tabs.** Each tab has exactly the orders of its status (counted by the superuser), and the New count is the
  number of confirmed ones.
- **Sorting and paging.** All the orders are walked three to a page by total, up and down, and compared with the
  same order worked out from the database. Two face-wash orders have the same total, so the id must break the tie,
  the same way in both directions, or a page would repeat or skip one. A cursor made for one sort and sent with
  another is refused (`invalid_cursor`), not read as the wrong key.
- **Search** finds Tanvir's order by part of the name, by the phone typed with a space, and by the number in lower
  case, and finds nothing for a name nobody has.

### The tenant-leak tests

```diff
@@ -5,6 +5,11 @@ import {
   problemSchema,
   SHOP_ORDERS_PER_PHONE,
   shopOrderConfirmedSchema,
+  type StorefrontOrder,
+  storefrontOrderCountsSchema,
+  storefrontOrderPageSchema,
+  storefrontOrderSchema,
+  storefrontSetupSchema,
 } from '@omnivo/contracts';
 import { sql as drizzleSql } from 'drizzle-orm';
 import postgres from 'postgres';
@@ -28,9 +33,11 @@ import {
   type TestRedis,
 } from '../../testing/containers.js';
 import { bearer, type SignedIn, signUp } from '../../testing/http.js';
+import { lastMailTo } from '../../testing/mailpit.js';
 import {
   clientAddress,
   codeFor,
+  deliveryServiceUpdate,
   type OrderShop,
   orderRequest,
   orderShop,
@@ -38,6 +45,7 @@ import {
   placeOrder,
   shopHeaders,
   shopPost,
+  smsAddress,
   trackingTokenFor,
 } from '../../testing/shop-orders.js';
 import { ShopDb } from '../shop-db.js';
@@ -269,6 +277,193 @@ describe('two shops', () => {
   });
 });
 
+// Step 27b: Storefront → Shop orders. Each workspace's staff see, move and plan their own shop's
+// orders only, the sales order's customer is found among the workspace's own customers, and a
+// service of another workspace cannot be the delivery charge
+describe("the ERP's shop orders", () => {
+  function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
+    return app.inject({
+      method,
+      url,
+      headers: bearer(who.accessToken),
+      ...(payload === undefined ? {} : { payload }),
+    });
+  }
+
+  async function idOf(shop: OrderShop, orderNo: string): Promise<string> {
+    const [row] = z.array(z.object({ id: z.uuid() })).parse(
+      await sql`
+          SELECT id::text FROM storefront_orders
+          WHERE tenant_id = ${shop.tenantId} AND order_no = ${orderNo}`,
+    );
+    if (row === undefined) throw new Error(`no order ${orderNo}`);
+    return row.id;
+  }
+
+  // The order once the worker has made its sales order, read by its own workspace's owner
+  async function withSalesOrder(who: SignedIn, id: string): Promise<StorefrontOrder> {
+    return eventually(async () => {
+      const res = await send(who, 'GET', `/storefront/orders/${id}`);
+      expect(res.statusCode, res.body).toBe(200);
+      const order = storefrontOrderSchema.parse(res.json());
+      expect(order.salesOrder).not.toBeNull();
+      return order;
+    });
+  }
+
+  async function confirmedIn(tenantId: string): Promise<string[]> {
+    return z
+      .array(z.object({ id: z.string() }))
+      .parse(
+        await sql`
+          SELECT id::text FROM storefront_orders
+          WHERE tenant_id = ${tenantId} AND status <> 'pending'`,
+      )
+      .map((row) => row.id)
+      .sort();
+  }
+
+  it("open, plan and move none of the other workspace's orders", async () => {
+    const id = await idOf(nirvor, nirvorOrder.orderNo);
+    const before = await withSalesOrder(nirvorOwner, id);
+    const { version } = before;
+    for (const [method, step, body] of [
+      ['GET', '', undefined],
+      ['GET', '/pack-plan', undefined],
+      ['POST', '/sales-order', { version }],
+      [
+        'POST',
+        '/pack',
+        {
+          version,
+          lines: [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }],
+        },
+      ],
+      ['POST', '/ship', { version }],
+      ['POST', '/deliver', { version }],
+      ['POST', '/cancel', { version, reason: 'Not ours' }],
+    ] as const) {
+      const res = await send(acmeOwner, method, `/storefront/orders/${id}${step}`, body);
+      expect(res.statusCode, `${method} ${step}`).toBe(404);
+      expect(problemOf(res).code).toBe('not_found');
+    }
+    // Untouched at Nirvor: still new, still the version its page read
+    const after = await send(nirvorOwner, 'GET', `/storefront/orders/${id}`);
+    expect(storefrontOrderSchema.parse(after.json())).toMatchObject({
+      status: 'confirmed',
+      version,
+    });
+  });
+
+  it('list, count and search their own orders only', async () => {
+    await withSalesOrder(acmeOwner, await idOf(acme, acmeOrder.orderNo));
+    for (const [who, shop] of [
+      [nirvorOwner, nirvor],
+      [acmeOwner, acme],
+    ] as const) {
+      const page = storefrontOrderPageSchema.parse(
+        (await send(who, 'GET', '/storefront/orders?view=all&limit=100')).json(),
+      );
+      expect(page.items.map((item) => item.id).sort()).toEqual(await confirmedIn(shop.tenantId));
+      const counts = storefrontOrderCountsSchema.parse(
+        (await send(who, 'GET', '/storefront/orders/counts')).json(),
+      );
+      const [row] = countSchema.parse(
+        await sql`
+          SELECT count(*)::int AS n FROM storefront_orders
+          WHERE tenant_id = ${shop.tenantId} AND status = 'confirmed'`,
+      );
+      expect(counts.confirmed).toBe(row?.n);
+    }
+    // Nirvor's buyer, searched for at Acme by phone and by number: nothing. Acme's own W-000001
+    // is the only one with that number there
+    const byPhone = storefrontOrderPageSchema.parse(
+      (
+        await send(acmeOwner, 'GET', `/storefront/orders?view=all&search=${nirvorOrder.phone}`)
+      ).json(),
+    );
+    expect(byPhone.items).toEqual([]);
+    const byNumber = storefrontOrderPageSchema.parse(
+      (
+        await send(acmeOwner, 'GET', `/storefront/orders?view=all&search=${nirvorOrder.orderNo}`)
+      ).json(),
+    );
+    expect(byNumber.items.map((item) => item.id)).toEqual([await idOf(acme, acmeOrder.orderNo)]);
+  });
+
+  it("find or make the customer and the delivery service in the order's own workspace", async () => {
+    // Nirvor's buyer orders from Acme too. Nirvor has a customer with this phone; Acme must not
+    // find it, but make its own
+    const nirvorCustomer = (
+      await withSalesOrder(nirvorOwner, await idOf(nirvor, nirvorOrder.orderNo))
+    ).customer;
+    const headers = shopHeaders(acme.host, clientAddress(41));
+    const sent = await lastMailTo(mail.apiUrl, smsAddress(nirvorOrder.phone));
+    const token = await placeOrder(
+      app,
+      headers,
+      orderRequest(acme.listingId, 2, nirvorOrder.phone, TWO),
+    );
+    const { code } = await codeFor(mail.apiUrl, nirvorOrder.phone, sent.id);
+    const res = await shopPost(app, '/orders/verify', headers, { token, code });
+    expect(res.statusCode, res.body).toBe(200);
+    const { orderNo } = shopOrderConfirmedSchema.parse(res.json());
+    const acmeCustomer = (await withSalesOrder(acmeOwner, await idOf(acme, orderNo))).customer;
+    expect(acmeCustomer).not.toBeNull();
+    expect(acmeCustomer?.id).not.toBe(nirvorCustomer?.id);
+    expect(
+      (await send(nirvorOwner, 'GET', `/customers/${acmeCustomer?.id ?? ''}`)).statusCode,
+    ).toBe(404);
+
+    const customers = z
+      .array(z.object({ tenant: z.string() }))
+      .parse(
+        await sql`
+          SELECT tenant_id::text AS tenant FROM parties WHERE phone = ${nirvorOrder.phone}
+          ORDER BY tenant_id`,
+      )
+      .map((row) => row.tenant);
+    expect(customers).toEqual([nirvor.tenantId, acme.tenantId].sort());
+    // Each workspace made its own "Delivery charge" with its first order
+    const services = z.array(z.object({ tenant: z.string(), n: z.number() })).parse(
+      await sql`
+          SELECT tenant_id::text AS tenant, count(*)::int AS n FROM products
+          WHERE name = 'Delivery charge' GROUP BY tenant_id ORDER BY tenant_id`,
+    );
+    expect(services).toEqual(
+      [nirvor.tenantId, acme.tenantId].sort().map((tenant) => ({ tenant, n: 1 })),
+    );
+  });
+
+  it("refuse the other workspace's service as the delivery charge", async () => {
+    const nirvorSetup = storefrontSetupSchema.parse(
+      (await send(nirvorOwner, 'GET', '/storefront/settings')).json(),
+    );
+    const nirvorService = nirvorSetup.shop?.deliveryVariantId ?? null;
+    expect(nirvorService).not.toBeNull();
+    const acmeSetup = storefrontSetupSchema.parse(
+      (await send(acmeOwner, 'GET', '/storefront/settings')).json(),
+    );
+    if (acmeSetup.shop === null) throw new Error('Acme has no shop');
+    // Nor does Acme's select offer it
+    expect(acmeSetup.deliveryChoices.map((choice) => choice.variantId)).not.toContain(
+      nirvorService,
+    );
+    const res = await send(
+      acmeOwner,
+      'PUT',
+      '/storefront/settings',
+      deliveryServiceUpdate(acmeSetup.shop, nirvorService ?? ''),
+    );
+    expect(res.statusCode).toBe(409);
+    expect(problemOf(res).code).toBe('storefront_delivery_product_invalid');
+    const after = storefrontSetupSchema.parse(
+      (await send(acmeOwner, 'GET', '/storefront/settings')).json(),
+    );
+    expect(after.shop?.deliveryVariantId).toBe(acmeSetup.shop.deliveryVariantId);
+  });
+});
+
 describe('the omnivo_shop role', () => {
   // ShopDb.orders is the API's own way in: SET LOCAL ROLE omnivo_shop, Nirvor's workspace. The
   // queries below are ones the order routes never write, as a bug might
```

Four more tests in 27a's file (decision 33), after the shop tests and before the database roles:

- **Acme's owner** gets 404 for Nirvor's order on the page, the pack plan and every move, each sent with the order's
  real version, so nothing but the workspace is wrong. Nirvor's order is unchanged afterwards.
- **Each workspace's list and New count** are exactly its own orders. Nirvor's buyer's phone finds nothing at Acme,
  and Nirvor's number finds only Acme's own `W-000001`.
- **The same buyer orders from both shops.** Nirvor already has a customer with that phone, but Acme's sales order
  gets a new customer of Acme's, which Nirvor's owner cannot open. `lastMailTo()` first notes the buyer's newest SMS
  (Nirvor's confirm), so `codeFor()` waits for the new code instead of reading an old message. Each workspace has
  exactly one "Delivery charge", made by its own first order.
- **Nirvor's delivery service** is not in Acme's select, and Acme cannot save it: `storefront_delivery_product_invalid`,
  and Acme's settings are unchanged.

Row-level security already stops a query that forgot the workspace, so these tests do not prove each `WHERE
tenant_id = …` by itself. They prove what a user of the API sees, which is what a leak is.

### Check this part

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test                                                        # 199 unit tests, unchanged
pnpm exec eslint apps/api/src/storefront/orders apps/api/src/testing
pnpm exec prettier --check apps/api/src/storefront/orders apps/api/src/testing
cd apps/api
npx vitest run src/storefront/orders/storefront-orders.int.spec.ts --maxWorkers=3       # 18 tests
npx vitest run src/storefront/orders/shop-orders.tenant-leak.int.spec.ts --maxWorkers=3 # 12 tests
```

27b.3 changed the sales, customer and product services, so their suites ran again too, with 27a's order tests and
the shop's settings tests: `shop-orders`, `storefront-admin`, `sales-documents`, `invoices`, `returns`, `customers`
and `products` (7 files, 173 tests), all passing.

Broken on purpose, each caught (and put back):

- The maker matching archived customers: the archived one is picked, and its sales order is refused.
- `onPicks()` not moving the challan's error paths: the error is under `lines.1.quantity`, not under the pick.
- Shipped allowed from a new order: the database's documents check refuses a shipped order without a challan, so the
  API answers 500 where the test wants `storefront_order_step_invalid`.
- The handler without `FOR UPDATE` on the order: the job and the page make two sales orders for one order.

## 27b.5 — `packages/i18n`: the screens' words

The Shop orders screens of 27b.6 need their words in English and Bangla, so they come first. 27b.1 already gave the
errors and the audit actions their words; this part adds the sidebar's item, the list, one order's page with its
Packed and Cancel dialogs, the settings' delivery box and the audit log's name for that box.

These words come before the mockup. If the mockup in 27b.6 changes a screen, the words change with it, and the diffs
below show them as they are at the end of the step.

Five decisions came up while writing the words (mine):

34. **"Shop orders" is the first item of the Storefront group.** It is the page the shop's staff open every day; the
    catalog and the settings are set up once. A packer with only `storefront.order.read` sees the group with this one
    item (decision 10).
35. **Delivered asks first, Shipped does not.** Delivered posts an invoice, which only a credit note can take back.
    Shipped is a status with nothing in the books, so one click is enough.
36. **The Bangla says "সেলস অর্ডার", like the sales screens.** 27b.1's audit action and its
    `storefront_order_no_sales_order` error wrote "Sales Order" in English inside the Bangla, while the sidebar, the
    sales order's page and its toasts say সেলস অর্ডার. The order's page links to that page, so both now use one word.
37. **The list's column says "Shopper", not "Customer".** It shows the name the shopper typed at checkout. The ERP
    customer the phone found can have another name (decision 2's oldest match), so the order's page shows both:
    "Deliver to" with what the shopper typed, and "Customer in Omnivo" with the customer.
38. **A tab with no orders says what that tab waits for** ("No order waits to be packed") under one shared title,
    and a search with no match offers "Search every order": the search looks in the open tab only (the contract's
    `view` and `search` go together), so an order in another tab is one click away.

### `locales/en.ts`

```diff
@@ -157,6 +157,8 @@ export const en = {
     // Step 26h: the group's last two items, "Shop" for the same reason (decision 32)
     storefrontAppearance: 'Shop appearance',
     storefrontPages: 'Shop pages',
+    // Step 27b: the shop's orders, first in the group (decision 34)
+    storefrontOrders: 'Shop orders',
   },
   auth: {
     workspace: 'Workspace',
@@ -5360,6 +5362,14 @@ export const en = {
         'Orders of this much or more pay no delivery charge. Empty means never free.',
       minimumOrder: 'Minimum order',
       minimumOrderHint: 'Checkout waits until the cart reaches this. Empty means no minimum.',
+      // Step 27b (decisions 4 and 17): the service the sales order and the invoice bill the
+      // delivery charge as. Empty = the first order with a charge makes "Delivery charge"
+      deliveryProduct: 'Delivery charge’s service',
+      deliveryProductAuto: 'Made by the first order with a charge',
+      deliveryProductHint:
+        'Sales orders and invoices bill the delivery charge as this service. Leave it empty and the first order with a charge makes one called Delivery charge.',
+      // name · sku of an active service (deliveryChoices)
+      deliveryProductOption: '{{name}} · {{sku}}',
       paymentTitle: 'Payment',
       payments: 'Ways to pay',
       paymentsHint: 'Mobile Banking is bKash or Nagad, paid before the parcel leaves.',
```

The sidebar's item (decision 34), and the delivery box in the settings' "Stock and delivery" card (decisions 4 and
17):

- **`deliveryProductAuto`** is the empty choice of the select. Empty is a real state, not "nothing picked yet": the
  first order with a charge makes the "Delivery charge" service and saves it here. So the empty choice says what
  will happen instead of "Pick a service".
- **`deliveryProductOption`** shows a choice as its name and SKU (`deliveryChoices` has both), because a workspace
  may have two services with the same name.
- The hint says where the service shows up (the sales order and the invoice). Nobody has to pick one, so the hint
  also says what happens when the box stays empty.

```diff
@@ -5829,6 +5839,201 @@ export const en = {
       deleted: '{{name}} deleted',
       loadFailed: "Couldn't load the page. Refresh the page to try again.",
     },
+    // Step 27b: the shop's orders (/storefront/orders, decision 10). Reading needs
+    // storefront.order.read, every button storefront.order.manage. Online only: offline the
+    // pages show storefront.needsConnection, like the rest of the menu
+    orders: {
+      title: 'Shop orders',
+      description: 'Orders from your online shop, from the phone code to the shopper’s door',
+      searchLabel: 'Search the orders',
+      searchPlaceholder: 'Order number, name or phone',
+      view: 'Show',
+      // The tabs (STOREFRONT_ORDER_VIEWS). "New" is a confirmed order nobody has packed yet
+      // (decision 13); returned has no tab until step 28, it shows under All
+      views: {
+        confirmed: 'New',
+        packed: 'Packed',
+        shipped: 'Shipped',
+        delivered: 'Delivered',
+        cancelled: 'Cancelled',
+        all: 'All',
+      },
+      // The status pill (STOREFRONT_ORDER_STATUSES), the tab's own word
+      statuses: {
+        confirmed: 'New',
+        packed: 'Packed',
+        shipped: 'Shipped',
+        delivered: 'Delivered',
+        cancelled: 'Cancelled',
+        returned: 'Returned',
+      },
+      // A second, crit pill: the sales order could not be made (decision 16)
+      needsAttention: 'Needs attention',
+      columns: {
+        order: 'Order',
+        confirmed: 'Confirmed',
+        customer: 'Shopper',
+        zone: 'Delivery',
+        payment: 'Payment',
+        total: 'Total',
+        status: 'Status',
+      },
+      // Under the number: count = itemCount, the pieces in the order
+      items_one: '{{formatted}} item',
+      items_other: '{{formatted}} items',
+      emptyTitle: 'No shop orders yet',
+      emptyBody:
+        'An order shows here once the shopper confirms it with the code sent to their phone. Its stock is held for it until it is packed.',
+      // A tab with nothing in it (no search): the title, then the tab's own line
+      viewEmptyTitle: 'Nothing here',
+      viewEmpty: {
+        confirmed: 'No order waits to be packed. New orders show here as shoppers confirm them.',
+        packed: 'No packed order waits to leave the shop.',
+        shipped: 'No order is on its way.',
+        delivered: 'No order is delivered yet.',
+        cancelled: 'No order was cancelled.',
+      },
+      noMatchTitle: 'No order matches',
+      noMatchBody: 'Check the number or the phone. The search looks in this tab only.',
+      searchAll: 'Search every order',
+      loadFailed: "Couldn't load the shop orders. Refresh the page to try again.",
+    },
+    // Step 27b: one order's page (/storefront/orders/$orderId): the next step's button, the
+    // lines, the shopper, the documents and the timeline (decision 10)
+    order: {
+      back: 'Shop orders',
+      // Under the title (the order's number)
+      placedOn: 'Placed {{date}}',
+      notFound:
+        'This order doesn’t exist, or the shopper has not typed the phone code yet. The shop deletes an order that never gets its code.',
+      loadFailed: "Couldn't load the order. Refresh the page to try again.",
+      cantManage:
+        'You can view shop orders. Ask a workspace owner for the storefront.order.manage permission to move them on.',
+      // The next step's button, one per status (decisions 5–8, 28). Cancel is secondary
+      makeSalesOrder: 'Make the sales order',
+      pack: 'Mark packed',
+      ship: 'Mark shipped',
+      deliver: 'Mark delivered',
+      cancel: 'Cancel order',
+      // The toasts. number = the order's (W-000123), the others the documents' own
+      salesOrderMade: 'Sales order {{salesOrder}} made for {{number}}',
+      packed: '{{number}} packed. Challan {{delivery}} posted.',
+      shipped: '{{number}} shipped',
+      delivered: '{{number}} delivered. Invoice {{invoice}} posted.',
+      cancelled: '{{number}} cancelled. The shopper gets an SMS.',
+      // The neutral document notice under the header: what the next step does
+      next: {
+        confirmed:
+          'Pack the goods, then mark it packed. That posts the challan, takes the stock out and ends the hold.',
+        packed: 'Mark it shipped when the parcel leaves the shop.',
+        shipped: 'Mark it delivered when the shopper has it. That posts the invoice.',
+        // Decision 7: the cash on delivery comes in as an ordinary money receipt
+        delivered:
+          'The invoice waits for its money. Record the cash when the rider brings it back.',
+      },
+      recordPayment: 'Record payment',
+      // Decision 1: the crit notice. reason = the error's own words (errors.*), a whole sentence
+      documentError: 'The sales order could not be made. {{reason}}',
+      // Decision 29: an order confirmed before 27b has no sales order and no error
+      noSalesOrder: 'This order has no sales order yet. Make it before the goods are packed.',
+      // The lines card
+      linesTitle: 'Items',
+      // packSize may be empty; the page then shows the SKU alone
+      lineSubline: '{{sku}} · {{packSize}}',
+      // quantity = "2 pcs" (the variant's base unit), price = the shop's unit price
+      lineQuantity: '{{quantity}} × {{price}}',
+      noPhoto: 'No photo',
+      subtotal: 'Subtotal',
+      // code = the coupon (27c); "Discount" alone when there is none
+      discountCode: 'Discount ({{code}})',
+      discount: 'Discount',
+      deliveryCharge: 'Delivery charge',
+      free: 'Free',
+      total: 'Total',
+      // The shopper card: what they typed at checkout, and the customer the phone found or made
+      shopperTitle: 'Deliver to',
+      phone: 'Mobile number',
+      address: 'Address',
+      zone: 'Delivery zone',
+      payment: 'Payment',
+      customer: 'Customer in Omnivo',
+      // Decision 2: until the sales order is made, no customer is picked
+      customerNotYet: 'Found by the phone with the sales order',
+      // The documents card (decision 9: a number links only for someone who may read that kind)
+      documentsTitle: 'Documents',
+      documentsHint: 'What the order made in the books and the stock',
+      documents: {
+        salesOrder: 'Sales order',
+        delivery: 'Challan',
+        invoice: 'Invoice',
+        salesReturn: 'Sales return',
+      },
+      // A document not made yet: when it will be. A sales return is only for a packed order
+      // that is cancelled, so it has no "not yet" line
+      documentsWhen: {
+        salesOrder: 'When the order is confirmed',
+        delivery: 'When it is packed',
+        invoice: 'When it is delivered',
+      },
+      // The timeline card, oldest first (history)
+      timelineTitle: 'Timeline',
+      history: {
+        pending: 'Placed in the shop',
+        confirmed: 'Confirmed with the phone code',
+        packed: 'Packed',
+        shipped: 'Shipped',
+        delivered: 'Delivered',
+        cancelled: 'Cancelled',
+        returned: 'Returned',
+      },
+      // Under the cancelled step: what the member typed (decision 19, staff only)
+      cancelReason: 'Why: {{reason}}',
+      // Decision 35: Delivered posts an invoice, so it asks first. Shipped does not
+      deliverTitle: 'Mark {{number}} delivered?',
+      deliverBody:
+        'This posts an invoice for {{total}}, dated today. It stays unpaid until you record the money.',
+      // The Packed dialog (decisions 5, 14, 15, 32)
+      packing: {
+        title: 'Pack {{number}}',
+        description:
+          'The challan takes these goods out of {{warehouse}}. Check the batches, or type or scan the serial numbers.',
+        // The line's header: quantity = "3 pcs"
+        needs: 'Needs {{quantity}}',
+        // An untracked product: one pick, nothing to choose
+        untracked: 'No batch or serial number to pick.',
+        batch: 'Batch',
+        batchPlaceholder: 'Pick a batch',
+        // available = on hand in the warehouse, with its unit ("12 pcs")
+        batchOption: '{{lot}} · expires {{date}} · {{available}} here',
+        batchOptionNoExpiry: '{{lot}} · {{available}} here',
+        quantity: 'Quantity',
+        addBatch: 'Add another batch',
+        // number = the pick's place in the line, from 1
+        removeBatch: 'Remove batch {{number}}',
+        noBatches: 'No batch of this product has stock in {{warehouse}}.',
+        // picked and quantity with the unit: "2 of 3 pcs"
+        picked: '{{picked}} of {{quantity}} picked',
+        serials: 'Serial numbers',
+        // needed = the line's quantity
+        serialsHint: 'One per line, or scan them. This line needs {{needed}}.',
+        serialsCount: '{{entered}} of {{needed}} typed',
+        submit: 'Mark packed',
+        loadFailed: "Couldn't load what to pack. Close this and try again.",
+      },
+      // The Cancel dialog (decisions 8 and 19)
+      cancelling: {
+        title: 'Cancel {{number}}?',
+        bodyConfirmed:
+          'The stock held for it is free again, and its sales order is cancelled. The shopper gets an SMS that the order was cancelled.',
+        bodyPacked:
+          'A sales return brings the packed goods back into stock, and the sales order is cancelled. The shopper gets an SMS that the order was cancelled.',
+        reason: 'Why',
+        reasonPlaceholder: 'The shopper did not answer the phone',
+        reasonHint: 'Only your team sees this. The SMS does not say why.',
+        keep: 'Keep the order',
+        submit: 'Cancel order',
+      },
+    },
   },
   approvals: {
     title: 'Approvals',
```

Two blocks after the text page's editor, `orders` for the list and `order` for one order's page:

- **`views` and `statuses` are two maps with the same words.** A tab is a filter (it has `all` and no `returned`), a
  status is a pill on a row (it has `returned` and no `all`). Each map has exactly the keys of its contract list
  (`STOREFRONT_ORDER_VIEWS`, `STOREFRONT_ORDER_STATUSES`), so 27b.6 can type them with `satisfies Record<…>` and a
  new status added later fails the type check until it has its word. `confirmed` is "New" in both (decision 13).
- **`needsAttention`** is the second, `crit` pill of decision 16. It names no cause: the cause is on the order's page,
  in the error's own words.
- **`items_one` / `items_other`** take `count` for the plural form and `formatted` for the digits, like the sync
  line's words, so Bangla shows its own digits.
- **`viewEmpty` has no `all` key.** The All tab with nothing in it is the shop with no orders at all, which gets the
  first-time empty state (`emptyTitle`, `emptyBody`) instead (decision 38).
- **The `order` block's buttons say the step, not the document** ("Mark packed", not "Post challan"). A packer thinks
  in parcels; the toast and the `next` notice say which document the step posted.
- **`next`** is the neutral document notice under the page header: what the next button will do. Every status that
  has a next step has one line, and `delivered` points at `recordPayment` (decision 7). Cancelled and returned have
  nothing next, so they have no line.
- **`documentError`** puts the error's own words (`errors.*`, a whole sentence with its full stop) after a fixed first
  sentence. The error words already say what to fix ("This product is archived. Restore it in Products first."), so
  the notice does not repeat it. `noSalesOrder` is decision 29's order, which has no error to show.
- **`documentsWhen`** says when a missing document will be made. A sales return has no line there: only a cancelled
  packed order gets one, so "not yet" would suggest every order will.
- **`history`** has all seven shop statuses, `pending` too: the timeline starts with the moment the shopper placed
  the order (the contract's history starts at `pending`), even though the list never shows a pending order.
- **`deliverTitle` and `deliverBody`** are decision 35's dialog. `total` is the order's total, which is the invoice's
  total because the sales order's prices include VAT (decision 3).
- **`packing`** is the Packed dialog. Its quantities come in already formatted with the unit ("3 pcs", decision 32:
  never the API's raw `3.0000`). `batchOption` shows the lot, the expiry and the stock in that warehouse, the three
  things a packer checks against the box in hand; a batch with no expiry date has its own shorter line instead of an
  empty date. `noBatches` is the line with nothing to pick: Mark packed would fail on stock, so the dialog says so
  first.
- **`cancelling`** has one body per status that can be cancelled, because they do different things: a new order frees
  its hold, a packed one needs a sales return. Both tell the member that the shopper gets an SMS, and `reasonHint`
  says the reason is not in it (decision 19), so nobody types something they would not say to the shopper's face.

```diff
@@ -7038,6 +7243,8 @@ export const en = {
       freeDeliveryFrom: 'Free delivery from',
       minimumOrder: 'Minimum order',
       paymentMethods: 'Ways to pay',
+      // Step 27b
+      deliveryVariantId: 'Delivery charge’s service',
       launched: 'Open',
       position: 'Place in the list',
       packSize: 'Pack size',
```

The settings' audit row (27b.3's `snapshot()`) has the new `deliveryVariantId`; without a word the audit log would
show the raw field name.

### `locales/bn.ts`

```diff
@@ -136,6 +136,8 @@ export const bn: Messages = {
     storefrontSettings: 'শপের সেটিংস',
     storefrontAppearance: 'শপের চেহারা',
     storefrontPages: 'শপের পেজ',
+    // ধাপ ২৭b: শপের অর্ডার, গ্রুপে প্রথমে (সিদ্ধান্ত ৩৪)
+    storefrontOrders: 'শপের অর্ডার',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -4989,6 +4991,12 @@ export const bn: Messages = {
       minimumOrder: 'সর্বনিম্ন অর্ডার',
       minimumOrderHint:
         'কার্ট এই পরিমাণে না পৌঁছানো পর্যন্ত চেকআউট হয় না। ফাঁকা মানে কোনো সীমা নেই।',
+      // ধাপ ২৭b (সিদ্ধান্ত ৪ ও ১৭): ডেলিভারি চার্জ যে সার্ভিস হিসেবে বিল হয়
+      deliveryProduct: 'ডেলিভারি চার্জের সার্ভিস',
+      deliveryProductAuto: 'চার্জসহ প্রথম অর্ডার এটা বানাবে',
+      deliveryProductHint:
+        'সেলস অর্ডার আর ইনভয়েসে ডেলিভারি চার্জ এই সার্ভিস হিসেবে বিল হয়। ফাঁকা রাখলে চার্জসহ প্রথম অর্ডার “ডেলিভারি চার্জ” নামে একটা বানাবে।',
+      deliveryProductOption: '{{name}} · {{sku}}',
       paymentTitle: 'পেমেন্ট',
       payments: 'পেমেন্টের উপায়',
       paymentsHint: 'মোবাইল ব্যাংকিং মানে bKash বা Nagad, পার্সেল রওনা হওয়ার আগে পেমেন্ট।',
@@ -5405,6 +5413,165 @@ export const bn: Messages = {
       deleted: '{{name}} মোছা হয়েছে',
       loadFailed: 'পেজটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     },
+    // ধাপ ২৭b: শপের অর্ডার (/storefront/orders, সিদ্ধান্ত ১০)
+    orders: {
+      title: 'শপের অর্ডার',
+      description: 'অনলাইন শপের অর্ডার, ফোনের কোড থেকে ক্রেতার দরজা পর্যন্ত',
+      searchLabel: 'অর্ডার খুঁজুন',
+      searchPlaceholder: 'অর্ডার নম্বর, নাম বা ফোন',
+      view: 'দেখান',
+      views: {
+        confirmed: 'নতুন',
+        packed: 'প্যাক হয়েছে',
+        shipped: 'পাঠানো হয়েছে',
+        delivered: 'পৌঁছেছে',
+        cancelled: 'বাতিল',
+        all: 'সব',
+      },
+      statuses: {
+        confirmed: 'নতুন',
+        packed: 'প্যাক হয়েছে',
+        shipped: 'পাঠানো হয়েছে',
+        delivered: 'পৌঁছেছে',
+        cancelled: 'বাতিল',
+        returned: 'ফেরত এসেছে',
+      },
+      needsAttention: 'নজর দিন',
+      columns: {
+        order: 'অর্ডার',
+        confirmed: 'কনফার্ম হয়েছে',
+        customer: 'ক্রেতা',
+        zone: 'ডেলিভারি',
+        payment: 'পেমেন্ট',
+        total: 'মোট',
+        status: 'অবস্থা',
+      },
+      items_one: '{{formatted}}টা পণ্য',
+      items_other: '{{formatted}}টা পণ্য',
+      emptyTitle: 'শপে এখনো কোনো অর্ডার নেই',
+      emptyBody:
+        'ক্রেতা ফোনে পাঠানো কোড দিয়ে কনফার্ম করলে অর্ডার এখানে আসে। প্যাক না হওয়া পর্যন্ত এর স্টক আটকে রাখা থাকে।',
+      viewEmptyTitle: 'এখানে কিছু নেই',
+      viewEmpty: {
+        confirmed:
+          'প্যাকের অপেক্ষায় কোনো অর্ডার নেই। ক্রেতারা কনফার্ম করলে নতুন অর্ডার এখানে আসে।',
+        packed: 'শপ ছাড়ার অপেক্ষায় কোনো প্যাক করা অর্ডার নেই।',
+        shipped: 'পথে কোনো অর্ডার নেই।',
+        delivered: 'এখনো কোনো অর্ডার পৌঁছায়নি।',
+        cancelled: 'কোনো অর্ডার বাতিল হয়নি।',
+      },
+      noMatchTitle: 'কোনো অর্ডার মেলেনি',
+      noMatchBody: 'নম্বর বা ফোন মিলিয়ে দেখুন। খোঁজা হয় শুধু এই ট্যাবে।',
+      searchAll: 'সব অর্ডারে খুঁজুন',
+      loadFailed: 'শপের অর্ডার আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    // ধাপ ২৭b: একটা অর্ডারের পেজ (/storefront/orders/$orderId)
+    order: {
+      back: 'শপের অর্ডার',
+      placedOn: '{{date}} অর্ডার দেওয়া হয়েছে',
+      notFound:
+        'এই অর্ডার নেই, অথবা ক্রেতা এখনো ফোনের কোড দেননি। কোড না পেলে শপ অর্ডারটা মুছে দেয়।',
+      loadFailed: 'অর্ডারটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+      cantManage:
+        'আপনি শপের অর্ডার দেখতে পারেন। এগিয়ে নিতে workspace owner-এর কাছে storefront.order.manage permission চান।',
+      makeSalesOrder: 'সেলস অর্ডার বানান',
+      pack: 'প্যাক হয়েছে বলে চিহ্ন দিন',
+      ship: 'পাঠানো হয়েছে বলে চিহ্ন দিন',
+      deliver: 'পৌঁছেছে বলে চিহ্ন দিন',
+      cancel: 'অর্ডার বাতিল করুন',
+      salesOrderMade: '{{number}}-এর সেলস অর্ডার {{salesOrder}} বানানো হয়েছে',
+      packed: '{{number}} প্যাক হয়েছে। চালান {{delivery}} পোস্ট হয়েছে।',
+      shipped: '{{number}} পাঠানো হয়েছে',
+      delivered: '{{number}} পৌঁছেছে। ইনভয়েস {{invoice}} পোস্ট হয়েছে।',
+      cancelled: '{{number}} বাতিল হয়েছে। ক্রেতা একটা SMS পাবেন।',
+      next: {
+        confirmed:
+          'মাল প্যাক করে প্যাক হয়েছে বলে চিহ্ন দিন। তাতে চালান পোস্ট হয়, স্টক বের হয়, আর আটকে রাখা স্টক ছাড়া পায়।',
+        packed: 'পার্সেল শপ ছাড়লে পাঠানো হয়েছে বলে চিহ্ন দিন।',
+        shipped: 'ক্রেতা হাতে পেলে পৌঁছেছে বলে চিহ্ন দিন। তাতে ইনভয়েস পোস্ট হয়।',
+        delivered: 'ইনভয়েসটা টাকার অপেক্ষায়। রাইডার টাকা নিয়ে ফিরলে সেটা লিখে রাখুন।',
+      },
+      recordPayment: 'টাকা জমা লিখুন',
+      documentError: 'সেলস অর্ডার বানানো যায়নি। {{reason}}',
+      noSalesOrder: 'এই অর্ডারের এখনো সেলস অর্ডার নেই। মাল প্যাকের আগে বানান।',
+      linesTitle: 'পণ্য',
+      lineSubline: '{{sku}} · {{packSize}}',
+      lineQuantity: '{{quantity}} × {{price}}',
+      noPhoto: 'ছবি নেই',
+      subtotal: 'সাবটোটাল',
+      discountCode: 'ছাড় ({{code}})',
+      discount: 'ছাড়',
+      deliveryCharge: 'ডেলিভারি চার্জ',
+      free: 'ফ্রি',
+      total: 'মোট',
+      shopperTitle: 'যেখানে পাঠাতে হবে',
+      phone: 'মোবাইল নম্বর',
+      address: 'ঠিকানা',
+      zone: 'ডেলিভারির এলাকা',
+      payment: 'পেমেন্ট',
+      customer: 'Omnivo-তে গ্রাহক',
+      customerNotYet: 'সেলস অর্ডারের সাথে ফোন দিয়ে খোঁজা হবে',
+      documentsTitle: 'ডকুমেন্ট',
+      documentsHint: 'অর্ডারটা খাতায় আর স্টকে যা বানিয়েছে',
+      documents: {
+        salesOrder: 'সেলস অর্ডার',
+        delivery: 'চালান',
+        invoice: 'ইনভয়েস',
+        salesReturn: 'সেলস রিটার্ন',
+      },
+      documentsWhen: {
+        salesOrder: 'অর্ডার কনফার্ম হলে',
+        delivery: 'প্যাক হলে',
+        invoice: 'পৌঁছালে',
+      },
+      timelineTitle: 'টাইমলাইন',
+      history: {
+        pending: 'শপে অর্ডার দেওয়া হয়েছে',
+        confirmed: 'ফোনের কোডে কনফার্ম হয়েছে',
+        packed: 'প্যাক হয়েছে',
+        shipped: 'পাঠানো হয়েছে',
+        delivered: 'পৌঁছেছে',
+        cancelled: 'বাতিল হয়েছে',
+        returned: 'ফেরত এসেছে',
+      },
+      cancelReason: 'কারণ: {{reason}}',
+      deliverTitle: '{{number}} পৌঁছেছে বলে চিহ্ন দেবেন?',
+      deliverBody:
+        'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে। টাকা জমা না লেখা পর্যন্ত এটা বাকি থাকে।',
+      packing: {
+        title: '{{number}} প্যাক করুন',
+        description:
+          'চালান এই মাল {{warehouse}} থেকে বের করবে। ব্যাচগুলো মিলিয়ে নিন, অথবা সিরিয়াল নম্বর লিখুন বা স্ক্যান করুন।',
+        needs: 'লাগবে {{quantity}}',
+        untracked: 'বাছার মতো কোনো ব্যাচ বা সিরিয়াল নম্বর নেই।',
+        batch: 'ব্যাচ',
+        batchPlaceholder: 'একটা ব্যাচ বাছুন',
+        batchOption: '{{lot}} · মেয়াদ {{date}} · এখানে {{available}}',
+        batchOptionNoExpiry: '{{lot}} · এখানে {{available}}',
+        quantity: 'পরিমাণ',
+        addBatch: 'আরেকটা ব্যাচ যোগ করুন',
+        removeBatch: 'ব্যাচ {{number}} সরান',
+        noBatches: '{{warehouse}}-এ এই পণ্যের কোনো ব্যাচে স্টক নেই।',
+        picked: '{{quantity}}-এর {{picked}} বাছা হয়েছে',
+        serials: 'সিরিয়াল নম্বর',
+        serialsHint: 'প্রতি লাইনে একটা, বা স্ক্যান করুন। এই লাইনে লাগবে {{needed}}টা।',
+        serialsCount: '{{needed}}টার {{entered}}টা লেখা হয়েছে',
+        submit: 'প্যাক হয়েছে বলে চিহ্ন দিন',
+        loadFailed: 'কী প্যাক করতে হবে তা আনা যায়নি। এটা বন্ধ করে আবার চেষ্টা করুন।',
+      },
+      cancelling: {
+        title: '{{number}} বাতিল করবেন?',
+        bodyConfirmed:
+          'এর জন্য আটকে রাখা স্টক আবার ছাড়া পাবে, আর এর সেলস অর্ডার বাতিল হবে। ক্রেতা অর্ডার বাতিলের একটা SMS পাবেন।',
+        bodyPacked:
+          'একটা সেলস রিটার্ন প্যাক করা মাল স্টকে ফেরত আনবে, আর সেলস অর্ডার বাতিল হবে। ক্রেতা অর্ডার বাতিলের একটা SMS পাবেন।',
+        reason: 'কারণ',
+        reasonPlaceholder: 'ক্রেতা ফোন ধরেননি',
+        reasonHint: 'শুধু আপনার টিম এটা দেখে। SMS-এ কারণ বলা হয় না।',
+        keep: 'অর্ডার রাখুন',
+        submit: 'অর্ডার বাতিল করুন',
+      },
+    },
   },
   approvals: {
     title: 'অনুমোদন',
@@ -6365,7 +6532,7 @@ export const bn: Messages = {
         deleted: 'শপের লিস্টিং মুছেছেন',
       },
       storefront_order: {
-        sales_order_made: 'শপের অর্ডারের Sales Order বানিয়েছেন',
+        sales_order_made: 'শপের অর্ডারের সেলস অর্ডার বানিয়েছেন',
         packed: 'শপের অর্ডার প্যাক হয়েছে বলে চিহ্ন দিয়েছেন',
         shipped: 'শপের অর্ডার পাঠানো হয়েছে বলে চিহ্ন দিয়েছেন',
         delivered: 'শপের অর্ডার পৌঁছেছে বলে চিহ্ন দিয়েছেন',
@@ -6560,6 +6727,8 @@ export const bn: Messages = {
       freeDeliveryFrom: 'ফ্রি ডেলিভারি যত থেকে',
       minimumOrder: 'সর্বনিম্ন অর্ডার',
       paymentMethods: 'পেমেন্টের উপায়',
+      // ধাপ ২৭b
+      deliveryVariantId: 'ডেলিভারি চার্জের সার্ভিস',
       launched: 'খোলা',
       position: 'তালিকায় জায়গা',
       packSize: 'প্যাকের সাইজ',
@@ -7463,7 +7632,7 @@ export const bn: Messages = {
     storefront_page_empty: 'অন্তত একটা অংশ লিখুন। শপ থেকে পেজটা সরাতে চাইলে মুছে দিন।',
     storefront_order_step_invalid:
       'আপনি খোলার পরে অর্ডারটা এগিয়ে গেছে। এখন কোথায় আছে দেখতে পেজটা আবার লোড করুন।',
-    storefront_order_no_sales_order: 'এই অর্ডারের এখনো Sales Order নেই। আগে Sales Order বানান।',
+    storefront_order_no_sales_order: 'এই অর্ডারের এখনো সেলস অর্ডার নেই। আগে সেলস অর্ডার বানান।',
     storefront_order_line_missing: 'অর্ডারের প্রতিটা লাইন প্যাক করুন, শুধু এই অর্ডারের লাইন।',
     storefront_order_line_twice: 'এই লাইন তালিকায় দুইবার আছে। একটা সরান।',
     storefront_order_pick_total:
```

The same keys in Bangla; the type check fails if one is missing. Two hunks change 27b.1's lines (decision 36). The
step buttons say "প্যাক হয়েছে বলে চিহ্ন দিন": a bare "প্যাক হয়েছে" on a button reads as a status, not as an action.
The audit actions of 27b.1 use the same words ("প্যাক হয়েছে বলে চিহ্ন দিয়েছেন"), so the button and the
audit log say one thing.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
```

The i18n tests include the check that every Bangla string keeps the English one's `{{placeholders}}`, so a Bangla
line that dropped `{{number}}` fails here, not on the screen. The words are not used by any screen yet: 27b.6 uses
them, and 27b.8 looks for words no screen uses and takes them out.

## 27b.6 — The Shop orders screens

This part builds what a person in the shop sees: "Shop orders" first in the Storefront group with the count of new
orders, the list with its tabs, one order's page with the next step's button, the Packed dialog, the Cancel and
Delivered dialogs, and the delivery charge's service box in Shop settings. The new-order bell now opens its order.
Everything follows the mockup you approved (17 screens, option 1: the error notice uses the error's own words).

The mocks (MSW) and the browser tests come in 27b.7. This part only changes the mock shop enough for the app to type
check (the settings' two new fields).

Decisions made while building the screens (mine):

39. **Every document number on the order's page is a link.** Decision 30 left the choice to the page, by the
    reader's permissions, but the sales documents have no read permission: every member reads sales orders,
    challans, invoices and returns. So a packer with only `storefront.order.*` can open the challan they posted.
40. **The Packed dialog shows a quantity without its zeros at the end, never rounded.** The pack plan sends the
    unit's code but not its decimals (decision 32). Reading the units list for the decimals would be one more
    request, and dropping only the zeros at the end (`3.0000` → `3`, `2.5000` → `2.5`) shows the same number.
41. **The tab is in the address (`?view=packed`), the search is not.** Back from an order lands on the tab it was
    opened from. The default tab (New) has no `?view=`, so the sidebar's link and the New tab are one address. A
    search is a quick look, like the catalog's.
42. **The Packed dialog is its own chunk, with its own small state instead of react-hook-form.** Its form is a list
    of lines, each a list of picks, and the API's error paths (`lines.0.picks.1.quantity`) are exactly the dialog's
    own paths, so a plain map of path → error code is enough. Most visits to an order never open it.
43. **`DocumentNotice` gets a `crit` tone and an optional action.** A sales order that could not be made blocks the
    next step: it is an error, not a warning. "Record payment" sits at the end of the delivered order's notice, as
    in the mockup.
44. **The router writes the six tabs out instead of importing `STOREFRONT_ORDER_VIEWS`.** Importing the list pulled
    the contracts' `storefront-orders` module, with every schema it imports, into the first chunk: 12 KB, over the
    budget. A `satisfies` check keeps the written list exactly the contract's.
45. **The lazy chunk budget is 155 KB (your choice).** The nine new routes grew the contracts' route table, which
    every page loads, and the listing editor went from 149.8 to 150.8 KB without changing. The order pages are
    95–109 KB.
46. **One notice under the header, in this order:** the failed sales order (crit), else "no sales order yet" (an
    order confirmed under 27a), else what the next button does. A member who may only read sees why there are no
    buttons, but only while there would be some to press.
47. **The order pills have a file of their own**, not `storefront-parts.tsx`: every Storefront page loads that file,
    and the listing editor is near its budget.
48. **"View shop" on the list only for `storefront.manage`.** The shop's address comes from the settings, which a
    packer may not read; asking anyway would be a refused request on every visit. The list has no "Changes show in
    the shop within a minute" line: an order is not something the shop shows.

### The queries and the Packed form's helpers

```ts
import {
  compareQuantity,
  isQuantity,
  type PackStorefrontOrderFormValues,
  routes,
  type StorefrontOrder,
  type StorefrontOrderSort,
  type StorefrontOrderView,
  type StorefrontPackPlan,
  sumQuantity,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 27b: the Shop orders pages' reads and the Packed dialog's form. Its own file, not
// lib/storefront.ts: a packer with only storefront.order.read opens these two pages and nothing
// else of the menu, so their chunk does not carry the catalog's and the appearance's code. Every
// key starts with ['storefront', tenantId, 'orders'], so the menu's refresh reaches them too, and
// one invalidate of that prefix after a move refreshes the list, the order and the sidebar's count.

// ---------------------------------------------------------------------------------------------
// Reads

export interface OrderFilter {
  view: StorefrontOrderView;
  search: string;
  sort: StorefrontOrderSort;
}

export function storefrontOrdersQuery(tenantId: string, filter: OrderFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefrontOrders.listOrders, {
        query: {
          limit: 50,
          view: filter.view,
          sort: filter.sort,
          ...(filter.search !== '' && { search: filter.search }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // Another tab keeps the old rows until its first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

export function storefrontOrderQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'one', orderId],
    queryFn: () => call(routes.storefrontOrders.getOrder, { params: { id: orderId } }),
  });
}

// What the Packed dialog opens with. Asked each time the dialog opens (staleTime 0, gcTime 0): the
// batches' stock changes with every sale, and a plan from an hour ago would suggest a batch that
// is empty now
export function storefrontPackPlanQuery(tenantId: string, orderId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'orders', 'pack-plan', orderId],
    queryFn: () => call(routes.storefrontOrders.getPackPlan, { params: { id: orderId } }),
    staleTime: 0,
    gcTime: 0,
  });
}

// ---------------------------------------------------------------------------------------------
// One order

// The step a member can take next, by status (decisions 5–8, 28). A confirmed order with no sales
// order cannot be packed: the challan is written from the sales order, so the page offers to make
// it first (decisions 1 and 29)
export type OrderStep = 'makeSalesOrder' | 'pack' | 'ship' | 'deliver';

export function nextStep(order: StorefrontOrder): OrderStep | null {
  switch (order.status) {
    case 'confirmed':
      return order.salesOrder === null ? 'makeSalesOrder' : 'pack';
    case 'packed':
      return 'ship';
    case 'shipped':
      return 'deliver';
    default:
      return null;
  }
}

// Decision 8: a new or packed order can be cancelled. A shipped one is with the courier, and its
// coming back is step 28's "returned"
export function canCancel(order: StorefrontOrder): boolean {
  return order.status === 'confirmed' || order.status === 'packed';
}

// ---------------------------------------------------------------------------------------------
// The Packed dialog's form

// What the dialog edits for one line. Not the contract's input: a serial line is one box of serial
// numbers (SerialNumbersInput keeps the list), and a batch line's picks keep the box's text as typed
// until the send
export interface PackLineValues {
  position: number;
  picks: { batchId: string; quantity: string }[];
  serials: string[];
}

// The API writes stock quantities with four decimals ("3.0000") and the order's own quantities as
// whole numbers ("2"), decision 32. A box shows what a person would type: only the zeros at the
// end go, never a digit that counts
export function plainQuantity(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

// How many decimals a quantity has once its zeros at the end are gone ("2.50" → 1), so the dialog
// formats it with the user's digits without rounding it
export function decimalsOf(value: string): number {
  return plainQuantity(value).split('.')[1]?.length ?? 0;
}

// The dialog's start: the API's suggestion (FEFO for a batch line, one pick for an untracked one),
// and an empty box for a serial line. A batch line with no suggestion (no batch has stock) starts
// with one empty pick, so the packer sees the select and the noBatches line together
export function packFormValues(plan: StorefrontPackPlan): PackLineValues[] {
  return plan.lines.map((line) => {
    if (line.tracking === 'serial') {
      return { position: line.position, picks: [], serials: [] };
    }
    const picks = line.picks.map((pick) => ({
      batchId: pick.batchId ?? '',
      quantity: plainQuantity(pick.quantity),
    }));
    return {
      position: line.position,
      picks: picks.length > 0 ? picks : [{ batchId: '', quantity: plainQuantity(line.quantity) }],
      serials: [],
    };
  });
}

// What "Mark packed" sends. A serial line is one pick of the whole quantity with the serial
// numbers typed; the challan checks that their count matches. A box that is not a quantity is
// sent as it is: the contract's schema refuses it on that box, with the same path as the API's
export function toPackInput(
  plan: StorefrontPackPlan,
  lines: readonly PackLineValues[],
  version: number,
): PackStorefrontOrderFormValues {
  return {
    version,
    lines: lines.map((values, index) => {
      const planned = plan.lines[index];
      if (planned?.tracking === 'serial') {
        return {
          position: values.position,
          picks: [
            {
              batchId: '',
              quantity: plainQuantity(planned.quantity),
              serialNumbers: [...values.serials],
            },
          ],
        };
      }
      return {
        position: values.position,
        picks: values.picks.map((pick) => ({
          batchId: pick.batchId,
          quantity: pick.quantity.trim(),
          serialNumbers: [],
        })),
      };
    }),
  };
}

// The line's count under its picks: what was picked so far, and whether it is exactly the line.
// A box that is not a quantity yet counts as nothing, so the count never shows NaN while typing
export function pickedOf(
  values: PackLineValues,
  quantity: string,
): { picked: string; complete: boolean } {
  const picked = sumQuantity(
    values.picks.map((pick) => pick.quantity.trim()).filter((value) => isQuantity(value)),
  );
  // sumQuantity writes four decimals; the count shows what a person would write
  return { picked: plainQuantity(picked), complete: compareQuantity(picked, quantity) === 0 };
}
```

- **A file of its own, not `lib/storefront.ts`.** A packer opens only these two pages, so their chunk does not carry
  the catalog's and the appearance's code.
- **Every key starts with `['storefront', tenantId, 'orders']`.** The menu's own refresh (`useStorefrontRefresh`)
  reaches them, and one invalidate after a move refreshes the list, the open order and the sidebar's count together.
- **`placeholderData: keepPreviousData`** on the list: a click on another tab keeps the old rows until the new first
  page arrives, so the table does not flash empty.
- **The pack plan has `staleTime: 0` and `gcTime: 0`.** Batches change with every sale. A plan kept from an hour ago
  would suggest a batch that is empty now, and the packer would only find out from the error.
- **`nextStep()`** is the one place that knows which button an order gets. A confirmed order with no sales order
  gets "Make the sales order", because the challan is written from the sales order (decisions 1 and 29). Cancelled,
  delivered and returned orders get none.
- **`canCancel()`** is decision 8: new or packed only. A shipped parcel is with the courier.
- **`PackLineValues` is not the contract's input.** A serial line is a list of serial numbers (the shared serial box
  keeps a list), and a batch line keeps each box's text exactly as typed until the send, so `1.` while typing `1.5`
  is not rewritten under the cursor.
- **`plainQuantity()`** is decision 40. It only removes zeros after the decimal point, so it can never round.
- **`packFormValues()`** starts from the API's suggestion. A batch line with no suggestion (no batch has stock) still
  gets one empty pick, so the packer sees the select and the "no batch has stock" line together. A serial line starts
  empty: only the packer knows which pieces are in the box (decision 14).
- **`toPackInput()`** turns a serial line into one pick of the whole quantity with the serial numbers. Their count
  is checked by the challan's own rules. A mistyped box is sent as it is, because the contract's schema refuses it
  with the same path the API would use, so the error lands under that box.
- **`pickedOf()`** ignores a box that is not a quantity yet, so the "2 of 3 pcs picked" line never shows NaN while a
  person types.

```ts
import {
  packStorefrontOrderInputSchema,
  type StorefrontOrder,
  type StorefrontPackPlan,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  canCancel,
  decimalsOf,
  nextStep,
  packFormValues,
  pickedOf,
  plainQuantity,
  toPackInput,
} from './storefront-orders';

const BATCH_A = '0193a1b2-0000-7000-8000-00000000000a';
const BATCH_B = '0193a1b2-0000-7000-8000-00000000000b';
const REF = { id: '0193a1b2-0000-7000-8000-0000000000f1', number: 'SO-2026-27-0412' };

// Only what nextStep and canCancel read; the rest of an order does not change their answer
function order(
  status: StorefrontOrder['status'],
  salesOrder: StorefrontOrder['salesOrder'] = REF,
): StorefrontOrder {
  return { status, salesOrder } as StorefrontOrder;
}

// Three lines as 27b.4 found them (decision 32): a batch line with the API's FEFO picks in stock
// quantities, an untracked line with its one pick, a serial line with none
const plan: StorefrontPackPlan = {
  warehouse: { id: '0193a1b2-0000-7000-8000-0000000000e1', name: 'Mirpur store' },
  lines: [
    {
      position: 1,
      name: 'Himalaya Purifying Neem Face Wash',
      packSize: '150ml',
      sku: 'HIM-NFW-150',
      unitCode: 'pcs',
      quantity: '3',
      tracking: 'batch',
      batches: [
        { batchId: BATCH_A, lotNumber: 'NFW-2408', expiresOn: '2027-04-30', available: '2.0000' },
        { batchId: BATCH_B, lotNumber: 'NFW-2411', expiresOn: '2027-10-31', available: '36.0000' },
      ],
      picks: [
        { batchId: BATCH_A, quantity: '2.0000', serialNumbers: [] },
        { batchId: BATCH_B, quantity: '1.0000', serialNumbers: [] },
      ],
    },
    {
      position: 2,
      name: 'SIS Low GI Sugar',
      packSize: '350gm',
      sku: 'SIS-LGI-350',
      unitCode: 'pcs',
      quantity: '1',
      tracking: 'none',
      batches: [],
      picks: [{ batchId: null, quantity: '1', serialNumbers: [] }],
    },
    {
      position: 3,
      name: 'Omron HEM-7120',
      packSize: '',
      sku: 'OMR-7120',
      unitCode: 'pcs',
      quantity: '1',
      tracking: 'serial',
      batches: [],
      picks: [],
    },
  ],
};

describe('the next step', () => {
  it('follows the parcel: pack, ship, deliver, then nothing', () => {
    expect(nextStep(order('confirmed'))).toBe('pack');
    expect(nextStep(order('packed'))).toBe('ship');
    expect(nextStep(order('shipped'))).toBe('deliver');
    expect(nextStep(order('delivered'))).toBeNull();
    expect(nextStep(order('cancelled'))).toBeNull();
    expect(nextStep(order('returned'))).toBeNull();
  });

  it('makes the sales order first when a new order has none (decisions 1 and 29)', () => {
    expect(nextStep(order('confirmed', null))).toBe('makeSalesOrder');
  });

  it('cancels only before the parcel leaves (decision 8)', () => {
    expect(canCancel(order('confirmed'))).toBe(true);
    expect(canCancel(order('packed'))).toBe(true);
    expect(canCancel(order('shipped'))).toBe(false);
    expect(canCancel(order('delivered'))).toBe(false);
  });
});

describe('quantities as a person types them', () => {
  it('drops only the zeros at the end', () => {
    expect(plainQuantity('3.0000')).toBe('3');
    expect(plainQuantity('2.5000')).toBe('2.5');
    expect(plainQuantity('10')).toBe('10');
    expect(plainQuantity('100.0500')).toBe('100.05');
  });

  it('counts the decimals left, so formatting never rounds', () => {
    expect(decimalsOf('3.0000')).toBe(0);
    expect(decimalsOf('2.7400')).toBe(2);
    expect(decimalsOf('12')).toBe(0);
  });
});

describe('the Packed form', () => {
  it("starts from the API's suggestion, written as a person would type it", () => {
    expect(packFormValues(plan)).toEqual([
      {
        position: 1,
        picks: [
          { batchId: BATCH_A, quantity: '2' },
          { batchId: BATCH_B, quantity: '1' },
        ],
        serials: [],
      },
      { position: 2, picks: [{ batchId: '', quantity: '1' }], serials: [] },
      { position: 3, picks: [], serials: [] },
    ]);
  });

  it('gives a batch line with no suggestion one empty batch of the whole quantity', () => {
    const [first] = plan.lines;
    if (first === undefined) throw new Error('no line');
    const empty = { ...plan, lines: [{ ...first, batches: [], picks: [] }] };
    expect(packFormValues(empty)).toEqual([
      { position: 1, picks: [{ batchId: '', quantity: '3' }], serials: [] },
    ]);
  });

  it('sends every line once, a serial line as one pick of the whole quantity', () => {
    const values = packFormValues(plan);
    const serial = values[2];
    if (serial === undefined) throw new Error('no line');
    serial.serials = ['OMR7120-23K0418'];
    const input = toPackInput(plan, values, 4);
    expect(input).toEqual({
      version: 4,
      lines: [
        {
          position: 1,
          picks: [
            { batchId: BATCH_A, quantity: '2', serialNumbers: [] },
            { batchId: BATCH_B, quantity: '1', serialNumbers: [] },
          ],
        },
        { position: 2, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
        {
          position: 3,
          picks: [{ batchId: '', quantity: '1', serialNumbers: ['OMR7120-23K0418'] }],
        },
      ],
    });
    // What the dialog sends is what the contract takes
    expect(packStorefrontOrderInputSchema.safeParse(input).success).toBe(true);
  });

  it("leaves a mistyped box for the contract to refuse, on that box's path", () => {
    const values = packFormValues(plan);
    const first = values[0]?.picks[1];
    if (first === undefined) throw new Error('no pick');
    first.quantity = '1,5';
    const parsed = packStorefrontOrderInputSchema.safeParse(toPackInput(plan, values, 1));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['lines', 0, 'picks', 1, 'quantity']);
  });

  it('counts what is picked, ignoring a box that is not a quantity yet', () => {
    const [values] = packFormValues(plan);
    if (values === undefined) throw new Error('no line');
    expect(pickedOf(values, '3')).toEqual({ picked: '3', complete: true });
    expect(
      pickedOf(
        {
          ...values,
          picks: [
            { batchId: BATCH_A, quantity: '2' },
            { batchId: '', quantity: '' },
          ],
        },
        '3',
      ),
    ).toEqual({ picked: '2', complete: false });
  });
});
```

The helpers have no React, so they are tested without a browser. The plan in the test is the one 27b.4 saw from the
real API: a batch line with stock quantities (`2.0000`), an untracked line, a serial line. The test that sends a
serial line also checks that the result passes `packStorefrontOrderInputSchema`, so the dialog and the contract
cannot drift apart.

### The sidebar's count

```diff
@@ -1772,3 +1772,16 @@ export function waitingCountQuery(tenantId: string) {
     staleTime: 0,
   });
 }
+
+// Step 27b (decision 18): the new shop orders, for the sidebar's count next to "Shop orders".
+// Polled like the approvals count; under ['storefront', tenantId, 'orders'], so a move on the
+// order's page refreshes it at once. Here, not in lib/storefront-orders.ts: the sidebar is in the
+// first chunk, the orders' pages are not
+export function storefrontOrderCountQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['storefront', tenantId, 'orders', 'counts'],
+    queryFn: async () => (await call(routes.storefrontOrders.countOrders)).confirmed,
+    refetchInterval: 30_000,
+    staleTime: 0,
+  });
+}
```

The count lives in `queries.ts`, not in the orders' file: the sidebar is in the first chunk and the orders' pages are
not. It polls every 30 seconds, like the approvals count, and its key is under the orders' prefix, so packing an order
lowers the number at once.

```diff
@@ -110,7 +110,7 @@ import { type InstallWay, promptInstall, useInstallWay } from '../lib/install';
 import { savePreference } from '../lib/preferences';
 import { logout, switchTenant } from '../lib/session';
 import { useCan } from '../lib/permissions';
-import { waitingCountQuery } from '../lib/queries';
+import { storefrontOrderCountQuery, waitingCountQuery } from '../lib/queries';
 import { useSession } from '../lib/session-store';
 import { useSyncAge, useSyncSummary } from '../lib/sync-summary';
 import { isTheme } from '../lib/theme';
@@ -364,6 +364,13 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
   const canInventoryReports = can('inventory.report.read');
   // Step 17a: how many documents wait for this person's decision, polled like the bell's badge
   const { data: waiting = 0 } = useQuery(waitingCountQuery(me?.tenant.id ?? ''));
+  // Step 27b: the shop orders nobody has packed yet. Only for someone who may read them: anyone
+  // else would be refused every 30 seconds
+  const canShopOrders = can('storefront.order.read');
+  const { data: newOrders = 0 } = useQuery({
+    ...storefrontOrderCountQuery(me?.tenant.id ?? ''),
+    enabled: canShopOrders,
+  });
   // Step 18b: sign out at once with nothing on the device, else ask. Step 20b (decision 6): an
   // open POS shift comes first: it is closed before anything else.
   const { waiting: unsynced, openShift } = useSyncSummary();
@@ -666,25 +673,43 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
           </NavGroup>
           {/* Step 26g (decision 5): the online shop, for the people who run it. After Stock, the
               group the shop sells from */}
-          {can('storefront.manage') && (
+          {/* Step 27b (decision 10): the group shows for the people who run the shop and for the
+              packers, who may only read and move its orders. They see Shop orders alone */}
+          {(can('storefront.manage') || canShopOrders) && (
             <NavGroup label={t('nav.storefront')}>
-              <NavLink to="/storefront/listings" icon={Store04Icon}>
-                {t('nav.storefrontCatalog')}
-              </NavLink>
-              <NavLink to="/storefront/categories" icon={FolderLibraryIcon}>
-                {t('nav.storefrontCategories')}
-              </NavLink>
-              {/* Step 26h: the look and the text pages, before the settings (approved with the
-                  mockup: the things changed most often come first) */}
-              <NavLink to="/storefront/appearance" icon={PaintBoardIcon}>
-                {t('nav.storefrontAppearance')}
-              </NavLink>
-              <NavLink to="/storefront/pages" icon={Files01Icon}>
-                {t('nav.storefrontPages')}
-              </NavLink>
-              <NavLink to="/storefront/settings" icon={WebDesign01Icon}>
-                {t('nav.storefrontSettings')}
-              </NavLink>
+              {/* Decision 34: first, the page the shop's staff open every day. The count is the
+                  orders that wait to be packed, crit like the approvals count: work to do */}
+              {canShopOrders && (
+                <NavLink
+                  to="/storefront/orders"
+                  icon={ShoppingBag01Icon}
+                  count={newOrders > 0 ? newOrders : undefined}
+                  countTone="crit"
+                >
+                  {t('nav.storefrontOrders')}
+                </NavLink>
+              )}
+              {can('storefront.manage') && (
+                <>
+                  <NavLink to="/storefront/listings" icon={Store04Icon}>
+                    {t('nav.storefrontCatalog')}
+                  </NavLink>
+                  <NavLink to="/storefront/categories" icon={FolderLibraryIcon}>
+                    {t('nav.storefrontCategories')}
+                  </NavLink>
+                  {/* Step 26h: the look and the text pages, before the settings (approved with
+                      the mockup: the things changed most often come first) */}
+                  <NavLink to="/storefront/appearance" icon={PaintBoardIcon}>
+                    {t('nav.storefrontAppearance')}
+                  </NavLink>
+                  <NavLink to="/storefront/pages" icon={Files01Icon}>
+                    {t('nav.storefrontPages')}
+                  </NavLink>
+                  <NavLink to="/storefront/settings" icon={WebDesign01Icon}>
+                    {t('nav.storefrontSettings')}
+                  </NavLink>
+                </>
+              )}
             </NavGroup>
           )}
           <NavGroup label={t('nav.workspace')}>
```

- **The query runs only with `storefront.order.read`.** Anyone else would get a 403 every 30 seconds.
- **The group shows for either permission** (decision 10). The five old items keep their `storefront.manage` check
  inside the group, so a packer sees "Shop orders" alone.
- **The count is `crit`** like the approvals count: it is work waiting. The icon is the mockup's `ShoppingBag01`.

### The routes

```diff
@@ -6,7 +6,7 @@ import {
   Outlet,
   redirect,
 } from '@tanstack/react-router';
-import { INVITE_PATH } from '@omnivo/contracts';
+import { INVITE_PATH, type StorefrontOrderView } from '@omnivo/contracts';
 
 import { restoreSession } from './lib/session';
 import { sessionStore } from './lib/session-store';
@@ -1027,6 +1027,37 @@ const auditLogRoute = createRoute({
   component: lazyRouteComponent(() => import('./routes/audit-log'), 'AuditLogPage'),
 });
 
+// Step 27b: the shop's orders (decision 10), behind storefront.order.read. The tab is a search
+// param, so Back from an order lands on its tab; anything that is not a tab is the default (New).
+// The tabs are written out here, not imported: STOREFRONT_ORDER_VIEWS lives in the contracts'
+// storefront-orders module, whose schemas (and the modules they import) would then ride in the
+// first chunk, 12 KB of it. `satisfies Record<…>` keeps the list exactly the contract's: a tab added
+// or removed there fails the type check here
+const ORDER_VIEWS: readonly StorefrontOrderView[] = Object.values({
+  confirmed: 'confirmed',
+  packed: 'packed',
+  shipped: 'shipped',
+  delivered: 'delivered',
+  cancelled: 'cancelled',
+  all: 'all',
+} as const satisfies { [View in StorefrontOrderView]: View });
+
+const storefrontOrdersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/orders',
+  validateSearch: (search: Record<string, unknown>): { view?: StorefrontOrderView } => {
+    const view = ORDER_VIEWS.find((candidate) => candidate === search.view);
+    return view === undefined || view === 'confirmed' ? {} : { view };
+  },
+  component: lazyRouteComponent(() => import('./routes/storefront-orders'), 'StorefrontOrdersPage'),
+});
+
+const storefrontOrderRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/orders/$orderId',
+  component: lazyRouteComponent(() => import('./routes/storefront-order'), 'StorefrontOrderPage'),
+});
+
 // Step 26g: the Storefront menu (decision 5), behind storefront.manage: the sidebar hides it, and
 // the API refuses the reads for anyone else. '/storefront/listings' is the catalog; a listing's
 // editor sits under it
@@ -1257,6 +1288,8 @@ const routeTree = rootRoute.addChildren([
     rolesRoute,
     approvalRulesRoute,
     auditLogRoute,
+    storefrontOrdersRoute,
+    storefrontOrderRoute,
     storefrontListingsRoute,
     storefrontListingRoute,
     storefrontCategoriesRoute,
```

- **`validateSearch`** turns anything that is not a tab into the default: an old link or a typo opens New instead of
  an error. `confirmed` itself is dropped from the address (decision 41).
- **The tabs are written out** (decision 44). `{ [View in StorefrontOrderView]: View }` is a mapped type: every view
  must be a key, and each key's value must be its own name, so a tab added to the contract, or a typo here, fails the
  type check. `Object.values()` of it is then the list.

### The pills

```tsx
import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryTruck01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageReceiveIcon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { StorefrontOrderStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';

// Step 27b: a shop order's pills, for the list and the order's page. A file of their own, not
// storefront-parts.tsx: the other Storefront pages load that file, and the listing editor sits at
// its chunk budget.

// The status pill (approved with the mockup). Work in progress is brand, not warn (CLAUDE.md →
// Sales document statuses): New waits for the packer, which is the shop's normal day. Returned is
// step 28's, here so a returned order in the All tab already has its pill
const ORDER_PILLS = {
  confirmed: { tone: 'brand', icon: Clock01Icon },
  packed: { tone: 'brand', icon: PackageIcon },
  shipped: { tone: 'brand', icon: DeliveryTruck01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
  returned: { tone: 'neutral', icon: PackageReceiveIcon },
} as const satisfies Record<
  StorefrontOrderStatus,
  { tone: 'brand' | 'good' | 'neutral'; icon: IconSvgElement }
>;

export function OrderStatusPill({ status }: { status: StorefrontOrderStatus }) {
  const { t } = useLocale();
  const pill = ORDER_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.orders.statuses.${status}`)}
    </Pill>
  );
}

// Decision 16: the sales order could not be made. crit: nothing moves on until someone acts
export function NeedsAttentionPill() {
  const { t } = useLocale();
  return (
    <Pill tone="crit" icon={Alert02Icon}>
      {t('storefront.orders.needsAttention')}
    </Pill>
  );
}
```

`satisfies Record<StorefrontOrderStatus, …>` makes a status added later fail the type check until it has a pill. The
tones follow CLAUDE.md's rule for documents: work in progress is `brand`, a finished sale is `good`, an order that
ended is neutral. "Needs attention" is the only `crit` one.

### The document notice

```diff
@@ -1,5 +1,6 @@
-import { HourglassIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
+import { Alert02Icon, HourglassIcon, InformationCircleIcon } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
+import { cn } from '@omnivo/ui';
 import type { ReactNode } from 'react';
 
 // A notice above a document: what its state means and what to do next. Icon plus words, never
@@ -8,31 +9,43 @@ import type { ReactNode } from 'react';
 // too, and importing it from there would pull the quotation page into their chunks. Step 17a: a
 // notice may bring its own icon (a requisition sent back is not an hourglass). Step 18c: moved here
 // from sales-parts.tsx, which reaches the route map through stock-parts.tsx: the sign-in page must
-// not load every module's schemas to show one notice.
+// not load every module's schemas to show one notice. Step 27b: crit, for a shop order whose sales
+// order could not be made (it blocks the next step, so it is an error, not a warning), and an
+// action at the end of the line (a "Record payment" link), which wraps under the words on a phone.
+const TONES = {
+  warn: 'border-warn/30 bg-warn-bg text-warn',
+  crit: 'border-crit/30 bg-crit-bg text-crit',
+  neutral: 'border-line bg-subtle text-ink-2',
+} as const;
+
+const ICONS = { warn: HourglassIcon, crit: Alert02Icon, neutral: InformationCircleIcon } as const;
+
 export function DocumentNotice({
   tone,
   icon,
+  action,
   children,
 }: {
-  tone: 'warn' | 'neutral';
+  tone: keyof typeof TONES;
   icon?: IconSvgElement;
+  action?: ReactNode;
   children: ReactNode;
 }) {
   return (
     <p
-      className={
-        tone === 'warn'
-          ? 'flex items-start gap-2 rounded-control border border-warn/30 bg-warn-bg px-3 py-2.5 text-body-sm text-warn'
-          : 'flex items-start gap-2 rounded-control border border-line bg-subtle px-3 py-2.5 text-body-sm text-ink-2'
-      }
+      className={cn(
+        'flex flex-wrap items-start gap-x-2 gap-y-1 rounded-control border px-3 py-2.5 text-body-sm',
+        TONES[tone],
+      )}
     >
       <HugeiconsIcon
-        icon={icon ?? (tone === 'warn' ? HourglassIcon : InformationCircleIcon)}
+        icon={icon ?? ICONS[tone]}
         size={17}
         strokeWidth={1.5}
         className="mt-px shrink-0"
       />
-      <span>{children}</span>
+      <span className="min-w-0 flex-1 basis-60">{children}</span>
+      {action}
     </p>
   );
 }
```

- **The tones are a map**, so a fourth one is one line, and `keyof typeof TONES` is the prop's type: a tone without
  its classes cannot be passed.
- **`cn()`** joins the classes, as CLAUDE.md asks, instead of a template string.
- **The text grows (`flex-1`) and the row wraps**, so an action sits at the right end on a wide screen and drops under
  the words on a phone. Every old notice has no action and looks as before.

### The list

```tsx
import { Search01Icon, ShoppingBag01Icon } from '@hugeicons/core-free-icons';
import {
  STOREFRONT_ORDER_VIEWS,
  type StorefrontOrderSort,
  type StorefrontOrderSummary,
  type StorefrontOrderView,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  Input,
  PageHeader,
  SegmentedControl,
  type SortingState,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';

import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
import { StorefrontOffline, useShopMoney, ViewShopLink } from '../components/storefront-parts';
import { useCan } from '../lib/permissions';
import { storefrontSetupQuery } from '../lib/storefront';
import { type OrderFilter, storefrontOrdersQuery } from '../lib/storefront-orders';
import { useDebounced } from '../lib/use-debounced';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 27b: the shop's orders (decision 10), a page at a time by tab, searched and sorted on the
// server like the catalog. The tab is in the address (?view=packed), so the browser's Back from an
// order returns to the tab it was opened from. A row opens the order's page.

const column = dataTableColumns<StorefrontOrderSummary>();

// Confirmed and Total sort both ways; the newest confirmed first is the contract's default
const DEFAULT_SORT: SortingState = [{ id: 'confirmedAt', desc: true }];

function sortOf(state: SortingState): StorefrontOrderSort {
  const first = state[0];
  if (first?.id === 'total') return first.desc ? '-total' : 'total';
  return first?.desc === false ? 'confirmed' : '-confirmed';
}

export function StorefrontOrdersPage() {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const navigate = useNavigate();
  const money = useShopMoney();
  const can = useCan();
  const { view = 'confirmed' } = useSearch({ strict: false });
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim(), 300);
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORT);

  // "View shop" needs the shop's address, which only storefront.manage may read: a packer with
  // storefront.order.read alone has no button, and no refused request either
  const setup = useQuery({
    ...storefrontSetupQuery(tenantId),
    enabled: online && can('storefront.manage'),
  });
  const shop = setup.data?.shop ?? null;
  const filter: OrderFilter = { view, search: settled, sort: sortOf(sorting) };
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontOrdersQuery(tenantId, filter),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setView = useCallback(
    (next: StorefrontOrderView) => {
      // The default tab has no ?view=, so the sidebar's link and this tab are one address
      void navigate({
        to: '/storefront/orders',
        search: next === 'confirmed' ? {} : { view: next },
        replace: true,
      });
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('orderNo', {
          header: t('storefront.orders.columns.order'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ row }) => (
            <span className="grid">
              {/* Order numbers are Geist Mono, as on the shop's own pages */}
              <span className="font-mono font-medium whitespace-nowrap text-ink">
                {row.original.orderNo}
              </span>
              <span className="text-caption text-ink-3">
                {t('storefront.orders.items', {
                  count: row.original.itemCount,
                  formatted: format.number(row.original.itemCount),
                })}
              </span>
            </span>
          ),
        }),
        column.accessor('confirmedAt', {
          header: t('storefront.orders.columns.confirmed'),
          meta: { card: 'detail' },
          // The time too: a shop takes many orders a day, and the packer works oldest first
          cell: ({ getValue }) => (
            <span className="whitespace-nowrap text-ink-2 tabular-nums">
              {format.dateTime(new Date(getValue()), timeZone)}
            </span>
          ),
        }),
        column.accessor('customerName', {
          header: t('storefront.orders.columns.customer'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            <span className="grid min-w-0">
              <span className="truncate font-medium text-ink">{row.original.customerName}</span>
              <span className="text-caption text-ink-3 tabular-nums">{row.original.phone}</span>
            </span>
          ),
        }),
        column.accessor('zoneName', {
          header: t('storefront.orders.columns.zone'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <span className="text-ink-2">{getValue()}</span>,
        }),
        column.accessor('paymentMethod', {
          header: t('storefront.orders.columns.payment'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => (
            <span className="text-ink-2">{t(`storefront.payments.${getValue()}`)}</span>
          ),
        }),
        column.accessor('total', {
          header: t('storefront.orders.columns.total'),
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('storefront.orders.columns.status'),
          enableSorting: false,
          meta: { card: 'trailing' },
          cell: ({ row }) => (
            <span className="inline-flex flex-wrap justify-end gap-1.5 min-[860px]:justify-start">
              <OrderStatusPill status={row.original.status} />
              {row.original.needsAttention && <NeedsAttentionPill />}
            </span>
          ),
        }),
      ]),
    [t, format, money, timeZone],
  );

  const viewOptions = STOREFRONT_ORDER_VIEWS.map((value) => ({
    value,
    label: t(`storefront.orders.views.${value}`),
  }));

  // Decision 38: why the table is empty, in the order that explains it best. A search that found
  // nothing; the All tab with nothing in it, which is a shop with no orders at all; another tab
  // with nothing waiting
  const empty =
    settled !== '' ? (
      <EmptyState
        icon={Search01Icon}
        title={t('storefront.orders.noMatchTitle')}
        description={t('storefront.orders.noMatchBody')}
        action={
          view !== 'all' && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setView('all');
              }}
            >
              {t('storefront.orders.searchAll')}
            </Button>
          )
        }
      />
    ) : view === 'all' ? (
      <EmptyState
        icon={ShoppingBag01Icon}
        title={t('storefront.orders.emptyTitle')}
        description={t('storefront.orders.emptyBody')}
      />
    ) : (
      <EmptyState
        icon={ShoppingBag01Icon}
        title={t('storefront.orders.viewEmptyTitle')}
        description={t(`storefront.orders.viewEmpty.${view}`)}
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.orders.title')}
        description={t('storefront.orders.description')}
        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
      />
      {!online && <StorefrontOffline />}
      {online && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
              <Input
                type="search"
                icon={Search01Icon}
                aria-label={t('storefront.orders.searchLabel')}
                placeholder={t('storefront.orders.searchPlaceholder')}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </div>
            <SegmentedControl
              label={t('storefront.orders.view')}
              value={view}
              options={viewOptions}
              onChange={setView}
            />
          </div>
          {isError && (
            <p role="alert" className="text-body-sm text-crit">
              {t('storefront.orders.loadFailed')}
            </p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.orders.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              sorting={{ state: sorting, onChange: setSorting }}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/orders/$orderId',
                  params: { orderId: row.id },
                })
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
    </div>
  );
}
```

- **`sortOf()`** maps the table's sort to the contract's four sorts. Confirmed starts newest first (the contract's
  default), so the table's first state says the same.
- **The Confirmed column shows the time too.** A shop takes many orders a day; the day alone would not tell two
  apart.
- **The status cell can hold two pills** (the status and "Needs attention", decision 16). On a phone's card it is
  right-aligned with the total.
- **The empty state says why the table is empty** (decision 38): a search with no match, with "Search every order"
  that moves to All and keeps the search (not on All itself, where it would do nothing); All with nothing in it,
  which is a shop with no orders yet; or another tab with nothing waiting, with that tab's own line.
- **Offline, the page is the Storefront's "Needs a connection" state.** Nothing is asked from the server then.

### One order's page

```tsx
import {
  Agreement01Icon,
  AlertCircleIcon,
  ArrowLeft01Icon,
  CancelCircleIcon,
  DeliveryTruck01Icon,
  Image01Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PackageReceiveIcon,
  ShoppingCart01Icon,
  SmartPhone01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  cancelStorefrontOrderInputSchema,
  contractErrorMap,
  type DocumentRef,
  isZeroMoney,
  routes,
  type ShopOrderStatus,
  type StorefrontOrder,
  type StorefrontOrderLine,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  FormAlert,
  TextAreaField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';

import { CancelDraftDialog } from '../components/cancel-draft-dialog';
import { DocumentNotice } from '../components/document-notice';
import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
import { StorefrontOffline, useShopMoney } from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { useCan } from '../lib/permissions';
import {
  canCancel,
  nextStep,
  type OrderStep,
  storefrontOrderQuery,
} from '../lib/storefront-orders';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 27b: one shop order (decision 10). The next step's button and Cancel in the header, a
// notice that says what the button does, the lines and the timeline on the left, the shopper and
// the documents the order made in a 340px column. On a phone the cards stack in the order a packer
// reads them: lines, address, documents, timeline. Online only, like the whole menu.

// The Packed dialog has a form with nested lists; most visits to an order never open it, so it is
// its own chunk, loaded when "Mark packed" is pressed
const PackDialog = lazy(() =>
  import('../components/storefront-pack-dialog').then((module) => ({
    default: module.PackDialog,
  })),
);

// The timeline's icon per status, the same pictures as the status pills, plus the shop's own two
// steps: the cart for the moment it was placed, the phone for the code
const STEP_ICONS = {
  pending: ShoppingCart01Icon,
  confirmed: SmartPhone01Icon,
  packed: PackageIcon,
  shipped: DeliveryTruck01Icon,
  delivered: PackageDeliveredIcon,
  cancelled: CancelCircleIcon,
  returned: PackageReceiveIcon,
} as const satisfies Record<ShopOrderStatus, IconSvgElement>;

const STEP_BUTTONS = {
  makeSalesOrder: Agreement01Icon,
  pack: PackageIcon,
  ship: DeliveryTruck01Icon,
  deliver: PackageDeliveredIcon,
} as const satisfies Record<OrderStep, IconSvgElement>;

type Dialogs = 'pack' | 'deliver' | 'cancel' | null;

// After a move: the order's own answer at once, then every read the move changed. The orders (the
// list, the sidebar's count), and the sales, stock, books and customers, because Packed posts a
// challan and Delivered an invoice. The same keys useSalesRefresh() refreshes, without importing
// the sales pages' shared file into this chunk
function useApplyMove(): (saved: StorefrontOrder) => Promise<void> {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return useCallback(
    async (saved: StorefrontOrder) => {
      queryClient.setQueryData(storefrontOrderQuery(tenantId, saved.id).queryKey, saved);
      await Promise.all(
        ['storefront', 'sales', 'stock', 'journal', 'customers'].map((area) =>
          queryClient.invalidateQueries({ queryKey: [area, tenantId] }),
        ),
      );
    },
    [queryClient, tenantId],
  );
}
```

- **`PackDialog` is `lazy()`** (decision 42), loaded when "Mark packed" is pressed.
- **`STEP_ICONS` covers all seven shop statuses**, `pending` too: the timeline starts with the moment the shopper
  placed the order. `satisfies` makes a new status fail here until it has an icon.
- **`useApplyMove()`** puts the move's answer into the order's cache at once, then refreshes every area the move
  touched: the storefront (list and count), sales (the challan, the invoice), stock, the books and the customers
  (what they owe). These are the keys `useSalesRefresh()` refreshes, written here so the page does not import the
  sales pages' shared file and its imports.

```tsx
function BackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/storefront/orders"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('storefront.order.back')}
    </Link>
  );
}

function Thumb({ line }: { line: StorefrontOrderLine }) {
  const { t } = useLocale();
  return line.image === null ? (
    <span
      title={t('storefront.order.noPhoto')}
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3"
    >
      <HugeiconsIcon icon={Image01Icon} size={16} strokeWidth={1.5} />
    </span>
  ) : (
    <img
      src={line.image.url}
      alt=""
      className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
    />
  );
}

function LinesCard({ order }: { order: StorefrontOrder }) {
  const { t, format } = useLocale();
  const money = useShopMoney();
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t('storefront.order.linesTitle')} />
      <ul className="mt-3">
        {order.lines.map((line) => (
          <li
            key={line.position}
            // Phone: the photo and the name on one row, the quantity and the amount under the
            // name. From sm the four share a row, the amounts lined up at the right
            className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-line px-5 py-3 sm:grid-cols-[40px_minmax(0,1fr)_auto_96px] sm:gap-x-5"
          >
            <Thumb line={line} />
            <span className="col-span-2 grid min-w-0 sm:col-span-1">
              <span className="text-body-sm font-medium text-ink">{line.name}</span>
              <span className="truncate text-caption text-ink-3">
                <span className="font-mono">{line.sku}</span>
                {line.packSize !== '' && ` · ${line.packSize}`}
              </span>
            </span>
            <span className="col-start-2 text-body-sm text-ink-2 tabular-nums sm:col-start-3 sm:row-start-1 sm:text-right">
              {t('storefront.order.lineQuantity', {
                quantity: `${format.number(line.quantity)} ${line.unitCode}`,
                price: money(line.unitPrice),
              })}
            </span>
            <span className="text-right text-body-sm font-medium tabular-nums sm:col-start-4 sm:row-start-1">
              {money(line.lineTotal)}
            </span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-2 border-t border-line bg-subtle px-5 py-4 text-body-sm tabular-nums">
        <div className="flex justify-between gap-4 text-ink-2">
          <dt>{t('storefront.order.subtotal')}</dt>
          <dd>{money(order.subtotal)}</dd>
        </div>
        {/* A coupon (27c) only; without one there is no discount line at all */}
        {!isZeroMoney(order.discount) && (
          <div className="flex justify-between gap-4 text-ink-2">
            <dt>
              {order.couponCode === null
                ? t('storefront.order.discount')
                : t('storefront.order.discountCode', { code: order.couponCode })}
            </dt>
            <dd>−{money(order.discount)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 text-ink-2">
          <dt>{t('storefront.order.deliveryCharge')}</dt>
          {/* Zero is the shop's free delivery (its threshold), so it says so, as the shop did */}
          <dd>
            {isZeroMoney(order.deliveryCharge)
              ? t('storefront.order.free')
              : money(order.deliveryCharge)}
          </dd>
        </div>
        <div className="mt-1 flex justify-between gap-4 border-t border-line pt-3 font-medium text-ink">
          <dt>{t('storefront.order.total')}</dt>
          <dd>{money(order.total)}</dd>
        </div>
      </dl>
    </Card>
  );
}
```

- **A line's grid has two shapes.** On a phone the photo and the name share the first row, and the quantity and the
  amount go under the name; from `sm` all four share one row with the amounts lined up on the right (the mockup's
  phone and desktop screens).
- **The quantity says the unit** ("2 pcs × ৳229"), from the line's `unitCode`.
- **The discount row shows only when there is one.** Coupons come in 27c; until then it never shows.
- **A zero delivery charge says "Free"**: zero means the order reached the shop's free delivery threshold, and the
  shopper saw "Free" at checkout too.

```tsx
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption font-medium text-ink-3">{label}</dt>
      <dd className="text-body-sm text-ink">{children}</dd>
    </div>
  );
}

// Decision 37: what the shopper typed, then the ERP customer the phone found or made
function ShopperCard({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  return (
    <Card>
      <CardHeader title={t('storefront.order.shopperTitle')} />
      <dl className="grid gap-4 px-5 pt-4 pb-5">
        <Fact label={t('storefront.orders.columns.customer')}>{order.customerName}</Fact>
        <Fact label={t('storefront.order.phone')}>
          <span className="tabular-nums">{order.phone}</span>
        </Fact>
        <Fact label={t('storefront.order.address')}>
          <span className="whitespace-pre-line">{order.address}</span>
        </Fact>
        <div className="grid grid-cols-2 gap-4">
          <Fact label={t('storefront.order.zone')}>{order.zoneName}</Fact>
          <Fact label={t('storefront.order.payment')}>
            {t(`storefront.payments.${order.paymentMethod}`)}
          </Fact>
        </div>
        <Fact label={t('storefront.order.customer')}>
          {order.customer === null ? (
            <span className="text-ink-3">{t('storefront.order.customerNotYet')}</span>
          ) : (
            <Link
              to="/customers/$customerId"
              params={{ customerId: order.customer.id }}
              className="font-medium text-brand underline-offset-3 hover:underline"
            >
              {order.customer.name}
            </Link>
          )}
        </Fact>
      </dl>
    </Card>
  );
}
```

The shopper card shows what the shopper typed, then the ERP customer the phone found or made (decision 37). Until the
sales order is made there is no customer yet, and the card says when there will be one. The address keeps its line
breaks (`whitespace-pre-line`), as the shopper typed it.

```tsx
const DOC_NUMBER =
  'font-mono text-body-sm font-medium text-brand tabular-nums underline-offset-3 hover:underline';

// The number as a link to its document. Every member reads the sales documents (there is no
// read permission for them), so every number links (decision 39). A document always has its number
// here: the order's documents are posted when they are made, never drafts
function DocumentLink({ kind, document }: { kind: DocumentKind; document: DocumentRef }) {
  const number = document.number ?? '—';
  switch (kind) {
    case 'salesOrder':
      return (
        <Link to="/sales-orders/$orderId" params={{ orderId: document.id }} className={DOC_NUMBER}>
          {number}
        </Link>
      );
    case 'delivery':
      return (
        <Link
          to="/deliveries/$deliveryId"
          params={{ deliveryId: document.id }}
          className={DOC_NUMBER}
        >
          {number}
        </Link>
      );
    case 'invoice':
      return (
        <Link to="/invoices/$invoiceId" params={{ invoiceId: document.id }} className={DOC_NUMBER}>
          {number}
        </Link>
      );
    case 'salesReturn':
      return (
        <Link
          to="/sales-returns/$returnId"
          params={{ returnId: document.id }}
          className={DOC_NUMBER}
        >
          {number}
        </Link>
      );
  }
}

const DOCUMENT_KINDS = ['salesOrder', 'delivery', 'invoice', 'salesReturn'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];

// A row is a document made, or one still to come. A sales return never "comes": only a cancelled
// packed order gets one, so it has no "not yet" row (and no documentsWhen word)
type DocumentRow =
  | { kind: DocumentKind; document: DocumentRef }
  | { kind: Exclude<DocumentKind, 'salesReturn'>; document: null };

function DocumentsCard({ order }: { order: StorefrontOrder }) {
  const { t } = useLocale();
  // A cancelled order shows only what it made: "When it is packed" would promise a step that never
  // comes. The sales return has no "not yet" line at all (it is only for a cancelled packed order)
  const ended = order.status === 'cancelled' || order.status === 'returned';
  const rows = DOCUMENT_KINDS.flatMap((kind): DocumentRow[] => {
    const document = order[kind];
    if (document !== null) return [{ kind, document }];
    if (ended || kind === 'salesReturn') return [];
    return [{ kind, document: null }];
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t('storefront.order.documentsTitle')}
        subtitle={t('storefront.order.documentsHint')}
      />
      <ul className="mt-3">
        {rows.map((row) => (
          <li
            key={row.kind}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-5 py-3"
          >
            <span className="text-body-sm text-ink-2">
              {t(`storefront.order.documents.${row.kind}`)}
            </span>
            {row.document === null ? (
              <span className="text-caption text-ink-3">
                {t(`storefront.order.documentsWhen.${row.kind}`)}
              </span>
            ) : (
              <DocumentLink kind={row.kind} document={row.document} />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

- **`DocumentLink`** has one `<Link>` per kind, because each route has its own parameter name, and TanStack checks
  each pair. Every number links (decision 39).
- **`DocumentRow`** is a union: a document made, or one still to come. The "still to come" side cannot be a sales
  return, so `documentsWhen.${kind}` only ever asks for a word that exists.
- **A cancelled order shows only what it made.** "When it is packed" on a cancelled order would promise a step that
  never comes.

```tsx
function TimelineCard({ order }: { order: StorefrontOrder }) {
  const { t, format } = useLocale();
  const timeZone = useTimeZone();
  const last = order.history.length - 1;
  return (
    <Card>
      <CardHeader title={t('storefront.order.timelineTitle')} />
      <ol className="grid px-5 pt-4 pb-5">
        {order.history.map((step, index) => (
          <li
            key={`${step.status}-${step.at}`}
            className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0"
          >
            {/* The line down to the next step, behind the dots; none after the last one */}
            {index < last && (
              <span
                aria-hidden="true"
                className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line"
              />
            )}
            {/* The step the order is at is brand; the earlier ones are done and step back */}
            <span
              aria-hidden="true"
              className={cn(
                'grid size-6 place-items-center rounded-full',
                index === last ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
              )}
            >
              <HugeiconsIcon icon={STEP_ICONS[step.status]} size={14} strokeWidth={1.5} />
            </span>
            <span className="grid min-w-0">
              <span className="text-body-sm font-medium text-ink">
                {t(`storefront.order.history.${step.status}`)}
              </span>
              <span className="text-caption text-ink-3 tabular-nums">
                {format.dateTime(new Date(step.at), timeZone)}
              </span>
              {/* Decision 19: the staff's reason, under the step it explains */}
              {step.status === 'cancelled' && order.cancelReason !== null && (
                <span className="mt-1 text-body-sm text-ink-2">
                  {t('storefront.order.cancelReason', { reason: order.cancelReason })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
```

The timeline draws a line from each dot to the next (none after the last), and the last step, where the order is now,
is `brand`. The cancel reason sits under the Cancelled step it explains (decision 19).

```tsx
// Decision 8: a reason for the staff, then Cancel. The body says what happens to the stock, which
// differs for a new and a packed order
function CancelDialog({
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
    resolver: zodResolver(cancelStorefrontOrderInputSchema, { error: contractErrorMap }),
    defaultValues: { version: order.version, reason: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontOrders.cancelOrder, {
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
      title={t('storefront.order.cancelling.title', { number: order.orderNo })}
      description={
        order.status === 'packed'
          ? t('storefront.order.cancelling.bodyPacked')
          : t('storefront.order.cancelling.bodyConfirmed')
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('storefront.order.cancelling.keep')}</Button>
          </DialogClose>
          <Button type="submit" form="cancel-shop-order" disabled={isSubmitting}>
            {t('storefront.order.cancelling.submit')}
          </Button>
        </>
      }
    >
      <form
        id="cancel-shop-order"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid gap-5"
      >
        {errors.root?.server?.message !== undefined && (
          <FormAlert message={errors.root.server.message} />
        )}
        <TextAreaField
          label={t('storefront.order.cancelling.reason')}
          optional
          placeholder={t('storefront.order.cancelling.reasonPlaceholder')}
          hint={t('storefront.order.cancelling.reasonHint')}
          maxLength={200}
          {...register('reason')}
          error={errors.reason?.message}
        />
      </form>
    </DialogContent>
  );
}
```

The Cancel dialog is a small react-hook-form form with the contract's own schema, so the 200-character limit and the
API's errors land under the box. Its description is the one that matches the order: a new order frees its hold, a
packed one needs a sales return.

```tsx
function OrderView({ order }: { order: StorefrontOrder }) {
  const { t, errorText, format } = useLocale();
  const timeZone = useTimeZone();
  const money = useShopMoney();
  const can = useCan();
  const canManage = can('storefront.order.manage');
  const applyMove = useApplyMove();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const step = nextStep(order);
  const cancellable = canCancel(order);

  // The two moves with no dialog of their own (Make the sales order, Shipped), and Delivered's
  // confirm. Their refusals (version_conflict, storefront_order_step_invalid, a sales error on the
  // retry) belong to no box, so they show above the cards, or in the Delivered dialog
  const move = useMutation({
    mutationFn: (kind: 'makeSalesOrder' | 'ship' | 'deliver') => {
      const body = { version: order.version };
      const params = { id: order.id };
      switch (kind) {
        case 'makeSalesOrder':
          return call(routes.storefrontOrders.makeSalesOrder, { params, body });
        case 'ship':
          return call(routes.storefrontOrders.shipOrder, { params, body });
        case 'deliver':
          return call(routes.storefrontOrders.deliverOrder, { params, body });
      }
    },
    onSuccess: async (saved, kind) => {
      await applyMove(saved);
      setDialog(null);
      toast(
        kind === 'makeSalesOrder'
          ? t('storefront.order.salesOrderMade', {
              number: saved.orderNo,
              salesOrder: saved.salesOrder?.number ?? '',
            })
          : kind === 'ship'
            ? t('storefront.order.shipped', { number: saved.orderNo })
            : t('storefront.order.delivered', {
                number: saved.orderNo,
                invoice: saved.invoice?.number ?? '',
              }),
      );
    },
  });
  const moveError =
    move.error instanceof ApiRequestError ? move.error.code : move.error ? 'unknown_error' : null;

  const afterDialog = async (saved: StorefrontOrder, message: string) => {
    await applyMove(saved);
    setDialog(null);
    toast(message);
  };

  const press = (next: OrderStep) => {
    move.reset();
    if (next === 'pack' || next === 'deliver') setDialog(next);
    else move.mutate(next);
  };

  // The notice under the header (decision 1, 29 and the `next` lines). A failed sales order comes
  // first: nothing else can happen before it is made
  const notices = [];
  if (order.documentError !== null) {
    notices.push(
      <DocumentNotice key="error" tone="crit">
        {t('storefront.order.documentError', { reason: errorText(order.documentError) })}
      </DocumentNotice>,
    );
  } else if (step === 'makeSalesOrder') {
    notices.push(
      <DocumentNotice key="no-so" tone="neutral">
        {t('storefront.order.noSalesOrder')}
      </DocumentNotice>,
    );
  } else if (canManage && order.status !== 'cancelled' && order.status !== 'returned') {
    // Decision 7: a delivered order's money comes in as an ordinary receipt for its invoice, for
    // someone who may write one
    const receipt = order.status === 'delivered' &&
      order.invoice !== null &&
      order.customer !== null &&
      can('sales.receipt.manage') && (
        <Link
          to="/receipts/new"
          search={{ customerId: order.customer.id, invoiceId: order.invoice.id }}
          className="font-medium text-brand underline-offset-3 hover:underline"
        >
          {t('storefront.order.recordPayment')}
        </Link>
      );
    notices.push(
      <DocumentNotice key="next" tone="neutral" action={receipt}>
        {t(`storefront.order.next.${order.status}`)}
      </DocumentNotice>,
    );
  }
  // A reader sees why there are no buttons, while there would be some to press
  if (!canManage && (step !== null || cancellable)) {
    notices.push(
      <DocumentNotice key="read-only" tone="neutral">
        {t('storefront.order.cantManage')}
      </DocumentNotice>,
    );
  }

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <BackLink />
      {/* The PageHeader's look, with the pills beside the number (approved with the mockup) */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-h1">{order.orderNo}</h1>
            <span className="flex flex-wrap gap-1.5">
              <OrderStatusPill status={order.status} />
              {order.documentError !== null && <NeedsAttentionPill />}
            </span>
          </div>
          <p className="mt-1 text-label text-ink-3 tabular-nums">
            {t('storefront.order.placedOn', {
              date: format.dateTime(new Date(order.placedAt), timeZone),
            })}
          </p>
        </div>
        {canManage && (step !== null || cancellable) && (
          // Phone: the two buttons share the row (approved with the mockup)
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            {cancellable && (
              <Button
                variant="secondary"
                className={cn(step === null && 'col-span-2')}
                onClick={() => {
                  move.reset();
                  setDialog('cancel');
                }}
              >
                <HugeiconsIcon icon={CancelCircleIcon} size={17} strokeWidth={1.5} />
                {t('storefront.order.cancel')}
              </Button>
            )}
            {step !== null && (
              <Button
                className={cn(!cancellable && 'col-span-2')}
                disabled={move.isPending}
                onClick={() => {
                  press(step);
                }}
              >
                <HugeiconsIcon icon={STEP_BUTTONS[step]} size={17} strokeWidth={1.5} />
                {t(`storefront.order.${step}`)}
              </Button>
            )}
          </div>
        )}
      </header>
      {moveError !== null && dialog === null && <FormAlert message={moveError} />}
      {notices.length > 0 && <div className="grid gap-2.5">{notices}</div>}
      {/* Two columns from xl. Below it the wrappers are `contents`, so the four cards are one
          stack, and `order` puts the address and the documents before the timeline */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="contents xl:grid xl:gap-5">
          <div className="order-1">
            <LinesCard order={order} />
          </div>
          <div className="order-4">
            <TimelineCard order={order} />
          </div>
        </div>
        <div className="contents xl:grid xl:gap-5">
          <div className="order-2">
            <ShopperCard order={order} />
          </div>
          <div className="order-3">
            <DocumentsCard order={order} />
          </div>
        </div>
      </div>

      {dialog === 'deliver' && (
        // Decision 35: Delivered posts an invoice, so it asks first. The dialog of a cancelled
        // draft, with this step's words
        <CancelDraftDialog
          title={t('storefront.order.deliverTitle', { number: order.orderNo })}
          body={t('storefront.order.deliverBody', { total: money(order.total) })}
          keep={t('common.cancel')}
          confirm={t('storefront.order.deliver')}
          pending={move.isPending}
          error={moveError ?? undefined}
          onConfirm={() => {
            move.mutate('deliver');
          }}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
      <Dialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === 'cancel' && (
          <CancelDialog
            order={order}
            onDone={(saved) =>
              afterDialog(saved, t('storefront.order.cancelled', { number: saved.orderNo }))
            }
          />
        )}
      </Dialog>
      <Dialog
        open={dialog === 'pack'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        {dialog === 'pack' && (
          <Suspense fallback={null}>
            <PackDialog
              order={order}
              onDone={(saved) =>
                afterDialog(
                  saved,
                  t('storefront.order.packed', {
                    number: saved.orderNo,
                    delivery: saved.delivery?.number ?? '',
                  }),
                )
              }
            />
          </Suspense>
        )}
      </Dialog>
    </div>
  );
}
```

- **One mutation for the three moves with no form** (Make the sales order, Shipped, Delivered). Their refusals
  (`version_conflict`, `storefront_order_step_invalid`, a sales error on the retry) belong to no box, so they show
  above the cards, or inside the Delivered dialog while it is open.
- **`press()`** opens a dialog for Packed (picks) and Delivered (decision 35: it posts an invoice), and sends Shipped
  and the retry at once.
- **The notices follow decision 46.** "Record payment" is a link to a new money receipt with the customer and the
  invoice filled in (decision 7), shown only to someone who may write receipts.
- **The header is the PageHeader's look with the pills beside the number**, as in the mockup. `PageHeader`'s title is
  a string, so the page writes the same classes itself.
- **On a phone the two buttons share a row**, each half the width; alone, a button takes the whole row.
- **The cards' order on a phone comes from CSS.** From `xl` there are two columns (the lines and the timeline; the
  shopper and the documents in 340px). Below it, the two column wrappers are `contents`, so the four cards are
  children of one grid, and `order-1` … `order-4` put the address and the documents before the timeline, the order
  a packer reads them in. No card is rendered twice.
- **Delivered reuses `CancelDraftDialog`**, the small confirm dialog of 17c, with this step's words: a title, a body,
  "Cancel" and the step's button.

```tsx
export function StorefrontOrderPage() {
  const { t } = useLocale();
  const { orderId = '' } = useParams({ strict: false });
  const online = useOnline();
  const { data: order, error } = useQuery({
    ...storefrontOrderQuery(useTenantId(), orderId),
    enabled: online && orderId !== '',
  });

  if (!online) {
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink />
        <StorefrontOffline />
      </div>
    );
  }
  if (error) {
    // 404: no such order, or a pending one the ERP never shows (decision 13)
    const missing = error instanceof ApiRequestError && error.status === 404;
    return (
      <div className="grid max-w-6xl grid-cols-1 gap-5">
        <BackLink />
        <EmptyState
          icon={AlertCircleIcon}
          tone={missing ? 'brand' : 'crit'}
          title={t('storefront.orders.title')}
          description={missing ? t('storefront.order.notFound') : t('storefront.order.loadFailed')}
        />
      </div>
    );
  }
  if (!order) return null;
  // key: a new answer (a move made in another tab) starts the dialogs and the mutation afresh
  return <OrderView key={`${order.id}-${String(order.version)}`} order={order} />;
}
```

- **A 404 says the order does not exist or still waits for its code**: the ERP never shows a pending order
  (decision 13), and an order that never gets its code is deleted after an hour. Any other failure says to refresh.
- **The view's `key` has the version.** An order moved in another tab comes back with a new version, and the dialogs
  and the last error start afresh instead of acting on the old one.

### The Packed dialog

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Image01Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  contractErrorMap,
  packStorefrontOrderInputSchema,
  routes,
  type StorefrontOrder,
  type StorefrontPackPlan,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  cn,
  DialogClose,
  DialogContent,
  Field,
  FormAlert,
  IconButton,
  Input,
  Select,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useId, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import {
  decimalsOf,
  packFormValues,
  type PackLineValues,
  pickedOf,
  plainQuantity,
  storefrontPackPlanQuery,
  toPackInput,
} from '../lib/storefront-orders';
import { useTenantId } from '../lib/workspace';
import { SerialNumbersInput } from './serial-numbers-input';

// Step 27b: "Mark packed" (decisions 5, 14, 15, 32). The dialog asks the API what to pack (the
// warehouse the stock is held in, each line's batches with stock there, and a first-expiry-first
// suggestion), lets the packer change the batches or type the serial numbers, and sends every line
// once. Whether the picks add up and the batches have the stock is the API's to say: its errors
// come back with the same paths as the contract's (lines.0.picks.1.quantity) and show under the box.

// The most picks a line may have (the contract's own limit)
const MAX_PICKS = 20;

// The paths this dialog has a place for. Anything else the API names shows above the lines, so no
// refusal is ever silent
const PLACED = /^lines\.\d+\.(position|picks(\.\d+\.(batchId|quantity|serialNumbers(\.\d+)?))?)$/;

type Errors = Record<string, string>;

// One error code per path, the first one, as the forms do
function errorsOf(fieldErrors: Record<string, string[]> | undefined): Errors {
  return Object.fromEntries(
    Object.entries(fieldErrors ?? {}).flatMap(([path, codes]) =>
      codes[0] === undefined ? [] : [[path, codes[0]]],
    ),
  );
}

function FieldError({ code }: { code: string | undefined }) {
  const { errorText } = useLocale();
  if (code === undefined) return null;
  return (
    <span className="flex items-start gap-1.5 text-label text-crit">
      <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-px shrink-0" />
      {errorText(code)}
    </span>
  );
}

// "2 of 3 pcs picked": good with a tick when the picks are exactly the line, ink-3 otherwise. The
// words carry the meaning; the color only repeats it
function Count({ complete, children }: { complete: boolean; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-label tabular-nums',
        complete ? 'text-good' : 'text-ink-3',
      )}
    >
      {complete && <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.5} />}
      {children}
    </span>
  );
}
```

- **`PLACED`** lists the paths the dialog shows under a box. Any other path the API names (a newer API, a bug) makes
  the error show at the top as well, so no refusal is ever silent.
- **`Count`** says "2 of 3 pcs picked" in words; the green tick only repeats it.

```tsx
function PackLine({
  index,
  planned,
  warehouse,
  image,
  values,
  errors,
  onChange,
}: {
  index: number;
  planned: StorefrontPackPlan['lines'][number];
  warehouse: string;
  image: string | null;
  values: PackLineValues;
  errors: Errors;
  onChange: (next: PackLineValues) => void;
}) {
  const { t, format } = useLocale();
  const id = useId();
  const quantityText = (value: string) =>
    `${format.number(value, decimalsOf(value))} ${planned.unitCode}`;
  const needed = quantityText(planned.quantity);
  const at = `lines.${String(index)}`;
  // A serial number's error names its place in the list (…serialNumbers.2): one line under the box
  const serialError = Object.entries(errors).find(([path]) =>
    path.startsWith(`${at}.picks.0.serialNumbers`),
  )?.[1];

  const batchOptions = [
    { value: '', label: t('storefront.order.packing.batchPlaceholder') },
    ...planned.batches.map((batch) => {
      const available = quantityText(batch.available);
      return {
        value: batch.batchId,
        label:
          batch.expiresOn === null
            ? t('storefront.order.packing.batchOptionNoExpiry', {
                lot: batch.lotNumber,
                available,
              })
            : t('storefront.order.packing.batchOption', {
                lot: batch.lotNumber,
                // A day with no time: read with local date parts, never as UTC midnight
                date: format.date(new Date(`${batch.expiresOn}T00:00:00`)),
                available,
              }),
      };
    }),
  ];

  const setPick = (pickIndex: number, patch: Partial<PackLineValues['picks'][number]>) => {
    onChange({
      ...values,
      picks: values.picks.map((pick, i) => (i === pickIndex ? { ...pick, ...patch } : pick)),
    });
  };

  const { picked, complete } = pickedOf(values, planned.quantity);
  const serials = values.serials.length;
  const serialsNeeded = Number(plainQuantity(planned.quantity));

  return (
    <section
      aria-labelledby={`${id}-name`}
      className="grid gap-3 rounded-control border border-line p-4"
    >
      <header className="flex items-start gap-3">
        {image === null ? (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-subtle text-ink-3">
            <HugeiconsIcon icon={Image01Icon} size={16} strokeWidth={1.5} />
          </span>
        ) : (
          <img
            src={image}
            alt=""
            className="size-10 shrink-0 rounded-lg border border-line bg-surface object-contain"
          />
        )}
        <span className="grid min-w-0 flex-1">
          <span id={`${id}-name`} className="text-body-sm font-medium text-ink">
            {planned.name}
          </span>
          <span className="truncate text-caption text-ink-3">
            <span className="font-mono">{planned.sku}</span>
            {planned.packSize !== '' && ` · ${planned.packSize}`}
          </span>
        </span>
        <span className="shrink-0 text-label text-ink-2 tabular-nums">
          {t('storefront.order.packing.needs', { quantity: needed })}
        </span>
      </header>
      <FieldError code={errors[`${at}.position`]} />

      {planned.tracking === 'none' && (
        <p className="text-body-sm text-ink-2">{t('storefront.order.packing.untracked')}</p>
      )}

      {planned.tracking === 'serial' && (
        <div className="grid gap-1.5">
          {/* The serial box every stock document uses (Geist Mono, one per line, a scanner's
              Enter starts the next), inside a Field for its label, hint and error */}
          <Field
            id={`${id}-serials`}
            label={t('storefront.order.packing.serials')}
            hint={t('storefront.order.packing.serialsHint', {
              needed: format.number(serialsNeeded),
            })}
            error={serialError}
          >
            <SerialNumbersInput
              id={`${id}-serials`}
              value={values.serials}
              invalid={serialError !== undefined}
              aria-describedby={`${id}-serials-${serialError === undefined ? 'hint' : 'error'}`}
              onChange={(serialNumbers) => {
                onChange({ ...values, serials: serialNumbers });
              }}
            />
          </Field>
          <span className="justify-self-end">
            <Count complete={serials === serialsNeeded}>
              {t('storefront.order.packing.serialsCount', {
                entered: format.number(serials),
                needed: format.number(serialsNeeded),
              })}
            </Count>
          </span>
        </div>
      )}

      {planned.tracking === 'batch' && (
        <div className="grid gap-3">
          {/* Mark packed would fail on stock: say so before the packer tries */}
          {planned.batches.length === 0 && (
            <p className="flex items-start gap-1.5 text-label text-crit">
              <HugeiconsIcon
                icon={Alert02Icon}
                size={15}
                strokeWidth={1.5}
                className="mt-px shrink-0"
              />
              {t('storefront.order.packing.noBatches', { warehouse })}
            </p>
          )}
          <div
            aria-hidden="true"
            className="grid grid-cols-[minmax(0,1fr)_120px_36px] gap-x-2.5 text-label font-medium text-ink"
          >
            <span>{t('storefront.order.packing.batch')}</span>
            <span>{t('storefront.order.packing.quantity')}</span>
          </div>
          {values.picks.map((pick, pickIndex) => {
            const number = format.number(pickIndex + 1);
            const batchError = errors[`${at}.picks.${String(pickIndex)}.batchId`];
            const quantityError = errors[`${at}.picks.${String(pickIndex)}.quantity`];
            return (
              <div
                // The picks have no id of their own; their place is what the API's paths name too
                key={pickIndex}
                className="grid grid-cols-[minmax(0,1fr)_120px_36px] items-start gap-x-2.5 gap-y-1"
              >
                <Select
                  aria-label={`${t('storefront.order.packing.batch')} ${number}`}
                  options={batchOptions}
                  value={pick.batchId}
                  invalid={batchError !== undefined}
                  onChange={(event) => {
                    setPick(pickIndex, { batchId: event.target.value });
                  }}
                />
                <Input
                  aria-label={`${t('storefront.order.packing.quantity')} ${number}`}
                  inputMode="decimal"
                  autoComplete="off"
                  align="end"
                  suffix={planned.unitCode}
                  invalid={quantityError !== undefined}
                  value={pick.quantity}
                  onChange={(event) => {
                    setPick(pickIndex, { quantity: event.target.value });
                  }}
                />
                <IconButton
                  icon={Delete02Icon}
                  label={t('storefront.order.packing.removeBatch', { number })}
                  className="mt-[3px]"
                  // A line always has a pick: the contract needs one, and an empty line would
                  // only come back as storefront_order_pick_total
                  disabled={values.picks.length === 1}
                  onClick={() => {
                    onChange({ ...values, picks: values.picks.filter((_, i) => i !== pickIndex) });
                  }}
                />
                {(batchError !== undefined || quantityError !== undefined) && (
                  <span className="col-span-3 grid gap-1">
                    <FieldError code={batchError} />
                    <FieldError code={quantityError} />
                  </span>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={values.picks.length >= MAX_PICKS || planned.batches.length === 0}
              onClick={() => {
                onChange({ ...values, picks: [...values.picks, { batchId: '', quantity: '' }] });
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
              {t('storefront.order.packing.addBatch')}
            </Button>
            <Count complete={complete}>
              {t('storefront.order.packing.picked', {
                picked: quantityText(picked),
                quantity: needed,
              })}
            </Count>
          </div>
        </div>
      )}
      <FieldError code={errors[`${at}.picks`]} />
    </section>
  );
}
```

- **The batch option shows the lot, the expiry and the stock in that warehouse**, the three things a packer checks
  against the box in hand. The expiry is read with local date parts (`T00:00:00` without a zone), never as UTC
  midnight, which in Dhaka would still be the right day but in a time zone west of UTC would be the day before.
- **A line with no batch in stock says so at once** (`noBatches`, `crit`), and "Add another batch" is disabled.
- **A serial line uses `SerialNumbersInput`**, the box every stock document uses: Geist Mono, one serial number per
  line, a scanner's Enter starts the next. A serial number's error names its place in the list
  (`…serialNumbers.2`), so the dialog shows the first such error under the box.
- **Remove is disabled on a line's last pick.** The contract needs at least one, and an empty line would only come
  back as `storefront_order_pick_total`.
- **A pick's key is its place.** Picks have no id, and their place is also what the API's error paths name.

```tsx
function PackForm({
  order,
  plan,
  onDone,
}: {
  order: StorefrontOrder;
  plan: StorefrontPackPlan;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const [lines, setLines] = useState(() => packFormValues(plan));
  const [errors, setErrors] = useState<Errors>({});
  const [rootError, setRootError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The order's photos, by line: the plan has the names, the order has the pictures
  const imageOf = useCallback(
    (position: number) =>
      order.lines.find((line) => line.position === position)?.image?.url ?? null,
    [order.lines],
  );

  const show = (found: Errors, code: string) => {
    setErrors(found);
    const unplaced = Object.keys(found).some((path) => !PLACED.test(path));
    setRootError(Object.keys(found).length === 0 || unplaced ? code : null);
  };

  const submit = async () => {
    // The contract's own checks first (a quantity typed wrong, a serial number twice), with the
    // same paths as the API's, so a mistake shows without a round trip
    const parsed = packStorefrontOrderInputSchema.safeParse(
      toPackInput(plan, lines, order.version),
      { error: contractErrorMap },
    );
    if (!parsed.success) {
      const found: Errors = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        found[path] ??= issue.message;
      }
      show(found, 'invalid_value');
      return;
    }
    setSaving(true);
    try {
      const saved = await call(routes.storefrontOrders.packOrder, {
        params: { id: order.id },
        body: parsed.data,
      });
      await onDone(saved);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        show(errorsOf(error.problem.fieldErrors), error.code);
      } else {
        show({}, 'unknown_error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogContent
      className="max-w-[560px]"
      title={t('storefront.order.packing.title', { number: order.orderNo })}
      description={t('storefront.order.packing.description', { warehouse: plan.warehouse.name })}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="pack-shop-order" disabled={saving}>
            {t('storefront.order.packing.submit')}
          </Button>
        </>
      }
    >
      <form
        id="pack-shop-order"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid gap-3"
      >
        {rootError !== null && <FormAlert message={rootError} />}
        {plan.lines.map((planned, index) => {
          const values = lines[index];
          if (values === undefined) return null;
          return (
            <PackLine
              key={planned.position}
              index={index}
              planned={planned}
              warehouse={plan.warehouse.name}
              image={imageOf(planned.position)}
              values={values}
              errors={errors}
              onChange={(next) => {
                setLines((current) => current.map((line, i) => (i === index ? next : line)));
              }}
            />
          );
        })}
      </form>
    </DialogContent>
  );
}
```

- **The contract's schema runs before the request**, with `contractErrorMap`, so its messages are error codes and its
  paths are the API's. A quantity typed as `1,5` shows under its box with no round trip.
- **The API's `fieldErrors` go into the same map.** A batch without the stock comes back from the challan as
  `lines.0.picks.1.quantity` (27b.3's `onPicks()`), so it shows under the pick that asked for too much.
- **The dialog is 560px**, wider than the usual 520px: the batch select, the quantity and the remove button share one
  row.

```tsx
export function PackDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder) => Promise<void>;
}) {
  const { t } = useLocale();
  const plan = useQuery(storefrontPackPlanQuery(useTenantId(), order.id));
  if (plan.data) return <PackForm order={order} plan={plan.data} onDone={onDone} />;
  // Until the plan comes, the dialog's frame, so the button's press always opens something; when
  // it cannot come, the line that says to close and try again
  return (
    <DialogContent title={t('storefront.order.packing.title', { number: order.orderNo })}>
      {plan.isError && (
        <p role="alert" className="text-body-sm text-crit">
          {t('storefront.order.packing.loadFailed')}
        </p>
      )}
    </DialogContent>
  );
}
```

Until the plan arrives the dialog is its empty frame, so the button's press always opens something. When the plan
cannot load, the dialog says to close it and try again.

### The new-order bell

```diff
@@ -58,9 +58,9 @@ const TARGET = {
   // Step 20b: the list, for an old notification without the shift's id; one with it opens the
   // shift (shiftOf below)
   'pos.shift_variance': '/pos/shifts',
-  // Step 27a: a new shop order. The Orders page comes in step 27b, and opens the order then; until
-  // it does, the overview, where the person was most likely to be
-  'storefront.order_confirmed': '/',
+  // Step 27a: a new shop order. Step 27b: the list's New tab, for an old notification without the
+  // order's id; one with it opens the order (shopOrderOf below)
+  'storefront.order_confirmed': '/storefront/orders',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
@@ -131,6 +131,14 @@ function shiftOf(notification: Notification): string | null {
     : null;
 }
 
+// Step 27b: the new-order bell opens its order. Its id is the order's (27a's handler sends it)
+function shopOrderOf(notification: Notification): string | null {
+  const { id } = notification.params;
+  return notification.type === 'storefront.order_confirmed' && typeof id === 'string' && id !== ''
+    ? id
+    : null;
+}
+
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
 // number no longer changes what you do
 function badgeText(count: number): string {
@@ -296,10 +304,13 @@ export function NotificationBell() {
                   if (notification.readAt === null) markRead.mutate(notification.id);
                   setOpen(false);
                   const shiftId = shiftOf(notification);
+                  const orderId = shopOrderOf(notification);
                   if (opensDocument(notification.type)) {
                     void openDocument(notification.params);
                   } else if (shiftId !== null) {
                     void navigate({ to: '/pos/shifts/$shiftId', params: { shiftId } });
+                  } else if (orderId !== null) {
+                    void navigate({ to: '/storefront/orders/$orderId', params: { orderId } });
                   } else {
                     void navigate({ to: TARGET[notification.type] });
                   }
```

27a's bell went to the overview because there was no order page yet. Now a bell with the order's id opens that order
(27a's handler sends `id`), and an older one without it opens the list's New tab.

### The delivery charge's service in Shop settings

```diff
@@ -176,6 +176,8 @@ export function settingsFormValues(
       freeDeliveryFrom: '',
       minimumOrder: '',
       paymentMethods: ['cod'],
+      // Step 27b (decision 4): none picked; the first order with a charge makes "Delivery charge"
+      deliveryVariantId: '',
       version: 1,
     };
   }
@@ -198,6 +200,8 @@ export function settingsFormValues(
     freeDeliveryFrom: plainAmount(shop.freeDeliveryFrom ?? ''),
     minimumOrder: plainAmount(shop.minimumOrder ?? ''),
     paymentMethods: shop.paymentMethods,
+    // null (none picked yet) is the select's empty choice, ''
+    deliveryVariantId: shop.deliveryVariantId ?? '',
     version: shop.version,
   };
 }
```

`null` from the API (none picked) becomes `''`, the select's empty choice; the contract turns `''` back into `null`.

```diff
@@ -155,6 +155,19 @@ function SettingsForm({
       label: `${warehouse.code} · ${warehouse.name}`,
     })),
   ];
+  // Step 27b (decision 4): the active services the delivery charge may be billed as. The API sends
+  // the saved one too when it was archived since, so the select never shows a value it has no
+  // option for
+  const deliveryOptions = [
+    { value: '', label: t('storefront.settings.deliveryProductAuto') },
+    ...setup.deliveryChoices.map((choice) => ({
+      value: choice.variantId,
+      label: t('storefront.settings.deliveryProductOption', {
+        name: choice.name,
+        sku: choice.sku,
+      }),
+    })),
+  ];
   const languageOptions = LANGUAGES.map((item) => ({ value: item.code, label: item.label }));
   const paymentOptions = SHOP_PAYMENT_METHODS.map((method) => ({
     value: method,
@@ -349,6 +362,16 @@ function SettingsForm({
               </Button>
             </div>
           </fieldset>
+          {/* Step 27b: right under the zones, the charges it bills. Optional: empty, the first
+              order with a charge makes "Delivery charge" and saves it here */}
+          <SelectField
+            label={t('storefront.settings.deliveryProduct')}
+            optional
+            hint={t('storefront.settings.deliveryProductHint')}
+            options={deliveryOptions}
+            {...register('deliveryVariantId')}
+            error={errors.deliveryVariantId?.message}
+          />
           <div className="grid gap-5 sm:grid-cols-2 sm:gap-x-4">
             <FormField
               control={control}
```

- **The box sits right under the delivery zones**, the charges it bills (as in the mockup), and is optional.
- **The options come from `deliveryChoices`** in the settings answer (decision 17): `storefront.manage` cannot read
  the products list. The API includes the saved service even when it was archived since, so the select never holds a
  value it has no option for.
- **Its errors land under it** without new code: the form's field names come from the schema's keys, which now include
  `deliveryVariantId`.

### The mock shop

```diff
@@ -128,6 +128,8 @@ export function setupOf(data: WorkspaceData, workspace: Workspace): StorefrontSe
       hotline: data.settings.phone ?? '',
       address: data.settings.address ?? '',
     },
+    // Step 27b: none to pick until 27b.7 lists the services
+    deliveryChoices: [],
   };
 }
 
@@ -162,6 +164,8 @@ function fieldsOf(input: CreateStorefrontSettingsInput, before: readonly ShopDel
     freeDeliveryFrom: input.freeDeliveryFrom === null ? null : money(input.freeDeliveryFrom),
     minimumOrder: input.minimumOrder === null ? null : money(input.minimumOrder),
     paymentMethods: input.paymentMethods,
+    // Step 27b: kept as sent until 27b.7 brings the API's checks
+    deliveryVariantId: input.deliveryVariantId,
   };
 }
 
```

```diff
@@ -241,6 +241,7 @@ export function seedStorefront(data: WorkspaceData, garments: boolean): void {
     freeDeliveryFrom: '2000.0000',
     minimumOrder: null,
     paymentMethods: payments,
+    deliveryVariantId: null,
     launchedAt: daysAgo(12),
     version: 4,
     updatedAt: daysAgo(3),
```

Only what the type check needs: the mock keeps the picked service as sent, has no choices yet, and the seeded shop has
none picked. 27b.7 gives the mock the API's rules and its Shop orders.

### The bundle budget

```diff
@@ -38,7 +38,9 @@ const INITIAL_BUDGET = 245 * 1024;
 // 26g: 150 KB (you chose this). A shop listing's editor is one form of five cards (the photo
 // uploader, the sale with its dates, the description with its preview): 145.9 KB. Loading two of
 // its cards on their own saved only 4 KB, most of the chunk being the route table and form parts.
-const CHUNK_BUDGET = 150 * 1024;
+// Step 27b: 155 KB (you chose this). The Shop orders' nine routes grew the route table, and the
+// listing's editor went from 149.8 to 150.8 KB without changing; the orders' own pages are 95–109 KB.
+const CHUNK_BUDGET = 155 * 1024;
 // Step 19a: everything the service worker downloads the first time, gz (the fonts do not shrink).
 // 1.3 MB at 19a. It is downloaded once per device; a new version downloads only the files that
 // changed.
```

Decision 45. The first chunk is 243.4 KB of its 245 KB.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                                  # 239 unit tests, 10 of them new
pnpm exec eslint apps/app/src apps/app/scripts
pnpm exec prettier --check apps/app/src apps/app/scripts
pnpm --filter @omnivo/ui build && pnpm --filter @omnivo/app build
pnpm --filter @omnivo/app test:bundle-size
```

Broken on purpose, each caught by the new spec (and put back): `nextStep()` offering "Mark packed" to an order with no
sales order, and `toPackInput()` sending a serial line without its serial numbers.

The screens are compared with the mockup in 27b.7, once the mock API has Shop orders to show.

## 27b.7 — The mock API and the browser tests

The app's mock mode (`pnpm dev:mock`, and every Playwright test) now has Shop orders: the nine routes with the API's
rules, a shop with seven orders in every state, and the delivery charge's service box with the API's checks. Then
eight Playwright tests, each run on a desktop and on a 390px phone. With the mock in place, the screens were compared
with the approved mockup; two differences were fixed here (decisions 55 and 56).

Decisions made in this part (mine, except 56):

49. **The shop orders are seeded only when a test asks for them** (`test.use({ shopOrders: true })`), like 21b's year
    of trade. Seeding them makes sales orders, challans, an invoice, customers and two products with stock. Every other
    test would then see other next numbers (`SO-2026-27-0002` would become `…-0008`), other customer lists and other
    stock values. `pnpm dev:mock` has no key, so a person trying the app sees the orders.
50. **The seed adds two accessories to the garments shop: an attar tracked by batch (with expiry) and a wristwatch
    tracked by serial number.** The garments workspace has no batch product at all, and the Packed dialog's two hard
    cases are a line split over two lots and a line typed by serial number. Fashion shops in Bangladesh do sell attar
    and watches beside clothes, so the orders still read true. Their lots come in the "wrong" order on purpose:
    AT-2411 arrives first but expires later, so a test sees that the plan goes by expiry, not by arrival.
51. **A move makes real mock documents with the sales mocks' own functions** (`createOrder`, `saveDelivery` and
    `postDelivery`, `saveInvoice` and `postInvoice`, `saveReturn` and `postReturn`, `changeOrderStatus`). So the
    numbers on the order's page open real pages, the stock really moves, and a refusal is the sales mock's own
    (`stock_insufficient` on a batch). The file imports `workspace-data.ts` as a type only, because
    `workspace-data.ts` imports its seed: the audit rows are written in `handlers.ts`, like the other sales routes.
52. **The mock's maker checks the goods lines before it makes anything.** The API rolls its transaction back when the
    sales order is refused. The mock's `transaction()` copies the documents and the stock, but not the catalog (10,000
    products), the customers or the shop. Checking the lines first means a refusal leaves no customer and no
    "Delivery charge" behind.
53. **W-000007's sales order was refused with `sales_item_invalid`, and its product is active again**, so "Make the
    sales order" works on the first press. A test then sees the whole way back: the crit notice, the button, the
    toast, the customer made by the phone.
54. **The mock's `createOrder` takes the shop's two differences as an optional argument**: prices that include VAT,
    and the shopper's address as text. It is the same split as the API's `insert(…, shop)` in 27b.3.
55. **Fix of a 27b.6 slip: the Packed dialog's count says "2 of 3 pcs picked"**, as in the mockup. It said "2 pcs of
    3 pcs picked": both numbers were formatted with the unit.
56. **On a phone, a list card has no Payment line (your choice).** The mockup drew a compact card that the shared
    `DataTable` card cannot draw. Rather than change that shared component, the column leaves the phone card: every
    order is Cash on Delivery until 27c, so the line said the same thing on every card.
57. **The tests never count the whole bell.** Other seeds have unread notifications too, so the bell's button is
    found by a pattern (`Notifications, <any number> unread`), and the test clicks the order's own row.

### What the mock keeps

```diff
@@ -1,4 +1,5 @@
 import {
+  type ErrorCode,
   type ShopPaymentMethod,
   type ShopTextPageSlug,
   slugFromName,
@@ -10,6 +11,7 @@ import {
   type StorefrontHero,
   type StorefrontImage,
   type StorefrontListing,
+  type StorefrontOrder,
   type StorefrontSale,
   type StorefrontSection,
   type StorefrontSettings,
@@ -115,6 +117,53 @@ export interface MockPage {
   updatedAt: string;
 }
 
+// Step 27b: a shop order as the ERP keeps it: 27a's storefront_orders row with its lines, and the
+// four documents 27b links to it. The mock never has a pending one: an order waiting for its phone
+// code is the shopper's (apps/shop), and the ERP never lists it. Each line keeps the listing's copy
+// as the shopper saw it (name, pack size, photo, price); the timeline is kept as it grows, the
+// shape the page reads (the API works it out from the row's *_at columns)
+export interface MockShopOrderLine {
+  position: number;
+  listingId: string;
+  name: string;
+  packSize: string;
+  image: StorefrontImage | null;
+  productId: string;
+  variantId: string;
+  quantity: number;
+  unitPrice: string;
+  lineTotal: string;
+}
+
+export interface MockShopOrder {
+  id: string;
+  orderNo: string;
+  status: StorefrontOrder['status'];
+  history: StorefrontOrder['history'];
+  customerName: string;
+  // 11 digits, as the shop's checkout keeps it (01711223344)
+  phone: string;
+  address: string;
+  zoneName: string;
+  paymentMethod: ShopPaymentMethod;
+  lines: MockShopOrderLine[];
+  subtotal: string;
+  discount: string;
+  couponCode: string | null;
+  deliveryCharge: string;
+  total: string;
+  // The warehouse the stock is held in (27a copied the shop's onto each hold)
+  warehouseId: string;
+  cancelReason: string | null;
+  salesOrderId: string | null;
+  deliveryId: string | null;
+  invoiceId: string | null;
+  salesReturnId: string | null;
+  documentError: ErrorCode | null;
+  version: number;
+  updatedAt: string;
+}
+
 export interface MockStorefront {
   shop: MockShop | null;
   categories: MockCategory[];
@@ -127,6 +176,8 @@ export interface MockStorefront {
   collections: MockCollection[];
   home: MockHomeBlock[];
   pages: Map<ShopTextPageSlug, MockPage>;
+  // Step 27b: the shop's confirmed orders, newest first (storefront-order-data.ts)
+  orders: MockShopOrder[];
 }
 
 export function emptyStorefront(): MockStorefront {
@@ -142,6 +193,7 @@ export function emptyStorefront(): MockStorefront {
     collections: [],
     home: [],
     pages: new Map(),
+    orders: [],
   };
 }
 
@@ -174,7 +226,8 @@ function seedPicture(
   return { id, alt };
 }
 
-function seedPhoto(
+// Step 27b: exported for the shop orders' two extra listings (storefront-order-data.ts)
+export function seedPhoto(
   data: WorkspaceData,
   label: string,
   colour: string,
```

`MockShopOrder` is 27a's `storefront_orders` row with its lines, plus 27b's four document links and the error. Two
choices differ from the table on purpose:

- **The timeline is kept as a list that grows** (`history`), in the shape the page reads. The API works it out from
  five `*_at` columns; the mock has no columns to save space in, and a list cannot get the steps out of order.
- **No pending order.** An order waiting for its code belongs to the shopper's side (`apps/shop` and its own mock).
  The ERP's routes never show one, so the ERP's mock never needs one.

`seedPhoto` is exported for the two new listings' photos, drawn the same way as the shop's other packshots.

### A shop order's sales order, the mock's way

```diff
@@ -526,24 +526,30 @@ function openQuotation(data: WorkspaceData, quotationId: string, customerId: str
   return quotation;
 }
 
-// Step 18b: an order written on a device comes with the id the device made (push-data.ts)
+// Step 18b: an order written on a device comes with the id the device made (push-data.ts). Step
+// 27b: a shop order's (storefront-order-data.ts), like the API's createForShop: its prices include
+// VAT whatever the workspace's setting, and it keeps the address the shopper typed as text
 export function createOrder(
   data: WorkspaceData,
   input: OrderFields,
   quotationId: string | null,
   id: string = crypto.randomUUID(),
+  shop: { pricesIncludeVat: boolean; shippingAddress: string } | null = null,
 ): MockOrder {
   const customer = customerOf(data, input.customerId, null);
   const quotation = quotationId === null ? null : openQuotation(data, quotationId, customer.id);
   // An order made from a quotation reads its prices the way the quotation did
-  const pricesIncludeVat = quotation?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
+  const pricesIncludeVat =
+    shop?.pricesIncludeVat ?? quotation?.pricesIncludeVat ?? data.settings.pricesIncludeVat;
+  const parts = orderParts(data, input, customer, pricesIncludeVat, new Set());
   const created: MockOrder = {
     id,
     number: null,
     status: 'draft',
     confirmedAt: null,
     quotationId: quotation?.id ?? null,
-    ...orderParts(data, input, customer, pricesIncludeVat, new Set()),
+    ...parts,
+    shippingAddress: parts.shippingAddress ?? shop?.shippingAddress ?? null,
     version: 1,
     updatedAt: now(),
   };
```

Decision 54. `shop` is the last argument with a default of `null`, so the device's call (`createOrder(data, input,
null, id)` in 18b) and the form's call do not change. The address is written after `orderParts()`: a shop order has
no saved address (`shippingAddressId` is null), so `orderParts()` gives `null` and the typed text takes its place.

### The rules: reading

```ts
import {
  addMoney,
  compareMoney,
  compareQuantity,
  type CustomerInput,
  type DocumentRef,
  type ErrorCode,
  isTrackingMode,
  listingPricing,
  multiplyMoney,
  type PackStorefrontOrderInput,
  productInputSchema,
  type SalesLineInput,
  type ShopDeliveryZone,
  type StorefrontImage,
  type StorefrontOrder,
  type StorefrontOrderCounts,
  type storefrontOrderQuerySchema,
  type StorefrontOrderSort,
  type StorefrontOrderSummary,
  type StorefrontPackPlan,
  type StorefrontSetup,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { confirmWithCredit, postInvoice, saveInvoice } from './invoice-data';
import { MockProblem } from './mock';
import { saveProduct } from './product-data';
import { postReturn, saveReturn } from './return-data';
import { saveCustomer } from './sales-data';
import {
  changeOrderStatus,
  createOrder,
  findDelivery,
  findOrder,
  type MockDelivery,
  type MockOrder,
  pageOf,
  postDelivery,
  resolveSalesLines,
  saveDelivery,
} from './sales-document-data';
import { balancesOf, branchOf, findVariant, postAdjustment, saveAdjustment } from './stock-data';
import {
  type MockCategory,
  type MockListing,
  type MockShopOrder,
  type MockShopOrderLine,
  seedPhoto,
} from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 27b: the shop's orders in the ERP (Storefront → Shop orders), with the API's rules
// (apps/api/src/storefront/orders/storefront-orders.service.ts and sales-order-maker.ts). A move
// makes its ERP documents with the mock's own sales code (sales-document-data.ts, invoice-data.ts,
// return-data.ts), so the documents it links open on their own pages like any other. The handlers
// run every move in transaction(): a refused document leaves nothing behind. The audit rows are
// the handlers' (handlers.ts): this file imports workspace-data.ts's type only, because
// workspace-data.ts imports the seed below (an import cycle otherwise).
//
// The seed is the garments workspace's Rahman Fashion after 12 days open, only when a test asks
// for it (fixtures.ts → seedsShopOrders): its orders make sales orders, challans, an invoice and
// customers, which would change the numbers and the lists other tests read.

type OrderQuery = z.output<typeof storefrontOrderQuerySchema>;

function now(): string {
  return new Date().toISOString();
}

function stepInvalid(): MockProblem {
  return new MockProblem(409, 'storefront_order_step_invalid');
}

// A day in the workspace's time zone: the documents a move makes are dated on it (decision 21)
function dayOf(data: WorkspaceData, at: string): string {
  return todayIn(data.settings.timezone, new Date(at));
}

// The API's phoneDigits: digits only, and +880 … the same as 0 …
function localPhone(phone: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
}
```

The header says what the file is and why the audit rows live elsewhere (decision 51). `dayOf()` dates every document
in the workspace's time zone from the move's own moment. The seed passes a moment days ago, so W-000001's invoice is
dated the day it was delivered, not the day the mock started. `localPhone()` is the API's `phoneDigits`: a customer
saved as `+880 1711-223344` is the same phone as the shop's `01711223344`.

```ts
// ---------------------------------------------------------------------------------------------
// Reading

function itemCount(order: MockShopOrder): number {
  return order.lines.reduce((count, line) => count + line.quantity, 0);
}

function summaryOf(order: MockShopOrder): StorefrontOrderSummary {
  const [placed, confirmed] = order.history;
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    placedAt: placed?.at ?? now(),
    confirmedAt: confirmed?.at ?? now(),
    customerName: order.customerName,
    phone: order.phone,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    itemCount: itemCount(order),
    total: order.total,
    needsAttention: order.documentError !== null,
  };
}

function confirmedAt(order: MockShopOrder): string {
  return summaryOf(order).confirmedAt;
}

// Each sort with its tie-breaker by id, so a page never repeats or skips an order. The mock's
// cursor is an offset (pageOf), so it cannot tell another sort's cursor the way the API does
const SORTS = {
  '-confirmed': (a, b) => confirmedAt(b).localeCompare(confirmedAt(a)) || b.id.localeCompare(a.id),
  confirmed: (a, b) => confirmedAt(a).localeCompare(confirmedAt(b)) || a.id.localeCompare(b.id),
  '-total': (a, b) => compareMoney(b.total, a.total) || b.id.localeCompare(a.id),
  total: (a, b) => compareMoney(a.total, b.total) || a.id.localeCompare(b.id),
} satisfies Record<StorefrontOrderSort, (a: MockShopOrder, b: MockShopOrder) => number>;

// The API's searchFilter: part of the number, of the name, or of the phone with its spaces and
// dashes dropped
function matches(order: MockShopOrder, search: string): boolean {
  const pattern = search.normalize('NFC').toLowerCase();
  const digits = search.replace(/[\s-]/g, '');
  return (
    order.orderNo.toLowerCase().includes(pattern) ||
    order.customerName.toLowerCase().includes(pattern) ||
    (/^\d+$/.test(digits) && order.phone.includes(digits))
  );
}

export function shopOrderPage(
  data: WorkspaceData,
  query: OrderQuery,
): { items: StorefrontOrderSummary[]; nextCursor: string | null } {
  const search = query.search ?? '';
  const found = data.storefront.orders.filter(
    (order) =>
      (query.view === 'all' || order.status === query.view) &&
      (search === '' || matches(order, search)),
  );
  const page = pageOf(found.toSorted(SORTS[query.sort]), query);
  return { items: page.items.map(summaryOf), nextCursor: page.nextCursor };
}

export function shopOrderCounts(data: WorkspaceData): StorefrontOrderCounts {
  return {
    confirmed: data.storefront.orders.filter((order) => order.status === 'confirmed').length,
  };
}

export function findShopOrder(data: WorkspaceData, id: string): MockShopOrder {
  const found = data.storefront.orders.find((order) => order.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A photo whose file is gone shows no picture, not a broken one (the API's `ready` check)
function imageOf(data: WorkspaceData, image: StorefrontImage | null) {
  if (image === null) return null;
  const photo = data.storefront.photos.get(image.id);
  return photo?.outcome?.kind === 'ready' && photo.url !== null
    ? { ...image, url: photo.url }
    : null;
}

// The variant now: its SKU and its base unit's code ("2 pcs"), its tracking for the pack plan
function variantOf(data: WorkspaceData, line: MockShopOrderLine) {
  const found = findVariant(data, line.variantId);
  if (!found) throw new Error(`Shop order line of a missing variant ${line.variantId}`);
  const unit = data.catalog.units.find((item) => item.id === found.product.baseUnitId);
  return { ...found, unitCode: unit?.code ?? '' };
}

function refOf(document: { id: string; number: string | null } | undefined): DocumentRef | null {
  return document === undefined ? null : { id: document.id, number: document.number };
}

export function toShopOrder(data: WorkspaceData, order: MockShopOrder): StorefrontOrder {
  const salesOrder = data.salesDocuments.orders.find((item) => item.id === order.salesOrderId);
  return {
    ...summaryOf(order),
    address: order.address,
    history: order.history,
    lines: order.lines.map((line) => {
      const { variant, unitCode } = variantOf(data, line);
      return {
        position: line.position,
        listingId: line.listingId,
        name: line.name,
        packSize: line.packSize,
        image: imageOf(data, line.image),
        productId: line.productId,
        variantId: line.variantId,
        sku: variant.sku,
        unitCode,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      };
    }),
    subtotal: order.subtotal,
    discount: order.discount,
    couponCode: order.couponCode,
    deliveryCharge: order.deliveryCharge,
    cancelReason: order.cancelReason,
    customer:
      salesOrder === undefined
        ? null
        : { id: salesOrder.customer.id, name: salesOrder.customer.name },
    salesOrder: refOf(salesOrder),
    delivery: refOf(data.salesDocuments.deliveries.find((item) => item.id === order.deliveryId)),
    invoice: refOf(data.billing.invoices.find((item) => item.id === order.invoiceId)),
    salesReturn: refOf(data.returns.salesReturns.find((item) => item.id === order.salesReturnId)),
    documentError: order.documentError,
    version: order.version,
    updatedAt: order.updatedAt,
  };
}

// FOR UPDATE's checks: the order, and the version the page read
function lockShopOrder(data: WorkspaceData, id: string, version: number): MockShopOrder {
  const order = findShopOrder(data, id);
  if (order.version !== version) throw new MockProblem(409, 'version_conflict');
  return order;
}

// A move: the new status, the step on the timeline, the version up. The audit row is the
// handler's (recordShopMove in handlers.ts)
function move(
  order: MockShopOrder,
  status: MockShopOrder['status'],
  at: string,
  fields: Partial<MockShopOrder> = {},
): void {
  Object.assign(order, fields, {
    status,
    history: [...order.history, { status, at }],
    version: order.version + 1,
    updatedAt: at,
  });
}
```

- `SORTS` is a `Record` over `StorefrontOrderSort` with `satisfies`: a fifth sort in the contract does not compile
  until it has its line here. Each sort breaks ties by id, so two orders with one total keep one order between pages.
- The cursor is an offset (`pageOf`), like every mock list. It cannot refuse another sort's cursor the way the API
  does (`invalid_cursor`); the app never sends one, because a new sort is a new query key.
- `matches()` is the API's search: the number, the name, and the phone only when the search is digits once spaces and
  dashes are gone. So "01711 223344" finds the order, and "Farhana" does not look in the phones.
- `imageOf()` shows no picture when the photo is gone or not ready, the API's `ready` check. A broken image would
  look like a bug on the packer's screen.
- `toShopOrder()` reads the customer through the sales order (decision 2: the order has no customer of its own), and
  each document's number from its own store. A number is never copied onto the order: a document's page and the
  order's page can never disagree.
- `lockShopOrder()` is the two checks the API's `FOR UPDATE` read makes: the order exists, and its version is the one
  the page read. `move()` is the API's `move()`: one place where the status, the timeline and the version change.

### The rules: the sales order

```ts
// ---------------------------------------------------------------------------------------------
// The sales order (decisions 1 to 4, ShopSalesOrderMaker)

// What the handlers write audit rows for, besides the move itself
export interface MadeSalesOrder {
  salesOrder: MockOrder;
  customerId: string;
  customerMade: boolean;
  deliveryProductId: string | null;
  overridden: { limit: string; exposure: string } | null;
}

// A product's VAT rate: its own, else the workspace's default. Neither: the sales order's own error
function rateOf(data: WorkspaceData, taxRateId: string | null): string {
  const rate =
    taxRateId ??
    data.sales.taxRates.find((item) => item.isDefault && item.archivedAt === null)?.id ??
    null;
  if (rate === null) throw new MockProblem(409, 'tax_rate_invalid');
  return rate;
}

// One line per shop line, in the cart's order, in the base unit at the shop's price (decision 3)
function goodsLines(data: WorkspaceData, order: MockShopOrder): SalesLineInput[] {
  return order.lines.map((line) => {
    const { product } = variantOf(data, line);
    return {
      variantId: line.variantId,
      unitId: product.baseUnitId,
      quantity: String(line.quantity),
      description: null,
      unitPrice: line.unitPrice,
      discountType: 'amount',
      discount: '0',
      taxRateId: rateOf(data, product.taxRateId),
    };
  });
}

// "Delivery charge", made by the first order with a charge (decision 4): a service in the piece
// unit, its id kept in the shop's settings, whose version goes up (a settings form open somewhere
// must reload before its save)
function makeDeliveryService(data: WorkspaceData): string {
  const shop = data.storefront.shop;
  if (shop === null) throw new Error('A shop order without a shop');
  const unit = data.catalog.units
    .filter((item) => item.archivedAt === null && item.dimension === 'count')
    .filter((item) => item.ratio !== null && compareQuantity(item.ratio, '1') === 0)
    .toSorted((a, b) => Number(b.code === 'pcs') - Number(a.code === 'pcs'))[0];
  if (unit === undefined) throw new MockProblem(409, 'storefront_delivery_product_invalid');
  const product = saveProduct(
    data.catalog,
    productInputSchema.parse({
      code: '',
      name: 'Delivery charge',
      type: 'service',
      categoryId: '',
      description: '',
      baseUnitId: unit.id,
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
    }),
  );
  data.catalog.products.push(product);
  const [variant] = product.variants;
  if (!variant) throw new Error('Delivery charge was made without a variant');
  Object.assign(shop, {
    deliveryVariantId: variant.id,
    version: shop.version + 1,
    updatedAt: now(),
  });
  return product.id;
}

// The address on the sales order and the challan: who, where and the phone, on their own lines
function shippingText(order: MockShopOrder): string {
  return [order.customerName, order.address, order.phone].join('\n');
}

// Decision 2: the first active customer with this phone, else a new one with no credit limit
function customerFor(data: WorkspaceData, order: MockShopOrder): { id: string; made: boolean } {
  const found = data.sales.customers.find(
    (customer) => customer.archivedAt === null && localPhone(customer.phone) === order.phone,
  );
  if (found) return { id: found.id, made: false };
  const language = data.storefront.shop?.language ?? 'en';
  const input: CustomerInput = {
    code: null,
    name: order.customerName,
    groupId: null,
    contactPerson: null,
    phone: order.phone,
    email: null,
    documentLanguage: language,
    bin: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    notes: null,
    addresses: [{ id: null, kind: 'shipping', label: null, address: order.address, phone: null }],
  };
  const saved = saveCustomer(data, input);
  data.sales.customers.push(saved);
  return { id: saved.id, made: true };
}

// The API's maker, in the order that lets a refusal leave nothing behind: the API rolls its
// transaction back, while the mock's transaction() does not copy the catalog (10,000 products), the
// customers or the shop. So the goods lines are checked first (an archived product, no VAT rate:
// the sales order's own errors), then the service, the customer and the order are made
export function makeShopSalesOrder(
  data: WorkspaceData,
  order: MockShopOrder,
  at: string = now(),
): MadeSalesOrder {
  const shop = data.storefront.shop;
  if (shop === null) throw new Error('A shop order without a shop');
  const goods = goodsLines(data, order);
  resolveSalesLines(data, goods, true, new Set());
  let deliveryProductId: string | null = null;
  const lines = [...goods];
  // A free delivery adds no line: a line of ৳0 would print a service nobody paid for
  if (compareMoney(order.deliveryCharge, '0') > 0) {
    if (shop.deliveryVariantId === null) deliveryProductId = makeDeliveryService(data);
    const variantId = shop.deliveryVariantId;
    const found = variantId === null ? undefined : findVariant(data, variantId);
    if (!found) throw new Error('The delivery charge service is missing');
    lines.push({
      variantId: found.variant.id,
      unitId: found.product.baseUnitId,
      quantity: '1',
      description: null,
      unitPrice: order.deliveryCharge,
      discountType: 'amount',
      discount: '0',
      taxRateId: rateOf(data, found.product.taxRateId),
    });
  }
  const customer = customerFor(data, order);
  const salesOrder = createOrder(
    data,
    {
      customerId: customer.id,
      date: dayOf(data, at),
      deliveryDate: null,
      // The shop's number, as a buyer's PO number would be
      customerReference: order.orderNo,
      warehouseId: order.warehouseId,
      shippingAddressId: null,
      note: null,
      lines,
    },
    null,
    crypto.randomUUID(),
    { pricesIncludeVat: true, shippingAddress: shippingText(order) },
  );
  // Over the limit it still goes (CreditOverride 'storefront_order'): the audit log says so
  const overridden = confirmWithCredit(data, salesOrder, true);
  Object.assign(order, {
    salesOrderId: salesOrder.id,
    documentError: null,
    version: order.version + 1,
    updatedAt: at,
  });
  return {
    salesOrder,
    customerId: customer.id,
    customerMade: customer.made,
    deliveryProductId,
    overridden,
  };
}

// "Make the sales order" (decision 1's retry): a refusal is kept on the order, as the handler
// keeps it, and still answered. The handler calls it outside transaction(): the order's error must
// stay when the sales order is refused
export function retrySalesOrder(data: WorkspaceData, id: string, version: number): MadeSalesOrder {
  const order = lockShopOrder(data, id, version);
  if (order.status !== 'confirmed' || order.salesOrderId !== null) throw stepInvalid();
  try {
    return makeShopSalesOrder(data, order);
  } catch (error) {
    if (error instanceof MockProblem) order.documentError = error.code;
    throw error;
  }
}

function salesOrderOf(data: WorkspaceData, order: MockShopOrder): MockOrder {
  if (order.salesOrderId === null) throw new MockProblem(409, 'storefront_order_no_sales_order');
  return findOrder(data, order.salesOrderId);
}
```

- `rateOf()`: a product without a VAT rate follows the default; with neither, the sales order's own `tax_rate_invalid`,
  the code the page shows with "Make the sales order".
- `makeDeliveryService()` takes the piece unit (`dimension` count, `ratio` 1, `pcs` first), as the API does, and makes
  the service through `productInputSchema.parse()`. The parse fills the form's defaults, so the product is one the
  product form could have saved. The shop's version goes up: a Shop settings form open somewhere must reload before
  it saves, or it would send its empty box back over the new service.
- `customerFor()` takes the first active customer with the phone (the mock's customers are kept in the order they
  were made, so "first" is the API's "oldest"). A new one gets no credit limit and the shop's language.
- `makeShopSalesOrder()` is in decision 52's order: lines checked (`resolveSalesLines` throws the sales order's own
  error), then the service, the customer and the order. `confirmWithCredit(…, true)` confirms even over a limit; its
  answer goes back to the handler, which writes the `credit_limit.overridden` row.
- `retrySalesOrder()` keeps a refusal on the order before it throws again. The handler does not wrap it in
  `transaction()`: the error must stay on the order even though the request fails.

### The rules: Packed

```ts
// ---------------------------------------------------------------------------------------------
// Packed (decisions 5, 14, 15)

// The batches of a variant with stock in the warehouse, earliest expiry first (none last), then
// the oldest batch: the order FEFO takes them in
function batchesIn(data: WorkspaceData, warehouseId: string, variantId: string) {
  const balances = balancesOf(data.stock);
  return data.stock.batches
    .filter((batch) => batch.variantId === variantId)
    .map((batch) => ({
      batchId: batch.id,
      lotNumber: batch.lotNumber,
      expiresOn: batch.expiresOn,
      available: balances.byBatch.get(`${warehouseId}|${variantId}|${batch.id}`) ?? '0',
    }))
    .filter((batch) => compareQuantity(batch.available, '0') > 0)
    .toSorted((a, b) => (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'));
}

// FEFO: take from the first batch until the line is full, then the next. A line the batches
// cannot fill keeps what they have; the challan's stock check has the last word
function fefo(
  quantity: string,
  available: StorefrontPackPlan['lines'][number]['batches'],
): StorefrontPackPlan['lines'][number]['picks'] {
  const picks: StorefrontPackPlan['lines'][number]['picks'] = [];
  let left = quantity;
  for (const batch of available) {
    if (compareQuantity(left, '0') <= 0) break;
    const take = compareQuantity(batch.available, left) < 0 ? batch.available : left;
    picks.push({ batchId: batch.batchId, quantity: sumQuantity([take]), serialNumbers: [] });
    left = subtractQuantity(left, take);
  }
  return picks;
}

export function packPlanOf(data: WorkspaceData, id: string): StorefrontPackPlan {
  const order = findShopOrder(data, id);
  if (order.status !== 'confirmed') throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);
  const warehouse = data.stock.warehouses.find((place) => place.id === salesOrder.warehouseId);
  if (!warehouse) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
  return {
    warehouse: { id: warehouse.id, name: warehouse.name },
    lines: order.lines.map((line) => {
      const { product, variant, unitCode } = variantOf(data, line);
      const quantity = String(line.quantity);
      // A product's tracking is a plain string in its answer (a newer server's new mode must not
      // break an older client); the plan's is the enum
      const tracking = isTrackingMode(product.tracking) ? product.tracking : 'none';
      const batches = tracking === 'batch' ? batchesIn(data, warehouse.id, line.variantId) : [];
      return {
        position: line.position,
        name: line.name,
        packSize: line.packSize,
        sku: variant.sku,
        unitCode,
        quantity,
        tracking,
        batches,
        picks:
          tracking === 'none'
            ? [{ batchId: null, quantity, serialNumbers: [] }]
            : tracking === 'batch'
              ? fefo(quantity, batches)
              : [],
      };
    }),
  };
}

// The challan's own errors name its lines (lines.0, lines.1 …); the dialog has the order's lines,
// each split into picks. The API's onPicks(): each challan line back to its line and pick
function onPicks(error: unknown, at: readonly { line: number; pick: number }[]): never {
  if (!(error instanceof MockProblem) || error.fieldErrors === undefined) throw error;
  const fieldErrors = Object.fromEntries(
    Object.entries(error.fieldErrors).map(([path, codes]) => {
      const match = /^lines\.(\d+)\.(.+)$/.exec(path);
      const where = match === null ? undefined : at[Number(match[1])];
      const field = match?.[2];
      return [
        where === undefined || field === undefined
          ? path
          : `lines.${String(where.line)}.picks.${String(where.pick)}.${field}`,
        codes,
      ];
    }),
  );
  throw new MockProblem(error.status, error.code, fieldErrors, error.params);
}

export function packShopOrder(
  data: WorkspaceData,
  id: string,
  input: PackStorefrontOrderInput,
  at: string = now(),
): { order: MockShopOrder; delivery: MockDelivery } {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'confirmed') throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);

  // Every line of the order once, and the picks of each add up to what the shopper ordered
  const byPosition = new Map(order.lines.map((line, index) => [line.position, index]));
  const fieldErrors: Record<string, ErrorCode[]> = {};
  input.lines.forEach((line, lineIndex) => {
    const index = byPosition.get(line.position);
    const ordered = index === undefined ? undefined : order.lines[index];
    if (ordered === undefined) {
      fieldErrors[`lines.${String(lineIndex)}.position`] = ['storefront_order_line_missing'];
      return;
    }
    const picked = sumQuantity(line.picks.map((pick) => pick.quantity));
    if (compareQuantity(picked, String(ordered.quantity)) !== 0) {
      fieldErrors[`lines.${String(lineIndex)}.picks`] = ['storefront_order_pick_total'];
    }
  });
  const [first] = Object.values(fieldErrors);
  if (first?.[0] !== undefined) throw new MockProblem(409, first[0], fieldErrors);
  if (input.lines.length !== order.lines.length) {
    throw new MockProblem(409, 'storefront_order_line_missing');
  }

  // Line i of the order is line i of the sales order (the maker wrote them so)
  const challanLines = input.lines.flatMap((line, lineIndex) => {
    const index = byPosition.get(line.position) ?? -1;
    const soLine = salesOrder.lines[index];
    if (soLine === undefined || soLine.variantId !== order.lines[index]?.variantId) {
      throw new Error(`Order ${id} line ${String(line.position)} has no sales order line`);
    }
    return line.picks.map((pick, pickIndex) => ({
      at: { line: lineIndex, pick: pickIndex },
      line: {
        variantId: soLine.variantId,
        unitId: soLine.unitId,
        quantity: pick.quantity,
        batchId: pick.batchId,
        serialNumbers: pick.serialNumbers,
        orderLineId: soLine.id,
      },
    }));
  });
  let delivery: MockDelivery;
  try {
    const draft = saveDelivery(data, {
      customerId: salesOrder.customer.id,
      orderId: salesOrder.id,
      date: dayOf(data, at),
      warehouseId: salesOrder.warehouseId,
      shippingAddressId: null,
      vehicle: null,
      note: null,
      lines: challanLines.map((entry) => entry.line),
    });
    // The shopper's address as text, like the API's postForShopOrder
    draft.shippingAddress = salesOrder.shippingAddress;
    delivery = postDelivery(data, draft);
  } catch (error) {
    onPicks(
      error,
      challanLines.map((entry) => entry.at),
    );
  }
  move(order, 'packed', at, { deliveryId: delivery.id });
  return { order, delivery };
}
```

- `batchesIn()` reads the stock of each batch in the order's warehouse and sorts by expiry, no expiry last. The mock
  has no "created" date on a batch, but its array is in arrival order and `toSorted()` is stable, so two lots with one
  expiry keep the API's "oldest first".
- `fefo()` is the API's function, word for word. Its quantities come out of `sumQuantity()`, so a batch pick is
  `"3.0000"` here too and the dialog's plain display (decision 40) is tested against the same strings.
- `packPlanOf()` narrows the product's `tracking` with `isTrackingMode()`: a product's answer keeps it as a plain
  string (a newer server's new mode must not break an older app), but the plan's contract is the enum.
- `packShopOrder()` checks what the API checks before any document: each line once, and its picks adding up to the
  ordered quantity (`storefront_order_pick_total` under that line's picks). Then one challan line per pick, each tied
  to its sales order line. The challan's own refusals (`lines.3.quantity`) go through `onPicks()` to the dialog's paths
  (`lines.0.picks.1.quantity`), so "Not enough stock here" shows under the batch that asked for too much.
- `saveDelivery()` writes the customer's saved address or none; the shopper's typed address is put on the draft
  before it is posted, like the API's `postForShopOrder`.

### The rules: Shipped, Delivered, Cancel and the settings box

```ts
// ---------------------------------------------------------------------------------------------
// Shipped, Delivered, Cancel (decisions 6 to 8)

export function shipShopOrder(
  data: WorkspaceData,
  id: string,
  version: number,
  at: string = now(),
): MockShopOrder {
  const order = lockShopOrder(data, id, version);
  if (order.status !== 'packed') throw stepInvalid();
  move(order, 'shipped', at);
  return order;
}

// A posted invoice for what the challan took, at the sales order's prices, and the delivery
// charge after it; dated that day and unpaid (the rider's cash is a money receipt)
export function deliverShopOrder(
  data: WorkspaceData,
  id: string,
  version: number,
  at: string = now(),
): { order: MockShopOrder; invoiceId: string } {
  const order = lockShopOrder(data, id, version);
  if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
  const salesOrder = salesOrderOf(data, order);
  const challan = findDelivery(data, order.deliveryId);
  const branchId = branchOf(data, salesOrder.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${salesOrder.warehouseId} has no branch`);
  const goods = challan.lines.map((line) => {
    const soLine = salesOrder.lines.find((item) => item.id === line.orderLineId);
    if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
    return {
      variantId: line.variantId,
      unitId: line.unitId,
      quantity: line.quantity,
      description: soLine.description,
      unitPrice: soLine.unitPrice,
      discountType: 'amount' as const,
      discount: '0',
      taxRateId: soLine.taxRate.id,
      deliveryLineId: line.id,
      orderLineId: null,
      batchId: null,
      serialNumbers: [],
    };
  });
  const charges = salesOrder.lines.slice(order.lines.length).map((soLine) => ({
    variantId: soLine.variantId,
    unitId: soLine.unitId,
    quantity: soLine.quantity,
    description: soLine.description,
    unitPrice: soLine.unitPrice,
    discountType: 'amount' as const,
    discount: '0',
    taxRateId: soLine.taxRate.id,
    deliveryLineId: null,
    orderLineId: soLine.id,
    batchId: null,
    serialNumbers: [],
  }));
  const draft = saveInvoice(data, {
    customerId: salesOrder.customer.id,
    date: dayOf(data, at),
    note: null,
    lines: [...goods, ...charges],
    dueDate: null,
    customerReference: order.orderNo,
    branchId,
    warehouseId: null,
  });
  // Never over the limit: it moves the amount from "on order" to "owed" and adds nothing
  postInvoice(data, draft, false);
  move(order, 'delivered', at, { invoiceId: draft.id });
  return { order, invoiceId: draft.id };
}

export interface CancelledShopOrder {
  order: MockShopOrder;
  salesReturnId: string | null;
  salesOrderId: string | null;
}

// A new order's sales order is cancelled (its hold ends with it); a packed one's goods come back
// on a posted sales return of the whole challan first, which opens its sales order again, and then
// the sales order is cancelled. The SMS to the shopper is the API's: the mock sends none
export function cancelShopOrder(
  data: WorkspaceData,
  id: string,
  input: { version: number; reason: string | null },
  at: string = now(),
): CancelledShopOrder {
  const order = lockShopOrder(data, id, input.version);
  if (order.status !== 'confirmed' && order.status !== 'packed') throw stepInvalid();
  let salesReturnId: string | null = null;
  if (order.status === 'packed') {
    if (order.deliveryId === null) throw stepInvalid();
    const challan = findDelivery(data, order.deliveryId);
    const draft = saveReturn(data, {
      customerId: challan.customer.id,
      date: dayOf(data, at),
      warehouseId: challan.warehouseId,
      // The return's reasons have no "order cancelled"; the shop order's page says why
      reason: 'other',
      note: null,
      lines: challan.lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        deliveryLineId: line.id,
      })),
    });
    postReturn(data, draft);
    salesReturnId = draft.id;
  }
  const salesOrder = order.salesOrderId === null ? undefined : findOrder(data, order.salesOrderId);
  if (salesOrder) changeOrderStatus(data, salesOrder, 'cancel');
  move(order, 'cancelled', at, { cancelReason: input.reason, salesReturnId });
  return { order, salesReturnId, salesOrderId: salesOrder?.id ?? null };
}

// ---------------------------------------------------------------------------------------------
// Shop settings' delivery charge service (decision 17, settings.service.ts)

// What the select offers: the active services by name, and the saved one even when archived
export function deliveryChoicesOf(data: WorkspaceData): StorefrontSetup['deliveryChoices'] {
  const saved = data.storefront.shop?.deliveryVariantId ?? null;
  return data.catalog.products
    .flatMap((product) => product.variants.map((variant) => ({ product, variant })))
    .filter(
      ({ product, variant }) =>
        variant.id === saved ||
        (product.type === 'service' && product.archivedAt === null && variant.archivedAt === null),
    )
    .toSorted(
      (a, b) =>
        a.product.name.toLowerCase().localeCompare(b.product.name.toLowerCase()) ||
        a.variant.sku.localeCompare(b.variant.sku),
    )
    .slice(0, 200)
    .map(({ product, variant }) => ({
      variantId: variant.id,
      name:
        variant.optionValues.length === 0
          ? product.name
          : `${product.name} — ${variant.optionValues.join(', ')}`,
      sku: variant.sku,
    }));
}

// A new choice must be an active service; the saved one is kept even if archived since. Emptied
// again: refused once a shop order's sales order has a line of the saved one
export function checkDeliveryService(data: WorkspaceData, variantId: string | null): void {
  const saved = data.storefront.shop?.deliveryVariantId ?? null;
  const problem = (code: ErrorCode) => new MockProblem(409, code, { deliveryVariantId: [code] });
  if (variantId === null) {
    if (saved === null) return;
    const used = data.storefront.orders.some((order) =>
      data.salesDocuments.orders.some(
        (salesOrder) =>
          salesOrder.id === order.salesOrderId &&
          salesOrder.lines.some((line) => line.variantId === saved),
      ),
    );
    if (used) throw problem('storefront_delivery_product_required');
    return;
  }
  const found = findVariant(data, variantId);
  if (!found) throw problem('storefront_delivery_product_invalid');
  const archived = found.product.archivedAt !== null || found.variant.archivedAt !== null;
  if (variantId !== saved && (found.product.type !== 'service' || archived)) {
    throw problem('storefront_delivery_product_invalid');
  }
}
```

- `deliverShopOrder()` bills each challan line at its sales order line's price and VAT rate, then the sales order's
  lines after the order's own: the delivery charge. `postInvoice(…, false)` never overrides a limit, for the API's
  reason: the invoice moves an amount from "on order" to "owed" and adds nothing.
- `cancelShopOrder()` on a packed order posts the return first. The mock's `postReturn()` reopens the sales order
  (15d: a return before the invoice), so `changeOrderStatus(…, 'cancel')` then finds a confirmed order with nothing
  delivered, the same path as the API's `cancelIn()`.
- `deliveryChoicesOf()` and `checkDeliveryService()` are the API's `deliveryChoices()` and `checkDelivery()`: active
  services by name, the saved one kept even when archived, and an empty box refused once a shop order's sales order
  bills the saved service.

### The seed

```ts
// ---------------------------------------------------------------------------------------------
// The seed

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function money(value: string): string {
  return addMoney(value, '0');
}

interface OrderSpec {
  name: string;
  phone: string;
  address: string;
  zone: ShopDeliveryZone;
  lines: { listing: MockListing; quantity: number }[];
  // Minutes ago the code confirmed it; the shopper placed it two minutes before
  confirmed: number;
}

// The shop's price now (the listing's own, or the variant's, less a running sale)
function priceOf(data: WorkspaceData, listing: MockListing): string {
  const variant = findVariant(data, listing.variantId)?.variant;
  const regular = listing.priceOverride ?? variant?.salePrice ?? '0';
  return money(listingPricing(regular, listing.sale, new Date()).price);
}

function placeOrder(
  data: WorkspaceData,
  number: number,
  spec: OrderSpec,
  warehouseId: string,
): MockShopOrder {
  const shop = data.storefront.shop;
  const lines = spec.lines.map(({ listing, quantity }, index) => {
    const unitPrice = priceOf(data, listing);
    return {
      position: index + 1,
      listingId: listing.id,
      name: listing.name,
      packSize: listing.packSize,
      image: listing.images[0] ?? null,
      productId: listing.productId,
      variantId: listing.variantId,
      quantity,
      unitPrice,
      lineTotal: multiplyMoney(String(quantity), unitPrice),
    };
  });
  const subtotal = sumMoney(lines.map((line) => line.lineTotal));
  // Free from the shop's threshold, else the zone's charge
  const free =
    shop?.freeDeliveryFrom !== null &&
    shop?.freeDeliveryFrom !== undefined &&
    compareMoney(subtotal, shop.freeDeliveryFrom) >= 0;
  const deliveryCharge = free ? '0.0000' : money(spec.zone.charge);
  const confirmed = minutesAgo(spec.confirmed);
  const order: MockShopOrder = {
    id: crypto.randomUUID(),
    orderNo: `W-${String(number).padStart(6, '0')}`,
    status: 'confirmed',
    history: [
      { status: 'pending', at: minutesAgo(spec.confirmed + 2) },
      { status: 'confirmed', at: confirmed },
    ],
    customerName: spec.name,
    phone: spec.phone,
    address: spec.address,
    zoneName: spec.zone.name,
    paymentMethod: 'cod',
    lines,
    subtotal,
    discount: '0.0000',
    couponCode: null,
    deliveryCharge,
    total: money(sumMoney([subtotal, deliveryCharge])),
    warehouseId,
    cancelReason: null,
    salesOrderId: null,
    deliveryId: null,
    invoiceId: null,
    salesReturnId: null,
    documentError: null,
    version: 1,
    updatedAt: confirmed,
  };
  data.storefront.orders.unshift(order);
  return order;
}

// Packed with what the plan suggests: FEFO for a batch line, the first serial numbers in stock for
// a serial one (the seed's packer scans those)
function packAsPlanned(data: WorkspaceData, order: MockShopOrder, at: string): void {
  const plan = packPlanOf(data, order.id);
  packShopOrder(
    data,
    order.id,
    {
      version: order.version,
      lines: plan.lines.map((line, index) => {
        const variantId = order.lines[index]?.variantId ?? '';
        const serials = [...data.stock.serials.entries()]
          .filter(([key, place]) => key.startsWith(`${variantId}|`) && place === order.warehouseId)
          .map(([key]) => key.slice(variantId.length + 1))
          .slice(0, Number(line.quantity));
        return {
          position: line.position,
          picks:
            line.tracking === 'serial'
              ? [{ batchId: null, quantity: line.quantity, serialNumbers: serials }]
              : line.picks,
        };
      }),
    },
    at,
  );
}

// Two accessories the shop sells beside its garments, so the Packed dialog has a batch line (an
// attar's lots, with their expiry) and a serial line (a watch's case numbers)
function seedAccessories(data: WorkspaceData, warehouseId: string): MockListing[] {
  const pcs = data.catalog.units.find((unit) => unit.code === 'pcs');
  if (!pcs) return [];
  const accessory = (code: string, name: string, price: string, tracking: 'batch' | 'serial') => {
    const product = saveProduct(
      data.catalog,
      productInputSchema.parse({
        code,
        name,
        type: 'goods',
        categoryId: '',
        description: '',
        baseUnitId: pcs.id,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking,
        hasExpiry: tracking === 'batch',
        taxRateId: '',
        options: [],
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: price, archived: false },
        ],
        units: [],
        customFields: {},
      }),
    );
    data.catalog.products.push(product);
    return product;
  };
  const attar = accessory('ACC-ATTAR', 'Oud attar 6 ml', '650', 'batch');
  const watch = accessory('ACC-WATCH', 'Steel analog wristwatch', '3450', 'serial');
  const [attarVariant] = attar.variants;
  const [watchVariant] = watch.variants;
  if (!attarVariant || !watchVariant) return [];
  const today = todayIn(data.settings.timezone);
  const inDays = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const line = {
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
  };
  // The later lot came in first: FEFO still takes AT-2408 first, because it expires first
  postAdjustment(
    data,
    saveAdjustment(data, {
      date: inDays(-12),
      warehouseId,
      direction: 'in',
      reason: 'opening',
      note: null,
      lines: [
        {
          ...line,
          variantId: attarVariant.id,
          unitId: pcs.id,
          quantity: '10',
          lotNumber: 'AT-2411',
          expiresOn: inDays(200),
          unitCost: '380',
        },
        {
          ...line,
          variantId: attarVariant.id,
          unitId: pcs.id,
          quantity: '2',
          lotNumber: 'AT-2408',
          expiresOn: inDays(80),
          unitCost: '380',
        },
        {
          ...line,
          variantId: watchVariant.id,
          unitId: pcs.id,
          quantity: '4',
          unitCost: '2100',
          serialNumbers: ['SW-7781', 'SW-7782', 'SW-7783', 'SW-7784'],
        },
      ],
    }),
  );
  const category: MockCategory = {
    id: crypto.randomUUID(),
    parentId: null,
    slug: 'accessories',
    name: 'Accessories',
    position: 4,
    version: 1,
    updatedAt: minutesAgo(60 * 24 * 12),
  };
  data.storefront.categories.push(category);
  const listing = (
    product: typeof attar,
    variantId: string,
    packSize: string,
    colour: string,
  ): MockListing => {
    const item: MockListing = {
      id: crypto.randomUUID(),
      productId: product.id,
      variantId,
      categoryId: category.id,
      slug: product.code.toLowerCase(),
      name: product.name,
      packSize,
      priceOverride: null,
      sale: null,
      badges: [],
      images: [seedPhoto(data, product.name, colour, product.name)],
      descriptionSections: [],
      seoTitle: null,
      seoDescription: null,
      publishedAt: minutesAgo(60 * 24 * 12),
      version: 2,
      updatedAt: minutesAgo(60 * 24 * 12),
    };
    data.storefront.listings.push(item);
    return item;
  };
  return [
    listing(attar, attarVariant.id, '6 ml', '#8B471F'),
    listing(watch, watchVariant.id, '40 mm case', '#475467'),
  ];
}

// Rahman Fashion's orders: one delivered (its invoice waits for the rider's cash), one cancelled
// before packing, one on its way, one packed, and three new ones. Of the new ones, W-000005 has a
// line of each kind for the Packed dialog (a batch, a serial, an untracked polo), W-000006 is a
// small one to cancel, and W-000007's sales order was refused when it was confirmed (the T-shirt
// was archived for a moment); it is active again, so "Make the sales order" works. Farhana Islam
// ordered twice: one customer in the ERP
export function seedShopOrders(data: WorkspaceData): void {
  const shop = data.storefront.shop;
  const warehouseId = shop?.defaultWarehouseId ?? null;
  const [inside, outside] = shop?.deliveryZones ?? [];
  if (shop === null || warehouseId === null || !inside || !outside) return;
  const [attar, watch] = seedAccessories(data, warehouseId);
  const bySlug = (slug: string) => data.storefront.listings.find((item) => item.slug === slug);
  const poloM = bySlug('pique-polo-navy-m');
  const poloL = bySlug('pique-polo-navy-l');
  const tee = bySlug('basic-crew-neck-t-shirt');
  if (!attar || !watch || !poloM || !poloL || !tee) return;

  const farhana = {
    name: 'Farhana Islam',
    phone: '01711223344',
    address: 'House 7, Road 3, Dhanmondi, Dhaka 1205',
  };
  const hours = (count: number) => count * 60;
  const days = (count: number) => count * 24 * 60;
  const specs: OrderSpec[] = [
    { ...farhana, zone: inside, lines: [{ listing: poloM, quantity: 2 }], confirmed: days(9) },
    {
      name: 'Sabbir Hossain',
      phone: '01819556677',
      address: 'Flat 4B, Block C, Mirpur 10, Dhaka 1216',
      zone: inside,
      lines: [{ listing: tee, quantity: 1 }],
      confirmed: days(7),
    },
    {
      name: 'Tanvir Ahmed',
      phone: '01913445566',
      address: 'Road 5, Agrabad C/A, Chattogram 4100',
      zone: outside,
      lines: [
        { listing: poloL, quantity: 1 },
        { listing: tee, quantity: 2 },
      ],
      confirmed: days(2),
    },
    {
      name: 'Mitu Akter',
      phone: '01552334455',
      address: 'House 12, Sector 7, Uttara, Dhaka 1230',
      zone: inside,
      lines: [{ listing: tee, quantity: 3 }],
      confirmed: days(1),
    },
    {
      ...farhana,
      zone: inside,
      lines: [
        { listing: attar, quantity: 3 },
        { listing: watch, quantity: 1 },
        { listing: poloM, quantity: 2 },
      ],
      confirmed: hours(3),
    },
    {
      name: 'Rakib Hasan',
      phone: '01611889900',
      address: 'Lane 2, Khulshi, Chattogram 4209',
      zone: outside,
      lines: [{ listing: poloL, quantity: 1 }],
      confirmed: 50,
    },
    {
      name: 'Shirin Sultana',
      phone: '01712990011',
      address: 'Block D, Road 8, Bashundhara R/A, Dhaka 1229',
      zone: inside,
      lines: [{ listing: tee, quantity: 2 }],
      confirmed: 20,
    },
  ];
  const orders = specs.map((spec, index) => placeOrder(data, index + 1, spec, warehouseId));
  const [delivered, cancelled, shipped, packed, , , refused] = orders;
  if (!delivered || !cancelled || !shipped || !packed || !refused) return;
  // The handler made each sales order when the code confirmed the order, except W-000007's
  for (const order of orders) {
    if (order === refused) continue;
    makeShopSalesOrder(data, order, confirmedAt(order));
  }
  refused.documentError = 'sales_item_invalid';
  const after = (order: MockShopOrder, minutes: number) =>
    new Date(Date.parse(confirmedAt(order)) + minutes * 60_000).toISOString();

  packAsPlanned(data, delivered, after(delivered, 90));
  shipShopOrder(data, delivered.id, delivered.version, after(delivered, 180));
  deliverShopOrder(data, delivered.id, delivered.version, after(delivered, days(1)));
  cancelShopOrder(
    data,
    cancelled.id,
    { version: cancelled.version, reason: 'The shopper did not answer the phone' },
    after(cancelled, 45),
  );
  packAsPlanned(data, shipped, after(shipped, 120));
  shipShopOrder(data, shipped.id, shipped.version, after(shipped, 240));
  packAsPlanned(data, packed, after(packed, 200));

  // The bell of the newest order that is not refused, unread (27a's handler rings it)
  const newest = orders[5];
  if (newest) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'storefront.order_confirmed',
      params: { id: newest.id, number: newest.orderNo, total: newest.total },
      readAt: null,
      createdAt: confirmedAt(newest),
    });
  }
}
```

- `placeOrder()` prices each line at the listing's price now and works out the delivery charge as the shop's checkout
  does: free from the shop's threshold (৳2,000 here), else the zone's charge. W-000005 (৳6,570) is free; the others pay.
- The seed moves the orders with the same functions the routes use, at moments in the past, so the seeded documents
  went through every rule a clicked one does. `packAsPlanned()` packs with the plan's own picks, and for a serial
  line the first serial numbers in that warehouse.
- `seedAccessories()` is decision 50. The two products have codes outside the P-… series, so the next product made in
  a test is still P-00006.
- The bell is the newest order that was not refused (W-000006), unread, with the API's params (`id`, `number`,
  `total`). It is what 27a's handler rings.

### The settings box and the order book's wiring

```diff
@@ -36,6 +36,7 @@ import type { Workspace } from './fixtures';
 import { MockProblem } from './mock';
 import { pageOf } from './sales-document-data';
 import { balancesOf, findVariant } from './stock-data';
+import { checkDeliveryService, deliveryChoicesOf } from './storefront-order-data';
 import {
   type MockCategory,
   type MockListing,
@@ -128,8 +129,8 @@ export function setupOf(data: WorkspaceData, workspace: Workspace): StorefrontSe
       hotline: data.settings.phone ?? '',
       address: data.settings.address ?? '',
     },
-    // Step 27b: none to pick until 27b.7 lists the services
-    deliveryChoices: [],
+    // Step 27b: the services the delivery charge may be billed as (storefront-order-data.ts)
+    deliveryChoices: deliveryChoicesOf(data),
   };
 }
 
@@ -164,7 +165,7 @@ function fieldsOf(input: CreateStorefrontSettingsInput, before: readonly ShopDel
     freeDeliveryFrom: input.freeDeliveryFrom === null ? null : money(input.freeDeliveryFrom),
     minimumOrder: input.minimumOrder === null ? null : money(input.minimumOrder),
     paymentMethods: input.paymentMethods,
-    // Step 27b: kept as sent until 27b.7 brings the API's checks
+    // Step 27b: checked by checkDeliveryService() before it is kept
     deliveryVariantId: input.deliveryVariantId,
   };
 }
@@ -186,6 +187,7 @@ function settingsSnapshot(shop: MockShop) {
     freeDeliveryFrom: shop.freeDeliveryFrom,
     minimumOrder: shop.minimumOrder,
     paymentMethods: shop.paymentMethods.join(', '),
+    deliveryVariantId: shop.deliveryVariantId,
   };
 }
 
@@ -207,6 +209,7 @@ export function createShop(
   if (data.storefront.shop !== null) throw new MockProblem(409, 'storefront_set_up_already');
   assertWarehouse(data, input.defaultWarehouseId);
   assertSubdomainFree(input.subdomain);
+  checkDeliveryService(data, input.deliveryVariantId);
   const shop: MockShop = {
     ...fieldsOf(input, []),
     launchedAt: null,
@@ -238,6 +241,7 @@ export function updateShop(
     assertWarehouse(data, input.defaultWarehouseId);
   }
   if (input.subdomain !== before.subdomain) assertSubdomainFree(input.subdomain);
+  checkDeliveryService(data, input.deliveryVariantId);
   const after: MockShop = {
     ...before,
     ...fieldsOf(input, before.deliveryZones),
```

The choices come from the order file, and both saves run `checkDeliveryService()` before anything is kept. The audit's
snapshot gets `deliveryVariantId`, like the API's, so the audit log names the change (27b.5's word "Delivery charge's
service").

```diff
@@ -92,6 +92,20 @@ export function seedsVatMonth(): boolean {
   }
 }
 
+// Step 27b: Rahman Fashion's shop orders (storefront-order-data.ts). They make sales orders,
+// challans, an invoice and customers, and two accessories with their stock, which would change the
+// numbers and the lists the other e2e tests read. A test asks for them with
+// test.use({ shopOrders: true }); `pnpm dev:mock` has no key and gets them.
+export const MOCK_NO_SHOP_ORDERS_KEY = 'omnivo.mock.noShopOrders';
+
+export function seedsShopOrders(): boolean {
+  try {
+    return localStorage.getItem(MOCK_NO_SHOP_ORDERS_KEY) === null;
+  } catch {
+    return true;
+  }
+}
+
 export function meIn(
   workspace: Workspace,
   companyName: string,
```

```diff
@@ -36,7 +36,14 @@ import {
   type MockDocumentOutput,
   seedDocumentOutput,
 } from './document-output-data';
-import { HEAD_OFFICES, OWNER, seedsTradeHistory, seedsVatMonth, type Workspace } from './fixtures';
+import {
+  HEAD_OFFICES,
+  OWNER,
+  seedsShopOrders,
+  seedsTradeHistory,
+  seedsVatMonth,
+  type Workspace,
+} from './fixtures';
 import { emptyBilling, type MockBilling } from './invoice-data';
 import { emptyJournal, type MockJournal, seedJournal } from './journal-data';
 import { MockProblem } from './mock';
@@ -57,6 +64,7 @@ import {
   seedSalesDocuments,
 } from './sales-document-data';
 import { emptyStock, type MockStock, seedStock, warehouse } from './stock-data';
+import { seedShopOrders } from './storefront-order-data';
 import { emptyStorefront, type MockStorefront, seedStorefront } from './storefront-seed';
 import { emptySuppliers, type MockSuppliers, seedSuppliers } from './supplier-data';
 import { emptySync, type MockSync, seedDevices } from './sync-data';
@@ -239,6 +247,8 @@ function seed(workspace: Workspace): WorkspaceData {
   if (garments) seedReportSchedules(data);
   // Step 26g: after the stock (the shop counts in the Main store) and the catalog it lists from
   seedStorefront(data, garments);
+  // Step 27b: after the shop it sells from (storefront-order-data.ts, fixtures.ts → seedsShopOrders)
+  if (garments && seedsShopOrders()) seedShopOrders(data);
   record(data, 'workspace.created', 'workspace', workspace.tenantId, {
     name: { from: null, to: workspace.name },
   });
```

Decision 49. The seed runs last, after the shop it sells from, and only in the garments workspace: the pharma one has
no shop until a test sets one up.

### The nine routes

```diff
@@ -3,12 +3,14 @@ import {
   accountTypeFits,
   addQuantity,
   APPROVAL_DOCUMENTS,
+  type AuditAction,
   type AuthSession,
   compareQuantity,
   dashboardCardsFor,
   type ErrorCode,
   isCostSort,
   isStockValueSort,
+  type PermissionKey,
   type Preferences,
   type ProductCategory,
   routes,
@@ -207,6 +209,19 @@ import {
   updateCollection,
   updateTheme,
 } from './storefront-appearance-data';
+import {
+  cancelShopOrder,
+  deliverShopOrder,
+  findShopOrder,
+  type MadeSalesOrder,
+  packPlanOf,
+  packShopOrder,
+  retrySalesOrder,
+  shipShopOrder,
+  shopOrderCounts,
+  shopOrderPage,
+  toShopOrder,
+} from './storefront-order-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -485,6 +500,71 @@ function shopData(): WorkspaceData {
   return current();
 }
 
+// Step 27b: the Shop orders' routes ask for their own permission, as the API's guard does:
+// storefront.order.read to read, storefront.order.manage for every move (decision 9). A packer
+// with these two alone has no storefront.manage
+function shopOrderData(permission: PermissionKey): WorkspaceData {
+  if (!me().permissions.includes(permission)) {
+    throw new MockProblem(403, 'permission_missing');
+  }
+  return current();
+}
+
+// The audit row of a move (the API's move()): the shop's number, the status before and after, and
+// the reason a member typed when cancelling
+function recordShopMove(
+  data: WorkspaceData,
+  action: AuditAction,
+  order: { id: string; orderNo: string; status: string; cancelReason: string | null },
+  before: string,
+): void {
+  record(
+    data,
+    action,
+    'storefront_order',
+    order.id,
+    diff(
+      { order: order.orderNo, status: before },
+      {
+        order: order.orderNo,
+        status: order.status,
+        ...(action === 'storefront_order.cancelled' && { reason: order.cancelReason }),
+      },
+    ),
+  );
+}
+
+// What making a shop order's sales order writes in the audit log: the customer and the "Delivery
+// charge" service when they were made, the sales order, the credit override, and the link
+function recordSalesOrderMade(
+  data: WorkspaceData,
+  order: { id: string; orderNo: string },
+  made: MadeSalesOrder,
+): void {
+  if (made.customerMade) record(data, 'customer.created', 'customer', made.customerId);
+  if (made.deliveryProductId !== null) {
+    record(data, 'product.created', 'product', made.deliveryProductId);
+  }
+  record(data, 'sales_order.created', 'sales_order', made.salesOrder.id);
+  record(data, 'sales_order.confirmed', 'sales_order', made.salesOrder.id);
+  if (made.overridden) {
+    record(
+      data,
+      'credit_limit.overridden',
+      'sales_order',
+      made.salesOrder.id,
+      diff({}, made.overridden),
+    );
+  }
+  record(
+    data,
+    'storefront_order.sales_order_made',
+    'storefront_order',
+    order.id,
+    diff({}, { order: order.orderNo }),
+  );
+}
+
 // audit-এর "আগের মান" — ফর্মের ঘরগুলো
 function editable(settings: Settings) {
   return {
@@ -6026,4 +6106,121 @@ export const handlers = [
       return reply(routes.storefrontAppearance.deletePage, undefined);
     }),
   ),
+
+  // --- Step 27b: Shop orders (storefront-order-data.ts) ----------------------------------------
+  // Every move runs in transaction(): a document the mock refuses (stock_insufficient on a batch)
+  // leaves no number used and no stock moved, like the API's transaction
+
+  mock(
+    routes.storefrontOrders.listOrders,
+    guarded(async ({ request }) => {
+      const data = shopOrderData(routes.storefrontOrders.listOrders.permission);
+      const query = readQuery(routes.storefrontOrders.listOrders.query, request);
+      await delay();
+      return reply(routes.storefrontOrders.listOrders, shopOrderPage(data, query));
+    }),
+  ),
+
+  // Before /:id, like the API's controller: "counts" is not an id
+  mock(
+    routes.storefrontOrders.countOrders,
+    guarded(() => {
+      const data = shopOrderData(routes.storefrontOrders.countOrders.permission);
+      return reply(routes.storefrontOrders.countOrders, shopOrderCounts(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.getOrder,
+    guarded(async ({ params }) => {
+      const data = shopOrderData(routes.storefrontOrders.getOrder.permission);
+      const { id } = routes.storefrontOrders.getOrder.params.parse(params);
+      await delay();
+      return reply(routes.storefrontOrders.getOrder, toShopOrder(data, findShopOrder(data, id)));
+    }),
+  ),
+
+  // Not in transaction(): a refusal is kept on the order (its documentError) and still answered
+  mock(
+    routes.storefrontOrders.makeSalesOrder,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.makeSalesOrder.permission);
+      const { id } = routes.storefrontOrders.makeSalesOrder.params.parse(params);
+      const { version } = await readBody(routes.storefrontOrders.makeSalesOrder.body, request);
+      const made = retrySalesOrder(data, id, version);
+      const order = findShopOrder(data, id);
+      recordSalesOrderMade(data, order, made);
+      return reply(routes.storefrontOrders.makeSalesOrder, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.getPackPlan,
+    guarded(async ({ params }) => {
+      const data = shopOrderData(routes.storefrontOrders.getPackPlan.permission);
+      const { id } = routes.storefrontOrders.getPackPlan.params.parse(params);
+      await delay();
+      return reply(routes.storefrontOrders.getPackPlan, packPlanOf(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.packOrder,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.packOrder.permission);
+      const { id } = routes.storefrontOrders.packOrder.params.parse(params);
+      const body = await readBody(routes.storefrontOrders.packOrder.body, request);
+      const { order, delivery } = transaction(data, () => packShopOrder(data, id, body));
+      record(data, 'delivery.created', 'delivery', delivery.id);
+      record(data, 'delivery.posted', 'delivery', delivery.id);
+      recordShopMove(data, 'storefront_order.packed', order, 'confirmed');
+      return reply(routes.storefrontOrders.packOrder, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.shipOrder,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.shipOrder.permission);
+      const { id } = routes.storefrontOrders.shipOrder.params.parse(params);
+      const { version } = await readBody(routes.storefrontOrders.shipOrder.body, request);
+      const order = shipShopOrder(data, id, version);
+      recordShopMove(data, 'storefront_order.shipped', order, 'packed');
+      return reply(routes.storefrontOrders.shipOrder, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.deliverOrder,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.deliverOrder.permission);
+      const { id } = routes.storefrontOrders.deliverOrder.params.parse(params);
+      const { version } = await readBody(routes.storefrontOrders.deliverOrder.body, request);
+      const { order, invoiceId } = transaction(data, () => deliverShopOrder(data, id, version));
+      record(data, 'invoice.created', 'invoice', invoiceId);
+      record(data, 'invoice.posted', 'invoice', invoiceId);
+      recordShopMove(data, 'storefront_order.delivered', order, 'shipped');
+      return reply(routes.storefrontOrders.deliverOrder, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.cancelOrder,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.cancelOrder.permission);
+      const { id } = routes.storefrontOrders.cancelOrder.params.parse(params);
+      const body = await readBody(routes.storefrontOrders.cancelOrder.body, request);
+      const before = findShopOrder(data, id).status;
+      const { order, salesReturnId, salesOrderId } = transaction(data, () =>
+        cancelShopOrder(data, id, body),
+      );
+      if (salesReturnId !== null) {
+        record(data, 'sales_return.created', 'sales_return', salesReturnId);
+        record(data, 'sales_return.posted', 'sales_return', salesReturnId);
+      }
+      if (salesOrderId !== null) record(data, 'sales_order.cancelled', 'sales_order', salesOrderId);
+      recordShopMove(data, 'storefront_order.cancelled', order, before);
+      return reply(routes.storefrontOrders.cancelOrder, toShopOrder(data, order));
+    }),
+  ),
 ];
```

- `shopOrderData()` checks the route's own permission, read from the contract (`routes.storefrontOrders.x.permission`),
  so the mock and the API's guard cannot disagree. A packer with only `storefront.order.*` passes; `shopData()` (the
  shop's own pages) would refuse them.
- `countOrders` comes before `getOrder`, like the API's controller: MSW matches in order, and "counts" would otherwise
  be read as an order's id.
- Pack, Delivered and Cancel run in `transaction()`. A refused challan (not enough of a batch) leaves no number used
  and no stock moved, so the packer can fix the pick and press again.
- `recordShopMove()` writes the API's row: the order's number and the status before and after, and the reason on a
  cancel. `recordSalesOrderMade()` writes the rows the API's maker and services write, in their order.

### Two screen fixes

```diff
@@ -308,7 +308,8 @@ function PackLine({
             </Button>
             <Count complete={complete}>
               {t('storefront.order.packing.picked', {
-                picked: quantityText(picked),
+                // The unit once, after the line's quantity: "2 of 3 pcs picked"
+                picked: format.number(picked, decimalsOf(picked)),
                 quantity: needed,
               })}
             </Count>
```

Decision 55. `quantity` already ends in the unit, so `picked` is the number alone.

```diff
@@ -138,7 +138,8 @@ export function StorefrontOrdersPage() {
         column.accessor('paymentMethod', {
           header: t('storefront.orders.columns.payment'),
           enableSorting: false,
-          meta: { card: 'detail' },
+          // No meta.card, so not on a phone's card: every order is Cash on Delivery until step 27c
+          // brings online payment, and the line would say the same on every card (27b.7)
           cell: ({ getValue }) => (
             <span className="text-ink-2">{t(`storefront.payments.${getValue()}`)}</span>
           ),
```

Decision 56. A column without `meta.card` stays in the desktop table and leaves the phone card.

### The browser tests

```diff
@@ -7,6 +7,7 @@ import { test as base, expect, type Locator, type Page, type Response } from '@p
 import {
   HEAD_OFFICES,
   MOCK_NO_HISTORY_KEY,
+  MOCK_NO_SHOP_ORDERS_KEY,
   MOCK_NO_VAT_MONTH_KEY,
   MOCK_ROLE_KEY,
   type MockRole,
@@ -60,6 +61,7 @@ export const test = base.extend<{
   answerPinDialog: boolean;
   tradeHistory: boolean;
   vatMonth: boolean;
+  shopOrders: boolean;
 }>({
   seedDevice: [true, { option: true }],
   answerPinDialog: [true, { option: true }],
@@ -67,8 +69,13 @@ export const test = base.extend<{
   tradeHistory: [false, { option: true }],
   // Step 21c: last month's documents with VAT (fixtures.ts → MOCK_NO_VAT_MONTH_KEY)
   vatMonth: [false, { option: true }],
+  // Step 27b: Rahman Fashion's shop orders (fixtures.ts → MOCK_NO_SHOP_ORDERS_KEY)
+  shopOrders: [false, { option: true }],
   // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
-  page: async ({ page, seedDevice, answerPinDialog, tradeHistory, vatMonth }, provide) => {
+  page: async (
+    { page, seedDevice, answerPinDialog, tradeHistory, vatMonth, shopOrders },
+    provide,
+  ) => {
     copies.set(page, copyOf(page));
     if (!tradeHistory) {
       await page.addInitScript((key) => {
@@ -80,6 +87,11 @@ export const test = base.extend<{
         localStorage.setItem(key, '1');
       }, MOCK_NO_VAT_MONTH_KEY);
     }
+    if (!shopOrders) {
+      await page.addInitScript((key) => {
+        localStorage.setItem(key, '1');
+      }, MOCK_NO_SHOP_ORDERS_KEY);
+    }
     if (answerPinDialog) {
       // A new seeded device always asks once; without the seed the branch dialog comes first
       if (seedDevice) pinWaiting.add(page);
```

The option is off by default, so every older test runs as before, and the key is left before the app starts.

```ts
import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  pinAnswered,
  test,
  toastShown,
} from './helpers.js';

// Step 27b: the shop's orders in the ERP, on the mock (mocks/storefront-order-data.ts). Rahman
// Fashion's orders: W-000001 delivered, W-000002 cancelled, W-000003 shipped, W-000004 packed, and
// three new ones: W-000005 (an attar of two lots, a watch by its serial number, two polos),
// W-000006, and W-000007 whose sales order was refused when it was confirmed. They are seeded only
// when a test asks (they make sales orders, challans and customers the other tests would see).
test.use({ shopOrders: true });

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await openFromNav(page, 'Shop orders');
}

// The list's tabs are a segmented control ("Show"): its radios are hidden, their words are the
// labels. Inside the control: "New" is a status pill in the table too
async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openOrder(page: Page, number: string): Promise<void> {
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// A row of the order's Documents card: the kind, then the number as a link (or when it comes)
function documentRow(page: Page, kind: string) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Documents' }) })
    .getByRole('listitem')
    .filter({ hasText: kind });
}

async function backToList(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Shop orders' })).toBeVisible();
}

test('lists the orders by tab and finds them by number, name or phone', async ({ page }) => {
  await start(page);
  // Three wait to be packed: the sidebar says so
  await expect(
    page.getByRole('navigation').getByRole('link', { name: /Shop orders/ }),
  ).toContainText('3');

  // New first, the newest confirmed on top; the refused one says so
  await expect(listItem(page, /W-00000[567]/)).toHaveCount(3);
  await expect(listItem(page, /W-000007/)).toContainText('Needs attention');
  await expect(listItem(page, /W-000005/)).toContainText('6 items');
  await expectNoSideScroll(page);

  await showTab(page, 'Packed');
  await expect(page).toHaveURL(/view=packed/);
  await expect(listItem(page, /W-00000/)).toHaveCount(1);
  await expect(listItem(page, /W-000004/)).toContainText('Mitu Akter');

  await showTab(page, 'Delivered');
  await expect(listItem(page, /W-000001/)).toContainText('Delivered');

  // The search looks in the tab only, and offers every order
  await page.getByLabel('Search the orders').fill('farhana');
  await expect(listItem(page, /W-00000/)).toHaveCount(1);
  await showTab(page, 'All');
  await expect(listItem(page, /W-00000/)).toHaveCount(2);
  // A phone typed with a space finds the 11 digits the shop keeps
  await page.getByLabel('Search the orders').fill('01711 223344');
  await expect(listItem(page, /W-00000/)).toHaveCount(2);

  await showTab(page, 'New');
  await page.getByLabel('Search the orders').fill('W-000004');
  await expect(page.getByText('No order matches')).toBeVisible();
  await page.getByRole('button', { name: 'Search every order' }).click();
  await expect(listItem(page, /W-000004/)).toBeVisible();

  await page.getByLabel('Search the orders').fill('');
  await showTab(page, 'Cancelled');
  await openOrder(page, 'W-000002');
  // A cancelled order shows what it made, and why it ended; no step is left to press
  await expect(page.getByText('Why: The shopper did not answer the phone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await expect(page.getByText('When it is packed')).toHaveCount(0);
  await expectNoSideScroll(page);
});

test('packs an order by batch and serial number, then ships and delivers it', async ({ page }) => {
  // Four moves and the challan's own page
  test.slow();
  await start(page);
  await openOrder(page, 'W-000005');
  await expect(page.getByText(/^Pack the goods, then mark it packed\./)).toBeVisible();
  // Farhana Islam's second order: the phone found her customer
  await expect(page.getByRole('link', { name: 'Farhana Islam' })).toBeVisible();
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Mark packed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pack W-000005' });
  await expect(
    dialog.getByText(/^The challan takes these goods out of Main store\./),
  ).toBeVisible();

  // The attar's lots by expiry, not by arrival: AT-2408 came in second but expires first, and
  // holds only 2 of the 3
  const attar = dialog.getByRole('region', { name: /Oud attar 6 ml/ });
  await expect(attar.getByLabel('Batch 1', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2408/,
  );
  await expect(attar.getByLabel('Quantity 1')).toHaveValue('2');
  await expect(attar.getByLabel('Batch 2', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2411/,
  );
  await expect(attar.getByLabel('Quantity 2')).toHaveValue('1');
  await expect(attar.getByText('3 of 3 pcs picked')).toBeVisible();
  const polo = dialog.getByRole('region', { name: /Pique polo shirt · Navy blue · M/ });
  await expect(polo.getByText('No batch or serial number to pick.')).toBeVisible();

  // All 3 from the first lot: the challan's stock check says no, under that batch's quantity
  await attar.getByRole('button', { name: 'Remove batch 2' }).click();
  await attar.getByLabel('Quantity 1').fill('3');
  const watch = dialog.getByRole('region', { name: /Steel analog wristwatch/ });
  await watch.getByLabel('Serial numbers').fill('SW-7782');
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  await expect(
    attar.getByText('Not enough stock here. Lower the quantity or pick another batch.'),
  ).toBeVisible();

  await attar.getByLabel('Quantity 1').fill('2');
  await attar.getByRole('button', { name: 'Add another batch' }).click();
  // The options: "Pick a batch", then the lots by expiry. The option's words carry a date that
  // moves with today, so by place: AT-2411 is the second lot
  await attar.getByLabel('Batch 2', { exact: true }).selectOption({ index: 2 });
  await expect(attar.getByLabel('Batch 2', { exact: true }).locator('option:checked')).toHaveText(
    /^AT-2411/,
  );
  await attar.getByLabel('Quantity 2').fill('1');
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  await toastShown(page, /^W-000005 packed\. Challan .+ posted\.$/);
  await expect(page.getByText(/^Mark it shipped when the parcel leaves the shop\./)).toBeVisible();

  // The challan is a real one: its lines took the batches and the serial number picked
  const challan = documentRow(page, 'Challan').getByRole('link');
  const challanNumber = (await challan.textContent()) ?? '';
  await challan.click();
  await expect(page.getByRole('heading', { level: 1, name: challanNumber })).toBeVisible();
  await expect(page.getByText('SW-7782', { exact: true })).toBeVisible();
  await expect(page.getByText(/AT-2408/).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000005' })).toBeVisible();

  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000005 shipped');

  // Delivered posts an invoice, so it asks first
  await page.getByRole('button', { name: 'Mark delivered' }).click();
  const confirm = page.getByRole('dialog', { name: 'Mark W-000005 delivered?' });
  await expect(confirm.getByText(/^This posts an invoice for ৳/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Mark delivered' }).click();
  await toastShown(page, /^W-000005 delivered\. Invoice .+ posted\.$/);
  await expect(page.getByText(/^The invoice waits for its money\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Record payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Mark / })).toHaveCount(0);

  // Off the New tab, and the sidebar's count is down by one
  await backToList(page);
  await expect(listItem(page, /W-000005/)).toHaveCount(0);
  await expect(
    page.getByRole('navigation').getByRole('link', { name: /Shop orders/ }),
  ).toContainText('2');
});

test('cancels a new order, and a packed one through a sales return', async ({ page }) => {
  await start(page);
  await openOrder(page, 'W-000006');
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel W-000006?' });
  await expect(dialog.getByText(/^The stock held for it is free again/)).toBeVisible();
  await dialog.getByLabel('Why').fill('Out of stock at the Khulshi courier point');
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000006 cancelled. The shopper gets an SMS.');
  await expect(page.getByText('Why: Out of stock at the Khulshi courier point')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

  await backToList(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const packed = page.getByRole('dialog', { name: 'Cancel W-000004?' });
  await expect(packed.getByText(/^A sales return brings the packed goods back/)).toBeVisible();
  await packed.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000004 cancelled. The shopper gets an SMS.');
  // The goods came back on a sales return, linked beside the challan
  await expect(documentRow(page, 'Sales return').getByRole('link')).toBeVisible();
  await expect(documentRow(page, 'Challan').getByRole('link')).toBeVisible();
});

test('makes the sales order of an order whose first try was refused', async ({ page }) => {
  await start(page);
  await openOrder(page, 'W-000007');
  await expect(
    page.getByText(
      'The sales order could not be made. Pick an active product. This one is archived or was deleted.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Found by the phone with the sales order')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Make the sales order' }).click();
  await toastShown(page, /^Sales order .+ made for W-000007$/);
  await expect(page.getByText(/^Pack the goods, then mark it packed\./)).toBeVisible();
  // A new shopper: the phone made her a customer
  await expect(page.getByRole('link', { name: 'Shirin Sultana' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toBeVisible();

  await backToList(page);
  await expect(listItem(page, /W-000007/)).not.toContainText('Needs attention');
});

test('the bell opens the new order', async ({ page }) => {
  await page.goto('/');
  await pinAnswered(page);
  // The workspace's other notifications are unread too: the count is not this test's
  await page
    .getByRole('button', { name: /^Notifications, \d+ unread$/ })
    .first()
    .click();
  await page.getByRole('button', { name: /New shop order W-000006 for ৳/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000006' })).toBeVisible();
});

test('a reader sees the orders without the buttons', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['storefront.order.read'] });
  await start(page);
  // The Storefront group shows for the orders alone; the shop's own pages need storefront.manage
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Catalog' })).toHaveCount(0);
  await openOrder(page, 'W-000005');
  await expect(
    page.getByText(
      /^You can view shop orders\. Ask a workspace owner for the storefront\.order\.manage/,
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark packed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View shop' })).toHaveCount(0);
});

test('a packer moves orders on without any sales permission', async ({ page }) => {
  await actAs(page, {
    name: 'Packer',
    permissions: ['storefront.order.read', 'storefront.order.manage'],
  });
  await start(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000004 shipped');
  await expect(page.getByText(/^Mark it delivered when the shopper has it\./)).toBeVisible();
});

test('picks the service the delivery charge is billed as', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop settings');
  // The first order with a charge made "Delivery charge"; the select shows it
  const select = page.getByLabel('Delivery charge’s service');
  await expect(select.locator('option:checked')).toHaveText(/^Delivery charge · /);

  // Orders bill it already: it cannot go back to empty
  await select.selectOption({ label: 'Made by the first order with a charge' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByText(
      'Orders already use a delivery charge service. Pick one; it can be another service.',
    ),
  ).toBeVisible();

  // Another service is fine: the next orders bill that one
  await select.selectOption({ label: 'Logo embroidery · SVC-EMB' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes not saved yet')).toBeHidden();
  await expect(select.locator('option:checked')).toHaveText('Logo embroidery · SVC-EMB');
});
```

- **The list:** the sidebar's count, the three new orders and the refused one's pill, the tab in the address, a search
  inside a tab and "Search every order", a phone typed with a space, and a cancelled order's page (its reason, no
  buttons, no "When it is packed").
- **Packed, Shipped, Delivered:** the plan by expiry (AT-2408 before AT-2411), the challan's refusal under the batch
  that asked for 3 of 2, the fix, the toast with the challan's number, the challan's own page with the serial number
  and the lot, then Shipped, Delivered's question, the invoice's toast, "Record payment", and the count going down.
- **Cancel:** a new order with a reason, then a packed one, which links its sales return beside its challan.
- **The refused sales order**, the **bell**, a **reader** (no buttons, no Catalog, no View shop), a **packer**
  (moves an order with no sales permission at all), and the **settings box** (the made service is shown, emptying it
  is refused, another service is kept).
- The second batch is picked by its place in the select. Its words carry an expiry date that moves with today.

### Check this part

```bash
pnpm --filter @omnivo/app typecheck                              # src, scripts, e2e, sw
pnpm --filter @omnivo/app test                                   # 239 unit tests
pnpm exec eslint apps/app/src/mocks apps/app/src/routes/storefront-orders.tsx \
  apps/app/src/components/storefront-pack-dialog.tsx apps/app/e2e
pnpm exec depcruise --config .dependency-cruiser.cjs apps/app/src   # no import cycle in the mocks
pnpm --filter @omnivo/ui build
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts storefront-orders --workers=2
pnpm --filter @omnivo/app build && pnpm --filter @omnivo/app test:bundle-size
```

The neighbouring suites still pass with the new mock routes (storefront, notifications, roles, settings,
sales-orders, customers and this file: 74 tests on desktop and phone).

Broken on purpose, each caught by the new spec (and put back): the pack's challan errors not mapped to the picks (the
stock error left the batch's box), and the settings box allowed to go empty after orders used its service.

The screens were compared with the mockup's 17 PNGs on the mock (desktop and 390px): they match, apart from
decisions 55 and 56.

On a busy machine one test failed once because Vite reloaded the page (its websocket to the dev server dropped under
load, and Vite reloads when it comes back). The mock then starts again with new ids, and the open order's page says
"This order doesn't exist". It passed on the rerun; it is not the app.

## 27b.8 — Run it and check it

### Two more fixtures

The whole run found two older test files that save the shop's settings with a body of their own, without the new
box. The contract refuses a body without `deliveryVariantId`, like any other box of that form, so every test after
the first save failed with `invalid_input`. 27b.3 fixed the same body in `storefront-admin.int.spec.ts`; these two
were missed, because their bodies go to an untyped `send()`, and the type check cannot see them.

```diff
@@ -121,6 +121,8 @@ async function setUp(who: SignedIn, slug: string, name: string): Promise<Shop> {
     freeDeliveryFrom: '',
     minimumOrder: '',
     paymentMethods: ['cod'],
+    // Step 27b: "Made by the first order with a charge"
+    deliveryVariantId: '',
   });
   expect(shop.statusCode, shop.body).toBe(201);
   // The same category slug in both shops on purpose: each shop's slugs are its own
@@ -366,6 +368,7 @@ describe('another workspace’s shop settings', () => {
       freeDeliveryFrom: '',
       minimumOrder: '',
       paymentMethods: ['cod'],
+      deliveryVariantId: '',
       version: ours.settings.version,
     });
     expect(res).toEqual({
@@ -391,6 +394,7 @@ describe('another workspace’s shop settings', () => {
       freeDeliveryFrom: '',
       minimumOrder: '',
       paymentMethods: ['cod'],
+      deliveryVariantId: '',
       version: ours.settings.version,
     });
     expect(res).toMatchObject({ status: 409, code: 'storefront_warehouse_invalid' });
```

```diff
@@ -386,6 +386,8 @@ describe('the logo and the colors', () => {
       freeDeliveryFrom: '',
       minimumOrder: '',
       paymentMethods: ['cod'],
+      // Step 27b: "Made by the first order with a charge"
+      deliveryVariantId: '',
     });
     expect(made.statusCode, made.body).toBe(201);
     const category = await send('POST', '/storefront/categories', {
@@ -502,6 +504,7 @@ describe('the logo and the colors', () => {
         freeDeliveryFrom: '',
         minimumOrder: '',
         paymentMethods: ['cod'],
+        deliveryVariantId: '',
         version: before.version,
       }),
       409,
```

`''` is what the settings page sends for "Made by the first order with a charge". The tests are about other things
(the shop's look, another workspace's warehouse), so they keep the box empty.

### The Packed dialog's plan, asked once too often

The run on the real API (below) showed one more request than needed: after each Packed, the page asked the API for
the order's pack plan once more, and got a 409 (`storefront_order_step_invalid`, because the order is packed now).
Nobody saw it: React Query kept the old plan, and the dialog closed a moment later. The cause is `useApplyMove()`:
it refreshes every query under `['storefront', tenant]`, and the Packed dialog's plan is one of them, still open
while the refresh starts.

```diff
@@ -104,7 +104,13 @@ function useApplyMove(): (saved: StorefrontOrder) => Promise<void> {
       queryClient.setQueryData(storefrontOrderQuery(tenantId, saved.id).queryKey, saved);
       await Promise.all(
         ['storefront', 'sales', 'stock', 'journal', 'customers'].map((area) =>
-          queryClient.invalidateQueries({ queryKey: [area, tenantId] }),
+          queryClient.invalidateQueries({
+            queryKey: [area, tenantId],
+            // Not the Packed dialog's plan: it is asked again each time the dialog opens (gcTime
+            // 0), and refreshed here, while the dialog is still open, it would ask for the plan
+            // of an order that is packed now, which the API refuses (409)
+            predicate: (query) => query.queryKey[3] !== 'pack-plan',
+          }),
         ),
       );
     },
```

The plan never needs a refresh from a move: it is asked again each time the dialog opens (`staleTime` 0, `gcTime` 0,
27b.6). So the refresh leaves it out by the fourth part of its key. Closing the dialog before the refresh does not
help: `setDialog(null)` only asks React for a new render, and the refresh starts in the same tick, while the dialog
is still mounted.

### Try it

```bash
pnpm install
pnpm db:migrate        # 0072
pnpm dev
pnpm seed:shop         # once, if your dev database has no demo shop yet (26h.8)
```

Start a second shop on the API, as in 27a.6 (the key is the API's `STOREFRONT_SHOP_KEY` from your `.env`):

```bash
SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000 \
SHOP_API_KEY=dev-only-shop-key-change-me-0123456789abcdef \
pnpm --filter @omnivo/shop dev --port 4322
```

Then place two or three orders at `http://demo-shop.localhost:4322` (the code is in Mailpit, `http://localhost:8025`),
and sign in to the ERP as the shop's owner (`owner@demo-shop.test`, `Demo-shop-2026`):

- [ ] The sidebar's Storefront group starts with **Shop orders**, with the count of new orders. The bell's "New shop
      order W-000001 for ৳538." opens the order's page.
- [ ] The order's page links the customer the phone found (a second order from the same phone links the same one) and,
      under Documents, the confirmed sales order. Its total is the shop's total to the paisa.
- [ ] **Mark packed**: the dialog says "No batch or serial number to pick." for the demo shop's products. Mark packed:
      the toast names the posted challan, and the product's stock is lower by what was packed.
- [ ] **Mark shipped**, then **Mark delivered**: it asks first, then the toast names the posted invoice, unpaid, and
      "Record payment" opens a money receipt for the customer.
- [ ] **Cancel order** on a new order, with a reason: Mailpit has "…order W-000002 was cancelled. Questions? Call …",
      and the sales order is cancelled.
- [ ] Pack another order, then cancel it: the Documents card links a posted sales return beside the challan, and the
      stock is back.
- [ ] Shop settings now shows "Delivery charge · …" in the delivery charge's service box.
- [ ] Sign in as a member with only `storefront.order.read`: Shop orders shows, with no buttons, and the shop's other
      pages are not in the menu.

## What comes next

- **27c:** coupons, and online payment with SSLCommerz (each shop's own encrypted credentials). Mobile Banking comes
  back to the checkout then.
- **Before staging sends real SMS:** a real `SmsSender` (the provider is your choice) and the shop's SMS balance.
- **Step 28:** courier bookings, the courier's events on the tracking page and on the order's timeline, the courier's
  cash on delivery as the invoice's payment, and parcels that come back (Returned).
