import {
  addMoney,
  cashDifferenceOf,
  compareMoney,
  expectedCashOf,
  formatShiftNumber,
  MAX_HELD_CARTS,
  type PosCashMovementInput,
  type PosShiftCloseInput,
  type PosShiftOpenInput,
  type PosShiftReport,
  type PosShiftReportKind,
  type SyncCommand,
  type SyncPosCashReason,
  type SyncPosRegister,
  type TenderAmount,
  tenderAmountsOf,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { SCREEN_CART } from './carts.js';
import type { LocalCopy } from './copy.js';
import type {
  DeviceShift,
  OutboxEntry,
  ShiftRow,
  ShiftTally,
  StoredShift,
  SyncDatabase,
} from './database.js';
import { openRows, sealEntry } from './sealed.js';

// Step 20b: the shift on the device. The device opens it, adds up its cash as it sells and moves
// money, and closes it; each step is a command in the outbox (sync.ts), in the same transaction as
// the shift's row, so the row and the outbox never disagree. No Dexie import, like pos.ts.

// What the lock screen and the sign-out ask about, from the row's clear fields: no key needed
export type ShiftState = Pick<ShiftRow, 'shiftId' | 'registerId' | 'number' | 'status'>;

export async function shiftState(db: SyncDatabase): Promise<ShiftState | null> {
  const row = await db.posShift.get('shift');
  return row
    ? { shiftId: row.shiftId, registerId: row.registerId, number: row.number, status: row.status }
    : null;
}

// Step 20c: nothing counted yet. A shift opened before the update starts its X report from here.
export const EMPTY_TALLY: ShiftTally = {
  saleCount: 0,
  salesTotal: '0',
  salesDiscount: '0',
  salesVat: '0',
  returnCount: 0,
  returnsTotal: '0',
  returnsVat: '0',
  taken: [],
  refunded: [],
};

// Step 20c: a box as a DeviceShift. A shift opened before the update was saved without the cash
// refunded and the tally: no return was made in it, so they start at nothing.
function deviceShiftOf(stored: StoredShift): DeviceShift {
  return {
    ...stored,
    cash: { ...stored.cash, cashRefunded: stored.cash.cashRefunded ?? '0' },
    tally: stored.tally ?? EMPTY_TALLY,
  };
}

async function openStored(copy: LocalCopy, row: ShiftRow): Promise<DeviceShift> {
  return deviceShiftOf(await copy.open('posShift', 'shift', row.box));
}

export async function readShift(copy: LocalCopy): Promise<DeviceShift | null> {
  const row = await copy.db.posShift.get('shift');
  return row ? openStored(copy, row) : null;
}

// The reasons the cashier picks from, "in" first, then by name, like the settings page (decision
// 62). The copy has the active ones only.
export async function localCashReasons(copy: LocalCopy): Promise<SyncPosCashReason[]> {
  const reasons = await openRows(copy, 'posCashReasons', await copy.db.posCashReasons.toArray());
  return reasons.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
}

async function sealShift(copy: LocalCopy, shift: DeviceShift, rev: number): Promise<ShiftRow> {
  return {
    key: 'shift',
    shiftId: shift.id,
    registerId: shift.registerId,
    number: shift.number,
    status: shift.status,
    rev,
    box: await copy.seal('posShift', 'shift', shift),
  };
}

// The open shift with this id, and its row as it was read (for the write's check). null = it closed
// meanwhile (another tab), or another shift is the device's now.
async function openShiftOf(
  copy: LocalCopy,
  shiftId: string,
): Promise<{ row: ShiftRow; shift: DeviceShift } | null> {
  const row = await copy.db.posShift.get('shift');
  if (row?.shiftId !== shiftId || row.status !== 'open') return null;
  return { row, shift: await openStored(copy, row) };
}

// A command of the shift, as the outbox keeps it. `chain` is its customerId: the push holds a
// command back while an earlier one with the same value waits. A shift's commands have their own
// value each, and their order comes from the shift's own rule (push.ts → pickBatch).
function shiftEntry(
  command: SyncCommand,
  fields: { shiftId: string; chain: string; key: string; name: string; total: string | null },
  savedAt: string,
): OutboxEntry {
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    customerId: fields.chain,
    key: fields.key,
    base: null,
    name: fields.name,
    lines: null,
    total: fields.total,
    savedAt,
    shiftId: fields.shiftId,
  };
}

