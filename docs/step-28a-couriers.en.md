# Step 28a: Courier automation, part 1 — courier accounts, booking a parcel and its news

> The implementation guide for "Phase 10 → Step 28", the first part, of [build-plan.bn.md](build-plan.bn.md). Step
> 28 has three parts:
>
> - **28a (this guide):** the shop's courier accounts (Steadfast by its API, or any courier by hand), booking a
>   packed order's parcel in the worker, the courier's news by webhook and by a 15-minute poll, the order moving
>   to Shipped and Delivered by itself, and the parcel's real events on the tracking page.
> - **28b:** the courier's COD money: a COD account per courier, the courier's payouts, returns and partial
>   deliveries.
> - **28c:** Pathao, which needs the address as its own city, zone and area.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `5c1a8a4`, "sslcommerz
> added") and checked on 2026-11-23: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, `pnpm typecheck`, `pnpm test`
> (1,610, of them 681 in `packages/contracts`, 274 in `apps/shop`, 244 in `apps/api` and 242 in `apps/app`),
> `pnpm test:integration` (905 in 52 files, clean on the first run) and `pnpm test:tenant-leak` (27 files; two of them
> timed out in their set-up while the machine was busy, and both passed when run again alone) on Testcontainers,
> `pnpm boundaries`, `pnpm test:openapi`, `pnpm test:bundle-size` (first load 249.7 KB gz of 250; the Shop couriers
> page 134.8 KB and the shop order page 119.9 KB, budget 155), the app's Playwright suite on a computer and on a phone
> (484 passed and 3 skipped on purpose; 5 timed out while the machine was busy, none of them in a file this guide
> changed, and all passed when run again one at a time), the PWA suite (4) and the shop's Playwright tests (50, 2
> skipped on purpose, as before). ESLint ran in the three runs `pnpm lint` makes, each with 6 GB of memory: no
> errors. The whole way was then run on the real API, its worker and the built shop with the fake courier (28a.8):
> the ERP screens added a Steadfast account, Packed booked the parcel, posted webhooks moved the order to Shipped and
> Delivered, and the shop's tracking page showed the courier's news.
>
> **There is no Steadfast test account yet.** `SteadfastAdapter` was first written from memory of Steadfast's
> documentation (it could not be fetched in 28a.1). In 28a.8 it was checked against Steadfast's own package on
> GitHub (`steadfast-it/SteadFast-Laravel-Package`, its README of 10 Nov 2026): the base address, the order's fields
> and answer, the three status reads, the eleven status words and the webhook all match. Four things are still not
> confirmed there: the two key headers' names, the `tracking_update` notice, the tracking page's address and the bulk
> CSV's columns. Everything else runs on the fake courier (`COURIER_MODE=fake`), which answers in the same shapes.
> Before the first live shop, book one parcel with a real Steadfast account (28a.8's "Try it").

## Goal

🏷️ **A packed order books its own parcel, and the courier's news moves the order.** Until now a shop order's parcel
is booked by hand on the courier's website, and a member presses Mark shipped and Mark delivered when someone
remembers. After 28a the tenant adds its Steadfast account in Storefront → Shop couriers, the Packed dialog books
the parcel as the challan is posted, and the worker hands it to Steadfast with our order number as the key, so a
retry can never make a second parcel. Steadfast's webhook (and a poll every 15 minutes when no webhook comes) moves
the order to Shipped when the rider picks it up and to Delivered when it arrives, which posts the invoice as before.
A booking that fails five times rings the bell and waits for "Book again"; it never fails quietly. A shop that
books by hand keeps doing so, now with the tracking code on the order, a label and an export for the courier's bulk
upload.

## Decisions

Agreed with the user on 2026-11-22 (all twelve as recommended):

1. **Three guides.** 28a couriers and booking, 28b COD money, returns and partial deliveries, 28c Pathao.
2. **Booking at Packed, not at confirm.** The batches and serial numbers are picked at Packed, and a parcel booked
   earlier would have the courier come for a box that is not packed yet.
3. **Idempotency twice.** Our order number is Steadfast's `invoice`, and the database has `UNIQUE (tenant_id,
   order_id, courier_account_id)`. After a timeout the worker asks Steadfast by the invoice before trying again.
4. **Five tries, then Needs attention.** Exponential backoff in BullMQ; then the order's crit pill, the bell and
   "Book again". The courier refusing the keys has its own error: it is the tenant's account, not our bug.
5. **The courier's news moves the order.** Picked up → Shipped, delivered → Delivered (the invoice, as 27b). A
   manual parcel keeps the buttons.
6. **A fake courier,** like 27d's fake gateway: `COURIER_MODE=fake` outside production, refused in production.
7. **Keys sealed with `CREDENTIALS_KEY`,** write-only, with "Test connection". Accounts need `storefront.manage`,
   booking `storefront.order.manage`.
8. **One webhook address per account,** with the account's own bearer token; only its hash is kept.
9. **A poll every 15 minutes** of the parcels still on their way, per workspace in batches.
10. **Shop orders only** for now; ERP challans get couriers later.
11. **Two SMS only:** when the rider picks the parcel up, and (28b) when it goes back.
12. **COD money in 28b:** a COD account per courier, a money receipt into it at Delivered, and the courier's payout.

Mine, made while writing (each says why where it is used):

13. **The default account is the policy.** The Packed dialog starts with the default courier account; with none it
    starts at "Don't book now". So "off" is simply no default, and a shop with its own riders works as before.
14. **A manual account names its courier** (one of the five the tracking page knows). A shop's own rider needs no
    account: the order moves by the buttons, as today.
15. **Shop couriers is its own page** in the Storefront menu, not another card in Shop settings, which is long
    already and is saved as one form.
16. **The webhook token is shown once,** like a share link; the page shows when the courier's news last arrived, so
    a tenant who never pasted the address finds out.
17. **The ERP has two statuses the shop never sees:** `booking` and `booking_failed`. The shop shows a parcel only
    once the courier gave it a tracking code.
18. **Booking and the export are order routes** (storefront-orders.ts), because they answer the order. shipping.ts
    never imports the order's file, so the two files have no import cycle.
19. **The export is JSON rows, and the browser writes the CSV,** in the columns of Steadfast's bulk upload, at most
    500 packed orders with no parcel.
20. **`codAmount` is on the order,** worked out by the API (the total less what paid tries took), so the label, the
    export and the booking say one amount.
21. **Cancel works while a parcel is only booked,** and is refused once the courier has picked it up: that is a
    return (28b).
22. **The webhook's body is read loosely and never refused for its shape.** A notice we cannot read is kept raw on
    the parcel; a 400 would make the courier stop sending.
23. **The default is set with `PUT /storefront/couriers`.** `/storefront/couriers/default` would reach the
    account's own `PUT /storefront/couriers/:id` with "default" as the id.

## 28a.1 — Contracts

Everything both sides must agree on before any code books a parcel: the courier accounts as the Shop couriers page
reads and saves them, a parcel as the order page shows it, what the Packed dialog and "Book courier" send, the
export for a courier's bulk upload, and what Steadfast's webhook posts. Plus the error codes, the audit actions, the
bell's new kind and their words.

### Courier accounts and parcels

```ts
import { z } from 'zod';

import { ERROR_CODES, errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { optionalIdSchema } from './stock.js';
import { SHOP_COURIERS, SHOP_SHIPMENT_STATUSES } from './storefront.js';

// Step 28a: couriers (system design §14.6). The shop's own courier accounts, as the ERP's
// Storefront → Shop couriers page reads and saves them, and the parcels a shop order is sent in.
// Omnivo keeps the keys and makes the calls; the courier's money goes to the tenant (step 28b).
// Business code never knows a courier's own API: each provider has one adapter in the API
// (apps/api/src/shipping/), and everything here is in our own words.

// ---------------------------------------------------------------------------------------------
// Courier accounts

// How a parcel gets to the courier:
// - steadfast: the API books it with Steadfast's own API, and Steadfast tells us where it is
//   (a webhook, and a 15-minute poll when no webhook comes)
// - manual: the shop books it on the courier's own website or app (or by phone) and types the
//   courier's tracking code into the order. Nothing is called; the staff move the order as before
// Pathao comes in step 28c: it needs the address as its own city, zone and area ids
export const COURIER_PROVIDERS = ['steadfast', 'manual'] as const;
export type CourierProvider = (typeof COURIER_PROVIDERS)[number];

// Which courier each provider is, for the tracking page (it shows the courier's name and its
// tracking code). A manual account picks one of the five; an API account is its own courier
export const COURIER_OF_PROVIDER = {
  steadfast: 'steadfast',
} as const satisfies Record<Exclude<CourierProvider, 'manual'>, (typeof SHOP_COURIERS)[number]>;

// "Test connection" asks the courier something harmless with the saved keys (Steadfast's
// balance). Its answers, the same two as the payment gateway's test (step 27d):
// - rejected: the courier answered and refused the keys
// - unreachable: no answer in time, or one that is not the courier's
export const COURIER_TEST_PROBLEMS = ['rejected', 'unreachable'] as const;
export type CourierTestProblem = (typeof COURIER_TEST_PROBLEMS)[number];

// A label for the staff ("Steadfast", "Steadfast Sylhet branch"): a workspace may have two
// accounts with one courier, one per pickup point. Not shown to shoppers
const accountNameSchema = z
  .string()
  .trim()
  .min(1, errorCode('required'))
  .max(60, errorCode('too_long'));

// Steadfast's Api-Key and Secret-Key are letters and digits. Trimmed: a key copied from the
// courier's panel often brings a space, and a key never has one. The pattern takes an empty box
// (`*`), for the same reason as the gateway's store id: Zod runs every check, so with `+` an empty
// box would say "required" and "letters and digits" at once. 200 is far more than any courier's
const courierKeySchema = z
  .string()
  .trim()
  .max(200, errorCode('too_long'))
  .regex(/^[A-Za-z0-9_-]*$/, errorCode('courier_key_format'));

// The first save needs both keys; a later one keeps a saved key when its box is empty. The form
// of a manual account has no keys at all: there is nothing to call
const steadfastCreateSchema = z.object({
  provider: z.literal('steadfast'),
  name: accountNameSchema,
  apiKey: courierKeySchema.min(1, errorCode('courier_key_required')),
  secretKey: courierKeySchema.min(1, errorCode('courier_key_required')),
});
const manualCreateSchema = z.object({
  provider: z.literal('manual'),
  name: accountNameSchema,
  // Whose website the shop books on. The select's "Pick a courier" sends '', which is this error
  courier: z.enum(SHOP_COURIERS, errorCode('courier_pick_one')),
});

// One schema per provider, told apart by `provider`, so the form and the API both know which
// fields to ask for. The provider never changes once saved (the update below has no `provider`
// to change it with, only to say which form it is)
export const createCourierAccountInputSchema = z.discriminatedUnion('provider', [
  steadfastCreateSchema,
  manualCreateSchema,
]);
export const updateCourierAccountInputSchema = z.discriminatedUnion('provider', [
  steadfastCreateSchema.extend({
    apiKey: courierKeySchema,
    secretKey: courierKeySchema,
    version: versionSchema,
  }),
  manualCreateSchema.extend({ version: versionSchema }),
]);
export type CreateCourierAccountInput = z.infer<typeof createCourierAccountInputSchema>;
export type UpdateCourierAccountInput = z.infer<typeof updateCourierAccountInputSchema>;
export type CourierAccountFormValues = z.input<typeof updateCourierAccountInputSchema>;

export const COURIER_ACCOUNT_STATUSES = ['active', 'archived'] as const;
export type CourierAccountStatus = (typeof COURIER_ACCOUNT_STATUSES)[number];

export const courierAccountSchema = z.object({
  id: z.uuid(),
  provider: z.enum(COURIER_PROVIDERS),
  name: z.string(),
  // The courier the tracking page names: the provider's own (COURIER_OF_PROVIDER) or the one a
  // manual account picked
  courier: z.enum(SHOP_COURIERS),
  status: z.enum(COURIER_ACCOUNT_STATUSES),
  // Where the courier sends its news, to paste into its panel with the token below. null for a
  // manual account. Not a secret: the token is
  webhookUrl: z.url().nullable(),
  // Whether a webhook token is saved. It is shown once, when it is made (courierAccountSavedSchema),
  // and only its hash is kept, like a tracking link's token
  hasWebhookToken: z.boolean(),
  // When the courier's webhook last reached us with the right token: the page says "Steadfast's
  // news arrive" or that none came yet, so a tenant who forgot to paste the URL finds out. null:
  // never
  lastWebhookAt: z.iso.datetime().nullable(),
  // The last "Test connection", as on the payment gateway's card. null: never tested, or a manual
  // account. Saving new keys clears it, because it said something about the old ones
  lastTest: z
    .object({
      at: z.iso.datetime(),
      problem: z.enum(COURIER_TEST_PROBLEMS).nullable(),
    })
    .nullable(),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CourierAccount = z.infer<typeof courierAccountSchema>;

// What a save or a new webhook token answers. The token is in the answer once, and never again:
// the page shows it in a read-only box with Copy, like a share link (step 16). null when this call
// made none (a manual account, or a save that kept the old token)
export const courierAccountSavedSchema = z.object({
  account: courierAccountSchema,
  webhookToken: z.string().nullable(),
});
export type CourierAccountSaved = z.infer<typeof courierAccountSavedSchema>;

// The page's one read: every account, archived ones too (the page has an Active / Archived
// control), and the default. The default is what the Packed dialog starts with (decision 2): with
// none, it starts at "Don't book now", so a shop with its own riders works as before
export const courierSetupSchema = z.object({
  accounts: z.array(courierAccountSchema),
  defaultAccountId: z.uuid().nullable(),
});
export type CourierSetup = z.infer<typeof courierSetupSchema>;

// The default can only be an active account that books by API: a manual account cannot be booked
// at Packed (the courier's code does not exist yet then). '' = no default
export const setDefaultCourierInputSchema = z.object({ accountId: optionalIdSchema });
export type SetDefaultCourierInput = z.infer<typeof setDefaultCourierInputSchema>;

export const courierAccountVersionInputSchema = z.object({ version: versionSchema });

// ---------------------------------------------------------------------------------------------
// Shipments: the parcels of a shop order, as the ERP's order page shows them

// What the ERP shows of a parcel: the shop's ten (SHOP_SHIPMENT_STATUSES) plus two of our own,
// before the courier knows about it:
// - booking: Packed asked for it, and the worker is calling the courier (or will try again)
// - booking_failed: five tries did not book it (decision 4). The order needs attention, the bell
//   rang, and the page has "Book again". The shop never sees either of these two: it shows a
//   parcel only once the courier gave it a tracking code
export const SHIPMENT_STATUSES = ['booking', 'booking_failed', ...SHOP_SHIPMENT_STATUSES] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// A parcel still on its way: the 15-minute poll asks the courier about these only, and an order
// with one cannot be booked again with another courier
export const OPEN_SHIPMENT_STATUSES = [
  'booking',
  'booked',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'on_hold',
  'returning',
] as const satisfies readonly ShipmentStatus[];

export function isOpenShipment(status: ShipmentStatus): boolean {
  return OPEN_SHIPMENT_STATUSES.some((open) => open === status);
}

// A courier's tracking code as a member types it for a manual parcel, or as the courier answers
// it. Letters, digits and dashes only: it goes into the tracking page, an SMS and a label
export const courierTrackingCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(64, errorCode('too_long'))
  .regex(/^[A-Z0-9-]*$/, errorCode('courier_tracking_code_format'));

export const shipmentEventSchema = z.object({
  status: z.enum(SHOP_SHIPMENT_STATUSES),
  at: z.iso.datetime(),
  // The courier's own words, as on the tracking page (shopShipmentEventSchema.note)
  note: z.string().nullable(),
});

export const storefrontShipmentSchema = z.object({
  id: z.uuid(),
  account: z.object({
    id: z.uuid(),
    name: z.string(),
    provider: z.enum(COURIER_PROVIDERS),
  }),
  courier: z.enum(SHOP_COURIERS),
  status: z.enum(SHIPMENT_STATUSES),
  // The courier's own id for the parcel and its tracking code. null while booking, or for a
  // booking that failed
  consignmentId: z.string().nullable(),
  trackingCode: z.string().nullable(),
  // What the rider collects: the order's total less what was paid online, fixed when it was
  // booked (the courier was told this amount)
  codAmount: z.string(),
  // When the courier gave it a tracking code. null while booking
  bookedAt: z.iso.datetime().nullable(),
  // Calls made to book it, and why the last one failed (courier_rejected_parcel: the courier said
  // no, with its own words in errorDetail, like "Invalid phone number"). null when it worked
  attempts: z.number().int().min(0),
  error: z.enum(ERROR_CODES).nullable(),
  errorDetail: z.string().nullable(),
  // Oldest first. Empty while booking
  events: z.array(shipmentEventSchema).max(100),
  // When the courier last told us anything (a webhook or the poll). null: never yet
  lastSyncedAt: z.iso.datetime().nullable(),
});
export type StorefrontShipment = z.infer<typeof storefrontShipmentSchema>;

// "Book courier" on a packed order that has no parcel on its way (or whose last one was
// cancelled or failed). An API account books through the worker (the answer has the parcel in
// `booking`); a manual account needs the tracking code the courier's panel gave, and its parcel
// is `booked` at once. The API checks which one the account is: an empty code for a manual
// account is courier_tracking_code_required, a code for an API account is ignored
export const bookShipmentInputSchema = z.object({
  version: versionSchema,
  accountId: z.uuid(errorCode('courier_pick_account')),
  trackingCode: courierTrackingCodeSchema,
});
export type BookShipmentInput = z.infer<typeof bookShipmentInputSchema>;
export type BookShipmentFormValues = z.input<typeof bookShipmentInputSchema>;

// ---------------------------------------------------------------------------------------------
// The export for a courier's own panel (the manual way, decision 2)

// The packed orders with no parcel yet, one row each, in the columns of Steadfast's bulk upload
// (Invoice, Name, Address, Phone, Amount, Note), which the other couriers' panels take too. The
// browser writes the CSV from these rows: the list is small (only what waits to go out), and the
// app already writes files in the browser for prints
export const COURIER_EXPORT_MAX_ROWS = 500;
export const courierExportRowSchema = z.object({
  orderId: z.uuid(),
  // Our order number: the courier's "invoice", the key its panel finds the parcel by
  invoice: z.string(),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  // What the rider collects (the order's codAmount), a decimal string with paisa
  amount: z.string(),
  // "3 items", for the rider; never the products (the courier does not need them)
  itemCount: z.number().int().min(1),
});
export const courierExportSchema = z.object({
  rows: z.array(courierExportRowSchema).max(COURIER_EXPORT_MAX_ROWS),
  // More orders wait than one export holds: the page says to export again after booking these
  more: z.boolean(),
});
export type CourierExportRow = z.infer<typeof courierExportRowSchema>;
export type CourierExport = z.infer<typeof courierExportSchema>;

// ---------------------------------------------------------------------------------------------
// The courier's webhook

// What Steadfast posts (its "delivery_status" and "tracking_update" notifications). Only what we
// read is listed, and loosely: a courier adds fields without telling anyone, and a notice we
// cannot read is kept raw on the parcel's events for debugging (§14.7), never refused with a 400
// that makes the courier stop sending. The adapter reads it (steadfast-adapter.ts)
export const steadfastWebhookSchema = z.looseObject({
  notification_type: z.string().optional(),
  consignment_id: z.union([z.string(), z.number()]).optional(),
  invoice: z.string().optional(),
  status: z.string().optional(),
  tracking_message: z.string().optional(),
  updated_at: z.string().optional(),
});
export type SteadfastWebhook = z.infer<typeof steadfastWebhookSchema>;

// The answer Steadfast expects. Anything else, it retries
export const courierWebhookAnswerSchema = z.object({
  status: z.literal('success'),
  message: z.string(),
});

// ---------------------------------------------------------------------------------------------
// Routes

const idParamsSchema = z.object({ id: z.uuid() });

// The accounts need storefront.manage, like the payment gateway: whoever sets up the shop sets up
// how its parcels go. There is no delete: a parcel keeps its account, so an account is archived.
// Booking and the export are moves of an order, so they are in storefront-orders.ts (their answer
// is the ERP's order, and that file reads the parcel's schema from here, never the other way)
export const shippingRoutes = {
  getCouriers: defineRoute({
    method: 'GET',
    path: '/storefront/couriers',
    summary: "The shop's courier accounts (never their keys) and the default one",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    response: courierSetupSchema,
  }),
  createCourier: defineRoute({
    method: 'POST',
    path: '/storefront/couriers',
    summary: 'Add a courier account; an API account answers its webhook token once',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createCourierAccountInputSchema,
    response: courierAccountSavedSchema,
  }),
  updateCourier: defineRoute({
    method: 'PUT',
    path: '/storefront/couriers/:id',
    summary: 'Change a courier account; an empty key keeps the saved one',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateCourierAccountInputSchema,
    response: courierAccountSchema,
  }),
  // No body: it tests what is saved, so the keys never travel for a test. A 200 whether the
  // courier accepted them or not, as for the gateway's test
  testCourier: defineRoute({
    method: 'POST',
    path: '/storefront/couriers/:id/test',
    summary: 'Ask the courier whether it accepts the saved keys',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: courierAccountSchema,
  }),
  // A new token replaces the old one at once: the courier's panel needs the new one pasted too
  renewCourierWebhookToken: defineRoute({
    method: 'POST',
    path: '/storefront/couriers/:id/webhook-token',
    summary: 'Make a new webhook token for a courier account; it is answered once',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: courierAccountVersionInputSchema,
    response: courierAccountSavedSchema,
  }),
  // Archived: not offered for new parcels, no longer the default. Its parcels on their way still
  // get the courier's news (the poll and the webhook still work), because they are still out there
  archiveCourier: defineRoute({
    method: 'POST',
    path: '/storefront/couriers/:id/archive',
    summary: 'Archive a courier account: no new parcels go with it',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: courierAccountVersionInputSchema,
    response: courierAccountSchema,
  }),
  restoreCourier: defineRoute({
    method: 'POST',
    path: '/storefront/couriers/:id/restore',
    summary: 'Restore an archived courier account',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: courierAccountVersionInputSchema,
    response: courierAccountSchema,
  }),
  // On the list's own address: /storefront/couriers/default would reach updateCourier with
  // "default" as the id
  setDefaultCourier: defineRoute({
    method: 'PUT',
    path: '/storefront/couriers',
    summary: 'Choose the courier the Packed dialog books with first, or none',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    body: setDefaultCourierInputSchema,
    response: courierSetupSchema,
  }),
  // The courier calls this, not a browser and not the shop: 'public', and the account's own
  // bearer token is checked by the handler before anything is read (decision 8). The account's id
  // in the address says whose parcel it is, so the body is never trusted for the tenant
  steadfastWebhook: defineRoute({
    method: 'POST',
    path: '/public/v1/couriers/steadfast/:id',
    summary: "Steadfast's news about a parcel (the courier only, with the account's token)",
    auth: 'public',
    status: 200,
    params: idParamsSchema,
    body: steadfastWebhookSchema,
    response: courierWebhookAnswerSchema,
  }),
};
```

Why each part is written this way:

- **`COURIER_PROVIDERS` is `steadfast` and `manual`,** not the five couriers of `SHOP_COURIERS`. A provider is how a
  parcel gets booked; a courier is whose name the tracking page shows. A manual account books on any courier's own
  website, so it picks the courier (decision 14), and an API account is its own courier (`COURIER_OF_PROVIDER`).
  The `satisfies` there makes the type check fail the day a provider is added without its courier.
- **The key pattern takes an empty box (`*`).** Zod runs every check, so with `+` an empty box would show
  "required" and "letters and digits" at once. The same reason as 27d's store id. Keys are trimmed: a key copied
  from a panel often brings a space, and a key never has one.
- **One discriminated union per save, by `provider`.** The form and the API both know which fields to ask for, and a
  manual account's parse drops any key a client sent. The update has the same `provider`, so it says which form it
  is; the API refuses a different provider than the saved one (`courier_provider_fixed`).
- **A later save keeps an empty key** (27d's write-only rule): the keys never come back to the browser, so the form
  cannot send them again.
- **The saved account has no key and no token.** `hasWebhookToken` and `lastWebhookAt` say what the page needs:
  whether a token exists and whether the courier's news reached us (decision 16). The token itself is only in
  `courierAccountSavedSchema`, once, when it is made.
- **`setDefaultCourierInputSchema` takes `''` as none** (decision 13), with the same helper the documents' selects
  use (`optionalIdSchema`).
- **`SHIPMENT_STATUSES` adds `booking` and `booking_failed` before the shop's ten** (decision 17).
  `OPEN_SHIPMENT_STATUSES` lists the ones still on their way, with `satisfies` so a typo is a type error: the poll
  asks about these only, and an order with one cannot be booked a second time.
- **`courierTrackingCodeSchema` upper-cases and allows letters, digits and dashes.** The code goes into the
  tracking page, an SMS and a label, so nothing else is needed, and a space typed by hand is caught at once.
- **`codAmount` on a parcel is fixed when it was booked.** The courier was told that amount; if the order changed
  later, the parcel's amount is still what the rider collects.
- **`error` and `errorDetail`.** The error is one of our codes (the page's words); the detail is the courier's own
  sentence ("Invalid phone number"), which is what the member needs to fix the order.
- **The export's rows** (decision 19) are the columns of Steadfast's bulk upload. The rows hold only what the
  courier needs: never the products.
- **`steadfastWebhookSchema` is a `looseObject` with every field optional** (decision 22). The consignment id comes
  as a number from Steadfast; the union takes a string too, in case it changes.
- **The webhook route is `auth: 'public'`** with the account's id in the address. The handler checks the bearer
  token before it reads anything, and the tenant comes from the account, never from the body.
- **`setDefaultCourier` is `PUT /storefront/couriers`** (decision 23).

### The order's parcels

```diff
@@ -7,6 +7,11 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 import { TRACKING_MODES } from './products.js';
 import { quantitySchema } from './quantities.js';
 import { documentRefSchema } from './sales.js';
+import {
+  bookShipmentInputSchema,
+  courierExportSchema,
+  storefrontShipmentSchema,
+} from './shipping.js';
 import { MAX_SERIALS_PER_LINE, optionalIdSchema, serialNumberSchema } from './stock.js';
 import { storefrontImageViewSchema } from './storefront-admin.js';
 import {
@@ -74,7 +79,8 @@ export const storefrontOrderSummarySchema = z.object({
   // The pieces in the order (the sum of the lines' quantities), as "3 items" on a phone's card
   itemCount: z.number().int().min(1),
   total: z.string(),
-  // The sales order could not be made (decision 1): the list shows a crit "Needs attention" pill
+  // The sales order could not be made (decision 1), or (step 28a) its parcel's booking failed five
+  // times: the list shows a crit "Needs attention" pill
   needsAttention: z.boolean(),
 });
 export type StorefrontOrderSummary = z.infer<typeof storefrontOrderSummarySchema>;
@@ -166,6 +172,14 @@ export const storefrontOrderSchema = storefrontOrderSummarySchema.extend({
   // to pay online. A paid online order has one paid try; two paid ones mean the shopper paid twice
   // (a second tab), and the page says one of them is to be refunded
   payments: z.array(storefrontOrderPaymentSchema).max(SHOP_PAYMENT_TRIES),
+  // Step 28a: what the rider collects at the door, a decimal string with paisa: the total less
+  // what paid tries took (never below zero; "0.00" for an order paid online). The API works it
+  // out, so the label, the export and the courier's booking all say the same amount
+  codAmount: z.string(),
+  // Step 28a: the order's parcels, oldest first. Empty until it is booked with a courier. More than
+  // one only when an earlier one was cancelled or failed and the order was booked again: at most
+  // one is on its way at a time (isOpenShipment)
+  shipments: z.array(storefrontShipmentSchema).max(5),
   version: z.number().int(),
   updatedAt: z.iso.datetime(),
 });
@@ -239,6 +253,11 @@ export const packStorefrontOrderInputSchema = z
   .object({
     version: versionSchema,
     lines: z.array(packLineInputSchema).min(1).max(SHOP_CART_MAX_LINES),
+    // Step 28a (decision 2): the courier account to book the parcel with, once the challan is
+    // posted. The dialog starts with the default account; '' = "Don't book now" (a shop's own
+    // rider, or a booking made later with "Book courier"). Only an active account that books by
+    // API: the API refuses a manual or archived one (courier_account_not_bookable)
+    courierAccountId: optionalIdSchema,
   })
   .superRefine((input, ctx) => {
     // Each line once: two entries for one line would pack it twice
@@ -290,6 +309,7 @@ export type CancelStorefrontOrderFormValues = z.input<typeof cancelStorefrontOrd
 
 const idParamsSchema = z.object({ id: z.uuid() });
 const paymentParamsSchema = z.object({ id: z.uuid(), paymentId: z.uuid() });
+const shipmentParamsSchema = z.object({ id: z.uuid(), shipmentId: z.uuid() });
 
 export const storefrontOrderRoutes = {
   listOrders: defineRoute({
@@ -312,6 +332,17 @@ export const storefrontOrderRoutes = {
     status: 200,
     response: storefrontOrderCountsSchema,
   }),
+  // Step 28a: declared before getOrder in the controller, like countOrders, or "courier-export"
+  // would reach it as an id
+  courierExport: defineRoute({
+    method: 'GET',
+    path: '/storefront/orders/courier-export',
+    summary: "The packed orders with no parcel yet, as rows for a courier's bulk upload",
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    response: courierExportSchema,
+  }),
   getOrder: defineRoute({
     method: 'GET',
     path: '/storefront/orders/:id',
@@ -389,6 +420,35 @@ export const storefrontOrderRoutes = {
     body: storefrontOrderVersionInputSchema,
     response: storefrontOrderSchema,
   }),
+  // Step 28a: "Book courier" on a packed order with no parcel on its way. An API account books in
+  // the worker (the answer's parcel is `booking`), a manual one takes the typed tracking code
+  bookShipment: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/shipments',
+    summary: 'Book courier: send a packed order with a courier account',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: idParamsSchema,
+    body: bookShipmentInputSchema,
+    response: storefrontOrderSchema,
+  }),
+  // Step 28a: "Book again" after five failed tries (decision 4). The same parcel row, so the
+  // courier is asked with the same order number and cannot make a second parcel
+  retryShipment: defineRoute({
+    method: 'POST',
+    path: '/storefront/orders/:id/shipments/:shipmentId/retry',
+    summary: 'Book again a parcel whose booking failed',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    params: shipmentParamsSchema,
+    body: storefrontOrderVersionInputSchema,
+    response: storefrontOrderSchema,
+  }),
+  // Step 28a: a booked parcel nobody has picked up yet is cancelled with the order (the API asks
+  // the courier to cancel it, or says to cancel it on the courier's panel); once the courier has
+  // it, the order is refused (storefront_order_parcel_on_its_way): it comes back as a return (28b)
   cancelOrder: defineRoute({
     method: 'POST',
     path: '/storefront/orders/:id/cancel',
```

- **`codAmount` on the order** (decision 20). The API works it out once, so the label, the export and the booking
  can never disagree.
- **`shipments` at most five,** oldest first. More than one only after a cancelled or failed one.
- **`courierAccountId` on Packed** is the Packed dialog's courier select (decisions 2 and 13). `''` means "Don't
  book now".
- **`courierExport` is declared before `getOrder` in the controller,** like `countOrders`, or Nest would read
  "courier-export" as an order id.
- **"Book again" uses the same parcel row,** so Steadfast is asked with the same invoice (decision 3).

### Error codes, audit actions and the bell

```diff
@@ -755,6 +755,39 @@ export const ERROR_CODES = [
   // Step 27d.4: a delete refused because the account is chosen on the shop's Payment card (the
   // money or the fee account). Archiving it is allowed: Pay online then leaves the checkout
   'account_used_by_shop',
+  // Step 28a: couriers. On the Shop couriers page: a key with other characters, the first save of
+  // an API account without both keys, a manual account with no courier picked, and the server with
+  // no CREDENTIALS_KEY (the same key the payment gateway's password is sealed with)
+  'courier_key_format',
+  'courier_key_required',
+  'courier_pick_one',
+  'courier_key_missing',
+  // The default or a Packed booking with a manual or archived account (a manual parcel has no code
+  // yet at Packed), a change to an archived account, and an account of another provider in a save
+  // (the provider never changes)
+  'courier_account_not_bookable',
+  'courier_account_archived',
+  'courier_provider_fixed',
+  // Book courier: no account picked, a manual parcel without its tracking code or with other
+  // characters in it, an order that is not packed (or is shipped already), an order with a parcel
+  // on its way, and Book again on a parcel that did not fail
+  'courier_pick_account',
+  'courier_tracking_code_required',
+  'courier_tracking_code_format',
+  'storefront_order_not_bookable',
+  'storefront_order_has_parcel',
+  'storefront_shipment_not_failed',
+  // Cancel after the courier picked the parcel up: it comes back as a return (step 28b)
+  'storefront_order_parcel_on_its_way',
+  // Why a booking failed, kept on the parcel and shown with Book again (decision 4): the courier
+  // refused the keys (the tenant's account, not our bug, §14.6 rule 5), refused the parcel itself
+  // (its own words in errorDetail: "Invalid phone number"), or never answered in time
+  'courier_rejected_keys',
+  'courier_rejected_parcel',
+  'courier_unreachable',
+  // The courier's webhook with no token or the wrong one, or for an account that is not an API
+  // account of this provider. A 401, so the courier's panel shows that something is wrong
+  'courier_webhook_token_invalid',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

```diff
@@ -302,6 +302,20 @@ export const AUDIT_ACTIONS = [
   'storefront_payment_gateway.created',
   'storefront_payment_gateway.updated',
   'storefront_payment_gateway.tested',
+  // Step 28a: the shop's courier accounts (entity = courier_account). Keys and tokens are never in
+  // the changes, only that they changed. The default is the workspace's storefront's change
+  // (entity = storefront, entityId = tenant id). A booking is the order's: booked by a member
+  // (with the account's name and, for a manual parcel, the tracking code) and booked again after
+  // it failed. What the courier reports later writes nothing here: it is on the parcel's events
+  'courier_account.created',
+  'courier_account.updated',
+  'courier_account.tested',
+  'courier_account.token_renewed',
+  'courier_account.archived',
+  'courier_account.restored',
+  'storefront.default_courier_set',
+  'storefront_order.shipment_booked',
+  'storefront_order.shipment_retried',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -368,6 +382,7 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront_order',
   'storefront_coupon',
   'storefront_payment_gateway',
+  'courier_account',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

```diff
@@ -30,6 +30,9 @@ import { pageOf, pageQuerySchema } from './pagination.js';
 // storefront.order_confirmed: params { id, number, total } — a shop order got its phone code
 // (step 27a); sent to the owners and the people with storefront.order.read. total is the amount
 // as a decimal string, which the bell writes as money
+// storefront.shipment_failed: params { id, number, courier } — five tries did not book a shop
+// order's parcel (step 28a, decision 4); sent to the owners and the people with
+// storefront.order.manage, and the bell opens the order. courier = the account's name
 export const NOTIFICATION_TYPES = [
   'workspace.ready',
   'member.joined',
@@ -49,6 +52,7 @@ export const NOTIFICATION_TYPES = [
   'pos.sold_short',
   'pos.shift_variance',
   'storefront.order_confirmed',
+  'storefront.shipment_failed',
 ] as const;
 export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
 
```

```diff
@@ -23,6 +23,7 @@ import { storefrontRoutes } from './storefront-admin.js';
 import { storefrontAppearanceRoutes } from './storefront-appearance.js';
 import { storefrontCouponRoutes } from './storefront-coupons.js';
 import { storefrontOrderRoutes } from './storefront-orders.js';
+import { shippingRoutes } from './shipping.js';
 import { storefrontPaymentRoutes } from './storefront-payments.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
@@ -170,6 +171,7 @@ type Routes = Readonly<{
   storefrontOrders: typeof storefrontOrderRoutes;
   storefrontCoupons: typeof storefrontCouponRoutes;
   storefrontPayments: typeof storefrontPaymentRoutes;
+  shipping: typeof shippingRoutes;
 }>;
 
 // API-র প্রতিটা endpoint এখানে। নতুন মডিউল = এখানে এক লাইন; API-র টেস্ট দেখে যে Nest-এর রুট আর
@@ -255,4 +257,5 @@ export const routes: Routes = {
   storefrontOrders: storefrontOrderRoutes,
   storefrontCoupons: storefrontCouponRoutes,
   storefrontPayments: storefrontPaymentRoutes,
+  shipping: shippingRoutes,
 };
```

```diff
@@ -68,6 +68,7 @@ export * from './storefront-admin.js';
 export * from './storefront-appearance.js';
 export * from './storefront-orders.js';
 export * from './storefront-payments.js';
+export * from './shipping.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
 export * from './suppliers.js';
```

- **Three booking errors** (decision 4): `courier_rejected_keys` (the tenant must fix the account),
  `courier_rejected_parcel` (the order's address or phone), `courier_unreachable` (try later). They are stored on
  the parcel, so the page can say what to do.
- **The webhook's own error** answers 401, so the courier's panel shows that the token is wrong.
- **Keys never appear in an audit entry,** only that they changed. What the courier reports writes no audit entry:
  it is in the parcel's events.
- **`storefront.shipment_failed`** goes to the people who can press "Book again".
- **A new route group needs its line in `Routes` too** (27d.1's note in routes.ts).

```diff
@@ -6898,6 +6898,7 @@ export const en = {
       storefront_order: 'Shop orders',
       storefront_coupon: 'Shop coupons',
       storefront_payment_gateway: 'Shop payment gateway',
+      courier_account: 'Shop couriers',
     },
     columns: {
       when: 'When',
@@ -7229,6 +7230,8 @@ export const en = {
         launched: 'Opened the online shop',
         // Step 26h
         theme_updated: 'Changed the shop’s logo or colors',
+        // Step 28a
+        default_courier_set: 'Chose the courier the shop books with first',
         home_moved: 'Moved a block on the shop’s home page',
         page_saved: 'Wrote or changed a shop page',
         page_deleted: 'Deleted a shop page',
@@ -7263,6 +7266,9 @@ export const en = {
         shipped: 'Marked a shop order shipped',
         delivered: 'Marked a shop order delivered',
         cancelled: 'Cancelled a shop order',
+        // Step 28a
+        shipment_booked: 'Booked a shop order’s parcel with a courier',
+        shipment_retried: 'Booked a shop order’s parcel again after it failed',
       },
       // Step 27c
       storefront_coupon: {
@@ -7277,6 +7283,15 @@ export const en = {
         updated: 'Changed the shop’s payment gateway',
         tested: 'Tested the shop’s payment gateway',
       },
+      // Step 28a
+      courier_account: {
+        created: 'Added a courier account',
+        updated: 'Changed a courier account',
+        tested: 'Tested a courier account',
+        token_renewed: 'Made a new webhook token for a courier account',
+        archived: 'Archived a courier account',
+        restored: 'Restored an archived courier account',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -7641,6 +7656,9 @@ export const en = {
       // Step 27a: a shop order got its phone code. {{total}} arrives as money ("৳578")
       storefront: {
         order_confirmed: 'New shop order {{number}} for {{total}}.',
+        // Step 28a: {{courier}} is the account's name ("Steadfast")
+        shipment_failed:
+          '{{courier}} did not book the parcel of {{number}}. Open the order to book it again.',
       },
     },
   },
@@ -8480,6 +8498,34 @@ export const en = {
       'This server cannot keep a gateway password yet. Ask whoever runs Omnivo for you to set CREDENTIALS_KEY.',
     account_used_by_shop:
       'The shop’s online payments use this account. Choose another one in Shop settings → Online payment first, or archive it.',
+    // Step 28a
+    courier_key_format:
+      'Type the key as the courier’s panel shows it: letters and digits, with no spaces.',
+    courier_key_required: 'Type both keys from the courier’s panel.',
+    courier_pick_one: 'Pick the courier you book these parcels with.',
+    courier_key_missing:
+      'This server cannot keep a courier’s keys yet. Ask whoever runs Omnivo for you to set CREDENTIALS_KEY.',
+    courier_account_not_bookable:
+      'Pick an active courier account that books by its API. A manual one is booked with Book courier, once the courier gives you its code.',
+    courier_account_archived: 'This courier account is archived. Restore it to change it.',
+    courier_provider_fixed:
+      'A courier account’s courier can’t change. Add a new account for the other courier.',
+    courier_pick_account: 'Pick the courier account to send the parcel with.',
+    courier_tracking_code_required: 'Type the tracking code the courier gave for this parcel.',
+    courier_tracking_code_format:
+      'Type the tracking code as the courier shows it: letters, digits and dashes.',
+    storefront_order_not_bookable: 'Only a packed order goes to a courier. Mark it packed first.',
+    storefront_order_has_parcel:
+      'This order’s parcel is on its way already. Reload the page to see it.',
+    storefront_shipment_not_failed: 'This parcel did not fail. Reload the page to see where it is.',
+    storefront_order_parcel_on_its_way:
+      'The courier has the parcel now, so the order can’t be cancelled. Ask the courier to return it.',
+    courier_rejected_keys:
+      'The courier refused the account’s keys. Check them in Shop couriers, then book again.',
+    courier_rejected_parcel: 'The courier refused the parcel. Fix what it says, then book again.',
+    courier_unreachable: 'The courier did not answer. Book again in a few minutes.',
+    courier_webhook_token_invalid:
+      'This webhook token is not right. Paste the token from Shop couriers.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -6361,6 +6361,7 @@ export const bn: Messages = {
       storefront_order: 'শপের অর্ডার',
       storefront_coupon: 'শপের কুপন',
       storefront_payment_gateway: 'শপের পেমেন্ট গেটওয়ে',
+      courier_account: 'শপের কুরিয়ার',
     },
     columns: {
       when: 'কখন',
@@ -6681,6 +6682,8 @@ export const bn: Messages = {
         launched: 'অনলাইন শপ খুলেছেন',
         // ধাপ ২৬h
         theme_updated: 'শপের লোগো বা রং বদলেছেন',
+        // Step 28a
+        default_courier_set: 'শপ প্রথমে কোন কুরিয়ারে বুক করবে তা বেছেছেন',
         home_moved: 'শপের হোম পেজের একটা ব্লক সরিয়েছেন',
         page_saved: 'শপের একটা পেজ লিখেছেন বা বদলেছেন',
         page_deleted: 'শপের একটা পেজ মুছেছেন',
@@ -6714,6 +6717,9 @@ export const bn: Messages = {
         shipped: 'শপের অর্ডার পাঠানো হয়েছে বলে চিহ্ন দিয়েছেন',
         delivered: 'শপের অর্ডার পৌঁছেছে বলে চিহ্ন দিয়েছেন',
         cancelled: 'শপের অর্ডার বাতিল করেছেন',
+        // Step 28a
+        shipment_booked: 'শপের অর্ডারের পার্সেল কুরিয়ারে বুক করেছেন',
+        shipment_retried: 'বুকিং ব্যর্থ হওয়ার পর শপের অর্ডারের পার্সেল আবার বুক করেছেন',
       },
       // Step 27c
       storefront_coupon: {
@@ -6728,6 +6734,15 @@ export const bn: Messages = {
         updated: 'শপের পেমেন্ট গেটওয়ে বদলেছেন',
         tested: 'শপের পেমেন্ট গেটওয়ে পরীক্ষা করেছেন',
       },
+      // Step 28a
+      courier_account: {
+        created: 'কুরিয়ার অ্যাকাউন্ট যোগ করেছেন',
+        updated: 'কুরিয়ার অ্যাকাউন্ট বদলেছেন',
+        tested: 'কুরিয়ার অ্যাকাউন্ট পরীক্ষা করেছেন',
+        token_renewed: 'কুরিয়ার অ্যাকাউন্টের নতুন webhook token বানিয়েছেন',
+        archived: 'কুরিয়ার অ্যাকাউন্ট আর্কাইভ করেছেন',
+        restored: 'আর্কাইভ করা কুরিয়ার অ্যাকাউন্ট ফিরিয়ে এনেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -7071,6 +7086,9 @@ export const bn: Messages = {
       // Step 27a: a shop order got its phone code. {{total}} arrives as money ("৳578")
       storefront: {
         order_confirmed: 'শপে নতুন অর্ডার {{number}}, মোট {{total}}।',
+        // Step 28a: {{courier}} is the account's name ("Steadfast")
+        shipment_failed:
+          '{{courier}} {{number}}-এর পার্সেল বুক করেনি। আবার বুক করতে অর্ডারটা খুলুন।',
       },
     },
   },
@@ -7875,6 +7893,36 @@ export const bn: Messages = {
       'এই সার্ভার এখনো পেমেন্ট গেটওয়ের পাসওয়ার্ড রাখতে পারে না। যিনি আপনার Omnivo চালান, তাঁকে CREDENTIALS_KEY সেট করতে বলুন।',
     account_used_by_shop:
       'শপের অনলাইন পেমেন্ট এই অ্যাকাউন্ট ব্যবহার করে। আগে শপের সেটিংস → অনলাইন পেমেন্ট থেকে অন্য একটা বাছুন, অথবা এটা আর্কাইভ করুন।',
+    // Step 28a
+    courier_key_format:
+      'কুরিয়ারের প্যানেলে যেভাবে দেখায় সেভাবে key লিখুন: অক্ষর আর অঙ্ক, কোনো স্পেস ছাড়া।',
+    courier_key_required: 'কুরিয়ারের প্যানেল থেকে দুটো key-ই লিখুন।',
+    courier_pick_one: 'এই পার্সেলগুলো যে কুরিয়ারে বুক করেন সেটা বাছুন।',
+    courier_key_missing:
+      'এই সার্ভার এখনো কুরিয়ারের key রাখতে পারে না। যিনি আপনার Omnivo চালান, তাঁকে CREDENTIALS_KEY সেট করতে বলুন।',
+    courier_account_not_bookable:
+      'API দিয়ে বুক করে এমন একটা চালু কুরিয়ার অ্যাকাউন্ট বাছুন। ম্যানুয়াল অ্যাকাউন্টে বুক হয় "কুরিয়ারে বুক করুন" দিয়ে, কুরিয়ার কোড দেওয়ার পরে।',
+    courier_account_archived: 'এই কুরিয়ার অ্যাকাউন্ট আর্কাইভ করা। বদলাতে আগে ফিরিয়ে আনুন।',
+    courier_provider_fixed:
+      'কুরিয়ার অ্যাকাউন্টের কুরিয়ার বদলানো যায় না। অন্য কুরিয়ারের জন্য নতুন অ্যাকাউন্ট যোগ করুন।',
+    courier_pick_account: 'পার্সেলটা কোন কুরিয়ার অ্যাকাউন্টে যাবে সেটা বাছুন।',
+    courier_tracking_code_required: 'এই পার্সেলের জন্য কুরিয়ারের দেওয়া ট্র্যাকিং কোড লিখুন।',
+    courier_tracking_code_format:
+      'কুরিয়ার যেভাবে দেখায় সেভাবে ট্র্যাকিং কোড লিখুন: অক্ষর, অঙ্ক আর ড্যাশ।',
+    storefront_order_not_bookable:
+      'শুধু প্যাক করা অর্ডারই কুরিয়ারে যায়। আগে প্যাক হয়েছে বলে চিহ্ন দিন।',
+    storefront_order_has_parcel: 'এই অর্ডারের পার্সেল আগেই রওনা হয়েছে। দেখতে পেজটা আবার লোড করুন।',
+    storefront_shipment_not_failed:
+      'এই পার্সেলের বুকিং ব্যর্থ হয়নি। কোথায় আছে দেখতে পেজটা আবার লোড করুন।',
+    storefront_order_parcel_on_its_way:
+      'পার্সেল এখন কুরিয়ারের কাছে, তাই অর্ডার বাতিল করা যাবে না। কুরিয়ারকে ফেরত দিতে বলুন।',
+    courier_rejected_keys:
+      'কুরিয়ার অ্যাকাউন্টের key মানেনি। শপের কুরিয়ার পেজে key দেখে নিন, তারপর আবার বুক করুন।',
+    courier_rejected_parcel:
+      'কুরিয়ার পার্সেলটা নেয়নি। কুরিয়ার যা বলেছে তা ঠিক করে আবার বুক করুন।',
+    courier_unreachable: 'কুরিয়ার উত্তর দেয়নি। কয়েক মিনিট পরে আবার বুক করুন।',
+    courier_webhook_token_invalid:
+      'এই webhook token ঠিক না। শপের কুরিয়ার পেজ থেকে token পেস্ট করুন।',
   },
   ui: {
     dataTable: {
```

The words of every new code, action and bell kind. They go in now, because `satisfies Record<ErrorCode, string>`
fails the i18n type check the moment a code has no words.

### Tests

```ts
import { describe, expect, it } from 'vitest';

import {
  bookShipmentInputSchema,
  courierAccountSchema,
  createCourierAccountInputSchema,
  isOpenShipment,
  OPEN_SHIPMENT_STATUSES,
  SHIPMENT_STATUSES,
  shippingRoutes,
  steadfastWebhookSchema,
  updateCourierAccountInputSchema,
} from './shipping.js';
import { SHOP_SHIPMENT_STATUSES } from './storefront.js';
import { storefrontOrderRoutes } from './storefront-orders.js';

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

const ACCOUNT = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';

// Keys as Steadfast's panel shows them (made up, the same shape)
const STEADFAST = {
  provider: 'steadfast',
  name: 'Steadfast',
  apiKey: 'xk2j9tqlm4n8vbc0r7pd',
  secretKey: 'h6s1w3fz9ye2u5ia8og0',
} as const;

describe('the courier account form', () => {
  it('needs both keys the first time, and keeps a saved one when its box is empty later', () => {
    expect(
      errorsOf(createCourierAccountInputSchema.safeParse({ ...STEADFAST, apiKey: '' })),
    ).toEqual({ apiKey: ['courier_key_required'] });
    const later = updateCourierAccountInputSchema.parse({
      ...STEADFAST,
      apiKey: '',
      secretKey: '',
      version: 2,
    });
    expect(later).toMatchObject({ apiKey: '', secretKey: '' });
  });

  it('trims a pasted key, and refuses one with other characters', () => {
    const parsed = createCourierAccountInputSchema.parse({ ...STEADFAST, apiKey: ' abc123 ' });
    expect(parsed.provider === 'steadfast' && parsed.apiKey).toBe('abc123');
    expect(
      errorsOf(createCourierAccountInputSchema.safeParse({ ...STEADFAST, secretKey: 'a b' })),
    ).toEqual({ secretKey: ['courier_key_format'] });
  });

  it('asks a manual account for its courier, never for keys', () => {
    const manual = { provider: 'manual', name: 'Pathao (by hand)' };
    expect(errorsOf(createCourierAccountInputSchema.safeParse({ ...manual, courier: '' }))).toEqual(
      { courier: ['courier_pick_one'] },
    );
    const parsed = createCourierAccountInputSchema.parse({
      ...manual,
      courier: 'pathao',
      apiKey: 'ignored',
    });
    expect(parsed).not.toHaveProperty('apiKey');
  });

  it('refuses a provider it does not know', () => {
    expect(
      createCourierAccountInputSchema.safeParse({ ...STEADFAST, provider: 'redx' }).success,
    ).toBe(false);
  });
});

describe('the saved account', () => {
  it('never has a key or the webhook token', () => {
    const parsed = courierAccountSchema.parse({
      id: ACCOUNT,
      provider: 'steadfast',
      name: 'Steadfast',
      courier: 'steadfast',
      status: 'active',
      webhookUrl: `https://api.omnivosoft.com/public/v1/couriers/steadfast/${ACCOUNT}`,
      hasWebhookToken: true,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
      updatedAt: '2026-11-22T10:00:00.000Z',
      apiKey: 'leaked',
      webhookToken: 'leaked',
    });
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed).not.toHaveProperty('webhookToken');
  });
});

describe('a parcel', () => {
  it("has the shop's ten statuses and two of the ERP's own before them", () => {
    expect(SHIPMENT_STATUSES).toEqual(['booking', 'booking_failed', ...SHOP_SHIPMENT_STATUSES]);
  });

  it('is on its way until it is delivered, returned, cancelled or failed', () => {
    expect(OPEN_SHIPMENT_STATUSES).toContain('on_hold');
    const closed = SHIPMENT_STATUSES.filter((status) => !isOpenShipment(status));
    expect(closed).toEqual([
      'booking_failed',
      'delivered',
      'partly_delivered',
      'returned',
      'cancelled',
    ]);
  });

  it('upper-cases a typed tracking code, and refuses one with a space', () => {
    const base = { version: 3, accountId: ACCOUNT };
    expect(
      bookShipmentInputSchema.parse({ ...base, trackingCode: ' sfr-2611 ' }).trackingCode,
    ).toBe('SFR-2611');
    expect(
      errorsOf(bookShipmentInputSchema.safeParse({ ...base, trackingCode: 'SFR 26' })),
    ).toEqual({ trackingCode: ['courier_tracking_code_format'] });
    expect(
      errorsOf(bookShipmentInputSchema.safeParse({ ...base, accountId: '', trackingCode: '' })),
    ).toEqual({ accountId: ['courier_pick_account'] });
  });
});

describe("Steadfast's webhook", () => {
  it('keeps the fields it does not know, and takes the consignment id as a number', () => {
    const parsed = steadfastWebhookSchema.parse({
      notification_type: 'delivery_status',
      consignment_id: 1424107,
      invoice: 'W-000123',
      status: 'delivered',
      cod_amount: 578,
    });
    expect(parsed.consignment_id).toBe(1424107);
    expect(parsed).toHaveProperty('cod_amount', 578);
  });

  it('never refuses a notice for its shape: the handler keeps an unknown one raw', () => {
    expect(steadfastWebhookSchema.safeParse({}).success).toBe(true);
    expect(steadfastWebhookSchema.safeParse({ status: 7 }).success).toBe(false);
  });
});

describe('the routes', () => {
  it('set up the accounts with storefront.manage, under /storefront/couriers', () => {
    const { steadfastWebhook, ...accountRoutes } = shippingRoutes;
    for (const route of Object.values(accountRoutes)) {
      expect(route.auth).toBe('bearer');
      expect(route.permission).toBe('storefront.manage');
      expect(route.path.startsWith('/storefront/couriers')).toBe(true);
    }
    expect(steadfastWebhook).toMatchObject({ auth: 'public', method: 'POST' });
    expect('permission' in steadfastWebhook).toBe(false);
  });

  it('tests what is saved, so the test sends no key', () => {
    expect('body' in shippingRoutes.testCourier).toBe(false);
  });

  it('book with storefront.order.manage, like every other move of an order', () => {
    const { bookShipment, retryShipment, courierExport } = storefrontOrderRoutes;
    for (const route of [bookShipment, retryShipment, courierExport]) {
      expect(route.permission).toBe('storefront.order.manage');
    }
  });
});
```

The account form (both keys the first time, an empty key kept later, a trimmed key, a key with a space, a manual
account without a courier and without keys), the saved account without a key or a token, the parcel's statuses
and which are on their way, the tracking code, the webhook kept loose, and every route's permission.

```diff
@@ -43,6 +43,7 @@ const PACK: PackStorefrontOrderFormValues = {
       picks: [{ batchId: '', quantity: '1', serialNumbers: ['356938035643809'] }],
     },
   ],
+  courierAccountId: '',
 };
 
 describe('the statuses the ERP shows', () => {
@@ -66,6 +67,14 @@ describe('the statuses the ERP shows', () => {
 });
 
 describe('Packed', () => {
+  it('books with the courier the dialog picked, and "Don\'t book now" as null (step 28a)', () => {
+    expect(packStorefrontOrderInputSchema.parse(PACK).courierAccountId).toBeNull();
+    const courier = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';
+    expect(
+      packStorefrontOrderInputSchema.parse({ ...PACK, courierAccountId: courier }).courierAccountId,
+    ).toBe(courier);
+  });
+
   it('takes a line split over two batches, and no batch as null', () => {
     const parsed = packStorefrontOrderInputSchema.parse(PACK);
     expect(parsed.lines[0]?.picks.map((pick) => pick.batchId)).toEqual([BATCH_A, BATCH_B]);
@@ -108,6 +117,7 @@ describe('Packed', () => {
         { position: 1, picks: [{ batchId: BATCH_A, quantity: '0', serialNumbers: [] }] },
         { position: 2, picks: [] },
       ],
+      courierAccountId: '',
     });
     expect(Object.keys(errorsOf(result)).sort()).toEqual([
       'lines.0.picks.0.quantity',
@@ -165,10 +175,14 @@ describe('the routes', () => {
   });
 
   // Decision 9: a packer reads and moves orders without storefront.manage (the shop's prices and
-  // pages), and every move is .manage, never .read
+  // pages), and every move is .manage, never .read. Two reads are .manage too: the pack plan, and
+  // (step 28a) the courier export, which is for booking and holds many shoppers' phones at once
   it('read with storefront.order.read and change with storefront.order.manage', () => {
     for (const route of routes) {
-      const changes = route.method !== 'GET' || route.path.endsWith('/pack-plan');
+      const changes =
+        route.method !== 'GET' ||
+        route.path.endsWith('/pack-plan') ||
+        route.path.endsWith('/courier-export');
       expect([route.path, route.permission]).toEqual([
         route.path,
         changes ? 'storefront.order.manage' : 'storefront.order.read',
```

Packed with and without a courier. The test of every route's permission now knows that the courier export is a read
with `storefront.order.manage`: it holds many shoppers' phones and addresses at once, and it is for booking.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/contracts test        # 681 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
```

Two things fail until later parts, on purpose:

- `pnpm --filter @omnivo/api typecheck`: the order view (`storefront-orders.service.ts`) has no `codAmount` and
  `shipments` yet (28a.3). `apps/api/src/contract.spec.ts` also fails: the contract has routes the API does not
  serve yet.
- `pnpm --filter @omnivo/app typecheck`: the bell's link map has no `storefront.shipment_failed`, the pack form and
  the mock order have no `courierAccountId`, `codAmount` and `shipments` (28a.6 and 28a.7).

Broken on purpose while this part was written, each caught:

- `courierTrackingCodeSchema` without `.toUpperCase()`: "upper-cases a typed tracking code" fails.
- `delivered` added to `OPEN_SHIPMENT_STATUSES`: "is on its way until it is delivered…" fails.

## 28a.2 — Database

Three new tables: `courier_accounts` (the shop's courier accounts), `storefront_shipments` (one row per parcel)
and `storefront_shipment_events` (what the courier said about a parcel, one row per step). Two migrations, as in
27a, 27c and 27d: drizzle-kit writes the tables, the keys and the checks (0077); a hand-written one gives the
tables their tenant rules, lets the tracking page read a parcel's way, lets the worker's poll find the workspaces
with parcels on their way, finds a webhook's account before the workspace is known, and keeps what must not
change (0078). No outbox event type yet: the API's maps of events are exhaustive, so the event comes in 28a.3 with
its handler (27d.2's mine 26).

Mine, made while writing this part:

24. **The default is a flag on the account** (`is_default`, one per workspace), not a column on
    `storefront_settings`. The Shop couriers page then works before the shop is set up (the settings row does not
    exist yet), and "the default is an active API account" is a check on one row, with no trigger.
25. **A parcel has a number (1 to 5) and an invoice.** The invoice is what the courier is told: the order number
    for the first parcel, then `W-000123-2`. Decision 3's `UNIQUE (tenant_id, order_id, courier_account_id)` would
    stop the shop from booking again with the same courier after a cancelled parcel, and Steadfast refuses an
    invoice it has seen anyway. So the database keeps decision 3's two promises another way: one invoice per
    courier account (a retry can never make a second parcel), and one parcel on its way per order.
26. **Each event has a key the API makes** (a SHA-256 of the status, the time and the note). The webhook and the
    poll often say the same thing, and a courier sends a notice again when our answer was slow; the key makes the
    second one a no-op.
27. **The tracking page reads the parcels as `omnivo_shop`,** because a tracking link and `/track` run inside
    `ShopDb.orders` (27a). Only the columns the page shows, and two RESTRICTIVE policies hide a parcel that is still
    booking or failed (mine 17) and a notice we could not read.

### The courier accounts

```ts
import {
  COURIER_OF_PROVIDER,
  COURIER_PROVIDERS,
  COURIER_TEST_PROBLEMS,
  OPEN_SHIPMENT_STATUSES,
  SHIPMENT_STATUSES,
  SHOP_COURIERS,
  SHOP_SHIPMENT_STATUSES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  jsonb,
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
import { storefrontOrders } from './storefront-orders.js';
import { tenants } from './tenants.js';

// Step 28a: couriers (system design §14.6). The shop's courier accounts, the parcels its orders
// are sent in, and what the courier said about each parcel. Migration 0078 gives the three tables
// their rules.

// Raw bytes, as in storefront-payments.ts and sync.ts: drizzle 0.45 has no bytea column
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// A list from the contracts as SQL ('booking', 'booked', …). Written by code only, never by a
// person, so sql.raw is safe here
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

// The provider and courier pairs of the API accounts, as SQL: ('steadfast', 'steadfast'). Read
// from COURIER_OF_PROVIDER, so 28c's Pathao gets its pair here without a new line
const API_PAIRS = sql.raw(
  Object.entries(COURIER_OF_PROVIDER)
    .map(([provider, courier]) => `('${provider}', '${courier}')`)
    .join(', '),
);

// A SHA-256 in lower-case hex, like a tracking link's token hash
const HASH_PATTERN = '^[0-9a-f]{64}$';

// AES-256-GCM's nonce and tag are 12 and 16 bytes. The sealed text is the JSON of the two keys
// ({"apiKey":"…","secretKey":"…"}), at most 427 bytes with two 200-character keys
const SEALED_MIN_BYTES = 12 + 16 + 1;
const SEALED_MAX_BYTES = 12 + 16 + 512;

// One courier account of the shop (decisions 7, 8 and 14). An API account (Steadfast) has its
// sealed keys and its webhook token's hash; a manual account has neither, only the courier it
// books with. Archived, never deleted: a parcel keeps its account
export const courierAccounts = pgTable(
  'courier_accounts',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    // Never changes once saved (0078's guard): the keys, the webhook and the parcels are the
    // provider's
    provider: text('provider', { enum: COURIER_PROVIDERS }).notNull(),
    name: text('name').notNull(),
    // The courier the tracking page names. An API account's own (the pair check below); a manual
    // account's pick, which may change: each parcel copies it when it is booked
    courier: text('courier', { enum: SHOP_COURIERS }).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // The Packed dialog's first choice (mine 24). At most one per workspace (the index below)
    isDefault: boolean('is_default').notNull().default(false),
    // The two keys, sealed by the API with CREDENTIALS_KEY (27d's way), and the key's number
    keysSealed: bytea('keys_sealed'),
    keyVersion: smallint('key_version'),
    // The webhook's bearer token, only its SHA-256 (decision 8): shown once, never kept
    webhookTokenHash: text('webhook_token_hash'),
    // When the courier's webhook last came with the right token (mine 16)
    lastWebhookAt: timestamp('last_webhook_at', { withTimezone: true }),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestProblem: text('last_test_problem', { enum: COURIER_TEST_PROBLEMS }),
  },
  (table) => [
    // The target of the parcels' foreign key (a constraint, for 0070's reason)
    unique('courier_accounts_tenant_id_key').on(table.tenantId, table.id),
    // One default per workspace. A second one fails here, so the API clears the old one first
    uniqueIndex('courier_accounts_default_idx')
      .on(table.tenantId)
      .where(sql`${table.isDefault}`),
    check(
      'courier_accounts_values_check',
      sql`${table.provider} IN (${sqlList(COURIER_PROVIDERS)})
        AND ${table.courier} IN (${sqlList(SHOP_COURIERS)})
        AND (${table.lastTestProblem} IS NULL OR ${table.lastTestProblem} IN (${sqlList(COURIER_TEST_PROBLEMS)}))`,
    ),
    // An API account is its own courier; a manual one picks any of the five
    check(
      'courier_accounts_courier_check',
      sql`${table.provider} = 'manual' OR (${table.provider}, ${table.courier}) IN (${API_PAIRS})`,
    ),
    check('courier_accounts_name_check', sql`char_length(${table.name}) BETWEEN 1 AND 60`),
    // An API account has its keys and its token; a manual account has none of them, and is never
    // tested (there is nothing to call)
    check(
      'courier_accounts_secrets_check',
      sql`CASE ${table.provider}
          WHEN 'manual' THEN num_nonnulls(${table.keysSealed}, ${table.keyVersion},
            ${table.webhookTokenHash}, ${table.lastWebhookAt}, ${table.lastTestedAt},
            ${table.lastTestProblem}) = 0
          ELSE num_nonnulls(${table.keysSealed}, ${table.keyVersion}, ${table.webhookTokenHash}) = 3
            AND octet_length(${table.keysSealed}) BETWEEN ${sql.raw(String(SEALED_MIN_BYTES))} AND ${sql.raw(String(SEALED_MAX_BYTES))}
            AND ${table.keyVersion} >= 1
            AND ${table.webhookTokenHash} ~ '${sql.raw(HASH_PATTERN)}'
        END`,
    ),
    check(
      'courier_accounts_test_check',
      sql`${table.lastTestProblem} IS NULL OR ${table.lastTestedAt} IS NOT NULL`,
    ),
    // The default books at Packed, so it is an active API account (decision 13)
    check(
      'courier_accounts_default_check',
      sql`NOT ${table.isDefault} OR (${table.provider} <> 'manual' AND ${table.archivedAt} IS NULL)`,
    ),
  ],
);
```

- **`bytea` and `sqlList()` are defined again** here, as in `storefront-payments.ts`. Each is three lines, and
  exporting them from a table file would make one table file import another for a helper.
- **`API_PAIRS` is read from `COURIER_OF_PROVIDER`.** 28c's Pathao then gets its `('pathao', 'pathao')` pair in the
  check without a new line here. `sql.raw` is safe for the same reason as `sqlList()`: the values come from code.
- **`created_by` is kept** (the payment gateway has none): a workspace can have several accounts, and the audit log
  is not the only place that should say who added one.
- **`archived_at`, not a status column.** The contract's `status` is worked out from it (`active` while it is
  NULL), and the time is there for free. There is no delete (0078's guard): a parcel names its account.
- **`is_default` with a partial unique index** (mine 24). Setting a new default must clear the old one in the same
  transaction, or the index refuses it; 28a.3 does both in one statement.
- **`keys_sealed` holds both keys in one box:** the API seals the JSON `{"apiKey":…,"secretKey":…}` with 27d's
  sealing. One box, one nonce and one key version, so the two keys can never be sealed with two different keys.
  The check's bounds are 27d's: 29 bytes at least, 540 at most (two 200-character keys are 427 bytes of JSON).
- **`courier_accounts_secrets_check`** gives each provider exactly its columns. A manual account has no keys, no
  token, no webhook time and no test: there is nothing to call. An API account always has its keys and its token's
  hash: the token is made with the account (28a.1's `courierAccountSavedSchema`), and a new token replaces it.
- **`courier_accounts_default_check`:** the default books at Packed, so it is an API account that is not archived
  (decision 13). Archiving the default fails here until the API clears the flag in the same update.

### The parcels

```ts
// One parcel of a shop order (decisions 2 to 5). Made by Packed or "Book courier" in `booking`
// (an API account) or `booked` (a manual one, with the code the member typed). "Book again" works
// on the same row, so the courier is asked with the same invoice. Never deleted (0078)
export const storefrontShipments = pgTable(
  'storefront_shipments',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdAt: baseColumns().createdAt,
    // The member who booked it
    createdBy: baseColumns().createdBy,
    updatedAt: baseColumns().updatedAt,
    orderId: uuid('order_id').notNull(),
    courierAccountId: uuid('courier_account_id').notNull(),
    // 1 to 5, the order's parcels in the order they were made (mine 25)
    parcelNo: smallint('parcel_no').notNull(),
    // What the courier was told as its "invoice": the order number, with "-2" to "-5" after it
    // for a later parcel (mine 25). The courier finds the parcel by it, and so do we after a timeout
    invoice: text('invoice').notNull(),
    // The account's courier when it was booked (a manual account may pick another one later)
    courier: text('courier', { enum: SHOP_COURIERS }).notNull(),
    status: text('status', { enum: SHIPMENT_STATUSES }).notNull().default('booking'),
    consignmentId: text('consignment_id'),
    trackingCode: text('tracking_code'),
    // The courier's own tracking page, https only (it goes into an <a href> on the shop)
    trackingUrl: text('tracking_url'),
    // What the rider collects, fixed when it was booked (28a.1)
    codAmount: numeric('cod_amount', { precision: 19, scale: 4 }).notNull(),
    bookedAt: timestamp('booked_at', { withTimezone: true }),
    // Calls made to book it, and why the last one failed: one of our codes, and the courier's own
    // sentence. Kept while it still books, so the page can say what went wrong last time
    attempts: smallint('attempts').notNull().default(0),
    error: text('error'),
    errorDetail: text('error_detail'),
    // When the courier last told us anything (the webhook or the poll)
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (table) => [
    unique('storefront_shipments_tenant_id_key').on(table.tenantId, table.id),
    // The order's parcels, oldest first (the order page), and at most five: a sixth has no number
    unique('storefront_shipments_parcel_key').on(table.tenantId, table.orderId, table.parcelNo),
    // One invoice per courier account (decision 3): a retry can never make a second parcel at the
    // courier, and the webhook's invoice names one parcel
    unique('storefront_shipments_invoice_key').on(
      table.tenantId,
      table.courierAccountId,
      table.invoice,
    ),
    // The webhook and the poll find a parcel by the courier's id
    uniqueIndex('storefront_shipments_consignment_idx')
      .on(table.tenantId, table.courierAccountId, table.consignmentId)
      .where(sql`${table.consignmentId} IS NOT NULL`),
    // One parcel on its way per order, whichever account (decision 3, and 28a.1's "an order with
    // one cannot be booked again"). Two Packed or Book courier at once: the second fails here. The
    // contracts' list, so this index and isOpenShipment() can never disagree
    uniqueIndex('storefront_shipments_open_idx')
      .on(table.tenantId, table.orderId)
      .where(sql`${table.status} IN (${sqlList(OPEN_SHIPMENT_STATUSES)})`),
    // The poll's read: the parcels still on their way, least recently heard from first
    index('storefront_shipments_poll_idx')
      .on(table.tenantId, table.lastSyncedAt)
      .where(sql`${table.status} IN (${sqlList(OPEN_SHIPMENT_STATUSES)})`),
    foreignKey({
      name: 'storefront_shipments_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }),
    foreignKey({
      name: 'storefront_shipments_account_fk',
      columns: [table.tenantId, table.courierAccountId],
      foreignColumns: [courierAccounts.tenantId, courierAccounts.id],
    }),
    check(
      'storefront_shipments_values_check',
      sql`${table.status} IN (${sqlList(SHIPMENT_STATUSES)})
        AND ${table.courier} IN (${sqlList(SHOP_COURIERS)})`,
    ),
    // At most five parcels. That the invoice is the order's number with this parcel's "-2" is
    // 0078's trigger: a check cannot read the order
    check('storefront_shipments_parcel_check', sql`${table.parcelNo} BETWEEN 1 AND 5`),
    // Before the courier answered (booking, booking_failed) there is no code and no booking time;
    // after, both. A failed booking says why; a booked parcel has no booking error left
    check(
      'storefront_shipments_status_check',
      sql`CASE WHEN ${table.status} IN ('booking', 'booking_failed')
          THEN num_nonnulls(${table.consignmentId}, ${table.trackingCode}, ${table.trackingUrl}, ${table.bookedAt}) = 0
          ELSE num_nonnulls(${table.trackingCode}, ${table.bookedAt}) = 2
            AND num_nonnulls(${table.error}, ${table.errorDetail}) = 0
        END
        AND (${table.status} <> 'booking_failed' OR ${table.error} IS NOT NULL)`,
    ),
    check(
      'storefront_shipments_text_check',
      sql`(${table.trackingCode} IS NULL OR ${table.trackingCode} ~ '^[A-Z0-9-]{1,64}$')
        AND (${table.consignmentId} IS NULL OR char_length(${table.consignmentId}) BETWEEN 1 AND 64)
        AND (${table.trackingUrl} IS NULL OR (${table.trackingUrl} LIKE 'https://%' AND char_length(${table.trackingUrl}) <= 300))
        AND (${table.error} IS NULL OR ${table.error} ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (${table.errorDetail} IS NULL OR char_length(${table.errorDetail}) BETWEEN 1 AND 300)`,
    ),
    check(
      'storefront_shipments_amounts_check',
      sql`${table.codAmount} >= 0 AND ${table.codAmount} = round(${table.codAmount}, 2)
        AND ${table.attempts} >= 0`,
    ),
  ],
);
```

- **The columns are the contract's `storefrontShipmentSchema`** (28a.1), plus `parcel_no`, `invoice` and
  `tracking_url`, which the API needs and the ERP's page does not show.
- **`courier` is copied from the account** when the parcel is made. A manual account may switch its courier later,
  and a parcel already with RedX is still with RedX.
- **`storefront_shipments_parcel_key` (`tenant_id`, `order_id`, `parcel_no`)** is the order page's read, oldest
  first, and the limit of five (`parcel_no BETWEEN 1 AND 5`): a sixth parcel has no number to take. The same trick
  as 27d's `try_no`.
- **`storefront_shipments_invoice_key`** (mine 25): one invoice per courier account. Two workers that both think
  they are booking parcel 1 cannot both write it, and a webhook's invoice always names one parcel.
- **`storefront_shipments_open_idx`** is the second promise: one parcel on its way per order, whichever account.
  Two Packed (or Packed and Book courier) at the same moment: the second waits for the first and then fails here.
  The status list is the contracts' `OPEN_SHIPMENT_STATUSES`, so this index, the poll's index and
  `isOpenShipment()` never disagree.
- **`storefront_shipments_poll_idx`**: the poll reads a workspace's open parcels, least recently heard from first,
  and stops at a batch (decision 9).
- **No `ON DELETE` on either foreign key.** A confirmed order is never deleted, an account is never deleted, and a
  parcel is never deleted (0078). A pending order cannot have a parcel (0078's trigger), so 27a's sweep never meets
  one.
- **`storefront_shipments_status_check`** gives each state its columns. Before the courier answered (`booking`,
  `booking_failed`) there is no courier id, code, page or booking time. After, a code and a booking time, and no
  booking error. `booking` may keep the last try's error (the page says what went wrong last time while it tries
  again); `booking_failed` must have one. A manual parcel has no courier id: only the code the member typed.
- **`storefront_shipments_text_check`**: the code in the contracts' form (upper case, letters, digits and dashes),
  the courier's page https only (it goes into an `<a href>` on the shop), the error a code, never a message, and the
  courier's sentence at most 300 characters, like the tracking page's note. 28a.3 cuts a longer one.
- **`cod_amount` to the paisa, and never below zero.** A paid online order still gets a parcel, with 0 to collect.

### The courier's news

```ts
// What the courier said about a parcel, one row per step (the tracking page's dots). Append-only
// (0078): the courier's news is a record, and a later notice adds a row
export const storefrontShipmentEvents = pgTable(
  'storefront_shipment_events',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    shipmentId: uuid('shipment_id').notNull(),
    // Where the parcel was then, in our words. NULL: a notice we could not read (decision 22),
    // kept with its body in `raw` and shown nowhere
    status: text('status', { enum: SHOP_SHIPMENT_STATUSES }),
    // The courier's own words ("Customer not reachable"), as the tracking page shows them
    note: text('note'),
    // When it happened, by the courier's clock (or ours, when it gives none)
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // How it came: the booking itself, a member (a manual parcel), the webhook or the poll
    source: text('source', { enum: ['booking', 'member', 'webhook', 'poll'] }).notNull(),
    // The API's own key for this step (a hash of the status, the time and the note): the same
    // notice twice, or the webhook and the poll saying the same thing, is one row (mine 26)
    eventKey: text('event_key').notNull(),
    // The courier's body as it came, for debugging (§14.7). Never a key or a token
    raw: jsonb('raw'),
  },
  (table) => [
    unique('storefront_shipment_events_key').on(table.tenantId, table.shipmentId, table.eventKey),
    // A parcel's events, oldest first
    index('storefront_shipment_events_shipment_idx').on(
      table.tenantId,
      table.shipmentId,
      table.occurredAt,
    ),
    foreignKey({
      name: 'storefront_shipment_events_shipment_fk',
      columns: [table.tenantId, table.shipmentId],
      foreignColumns: [storefrontShipments.tenantId, storefrontShipments.id],
    }),
    check(
      'storefront_shipment_events_values_check',
      sql`(${table.status} IS NULL OR ${table.status} IN (${sqlList(SHOP_SHIPMENT_STATUSES)}))
        AND ${table.source} IN ('booking', 'member', 'webhook', 'poll')
        AND (${table.status} IS NOT NULL OR ${table.raw} IS NOT NULL)`,
    ),
    check(
      'storefront_shipment_events_text_check',
      sql`(${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 300)
        AND ${table.eventKey} ~ '${sql.raw(HASH_PATTERN)}'
        AND (${table.raw} IS NULL OR octet_length(${table.raw}::text) <= 8192)`,
    ),
  ],
);
```

- **One row per step,** never changed (0078). The order page and the tracking page draw these rows as dots.
- **`status` may be NULL** (decision 22): a notice we could not read is kept with its body, so it can be looked at
  later, and shown nowhere. The check then wants the body: a row with neither says nothing.
- **`occurred_at` and `received_at`.** The courier's own time orders the dots (a late webhook must not jump ahead of
  the poll's newer news); ours says when it reached us.
- **`source`** says how the step came: the booking itself, a member (a manual parcel), the webhook or the poll.
- **`event_key`** (mine 26), unique per parcel. The API writes with `ON CONFLICT DO NOTHING` on this key.
- **`raw` at most 8 KB.** A courier's notice is a few hundred bytes; the cap stops a broken or hostile sender from
  filling the table. It never holds a key or a token: the bearer token is in a header, not the body.

```diff
@@ -56,3 +56,4 @@ export * from './storefront.js';
 export * from './storefront-orders.js';
 export * from './storefront-coupons.js';
 export * from './storefront-payments.js';
+export * from './storefront-shipping.js';
```

### The tables' migration

```sql
CREATE TABLE "courier_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"courier" text NOT NULL,
	"archived_at" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"keys_sealed" "bytea",
	"key_version" smallint,
	"webhook_token_hash" text,
	"last_webhook_at" timestamp with time zone,
	"last_tested_at" timestamp with time zone,
	"last_test_problem" text,
	CONSTRAINT "courier_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "courier_accounts_values_check" CHECK ("courier_accounts"."provider" IN ('steadfast', 'manual')
        AND "courier_accounts"."courier" IN ('pathao', 'steadfast', 'redx', 'ecourier', 'paperfly')
        AND ("courier_accounts"."last_test_problem" IS NULL OR "courier_accounts"."last_test_problem" IN ('rejected', 'unreachable'))),
	CONSTRAINT "courier_accounts_courier_check" CHECK ("courier_accounts"."provider" = 'manual' OR ("courier_accounts"."provider", "courier_accounts"."courier") IN (('steadfast', 'steadfast'))),
	CONSTRAINT "courier_accounts_name_check" CHECK (char_length("courier_accounts"."name") BETWEEN 1 AND 60),
	CONSTRAINT "courier_accounts_secrets_check" CHECK (CASE "courier_accounts"."provider"
          WHEN 'manual' THEN num_nonnulls("courier_accounts"."keys_sealed", "courier_accounts"."key_version",
            "courier_accounts"."webhook_token_hash", "courier_accounts"."last_webhook_at", "courier_accounts"."last_tested_at",
            "courier_accounts"."last_test_problem") = 0
          ELSE num_nonnulls("courier_accounts"."keys_sealed", "courier_accounts"."key_version", "courier_accounts"."webhook_token_hash") = 3
            AND octet_length("courier_accounts"."keys_sealed") BETWEEN 29 AND 540
            AND "courier_accounts"."key_version" >= 1
            AND "courier_accounts"."webhook_token_hash" ~ '^[0-9a-f]{64}$'
        END),
	CONSTRAINT "courier_accounts_test_check" CHECK ("courier_accounts"."last_test_problem" IS NULL OR "courier_accounts"."last_tested_at" IS NOT NULL),
	CONSTRAINT "courier_accounts_default_check" CHECK (NOT "courier_accounts"."is_default" OR ("courier_accounts"."provider" <> 'manual' AND "courier_accounts"."archived_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "storefront_shipment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"status" text,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"event_key" text NOT NULL,
	"raw" jsonb,
	CONSTRAINT "storefront_shipment_events_key" UNIQUE("tenant_id","shipment_id","event_key"),
	CONSTRAINT "storefront_shipment_events_values_check" CHECK (("storefront_shipment_events"."status" IS NULL OR "storefront_shipment_events"."status" IN ('booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'partly_delivered', 'on_hold', 'returning', 'returned', 'cancelled'))
        AND "storefront_shipment_events"."source" IN ('booking', 'member', 'webhook', 'poll')
        AND ("storefront_shipment_events"."status" IS NOT NULL OR "storefront_shipment_events"."raw" IS NOT NULL)),
	CONSTRAINT "storefront_shipment_events_text_check" CHECK (("storefront_shipment_events"."note" IS NULL OR char_length("storefront_shipment_events"."note") BETWEEN 1 AND 300)
        AND "storefront_shipment_events"."event_key" ~ '^[0-9a-f]{64}$'
        AND ("storefront_shipment_events"."raw" IS NULL OR octet_length("storefront_shipment_events"."raw"::text) <= 8192))
);
--> statement-breakpoint
CREATE TABLE "storefront_shipments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"order_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"parcel_no" smallint NOT NULL,
	"invoice" text NOT NULL,
	"courier" text NOT NULL,
	"status" text DEFAULT 'booking' NOT NULL,
	"consignment_id" text,
	"tracking_code" text,
	"tracking_url" text,
	"cod_amount" numeric(19, 4) NOT NULL,
	"booked_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error" text,
	"error_detail" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "storefront_shipments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_shipments_parcel_key" UNIQUE("tenant_id","order_id","parcel_no"),
	CONSTRAINT "storefront_shipments_invoice_key" UNIQUE("tenant_id","courier_account_id","invoice"),
	CONSTRAINT "storefront_shipments_values_check" CHECK ("storefront_shipments"."status" IN ('booking', 'booking_failed', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'partly_delivered', 'on_hold', 'returning', 'returned', 'cancelled')
        AND "storefront_shipments"."courier" IN ('pathao', 'steadfast', 'redx', 'ecourier', 'paperfly')),
	CONSTRAINT "storefront_shipments_parcel_check" CHECK ("storefront_shipments"."parcel_no" BETWEEN 1 AND 5),
	CONSTRAINT "storefront_shipments_status_check" CHECK (CASE WHEN "storefront_shipments"."status" IN ('booking', 'booking_failed')
          THEN num_nonnulls("storefront_shipments"."consignment_id", "storefront_shipments"."tracking_code", "storefront_shipments"."tracking_url", "storefront_shipments"."booked_at") = 0
          ELSE num_nonnulls("storefront_shipments"."tracking_code", "storefront_shipments"."booked_at") = 2
            AND num_nonnulls("storefront_shipments"."error", "storefront_shipments"."error_detail") = 0
        END
        AND ("storefront_shipments"."status" <> 'booking_failed' OR "storefront_shipments"."error" IS NOT NULL)),
	CONSTRAINT "storefront_shipments_text_check" CHECK (("storefront_shipments"."tracking_code" IS NULL OR "storefront_shipments"."tracking_code" ~ '^[A-Z0-9-]{1,64}$')
        AND ("storefront_shipments"."consignment_id" IS NULL OR char_length("storefront_shipments"."consignment_id") BETWEEN 1 AND 64)
        AND ("storefront_shipments"."tracking_url" IS NULL OR ("storefront_shipments"."tracking_url" LIKE 'https://%' AND char_length("storefront_shipments"."tracking_url") <= 300))
        AND ("storefront_shipments"."error" IS NULL OR "storefront_shipments"."error" ~ '^[a-z][a-z0-9_]{0,63}$')
        AND ("storefront_shipments"."error_detail" IS NULL OR char_length("storefront_shipments"."error_detail") BETWEEN 1 AND 300)),
	CONSTRAINT "storefront_shipments_amounts_check" CHECK ("storefront_shipments"."cod_amount" >= 0 AND "storefront_shipments"."cod_amount" = round("storefront_shipments"."cod_amount", 2)
        AND "storefront_shipments"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipment_events" ADD CONSTRAINT "storefront_shipment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipment_events" ADD CONSTRAINT "storefront_shipment_events_shipment_fk" FOREIGN KEY ("tenant_id","shipment_id") REFERENCES "public"."storefront_shipments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."storefront_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_account_fk" FOREIGN KEY ("tenant_id","courier_account_id") REFERENCES "public"."courier_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_accounts_default_idx" ON "courier_accounts" USING btree ("tenant_id") WHERE "courier_accounts"."is_default";--> statement-breakpoint
CREATE INDEX "storefront_shipment_events_shipment_idx" ON "storefront_shipment_events" USING btree ("tenant_id","shipment_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_consignment_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id","consignment_id") WHERE "storefront_shipments"."consignment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_shipments_open_idx" ON "storefront_shipments" USING btree ("tenant_id","order_id") WHERE "storefront_shipments"."status" IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'returning');--> statement-breakpoint
CREATE INDEX "storefront_shipments_poll_idx" ON "storefront_shipments" USING btree ("tenant_id","last_synced_at") WHERE "storefront_shipments"."status" IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold', 'returning');
```

Made by drizzle-kit from the schema files:

```bash
pnpm --filter @omnivo/db generate --name storefront-shipping
```

It also writes `meta/0077_snapshot.json` and a line in `meta/_journal.json`; both are drizzle-kit's own and not
shown.

### The rules

```sql
-- Custom SQL migration file, put your code below! --
-- Step 28a: who may read and write the couriers. 0077 made the courier accounts, the parcels and
-- their events; this file gives the three tables their tenant rules, lets the tracking page read
-- a parcel's way, lets the worker's poll find the workspaces with parcels on their way, finds a
-- webhook's account before the workspace is known, and keeps what must not change.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role: omnivo_app (the Shop couriers page, the order page, the booking job,
--    the webhook once it knows the account) and omnivo_shop (the tracking page) set app.tenant_id
--    to one workspace first
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['courier_accounts', 'storefront_shipments', 'storefront_shipment_events'])
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

-- 2) The courier accounts: no grant to omnivo_public or omnivo_shop. The shop never needs the
--    keys, the token's hash or even the account's name: a parcel carries its own courier. As for
--    the payment gateway (0076), nothing is written here on purpose

-- 3) The tracking page (a tracking link and /track) runs as omnivo_shop (27a's ShopDb.orders). It
--    reads a parcel's courier, code and courier page, and its events: only those columns. Not the
--    account, the COD amount, the courier's id, the errors or the raw bodies. And only a parcel
--    the courier gave a code to (mine 17): a RESTRICTIVE policy, so a bug in the API's query
--    cannot show "booking" or "booking failed" to a shopper. An event with no status (a notice we
--    could not read) is hidden the same way
GRANT SELECT (tenant_id, id, order_id, parcel_no, courier, status, tracking_code, tracking_url)
  ON storefront_shipments TO omnivo_shop;
CREATE POLICY storefront_shipments_shop_booked ON storefront_shipments
  AS RESTRICTIVE FOR SELECT TO omnivo_shop
  USING (status NOT IN ('booking', 'booking_failed'));
GRANT SELECT (tenant_id, shipment_id, status, note, occurred_at)
  ON storefront_shipment_events TO omnivo_shop;
CREATE POLICY storefront_shipment_events_shop_read ON storefront_shipment_events
  AS RESTRICTIVE FOR SELECT TO omnivo_shop
  USING (status IS NOT NULL);

-- 4) The worker's poll (decision 9) asks about the parcels still on their way in EVERY workspace,
--    so tenant_isolation alone would show it nothing. As in 0062 and 0071: it reads as
--    omnivo_worker, the workspace and the status of the open parcels only, enough to know which
--    workspaces to queue. The courier calls then run as omnivo_app inside each workspace. The
--    list is OPEN_SHIPMENT_STATUSES, as in 0077's two indexes
GRANT SELECT (tenant_id, status) ON storefront_shipments TO omnivo_worker;
CREATE POLICY storefront_shipments_poll ON storefront_shipments
  FOR SELECT
  TO omnivo_worker
  USING (status IN ('booking', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'on_hold',
    'returning'));

-- 5) From a webhook's address to its workspace (decision 8). The courier's call knows only the
--    account's id, so it cannot set app.tenant_id yet. This function looks across workspaces and
--    answers one row for one id: the workspace and the token's hash, which the API compares with
--    the bearer token before it reads the body. Nothing for an unknown id, a manual account, an
--    account of another provider (Steadfast's address with 28c's Pathao account) or a deleted
--    workspace. An archived account still answers: its parcels on their way still get their news
--    (28a.1's archiveCourier).
--    SECURITY DEFINER, with a policy for its owner (the migrator) to read across workspaces, as
--    0064's storefront_tenant_for_subdomain. search_path is fixed for 0064's reason
CREATE POLICY courier_webhook_lookup ON courier_accounts
  FOR SELECT TO omnivo_migrator
  USING (true);

CREATE FUNCTION courier_account_for_webhook(account_id uuid, provider_name text)
  RETURNS TABLE (tenant_id uuid, webhook_token_hash text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT a.tenant_id, a.webhook_token_hash
  FROM courier_accounts a
  JOIN tenants t ON t.id = a.tenant_id
  WHERE a.id = account_id AND a.provider = provider_name AND a.provider <> 'manual'
    AND t.deleted_at IS NULL
$$;

-- The webhook's controller runs as omnivo_app with no workspace yet. Every role may run a new
-- function (PUBLIC), so that right goes first
REVOKE EXECUTE ON FUNCTION courier_account_for_webhook(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION courier_account_for_webhook(uuid, text) TO omnivo_app;

-- 6) An account's provider never changes (courier_accounts_provider_fixed): its keys, its webhook
--    address and its parcels are that provider's. And an account is never deleted
--    (courier_accounts_kept): its parcels name it. The API answers courier_provider_fixed first;
--    this is the last word. The CONSTRAINT names are what the API's database-error mapping reads
CREATE FUNCTION courier_accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'courier account % is archived, never deleted', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'courier_accounts_kept';
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.provider) IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.provider) THEN
    RAISE EXCEPTION 'courier account % keeps its provider', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'courier_accounts_provider_fixed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER courier_accounts_guard
  BEFORE UPDATE OR DELETE ON courier_accounts
  FOR EACH ROW EXECUTE FUNCTION courier_accounts_guard();

-- 7) A parcel (decision 3):
--    - is made for a confirmed order, and its invoice is that order's number (with "-2" to "-5"
--      for a later parcel): the courier finds it by that number, so a wrong one would lose it
--      (storefront_shipments_invoice_check). A check cannot read the order, so a trigger does
--    - keeps its order, account, number, invoice, courier and COD amount: the courier was told
--      these (storefront_shipments_fixed)
--    - keeps the courier's id, its tracking code and its booking time once it has them: the
--      shopper got the code by SMS (storefront_shipments_code_kept)
--    - moves only forward: back to booking only from booking_failed ("Book again"), to
--      booking_failed only from booking, and never out of cancelled or returned
--      (storefront_shipments_not_reopened)
--    - is never deleted (storefront_shipments_kept)
CREATE FUNCTION storefront_shipments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'parcel % is kept', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_kept';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The CASE is worked out first: inside an IF's condition, PL/pgSQL would take the CASE's
    -- own THEN as the IF's
    SELECT o.order_no || CASE WHEN NEW.parcel_no = 1 THEN '' ELSE '-' || NEW.parcel_no END
      INTO expected
    FROM storefront_orders o
    WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.order_id;
    IF expected IS NULL OR NEW.invoice <> expected THEN
      RAISE EXCEPTION 'parcel % must carry its order''s number', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_invoice_check';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.tenant_id, NEW.id, NEW.order_id, NEW.courier_account_id, NEW.parcel_no, NEW.invoice,
      NEW.courier, NEW.cod_amount, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.tenant_id, OLD.id, OLD.order_id, OLD.courier_account_id, OLD.parcel_no,
      OLD.invoice, OLD.courier, OLD.cod_amount, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'parcel % keeps its order, account, invoice and amount', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_fixed';
  END IF;
  IF (OLD.tracking_code IS NOT NULL AND NEW.tracking_code IS DISTINCT FROM OLD.tracking_code)
     OR (OLD.consignment_id IS NOT NULL AND NEW.consignment_id IS DISTINCT FROM OLD.consignment_id)
     OR (OLD.booked_at IS NOT NULL AND NEW.booked_at IS DISTINCT FROM OLD.booked_at) THEN
    RAISE EXCEPTION 'parcel % keeps its tracking code', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_code_kept';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND ((NEW.status = 'booking' AND OLD.status <> 'booking_failed')
       OR (NEW.status = 'booking_failed' AND OLD.status <> 'booking')
       OR OLD.status IN ('cancelled', 'returned')) THEN
    RAISE EXCEPTION 'parcel % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_not_reopened';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER storefront_shipments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_guard();

-- 8) The courier's news is a record (§14.7): an event is never changed or deleted, like a stock
--    movement (0022). A later notice is a new row. omnivo_app has UPDATE and DELETE on every
--    table (default privileges), so the rule lives here
CREATE FUNCTION storefront_shipment_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'parcel event % cannot be changed or deleted', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipment_events_append_only';
END;
$$;

CREATE TRIGGER storefront_shipment_events_append_only
  BEFORE UPDATE OR DELETE ON storefront_shipment_events
  FOR EACH ROW EXECUTE FUNCTION storefront_shipment_events_append_only();
```

Made empty with `pnpm --filter @omnivo/db generate --custom --name storefront-shipping-rules`, then written by
hand. Section by section:

1. **The tenant rules,** as every table has. No `TO`, so they hold for every role.
2. **Nothing for the shop on the accounts.** The shop never needs a key, a token's hash or an account's name: a
   parcel carries its own courier.
3. **The tracking page's read** (mine 27): column grants on the parcel and its events, and two RESTRICTIVE
   policies. A permissive policy is OR-ed with `tenant_isolation`; a restrictive one is AND-ed, so a bug in the
   API's query still cannot show a parcel in `booking` to a shopper.
4. **The poll's list** (decision 9), as 0062 and 0071 do for the worker: two columns of the open parcels in every
   workspace, enough to know which workspaces to queue. The courier calls then run as `omnivo_app` inside each one.
5. **The webhook's lookup** (decision 8). A courier's call knows only the account's id. The function answers the
   workspace and the token's hash for one id, and nothing for a manual account, another provider's account, an
   unknown id or a deleted workspace; an archived account still answers, because its parcels on their way still get
   their news. `SECURITY DEFINER` with a policy for its owner, like 0064's host lookup; only `omnivo_app` may run it.
   The API compares the bearer token with the hash before it reads the body.
6. **An account keeps its provider and is never deleted.** The API answers `courier_provider_fixed` first; this is
   the last word.
7. **A parcel's guard.** On INSERT it checks that the invoice is the order's own number (with this parcel's `-2`):
   the courier finds the parcel by it, so a wrong one would lose it, and a check cannot read the order. The `CASE`
   is worked out into a variable first: inside an `IF`'s condition, PL/pgSQL takes the `CASE`'s own `THEN` as the
   `IF`'s and fails with "syntax error at end of input". A pending order has no number, so it cannot get a parcel.
   On UPDATE: what the courier was told stays (order, account, number, invoice, courier, amount); the courier's id,
   the code and the booking time stay once set (the shopper got the code by SMS); and the status moves only
   forward: back to `booking` only from `booking_failed` ("Book again"), to `booking_failed` only from `booking`,
   and never out of `cancelled` or `returned`. Never a DELETE.
8. **The events are append-only,** like the stock ledger (0022): `omnivo_app` has UPDATE and DELETE on every table
   by default, so the rule lives in a trigger.

### Check this part

```bash
pnpm --filter @omnivo/db typecheck && pnpm --filter @omnivo/db build
pnpm exec eslint packages/db/src
```

Then the migrations on a throwaway Postgres (never the dev database: its compose project would be reused), with a
fixture of two workspaces, and a script of checks run as each role in one transaction that is rolled back:

```bash
docker run -d --name omnivo28a2-pg -p 55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=omnivo -v "$PWD/infra/docker/postgres/init:/docker-entrypoint-initdb.d:ro" postgres:17-alpine
MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@localhost:55432/omnivo \
  pnpm --filter @omnivo/db migrate
```

What was checked (all passed):

- **Accounts:** a manual account with keys, an API account without its token, Steadfast as Pathao, an unknown
  provider, an empty name, a sealed box of 28 or 541 bytes, a bad token hash, a test problem without its time, a
  manual account with a test: each refused by its check. The default: a manual default, archiving the default and
  a second default refused; clearing the flag and archiving together works. A manual account changes its courier,
  never its provider, and is never deleted.
- **Parcels:** a wrong invoice, `W-000002` as parcel 2, a sixth parcel, a parcel for a pending order, another
  workspace's account, a second parcel on its way (with another account), booked without a code, booking with a
  code, failed without an error, a lower-case code, an `http://` page, an amount with a third decimal and an
  unknown courier: each refused. Booking → failed → Book again → booked → picked up works; changing the amount, the
  account, the code or the courier's id, going back to booking, booked → failed, and cancelled → booked are refused;
  after a cancelled parcel, parcel 2 (`W-000001-2`) with the same account works, and parcel 1 again is refused.
  Nothing is deleted.
- **Events:** the same key twice, no status and no body, an unknown source, a key that is not a hash and another
  workspace's parcel are refused; an event is never changed or deleted.
- **The webhook's lookup** with no workspace set: finds Acme's and Beta's accounts, nothing for a manual account,
  another provider, an unknown id, or (at the end) a deleted workspace. `omnivo_shop` may not run it.
- **The shop** (`omnivo_shop` in Acme) sees the cancelled and the picked-up parcels and their events with a status,
  not the parcel still booking or the unread notice; it may not read the amount, the invoice, the raw body or any
  account, and may not change a parcel. `omnivo_public` reads no parcel at all.
- **The worker** with no workspace sees the open parcels of both workspaces (not the cancelled one), only their
  workspace and status.
- **A race:** two bookings of one order at the same moment, with two accounts: the second waits for the first and
  fails on `storefront_shipments_open_idx`. One parcel.

Broken on purpose, each caught:

- `storefront_shipments_shop_booked` dropped: the shop's check sees `2:booking:-`.
- `storefront_shipment_events_append_only` dropped: changing an event is not refused.

(The first version of the shop's check missed the first break: `string_agg` skips a NULL, and a booking parcel's
code is NULL. It now reads `coalesce(tracking_code, '-')` and counts the rows too.)

## 28a.3 — API

The API side of couriers, in two folders. `apps/api/src/shipping/` is the courier layer, like 27d's `payments/`: one
interface in our own words, Steadfast's adapter, the fake courier, and nothing about shops. `apps/api/src/storefront/
shipping/` is the shop's side: the Shop couriers page, a shop order's parcels, the worker's booking job, the
courier's news (webhook and poll) and the tracking page's read. The order's Shipped and Delivered move out of
`StorefrontOrdersService` into `orders/order-moves.ts`, so the courier's news moves an order with the buttons' own
code, in the API (a webhook) and in the worker (the poll).

How a parcel lives, end to end:

1. **Packed** with a courier account (or **Book courier** later) writes a parcel in `booking` and an outbox event in
   the same transaction. A manual account's parcel is `booked` at once, with the code the member typed.
2. **The worker** takes the event from its own `couriers` queue and calls the courier: five tries over about 15
   minutes. A try after the first asks the courier by the invoice first. Booked: the tracking code and the first
   step. Five failures (or one the courier refuses for good): `booking_failed`, the bell, and **Book again**.
3. **The courier's news** comes by its webhook (the account's own address and token) or by the poll every 15
   minutes. Each step is an event row; the parcel takes its newest step's status; the order moves to Shipped when
   the goods leave (and the shopper gets an SMS) and to Delivered when they arrive, which posts the invoice.
4. **The tracking page** shows the parcel once it has a code, with its steps.

Mine, made while writing this part:

28. **Booking goes through the outbox, on a third queue.** The event is written with the challan, so a Packed that
    rolls back books nothing, and a booking is never lost when Redis is away. A `couriers` queue, because a
    courier's API that answers in 15 seconds must not hold up a workspace's setup or a report, and its own tries
    (`courierRetry`: 5 tries, 1, 2, 4 and 8 minutes apart), because a courier that is down is down for minutes.
29. **A booking whose answer was lost, and that Steadfast cannot describe, fails with `courier_invoice_taken`.**
    Steadfast's `status_by_invoice` says where a parcel is, not its id or its code, so the parcel cannot be
    recorded as booked. A permanent failure that says to find it on the courier's panel is honest; booking again
    would be refused for the invoice anyway.
30. **Cancel is refused while the worker is still booking** (`storefront_order_parcel_booking`). The worker might
    reach the courier a moment after the cancel and leave a parcel there for an order that no longer exists. The
    booking always ends in about 15 minutes (booked or failed), and both allow the cancel.
31. **Shipped and Delivered live in `order-moves.ts`,** and the invoice's `created_by` / `posted_by` read
    `currentActorId()`: the courier's news has no member, like the worker's sales orders in 27b.
32. **A step's time is the courier's, kept between the parcel's booking and the moment the notice came.** A
    courier clock a few minutes off would otherwise put a new step before the booking and take the parcel back to
    `booked`. The step's key uses the courier's own time as it was sent, so the same notice twice is still one row.
33. **Delivered from the courier's news runs in a savepoint.** An invoice the sales rules refuse (a product archived
    since, the books locked) must not lose the courier's news with it: the order stays Shipped, and Mark delivered
    on its page shows the reason to someone who can fix it.
34. **The fake courier tells the poll nothing.** It keeps no state, so the only honest answer is "no answer"; an
    answer of `booked` would take every parcel back to booked after its webhook. Its parcels move by webhook, as
    the guide's "Try it" does by hand.
35. **A manual parcel follows the buttons:** Mark shipped makes it `picked_up`, Mark delivered `delivered`, so the
    tracking page shows the steps too (decision 5).
36. **Packed without `courierAccountId` is "Don't book now".** 28a.1 made the field required, which refused every
    Packed from a page loaded before 28a (and 27b–27d's own tests). `.default(null)` keeps the old body working.
37. **One key seals both tables, with the table in the seal.** `credentials.ts` takes the table as part of GCM's
    additional data, so a courier's keys copied into the gateway's row do not open as a password. The gateway's
    text is the one 27d wrote, so every password sealed before 28a still opens.
38. **The poll asks about at most 100 parcels per workspace per run,** least recently heard from first. A shop with
    a thousand parcels on the road is covered in a few hours, and no courier gets hundreds of calls at once.
39. **Steadfast's words, in one table.** `pending` (the first word after the booking) is read as in transit,
    because Steadfast has no "picked up"; `*_approval_pending` is not final (the order is Delivered only once
    Steadfast says `delivered`); a `cancelled` after the pickup means the goods come back (`returning`).

### The config

```diff
@@ -42,10 +42,21 @@ const paymentEnvSchema = z.object({
     .optional(),
 });
 
+// Step 28a: couriers. Both processes use it: the API books a manual parcel and answers the
+// courier's webhook and "Test connection", and the worker books an API parcel and polls.
+const shippingEnvSchema = z.object({
+  // Which couriers the API talks to (decision 6). fake: an answer in the courier's shapes from
+  // this process itself (shipping/fake-courier.ts), for development, CI and the tests; it books
+  // nothing and is refused in production. live: each provider's own API (Steadfast). Left out:
+  // live in production, fake everywhere else, like PAYMENT_GATEWAY
+  COURIER_MODE: z.enum(['fake', 'live']).optional(),
+});
+
 // process.env-এর সব মান string | undefined — এখানে একবার যাচাই করে টাইপ-নিরাপদ Config বানানো
 const envSchema = sharedEnvSchema
   .extend(storageEnvSchema.shape)
   .extend(paymentEnvSchema.shape)
+  .extend(shippingEnvSchema.shape)
   .extend({
     PORT: z.coerce.number().int().positive().default(3000),
     API_BASE_URL: z.url(),
@@ -81,6 +92,7 @@ const envSchema = sharedEnvSchema
 const workerEnvSchema = sharedEnvSchema
   .extend(storageEnvSchema.shape)
   .extend(paymentEnvSchema.shape)
+  .extend(shippingEnvSchema.shape)
   .extend({
     // The relay's own database role (omnivo_worker): it may read every tenant's outbox rows, and
     // nothing else. The jobs themselves use DATABASE_URL (omnivo_app) with a tenant context.
@@ -132,6 +144,28 @@ function paymentConfig(e: z.output<typeof paymentEnvSchema> & { NODE_ENV: string
 
 export type PaymentsConfig = ReturnType<typeof paymentConfig>;
 
+// Step 28a: the couriers' mode and the key that seals each courier account's keys. The key is the
+// payment gateway's CREDENTIALS_KEY (decision 7): one secret that seals what the tenants typed,
+// with the table in each seal's context (payments/credentials.ts), so a key sealed for a courier
+// never opens as a gateway password
+function shippingConfig(
+  e: z.output<typeof shippingEnvSchema> & { NODE_ENV: string },
+  payments: PaymentsConfig,
+) {
+  const production = e.NODE_ENV === 'production';
+  const mode = e.COURIER_MODE ?? (production ? 'live' : 'fake');
+  // The fake courier "books" every parcel without telling anyone: on a live shop the order would
+  // say Booked and no rider would ever come. Refused before the API takes a request
+  if (production && mode === 'fake') {
+    throw new Error(
+      'Invalid environment — COURIER_MODE=fake books nothing for real, so production cannot use it.',
+    );
+  }
+  return { mode, credentialsKey: payments.credentialsKey };
+}
+
+export type ShippingConfig = ReturnType<typeof shippingConfig>;
+
 function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>) {
   const parsed = schema.safeParse(env);
   if (!parsed.success) {
@@ -167,6 +201,7 @@ function phoneCodeKey(jwtSecret: string): Buffer {
 
 export function loadConfig(env: Record<string, string | undefined>) {
   const e = parseEnv(envSchema, env);
+  const payments = paymentConfig(e);
   return {
     port: e.PORT,
     apiBaseUrl: e.API_BASE_URL,
@@ -180,7 +215,9 @@ export function loadConfig(env: Record<string, string | undefined>) {
     secureCookies: e.NODE_ENV === 'production',
     storage: storageConfig(e),
     // Step 27d: the payment gateway and the key that seals its passwords
-    payments: paymentConfig(e),
+    payments,
+    // Step 28a: the couriers (fake or live) and the same key, for the courier accounts' keys
+    shipping: shippingConfig(e, payments),
     // Step 26f: the public shop API (storefront/)
     storefront: {
       baseDomain: e.SHOP_BASE_DOMAIN,
@@ -211,6 +248,7 @@ export type Config = ReturnType<typeof loadConfig>;
 
 export function loadWorkerConfig(env: Record<string, string | undefined>) {
   const e = parseEnv(workerEnvSchema, env);
+  const payments = paymentConfig(e);
   return {
     databaseUrl: e.DATABASE_URL,
     relayDatabaseUrl: e.WORKER_DATABASE_URL,
@@ -224,7 +262,9 @@ export function loadWorkerConfig(env: Record<string, string | undefined>) {
     // The report exports (step 11) go to the same bucket as the uploads
     storage: storageConfig(e),
     // Step 27d: the sweep asks the gateway before it deletes an unpaid online order
-    payments: paymentConfig(e),
+    payments,
+    // Step 28a: the worker books the API parcels and polls the ones on their way
+    shipping: shippingConfig(e, payments),
     relay: {
       // How long the relay sleeps when it found nothing to publish. One second keeps an invitation
       // email about a second behind the click, for one cheap index read per second.
@@ -240,6 +280,14 @@ export function loadWorkerConfig(env: Record<string, string | undefined>) {
       attempts: 5,
       backoffMs: 2_000,
     },
+    // Step 28a (decision 4): booking a parcel tries five times too, but over about 15 minutes (1,
+    // 2, 4 and 8 minutes apart): a courier's API that is down is usually down for minutes, not
+    // seconds, and a parcel booked 10 minutes late is still picked up the same day. Then the
+    // parcel fails, the bell rings and the page offers "Book again"
+    courierRetry: {
+      attempts: 5,
+      backoffMs: 60_000,
+    },
     // Published outbox rows are kept this long for debugging ("did the event go out?"), then
     // deleted by an hourly job
     outboxRetentionDays: 7,
```

- **`COURIER_MODE` is its own setting,** next to `PAYMENT_GATEWAY` and with the same rules: fake outside production,
  live in production, and fake refused in production before the API takes a request. A shop on the fake courier
  would show "Booked" and no rider would ever come.
- **`shippingConfig` takes the payment config's key** instead of reading `CREDENTIALS_KEY` again (decision 7): one
  secret, parsed once, so the two can never disagree about it.
- **`courierRetry` is the worker's, apart from `retry`.** The test worker sets `retry` to two quick tries; it can
  set `courierRetry` on its own, and production's courier tries stay minutes apart.
- `payments` is worked out once in each loader, because `shippingConfig` needs it.

```diff
@@ -127,3 +127,27 @@ describe('payment config', () => {
     expect(() => loadConfig(env({ CREDENTIALS_KEY: short }))).toThrow(/Invalid environment/);
   });
 });
+
+// Step 28a.3: the couriers, like the gateway, and the same key
+describe('shipping config', () => {
+  const production = { NODE_ENV: 'production', STOREFRONT_MEDIA_URL: 'https://files.example.com' };
+  const key = Buffer.alloc(32, 7).toString('base64');
+
+  it('uses the fake courier outside production and the real ones in production', () => {
+    expect(loadConfig(env({})).shipping.mode).toBe('fake');
+    expect(loadConfig(env(production)).shipping.mode).toBe('live');
+    expect(loadConfig(env({ COURIER_MODE: 'live' })).shipping.mode).toBe('live');
+  });
+
+  it('refuses the fake courier in production', () => {
+    expect(() => loadConfig(env({ ...production, COURIER_MODE: 'fake' }))).toThrow(
+      /COURIER_MODE=fake/,
+    );
+  });
+
+  it("seals with the gateway's key", () => {
+    expect(loadConfig(env({})).shipping.credentialsKey).toBeNull();
+    const config = loadConfig(env({ CREDENTIALS_KEY: key }));
+    expect(config.shipping.credentialsKey).toBe(config.payments.credentialsKey);
+  });
+});
```

The same three checks as the gateway's: the default per environment, fake refused in production, and the same key
object as the payments' (`toBe`, not `toEqual`).

```diff
@@ -46,6 +46,11 @@ STOREFRONT_SHOP_KEY=dev-only-shop-key-change-me-0123456789abcdef
 # save a password. Changing it later makes every saved password unreadable until it is typed again
 # PAYMENT_GATEWAY=fake
 CREDENTIALS_KEY=ZGV2LW9ubHktY3JlZGVudGlhbHMta2V5LTMyYnl0ZXM=
+# Step 28a: couriers, read by the API and the worker. COURIER_MODE is fake (books every parcel
+# without calling anyone; move a parcel by posting a webhook) or live (Steadfast's own API); left
+# out, fake outside production and live in production, which refuses fake. A courier account's
+# keys are sealed with CREDENTIALS_KEY above
+# COURIER_MODE=fake
 # Step 26f.5: the shop's server (apps/shop) reads these, not the API. Left out, it shows the mock
 # shop. To see a launched shop from the API: SHOP_SOURCE=api SHOP_API_URL=http://localhost:3000
 # SHOP_API_KEY=<STOREFRONT_SHOP_KEY above> pnpm --filter @omnivo/shop dev, then open
```

```diff
@@ -16,3 +16,8 @@ export const RELAY_DB = Symbol('RELAY_DB');
 // it (payments/gateway.ts)
 export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');
 export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
+
+// Step 28a: the couriers' part of the config, and the adapters made from it (shipping/courier.ts):
+// one per provider that books by API
+export const SHIPPING_CONFIG = Symbol('SHIPPING_CONFIG');
+export const COURIERS = Symbol('COURIERS');
```
```diff
@@ -14,13 +14,16 @@ import { createWithUser } from '../common/tenant/with-user.js';
 import type { Config } from '../config.js';
 import { StorageService } from '../storage/storage.service.js';
 import { createGateway } from '../payments/create-gateway.js';
+import { createCouriers } from '../shipping/create-couriers.js';
 import {
   AUTH,
   CONFIG,
+  COURIERS,
   DB,
   PAYMENT_GATEWAY,
   PAYMENTS_CONFIG,
   REDIS,
+  SHIPPING_CONFIG,
   STORAGE_CONFIG,
   WITH_TENANT,
   WITH_USER,
@@ -66,6 +69,9 @@ export class InfraModule implements OnApplicationShutdown {
         // Step 27d: the gateway for the shop's payments and the Payment card's test
         { provide: PAYMENTS_CONFIG, useValue: config.payments },
         { provide: PAYMENT_GATEWAY, useFactory: () => createGateway(config.payments) },
+        // Step 28a: the couriers, for a webhook and "Test connection" (the worker books and polls)
+        { provide: SHIPPING_CONFIG, useValue: config.shipping },
+        { provide: COURIERS, useFactory: () => createCouriers(config.shipping) },
       ],
       exports: [
         CONFIG,
@@ -77,6 +83,8 @@ export class InfraModule implements OnApplicationShutdown {
         StorageService,
         PAYMENTS_CONFIG,
         PAYMENT_GATEWAY,
+        SHIPPING_CONFIG,
+        COURIERS,
       ],
     };
   }
```

The API provides `SHIPPING_CONFIG` and `COURIERS` like 27d's two tokens. The worker provides its own (below), and a
test can put its own adapters in `COURIERS`' place.

### One key, two tables

```diff
@@ -14,23 +14,30 @@ export type CredentialsKey = NonNullable<PaymentsConfig['credentialsKey']>;
 const NONCE_BYTES = 12;
 const TAG_BYTES = 16;
 
+// Step 28a: the tables that keep a sealed secret: the gateway's password (27d) and a courier
+// account's keys. The key is the same; the table is part of each seal's context
+export type SealedTable = 'storefront_payment_gateways' | 'courier_accounts';
+
 // What the seal is tied to, besides the key: the table and the workspace. GCM checks this
 // "additional data" on opening without storing it, so a sealed password copied into another
-// workspace's row (a bug, or someone with database access) fails to open there
-function contextOf(tenantId: string): Buffer {
-  return Buffer.from(`omnivo storefront_payment_gateways ${tenantId}`, 'utf8');
+// workspace's row (a bug, or someone with database access) fails to open there, and (28a) a
+// courier's keys copied into the gateway's row do not open as a password. The gateway's text is
+// the one 27d wrote, so the passwords sealed before 28a still open
+function contextOf(table: SealedTable, tenantId: string): Buffer {
+  return Buffer.from(`omnivo ${table} ${tenantId}`, 'utf8');
 }
 
 // One bytea: nonce ‖ tag ‖ ciphertext (27d.2's storefront_payment_gateways_sealed_check counts on
 // this order and these sizes)
 export function sealSecret(
   key: CredentialsKey,
+  table: SealedTable,
   tenantId: string,
   secret: string,
 ): { sealed: Buffer; keyVersion: number } {
   const nonce = randomBytes(NONCE_BYTES);
   const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
-  cipher.setAAD(contextOf(tenantId));
+  cipher.setAAD(contextOf(table, tenantId));
   const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
   return { sealed: Buffer.concat([nonce, cipher.getAuthTag(), body]), keyVersion: key.version };
 }
@@ -41,6 +48,7 @@ export function sealSecret(
 // shop can show ("Try again", "Pay on delivery"), a 500 is not
 export function openSecret(
   key: CredentialsKey,
+  table: SealedTable,
   tenantId: string,
   sealed: Buffer,
   keyVersion: number,
@@ -48,7 +56,7 @@ export function openSecret(
   if (keyVersion !== key.version || sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
   try {
     const decipher = createDecipheriv('aes-256-gcm', key.key, sealed.subarray(0, NONCE_BYTES));
-    decipher.setAAD(contextOf(tenantId));
+    decipher.setAAD(contextOf(table, tenantId));
     decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
     return Buffer.concat([
       decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
```

- **`SealedTable` is a union, not a free string,** so a caller cannot seal under a table name nobody reads back.
- **The context text is unchanged for the gateway** (`omnivo storefront_payment_gateways <tenant>`), so the
  passwords sealed by 27d still open (mine 37).

```diff
@@ -5,31 +5,45 @@ import { type CredentialsKey, openSecret, sealSecret } from './credentials.js';
 const KEY: CredentialsKey = { version: 1, key: Buffer.alloc(32, 1) };
 const TENANT = '0196f3b0-0000-7000-8000-000000000001';
 const OTHER = '0196f3b0-0000-7000-8000-000000000002';
+const GATEWAYS = 'storefront_payment_gateways';
 
 describe('gateway password seal (step 27d.3)', () => {
   it('opens what it sealed, and seals the same password differently each time', () => {
-    const first = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
-    const second = sealSecret(KEY, TENANT, 'nirvo67412bc0d9f1e@ssl');
+    const first = sealSecret(KEY, GATEWAYS, TENANT, 'nirvo67412bc0d9f1e@ssl');
+    const second = sealSecret(KEY, GATEWAYS, TENANT, 'nirvo67412bc0d9f1e@ssl');
     expect(first.keyVersion).toBe(1);
     expect(first.sealed.equals(second.sealed)).toBe(false);
-    expect(openSecret(KEY, TENANT, first.sealed, 1)).toBe('nirvo67412bc0d9f1e@ssl');
+    expect(openSecret(KEY, GATEWAYS, TENANT, first.sealed, 1)).toBe('nirvo67412bc0d9f1e@ssl');
     // The database's check: nonce + tag + at least one byte
     expect(first.sealed.length).toBe(12 + 16 + 'nirvo67412bc0d9f1e@ssl'.length);
   });
 
   it('keeps a space and Bangla letters as they were typed', () => {
-    const { sealed } = sealSecret(KEY, TENANT, ' পাসওয়ার্ড ');
-    expect(openSecret(KEY, TENANT, sealed, 1)).toBe(' পাসওয়ার্ড ');
+    const { sealed } = sealSecret(KEY, GATEWAYS, TENANT, ' পাসওয়ার্ড ');
+    expect(openSecret(KEY, GATEWAYS, TENANT, sealed, 1)).toBe(' পাসওয়ার্ড ');
   });
 
   it('does not open in another workspace, with another key, or once a bit changed', () => {
-    const { sealed } = sealSecret(KEY, TENANT, 'secret');
-    expect(openSecret(KEY, OTHER, sealed, 1)).toBeNull();
-    expect(openSecret({ version: 1, key: Buffer.alloc(32, 2) }, TENANT, sealed, 1)).toBeNull();
-    expect(openSecret(KEY, TENANT, sealed, 2)).toBeNull();
+    const { sealed } = sealSecret(KEY, GATEWAYS, TENANT, 'secret');
+    expect(openSecret(KEY, GATEWAYS, OTHER, sealed, 1)).toBeNull();
+    expect(
+      openSecret({ version: 1, key: Buffer.alloc(32, 2) }, GATEWAYS, TENANT, sealed, 1),
+    ).toBeNull();
+    expect(openSecret(KEY, GATEWAYS, TENANT, sealed, 2)).toBeNull();
     const changed = Buffer.from(sealed);
     changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
-    expect(openSecret(KEY, TENANT, changed, 1)).toBeNull();
-    expect(openSecret(KEY, TENANT, sealed.subarray(0, 28), 1)).toBeNull();
+    expect(openSecret(KEY, GATEWAYS, TENANT, changed, 1)).toBeNull();
+    expect(openSecret(KEY, GATEWAYS, TENANT, sealed.subarray(0, 28), 1)).toBeNull();
+  });
+
+  // Step 28a: one key seals both tables, so the table is part of the seal
+  it("does not open a courier account's keys as a gateway password, or the other way", () => {
+    const courier = sealSecret(KEY, 'courier_accounts', TENANT, '{"apiKey":"a","secretKey":"b"}');
+    expect(openSecret(KEY, GATEWAYS, TENANT, courier.sealed, 1)).toBeNull();
+    expect(openSecret(KEY, 'courier_accounts', TENANT, courier.sealed, 1)).toBe(
+      '{"apiKey":"a","secretKey":"b"}',
+    );
+    const gateway = sealSecret(KEY, GATEWAYS, TENANT, 'secret');
+    expect(openSecret(KEY, 'courier_accounts', TENANT, gateway.sealed, 1)).toBeNull();
   });
 });
```
```diff
@@ -106,7 +106,12 @@ export class StorefrontPaymentGatewayService {
     const key = this.key();
     return this.withTenant(async (tx) => {
       const chart = await this.checkAccounts(tx, input);
-      const { sealed, keyVersion } = sealSecret(key, getTenantId(), input.password);
+      const { sealed, keyVersion } = sealSecret(
+        key,
+        'storefront_payment_gateways',
+        getTenantId(),
+        input.password,
+      );
       const [row] = await tx
         .insert(storefrontPaymentGateways)
         .values({
@@ -149,14 +154,22 @@ export class StorefrontPaymentGatewayService {
       if (before === null) throw notSetUp();
       if (before.version !== input.version) throw versionConflict();
       const chart = await this.checkAccounts(tx, input);
-      const sealed = key === null ? null : sealSecret(key, getTenantId(), input.password);
+      const sealed =
+        key === null
+          ? null
+          : sealSecret(key, 'storefront_payment_gateways', getTenantId(), input.password);
       // A new password that is the old one is no change (the audit and the last test agree). Only
       // checkable when the saved one opens; when it does not, the new one is a change anyway
       const passwordChanged =
         sealed !== null &&
         (key === null ||
-          openSecret(key, getTenantId(), before.passwordSealed, before.keyVersion) !==
-            input.password);
+          openSecret(
+            key,
+            'storefront_payment_gateways',
+            getTenantId(),
+            before.passwordSealed,
+            before.keyVersion,
+          ) !== input.password);
       // The last test said something about the store id, the password and the address (mode);
       // a change to any of them makes it say nothing any more. The accounts are not tested
       const reach =
@@ -197,7 +210,13 @@ export class StorefrontPaymentGatewayService {
     const key = this.key();
     const saved = await this.withTenant((tx) => this.find(tx, false));
     if (saved === null) throw notSetUp();
-    const password = openSecret(key, saved.tenantId, saved.passwordSealed, saved.keyVersion);
+    const password = openSecret(
+      key,
+      'storefront_payment_gateways',
+      saved.tenantId,
+      saved.passwordSealed,
+      saved.keyVersion,
+    );
     // A password this key cannot open (sealed by another key) cannot reach the gateway either:
     // it is refused, and saving it again seals it with this server's key
     const problem: PaymentGatewayTestProblem | null =
```
```diff
@@ -45,7 +45,15 @@ export class GatewayAccounts {
     if (row === undefined) return null;
     const key = this.config.credentialsKey;
     const password =
-      key === null ? null : openSecret(key, tenantId, row.passwordSealed, row.keyVersion);
+      key === null
+        ? null
+        : openSecret(
+            key,
+            'storefront_payment_gateways',
+            tenantId,
+            row.passwordSealed,
+            row.keyVersion,
+          );
     if (password === null) {
       // The workspace and why, never the value
       this.logger.error(
```

The gateway's four calls name their table; nothing else changes.

### The courier layer

```ts
import { createHash } from 'node:crypto';

import {
  COURIER_OF_PROVIDER,
  type CourierTestProblem,
  type ShopShipmentStatus,
} from '@omnivo/contracts';

// Step 28a: what the API needs from a courier, in our own words (§14.6). Nothing about shops or
// orders is in here: a challan of the ERP books the same way later (decision 10). The shop's code
// (storefront/shipping/) decides what an answer means for a parcel; an adapter only talks to its
// courier and says what it answered. One adapter per provider that books by API; a manual account
// has none, because nothing is called.

// The providers that have an adapter: every provider but 'manual' (28a.1's COURIER_OF_PROVIDER)
export type ApiCourierProvider = keyof typeof COURIER_OF_PROVIDER;

export function isApiProvider(provider: string): provider is ApiCourierProvider {
  return Object.keys(COURIER_OF_PROVIDER).includes(provider);
}

// An account's two keys, opened from their sealed box for one call (storefront/shipping/
// courier-keys.ts). In memory only for the call
export interface CourierKeys {
  apiKey: string;
  secretKey: string;
}

// What the courier is told about one parcel. The invoice is our key at the courier (decision 3):
// the order number, or "W-000123-2" for a later parcel (28a.2's mine 25)
export interface ParcelRequest {
  invoice: string;
  name: string;
  phone: string;
  address: string;
  // What the rider collects, a decimal string to the paisa ("578.00"; "0.00" when paid online)
  codAmount: string;
  // For the rider, "3 items"; never the products
  note: string;
}

// rejected: the courier answered and refused the keys. unreachable: no answer in time, or one that
// is not the courier's. The same two as "Test connection" (28a.1)
export type CourierProblem = CourierTestProblem;

// A parcel the courier knows, with its id, its tracking code, its own tracking page and where it
// is now, already in our words
export interface CourierParcel {
  consignmentId: string;
  trackingCode: string;
  trackingUrl: string | null;
  status: ShopShipmentStatus;
}

// - booked: the courier took it
// - refused: the courier answered and said no to this parcel (a phone it does not take, an address
//   too long), with its own sentence when it gave one. Asking again would get the same answer
// - taken: the courier already has a parcel with this invoice (an earlier call reached it, and its
//   answer was lost). The caller asks by the invoice (find)
// - problem: the courier could not be asked, or refused the keys
export type BookAnswer =
  | { kind: 'booked'; parcel: CourierParcel }
  | { kind: 'refused'; detail: string | null }
  | { kind: 'taken' }
  | { kind: 'problem'; problem: CourierProblem };

// What the courier knows by our invoice, asked after a call whose answer was lost (decision 3):
// - found: the parcel, with everything a booking answers
// - exists: a parcel has this invoice, but the courier's answer does not say its tracking code
//   (Steadfast's status_by_invoice says only where it is). It cannot be recorded as booked
// - none: nothing has this invoice, so booking it now makes the only parcel
export type FindAnswer =
  | { kind: 'found'; parcel: CourierParcel }
  | { kind: 'exists' }
  | { kind: 'none' }
  | { kind: 'problem'; problem: CourierProblem };

// Where a parcel is now, asked by the 15-minute poll (decision 9). status null: the courier
// answered a word this adapter does not know; the courier's own word is in `word`, kept with the
// event so it can be read later (decision 22)
export type StatusAnswer =
  | { kind: 'status'; status: ShopShipmentStatus | null; word: string }
  | { kind: 'problem'; problem: CourierProblem };

// One webhook body, read. The courier names the parcel by its own id or by our invoice (or both);
// the caller finds it with either, only inside the account's own workspace
//  - status: the parcel moved, with the courier's note and time when it gave them
//  - note: words about the parcel with no new status ("Received at Sylhet hub")
//  - unread: a body this adapter cannot read. Kept raw on the parcel (decision 22), never refused
export type CourierNotice = {
  consignmentId: string | null;
  invoice: string | null;
  raw: Record<string, unknown>;
} & (
  | { kind: 'status'; status: ShopShipmentStatus | null; note: string | null; at: Date | null }
  | { kind: 'note'; note: string; at: Date | null }
  | { kind: 'unread' }
);

export interface CourierAdapter {
  book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer>;
  find(keys: CourierKeys, invoice: string): Promise<FindAnswer>;
  status(keys: CourierKeys, consignmentId: string): Promise<StatusAnswer>;
  // No call: the body came to us. Pure, so the unit test covers every shape
  readNotice(body: unknown): CourierNotice;
  // "Test connection": null when the courier accepts the keys. Asks something that changes nothing
  test(keys: CourierKeys): Promise<CourierProblem | null>;
}

// The adapters of this process, one per API provider (shipping/create-couriers.ts). A Record over
// the providers, so 28c's Pathao does not compile until it has its adapter
export type CourierAdapters = Record<ApiCourierProvider, CourierAdapter>;

// A courier's words for a column of ours: trimmed, null when empty, and cut to the columns' 300
// characters (storefront_shipments_text_check and the events' note), so a long sentence never
// leaves a parcel's news unrecorded
export function courierText(value: unknown): string | null {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text.slice(0, 300);
}

// A courier's id for a parcel as our text: Steadfast sends a number, others a string. null for
// anything that is not a plain id (the column takes 1 to 64 characters)
export function courierId(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(text.trim()) ? text.trim() : null;
}

// The API's own key for one step of a parcel (28a.2's mine 26): the same status, time and note is
// the same step, whether the webhook said it twice or the webhook and the poll both did. The time
// is the courier's own as it sent it (null when it sent none), never one we worked out: the same
// notice sent twice must give the same key. A SHA-256 in hex, the column's form
// (storefront_shipment_events_text_check)
export function eventKeyOf(
  kind: string,
  status: ShopShipmentStatus | null,
  at: Date | null,
  note: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, status, at?.toISOString() ?? null, note]))
    .digest('hex');
}
```

- **`ApiCourierProvider` is read from `COURIER_OF_PROVIDER`** (28a.1), and `CourierAdapters` is a `Record` over it:
  28c's Pathao does not compile until it has an adapter.
- **`isApiProvider()` is a type guard,** so a row's `provider` (which may be `manual`) narrows without a cast before
  it indexes `CourierAdapters`.
- **`BookAnswer` has four kinds, because the caller acts differently on each.** `refused` is permanent (the courier
  said no to this parcel); `taken` means an earlier call reached the courier, so the caller asks by the invoice;
  `problem` is the keys refused (permanent) or no answer (try again).
- **`FindAnswer` has `exists`** for a courier that confirms a parcel but does not say its code (Steadfast, mine 29).
- **`StatusAnswer` keeps the courier's own word** when the adapter does not know it, for the log (decision 22).
- **`CourierNotice` names the parcel by the courier's id or by our invoice.** The webhook finds it with either, only
  among the account's own parcels. `raw` is always there, so a notice we cannot read can still be kept.
- **`readNotice` is pure** (no call: the body came to us), so the unit test covers every shape.
- **`courierText()` collapses spaces and cuts to 300**, the columns' limit: a courier's long sentence never leaves a
  parcel's news unrecorded. **`courierId()`** takes a safe integer or a plain id and nothing else.
- **`eventKeyOf()`** is mine 26's key, from the courier's own time as sent (mine 32). `JSON.stringify` of an array,
  so `["a b", null]` and `["a", "b null"]` can never give the same text.

```ts
import type { ShippingConfig } from '../config.js';
import type { CourierAdapters } from './courier.js';
import { FakeCourier } from './fake-courier.js';
import { SteadfastAdapter } from './steadfast-adapter.js';

// Step 28a: the adapters of this process, by COURIER_MODE (config.ts). Its own file, like 27d's
// create-gateway.ts, so the classes can import courier.ts without a circle. The API's InfraModule
// and the WorkerModule both provide it as COURIERS; a test puts its own in its place
export function createCouriers(config: ShippingConfig): CourierAdapters {
  if (config.mode === 'fake') return { steadfast: new FakeCourier() };
  return { steadfast: new SteadfastAdapter() };
}
```

Its own file for 27d's reason: the two classes import `courier.ts`, and `courier.ts` imports neither.

### Steadfast

```ts
import { Logger } from '@nestjs/common';
import { type ShopShipmentStatus, steadfastWebhookSchema } from '@omnivo/contracts';
import { z } from 'zod';

import {
  type BookAnswer,
  type CourierAdapter,
  courierId,
  type CourierKeys,
  type CourierNotice,
  type CourierProblem,
  courierText,
  type FindAnswer,
  type ParcelRequest,
  type StatusAnswer,
} from './courier.js';

// Step 28a: Steadfast's merchant API (portal.packzy.com/api/v1). Written from Steadfast's own
// documentation of its requests and answers only: there was no Steadfast account to try it on (the
// guide says so, and 28a.8's "Try it" books one real parcel first). Four calls: create_order (a
// booking), status_by_invoice (after a lost answer), status_by_cid (the poll) and get_balance
// ("Test connection"). Steadfast has no cancel call: a booking is cancelled on its panel.

const BASE_URL = 'https://portal.packzy.com/api/v1';

// Long enough for Steadfast on a slow day. A booking runs in the worker, so nobody waits on it;
// "Test connection" waits this long at most
const TIMEOUT_MS = 15_000;

// Steadfast's tracking page for a code. Not in its API answer, so it is made here
function trackingUrlOf(trackingCode: string): string {
  return `https://steadfast.com.bd/t/${encodeURIComponent(trackingCode)}`;
}

// Steadfast's words for where a parcel is, and ours (SHOP_SHIPMENT_STATUSES). The one place they
// meet: when Steadfast adds or renames one, only this table changes. A word that is not here is
// kept with the event as it came (decision 22) and moves nothing.
//  - in_review: booked, waiting for Steadfast to approve it; pending: approved and with Steadfast,
//    not delivered or cancelled yet. Steadfast has no word for "picked up" on its own: pending is
//    the first one after the booking, so it is read as on the way
//  - *_approval_pending: the rider says delivered (or partly, or cancelled), and Steadfast's hub
//    has not approved it yet. Read as still out for delivery (or coming back): the order is
//    Delivered, and its invoice posted, only once Steadfast says delivered for good
//  - cancelled: Steadfast cancelled the consignment. Before anyone picked it up that is a cancelled
//    booking; after, the goods come back. The shop's code tells the two apart by where the parcel
//    was (storefront/shipping/shipment-news.ts), so the adapter says only "cancelled"
//  - hold: the rider will try again; unknown: Steadfast does not know (read as on hold)
const STEADFAST_WORDS = {
  in_review: 'booked',
  pending: 'in_transit',
  hold: 'on_hold',
  delivered_approval_pending: 'out_for_delivery',
  partial_delivered_approval_pending: 'out_for_delivery',
  cancelled_approval_pending: 'returning',
  unknown_approval_pending: 'on_hold',
  delivered: 'delivered',
  partial_delivered: 'partly_delivered',
  cancelled: 'cancelled',
  unknown: 'on_hold',
} as const satisfies Record<string, ShopShipmentStatus>;

// A Map, so a word from Steadfast ("constructor", "__proto__") can never reach an object's own
// properties, and no cast is needed to look one up
const STATUS_OF: ReadonlyMap<string, ShopShipmentStatus> = new Map(Object.entries(STEADFAST_WORDS));

function statusOf(word: string | null | undefined): ShopShipmentStatus | null {
  return STATUS_OF.get(word?.trim().toLowerCase() ?? '') ?? null;
}

// Only what is read from each answer; zod objects drop the rest. Steadfast puts its own status in
// the body too (200, 400, 401), not only in the HTTP status
const codeSchema = z.union([z.number(), z.string()]).optional();

const createSchema = z.object({
  status: codeSchema,
  message: z.string().nullish(),
  // A refused booking: { field: ["The recipient phone must be 11 digits."] }
  errors: z.record(z.string(), z.union([z.array(z.string()), z.string()])).nullish(),
  consignment: z
    .object({
      consignment_id: z.union([z.number(), z.string()]),
      tracking_code: z.string(),
      status: z.string().nullish(),
    })
    .nullish(),
});

const statusSchema = z.object({
  status: codeSchema,
  delivery_status: z.string().nullish(),
});

const balanceSchema = z.object({
  status: codeSchema,
  current_balance: z.union([z.number(), z.string()]).nullish(),
});

// An answer is Steadfast's yes when its own status says 200
function said200(status: number | string | undefined): boolean {
  return String(status) === '200';
}

// The first sentence of Steadfast's refusal: an error under a field, or its message
function refusalOf(answer: z.infer<typeof createSchema>): string | null {
  for (const value of Object.values(answer.errors ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && courierText(first) !== null) return courierText(first);
  }
  return courierText(answer.message);
}

// Steadfast writes its times as "2026-11-23 14:05:09", Bangladesh time, with no zone: read so. A
// time with a zone is read as it says. Anything else, or a time more than a day ahead (a broken
// clock), is no time: the caller uses the moment the notice came
export function steadfastTime(value: string | undefined, now: Date = new Date()): Date | null {
  const text = value?.trim() ?? '';
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text);
  const at = new Date(local === null ? text : `${local[1] ?? ''}T${local[2] ?? ''}+06:00`);
  if (text === '' || Number.isNaN(at.getTime())) return null;
  return at.getTime() > now.getTime() + 24 * 60 * 60 * 1000 ? null : at;
}

type Call =
  | { kind: 'answer'; httpStatus: number; body: unknown }
  | { kind: 'problem'; problem: CourierProblem };

export class SteadfastAdapter implements CourierAdapter {
  private readonly logger = new Logger(SteadfastAdapter.name);

  // fetch is a parameter so the unit test can answer for Steadfast
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer> {
    const call = await this.call(keys, '/create_order', {
      invoice: parcel.invoice,
      // Steadfast's limits: a name of 100 characters, an address of 250, a phone of 11 digits
      // (ours always is: 01XXXXXXXXX, shopPhoneSchema). The address on one line: its label
      // printer does not break lines
      recipient_name: parcel.name.slice(0, 100),
      recipient_phone: parcel.phone,
      recipient_address: parcel.address.replace(/\s+/g, ' ').trim().slice(0, 250),
      // A number in Steadfast's API. Taka with paisa is exact as a JavaScript number for any COD
      // amount a parcel can have (far below 2^53 paisa), and the string goes in unchanged
      cod_amount: Number(parcel.codAmount),
      note: parcel.note,
    });
    if (call.kind === 'problem') return call;
    const answer = createSchema.safeParse(call.body);
    if (!answer.success) return { kind: 'problem', problem: 'unreachable' };
    const consignment = answer.data.consignment;
    const consignmentId = courierId(consignment?.consignment_id);
    const trackingCode = consignment?.tracking_code.trim().toUpperCase() ?? '';
    if (said200(answer.data.status) && consignmentId !== null && trackingCode !== '') {
      if (!/^[A-Z0-9-]{1,64}$/.test(trackingCode)) {
        // A code our column cannot keep: the parcel exists at Steadfast, but not here. Asking by
        // the invoice says the same, so it fails with Steadfast's own code in the log
        this.logger.warn(`Steadfast answered a tracking code we cannot keep: ${trackingCode}`);
        return { kind: 'problem', problem: 'unreachable' };
      }
      return {
        kind: 'booked',
        parcel: {
          consignmentId,
          trackingCode,
          trackingUrl: trackingUrlOf(trackingCode),
          status: statusOf(consignment?.status) ?? 'booked',
        },
      };
    }
    const detail = refusalOf(answer.data);
    // The invoice is unique per merchant at Steadfast: an earlier call got there first
    if (detail !== null && /invoice/i.test(detail) && /taken|exist|duplicate/i.test(detail)) {
      return { kind: 'taken' };
    }
    return { kind: 'refused', detail };
  }

  // Steadfast answers where a parcel with this invoice is, but not its id or its tracking code
  async find(keys: CourierKeys, invoice: string): Promise<FindAnswer> {
    const call = await this.call(keys, `/status_by_invoice/${encodeURIComponent(invoice)}`);
    if (call.kind === 'problem') return call;
    const answer = statusSchema.safeParse(call.body);
    if (!answer.success) return { kind: 'problem', problem: 'unreachable' };
    // A 404, or its own status saying so: no parcel has this invoice
    if (call.httpStatus === 404 || !said200(answer.data.status)) return { kind: 'none' };
    return answer.data.delivery_status == null ? { kind: 'none' } : { kind: 'exists' };
  }

  async status(keys: CourierKeys, consignmentId: string): Promise<StatusAnswer> {
    const call = await this.call(keys, `/status_by_cid/${encodeURIComponent(consignmentId)}`);
    if (call.kind === 'problem') return call;
    const answer = statusSchema.safeParse(call.body);
    const word = answer.success ? answer.data.delivery_status?.trim() : undefined;
    if (!answer.success || !said200(answer.data.status) || word === undefined || word === '') {
      return { kind: 'problem', problem: 'unreachable' };
    }
    return { kind: 'status', status: statusOf(word), word: word.slice(0, 64) };
  }

  // Steadfast's two notices (28a.1's steadfastWebhookSchema): delivery_status, with the new status
  // and tracking_message, and tracking_update, with words only
  readNotice(body: unknown): CourierNotice {
    const parsed = steadfastWebhookSchema.safeParse(body);
    const raw: Record<string, unknown> =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body))
        : { body };
    if (!parsed.success) return { consignmentId: null, invoice: null, raw, kind: 'unread' };
    const notice = parsed.data;
    const ids = {
      consignmentId: courierId(notice.consignment_id),
      invoice: courierText(notice.invoice),
      raw,
    };
    const note = courierText(notice.tracking_message);
    const at = steadfastTime(notice.updated_at);
    const type = notice.notification_type?.trim().toLowerCase();
    if (type === 'tracking_update') {
      return note === null ? { ...ids, kind: 'unread' } : { ...ids, kind: 'note', note, at };
    }
    // delivery_status, or a notice with a status and no type
    if (notice.status === undefined) return { ...ids, kind: 'unread' };
    const status = statusOf(notice.status);
    return status === null
      ? { ...ids, kind: 'unread' }
      : { ...ids, kind: 'status', status, note, at };
  }

  // Steadfast's balance: it reads, changes nothing, and needs both keys
  async test(keys: CourierKeys): Promise<CourierProblem | null> {
    const call = await this.call(keys, '/get_balance');
    if (call.kind === 'problem') return call.problem;
    const answer = balanceSchema.safeParse(call.body);
    if (!answer.success) return 'unreachable';
    return said200(answer.data.status) ? null : 'rejected';
  }

  // The answer's JSON, or a problem when there is none to read: no connection, a timeout, a server
  // error, or a body that is not JSON (a proxy's error page). 401 and 403 are the keys refused,
  // here or in the body's own status. A 4xx with a JSON body is an answer (a refused booking).
  // Never throws, and never logs the keys
  private async call(
    keys: CourierKeys,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Call> {
    try {
      const response = await this.fetchFn(`${BASE_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'Api-Key': keys.apiKey,
          'Secret-Key': keys.secretKey,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) {
        return { kind: 'problem', problem: 'rejected' };
      }
      if (response.status >= 500) {
        this.logger.warn(`Steadfast answered HTTP ${String(response.status)}`);
        return { kind: 'problem', problem: 'unreachable' };
      }
      const json: unknown = await response.json();
      const own =
        typeof json === 'object' && json !== null && 'status' in json ? String(json.status) : '';
      if (own === '401' || own === '403') return { kind: 'problem', problem: 'rejected' };
      return { kind: 'answer', httpStatus: response.status, body: json };
    } catch (error) {
      this.logger.warn(
        `Steadfast did not answer: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { kind: 'problem', problem: 'unreachable' };
    }
  }
}
```

**Not run against Steadfast.** The calls and the answers are from Steadfast's documentation as written in 28a.1's
handoff (from memory: the documentation could not be fetched while writing). The unit tests check the adapter
against those answers. 28a.8 checked them against Steadfast's own GitHub package ("Steadfast's API, checked"). Before the first live shop, book one real parcel (28a.8's "Try it") and correct this file if
an answer differs: the table and the schemas are the only places that know Steadfast's words.

- **`STEADFAST_WORDS` is the one place Steadfast's statuses meet ours** (mine 39), with `satisfies` so every value is
  one of our statuses. **It is read through a `Map`**, so a word like `__proto__` or `constructor` can never reach
  an object's own properties, and no cast is needed.
- **The schemas read only what is used, and loosely:** Steadfast's own `status` comes as a number or a string, and
  its id as a number. `said200()` compares as text, so both forms work.
- **`refusalOf()`** takes the first sentence under a field (`errors.recipient_phone[0]`), else the message: that
  sentence is what the member needs ("must be 11 digits").
- **A refusal that names the invoice as taken is `taken`,** not a refusal (decision 3): the booking job then asks by
  the invoice instead of failing a parcel that exists.
- **`steadfastTime()`** reads Steadfast's zone-less time as Bangladesh time (`+06:00`). A time more than a day ahead
  is no time: a broken clock must not put a step in the future, where it would stay the newest for ever.
- **`book()`:** the address goes on one line and is cut to Steadfast's 250 characters (its label printer does not
  break lines); `cod_amount` is a number in Steadfast's API, and `Number("578.00")` is exact for any amount a
  parcel can have. A tracking code our column cannot keep is a problem, not a booking: recording half a parcel
  would be worse.
- **`find()` answers `exists`, never `found`** (mine 29), and a 404 or Steadfast's own non-200 is `none`.
- **`call()` never throws and never logs the keys.** 401 and 403 (in the HTTP status or in the body's own status)
  are the keys refused; 5xx and a body that is not JSON are no answer; a 4xx with a JSON body is an answer (a
  refused booking has one). The keys go in headers (`Api-Key`, `Secret-Key`), never in the address.

### The fake courier

```ts
import { createHash } from 'node:crypto';

import {
  type BookAnswer,
  type CourierAdapter,
  type CourierKeys,
  type CourierNotice,
  type CourierProblem,
  type FindAnswer,
  type ParcelRequest,
  type StatusAnswer,
} from './courier.js';
import { SteadfastAdapter } from './steadfast-adapter.js';

// A phone that makes the fake courier refuse the parcel, as Steadfast refuses a number it does not
// take, so the failed booking, the bell and "Book again" can be tried by hand and in the tests
export const FAKE_REFUSED_PHONE = '01700000000';

// Step 28a (decision 6): the courier of development, CI and the tests, like 27d's fake gateway. It
// keeps nothing and calls nobody: a booking's answer is worked out from the invoice, so the same
// invoice always gets the same consignment id and code (a retry is idempotent, as at Steadfast).
// Where a parcel goes next is told the way a courier tells it, by its webhook: post a Steadfast
// body to the account's webhook address (the guide's "Try it"); the poll gets nothing from it.
// It reads Steadfast's bodies, because with COURIER_MODE=fake it stands in for Steadfast. Refused
// in production (config.ts).
export class FakeCourier implements CourierAdapter {
  // Only for its pure readNotice: no call is ever made through it
  private readonly bodies = new SteadfastAdapter();

  book(keys: CourierKeys, parcel: ParcelRequest): Promise<BookAnswer> {
    const problem = fakeProblem(keys);
    if (problem !== null) return Promise.resolve({ kind: 'problem', problem });
    if (parcel.phone === FAKE_REFUSED_PHONE) {
      return Promise.resolve({
        kind: 'refused',
        detail: 'The recipient phone must be a working mobile number.',
      });
    }
    const hash = createHash('sha256').update(parcel.invoice).digest('hex');
    return Promise.resolve({
      kind: 'booked',
      parcel: {
        // Steadfast's ids are numbers; ten hex digits are at most 1,099,511,627,775
        consignmentId: String(Number.parseInt(hash.slice(0, 10), 16)),
        trackingCode: `FAKE${hash.slice(10, 20).toUpperCase()}`,
        // No page to show: the fake has no website
        trackingUrl: null,
        status: 'booked',
      },
    });
  }

  // It keeps no table, so no lost answer can be found: the caller books again, which gives the
  // same id and code anyway
  find(keys: CourierKeys): Promise<FindAnswer> {
    const problem = fakeProblem(keys);
    return Promise.resolve(problem === null ? { kind: 'none' } : { kind: 'problem', problem });
  }

  // It keeps nothing, so it cannot say where a parcel is: it answers as a courier that does not
  // answer, and the poll leaves the parcel where the webhook put it. An answer of "booked" here
  // would take a parcel back to booked after every webhook
  status(): Promise<StatusAnswer> {
    return Promise.resolve({ kind: 'problem', problem: 'unreachable' });
  }

  readNotice(body: unknown): CourierNotice {
    return this.bodies.readNotice(body);
  }

  test(keys: CourierKeys): Promise<CourierProblem | null> {
    return Promise.resolve(fakeProblem(keys));
  }
}

// Two API keys that make the fake courier answer like Steadfast on a bad day, as the fake
// gateway's two store ids do
function fakeProblem(keys: CourierKeys): CourierProblem | null {
  if (keys.apiKey === 'fake_rejected') return 'rejected';
  if (keys.apiKey === 'fake_unreachable') return 'unreachable';
  return null;
}
```

- **The answer is worked out from the invoice** (a SHA-256), so the same invoice always gets the same id and code,
  as an idempotent courier would answer a retry.
- **`FAKE_REFUSED_PHONE` and the two keys** make the bad days reachable by hand and in the tests: a refused parcel,
  refused keys, no answer.
- **`status()` answers "no answer"** (mine 34).
- **`readNotice()` is Steadfast's**: with `COURIER_MODE=fake` the fake stands in for Steadfast, so the webhook
  address, its body and its token are the real ones.

```ts
import { describe, expect, it } from 'vitest';

import { stepStatusOf } from '../storefront/shipping/shipment-news.js';
import { bearerOf } from '../storefront/shipping/courier-webhooks.js';
import { invoiceOf } from '../storefront/shipping/shipments.js';
import { courierId, courierText, eventKeyOf, type ParcelRequest } from './courier.js';
import { FAKE_REFUSED_PHONE, FakeCourier } from './fake-courier.js';
import { SteadfastAdapter, steadfastTime } from './steadfast-adapter.js';

const KEYS = { apiKey: 'k8xvq2m4b1c3d5e6', secretKey: 's9yw3n5c2d4e6f7g' };
const PARCEL: ParcelRequest = {
  invoice: 'W-000123',
  name: 'Sadia Rahman',
  phone: '01786120356',
  address: 'House 12\nRoad 4, Dhanmondi, Inside Dhaka',
  codAmount: '578.00',
  note: '3 items',
};

// A fetch that answers one JSON body and remembers what it was asked, as the gateway's test does
function answering(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
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

function failing(): typeof fetch {
  return () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
}

describe('Steadfast adapter (step 28a.3)', () => {
  it('books with the keys in headers, the address on one line and the amount as a number', async () => {
    const { calls, fetchFn } = answering({
      status: 200,
      message: 'Consignment has been created successfully.',
      consignment: {
        consignment_id: 1424107,
        invoice: 'W-000123',
        tracking_code: '15BAEB8A',
        recipient_name: 'Sadia Rahman',
        cod_amount: 578,
        status: 'in_review',
      },
    });
    const answer = await new SteadfastAdapter(fetchFn).book(KEYS, PARCEL);
    expect(answer).toEqual({
      kind: 'booked',
      parcel: {
        consignmentId: '1424107',
        trackingCode: '15BAEB8A',
        trackingUrl: 'https://steadfast.com.bd/t/15BAEB8A',
        status: 'booked',
      },
    });
    const call = calls[0];
    expect(call?.url).toBe('https://portal.packzy.com/api/v1/create_order');
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.headers).toMatchObject({
      'Api-Key': KEYS.apiKey,
      'Secret-Key': KEYS.secretKey,
    });
    const body = call?.init?.body;
    const sent: unknown = typeof body === 'string' ? JSON.parse(body) : null;
    expect(sent).toEqual({
      invoice: 'W-000123',
      recipient_name: 'Sadia Rahman',
      recipient_phone: '01786120356',
      recipient_address: 'House 12 Road 4, Dhanmondi, Inside Dhaka',
      cod_amount: 578,
      note: '3 items',
    });
  });

  it("refuses a parcel with Steadfast's own sentence, and knows a taken invoice", async () => {
    const refused = answering(
      { status: 400, errors: { recipient_phone: ['The recipient phone must be 11 digits.'] } },
      422,
    );
    expect(await new SteadfastAdapter(refused.fetchFn).book(KEYS, PARCEL)).toEqual({
      kind: 'refused',
      detail: 'The recipient phone must be 11 digits.',
    });
    const taken = answering({
      status: 400,
      errors: { invoice: ['The invoice has already been taken.'] },
    });
    expect(await new SteadfastAdapter(taken.fetchFn).book(KEYS, PARCEL)).toEqual({ kind: 'taken' });
  });

  it('reads refused keys, no answer and a broken body as problems, never as a booking', async () => {
    expect(
      await new SteadfastAdapter(answering({ message: 'Unauthorized' }, 401).fetchFn).book(
        KEYS,
        PARCEL,
      ),
    ).toEqual({ kind: 'problem', problem: 'rejected' });
    expect(
      await new SteadfastAdapter(answering({ status: 401 }).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'problem', problem: 'rejected' });
    expect(await new SteadfastAdapter(failing()).book(KEYS, PARCEL)).toEqual({
      kind: 'problem',
      problem: 'unreachable',
    });
    expect(
      await new SteadfastAdapter(answering({ oops: true }, 502).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'problem', problem: 'unreachable' });
    // "200" without a consignment is not a booking either
    expect(
      await new SteadfastAdapter(answering({ status: 200 }).fetchFn).book(KEYS, PARCEL),
    ).toEqual({ kind: 'refused', detail: null });
  });

  it('finds a parcel by its invoice only as "exists": Steadfast does not say its code', async () => {
    const { calls, fetchFn } = answering({ status: 200, delivery_status: 'in_review' });
    expect(await new SteadfastAdapter(fetchFn).find(KEYS, 'W-000123-2')).toEqual({
      kind: 'exists',
    });
    expect(calls[0]?.url).toBe('https://portal.packzy.com/api/v1/status_by_invoice/W-000123-2');
    expect(
      await new SteadfastAdapter(
        answering({ status: 404, message: 'Not found' }, 404).fetchFn,
      ).find(KEYS, 'W-000124'),
    ).toEqual({ kind: 'none' });
  });

  it("maps Steadfast's statuses in one table, and keeps a word it does not know", async () => {
    const status = async (word: string) =>
      new SteadfastAdapter(answering({ status: 200, delivery_status: word }).fetchFn).status(
        KEYS,
        '1424107',
      );
    expect(await status('in_review')).toEqual({
      kind: 'status',
      status: 'booked',
      word: 'in_review',
    });
    expect(await status('pending')).toMatchObject({ status: 'in_transit' });
    expect(await status('hold')).toMatchObject({ status: 'on_hold' });
    // The rider says delivered, the hub has not approved it: not Delivered yet
    expect(await status('delivered_approval_pending')).toMatchObject({
      status: 'out_for_delivery',
    });
    expect(await status('delivered')).toMatchObject({ status: 'delivered' });
    expect(await status('partial_delivered')).toMatchObject({ status: 'partly_delivered' });
    expect(await status('cancelled')).toMatchObject({ status: 'cancelled' });
    expect(await status('Delivered ')).toMatchObject({ status: 'delivered' });
    expect(await status('teleported')).toEqual({
      kind: 'status',
      status: null,
      word: 'teleported',
    });
    expect(await status('__proto__')).toMatchObject({ status: null });
  });

  it('reads both webhook notices, and keeps a body it cannot read', () => {
    const adapter = new SteadfastAdapter(failing());
    expect(
      adapter.readNotice({
        notification_type: 'delivery_status',
        consignment_id: 1424107,
        invoice: 'W-000123',
        cod_amount: 578,
        status: 'delivered',
        delivery_charge: 80,
        tracking_message: '  Delivered to  the customer ',
        updated_at: '2026-11-23 14:05:09',
      }),
    ).toMatchObject({
      kind: 'status',
      consignmentId: '1424107',
      invoice: 'W-000123',
      status: 'delivered',
      note: 'Delivered to the customer',
      at: new Date('2026-11-23T08:05:09.000Z'),
    });
    expect(
      adapter.readNotice({
        notification_type: 'tracking_update',
        consignment_id: '1424107',
        tracking_message: 'Received at Sylhet hub',
      }),
    ).toMatchObject({ kind: 'note', note: 'Received at Sylhet hub', at: null });
    expect(
      adapter.readNotice({ notification_type: 'delivery_status', status: 'teleported' }),
    ).toMatchObject({ kind: 'unread' });
    expect(adapter.readNotice({ consignment_id: { nested: true } })).toMatchObject({
      kind: 'unread',
      consignmentId: null,
    });
    expect(adapter.readNotice('not an object')).toMatchObject({
      kind: 'unread',
      raw: { body: 'not an object' },
    });
  });

  it('tests the keys with the balance, which changes nothing', async () => {
    const { calls, fetchFn } = answering({ status: 200, current_balance: 0 });
    expect(await new SteadfastAdapter(fetchFn).test(KEYS)).toBeNull();
    expect(calls[0]?.url).toBe('https://portal.packzy.com/api/v1/get_balance');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(await new SteadfastAdapter(answering({}, 403).fetchFn).test(KEYS)).toBe('rejected');
    expect(await new SteadfastAdapter(failing()).test(KEYS)).toBe('unreachable');
  });

  it("reads Steadfast's time as Bangladesh time, and no time it cannot trust", () => {
    const now = new Date('2026-11-23T10:00:00Z');
    expect(steadfastTime('2026-11-23 14:05:09', now)?.toISOString()).toBe(
      '2026-11-23T08:05:09.000Z',
    );
    expect(steadfastTime('2026-11-23T08:05:09Z', now)?.toISOString()).toBe(
      '2026-11-23T08:05:09.000Z',
    );
    expect(steadfastTime('yesterday', now)).toBeNull();
    expect(steadfastTime('2027-01-01 00:00:00', now)).toBeNull();
    expect(steadfastTime(undefined, now)).toBeNull();
  });
});

describe('fake courier (step 28a.3)', () => {
  it('books the same invoice with the same id and code every time', async () => {
    const fake = new FakeCourier();
    const first = await fake.book(KEYS, PARCEL);
    const again = await fake.book(KEYS, PARCEL);
    expect(first).toEqual(again);
    expect(first).toMatchObject({
      kind: 'booked',
      parcel: { status: 'booked', trackingUrl: null },
    });
    const other = await fake.book(KEYS, { ...PARCEL, invoice: 'W-000123-2' });
    expect(other).not.toEqual(first);
  });

  it('refuses keys, a phone and answers nothing as asked', async () => {
    const fake = new FakeCourier();
    expect(await fake.book({ ...KEYS, apiKey: 'fake_rejected' }, PARCEL)).toEqual({
      kind: 'problem',
      problem: 'rejected',
    });
    expect(await fake.test({ ...KEYS, apiKey: 'fake_unreachable' })).toBe('unreachable');
    expect(await fake.book(KEYS, { ...PARCEL, phone: FAKE_REFUSED_PHONE })).toMatchObject({
      kind: 'refused',
    });
    expect(await fake.find(KEYS)).toEqual({ kind: 'none' });
    expect(await fake.status()).toEqual({ kind: 'problem', problem: 'unreachable' });
    expect(fake.readNotice({ status: 'delivered', consignment_id: 7 })).toMatchObject({
      kind: 'status',
      status: 'delivered',
      consignmentId: '7',
    });
  });
});

describe('courier helpers (step 28a.3)', () => {
  it("cuts a courier's words to the columns, and reads only plain ids", () => {
    expect(courierText(`  ${'a'.repeat(400)} `)).toHaveLength(300);
    expect(courierText('   ')).toBeNull();
    expect(courierText(42)).toBeNull();
    expect(courierId(1424107)).toBe('1424107');
    expect(courierId(' SF-12 ')).toBe('SF-12');
    expect(courierId(1.5)).toBeNull();
    expect(courierId('a b')).toBeNull();
  });

  it('keys one step by its status, time and note', () => {
    const at = new Date('2026-11-23T08:05:09Z');
    expect(eventKeyOf('status', 'delivered', at, null)).toMatch(/^[0-9a-f]{64}$/);
    expect(eventKeyOf('status', 'delivered', at, null)).toBe(
      eventKeyOf('status', 'delivered', at, null),
    );
    expect(eventKeyOf('status', 'delivered', at, 'x')).not.toBe(
      eventKeyOf('status', 'delivered', at, null),
    );
  });

  it('gives a later parcel the order number with its own number', () => {
    expect(invoiceOf('W-000123', 1)).toBe('W-000123');
    expect(invoiceOf('W-000123', 3)).toBe('W-000123-3');
  });

  it('reads a cancel after the pickup as goods coming back', () => {
    expect(stepStatusOf('booked', 'cancelled')).toBe('cancelled');
    expect(stepStatusOf('in_transit', 'cancelled')).toBe('returning');
    expect(stepStatusOf('in_transit', 'delivered')).toBe('delivered');
  });

  it('takes only a bearer token from the Authorization header', () => {
    expect(bearerOf('Bearer abc_DEF-123')).toBe('abc_DEF-123');
    expect(bearerOf('bearer  abc ')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer a b')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});
```

The unit tests: Steadfast against its documented answers (a booking, a refusal, a taken invoice, the keys refused,
no answer, a broken body, the status table, both notices, the balance test, the time), the fake courier, and the
helpers the shop's side uses (`invoiceOf`, `stepStatusOf`, `bearerOf`).

### Two new error codes

```diff
@@ -779,12 +779,20 @@ export const ERROR_CODES = [
   'storefront_shipment_not_failed',
   // Cancel after the courier picked the parcel up: it comes back as a return (step 28b)
   'storefront_order_parcel_on_its_way',
+  // 28a.3: cancel while the worker is still booking the parcel. The booking ends booked or failed
+  // within about 15 minutes (decision 4); cancelling in between could leave a parcel at the
+  // courier for an order that no longer exists
+  'storefront_order_parcel_booking',
   // Why a booking failed, kept on the parcel and shown with Book again (decision 4): the courier
   // refused the keys (the tenant's account, not our bug, §14.6 rule 5), refused the parcel itself
   // (its own words in errorDetail: "Invalid phone number"), or never answered in time
   'courier_rejected_keys',
   'courier_rejected_parcel',
   'courier_unreachable',
+  // 28a.3: the courier has a parcel with this order's number already (an earlier call reached it
+  // and its answer was lost), but its answer does not say the tracking code (Steadfast's
+  // status_by_invoice). The parcel is found on the courier's panel
+  'courier_invoice_taken',
   // The courier's webhook with no token or the wrong one, or for an account that is not an API
   // account of this provider. A 401, so the courier's panel shows that something is wrong
   'courier_webhook_token_invalid',
```
```diff
@@ -8520,10 +8520,14 @@ export const en = {
     storefront_shipment_not_failed: 'This parcel did not fail. Reload the page to see where it is.',
     storefront_order_parcel_on_its_way:
       'The courier has the parcel now, so the order can’t be cancelled. Ask the courier to return it.',
+    storefront_order_parcel_booking:
+      'The parcel is being booked with the courier. Cancel once it is booked or its booking failed.',
     courier_rejected_keys:
       'The courier refused the account’s keys. Check them in Shop couriers, then book again.',
     courier_rejected_parcel: 'The courier refused the parcel. Fix what it says, then book again.',
     courier_unreachable: 'The courier did not answer. Book again in a few minutes.',
+    courier_invoice_taken:
+      'The courier already has a parcel with this order’s number. Find it on the courier’s panel and cancel it there, then book again.',
     courier_webhook_token_invalid:
       'This webhook token is not right. Paste the token from Shop couriers.',
   } satisfies Record<ErrorCode, string>,
```
```diff
@@ -7916,11 +7916,15 @@ export const bn: Messages = {
       'এই পার্সেলের বুকিং ব্যর্থ হয়নি। কোথায় আছে দেখতে পেজটা আবার লোড করুন।',
     storefront_order_parcel_on_its_way:
       'পার্সেল এখন কুরিয়ারের কাছে, তাই অর্ডার বাতিল করা যাবে না। কুরিয়ারকে ফেরত দিতে বলুন।',
+    storefront_order_parcel_booking:
+      'পার্সেলটা কুরিয়ারে বুক হচ্ছে। বুক হলে বা বুকিং ব্যর্থ হলে তারপর বাতিল করুন।',
     courier_rejected_keys:
       'কুরিয়ার অ্যাকাউন্টের key মানেনি। শপের কুরিয়ার পেজে key দেখে নিন, তারপর আবার বুক করুন।',
     courier_rejected_parcel:
       'কুরিয়ার পার্সেলটা নেয়নি। কুরিয়ার যা বলেছে তা ঠিক করে আবার বুক করুন।',
     courier_unreachable: 'কুরিয়ার উত্তর দেয়নি। কয়েক মিনিট পরে আবার বুক করুন।',
+    courier_invoice_taken:
+      'এই অর্ডারের নম্বরে কুরিয়ারের কাছে আগেই একটা পার্সেল আছে। কুরিয়ারের প্যানেলে সেটা খুঁজে বাতিল করুন, তারপর আবার বুক করুন।',
     courier_webhook_token_invalid:
       'এই webhook token ঠিক না। শপের কুরিয়ার পেজ থেকে token পেস্ট করুন।',
   },
```

`storefront_order_parcel_booking` (mine 30) and `courier_invoice_taken` (mine 29), with their words. Each says what
to do next, like the other courier errors.

### The Shop couriers page

```ts
import { z } from 'zod';

import { type CredentialsKey, openSecret, sealSecret } from '../../payments/credentials.js';
import type { CourierKeys } from '../../shipping/courier.js';

// Step 28a (decision 7): a courier account's two keys, sealed as one JSON text with 27d's sealing
// (28a.2's keys_sealed: one box, one nonce, one key version, so the two keys are never sealed by
// two different keys). The table is in the seal's context: a box copied into the gateway's row
// does not open there.

const keysSchema = z.object({ apiKey: z.string().min(1), secretKey: z.string().min(1) });

export function sealKeys(
  key: CredentialsKey,
  tenantId: string,
  keys: CourierKeys,
): { sealed: Buffer; keyVersion: number } {
  // Only the two fields, in this order: a wider object passed in by mistake seals nothing more
  const text = JSON.stringify({ apiKey: keys.apiKey, secretKey: keys.secretKey });
  return sealSecret(key, 'courier_accounts', tenantId, text);
}

// The keys, or null when they cannot be opened: no CREDENTIALS_KEY on this server, a box sealed by
// another key, changed in the database or another workspace's, or a text that is not the two keys.
// The caller says which workspace in its log, never the value
export function openKeys(
  key: CredentialsKey | null,
  row: { tenantId: string; keysSealed: Buffer | null; keyVersion: number | null },
): CourierKeys | null {
  if (key === null || row.keysSealed === null || row.keyVersion === null) return null;
  const text = openSecret(key, 'courier_accounts', row.tenantId, row.keysSealed, row.keyVersion);
  if (text === null) return null;
  try {
    const keys = keysSchema.safeParse(JSON.parse(text));
    return keys.success ? keys.data : null;
  } catch {
    // JSON.parse throws on a text that is not JSON: the box opened, so this is a bug, not an attack
    return null;
  }
}
```

- **One JSON text, one seal** (28a.2's `keys_sealed`). `sealKeys()` builds the object from the two fields by name,
  so a wider object passed in by mistake seals nothing more.
- **`openKeys()` answers null, never throws:** no key, another key's seal, a changed box, or a text that is not the
  two keys. The callers log which account, never the value.

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COURIER_OF_PROVIDER,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierSetup,
  type CourierTestProblem,
  type CreateCourierAccountInput,
  routes,
  type UpdateCourierAccountInput,
} from '@omnivo/contracts';
import { courierAccounts } from '@omnivo/db';
import { and, asc, eq, or, sql } from 'drizzle-orm';

import { audit, created, diff } from '../../common/audit/audit.js';
import { isCheckViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import type { Config, ShippingConfig } from '../../config.js';
import { CONFIG, COURIERS, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import type { CredentialsKey } from '../../payments/credentials.js';
import {
  type ApiCourierProvider,
  type CourierAdapters,
  isApiProvider,
} from '../../shipping/courier.js';
import { newToken, tokenHash } from '../orders/order-secrets.js';
import { openKeys, sealKeys } from './courier-keys.js';

type AccountRow = typeof courierAccounts.$inferSelect;

// Each API provider's webhook path, from the contract, so the address the page shows is the one
// the controller serves. A Record over the providers: 28c's Pathao needs its route here to compile
const WEBHOOK_PATH = {
  steadfast: routes.shipping.steadfastWebhook.path,
} satisfies Record<ApiCourierProvider, string>;

function archived(): AppError {
  return new AppError(
    409,
    'courier_account_archived',
    'This courier account is archived. Restore it first.',
  );
}

function notBookable(field: string): AppError {
  return new AppError(
    422,
    'courier_account_not_bookable',
    'Only an active account that books by API can do this.',
    { fieldErrors: { [field]: ['courier_account_not_bookable'] } },
  );
}

// The audit's view: plain values, never a key or a token. A change of keys or token is written as
// the word "changed" under its own field, like the gateway's password (27d)
function snapshot(row: AccountRow) {
  return {
    name: row.name,
    provider: row.provider,
    courier: row.courier,
    status: row.archivedAt === null ? 'active' : 'archived',
  };
}

// Step 28a: Storefront → Shop couriers (decisions 7, 8, 13 and 14). storefront.manage on every
// route (the contract says so and the guard checks it). An API account's keys are sealed here and
// never answered; its webhook token is made here, answered once, and only its hash is kept. A
// manual account is a name and a courier: nothing is called for it.
@Injectable()
export class CourierAccountsService {
  private readonly logger = new Logger(CourierAccountsService.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
  ) {}

  setup(): Promise<CourierSetup> {
    return this.withTenant((tx) => this.read(tx));
  }

  create(input: CreateCourierAccountInput): Promise<CourierAccountSaved> {
    // Before the transaction: a server that cannot seal keys says so without touching anything
    if (input.provider !== 'manual') this.key();
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const userId = currentPrincipal().userId;
      // The token is made with the account (28a.2's secrets check wants its hash at once)
      const token = input.provider === 'manual' ? null : newToken();
      const values =
        input.provider === 'manual'
          ? { provider: input.provider, name: input.name, courier: input.courier }
          : {
              provider: input.provider,
              name: input.name,
              courier: COURIER_OF_PROVIDER[input.provider],
              ...this.sealed(this.key(), tenantId, input),
              webhookTokenHash: token === null ? null : tokenHash(token),
            };
      const [row] = await tx
        .insert(courierAccounts)
        .values({ tenantId, ...values, createdBy: userId, updatedBy: userId })
        .returning();
      if (row === undefined) throw new Error('Courier account insert returned no row');
      await audit(tx, {
        action: 'courier_account.created',
        entityType: 'courier_account',
        entityId: row.id,
        changes: created({
          ...snapshot(row),
          ...(row.provider === 'manual' ? {} : { keys: 'changed', webhookToken: 'changed' }),
        }),
      });
      return { account: this.toAccount(row), webhookToken: token };
    });
  }

  update(id: string, input: UpdateCourierAccountInput): Promise<CourierAccount> {
    // An empty box keeps the saved key, so only a new key needs CREDENTIALS_KEY
    const typed = input.provider !== 'manual' && (input.apiKey !== '' || input.secretKey !== '');
    const key = typed ? this.key() : null;
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, input.version);
      if (before.archivedAt !== null) throw archived();
      // The provider never changes (28a.1): the form says which one it is, and must say the saved one
      if (input.provider !== before.provider) {
        throw new AppError(
          409,
          'courier_provider_fixed',
          'A courier account keeps its provider. Add a new account for another one.',
        );
      }
      let keys: { keysSealed: Buffer; keyVersion: number } | null = null;
      if (input.provider !== 'manual' && key !== null) {
        // One box for both keys: a box with one new key needs the other one from the saved box
        const saved = openKeys(key, before);
        const apiKey = input.apiKey !== '' ? input.apiKey : saved?.apiKey;
        const secretKey = input.secretKey !== '' ? input.secretKey : saved?.secretKey;
        if (apiKey === undefined || secretKey === undefined) {
          // The saved box does not open with this server's key: both keys must be typed again
          const field = apiKey === undefined ? 'apiKey' : 'secretKey';
          throw new AppError(422, 'courier_key_required', 'Type both keys again.', {
            fieldErrors: { [field]: ['courier_key_required'] },
          });
        }
        // The same keys typed again are no change (the audit and the last test agree)
        if (saved?.apiKey !== apiKey || saved.secretKey !== secretKey) {
          keys = this.sealed(key, getTenantId(), { apiKey, secretKey });
        }
      }
      const [after] = await tx
        .update(courierAccounts)
        .set({
          name: input.name,
          ...(input.provider === 'manual' ? { courier: input.courier } : {}),
          // The last test said something about the old keys only
          ...(keys === null ? {} : { ...keys, lastTestedAt: null, lastTestProblem: null }),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.updated',
        entityType: 'courier_account',
        entityId: id,
        changes: {
          ...diff(snapshot(before), snapshot(after)),
          ...(keys === null ? {} : { keys: { from: null, to: 'changed' } }),
        },
      });
      return this.toAccount(after);
    });
  }

  // "Test connection" (decision 7): the saved keys, asked outside the transaction, as 27d's test,
  // so no row stays locked while the courier thinks. A refusal is an answer, not an error
  async test(id: string): Promise<CourierAccount> {
    const saved = await this.withTenant((tx) => this.find(tx, id, false));
    if (!isApiProvider(saved.provider)) throw notBookable('id');
    const keys = openKeys(this.shipping.credentialsKey, saved);
    if (keys === null) this.cannotOpen(saved);
    // Keys this server cannot open cannot reach the courier either: refused, and typing them again
    // seals them with this server's key
    const problem: CourierTestProblem | null =
      keys === null ? 'rejected' : await this.couriers[saved.provider].test(keys);
    return this.withTenant(async (tx) => {
      await this.find(tx, id, true);
      const [after] = await tx
        .update(courierAccounts)
        // No version bump: a test changes no value the form holds
        .set({ lastTestedAt: new Date(), lastTestProblem: problem })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.tested',
        entityType: 'courier_account',
        entityId: id,
        changes: created({ testResult: problem ?? 'ok' }),
      });
      return this.toAccount(after);
    });
  }

  // A new token replaces the old one at once (28a.1): the courier's panel needs the new one too
  renewToken(id: string, version: number): Promise<CourierAccountSaved> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, version);
      if (before.provider === 'manual') throw notBookable('id');
      if (before.archivedAt !== null) throw archived();
      const token = newToken();
      const [after] = await tx
        .update(courierAccounts)
        .set({
          webhookTokenHash: tokenHash(token),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: 'courier_account.token_renewed',
        entityType: 'courier_account',
        entityId: id,
        changes: { webhookToken: { from: null, to: 'changed' } },
      });
      return { account: this.toAccount(after), webhookToken: token };
    });
  }

  // Not offered for new parcels and no longer the default, in one UPDATE: 28a.2's default check
  // refuses an archived default, so the flag goes with it. Its parcels on their way still get the
  // courier's news
  archive(id: string, version: number): Promise<CourierAccount> {
    return this.setArchived(id, version, true);
  }

  restore(id: string, version: number): Promise<CourierAccount> {
    return this.setArchived(id, version, false);
  }

  // The Packed dialog's first choice (decision 13), or none. One UPDATE sets the new default and
  // clears the old one (28a.2's partial unique index would refuse two at any moment in between).
  // It reads only the rows that change: the old default and the new one
  setDefault(accountId: string | null): Promise<CourierSetup> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [before] = await tx
        .select({ id: courierAccounts.id, name: courierAccounts.name })
        .from(courierAccounts)
        .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.isDefault, true)));
      let name: string | null = null;
      if (accountId !== null) {
        const account = await this.find(tx, accountId, true);
        if (account.provider === 'manual' || account.archivedAt !== null) {
          throw notBookable('accountId');
        }
        name = account.name;
      }
      if ((before?.id ?? null) !== accountId) {
        try {
          await tx
            .update(courierAccounts)
            .set({
              isDefault:
                accountId === null ? false : sql`${courierAccounts.id} = ${accountId}::uuid`,
            })
            .where(
              and(
                eq(courierAccounts.tenantId, tenantId),
                accountId === null
                  ? eq(courierAccounts.isDefault, true)
                  : or(eq(courierAccounts.isDefault, true), eq(courierAccounts.id, accountId)),
              ),
            );
        } catch (error) {
          // Archived or made manual since the read above, by another request: the check's answer
          if (isCheckViolation(error, 'courier_accounts_default_check')) {
            throw notBookable('accountId');
          }
          throw error;
        }
        await audit(tx, {
          action: 'storefront.default_courier_set',
          entityType: 'storefront',
          entityId: tenantId,
          changes: { defaultCourier: { from: before?.name ?? null, to: name } },
        });
      }
      return this.read(tx);
    });
  }

  private setArchived(id: string, version: number, archive: boolean): Promise<CourierAccount> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id, version);
      // Already as asked: no change, no audit row (a second tab's click)
      if ((before.archivedAt !== null) === archive) return this.toAccount(before);
      const [after] = await tx
        .update(courierAccounts)
        .set({
          archivedAt: archive ? new Date() : null,
          ...(archive ? { isDefault: false } : {}),
          version: sql`${courierAccounts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)))
        .returning();
      if (after === undefined) throw notFound('Courier account');
      await audit(tx, {
        action: archive ? 'courier_account.archived' : 'courier_account.restored',
        entityType: 'courier_account',
        entityId: id,
        changes: diff(snapshot(before), snapshot(after)),
      });
      return this.toAccount(after);
    });
  }

  // Active ones first, then by name: the page's two tabs read one list
  private async read(tx: Transaction): Promise<CourierSetup> {
    const rows = await tx
      .select()
      .from(courierAccounts)
      .where(eq(courierAccounts.tenantId, getTenantId()))
      .orderBy(
        sql`${courierAccounts.archivedAt} IS NOT NULL`,
        asc(courierAccounts.name),
        asc(courierAccounts.id),
      );
    return {
      accounts: rows.map((row) => this.toAccount(row)),
      defaultAccountId: rows.find((row) => row.isDefault)?.id ?? null,
    };
  }

  private sealed(
    key: CredentialsKey,
    tenantId: string,
    keys: { apiKey: string; secretKey: string },
  ) {
    const { sealed, keyVersion } = sealKeys(key, tenantId, keys);
    return { keysSealed: sealed, keyVersion };
  }

  private key(): CredentialsKey {
    const key = this.shipping.credentialsKey;
    if (key === null) {
      throw new AppError(
        422,
        'courier_key_missing',
        "This server has no CREDENTIALS_KEY, so it cannot keep a courier's keys.",
      );
    }
    return key;
  }

  private cannotOpen(row: AccountRow): void {
    // The workspace, the account and why, never a value
    this.logger.error(
      `The keys of courier account ${row.id} (tenant ${row.tenantId}) cannot be opened (${this.shipping.credentialsKey === null ? 'no CREDENTIALS_KEY' : `key version ${String(row.keyVersion)}`})`,
    );
  }

  private async lock(tx: Transaction, id: string, version: number): Promise<AccountRow> {
    const row = await this.find(tx, id, true);
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async find(tx: Transaction, id: string, lock: boolean): Promise<AccountRow> {
    const query = tx
      .select()
      .from(courierAccounts)
      .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)));
    const [row] = lock ? await query.for('update') : await query;
    if (row === undefined) throw notFound('Courier account');
    return row;
  }

  private toAccount(row: AccountRow): CourierAccount {
    const base = this.config.apiBaseUrl.replace(/\/+$/, '');
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      courier: row.courier,
      status: row.archivedAt === null ? 'active' : 'archived',
      webhookUrl: isApiProvider(row.provider)
        ? `${base}${WEBHOOK_PATH[row.provider].replace(':id', row.id)}`
        : null,
      hasWebhookToken: row.webhookTokenHash !== null,
      lastWebhookAt: row.lastWebhookAt?.toISOString() ?? null,
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

- **`WEBHOOK_PATH` is read from the contract's route,** so the address the page shows is the one the controller
  serves, and a Record over the providers again.
- **`create()` checks the key before the transaction,** so a server with no `CREDENTIALS_KEY` answers
  `courier_key_missing` without touching anything. The token is made with the account: 28a.2's secrets check
  wants its hash in the same row. The answer carries the token once (decision 16).
- **`update()` keeps an empty box** (27d's write-only rule). Both keys live in one box, so a new API key with an
  empty secret box needs the saved secret: the saved box is opened, and when it cannot be (another server key),
  both keys must be typed again (`courier_key_required` on the empty one). The same keys typed again are no change,
  and a change clears the last test, which said something about the old keys only.
- **The provider never changes** (`courier_provider_fixed`): the form's `provider` must be the saved one.
- **`test()` asks the courier outside any transaction** (27d's reason) and keeps its answer without a version bump:
  a test changes nothing the form holds, so a form open in another tab can still be saved.
- **`renewToken()`** replaces the hash at once; the old token stops working the same moment.
- **`setArchived()` clears `is_default` in the same UPDATE:** 28a.2's default check refuses an archived default. A
  second click (already archived) writes nothing and no audit row.
- **`setDefault()`** sets the new default and clears the old one in one UPDATE (28a.2's partial unique index would
  refuse two at any moment in between), touching only those two rows. A race with an archive of the same account
  ends in the check, and its answer is the same `courier_account_not_bookable`. No change, no audit row.
- **`read()` lists active accounts first, then by name:** the page's two tabs read one list.
- **`toAccount()`** never answers a key or a hash: `hasWebhookToken` and `lastWebhookAt` are what the page needs.

### Moving an order

```ts
import { Injectable } from '@nestjs/common';
import {
  compareMoney,
  multiplyMoney,
  spreadMoney,
  type StorefrontOrderStatus,
  todayIn,
} from '@omnivo/contracts';
import {
  deliveryLines,
  salesOrderLines,
  salesOrders,
  storefrontOrderLines,
  storefrontOrders,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { audit, diff } from '../../common/audit/audit.js';
import { AppError, notFound } from '../../common/http/app-error.js';
import { currentActorId, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { InvoicesService } from '../../sales/invoices.service.js';
import type { OrderLineRow, OrderRow } from './order-view.js';
import { ShopPaymentReceipts } from './payment-receipts.js';

// Step 28a: a shop order's Shipped and Delivered, out of StorefrontOrdersService (27b), so the
// courier's news (storefront/shipping/shipment-news.ts) moves an order with the same code as the
// member's buttons: in the API for a webhook, and in the worker for the 15-minute poll, which has
// no StorefrontOrdersService. Each takes an order the caller has locked (FOR UPDATE) in its own
// transaction, and says nothing about versions: the buttons check the version first, the
// courier's news has none to check. Who did it is currentActorId(): the member, or null for the
// courier's news (27b's decision 20).

export function stepInvalid(): AppError {
  return new AppError(
    409,
    'storefront_order_step_invalid',
    'This order has moved on since it was loaded. Reload it.',
  );
}

// The order's columns a move may set
export type OrderMove = Partial<
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
> & { status: StorefrontOrderStatus };

// The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
// reads them together), the version up, and the audit row of the move
export async function moveOrder(
  tx: Transaction,
  before: OrderRow,
  fields: OrderMove,
): Promise<void> {
  await tx
    .update(storefrontOrders)
    .set({
      ...fields,
      version: sql`${storefrontOrders.version} + 1`,
      updatedBy: currentActorId(),
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

// FOR UPDATE, never a pending order (that one is the shopper's). The courier's news locks the
// order this way before its parcel, the same order as the buttons, so the two take turns
export async function lockOrder(tx: Transaction, id: string): Promise<OrderRow> {
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
  return order;
}

// The order's sales order, which Packed and Delivered build on
export async function salesOrderOf(tx: Transaction, order: OrderRow) {
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

export function orderLinesOf(tx: Transaction, orderId: string): Promise<OrderLineRow[]> {
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

export function salesOrderLinesOf(tx: Transaction, salesOrderId: string) {
  return tx
    .select()
    .from(salesOrderLines)
    .where(
      and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, salesOrderId)),
    )
    .orderBy(asc(salesOrderLines.lineNo));
}

// Today in the workspace's time zone: the documents a move makes are dated by it
export async function shopToday(tx: Transaction): Promise<string> {
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  return todayIn(settings?.timezone ?? 'Asia/Dhaka');
}

@Injectable()
export class ShopOrderMoves {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly paymentReceipts: ShopPaymentReceipts,
  ) {}

  // 27b's decision 6: a status only. Step 28a: the courier's "picked up" calls it too
  async ship(tx: Transaction, order: OrderRow): Promise<void> {
    if (order.status !== 'packed') throw stepInvalid();
    await moveOrder(tx, order, { status: 'shipped', shippedAt: new Date() });
  }

  // 27b's decision 7: a posted invoice for what the challan took and the delivery charge, dated
  // today (decision 21) and unpaid: the cash the rider brings back is a money receipt. Step 28a:
  // the courier's "delivered" calls it too
  async deliver(tx: Transaction, order: OrderRow): Promise<void> {
    if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
    const salesOrder = await salesOrderOf(tx, order);
    const orderLines = await orderLinesOf(tx, order.id);
    const soLines = await salesOrderLinesOf(tx, salesOrder.id);
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
    // sales order's lines after the order's own (the maker added it last). Step 27c: and with
    // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
    // would bill more than the shopper pays
    const discounts = challanDiscounts(challan, soLineById);
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
        discount: discounts.get(line.id) ?? '0',
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
      date: await shopToday(tx),
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
    // Step 27d (decision 6): a paid online order's advance pays its invoice at once
    await this.paymentReceipts.applyToInvoice(tx, order.id, invoiceId);
    await moveOrder(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
  }
}

// Step 27c: each challan line's share of its sales order line's discount, by challan line id. A
// line packed from two batches is two challan lines of one order line, so the order line's
// discount is spread over them by what each is worth at the order's price (spreadMoney: to the
// paisa, adding up to the discount exactly). One challan line per order line, the usual case,
// takes the whole discount. The maker wrote every discount of a shop's sales order as an amount
// (sales-order-maker.ts); a line without one gets none. Exported for its unit test
export function challanDiscounts(
  challan: readonly { id: string; orderLineId: string | null; quantity: string }[],
  orderLines: ReadonlyMap<string, { discountType: string; discount: string; unitPrice: string }>,
): Map<string, string> {
  const byOrderLine = new Map<string, { id: string; quantity: string }[]>();
  for (const line of challan) {
    if (line.orderLineId === null) continue;
    byOrderLine.set(line.orderLineId, [...(byOrderLine.get(line.orderLineId) ?? []), line]);
  }
  const shares = new Map<string, string>();
  for (const [orderLineId, lines] of byOrderLine) {
    const orderLine = orderLines.get(orderLineId);
    if (orderLine?.discountType !== 'amount' || compareMoney(orderLine.discount, '0') === 0) {
      continue;
    }
    const pieces = spreadMoney(
      orderLine.discount,
      lines.map((line) => multiplyMoney(line.quantity, orderLine.unitPrice)),
    );
    lines.forEach((line, index) => shares.set(line.id, pieces[index] ?? '0'));
  }
  return shares;
}
```

27b's code, moved, not rewritten: `move()` (now `moveOrder()`), the locks and the helpers, `ship()` and `deliver()`
as they were, and `challanDiscounts()` with them. What changed:

- **`updatedBy: currentActorId()`** (mine 31): the member, or null for the courier's news.
- **`lockOrder()` has no version.** The buttons check the version first (`StorefrontOrdersService.lock()` below); the
  courier's news has none to check. Both lock the order before the parcel, so they take turns.
- **`ship()` and `deliver()` check the status themselves,** as each did before, so the news cannot ship an order that
  is not packed.

```diff
@@ -2,7 +2,7 @@ import { documentTotals, lineAmounts, sumMoney } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import { lineDiscounts } from './sales-order-maker.js';
-import { challanDiscounts } from './storefront-orders.service.js';
+import { challanDiscounts } from './order-moves.js';
 
 // Step 27c: a coupon's discount on the ERP's documents (decision 4)
 describe('lineDiscounts (sales order)', () => {
```

```diff
@@ -40,7 +40,7 @@ import { z } from 'zod';
 import { audit, created, diff } from '../common/audit/audit.js';
 import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
 import { decodeCursor, toPage } from '../common/pagination/cursor.js';
-import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
+import { currentActorId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
 import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
 import { WITH_TENANT } from '../infra/tokens.js';
 import {
@@ -254,8 +254,10 @@ export class InvoicesService {
       .values({
         tenantId: getTenantId(),
         ...fields.header,
-        createdBy: currentPrincipal().userId,
-        updatedBy: currentPrincipal().userId,
+        // Step 28a: currentActorId(), because a shop order's Delivered can come from the courier's
+        // news (no member; null, as the worker's own documents, 27b's decision 20)
+        createdBy: currentActorId(),
+        updatedBy: currentActorId(),
       })
       .returning();
     if (!row) throw new Error('Invoice insert returned no row');
@@ -778,9 +780,9 @@ export class InvoicesService {
         status: 'posted',
         number,
         postedAt: new Date(),
-        postedBy: currentPrincipal().userId,
+        postedBy: currentActorId(),
         version: sql`${invoices.version} + 1`,
-        updatedBy: currentPrincipal().userId,
+        updatedBy: currentActorId(),
       })
       .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, draft.id)));
     await audit(tx, {
```

The invoice's save and post read `currentActorId()` (mine 31). A member's invoice is unchanged: the member is the
actor. Everything else the post calls already took the actor this way (the journal, the receipts of 27d).

### The parcels

```ts
import {
  COURIER_EXPORT_MAX_ROWS,
  type CourierExport,
  isErrorCode,
  isOpenShipment,
  OPEN_SHIPMENT_STATUSES,
  type ShopShipmentStatus,
  type StorefrontShipment,
} from '@omnivo/contracts';
import {
  courierAccounts,
  storefrontOrders,
  storefrontPayments,
  storefrontShipmentEvents,
  storefrontShipments,
} from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { audit, created } from '../../common/audit/audit.js';
import { isUniqueViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound } from '../../common/http/app-error.js';
import { emit } from '../../common/outbox/outbox.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { eventKeyOf } from '../../shipping/courier.js';
import { codAmountOf, type OrderRow } from '../orders/order-view.js';

// Step 28a: a shop order's parcels (decisions 2 to 5, 17, 20 and 21), as the order routes use
// them. Plain functions over the caller's transaction: every one runs inside a move of the order,
// after StorefrontOrdersService has locked the order (FOR UPDATE), so two moves of one order take
// turns, and the parcel's change and the order's commit or roll back together. The worker's half
// (calling the courier) is booking.handler.ts; the courier's news is shipment-news.ts.

type ParcelRow = typeof storefrontShipments.$inferSelect;

// A parcel's invoice (28a.2's mine 25): the order number for the first, then "W-000123-2". 0078's
// trigger checks the same rule, so a mistake here is a 500, never a parcel the courier cannot match
export function invoiceOf(orderNo: string, parcelNo: number): string {
  return parcelNo === 1 ? orderNo : `${orderNo}-${String(parcelNo)}`;
}

function notBookable(): AppError {
  return new AppError(
    409,
    'storefront_order_not_bookable',
    'Only a packed order goes to a courier. Mark it packed first.',
  );
}

function hasParcel(): AppError {
  return new AppError(
    409,
    'storefront_order_has_parcel',
    'This order has a parcel on its way already. Reload the page.',
  );
}

// What the rider collects for this order now: the total less what its paid tries took (decision
// 20). Read here, in the order's transaction, so a payment that lands meanwhile is counted
export async function codAmountFor(tx: Transaction, order: OrderRow): Promise<string> {
  const paid = await tx
    .select({ amount: storefrontPayments.amount })
    .from(storefrontPayments)
    .where(
      and(
        eq(storefrontPayments.tenantId, getTenantId()),
        eq(storefrontPayments.orderId, order.id),
        eq(storefrontPayments.status, 'paid'),
      ),
    );
  return codAmountOf(
    order.total,
    paid.map((row) => row.amount),
  );
}

async function parcelsOf(tx: Transaction, orderId: string, lock: boolean): Promise<ParcelRow[]> {
  const query = tx
    .select()
    .from(storefrontShipments)
    .where(
      and(
        eq(storefrontShipments.tenantId, getTenantId()),
        eq(storefrontShipments.orderId, orderId),
      ),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  return lock ? query.for('update') : query;
}

// One step a member took for a parcel (a manual parcel's booking, a cancel): the same row the
// courier's news writes, so the order page and the tracking page draw it the same way
async function memberEvent(
  tx: Transaction,
  shipmentId: string,
  status: ShopShipmentStatus,
  at: Date,
): Promise<void> {
  await tx
    .insert(storefrontShipmentEvents)
    .values({
      tenantId: getTenantId(),
      shipmentId,
      status,
      note: null,
      occurredAt: at,
      source: 'member',
      eventKey: eventKeyOf('member', status, at, null),
    })
    .onConflictDoNothing();
}

// Packed with a courier, or "Book courier" later (decision 2). The order must be packed and have
// no parcel on its way. An API account's parcel starts in `booking` and the worker books it
// (emit, in this transaction: a Packed that rolls back books nothing); a manual account's parcel
// is booked at once with the code the member typed from the courier's panel
export async function startShipment(
  tx: Transaction,
  order: OrderRow,
  input: { accountId: string; trackingCode: string },
): Promise<void> {
  if (order.status !== 'packed' || order.orderNo === null) throw notBookable();
  const tenantId = getTenantId();
  // FOR SHARE: an archive of this account waits until the parcel is made, so a parcel never
  // starts with an account archived a moment before
  const [account] = await tx
    .select()
    .from(courierAccounts)
    .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.id, input.accountId)))
    .for('share');
  if (account === undefined) throw notFound('Courier account');
  if (account.archivedAt !== null) {
    throw new AppError(409, 'courier_account_archived', 'This courier account is archived.', {
      fieldErrors: { accountId: ['courier_account_archived'] },
    });
  }
  const manual = account.provider === 'manual';
  if (manual && input.trackingCode === '') {
    throw new AppError(422, 'courier_tracking_code_required', 'Type the courier’s tracking code.', {
      fieldErrors: { trackingCode: ['courier_tracking_code_required'] },
    });
  }
  const parcels = await parcelsOf(tx, order.id, false);
  if (parcels.some((parcel) => isOpenShipment(parcel.status))) throw hasParcel();
  // A sixth has no number (28a.2's parcel check): five tries of one order is a case for a person
  if (parcels.length >= 5) throw notBookable();
  const parcelNo = parcels.length + 1;
  const now = new Date();
  let row: ParcelRow | undefined;
  try {
    [row] = await tx
      .insert(storefrontShipments)
      .values({
        tenantId,
        orderId: order.id,
        courierAccountId: account.id,
        parcelNo,
        invoice: invoiceOf(order.orderNo, parcelNo),
        courier: account.courier,
        codAmount: await codAmountFor(tx, order),
        // Only the order routes reach this, so there is always a member
        createdBy: currentPrincipal().userId,
        ...(manual
          ? { status: 'booked' as const, trackingCode: input.trackingCode, bookedAt: now }
          : { status: 'booking' as const }),
      })
      .returning();
  } catch (error) {
    // Two Packed or Book courier at the same moment: the second waits for the first's commit and
    // fails on one of these (28a.2's race check). The same answer as the check above
    if (
      isUniqueViolation(error, 'storefront_shipments_open_idx') ||
      isUniqueViolation(error, 'storefront_shipments_parcel_key')
    ) {
      throw hasParcel();
    }
    throw error;
  }
  if (row === undefined) throw new Error('Parcel insert returned no row');
  if (manual) await memberEvent(tx, row.id, 'booked', now);
  else await emit(tx, 'storefront.shipment_requested', { shipmentId: row.id });
  await audit(tx, {
    action: 'storefront_order.shipment_booked',
    entityType: 'storefront_order',
    entityId: order.id,
    changes: created({
      order: order.orderNo,
      courier: account.name,
      ...(manual ? { trackingCode: input.trackingCode } : {}),
    }),
  });
}

// "Book again" (decision 4): the same row, so the courier is asked with the same invoice (decision
// 3). Only the order's last parcel, only after it failed, and only while nothing else is on its
// way. The last error stays on the row while it books again: the page says what went wrong last
// time (28a.2's status check allows it)
export async function retryShipment(
  tx: Transaction,
  order: OrderRow,
  shipmentId: string,
): Promise<void> {
  if (order.status !== 'packed') throw notBookable();
  const parcels = await parcelsOf(tx, order.id, true);
  const parcel = parcels.find((row) => row.id === shipmentId);
  if (parcel === undefined) throw notFound('Parcel');
  if (parcel.status !== 'booking_failed') {
    throw new AppError(
      409,
      'storefront_shipment_not_failed',
      'This parcel did not fail. Reload the page.',
    );
  }
  if (parcels.some((row) => row.parcelNo > parcel.parcelNo || isOpenShipment(row.status))) {
    throw hasParcel();
  }
  const [account] = await tx
    .select({ name: courierAccounts.name, archivedAt: courierAccounts.archivedAt })
    .from(courierAccounts)
    .where(
      and(
        eq(courierAccounts.tenantId, getTenantId()),
        eq(courierAccounts.id, parcel.courierAccountId),
      ),
    )
    .for('share');
  if (account?.archivedAt !== null) {
    throw new AppError(
      409,
      'courier_account_archived',
      'This parcel’s courier account is archived. Restore it, or book with another account.',
    );
  }
  await tx
    .update(storefrontShipments)
    .set({ status: 'booking', updatedAt: new Date() })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, parcel.id)),
    );
  await emit(tx, 'storefront.shipment_requested', { shipmentId: parcel.id });
  await audit(tx, {
    action: 'storefront_order.shipment_retried',
    entityType: 'storefront_order',
    entityId: order.id,
    changes: created({ order: order.orderNo, courier: account.name, invoice: parcel.invoice }),
  });
}

// Cancel (decision 21): a parcel only booked is cancelled with the order, and a failed one stays as
// it was (it is not on its way). Refused while the worker is still booking (it might reach the
// courier after the cancel) and once the courier has the parcel (that is a return, step 28b).
// Steadfast has no cancel call, so the order page says to cancel it on the courier's panel too
export async function cancelShipments(tx: Transaction, order: OrderRow): Promise<void> {
  const parcels = await parcelsOf(tx, order.id, true);
  const open = parcels.find((parcel) => isOpenShipment(parcel.status));
  if (open === undefined) return;
  if (open.status === 'booking') {
    throw new AppError(
      409,
      'storefront_order_parcel_booking',
      'The parcel is being booked. Cancel once it is booked or its booking failed.',
    );
  }
  if (open.status !== 'booked') {
    throw new AppError(
      409,
      'storefront_order_parcel_on_its_way',
      'The courier has the parcel now, so the order cannot be cancelled.',
    );
  }
  const now = new Date();
  await tx
    .update(storefrontShipments)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, open.id)),
    );
  await memberEvent(tx, open.id, 'cancelled', now);
}

// Mark shipped and Mark delivered on an order whose parcel was booked by hand (decision 5: a
// manual parcel keeps the buttons): the parcel follows, so the tracking page shows the step too.
// An API parcel is moved by its courier only; the buttons still move its order (a courier whose
// news stopped), and the courier's later news adds its own steps
export async function followOrder(
  tx: Transaction,
  orderId: string,
  status: 'picked_up' | 'delivered',
): Promise<void> {
  const [open] = await tx
    .select({ id: storefrontShipments.id })
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
        eq(courierAccounts.provider, 'manual'),
        inArray(storefrontShipments.status, [...OPEN_SHIPMENT_STATUSES]),
      ),
    )
    .for('update', { of: storefrontShipments });
  if (open === undefined) return;
  const now = new Date();
  await tx
    .update(storefrontShipments)
    .set({ status, updatedAt: now })
    .where(
      and(eq(storefrontShipments.tenantId, getTenantId()), eq(storefrontShipments.id, open.id)),
    );
  await memberEvent(tx, open.id, status, now);
}

// The order page's parcels, oldest first, each with its steps oldest first (a notice we could not
// read is left out: it has no status). Stored error codes are read like the order's documentError:
// one this API no longer knows reads as none
export async function shipmentsOf(tx: Transaction, orderId: string): Promise<StorefrontShipment[]> {
  const tenantId = getTenantId();
  const rows = await tx
    .select({
      parcel: storefrontShipments,
      accountName: courierAccounts.name,
      provider: courierAccounts.provider,
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
      and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  if (rows.length === 0) return [];
  const events = await tx
    .select({
      shipmentId: storefrontShipmentEvents.shipmentId,
      status: storefrontShipmentEvents.status,
      note: storefrontShipmentEvents.note,
      at: storefrontShipmentEvents.occurredAt,
    })
    .from(storefrontShipmentEvents)
    .where(
      and(
        eq(storefrontShipmentEvents.tenantId, tenantId),
        inArray(
          storefrontShipmentEvents.shipmentId,
          rows.map((row) => row.parcel.id),
        ),
        isNotNull(storefrontShipmentEvents.status),
      ),
    )
    .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
  return rows.map(({ parcel, accountName, provider }) => ({
    id: parcel.id,
    account: { id: parcel.courierAccountId, name: accountName, provider },
    courier: parcel.courier,
    status: parcel.status,
    consignmentId: parcel.consignmentId,
    trackingCode: parcel.trackingCode,
    codAmount: parcel.codAmount,
    bookedAt: parcel.bookedAt?.toISOString() ?? null,
    attempts: parcel.attempts,
    error: parcel.error !== null && isErrorCode(parcel.error) ? parcel.error : null,
    errorDetail: parcel.errorDetail,
    // The contract's 100 (the tracking page's too): the newest are the ones that matter
    events: events
      .filter((event) => event.shipmentId === parcel.id)
      .flatMap((event) =>
        event.status === null
          ? []
          : [{ status: event.status, at: event.at.toISOString(), note: event.note }],
      )
      .slice(-100),
    lastSyncedAt: parcel.lastSyncedAt?.toISOString() ?? null,
  }));
}

// The list's "Needs attention" (28a.1): a packed order whose last parcel failed to book. A
// correlated EXISTS over the order's few parcels (storefront_shipments_parcel_key finds them).
// storefront_orders is written out, as 27b's itemCount does: in a select's fields Drizzle writes a
// column without its table, and an unqualified "tenant_id" in the subquery would be its own row's
export const parcelNeedsAttention = sql<boolean>`(storefront_orders.status = 'packed' AND EXISTS (
  SELECT 1 FROM storefront_shipments s
  WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
    AND s.status = 'booking_failed'
    AND NOT EXISTS (
      SELECT 1 FROM storefront_shipments t
      WHERE t.tenant_id = s.tenant_id AND t.order_id = s.order_id AND t.parcel_no > s.parcel_no
    )
))`;

// The export for a courier's bulk upload (decision 19): the packed orders with no parcel on its
// way, oldest packed first, at most COURIER_EXPORT_MAX_ROWS. The invoice is the one the order's
// next parcel gets, so the code typed back into "Book courier" matches what the courier's panel
// was given
export async function courierExportRows(tx: Transaction): Promise<CourierExport> {
  const tenantId = getTenantId();
  const orders = await tx
    .select({
      order: storefrontOrders,
      // storefront_orders written out, for parcelNeedsAttention's reason
      parcels: sql<number>`(SELECT count(*)::int FROM storefront_shipments s
        WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id)`,
      items: sql<number>`(SELECT coalesce(sum(l.quantity), 0)::int FROM storefront_order_lines l
        WHERE l.tenant_id = storefront_orders.tenant_id AND l.order_id = storefront_orders.id)`,
    })
    .from(storefrontOrders)
    .where(
      and(
        eq(storefrontOrders.tenantId, tenantId),
        eq(storefrontOrders.status, 'packed'),
        sql`NOT EXISTS (SELECT 1 FROM storefront_shipments s
          WHERE s.tenant_id = storefront_orders.tenant_id AND s.order_id = storefront_orders.id
            AND s.status IN (${sql.join(
              OPEN_SHIPMENT_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )}))`,
      ),
    )
    .orderBy(asc(storefrontOrders.packedAt), asc(storefrontOrders.id))
    .limit(COURIER_EXPORT_MAX_ROWS + 1);
  const page = orders.slice(0, COURIER_EXPORT_MAX_ROWS);
  const paid =
    page.length === 0
      ? []
      : await tx
          .select({ orderId: storefrontPayments.orderId, amount: storefrontPayments.amount })
          .from(storefrontPayments)
          .where(
            and(
              eq(storefrontPayments.tenantId, tenantId),
              inArray(
                storefrontPayments.orderId,
                page.map((row) => row.order.id),
              ),
              eq(storefrontPayments.status, 'paid'),
            ),
          );
  return {
    rows: page.flatMap(({ order, parcels, items }) =>
      // A packed order always has its number; one without is a broken row, left out
      order.orderNo === null || parcels >= 5
        ? []
        : [
            {
              orderId: order.id,
              invoice: invoiceOf(order.orderNo, parcels + 1),
              name: order.customerName,
              // On one line: a CSV cell with line breaks is read wrong by some courier panels
              address: order.address.replace(/\s+/g, ' ').trim(),
              phone: order.phone,
              amount: codAmountOf(
                order.total,
                paid.filter((row) => row.orderId === order.id).map((row) => row.amount),
              ),
              itemCount: Math.max(items, 1),
            },
          ],
    ),
    more: orders.length > COURIER_EXPORT_MAX_ROWS,
  };
}
```

- **Plain functions over the caller's transaction.** Every one runs inside a move of the order, after
  `StorefrontOrdersService` has locked it, so the parcel's change and the order's commit or roll back together.
- **`invoiceOf()`** is 28a.2's rule (mine 25); 0078's trigger checks the same rule, so a mistake here is a 500,
  never a parcel the courier cannot match.
- **`codAmountFor()`** reads the paid tries in the order's transaction: a payment that lands meanwhile is counted.
- **`startShipment()`:** the account is read `FOR SHARE`, so an archive of it waits until the parcel is made. A
  manual account needs the code; an API account ignores it (28a.1). An order with a parcel on its way is refused
  before the insert, and a sixth parcel too (it has no number). Two bookings at the same moment wait for each
  other and the second fails on the open index (28a.2's race), with the same answer. The outbox event is written
  in this transaction (mine 28).
- **`retryShipment()`:** only the order's last parcel, only after it failed, and only while nothing else is on its
  way. The last error stays while it books again (28a.2's status check allows it), so the page says what went wrong.
- **`cancelShipments()`** (decision 21, mine 30): `booking` refuses, `booked` is cancelled with a member's step, and
  anything past `booked` refuses (that is a return). Steadfast has no cancel call; the order page says to cancel it
  on the courier's panel too (28a.6).
- **`followOrder()`** (mine 35) moves a manual parcel with the buttons. `FOR UPDATE OF storefront_shipments` locks the
  parcel only, not the account row of the join.
- **`shipmentsOf()`** leaves out a notice we could not read (it has no status) and keeps the newest 100 steps (the
  contract's limit). An error code this API no longer knows reads as none, like the order's `documentError`.
- **`parcelNeedsAttention`** writes `storefront_orders` out by name, as 27b's `itemCount` does: in a select's
  fields Drizzle writes a column without its table, and an unqualified `tenant_id` inside the subquery would be the
  subquery's own row. (The first version did that, and the list never showed "Needs attention".)
- **`courierExportRows()`** gives each order the invoice its next parcel will get, so the code typed back into Book
  courier matches what the courier's panel was given. The address goes on one line: some panels read a CSV cell
  with line breaks wrong.

```diff
@@ -1,9 +1,13 @@
 import {
+  compareMoney,
   SHOP_ORDER_STATUSES,
   storefrontImageSchema,
   type ShopOrder,
   type ShopOrderStatus,
+  type ShopShipment,
   type ShopTracking,
+  subtractMoney,
+  sumMoney,
 } from '@omnivo/contracts';
 import type { storefrontOrderLines, storefrontOrders } from '@omnivo/db';
 
@@ -84,10 +88,23 @@ export function orderOf(
   };
 }
 
+// Step 28a (decision 20): what the rider collects, the total less what the paid tries took, to the
+// paisa and never below zero: a shopper who paid twice owes nothing at the door (the second
+// payment is a refund, 27d). Four decimals, like every amount the API answers ("578.0000");
+// "0.0000" for an order paid online
+export function codAmountOf(total: string, paid: readonly string[]): string {
+  const left = subtractMoney(total, sumMoney(paid));
+  return compareMoney(left, '0') > 0 ? left : '0.0000';
+}
+
 // What a tracking link and the /track form show (26e's shopTrackingSchema): no name, phone,
 // address or line, because the link gets forwarded. Each field picked by name, never `...order`.
-// No parcel yet: couriers come in step 28
-export function trackingOf(order: OrderRow, lines: readonly OrderLineRow[]): ShopTracking {
+// Step 28a: and its parcels, read by the caller (shop-orders.service.ts, as omnivo_shop)
+export function trackingOf(
+  order: OrderRow,
+  lines: readonly OrderLineRow[],
+  shipments: readonly ShopShipment[],
+): ShopTracking {
   return {
     orderNo: numberOf(order),
     placedAt: order.createdAt.toISOString(),
@@ -97,6 +114,6 @@ export function trackingOf(order: OrderRow, lines: readonly OrderLineRow[]): Sho
     itemCount: lines.reduce((count, line) => count + line.quantity, 0),
     total: order.total,
     paymentMethod: order.paymentMethod,
-    shipments: [],
+    shipments: [...shipments],
   };
 }
```

- **`codAmountOf()`** (decision 20) never goes below zero: a shopper who paid twice owes nothing at the door, and the
  second payment is a refund (27d). Four decimals, like every amount the API answers.
- **`trackingOf()` takes the parcels** the caller read, as the shop's role (below).

```diff
@@ -1,7 +1,14 @@
 import { shopOrderSchema, shopTrackingSchema } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
-import { historyOf, type OrderLineRow, orderOf, type OrderRow, trackingOf } from './order-view.js';
+import {
+  codAmountOf,
+  historyOf,
+  type OrderLineRow,
+  orderOf,
+  type OrderRow,
+  trackingOf,
+} from './order-view.js';
 
 const TENANT = '0193a000-0000-7000-8000-000000000001';
 const ORDER = '0193a000-0000-7000-8000-000000000002';
@@ -107,7 +114,7 @@ describe('order view', () => {
   });
 
   it('gives a tracking link no name, phone, address or line', () => {
-    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES));
+    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES, []));
     expect(answer).toEqual({
       orderNo: 'W-000123',
       placedAt: PLACED.toISOString(),
@@ -121,6 +128,28 @@ describe('order view', () => {
   });
 
   it('refuses to show an order without a number', () => {
-    expect(() => trackingOf(order({ orderNo: null }), LINES)).toThrow(/no number/);
+    expect(() => trackingOf(order({ orderNo: null }), LINES, [])).toThrow(/no number/);
+  });
+
+  // Step 28a: the parcels the caller read, as they came
+  it('gives a tracking link its parcels', () => {
+    const parcel = {
+      courier: 'steadfast' as const,
+      trackingCode: 'SFR2611230042',
+      trackingUrl: 'https://steadfast.com.bd/t/SFR2611230042',
+      events: [{ status: 'booked' as const, at: PLACED.toISOString(), note: null }],
+    };
+    const answer = shopTrackingSchema.parse(trackingOf(order(), LINES, [parcel]));
+    expect(answer.shipments).toEqual([parcel]);
+  });
+});
+
+describe('what the rider collects (step 28a.3)', () => {
+  it('is the total less what was paid, never below zero', () => {
+    expect(codAmountOf('578.0000', [])).toBe('578.0000');
+    expect(codAmountOf('578.0000', ['578.0000'])).toBe('0.0000');
+    // Paid twice (a second tab): nothing at the door, the second payment is a refund
+    expect(codAmountOf('578.0000', ['578.0000', '578.0000'])).toBe('0.0000');
+    expect(codAmountOf('578.5000', ['100.0000'])).toBe('478.5000');
   });
 });
```

### The orders service

```diff
@@ -1,11 +1,11 @@
 import { Inject, Injectable } from '@nestjs/common';
 import {
-  compareMoney,
+  type BookShipmentInput,
   compareQuantity,
+  type CourierExport,
   type DocumentRef,
   type ErrorCode,
   isErrorCode,
-  multiplyMoney,
   type PackStorefrontOrderInput,
   type StorefrontOrder,
   type StorefrontOrderCounts,
@@ -17,10 +17,8 @@ import {
   type StorefrontOrderSummary,
   type StorefrontPackPlan,
   storefrontImageSchema,
-  spreadMoney,
   sumQuantity,
   subtractQuantity,
-  todayIn,
 } from '@omnivo/contracts';
 import {
   batches,
@@ -31,24 +29,22 @@ import {
   products,
   productVariants,
   receipts,
-  salesOrderLines,
   salesOrders,
   salesReturns,
   stockBalances,
+  courierAccounts,
   storefrontImages,
   storefrontOrderLines,
   storefrontOrders,
   storefrontPayments,
   storefrontSettings,
   storefrontStockHolds,
-  tenantSettings,
   units,
   warehouses,
 } from '@omnivo/db';
 import { and, asc, eq, gt, inArray, ne, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
-import { audit, diff } from '../../common/audit/audit.js';
 import { containsPattern } from '../../common/db/search.js';
 import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
 import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
@@ -57,14 +53,32 @@ import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js
 import type { Config } from '../../config.js';
 import { CONFIG, WITH_TENANT } from '../../infra/tokens.js';
 import { DeliveriesService } from '../../sales/deliveries.service.js';
-import { InvoicesService } from '../../sales/invoices.service.js';
 import { SalesOrdersService } from '../../sales/sales-orders.service.js';
 import { SalesReturnsService } from '../../sales/sales-returns.service.js';
 import { cancelledSms } from '../../sms/shop-sms.js';
 import { SmsQueue } from '../../sms/sms-queue.js';
 import { isoText } from '../listing-sql.js';
 import { shopImage } from '../media.js';
-import { historyOf, type OrderLineRow, type OrderRow } from './order-view.js';
+import {
+  lockOrder,
+  moveOrder,
+  orderLinesOf,
+  salesOrderLinesOf,
+  salesOrderOf,
+  ShopOrderMoves,
+  shopToday,
+  stepInvalid,
+} from './order-moves.js';
+import { codAmountOf, historyOf, type OrderRow } from './order-view.js';
+import {
+  cancelShipments,
+  courierExportRows,
+  followOrder,
+  parcelNeedsAttention,
+  retryShipment,
+  shipmentsOf,
+  startShipment,
+} from '../shipping/shipments.js';
 import { ShopPaymentReceipts } from './payment-receipts.js';
 import { ShopSalesOrderMaker } from './sales-order-maker.js';
 
@@ -118,14 +132,6 @@ function invalidCursor(): AppError {
   return new AppError(400, 'invalid_cursor', 'The cursor is not valid for this list.');
 }
 
-function stepInvalid(): AppError {
-  return new AppError(
-    409,
-    'storefront_order_step_invalid',
-    'This order has moved on since it was loaded. Reload it.',
-  );
-}
-
 // The statuses the ERP shows (decision 13). The routes never read a pending order (their WHERE
 // says status <> 'pending'), so one here is a bug, and a loud one
 function erpStatus(order: OrderRow): StorefrontOrderStatus {
@@ -144,7 +150,13 @@ function numberOf(order: OrderRow): string {
   return order.orderNo;
 }
 
-function summaryOf(order: OrderRow, items: number): StorefrontOrderSummary {
+// Step 28a: parcelAttention is the parcel's half of "Needs attention" (its last booking failed),
+// worked out by the caller: in SQL for the list, from the parcels for the order page
+function summaryOf(
+  order: OrderRow,
+  items: number,
+  parcelAttention: boolean,
+): StorefrontOrderSummary {
   return {
     id: order.id,
     orderNo: numberOf(order),
@@ -157,7 +169,7 @@ function summaryOf(order: OrderRow, items: number): StorefrontOrderSummary {
     paymentMethod: order.paymentMethod,
     itemCount: items,
     total: order.total,
-    needsAttention: order.documentError !== null,
+    needsAttention: order.documentError !== null || parcelAttention,
   };
 }
 
@@ -207,10 +219,10 @@ export class StorefrontOrdersService {
     private readonly maker: ShopSalesOrderMaker,
     private readonly salesOrders: SalesOrdersService,
     private readonly deliveries: DeliveriesService,
-    private readonly invoices: InvoicesService,
     private readonly salesReturns: SalesReturnsService,
     private readonly sms: SmsQueue,
     private readonly paymentReceipts: ShopPaymentReceipts,
+    private readonly moves: ShopOrderMoves,
   ) {
     this.mediaUrl = config.storefront.mediaUrl;
   }
@@ -240,14 +252,19 @@ export class StorefrontOrdersService {
       }
       const direction = sort.desc ? sql`DESC` : sql`ASC`;
       const rows = await tx
-        .select({ order: storefrontOrders, items: itemCount, sortKey: sort.text })
+        .select({
+          order: storefrontOrders,
+          items: itemCount,
+          sortKey: sort.text,
+          parcelAttention: parcelNeedsAttention,
+        })
         .from(storefrontOrders)
         .where(and(...filters))
         .orderBy(sql`${sort.key} ${direction}`, sql`${storefrontOrders.id} ${direction}`)
         .limit(q.limit + 1);
       const page = toPage(rows, q.limit, (last) => [q.sort, last.sortKey, last.order.id]);
       return {
-        items: page.items.map((row) => summaryOf(row.order, row.items)),
+        items: page.items.map((row) => summaryOf(row.order, row.items, row.parcelAttention)),
         nextCursor: page.nextCursor,
       };
     });
@@ -346,7 +363,7 @@ export class StorefrontOrdersService {
     return this.withTenant(async (tx) => {
       const order = await this.find(tx, id);
       if (order.status !== 'confirmed') throw stepInvalid();
-      const salesOrder = await this.salesOrderOf(tx, order);
+      const salesOrder = await salesOrderOf(tx, order);
       const [warehouse] = await tx
         .select({ id: warehouses.id, name: warehouses.name })
         .from(warehouses)
@@ -392,9 +409,11 @@ export class StorefrontOrdersService {
     return this.withTenant(async (tx) => {
       const order = await this.lock(tx, id, input.version);
       if (order.status !== 'confirmed') throw stepInvalid();
-      const salesOrder = await this.salesOrderOf(tx, order);
-      const orderLines = await this.orderLinesOf(tx, id);
-      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);
+      // Step 28a: the courier first, so a wrong pick is refused before any stock moves
+      if (input.courierAccountId !== null) await this.bookableAtPack(tx, input.courierAccountId);
+      const salesOrder = await salesOrderOf(tx, order);
+      const orderLines = await orderLinesOf(tx, id);
+      const soLines = await salesOrderLinesOf(tx, salesOrder.id);
 
       // Every line of the order once, and only its lines (the contract refused a line twice).
       // The picks of a line add up to what the shopper ordered: the challan would take whatever
@@ -455,7 +474,7 @@ export class StorefrontOrdersService {
         deliveryId = await this.deliveries.postForShopOrder(tx, {
           customerId: salesOrder.customerId,
           orderId: salesOrder.id,
-          date: await this.today(tx),
+          date: await shopToday(tx),
           warehouseId: salesOrder.warehouseId,
           shippingAddress: salesOrder.shippingAddress,
           note: null,
@@ -467,104 +486,59 @@ export class StorefrontOrdersService {
           challanLines.map((entry) => entry.at),
         );
       }
-      await this.move(tx, order, { status: 'packed', packedAt: new Date(), deliveryId });
+      await moveOrder(tx, order, { status: 'packed', packedAt: new Date(), deliveryId });
+      // Step 28a (decision 2): the parcel in the same transaction as the challan. The worker books
+      // it once this commits; a Packed that rolls back books nothing
+      if (input.courierAccountId !== null) {
+        await startShipment(tx, await lockOrder(tx, id), {
+          accountId: input.courierAccountId,
+          trackingCode: '',
+        });
+      }
+      return this.read(tx, id);
+    });
+  }
+
+  // Step 28a: "Book courier" on a packed order (decision 2), with an API or a manual account
+  bookShipment(id: string, input: BookShipmentInput): Promise<StorefrontOrder> {
+    return this.withTenant(async (tx) => {
+      const order = await this.lock(tx, id, input.version);
+      await startShipment(tx, order, input);
+      return this.read(tx, id);
+    });
+  }
+
+  // Step 28a: "Book again" after five failed tries (decision 4)
+  retryShipment(id: string, shipmentId: string, version: number): Promise<StorefrontOrder> {
+    return this.withTenant(async (tx) => {
+      const order = await this.lock(tx, id, version);
+      await retryShipment(tx, order, shipmentId);
       return this.read(tx, id);
     });
   }
 
-  // Decision 6: a status only. The courier comes in step 28
+  // Step 28a (decision 19): the rows for a courier's bulk upload
+  courierExport(): Promise<CourierExport> {
+    return this.withTenant((tx) => courierExportRows(tx));
+  }
+
+  // Decision 6: a status only (the moves are in order-moves.ts since 28a)
   ship(id: string, version: number): Promise<StorefrontOrder> {
     return this.withTenant(async (tx) => {
       const order = await this.lock(tx, id, version);
-      if (order.status !== 'packed') throw stepInvalid();
-      await this.move(tx, order, { status: 'shipped', shippedAt: new Date() });
+      await this.moves.ship(tx, order);
+      // Step 28a: a parcel booked by hand follows the button (decision 5)
+      await followOrder(tx, id, 'picked_up');
       return this.read(tx, id);
     });
   }
 
-  // Decision 7: a posted invoice for what the challan took and the delivery charge, dated today
-  // (decision 21) and unpaid: the cash the rider brings back is a money receipt
+  // Decision 7: the invoice (order-moves.ts)
   deliver(id: string, version: number): Promise<StorefrontOrder> {
     return this.withTenant(async (tx) => {
       const order = await this.lock(tx, id, version);
-      if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
-      const salesOrder = await this.salesOrderOf(tx, order);
-      const orderLines = await this.orderLinesOf(tx, id);
-      const soLines = await this.salesOrderLinesOf(tx, salesOrder.id);
-      const soLineById = new Map(soLines.map((line) => [line.id, line]));
-      const challan = await tx
-        .select()
-        .from(deliveryLines)
-        .where(
-          and(
-            eq(deliveryLines.tenantId, getTenantId()),
-            eq(deliveryLines.deliveryId, order.deliveryId),
-          ),
-        )
-        .orderBy(asc(deliveryLines.lineNo));
-      const [branch] = await tx
-        .select({ id: warehouses.branchId })
-        .from(warehouses)
-        .where(
-          and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
-        );
-      if (!branch) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);
-
-      // Each challan line at its order line's price and VAT rate; then the delivery charge, the
-      // sales order's lines after the order's own (the maker added it last). Step 27c: and with
-      // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
-      // would bill more than the shopper pays
-      const discounts = challanDiscounts(challan, soLineById);
-      const goods = challan.map((line) => {
-        const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
-        if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
-        return {
-          variantId: line.variantId,
-          unitId: line.unitId,
-          quantity: line.quantity,
-          description: soLine.description,
-          unitPrice: soLine.unitPrice,
-          discountType: 'amount' as const,
-          discount: discounts.get(line.id) ?? '0',
-          taxRateId: soLine.taxRateId,
-          deliveryLineId: line.id,
-          orderLineId: null,
-          batchId: null,
-          serialNumbers: [],
-        };
-      });
-      const charges = soLines.slice(orderLines.length).map((soLine) => ({
-        variantId: soLine.variantId,
-        unitId: soLine.unitId,
-        quantity: soLine.quantity,
-        description: soLine.description,
-        unitPrice: soLine.unitPrice,
-        discountType: 'amount' as const,
-        discount: '0',
-        taxRateId: soLine.taxRateId,
-        deliveryLineId: null,
-        orderLineId: soLine.id,
-        batchId: null,
-        serialNumbers: [],
-      }));
-      const invoiceId = await this.invoices.createIn(tx, {
-        customerId: salesOrder.customerId,
-        date: await this.today(tx),
-        note: null,
-        lines: [...goods, ...charges],
-        // The customer's payment terms from today: 0 days for a new shop customer
-        dueDate: null,
-        customerReference: order.orderNo,
-        branchId: branch.id,
-        warehouseId: null,
-        post: true,
-        // Never over the limit: the invoice bills the confirmed order at its own prices, which
-        // moves the amount from "on order" to "owed" and adds nothing (CreditService.check)
-        overrideCreditLimit: false,
-      });
-      // Step 27d (decision 6): a paid online order's advance pays its invoice at once
-      await this.paymentReceipts.applyToInvoice(tx, order.id, invoiceId);
-      await this.move(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
+      await this.moves.deliver(tx, order);
+      await followOrder(tx, id, 'delivered');
       return this.read(tx, id);
     });
   }
@@ -580,6 +554,9 @@ export class StorefrontOrdersService {
     const { order, sms } = await this.withTenant(async (tx) => {
       const before = await this.lock(tx, id, input.version);
       if (before.status !== 'confirmed' && before.status !== 'packed') throw stepInvalid();
+      // Step 28a (decision 21): a parcel only booked is cancelled with the order; one booking or
+      // with the courier refuses the cancel
+      await cancelShipments(tx, before);
       let salesReturnId: string | null = null;
       if (before.status === 'packed') {
         salesReturnId = await this.returnChallan(tx, before);
@@ -596,7 +573,7 @@ export class StorefrontOrdersService {
       if (before.salesOrderId !== null) {
         await this.salesOrders.cancelIn(tx, before.salesOrderId, null);
       }
-      await this.move(tx, before, {
+      await moveOrder(tx, before, {
         status: 'cancelled',
         cancelledAt: new Date(),
         cancelReason: input.reason,
@@ -647,7 +624,7 @@ export class StorefrontOrdersService {
       .orderBy(asc(deliveryLines.lineNo));
     return this.salesReturns.createIn(tx, {
       customerId: challan.customerId,
-      date: await this.today(tx),
+      date: await shopToday(tx),
       warehouseId: challan.warehouseId,
       // The return's own list of reasons has no "order cancelled"; the shop order's page says
       // why, and the return's audit row names the order through its challan
@@ -681,73 +658,26 @@ export class StorefrontOrdersService {
     });
   }
 
-  // The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
-  // reads them together), the version up, and the audit row of the move
-  private async move(
-    tx: Transaction,
-    before: OrderRow,
-    fields: Partial<
-      Pick<
-        OrderRow,
-        | 'status'
-        | 'packedAt'
-        | 'shippedAt'
-        | 'deliveredAt'
-        | 'cancelledAt'
-        | 'cancelReason'
-        | 'deliveryId'
-        | 'invoiceId'
-        | 'salesReturnId'
-      >
-    > & { status: StorefrontOrderStatus },
-  ): Promise<void> {
-    await tx
-      .update(storefrontOrders)
-      .set({
-        ...fields,
-        version: sql`${storefrontOrders.version} + 1`,
-        updatedBy: currentPrincipal().userId,
-      })
-      .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, before.id)));
-    const action = {
-      confirmed: null,
-      packed: 'storefront_order.packed',
-      shipped: 'storefront_order.shipped',
-      delivered: 'storefront_order.delivered',
-      cancelled: 'storefront_order.cancelled',
-      returned: null,
-    } as const satisfies Record<StorefrontOrderStatus, string | null>;
-    const name = action[fields.status];
-    if (name === null) throw new Error(`No audit action for ${fields.status}`);
-    await audit(tx, {
-      action: name,
-      entityType: 'storefront_order',
-      entityId: before.id,
-      changes: diff(
-        { order: before.orderNo, status: before.status },
-        {
-          order: before.orderNo,
-          status: fields.status,
-          ...(fields.cancelReason === undefined ? {} : { reason: fields.cancelReason }),
-        },
-      ),
-    });
+  // Step 28a: Packed books with an active API account only (28a.1's packStorefrontOrderInputSchema):
+  // a manual parcel needs the courier's code, which does not exist before the box is handed over
+  private async bookableAtPack(tx: Transaction, accountId: string): Promise<void> {
+    const [account] = await tx
+      .select({ provider: courierAccounts.provider, archivedAt: courierAccounts.archivedAt })
+      .from(courierAccounts)
+      .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, accountId)));
+    if (account === undefined || account.provider === 'manual' || account.archivedAt !== null) {
+      throw new AppError(
+        422,
+        'courier_account_not_bookable',
+        'Pick an active courier account that books by API, or Don’t book now.',
+        { fieldErrors: { courierAccountId: ['courier_account_not_bookable'] } },
+      );
+    }
   }
 
-  // FOR UPDATE, never a pending order (that one is the shopper's), and the version the page read
+  // FOR UPDATE (order-moves.ts's lockOrder), and the version the page read
   private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
-    const [order] = await tx
-      .select()
-      .from(storefrontOrders)
-      .where(
-        and(
-          eq(storefrontOrders.tenantId, getTenantId()),
-          eq(storefrontOrders.id, id),
-          ne(storefrontOrders.status, 'pending'),
-        ),
-      )
-      .for('update');
-    if (!order) throw notFound('Shop order');
+    const order = await lockOrder(tx, id);
     if (order.version !== version) throw versionConflict();
     return order;
   }
@@ -767,46 +697,6 @@ export class StorefrontOrdersService {
     return order;
   }
 
-  // The order's sales order, which Packed and Delivered build on
-  private async salesOrderOf(tx: Transaction, order: OrderRow) {
-    if (order.salesOrderId === null) {
-      throw new AppError(
-        409,
-        'storefront_order_no_sales_order',
-        'This order has no sales order yet. Make the sales order first.',
-      );
-    }
-    const [row] = await tx
-      .select()
-      .from(salesOrders)
-      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, order.salesOrderId)));
-    if (!row) throw new Error(`Sales order ${order.salesOrderId} is missing`);
-    return row;
-  }
-
-  private orderLinesOf(tx: Transaction, orderId: string): Promise<OrderLineRow[]> {
-    return tx
-      .select()
-      .from(storefrontOrderLines)
-      .where(
-        and(
-          eq(storefrontOrderLines.tenantId, getTenantId()),
-          eq(storefrontOrderLines.orderId, orderId),
-        ),
-      )
-      .orderBy(asc(storefrontOrderLines.position));
-  }
-
-  private salesOrderLinesOf(tx: Transaction, salesOrderId: string) {
-    return tx
-      .select()
-      .from(salesOrderLines)
-      .where(
-        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, salesOrderId)),
-      )
-      .orderBy(asc(salesOrderLines.lineNo));
-  }
-
   // The order's lines with what the ERP knows of each variant now: its SKU, its base unit's code
   // and how its stock is tracked
   private async linesOf(tx: Transaction, orderId: string) {
@@ -877,14 +767,6 @@ export class StorefrontOrdersService {
     return byVariant;
   }
 
-  private async today(tx: Transaction): Promise<string> {
-    const [settings] = await tx
-      .select({ timezone: tenantSettings.timezone })
-      .from(tenantSettings)
-      .where(eq(tenantSettings.tenantId, getTenantId()));
-    return todayIn(settings?.timezone ?? 'Asia/Dhaka');
-  }
-
   // Part of the number ("W-000123", "123"), of the name, or of the phone with its spaces and
   // dashes dropped ("01786 120356"). No index helps here (a LIKE is not leakproof under RLS,
   // 27b.2): the list's index narrows to the workspace and the tab first
@@ -964,10 +846,15 @@ export class StorefrontOrdersService {
       )
       .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.orderId, id)))
       .orderBy(asc(storefrontPayments.tryNo));
+    // Step 28a: the parcels, and what the rider collects (decision 20) from the paid tries read
+    // above
+    const shipments = await shipmentsOf(tx, id);
+    const last = shipments.at(-1);
     return {
       ...summaryOf(
         order,
         lines.reduce((count, { line }) => count + line.quantity, 0),
+        order.status === 'packed' && last?.status === 'booking_failed',
       ),
       address: order.address,
       history: historyOf(order),
@@ -1027,6 +914,13 @@ export class StorefrontOrdersService {
             ? payment.receiptError
             : null,
       })),
+      codAmount: codAmountOf(
+        order.total,
+        payments
+          .filter(({ payment }) => payment.status === 'paid')
+          .map(({ payment }) => payment.amount),
+      ),
+      shipments,
       version: order.version,
       updatedAt: order.updatedAt.toISOString(),
     };
@@ -1050,33 +944,3 @@ function fefo(
   }
   return picks;
 }
-
-// Step 27c: each challan line's share of its sales order line's discount, by challan line id. A
-// line packed from two batches is two challan lines of one order line, so the order line's
-// discount is spread over them by what each is worth at the order's price (spreadMoney: to the
-// paisa, adding up to the discount exactly). One challan line per order line, the usual case,
-// takes the whole discount. The maker wrote every discount of a shop's sales order as an amount
-// (sales-order-maker.ts); a line without one gets none. Exported for its unit test
-export function challanDiscounts(
-  challan: readonly { id: string; orderLineId: string | null; quantity: string }[],
-  orderLines: ReadonlyMap<string, { discountType: string; discount: string; unitPrice: string }>,
-): Map<string, string> {
-  const byOrderLine = new Map<string, { id: string; quantity: string }[]>();
-  for (const line of challan) {
-    if (line.orderLineId === null) continue;
-    byOrderLine.set(line.orderLineId, [...(byOrderLine.get(line.orderLineId) ?? []), line]);
-  }
-  const shares = new Map<string, string>();
-  for (const [orderLineId, lines] of byOrderLine) {
-    const orderLine = orderLines.get(orderLineId);
-    if (orderLine?.discountType !== 'amount' || compareMoney(orderLine.discount, '0') === 0) {
-      continue;
-    }
-    const pieces = spreadMoney(
-      orderLine.discount,
-      lines.map((line) => multiplyMoney(line.quantity, orderLine.unitPrice)),
-    );
-    lines.forEach((line, index) => shares.set(line.id, pieces[index] ?? '0'));
-  }
-  return shares;
-}
```

- **The moved code is gone from here** (`order-moves.ts`); `ship()` and `deliver()` lock with the version and call
  the moves.
- **`summaryOf()` takes the parcel's half of "Needs attention",** worked out in SQL for the list and from the parcels
  for the order page.
- **Packed checks the courier account first** (`bookableAtPack()`), before any stock moves: a manual or archived
  account is a field error on the dialog's select. The parcel is made after the challan, in the same transaction,
  with the order read again (now packed).
- **Cancel asks the parcels first** (`cancelShipments()`): a refusal there leaves the challan and the stock alone.
- **`read()` adds `codAmount` and `shipments`.** The amount is worked out from the payment rows the page already
  read, so it is the same moment's answer.

```diff
@@ -27,6 +27,12 @@ export class StorefrontOrdersController {
     return this.orders.counts();
   }
 
+  // Step 28a: before getOrder, for countOrders' reason
+  @Endpoint(routes.storefrontOrders.courierExport)
+  courierExport(): Promise<RouteResponse<Routes['courierExport']>> {
+    return this.orders.courierExport();
+  }
+
   @Endpoint(routes.storefrontOrders.getOrder)
   getOrder({ params }: RouteInput<Routes['getOrder']>): Promise<RouteResponse<Routes['getOrder']>> {
     return this.orders.get(params.id);
@@ -82,6 +88,23 @@ export class StorefrontOrdersController {
     return this.orders.makePaymentReceipt(params.id, params.paymentId, body.version);
   }
 
+  // Step 28a: "Book courier" and "Book again"
+  @Endpoint(routes.storefrontOrders.bookShipment)
+  bookShipment({
+    params,
+    body,
+  }: RouteInput<Routes['bookShipment']>): Promise<RouteResponse<Routes['bookShipment']>> {
+    return this.orders.bookShipment(params.id, body);
+  }
+
+  @Endpoint(routes.storefrontOrders.retryShipment)
+  retryShipment({
+    params,
+    body,
+  }: RouteInput<Routes['retryShipment']>): Promise<RouteResponse<Routes['retryShipment']>> {
+    return this.orders.retryShipment(params.id, params.shipmentId, body.version);
+  }
+
   @Endpoint(routes.storefrontOrders.cancelOrder)
   cancelOrder({
     params,
```

`courierExport` before `getOrder`, for `countOrders`' reason.

```diff
@@ -256,8 +256,9 @@ export const packStorefrontOrderInputSchema = z
     // Step 28a (decision 2): the courier account to book the parcel with, once the challan is
     // posted. The dialog starts with the default account; '' = "Don't book now" (a shop's own
     // rider, or a booking made later with "Book courier"). Only an active account that books by
-    // API: the API refuses a manual or archived one (courier_account_not_bookable)
-    courierAccountId: optionalIdSchema,
+    // API: the API refuses a manual or archived one (courier_account_not_bookable). Left out is
+    // "Don't book now" too (28a.3): a page loaded before 28a, still open in a tab, packs as before
+    courierAccountId: optionalIdSchema.default(null),
   })
   .superRefine((input, ctx) => {
     // Each line once: two entries for one line would pack it twice
```
```diff
@@ -73,6 +73,11 @@ describe('Packed', () => {
     expect(
       packStorefrontOrderInputSchema.parse({ ...PACK, courierAccountId: courier }).courierAccountId,
     ).toBe(courier);
+    // 28a.3: a body without the field (an older page) does not book either
+    expect(
+      packStorefrontOrderInputSchema.parse({ version: PACK.version, lines: PACK.lines })
+        .courierAccountId,
+    ).toBeNull();
   });
 
   it('takes a line split over two batches, and no batch as null', () => {
```

Mine 36.

### Booking in the worker

```diff
@@ -31,6 +31,9 @@ export const OUTBOX_EVENT_TYPES = [
   // Step 27d: a payment try of a shop order was paid. The worker makes its money receipt (and the
   // gateway's fee) once the order has its sales order (27d.2's mine 26)
   'storefront.payment_paid',
+  // Step 28a: a shop order's parcel waits to be booked with a courier's API (Packed, "Book
+  // courier" or "Book again"). The worker calls the courier, on its own queue (decision 4)
+  'storefront.shipment_requested',
 ] as const;
 export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
 
```
```diff
@@ -61,6 +61,9 @@ export const outboxPayloadSchemas = {
   // Step 27d: one payment try was paid. Its row has the rest (amount, the gateway's numbers); the
   // worker makes the posted money receipt. Never the val_id or the store's account
   'storefront.payment_paid': z.object({ paymentId: z.uuid() }),
+  // Step 28a: one parcel in `booking`. Its row has the rest (the account, the invoice, the amount);
+  // the worker reads the order's name, phone and address when it calls. Never the account's keys
+  'storefront.shipment_requested': z.object({ shipmentId: z.uuid() }),
 } satisfies Record<OutboxEventType, z.ZodObject>;
 
 export type OutboxPayload<T extends OutboxEventType> = z.output<(typeof outboxPayloadSchemas)[T]>;
```

The payload is the parcel's id only: the worker reads the rest when it runs, and the keys never go near the outbox.

```ts
import type { PermissionKey } from '@omnivo/contracts';
import { membershipRoles, memberships, permissions, rolePermissions, roles } from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import { getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';

// Step 28a: the members whose bell a background job rings: the owners, and everyone one of whose
// roles has the permission. The same query OrderConfirmedHandler (27a) and the POS handlers write
// out themselves; new handlers use this one. Distinct users: a member with two such roles hears
// once
export async function membersWhoMay(
  tx: Transaction,
  permission: PermissionKey,
): Promise<{ userId: string }[]> {
  const tenantId = getTenantId();
  return tx
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
        or(eq(roles.kind, 'owner'), eq(permissions.key, permission)),
      ),
    );
}
```

27a's recipients query as one function. The earlier handlers keep their own copy for now; a new handler uses this.

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErrorCode } from '@omnivo/contracts';
import {
  courierAccounts,
  storefrontOrderLines,
  storefrontOrders,
  storefrontShipmentEvents,
  storefrontShipments,
} from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import {
  type EventHandler,
  type OutboxEvent,
  PermanentJobError,
} from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import type { ShippingConfig } from '../../config.js';
import { COURIERS, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { notify } from '../../notifications/notify.js';
import { membersWhoMay } from '../../notifications/recipients.js';
import {
  type CourierAdapter,
  type CourierAdapters,
  type CourierKeys,
  type CourierParcel,
  courierText,
  eventKeyOf,
  isApiProvider,
  type ParcelRequest,
} from '../../shipping/courier.js';
import { openKeys } from './courier-keys.js';

// What one try ended with: booked, or a failure with our code and the courier's sentence. A
// permanent one (the courier said no, or the keys cannot be opened) is not tried again: the next
// try would get the same answer (decision 4)
type Outcome =
  | { kind: 'booked'; parcel: CourierParcel }
  | { kind: 'failed'; error: ErrorCode; detail: string | null; permanent: boolean };

// Everything a try needs, read before the courier is called
interface Booking {
  shipmentId: string;
  orderId: string;
  attemptsBefore: number;
  adapter: CourierAdapter;
  keys: CourierKeys | null;
  request: ParcelRequest;
}

// Step 28a (decisions 3 and 4): the worker's half of a booking, for one parcel in `booking`. On
// the couriers queue (worker/queues.ts), five tries over about 15 minutes. Three transactions and
// no lock held while the courier thinks, as 27d's gateway calls:
// 1. count the try (attempts + 1) and read what the courier is told. Counted first: a worker that
//    dies during the call leaves the count, so the next try knows the courier may have it
// 2. call the courier, outside any transaction. A try after the first asks by the invoice before
//    booking (decision 3), so a lost answer never makes a second parcel
// 3. write the answer: booked, with its first step; or the error, kept on the row while it still
//    books, and thrown so the queue tries again (or, for a permanent one, gives up at once)
// onGiveUp then fails the parcel and rings the bell. Every step reads the parcel's status first:
// a second run of a job (the queue's at-least-once) finds it booked and does nothing.
@Injectable()
export class ShipmentBookingHandler implements EventHandler<'storefront.shipment_requested'> {
  private readonly logger = new Logger(ShipmentBookingHandler.name);

  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
  ) {}

  async handle(event: OutboxEvent<'storefront.shipment_requested'>): Promise<void> {
    const booking = await this.start(event.payload.shipmentId);
    if (booking === null) return;
    const outcome = await this.call(booking);
    await this.finish(booking, outcome);
    if (outcome.kind === 'failed') {
      const message = `parcel ${booking.shipmentId}: ${outcome.error}`;
      throw outcome.permanent ? new PermanentJobError(message) : new Error(message);
    }
  }

  // After the last try, or at once for a permanent failure: the parcel fails, keeping the last
  // try's reason (courier_unreachable when none was written: the worker died before it could),
  // and the bell rings for the people who can book again (decision 4)
  async onGiveUp(event: OutboxEvent<'storefront.shipment_requested'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [failed] = await tx
        .update(storefrontShipments)
        .set({
          status: 'booking_failed',
          error: sql`coalesce(${storefrontShipments.error}, 'courier_unreachable')`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, event.payload.shipmentId),
            eq(storefrontShipments.status, 'booking'),
          ),
        )
        .returning({
          orderId: storefrontShipments.orderId,
          accountId: storefrontShipments.courierAccountId,
        });
      // Booked meanwhile (a second job), or not this job's to fail
      if (failed === undefined) return;
      const [order] = await tx
        .select({ orderNo: storefrontOrders.orderNo, accountName: courierAccounts.name })
        .from(storefrontOrders)
        .innerJoin(
          courierAccounts,
          and(
            eq(courierAccounts.tenantId, storefrontOrders.tenantId),
            eq(courierAccounts.id, failed.accountId),
          ),
        )
        .where(
          and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, failed.orderId)),
        );
      if (order?.orderNo == null) return;
      for (const member of await membersWhoMay(tx, 'storefront.order.manage')) {
        await notify(tx, {
          userId: member.userId,
          type: 'storefront.shipment_failed',
          // The number and the account's name; never the buyer's name or phone (a bell is seen
          // over a shoulder)
          params: { id: failed.orderId, number: order.orderNo, courier: order.accountName },
          eventId: event.id,
        });
      }
    });
  }

  private start(shipmentId: string): Promise<Booking | null> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [row] = await tx
        .select({ parcel: storefrontShipments, account: courierAccounts, order: storefrontOrders })
        .from(storefrontShipments)
        .innerJoin(
          courierAccounts,
          and(
            eq(courierAccounts.tenantId, storefrontShipments.tenantId),
            eq(courierAccounts.id, storefrontShipments.courierAccountId),
          ),
        )
        .innerJoin(
          storefrontOrders,
          and(
            eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
            eq(storefrontOrders.id, storefrontShipments.orderId),
          ),
        )
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
        )
        .for('update', { of: storefrontShipments });
      // Booked already (a second run), failed and not asked again, or gone
      if (row?.parcel.status !== 'booking') return null;
      const { parcel, account, order } = row;
      if (!isApiProvider(account.provider)) {
        throw new PermanentJobError(`parcel ${shipmentId} has a manual account`);
      }
      await tx
        .update(storefrontShipments)
        .set({ attempts: sql`${storefrontShipments.attempts} + 1`, updatedAt: new Date() })
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
        );
      const [items] = await tx
        .select({ count: sql<number>`coalesce(sum(${storefrontOrderLines.quantity}), 0)::int` })
        .from(storefrontOrderLines)
        .where(
          and(
            eq(storefrontOrderLines.tenantId, tenantId),
            eq(storefrontOrderLines.orderId, order.id),
          ),
        );
      const keys = openKeys(this.shipping.credentialsKey, account);
      if (keys === null) {
        // The workspace and the account, never a value
        this.logger.error(
          `The keys of courier account ${account.id} (tenant ${tenantId}) cannot be opened`,
        );
      }
      const count = items?.count ?? 0;
      return {
        shipmentId,
        orderId: order.id,
        attemptsBefore: parcel.attempts,
        adapter: this.couriers[account.provider],
        keys,
        request: {
          invoice: parcel.invoice,
          name: order.customerName,
          phone: order.phone,
          address: `${order.address}, ${order.zoneName}`,
          // Postgres's "578.0000" as the courier's two decimals; the amount is to the paisa
          // already (28a.2's amounts check)
          codAmount: parcel.codAmount.replace(/^(\d+)\.(\d{2})\d*$/, '$1.$2'),
          note: `${String(count)} ${count === 1 ? 'item' : 'items'}`,
        },
      };
    });
  }

  private async call(booking: Booking): Promise<Outcome> {
    const { adapter, keys, request } = booking;
    // Keys this server cannot open: no CREDENTIALS_KEY, or sealed by another key. Trying again
    // cannot help until someone types them again on Shop couriers
    if (keys === null) {
      return { kind: 'failed', error: 'courier_key_missing', detail: null, permanent: true };
    }
    // A try after the first: the courier may have the parcel from a call whose answer was lost
    if (booking.attemptsBefore > 0) {
      const found = await this.found(adapter, keys, request.invoice);
      if (found !== null) return found;
    }
    const answer = await adapter.book(keys, request);
    switch (answer.kind) {
      case 'booked':
        return { kind: 'booked', parcel: answer.parcel };
      case 'refused':
        return {
          kind: 'failed',
          error: 'courier_rejected_parcel',
          detail: answer.detail,
          permanent: true,
        };
      case 'taken':
        return (
          (await this.found(adapter, keys, request.invoice)) ?? {
            kind: 'failed',
            error: 'courier_unreachable',
            detail: null,
            permanent: false,
          }
        );
      case 'problem':
        return problemOutcome(answer.problem);
    }
  }

  // The parcel by its invoice: the booking it is (found), a failure (exists without a code, or
  // the courier could not be asked), or null when nothing has the invoice and booking is safe
  private async found(
    adapter: CourierAdapter,
    keys: CourierKeys,
    invoice: string,
  ): Promise<Outcome | null> {
    const answer = await adapter.find(keys, invoice);
    switch (answer.kind) {
      case 'found':
        return { kind: 'booked', parcel: answer.parcel };
      case 'exists':
        return { kind: 'failed', error: 'courier_invoice_taken', detail: null, permanent: true };
      case 'none':
        return null;
      case 'problem':
        return problemOutcome(answer.problem);
    }
  }

  private finish(booking: Booking, outcome: Outcome): Promise<void> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [parcel] = await tx
        .select({ status: storefrontShipments.status })
        .from(storefrontShipments)
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, booking.shipmentId),
          ),
        )
        .for('update');
      if (parcel?.status !== 'booking') return;
      const now = new Date();
      if (outcome.kind === 'failed') {
        await tx
          .update(storefrontShipments)
          .set({ error: outcome.error, errorDetail: courierText(outcome.detail), updatedAt: now })
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              eq(storefrontShipments.id, booking.shipmentId),
            ),
          );
        return;
      }
      const { parcel: booked } = outcome;
      await tx
        .update(storefrontShipments)
        .set({
          status: booked.status,
          consignmentId: booked.consignmentId,
          trackingCode: booked.trackingCode,
          trackingUrl: booked.trackingUrl,
          bookedAt: now,
          error: null,
          errorDetail: null,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(storefrontShipments.tenantId, tenantId),
            eq(storefrontShipments.id, booking.shipmentId),
          ),
        );
      // The first step: booked, by the booking itself. The tracking page shows a parcel from here
      await tx
        .insert(storefrontShipmentEvents)
        .values({
          tenantId,
          shipmentId: booking.shipmentId,
          status: 'booked',
          note: null,
          occurredAt: now,
          receivedAt: now,
          source: 'booking',
          eventKey: eventKeyOf('booking', 'booked', now, null),
        })
        .onConflictDoNothing();
    });
  }
}

// The keys refused: the tenant's account, not our bug (§14.6 rule 5), and the same next time.
// No answer: maybe next time
function problemOutcome(problem: 'rejected' | 'unreachable'): Outcome {
  return problem === 'rejected'
    ? { kind: 'failed', error: 'courier_rejected_keys', detail: null, permanent: true }
    : { kind: 'failed', error: 'courier_unreachable', detail: null, permanent: false };
}
```

- **Three transactions, no lock held while the courier thinks** (27d's rule). The try is counted first: a worker that
  dies during the call leaves the count, and the next try knows the courier may have the parcel.
- **Every step reads the parcel's status first,** so a job that runs twice (the queue promises at least once) finds
  the parcel booked and does nothing.
- **A try after the first asks by the invoice before it books** (decision 3). `found` is a booking; `exists` fails
  for good (mine 29); `none` means booking now makes the only parcel.
- **Permanent and temporary failures:** keys this server cannot open (`courier_key_missing`), keys refused, a parcel
  refused and a taken invoice are permanent: `PermanentJobError` skips the other tries. No answer throws a plain
  error, and the queue tries again later.
- **The error is written while the parcel still books,** so the page says what went wrong last time; `onGiveUp()`
  then fails the parcel with it (or `courier_unreachable` when the worker died before it wrote one) and rings the
  bell for the owners and `storefront.order.manage`. The bell names the order and the account, never the buyer.
- **What the courier is told:** the address with the delivery zone after it (the rider's area), the amount with two
  decimals, and "3 items", never the products.
- **The booking's own step** (`booked`, source `booking`) is what the tracking page shows first.

```diff
@@ -6,12 +6,14 @@ import { z } from 'zod';
 import type { WorkerConfig } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
 
-export const QUEUE_NAMES = ['email', 'jobs'] as const;
+export const QUEUE_NAMES = ['email', 'jobs', 'couriers'] as const;
 export type QueueName = (typeof QUEUE_NAMES)[number];
 
 // Two queues, so a slow or broken mail server never holds up workspace setup. Each queue gets its
 // own workers, and the email queue can get a rate limit later (a mail provider allows N per second).
-// satisfies: a new event type without a queue does not compile.
+// satisfies: a new event type without a queue does not compile. Step 28a: a third, for the
+// couriers: a courier's API that answers slowly (15 seconds, then a retry minutes later) must not
+// hold up a workspace's setup or a report.
 const QUEUE_OF = {
   'workspace.created': 'email',
   'invitation.issued': 'email',
@@ -33,6 +35,7 @@ const QUEUE_OF = {
   'storefront.image_uploaded': 'jobs',
   'storefront.order_confirmed': 'jobs',
   'storefront.payment_paid': 'jobs',
+  'storefront.shipment_requested': 'couriers',
 } satisfies Record<OutboxEventType, QueueName>;
 
 // The hourly maintenance job. Not an outbox event: no request asks for it, a scheduler adds it.
@@ -45,6 +48,9 @@ export const REPORT_SCHEDULE_SWEEP = 'report-schedules.sweep';
 // Step 27a: every 5 minutes, delete the shop orders that never got their phone code (decision 19)
 export const PENDING_ORDER_SWEEP = 'storefront-orders.sweep';
 
+// Step 28a: every 15 minutes, ask the couriers about the parcels on their way (decision 9)
+export const SHIPMENT_POLL = 'storefront-shipments.poll';
+
 // What a job carries: the outbox row minus its bookkeeping. The job name is the event type.
 // Redis is data from outside this process, so the worker checks this shape before using it.
 export const eventJobDataSchema = z.object({
@@ -63,6 +69,7 @@ type OutboxRow = typeof outboxEvents.$inferSelect;
 
 const HOUR_MS = 60 * 60 * 1000;
 const SWEEP_MS = 5 * 60 * 1000;
+const POLL_MS = 15 * 60 * 1000;
 const DAY_S = 24 * 60 * 60;
 
 @Injectable()
@@ -78,6 +85,7 @@ export class Queues implements OnApplicationShutdown {
     this.queues = {
       email: new Queue('email', { connection }),
       jobs: new Queue('jobs', { connection }),
+      couriers: new Queue('couriers', { connection }),
     };
     // As in job-runner.ts: without a listener, every failed reconnect is an "unhandled error"
     // printed by ioredis. The relay already reports the failures that matter.
@@ -90,6 +98,8 @@ export class Queues implements OnApplicationShutdown {
 
   async publish(rows: readonly OutboxRow[]): Promise<void> {
     for (const name of QUEUE_NAMES) {
+      // Step 28a: the couriers' queue has its own tries and pauses (config.ts's courierRetry)
+      const retry = name === 'couriers' ? this.config.courierRetry : this.config.retry;
       const jobs = rows
         .filter((row) => QUEUE_OF[row.type] === name)
         .map((row) => ({
@@ -105,8 +115,8 @@ export class Queues implements OnApplicationShutdown {
             // relay publishes a row twice (it pushed to Redis, then crashed before marking the row),
             // the second add is a no-op while the first job is still kept.
             jobId: row.id,
-            attempts: this.config.retry.attempts,
-            backoff: { type: 'exponential', delay: this.config.retry.backoffMs },
+            attempts: retry.attempts,
+            backoff: { type: 'exponential', delay: retry.backoffMs },
             // Keep finished jobs for a day and failed ones for a week (ages in seconds), so they
             // can be inspected; after that Redis would only fill up with them
             removeOnComplete: { age: DAY_S },
@@ -148,6 +158,16 @@ export class Queues implements OnApplicationShutdown {
     );
   }
 
+  // Step 28a: the same, for the couriers' poll. On the jobs queue: one run is quick database work
+  // around a call per parcel, and a poll held up by a report is only a little late
+  async scheduleShipmentPoll(): Promise<void> {
+    await this.queues.jobs.upsertJobScheduler(
+      'storefront-shipments-poll',
+      { every: POLL_MS },
+      { name: SHIPMENT_POLL },
+    );
+  }
+
   async onApplicationShutdown(): Promise<void> {
     await Promise.all(QUEUE_NAMES.map((name) => this.queues[name].close()));
   }
```

- **`couriers` is a third queue** (mine 28); `JobRunner` makes one BullMQ worker per name in `QUEUE_NAMES`, so it
  needs no change for it.
- **The retry options follow the queue,** not the event: every event on `couriers` gets `courierRetry`.
- **The poll's schedule** is on `jobs`: one run is quick database work around a call per parcel.

```diff
@@ -22,6 +22,7 @@ import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
 import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
 import { PaymentPaidHandler } from '../storefront/orders/payment-paid.handler.js';
+import { ShipmentBookingHandler } from '../storefront/shipping/booking.handler.js';
 
 // Which handler runs for which event — the one place to look. The mapped type ties each key to a
 // handler of exactly that event, so wiring the invitation handler to 'member.joined' (or leaving
@@ -54,6 +55,7 @@ export class EventHandlers {
     storefrontImage: StorefrontImageHandler,
     orderConfirmed: OrderConfirmedHandler,
     paymentPaid: PaymentPaidHandler,
+    shipmentBooking: ShipmentBookingHandler,
   ) {
     this.byType = {
       'workspace.created': welcome,
@@ -76,6 +78,7 @@ export class EventHandlers {
       'storefront.image_uploaded': storefrontImage,
       'storefront.order_confirmed': orderConfirmed,
       'storefront.payment_paid': paymentPaid,
+      'storefront.shipment_requested': shipmentBooking,
     };
   }
 
```

### The courier's news

```ts
import { Injectable, Logger } from '@nestjs/common';
import { type ShipmentStatus, type ShopShipmentStatus } from '@omnivo/contracts';
import { storefrontSettings, storefrontShipmentEvents, storefrontShipments } from '@omnivo/db';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

import { AppError } from '../../common/http/app-error.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { type CourierNotice, eventKeyOf } from '../../shipping/courier.js';
import { pickedUpSms } from '../../sms/shop-sms.js';
import type { SmsJob } from '../../sms/sms-job.js';
import { lockOrder, ShopOrderMoves } from '../orders/order-moves.js';

type ParcelRow = typeof storefrontShipments.$inferSelect;

// Where a parcel is after the courier took it: any of these means the goods have left the shop, so
// a packed order is Shipped (decision 5). Not booked (nobody came yet) and not cancelled
const LEFT_THE_SHOP = new Set<ShipmentStatus>([
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partly_delivered',
  'on_hold',
  'returning',
  'returned',
]);

// A parcel whose status the news no longer changes: the courier never answered a code for one in
// booking or booking_failed (it is the booking job's), and 0078's guard keeps a cancelled or
// returned one where it is
const SETTLED = new Set<ShipmentStatus>(['booking', 'booking_failed', 'cancelled', 'returned']);

// What a courier's status means for a parcel that is where `current` says. The courier cancelling
// the consignment before anyone picked it up is a cancelled booking; once the goods left, they are
// coming back (the Steadfast adapter's note). The webhook and the poll both read a status this way,
// so the poll's "is this news?" and the step the webhook writes agree
export function stepStatusOf(
  current: ShipmentStatus,
  said: ShopShipmentStatus,
): ShopShipmentStatus {
  if (said !== 'cancelled') return said;
  return current === 'booking' ||
    current === 'booking_failed' ||
    current === 'booked' ||
    current === 'cancelled'
    ? 'cancelled'
    : 'returning';
}

function between(at: Date, from: Date, to: Date): Date {
  return new Date(Math.min(Math.max(at.getTime(), from.getTime()), to.getTime()));
}

// 28a.2's raw column holds at most 8 KB. A courier's notice is a few hundred bytes; a body over the
// limit is kept as a marker, so it is still seen as one we could not read
function keptRaw(raw: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 8000 ? raw : { tooLarge: true };
}

// Step 28a: what the courier said about one parcel, from its webhook (in the API) or the 15-minute
// poll (in the worker), written the same way:
// 1. the order, then the parcel, are locked (the buttons' order, so the two take turns)
// 2. each step is a row of the parcel's events, with the API's own key: the same step twice is
//    one row (28a.2's mine 26)
// 3. the parcel's status is its newest step's, by the courier's clock (kept between the booking
//    and now): a webhook that comes late does not take the parcel back
// 4. the order follows: Shipped once the goods have left, then Delivered, which posts the invoice
//    (decision 5, the buttons' own code in order-moves.ts)
// It answers the SMS to send once the caller's transaction has committed (decision 11), never
// before: an SMS for news that rolled back would tell the shopper something that did not happen.
@Injectable()
export class ShipmentNews {
  private readonly logger = new Logger(ShipmentNews.name);

  constructor(private readonly moves: ShopOrderMoves) {}

  async apply(
    tx: Transaction,
    shipmentId: string,
    notices: readonly CourierNotice[],
    source: 'webhook' | 'poll',
    now: Date = new Date(),
  ): Promise<SmsJob | null> {
    const tenantId = getTenantId();
    const [found] = await tx
      .select({ orderId: storefrontShipments.orderId })
      .from(storefrontShipments)
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      );
    if (found === undefined) return null;
    const order = await lockOrder(tx, found.orderId);
    const [parcel] = await tx
      .select()
      .from(storefrontShipments)
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      )
      .for('update');
    if (parcel === undefined) return null;

    let current: ShipmentStatus = parcel.status;
    for (const notice of notices) {
      const step = this.stepOf(parcel, current, notice, now);
      await tx
        .insert(storefrontShipmentEvents)
        .values({ tenantId, shipmentId, ...step, source, receivedAt: now })
        .onConflictDoNothing();
      if (step.status !== null) current = step.status;
    }

    const status = SETTLED.has(parcel.status) ? parcel.status : await this.newest(tx, parcel);
    await tx
      .update(storefrontShipments)
      .set({ status, lastSyncedAt: now, updatedAt: now })
      .where(
        and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.id, shipmentId)),
      );

    let sms: SmsJob | null = null;
    if (LEFT_THE_SHOP.has(status) && order.status === 'packed') {
      await this.moves.ship(tx, order);
      sms = await this.pickedUp(tx, order.phone, order.orderNo, parcel);
    }
    if (status === 'delivered') await this.deliver(tx, order.id);
    return sms;
  }

  // One notice as an event row. A parcel the courier has not given a code to yet (still booking,
  // or failed) keeps any news about it raw: it cannot have a step before it has a code
  private stepOf(
    parcel: ParcelRow,
    current: ShipmentStatus,
    notice: CourierNotice,
    now: Date,
  ): {
    status: ShopShipmentStatus | null;
    note: string | null;
    occurredAt: Date;
    eventKey: string;
    raw: Record<string, unknown> | null;
  } {
    const booked = !(parcel.status === 'booking' || parcel.status === 'booking_failed');
    if (
      notice.kind === 'unread' ||
      !booked ||
      (notice.kind === 'status' && notice.status === null)
    ) {
      const raw = keptRaw(notice.raw);
      // Its key from the body itself: the same body sent twice is one row
      return {
        status: null,
        note: null,
        occurredAt: now,
        eventKey: eventKeyOf('unread', null, null, JSON.stringify(raw)),
        raw,
      };
    }
    // The courier's clock, kept between the booking and the moment the notice reached us: a step
    // cannot happen before the parcel was booked, nor after we heard of it. A courier clock a few
    // minutes off (or a time in the wrong zone) would otherwise put a new step before the booking
    // and take the parcel back to booked
    const at = between(notice.at ?? now, parcel.bookedAt ?? now, now);
    let status: ShopShipmentStatus;
    if (notice.kind === 'note') {
      // Words with no new status: the step is where the parcel is now (booked, in transit …)
      status = current === 'booking' || current === 'booking_failed' ? 'booked' : current;
    } else {
      status = stepStatusOf(current, notice.status ?? 'booked');
    }
    return {
      status,
      note: notice.note,
      occurredAt: at,
      eventKey: eventKeyOf(notice.kind, status, notice.at, notice.note),
      raw: null,
    };
  }

  // The parcel's newest step by the courier's clock (then by when it reached us), the status it
  // takes. 0078's guard never lets it leave cancelled or returned, which SETTLED already keeps
  private async newest(tx: Transaction, parcel: ParcelRow): Promise<ShipmentStatus> {
    const [step] = await tx
      .select({ status: storefrontShipmentEvents.status })
      .from(storefrontShipmentEvents)
      .where(
        and(
          eq(storefrontShipmentEvents.tenantId, getTenantId()),
          eq(storefrontShipmentEvents.shipmentId, parcel.id),
          isNotNull(storefrontShipmentEvents.status),
        ),
      )
      .orderBy(desc(storefrontShipmentEvents.occurredAt), desc(storefrontShipmentEvents.receivedAt))
      .limit(1);
    return step?.status ?? parcel.status;
  }

  // Delivered posts the invoice, in a savepoint: an invoice the sales rules refuse (a product
  // archived since, a lock date) must not lose the courier's news with it. The order stays
  // Shipped, and Mark delivered on its page shows the reason to the member who can fix it
  private async deliver(tx: Transaction, orderId: string): Promise<void> {
    const order = await lockOrder(tx, orderId);
    if (order.status !== 'shipped') return;
    try {
      await tx.transaction((inner) => this.moves.deliver(inner, order));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.logger.warn(`Shop order ${orderId} was delivered, but its invoice: ${error.code}`);
    }
  }

  // The shopper's SMS: the courier and its code (decision 11). None before the shop is set up
  // (there is no name to sign it with), which a shop with orders always is
  private async pickedUp(
    tx: Transaction,
    phone: string,
    orderNo: string | null,
    parcel: ParcelRow,
  ): Promise<SmsJob | null> {
    if (orderNo === null || parcel.trackingCode === null) return null;
    const [shop] = await tx
      .select({ language: storefrontSettings.language, name: storefrontSettings.name })
      .from(storefrontSettings)
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    if (shop === undefined) return null;
    return {
      to: phone,
      text: pickedUpSms(shop.language, shop.name, orderNo, parcel.courier, parcel.trackingCode),
    };
  }
}
```

- **The order is locked before the parcel,** the buttons' order, so a webhook and a Mark shipped take turns.
- **`stepOf()`:** a parcel without a code yet keeps any news raw; a note with no status is a step at the parcel's
  current status; `stepStatusOf()` reads a cancel after the pickup as goods coming back (mine 39). The time is
  clamped by `between()` (mine 32), the key is not.
- **`newest()`** orders by the courier's time, then by when it reached us. A parcel in `booking`, `booking_failed`,
  `cancelled` or `returned` keeps its status (`SETTLED`): the first two are the booking job's, the last two are
  0078's guard.
- **The order follows:** any status in `LEFT_THE_SHOP` ships a packed order (and makes the SMS), and `delivered`
  delivers it, in a savepoint (mine 33). `partly_delivered`, `returning` and `returned` ship the order and stop
  there: 28b handles what comes back.
- **The SMS is answered, never sent here.** The caller sends it after its commit.

```diff
@@ -1,6 +1,6 @@
-import { type LanguageCode, SHOP_CODE_VALID_MINUTES } from '@omnivo/contracts';
+import { type LanguageCode, SHOP_CODE_VALID_MINUTES, type ShopCourier } from '@omnivo/contracts';
 
-// Step 27a: the shop's two SMS (27b adds a third), in the shop's language (storefront_settings.language). Written
+// Step 27a: the shop's two SMS (27b adds a third, 28a a fourth), in the shop's language (storefront_settings.language). Written
 // here, side by side, like the emails' words (mail/invitation-email.ts): @omnivo/i18n is the
 // browser's. satisfies makes a third language a compile error until it has its words.
 //
@@ -51,3 +51,30 @@ export function cancelledSms(
   } satisfies Record<LanguageCode, string>;
   return words[language];
 }
+
+// The couriers' own names: brand names, the same in every language (as the tracking page's
+// shop.track.couriers words)
+const COURIER_NAMES = {
+  pathao: 'Pathao',
+  steadfast: 'Steadfast',
+  redx: 'RedX',
+  ecourier: 'eCourier',
+  paperfly: 'Paperfly',
+} satisfies Record<ShopCourier, string>;
+
+// Step 28a (decision 11): the courier picked the parcel up, and the order is Shipped. The courier
+// and its code, which its call centre asks for; the tracking link went with the confirmation and
+// cannot be sent again (only its hash is kept)
+export function pickedUpSms(
+  language: LanguageCode,
+  shopName: string,
+  orderNo: string,
+  courier: ShopCourier,
+  trackingCode: string,
+): string {
+  const words = {
+    en: `${shopName}: order ${orderNo} is on its way with ${COURIER_NAMES[courier]}, code ${trackingCode}.`,
+    bn: `${shopName}: অর্ডার ${orderNo} ${COURIER_NAMES[courier]} দিয়ে রওনা হয়েছে, কোড ${trackingCode}।`,
+  } satisfies Record<LanguageCode, string>;
+  return words[language];
+}
```

The fourth SMS (decision 11): the courier's name and its code, which its call centre asks for. The tracking link
went with the confirmation and cannot be sent again: only its hash is kept.

```diff
@@ -17,7 +17,9 @@ export class SmsQueue implements OnApplicationShutdown {
   private readonly logger = new Logger(SmsQueue.name);
   private queue: Queue | null = null;
 
-  constructor(@Inject(CONFIG) private readonly config: Config) {}
+  // Only the Redis address: step 28a's worker adds SMS too (a parcel picked up, found by the poll),
+  // and its config has the address but not the API's other parts
+  constructor(@Inject(CONFIG) private readonly config: Pick<Config, 'redisUrl'>) {}
 
   // Made on the first SMS, not when the API starts: most API processes never send one, and a queue
   // made at start would hold a Redis connection open (and try it in tests that have no Redis)
```

`Pick<Config, 'redisUrl'>`: the worker's config has the address but not the API's other parts, and the queue reads
nothing else.

### The webhook

```ts
import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { type Db, courierAccounts, storefrontShipments } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AppError } from '../../common/http/app-error.js';
import { runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { COURIERS, DB, WITH_TENANT } from '../../infra/tokens.js';
import type { ApiCourierProvider, CourierAdapters } from '../../shipping/courier.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { tokenHash } from '../orders/order-secrets.js';
import { ShipmentNews } from './shipment-news.js';

const lookupSchema = z.object({ tenant_id: z.uuid(), webhook_token_hash: z.string() });

function tokenInvalid(): AppError {
  return new AppError(
    401,
    'courier_webhook_token_invalid',
    'This webhook token is not right. Paste the token from Shop couriers.',
  );
}

// "Bearer <token>" as the courier's panel sends it, or null
export function bearerOf(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

// Step 28a (decisions 8 and 22): a courier's webhook. The courier knows only the account's id (in
// the address) and its token (the Authorization header), so:
// 1. courier_account_for_webhook (0078) finds the workspace and the token's hash for the id, with
//    no workspace set yet. The same 401 for an unknown id, a manual account, another provider's
//    account and a wrong token: the caller learns nothing about which ids exist
// 2. the token is compared with the hash in constant time, before the body is read at all
// 3. inside the workspace: the account's last webhook time (the page shows it, decision 16), then
//    the parcel by the courier's id or by our invoice, only among this account's parcels. The
//    body never says which workspace or account it is for
// A body we cannot read, or one about a parcel we do not know, is answered "success" all the same:
// a refusal would only make the courier send it again and again, and then stop sending.
@Injectable()
export class CourierWebhooks {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
    private readonly news: ShipmentNews,
    private readonly sms: SmsQueue,
  ) {}

  async receive(
    provider: ApiCourierProvider,
    accountId: string,
    authorization: string | undefined,
    body: unknown,
  ): Promise<void> {
    const token = bearerOf(authorization);
    if (token === null) throw tokenInvalid();
    const rows = await this.db.execute(
      sql`SELECT tenant_id::text AS tenant_id, webhook_token_hash
          FROM courier_account_for_webhook(${accountId}::uuid, ${provider})`,
    );
    const found = lookupSchema.safeParse(rows[0]);
    if (!found.success) throw tokenInvalid();
    // Two SHA-256 digests in hex: always one length, as timingSafeEqual needs
    const sent = Buffer.from(tokenHash(token), 'hex');
    const kept = Buffer.from(found.data.webhook_token_hash, 'hex');
    if (sent.length !== kept.length || !timingSafeEqual(sent, kept)) throw tokenInvalid();

    const notice = this.couriers[provider].readNotice(body);
    const tenantId = found.data.tenant_id;
    const sms = await runWithTenant(tenantId, () =>
      this.withTenant(async (tx) => {
        const now = new Date();
        await tx
          .update(courierAccounts)
          .set({ lastWebhookAt: now })
          .where(and(eq(courierAccounts.tenantId, tenantId), eq(courierAccounts.id, accountId)));
        const by =
          notice.consignmentId !== null
            ? eq(storefrontShipments.consignmentId, notice.consignmentId)
            : notice.invoice !== null
              ? eq(storefrontShipments.invoice, notice.invoice)
              : null;
        if (by === null) return null;
        const [parcel] = await tx
          .select({ id: storefrontShipments.id })
          .from(storefrontShipments)
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              eq(storefrontShipments.courierAccountId, accountId),
              by,
            ),
          );
        return parcel === undefined
          ? null
          : this.news.apply(tx, parcel.id, [notice], 'webhook', now);
      }),
    );
    // After the commit; never throws (SmsQueue.send)
    if (sms !== null) await this.sms.send(sms);
  }
}
```

- **One 401 for every wrong case:** no bearer token, an unknown id, a manual account, another provider's account, a
  wrong token. The caller learns nothing about which ids exist.
- **`courier_account_for_webhook`** (0078) runs with no workspace set: the address names only the account. It runs
  as `omnivo_app` through `DB`; only that role may run it.
- **The token is compared as two SHA-256 digests with `timingSafeEqual`,** before the body is read.
- **Inside the workspace,** the account's `last_webhook_at` is written first (decision 16), then the parcel is found
  by the courier's id or by our invoice, only among this account's parcels: the body never chooses the workspace
  or the account.
- **A notice about a parcel we do not know is still a 200** (decision 22).

```ts
import { Controller, Headers } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { CourierAccountsService } from './courier-accounts.service.js';
import { CourierWebhooks } from './courier-webhooks.js';

type Routes = typeof routes.shipping;

// Step 28a: Storefront → Shop couriers, and the courier's webhook. The accounts' routes need
// storefront.manage (the contract says so and the guard checks it); the webhook is public, and
// CourierWebhooks checks the account's token before it reads anything (decision 8)
@Controller()
export class CourierAccountsController {
  constructor(
    private readonly accounts: CourierAccountsService,
    private readonly webhooks: CourierWebhooks,
  ) {}

  @Endpoint(routes.shipping.getCouriers)
  getCouriers(): Promise<RouteResponse<Routes['getCouriers']>> {
    return this.accounts.setup();
  }

  @Endpoint(routes.shipping.createCourier)
  createCourier({
    body,
  }: RouteInput<Routes['createCourier']>): Promise<RouteResponse<Routes['createCourier']>> {
    return this.accounts.create(body);
  }

  // Declared before updateCourier only for reading order: the two have different methods on
  // /storefront/couriers and /storefront/couriers/:id, so Nest never mixes them up
  @Endpoint(routes.shipping.setDefaultCourier)
  setDefaultCourier({
    body,
  }: RouteInput<Routes['setDefaultCourier']>): Promise<RouteResponse<Routes['setDefaultCourier']>> {
    return this.accounts.setDefault(body.accountId);
  }

  @Endpoint(routes.shipping.updateCourier)
  updateCourier({
    params,
    body,
  }: RouteInput<Routes['updateCourier']>): Promise<RouteResponse<Routes['updateCourier']>> {
    return this.accounts.update(params.id, body);
  }

  @Endpoint(routes.shipping.testCourier)
  testCourier({
    params,
  }: RouteInput<Routes['testCourier']>): Promise<RouteResponse<Routes['testCourier']>> {
    return this.accounts.test(params.id);
  }

  @Endpoint(routes.shipping.renewCourierWebhookToken)
  renewCourierWebhookToken({
    params,
    body,
  }: RouteInput<Routes['renewCourierWebhookToken']>): Promise<
    RouteResponse<Routes['renewCourierWebhookToken']>
  > {
    return this.accounts.renewToken(params.id, body.version);
  }

  @Endpoint(routes.shipping.archiveCourier)
  archiveCourier({
    params,
    body,
  }: RouteInput<Routes['archiveCourier']>): Promise<RouteResponse<Routes['archiveCourier']>> {
    return this.accounts.archive(params.id, body.version);
  }

  @Endpoint(routes.shipping.restoreCourier)
  restoreCourier({
    params,
    body,
  }: RouteInput<Routes['restoreCourier']>): Promise<RouteResponse<Routes['restoreCourier']>> {
    return this.accounts.restore(params.id, body.version);
  }

  // The body is the contract's loose one (any object passes, decision 22). The header is read
  // with Nest's own decorator: it is not part of the contract's input
  @Endpoint(routes.shipping.steadfastWebhook)
  async steadfastWebhook(
    { params, body }: RouteInput<Routes['steadfastWebhook']>,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<RouteResponse<Routes['steadfastWebhook']>> {
    await this.webhooks.receive('steadfast', params.id, authorization, body);
    return { status: 'success', message: 'Received' };
  }
}
```

The webhook reads the `Authorization` header with Nest's `@Headers()` as the second parameter: the contract's input
is the first, and a header is not part of it.

```diff
@@ -29,6 +29,11 @@ import { StorefrontOrdersController } from './orders/storefront-orders.controlle
 import { StorefrontOrdersService } from './orders/storefront-orders.service.js';
 import { PublicStorefrontController } from './public-storefront.controller.js';
 import { PublicStorefrontService } from './public-storefront.service.js';
+import { ShopOrderMoves } from './orders/order-moves.js';
+import { CourierAccountsController } from './shipping/courier-accounts.controller.js';
+import { CourierAccountsService } from './shipping/courier-accounts.service.js';
+import { CourierWebhooks } from './shipping/courier-webhooks.js';
+import { ShipmentNews } from './shipping/shipment-news.js';
 import { ShopDb } from './shop-db.js';
 
 // Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
@@ -44,7 +49,11 @@ import { ShopDb } from './shop-db.js';
 // the reason above. Step 27d adds paying online: the shop's payment routes (orders/shop-payments.*,
 // as omnivo_shop), the Payment card (admin/payment-gateway.*), and the money receipt of a paid try
 // (orders/payment-receipts.ts), which "Make the receipt" shares with the worker. The gateway itself
-// comes from InfraModule (PAYMENT_GATEWAY)
+// comes from InfraModule (PAYMENT_GATEWAY). Step 28a adds couriers (shipping/): the Shop couriers
+// page and the courier's webhook (one controller), the parcels of a shop order (shipping/
+// shipments.ts, used by the order moves), and the courier's news, which moves an order with the
+// buttons' own code (orders/order-moves.ts). The adapters come from InfraModule (COURIERS); the
+// booking job and the poll run in the worker
 @Module({
   imports: [AttachmentsModule, SalesModule, ProductsModule],
   controllers: [
@@ -55,6 +64,7 @@ import { ShopDb } from './shop-db.js';
     StorefrontOrdersController,
     StorefrontCouponsController,
     StorefrontPaymentsController,
+    CourierAccountsController,
   ],
   providers: [
     ShopDb,
@@ -77,6 +87,10 @@ import { ShopDb } from './shop-db.js';
     ShopPaymentsService,
     ShopPaymentReceipts,
     StorefrontPaymentGatewayService,
+    ShopOrderMoves,
+    CourierAccountsService,
+    CourierWebhooks,
+    ShipmentNews,
   ],
 })
 export class StorefrontModule {}
```

### The poll

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OPEN_SHIPMENT_STATUSES } from '@omnivo/contracts';
import { type Db, courierAccounts, storefrontShipments } from '@omnivo/db';
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import type { ShippingConfig } from '../../config.js';
import { COURIERS, RELAY_DB, SHIPPING_CONFIG, WITH_TENANT } from '../../infra/tokens.js';
import { type CourierAdapters, isApiProvider } from '../../shipping/courier.js';
import { SmsQueue } from '../../sms/sms-queue.js';
import { openKeys } from './courier-keys.js';
import { ShipmentNews, stepStatusOf } from './shipment-news.js';

// How many parcels of one workspace one poll asks about, least recently heard from first. The
// rest wait for the next poll, 15 minutes later: a shop with a thousand parcels on the road is
// covered within a few hours, and no workspace's courier gets hundreds of calls at once (mine)
const BATCH = 100;

// The statuses the poll asks about: the parcels still on their way that the courier knows (the
// booking job has the ones still in `booking`)
const POLLED = OPEN_SHIPMENT_STATUSES.filter((status) => status !== 'booking');

// Step 28a (decision 9): every 15 minutes, ask the courier where each parcel on its way is, for
// the shops whose courier's webhook does not come (never pasted, or the courier's own trouble).
// Two halves on two roles, like 27a's pending-order sweep:
// 1. as omnivo_worker (RELAY_DB): which workspaces have a parcel on its way. 0078 lets it read
//    the workspace and the status of the open parcels only
// 2. as omnivo_app inside each one: its parcels, then one courier call per parcel (outside any
//    transaction), then the answer through ShipmentNews in its own transaction
// A status the parcel has already is no news: only last_synced_at moves, so a parcel asked about
// a hundred times has one step per change, not a hundred. Provided by WorkerModule only.
@Injectable()
export class ShipmentPoll {
  private readonly logger = new Logger(ShipmentPoll.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(SHIPPING_CONFIG) private readonly shipping: ShippingConfig,
    @Inject(COURIERS) private readonly couriers: CourierAdapters,
    private readonly news: ShipmentNews,
    private readonly sms: SmsQueue,
  ) {}

  // The number of parcels asked about
  async run(): Promise<number> {
    const tenants = await this.relayDb
      .selectDistinct({ tenantId: storefrontShipments.tenantId })
      .from(storefrontShipments)
      .where(inArray(storefrontShipments.status, [...POLLED]));
    let asked = 0;
    for (const { tenantId } of tenants) {
      try {
        asked += await runWithTenant(tenantId, () => this.poll(tenantId));
      } catch (error) {
        // One workspace's failure must not stop the others; the next poll tries again
        this.logger.warn(`parcels (tenant ${tenantId}): ${String(error)}`);
      }
    }
    return asked;
  }

  private async poll(tenantId: string): Promise<number> {
    const parcels = await this.withTenant((tx) =>
      tx
        .select({ parcel: storefrontShipments, account: courierAccounts })
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
            eq(storefrontShipments.tenantId, tenantId),
            inArray(storefrontShipments.status, [...POLLED]),
            isNotNull(storefrontShipments.consignmentId),
            ne(courierAccounts.provider, 'manual'),
          ),
        )
        .orderBy(
          sql`${storefrontShipments.lastSyncedAt} ASC NULLS FIRST`,
          asc(storefrontShipments.id),
        )
        .limit(BATCH),
    );
    for (const { parcel, account } of parcels) {
      if (!isApiProvider(account.provider) || parcel.consignmentId === null) continue;
      const keys = openKeys(this.shipping.credentialsKey, account);
      // Keys this server cannot open: the account's own "Test connection" says so; nothing to ask
      if (keys === null) continue;
      const answer = await this.couriers[account.provider].status(keys, parcel.consignmentId);
      // No answer, or the keys refused: the next poll asks again. The webhook may still come
      if (answer.kind === 'problem') continue;
      // A word the adapter does not know is kept once by the webhook's way, not every 15 minutes
      // here; the log says which, so the adapter's table can learn it
      if (answer.status === null) {
        this.logger.warn(`${account.provider} said "${answer.word}" about parcel ${parcel.id}`);
      }
      const news =
        answer.status === null || stepStatusOf(parcel.status, answer.status) === parcel.status
          ? []
          : [
              {
                consignmentId: parcel.consignmentId,
                invoice: parcel.invoice,
                raw: { status: answer.word },
                kind: 'status' as const,
                status: answer.status,
                note: null,
                // The courier gives no time with a status: the step is when the poll saw it. A
                // time also keeps its key apart from an earlier step with the same status (in
                // transit, on hold, in transit again)
                at: new Date(),
              },
            ];
      const sms = await this.withTenant((tx) => this.news.apply(tx, parcel.id, news, 'poll'));
      if (sms !== null) await this.sms.send(sms);
    }
    return parcels.length;
  }
}
```

- **Two roles, like 27a's sweep:** `omnivo_worker` finds the workspaces with a parcel on its way (0078's policy shows
  it two columns of those rows only), then `omnivo_app` works inside each.
- **Only parcels the courier knows** (a consignment id, not `booking`, not manual), least recently heard from
  first, 100 at most (mine 38).
- **A status the parcel has already is no news** (compared through `stepStatusOf()`, as the webhook writes it): only
  `last_synced_at` moves. The step's time is the poll's, which also keeps "in transit" after "on hold" apart from
  the first "in transit".
- **A word the adapter does not know is logged, not stored:** stored, it would be a new row every 15 minutes.

```diff
@@ -19,6 +19,7 @@ import type { WorkerConfig } from '../config.js';
 import { CONFIG } from '../infra/tokens.js';
 import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
 import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
+import { ShipmentPoll } from '../storefront/shipping/shipment-poll.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { OutboxRelay } from './outbox-relay.js';
@@ -31,6 +32,7 @@ import {
   QUEUE_NAMES,
   Queues,
   REPORT_SCHEDULE_SWEEP,
+  SHIPMENT_POLL,
 } from './queues.js';
 
 // How many jobs of one queue run at the same time in one worker process. Jobs spend most of their
@@ -51,6 +53,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     private readonly syncLog: SyncLogCleanup,
     private readonly reportSweep: ReportScheduleSweep,
     private readonly orderSweep: PendingOrderSweep,
+    private readonly shipmentPoll: ShipmentPoll,
   ) {}
 
   async onApplicationBootstrap(): Promise<void> {
@@ -69,6 +72,7 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
     await this.queues.scheduleCleanup();
     await this.queues.scheduleReportSweep();
     await this.queues.schedulePendingOrderSweep();
+    await this.queues.scheduleShipmentPoll();
   }
 
   // close() stops taking new jobs and waits for the running ones, before the database closes
@@ -100,6 +104,12 @@ export class JobRunner implements OnApplicationBootstrap, BeforeApplicationShutd
       if (deleted > 0) this.logger.log(`shop orders: ${String(deleted)} without a code deleted`);
       return;
     }
+    // Step 28a: like the sweeps, no retries of its own; the next poll is 15 minutes later
+    if (job.name === SHIPMENT_POLL) {
+      const asked = await this.shipmentPoll.run();
+      if (asked > 0) this.logger.log(`parcels: asked the couriers about ${String(asked)}`);
+      return;
+    }
     // A job we cannot read will never become readable: no retries
     if (!isOutboxEventType(job.name)) throw new UnrecoverableError(`Unknown job ${job.name}`);
     const data = eventJobDataSchema.safeParse(job.data);
```
```diff
@@ -9,17 +9,22 @@ import { DocumentFileMaker } from '../documents/file-maker.js';
 import type { WorkerConfig } from '../config.js';
 import {
   CONFIG,
+  COURIERS,
   DB,
   PAYMENT_GATEWAY,
   PAYMENTS_CONFIG,
   REDIS,
   RELAY_DB,
+  SHIPPING_CONFIG,
   STORAGE_CONFIG,
   WITH_TENANT,
 } from '../infra/tokens.js';
 import { PostingService } from '../journal/posting.service.js';
 import { createGateway } from '../payments/create-gateway.js';
 import { LowStockHandler } from '../inventory/low-stock.handler.js';
+import { StockBooksService } from '../inventory/stock-books.service.js';
+import { StockPostingService } from '../inventory/stock-posting.service.js';
+import { ValueAccess } from '../inventory/value-access.js';
 import { InvitationEmailHandler } from '../invitations/invitation-email.handler.js';
 import { MemberJoinedHandler } from '../invitations/member-joined.handler.js';
 import { MailService } from '../mail/mail.service.js';
@@ -36,6 +41,8 @@ import { ReportScheduleSweep } from '../reports/report-schedule-sweep.js';
 import { BalanceAccess } from '../sales/balance-access.js';
 import { CreditService } from '../sales/credit.service.js';
 import { CustomersService } from '../sales/customers.service.js';
+import { DeliveriesService } from '../sales/deliveries.service.js';
+import { InvoicesService } from '../sales/invoices.service.js';
 import { ReceiptsService } from '../sales/receipts.service.js';
 import { SalesBooksService } from '../sales/sales-books.service.js';
 import { SalesOrdersService } from '../sales/sales-orders.service.js';
@@ -46,7 +53,9 @@ import { StockAccountsHandler } from '../setup/stock-accounts.handler.js';
 import { TaxRatesHandler } from '../setup/tax-rates.handler.js';
 import { WelcomeEmailHandler } from '../setup/welcome-email.handler.js';
 import { StorageService } from '../storage/storage.service.js';
+import { createCouriers } from '../shipping/create-couriers.js';
 import { SMS_SENDER, MailSmsSender } from '../sms/sms-sender.js';
+import { SmsQueue } from '../sms/sms-queue.js';
 import { StorefrontImageHandler } from '../storefront/image.handler.js';
 import { GatewayAccounts } from '../storefront/gateway-accounts.js';
 import { OrderConfirmedHandler } from '../storefront/orders/order-confirmed.handler.js';
@@ -54,6 +63,10 @@ import { PaymentPaidHandler } from '../storefront/orders/payment-paid.handler.js
 import { ShopPaymentReceipts } from '../storefront/orders/payment-receipts.js';
 import { PendingOrderSweep } from '../storefront/orders/pending-order-sweep.js';
 import { ShopSalesOrderMaker } from '../storefront/orders/sales-order-maker.js';
+import { ShopOrderMoves } from '../storefront/orders/order-moves.js';
+import { ShipmentBookingHandler } from '../storefront/shipping/booking.handler.js';
+import { ShipmentNews } from '../storefront/shipping/shipment-news.js';
+import { ShipmentPoll } from '../storefront/shipping/shipment-poll.js';
 import { SyncLogCleanup } from '../sync/sync-log-cleanup.js';
 import { EventHandlers } from './handlers.js';
 import { JobRunner } from './job-runner.js';
@@ -149,6 +162,23 @@ export class WorkerModule implements OnApplicationShutdown {
         ReceiptsService,
         SalesBooksService,
         PostingService,
+        // Step 28a: the couriers. The booking job, the 15-minute poll, and what the courier's
+        // news needs to move an order: Shipped and Delivered with the buttons' own code
+        // (ShopOrderMoves), whose invoice needs the sales and stock services below, and the SMS
+        // queue's producer for the "picked up" SMS (the API's own SmsQueue: it reads only
+        // redisUrl from the config)
+        { provide: SHIPPING_CONFIG, useValue: config.shipping },
+        { provide: COURIERS, useFactory: () => createCouriers(config.shipping) },
+        ShipmentBookingHandler,
+        ShipmentPoll,
+        ShipmentNews,
+        ShopOrderMoves,
+        InvoicesService,
+        DeliveriesService,
+        StockPostingService,
+        StockBooksService,
+        ValueAccess,
+        SmsQueue,
         { provide: REDIS, useFactory: () => new Redis(config.redisUrl, { lazyConnect: true }) },
       ],
     };
```

The worker gets the couriers and everything the news needs to move an order: `ShopOrderMoves`, and for its invoice
`InvoicesService` with the sales and stock services it asks for (`DeliveriesService`, `StockPostingService`,
`StockBooksService`, `ValueAccess`), plus the API's own `SmsQueue` for the picked-up SMS.

### The tracking page

```ts
import type { ShopShipment } from '@omnivo/contracts';
import { storefrontShipmentEvents, storefrontShipments } from '@omnivo/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Transaction } from '../../common/tenant/with-tenant.js';

// Step 28a: an order's parcels as the tracking page shows them (26e's shopShipmentSchema), read
// inside ShopDb.orders as omnivo_shop. Only the columns 0078 grants that role, named one by one: a
// select() of the whole row would ask for the COD amount and the courier's errors and fail. The
// restrictive policies leave out a parcel still booking or failed, and a notice we could not read,
// whatever this query asks (28a.2's mine 27). The tenant comes from the shop's host (ShopScope)
export async function shopShipmentsOf(
  tx: Transaction,
  tenantId: string,
  orderId: string,
): Promise<ShopShipment[]> {
  const parcels = await tx
    .select({
      id: storefrontShipments.id,
      courier: storefrontShipments.courier,
      trackingCode: storefrontShipments.trackingCode,
      trackingUrl: storefrontShipments.trackingUrl,
    })
    .from(storefrontShipments)
    .where(
      and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
    )
    .orderBy(asc(storefrontShipments.parcelNo));
  if (parcels.length === 0) return [];
  const events = await tx
    .select({
      shipmentId: storefrontShipmentEvents.shipmentId,
      status: storefrontShipmentEvents.status,
      note: storefrontShipmentEvents.note,
      at: storefrontShipmentEvents.occurredAt,
    })
    .from(storefrontShipmentEvents)
    .where(
      and(
        eq(storefrontShipmentEvents.tenantId, tenantId),
        inArray(
          storefrontShipmentEvents.shipmentId,
          parcels.map((parcel) => parcel.id),
        ),
      ),
    )
    .orderBy(asc(storefrontShipmentEvents.occurredAt));
  return parcels.flatMap((parcel) => {
    const steps = events
      .filter((event) => event.shipmentId === parcel.id)
      .flatMap((event) =>
        event.status === null
          ? []
          : [{ status: event.status, at: event.at.toISOString(), note: event.note }],
      )
      // The newest 100, as the contract allows
      .slice(-100);
    // A booked parcel always has its booking's step; one without (cannot happen) is not shown
    // rather than breaking the contract's "at least one event"
    return parcel.trackingCode === null || steps.length === 0
      ? []
      : [
          {
            courier: parcel.courier,
            trackingCode: parcel.trackingCode,
            trackingUrl: parcel.trackingUrl,
            events: steps,
          },
        ];
  });
}
```

- **Every column named,** because `omnivo_shop` may read only the columns 0078 grants: a `select()` of the whole row
  would ask for the COD amount and fail.
- **The restrictive policies leave out** a parcel still booking or failed and a notice we could not read, whatever
  this query asks (mine 27). A parcel with no step (cannot happen) is left out rather than break the contract's "at
  least one".

```diff
@@ -39,6 +39,7 @@ import { lockedCoupon, markOrdered, usedByPhone } from '../coupon-sql.js';
 import { GatewayAccounts } from '../gateway-accounts.js';
 import { checkoutSettingsOf, quotedListings } from '../public-storefront.service.js';
 import { quoteCart } from '../quote.js';
+import { shopShipmentsOf } from '../shipping/shop-shipments.js';
 import { ShopDb, type ShopScope } from '../shop-db.js';
 import { shopUrl } from '../shop-url.js';
 import { confirmPendingOrder } from './confirm-order.js';
@@ -592,7 +593,11 @@ export class ShopOrdersService {
             ),
           );
         if (order === undefined) throw notFound('Order');
-        return trackingOf(order, await this.linesOf(tx, shop, order.id));
+        return trackingOf(
+          order,
+          await this.linesOf(tx, shop, order.id),
+          await shopShipmentsOf(tx, shop.tenantId, order.id),
+        );
       },
       { readOnly: true },
     );
@@ -627,7 +632,11 @@ export class ShopOrdersService {
           );
         return order === undefined
           ? null
-          : trackingOf(order, await this.linesOf(tx, shop, order.id));
+          : trackingOf(
+              order,
+              await this.linesOf(tx, shop, order.id),
+              await shopShipmentsOf(tx, shop.tenantId, order.id),
+            );
       },
       { readOnly: true },
     );
```

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/api exec tsc --noEmit -p .
pnpm --filter @omnivo/api test
pnpm --filter @omnivo/contracts test
pnpm --filter @omnivo/i18n test
pnpm --filter @omnivo/shop typecheck
pnpm exec eslint apps/api/src packages/contracts/src/errors.ts packages/db/src/schema/outbox-events.ts
pnpm exec prettier --check apps/api/src packages/contracts/src packages/i18n/src
pnpm boundaries
```

All pass: API 244 unit tests (21 new: the couriers, the seal's table, the config, the COD amount, the tracking
parcels), contracts 681, i18n 21, the shop's type check, no boundary violation. The app does not type-check until
28a.6 (28a.1's notification and pack form).

The storefront order suites (`apps/api/src/storefront/orders`, 113 tests), the invoices and the outbox relay
(`sales/invoices`, `worker`) still pass. The first run of the order suites failed in 10 tests with one cause: 28a.1
made Packed's `courierAccountId` required (mine 36).

A throwaway run on the real stack with the fake courier (not part of the repo; 28a.4 writes the real tests) went
through: a Steadfast account answering its token once and its webhook address; a manual account refused as the
default and at Packed; Packed booking through the worker (`attempts` 1, a `FAKE…` code, the invoice the order
number); the webhook refusing no token and a wrong one with 401; `pending` shipping the order and sending the SMS;
the same notice twice kept once, a note-only notice and an unreadable one kept; `delivered` delivering the order with
a posted invoice; the tracking page showing the parcel's four steps; the poll running without moving anything. A
second order: refused keys failing at once (`courier_rejected_keys`), "Needs attention" on the order and in the
list, the bell, Book again, then a manual Paperfly parcel as parcel 2 (`W-…-2`) with its code upper-cased, and Mark
shipped making it `picked_up`. A third: Packed without booking, in the export with its amount, Book courier, then
the cancel cancelling the booked parcel; archiving the default leaving no default.

Broken on purpose, each caught by that run:

- the token comparison dropped (any token of the right length passes): a wrong token answers 200;
- the step's key made from the clamped time: the same notice twice is two steps.

That run found three bugs, fixed above: the correlated subqueries without their table (no "Needs attention"), a
courier time in the future putting the next steps before it (mine 32), and the clamp making the same notice two
rows (the key now uses the courier's own time).

## 28a.4 — Tests

28a.3 was checked by one throwaway smoke test. This part replaces it with real tests: a new integration file for
Shop couriers and for everything an order's parcel goes through, and a new tenant-leak file. Both run against the
real stack: Postgres, Redis, Mailpit, the API and the worker, on the fake courier (`COURIER_MODE`'s default outside
production). No Steadfast key was used: the real Steadfast API was not called in this part either.

No bug of 28a.3 was found here. Every failure while writing the tests was a mistake in a test, fixed in the test:
a notice with no time counts at the moment it arrives (so it came after a "delivered" sent a second earlier), and
the bell rang for two people because an earlier test's member may book too.

Mine, made while writing this part:

40. **A test changes what the courier answers by spying on the worker's own fake courier.** The booking job and the
    poll look up `couriers[provider]` on every call, so `vi.spyOn(courier, 'book')` on the worker's instance changes
    the next answer, and `vi.restoreAllMocks()` after each test gives the fake its own answers back. A second test
    adapter class would copy the fake's answers, and the fake's own code (the invoice's hash, the refused phone)
    would then not be what the tests run.
41. **The export's 500-row limit is not tested.** The contract's `max(500)` and the `more` flag are one line each;
    a test would need 501 packed orders, which takes minutes on this stack for one comparison.

### A fast courier retry in the tests

```diff
@@ -50,7 +50,7 @@ export async function createTestApp(config: Config): Promise<NestFastifyApplicat
 }
 
 // The worker's config, checked like production's, but fast: the relay looks every 50 ms and a
-// failed job gives up after 2 quick tries, so a test waits well under a second for either. With
+// failed job (an email, a booking) gives up after 2 quick tries, so a test waits well under a second for either. With
 // no mailUrl the SMTP address is dead (port 1): every send fails at once, which is how the tests
 // see "Email not sent". No storageUrl: the same dead address, for tests that write no files.
 export function testWorkerConfig(urls: {
@@ -76,6 +76,9 @@ export function testWorkerConfig(urls: {
     ...config,
     relay: { ...config.relay, idleMs: 50, publishTimeoutMs: 500 },
     retry: { attempts: 2, backoffMs: 50 },
+    // Step 28a: a booking's tries too, so a parcel the courier never answers fails in well under a
+    // second, not after the 15 minutes of production's five tries
+    courierRetry: { attempts: 2, backoffMs: 50 },
   };
 }
 
```

The worker's test config already makes failed jobs retry fast. 28a.3 gave the couriers' queue its own tries
(`courierRetry`, five tries a minute or more apart), which the test config did not change. Without this line, a
test of a courier that does not answer would wait 15 minutes for the parcel to fail. With it, two tries 50 ms
apart: the first try, one retry, then `onGiveUp`.

### The courier tests

The file is long, so it is shown in parts. First the helpers for the accounts:

```ts
import { createHash } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierExportSchema,
  courierSetupSchema,
  invoiceSchema,
  memberPageSchema,
  type PermissionKey,
  roleSchema,
  type ShopShipment,
  shopTrackingSchema,
  type StorefrontOrder,
  storefrontOrderPageSchema,
  storefrontOrderSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Config, ShippingConfig } from '../../config.js';
import { COURIERS, SHIPPING_CONFIG } from '../../infra/tokens.js';
import type { CourierAdapter, CourierAdapters } from '../../shipping/courier.js';
import { FAKE_REFUSED_PHONE, FakeCourier } from '../../shipping/fake-courier.js';
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
  type OrderShop,
  orderRequest,
  orderShop,
  phoneOf,
  placeOrder,
  shopHeaders,
  shopPost,
  smsAddress,
  trackingTokenFor,
} from '../../testing/shop-orders.js';
import { joinWithoutRoles } from '../../testing/workspace.js';
import { openKeys } from './courier-keys.js';
import { ShipmentPoll } from './shipment-poll.js';

// Step 28a: Shop couriers and a shop order's parcels, on the real stack: Postgres, Redis, Mailpit,
// the API and the worker, with the fake courier (COURIER_MODE's default outside production). The
// fake answers like Steadfast from the invoice alone; where a test needs another answer (a lost
// one, a parcel the courier has already, a status for the poll), it spies on the worker's own
// adapter (`courier`), which the booking job and the poll look up on every call.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let config: Config;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
let shop: OrderShop;
let courier: CourierAdapter;
// The accounts most tests use, made by the first tests and kept up to date by them
let steadfast: CourierAccount;
let steadfastToken: string;
let manual: CourierAccount;

const API_KEY = 'sf-api-7k2m9q4x';
const SECRET_KEY = 'sf-secret-4n8p1x6w';

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];

function send(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, who = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function accountOf(id: string): Promise<CourierAccount> {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found;
}

async function addAccount(body: object) {
  const res = await send('POST', '/storefront/couriers', body);
  expect(res.statusCode, res.body).toBe(201);
  return courierAccountSavedSchema.parse(res.json());
}

async function defaultOf(): Promise<string | null> {
  return courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json())
    .defaultAccountId;
}

// The account's row as the database keeps it: the sealed box in hex, so a test can compare it
// before and after a save
const accountRowSchema = z.object({
  sealed: z.string().nullable(),
  key_version: z.number().nullable(),
  webhook_token_hash: z.string().nullable(),
  is_default: z.boolean(),
  last_webhook_at: z.date().nullable(),
});
async function accountRow(id: string) {
  const [row] = z.array(accountRowSchema).parse(
    await sql`
      SELECT encode(keys_sealed, 'hex') AS sealed, key_version, webhook_token_hash, is_default,
        last_webhook_at
      FROM courier_accounts WHERE id = ${id}`,
  );
  if (row === undefined) throw new Error(`no courier account row ${id}`);
  return row;
}

// The two keys as this server opens them, read with the API's own config
async function keysOf(id: string) {
  const [row] = z
    .array(
      z.object({
        tenant_id: z.string(),
        keys_sealed: z.instanceof(Buffer).nullable(),
        key_version: z.number().nullable(),
      }),
    )
    .parse(
      await sql`SELECT tenant_id::text, keys_sealed, key_version FROM courier_accounts WHERE id = ${id}`,
    );
  if (row === undefined) throw new Error(`no courier account row ${id}`);
  return openKeys(app.get<ShippingConfig>(SHIPPING_CONFIG).credentialsKey, {
    tenantId: row.tenant_id,
    keysSealed: row.keys_sealed,
    keyVersion: row.key_version,
  });
}

// Every audit row of courier accounts, its whole payload as text
async function accountAudit() {
  return z.array(z.object({ action: z.string(), text: z.string() })).parse(
    await sql`
      SELECT action, payload::text AS text FROM audit_logs
      WHERE tenant_id = ${shop.tenantId} AND entity_type = 'courier_account'
      ORDER BY created_at, id`,
  );
}
```

- **`courier`** is the worker's own adapter for Steadfast (`worker.get<CourierAdapters>(COURIERS)`), the fake one.
  Mine 40 says why the tests spy on it rather than replace it. The API has its own copy (for "Test connection" and
  the webhook), which no test changes: those two use the fake as it is.
- **`steadfast`, `steadfastToken` and `manual`** are made by the first test and kept up to date by the tests that
  change them (a new version, a new token). The tests in this file run in order and share them, like 27d's
  gateway. A test run alone with `-t` therefore fails: run the whole file.
- **`accountRow()`** reads the sealed box in hex, so a test can compare it before and after a save, and the
  webhook token's hash. **`keysOf()`** opens the box with the API's own key (`SHIPPING_CONFIG`), the way the
  booking job does. It is the only way a test can see that an empty box kept the other key: the account's answer
  never has a key.
- **`accountAudit()`** reads each audit row's whole `payload` as text, so a test can check that no key and no
  token is anywhere in it, under any field.

```ts
async function getOrder(id: string): Promise<StorefrontOrder> {
  const res = await send('GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

interface Confirmed {
  id: string;
  orderNo: string;
  phone: string;
  // The tracking link's token, from the confirm SMS
  token: string;
  // The shopper's address, for the tracking page's limits
  client: number;
}

// An order placed, confirmed with its phone code, and given its sales order by the worker: ready
// to pack. n picks the phone and the shopper's address, so no two tests share them
async function confirm(n: number, phone = phoneOf(n)): Promise<Confirmed> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TOTAL));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const tracking = await trackingTokenFor(mail.apiUrl, phone);
  const [row] = z.array(z.object({ id: z.uuid(), order_no: z.string() })).parse(
    await sql`SELECT id::text, order_no FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  await eventually(async () => {
    expect((await getOrder(row.id)).salesOrder).not.toBeNull();
  });
  return { id: row.id, orderNo: row.order_no, phone, token: tracking, client: n };
}

// Packed, with a courier account or none (''). Answers the order as the Packed dialog gets it
async function pack(id: string, courierAccountId: string) {
  const order = await getOrder(id);
  return send('POST', `/storefront/orders/${id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId,
  });
}
async function packed(id: string, courierAccountId: string): Promise<StorefrontOrder> {
  const res = await pack(id, courierAccountId);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// Waits until the order's newest parcel is in `status` (the worker books a moment later)
async function parcelIs(id: string, status: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(id);
    expect(order.shipments.at(-1)?.status).toBe(status);
    return order;
  });
}

function lastParcel(order: StorefrontOrder) {
  const parcel = order.shipments.at(-1);
  if (parcel === undefined) throw new Error(`order ${order.id} has no parcel`);
  return parcel;
}

// "Book courier" on the order page
function bookCourier(order: StorefrontOrder, accountId: string, trackingCode = '') {
  return send('POST', `/storefront/orders/${order.id}/shipments`, {
    version: order.version,
    accountId,
    trackingCode,
  });
}

function retry(order: StorefrontOrder, shipmentId: string) {
  return send('POST', `/storefront/orders/${order.id}/shipments/${shipmentId}/retry`, {
    version: order.version,
  });
}

async function move(order: StorefrontOrder, step: 'ship' | 'deliver' | 'cancel') {
  return send(
    'POST',
    `/storefront/orders/${order.id}/${step}`,
    step === 'cancel' ? { version: order.version, reason: '' } : { version: order.version },
  );
}

// The courier's webhook, as Steadfast's panel sends it
function webhook(accountId: string, token: string | null, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${accountId}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body,
  });
}
async function notice(body: object): Promise<void> {
  const res = await webhook(steadfast.id, steadfastToken, body);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ status: 'success', message: 'Received' });
}

// A Steadfast delivery_status body about one parcel. Its time is Steadfast's own form, in Dhaka
function statusNotice(consignmentId: string, status: string, message: string, at: string) {
  return {
    notification_type: 'delivery_status',
    consignment_id: Number(consignmentId),
    status,
    tracking_message: message,
    updated_at: at,
  };
}

// A moment as Steadfast writes it ("2026-11-23 14:05:09", Dhaka time, UTC+6)
function steadfastAt(at: Date): string {
  return new Date(at.getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Steadfast's times have whole seconds, and a step is never before its parcel's booking (the API
// keeps it between the booking and now). Waiting for the next second makes "now" in Steadfast's
// form later than the booking, so the steps keep the times the test gives them
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_010 - (Date.now() % 1_000)));
}

const eventRowSchema = z.object({
  status: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string(),
  raw: z.unknown(),
});
async function eventRows(shipmentId: string) {
  return z.array(eventRowSchema).parse(
    await sql`SELECT status, note, source, raw FROM storefront_shipment_events
      WHERE shipment_id = ${shipmentId} ORDER BY occurred_at, received_at, id`,
  );
}

// The tracking page, as the shop's server asks for it (as omnivo_shop)
async function trackingOf(order: Confirmed): Promise<ShopShipment[]> {
  const res = await shopPost(
    app,
    '/tracking',
    shopHeaders(shop.host, clientAddress(order.client)),
    {
      token: order.token,
    },
  );
  expect(res.statusCode, res.body).toBe(200);
  return shopTrackingSchema.parse(res.json()).shipments;
}

// The SMS to one phone, newest first (Mailpit lists 50 at a time by default; its snippet holds
// a whole SMS)
const mailboxSchema = z.object({
  messages: z.array(
    z.object({ To: z.array(z.object({ Address: z.string() })), Snippet: z.string() }),
  ),
});
async function smsTo(phone: string): Promise<string[]> {
  const res = await fetch(`${mail.apiUrl}/api/v1/messages?limit=1000`);
  const { messages } = mailboxSchema.parse(await res.json());
  return messages
    .filter((message) => message.To.some((to) => to.Address === smsAddress(phone)))
    .map((message) => message.Snippet);
}
const ON_ITS_WAY = 'is on its way with Steadfast';

async function bellsFor(orderId: string) {
  return z.array(z.object({ params: z.record(z.string(), z.unknown()) })).parse(
    await sql`SELECT params FROM notifications
      WHERE type = 'storefront.shipment_failed' AND params->>'id' = ${orderId}`,
  );
}

// A member of Nirvor with exactly these permissions (27b's helper)
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

// Sends requests "at the same moment" for sure, and in a known order (27c's gate): a transaction
// of the test's own locks `table` in SHARE mode, and the next request is sent only once the one
// before it waits
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
  courier = worker.get<CourierAdapters>(COURIERS).steadfast;
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
}, 240_000);

afterEach(() => {
  // Every spy on the worker's courier goes back to the fake's own answers
  vi.restoreAllMocks();
});

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});
```

- **`confirm()`** places an order of two face washes (৳538), types the phone code, and waits for the worker's sales
  order: the order can be packed then. It gives back the order number, the phone, and the tracking token from the
  confirm SMS. `n` picks the phone and the shopper's address, so no two tests share either: the shop's limits count
  per phone and per address across the whole API. The phone can be given instead: the fake courier refuses
  `FAKE_REFUSED_PHONE`.
- **`pack()`** sends Packed with a courier account, or `''` for "Don't book now". **`parcelIs()`** waits until the
  order's newest parcel is in a status: the worker books a moment after Packed has answered.
- **`notice()`** posts a webhook with the account's token and expects Steadfast's `success` answer.
  **`statusNotice()`** is a Steadfast `delivery_status` body; **`steadfastAt()`** writes a time the way Steadfast
  does (`2026-11-23 14:05:09`, Dhaka time).
- **`nextSecond()`** waits until the clock is in the next second. Steadfast's times have whole seconds, and the API
  keeps a step between the parcel's booking and now (28a.3's clamp). Right after a booking, "now" written in whole
  seconds is often a little before the booking, and every step would be moved to the booking's moment. After the
  wait, the steps keep the times the test gives them.
- **`eventRows()`** reads a parcel's events in SQL, with the columns the order page leaves out: where each came from
  (`source`) and the body kept for one nobody could read (`raw`).
- **`trackingOf()`** asks for the tracking page the way the shop's server does, so it reads as `omnivo_shop`.
- **`smsTo()`** lists the SMS to a phone from Mailpit, up to 1,000 messages (Mailpit lists 50 by default). An SMS is
  short, so Mailpit's snippet holds all of it.
- **`bellsFor()`** reads the bell rows of `storefront.shipment_failed` for one order.
- **`member()`** and **`inTurn()`** are 27b's and 27c's helpers: a member with exactly some permissions, and a gate
  that sends requests "at the same moment" in a known order.

The shop has one product, Neem Face Wash, with 200 pieces: every test's order takes two.

```ts
describe('Shop couriers', () => {
  it('adds an API account with its webhook token once, and keeps its keys sealed', async () => {
    const saved = await addAccount({
      provider: 'steadfast',
      name: 'Steadfast',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
    });
    expect(saved.account).toMatchObject({
      provider: 'steadfast',
      courier: 'steadfast',
      status: 'active',
      webhookUrl: `http://localhost:3000/public/v1/couriers/steadfast/${saved.account.id}`,
      hasWebhookToken: true,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
    });
    expect(saved.webhookToken).toMatch(/^[\w-]{22}$/);
    steadfast = saved.account;
    steadfastToken = saved.webhookToken ?? '';

    // The page never answers a key or the token again
    const page = await send('GET', '/storefront/couriers');
    for (const secret of [API_KEY, SECRET_KEY, steadfastToken])
      expect(page.body).not.toContain(secret);
    // The database keeps one sealed box of both keys, and the token's hash only
    const row = await accountRow(steadfast.id);
    for (const secret of [API_KEY, SECRET_KEY]) {
      expect(row.sealed).not.toContain(Buffer.from(secret).toString('hex'));
    }
    expect(row.webhook_token_hash).toBe(createHash('sha256').update(steadfastToken).digest('hex'));
    expect(row.key_version).toBe(1);
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    // The audit row says "changed", never a value
    const audit = await accountAudit();
    expect(audit.map((entry) => entry.action)).toEqual(['courier_account.created']);
    expect(audit[0]?.text).toContain('changed');
    for (const secret of [API_KEY, SECRET_KEY, steadfastToken]) {
      expect(audit[0]?.text).not.toContain(secret);
    }

    // A manual account: a name and a courier, no keys, no webhook
    const byHand = await addAccount({ provider: 'manual', name: 'RedX by hand', courier: 'redx' });
    expect(byHand.webhookToken).toBeNull();
    expect(byHand.account).toMatchObject({
      provider: 'manual',
      courier: 'redx',
      webhookUrl: null,
      hasWebhookToken: false,
    });
    manual = byHand.account;
    expect((await accountRow(manual.id)).sealed).toBeNull();
  });

  it('keeps a key whose box is left empty, clears the last test with new keys, and keeps the provider', async () => {
    // Test connection: an answer, not a change of the form's version
    const tested = courierAccountSchema.parse(
      (await send('POST', `/storefront/couriers/${steadfast.id}/test`)).json(),
    );
    expect(tested.lastTest?.problem).toBeNull();
    expect(tested.version).toBe(steadfast.version);
    const sealed = (await accountRow(steadfast.id)).sealed;

    // Both boxes empty: the keys stay, so does the last test
    const renamed = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      name: 'Steadfast Mirpur',
      apiKey: '',
      secretKey: '',
      version: tested.version,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(courierAccountSchema.parse(renamed.json())).toMatchObject({
      name: 'Steadfast Mirpur',
      version: tested.version + 1,
      lastTest: { problem: null },
    });
    expect((await accountRow(steadfast.id)).sealed).toBe(sealed);

    // A form opened before that save
    const stale = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      name: 'Steadfast',
      apiKey: '',
      secretKey: '',
      version: tested.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'version_conflict' });

    // Only the API key: the secret key comes from the saved box, in a new box
    const newKey = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      name: 'Steadfast Mirpur',
      apiKey: 'fake_rejected',
      secretKey: '',
      version: tested.version + 1,
    });
    expect(newKey.statusCode, newKey.body).toBe(200);
    expect(courierAccountSchema.parse(newKey.json()).lastTest).toBeNull();
    expect((await accountRow(steadfast.id)).sealed).not.toBe(sealed);
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: 'fake_rejected', secretKey: SECRET_KEY });
    const refused = courierAccountSchema.parse(
      (await send('POST', `/storefront/couriers/${steadfast.id}/test`)).json(),
    );
    expect(refused.lastTest?.problem).toBe('rejected');

    // The same keys typed again are no change: same box, and the last test stays
    const sealedNow = (await accountRow(steadfast.id)).sealed;
    const same = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      name: 'Steadfast Mirpur',
      apiKey: 'fake_rejected',
      secretKey: SECRET_KEY,
      version: refused.version,
    });
    expect(courierAccountSchema.parse(same.json()).lastTest?.problem).toBe('rejected');
    expect((await accountRow(steadfast.id)).sealed).toBe(sealedNow);

    // Back to the good keys for the tests after this one
    const back = await send('PUT', `/storefront/couriers/${steadfast.id}`, {
      provider: 'steadfast',
      name: 'Steadfast',
      apiKey: API_KEY,
      secretKey: '',
      version: refused.version + 1,
    });
    expect(back.statusCode, back.body).toBe(200);
    steadfast = courierAccountSchema.parse(back.json());
    expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    // In the audit log, "keys" only where keys were sealed: the account's creation and the two
    // saves with a new key
    const audit = await accountAudit();
    expect(audit.filter((entry) => entry.text.includes('"keys"'))).toHaveLength(3);
    for (const entry of audit) {
      for (const secret of [API_KEY, SECRET_KEY]) expect(entry.text).not.toContain(secret);
    }

    // A manual account stays manual, and has nothing to test
    const fixed = await send('PUT', `/storefront/couriers/${manual.id}`, {
      provider: 'steadfast',
      name: 'RedX by hand',
      apiKey: API_KEY,
      secretKey: SECRET_KEY,
      version: manual.version,
    });
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json()).toMatchObject({ code: 'courier_provider_fixed' });
    const notTestable = await send('POST', `/storefront/couriers/${manual.id}/test`);
    expect(notTestable.statusCode).toBe(422);
    expect(notTestable.json()).toMatchObject({ code: 'courier_account_not_bookable' });
    const otherCourier = await send('PUT', `/storefront/couriers/${manual.id}`, {
      provider: 'manual',
      name: 'Paperfly by hand',
      courier: 'paperfly',
      version: manual.version,
    });
    expect(otherCourier.statusCode, otherCourier.body).toBe(200);
    manual = courierAccountSchema.parse(otherCourier.json());
    expect(manual.courier).toBe('paperfly');
  });

  it('keeps one default: an active API account, never a manual or an archived one', async () => {
    expect(await defaultOf()).toBeNull();
    const set = await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    expect(set.statusCode, set.body).toBe(200);
    expect(courierSetupSchema.parse(set.json()).defaultAccountId).toBe(steadfast.id);
    const byHand = await send('PUT', '/storefront/couriers', { accountId: manual.id });
    expect(byHand.statusCode).toBe(422);
    expect(byHand.json()).toMatchObject({
      code: 'courier_account_not_bookable',
      fieldErrors: { accountId: ['courier_account_not_bookable'] },
    });

    // A second API account takes the flag from the first, in one UPDATE
    const spare = (
      await addAccount({
        provider: 'steadfast',
        name: 'Steadfast spare',
        apiKey: 'k2',
        secretKey: 's2',
      })
    ).account;
    await send('PUT', '/storefront/couriers', { accountId: spare.id });
    expect(await defaultOf()).toBe(spare.id);
    const [flags] = await sql`SELECT count(*)::int AS n FROM courier_accounts
      WHERE tenant_id = ${shop.tenantId} AND is_default`;
    expect(flags?.n).toBe(1);

    // Archived: no longer the default, and cannot become it
    const archived = await send('POST', `/storefront/couriers/${spare.id}/archive`, {
      version: spare.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(await defaultOf()).toBeNull();
    expect((await send('PUT', '/storefront/couriers', { accountId: spare.id })).statusCode).toBe(
      422,
    );
    // A second archive (another tab) changes nothing
    const again = await send('POST', `/storefront/couriers/${spare.id}/archive`, {
      version: courierAccountSchema.parse(archived.json()).version,
    });
    expect(again.statusCode).toBe(200);
    const restored = courierAccountSchema.parse(
      (
        await send('POST', `/storefront/couriers/${spare.id}/restore`, {
          version: courierAccountSchema.parse(archived.json()).version,
        })
      ).json(),
    );
    expect(restored.status).toBe('active');
    const edit = await send('PUT', `/storefront/couriers/${spare.id}`, {
      provider: 'steadfast',
      name: 'Steadfast spare',
      apiKey: '',
      secretKey: '',
      version: restored.version,
    });
    expect(edit.statusCode).toBe(200);
    const spareNow = courierAccountSchema.parse(edit.json());

    // "Use as default" and Archive at the same moment, both ways round. The second always sees
    // the first: the default goes with the archive, or the archived account is refused
    const [first, second] = await inTurn('courier_accounts', [
      () => send('PUT', '/storefront/couriers', { accountId: spare.id }),
      () => send('POST', `/storefront/couriers/${spare.id}/archive`, { version: spareNow.version }),
    ]);
    expect([first?.statusCode, second?.statusCode]).toEqual([200, 200]);
    expect(await defaultOf()).toBeNull();
    const archivedAgain = await accountOf(spare.id);
    const back = courierAccountSchema.parse(
      (
        await send('POST', `/storefront/couriers/${spare.id}/restore`, {
          version: archivedAgain.version,
        })
      ).json(),
    );
    const [archive, setDefault] = await inTurn('courier_accounts', [
      () => send('POST', `/storefront/couriers/${spare.id}/archive`, { version: back.version }),
      () => send('PUT', '/storefront/couriers', { accountId: spare.id }),
    ]);
    expect(archive?.statusCode).toBe(200);
    expect(setDefault?.statusCode).toBe(422);
    expect(await defaultOf()).toBeNull();

    // None, then the first account again for the tests after this one
    await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    const none = await send('PUT', '/storefront/couriers', { accountId: '' });
    expect(courierSetupSchema.parse(none.json()).defaultAccountId).toBeNull();
    await send('PUT', '/storefront/couriers', { accountId: steadfast.id });
    expect(await defaultOf()).toBe(steadfast.id);
  });

  it('renews the webhook token: the old one stops at once', async () => {
    const body = { notification_type: 'delivery_status', invoice: 'W-999999', status: 'pending' };
    expect((await webhook(steadfast.id, steadfastToken, body)).statusCode).toBe(200);
    const res = await send('POST', `/storefront/couriers/${steadfast.id}/webhook-token`, {
      version: steadfast.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const renewed = courierAccountSavedSchema.parse(res.json());
    expect(renewed.webhookToken).toMatch(/^[\w-]{22}$/);
    expect(renewed.account.version).toBe(steadfast.version + 1);
    const old = await webhook(steadfast.id, steadfastToken, body);
    expect(old.statusCode).toBe(401);
    expect(old.json()).toMatchObject({ code: 'courier_webhook_token_invalid' });
    steadfastToken = renewed.webhookToken ?? '';
    steadfast = renewed.account;
    expect((await webhook(steadfast.id, steadfastToken, body)).statusCode).toBe(200);
    // A manual account has no webhook
    const byHand = await send('POST', `/storefront/couriers/${manual.id}/webhook-token`, {
      version: manual.version,
    });
    expect(byHand.statusCode).toBe(422);
  });

  it("needs CREDENTIALS_KEY for an API account's keys, never for a manual one", async () => {
    const keyless = await createTestApp({
      ...config,
      payments: { ...config.payments, credentialsKey: null },
      shipping: { ...config.shipping, credentialsKey: null },
    });
    try {
      const as = (method: 'POST' | 'PUT', url: string, payload: object) =>
        keyless.inject({ method, url, headers: bearer(owner.accessToken), payload });
      const [before] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
      const added = await as('POST', '/storefront/couriers', {
        provider: 'steadfast',
        name: 'Steadfast Sylhet',
        apiKey: 'k3',
        secretKey: 's3',
      });
      expect(added.statusCode).toBe(422);
      expect(added.json()).toMatchObject({ code: 'courier_key_missing' });
      const [after] = await sql`SELECT count(*)::int AS n FROM courier_accounts`;
      expect(after?.n).toBe(before?.n);
      const byHand = await as('POST', '/storefront/couriers', {
        provider: 'manual',
        name: 'eCourier by hand',
        courier: 'ecourier',
      });
      expect(byHand.statusCode, byHand.body).toBe(201);

      // A new key needs it; a name change with both boxes empty does not
      const current = await accountOf(steadfast.id);
      const typed = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
        provider: 'steadfast',
        name: 'Steadfast',
        apiKey: 'k4',
        secretKey: '',
        version: current.version,
      });
      expect(typed.json()).toMatchObject({ code: 'courier_key_missing' });
      const named = await as('PUT', `/storefront/couriers/${steadfast.id}`, {
        provider: 'steadfast',
        name: 'Steadfast',
        apiKey: '',
        secretKey: '',
        version: current.version,
      });
      expect(named.statusCode, named.body).toBe(200);
      steadfast = courierAccountSchema.parse(named.json());
      // The keys cannot be opened, so they cannot reach the courier: refused
      const tested = await as('POST', `/storefront/couriers/${steadfast.id}/test`, {});
      expect(courierAccountSchema.parse(tested.json()).lastTest?.problem).toBe('rejected');
      expect(await keysOf(steadfast.id)).toEqual({ apiKey: API_KEY, secretKey: SECRET_KEY });
    } finally {
      await keyless.close();
    }
  });

  it('gives the accounts to storefront.manage only', async () => {
    const packer = await member('rafiq@nirvor.com', 'Rafiq Islam', [
      'storefront.order.read',
      'storefront.order.manage',
    ]);
    for (const [method, url, body] of [
      ['GET', '/storefront/couriers', undefined],
      ['POST', '/storefront/couriers', { provider: 'manual', name: 'RedX', courier: 'redx' }],
      ['PUT', '/storefront/couriers', { accountId: '' }],
      ['POST', `/storefront/couriers/${steadfast.id}/test`, undefined],
    ] as const) {
      expect((await send(method, url, body, packer)).statusCode).toBe(403);
    }
  });
});
```

Shop couriers, in the order a workspace goes through it.

- **An API account.** The answer has the webhook address on the API's own address and a 22-character token; the
  page never answers the token or a key again. The row keeps one sealed box (neither key's bytes are in it) and the
  token's SHA-256 only. The audit row says "changed", never a value. A manual account has no keys, no address and
  no token.
- **Changes.** "Test connection" answers without moving the form's version. Both key boxes empty keep the box as it
  was, and keep the last test. A form opened before that save is refused (`version_conflict`). Only a new API key:
  the box is sealed again with the saved secret key in it (`keysOf()` shows both), and the last test is cleared,
  because it said something about the old keys. `fake_rejected` makes the fake courier refuse them. The same keys
  typed again are no change. In the audit log, "keys" appears three times: the creation and the two saves with a
  new key. A manual account cannot become a Steadfast one (`courier_provider_fixed`), has nothing to test
  (`courier_account_not_bookable`), and can change its courier.
- **The default.** A manual account is refused, under `accountId`. A second API account takes the flag from the
  first, and the table never has two. Archiving the default leaves no default, and an archived account cannot
  become one. A second archive changes nothing. Then "Use as default" and Archive at the same moment, both ways
  round, with the gate on `courier_accounts`. Default first: it holds the account's row, Archive waits for it, then
  archives and takes the flag with it, so both answer 200 and there is no default. Archive first: "Use as default"
  waits for the row, then reads it archived and is refused (422). Either way, no archived account is the default.
- **A new token** stops the old one at once (401 `courier_webhook_token_invalid`); a manual account has no token
  to renew.
- **No `CREDENTIALS_KEY`.** A second API in the same file, with both `payments` and `shipping` keyless (27d's
  decision 45). A new API account is refused with `courier_key_missing` and writes no row; a manual one is saved. A
  name change with both key boxes empty needs no key; a new key does. "Test connection" says `rejected`: keys this
  server cannot open cannot reach the courier.
- **Permissions.** A packer with `storefront.order.manage` but not `storefront.manage` gets 403 on the accounts.

```ts
describe('booking a parcel', () => {
  it('books at Packed in the worker, with the order number as its invoice', async () => {
    const book = vi.spyOn(courier, 'book');
    const order = await confirm(900);
    const before = await getOrder(order.id);
    expect(before.codAmount).toBe('538.0000');
    expect(before.shipments).toEqual([]);
    // A manual account cannot book at Packed: nothing would call it
    const byHand = await pack(order.id, manual.id);
    expect(byHand.statusCode).toBe(422);
    expect(byHand.json()).toMatchObject({
      fieldErrors: { courierAccountId: ['courier_account_not_bookable'] },
    });

    const answer = await packed(order.id, steadfast.id);
    expect(answer.shipments).toMatchObject([
      { status: 'booking', codAmount: '538.0000', attempts: 0, events: [] },
    ]);
    const booked = await parcelIs(order.id, 'booked');
    const parcel = lastParcel(booked);
    expect(parcel).toMatchObject({
      account: { id: steadfast.id, name: 'Steadfast', provider: 'steadfast' },
      courier: 'steadfast',
      attempts: 1,
      error: null,
    });
    expect(parcel.trackingCode).toMatch(/^FAKE[0-9A-F]{10}$/);
    expect(parcel.consignmentId).toMatch(/^\d+$/);
    expect(parcel.bookedAt).not.toBeNull();
    expect(parcel.events.map((event) => event.status)).toEqual(['booked']);
    expect((await eventRows(parcel.id)).map((row) => row.source)).toEqual(['booking']);
    // What the courier was told: our number, the zone in the address, two decimals, no product
    expect(book).toHaveBeenCalledTimes(1);
    expect(book.mock.calls[0]?.[1]).toEqual({
      invoice: order.orderNo,
      name: 'Nusrat Jahan',
      phone: order.phone,
      address: 'House 12, Road 5, Mirpur 10, Dhaka, Inside Dhaka',
      codAmount: '538.00',
      note: '2 items',
    });
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${parcel.id}`;
    expect(row?.invoice).toBe(order.orderNo);
    // One parcel on its way at a time
    const second = await bookCourier(booked, steadfast.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'storefront_order_has_parcel' });
    // Packed's audit row names the account
    const [audit] = await sql`SELECT payload::text AS text FROM audit_logs
      WHERE entity_id = ${order.id} AND action = 'storefront_order.shipment_booked'`;
    expect(audit?.text).toContain('Steadfast');
  });

  it('waits for a booking before it cancels, then cancels the booked parcel with its order', async () => {
    const fake = new FakeCourier();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(courier, 'book').mockImplementationOnce(async (keys, request) => {
      await held;
      return fake.book(keys, request);
    });
    const order = await confirm(901);
    try {
      await packed(order.id, steadfast.id);
      // The worker has the parcel: its try is counted, and the courier has not answered
      await eventually(async () => {
        const [row] =
          await sql`SELECT attempts FROM storefront_shipments WHERE order_id = ${order.id}`;
        expect(row?.attempts).toBe(1);
      });
      const booking = await getOrder(order.id);
      const refused = await move(booking, 'cancel');
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'storefront_order_parcel_booking' });
      // The tracking page shows no parcel before the courier has it
      expect(await trackingOf(order)).toEqual([]);
    } finally {
      release();
    }
    const booked = await parcelIs(order.id, 'booked');
    const cancelled = await move(booked, 'cancel');
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const after = storefrontOrderSchema.parse(cancelled.json());
    expect(after.status).toBe('cancelled');
    expect(lastParcel(after).status).toBe('cancelled');
    expect(lastParcel(after).events.map((event) => event.status)).toEqual(['booked', 'cancelled']);
    expect((await eventRows(lastParcel(after).id)).map((row) => row.source)).toEqual([
      'booking',
      'member',
    ]);
  });

  it('asks by the invoice after a lost answer, so the courier never gets two parcels', async () => {
    const book = vi.spyOn(courier, 'book').mockResolvedValueOnce({
      kind: 'problem',
      problem: 'unreachable',
    });
    const find = vi.spyOn(courier, 'find').mockResolvedValueOnce({
      kind: 'found',
      parcel: {
        consignmentId: '880001',
        trackingCode: 'SFLOST0001',
        trackingUrl: 'https://steadfast.com.bd/t/SFLOST0001',
        status: 'booked',
      },
    });
    const order = await confirm(902);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    expect(parcel).toMatchObject({
      consignmentId: '880001',
      trackingCode: 'SFLOST0001',
      attempts: 2,
      error: null,
    });
    expect(book).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0]?.[1]).toBe(order.orderNo);
    // The courier's own page, for the tracking page's link
    expect((await trackingOf(order))[0]?.trackingUrl).toBe('https://steadfast.com.bd/t/SFLOST0001');
  });

  it('asks by the invoice when the courier says it has one, and fails a parcel it cannot match', async () => {
    // "taken": an earlier call got through. Found by the invoice, it is the booking
    vi.spyOn(courier, 'book').mockResolvedValueOnce({ kind: 'taken' });
    vi.spyOn(courier, 'find').mockResolvedValueOnce({
      kind: 'found',
      parcel: {
        consignmentId: '880002',
        trackingCode: 'SFTAKEN002',
        trackingUrl: null,
        status: 'booked',
      },
    });
    const taken = await confirm(903);
    await packed(taken.id, steadfast.id);
    expect(lastParcel(await parcelIs(taken.id, 'booked'))).toMatchObject({
      trackingCode: 'SFTAKEN002',
      attempts: 1,
    });

    // "exists": the courier has the invoice, but its answer has no code. Never booked twice
    vi.spyOn(courier, 'book').mockResolvedValueOnce({ kind: 'problem', problem: 'unreachable' });
    vi.spyOn(courier, 'find').mockResolvedValueOnce({ kind: 'exists' });
    const order = await confirm(904);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    expect(lastParcel(failed)).toMatchObject({ error: 'courier_invoice_taken', attempts: 2 });
    expect(failed.needsAttention).toBe(true);
  });

  it('fails a parcel the courier refused at once, with its words, and rings the bell', async () => {
    const book = vi.spyOn(courier, 'book');
    const order = await confirm(905, FAKE_REFUSED_PHONE);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    expect(lastParcel(failed)).toMatchObject({
      error: 'courier_rejected_parcel',
      errorDetail: 'The recipient phone must be a working mobile number.',
      attempts: 1,
      trackingCode: null,
    });
    // Asking again would get the same answer: one call
    expect(book).toHaveBeenCalledTimes(1);
    const bells = await eventually(async () => {
      const found = await bellsFor(order.id);
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(bells[0]?.params).toEqual({ id: order.id, number: order.orderNo, courier: 'Steadfast' });
    // The tracking page has no parcel to show
    expect(await trackingOf(order)).toEqual([]);
  });

  it('tries an unreachable courier again, then fails the parcel; Book again books the same row', async () => {
    vi.spyOn(courier, 'book').mockResolvedValue({ kind: 'problem', problem: 'unreachable' });
    const order = await confirm(906);
    await packed(order.id, steadfast.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    const parcel = lastParcel(failed);
    expect(parcel).toMatchObject({ error: 'courier_unreachable', attempts: 2 });
    expect(failed.needsAttention).toBe(true);
    const list = storefrontOrderPageSchema.parse(
      (await send('GET', '/storefront/orders?view=packed')).json(),
    );
    expect(list.items.find((item) => item.id === order.id)?.needsAttention).toBe(true);
    // Everyone who may book again: the owner, and Rafiq, the packer of the permissions test
    await eventually(async () => {
      expect(await bellsFor(order.id)).toHaveLength(2);
    });
    const [people] = await sql`SELECT array_agg(u.email ORDER BY u.email) AS emails
      FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = 'storefront.shipment_failed' AND n.params->>'id' = ${order.id}`;
    expect(people?.emails).toEqual(['nusrat@nirvor.com', 'rafiq@nirvor.com']);

    vi.restoreAllMocks();
    const again = await retry(failed, parcel.id);
    expect(again.statusCode, again.body).toBe(200);
    // Booking again, with the last reason still on it for the page
    expect(lastParcel(storefrontOrderSchema.parse(again.json()))).toMatchObject({
      id: parcel.id,
      status: 'booking',
      error: 'courier_unreachable',
    });
    const booked = await parcelIs(order.id, 'booked');
    expect(booked.shipments).toHaveLength(1);
    expect(lastParcel(booked)).toMatchObject({ id: parcel.id, attempts: 3, error: null });
    expect(booked.needsAttention).toBe(false);
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${parcel.id}`;
    expect(row?.invoice).toBe(order.orderNo);
    const notFailed = await retry(booked, parcel.id);
    expect(notFailed.statusCode).toBe(409);
    expect(notFailed.json()).toMatchObject({ code: 'storefront_shipment_not_failed' });
  });

  it("fails a parcel whose keys this server can't open, without calling the courier", async () => {
    const book = vi.spyOn(courier, 'book');
    const sylhet = (
      await addAccount({
        provider: 'steadfast',
        name: 'Steadfast Sylhet',
        apiKey: 'k5',
        secretKey: 's5',
      })
    ).account;
    // This server's key is version 1
    await sql`UPDATE courier_accounts SET key_version = 2 WHERE id = ${sylhet.id}`;
    try {
      const order = await confirm(907);
      await packed(order.id, sylhet.id);
      const failed = await parcelIs(order.id, 'booking_failed');
      expect(lastParcel(failed)).toMatchObject({ error: 'courier_key_missing', attempts: 1 });
      expect(book).not.toHaveBeenCalled();
    } finally {
      await sql`UPDATE courier_accounts SET key_version = 1 WHERE id = ${sylhet.id}`;
    }
  });

  it('books a second parcel after a failure, and keeps Book again for the last one', async () => {
    const old = (
      await addAccount({
        provider: 'steadfast',
        name: 'Steadfast old keys',
        apiKey: 'fake_rejected',
        secretKey: 's6',
      })
    ).account;
    const order = await confirm(908);
    await packed(order.id, old.id);
    const failed = await parcelIs(order.id, 'booking_failed');
    const first = lastParcel(failed);
    expect(first).toMatchObject({ error: 'courier_rejected_keys', attempts: 1 });

    // An archived account books nothing, again or new
    await send('POST', `/storefront/couriers/${old.id}/archive`, { version: old.version });
    const archivedRetry = await retry(failed, first.id);
    expect(archivedRetry.statusCode).toBe(409);
    expect(archivedRetry.json()).toMatchObject({ code: 'courier_account_archived' });
    expect((await bookCourier(failed, old.id)).json()).toMatchObject({
      code: 'courier_account_archived',
    });

    // By hand: the code from the courier's panel is required, and kept in capitals
    const noCode = await bookCourier(failed, manual.id);
    expect(noCode.statusCode).toBe(422);
    expect(noCode.json()).toMatchObject({
      fieldErrors: { trackingCode: ['courier_tracking_code_required'] },
    });
    const res = await bookCourier(failed, manual.id, 'pf-2611-0042');
    expect(res.statusCode, res.body).toBe(200);
    const two = storefrontOrderSchema.parse(res.json());
    expect(two.shipments.map((parcel) => parcel.status)).toEqual(['booking_failed', 'booked']);
    const second = lastParcel(two);
    expect(second).toMatchObject({
      courier: 'paperfly',
      trackingCode: 'PF-2611-0042',
      attempts: 0,
    });
    expect(two.needsAttention).toBe(false);
    const [row] = await sql`SELECT invoice FROM storefront_shipments WHERE id = ${second.id}`;
    expect(row?.invoice).toBe(`${order.orderNo}-2`);
    // The first parcel is not the last one any more
    const oldRetry = await retry(two, first.id);
    expect(oldRetry.statusCode).toBe(409);
    expect(oldRetry.json()).toMatchObject({ code: 'storefront_order_has_parcel' });

    // A manual parcel follows the buttons
    const shipped = storefrontOrderSchema.parse((await move(two, 'ship')).json());
    expect(lastParcel(shipped).status).toBe('picked_up');
    const delivered = await move(shipped, 'deliver');
    expect(delivered.statusCode, delivered.body).toBe(200);
    const done = storefrontOrderSchema.parse(delivered.json());
    expect(lastParcel(done).events.map((event) => event.status)).toEqual([
      'booked',
      'picked_up',
      'delivered',
    ]);
    // The tracking page shows the parcel that went, never the one that failed
    const tracking = await trackingOf(order);
    expect(tracking).toHaveLength(1);
    expect(tracking[0]).toMatchObject({ courier: 'paperfly', trackingCode: 'PF-2611-0042' });
  });

  it('keeps an API parcel where its courier put it when a member marks the order shipped', async () => {
    const order = await confirm(909);
    await packed(order.id, steadfast.id);
    const booked = await parcelIs(order.id, 'booked');
    const shipped = storefrontOrderSchema.parse((await move(booked, 'ship')).json());
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).status).toBe('booked');
    // The courier's news still comes; the order is shipped already, so no second SMS of it
    await notice(
      statusNotice(
        lastParcel(shipped).consignmentId ?? '',
        'pending',
        'Picked up',
        steadfastAt(new Date()),
      ),
    );
    expect(lastParcel(await getOrder(order.id)).status).toBe('in_transit');
    expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toEqual([]);
  });

  it('refuses a parcel for an order that is not packed', async () => {
    const order = await confirm(910);
    const res = await bookCourier(await getOrder(order.id), steadfast.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'storefront_order_not_bookable' });
  });

  it('exports the packed orders with no parcel on its way, with the next parcel’s invoice', async () => {
    const none = await confirm(911);
    const noParcel = await packed(none.id, '');
    expect(noParcel.shipments).toEqual([]);
    const res = await send('GET', '/storefront/orders/courier-export');
    expect(res.statusCode, res.body).toBe(200);
    const exported = courierExportSchema.parse(res.json());
    expect(exported.more).toBe(false);
    expect(exported.rows.find((row) => row.orderId === none.id)).toEqual({
      orderId: none.id,
      invoice: none.orderNo,
      name: 'Nusrat Jahan',
      address: 'House 12, Road 5, Mirpur 10, Dhaka',
      phone: none.phone,
      amount: '538.0000',
      itemCount: 2,
    });
    // The refused parcel's order (905) goes again as its second parcel; a booked one not at all
    const [refused] = await sql`SELECT id::text, order_no FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${FAKE_REFUSED_PHONE}`;
    expect(exported.rows.find((row) => row.orderId === refused?.id)?.invoice).toBe(
      `${String(refused?.order_no)}-2`,
    );
    const [booked] = await sql`SELECT order_id::text AS id FROM storefront_shipments
      WHERE tenant_id = ${shop.tenantId} AND status = 'booked' LIMIT 1`;
    expect(exported.rows.map((row) => row.orderId)).not.toContain(booked?.id);
    // The packer's permission, not a reader's
    const reader = await member('sumi@nirvor.com', 'Sumi Akter', ['storefront.order.read']);
    expect(
      (await send('GET', '/storefront/orders/courier-export', undefined, reader)).statusCode,
    ).toBe(403);
  });
});
```

- **Booking at Packed.** A manual account is refused at Packed, under `courierAccountId`. With the Steadfast
  account, Packed answers the parcel in `booking` with no try yet; the worker books it with one try. The parcel has
  a `FAKE…` code, the courier's id, and one step, written by the booking (`source` `booking`). The spy without a
  `mock…` call lets the fake answer and records what it was told: the order number as the invoice, the zone after
  the address, the amount with two decimals, and "2 items", never the products. A second parcel is refused while
  this one is on its way.
- **Cancel while it books.** The spy holds the first booking until the test lets it go (`release()`). Meanwhile the
  try is counted, Cancel is refused with `storefront_order_parcel_booking`, and the tracking page shows no parcel.
  Once booked, Cancel cancels the parcel with the order: its second step is the member's.
- **A lost answer.** The first try "does not answer"; the second asks by the invoice first and is told the parcel
  exists. It is recorded as booked with the courier's code, after one `book()` call and one `find()` call: the
  courier never gets the parcel twice. The tracking page gets the courier's own page.
- **"Taken" and "exists".** The courier says it has the invoice already: found by the invoice, that is the booking,
  in one try. The courier has the invoice but no code to give: the parcel fails with `courier_invoice_taken`, and
  never books a second time.
- **Refused.** The fake refuses `FAKE_REFUSED_PHONE`: one try (asking again would get the same answer), the
  courier's sentence kept, and the bell with the order's number and the account's name, never the buyer's.
- **No answer at all.** Both tries fail, so the parcel fails with `courier_unreachable`. "Needs attention" is on the
  order and in the Packed list, and the bell rings for everyone with `storefront.order.manage`: the owner and
  Rafiq, the packer made by the permissions test. Book again books the same row, with the same invoice: its third
  try asks by the invoice, then books. Book again on a booked parcel is refused.
- **Keys that cannot be opened.** The account's `key_version` set to 2 in SQL (this server's key is version 1): the
  parcel fails at once with `courier_key_missing`, and the courier is never called.
- **A second parcel.** An account with refused keys fails the first parcel. Archived, it books nothing, again or
  new. A manual account books parcel 2: the code is required and kept in capitals, and the invoice is `W-…-2`.
  Book again is then refused for parcel 1: it is not the last. The buttons move the manual parcel to picked up and
  delivered, and the tracking page shows only the parcel that went.
- **Mark shipped on an API parcel** moves the order and leaves the parcel where its courier put it. The courier's
  pickup then moves the parcel, and sends no SMS: the order was shipped already.
- **Not packed:** Book courier on a confirmed order is refused (`storefront_order_not_bookable`).
- **The export** lists a packed order with no parcel, with its invoice, its address on one line, its amount and its
  items; the refused parcel's order as its second parcel (`W-…-2`); never an order with a parcel on its way. A
  reader gets 403.

```ts
describe("the courier's news", () => {
  it('answers 401 for every wrong token or account, and 200 for a parcel it does not know', async () => {
    const body = { notification_type: 'delivery_status', invoice: 'W-999998', status: 'pending' };
    for (const [id, token] of [
      [steadfast.id, null],
      [steadfast.id, 'wrongwrongwrongwrongwr'],
      [steadfast.id, `${steadfastToken} extra`],
      // Another account's id with this one's token, a manual account, and no account at all
      [manual.id, steadfastToken],
      ['0198c0de-0000-7000-8000-000000000000', steadfastToken],
    ] as const) {
      const res = await webhook(id, token, body);
      expect(res.statusCode, `${id} ${String(token)}`).toBe(401);
      expect(res.json()).toMatchObject({ code: 'courier_webhook_token_invalid' });
    }
    const [before] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events`;
    await sql`UPDATE courier_accounts SET last_webhook_at = NULL WHERE id = ${steadfast.id}`;
    await notice(body);
    const [after] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events`;
    expect(after?.n).toBe(before?.n);
    // The page shows when the courier last called
    expect((await accountRow(steadfast.id)).last_webhook_at).not.toBeNull();
    expect((await accountOf(steadfast.id)).lastWebhookAt).not.toBeNull();
  });

  it('moves the order to Shipped and Delivered, one step per notice, and sends one SMS', async () => {
    const order = await confirm(920);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const id = parcel.consignmentId ?? '';
    await nextSecond();
    const now = steadfastAt(new Date());
    const pickedUp = statusNotice(id, 'pending', 'Picked up from Nirvor', now);
    await notice(pickedUp);
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).status).toBe('in_transit');
    await eventually(async () => {
      expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(
        1,
      );
    });
    // The same notice again is the same step
    await notice(pickedUp);
    // Words with no status, by our invoice instead of the courier's id
    await notice({
      notification_type: 'tracking_update',
      invoice: order.orderNo,
      tracking_message: 'Received at Sylhet hub',
      updated_at: now,
    });
    // A status the adapter does not know, and a body far too large: kept, never refused
    await notice({
      notification_type: 'delivery_status',
      consignment_id: Number(id),
      status: 'teleported',
    });
    await notice({
      notification_type: 'delivery_status',
      consignment_id: Number(id),
      status: 'pending',
      tracking_message: 'x'.repeat(9000),
      updated_at: now,
    });
    await notice(statusNotice(id, 'delivered', 'Delivered to Nusrat', now));
    const done = await getOrder(order.id);
    expect(done.status).toBe('delivered');
    const invoice = invoiceSchema.parse(
      (await send('GET', `/invoices/${done.invoice?.id ?? ''}`)).json(),
    );
    expect(invoice.status).toBe('posted');
    // A late notice from before, by the courier's clock: kept, and the parcel stays delivered.
    // Its time is before the booking, so it counts as the booking's moment
    const yesterday = steadfastAt(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await notice(statusNotice(id, 'pending', 'At Mirpur hub', yesterday));
    const last = await getOrder(order.id);
    expect(lastParcel(last).status).toBe('delivered');
    const steps = lastParcel(last).events.map((event) => [event.status, event.note]);
    expect(steps[0]).toEqual(['booked', null]);
    expect(steps.slice(-3)).toEqual([
      ['in_transit', 'Received at Sylhet hub'],
      ['in_transit', 'x'.repeat(300)],
      ['delivered', 'Delivered to Nusrat'],
    ]);
    expect(steps.filter(([, note]) => note === 'Picked up from Nirvor')).toHaveLength(1);
    expect(steps).toContainEqual(['in_transit', 'At Mirpur hub']);
    // The unread one is a row with no status, its body kept
    const unread = (await eventRows(parcel.id)).filter((row) => row.status === null);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.raw).toMatchObject({ status: 'teleported' });
    // Only one SMS for the whole trip
    expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(1);
    // The tracking page has the same steps, and not the unread one
    const tracking = await trackingOf(order);
    expect(tracking[0]?.events.map((event) => event.note)).toEqual(steps.map(([, note]) => note));
  });

  it('keeps a body too large for its column as a marker', async () => {
    const order = await confirm(921);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    await notice({
      notification_type: 'mystery',
      consignment_id: Number(parcel.consignmentId),
      extra: 'y'.repeat(9000),
    });
    const unread = (await eventRows(parcel.id)).filter((row) => row.status === null);
    expect(unread.map((row) => row.raw)).toEqual([{ tooLarge: true }]);
    expect(lastParcel(await getOrder(order.id)).status).toBe('booked');
  });

  it('keeps the news when the invoice is refused, and leaves the order Shipped', async () => {
    const order = await confirm(922);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    // The books are closed up to today in Dhaka: no invoice can be posted
    await sql`INSERT INTO period_locks (tenant_id, lock_date)
      VALUES (${shop.tenantId}, (now() AT TIME ZONE 'Asia/Dhaka')::date)
      ON CONFLICT (tenant_id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
    try {
      await notice(
        statusNotice(parcel.consignmentId ?? '', 'delivered', 'Delivered', steadfastAt(new Date())),
      );
      const shipped = await getOrder(order.id);
      expect(shipped.status).toBe('shipped');
      expect(shipped.invoice).toBeNull();
      expect(lastParcel(shipped).status).toBe('delivered');
      // Mark delivered shows the reason to the member
      const refused = await move(shipped, 'deliver');
      expect(refused.json()).toMatchObject({ code: 'journal_period_locked' });
    } finally {
      await sql`UPDATE period_locks SET lock_date = NULL WHERE tenant_id = ${shop.tenantId}`;
    }
    const delivered = await move(await getOrder(order.id), 'deliver');
    expect(delivered.statusCode, delivered.body).toBe(200);
    expect(storefrontOrderSchema.parse(delivered.json()).invoice).not.toBeNull();
  });

  it('cancels a parcel the courier cancelled before pickup, and brings one back after it', async () => {
    const before = await confirm(923);
    await packed(before.id, steadfast.id);
    const first = lastParcel(await parcelIs(before.id, 'booked'));
    const now = steadfastAt(new Date());
    await notice(
      statusNotice(first.consignmentId ?? '', 'cancelled', 'Cancelled by merchant', now),
    );
    const cancelled = await getOrder(before.id);
    expect(cancelled.status).toBe('packed');
    expect(lastParcel(cancelled).status).toBe('cancelled');
    // Nothing on its way: it can go again, as its second parcel
    const again = await bookCourier(cancelled, steadfast.id);
    expect(again.statusCode, again.body).toBe(200);
    expect((await parcelIs(before.id, 'booked')).shipments).toHaveLength(2);

    const after = await confirm(924);
    await packed(after.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(after.id, 'booked'));
    await notice(statusNotice(parcel.consignmentId ?? '', 'pending', 'Picked up', now));
    await notice(statusNotice(parcel.consignmentId ?? '', 'cancelled', 'Refused at the door', now));
    const back = await getOrder(after.id);
    expect(back.status).toBe('shipped');
    expect(lastParcel(back).status).toBe('returning');
    // Once the courier has it, the order cannot be cancelled
    expect((await move(back, 'cancel')).statusCode).toBe(409);
  });
});
```

- **The webhook's door.** No header, a wrong token, a token with more after it, another account's id, a manual
  account's id and an id nobody has: all the same 401. A notice about a parcel nobody has is answered 200, writes no
  step, and sets the account's last webhook time.
- **A whole trip.** `pending` ships the order and sends the SMS. The same notice again is the same step. A
  `tracking_update` found by the invoice, not the courier's id, is a note at the parcel's status. A status the
  adapter does not know is kept as an unread row with its body. A 9,000-character message is cut to 300.
  `delivered` delivers the order and posts its invoice. Then a late notice from yesterday: kept, at the booking's
  moment (the clamp), and the parcel stays delivered. One SMS for the whole trip. The tracking page has the same
  steps, and not the unread one.
- **A body too large for its column** (over 8 KB) is kept as the marker `{ "tooLarge": true }`.
- **An invoice the books refuse.** The lock date set to today in SQL: `delivered` still moves the parcel, and the
  order stays Shipped with no invoice. Mark delivered shows the reason (`journal_period_locked`), and works once the
  lock is gone.
- **Cancelled by the courier.** Before pickup the parcel is cancelled, and the order can be booked again as
  parcel 2. After pickup it is coming back (`returning`), the order stays shipped, and Cancel is refused.

```ts
describe('the poll', () => {
  it('asks about each parcel on its way, and writes a step only when the status changed', async () => {
    const order = await confirm(930);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const status = vi
      .spyOn(courier, 'status')
      .mockImplementation((_keys, consignmentId) =>
        Promise.resolve(
          consignmentId === parcel.consignmentId
            ? { kind: 'status', status: 'in_transit', word: 'pending' }
            : { kind: 'problem', problem: 'unreachable' },
        ),
      );
    const poll = worker.get(ShipmentPoll);
    expect(await poll.run()).toBeGreaterThan(0);
    const shipped = await getOrder(order.id);
    expect(shipped.status).toBe('shipped');
    expect(lastParcel(shipped).events.map((event) => event.status)).toEqual([
      'booked',
      'in_transit',
    ]);
    expect((await eventRows(parcel.id)).map((row) => row.source)).toEqual(['booking', 'poll']);
    await eventually(async () => {
      expect((await smsTo(order.phone)).filter((text) => text.includes(ON_ITS_WAY))).toHaveLength(
        1,
      );
    });
    const synced = lastParcel(shipped).lastSyncedAt ?? '';

    // The same status again is no news: no step, only the time it was asked
    await poll.run();
    const again = lastParcel(await getOrder(order.id));
    expect(again.events).toHaveLength(2);
    expect(Date.parse(again.lastSyncedAt ?? '')).toBeGreaterThan(Date.parse(synced));
    // A word the adapter does not know is no step either
    status.mockImplementation(() =>
      Promise.resolve({ kind: 'status', status: null, word: 'teleported' }),
    );
    await poll.run();
    expect(lastParcel(await getOrder(order.id)).events).toHaveLength(2);
    // Only parcels with the courier's id: never a manual one, never one still booking
    const asked = new Set(status.mock.calls.map((call) => call[1]));
    const [manualIds] = await sql`SELECT count(*)::int AS n FROM storefront_shipments s
      JOIN courier_accounts a ON a.id = s.courier_account_id
      WHERE a.provider = 'manual' AND s.consignment_id = ANY(${[...asked]})`;
    expect(manualIds?.n).toBe(0);
    // Delivered and cancelled parcels are not on their way any more
    const [settled] = await sql`SELECT count(*)::int AS n FROM storefront_shipments
      WHERE status IN ('delivered', 'cancelled', 'booking_failed') AND consignment_id = ANY(${[...asked]})`;
    expect(settled?.n).toBe(0);
  });

  it("skips a parcel whose account's keys this server can't open", async () => {
    const order = await confirm(931);
    await packed(order.id, steadfast.id);
    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
    const status = vi.spyOn(courier, 'status');
    await sql`UPDATE courier_accounts SET key_version = 2 WHERE id = ${steadfast.id}`;
    try {
      await worker.get(ShipmentPoll).run();
      expect(status.mock.calls.map((call) => call[1])).not.toContain(parcel.consignmentId);
    } finally {
      await sql`UPDATE courier_accounts SET key_version = 1 WHERE id = ${steadfast.id}`;
    }
    await worker.get(ShipmentPoll).run();
    expect(status.mock.calls.map((call) => call[1])).toContain(parcel.consignmentId);
  });
});
```

- **The poll.** The spy answers `in_transit` for one parcel and "no answer" for every other. The parcel moves,
  the order ships, the SMS goes, and the step's `source` is `poll`. The same answer again writes no step and moves
  only `lastSyncedAt`. A word the adapter does not know writes no step either. The poll never asked about a manual
  parcel, or a parcel already delivered, cancelled or failed.
- **Keys that cannot be opened** (`key_version` 2 again): the poll skips the account's parcels, and asks about them
  once the keys open.

### The tenant-leak tests

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type CourierAccount,
  courierAccountSavedSchema,
  courierAccountSchema,
  courierExportSchema,
  courierSetupSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
} from '@omnivo/contracts';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { COURIERS } from '../../infra/tokens.js';
import type { CourierAdapter, CourierAdapters } from '../../shipping/courier.js';
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
} from '../../testing/shop-orders.js';
import { ShopDb } from '../shop-db.js';
import { ShipmentPoll } from './shipment-poll.js';

// Step 28a: a courier account and its parcels are a workspace's own. Two launched shops, Nirvor
// and Acme, each with its own Steadfast account. The fake courier works a parcel's id and code out
// of its invoice, so the first order of each shop (W-000001 in both) has the SAME consignment id
// and invoice in both workspaces: only the account (in the webhook's address) and the workspace
// tell them apart. The ERP must show, change and book with its own accounts only; a webhook must
// move only the parcels of the account it names; the poll must ask each workspace's parcels with
// that workspace's keys; a sealed key must open only where it was sealed; and the shop's and the
// worker's database roles must see no more than 0078 grants them.
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
let courier: CourierAdapter;
let nirvorAccount: CourierAccount;
let nirvorToken: string;
let acmeAccount: CourierAccount;
let acmeToken: string;
// The first order of each shop, packed and booked: W-000001 in both
let nirvorOrder: StorefrontOrder;
let acmeOrder: StorefrontOrder;

const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];

function send(who: SignedIn, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function addSteadfast(who: SignedIn, apiKey: string) {
  const res = await send(who, 'POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast',
    apiKey,
    secretKey: `${apiKey}-secret`,
  });
  expect(res.statusCode, res.body).toBe(201);
  const saved = courierAccountSavedSchema.parse(res.json());
  return { account: saved.account, token: saved.webhookToken ?? '' };
}

async function getOrder(who: SignedIn, id: string): Promise<StorefrontOrder> {
  const res = await send(who, 'GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// An order of two face washes at this shop, confirmed by shopper n and given its sales order
async function confirmAt(shop: OrderShop, who: SignedIn, n: number): Promise<StorefrontOrder> {
  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, '538'));
  const { code } = await codeFor(mail.apiUrl, phone);
  const res = await shopPost(app, '/orders/verify', headers, { token, code });
  expect(res.statusCode, res.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
        WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  return eventually(async () => {
    const order = await getOrder(who, row.id);
    expect(order.salesOrder).not.toBeNull();
    return order;
  });
}

async function packWith(who: SignedIn, order: StorefrontOrder, courierAccountId: string) {
  return send(who, 'POST', `/storefront/orders/${order.id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId,
  });
}

async function bookedAt(who: SignedIn, id: string): Promise<StorefrontOrder> {
  return eventually(async () => {
    const order = await getOrder(who, id);
    expect(order.shipments.at(-1)?.status).toBe('booked');
    return order;
  });
}

function webhook(accountId: string, token: string, body: object) {
  return app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${accountId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

const parcelRowSchema = z.object({
  tenant_id: z.string(),
  status: z.string(),
  events: z.number(),
});
async function parcelOf(order: StorefrontOrder) {
  const [row] = z.array(parcelRowSchema).parse(
    await sql`SELECT s.tenant_id::text, s.status,
        (SELECT count(*)::int FROM storefront_shipment_events e WHERE e.shipment_id = s.id) AS events
      FROM storefront_shipments s WHERE s.order_id = ${order.id} ORDER BY s.parcel_no DESC LIMIT 1`,
  );
  if (row === undefined) throw new Error(`order ${order.id} has no parcel`);
  return row;
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
  courier = worker.get<CourierAdapters>(COURIERS).steadfast;
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
  ({ account: nirvorAccount, token: nirvorToken } = await addSteadfast(
    nirvorOwner,
    'nirvor-api-key',
  ));
  ({ account: acmeAccount, token: acmeToken } = await addSteadfast(acmeOwner, 'acme-api-key'));
  // Each shop's first order, packed with its own account and booked
  const first = async (shop: OrderShop, who: SignedIn, account: CourierAccount, n: number) => {
    const order = await confirmAt(shop, who, n);
    const res = await packWith(who, order, account.id);
    expect(res.statusCode, res.body).toBe(200);
    return bookedAt(who, order.id);
  };
  nirvorOrder = await first(nirvor, nirvorOwner, nirvorAccount, 1001);
  acmeOrder = await first(acme, acmeOwner, acmeAccount, 1002);
}, 240_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops, one fake courier', () => {
  it('gives both first parcels the same invoice and consignment id', () => {
    expect(nirvorOrder.orderNo).toBe(acmeOrder.orderNo);
    expect(nirvorOrder.shipments[0]?.consignmentId).toBe(acmeOrder.shipments[0]?.consignmentId);
  });
});

describe('Shop couriers', () => {
  it("shows, changes and books with the workspace's own accounts only", async () => {
    const setup = courierSetupSchema.parse(
      (await send(acmeOwner, 'GET', '/storefront/couriers')).json(),
    );
    expect(setup.accounts.map((account) => account.id)).toEqual([acmeAccount.id]);
    const id = nirvorAccount.id;
    const version = { version: nirvorAccount.version };
    for (const [method, url, body] of [
      [
        'PUT',
        `/storefront/couriers/${id}`,
        { provider: 'steadfast', name: 'Taken', apiKey: '', secretKey: '', ...version },
      ],
      ['POST', `/storefront/couriers/${id}/test`, undefined],
      ['POST', `/storefront/couriers/${id}/webhook-token`, version],
      ['POST', `/storefront/couriers/${id}/archive`, version],
      ['POST', `/storefront/couriers/${id}/restore`, version],
      ['PUT', '/storefront/couriers', { accountId: id }],
    ] as const) {
      const res = await send(acmeOwner, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    // Nirvor's account is as it was
    const own = courierSetupSchema.parse(
      (await send(nirvorOwner, 'GET', '/storefront/couriers')).json(),
    ).accounts[0];
    expect(own).toMatchObject({
      name: 'Steadfast',
      version: nirvorAccount.version,
      lastTest: null,
    });

    // Acme's order with Nirvor's account: at Packed, and with Book courier
    const order = await confirmAt(acme, acmeOwner, 1003);
    const packed = await packWith(acmeOwner, order, id);
    expect(packed.statusCode).toBe(422);
    expect(packed.json()).toMatchObject({ code: 'courier_account_not_bookable' });
    const none = storefrontOrderSchema.parse((await packWith(acmeOwner, order, '')).json());
    const booked = await send(acmeOwner, 'POST', `/storefront/orders/${order.id}/shipments`, {
      version: none.version,
      accountId: id,
      trackingCode: '',
    });
    expect(booked.statusCode).toBe(404);
    // The export lists Acme's orders only
    const exported = courierExportSchema.parse(
      (await send(acmeOwner, 'GET', '/storefront/orders/courier-export')).json(),
    );
    expect(exported.rows.map((row) => row.orderId)).toEqual([order.id]);
  });

  it("opens no other workspace's sealed keys", async () => {
    const [own] = z
      .array(z.object({ keys_sealed: z.instanceof(Buffer) }))
      .parse(await sql`SELECT keys_sealed FROM courier_accounts WHERE id = ${acmeAccount.id}`);
    if (own === undefined) throw new Error("no keys on Acme's account");
    // Nirvor's box copied into Acme's row, as someone with database access could do. The key is
    // the same; the workspace is part of what was sealed
    await sql`UPDATE courier_accounts SET keys_sealed =
      (SELECT keys_sealed FROM courier_accounts WHERE id = ${nirvorAccount.id})
      WHERE id = ${acmeAccount.id}`;
    try {
      const tested = await send(acmeOwner, 'POST', `/storefront/couriers/${acmeAccount.id}/test`);
      expect(courierAccountSchema.parse(tested.json()).lastTest?.problem).toBe('rejected');
      const book = vi.spyOn(courier, 'book');
      const order = await confirmAt(acme, acmeOwner, 1004);
      expect((await packWith(acmeOwner, order, acmeAccount.id)).statusCode).toBe(200);
      const failed = await eventually(async () => {
        const now = await getOrder(acmeOwner, order.id);
        expect(now.shipments[0]?.status).toBe('booking_failed');
        return now;
      });
      expect(failed.shipments[0]?.error).toBe('courier_key_missing');
      // Never Nirvor's keys at Acme's courier
      expect(book).not.toHaveBeenCalled();
    } finally {
      await sql`UPDATE courier_accounts SET keys_sealed = ${own.keys_sealed} WHERE id = ${acmeAccount.id}`;
    }
  });
});

describe("the courier's news", () => {
  it("takes no other account's token, and moves only the named account's parcels", async () => {
    const body = {
      notification_type: 'delivery_status',
      consignment_id: Number(nirvorOrder.shipments[0]?.consignmentId),
      invoice: nirvorOrder.orderNo,
      status: 'pending',
      tracking_message: 'Picked up',
    };
    // Acme's address with Nirvor's token, and the other way round
    expect((await webhook(acmeAccount.id, nirvorToken, body)).statusCode).toBe(401);
    expect((await webhook(nirvorAccount.id, acmeToken, body)).statusCode).toBe(401);
    expect(await parcelOf(acmeOrder)).toMatchObject({ status: 'booked', events: 1 });
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'booked', events: 1 });

    // Nirvor's courier tells Nirvor's account: the same id and invoice at Acme stay as they were
    await sql`UPDATE courier_accounts SET last_webhook_at = NULL`;
    const res = await webhook(nirvorAccount.id, nirvorToken, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'in_transit', events: 2 });
    expect(await parcelOf(acmeOrder)).toMatchObject({ status: 'booked', events: 1 });
    expect((await getOrder(nirvorOwner, nirvorOrder.id)).status).toBe('shipped');
    expect((await getOrder(acmeOwner, acmeOrder.id)).status).toBe('packed');
    const touched = z
      .array(z.object({ tenant_id: z.string() }))
      .parse(
        await sql`SELECT tenant_id::text FROM courier_accounts WHERE last_webhook_at IS NOT NULL`,
      );
    expect(touched.map((row) => row.tenant_id)).toEqual([nirvor.tenantId]);
    // Every event row is its parcel's workspace's
    const [mixed] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events e
      JOIN storefront_shipments s ON s.id = e.shipment_id WHERE e.tenant_id <> s.tenant_id`;
    expect(mixed?.n).toBe(0);
  });

  it("asks about each workspace's parcels with that workspace's own keys", async () => {
    const consignment = acmeOrder.shipments[0]?.consignmentId;
    const status = vi
      .spyOn(courier, 'status')
      .mockImplementation((keys, consignmentId) =>
        Promise.resolve(
          keys.apiKey === 'acme-api-key' && consignmentId === consignment
            ? { kind: 'status', status: 'in_transit', word: 'pending' }
            : { kind: 'problem', problem: 'unreachable' },
        ),
      );
    await worker.get(ShipmentPoll).run();
    // The one id, asked once in each workspace, each time with its own keys
    expect(
      status.mock.calls
        .filter((call) => call[1] === consignment)
        .map((call) => call[0].apiKey)
        .sort(),
    ).toEqual(['acme-api-key', 'nirvor-api-key']);
    expect(await parcelOf(acmeOrder)).toMatchObject({
      tenant_id: acme.tenantId,
      status: 'in_transit',
    });
    // Nirvor's parcel got no step from Acme's answer
    expect(await parcelOf(nirvorOrder)).toMatchObject({ status: 'in_transit', events: 2 });
  });
});

describe('the order page', () => {
  it("answers 404 for another workspace's order and parcel", async () => {
    const parcel = nirvorOrder.shipments[0]?.id ?? '';
    expect((await send(acmeOwner, 'GET', `/storefront/orders/${nirvorOrder.id}`)).statusCode).toBe(
      404,
    );
    const retry = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${nirvorOrder.id}/shipments/${parcel}/retry`,
      { version: nirvorOrder.version },
    );
    expect(retry.statusCode).toBe(404);
    // Acme's own packed order (its first one is shipped by now), with Nirvor's parcel id
    const [packed] = z.array(z.object({ id: z.string() })).parse(
      await sql`SELECT id::text FROM storefront_orders
          WHERE tenant_id = ${acme.tenantId} AND status = 'packed' LIMIT 1`,
    );
    const own = await getOrder(acmeOwner, packed?.id ?? '');
    const mixed = await send(
      acmeOwner,
      'POST',
      `/storefront/orders/${own.id}/shipments/${parcel}/retry`,
      { version: own.version },
    );
    expect(mixed.statusCode).toBe(404);
  });
});

describe('the database roles', () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.host, (tx) => tx.execute(query));
  }
  async function deniedAs(as: typeof asShop, query: SQL) {
    return pgErrorOf(await as(query).catch((caught: unknown) => caught));
  }

  it("give the shop's roles no account, no amount and no other workspace's parcel", async () => {
    for (const as of [asPublic, asShop]) {
      expect(await deniedAs(as, drizzleSql`SELECT name FROM courier_accounts`)).toEqual({
        code: '42501',
        message: 'permission denied for table courier_accounts',
      });
      expect(
        await deniedAs(
          as,
          drizzleSql`SELECT * FROM courier_account_for_webhook(${nirvorAccount.id}::uuid, 'steadfast')`,
        ),
      ).toEqual({
        code: '42501',
        message: 'permission denied for function courier_account_for_webhook',
      });
    }
    // omnivo_public reads no parcel at all; omnivo_shop only the tracking page's columns
    expect(await deniedAs(asPublic, drizzleSql`SELECT id FROM storefront_shipments`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipments',
    });
    for (const column of ['cod_amount', 'consignment_id', 'error_detail']) {
      expect(
        await deniedAs(
          asShop,
          drizzleSql`SELECT ${drizzleSql.identifier(column)} FROM storefront_shipments`,
        ),
      ).toEqual({ code: '42501', message: 'permission denied for table storefront_shipments' });
    }
    expect(await deniedAs(asShop, drizzleSql`SELECT raw FROM storefront_shipment_events`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipment_events',
    });
    // Acme's parcel, from Nirvor's shop: not there
    const seen = await asShop(drizzleSql`SELECT tenant_id::text FROM storefront_shipments`);
    expect(Array.from(seen).map((row) => row.tenant_id)).toEqual([nirvor.tenantId]);
    // And never a write
    expect(
      await deniedAs(asShop, drizzleSql`UPDATE storefront_shipments SET status = 'delivered'`),
    ).toEqual({ code: '42501', message: 'permission denied for table storefront_shipments' });
  });

  it('hide a parcel still booking or failed, and a notice nobody could read, even in its own workspace', async () => {
    const order = await confirmAt(nirvor, nirvorOwner, 1005);
    const old = await addSteadfast(nirvorOwner, 'fake_rejected');
    expect((await packWith(nirvorOwner, order, old.account.id)).statusCode).toBe(200);
    await eventually(async () => {
      expect((await getOrder(nirvorOwner, order.id)).shipments[0]?.status).toBe('booking_failed');
    });
    const failed = await asShop(
      drizzleSql`SELECT id FROM storefront_shipments WHERE order_id = ${order.id}::uuid`,
    );
    expect(Array.from(failed)).toEqual([]);
    // A notice Nirvor's adapter cannot read, on Nirvor's booked parcel
    const unread = await webhook(nirvorAccount.id, nirvorToken, {
      notification_type: 'mystery',
      invoice: nirvorOrder.orderNo,
    });
    expect(unread.statusCode).toBe(200);
    const [kept] = await sql`SELECT count(*)::int AS n FROM storefront_shipment_events
      WHERE tenant_id = ${nirvor.tenantId} AND status IS NULL`;
    expect(kept?.n).toBe(1);
    const shown = await asShop(
      drizzleSql`SELECT count(*)::int AS n FROM storefront_shipment_events WHERE status IS NULL`,
    );
    expect(Array.from(shown)).toEqual([{ n: 0 }]);
  });

  it("let the worker's role read only which workspaces have a parcel on its way", async () => {
    const workerSql = postgres(pg.workerUrl, { max: 1 });
    try {
      const open = z
        .array(z.object({ tenant_id: z.string(), status: z.string() }))
        .parse(await workerSql`SELECT tenant_id::text, status FROM storefront_shipments`);
      // Both workspaces' parcels on their way; never a failed one, and never more than two columns
      expect(new Set(open.map((row) => row.tenant_id))).toEqual(
        new Set([nirvor.tenantId, acme.tenantId]),
      );
      expect(open.map((row) => row.status)).not.toContain('booking_failed');
      const error = await workerSql`SELECT tracking_code FROM storefront_shipments`.catch(
        (caught: unknown) => caught,
      );
      expect(pgErrorOf(error)).toEqual({
        code: '42501',
        message: 'permission denied for table storefront_shipments',
      });
    } finally {
      await workerSql.end();
    }
  });
});
```

Two launched shops, Nirvor and Acme, each with its own Steadfast account and its first order booked. The fake
courier works a parcel's id out of its invoice, so both first parcels have the same invoice (`W-000001`) and the
same consignment id: the first test checks it, because the webhook tests mean nothing without it. Only the account
in the webhook's address, and the workspace, tell the two apart.

- **The accounts.** Acme's owner sees only Acme's account. With Nirvor's account id, every account route answers
  404, and "Use as default" too; Nirvor's account is unchanged. Nirvor's account at Acme's Packed is refused like
  any account Acme cannot book with (422), and with Book courier it is a 404. The export lists Acme's orders only.
- **The sealed keys.** Nirvor's box copied into Acme's row: it does not open there (the workspace is part of what
  was sealed). Acme's test says `rejected`, and Acme's booking fails with `courier_key_missing` without calling the
  courier: Nirvor's keys never reach Acme's courier. Acme's box is put back in `finally`.
- **The webhook.** Each account's token is refused at the other's address. Nirvor's notice at Nirvor's address
  moves Nirvor's parcel only; Acme's parcel with the same id and invoice stays booked, its order packed, and only
  Nirvor's account has a last webhook time. No event row is in another workspace than its parcel.
- **The poll.** The same consignment id is asked once in each workspace, each time with that workspace's own keys.
  Acme's answer moves Acme's parcel, and not Nirvor's.
- **The order page.** Nirvor's order is a 404 for Acme, and so is Book again with Nirvor's parcel, through Nirvor's
  order or Acme's own.
- **The database roles.** Both of the shop's roles get "permission denied" for `courier_accounts` and for
  `courier_account_for_webhook()`, even in their own workspace. `omnivo_public` reads no parcel at all;
  `omnivo_shop` gets "permission denied" for the amount, the courier's id, the courier's words and the raw body,
  sees only its own workspace's parcels, and writes none. A failed parcel and an unread notice are hidden from it
  in its own workspace too (0078's restrictive policies). `omnivo_worker` sees which workspaces have a parcel on its
  way and nothing else: no failed parcel, and "permission denied" for a tracking code.

The generic row-security test (`apps/api/src/common/tenant/rls-coverage.tenant-leak.int.spec.ts`) needs no change:
it finds the three new tables by their `tenant_id` column and checks that each has row security on.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/api exec tsc --noEmit -p .
pnpm --filter @omnivo/api test
pnpm exec eslint apps/api/src/storefront/shipping apps/api/src/testing/app.ts
pnpm exec prettier --check apps/api/src/storefront/shipping apps/api/src/testing
cd apps/api
npx vitest run src/storefront/shipping src/common/tenant src/storefront/orders/storefront-orders.int.spec.ts --maxWorkers=3
```

All pass: API 244 unit tests; the two new files (24 and 9 tests, about 20 and 10 seconds after the containers
start), the generic tenant-leak suites and the storefront orders suite (58 tests in all). The new files passed
three runs in a row. The app does not type-check until 28a.6.

Broken on purpose, to see that the tests notice:

- The booking job's "ask by the invoice after the first try" taken out: the lost-answer test fails (a second
  `book()` gets the fake's own code, not the courier's), and the "exists" test books a parcel the courier already
  has.
- The clamp taken out of `ShipmentNews` (the courier's time used as it is): yesterday's late notice becomes the
  parcel's first step, before its booking, and a pickup notice a second before the booking leaves the parcel booked.
- One workspace for every seal (`'all'` in place of the tenant in `courier-keys.ts`): the sealed-keys leak test
  fails, because Nirvor's box opens in Acme's row.

## 28a.5 — `packages/i18n`: the words of the courier screens

The screens of 28a.6 need their words in English and Bangla, so they come first. 28a.1 already gave the errors, the
audit log's actions and the bell their words (and 28a.3 the two new error codes). This part adds the Storefront
menu's "Shop couriers" item and its page, the order page's parcel card and its notices, the Book courier dialog,
the courier select in the Packed dialog, the parcel's label, the export for a courier's bulk upload, and the audit
log's names for the new fields. The shop's words do not change: its tracking page has had the parcel's words since
26e, and 28a.3 only fills that page with real steps.

These words come before the mockup. If the mockup in 28a.6 changes a screen, the words change with it, and the
diffs below show them as they are at the end of the step.

Five decisions came up while writing the words (mine):

42. **The ERP has its own twelve status words for a parcel,** apart from the shop's ten (`shop.track.shipmentStatuses`).
    The ERP cannot import the shop's words (CLAUDE.md: `@omnivo/i18n/shop` is the shop's only), and the two are
    for different readers: a shopper reads "Could not deliver: they will try again", a member reads a short pill,
    "On hold". The courier names are a list of their own in the ERP too, the same in Bangla (they are names, like
    the shop's list).
43. **The status of an order moving by itself is said before it happens.** The order page's line under a booked
    parcel says "The order moves to Shipped by itself when Steadfast's rider picks the parcel up", and the one under
    a shipped order "…moves to Delivered by itself… That posts the invoice." The buttons stay (a manual move still
    works, decision 5), so without the line a member presses Mark delivered on a parcel the courier is still
    carrying, and the invoice is posted a day early.
44. **The default's off state is said in words, never left empty.** The select says "Don't book at Packed" and the
    toast "Packed books with no courier first". An empty select would read as "not set up yet" and send the tenant
    to look for a missing step; decision 13 makes "no default" a real choice for a shop with its own riders.
45. **The webhook dialog names the fields as Steadfast's panel names them** ("Callback URL", "Auth token (Bearer)"),
    in both languages. The person copies from our box into a box on Steadfast's page; the same name on both sides
    is the whole instruction. Its last line says what happens when nobody pastes it (the 15-minute poll, decision
    9), so a tenant who skips it is not surprised that orders move late.
46. **The export's file stays in the courier's words.** The column names (Invoice, Name, Address, Phone, Amount,
    Note) are Steadfast's bulk upload format, not text for a person, so they stay in code (28a.6), like a CSV's
    header in any export for another system. Only the Note column ("3 items") goes through `t()`, with the orders
    list's own `items_*` words, in the language of whoever exports, because the rider reads it.

### `locales/en.ts`

```diff
@@ -162,6 +162,8 @@ export const en = {
     // Step 27c: after Catalog, both about the shop's prices (decision 29). "Shop" for the phone's
     // nav row, like the others
     storefrontCoupons: 'Shop coupons',
+    // Step 28a: after Shop settings in the menu, both set the shop up (decision 15)
+    storefrontCouriers: 'Shop couriers',
   },
   auth: {
     workspace: 'Workspace',
```

The menu item. "Shop" for the same reason as its neighbours: on a phone the nav is one row with no group labels. It
sits after Shop settings (28a.6), because both set the shop up; Shop orders, which people open every day, stays
first in the group.

```diff
@@ -5472,6 +5474,146 @@ export const en = {
       updated: 'Payment gateway saved',
       loadFailed: "Couldn't load the payment gateway. Refresh the page to try again.",
     },
+    // Step 28a: Storefront → Shop couriers (/storefront/couriers, decision 15), storefront.manage.
+    // An account books with the courier's API (Steadfast) or names a courier the shop books by
+    // hand (decision 14)
+    couriers: {
+      title: 'Shop couriers',
+      description:
+        'The couriers your parcels go with, and the one the Packed dialog books with first',
+      add: 'Add courier account',
+      view: 'Show',
+      views: { active: 'Active', archived: 'Archived' },
+      statuses: { active: 'Active', archived: 'Archived' },
+      // A second, brand pill on the default account's row (decision 13)
+      isDefault: 'Books first',
+      // The line under the account's name. courier = the courier's name (names below)
+      providers: {
+        steadfast: '{{courier}} · books by its API',
+        manual: '{{courier}} · booked by hand',
+      },
+      // SHOP_COURIERS. Names, so the same in Bangla, like the shop's own list
+      names: {
+        pathao: 'Pathao',
+        steadfast: 'Steadfast',
+        redx: 'RedX',
+        ecourier: 'eCourier',
+        paperfly: 'Paperfly',
+      },
+      columns: {
+        account: 'Account',
+        news: 'Courier’s news',
+        test: 'Last test',
+        status: 'Status',
+      },
+      // The news column (lastWebhookAt, decision 16). date = the date and time in the
+      // workspace's time zone
+      newsAt: 'Last arrived {{date}}',
+      newsNever: 'None yet',
+      newsNeverHint:
+        'Paste the webhook into the courier’s panel. Until then, Omnivo asks every 15 minutes.',
+      newsManual: 'Moved by hand',
+      // The last test column (lastTest)
+      neverTested: 'Not tested',
+      testWorked: 'Keys accepted {{date}}',
+      testRejected: 'Keys refused {{date}}',
+      testUnreachable: 'No answer {{date}}',
+      // The row menu
+      actionsFor: 'Actions for {{name}}',
+      edit: 'Edit',
+      test: 'Test connection',
+      renewToken: 'New webhook token',
+      archive: 'Archive',
+      restore: 'Restore',
+      // The test's toast. courier = the courier's name
+      testedWorked: '{{courier}} accepted the keys',
+      testedRejected: '{{courier}} refused the keys. Check them in Edit.',
+      testedUnreachable: '{{courier}} did not answer. Try again in a few minutes.',
+      emptyTitle: 'No courier account yet',
+      emptyBody:
+        'Add your Steadfast account to book parcels as orders are packed, or a courier you book by hand, to keep its tracking codes on the orders.',
+      archivedEmptyTitle: 'No archived courier account',
+      archivedEmptyBody:
+        'An account you archive shows here. Its parcels on their way still get the courier’s news.',
+      loadFailed: "Couldn't load the courier accounts. Refresh the page to try again.",
+      // The card above the list (setDefaultCourier, decision 13)
+      default: {
+        title: 'Book at Packed',
+        description:
+          'The courier the Packed dialog starts with. Whoever packs the order can still change it.',
+        label: 'Book with',
+        none: 'Don’t book at Packed',
+        hint: 'Only an account that books by its API. With none, a parcel is booked with Book courier, or by hand.',
+        noApiAccount: 'Add a Steadfast account to book parcels as orders are packed.',
+        save: 'Save',
+        saved: 'Packed books with {{name}} first',
+        cleared: 'Packed books with no courier first',
+      },
+      // The account dialog (create and update, by provider)
+      form: {
+        addTitle: 'Add a courier account',
+        editTitle: 'Edit {{name}}',
+        provider: 'How it books',
+        providers: { steadfast: 'Steadfast, by its API', manual: 'Another courier, by hand' },
+        providerHints: {
+          steadfast:
+            'Omnivo books each parcel with Steadfast, and Steadfast’s news move the order.',
+          manual:
+            'You book on the courier’s own website or app, then type its tracking code into the order.',
+        },
+        // Editing: the provider is shown, not offered (courier_provider_fixed)
+        providerFixed: 'An account’s courier can’t change. Add a new account for another courier.',
+        name: 'Name',
+        namePlaceholder: 'Steadfast Dhaka',
+        nameHint:
+          'Only your team sees it. Two accounts with one courier, one per pickup point, need two names.',
+        apiKey: 'API key',
+        secretKey: 'Secret key',
+        keysHint: 'Both are on the API page of your Steadfast panel.',
+        // A saved account: the boxes start empty, and an empty box keeps its key
+        keySavedPlaceholder: 'Saved',
+        keysSavedHint:
+          'The keys are saved and never shown. Leave a box empty to keep its key, or type a new one.',
+        courier: 'Courier',
+        courierPlaceholder: 'Pick a courier',
+        courierHint: 'Whose website or app you book on. The tracking page names it.',
+        create: 'Add account',
+        save: 'Save changes',
+        created: 'Courier account {{name}} added',
+        updated: 'Courier account saved',
+      },
+      // After an API account is added, and after New webhook token. The token is in the answer
+      // once (courierAccountSavedSchema), so the dialog says so
+      webhook: {
+        title: 'Paste the webhook into Steadfast',
+        description:
+          'Steadfast sends each parcel’s news to this address. Paste both into the webhook settings of your Steadfast panel.',
+        url: 'Callback URL',
+        token: 'Auth token (Bearer)',
+        tokenHint: 'Shown only this once. If it is lost, make a new one from the account’s menu.',
+        copyUrl: 'Copy URL',
+        copyToken: 'Copy token',
+        copied: 'Copied',
+        poll: 'Until the first news arrive, Omnivo asks Steadfast every 15 minutes, so orders still move, only later.',
+        done: 'Done',
+      },
+      renewing: {
+        title: 'Make a new webhook token for {{name}}?',
+        body: 'The old token stops working at once. Steadfast’s news are refused until you paste the new one into its panel.',
+        submit: 'Make new token',
+      },
+      archiving: {
+        title: 'Archive {{name}}?',
+        body: 'No new parcel goes with it. Its parcels on their way still get the courier’s news.',
+        // The default account: archiving it clears the default too (28a.2)
+        bodyDefault:
+          'No new parcel goes with it, and Packed books with no courier first. Its parcels on their way still get the courier’s news.',
+        submit: 'Archive account',
+      },
+      archived: '{{name}} archived',
+      restored: '{{name}} restored',
+      tokenRenewed: 'New webhook token made',
+    },
     categories: {
       title: 'Shop categories',
       description: 'How the shop groups its listings, in the order its menu shows them',
```

The new `couriers` block, the Shop couriers page (decision 15), right after the payment gateway's words because it
is set up the same way:

- **`providers`** is the line under an account's name: which courier, and how it books. Both facts decide what
  happens to a parcel (booked by Omnivo, or typed in by a member), so the list shows both without opening the
  account. It has exactly the keys of `COURIER_PROVIDERS`, so a template-literal key type-checks, and Pathao (28c)
  fails the type check until it has its words.
- **`names`** has exactly the keys of `SHOP_COURIERS` (decision 42).
- **`newsAt` / `newsNever` / `newsNeverHint`** are decision 16's column. "None yet" comes with a `warn` line that
  says what to do and what happens meanwhile, because a missing webhook is the most likely mistake in the whole
  setup, and the order still moves (by the poll), only late. A manual account has no news at all, so it says "Moved
  by hand" in place of a dash that would look like missing data.
- **`neverTested`, `testWorked`, `testRejected`, `testUnreachable`** are the table's short form of the last test.
  The gateway card (27d) has room for a sentence; a table cell does not, so the advice goes into the test's toast
  (`testedRejected` says to check the keys in Edit) and the error words of 28a.1.
- **`default`** is the "Book at Packed" card (decision 13, 44). Its hint says why a manual account is not in the
  list (it cannot be booked at Packed: its code does not exist yet), the same reason `courier_account_not_bookable`
  gives when the API refuses one.
- **`form`**: `providers` are the two kinds as a person would choose them ("Steadfast, by its API", "Another
  courier, by hand"), each with a hint of what it means for the day's work. `providerFixed` replaces the choice
  when editing (`courier_provider_fixed`, 28a.2's guard). `keysHint` says where both keys are, because a person
  setting this up for the first time does not know Steadfast calls them API key and Secret key; `keySavedPlaceholder`
  and `keysSavedHint` work as the gateway's saved password does (an empty box keeps the saved key, 28a.1), one hint
  for both boxes since they behave the same. `nameHint` says why two accounts with one courier need two names:
  one per pickup point.
- **`webhook`** is decision 45. `tokenHint` says it is shown once and how to get a new one, like a share link (step
  16).
- **`renewing` and `archiving`** ask first. Both say the effect that is easy to miss: a new token stops the old one
  at once (Steadfast's news are refused until it is pasted), and archiving the default leaves Packed with no default
  (28a.2 clears it in the same update), so `bodyDefault` is its own line. Both say that the parcels already on
  their way keep their news, because "archive" sounds like it could stop them.

```diff
@@ -5964,6 +6106,15 @@ export const en = {
       noMatchTitle: 'No order matches',
       noMatchBody: 'Check the number or the phone. The search looks in this tab only.',
       searchAll: 'Search every order',
+      // Step 28a: the packed orders with no parcel, for a courier's bulk upload (decision 19). The
+      // file's column names are the courier's, so they stay in code; its Note is `items_*`
+      exportCourier: 'Export for courier',
+      exporting: 'Exporting…',
+      exported_one: '{{formatted}} packed order in the file',
+      exported_other: '{{formatted}} packed orders in the file',
+      exportedMore:
+        'More orders wait than one file holds. Book these with the courier, then export again.',
+      exportEmpty: 'No packed order waits for a courier.',
       loadFailed: "Couldn't load the shop orders. Refresh the page to try again.",
     },
     // Step 27b: one order's page (/storefront/orders/$orderId): the next step's button, the
```

The orders list's export (decision 19, 46). `exported_*` uses `{{formatted}}` with `count`, like `items_*`, so the
number is in the reader's digits and the plural follows the count. `exportedMore` is the answer's `more`: the file
holds 500 orders, and the line says what to do with the rest. `exportEmpty` is a toast, not an empty file: a CSV
with only a header would upload as nothing and look like a failure on the courier's side.

```diff
@@ -5983,12 +6134,20 @@ export const en = {
       ship: 'Mark shipped',
       deliver: 'Mark delivered',
       cancel: 'Cancel order',
+      // Step 28a: on a packed order with no parcel on its way (or one that was cancelled)
+      book: 'Book courier',
       // The toasts. number = the order's (W-000123), the others the documents' own
       salesOrderMade: 'Sales order {{salesOrder}} made for {{number}}',
       packed: '{{number}} packed. Challan {{delivery}} posted.',
       shipped: '{{number}} shipped',
       delivered: '{{number}} delivered. Invoice {{invoice}} posted.',
       cancelled: '{{number}} cancelled. The shopper gets an SMS.',
+      // Step 28a. courier = the account's name, code = the tracking code
+      packedBooking:
+        '{{number}} packed. Challan {{delivery}} posted. Booking the parcel with {{courier}}.',
+      bookingStarted: 'Booking {{number}}’s parcel with {{courier}}',
+      booked: '{{number}} booked with {{courier}}, code {{code}}',
+      bookingAgain: 'Booking {{number}}’s parcel again',
       // The neutral document notice under the header: what the next step does
       next: {
         confirmed:
```

The order page's Book courier button and the toasts. `packedBooking` replaces `packed` when the Packed dialog
booked a parcel: it says the booking started, not that it worked, because the worker books it a moment later
(28a.3) and the parcel card shows how it went. `booked` is a manual parcel's toast: it is booked at once, with the
code the member typed.

```diff
@@ -6013,6 +6172,19 @@ export const en = {
       paidOnCod:
         'The shopper paid {{amount}} online too, then chose cash on delivery. Tell the rider to take no cash. If the rider took it as well, pay one back.',
       recordRefund: 'Record refund',
+      // Step 28a: the next step's line once the order has a parcel (decision 5). courier = the
+      // account's name. They replace next.packed and next.shipped
+      nextNoParcel: 'Book a courier, or mark it shipped when the parcel leaves the shop.',
+      nextBooking: 'Omnivo is booking the parcel with {{courier}}.',
+      nextBooked:
+        'The order moves to Shipped by itself when {{courier}}’s rider picks the parcel up.',
+      nextShipped:
+        'The order moves to Delivered by itself when {{courier}} delivers it. That posts the invoice.',
+      // A parcel booked by hand: the staff move the order, as before
+      nextManual: 'Mark it shipped when {{courier}} picks the parcel up.',
+      // The crit notice of a booking that failed (decision 4). reason = the error's own words
+      parcelFailed: '{{courier}} did not book the parcel. {{reason}}',
+      bookAgain: 'Book again',
       // Decision 1: the crit notice. reason = the error's own words (errors.*), a whole sentence
       documentError: 'The sales order could not be made. {{reason}}',
       // Decision 29: an order confirmed before 27b has no sales order and no error
```

The next step's line once the order has a parcel (decision 43). They are their own keys, not new entries in `next`,
because `next` has one entry per status (27d's `deliveredPaid` did the same). `nextNoParcel` replaces
`next.packed` on a packed order with no parcel, so the member sees both ways on. `parcelFailed` is the `crit`
notice of a booking that failed five times (decision 4), with the error's own words (`courier_rejected_parcel`,
`courier_rejected_keys`, `courier_unreachable` from 28a.1 each say what to do), and `bookAgain` is its action.

```diff
@@ -6107,6 +6279,79 @@ export const en = {
       deliverTitle: 'Mark {{number}} delivered?',
       deliverBody:
         'This posts an invoice for {{total}}, dated today. It stays unpaid until you record the money.',
+      // Step 28a: one card per parcel, newest first (storefrontShipmentSchema)
+      parcels: {
+        title: 'Parcel',
+        // An order booked again: number = the parcel's place, from 1
+        titleNumber: 'Parcel {{number}}',
+        // account = the courier account's name
+        description: 'Sent with {{account}}',
+        // The pill (SHIPMENT_STATUSES). The courier's steps on the card use the same words
+        statuses: {
+          booking: 'Booking',
+          booking_failed: 'Booking failed',
+          booked: 'Booked',
+          picked_up: 'Picked up',
+          in_transit: 'In transit',
+          out_for_delivery: 'Out for delivery',
+          delivered: 'Delivered',
+          partly_delivered: 'Partly delivered',
+          on_hold: 'On hold',
+          returning: 'Going back',
+          returned: 'Returned',
+          cancelled: 'Cancelled',
+        },
+        courier: 'Courier',
+        trackingCode: 'Tracking code',
+        consignmentId: 'Courier’s ID',
+        cod: 'Rider collects',
+        codNothing: 'Nothing: paid online',
+        bookedAt: 'Booked',
+        lastSynced: 'Last news',
+        neverSynced: 'None yet',
+        // While booking. count = the calls made so far (attempts)
+        bookingNow: 'Booking with {{courier}}…',
+        bookingRetry_one: 'Tried {{formatted}} time. Omnivo tries again by itself.',
+        bookingRetry_other: 'Tried {{formatted}} times. Omnivo tries again by itself.',
+        // A refused parcel: the courier's own words (errorDetail), as they came
+        courierSaid: 'The courier said: “{{detail}}”',
+        eventsTitle: 'The courier’s news',
+        noEvents: 'No news from the courier yet.',
+        manual: 'Booked by hand. Move the order with its buttons.',
+        printLabel: 'Print label',
+      },
+      // The Book courier dialog (bookShipment)
+      booking: {
+        title: 'Book a courier for {{number}}',
+        // amount = the order's codAmount
+        description:
+          'The courier gets the shopper’s name, mobile number and address, and what the rider collects: {{amount}}.',
+        descriptionPaid:
+          'The courier gets the shopper’s name, mobile number and address. The order is paid, so the rider collects nothing.',
+        account: 'Courier account',
+        accountPlaceholder: 'Pick an account',
+        // name = the account's, courier = the courier's name
+        accountOption: '{{name}} · {{courier}}',
+        apiHint:
+          'Omnivo books the parcel with {{courier}} now, and the courier’s news move the order.',
+        trackingCode: 'Tracking code',
+        trackingCodePlaceholder: 'SFR2611120042',
+        trackingCodeHint:
+          'Book the parcel on the courier’s website or app first, then type the code it gave.',
+        noAccounts: 'No active courier account yet. Add one in Shop couriers.',
+        submit: 'Book courier',
+      },
+      // The parcel's label, a print sheet (one per parcel)
+      label: {
+        title: 'Parcel label {{number}}',
+        from: 'From',
+        to: 'To',
+        order: 'Order',
+        // amount = the parcel's codAmount, always with paisa
+        collect: 'Collect {{amount}}',
+        paid: 'Paid. Collect nothing.',
+        courierLine: '{{courier}} · {{code}}',
+      },
       // The Packed dialog (decisions 5, 14, 15, 32)
       packing: {
         title: 'Pack {{number}}',
```

Three new blocks before the Packed dialog's words:

- **`parcels`** is the parcel card. `statuses` has exactly the keys of `SHIPMENT_STATUSES` (decision 42), and the
  card's list of the courier's steps uses the same words, so a step and the pill above it never disagree.
  `codNothing` says why the amount is zero, so nobody thinks the order lost its money. `bookingRetry_*` is shown
  while `attempts` is 1 or more: the member sees that Omnivo is still trying by itself (decision 4), so they do not
  press anything. `courierSaid` puts the courier's own words in quotes, because they are in the courier's language,
  not ours ("Invalid phone number"). `manual` says the buttons move a parcel booked by hand (decision 5).
- **`booking`** is the Book courier dialog. Its description says what the courier gets, and with `descriptionPaid`
  that an order paid online sends a zero amount; both use the order's `codAmount` (decision 20), the same amount the
  label and the export show. `apiHint` shows once an API account is picked, and the tracking code box once a manual
  one is; `trackingCodeHint` says the order of work (book on the courier's site first), because the code does not
  exist before that.
- **`label`** is the parcel's print sheet. `collect` always has paisa (it is printed, like the POS receipt), and
  `paid` says plainly not to take money: a rider who sees a blank amount may ask for the order's total.

```diff
@@ -6132,6 +6377,11 @@ export const en = {
         // needed = the line's quantity
         serialsHint: 'One per line, or scan them. This line needs {{needed}}.',
         serialsCount: '{{entered}} of {{needed}} typed',
+        // Step 28a (decision 13): API accounts only, starting with the default
+        courier: 'Send with',
+        courierNone: 'Don’t book now',
+        courierHint: 'Omnivo books the parcel with {{courier}} once the challan is posted.',
+        courierNoneHint: 'Book it later with Book courier, or by hand on the courier’s website.',
         submit: 'Mark packed',
         loadFailed: "Couldn't load what to pack. Close this and try again.",
       },
```

The Packed dialog's courier select (decision 13): API accounts only, starting with the default. Each choice has its
own hint, so the person packing knows whether a rider is coming or they still have to book it.

```diff
@@ -6142,6 +6392,9 @@ export const en = {
           'The stock held for it is free again, and its sales order is cancelled. The shopper gets an SMS that the order was cancelled.',
         bodyPacked:
           'A sales return brings the packed goods back into stock, and the sales order is cancelled. The shopper gets an SMS that the order was cancelled.',
+        // Step 28a (decision 21): the order has a booked parcel. courier = the account's name
+        parcelBooked:
+          'Its parcel booked with {{courier}} is cancelled here too. Cancel it on the courier’s panel as well, so no rider comes for it.',
         reason: 'Why',
         reasonPlaceholder: 'The shopper did not answer the phone',
         reasonHint: 'Only your team sees this. The SMS does not say why.',
```

The Cancel dialog of an order with a booked parcel (decision 21). Steadfast has no cancel call in what 28a uses, so
the parcel is cancelled in Omnivo (28a.3) and the line asks the member to cancel it on the courier's panel too.
Without it, a rider comes for a parcel that is not there.

```diff
@@ -7542,6 +7795,14 @@ export const en = {
       feeAccount: 'Gateway fee account',
       password: 'Password',
       testResult: 'Test result',
+      // Step 28a: a courier account and a parcel. The keys' and the token's change say only
+      // "changed"
+      provider: 'How it books',
+      courier: 'Courier',
+      keys: 'Keys',
+      webhookToken: 'Webhook token',
+      defaultCourier: 'Books first',
+      trackingCode: 'Tracking code',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

The audit log's names for what 28a.3 writes into `changes`: the account's snapshot (`provider`, `courier`), the
words "changed" under `keys` and `webhookToken` (never a value), the default's name, and a manual parcel's tracking
code. `courier` serves both: an account's courier and the account a parcel was booked with.

### `locales/bn.ts`

```diff
@@ -140,6 +140,8 @@ export const bn: Messages = {
     storefrontOrders: 'শপের অর্ডার',
     // ধাপ ২৭c: ক্যাটালগের পরে, দুটোই শপের দাম নিয়ে (সিদ্ধান্ত ২৯)
     storefrontCoupons: 'শপের কুপন',
+    // Step 28a
+    storefrontCouriers: 'শপের কুরিয়ার',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -5080,6 +5082,131 @@ export const bn: Messages = {
       updated: 'পেমেন্ট গেটওয়ে সেভ হয়েছে',
       loadFailed: 'পেমেন্ট গেটওয়ে আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     },
+    // Step 28a
+    couriers: {
+      title: 'শপের কুরিয়ার',
+      description:
+        'আপনার পার্সেল যে কুরিয়ারগুলোতে যায়, আর প্যাক করার ডায়ালগ প্রথমে যেটায় বুক করে',
+      add: 'কুরিয়ার অ্যাকাউন্ট যোগ করুন',
+      view: 'দেখান',
+      views: { active: 'চালু', archived: 'আর্কাইভ করা' },
+      statuses: { active: 'চালু', archived: 'আর্কাইভ করা' },
+      isDefault: 'প্রথমে এটায় বুক হয়',
+      providers: {
+        steadfast: '{{courier}} · এর API দিয়ে বুক হয়',
+        manual: '{{courier}} · হাতে বুক করা হয়',
+      },
+      names: {
+        pathao: 'Pathao',
+        steadfast: 'Steadfast',
+        redx: 'RedX',
+        ecourier: 'eCourier',
+        paperfly: 'Paperfly',
+      },
+      columns: {
+        account: 'অ্যাকাউন্ট',
+        news: 'কুরিয়ারের খবর',
+        test: 'শেষ পরীক্ষা',
+        status: 'অবস্থা',
+      },
+      newsAt: 'শেষ এসেছে {{date}}',
+      newsNever: 'এখনো আসেনি',
+      newsNeverHint:
+        'কুরিয়ারের প্যানেলে webhook পেস্ট করুন। ততক্ষণ Omnivo প্রতি ১৫ মিনিটে জিজ্ঞেস করে।',
+      newsManual: 'হাতে এগোনো হয়',
+      neverTested: 'পরীক্ষা হয়নি',
+      testWorked: 'key মেনেছে {{date}}',
+      testRejected: 'key মানেনি {{date}}',
+      testUnreachable: 'উত্তর আসেনি {{date}}',
+      actionsFor: '{{name}}-এর কাজ',
+      edit: 'বদলান',
+      test: 'কানেকশন পরীক্ষা করুন',
+      renewToken: 'নতুন webhook token',
+      archive: 'আর্কাইভ করুন',
+      restore: 'ফিরিয়ে আনুন',
+      testedWorked: '{{courier}} key মেনে নিয়েছে',
+      testedRejected: '{{courier}} key মানেনি। বদলান-এ গিয়ে দেখে নিন।',
+      testedUnreachable: '{{courier}} উত্তর দেয়নি। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
+      emptyTitle: 'এখনো কোনো কুরিয়ার অ্যাকাউন্ট নেই',
+      emptyBody:
+        'অর্ডার প্যাক হওয়ার সাথে সাথে পার্সেল বুক করতে আপনার Steadfast অ্যাকাউন্ট যোগ করুন, অথবা যে কুরিয়ারে হাতে বুক করেন সেটা যোগ করুন, যাতে তার ট্র্যাকিং কোড অর্ডারে থাকে।',
+      archivedEmptyTitle: 'আর্কাইভ করা কোনো কুরিয়ার অ্যাকাউন্ট নেই',
+      archivedEmptyBody:
+        'যে অ্যাকাউন্ট আর্কাইভ করবেন তা এখানে দেখাবে। এর যে পার্সেল পথে আছে, সেগুলোর খবর তখনো আসে।',
+      loadFailed: 'কুরিয়ার অ্যাকাউন্ট আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+      default: {
+        title: 'প্যাক করার সময় বুক',
+        description:
+          'প্যাক করার ডায়ালগ যে কুরিয়ার দিয়ে শুরু হয়। যিনি প্যাক করেন তিনি তখনো বদলাতে পারেন।',
+        label: 'যেটায় বুক হবে',
+        none: 'প্যাক করার সময় বুক করবেন না',
+        hint: 'শুধু API দিয়ে বুক করে এমন অ্যাকাউন্ট। কোনোটা না বাছলে পার্সেল বুক হয় "কুরিয়ারে বুক করুন" দিয়ে, অথবা হাতে।',
+        noApiAccount:
+          'অর্ডার প্যাক হওয়ার সাথে সাথে পার্সেল বুক করতে একটা Steadfast অ্যাকাউন্ট যোগ করুন।',
+        save: 'সেভ করুন',
+        saved: 'প্যাক করার সময় প্রথমে {{name}}-এ বুক হবে',
+        cleared: 'প্যাক করার সময় প্রথমে কোনো কুরিয়ারে বুক হবে না',
+      },
+      form: {
+        addTitle: 'কুরিয়ার অ্যাকাউন্ট যোগ করুন',
+        editTitle: '{{name}} বদলান',
+        provider: 'যেভাবে বুক হয়',
+        providers: { steadfast: 'Steadfast, এর API দিয়ে', manual: 'অন্য কুরিয়ার, হাতে' },
+        providerHints: {
+          steadfast:
+            'Omnivo প্রতিটা পার্সেল Steadfast-এ বুক করে, আর Steadfast-এর খবরে অর্ডার এগোয়।',
+          manual:
+            'আপনি কুরিয়ারের নিজের ওয়েবসাইট বা অ্যাপে বুক করেন, তারপর তার ট্র্যাকিং কোড অর্ডারে লেখেন।',
+        },
+        providerFixed:
+          'অ্যাকাউন্টের কুরিয়ার বদলানো যায় না। অন্য কুরিয়ারের জন্য নতুন অ্যাকাউন্ট যোগ করুন।',
+        name: 'নাম',
+        namePlaceholder: 'Steadfast ঢাকা',
+        nameHint:
+          'শুধু আপনার টিম এটা দেখে। এক কুরিয়ারে দুটো অ্যাকাউন্ট থাকলে, প্রতি পিকআপ পয়েন্টে একটা, দুটো আলাদা নাম লাগবে।',
+        apiKey: 'API key',
+        secretKey: 'Secret key',
+        keysHint: 'দুটোই আপনার Steadfast প্যানেলের API পেজে আছে।',
+        keySavedPlaceholder: 'সেভ করা আছে',
+        keysSavedHint:
+          'key সেভ করা আছে, কখনো দেখানো হয় না। কোনো key রেখে দিতে তার বক্স খালি রাখুন, বদলাতে নতুনটা লিখুন।',
+        courier: 'কুরিয়ার',
+        courierPlaceholder: 'একটা কুরিয়ার বাছুন',
+        courierHint: 'যার ওয়েবসাইট বা অ্যাপে বুক করেন। ট্র্যাকিং পেজে এর নাম দেখায়।',
+        create: 'অ্যাকাউন্ট যোগ করুন',
+        save: 'বদল সেভ করুন',
+        created: 'কুরিয়ার অ্যাকাউন্ট {{name}} যোগ হয়েছে',
+        updated: 'কুরিয়ার অ্যাকাউন্ট সেভ হয়েছে',
+      },
+      webhook: {
+        title: 'Steadfast-এ webhook পেস্ট করুন',
+        description:
+          'Steadfast প্রতিটা পার্সেলের খবর এই ঠিকানায় পাঠায়। আপনার Steadfast প্যানেলের webhook সেটিংসে দুটোই পেস্ট করুন।',
+        url: 'Callback URL',
+        token: 'Auth token (Bearer)',
+        tokenHint: 'শুধু এই একবার দেখানো হয়। হারালে অ্যাকাউন্টের মেনু থেকে নতুন একটা বানান।',
+        copyUrl: 'URL কপি করুন',
+        copyToken: 'token কপি করুন',
+        copied: 'কপি হয়েছে',
+        poll: 'প্রথম খবর আসা পর্যন্ত Omnivo প্রতি ১৫ মিনিটে Steadfast-কে জিজ্ঞেস করে, তাই অর্ডার তখনো এগোয়, শুধু একটু পরে।',
+        done: 'হয়ে গেছে',
+      },
+      renewing: {
+        title: '{{name}}-এর জন্য নতুন webhook token বানাবেন?',
+        body: 'পুরনো token সাথে সাথে কাজ বন্ধ করবে। নতুনটা Steadfast-এর প্যানেলে পেস্ট না করা পর্যন্ত এর খবর ফিরিয়ে দেওয়া হবে।',
+        submit: 'নতুন token বানান',
+      },
+      archiving: {
+        title: '{{name}} আর্কাইভ করবেন?',
+        body: 'এটা দিয়ে আর কোনো নতুন পার্সেল যাবে না। এর যে পার্সেল পথে আছে, সেগুলোর খবর তখনো আসবে।',
+        bodyDefault:
+          'এটা দিয়ে আর কোনো নতুন পার্সেল যাবে না, আর প্যাক করার সময় প্রথমে কোনো কুরিয়ারে বুক হবে না। এর যে পার্সেল পথে আছে, সেগুলোর খবর তখনো আসবে।',
+        submit: 'অ্যাকাউন্ট আর্কাইভ করুন',
+      },
+      archived: '{{name}} আর্কাইভ হয়েছে',
+      restored: '{{name}} ফিরিয়ে আনা হয়েছে',
+      tokenRenewed: 'নতুন webhook token বানানো হয়েছে',
+    },
     categories: {
       title: 'শপের ক্যাটাগরি',
       description: 'শপ তার লিস্টিংগুলো যেভাবে সাজায়, মেনুতে যে ক্রমে দেখায়',
@@ -5516,6 +5643,14 @@ export const bn: Messages = {
       noMatchTitle: 'কোনো অর্ডার মেলেনি',
       noMatchBody: 'নম্বর বা ফোন মিলিয়ে দেখুন। খোঁজা হয় শুধু এই ট্যাবে।',
       searchAll: 'সব অর্ডারে খুঁজুন',
+      // Step 28a
+      exportCourier: 'কুরিয়ারের জন্য এক্সপোর্ট',
+      exporting: 'এক্সপোর্ট হচ্ছে…',
+      exported_one: 'ফাইলে প্যাক করা {{formatted}}টা অর্ডার',
+      exported_other: 'ফাইলে প্যাক করা {{formatted}}টা অর্ডার',
+      exportedMore:
+        'একটা ফাইলে যত ধরে, তার চেয়ে বেশি অর্ডার অপেক্ষায় আছে। এগুলো কুরিয়ারে বুক করুন, তারপর আবার এক্সপোর্ট করুন।',
+      exportEmpty: 'কোনো প্যাক করা অর্ডার কুরিয়ারের অপেক্ষায় নেই।',
       loadFailed: 'শপের অর্ডার আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
     },
     // ধাপ ২৭b: একটা অর্ডারের পেজ (/storefront/orders/$orderId)
@@ -5532,11 +5667,19 @@ export const bn: Messages = {
       ship: 'পাঠানো হয়েছে বলে চিহ্ন দিন',
       deliver: 'পৌঁছেছে বলে চিহ্ন দিন',
       cancel: 'অর্ডার বাতিল করুন',
+      // Step 28a
+      book: 'কুরিয়ারে বুক করুন',
       salesOrderMade: '{{number}}-এর সেলস অর্ডার {{salesOrder}} বানানো হয়েছে',
       packed: '{{number}} প্যাক হয়েছে। চালান {{delivery}} পোস্ট হয়েছে।',
       shipped: '{{number}} পাঠানো হয়েছে',
       delivered: '{{number}} পৌঁছেছে। ইনভয়েস {{invoice}} পোস্ট হয়েছে।',
       cancelled: '{{number}} বাতিল হয়েছে। ক্রেতা একটা SMS পাবেন।',
+      // Step 28a
+      packedBooking:
+        '{{number}} প্যাক হয়েছে। চালান {{delivery}} পোস্ট হয়েছে। পার্সেল {{courier}}-এ বুক হচ্ছে।',
+      bookingStarted: '{{number}}-এর পার্সেল {{courier}}-এ বুক হচ্ছে',
+      booked: '{{number}} {{courier}}-এ বুক হয়েছে, কোড {{code}}',
+      bookingAgain: '{{number}}-এর পার্সেল আবার বুক হচ্ছে',
       next: {
         confirmed:
           'মাল প্যাক করে প্যাক হয়েছে বলে চিহ্ন দিন। তাতে চালান পোস্ট হয়, স্টক বের হয়, আর আটকে রাখা স্টক ছাড়া পায়।',
@@ -5553,6 +5696,17 @@ export const bn: Messages = {
       paidOnCod:
         'ক্রেতা অনলাইনেও {{amount}} দিয়েছেন, তারপর ক্যাশ অন ডেলিভারি বেছেছেন। রাইডারকে নগদ না নিতে বলুন। রাইডার নগদও নিয়ে থাকলে একটা ফেরত দিন।',
       recordRefund: 'রিফান্ড লিখুন',
+      // Step 28a
+      nextNoParcel:
+        'কুরিয়ারে বুক করুন, অথবা পার্সেল দোকান থেকে বের হলে পাঠানো হয়েছে বলে চিহ্ন দিন।',
+      nextBooking: 'Omnivo পার্সেলটা {{courier}}-এ বুক করছে।',
+      nextBooked:
+        '{{courier}}-এর রাইডার পার্সেল নিয়ে গেলে অর্ডার নিজে থেকেই পাঠানো হয়েছে-তে যাবে।',
+      nextShipped:
+        '{{courier}} পৌঁছে দিলে অর্ডার নিজে থেকেই পৌঁছেছে-তে যাবে। তাতে ইনভয়েস পোস্ট হয়।',
+      nextManual: '{{courier}} পার্সেল নিয়ে গেলে পাঠানো হয়েছে বলে চিহ্ন দিন।',
+      parcelFailed: '{{courier}} পার্সেলটা বুক করেনি। {{reason}}',
+      bookAgain: 'আবার বুক করুন',
       documentError: 'সেলস অর্ডার বানানো যায়নি। {{reason}}',
       noSalesOrder: 'এই অর্ডারের এখনো সেলস অর্ডার নেই। মাল প্যাকের আগে বানান।',
       linesTitle: 'পণ্য',
@@ -5625,6 +5779,68 @@ export const bn: Messages = {
       deliverTitle: '{{number}} পৌঁছেছে বলে চিহ্ন দেবেন?',
       deliverBody:
         'এতে আজকের তারিখে {{total}}-এর একটা ইনভয়েস পোস্ট হবে। টাকা জমা না লেখা পর্যন্ত এটা বাকি থাকে।',
+      // Step 28a
+      parcels: {
+        title: 'পার্সেল',
+        titleNumber: 'পার্সেল {{number}}',
+        description: '{{account}} দিয়ে পাঠানো',
+        statuses: {
+          booking: 'বুক হচ্ছে',
+          booking_failed: 'বুকিং ব্যর্থ',
+          booked: 'বুক হয়েছে',
+          picked_up: 'নিয়ে গেছে',
+          in_transit: 'পথে আছে',
+          out_for_delivery: 'ডেলিভারির জন্য বের হয়েছে',
+          delivered: 'পৌঁছেছে',
+          partly_delivered: 'আংশিক পৌঁছেছে',
+          on_hold: 'আটকে আছে',
+          returning: 'ফেরত যাচ্ছে',
+          returned: 'ফেরত এসেছে',
+          cancelled: 'বাতিল',
+        },
+        courier: 'কুরিয়ার',
+        trackingCode: 'ট্র্যাকিং কোড',
+        consignmentId: 'কুরিয়ারের আইডি',
+        cod: 'রাইডার নেবেন',
+        codNothing: 'কিছু না: অনলাইনে পেমেন্ট হয়েছে',
+        bookedAt: 'বুক হয়েছে',
+        lastSynced: 'শেষ খবর',
+        neverSynced: 'এখনো আসেনি',
+        bookingNow: '{{courier}}-এ বুক হচ্ছে…',
+        bookingRetry_one: '{{formatted}} বার চেষ্টা হয়েছে। Omnivo নিজে থেকেই আবার চেষ্টা করবে।',
+        bookingRetry_other: '{{formatted}} বার চেষ্টা হয়েছে। Omnivo নিজে থেকেই আবার চেষ্টা করবে।',
+        courierSaid: 'কুরিয়ার বলেছে: “{{detail}}”',
+        eventsTitle: 'কুরিয়ারের খবর',
+        noEvents: 'কুরিয়ারের কাছ থেকে এখনো কোনো খবর আসেনি।',
+        manual: 'হাতে বুক করা। অর্ডারের বাটন দিয়ে অর্ডার এগিয়ে নিন।',
+        printLabel: 'লেবেল প্রিন্ট করুন',
+      },
+      booking: {
+        title: '{{number}}-এর জন্য কুরিয়ারে বুক করুন',
+        description:
+          'কুরিয়ার পাবে ক্রেতার নাম, মোবাইল নম্বর আর ঠিকানা, আর রাইডার যা নেবেন: {{amount}}।',
+        descriptionPaid:
+          'কুরিয়ার পাবে ক্রেতার নাম, মোবাইল নম্বর আর ঠিকানা। অর্ডারের পেমেন্ট হয়ে গেছে, তাই রাইডার কিছু নেবেন না।',
+        account: 'কুরিয়ার অ্যাকাউন্ট',
+        accountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+        accountOption: '{{name}} · {{courier}}',
+        apiHint: 'Omnivo এখনই পার্সেলটা {{courier}}-এ বুক করবে, আর কুরিয়ারের খবরে অর্ডার এগোবে।',
+        trackingCode: 'ট্র্যাকিং কোড',
+        trackingCodePlaceholder: 'SFR2611120042',
+        trackingCodeHint:
+          'আগে কুরিয়ারের ওয়েবসাইট বা অ্যাপে পার্সেল বুক করুন, তারপর তার দেওয়া কোড লিখুন।',
+        noAccounts: 'এখনো কোনো চালু কুরিয়ার অ্যাকাউন্ট নেই। শপের কুরিয়ার পেজে একটা যোগ করুন।',
+        submit: 'কুরিয়ারে বুক করুন',
+      },
+      label: {
+        title: 'পার্সেলের লেবেল {{number}}',
+        from: 'যেখান থেকে',
+        to: 'যার কাছে',
+        order: 'অর্ডার',
+        collect: '{{amount}} নিন',
+        paid: 'পেমেন্ট হয়ে গেছে। কিছু নেবেন না।',
+        courierLine: '{{courier}} · {{code}}',
+      },
       packing: {
         title: '{{number}} প্যাক করুন',
         description:
@@ -5643,6 +5859,12 @@ export const bn: Messages = {
         serials: 'সিরিয়াল নম্বর',
         serialsHint: 'প্রতি লাইনে একটা, বা স্ক্যান করুন। এই লাইনে লাগবে {{needed}}টা।',
         serialsCount: '{{needed}}টার {{entered}}টা লেখা হয়েছে',
+        // Step 28a
+        courier: 'যেটা দিয়ে পাঠাবেন',
+        courierNone: 'এখন বুক করবেন না',
+        courierHint: 'চালান পোস্ট হলে Omnivo পার্সেলটা {{courier}}-এ বুক করবে।',
+        courierNoneHint:
+          'পরে "কুরিয়ারে বুক করুন" দিয়ে বুক করুন, অথবা কুরিয়ারের ওয়েবসাইটে হাতে।',
         submit: 'প্যাক হয়েছে বলে চিহ্ন দিন',
         loadFailed: 'কী প্যাক করতে হবে তা আনা যায়নি। এটা বন্ধ করে আবার চেষ্টা করুন।',
       },
@@ -5652,6 +5874,9 @@ export const bn: Messages = {
           'এর জন্য আটকে রাখা স্টক আবার ছাড়া পাবে, আর এর সেলস অর্ডার বাতিল হবে। ক্রেতা অর্ডার বাতিলের একটা SMS পাবেন।',
         bodyPacked:
           'একটা সেলস রিটার্ন প্যাক করা মাল স্টকে ফেরত আনবে, আর সেলস অর্ডার বাতিল হবে। ক্রেতা অর্ডার বাতিলের একটা SMS পাবেন।',
+        // Step 28a
+        parcelBooked:
+          '{{courier}}-এ বুক করা এর পার্সেলও এখানে বাতিল হবে। কুরিয়ারের প্যানেলেও বাতিল করুন, যাতে কোনো রাইডার এটা নিতে না আসে।',
         reason: 'কারণ',
         reasonPlaceholder: 'ক্রেতা ফোন ধরেননি',
         reasonHint: 'শুধু আপনার টিম এটা দেখে। SMS-এ কারণ বলা হয় না।',
@@ -6984,6 +7209,13 @@ export const bn: Messages = {
       feeAccount: 'গেটওয়ের ফি-এর অ্যাকাউন্ট',
       password: 'পাসওয়ার্ড',
       testResult: 'পরীক্ষার ফল',
+      // Step 28a
+      provider: 'যেভাবে বুক হয়',
+      courier: 'কুরিয়ার',
+      keys: 'Key',
+      webhookToken: 'Webhook token',
+      defaultCourier: 'প্রথমে যেটায় বুক হয়',
+      trackingCode: 'ট্র্যাকিং কোড',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
```

The same keys in Bangla; the type check fails if one is missing. "কুরিয়ারে বুক করুন" is the Book courier button
that 28a.1's `courier_account_not_bookable` already names, and "শপের কুরিয়ার" is the page that its key errors
point to, so the error and the screen say one thing. API key, Secret key, webhook token, Callback URL and Auth token
(Bearer) stay in English, like 28a.1's errors, because they are the words on Steadfast's own panel (decision 45).
The parcel's pills are short (নিয়ে গেছে, আটকে আছে); the shop's longer sentences for the same steps stay the
shopper's.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/shop typecheck
```

The i18n checks pass. The i18n tests include the check that every Bangla string keeps the English one's
`{{placeholders}}`, so a Bangla line that dropped `{{courier}}` fails here, not on the screen. The shop type check
passes. The app type check still fails, and only with the errors 28a.1 expected (the bell's link map and the mock
orders; the pack form type-checks since 28a.3 gave `courierAccountId` a default), which 28a.6 and 28a.7 fix. No screen uses the words yet: 28a.6 uses them, and 28a.8 looks
for words no screen uses and takes them out.

Broken on purpose, to see that the checks notice:

- `booking_failed` taken out of the Bangla parcel statuses: the i18n type check fails (`Property 'booking_failed'
  is missing`).
- `{{courier}}` taken out of the Bangla `nextBooked`: the placeholder test fails.

## 28a.6 — The ERP screens

Everything a person sees of couriers in the ERP: the new Storefront → Shop couriers page with its dialogs, the parcel
cards and Book courier on a shop order's page, "Send with" in the Packed dialog, a warning in the Cancel dialog,
"Export for courier" on the orders list, the parcel's label, and the bell's link. The mockup was approved with no
change ("R", 2026-11-23). The mock API comes in 28a.7, so these screens are first seen in the browser there.

Decisions approved with the mockup:

- **"None yet" is `warn`** on an API account whose news never reached us, with a line that says to paste the
  webhook. A tenant who forgot the webhook finds out here, not from a parcel that never moved.
- **The parcel card sits under Items and before Payments.** With more than one parcel, the newest comes first
  ("Parcel 2" above "Parcel 1").
- **The courier's news are newest first,** like the shop's tracking page. The order's own Timeline stays oldest
  first.
- **The parcel pills:** work on its way is `brand`, delivered is `good`, a failed booking is `crit`, what the shop
  must act on (on hold, going back, partly delivered) is `warn`, returned and cancelled are neutral.
- **"Export for courier" is on every tab** of Shop orders: it always exports the packed orders with no parcel.
- **The label is A6,** black on white, no barcode, the amount always with paisa.
- **Mark shipped stays** while an API parcel is on its way, as a way out when the courier's news are late.
- **The Cancel dialog's line about a booked parcel is `warn`:** the member must cancel it on the courier's panel too.

Mine, made while writing:

47. **A short read of the courier accounts for the packer.** The Packed dialog and Book courier are for
    `storefront.order.manage`, but the accounts page needs `storefront.manage`, so a packer could not see any
    account to pick. `GET /storefront/orders/courier-choices` answers the active accounts (id, provider, name,
    courier) and the default, and nothing else. It is an order route, like the export (decision 18).
48. **Book courier stays in the header while a failed parcel waits.** "Book again" (in the crit notice) books the
    same parcel with the same account. Book courier lets the shop pick another account, for example one booked by
    hand when the courier refuses the shopper's phone number.
49. **The label's "From" is the company** (its legal name, address and phone), which every print sheet already
    reads and every member may read. The shop's own settings need `storefront.manage`.
50. **The export file has a byte order mark and a guard against formulas.** Without the mark, Excel shows a Bangla
    name as question marks. A name or an address that starts with `=`, `+`, `-` or `@` gets a `'` in front, so it
    is never run as a formula.
51. **The order page asks again every 3 seconds while a parcel is booking,** and stops once it is booked or failed.
52. **One new word, `storefront.couriers.columns.actions`** (en and bn), the hidden header of the row menu's
    column, like the coupons page has.
53. **The tracking page sorts steps of one courier second by when they arrived** (the user's choice, 2026-11-23).
    It needs a new grant (0079), so it is in this part, although it is not a screen of the ERP.

### A read for the packer

```diff
@@ -235,6 +235,18 @@ export const bookShipmentInputSchema = z.object({
 export type BookShipmentInput = z.infer<typeof bookShipmentInputSchema>;
 export type BookShipmentFormValues = z.input<typeof bookShipmentInputSchema>;
 
+// What the Packed dialog and "Book courier" offer (found in 28a.6). Those two are for the packer
+// (storefront.order.manage), who may not read the Shop couriers page (storefront.manage), so they
+// get their own short read: the active accounts by name, never a webhook address or a test, and
+// the default the Packed dialog starts with. Active ones only: an archived account books nothing
+export const courierChoicesSchema = z.object({
+  accounts: z.array(
+    courierAccountSchema.pick({ id: true, provider: true, name: true, courier: true }),
+  ),
+  defaultAccountId: z.uuid().nullable(),
+});
+export type CourierChoices = z.infer<typeof courierChoicesSchema>;
+
 // ---------------------------------------------------------------------------------------------
 // The export for a courier's own panel (the manual way, decision 2)
 
```

`courierChoicesSchema` picks four fields of the account with `.pick()`, so it can never drift from the account's
own shape, and it leaves out the webhook address, the tests and the version: a packer needs a name to pick, nothing
more. Active accounts only, because an archived one books nothing. The page shows manual accounts too (Book courier
needs them); the Packed dialog filters them out itself.

```diff
@@ -9,6 +9,7 @@ import { quantitySchema } from './quantities.js';
 import { documentRefSchema } from './sales.js';
 import {
   bookShipmentInputSchema,
+  courierChoicesSchema,
   courierExportSchema,
   storefrontShipmentSchema,
 } from './shipping.js';
@@ -344,6 +345,17 @@ export const storefrontOrderRoutes = {
     status: 200,
     response: courierExportSchema,
   }),
+  // Step 28a.6: the accounts the Packed dialog and Book courier offer, for a packer without
+  // storefront.manage. Before getOrder too
+  courierChoices: defineRoute({
+    method: 'GET',
+    path: '/storefront/orders/courier-choices',
+    summary: 'The active courier accounts a packer can book with, and the default one',
+    auth: 'bearer',
+    permission: 'storefront.order.manage',
+    status: 200,
+    response: courierChoicesSchema,
+  }),
   getOrder: defineRoute({
     method: 'GET',
     path: '/storefront/orders/:id',
```

The route sits next to the export and has the same permission. Its path is under `/storefront/orders/`, so in the
controller it must be declared before `getOrder`, or "courier-choices" would reach `getOrder` as an order id.

```diff
@@ -168,8 +168,8 @@ describe('the routes', () => {
   });
 
   it('book with storefront.order.manage, like every other move of an order', () => {
-    const { bookShipment, retryShipment, courierExport } = storefrontOrderRoutes;
-    for (const route of [bookShipment, retryShipment, courierExport]) {
+    const { bookShipment, retryShipment, courierExport, courierChoices } = storefrontOrderRoutes;
+    for (const route of [bookShipment, retryShipment, courierExport, courierChoices]) {
       expect(route.permission).toBe('storefront.order.manage');
     }
   });
```

```diff
@@ -181,13 +181,15 @@ describe('the routes', () => {
 
   // Decision 9: a packer reads and moves orders without storefront.manage (the shop's prices and
   // pages), and every move is .manage, never .read. Two reads are .manage too: the pack plan, and
-  // (step 28a) the courier export, which is for booking and holds many shoppers' phones at once
+  // (step 28a) the courier export, which is for booking and holds many shoppers' phones at once,
+  // and the courier choices, which only the one who books needs
   it('read with storefront.order.read and change with storefront.order.manage', () => {
     for (const route of routes) {
       const changes =
         route.method !== 'GET' ||
         route.path.endsWith('/pack-plan') ||
-        route.path.endsWith('/courier-export');
+        route.path.endsWith('/courier-export') ||
+        route.path.endsWith('/courier-choices');
       expect([route.path, route.permission]).toEqual([
         route.path,
         changes ? 'storefront.order.manage' : 'storefront.order.read',
```

The two permission tests know the new route. The second one says why a GET is `.manage` here: only the person who
books needs the list.

```diff
@@ -1,5 +1,6 @@
 import {
   COURIER_EXPORT_MAX_ROWS,
+  type CourierChoices,
   type CourierExport,
   isErrorCode,
   isOpenShipment,
@@ -14,7 +15,7 @@ import {
   storefrontShipmentEvents,
   storefrontShipments,
 } from '@omnivo/db';
-import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
+import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
 
 import { audit, created } from '../../common/audit/audit.js';
 import { isUniqueViolation } from '../../common/db/pg-errors.js';
@@ -399,6 +400,27 @@ export const parcelNeedsAttention = sql<boolean>`(storefront_orders.status = 'pa
     )
 ))`;
 
+// Step 28a.6: what the Packed dialog and Book courier offer (courierChoicesSchema). Active
+// accounts only, by name. The default comes from the same rows: 28a.2's check keeps it an active
+// API account, so it is always one of them
+export async function courierChoicesOf(tx: Transaction): Promise<CourierChoices> {
+  const rows = await tx
+    .select({
+      id: courierAccounts.id,
+      provider: courierAccounts.provider,
+      name: courierAccounts.name,
+      courier: courierAccounts.courier,
+      isDefault: courierAccounts.isDefault,
+    })
+    .from(courierAccounts)
+    .where(and(eq(courierAccounts.tenantId, getTenantId()), isNull(courierAccounts.archivedAt)))
+    .orderBy(asc(courierAccounts.name), asc(courierAccounts.id));
+  return {
+    accounts: rows.map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
+    defaultAccountId: rows.find((row) => row.isDefault)?.id ?? null,
+  };
+}
+
 // The export for a courier's bulk upload (decision 19): the packed orders with no parcel on its
 // way, oldest packed first, at most COURIER_EXPORT_MAX_ROWS. The invoice is the one the order's
 // next parcel gets, so the code typed back into "Book courier" matches what the courier's panel
```

`courierChoicesOf` reads the accounts in the caller's tenant transaction, so row level security limits it to the
workspace, like every other read. The default comes from the same rows: 28a.2's check keeps the default an active
API account, so it is always among them, and there is no second query.

```diff
@@ -2,6 +2,7 @@ import { Inject, Injectable } from '@nestjs/common';
 import {
   type BookShipmentInput,
   compareQuantity,
+  type CourierChoices,
   type CourierExport,
   type DocumentRef,
   type ErrorCode,
@@ -72,6 +73,7 @@ import {
 import { codAmountOf, historyOf, type OrderRow } from './order-view.js';
 import {
   cancelShipments,
+  courierChoicesOf,
   courierExportRows,
   followOrder,
   parcelNeedsAttention,
@@ -518,6 +520,11 @@ export class StorefrontOrdersService {
   }
 
   // Step 28a (decision 19): the rows for a courier's bulk upload
+  // Step 28a.6: the Packed dialog's and Book courier's accounts
+  courierChoices(): Promise<CourierChoices> {
+    return this.withTenant((tx) => courierChoicesOf(tx));
+  }
+
   courierExport(): Promise<CourierExport> {
     return this.withTenant((tx) => courierExportRows(tx));
   }
```

```diff
@@ -33,6 +33,12 @@ export class StorefrontOrdersController {
     return this.orders.courierExport();
   }
 
+  // Step 28a.6: before getOrder too
+  @Endpoint(routes.storefrontOrders.courierChoices)
+  courierChoices(): Promise<RouteResponse<Routes['courierChoices']>> {
+    return this.orders.courierChoices();
+  }
+
   @Endpoint(routes.storefrontOrders.getOrder)
   getOrder({ params }: RouteInput<Routes['getOrder']>): Promise<RouteResponse<Routes['getOrder']>> {
     return this.orders.get(params.id);
```

The service wraps the read in `withTenant`, and the controller declares it before `getOrder` (see above).

```diff
@@ -6,6 +6,7 @@ import {
   type CourierAccount,
   courierAccountSavedSchema,
   courierAccountSchema,
+  courierChoicesSchema,
   courierExportSchema,
   courierSetupSchema,
   invoiceSchema,
@@ -758,7 +759,7 @@ describe('Shop couriers', () => {
     }
   });
 
-  it('gives the accounts to storefront.manage only', async () => {
+  it('gives the accounts to storefront.manage only, and their names to the packer', async () => {
     const packer = await member('rafiq@nirvor.com', 'Rafiq Islam', [
       'storefront.order.read',
       'storefront.order.manage',
@@ -771,6 +772,25 @@ describe('Shop couriers', () => {
     ] as const) {
       expect((await send(method, url, body, packer)).statusCode).toBe(403);
     }
+    // 28a.6: the packer still gets what the Packed dialog and Book courier offer: the active
+    // accounts by name and the default, the same as the page's read, never a webhook address
+    const page = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
+    const choices = await send('GET', '/storefront/orders/courier-choices', undefined, packer);
+    expect(choices.statusCode, choices.body).toBe(200);
+    const read = courierChoicesSchema.parse(choices.json());
+    // By id on both sides: the API sorts by name in the database's collation, which is not JS's
+    const byId = <T extends { id: string }>(rows: T[]) =>
+      [...rows].sort((a, b) => a.id.localeCompare(b.id));
+    expect(byId(read.accounts)).toEqual(
+      byId(
+        page.accounts
+          .filter((account) => account.status === 'active')
+          .map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
+      ),
+    );
+    expect(read.accounts.length).toBeGreaterThan(0);
+    expect(read.defaultAccountId).toBe(page.defaultAccountId);
+    expect(choices.body).not.toContain('webhook');
   });
 });
 
```

The packer of the "gives the accounts to storefront.manage only" test now also reads the choices: a 200, the same
active accounts as the page's own read, the same default, and no webhook address anywhere in the body. Both lists
are sorted by id before they are compared, because the API sorts by name in the database's collation, which is not
the one JavaScript uses.

### The word for the menu's column

```diff
@@ -5505,6 +5505,8 @@ export const en = {
         news: 'Courier’s news',
         test: 'Last test',
         status: 'Status',
+        // 28a.6: the row menu's column, read by screen readers only
+        actions: 'Actions',
       },
       // The news column (lastWebhookAt, decision 16). date = the date and time in the
       // workspace's time zone
```

```diff
@@ -5108,6 +5108,7 @@ export const bn: Messages = {
         news: 'কুরিয়ারের খবর',
         test: 'শেষ পরীক্ষা',
         status: 'অবস্থা',
+        actions: 'কাজ',
       },
       newsAt: 'শেষ এসেছে {{date}}',
       newsNever: 'এখনো আসেনি',
```

The row menu's column has no visible header, but a screen reader reads one (mine 52). The Bangla is the coupons
page's own word.

### The app's reads and the export file

```diff
@@ -50,6 +50,14 @@ export function storefrontPaymentSetupQuery(tenantId: string) {
   });
 }
 
+// Step 28a: the Shop couriers page's one read (every account, archived ones too, and the default)
+export function storefrontCouriersQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['storefront', tenantId, 'couriers'],
+    queryFn: () => call(routes.shipping.getCouriers),
+  });
+}
+
 export function storefrontCategoriesQuery(tenantId: string) {
   return queryOptions({
     queryKey: ['storefront', tenantId, 'categories'],
```

The page's one read. Its key starts with `['storefront', tenantId]`, so `useStorefrontRefresh()` refreshes it after
every change, like the other Storefront pages.

```diff
@@ -1,5 +1,7 @@
 import {
   compareQuantity,
+  type CourierExportRow,
+  isOpenShipment,
   isQuantity,
   type PackStorefrontOrderFormValues,
   routes,
@@ -7,6 +9,7 @@ import {
   type StorefrontOrderSort,
   type StorefrontOrderView,
   type StorefrontPackPlan,
+  type StorefrontShipment,
   sumQuantity,
 } from '@omnivo/contracts';
 import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
@@ -67,6 +70,16 @@ export function storefrontPackPlanQuery(tenantId: string, orderId: string) {
   });
 }
 
+// Step 28a.6: the accounts the Packed dialog and Book courier offer (courierChoices). Asked each
+// time one of them opens, like the pack plan: an account archived a minute ago must not be offered
+export function storefrontCourierChoicesQuery(tenantId: string) {
+  return queryOptions({
+    queryKey: ['storefront', tenantId, 'orders', 'courier-choices'],
+    queryFn: () => call(routes.storefrontOrders.courierChoices),
+    staleTime: 0,
+  });
+}
+
 // ---------------------------------------------------------------------------------------------
 // One order
 
@@ -188,3 +201,78 @@ export function pickedOf(
   // sumQuantity writes four decimals; the count shows what a person would write
   return { picked: plainQuantity(picked), complete: compareQuantity(picked, quantity) === 0 };
 }
+
+// ---------------------------------------------------------------------------------------------
+// Step 28a: the order's parcels
+
+// The order's parcels come oldest first (storefrontOrderSchema). The page shows the newest first:
+// the one that matters now is on top, and an earlier failed one sits under it
+export function parcelsNewestFirst(order: StorefrontOrder): StorefrontShipment[] {
+  return [...order.shipments].reverse();
+}
+
+// The parcel on its way, if any. The database keeps at most one per order (28a.2's open_idx)
+export function openParcel(order: StorefrontOrder): StorefrontShipment | null {
+  return order.shipments.find((parcel) => isOpenShipment(parcel.status)) ?? null;
+}
+
+// "Needs attention" on the order's page, by the API's own rule for the list (parcelNeedsAttention):
+// a packed order whose last parcel failed to book. "Book again" made a new parcel, so a failed one
+// under a newer one no longer counts
+export function parcelFailed(order: StorefrontOrder): StorefrontShipment | null {
+  const last = order.shipments.at(-1);
+  return order.status === 'packed' && last?.status === 'booking_failed' ? last : null;
+}
+
+// "Book courier": a packed order with no parcel on its way (none yet, or the last one failed or
+// was cancelled). The API refuses the rest with storefront_order_not_bookable
+export function canBook(order: StorefrontOrder): boolean {
+  return order.status === 'packed' && openParcel(order) === null;
+}
+
+// ---------------------------------------------------------------------------------------------
+// Step 28a: the export for a courier's bulk upload (decision 19)
+
+// The columns of Steadfast's bulk upload, in its own words, which the other couriers' panels take
+// too. They stay English in a Bangla app: the courier's panel reads them, not a person
+export const COURIER_CSV_COLUMNS = [
+  'Invoice',
+  'Name',
+  'Address',
+  'Phone',
+  'Amount',
+  'Note',
+] as const;
+
+// One CSV cell. Quoted when it holds a comma, a quote or a line break (an address often has all
+// three), with its quotes doubled. A shopper typed the name and the address: one that starts with
+// = + - or @ would run as a formula when the file is opened in Excel, so it gets a ' in front
+// (OWASP's CSV injection advice). Only those two: a phone or an amount never starts that way, and
+// a ' there would reach the courier's panel
+function csvCell(value: string, typed = false): string {
+  const safe = typed && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
+  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
+}
+
+// The whole file. note(count) is the rider's line ("3 items", in the reader's words). CRLF, as
+// RFC 4180 says, and a byte order mark first, so Excel reads a Bangla name as UTF-8, not as
+// question marks. The amount as the API wrote it (paisa, a dot): the courier's panel reads it
+export function courierCsv(
+  rows: readonly CourierExportRow[],
+  note: (count: number) => string,
+): string {
+  const lines = [
+    COURIER_CSV_COLUMNS.join(','),
+    ...rows.map((row) =>
+      [
+        csvCell(row.invoice),
+        csvCell(row.name, true),
+        csvCell(row.address, true),
+        csvCell(row.phone),
+        csvCell(row.amount),
+        csvCell(note(row.itemCount), true),
+      ].join(','),
+    ),
+  ];
+  return `\uFEFF${lines.join('\r\n')}\r\n`;
+}
```

Why each part is written this way:

- **`storefrontCourierChoicesQuery` has `staleTime: 0`.** It is asked each time the Packed dialog or Book courier
  opens, like the pack plan: an account archived a minute ago must not be offered. Its key is under `orders`, so
  the page's refresh after a move reaches it too.
- **`parcelsNewestFirst` copies before it reverses.** `reverse()` changes the array in place, and this array is the
  query's cached data.
- **`parcelFailed` looks at the last parcel only,** the same rule as the API's `parcelNeedsAttention`. After Book
  again or Book courier there is a newer parcel, and the old failed one no longer needs anyone.
- **`canBook` is a packed order with no parcel on its way.** A cancelled or failed parcel is not on its way, so
  the order can be booked again; the API refuses the rest with `storefront_order_not_bookable`.
- **`courierCsv`** writes the courier's column names in English, because the courier's panel reads them, not a
  person. A cell is quoted only when it needs it (a comma, a quote or a line break, which an address often has),
  with its quotes doubled. Lines end with CRLF, as the CSV standard (RFC 4180) says. The amount stays as the API
  wrote it (a dot and paisa): the panel reads numbers, not the reader's digits. The guard against formulas (mine
  50) covers only the cells the shopper typed: a phone or an amount never starts with those signs, and a `'` in
  them would reach the courier.

```diff
@@ -1,15 +1,22 @@
 import {
+  type CourierExportRow,
   packStorefrontOrderInputSchema,
   type StorefrontOrder,
   type StorefrontPackPlan,
+  type StorefrontShipment,
 } from '@omnivo/contracts';
 import { describe, expect, it } from 'vitest';
 
 import {
+  canBook,
   canCancel,
+  courierCsv,
   decimalsOf,
   nextStep,
+  openParcel,
   packFormValues,
+  parcelFailed,
+  parcelsNewestFirst,
   pickedOf,
   plainQuantity,
   toPackInput,
@@ -191,3 +198,65 @@ describe('the Packed form', () => {
     ).toEqual({ picked: '2', complete: false });
   });
 });
+
+// Step 28a.6. A parcel with only what the helpers read
+function parcel(id: string, status: StorefrontShipment['status']): StorefrontShipment {
+  return { id, status } as StorefrontShipment;
+}
+function withParcels(
+  status: StorefrontOrder['status'],
+  shipments: StorefrontShipment[],
+): StorefrontOrder {
+  return { status, shipments } as StorefrontOrder;
+}
+
+describe('the parcels', () => {
+  it('finds the open one, newest first, and when a failed one needs attention', () => {
+    const failed = parcel('p1', 'booking_failed');
+    const booked = parcel('p2', 'booked');
+    const order = withParcels('packed', [failed, booked]);
+    expect(parcelsNewestFirst(order).map((one) => one.id)).toEqual(['p2', 'p1']);
+    expect(openParcel(order)).toBe(booked);
+    // Booked again: the failed one under it no longer counts, and nothing more can be booked
+    expect(parcelFailed(order)).toBeNull();
+    expect(canBook(order)).toBe(false);
+    const stuck = withParcels('packed', [failed]);
+    expect(parcelFailed(stuck)).toBe(failed);
+    expect(canBook(stuck)).toBe(true);
+    // A cancelled parcel is not on its way: the order can be booked again
+    expect(canBook(withParcels('packed', [parcel('p3', 'cancelled')]))).toBe(true);
+    // Only a packed order books
+    expect(canBook(withParcels('confirmed', []))).toBe(false);
+    expect(parcelFailed(withParcels('cancelled', [failed]))).toBeNull();
+  });
+});
+
+describe('the courier export file', () => {
+  const row: CourierExportRow = {
+    orderId: '0193a1b2-0000-7000-8000-0000000000c1',
+    invoice: 'W-000123',
+    name: 'ফারহানা আক্তার',
+    address: 'House 12, Road 5, "Green" Lane\nDhanmondi',
+    phone: '01786120356',
+    amount: '538.00',
+    itemCount: 3,
+  };
+  const note = (count: number) => `${String(count)} items`;
+
+  it('writes the courier’s columns, quoted where a cell needs it', () => {
+    const file = courierCsv([row], note);
+    // The byte order mark first, so Excel reads the Bangla name as UTF-8
+    expect(file.startsWith('\uFEFF')).toBe(true);
+    expect(file.slice(1).split('\r\n')).toEqual([
+      'Invoice,Name,Address,Phone,Amount,Note',
+      'W-000123,ফারহানা আক্তার,"House 12, Road 5, ""Green"" Lane\nDhanmondi",01786120356,538.00,3 items',
+      '',
+    ]);
+  });
+
+  it('never lets a shopper’s words run as a formula', () => {
+    const file = courierCsv([{ ...row, name: '=HYPERLINK("x")', address: '+8801' }], note);
+    const cells = file.slice(1).split('\r\n')[1];
+    expect(cells).toBe(`W-000123,"'=HYPERLINK(""x"")",'+8801,01786120356,538.00,3 items`);
+  });
+});
```

The parcel test builds a failed parcel with a booked one after it, then the failed one alone, then a cancelled one,
and checks each helper's answer. The export tests check the whole file to the byte: the mark, the header, the
quoting of an address with a comma, quotes and a line break, and a formula that is kept from running.

### Shop couriers

```tsx
import {
  Alert02Icon,
  Archive02Icon,
  ArchiveRestoreIcon,
  CheckmarkBadge01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Edit02Icon,
  InformationCircleIcon,
  MoreHorizontalIcon,
  Plug01Icon,
  PlusSignIcon,
  ShippingTruck01Icon,
  WebhookIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  COURIER_ACCOUNT_STATUSES,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierAccountStatus,
  type CourierSetup,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  cn,
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
  Field,
  FormAlert,
  IconButton,
  Input,
  PageHeader,
  Pill,
  SegmentedControl,
  SelectField,
  toast,
} from '@omnivo/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useId, useMemo, useState } from 'react';

import { DocumentNotice } from '../components/document-notice';
import {
  StorefrontOffline,
  useStorefrontRefresh,
  ViewShopLink,
} from '../components/storefront-parts';
import { ApiRequestError, call } from '../lib/api';
import { storefrontCouriersQuery, storefrontSetupQuery } from '../lib/storefront';
import { useOnline } from '../lib/use-online';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 28a: Storefront → Shop couriers (decision 15, approved with the mockup), storefront.manage.
// The "Book at Packed" card (the default account, decision 13), then the accounts with an Active /
// Archived control. An account opens in a dialog; a new API account, and a new webhook token, show
// the webhook's address and token once (decision 16). Online only, like the whole menu. No
// "Changes show in the shop" line: the shop never shows an account.

const column = dataTableColumns<CourierAccount>();

// The form's chunk loads the first time Add or Edit is opened (storefront-courier-form.tsx)
const AccountDialog = lazy(async () => ({
  default: (await import('../components/storefront-courier-form')).AccountDialog,
}));

const STATUS_PILLS = {
  active: { tone: 'good', icon: CheckmarkCircle02Icon },
  archived: { tone: 'neutral', icon: Archive02Icon },
} as const satisfies Record<CourierAccountStatus, { tone: string; icon: IconSvgElement }>;

// A line with its own icon and colour, so the colour is never the only sign
function Line({ tone, icon, children }: { tone: string; icon: IconSvgElement; children: string }) {
  return (
    <span className={cn('inline-flex items-start gap-1.5 text-body-sm', tone)}>
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}
```

The account form is its own chunk, loaded the first time Add or Edit opens, like the coupon form: most visits to the
page only read it. `Line` puts an icon beside every coloured line, so colour is never the only sign.

```tsx
// ---------------------------------------------------------------------------------------------
// The default account

// Decision 13: the account the Packed dialog starts with. Its own small form (one select and
// Save), because it saves to its own route (PUT /storefront/couriers). Only an active account that
// books by API: a manual one has no code yet at Packed. Save waits for a change. Secondary: the
// page's one primary button is "Add courier account"
function DefaultCard({ setup }: { setup: CourierSetup }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const tenantId = useTenantId();
  const choices = setup.accounts.filter(
    (account) => account.status === 'active' && account.provider !== 'manual',
  );
  const [value, setValue] = useState(setup.defaultAccountId ?? '');
  const save = useMutation({
    mutationFn: () => call(routes.shipping.setDefaultCourier, { body: { accountId: value } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(storefrontCouriersQuery(tenantId).queryKey, saved);
      const name = saved.accounts.find((account) => account.id === saved.defaultAccountId)?.name;
      toast(
        name === undefined
          ? t('storefront.couriers.default.cleared')
          : t('storefront.couriers.default.saved', { name }),
      );
    },
  });
  const failure =
    save.error instanceof ApiRequestError ? save.error.code : save.error ? 'unknown_error' : null;
  return (
    <Card>
      <CardHeader
        title={t('storefront.couriers.default.title')}
        subtitle={t('storefront.couriers.default.description')}
      />
      <div className="grid gap-3 p-5">
        {failure !== null && <FormAlert message={failure} />}
        {choices.length === 0 ? (
          <p className="flex items-start gap-1.5 text-label text-ink-2">
            <HugeiconsIcon
              icon={InformationCircleIcon}
              size={15}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-ink-3"
            />
            {t('storefront.couriers.default.noApiAccount')}
          </p>
        ) : (
          // The button sits on the select's line from sm (its label's height above it), under
          // it on a phone
          <div className="grid gap-3 sm:flex sm:items-start">
            <div className="min-w-0 sm:w-full sm:max-w-[420px]">
              <SelectField
                label={t('storefront.couriers.default.label')}
                icon={ShippingTruck01Icon}
                name="defaultAccountId"
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                }}
                options={[
                  { value: '', label: t('storefront.couriers.default.none') },
                  ...choices.map((account) => ({
                    value: account.id,
                    label: t('storefront.order.booking.accountOption', {
                      name: account.name,
                      courier: t(`storefront.couriers.names.${account.courier}`),
                    }),
                  })),
                ]}
                hint={t('storefront.couriers.default.hint')}
              />
            </div>
            <Button
              variant="secondary"
              className="justify-self-start sm:mt-[25px]"
              disabled={value === (setup.defaultAccountId ?? '') || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('storefront.couriers.default.save')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
```

The "Book at Packed" card (decision 13) is its own small form, because it saves to its own route. It offers only
active API accounts: a manual account has no tracking code yet at Packed. Save is secondary and waits for a change,
because the page's one primary button is "Add courier account". The answer of the save is the whole setup, so it
goes straight into the query's cache, and the page's key on the card (below) starts the select again from the saved
value. With no API account, the card says what to add instead of showing an empty select.

```tsx
// ---------------------------------------------------------------------------------------------
// Dialogs

// The browser's clipboard can refuse (an old browser, a page not on HTTPS): then the person selects
// the text in its box and copies it themselves (the share dialog's rule)
function useCopy(): (text: string) => void {
  const { t } = useLocale();
  return (text) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast(t('storefront.couriers.webhook.copied'));
      },
      () => {
        toast(t('documentOutput.copyFailed'));
      },
    );
  };
}

function CopyBox({
  label,
  value,
  copy,
  hint,
}: {
  label: string;
  value: string;
  copy: string;
  hint?: string;
}) {
  const id = useId();
  const copyText = useCopy();
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        {/* Read only, and selected on focus: one tap selects it for copying by hand */}
        <div className="min-w-0 flex-1">
          <Input
            id={id}
            readOnly
            value={value}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => {
            copyText(value);
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
          {copy}
        </Button>
      </div>
    </Field>
  );
}

// Decision 16: the token is in the answer once (courierAccountSavedSchema). The dialog says so,
// and closing it any way is Done
function WebhookDialog({ saved }: { saved: CourierAccountSaved }) {
  const { t } = useLocale();
  return (
    <DialogContent
      title={t('storefront.couriers.webhook.title')}
      description={t('storefront.couriers.webhook.description')}
      footer={
        <DialogClose asChild>
          <Button>{t('storefront.couriers.webhook.done')}</Button>
        </DialogClose>
      }
    >
      <div className="grid gap-[18px]">
        <CopyBox
          label={t('storefront.couriers.webhook.url')}
          value={saved.account.webhookUrl ?? ''}
          copy={t('storefront.couriers.webhook.copyUrl')}
        />
        <CopyBox
          label={t('storefront.couriers.webhook.token')}
          value={saved.webhookToken ?? ''}
          copy={t('storefront.couriers.webhook.copyToken')}
          hint={t('storefront.couriers.webhook.tokenHint')}
        />
        <DocumentNotice tone="neutral">{t('storefront.couriers.webhook.poll')}</DocumentNotice>
      </div>
    </DialogContent>
  );
}

// New webhook token and Archive both ask first, with the same frame
function ConfirmDialog({
  title,
  body,
  submit,
  pending,
  error,
  onConfirm,
}: {
  title: string;
  body: string;
  submit: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <DialogContent
      title={title}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onConfirm}>
            {submit}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {/* version_conflict: someone changed it meanwhile; Cancel and the list shows the new one */}
        {error !== null && <FormAlert message={error} />}
        <p className="text-body-sm text-ink-2">{body}</p>
      </div>
    </DialogContent>
  );
}
```

The dialogs:

- **`useCopy`** is the share dialog's rule: the browser's clipboard can refuse (an old browser, a page not on
  HTTPS), and then the toast says to select the text by hand. The boxes are read-only and select everything on
  focus, so one tap is enough.
- **`WebhookDialog`** shows the address and the token. The token is in the save's answer once (decision 16), so the
  hint says it is shown only now, and how to get a new one. Its only button is Done.
- **`ConfirmDialog`** is one frame for New webhook token and Archive. An error with no box (a version conflict when
  someone changed the account meanwhile) shows above the words.

```tsx
// ---------------------------------------------------------------------------------------------
// The page

type Acting =
  | null
  | { kind: 'new' }
  | { kind: 'edit'; account: CourierAccount }
  | { kind: 'archive'; account: CourierAccount }
  | { kind: 'renew'; account: CourierAccount }
  | { kind: 'webhook'; saved: CourierAccountSaved };

function codeOf(error: unknown): string | null {
  if (error instanceof ApiRequestError) return error.code;
  return error ? 'unknown_error' : null;
}

export function StorefrontCouriersPage() {
  const { t, format, errorText } = useLocale();
  const tenantId = useTenantId();
  const timeZone = useTimeZone();
  const online = useOnline();
  const refresh = useStorefrontRefresh();
  const [view, setView] = useState<CourierAccountStatus>('active');
  const [acting, setActing] = useState<Acting>(null);
  const close = () => {
    setActing(null);
  };

  // "View shop" once the shop has an address. An account does not need the shop: it can be added
  // before the shop is set up
  const shop = useQuery({ ...storefrontSetupQuery(tenantId), enabled: online }).data?.shop ?? null;
  const { data: setup, isError } = useQuery({
    ...storefrontCouriersQuery(tenantId),
    enabled: online,
  });

  // Test connection: a 200 whether the keys worked or not; the account's lastTest says which, and
  // the toast says it too
  const test = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.testCourier, { params: { id: account.id } }),
    onSuccess: async (saved) => {
      await refresh();
      const courier = t(`storefront.couriers.names.${saved.courier}`);
      const problem = saved.lastTest?.problem ?? null;
      toast(
        problem === null
          ? t('storefront.couriers.testedWorked', { courier })
          : problem === 'rejected'
            ? t('storefront.couriers.testedRejected', { courier })
            : t('storefront.couriers.testedUnreachable', { courier }),
      );
    },
    onError: (error) => {
      toast(errorText(codeOf(error) ?? 'unknown_error'));
    },
  });
  const restore = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.restoreCourier, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.couriers.restored', { name: saved.name }));
    },
    onError: (error) => {
      toast(errorText(codeOf(error) ?? 'unknown_error'));
    },
  });
  const archive = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.archiveCourier, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      setActing(null);
      toast(t('storefront.couriers.archived', { name: saved.name }));
    },
  });
  const renew = useMutation({
    mutationFn: (account: CourierAccount) =>
      call(routes.shipping.renewCourierWebhookToken, {
        params: { id: account.id },
        body: { version: account.version },
      }),
    onSuccess: async (saved) => {
      await refresh();
      toast(t('storefront.couriers.tokenRenewed'));
      // The new token, once, in the same dialog as a new account's
      setActing({ kind: 'webhook', saved });
    },
  });
  // mutate is stable; the mutation objects are new on every render and would rebuild the columns
  const { mutate: testAccount } = test;
  const { mutate: restoreAccount } = restore;

  const defaultId = setup?.defaultAccountId ?? null;
```

The page's state is one `Acting` union, so only one dialog can be open, and TypeScript knows which account each one
has. Test connection answers 200 whether the keys worked or not; the account's `lastTest` says which, and the toast
says the same words. Restore asks nothing (it changes nothing the courier sees). A new webhook token opens the same
webhook dialog as a new account. The `mutate` functions are taken out because they are stable: the mutation objects
are new on every render and would rebuild the table's columns each time.

```tsx
  const columns = useMemo(() => {
    const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
    return column.columns([
      column.accessor('name', {
        header: t('storefront.couriers.columns.account'),
        enableSorting: false,
        meta: { card: 'title' },
        cell: ({ row }) => {
          const account = row.original;
          const courier = t(`storefront.couriers.names.${account.courier}`);
          return (
            <span className="flex items-center gap-3">
              <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                <HugeiconsIcon icon={ShippingTruck01Icon} size={16} strokeWidth={1.5} />
              </span>
              <span className="grid min-w-0">
                <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {account.name}
                  {account.id === defaultId && (
                    <Pill tone="brand" icon={CheckmarkBadge01Icon}>
                      {t('storefront.couriers.isDefault')}
                    </Pill>
                  )}
                </span>
                <span className="text-caption font-normal text-ink-3">
                  {t(`storefront.couriers.providers.${account.provider}`, { courier })}
                </span>
              </span>
            </span>
          );
        },
      }),
      column.accessor('lastWebhookAt', {
        header: t('storefront.couriers.columns.news'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ row }) => {
          const account = row.original;
          if (account.provider === 'manual') {
            return (
              <span className="text-body-sm text-ink-3">{t('storefront.couriers.newsManual')}</span>
            );
          }
          if (account.lastWebhookAt !== null) {
            return (
              <span className="text-body-sm whitespace-nowrap text-ink tabular-nums">
                {t('storefront.couriers.newsAt', { date: when(account.lastWebhookAt) })}
              </span>
            );
          }
          // Decision 16 (approved with the mockup): warn, because the courier's news never
          // reached us, and the line under it says what to do
          return (
            <span className="grid max-w-[260px] gap-0.5">
              <span className="font-medium text-warn">
                <Line tone="text-warn" icon={Alert02Icon}>
                  {t('storefront.couriers.newsNever')}
                </Line>
              </span>
              <span className="text-caption text-ink-3">
                {t('storefront.couriers.newsNeverHint')}
              </span>
            </span>
          );
        },
      }),
      column.accessor('lastTest', {
        header: t('storefront.couriers.columns.test'),
        enableSorting: false,
        meta: { card: 'detail' },
        cell: ({ row }) => {
          const account = row.original;
          // A manual account has nothing to test
          if (account.provider === 'manual') return <span className="text-ink-3">—</span>;
          const last = account.lastTest;
          if (last === null) {
            return (
              <span className="text-body-sm text-ink-3">
                {t('storefront.couriers.neverTested')}
              </span>
            );
          }
          const date = when(last.at);
          switch (last.problem) {
            case null:
              return (
                <Line tone="text-good" icon={CheckmarkCircle02Icon}>
                  {t('storefront.couriers.testWorked', { date })}
                </Line>
              );
            case 'rejected':
              return (
                <Line tone="text-crit" icon={Alert02Icon}>
                  {t('storefront.couriers.testRejected', { date })}
                </Line>
              );
            case 'unreachable':
              return (
                <Line tone="text-warn" icon={Alert02Icon}>
                  {t('storefront.couriers.testUnreachable', { date })}
                </Line>
              );
          }
        },
      }),
      column.accessor('status', {
        header: t('storefront.couriers.columns.status'),
        enableSorting: false,
        meta: { card: 'subtitle' },
        cell: ({ getValue }) => {
          const status = getValue();
          const pill = STATUS_PILLS[status];
          return (
            <Pill tone={pill.tone} icon={pill.icon}>
              {t(`storefront.couriers.statuses.${status}`)}
            </Pill>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('storefront.couriers.columns.actions')}</span>,
        meta: { align: 'end', card: 'trailing' },
        cell: ({ row }) => {
          const account = row.original;
          const byApi = account.provider !== 'manual';
          return (
            // The row opens Edit on a click: the menu's events must not reach it (27c.7's lesson,
            // storefront-coupons.tsx). `contents`: the wrapper draws no box
            <div
              className="contents"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={MoreHorizontalIcon}
                    label={t('storefront.couriers.actionsFor', { name: account.name })}
                    className="-my-1"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {account.status === 'archived' ? (
                    <DropdownMenuItem
                      icon={ArchiveRestoreIcon}
                      onSelect={() => {
                        restoreAccount(account);
                      }}
                    >
                      {t('storefront.couriers.restore')}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        icon={Edit02Icon}
                        onSelect={() => {
                          setActing({ kind: 'edit', account });
                        }}
                      >
                        {t('storefront.couriers.edit')}
                      </DropdownMenuItem>
                      {byApi && (
                        <DropdownMenuItem
                          icon={Plug01Icon}
                          onSelect={() => {
                            testAccount(account);
                          }}
                        >
                          {t('storefront.couriers.test')}
                        </DropdownMenuItem>
                      )}
                      {byApi && (
                        <DropdownMenuItem
                          icon={WebhookIcon}
                          onSelect={() => {
                            setActing({ kind: 'renew', account });
                          }}
                        >
                          {t('storefront.couriers.renewToken')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        icon={Archive02Icon}
                        onSelect={() => {
                          setActing({ kind: 'archive', account });
                        }}
                      >
                        {t('storefront.couriers.archive')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ]);
  }, [t, format, timeZone, defaultId, testAccount, restoreAccount]);
```

The columns:

- **Account:** the 30px tile, the name, the brand "Books first" pill on the default, and the provider line under it.
- **Courier's news:** a manual account says "Moved by hand". An API account with news shows when they last came;
  one with none is `warn` with the line that says what to do (approved with the mockup).
- **Last test:** a dash for a manual account, which has nothing to test; otherwise each answer has its own colour
  and icon.
- **The row menu:** an archived account has only Restore. Test connection and New webhook token are for an API
  account only. The wrapper stops the menu's clicks and keys from reaching the row, which opens Edit: 27c.7 found
  that without it, Archive opened the Edit form instead.

```tsx
  const rows = setup?.accounts.filter((account) => account.status === view);
  const openNew = () => {
    setActing({ kind: 'new' });
  };
  const empty =
    view === 'archived' ? (
      <EmptyState
        icon={Archive02Icon}
        title={t('storefront.couriers.archivedEmptyTitle')}
        description={t('storefront.couriers.archivedEmptyBody')}
      />
    ) : (
      <EmptyState
        icon={ShippingTruck01Icon}
        title={t('storefront.couriers.emptyTitle')}
        description={t('storefront.couriers.emptyBody')}
        action={
          <Button size="sm" onClick={openNew}>
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.5} />
            {t('storefront.couriers.add')}
          </Button>
        }
      />
    );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.couriers.title')}
        description={t('storefront.couriers.description')}
        actions={
          online && (
            <>
              {shop !== null && <ViewShopLink href={shop.shopUrl} />}
              <Button onClick={openNew}>
                <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
                {t('storefront.couriers.add')}
              </Button>
            </>
          )
        }
      />
      {!online && <StorefrontOffline />}
      {online && isError && (
        <p role="alert" className="text-body-sm text-crit">
          {t('storefront.couriers.loadFailed')}
        </p>
      )}
      {online && setup && (
        <>
          {/* key: a save elsewhere (an archive of the default) starts the select afresh */}
          <DefaultCard key={setup.defaultAccountId ?? 'none'} setup={setup} />
          <div>
            <SegmentedControl
              label={t('storefront.couriers.view')}
              value={view}
              options={COURIER_ACCOUNT_STATUSES.map((value) => ({
                value,
                label: t(`storefront.couriers.views.${value}`),
              }))}
              onChange={setView}
            />
          </div>
          {rows && (
            <DataTable
              label={t('storefront.couriers.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              // An archived account opens nothing: Restore (its menu) comes before a change
              onRowClick={
                view === 'active'
                  ? (account) => {
                      setActing({ kind: 'edit', account });
                    }
                  : undefined
              }
              empty={empty}
            />
          )}
        </>
      )}
      {(acting?.kind === 'new' || acting?.kind === 'edit') && (
        // fallback null: the chunk comes in a moment, and an empty dialog frame would flash first
        <Suspense fallback={null}>
          <AccountDialog
            account={acting.kind === 'new' ? null : acting.account}
            onClose={close}
            onSaved={async (saved) => {
              await refresh();
              // A new API account's webhook, once (decision 16); a manual one has none
              if (saved.webhookToken !== null) setActing({ kind: 'webhook', saved });
              else setActing(null);
            }}
          />
        </Suspense>
      )}
      {acting !== null &&
        (acting.kind === 'archive' || acting.kind === 'renew' || acting.kind === 'webhook') && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                archive.reset();
                renew.reset();
                setActing(null);
              }
            }}
          >
            {acting.kind === 'webhook' && <WebhookDialog saved={acting.saved} />}
            {acting.kind === 'renew' && (
              <ConfirmDialog
                title={t('storefront.couriers.renewing.title', { name: acting.account.name })}
                body={t('storefront.couriers.renewing.body')}
                submit={t('storefront.couriers.renewing.submit')}
                pending={renew.isPending}
                error={codeOf(renew.error)}
                onConfirm={() => {
                  renew.mutate(acting.account);
                }}
              />
            )}
            {acting.kind === 'archive' && (
              <ConfirmDialog
                title={t('storefront.couriers.archiving.title', { name: acting.account.name })}
                // The default account: archiving it clears the default too (28a.2)
                body={
                  acting.account.id === defaultId
                    ? t('storefront.couriers.archiving.bodyDefault')
                    : t('storefront.couriers.archiving.body')
                }
                submit={t('storefront.couriers.archiving.submit')}
                pending={archive.isPending}
                error={codeOf(archive.error)}
                onConfirm={() => {
                  archive.mutate(acting.account);
                }}
              />
            )}
          </Dialog>
        )}
    </div>
  );
}
```

The two tabs filter one list in the browser: a workspace has a few accounts, and the read already has them all. An
archived row opens nothing, because Restore comes before a change. After a save, the API account's webhook opens
once; a manual account has none, so the dialog just closes. Closing a confirm dialog resets its mutation, so an old
error is not shown the next time it opens.

```tsx
import {
  Edit02Icon,
  Key01Icon,
  LockKeyholeIcon,
  Plug01Icon,
  ShippingTruck01Icon,
  Tag01Icon,
} from '@hugeicons/core-free-icons';
import {
  contractErrorMap,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierProvider,
  createCourierAccountInputSchema,
  routes,
  SHOP_COURIERS,
  updateCourierAccountInputSchema,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  FormAlert,
  SelectableCardGroup,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { type Resolver, useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';

// Step 28a: the courier account's dialog (approved with the mockup), its own chunk like the coupon
// form. One form for both providers: the contract's create and update schemas are unions by
// `provider`, so the form keeps one flat shape (every box), and the resolver builds the union's
// body from it and checks that with the contract's own schema. That way the keys of a Steadfast
// account never travel with a manual one, and the errors land under the same boxes as the API's.

interface AccountForm {
  provider: CourierProvider;
  name: string;
  apiKey: string;
  secretKey: string;
  // '' = "Pick a courier" (courier_pick_one)
  courier: string;
  version: number;
}

const FIELDS = ['provider', 'name', 'apiKey', 'secretKey', 'courier'] as const;

// The union's body for the provider picked. unknown: the schema below checks it (an empty courier
// is its error, not a type error here)
function bodyOf(values: AccountForm, isNew: boolean): unknown {
  const version = isNew ? {} : { version: values.version };
  return values.provider === 'manual'
    ? { provider: 'manual', name: values.name, courier: values.courier, ...version }
    : {
        provider: values.provider,
        name: values.name,
        apiKey: values.apiKey,
        secretKey: values.secretKey,
        ...version,
      };
}

function schemaOf(isNew: boolean) {
  return isNew ? createCourierAccountInputSchema : updateCourierAccountInputSchema;
}

// react-hook-form's resolver, by hand: the contract's schema over the body, each issue under the
// box its path names. The values stay the form's own (the page builds the body again to send it)
function resolverOf(isNew: boolean): Resolver<AccountForm> {
  return (values) => {
    const parsed = schemaOf(isNew).safeParse(bodyOf(values, isNew), { error: contractErrorMap });
    if (parsed.success) return { values, errors: {} };
    const errors: Partial<Record<(typeof FIELDS)[number], { type: string; message: string }>> = {};
    for (const issue of parsed.error.issues) {
      const field = FIELDS.find((name) => name === issue.path[0]);
      if (field !== undefined) errors[field] ??= { type: 'validation', message: issue.message };
    }
    return { values: {}, errors };
  };
}

function AccountForm({
  account,
  onSaved,
}: {
  account: CourierAccount | null;
  onSaved: (saved: CourierAccountSaved) => Promise<void>;
}) {
  const { t } = useLocale();
  const isNew = account === null;
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<AccountForm>({
    resolver: resolverOf(isNew),
    defaultValues: {
      provider: account?.provider ?? 'steadfast',
      name: account?.name ?? '',
      // Write-only (decision 7): the boxes always start empty; on a saved account an empty box
      // keeps its key
      apiKey: '',
      secretKey: '',
      courier: account?.provider === 'manual' ? account.courier : '',
      version: account?.version ?? 0,
    },
  });
  const provider = useWatch({ control, name: 'provider' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      // The resolver checked it; parse again for the typed body
      const body = bodyOf(values, isNew);
      if (account === null) {
        const saved = await call(routes.shipping.createCourier, {
          body: createCourierAccountInputSchema.parse(body),
        });
        toast(t('storefront.couriers.form.created', { name: saved.account.name }));
        await onSaved(saved);
      } else {
        const saved = await call(routes.shipping.updateCourier, {
          params: { id: account.id },
          body: updateCourierAccountInputSchema.parse(body),
        });
        toast(t('storefront.couriers.form.updated'));
        await onSaved({ account: saved, webhookToken: null });
      }
    } catch (error) {
      applyApiError(error, FIELDS, setError);
    }
  });
  const serverError = errors.root?.server?.message;

  return (
    <DialogContent
      title={
        isNew
          ? t('storefront.couriers.form.addTitle')
          : t('storefront.couriers.form.editTitle', { name: account.name })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="courier-account" disabled={isSubmitting}>
            {isSubmitting
              ? t('common.saving')
              : isNew
                ? t('storefront.couriers.form.create')
                : t('storefront.couriers.form.save')}
          </Button>
        </>
      }
    >
      <form
        id="courier-account"
        noValidate
        className="grid gap-[18px]"
        onSubmit={(event) => void onSubmit(event)}
      >
        {serverError !== undefined && <FormAlert message={serverError} />}
        {isNew ? (
          <div className="grid gap-1.5">
            {/* The group's legend is for screen readers; this is the same words on screen */}
            <p aria-hidden="true" className="text-label font-medium text-ink">
              {t('storefront.couriers.form.provider')}
            </p>
            <SelectableCardGroup
              legend={t('storefront.couriers.form.provider')}
              value={provider}
              options={[
                {
                  value: 'steadfast',
                  icon: Plug01Icon,
                  title: t('storefront.couriers.form.providers.steadfast'),
                  description: t('storefront.couriers.form.providerHints.steadfast'),
                },
                {
                  value: 'manual',
                  icon: Edit02Icon,
                  title: t('storefront.couriers.form.providers.manual'),
                  description: t('storefront.couriers.form.providerHints.manual'),
                },
              ]}
              onChange={(next: CourierProvider) => {
                setValue('provider', next);
              }}
            />
          </div>
        ) : (
          // courier_provider_fixed: shown as a fact, not offered (approved with the mockup)
          <div className="grid gap-0.5 rounded-control bg-subtle p-3">
            <span className="text-label font-medium text-ink">
              {t('storefront.couriers.form.provider')}
            </span>
            <span className="text-body text-ink-2">
              {t(`storefront.couriers.form.providers.${account.provider}`)}
            </span>
            <span className="text-label text-ink-3">
              {t('storefront.couriers.form.providerFixed')}
            </span>
          </div>
        )}
        <TextField
          label={t('storefront.couriers.form.name')}
          icon={Tag01Icon}
          placeholder={t('storefront.couriers.form.namePlaceholder')}
          autoComplete="off"
          maxLength={60}
          hint={t('storefront.couriers.form.nameHint')}
          {...register('name')}
          error={errors.name?.message}
        />
        {provider === 'manual' ? (
          <SelectField
            label={t('storefront.couriers.form.courier')}
            icon={ShippingTruck01Icon}
            options={[
              { value: '', label: t('storefront.couriers.form.courierPlaceholder') },
              ...SHOP_COURIERS.map((courier) => ({
                value: courier,
                label: t(`storefront.couriers.names.${courier}`),
              })),
            ]}
            hint={t('storefront.couriers.form.courierHint')}
            {...register('courier')}
            error={errors.courier?.message}
          />
        ) : (
          <>
            {/* new-password: the browser must not fill in the member's own password here */}
            <TextField
              label={t('storefront.couriers.form.apiKey')}
              icon={Key01Icon}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={isNew ? undefined : t('storefront.couriers.form.keySavedPlaceholder')}
              {...register('apiKey')}
              error={errors.apiKey?.message}
            />
            <TextField
              label={t('storefront.couriers.form.secretKey')}
              icon={LockKeyholeIcon}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={isNew ? undefined : t('storefront.couriers.form.keySavedPlaceholder')}
              hint={
                isNew
                  ? t('storefront.couriers.form.keysHint')
                  : t('storefront.couriers.form.keysSavedHint')
              }
              {...register('secretKey')}
              error={errors.secretKey?.message}
            />
          </>
        )}
      </form>
    </DialogContent>
  );
}

export function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: CourierAccount | null;
  onClose: () => void;
  onSaved: (saved: CourierAccountSaved) => Promise<void>;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AccountForm key={account?.id ?? 'new'} account={account} onSaved={onSaved} />
    </Dialog>
  );
}
```

Why the form is written this way:

- **One flat form for both providers.** The contract's create and update inputs are unions by `provider`, and
  react-hook-form works best with one shape. So the form keeps every box, and `bodyOf` builds the union's body for
  the provider picked: a manual account never sends keys, and an API account never sends a courier.
- **The resolver is written by hand.** It checks `bodyOf`'s result with the contract's own schema and puts each
  issue under the box its path names. The errors are the same codes and paths as the API's, so `applyApiError` puts
  a refusal from the server in the same place. The submit parses the body again to get its type for `call`.
- **The keys start empty, always** (decision 7). On a saved account the placeholder says "Saved", and an empty box
  keeps its key. `autoComplete="new-password"` stops the browser from filling in the member's own password.
- **The provider is picked only when the account is new.** On edit it is a fact on `subtle` with the reason it
  cannot change (`courier_provider_fixed`), approved with the mockup.
- **The cards' legend is read by screen readers,** and the same words show above the cards, hidden from screen
  readers so they are not read twice.
- **`key` on the form** starts it afresh for another account, so no box keeps the last account's values.

### The router, the menu and the bell

```diff
@@ -1090,6 +1090,17 @@ const storefrontCouponsRoute = createRoute({
   ),
 });
 
+// Step 28a: the shop's courier accounts (decision 15), storefront.manage. One page: an account opens
+// in a dialog
+const storefrontCouriersRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/couriers',
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-couriers'),
+    'StorefrontCouriersPage',
+  ),
+});
+
 const storefrontCategoriesRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/storefront/categories',
@@ -1304,6 +1315,7 @@ const routeTree = rootRoute.addChildren([
     storefrontListingsRoute,
     storefrontListingRoute,
     storefrontCouponsRoute,
+    storefrontCouriersRoute,
     storefrontCategoriesRoute,
     storefrontSettingsRoute,
     storefrontAppearanceRoute,
```

```diff
@@ -71,6 +71,7 @@ import {
   UserMultiple02Icon,
   UserTime01Icon,
   WarehouseIcon,
+  ShippingTruck01Icon,
   WebDesign01Icon,
   PaintBoardIcon,
   Files01Icon,
@@ -713,6 +714,10 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
                   <NavLink to="/storefront/settings" icon={WebDesign01Icon}>
                     {t('nav.storefrontSettings')}
                   </NavLink>
+                  {/* Step 28a: after Shop settings, both set the shop up (decision 15) */}
+                  <NavLink to="/storefront/couriers" icon={ShippingTruck01Icon}>
+                    {t('nav.storefrontCouriers')}
+                  </NavLink>
                 </>
               )}
             </NavGroup>
```

The page is a lazy route like the other Storefront pages. The menu item sits after Shop settings, behind
`storefront.manage` like its neighbours.

```diff
@@ -61,6 +61,9 @@ const TARGET = {
   // Step 27a: a new shop order. Step 27b: the list's New tab, for an old notification without the
   // order's id; one with it opens the order (shopOrderOf below)
   'storefront.order_confirmed': '/storefront/orders',
+  // Step 28a: a parcel that failed to book five times. The order's page has Book again; an old
+  // notification without the id opens the list
+  'storefront.shipment_failed': '/storefront/orders',
 } as const satisfies Record<Exclude<NotificationType, DocumentNotificationType>, string>;
 
 // A document's page from the notification's kind and id. The list of that kind when the id is
@@ -131,12 +134,14 @@ function shiftOf(notification: Notification): string | null {
     : null;
 }
 
-// Step 27b: the new-order bell opens its order. Its id is the order's (27a's handler sends it)
+// Step 27b: the new-order bell opens its order. Its id is the order's (27a's handler sends it).
+// Step 28a: so does a failed booking's (28a.3's handler sends the order's id too)
 function shopOrderOf(notification: Notification): string | null {
   const { id } = notification.params;
-  return notification.type === 'storefront.order_confirmed' && typeof id === 'string' && id !== ''
-    ? id
-    : null;
+  const opensOrder =
+    notification.type === 'storefront.order_confirmed' ||
+    notification.type === 'storefront.shipment_failed';
+  return opensOrder && typeof id === 'string' && id !== '' ? id : null;
 }
 
 // The badge stops at 9+: a two-digit count would not fit the 18px circle, and past nine the exact
```

A failed booking's bell (28a.3) opens its order, where Book again is. Its params have the order's id, like the
new-order bell, so `shopOrderOf` now knows both kinds. `satisfies` on the map made this a type error until now, which
is how 28a.1 left it on purpose.

### The parcel cards, Book courier and the label

```tsx
import {
  Alert02Icon,
  CancelCircleIcon,
  Clock01Icon,
  DeliveryBox01Icon,
  DeliveryDelay01Icon,
  DeliveryReturn01Icon,
  DeliveryTracking01Icon,
  DeliveryTruck01Icon,
  Loading03Icon,
  PackageDeliveredIcon,
  PackageMovingIcon,
  PackageReceiveIcon,
  PackageRemoveIcon,
  PrinterIcon,
  ShippingTruck01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  bookShipmentInputSchema,
  type BookShipmentFormValues,
  contractErrorMap,
  isZeroMoney,
  routes,
  type ShipmentStatus,
  type StorefrontOrder,
  type StorefrontShipment,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  cn,
  DialogClose,
  DialogContent,
  FormAlert,
  Pill,
  SelectField,
  TextField,
} from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useForm, useWatch } from 'react-hook-form';

import { call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { settingsQuery } from '../lib/queries';
import { parcelsNewestFirst, storefrontCourierChoicesQuery } from '../lib/storefront-orders';
import { useTenantId, useTimeZone } from '../lib/workspace';

// Step 28a.6: a shop order's parcels on its page (approved with the mockup), the Book courier
// dialog and the parcel's label. A file of its own, loaded with the order page: the list never
// shows a parcel, and the Packed dialog only needs the choices query.

// The pill of each of the twelve statuses (approved with the mockup). Work on its way is brand, as
// the order's own pills (CLAUDE.md → Sales document statuses); delivered is good; a failed booking
// is crit, because nothing moves until someone books it again; warn for what the shop must act on
// (the courier holds it, it comes back, part of it came back); over and done is neutral. The
// courier's news on the card use the same icons, so a step reads the same in both places
export const PARCEL_PILLS = {
  booking: { tone: 'brand', icon: Clock01Icon },
  booking_failed: { tone: 'crit', icon: Alert02Icon },
  booked: { tone: 'brand', icon: DeliveryBox01Icon },
  picked_up: { tone: 'brand', icon: PackageMovingIcon },
  in_transit: { tone: 'brand', icon: DeliveryTruck01Icon },
  out_for_delivery: { tone: 'brand', icon: DeliveryTracking01Icon },
  delivered: { tone: 'good', icon: PackageDeliveredIcon },
  partly_delivered: { tone: 'warn', icon: PackageRemoveIcon },
  on_hold: { tone: 'warn', icon: DeliveryDelay01Icon },
  returning: { tone: 'warn', icon: DeliveryReturn01Icon },
  returned: { tone: 'neutral', icon: PackageReceiveIcon },
  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
} as const satisfies Record<
  ShipmentStatus,
  { tone: 'brand' | 'good' | 'warn' | 'crit' | 'neutral'; icon: IconSvgElement }
>;

export function ParcelPill({ status }: { status: ShipmentStatus }) {
  const { t } = useLocale();
  const pill = PARCEL_PILLS[status];
  return (
    <Pill tone={pill.tone} icon={pill.icon}>
      {t(`storefront.order.parcels.statuses.${status}`)}
    </Pill>
  );
}

// What the rider collects, as the shop writes money (paisa only when there is some), or that the
// order is paid. A label always shows paisa: its own formatting is in ParcelLabel
function useCollect(): (amount: string) => string {
  const { t, format } = useLocale();
  return (amount) => {
    if (isZeroMoney(amount)) return t('storefront.order.parcels.codNothing');
    const paisa = /\.(\d+)$/.exec(amount)?.[1] ?? '';
    return format.money(amount, { decimals: /[1-9]/.test(paisa) ? 2 : 0 });
  };
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-caption text-ink-3">{label}</dt>
      <dd
        className={cn(
          'text-body-sm break-words text-ink tabular-nums',
          mono && 'font-mono text-[13px]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
```

The pills of the twelve statuses, with `satisfies`, so a status added to `SHIPMENT_STATUSES` without its pill is a
type error. The courier's news on the card use the same icons, so a step looks the same in the pill and in the
list. `useCollect` shows what the rider collects the way the shop writes money (paisa only when there is some), or
"Nothing: paid online" for a paid order.

```tsx
function ParcelCard({
  parcel,
  title,
  onPrint,
}: {
  parcel: StorefrontShipment;
  title: string;
  onPrint: (parcel: StorefrontShipment) => void;
}) {
  const { t, format, errorText } = useLocale();
  const timeZone = useTimeZone();
  const collect = useCollect();
  const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
  const byApi = parcel.account.provider !== 'manual';
  const courier = t(`storefront.couriers.names.${parcel.courier}`);
  // The courier's news, newest first like the shop's tracking page (approved with the mockup).
  // Only an API parcel has news; a manual one moves with the order's buttons
  const events = [...parcel.events].reverse();

  const facts: { label: string; value: string; mono?: boolean }[] = [];
  if (parcel.trackingCode !== null) {
    facts.push({ label: t('storefront.order.parcels.courier'), value: courier });
    facts.push({
      label: t('storefront.order.parcels.trackingCode'),
      value: parcel.trackingCode,
      mono: true,
    });
  }
  if (parcel.consignmentId !== null) {
    facts.push({
      label: t('storefront.order.parcels.consignmentId'),
      value: parcel.consignmentId,
      mono: true,
    });
  }
  facts.push({ label: t('storefront.order.parcels.cod'), value: collect(parcel.codAmount) });
  if (parcel.bookedAt !== null) {
    facts.push({ label: t('storefront.order.parcels.bookedAt'), value: when(parcel.bookedAt) });
    if (byApi) {
      facts.push({
        label: t('storefront.order.parcels.lastSynced'),
        value:
          parcel.lastSyncedAt === null
            ? t('storefront.order.parcels.neverSynced')
            : when(parcel.lastSyncedAt),
      });
    }
  }

  return (
    <Card className="overflow-hidden">
      {/* CardHeader's own markup: its title is text only, and the pill sits beside the title */}
      <header className="flex items-start justify-between gap-4 px-5 pt-[18px]">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-h3">
            {title}
            <ParcelPill status={parcel.status} />
          </h3>
          <p className="text-label text-ink-3">
            {t('storefront.order.parcels.description', { account: parcel.account.name })}
          </p>
        </div>
        {/* A label needs the courier's code; a cancelled parcel goes nowhere */}
        {parcel.trackingCode !== null && parcel.status !== 'cancelled' && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              onPrint(parcel);
            }}
          >
            <HugeiconsIcon icon={PrinterIcon} size={16} strokeWidth={1.5} />
            {t('storefront.order.parcels.printLabel')}
          </Button>
        )}
      </header>
      <div className="grid gap-1.5 px-5 pt-3.5 pb-[18px]">
        {parcel.status === 'booking' && (
          // role=status: the worker books it in a moment, and the page asks again (28a.6's
          // refetchInterval on the order), so a screen reader hears when it moves on
          <div role="status" className="grid gap-1">
            <p className="flex items-center gap-2 text-body-sm font-medium text-brand">
              <HugeiconsIcon
                icon={Loading03Icon}
                size={17}
                strokeWidth={1.5}
                className="motion-safe:animate-spin"
              />
              {t('storefront.order.parcels.bookingNow', { courier: parcel.account.name })}
            </p>
            {parcel.attempts > 0 && (
              <p className="text-caption text-ink-3">
                {t('storefront.order.parcels.bookingRetry', {
                  count: parcel.attempts,
                  formatted: format.number(parcel.attempts),
                })}
              </p>
            )}
          </div>
        )}
        {parcel.status === 'booking_failed' && (
          <p className="flex items-start gap-1.5 text-label text-crit">
            <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="mt-0.5" />
            <span>
              {/* The courier's own words say what to fix ("Invalid phone number"); without them,
                  our error's words */}
              {parcel.errorDetail !== null
                ? t('storefront.order.parcels.courierSaid', { detail: parcel.errorDetail })
                : errorText(parcel.error ?? 'unknown_error')}
            </span>
          </p>
        )}
        {!byApi && parcel.status === 'booked' && (
          <p className="text-body-sm text-ink-2">{t('storefront.order.parcels.manual')}</p>
        )}
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {facts.map((fact) => (
            <Fact
              key={fact.label}
              label={fact.label}
              value={fact.value}
              mono={fact.mono ?? false}
            />
          ))}
        </dl>
      </div>
      {byApi && parcel.bookedAt !== null && (
        <section className="border-t border-line px-5 pt-3.5 pb-1">
          <h4 className="text-label font-medium text-ink">
            {t('storefront.order.parcels.eventsTitle')}
          </h4>
          {events.length === 0 ? (
            <p className="pt-1 pb-4 text-caption text-ink-3">
              {t('storefront.order.parcels.noEvents')}
            </p>
          ) : (
            // The order's Timeline card's look: 24px dots, a 1px line, the newest on brand-soft
            <ol className="grid pt-2.5 pb-4">
              {events.map((event, index) => (
                <li
                  key={`${event.at}-${event.status}-${String(index)}`}
                  className="relative grid grid-cols-[24px_1fr] gap-3 pb-4 last:pb-0"
                >
                  {index < events.length - 1 && (
                    <span className="absolute top-7 bottom-1 left-[11.5px] w-px bg-line" />
                  )}
                  <span
                    className={cn(
                      'grid size-6 place-items-center rounded-full',
                      index === 0 ? 'bg-brand-soft text-brand' : 'bg-subtle text-ink-3',
                    )}
                  >
                    <HugeiconsIcon
                      icon={PARCEL_PILLS[event.status].icon}
                      size={14}
                      strokeWidth={1.5}
                    />
                  </span>
                  <span className="grid">
                    <span className="text-body-sm font-medium text-ink">
                      {t(`storefront.order.parcels.statuses.${event.status}`)}
                    </span>
                    <span className="text-caption text-ink-3 tabular-nums">{when(event.at)}</span>
                    {event.note !== null && (
                      <span className="text-body-sm text-ink-2">{event.note}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </Card>
  );
}

// One card per parcel, newest first. "Parcel" alone for the usual one; numbered once there are
// more, by their place (1 = the first), so "Parcel 2" sits above "Parcel 1"
export function ParcelCards({
  order,
  onPrint,
}: {
  order: StorefrontOrder;
  onPrint: (parcel: StorefrontShipment) => void;
}) {
  const { t } = useLocale();
  const many = order.shipments.length > 1;
  const count = order.shipments.length;
  return (
    <div className="grid gap-5">
      {parcelsNewestFirst(order).map((parcel, index) => (
        <ParcelCard
          key={parcel.id}
          parcel={parcel}
          title={
            many
              ? t('storefront.order.parcels.titleNumber', { number: count - index })
              : t('storefront.order.parcels.title')
          }
          onPrint={onPrint}
        />
      ))}
    </div>
  );
}
```

One card per parcel:

- **The header is `CardHeader`'s markup by hand,** because `CardHeader`'s title is text only and the pill sits beside
  the title. Print label needs a tracking code, and a cancelled parcel goes nowhere, so neither has it.
- **While booking,** a `role="status"` line, so a screen reader hears when it moves on. The spinner turns only when
  the person has not asked for reduced motion. "Tried 2 times" shows only once a try failed.
- **A failed booking** shows the courier's own words when it sent some ("Invalid phone number"), because they say
  what to fix. Otherwise it shows our error's words.
- **The facts** are only the ones that exist: no tracking code while booking, no courier's ID for a manual parcel,
  no "Last news" for a manual one (it has none).
- **The courier's news** show only for an API parcel the courier has. The order's Timeline card's look keeps the
  page to one style. Each step's key includes its place, because a courier can send two steps with the same time
  and status.
- **`ParcelCards`** numbers the cards only when there is more than one, newest first, so "Parcel 2" sits above
  "Parcel 1".

```tsx
// ---------------------------------------------------------------------------------------------
// Book courier

// The form keeps the tracking code as typed: the schema upper-cases it on the way out, so the box
// does not jump while typing. The account's '' is "Pick an account" (courier_pick_account)
const BOOK_FIELDS = ['accountId', 'trackingCode'] as const;

export function BookCourierDialog({
  order,
  onDone,
}: {
  order: StorefrontOrder;
  onDone: (saved: StorefrontOrder, toast: string) => void;
}) {
  const { t } = useLocale();
  const collect = useCollect();
  const choices = useQuery(storefrontCourierChoicesQuery(useTenantId()));
  const accounts = choices.data?.accounts ?? [];
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<BookShipmentFormValues>({
    resolver: zodResolver(bookShipmentInputSchema, { error: contractErrorMap }),
    // The default account first, like the Packed dialog (decision 13); none = pick one
    values: {
      version: order.version,
      accountId: choices.data?.defaultAccountId ?? '',
      trackingCode: '',
    },
    resetOptions: { keepDirtyValues: true },
  });
  const accountId = useWatch({ control, name: 'accountId' });
  const account = accounts.find((one) => one.id === accountId) ?? null;
  const manual = account?.provider === 'manual';

  const onSubmit = handleSubmit(async (values) => {
    try {
      // A code for an API account is ignored by the API; send none, so nothing typed before the
      // account changed travels
      const body = manual ? values : { ...values, trackingCode: '' };
      const saved = await call(routes.storefrontOrders.bookShipment, {
        params: { id: order.id },
        body,
      });
      const parcel = saved.shipments.at(-1);
      const name = account?.name ?? '';
      onDone(
        saved,
        parcel?.trackingCode !== null && parcel?.trackingCode !== undefined && manual
          ? t('storefront.order.booked', {
              number: saved.orderNo,
              courier: name,
              code: parcel.trackingCode,
            })
          : t('storefront.order.bookingStarted', { number: saved.orderNo, courier: name }),
      );
    } catch (error) {
      applyApiError(error, BOOK_FIELDS, setError);
    }
  });
  const serverError = errors.root?.server?.message;

  return (
    <DialogContent
      title={t('storefront.order.booking.title', { number: order.orderNo })}
      description={
        isZeroMoney(order.codAmount)
          ? t('storefront.order.booking.descriptionPaid')
          : t('storefront.order.booking.description', { amount: collect(order.codAmount) })
      }
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            type="submit"
            form="book-courier"
            disabled={isSubmitting || accounts.length === 0}
          >
            {t('storefront.order.booking.submit')}
          </Button>
        </>
      }
    >
      <form
        id="book-courier"
        noValidate
        className="grid gap-[18px]"
        onSubmit={(event) => void onSubmit(event)}
      >
        {serverError !== undefined && <FormAlert message={serverError} />}
        {choices.isError && <FormAlert message="unknown_error" />}
        {choices.data && accounts.length === 0 ? (
          <p className="text-body-sm text-ink-2">{t('storefront.order.booking.noAccounts')}</p>
        ) : (
          <SelectField
            label={t('storefront.order.booking.account')}
            icon={ShippingTruck01Icon}
            options={[
              { value: '', label: t('storefront.order.booking.accountPlaceholder') },
              ...accounts.map((one) => ({
                value: one.id,
                label: t('storefront.order.booking.accountOption', {
                  name: one.name,
                  courier: t(`storefront.couriers.names.${one.courier}`),
                }),
              })),
            ]}
            hint={
              account !== null && !manual
                ? t('storefront.order.booking.apiHint', {
                    courier: t(`storefront.couriers.names.${account.courier}`),
                  })
                : undefined
            }
            {...register('accountId')}
            error={errors.accountId?.message}
          />
        )}
        {manual && (
          <TextField
            label={t('storefront.order.booking.trackingCode')}
            icon={DeliveryTracking01Icon}
            placeholder={t('storefront.order.booking.trackingCodePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            hint={t('storefront.order.booking.trackingCodeHint')}
            {...register('trackingCode')}
            error={errors.trackingCode?.message}
          />
        )}
      </form>
    </DialogContent>
  );
}
```

Book courier:

- **The account starts at the default,** like the Packed dialog. `values` (not `defaultValues`) fills it in when the
  choices arrive, and `keepDirtyValues` keeps what the member already picked.
- **The tracking code box shows only for a manual account.** The API ignores a code for an API account, but the
  dialog sends an empty one anyway, so a code typed before the account changed never travels.
- **The toast** says "booked, code …" for a manual parcel (it is booked at once) and "Booking …" for an API one (the
  worker books it a moment later).
- **The description** says what the rider collects, or that the order is paid, because the courier is told that
  amount and the member should see it before booking.

```tsx
// ---------------------------------------------------------------------------------------------
// The label

// The parcel's label (approved with the mockup): an A6 sheet (105 × 148 mm), which is a 4 × 6 in
// thermal label's size and a quarter of A4. Black on white with no fills, like the POS receipt. Like
// PrintSheet it goes straight into <body> with data-print-sheet, so styles.css prints it and nothing
// else; its own @page wins while it is there, and goes with it. It prints once when it mounts, then
// tells the page it is done (window.print() waits for the dialog), so the page unmounts it. No
// barcode: the courier prints its own label from its panel; this one is for the shop's own shelf
// and for a courier booked by hand.
export function ParcelLabel({
  order,
  parcel,
  onPrinted,
}: {
  order: StorefrontOrder;
  parcel: StorefrontShipment;
  onPrinted: () => void;
}) {
  const { t, format } = useLocale();
  const settings = useQuery(settingsQuery(useTenantId())).data;
  const printed = useRef(false);
  useEffect(() => {
    // The company comes first: printing before it arrives would print a label with no sender.
    // The ref: React's second run of the effect in development must not print twice
    if (settings === undefined || printed.current) return;
    printed.current = true;
    window.print();
    onPrinted();
  }, [settings, onPrinted]);
  if (settings === undefined) return null;
  const courier = t(`storefront.couriers.names.${parcel.courier}`);
  return createPortal(
    <article
      data-print-sheet=""
      aria-label={t('storefront.order.label.title', { number: order.orderNo })}
      className="hidden h-[148mm] w-[105mm] bg-surface p-[6mm] text-ink print:block"
    >
      <style>{'@page { size: A6; margin: 0; }'}</style>
      <div className="grid content-start gap-3.5 text-[13px] leading-snug">
        <p className="border-b-2 border-ink pb-2.5 font-mono text-[18px] font-medium">
          {t('storefront.order.label.courierLine', { courier, code: parcel.trackingCode ?? '' })}
        </p>
        <p className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.order')}
          </span>
          <span className="font-mono text-[16px] font-medium">{order.orderNo}</span>
        </p>
        <div className="grid gap-0.5">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.to')}
          </span>
          <span className="text-[16px] font-semibold">{order.customerName}</span>
          <span className="tabular-nums">{order.phone}</span>
          {/* The address keeps the shopper's own line breaks */}
          <span className="whitespace-pre-line">{order.address}</span>
          <span>{order.zoneName}</span>
        </div>
        {/* Always with paisa (decision 20's amount, as the courier was told): it is printed */}
        <p className="border-2 border-ink p-2.5 text-center text-[20px] font-semibold tabular-nums">
          {isZeroMoney(parcel.codAmount)
            ? t('storefront.order.label.paid')
            : t('storefront.order.label.collect', {
                amount: format.money(parcel.codAmount, { decimals: 2 }),
              })}
        </p>
        <div className="grid gap-0.5 border-t border-ink pt-2.5 text-[11.5px]">
          <span className="text-[10px] font-semibold tracking-wide uppercase">
            {t('storefront.order.label.from')}
          </span>
          <span className="text-[13px] font-semibold">
            {settings.legalName ?? settings.companyName}
          </span>
          {settings.address !== null && (
            <span className="whitespace-pre-line">{settings.address}</span>
          )}
          {settings.phone !== null && <span className="tabular-nums">{settings.phone}</span>}
        </div>
      </div>
    </article>,
    document.body,
  );
}
```

The label (approved with the mockup, mine 49). It goes into `<body>` with `data-print-sheet`, like the POS receipt,
so the print rule in `styles.css` prints it and nothing else. Its own `@page` (A6, no margin) wins while it is in the
page and goes with it. It waits for the company's settings, so it never prints without a sender, and the ref stops
React's second run of the effect in development from printing twice. `window.print()` waits for the print dialog,
so `onPrinted` then takes the label out of the page. The address keeps the shopper's line breaks. The amount always
has paisa, because it is printed.

### The order page

```diff
@@ -1,5 +1,6 @@
 import {
   Agreement01Icon,
+  Alert02Icon,
   AlertCircleIcon,
   ArrowLeft01Icon,
   CancelCircleIcon,
@@ -9,6 +10,7 @@ import {
   PackageDeliveredIcon,
   PackageIcon,
   PackageReceiveIcon,
+  ShippingTruck01Icon,
   ShoppingCart01Icon,
   SmartPhone01Icon,
 } from '@hugeicons/core-free-icons';
@@ -23,6 +25,7 @@ import {
   type ShopOrderStatus,
   type StorefrontOrder,
   type StorefrontOrderLine,
+  type StorefrontShipment,
 } from '@omnivo/contracts';
 import { useLocale } from '@omnivo/i18n';
 import {
@@ -45,6 +48,11 @@ import { useForm } from 'react-hook-form';
 
 import { CancelDraftDialog } from '../components/cancel-draft-dialog';
 import { DocumentNotice } from '../components/document-notice';
+import {
+  BookCourierDialog,
+  ParcelCards,
+  ParcelLabel,
+} from '../components/storefront-order-parcels';
 import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
 import {
   invoiceTookPayment,
@@ -57,9 +65,12 @@ import { ApiRequestError, call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
 import { useCan } from '../lib/permissions';
 import {
+  canBook,
   canCancel,
   nextStep,
+  openParcel,
   type OrderStep,
+  parcelFailed,
   storefrontOrderQuery,
 } from '../lib/storefront-orders';
 import { useOnline } from '../lib/use-online';
@@ -105,7 +116,7 @@ const STEP_BUTTONS = {
   deliver: PackageDeliveredIcon,
 } as const satisfies Record<OrderStep, IconSvgElement>;
 
-type Dialogs = 'pack' | 'deliver' | 'cancel' | null;
+type Dialogs = 'pack' | 'deliver' | 'cancel' | 'book' | null;
 
 // After a move: the order's own answer at once, then every read the move changed. The orders (the
 // list, the sidebar's count), and the sales, stock, books and customers, because Packed posts a
@@ -445,6 +456,10 @@ function CancelDialog({
     resolver: zodResolver(cancelStorefrontOrderInputSchema, { error: contractErrorMap }),
     defaultValues: { version: order.version, reason: '' },
   });
+  // A parcel the courier has a code for. One still booking is refused by the API
+  // (storefront_order_parcel_booking), and that error shows above the box
+  const open = openParcel(order);
+  const booked = open?.status === 'booked' ? open : null;
   const onSubmit = handleSubmit(async (values) => {
     try {
       const saved = await call(routes.storefrontOrders.cancelOrder, {
@@ -484,6 +499,14 @@ function CancelDialog({
         {errors.root?.server?.message !== undefined && (
           <FormAlert message={errors.root.server.message} />
         )}
+        {/* Step 28a (decision 21): a booked parcel is cancelled here too, but the courier is not
+            told (Steadfast has no cancel call), so the member must cancel it on its panel. warn:
+            it is theirs to do (approved with the mockup) */}
+        {booked !== null && (
+          <DocumentNotice tone="warn" icon={Alert02Icon}>
+            {t('storefront.order.cancelling.parcelBooked', { courier: booked.account.name })}
+          </DocumentNotice>
+        )}
         <TextAreaField
           label={t('storefront.order.cancelling.reason')}
           optional
@@ -506,8 +529,46 @@ function OrderView({ order }: { order: StorefrontOrder }) {
   const canManage = can('storefront.order.manage');
   const applyMove = useApplyMove();
   const [dialog, setDialog] = useState<Dialogs>(null);
+  // Step 28a: the parcel whose label is printing (ParcelLabel prints once, then clears this)
+  const [printing, setPrinting] = useState<StorefrontShipment | null>(null);
   const step = nextStep(order);
   const cancellable = canCancel(order);
+  const failed = parcelFailed(order);
+  const open = openParcel(order);
+  const bookable = canBook(order);
+  const stopPrinting = useCallback(() => {
+    setPrinting(null);
+  }, []);
+  // Step 28a (decision 5): the step's line once a packed order is with a courier, or a shipped one
+  // is with an API courier. null keeps the status's own line (next.*)
+  const parcelText = ((): string | null => {
+    if (order.status === 'packed') {
+      if (open === null) return t('storefront.order.nextNoParcel');
+      const courier = open.account.name;
+      if (open.status === 'booking') return t('storefront.order.nextBooking', { courier });
+      return open.account.provider === 'manual'
+        ? t('storefront.order.nextManual', { courier })
+        : t('storefront.order.nextBooked', { courier });
+    }
+    if (order.status === 'shipped' && open !== null && open.account.provider !== 'manual') {
+      return t('storefront.order.nextShipped', { courier: open.account.name });
+    }
+    return null;
+  })();
+
+  // Step 28a: "Book again" on a parcel that failed five times books the same parcel (the same
+  // invoice) once more, in the worker
+  const retry = useMutation({
+    mutationFn: (parcel: StorefrontShipment) =>
+      call(routes.storefrontOrders.retryShipment, {
+        params: { id: order.id, shipmentId: parcel.id },
+        body: { version: order.version },
+      }),
+    onSuccess: async (saved) => {
+      await applyMove(saved);
+      toast(t('storefront.order.bookingAgain', { number: saved.orderNo }));
+    },
+  });
 
   // The two moves with no dialog of their own (Make the sales order, Shipped), and Delivered's
   // confirm. Their refusals (version_conflict, storefront_order_step_invalid, a sales error on the
@@ -586,6 +647,42 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         {t('storefront.order.deliveredPaid')}
       </DocumentNotice>,
     );
+  } else if (!blocked && failed !== null) {
+    // Step 28a (decision 4): the booking failed five times. crit: nothing moves until someone
+    // books it again. Its reason is the error's own words; the courier's are on the parcel card
+    notices.push(
+      <DocumentNotice
+        key="next"
+        tone="crit"
+        icon={Alert02Icon}
+        action={
+          canManage && (
+            <button
+              type="button"
+              disabled={retry.isPending}
+              className="font-medium text-brand underline-offset-3 hover:underline"
+              onClick={() => {
+                retry.mutate(failed);
+              }}
+            >
+              {t('storefront.order.bookAgain')}
+            </button>
+          )
+        }
+      >
+        {t('storefront.order.parcelFailed', {
+          courier: failed.account.name,
+          reason: errorText(failed.error ?? 'unknown_error'),
+        })}
+      </DocumentNotice>,
+    );
+  } else if (!blocked && canManage && parcelText !== null) {
+    // Step 28a (decision 5): once the order has a parcel, the line says who moves the order
+    notices.push(
+      <DocumentNotice key="next" tone="neutral">
+        {parcelText}
+      </DocumentNotice>,
+    );
   } else if (!blocked && canManage && order.status !== 'cancelled' && order.status !== 'returned') {
     // Decision 7: a delivered order's money comes in as an ordinary receipt for its invoice, for
     // someone who may write one
@@ -626,7 +723,8 @@ function OrderView({ order }: { order: StorefrontOrder }) {
             <h1 className="text-h1">{order.orderNo}</h1>
             <span className="flex flex-wrap gap-1.5">
               <OrderStatusPill status={order.status} />
-              {order.documentError !== null && <NeedsAttentionPill />}
+              {/* The sales order could not be made, or (step 28a) the parcel failed to book */}
+              {order.needsAttention && <NeedsAttentionPill />}
             </span>
           </div>
           <p className="mt-1 text-label text-ink-3 tabular-nums">
@@ -651,9 +749,24 @@ function OrderView({ order }: { order: StorefrontOrder }) {
                 {t('storefront.order.cancel')}
               </Button>
             )}
+            {/* Step 28a: a packed order with no parcel on its way (approved with the mockup) */}
+            {bookable && (
+              <Button
+                variant="secondary"
+                onClick={() => {
+                  setDialog('book');
+                }}
+              >
+                <HugeiconsIcon icon={ShippingTruck01Icon} size={17} strokeWidth={1.5} />
+                {t('storefront.order.book')}
+              </Button>
+            )}
             {step !== null && (
               <Button
-                className={cn(!cancellable && 'col-span-2')}
+                className={cn(
+                  (!cancellable || bookable) && 'col-span-2',
+                  bookable && 'sm:col-span-1',
+                )}
                 disabled={move.isPending}
                 onClick={() => {
                   press(step);
@@ -667,6 +780,11 @@ function OrderView({ order }: { order: StorefrontOrder }) {
         )}
       </header>
       {moveError !== null && dialog === null && <FormAlert message={moveError} />}
+      {retry.error !== null && (
+        <FormAlert
+          message={retry.error instanceof ApiRequestError ? retry.error.code : 'unknown_error'}
+        />
+      )}
       {notices.length > 0 && <div className="grid gap-2.5">{notices}</div>}
       {/* Two columns from xl. Below it the wrappers are `contents`, so the four cards are one
           stack, and `order` puts the address and the documents before the timeline */}
@@ -675,6 +793,13 @@ function OrderView({ order }: { order: StorefrontOrder }) {
           <div className="order-1">
             <LinesCard order={order} />
           </div>
+          {/* Step 28a: under the lines and before the payments (approved with the mockup). On a
+              phone order-2 too, so the DOM order puts it before the payments */}
+          {order.shipments.length > 0 && (
+            <div className="order-2">
+              <ParcelCards order={order} onPrint={setPrinting} />
+            </div>
+          )}
           {/* Step 27d: under the lines, the gateway's visits (none: no card, and the empty
               wrapper takes no gap, being `contents` on a phone and empty in the xl grid) */}
           {order.payments.length > 0 && (
@@ -729,6 +854,22 @@ function OrderView({ order }: { order: StorefrontOrder }) {
           />
         )}
       </Dialog>
+      <Dialog
+        open={dialog === 'book'}
+        onOpenChange={(open) => {
+          if (!open) setDialog(null);
+        }}
+      >
+        {dialog === 'book' && (
+          <BookCourierDialog
+            order={order}
+            onDone={(saved, message) => void afterDialog(saved, message)}
+          />
+        )}
+      </Dialog>
+      {printing !== null && (
+        <ParcelLabel order={order} parcel={printing} onPrinted={stopPrinting} />
+      )}
       <Dialog
         open={dialog === 'pack'}
         onOpenChange={(open) => {
@@ -739,15 +880,21 @@ function OrderView({ order }: { order: StorefrontOrder }) {
           <Suspense fallback={null}>
             <PackDialog
               order={order}
-              onDone={(saved) =>
-                afterDialog(
+              onDone={(saved) => {
+                // Step 28a: Packed asked a courier for the parcel. The toast says the booking
+                // started, not that it worked: the worker books it a moment later
+                const booking = openParcel(saved);
+                const words = { number: saved.orderNo, delivery: saved.delivery?.number ?? '' };
+                return afterDialog(
                   saved,
-                  t('storefront.order.packed', {
-                    number: saved.orderNo,
-                    delivery: saved.delivery?.number ?? '',
-                  }),
-                )
-              }
+                  booking?.status === 'booking'
+                    ? t('storefront.order.packedBooking', {
+                        ...words,
+                        courier: booking.account.name,
+                      })
+                    : t('storefront.order.packed', words),
+                );
+              }}
             />
           </Suspense>
         )}
@@ -763,6 +910,13 @@ export function StorefrontOrderPage() {
   const { data: order, error } = useQuery({
     ...storefrontOrderQuery(useTenantId(), orderId),
     enabled: online && orderId !== '',
+    // Step 28a: the worker books a parcel a moment after Packed (or after Book again), so the page
+    // asks again every 3 seconds while one is booking, and stops once it is booked or failed. The
+    // courier's later news come minutes apart; a reload or the next visit shows them
+    refetchInterval: (query) =>
+      query.state.data?.shipments.some((parcel) => parcel.status === 'booking') === true
+        ? 3000
+        : false,
   });
 
   if (!online) {
```

Why each change is written this way:

- **The Cancel dialog** warns when the parcel is booked (decision 21): Omnivo cancels it in its own books, but the
  courier is not told, so the member must cancel it on the courier's panel. A parcel still booking is refused by
  the API (`storefront_order_parcel_booking`), and that error shows above the box.
- **`parcelText`** is the step's line once the order has a parcel (decision 5): who moves the order next, and how.
  `null` keeps the status's own line. A shipped order with a manual parcel keeps the usual line, because the member
  marks it delivered.
- **The failed booking's notice is `crit`,** because nothing moves until someone books again. Book again is a real
  button in the notice's action place. It books the same parcel again (`retryShipment`), and its error shows above
  the cards, like a move's.
- **"Needs attention" in the header now reads `order.needsAttention`,** which the API sets for a failed sales order
  and for a failed parcel. The page no longer works it out itself.
- **Book courier** sits between Cancel and the step's button. On a phone the three buttons are two columns, and the
  step's button takes the whole second row.
- **The parcel cards** have `order-2`, like the payments. On a phone the wrappers are `contents`, so the DOM order
  puts the parcels before the payments.
- **The Packed toast** says the booking started when Packed asked a courier, because the worker books it a moment
  later and the card shows how it went.
- **`refetchInterval`** asks again every 3 seconds while a parcel is booking, and stops when none is (mine 51). The
  courier's later news come minutes apart, so the page does not keep asking for them.

```diff
@@ -4,10 +4,12 @@ import {
   Delete02Icon,
   Image01Icon,
   PlusSignIcon,
+  ShippingTruck01Icon,
 } from '@hugeicons/core-free-icons';
 import { HugeiconsIcon } from '@hugeicons/react';
 import {
   contractErrorMap,
+  type CourierChoices,
   packStorefrontOrderInputSchema,
   routes,
   type StorefrontOrder,
@@ -24,6 +26,7 @@ import {
   IconButton,
   Input,
   Select,
+  SelectField,
 } from '@omnivo/ui';
 import { useQuery } from '@tanstack/react-query';
 import { useCallback, useId, useState } from 'react';
@@ -35,6 +38,7 @@ import {
   type PackLineValues,
   pickedOf,
   plainQuantity,
+  storefrontCourierChoicesQuery,
   storefrontPackPlanQuery,
   toPackInput,
 } from '../lib/storefront-orders';
@@ -52,7 +56,8 @@ const MAX_PICKS = 20;
 
 // The paths this dialog has a place for. Anything else the API names shows above the lines, so no
 // refusal is ever silent
-const PLACED = /^lines\.\d+\.(position|picks(\.\d+\.(batchId|quantity|serialNumbers(\.\d+)?))?)$/;
+const PLACED =
+  /^(lines\.\d+\.(position|picks(\.\d+\.(batchId|quantity|serialNumbers(\.\d+)?))?)|courierAccountId)$/;
 
 type Errors = Record<string, string>;
 
@@ -324,14 +329,23 @@ function PackLine({
 function PackForm({
   order,
   plan,
+  choices,
   onDone,
 }: {
   order: StorefrontOrder;
   plan: StorefrontPackPlan;
+  // null: the accounts could not be read. Packing never waits for a courier: the select is left
+  // out, and the parcel is booked later with Book courier
+  choices: CourierChoices | null;
   onDone: (saved: StorefrontOrder) => Promise<void>;
 }) {
   const { t } = useLocale();
   const [lines, setLines] = useState(() => packFormValues(plan));
+  // Step 28a (decision 13): API accounts only (a manual one has no code yet at Packed), starting
+  // with the default; with none, "Don't book now"
+  const bookable = choices?.accounts.filter((account) => account.provider !== 'manual') ?? [];
+  const [courierAccountId, setCourierAccountId] = useState(choices?.defaultAccountId ?? '');
+  const courier = bookable.find((account) => account.id === courierAccountId) ?? null;
   const [errors, setErrors] = useState<Errors>({});
   const [rootError, setRootError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);
@@ -352,7 +366,7 @@ function PackForm({
     // The contract's own checks first (a quantity typed wrong, a serial number twice), with the
     // same paths as the API's, so a mistake shows without a round trip
     const parsed = packStorefrontOrderInputSchema.safeParse(
-      toPackInput(plan, lines, order.version),
+      { ...toPackInput(plan, lines, order.version), courierAccountId },
       { error: contractErrorMap },
     );
     if (!parsed.success) {
@@ -426,6 +440,31 @@ function PackForm({
             />
           );
         })}
+        {/* Step 28a: after the lines, the last thing the packer decides. Only while the shop has
+            an account that books by API: without one there is nothing to choose */}
+        {bookable.length > 0 && (
+          <div className="pt-2">
+            <SelectField
+              label={t('storefront.order.packing.courier')}
+              icon={ShippingTruck01Icon}
+              name="courierAccountId"
+              value={courierAccountId}
+              onChange={(event) => {
+                setCourierAccountId(event.target.value);
+              }}
+              options={[
+                { value: '', label: t('storefront.order.packing.courierNone') },
+                ...bookable.map((account) => ({ value: account.id, label: account.name })),
+              ]}
+              hint={
+                courier === null
+                  ? t('storefront.order.packing.courierNoneHint')
+                  : t('storefront.order.packing.courierHint', { courier: courier.name })
+              }
+              error={errors.courierAccountId}
+            />
+          </div>
+        )}
       </form>
     </DialogContent>
   );
@@ -439,8 +478,16 @@ export function PackDialog({
   onDone: (saved: StorefrontOrder) => Promise<void>;
 }) {
   const { t } = useLocale();
-  const plan = useQuery(storefrontPackPlanQuery(useTenantId(), order.id));
-  if (plan.data) return <PackForm order={order} plan={plan.data} onDone={onDone} />;
+  const tenantId = useTenantId();
+  const plan = useQuery(storefrontPackPlanQuery(tenantId, order.id));
+  // Step 28a: the accounts for "Send with", asked with the plan. The form waits for both, so the
+  // select never appears under the packer's hand; a failed read is no select (null)
+  const choices = useQuery(storefrontCourierChoicesQuery(tenantId));
+  if (plan.data && (choices.data !== undefined || choices.isError)) {
+    return (
+      <PackForm order={order} plan={plan.data} choices={choices.data ?? null} onDone={onDone} />
+    );
+  }
   // Until the plan comes, the dialog's frame, so the button's press always opens something; when
   // it cannot come, the line that says to close and try again
   return (
```

"Send with" (decision 13):

- **API accounts only,** starting with the default. With none, "Don't book now". The select shows only when the
  shop has an API account: without one there is nothing to choose.
- **The dialog waits for the plan and the choices together,** so the select never appears under the packer's
  hand. If the choices cannot be read, the dialog opens without the select: packing never waits for a courier.
- **`courierAccountId` goes through the contract's own check** with the lines, and `PLACED` now knows its path, so
  the API's `courier_account_not_bookable` shows under the select instead of at the top.

### Export for courier

```diff
@@ -1,5 +1,7 @@
-import { Search01Icon, ShoppingBag01Icon } from '@hugeicons/core-free-icons';
+import { Download04Icon, Search01Icon, ShoppingBag01Icon } from '@hugeicons/core-free-icons';
+import { HugeiconsIcon } from '@hugeicons/react';
 import {
+  routes,
   STOREFRONT_ORDER_VIEWS,
   type StorefrontOrderSort,
   type StorefrontOrderSummary,
@@ -15,16 +17,19 @@ import {
   PageHeader,
   SegmentedControl,
   type SortingState,
+  toast,
+  toIsoDate,
 } from '@omnivo/ui';
-import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
+import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
 import { useNavigate, useSearch } from '@tanstack/react-router';
 import { useCallback, useMemo, useState } from 'react';
 
 import { NeedsAttentionPill, OrderStatusPill } from '../components/storefront-order-pills';
 import { StorefrontOffline, useShopMoney, ViewShopLink } from '../components/storefront-parts';
+import { ApiRequestError, call } from '../lib/api';
 import { useCan } from '../lib/permissions';
 import { storefrontSetupQuery } from '../lib/storefront';
-import { type OrderFilter, storefrontOrdersQuery } from '../lib/storefront-orders';
+import { courierCsv, type OrderFilter, storefrontOrdersQuery } from '../lib/storefront-orders';
 import { useDebounced } from '../lib/use-debounced';
 import { useOnline } from '../lib/use-online';
 import { useTenantId, useTimeZone } from '../lib/workspace';
@@ -35,6 +40,59 @@ import { useTenantId, useTimeZone } from '../lib/workspace';
 
 const column = dataTableColumns<StorefrontOrderSummary>();
 
+// A file the browser makes itself: a Blob, a hidden link, a click (the product import's template
+// does the same)
+function saveCsv(fileName: string, text: string): void {
+  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
+  const link = document.createElement('a');
+  link.href = url;
+  link.download = fileName;
+  link.click();
+  URL.revokeObjectURL(url);
+}
+
+// Step 28a (decision 19): "Export for courier", for a shop that books on the courier's own panel.
+// The packed orders with no parcel on its way, whatever tab is open (approved with the mockup), as
+// a CSV in the courier's bulk-upload columns. An empty answer is a toast, never an empty file: a
+// file with only a header uploads as nothing and looks like the courier's fault
+function ExportButton() {
+  const { t, format, errorText } = useLocale();
+  const exporter = useMutation({
+    mutationFn: () => call(routes.storefrontOrders.courierExport),
+    onSuccess: ({ rows, more }) => {
+      if (rows.length === 0) {
+        toast(t('storefront.orders.exportEmpty'));
+        return;
+      }
+      const items = (count: number) =>
+        t('storefront.orders.items', { count, formatted: format.number(count) });
+      // The local day in the name, so two exports of one day sort together
+      saveCsv(`courier-orders-${toIsoDate(new Date())}.csv`, courierCsv(rows, items));
+      const done = t('storefront.orders.exported', {
+        count: rows.length,
+        formatted: format.number(rows.length),
+      });
+      // One toast: a second would replace the first before it is read
+      toast(more ? `${done}. ${t('storefront.orders.exportedMore')}` : done);
+    },
+    onError: (error) => {
+      toast(errorText(error instanceof ApiRequestError ? error.code : 'unknown_error'));
+    },
+  });
+  return (
+    <Button
+      variant="secondary"
+      disabled={exporter.isPending}
+      onClick={() => {
+        exporter.mutate();
+      }}
+    >
+      <HugeiconsIcon icon={Download04Icon} size={17} strokeWidth={1.5} />
+      {exporter.isPending ? t('storefront.orders.exporting') : t('storefront.orders.exportCourier')}
+    </Button>
+  );
+}
+
 // Confirmed and Total sort both ways; the newest confirmed first is the contract's default
 const DEFAULT_SORT: SortingState = [{ id: 'confirmedAt', desc: true }];
 
@@ -211,7 +269,13 @@ export function StorefrontOrdersPage() {
       <PageHeader
         title={t('storefront.orders.title')}
         description={t('storefront.orders.description')}
-        actions={shop !== null && <ViewShopLink href={shop.shopUrl} />}
+        actions={
+          <>
+            {shop !== null && <ViewShopLink href={shop.shopUrl} />}
+            {/* For booking, so .manage, like the route; online only, like the page */}
+            {online && can('storefront.order.manage') && <ExportButton />}
+          </>
+        }
       />
       {!online && <StorefrontOffline />}
       {online && (
```

The button is in the page header, on every tab, for `storefront.order.manage` (the route's permission) and only
online. An empty answer is a toast, never a file: a file with only a header uploads as nothing and looks like the
courier's fault. The file name has the local day, so two exports of one day sort together. When more orders wait
than one file holds, the toast says so in the same toast: a second toast would replace the first before anyone read
it.

### The tracking page's order

The order page sorts a parcel's steps by the courier's time, then by when each step reached us. The tracking page
sorted by the courier's time only, because 0078 did not let `omnivo_shop` read `received_at`. Steadfast's times
have no fraction of a second, and 28a.3 moves a time from before the booking to the booking's moment, so two steps
often share one second. Postgres then returned them in whatever order it read them: the order in which they were
written, most of the time, but nothing promised it.

```sql
-- Custom SQL migration file, put your code below! --
-- Step 28a.6 (the user's choice, 2026-11-23): the tracking page shows a parcel's steps in the
-- order they happened. Two steps often share one courier second (Steadfast's times have no
-- fraction, and 28a.3 clamps a time from before the booking to the booking's moment), so the
-- tracking page breaks the tie by when the step reached us, as the ERP's order page does. 0078 gave
-- omnivo_shop only the columns the page showed then; it needs received_at too, to sort by it.
-- A time, not a secret: it says when the courier's news arrived, nothing about the shopper.
GRANT SELECT (received_at) ON storefront_shipment_events TO omnivo_shop;
```

One column, for one role. It is a time, not a secret: it says when the courier's news arrived, nothing about the
shopper. Drizzle's journal gets the file's entry with `drizzle-kit generate --custom`, like 0078; the schema does
not change.

```diff
@@ -5,7 +5,7 @@ import { and, asc, eq, inArray } from 'drizzle-orm';
 import type { Transaction } from '../../common/tenant/with-tenant.js';
 
 // Step 28a: an order's parcels as the tracking page shows them (26e's shopShipmentSchema), read
-// inside ShopDb.orders as omnivo_shop. Only the columns 0078 grants that role, named one by one: a
+// inside ShopDb.orders as omnivo_shop. Only the columns 0078 (and 0079) grant that role, named one by one: a
 // select() of the whole row would ask for the COD amount and the courier's errors and fail. The
 // restrictive policies leave out a parcel still booking or failed, and a notice we could not read,
 // whatever this query asks (28a.2's mine 27). The tenant comes from the shop's host (ShopScope)
@@ -44,7 +44,9 @@ export async function shopShipmentsOf(
         ),
       ),
     )
-    .orderBy(asc(storefrontShipmentEvents.occurredAt));
+    // Steps of one courier second in the order they reached us (0079 grants received_at for it),
+    // as the order page sorts them. Without it, ties came back in whatever order Postgres read them
+    .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
   return parcels.flatMap((parcel) => {
     const steps = events
       .filter((event) => event.shipmentId === parcel.id)
```

The same two keys as the order page's query (`shipmentsOf`), so both pages show one order of steps.

```diff
@@ -1257,6 +1257,30 @@ describe("the courier's news", () => {
     expect(tracking[0]?.events.map((event) => event.note)).toEqual(steps.map(([, note]) => note));
   });
 
+  // 28a.6 (0079): two steps of one courier second, inserted in the opposite order to when they
+  // arrived, so only the tie-break by received_at puts them right (Postgres would return them in
+  // the order they were written). Inserted by hand: the API always writes in arrival order. The id
+  // is made here because the app makes the ids, so the column has no default
+  it('shows steps of one courier second in the order they arrived, on the tracking page too', async () => {
+    const order = await confirm(925);
+    await packed(order.id, steadfast.id);
+    const parcel = lastParcel(await parcelIs(order.id, 'booked'));
+    const at = new Date(Date.now() + 60_000);
+    const step = (note: string, arrived: number) => sql`
+      INSERT INTO storefront_shipment_events
+        (id, tenant_id, shipment_id, status, note, occurred_at, received_at, source, event_key)
+      SELECT gen_random_uuid(), tenant_id, id, 'in_transit', ${note}, ${at}, ${new Date(at.getTime() + arrived)},
+             'webhook', encode(sha256(convert_to(${note}, 'UTF8')), 'hex')
+        FROM storefront_shipments WHERE id = ${parcel.id}`;
+    await step('Left Tejgaon hub', 2_000);
+    await step('Reached Tejgaon hub', 1_000);
+    const notes = (events: readonly { note: string | null }[]) =>
+      events.map((event) => event.note).slice(-2);
+    const expected = ['Reached Tejgaon hub', 'Left Tejgaon hub'];
+    expect(notes(lastParcel(await getOrder(order.id)).events)).toEqual(expected);
+    expect(notes((await trackingOf(order))[0]?.events ?? [])).toEqual(expected);
+  });
+
   it('keeps a body too large for its column as a marker', async () => {
     const order = await confirm(921);
     await packed(order.id, steadfast.id);
```

The test writes two steps of the same second straight into the table, in the opposite order to their
`received_at`. The API always writes in arrival order, so only a hand insert can show that the order comes from
the sort and not from luck. The `id` is made in the insert because the app makes the ids, so the column has no
default. Both pages must show "Reached Tejgaon hub" before "Left Tejgaon hub".

```diff
@@ -455,6 +455,13 @@ describe('the database roles', () => {
       code: '42501',
       message: 'permission denied for table storefront_shipment_events',
     });
+    // 0079: when a step arrived, for the tracking page's order. Still only Nirvor's
+    const arrived = await asShop(
+      drizzleSql`SELECT tenant_id::text, received_at FROM storefront_shipment_events`,
+    );
+    expect(new Set(Array.from(arrived).map((row) => row.tenant_id))).toEqual(
+      new Set([nirvor.tenantId]),
+    );
     // Acme's parcel, from Nirvor's shop: not there
     const seen = await asShop(drizzleSql`SELECT tenant_id::text FROM storefront_shipments`);
     expect(Array.from(seen).map((row) => row.tenant_id)).toEqual([nirvor.tenantId]);
```

`omnivo_shop` can read the new column, and still only its own workspace's rows; the test above it still shows that
`raw` stays closed.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/contracts test                       # 681 tests
pnpm --filter @omnivo/i18n test                            # 21 tests
pnpm --filter @omnivo/api typecheck
cd apps/api && npx vitest run src/storefront/shipping/couriers.int.spec.ts --maxWorkers=1   # 25 tests
cd apps/api && npx vitest run src/storefront/shipping/couriers.tenant-leak.int.spec.ts --maxWorkers=1   # 9 tests
cd apps/app && npx vitest run src/lib                      # 242 tests
pnpm --filter @omnivo/app typecheck
pnpm exec eslint <the files of this part>
pnpm exec prettier --check <the files of this part>
```

All pass, except the app type check, which still fails in `src/mocks/storefront-order-data.ts` (the mock orders have
no `codAmount` and `shipments`, and the mock Packed call has no `courierAccountId`). 28a.7 builds the mock courier
API and fixes them, and only then are the screens seen in a browser. Run the courier tests as a whole file, never
with `-t`: they share accounts in order.

Broken on purpose, to see that the checks notice:

- The formula guard turned off in `courierCsv`: the export test fails.
- `parcelFailed` looking at any failed parcel, not the last one: the parcel test fails.
- The tracking page sorting by the courier's time only: the new order test fails.

## 28a.7 — The mock API and the browser tests

The ERP app's mock API (MSW, the `pnpm dev:mock` mode the browser tests run on) learns couriers: the eight routes of
Shop couriers, Book courier, Book again, the packer's short read, the export, and the parcels on every shop order.
Then the screens of 28a.6 are seen in a browser for the first time, compared with the mockup's pictures, and tested
on a desktop and a 390px phone.

The shop needs no change in this part. Its tracking page has drawn parcels since step 26e, from the mock shop's demo
orders and, since 28a.3, from the API (`shop-shipments.ts`). Its type check and its 274 unit tests still pass; its
browser tests run with everything else in 28a.8.

Mine, made while writing:

54. **The mock books in two seconds, on the next read.** It has no worker. A parcel booked by API waits in `booking`
    with a `bookUntil` time, and the first read of the shop's orders after that time answers it, the way the
    API's fake courier would (`settleBookings`). The order page asks again every 3 seconds while a parcel books
    (mine 51), so it sees the answer as it would see the worker's. The same idea as the photo job's pretend delay
    (26g).
55. **The mock's fake codes are not the API's.** The API's fake courier hashes the order number with SHA-256, which
    is async in a browser. The mock uses FNV-1a, a short sync hash: the same order number still always gets the same
    code, but not the code the API would give. The tests check the code's shape (`FAKE` and ten hex digits) only.
56. **A courier that does not answer fails at once in the mock, after "five tries".** The API tries five times over
    about 15 minutes; the mock counts the five tries in one answer, so a test does not wait 15 minutes.
57. **The seed's couriers come with the seeded shop orders only** (the `shopOrders` test option), like the orders
    themselves: four accounts that show each case of the page (the default with news arriving, one whose webhook was
    never pasted and whose keys the fake courier does not answer, one booked by hand, an archived one), and two
    parcels Steadfast carried. Without that option, Shop couriers is empty.
58. **Bug found and fixed in 28a.6's code: the export file wrote `538.0000`.** The API answers money with 4
    decimals, and `courierCsv` copied the amount as it came. The 28a.6 unit test used `538.00` as its input, so it
    did not see it. Now `paisaOf` cuts it to `538.00`, and the test's input is the API's real `538.0000`.
59. **The bell rings for one member in the mock.** The API rings it for every owner and every member with
    `storefront.order.manage`; the mock has one person signed in.
60. **The old packing test chooses "Don’t book now".** Its story is the shop's own rider, moved by hand. With the
    seeded couriers the Packed dialog starts with the default account, and the next-step line now offers a courier
    too, so the test picks the old way on purpose and reads the new line.

### What the mock keeps

```diff
@@ -1,11 +1,16 @@
 import {
+  type CourierProvider,
+  type CourierTestProblem,
   type ErrorCode,
   type PaymentGatewayMode,
   type PaymentGatewayProvider,
   type PaymentGatewayTestProblem,
+  type ShipmentStatus,
+  type ShopCourier,
   type ShopCouponRule,
   type ShopPaymentMethod,
   type ShopPaymentStatus,
+  type ShopShipmentStatus,
   type ShopTextPageSlug,
   slugFromName,
   STOREFRONT_DEFAULT_THEME,
@@ -168,6 +173,8 @@ export interface MockShopOrder {
   // Step 27d: the order's visits to the payment page, oldest first (27d.2's storefront_payments).
   // Empty for a Cash on Delivery order that never tried to pay online
   payments: MockShopPayment[];
+  // Step 28a: the order's parcels, oldest first (28a.2's storefront_shipments)
+  shipments: MockShipment[];
   version: number;
   updatedAt: string;
 }
@@ -203,6 +210,47 @@ export interface MockGateway {
   updatedAt: string;
 }
 
+// Step 28a: a courier account, as the API's courier_accounts row keeps it. The mock keeps the keys
+// in plain text, as it keeps the gateway's password: it has no key to seal them with, and it never
+// answers them (storefront-shipping-data.ts → toCourierAccount). The webhook token is not kept at
+// all: the API keeps only its hash, and the mock has no courier to post with it
+export interface MockCourierAccount {
+  id: string;
+  provider: CourierProvider;
+  name: string;
+  courier: ShopCourier;
+  // null for a manual account
+  keys: { apiKey: string; secretKey: string } | null;
+  hasWebhookToken: boolean;
+  isDefault: boolean;
+  archivedAt: string | null;
+  lastWebhookAt: string | null;
+  lastTest: { at: string; problem: CourierTestProblem | null } | null;
+  version: number;
+  updatedAt: string;
+}
+
+// Step 28a: one parcel, as the API's storefront_shipments row keeps it, with its steps. A parcel in
+// `booking` has bookUntil: when the pretend worker answers (storefront-shipping-data.ts)
+export interface MockShipment {
+  id: string;
+  accountId: string;
+  parcelNo: number;
+  invoice: string;
+  courier: ShopCourier;
+  status: ShipmentStatus;
+  consignmentId: string | null;
+  trackingCode: string | null;
+  codAmount: string;
+  bookedAt: string | null;
+  attempts: number;
+  error: ErrorCode | null;
+  errorDetail: string | null;
+  events: { status: ShopShipmentStatus; at: string; note: string | null }[];
+  lastSyncedAt: string | null;
+  bookUntil: string | null;
+}
+
 // Step 27c: a coupon as the table keeps it (storefront-coupon-data.ts has the rules). The mock has
 // no shop checkout, so the orders that have a code are not real orders here:
 // - used: how many orders hold a use now (the API counts them with storefront_coupon_uses())
@@ -235,6 +283,8 @@ export interface MockStorefront {
   coupons: MockCoupon[];
   // Step 27d: null until the Online payment card is saved the first time
   gateway: MockGateway | null;
+  // Step 28a: the shop's courier accounts, archived ones too, in the order they were made
+  couriers: MockCourierAccount[];
 }
 
 export function emptyStorefront(): MockStorefront {
@@ -253,6 +303,7 @@ export function emptyStorefront(): MockStorefront {
     orders: [],
     coupons: [],
     gateway: null,
+    couriers: [],
   };
 }
 
```

The mock keeps two new things, in the same shape as the API's rows: the shop's courier accounts on
`MockStorefront`, and the parcels on each order. The keys are kept in plain text, as 27d's mock kept the gateway's
password: the mock has no key to seal them with, and the only way out of the mock is `toCourierAccount`, which never
copies them. The webhook token is not kept at all. The API keeps only its hash, and the mock has no courier that
would post with it, so `hasWebhookToken` is enough for the page. `bookUntil` is the mock's own field (mine 54); it is
never in an answer.

### The courier mock

The rules live in a file of their own, `storefront-shipping-data.ts`, which imports no other storefront mock file
but the seed's types. `storefront-order-data.ts` imports it (as it imports the payment mock), and
`workspace-data.ts` seeds through the order file: an import the other way would be a cycle.

```ts
import {
  compareMoney,
  COURIER_EXPORT_MAX_ROWS,
  COURIER_OF_PROVIDER,
  type CourierAccount,
  type CourierAccountSaved,
  type CourierChoices,
  type CourierExport,
  type CourierSetup,
  type CourierTestProblem,
  type CreateCourierAccountInput,
  type ErrorCode,
  isOpenShipment,
  routes,
  type ShopShipmentStatus,
  type StorefrontShipment,
  subtractMoney,
  sumMoney,
  type UpdateCourierAccountInput,
} from '@omnivo/contracts';

import { API_URL } from '../lib/api';
import { MockProblem } from './mock';
import type { MockCourierAccount, MockShipment, MockShopOrder } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 28a: the shop's couriers in the ERP, with the API's rules: Shop couriers
// (apps/api/src/storefront/shipping/courier-accounts.service.ts) and an order's parcels
// (shipments.ts). The mock has no worker and no courier. A parcel booked by API waits in `booking`
// for MOCK_BOOK_MS and is then answered the way the API's FakeCourier answers (settleBookings),
// the first time anything reads the shop's orders after that: the order page asks again every 3
// seconds while a parcel books, so it sees the answer as it would see the worker's.
//
// This file imports no other storefront mock file but the seed's types, like
// storefront-payment-data.ts: storefront-order-data.ts imports it. The audit rows are the
// handlers' (handlers.ts).

// How long the pretend worker takes to book. The API's first try runs within a second or two
export const MOCK_BOOK_MS = 2000;

// The API's FakeCourier: this phone makes the courier refuse the parcel, and these two API keys
// make it answer like Steadfast on a bad day (apps/api/src/shipping/fake-courier.ts)
const FAKE_REFUSED_PHONE = '01700000000';

function fakeProblem(keys: { apiKey: string } | null): CourierTestProblem | null {
  if (keys?.apiKey === 'fake_rejected') return 'rejected';
  if (keys?.apiKey === 'fake_unreachable') return 'unreachable';
  return null;
}

function now(): string {
  return new Date().toISOString();
}

function later(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

// A token like the API's newToken(): 128 random bits as 22 base64url characters
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// The fake courier's answer depends on the invoice only, so a retry gets the same id and code.
// The API hashes with SHA-256 (async in a browser); FNV-1a is enough for a stable mock value
function hashOf(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function fakeBooking(invoice: string): { consignmentId: string; trackingCode: string } {
  const a = hashOf(invoice, 2166136261);
  const b = hashOf(invoice, 3735928559);
  return {
    consignmentId: String(100_000_000 + (a % 900_000_000)),
    trackingCode: `FAKE${b.toString(16).toUpperCase().padStart(8, '0')}${(a & 0xff).toString(16).toUpperCase().padStart(2, '0')}`,
  };
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

function archived(field?: string): MockProblem {
  return new MockProblem(
    409,
    'courier_account_archived',
    field === undefined ? undefined : { [field]: ['courier_account_archived'] },
  );
}

function notBookable(field: string): MockProblem {
  return new MockProblem(422, 'courier_account_not_bookable', {
    [field]: ['courier_account_not_bookable'],
  });
}

function hasParcel(): MockProblem {
  return new MockProblem(409, 'storefront_order_has_parcel');
}

function orderNotBookable(): MockProblem {
  return new MockProblem(409, 'storefront_order_not_bookable');
}
```

The fake courier's answers are the API's (`apps/api/src/shipping/fake-courier.ts`): the phone `01700000000` is
refused, and the two API keys `fake_rejected` and `fake_unreachable` act like Steadfast on a bad day. The mock uses
the same three values, so a person can try every failure the same way on the mock and on a real API with
`COURIER_MODE=fake`.

`newToken` makes 16 random bytes and writes them as base64url without padding, which is 22 characters, the API's own
token shape, so the webhook dialog's box shows what the real one shows. `hashOf` is FNV-1a (mine 55); two seeds give
two numbers, one for the courier's id (nine digits, like Steadfast's) and one for the tracking code.

The error helpers answer with the API's status and code, and with the field the API names where it names one
(`accountId`, `courierAccountId`, `trackingCode`): the form puts the message under that box only when the field is
named.

```ts
// ---------------------------------------------------------------------------------------------
// Courier accounts (Shop couriers)

function findAccount(data: WorkspaceData, id: string): MockCourierAccount {
  const found = data.storefront.couriers.find((account) => account.id === id);
  if (!found) throw notFound();
  return found;
}

function lockAccount(data: WorkspaceData, id: string, version: number): MockCourierAccount {
  const account = findAccount(data, id);
  if (account.version !== version) throw new MockProblem(409, 'version_conflict');
  return account;
}

// Never the keys, and never a token: only whether one is saved
export function toCourierAccount(account: MockCourierAccount): CourierAccount {
  return {
    id: account.id,
    provider: account.provider,
    name: account.name,
    courier: account.courier,
    status: account.archivedAt === null ? 'active' : 'archived',
    webhookUrl:
      account.provider === 'manual'
        ? null
        : `${API_URL}${routes.shipping.steadfastWebhook.path.replace(':id', account.id)}`,
    hasWebhookToken: account.hasWebhookToken,
    lastWebhookAt: account.lastWebhookAt,
    lastTest: account.lastTest,
    version: account.version,
    updatedAt: account.updatedAt,
  };
}

// The audit's view (the API's snapshot): plain values, never a key or a token
export function courierSnapshot(account: MockCourierAccount) {
  return {
    name: account.name,
    provider: account.provider,
    courier: account.courier,
    status: account.archivedAt === null ? 'active' : 'archived',
  };
}

// Active ones first, then by name: the page's two tabs read one list
export function courierSetup(data: WorkspaceData): CourierSetup {
  const accounts = data.storefront.couriers.toSorted(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return {
    accounts: accounts.map(toCourierAccount),
    defaultAccountId: accounts.find((account) => account.isDefault)?.id ?? null,
  };
}

// What the Packed dialog and Book courier offer the packer: active accounts by name
export function courierChoicesOf(data: WorkspaceData): CourierChoices {
  const active = data.storefront.couriers
    .filter((account) => account.archivedAt === null)
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return {
    accounts: active.map(({ id, provider, name, courier }) => ({ id, provider, name, courier })),
    defaultAccountId: active.find((account) => account.isDefault)?.id ?? null,
  };
}

// An API account answers its webhook token once; a manual account has none
export function createCourier(
  data: WorkspaceData,
  input: CreateCourierAccountInput,
): { account: MockCourierAccount; saved: CourierAccountSaved } {
  const at = now();
  const token = input.provider === 'manual' ? null : newToken();
  const account: MockCourierAccount = {
    id: crypto.randomUUID(),
    provider: input.provider,
    name: input.name,
    courier: input.provider === 'manual' ? input.courier : COURIER_OF_PROVIDER[input.provider],
    keys: input.provider === 'manual' ? null : { apiKey: input.apiKey, secretKey: input.secretKey },
    hasWebhookToken: token !== null,
    isDefault: false,
    archivedAt: null,
    lastWebhookAt: null,
    lastTest: null,
    version: 1,
    updatedAt: at,
  };
  data.storefront.couriers.push(account);
  return { account, saved: { account: toCourierAccount(account), webhookToken: token } };
}

// An empty key box keeps the saved key. New keys clear the last test: it was about the old ones
export function updateCourier(
  data: WorkspaceData,
  id: string,
  input: UpdateCourierAccountInput,
): { before: MockCourierAccount; after: MockCourierAccount; keysChanged: boolean } {
  const account = lockAccount(data, id, input.version);
  if (account.archivedAt !== null) throw archived();
  if (input.provider !== account.provider) throw new MockProblem(409, 'courier_provider_fixed');
  const before = { ...account };
  let keysChanged = false;
  if (input.provider !== 'manual') {
    const apiKey = input.apiKey !== '' ? input.apiKey : (account.keys?.apiKey ?? '');
    const secretKey = input.secretKey !== '' ? input.secretKey : (account.keys?.secretKey ?? '');
    keysChanged = account.keys?.apiKey !== apiKey || account.keys.secretKey !== secretKey;
    if (keysChanged) Object.assign(account, { keys: { apiKey, secretKey }, lastTest: null });
  } else {
    account.courier = input.courier;
  }
  Object.assign(account, { name: input.name, version: account.version + 1, updatedAt: now() });
  return { before, after: account, keysChanged };
}

// "Test connection": the saved keys, answered like the API's FakeCourier. No version change
export function testCourier(data: WorkspaceData, id: string): MockCourierAccount {
  const account = findAccount(data, id);
  if (account.provider === 'manual') throw notBookable('id');
  account.lastTest = { at: now(), problem: fakeProblem(account.keys) };
  return account;
}

// A new token replaces the old one at once
export function renewCourierToken(
  data: WorkspaceData,
  id: string,
  version: number,
): CourierAccountSaved {
  const account = lockAccount(data, id, version);
  if (account.provider === 'manual') throw notBookable('id');
  if (account.archivedAt !== null) throw archived();
  Object.assign(account, { hasWebhookToken: true, version: account.version + 1, updatedAt: now() });
  return { account: toCourierAccount(account), webhookToken: newToken() };
}

// Archived: not offered for new parcels, and no longer the default. changed is false when it was
// already as asked (a second tab's click): no audit row then
export function setCourierArchived(
  data: WorkspaceData,
  id: string,
  version: number,
  archive: boolean,
): { before: MockCourierAccount; after: MockCourierAccount; changed: boolean } {
  const account = lockAccount(data, id, version);
  const before = { ...account };
  if ((account.archivedAt !== null) === archive) return { before, after: account, changed: false };
  Object.assign(account, {
    archivedAt: archive ? now() : null,
    ...(archive ? { isDefault: false } : {}),
    version: account.version + 1,
    updatedAt: now(),
  });
  return { before, after: account, changed: true };
}

// The Packed dialog's first choice, or none: an active API account only. change is null when it
// was already so (no audit row then)
export function setDefaultCourier(
  data: WorkspaceData,
  accountId: string | null,
): { setup: CourierSetup; change: { from: string | null; to: string | null } | null } {
  const before = data.storefront.couriers.find((account) => account.isDefault) ?? null;
  let next: MockCourierAccount | null = null;
  if (accountId !== null) {
    next = findAccount(data, accountId);
    if (next.provider === 'manual' || next.archivedAt !== null) throw notBookable('accountId');
  }
  if (before?.id === next?.id) return { setup: courierSetup(data), change: null };
  for (const account of data.storefront.couriers) account.isDefault = account.id === next?.id;
  return {
    setup: courierSetup(data),
    change: { from: before?.name ?? null, to: next?.name ?? null },
  };
}
```

The account rules, one function per route, each the API service's rule in a few lines:

- `toCourierAccount` builds the webhook address from the contract's own path (`routes.shipping.steadfastWebhook`),
  so it is the address the API would answer, on the mock's API base. A manual account has none.
- `courierSetup` sorts active accounts first, then by name, then by id, as the API's query does; the page's two tabs
  filter one list. `courierChoicesOf` is the packer's read: active accounts only, and only four fields.
- `createCourier` makes a token only for an API account. The answer carries it once; the account keeps only
  `hasWebhookToken`.
- `updateCourier` keeps a saved key when its box is empty, and clears the last test only when a key really changed:
  the same keys typed again are no change, as in the API. The provider can never change (`courier_provider_fixed`).
- `testCourier` writes the fake courier's answer and does not change the version: a test changes no value the form
  holds, so an open form is not made stale by a test.
- `setCourierArchived` returns `changed: false` when the account already was as asked (a second tab's click), and
  the handler then writes no audit row. Archiving clears the default in the same step, as the API's one UPDATE does.
- `setDefaultCourier` refuses a manual or archived account with the field error on `accountId`, and reports a change
  only when the default really moved, for the same audit reason.

```ts
// ---------------------------------------------------------------------------------------------
// Parcels

// What the rider collects: the total less what the order's paid tries took, never below zero
export function codAmountOf(order: MockShopOrder): string {
  const paid = order.payments
    .filter((payment) => payment.status === 'paid')
    .map((payment) => payment.amount);
  const left = subtractMoney(order.total, sumMoney(paid));
  return compareMoney(left, '0') > 0 ? left : '0.0000';
}

// The list's "Needs attention": a packed order whose last parcel failed to book
export function parcelNeedsAttention(order: MockShopOrder): boolean {
  return order.status === 'packed' && order.shipments.at(-1)?.status === 'booking_failed';
}

export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): StorefrontShipment[] {
  return order.shipments.map((parcel) => {
    const account = findAccount(data, parcel.accountId);
    return {
      id: parcel.id,
      account: { id: account.id, name: account.name, provider: account.provider },
      courier: parcel.courier,
      status: parcel.status,
      consignmentId: parcel.consignmentId,
      trackingCode: parcel.trackingCode,
      codAmount: parcel.codAmount,
      bookedAt: parcel.bookedAt,
      attempts: parcel.attempts,
      error: parcel.error,
      errorDetail: parcel.errorDetail,
      events: parcel.events.slice(-100),
      lastSyncedAt: parcel.lastSyncedAt,
    };
  });
}

function step(parcel: MockShipment, status: ShopShipmentStatus, at: string, note: string | null) {
  parcel.events.push({ status, at, note });
}

// A failed booking rings the bell (the API's onGiveUp). The mock has one member to tell
function ringFailed(data: WorkspaceData, order: MockShopOrder, account: MockCourierAccount): void {
  data.notifications.unshift({
    id: crypto.randomUUID(),
    type: 'storefront.shipment_failed',
    params: { id: order.id, number: order.orderNo, courier: account.name },
    readAt: null,
    createdAt: now(),
  });
}

// The pretend worker (the API's ShipmentBookingHandler with its FakeCourier): every parcel whose
// booking time is up gets the courier's answer. Keys the courier refuses and a phone it refuses
// fail at once (one try, as the API's PermanentJobError); a courier that does not answer fails
// after the API's five tries, which the mock counts at once
export function settleBookings(data: WorkspaceData, at: string = now()): void {
  for (const order of data.storefront.orders) {
    for (const parcel of order.shipments) {
      if (parcel.status !== 'booking' || parcel.bookUntil === null || parcel.bookUntil > at) {
        continue;
      }
      const account = findAccount(data, parcel.accountId);
      const problem = fakeProblem(account.keys);
      const failed: { error: ErrorCode; detail: string | null; tries: number } | null =
        problem === 'rejected'
          ? { error: 'courier_rejected_keys', detail: null, tries: 1 }
          : problem === 'unreachable'
            ? { error: 'courier_unreachable', detail: null, tries: 5 }
            : order.phone === FAKE_REFUSED_PHONE
              ? {
                  error: 'courier_rejected_parcel',
                  detail: 'The recipient phone must be a working mobile number.',
                  tries: 1,
                }
              : null;
      parcel.bookUntil = null;
      if (failed !== null) {
        Object.assign(parcel, {
          status: 'booking_failed',
          attempts: parcel.attempts + failed.tries,
          error: failed.error,
          errorDetail: failed.detail,
        });
        ringFailed(data, order, account);
        continue;
      }
      // Booked: the last error goes, and the booking is the parcel's first step
      Object.assign(parcel, {
        ...fakeBooking(parcel.invoice),
        status: 'booked',
        bookedAt: at,
        attempts: parcel.attempts + 1,
        error: null,
        errorDetail: null,
      });
      step(parcel, 'booked', at, null);
    }
  }
}

// Packed books with an active API account only: a manual parcel needs the courier's code
export function bookableAtPack(data: WorkspaceData, accountId: string): void {
  const account = data.storefront.couriers.find((item) => item.id === accountId);
  if (account === undefined || account.provider === 'manual' || account.archivedAt !== null) {
    throw new MockProblem(422, 'courier_account_not_bookable', {
      courierAccountId: ['courier_account_not_bookable'],
    });
  }
}

// Packed with a courier, or Book courier later. An API account's parcel books in the pretend
// worker; a manual account's parcel is booked at once with the code the member typed. The order's
// version does not change, as in the API (the parcel is its own row)
export function startShipment(
  data: WorkspaceData,
  order: MockShopOrder,
  input: { accountId: string; trackingCode: string },
  at: string = now(),
): MockCourierAccount {
  if (order.status !== 'packed') throw orderNotBookable();
  const account = findAccount(data, input.accountId);
  if (account.archivedAt !== null) throw archived('accountId');
  const manual = account.provider === 'manual';
  if (manual && input.trackingCode === '') {
    throw new MockProblem(422, 'courier_tracking_code_required', {
      trackingCode: ['courier_tracking_code_required'],
    });
  }
  if (order.shipments.some((parcel) => isOpenShipment(parcel.status))) throw hasParcel();
  if (order.shipments.length >= 5) throw orderNotBookable();
  const parcelNo = order.shipments.length + 1;
  const parcel: MockShipment = {
    id: crypto.randomUUID(),
    accountId: account.id,
    parcelNo,
    invoice: parcelNo === 1 ? order.orderNo : `${order.orderNo}-${String(parcelNo)}`,
    courier: account.courier,
    status: manual ? 'booked' : 'booking',
    consignmentId: null,
    trackingCode: manual ? input.trackingCode : null,
    codAmount: codAmountOf(order),
    bookedAt: manual ? at : null,
    attempts: 0,
    error: null,
    errorDetail: null,
    events: [],
    lastSyncedAt: null,
    bookUntil: manual ? null : later(at, MOCK_BOOK_MS),
  };
  if (manual) step(parcel, 'booked', at, null);
  order.shipments.push(parcel);
  return account;
}

// Book again: the same row, so the courier is asked with the same invoice. The last error stays
// while it books again
export function retryShipment(
  data: WorkspaceData,
  order: MockShopOrder,
  shipmentId: string,
  at: string = now(),
): { account: MockCourierAccount; parcel: MockShipment } {
  if (order.status !== 'packed') throw orderNotBookable();
  const parcel = order.shipments.find((item) => item.id === shipmentId);
  if (parcel === undefined) throw notFound();
  if (parcel.status !== 'booking_failed') {
    throw new MockProblem(409, 'storefront_shipment_not_failed');
  }
  if (
    order.shipments.some((item) => item.parcelNo > parcel.parcelNo || isOpenShipment(item.status))
  ) {
    throw hasParcel();
  }
  const account = findAccount(data, parcel.accountId);
  if (account.archivedAt !== null) throw archived();
  Object.assign(parcel, { status: 'booking', bookUntil: later(at, MOCK_BOOK_MS) });
  return { account, parcel };
}

// Cancel: a parcel only booked is cancelled with the order; one still booking, or one the courier
// has, refuses the cancel. A failed one stays as it was
export function cancelShipments(order: MockShopOrder, at: string = now()): void {
  const open = order.shipments.find((parcel) => isOpenShipment(parcel.status));
  if (open === undefined) return;
  if (open.status === 'booking') throw new MockProblem(409, 'storefront_order_parcel_booking');
  if (open.status !== 'booked') throw new MockProblem(409, 'storefront_order_parcel_on_its_way');
  open.status = 'cancelled';
  step(open, 'cancelled', at, null);
}

// Mark shipped and Mark delivered move a parcel booked by hand with them. An API parcel moves
// with its courier's news only
export function followOrder(
  data: WorkspaceData,
  order: MockShopOrder,
  status: 'picked_up' | 'delivered',
  at: string = now(),
): void {
  const open = order.shipments.find(
    (parcel) =>
      isOpenShipment(parcel.status) && findAccount(data, parcel.accountId).provider === 'manual',
  );
  if (open === undefined) return;
  open.status = status;
  step(open, status, at, null);
}

function packedAt(order: MockShopOrder): string {
  return order.history.find((entry) => entry.status === 'packed')?.at ?? order.updatedAt;
}

// The export for a courier's bulk upload: the packed orders with no parcel on its way, oldest
// packed first. The invoice is the one the order's next parcel gets
export function courierExportOf(data: WorkspaceData): CourierExport {
  const waiting = data.storefront.orders
    .filter(
      (order) =>
        order.status === 'packed' &&
        !order.shipments.some((parcel) => isOpenShipment(parcel.status)),
    )
    .toSorted((a, b) => packedAt(a).localeCompare(packedAt(b)) || a.id.localeCompare(b.id));
  const page = waiting.slice(0, COURIER_EXPORT_MAX_ROWS);
  return {
    rows: page.flatMap((order) => {
      const parcels = order.shipments.length;
      if (parcels >= 5) return [];
      return [
        {
          orderId: order.id,
          invoice: parcels === 0 ? order.orderNo : `${order.orderNo}-${String(parcels + 1)}`,
          name: order.customerName,
          address: order.address.replace(/\s+/g, ' ').trim(),
          phone: order.phone,
          amount: codAmountOf(order),
          itemCount: Math.max(
            order.lines.reduce((count, line) => count + line.quantity, 0),
            1,
          ),
        },
      ];
    }),
    more: waiting.length > COURIER_EXPORT_MAX_ROWS,
  };
}
```

The parcel rules:

- `codAmountOf` is the API's: the total less what the order's paid tries took, never below zero. W-000004 of the
  seed was paid with Nagad, so its rider collects nothing, and the Book courier dialog says so.
- `parcelNeedsAttention` looks at the order's last parcel only. A failed parcel followed by one booked by hand is
  history, not a problem.
- `settleBookings` is the pretend worker (mines 54 and 56). Refused keys and a refused phone fail after one try, as
  the API's permanent failures do; no answer fails after "five". A failure rings the bell (mine 59). A booking that
  works writes the courier's id and code, clears the last error, and adds the parcel's first step, "Booked", at the
  time the worker answered.
- `startShipment` checks in the API's order: the order is packed, the account exists and is active, a manual account
  has a tracking code, no parcel is on its way, fewer than five parcels. The invoice is the order number, then
  `W-000123-2` for a second parcel (decision 3 and mine 25). The order's version does not change, because in the API
  the parcel is its own row: a page that holds the order can still move it.
- `retryShipment` books the same parcel again, so the courier is asked with the same invoice. Only the last parcel,
  only after it failed, only while nothing else is on its way, and only with an active account. The last error stays
  while it books again, so the page can still say what went wrong last time.
- `cancelShipments` cancels a parcel that is only booked, and refuses while it is booking or once the courier has
  it, with the API's two codes.
- `followOrder` moves only a parcel booked by hand: Mark shipped and Mark delivered move it with the order. An API
  parcel moves with its courier's news only.
- `courierExportOf` lists the packed orders with no parcel on its way, oldest packed first, with the invoice the
  next parcel will get, so the code typed back into Book courier matches what the courier's panel was given. The
  address is put on one line: some courier panels read a CSV cell with line breaks wrong.

```ts
// ---------------------------------------------------------------------------------------------
// The seed

// Rahman Fashion's couriers: Steadfast from its Dhaka pickup point (the default, its news
// arriving), a second Steadfast account for the Chattogram depot whose webhook was never pasted
// (and whose keys the fake courier does not answer, so booking with it fails and Test connection
// says so), Pathao booked by hand at the counter, and an archived RedX account
export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccount[] {
  const account = (
    fields: Pick<MockCourierAccount, 'provider' | 'name' | 'courier' | 'keys'> &
      Partial<MockCourierAccount>,
  ): MockCourierAccount => {
    const item: MockCourierAccount = {
      id: crypto.randomUUID(),
      hasWebhookToken: fields.provider !== 'manual',
      isDefault: false,
      archivedAt: null,
      lastWebhookAt: null,
      lastTest: null,
      version: 1,
      updatedAt: at,
      ...fields,
    };
    data.storefront.couriers.push(item);
    return item;
  };
  return [
    account({
      provider: 'steadfast',
      name: 'Steadfast Dhaka',
      courier: 'steadfast',
      keys: { apiKey: 'sf7k2qd9xw', secretKey: 'sfs81mzp0c' },
      isDefault: true,
      lastWebhookAt: later(now(), -25 * 60_000),
      lastTest: { at: later(now(), -26 * 60 * 60_000), problem: null },
    }),
    account({
      provider: 'steadfast',
      name: 'Steadfast Chattogram',
      courier: 'steadfast',
      keys: { apiKey: 'fake_unreachable', secretKey: 'sfs40ctg7q' },
    }),
    account({ provider: 'manual', name: 'Pathao counter', courier: 'pathao', keys: null }),
    account({
      provider: 'manual',
      name: 'RedX',
      courier: 'redx',
      keys: null,
      archivedAt: later(at, 2 * 24 * 60 * 60_000),
      version: 2,
    }),
  ];
}

// A seeded parcel booked with an API account, with the courier's own id and code and the steps it
// sent since (the seed's story is the real Steadfast, not the fake courier)
export function seedParcel(
  order: MockShopOrder,
  account: MockCourierAccount,
  codes: { consignmentId: string; trackingCode: string },
  bookedAt: string,
  steps: { status: ShopShipmentStatus; at: string; note: string | null }[],
): MockShipment {
  const parcel: MockShipment = {
    id: crypto.randomUUID(),
    accountId: account.id,
    parcelNo: order.shipments.length + 1,
    invoice: order.orderNo,
    courier: account.courier,
    status: steps.at(-1)?.status ?? 'booked',
    ...codes,
    codAmount: codAmountOf(order),
    bookedAt,
    attempts: 1,
    error: null,
    errorDetail: null,
    events: [{ status: 'booked', at: bookedAt, note: null }, ...steps],
    lastSyncedAt: steps.at(-1)?.at ?? bookedAt,
    bookUntil: null,
  };
  order.shipments.push(parcel);
  return parcel;
}
```

The seed (mine 57). The RedX account was archived two days after the shop opened, so its time is in the past like
the rest of the seed. The seeded parcels take real-looking Steadfast codes (`SFR2611210042`), not the fake courier's:
the seed tells the story of the real Steadfast. `seedParcel` puts the "Booked" step first and takes the parcel's
status and its last news time from the last step, so a seeded parcel can never say "In transit" with no step under
it.

### The shop orders' mock

```diff
@@ -1,5 +1,6 @@
 import {
   addMoney,
+  type BookShipmentInput,
   compareMoney,
   compareQuantity,
   type CustomerInput,
@@ -54,8 +55,22 @@ import {
   seedTry,
   toPayment,
 } from './storefront-payment-data';
+import {
+  bookableAtPack,
+  cancelShipments,
+  codAmountOf,
+  followOrder,
+  parcelNeedsAttention,
+  retryShipment,
+  seedCouriers,
+  seedParcel,
+  settleBookings,
+  shipmentsOf,
+  startShipment,
+} from './storefront-shipping-data';
 import {
   type MockCategory,
+  type MockCourierAccount,
   type MockListing,
   type MockShopOrder,
   type MockShopOrderLine,
@@ -117,7 +132,8 @@ function summaryOf(order: MockShopOrder): StorefrontOrderSummary {
     paymentMethod: order.paymentMethod,
     itemCount: itemCount(order),
     total: order.total,
-    needsAttention: order.documentError !== null,
+    // Step 28a: or its last parcel failed to book
+    needsAttention: order.documentError !== null || parcelNeedsAttention(order),
   };
 }
 
@@ -151,6 +167,8 @@ export function shopOrderPage(
   query: OrderQuery,
 ): { items: StorefrontOrderSummary[]; nextCursor: string | null } {
   const search = query.search ?? '';
+  // Step 28a: the pretend worker's bookings first, as any read sees the worker's
+  settleBookings(data);
   const found = data.storefront.orders.filter(
     (order) =>
       (query.view === 'all' || order.status === query.view) &&
@@ -167,6 +185,7 @@ export function shopOrderCounts(data: WorkspaceData): StorefrontOrderCounts {
 }
 
 export function findShopOrder(data: WorkspaceData, id: string): MockShopOrder {
+  settleBookings(data);
   const found = data.storefront.orders.find((order) => order.id === id);
   if (!found) throw new MockProblem(404, 'not_found');
   return found;
@@ -232,6 +251,9 @@ export function toShopOrder(data: WorkspaceData, order: MockShopOrder): Storefro
     documentError: order.documentError,
     // Step 27d
     payments: order.payments.map((payment) => toPayment(data, payment)),
+    // Step 28a
+    codAmount: codAmountOf(order),
+    shipments: shipmentsOf(data, order),
     version: order.version,
     updatedAt: order.updatedAt,
   };
@@ -574,9 +596,11 @@ export function packShopOrder(
   id: string,
   input: PackStorefrontOrderInput,
   at: string = now(),
-): { order: MockShopOrder; delivery: MockDelivery } {
+): { order: MockShopOrder; delivery: MockDelivery; courier: MockCourierAccount | null } {
   const order = lockShopOrder(data, id, input.version);
   if (order.status !== 'confirmed') throw stepInvalid();
+  // Step 28a: the courier first, so a wrong pick is refused before any stock moves
+  if (input.courierAccountId !== null) bookableAtPack(data, input.courierAccountId);
   const salesOrder = salesOrderOf(data, order);
 
   // Every line of the order once, and the picks of each add up to what the shopper ordered
@@ -641,7 +665,35 @@ export function packShopOrder(
     );
   }
   move(order, 'packed', at, { deliveryId: delivery.id });
-  return { order, delivery };
+  // Step 28a: the parcel with the challan; the pretend worker books it (storefront-shipping-data.ts)
+  const courier =
+    input.courierAccountId === null
+      ? null
+      : startShipment(data, order, { accountId: input.courierAccountId, trackingCode: '' }, at);
+  return { order, delivery, courier };
+}
+
+// ---------------------------------------------------------------------------------------------
+// Step 28a: Book courier and Book again (the parcel's rules are storefront-shipping-data.ts's)
+
+export function bookShopOrder(
+  data: WorkspaceData,
+  id: string,
+  input: BookShipmentInput,
+): { order: MockShopOrder; courier: MockCourierAccount } {
+  const order = lockShopOrder(data, id, input.version);
+  return { order, courier: startShipment(data, order, input) };
+}
+
+export function retryShopParcel(
+  data: WorkspaceData,
+  id: string,
+  shipmentId: string,
+  version: number,
+): { order: MockShopOrder; courier: MockCourierAccount; invoice: string } {
+  const order = lockShopOrder(data, id, version);
+  const { account, parcel } = retryShipment(data, order, shipmentId);
+  return { order, courier: account, invoice: parcel.invoice };
 }
 
 // ---------------------------------------------------------------------------------------------
@@ -656,6 +708,8 @@ export function shipShopOrder(
   const order = lockShopOrder(data, id, version);
   if (order.status !== 'packed') throw stepInvalid();
   move(order, 'shipped', at);
+  // Step 28a: a parcel booked by hand follows the button
+  followOrder(data, order, 'picked_up', at);
   return order;
 }
 
@@ -718,6 +772,7 @@ export function deliverShopOrder(
   // Never over the limit: it moves the amount from "on order" to "owed" and adds nothing
   postInvoice(data, draft, false);
   move(order, 'delivered', at, { invoiceId: draft.id });
+  followOrder(data, order, 'delivered', at);
   // Step 27d (decision 6): the invoice takes the advances of the paid tries
   applyPaymentsToInvoice(data, order, draft.id);
   return { order, invoiceId: draft.id };
@@ -740,6 +795,9 @@ export function cancelShopOrder(
 ): CancelledShopOrder {
   const order = lockShopOrder(data, id, input.version);
   if (order.status !== 'confirmed' && order.status !== 'packed') throw stepInvalid();
+  // Step 28a: a parcel only booked is cancelled with the order; one booking or with the courier
+  // refuses the cancel
+  cancelShipments(order, at);
   let salesReturnId: string | null = null;
   if (order.status === 'packed') {
     if (order.deliveryId === null) throw stepInvalid();
@@ -910,6 +968,7 @@ function placeOrder(
     salesReturnId: null,
     documentError: null,
     payments: [],
+    shipments: [],
     version: 1,
     updatedAt: confirmed,
   };
@@ -940,6 +999,7 @@ function packAsPlanned(data: WorkspaceData, order: MockShopOrder, at: string): v
               : line.picks,
         };
       }),
+      courierAccountId: null,
     },
     at,
   );
@@ -1246,6 +1306,33 @@ export function seedShopOrders(data: WorkspaceData): void {
   shipShopOrder(data, shipped.id, shipped.version, after(shipped, 240));
   packAsPlanned(data, packed, after(packed, 200));
 
+  // Step 28a: the shop's couriers, and the parcels Steadfast Dhaka carried: W-000001 to the door,
+  // W-000003 on its way to Chattogram. W-000004 waits for Book courier (or the export)
+  const [dhaka] = seedCouriers(data, minutesAgo(13 * 24 * 60));
+  if (!dhaka) return;
+  seedParcel(
+    delivered,
+    dhaka,
+    { consignmentId: '148920107', trackingCode: 'SFR2611140017' },
+    after(delivered, 92),
+    [
+      { status: 'picked_up', at: after(delivered, 180), note: 'Picked up from Rahman Fashion' },
+      { status: 'in_transit', at: after(delivered, 300), note: 'At the Dhanmondi hub' },
+      { status: 'out_for_delivery', at: after(delivered, days(1) - 150), note: null },
+      { status: 'delivered', at: after(delivered, days(1)), note: null },
+    ],
+  );
+  seedParcel(
+    shipped,
+    dhaka,
+    { consignmentId: '148920331', trackingCode: 'SFR2611210042' },
+    after(shipped, 122),
+    [
+      { status: 'picked_up', at: after(shipped, 240), note: 'Picked up from Rahman Fashion' },
+      { status: 'in_transit', at: after(shipped, 600), note: 'Reached the Chattogram hub' },
+    ],
+  );
+
   // The bell of the newest order that is not refused, unread (27a's handler rings it)
   const newest = orders[5];
   if (newest) {
```

The order mock calls the parcel rules at the same places as the API's `StorefrontOrdersService`:

- `findShopOrder` and `shopOrderPage` run `settleBookings` first. Every move finds its order through
  `findShopOrder`, so a cancel or a Book again sees the worker's answer if its time is up, as a real move would see
  the worker's committed row.
- `summaryOf` adds the failed parcel to "Needs attention", next to the sales order's error.
- `packShopOrder` checks the courier before any stock moves, and books after the challan, as the API does. It
  returns the account, so the handler can write the audit row.
- `shipShopOrder` and `deliverShopOrder` let a parcel booked by hand follow; `cancelShopOrder` cancels the parcels
  first, so a refused cancel leaves the order as it was.
- `bookShopOrder` and `retryShopParcel` check the order's version (the API's lock) and then call the parcel rules.
- The seed's own packing sends `courierAccountId: null`, and the couriers and the two parcels come after every move
  of the seed, so no seeded move books or follows a parcel by accident.

### The handlers

```diff
@@ -222,11 +222,13 @@ import {
   cancelShopOrder,
   deliverShopOrder,
   findShopOrder,
+  bookShopOrder,
   type MadeSalesOrder,
   makeShopPaymentReceipt,
   packPlanOf,
   packShopOrder,
   retrySalesOrder,
+  retryShopParcel,
   shipShopOrder,
   shopOrderCounts,
   shopOrderPage,
@@ -240,6 +242,19 @@ import {
   toGateway,
   updateGateway,
 } from './storefront-payment-data';
+import {
+  courierChoicesOf,
+  courierExportOf,
+  courierSetup,
+  courierSnapshot,
+  createCourier,
+  renewCourierToken,
+  setCourierArchived,
+  setDefaultCourier,
+  testCourier,
+  toCourierAccount,
+  updateCourier,
+} from './storefront-shipping-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -583,6 +598,23 @@ function recordSalesOrderMade(
   );
 }
 
+// Step 28a: a parcel booked at Packed or with Book courier (the API's startShipment audit row).
+// The tracking code only for a parcel booked by hand: an API parcel has none yet
+function recordShipmentBooked(
+  data: WorkspaceData,
+  order: { id: string; orderNo: string },
+  courier: string,
+  trackingCode: string | null,
+): void {
+  record(
+    data,
+    'storefront_order.shipment_booked',
+    'storefront_order',
+    order.id,
+    diff({}, { order: order.orderNo, courier, ...(trackingCode === null ? {} : { trackingCode }) }),
+  );
+}
+
 // audit-এর "আগের মান" — ফর্মের ঘরগুলো
 function editable(settings: Settings) {
   return {
@@ -6148,6 +6180,25 @@ export const handlers = [
     }),
   ),
 
+  // Step 28a: before /:id too ("courier-export" and "courier-choices" are not ids)
+  mock(
+    routes.storefrontOrders.courierExport,
+    guarded(async () => {
+      const data = shopOrderData(routes.storefrontOrders.courierExport.permission);
+      await delay();
+      return reply(routes.storefrontOrders.courierExport, courierExportOf(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.courierChoices,
+    guarded(async () => {
+      const data = shopOrderData(routes.storefrontOrders.courierChoices.permission);
+      await delay();
+      return reply(routes.storefrontOrders.courierChoices, courierChoicesOf(data));
+    }),
+  ),
+
   mock(
     routes.storefrontOrders.getOrder,
     guarded(async ({ params }) => {
@@ -6188,10 +6239,11 @@ export const handlers = [
       const data = shopOrderData(routes.storefrontOrders.packOrder.permission);
       const { id } = routes.storefrontOrders.packOrder.params.parse(params);
       const body = await readBody(routes.storefrontOrders.packOrder.body, request);
-      const { order, delivery } = transaction(data, () => packShopOrder(data, id, body));
+      const { order, delivery, courier } = transaction(data, () => packShopOrder(data, id, body));
       record(data, 'delivery.created', 'delivery', delivery.id);
       record(data, 'delivery.posted', 'delivery', delivery.id);
       recordShopMove(data, 'storefront_order.packed', order, 'confirmed');
+      if (courier !== null) recordShipmentBooked(data, order, courier.name, null);
       return reply(routes.storefrontOrders.packOrder, toShopOrder(data, order));
     }),
   ),
@@ -6256,6 +6308,182 @@ export const handlers = [
     }),
   ),
 
+  // Step 28a: Book courier and Book again (storefront-shipping-data.ts). An API account's parcel
+  // answers in `booking`; the pretend worker books it MOCK_BOOK_MS later
+  mock(
+    routes.storefrontOrders.bookShipment,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.bookShipment.permission);
+      const { id } = routes.storefrontOrders.bookShipment.params.parse(params);
+      const body = await readBody(routes.storefrontOrders.bookShipment.body, request);
+      const { order, courier } = bookShopOrder(data, id, body);
+      recordShipmentBooked(
+        data,
+        order,
+        courier.name,
+        courier.provider === 'manual' ? body.trackingCode : null,
+      );
+      return reply(routes.storefrontOrders.bookShipment, toShopOrder(data, order));
+    }),
+  ),
+
+  mock(
+    routes.storefrontOrders.retryShipment,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontOrders.retryShipment.permission);
+      const { id, shipmentId } = routes.storefrontOrders.retryShipment.params.parse(params);
+      const { version } = await readBody(routes.storefrontOrders.retryShipment.body, request);
+      const { order, courier, invoice } = retryShopParcel(data, id, shipmentId, version);
+      record(
+        data,
+        'storefront_order.shipment_retried',
+        'storefront_order',
+        order.id,
+        diff({}, { order: order.orderNo, courier: courier.name, invoice }),
+      );
+      return reply(routes.storefrontOrders.retryShipment, toShopOrder(data, order));
+    }),
+  ),
+
+  // --- Step 28a: Shop couriers (storefront-shipping-data.ts) -----------------------------------
+  // storefront.manage, like the payment gateway. The audit rows never hold a key or a token: a new
+  // one is written as "changed" (the API's snapshot)
+
+  mock(
+    routes.shipping.getCouriers,
+    guarded(async () => {
+      const data = shopData();
+      await delay();
+      return reply(routes.shipping.getCouriers, courierSetup(data));
+    }),
+  ),
+
+  mock(
+    routes.shipping.createCourier,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const body = await readBody(routes.shipping.createCourier.body, request);
+      const { account, saved } = createCourier(data, body);
+      record(
+        data,
+        'courier_account.created',
+        'courier_account',
+        account.id,
+        diff(
+          {},
+          {
+            ...courierSnapshot(account),
+            ...(account.provider === 'manual' ? {} : { keys: 'changed', webhookToken: 'changed' }),
+          },
+        ),
+      );
+      return reply(routes.shipping.createCourier, saved);
+    }),
+  ),
+
+  mock(
+    routes.shipping.updateCourier,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.shipping.updateCourier.params.parse(params);
+      const body = await readBody(routes.shipping.updateCourier.body, request);
+      const { before, after, keysChanged } = updateCourier(data, id, body);
+      record(data, 'courier_account.updated', 'courier_account', id, {
+        ...diff(courierSnapshot(before), courierSnapshot(after)),
+        ...(keysChanged ? { keys: { from: null, to: 'changed' } } : {}),
+      });
+      return reply(routes.shipping.updateCourier, toCourierAccount(after));
+    }),
+  ),
+
+  mock(
+    routes.shipping.testCourier,
+    guarded(async ({ params }) => {
+      const data = shopData();
+      const { id } = routes.shipping.testCourier.params.parse(params);
+      // A real test waits for the courier; the menu's "Testing…" shows for a moment
+      await delay();
+      const account = testCourier(data, id);
+      record(
+        data,
+        'courier_account.tested',
+        'courier_account',
+        id,
+        diff({}, { testResult: account.lastTest?.problem ?? 'ok' }),
+      );
+      return reply(routes.shipping.testCourier, toCourierAccount(account));
+    }),
+  ),
+
+  mock(
+    routes.shipping.renewCourierWebhookToken,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.shipping.renewCourierWebhookToken.params.parse(params);
+      const { version } = await readBody(routes.shipping.renewCourierWebhookToken.body, request);
+      const saved = renewCourierToken(data, id, version);
+      record(data, 'courier_account.token_renewed', 'courier_account', id, {
+        webhookToken: { from: null, to: 'changed' },
+      });
+      return reply(routes.shipping.renewCourierWebhookToken, saved);
+    }),
+  ),
+
+  mock(
+    routes.shipping.archiveCourier,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.shipping.archiveCourier.params.parse(params);
+      const { version } = await readBody(routes.shipping.archiveCourier.body, request);
+      const { before, after, changed } = setCourierArchived(data, id, version, true);
+      if (changed) {
+        record(
+          data,
+          'courier_account.archived',
+          'courier_account',
+          id,
+          diff(courierSnapshot(before), courierSnapshot(after)),
+        );
+      }
+      return reply(routes.shipping.archiveCourier, toCourierAccount(after));
+    }),
+  ),
+
+  mock(
+    routes.shipping.restoreCourier,
+    guarded(async ({ request, params }) => {
+      const data = shopData();
+      const { id } = routes.shipping.restoreCourier.params.parse(params);
+      const { version } = await readBody(routes.shipping.restoreCourier.body, request);
+      const { before, after, changed } = setCourierArchived(data, id, version, false);
+      if (changed) {
+        record(
+          data,
+          'courier_account.restored',
+          'courier_account',
+          id,
+          diff(courierSnapshot(before), courierSnapshot(after)),
+        );
+      }
+      return reply(routes.shipping.restoreCourier, toCourierAccount(after));
+    }),
+  ),
+
+  mock(
+    routes.shipping.setDefaultCourier,
+    guarded(async ({ request }) => {
+      const data = shopData();
+      const { accountId } = await readBody(routes.shipping.setDefaultCourier.body, request);
+      const { setup, change } = setDefaultCourier(data, accountId);
+      if (change !== null) {
+        record(data, 'storefront.default_courier_set', 'storefront', workspace.tenantId, {
+          defaultCourier: change,
+        });
+      }
+      return reply(routes.shipping.setDefaultCourier, setup);
+    }),
+  ),
+
   // --- Step 27d: the Online payment card (storefront-payment-data.ts) ---------------------------
   // storefront.manage, like the shop's settings. The audit rows never hold the password: a new
   // one is written as "changed" (the API's snapshot)
```

The two reads under `/storefront/orders/` (the export and the packer's choices) are declared before `getOrder`,
like the API's controller: MSW matches in order, and "courier-export" would otherwise reach `getOrder` as an id. The
account routes need `storefront.manage` (`shopData`); the order routes their own permission from the contract
(`shopOrderData`), so the packer test sees the same 403s as the API would give. Every audit row is the API's: a key
or a token is written only as "changed", and a test, a default or an archive that changed nothing writes no row.
Book courier and Book again are not inside `transaction()`: each changes one parcel and nothing else, so there is
nothing to roll back.

### The export's paisa

```diff
@@ -254,9 +254,17 @@ function csvCell(value: string, typed = false): string {
   return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
 }
 
+// Found in 28a.7: the API answers money with 4 decimals ("538.0000"), and a courier's panel wants
+// taka and paisa ("538.00"). Every shop amount is whole paisa (its prices, and a percent off rounds
+// to the paisa), so the last two digits are always 0 and cutting them loses nothing
+function paisaOf(amount: string): string {
+  const [whole = '0', fraction = ''] = amount.split('.');
+  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
+}
+
 // The whole file. note(count) is the rider's line ("3 items", in the reader's words). CRLF, as
 // RFC 4180 says, and a byte order mark first, so Excel reads a Bangla name as UTF-8, not as
-// question marks. The amount as the API wrote it (paisa, a dot): the courier's panel reads it
+// question marks. The amount with paisa and a dot (paisaOf): the courier's panel reads it
 export function courierCsv(
   rows: readonly CourierExportRow[],
   note: (count: number) => string,
@@ -269,7 +277,7 @@ export function courierCsv(
         csvCell(row.name, true),
         csvCell(row.address, true),
         csvCell(row.phone),
-        csvCell(row.amount),
+        csvCell(paisaOf(row.amount)),
         csvCell(note(row.itemCount), true),
       ].join(','),
     ),
```

Mine 58. `paisaOf` cuts the API's four decimals to two. It does not round: every amount in the shop is whole paisa
(the shop's prices are, and a percent off rounds to the paisa, `percentOfMoney`), so the last two digits are always
zero. Cutting a string also never turns the amount into a JavaScript `number`, which the money rule forbids.

```diff
@@ -238,7 +238,8 @@ describe('the courier export file', () => {
     name: 'ফারহানা আক্তার',
     address: 'House 12, Road 5, "Green" Lane\nDhanmondi',
     phone: '01786120356',
-    amount: '538.00',
+    // As the API answers it: 4 decimals, written with paisa
+    amount: '538.0000',
     itemCount: 3,
   };
   const note = (count: number) => `${String(count)} items`;
```

The test now starts from what the API really answers. With the old `538.00` input, the test passed whether the file
cut the decimals or not; that is how the bug got through 28a.6.

### The browser tests

```diff
@@ -130,6 +130,9 @@ test('packs an order by batch and serial number, then ships and delivers it', as
   await attar.getByLabel('Quantity 1').fill('3');
   const watch = dialog.getByRole('region', { name: /Steel analog wristwatch/ });
   await watch.getByLabel('Serial numbers').fill('SW-7782');
+  // Step 28a: the dialog starts with the shop's default courier. This order goes by the shop's
+  // own rider, moved by hand (storefront-couriers.e2e.ts books one)
+  await dialog.getByLabel('Send with').selectOption({ label: 'Don’t book now' });
   await dialog.getByRole('button', { name: 'Mark packed' }).click();
   await expect(
     attar.getByText('Not enough stock here. Lower the quantity or pick another batch.'),
@@ -146,7 +149,10 @@ test('packs an order by batch and serial number, then ships and delivers it', as
   await attar.getByLabel('Quantity 2').fill('1');
   await dialog.getByRole('button', { name: 'Mark packed' }).click();
   await toastShown(page, /^W-000005 packed\. Challan .+ posted\.$/);
-  await expect(page.getByText(/^Mark it shipped when the parcel leaves the shop\./)).toBeVisible();
+  // Step 28a: the shop has couriers, so the line offers one too
+  await expect(
+    page.getByText('Book a courier, or mark it shipped when the parcel leaves the shop.'),
+  ).toBeVisible();
 
   // The challan is a real one: its lines took the batches and the serial number picked
   const challan = documentRow(page, 'Challan').getByRole('link');
```

Mine 60: the old packing test keeps its story (the shop's own rider) by choosing "Don’t book now", and reads the new
next-step line.

```ts
import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  readOnlyItem,
  test,
  toastShown,
} from './helpers.js';

// Step 28a: the shop's couriers on the mock (mocks/storefront-shipping-data.ts). Rahman Fashion has
// Steadfast Dhaka (the default, its news arriving), Steadfast Chattogram (no webhook pasted yet,
// and keys the fake courier does not answer, so booking with it fails), Pathao counter (booked by
// hand) and an archived RedX. Steadfast Dhaka carried W-000001 to the door and has W-000003 on its
// way; W-000004 is packed with no parcel (paid online, so the rider collects nothing). A parcel
// booked by API waits in "Booking" for two seconds, then the pretend worker answers like the API's
// FakeCourier. Moving between pages goes through the menu: a reload starts the mock again.
test.use({ shopOrders: true });

async function openCouriers(page: Page): Promise<void> {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
}

async function openOrders(page: Page): Promise<void> {
  await openFromNav(page, 'Shop orders');
}

async function showTab(page: Page, name: string): Promise<void> {
  await page.getByRole('group', { name: 'Show' }).getByText(name, { exact: true }).click();
}

async function openOrder(page: Page, number: string): Promise<void> {
  await listItem(page, new RegExp(number)).click();
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible();
}

// The parcel card (a Card is a <section>): its title is "Parcel", or "Parcel 2" once the order was
// booked again, with the pill in the heading. The last match is the card itself, not a section
// around it
function parcelCard(page: Page) {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: /^Parcel/ }) })
    .last();
}

// An account's row (a card on a phone). Its name starts with the account's: the row's menu button
// ("Actions for Steadfast Dhaka") holds the name too
function accountRow(page: Page, name: string) {
  const start = new RegExp(`^${name}`);
  return page.getByRole('row', { name: start }).or(page.getByRole('button', { name: start }));
}

// The row's menu button. exact: on a phone the row is a card (a button) whose name holds it too
async function rowAction(page: Page, account: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Actions for ${account}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('adds a Steadfast account, shows its webhook once, picks the default and archives it', async ({
  page,
}) => {
  await openCouriers(page);
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText('Books first');
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText(/Last arrived/);
  await expect(accountRow(page, 'Steadfast Dhaka')).toContainText(/Keys accepted/);
  // No webhook pasted yet: the warn line says what to do, and that the poll stands in meanwhile
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText('None yet');
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText('Not tested');
  await expect(accountRow(page, 'Pathao counter')).toContainText('Moved by hand');
  await expect(accountRow(page, 'RedX')).toHaveCount(0);
  await expectNoSideScroll(page);

  await page.getByRole('button', { name: 'Add courier account' }).click();
  const add = page.getByRole('dialog', { name: 'Add a courier account' });
  await add.getByLabel('Name').fill('Steadfast Sylhet');
  // Both keys on the first save
  await add.getByLabel('API key').fill('sfsylhet01');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(add.getByText('Type both keys from the courier’s panel.')).toBeVisible();
  await add.getByLabel('Secret key').fill(' sfsylhet02 ');
  await add.getByRole('button', { name: 'Add account' }).click();

  // The token is in the answer once: the dialog shows it with the address to paste
  const webhook = page.getByRole('dialog', { name: 'Paste the webhook into Steadfast' });
  await expect(webhook.getByLabel('Callback URL')).toHaveValue(
    /\/public\/v1\/couriers\/steadfast\/[0-9a-f-]{36}$/,
  );
  await expect(webhook.getByLabel('Auth token (Bearer)')).toHaveValue(/^[A-Za-z0-9_-]{22}$/);
  await expect(webhook.getByText(/^Shown only this once\./)).toBeVisible();
  await webhook.getByRole('button', { name: 'Done' }).click();
  await expect(accountRow(page, 'Steadfast Sylhet')).toContainText('None yet');

  // A new token is shown once too, after a question: the old one stops at once
  await rowAction(page, 'Steadfast Sylhet', 'New webhook token');
  const renew = page.getByRole('dialog', {
    name: 'Make a new webhook token for Steadfast Sylhet?',
  });
  await renew.getByRole('button', { name: 'Make new token' }).click();
  await expect(webhook.getByLabel('Auth token (Bearer)')).toHaveValue(/^[A-Za-z0-9_-]{22}$/);
  await webhook.getByRole('button', { name: 'Done' }).click();

  // The Packed dialog's first choice
  const bookWith = page.getByLabel('Book with');
  await bookWith.selectOption({ label: 'Steadfast Sylhet · Steadfast' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await toastShown(page, 'Packed books with Steadfast Sylhet first');
  await expect(accountRow(page, 'Steadfast Sylhet')).toContainText('Books first');
  await expect(accountRow(page, 'Steadfast Dhaka')).not.toContainText('Books first');

  // Archiving the default clears it, and the dialog says so
  await rowAction(page, 'Steadfast Sylhet', 'Archive');
  const archive = page.getByRole('dialog', { name: 'Archive Steadfast Sylhet?' });
  await expect(archive.getByText(/Packed books with no courier first\./)).toBeVisible();
  await archive.getByRole('button', { name: 'Archive account' }).click();
  await toastShown(page, 'Steadfast Sylhet archived');
  await expect(bookWith.locator('option:checked')).toHaveText('Don’t book at Packed');
  await expect(accountRow(page, 'Steadfast Sylhet')).toHaveCount(0);

  await page.getByRole('group', { name: 'Show' }).getByText('Archived', { exact: true }).click();
  // An archived row opens nothing, so on a phone its card is a plain list item
  await expect(readOnlyItem(page, 'Steadfast Sylhet')).toBeVisible();
  await rowAction(page, 'RedX', 'Restore');
  await toastShown(page, 'RedX restored');
  await expect(accountRow(page, 'RedX')).toHaveCount(0);
});

test('tests the keys, keeps them write-only, and adds a courier booked by hand', async ({
  page,
}) => {
  await openCouriers(page);
  // The fake courier does not answer Chattogram's keys
  await rowAction(page, 'Steadfast Chattogram', 'Test connection');
  await toastShown(page, 'Steadfast did not answer. Try again in a few minutes.');
  await expect(accountRow(page, 'Steadfast Chattogram')).toContainText(/No answer/);

  // The keys are never shown: the boxes start empty, and an empty box keeps its key
  await rowAction(page, 'Steadfast Dhaka', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Dhaka' });
  await expect(edit.getByLabel('API key')).toHaveValue('');
  await expect(edit.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved');
  await expect(edit.getByText(/^An account’s courier can’t change\./)).toBeVisible();
  await edit.getByLabel('Name').fill('Steadfast Dhaka depot');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');
  // The same keys: the last test still stands
  await expect(accountRow(page, 'Steadfast Dhaka depot')).toContainText(/Keys accepted/);

  await page.getByRole('button', { name: 'Add courier account' }).click();
  const add = page.getByRole('dialog', { name: 'Add a courier account' });
  await add.getByText('Another courier, by hand').click();
  await expect(add.getByLabel('API key')).toHaveCount(0);
  await add.getByLabel('Name').fill('Paperfly Mirpur');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(add.getByText('Pick the courier you book these parcels with.')).toBeVisible();
  await add.getByLabel('Courier', { exact: true }).selectOption({ label: 'Paperfly' });
  await add.getByRole('button', { name: 'Add account' }).click();
  // Nothing to paste for a courier booked by hand
  await toastShown(page, 'Courier account Paperfly Mirpur added');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(accountRow(page, 'Paperfly Mirpur')).toContainText('Paperfly · booked by hand');
  // Only an API account can be the default
  await expect(
    page.getByLabel('Book with').locator('option', { hasText: 'Paperfly Mirpur' }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Book with').locator('option', { hasText: 'Steadfast Dhaka depot' }),
  ).toHaveCount(1);
  await expectNoSideScroll(page);
});

test('packs with the default courier; the booked parcel prints its label and cancels with the order', async ({
  page,
}) => {
  test.slow();
  // Count what the browser was asked to print, and keep the label's words at that moment
  await page.addInitScript(() => {
    window.print = () => {
      const sheet = document.querySelector('[data-print-sheet]');
      document.body.setAttribute('data-printed', sheet?.textContent ?? '');
    };
  });
  await page.goto('/');
  await openOrders(page);
  await openOrder(page, 'W-000005');
  await page.getByRole('button', { name: 'Mark packed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pack W-000005' });
  // The default account, with what happens after the challan
  await expect(dialog.getByLabel('Send with').locator('option:checked')).toHaveText(
    'Steadfast Dhaka',
  );
  await expect(
    dialog.getByText('Omnivo books the parcel with Steadfast Dhaka once the challan is posted.'),
  ).toBeVisible();
  await dialog
    .getByRole('region', { name: /Steel analog wristwatch/ })
    .getByLabel('Serial numbers')
    .fill('SW-7781');
  await dialog.getByRole('button', { name: 'Mark packed' }).click();
  // Not toastShown: it waits for the toast to close, and the pretend worker answers in 2 seconds
  await expect(
    page.getByText(
      /^W-000005 packed\. Challan .+ posted\. Booking the parcel with Steadfast Dhaka\.$/,
    ),
  ).toBeVisible();

  // Booking now: the page asks again every 3 seconds until the worker answered
  const parcel = parcelCard(page);
  await expect(parcel.getByText('Booking with Steadfast Dhaka…')).toBeVisible();
  await expect(page.getByText('Omnivo is booking the parcel with Steadfast Dhaka.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Book courier' })).toHaveCount(0);
  await expect(
    page.getByText(
      'The order moves to Shipped by itself when Steadfast Dhaka’s rider picks the parcel up.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(parcel.getByText(/^FAKE[0-9A-F]{10}$/)).toBeVisible();
  await expect(parcel.getByText('No news from the courier yet.')).toHaveCount(0);
  await expectNoSideScroll(page);

  // The label: the courier's code, the order, the buyer, and what the rider collects
  await parcel.getByRole('button', { name: 'Print label' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-printed', /Steadfast · FAKE/);
  const printed = (await page.locator('body').getAttribute('data-printed')) ?? '';
  expect(printed).toContain('W-000005');
  expect(printed).toContain('Farhana Islam');
  expect(printed).toMatch(/Collect ৳[\d,]+\.\d{2}/);

  // Cancel says the courier's panel must cancel it too; the parcel is cancelled with the order
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const cancel = page.getByRole('dialog', { name: 'Cancel W-000005?' });
  await expect(
    cancel.getByText(/^Its parcel booked with Steadfast Dhaka is cancelled here too\./),
  ).toBeVisible();
  await cancel.getByRole('button', { name: 'Cancel order' }).click();
  await toastShown(page, 'W-000005 cancelled. The shopper gets an SMS.');
  await expect(parcel.getByText('Cancelled').first()).toBeVisible();
});

test('a booking that fails rings the bell; Book again books it once the keys are fixed', async ({
  page,
}) => {
  test.slow();
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await expect(
    page.getByText('Book a courier, or mark it shipped when the parcel leaves the shop.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  // Paid online (Nagad): the rider collects nothing
  await expect(book.getByText(/The order is paid, so the rider collects nothing\.$/)).toBeVisible();
  await book
    .getByLabel('Courier account')
    .selectOption({ label: 'Steadfast Chattogram · Steadfast' });
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'Booking W-000004’s parcel with Steadfast Chattogram');

  // Five tries got no answer: the crit notice, the Needs attention pill and the bell
  await expect(
    page.getByText(
      'Steadfast Chattogram did not book the parcel. The courier did not answer. Book again in a few minutes.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Needs attention')).toBeVisible();
  await expect(parcelCard(page).getByText('Nothing: paid online')).toBeVisible();
  await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
  await expect(
    page.getByText(
      'Steadfast Chattogram did not book the parcel of W-000004. Open the order to book it again.',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Fix the keys on Shop couriers (a new key clears the last test), then come back
  await openFromNav(page, 'Shop couriers');
  await rowAction(page, 'Steadfast Chattogram', 'Edit');
  const edit = page.getByRole('dialog', { name: 'Edit Steadfast Chattogram' });
  await edit.getByLabel('API key').fill('sfctg2611ok');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toastShown(page, 'Courier account saved');

  await openOrders(page);
  await showTab(page, 'Packed');
  await expect(listItem(page, /W-000004/)).toContainText('Needs attention');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book again' }).click();
  await toastShown(page, 'Booking W-000004’s parcel again');
  await expect(
    page.getByText(
      'The order moves to Shipped by itself when Steadfast Chattogram’s rider picks the parcel up.',
    ),
  ).toBeVisible({ timeout: 10_000 });
  // The same parcel, booked: no second card, and no attention any more
  await expect(page.getByRole('heading', { level: 3, name: /^Parcel 2/ })).toHaveCount(0);
  await expect(page.getByText('Needs attention')).toHaveCount(0);
  await expect(parcelCard(page).getByText(/^FAKE[0-9A-F]{10}$/)).toBeVisible();
});

test('exports the packed orders, then books one by hand and moves it with the buttons', async ({
  page,
}) => {
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Packed');

  // The file for the courier's bulk upload: W-000004 waits, and the rider collects nothing
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for courier' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^courier-orders-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await file.path(), 'utf8');
  expect(csv).toMatch(/^\uFEFFInvoice,Name,Address,Phone,Amount,Note\r?\n/);
  expect(csv).toContain(
    'W-000004,Mitu Akter,"House 12, Sector 7, Uttara, Dhaka 1230",01552334455,0.00',
  );
  await toastShown(page, '1 packed order in the file');

  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  await book.getByLabel('Courier account').selectOption({ label: 'Pathao counter · Pathao' });
  await book.getByRole('button', { name: 'Book courier' }).click();
  await expect(
    book.getByText('Type the tracking code the courier gave for this parcel.'),
  ).toBeVisible();
  // Typed as it comes; kept in capitals, as the courier shows it
  await book.getByLabel('Tracking code').fill('ptp-2611-77');
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'W-000004 booked with Pathao counter, code PTP-2611-77');

  const parcel = parcelCard(page);
  await expect(parcel.getByText('Booked by hand. Move the order with its buttons.')).toBeVisible();
  await expect(
    page.getByText('Mark it shipped when Pathao counter picks the parcel up.'),
  ).toBeVisible();
  // A parcel on its way: no second booking
  await expect(page.getByRole('button', { name: 'Book courier' })).toHaveCount(0);

  // The order's button moves the parcel too
  await page.getByRole('button', { name: 'Mark shipped' }).click();
  await toastShown(page, 'W-000004 shipped');
  await expect(parcel.getByText('Picked up').first()).toBeVisible();

  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  await showTab(page, 'Packed');
  await page.getByRole('button', { name: 'Export for courier' }).click();
  await toastShown(page, 'No packed order waits for a courier.');
});

test('shows the courier’s news on a shipped order', async ({ page }) => {
  await page.goto('/');
  await openOrders(page);
  await showTab(page, 'Shipped');
  await openOrder(page, 'W-000003');
  await expect(
    page.getByText(
      'The order moves to Delivered by itself when Steadfast Dhaka delivers it. That posts the invoice.',
    ),
  ).toBeVisible();
  const parcel = parcelCard(page);
  await expect(parcel.getByText('SFR2611210042')).toBeVisible();
  await expect(parcel.getByText('Reached the Chattogram hub')).toBeVisible();
  // Newest first
  await expect(parcel.getByRole('listitem').first()).toContainText('In transit');
  await expectNoSideScroll(page);
});

test('a packer books with the active accounts without the Shop couriers page', async ({ page }) => {
  await actAs(page, {
    name: 'Packer',
    permissions: ['storefront.order.read', 'storefront.order.manage'],
  });
  await page.goto('/');
  await expect(
    page.getByRole('navigation').getByRole('link', { name: 'Shop couriers' }),
  ).toHaveCount(0);
  await openOrders(page);
  await showTab(page, 'Packed');
  await openOrder(page, 'W-000004');
  await page.getByRole('button', { name: 'Book courier' }).click();
  const book = page.getByRole('dialog', { name: 'Book a courier for W-000004' });
  // Active accounts only: the archived RedX is not offered
  await expect(book.getByLabel('Courier account').locator('option')).toHaveText([
    'Pick an account',
    'Pathao counter · Pathao',
    'Steadfast Chattogram · Steadfast',
    'Steadfast Dhaka · Steadfast',
  ]);
  await book.getByLabel('Courier account').selectOption({ label: 'Steadfast Dhaka · Steadfast' });
  await expect(
    book.getByText(
      'Omnivo books the parcel with Steadfast now, and the courier’s news move the order.',
    ),
  ).toBeVisible();
  await book.getByRole('button', { name: 'Book courier' }).click();
  await toastShown(page, 'Booking W-000004’s parcel with Steadfast Dhaka');
});
```

Seven tests, each run on a desktop and on a 390px phone:

- **The page:** the seeded rows, adding a Steadfast account (both keys needed, the webhook address and a 22-character
  token shown once), a new token after its question, the default and its pill, archiving the default (the dialog
  says Packed books with no courier first, and the select follows), the Archived tab and Restore.
- **Keys and a manual account:** Test connection with keys the fake courier does not answer, an edit whose key
  boxes start empty with "Saved" and keep the keys (the last test still stands), and a manual account with no
  webhook dialog that the default select never offers.
- **Booking at Packed:** the dialog starts with the default, the toast says the parcel is booking, the card says
  "Booking with Steadfast Dhaka…", then the worker's code, the label (its courier line, the order, the buyer and
  "Collect ৳…" with paisa), and a cancel that warns about the courier's panel and cancels the parcel.
- **A failed booking:** the crit notice with the error's words, the Needs attention pill, "Nothing: paid online",
  the bell's line, then new keys on Shop couriers and Book again on the same parcel (no "Parcel 2").
- **The export and booking by hand:** the CSV (byte order mark, the courier's columns, the address quoted, `0.00`),
  a missing tracking code refused under its box, a code typed in small letters kept in capitals, the manual line,
  Mark shipped moving the parcel to Picked up, and the export's empty toast once nothing waits.
- **A shipped order's news:** the seeded code and the courier's note, newest first.
- **The packer:** no Shop couriers in the menu, and Book courier offers the active accounts (not the archived RedX).

A few things the tests do on purpose:

- **`accountRow` matches the start of the name.** The row's menu button is called "Actions for Steadfast Dhaka", so a
  plain "contains" match finds the row and its button, and Playwright refuses two matches.
- **The archived row is a `readOnlyItem`.** An archived account opens nothing on a click, so on a phone its card is
  a plain list item, not a button.
- **The booking test does not wait for its toast to close.** `toastShown` waits about 3 seconds, and the pretend
  worker answers after 2, so "Booking with Steadfast Dhaka…" would be gone before the test looked.
- **`window.print` is replaced before the page loads.** The label is drawn only while the browser prints and removed
  right after, so the replacement copies the label's words at that moment into an attribute the test reads.
- **Pages change through the menu, never `page.goto`,** after the start: a reload starts the mock again and would
  forget the new keys and the failed parcel.

The screens were compared with the mockup's pictures (`couriers`, `order-shipped`, `order-failed`, the Packed and
Book courier dialogs). They match. One small difference comes from the screen width, not the code: at 1280px the
"Books first" pill wraps under the account's name, and the mockup's 1440px frame has room for it beside the name.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/app typecheck
cd apps/app && npx tsc --noEmit -p e2e
cd apps/app && npx vitest run                              # 242 tests
cd apps/app && pnpm exec playwright test --config e2e/playwright.config.ts storefront notifications.e2e.ts --workers=2
                                                           # 70 tests (14 new)
pnpm --filter @omnivo/shop typecheck
cd apps/shop && npx vitest run                             # 274 tests
pnpm exec eslint <the files of this part>
pnpm exec prettier --check <the files of this part>
```

All pass. The app's type check is clean again for the first time since 28a.1.

Broken on purpose, to see that the checks notice:

- `courierCsv` writing the amount as it came, without `paisaOf`: the export unit test fails (`538.0000`).
- `followOrder` in the mock moving nothing: the booking-by-hand browser test fails at "Picked up".

## 28a.8 — Run it and check it

Every check ran once on the whole repo, then the whole way ran on the real API with the fake courier. The run found
no bug. Three things change: the generated API description, a comment for the staging server, and what the guide
says about Steadfast, which could now be checked against Steadfast's own words.

Decisions made in this part:

61. **Steadfast was checked against its own GitHub package, not its panel.** Steadfast's documentation site could
    not be read in 28a.1. Its own package (`steadfast-it/SteadFast-Laravel-Package`, README of 10 Nov 2026, "Align
    the package with the current official SteadFast API documentation") could be read now. Everything the adapter
    sends and reads matches it: `https://portal.packzy.com/api/v1`, `create_order` with `invoice`,
    `recipient_name`, `recipient_phone`, `recipient_address`, `cod_amount` and `note`, its answer
    (`consignment.consignment_id` as a number, `tracking_code`, `status: in_review`), the three status reads
    (`status_by_cid`, `status_by_invoice`, `status_by_trackingcode`, each `{ status: 200, delivery_status }`), the
    eleven status words, and the webhook (a Bearer token the shop chooses, a body with `consignment_id`, `invoice`,
    `status`, `cod_amount` and `updated_at`, the answer `{ status: 'success' }`, the same notice possibly sent more
    than once). It also says "the API has no idempotency key", which is why the worker asks by the invoice after a
    timeout (decision 3). No code changes.
62. **Four things are still from memory:** the key headers' names (`Api-Key`, `Secret-Key`), the
    `notification_type: tracking_update` notice, the tracking page's address (`steadfast.com.bd/t/<code>`) and the
    bulk upload's columns. Each lives in one place (`steadfast-adapter.ts`, `courier-csv.ts`), so a difference found
    with the first real parcel is a small change there.
63. **`pending` stays "in transit", and the first real parcel decides.** The package says `pending` means "not yet
    delivered or cancelled": the parcel is with Steadfast. 28a reads it as picked up (decision 39), which ships the
    order and sends the shopper the "on its way" SMS. If Steadfast sends `pending` before its rider has the box (for
    example when the shop's booking is approved), the order moves to Shipped too early. Only a real parcel shows
    which one it is, so "Try it" has a line for it. If it is early, the fix is one line in `STEADFAST_WORDS`
    (`pending → booked`) and the pickup then comes from the first `tracking_update`.

Steadfast's package also has calls 28a does not use: the whole history of a parcel
(`/trackings_by_invoice/{invoice}`), a bulk booking of up to 500 orders, return requests, and the list of
Steadfast's payments. The last one is what 28b needs for the courier's COD payouts.

### The API description

`packages/contracts/openapi.json` is generated again, now that the shop builds (the same command as 27d):

```bash
node packages/contracts/scripts/gen-openapi.ts
pnpm test:openapi
```

It adds 11 paths: the couriers (list, add, change, archive, restore, test, new webhook token), the order's parcels
and their retry, the Packed dialog's courier choices, the export, and the public webhook
`/public/v1/couriers/steadfast/{id}`. It also adds the `shipping` tag and `courier_account` to the audit log's
kinds. The file is not shown here: it is long, and nobody writes it by hand.

### Staging

```diff
@@ -220,6 +220,8 @@ services:
   # and the API's SHOP_BASE_DOMAIN and STOREFRONT_SHOP_KEY (the same value as SHOP_API_KEY; step
   # 27a). Paying online (step 27d) also needs CREDENTIALS_KEY on api and worker: production uses
   # SSLCommerz (PAYMENT_GATEWAY), and without the key the Online payment card cannot save a store.
+  # Shop couriers (step 28a) need the same key for a courier's API keys. Production books with the
+  # real courier (COURIER_MODE is live), so a staging shop books real parcels once one is set.
   # It needs nothing else in the stack. `web` does not wait for it either:
   # if the shop fails, the ERP app keeps working and only the shop's address answers 502.
   shop:
```

Only a comment. The staging server runs in production mode, so `COURIER_MODE` is `live` there: a courier account
saved on staging books real Steadfast parcels. Without `CREDENTIALS_KEY` (27d.8) the Shop couriers page cannot save
an API key yet and answers `courier_key_missing`. The staging shop still shows the mock (26g.8).

### The run on the real API

Not part of the repo: a script started a throwaway Postgres, Valkey, MinIO and Mailpit on other ports, the built API
and worker (`COURIER_MODE=fake`), ran `pnpm seed:shop`, started the built shop with `SHOP_SOURCE=api`, and drove the
ERP's production build and the shop in one browser:

- Shop couriers: "Steadfast Dhaka" added with an API key and a secret key. The webhook dialog showed the Callback URL
  (`http://localhost:3199/public/v1/couriers/steadfast/<id>`) and the token once. "Books first" saved, the toast
  "Packed books with Steadfast Dhaka first", and "Test connection" said "Keys accepted".
- The database holds the keys as 95 sealed bytes and only the token's SHA-256 (64 hex characters): no plain key and
  no token in the row. The three audit rows (`courier_account.created`, `storefront.default_courier_set`,
  `courier_account.tested`) hold neither.
- Two Cash on Delivery orders on the shop, confirmed with the codes from Mailpit. The first one packed with "Send
  with" at Steadfast Dhaka: the worker booked it on the first try (`FAKE8604DDA66D`, COD ৳538), and the order page
  said it moves to Shipped by itself.
- The webhook: a wrong token answered 401. `pending` answered `{"status":"success","message":"Received"}`, the order
  was Shipped, and the shopper's SMS said "Omnivo: order W-000001 is on its way with Steadfast, code
  FAKE8604DDA66D." A `tracking_update` ("Reached the Mirpur hub") and `delivered` followed: the order was Delivered
  with invoice `INV-2026-27-0001` of ৳538.
- The second order packed with "Don't book now". "Export for courier" wrote one row, `W-000002,Nusrat Jahan,"House
  12, Road 5, Dhanmondi",01711284519,538.00,2 items` (the paisa fix of 28a.7). "Book courier" then booked it.
- The shop's `/track` with the first order's phone and number: "Steadfast · FAKE8604DDA66D", "Reached the Mirpur
  hub" and "Delivered to Nusrat Jahan". No page had a script error.

### Try it

Your `.env` can take the new line from `.env.example` (28a.3): `COURIER_MODE`. Left out, it is `fake` outside
production, which is what you want on your computer. The courier's keys are sealed with `CREDENTIALS_KEY` (27d).

```bash
pnpm install
pnpm db:migrate        # 0077, 0078 and 0079
pnpm dev
pnpm seed:shop         # once, if your dev database has no demo shop yet (26h.8)
```

Start a second shop on the API, as in 27a.6, and sign in to the ERP as the shop's owner (`owner@demo-shop.test`,
`Demo-shop-2026`). The phone codes and the shopper's SMS are in Mailpit (`http://localhost:8025`). With the fake
courier, a parcel moves only when you post its webhook, for example:

```bash
curl -X POST http://localhost:3000/public/v1/couriers/steadfast/<account id> \
  -H 'Authorization: Bearer <the token from the dialog>' -H 'Content-Type: application/json' \
  -d '{"notification_type":"delivery_status","consignment_id":<its id>,"invoice":"W-000001",
       "status":"pending","cod_amount":538,"updated_at":"2026-11-23 15:30:00"}'
```

The account id is in the Callback URL, and the consignment id is on the order's parcel card.

- [ ] Storefront → Shop couriers: "Add courier account", Steadfast, any keys. The webhook dialog shows the Callback URL and
      the token once; closing it and opening "New webhook token" gives a new one, and the old one answers 401.
- [ ] "Test connection" says the keys were accepted. Change the API key to `fake_rejected`: the keys are refused.
      `fake_unreachable`: the courier did not answer.
- [ ] Make it the one that books first. Order on the shop, then Packed: "Send with" starts at it. The order page
      shows "Booking the parcel…", then the tracking code and "moves to Shipped by itself".
- [ ] Post `pending`: the order is Shipped and the shopper's SMS names Steadfast and the code. Post it again: nothing
      changes. Post `delivered`: the order is Delivered with its invoice.
- [ ] Open the order's tracking link (in the SMS): the parcel, its code and the courier's news, newest first.
- [ ] Pack another order with "Don't book now". "Export for courier" downloads one row; "Book courier" books it.
- [ ] Book a parcel with an account whose key is `fake_unreachable`: after five tries the bell rings and the order
      page has "Book again".
- [ ] Archive the account: Packed no longer offers it, and its parcels on the road keep their news.

Before the first live shop, with a real Steadfast account (`COURIER_MODE=live`, or on staging once it has
`CREDENTIALS_KEY`):

- [ ] Add the keys and "Test connection". Paste the Callback URL and the token in Steadfast's panel (Webhook).
- [ ] Book one real parcel to the shop's own address. Watch when the order turns Shipped: when Steadfast approves the
      booking, or when its rider takes the box. If it is the first, change `pending` to `booked` in
      `STEADFAST_WORDS` (decision 63).
- [ ] Check the four things still from memory (decision 62): the tracking link on the order page opens the parcel,
      a hub update shows on the tracking page, and an export file uploads in Steadfast's bulk page without changes.

## What comes next

- **28a.9 (on request):** the docs: CLAUDE.md (Shop couriers, the webhook dialog, the order's parcel cards, Book
  courier, the label, Export for courier, the tracking page's parcels, `COURIER_MODE`), system-design and build-plan
  ২৮a with section ৯.
- **Before a live shop:** the Steadfast list above with a real account.
- **28b:** the courier's COD money: a COD account per courier, Steadfast's payouts (its payments list), returns and
  partial deliveries.
- **28c:** Pathao, with the address as its own city, zone and area.
- **Small:** the webhook token and the tracking code in `Geist Mono`, as the mockup draws them, once `@omnivo/ui`'s
  input can take a font; the "Books first" pill wraps under the name at 1280px.
