import 'fake-indexeddb/auto';

import {
  MAX_HELD_CARTS,
  type PosSaleInput,
  syncCommandSchema,
  type SyncPosRegister,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import {
  heldCarts,
  heldCount,
  holdCart,
  type PosCart,
  resumeCart,
  saveScreenCart,
  screenCart,
} from './carts.js';
import { applyPage } from './apply.js';
import type { LocalCopy } from './copy.js';
import type { HeldCart } from './database.js';
import { keepClaim, savePosSale } from './pos.js';
import { outboxEntries } from './queries.js';
import {
  closeShift,
  localCashReasons,
  moveCash,
  openShift,
  readShift,
  shiftStart,
  shiftState,
} from './shift.js';
import { cashReason, newCopy, page, posRegister, VAT_15 } from './test-fixtures.js';

const OPENED = '2026-10-29T03:02:00.000Z';
const DAY = '2026-10-29';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';
const BASE_UNIT = '01928c4e-0000-7000-8000-000000000001';

// A copy that holds POS1, ready to open a shift
async function counter(fields: Partial<SyncPosRegister> = {}) {
  const copy = await newCopy();
  const register = posRegister({ code: 'POS1', ...fields });
  await keepClaim(copy, { id: register.id, lastNumber: 0 });
  return { copy, register };
}

function count(total: string) {
  return { notes: null, total };
}

async function open(copy: LocalCopy, register: SyncPosRegister, total = '5000.00') {
  const result = await openShift(copy, {
    register,
    input: {
      date: DAY,
      openedAt: OPENED,
      opening: count(total),
      floatReasonId: null,
    },
    savedAt: OPENED,
  });
  if (result.kind !== 'opened') throw new Error(`The shift did not open: ${result.kind}`);
  return result;
}

// A walk-in sale of ৳840, paid ৳1,000 in cash: ৳160 change
function sale(registerId: string, shiftId: string): Omit<PosSaleInput, 'sequence'> {
  return {
    registerId,
    shiftId,
    date: DAY,
    soldAt: OPENED,
    customerId: null,
    pricesIncludeVat: true,
    lines: [
      {
        variantId: VARIANT,
        unitId: BASE_UNIT,
        quantity: '2',
        description: null,
        unitPrice: '420',
        discountType: 'percent',
        discount: '0',
        taxRateId: VAT_15,
        rate: '15.00',
        startingPrice: '420.0000',
        batchId: null,
        serialNumbers: [],
      },
    ],
    billDiscountType: 'amount',
    billDiscount: '0',
    payments: [{ method: 'cash', amount: '1000', reference: null }],
  };
}

const EMPTY: PosCart = { customer: null, lines: [], billDiscountType: 'amount', billDiscount: '' };

function held(name: string | null, lines = 1): HeldCart {
  const line = sale('', '').lines[0];
  if (!line) throw new Error('line');
  return {
    name,
    heldAt: OPENED,
    items: lines,
    total: '840.0000',
    cart: {
      ...EMPTY,
      lines: Array.from({ length: lines }, (_, index) => ({
        ...line,
        key: `line-${String(index)}`,
        productId: uuidv7(),
        factor: '1',
        name: 'Miniket rice 5 kg',
        sku: 'RICE-5',
        unitCode: 'bag',
        decimals: 0,
        tracking: 'none',
        goods: true,
        unitPrice: '420',
      })),
    },
  };
}

describe('the reasons on the device', () => {
  it('keeps the reasons the pull sends, sealed, "in" first and then by name', async () => {
    const copy = await newCopy();
    const reasons = [
      cashReason({ name: 'Tea for the staff', direction: 'out' }),
      cashReason({ name: 'Float from the owner', direction: 'in' }),
      cashReason({ name: 'Cash to the bank', direction: 'out' }),
    ];
    await applyPage(
      copy,
      page({
        changes: reasons.map((row) => ({
          op: 'upsert' as const,
          entity: 'pos_cash_reason' as const,
          key: row.id,
          data: row,
        })),
      }),
      null,
    );
    expect((await localCashReasons(copy)).map((row) => row.name)).toEqual([
      'Float from the owner',
      'Cash to the bank',
      'Tea for the staff',
    ]);
  });
});

describe('shiftStart', () => {
  const register = posRegister({ code: 'POS1' });

  it('starts a register’s first shift at 1, with nothing to compare with', () => {
    expect(shiftStart(register, null)).toEqual({
      sequence: 1,
      number: 'POS1-S0001',
      first: true,
      cashLeft: null,
    });
  });

  it('goes on from the server’s last shift, or from this device’s own when it is later', () => {
    const lastShift = {
      id: uuidv7(),
      sequence: 41,
      status: 'closed' as const,
      cashLeft: '5000.00',
    };
    expect(shiftStart({ ...register, lastShift }, null)).toMatchObject({
      sequence: 42,
      number: 'POS1-S0042',
      first: false,
      cashLeft: '5000.00',
    });
    // Its own close has not reached the server yet: the device's count is the newer one
    const own = {
      id: uuidv7(),
      registerId: register.id,
      sequence: 42,
      number: 'POS1-S0042',
      status: 'closed' as const,
      openedAt: OPENED,
      openingDate: DAY,
      opening: count('5000.00'),
      cash: { opening: '5000', cashTaken: '0', changeGiven: '0', paidIn: '0', paidOut: '0' },
      closedAt: OPENED,
      counted: '7640.00',
      expected: '8160.0000',
    };
    expect(shiftStart({ ...register, lastShift }, own)).toMatchObject({
      sequence: 43,
      cashLeft: '7640.00',
    });
    // Another register's shift says nothing about this one
    expect(shiftStart({ ...register, lastShift }, { ...own, registerId: uuidv7() })).toMatchObject({
      sequence: 42,
    });
  });
});

describe('a shift on the device', () => {
  it('opens with a command the server reads, and only on the register the device holds', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    expect(shift).toMatchObject({ number: 'POS1-S0001', status: 'open' });
    const [entry] = await outboxEntries(copy);
    expect(entry?.shiftId).toBe(shift.id);
    expect(syncCommandSchema.parse(entry?.command)).toMatchObject({
      type: 'pos_shift.open',
      shiftId: shift.id,
      input: { registerId: register.id, sequence: 1, floatReasonId: null },
    });
    // The lock screen reads this without the key; the amounts are in the box only
    expect(await shiftState(copy.db)).toEqual({
      shiftId: shift.id,
      registerId: register.id,
      number: 'POS1-S0001',
      status: 'open',
    });
    // A second open (another tab) and an open on a register the device does not hold
    const again = await openShift(copy, {
      register,
      input: { date: DAY, openedAt: OPENED, opening: count('0'), floatReasonId: null },
      savedAt: OPENED,
    });
    expect(again.kind).toBe('open-already');
    const other = await counter();
    const notHeld = await openShift(other.copy, {
      register,
      input: { date: DAY, openedAt: OPENED, opening: count('0'), floatReasonId: null },
      savedAt: OPENED,
    });
    expect(notHeld.kind).toBe('not-held');
  });

  it('adds up the cash of its sales and movements, and closes with what it expected', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    for (let index = 0; index < 2; index += 1) {
      const saved = await savePosSale(copy, {
        input: sale(register.id, shift.id),
        registerCode: 'POS1',
        total: '840.0000',
        savedAt: OPENED,
      });
      expect(saved.kind).toBe('saved');
    }
    const move = (direction: 'in' | 'out', amount: string) =>
      moveCash(copy, {
        input: {
          shiftId: shift.id,
          reasonId: uuidv7(),
          amount,
          note: null,
          date: DAY,
          movedAt: OPENED,
        },
        direction,
        name: `${amount} ${direction}`,
        savedAt: OPENED,
      });
    expect(await move('in', '2000')).toEqual({ kind: 'saved' });
    // 5,000 + 2,000 in cash − 320 change + 2,000 = ৳8,680 in the drawer: no more goes out
    expect(await move('out', '8680.01')).toEqual({ kind: 'too-large' });
    expect(await move('out', '1000')).toEqual({ kind: 'saved' });
    expect((await readShift(copy))?.cash).toEqual({
      opening: '5000.00',
      cashTaken: '2000.0000',
      changeGiven: '320.0000',
      paidIn: '2000.0000',
      paidOut: '1000.0000',
    });

    await holdCart(copy, shift.id, held('Customer in the blue shirt'));
    await saveScreenCart(copy, shift.id, held(null));
    const closed = await closeShift(copy, {
      shiftId: shift.id,
      input: { date: DAY, closedAt: OPENED, counted: count('7640.00') },
      savedAt: OPENED,
    });
    expect(closed).toMatchObject({
      kind: 'closed',
      shift: { status: 'closed', counted: '7640.00', expected: '7680.0000' },
      difference: '-40.0000',
    });
    const entries = await outboxEntries(copy);
    const close = entries.at(-1);
    expect(syncCommandSchema.parse(close?.command)).toMatchObject({
      type: 'pos_shift.close',
      input: { deviceExpected: '7680.0000', heldDropped: 1 },
    });
    // The open, two sales, three movements (the refused pay out never went in) and the close
    expect(entries.map((entry) => entry.command.type)).toEqual([
      'pos_shift.open',
      'pos_sale.create',
      'pos_sale.create',
      'pos_cash_movement.create',
      'pos_cash_movement.create',
      'pos_shift.close',
    ]);
    expect(entries.every((entry) => entry.shiftId === shift.id)).toBe(true);
    // The carts went with the shift, and nothing sells on it now
    expect(await copy.db.posCarts.count()).toBe(0);
    const late = await savePosSale(copy, {
      input: sale(register.id, shift.id),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: OPENED,
    });
    expect(late.kind).toBe('no-shift');
    // The next shift goes on from this one, and compares with its count
    const next = await open(copy, register, '7640.00');
    expect(next.start).toMatchObject({ number: 'POS1-S0002', first: false, cashLeft: '7640.00' });
  });
});

