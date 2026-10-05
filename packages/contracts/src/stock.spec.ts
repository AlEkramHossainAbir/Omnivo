import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import { reasonFits, stockAdjustmentInputSchema } from './stock-adjustments.js';
import { receiveTransferInputSchema, stockTransferInputSchema } from './stock-transfers.js';
import { reorderLevelInputSchema } from './stock.js';

const WAREHOUSE = '01920000-0000-7000-8000-000000000001';
const DEPOT = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';

function line(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    batchId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function adjustment(extra: object = {}) {
  return {
    date: '2026-10-01',
    warehouseId: WAREHOUSE,
    direction: 'in',
    reason: 'opening',
    note: '',
    lines: [line()],
    post: true,
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

describe('stock adjustment input', () => {
  it('turns the form’s empty boxes into nulls', () => {
    const parsed = stockAdjustmentInputSchema.parse(adjustment({ note: '  ' }));
    expect(parsed.note).toBeNull();
    expect(parsed.lines[0]).toMatchObject({ batchId: null, lotNumber: null, expiresOn: null });
  });

  it('keeps each reason to its direction', () => {
    expect(reasonFits('opening', 'in')).toBe(true);
    expect(reasonFits('damaged', 'in')).toBe(false);
    expect(reasonFits('correction', 'out')).toBe(true);
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({ direction: 'out', reason: 'found' }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ reason: 'adjustment_reason_direction' });
  });

  it('refuses zero, a batch that expires before it was made, and an IMEI twice', () => {
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({
        lines: [
          line({ quantity: '0' }),
          line({ manufacturedOn: '2026-09-01', expiresOn: '2026-08-01' }),
          line({ quantity: '2', serialNumbers: ['356938035643809', '356938035643809'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      'lines.0.quantity': 'quantity_format',
      'lines.1.expiresOn': 'stock_batch_dates',
      'lines.2.serialNumbers.1': 'stock_serial_twice',
    });
  });

  it('refuses the same serial number on two lines', () => {
    const result = stockAdjustmentInputSchema.safeParse(
      adjustment({
        lines: [
          line({ quantity: '1', serialNumbers: ['SN-1'] }),
          line({ quantity: '1', serialNumbers: ['SN-1'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('needs at least one line', () => {
    const result = stockAdjustmentInputSchema.safeParse(adjustment({ lines: [] }), {
      error: contractErrorMap,
    });
    expect(errorsOf(result)).toEqual({ lines: 'stock_lines_required' });
  });
});

describe('stock transfer input', () => {
  it('refuses a transfer to the warehouse it comes from', () => {
    const result = stockTransferInputSchema.safeParse(
      {
        fromWarehouseId: WAREHOUSE,
        toWarehouseId: WAREHOUSE,
        date: '2026-10-02',
        note: '',
        lines: [
          { variantId: VARIANT, unitId: UNIT, quantity: '1', batchId: '', serialNumbers: [] },
        ],
        send: true,
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({ toWarehouseId: 'transfer_same_warehouse' });
    expect(
      stockTransferInputSchema.safeParse({
        fromWarehouseId: WAREHOUSE,
        toWarehouseId: DEPOT,
        date: '2026-10-02',
        note: '',
        lines: [
          { variantId: VARIANT, unitId: UNIT, quantity: '1', batchId: '', serialNumbers: [] },
        ],
        send: true,
      }).success,
    ).toBe(true);
  });

  it('receives every line once, zero included', () => {
    const lineId = '01920000-0000-7000-8000-000000000009';
    expect(
      receiveTransferInputSchema.safeParse({
        version: 2,
        date: '2026-10-03',
        lines: [{ lineId, receivedQuantity: '0', serialNumbers: [] }],
      }).success,
    ).toBe(true);
    const twice = receiveTransferInputSchema.safeParse(
      {
        version: 2,
        date: '2026-10-03',
        lines: [
          { lineId, receivedQuantity: '1', serialNumbers: [] },
          { lineId, receivedQuantity: '1', serialNumbers: [] },
        ],
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.lineId': 'transfer_lines_mismatch' });
  });
});

describe('reorder level input', () => {
  it('needs a level before an order size, and an order of more than nothing', () => {
    const base = { warehouseId: WAREHOUSE, variantId: VARIANT };
    expect(
      reorderLevelInputSchema.parse({ ...base, minQuantity: '', reorderQuantity: '' }),
    ).toMatchObject({
      minQuantity: null,
      reorderQuantity: null,
    });
    expect(
      errorsOf(
        reorderLevelInputSchema.safeParse({ ...base, minQuantity: '', reorderQuantity: '48' }),
      ),
    ).toEqual({ minQuantity: 'reorder_level_required' });
    expect(
      errorsOf(
        reorderLevelInputSchema.safeParse({ ...base, minQuantity: '12', reorderQuantity: '0' }),
      ),
    ).toEqual({ reorderQuantity: 'quantity_format' });
  });
});
