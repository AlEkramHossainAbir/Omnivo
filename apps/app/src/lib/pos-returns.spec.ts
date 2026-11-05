import type { PosReturnableLine, PosReturnableSale } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  exchangeSplit,
  firstPick,
  picksProblem,
  returnLinesOf,
  returnSlipOf,
  returnTotalOf,
  saleProblem,
  serialsLeft,
} from './pos-returns';

const PCS = '01928c4e-0000-7000-8000-000000000001';

function line(
  fields: Partial<PosReturnableLine> & Pick<PosReturnableLine, 'id'>,
): PosReturnableLine {
  return {
    variantId: '01928c4e-8888-7000-8000-000000000001',
    productId: '01928c4e-8888-7000-8000-000000000002',
    productCode: 'POLO',
    productName: 'Men’s polo shirt',
    optionValues: ['M'],
    sku: 'POLO-M',
    baseUnitId: PCS,
    tracking: 'none',
    unitId: PCS,
    quantity: '2.0000',
    baseQuantity: '2.0000',
    description: 'Men’s polo shirt — M',
    unitPrice: '850.0000',
    taxRate: {
      id: '01928c4e-7777-7000-8000-000000000002',
      name: 'VAT 15%',
      kind: 'standard',
      rate: '15.00',
    },
    net: '1478.2600',
    vat: '221.7400',
    total: '1700.0000',
    serialNumbers: [],
    returnedSerialNumbers: [],
    returnedQuantity: '0.0000',
    ...fields,
  };
}

const shirts = line({ id: '01928c4e-1111-7000-8000-000000000001' });
const charger = line({
  id: '01928c4e-1111-7000-8000-000000000002',
  description: 'USB-C charger 20 W',
  tracking: 'serial',
  quantity: '2.0000',
  net: '1478.2600',
  vat: '221.7400',
  total: '1700.0000',
  serialNumbers: ['CHG20-7Q41K', 'CHG20-7Q41L'],
  returnedSerialNumbers: ['CHG20-7Q41L'],
  returnedQuantity: '1.0000',
});
const tea = line({
  id: '01928c4e-1111-7000-8000-000000000003',
  description: 'Black tea 400 g',
  quantity: '1.0000',
  returnedQuantity: '1.0000',
});

const sale: PosReturnableSale = {
  id: '01928c4e-2222-7000-8000-000000000001',
  number: 'POS1-000164',
  registerId: '01928c4e-3333-7000-8000-000000000001',
  date: '2026-10-28',
  soldAt: '2026-10-28T10:12:00.000Z',
  customer: null,
  pricesIncludeVat: true,
  total: '4250.0000',
  lines: [shirts, charger, tea],
  payments: [{ method: 'cash', amount: '4250.0000' }],
};

describe('the lines coming back', () => {
  it('start with one piece, or with no serial number ticked', () => {
    expect(firstPick(shirts)).toEqual({ quantity: '1', serials: [] });
    expect(firstPick(charger)).toEqual({ quantity: '0', serials: [] });
    expect(serialsLeft(charger)).toEqual(['CHG20-7Q41K']);
  });

  it('pay each line back at its share, a serial line by the numbers ticked', () => {
    const lines = returnLinesOf(sale, {
      [shirts.id]: { quantity: '1', serials: [] },
      [charger.id]: { quantity: '0', serials: ['CHG20-7Q41K'] },
    });
    expect(lines).toEqual([
      { saleLineId: shirts.id, quantity: '1', net: '739.1300', vat: '110.8700', serialNumbers: [] },
      // The last charger takes what is left of its line
      {
        saleLineId: charger.id,
        quantity: '1',
        net: '739.1300',
        vat: '110.8700',
        serialNumbers: ['CHG20-7Q41K'],
      },
    ]);
    expect(returnTotalOf(lines)).toBe('1700.0000');
  });

  it('leave out a box still being typed, and say what stops the next step', () => {
    expect(returnLinesOf(sale, { [shirts.id]: { quantity: '1.', serials: [] } })).toEqual([]);
    expect(picksProblem(sale, {})).toEqual({ code: 'pos_return_lines_required', line: null });
    expect(picksProblem(sale, { [shirts.id]: { quantity: '3', serials: [] } })).toEqual({
      code: 'pos_return_quantity_too_large',
      line: shirts.id,
    });
    expect(picksProblem(sale, { [shirts.id]: { quantity: '2', serials: [] } })).toBeNull();
  });
});

describe('the sale', () => {
  it('comes back inside the register’s window only, and only with something left', () => {
    expect(saleProblem(sale, '2026-11-04', { returnDays: 7 })).toBeNull();
    expect(saleProblem(sale, '2026-11-05', { returnDays: 7 })).toBe('pos_return_too_old');
    expect(saleProblem(sale, '2026-10-28', { returnDays: 0 })).toBeNull();
    const back = { ...sale, lines: [tea] };
    expect(saleProblem(back, '2026-10-28', { returnDays: 7 })).toBe('pos_return_nothing_left');
  });
});

describe('an exchange', () => {
  it('pays the new sale up to its total, and the rest goes back', () => {
    expect(exchangeSplit('1700', '1750')).toEqual({ used: '1700.0000', rest: '0.0000' });
    expect(exchangeSplit('1700', '850')).toEqual({ used: '850.0000', rest: '850.0000' });
  });
});

describe('the return slip', () => {
  it('prints the lines with their units, and an exchange as the sale it paid for', () => {
    const lines = returnLinesOf(sale, { [shirts.id]: { quantity: '1', serials: [] } });
    const slip = returnSlipOf({
      number: 'POS1-R000012',
      returnedAt: '2026-11-01T09:12:00.000Z',
      register: { code: 'POS1', paperWidth: '80', receiptFooter: null },
      cashier: 'Nusrat Jahan',
      sale,
      lines,
      refunds: [{ method: 'exchange', amount: '850.0000', reference: null }],
      usedOn: 'POS1-000188',
      note: 'Wrong size',
      unitOf: () => ({ code: 'pcs', decimals: 0 }),
    });
    expect(slip).toMatchObject({
      sale: { number: 'POS1-000164', date: '2026-10-28' },
      customerName: null,
      lines: [{ name: 'Men’s polo shirt — M', quantity: '1', unitCode: 'pcs', total: '850.0000' }],
      total: '850.0000',
      refunds: [],
      usedOn: 'POS1-000188',
    });
  });
});
