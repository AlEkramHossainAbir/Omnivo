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
