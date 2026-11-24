import {
  type CourierExportRow,
  packStorefrontOrderInputSchema,
  type StorefrontOrder,
  type StorefrontPackPlan,
  type StorefrontShipment,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  asksCollected,
  canBook,
  canCancel,
  collectedStart,
  courierCsv,
  decimalsOf,
  doorParcel,
  nextStep,
  openParcel,
  packFormValues,
  parcelFailed,
  parcelsNewestFirst,
  pickedOf,
  plainMoney,
  plainQuantity,
  primaryDoorMove,
  receiptFailed,
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

// Step 28a.6. A parcel with only what the helpers read
function parcel(id: string, status: StorefrontShipment['status']): StorefrontShipment {
  return { id, status } as StorefrontShipment;
}
function withParcels(
  status: StorefrontOrder['status'],
  shipments: StorefrontShipment[],
): StorefrontOrder {
  return { status, shipments } as StorefrontOrder;
}

describe('the parcels', () => {
  it('finds the open one, newest first, and when a failed one needs attention', () => {
    const failed = parcel('p1', 'booking_failed');
    const booked = parcel('p2', 'booked');
    const order = withParcels('packed', [failed, booked]);
    expect(parcelsNewestFirst(order).map((one) => one.id)).toEqual(['p2', 'p1']);
    expect(openParcel(order)).toBe(booked);
    // Booked again: the failed one under it no longer counts, and nothing more can be booked
    expect(parcelFailed(order)).toBeNull();
    expect(canBook(order)).toBe(false);
    const stuck = withParcels('packed', [failed]);
    expect(parcelFailed(stuck)).toBe(failed);
    expect(canBook(stuck)).toBe(true);
    // A cancelled parcel is not on its way: the order can be booked again
    expect(canBook(withParcels('packed', [parcel('p3', 'cancelled')]))).toBe(true);
    // Only a packed order books
    expect(canBook(withParcels('confirmed', []))).toBe(false);
    expect(parcelFailed(withParcels('cancelled', [failed]))).toBeNull();
  });
});

// Step 28b.6. A parcel at the door, with only the money the helpers read
function moneyParcel(
  id: string,
  status: StorefrontShipment['status'],
  money: Partial<
    Pick<StorefrontShipment, 'codAmount' | 'collectedAmount' | 'receiptError'> & {
      hasCodAccount: boolean;
    }
  > = {},
): StorefrontShipment {
  return {
    id,
    status,
    account: { hasCodAccount: money.hasCodAccount ?? true },
    codAmount: money.codAmount ?? '538.0000',
    collectedAmount: money.collectedAmount ?? null,
    receiptError: money.receiptError ?? null,
  } as StorefrontShipment;
}

describe('the parcel at the door', () => {
  it('is the newest one the courier took, never a failed, cancelled or received one', () => {
    const failed = moneyParcel('p1', 'booking_failed');
    const delivered = moneyParcel('p2', 'delivered');
    expect(doorParcel(withParcels('delivered', [failed, delivered]))).toBe(delivered);
    // The courier took the second parcel: it is the one at the door
    const second = moneyParcel('p3', 'out_for_delivery');
    expect(doorParcel(withParcels('shipped', [delivered, second]))).toBe(second);
    // Received back (mine 28) or a booking that never reached the courier: none
    expect(doorParcel(withParcels('returned', [moneyParcel('p4', 'returned')]))).toBeNull();
    expect(doorParcel(withParcels('packed', [failed, moneyParcel('p5', 'cancelled')]))).toBeNull();
  });

  it('asks what the rider collected only when a COD receipt will be made', () => {
    expect(asksCollected(moneyParcel('p1', 'in_transit'))).toBe(true);
    // No COD account: the receipt is typed by hand, as before 28b
    expect(asksCollected(moneyParcel('p1', 'in_transit', { hasCodAccount: false }))).toBe(false);
    // Paid online: the rider collects nothing
    expect(asksCollected(moneyParcel('p1', 'in_transit', { codAmount: '0.0000' }))).toBe(false);
    expect(asksCollected(null)).toBe(false);
  });

  it('starts the box with what the courier said, else what the rider was to collect', () => {
    expect(collectedStart(moneyParcel('p1', 'in_transit'))).toBe('538');
    expect(
      collectedStart(moneyParcel('p1', 'partly_delivered', { collectedAmount: '247.5000' })),
    ).toBe('247.50');
    // Zero is what the courier said, not "nothing said"
    expect(collectedStart(moneyParcel('p1', 'delivered', { collectedAmount: '0.0000' }))).toBe('0');
    expect(plainMoney('1240')).toBe('1240');
  });

  it('makes the button the parcel asks for the primary one', () => {
    const shipped = (status: StorefrontShipment['status']) =>
      withParcels('shipped', [moneyParcel('p1', status)]);
    expect(primaryDoorMove(shipped('in_transit'))).toBe('deliver');
    expect(primaryDoorMove(shipped('partly_delivered'))).toBe('cameBack');
    expect(primaryDoorMove(shipped('returning'))).toBe('receive');
    expect(primaryDoorMove(shipped('returned'))).toBe('receive');
    // A manual parcel, or none: the member decides, Mark delivered first
    expect(primaryDoorMove(withParcels('shipped', []))).toBe('deliver');
  });

  it('finds the parcel whose COD receipt failed', () => {
    const failed = moneyParcel('p1', 'delivered', { receiptError: 'receipt_account_invalid' });
    expect(receiptFailed(withParcels('delivered', [failed]))).toBe(failed);
    expect(receiptFailed(withParcels('delivered', [moneyParcel('p2', 'delivered')]))).toBeNull();
  });
});

describe('the courier export file', () => {
  const row: CourierExportRow = {
    orderId: '0193a1b2-0000-7000-8000-0000000000c1',
    invoice: 'W-000123',
    name: 'ফারহানা আক্তার',
    address: 'House 12, Road 5, "Green" Lane\nDhanmondi',
    phone: '01786120356',
    // As the API answers it: 4 decimals, written with paisa
    amount: '538.0000',
    itemCount: 3,
  };
  const note = (count: number) => `${String(count)} items`;

  it('writes the courier’s columns, quoted where a cell needs it', () => {
    const file = courierCsv([row], note);
    // The byte order mark first, so Excel reads the Bangla name as UTF-8
    expect(file.startsWith('\uFEFF')).toBe(true);
    expect(file.slice(1).split('\r\n')).toEqual([
      'Invoice,Name,Address,Phone,Amount,Note',
      'W-000123,ফারহানা আক্তার,"House 12, Road 5, ""Green"" Lane\nDhanmondi",01786120356,538.00,3 items',
      '',
    ]);
  });

  it('never lets a shopper’s words run as a formula', () => {
    const file = courierCsv([{ ...row, name: '=HYPERLINK("x")', address: '+8801' }], note);
    const cells = file.slice(1).split('\r\n')[1];
    expect(cells).toBe(`W-000123,"'=HYPERLINK(""x"")",'+8801,01786120356,538.00,3 items`);
  });
});
