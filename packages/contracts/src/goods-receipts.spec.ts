import { describe, expect, it } from 'vitest';

import {
  goodsReceiptInputSchema,
  type GoodsReceiptLineFormValues,
  keptQuantity,
  receivedOf,
  updateGoodsReceiptInputSchema,
} from './goods-receipts.js';

const ORDER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const ORDER_LINE = '01920000-0000-7000-8000-000000000005';

function line(extra: Partial<GoodsReceiptLineFormValues> = {}): GoodsReceiptLineFormValues {
  return {
    orderLineId: ORDER_LINE,
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '48',
    rejectedQuantity: '',
    rejectionReason: '',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function receipt(lines: GoodsReceiptLineFormValues[] = [line()]) {
  return {
    orderId: ORDER,
    date: '2026-10-20',
    warehouseId: WAREHOUSE,
    supplierChallan: 'MSM-DC-7781',
    vehicle: '',
    note: '',
    lines,
    post: false,
  };
}

function issuesOf(lines: GoodsReceiptLineFormValues[]) {
  return goodsReceiptInputSchema.safeParse(receipt(lines)).error?.issues;
}

describe('goods receipt input', () => {
  it('reads an empty rejected box as nothing turned back', () => {
    expect(goodsReceiptInputSchema.parse(receipt())).toMatchObject({
      supplierChallan: 'MSM-DC-7781',
      vehicle: null,
      lines: [expect.objectContaining({ rejectedQuantity: '0', rejectionReason: null })],
    });
  });

  it('takes what was accepted and what was turned back, with the reason', () => {
    const parsed = goodsReceiptInputSchema.parse(
      receipt([line({ rejectedQuantity: '2', rejectionReason: 'Torn at the edge' })]),
    );
    const [first] = parsed.lines;
    if (first === undefined) throw new Error('no line');
    expect(receivedOf(first)).toBe('50.0000');
  });

  it('keeps a line that turned everything back', () => {
    expect(
      issuesOf([line({ quantity: '0', rejectedQuantity: '2', rejectionReason: 'Wrong shade' })]),
    ).toBeUndefined();
  });

  it('refuses a line where nothing came, on the accepted box', () => {
    expect(issuesOf([line({ quantity: '0' })])).toEqual([
      expect.objectContaining({ path: ['lines', 0, 'quantity'], message: 'grn_line_empty' }),
    ]);
  });

  it('needs a reason for what was turned back', () => {
    expect(issuesOf([line({ rejectedQuantity: '2' })])).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'rejectionReason'],
        message: 'grn_rejection_reason',
      }),
    ]);
  });

  it('leaves a bad number to its own box, with no second error', () => {
    expect(issuesOf([line({ rejectedQuantity: '2.12345' })])).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'rejectedQuantity'],
        message: 'quantity_format',
      }),
    ]);
  });

  it('takes a serial number once on the whole receipt', () => {
    expect(
      issuesOf([
        line({ quantity: '1', serialNumbers: ['IMEI-1'] }),
        line({ quantity: '1', serialNumbers: ['IMEI-1'] }),
      ]),
    ).toEqual([
      expect.objectContaining({
        path: ['lines', 1, 'serialNumbers', 0],
        message: 'stock_serial_twice',
      }),
    ]);
  });

  it('keeps its order: the edit form sends no order', () => {
    const parsed = updateGoodsReceiptInputSchema.parse({ ...receipt(), version: 2 });
    expect('orderId' in parsed).toBe(false);
  });
});

describe('kept quantity', () => {
  it('is what was accepted less what purchase returns sent back', () => {
    expect(keptQuantity({ baseQuantity: '600.0000', returnedQuantity: '0.0000' })).toBe('600.0000');
    expect(keptQuantity({ baseQuantity: '600.0000', returnedQuantity: '20.0000' })).toBe(
      '580.0000',
    );
    expect(keptQuantity({ baseQuantity: '600.0000', returnedQuantity: '600.0000' })).toBe('0.0000');
  });
});
