import { describe, expect, it } from 'vitest';

import {
  draftRequisitionLineAmount,
  requisitionAmount,
  requisitionInputSchema,
  type RequisitionFormValues,
} from './requisitions.js';

const WAREHOUSE = '01920000-0000-7000-8000-000000000001';
const VARIANT = '01920000-0000-7000-8000-000000000002';
const UNIT = '01920000-0000-7000-8000-000000000003';

function requisition(extra: Partial<Omit<RequisitionFormValues, 'version'>> = {}) {
  return {
    date: '2026-10-15',
    warehouseId: WAREHOUSE,
    neededBy: '',
    note: '',
    lines: [
      {
        variantId: VARIANT,
        unitId: UNIT,
        quantity: '40',
        description: '',
        estimatedCost: '4250.50',
      },
    ],
    ...extra,
  };
}

describe('requisition input', () => {
  it('reads empty boxes as "not set": no date needed by, no description', () => {
    expect(requisitionInputSchema.parse(requisition())).toMatchObject({
      neededBy: null,
      note: null,
      lines: [expect.objectContaining({ description: null, estimatedCost: '4250.50' })],
    });
  });

  it('refuses a "needed by" date before the requisition, on that box', () => {
    expect(
      requisitionInputSchema.safeParse(requisition({ neededBy: '2026-10-14' })).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['neededBy'], message: 'requisition_needed_by' })]);
  });

  it('needs a cost on every line, one error per box', () => {
    const line = requisition().lines[0];
    if (line === undefined) throw new Error('no line');
    expect(
      requisitionInputSchema.safeParse(requisition({ lines: [{ ...line, estimatedCost: '' }] }))
        .error?.issues,
    ).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'estimatedCost'],
        message: 'requisition_cost_required',
      }),
    ]);
  });

  it('needs a warehouse and at least one line', () => {
    const issues = requisitionInputSchema.safeParse(requisition({ warehouseId: '', lines: [] }))
      .error?.issues;
    expect(issues?.map((issue) => issue.message)).toEqual([
      'purchase_warehouse_required',
      'purchase_lines_required',
    ]);
  });
});

describe('requisition amount', () => {
  it('rounds each line to the paisa, then adds them', () => {
    // 3 × 0.8512 = 2.5536 → 2.55; 7 × 1.005 = 7.035 → 7.04
    expect(
      requisitionAmount([
        { quantity: '3', estimatedCost: '0.8512' },
        { quantity: '7', estimatedCost: '1.005' },
      ]),
    ).toBe('9.5900');
  });

  it('waits for complete boxes while the line is typed', () => {
    expect(draftRequisitionLineAmount('40', '')).toBeNull();
    expect(draftRequisitionLineAmount('1.', '100')).toBeNull();
    expect(draftRequisitionLineAmount(' 40 ', '4250.50')).toBe('170020.0000');
  });
});
