import { z } from 'zod';

import { errorCode } from './errors.js';
import { optionalText } from './fields.js';
import { defineRoute } from './http.js';
import { entryRefSchema } from './journal.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { RECEIPT_STATUSES, voidReceiptInputSchema } from './receipts.js';
import { documentRefSchema } from './sales.js';
import { COURIER_PROVIDERS, SHIPMENT_STATUSES } from './shipping.js';
import { SHOP_COURIERS } from './storefront.js';
import { accountChoiceSchema } from './storefront-payments.js';

// Step 28c: the courier's payout (system design §14.6). A courier pays the shop's COD money out
// to the bank days after the riders collected it, with its own charges taken off. A payout
// (CPO-2026-27-0001) records one such transfer: its lines are the parcels it paid, and posting it
// takes the money out of the courier account's COD account (decision 3):
//
//   Dr the bank account          what reached the bank (collected − charges)
//   Dr the charges account       the courier's charges
//   Cr the COD account           what the riders collected
//
// Like a money receipt, saving posts it, and a mistake is voided (its entry reversed on the void
// date), which frees its parcels for another payout (decision 6). A parcel is in one posted payout
// at most.
//
//   posted  in the books
//   voided  reversed, and its parcels can be paid out again
export const PAYOUT_STATUSES = RECEIPT_STATUSES;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// What a payout's line pays (decision 4):
// - cod: a parcel whose rider collected cash, with the COD receipt Delivered made into the account's
//   COD account. The line takes `collected` out of that account and the courier's charge for it
// - charge: a parcel that brought no cash but cost a charge: one that came back (returned or
//   cancelled after pickup), or one paid online. Only its charge, taken out of the cash the other
//   lines bring
export const PAYOUT_LINE_KINDS = ['cod', 'charge'] as const;
export type PayoutLineKind = (typeof PAYOUT_LINE_KINDS)[number];

// Steadfast pays out a few hundred parcels at a time at most; the courier's own payout list
// (and its CSV) is per payment
export const MAX_PAYOUT_LINES = 500;

// ---------------------------------------------------------------------------------------------
// The parcels a new payout can take

// A parcel of the account that no posted payout has taken yet (decision 4). The API sends only
// those: a cod line's receipt is posted and went into the account's COD account now (a receipt
// into an older COD account, or one voided, is not offered: its money is not in this account), a
// charge line's parcel is returned, cancelled or delivered with nothing to collect, and has a
// charge the courier said (else nothing is owed for it yet, as far as we know).
export const payoutParcelSchema = z.object({
  shipmentId: z.uuid(),
  kind: z.enum(PAYOUT_LINE_KINDS),
  order: z.object({ id: z.uuid(), number: z.string() }),
  // The courier's invoice for the parcel (W-000123, W-000123-2 for a second parcel), its
  // tracking code and its own id: the three keys a payout CSV may name a parcel by
  invoice: z.string(),
  trackingCode: z.string().nullable(),
  consignmentId: z.string().nullable(),
  status: z.enum(SHIPMENT_STATUSES),
  // What the rider collected, the COD receipt's amount ('0' for a charge line), with paisa. Fixed:
  // the receipt is posted, so the payout takes exactly this out of the COD account (decision 5)
  collected: z.string(),
  // The courier's charge as its notice said it (Steadfast's delivery_charge). null when the courier
  // has not said: the form's charge box starts empty, and the member types it
  courierCharge: z.string().nullable(),
  // The COD receipt and its date: a payout is never dated before the receipts it pays out
  // (decision 7). null for a charge line
  receipt: documentRefSchema.nullable(),
  receiptDate: z.iso.date().nullable(),
  // When the courier last said anything about it: the list's "Delivered 21 Nov" line
  lastSyncedAt: z.iso.datetime().nullable(),
});
export type PayoutParcel = z.infer<typeof payoutParcelSchema>;

// ---------------------------------------------------------------------------------------------
// The courier's payout CSV (decisions 10–12)

// What a row's key column holds: the parcel's courier invoice (our order number), its tracking
// code or the courier's own id
export const PAYOUT_CSV_KEYS = ['invoice', 'tracking_code', 'consignment_id'] as const;
export type PayoutCsvKey = (typeof PAYOUT_CSV_KEYS)[number];

const columnNameSchema = z
  .string()
  .trim()
  .min(1, errorCode('payout_csv_column_required'))
  .max(100, errorCode('too_long'));

