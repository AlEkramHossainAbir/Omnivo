import { posSaleInputSchema, type SyncStock } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  addToCart,
  type Cart,
  cartAmounts,
  type CartLine,
  changeLine,
  dueOf,
  EMPTY_CART,
  fefoBatch,
  lineReady,
  newLineKey,
  overridesOf,
  quickCash,
  receiptOfCart,
  removeLine,
  saleValues,
  shortLines,
} from './pos';

const RICE = '01928c4e-8888-7000-8000-000000000001';
const PHONE = '01928c4e-8888-7000-8000-000000000002';
const BAG = '01928c4e-0000-7000-8000-000000000001';
const VAT_15 = '01928c4e-7777-7000-8000-000000000002';
const REGISTER = '01928c4e-5555-7000-8000-000000000001';
const WAREHOUSE = '01928c4e-7777-7000-8000-000000000001';

function line(fields: Partial<CartLine> = {}): CartLine {
  return {
    key: newLineKey(),
    productId: '01928c4e-4444-7000-8000-000000000001',
    variantId: RICE,
    unitId: BAG,
    factor: '1',
    name: 'Miniket rice 5 kg',
    sku: 'GR-RICE-05',
    unitCode: 'bag',
    decimals: 0,
    tracking: 'none',
    goods: true,
    quantity: '1',
    unitPrice: '420.0000',
    startingPrice: '420.0000',
    discountType: 'percent',
    discount: '0',
    taxRateId: VAT_15,
    rate: '15.00',
    batchId: null,
    serialNumbers: [],
    ...fields,
  };
}

function stock(fields: Partial<SyncStock>): SyncStock {
  return {
    warehouseId: WAREHOUSE,
    productId: '01928c4e-4444-7000-8000-000000000001',
    variantId: RICE,
    batchId: null,
    lotNumber: null,
    manufacturedOn: null,
    expiresOn: null,
    quantity: '3.0000',
    updatedAt: '2026-10-27T04:00:00.000Z',
    ...fields,
  };
}

function cartOf(...lines: CartLine[]): Cart {
  return { ...EMPTY_CART, lines };
}

describe('addToCart', () => {
  it('adds one to the line of the same item, and keeps a serial item on lines of its own', () => {
    let cart = addToCart(EMPTY_CART, line());
    cart = addToCart(cart, line());
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.quantity).toBe('2.0000');

    const phone = { variantId: PHONE, tracking: 'serial', serialNumbers: ['SN-8841207'] };
    cart = addToCart(addToCart(cart, line(phone)), line(phone));
    expect(cart.lines).toHaveLength(3);
  });

  it('starts a new line when the cashier changed the old one’s price or discount', () => {
    const first = line();
    let cart = changeLine(cartOf(first), first.key, { discount: '5' });
    cart = addToCart(cart, line());
    expect(cart.lines.map((item) => item.quantity)).toEqual(['1', '1']);
    expect(removeLine(cart, first.key).lines).toHaveLength(1);
  });
});

describe('cartAmounts', () => {
  it('works out the receipt like the server, and counts a half-typed box as 0', () => {
    // 2 bags at ৳420 with VAT in the price, ৳40 off the bill: ৳800, of which VAT ৳104.35
    const cart = {
      ...cartOf(line({ quantity: '2' }), line({ quantity: '1.' })),
      billDiscount: '40',
    };
    const { totals } = cartAmounts(cart, true);
    expect(totals).toMatchObject({ billDiscount: '40.0000', total: '800.0000', vat: '104.3500' });
  });
});

describe('lineReady', () => {
  it('waits for a quantity, a price and one serial number per base unit', () => {
    expect(lineReady(line())).toBe(true);
    expect(lineReady(line({ quantity: '0' }))).toBe(false);
    expect(lineReady(line({ quantity: '1.' }))).toBe(false);
    expect(lineReady(line({ unitPrice: '' }))).toBe(false);
    const phone = line({ tracking: 'serial', quantity: '2', serialNumbers: ['SN-1'] });
    expect(lineReady(phone)).toBe(false);
    expect(lineReady({ ...phone, serialNumbers: ['SN-1', 'SN-2'] })).toBe(true);
  });
});

describe('shortLines', () => {
  it('stops a variant whose lines together need more than the warehouse has', () => {
    const a = line({ quantity: '2' });
    const b = line({ quantity: '2', unitPrice: '400.0000' });
    const service = line({ variantId: PHONE, goods: false, quantity: '9' });
    const rows = [stock({ quantity: '1.0000', batchId: 'x' }), stock({ quantity: '2.0000' })];
    const short = shortLines(cartOf(a, b, service), rows, false);
    expect([...short.entries()]).toEqual([
      [a.key, '3.0000'],
      [b.key, '3.0000'],
    ]);
    expect(shortLines(cartOf(a, b), rows, true).size).toBe(0);
  });
});

