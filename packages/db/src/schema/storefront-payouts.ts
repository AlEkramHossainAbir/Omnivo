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
