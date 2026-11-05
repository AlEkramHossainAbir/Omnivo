import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  formatReturnNumber,
  isWithinReturnWindow,
  lastReturnDayOf,
  posReturnAmounts,
  posReturnInputSchema,
  posSaleNumberParamsSchema,
  refundMethodsOf,
  returnableQuantityOf,
} from './pos-returns.js';

const REGISTER = '0192f1f0-0000-7000-8000-000000000001';
const SHIFT = '0192f1f0-0000-7000-8000-000000000002';
const SALE = '0192f1f0-0000-7000-8000-000000000003';
const SHIRT_LINE = '0192f1f0-0000-7000-8000-000000000004';
const PHONE_LINE = '0192f1f0-0000-7000-8000-000000000005';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('return numbers', () => {
  it("puts an R between the register's code and 6 digits, and grows past them", () => {
    expect(formatReturnNumber('POS1', 12)).toBe('POS1-R000012');
    expect(formatReturnNumber('CTG2', 1234567)).toBe('CTG2-R1234567');
  });
});

describe('the return window', () => {
  // Sold on Friday 23 October; the counter takes goods back for 7 days
  it('takes goods back up to the last day, and not the day after', () => {
    expect(lastReturnDayOf('2026-10-23', 7)).toBe('2026-10-30');
    expect(isWithinReturnWindow('2026-10-23', '2026-10-30', 7)).toBe(true);
    expect(isWithinReturnWindow('2026-10-23', '2026-10-31', 7)).toBe(false);
  });

  it('reads 0 days as the same day only, also across the end of a month', () => {
    expect(isWithinReturnWindow('2026-10-31', '2026-10-31', 0)).toBe(true);
    expect(isWithinReturnWindow('2026-10-31', '2026-11-01', 0)).toBe(false);
  });
});

describe('the money of a return', () => {
  // Three polo shirts at ৳100 each before VAT, ৳15 VAT on the line
  const shirts = { quantity: '3.0000', net: '100.0000', vat: '15.0000' };

  it('gives back each piece of a line so that the pieces add up to the line', () => {
    const first = posReturnAmounts({ ...shirts, returnedQuantity: '0.0000' }, '1');
    const second = posReturnAmounts({ ...shirts, returnedQuantity: '1.0000' }, '1');
    const third = posReturnAmounts({ ...shirts, returnedQuantity: '2.0000' }, '1');
    expect([first.net, second.net, third.net]).toEqual(['33.3300', '33.3400', '33.3300']);
    expect([first.vat, second.vat, third.vat]).toEqual(['5.0000', '5.0000', '5.0000']);
    expect(first.total).toBe('38.3300');
  });

  it('gives back one shirt of two at the price it was sold for, to the paisa', () => {
    // 2 × ৳420 with VAT: net 730.43 and VAT 109.57, each rounded on its own at the sale
    const pair = { quantity: '2.0000', net: '730.4300', vat: '109.5700' };
    const first = posReturnAmounts({ ...pair, returnedQuantity: '0' }, '1');
    const second = posReturnAmounts({ ...pair, returnedQuantity: '1' }, '1');
    expect(first).toEqual({ net: '365.2100', vat: '54.7900', total: '420.0000' });
    expect(second).toEqual({ net: '365.2200', vat: '54.7800', total: '420.0000' });
  });

  it('gives back a whole line as it was sold, without rounding it', () => {
    const line = { quantity: '2.0000', net: '1234.5678', vat: '185.1852', returnedQuantity: '0' };
    expect(posReturnAmounts(line, '2')).toEqual({
      net: '1234.5678',
      vat: '185.1852',
      total: '1419.7530',
    });
  });

  it('leaves what was not returned yet, and never less than nothing', () => {
    expect(returnableQuantityOf({ quantity: '10.0000', returnedQuantity: '3.0000' })).toBe(
      '7.0000',
    );
    // Two counters took back the same strips while one was offline
    expect(returnableQuantityOf({ quantity: '10.0000', returnedQuantity: '12.0000' })).toBe(
      '0.0000',
    );
  });

  it('pays back by cash, or by a way the sale was paid, never by its exchange', () => {
    const sale = {
      payments: [
        { method: 'exchange' as const, amount: '1200.0000' },
        { method: 'bkash' as const, amount: '500.0000' },
      ],
    };
    expect(refundMethodsOf(sale)).toEqual(['cash', 'bkash']);
  });
});