describe('overridesOf', () => {
  it('names a changed price and a discount above the register’s limit', () => {
    const changed = line({ unitPrice: '400' });
    const typed = line({ startingPrice: null, unitPrice: '500' });
    const generous = line({ discount: '12' });
    const cart = {
      ...cartOf(changed, typed, generous),
      billDiscountType: 'percent' as const,
      billDiscount: '10',
    };
    expect(overridesOf(cart, { maxDiscountPercent: '10.00' })).toEqual([
      { kind: 'price', line: 0 },
      { kind: 'discount', line: 2 },
    ]);
    expect(
      overridesOf({ ...cart, billDiscount: '10.5' }, { maxDiscountPercent: '10.00' }),
    ).toContainEqual({
      kind: 'bill_discount',
    });
  });
});

describe('fefoBatch', () => {
  const rows = [
    stock({ batchId: 'late', lotNumber: 'B', expiresOn: '2027-11-30' }),
    stock({ batchId: 'early', lotNumber: 'A', expiresOn: '2027-01-31' }),
    stock({ batchId: 'gone', lotNumber: 'C', expiresOn: '2026-10-01' }),
    stock({ batchId: 'empty', lotNumber: 'D', expiresOn: '2026-12-31', quantity: '0.0000' }),
  ];

  it('takes the first expiry with stock, never an expired batch', () => {
    expect(fefoBatch(rows, '2026-10-27', false)).toBe('early');
  });

  it('falls back to the batch that expires last only when the workspace sells below zero', () => {
    const empty = rows.map((row) => ({ ...row, quantity: '0.0000' }));
    expect(fefoBatch(empty, '2026-10-27', false)).toBeNull();
    expect(fefoBatch(empty, '2026-10-27', true)).toBe('late');
    expect(fefoBatch([], '2026-10-27', true)).toBeNull();
  });
});

describe('the payment', () => {
  it('offers the notes above the total, and says what is still to pay', () => {
    expect(quickCash('2300.0000')).toEqual(['2310', '2350', '2400', '2500']);
    expect(quickCash('47.5000')).toEqual(['50', '100', '500', '1000']);
    const rows = [
      { key: 'a', method: 'card' as const, amount: '1500', reference: '' },
      { key: 'b', method: 'cash' as const, amount: '50.', reference: '' },
    ];
    expect(dueOf(rows, '2300.0000')).toBe('800.0000');
    expect(dueOf([{ key: 'c', method: 'card', amount: '2500', reference: '' }], '2300.0000')).toBe(
      '0.0000',
    );
  });

  it('builds the sale the schema reads, walk-in, with empty boxes as the form has them', () => {
    const values = saleValues({
      cart: { ...cartOf(line({ quantity: '2' })), billDiscount: '' },
      registerId: REGISTER,
      date: '2026-10-27',
      soldAt: '2026-10-27T10:15:00.000Z',
      pricesIncludeVat: true,
      payments: [{ key: 'a', method: 'cash', amount: '1000', reference: '' }],
    });
    const parsed = posSaleInputSchema.parse({ ...values, sequence: 1 });
    expect(parsed).toMatchObject({ customerId: null, billDiscount: '0' });
    expect(parsed.payments[0]?.reference).toBeNull();
  });
});

describe('receiptOfCart', () => {
  it('prints lines that, less the bill discount, add up to the total', () => {
    // 2 bags at ৳420 with 5% off, 1 bag at ৳400, ৳20 off the bill, VAT in the price
    const cart = {
      ...cartOf(line({ quantity: '2', discount: '5' }), line({ unitPrice: '400.0000' })),
      billDiscount: '20',
    };
    const receipt = receiptOfCart({
      number: 'POS1-000124',
      soldAt: '2026-10-27T10:15:00.000Z',
      register: { code: 'POS1', paperWidth: '80', receiptFooter: null },
      cashier: 'Nusrat Jahan',
      cart,
      pricesIncludeVat: true,
      payments: [{ method: 'cash', amount: '1200', reference: null }],
      paid: '1200.0000',
      change: '2.0000',
    });
    expect(receipt.lines.map((item) => [item.discount, item.after])).toEqual([
      ['42.0000', '798.0000'],
      ['0.0000', '400.0000'],
    ]);
    expect(receipt).toMatchObject({
      billDiscount: '20.0000',
      total: '1178.0000',
      customerName: null,
    });
  });
});
