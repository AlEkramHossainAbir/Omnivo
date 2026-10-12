import { describe, expect, it } from 'vitest';

import { billableQuantity } from './deliveries.js';
import { contractErrorMap } from './errors.js';
import { salesReturnInputSchema } from './sales-returns.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const DELIVERY_LINE = '01920000-0000-7000-8000-000000000005';
const BATCH = '01920000-0000-7000-8000-000000000006';

function returnLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '3',
    batchId: '',
    serialNumbers: [],
    deliveryLineId: DELIVERY_LINE,
    ...extra,
  };
}

function salesReturn(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-11',
    warehouseId: WAREHOUSE,
    reason: 'expired',
    note: '',
    lines: [returnLine()],
    post: false,
    ...extra,
  };
}

// The error codes where the form will show them: field path → code
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('sales return input', () => {
  it('takes a line from a challan and a line on its own with its batch', () => {
    const parsed = salesReturnInputSchema.parse(
      salesReturn({
        lines: [returnLine(), returnLine({ deliveryLineId: '', batchId: BATCH })],
      }),
    );
    expect(parsed.lines.map((line) => [line.deliveryLineId, line.batchId])).toEqual([
      [DELIVERY_LINE, null],
      [null, BATCH],
    ]);
  });

  it("refuses a batch on a challan line: it comes back with the challan line's own", () => {
    const result = salesReturnInputSchema.safeParse(
      salesReturn({ lines: [returnLine({ batchId: BATCH })] }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.0.batchId': 'return_batch_not_allowed' });
  });

  it('refuses one challan line twice, on the second line', () => {
    const result = salesReturnInputSchema.safeParse(
      salesReturn({ lines: [returnLine(), returnLine()] }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.deliveryLineId': 'return_line_twice' });
  });

  it('refuses one serial number on two lines', () => {
    const result = salesReturnInputSchema.safeParse(
      salesReturn({
        lines: [
          returnLine({ quantity: '1', serialNumbers: ['356938035643809'] }),
          returnLine({ deliveryLineId: '', quantity: '1', serialNumbers: ['356938035643809'] }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('marks every mistake at once', () => {
    const result = salesReturnInputSchema.safeParse(
      salesReturn({
        customerId: '',
        warehouseId: '',
        lines: [returnLine({ batchId: BATCH }), returnLine()],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      warehouseId: 'stock_warehouse_invalid',
      'lines.0.batchId': 'return_batch_not_allowed',
      'lines.1.deliveryLineId': 'return_line_twice',
    });
  });
});

describe('billable quantity', () => {
  it('is what left less what came back before it was billed', () => {
    expect(billableQuantity({ baseQuantity: '48.0000', returnedQuantity: '0.0000' })).toBe(
      '48.0000',
    );
    expect(billableQuantity({ baseQuantity: '48.0000', returnedQuantity: '3.0000' })).toBe(
      '45.0000',
    );
    // All of it came back: nothing left to bill
    expect(billableQuantity({ baseQuantity: '48.0000', returnedQuantity: '48.0000' })).toBe(
      '0.0000',
    );
  });
});