const SAVE_ATTEMPTS = 3;

function tooManyTries(): never {
  throw new Error('The shift kept changing during the save');
}

// ---------------------------------------------------------------------------------------------
// Opening

// Where the next shift of a register goes on from: its number, and what the drawer should hold.
// This device's own last shift of the register when it is the latest (its close may not have
// reached the server yet), else the register's lastShift from the pull (decision 17). first = the
// register never had a shift: there is nothing to compare with, and the count is the float
// (decision 12). cashLeft is null for a first shift, and when the server's last shift is still
// open there (a device lost with it): the server compares, the device has nothing to say.
export interface ShiftStart {
  sequence: number;
  number: string;
  first: boolean;
  cashLeft: string | null;
}

export function shiftStart(
  register: Pick<SyncPosRegister, 'id' | 'code' | 'lastShift'>,
  own: DeviceShift | null,
): ShiftStart {
  const server = register.lastShift;
  const mine = own?.registerId === register.id && own.status === 'closed' ? own : null;
  const next = (sequence: number) => ({
    sequence: sequence + 1,
    number: formatShiftNumber(register.code, sequence + 1),
  });
  if (mine && (!server || mine.sequence >= server.sequence)) {
    return { ...next(mine.sequence), first: false, cashLeft: mine.counted };
  }
  if (server) return { ...next(server.sequence), first: false, cashLeft: server.cashLeft };
  return { ...next(0), first: true, cashLeft: null };
}

export interface ShiftOpenSave {
  register: Pick<SyncPosRegister, 'id' | 'code' | 'lastShift'>;
  // posShiftOpenInputSchema's output, less what the save decides
  input: Omit<PosShiftOpenInput, 'registerId' | 'sequence'>;
  savedAt: string;
}

// opened: the shift and where it started from (the toast says the difference). not-held: the
// claim is gone or is another register's. open-already: another tab opened a shift meanwhile.
export type ShiftOpenResult =
  | { kind: 'opened'; shift: DeviceShift; start: ShiftStart }
  | { kind: 'not-held' }
  | { kind: 'open-already' };

// The claim, the shift's row and the outbox in one transaction, like a sale's number: the shift is
// open on the device only when its open is in the outbox. Sealed first, written only if the claim
// and the row are still the ones read (another tab), else again from what is there now.
export async function openShift(copy: LocalCopy, save: ShiftOpenSave): Promise<ShiftOpenResult> {
  const { db } = copy;
  const { register, input } = save;
  const shiftId = uuidv7();
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const claim = await db.registerClaim.get('claim');
    if (claim?.registerId !== register.id) return { kind: 'not-held' };
    const before = await db.posShift.get('shift');
    const own = before ? await openStored(copy, before) : null;
    if (own?.status === 'open') return { kind: 'open-already' };
    const start = shiftStart(register, own);
    const shift: DeviceShift = {
      id: shiftId,
      registerId: register.id,
      sequence: start.sequence,
      number: start.number,
      status: 'open',
      openedAt: input.openedAt,
      openingDate: input.date,
      opening: input.opening,
      // A first shift's float is its opening, not a pay in (expectedCashOf counts it once)
      cash: {
        opening: input.opening.total,
        cashTaken: '0',
        changeGiven: '0',
        paidIn: '0',
        paidOut: '0',
        cashRefunded: '0',
      },
      tally: EMPTY_TALLY,
      closedAt: null,
      counted: null,
      expected: null,
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_shift.open',
      shiftId,
      input: {
        ...input,
        registerId: register.id,
        sequence: start.sequence,
        // Only a first shift names where its float came from (the server ignores it otherwise)
        floatReasonId: start.first ? input.floatReasonId : null,
      },
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        { shiftId, chain: shiftId, key: shiftId, name: start.number, total: input.opening.total },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, (before?.rev ?? 0) + 1);
    const written = await db.transaction(
      'rw',
      [db.registerClaim, db.posShift, db.outbox],
      async () => {
        const now = await db.registerClaim.get('claim');
        if (now?.registerId !== register.id) return 'not-held';
        if ((await db.posShift.get('shift'))?.rev !== before?.rev) return 'changed';
        await db.posShift.put(row);
        await db.outbox.add(entry);
        return 'written';
      },
    );
    if (written === 'not-held') return { kind: 'not-held' };
    if (written === 'written') return { kind: 'opened', shift, start };
  }
  return tooManyTries();
}