// Which column of the file holds what, by its header's name. The key column is required: a row
// is matched to a parcel by it. The two amount columns may be left out ('' = none): without the
// collected column a row cannot be "different", and without the charge column the charges stay
// what the courier's notices said. Saved on the courier account once a file matched with it
// (decision 11), so the next file of the same courier needs no mapping
export const payoutCsvMapSchema = z.object({
  key: z.enum(PAYOUT_CSV_KEYS),
  keyColumn: columnNameSchema,
  collectedColumn: z
    .string()
    .trim()
    .max(100, errorCode('too_long'))
    .transform((value) => (value === '' ? null : value))
    .nullable(),
  chargeColumn: z
    .string()
    .trim()
    .max(100, errorCode('too_long'))
    .transform((value) => (value === '' ? null : value))
    .nullable(),
});
export type PayoutCsvMap = z.infer<typeof payoutCsvMapSchema>;
export type PayoutCsvMapFormValues = z.input<typeof payoutCsvMapSchema>;

// A guess at Steadfast's payout file (decision 11): no real file was seen when this was written, so
// these are the names its merchant panel uses on screen. The dialog shows the mapping step whenever
// a name is missing from the file, so a wrong guess costs one mapping, once.
export const STEADFAST_PAYOUT_CSV_PRESET = {
  key: 'invoice',
  keyColumn: 'Invoice',
  collectedColumn: 'COD Amount',
  chargeColumn: 'Delivery Charge',
} as const satisfies PayoutCsvMap;

// The file as the browser read it, as text (decision 10): small enough for one request, so no
// upload and no worker job. 1,000,000 characters is about 10,000 rows of a courier's export; the
// API also refuses more than MAX_PAYOUT_CSV_ROWS rows (payout_csv_too_many_rows)
export const MAX_PAYOUT_CSV_CHARS = 1_000_000;
export const MAX_PAYOUT_CSV_ROWS = 5000;

// `map` null: the account's saved map, else the provider's preset (Steadfast's above; a manual
// account has none, so its first file always shows the mapping step)
export const payoutMatchInputSchema = z.object({
  csv: z
    .string()
    .min(1, errorCode('payout_csv_unreadable'))
    .max(MAX_PAYOUT_CSV_CHARS, errorCode('payout_csv_too_big')),
  map: payoutCsvMapSchema.nullable(),
});
export type PayoutMatchInput = z.infer<typeof payoutMatchInputSchema>;

// What each row of the file turned out to be (decision 12):
// - matched: a parcel this payout can take, and the file's collected amount (if mapped) is ours
// - different: a parcel this payout can take, but the file's collected amount is not what our COD
//   receipt says. Both are shown; the member decides (the receipt cannot change, so a difference
//   the courier keeps goes into the line's charge)
// - already_paid: the parcel is in a posted payout (`payout` names it)
// - not_ready: the parcel is ours but not payable yet (still on its way, no COD receipt, or a
//   receipt into another COD account)
// - unknown: no parcel of this account has this key
// - twice: a key the file already had on an earlier row (only the first row counts)
// - invalid: an empty key, or an amount cell that is not a number
export const PAYOUT_MATCH_OUTCOMES = [
  'matched',
  'different',
  'already_paid',
  'not_ready',
  'unknown',
  'twice',
  'invalid',
] as const;
export type PayoutMatchOutcome = (typeof PAYOUT_MATCH_OUTCOMES)[number];

export const payoutMatchRowSchema = z.object({
  // The row's line in the file, counting the header as 1, as a spreadsheet numbers it
  row: z.number().int().min(2),
  key: z.string(),
  outcome: z.enum(PAYOUT_MATCH_OUTCOMES),
  // The parcel the key found (matched, different, not_ready); null otherwise
  shipmentId: z.uuid().nullable(),
  // The posted payout that already paid it (already_paid)
  payout: documentRefSchema.nullable(),
  // The file's two amounts, with paisa, as numbers the API read (never the cell's raw text). null
  // when the column is not mapped, or the cell is empty
  fileCollected: z.string().nullable(),
  fileCharge: z.string().nullable(),
});
export type PayoutMatchRow = z.infer<typeof payoutMatchRowSchema>;

export const payoutMatchSchema = z.object({
  // The file's header row, for the mapping step's selects
  columns: z.array(z.string()).max(200),
  // The map this answer used, and the names of it that the file does not have. With one missing
  // there are no rows: the dialog shows the mapping step with the file's columns
  map: payoutCsvMapSchema.nullable(),
  missing: z.array(z.string()),
  rows: z.array(payoutMatchRowSchema).max(MAX_PAYOUT_CSV_ROWS),
  // What the file says reached the bank, for its matched and different rows: collected − charge
  // (both mapped), so the member can hold it against the bank statement. null without both columns
  fileNet: z.string().nullable(),
});
export type PayoutMatch = z.infer<typeof payoutMatchSchema>;

