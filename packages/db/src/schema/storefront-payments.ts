import {
  PAYMENT_GATEWAY_MODES,
  PAYMENT_GATEWAY_PROVIDERS,
  PAYMENT_GATEWAY_TEST_PROBLEMS,
  SHOP_PAYMENT_STATUSES,
  SHOP_PAYMENT_TRIES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
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
import { tenants } from './tenants.js';

// Step 27d: online payment. The shop's own gateway account, and one row for every visit a shopper
// makes to the gateway's page. The money goes to the tenant's SSLCommerz account; Omnivo keeps the
// keys and makes the calls (system design §14). Migration 0076 gives both tables their rules.

// Raw bytes, as in sync.ts: drizzle 0.45 has no bytea column, and the postgres driver reads and
// writes one as a Buffer
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// A list from the contracts as SQL ('started', 'not_opened', …). Written by code only, never by a
// person, so sql.raw is safe here
function sqlList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '));
}

// AES-256-GCM's nonce and tag are 12 and 16 bytes; the password is at most 128 characters
// (createStorefrontPaymentGatewayInputSchema), at most 512 bytes in UTF-8
const SEALED_MIN_BYTES = 12 + 16 + 1;
const SEALED_MAX_BYTES = 12 + 16 + 512;

// The workspace's gateway account (decision 4). One row per workspace, so the tenant's id is the
// key: the Payment card has nothing to pick between, and the audit log names it by the tenant's id
// (27d.1). Only omnivo_app reads it (0076 grants the shop's roles nothing): the shop's server never
// holds the password, not even encrypted
export const storefrontPaymentGateways = pgTable(
  'storefront_payment_gateways',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    provider: text('provider', { enum: PAYMENT_GATEWAY_PROVIDERS }).notNull(),
    storeId: text('store_id').notNull(),
    mode: text('mode', { enum: PAYMENT_GATEWAY_MODES }).notNull(),
    // The store password, sealed by the API with AES-256-GCM under CREDENTIALS_KEY: the nonce, the
    // tag and the ciphertext in one value (27d.3). The database never sees the password or the key,
    // so a leaked dump or backup gives neither
    passwordSealed: bytea('password_sealed').notNull(),
    // Which CREDENTIALS_KEY sealed it. A new key gets the next number; the API opens a row with
    // the key of its number, so the keys can be changed one row at a time
    keyVersion: smallint('key_version').notNull(),
    // Where a paid order's money receipt goes, and where the gateway's fee is posted (decision 6).
    // Whether they still fit (not archived, holds money, an expense) is storefront_online_ready()
    // in 0076, because an account can be archived after the gateway was saved
    moneyAccountId: uuid('money_account_id').notNull(),
    feeAccountId: uuid('fee_account_id').notNull(),
    // The last "Test connection": when, and what went wrong (NULL: it worked). Both NULL: never
    // tested. Saving new values empties both (27d.1's lastTest)
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestProblem: text('last_test_problem', { enum: PAYMENT_GATEWAY_TEST_PROBLEMS }),
  },
  (table) => [
    // Accounts of this workspace. No ON DELETE: an account is deleted for real only when nothing
    // uses it, and the gateway uses these two
    foreignKey({
      name: 'storefront_payment_gateways_money_account_fk',
      columns: [table.tenantId, table.moneyAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    foreignKey({
      name: 'storefront_payment_gateways_fee_account_fk',
      columns: [table.tenantId, table.feeAccountId],
      foreignColumns: [ledgerAccounts.tenantId, ledgerAccounts.id],
    }),
    // drizzle's enum is a TypeScript type only. Here the database says it too: the mode picks the
    // gateway's address, so an unknown one must not be saved (mine 23)
    check(
      'storefront_payment_gateways_values_check',
      sql`${table.provider} IN (${sqlList(PAYMENT_GATEWAY_PROVIDERS)})
        AND ${table.mode} IN (${sqlList(PAYMENT_GATEWAY_MODES)})
        AND (${table.lastTestProblem} IS NULL OR ${table.lastTestProblem} IN (${sqlList(PAYMENT_GATEWAY_TEST_PROBLEMS)}))`,
    ),
    // The form's store id rule (27d.1), after its trim
    check(
      'storefront_payment_gateways_store_id_check',
      sql`${table.storeId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
    // Something the API sealed: at least a nonce, a tag and one byte. A row with an empty value
    // would look saved and never work
    check(
      'storefront_payment_gateways_sealed_check',
      sql`octet_length(${table.passwordSealed}) BETWEEN ${sql.raw(String(SEALED_MIN_BYTES))} AND ${sql.raw(String(SEALED_MAX_BYTES))}
        AND ${table.keyVersion} >= 1`,
    ),
    // The money and its fee in one account would post the fee against itself: the money account's
    // balance would no longer be what SSLCommerz owes
    check(
      'storefront_payment_gateways_accounts_check',
      sql`${table.moneyAccountId} <> ${table.feeAccountId}`,
    ),
    check(
      'storefront_payment_gateways_test_check',
      sql`${table.lastTestProblem} IS NULL OR ${table.lastTestedAt} IS NOT NULL`,
    ),
  ],
);

// One payment try (decision 1): placing an online order makes the first, "Try again" the next,
// at most SHOP_PAYMENT_TRIES per order. The shop's server writes it as omnivo_shop (the try and
// the gateway's answer); the worker adds the money receipt as omnivo_app. A paid try is never
// deleted and its answer never changes (0076's guard): it is the record that money came
export const storefrontPayments = pgTable(
  'storefront_payments',
  {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    // 1 to SHOP_PAYMENT_TRIES, in the order the tries were made. With the unique key below it is
    // the database's count of an order's tries (mine 21)
    tryNo: smallint('try_no').notNull(),
    // Our id for the try, sent to the gateway as tran_id (shopPaymentTranIdSchema)
    tranId: text('tran_id').notNull(),
    // The gateway and the mode the try was started with. The answer is asked at the same address
    // (sandbox or live), even if the tenant switches the mode while the shopper is paying (mine 20)
    provider: text('provider', { enum: PAYMENT_GATEWAY_PROVIDERS }).notNull(),
    mode: text('mode', { enum: PAYMENT_GATEWAY_MODES }).notNull(),
    status: text('status', { enum: SHOP_PAYMENT_STATUSES }).notNull().default('started'),
    // The order's total when the try started: what the gateway was asked to take, and what its
    // answer must say (decision 2)
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    // When the gateway's answer was recorded (paid, failed or cancelled)
    settledAt: timestamp('settled_at', { withTimezone: true }),
    // From the gateway's own answer, never from the post (27d.1's shopGatewayPostSchema), and only
    // on a paid try: the validation id, the way the shopper paid ("BKASH-BKash"), the bank's or
    // wallet's transaction number, and what the gateway pays out after its fee
    valId: text('val_id'),
    cardType: text('card_type'),
    bankTranId: text('bank_tran_id'),
    storeAmount: numeric('store_amount', { precision: 19, scale: 4 }),
    // The posted money receipt the worker made for a paid try (decision 6), or why it could not
    // (an error code, like an order's document_error). Neither while the worker has not run
    receiptId: uuid('receipt_id'),
    receiptError: text('receipt_error'),
  },
  (table) => [
    // An order's tries, oldest first (the order page's Payments card and /checkout/paid), and at
    // most one try of each number: two "Try again" at the same moment both ask for try 2, and the
    // second fails here. A constraint, so the API answers by its name
    unique('storefront_payments_try_key').on(table.tenantId, table.orderId, table.tryNo),
    // The gateway's calls name the try by its tran_id: settle looks it up here, in the workspace
    // the shop's host names. Random, so it never collides; unique all the same, so a bug that
    // gave two tries one id fails here instead of paying both with one payment
    uniqueIndex('storefront_payments_tran_id_idx').on(table.tenantId, table.tranId),
    // One validation is one payment: a val_id that paid one try cannot pay a second
    uniqueIndex('storefront_payments_val_id_idx')
      .on(table.tenantId, table.valId)
      .where(sql`${table.valId} IS NOT NULL`),
    // One receipt, one payment: a worker that ran twice cannot link a second payment's receipt
    uniqueIndex('storefront_payments_receipt_idx')
      .on(table.tenantId, table.receiptId)
      .where(sql`${table.receiptId} IS NOT NULL`),
    // A pending order's tries go with it (the sweep, five wrong codes after "Pay on delivery").
    // Never a paid one: 0076's guard refuses that delete, and so the order's delete too
    foreignKey({
      name: 'storefront_payments_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_payments_receipt_fk',
      columns: [table.tenantId, table.receiptId],
      foreignColumns: [receipts.tenantId, receipts.id],
    }),
    // The contracts' lists, for the gateway's reason above. The status most of all: the guard in
    // 0076 and the checks below read 'paid' and 'started', and a status nobody knows would pass
    // them all
    check(
      'storefront_payments_values_check',
      sql`${table.status} IN (${sqlList(SHOP_PAYMENT_STATUSES)})
        AND ${table.provider} IN (${sqlList(PAYMENT_GATEWAY_PROVIDERS)})
        AND ${table.mode} IN (${sqlList(PAYMENT_GATEWAY_MODES)})`,
    ),
    check(
      'storefront_payments_try_no_check',
      sql`${table.tryNo} BETWEEN 1 AND ${sql.raw(String(SHOP_PAYMENT_TRIES))}`,
    ),
    check('storefront_payments_tran_id_check', sql`${table.tranId} ~ '^[A-Z0-9]{20}$'`),
    // To the paisa, like every amount the books post: the API rounds the gateway's store_amount
    // before it writes it (27d.3). The fee (amount − store_amount) is then never below zero
    check(
      'storefront_payments_amounts_check',
      sql`${table.amount} > 0 AND ${table.amount} = round(${table.amount}, 2)
        AND (${table.storeAmount} IS NULL OR (${table.storeAmount} >= 0
          AND ${table.storeAmount} <= ${table.amount}
          AND ${table.storeAmount} = round(${table.storeAmount}, 2)))`,
    ),
    // Each status with its columns, exactly. Started and not_opened have no answer yet; failed and
    // cancelled have an answer and no money; paid has the validation and the payout. The receipt
    // and its error belong to a paid try, never both
    check(
      'storefront_payments_status_check',
      sql`(${table.status} IN ('started', 'not_opened')) = (${table.settledAt} IS NULL)
        AND (${table.status} = 'paid') = (${table.valId} IS NOT NULL AND ${table.storeAmount} IS NOT NULL)
        AND (${table.status} = 'paid' OR num_nonnulls(${table.valId}, ${table.storeAmount}, ${table.cardType}, ${table.bankTranId}, ${table.receiptId}, ${table.receiptError}) = 0)
        AND num_nonnulls(${table.receiptId}, ${table.receiptError}) <= 1`,
    ),
    // The gateway's words, short enough for a page: the API cuts a longer one before it writes
    // it (27d.3), so a payment is never left unrecorded for a long card name
    check(
      'storefront_payments_text_check',
      sql`(${table.valId} IS NULL OR char_length(${table.valId}) BETWEEN 1 AND 64)
        AND (${table.cardType} IS NULL OR char_length(${table.cardType}) BETWEEN 1 AND 100)
        AND (${table.bankTranId} IS NULL OR char_length(${table.bankTranId}) BETWEEN 1 AND 100)`,
    ),
    // An error code in snake_case, never a message, for storefront_orders_document_error_check's
    // reason
    check(
      'storefront_payments_receipt_error_check',
      sql`${table.receiptError} IS NULL OR ${table.receiptError} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  ],
);
