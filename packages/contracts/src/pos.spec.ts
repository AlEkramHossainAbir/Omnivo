import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  formatPosNumber,
  posChangeOf,
  posOverridesOf,
  posRegisterInputSchema,
  posSaleAmounts,
  posSaleInputSchema,
  registerMethods,
  updatePosRegisterInputSchema,
} from './pos.js';
import { lineAmounts } from './sales.js';

const WAREHOUSE = '0192f1d0-0000-7000-8000-000000000001';
const CASH = '0192f1d0-0000-7000-8000-000000000002';
const BKASH = '0192f1d0-0000-7000-8000-000000000003';
const REGISTER = '0192f1d0-0000-7000-8000-000000000004';
const VARIANT = '0192f1d0-0000-7000-8000-000000000005';
const UNIT = '0192f1d0-0000-7000-8000-000000000006';
const RATE = '0192f1d0-0000-7000-8000-000000000007';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('receipt numbers', () => {
  it("puts the register's code before 6 digits, and grows past them", () => {
    expect(formatPosNumber('POS1', 123)).toBe('POS1-000123');
    expect(formatPosNumber('CTG2', 1234567)).toBe('CTG2-1234567');
  });
});

describe('register input', () => {
  // The front counter of a pharmacy in Dhanmondi: cash and bKash, no card machine
  const counter = {
    code: ' pos1 ',
    name: 'Front counter',
    warehouseId: WAREHOUSE,
    accounts: { cash: CASH, card: '', bkash: BKASH, nagad: '' },
    maxDiscountPercent: '',
    paperWidth: '80',
    receiptFooter: '',
  };

  it('upper-cases the code, and reads the empty boxes as nothing', () => {
    const input = posRegisterInputSchema.parse(counter);
    expect(input.code).toBe('POS1');
    expect(input.accounts).toEqual({ cash: CASH, card: null, bkash: BKASH, nagad: null });
    expect(input.maxDiscountPercent).toBe('0');
    expect(input.receiptFooter).toBeNull();
    expect(registerMethods({ ...input.accounts, cash: CASH })).toEqual(['cash', 'bkash']);
  });

  it('refuses a hyphen in the code, no cash account and a limit over 100%, each with its code', () => {
    const result = posRegisterInputSchema.safeParse(
      {
        ...counter,
        code: 'POS-1',
        accounts: { ...counter.accounts, cash: '' },
        maxDiscountPercent: '100.5',
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      code: 'pos_register_code_format',
      'accounts.cash': 'pos_register_cash_required',
      maxDiscountPercent: 'pos_discount_limit_format',
    });
  });

  it('never changes the code once the register exists', () => {
    const update = updatePosRegisterInputSchema.parse({ ...counter, code: 'POS9', version: 2 });
    expect(update).not.toHaveProperty('code');
  });
});

describe('sale amounts', () => {
  const line = (extra: object) => ({
    quantity: '1',
    unitPrice: '100',
    discountType: 'percent' as const,
    discount: '0',
    rate: '15.00',
    ...extra,
  });

  it('works a line out like any sales line when the bill has no discount', () => {
    const one = line({ quantity: '3', unitPrice: '1200.50', discount: '10' });
    const { lines } = posSaleAmounts([one], { type: 'percent', value: '0' }, false);
    expect(lines[0]).toEqual({ ...lineAmounts(one, false), billDiscount: '0.0000' });
  });

  it("shares the bill's discount by what each line is after its own, then adds the VAT", () => {
    const { lines, totals } = posSaleAmounts(
      [line({ quantity: '2', unitPrice: '500', discount: '10' }), line({ unitPrice: '300' })],
      { type: 'percent', value: '5' },
      false,
    );
    // 5% of 900 + 300: ৳45 and ৳15
    expect(lines.map((amounts) => [amounts.billDiscount, amounts.net, amounts.vat])).toEqual([
      ['45.0000', '855.0000', '128.2500'],
      ['15.0000', '285.0000', '42.7500'],
    ]);
    expect(totals).toEqual({
      discount: '100.0000',
      billDiscount: '60.0000',
      net: '1140.0000',
      vat: '171.0000',
      total: '1311.0000',
    });
  });

  it('gives the paisa left over to the biggest line, never to a free one', () => {
    const { lines, totals } = posSaleAmounts(
      [line({}), line({}), line({}), line({ unitPrice: '0' })],
      { type: 'amount', value: '10' },
      false,
    );
    expect(lines.map((amounts) => amounts.billDiscount)).toEqual([
      '3.3400',
      '3.3300',
      '3.3300',
      '0.0000',
    ]);
    expect(totals.billDiscount).toBe('10.0000');
  });

  it('takes the VAT out of what was paid when prices include it', () => {
    const { lines } = posSaleAmounts(
      [line({ unitPrice: '115' })],
      { type: 'amount', value: '11.50' },
      true,
    );
    expect(lines[0]).toMatchObject({ net: '90.0000', vat: '13.5000', total: '103.5000' });
  });
});

