import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  purchaseReturnInputSchema,
  type PurchaseReturnLineFormValues,
  updatePurchaseReturnInputSchema,
} from './purchase-returns.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RECEIPT_LINE = '01920000-0000-7000-8000-000000000005';
const BATCH = '01920000-0000-7000-8000-000000000006';

function line(extra: Partial<PurchaseReturnLineFormValues> = {}): PurchaseReturnLineFormValues {
  return {
    receiptLineId: RECEIPT_LINE,
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '20',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

function purchaseReturn(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-10-25',
    warehouseId: WAREHOUSE,
    reason: 'quality',
    note: '',
    lines: [line()],
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

describe('purchase return input', () => {
  it('takes a line from a goods receipt and a line on its own with its batch', () => {
    const parsed = purchaseReturnInputSchema.parse(
      purchaseReturn({
        lines: [line(), line({ receiptLineId: '', batchId: BATCH, quantity: '5' })],
      }),
    );
    expect(parsed.lines.map((each) => [each.receiptLineId, each.batchId])).toEqual([
      [RECEIPT_LINE, null],
      [null, BATCH],
    ]);
  });

  it("refuses a batch on a receipt line: it goes back with the receipt line's own", () => {
    const result = purchaseReturnInputSchema.safeParse(
      purchaseReturn({ lines: [line({ batchId: BATCH })] }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.0.batchId': 'purchase_return_batch_not_allowed' });
  });

  it('refuses one receipt line twice, on the second line', () => {
    const result = purchaseReturnInputSchema.safeParse(purchaseReturn({ lines: [line(), line()] }));
    expect(errorsOf(result)).toEqual({ 'lines.1.receiptLineId': 'purchase_return_line_twice' });
  });

  it('refuses one serial number on two lines', () => {
    const result = purchaseReturnInputSchema.safeParse(
      purchaseReturn({
        lines: [
          line({ quantity: '1', serialNumbers: ['SN-4471-B'] }),
          line({ receiptLineId: '', quantity: '1', serialNumbers: ['SN-4471-B'] }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('needs a supplier, a warehouse, a known reason and a line', () => {
    // The reason has no code of its own: the API's error map gives the general one
    const result = purchaseReturnInputSchema.safeParse(
      purchaseReturn({ supplierId: '', warehouseId: '', reason: 'unknown', lines: [] }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      supplierId: 'purchase_supplier_required',
      warehouseId: 'stock_warehouse_invalid',
      reason: 'invalid_value',
      lines: 'stock_lines_required',
    });
  });

  it('keeps the same rules when a draft is changed', () => {
    const result = updatePurchaseReturnInputSchema.safeParse({
      ...purchaseReturn({ lines: [line(), line()] }),
      version: 3,
    });
    expect(errorsOf(result)).toEqual({ 'lines.1.receiptLineId': 'purchase_return_line_twice' });
  });
});
