import type {
  ApprovalRound,
  ApprovalStep,
  PurchaseOrderLine,
  RequisitionLine,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  allowedToReceive,
  approvedByOwnSubmit,
  isOrderLate,
  leftToOrder,
  leftToReceive,
  receiptFill,
  requisitionFormTotals,
  roundNumber,
  startingPrice,
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
    orderedQuantity: '0.0000',
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

// ---------------------------------------------------------------------------------------------
// Step 17b

describe('leftToOrder', () => {
  const line = { baseQuantity: '480.0000', orderedQuantity: '0.0000' } as const;

  it('is what the requisition asked for, less what orders cover, in the base unit', () => {
    expect(leftToOrder({ ...requisitionLine(), ...line, orderedQuantity: '360.0000' })).toBe(
      '120.0000',
    );
  });

  it('is never less than nothing: a mill’s minimum order may order more (decision 16)', () => {
    expect(leftToOrder({ ...requisitionLine(), ...line, orderedQuantity: '500.0000' })).toBe(
      '0.0000',
    );
  });
});

describe('isOrderLate', () => {
  it('is late only when approved and past its delivery date', () => {
    const order = { status: 'approved', expectedDate: '2026-10-15' };
    expect(isOrderLate(order, '2026-10-16')).toBe(true);
    expect(isOrderLate(order, '2026-10-15')).toBe(false);
    expect(isOrderLate({ ...order, status: 'received' }, '2026-10-16')).toBe(false);
    expect(isOrderLate({ ...order, expectedDate: null }, '2026-10-16')).toBe(false);
  });
});

describe('leftToReceive and allowedToReceive', () => {
  it('leaves what was rejected to come: the supplier still owes it', () => {
    const line = orderLine({ receivedQuantity: '600.0000', rejectedQuantity: '50.0000' });
    expect(leftToReceive(line)).toBe('400.0000');
  });

  it('lets in the workspace’s percent more, rounded down like the API (decision 22)', () => {
    const line = orderLine({ receivedQuantity: '600.0000' });
    // 1,000 m at 3% = 1,030 m in all, 600 m came already
    expect(allowedToReceive(line, '3.00')).toBe('430.0000');
    expect(allowedToReceive(line, '0.00')).toBe('400.0000');
    expect(allowedToReceive(orderLine({ receivedQuantity: '1040.0000' }), '3.00')).toBe('0.0000');
  });

  it('never asks a service line for goods (decision 29)', () => {
    const service = orderLine({ productType: 'service' });
    expect(leftToReceive(service)).toBe('0.0000');
    expect(allowedToReceive(service, '10')).toBe('0.0000');
  });
});

describe('receiptFill', () => {
  it('keeps the order’s unit for an untouched line, and asks for the rest in the base unit', () => {
    const bags = orderLine({
      id: 'bags',
      unitId: 'bag',
      quantity: '40.0000',
      baseQuantity: '1000.0000',
    });
    const started = orderLine({ id: 'started', receivedQuantity: '600.0000' });
    const service = orderLine({ id: 'dyeing', productType: 'service' });
    expect(receiptFill([bags, started, service], new Map())).toEqual([
      { orderLineId: 'bags', variantId: 'fabric', unitId: 'bag', quantity: '40' },
      { orderLineId: 'started', variantId: 'fabric', unitId: 'm', quantity: '400' },
    ]);
  });

  it('adds only what the form does not hold yet', () => {
    const line = orderLine({ id: 'fabric-line' });
    expect(receiptFill([line], new Map([['fabric-line', '250']]))).toEqual([
      { orderLineId: 'fabric-line', variantId: 'fabric', unitId: 'm', quantity: '750' },
    ]);
    expect(receiptFill([line], new Map([['fabric-line', '1000']]))).toEqual([]);
  });
});

describe('startingPrice', () => {
  it('is the net when the order’s prices are before VAT', () => {
    expect(startingPrice('312.5000', '15.00', false)).toBe('312.5000');
  });

  it('adds the VAT, to the paisa, when the order’s prices include it', () => {
    // 312.50 + 15% (46.875 → 46.88)
    expect(startingPrice('312.5000', '15.00', true)).toBe('359.3800');
  });

  it('stays empty when nothing is known, or the rate is not loaded', () => {
    expect(startingPrice(null, '15.00', true)).toBeNull();
    expect(startingPrice('312.5000', null, true)).toBe('312.5000');
  });
});

// A requisition line with the fields the helpers do not read filled in
function requisitionLine(): RequisitionLine {
  return {
    id: 'req-line',
    variantId: 'yarn',
    productId: 'p-yarn',
    productCode: 'P-00031',
    productName: '30s combed cotton yarn',
    optionValues: [],
    sku: 'P-00031',
    baseUnitId: 'cone',
    productType: 'goods',
    units: [],
    unitId: 'cone',
    quantity: '480.0000',
    baseQuantity: '480.0000',
    description: '30s combed cotton yarn',
    estimatedCost: '312.0000',
    amount: '149760.0000',
    orderedQuantity: '0.0000',
  };
}

// An order line of 1,000 m of fabric, nothing received yet
function orderLine(extra: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'line-1',
    variantId: 'fabric',
    productId: 'p-fabric',
    productCode: 'P-00102',
    productName: 'Single jersey 180 GSM',
    optionValues: [],
    sku: 'P-00102',
    baseUnitId: 'm',
    productType: 'goods',
    tracking: 'batch',
    hasExpiry: false,
    units: [{ unitId: 'bag', factor: '25.000000' }],
    unitId: 'm',
    quantity: '1000.0000',
    baseQuantity: '1000.0000',
    description: 'Single jersey 180 GSM',
    unitPrice: '312.5000',
    discountType: 'percent',
    discount: '0.0000',
    taxRate: { id: 'vat-15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '312500.0000',
    vat: '46875.0000',
    total: '359375.0000',
    requisitionLine: null,
    receivedQuantity: '0.0000',
    rejectedQuantity: '0.0000',
    ...extra,
  };
}