// ---------------------------------------------------------------------------------------------
// What the API sends

// A courier account as the payout pages name it. storefront.payout.manage does not read the Shop
// couriers page (storefront.manage), so these come on their own read, archived accounts too: an
// archived account's parcels can still be paid out
export const payoutAccountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(COURIER_PROVIDERS),
  courier: z.enum(SHOP_COURIERS),
  archived: z.boolean(),
  // The two accounts the payout posts to, null when the courier account has none. Without a COD
  // account it has nothing to pay out; without a charges account only lines with no charge can be
  // paid (payout_account_no_charges)
  codAccount: accountChoiceSchema.nullable(),
  chargeAccount: accountChoiceSchema.nullable(),
  // What it holds now, as on the Shop couriers page (posted COD receipts no payout took)
  holds: z.object({ amount: z.string(), parcels: z.number().int().min(0) }),
});
export type PayoutAccount = z.infer<typeof payoutAccountSchema>;

// The payout pages' one read of choices: the courier accounts and the bank accounts a payout may
// go into (active accounts that hold money, not a group; the form leaves out the chosen courier
// account's own COD account)
export const payoutSetupSchema = z.object({
  accounts: z.array(payoutAccountSchema),
  bankAccounts: z.array(accountChoiceSchema),
});
export type PayoutSetup = z.infer<typeof payoutSetupSchema>;

// The new payout's parcels for one account, with its saved CSV map (null: none saved yet)
export const payoutParcelsSchema = z.object({
  account: payoutAccountSchema,
  parcels: z.array(payoutParcelSchema),
  csvMap: payoutCsvMapSchema.nullable(),
});
export type PayoutParcels = z.infer<typeof payoutParcelsSchema>;

export const payoutSummarySchema = z.object({
  id: z.uuid(),
  number: z.string(),
  date: z.iso.date(),
  account: z.object({ id: z.uuid(), name: z.string(), courier: z.enum(SHOP_COURIERS) }),
  bankAccountId: z.uuid(),
  // The courier's own name for the payment (Steadfast's "SFC-23618228"), or a bank reference
  reference: z.string().nullable(),
  parcels: z.number().int().min(1),
  // Sums of the lines, with paisa: collected − charges = net, what reached the bank
  collected: z.string(),
  charges: z.string(),
  net: z.string(),
  status: z.enum(PAYOUT_STATUSES),
  version: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type PayoutSummary = z.infer<typeof payoutSummarySchema>;

export const payoutLineSchema = z.object({
  shipmentId: z.uuid(),
  kind: z.enum(PAYOUT_LINE_KINDS),
  order: z.object({ id: z.uuid(), number: z.string() }),
  invoice: z.string(),
  trackingCode: z.string().nullable(),
  collected: z.string(),
  charge: z.string(),
  // The courier's own figure when the payout was saved, so the page can say "Steadfast said ৳60"
  // when the member typed another charge. null: the courier had not said
  courierCharge: z.string().nullable(),
  receipt: documentRefSchema.nullable(),
});
export type PayoutLine = z.infer<typeof payoutLineSchema>;

export const payoutSchema = payoutSummarySchema.extend({
  note: z.string().nullable(),
  // The accounts it posted to, as they were then (a courier account may name others since)
  codAccountId: z.uuid(),
  chargeAccountId: z.uuid().nullable(),
  branchId: z.uuid(),
  lines: z.array(payoutLineSchema).min(1).max(MAX_PAYOUT_LINES),
  entry: entryRefSchema,
  // The reversal that voided it, its date and why; null while posted
  voidEntry: entryRefSchema.nullable(),
  voidDate: z.iso.date().nullable(),
  voidReason: z.string().nullable(),
});
export type Payout = z.infer<typeof payoutSchema>;

// ---------------------------------------------------------------------------------------------
// What the form sends

// A line's charge: a shop amount, so whole paisa, and 0 when the courier charged nothing. Required:
// an empty box is a charge nobody typed, and the bank figure depends on it
export const payoutChargeSchema = z
  .string()
  .trim()
  .refine((value) => value !== '', errorCode('payout_charge_required'))
  .refine(
    (value) => value === '' || /^\d{1,15}(?:\.\d{1,2})?$/.test(value),
    errorCode('money_format'),
  );

export const payoutLineInputSchema = z.object({
  shipmentId: z.uuid(),
  charge: payoutChargeSchema,
});

// Branch: the shop warehouse's, chosen by the API (decision 7), like the COD receipts'. Whether a
// parcel is still payable, a charge line's charge is above zero (payout_charge_line_zero), the net
// is not below zero (payout_below_zero) and the date is not before a receipt's
// (payout_date_before_receipt) only the API knows
export const payoutInputSchema = z
  .object({
    accountId: z.uuid(errorCode('payout_pick_account')),
    date: z.iso.date(errorCode('sales_date_required')),
    bankAccountId: z.uuid(errorCode('payout_bank_account_invalid')),
    reference: optionalText(60),
    note: optionalText(300),
    lines: z
      .array(payoutLineInputSchema)
      .min(1, errorCode('payout_lines_required'))
      .max(MAX_PAYOUT_LINES, errorCode('payout_too_many_lines')),
  })
  .superRefine((input, ctx) => {
    // The same parcel twice would take its money out twice. The error sits on the second line
    const seen = new Set<string>();
    input.lines.forEach((line, index) => {
      if (seen.has(line.shipmentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'shipmentId'],
          message: errorCode('payout_line_twice'),
        });
      }
      seen.add(line.shipmentId);
    });
  });
