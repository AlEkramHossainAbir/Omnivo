import {
  absMoney,
  addMoney,
  type CashCount,
  cashDifferenceOf,
  compareMoney,
  type EntryRef,
  formatShiftNumber,
  isOverVarianceAlert,
  isPartyAccountPurpose,
  isZeroMoney,
  POS_TENDERS,
  type PosCashMovementInput,
  type PosCashReason,
  type PosCashReasonInput,
  type posCashReasonListQuerySchema,
  type PosShift,
  type PosShiftCloseInput,
  type posShiftListQuerySchema,
  type PosShiftOpenInput,
  type PosShiftPage,
  type PosShiftSummary,
  type PosTender,
  subtractMoney,
  sumMoney,
  todayIn,
  type UpdatePosCashReasonInput,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { codeOf } from './accounting-data';
import { OWNER } from './fixtures';
import { postNew, stockAccountIds } from './journal-data';
import { MockProblem } from './mock';
import {
  accountOf,
  bookingDay,
  deviceShift,
  type MockMovement,
  type MockRegister,
  type MockShift,
  shiftCash,
  toRegister,
} from './pos-data';
import { fieldProblem, pageOf } from './sales-document-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20b: the pay in and pay out reasons, and the shifts the devices push. The API's
// pos-cash-reasons.service.ts and pos-shifts.service.ts on plain arrays, shortened. The rows live
// in data.pos beside the registers and the sales (pos-data.ts), which read a register's latest
// shift and a sale's shift from them. Like pos-data.ts, this file writes no audit rows: its
// callers (handlers.ts, push-data.ts, device-data.ts) do, since workspace-data.ts imports this
// file for the seed and record() lives there.

function now(): string {
  return new Date().toISOString();
}

// A count as the API stores and answers it: the device's notes, and the total with 2 decimals
// (numeric with 4, the last two zeros cut: the API's countTotal())
function storedCount(count: CashCount): CashCount {
  return { notes: count.notes, total: addMoney(count.total, '0').replace(/(\.\d{2})00$/, '$1') };
}

export function personName(data: WorkspaceData, userId: string): string {
  if (userId === OWNER.id) return OWNER.fullName;
  return data.people.members.find((member) => member.userId === userId)?.fullName ?? '';
}

// --- The seed -----------------------------------------------------------------------------------

function reason(
  data: WorkspaceData,
  name: string,
  direction: PosCashReason['direction'],
  code: string,
  archived = false,
): PosCashReason | null {
  const account = data.accounts.find((item) => item.code === code);
  if (!account) return null;
  const created: PosCashReason = {
    id: crypto.randomUUID(),
    name,
    direction,
    accountId: account.id,
    archivedAt: archived ? now() : null,
    version: archived ? 2 : 1,
    updatedAt: now(),
  };
  data.pos.reasons.push(created);
  return created;
}

// The reasons a shop's counter uses: the owner's float and change from the bank in; the day's
// cash to the bank and tea for the staff out (an expense). Staff lunch was given up, so it is
// archived. The pharma distributor keeps two. Then the outlet's counter (POS2), held by the store
// office PC, has a shift open since this morning: Abdul Karim's, with ৳5,000 from the owner. It
// lets the shifts list show an open shift, and a manager close it without a count. The seed posts
// no entries, like CTG1's 1,260 receipts that have no sales: the books stay what other tests count
// on. After seedPos().
export function seedPosShifts(data: WorkspaceData, garments: boolean): void {
  const float = reason(data, 'Float from the owner', 'in', '3100');
  if (garments) reason(data, 'Change from the bank', 'in', '1121');
  reason(data, 'Cash to the bank', 'out', '1121');
  if (!garments) return;
  reason(data, 'Tea for the staff', 'out', '5290');
  reason(data, 'Staff lunch', 'out', '5290', true);

  const outlet = data.pos.registers.find((item) => item.code === 'POS2');
  const holder = data.sync.devices.find((device) => device.id === outlet?.deviceId);
  if (!outlet || !holder) return;
  const openedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  data.pos.shifts.push({
    id: crypto.randomUUID(),
    registerId: outlet.id,
    deviceId: holder.id,
    cashierId: holder.userId,
    sequence: 1,
    number: formatShiftNumber(outlet.code, 1),
    status: 'open',
    openedAt,
    closedAt: null,
    opening: {
      count: storedCount({
        notes: {
          '1000': 3,
          '500': 2,
          '200': 5,
          '100': 0,
          '50': 0,
          '20': 0,
          '10': 0,
          '5': 0,
          '2': 0,
          '1': 0,
        },
        total: '5000',
      }),
      date: todayIn(data.settings.timezone),
      comparedWith: null,
      floatReasonId: float?.id ?? null,
      entry: null,
    },
    closing: null,
    expectedCash: null,
    closedBy: null,
  });
}

// --- Reasons (Settings → POS cash reasons) ------------------------------------------------------

export function findCashReason(data: WorkspaceData, id: string): PosCashReason {
  const found = data.pos.reasons.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// In and out apart, then by name, as the page and the cashier's select show them
export function listCashReasons(
  data: WorkspaceData,
  query: z.output<typeof posCashReasonListQuerySchema>,
): PosCashReason[] {
  return data.pos.reasons
    .filter((item) => (item.archivedAt === null) === (query.status === 'active'))
    .toSorted(
      (a, b) =>
        a.direction.localeCompare(b.direction) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
}

// What the audit log shows: the account by its code
export function reasonSnapshot(
  data: WorkspaceData,
  item: PosCashReason,
): Record<string, string | null> {
  return {
    name: item.name,
    direction: item.direction,
    account: codeOf(data.accounts, item.accountId),
  };
}

// The API's checkAccount(): active, not a group, not one kept per party, not a stock account
function checkReasonAccount(data: WorkspaceData, accountId: string): void {
  const account = data.accounts.find((item) => item.id === accountId);
  if (
    !account ||
    account.isGroup ||
    account.archivedAt !== null ||
    isPartyAccountPurpose(account.purpose) ||
    stockAccountIds(data).has(accountId)
  ) {
    throw fieldProblem('pos_reason_account_invalid', 'accountId');
  }
}

// One name per workspace, archived ones too (pos_cash_reasons_tenant_name_idx)
function checkName(data: WorkspaceData, name: string, id?: string): void {
  if (
    data.pos.reasons.some(
      (item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw fieldProblem('pos_reason_name_taken', 'name');
  }
}

export function createCashReason(data: WorkspaceData, input: PosCashReasonInput): PosCashReason {
  checkReasonAccount(data, input.accountId);
  checkName(data, input.name);
  const created: PosCashReason = {
    id: crypto.randomUUID(),
    name: input.name,
    direction: input.direction,
    accountId: input.accountId,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.pos.reasons.push(created);
  return created;
}

// The name and the account; the direction never changes. Only a new account must be usable: an
// archived reason keeps an account archived since.
export function updateCashReason(
  data: WorkspaceData,
  target: PosCashReason,
  input: Omit<UpdatePosCashReasonInput, 'version'>,
): void {
  if (input.accountId !== target.accountId) checkReasonAccount(data, input.accountId);
  checkName(data, input.name, target.id);
  Object.assign(target, {
    name: input.name,
    accountId: input.accountId,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// A reason comes back only with a usable account
export function setReasonArchived(
  data: WorkspaceData,
  target: PosCashReason,
  archived: boolean,
): void {
  if ((target.archivedAt !== null) === archived) return;
  if (!archived) checkReasonAccount(data, target.accountId);
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// --- The books ----------------------------------------------------------------------------------

interface ShiftDocument {
  id: string;
  number: string;
  date: string;
  branchId: string;
}

// One entry of two lines with the branch of the register's warehouse, the journal source
// pos_shift pointing at the shift. null for nothing.
function postMove(
  data: WorkspaceData,
  document: ShiftDocument,
  move: { debit: string; credit: string; amount: string },
  narration: string,
): EntryRef | null {
  if (isZeroMoney(move.amount)) return null;
  const line = { branchId: document.branchId, partyId: null, description: null };
  const entry = postNew(
    data,
    {
      date: document.date,
      narration,
      lines: [
        { ...line, accountId: move.debit, debit: move.amount, credit: '0' },
        { ...line, accountId: move.credit, debit: '0', credit: move.amount },
      ],
    },
    'pos_shift',
    { id: document.id, number: document.number },
  );
  return { id: entry.id, number: entry.number ?? '' };
}

// Over (above zero) comes in from over/short to the register's cash, short the other way
function postDifference(
  data: WorkspaceData,
  document: ShiftDocument,
  register: MockRegister,
  difference: string,
  narration: string,
): EntryRef | null {
  if (isZeroMoney(difference)) return null;
  const overShort = register.overShortAccountId;
  // A register from 20a opens no shift without it (decision 13): only a bug gets here
  if (overShort === null) throw new MockProblem(409, 'pos_over_short_required');
  const amount = absMoney(difference);
  return postMove(
    data,
    document,
    compareMoney(difference, '0') > 0
      ? { debit: register.accounts.cash, credit: overShort, amount }
      : { debit: overShort, credit: register.accounts.cash, amount },
    narration,
  );
}

function registerOf(data: WorkspaceData, shift: MockShift): MockRegister {
  const found = data.pos.registers.find((item) => item.id === shift.registerId);
  if (!found) throw new Error(`POS register ${shift.registerId} of a shift is missing`);
  return found;
}

function latestShift(data: WorkspaceData, registerId: string): MockShift | undefined {
  return data.pos.shifts
    .filter((shift) => shift.registerId === registerId)
    .toSorted((a, b) => b.sequence - a.sequence)[0];
}

// --- From the device (push-data.ts, inside its transaction) -------------------------------------

// The API's openFromDevice(): the opening count compared with what the last shift left (the
// difference to over/short), or a first shift's float from its "in" reason's account
export function openShift(
  data: WorkspaceData,
  device: { id: string; userId: string },
  shiftId: string,
  input: PosShiftOpenInput,
): { shift: MockShift; floatReason: string | null } {
  const register = data.pos.registers.find((item) => item.id === input.registerId);
  if (register?.deviceId !== device.id) throw fieldProblem('pos_register_not_held', 'registerId');
  const number = formatShiftNumber(register.code, input.sequence);
  const last = latestShift(data, register.id);
  if (last?.status === 'open') throw new MockProblem(409, 'pos_shift_already_open');
  // What should be in the drawer: the last count, or what the server expects now (decision 63)
  const comparedWith =
    last === undefined
      ? null
      : last.status === 'closed_without_count'
        ? shiftCash(data, last).expected
        : addMoney(last.closing?.count.total ?? '0', '0');
  if (data.pos.shifts.some((shift) => shift.id === shiftId)) {
    throw new MockProblem(409, 'sync_id_taken');
  }
  if (data.pos.shifts.some((shift) => shift.number === number)) {
    throw fieldProblem('pos_number_taken', 'sequence');
  }

  const date = bookingDay(data, input.date);
  const opening = input.opening.total;
  const document = { id: shiftId, number, date, branchId: toRegister(data, register).branchId };
  let floatReason: PosCashReason | null = null;
  let entry: EntryRef | null;
  if (comparedWith !== null) {
    entry = postDifference(
      data,
      document,
      register,
      cashDifferenceOf(opening, comparedWith),
      `POS shift ${number}: opening count`,
    );
  } else if (input.floatReasonId !== null) {
    floatReason = data.pos.reasons.find((item) => item.id === input.floatReasonId) ?? null;
    if (floatReason?.direction !== 'in') {
      throw fieldProblem('pos_float_reason_required', 'floatReasonId');
    }
    entry = postMove(
      data,
      document,
      { debit: register.accounts.cash, credit: floatReason.accountId, amount: opening },
      `POS shift ${number}: float, ${floatReason.name}`,
    );
  } else {
    // A first shift without a reason: only a bug gets here, and over/short takes the money
    entry = postDifference(data, document, register, opening, `POS shift ${number}: opening count`);
  }

  const shift: MockShift = {
    id: shiftId,
    registerId: register.id,
    deviceId: device.id,
    cashierId: device.userId,
    sequence: input.sequence,
    number,
    status: 'open',
    openedAt: input.openedAt,
    closedAt: null,
    opening: {
      count: storedCount(input.opening),
      date,
      comparedWith,
      floatReasonId: floatReason?.id ?? null,
      entry,
    },
    closing: null,
    expectedCash: null,
    closedBy: null,
  };
  data.pos.shifts.push(shift);
  return { shift, floatReason: floatReason?.name ?? null };
}

// The API's moveCashFromDevice(): Dr cash / Cr the reason's account, or the other way. Also for a
// shift closed since (the money moved), and with a reason archived since.
export function moveCash(
  data: WorkspaceData,
  deviceId: string,
  movementId: string,
  input: PosCashMovementInput,
): { shift: MockShift; movement: MockMovement; reason: PosCashReason } {
  const shift = deviceShift(data, input.shiftId, deviceId);
  const found = data.pos.reasons.find((item) => item.id === input.reasonId);
  if (!found) throw fieldProblem('pos_reason_required', 'reasonId');
  if (data.pos.movements.some((movement) => movement.id === movementId)) {
    throw new MockProblem(409, 'sync_id_taken');
  }
  const register = registerOf(data, shift);
  const date = bookingDay(data, input.date);
  const cash = register.accounts.cash;
  const entry = postMove(
    data,
    { id: shift.id, number: shift.number, date, branchId: toRegister(data, register).branchId },
    found.direction === 'in'
      ? { debit: cash, credit: found.accountId, amount: input.amount }
      : { debit: found.accountId, credit: cash, amount: input.amount },
    `POS shift ${shift.number}: pay ${found.direction}, ${found.name}`,
  );
  if (entry === null) throw new Error('A pay in or pay out above zero posted nothing');
  const movement: MockMovement = {
    id: movementId,
    shiftId: shift.id,
    reasonId: found.id,
    direction: found.direction,
    amount: addMoney(input.amount, '0'),
    note: input.note,
    date,
    movedAt: input.movedAt,
    accountId: found.accountId,
    entry,
  };
  data.pos.movements.push(movement);
  return { shift, movement, reason: found };
}

export type CloseResult =
  // Decision 38: closed without a count before this arrived; the count goes to the audit log only
  | { kept: false; shift: MockShift; statusBefore: MockShift['status'] }
  | {
      kept: true;
      shift: MockShift;
      expected: string;
      difference: string;
      date: string;
      entry: EntryRef | null;
    };

// The API's closeFromDevice(): the expected cash worked out again from the mock's rows, the
// difference to over/short, and the bell over the register's limit (last: nothing after it throws)
export function closeShift(
  data: WorkspaceData,
  deviceId: string,
  shiftId: string,
  input: PosShiftCloseInput,
): CloseResult {
  const shift = data.pos.shifts.find((item) => item.id === shiftId);
  if (shift?.deviceId !== deviceId) throw fieldProblem('pos_shift_unknown', 'shiftId');
  if (shift.status !== 'open') return { kept: false, shift, statusBefore: shift.status };

  const register = registerOf(data, shift);
  const { expected } = shiftCash(data, shift);
  const counted = input.counted.total;
  const difference = cashDifferenceOf(counted, expected);
  const date = bookingDay(data, input.date);
  const entry = postDifference(
    data,
    { id: shift.id, number: shift.number, date, branchId: toRegister(data, register).branchId },
    register,
    difference,
    `POS shift ${shift.number}: closing count`,
  );
  Object.assign(shift, {
    status: 'closed',
    closedAt: input.closedAt,
    closing: {
      count: storedCount(input.counted),
      date,
      deviceExpected: input.deviceExpected,
      heldDropped: input.heldDropped,
      entry,
    },
    expectedCash: expected,
  } satisfies Partial<MockShift>);

  // Decision 5: the managers hear about a big difference. The mock's person is the owner, who is
  // always one of them.
  if (isOverVarianceAlert(difference, register.varianceAlert)) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'pos.shift_variance',
      params: { id: shift.id, number: shift.number, register: register.name, difference },
      readAt: null,
      createdAt: now(),
    });
  }
  return { kept: true, shift, expected, difference, date, entry };
}

// --- For the managers (pos.shift.manage) --------------------------------------------------------

export function findShift(data: WorkspaceData, id: string): MockShift {
  const found = data.pos.shifts.find((shift) => shift.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// A list row. A counted shift shows what the drawer should have held at its close; an open one,
// and one closed without a count, what it should hold now (late sales count, decision 63). Step
// 20c: with the returns its drawer paid back, whatever shift sold the goods.
function toSummary(data: WorkspaceData, shift: MockShift): PosShiftSummary {
  const register = toRegister(data, registerOf(data, shift));
  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
  const returns = data.pos.returns.filter((item) => item.shiftId === shift.id);
  const counted = shift.closing === null ? null : addMoney(shift.closing.count.total, '0');
  return {
    id: shift.id,
    number: shift.number,
    register: { id: register.id, code: register.code, name: register.name },
    branchId: register.branchId,
    sequence: shift.sequence,
    status: shift.status,
    cashier: { id: shift.cashierId, fullName: personName(data, shift.cashierId) },
    device: {
      id: shift.deviceId,
      name: data.sync.devices.find((device) => device.id === shift.deviceId)?.name ?? '',
    },
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
    openingCash: shift.opening.count.total,
    expectedCash:
      shift.status === 'closed' && shift.expectedCash !== null
        ? shift.expectedCash
        : shiftCash(data, shift).expected,
    countedCash: shift.closing?.count.total ?? null,
    difference:
      counted === null || shift.expectedCash === null
        ? null
        : cashDifferenceOf(counted, shift.expectedCash),
    saleCount: sales.length,
    salesTotal: sumMoney(sales.map((sale) => sale.total)),
    returnCount: returns.length,
    returnsTotal: sumMoney(returns.map((item) => item.total)),
  };
}

// Newest first by the device's clock, then by id, like the API's cursor
export function listShifts(
  data: WorkspaceData,
  query: z.output<typeof posShiftListQuerySchema>,
): PosShiftPage {
  const matching = data.pos.shifts
    .filter(
      (shift) =>
        (query.registerId === undefined || shift.registerId === query.registerId) &&
        (query.status === undefined || shift.status === query.status),
    )
    .toSorted((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id));
  const page = pageOf(matching, query);
  return { ...page, items: page.items.map((shift) => toSummary(data, shift)) };
}

// One shift with everything its page shows
export function toShift(data: WorkspaceData, shift: MockShift): PosShift {
  const register = registerOf(data, shift);
  const cash = shiftCash(data, shift);
  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
  const returns = data.pos.returns.filter((item) => item.shiftId === shift.id);
  // What the sales took by each tender: every method the register takes now, and any other one a
  // sale of the shift was paid with, cash first. Step 20c: and what its returns paid back, the
  // same way. Exchange is never "taken" by a register: shown only when a sale or a return used it.
  const perTender = (paid: readonly { method: PosTender; amount: string }[]) =>
    POS_TENDERS.flatMap((method) => {
      const amounts = paid.filter((item) => item.method === method).map((item) => item.amount);
      if (amounts.length === 0 && (method === 'exchange' || accountOf(register, method) === null)) {
        return [];
      }
      return [{ method, amount: sumMoney(amounts) }];
    });
  const floatReason = data.pos.reasons.find((item) => item.id === shift.opening.floatReasonId);
  const { opening } = shift;
  return {
    ...toSummary(data, shift),
    opening: {
      count: opening.count,
      date: opening.date,
      comparedWith: opening.comparedWith,
      difference:
        opening.comparedWith === null
          ? null
          : subtractMoney(addMoney(opening.count.total, '0'), opening.comparedWith),
      floatReason: floatReason ? { id: floatReason.id, name: floatReason.name } : null,
      entry: opening.entry,
    },
    closing: shift.status === 'closed' ? shift.closing : null,
    closedBy:
      shift.closedBy === null
        ? null
        : { id: shift.closedBy, fullName: personName(data, shift.closedBy) },
    cash: {
      opening: cash.opening,
      cashTaken: cash.cashTaken,
      changeGiven: cash.changeGiven,
      paidIn: cash.paidIn,
      paidOut: cash.paidOut,
      cashRefunded: cash.cashRefunded,
    },
    payments: perTender(sales.flatMap((sale) => sale.payments)),
    refunds: perTender(returns.flatMap((item) => item.refunds)),
    // For the Z report: the sales' discounts (each line's and the bill's) and VAT, the returns' VAT
    salesDiscount: sumMoney(sales.map((sale) => addMoney(sale.discount, sale.billDiscountAmount))),
    salesVat: sumMoney(sales.map((sale) => sale.vat)),
    returnsVat: sumMoney(returns.map((item) => item.vat)),
    movements: data.pos.movements
      .filter((movement) => movement.shiftId === shift.id)
      .toSorted((a, b) => a.movedAt.localeCompare(b.movedAt) || a.id.localeCompare(b.id))
      .map((movement) => ({
        id: movement.id,
        reason: {
          id: movement.reasonId,
          name: data.pos.reasons.find((item) => item.id === movement.reasonId)?.name ?? '',
        },
        direction: movement.direction,
        amount: movement.amount,
        note: movement.note,
        date: movement.date,
        movedAt: movement.movedAt,
        accountId: movement.accountId,
        entry: movement.entry,
      })),
  };
}

// Decision 11: nobody counted, so nothing posts. The expected cash now is kept; the next shift's
// opening count is compared with it and finds what is missing. Returns it, for the audit row.
export function closeWithoutCount(
  data: WorkspaceData,
  shift: MockShift,
  closedBy: string,
  closedAt = now(),
): string {
  if (shift.status !== 'open') throw new MockProblem(409, 'pos_shift_closed');
  const { expected } = shiftCash(data, shift);
  Object.assign(shift, {
    status: 'closed_without_count',
    closedAt,
    closedBy,
    expectedCash: expected,
  } satisfies Partial<MockShift>);
  return expected;
}

// --- Devices (device-data.ts) -------------------------------------------------------------------

// The device's open shift, if any: it keeps its register and its branch until the shift closes
export function openShiftOf(data: WorkspaceData, deviceId: string): MockShift | undefined {
  return data.pos.shifts.find((shift) => shift.deviceId === deviceId && shift.status === 'open');
}
