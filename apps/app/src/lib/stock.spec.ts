import type { Unit } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  basePreview,
  daysUntil,
  documentRoute,
  expiryTone,
  fefoSplit,
  firstMessage,
  parseSerials,
  unitChoices,
  variantName,
} from './stock';

function unit(id: string, code: string, decimals = 0): Unit {
  return {
    id,
    code,
    name: code,
    dimension: 'count',
    ratio: null,
    decimals,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const UNITS = [
  unit('pcs', 'pcs'),
  unit('case', 'case'),
  unit('m', 'm', 2),
  unit('yard', 'yard', 2),
];
const juice = { baseUnitId: 'pcs', units: [{ unitId: 'case', factor: '24.000000' }] };

describe('stock helpers', () => {
  it('names a variant by its product and values', () => {
    expect(variantName({ productName: 'Napa 500 mg', optionValues: [] })).toBe('Napa 500 mg');
    expect(variantName({ productName: 'Polo shirt', optionValues: ['M', 'Navy'] })).toBe(
      'Polo shirt · M / Navy',
    );
  });

  it('offers the base unit and each pack with its size', () => {
    expect(unitChoices(juice, UNITS)).toEqual([
      { value: 'pcs', label: 'pcs' },
      { value: 'case', label: 'case = 24 pcs' },
    ]);
  });

  it('shows a pack in base units, rounded like the server', () => {
    expect(basePreview(juice, 'case', '3', UNITS)).toBe('72.0000');
    expect(basePreview(juice, 'pcs', '3', UNITS)).toBeNull();
    expect(basePreview(juice, 'case', '', UNITS)).toBeNull();
    const fabric = { baseUnitId: 'm', units: [{ unitId: 'yard', factor: '0.914400' }] };
    expect(basePreview(fabric, 'yard', '3', UNITS)).toBe('2.7400');
  });

  it('takes from the batch that expires first, then the next', () => {
    const batches = [
      { batchId: 'NP24090', quantity: '40.0000' },
      { batchId: 'NP24117', quantity: '120.0000' },
    ];
    expect(fefoSplit(batches, '30')).toEqual({
      picks: [{ batchId: 'NP24090', quantity: '30' }],
      missing: '0.0000',
    });
    expect(fefoSplit(batches, '100')).toEqual({
      picks: [
        { batchId: 'NP24090', quantity: '40' },
        { batchId: 'NP24117', quantity: '60' },
      ],
      missing: '0.0000',
    });
    expect(fefoSplit(batches, '200').missing).toBe('40.0000');
  });

  it('counts days to an expiry and colours it', () => {
    expect(daysUntil('2026-10-31', '2026-10-01')).toBe(30);
    expect(daysUntil('2026-09-30', '2026-10-01')).toBe(-1);
    expect(expiryTone('2026-09-30', '2026-10-01')).toBe('crit');
    expect(expiryTone('2026-10-31', '2026-10-01')).toBe('warn');
    expect(expiryTone('2027-06-30', '2026-10-01')).toBe('neutral');
    expect(expiryTone(null, '2026-10-01')).toBe('neutral');
  });

  it('reads serial numbers one per line, or separated by commas', () => {
    expect(parseSerials('356938035643809\n356938035643817\n\n')).toEqual([
      '356938035643809',
      '356938035643817',
    ]);
    expect(parseSerials(' SN-1, SN-2 ;SN-3 ')).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });

  it('links a movement to its document', () => {
    expect(documentRoute('adjustment')).toBe('/stock/adjustments/$adjustmentId');
    expect(documentRoute('transfer_in')).toBe('/stock/transfers/$transferId');
    expect(documentRoute('revaluation')).toBe('/stock/revaluations/$revaluationId');
    expect(documentRoute('delivery')).toBe('/deliveries/$deliveryId');
    expect(documentRoute('sales_invoice')).toBeNull();
  });
});

describe('form errors', () => {
  it('finds the first message, even inside a list of serial numbers', () => {
    expect(firstMessage({ message: 'stock_serial_count' })).toBe('stock_serial_count');
    expect(firstMessage([undefined, { message: 'stock_serial_twice' }])).toBe('stock_serial_twice');
    expect(firstMessage(undefined)).toBeUndefined();
  });
});
