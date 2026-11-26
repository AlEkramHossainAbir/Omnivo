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
