import {
  packStorefrontOrderInputSchema,
  type StorefrontOrder,
  type StorefrontPackPlan,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  canCancel,
  decimalsOf,
  nextStep,
  packFormValues,
  pickedOf,
  plainQuantity,
  toPackInput,
} from './storefront-orders';

const BATCH_A = '0193a1b2-0000-7000-8000-00000000000a';
const BATCH_B = '0193a1b2-0000-7000-8000-00000000000b';
const REF = { id: '0193a1b2-0000-7000-8000-0000000000f1', number: 'SO-2026-27-0412' };

// Only what nextStep and canCancel read; the rest of an order does not change their answer
function order(
  status: StorefrontOrder['status'],
  salesOrder: StorefrontOrder['salesOrder'] = REF,
): StorefrontOrder {
  return { status, salesOrder } as StorefrontOrder;
}

// Three lines as 27b.4 found them (decision 32): a batch line with the API's FEFO picks in stock
// quantities, an untracked line with its one pick, a serial line with none
const plan: StorefrontPackPlan = {
  warehouse: { id: '0193a1b2-0000-7000-8000-0000000000e1', name: 'Mirpur store' },
  lines: [
    {
      position: 1,
      name: 'Himalaya Purifying Neem Face Wash',
      packSize: '150ml',
      sku: 'HIM-NFW-150',
      unitCode: 'pcs',
      quantity: '3',
      tracking: 'batch',
      batches: [
        { batchId: BATCH_A, lotNumber: 'NFW-2408', expiresOn: '2027-04-30', available: '2.0000' },
        { batchId: BATCH_B, lotNumber: 'NFW-2411', expiresOn: '2027-10-31', available: '36.0000' },
      ],
      picks: [
        { batchId: BATCH_A, quantity: '2.0000', serialNumbers: [] },
        { batchId: BATCH_B, quantity: '1.0000', serialNumbers: [] },
      ],
    },
    {
      position: 2,
      name: 'SIS Low GI Sugar',
      packSize: '350gm',
      sku: 'SIS-LGI-350',
      unitCode: 'pcs',
      quantity: '1',
      tracking: 'none',
      batches: [],
      picks: [{ batchId: null, quantity: '1', serialNumbers: [] }],
    },
    {
      position: 3,
      name: 'Omron HEM-7120',
      packSize: '',
      sku: 'OMR-7120',
      unitCode: 'pcs',
      quantity: '1',
      tracking: 'serial',
      batches: [],
      picks: [],
    },
  ],
};

describe('the next step', () => {
  it('follows the parcel: pack, ship, deliver, then nothing', () => {
    expect(nextStep(order('confirmed'))).toBe('pack');
    expect(nextStep(order('packed'))).toBe('ship');
    expect(nextStep(order('shipped'))).toBe('deliver');
    expect(nextStep(order('delivered'))).toBeNull();
    expect(nextStep(order('cancelled'))).toBeNull();
    expect(nextStep(order('returned'))).toBeNull();
  });

  it('makes the sales order first when a new order has none (decisions 1 and 29)', () => {
    expect(nextStep(order('confirmed', null))).toBe('makeSalesOrder');
  });

  it('cancels only before the parcel leaves (decision 8)', () => {
    expect(canCancel(order('confirmed'))).toBe(true);
    expect(canCancel(order('packed'))).toBe(true);
    expect(canCancel(order('shipped'))).toBe(false);
    expect(canCancel(order('delivered'))).toBe(false);
  });
});

describe('quantities as a person types them', () => {
  it('drops only the zeros at the end', () => {
    expect(plainQuantity('3.0000')).toBe('3');
    expect(plainQuantity('2.5000')).toBe('2.5');
    expect(plainQuantity('10')).toBe('10');
    expect(plainQuantity('100.0500')).toBe('100.05');
  });

  it('counts the decimals left, so formatting never rounds', () => {
    expect(decimalsOf('3.0000')).toBe(0);
    expect(decimalsOf('2.7400')).toBe(2);
    expect(decimalsOf('12')).toBe(0);
  });
});

describe('the Packed form', () => {
  it("starts from the API's suggestion, written as a person would type it", () => {
    expect(packFormValues(plan)).toEqual([
      {
        position: 1,
        picks: [
          { batchId: BATCH_A, quantity: '2' },
          { batchId: BATCH_B, quantity: '1' },
        ],
        serials: [],
      },
      { position: 2, picks: [{ batchId: '', quantity: '1' }], serials: [] },
      { position: 3, picks: [], serials: [] },
    ]);
  });

  it('gives a batch line with no suggestion one empty batch of the whole quantity', () => {
    const [first] = plan.lines;
    if (first === undefined) throw new Error('no line');
    const empty = { ...plan, lines: [{ ...first, batches: [], picks: [] }] };
    expect(packFormValues(empty)).toEqual([
      { position: 1, picks: [{ batchId: '', quantity: '3' }], serials: [] },
    ]);
  });

  it('sends every line once, a serial line as one pick of the whole quantity', () => {
    const values = packFormValues(plan);
    const serial = values[2];
    if (serial === undefined) throw new Error('no line');
    serial.serials = ['OMR7120-23K0418'];
    const input = toPackInput(plan, values, 4);
    expect(input).toEqual({
      version: 4,
      lines: [
        {
          position: 1,
          picks: [
            { batchId: BATCH_A, quantity: '2', serialNumbers: [] },
            { batchId: BATCH_B, quantity: '1', serialNumbers: [] },
          ],
        },
        { position: 2, picks: [{ batchId: '', quantity: '1', serialNumbers: [] }] },
        {
          position: 3,
          picks: [{ batchId: '', quantity: '1', serialNumbers: ['OMR7120-23K0418'] }],
        },
      ],
    });
    // What the dialog sends is what the contract takes
    expect(packStorefrontOrderInputSchema.safeParse(input).success).toBe(true);
  });

  it("leaves a mistyped box for the contract to refuse, on that box's path", () => {
    const values = packFormValues(plan);
    const first = values[0]?.picks[1];
    if (first === undefined) throw new Error('no pick');
    first.quantity = '1,5';
    const parsed = packStorefrontOrderInputSchema.safeParse(toPackInput(plan, values, 1));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['lines', 0, 'picks', 1, 'quantity']);
  });

  it('counts what is picked, ignoring a box that is not a quantity yet', () => {
    const [values] = packFormValues(plan);
    if (values === undefined) throw new Error('no line');
    expect(pickedOf(values, '3')).toEqual({ picked: '3', complete: true });
    expect(
      pickedOf(
        {
          ...values,
          picks: [
            { batchId: BATCH_A, quantity: '2' },
            { batchId: '', quantity: '' },
          ],
        },
        '3',
      ),
    ).toEqual({ picked: '2', complete: false });
  });
});