// ---------------------------------------------------------------------------------------------
// A sale's and a return's money (pos.ts and returns.ts call these inside their own saves)

// What a sale brings into its shift: the cash it took and the change it gave back, and for the X
// report its total, its discounts (the lines' and the bill's), its VAT and what each tender paid
export interface SaleEffect {
  cashTaken: string;
  changeGiven: string;
  total: string;
  discount: string;
  vat: string;
  payments: readonly TenderAmount[];
}

// Step 20c: what a return takes out of its shift: the cash given back, and for the X report its
// total, its VAT and what each tender paid back (an exchange's money as `exchange`)
export interface ReturnEffect {
  cashRefunded: string;
  total: string;
  vat: string;
  refunds: readonly TenderAmount[];
}

export function shiftAfterSale(shift: DeviceShift, sale: SaleEffect): DeviceShift {
  const { cash, tally } = shift;
  return {
    ...shift,
    cash: {
      ...cash,
      cashTaken: addMoney(cash.cashTaken, sale.cashTaken),
      changeGiven: addMoney(cash.changeGiven, sale.changeGiven),
    },
    tally: {
      ...tally,
      saleCount: tally.saleCount + 1,
      salesTotal: addMoney(tally.salesTotal, sale.total),
      salesDiscount: addMoney(tally.salesDiscount, sale.discount),
      salesVat: addMoney(tally.salesVat, sale.vat),
      taken: tenderAmountsOf([...tally.taken, ...sale.payments]),
    },
  };
}

export function shiftAfterReturn(shift: DeviceShift, given: ReturnEffect): DeviceShift {
  const { cash, tally } = shift;
  return {
    ...shift,
    cash: { ...cash, cashRefunded: addMoney(cash.cashRefunded, given.cashRefunded) },
    tally: {
      ...tally,
      returnCount: tally.returnCount + 1,
      returnsTotal: addMoney(tally.returnsTotal, given.total),
      returnsVat: addMoney(tally.returnsVat, given.vat),
      refunded: tenderAmountsOf([...tally.refunded, ...given.refunds]),
    },
  };
}

// The save reads the shift and writes it back changed, with its sale or its return; null = no open
// shift with this id. The save checks the rev inside its transaction.
export async function shiftAfter(
  copy: LocalCopy,
  shiftId: string,
  change: (shift: DeviceShift) => DeviceShift,
): Promise<{ before: ShiftRow; row: ShiftRow; shift: DeviceShift } | null> {
  const open = await openShiftOf(copy, shiftId);
  if (!open) return null;
  const shift = change(open.shift);
  return { before: open.row, row: await sealShift(copy, shift, open.row.rev + 1), shift };
}

// ---------------------------------------------------------------------------------------------
// Pay in and pay out

export interface CashMoveSave {
  // posCashMovementInputSchema's output
  input: PosCashMovementInput;
  direction: SyncPosCashReason['direction'];
  // The Sync page's name for it, in the cashier's language: "৳10,000 paid out for Cash to the bank"
  name: string;
  savedAt: string;
}

// too-large: a pay out of more than the drawer should hold (pos_pay_out_too_large). The device
// knows the expected cash, and the cashier does not see it (decision 3): only this answer says it.
export type CashMoveResult = { kind: 'saved' } | { kind: 'no-shift' } | { kind: 'too-large' };

export async function moveCash(copy: LocalCopy, save: CashMoveSave): Promise<CashMoveResult> {
  const { db } = copy;
  const { input } = save;
  const movementId = uuidv7();
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const open = await openShiftOf(copy, input.shiftId);
    if (!open) return { kind: 'no-shift' };
    const { cash } = open.shift;
    if (save.direction === 'out' && compareMoney(input.amount, expectedCashOf(cash)) > 0) {
      return { kind: 'too-large' };
    }
    const shift: DeviceShift = {
      ...open.shift,
      cash:
        save.direction === 'in'
          ? { ...cash, paidIn: addMoney(cash.paidIn, input.amount) }
          : { ...cash, paidOut: addMoney(cash.paidOut, input.amount) },
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_cash_movement.create',
      movementId,
      input,
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        {
          shiftId: input.shiftId,
          chain: movementId,
          key: movementId,
          name: save.name,
          total: input.amount,
        },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, open.row.rev + 1);
    const written = await db.transaction('rw', [db.posShift, db.outbox], async () => {
      if ((await db.posShift.get('shift'))?.rev !== open.row.rev) return false;
      await db.posShift.put(row);
      await db.outbox.add(entry);
      return true;
    });
    if (written) return { kind: 'saved' };
  }
  return tooManyTries();
}

