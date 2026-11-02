import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  cashCountSchema,
  cashDifferenceOf,
  cashNotesTotal,
  expectedCashOf,
  formatShiftNumber,
  isOverVarianceAlert,
  posCashMovementInputSchema,
  posCashReasonInputSchema,
  posShiftCloseInputSchema,
  shiftNetOf,
  tenderAmountsOf,
  updatePosCashReasonInputSchema,
} from './pos-shifts.js';

const SHIFT = '0192f1e0-0000-7000-8000-000000000001';
const BANK = '0192f1e0-0000-7000-8000-000000000002';
const REASON = '0192f1e0-0000-7000-8000-000000000003';
const AT = '2026-10-28T15:30:00.000Z';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

// The drawer of the front counter at a super shop in Chattogram, at the end of a Thursday
const notes = {
  '1000': 4,
  '500': 5,
  '200': 0,
  '100': 12,
  '50': 3,
  '20': 6,
  '10': 9,
  '5': 2,
  '2': 0,
  '1': 0,
};

describe('shift numbers', () => {
  it("puts the register's code and an S before 4 digits, and grows past them", () => {
    expect(formatShiftNumber('POS1', 42)).toBe('POS1-S0042');
    expect(formatShiftNumber('CTG2', 12345)).toBe('CTG2-S12345');
  });
});

describe('the count', () => {
  it('adds the notes up', () => {
    // 4,000 + 2,500 + 1,200 + 150 + 120 + 90 + 10
    expect(cashNotesTotal(notes)).toBe('8070.0000');
  });

  it('takes notes with their total, or a total alone', () => {
    expect(cashCountSchema.parse({ notes, total: '8070' }).notes).toEqual(notes);
    expect(cashCountSchema.parse({ notes: null, total: ' 2350.50 ' }).total).toBe('2350.50');
    expect(cashCountSchema.parse({ notes: null, total: '0' }).total).toBe('0');
  });

  it('refuses a total that is not what the notes add up to, an empty box and a tenth of a paisa', () => {
    const parse = (count: object) => cashCountSchema.safeParse(count, { error: contractErrorMap });
    expect(errorsOf(parse({ notes, total: '8000' }))).toEqual({
      total: 'pos_count_total_mismatch',
    });
    expect(errorsOf(parse({ notes: null, total: '' }))).toEqual({ total: 'pos_count_required' });
    expect(errorsOf(parse({ notes: null, total: '12.345' }))).toEqual({ total: 'money_format' });
  });

  it('refuses a note count that is not a whole number', () => {
    const result = cashCountSchema.safeParse({ notes: { ...notes, '500': 2.5 }, total: '6820' });
    expect(Object.keys(errorsOf(result))).toEqual(['notes.500']);
  });
});

describe('the cash of a shift', () => {
  // A ৳5,000 float; ৳12,480 in cash from the sales and ৳1,320 given back; ৳2,000 of change from the
  // bank put in; ৳10,000 sent to the bank
  const cash = {
    opening: '5000',
    cashTaken: '12480',
    changeGiven: '1320',
    paidIn: '2000',
    paidOut: '10000',
    cashRefunded: '0',
  };

  it('expects the opening, plus what came in, less what went out', () => {
    expect(expectedCashOf(cash)).toBe('8160.0000');
  });

  it('takes the cash the returns paid back off too', () => {
    expect(expectedCashOf({ ...cash, cashRefunded: '736.50' })).toBe('7423.5000');
  });

  it('is short when less was counted, and rings the bell only above the limit', () => {
    const short = cashDifferenceOf('7640', expectedCashOf(cash));
    expect(short).toBe('-520.0000');
    expect(isOverVarianceAlert(short, '500')).toBe(true);
    expect(isOverVarianceAlert('-500.0000', '500')).toBe(false);
    expect(isOverVarianceAlert('0.5000', '0')).toBe(true);
    expect(isOverVarianceAlert('0.0000', '0')).toBe(false);
  });
});

describe('the X and Z reports', () => {
  it("lists each tender's amount once, in the tenders' order, and leaves out nothing taken", () => {
    const taken = tenderAmountsOf([
      { method: 'bkash', amount: '2300' },
      { method: 'cash', amount: '12480' },
      { method: 'exchange', amount: '1200' },
      { method: 'bkash', amount: '450.50' },
      { method: 'card', amount: '0.0000' },
    ]);
    expect(taken).toEqual([
      { method: 'cash', amount: '12480.0000' },
      { method: 'bkash', amount: '2750.5000' },
      { method: 'exchange', amount: '1200.0000' },
    ]);
  });

  it('nets the returns off the sales', () => {
    expect(shiftNetOf({ salesTotal: '58420.50', returnsTotal: '1936.50' })).toBe('56484.0000');
  });
});

describe('reasons', () => {
  it('keeps the direction on a new reason, and drops it from a change', () => {
    const input = posCashReasonInputSchema.parse({
      name: ' Bank deposit ',
      direction: 'out',
      accountId: BANK,
    });
    expect(input).toEqual({ name: 'Bank deposit', direction: 'out', accountId: BANK });
    const update = updatePosCashReasonInputSchema.parse({ ...input, direction: 'in', version: 2 });
    expect(update).not.toHaveProperty('direction');
  });

  it('refuses a short name and no account, each with its code', () => {
    const result = posCashReasonInputSchema.safeParse(
      { name: 'B', direction: 'in', accountId: '' },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      name: 'pos_reason_name_required',
      accountId: 'pos_reason_account_invalid',
    });
  });
});

describe("the cashier's forms", () => {
  it('asks for a reason and an amount above zero', () => {
    const result = posCashMovementInputSchema.safeParse(
      { shiftId: SHIFT, reasonId: '', amount: '0', note: '', date: '2026-10-28', movedAt: AT },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      reasonId: 'pos_reason_required',
      amount: 'pos_cash_amount_required',
    });
  });

  it('keeps the note of a pay out', () => {
    const input = posCashMovementInputSchema.parse({
      shiftId: SHIFT,
      reasonId: REASON,
      amount: '10000',
      note: 'Deposit slip 0042, DBBL Agrabad',
      date: '2026-10-28',
      movedAt: AT,
    });
    expect(input.note).toBe('Deposit slip 0042, DBBL Agrabad');
  });

  it('drops at most 20 held carts at the close', () => {
    const close = {
      date: '2026-10-28',
      closedAt: AT,
      counted: { notes, total: '8070' },
      deviceExpected: '8160.0000',
      heldDropped: 21,
    };
    expect(Object.keys(errorsOf(posShiftCloseInputSchema.safeParse(close)))).toEqual([
      'heldDropped',
    ]);
    expect(posShiftCloseInputSchema.parse({ ...close, heldDropped: 2 }).counted.total).toBe('8070');
  });
});
