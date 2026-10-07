import type { SalesLineFormValues, SalesOrderLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  baseByOrderLine,
  fillFromOrder,
  formDiscount,
  formTotals,
  isExpired,
  isLate,
  leftToDeliver,
  savedLines,
  toFormLine,
} from './sales';

// An order line as the API sends it: 2 cases of 24 (48 pcs), nothing delivered yet
function orderLine(extra: Partial<SalesOrderLine> = {}): SalesOrderLine {
  return {
    id: 'line-juice',
    variantId: 'juice',
    productId: 'p-juice',
    productCode: 'P-00012',
    productName: 'Mango juice 250 ml',
    optionValues: [],
    sku: 'P-00012',
    baseUnitId: 'pcs',
    productType: 'goods',
    tracking: 'none',
    hasExpiry: false,
    units: [{ unitId: 'case', factor: '24.000000' }],
    unitId: 'case',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: 'Mango juice 250 ml',
    unitPrice: '504.0000',
    discountType: 'percent',
    discount: '0.0000',
    taxRate: { id: 'vat15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '1008.0000',
    vat: '151.2000',
    total: '1159.2000',
    deliveredQuantity: '0.0000',
    ...extra,
  };
}

function formLine(extra: Partial<SalesLineFormValues> = {}): SalesLineFormValues {
  return {
    variantId: 'juice',
    unitId: 'case',
    quantity: '2',
    description: '',
    unitPrice: '504.00',
    discountType: 'percent',
    discount: '10.00',
    taxRateId: 'vat15',
    ...extra,
  };
}

describe('sales helpers', () => {
  it('shows a saved discount the way the box takes it', () => {
    expect(formDiscount('0.0000')).toBe('');
    expect(formDiscount('10.0000')).toBe('10');
    expect(formDiscount('12.5000')).toBe('12.5');
    expect(formDiscount('250.7500')).toBe('250.75');
  });

  it('marks an open quotation expired the day after its date, and nothing else', () => {
    const open = { status: 'open', validUntil: '2026-10-06' };
    expect(isExpired(open, '2026-10-06')).toBe(false);
    expect(isExpired(open, '2026-10-07')).toBe(true);
    expect(isExpired({ ...open, validUntil: null }, '2027-01-01')).toBe(false);
    expect(isExpired({ ...open, status: 'accepted' }, '2026-10-07')).toBe(false);
  });

  it('marks only a confirmed order late', () => {
    const order = { status: 'confirmed', deliveryDate: '2026-10-06' };
    expect(isLate(order, '2026-10-07')).toBe(true);
    expect(isLate({ ...order, status: 'delivered' }, '2026-10-07')).toBe(false);
    expect(isLate({ ...order, deliveryDate: null }, '2026-10-07')).toBe(false);
  });

  it('works out what an order line has left, never below zero, nothing for a service', () => {
    expect(leftToDeliver(orderLine({ deliveredQuantity: '20.0000' }))).toBe('28.0000');
    expect(leftToDeliver(orderLine({ deliveredQuantity: '48.0000' }))).toBe('0.0000');
    expect(leftToDeliver(orderLine({ productType: 'service', baseUnitId: 'job' }))).toBe('0.0000');
  });

  it('fills a delivery from the order: whole lines in their unit, the rest in the base unit', () => {
    const napa = orderLine({
      id: 'line-napa',
      variantId: 'napa',
      unitId: 'pcs',
      quantity: '200.0000',
      baseQuantity: '200.0000',
      deliveredQuantity: '150.0000',
    });
    const carriage = orderLine({ id: 'line-carriage', productType: 'service' });
    expect(fillFromOrder([orderLine(), napa, carriage], new Map())).toEqual([
      { orderLineId: 'line-juice', variantId: 'juice', unitId: 'case', quantity: '2' },
      { orderLineId: 'line-napa', variantId: 'napa', unitId: 'pcs', quantity: '50' },
    ]);
    // A second click adds only what the form does not hold yet
    const onForm = baseByOrderLine([
      { orderLineId: 'line-juice', base: '24.0000' },
      { orderLineId: 'line-napa', base: '50.0000' },
      { orderLineId: '', base: '5.0000' },
      { orderLineId: 'line-juice', base: null },
    ]);
    expect(fillFromOrder([orderLine(), napa], onForm)).toEqual([
      { orderLineId: 'line-juice', variantId: 'juice', unitId: 'pcs', quantity: '24' },
    ]);
  });

  it('puts a saved line back in the form the way its boxes take it', () => {
    expect(toFormLine(orderLine({ discount: '10.0000' }))).toEqual({
      variantId: 'juice',
      unitId: 'case',
      quantity: '2',
      // Just the product's name: the box stays empty and keeps following the product
      description: '',
      unitPrice: '504.0000',
      discountType: 'percent',
      discount: '10',
      taxRateId: 'vat15',
    });
    expect(
      toFormLine(orderLine({ description: 'Mango juice, Mirpur depot carton' })).description,
    ).toBe('Mango juice, Mirpur depot carton');
    const { meta } = savedLines([orderLine()], 'customer-1');
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({
      key: 'line-juice',
      item: { variantId: 'juice', productType: 'goods' },
      source: undefined,
      pricedFor: 'customer-1',
    });
  });

  it('totals the complete lines with the contract’s arithmetic', () => {
    const rateOf = (id: string) => (id === 'vat15' ? '15.00' : null);
    const { amounts, totals } = formTotals(
      [formLine(), formLine({ quantity: '' }), formLine({ taxRateId: '' })],
      rateOf,
      false,
    );
    expect(amounts.map((amount) => amount?.total ?? null)).toEqual(['1043.2800', null, null]);
    // 2 cases × ৳504 − 10% = ৳907.20, VAT 15% = ৳136.08 (15b.4's quotation)
    expect(totals).toEqual({
      discount: '100.8000',
      net: '907.2000',
      vat: '136.0800',
      total: '1043.2800',
    });
  });
});