// ---------------------------------------------------------------------------------------------
// Closing

export interface ShiftCloseSave {
  shiftId: string;
  // posShiftCloseInputSchema's output, less what the device works out
  input: Omit<PosShiftCloseInput, 'deviceExpected' | 'heldDropped'>;
  savedAt: string;
}

// closed: the shift as the result screen shows it (counted, expected), and the difference
// (counted less expected: above zero = over). no-shift: closed already (another tab).
export type ShiftCloseResult =
  { kind: 'closed'; shift: DeviceShift; difference: string } | { kind: 'no-shift' };

// The close is final (decision 9). It drops the shift's carts, held or on the screen, in the same
// transaction, and says how many held ones it dropped; they are counted again inside it, so a hold
// in another tab meanwhile makes the save start again rather than send a wrong number.
export async function closeShift(copy: LocalCopy, save: ShiftCloseSave): Promise<ShiftCloseResult> {
  const { db } = copy;
  const { shiftId, input } = save;
  const heldOf = async () =>
    (await db.posCarts.where('shiftId').equals(shiftId).primaryKeys()).filter(
      (key) => key !== SCREEN_CART,
    ).length;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
    const open = await openShiftOf(copy, shiftId);
    if (!open) return { kind: 'no-shift' };
    const held = await heldOf();
    const expected = expectedCashOf(open.shift.cash);
    const shift: DeviceShift = {
      ...open.shift,
      status: 'closed',
      closedAt: input.closedAt,
      counted: input.counted.total,
      expected,
    };
    const command: SyncCommand = {
      id: uuidv7(),
      type: 'pos_shift.close',
      shiftId,
      input: { ...input, deviceExpected: expected, heldDropped: Math.min(held, MAX_HELD_CARTS) },
    };
    const entry = await sealEntry(
      copy,
      shiftEntry(
        command,
        { shiftId, chain: command.id, key: shiftId, name: open.shift.number, total: null },
        save.savedAt,
      ),
    );
    const row = await sealShift(copy, shift, open.row.rev + 1);
    const written = await db.transaction('rw', [db.posShift, db.posCarts, db.outbox], async () => {
      if ((await db.posShift.get('shift'))?.rev !== open.row.rev) return false;
      if ((await heldOf()) !== held) return false;
      await db.posShift.put(row);
      await db.posCarts.where('shiftId').equals(shiftId).delete();
      await db.outbox.add(entry);
      return true;
    });
    if (written) {
      return { kind: 'closed', shift, difference: cashDifferenceOf(input.counted.total, expected) };
    }
  }
  return tooManyTries();
}

// ---------------------------------------------------------------------------------------------
// Step 20c: the shift's reports

export interface ShiftReportFields {
  kind: PosShiftReportKind;
  register: { code: string; name: string };
  cashierName: string;
  printedAt: string;
}

// The X report (the shift still open) or the Z report (closed), from the device's own shift: the
// device prints it offline too. The X report is blind (decision 9): no drawer, so it never tells
// the cashier what the count should come to. The Z report has the drawer, once the shift is closed
// with a count.
export function shiftReportOf(shift: DeviceShift, fields: ShiftReportFields): PosShiftReport {
  const { cash, tally } = shift;
  const drawer =
    fields.kind === 'z' && shift.counted !== null && shift.expected !== null
      ? {
          ...cash,
          expected: shift.expected,
          counted: shift.counted,
          difference: cashDifferenceOf(shift.counted, shift.expected),
        }
      : null;
  return {
    kind: fields.kind,
    register: fields.register,
    shiftNumber: shift.number,
    cashierName: fields.cashierName,
    openedAt: shift.openedAt,
    closedAt: fields.kind === 'z' ? shift.closedAt : null,
    printedAt: fields.printedAt,
    saleCount: tally.saleCount,
    salesTotal: tally.salesTotal,
    salesDiscount: tally.salesDiscount,
    salesVat: tally.salesVat,
    returnCount: tally.returnCount,
    returnsTotal: tally.returnsTotal,
    returnsVat: tally.returnsVat,
    taken: tally.taken,
    refunded: tally.refunded,
    paidIn: cash.paidIn,
    paidOut: cash.paidOut,
    drawer,
  };
}
