import { z } from 'zod';

import { errorCode, errorCodeSchema } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { priceSchema } from './money.js';
import { documentRefSchema } from './sales.js';
import { optionalIdSchema } from './stock.js';
import { SHOP_COURIERS, SHOP_SHIPMENT_STATUSES } from './storefront.js';
import { accountChoiceSchema } from './storefront-payments.js';

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
// Pathao comes in step 28d: it needs the address as its own city, zone and area ids
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

// Step 28b: the two accounts of the courier's money, the same for both providers (a courier booked
// by hand collects COD too):
// - codAccountId (decision 2): where the rider's cash waits until the courier pays it out, an
//   account that holds money ("Cash with Steadfast", under the current assets). Delivered posts a
//   money receipt into it, so its balance is what this courier owes the shop. '' = none: the cash
//   is a money receipt typed by hand, as before 28b
// - chargeAccountId (decision 3): the expense account the courier's charges go to when it pays out
//   (step 28c). '' = none yet; nothing in 28b posts to it
// Whether each is an active account of the right kind only the API knows (the chart is not in the
// form): courier_cod_account_invalid and courier_charge_account_invalid
const courierMoneyFieldsSchema = z.object({
  codAccountId: optionalIdSchema,
  chargeAccountId: optionalIdSchema,
});

// The first save needs both keys; a later one keeps a saved key when its box is empty. The form
// of a manual account has no keys at all: there is nothing to call
const steadfastCreateSchema = courierMoneyFieldsSchema.extend({
  provider: z.literal('steadfast'),
  name: accountNameSchema,
  apiKey: courierKeySchema.min(1, errorCode('courier_key_required')),
  secretKey: courierKeySchema.min(1, errorCode('courier_key_required')),
});
const manualCreateSchema = courierMoneyFieldsSchema.extend({
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
  // Step 28b: the two accounts above, as saved. A saved one may have been archived since: the
  // form then starts its select empty with the error shown, like the payment gateway's card
  codAccountId: z.uuid().nullable(),
  chargeAccountId: z.uuid().nullable(),
  // Step 28b (decision 12): what this courier holds of the shop's money now, the page's "Holds
  // ৳45,200 · 18 parcels": the parcels whose COD receipt went into the COD account and that no
  // payout has taken yet (28c). The sum of what the riders collected, with paisa
  holds: z.object({
    amount: z.string(),
    parcels: z.number().int().min(0),
  }),
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
// Step 28b: and what the two account selects offer, here for the same reason as the payment
// gateway's (storefront.manage does not read the chart of accounts): the active accounts that hold
// money, and the active expense accounts, neither a group, "1160 · Cash with Steadfast"
export const courierSetupSchema = z.object({
  accounts: z.array(courierAccountSchema),
  defaultAccountId: z.uuid().nullable(),
  codAccounts: z.array(accountChoiceSchema),
  chargeAccounts: z.array(accountChoiceSchema),
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

// Step 28b: what the rider collected, as the courier says it (Steadfast's cod_amount) or a member
// types it at Delivered: a shop amount, so whole paisa. '' = not typed: the API takes what the
// courier said, else the parcel's codAmount. Zero is real: a shopper who paid nothing at the door
// (a partial delivery of what was paid online, say). At most the parcel's codAmount, which only
// the API knows (storefront_order_collected_over)
export const collectedAmountSchema = priceSchema.refine(
  (value) => value === null || /^\d+(?:\.\d{1,2})?$/.test(value),
  errorCode('money_format'),
);

export const storefrontShipmentSchema = z.object({
  id: z.uuid(),
  account: z.object({
    id: z.uuid(),
    name: z.string(),
    provider: z.enum(COURIER_PROVIDERS),
    // Step 28b: the account has a COD account, so Delivered makes the COD receipt (decision 4).
    // The Delivered and partly delivered dialogs ask what the rider collected only then
    hasCodAccount: z.boolean(),
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
  // Step 28b (decision 5): what the rider really collected and what the courier charges for the
  // parcel, as its notice said (Steadfast's cod_amount and delivery_charge), with paisa. A partial
  // delivery collects less than codAmount. null until the courier says, or for a manual parcel
  // until Delivered (collected) and the payout (the charge, step 28c)
  collectedAmount: z.string().nullable(),
  courierCharge: z.string().nullable(),
  // Step 28b (decision 4): the COD receipt Delivered made for collectedAmount, into the account's
  // COD account. null before Delivered, with no COD account, for nothing collected, or while it
  // could not be made: then receiptError says why ("receipt_account_invalid": the COD account was
  // archived since), the order needs attention, and the page has "Make the receipt"
  receipt: documentRefSchema.nullable(),
  receiptError: errorCodeSchema.nullable(),
  // Step 28c: the posted payout that paid this parcel out to the bank (the card's "Paid out on
  // CPO-2026-27-0001"). null until one does, and again after it is voided
  payout: documentRefSchema.nullable(),
  // When the courier gave it a tracking code. null while booking
  bookedAt: z.iso.datetime().nullable(),
  // Calls made to book it, and why the last one failed (courier_rejected_parcel: the courier said
  // no, with its own words in errorDetail, like "Invalid phone number"). null when it worked
  attempts: z.number().int().min(0),
  error: errorCodeSchema.nullable(),
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

// What the Packed dialog and "Book courier" offer (found in 28a.6). Those two are for the packer
// (storefront.order.manage), who may not read the Shop couriers page (storefront.manage), so they
// get their own short read: the active accounts by name, never a webhook address or a test, and
// the default the Packed dialog starts with. Active ones only: an archived account books nothing
export const courierChoicesSchema = z.object({
  accounts: z.array(
    courierAccountSchema.pick({ id: true, provider: true, name: true, courier: true }),
  ),
  defaultAccountId: z.uuid().nullable(),
});
export type CourierChoices = z.infer<typeof courierChoicesSchema>;

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
  // Step 28b: on delivery_status, what the rider collected and Steadfast's charge for the parcel
  // (decision 5). Numbers in Steadfast's documentation ("cod_amount": 1500.00); a string too, since
  // a courier's JSON is not ours to trust. The adapter reads them as money or not at all
  cod_amount: z.union([z.number(), z.string()]).optional(),
  delivery_charge: z.union([z.number(), z.string()]).optional(),
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