describe('held carts', () => {
  it('holds up to the limit, resumes one in the screen cart’s place, and a sale clears the screen', async () => {
    const { copy, register } = await counter();
    const { shift } = await open(copy, register);
    await saveScreenCart(copy, shift.id, held(null, 2));
    expect(await holdCart(copy, shift.id, held('Blue shirt'))).toBe('held');
    // Holding takes the cart off the screen: a reload brings back an empty one
    expect(await screenCart(copy, shift.id)).toBeNull();
    for (let index = 1; index < MAX_HELD_CARTS; index += 1) {
      await holdCart(copy, shift.id, { ...held(`Bill ${String(index)}`), heldAt: OPENED });
    }
    expect(await holdCart(copy, shift.id, held('One too many'))).toBe('full');
    expect(await heldCount(copy, shift.id)).toBe(MAX_HELD_CARTS);

    // Resuming with a cart on the screen swaps the two: the count stays, nothing is lost
    const [first] = await heldCarts(copy, shift.id);
    if (!first) throw new Error('no held cart');
    const screen = held('On the screen', 3);
    const resumed = await resumeCart(copy, shift.id, first.id, screen);
    expect(resumed?.name).toBe('Blue shirt');
    expect(await heldCount(copy, shift.id)).toBe(MAX_HELD_CARTS);
    expect((await screenCart(copy, shift.id))?.lines).toHaveLength(1);
    // Gone already (another tab): nothing changes
    expect(await resumeCart(copy, shift.id, first.id, null)).toBeNull();

    // The sale of the screen's cart takes it off the device in its own transaction
    await savePosSale(copy, {
      input: sale(register.id, shift.id),
      registerCode: 'POS1',
      total: '840.0000',
      savedAt: OPENED,
    });
    expect(await screenCart(copy, shift.id)).toBeNull();
    // Another shift's screen cart is not this one's
    await saveScreenCart(copy, shift.id, held(null));
    expect(await screenCart(copy, uuidv7())).toBeNull();
  });
});