describe('change and overrides', () => {
  it('gives back what was paid over the total, and never less than nothing', () => {
    const payments = [
      { method: 'bkash' as const, amount: '1000' },
      { method: 'cash' as const, amount: '1000' },
    ];
    expect(posChangeOf(payments, '1700.0000')).toBe('300.0000');
    expect(posChangeOf(payments, '2500.0000')).toBe('0.0000');
  });

  it('lists a changed price and every discount over the limit, but not a price typed from none', () => {
    const sale = {
      lines: [
        // ৳120 on the shelf, sold for ৳110
        {
          quantity: '1',
          unitPrice: '110',
          discountType: 'percent' as const,
          discount: '0',
          startingPrice: '120',
        },
        // No price anywhere, so the cashier typed ৳50; 15% off is over the 10% limit
        {
          quantity: '1',
          unitPrice: '50',
          discountType: 'percent' as const,
          discount: '15',
          startingPrice: null,
        },
        // ৳20 off ৳200 is exactly 10%: not over
        {
          quantity: '1',
          unitPrice: '200',
          discountType: 'amount' as const,
          discount: '20',
          startingPrice: '200',
        },
      ],
      // ৳40 off ৳332.50 is over 10% (৳33.25)
      billDiscountType: 'amount' as const,
      billDiscount: '40',
    };
    expect(posOverridesOf(sale, '10')).toEqual([
      { kind: 'price', line: 0 },
      { kind: 'discount', line: 1 },
      { kind: 'bill_discount' },
    ]);
    expect(posOverridesOf({ ...sale, lines: [], billDiscount: '0' }, '10')).toEqual([]);
  });
});

describe('sale input', () => {
  // Two bottles of soybean oil at a super shop in Chattogram, ৳850 each with VAT
  function sale(extra: object = {}) {
    return {
      registerId: REGISTER,
      sequence: 123,
      date: '2026-10-27',
      soldAt: '2026-10-27T11:42:10.000Z',
      customerId: '',
      pricesIncludeVat: true,
      lines: [
        {
          variantId: VARIANT,
          unitId: UNIT,
          quantity: '2',
          description: '',
          unitPrice: '850',
          discountType: 'percent',
          discount: '',
          taxRateId: RATE,
          rate: '15.00',
          startingPrice: '850.0000',
          batchId: '',
          serialNumbers: [],
        },
      ],
      billDiscountType: 'percent',
      billDiscount: '',
      payments: [{ method: 'cash', amount: '2000', reference: '' }],
      ...extra,
    };
  }

  it('sells to a walk-in customer, and gives the change in cash', () => {
    const input = posSaleInputSchema.parse(sale());
    expect(input.customerId).toBeNull();
    expect(input.billDiscount).toBe('0');
    expect(posChangeOf(input.payments, '1700.0000')).toBe('300.0000');
  });

  it('takes a split payment: part by bKash, the rest in cash', () => {
    const payments = [
      { method: 'bkash', amount: '1000', reference: 'BK7XQ2M4' },
      { method: 'cash', amount: '1000', reference: '' },
    ];
    expect(posSaleInputSchema.safeParse(sale({ payments })).success).toBe(true);
  });

  it('needs the whole amount, and change only from cash', () => {
    const short = posSaleInputSchema.safeParse(
      sale({ payments: [{ method: 'cash', amount: '1500', reference: '' }] }),
    );
    expect(errorsOf(short)).toEqual({ payments: 'pos_payment_short' });
    const card = posSaleInputSchema.safeParse(
      sale({ payments: [{ method: 'card', amount: '2000', reference: '4417' }] }),
    );
    expect(errorsOf(card)).toEqual({ payments: 'pos_change_not_cash' });
    const none = posSaleInputSchema.safeParse(sale({ payments: [] }), {
      error: contractErrorMap,
    });
    expect(errorsOf(none)).toEqual({ payments: 'pos_payments_required' });
  });

  it('never takes more off the bill than the bill', () => {
    const result = posSaleInputSchema.safeParse(
      sale({ billDiscountType: 'amount', billDiscount: '1800' }),
    );
    expect(errorsOf(result)).toEqual({ billDiscount: 'sales_discount_too_large' });
  });

  it("checks the device's rate, and a serial number scanned on two lines", () => {
    const [first] = sale().lines;
    const phone = { ...first, quantity: '1', serialNumbers: ['356938035643809'] };
    const twice = posSaleInputSchema.safeParse(sale({ lines: [phone, phone] }));
    expect(errorsOf(twice)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
    const rate = posSaleInputSchema.safeParse(sale({ lines: [{ ...first, rate: '15%' }] }));
    expect(errorsOf(rate)).toEqual({ 'lines.0.rate': 'tax_rate_format' });
  });
});
