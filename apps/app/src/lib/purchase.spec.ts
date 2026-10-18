import type { ApprovalRound, ApprovalStep, RequisitionLine } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  approvedByOwnSubmit,
  requisitionFormTotals,
  roundNumber,
  stepState,
  toRequisitionFormLine,
} from './purchase';

const RUPA = { id: '00000000-0000-4000-8000-000000000001', name: 'Rupa Akter' };
const KAMAL = { id: '00000000-0000-4000-8000-000000000002', name: 'Kamal Hossain' };

// A step as the API sends it: Purchase manager from ৳20,000, not decided yet
function step(position: number, extra: Partial<ApprovalStep> = {}): ApprovalStep {
  return {
    position,
    minAmount: position === 1 ? '20000.0000' : '100000.0000',
    role: {
      id: `00000000-0000-4000-8000-00000000010${String(position)}`,
      name: 'Purchase manager',
    },
    decision: null,
    decidedBy: null,
    decidedAt: null,
    comment: null,
    ...extra,
  };
}

function round(status: ApprovalRound['status'], steps: ApprovalStep[]): ApprovalRound {
  return {
    id: '00000000-0000-4000-8000-000000000200',
    status,
    amount: '150000.0000',
    submittedBy: RUPA,
    submittedAt: '2026-10-15T04:00:00.000Z',
    closedAt: status === 'pending' ? null : '2026-10-15T06:00:00.000Z',
    steps,
  };
}

const approvedBy = (person: { id: string; name: string }) => ({
  decision: 'approved' as const,
  decidedBy: person,
  decidedAt: '2026-10-15T05:00:00.000Z',
});

describe('requisitionFormTotals', () => {
  it('adds the complete lines and leaves the half-typed ones out', () => {
    const { amounts, total } = requisitionFormTotals([
      // 40 cones at ৳312.4567 = ৳12,498.268 → ৳12,498.27 (rounded once per line)
      {
        variantId: 'yarn',
        unitId: 'cone',
        quantity: '40',
        description: '',
        estimatedCost: '312.4567',
      },
      { variantId: 'motor', unitId: 'pcs', quantity: '1.', description: '', estimatedCost: '8500' },
      { variantId: 'bags', unitId: 'pcs', quantity: '200', description: '', estimatedCost: '' },
    ]);
    expect(amounts).toEqual(['12498.2700', null, null]);
    expect(total).toBe('12498.2700');
  });

  it('is nothing for no lines', () => {
    expect(requisitionFormTotals([]).total).toBe('0.0000');
  });
});

describe('toRequisitionFormLine', () => {
  const line: RequisitionLine = {
    id: 'line-1',
    variantId: 'yarn',
    productId: 'p-yarn',
    productCode: 'P-00031',
    productName: '30s combed cotton yarn',
    optionValues: [],
    sku: 'P-00031',
    baseUnitId: 'cone',
    productType: 'goods',
    units: [{ unitId: 'bag', factor: '24.000000' }],
    unitId: 'bag',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: '30s combed cotton yarn',
    estimatedCost: '7499.0000',
    amount: '14998.0000',
  };

  it('shows the quantity as typed and an empty description when it is the product name', () => {
    expect(toRequisitionFormLine(line)).toEqual({
      variantId: 'yarn',
      unitId: 'bag',
      quantity: '2',
      description: '',
      estimatedCost: '7499.0000',
    });
  });

  it('keeps a description the person wrote', () => {
    expect(toRequisitionFormLine({ ...line, description: 'Navy, for PO-HM-2026-1187' })).toEqual(
      expect.objectContaining({ description: 'Navy, for PO-HM-2026-1187' }),
    );
  });
});

describe('stepState', () => {
  it('waits on the first undecided step of a pending round, the next is not yet', () => {
    const pending = round('pending', [step(1, approvedBy(KAMAL)), step(2), step(3)]);
    expect(pending.steps.map((item) => stepState(pending, item))).toEqual([
      'approved',
      'waiting',
      'notYet',
    ]);
  });

  it('never shows a step of a closed round as waiting', () => {
    const rejected = round('rejected', [
      step(1, { decision: 'rejected', decidedBy: KAMAL, comment: 'Order 1,500 cones' }),
      step(2),
    ]);
    expect(rejected.steps.map((item) => stepState(rejected, item))).toEqual([
      'rejected',
      'notDecided',
    ]);
    const reopened = round('reopened', [step(1)]);
    expect(stepState(reopened, step(1))).toBe('notDecided');
  });
});

describe('approvedByOwnSubmit', () => {
  it('is true when every step was approved by the person who submitted it (an Owner)', () => {
    expect(approvedByOwnSubmit(round('approved', [step(1, approvedBy(RUPA))]))).toBe(true);
  });

  it('is false when someone else approved, and when no level applied', () => {
    expect(approvedByOwnSubmit(round('approved', [step(1, approvedBy(KAMAL))]))).toBe(false);
    expect(approvedByOwnSubmit(round('approved', []))).toBe(false);
  });
});

describe('roundNumber', () => {
  it('counts from the first submission, while the list is newest first', () => {
    const rounds = [round('pending', []), round('rejected', []), round('reopened', [])];
    expect([0, 1, 2].map((index) => roundNumber(rounds, index))).toEqual([3, 2, 1]);
  });
});
