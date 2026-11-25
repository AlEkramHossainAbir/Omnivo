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
