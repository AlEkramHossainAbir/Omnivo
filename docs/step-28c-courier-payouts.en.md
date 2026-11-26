# Step 28c: Courier automation, part 3 — the courier's payout into the bank

> The implementation guide for "Phase 10 → Step 28", the third part, of [build-plan.bn.md](build-plan.bn.md).
> Step 28 has four parts:
>
> - **28a (done):** courier accounts, booking a packed order's parcel, the courier's news by webhook and by poll.
>   Guide: [step-28a-couriers.en.md](step-28a-couriers.en.md).
> - **28b (done):** a COD account for each courier account, a money receipt into it at Delivered, partly delivered
>   and returned parcels. Guide: [step-28b-cod-money.en.md](step-28b-cod-money.en.md).
> - **28c (this guide):** the courier's payout: a document that takes the COD money out of the courier's account into
>   the bank, with the courier's charges on their own line, and matching the courier's payout CSV.
> - **28d (later, no target date):** Pathao, which needs the address as its own city, zone and area. The work now
>   is the release, so there is no plan yet for when Pathao comes. Until then, a Pathao account is a manual one.

> Every file in this guide was placed in a separate copy of the repo (on top of commit `dcb3a80`, "courier cod
> added") and checked on 2026-11-25: `pnpm dedupe --check`, `pnpm build`, `pnpm format`, the three ESLint runs,
> `pnpm typecheck`, `pnpm test` (1,679, of them 702 in `packages/contracts`, 274 in `apps/shop`, 273 in `apps/api` and
> 261 in `apps/app`), `pnpm test:integration` (936 in 54 files; the number series test failed on the first run
> because it still counted 23 series, fixed in 28c.8, and the file then passed alone: 6 of 6) and
> `pnpm test:tenant-leak` (199 in 28 files) on Testcontainers, `pnpm boundaries` (after the fix in 28c.8),
> `pnpm test:openapi` (after generating it again), `pnpm test:bundle-size` (first load 254.0 KB gz of 255; the new
> payout page 135.5 KB, Shop couriers 137.0 KB, budget 155), the app's Playwright suite on a computer and on a phone
> (496 passed and 3 skipped on purpose; 11 timed out while the machine was busy, none of them a payout test, and all
> 11 passed when run again on one worker, on both projects), the PWA tests (4) and the shop's Playwright suite (50
> passed, 2 skipped). Then the whole way ran on the real API with the fake courier (28c.8). The real Steadfast API was
> not called, and no real payout file was seen.

## Goal

🏷️ **The courier's money comes home, and the books say so.** After 28b the rider's cash waits in the courier
account's COD account ("Cash with Steadfast"), and its balance is what the courier owes the shop. A few days later
Steadfast pays it into the bank, less its charges: one bank line for many parcels, often a few hundred. Until now
someone had to work out which parcels it paid and type a journal entry. After 28c an accountant records the payout:
they pick the courier account, tick the parcels it paid (or match the courier's payout CSV, which ticks them), check
each charge, and save. The payout posts one entry: the bank gets what arrived, the charges account gets the
courier's charges, and the COD account gives up what the riders collected. Each parcel is paid out once. A parcel
that came back costs a charge too, and the same payout records it. The Shop couriers page then holds only what is
still with the courier.

## Decisions

Agreed with the user on 2026-11-24 (all fifteen as recommended):

1. **One guide, 28c,** for the payout, the CSV matching and the return charge. Pathao is 28d. Steadfast has a payments
   API (`GET /payments`, `GET /payments/{id}` with the parcels it paid), but its answer is not documented anywhere,
   and even the SDKs read it as an untyped object. It waits for a real account: the CSV and ticking work for every
   courier.
2. **A payout document,** `storefront_payouts` with its lines `storefront_payout_lines` (one per parcel). Its header
   has the number, date, courier account, bank account, branch, reference (Steadfast's `SFC-23618228`) and note; it
   is posted or voided. Number series `storefront.payout`, prefix `CPO`. Journal source `storefront_payout`.
3. **The entry:** Dr bank (net) + Dr courier charges / Cr COD account (what was collected). A net below zero is
   refused (`payout_below_zero`); a net of zero has no bank line.
4. **What a payout can take:** the account's parcels that no posted payout took yet: a COD line has a posted COD
   receipt into the account's current COD account; a charge line is a parcel that brought no cash (returned,
   cancelled, paid online) but has a charge. A voided receipt, and a parcel delivered before 28b, are not offered.
5. **Collected cannot change:** it is the posted receipt's amount. The charge starts with the courier's
   `courier_charge` and can be changed. When the courier says it collected less, the member puts the difference in
   the charge; the line shows it.
6. **Posted when saved, voided like a receipt** (a date and a reason; the entry is reversed). A voided payout frees
   its parcels. The parcel keeps the payout's id (`payout_id`): set when posted, cleared when voided, guarded by a
   trigger, and the parcels are locked while a payout is made.
7. **The date** is never before the newest COD receipt of its lines, and the period lock applies. The bank account is
   an active account that holds money and is not the COD account. The branch is the shop warehouse's.
8. **No input VAT on the charges:** a courier gives no Mushak 6.3 for each parcel.
9. **One permission, `storefront.payout.manage`,** to read, make and void payouts. The Owner, Admin and Accountant
   templates get it.
10. **CSV matching:** the browser sends the file's text to a match route (at most 1 MB and 5,000 rows); the API
    parses it with the product import's `csv.ts`, moved to a shared place. No upload and no worker job.
11. **Column mapping:** the key column (tracking code, consignment id or invoice), the collected column and the
    charge column, saved on the courier account. A Steadfast preset, which is a guess: no real payout file was seen.
12. **What the match shows:** matched (ticked, with the file's charge), already paid (with the CPO number), unknown,
    not ready, and different (both amounts shown, the member decides).
13. **Screens:** a menu item "Shop payouts" (`MoneyReceive02` at first; `Bank` since the mockup, P1 in 28c.6) after Shop couriers; a list page, a new payout page and
    a payout's page with a printed voucher.
14. **Elsewhere:** "Record payout" in the Shop couriers row menu, and "Paid out on CPO-…" on the order page's parcel
    card.
15. **Holds keeps its meaning:** the parcels with a posted COD receipt and no payout.

Mine, made while writing (each says why where it is used):

16. **The payout pages have their own read of choices** (`/storefront/payout-setup`): the courier accounts, archived
    ones too, and the bank accounts. `storefront.payout.manage` reads neither the Shop couriers page
    (`storefront.manage`) nor the chart of accounts.
17. **Addresses that never meet `/storefront/payouts/:id`:** the setup is `/storefront/payout-setup`, and the parcels
    and the match hang on the courier account (`/storefront/couriers/:id/payout-parcels`, `…/payout-match`).
18. **The match is one route.** With no map it uses the account's saved map, else the provider's preset. When the
    file lacks a mapped column, the answer has the file's columns and the missing names and no rows (not an error),
    so the dialog shows the mapping step. A map is saved only when the member gave it and the file had all of it.
19. **Two more match outcomes:** `twice` (a key the file already had) and `invalid` (an empty key, or an amount that
    is not a number), so every row of the file is accounted for.
20. **A charge line needs a charge above zero** (`payout_charge_line_zero`): with no cash and no charge it would post
    nothing.
21. **A saved CSV map writes no audit entry:** it moves no money and changes no document.
22. **A line keeps the courier's own charge** as it was when the payout was saved, so the page can say "Steadfast
    said ৳60" next to a charge the member changed.
23. **The payout's entry has its own journal group** (`STOREFRONT_JOURNAL_SOURCES`), and the journal's Reverse
    refuses it (`journal_is_payout`): only voiding the payout frees its parcels together with the entry.
24. **Voiding reuses the receipt's input and rules** (`voidReceiptInputSchema`, `receipt_void_date`), the same as a
    refund: the day it turned out wrong, never before the payout's own date, and why.
25. **A payout keeps no entry id.** Its journal entry points at it (`journal_entries.document_id`), as a money
    receipt's does, and the void's reversal points at that entry. One link, kept in one place.
26. **A COD receipt that a posted payout paid out cannot be voided** (`receipts_paid_out`): the payout already took
    its money out of the COD account. The payout is voided first. The API's error code for it comes in 28c.3.
27. **The journal's document check reads its list from the contracts** (`DOCUMENT_JOURNAL_SOURCES`), so a new
    document's source can no longer be missing from the database.
28. **A line carries the courier account,** so two foreign keys alone keep a line's parcel and its payout on the
    same courier account, and a parcel's payout on its own account.
29. **The payout adds up at COMMIT** (a deferred constraint trigger): its sums are its lines', and its parcels point
    at it while it is posted and not once it is voided.
30. **A charge line is a parcel with no COD receipt whose journey is over** (delivered, partly delivered, returned or
    cancelled). A parcel with a receipt is paid by its receipt.
31. **28b's `storefront_shipments_cod_idx` becomes `storefront_shipments_payable_idx`:** the parcels with a receipt or
    a charge that no payout took yet. Holds and the new payout page both read it.
32. **The role templates:** the Accountant in every industry, and the two managers who run a shop (Shop manager,
    Manager). There is no Admin template: the Owner has every permission, and the managers stand in for an admin.
33. **`payout_voided`,** the payout's own "already voided", like `refund_voided`.
34. **A charge line brought no cash.** A parcel delivered with cash but no COD receipt (typed by hand before its
    account had a COD account) is not a charge line: that cash is not in the COD account.
35. **CSV column names are matched without case; keys exactly.** The preset is a guess, so "COD amount" should still
    find "COD Amount"; a key names one parcel, so a loose compare could find the wrong one.
36. **An account with no COD account stays in the payout's account select, disabled,** with "no COD account" in
    its option; the others say what they hold now.
37. **A different amount's line says to add the difference to the charge:** the receipt cannot change.
38. **A file row's line says "this number", never the key's name,** so one sentence fits all three keys.
39. **The file's bank figure is shown like the books' line,** with an "Agrees" or "Out by" pill.
40. **The two amount columns have a "Not in the file" option** (`''`, which the schema makes `null`).

## 28c.1 — Contracts

What both sides must agree on before any code moves the courier's money: the payout and its lines, the parcels a new
payout can take, the CSV map and what a match answers, the routes, the new permission, number series and journal
source, the parcel's payout, the error codes, the audit actions and their words.

### The payout

```ts
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
```

The file is long because it holds the whole conversation between the payout pages and the API. The notable parts:

- **`PAYOUT_STATUSES = RECEIPT_STATUSES`.** A payout lives like a money receipt: posted when saved, voided when it
  was wrong. Reusing the receipt's list keeps one pair of words and pills for both.
- **Two line kinds** (`cod`, `charge`). A parcel that came back brought no cash, but the courier still takes its
  charge out of the payout (decision 4). Without the `charge` kind, the return charge would need a journal entry by
  hand, which is what 28c is here to end.
- **`payoutParcelSchema.collected` is a string the form shows, never a box.** It is the posted COD receipt's amount,
  and the payout must take exactly that out of the COD account (decision 5). If the form could change it, the COD
  account would keep a remainder that belongs to no parcel.
- **`courierCharge` is nullable.** A manual courier never sends a notice, and Steadfast sends `delivery_charge` only
  on some notices. `null` means "nobody said": the box starts empty, and `payoutChargeSchema` makes the member type
  a figure, even 0. A default of 0 would quietly post a free delivery.
- **`receiptDate`** lets the form refuse a date before the money was with the courier, before the API does
  (decision 7).
- **`payoutCsvMapSchema` names columns by their header,** not by position. A courier adds a column now and then; a
  header name survives that, a column number does not. The two amount columns may be empty (`null`): a file with
  only the parcels still ticks them.
- **`STEADFAST_PAYOUT_CSV_PRESET` is a guess** (decision 11), written with `satisfies PayoutCsvMap` so a typo in the
  key kind fails the type check. Its comment says it is a guess, and the match answers the missing names instead of
  failing, so a wrong guess costs one mapping (mine 18).
- **`payoutMatchInputSchema` limits the text to 1,000,000 characters.** The API's body limit and the row limit
  (`MAX_PAYOUT_CSV_ROWS`) stop the rest; the size check here gives the form its own words for a file that is too big.
- **Seven outcomes, one row each** (decision 12, mine 19). One array, not five, so the dialog can show the file in its
  own order and group it by outcome, and every row of the file is accounted for.
- **`payoutMatchSchema.fileNet`** is what the file says reached the bank. The member holds it against the bank
  statement before saving; it is `null` without both amount columns, because half a sum would mislead.
- **`payoutAccountSchema`** carries the two posting accounts and Holds, so the new payout page needs no second read
  to say "Holds ৳45,200 · 18 parcels" and to warn when the charges account is missing (mine 16).
- **`payoutLineSchema.courierCharge`** keeps the courier's figure when the payout was saved (mine 22).
- **`payoutChargeSchema` allows two decimals only:** a shop amount is in whole paisa, like the collected amount.
- **`payoutInputSchema` has no branch.** The API takes the shop warehouse's, as the COD receipts do (decision 7), so
  the payout's entry sits in the same branch as the receipts it takes the money from.
- **The `superRefine` puts `payout_line_twice` on the second line,** where the member sees the repeat. The API checks
  again with the parcels locked, because two browsers can save at once.
- **The routes** (mine 17): `/storefront/payouts/setup` would reach `get` with "setup" as the id, so the setup and
  the per-account reads have their own addresses. The match is a POST only because the file is in the body.

### The parcel's payout, the permission, the number and the journal

```diff
@@ -23,7 +23,7 @@ import { accountChoiceSchema } from './storefront-payments.js';
 //   (a webhook, and a 15-minute poll when no webhook comes)
 // - manual: the shop books it on the courier's own website or app (or by phone) and types the
 //   courier's tracking code into the order. Nothing is called; the staff move the order as before
-// Pathao comes in step 28c: it needs the address as its own city, zone and area ids
+// Pathao comes in step 28d: it needs the address as its own city, zone and area ids
 export const COURIER_PROVIDERS = ['steadfast', 'manual'] as const;
 export type CourierProvider = (typeof COURIER_PROVIDERS)[number];
 
@@ -267,6 +267,9 @@ export const storefrontShipmentSchema = z.object({
   // archived since), the order needs attention, and the page has "Make the receipt"
   receipt: documentRefSchema.nullable(),
   receiptError: z.enum(ERROR_CODES).nullable(),
+  // Step 28c: the posted payout that paid this parcel out to the bank (the card's "Paid out on
+  // CPO-2026-27-0001"). null until one does, and again after it is voided
+  payout: documentRefSchema.nullable(),
   // When the courier gave it a tracking code. null while booking
   bookedAt: z.iso.datetime().nullable(),
   // Calls made to book it, and why the last one failed (courier_rejected_parcel: the courier said
```

The parcel gets `payout`, for the card's "Paid out on CPO-2026-27-0001" (decision 14). The comment about Pathao now
says 28d.

```diff
@@ -59,6 +59,9 @@ export const PERMISSION_KEYS = [
   // moves them on without changing the shop's prices, and an order holds a phone and an address
   'storefront.order.read',
   'storefront.order.manage',
+  // Step 28c (decision 9): the couriers' payouts. Apart from running the shop and from moving its
+  // orders: a payout moves the courier's money into the bank, so it is the accountant's
+  'storefront.payout.manage',
 ] as const;
 
 export type PermissionKey = (typeof PERMISSION_KEYS)[number];
@@ -138,4 +141,5 @@ export const PERMISSION_GROUP_OF = {
   'storefront.manage': 'storefront',
   'storefront.order.read': 'storefront',
   'storefront.order.manage': 'storefront',
+  'storefront.payout.manage': 'storefront',
 } as const satisfies Record<PermissionKey, PermissionGroup>;
```

`storefront.payout.manage` is its own key (decision 9): running the shop and moving its orders do not let anyone move
the courier's money into the bank.

```diff
@@ -29,6 +29,7 @@ export const DOCUMENT_TYPES = [
   'purchase.return',
   'purchase.debit_note',
   'purchase.refund',
+  'storefront.payout',
 ] as const;
 export type DocumentType = (typeof DOCUMENT_TYPES)[number];
 
@@ -74,6 +75,8 @@ const DEFAULT_PREFIXES = {
   'purchase.return': 'PRN',
   'purchase.debit_note': 'DN',
   'purchase.refund': 'SRF',
+  // A courier's payout of the shop's COD money (step 28c). CPO, not PO: PO is the purchase order's
+  'storefront.payout': 'CPO',
 } satisfies Record<DocumentType, string>;
 
 // টেন্যান্ট কিছু না বদলালে এই ছাঁচ — DB-তে রো লেখা হয় শুধু প্রথম বদলের সময়।
```

`CPO`, because `PO` is the purchase order's. The series is a yearly one like every other document's
(`CPO-2026-27-0001`).

```diff
@@ -69,6 +69,7 @@ export const JOURNAL_SOURCES = [
   'pos_sale',
   'pos_shift',
   'pos_return',
+  'storefront_payout',
 ] as const;
 export type JournalSource = (typeof JOURNAL_SOURCES)[number];
 
@@ -134,6 +135,18 @@ export function isPosJournalSource(value: string): value is PosJournalSource {
   return POS_JOURNAL_SOURCES.some((source) => source === value);
 }
 
+// The source of a courier's payout (step 28c). The journal's Reverse refuses it (journal_is_payout):
+// voiding the payout on its own page reverses the entry and frees its parcels together, so the
+// parcels and the books never disagree.
+export const STOREFRONT_JOURNAL_SOURCES = [
+  'storefront_payout',
+] as const satisfies readonly JournalSource[];
+export type StorefrontJournalSource = (typeof STOREFRONT_JOURNAL_SOURCES)[number];
+
+export function isStorefrontJournalSource(value: string): value is StorefrontJournalSource {
+  return STOREFRONT_JOURNAL_SOURCES.some((source) => source === value);
+}
+
 // Every source whose entry points at the document that made it (journal_entries_document_check in
 // the database holds the same list)
 export const DOCUMENT_JOURNAL_SOURCES = [
@@ -141,6 +154,7 @@ export const DOCUMENT_JOURNAL_SOURCES = [
   ...SALES_JOURNAL_SOURCES,
   ...PURCHASE_JOURNAL_SOURCES,
   ...POS_JOURNAL_SOURCES,
+  ...STOREFRONT_JOURNAL_SOURCES,
 ] as const satisfies readonly JournalSource[];
 
 // '2026-07-01' and -1 → '2026-06-30'. The arithmetic runs in UTC, so no time zone can move the
```

The new source goes into `DOCUMENT_JOURNAL_SOURCES`, so its entry must point at its payout (the database check gets
the same name in 28c.2), and into its own group, so the journal's Reverse can refuse it (mine 23).

### Error codes, audit actions and routes

```diff
@@ -813,6 +813,39 @@ export const ERROR_CODES = [
   'storefront_order_return_everything',
   // "Make the receipt" on a parcel whose COD receipt did not fail
   'storefront_cod_receipt_not_failed',
+  // Step 28c: the courier's payout. No courier account picked; a bank account that is not an
+  // active account holding money (or is a group, or is the courier's own COD account); no line, or
+  // more than MAX_PAYOUT_LINES; one parcel on two lines
+  'payout_pick_account',
+  'payout_bank_account_invalid',
+  'payout_lines_required',
+  'payout_too_many_lines',
+  'payout_line_twice',
+  // A line's charge box left empty
+  'payout_charge_required',
+  // The courier account has no COD account (it has nothing to pay out), or the payout has charges
+  // and the account has no charges account
+  'payout_account_no_cod',
+  'payout_account_no_charges',
+  // A parcel that this payout cannot take: another account's, still on its way, without a posted
+  // COD receipt in the COD account, or already in a posted payout (also a race: another payout
+  // took it a moment ago). The form reloads its parcels
+  'payout_parcel_unavailable',
+  // A charge line (no cash) with a charge of zero: it would pay nothing and take nothing
+  'payout_charge_line_zero',
+  // The charges are more than what the riders collected on its lines: the bank would pay the
+  // courier. Add the payout's delivered parcels too
+  'payout_below_zero',
+  // Dated before one of its COD receipts: the money was not in the courier's account yet
+  'payout_date_before_receipt',
+  // The CSV: empty or not a CSV, over MAX_PAYOUT_CSV_CHARS, over MAX_PAYOUT_CSV_ROWS rows, and a
+  // mapping box left empty
+  'payout_csv_unreadable',
+  'payout_csv_too_big',
+  'payout_csv_too_many_rows',
+  'payout_csv_column_required',
+  // A payout's entry is undone by voiding the payout on its own page, so its parcels are freed too
+  'journal_is_payout',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

Each code says what the member must do. `payout_parcel_unavailable` is one code for four reasons (another account's
parcel, not delivered, no receipt, already paid): the form cannot fix any of them but by reloading the parcels, and
the reason may change between two clicks anyway.

```diff
@@ -322,6 +322,11 @@ export const AUDIT_ACTIONS = [
   'storefront_order.partly_delivered',
   'storefront_order.returned',
   'storefront_order.cod_receipt_made',
+  // Step 28c: the courier's payout (entity = storefront_payout), made (with its number, account,
+  // bank account, parcel count and the three sums) and voided (with the date and the reason). A
+  // saved CSV map writes nothing here: it changes no money and no document
+  'storefront_payout.created',
+  'storefront_payout.voided',
 ] as const;
 export type AuditAction = (typeof AUDIT_ACTIONS)[number];
 
@@ -389,6 +394,7 @@ export const AUDIT_ENTITY_TYPES = [
   'storefront_coupon',
   'storefront_payment_gateway',
   'courier_account',
+  'storefront_payout',
 ] as const;
 export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];
 
```

```diff
@@ -25,6 +25,7 @@ import { storefrontCouponRoutes } from './storefront-coupons.js';
 import { storefrontOrderDeliveryRoutes, storefrontOrderRoutes } from './storefront-orders.js';
 import { shippingRoutes } from './shipping.js';
 import { storefrontPaymentRoutes } from './storefront-payments.js';
+import { storefrontPayoutRoutes } from './storefront-payouts.js';
 import { publicStorefrontRoutes } from './storefront.js';
 import { creditNoteRoutes } from './credit-notes.js';
 import { customFieldRoutes } from './custom-fields.js';
@@ -172,6 +173,7 @@ type Routes = Readonly<{
   storefrontOrderDeliveries: typeof storefrontOrderDeliveryRoutes;
   storefrontCoupons: typeof storefrontCouponRoutes;
   storefrontPayments: typeof storefrontPaymentRoutes;
+  storefrontPayouts: typeof storefrontPayoutRoutes;
   shipping: typeof shippingRoutes;
 }>;
 
@@ -259,5 +261,6 @@ export const routes: Routes = {
   storefrontOrderDeliveries: storefrontOrderDeliveryRoutes,
   storefrontCoupons: storefrontCouponRoutes,
   storefrontPayments: storefrontPaymentRoutes,
+  storefrontPayouts: storefrontPayoutRoutes,
   shipping: shippingRoutes,
 };
```

```diff
@@ -68,6 +68,7 @@ export * from './storefront-admin.js';
 export * from './storefront-appearance.js';
 export * from './storefront-orders.js';
 export * from './storefront-payments.js';
+export * from './storefront-payouts.js';
 export * from './shipping.js';
 export * from './supplier-payments.js';
 export * from './supplier-refunds.js';
```

### Words

```diff
@@ -469,6 +469,8 @@ export const en = {
         revaluation: 'Stock revaluation',
       },
       accounting: { journal: 'Journal voucher' },
+      // Step 28c
+      storefront: { payout: 'Courier payout' },
     },
     yearStyles: {
       none: 'No year',
@@ -1017,6 +1019,7 @@ export const en = {
       pos_sale: 'POS sale',
       pos_shift: 'POS shift',
       pos_return: 'POS return',
+      storefront_payout: 'Courier payout',
     },
     fromDocument: 'From {{document}}',
     stockEntryHint:
@@ -7194,6 +7197,10 @@ export const en = {
         read: 'See the shop’s orders, with the buyers’ phones and addresses',
         manage: 'Move the shop’s orders on and cancel them',
       },
+      // Step 28c
+      payout: {
+        manage: 'Record and void the couriers’ payouts of the shop’s COD money into the bank',
+      },
     },
   },
   invite: {
@@ -7279,6 +7286,7 @@ export const en = {
       storefront_coupon: 'Shop coupons',
       storefront_payment_gateway: 'Shop payment gateway',
       courier_account: 'Shop couriers',
+      storefront_payout: 'Courier payouts',
     },
     columns: {
       when: 'When',
@@ -7676,6 +7684,11 @@ export const en = {
         archived: 'Archived a courier account',
         restored: 'Restored an archived courier account',
       },
+      // Step 28c
+      storefront_payout: {
+        created: 'Recorded a courier’s payout',
+        voided: 'Voided a courier’s payout',
+      },
     },
     // changes-এর ঘরের নাম → লেখা। তালিকায় না থাকলে কাঁচা নামই দেখায় (নতুন সার্ভারের নতুন ঘর)
     fields: {
@@ -8942,6 +8955,34 @@ export const en = {
       'Tick what came back. If the shopper kept everything, use Mark delivered.',
     storefront_order_return_everything: 'Everything came back. Use Receive the return instead.',
     storefront_cod_receipt_not_failed: 'This parcel’s COD receipt did not fail. Reload the order.',
+    // Step 28c
+    payout_pick_account: 'Pick the courier account that paid.',
+    payout_bank_account_invalid:
+      'Pick the active bank or cash account the money went into, not the courier’s own COD account.',
+    payout_lines_required: 'Tick at least one parcel this payout paid.',
+    payout_too_many_lines:
+      'A payout takes at most 500 parcels. Record the rest as a second payout.',
+    payout_line_twice: 'This parcel is on the payout twice. Remove one of the lines.',
+    payout_charge_required: 'Type the courier’s charge for this parcel, or 0.',
+    payout_account_no_cod:
+      'This courier account has no COD account, so it holds no money to pay out. Pick one in Shop couriers.',
+    payout_account_no_charges:
+      'This payout has charges, and the courier account has no charges account. Pick one in Shop couriers.',
+    payout_parcel_unavailable:
+      'A parcel can’t be paid out any more: another payout took it, or it changed. Reload the parcels.',
+    payout_charge_line_zero:
+      'A parcel that brought no cash is here only for its charge. Type the charge, or untick it.',
+    payout_below_zero:
+      'The charges are more than the cash on these parcels. Tick the delivered parcels this payout paid too.',
+    payout_date_before_receipt:
+      'Pick a date on or after the COD receipts of these parcels: the money wasn’t with the courier before.',
+    payout_csv_unreadable:
+      'This file isn’t a CSV with a header row. Download the payout as CSV again.',
+    payout_csv_too_big: 'This file is too big. Download one payout at a time.',
+    payout_csv_too_many_rows: 'The file has more than 5,000 rows. Download one payout at a time.',
+    payout_csv_column_required: 'Pick the column.',
+    journal_is_payout:
+      'A courier payout’s entry can’t be reversed here. Void the payout on its own page: that frees its parcels too.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -419,6 +419,8 @@ export const bn: Messages = {
         revaluation: 'স্টকের পুনর্মূল্যায়ন',
       },
       accounting: { journal: 'জার্নাল ভাউচার' },
+      // Step 28c
+      storefront: { payout: 'কুরিয়ার পেআউট' },
     },
     yearStyles: {
       none: 'বছর ছাড়া',
@@ -907,6 +909,7 @@ export const bn: Messages = {
       pos_sale: 'POS বিক্রি',
       pos_shift: 'POS শিফট',
       pos_return: 'POS ফেরত',
+      storefront_payout: 'কুরিয়ার পেআউট',
     },
     fromDocument: '{{document}} থেকে',
     stockEntryHint:
@@ -6603,6 +6606,10 @@ export const bn: Messages = {
         read: 'শপের অর্ডার দেখা, ক্রেতার ফোন আর ঠিকানাসহ',
         manage: 'শপের অর্ডার এগিয়ে নেওয়া আর বাতিল করা',
       },
+      // Step 28c
+      payout: {
+        manage: 'শপের COD টাকা ব্যাংকে আসার কুরিয়ার পেআউট লেখা আর বাতিল করা',
+      },
     },
   },
   invite: {
@@ -6688,6 +6695,7 @@ export const bn: Messages = {
       storefront_coupon: 'শপের কুপন',
       storefront_payment_gateway: 'শপের পেমেন্ট গেটওয়ে',
       courier_account: 'শপের কুরিয়ার',
+      storefront_payout: 'কুরিয়ার পেআউট',
     },
     columns: {
       when: 'কখন',
@@ -7073,6 +7081,11 @@ export const bn: Messages = {
         archived: 'কুরিয়ার অ্যাকাউন্ট আর্কাইভ করেছেন',
         restored: 'আর্কাইভ করা কুরিয়ার অ্যাকাউন্ট ফিরিয়ে এনেছেন',
       },
+      // Step 28c
+      storefront_payout: {
+        created: 'কুরিয়ারের একটা পেআউট লিখেছেন',
+        voided: 'কুরিয়ারের একটা পেআউট বাতিল করেছেন',
+      },
     },
     fields: {
       name: 'নাম',
@@ -8284,6 +8297,32 @@ export const bn: Messages = {
     storefront_order_return_everything: 'সবই ফেরত এসেছে। এর বদলে "ফেরত মাল বুঝে নিন" চাপুন।',
     storefront_cod_receipt_not_failed:
       'এই পার্সেলের COD রিসিট ব্যর্থ হয়নি। অর্ডারটা আবার লোড করুন।',
+    // Step 28c
+    payout_pick_account: 'যে কুরিয়ার অ্যাকাউন্ট টাকা দিয়েছে সেটা বাছুন।',
+    payout_bank_account_invalid:
+      'যে চালু ব্যাংক বা ক্যাশ অ্যাকাউন্টে টাকা এসেছে সেটা বাছুন, কুরিয়ারের নিজের COD অ্যাকাউন্ট নয়।',
+    payout_lines_required: 'এই পেআউটে যে পার্সেলগুলোর টাকা এসেছে, অন্তত একটায় টিক দিন।',
+    payout_too_many_lines: 'একটা পেআউটে সর্বোচ্চ ৫০০টা পার্সেল। বাকিগুলো আরেকটা পেআউটে লিখুন।',
+    payout_line_twice: 'এই পার্সেল পেআউটে দুবার আছে। একটা লাইন সরান।',
+    payout_charge_required: 'এই পার্সেলের কুরিয়ার চার্জ লিখুন, না থাকলে 0।',
+    payout_account_no_cod:
+      'এই কুরিয়ার অ্যাকাউন্টের COD অ্যাকাউন্ট নেই, তাই পেআউটের কোনো টাকা এর কাছে নেই। শপের কুরিয়ার পেজে একটা বাছুন।',
+    payout_account_no_charges:
+      'এই পেআউটে চার্জ আছে, কিন্তু কুরিয়ার অ্যাকাউন্টের চার্জের অ্যাকাউন্ট নেই। শপের কুরিয়ার পেজে একটা বাছুন।',
+    payout_parcel_unavailable:
+      'একটা পার্সেলের পেআউট আর হয় না: অন্য পেআউট নিয়ে নিয়েছে, বা সেটা বদলেছে। পার্সেলগুলো আবার লোড করুন।',
+    payout_charge_line_zero:
+      'যে পার্সেলে নগদ আসেনি, সেটা এখানে শুধু তার চার্জের জন্য। চার্জ লিখুন, না হলে টিক তুলে দিন।',
+    payout_below_zero:
+      'এই পার্সেলগুলোর নগদের চেয়ে চার্জ বেশি। এই পেআউটে যে পৌঁছানো পার্সেলগুলোর টাকা এসেছে সেগুলোতেও টিক দিন।',
+    payout_date_before_receipt:
+      'এই পার্সেলগুলোর COD রিসিটের দিন বা তার পরের তারিখ বাছুন: তার আগে টাকা কুরিয়ারের কাছে ছিল না।',
+    payout_csv_unreadable: 'ফাইলটা header row সহ CSV না। পেআউটটা আবার CSV হিসেবে ডাউনলোড করুন।',
+    payout_csv_too_big: 'ফাইলটা অনেক বড়। একবারে একটা পেআউট ডাউনলোড করুন।',
+    payout_csv_too_many_rows: 'ফাইলে ৫,০০০-এর বেশি row আছে। একবারে একটা পেআউট ডাউনলোড করুন।',
+    payout_csv_column_required: 'কলামটা বাছুন।',
+    journal_is_payout:
+      'কুরিয়ার পেআউটের এন্ট্রি এখানে রিভার্স করা যায় না। পেআউটের নিজের পেজে বাতিল করুন: তাতে তার পার্সেলগুলোও ছাড়া পায়।',
   },
   ui: {
     dataTable: {
```

The screens' words come in 28c.5. These are the words the type check asks for now: the number series' name, the
journal source, the permission, the audit actions and the errors.

### Tests

```ts
import { describe, expect, it } from 'vitest';

import { routes } from './routes.js';
import {
  MAX_PAYOUT_CSV_CHARS,
  MAX_PAYOUT_LINES,
  payoutCsvMapSchema,
  payoutInputSchema,
  payoutMatchInputSchema,
  STEADFAST_PAYOUT_CSV_PRESET,
} from './storefront-payouts.js';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const BANK = '01920000-0000-7000-8000-000000000002';
const PARCEL_A = '01920000-0000-7000-8000-000000000003';
const PARCEL_B = '01920000-0000-7000-8000-000000000004';

function payout(extra: object = {}) {
  return {
    accountId: ACCOUNT,
    date: '2026-11-24',
    bankAccountId: BANK,
    reference: 'SFC-23618228',
    note: '',
    lines: [
      { shipmentId: PARCEL_A, charge: '60' },
      { shipmentId: PARCEL_B, charge: '0' },
    ],
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

describe('payout input', () => {
  it('takes parcels with their charges, 0 included', () => {
    expect(payoutInputSchema.parse(payout())).toMatchObject({
      reference: 'SFC-23618228',
      note: null,
      lines: [
        { shipmentId: PARCEL_A, charge: '60' },
        { shipmentId: PARCEL_B, charge: '0' },
      ],
    });
  });

  it('names the box of a missing account, bank account or line', () => {
    expect(
      errorsOf(
        payoutInputSchema.safeParse(payout({ accountId: '', bankAccountId: '', lines: [] })),
      ),
    ).toEqual({
      accountId: 'payout_pick_account',
      bankAccountId: 'payout_bank_account_invalid',
      lines: 'payout_lines_required',
    });
  });

  it('needs a charge in each box, in whole paisa', () => {
    const lines = [
      { shipmentId: PARCEL_A, charge: '' },
      { shipmentId: PARCEL_B, charge: '60.505' },
    ];
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      'lines.0.charge': 'payout_charge_required',
      'lines.1.charge': 'money_format',
    });
  });

  it('refuses one parcel twice, on the second line', () => {
    const lines = [
      { shipmentId: PARCEL_A, charge: '60' },
      { shipmentId: PARCEL_A, charge: '60' },
    ];
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      'lines.1.shipmentId': 'payout_line_twice',
    });
  });

  it('takes at most MAX_PAYOUT_LINES parcels', () => {
    const lines = Array.from({ length: MAX_PAYOUT_LINES + 1 }, (_, index) => ({
      shipmentId: `01920000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      charge: '0',
    }));
    expect(errorsOf(payoutInputSchema.safeParse(payout({ lines })))).toEqual({
      lines: 'payout_too_many_lines',
    });
  });
});

describe('payout CSV', () => {
  it('maps an empty amount column to none, and needs the key column', () => {
    expect(
      payoutCsvMapSchema.parse({
        key: 'tracking_code',
        keyColumn: ' Tracking Code ',
        collectedColumn: '',
        chargeColumn: 'Charge',
      }),
    ).toEqual({
      key: 'tracking_code',
      keyColumn: 'Tracking Code',
      collectedColumn: null,
      chargeColumn: 'Charge',
    });
    expect(
      errorsOf(
        payoutCsvMapSchema.safeParse({
          key: 'invoice',
          keyColumn: '',
          collectedColumn: '',
          chargeColumn: '',
        }),
      ),
    ).toEqual({ keyColumn: 'payout_csv_column_required' });
  });

  it('keeps the Steadfast preset a valid map', () => {
    expect(payoutCsvMapSchema.parse(STEADFAST_PAYOUT_CSV_PRESET)).toEqual(
      STEADFAST_PAYOUT_CSV_PRESET,
    );
  });

  it('refuses an empty file and one over the size limit', () => {
    expect(errorsOf(payoutMatchInputSchema.safeParse({ csv: '', map: null }))).toEqual({
      csv: 'payout_csv_unreadable',
    });
    const csv = 'a'.repeat(MAX_PAYOUT_CSV_CHARS + 1);
    expect(errorsOf(payoutMatchInputSchema.safeParse({ csv, map: null }))).toEqual({
      csv: 'payout_csv_too_big',
    });
  });
});

describe('payout routes', () => {
  it('never put a word where /storefront/payouts/:id would read it as an id', () => {
    // GET /storefront/payouts/setup or …/parcels would reach `get` with that word as the id
    const paths = Object.values(routes.storefrontPayouts).map((route) => route.path);
    const under = paths.filter((path) => path.startsWith('/storefront/payouts/'));
    expect(under.every((path) => path.startsWith('/storefront/payouts/:id'))).toBe(true);
  });

  it('all need storefront.payout.manage', () => {
    for (const route of Object.values(routes.storefrontPayouts)) {
      expect(route.permission).toBe('storefront.payout.manage');
    }
  });
});
```

The route test guards mine 17: if a later change adds `/storefront/payouts/something`, it fails before Nest sends that
address to `get`.

### Check this part

```bash
pnpm turbo build --filter='./packages/*' --continue
pnpm --filter @omnivo/contracts test        # 702 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test
```

These fail until later parts, on purpose:

- `@omnivo/db`'s build: the permission catalog has no words for `storefront.payout.manage` yet (28c.2).
- `pnpm --filter @omnivo/api typecheck`: the parcel view (`storefront/shipping/shipments.ts`) has no `payout` yet
  (28c.3).
- `pnpm --filter @omnivo/app typecheck`: the app's parcel mock has no `payout` yet (28c.7).

Broken on purpose while this part was written, each caught:

- The `superRefine` without its check: "refuses one parcel twice, on the second line" fails.
- `payoutChargeSchema` with four decimals: "needs a charge in each box, in whole paisa" fails.

## 28c.2 — Database

Two new tables (the payout and its lines), a column on the parcel (the payout that paid it out) and one on the courier
account (its saved CSV map), the journal's document check, the permission's words, and the rules that keep the
courier's money right.

### The payout and its lines

```ts
import { PAYOUT_LINE_KINDS, PAYOUT_STATUSES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { branches } from './branches.js';
import { ledgerAccounts } from './ledger-accounts.js';
import { receipts } from './receipts.js';
import { courierAccounts, storefrontShipments } from './storefront-shipping.js';
import { tenants } from './tenants.js';

// Step 28c: the courier's payout (system design §14.6). One row per transfer the courier made to
// the bank, and one line per parcel it paid. Saving posts it (Dr bank, Dr charges / Cr the COD
// account); a mistake is voided. Its journal entry points at it (journal_entries.document_id, as a
// receipt's does), so the payout keeps no entry id. Migration 0083 gives both tables their rules.

// Two kinds of value from the contracts as SQL. Written by code only, never by a person, so
// sql.raw is safe here (storefront-shipping.ts's sqlList)
const STATUSES = sql.raw(PAYOUT_STATUSES.map((value) => `'${value}'`).join(', '));
const KINDS = sql.raw(PAYOUT_LINE_KINDS.map((value) => `'${value}'`).join(', '));

export const storefrontPayouts = pgTable(
  'storefront_payouts',
  {
    // Never deleted (0083): its number is in the books, and a mistake is voided
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    createdAt: baseColumns().createdAt,
    createdBy: baseColumns().createdBy,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    // Given when it is saved (the 'storefront.payout' series, CPO-2026-27-0001): saved means posted
    number: text('number').notNull(),
    // The day the money reached the bank. Not before any of its COD receipts (decision 7) and not in
    // a locked period: both are the API's checks, because the journal's own lock check would only
    // say "locked", and a receipt's date is on another table
    date: date('date', { mode: 'string' }).notNull(),
    courierAccountId: uuid('courier_account_id').notNull(),
    // The bank account the money went into, and the two accounts it came out of, copied from the
    // courier account when the payout was saved: the account may name others later (decision 3)
    bankAccountId: uuid('bank_account_id').notNull(),
    codAccountId: uuid('cod_account_id').notNull(),
    // NULL only when no line has a charge (the check below)
    chargeAccountId: uuid('charge_account_id'),
    // The shop warehouse's branch, as the COD receipts' (decision 7)
    branchId: uuid('branch_id').notNull(),
    // The courier's own name for the payment (Steadfast's "SFC-23618228"), or the bank's reference
    reference: text('reference'),
    note: text('note'),
    // The sums of the lines, with paisa (0083's check makes sure they are): what the riders
    // collected, the courier's charges, and what reached the bank
    collected: numeric('collected', { precision: 19, scale: 4 }).notNull(),
    charges: numeric('charges', { precision: 19, scale: 4 }).notNull(),
    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
    status: text('status', { enum: PAYOUT_STATUSES }).notNull().default('posted'),
    // Set when voided: the day it turned out wrong, and why (as a receipt's)
    voidDate: date('void_date', { mode: 'string' }),
    voidReason: text('void_reason'),
  },
  (table) => [
    unique('storefront_payouts_tenant_id_key').on(table.tenantId, table.id),
    // The target of the parcel's payout_id foreign key: a parcel is paid out only by a payout of
    // its own courier account, and no trigger is needed to say so
    unique('storefront_payouts_account_key').on(table.tenantId, table.courierAccountId, table.id),
    unique('storefront_payouts_number_key').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id), and the same for one courier account
    index('storefront_payouts_date_idx').on(table.tenantId, table.date, table.id),
    index('storefront_payouts_account_idx').on(
      table.tenantId,
      table.courierAccountId,
      table.date,
      table.id,
    ),
    foreignKey({
      name: 'storefront_payouts_courier_account_fk',
      columns: [table.tenantId, table.courierAccountId],
      foreignColumns: [courierAccounts.tenantId, courierAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payouts_bank_account_fk',
      columns: [table.tenantId, table.bankAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payouts_cod_account_fk',
      columns: [table.tenantId, table.codAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payouts_charge_account_fk',
      columns: [table.tenantId, table.chargeAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payouts_branch_fk',
      columns: [table.tenantId, table.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    check('storefront_payouts_status_check', sql`${table.status} IN (${STATUSES})`),
    // To the paisa, collected − charges = net, and never below zero (payout_below_zero): a courier
    // that kept more than it collected sends a bill, not a payout. Charges need their account
    check(
      'storefront_payouts_amounts_check',
      sql`${table.collected} >= 0 AND ${table.collected} = round(${table.collected}, 2)
        AND ${table.charges} >= 0 AND ${table.charges} = round(${table.charges}, 2)
        AND ${table.net} = ${table.collected} - ${table.charges} AND ${table.net} >= 0
        AND (${table.charges} = 0 OR ${table.chargeAccountId} IS NOT NULL)`,
    ),
    // Three different accounts. The bank as the COD account would post a payout that moves nothing;
    // the charges in either would hide them in a money account's balance (27d's two accounts)
    check(
      'storefront_payouts_accounts_check',
      sql`${table.bankAccountId} <> ${table.codAccountId}
        AND (${table.chargeAccountId} IS NULL OR (${table.chargeAccountId} <> ${table.codAccountId}
          AND ${table.chargeAccountId} <> ${table.bankAccountId}))`,
    ),
    // The contracts' limits (payoutInputSchema): 60 and 300 characters
    check(
      'storefront_payouts_text_check',
      sql`(${table.reference} IS NULL OR char_length(${table.reference}) BETWEEN 1 AND 60)
        AND (${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 300)`,
    ),
    // Voided ⇔ a void date and a reason (200 = voidReceiptInputSchema's limit), never before the
    // payout's own date (receipt_void_date)
    check(
      'storefront_payouts_void_check',
      sql`(${table.status} = 'voided') = (${table.voidDate} IS NOT NULL AND ${table.voidReason} IS NOT NULL)
        AND (${table.voidDate} IS NULL OR ${table.voidDate} >= ${table.date})
        AND (${table.voidReason} IS NULL OR char_length(${table.voidReason}) BETWEEN 1 AND 200)`,
    ),
  ],
);

// One parcel a payout paid. Written with its payout and never changed or deleted (0083): a voided
// payout keeps its lines, so its page still shows what it was
export const storefrontPayoutLines = pgTable(
  'storefront_payout_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    payoutId: uuid('payout_id').notNull(),
    // The payout's courier account, in both foreign keys below: a line's parcel is always one of
    // its payout's account
    courierAccountId: uuid('courier_account_id').notNull(),
    shipmentId: uuid('shipment_id').notNull(),
    kind: text('kind', { enum: PAYOUT_LINE_KINDS }).notNull(),
    // A cod line: its COD receipt's amount (what the rider collected). A charge line: 0
    collected: numeric('collected', { precision: 19, scale: 4 }).notNull(),
    // What the courier kept for the parcel, as the member saved it (decision 5)
    charge: numeric('charge', { precision: 19, scale: 4 }).notNull(),
    // The courier's own figure then (the parcel's courier_charge), so the page can say "Steadfast
    // said ৳60" next to a charge the member typed differently (mine 22). NULL: it had not said
    courierCharge: numeric('courier_charge', { precision: 19, scale: 4 }),
    // A cod line's COD receipt, the parcel's own (0083's trigger checks it is)
    receiptId: uuid('receipt_id'),
  },
  (table) => [
    // A parcel once per payout (payout_line_twice). It may be on a voided payout and then on a new
    // one: that is two payouts
    primaryKey({
      name: 'storefront_payout_lines_pkey',
      columns: [table.tenantId, table.payoutId, table.shipmentId],
    }),
    foreignKey({
      name: 'storefront_payout_lines_payout_fk',
      columns: [table.tenantId, table.courierAccountId, table.payoutId],
      foreignColumns: [
        storefrontPayouts.tenantId,
        storefrontPayouts.courierAccountId,
        storefrontPayouts.id,
      ],
    }),
    foreignKey({
      name: 'storefront_payout_lines_shipment_fk',
      columns: [table.tenantId, table.courierAccountId, table.shipmentId],
      foreignColumns: [
        storefrontShipments.tenantId,
        storefrontShipments.courierAccountId,
        storefrontShipments.id,
      ],
    }),
    foreignKey({
      name: 'storefront_payout_lines_receipt_fk',
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.id],
    }),
    check('storefront_payout_lines_kind_check', sql`${table.kind} IN (${KINDS})`),
    check(
      'storefront_payout_lines_amounts_check',
      sql`${table.collected} >= 0 AND ${table.collected} = round(${table.collected}, 2)
        AND ${table.charge} >= 0 AND ${table.charge} = round(${table.charge}, 2)
        AND (${table.courierCharge} IS NULL OR (${table.courierCharge} >= 0
          AND ${table.courierCharge} = round(${table.courierCharge}, 2)))`,
    ),
    // A cod line brings the money its receipt took in, and its charge may be 0. A charge line
    // brings nothing and costs something: a charge line of ৳0 would pay out nothing for a parcel
    // and still mark it paid (payout_charge_line_zero)
    check(
      'storefront_payout_lines_shape_check',
      sql`CASE ${table.kind}
          WHEN 'cod' THEN ${table.receiptId} IS NOT NULL AND ${table.collected} > 0
          ELSE ${table.receiptId} IS NULL AND ${table.collected} = 0 AND ${table.charge} > 0
        END`,
    ),
  ],
);
```

- **No `deleted_at` and no entry id** (mine 25). A payout is voided, never deleted, and its entry finds it by
  `journal_entries.document_id`, the way a receipt's does. A second link (`entry_id` here) could point at another
  entry than the one that points back.
- **`cod_account_id` and `charge_account_id` are copied onto the payout.** The courier account may name other accounts
  next month (28b's form allows it); the payout's page must still say where this money went, and its reversal must
  credit back the same accounts.
- **`net` is stored, with a check `net = collected − charges`.** The list sorts and shows it without sums, and the
  check means it can never drift from the two figures. `net >= 0` is decision 3's "a payout below zero is refused": a
  courier that kept more than it collected owes the shop, which is a bill, not a payout.
- **`charges = 0 OR charge_account_id IS NOT NULL`.** Only a payout with charges needs the charges account. Without
  this, a courier account with no charges account could post a charge to nowhere.
- **Three different accounts.** The bank as the COD account would post a payout that moves nothing; the charges in a
  money account would hide them in its balance.
- **`storefront_payouts_account_key` (tenant, courier account, id)** is the target of two foreign keys (mine 28). With
  it, "this parcel's payout is of this parcel's courier account" is a key, not a trigger: a key cannot be skipped by
  any code path.
- **The void check** matches the receipt's: a void date and a reason together, never before the payout's own date,
  and the reason within `voidReceiptInputSchema`'s 200 characters (mine 24).
- **`date` has no lock check here.** The journal refuses a locked period when the entry is posted, and the API says
  `payout_date_before_receipt` before that; a database check cannot read a receipt's date on another table.
- **A line's primary key is (tenant, payout, parcel).** A parcel is once on a payout (`payout_line_twice`), but it can
  be on a voided payout and later on a new one.
- **The line's shape check** (mine 30): a cod line has its receipt and brings money; a charge line has no receipt,
  brings nothing and costs more than ৳0 (`payout_charge_line_zero`, mine 20). A ৳0 charge line would mark a parcel
  paid without moving anything.
- **`courier_charge` on the line** is the courier's figure when the payout was saved (mine 22). The parcel's own
  column may change with a later notice; the payout's page shows what was known then.

### The parcel's payout and the saved CSV map

```diff
@@ -28,12 +28,14 @@ import { baseColumns } from '../base-columns.js';
 import { ledgerAccounts } from './ledger-accounts.js';
 import { receipts } from './receipts.js';
 import { storefrontOrders } from './storefront-orders.js';
+import { storefrontPayouts } from './storefront-payouts.js';
 import { tenants } from './tenants.js';
 
 // Step 28a: couriers (system design §14.6). The shop's courier accounts, the parcels its orders
 // are sent in, and what the courier said about each parcel. Migration 0078 gives the three tables
 // their rules. Step 28b: the courier's COD money (each account's two accounts, and what each
-// parcel collected and its receipt); migration 0081 adds their rules.
+// parcel collected and its receipt); migration 0081 adds their rules. Step 28c: the payout that
+// paid each parcel out, and each account's saved payout CSV map; migration 0083 adds their rules.
 
 // Raw bytes, as in storefront-payments.ts and sync.ts: drizzle 0.45 has no bytea column
 const bytea = customType<{ data: Buffer; driverData: Buffer }>({
@@ -103,6 +105,12 @@ export const courierAccounts = pgTable(
     // account can be archived after it was picked (27d's reason)
     codAccountId: uuid('cod_account_id'),
     chargeAccountId: uuid('charge_account_id'),
+    // Step 28c (decision 11). Which columns of this courier's payout CSV hold what
+    // (payoutCsvMapSchema), saved when a file matched with a map the member gave, so the next file
+    // needs no mapping. The API parses it with that schema on every read, so an old shape becomes
+    // "no map" rather than a crash. Saving it bumps no version: it is a convenience, not the
+    // account's settings, and a member editing the account must not get a conflict for it (mine 21)
+    payoutCsvMap: jsonb('payout_csv_map'),
   },
   (table) => [
     // The target of the parcels' foreign key (a constraint, for 0070's reason)
@@ -156,6 +164,13 @@ export const courierAccounts = pgTable(
             AND ${table.webhookTokenHash} ~ '${sql.raw(HASH_PATTERN)}'
         END`,
     ),
+    // An object of four short names at most (the map's own limits are 100 characters a name). The
+    // size cap keeps a bug from storing a whole file here
+    check(
+      'courier_accounts_payout_csv_map_check',
+      sql`${table.payoutCsvMap} IS NULL OR (jsonb_typeof(${table.payoutCsvMap}) = 'object'
+        AND octet_length(${table.payoutCsvMap}::text) <= 1024)`,
+    ),
     check(
       'courier_accounts_test_check',
       sql`${table.lastTestProblem} IS NULL OR ${table.lastTestedAt} IS NOT NULL`,
@@ -215,9 +230,17 @@ export const storefrontShipments = pgTable(
     // could not (an error code, like a payment try's receipt_error). Neither: none was due
     receiptId: uuid('receipt_id'),
     receiptError: text('receipt_error'),
+    // Step 28c (decision 6). The posted payout that paid this parcel out, set when it is posted and
+    // cleared when it is voided. One column, so a parcel is in one posted payout at most: two
+    // payouts at once lock the row, and the second finds it taken. When it may be set or cleared is
+    // 0083's guard
+    payoutId: uuid('payout_id'),
   },
   (table) => [
     unique('storefront_shipments_tenant_id_key').on(table.tenantId, table.id),
+    // Step 28c. The target of a payout line's foreign key: a line's parcel is one of its payout's
+    // courier account
+    unique('storefront_shipments_account_key').on(table.tenantId, table.courierAccountId, table.id),
     // The order's parcels, oldest first (the order page), and at most five: a sixth has no number
     unique('storefront_shipments_parcel_key').on(table.tenantId, table.orderId, table.parcelNo),
     // One invoice per courier account (decision 3): a retry can never make a second parcel at the
@@ -261,11 +284,30 @@ export const storefrontShipments = pgTable(
       columns: [table.tenantId, table.receiptId],
       foreignColumns: [receipts.tenantId, receipts.id],
     }),
-    // What each courier account holds (decision 12) and 28c's payout read the parcels with a COD
-    // receipt, per account. Partial: most parcels of a shop that takes online payment have none
-    index('storefront_shipments_cod_idx')
+    // Step 28c: in place of 28b's storefront_shipments_cod_idx. What each courier account holds
+    // (28b's decision 12: posted COD receipts no payout took) and the parcels a new payout can take
+    // (a COD receipt, or a charge the courier said), per account. Partial: a parcel leaves it once
+    // it is paid out, so it stays small however many parcels a shop has sent
+    index('storefront_shipments_payable_idx')
       .on(table.tenantId, table.courierAccountId)
-      .where(sql`${table.receiptId} IS NOT NULL`),
+      .where(
+        sql`${table.payoutId} IS NULL AND (${table.receiptId} IS NOT NULL OR ${table.courierCharge} IS NOT NULL)`,
+      ),
+    // A payout's parcels: the void clears them, and 0083's checks count them
+    index('storefront_shipments_payout_idx')
+      .on(table.tenantId, table.payoutId)
+      .where(sql`${table.payoutId} IS NOT NULL`),
+    // Its own courier account's payout only (storefront_payouts_account_key). No ON DELETE: a
+    // payout is never deleted
+    foreignKey({
+      name: 'storefront_shipments_payout_fk',
+      columns: [table.tenantId, table.courierAccountId, table.payoutId],
+      foreignColumns: [
+        storefrontPayouts.tenantId,
+        storefrontPayouts.courierAccountId,
+        storefrontPayouts.id,
+      ],
+    }),
     check(
       'storefront_shipments_values_check',
       sql`${table.status} IN (${sqlList(SHIPMENT_STATUSES)})
```

- **`payout_id` on the parcel, not a flag on the line** (decision 6). One column means "in one posted payout at most"
  holds by itself: two payouts that take the same parcel at once both update this row, and the second one waits for
  the first and then finds it taken. A rule on the lines would need a lock the code has to remember.
- **`storefront_shipments_account_key`** is the lines' foreign key target, for mine 28.
- **The payout foreign key has three columns** (tenant, courier account, payout). A parcel can only point at a payout
  of its own courier account.
- **`storefront_shipments_payable_idx` replaces 28b's `storefront_shipments_cod_idx`** (mine 31). Holds (28b) reads
  "a receipt and no payout" and the new payout page reads "a receipt or a charge, and no payout"; both are covered by
  this one partial index, and a parcel leaves it once it is paid out, so the index stays small for a shop that has
  sent ten thousand parcels. Postgres proves that `receipt_id IS NOT NULL AND payout_id IS NULL` implies the index's
  `WHERE`, so Holds uses it once 28c.3 adds `payout_id IS NULL` to its query (the checks below look at the plan).
- **`storefront_shipments_payout_idx`** finds a payout's parcels: the void clears them, and 0083's check counts them.
- **`payout_csv_map` is `jsonb` with a size cap,** not four columns. Its shape is the contracts' `payoutCsvMapSchema`,
  and the API parses it on every read, so a map saved by an older shape reads as "no map" instead of failing. Saving
  it bumps no version (mine 21): a member editing the courier account must not get a conflict because someone matched
  a file.

### The two schema files import each other

```diff
@@ -8,7 +8,14 @@ module.exports = {
       // Step 17c: a bill line points at a goods receipt line, and a goods receipt a bill made points
       // at its bill. The two tables reference each other, and Drizzle reads a table's foreign keys
       // only when it is asked for them, after both files have loaded. Only these two files.
-      from: { pathNot: '^packages/db/src/schema/(bills|goods-receipts)\\.ts$' },
+      // Step 28c: the same for a parcel and its payout. The parcel keeps the payout that paid it
+      // (payout_id), and each payout line points at its parcel. Only these two files too.
+      from: {
+        pathNot: [
+          '^packages/db/src/schema/(bills|goods-receipts)\\.ts$',
+          '^packages/db/src/schema/storefront-(shipping|payouts)\\.ts$',
+        ],
+      },
       to: { circular: true },
     },
     {
```

The parcel's payout foreign key needs `storefrontPayouts` in `storefront-shipping.ts`, and a payout line's parcel
foreign key needs `storefrontShipments` in `storefront-payouts.ts`. So the two files import each other, and
`pnpm boundaries` refuses every import loop. Step 17c had the same case (a bill line points at a goods receipt line,
and a goods receipt points at its bill) and allowed exactly those two files. These two files are added the same way
(mine 53). It is safe here for the same reason: Drizzle reads a table's foreign keys only when it is asked for them,
after both files have loaded, so neither file needs the other while it loads. The rule still catches a loop in any
other file. Moving both tables into one file would also work, but `storefront-shipping.ts` is already long, and the
payout is a document of its own, like a bill.

### The journal's document check

```diff
@@ -1,4 +1,4 @@
-import { JOURNAL_SOURCES, JOURNAL_STATUSES } from '@omnivo/contracts';
+import { DOCUMENT_JOURNAL_SOURCES, JOURNAL_SOURCES, JOURNAL_STATUSES } from '@omnivo/contracts';
 import { sql } from 'drizzle-orm';
 import {
   boolean,
@@ -82,11 +82,13 @@ export const journalEntries = pgTable(
     // receipt's since 15c, a sales return's, a credit note's and a refund's since 15d, a goods
     // receipt's since 17b, a bill's and a supplier payment's since 17c, a purchase return's, a
     // debit note's and a supplier refund's since 17d, a POS sale's since 20a, a POS shift's since
-    // 20b, a POS return's since 20c) always points at its document, and no other entry does. The list is
-    // contracts' DOCUMENT_JOURNAL_SOURCES.
+    // 20b, a POS return's since 20c, a courier payout's since 28c) always points at its document,
+    // and no other entry does. Since 28c the list is read from the contracts'
+    // DOCUMENT_JOURNAL_SOURCES, so a new document's source can no longer be left out here (it was
+    // typed by hand before, and the two had to be kept equal by eye)
     check(
       'journal_entries_document_check',
-      sql`(${table.source} IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_invoice', 'sales_receipt', 'sales_return', 'sales_credit_note', 'sales_refund', 'purchase_receipt', 'purchase_bill', 'purchase_payment', 'purchase_return', 'purchase_debit_note', 'purchase_refund', 'pos_sale', 'pos_shift', 'pos_return')) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
+      sql`(${table.source} IN (${sql.raw(DOCUMENT_JOURNAL_SOURCES.map((source) => `'${source}'`).join(', '))})) = (${table.documentId} IS NOT NULL AND ${table.documentNumber} IS NOT NULL)`,
     ),
     // A document's entries (a transfer has up to two; an invoice or a receipt has one, which the
     // invoice page and the receipt page find here)
```

The check had its list typed by hand. Each document since step 14 added its name in two places, and the comment asked
to keep them equal by eye. It now reads `DOCUMENT_JOURNAL_SOURCES` (mine 27), so `storefront_payout` is in it, and so
is every later source. `sql.raw` is safe here: the list is the contracts' constant, never anything a person typed.
The generated migration drops and adds the check with the same names in a new order; the rows already there pass it.

### The permission's words and the index

```diff
@@ -73,6 +73,8 @@ const DESCRIPTIONS = {
   'storefront.order.read': "See the online shop's orders, with the buyers' phones and addresses",
   'storefront.order.manage':
     "Move the online shop's orders on (packed, shipped, delivered) and cancel them",
+  'storefront.payout.manage':
+    "Record the couriers' payouts of the shop's cash on delivery money into the bank, and void them",
 } satisfies Record<PermissionKey, string>;
 
 export const PERMISSIONS = PERMISSION_KEYS.map((key) => ({ key, description: DESCRIPTIONS[key] }));
```

```diff
@@ -57,3 +57,4 @@ export * from './storefront-orders.js';
 export * from './storefront-coupons.js';
 export * from './storefront-payments.js';
 export * from './storefront-shipping.js';
+export * from './storefront-payouts.js';
```

No migration grants the new permission to existing roles. The Owner has every key in code (`PermissionService`), and
the role templates (28c.3) give it to new workspaces' Accountant and managers; an owner adds it to an older
workspace's roles in Settings → Roles, as for every permission since step 13.

### Migration 0082 (generated)

```bash
pnpm --filter @omnivo/db generate --name storefront-payouts
```

```sql
CREATE TABLE "storefront_payout_lines" (
	"tenant_id" uuid NOT NULL,
	"payout_id" uuid NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"collected" numeric(19, 4) NOT NULL,
	"charge" numeric(19, 4) NOT NULL,
	"courier_charge" numeric(19, 4),
	"receipt_id" uuid,
	CONSTRAINT "storefront_payout_lines_pkey" PRIMARY KEY("tenant_id","payout_id","shipment_id"),
	CONSTRAINT "storefront_payout_lines_kind_check" CHECK ("storefront_payout_lines"."kind" IN ('cod', 'charge')),
	CONSTRAINT "storefront_payout_lines_amounts_check" CHECK ("storefront_payout_lines"."collected" >= 0 AND "storefront_payout_lines"."collected" = round("storefront_payout_lines"."collected", 2)
        AND "storefront_payout_lines"."charge" >= 0 AND "storefront_payout_lines"."charge" = round("storefront_payout_lines"."charge", 2)
        AND ("storefront_payout_lines"."courier_charge" IS NULL OR ("storefront_payout_lines"."courier_charge" >= 0
          AND "storefront_payout_lines"."courier_charge" = round("storefront_payout_lines"."courier_charge", 2)))),
	CONSTRAINT "storefront_payout_lines_shape_check" CHECK (CASE "storefront_payout_lines"."kind"
          WHEN 'cod' THEN "storefront_payout_lines"."receipt_id" IS NOT NULL AND "storefront_payout_lines"."collected" > 0
          ELSE "storefront_payout_lines"."receipt_id" IS NULL AND "storefront_payout_lines"."collected" = 0 AND "storefront_payout_lines"."charge" > 0
        END)
);
--> statement-breakpoint
CREATE TABLE "storefront_payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"number" text NOT NULL,
	"date" date NOT NULL,
	"courier_account_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"cod_account_id" uuid NOT NULL,
	"charge_account_id" uuid,
	"branch_id" uuid NOT NULL,
	"reference" text,
	"note" text,
	"collected" numeric(19, 4) NOT NULL,
	"charges" numeric(19, 4) NOT NULL,
	"net" numeric(19, 4) NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"void_date" date,
	"void_reason" text,
	CONSTRAINT "storefront_payouts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "storefront_payouts_account_key" UNIQUE("tenant_id","courier_account_id","id"),
	CONSTRAINT "storefront_payouts_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "storefront_payouts_status_check" CHECK ("storefront_payouts"."status" IN ('posted', 'voided')),
	CONSTRAINT "storefront_payouts_amounts_check" CHECK ("storefront_payouts"."collected" >= 0 AND "storefront_payouts"."collected" = round("storefront_payouts"."collected", 2)
        AND "storefront_payouts"."charges" >= 0 AND "storefront_payouts"."charges" = round("storefront_payouts"."charges", 2)
        AND "storefront_payouts"."net" = "storefront_payouts"."collected" - "storefront_payouts"."charges" AND "storefront_payouts"."net" >= 0
        AND ("storefront_payouts"."charges" = 0 OR "storefront_payouts"."charge_account_id" IS NOT NULL)),
	CONSTRAINT "storefront_payouts_accounts_check" CHECK ("storefront_payouts"."bank_account_id" <> "storefront_payouts"."cod_account_id"
        AND ("storefront_payouts"."charge_account_id" IS NULL OR ("storefront_payouts"."charge_account_id" <> "storefront_payouts"."cod_account_id"
          AND "storefront_payouts"."charge_account_id" <> "storefront_payouts"."bank_account_id"))),
	CONSTRAINT "storefront_payouts_text_check" CHECK (("storefront_payouts"."reference" IS NULL OR char_length("storefront_payouts"."reference") BETWEEN 1 AND 60)
        AND ("storefront_payouts"."note" IS NULL OR char_length("storefront_payouts"."note") BETWEEN 1 AND 300)),
	CONSTRAINT "storefront_payouts_void_check" CHECK (("storefront_payouts"."status" = 'voided') = ("storefront_payouts"."void_date" IS NOT NULL AND "storefront_payouts"."void_reason" IS NOT NULL)
        AND ("storefront_payouts"."void_date" IS NULL OR "storefront_payouts"."void_date" >= "storefront_payouts"."date")
        AND ("storefront_payouts"."void_reason" IS NULL OR char_length("storefront_payouts"."void_reason") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_document_check";--> statement-breakpoint
DROP INDEX "storefront_shipments_cod_idx";--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD COLUMN "payout_csv_map" jsonb;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD COLUMN "payout_id" uuid;--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_account_key" UNIQUE("tenant_id","courier_account_id","id");--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_payout_fk" FOREIGN KEY ("tenant_id","courier_account_id","payout_id") REFERENCES "public"."storefront_payouts"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_shipment_fk" FOREIGN KEY ("tenant_id","courier_account_id","shipment_id") REFERENCES "public"."storefront_shipments"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payout_lines" ADD CONSTRAINT "storefront_payout_lines_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_courier_account_fk" FOREIGN KEY ("tenant_id","courier_account_id") REFERENCES "public"."courier_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_bank_account_fk" FOREIGN KEY ("tenant_id","bank_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_cod_account_fk" FOREIGN KEY ("tenant_id","cod_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_charge_account_fk" FOREIGN KEY ("tenant_id","charge_account_id") REFERENCES "public"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_payouts" ADD CONSTRAINT "storefront_payouts_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_payouts_date_idx" ON "storefront_payouts" USING btree ("tenant_id","date","id");--> statement-breakpoint
CREATE INDEX "storefront_payouts_account_idx" ON "storefront_payouts" USING btree ("tenant_id","courier_account_id","date","id");--> statement-breakpoint
ALTER TABLE "storefront_shipments" ADD CONSTRAINT "storefront_shipments_payout_fk" FOREIGN KEY ("tenant_id","courier_account_id","payout_id") REFERENCES "public"."storefront_payouts"("tenant_id","courier_account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storefront_shipments_payable_idx" ON "storefront_shipments" USING btree ("tenant_id","courier_account_id") WHERE "storefront_shipments"."payout_id" IS NULL AND ("storefront_shipments"."receipt_id" IS NOT NULL OR "storefront_shipments"."courier_charge" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "storefront_shipments_payout_idx" ON "storefront_shipments" USING btree ("tenant_id","payout_id") WHERE "storefront_shipments"."payout_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_document_check" CHECK (("journal_entries"."source" IN ('stock_adjustment', 'stock_transfer', 'stock_revaluation', 'sales_delivery', 'sales_return', 'purchase_receipt', 'purchase_return', 'pos_sale', 'pos_return', 'sales_invoice', 'sales_receipt', 'sales_credit_note', 'sales_refund', 'purchase_bill', 'purchase_payment', 'purchase_debit_note', 'purchase_refund', 'pos_shift', 'storefront_payout')) = ("journal_entries"."document_id" IS NOT NULL AND "journal_entries"."document_number" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_payout_csv_map_check" CHECK ("courier_accounts"."payout_csv_map" IS NULL OR (jsonb_typeof("courier_accounts"."payout_csv_map") = 'object'
        AND octet_length("courier_accounts"."payout_csv_map"::text) <= 1024));
```

One line was moved by hand: drizzle-kit wrote `ADD CONSTRAINT "storefront_shipments_account_key"` near the end, after
the lines' foreign key that points at it, and Postgres refuses a foreign key to columns with no unique key yet ("there
is no unique constraint matching given keys"). The line now comes right after `ADD COLUMN "payout_id"`. drizzle-kit
reads its snapshot, not this SQL, so `generate` afterwards still says "No schema changes".

### Migration 0083 (the rules)

```bash
pnpm --filter @omnivo/db generate --custom --name storefront-payouts-rules
```

```sql
-- Custom SQL migration file, put your code below! --
-- Step 28c: the rules of the courier's payout. 0082 made the payouts and their lines, gave each
-- parcel the payout that paid it out and each courier account its saved CSV map; this file gives
-- the two tables their tenant rules and keeps the money right: a parcel is paid out once, by its
-- own receipt's money, and a payout never changes but to be voided.

-- 1) The tenant rules: ENABLE + FORCE RLS + tenant_isolation (with NULLIF, as in 0002). No TO, so
--    it holds for every role. Only omnivo_app uses them (the payout pages): no grant to
--    omnivo_public, omnivo_shop or omnivo_worker, so the shop and the worker cannot read a payout
--    at all. Nothing is written here on purpose. The parcel's new payout_id and the account's
--    payout_csv_map are closed to the shop the same way: it reads those tables by column (0078)
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY['storefront_payouts', 'storefront_payout_lines'])
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

-- 2) A payout (decision 6) is saved posted, never deleted (its number is in the books), and while
--    posted only one thing may happen to it: it is voided (status, the void date and reason, and
--    the version). A voided payout never changes again. As receipts_guard (0030), it compares the
--    whole row without the columns that may move, so a column added later is fixed too
CREATE FUNCTION storefront_payouts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payout % is saved posted', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status = 'voided'
     AND to_jsonb(NEW) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by']
       = to_jsonb(OLD) - ARRAY['status', 'void_date', 'void_reason', 'version', 'updated_at',
                               'updated_by'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payout % can only be voided, once', OLD.id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_immutable';
END;
$$;

CREATE TRIGGER storefront_payouts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_payouts
  FOR EACH ROW EXECUTE FUNCTION storefront_payouts_guard();

-- 3) A payout's line (decisions 4 and 5):
--    - is written with its payout, before its parcels are linked, and never changed or deleted
--      (storefront_payout_lines_immutable). Once a parcel points at the payout, a line added later
--      would be money nobody checked. A voided payout takes no line either
--    - pays the parcel's own money (storefront_payout_lines_parcel_check). A cod line is the
--      parcel's COD receipt, still posted, for exactly what it took in, into the COD account the
--      payout credits: anything else would take money out of the COD account that was never put
--      in. A charge line is a parcel with no COD receipt (a parcel that has one is paid by its
--      receipt, or its money would stay in the COD account for good) whose journey is over:
--      delivered with nothing to collect, partly delivered with ৳0, returned or cancelled. A
--      parcel still on its way may still bring money, so it is not paid out yet
--    The receipt is read FOR SHARE: a void of the same receipt at the same moment waits for this
--    transaction, and then section 6 refuses it; or the void went first, and this read sees it
--    voided. Without the lock both would commit (each saw the other's old row), and the payout
--    would take a voided receipt's money out of the COD account
CREATE FUNCTION storefront_payout_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payout storefront_payouts%ROWTYPE;
  parcel storefront_shipments%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payout % keeps its lines', OLD.payout_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_immutable';
  END IF;
  SELECT * INTO payout FROM storefront_payouts p
  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payout_id;
  IF payout.status <> 'posted' OR EXISTS (
       SELECT 1 FROM storefront_shipments s
       WHERE s.tenant_id = NEW.tenant_id AND s.payout_id = NEW.payout_id) THEN
    RAISE EXCEPTION 'payout % takes no more lines', NEW.payout_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_immutable';
  END IF;
  SELECT * INTO parcel FROM storefront_shipments s
  WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.shipment_id;
  IF NEW.kind = 'cod' THEN
    PERFORM 1 FROM receipts r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.receipt_id
      AND parcel.receipt_id = r.id AND r.status = 'posted' AND r.amount = NEW.collected
      AND r.account_id = payout.cod_account_id
    FOR SHARE;
    IF FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF parcel.receipt_id IS NULL
     AND parcel.status IN ('delivered', 'partly_delivered', 'returned', 'cancelled') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'parcel % is not a % line of payout %', NEW.shipment_id, NEW.kind, NEW.payout_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payout_lines_parcel_check';
END;
$$;

CREATE TRIGGER storefront_payout_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storefront_payout_lines
  FOR EACH ROW EXECUTE FUNCTION storefront_payout_lines_guard();

-- 4) At the end of the transaction that saved or voided it, a payout adds up
--    (storefront_payouts_lines_check): 1 to 500 lines (MAX_PAYOUT_LINES), its collected and
--    charges are the sums of its lines, and its parcels point at it while it is posted, all of
--    them, and none once voided. A check runs per row and cannot see the lines, so this is a
--    constraint trigger deferred to COMMIT, when the API has written the payout, its lines and its
--    parcels in whatever order. "All of them" is a count: section 5 lets a parcel point at a
--    payout only with a line in it, and a payout has one line per parcel (the primary key), so as
--    many parcels as lines means every line's parcel.
--    The row is read again: a deferred trigger gets the row as it was when the event happened, and
--    a payout saved and voided in one transaction would be checked as posted. How many parcels it
--    should have is worked out before the IF, for 0078's reason (PL/pgSQL would take the CASE's
--    own THEN as the IF's)
CREATE FUNCTION storefront_payouts_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  payout storefront_payouts%ROWTYPE;
  line_count integer;
  collected_sum numeric;
  charge_sum numeric;
  linked integer;
  should_link integer;
BEGIN
  SELECT * INTO payout FROM storefront_payouts p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.id;
  SELECT count(*), coalesce(sum(l.collected), 0), coalesce(sum(l.charge), 0)
    INTO line_count, collected_sum, charge_sum
  FROM storefront_payout_lines l
  WHERE l.tenant_id = payout.tenant_id AND l.payout_id = payout.id;
  SELECT count(*) INTO linked
  FROM storefront_shipments s
  WHERE s.tenant_id = payout.tenant_id AND s.payout_id = payout.id;
  should_link := CASE payout.status WHEN 'posted' THEN line_count ELSE 0 END;
  IF line_count NOT BETWEEN 1 AND 500
     OR collected_sum <> payout.collected OR charge_sum <> payout.charges
     OR linked <> should_link THEN
    RAISE EXCEPTION 'payout % does not add up: % lines, % parcels linked', payout.id, line_count,
      linked
      USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_payouts_lines_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER storefront_payouts_check
  AFTER INSERT OR UPDATE ON storefront_payouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION storefront_payouts_check();

-- 5) A parcel's payout (decision 6, storefront_shipments_payout_check): set only from none to a
--    posted payout with a line for this parcel, and cleared only when that payout is voided. Never
--    moved from one payout to another: two payouts at once both lock the row, and the second one
--    then finds it taken (its UPDATE … WHERE payout_id IS NULL matches nothing, and if it did not
--    ask, this refuses it). That the payout is of the parcel's own courier account is 0082's
--    foreign key. Its own trigger, next to 0078's and 0081's, so neither is written again here
CREATE FUNCTION storefront_shipments_payout_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payout_id IS NOT DISTINCT FROM OLD.payout_id THEN
    RETURN NEW;
  END IF;
  IF OLD.payout_id IS NULL THEN
    PERFORM 1
    FROM storefront_payouts p
    JOIN storefront_payout_lines l
      ON l.tenant_id = p.tenant_id AND l.payout_id = p.id AND l.shipment_id = NEW.id
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payout_id AND p.status = 'posted';
    IF FOUND THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.payout_id IS NULL THEN
    PERFORM 1
    FROM storefront_payouts p
    WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.payout_id AND p.status = 'voided';
    IF FOUND THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'parcel % cannot go from payout % to %', OLD.id, OLD.payout_id, NEW.payout_id
    USING ERRCODE = 'check_violation', CONSTRAINT = 'storefront_shipments_payout_check';
END;
$$;

CREATE TRIGGER storefront_shipments_payout_guard
  BEFORE UPDATE OF payout_id ON storefront_shipments
  FOR EACH ROW EXECUTE FUNCTION storefront_shipments_payout_guard();

-- 6) A COD receipt whose parcel a posted payout paid out is not voided (receipts_paid_out, mine
--    26): the payout already took its money out of the COD account, so a void would leave that
--    account below what the courier holds. The payout is voided first, then the receipt. An
--    ordinary receipt has no parcel, so this costs it one look-up by 0080's unique index. Read
--    with a new snapshot (a PL/pgSQL query in READ COMMITTED), so a payout that committed while
--    this void waited for section 3's lock is seen
CREATE FUNCTION receipts_paid_out_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' AND NEW.status = 'voided' AND EXISTS (
       SELECT 1 FROM storefront_shipments s
       WHERE s.tenant_id = OLD.tenant_id AND s.receipt_id = OLD.id AND s.payout_id IS NOT NULL) THEN
    RAISE EXCEPTION 'receipt % was paid out by a courier payout', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receipts_paid_out';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receipts_paid_out_guard
  BEFORE UPDATE OF status ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_paid_out_guard();
```

Section by section:

1. **Tenant rules, and no grant to the shop's roles or the worker.** The payout is the shop's bank money; the shop
   never reads it, and the worker has no payout job (decision 10). The parcel's `payout_id` stays closed to the shop
   because 0078 granted it the parcel's columns one by one.
2. **The payout's guard** compares the whole row as `jsonb` without the columns a void may change, like
   `receipts_guard` (0030). Written that way, a column added in a later step is fixed too, with no change here. An
   insert must be `posted`: "saving posts it" (decision 6) is then true for every path that writes. Because the guard
   runs before the checks, a status like `draft` is refused by the guard; `storefront_payouts_status_check` stays as
   the backstop.
3. **The line's guard.** A line is written before its parcels are linked, and never after: once a parcel points at
   the payout, a new line would be money that no check of the form saw. A cod line must be its parcel's own COD
   receipt, still posted, for exactly its amount, into the COD account this payout credits. A receipt into an older
   COD account is refused here: crediting 1150 for money that sits in 1110 would leave 1150 below zero and 1110 above
   what the courier holds. A charge line must be a parcel with no receipt whose journey is over (mine 30). The
   receipt is read `FOR SHARE`: without it, a payout and a void of the same receipt at the same moment each saw the
   other's old row and both committed (the race below shows it).
4. **The deferred check** (mine 29). A payout, its lines and its parcels are three statements at least, in whatever
   order the API writes them, so a per-row check would see half of it. `DEFERRABLE INITIALLY DEFERRED` runs it at
   COMMIT. It reads the payout again because a deferred trigger is handed the row as it was when the event was queued.
   The `CASE` is worked out before the `IF`, for 0078's reason: inside an `IF` condition PL/pgSQL takes the `CASE`'s
   own `THEN` as the `IF`'s, which is a syntax error.
5. **The parcel's guard.** `payout_id` goes from none to a posted payout that has a line for this parcel, and back to
   none only when that payout is voided. It never moves from one payout to another. Its own trigger, `BEFORE UPDATE OF
   payout_id`, so it costs nothing on the courier's news, which update other columns.
6. **`receipts_paid_out`** (mine 26). Voiding a paid-out COD receipt would reverse money that the payout already moved
   to the bank. The trigger is `BEFORE UPDATE OF status`, so the many receipt updates that only apply money skip it,
   and an ordinary receipt (no parcel) costs one look-up by 28b's unique index.

### Check this part

The checks run on a throwaway Postgres on port 55432 (never `pnpm db:up`: the compose project would reuse your dev
database), with `infra/docker/postgres/init` mounted so the roles exist:

```bash
docker run -d --name omnivo-payouts-pg -p 55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=omnivo -v "$PWD/infra/docker/postgres/init:/docker-entrypoint-initdb.d:ro" postgres:17-alpine
MIGRATOR_DATABASE_URL=postgres://omnivo_migrator:migrator_dev_password@localhost:55432/omnivo \
  pnpm --filter @omnivo/db migrate
pnpm --filter @omnivo/db generate            # "No schema changes, nothing to migrate"
pnpm --filter @omnivo/db typecheck
pnpm boundaries                              # the loop above is allowed (28c.8 found it)
docker rm -f omnivo-payouts-pg
```

What was checked, as `omnivo_app` inside one rolled-back transaction (`SET CONSTRAINTS ALL IMMEDIATE` fires the
deferred check where a COMMIT would):

- A payout of three parcels (two cod lines, one charge line, ৳878 − ৳165 = ৳713) saves, and adds up at COMMIT.
- Every constraint name above refuses its case once: amounts (net, below zero, a third decimal, charges with no
  account), the three accounts, the text limits, the number, another workspace's account, bank and branch, the line's
  kind, shape and amounts, the line's two foreign keys, the parcel's payout guard, the void check.
- The deferred check refuses a payout with no line, with sums that are not its lines', and with a line whose parcel
  never got linked; the same payout with its parcel linked passes.
- A line is refused for a parcel with no receipt, a receipt into the old COD account, the wrong amount, a parcel on
  its way, a charge line on a parcel that has a receipt, and any line once the parcels are linked or the payout is
  voided. No line is changed or deleted.
- A posted payout is not changed, deleted or voided with another column changed; voided with its parcels still
  linked it fails at COMMIT; voided and let go, the parcel is paid out again by a new payout. A voided payout keeps
  its lines and is never posted again.
- A paid-out COD receipt is not voided; once its payout is voided, it is. A voided receipt's parcel is no cod line.
- The journal refuses a `storefront_payout` entry with no document; the older sources work as before.
- The CSV map refuses an array and a 1 KB object.
- Holds' query (`payout_id IS NULL AND receipt_id IS NOT NULL`) uses `storefront_shipments_payable_idx`.
- In another workspace, and with no workspace, no payout is seen; writing into Acme from Beta is refused (RLS).
  `omnivo_shop`, `omnivo_public` and `omnivo_worker` cannot read the payout tables, nor the parcel's `payout_id`.

Three races, each with two `psql` sessions:

- Two payouts take the same parcel: the second waits, its `UPDATE … WHERE payout_id IS NULL` matches nothing, and
  COMMIT refuses it (`storefront_payouts_lines_check`). One payout exists.
- A payout takes a parcel while its receipt is voided: the void waits for the payout's `FOR SHARE`, then
  `receipts_paid_out` refuses it.
- The receipt is voided first: the payout's line waits, then sees the receipt voided
  (`storefront_payout_lines_parcel_check`).

Broken on purpose, each caught:

- The line guard without `FOR SHARE`: both of the last two races commit (a voided receipt's money paid out).
- No deferred check: the checks' "no line" payout passes, and the first race keeps two payouts for one parcel.
- No parcel guard: a parcel moves from one payout to another.
- No `receipts_paid_out` guard: a paid-out receipt is voided.

The API suites that touch receipts, the journal and the COD money still pass on the new migrations (`sales/returns`,
`sales/invoices`, `sales.tenant-leak`, `storefront/shipping/cod` and `couriers`: 108 tests), the last two with the
parcel view's `payout` added by hand for the run, because that line is 28c.3's.

These fail until later parts, on purpose:

- `pnpm --filter @omnivo/api typecheck`: the parcel view (`storefront/shipping/shipments.ts`) has no `payout` yet
  (28c.3). Until then the API answers 500 on any route that returns a parcel.
- `pnpm --filter @omnivo/app typecheck`: the app's parcel mock has no `payout` yet (28c.7).

## 28c.3 — API

The payout's routes (setup, list, one payout, the parcels a new payout can take, the CSV match, save, void), the
entry, the shared CSV reader, and the places outside the payout that change with it: Holds, the parcel card's
payout, the journal's Reverse, a COD receipt's void, the role templates and two new error codes.

### Two more error codes

```diff
@@ -846,6 +846,11 @@ export const ERROR_CODES = [
   'payout_csv_column_required',
   // A payout's entry is undone by voiding the payout on its own page, so its parcels are freed too
   'journal_is_payout',
+  // Step 28c.3: a voided payout can't be voided again (a second tab's click), and a COD receipt
+  // that a posted payout paid out can't be voided (0083's receipts_paid_out): the payout took its
+  // money out of the COD account already, so the payout is voided first
+  'payout_voided',
+  'receipt_paid_out',
 ] as const;
 
 export type ErrorCode = (typeof ERROR_CODES)[number];
```

```diff
@@ -8983,6 +8983,9 @@ export const en = {
     payout_csv_column_required: 'Pick the column.',
     journal_is_payout:
       'A courier payout’s entry can’t be reversed here. Void the payout on its own page: that frees its parcels too.',
+    payout_voided: 'This payout is voided and can no longer change. Reload the page.',
+    receipt_paid_out:
+      'A courier payout paid this COD money out to the bank. Void the payout first, then this receipt.',
   } satisfies Record<ErrorCode, string>,
   ui: {
     dataTable: {
```

```diff
@@ -8323,6 +8323,9 @@ export const bn: Messages = {
     payout_csv_column_required: 'কলামটা বাছুন।',
     journal_is_payout:
       'কুরিয়ার পেআউটের এন্ট্রি এখানে রিভার্স করা যায় না। পেআউটের নিজের পেজে বাতিল করুন: তাতে তার পার্সেলগুলোও ছাড়া পায়।',
+    payout_voided: 'এই পেআউট বাতিল হয়েছে, এটা আর বদলানো যায় না। পেজটা রিলোড করুন।',
+    receipt_paid_out:
+      'একটা কুরিয়ার পেআউট এই COD-র টাকা ব্যাংকে তুলে দিয়েছে। আগে পেআউটটা বাতিল করুন, তারপর এই রিসিট।',
   },
   ui: {
     dataTable: {
```

- **`payout_voided`** (mine 33) is the payout's own "already voided", like `refund_voided`. A second tab that voids
  the same payout gets it; without it the answer would be the version conflict, which says "someone changed it"
  when the truth is "it is voided".
- **`receipt_paid_out`** is 28c.2's `receipts_paid_out` rule as the API says it (mine 26). The words say what to do
  first, because a member on a receipt's page cannot see the payout that holds it.

### The CSV reader, shared

```ts
import { CsvError, parse } from 'csv-parse/sync';

// Step 28c (decision 10): reading a CSV file, shared by the product import (step 12) and the
// courier's payout match. Only the parts both need: bytes to text, and text to rows of cells.
// What a column means stays with each caller.

// Bytes → text. Excel's "CSV UTF-8" starts with a byte order mark; its plain "CSV" on Windows is
// not UTF-8 at all, and a Bangla name would come out as question marks. fatal: true refuses such a
// file instead of reading broken names.
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// Text → rows of trimmed cells, the header first. null when it is not a CSV at all (a quote never
// closed, say). relax_column_count: Excel leaves trailing empty cells out of short rows. bom: drop
// the byte order mark, which a browser's FileReader keeps in the text it reads.
export function readCsvRecords(text: string): string[][] | null {
  try {
    return parse(text, { bom: true, trim: true, relax_column_count: true });
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return null;
  }
}
```

```diff
@@ -14,7 +14,8 @@ import {
   productInputSchema,
   type TrackingMode,
 } from '@omnivo/contracts';
-import { CsvError, parse } from 'csv-parse/sync';
+
+import { decodeUtf8, readCsvRecords } from '../../common/csv/csv.js';
 
 // The CSV half of an import, without the database: bytes in, product inputs (or what is wrong)
 // out. Pure, so every rule is tested on its own (csv.spec.ts) without containers.
@@ -52,17 +53,6 @@ function fileError(code: ErrorCode, params?: Record<string, string | number>): P
   return { row: null, column: null, code, ...(params && { params }) };
 }
 
-// Bytes → text. Excel's "CSV UTF-8" starts with a byte order mark; its plain "CSV" on Windows is
-// not UTF-8 at all, and a Bangla name would come out as question marks. fatal: true refuses such a
-// file instead of importing broken names.
-function decode(bytes: Uint8Array): string | null {
-  try {
-    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
-  } catch {
-    return null;
-  }
-}
-
 // The cells of the columns that describe the product, not one variant: in a product's later rows
 // they are empty or the same as in its first row
 const PRODUCT_COLUMNS = new Set<string>([
@@ -153,15 +143,11 @@ const YES = new Set(['yes', 'y', 'true', '1']);
 const NO = new Set(['no', 'n', 'false', '0']);
 
 export function readProductsCsv(bytes: Uint8Array, lookups: ImportLookups): ReadFile {
-  const text = decode(bytes);
+  // Step 28c: the two reading steps moved to common/csv/csv.ts, for the payout match
+  const text = decodeUtf8(bytes);
   if (text === null) return { products: [], errors: [fileError('import_encoding')], rowCount: 0 };
-
-  let records: string[][];
-  try {
-    // relax_column_count: Excel leaves trailing empty cells out of short rows. bom: drop the BOM.
-    records = parse(text, { bom: true, trim: true, relax_column_count: true });
-  } catch (error) {
-    if (!(error instanceof CsvError)) throw error;
+  const records = readCsvRecords(text);
+  if (records === null) {
     return { products: [], errors: [fileError('import_csv_malformed')], rowCount: 0 };
   }
 
```

Decision 10 says the payout reads its file with the product import's reader. Only the two steps both need move:
bytes to text, and text to rows. What a column means stays with each caller, because the product import's columns
are fixed names and the payout's are whatever the courier wrote.

- **`readCsvRecords` returns `null` instead of throwing.** The import turns it into `import_csv_malformed` and the
  match into `payout_csv_unreadable`; a thrown `CsvError` would make each caller catch the library's own class.
  Any other error still throws: it is a bug, not a bad file.
- **`bom: true` matters more for the payout.** The browser reads the file with `FileReader.readAsText`, which keeps
  the byte order mark that Excel writes. Without `bom: true` the first header would be `﻿Invoice`, and the
  preset's `Invoice` would never be found.
- The payout sends text, not bytes, so it does not use `decodeUtf8`. The browser has already decoded the file; a
  file that is not UTF-8 shows its broken characters in the mapping step's selects, where the member sees them.

### Matching the file, without the database

```ts
import {
  compareMoney,
  type DocumentRef,
  type ErrorCode,
  isZeroMoney,
  MAX_PAYOUT_CSV_ROWS,
  type PayoutCsvKey,
  type PayoutCsvMap,
  type PayoutLineKind,
  type PayoutMatchRow,
  type ReceiptStatus,
  type ShipmentStatus,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';

import { readCsvRecords } from '../../common/csv/csv.js';

// Step 28c (decisions 10–12, mine 18 and 19): the courier's payout CSV against the account's
// parcels, without the database. Text in, one answer per row out. Pure, so every rule is tested
// on its own (payout-match.spec.ts) without containers; PayoutsService reads the parcels the keys
// name and saves the map.

// The file, read: its header and its rows of cells, each with its line number in the file
export interface PayoutCsv {
  header: string[];
  rows: { row: number; cells: string[] }[];
}

// What a key found on our side, as PayoutsService read it
export type MatchParcel =
  // A parcel a new payout can take, and what it would take out of the COD account ('0' for a
  // charge line)
  | { state: 'payable'; shipmentId: string; collected: string }
  // In a posted payout already
  | { state: 'paid'; shipmentId: string; payout: DocumentRef }
  // Ours, but not payable yet (on its way, no receipt, a receipt into another COD account)
  | { state: 'not_ready'; shipmentId: string };

export interface PayoutMatchResult {
  rows: PayoutMatchRow[];
  fileNet: string | null;
}

// A header wider than the contract's 200 columns is no courier's payout file
const MAX_COLUMNS = 200;

// The text the browser read, as a header and rows, or why it cannot be read. A row of empty cells
// (Excel writes a few at the end) is skipped, keeping the numbers: the header is row 1, so record
// i is row i + 1, as the spreadsheet shows it
export function readPayoutCsv(text: string): PayoutCsv | ErrorCode {
  const records = readCsvRecords(text);
  const header = records?.[0];
  if (records === null || header === undefined || header.every((cell) => cell === '')) {
    return 'payout_csv_unreadable';
  }
  if (header.length > MAX_COLUMNS) return 'payout_csv_unreadable';
  const rows = records
    .slice(1)
    .flatMap((cells, index) =>
      cells.every((cell) => cell === '') ? [] : [{ row: index + 2, cells }],
    );
  if (rows.length > MAX_PAYOUT_CSV_ROWS) return 'payout_csv_too_many_rows';
  return { header, rows };
}
```

- **A pure module.** Every rule here (which row is which outcome, what counts as an amount, the file's net) can be
  tested without containers (28c.4). `PayoutsService` only reads the parcels the file's keys name and saves the map.
- **`MatchParcel` is a union of three states,** so `matchPayoutCsv` cannot read `collected` from a parcel that is
  not payable: TypeScript narrows it by `state`.
- **`readPayoutCsv` returns the error code or the file.** The contract caps the text at 1,000,000 characters; the
  rows are counted here (`payout_csv_too_many_rows`), after empty rows are dropped, so Excel's trailing empty rows
  never count against the limit.
- **Row numbers keep their gaps.** The header is row 1, so record `i` is row `i + 1`, as the spreadsheet shows it.
  A member who reads "row 14: unknown" finds row 14 in Excel, even when row 9 was empty.
- **A header with every cell empty, or wider than 200 columns, is unreadable.** The contract's `columns` holds at
  most 200, and no courier's payout file has that many; it is a different file.

```ts
// The position of each mapped column in the header, by its name. Case is ignored: the preset is a
// guess (decision 11), and "COD amount" for "COD Amount" should not cost a mapping. The first
// column of that name wins, as a spreadsheet's lookup would take it
interface Positions {
  key: number;
  collected: number | null;
  charge: number | null;
}

function positionOf(header: readonly string[], name: string): number {
  const wanted = name.toLowerCase();
  return header.findIndex((cell) => cell.toLowerCase() === wanted);
}

// The map's column names the file does not have (mine 18). Empty: every mapped column is there
export function missingColumns(header: readonly string[], map: PayoutCsvMap): string[] {
  return [map.keyColumn, map.collectedColumn, map.chargeColumn].filter(
    (name): name is string => name !== null && positionOf(header, name) === -1,
  );
}

function positionsOf(header: readonly string[], map: PayoutCsvMap): Positions {
  const optional = (name: string | null) => (name === null ? null : positionOf(header, name));
  return {
    key: positionOf(header, map.keyColumn),
    collected: optional(map.collectedColumn),
    charge: optional(map.chargeColumn),
  };
}

// A money cell as a courier writes it: "1,250", "1250.50", "৳ 1,250", "Tk 80". Only the grouping
// commas, the taka sign and its spellings, and spaces are dropped; anything else (a minus, a third
// decimal, "N/A") is not an amount, so the row is invalid rather than read wrongly. An empty cell
// is an amount of null: the file says nothing about this parcel
const AMOUNT = /^\d{1,15}(?:\.\d{1,2})?$/;

export type CellAmount = { valid: true; amount: string | null } | { valid: false };

const NONE: CellAmount = { valid: true, amount: null };

export function readAmount(cell: string): CellAmount {
  const plain = cell.replace(/,|৳|tk\.?|bdt|\s/gi, '');
  if (plain === '') return { valid: true, amount: null };
  // sumMoney writes it the way the API writes every amount: 4 decimals ("1250.5000")
  return AMOUNT.test(plain) ? { valid: true, amount: sumMoney([plain]) } : { valid: false };
}

// The keys the file names, for PayoutsService's one read of the parcels: the key column's cells,
// trimmed (csv-parse trims them), never empty, each once
export function keysOf(csv: PayoutCsv, map: PayoutCsvMap): string[] {
  const at = positionOf(csv.header, map.keyColumn);
  const keys = new Set<string>();
  for (const { cells } of csv.rows) {
    const key = cells[at] ?? '';
    if (key !== '') keys.add(key);
  }
  return [...keys];
}
```

- **Column names are compared without case** (mine 35). The preset is a guess (decision 11). If Steadfast writes
  "COD amount" and the preset says "COD Amount", ignoring case saves a mapping step. Two columns that differ only
  by case are not something a courier writes; the first one wins.
- **`missingColumns` names the map's columns the file does not have.** The match route answers them with no rows
  (mine 18), and the dialog shows the mapping step with the file's own columns.
- **`readAmount` drops only commas, the taka sign, "Tk", "BDT" and spaces.** Everything else that is not a plain
  amount with at most 2 decimals is `invalid`: a minus sign, "N/A", a third decimal. Reading "-80" as 80, or
  "1.005" as 1.01, would put a wrong number next to a parcel and look like a fact.
- **`CellAmount` is a small union, not `string | null | 'invalid'`.** In that union `'invalid'` is just another
  string, so TypeScript could not stop the code from using it as an amount (ESLint's
  `no-redundant-type-constituents` says so too).
- **An empty cell is "no amount", not 0.** A courier's file may leave the charge empty on a row it did not charge
  yet; reading it as ৳0 would make the row look different from our figure.
- **`keysOf` gives each key once,** for one database read with `IN (…)`. 5,000 rows are 5,000 parameters at most,
  well under Postgres's limit of 65,535.

```ts
// Every row of the file, accounted for (mine 19). Keys are compared exactly: our invoice
// (W-000123) and the courier's tracking code and id are written by machines on both sides, and a
// looser compare could match one parcel's row to another's
export function matchPayoutCsv(
  csv: PayoutCsv,
  map: PayoutCsvMap,
  parcels: ReadonlyMap<string, MatchParcel>,
): PayoutMatchResult {
  const at = positionsOf(csv.header, map);
  const seen = new Set<string>();
  const rows: PayoutMatchRow[] = [];
  const collectedOnFile: string[] = [];
  const chargesOnFile: string[] = [];
  for (const { row, cells } of csv.rows) {
    const key = cells[at.key] ?? '';
    // A column the map leaves out reads like an empty cell
    const collectedCell = at.collected === null ? NONE : readAmount(cells[at.collected] ?? '');
    const chargeCell = at.charge === null ? NONE : readAmount(cells[at.charge] ?? '');
    const base = {
      row,
      key,
      shipmentId: null,
      payout: null,
      fileCollected: null,
      fileCharge: null,
    };
    if (key === '' || !collectedCell.valid || !chargeCell.valid) {
      rows.push({ ...base, outcome: 'invalid' });
      continue;
    }
    const collected = collectedCell.amount;
    const charge = chargeCell.amount;
    const amounts = { fileCollected: collected, fileCharge: charge };
    // Only the first row of a key counts: a second one would pay the parcel twice
    if (seen.has(key)) {
      rows.push({ ...base, ...amounts, outcome: 'twice' });
      continue;
    }
    seen.add(key);
    const parcel = parcels.get(key);
    if (parcel === undefined) {
      rows.push({ ...base, ...amounts, outcome: 'unknown' });
      continue;
    }
    if (parcel.state === 'paid') {
      rows.push({ ...base, ...amounts, outcome: 'already_paid', payout: parcel.payout });
      continue;
    }
    if (parcel.state === 'not_ready') {
      rows.push({ ...base, ...amounts, outcome: 'not_ready', shipmentId: parcel.shipmentId });
      continue;
    }
    // Our figure is the posted COD receipt's (decision 5): a file that says otherwise is shown,
    // never believed. An empty cell says nothing, so it is no difference
    const different = collected !== null && compareMoney(collected, parcel.collected) !== 0;
    rows.push({
      ...base,
      ...amounts,
      outcome: different ? 'different' : 'matched',
      shipmentId: parcel.shipmentId,
    });
    collectedOnFile.push(collected ?? '0');
    chargesOnFile.push(charge ?? '0');
  }
  // What the file says reached the bank for the rows this payout can take, only when the file
  // has both amounts: with one of them the sum would be a guess
  const fileNet =
    map.collectedColumn === null || map.chargeColumn === null
      ? null
      : subtractMoney(sumMoney(collectedOnFile), sumMoney(chargesOnFile));
  return { rows, fileNet };
}
```

- **Every row gets one outcome** (mine 19), in this order: `invalid` (an empty key, or an amount that is not an
  amount), `twice` (the key was already on an earlier row), `unknown`, `already_paid`, `not_ready`, then
  `matched` or `different`. `invalid` comes first because a row with a broken amount cannot be trusted for
  anything else.
- **Keys are compared exactly.** Our invoice (`W-000123`) and the courier's tracking code and id are written by
  machines on both sides. A loose compare (case, spaces inside) could match one parcel's row to another parcel.
- **Only the first row of a key counts.** A second row of the same parcel would pay it twice. Showing it as `twice`,
  not dropping it, lets the member see that the courier's file has a mistake.
- **`different` only compares what was collected.** Our figure is the posted COD receipt (decision 5); the file's
  is shown next to it, never believed. A difference in the charge is not a difference: the charge is what the
  member checks and types anyway.
- **`fileNet` needs both amount columns,** and sums only the rows this payout can take (`matched` and `different`).
  With one column it would be a guess. The member holds it against the bank statement.

```ts
// What a parcel must be for a payout to take it (decision 4, mine 30), from the columns
// PayoutsService reads. The same rule for the new payout's list, the match and the save, so a
// parcel the list offers is one the save takes:
// - cod: its COD receipt is posted and went into the account's COD account now. A voided receipt
//   keeps its link (28b), and its money is no longer in the account; a receipt into an older COD
//   account is in that account, which this payout does not credit (0083 refuses it too)
// - charge: no receipt, nothing collected, the journey over, and a charge the courier said. A
//   parcel delivered with cash and no receipt (the account had no COD account then) is neither:
//   its cash was typed by hand, so the courier's charge for it is no charge line of ours
// null: not payable now. Whether a posted payout took it already is the caller's question
export interface PayableParcel {
  status: ShipmentStatus;
  receiptId: string | null;
  receiptStatus: ReceiptStatus | null;
  receiptAccountId: string | null;
  collectedAmount: string | null;
  courierCharge: string | null;
}

const JOURNEY_OVER: readonly ShipmentStatus[] = [
  'delivered',
  'partly_delivered',
  'returned',
  'cancelled',
];

export function payoutKindOf(
  parcel: PayableParcel,
  codAccountId: string | null,
): PayoutLineKind | null {
  if (parcel.receiptId !== null) {
    return parcel.receiptStatus === 'posted' &&
      codAccountId !== null &&
      parcel.receiptAccountId === codAccountId
      ? 'cod'
      : null;
  }
  const charged = parcel.courierCharge !== null && compareMoney(parcel.courierCharge, '0') > 0;
  const noCash = parcel.collectedAmount === null || isZeroMoney(parcel.collectedAmount);
  return charged && noCash && JOURNEY_OVER.includes(parcel.status) ? 'charge' : null;
}

// The parcel column a key names, for the read in PayoutsService
export const KEY_COLUMN = {
  invoice: 'invoice',
  tracking_code: 'trackingCode',
  consignment_id: 'consignmentId',
} as const satisfies Record<PayoutCsvKey, 'invoice' | 'trackingCode' | 'consignmentId'>;
```

- **One rule for three places.** The new payout's list, the match and the save all ask `payoutKindOf`. If the list
  used one rule and the save another, a parcel the page offered could be refused when saved.
- **A cod line needs a posted receipt into the account's COD account now.** A voided receipt keeps its link (28b),
  but its money left the COD account when it was voided. A receipt into an older COD account is in that older
  account, and this payout credits the new one (0083 refuses it too).
- **A charge line needs nothing collected** (mine 34). A parcel delivered with cash but no receipt (its account had
  no COD account then, 28b's decision 2) had its cash typed by hand somewhere else. Its courier charge is not money
  this COD account owes, so it is not offered as a charge line.
- **A charge line needs a charge the courier said, above zero.** A manual account's parcels never get a
  `courier_charge` (no courier's news), so a manual account's returned parcel is never a charge line. Its charge can
  still be paid: the member adds it to another line's charge, which the form allows.
- **`JOURNEY_OVER`** is the same list as 0083's line guard. A parcel still on its way may still bring cash.
- **`KEY_COLUMN` is a `Record` over the contract's keys,** checked with `satisfies`. A fourth key added to
  `PAYOUT_CSV_KEYS` fails to compile here until it names its column.

### The payout's entry

```ts
import { Injectable } from '@nestjs/common';
import { type EntryRef, isZeroMoney } from '@omnivo/contracts';
import { journalEntries, journalLines } from '@omnivo/db';
import { and, asc, eq } from 'drizzle-orm';

import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { type LineInput, PostingService } from '../../journal/posting.service.js';

// What the entry needs from the payout: the accounts it copied, its branch and its three sums
export interface PayoutPosting {
  branchId: string;
  bankAccountId: string;
  codAccountId: string;
  chargeAccountId: string | null;
  collected: string;
  charges: string;
  net: string;
}

function line(accountId: string, branchId: string, debit: string, credit: string): LineInput {
  return { accountId, branchId, partyId: null, description: null, debit, credit };
}

// A found entry as a reference; a posted entry always has its number
function toRef(entry: { id: string; number: string | null }): EntryRef {
  if (entry.number === null) throw new Error('A posted entry has no number');
  return { id: entry.id, number: entry.number };
}

// Step 28c: the journal half of a courier's payout (decision 3), like SalesBooksService for the
// sales documents: it builds the entry and posts it through the journal's PostingService, inside
// the payout's own transaction, so the payout, its parcels and the books change together or not at
// all. Its own class, not a method on SalesBooksService: the payout is no sales document, and its
// source is the storefront group's (mine 23), which the journal's Reverse refuses on its own.
@Injectable()
export class PayoutBooks {
  constructor(private readonly posting: PostingService) {}

  // Dr the bank for what reached it / Dr the charges account for the courier's charges / Cr the COD
  // account for what the riders collected, every line with the payout's branch. A side of ৳0 has no
  // line: a payout whose charges ate all the cash has no bank line (decision 3), and one with no
  // charges has no charges line. The collected side is never 0: with nothing collected the net is
  // below zero, which create() refuses first
  async post(
    tx: Transaction,
    document: { id: string; number: string; date: string },
    input: PayoutPosting,
  ): Promise<EntryRef> {
    const lines: LineInput[] = [];
    if (!isZeroMoney(input.net)) {
      lines.push(line(input.bankAccountId, input.branchId, input.net, '0'));
    }
    if (!isZeroMoney(input.charges)) {
      if (input.chargeAccountId === null) throw new Error('A payout with charges has no account');
      lines.push(line(input.chargeAccountId, input.branchId, input.charges, '0'));
    }
    lines.push(line(input.codAccountId, input.branchId, '0', input.collected));
    const entry = await this.posting.postNew(tx, {
      date: document.date,
      narration: `Courier payout ${document.number}`,
      source: 'storefront_payout',
      document: { id: document.id, number: document.number },
      lines,
    });
    return toRef(entry);
  }

  // The payout's own entry. Posted: a reversal leaves it posted, and has its own source
  async entryOf(tx: Transaction, payoutId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, getTenantId()),
          eq(journalEntries.documentId, payoutId),
          eq(journalEntries.source, 'storefront_payout'),
          eq(journalEntries.status, 'posted'),
        ),
      );
    return row === undefined ? null : toRef(row);
  }

  // The reversal of the payout's entry, once it is voided
  async reversalOf(tx: Transaction, entryId: string): Promise<EntryRef | null> {
    const [row] = await tx
      .select({ id: journalEntries.id, number: journalEntries.number })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, getTenantId()), eq(journalEntries.reversalOfId, entryId)),
      );
    return row === undefined ? null : toRef(row);
  }

  // A voided payout: the journal's own reversal of its entry (source 'reversal', pointing back at
  // it), dated the void date, the same lines with debit and credit swapped, as a voided receipt's.
  // The COD account gets the money back, so Holds counts the parcels again once they are freed
  async reverse(
    tx: Transaction,
    entry: EntryRef,
    input: { date: string; narration: string },
  ): Promise<EntryRef> {
    const lines = await tx
      .select({
        accountId: journalLines.accountId,
        branchId: journalLines.branchId,
        partyId: journalLines.partyId,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
      })
      .from(journalLines)
      .where(and(eq(journalLines.tenantId, getTenantId()), eq(journalLines.entryId, entry.id)))
      .orderBy(asc(journalLines.lineNo));
    const posted = await this.posting.postNew(tx, {
      date: input.date,
      narration: input.narration,
      source: 'reversal',
      reversalOfId: entry.id,
      lines: lines.map((row) => ({ ...row, debit: row.credit, credit: row.debit })),
    });
    return toRef(posted);
  }
}
```

- **Its own class, not a method on `SalesBooksService`.** The payout is not a sales document, and
  `SalesBooksService.entryOf` takes only sales sources. `PurchaseBooksService` has its own copy of `reverse` for the
  same reason; the 20 lines are cheaper than a shared base class every books service would have to follow.
- **A side of ৳0 has no line.** The journal refuses a line that is zero on both sides. A payout whose charges ate all
  its cash has no bank line (decision 3), and one with no charges has no charges line.
- **The collected side is never ৳0:** with nothing collected, `net` is below zero, and `create` refuses that before
  it posts. So the entry always has at least two lines.
- **Every line names the payout's branch.** The profit and loss by branch then shows the courier's charges where
  the shop's sales were made.
- **No party on any line.** The COD account, the bank and the charges account are not kept per customer or
  supplier, so the journal's party rule (step 15a) wants none.
- **`entryOf` looks for `status = 'posted'`,** like the receipt's. A reversal keeps the original entry posted, and the
  reversal has its own source (`reversal`), so the payout has exactly one entry with its source.

### The service

```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  type CourierProvider,
  type ErrorCode,
  isNegativeMoney,
  type Payout,
  type PayoutAccount,
  type PayoutCsvMap,
  payoutCsvMapSchema,
  type PayoutCsvKey,
  type PayoutInput,
  type PayoutLine,
  type PayoutLineKind,
  type PayoutMatch,
  type PayoutMatchInput,
  type PayoutParcel,
  type PayoutParcels,
  type PayoutSetup,
  type PayoutStatus,
  type PayoutSummary,
  STEADFAST_PAYOUT_CSV_PRESET,
  type StorefrontAccountChoice,
  subtractMoney,
  sumMoney,
  type VoidPayoutInput,
} from '@omnivo/contracts';
import {
  courierAccounts,
  ledgerAccounts,
  receipts,
  storefrontOrders,
  storefrontPayoutLines,
  storefrontPayouts,
  storefrontSettings,
  storefrontShipments,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../../common/audit/audit.js';
import { isCheckViolation } from '../../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../../common/http/app-error.js';
import { decodeCursor, toPage } from '../../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { NumberingService } from '../../numbering/numbering.service.js';
import { chartOf } from '../admin/payment-gateway.service.js';
import { holdsOf } from '../shipping/courier-accounts.service.js';
import { PayoutBooks } from './payout-books.js';
import {
  KEY_COLUMN,
  keysOf,
  type MatchParcel,
  matchPayoutCsv,
  missingColumns,
  payoutKindOf,
  readPayoutCsv,
} from './payout-match.js';

type PayoutRow = typeof storefrontPayouts.$inferSelect;
type AccountRow = typeof courierAccounts.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The map a file is read with when the member gave none and the account has none saved (mine 18).
// A manual account's courier is any of five, so there is nothing to guess: its first file always
// shows the mapping step
const PRESET = {
  steadfast: STEADFAST_PAYOUT_CSV_PRESET,
  manual: null,
} as const satisfies Record<CourierProvider, PayoutCsvMap | null>;

// The saved map, read with today's schema: a map an older shape saved reads as none, so the
// mapping step shows instead of the match failing (28c.2)
function savedMapOf(row: AccountRow): PayoutCsvMap | null {
  const parsed = payoutCsvMapSchema.safeParse(row.payoutCsvMap);
  return parsed.success ? parsed.data : null;
}

function sameMap(a: PayoutCsvMap, b: PayoutCsvMap | null): boolean {
  return (
    b !== null &&
    a.key === b.key &&
    a.keyColumn === b.keyColumn &&
    a.collectedColumn === b.collectedColumn &&
    a.chargeColumn === b.chargeColumn
  );
}

// An error the form shows under one box, or under several lines' boxes (lines.2.shipmentId)
function boxError(code: ErrorCode, fields: readonly string[], message: string): AppError {
  return new AppError(422, code, message, {
    fieldErrors: Object.fromEntries(fields.map((field) => [field, [code]])),
  });
}

function unavailable(indexes: readonly number[]): AppError {
  return new AppError(
    409,
    'payout_parcel_unavailable',
    'A parcel cannot be paid out any more. Reload the parcels.',
    {
      fieldErrors: Object.fromEntries(
        indexes.map((index) => [
          `lines.${String(index)}.shipmentId`,
          ['payout_parcel_unavailable'],
        ]),
      ),
    },
  );
}

// The database's last word when two payouts took the same parcel at once, or its receipt was
// voided a moment ago (0083): the second one's UPDATE found the parcel taken and COMMIT refused
// the payout, or the line's guard found the receipt voided. The form knows one answer for both:
// reload the parcels
function parcelRace(error: unknown): unknown {
  if (
    isCheckViolation(error, 'storefront_payouts_lines_check') ||
    isCheckViolation(error, 'storefront_payout_lines_parcel_check') ||
    isCheckViolation(error, 'storefront_shipments_payout_check')
  ) {
    return unavailable([]);
  }
  return error;
}

// A parcel as the three reads need it: its keys, its state and its receipt
const parcelColumns = {
  id: storefrontShipments.id,
  orderId: storefrontShipments.orderId,
  orderNo: storefrontOrders.orderNo,
  invoice: storefrontShipments.invoice,
  trackingCode: storefrontShipments.trackingCode,
  consignmentId: storefrontShipments.consignmentId,
  status: storefrontShipments.status,
  collectedAmount: storefrontShipments.collectedAmount,
  courierCharge: storefrontShipments.courierCharge,
  lastSyncedAt: storefrontShipments.lastSyncedAt,
  payoutId: storefrontShipments.payoutId,
  receiptId: storefrontShipments.receiptId,
  receiptNumber: receipts.number,
  receiptStatus: receipts.status,
  receiptAccountId: receipts.accountId,
  receiptAmount: receipts.amount,
  receiptDate: receipts.date,
};
```

- **`PRESET` is a `Record` over the providers** (mine 18). A third provider (Pathao in 28d) fails to compile until it
  says its preset or `null`.
- **`savedMapOf` parses the stored `jsonb` with today's schema.** A map saved by an older shape reads as none, so the
  member sees the mapping step instead of an error (28c.2).
- **`unavailable` marks every line at once** (`lines.3.shipmentId`). A member who ticked 200 parcels sees which ones
  went, not only that something did.
- **`parcelRace` maps 0083's three rules to `payout_parcel_unavailable`.** Each one fires only in a race (another
  payout took the parcel, or its receipt was voided a moment ago) or when this code is wrong. The form has one
  answer for all of them: reload the parcels.
- **`parcelColumns`** is one select shape for the list, the save and the match, so `payoutKindOf` always gets the
  same columns.

```ts
// Step 28c (decisions 2–12): Storefront → Shop payouts. Every route needs
// storefront.payout.manage (the contract says so and the guard checks it). A payout is posted when
// it is saved and voided on its own page, like a money receipt; its parcels are locked while it is
// made, and 0083's rules are the last word on every one of them.
@Injectable()
export class PayoutsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly books: PayoutBooks,
  ) {}

  // The pages' one read of choices (mine 16): every courier account, archived ones last (an
  // archived account's parcels can still be paid out), and the bank accounts a payout may go into
  setup(): Promise<PayoutSetup> {
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(courierAccounts)
        .where(eq(courierAccounts.tenantId, getTenantId()))
        .orderBy(
          sql`${courierAccounts.archivedAt} IS NOT NULL`,
          asc(courierAccounts.name),
          asc(courierAccounts.id),
        );
      const chart = await chartOf(tx);
      return {
        accounts: await this.toAccounts(tx, rows),
        bankAccounts: chart.moneyAccounts,
      };
    });
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: PayoutStatus | undefined;
    accountId?: string | undefined;
  }): Promise<{ items: PayoutSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(storefrontPayouts.status, query.status),
          query.accountId === undefined
            ? undefined
            : eq(storefrontPayouts.courierAccountId, query.accountId),
          after === undefined
            ? undefined
            : sql`(${storefrontPayouts.date}, ${storefrontPayouts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.payout.date, last.payout.id]);
      return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<Payout> {
    return this.withTenant((tx) => this.read(tx, id));
  }
```

- **`setup` lists archived courier accounts too, last** (mine 16). An archived account still holds the money of
  its last parcels, and only a payout takes it out.
- **The bank choices are `chartOf`'s money accounts:** the same list the COD account select offers, read the same
  way. The form leaves out the chosen account's own COD account; `create` refuses it anyway.
- **The list pages by `(date, id)`, newest first,** like the refunds. A cursor of the date alone would skip payouts
  with the same date.

```ts
  // The new payout page's list: the account's parcels a payout can take now, oldest receipt first
  // (the courier pays the oldest first), the charge lines after them
  parcels(accountId: string): Promise<PayoutParcels> {
    return this.withTenant(async (tx) => {
      const row = await this.findAccount(tx, accountId, null);
      if (row === null) throw notFound('Courier account');
      const [account] = await this.toAccounts(tx, [row]);
      if (account === undefined) throw notFound('Courier account');
      // storefront_shipments_payable_idx's own condition, so the read stays on that index however
      // many parcels the shop has sent; payoutKindOf() then keeps the ones a payout takes now
      const candidates = await this.parcelRows(
        tx,
        and(
          eq(storefrontShipments.courierAccountId, row.id),
          isNull(storefrontShipments.payoutId),
          or(
            sql`${storefrontShipments.receiptId} IS NOT NULL`,
            sql`${storefrontShipments.courierCharge} IS NOT NULL`,
          ),
        ),
      );
      const parcels = candidates.flatMap((parcel): PayoutParcel[] => {
        const kind = payoutKindOf(parcel, row.codAccountId);
        return kind === null ? [] : [toParcel(parcel, kind)];
      });
      parcels.sort(
        (a, b) =>
          (a.receiptDate ?? '9999-12-31').localeCompare(b.receiptDate ?? '9999-12-31') ||
          a.invoice.localeCompare(b.invoice),
      );
      return { account, parcels, csvMap: savedMapOf(row) };
    });
  }
```

- **The read uses `storefront_shipments_payable_idx`'s own condition** (`payout_id IS NULL AND (receipt_id IS NOT
  NULL OR courier_charge IS NOT NULL)`), so Postgres reads only the unpaid parcels, however many the shop has sent.
  `payoutKindOf` then keeps the ones a payout takes now.
- **Oldest receipt first, charge lines last.** A courier pays the oldest parcels first, so the member ticks from the
  top. The sort is in JavaScript: the list is one account's unpaid parcels, a few hundred at most.

```ts
  // The courier's file against the account's parcels (decisions 10–12, mine 18 and 19). Nothing is
  // written but the map, and only a map the member gave, once the file had all its columns: a map
  // that found nothing should not replace one that works
  match(accountId: string, input: PayoutMatchInput): Promise<PayoutMatch> {
    const csv = readPayoutCsv(input.csv);
    if (typeof csv === 'string') {
      throw boxError(csv, ['csv'], 'This file cannot be read as a payout CSV.');
    }
    return this.withTenant(async (tx) => {
      const row = await this.findAccount(tx, accountId, null);
      if (row === null) throw notFound('Courier account');
      const saved = savedMapOf(row);
      const map = input.map ?? saved ?? PRESET[row.provider];
      // The mapping step's choices: the header's names, without the empty ones
      const columns = csv.header.filter((name) => name !== '');
      if (map === null) return { columns, map: null, missing: [], rows: [], fileNet: null };
      const missing = missingColumns(csv.header, map);
      if (missing.length > 0) return { columns, map, missing, rows: [], fileNet: null };
      if (input.map !== null && !sameMap(input.map, saved)) {
        // No version bump and no audit (mine 21): a map moves no money, and a member editing the
        // account at the same time must not get a conflict for it
        await tx
          .update(courierAccounts)
          .set({ payoutCsvMap: input.map })
          .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, row.id)));
      }
      const parcels = await this.parcelsByKey(tx, row, map.key, keysOf(csv, map));
      const { rows, fileNet } = matchPayoutCsv(csv, map, parcels);
      return { columns, map, missing: [], rows, fileNet };
    });
  }
```

- **The file is read before the transaction.** A file that is not a CSV is refused without a database connection.
- **The map, in order: the member's, the saved one, the preset** (mine 18). With none (a manual account's first
  file), the answer has the file's columns and no rows, and the dialog asks for the mapping.
- **The map is saved only when the member gave it, it differs from the saved one, and the file had all its
  columns.** A map that found nothing must not replace one that works. Saving bumps no version and writes no audit
  (mine 21): a member editing the courier account at the same moment must not get a conflict for it.
- **The parcels are read with every state** (paid, payable, not ready), because the match reports all of them.

```ts
  // Saving posts it (decision 6). In this order: the courier account (FOR SHARE, so its COD
  // account cannot change under us), the parcels (FOR UPDATE, in id order, so two payouts of
  // overlapping parcels queue up instead of deadlocking), every check, the number, the payout,
  // its lines, the parcels' payout_id, then the entry. 0083's deferred check runs at COMMIT
  async create(input: PayoutInput): Promise<Payout> {
    try {
      return await this.withTenant(async (tx) => {
        const tenantId = getTenantId();
        const account = await this.findAccount(tx, input.accountId, 'share');
        if (account === null) {
          throw boxError('payout_pick_account', ['accountId'], 'Pick a courier account.');
        }
        if (account.codAccountId === null) {
          throw boxError(
            'payout_account_no_cod',
            ['accountId'],
            'This courier account has no COD account.',
          );
        }
        const codAccountId = account.codAccountId;
        // An active account that holds money, and not the COD account itself: a payout into it
        // would move nothing (decision 7; 0082's accounts check is the last word)
        const chart = await chartOf(tx);
        if (
          input.bankAccountId === codAccountId ||
          !chart.moneyAccounts.some((choice) => choice.id === input.bankAccountId)
        ) {
          throw boxError(
            'payout_bank_account_invalid',
            ['bankAccountId'],
            'Pick the bank or cash account the money went into.',
          );
        }

        const ids = input.lines.map((line) => line.shipmentId);
        const locked = await this.lockParcels(tx, account.id, ids);
        const byId = new Map(locked.map((parcel) => [parcel.id, parcel]));
        const taken: number[] = [];
        const zero: number[] = [];
        const lines = input.lines.flatMap((line, index) => {
          const parcel = byId.get(line.shipmentId);
          // Not found (another account's, another workspace's) or in a posted payout already
          const kind = parcel?.payoutId === null ? payoutKindOf(parcel, codAccountId) : null;
          if (parcel === undefined || kind === null) {
            taken.push(index);
            return [];
          }
          // A charge line is there only for its charge (mine 20)
          if (kind === 'charge' && compareMoney(line.charge, '0') === 0) zero.push(index);
          return [
            {
              parcel,
              kind,
              collected: kind === 'cod' ? (parcel.receiptAmount ?? '0') : '0',
              charge: line.charge,
            },
          ];
        });
        // Every line at once, so the form marks each one: another workspace's parcel, another
        // account's and one taken a moment ago all get the same answer
        if (taken.length > 0) throw unavailable(taken);
        if (zero.length > 0) {
          throw boxError(
            'payout_charge_line_zero',
            zero.map((index) => `lines.${String(index)}.charge`),
            'A parcel that brought no cash needs its charge.',
          );
        }

        const collected = sumMoney(lines.map((line) => line.collected));
        const charges = sumMoney(lines.map((line) => line.charge));
        const net = subtractMoney(collected, charges);
        if (isNegativeMoney(net)) {
          throw new AppError(
            422,
            'payout_below_zero',
            'The charges are more than the cash on these parcels.',
          );
        }
        if (compareMoney(charges, '0') > 0 && account.chargeAccountId === null) {
          throw boxError(
            'payout_account_no_charges',
            ['accountId'],
            'This courier account has no charges account.',
          );
        }
        // Never before the newest COD receipt it pays out (decision 7): the money was not with
        // the courier before. ISO dates compare as text
        const newest = lines.reduce<string | null>((latest, line) => {
          const day = line.parcel.receiptDate;
          return day !== null && (latest === null || day > latest) ? day : latest;
        }, null);
        if (newest !== null && input.date < newest) {
          throw new AppError(
            422,
            'payout_date_before_receipt',
            'A payout cannot be dated before the COD receipts it pays out.',
            { params: { date: newest }, fieldErrors: { date: ['payout_date_before_receipt'] } },
          );
        }
        const branchId = await this.shopBranch(tx);

        const number = await this.numbering.next(tx, 'storefront.payout', input.date);
        const userId = currentPrincipal().userId;
        const [row] = await tx
          .insert(storefrontPayouts)
          .values({
            tenantId,
            number,
            date: input.date,
            courierAccountId: account.id,
            bankAccountId: input.bankAccountId,
            codAccountId,
            chargeAccountId: account.chargeAccountId,
            branchId,
            reference: input.reference,
            note: input.note,
            collected,
            charges,
            net,
            createdBy: userId,
            updatedBy: userId,
          })
          .returning();
        if (row === undefined) throw new Error('Payout insert returned no row');
        await tx.insert(storefrontPayoutLines).values(
          lines.map((line) => ({
            tenantId,
            payoutId: row.id,
            courierAccountId: account.id,
            shipmentId: line.parcel.id,
            kind: line.kind,
            collected: line.collected,
            charge: line.charge,
            // The courier's own figure as it is now (mine 22)
            courierCharge: line.parcel.courierCharge,
            receiptId: line.kind === 'cod' ? line.parcel.receiptId : null,
          })),
        );
        // After the lines: 0083's parcel guard lets payout_id point only at a payout with a line
        // for the parcel. `payout_id IS NULL` again, though the rows are locked: if anything got
        // past the lock, fewer rows come back, and the payout is refused here, not at COMMIT
        const linked = await tx
          .update(storefrontShipments)
          .set({ payoutId: row.id })
          .where(
            and(
              eq(storefrontShipments.tenantId, tenantId),
              inArray(storefrontShipments.id, ids),
              isNull(storefrontShipments.payoutId),
            ),
          )
          .returning({ id: storefrontShipments.id });
        if (linked.length !== ids.length) throw unavailable([]);
        // The journal checks the date's period: a payout in a closed month is refused here
        const entry = await this.books.post(
          tx,
          { id: row.id, number, date: row.date },
          {
            branchId,
            bankAccountId: input.bankAccountId,
            codAccountId,
            chargeAccountId: row.chargeAccountId,
            collected: row.collected,
            charges: row.charges,
            net: row.net,
          },
        );
        await audit(tx, {
          action: 'storefront_payout.created',
          entityType: 'storefront_payout',
          entityId: row.id,
          changes: created({
            number,
            date: row.date,
            courierAccount: account.name,
            bankAccount: chart.codeOf.get(input.bankAccountId) ?? input.bankAccountId,
            reference: row.reference,
            parcels: lines.length,
            collected,
            charges,
            net,
            entry: entry.number,
          }),
        });
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw parcelRace(error);
    }
  }
```

The save, step by step:

- **The courier account `FOR SHARE`.** Its COD account cannot change until this commits. A member who changes it
  at the same moment waits, and the payout credits the account its lines' receipts went into.
- **A missing account is `payout_pick_account` under the box,** not 404: the id came from the form's select.
- **The bank is checked against `chartOf`'s money accounts,** and must not be the COD account (decision 7). 0082's
  accounts check is the last word.
- **The parcels `FOR UPDATE`, in id order.** Two payouts with overlapping parcels then lock them in the same order,
  so the second waits for the first instead of a deadlock (each holding a parcel the other wants). Only this
  account's parcels are read, so another account's parcel, or another workspace's, is simply not found.
- **`parcel?.payoutId === null`** is true only for a parcel that was found and is in no posted payout. TypeScript
  narrows `parcel` to defined in the true branch, so `payoutKindOf` gets a real row.
- **A cod line's `collected` is the receipt's amount,** never the form's (decision 5). The form sends only the
  parcel and its charge.
- **The checks, in this order:** unavailable parcels, a charge line with a ৳0 charge (mine 20), a net below zero
  (decision 3), charges without a charges account, a date before the newest receipt (decision 7). Each later one
  depends on the earlier ones: the net is only right once every line is a real line.
- **`payout_date_before_receipt` carries the newest date in `params`,** so the words can say "on or after 21 Nov".
  ISO dates compare as text, so `>` on the strings is the same as comparing the days.
- **The branch is the shop warehouse's** (decision 7). A shop has its warehouse from its launch, and a parcel needs
  a launched shop, so a payout without one is a broken workspace: a plain `Error`, a 500.
- **The number comes last of the reads,** right before the insert. A refusal after `numbering.next` would roll the
  number back anyway (same transaction), but fewer refusals reach it this way.
- **The lines before the parcels' `payout_id`.** 0083's parcel guard lets `payout_id` point only at a payout with a
  line for the parcel. The other order is refused by the database.
- **`payout_id IS NULL` again in the UPDATE,** though the rows are locked. If anything got past the lock, fewer rows
  come back, and the payout is refused here with the form's code, not at COMMIT with a 500.
- **The entry last,** after every row it describes exists. The journal checks the period lock: a payout in a closed
  month is refused there (`journal_period_locked`).
- **The audit names the account and the bank by name and code,** as the gateway's does: an id in the log is useless
  to a person.
- **The `try … catch` is outside `withTenant`.** The deferred check runs at COMMIT, which happens when `withTenant`
  returns, so only a catch outside it sees that error.

```ts
  // A payout typed wrong, or one the bank never got (decision 6, mine 24): voided first, then its
  // parcels freed (0083's parcel guard lets payout_id go only once the payout is voided), then its
  // entry reversed on the void date. The payout stays, voided, with its lines, so its number is
  // never reused or missing
  void(id: string, input: VoidPayoutInput): Promise<Payout> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const row = await this.lock(tx, id, input.version);
      if (input.date < row.date) {
        throw new AppError(
          409,
          'receipt_void_date',
          'A payout cannot be voided before its own date.',
          { fieldErrors: { date: ['receipt_void_date'] } },
        );
      }
      const entry = await this.books.entryOf(tx, id);
      if (entry === null) throw new Error(`Payout ${id} has no entry`);
      await tx
        .update(storefrontPayouts)
        .set({
          status: 'voided',
          voidDate: input.date,
          voidReason: input.reason,
          version: sql`${storefrontPayouts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(storefrontPayouts.tenantId, tenantId), eq(storefrontPayouts.id, id)));
      await tx
        .update(storefrontShipments)
        .set({ payoutId: null })
        .where(
          and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.payoutId, id)),
        );
      const reversal = await this.books.reverse(tx, entry, {
        date: input.date,
        narration: `Courier payout ${row.number} voided: ${input.reason}`,
      });
      await audit(tx, {
        action: 'storefront_payout.voided',
        entityType: 'storefront_payout',
        entityId: id,
        changes: created({ date: input.date, reason: input.reason, reversal: reversal.number }),
      });
      return this.read(tx, id);
    });
  }
```

- **Voided first, then the parcels freed.** 0083's parcel guard lets `payout_id` go back to none only once the payout
  is voided; the other order is refused.
- **`receipt_void_date`** is the receipt's code and words (mine 24): the same rule, "not before its own date".
- **The reversal is dated the void date,** like a voided receipt's. The COD account gets the money back on that day,
  and Holds counts the parcels again.
- **No `try … catch` here.** Nothing a person can do makes 0083 refuse a void: the payout row is locked, and a
  voided payout cannot be voided again (`payout_voided` in `lock`).

```ts
  // FOR UPDATE: two voids of one payout take turns. A voided payout is final
  private async lock(tx: Transaction, id: string, version: number): Promise<PayoutRow> {
    const [row] = await tx
      .select()
      .from(storefrontPayouts)
      .where(and(eq(storefrontPayouts.tenantId, getTenantId()), eq(storefrontPayouts.id, id)))
      .for('update');
    if (row === undefined) throw notFound('Payout');
    if (row.status === 'voided') {
      throw new AppError(409, 'payout_voided', 'This payout is voided and cannot be changed.');
    }
    if (row.version !== version) throw versionConflict();
    return row;
  }

  // Any courier account of this workspace, archived ones too: an archived account still holds the
  // money its last parcels brought in
  private async findAccount(
    tx: Transaction,
    id: string,
    lock: 'share' | null,
  ): Promise<AccountRow | null> {
    const query = tx
      .select()
      .from(courierAccounts)
      .where(and(eq(courierAccounts.tenantId, getTenantId()), eq(courierAccounts.id, id)));
    const [row] = lock === null ? await query : await query.for(lock);
    return row ?? null;
  }

  // The pages' view of the accounts, with the two ledger accounts by code and name (an archived
  // one too: the page must still name it) and what each holds
  private async toAccounts(tx: Transaction, rows: readonly AccountRow[]): Promise<PayoutAccount[]> {
    if (rows.length === 0) return [];
    const ledgerIds = rows.flatMap((row) =>
      [row.codAccountId, row.chargeAccountId].filter((id): id is string => id !== null),
    );
    const choices =
      ledgerIds.length === 0
        ? []
        : await tx
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.tenantId, getTenantId()),
                inArray(ledgerAccounts.id, ledgerIds),
              ),
            );
    const choiceOf = (id: string | null): StorefrontAccountChoice | null =>
      id === null ? null : (choices.find((choice) => choice.id === id) ?? null);
    const holds = await holdsOf(
      tx,
      rows.map((row) => row.id),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      courier: row.courier,
      archived: row.archivedAt !== null,
      codAccount: choiceOf(row.codAccountId),
      chargeAccount: choiceOf(row.chargeAccountId),
      holds: holds.get(row.id) ?? { amount: '0.0000', parcels: 0 },
    }));
  }

  // The parcels with their order's number and their receipt, by any condition on the parcel
  private parcelRows(tx: Transaction, where: SQL | undefined) {
    return tx
      .select(parcelColumns)
      .from(storefrontShipments)
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontShipments.tenantId),
          eq(receipts.id, storefrontShipments.receiptId),
        ),
      )
      .where(and(eq(storefrontShipments.tenantId, getTenantId()), where));
  }

  // The parcels a new payout names, locked in id order. Only the account's: another account's id
  // (or another workspace's) is simply not found, and create() says it is unavailable
  private lockParcels(tx: Transaction, accountId: string, ids: readonly string[]) {
    return this.parcelRows(
      tx,
      and(
        eq(storefrontShipments.courierAccountId, accountId),
        inArray(storefrontShipments.id, [...ids]),
      ),
    )
      .orderBy(asc(storefrontShipments.id))
      .for('update', { of: storefrontShipments });
  }

  // The parcels the file's keys name, each as what a payout could do with it. One read for the
  // whole file; the account's unique keys (invoice, consignment id) and the exact compare keep it
  // on the account's own rows. A tracking code has no unique index, so a second parcel with the
  // same code (a courier's typo) keeps the first one read
  private async parcelsByKey(
    tx: Transaction,
    account: AccountRow,
    key: PayoutCsvKey,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, MatchParcel>> {
    if (keys.length === 0) return new Map();
    const column = storefrontShipments[KEY_COLUMN[key]];
    const rows = await tx
      .select({ ...parcelColumns, payoutNumber: storefrontPayouts.number })
      .from(storefrontShipments)
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontShipments.tenantId),
          eq(receipts.id, storefrontShipments.receiptId),
        ),
      )
      .leftJoin(
        storefrontPayouts,
        and(
          eq(storefrontPayouts.tenantId, storefrontShipments.tenantId),
          eq(storefrontPayouts.id, storefrontShipments.payoutId),
        ),
      )
      .where(
        and(
          eq(storefrontShipments.tenantId, getTenantId()),
          eq(storefrontShipments.courierAccountId, account.id),
          inArray(column, [...keys]),
        ),
      )
      .orderBy(asc(storefrontShipments.createdAt));
    const found = new Map<string, MatchParcel>();
    for (const row of rows) {
      const value = row[KEY_COLUMN[key]];
      if (value === null || found.has(value)) continue;
      found.set(
        value,
        row.payoutId !== null
          ? {
              state: 'paid',
              shipmentId: row.id,
              payout: { id: row.payoutId, number: row.payoutNumber },
            }
          : payoutKindOf(row, account.codAccountId) === null
            ? { state: 'not_ready', shipmentId: row.id }
            : {
                state: 'payable',
                shipmentId: row.id,
                collected: row.receiptId === null ? '0.0000' : (row.receiptAmount ?? '0.0000'),
              },
      );
    }
    return found;
  }

  // The shop warehouse's branch (decision 7), as the COD receipts' branch. A shop has its
  // warehouse from its launch on, and a payout needs a parcel, which needs a launched shop
  private async shopBranch(tx: Transaction): Promise<string> {
    const [row] = await tx
      .select({ branchId: warehouses.branchId })
      .from(storefrontSettings)
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, storefrontSettings.tenantId),
          eq(warehouses.id, storefrontSettings.defaultWarehouseId),
        ),
      )
      .where(eq(storefrontSettings.tenantId, getTenantId()));
    if (row === undefined) throw new Error('The shop has no warehouse, so a payout has no branch');
    return row.branchId;
  }

  // The list's rows (and the payout page's header): the account's name and courier, and the count
  // of lines. The count is written out with its tables' names, for 27b's reason (itemCount): in a
  // select's fields Drizzle writes a column without its table, and an unqualified "tenant_id" in
  // the subquery would be the line's own
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        payout: storefrontPayouts,
        accountName: courierAccounts.name,
        courier: courierAccounts.courier,
        parcels: sql<number>`(SELECT count(*) FROM storefront_payout_lines l
          WHERE l.tenant_id = storefront_payouts.tenant_id
            AND l.payout_id = storefront_payouts.id)::int`,
      })
      .from(storefrontPayouts)
      .innerJoin(
        courierAccounts,
        and(
          eq(courierAccounts.tenantId, storefrontPayouts.tenantId),
          eq(courierAccounts.id, storefrontPayouts.courierAccountId),
        ),
      )
      .where(and(eq(storefrontPayouts.tenantId, getTenantId()), where))
      .orderBy(desc(storefrontPayouts.date), desc(storefrontPayouts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Payout> {
    const [found] = await this.rows(tx, eq(storefrontPayouts.id, id), 1);
    if (found === undefined) throw notFound('Payout');
    const row = found.payout;
    const tenantId = getTenantId();
    const lines = await tx
      .select({
        line: storefrontPayoutLines,
        orderId: storefrontShipments.orderId,
        orderNo: storefrontOrders.orderNo,
        invoice: storefrontShipments.invoice,
        trackingCode: storefrontShipments.trackingCode,
        receiptNumber: receipts.number,
      })
      .from(storefrontPayoutLines)
      .innerJoin(
        storefrontShipments,
        and(
          eq(storefrontShipments.tenantId, storefrontPayoutLines.tenantId),
          eq(storefrontShipments.id, storefrontPayoutLines.shipmentId),
        ),
      )
      .innerJoin(
        storefrontOrders,
        and(
          eq(storefrontOrders.tenantId, storefrontShipments.tenantId),
          eq(storefrontOrders.id, storefrontShipments.orderId),
        ),
      )
      .leftJoin(
        receipts,
        and(
          eq(receipts.tenantId, storefrontPayoutLines.tenantId),
          eq(receipts.id, storefrontPayoutLines.receiptId),
        ),
      )
      .where(
        and(eq(storefrontPayoutLines.tenantId, tenantId), eq(storefrontPayoutLines.payoutId, id)),
      )
      .orderBy(asc(storefrontShipments.invoice));
    const entry = await this.books.entryOf(tx, id);
    if (entry === null) throw new Error(`Payout ${id} has no entry`);
    const voidEntry = row.status === 'voided' ? await this.books.reversalOf(tx, entry.id) : null;
    return {
      ...toSummary(found),
      note: row.note,
      codAccountId: row.codAccountId,
      chargeAccountId: row.chargeAccountId,
      branchId: row.branchId,
      lines: lines.map((each): PayoutLine => ({
        shipmentId: each.line.shipmentId,
        kind: each.line.kind,
        order: { id: each.orderId, number: each.orderNo ?? '' },
        invoice: each.invoice,
        trackingCode: each.trackingCode,
        collected: each.line.collected,
        charge: each.line.charge,
        courierCharge: each.line.courierCharge,
        receipt:
          each.line.receiptId === null
            ? null
            : { id: each.line.receiptId, number: each.receiptNumber },
      })),
      entry,
      voidEntry,
      voidDate: row.voidDate,
      voidReason: row.voidReason,
    };
  }
}
```

- **`findAccount` reads archived accounts too.** An archived account's money still needs a payout.
- **`toAccounts` reads the two ledger accounts by id, archived ones too.** `chartOf` lists only active accounts, and
  the page must still name an account that was archived since.
- **`lockParcels` uses `for('update', { of: storefrontShipments })`.** Without `of`, Postgres would try to lock every
  joined row, and refuse the query outright: the receipt is the nullable side of a left join ("FOR UPDATE cannot be
  applied to the nullable side of an outer join"). Locking the order too would only make other work on the order
  wait. The receipt gets its lock from 0083's line guard (`FOR SHARE`), which is the lock that matters.
- **`parcelsByKey` keeps the first parcel of a key.** Invoice and consignment id are unique per account (28a), so
  only a tracking code could repeat (a courier's typo). Ordered by `created_at`, the older parcel wins, the same way
  every time.
- **`rows` counts the lines with the tables written out by name,** for 27b's reason: in a select's fields Drizzle
  writes a column without its table, and an unqualified `tenant_id` in the subquery would be the line's own.
- **`read` sorts the lines by invoice,** the order a member finds them in the courier's file.

```ts
function toSummary(found: {
  payout: PayoutRow;
  accountName: string;
  courier: PayoutSummary['account']['courier'];
  parcels: number;
}): PayoutSummary {
  const { payout } = found;
  return {
    id: payout.id,
    number: payout.number,
    date: payout.date,
    account: { id: payout.courierAccountId, name: found.accountName, courier: found.courier },
    bankAccountId: payout.bankAccountId,
    reference: payout.reference,
    parcels: found.parcels,
    collected: payout.collected,
    charges: payout.charges,
    net: payout.net,
    status: payout.status,
    version: payout.version,
    updatedAt: payout.updatedAt.toISOString(),
  };
}

// A parcel row as the new payout's list sends it. A confirmed order always has its number (a
// parcel is booked only after that), so the empty string is a broken row's, never a real one's
function toParcel(
  row: {
    id: string;
    orderId: string;
    orderNo: string | null;
    invoice: string;
    trackingCode: string | null;
    consignmentId: string | null;
    status: PayoutParcel['status'];
    courierCharge: string | null;
    lastSyncedAt: Date | null;
    receiptId: string | null;
    receiptNumber: string | null;
    receiptAmount: string | null;
    receiptDate: string | null;
  },
  kind: PayoutLineKind,
): PayoutParcel {
  return {
    shipmentId: row.id,
    kind,
    order: { id: row.orderId, number: row.orderNo ?? '' },
    invoice: row.invoice,
    trackingCode: row.trackingCode,
    consignmentId: row.consignmentId,
    status: row.status,
    collected: kind === 'cod' ? (row.receiptAmount ?? '0.0000') : '0.0000',
    courierCharge: row.courierCharge,
    receipt:
      kind === 'cod' && row.receiptId !== null
        ? { id: row.receiptId, number: row.receiptNumber }
        : null,
    receiptDate: kind === 'cod' ? row.receiptDate : null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}
```

- **`order.number ?? ''`.** A parcel is booked only after its order is confirmed, which gives it a number; the empty
  string is a broken row's, never a real one's. Throwing would hide every other line of the page for one bad row.
- **A charge line sends `collected: '0.0000'` and no receipt,** the shape the contract and 0082's line check expect.

### The routes

```ts
import { Controller } from '@nestjs/common';
import { type RouteInput, type RouteResponse, routes } from '@omnivo/contracts';

import { Endpoint } from '../../common/http/endpoint.js';
import { PayoutsService } from './payouts.service.js';

type Routes = typeof routes.storefrontPayouts;

// Step 28c: Storefront → Shop payouts. Every route needs storefront.payout.manage (the contract
// says so and the guard checks it). The parcels and the match hang on the courier account
// (/storefront/couriers/:id/…), and the setup has its own address, so none of them ever meets
// /storefront/payouts/:id (mine 17)
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Endpoint(routes.storefrontPayouts.setup)
  setup(): Promise<RouteResponse<Routes['setup']>> {
    return this.payouts.setup();
  }

  @Endpoint(routes.storefrontPayouts.list)
  list({ query }: RouteInput<Routes['list']>): Promise<RouteResponse<Routes['list']>> {
    return this.payouts.list(query);
  }

  @Endpoint(routes.storefrontPayouts.get)
  get({ params }: RouteInput<Routes['get']>): Promise<RouteResponse<Routes['get']>> {
    return this.payouts.get(params.id);
  }

  @Endpoint(routes.storefrontPayouts.parcels)
  parcels({ params }: RouteInput<Routes['parcels']>): Promise<RouteResponse<Routes['parcels']>> {
    return this.payouts.parcels(params.id);
  }

  @Endpoint(routes.storefrontPayouts.match)
  match({ params, body }: RouteInput<Routes['match']>): Promise<RouteResponse<Routes['match']>> {
    return this.payouts.match(params.id, body);
  }

  @Endpoint(routes.storefrontPayouts.create)
  create({ body }: RouteInput<Routes['create']>): Promise<RouteResponse<Routes['create']>> {
    return this.payouts.create(body);
  }

  @Endpoint(routes.storefrontPayouts.void)
  void({ params, body }: RouteInput<Routes['void']>): Promise<RouteResponse<Routes['void']>> {
    return this.payouts.void(params.id, body);
  }
}
```

```diff
@@ -1,6 +1,8 @@
 import { Module } from '@nestjs/common';
 
 import { AttachmentsModule } from '../attachments/attachments.module.js';
+import { JournalModule } from '../journal/journal.module.js';
+import { NumberingModule } from '../numbering/numbering.module.js';
 import { ProductsModule } from '../products/products.module.js';
 import { SalesModule } from '../sales/sales.module.js';
 import { StorefrontAppearanceService } from './admin/appearance.service.js';
@@ -35,6 +37,9 @@ import { CourierAccountsController } from './shipping/courier-accounts.controlle
 import { CourierAccountsService } from './shipping/courier-accounts.service.js';
 import { CourierWebhooks } from './shipping/courier-webhooks.js';
 import { ShipmentNews } from './shipping/shipment-news.js';
+import { PayoutBooks } from './payouts/payout-books.js';
+import { PayoutsController } from './payouts/payouts.controller.js';
+import { PayoutsService } from './payouts/payouts.service.js';
 import { ShopDb } from './shop-db.js';
 
 // Step 26f: the online shop's side of the API: the public reads (/public/v1). Step 26g adds the
@@ -54,9 +59,10 @@ import { ShopDb } from './shop-db.js';
 // page and the courier's webhook (one controller), the parcels of a shop order (shipping/
 // shipments.ts, used by the order moves), and the courier's news, which moves an order with the
 // buttons' own code (orders/order-moves.ts). The adapters come from InfraModule (COURIERS); the
-// booking job and the poll run in the worker
+// booking job and the poll run in the worker. Step 28c adds the courier's payout (payouts/), a
+// document of its own with its number and its entry, so it imports the journal and the numbering
 @Module({
-  imports: [AttachmentsModule, SalesModule, ProductsModule],
+  imports: [AttachmentsModule, SalesModule, ProductsModule, JournalModule, NumberingModule],
   controllers: [
     PublicStorefrontController,
     ShopOrdersController,
@@ -66,6 +72,7 @@ import { ShopDb } from './shop-db.js';
     StorefrontCouponsController,
     StorefrontPaymentsController,
     CourierAccountsController,
+    PayoutsController,
   ],
   providers: [
     ShopDb,
@@ -94,6 +101,8 @@ import { ShopDb } from './shop-db.js';
     CourierAccountsService,
     CourierWebhooks,
     ShipmentNews,
+    PayoutBooks,
+    PayoutsService,
   ],
 })
 export class StorefrontModule {}
```

- Each method only passes the contract's input on; the guard checks `storefront.payout.manage` from the contract.
- **`JournalModule` and `NumberingModule` are imported here now.** The payout is the first storefront document with
  its own number and entry; before it, the storefront posted only through `ReceiptsService` (`SalesModule`).

### Holds, and the parcel card's payout

```diff
@@ -11,7 +11,7 @@ import {
   type UpdateCourierAccountInput,
 } from '@omnivo/contracts';
 import { courierAccounts, receipts, storefrontShipments } from '@omnivo/db';
-import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
+import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
 
 import { audit, created, diff } from '../../common/audit/audit.js';
 import { isCheckViolation } from '../../common/db/pg-errors.js';
@@ -471,9 +471,10 @@ export class CourierAccountsService {
 
 // Step 28b (decision 12, mine 26): what each courier holds of the shop's money, the page's "Holds
 // ৳45,200 · 18 parcels": the parcels whose COD receipt is posted (a voided one stays linked and
-// counts no more). storefront_shipments_cod_idx finds them per account. Step 28c's payout takes
-// its parcels out of this sum
-async function holdsOf(tx: Transaction, accountIds: readonly string[]): Promise<Holds> {
+// counts no more). Step 28c (decision 15): and that no posted payout took, so a payout takes its
+// parcels out of this sum and a voided one puts them back. storefront_shipments_payable_idx finds
+// them per account (its condition covers this one). Exported: the payout pages show it too
+export async function holdsOf(tx: Transaction, accountIds: readonly string[]): Promise<Holds> {
   if (accountIds.length === 0) return new Map();
   const rows = await tx
     .select({
@@ -494,6 +495,7 @@ async function holdsOf(tx: Transaction, accountIds: readonly string[]): Promise<
         eq(storefrontShipments.tenantId, getTenantId()),
         inArray(storefrontShipments.courierAccountId, [...accountIds]),
         isNotNull(storefrontShipments.receiptId),
+        isNull(storefrontShipments.payoutId),
         eq(receipts.status, 'posted'),
       ),
     )
```

- **`isNull(payoutId)`** (decision 15): a paid-out parcel's money is in the bank, not with the courier. A voided
  payout clears `payout_id`, so its parcels count again by themselves.
- **Exported,** because the payout pages show the same "Holds ৳45,200 · 18 parcels" as Shop couriers.
- 28c.2's checks showed that Postgres uses `storefront_shipments_payable_idx` for this query.

```diff
@@ -14,6 +14,7 @@ import {
   receipts,
   storefrontOrders,
   storefrontPayments,
+  storefrontPayouts,
   storefrontShipmentEvents,
   storefrontShipments,
 } from '@omnivo/db';
@@ -335,6 +336,8 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
       codAccountId: courierAccounts.codAccountId,
       // Step 28b: the COD receipt's number, for the parcel card's link
       receiptNumber: receipts.number,
+      // Step 28c (decision 14): the payout's number, for the card's "Paid out on CPO-…"
+      payoutNo: storefrontPayouts.number,
     })
     .from(storefrontShipments)
     .innerJoin(
@@ -351,6 +354,13 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
         eq(receipts.id, storefrontShipments.receiptId),
       ),
     )
+    .leftJoin(
+      storefrontPayouts,
+      and(
+        eq(storefrontPayouts.tenantId, storefrontShipments.tenantId),
+        eq(storefrontPayouts.id, storefrontShipments.payoutId),
+      ),
+    )
     .where(
       and(eq(storefrontShipments.tenantId, tenantId), eq(storefrontShipments.orderId, orderId)),
     )
@@ -375,7 +385,7 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
       ),
     )
     .orderBy(asc(storefrontShipmentEvents.occurredAt), asc(storefrontShipmentEvents.receivedAt));
-  return rows.map(({ parcel, accountName, provider, codAccountId, receiptNumber }) => ({
+  return rows.map(({ parcel, accountName, provider, codAccountId, receiptNumber, payoutNo }) => ({
     id: parcel.id,
     account: {
       id: parcel.courierAccountId,
@@ -397,6 +407,11 @@ export async function shipmentsOf(tx: Transaction, orderId: string): Promise<Sto
         : { id: parcel.receiptId, number: receiptNumber },
     receiptError:
       parcel.receiptError !== null && isErrorCode(parcel.receiptError) ? parcel.receiptError : null,
+    // Only a posted payout: a voided one cleared payout_id (0083)
+    payout:
+      parcel.payoutId === null || payoutNo === null
+        ? null
+        : { id: parcel.payoutId, number: payoutNo },
     bookedAt: parcel.bookedAt?.toISOString() ?? null,
     attempts: parcel.attempts,
     error: parcel.error !== null && isErrorCode(parcel.error) ? parcel.error : null,
```

- **A left join on the payout, for its number** (decision 14): the card's "Paid out on CPO-…" links to it. Only a
  posted payout is ever in `payout_id` (0083), so there is no status to check.
- The field is `payoutNo`, not `payoutNumber`, only so the destructuring line still fits in 100 characters and
  Prettier leaves the whole `rows.map` as it was.

### The journal's Reverse

```diff
@@ -4,6 +4,7 @@ import {
   isPurchaseJournalSource,
   isSalesJournalSource,
   isStockJournalSource,
+  isStorefrontJournalSource,
   type JournalEntry,
   type JournalEntryInput,
   type JournalEntrySummary,
@@ -231,6 +232,16 @@ export class JournalService {
             'This entry belongs to a POS shift. Correct it with the next count or a pay in or out.',
           );
         }
+        if (isStorefrontJournalSource(entry.source)) {
+          // A courier's payout (step 28c, mine 23): its parcels point at it. Reversing the entry
+          // alone would leave them paid out with their money back in the COD account; voiding the
+          // payout on its own page reverses the entry and frees them together.
+          throw new AppError(
+            409,
+            'journal_is_payout',
+            'This entry belongs to a courier payout. Void the payout on its own page.',
+          );
+        }
         if (entry.version !== input.version) throw versionConflict();
         const [already] = await tx
           .select({ id: reversal.id })
```

Mine 23. Reversing the payout's entry from the journal would put the money back in the COD account and leave the
parcels paid out: Holds would say ৳0 while the books say the courier owes the money. Voiding the payout does both.

### A paid-out COD receipt cannot be voided

```diff
@@ -11,8 +11,15 @@ import {
   subtractMoney,
   type VoidReceiptInput,
 } from '@omnivo/contracts';
-import { invoices, parties, receiptAllocations, receipts, refunds } from '@omnivo/db';
-import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
+import {
+  invoices,
+  parties,
+  receiptAllocations,
+  receipts,
+  refunds,
+  storefrontShipments,
+} from '@omnivo/db';
+import { and, asc, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
 import { z } from 'zod';
 
 import { audit, created } from '../common/audit/audit.js';
@@ -59,6 +66,15 @@ function voided(): AppError {
   return new AppError(409, 'receipt_voided', 'This receipt is voided and cannot be changed.');
 }
 
+// Step 28c (mine 26): a COD receipt whose money a posted courier payout took to the bank
+function paidOutError(): AppError {
+  return new AppError(
+    409,
+    'receipt_paid_out',
+    'A courier payout paid this money out. Void the payout first.',
+  );
+}
+
 function overAllocatedError(): AppError {
   return new AppError(
     409,
@@ -226,10 +242,26 @@ export class ReceiptsService {
 
   // A bounced cheque or a receipt typed by mistake: its money comes off the invoices, and its entry
   // is reversed on the void date. The receipt stays, voided, so its number is never reused or
-  // missing from the series. Not while a posted refund pays some of it back (step 15d).
+  // missing from the series. Not while a posted refund pays some of it back (step 15d), nor while
+  // a posted courier payout pays it out (step 28c).
   void(id: string, input: VoidReceiptInput): Promise<Receipt> {
     return this.withTenant(async (tx) => {
       const row = await this.lock(tx, id, input.version);
+      // The lock on the receipt makes a payout that is being saved finish first (its line reads
+      // the receipt FOR SHARE), and one saved after this waits and then finds the receipt voided.
+      // So what this finds is what there is; 0083's receipts_paid_out is the last word
+      const [paidOut] = await tx
+        .select({ id: storefrontShipments.id })
+        .from(storefrontShipments)
+        .where(
+          and(
+            eq(storefrontShipments.tenantId, getTenantId()),
+            eq(storefrontShipments.receiptId, id),
+            isNotNull(storefrontShipments.payoutId),
+          ),
+        )
+        .limit(1);
+      if (paidOut) throw paidOutError();
       // The lock on the receipt makes a new refund of it wait (RefundsService locks it too), so
       // what this finds is what there is. The database's receipts_void_check is the last word.
       const [refund] = await tx
```

- **Checked after the receipt's own lock,** like the refunds check under it. The lock decides the order with a
  payout being saved: the payout's line reads the receipt `FOR SHARE`, so either the payout commits first and this
  check finds it, or this void commits first and the payout's line finds the receipt voided. 28c.2's race showed
  both.
- **No mapping of the database's error.** As with `receipts_void_check`, the check above makes 0083's
  `receipts_paid_out` a last word that only a bug reaches.

### The role templates

```diff
@@ -197,6 +197,10 @@ const RUNNING_THE_SHOP = ['storefront.manage'] as const;
 // Step 27a: the shop's orders, for the same two roles (27a's decision 11). Apart from
 // storefront.manage, so an owner can give a packer the orders without the shop's prices
 const SHOP_ORDERS = ['storefront.order.read', 'storefront.order.manage'] as const;
+// Step 28c (decision 9, mine 32): the courier's payouts move the shop's COD money into the bank,
+// so they are the accountant's, in every industry, and the two managers' who run a shop. There is
+// no Admin template: the Owner has every permission, and the managers stand in for an admin
+const SHOP_PAYOUTS = ['storefront.payout.manage'] as const;
 
 // Some roles have few permissions today because the modules they will use (stock, sales) do not
 // exist yet. Each of those steps adds its permissions to these templates for new workspaces.
@@ -237,6 +241,8 @@ const ACCOUNTANT: RoleTemplate = {
     ...STOCK_REPORTS,
     // Step 21c: and sending them by email on a schedule
     ...SCHEDULING_REPORTS,
+    // Step 28c: the courier's payouts
+    ...SHOP_PAYOUTS,
   ],
 };
 
@@ -766,6 +772,7 @@ export const INDUSTRY_TEMPLATES = {
           ...SCHEDULING_REPORTS,
           ...RUNNING_THE_SHOP,
           ...SHOP_ORDERS,
+          ...SHOP_PAYOUTS,
         ],
       },
       {
@@ -846,6 +853,7 @@ export const INDUSTRY_TEMPLATES = {
           ...SCHEDULING_REPORTS,
           ...RUNNING_THE_SHOP,
           ...SHOP_ORDERS,
+          ...SHOP_PAYOUTS,
         ],
       },
     ],
```

```diff
@@ -159,6 +159,8 @@ describe('starting the setup', () => {
           'sales.receipt.manage',
           'sales.refund.manage',
           'sales.report.read',
+          // Step 28c: the courier's payouts
+          'storefront.payout.manage',
         ],
       ],
       [
```

Mine 32. Decision 9 named the Owner, an Admin and the Accountant. There is no Admin template: the Owner has every
permission in code, and the two managers who run a shop (Shop manager in retail, Manager in "other") stand in for
an admin. So the Accountant gets it in every industry, and those two managers get it next to the shop's own
permissions. Older workspaces get nothing new (28c.2): their owner adds it in Settings → Roles. The setup test lists
the Accountant's permissions by hand, so it gets the new one too.

### Check this part

```bash
pnpm turbo build --filter='./packages/*' --continue
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/storefront apps/api/src/common/csv apps/api/src/products/import \
  apps/api/src/journal apps/api/src/sales/receipts.service.ts apps/api/src/setup
pnpm --filter @omnivo/api test                   # 246 unit tests
cd apps/api && npx vitest run src/storefront/shipping src/sales/invoices.int.spec.ts \
  src/sales/returns.int.spec.ts src/journal/journal.int.spec.ts src/products/product-imports.int.spec.ts \
  src/setup/setup.int.spec.ts src/auth/auth.int.spec.ts \
  src/common/tenant/rls-coverage.tenant-leak.int.spec.ts --maxWorkers=3
```

What was checked, on the real stack (Postgres, Redis, Mailpit, the API and the worker with the fake courier), in a
throwaway test that 28c.4 replaces with the real ones:

- Two parcels delivered by Steadfast's webhook (৳538 each, charges ৳80 and ৳60) and one that came back (charge
  ৳50): the setup says the account holds ৳1,076 in 2 parcels; the new payout's list has two cod lines and one charge
  line, oldest first.
- A file with the preset's columns and a byte order mark: matched, different ("1,000" against ৳538), matched (the
  charge line), not ready (a parcel on its way), unknown, twice, invalid (an empty key), invalid ("N/A"); the file's
  net is ৳1,348. A map whose column the file lacks answers `missing: ['Tracking']`, no rows, and is not saved.
- Refused with their codes: the COD account as the bank, a date before the receipts (with the date in `params`),
  a parcel not ready (under `lines.3.shipmentId`), a charge line at ৳0, charges above the cash.
- Saved: CPO-2026-27-0001, ৳1,076 − ৳190 = ৳886; its entry is Dr bank ৳886, Dr charges ৳190, Cr COD ৳1,076. The same
  payout again is `payout_parcel_unavailable`. Holds is ৳0, the parcel card says the payout, the list has it.
- Matched again with a map the member gave: `already_paid` with the payout, no `fileNet` (one amount column), and the
  map saved on the account.
- The journal's Reverse of its entry is `journal_is_payout`; voiding a paid-out COD receipt is `receipt_paid_out`.
- Voided: its reversal exists, a second void is `payout_voided`, the parcels are free, Holds is back to 2 parcels,
  and the same parcels are paid out again by a new payout.
- The suites that touch receipts, the journal, the import, the setup and the couriers still pass (101 + 52 tests,
  the setup test with the Accountant's new permission).

Broken on purpose, each checked:

- `holdsOf` without `isNull(payoutId)`: Holds still says ৳1,076 after the payout.
- The journal's Reverse without the payout's check: the Reverse goes through.
- The receipt void without its paid-out check: still refused, by 0083's `receipts_paid_out`, so the database's rule
  holds on its own; the API then answers 500 (`internal_error`), which is why the check is there.

These fail until later parts, on purpose:

- `pnpm test:openapi`: `openapi.json` is generated again at the end (28c.8), as in 28b.
- `pnpm --filter @omnivo/app typecheck`: the app's parcel mock has no `payout` yet (28c.7).

## 28c.4 — API tests

The tests come in three files: one of unit tests for the pure CSV matcher, one that runs payouts on the real stack
(Postgres, Redis, Mailpit, the API and the worker, with the fake courier), and one that keeps two workspaces apart.
They replace the throwaway smoke test of 28c.3. They found no bug in 28c.3's code; the first run's two failures
were mistakes in the tests themselves (a courier the shop does not know, and the audit log's `{ from, to }` shape).

### The matcher, without the database

```ts
import {
  type DocumentRef,
  MAX_PAYOUT_CSV_ROWS,
  type PayoutCsvMap,
  STEADFAST_PAYOUT_CSV_PRESET,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  keysOf,
  type MatchParcel,
  matchPayoutCsv,
  missingColumns,
  type PayableParcel,
  type PayoutCsv,
  payoutKindOf,
  readAmount,
  readPayoutCsv,
} from './payout-match.js';

const PRESET: PayoutCsvMap = STEADFAST_PAYOUT_CSV_PRESET;
const COD_ACCOUNT = '0193a000-0000-7000-8000-0000000000c1';
const OLD_COD_ACCOUNT = '0193a000-0000-7000-8000-0000000000c2';
const RECEIPT = '0193a000-0000-7000-8000-0000000000a1';
const PAYOUT: DocumentRef = {
  id: '0193a000-0000-7000-8000-0000000000b1',
  number: 'CPO-2026-27-0001',
};

// A file read by readPayoutCsv, or the test fails at once with the error code it got
function csvOf(text: string): PayoutCsv {
  const csv = readPayoutCsv(text);
  if (typeof csv === 'string') throw new Error(`Not readable: ${csv}`);
  return csv;
}

describe('readPayoutCsv', () => {
  it('reads the header and the rows, numbered as the spreadsheet shows them', () => {
    const csv = csvOf('Invoice,COD Amount\nW-000001,538\nW-000002,309\n');
    expect(csv.header).toEqual(['Invoice', 'COD Amount']);
    expect(csv.rows).toEqual([
      { row: 2, cells: ['W-000001', '538'] },
      { row: 3, cells: ['W-000002', '309'] },
    ]);
  });

  it('drops the byte order mark a FileReader keeps', () => {
    expect(csvOf('﻿Invoice,COD Amount\nW-000001,538').header).toEqual(['Invoice', 'COD Amount']);
  });

  it('skips empty rows and keeps the numbers of the rows after them', () => {
    const csv = csvOf('Invoice,COD Amount\n,\nW-000001,538\n,,\n');
    expect(csv.rows).toEqual([{ row: 3, cells: ['W-000001', '538'] }]);
  });

  it('refuses a file that is no CSV, an empty file and an empty header', () => {
    expect(readPayoutCsv('Invoice,"COD Amount\nW-000001,538')).toBe('payout_csv_unreadable');
    expect(readPayoutCsv('')).toBe('payout_csv_unreadable');
    expect(readPayoutCsv(',,\nW-000001,538,80')).toBe('payout_csv_unreadable');
  });

  it('refuses a header wider than 200 columns', () => {
    const wide = Array.from({ length: 201 }, (_, index) => `C${String(index)}`).join(',');
    expect(readPayoutCsv(wide)).toBe('payout_csv_unreadable');
    const widest = Array.from({ length: 200 }, (_, index) => `C${String(index)}`).join(',');
    expect(readPayoutCsv(widest)).not.toBe('payout_csv_unreadable');
  });

  it('takes 5,000 rows and refuses one more, not counting empty ones', () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => `W-${String(index).padStart(6, '0')},1`);
    const most = ['Invoice,COD Amount', ...rows(MAX_PAYOUT_CSV_ROWS), ',', ','].join('\n');
    expect(csvOf(most).rows).toHaveLength(MAX_PAYOUT_CSV_ROWS);
    const tooMany = ['Invoice,COD Amount', ...rows(MAX_PAYOUT_CSV_ROWS + 1)].join('\n');
    expect(readPayoutCsv(tooMany)).toBe('payout_csv_too_many_rows');
  });
});

describe('missingColumns', () => {
  it('ignores case', () => {
    expect(missingColumns(['invoice', 'COD AMOUNT', 'delivery charge'], PRESET)).toEqual([]);
  });

  it('names each mapped column the file does not have, never a column the map leaves out', () => {
    expect(missingColumns(['Invoice', 'Amount'], PRESET)).toEqual([
      'COD Amount',
      'Delivery Charge',
    ]);
    const keyOnly: PayoutCsvMap = { ...PRESET, collectedColumn: null, chargeColumn: null };
    expect(missingColumns(['Invoice'], keyOnly)).toEqual([]);
    expect(missingColumns(['Tracking'], keyOnly)).toEqual(['Invoice']);
  });
});

describe('readAmount', () => {
  it('reads an amount as a courier writes it, with 4 decimals like the API', () => {
    expect(readAmount('1,250')).toEqual({ valid: true, amount: '1250.0000' });
    expect(readAmount('1250.5')).toEqual({ valid: true, amount: '1250.5000' });
    expect(readAmount('৳ 1,250.50')).toEqual({ valid: true, amount: '1250.5000' });
    expect(readAmount('Tk 80')).toEqual({ valid: true, amount: '80.0000' });
    expect(readAmount('tk. 80')).toEqual({ valid: true, amount: '80.0000' });
    expect(readAmount('80 BDT')).toEqual({ valid: true, amount: '80.0000' });
    expect(readAmount('0')).toEqual({ valid: true, amount: '0.0000' });
  });

  it('reads an empty cell as no amount, not as zero', () => {
    expect(readAmount('')).toEqual({ valid: true, amount: null });
    expect(readAmount(' ৳ ')).toEqual({ valid: true, amount: null });
  });

  it('refuses a minus, a third decimal and words, rather than read them wrongly', () => {
    expect(readAmount('-50')).toEqual({ valid: false });
    expect(readAmount('12.345')).toEqual({ valid: false });
    expect(readAmount('N/A')).toEqual({ valid: false });
    expect(readAmount('1.2.3')).toEqual({ valid: false });
  });
});

describe('keysOf', () => {
  it('gives each key once and leaves empty ones out', () => {
    const csv = csvOf('COD Amount,Invoice\n538,W-000001\n80,\n538,W-000001\n309,W-000002');
    expect(keysOf(csv, PRESET)).toEqual(['W-000001', 'W-000002']);
  });
});

describe('matchPayoutCsv', () => {
  const parcels = new Map<string, MatchParcel>([
    ['W-000001', { state: 'payable', shipmentId: 's1', collected: '538.0000' }],
    ['W-000002', { state: 'payable', shipmentId: 's2', collected: '309.0000' }],
    // A charge line: nothing collected
    ['W-000003', { state: 'payable', shipmentId: 's3', collected: '0' }],
    ['W-000004', { state: 'paid', shipmentId: 's4', payout: PAYOUT }],
    ['W-000005', { state: 'not_ready', shipmentId: 's5' }],
  ]);

  const FILE = [
    'Invoice,COD Amount,Delivery Charge',
    'W-000001,538,60', // 2 matched
    'W-000002,300,60', // 3 different: our receipt says 309
    'W-000003,,120', // 4 matched: a charge line, the cell says nothing
    'W-000004,420,60', // 5 already paid
    'W-000005,250,60', // 6 not ready
    'W-000099,100,60', // 7 unknown
    'W-000001,538,60', // 8 twice
    ',538,60', // 9 invalid: no key
    'W-000006,N/A,60', // 10 invalid: no amount
  ].join('\n');

  it('accounts for every row of the file, in its order', () => {
    const { rows } = matchPayoutCsv(csvOf(FILE), PRESET, parcels);
    expect(rows.map((row) => [row.row, row.key, row.outcome])).toEqual([
      [2, 'W-000001', 'matched'],
      [3, 'W-000002', 'different'],
      [4, 'W-000003', 'matched'],
      [5, 'W-000004', 'already_paid'],
      [6, 'W-000005', 'not_ready'],
      [7, 'W-000099', 'unknown'],
      [8, 'W-000001', 'twice'],
      [9, '', 'invalid'],
      [10, 'W-000006', 'invalid'],
    ]);
  });

  it('keeps the file’s figures beside the parcel each row found', () => {
    const { rows } = matchPayoutCsv(csvOf(FILE), PRESET, parcels);
    expect(rows[1]).toEqual({
      row: 3,
      key: 'W-000002',
      outcome: 'different',
      shipmentId: 's2',
      payout: null,
      fileCollected: '300.0000',
      fileCharge: '60.0000',
    });
    expect(rows[2]).toMatchObject({
      shipmentId: 's3',
      fileCollected: null,
      fileCharge: '120.0000',
    });
    expect(rows[3]).toMatchObject({ shipmentId: null, payout: PAYOUT });
    expect(rows[4]).toMatchObject({ shipmentId: 's5', payout: null });
    expect(rows[5]).toMatchObject({ shipmentId: null, fileCollected: '100.0000' });
    // An invalid row says nothing it could not read
    expect(rows[8]).toMatchObject({ shipmentId: null, fileCollected: null, fileCharge: null });
  });

  it('sums the file’s net over the rows this payout can take only', () => {
    // (538 + 300 + 0) − (60 + 60 + 120)
    expect(matchPayoutCsv(csvOf(FILE), PRESET, parcels).fileNet).toBe('598.0000');
  });

  it('has no net without both amount columns', () => {
    const csv = csvOf(FILE);
    expect(matchPayoutCsv(csv, { ...PRESET, chargeColumn: null }, parcels).fileNet).toBeNull();
    expect(matchPayoutCsv(csv, { ...PRESET, collectedColumn: null }, parcels).fileNet).toBeNull();
  });

  it('never calls a row different without a collected column', () => {
    const { rows } = matchPayoutCsv(csvOf(FILE), { ...PRESET, collectedColumn: null }, parcels);
    expect(rows[1]).toMatchObject({ outcome: 'matched', fileCollected: null });
  });

  it('compares the amount, not the way it is written', () => {
    const csv = csvOf('Invoice,COD Amount\nW-000001,"৳ 538.00"');
    expect(matchPayoutCsv(csv, PRESET, parcels).rows[0]?.outcome).toBe('matched');
  });

  it('compares keys exactly', () => {
    const csv = csvOf('Invoice,COD Amount\nw-000001,538');
    expect(matchPayoutCsv(csv, PRESET, parcels).rows[0]?.outcome).toBe('unknown');
  });

  it('lets a key whose first row was invalid count on a later row', () => {
    const csv = csvOf('Invoice,COD Amount\nW-000001,-538\nW-000001,538');
    expect(matchPayoutCsv(csv, PRESET, parcels).rows.map((row) => row.outcome)).toEqual([
      'invalid',
      'matched',
    ]);
  });
});

describe('payoutKindOf', () => {
  const cod: PayableParcel = {
    status: 'delivered',
    receiptId: RECEIPT,
    receiptStatus: 'posted',
    receiptAccountId: COD_ACCOUNT,
    collectedAmount: '538.0000',
    courierCharge: '60.0000',
  };
  const charge: PayableParcel = {
    status: 'returned',
    receiptId: null,
    receiptStatus: null,
    receiptAccountId: null,
    collectedAmount: null,
    courierCharge: '120.0000',
  };

  it('takes a posted COD receipt into the account’s COD account now', () => {
    expect(payoutKindOf(cod, COD_ACCOUNT)).toBe('cod');
  });

  it('does not take a voided receipt, one into an older COD account, or any without a COD account', () => {
    expect(payoutKindOf({ ...cod, receiptStatus: 'voided' }, COD_ACCOUNT)).toBeNull();
    expect(payoutKindOf({ ...cod, receiptAccountId: OLD_COD_ACCOUNT }, COD_ACCOUNT)).toBeNull();
    expect(payoutKindOf(cod, null)).toBeNull();
  });

  it('never makes a charge line of a parcel whose receipt was voided', () => {
    expect(
      payoutKindOf({ ...cod, receiptStatus: 'voided', collectedAmount: '0' }, COD_ACCOUNT),
    ).toBeNull();
  });

  it('takes a charge on a journey that is over, with nothing collected', () => {
    for (const status of ['delivered', 'partly_delivered', 'returned', 'cancelled'] as const) {
      expect(payoutKindOf({ ...charge, status }, COD_ACCOUNT)).toBe('charge');
    }
    expect(payoutKindOf({ ...charge, collectedAmount: '0.0000' }, null)).toBe('charge');
  });

  it('does not take a parcel on its way', () => {
    for (const status of [
      'booking',
      'booked',
      'picked_up',
      'in_transit',
      'on_hold',
      'returning',
    ] as const) {
      expect(payoutKindOf({ ...charge, status }, COD_ACCOUNT)).toBeNull();
    }
  });

  it('does not take a parcel delivered with cash and no receipt (typed by hand)', () => {
    expect(
      payoutKindOf({ ...charge, status: 'delivered', collectedAmount: '538.0000' }, COD_ACCOUNT),
    ).toBeNull();
  });

  it('does not take a parcel with no charge or a charge of zero', () => {
    expect(payoutKindOf({ ...charge, courierCharge: null }, COD_ACCOUNT)).toBeNull();
    expect(payoutKindOf({ ...charge, courierCharge: '0.0000' }, COD_ACCOUNT)).toBeNull();
  });
});
```

`payout-match.ts` is pure (28c.3), so every rule of the file is tested here in milliseconds, without containers. The
integration tests then only need one file that touches each outcome once.

- **`csvOf`** turns `readPayoutCsv`'s error code into a failed test at once. Without it, every test would need its
  own `typeof csv === 'string'` check before TypeScript lets it read `csv.rows`.
- **`readPayoutCsv`:** the row numbers are the spreadsheet's (the header is row 1), so the dialog can say "row 7"
  and the member finds it in Excel. An empty row is skipped but still counts, so the rows after it keep their
  numbers. The byte order mark test matters because a browser's `FileReader` keeps the mark that Excel's "CSV
  UTF-8" writes; without `bom: true` the first column would be `﻿Invoice` and the preset would never match.
  200 columns are taken and 201 are refused, and 5,000 rows are taken and 5,001 refused, so both limits are tested
  at their edge, not just "somewhere above". Empty rows at the end do not count against the 5,000.
- **`missingColumns`:** case is ignored, because the preset is a guess (decision 11). A column the map leaves out
  (`null`) is never "missing".
- **`readAmount`:** the ways a courier writes money (`1,250`, `৳ 1,250.50`, `Tk 80`, `tk. 80`, `80 BDT`) all read,
  and come back with 4 decimals like every amount the API sends. An empty cell is `null`, not zero: "the file says
  nothing" must never look like "the rider collected ৳0". A minus, a third decimal and words are refused, so a row
  is shown as invalid instead of being read wrongly.
- **`matchPayoutCsv`:** one file with one row of every outcome, in the order of the file. The fixture's comments
  give each row's number and why it ends where it does. The net counts only the rows this payout can take
  (matched and different): `(538 + 300 + 0) − (60 + 60 + 120)`. With either amount column left out, there is no net
  and no "different". `"৳ 538.00"` against our `538.0000` is a match (the amount is compared, not the text), while
  `w-000001` against `W-000001` is unknown (keys are compared exactly, mine 35). The last test pins down a detail: an
  invalid row does not "use up" its key, so a corrected row further down still matches.
- **`payoutKindOf`:** a voided receipt, a receipt into an older COD account and an account with no COD account give
  no cod line. A parcel whose receipt was voided never becomes a charge line either, even with nothing collected:
  its money left the COD account when the receipt was voided, and a charge line for it would take the courier's
  charge out twice. A charge line needs the journey to be over (every status of `JOURNEY_OVER` is tried, and every
  status on the way), nothing collected, and a charge above zero. A parcel delivered with cash and no receipt (an
  account that had no COD account then) is not a charge line: its cash was typed by hand.

### The payouts, on the real stack

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
  journalEntrySchema,
  memberPageSchema,
  type Payout,
  payoutMatchSchema,
  payoutPageSchema,
  payoutParcelsSchema,
  payoutSchema,
  payoutSetupSchema,
  type PermissionKey,
  problemSchema,
  receiptSchema,
  roleSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  type StorefrontShipment,
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
import { joinWithoutRoles } from '../../testing/workspace.js';

// Step 28c: the courier's payout, on the real stack (Postgres, Redis, Mailpit, the API and the
// worker, with the fake courier). A courier pays the riders' cash out to the bank with its charges
// taken off; a payout takes the parcels it paid and posts Dr bank (net) + Dr charges / Cr the COD
// account. The courier's CSV is matched against the account's parcels first. Every test places
// its own orders, with its own phone and shopper address (n), so the shop's limits never stop a
// test, and never counts parcels another test made.
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let owner: SignedIn;
// storefront.payout.manage only, and every storefront.* permission but that one
let payer: SignedIn;
let clerk: SignedIn;
let shop: OrderShop;
// The COD money account, the courier charges account, and the cash account (1110) a payout goes
// into
let codAccount: Account;
let chargeAccount: Account;
let bankId: string;
// Steadfast by its API with both accounts; Pathao by hand with the COD account only; RedX by hand
// with none
let steadfast: CourierAccount;
let steadfastToken: string;
let pathao: CourierAccount;
let redx: CourierAccount;

// Two face washes (৳229 each) and the ৳80 delivery charge
const TOTAL = '538';
const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
// Each test places a few orders and waits a second between two courier steps of one parcel
const COURIER_CLOCK = 60_000;

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

async function move(id: string, step: string, body: object): Promise<StorefrontOrder> {
  const res = await send('POST', `/storefront/orders/${id}/${step}`, body);
  expect(res.statusCode, `${step}: ${res.body}`).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

// Placed by shopper n, confirmed with the code from Mailpit, and given its sales order by the
// worker: ready to pack
async function confirm(n: number): Promise<StorefrontOrder> {
  const phone = phoneOf(n);
  const headers = shopHeaders(shop.host, clientAddress(n));
  const token = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, TOTAL));
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

// Packed, and booked with Steadfast by the worker
async function booked(n: number): Promise<StorefrontOrder> {
  const order = await confirm(n);
  await move(order.id, 'pack', {
    version: order.version,
    lines: WHOLE,
    courierAccountId: steadfast.id,
  });
  return eventually(async () => {
    const now = await getOrder(order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
}

// Steadfast's webhook for this order's newest parcel. The fake courier gives no time, so a step's
// time is the moment it reached the API: the wait keeps two steps of one parcel a second apart
async function notice(order: StorefrontOrder, body: object): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${steadfast.id}`,
    headers: { authorization: `Bearer ${steadfastToken}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(order.shipments.at(-1)?.consignmentId),
      ...body,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

// An order and its newest parcel, as the order page shows them now. The parcel's courier invoice
// is the order number (W-000123): each test's order has one parcel
interface Sent {
  order: StorefrontOrder;
  parcel: StorefrontShipment;
}

async function sentOf(order: StorefrontOrder): Promise<Sent> {
  const now = await getOrder(order.id);
  const parcel = now.shipments.at(-1);
  if (parcel === undefined) throw new Error(`${order.orderNo} has no parcel`);
  return { order: now, parcel };
}

// Delivered by Steadfast: the rider collected cod (its COD receipt is posted) and the courier
// charged charge
async function delivered(n: number, cod = 538, charge = 80): Promise<Sent> {
  const order = await booked(n);
  await notice(order, { status: 'delivered', cod_amount: cod, delivery_charge: charge });
  const sent = await sentOf(order);
  expect(sent.parcel.receipt, `${order.orderNo} has no COD receipt`).not.toBeNull();
  return sent;
}

// Cancelled by Steadfast with its charge, and received back by a member: a charge line
async function returned(n: number, charge = 50): Promise<Sent> {
  const order = await booked(n);
  await notice(order, { status: 'pending' });
  await notice(order, { status: 'cancelled', delivery_charge: charge });
  const now = await getOrder(order.id);
  await move(now.id, 'return', { version: now.version, reason: '' });
  return sentOf(order);
}

// Booked by hand with Pathao, shipped and marked delivered: the COD receipt is the whole ৳538
async function deliveredByHand(n: number): Promise<Sent> {
  const order = await confirm(n);
  const packed = await move(order.id, 'pack', {
    version: order.version,
    lines: WHOLE,
    courierAccountId: '',
  });
  const withParcel = await move(order.id, 'shipments', {
    version: packed.version,
    accountId: pathao.id,
    trackingCode: `PTH-${order.orderNo}`,
  });
  const shipped = await move(order.id, 'ship', { version: withParcel.version });
  await move(order.id, 'deliver', { version: shipped.version, collectedAmount: null });
  return sentOf(order);
}

async function receiptOf(sent: Sent) {
  const res = await send('GET', `/receipts/${sent.parcel.receipt?.id ?? ''}`);
  expect(res.statusCode, res.body).toBe(200);
  return receiptSchema.parse(res.json());
}

// The day of a parcel's COD receipt: today in the workspace's time zone, the day a payout of it
// is dated in these tests
async function today(sent: Sent): Promise<string> {
  return (await receiptOf(sent)).date;
}

function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// A payout of these parcels, each with its charge, into the cash account
function payoutBody(date: string, lines: [Sent, string][], account = steadfast) {
  return {
    accountId: account.id,
    date,
    bankAccountId: bankId,
    reference: 'SFC-23618228',
    note: '',
    lines: lines.map(([sent, charge]) => ({ shipmentId: sent.parcel.id, charge })),
  };
}

async function pay(body: object): Promise<Payout> {
  const res = await send('POST', '/storefront/payouts', body);
  expect(res.statusCode, res.body).toBe(201);
  return payoutSchema.parse(res.json());
}

async function refused(
  method: 'GET' | 'POST',
  url: string,
  body: object | undefined,
  status: number,
) {
  const res = await send(method, url, body);
  expect(res.statusCode, res.body).toBe(status);
  return refusalSchema.parse(res.json());
}

// The new payout page's list of this account
async function payable(account: CourierAccount) {
  const res = await send('GET', `/storefront/couriers/${account.id}/payout-parcels`);
  expect(res.statusCode, res.body).toBe(200);
  return payoutParcelsSchema.parse(res.json());
}

async function match(account: CourierAccount, csv: string, map: object | null = null) {
  const res = await send('POST', `/storefront/couriers/${account.id}/payout-match`, { csv, map });
  expect(res.statusCode, res.body).toBe(200);
  return payoutMatchSchema.parse(res.json());
}

// A courier account as the Shop couriers page shows it now
async function courierAccount(id: string) {
  const setup = courierSetupSchema.parse((await send('GET', '/storefront/couriers')).json());
  const found = setup.accounts.find((account) => account.id === id);
  if (found === undefined) throw new Error(`no courier account ${id}`);
  return found;
}

// What it holds: the page's "৳45,200 · 18 parcels"
async function holdsOf(id: string) {
  return (await courierAccount(id)).holds;
}

// An entry's lines as [account, debit, credit], by the accounts' names in this test
async function entryLines(id: string) {
  const res = await send('GET', `/journal-entries/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  const entry = journalEntrySchema.parse(res.json());
  const name = (accountId: string) =>
    accountId === codAccount.id
      ? 'cod'
      : accountId === chargeAccount.id
        ? 'charges'
        : accountId === bankId
          ? 'bank'
          : accountId;
  return entry.lines
    .map((line) => [name(line.accountId), line.debit, line.credit])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

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
// When the gate opens, they run in the order they were sent
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
  shop = await orderShop(app, sql, owner, { slug: 'nirvor', name: 'Nirvor', stock: 400 });

  // The COD account sits next to Cash in hand (1110), the charge account under the first expense
  // group, as in 28b's cod.int.spec.ts
  const chart = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  bankId = cash.id;
  codAccount = await ledgerAccount(cash.parentId, '1191', 'Cash with couriers', true);
  chargeAccount = await ledgerAccount(expenses.id, '5998', 'Courier charges', false);

  const api = await send('POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast Dhaka',
    apiKey: 'sf-api-7k2m9q4x',
    secretKey: 'sf-secret-4n8p1x6w',
    codAccountId: codAccount.id,
    chargeAccountId: chargeAccount.id,
  });
  expect(api.statusCode, api.body).toBe(201);
  const made = courierAccountSavedSchema.parse(api.json());
  steadfast = made.account;
  steadfastToken = made.webhookToken ?? '';
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

  payer = await member('shamim@nirvor.com', 'Shamim Ahmed', ['storefront.payout.manage']);
  clerk = await member('rafiq@nirvor.com', 'Rafiq Islam', [
    'storefront.manage',
    'storefront.order.read',
    'storefront.order.manage',
  ]);
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('the parcels a payout can take', () => {
  it(
    'offers the COD parcels and the charge lines, never a parcel on its way or a voided receipt',
    async () => {
      const cod = await delivered(1);
      const charge = await returned(2, 50);
      const onItsWay = await sentOf(await booked(3));
      const voided = await delivered(4);
      const receipt = await receiptOf(voided);
      const res = await send('POST', `/receipts/${receipt.id}/void`, {
        version: receipt.version,
        date: receipt.date,
        reason: 'The rider handed in the wrong parcel',
      });
      expect(res.statusCode, res.body).toBe(200);

      const { account, parcels, csvMap } = await payable(steadfast);
      expect(account).toMatchObject({
        id: steadfast.id,
        codAccount: { id: codAccount.id },
        chargeAccount: { id: chargeAccount.id },
      });
      expect(csvMap).toBeNull();
      const ids = parcels.map((parcel) => parcel.shipmentId);
      expect(ids).not.toContain(onItsWay.parcel.id);
      expect(ids).not.toContain(voided.parcel.id);
      expect(parcels.find((parcel) => parcel.shipmentId === cod.parcel.id)).toMatchObject({
        kind: 'cod',
        order: { id: cod.order.id, number: cod.order.orderNo },
        invoice: cod.order.orderNo,
        collected: '538.0000',
        courierCharge: '80.0000',
        receipt: { id: cod.parcel.receipt?.id },
        receiptDate: receipt.date,
      });
      expect(parcels.find((parcel) => parcel.shipmentId === charge.parcel.id)).toMatchObject({
        kind: 'charge',
        collected: '0.0000',
        courierCharge: '50.0000',
        receipt: null,
        receiptDate: null,
      });
      // The COD parcels by their receipt's day first, then the charge lines
      const kinds = parcels.map((parcel) => parcel.kind);
      expect(kinds.indexOf('charge')).toBeGreaterThan(kinds.lastIndexOf('cod'));
      // Another account's list does not have them
      const byHand = (await payable(pathao)).parcels.map((parcel) => parcel.shipmentId);
      expect(byHand).not.toContain(cod.parcel.id);
    },
    COURIER_CLOCK,
  );

  it('lists every courier account, archived ones last, and the accounts money can go into', async () => {
    const spare = await send('POST', '/storefront/couriers', {
      provider: 'manual',
      name: 'Paperfly spare',
      courier: 'paperfly',
      codAccountId: '',
      chargeAccountId: '',
    });
    expect(spare.statusCode, spare.body).toBe(201);
    const saved = courierAccountSavedSchema.parse(spare.json()).account;
    const archived = await send('POST', `/storefront/couriers/${saved.id}/archive`, {
      version: saved.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const setup = payoutSetupSchema.parse((await send('GET', '/storefront/payout-setup')).json());
    expect(setup.accounts.at(-1)).toMatchObject({ id: saved.id, archived: true });
    expect(setup.accounts.find((account) => account.id === redx.id)).toMatchObject({
      archived: false,
      codAccount: null,
      chargeAccount: null,
    });
    const codes = setup.bankAccounts.map((account) => account.code);
    expect(codes).toEqual(expect.arrayContaining(['1110', '1191']));
    expect(codes).not.toContain('5998');
  });
});

describe('the courier’s file', () => {
  it(
    'accounts for every row with the preset, and names the payout a paid parcel is in',
    async () => {
      const a = await delivered(10);
      const b = await delivered(11);
      const c = await returned(12, 50);
      const d = await booked(13);
      const csv = [
        'Invoice,COD Amount,Delivery Charge',
        `${a.order.orderNo},538,80`,
        `${b.order.orderNo},"1,000",60`,
        `${c.order.orderNo},0,50`,
        `${d.orderNo},538,80`,
        'W-999999,10,1',
        `${a.order.orderNo},538,80`,
        ',1,1',
        `${a.order.orderNo}x,N/A,1`,
        '',
      ].join('\n');
      // With the byte order mark of Excel's "CSV UTF-8", which the browser's FileReader keeps
      const first = await match(steadfast, `\uFEFF${csv}`);
      expect(first).toMatchObject({
        columns: ['Invoice', 'COD Amount', 'Delivery Charge'],
        map: { key: 'invoice', keyColumn: 'Invoice' },
        missing: [],
        // (538 + 1,000 + 0) − (80 + 60 + 50): the rows this payout can take only
        fileNet: '1348.0000',
      });
      expect(first.rows.map((row) => [row.row, row.outcome])).toEqual([
        [2, 'matched'],
        [3, 'different'],
        [4, 'matched'],
        [5, 'not_ready'],
        [6, 'unknown'],
        [7, 'twice'],
        [8, 'invalid'],
        [9, 'invalid'],
      ]);
      expect(first.rows[0]).toMatchObject({ shipmentId: a.parcel.id, fileCollected: '538.0000' });
      expect(first.rows[1]).toMatchObject({ shipmentId: b.parcel.id, fileCollected: '1000.0000' });
      // The preset is not saved: only a map the member gives is
      expect((await payable(steadfast)).csvMap).toBeNull();

      const payout = await pay(payoutBody(await today(a), [[a, '80']]));
      const again = await match(steadfast, csv);
      expect(again.rows[0]).toMatchObject({
        outcome: 'already_paid',
        shipmentId: null,
        payout: { id: payout.id, number: payout.number },
      });
    },
    COURIER_CLOCK,
  );

  it(
    'saves a map the member gave once the file has its columns, and uses it next time',
    async () => {
      const sent = await deliveredByHand(20);
      const csv = `Parcel ID,Collected\n${sent.parcel.trackingCode ?? ''},538\n`;
      // A manual account has no preset: the mapping step, with the file's columns
      expect(await match(pathao, csv)).toEqual({
        columns: ['Parcel ID', 'Collected'],
        map: null,
        missing: [],
        rows: [],
        fileNet: null,
      });
      // A map the file lacks: what is missing, no rows, nothing saved
      const wrong = {
        key: 'tracking_code',
        keyColumn: 'Tracking',
        collectedColumn: 'Collected',
        chargeColumn: '',
      };
      expect(await match(pathao, csv, wrong)).toMatchObject({ missing: ['Tracking'], rows: [] });
      expect((await payable(pathao)).csvMap).toBeNull();
      // One that fits (any case): matched and saved, and the account's version does not move
      const matched = await match(pathao, csv, { ...wrong, keyColumn: 'parcel id' });
      expect(matched.rows[0]).toMatchObject({ outcome: 'matched', shipmentId: sent.parcel.id });
      // Only one of the two amounts is mapped, so the file's net would be a guess
      expect(matched.fileNet).toBeNull();
      const saved = {
        key: 'tracking_code',
        keyColumn: 'parcel id',
        collectedColumn: 'Collected',
        chargeColumn: null,
      };
      expect((await payable(pathao)).csvMap).toEqual(saved);
      expect((await courierAccount(pathao.id)).version).toBe(pathao.version);
      // map null now reads with the saved one
      expect(await match(pathao, csv)).toMatchObject({ map: saved, missing: [] });
    },
    COURIER_CLOCK,
  );

  it('refuses a file it cannot read, one of too many rows and one too long', async () => {
    const url = `/storefront/couriers/${steadfast.id}/payout-match`;
    const broken = await refused(
      'POST',
      url,
      { csv: 'Invoice,"COD Amount\nW-1,538', map: null },
      422,
    );
    expect(broken).toMatchObject({
      code: 'payout_csv_unreadable',
      fieldErrors: { csv: ['payout_csv_unreadable'] },
    });
    const rows = Array.from({ length: 5001 }, (_, i) => `W-${String(i).padStart(6, '0')},1,1`);
    const csv = ['Invoice,COD Amount,Delivery Charge', ...rows].join('\n');
    expect((await refused('POST', url, { csv, map: null }, 422)).code).toBe(
      'payout_csv_too_many_rows',
    );
    const big = await refused('POST', url, { csv: 'x'.repeat(1_000_001), map: null }, 400);
    expect(big.fieldErrors).toEqual({ csv: ['payout_csv_too_big'] });
  });
});

describe('a payout', () => {
  it(
    'posts the bank, the charges and the COD account, and takes its parcels',
    async () => {
      const a = await delivered(30, 538, 80);
      const b = await delivered(31, 538, 60);
      const c = await returned(32, 50);
      const day = await today(a);
      const holds = await holdsOf(steadfast.id);
      const payout = await pay({
        ...payoutBody(day, [
          [a, '80'],
          [b, '60'],
          [c, '50'],
        ]),
        note: 'Steadfast weekly payout',
      });
      const [branch] = z
        .array(z.object({ id: z.string() }))
        .parse(
          await sql`SELECT branch_id::text AS id FROM warehouses WHERE id = ${shop.warehouseId}`,
        );
      expect(payout).toMatchObject({
        date: day,
        account: { id: steadfast.id, name: 'Steadfast Dhaka', courier: 'steadfast' },
        bankAccountId: bankId,
        codAccountId: codAccount.id,
        chargeAccountId: chargeAccount.id,
        branchId: branch?.id,
        reference: 'SFC-23618228',
        note: 'Steadfast weekly payout',
        parcels: 3,
        collected: '1076.0000',
        charges: '190.0000',
        net: '886.0000',
        status: 'posted',
        voidEntry: null,
      });
      expect(payout.number).toMatch(/^CPO-/);
      // By invoice; a charge line names no receipt
      expect(
        payout.lines.map((line) => [line.invoice, line.kind, line.collected, line.charge]),
      ).toEqual([
        [a.order.orderNo, 'cod', '538.0000', '80.0000'],
        [b.order.orderNo, 'cod', '538.0000', '60.0000'],
        [c.order.orderNo, 'charge', '0.0000', '50.0000'],
      ]);
      expect(payout.lines.map((line) => line.receipt?.id ?? null)).toEqual([
        a.parcel.receipt?.id,
        b.parcel.receipt?.id,
        null,
      ]);
      expect(await entryLines(payout.entry.id)).toEqual([
        ['bank', '886.0000', '0.0000'],
        ['charges', '190.0000', '0.0000'],
        ['cod', '0.0000', '1076.0000'],
      ]);
      // The courier holds the paid parcels no more, and each parcel card names the payout
      expect(await holdsOf(steadfast.id)).toEqual({
        amount: (Number(holds.amount) - 1076).toFixed(4),
        parcels: holds.parcels - 2,
      });
      expect((await sentOf(a.order)).parcel.payout).toEqual({
        id: payout.id,
        number: payout.number,
      });
      // Taken: a second payout of the same parcel says which line
      const twice = await refused('POST', '/storefront/payouts', payoutBody(day, [[b, '60']]), 409);
      expect(twice).toMatchObject({
        code: 'payout_parcel_unavailable',
        fieldErrors: { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      });
      expect(
        payoutSchema.parse((await send('GET', `/storefront/payouts/${payout.id}`)).json()),
      ).toEqual(payout);
      const [logged] = await sql`SELECT payload->'changes'->'net'->>'to' AS net FROM audit_logs
        WHERE tenant_id = ${shop.tenantId} AND action = 'storefront_payout.created'
          AND entity_id = ${payout.id}`;
      expect(logged?.net).toBe('886.0000');
    },
    COURIER_CLOCK,
  );

  it(
    'posts no bank line when the charges take all of the cash, and no charge line without charges',
    async () => {
      const all = await delivered(40, 538, 80);
      const day = await today(all);
      const zero = await pay(payoutBody(day, [[all, '538']]));
      expect(zero.net).toBe('0.0000');
      expect(await entryLines(zero.entry.id)).toEqual([
        ['charges', '538.0000', '0.0000'],
        ['cod', '0.0000', '538.0000'],
      ]);
      // Pathao has no charges account: a payout with no charge needs none
      const byHand = await deliveredByHand(41);
      const plain = await pay(payoutBody(day, [[byHand, '0']], pathao));
      expect(plain.chargeAccountId).toBeNull();
      expect(await entryLines(plain.entry.id)).toEqual([
        ['bank', '538.0000', '0.0000'],
        ['cod', '0.0000', '538.0000'],
      ]);
    },
    COURIER_CLOCK,
  );

  it(
    'refuses what the books or the parcels cannot take, each under its box',
    async () => {
      const a = await delivered(50, 538, 80);
      const charge = await returned(51, 50);
      const onItsWay = await sentOf(await booked(52));
      const byHand = await deliveredByHand(53);
      const day = await today(a);
      const body = payoutBody(day, [[a, '80']]);
      const line = (sent: Sent, amount: string) => ({ shipmentId: sent.parcel.id, charge: amount });
      const cases: [object, number, string, Record<string, string[]>][] = [
        // The COD account is no bank, and an expense account holds no money
        [
          { bankAccountId: codAccount.id },
          422,
          'payout_bank_account_invalid',
          { bankAccountId: ['payout_bank_account_invalid'] },
        ],
        [
          { bankAccountId: chargeAccount.id },
          422,
          'payout_bank_account_invalid',
          { bankAccountId: ['payout_bank_account_invalid'] },
        ],
        // RedX has no COD account; Pathao no charges account for a charge
        [
          { accountId: redx.id },
          422,
          'payout_account_no_cod',
          { accountId: ['payout_account_no_cod'] },
        ],
        [
          payoutBody(day, [[byHand, '10']], pathao),
          422,
          'payout_account_no_charges',
          { accountId: ['payout_account_no_charges'] },
        ],
        // A charge line of ৳0, the charges over the cash, a charge line alone
        [
          { lines: [line(a, '80'), line(charge, '0')] },
          422,
          'payout_charge_line_zero',
          { 'lines.1.charge': ['payout_charge_line_zero'] },
        ],
        [{ lines: [line(a, '600')] }, 422, 'payout_below_zero', {}],
        [{ lines: [line(charge, '50')] }, 422, 'payout_below_zero', {}],
        // Before its COD receipt
        [
          { date: dayBefore(day) },
          422,
          'payout_date_before_receipt',
          { date: ['payout_date_before_receipt'] },
        ],
        // A parcel on its way, and one of another courier account
        [
          { lines: [line(a, '80'), line(onItsWay, '0')] },
          409,
          'payout_parcel_unavailable',
          { 'lines.1.shipmentId': ['payout_parcel_unavailable'] },
        ],
        [
          { lines: [line(byHand, '0')] },
          409,
          'payout_parcel_unavailable',
          { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
        ],
      ];
      for (const [wrong, status, code, fieldErrors] of cases) {
        const problem = await refused('POST', '/storefront/payouts', { ...body, ...wrong }, status);
        expect(problem.code, JSON.stringify(wrong)).toBe(code);
        expect(problem.fieldErrors ?? {}, code).toEqual(fieldErrors);
      }
      // The receipt's day, for the message
      const early = await refused(
        'POST',
        '/storefront/payouts',
        { ...body, date: dayBefore(day) },
        422,
      );
      expect(early.params).toEqual({ date: day });
      // The contract's own: the same parcel twice, on the second line
      const same = await refused(
        'POST',
        '/storefront/payouts',
        { ...body, lines: [line(a, '80'), line(a, '0')] },
        400,
      );
      expect(same.fieldErrors).toEqual({ 'lines.1.shipmentId': ['payout_line_twice'] });
      // Nothing was saved, and the parcel can still be paid out
      const [none] = await sql`SELECT count(*)::int AS n FROM storefront_payout_lines
        WHERE tenant_id = ${shop.tenantId} AND shipment_id = ${a.parcel.id}`;
      expect(none?.n).toBe(0);
      await pay(body);
    },
    COURIER_CLOCK,
  );

  it(
    'is refused in a closed period',
    async () => {
      const a = await delivered(60);
      const day = await today(a);
      await sql`INSERT INTO period_locks (tenant_id, lock_date) VALUES (${shop.tenantId}, ${day})
        ON CONFLICT (tenant_id) DO UPDATE SET lock_date = EXCLUDED.lock_date`;
      try {
        const res = await send('POST', '/storefront/payouts', payoutBody(day, [[a, '80']]));
        expect(refusalSchema.parse(res.json()).code, res.body).toBe('journal_period_locked');
      } finally {
        await sql`UPDATE period_locks SET lock_date = NULL WHERE tenant_id = ${shop.tenantId}`;
      }
      await pay(payoutBody(day, [[a, '80']]));
    },
    COURIER_CLOCK,
  );

  it(
    'still pays out an archived courier account’s parcels',
    async () => {
      const a = await deliveredByHand(70);
      const day = await today(a);
      const current = await courierAccount(pathao.id);
      const archived = await send('POST', `/storefront/couriers/${pathao.id}/archive`, {
        version: current.version,
      });
      expect(archived.statusCode, archived.body).toBe(200);
      try {
        const ids = (await payable(pathao)).parcels.map((parcel) => parcel.shipmentId);
        expect(ids).toContain(a.parcel.id);
        await pay(payoutBody(day, [[a, '0']], pathao));
      } finally {
        const now = courierAccountSchema.parse(archived.json());
        const back = await send('POST', `/storefront/couriers/${pathao.id}/restore`, {
          version: now.version,
        });
        expect(back.statusCode, back.body).toBe(200);
      }
    },
    COURIER_CLOCK,
  );
});

describe('voiding a payout', () => {
  it(
    'reverses its entry and frees its parcels, on its own page only',
    async () => {
      const a = await delivered(80, 538, 80);
      const c = await returned(81, 50);
      const day = await today(a);
      const payout = await pay(
        payoutBody(day, [
          [a, '80'],
          [c, '50'],
        ]),
      );
      // The journal does not undo it, and its COD receipt cannot be voided while it is paid out
      const entry = journalEntrySchema.parse(
        (await send('GET', `/journal-entries/${payout.entry.id}`)).json(),
      );
      const reverse = await refused(
        'POST',
        `/journal-entries/${entry.id}/reverse`,
        { version: entry.version, date: day },
        409,
      );
      expect(reverse.code).toBe('journal_is_payout');
      const receipt = await receiptOf(a);
      const voidReceipt = { version: receipt.version, date: day, reason: 'Typed by mistake' };
      expect((await refused('POST', `/receipts/${receipt.id}/void`, voidReceipt, 409)).code).toBe(
        'receipt_paid_out',
      );

      const url = `/storefront/payouts/${payout.id}/void`;
      const reason = 'Steadfast sent it twice';
      const early = await refused(
        'POST',
        url,
        { version: payout.version, date: dayBefore(day), reason },
        409,
      );
      expect(early).toMatchObject({
        code: 'receipt_void_date',
        fieldErrors: { date: ['receipt_void_date'] },
      });
      const stale = await refused(
        'POST',
        url,
        { version: payout.version + 1, date: day, reason },
        409,
      );
      expect(stale.code).toBe('version_conflict');
      const res = await send('POST', url, { version: payout.version, date: day, reason });
      expect(res.statusCode, res.body).toBe(200);
      const voided = payoutSchema.parse(res.json());
      expect(voided).toMatchObject({
        status: 'voided',
        voidDate: day,
        voidReason: reason,
        version: payout.version + 1,
        entry: { id: payout.entry.id },
      });
      // The lines stay, so the page still shows what it paid
      expect(voided.lines).toHaveLength(2);
      expect(await entryLines(voided.voidEntry?.id ?? '')).toEqual([
        ['bank', '0.0000', '408.0000'],
        ['charges', '0.0000', '130.0000'],
        ['cod', '538.0000', '0.0000'],
      ]);
      const again = await refused('POST', url, { version: voided.version, date: day, reason }, 409);
      expect(again.code).toBe('payout_voided');

      // Its parcels can be paid out again, and its COD receipt could be voided now
      expect((await sentOf(a.order)).parcel.payout).toBeNull();
      const ids = (await payable(steadfast)).parcels.map((parcel) => parcel.shipmentId);
      expect(ids).toEqual(expect.arrayContaining([a.parcel.id, c.parcel.id]));
      const next = await pay(
        payoutBody(day, [
          [a, '80'],
          [c, '50'],
        ]),
      );
      expect(next.number).not.toBe(payout.number);
    },
    COURIER_CLOCK,
  );
});

describe('at the same moment', () => {
  it(
    'lets one of two payouts of the same parcel through',
    async () => {
      const a = await delivered(90);
      const body = payoutBody(await today(a), [[a, '80']]);
      // The first holds the parcel's lock and waits at the journal; the second waits for the
      // parcel, then finds it paid out, so it can say which line (without the lock it would get as
      // far as the parcel's UPDATE, find nothing to update, and name no line)
      const [first, second] = await inTurn('journal_entries', [
        () => send('POST', '/storefront/payouts', body),
        () => send('POST', '/storefront/payouts', body),
      ]);
      expect(first?.statusCode, first?.body).toBe(201);
      expect(second?.statusCode, second?.body).toBe(409);
      expect(refusalSchema.parse(second?.json())).toMatchObject({
        code: 'payout_parcel_unavailable',
        fieldErrors: { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      });
      const [lines] = await sql`SELECT count(*)::int AS n FROM storefront_payout_lines
        WHERE tenant_id = ${shop.tenantId} AND shipment_id = ${a.parcel.id}`;
      expect(lines?.n).toBe(1);
    },
    COURIER_CLOCK,
  );

  it(
    'takes turns with voiding the COD receipt: the payout first, so the void is refused',
    async () => {
      const a = await delivered(91);
      const receipt = await receiptOf(a);
      // The payout's line reads the receipt FOR SHARE; the void waits for that lock
      const [payout, voidIt] = await inTurn('journal_entries', [
        () => send('POST', '/storefront/payouts', payoutBody(receipt.date, [[a, '80']])),
        () =>
          send('POST', `/receipts/${receipt.id}/void`, {
            version: receipt.version,
            date: receipt.date,
            reason: 'The rider handed in the wrong parcel',
          }),
      ]);
      expect(payout?.statusCode, payout?.body).toBe(201);
      expect(voidIt?.statusCode, voidIt?.body).toBe(409);
      expect(refusalSchema.parse(voidIt?.json()).code).toBe('receipt_paid_out');
    },
    COURIER_CLOCK,
  );

  it(
    'takes turns with voiding the COD receipt: the void first, so the payout is refused',
    async () => {
      const a = await delivered(92);
      const receipt = await receiptOf(a);
      // The void holds the receipt's lock and waits at the journal; the payout's line then waits
      // for the receipt and finds it voided (0083's parcel check)
      const [voidIt, payout] = await inTurn('journal_entries', [
        () =>
          send('POST', `/receipts/${receipt.id}/void`, {
            version: receipt.version,
            date: receipt.date,
            reason: 'The rider handed in the wrong parcel',
          }),
        () => send('POST', '/storefront/payouts', payoutBody(receipt.date, [[a, '80']])),
      ]);
      expect(voidIt?.statusCode, voidIt?.body).toBe(200);
      expect(payout?.statusCode, payout?.body).toBe(409);
      expect(refusalSchema.parse(payout?.json()).code).toBe('payout_parcel_unavailable');
      const [made] = await sql`SELECT count(*)::int AS n FROM storefront_payouts
        WHERE tenant_id = ${shop.tenantId} AND reference = 'SFC-23618228'
          AND id IN (SELECT payout_id FROM storefront_payout_lines WHERE shipment_id = ${a.parcel.id})`;
      expect(made?.n).toBe(0);
    },
    COURIER_CLOCK,
  );
});

describe('the list and who may use it', () => {
  it('filters by status and courier account, and pages newest first', async () => {
    const all = payoutPageSchema.parse((await send('GET', '/storefront/payouts?limit=100')).json());
    expect(all.items.length).toBeGreaterThan(3);
    const voided = payoutPageSchema.parse(
      (await send('GET', '/storefront/payouts?status=voided')).json(),
    );
    expect(voided.items.length).toBeGreaterThan(0);
    expect(voided.items.every((item) => item.status === 'voided')).toBe(true);
    const byHand = payoutPageSchema.parse(
      (await send('GET', `/storefront/payouts?accountId=${pathao.id}`)).json(),
    );
    expect(byHand.items.length).toBeGreaterThan(0);
    expect(byHand.items.every((item) => item.account.id === pathao.id)).toBe(true);
    // Two at a time, never one twice, in the full list's order
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const page = payoutPageSchema.parse(
        (await send('GET', `/storefront/payouts?limit=2${after}`)).json(),
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((item) => item.id));
  });

  it('needs storefront.payout.manage for every route, and nothing more to read them', async () => {
    const all = payoutPageSchema.parse((await send('GET', '/storefront/payouts')).json());
    const first = all.items[0];
    if (first === undefined) throw new Error('no payout yet');
    const day = first.date;
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', '/storefront/payout-setup'],
      ['GET', '/storefront/payouts'],
      ['GET', `/storefront/payouts/${first.id}`],
      ['GET', `/storefront/couriers/${steadfast.id}/payout-parcels`],
      [
        'POST',
        `/storefront/couriers/${steadfast.id}/payout-match`,
        { csv: 'Invoice\nW-1', map: null },
      ],
      [
        'POST',
        '/storefront/payouts',
        { ...payoutBody(day, []), lines: [{ shipmentId: first.id, charge: '0' }] },
      ],
      [
        'POST',
        `/storefront/payouts/${first.id}/void`,
        { version: first.version, date: day, reason: 'x' },
      ],
    ];
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body, clerk);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const [method, url, body] of routes.slice(0, 5)) {
      const res = await send(method, url, body, payer);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(200);
    }
  });
});
```

The helpers, in order:

- **Three courier accounts:** Steadfast by its API with both money accounts, Pathao by hand with the COD account
  only, and RedX by hand with none. Each refusal that depends on the account (no COD account, no charges account,
  another account's parcel) has its own account to test with. Steadfast and Pathao share the COD account on
  purpose: a Pathao parcel's receipt is in the right ledger account, so the only thing that refuses it under
  Steadfast is that it is another courier account's parcel.
- **Two members:** `payer` has only `storefront.payout.manage`; `clerk` has every other storefront permission. So the
  permission test proves both directions: the payout permission is needed, and nothing else is.
- **`Sent`:** an order and its newest parcel. The parcel view has no invoice and no order id (the order page already
  has both), so the helpers return the two together. A test's order has one parcel, so its courier invoice is the
  order number.
- **`delivered`, `returned`, `deliveredByHand`** are the three ways a parcel becomes payable: Steadfast's
  "delivered" with the rider's cash and the charge (a cod line); Steadfast's "cancelled" with a charge, then Receive
  the return (a charge line); and by hand with Pathao, then Mark delivered (a cod line with no courier's charge).
  `delivered` checks the COD receipt is there, so a test that later fails for "no receipt" fails here, with the order
  number, instead of far away.
- **`notice` waits a second before it sends,** not after. The fake courier gives no time, so the API dates a step
  by when it arrived, and a parcel's newest step wins (28a). Two steps of one parcel must be a second apart; waiting
  first also keeps the "delivered" after the worker's "booked".
- **`today`** is the COD receipt's own date, because the receipt is dated today in the workspace's time zone
  (Asia/Dhaka), which is not the test machine's day near midnight. A payout dated by the receipt can never be
  "before its receipt" by accident.
- **`refused`** checks the status and returns the code and the field errors, so each refusal is one line.
- **`entryLines`** names the three accounts and sorts the lines, so an entry reads as `['bank', '886.0000', '0.0000']`
  and a test does not depend on the order the books wrote them in.
- **`holdsOf`** is the Shop couriers page's own number. A test compares it with the value from before, never with a
  fixed sum, because the tests share one shop and earlier tests leave parcels behind.
- **`inTurn`** is 28a's gate. Here it locks `journal_entries`: a payout and a receipt's void both take their row
  locks first and write the journal last. So the first request sent holds its locks and waits at the gate, and the
  second waits for one of those locks. When the gate opens they run in the order they were sent.
- **`COURIER_CLOCK` is 60 seconds.** A test places up to four orders, each with its sales order from the worker and
  a second's wait per courier step.

What each test proves:

- **The parcels a payout can take.** A cod line with its receipt and its day, a charge line with no receipt and no
  day, and the cod lines before the charge lines. A parcel on its way and a parcel whose receipt was voided are not
  on the list, and another account's list does not have them.
- **The setup.** Every courier account, an archived one last; RedX with no money accounts. The bank choices are
  money accounts (the cash account and the COD account), never the expense account.
- **The preset.** The 28c.3 smoke file again, with the byte order mark: every outcome in order, the net ৳1,348, and
  the matched rows naming their parcels. The preset is not saved. After a payout, the same file says
  `already_paid` with the payout's number and no parcel id (mine 19: the dialog links the payout, and the row cannot
  be ticked).
- **A saved map.** A manual account has no preset, so its first file answers with the file's columns and nothing
  else (the mapping step). A map the file lacks says what is missing and is not saved. A map that fits (in another
  case) matches, is saved, and does not move the account's version (mine 21), and `map: null` then reads with it.
- **Files refused.** A quote never closed is `payout_csv_unreadable` under `csv` (a 422 from the service); 5,001
  rows is `payout_csv_too_many_rows`; and a text over 1,000,000 characters is the contract's own
  `payout_csv_too_big` (a 400, before the service is reached).
- **A payout.** Three lines (two cod, one charge): the payout's fields, its branch (the shop warehouse's), its lines
  by invoice, the entry Dr bank ৳886, Dr charges ৳190, Cr COD ৳1,076, Holds down by ৳1,076 and two parcels, the
  parcel card's payout, and the audit row's net. A second payout of a paid parcel names the line.
- **Net zero and no charges.** Charges that take all of the cash post no bank line (decision 3); a Pathao payout
  with no charge posts no charge line and needs no charges account.
- **Ten refusals,** each with its status and the exact field errors, then the contract's own "same parcel twice" on
  the second line. Worth noting: a payout of charge lines alone is always `payout_below_zero`. A charge line brings
  no cash, so its charge can only be taken off a cod line's cash; the courier keeps the charge for a returned parcel
  out of the next payout that has cash in it, which is exactly what the form lets the member do. After all the
  refusals nothing was saved, and the same parcel is then paid out.
- **A closed period.** A payout dated on the lock date is `journal_period_locked`, and goes through once the lock is
  lifted.
- **An archived courier account** still has its parcels on the list and pays them out (decision 4): archiving stops
  new bookings, not the money already with the courier.
- **Voiding.** The journal's Reverse is `journal_is_payout` and the paid-out receipt's void is `receipt_paid_out`. A
  void dated before the payout is `receipt_void_date` under `date`; an old version is `version_conflict`. Voided:
  the lines stay, the reversal is the entry turned around (Cr bank ৳408, Cr charges ৳130, Dr COD ৳538), a second
  void is `payout_voided`, and the parcels are free and paid out again under a new number.
- **Three races.** Two payouts of one parcel: one goes through, the other is `payout_parcel_unavailable` under
  `lines.0.shipmentId`, and the parcel is on one line. The field error is what makes the parcels' `FOR UPDATE`
  testable: with the lock, the second payout reads the parcel only after the first committed, sees it paid out, and
  names the line. Without it, the second would read the parcel as free, get as far as the parcel's
  `UPDATE … WHERE payout_id IS NULL`, update nothing, and answer a 409 that names no line. That is still safe (no
  parcel is paid twice), so only the field error tells the two apart. A payout and its receipt's void, the payout first: the void waits for the payout's line
  (which reads the receipt `FOR SHARE`) and is then `receipt_paid_out`. The void first: the payout's line waits for
  the receipt, finds it voided, and 0083's parcel check refuses the payout, which the API answers as
  `payout_parcel_unavailable`, and no payout is left with that parcel.
- **The list.** The status and account filters, and paging two at a time gives the full list's order with no payout
  twice.
- **Permissions.** Every route is 403 without `storefront.payout.manage`, even for a member with every other
  storefront permission. The create and void bodies are valid, so the 403 is the permission's, not a 400. With the
  permission alone, the five reads answer 200.

### Tenant leak

```ts
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  type CourierAccount,
  courierAccountSavedSchema,
  type Payout,
  payoutMatchSchema,
  payoutPageSchema,
  payoutSchema,
  payoutSetupSchema,
  problemSchema,
  receiptSchema,
  type StorefrontOrder,
  storefrontOrderSchema,
  type StorefrontShipment,
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

// Step 28c: a courier payout is a workspace's own. Two launched shops, Nirvor and Acme, each with
// its own Steadfast account, COD account and charges account, and one parcel delivered by the
// courier's news. The fake courier works a parcel's id out of its invoice, so both first parcels
// are W-000001 with the same consignment id: only the workspace tells them apart. Nirvor pays its
// parcel out. Acme must not read, void or list Nirvor's payout, nor use Nirvor's courier account,
// parcel or bank account in its own; its CSV's W-000001 must find its own parcel; and the shop's
// and the worker's database roles must not read a payout at all (0083 grants them nothing).
let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;

interface Side {
  owner: SignedIn;
  shop: OrderShop;
  bankId: string;
  codAccount: Account;
  account: CourierAccount;
  token: string;
  parcel: StorefrontShipment;
  day: string;
}
let nirvor: Side;
let acme: Side;
let nirvorPayout: Payout;

const WHOLE = [{ position: 1, picks: [{ batchId: '', quantity: '2', serialNumbers: [] }] }];
const refusalSchema = problemSchema.pick({ code: true, fieldErrors: true });

function send(who: SignedIn, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: bearer(who.accessToken),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function getOrder(who: SignedIn, id: string): Promise<StorefrontOrder> {
  const res = await send(who, 'GET', `/storefront/orders/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return storefrontOrderSchema.parse(res.json());
}

async function ledgerAccount(
  who: SignedIn,
  parentId: string,
  code: string,
  name: string,
  holdsMoney: boolean,
): Promise<Account> {
  const res = await send(who, 'POST', '/accounts', {
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

// A workspace with a launched shop, its Steadfast account with both money accounts, and its first
// order (W-000001) delivered by the courier's news, with its COD receipt
async function sideOf(
  owner: SignedIn,
  slug: string,
  name: string,
  apiKey: string,
  n: number,
): Promise<Side> {
  const shop = await orderShop(app, sql, owner, { slug, name, stock: 50 });
  const chart = accountListSchema.parse((await send(owner, 'GET', '/accounts')).json()).items;
  const cash = chart.find((account) => account.code === '1110');
  const expenses = chart.find(
    (account) => account.type === 'expense' && account.isGroup && account.parentId !== null,
  );
  if (cash?.parentId == null || expenses === undefined) throw new Error('the seed chart changed');
  const codAccount = await ledgerAccount(owner, cash.parentId, '1191', 'Cash with Steadfast', true);
  const chargeAccount = await ledgerAccount(owner, expenses.id, '5998', 'Courier charges', false);
  const saved = await send(owner, 'POST', '/storefront/couriers', {
    provider: 'steadfast',
    name: 'Steadfast',
    apiKey,
    secretKey: `${apiKey}-secret`,
    codAccountId: codAccount.id,
    chargeAccountId: chargeAccount.id,
  });
  expect(saved.statusCode, saved.body).toBe(201);
  const { account, webhookToken } = courierAccountSavedSchema.parse(saved.json());
  const token = webhookToken ?? '';

  const headers = shopHeaders(shop.host, clientAddress(n));
  const phone = phoneOf(n);
  const orderToken = await placeOrder(app, headers, orderRequest(shop.listingId, 2, phone, '538'));
  const { code } = await codeFor(mail.apiUrl, phone);
  const verified = await shopPost(app, '/orders/verify', headers, { token: orderToken, code });
  expect(verified.statusCode, verified.body).toBe(200);
  const [row] = z.array(z.object({ id: z.uuid() })).parse(
    await sql`SELECT id::text FROM storefront_orders
      WHERE tenant_id = ${shop.tenantId} AND phone = ${phone} AND status = 'confirmed'`,
  );
  if (row === undefined) throw new Error(`no confirmed order for ${phone}`);
  const order = await eventually(async () => {
    const now = await getOrder(owner, row.id);
    expect(now.salesOrder).not.toBeNull();
    return now;
  });
  const packed = await send(owner, 'POST', `/storefront/orders/${order.id}/pack`, {
    version: order.version,
    lines: WHOLE,
    courierAccountId: account.id,
  });
  expect(packed.statusCode, packed.body).toBe(200);
  const booked = await eventually(async () => {
    const now = await getOrder(owner, order.id);
    expect(now.shipments.at(-1)?.status).toBe('booked');
    return now;
  });
  // A second after the booking, so the delivered step is the parcel's newest (28a)
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const news = await app.inject({
    method: 'POST',
    url: `/public/v1/couriers/steadfast/${account.id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      notification_type: 'delivery_status',
      consignment_id: Number(booked.shipments.at(-1)?.consignmentId),
      status: 'delivered',
      cod_amount: 538,
      delivery_charge: 80,
    },
  });
  expect(news.statusCode, news.body).toBe(200);
  const parcel = (await getOrder(owner, order.id)).shipments.at(-1);
  if (parcel?.receipt == null) throw new Error(`${slug}'s parcel has no COD receipt`);
  const receipt = receiptSchema.parse(
    (await send(owner, 'GET', `/receipts/${parcel.receipt.id}`)).json(),
  );
  return { owner, shop, bankId: cash.id, codAccount, account, token, parcel, day: receipt.date };
}

function payoutBody(side: Side, overrides: object = {}) {
  return {
    accountId: side.account.id,
    date: side.day,
    bankAccountId: side.bankId,
    reference: 'SFC-23618228',
    note: '',
    lines: [{ shipmentId: side.parcel.id, charge: '80' }],
    ...overrides,
  };
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
  const nirvorOwner = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  const acmeOwner = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  nirvor = await sideOf(nirvorOwner, 'nirvor', 'Nirvor', 'nirvor-api-key', 2001);
  acme = await sideOf(acmeOwner, 'acme', 'Acme', 'acme-api-key', 2002);
  const paid = await send(nirvor.owner, 'POST', '/storefront/payouts', payoutBody(nirvor));
  expect(paid.statusCode, paid.body).toBe(201);
  nirvorPayout = payoutSchema.parse(paid.json());
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await sql.end();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

describe('two shops, one fake courier', () => {
  it('gives both first parcels the same invoice and consignment id', () => {
    expect(nirvor.parcel.consignmentId).toBe(acme.parcel.consignmentId);
    expect(nirvor.parcel.id).not.toBe(acme.parcel.id);
  });
});

describe('Shop payouts', () => {
  it("shows the workspace's own courier accounts, bank accounts and payouts only", async () => {
    const setup = payoutSetupSchema.parse(
      (await send(acme.owner, 'GET', '/storefront/payout-setup')).json(),
    );
    expect(setup.accounts.map((account) => account.id)).toEqual([acme.account.id]);
    const banks = setup.bankAccounts.map((account) => account.id);
    expect(banks).toContain(acme.bankId);
    expect(banks).not.toContain(nirvor.bankId);
    expect(banks).not.toContain(nirvor.codAccount.id);
    // Acme's account holds its own parcel, not Nirvor's paid one
    expect(setup.accounts[0]?.holds).toEqual({ amount: '538.0000', parcels: 1 });
    const list = payoutPageSchema.parse(
      (await send(acme.owner, 'GET', '/storefront/payouts')).json(),
    );
    expect(list.items).toEqual([]);
    const filtered = payoutPageSchema.parse(
      (await send(acme.owner, 'GET', `/storefront/payouts?accountId=${nirvor.account.id}`)).json(),
    );
    expect(filtered.items).toEqual([]);
  });

  it("answers 404 for another workspace's payout and courier account", async () => {
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', `/storefront/payouts/${nirvorPayout.id}`],
      [
        'POST',
        `/storefront/payouts/${nirvorPayout.id}/void`,
        { version: nirvorPayout.version, date: nirvor.day, reason: 'Not ours' },
      ],
      ['GET', `/storefront/couriers/${nirvor.account.id}/payout-parcels`],
      [
        'POST',
        `/storefront/couriers/${nirvor.account.id}/payout-match`,
        { csv: 'Invoice,COD Amount,Delivery Charge\nW-000001,538,80', map: null },
      ],
    ];
    for (const [method, url, body] of routes) {
      const res = await send(acme.owner, method, url, body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
    }
    // Nirvor's payout is as it was
    const own = payoutSchema.parse(
      (await send(nirvor.owner, 'GET', `/storefront/payouts/${nirvorPayout.id}`)).json(),
    );
    expect(own).toMatchObject({ status: 'posted', version: nirvorPayout.version });
  });

  it('finds its own W-000001 in the file, not the paid one of the other workspace', async () => {
    const res = await send(
      acme.owner,
      'POST',
      `/storefront/couriers/${acme.account.id}/payout-match`,
      {
        csv: 'Invoice,COD Amount,Delivery Charge\nW-000001,538,80',
        map: null,
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(payoutMatchSchema.parse(res.json()).rows).toEqual([
      expect.objectContaining({ outcome: 'matched', shipmentId: acme.parcel.id, payout: null }),
    ]);
  });

  it('pays out with its own courier account, parcels and bank account only', async () => {
    const cases: [object, number, string, Record<string, string[]>][] = [
      [
        { accountId: nirvor.account.id },
        422,
        'payout_pick_account',
        { accountId: ['payout_pick_account'] },
      ],
      [
        { lines: [{ shipmentId: nirvor.parcel.id, charge: '80' }] },
        409,
        'payout_parcel_unavailable',
        { 'lines.0.shipmentId': ['payout_parcel_unavailable'] },
      ],
      [
        { bankAccountId: nirvor.bankId },
        422,
        'payout_bank_account_invalid',
        { bankAccountId: ['payout_bank_account_invalid'] },
      ],
    ];
    for (const [wrong, status, code, fieldErrors] of cases) {
      const res = await send(acme.owner, 'POST', '/storefront/payouts', payoutBody(acme, wrong));
      expect(res.statusCode, res.body).toBe(status);
      expect(refusalSchema.parse(res.json())).toEqual({ code, fieldErrors });
    }
    // Its own goes through, with its own number series
    const res = await send(acme.owner, 'POST', '/storefront/payouts', payoutBody(acme));
    expect(res.statusCode, res.body).toBe(201);
    const payout = payoutSchema.parse(res.json());
    expect(payout.number).toBe(nirvorPayout.number);
    expect(payout.lines.map((line) => line.shipmentId)).toEqual([acme.parcel.id]);
    // And Nirvor's parcel still names Nirvor's payout
    const [row] = await sql`SELECT payout_id::text AS id FROM storefront_shipments
      WHERE id = ${nirvor.parcel.id}`;
    expect(row?.id).toBe(nirvorPayout.id);
  });
});

describe('the database roles', () => {
  // ShopDb.read and ShopDb.orders in Nirvor's workspace: the shop's two ways in
  function asPublic(query: SQL) {
    return app.get(ShopDb).read(nirvor.shop.host, (tx) => tx.execute(query));
  }
  function asShop(query: SQL) {
    return app.get(ShopDb).orders(nirvor.shop.host, (tx) => tx.execute(query));
  }
  async function deniedAs(as: typeof asShop, query: SQL) {
    return pgErrorOf(await as(query).catch((caught: unknown) => caught));
  }

  it("give the shop's roles and the worker's role no payout and no parcel's payout", async () => {
    for (const as of [asPublic, asShop]) {
      for (const table of ['storefront_payouts', 'storefront_payout_lines']) {
        expect(
          await deniedAs(as, drizzleSql`SELECT count(*) FROM ${drizzleSql.identifier(table)}`),
        ).toEqual({ code: '42501', message: `permission denied for table ${table}` });
      }
    }
    expect(await deniedAs(asShop, drizzleSql`SELECT payout_id FROM storefront_shipments`)).toEqual({
      code: '42501',
      message: 'permission denied for table storefront_shipments',
    });
    const workerSql = postgres(pg.workerUrl, { max: 1 });
    try {
      for (const table of ['storefront_payouts', 'storefront_payout_lines']) {
        const error = await workerSql`SELECT count(*) FROM ${workerSql(table)}`.catch(
          (caught: unknown) => caught,
        );
        expect(pgErrorOf(error)).toEqual({
          code: '42501',
          message: `permission denied for table ${table}`,
        });
      }
    } finally {
      await workerSql.end();
    }
  });
});
```

Two shops, Nirvor and Acme, each with its own Steadfast account and money accounts, and one parcel delivered by the
courier's news. The fake courier works a parcel's id and code out of its invoice, so both first parcels are W-000001
with the same consignment id; only the workspace tells them apart. Nirvor pays its parcel out before the tests.

- **`sideOf`** builds one workspace's whole setup, so the two sides are made the same way and differ only in the
  workspace.
- **What Acme sees.** Its setup has its own courier account and its own bank accounts only, never Nirvor's cash or
  COD account; its Holds counts its own parcel; its list is empty, even filtered by Nirvor's account id.
- **404, never 403.** Reading or voiding Nirvor's payout, and the parcels or the match of Nirvor's courier account,
  answer 404 to Acme: under RLS the row does not exist for Acme, and a 403 would tell Acme that it does. Nirvor's
  payout is unchanged.
- **The same key.** Acme's file with W-000001 finds Acme's own parcel, `matched`, not Nirvor's paid one
  (`already_paid`). The match reads parcels by the key and the account, and the account is Acme's.
- **Acme's payout** with Nirvor's courier account is `payout_pick_account` (no such account for Acme), with Nirvor's
  parcel `payout_parcel_unavailable`, and with Nirvor's cash account `payout_bank_account_invalid`. Its own payout goes
  through with the same number as Nirvor's (CPO-…-0001): each workspace has its own number series. Nirvor's parcel
  still names Nirvor's payout.
- **The database roles.** The shop's two roles (`omnivo_public` and `omnivo_shop`, through `ShopDb`) and the
  worker's role cannot read `storefront_payouts` or `storefront_payout_lines` at all, and `omnivo_shop` cannot read
  the parcel's `payout_id`. 0083 grants them nothing; this test keeps it so if a later migration grants the tracking
  page more. `count(*)` is the query because the lines table has no `id` column, and Postgres would then answer
  "column does not exist" before it checks the permission.

### The number series list

```diff
@@ -101,7 +101,12 @@ describe('number series endpoints', () => {
   it('lists every document type with its next number, without using it up', async () => {
     const today = periodOf(todayIn('Asia/Dhaka'), 'fiscal', 7);
     const { items } = numberSeriesListSchema.parse((await send('GET', '/number-series')).json());
-    expect(items.map((series) => series.documentType)).toHaveLength(23);
+    expect(items.map((series) => series.documentType)).toHaveLength(24);
+    // Courier payouts (step 28c): numbered by fiscal year when posted, like a money receipt
+    expect(items.find((series) => series.documentType === 'storefront.payout')).toMatchObject({
+      prefix: 'CPO',
+      nextNumber: `CPO-${today}-0001`,
+    });
     // Purchase returns, debit notes and supplier refunds (step 17d): numbered by fiscal year. A
     // return and a debit note take their number when posted, a refund when saved (it has no draft).
     for (const [documentType, prefix] of [
```

28c.1 added one number series (`storefront.payout`, `CPO`), so the number series page lists 24 kinds of document, not
23. This test counts them, so a series added by mistake, or one left out, shows up. It now also checks the new one:
numbered by fiscal year like a money receipt, and the first one is `CPO-2026-27-0001`. This change was missed until
the full run in 28c.8 (mine 54); the payout code itself did not change.

### Check this part

```bash
pnpm turbo build --filter='./packages/*' --continue
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/storefront/payouts
pnpm --filter @omnivo/api test                   # 273 unit tests
cd apps/api && npx vitest run src/storefront/payouts --maxWorkers=1
```

What ran on commit 4696643:

- **Typecheck, lint, prettier:** clean.
- **Unit tests:** 32 files, 273 tests, all pass (27 of them in `payout-match.spec.ts`).
- **`payouts.int.spec.ts`:** 16 tests pass (49 with the unit and leak files, in one run). **`payouts.tenant-leak.int.spec.ts`:** 6 pass.
- **Broken on purpose,** one at a time, each caught:
  1. `matchPayoutCsv` without its `seen` check: two unit tests fail (no `twice`, and the net counts the row twice);
  2. `payoutKindOf` taking only a posted receipt as "has a receipt": a voided receipt's parcel becomes a charge line,
     and its unit test fails;
  3. `holdsOf` without `isNull(payoutId)`: the payout test fails (Holds still says ৳1,076 in 2 parcels);
  4. no date check in `create`: the refusals test fails (the payout dated before its receipt is posted);
  5. the bank allowed to be the COD account: the refusals test fails with a 500, because 0082's check that the
     three accounts differ still refuses it. The service's check is what turns that into an error under the box;
  6. `GRANT SELECT ON storefront_payouts TO omnivo_shop` at the end of 0083: the roles leak test fails;
  7. `lockParcels` without its `FOR UPDATE`: the two-payouts race fails (its 409 names no line). Before the race test
     checked the field error, this break passed every test; the check was added for it.
- **Not tested:** a real Steadfast payout file (none was seen, decision 11); a payout of 500 lines; and a second
  parcel of one order (`W-000123-2`), which is matched by its own invoice like any other.

## 28c.5 — `packages/i18n`: the words of the payout screens

The screens of 28c.6 need their words in English and Bangla, so they come first. 28c.1 and 28c.3 already gave the
errors, the audit log's two actions, the permission, the number series and the journal source their words. This
part adds the menu item, the payouts list, the new payout page, the payout file dialog, the payout's own page with
its void dialog, the printed voucher, the Shop couriers row menu's "Record payout", the parcel card's "Paid out on"
and the audit log's names for what a payout's entry writes. The shop's words do not change: the shop never shows a
payout.

These words come before the mockup. If the mockup in 28c.6 changes a screen, the words change with it, and the
diffs below show them as they are at the end of the step.

Five decisions came up while writing the words (mine):

36. **An account with no COD account stays in the select, disabled, and says why** ("Steadfast Dhaka · no COD
    account"). Hiding it would leave a member looking for a courier that is not there; the error
    `payout_account_no_cod` already says where to fix it. Every other option says what the account holds now, the
    Holds column's figure, so the member picks the account the bank statement's amount fits.
37. **"Other amount" tells the member what to do with the difference:** add it to the charge (decision 5). The
    receipt is posted and cannot change, so the line is the only place a courier's short payment can go, and saying
    so on the row saves a question.
38. **A row's line says "this number", never the key's name.** The mapping step names the key once ("Parcels are
    named by: Invoice"); the row lines then read the same for all three keys, and the Bangla needs no grammar for
    three nouns.
39. **The file's bank figure is shown like the books' line:** "The file says ৳39,840 reached the bank" with an
    "Agrees" or "Out by ৳x" pill next to the ticked lines' own figure. That is the one number the member holds
    against the bank statement.
40. **The amount columns have a "Not in the file" option**, the form's `''` that `payoutCsvMapSchema` turns into
    `null`. A courier's file without a charge column is still useful: it ticks the parcels, and the charges stay what
    the courier's news said.

### `locales/en.ts`

```diff
@@ -164,6 +164,8 @@ export const en = {
     storefrontCoupons: 'Shop coupons',
     // Step 28a: after Shop settings in the menu, both set the shop up (decision 15)
     storefrontCouriers: 'Shop couriers',
+    // Step 28c (decision 13): after Shop couriers. "Shop" for the phone's nav row, like the others
+    storefrontPayouts: 'Shop payouts',
   },
   auth: {
     workspace: 'Workspace',
@@ -5540,6 +5542,8 @@ export const en = {
       edit: 'Edit',
       test: 'Test connection',
       renewToken: 'New webhook token',
+      // Step 28c (decision 14): a new payout of this account
+      recordPayout: 'Record payout',
       archive: 'Archive',
       restore: 'Restore',
       // The test's toast. courier = the courier's name
```

The menu item after Shop couriers (decision 13), "Shop …" like the others because the phone's nav row has no group
labels, and the Shop couriers row menu's "Record payout" (decision 14), which opens a new payout of that account.

```diff
@@ -5648,6 +5652,208 @@ export const en = {
       restored: '{{name}} restored',
       tokenRenewed: 'New webhook token made',
     },
+    // Step 28c: Storefront → Shop payouts (/storefront/payouts, decision 13), with
+    // storefront.payout.manage. A payout is the courier's transfer of the riders' cash to the
+    // bank, its charges taken off
+    payouts: {
+      title: 'Shop payouts',
+      description: 'The COD money your couriers send to the bank, with their charges taken off',
+      new: 'Record payout',
+      account: 'Courier account',
+      allAccounts: 'All courier accounts',
+      // An archived account keeps its payouts, and can still pay out (decision 4)
+      archivedAccount: '{{name}} (archived)',
+      view: 'Show',
+      views: { all: 'All', posted: 'Posted', voided: 'Voided' },
+      // PAYOUT_STATUSES
+      statuses: { posted: 'Posted', voided: 'Voided' },
+      columns: {
+        number: 'Number',
+        date: 'Date',
+        account: 'Courier account',
+        reference: 'Courier’s reference',
+        parcels: 'Parcels',
+        collected: 'Collected',
+        charges: 'Charges',
+        net: 'To the bank',
+        status: 'Status',
+      },
+      emptyTitle: 'No payouts yet',
+      emptyBody:
+        'When Steadfast sends the riders’ cash to your bank, record it here: tick the parcels it paid, or match its payout file.',
+      filteredEmptyTitle: 'No payout matches',
+      filteredEmptyBody: 'No payout has this courier account and status.',
+      showAll: 'Show every payout',
+      loadFailed: "Couldn't load the payouts. Refresh the page to try again.",
+    },
+    // Step 28c: a new payout (/storefront/payouts/new) and a payout's page
+    payout: {
+      back: 'Shop payouts',
+      newTitle: 'Record a courier payout',
+      newDescription:
+        'Tick the parcels this transfer paid. Saving posts it: the money moves out of the courier’s COD account into the bank.',
+      account: 'Courier account',
+      accountPlaceholder: 'Pick the courier account that paid',
+      // The account select's options (payoutAccountSchema.holds), whole taka
+      accountHolds_one: '{{name}} · holds {{amount}} in {{formatted}} parcel',
+      accountHolds_other: '{{name}} · holds {{amount}} in {{formatted}} parcels',
+      accountHoldsNothing: '{{name}} · holds nothing',
+      // Disabled: with no COD account there is nothing to pay out (payout_account_no_cod)
+      accountNoCod: '{{name}} · no COD account',
+      date: 'Date',
+      dateHint: 'The day the money reached the bank, as on the bank statement.',
+      bankAccount: 'Paid into',
+      bankAccountPlaceholder: 'Pick an account',
+      bankAccountHint: 'The bank or mobile wallet account the courier sent the money to.',
+      // The setup's bank accounts, without this courier account's own COD account (decision 7)
+      noBankAccounts:
+        'No other active account holds money. Tick “Holds money” on your bank account in the chart of accounts.',
+      reference: 'Courier’s reference',
+      referencePlaceholder: 'SFC-23618228',
+      referenceHint:
+        'The payment’s number in the courier’s panel, or the bank’s reference. It prints on the voucher.',
+      note: 'Note',
+      notePlaceholder: 'Tuesday’s Steadfast payout for the Mirpur pickup',
+      // No charges account: a line with a charge is refused (payout_account_no_charges)
+      noChargeAccount:
+        '{{name}} has no courier charges account, so only parcels with no charge can be paid out. Pick one in Shop couriers to record the charges.',
+      // The parcels card (payoutParcelsSchema)
+      parcelsTitle: 'Parcels',
+      parcelsDescription:
+        'The parcels of {{name}} that no payout has taken yet. Tick the ones this transfer paid.',
+      pickAccountFirst: 'Pick the courier account to see its parcels.',
+      matchFile: 'Match a payout file',
+      tickAll: 'Tick all',
+      clear: 'Clear',
+      columns: {
+        parcel: 'Parcel',
+        status: 'Status',
+        receipt: 'Money receipt',
+        collected: 'Collected',
+        charge: 'Charge',
+        net: 'To the bank',
+      },
+      // invoice = the courier's invoice (W-000123, W-000123-2)
+      tick: 'Pay out {{invoice}}',
+      chargeLabel: 'Charge for {{invoice}}',
+      // PAYOUT_LINE_KINDS, under the invoice: a charge line brought no cash (decision 4)
+      kinds: { cod: 'Delivered with cash', charge: 'Charge only: no cash came' },
+      // The courier's own charge (courierCharge, mine 22), under the charge box. courier = its name
+      courierSaid: '{{courier}} said {{amount}}',
+      courierSilent: '{{courier}} has not said its charge',
+      noParcelsTitle: 'Nothing to pay out',
+      noParcelsBody:
+        'Every parcel of {{name}} is paid out. A parcel shows here once it is delivered and its COD receipt is made, or once it came back with a charge.',
+      // The totals on subtle under the table
+      ticked_one: '{{formatted}} parcel ticked',
+      ticked_other: '{{formatted}} parcels ticked',
+      collected: 'Collected',
+      charges: 'Charges',
+      net: 'To the bank',
+      // After a file was matched (payoutMatchSchema.fileNet): the bank figure the file gives,
+      // held against the ticked lines'
+      fileNet: 'The file says {{amount}} reached the bank',
+      fileAgrees: 'Agrees',
+      fileOutBy: 'Out by {{amount}}',
+      save: 'Record payout',
+      saveHint:
+        'Saving posts the payout. A mistake is voided on the payout’s page, which frees its parcels again.',
+      created: '{{number}} recorded',
+      // The payout's own page
+      facts: {
+        account: 'Courier account',
+        bankAccount: 'Paid into',
+        date: 'Date',
+        reference: 'Courier’s reference',
+        codAccount: 'Out of',
+        chargeAccount: 'Charges to',
+        branch: 'Branch',
+        note: 'Note',
+      },
+      linesTitle: 'Parcels paid',
+      linesDescription: 'What each parcel brought, and what the courier kept',
+      print: 'Print voucher',
+      entry: 'Journal entry',
+      voidEntry: 'Reversal',
+      void: 'Void payout',
+      voidTitle: 'Void {{number}}',
+      voidBody:
+        'Its entry is reversed on the void date, and its parcels can be paid out again. The payout stays in the list with its number.',
+      voidDate: 'Void date',
+      voidDateHint: 'The day it turned out wrong, like the day you found it was recorded twice.',
+      voidReason: 'Reason',
+      voidReasonPlaceholder: 'Recorded twice: the same Steadfast payment as CPO-2026-27-0003',
+      confirmVoid: 'Void payout',
+      voided: '{{number}} voided',
+      voidedNotice: 'Voided on {{date}}: {{reason}}. Its parcels can be paid out again.',
+      notFound: "This payout doesn't exist.",
+      loadFailed: "Couldn't load the payout. Refresh the page to try again.",
+      // The payout file dialog (decisions 10–12, mine 18 and 19). name = the courier account
+      csv: {
+        title: 'Match the courier’s payout file',
+        description:
+          'The payout’s CSV from {{name}}’s panel. Omnivo ticks the parcels it names and takes their charges.',
+        choose: 'Choose CSV file',
+        fileHint:
+          'One payout at a time, up to 1 MB and 5,000 rows. The file is read to tick the parcels, never kept.',
+        reading: 'Reading the file…',
+        matching: 'Matching…',
+        // The mapping step: the saved map or the preset names a column the file lacks.
+        // names = those names, in quotes, joined with commas
+        mapTitle: 'Which column is which?',
+        mapMissing: 'Not in the file: {{names}}. Pick the file’s own columns.',
+        mapFirst: 'Pick the file’s columns once. They are kept for {{name}}’s next file.',
+        key: 'Parcels are named by',
+        // PAYOUT_CSV_KEYS
+        keys: {
+          invoice: 'Invoice (W-000123)',
+          tracking_code: 'Tracking code',
+          consignment_id: 'Courier’s ID',
+        },
+        keyColumn: 'Its column',
+        collectedColumn: 'Collected column',
+        collectedHint:
+          'What the rider collected. Without it, a parcel with another amount can’t be found.',
+        chargeColumn: 'Charge column',
+        chargeHint:
+          'The courier’s charge for each parcel. Without it, the charges stay what the courier’s news said.',
+        columnPlaceholder: 'Pick a column',
+        columnNone: 'Not in the file',
+        match: 'Match the file',
+        changeColumns: 'Change the columns',
+        otherFile: 'Choose another file',
+        // The result, one line per row of the file. row = its line, the header being 1
+        row: 'Row {{row}}',
+        // PAYOUT_MATCH_OUTCOMES, as pills
+        outcomes: {
+          matched: 'Found',
+          different: 'Other amount',
+          already_paid: 'Already paid out',
+          not_ready: 'Not ready',
+          unknown: 'Not found',
+          twice: 'Twice in the file',
+          invalid: 'Can’t be read',
+        },
+        // label = the pill's words, count = its rows
+        outcomeCount: '{{label}}: {{formatted}}',
+        // The line under a row. file and ours = the two collected amounts, with paisa
+        different:
+          'The file says {{file}} collected, the money receipt {{ours}}. If the courier keeps the difference, add it to the charge.',
+        alreadyPaid: 'Paid out on {{payout}}.',
+        notReady:
+          'Not delivered yet, or its money receipt isn’t made. It can be paid out once it is.',
+        unknown: 'None of {{name}}’s parcels has this number.',
+        twice: 'An earlier row has the same number. Only the first one counts.',
+        invalid: 'The row has no parcel number, or an amount that isn’t a number.',
+        // Ticks the found and other-amount rows' parcels, with the file's charges
+        apply_one: 'Tick {{formatted}} parcel',
+        apply_other: 'Tick {{formatted}} parcels',
+        applyHint: 'The charges come from the file. Parcels ticked before stay ticked.',
+        noneToTick: 'No row names a parcel this payout can take.',
+        applied_one: '{{formatted}} parcel ticked from the file',
+        applied_other: '{{formatted}} parcels ticked from the file',
+      },
+    },
     categories: {
       title: 'Shop categories',
       description: 'How the shop groups its listings, in the order its menu shows them',
```

The two new groups, `storefront.payouts` (the list) and `storefront.payout` (a new payout, a payout's page and the
file dialog). They sit after `couriers`, like the menu.

- **The list.** Its columns are the summary's fields (`payoutSummarySchema`). "To the bank" is `net`: the words say
  where the money went, not an accounting term. The tabs are `views` (All, Posted, Voided) and the pill is
  `statuses`, with exactly `PAYOUT_STATUSES`' keys, so a status the contracts add later fails the type check here.
  The empty line names Steadfast and both ways to fill a payout, so a new shop knows what the page is for.
- **The account select** (mine 36). `accountHolds_*` uses `{{formatted}}` with `count`, like 28b's Holds column, so
  the number is in the reader's digits and the plural follows it; `amount` is whole taka, like every list.
- **The bank select.** `noBankAccounts` says the setup has no other account that holds money: the form leaves out
  the courier account's own COD account (decision 7), so a chart with only "Cash with Steadfast" has nothing to
  offer. The hint names a mobile wallet too, because some couriers pay out to bKash.
- **The reference** has the courier's own number as its placeholder (`SFC-23618228`, decision 2): that is what the
  member types, and what the voucher prints next to ours.
- **`noChargeAccount`** is the notice before the error: with no charges account a line with a charge is refused
  (`payout_account_no_charges`), so the page says it as soon as the account is picked.
- **The parcels card.** `tick` and `chargeLabel` name the line's invoice, so a screen reader says which parcel a
  checkbox or a box belongs to. `kinds` is under the invoice: a charge line says no cash came (decision 4), so a
  ৳0 in Collected does not look like a mistake. `courierSaid` is the courier's own figure under the charge box (mine
  22); `courierSilent` says the box is empty because the courier has not said, not because the charge is zero.
- **The totals** (`ticked_*`, `collected`, `charges`, `net`) and the file's figure (mine 39).
- **Saving** says it posts at once (decision 6) and where a mistake is undone, because there is no draft.
- **The payout's page.** `facts.codAccount` is "Out of" and `facts.chargeAccount` "Charges to": the two accounts the
  entry moved money between, as they were then (`payoutSchema.codAccountId`). The void dialog follows the money
  receipt's (decision 24), and its body and `voidedNotice` say the parcels are free again, which is what a member
  voids a payout for.
- **`csv`, the payout file dialog.** `fileHint` gives the two limits (decision 10) and says the file is never kept.
  `mapMissing` lists the names the answer's `missing` gives (mine 18), and `mapFirst` says the columns are kept for
  the next file (decision 11). `keys` has exactly `PAYOUT_CSV_KEYS`' keys; the invoice's label shows an example,
  because "invoice" alone reads as our sales invoice. `collectedHint` and `chargeHint` say what is lost without each
  column (mine 40). `outcomes` has exactly `PAYOUT_MATCH_OUTCOMES`' keys (decision 12, mine 19), and each row that is
  not simply found has its own line (mines 37 and 38). `apply_*` counts the rows it will tick, so the button says
  what it does.

```diff
@@ -6393,6 +6599,8 @@ export const en = {
         collected: 'Rider collected',
         charge: 'Courier’s charge',
         receipt: 'Money receipt',
+        // Step 28c (decision 14): the posted payout that paid the parcel's money out, as a link
+        payout: 'Paid out on',
         // Mine 14: the COD receipt's error sits on its parcel. reason = the error's own words
         receiptError: 'The COD receipt could not be made. {{reason}}',
         makeReceipt: 'Make the receipt',
```

The parcel card's new fact (decision 14), a caption label like "Money receipt", with the payout's number as a link
next to it.

```diff
@@ -6885,6 +7093,8 @@ export const en = {
       purchaseReturn: 'Purchase return',
       debitNote: 'Debit note',
       supplierRefund: 'Supplier refund',
+      // Step 28c
+      storefrontPayout: 'Courier payout',
     },
     bin: 'BIN {{bin}}',
     phone: 'Phone {{phone}}',
@@ -6948,6 +7158,18 @@ export const en = {
     supplierCredit: 'Their credit note',
     receivedInto: 'Received into',
     paidBackOn: 'Paid back on',
+    // Step 28c: a courier payout's voucher
+    courier: 'Courier',
+    paidInto: 'Paid into',
+    payoutColumns: {
+      parcel: 'Parcel',
+      trackingCode: 'Tracking code',
+      collected: 'Collected',
+      charge: 'Charge',
+    },
+    collected: 'Collected',
+    charges: 'Courier’s charges',
+    netToBank: 'Paid into the bank',
     signatures: {
       customer: 'Customer’s signature',
       receivedBy: 'Received by',
```

The printed voucher: its title, the courier and the bank account, the lines' columns and the three totals. The
voucher's other words (number, date, reference, "In words", the signatures) are already in `print`, shared with the
supplier's payment voucher.

```diff
@@ -7951,6 +8173,13 @@ export const en = {
       codAccount: 'COD account',
       chargeAccount: 'Courier charges account',
       cameBack: 'Lines that came back',
+      // Step 28c: a payout's created entry
+      courierAccount: 'Courier account',
+      bankAccount: 'Paid into',
+      parcels: 'Parcels',
+      collected: 'Collected',
+      charges: 'Charges',
+      net: 'To the bank',
     },
     loadFailed: "Couldn't load the audit log. Refresh the page to try again.",
   },
```

The audit log's names for the fields `storefront_payout.created` writes (28c.3): the courier account by name, the
bank account by its code, the number of parcels and the three sums. `number`, `date`, `reference`, `entry`,
`reason` and `reversal` already had words.

### `locales/bn.ts`

```diff
@@ -142,6 +142,8 @@ export const bn: Messages = {
     storefrontCoupons: 'শপের কুপন',
     // Step 28a
     storefrontCouriers: 'শপের কুরিয়ার',
+    // Step 28c
+    storefrontPayouts: 'শপের পেআউট',
   },
   auth: {
     workspace: 'ওয়ার্কস্পেস',
@@ -5134,6 +5136,8 @@ export const bn: Messages = {
       edit: 'বদলান',
       test: 'কানেকশন পরীক্ষা করুন',
       renewToken: 'নতুন webhook token',
+      // Step 28c
+      recordPayout: 'পেআউট লিখুন',
       archive: 'আর্কাইভ করুন',
       restore: 'ফিরিয়ে আনুন',
       testedWorked: '{{courier}} key মেনে নিয়েছে',
@@ -5235,6 +5239,180 @@ export const bn: Messages = {
       restored: '{{name}} ফিরিয়ে আনা হয়েছে',
       tokenRenewed: 'নতুন webhook token বানানো হয়েছে',
     },
+    // Step 28c
+    payouts: {
+      title: 'শপের পেআউট',
+      description: 'কুরিয়াররা চার্জ কেটে যে COD টাকা আপনার ব্যাংকে পাঠায়',
+      new: 'পেআউট লিখুন',
+      account: 'কুরিয়ার অ্যাকাউন্ট',
+      allAccounts: 'সব কুরিয়ার অ্যাকাউন্ট',
+      archivedAccount: '{{name}} (আর্কাইভ করা)',
+      view: 'দেখান',
+      views: { all: 'সব', posted: 'পোস্ট করা', voided: 'বাতিল' },
+      statuses: { posted: 'পোস্ট করা', voided: 'বাতিল' },
+      columns: {
+        number: 'নম্বর',
+        date: 'তারিখ',
+        account: 'কুরিয়ার অ্যাকাউন্ট',
+        reference: 'কুরিয়ারের রেফারেন্স',
+        parcels: 'পার্সেল',
+        collected: 'রাইডার নিয়েছেন',
+        charges: 'চার্জ',
+        net: 'ব্যাংকে এসেছে',
+        status: 'অবস্থা',
+      },
+      emptyTitle: 'এখনো কোনো পেআউট নেই',
+      emptyBody:
+        'Steadfast রাইডারদের নেওয়া টাকা আপনার ব্যাংকে পাঠালে এখানে লিখুন: যে পার্সেলগুলোর টাকা এসেছে সেগুলোতে টিক দিন, বা তার পেআউট ফাইল মিলিয়ে নিন।',
+      filteredEmptyTitle: 'কোনো পেআউট মেলেনি',
+      filteredEmptyBody: 'এই কুরিয়ার অ্যাকাউন্ট আর অবস্থার কোনো পেআউট নেই।',
+      showAll: 'সব পেআউট দেখান',
+      loadFailed: 'পেআউটগুলো আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+    },
+    payout: {
+      back: 'শপের পেআউট',
+      newTitle: 'কুরিয়ারের পেআউট লিখুন',
+      newDescription:
+        'এই ট্রান্সফারে যে পার্সেলগুলোর টাকা এসেছে সেগুলোতে টিক দিন। সেভ করলেই পোস্ট হয়: টাকা কুরিয়ারের COD অ্যাকাউন্ট থেকে ব্যাংকে যায়।',
+      account: 'কুরিয়ার অ্যাকাউন্ট',
+      accountPlaceholder: 'যে কুরিয়ার অ্যাকাউন্ট টাকা দিয়েছে সেটা বাছুন',
+      accountHolds_one: '{{name}} · {{formatted}}টা পার্সেলের {{amount}} কাছে আছে',
+      accountHolds_other: '{{name}} · {{formatted}}টা পার্সেলের {{amount}} কাছে আছে',
+      accountHoldsNothing: '{{name}} · কিছু কাছে নেই',
+      accountNoCod: '{{name}} · COD অ্যাকাউন্ট নেই',
+      date: 'তারিখ',
+      dateHint: 'যেদিন টাকা ব্যাংকে পৌঁছেছে, ব্যাংক স্টেটমেন্টে যেমন আছে।',
+      bankAccount: 'যে অ্যাকাউন্টে এসেছে',
+      bankAccountPlaceholder: 'একটা অ্যাকাউন্ট বাছুন',
+      bankAccountHint: 'যে ব্যাংক বা মোবাইল ওয়ালেট অ্যাকাউন্টে কুরিয়ার টাকা পাঠিয়েছে।',
+      noBankAccounts:
+        'টাকা রাখা হয় এমন আর কোনো চালু অ্যাকাউন্ট নেই। চার্ট অফ অ্যাকাউন্টসে আপনার ব্যাংক অ্যাকাউন্টে “টাকা রাখা হয়” টিক দিন।',
+      reference: 'কুরিয়ারের রেফারেন্স',
+      referencePlaceholder: 'SFC-23618228',
+      referenceHint:
+        'কুরিয়ারের প্যানেলে পেমেন্টের নম্বর, বা ব্যাংকের রেফারেন্স। এটা ভাউচারে প্রিন্ট হয়।',
+      note: 'নোট',
+      notePlaceholder: 'মিরপুর পিকআপের মঙ্গলবারের Steadfast পেআউট',
+      noChargeAccount:
+        '{{name}}-এর কুরিয়ার চার্জের অ্যাকাউন্ট নেই, তাই শুধু চার্জ ছাড়া পার্সেলের পেআউট হবে। চার্জ লিখতে শপের কুরিয়ার পেজে একটা বাছুন।',
+      parcelsTitle: 'পার্সেল',
+      parcelsDescription:
+        '{{name}}-এর যে পার্সেলগুলো এখনো কোনো পেআউটে যায়নি। এই ট্রান্সফারে যেগুলোর টাকা এসেছে সেগুলোতে টিক দিন।',
+      pickAccountFirst: 'পার্সেলগুলো দেখতে কুরিয়ার অ্যাকাউন্ট বাছুন।',
+      matchFile: 'পেআউট ফাইল মেলান',
+      tickAll: 'সবগুলোতে টিক দিন',
+      clear: 'মুছুন',
+      columns: {
+        parcel: 'পার্সেল',
+        status: 'অবস্থা',
+        receipt: 'মানি রিসিট',
+        collected: 'রাইডার নিয়েছেন',
+        charge: 'চার্জ',
+        net: 'ব্যাংকে',
+      },
+      tick: '{{invoice}}-এর পেআউট',
+      chargeLabel: '{{invoice}}-এর চার্জ',
+      kinds: { cod: 'নগদসহ পৌঁছেছে', charge: 'শুধু চার্জ: নগদ আসেনি' },
+      courierSaid: '{{courier}} বলেছে {{amount}}',
+      courierSilent: '{{courier}} এখনো চার্জ বলেনি',
+      noParcelsTitle: 'পেআউটের কিছু নেই',
+      noParcelsBody:
+        '{{name}}-এর সব পার্সেলের পেআউট হয়ে গেছে। পার্সেল পৌঁছে তার COD রিসিট বানানো হলে, বা চার্জসহ ফেরত এলে, এখানে আসে।',
+      ticked_one: '{{formatted}}টা পার্সেলে টিক',
+      ticked_other: '{{formatted}}টা পার্সেলে টিক',
+      collected: 'রাইডার নিয়েছেন',
+      charges: 'চার্জ',
+      net: 'ব্যাংকে',
+      fileNet: 'ফাইল বলছে ব্যাংকে {{amount}} এসেছে',
+      fileAgrees: 'মিলেছে',
+      fileOutBy: '{{amount}} গরমিল',
+      save: 'পেআউট লিখুন',
+      saveHint:
+        'সেভ করলেই পেআউট পোস্ট হয়। ভুল হলে পেআউটের পেজে বাতিল করুন, তাতে পার্সেলগুলো আবার ছাড়া পায়।',
+      created: '{{number}} লেখা হয়েছে',
+      facts: {
+        account: 'কুরিয়ার অ্যাকাউন্ট',
+        bankAccount: 'যে অ্যাকাউন্টে এসেছে',
+        date: 'তারিখ',
+        reference: 'কুরিয়ারের রেফারেন্স',
+        codAccount: 'যেখান থেকে গেছে',
+        chargeAccount: 'চার্জ যেখানে গেছে',
+        branch: 'শাখা',
+        note: 'নোট',
+      },
+      linesTitle: 'যে পার্সেলগুলোর টাকা এসেছে',
+      linesDescription: 'প্রতিটা পার্সেলে কত এসেছে, আর কুরিয়ার কত রেখেছে',
+      print: 'ভাউচার প্রিন্ট করুন',
+      entry: 'জার্নাল এন্ট্রি',
+      voidEntry: 'রিভার্সাল',
+      void: 'পেআউট বাতিল করুন',
+      voidTitle: '{{number}} বাতিল করুন',
+      voidBody:
+        'বাতিলের তারিখে এর এন্ট্রি রিভার্স হবে, আর এর পার্সেলগুলোর আবার পেআউট হতে পারবে। পেআউটটা নম্বরসহ তালিকায় থেকে যাবে।',
+      voidDate: 'বাতিলের তারিখ',
+      voidDateHint: 'যেদিন ভুলটা ধরা পড়ল, যেমন যেদিন দেখলেন এটা দুবার লেখা হয়েছে।',
+      voidReason: 'কারণ',
+      voidReasonPlaceholder: 'দুবার লেখা: CPO-2026-27-0003-এর একই Steadfast পেমেন্ট',
+      confirmVoid: 'পেআউট বাতিল করুন',
+      voided: '{{number}} বাতিল হয়েছে',
+      voidedNotice: '{{date}}-এ বাতিল: {{reason}}। এর পার্সেলগুলোর আবার পেআউট হতে পারে।',
+      notFound: 'এই পেআউট নেই।',
+      loadFailed: 'পেআউটটা আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
+      csv: {
+        title: 'কুরিয়ারের পেআউট ফাইল মেলান',
+        description:
+          '{{name}}-এর প্যানেল থেকে পেআউটের CSV। ফাইলে যে পার্সেলগুলোর নাম আছে, Omnivo সেগুলোতে টিক দেয় আর তাদের চার্জ নেয়।',
+        choose: 'CSV ফাইল বাছুন',
+        fileHint:
+          'একবারে একটা পেআউট, সর্বোচ্চ 1 MB আর ৫,০০০ row। পার্সেলে টিক দিতে ফাইলটা পড়া হয়, রাখা হয় না।',
+        reading: 'ফাইলটা পড়া হচ্ছে…',
+        matching: 'মেলানো হচ্ছে…',
+        mapTitle: 'কোন কলামে কী আছে?',
+        mapMissing: 'ফাইলে নেই: {{names}}। ফাইলের নিজের কলামগুলো বাছুন।',
+        mapFirst: 'ফাইলের কলামগুলো একবার বাছুন। {{name}}-এর পরের ফাইলের জন্য এগুলো রাখা থাকবে।',
+        key: 'পার্সেল চেনা যায়',
+        keys: {
+          invoice: 'ইনভয়েস (W-000123)',
+          tracking_code: 'ট্র্যাকিং কোড',
+          consignment_id: 'কুরিয়ারের ID',
+        },
+        keyColumn: 'তার কলাম',
+        collectedColumn: 'রাইডার যা নিয়েছেন তার কলাম',
+        collectedHint: 'রাইডার যা নিয়েছেন। এটা ছাড়া অন্য পরিমাণের পার্সেল ধরা যায় না।',
+        chargeColumn: 'চার্জের কলাম',
+        chargeHint:
+          'প্রতিটা পার্সেলে কুরিয়ারের চার্জ। এটা ছাড়া চার্জ থাকে কুরিয়ারের খবরে যা এসেছিল।',
+        columnPlaceholder: 'একটা কলাম বাছুন',
+        columnNone: 'ফাইলে নেই',
+        match: 'ফাইল মেলান',
+        changeColumns: 'কলাম বদলান',
+        otherFile: 'অন্য ফাইল বাছুন',
+        row: 'Row {{row}}',
+        outcomes: {
+          matched: 'পাওয়া গেছে',
+          different: 'অন্য পরিমাণ',
+          already_paid: 'আগেই পেআউট হয়েছে',
+          not_ready: 'এখনো হয়নি',
+          unknown: 'পাওয়া যায়নি',
+          twice: 'ফাইলে দুবার',
+          invalid: 'পড়া যায় না',
+        },
+        outcomeCount: '{{label}}: {{formatted}}',
+        different:
+          'ফাইল বলছে রাইডার {{file}} নিয়েছেন, মানি রিসিটে {{ours}}। পার্থক্যটা কুরিয়ার রেখে দিলে চার্জে যোগ করুন।',
+        alreadyPaid: '{{payout}}-এ পেআউট হয়েছে।',
+        notReady: 'এখনো পৌঁছায়নি, বা তার মানি রিসিট বানানো হয়নি। হলে এর পেআউট হবে।',
+        unknown: '{{name}}-এর কোনো পার্সেলের এই নম্বর নেই।',
+        twice: 'আগের একটা row-তেও এই নম্বর আছে। শুধু প্রথমটা ধরা হয়।',
+        invalid: 'এই row-তে পার্সেলের নম্বর নেই, বা কোনো পরিমাণ সংখ্যা না।',
+        apply_one: '{{formatted}}টা পার্সেলে টিক দিন',
+        apply_other: '{{formatted}}টা পার্সেলে টিক দিন',
+        applyHint: 'চার্জ আসে ফাইল থেকে। আগে টিক দেওয়া পার্সেলগুলোতে টিক থেকে যায়।',
+        noneToTick: 'এই পেআউট নিতে পারে এমন কোনো পার্সেল কোনো row-তে নেই।',
+        applied_one: 'ফাইল থেকে {{formatted}}টা পার্সেলে টিক দেওয়া হয়েছে',
+        applied_other: 'ফাইল থেকে {{formatted}}টা পার্সেলে টিক দেওয়া হয়েছে',
+      },
+    },
     categories: {
       title: 'শপের ক্যাটাগরি',
       description: 'শপ তার লিস্টিংগুলো যেভাবে সাজায়, মেনুতে যে ক্রমে দেখায়',
@@ -5875,6 +6053,8 @@ export const bn: Messages = {
         collected: 'রাইডার নিয়েছেন',
         charge: 'কুরিয়ারের চার্জ',
         receipt: 'মানি রিসিট',
+        // Step 28c
+        payout: 'যে পেআউটে টাকা এসেছে',
         receiptError: 'COD রিসিট বানানো যায়নি। {{reason}}',
         makeReceipt: 'রিসিট বানান',
         receiptMade: 'মানি রিসিট {{receipt}} বানানো হয়েছে',
@@ -6314,6 +6494,8 @@ export const bn: Messages = {
       purchaseReturn: 'পারচেজ রিটার্ন',
       debitNote: 'ডেবিট নোট',
       supplierRefund: 'সাপ্লায়ার রিফান্ড',
+      // Step 28c
+      storefrontPayout: 'কুরিয়ার পেআউট',
     },
     bin: 'BIN {{bin}}',
     phone: 'ফোন {{phone}}',
@@ -6374,6 +6556,18 @@ export const bn: Messages = {
     supplierCredit: 'তাদের ক্রেডিট নোট',
     receivedInto: 'যে অ্যাকাউন্টে এলো',
     paidBackOn: 'যার বিপরীতে ফেরত',
+    // Step 28c
+    courier: 'কুরিয়ার',
+    paidInto: 'যে অ্যাকাউন্টে এসেছে',
+    payoutColumns: {
+      parcel: 'পার্সেল',
+      trackingCode: 'ট্র্যাকিং কোড',
+      collected: 'রাইডার নিয়েছেন',
+      charge: 'চার্জ',
+    },
+    collected: 'রাইডার নিয়েছেন',
+    charges: 'কুরিয়ারের চার্জ',
+    netToBank: 'ব্যাংকে এসেছে',
     signatures: {
       customer: 'গ্রাহকের স্বাক্ষর',
       receivedBy: 'গ্রহণকারী',
@@ -7338,6 +7532,13 @@ export const bn: Messages = {
       codAccount: 'COD অ্যাকাউন্ট',
       chargeAccount: 'কুরিয়ার চার্জের অ্যাকাউন্ট',
       cameBack: 'যে লাইনগুলো ফেরত এসেছে',
+      // Step 28c
+      courierAccount: 'কুরিয়ার অ্যাকাউন্ট',
+      bankAccount: 'যে অ্যাকাউন্টে এসেছে',
+      parcels: 'পার্সেল',
+      collected: 'রাইডার নিয়েছেন',
+      charges: 'চার্জ',
+      net: 'ব্যাংকে এসেছে',
     },
     loadFailed: 'অডিট লগ আনা যায়নি। পেজটা রিফ্রেশ করে আবার চেষ্টা করুন।',
   },
```

The same keys in Bangla; the type check fails if one is missing. COD, CSV and Steadfast stay in English, like 28b's
words, and "row" too, as the CSV errors of 28c.1 say it: it is what the spreadsheet calls a line. Collected is
"রাইডার নিয়েছেন", the parcel card's word (28b), so the payout and the card say the same thing; void is "বাতিল", the
money receipt's word, because a payout is voided like one.

### Check this part

```bash
pnpm --filter @omnivo/i18n build && pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test   # 21 tests
pnpm exec eslint packages/i18n/src
pnpm exec prettier --check packages/i18n/src
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/shop typecheck
pnpm --filter @omnivo/app typecheck
```

What ran on commit 35e8e4d:

- **i18n:** build, type check, 21 tests, eslint and prettier all pass. The packages build, and the shop type check
  passes.
- **The app type check** still fails, with the one error 28c.1 expected (`mocks/storefront-shipping-data.ts`: the
  parcel has no `payout`), which 28c.7 fixes. No screen uses the words yet: 28c.6 uses them, and 28c.8 looks for
  words no screen uses and takes them out.
- **Broken on purpose,** one at a time, each caught:
  1. `fileOutBy` taken out of the Bangla `payout`: the i18n type check fails (`Property 'fileOutBy' is missing`);
  2. `{{ours}}` taken out of the Bangla `csv.different`: the placeholder test fails
     (`storefront.payout.csv.different: en [file, ours] / bn [file]`).

## 28c.6 — The ERP screens

The screens come last, on top of the contracts, the API and the words. Before any code, the screens were drawn as a
mockup (HTML pages turned into pictures, not published anywhere) and the user approved them on 2026-11-25 with seven
proposals:

- **P1.** The menu item's icon is `Bank`, not `MoneyReceive02`: Money receipts already uses that one, and an
  accountant sees both items.
- **P2.** A voided payout stays in the list with its pill, like a voided receipt.
- **P3.** The new payout page is a form card (account across two columns, date, paid into, reference, note), then
  a Parcels card with every parcel the account may pay out, none ticked at first. A charge box starts with what the
  courier said, is enabled only while its parcel is ticked, and is required then. The new page and the payout's
  page show paisa (the payout posts); the list shows whole taka (a list).
- **P4.** The sums sit on `subtle` under the parcels. After a file was matched, the file's own bank figure is shown
  with an "Agrees" or "Out by ৳x" pill, so a wrong charge shows before saving.
- **P5.** The file dialog is 560px wide and has three steps: choose the file; pick the columns (only when needed);
  see the result. The rows that need a look come first.
- **P6.** "Record payout" in the Shop couriers row menu sits after "New webhook token", before "Archive".
- **P7.** On a phone each parcel is a card of its own.

These decisions came up while writing the screens (mine):

41. **A select option can be disabled** (`SelectOption.disabled` in `@omnivo/ui`). A courier account with no COD
    account stays in the payout's select, greyed out, as the mockup shows (mine 36). Hiding it would leave a member
    looking for an account that is not there.
42. **`ParcelPill` moved to `storefront-order-pills.tsx`.** The new payout lists parcels with their status pill. The
    pill lived in `storefront-order-parcels.tsx`, the order page's parcel cards with Book courier and the label;
    importing it would have put all of that into the payout form's chunk.
43. **The form holds only the ticked lines; the boxes live beside it.** `lines` is what the API takes, in the
    parcels' order. What each charge box shows, ticked or not, is a separate map (`ChargeDrafts`). Untick a parcel and
    tick it again, and the charge typed before comes back.
44. **A parcel taken by someone else is handled once, at the top.** When the save answers
    `payout_parcel_unavailable`, the form reads the parcels again, drops the lines of the ones that are gone, and shows
    the error above the form. The row that had the error is gone, so an error under it could not be seen.
45. **A link only for someone who may open it.** A payout line's order links to the order page only with
    `storefront.order.read`; the parcel card's payout links to the payout only with `storefront.payout.manage`.
    Everyone else sees the number as text. Receipts are always links: every member reads them.
46. **Void reuses the money receipt's `VoidForm`** with `words="storefront.payout"`. Its keys are the same as a
    receipt's; only the No button differs, and the payout's is a plain "Cancel".
47. **One more word, `storefront.payout.total`** ("Total"), for the total row of the payout's lines.

### The words added here

```diff
@@ -5772,6 +5772,8 @@ export const en = {
       },
       linesTitle: 'Parcels paid',
       linesDescription: 'What each parcel brought, and what the courier kept',
+      // The lines' total row (approved with the mockup)
+      total: 'Total',
       print: 'Print voucher',
       entry: 'Journal entry',
       voidEntry: 'Reversal',
```

```diff
@@ -5342,6 +5342,7 @@ export const bn: Messages = {
       },
       linesTitle: 'যে পার্সেলগুলোর টাকা এসেছে',
       linesDescription: 'প্রতিটা পার্সেলে কত এসেছে, আর কুরিয়ার কত রেখেছে',
+      total: 'মোট',
       print: 'ভাউচার প্রিন্ট করুন',
       entry: 'জার্নাল এন্ট্রি',
       voidEntry: 'রিভার্সাল',
```

The one word the mockup added (mine 47). It is in the `payout` group, next to the lines' title, because only the
payout's page uses it.

### `@omnivo/ui`: a disabled option

```diff
@@ -137,6 +137,9 @@ export function TextField({ id, label, optional, hint, error, ...input }: TextFi
 export interface SelectOption {
   value: string;
   label: string;
+  // Step 28c: shown but not offered, like a courier account with no COD account in the payout's
+  // select: the person sees it exists and the words say why it can't be picked
+  disabled?: boolean | undefined;
 }
 
 export interface SelectProps extends Omit<ComponentProps<'select'>, 'className'> {
@@ -161,7 +164,7 @@ export function Select({ options, icon, invalid = false, ...select }: SelectProp
         {...select}
       >
         {options.map((option) => (
-          <option key={option.value} value={option.value}>
+          <option key={option.value} value={option.value} disabled={option.disabled}>
             {option.label}
           </option>
         ))}
```

`disabled` is optional, so every select that exists keeps working unchanged. It is `boolean | undefined` because the
repo has `exactOptionalPropertyTypes` on: a caller may write `disabled: cond ? true : undefined`. The `<option>`
gets the attribute as it is; `undefined` writes nothing. A native disabled option is greyed out and cannot be picked
with the mouse or the keyboard, in every browser, so there is no script to keep in step with it (mine 41).

### The reads and the sums: `lib/storefront-payouts.ts`

```ts
import {
  absMoney,
  compareMoney,
  isMoneyAmount,
  type PayoutFormValues,
  type PayoutMatchOutcome,
  type PayoutMatchRow,
  type PayoutParcel,
  type PayoutStatus,
  plainQuantity,
  routes,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';

import { call } from './api';

// Step 28c: Shop payouts' reads and the new payout's sums. Its own file, like storefront-orders.ts:
// only the payout pages load it. Every key starts with ['storefront', tenantId], so a payout saved
// or voided refreshes the couriers' Holds and the order page's parcel card too. No React here, so
// the spec runs without a DOM.

// ---------------------------------------------------------------------------------------------
// Reads

// The account select's choices (with what each holds) and the bank accounts
export function storefrontPayoutSetupQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'setup'],
    queryFn: () => call(routes.storefrontPayouts.setup),
  });
}

export interface PayoutFilter {
  // '' = both
  status: PayoutStatus | '';
  // '' = every courier account
  accountId: string;
}

export function storefrontPayoutsQuery(tenantId: string, filter: PayoutFilter) {
  return infiniteQueryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'list', filter],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      call(routes.storefrontPayouts.list, {
        query: {
          limit: 50,
          ...(filter.status !== '' && { status: filter.status }),
          ...(filter.accountId !== '' && { accountId: filter.accountId }),
          ...(pageParam !== null && { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (page) => page.nextCursor,
    // A filter change keeps the old rows until the first page comes: no flash of an empty table
    placeholderData: keepPreviousData,
  });
}

export function storefrontPayoutQuery(tenantId: string, payoutId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'one', payoutId],
    queryFn: () => call(routes.storefrontPayouts.get, { params: { id: payoutId } }),
    retry: false,
  });
}

// The parcels a new payout may take. Asked each time the page opens (staleTime 0, gcTime 0), like
// the pack plan: a parcel another member paid out a minute ago must not be offered again
export function storefrontPayoutParcelsQuery(tenantId: string, accountId: string) {
  return queryOptions({
    queryKey: ['storefront', tenantId, 'payouts', 'parcels', accountId],
    queryFn: () => call(routes.storefrontPayouts.parcels, { params: { id: accountId } }),
    staleTime: 0,
    gcTime: 0,
  });
}
```

Every key starts with `['storefront', tenantId]`, like the rest of the Storefront menu. Saving or voiding a payout then
refreshes the couriers' Holds column and the order page's parcel card with one `invalidateQueries`.

- **The list** is an infinite query, paged by the server's cursor, 50 rows a time. The filter object is part of the
  key, so each filter has its own cache. `keepPreviousData` keeps the old rows on screen while the new filter's first
  page loads; without it the table would flash empty on every change.
- **One payout** has `retry: false`. A wrong id answers 404, and three retries would only make the "doesn't exist"
  message wait.
- **The parcels** have `staleTime: 0` and `gcTime: 0`, like the Packed dialog's plan. A parcel another member paid out a
  minute ago must not be offered again just because the cache still had it.

```ts
// ---------------------------------------------------------------------------------------------
// The new payout's lines

export type PayoutLineValue = PayoutFormValues['lines'][number];
// What each charge box holds, ticked or not, by shipment id. An unticked parcel keeps its box, so
// ticking it again brings back what was typed
export type ChargeDrafts = Readonly<Record<string, string>>;

// The API answers money with 4 decimals ("60.0000"); the charge's schema takes 2 at most. The
// plain form ("60", "60.5") is the same amount and passes it
export function startDrafts(parcels: readonly PayoutParcel[]): ChargeDrafts {
  return Object.fromEntries(
    parcels.map((parcel) => [
      parcel.shipmentId,
      parcel.courierCharge === null ? '' : plainQuantity(parcel.courierCharge),
    ]),
  );
}

// The ticked lines in the parcels' order, so the server's "lines.3.charge" points at the row the
// page shows fourth among the ticked ones, the same order every time
export function orderLines(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
): PayoutLineValue[] {
  const order = new Map(parcels.map((parcel, index) => [parcel.shipmentId, index]));
  return lines.toSorted((a, b) => (order.get(a.shipmentId) ?? 0) - (order.get(b.shipmentId) ?? 0));
}

export interface PayoutTotals {
  collected: string;
  charges: string;
  net: string;
}

// The sums under the table, of the ticked lines only. A charge box that is empty or not a number
// yet counts as nothing: the sums follow the typing, and the save says what is wrong with the box
export function payoutTotals(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
): PayoutTotals {
  const ticked = new Set(lines.map((line) => line.shipmentId));
  const collected = sumMoney(
    parcels.filter((parcel) => ticked.has(parcel.shipmentId)).map((parcel) => parcel.collected),
  );
  const charges = sumMoney(
    lines.map((line) => line.charge.trim()).filter((charge) => isMoneyAmount(charge)),
  );
  return { collected, charges, net: subtractMoney(collected, charges) };
}

// The file's bank figure against the ticked lines' (P4): null when they agree, else how far apart,
// without its sign (the pill says "Out by ৳9.00" either way)
export function fileDifference(net: string, fileNet: string): string | null {
  return compareMoney(net, fileNet) === 0 ? null : absMoney(subtractMoney(fileNet, net));
}
```

- **`startDrafts`** fills each box with the courier's charge. The API sends money with 4 decimals (`"60.0000"`), but
  `payoutChargeSchema` takes 2 at most. `plainQuantity` writes the same amount without the trailing zeros (`"60"`), which
  the schema takes. Without it every untouched box would fail the save with `money_format`. The spec checks this.
- **`orderLines`** keeps the ticked lines in the parcels' order, not the order they were ticked in. The API names a bad
  line by its index (`lines.3.charge`). With a stable order, the form can put that error under the right row.
- **`payoutTotals`** adds the ticked lines only. A box that is empty, or not a number yet (`"6o"`), counts as nothing:
  the sums follow the typing without jumping to an error, and the save says what is wrong with the box. All sums use
  the contracts' money helpers on strings, never JavaScript numbers.
- **`fileDifference`** compares with `compareMoney`, so `"1886.0000"` and `"1886.00"` agree. It gives the difference
  without its sign, because the pill says "Out by ৳9.00" whichever way it is out.

```ts
// ---------------------------------------------------------------------------------------------
// The payout file

// P5: the rows that need a look first, then the ones that only say why nothing was ticked, then the
// ones found. A `satisfies` keeps it every outcome, each once: an outcome added to the contract
// fails the type check here
const OUTCOME_RANK = {
  different: 0,
  unknown: 1,
  invalid: 2,
  twice: 3,
  already_paid: 4,
  not_ready: 5,
  matched: 6,
} as const satisfies Record<PayoutMatchOutcome, number>;

// Stable: inside one outcome, the file's own order (the row numbers go up)
export function sortMatchRows(rows: readonly PayoutMatchRow[]): PayoutMatchRow[] {
  return rows.toSorted(
    (a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome] || a.row - b.row,
  );
}

// The count pills above the rows, in the same order, only the outcomes the file has
export function outcomeCounts(
  rows: readonly PayoutMatchRow[],
): { outcome: PayoutMatchOutcome; count: number }[] {
  const counts = new Map<PayoutMatchOutcome, number>();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  return [...counts]
    .map(([outcome, count]) => ({ outcome, count }))
    .toSorted((a, b) => OUTCOME_RANK[a.outcome] - OUTCOME_RANK[b.outcome]);
}

// A row whose parcel this payout can take: found, or found with another amount (the member decides,
// decision 12). Only a parcel the page lists: the list and the match apply the same rule, but the
// list may be a minute older than the match
function tickable(
  row: PayoutMatchRow,
  listed: ReadonlySet<string>,
): row is PayoutMatchRow & {
  shipmentId: string;
} {
  return (
    (row.outcome === 'matched' || row.outcome === 'different') &&
    row.shipmentId !== null &&
    listed.has(row.shipmentId)
  );
}

export function tickableCount(
  parcels: readonly PayoutParcel[],
  rows: readonly PayoutMatchRow[],
): number {
  const listed = new Set(parcels.map((parcel) => parcel.shipmentId));
  return rows.filter((row) => tickable(row, listed)).length;
}

// "Tick 4 parcels": the file's parcels ticked with the file's charges. A file with no charge
// column keeps each box as it is. Parcels ticked before stay ticked (the hint says so), so two
// files of one transfer can be matched one after the other
export function applyMatch(
  parcels: readonly PayoutParcel[],
  lines: readonly PayoutLineValue[],
  drafts: ChargeDrafts,
  rows: readonly PayoutMatchRow[],
): { lines: PayoutLineValue[]; drafts: ChargeDrafts; ticked: number } {
  const listed = new Set(parcels.map((parcel) => parcel.shipmentId));
  const next: Record<string, string> = { ...drafts };
  const ticked = new Set(lines.map((line) => line.shipmentId));
  let count = 0;
  for (const row of rows) {
    if (!tickable(row, listed)) continue;
    if (row.fileCharge !== null) next[row.shipmentId] = plainQuantity(row.fileCharge);
    ticked.add(row.shipmentId);
    count += 1;
  }
  return {
    lines: orderLines(
      parcels,
      [...ticked].map((shipmentId) => ({ shipmentId, charge: next[shipmentId] ?? '' })),
    ),
    drafts: next,
    ticked: count,
  };
}
```

- **`OUTCOME_RANK`** is the order of P5: the rows that need a look (another amount, an unknown number, a row that can't
  be read, a repeated number), then the ones that only say why nothing was ticked, then the ones found. `satisfies
  Record<PayoutMatchOutcome, number>` makes it list every outcome exactly once: an outcome added to the contract fails
  the type check here (checked on purpose below).
- **`sortMatchRows`** breaks ties by the row number, so inside one outcome the rows keep the file's order. That is the
  order the person sees in Excel.
- **`tickable`** takes a found row, or one with another amount (decision 12: the member decides), but only for a parcel
  the page lists. The match and the list follow the same rule (`payoutKindOf`), but the list may be a minute older. A
  parcel taken in that minute must not come back as a line the page does not show.
- **`applyMatch`** sets each ticked parcel's box to the file's charge. A file with no charge column (`fileCharge` null)
  keeps the box as it was. It keeps the parcels ticked before, so a payout split over two files can be matched one
  file after the other. `ticked` counts this file's rows for the toast.

```ts
import {
  PAYOUT_MATCH_OUTCOMES,
  payoutInputSchema,
  type PayoutMatchOutcome,
  type PayoutMatchRow,
  type PayoutParcel,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyMatch,
  fileDifference,
  orderLines,
  outcomeCounts,
  payoutTotals,
  sortMatchRows,
  startDrafts,
  tickableCount,
} from './storefront-payouts';

const A = '0193a1b2-0000-7000-8000-00000000000a';
const B = '0193a1b2-0000-7000-8000-00000000000b';
const C = '0193a1b2-0000-7000-8000-00000000000c';
const GONE = '0193a1b2-0000-7000-8000-0000000000ff';

// A parcel as the API answers it: money with 4 decimals
function parcel(
  shipmentId: string,
  collected: string,
  courierCharge: string | null,
  kind: PayoutParcel['kind'] = 'cod',
): PayoutParcel {
  return {
    shipmentId,
    kind,
    order: { id: shipmentId, number: `W-${shipmentId.slice(-3)}` },
    invoice: `W-${shipmentId.slice(-3)}`,
    trackingCode: null,
    consignmentId: null,
    status: kind === 'cod' ? 'delivered' : 'returned',
    collected,
    courierCharge,
    receipt: null,
    receiptDate: null,
    lastSyncedAt: null,
  };
}

const PARCELS = [
  parcel(A, '538.0000', '60.0000'),
  parcel(B, '1249.0000', null),
  parcel(C, '0.0000', '30.0000', 'charge'),
];

function row(
  n: number,
  outcome: PayoutMatchOutcome,
  shipmentId: string | null,
  fileCharge: string | null = null,
): PayoutMatchRow {
  return {
    row: n,
    key: `W-${String(n)}`,
    outcome,
    shipmentId,
    payout: null,
    fileCollected: null,
    fileCharge,
  };
}

describe('startDrafts', () => {
  it('starts each box with what the courier said, in a form the charge schema takes', () => {
    const drafts = startDrafts(PARCELS);
    expect(drafts).toEqual({ [A]: '60', [B]: '', [C]: '30' });
    // The API's "60.0000" has 4 decimals; the schema takes 2 at most
    const parsed = payoutInputSchema.safeParse({
      accountId: A,
      date: '2026-11-24',
      bankAccountId: B,
      reference: '',
      note: '',
      lines: [{ shipmentId: A, charge: drafts[A] }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('orderLines', () => {
  it("keeps the ticked lines in the parcels' order, whatever order they were ticked in", () => {
    const lines = orderLines(PARCELS, [
      { shipmentId: C, charge: '30' },
      { shipmentId: A, charge: '60' },
    ]);
    expect(lines.map((line) => line.shipmentId)).toEqual([A, C]);
  });
});

describe('payoutTotals', () => {
  it('adds up the ticked lines only', () => {
    expect(
      payoutTotals(PARCELS, [
        { shipmentId: A, charge: '60' },
        { shipmentId: C, charge: '30' },
      ]),
    ).toEqual({ collected: '538.0000', charges: '90.0000', net: '448.0000' });
  });

  it('counts a box that is empty or not a number yet as nothing', () => {
    expect(
      payoutTotals(PARCELS, [
        { shipmentId: A, charge: '' },
        { shipmentId: B, charge: '6o' },
      ]),
    ).toEqual({ collected: '1787.0000', charges: '0.0000', net: '1787.0000' });
  });

  it('goes below zero when the charges are more than the cash (the API refuses it)', () => {
    expect(payoutTotals(PARCELS, [{ shipmentId: C, charge: '30' }]).net).toBe('-30.0000');
  });
});

describe('fileDifference', () => {
  it('is null when the file and the lines agree, at any number of decimals', () => {
    expect(fileDifference('1886.0000', '1886.00')).toBeNull();
  });

  it('is how far apart they are, without its sign', () => {
    expect(fileDifference('1886.0000', '1877.00')).toBe('9.0000');
    expect(fileDifference('1877.0000', '1886.00')).toBe('9.0000');
  });
});

describe('sortMatchRows and outcomeCounts', () => {
  const rows = [
    row(2, 'matched', A),
    row(3, 'already_paid', null),
    row(4, 'different', B),
    row(5, 'unknown', null),
    row(6, 'matched', C),
    row(7, 'invalid', null),
  ];

  it('puts the rows that need a look first, the file order inside each outcome', () => {
    expect(sortMatchRows(rows).map((item) => item.row)).toEqual([4, 5, 7, 3, 2, 6]);
  });

  it('counts each outcome the file has, in the same order', () => {
    expect(outcomeCounts(rows)).toEqual([
      { outcome: 'different', count: 1 },
      { outcome: 'unknown', count: 1 },
      { outcome: 'invalid', count: 1 },
      { outcome: 'already_paid', count: 1 },
      { outcome: 'matched', count: 2 },
    ]);
  });

  it('ranks every outcome of the contract', () => {
    const all = PAYOUT_MATCH_OUTCOMES.map((outcome, index) => row(index + 2, outcome, null));
    expect(sortMatchRows(all)).toHaveLength(PAYOUT_MATCH_OUTCOMES.length);
  });
});

describe('applyMatch', () => {
  it("ticks the found and other-amount rows' parcels with the file's charges", () => {
    const result = applyMatch(PARCELS, [], startDrafts(PARCELS), [
      row(2, 'matched', A, '65.00'),
      row(3, 'different', B, '60.00'),
      row(4, 'already_paid', C),
    ]);
    expect(result.ticked).toBe(2);
    expect(result.lines).toEqual([
      { shipmentId: A, charge: '65' },
      { shipmentId: B, charge: '60' },
    ]);
    expect(result.drafts[A]).toBe('65');
  });

  it('keeps a box as it is when the file has no charge column', () => {
    const result = applyMatch(PARCELS, [], startDrafts(PARCELS), [row(2, 'matched', A)]);
    expect(result.lines).toEqual([{ shipmentId: A, charge: '60' }]);
  });

  it('keeps the parcels ticked before, in the parcels’ order', () => {
    const result = applyMatch(PARCELS, [{ shipmentId: C, charge: '30' }], startDrafts(PARCELS), [
      row(2, 'matched', A),
    ]);
    expect(result.lines.map((line) => line.shipmentId)).toEqual([A, C]);
    expect(result.ticked).toBe(1);
  });

  it('never ticks a parcel the page does not list (taken since the list was read)', () => {
    const rows = [row(2, 'matched', GONE), row(3, 'unknown', null)];
    expect(tickableCount(PARCELS, rows)).toBe(0);
    expect(applyMatch(PARCELS, [], {}, rows)).toEqual({ lines: [], drafts: {}, ticked: 0 });
  });
});
```

The spec runs without a DOM, like the other `lib` specs. The parcels are built the way the API answers them, with 4
decimals, so the tests see the same strings the page does. The first test also parses a line with the contract's
own schema, which is the check that matters for `startDrafts`.

### The parts the payout pages share

```tsx
import {
  ArrowLeft01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { PayoutAccount, PayoutStatus } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Pill } from '@omnivo/ui';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';

// Step 28c: what the payout pages share. Small on purpose: the list, the new payout and the payout's
// page each load it.

// Like a money receipt's: posted is good, a voided one is neutral (it stays in the list, P2)
export function PayoutStatusPill({ status }: { status: PayoutStatus }) {
  const { t } = useLocale();
  return status === 'voided' ? (
    <Pill tone="neutral" icon={CancelCircleIcon}>
      {t('storefront.payouts.statuses.voided')}
    </Pill>
  ) : (
    <Pill tone="good" icon={CheckmarkCircle02Icon}>
      {t('storefront.payouts.statuses.posted')}
    </Pill>
  );
}

// An account's name, with "(archived)" on an archived one: it keeps its payouts and can still pay
// out (decision 4), so the selects list it, and the words say why it is not on Shop couriers' tab
export function usePayoutAccountName(): (
  account: Pick<PayoutAccount, 'name' | 'archived'>,
) => string {
  const { t } = useLocale();
  return useCallback(
    (account) =>
      account.archived
        ? t('storefront.payouts.archivedAccount', { name: account.name })
        : account.name,
    [t],
  );
}

// Back to the list, from a new payout and from a payout's page
export function PayoutBackLink() {
  const { t } = useLocale();
  return (
    <Link
      to="/storefront/payouts"
      className="inline-flex w-fit items-center gap-1.5 text-body-sm font-medium text-brand underline-offset-3 hover:underline"
    >
      <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
      {t('storefront.payout.back')}
    </Link>
  );
}
```

The status pill is a money receipt's (P2): posted is `good`, voided is neutral, each with its icon and its word, so
colour is never the only sign. `usePayoutAccountName` adds "(archived)": an archived account keeps its payouts and
can still pay out (decision 4), so the list's filter and the new payout's select both show it, and the words say why
it is not on Shop couriers' Active tab. The back link is here, not in a route file: the form and the payout page
import it, and a component importing a route module would tie two lazy chunks together.

### The routes and the menu

```diff
@@ -6,7 +6,7 @@ import {
   Outlet,
   redirect,
 } from '@tanstack/react-router';
-import { INVITE_PATH, type StorefrontOrderView } from '@omnivo/contracts';
+import { INVITE_PATH, type PayoutStatus, type StorefrontOrderView } from '@omnivo/contracts';
 
 import { restoreSession } from './lib/session';
 import { sessionStore } from './lib/session-store';
@@ -1103,6 +1103,55 @@ const storefrontCouriersRoute = createRoute({
   ),
 });
 
+// Step 28c: the couriers' payouts (decision 13), storefront.payout.manage: the sidebar hides them,
+// and the API refuses the reads for anyone else. The list's two filters are search params, so Back
+// from a payout lands on the same list (approved with the mockup). The statuses are written out
+// for the same reason as ORDER_VIEWS: the contracts' storefront-payouts module stays out of the
+// first chunk; `satisfies` keeps them the contract's
+const PAYOUT_STATUSES_SEARCH: readonly PayoutStatus[] = Object.values({
+  posted: 'posted',
+  voided: 'voided',
+} as const satisfies { [Status in PayoutStatus]: Status });
+
+const storefrontPayoutsRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/payouts',
+  validateSearch: (
+    search: Record<string, unknown>,
+  ): { status?: PayoutStatus; account?: string } => {
+    const status = PAYOUT_STATUSES_SEARCH.find((candidate) => candidate === search.status);
+    return {
+      ...(status !== undefined && { status }),
+      ...(typeof search.account === 'string' &&
+        UUID.test(search.account) && { account: search.account }),
+    };
+  },
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-payouts'),
+    'StorefrontPayoutsPage',
+  ),
+});
+
+// "Record payout" in a courier account's row menu comes with ?account=. '/…/new' beats '/…/$id'
+const newStorefrontPayoutRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/payouts/new',
+  validateSearch: (search: Record<string, unknown>): { account?: string } =>
+    typeof search.account === 'string' && UUID.test(search.account)
+      ? { account: search.account }
+      : {},
+  component: lazyRouteComponent(
+    () => import('./routes/storefront-payout'),
+    'NewStorefrontPayoutPage',
+  ),
+});
+
+const storefrontPayoutRoute = createRoute({
+  getParentRoute: () => appRoute,
+  path: '/storefront/payouts/$payoutId',
+  component: lazyRouteComponent(() => import('./routes/storefront-payout'), 'StorefrontPayoutPage'),
+});
+
 const storefrontCategoriesRoute = createRoute({
   getParentRoute: () => appRoute,
   path: '/storefront/categories',
@@ -1318,6 +1367,9 @@ const routeTree = rootRoute.addChildren([
     storefrontListingRoute,
     storefrontCouponsRoute,
     storefrontCouriersRoute,
+    storefrontPayoutsRoute,
+    newStorefrontPayoutRoute,
+    storefrontPayoutRoute,
     storefrontCategoriesRoute,
     storefrontSettingsRoute,
     storefrontAppearanceRoute,
```

- **The list's filters are search params** (`?status=voided&account=…`). Back from a payout then lands on the same
  filtered list, and a filtered list can be bookmarked. Anything that is not a status or a UUID is dropped, so a typed
  address never reaches the API as nonsense.
- **The statuses are written out** for the same reason as `ORDER_VIEWS` above them: importing `PAYOUT_STATUSES` would put
  the contracts' payouts module into the first chunk, which every page loads. `satisfies { [Status in PayoutStatus]:
  Status }` keeps the list equal to the contract's: a status added there fails the type check here.
- **`/new` is declared before `/$payoutId`.** TanStack Router ranks a static segment above a parameter anyway, and the
  order also reads that way.
- **Both payout pages come from one route file**, each with its own lazy component, like the money receipt's.

```diff
@@ -1,6 +1,7 @@
 import {
   ArrowDataTransferHorizontalIcon,
   BalanceScaleIcon,
+  BankIcon,
   Book02Icon,
   BookOpen02Icon,
   CalendarClockIcon,
@@ -677,7 +678,9 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
               group the shop sells from */}
           {/* Step 27b (decision 10): the group shows for the people who run the shop and for the
               packers, who may only read and move its orders. They see Shop orders alone */}
-          {(can('storefront.manage') || canShopOrders) && (
+          {/* Step 28c: and for the people who record the couriers' payouts, like an accountant
+              with no other shop permission, who sees Shop payouts alone */}
+          {(can('storefront.manage') || canShopOrders || can('storefront.payout.manage')) && (
             <NavGroup label={t('nav.storefront')}>
               {/* Decision 34: first, the page the shop's staff open every day. The count is the
                   orders that wait to be packed, crit like the approvals count: work to do */}
@@ -720,6 +723,13 @@ export function AppShell({ lock }: { lock: LockAction | undefined }) {
                   </NavLink>
                 </>
               )}
+              {/* Step 28c (decision 13): after Shop couriers, the money those accounts hold. The
+                  icon is Bank, not Money receipts' MoneyReceive02 (P1): an accountant sees both */}
+              {can('storefront.payout.manage') && (
+                <NavLink to="/storefront/payouts" icon={BankIcon}>
+                  {t('nav.storefrontPayouts')}
+                </NavLink>
+              )}
             </NavGroup>
           )}
           <NavGroup label={t('nav.workspace')}>
```

The group's rule gains `storefront.payout.manage`. Before, an accountant with only that permission had no Storefront
group, and so no way to reach the page. Now they see the group with Shop payouts alone. The item sits after Shop
couriers (decision 13) with the `Bank` icon (P1). It has its own `can()`, outside the `storefront.manage` block,
because a shop manager without payouts must not see it and an accountant without the shop must.

### The list: `routes/storefront-payouts.tsx`

```tsx
import { BankIcon, PlusSignIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { PAYOUT_STATUSES, type PayoutStatus, type PayoutSummary } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  DataTable,
  dataTableColumns,
  EmptyState,
  PageHeader,
  SegmentedControl,
  SelectField,
} from '@omnivo/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

import { useIsoDate } from '../components/stock-parts';
import { PayoutStatusPill, usePayoutAccountName } from '../components/storefront-payout-parts';
import { StorefrontOffline } from '../components/storefront-parts';
import { storefrontPayoutSetupQuery, storefrontPayoutsQuery } from '../lib/storefront-payouts';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 28c: Storefront → Shop payouts (decision 13, approved with the mockup),
// storefront.payout.manage. A data table, newest date first and paged by the server, filtered by
// the courier account and the status, both in the address. A voided payout stays with its pill
// (P2). Whole taka, as a list shows money; the payout's page has the paisa. Online only, like the
// whole Storefront menu.

const column = dataTableColumns<PayoutSummary>();

export function StorefrontPayoutsPage() {
  const { t, format } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const online = useOnline();
  const isoDate = useIsoDate();
  const accountName = usePayoutAccountName();
  const { status = '', account = '' } = useSearch({ from: '/app/storefront/payouts' });
  const filtered = status !== '' || account !== '';

  const { data: setup } = useQuery({ ...storefrontPayoutSetupQuery(tenantId), enabled: online });
  const { data, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...storefrontPayoutsQuery(tenantId, { status, accountId: account }),
    enabled: online,
  });
  const rows = useMemo(() => data?.pages.flatMap((page) => page.items), [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // The address keeps the filters: Back from a payout lands on the same list. replace: a filter is
  // not a page of its own in the history
  const setFilter = (next: { status?: PayoutStatus | ''; account?: string }) => {
    const nextStatus = next.status ?? status;
    const nextAccount = next.account ?? account;
    void navigate({
      to: '/storefront/payouts',
      search: {
        ...(nextStatus !== '' && { status: nextStatus }),
        ...(nextAccount !== '' && { account: nextAccount }),
      },
      replace: true,
    });
  };

  const money = useCallback((value: string) => format.money(value, { decimals: 0 }), [format]);
  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('number', {
          header: t('storefront.payouts.columns.number'),
          enableSorting: false,
          meta: { card: 'title' },
          cell: ({ getValue }) => (
            <span className="font-mono font-medium tabular-nums">{getValue()}</span>
          ),
        }),
        column.accessor('date', {
          header: t('storefront.payouts.columns.date'),
          enableSorting: false,
          meta: { card: 'subtitle' },
          cell: ({ row }) => (
            // On a phone the card's sub-line says the account too: the column is hidden there
            <span className="tabular-nums">
              {isoDate(row.original.date)}
              <span className="min-[860px]:hidden"> · {row.original.account.name}</span>
            </span>
          ),
        }),
        column.accessor((payout) => payout.account.name, {
          id: 'account',
          header: t('storefront.payouts.columns.account'),
          enableSorting: false,
        }),
        column.accessor('reference', {
          header: t('storefront.payouts.columns.reference'),
          enableSorting: false,
          cell: ({ getValue }) => {
            const reference = getValue();
            return reference === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className="font-mono text-label">{reference}</span>
            );
          },
        }),
        column.accessor('parcels', {
          header: t('storefront.payouts.columns.parcels'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => format.number(getValue()),
        }),
        column.accessor('collected', {
          header: t('storefront.payouts.columns.collected'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => money(getValue()),
        }),
        column.accessor('charges', {
          header: t('storefront.payouts.columns.charges'),
          enableSorting: false,
          meta: { align: 'end' },
          cell: ({ getValue }) => money(getValue()),
        }),
        // What reached the bank: the figure a person matches against the statement, so it is the
        // one at 500 and the card's right-hand number on a phone
        column.accessor('net', {
          header: t('storefront.payouts.columns.net'),
          enableSorting: false,
          meta: { align: 'end', card: 'trailing' },
          cell: ({ getValue }) => <span className="font-medium">{money(getValue())}</span>,
        }),
        column.accessor('status', {
          header: t('storefront.payouts.columns.status'),
          enableSorting: false,
          meta: { card: 'detail' },
          cell: ({ getValue }) => <PayoutStatusPill status={getValue()} />,
        }),
      ]),
    [t, format, isoDate, money],
  );

  const write = (
    <Button
      onClick={() =>
        void navigate({
          to: '/storefront/payouts/new',
          search: account === '' ? {} : { account },
        })
      }
    >
      <HugeiconsIcon icon={PlusSignIcon} size={17} strokeWidth={1.5} />
      {t('storefront.payouts.new')}
    </Button>
  );

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PageHeader
        title={t('storefront.payouts.title')}
        description={t('storefront.payouts.description')}
        actions={online && write}
      />
      {!online ? (
        <StorefrontOffline />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <div className="w-full min-w-0 sm:w-80">
              <SelectField
                label={t('storefront.payouts.account')}
                value={account}
                onChange={(event) => {
                  setFilter({ account: event.target.value });
                }}
                options={[
                  { value: '', label: t('storefront.payouts.allAccounts') },
                  ...(setup?.accounts ?? []).map((choice) => ({
                    value: choice.id,
                    label: accountName(choice),
                  })),
                ]}
              />
            </div>
            <SegmentedControl
              label={t('storefront.payouts.view')}
              value={status}
              options={[
                { value: '', label: t('storefront.payouts.views.all') },
                ...PAYOUT_STATUSES.map((value) => ({
                  value,
                  label: t(`storefront.payouts.views.${value}`),
                })),
              ]}
              onChange={(next) => {
                setFilter({ status: next });
              }}
            />
          </div>
          {isError && (
            <p className="text-body-sm text-crit">{t('storefront.payouts.loadFailed')}</p>
          )}
          {rows && (
            <DataTable
              label={t('storefront.payouts.title')}
              data={rows}
              columns={columns}
              getRowId={(row) => row.id}
              onRowClick={(row) =>
                void navigate({
                  to: '/storefront/payouts/$payoutId',
                  params: { payoutId: row.id },
                })
              }
              onEndReached={loadMore}
              empty={
                filtered ? (
                  <EmptyState
                    icon={BankIcon}
                    title={t('storefront.payouts.filteredEmptyTitle')}
                    description={t('storefront.payouts.filteredEmptyBody')}
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setFilter({ status: '', account: '' });
                        }}
                      >
                        {t('storefront.payouts.showAll')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={BankIcon}
                    title={t('storefront.payouts.emptyTitle')}
                    description={t('storefront.payouts.emptyBody')}
                    action={write}
                  />
                )
              }
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

- **`useSearch({ from: '/app/storefront/payouts' })`** reads the two filters with this route's own types. With
  `strict: false` the type would be every route's search params merged, and `status` would not be narrowed to
  `PayoutStatus`.
- **`setFilter`** builds the next address from the current one and the change, and navigates with `replace: true`. A
  filter is not a page of its own, so Back leaves the list instead of undoing filters one by one. The two values are
  read into their own `const`s first: TypeScript narrows a plain variable after `!== ''`, which the spread needs to
  stay a `PayoutStatus`.
- **The columns.** The number is `Geist Mono`. On a phone the account column is hidden (it has no `meta.card`), so the
  card's sub-line adds it after the date (`min-[860px]:hidden` hides that copy on a wide screen, where the column
  shows it). "To the bank" is the card's trailing number and the column at weight 500: it is the figure a person holds
  against the bank statement. Money is whole taka (`decimals: 0`), as every list shows it.
- **"Record payout"** keeps the account filter: from a list filtered to Steadfast Dhaka, the new payout starts with
  Steadfast Dhaka.
- **Two empty states:** a filtered list says nothing matches and offers "Show every payout", which clears both
  filters; an empty workspace says what the page is for and offers Record payout.
- **Online only**, like the whole Storefront menu: offline the header stays and the body is "Needs a connection".

### Two pages in one route file: `routes/storefront-payout.tsx`

```tsx
import { AlertCircleIcon } from '@hugeicons/core-free-icons';
import { useLocale } from '@omnivo/i18n';
import { EmptyState } from '@omnivo/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense } from 'react';

import { useToday } from '../components/stock-parts';
import { PayoutBackLink } from '../components/storefront-payout-parts';
import { StorefrontOffline } from '../components/storefront-parts';
import { storefrontPayoutQuery, storefrontPayoutSetupQuery } from '../lib/storefront-payouts';
import { useOnline } from '../lib/use-online';
import { useTenantId } from '../lib/workspace';

// Step 28c: a new payout (/storefront/payouts/new, "Record payout" in a courier account's row menu
// comes with ?account=) and a payout's page. Each in its own chunk, like the money receipt's: the
// form brings the date picker and the parcels table, the page the print sheet.

const PayoutForm = lazy(async () => ({
  default: (await import('../components/storefront-payout-form')).PayoutForm,
}));
const PayoutView = lazy(async () => ({
  default: (await import('../components/storefront-payout-view')).PayoutView,
}));

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      {children}
    </div>
  );
}

export function NewStorefrontPayoutPage() {
  const online = useOnline();
  const today = useToday();
  const { account = '' } = useSearch({ strict: false });
  const { data: setup } = useQuery({
    ...storefrontPayoutSetupQuery(useTenantId()),
    enabled: online,
  });
  if (!online) {
    return (
      <Frame>
        <StorefrontOffline />
      </Frame>
    );
  }
  if (!setup) return null;
  // An account the address names that is not in the setup (another workspace's, or a typo) starts
  // the form empty instead of asking the API for its parcels
  const start = setup.accounts.some((choice) => choice.id === account) ? account : '';
  return (
    <Suspense fallback={null}>
      <PayoutForm setup={setup} accountId={start} today={today} />
    </Suspense>
  );
}

export function StorefrontPayoutPage() {
  const { t } = useLocale();
  const online = useOnline();
  const today = useToday();
  const { payoutId = '' } = useParams({ strict: false });
  const { data: payout, isError } = useQuery({
    ...storefrontPayoutQuery(useTenantId(), payoutId),
    enabled: online && payoutId !== '',
  });
  if (!online) {
    return (
      <Frame>
        <StorefrontOffline />
      </Frame>
    );
  }
  if (isError) {
    return (
      <Frame>
        <EmptyState
          icon={AlertCircleIcon}
          title={t('storefront.payouts.title')}
          description={t('storefront.payout.notFound')}
        />
      </Frame>
    );
  }
  if (!payout) return null;
  return (
    <Suspense fallback={null}>
      <PayoutView payout={payout} today={today} />
    </Suspense>
  );
}
```

- **The form waits for the setup** (the account choices and the bank accounts). Its defaults are worked out once, as
  it mounts, so it must not mount before they arrive.
- **An address account that is not in the setup** (a typo, or another workspace's link) starts the form empty instead
  of asking the API for parcels it would refuse.
- **A payout that can't be read** shows an empty state with the back link. That covers a wrong id and a payout of
  another workspace (the API answers 404 for both).

### The new payout: `components/storefront-payout-form.tsx`

```tsx
import {
  Alert02Icon,
  BankIcon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  FileImportIcon,
  InformationCircleIcon,
  Note01Icon,
  ShippingTruck01Icon,
  Tag01Icon,
  Wallet01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  contractErrorMap,
  type PayoutAccount,
  type PayoutFormValues,
  type PayoutMatchRow,
  type PayoutParcel,
  type PayoutSetup,
  payoutInputSchema,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  cn,
  Dialog,
  EmptyState,
  FormAlert,
  FormField,
  Input,
  MoneyInput,
  PageHeader,
  Pill,
  SelectField,
  TextField,
  toast,
} from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { Controller, type FieldErrors, type Path, useForm, useWatch } from 'react-hook-form';

import { ApiRequestError, call } from '../lib/api';
import { applyApiError } from '../lib/field-errors';
import { rowPath } from '../lib/products';
import {
  applyMatch,
  type ChargeDrafts,
  fileDifference,
  orderLines,
  type PayoutLineValue,
  payoutTotals,
  startDrafts,
  storefrontPayoutParcelsQuery,
} from '../lib/storefront-payouts';
import { useTenantId } from '../lib/workspace';
import { DocumentNotice } from './document-notice';
import { ParcelPill } from './storefront-order-pills';
import { useIsoDate } from './stock-parts';
import { PayoutBackLink, usePayoutAccountName } from './storefront-payout-parts';
import { useShopMoney } from './storefront-parts';

// Step 28c: Record a courier payout (approved with the mockup, P3–P5 and P7). Its own chunk, loaded
// by routes/storefront-payout.tsx. A payout is never a draft: saving posts it, so this form is only
// for a new one. The form card (account, date, paid into, reference, note), then the Parcels card:
// every parcel of the account that no payout has taken, none ticked at first.

const DatePicker = lazy(async () => ({ default: (await import('./date-input')).DatePicker }));
// The file dialog is its own chunk: most payouts are ticked by hand, and the CSV reading and the
// outcome list need not ride with the form
const PayoutFileDialog = lazy(async () => ({
  default: (await import('./storefront-payout-file')).PayoutFileDialog,
}));

type FormValues = PayoutFormValues;

function fieldNames(count: number): Path<FormValues>[] {
  return [
    'accountId',
    'date',
    'bankAccountId',
    'reference',
    'note',
    'lines',
    ...Array.from({ length: count }, (_, index) => [
      rowPath('lines', index, 'shipmentId'),
      rowPath('lines', index, 'charge'),
    ]).flat(),
  ];
}

// The account select's option: what it holds, so the person picks the one whose money arrived.
// Without a COD account there is nothing to pay out: shown, but not offered
function useAccountOption(): (account: PayoutAccount) => {
  value: string;
  label: string;
  disabled: boolean;
} {
  const { t, format } = useLocale();
  const nameOf = usePayoutAccountName();
  return (account) => {
    const name = nameOf(account);
    if (account.codAccount === null) {
      return {
        value: account.id,
        label: t('storefront.payout.accountNoCod', { name }),
        disabled: true,
      };
    }
    return {
      value: account.id,
      label:
        account.holds.parcels === 0
          ? t('storefront.payout.accountHoldsNothing', { name })
          : t('storefront.payout.accountHolds', {
              name,
              amount: format.money(account.holds.amount, { decimals: 0 }),
              count: account.holds.parcels,
              formatted: format.number(account.holds.parcels),
            }),
      disabled: false,
    };
  };
}
```

- **Two lazy imports.** The date picker brings the calendar's popover. The file dialog is its own chunk too (P5): most
  payouts are ticked by hand, and the CSV reading and the outcome list need not load with every form.
- **`fieldNames`** lists every path the API may name (`lines.3.charge`, `lines.3.shipmentId`), so `applyApiError`
  can put a server error under its box. Built from the lines' count at the time of the error.
- **`useAccountOption`** writes each option as mine 36 says: what the account holds, in whole taka and the reader's
  digits, with `count` for the plural. An account with no COD account is disabled (mine 41).

```tsx
export function PayoutForm({
  setup,
  accountId: startAccount,
  today,
}: {
  setup: PayoutSetup;
  // From "Record payout" in a courier account's row menu; '' = pick one
  accountId: string;
  today: string;
}) {
  const { t, errorText } = useLocale();
  const navigate = useNavigate();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const optionOf = useAccountOption();
  const nameOf = usePayoutAccountName();
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(payoutInputSchema, { error: contractErrorMap }),
    defaultValues: {
      accountId: startAccount,
      date: today,
      // One bank account needs no choice
      bankAccountId: setup.bankAccounts.length === 1 ? (setup.bankAccounts[0]?.id ?? '') : '',
      reference: '',
      note: '',
      lines: [],
    },
  });
  const accountId = useWatch({ control, name: 'accountId' });
  const account = setup.accounts.find((choice) => choice.id === accountId) ?? null;
  // Decision 7: the money leaves the COD account for the bank, so the COD account is never the bank
  const bankChoices = setup.bankAccounts.filter((choice) => choice.id !== account?.codAccount?.id);
  const canPay = account !== null && account.codAccount !== null;
  const parcelsQuery = useQuery({
    ...storefrontPayoutParcelsQuery(tenantId, accountId),
    enabled: canPay,
  });
  const parcels = parcelsQuery.data?.parcels;
  // The charge boxes, ticked or not, from what the courier said; and the file's bank figure once
  // a file was matched. Both belong to one account: picking another starts them again
  const [drafts, setDrafts] = useState<ChargeDrafts | null>(null);
  const [fileNet, setFileNet] = useState<string | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const shownDrafts = drafts ?? (parcels ? startDrafts(parcels) : {});

  const pickAccount = (next: string) => {
    setValue('accountId', next, { shouldValidate: errors.accountId !== undefined });
    setValue('lines', []);
    setDrafts(null);
    setFileNet(null);
    clearErrors('lines');
    // The COD account of the new courier is no bank for its own payout
    const cod = setup.accounts.find((choice) => choice.id === next)?.codAccount?.id;
    if (cod !== undefined && getValues('bankAccountId') === cod) setValue('bankAccountId', '');
    // The address names the account, so a reload or Back keeps it (replace: not a new page)
    void navigate({
      to: '/storefront/payouts/new',
      search: next === '' ? {} : { account: next },
      replace: true,
    });
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      const saved = await call(routes.storefrontPayouts.create, { body: values });
      // The couriers' Holds, the parcels' "Paid out on" and the journal all changed
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
        queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
      ]);
      toast(t('storefront.payout.created', { number: saved.number }));
      void navigate({
        to: '/storefront/payouts/$payoutId',
        params: { payoutId: saved.id },
        replace: true,
      });
    } catch (error) {
      // Another payout took a parcel, or its receipt was voided a moment ago: the parcels are read
      // again, the lines of the ones gone are dropped, and the error stays at the top, where it
      // still makes sense once its row is gone
      if (error instanceof ApiRequestError && error.code === 'payout_parcel_unavailable') {
        const fresh = (await parcelsQuery.refetch()).data?.parcels ?? [];
        const listed = new Set(fresh.map((parcel) => parcel.shipmentId));
        setValue(
          'lines',
          getValues('lines').filter((line) => listed.has(line.shipmentId)),
        );
        setError('root.server', { message: 'payout_parcel_unavailable' });
        return;
      }
      applyApiError(error, fieldNames(getValues('lines').length), setError);
    }
  });

  const failure = errors.root?.server?.message;
  const courier = account === null ? '' : t(`storefront.couriers.names.${account.courier}`);
```

- **The defaults.** The date is today (the money usually arrives the day it is recorded). One bank account is picked
  for the member; with more, they choose, because a wrong bank is worse than a click.
- **The bank choices leave out the account's own COD account** (decision 7): the money leaves the COD account, so it
  cannot also arrive there. The API refuses it too.
- **The parcels are read only when the account can pay out** (`canPay`). An account with no COD account would only
  get `payout_account_no_cod`.
- **`drafts` starts as `null`** and means "the courier's figures" until the first change (mine 43). That way a parcels
  answer that arrives after the first render still fills the boxes, with no effect to keep in step.
- **`pickAccount`** clears what belonged to the old account: the ticked lines, the boxes, the file's figure and their
  errors. If the bank picked so far is the new account's COD account, it is cleared too. The address follows the
  select (`replace: true`), so a reload keeps the account.
- **Saving** invalidates the whole storefront menu (Holds, the parcels' "Paid out on") and the journal, then opens
  the payout with `replace: true`, so Back from it does not reopen a form that was already saved.
- **A parcel taken meanwhile** (mine 44): the parcels are read again with `refetch()`, the lines of the parcels that
  are gone are dropped, and the error goes to the top of the form.

```tsx
  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      <PageHeader
        title={t('storefront.payout.newTitle')}
        description={t('storefront.payout.newDescription')}
      />
      <form
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="grid grid-cols-1 gap-5"
      >
        {failure && <FormAlert message={failure} />}
        <Card className="grid grid-cols-1 gap-5 p-5 sm:grid-cols-2 sm:gap-x-4 lg:grid-cols-3">
          <div className="sm:col-span-2">
            <SelectField
              label={t('storefront.payout.account')}
              icon={ShippingTruck01Icon}
              options={[
                { value: '', label: t('storefront.payout.accountPlaceholder') },
                ...setup.accounts.map(optionOf),
              ]}
              {...register('accountId')}
              onChange={(event) => {
                pickAccount(event.target.value);
              }}
              error={errors.accountId?.message}
            />
          </div>
          <FormField
            control={control}
            name="date"
            label={t('storefront.payout.date')}
            hint={t('storefront.payout.dateHint')}
          >
            {(field) => (
              <Suspense fallback={<Input id={field.id} icon={Calendar03Icon} disabled />}>
                <DatePicker {...field} />
              </Suspense>
            )}
          </FormField>
          <div className="sm:col-span-2">
            <SelectField
              label={t('storefront.payout.bankAccount')}
              icon={Wallet01Icon}
              hint={t('storefront.payout.bankAccountHint')}
              disabled={bankChoices.length === 0}
              options={[
                { value: '', label: t('storefront.payout.bankAccountPlaceholder') },
                ...bankChoices.map((choice) => ({
                  value: choice.id,
                  label: `${choice.code} · ${choice.name}`,
                })),
              ]}
              {...register('bankAccountId')}
              // Nothing to pick is said as an error at once (approved with the mockup): the form
              // can't be saved until someone fixes the chart
              error={
                bankChoices.length === 0
                  ? t('storefront.payout.noBankAccounts')
                  : errors.bankAccountId?.message
              }
            />
          </div>
          <TextField
            label={t('storefront.payout.reference')}
            icon={Tag01Icon}
            optional
            placeholder={t('storefront.payout.referencePlaceholder')}
            hint={t('storefront.payout.referenceHint')}
            {...register('reference')}
            error={errors.reference?.message}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <TextField
              label={t('storefront.payout.note')}
              icon={Note01Icon}
              optional
              placeholder={t('storefront.payout.notePlaceholder')}
              {...register('note')}
              error={errors.note?.message}
            />
          </div>
        </Card>

        {/* Before the parcels: a charge has nowhere to go, so only parcels with no charge can be
            paid out (the API refuses the rest, payout_account_no_charges) */}
        {account !== null && account.codAccount !== null && account.chargeAccount === null && (
          <DocumentNotice tone="warn" icon={Alert02Icon}>
            {t('storefront.payout.noChargeAccount', { name: account.name })}
          </DocumentNotice>
        )}
```

- **The form card** has the money receipt's grid: one column on a phone, two from `sm`, three from `lg`. The account
  select takes two columns, so its long option ("Steadfast Dhaka · holds ৳45,200 in 18 parcels") is not cut.
- **The account select** spreads `register('accountId')` and then replaces `onChange` with `pickAccount`. The spread
  must come first: the later prop wins, and `pickAccount` sets the value itself with `setValue`.
- **No bank account to pick** is shown as an error at once (approved with the mockup). The form can't be saved until
  someone ticks "Holds money" on a bank account in the chart, and the words say exactly that. `errorText` passes a
  sentence through unchanged, so the select's `error` can take the words instead of a code.
- **The warn notice** comes before the parcels (decision `noChargeAccount`, 28c.5): with no charges account any line
  with a charge is refused, so the member learns it before ticking anything.

```tsx
        <Card className="@container overflow-hidden">
          <CardHeader
            title={t('storefront.payout.parcelsTitle')}
            subtitle={
              account === null
                ? undefined
                : t('storefront.payout.parcelsDescription', { name: account.name })
            }
            actions={
              parcels !== undefined &&
              parcels.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setFileOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={FileImportIcon} size={16} strokeWidth={1.5} />
                  {t('storefront.payout.matchFile')}
                </Button>
              )
            }
          />
          {!canPay ? (
            <p className="flex items-start gap-1.5 px-5 pt-3 pb-5 text-label text-ink-2">
              <HugeiconsIcon
                icon={InformationCircleIcon}
                size={15}
                strokeWidth={1.5}
                className="mt-0.5 shrink-0 text-ink-3"
              />
              {t('storefront.payout.pickAccountFirst')}
            </p>
          ) : parcelsQuery.isError ? (
            <p className="px-5 pt-3 pb-5 text-body-sm text-crit">{errorText('unknown_error')}</p>
          ) : parcels === undefined ? null : parcels.length === 0 ? (
            <EmptyState
              icon={BankIcon}
              title={t('storefront.payout.noParcelsTitle')}
              description={t('storefront.payout.noParcelsBody', { name: account.name })}
            />
          ) : (
            <Controller
              control={control}
              name="lines"
              render={({ field }) => (
                <ParcelsTable
                  parcels={parcels}
                  courier={courier}
                  lines={field.value}
                  drafts={shownDrafts}
                  onChange={(lines, nextDrafts) => {
                    field.onChange(lines);
                    setDrafts(nextDrafts);
                  }}
                  errors={errors}
                  fileNet={fileNet}
                />
              )}
            />
          )}
        </Card>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="mr-auto max-w-xl text-label text-ink-3">
            {t('storefront.payout.saveHint')}
          </p>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('common.saving') : t('storefront.payout.save')}
          </Button>
        </div>
      </form>

      <Dialog open={fileOpen} onOpenChange={setFileOpen}>
        <Suspense fallback={null}>
          {fileOpen && account !== null && parcels !== undefined && (
            <PayoutFileDialog
              accountId={account.id}
              accountName={nameOf(account)}
              parcels={parcels}
              onApply={(rows: readonly PayoutMatchRow[], net: string | null) => {
                const applied = applyMatch(parcels, getValues('lines'), shownDrafts, rows);
                setValue('lines', applied.lines, { shouldValidate: errors.lines !== undefined });
                setDrafts(applied.drafts);
                setFileNet(net);
                setFileOpen(false);
                toast(
                  t('storefront.payout.csv.applied', {
                    count: applied.ticked,
                    formatted: String(applied.ticked),
                  }),
                );
              }}
            />
          )}
        </Suspense>
      </Dialog>
    </div>
  );
}
```

- **The Parcels card is a container** (`@container`), so the table below switches to cards by the card's width, not
  the screen's (P7). The same form fits a wide page and a phone.
- **"Match a payout file"** shows only when there are parcels: a file can only tick parcels the page lists.
- **The card's body** is one of five states: no account yet, a failed read, still loading (nothing, for a moment),
  nothing to pay out (the empty state with its words), or the table.
- **The lines are one `Controller`**: the table gets the value and calls `onChange` with the next lines and the next
  boxes together, so the two never disagree.
- **The file dialog** mounts only while it is open (`fileOpen &&`), so each opening starts at "Choose CSV file". On
  "Tick N parcels" the form runs `applyMatch` on its current lines and boxes, keeps the file's bank figure for the
  sums (P4), and says in a toast how many it ticked. `shouldValidate` runs only when the lines already had an error,
  so a first match does not show errors before a save.

```tsx
// ---------------------------------------------------------------------------------------------
// The parcels

// One grid template for the caption header and every row on a wide card (@3xl); on a narrow one
// each row is a card of its own with labels (P7), like the line editors
const GRID =
  '@3xl:grid @3xl:grid-cols-[1.25rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_7rem_9.5rem_7rem] @3xl:items-start @3xl:gap-x-4';

function ParcelsTable({
  parcels,
  courier,
  lines,
  drafts,
  onChange,
  errors,
  fileNet,
}: {
  parcels: readonly PayoutParcel[];
  // The courier's name, for "Steadfast said ৳60"
  courier: string;
  lines: readonly PayoutLineValue[];
  drafts: ChargeDrafts;
  onChange: (lines: PayoutLineValue[], drafts: ChargeDrafts) => void;
  errors: FieldErrors<FormValues>;
  // The file's bank figure, after a match (P4)
  fileNet: string | null;
}) {
  const { t, format, errorText } = useLocale();
  const isoDate = useIsoDate();
  const shopMoney = useShopMoney();
  const money = (value: string) => format.money(value, { decimals: 2 });
  const totals = payoutTotals(parcels, lines);
  const difference = fileNet === null ? null : fileDifference(totals.net, fileNet);
  const listError = errors.lines?.root?.message ?? errors.lines?.message;

  const tick = (parcel: PayoutParcel, on: boolean) => {
    const rest = lines.filter((line) => line.shipmentId !== parcel.shipmentId);
    onChange(
      on
        ? orderLines(parcels, [
            ...rest,
            { shipmentId: parcel.shipmentId, charge: drafts[parcel.shipmentId] ?? '' },
          ])
        : rest,
      drafts,
    );
  };
  const charge = (parcel: PayoutParcel, value: string) => {
    onChange(
      lines.map((line) =>
        line.shipmentId === parcel.shipmentId ? { ...line, charge: value } : line,
      ),
      { ...drafts, [parcel.shipmentId]: value },
    );
  };

  return (
    <div className="grid grid-cols-1">
      <div className="flex flex-wrap gap-2 px-5 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={lines.length === parcels.length}
          onClick={() => {
            onChange(
              parcels.map((parcel) => ({
                shipmentId: parcel.shipmentId,
                charge: drafts[parcel.shipmentId] ?? '',
              })),
              drafts,
            );
          }}
        >
          {t('storefront.payout.tickAll')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={lines.length === 0}
          onClick={() => {
            onChange([], drafts);
          }}
        >
          {t('storefront.payout.clear')}
        </Button>
      </div>
      {/* The header only on a wide card: on a narrow one each row says its own labels */}
      <div
        aria-hidden="true"
        className={cn('hidden bg-subtle px-5 py-2.5 text-caption font-medium text-ink-3', GRID)}
      >
        <span />
        <span>{t('storefront.payout.columns.parcel')}</span>
        <span>{t('storefront.payout.columns.status')}</span>
        <span>{t('storefront.payout.columns.receipt')}</span>
        <span className="text-right">{t('storefront.payout.columns.collected')}</span>
        <span className="text-right">{t('storefront.payout.columns.charge')}</span>
        <span className="text-right">{t('storefront.payout.columns.net')}</span>
      </div>
```

- **`GRID`** is one template for the header and every row from `@3xl`: the checkbox, parcel, status, receipt,
  collected, charge and bank columns. Below it there is no grid template, and each row lays itself out as a card.
- **`tick`** adds the parcel with its box's value, or removes it, and puts the lines back in the parcels' order.
- **`charge`** updates the line and the box together.
- **"Tick all" and "Clear"** are disabled when they would change nothing. A disabled button says "already done"
  better than a click that does nothing.
- **The header row** is `aria-hidden`: it only draws the column names. Each row's controls carry their own labels
  (`tick`, `chargeLabel` name the invoice), and on a narrow card the labels show.

```tsx
      <ul className="grid grid-cols-1">
        {parcels.map((parcel) => {
          const index = lines.findIndex((line) => line.shipmentId === parcel.shipmentId);
          const on = index !== -1;
          const line = on ? lines[index] : undefined;
          const error = on
            ? (errors.lines?.[index]?.charge?.message ?? errors.lines?.[index]?.shipmentId?.message)
            : undefined;
          const id = `payout-${parcel.shipmentId}`;
          const value = drafts[parcel.shipmentId] ?? '';
          const net = on && line ? payoutTotals([parcel], [line]).net : null;
          return (
            <li
              key={parcel.shipmentId}
              role="group"
              aria-label={parcel.invoice}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-line px-5 py-3 text-body-sm',
                GRID,
              )}
            >
              <div className="row-span-1 pt-0.5">
                <Checkbox
                  id={id}
                  hideLabel
                  label={t('storefront.payout.tick', { invoice: parcel.invoice })}
                  checked={on}
                  onCheckedChange={(checked) => {
                    tick(parcel, checked === true);
                  }}
                />
              </div>
              <div className="flex min-w-0 items-start justify-between gap-2 @3xl:block">
                <span className="grid min-w-0">
                  <span className="font-mono font-medium tabular-nums text-ink">
                    {parcel.invoice}
                  </span>
                  <span className="text-caption text-ink-3">
                    {t(`storefront.payout.kinds.${parcel.kind}`)}
                  </span>
                  {parcel.trackingCode !== null && (
                    <span className="truncate font-mono text-caption text-ink-3">
                      {parcel.trackingCode}
                    </span>
                  )}
                </span>
                {/* On a phone the pill sits beside the number, as the card's title row */}
                <span className="@3xl:hidden">
                  <ParcelPill status={parcel.status} />
                </span>
              </div>
              <div className="col-start-2 hidden @3xl:col-start-auto @3xl:block">
                <ParcelPill status={parcel.status} />
              </div>
              <Cell label={t('storefront.payout.columns.receipt')}>
                {parcel.receipt === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="grid @3xl:justify-items-start">
                    {/* Every member reads money receipts, so it is always a link */}
                    <Link
                      to="/receipts/$receiptId"
                      params={{ receiptId: parcel.receipt.id }}
                      className="font-mono font-medium text-brand underline-offset-3 hover:underline"
                    >
                      {parcel.receipt.number ?? '—'}
                    </Link>
                    {parcel.receiptDate !== null && (
                      <span className="hidden text-caption text-ink-3 tabular-nums @3xl:block">
                        {isoDate(parcel.receiptDate)}
                      </span>
                    )}
                  </span>
                )}
              </Cell>
              <Cell label={t('storefront.payout.columns.collected')} end>
                <span className={on ? 'tabular-nums' : 'text-ink-3 tabular-nums'}>
                  {money(parcel.collected)}
                </span>
              </Cell>
              <div className="col-start-2 grid gap-1 @3xl:col-start-auto">
                <label
                  htmlFor={`${id}-charge`}
                  className="text-label font-medium text-ink @3xl:sr-only"
                >
                  {t('storefront.payout.columns.charge')}
                </label>
                <MoneyInput
                  id={`${id}-charge`}
                  aria-label={t('storefront.payout.chargeLabel', { invoice: parcel.invoice })}
                  value={value}
                  disabled={!on}
                  invalid={error !== undefined}
                  aria-describedby={error ? `${id}-error` : `${id}-said`}
                  onChange={(next) => {
                    charge(parcel, next);
                  }}
                />
                {error ? (
                  <span id={`${id}-error`} className="flex items-start gap-1 text-label text-crit">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={15}
                      strokeWidth={1.5}
                      className="mt-0.5 shrink-0"
                    />
                    {errorText(error)}
                  </span>
                ) : (
                  <span id={`${id}-said`} className="text-caption text-ink-3 @3xl:text-right">
                    {parcel.courierCharge === null
                      ? t('storefront.payout.courierSilent', { courier })
                      : t('storefront.payout.courierSaid', {
                          courier,
                          amount: shopMoney(parcel.courierCharge),
                        })}
                  </span>
                )}
              </div>
              <Cell label={t('storefront.payout.columns.net')} end>
                {net === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <span className="font-medium tabular-nums">{money(net)}</span>
                )}
              </Cell>
            </li>
          );
        })}
      </ul>
```

- **Each row is a `role="group"` named by the invoice**, so a screen reader says "W-000118, group" before its
  checkbox and its box, like the line editors' "Line 2".
- **The error under a row** is the line's charge error or its shipment error, found by the line's index in `lines`
  (not the parcel's index on the page). That matches the paths the API sends.
- **The status pill shows twice in the markup**, once beside the number (phone) and once in its column (from `@3xl`),
  each hidden at the other width. The phone card's title row then has the number and the status side by side, as in
  the mockup.
- **The receipt is always a `Link`** (mine 45). Its date shows only in the wide layout: on a phone the card is tall
  enough already.
- **The charge box** has a visible label only on a narrow card. On a wide card the column header says it, and the box
  keeps its `aria-label` ("Charge for W-000118"). It is disabled while unticked (P3). Under it is the error, or the
  courier's own figure ("Steadfast said ৳60", in the shop's money style: paisa only when there are some), linked by
  `aria-describedby`.
- **"To the bank"** per row is `payoutTotals` of that one line, so a row and the sums always use the same rule.

```tsx
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-line bg-subtle px-5 py-3.5 text-body-sm tabular-nums">
        <span className="font-medium">
          {t('storefront.payout.ticked', {
            count: lines.length,
            formatted: format.number(lines.length),
          })}
        </span>
        <dl className="ml-auto grid w-full grid-cols-[auto_auto] justify-between gap-x-6 gap-y-1 sm:w-auto">
          <dt className="text-ink-2">{t('storefront.payout.collected')}</dt>
          <dd className="text-right">{money(totals.collected)}</dd>
          <dt className="text-ink-2">{t('storefront.payout.charges')}</dt>
          <dd className="text-right">{money(totals.charges)}</dd>
          <dt className="font-medium">{t('storefront.payout.net')}</dt>
          <dd className="text-right font-medium">{money(totals.net)}</dd>
          {fileNet !== null && (
            // P4: the file's own bank figure, so a wrong charge shows before saving. The pill
            // has its icon and its words: the colour is never the only sign
            <div className="col-span-2 mt-1 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-2 text-label text-ink-2">
              <dt>{t('storefront.payout.fileNet', { amount: money(fileNet) })}</dt>
              <dd>
                {difference === null ? (
                  <Pill tone="good" icon={CheckmarkCircle02Icon}>
                    {t('storefront.payout.fileAgrees')}
                  </Pill>
                ) : (
                  <Pill tone="crit" icon={Alert02Icon}>
                    {t('storefront.payout.fileOutBy', { amount: money(difference) })}
                  </Pill>
                )}
              </dd>
            </div>
          )}
        </dl>
      </div>
      {listError && (
        <p className="flex items-center gap-1.5 border-t border-line px-5 py-3 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {errorText(listError)}
        </p>
      )}
    </div>
  );
}

// A value with its label on a narrow card (left, ink-3) and alone in its column on a wide one
function Cell({
  label,
  end = false,
  children,
}: {
  label: string;
  end?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'col-start-2 flex items-baseline justify-between gap-3 @3xl:col-start-auto @3xl:block',
        end && '@3xl:text-right',
      )}
    >
      <span className="text-ink-3 @3xl:sr-only">{label}</span>
      {children}
    </div>
  );
}
```

- **The sums** are a `<dl>`: each label is paired with its amount for a screen reader. They sit at the right on a wide
  card and take the whole width on a phone.
- **The file's figure** (P4) is a fourth pair, under a rule. The pill has its icon and its words ("Agrees", "Out by
  ৳9.00"), so colour is never the only sign. The contract's sums have 4 decimals; `format.money` with
  `decimals: 2` shows paisa, as a document does.
- **`Cell`** writes a value with its label on a narrow card (label left in `ink-3`, value right) and alone in its
  column on a wide one, where the label becomes `sr-only`. Class names are merged with `cn()`, never with a template
  string, so a later class always wins.

### The file dialog: `components/storefront-payout-file.tsx`

```tsx
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Csv01Icon,
  FileImportIcon,
  FileNotFoundIcon,
  HelpCircleIcon,
  HourglassIcon,
  InformationCircleIcon,
  TaskDone01Icon,
  Upload04Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  MAX_PAYOUT_CSV_CHARS,
  PAYOUT_CSV_KEYS,
  type PayoutCsvKey,
  type PayoutCsvMap,
  type PayoutMatch,
  type PayoutMatchOutcome,
  type PayoutMatchRow,
  type PayoutParcel,
  routes,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, DialogClose, DialogContent, FormAlert, Pill, SelectField } from '@omnivo/ui';
import { useRef, useState } from 'react';

import { ApiRequestError, call } from '../lib/api';
import { outcomeCounts, sortMatchRows, tickableCount } from '../lib/storefront-payouts';
import { DocumentNotice } from './document-notice';

// Step 28c: "Match a payout file" (decisions 10–12, mine 18 and 19, approved with the mockup, P5).
// Its own chunk. The browser reads the CSV and POSTs its text to the match route: no upload, no
// storage, nothing kept but the column map. Three steps in one dialog: choose the file, pick the
// columns (only when the saved map or the Steadfast preset names a column the file lacks, or there
// is no map at all), then the result, one line per row of the file.

// The outcome pills (approved with the mockup). Found is good; what the member must look at is
// warn (another amount, a number we don't know, a row that can't be read); what only says why
// nothing was ticked is neutral
const OUTCOME_PILLS = {
  matched: { tone: 'good', icon: CheckmarkCircle02Icon },
  different: { tone: 'warn', icon: Alert02Icon },
  unknown: { tone: 'warn', icon: HelpCircleIcon },
  invalid: { tone: 'warn', icon: FileNotFoundIcon },
  twice: { tone: 'neutral', icon: Copy01Icon },
  already_paid: { tone: 'neutral', icon: TaskDone01Icon },
  not_ready: { tone: 'neutral', icon: HourglassIcon },
} as const satisfies Record<
  PayoutMatchOutcome,
  { tone: 'good' | 'warn' | 'neutral'; icon: IconSvgElement }
>;

// The mapping step's values: '' = nothing picked yet for the parcel's column, or "Not in the file"
// for an amount column
interface MapValues {
  key: PayoutCsvKey;
  keyColumn: string;
  collectedColumn: string;
  chargeColumn: string;
}

type Step =
  | { kind: 'choose' }
  | {
      kind: 'map';
      csv: string;
      file: string;
      columns: string[];
      missing: string[];
      start: MapValues;
    }
  | { kind: 'result'; csv: string; file: string; match: PayoutMatch };

// The map the API used (saved or preset) as the mapping step's start: a column the file lacks
// starts empty, so the member picks the file's own
function startValues(map: PayoutCsvMap | null, columns: readonly string[]): MapValues {
  const has = (name: string | null | undefined): string =>
    name != null && columns.includes(name) ? name : '';
  return {
    key: map?.key ?? 'invoice',
    keyColumn: has(map?.keyColumn),
    collectedColumn: has(map?.collectedColumn),
    chargeColumn: has(map?.chargeColumn),
  };
}
```

- **`OUTCOME_PILLS`** are the approved tones: found is `good`; what the member must look at is `warn` (another amount,
  a number we do not know, a row that can't be read); what only says why nothing was ticked is neutral. `satisfies`
  keeps one pill per outcome.
- **`Step`** is a discriminated union: each step carries exactly what it needs (the text read from the file, its name,
  the columns, the answer). The render below narrows on `kind`, so no step can read a field another step has.
- **`startValues`** starts the mapping step from the map the API used, but a column the file does not have starts empty.
  The member then picks the file's own column, and nothing points at a column that does not exist.

```tsx
export function PayoutFileDialog({
  accountId,
  accountName,
  parcels,
  onApply,
}: {
  accountId: string;
  accountName: string;
  // The parcels the page lists: what a row may tick, and the receipt's amount for "Other amount"
  parcels: readonly PayoutParcel[];
  onApply: (rows: readonly PayoutMatchRow[], fileNet: string | null) => void;
}) {
  const { t, format } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState<'reading' | 'matching' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const money = (value: string) => format.money(value, { decimals: 2 });

  // One POST for both the first try (map null: the saved map, else the preset) and the mapping
  // step's (the member's map, which the API keeps for the account's next file)
  const match = async (csv: string, file: string, map: PayoutCsvMap | null) => {
    setBusy('matching');
    setFailure(null);
    try {
      const answer = await call(routes.storefrontPayouts.match, {
        params: { id: accountId },
        body: { csv, map },
      });
      if (answer.map === null || answer.missing.length > 0) {
        setStep({
          kind: 'map',
          csv,
          file,
          columns: answer.columns,
          missing: answer.missing,
          start: startValues(answer.map, answer.columns),
        });
      } else {
        setStep({ kind: 'result', csv, file, match: answer });
      }
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error.code : 'unknown_error');
    } finally {
      setBusy(null);
    }
  };

  const choose = async (file: File | undefined) => {
    if (file === undefined) return;
    // Over 1 MB is refused here, before the browser reads it: the API refuses it too, but only
    // after the whole file went up
    if (file.size > MAX_PAYOUT_CSV_CHARS) {
      setFailure('payout_csv_too_big');
      return;
    }
    setBusy('reading');
    setFailure(null);
    // UTF-8, as Steadfast's panel and Excel's "CSV UTF-8" write it. The API drops a byte order
    // mark, so a file Excel saved reads the same
    const csv = await file.text();
    await match(csv, file.name, null);
  };

  const chooseAgain = () => {
    setStep({ kind: 'choose' });
    setFailure(null);
    // The same file picked again must fire onChange, so the input forgets the last one
    if (input.current) input.current.value = '';
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept=".csv,text/csv"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        void choose(event.target.files?.[0]);
      }}
    />
  );

  const title = t('storefront.payout.csv.title');
  const description = t('storefront.payout.csv.description', { name: accountName });
  const cancel = (
    <DialogClose asChild>
      <Button variant="secondary">{t('common.cancel')}</Button>
    </DialogClose>
  );
```

- **`match`** is one POST for both tries (mine 18): first with `map: null` (the saved map, else the preset), then with
  the member's map. An answer with no map, or with missing columns, opens the mapping step; any other answer is the
  result. An API error (an unreadable file, too many rows) stays on the current step as an alert, in the reader's
  language, from its code.
- **The size is checked before reading.** The API refuses a file over 1 MB too, but only after the browser read it and
  sent it all. `file.size` is in bytes, and the limit counts characters, which is the same or more; a file that passes
  here can still be refused there, never the other way round.
- **`file.text()`** reads UTF-8, as Steadfast's panel and Excel's "CSV UTF-8" write it. The API drops a byte order mark
  (28c.3), so a file Excel saved reads the same.
- **`chooseAgain`** clears the input's value. Otherwise picking the same file again would not fire `onChange`, and
  "Choose another file" followed by the same file would do nothing.
- **The input is `sr-only`, out of the tab order and hidden from screen readers**; the visible button opens it with
  `click()`. That keeps the design system's secondary button instead of the browser's own file control.

```tsx
  if (step.kind === 'choose') {
    return (
      <DialogContent
        title={title}
        description={description}
        className="max-w-[560px]"
        footer={cancel}
      >
        {failure !== null && <FormAlert message={failure} />}
        <div className="grid justify-items-center gap-3 rounded-control border border-dashed border-line-strong px-6 py-6 text-center">
          <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand">
            <HugeiconsIcon icon={FileImportIcon} size={18} strokeWidth={1.5} />
          </span>
          {fileInput}
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => {
              input.current?.click();
            }}
          >
            <HugeiconsIcon icon={Upload04Icon} size={17} strokeWidth={1.5} />
            {busy === 'reading'
              ? t('storefront.payout.csv.reading')
              : busy === 'matching'
                ? t('storefront.payout.csv.matching')
                : t('storefront.payout.csv.choose')}
          </Button>
          <p className="max-w-sm text-label text-ink-3">{t('storefront.payout.csv.fileHint')}</p>
        </div>
      </DialogContent>
    );
  }

  if (step.kind === 'map') {
    return (
      <MapStep
        title={title}
        description={description}
        accountName={accountName}
        file={step.file}
        columns={step.columns}
        missing={step.missing}
        start={step.start}
        busy={busy !== null}
        failure={failure}
        onBack={chooseAgain}
        onMatch={(map) => void match(step.csv, step.file, map)}
      />
    );
  }
```

The first step is a dashed box with the button and the two limits (`fileHint`). The button says what is happening:
"Reading the file…", then "Matching…". It is disabled meanwhile, so a second click can't start a second request. The
mapping step is its own component below, because it has its own state.

```tsx
  // The result
  const rows = sortMatchRows(step.match.rows);
  const counts = outcomeCounts(rows);
  const ticks = tickableCount(parcels, rows);
  const collectedOf = new Map(parcels.map((parcel) => [parcel.shipmentId, parcel.collected]));
  const lineOf = (row: PayoutMatchRow): string | null => {
    switch (row.outcome) {
      case 'matched':
        return null;
      case 'different':
        return t('storefront.payout.csv.different', {
          file: money(row.fileCollected ?? '0'),
          ours: money(
            (row.shipmentId === null ? undefined : collectedOf.get(row.shipmentId)) ?? '0',
          ),
        });
      case 'already_paid':
        return t('storefront.payout.csv.alreadyPaid', { payout: row.payout?.number ?? '—' });
      case 'not_ready':
        return t('storefront.payout.csv.notReady');
      case 'unknown':
        return t('storefront.payout.csv.unknown', { name: accountName });
      case 'twice':
        return t('storefront.payout.csv.twice');
      case 'invalid':
        return t('storefront.payout.csv.invalid');
    }
  };
  const map = step.match.map;

  return (
    <DialogContent
      title={title}
      description={description}
      className="max-w-[560px]"
      footer={
        <>
          {ticks > 0 && (
            <p className="mr-auto max-w-56 text-label text-ink-3">
              {t('storefront.payout.csv.applyHint')}
            </p>
          )}
          <Button variant="secondary" onClick={chooseAgain}>
            {t('storefront.payout.csv.otherFile')}
          </Button>
          {ticks > 0 ? (
            <Button
              onClick={() => {
                onApply(step.match.rows, step.match.fileNet);
              }}
            >
              {t('storefront.payout.csv.apply', {
                count: ticks,
                formatted: format.number(ticks),
              })}
            </Button>
          ) : (
            cancel
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-body-sm text-ink-2">
        <HugeiconsIcon icon={Csv01Icon} size={17} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{step.file}</span>
        {map !== null && (
          <button
            type="button"
            className="text-body-sm font-medium text-brand underline-offset-3 hover:underline"
            onClick={() => {
              setStep({
                kind: 'map',
                csv: step.csv,
                file: step.file,
                columns: step.match.columns,
                missing: [],
                start: startValues(map, step.match.columns),
              });
            }}
          >
            {t('storefront.payout.csv.changeColumns')}
          </button>
        )}
      </div>
      {counts.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('storefront.payout.csv.title')}>
          {counts.map(({ outcome, count }) => (
            <li key={outcome}>
              <Pill tone={OUTCOME_PILLS[outcome].tone} icon={OUTCOME_PILLS[outcome].icon}>
                {t('storefront.payout.csv.outcomeCount', {
                  label: t(`storefront.payout.csv.outcomes.${outcome}`),
                  formatted: format.number(count),
                })}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        // The rows scroll inside their box: a 300-parcel payout keeps the buttons in view
        <ol className="grid max-h-80 overflow-y-auto rounded-control border border-line">
          {rows.map((row) => {
            const line = lineOf(row);
            const pill = OUTCOME_PILLS[row.outcome];
            return (
              <li
                key={row.row}
                className="grid gap-1 border-t border-line px-3.5 py-2.5 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm">
                  <span className="text-caption text-ink-3 tabular-nums">
                    {t('storefront.payout.csv.row', { row: format.number(row.row) })}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                    {row.key === '' ? '—' : row.key}
                  </span>
                  <Pill tone={pill.tone} icon={pill.icon}>
                    {t(`storefront.payout.csv.outcomes.${row.outcome}`)}
                  </Pill>
                </div>
                {line !== null && <p className="text-caption text-ink-3">{line}</p>}
              </li>
            );
          })}
        </ol>
      )}
      {ticks === 0 && (
        <p className="flex items-center gap-1.5 text-label text-crit">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.5} className="shrink-0" />
          {t('storefront.payout.csv.noneToTick')}
        </p>
      )}
    </DialogContent>
  );
}

// The mapping step: the file's own columns in three selects and the kind of number that names a
// parcel. Plain state, not a form library: four selects, and the API checks the map again
```

- **The rows are sorted by `sortMatchRows`** (P5) and counted by `outcomeCounts` for the pills above them.
- **`lineOf`** writes the line under a row. The `switch` has no `default`: every outcome has a case, and a new outcome
  in the contract would make the function's return type include `undefined`, which fails the type check.
- **"Other amount"** shows the file's figure and the receipt's, both with paisa (mine 37). The receipt's comes from the
  parcels the page lists, so the dialog needs no extra request.
- **"Change the columns"** shows only when the answer had a map. It reopens the mapping step with that map, so a
  member who picked the wrong column can fix it without choosing the file again.
- **The rows scroll inside their box** (`max-h-80`): a payout of 300 parcels keeps the buttons in view.
- **With nothing to tick**, there is no primary button, only Cancel, and a `crit` line says why (`noneToTick`).
  Otherwise "Tick 4 parcels" names how many it ticks, and the hint says the charges come from the file.

```tsx
function MapStep({
  title,
  description,
  accountName,
  file,
  columns,
  missing,
  start,
  busy,
  failure,
  onBack,
  onMatch,
}: {
  title: string;
  description: string;
  accountName: string;
  file: string;
  columns: readonly string[];
  // The saved map's or the preset's columns this file lacks; [] when there was no map at all
  missing: readonly string[];
  start: MapValues;
  busy: boolean;
  failure: string | null;
  onBack: () => void;
  onMatch: (map: PayoutCsvMap) => void;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState(start);
  const set = (next: Partial<MapValues>) => {
    setValues((current) => ({ ...current, ...next }));
  };
  const columnOptions = columns.map((name) => ({ value: name, label: name }));
  const amountOptions = [
    { value: '', label: t('storefront.payout.csv.columnNone') },
    ...columnOptions,
  ];
  return (
    <DialogContent
      title={title}
      description={description}
      className="max-w-[560px]"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={onBack}>
            {t('storefront.payout.csv.otherFile')}
          </Button>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            disabled={busy || values.keyColumn === ''}
            onClick={() => {
              onMatch({
                key: values.key,
                keyColumn: values.keyColumn,
                collectedColumn: values.collectedColumn === '' ? null : values.collectedColumn,
                chargeColumn: values.chargeColumn === '' ? null : values.chargeColumn,
              });
            }}
          >
            {busy ? t('storefront.payout.csv.matching') : t('storefront.payout.csv.match')}
          </Button>
        </>
      }
    >
      {failure !== null && <FormAlert message={failure} />}
      <div className="flex items-center gap-2 text-body-sm text-ink-2">
        <HugeiconsIcon icon={Csv01Icon} size={17} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 truncate">{file}</span>
      </div>
      <h4 className="text-h3">{t('storefront.payout.csv.mapTitle')}</h4>
      <DocumentNotice tone="neutral" icon={InformationCircleIcon}>
        {missing.length > 0
          ? t('storefront.payout.csv.mapMissing', {
              names: missing.map((name) => `“${name}”`).join(', '),
            })
          : t('storefront.payout.csv.mapFirst', { name: accountName })}
      </DocumentNotice>
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        <SelectField
          label={t('storefront.payout.csv.key')}
          value={values.key}
          onChange={(event) => {
            const key = PAYOUT_CSV_KEYS.find((candidate) => candidate === event.target.value);
            if (key !== undefined) set({ key });
          }}
          options={PAYOUT_CSV_KEYS.map((key) => ({
            value: key,
            label: t(`storefront.payout.csv.keys.${key}`),
          }))}
        />
        <SelectField
          label={t('storefront.payout.csv.keyColumn')}
          value={values.keyColumn}
          onChange={(event) => {
            set({ keyColumn: event.target.value });
          }}
          options={[
            { value: '', label: t('storefront.payout.csv.columnPlaceholder') },
            ...columnOptions,
          ]}
        />
        <SelectField
          label={t('storefront.payout.csv.collectedColumn')}
          hint={t('storefront.payout.csv.collectedHint')}
          value={values.collectedColumn}
          onChange={(event) => {
            set({ collectedColumn: event.target.value });
          }}
          options={amountOptions}
        />
        <SelectField
          label={t('storefront.payout.csv.chargeColumn')}
          hint={t('storefront.payout.csv.chargeHint')}
          value={values.chargeColumn}
          onChange={(event) => {
            set({ chargeColumn: event.target.value });
          }}
          options={amountOptions}
        />
      </div>
    </DialogContent>
  );
}
```

- **Plain state, not a form library.** Four selects, no free text, and the API checks the map again
  (`payoutCsvMapSchema`). A form library would add a resolver and a submit handler for four `onChange`s.
- **"Match the file" is disabled until the parcel's column is picked**: the only required choice.
- **`''` becomes `null`** for the two amount columns, the contract's "Not in the file" (mine 40).
- **The key select** finds the value in `PAYOUT_CSV_KEYS` instead of casting `event.target.value`, so the state can only
  ever hold one of the three keys.
- **The notice** lists the missing names in quotes, joined by commas, or, with no map at all, says the columns are kept
  for the account's next file (decision 11).

### The payout's page: `components/storefront-payout-view.tsx`

```tsx
import { compareMoney, type Payout, routes, subtractMoney } from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { Button, Card, CardHeader, Dialog, PageHeader } from '@omnivo/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { lazy, Suspense, useState } from 'react';

import { call } from '../lib/api';
import { useCan } from '../lib/permissions';
import { accountsQuery, branchesQuery } from '../lib/queries';
import { useTenantId } from '../lib/workspace';
import { Fact } from './adjustment-view';
import { DocumentNotice } from './document-notice';
import { EntryLinks } from './entry-links';
import { PayoutPrint, PrintButton } from './print-documents';
import { useIsoDate } from './stock-parts';
import { PayoutBackLink, PayoutStatusPill } from './storefront-payout-parts';

// Step 28c: a payout's page (approved with the mockup), laid out like a money receipt's: the
// number with the courier account under it, the pill and Print voucher; a voided payout's notice;
// the facts card with its entries; the parcels it paid, each with its receipt and its order; Void
// at the bottom, pushed left. Its own chunk, loaded by routes/storefront-payout.tsx.

const VoidForm = lazy(async () => ({ default: (await import('./money-dialogs')).VoidForm }));

const LINK = 'font-mono font-medium text-brand underline-offset-3 hover:underline';

export function PayoutView({ payout, today }: { payout: Payout; today: string }) {
  const { t, format } = useLocale();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const isoDate = useIsoDate();
  // A line's order is a link only for someone who may open it: an accountant with only
  // storefront.payout.manage would get a refusal
  const canOrders = useCan()('storefront.order.read');
  // Reading the chart and the branches needs no permission (step 10): the facts name the accounts
  // the payout saved by id, archived ones too
  const accounts = useQuery(accountsQuery(tenantId)).data;
  const branches = useQuery(branchesQuery(tenantId, 'active')).data;
  const [voiding, setVoiding] = useState(false);
  const money = (value: string) => format.money(value, { decimals: 2 });
  const posted = payout.status === 'posted';
  const accountLabel = (id: string | null): string => {
    if (id === null) return '—';
    const account = accounts?.find((item) => item.id === id);
    return account ? `${account.code} · ${account.name}` : '—';
  };
  const courier = t(`storefront.couriers.names.${payout.account.courier}`);

  return (
    <div className="grid max-w-6xl grid-cols-1 gap-5">
      <PayoutBackLink />
      <PageHeader
        title={payout.number}
        description={payout.account.name}
        actions={
          <>
            <PayoutStatusPill status={payout.status} />
            {/* A voided payout does not print (a voided document on paper looks real) */}
            {posted && <PrintButton />}
          </>
        }
      />
      {payout.voidDate !== null && (
        <DocumentNotice tone="neutral">
          {t('storefront.payout.voidedNotice', {
            date: isoDate(payout.voidDate),
            reason: payout.voidReason ?? '',
          })}
        </DocumentNotice>
      )}
      <Card className="grid grid-cols-1 gap-x-6 gap-y-4 p-5 sm:grid-cols-3">
        <Fact label={t('storefront.payout.facts.account')} value={payout.account.name} />
        <Fact label={t('storefront.payout.facts.date')} value={isoDate(payout.date)} />
        <Fact label={t('storefront.payout.facts.reference')} value={payout.reference ?? '—'} />
        <Fact
          label={t('storefront.payout.facts.bankAccount')}
          value={accountLabel(payout.bankAccountId)}
        />
        <Fact
          label={t('storefront.payout.facts.codAccount')}
          value={accountLabel(payout.codAccountId)}
        />
        {payout.chargeAccountId !== null && (
          <Fact
            label={t('storefront.payout.facts.chargeAccount')}
            value={accountLabel(payout.chargeAccountId)}
          />
        )}
        <Fact
          label={t('storefront.payout.facts.branch')}
          value={branches?.find((branch) => branch.id === payout.branchId)?.name ?? '—'}
        />
        <EntryLinks label={t('storefront.payout.entry')} entries={[payout.entry]} none="" />
        {payout.voidEntry !== null && (
          <EntryLinks
            label={t('storefront.payout.voidEntry')}
            entries={[payout.voidEntry]}
            none=""
          />
        )}
        {payout.note !== null && (
          <div className="sm:col-span-3">
            <Fact label={t('storefront.payout.facts.note')} value={payout.note} />
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={t('storefront.payout.linesTitle')}
          subtitle={t('storefront.payout.linesDescription')}
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-body-sm">
            <caption className="sr-only">{t('storefront.payout.linesTitle')}</caption>
            <thead>
              <tr className="bg-subtle text-left text-caption font-medium text-ink-3">
                <th scope="col" className="px-5 py-2.5">
                  {t('storefront.payout.columns.parcel')}
                </th>
                <th scope="col" className="px-3 py-2.5">
                  {t('storefront.payout.columns.receipt')}
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  {t('storefront.payout.columns.collected')}
                </th>
                <th scope="col" className="px-3 py-2.5 text-right">
                  {t('storefront.payout.columns.charge')}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right">
                  {t('storefront.payout.columns.net')}
                </th>
              </tr>
            </thead>
            <tbody>
              {payout.lines.map((line) => (
                <tr key={line.shipmentId} className="border-t border-line align-top">
                  <td className="px-5 py-3">
                    {canOrders ? (
                      <Link
                        to="/storefront/orders/$orderId"
                        params={{ orderId: line.order.id }}
                        className={LINK}
                      >
                        {line.invoice}
                      </Link>
                    ) : (
                      <span className="font-mono font-medium">{line.invoice}</span>
                    )}
                    <span className="block text-caption text-ink-3">
                      {t(`storefront.payout.kinds.${line.kind}`)}
                    </span>
                    {line.trackingCode !== null && (
                      <span className="block font-mono text-caption text-ink-3">
                        {line.trackingCode}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {line.receipt === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <Link
                        to="/receipts/$receiptId"
                        params={{ receiptId: line.receipt.id }}
                        className={LINK}
                      >
                        {line.receipt.number ?? '—'}
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(line.collected)}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                    {money(line.charge)}
                    {/* A charge the member changed (a file's, or the difference the courier
                        kept) shows the courier's own figure under it */}
                    {line.courierCharge !== null &&
                      compareMoney(line.courierCharge, line.charge) !== 0 && (
                        <span className="block text-caption text-ink-3">
                          {t('storefront.payout.courierSaid', {
                            courier,
                            amount: money(line.courierCharge),
                          })}
                        </span>
                      )}
                  </td>
                  <td className="px-5 py-3 text-right font-medium whitespace-nowrap tabular-nums">
                    {money(subtractMoney(line.collected, line.charge))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-subtle font-medium tabular-nums">
                <th scope="row" className="px-5 py-3 text-left">
                  {t('storefront.payout.total')}
                </th>
                <td />
                <td className="px-3 py-3 text-right whitespace-nowrap">
                  {money(payout.collected)}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap">{money(payout.charges)}</td>
                <td className="px-5 py-3 text-right whitespace-nowrap">{money(payout.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {posted && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Away from everything else: voiding can't be undone */}
          <Button
            variant="secondary"
            onClick={() => {
              setVoiding(true);
            }}
          >
            {t('storefront.payout.void')}
          </Button>
        </div>
      )}

      <Dialog open={voiding} onOpenChange={setVoiding}>
        <Suspense fallback={null}>
          {voiding && (
            <VoidForm
              words="storefront.payout"
              number={payout.number}
              version={payout.version}
              today={today}
              save={async (body) => {
                await call(routes.storefrontPayouts.void, { params: { id: payout.id }, body });
                // The parcels are free again: the couriers' Holds, the order pages and the list
                await Promise.all([
                  queryClient.invalidateQueries({ queryKey: ['storefront', tenantId] }),
                  queryClient.invalidateQueries({ queryKey: ['journal', tenantId] }),
                ]);
              }}
              onDone={() => {
                setVoiding(false);
              }}
            />
          )}
        </Suspense>
      </Dialog>
      {posted && <PayoutPrint payout={payout} bankAccount={accountLabel(payout.bankAccountId)} />}
    </div>
  );
}
```

- **Laid out like a money receipt's page:** the number with the courier account under it, the pill and Print voucher
  in the header, then the voided notice, the facts card and the lines.
- **The accounts are named from the chart** (`accountsQuery`), which every member may read (step 10). The payout keeps
  only ids, and the account it used may be archived since; the chart still has it.
- **"Charges to"** shows only when the payout has a charges account: a payout with no charges has none.
- **The lines.** The order is a link only with `storefront.order.read` (mine 45); the receipt always. A charge that
  differs from the courier's own figure shows that figure under it, so the voucher's reader sees where the member
  changed it. The comparison is `compareMoney` on the strings, never `Number()`: money is never a JavaScript number.
- **The total row** is a `<tfoot>` with a `<th scope="row">` (mine 47), so a screen reader reads "Total" with each
  amount.
- **Void is alone at the bottom, on the left**, away from Print, because it can't be undone. Its dialog is the
  receipt's `VoidForm` (mine 46). After it, the whole Storefront menu and the journal are read again: the parcels are
  free, the Holds go up, and a reversal entry exists.
- **A voided payout does not print**, so there is no Print button and no sheet for it.

### The voucher: `components/print-documents.tsx`

```diff
@@ -10,6 +10,7 @@ import {
   defaultLineDescription,
   type Invoice,
   isZeroMoney,
+  type Payout,
   plainQuantity,
   type PurchaseOrder,
   type PurchaseReturn,
@@ -1099,3 +1100,66 @@ export function SupplierRefundPrint({
     </Sheet>
   );
 }
+
+// Step 28c: a courier payout's voucher (approved with the mockup), signed by whoever recorded it and
+// whoever authorised it, like a supplier payment's. The courier, its reference and the bank account
+// at the top, because the bank statement is matched by them; then each parcel with its tracking
+// code (what the courier's panel shows), what it brought and what the courier kept, and the bank
+// figure in words
+export function PayoutPrint({ payout, bankAccount }: { payout: Payout; bankAccount: string }) {
+  const { t, format } = useLocale();
+  const isoDate = useIsoDate();
+  const money = (value: string) => format.money(value, { decimals: 2 });
+  return (
+    <Sheet
+      title={t('print.titles.storefrontPayout')}
+      meta={[
+        { label: t('print.number'), value: payout.number },
+        { label: t('print.date'), value: isoDate(payout.date) },
+        { label: t('print.courier'), value: payout.account.name },
+        payout.reference === null ? null : { label: t('print.reference'), value: payout.reference },
+        { label: t('print.paidInto'), value: bankAccount },
+      ]}
+      signatures={[t('print.signatures.preparedBy'), t('print.signatures.authorised')]}
+    >
+      <table className="w-full border-collapse text-caption">
+        <thead>
+          <tr>
+            <th scope="col" className={HEAD}>
+              {t('print.payoutColumns.parcel')}
+            </th>
+            <th scope="col" className={HEAD}>
+              {t('print.payoutColumns.trackingCode')}
+            </th>
+            <th scope="col" className={cn(HEAD, 'text-right')}>
+              {t('print.payoutColumns.collected')}
+            </th>
+            <th scope="col" className={cn(HEAD, 'text-right')}>
+              {t('print.payoutColumns.charge')}
+            </th>
+          </tr>
+        </thead>
+        <tbody>
+          {payout.lines.map((line) => (
+            <tr key={line.shipmentId} className="break-inside-avoid">
+              <td className={cn(CELL, 'font-mono tabular-nums')}>{line.invoice}</td>
+              <td className={cn(CELL, 'font-mono tabular-nums')}>{line.trackingCode ?? '—'}</td>
+              <td className={cn(CELL, 'text-right tabular-nums')}>{money(line.collected)}</td>
+              <td className={cn(CELL, 'text-right tabular-nums')}>{money(line.charge)}</td>
+            </tr>
+          ))}
+        </tbody>
+      </table>
+      <dl className="ml-auto grid w-72 break-inside-avoid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
+        <dt>{t('print.collected')}</dt>
+        <dd className="text-right">{money(payout.collected)}</dd>
+        <dt>{t('print.charges')}</dt>
+        <dd className="text-right">{money(payout.charges)}</dd>
+        <dt className="border-t border-ink pt-1 font-semibold">{t('print.netToBank')}</dt>
+        <dd className="border-t border-ink pt-1 text-right font-semibold">{money(payout.net)}</dd>
+      </dl>
+      <InWords amount={payout.net} />
+      <Note note={payout.note} />
+    </Sheet>
+  );
+}
```

The supplier payment's voucher is the model: the same `Sheet`, the same table styles, "Prepared by" and "Authorised
signature". The facts at the top are the ones a bank statement is matched by: the courier, its reference and the bank
account. A reference the member left empty is `null` in `meta`, and the sheet filters it out. The bank account comes
in as a ready label (`1120 · Dutch-Bangla Bank current`), because the chart is read by the page, not by the print
code. The sums are a small `<dl>` at the right, the last one in bold under a rule, then the amount in words.

### Void: `components/money-dialogs.tsx`

```diff
@@ -155,7 +155,8 @@ export function ApplyForm({
 }
 
 // "Void": the date the money turned out not to be there (or never reached the customer), and why.
-// `words` picks the document's own texts; both have the same keys, but for the dialog's No button.
+// `words` picks the document's own texts; they have the same keys, but for the dialog's No button.
+// Step 28c: and a courier payout's, whose No button is a plain Cancel
 export function VoidForm({
   words,
   number,
@@ -164,7 +165,7 @@ export function VoidForm({
   save,
   onDone,
 }: {
-  words: 'receipts' | 'refunds';
+  words: 'receipts' | 'refunds' | 'storefront.payout';
   number: string;
   version: number;
   today: string;
@@ -203,7 +204,11 @@ export function VoidForm({
         <>
           <DialogClose asChild>
             <Button variant="secondary">
-              {words === 'receipts' ? t('receipts.keepReceipt') : t('refunds.keepRefund')}
+              {words === 'receipts'
+                ? t('receipts.keepReceipt')
+                : words === 'refunds'
+                  ? t('refunds.keepRefund')
+                  : t('common.cancel')}
             </Button>
           </DialogClose>
           <Button type="submit" form="void-form" disabled={isSubmitting}>
```

`words` gains `'storefront.payout'`. The texts are looked up as `` `${words}.voidTitle` ``, and the payout group has
the same keys (28c.5), so the type check proves each one exists. Only the No button differs: a payout has no
"Keep payout" word, and "Cancel" says the same.

### Shop couriers: "Record payout"

```diff
@@ -2,6 +2,7 @@ import {
   Alert02Icon,
   Archive02Icon,
   ArchiveRestoreIcon,
+  BankIcon,
   CheckmarkBadge01Icon,
   CheckmarkCircle02Icon,
   Copy01Icon,
@@ -49,6 +50,7 @@ import {
   toast,
 } from '@omnivo/ui';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
+import { useNavigate } from '@tanstack/react-router';
 import { lazy, Suspense, useId, useMemo, useState } from 'react';
 
 import { DocumentNotice } from '../components/document-notice';
@@ -58,6 +60,7 @@ import {
   ViewShopLink,
 } from '../components/storefront-parts';
 import { ApiRequestError, call } from '../lib/api';
+import { useCan } from '../lib/permissions';
 import { storefrontCouriersQuery, storefrontSetupQuery } from '../lib/storefront';
 import { useOnline } from '../lib/use-online';
 import { useTenantId, useTimeZone } from '../lib/workspace';
@@ -336,6 +339,8 @@ export function StorefrontCouriersPage() {
   const timeZone = useTimeZone();
   const online = useOnline();
   const refresh = useStorefrontRefresh();
+  const navigate = useNavigate();
+  const canPayout = useCan()('storefront.payout.manage');
   const [view, setView] = useState<CourierAccountStatus>('active');
   const [acting, setActing] = useState<Acting>(null);
   const close = () => {
@@ -637,6 +642,22 @@ export function StorefrontCouriersPage() {
                           {t('storefront.couriers.renewToken')}
                         </DropdownMenuItem>
                       )}
+                      {/* Step 28c (P6): a new payout of this account, with its money. Only for
+                          the people who record payouts, and only when the account has a COD
+                          account: without one it holds no money to pay out */}
+                      {canPayout && account.codAccountId !== null && (
+                        <DropdownMenuItem
+                          icon={BankIcon}
+                          onSelect={() => {
+                            void navigate({
+                              to: '/storefront/payouts/new',
+                              search: { account: account.id },
+                            });
+                          }}
+                        >
+                          {t('storefront.couriers.recordPayout')}
+                        </DropdownMenuItem>
+                      )}
                       <DropdownMenuItem
                         icon={Archive02Icon}
                         onSelect={() => {
@@ -654,7 +675,7 @@ export function StorefrontCouriersPage() {
         },
       }),
     ]);
-  }, [t, format, timeZone, defaultId, testAccount, restoreAccount]);
+  }, [t, format, timeZone, defaultId, testAccount, restoreAccount, canPayout, navigate]);
 
   const rows = setup?.accounts.filter((account) => account.status === view);
   const openNew = () => {
```

The item shows only with `storefront.payout.manage` and only for an account with a COD account (P6): without one there
is no money to pay out, and the new payout would disable that account anyway. It opens the new payout with
`?account=`. `canPayout` and `navigate` are in the columns' `useMemo` list, because the menu reads them.

### The parcel pill moves, and the parcel card says "Paid out on"

```diff
@@ -2,10 +2,14 @@ import {
   Alert02Icon,
   CancelCircleIcon,
   Clock01Icon,
+  DeliveryBox01Icon,
+  DeliveryDelay01Icon,
   DeliveryReturn01Icon,
+  DeliveryTracking01Icon,
   DeliveryTruck01Icon,
   PackageDeliveredIcon,
   PackageIcon,
+  PackageMovingIcon,
   PackageReceiveIcon,
   PackageRemoveIcon,
 } from '@hugeicons/core-free-icons';
@@ -78,3 +82,38 @@ export function ParcelWaitPill({
     </Pill>
   );
 }
+
+// Step 28a.6: the pill of each of the twelve parcel statuses (approved with the mockup). Moved
+// here from storefront-order-parcels.tsx in step 28c: the new payout lists parcels too, and that
+// file (the parcel cards, Book courier, the label) would ride in its chunk. Work on its way is brand, as
+// the order's own pills (CLAUDE.md → Sales document statuses); delivered is good; a failed booking
+// is crit, because nothing moves until someone books it again; warn for what the shop must act on
+// (the courier holds it, it comes back, part of it came back); over and done is neutral. The
+// courier's news on the card use the same icons, so a step reads the same in both places
+export const PARCEL_PILLS = {
+  booking: { tone: 'brand', icon: Clock01Icon },
+  booking_failed: { tone: 'crit', icon: Alert02Icon },
+  booked: { tone: 'brand', icon: DeliveryBox01Icon },
+  picked_up: { tone: 'brand', icon: PackageMovingIcon },
+  in_transit: { tone: 'brand', icon: DeliveryTruck01Icon },
+  out_for_delivery: { tone: 'brand', icon: DeliveryTracking01Icon },
+  delivered: { tone: 'good', icon: PackageDeliveredIcon },
+  partly_delivered: { tone: 'warn', icon: PackageRemoveIcon },
+  on_hold: { tone: 'warn', icon: DeliveryDelay01Icon },
+  returning: { tone: 'warn', icon: DeliveryReturn01Icon },
+  returned: { tone: 'neutral', icon: PackageReceiveIcon },
+  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
+} as const satisfies Record<
+  ShipmentStatus,
+  { tone: 'brand' | 'good' | 'warn' | 'crit' | 'neutral'; icon: IconSvgElement }
+>;
+
+export function ParcelPill({ status }: { status: ShipmentStatus }) {
+  const { t } = useLocale();
+  const pill = PARCEL_PILLS[status];
+  return (
+    <Pill tone={pill.tone} icon={pill.icon}>
+      {t(`storefront.order.parcels.statuses.${status}`)}
+    </Pill>
+  );
+}
```

```diff
@@ -1,21 +1,11 @@
 import {
   Alert02Icon,
-  CancelCircleIcon,
-  Clock01Icon,
-  DeliveryBox01Icon,
-  DeliveryDelay01Icon,
-  DeliveryReturn01Icon,
   DeliveryTracking01Icon,
-  DeliveryTruck01Icon,
   Loading03Icon,
-  PackageDeliveredIcon,
-  PackageMovingIcon,
-  PackageReceiveIcon,
-  PackageRemoveIcon,
   PrinterIcon,
   ShippingTruck01Icon,
 } from '@hugeicons/core-free-icons';
-import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
+import { HugeiconsIcon } from '@hugeicons/react';
 import { zodResolver } from '@hookform/resolvers/zod';
 import {
   bookShipmentInputSchema,
@@ -23,7 +13,6 @@ import {
   contractErrorMap,
   isZeroMoney,
   routes,
-  type ShipmentStatus,
   type StorefrontOrder,
   type StorefrontShipment,
 } from '@omnivo/contracts';
@@ -35,7 +24,6 @@ import {
   DialogClose,
   DialogContent,
   FormAlert,
-  Pill,
   SelectField,
   TextField,
 } from '@omnivo/ui';
@@ -47,48 +35,17 @@ import { useForm, useWatch } from 'react-hook-form';
 
 import { call } from '../lib/api';
 import { applyApiError } from '../lib/field-errors';
+import { useCan } from '../lib/permissions';
 import { settingsQuery } from '../lib/queries';
 import { parcelsNewestFirst, storefrontCourierChoicesQuery } from '../lib/storefront-orders';
 import { useTenantId, useTimeZone } from '../lib/workspace';
+import { PARCEL_PILLS, ParcelPill } from './storefront-order-pills';
 import { useShopMoney } from './storefront-parts';
 
 // Step 28a.6: a shop order's parcels on its page (approved with the mockup), the Book courier
 // dialog and the parcel's label. A file of its own, loaded with the order page: the list never
 // shows a parcel, and the Packed dialog only needs the choices query.
 
-// The pill of each of the twelve statuses (approved with the mockup). Work on its way is brand, as
-// the order's own pills (CLAUDE.md → Sales document statuses); delivered is good; a failed booking
-// is crit, because nothing moves until someone books it again; warn for what the shop must act on
-// (the courier holds it, it comes back, part of it came back); over and done is neutral. The
-// courier's news on the card use the same icons, so a step reads the same in both places
-export const PARCEL_PILLS = {
-  booking: { tone: 'brand', icon: Clock01Icon },
-  booking_failed: { tone: 'crit', icon: Alert02Icon },
-  booked: { tone: 'brand', icon: DeliveryBox01Icon },
-  picked_up: { tone: 'brand', icon: PackageMovingIcon },
-  in_transit: { tone: 'brand', icon: DeliveryTruck01Icon },
-  out_for_delivery: { tone: 'brand', icon: DeliveryTracking01Icon },
-  delivered: { tone: 'good', icon: PackageDeliveredIcon },
-  partly_delivered: { tone: 'warn', icon: PackageRemoveIcon },
-  on_hold: { tone: 'warn', icon: DeliveryDelay01Icon },
-  returning: { tone: 'warn', icon: DeliveryReturn01Icon },
-  returned: { tone: 'neutral', icon: PackageReceiveIcon },
-  cancelled: { tone: 'neutral', icon: CancelCircleIcon },
-} as const satisfies Record<
-  ShipmentStatus,
-  { tone: 'brand' | 'good' | 'warn' | 'crit' | 'neutral'; icon: IconSvgElement }
->;
-
-export function ParcelPill({ status }: { status: ShipmentStatus }) {
-  const { t } = useLocale();
-  const pill = PARCEL_PILLS[status];
-  return (
-    <Pill tone={pill.tone} icon={pill.icon}>
-      {t(`storefront.order.parcels.statuses.${status}`)}
-    </Pill>
-  );
-}
-
 // What the rider collects, as the shop writes money (paisa only when there is some), or that the
 // order is paid. A label always shows paisa: its own formatting is in ParcelLabel
 function useCollect(): (amount: string) => string {
@@ -129,6 +86,7 @@ function ParcelCard({
   const timeZone = useTimeZone();
   const collect = useCollect();
   const money = useShopMoney();
+  const canPayout = useCan()('storefront.payout.manage');
   const when = (iso: string) => format.dateTime(new Date(iso), timeZone);
   const byApi = parcel.account.provider !== 'manual';
   const courier = t(`storefront.couriers.names.${parcel.courier}`);
@@ -180,6 +138,24 @@ function ParcelCard({
       ),
     });
   }
+  // Step 28c (decision 14): the posted payout that took the parcel's money to the bank. A link only
+  // for the people who record payouts: a packer opening it would get a refusal
+  if (parcel.payout !== null) {
+    facts.push({
+      label: t('storefront.order.parcels.payout'),
+      value: canPayout ? (
+        <Link
+          to="/storefront/payouts/$payoutId"
+          params={{ payoutId: parcel.payout.id }}
+          className="font-mono text-[13px] font-medium text-brand underline-offset-3 hover:underline"
+        >
+          {parcel.payout.number ?? '—'}
+        </Link>
+      ) : (
+        <span className="font-mono text-[13px] font-medium">{parcel.payout.number ?? '—'}</span>
+      ),
+    });
+  }
   if (parcel.bookedAt !== null) {
     facts.push({ label: t('storefront.order.parcels.bookedAt'), value: when(parcel.bookedAt) });
     if (byApi) {
```

`PARCEL_PILLS` and `ParcelPill` move unchanged to the pills module (mine 42), and the parcel card imports them from
there. The icons and types only the pills used leave the card's imports.

The new fact comes after "Money receipt": the receipt brought the money in, the payout took it out. It shows only while
a posted payout holds the parcel; a void clears `payout_id` (decision 6), so the fact goes with it. It is a link only
for someone who may open payouts (mine 45).

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/ui typecheck && pnpm --filter @omnivo/ui test        # 22 tests
pnpm --filter @omnivo/i18n typecheck && pnpm --filter @omnivo/i18n test    # 21 tests
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                                             # 261 tests
pnpm exec eslint apps/app/src packages/ui/src packages/i18n/src
pnpm exec prettier --check apps/app/src packages/ui/src packages/i18n/src
```

What ran on commit 2475fde:

- **ui, i18n and the app's unit tests** pass: 22, 21 and 261 (14 of them new in `storefront-payouts.spec.ts`). eslint and
  prettier pass on every changed file.
- **The app type check** still fails with the one error 28c.1 expected (`mocks/storefront-shipping-data.ts`: the
  parcel has no `payout`). The mock API is 28c.7's; nothing else fails.
- **Not seen in a browser yet.** The pages call routes the mock API does not have until 28c.7, which adds them and
  the Playwright tests and compares the pages with the mockup.
- **Broken on purpose,** one at a time, each caught:
  1. `tickable` without its `listed.has(…)` check: the spec "never ticks a parcel the page does not list" fails;
  2. `not_ready` taken out of `OUTCOME_RANK`: the type check fails at the `satisfies`.


## 28c.7 — The mock API and the browser tests

The screens of 28c.6 call seven routes the mock API (MSW, `pnpm dev:mock` and the Playwright tests) did not have. This
part adds them, with the API's rules, then tests the pages in a real browser at both sizes.

These decisions came up here (mine):

48. **A fixture switch of its own, `shopPayouts`.** Shop payouts needs delivered Cash on Delivery parcels with COD
    receipts, and one payout already made. Seeding them with the shop orders would change what Steadfast Dhaka holds,
    which the 28b tests read ("Nothing yet"). So they come only when a test asks (`test.use({ shopOrders: true,
    shopPayouts: true })`), like 27b's `shopOrders`. `pnpm dev:mock` has no key, so a person trying the mock sees
    them.
49. **The mock reads the CSV with a small reader of its own.** The API uses `csv-parse`; the app does not bundle a
    CSV parser, and adding one for the mock alone is not worth it. The reader handles what a courier's export has:
    quoted cells (a `"1,000"` amount), `""` inside quotes, CRLF or LF, a byte order mark. The rules after the reading
    (column names without case, amounts, the seven outcomes, the file's bank figure) are the API's, line by line.
50. **"Print voucher", as the mockup shows.** 28c.6 used the shared `PrintButton`, which always says "Print", so the
    word `storefront.payout.print` was never shown. The browser test found it. `PrintButton` now takes an optional
    `label`; every other page still says Print.
51. **The number is taken only after the entry is posted.** The mock's `transaction()` puts back the journal and the
    documents of a refused save, but not the shop's own rows. So the payout's counter moves, and the parcels get their
    `payoutId`, only after `postNew` has passed (a closed period refuses there). Nothing is left half written.
52. **The mock journal refuses to reverse a payout's entry** (`journal_is_payout`), as the API does. Voiding the
    payout reverses it with `allowPayout`, the same way a voided receipt passes `allowSales`.

### The mock's payouts: `mocks/storefront-payout-data.ts`

```ts
import {
  compareMoney,
  type CourierProvider,
  type DocumentRef,
  type EntryRef,
  type ErrorCode,
  isNegativeMoney,
  isZeroMoney,
  MAX_PAYOUT_CSV_ROWS,
  type Payout,
  type PayoutAccount,
  type PayoutCsvKey,
  type PayoutCsvMap,
  payoutCsvMapSchema,
  type PayoutInput,
  type PayoutLineKind,
  type PayoutMatch,
  type PayoutMatchInput,
  type PayoutMatchRow,
  type PayoutParcel,
  type PayoutParcels,
  type PayoutSetup,
  type PayoutStatus,
  type PayoutSummary,
  type ShipmentStatus,
  STEADFAST_PAYOUT_CSV_PRESET,
  type StorefrontAccountChoice,
  subtractMoney,
  sumMoney,
  type VoidPayoutInput,
} from '@omnivo/contracts';

import { refOf, side } from './invoice-data';
import { findEntry, postNew, reverseEntry } from './journal-data';
import { MockProblem } from './mock';
import { seriesNumber } from './sales-document-data';
import { branchOf } from './stock-data';
import { chartOf } from './storefront-payment-data';
import type { MockCourierAccount, MockShipment, MockShopOrder } from './storefront-seed';
import type { WorkspaceData } from './workspace-data';

// Step 28c: Storefront → Shop payouts, with the API's rules (apps/api/src/storefront/payouts/:
// payouts.service.ts, and payout-match.ts for the file). A payout is posted when it is saved and
// voided on its own page, like a money receipt. The mock has no database, so 0083's guards are the
// checks below, done before anything is written: the API's lock and its deferred check have no
// race to stop in one browser tab.
//
// This file imports no other storefront mock file but the seed's types and the payment card's
// chartOf: storefront-shipping-data.ts (Holds, the parcel card's "Paid out on") and
// storefront-order-data.ts (the seed) import it.

// A payout as storefront_payouts keeps it, with its lines (storefront_payout_lines). The entry is
// kept by id and looked up on read, so its number and its reversal are always the journal's
export interface MockPayoutLine {
  shipmentId: string;
  kind: PayoutLineKind;
  collected: string;
  charge: string;
  // The courier's own figure when the payout was saved (mine 22)
  courierCharge: string | null;
  receiptId: string | null;
}

export interface MockPayout {
  id: string;
  number: string;
  date: string;
  accountId: string;
  bankAccountId: string;
  // The accounts it posted to, as they were then
  codAccountId: string;
  chargeAccountId: string | null;
  branchId: string;
  reference: string | null;
  note: string | null;
  collected: string;
  charges: string;
  net: string;
  status: PayoutStatus;
  lines: MockPayoutLine[];
  entryId: string;
  voidDate: string | null;
  voidReason: string | null;
  version: number;
  updatedAt: string;
}

export interface MockPayouts {
  // Newest saved first, like the other mock documents
  items: MockPayout[];
  // The last number given (CPO-…), like the other mock documents' counters
  counter: number;
}

export function emptyPayouts(): MockPayouts {
  return { items: [], counter: 0 };
}

function now(): string {
  return new Date().toISOString();
}

function notFound(): MockProblem {
  return new MockProblem(404, 'not_found');
}

// An error under one box, or under several lines' boxes (the API's boxError)
function boxError(code: ErrorCode, fields: readonly string[]): MockProblem {
  return new MockProblem(422, code, Object.fromEntries(fields.map((field) => [field, [code]])));
}

function unavailable(indexes: readonly number[]): MockProblem {
  return new MockProblem(
    409,
    'payout_parcel_unavailable',
    Object.fromEntries(
      indexes.map((index) => [`lines.${String(index)}.shipmentId`, ['payout_parcel_unavailable']]),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// What a parcel is to a payout

// A parcel with its order, as the reads walk them
interface Sent {
  order: MockShopOrder;
  parcel: MockShipment;
}

function sentOf(data: WorkspaceData, accountId: string): Sent[] {
  return data.storefront.orders.flatMap((order) =>
    order.shipments
      .filter((parcel) => parcel.accountId === accountId)
      .map((parcel) => ({ order, parcel })),
  );
}

function receiptOf(data: WorkspaceData, id: string | null) {
  return id === null ? undefined : data.billing.receipts.find((receipt) => receipt.id === id);
}

const JOURNEY_OVER: readonly ShipmentStatus[] = [
  'delivered',
  'partly_delivered',
  'returned',
  'cancelled',
];

// The API's payoutKindOf (payout-match.ts), with the receipt looked up here: a cod line's receipt
// is posted and went into the account's COD account now; a charge line has no receipt, nothing
// collected, its journey over and a charge the courier said. Whether a posted payout took it is
// the caller's question
function kindOf(
  data: WorkspaceData,
  parcel: MockShipment,
  codAccountId: string | null,
): PayoutLineKind | null {
  if (parcel.receiptId !== null) {
    const receipt = receiptOf(data, parcel.receiptId);
    return receipt?.status === 'posted' &&
      codAccountId !== null &&
      receipt.accountId === codAccountId
      ? 'cod'
      : null;
  }
  const charged = parcel.courierCharge !== null && compareMoney(parcel.courierCharge, '0') > 0;
  const noCash = parcel.collectedAmount === null || isZeroMoney(parcel.collectedAmount);
  return charged && noCash && JOURNEY_OVER.includes(parcel.status) ? 'charge' : null;
}

// The courier's holds (decision 12, 28b's holdsOf): posted COD receipts no payout took. Shop
// couriers' Holds column and the payout form's account select read the same figure
export function payoutHoldsOf(data: WorkspaceData, accountId: string): PayoutAccount['holds'] {
  const held = sentOf(data, accountId).filter(
    ({ parcel }) =>
      parcel.payoutId === null && receiptOf(data, parcel.receiptId)?.status === 'posted',
  );
  return {
    amount: sumMoney(held.map(({ parcel }) => parcel.collectedAmount ?? '0')),
    parcels: held.length,
  };
}

// The parcel card's "Paid out on CPO-…" (the API's left join on payout_id)
export function payoutRefOf(data: WorkspaceData, payoutId: string | null): DocumentRef | null {
  if (payoutId === null) return null;
  const payout = data.storefront.payouts.items.find((item) => item.id === payoutId);
  return payout === undefined ? null : { id: payout.id, number: payout.number };
}

// 0083's receipts_paid_out (mine 26): a COD receipt whose money a posted payout took is voided only
// after the payout is
export function assertReceiptNotPaidOut(data: WorkspaceData, receiptId: string): void {
  const paidOut = data.storefront.orders.some((order) =>
    order.shipments.some((parcel) => parcel.receiptId === receiptId && parcel.payoutId !== null),
  );
  if (paidOut) throw new MockProblem(409, 'receipt_paid_out');
}

// ---------------------------------------------------------------------------------------------
// Reads

function findAccount(data: WorkspaceData, id: string): MockCourierAccount | undefined {
  return data.storefront.couriers.find((account) => account.id === id);
}

// The two ledger accounts by code and name, an archived one too (the page must still name it)
function choiceOf(data: WorkspaceData, id: string | null): StorefrontAccountChoice | null {
  const account = id === null ? undefined : data.accounts.find((item) => item.id === id);
  return account === undefined ? null : { id: account.id, code: account.code, name: account.name };
}

function toAccount(data: WorkspaceData, account: MockCourierAccount): PayoutAccount {
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    courier: account.courier,
    archived: account.archivedAt !== null,
    codAccount: choiceOf(data, account.codAccountId),
    chargeAccount: choiceOf(data, account.chargeAccountId),
    holds: payoutHoldsOf(data, account.id),
  };
}

// Every courier account, archived ones last, then by name; and the accounts that hold money
export function payoutSetupOf(data: WorkspaceData): PayoutSetup {
  const accounts = data.storefront.couriers.toSorted(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return {
    accounts: accounts.map((account) => toAccount(data, account)),
    bankAccounts: chartOf(data).moneyAccounts,
  };
}

function toParcel(data: WorkspaceData, sent: Sent, kind: PayoutLineKind): PayoutParcel {
  const { order, parcel } = sent;
  const receipt = kind === 'cod' ? receiptOf(data, parcel.receiptId) : undefined;
  return {
    shipmentId: parcel.id,
    kind,
    order: { id: order.id, number: order.orderNo },
    invoice: parcel.invoice,
    trackingCode: parcel.trackingCode,
    consignmentId: parcel.consignmentId,
    status: parcel.status,
    collected: receipt?.amount ?? '0.0000',
    courierCharge: parcel.courierCharge,
    receipt: receipt === undefined ? null : { id: receipt.id, number: receipt.number },
    receiptDate: receipt?.date ?? null,
    lastSyncedAt: parcel.lastSyncedAt,
  };
}

// A saved map read with today's schema: one of an older shape reads as none
function savedMapOf(account: MockCourierAccount): PayoutCsvMap | null {
  const parsed = payoutCsvMapSchema.safeParse(account.payoutCsvMap);
  return parsed.success ? parsed.data : null;
}

// The new payout's list: oldest receipt first, the charge lines after them
export function payoutParcelsOf(data: WorkspaceData, accountId: string): PayoutParcels {
  const account = findAccount(data, accountId);
  if (account === undefined) throw notFound();
  const parcels = sentOf(data, account.id).flatMap((sent): PayoutParcel[] => {
    if (sent.parcel.payoutId !== null) return [];
    const kind = kindOf(data, sent.parcel, account.codAccountId);
    return kind === null ? [] : [toParcel(data, sent, kind)];
  });
  parcels.sort(
    (a, b) =>
      (a.receiptDate ?? '9999-12-31').localeCompare(b.receiptDate ?? '9999-12-31') ||
      a.invoice.localeCompare(b.invoice),
  );
  return { account: toAccount(data, account), parcels, csvMap: savedMapOf(account) };
}

function toSummary(data: WorkspaceData, payout: MockPayout): PayoutSummary {
  const account = findAccount(data, payout.accountId);
  return {
    id: payout.id,
    number: payout.number,
    date: payout.date,
    account: {
      id: payout.accountId,
      name: account?.name ?? '',
      courier: account?.courier ?? 'steadfast',
    },
    bankAccountId: payout.bankAccountId,
    reference: payout.reference,
    parcels: payout.lines.length,
    collected: payout.collected,
    charges: payout.charges,
    net: payout.net,
    status: payout.status,
    version: payout.version,
    updatedAt: payout.updatedAt,
  };
}

function findPayout(data: WorkspaceData, id: string): MockPayout {
  const payout = data.storefront.payouts.items.find((item) => item.id === id);
  if (payout === undefined) throw notFound();
  return payout;
}

function findSent(data: WorkspaceData, shipmentId: string): Sent | undefined {
  for (const order of data.storefront.orders) {
    const parcel = order.shipments.find((item) => item.id === shipmentId);
    if (parcel !== undefined) return { order, parcel };
  }
  return undefined;
}

export function toPayout(data: WorkspaceData, payout: MockPayout): Payout {
  const entry = findEntry(data, payout.entryId);
  const lines = payout.lines
    .map((line) => ({ line, sent: findSent(data, line.shipmentId) }))
    .toSorted((a, b) => (a.sent?.parcel.invoice ?? '').localeCompare(b.sent?.parcel.invoice ?? ''));
  return {
    ...toSummary(data, payout),
    note: payout.note,
    codAccountId: payout.codAccountId,
    chargeAccountId: payout.chargeAccountId,
    branchId: payout.branchId,
    lines: lines.map(({ line, sent }) => {
      const receipt = receiptOf(data, line.receiptId);
      return {
        shipmentId: line.shipmentId,
        kind: line.kind,
        order: { id: sent?.order.id ?? '', number: sent?.order.orderNo ?? '' },
        invoice: sent?.parcel.invoice ?? '',
        trackingCode: sent?.parcel.trackingCode ?? null,
        collected: line.collected,
        charge: line.charge,
        courierCharge: line.courierCharge,
        receipt: receipt === undefined ? null : { id: receipt.id, number: receipt.number },
      };
    }),
    entry: refOf(entry),
    voidEntry: entry.reversedBy,
    voidDate: payout.voidDate,
    voidReason: payout.voidReason,
  };
}

export function getPayout(data: WorkspaceData, id: string): Payout {
  return toPayout(data, findPayout(data, id));
}

// Newest date first, then the newest saved (the API's date, id DESC with uuidv7 ids)
export function listPayouts(
  data: WorkspaceData,
  query: { status?: PayoutStatus | undefined; accountId?: string | undefined },
): PayoutSummary[] {
  return data.storefront.payouts.items
    .filter(
      (payout) =>
        (query.status === undefined || payout.status === query.status) &&
        (query.accountId === undefined || payout.accountId === query.accountId),
    )
    .toSorted((a, b) => b.date.localeCompare(a.date))
    .map((payout) => toSummary(data, payout));
}

// ---------------------------------------------------------------------------------------------
// The courier's file (the API's payout-match.ts)

// A manual account's courier is any of five, so it has no preset (mine 18)
const PRESET = {
  steadfast: STEADFAST_PAYOUT_CSV_PRESET,
  manual: null,
} as const satisfies Record<CourierProvider, PayoutCsvMap | null>;

// RFC 4180 as far as a courier's export needs it: quoted cells (with commas, line breaks and ""),
// CRLF or LF, a byte order mark, cells trimmed (csv-parse's `trim`). null: a quote never closed.
// The API reads the file with csv-parse (apps/api/src/common/csv/csv.ts); the mock has no parser
// of its own to share, and the app does not bundle one for a mock
function readCsvRecords(text: string): string[][] | null {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endRow = () => {
    row.push(cell.trim());
    records.push(row);
    row = [];
    cell = '';
    started = false;
  };
  for (let index = text.startsWith('﻿') ? 1 : 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    started = true;
    if (char === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (char === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text.charAt(index + 1) === '\n') index += 1;
      endRow();
    } else {
      cell += char;
    }
  }
  if (quoted) return null;
  if (started || row.length > 0) endRow();
  return records;
}

interface PayoutCsv {
  header: string[];
  rows: { row: number; cells: string[] }[];
}

function readPayoutCsv(
  text: string,
): PayoutCsv | 'payout_csv_unreadable' | 'payout_csv_too_many_rows' {
  const records = readCsvRecords(text);
  const header = records?.[0];
  if (records === null || header === undefined || header.every((cell) => cell === '')) {
    return 'payout_csv_unreadable';
  }
  if (header.length > 200) return 'payout_csv_unreadable';
  // A row of empty cells is skipped, keeping the numbers: the header is row 1
  const rows = records
    .slice(1)
    .flatMap((cells, index) =>
      cells.every((cell) => cell === '') ? [] : [{ row: index + 2, cells }],
    );
  if (rows.length > MAX_PAYOUT_CSV_ROWS) return 'payout_csv_too_many_rows';
  return { header, rows };
}

// Column names are compared without case; the first of a name wins
function positionOf(header: readonly string[], name: string): number {
  const wanted = name.toLowerCase();
  return header.findIndex((cell) => cell.toLowerCase() === wanted);
}

function missingColumns(header: readonly string[], map: PayoutCsvMap): string[] {
  return [map.keyColumn, map.collectedColumn, map.chargeColumn].filter(
    (name): name is string => name !== null && positionOf(header, name) === -1,
  );
}

// "1,250", "৳ 1,250", "Tk 80": an amount; a minus, a third decimal or "N/A": not one
type CellAmount = { valid: true; amount: string | null } | { valid: false };

function readAmount(cell: string): CellAmount {
  const plain = cell.replace(/,|৳|tk\.?|bdt|\s/gi, '');
  if (plain === '') return { valid: true, amount: null };
  return /^\d{1,15}(?:\.\d{1,2})?$/.test(plain)
    ? { valid: true, amount: sumMoney([plain]) }
    : { valid: false };
}

const KEY_OF = {
  invoice: (parcel: MockShipment) => parcel.invoice,
  tracking_code: (parcel: MockShipment) => parcel.trackingCode,
  consignment_id: (parcel: MockShipment) => parcel.consignmentId,
} as const satisfies Record<PayoutCsvKey, (parcel: MockShipment) => string | null>;

type Found =
  | { state: 'payable'; shipmentId: string; collected: string }
  | { state: 'paid'; shipmentId: string; payout: DocumentRef }
  | { state: 'not_ready'; shipmentId: string };

// What each key of the account's parcels is now; the first parcel of a key wins (the API reads in
// the order the parcels were made)
function parcelsByKey(
  data: WorkspaceData,
  account: MockCourierAccount,
  key: PayoutCsvKey,
): Map<string, Found> {
  const found = new Map<string, Found>();
  for (const { parcel } of sentOf(data, account.id)) {
    const value = KEY_OF[key](parcel);
    if (value === null || found.has(value)) continue;
    const payout = payoutRefOf(data, parcel.payoutId);
    if (payout !== null) {
      found.set(value, { state: 'paid', shipmentId: parcel.id, payout });
      continue;
    }
    const kind = kindOf(data, parcel, account.codAccountId);
    found.set(
      value,
      kind === null
        ? { state: 'not_ready', shipmentId: parcel.id }
        : {
            state: 'payable',
            shipmentId: parcel.id,
            collected: kind === 'cod' ? (receiptOf(data, parcel.receiptId)?.amount ?? '0') : '0',
          },
    );
  }
  return found;
}

function sameMap(a: PayoutCsvMap, b: PayoutCsvMap | null): boolean {
  return (
    b !== null &&
    a.key === b.key &&
    a.keyColumn === b.keyColumn &&
    a.collectedColumn === b.collectedColumn &&
    a.chargeColumn === b.chargeColumn
  );
}

// Every row of the file accounted for (decisions 10–12, mine 18 and 19). The map the member gave is
// saved on the account once the file had all its columns
export function matchPayoutFile(
  data: WorkspaceData,
  accountId: string,
  input: PayoutMatchInput,
): PayoutMatch {
  const csv = readPayoutCsv(input.csv);
  if (typeof csv === 'string') throw boxError(csv, ['csv']);
  const account = findAccount(data, accountId);
  if (account === undefined) throw notFound();
  const saved = savedMapOf(account);
  const map = input.map ?? saved ?? PRESET[account.provider];
  const columns = csv.header.filter((name) => name !== '');
  if (map === null) return { columns, map: null, missing: [], rows: [], fileNet: null };
  const missing = missingColumns(csv.header, map);
  if (missing.length > 0) return { columns, map, missing, rows: [], fileNet: null };
  if (input.map !== null && !sameMap(input.map, saved)) account.payoutCsvMap = input.map;

  const parcels = parcelsByKey(data, account, map.key);
  const at = {
    key: positionOf(csv.header, map.keyColumn),
    collected: map.collectedColumn === null ? null : positionOf(csv.header, map.collectedColumn),
    charge: map.chargeColumn === null ? null : positionOf(csv.header, map.chargeColumn),
  };
  const none: CellAmount = { valid: true, amount: null };
  const seen = new Set<string>();
  const rows: PayoutMatchRow[] = [];
  const collectedOnFile: string[] = [];
  const chargesOnFile: string[] = [];
  for (const { row, cells } of csv.rows) {
    const key = cells[at.key] ?? '';
    const collectedCell = at.collected === null ? none : readAmount(cells[at.collected] ?? '');
    const chargeCell = at.charge === null ? none : readAmount(cells[at.charge] ?? '');
    const base = {
      row,
      key,
      shipmentId: null,
      payout: null,
      fileCollected: null,
      fileCharge: null,
    };
    if (key === '' || !collectedCell.valid || !chargeCell.valid) {
      rows.push({ ...base, outcome: 'invalid' });
      continue;
    }
    const amounts = { fileCollected: collectedCell.amount, fileCharge: chargeCell.amount };
    if (seen.has(key)) {
      rows.push({ ...base, ...amounts, outcome: 'twice' });
      continue;
    }
    seen.add(key);
    const parcel = parcels.get(key);
    if (parcel === undefined) {
      rows.push({ ...base, ...amounts, outcome: 'unknown' });
    } else if (parcel.state === 'paid') {
      rows.push({ ...base, ...amounts, outcome: 'already_paid', payout: parcel.payout });
    } else if (parcel.state === 'not_ready') {
      rows.push({ ...base, ...amounts, outcome: 'not_ready', shipmentId: parcel.shipmentId });
    } else {
      const collected = collectedCell.amount;
      const different = collected !== null && compareMoney(collected, parcel.collected) !== 0;
      rows.push({
        ...base,
        ...amounts,
        outcome: different ? 'different' : 'matched',
        shipmentId: parcel.shipmentId,
      });
      collectedOnFile.push(collected ?? '0');
      chargesOnFile.push(chargeCell.amount ?? '0');
    }
  }
  const fileNet =
    map.collectedColumn === null || map.chargeColumn === null
      ? null
      : subtractMoney(sumMoney(collectedOnFile), sumMoney(chargesOnFile));
  return { columns, map, missing: [], rows, fileNet };
}

// ---------------------------------------------------------------------------------------------
// Saving and voiding

// The shop warehouse's branch (decision 7), as the COD receipts'
function shopBranch(data: WorkspaceData): string {
  const warehouseId = data.storefront.shop?.defaultWarehouseId ?? null;
  const branchId = warehouseId === null ? null : branchOf(data, warehouseId);
  if (branchId === null) throw new Error('The shop has no warehouse, so a payout has no branch');
  return branchId;
}

// Saving posts it, with every check the API makes, in the API's order, before anything is written.
// The entry is posted before the payout and its parcels change: a closed period refuses there
// (journal_period_locked) and leaves nothing behind
export function createPayout(
  data: WorkspaceData,
  input: PayoutInput,
  at: string = now(),
): MockPayout {
  const account = findAccount(data, input.accountId);
  if (account === undefined) throw boxError('payout_pick_account', ['accountId']);
  const codAccountId = account.codAccountId;
  if (codAccountId === null) throw boxError('payout_account_no_cod', ['accountId']);
  const chart = chartOf(data);
  if (
    input.bankAccountId === codAccountId ||
    !chart.moneyAccounts.some((choice) => choice.id === input.bankAccountId)
  ) {
    throw boxError('payout_bank_account_invalid', ['bankAccountId']);
  }

  const taken: number[] = [];
  const zero: number[] = [];
  const lines = input.lines.flatMap((line, index) => {
    const sent = findSent(data, line.shipmentId);
    // Another account's parcel, or one in a posted payout already, is not found
    const parcel =
      sent?.parcel.accountId === account.id && sent.parcel.payoutId === null
        ? sent.parcel
        : undefined;
    const kind = parcel === undefined ? null : kindOf(data, parcel, codAccountId);
    if (parcel === undefined || kind === null) {
      taken.push(index);
      return [];
    }
    if (kind === 'charge' && compareMoney(line.charge, '0') === 0) zero.push(index);
    const receipt = kind === 'cod' ? receiptOf(data, parcel.receiptId) : undefined;
    return [
      {
        parcel,
        kind,
        receipt,
        collected: receipt?.amount ?? '0.0000',
        charge: sumMoney([line.charge]),
      },
    ];
  });
  if (taken.length > 0) throw unavailable(taken);
  if (zero.length > 0) {
    throw boxError(
      'payout_charge_line_zero',
      zero.map((index) => `lines.${String(index)}.charge`),
    );
  }
  const collected = sumMoney(lines.map((line) => line.collected));
  const charges = sumMoney(lines.map((line) => line.charge));
  const net = subtractMoney(collected, charges);
  if (isNegativeMoney(net)) throw new MockProblem(422, 'payout_below_zero');
  if (compareMoney(charges, '0') > 0 && account.chargeAccountId === null) {
    throw boxError('payout_account_no_charges', ['accountId']);
  }
  const newest = lines.reduce<string | null>((latest, line) => {
    const day = line.receipt?.date ?? null;
    return day !== null && (latest === null || day > latest) ? day : latest;
  }, null);
  if (newest !== null && input.date < newest) {
    throw new MockProblem(
      422,
      'payout_date_before_receipt',
      { date: ['payout_date_before_receipt'] },
      { date: newest },
    );
  }
  const branchId = shopBranch(data);

  // The number is taken only once the entry is posted: a refused entry leaves the counter as it was
  const id = crypto.randomUUID();
  const number = seriesNumber(
    data,
    'storefront.payout',
    data.storefront.payouts.counter + 1,
    input.date,
  );
  // Dr the bank (what reached it), Dr the charges, Cr the COD account; a ৳0 side is left out
  const entry = postNew(
    data,
    {
      date: input.date,
      narration: `Courier payout ${number} from ${account.name}`,
      lines: [
        ...(isZeroMoney(net) ? [] : [side(input.bankAccountId, branchId, null, { debit: net })]),
        ...(isZeroMoney(charges) || account.chargeAccountId === null
          ? []
          : [side(account.chargeAccountId, branchId, null, { debit: charges })]),
        ...(isZeroMoney(collected)
          ? []
          : [side(codAccountId, branchId, null, { credit: collected })]),
      ],
    },
    'storefront_payout',
    { id, number },
  );
  data.storefront.payouts.counter += 1;
  const payout: MockPayout = {
    id,
    number,
    date: input.date,
    accountId: account.id,
    bankAccountId: input.bankAccountId,
    codAccountId,
    chargeAccountId: account.chargeAccountId,
    branchId,
    reference: input.reference,
    note: input.note,
    collected,
    charges,
    net,
    status: 'posted',
    lines: lines.map((line) => ({
      shipmentId: line.parcel.id,
      kind: line.kind,
      collected: line.collected,
      charge: line.charge,
      courierCharge: line.parcel.courierCharge,
      receiptId: line.receipt?.id ?? null,
    })),
    entryId: entry.id,
    voidDate: null,
    voidReason: null,
    version: 1,
    updatedAt: at,
  };
  data.storefront.payouts.items.unshift(payout);
  for (const line of lines) line.parcel.payoutId = id;
  return payout;
}

// Voided: the entry reversed on the void date and the parcels freed together. The payout stays,
// with its lines, so its number is never reused or missing
export function voidPayout(
  data: WorkspaceData,
  id: string,
  input: VoidPayoutInput,
  at: string = now(),
): { payout: MockPayout; reversal: EntryRef } {
  const payout = findPayout(data, id);
  if (payout.status === 'voided') throw new MockProblem(409, 'payout_voided');
  if (payout.version !== input.version) throw new MockProblem(409, 'version_conflict');
  if (input.date < payout.date) {
    throw new MockProblem(409, 'receipt_void_date', { date: ['receipt_void_date'] });
  }
  const reversal = reverseEntry(data, findEntry(data, payout.entryId), input.date, {
    allowPayout: true,
    narration: `Courier payout ${payout.number} voided: ${input.reason}`,
  });
  Object.assign(payout, {
    status: 'voided',
    voidDate: input.date,
    voidReason: input.reason,
    version: payout.version + 1,
    updatedAt: at,
  });
  for (const order of data.storefront.orders) {
    for (const parcel of order.shipments) {
      if (parcel.payoutId === id) parcel.payoutId = null;
    }
  }
  return { payout, reversal: refOf(reversal) };
}
```

- **One file, imported by the others.** The shipping mock needs what a courier holds and the parcel card's payout;
  the order mock's seed makes a payout. This file imports none of them, only the seed's types, so there is no import
  cycle.
- **`kindOf` is the API's `payoutKindOf`**, with the receipt looked up in the mock's billing. The list, the match and
  the save all use it, so a parcel the page offers is one the save takes.
- **`payoutHoldsOf` is now the only "holds" figure.** Shop couriers' Holds column and the payout form's account select
  both read it, and it leaves out a parcel a posted payout took. Before 28c the shipping mock had its own copy, which
  would have kept counting paid-out money.
- **`createPayout` checks everything first**, in the API's order (account, COD account, bank account, the lines, a
  charge line's zero charge, below zero, the charges account, the date), so the form gets the same error under the same
  box as with the real API. Then the entry, then the writes (mine 51).
- **The entry** is Dr bank (net), Dr charges, Cr COD account, with a ৳0 side left out, like `PayoutBooks.post`. A
  payout of charge lines alone would go below zero and is refused (`payout_below_zero`); one whose charges equal its
  cash has a net of zero, and so no bank line.
- **`voidPayout`** reverses the entry first (it refuses a closed period), then marks the payout voided and frees its
  parcels.
- **`assertReceiptNotPaidOut`** is 0083's `receipts_paid_out` (mine 26): the receipt's Void refuses a COD receipt a
  posted payout took. The handler calls it, so `invoice-data.ts` does not import this file.

### The seed's types and the shipping mock

```diff
@@ -5,6 +5,7 @@ import {
   type PaymentGatewayMode,
   type PaymentGatewayProvider,
   type PaymentGatewayTestProblem,
+  type PayoutCsvMap,
   type ShipmentStatus,
   type ShopCourier,
   type ShopCouponRule,
@@ -29,6 +30,7 @@ import {
 } from '@omnivo/contracts';
 
 import { findVariant } from './stock-data';
+import type { MockPayouts } from './storefront-payout-data';
 import type { WorkspaceData } from './workspace-data';
 
 // Step 26g: what the mock keeps of the online shop, and the garments workspace's open shop. A file
@@ -231,6 +233,8 @@ export interface MockCourierAccount {
   archivedAt: string | null;
   lastWebhookAt: string | null;
   lastTest: { at: string; problem: CourierTestProblem | null } | null;
+  // Step 28c: the payout file's columns, saved by the first file matched with a map (decision 11)
+  payoutCsvMap: PayoutCsvMap | null;
   version: number;
   updatedAt: string;
 }
@@ -261,6 +265,9 @@ export interface MockShipment {
   courierCharge: string | null;
   receiptId: string | null;
   receiptError: ErrorCode | null;
+  // Step 28c: the posted payout that paid it out (storefront-payout-data.ts); null again when it is
+  // voided
+  payoutId: string | null;
 }
 
 // Step 27c: a coupon as the table keeps it (storefront-coupon-data.ts has the rules). The mock has
@@ -297,6 +304,8 @@ export interface MockStorefront {
   gateway: MockGateway | null;
   // Step 28a: the shop's courier accounts, archived ones too, in the order they were made
   couriers: MockCourierAccount[];
+  // Step 28c: the couriers' payouts (storefront-payout-data.ts)
+  payouts: MockPayouts;
 }
 
 export function emptyStorefront(): MockStorefront {
@@ -316,6 +325,7 @@ export function emptyStorefront(): MockStorefront {
     coupons: [],
     gateway: null,
     couriers: [],
+    payouts: { items: [], counter: 0 },
   };
 }
 
```

```diff
@@ -26,6 +26,7 @@ import { API_URL } from '../lib/api';
 import { codeOf } from './accounting-data';
 import { MockProblem } from './mock';
 import { chartOf } from './storefront-payment-data';
+import { payoutHoldsOf, payoutRefOf } from './storefront-payout-data';
 import type { MockCourierAccount, MockShipment, MockShopOrder } from './storefront-seed';
 import type { WorkspaceData } from './workspace-data';
 
@@ -36,9 +37,9 @@ import type { WorkspaceData } from './workspace-data';
 // the first time anything reads the shop's orders after that: the order page asks again every 3
 // seconds while a parcel books, so it sees the answer as it would see the worker's.
 //
-// This file imports no other storefront mock file but the seed's types and (step 28b) the payment
-// card's chartOf, which imports none either: storefront-order-data.ts imports it. The audit rows
-// are the handlers' (handlers.ts).
+// This file imports no other storefront mock file but the seed's types, (step 28b) the payment
+// card's chartOf and (step 28c) the payouts' holds and refs, which import none of the order files
+// either: storefront-order-data.ts imports it. The audit rows are the handlers' (handlers.ts).
 //
 // Step 28b: the courier's money (apps/api/src/storefront/shipping/cod-receipts.ts and
 // shipment-news.ts). An account's two money accounts and what it holds; a parcel's collected
@@ -137,26 +138,6 @@ function lockAccount(data: WorkspaceData, id: string, version: number): MockCour
   return account;
 }
 
-// Step 28b (decision 12): what a courier holds now, the API's holdsOf: the parcels whose COD
-// receipt is posted (a voided one went back out of the COD account), and what their riders
-// collected
-function holdsOf(data: WorkspaceData, accountId: string): CourierAccount['holds'] {
-  const held = data.storefront.orders
-    .flatMap((order) => order.shipments)
-    .filter(
-      (parcel) =>
-        parcel.accountId === accountId &&
-        parcel.receiptId !== null &&
-        data.billing.receipts.some(
-          (receipt) => receipt.id === parcel.receiptId && receipt.status === 'posted',
-        ),
-    );
-  return {
-    amount: sumMoney(held.map((parcel) => parcel.collectedAmount ?? '0')),
-    parcels: held.length,
-  };
-}
-
 // Never the keys, and never a token: only whether one is saved
 export function toCourierAccount(data: WorkspaceData, account: MockCourierAccount): CourierAccount {
   return {
@@ -174,7 +155,9 @@ export function toCourierAccount(data: WorkspaceData, account: MockCourierAccoun
     lastTest: account.lastTest,
     codAccountId: account.codAccountId,
     chargeAccountId: account.chargeAccountId,
-    holds: holdsOf(data, account.id),
+    // Step 28b (decision 12): what the courier holds now, the API's holdsOf. Step 28c: without the
+    // parcels a posted payout took to the bank (storefront-payout-data.ts)
+    holds: payoutHoldsOf(data, account.id),
     version: account.version,
     updatedAt: account.updatedAt,
   };
@@ -263,6 +246,7 @@ export function createCourier(
     archivedAt: null,
     lastWebhookAt: null,
     lastTest: null,
+    payoutCsvMap: null,
     version: 1,
     updatedAt: at,
   };
@@ -404,6 +388,8 @@ export function shipmentsOf(data: WorkspaceData, order: MockShopOrder): Storefro
       courierCharge: parcel.courierCharge,
       receipt: receiptRefOf(data, parcel.receiptId),
       receiptError: parcel.receiptError,
+      // Step 28c
+      payout: payoutRefOf(data, parcel.payoutId),
       bookedAt: parcel.bookedAt,
       attempts: parcel.attempts,
       error: parcel.error,
@@ -541,6 +527,7 @@ export function startShipment(
     courierCharge: null,
     receiptId: null,
     receiptError: null,
+    payoutId: null,
   };
   if (manual) step(parcel, 'booked', at, null);
   order.shipments.push(parcel);
@@ -793,6 +780,7 @@ export function seedCouriers(data: WorkspaceData, at: string): MockCourierAccoun
       archivedAt: null,
       lastWebhookAt: null,
       lastTest: null,
+      payoutCsvMap: null,
       version: 1,
       updatedAt: at,
       ...fields,
@@ -897,6 +885,7 @@ export function seedParcel(
     ...money,
     receiptId: null,
     receiptError: null,
+    payoutId: null,
   };
   order.shipments.push(parcel);
   return parcel;
```

A parcel gets `payoutId`, a courier account `payoutCsvMap`, the shop `payouts`. `MockPayouts` is a type import, so
the seed file still has no code import of the payout file. In the shipping mock, the old `holdsOf` goes: Holds now
comes from `payoutHoldsOf`. The parcel view gains `payout` (the one type error 28c.1 left in the app), and every new
parcel and account starts with the new fields empty.

### The journal's Reverse

```diff
@@ -8,6 +8,7 @@ import {
   formatDocumentNumber,
   isNegativeMoney,
   isPosJournalSource,
+  isStorefrontJournalSource,
   isPurchaseJournalSource,
   isSalesJournalSource,
   isStockJournalSource,
@@ -304,6 +305,8 @@ export function postDraft(data: WorkspaceData, entry: JournalEntry): void {
 // narration; the Reverse button refuses every sales entry (journal_is_sales, step 15c).
 // allowPurchase: the same for a voided supplier payment (bill-data.ts); a bill is corrected by a
 // debit note (17d), never reversed (journal_is_purchase, step 17c).
+// allowPayout: only a voided courier payout (storefront-payout-data.ts, step 28c): Reverse alone
+// would leave its parcels paid out (journal_is_payout).
 export function reverseEntry(
   data: WorkspaceData,
   entry: JournalEntry,
@@ -312,11 +315,13 @@ export function reverseEntry(
     allowYearClose = false,
     allowSales = false,
     allowPurchase = false,
+    allowPayout = false,
     narration,
   }: {
     allowYearClose?: boolean;
     allowSales?: boolean;
     allowPurchase?: boolean;
+    allowPayout?: boolean;
     narration?: string;
   } = {},
 ): JournalEntry {
@@ -335,6 +340,9 @@ export function reverseEntry(
   }
   // Step 20b: a shift's cash is put right by the next count, or a pay in or out the other way
   if (isPosJournalSource(entry.source)) throw new MockProblem(409, 'journal_is_pos');
+  if (isStorefrontJournalSource(entry.source) && !allowPayout) {
+    throw new MockProblem(409, 'journal_is_payout');
+  }
   if (entry.reversedBy !== null) throw new MockProblem(409, 'journal_already_reversed');
   if (date < entry.date) {
     throw new MockProblem(409, 'journal_reversal_date', { date: ['journal_reversal_date'] });
```

Mine 52. The check sits with the other "this entry belongs to a document" checks, before the version and date checks,
in the same place as in the API's `journal.service.ts`.

### Steadfast Dhaka's last week: the seed

```diff
@@ -106,6 +106,20 @@ export function seedsShopOrders(): boolean {
   }
 }
 
+// Step 28c: Steadfast Dhaka's last week of delivered Cash on Delivery orders and one payout, for Shop
+// payouts (storefront-order-data.ts → seedPayoutWeek). Only with the shop orders. They move what
+// Steadfast Dhaka holds, which the 28b tests read, so a test asks for them with
+// test.use({ shopOrders: true, shopPayouts: true }); `pnpm dev:mock` has no key and gets them.
+export const MOCK_NO_SHOP_PAYOUTS_KEY = 'omnivo.mock.noShopPayouts';
+
+export function seedsShopPayouts(): boolean {
+  try {
+    return localStorage.getItem(MOCK_NO_SHOP_PAYOUTS_KEY) === null;
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
@@ -40,6 +40,7 @@ import {
   HEAD_OFFICES,
   OWNER,
   seedsShopOrders,
+  seedsShopPayouts,
   seedsTradeHistory,
   seedsVatMonth,
   type Workspace,
@@ -249,7 +250,8 @@ function seed(workspace: Workspace): WorkspaceData {
   // Step 26g: after the stock (the shop counts in the Main store) and the catalog it lists from
   seedStorefront(data, garments);
   // Step 27b: after the shop it sells from (storefront-order-data.ts, fixtures.ts → seedsShopOrders)
-  if (garments && seedsShopOrders()) seedShopOrders(data);
+  // Step 28c: with Steadfast Dhaka's last week for Shop payouts (fixtures.ts → seedsShopPayouts)
+  if (garments && seedsShopOrders()) seedShopOrders(data, seedsShopPayouts());
   // Step 27c: the mockup's coupons (storefront-coupon-data.ts). A coupon needs no shop, but only
   // the garments workspace has one to run them
   if (garments) seedCoupons(data);
```

```diff
@@ -70,6 +70,7 @@ import {
   seedTry,
   toPayment,
 } from './storefront-payment-data';
+import { createPayout } from './storefront-payout-data';
 import {
   bookableAtPack,
   cancelShipments,
@@ -1358,6 +1359,120 @@ function placeOrder(
   return order;
 }
 
+// Step 28c: Steadfast Dhaka's last week, for Shop payouts (fixtures.ts → seedsShopPayouts). Four
+// Cash on Delivery orders of one attar each, delivered 6 to 2 days ago, each with its COD receipt
+// into 1191 Cash with Steadfast. W-000008's money reached the bank 4 days ago: CPO-…-0001, Steadfast's
+// SFC-23618228, into the Dutch-Bangla account. W-000009 to W-000011 wait for the next payout, and
+// Steadfast has not said W-000011's charge yet. With W-000001's charge (paid online, nothing
+// collected), the new payout's list has three cash parcels and one charge-only line
+function seedPayoutWeek(
+  data: WorkspaceData,
+  dhaka: MockCourierAccount,
+  attar: MockListing,
+  zones: { inside: ShopDeliveryZone; outside: ShopDeliveryZone },
+  warehouseId: string,
+): void {
+  const days = (count: number) => count * 24 * 60;
+  const week = [
+    {
+      spec: {
+        name: 'Nasima Akter',
+        phone: '01715667788',
+        address: 'House 22, Road 11, Banani, Dhaka 1213',
+        zone: zones.inside,
+      },
+      delivered: days(6),
+      consignmentId: '148920512',
+      trackingCode: 'SFR2611190008',
+      courierCharge: '60.0000',
+    },
+    {
+      spec: {
+        name: 'Jahid Hasan',
+        phone: '01817334455',
+        address: 'Flat 3A, Lalmatia Block D, Dhaka 1207',
+        zone: zones.inside,
+      },
+      delivered: days(4),
+      consignmentId: '148920688',
+      trackingCode: 'SFR2611210019',
+      courierCharge: '60.0000',
+    },
+    {
+      spec: {
+        name: 'Rumana Chowdhury',
+        phone: '01914223344',
+        address: 'Road 2, Nasirabad H/S, Chattogram 4209',
+        zone: zones.outside,
+      },
+      delivered: days(3),
+      consignmentId: '148920745',
+      trackingCode: 'SFR2611220031',
+      courierCharge: '130.0000',
+    },
+    {
+      spec: {
+        name: 'Imran Kabir',
+        phone: '01556112233',
+        address: 'House 5, Sector 4, Uttara, Dhaka 1230',
+        zone: zones.inside,
+      },
+      delivered: days(2),
+      consignmentId: '148920802',
+      trackingCode: 'SFR2611230044',
+      courierCharge: null,
+    },
+  ];
+  const sent = week.map((day, index) => {
+    const order = placeOrder(
+      data,
+      8 + index,
+      { ...day.spec, lines: [{ listing: attar, quantity: 1 }], confirmed: day.delivered + days(1) },
+      warehouseId,
+    );
+    const at = (minutes: number) =>
+      new Date(Date.parse(confirmedAt(order)) + minutes * 60_000).toISOString();
+    makeShopSalesOrder(data, order, confirmedAt(order));
+    packAsPlanned(data, order, at(90));
+    shipShopOrder(data, order.id, order.version, at(180));
+    const parcel = seedParcel(
+      order,
+      dhaka,
+      { consignmentId: day.consignmentId, trackingCode: day.trackingCode },
+      at(92),
+      [
+        { status: 'picked_up', at: at(180), note: 'Picked up from Rahman Fashion' },
+        { status: 'out_for_delivery', at: at(days(1) - 150), note: null },
+      ],
+      { collectedAmount: codAmountOf(order), courierCharge: day.courierCharge },
+    );
+    // Steadfast's delivered notice: the parcel follows, and settleCod makes the COD receipt
+    deliverShopOrder(
+      data,
+      order.id,
+      { version: order.version, collectedAmount: null },
+      at(days(1)),
+    );
+    return { order, parcel, day: dayOf(data, at(days(1))) };
+  });
+  const first = sent[0];
+  const bank = data.accounts.find((account) => account.code === '1121');
+  if (!first || !bank) return;
+  const paidOn = dayOf(data, minutesAgo(days(4)));
+  createPayout(
+    data,
+    {
+      accountId: dhaka.id,
+      date: paidOn,
+      bankAccountId: bank.id,
+      reference: 'SFC-23618228',
+      note: null,
+      lines: [{ shipmentId: first.parcel.id, charge: '60' }],
+    },
+    minutesAgo(days(4)),
+  );
+}
+
 // Packed with what the plan suggests: FEFO for a batch line, the first serial numbers in stock for
 // a serial one (the seed's packer scans those)
 function packAsPlanned(data: WorkspaceData, order: MockShopOrder, at: string): void {
@@ -1575,8 +1690,9 @@ function seedTries(
 // line of each kind for the Packed dialog (a batch, a serial, an untracked polo), W-000006 is a
 // small one to cancel, and W-000007's sales order was refused when it was confirmed (the T-shirt
 // was archived for a moment); it is active again, so "Make the sales order" works. Farhana Islam
-// ordered twice: one customer in the ERP
-export function seedShopOrders(data: WorkspaceData): void {
+// ordered twice: one customer in the ERP. Step 28c: `payouts` adds Steadfast Dhaka's last week
+// (seedPayoutWeek)
+export function seedShopOrders(data: WorkspaceData, payouts = false): void {
   const shop = data.storefront.shop;
   const warehouseId = shop?.defaultWarehouseId ?? null;
   const [inside, outside] = shop?.deliveryZones ?? [];
@@ -1723,6 +1839,7 @@ export function seedShopOrders(data: WorkspaceData): void {
     // Step 28b: outside Dhaka, Steadfast charges more; nothing collected yet
     { collectedAmount: null, courierCharge: '130.0000' },
   );
+  if (payouts) seedPayoutWeek(data, dhaka, attar, { inside, outside }, warehouseId);
 
   // The bell of the newest order that is not refused, unread (27a's handler rings it)
   const newest = orders[5];
```

- **Four orders of one Oud attar each** (৳650), W-000008 to W-000011. The attar has ten in stock and a batch, so the
  packing works with the existing plan (FEFO) and leaves stock for the other seeded orders.
- **Each goes the real way:** sales order, Packed, Shipped, the courier's parcel with its steps and Steadfast's
  `cod_amount` and `delivery_charge`, then Delivered, which makes the invoice and the COD receipt (`settleCod`). So the
  receipts, the journal and the invoices agree, as they would after a real week.
- **W-000011 has no charge from the courier** (`courierCharge: null`), so the form shows "Steadfast has not said its
  charge" and the save needs one typed.
- **W-000008 is paid out four days ago** by `createPayout` itself, with Steadfast's reference `SFC-23618228`: the list
  is not empty, and a file can name an "already paid out" parcel.

### The routes: `mocks/handlers.ts`

```diff
@@ -261,6 +261,17 @@ import {
   toCourierAccount,
   updateCourier,
 } from './storefront-shipping-data';
+import {
+  assertReceiptNotPaidOut,
+  createPayout,
+  getPayout,
+  listPayouts,
+  matchPayoutFile,
+  payoutParcelsOf,
+  payoutSetupOf,
+  toPayout,
+  voidPayout,
+} from './storefront-payout-data';
 import {
   findProduct,
   IMPORT_DELAY_MS,
@@ -3734,6 +3745,8 @@ export const handlers = [
       const target = findReceipt(data, id);
       assertNotVoided(target);
       checkVersion(target.version, version);
+      // Step 28c: a COD receipt a posted courier payout took to the bank (receipt_paid_out)
+      assertReceiptNotPaidOut(data, id);
       transaction(data, () => {
         voidReceipt(data, target, input);
         record(data, 'receipt.voided', 'receipt', id);
@@ -6623,6 +6636,117 @@ export const handlers = [
     }),
   ),
 
+  // --- Step 28c: Shop payouts (storefront-payout-data.ts) --------------------------------------
+  // storefront.payout.manage on every route (decision 9), never storefront.manage: an accountant
+  // records payouts without the shop's settings. Saving and voiding run in a transaction(), so a
+  // refused entry (a closed period) puts the journal back as it was
+
+  mock(
+    routes.storefrontPayouts.setup,
+    guarded(async () => {
+      const data = shopOrderData(routes.storefrontPayouts.setup.permission);
+      await delay();
+      return reply(routes.storefrontPayouts.setup, payoutSetupOf(data));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayouts.list,
+    guarded(({ request }) => {
+      const data = shopOrderData(routes.storefrontPayouts.list.permission);
+      const query = readQuery(routes.storefrontPayouts.list.query, request);
+      return reply(routes.storefrontPayouts.list, pageOf(listPayouts(data, query), query));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayouts.get,
+    guarded(({ params }) => {
+      const data = shopOrderData(routes.storefrontPayouts.get.permission);
+      const { id } = routes.storefrontPayouts.get.params.parse(params);
+      return reply(routes.storefrontPayouts.get, getPayout(data, id));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayouts.parcels,
+    guarded(async ({ params }) => {
+      const data = shopOrderData(routes.storefrontPayouts.parcels.permission);
+      const { id } = routes.storefrontPayouts.parcels.params.parse(params);
+      await delay();
+      return reply(routes.storefrontPayouts.parcels, payoutParcelsOf(data, id));
+    }),
+  ),
+
+  // No audit row: the saved map moves no money (mine 21)
+  mock(
+    routes.storefrontPayouts.match,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontPayouts.match.permission);
+      const { id } = routes.storefrontPayouts.match.params.parse(params);
+      const body = await readBody(routes.storefrontPayouts.match.body, request);
+      await delay();
+      return reply(routes.storefrontPayouts.match, matchPayoutFile(data, id, body));
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayouts.create,
+    guarded(async ({ request }) => {
+      const data = shopOrderData(routes.storefrontPayouts.create.permission);
+      const body = await readBody(routes.storefrontPayouts.create.body, request);
+      const payout = transaction(data, () => {
+        const made = createPayout(data, body);
+        const view = toPayout(data, made);
+        record(
+          data,
+          'storefront_payout.created',
+          'storefront_payout',
+          made.id,
+          diff(
+            {},
+            {
+              number: made.number,
+              date: made.date,
+              courierAccount: view.account.name,
+              bankAccount: codeOf(data.accounts, made.bankAccountId),
+              reference: made.reference,
+              parcels: made.lines.length,
+              collected: made.collected,
+              charges: made.charges,
+              net: made.net,
+              entry: view.entry.number,
+            },
+          ),
+        );
+        return view;
+      });
+      return reply(routes.storefrontPayouts.create, payout);
+    }),
+  ),
+
+  mock(
+    routes.storefrontPayouts.void,
+    guarded(async ({ request, params }) => {
+      const data = shopOrderData(routes.storefrontPayouts.void.permission);
+      const { id } = routes.storefrontPayouts.void.params.parse(params);
+      const body = await readBody(routes.storefrontPayouts.void.body, request);
+      const payout = transaction(data, () => {
+        const { payout: voided, reversal } = voidPayout(data, id, body);
+        record(
+          data,
+          'storefront_payout.voided',
+          'storefront_payout',
+          id,
+          diff({}, { date: body.date, reason: body.reason, reversal: reversal.number }),
+        );
+        return toPayout(data, voided);
+      });
+      await delay();
+      return reply(routes.storefrontPayouts.void, payout);
+    }),
+  ),
+
   // --- Step 27d: the Online payment card (storefront-payment-data.ts) ---------------------------
   // storefront.manage, like the shop's settings. The audit rows never hold the password: a new
   // one is written as "changed" (the API's snapshot)
```

- **`storefront.payout.manage` on every route**, through `shopOrderData(permission)`, which checks whatever permission
  it is given. Never `shopData()`: that asks for `storefront.manage`, which an accountant does not have.
- **Save and void run in `transaction()`**, so a refused entry puts the journal back.
- **The audit rows** have the API's fields, with the bank account by its code. The file match writes no audit row
  (mine 21).
- **The receipt's Void** calls `assertReceiptNotPaidOut` after its own checks.

### The fix from the browser: "Print voucher"

```diff
@@ -47,8 +47,10 @@ import { useIsoDate, useQuantity, useTenantId, useWarehouses } from './stock-par
 // Print (or Save as PDF), so it works offline and needs no PDF service. Each page renders its sheet
 // next to itself; PrintSheet keeps it hidden on the screen and alone on paper.
 
-// "Print" in a document's header: the browser prints the sheet of the page
-export function PrintButton() {
+// "Print" in a document's header: the browser prints the sheet of the page. Step 28c: `label` for
+// a page whose sheet has its own name ("Print voucher" on a courier payout, approved with its
+// mockup); every other page says Print
+export function PrintButton({ label }: { label?: string }) {
   const { t } = useLocale();
   return (
     <Button
@@ -58,7 +60,7 @@ export function PrintButton() {
       }}
     >
       <HugeiconsIcon icon={PrinterIcon} size={17} strokeWidth={1.5} />
-      {t('print.print')}
+      {label ?? t('print.print')}
     </Button>
   );
 }
```

```diff
@@ -57,7 +57,7 @@ export function PayoutView({ payout, today }: { payout: Payout; today: string })
           <>
             <PayoutStatusPill status={payout.status} />
             {/* A voided payout does not print (a voided document on paper looks real) */}
-            {posted && <PrintButton />}
+            {posted && <PrintButton label={t('storefront.payout.print')} />}
           </>
         }
       />
```

Mine 50. `label` is optional, so the thirteen other pages that print are unchanged.

### The tests: `e2e/storefront-payouts.e2e.ts`

```diff
@@ -8,6 +8,7 @@ import {
   HEAD_OFFICES,
   MOCK_NO_HISTORY_KEY,
   MOCK_NO_SHOP_ORDERS_KEY,
+  MOCK_NO_SHOP_PAYOUTS_KEY,
   MOCK_NO_VAT_MONTH_KEY,
   MOCK_ROLE_KEY,
   type MockRole,
@@ -62,6 +63,7 @@ export const test = base.extend<{
   tradeHistory: boolean;
   vatMonth: boolean;
   shopOrders: boolean;
+  shopPayouts: boolean;
 }>({
   seedDevice: [true, { option: true }],
   answerPinDialog: [true, { option: true }],
@@ -71,9 +73,12 @@ export const test = base.extend<{
   vatMonth: [false, { option: true }],
   // Step 27b: Rahman Fashion's shop orders (fixtures.ts → MOCK_NO_SHOP_ORDERS_KEY)
   shopOrders: [false, { option: true }],
+  // Step 28c: Steadfast Dhaka's last week for Shop payouts, with the shop orders
+  // (fixtures.ts → MOCK_NO_SHOP_PAYOUTS_KEY)
+  shopPayouts: [false, { option: true }],
   // `provide`, not Playwright's usual `use`: the React hooks lint rule reads `use(…)` as a hook
   page: async (
-    { page, seedDevice, answerPinDialog, tradeHistory, vatMonth, shopOrders },
+    { page, seedDevice, answerPinDialog, tradeHistory, vatMonth, shopOrders, shopPayouts },
     provide,
   ) => {
     copies.set(page, copyOf(page));
@@ -92,6 +97,11 @@ export const test = base.extend<{
         localStorage.setItem(key, '1');
       }, MOCK_NO_SHOP_ORDERS_KEY);
     }
+    if (!shopPayouts) {
+      await page.addInitScript((key) => {
+        localStorage.setItem(key, '1');
+      }, MOCK_NO_SHOP_PAYOUTS_KEY);
+    }
     if (answerPinDialog) {
       // A new seeded device always asks once; without the seed the branch dialog comes first
       if (seedDevice) pinWaiting.add(page);
```

```ts
import type { Page } from '@playwright/test';

import {
  actAs,
  expect,
  expectNoSideScroll,
  listItem,
  openFromNav,
  test,
  toastShown,
} from './helpers.js';

// Step 28c: Shop payouts on the mock (mocks/storefront-payout-data.ts). Steadfast Dhaka's last week
// (storefront-order-data.ts → seedPayoutWeek): W-000008 to W-000011, one Oud attar each (৳650),
// Cash on Delivery, delivered 6 to 2 days ago, each with its COD receipt into 1191 Cash with
// Steadfast. Inside Dhaka the shopper paid ৳730 and Steadfast charges ৳60; W-000010 went to
// Chattogram (৳770, ৳130). W-000008 is paid out already on CPO-…-0001 (Steadfast's SFC-23618228).
// Steadfast has not said W-000011's charge. W-000001 was paid online, so its ৳60 is a charge-only
// line; W-000003 is still on its way. Moving between pages goes through the menu: a reload starts
// the mock again.
test.use({ shopOrders: true, shopPayouts: true });

// A row's name starts with the number (the rest of the row follows it), a heading's is the number
const CPO = (n: number) => new RegExp(`^CPO-\\d{4}-\\d{2}-${String(n).padStart(4, '0')}\\b`);

// The account select, the Record payout page's first box
function accountSelect(page: Page) {
  return page.getByLabel('Courier account', { exact: true });
}

// A parcel's row (a card on a phone): a group named by its invoice
function parcel(page: Page, invoice: string) {
  return page.getByRole('group', { name: invoice, exact: true });
}

async function tick(page: Page, invoice: string): Promise<void> {
  await page.getByRole('checkbox', { name: `Pay out ${invoice}`, exact: true }).check();
}

function totals(page: Page) {
  return page.locator('dl').filter({ hasText: 'To the bank' }).last();
}

async function newPayout(page: Page): Promise<void> {
  await openFromNav(page, 'Shop payouts');
  await page.getByRole('button', { name: 'Record payout' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Record a courier payout' }),
  ).toBeVisible();
}

// The browser reads the file; the dialog posts its text to the match route
async function chooseFile(page: Page, name: string, csv: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Match the courier’s payout file' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose CSV file' }).click();
  await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
}

test('lists the payouts, with the filters in the address', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop payouts');
  const first = listItem(page, CPO(1));
  await expect(first).toContainText('Steadfast Dhaka');
  await expect(first).toContainText('৳670');
  await expect(first).toContainText('Posted');
  await expectNoSideScroll(page);

  // Voided: none yet, and the address keeps the filter
  await page.getByRole('group', { name: 'Show' }).getByText('Voided', { exact: true }).click();
  await expect(page).toHaveURL(/status=voided/);
  await expect(page.getByText('No payout matches')).toBeVisible();
  await page.getByRole('button', { name: 'Show every payout' }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(first).toBeVisible();

  // The payout's page: its parcel, its receipt and its entry; the voucher waits for the print
  await first.click();
  await expect(page.getByRole('heading', { level: 1, name: CPO(1) })).toBeVisible();
  await expect(page.getByText('SFC-23618228').first()).toBeVisible();
  await expect(page.getByText('1121 · Dutch-Bangla Bank CD A/C 1234').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'W-000008' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toBeVisible();
  const sheet = page.locator('[data-print-sheet]');
  await expect(sheet).toContainText('Courier payout');
  await expect(sheet).toContainText('SFC-23618228');
  await expect(page.getByRole('button', { name: 'Print voucher' })).toBeVisible();
  await expectNoSideScroll(page);

  // Its COD receipt can't be voided while the payout stands (receipt_paid_out)
  await page.getByRole('link', { name: /^MR-/ }).click();
  await page.getByRole('button', { name: 'Void receipt' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Typed twice');
  await dialog.getByRole('button', { name: 'Void receipt' }).click();
  await expect(
    dialog.getByText(/^A courier payout paid this COD money out to the bank\./),
  ).toBeVisible();
});

test('records a payout from the courier’s row menu, then voids it', async ({ page }) => {
  await page.goto('/');
  await openFromNav(page, 'Shop couriers');
  // What it holds: the three receipts no payout took (৳730 + ৳770 + ৳730)
  await expect(listItem(page, /^Steadfast Dhaka/)).toContainText('৳2,230 · 3 parcels');
  await page.getByRole('button', { name: 'Actions for Steadfast Dhaka', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Record payout' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Record a courier payout' }),
  ).toBeVisible();
  await expect(accountSelect(page).locator('option:checked')).toHaveText(
    'Steadfast Dhaka · holds ৳2,230 in 3 parcels',
  );
  // An account with no COD account is shown, not offered
  await expect(
    accountSelect(page).locator('option', { hasText: 'Pathao counter · no COD account' }),
  ).toBeDisabled();

  // Oldest receipt first, the charge-only line last; W-000008 is paid out, W-000003 on its way
  await expect(page.getByRole('group', { name: /^W-0000/ })).toHaveCount(4);
  await expect(parcel(page, 'W-000001')).toContainText('Charge only: no cash came');
  await expect(parcel(page, 'W-000011')).toContainText('Steadfast has not said its charge');
  await expect(parcel(page, 'W-000008')).toHaveCount(0);
  await expectNoSideScroll(page);

  await page
    .getByLabel('Paid into')
    .selectOption({ label: '1121 · Dutch-Bangla Bank CD A/C 1234' });
  await page.getByLabel(/^Courier’s reference/).fill('SFC-23640011');
  await tick(page, 'W-000009');
  await tick(page, 'W-000001');
  await tick(page, 'W-000011');
  await expect(page.getByText('3 parcels ticked')).toBeVisible();
  // W-000011's box is empty: nobody typed its charge
  await page.getByRole('button', { name: 'Record payout' }).click();
  await expect(parcel(page, 'W-000011')).toContainText('Type the courier’s charge for this parcel');
  await page.getByLabel('Charge for W-000011').fill('60');
  // ৳730 + ৳730 collected, ৳60 × 3 charges
  await expect(totals(page)).toContainText('৳1,460.00');
  await expect(totals(page)).toContainText('৳180.00');
  await expect(totals(page)).toContainText('৳1,280.00');

  await page.getByRole('button', { name: 'Record payout' }).click();
  await toastShown(page, /^CPO-\d{4}-\d{2}-0002 recorded$/);
  await expect(page.getByRole('heading', { level: 1, name: CPO(2) })).toBeVisible();
  await expect(page.getByText('Charge only: no cash came')).toBeVisible();
  const total = page.getByRole('row', { name: /^Total/ });
  await expect(total).toContainText('৳1,460.00');
  await expect(total).toContainText('৳1,280.00');

  // The parcel card says which payout took the money
  await page.getByRole('link', { name: 'W-000009' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'W-000009' })).toBeVisible();
  await expect(page.getByText('Paid out on')).toBeVisible();
  await page.getByRole('link', { name: CPO(2) }).click();

  // Voided: the entry reversed, the parcels free again for the next payout
  await page.getByRole('button', { name: 'Void payout' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill('Recorded the wrong transfer');
  await dialog.getByRole('button', { name: 'Void payout' }).click();
  await toastShown(page, /^CPO-\d{4}-\d{2}-0002 voided$/);
  await expect(
    page.getByText(
      /^Voided on .+: Recorded the wrong transfer\. Its parcels can be paid out again\./,
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /^JV-/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Void payout' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print voucher' })).toHaveCount(0);

  await newPayout(page);
  await accountSelect(page).selectOption({ label: 'Steadfast Dhaka · holds ৳2,230 in 3 parcels' });
  await expect(page.getByRole('group', { name: /^W-0000/ })).toHaveCount(4);
});

test('matches the courier’s payout file, with the preset and with picked columns', async ({
  page,
}) => {
  await page.goto('/');
  await newPayout(page);
  await accountSelect(page).selectOption({ label: 'Steadfast Dhaka · holds ৳2,230 in 3 parcels' });
  await page.getByRole('button', { name: 'Match a payout file' }).click();

  // Steadfast's preset columns: one row of each outcome
  await chooseFile(
    page,
    'steadfast-payout.csv',
    [
      'Invoice,Tracking Code,COD Amount,Delivery Charge',
      'W-000009,SFR2611210019,730,60',
      'W-000010,SFR2611220031,"1,000",130',
      'W-000008,SFR2611190008,730,60',
      'W-000003,SFR2611210042,0,130',
      'W-000099,SFR0000000000,500,60',
      'W-000009,SFR2611210019,730,60',
      'W-000011,SFR2611230044,N/A,60',
    ].join('\n'),
  );
  const dialog = page.getByRole('dialog', { name: 'Match the courier’s payout file' });
  for (const pill of [
    'Found: 1',
    'Other amount: 1',
    'Not found: 1',
    'Can’t be read: 1',
    'Twice in the file: 1',
    'Already paid out: 1',
    'Not ready: 1',
  ]) {
    await expect(dialog.getByText(pill, { exact: true })).toBeVisible();
  }
  await expect(
    dialog.getByText(/^The file says ৳1,000\.00 collected, the money receipt ৳770\.00\./),
  ).toBeVisible();
  await expect(dialog.getByText(/^Paid out on CPO-\d{4}-\d{2}-0001\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Tick 2 parcels' }).click();
  await toastShown(page, '2 parcels ticked from the file');
  // The file says ৳1,540 reached the bank; the receipts say ৳1,310
  await expect(totals(page)).toContainText('The file says ৳1,540.00 reached the bank');
  await expect(totals(page)).toContainText('Out by ৳230.00');

  // Another courier's export: other names, so the columns are picked once
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Match a payout file' }).click();
  await chooseFile(
    page,
    'bank-sheet.csv',
    ['Consignment,Paid,Fee', '148920688,730,60', '148920802,730,60', ''].join('\r\n'),
  );
  await expect(dialog.getByRole('heading', { name: 'Which column is which?' })).toBeVisible();
  await expect(dialog.getByText(/^Not in the file: /)).toBeVisible();
  await dialog.getByLabel('Parcels are named by').selectOption({ label: 'Courier’s ID' });
  await dialog.getByLabel('Its column').selectOption('Consignment');
  await dialog.getByLabel('Collected column').selectOption('Paid');
  await dialog.getByLabel('Charge column').selectOption('Fee');
  await dialog.getByRole('button', { name: 'Match the file' }).click();
  await expect(dialog.getByText('Found: 2', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Tick 2 parcels' }).click();
  await toastShown(page, '2 parcels ticked from the file');
  await expect(page.getByLabel('Charge for W-000011')).toHaveValue('60.00');
  await expect(totals(page)).toContainText('Agrees');
  await expectNoSideScroll(page);

  // The picked columns are kept: the same file again goes straight to the result
  await page.getByRole('button', { name: 'Match a payout file' }).click();
  await chooseFile(page, 'bank-sheet.csv', ['Consignment,Paid,Fee', '148920688,730,60'].join('\n'));
  await expect(dialog.getByText('Already paid out: 1', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Found: 1', { exact: true })).toBeVisible();
});

test('an accountant who only records payouts sees Shop payouts alone', async ({ page }) => {
  await actAs(page, { name: 'Accountant', permissions: ['storefront.payout.manage'] });
  await page.goto('/');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Shop orders' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Shop couriers' })).toHaveCount(0);
  await openFromNav(page, 'Shop payouts');
  await listItem(page, CPO(1)).click();
  await expect(page.getByRole('heading', { level: 1, name: CPO(1) })).toBeVisible();
  // The shop's order would be refused: the invoice is text, not a link
  await expect(page.getByText('W-000008', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'W-000008' })).toHaveCount(0);
});
```

- **The list** with the filter in the address, the payout's page (its parcel, receipt, entry and the voucher in the
  page), and the receipt that cannot be voided while the payout stands.
- **Recording a payout from Shop couriers' row menu**: the account comes chosen, an account with no COD account is
  greyed out, the charge-only line, the empty charge refused under its own box, the sums, the parcel card's "Paid out
  on", then Void and the parcels free again.
- **The file**, once with Steadfast's preset names and one row of each outcome (the file's bank figure is ৳230 more
  than the receipts', so "Out by ৳230.00"), and once with other names, which shows the mapping step; the picked
  columns are kept for the next file.
- **An accountant with only `storefront.payout.manage`** sees the Storefront group with Shop payouts alone, and a
  payout's order is text, not a link.
- Every test runs at 1280px and at 390px (Pixel 7), and checks that the page never scrolls sideways.

### Check this part

```bash
pnpm turbo build --filter='./packages/*'
pnpm --filter @omnivo/app typecheck
pnpm --filter @omnivo/app test                                             # 261 tests
pnpm --filter @omnivo/app exec playwright test -c e2e/playwright.config.ts storefront-payouts
pnpm exec eslint apps/app/src apps/app/e2e
pnpm exec prettier --check apps/app/src apps/app/e2e
```

What ran on commit 15bd9f0:

- **The app type check passes** again, `e2e/` too: the parcel's `payout` was the last error 28c.1 left. The app's 261
  unit tests pass; eslint and prettier pass on every changed file.
- **`storefront-payouts.e2e.ts`: 8 pass** (4 tests at 1280px and at 390px).
- **The neighbouring suites still pass** (every `storefront*` file, receipts, journal, bills and refunds, both sizes):
  124 tests. They cover the Holds column, the parcel card and the print button that this part changed.
- **Broken on purpose,** one at a time, each caught:
  1. `payoutHoldsOf` counting paid-out parcels: the Holds and the account select's figure are wrong;
  2. the file match without its `seen` set: no "Twice in the file" row;
  3. `voidPayout` keeping the parcels' `payoutId`: they are not offered again after the void;
  4. the receipt's Void without `assertReceiptNotPaidOut`: a paid-out COD receipt is voided.

## 28c.8 — Run it and check it

Every check ran once on the whole repo, then the whole way ran on the real API with the fake courier. The full run
found two things that the earlier parts' own checks did not: an import loop between two schema files, and a test that
counts the number series. Both are fixed in the parts they belong to (28c.2 and 28c.4 above). `openapi.json` is
generated again. The run on the real API found no bug.

Decisions made in this part:

53. **The two schema files may import each other** (`.dependency-cruiser.cjs`, shown in 28c.2). A parcel points at
    its payout and a payout line points at its parcel, so `storefront-shipping.ts` and `storefront-payouts.ts` need
    each other. `pnpm boundaries` refuses every import loop; step 17c allowed exactly two files (bills and goods
    receipts) for the same reason, and these two are added beside them. 28c.2's checks did not run `pnpm boundaries`;
    they do now.
54. **Bug fixed in a test:** `numbering.int.spec.ts` counts the number series the page lists, and 28c.1's `CPO`
    series made it 24, not 23. The test now says 24 and checks the new series (shown in 28c.4). The payout code did
    not change.

### The API description

`packages/contracts/openapi.json` is generated again, as in 28b.8:

```bash
node packages/contracts/scripts/gen-openapi.ts
pnpm test:openapi
```

It adds the six new paths (`/storefront/payout-setup`, `/storefront/payouts`, `/storefront/payouts/{id}`, its
`void`, and the courier account's `payout-parcels` and `payout-match`), the parcel's `payout`, the courier account's
saved CSV map, the permission and the journal source. The file is not shown here: it is long, and nobody writes it by
hand.

### The bundle

No budget changes. The first load is 254.0 KB of its 255 KB: the payout screens' words (28c.5) and the seven new
routes in the contracts' route table added 3 KB. The screens stay in their lazy chunks: the new payout page 135.5 KB,
the file dialog 85.6 KB, the payout's page 101.9 KB and the list 99.6 KB (budget 155). Shop couriers is 137.0 KB and
the shop order page 135.8 KB. The next step that adds words to every page will need the budget again, or the real fix:
loading each module's words with its own pages.

### The run on the real API

Not part of the repo: a script started a throwaway Postgres, Valkey, MinIO and Mailpit on other ports, the built API
and worker (`COURIER_MODE=fake`), ran `pnpm seed:shop`, started the built shop with `SHOP_SOURCE=api`, and drove the
ERP's production build and the shop in one browser:

- Two accounts added to the demo chart, beside 1110 with "Holds money": `1191 · Cash with Steadfast` and
  `1121 · Dutch-Bangla Bank CD A/C 1234`. "Steadfast Dhaka" added with its keys, COD account 1191 and charges
  account `5240 · Transport and conveyance`.
- 28b's four orders again (two shampoos each, ৳538 with delivery), packed and booked by the worker: W-000001
  delivered by the webhook (collected ৳538, charge ৳70, `MR-2026-27-0001`), W-000002 partly delivered (৳309, charge
  ৳70, one shampoo back), W-000003 cancelled after the pick-up with `delivery_charge` 60 and received back (no cash),
  W-000004 marked delivered by hand with ৳500 (no charge from the courier). Shop couriers said "৳1,347 · 3 parcels".
- **Record payout** from the Shop couriers row menu: the account select said "Steadfast Dhaka · holds ৳1,347 in 3
  parcels" and the page offered four parcels, the three receipts oldest first and W-000003 last as "Charge only: no
  cash came" with "Steadfast said ৳60". W-000004 said "Steadfast has not said its charge".
- **The file:** a CSV with Steadfast's preset columns (Invoice, Tracking Code, COD Amount, Delivery Charge), one row
  per parcel (charges 70, 70, 60, 70) and one invoice the shop never had. The dialog said "Found: 4" and "Not found:
  1" (row 6, "None of Steadfast Dhaka's parcels has this number."). "Tick 4 parcels" ticked all four with the file's
  charges, W-000004's ৳70 too. The totals: collected ৳1,347.00, charges ৳270.00, to the bank ৳1,077.00, and "The file
  says ৳1,077.00 reached the bank" with "Agrees".
- **Saved** as `CPO-2026-27-0001`: four lines, all four parcels linked, and entry `JV-2026-27-0014`: Dr 1121 ৳1,077,
  Dr 5240 ৳270, Cr 1191 ৳1,347. The payout's page showed the lines with W-000003's "−৳60.00" to the bank, and the
  voucher on its print sheet.
- Shop couriers then said "Nothing yet". W-000001's parcel card said "Paid out on CPO-2026-27-0001". Voiding its
  money receipt was refused (409, "A courier payout paid this COD money out to the bank.").
- **Void payout** ("Recorded the wrong transfer"): the payout voided with its lines kept, no parcel linked, and the
  reversal `JV-2026-27-0015` (Dr 1191 ৳1,347 / Cr 1121 ৳1,077, Cr 5240 ৳270). Shop couriers said "৳1,347 · 3
  parcels" again. No page had a script error.

### Try it

28c adds no setting to `.env`. Run the migrations (0077–0081 are 28a's and 28b's, if your database does not have
them yet):

```bash
pnpm install
pnpm db:migrate        # 0082 and 0083 (and 0077–0081 from 28a and 28b)
pnpm dev
```

Sign in to the demo shop's ERP as in 28a.8. Set up 28b's COD money first (28b.8's list), and add a bank account
(`1121 · Dutch-Bangla Bank CD A/C 1234`, "Holds money") to the chart.

- [ ] Deliver three parcels with a `cod_amount` and a `delivery_charge` (28b.8), and cancel one after `pending` with
      a `delivery_charge`, then receive it back.
- [ ] Shop payouts is in the Storefront group. Record payout: the account says what it holds, the cancelled parcel
      is a charge-only line, and nothing is ticked.
- [ ] Tick the parcels, pick the bank and save. The journal entry has the bank, the charges and the COD account, and
      the Shop couriers row says "Nothing yet".
- [ ] Open a parcel's order: the parcel card says "Paid out on CPO-…". Try to void its money receipt: it is refused.
- [ ] Record payout again: the paid-out parcels are not offered.
- [ ] Match a CSV with other column names: the dialog asks which column is which, and the next file of that courier
      goes straight to the result.
- [ ] Void the payout: its entry is reversed, and the parcels are offered again.
- [ ] A role with only `storefront.payout.manage` sees the Storefront group with Shop payouts alone.

Before the first live shop, with a real Steadfast account:

- [ ] Download one real payout report from Steadfast's panel. If its columns are not Invoice, Tracking Code, COD
      Amount and Delivery Charge, change `STEADFAST_PAYOUT_CSV_PRESET` in `storefront-payouts.ts` (decision 11), or
      pick the columns once in the dialog.
- [ ] Compare one payout's bank transfer with the payout Omnivo records for it.
- [ ] Look at Steadfast's `GET /payments/{id}` answer: once its shape is known, a payout can be made from it without
      a file (decision 1).

## What comes next

- **28c.9 (done, 2026-11-25):** the docs: CLAUDE.md (the Shop payouts menu item, its list, new payout page, file
  dialog, payout page, void dialog and voucher, the payout statuses and match outcome pills, Shop couriers' "Record
  payout", the parcel card's "Paid out on", a paragraph on the payout in the storefront section), system-design §14.6
  and build-plan ২৮c with section ৯.
- **28d (later, no target date):** Pathao, with the address as its own city, zone and area. The work now is the
  release, so 28d has no planned date. Until it comes, add Pathao as a manual courier account: book by hand, and the
  COD receipt and the payout work the same way.
- **Later:** Steadfast's payments API, once a real account shows its answer.
- **Known limits:** the Steadfast preset is a guess (decision 11). The words of every module still load with the
  first page, and the first load has 1 KB left.