describe('return input', () => {
  // A customer brings back one of two shirts (৳736 with VAT) and a phone with its IMEI
  function input(extra: object = {}) {
    return {
      registerId: REGISTER,
      sequence: 12,
      shiftId: SHIFT,
      date: '2026-10-28',
      returnedAt: '2026-10-28T10:42:00.000Z',
      saleId: SALE,
      lines: [
        {
          saleLineId: SHIRT_LINE,
          quantity: '1',
          net: '640.0000',
          vat: '96.0000',
          serialNumbers: [],
        },
      ],
      refunds: [{ method: 'cash', amount: '736', reference: '' }],
      note: ' Wrong size ',
      ...extra,
    };
  }

  it('pays the whole total back, split if need be', () => {
    const parsed = posReturnInputSchema.parse(input());
    expect(parsed.note).toBe('Wrong size');
    const split = [
      { method: 'exchange', amount: '500', reference: '' },
      { method: 'cash', amount: '236', reference: '' },
    ];
    expect(posReturnInputSchema.safeParse(input({ refunds: split })).success).toBe(true);
  });

  it('refuses refunds that do not add up to the total, and a second exchange', () => {
    const short = posReturnInputSchema.safeParse(
      input({ refunds: [{ method: 'cash', amount: '700', reference: '' }] }),
    );
    expect(errorsOf(short)).toEqual({ refunds: 'pos_refund_mismatch' });
    const twice = [
      { method: 'exchange', amount: '368', reference: '' },
      { method: 'exchange', amount: '368', reference: '' },
    ];
    expect(errorsOf(posReturnInputSchema.safeParse(input({ refunds: twice })))).toEqual({
      refunds: 'pos_exchange_invalid',
    });
  });

  it('needs a line, each line of the sale once, and an amount in each refund box', () => {
    const none = posReturnInputSchema.safeParse(input({ lines: [] }), { error: contractErrorMap });
    expect(errorsOf(none)).toEqual({ lines: 'pos_return_lines_required' });
    const [shirt] = input().lines;
    const twice = posReturnInputSchema.safeParse(
      input({
        lines: [shirt, shirt],
        refunds: [{ method: 'cash', amount: '1472', reference: '' }],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.saleLineId': 'pos_return_line_twice' });
    const empty = posReturnInputSchema.safeParse(
      input({ refunds: [{ method: 'cash', amount: '', reference: '' }] }),
      { error: contractErrorMap },
    );
    expect(errorsOf(empty)).toEqual({ 'refunds.0.amount': 'pos_refund_amount_required' });
  });

  it('takes back a free sample with no refund at all', () => {
    const free = { saleLineId: SHIRT_LINE, quantity: '1', net: '0', vat: '0', serialNumbers: [] };
    expect(posReturnInputSchema.safeParse(input({ lines: [free], refunds: [] })).success).toBe(
      true,
    );
  });

  it('refuses a serial number ticked on two lines', () => {
    const phone = {
      saleLineId: PHONE_LINE,
      quantity: '1',
      net: '0',
      vat: '0',
      serialNumbers: ['356938035643809'],
    };
    const lines = [phone, { ...phone, saleLineId: SHIRT_LINE }];
    const result = posReturnInputSchema.safeParse(input({ lines, refunds: [] }));
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('finds a receipt typed in small letters', () => {
    expect(posSaleNumberParamsSchema.parse({ number: ' pos1-000123 ' }).number).toBe('POS1-000123');
  });
});