export type PayoutInput = z.infer<typeof payoutInputSchema>;
export type PayoutFormValues = z.input<typeof payoutInputSchema>;

// The same as a receipt's: the day it turned out wrong (not before the payout's own date,
// receipt_void_date), and why
export const voidPayoutInputSchema = voidReceiptInputSchema;
export type VoidPayoutInput = z.infer<typeof voidPayoutInputSchema>;

export const payoutListQuerySchema = pageQuerySchema.extend({
  status: z.enum(PAYOUT_STATUSES).optional(),
  accountId: z.uuid().optional(),
});
export type PayoutListQuery = z.input<typeof payoutListQuerySchema>;

export const payoutPageSchema = pageOf(payoutSummarySchema);
export type PayoutPage = z.infer<typeof payoutPageSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

// Every route needs storefront.payout.manage (decision 9): reading a payout shows the bank and the
// courier's money, and making one moves it. The parcels and the CSV match hang on the courier
// account (/storefront/couriers/:id/…), so they never meet /storefront/payouts/:id. The setup has
// its own address for the same reason (/storefront/payouts/setup would reach `get` with "setup"
// as the id).
export const storefrontPayoutRoutes = {
  setup: defineRoute({
    method: 'GET',
    path: '/storefront/payout-setup',
    summary: 'The courier accounts and the bank accounts a courier payout may use',
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    response: payoutSetupSchema,
  }),
  list: defineRoute({
    method: 'GET',
    path: '/storefront/payouts',
    summary: "The couriers' payouts, newest date first",
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    query: payoutListQuerySchema,
    response: payoutPageSchema,
  }),
  get: defineRoute({
    method: 'GET',
    path: '/storefront/payouts/:id',
    summary: 'One courier payout with its parcels',
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    params: idParamsSchema,
    response: payoutSchema,
  }),
  parcels: defineRoute({
    method: 'GET',
    path: '/storefront/couriers/:id/payout-parcels',
    summary: "A courier account's parcels that no payout has taken yet",
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    params: idParamsSchema,
    response: payoutParcelsSchema,
  }),
  // A POST because the file travels in the body; it changes nothing but the saved map, and that
  // only when the member gave one and the file had all its columns
  match: defineRoute({
    method: 'POST',
    path: '/storefront/couriers/:id/payout-match',
    summary: "Match the courier's payout CSV to the account's parcels",
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    params: idParamsSchema,
    body: payoutMatchInputSchema,
    response: payoutMatchSchema,
  }),
  create: defineRoute({
    method: 'POST',
    path: '/storefront/payouts',
    summary: "Record a courier's payout; it is posted at once",
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 201,
    body: payoutInputSchema,
    response: payoutSchema,
  }),
  void: defineRoute({
    method: 'POST',
    path: '/storefront/payouts/:id/void',
    summary: 'Void a courier payout: reverse its entry and free its parcels',
    auth: 'bearer',
    permission: 'storefront.payout.manage',
    status: 200,
    params: idParamsSchema,
    body: voidPayoutInputSchema,
    response: payoutSchema,
  }),
};
