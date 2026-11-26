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
import { ledgerAccounts } from './ledger-accounts.js';
import { receipts } from './receipts.js';
import { storefrontOrders } from './storefront-orders.js';
import { storefrontPayouts } from './storefront-payouts.js';
import { tenants } from './tenants.js';

// Step 28a: couriers (system design §14.6). The shop's courier accounts, the parcels its orders
// are sent in, and what the courier said about each parcel. Migration 0078 gives the three tables
// their rules. Step 28b: the courier's COD money (each account's two accounts, and what each
// parcel collected and its receipt); migration 0081 adds their rules. Step 28c: the payout that
// paid each parcel out, and each account's saved payout CSV map; migration 0083 adds their rules.

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
    // Step 28b. The money account the rider's cash goes into at Delivered ("Cash with
    // Steadfast", decision 2), and the expense account of the courier's charges (decision 3, used
    // by 28c's payout). NULL: none, so Delivered makes no receipt, as before 28b. Whether they
    // still fit (a posting account that holds money, an expense) is the API's check, because an
    // account can be archived after it was picked (27d's reason)
    codAccountId: uuid('cod_account_id'),
    chargeAccountId: uuid('charge_account_id'),
    // Step 28c (decision 11). Which columns of this courier's payout CSV hold what
    // (payoutCsvMapSchema), saved when a file matched with a map the member gave, so the next file
    // needs no mapping. The API parses it with that schema on every read, so an old shape becomes
    // "no map" rather than a crash. Saving it bumps no version: it is a convenience, not the
    // account's settings, and a member editing the account must not get a conflict for it (mine 21)
    payoutCsvMap: jsonb('payout_csv_map'),
  },
  (table) => [
    // The target of the parcels' foreign key (a constraint, for 0070's reason)
    unique('courier_accounts_tenant_id_key').on(table.tenantId, table.id),
    // Accounts of this workspace. No ON DELETE: an account is deleted for real only when nothing
    // uses it, and these two are used (27d's gateway)
    foreignKey({
      name: 'courier_accounts_cod_account_fk',
      columns: [table.tenantId, table.codAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'courier_accounts_charge_account_fk',
      columns: [table.tenantId, table.chargeAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // The charges in the COD account would post them against the money they come out of: its
    // balance would no longer be what the courier holds (27d's two accounts)
    check(
      'courier_accounts_money_accounts_check',
      sql`${table.codAccountId} IS NULL OR ${table.chargeAccountId} IS NULL
        OR ${table.codAccountId} <> ${table.chargeAccountId}`,
    ),
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
    // An object of four short names at most (the map's own limits are 100 characters a name). The
    // size cap keeps a bug from storing a whole file here
    check(
      'courier_accounts_payout_csv_map_check',
      sql`${table.payoutCsvMap} IS NULL OR (jsonb_typeof(${table.payoutCsvMap}) = 'object'
        AND octet_length(${table.payoutCsvMap}::text) <= 1024)`,
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
    // Step 28b (decision 5). What the rider collected (the courier's notice, or what the member
    // typed at Delivered), never more than cod_amount (mine 15), and the courier's charge for the
    // parcel as its notice said it (28c's payout uses it). NULL: not known yet
    collectedAmount: numeric('collected_amount', { precision: 19, scale: 4 }),
    courierCharge: numeric('courier_charge', { precision: 19, scale: 4 }),
    // The posted COD receipt Delivered made for this parcel (decision 4, mine 14), or why it
    // could not (an error code, like a payment try's receipt_error). Neither: none was due
    receiptId: uuid('receipt_id'),
    receiptError: text('receipt_error'),
    // Step 28c (decision 6). The posted payout that paid this parcel out, set when it is posted and
    // cleared when it is voided. One column, so a parcel is in one posted payout at most: two
    // payouts at once lock the row, and the second finds it taken. When it may be set or cleared is
    // 0083's guard
    payoutId: uuid('payout_id'),
  },
  (table) => [
    unique('storefront_shipments_tenant_id_key').on(table.tenantId, table.id),
    // Step 28c. The target of a payout line's foreign key: a line's parcel is one of its payout's
    // courier account
    unique('storefront_shipments_account_key').on(table.tenantId, table.courierAccountId, table.id),
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
    // Step 28b. One receipt, one parcel: a news handler that ran twice cannot link a second
    // parcel to the same money. No ON DELETE: a receipt is voided, never deleted
    uniqueIndex('storefront_shipments_receipt_idx')
      .on(table.tenantId, table.receiptId)
      .where(sql`${table.receiptId} IS NOT NULL`),
    foreignKey({
      name: 'storefront_shipments_receipt_fk',
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.id],
    }),
    // Step 28c: in place of 28b's storefront_shipments_cod_idx. What each courier account holds
    // (28b's decision 12: posted COD receipts no payout took) and the parcels a new payout can take
    // (a COD receipt, or a charge the courier said), per account. Partial: a parcel leaves it once
    // it is paid out, so it stays small however many parcels a shop has sent
    index('storefront_shipments_payable_idx')
      .on(table.tenantId, table.courierAccountId)
      .where(
        sql`${table.payoutId} IS NULL AND (${table.receiptId} IS NOT NULL OR ${table.courierCharge} IS NOT NULL)`,
      ),
    // A payout's parcels: the void clears them, and 0083's checks count them
    index('storefront_shipments_payout_idx')
      .on(table.tenantId, table.payoutId)
      .where(sql`${table.payoutId} IS NOT NULL`),
    // Its own courier account's payout only (storefront_payouts_account_key). No ON DELETE: a
    // payout is never deleted
    foreignKey({
      name: 'storefront_shipments_payout_fk',
      columns: [table.tenantId, table.courierAccountId, table.payoutId],
      foreignColumns: [
        storefrontPayouts.tenantId,
        storefrontPayouts.courierAccountId,
        storefrontPayouts.id,
      ],
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
    // Step 28b. The rider's money to the paisa, and never more than the courier was told to
    // collect (mine 15). A receipt is for what was collected, so it needs more than zero (zero
    // makes none; coalesce, because NULL > 0 is NULL and a check passes on NULL); the receipt and its error are never both. A parcel the courier has not taken
    // yet has none of them. When a receipt may be linked, and that it is this parcel's money, is
    // 0081's guard: a check cannot read the receipt
    check(
      'storefront_shipments_cod_check',
      sql`(${table.collectedAmount} IS NULL OR (${table.collectedAmount} >= 0
          AND ${table.collectedAmount} = round(${table.collectedAmount}, 2)
          AND ${table.collectedAmount} <= ${table.codAmount}))
        AND (${table.courierCharge} IS NULL OR (${table.courierCharge} >= 0
          AND ${table.courierCharge} = round(${table.courierCharge}, 2)))
        AND (${table.receiptId} IS NULL OR coalesce(${table.collectedAmount}, 0) > 0)
        AND num_nonnulls(${table.receiptId}, ${table.receiptError}) <= 1
        AND (${table.receiptError} IS NULL OR ${table.receiptError} ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (${table.status} NOT IN ('booking', 'booking_failed')
          OR num_nonnulls(${table.collectedAmount}, ${table.courierCharge}, ${table.receiptId}, ${table.receiptError}) = 0)`,
    ),
  ],
);

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
