import { cashCountSchema, type PosShift } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  boxesTotal,
  countValues,
  differenceKind,
  EMPTY_NOTES,
  leftOpen,
  noteAmount,
  noteDigits,
  zReportOf,
} from './pos-shift';

describe('the count', () => {
  it('keeps whole ASCII digits in a note box, from a Bangla keyboard too', () => {
    expect(noteDigits('১২')).toBe('12');
    expect(noteDigits('4.5')).toBe('45');
    expect(noteDigits('-3')).toBe('3');
    expect(noteDigits('1234567')).toBe('12345');
  });

  it('sends the notes with their own total, which the schema accepts', () => {
    const boxes = { ...EMPTY_NOTES, '1000': '4', '500': '2', '10': '' };
    const values = countValues('notes', boxes, '999');
    expect(values.total).toBe('5000.00');
    expect(values.notes?.['1000']).toBe(4);
    expect(values.notes?.['10']).toBe(0);
    expect(cashCountSchema.safeParse(values).success).toBe(true);
    expect(boxesTotal(boxes)).toBe('5000.00');
    expect(noteAmount('500', '2')).toBe('1000.0000');
  });

  it('sends a total alone as it is typed; an empty one is refused', () => {
    expect(countValues('total', { ...EMPTY_NOTES, '1000': '4' }, '7640.50')).toEqual({
      notes: null,
      total: '7640.50',
    });
    const empty = cashCountSchema.safeParse(countValues('total', EMPTY_NOTES, ''));
    expect(empty.error?.issues[0]?.message).toBe('pos_count_required');
    // An empty drawer is a count
    expect(cashCountSchema.safeParse(countValues('notes', EMPTY_NOTES, '')).success).toBe(true);
  });
});

describe('the result', () => {
  it('reads a difference as even, over or short', () => {
    expect(differenceKind('0.0000')).toBe('even');
    expect(differenceKind('120.0000')).toBe('over');
    expect(differenceKind('-50.0000')).toBe('short');
  });

  it('finds a shift left open since an earlier day', () => {
    expect(leftOpen('2026-10-28', '2026-10-29')).toBe(true);
    expect(leftOpen('2026-10-29', '2026-10-29')).toBe(false);
  });
});

// A closed shift as the shift's page has it: two sales by cash and bKash, one return paid back in
// cash and one used on an exchange (step 20c)
const closed: PosShift = {
  id: '0195f0a0-0000-7000-8000-000000000001',
  number: 'POS1-S0042',
  register: { id: '0195f0a0-0000-7000-8000-000000000002', code: 'POS1', name: 'Front counter' },
  branchId: '0195f0a0-0000-7000-8000-000000000003',
  sequence: 42,
  status: 'closed',
  cashier: { id: '0195f0a0-0000-7000-8000-000000000004', fullName: 'Sumi Akter' },
  device: { id: '0195f0a0-0000-7000-8000-000000000005', name: 'Front counter PC' },
  openedAt: '2026-09-23T03:02:00.000Z',
  closedAt: '2026-09-23T13:10:00.000Z',
  openingCash: '2000.0000',
  expectedCash: '3420.0000',
  countedCash: '3400.0000',
  difference: '-20.0000',
  saleCount: 2,
  salesTotal: '2300.0000',
  returnCount: 2,
  returnsTotal: '1260.0000',
  opening: {
    count: { notes: null, total: '2000.00' },
    date: '2026-09-23',
    comparedWith: '2000.0000',
    difference: '0.0000',
    floatReason: null,
    entry: null,
  },
  closing: {
    count: { notes: null, total: '3400.00' },
    date: '2026-09-23',
    deviceExpected: '3420.0000',
    heldDropped: 0,
    entry: null,
  },
  closedBy: null,
  cash: {
    opening: '2000.0000',
    cashTaken: '2000.0000',
    changeGiven: '160.0000',
    paidIn: '0.0000',
    paidOut: '0.0000',
    cashRefunded: '420.0000',
  },
  payments: [
    { method: 'cash', amount: '1840.0000' },
    { method: 'card', amount: '0.0000' },
    { method: 'bkash', amount: '460.0000' },
  ],
  refunds: [
    { method: 'cash', amount: '420.0000' },
    { method: 'card', amount: '0.0000' },
    { method: 'exchange', amount: '840.0000' },
  ],
  salesDiscount: '115.0000',
  salesVat: '300.0000',
  returnsVat: '164.3500',
  movements: [],
};

describe('the Z report of a shift page', () => {
  it('has the server sums, only the tenders used, and the drawer of the count', () => {
    const report = zReportOf(closed, '2026-09-24T04:00:00.000Z');
    expect(report.kind).toBe('z');
    expect(report.shiftNumber).toBe('POS1-S0042');
    expect(report.closedAt).toBe(closed.closedAt);
    expect(report.taken).toEqual([
      { method: 'cash', amount: '1840.0000' },
      { method: 'bkash', amount: '460.0000' },
    ]);
    expect(report.refunded).toEqual([
      { method: 'cash', amount: '420.0000' },
      { method: 'exchange', amount: '840.0000' },
    ]);
    expect(report.drawer).toEqual({
      ...closed.cash,
      expected: '3420.0000',
      counted: '3400.0000',
      difference: '-20.0000',
    });
  });

  it('has no drawer for a shift closed without a count', () => {
    const report = zReportOf(
      {
        ...closed,
        status: 'closed_without_count',
        countedCash: null,
        difference: null,
        closing: null,
      },
      '2026-09-24T04:00:00.000Z',
    );
    expect(report.drawer).toBeNull();
  });
});
