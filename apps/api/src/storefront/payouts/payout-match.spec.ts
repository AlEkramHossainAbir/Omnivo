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
