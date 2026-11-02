import {
  addMoney,
  addQuantity,
  type CashCount,
  compareMoney,
  compareQuantity,
  type Device,
  type EntryRef,
  type ErrorCode,
  expectedCashOf,
  formatPosNumber,
  isZeroMoney,
  isWholeQuantity,
  moneyAccountIds,
  negateMoney,
  POS_PAYMENT_METHODS,
  type PosCashDirection,
  type PosCashReason,
  type PosLastShift,
  type PosOverride,
  POS_DEFAULT_RETURN_DAYS,
  posChangeOf,
  posOverridesOf,
  type PosRegister,
  type PosRegisterInput,
  type PosRegisterListItem,
  type posRegisterListQuerySchema,
  type PosSale,
  type PosSaleInput,
  type PosSaleLine,
  posSaleAmounts,
  posSaleLineSchema,
  type posSaleListQuerySchema,
  type PosSalePage,
  posSaleSummarySchema,
  type PosRefund,
  type PosShiftStatus,
  type PosTender,
  type ShiftCash,
  shiftIsoDate,
  type SoldShortItem,
  soldShortItemSchema,
  type soldShortQuerySchema,
  type SoldShortPage,
  stockLineSchema,
  subtractQuantity,
  sumMoney,
  todayIn,
  type UpdatePosRegisterInput,
  wholeCount,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { codeOf } from './accounting-data';
import { OWNER } from './fixtures';
import { salesAccounts } from './invoice-data';
import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  customerOf,
  deliveryAccounts,
  fieldProblem,
  newestFirst,
  pageOf,
  resolveSalesLines,
} from './sales-document-data';
import { balancesOf, branchOf, issuesError, type Move, postMoves } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20a: the POS registers, who holds them, and the sales the devices push. The
// API's pos-registers.service.ts and pos-sales.service.ts on plain arrays, shortened. A sale is
// written only by the push (push-data.ts calls createSale), like the API (decision 21). The audit
// rows are written by the callers (handlers.ts, push-data.ts), which import workspace-data.ts:
// this file is imported by it, for the seed.
// Step 20b: the shifts, their pay ins and outs, and the reasons, kept here beside the registers
// and the sales, because a register's latest shift and a sale's shift are read with them. What
// the devices and the managers do with a shift is pos-shift-data.ts.
// Step 20c: the returns, kept here too, because a sale reads what came back of each line and a
// shift what its returns paid back. What a return does is pos-return-data.ts.

// A register without its branch: the branch is its warehouse's, worked out when it is read, so a
// warehouse moved to another branch takes its free registers along (the API joins warehouses).
// Step 20b: and without its latest shift, which is read from the shifts (the API's lastShiftsOf).
export type MockRegister = Omit<PosRegister, 'branchId' | 'lastShift'>;

// A sale's line as the mock keeps it: the contract's line, plus what the Sold short list reads
// (the API's short_serials column, and the lot of the batch that went below zero). Step 20c:
// without what came back of it, read from the returns when the sale is read, and with what its
// goods cost (the API's value column): a return takes its share of that back into stock.
export interface MockPosLine extends Omit<PosSaleLine, 'returnedQuantity'> {
  shortSerials: string[];
  shortLot: string | null;
  value: string;
}

// The device by its id: its name is the one it has now when the sale is read. Step 20c: its
// returns are read from data.pos.returns, like the API's join.
export type MockPosSale = Omit<PosSale, 'lines' | 'device' | 'returns'> & {
  deviceId: string;
  lines: MockPosLine[];
};

// Step 20c: a POS return as the API's pos_returns row keeps it, with its lines (the product,
// unit, description and price are the sale line's), the batches each went back into and its
// refunds. Never changed once written (0056).
export interface MockReturnLine {
  id: string;
  saleLineId: string;
  // In the sale line's unit, and in the base unit
  quantity: string;
  baseQuantity: string;
  net: string;
  vat: string;
  total: string;
  // This return's share of what the goods cost when sold
  value: string;
  batches: { batchId: string; quantity: string }[];
  serialNumbers: string[];
}

export interface MockReturn {
  id: string;
  registerId: string;
  shiftId: string;
  deviceId: string;
  // The person who pushed it (created_by)
  cashierId: string;
  sequence: number;
  number: string;
  date: string;
  returnedAt: string;
  saleId: string;
  // The register's warehouse: where the goods came back into
  warehouseId: string;
  net: string;
  vat: string;
  total: string;
  note: string | null;
  outsideWindow: boolean;
  createdAt: string;
  lines: MockReturnLine[];
  refunds: PosRefund[];
  entry: EntryRef | null;
}

// A shift as the API's pos_shifts row keeps it (step 20b). The cashier is the device's person
// (created_by); the counts keep the device's notes and a 4-decimal total.
export interface MockShift {
  id: string;
  registerId: string;
  deviceId: string;
  cashierId: string;
  sequence: number;
  number: string;
  status: PosShiftStatus;
  openedAt: string;
  closedAt: string | null;
  opening: {
    count: CashCount;
    date: string;
    // null = the register's first shift
    comparedWith: string | null;
    floatReasonId: string | null;
    entry: EntryRef | null;
  };
  // A counted close; null while open and for a close without a count
  closing: {
    count: CashCount;
    date: string;
    deviceExpected: string;
    heldDropped: number;
    entry: EntryRef | null;
  } | null;
  // What the drawer should have held at the close, either close; null while open
  expectedCash: string | null;
  // Who closed it without a count
  closedBy: string | null;
}

export interface MockMovement {
  id: string;
  shiftId: string;
  reasonId: string;
  direction: PosCashDirection;
  amount: string;
  note: string | null;
  date: string;
  movedAt: string;
  // The reason's account when it was posted
  accountId: string;
  entry: EntryRef;
}

export interface MockPos {
  registers: MockRegister[];
  // Newest first: a new sale is put first
  sales: MockPosSale[];
  // Step 20b: in the order they were added; the lists sort them
  reasons: PosCashReason[];
  shifts: MockShift[];
  movements: MockMovement[];
  // Step 20c: in the order they arrived; the list sorts them
  returns: MockReturn[];
}

export function emptyPos(): MockPos {
  return { registers: [], sales: [], reasons: [], shifts: [], movements: [], returns: [] };
}

function now(): string {
  return new Date().toISOString();
}

// "7.5" → "7.50", the way Postgres sends NUMERIC(5,2). The schema let only 0–100 with at most 2
// decimals through, so the whole part is a plain number.
function percentText(value: string): string {
  const [whole = '0', part = ''] = value.split('.');
  return `${String(Number(whole))}.${part.padEnd(2, '0')}`;
}

// --- The seed -----------------------------------------------------------------------------------

type SeedRegister = Omit<
  MockRegister,
  | 'id'
  | 'archivedAt'
  | 'version'
  | 'updatedAt'
  | 'overShortAccountId'
  | 'varianceAlert'
  | 'lockAfter'
  | 'exchangeAccountId'
  | 'returnDays'
  | 'lastReturnNumber'
>;

// Step 20b: every seeded counter has the over/short account, so a shift opens on it, a bell for a
// difference over ৳500, and no idle lock: the device in the tests has no PIN until a test sets one.
// Step 20c: goods come back for the default 7 days; `exchangeAccountId` null = refunds only.
function register(
  fields: SeedRegister,
  overShortAccountId: string | null,
  exchangeAccountId: string | null = null,
): MockRegister {
  return {
    id: crypto.randomUUID(),
    ...fields,
    overShortAccountId,
    varianceAlert: '500',
    lockAfter: 'off',
    exchangeAccountId,
    returnDays: POS_DEFAULT_RETURN_DAYS,
    lastReturnNumber: 0,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
}

// The garments maker sells its export surplus at a factory outlet in the head office: the
// showroom counter is free, so this browser's device can take it; the outlet's second counter is
// held by the store office PC (seedDevices()), and stays in the list with that name. The
// Chattogram depot's counter was held by the depot computer revoked 12 days ago: the revoke freed
// it, and its numbers go on from 1,260. The pharma distributor has one counter at its depot.
// After seedDevices(): the outlet's counter names one of its devices. Step 20c: the head office's
// two counters make exchanges, through 2190 POS exchange clearing; the depot's counter and the
// pharmacy's only pay money back.
export function seedPos(data: WorkspaceData, garments: boolean): void {
  const byCode = (code: string) => data.stock.warehouses.find((place) => place.code === code);
  const account = (code: string) => data.accounts.find((row) => row.code === code)?.id ?? null;
  const main = byCode('MAIN');
  const cash = account('1110');
  if (!main || cash === null) return;
  const card = account('1121');
  const overShort = addOverShortAccount(data);
  if (!garments) {
    data.pos.registers.push(
      register(
        {
          code: 'POS1',
          name: 'Pharmacy counter',
          warehouseId: main.id,
          accounts: { cash, card, bkash: null, nagad: null },
          maxDiscountPercent: '5.00',
          paperWidth: '80',
          receiptFooter:
            'Medicines once sold are not taken back. Keep this receipt for your doctor.',
          deviceId: null,
          lastNumber: 0,
        },
        overShort,
      ),
    );
    return;
  }
  const storePc = data.sync.devices.find((device) => device.name === 'Store office PC');
  const depot = byCode('CTG');
  const exchange = addExchangeAccount(data);
  data.pos.registers.push(
    register(
      {
        code: 'POS1',
        name: 'Showroom counter',
        warehouseId: main.id,
        accounts: { cash, card, bkash: null, nagad: null },
        maxDiscountPercent: '10.00',
        paperWidth: '80',
        receiptFooter: 'Goods once sold are exchanged within 7 days with this receipt.',
        deviceId: null,
        lastNumber: 0,
      },
      overShort,
      exchange,
    ),
    register(
      {
        code: 'POS2',
        name: 'Factory outlet counter',
        warehouseId: main.id,
        accounts: { cash, card: null, bkash: null, nagad: null },
        maxDiscountPercent: '5.00',
        paperWidth: '58',
        receiptFooter: null,
        deviceId: storePc?.id ?? null,
        lastNumber: 214,
      },
      overShort,
      exchange,
    ),
  );
  if (depot) {
    data.pos.registers.push(
      register(
        {
          code: 'CTG1',
          name: 'Depot counter',
          warehouseId: depot.id,
          accounts: { cash, card: null, bkash: null, nagad: null },
          maxDiscountPercent: '0.00',
          paperWidth: '80',
          receiptFooter: null,
          deviceId: null,
          lastNumber: 1260,
        },
        overShort,
      ),
    );
  }
}

// Step 20b: the account a counter's cash difference goes to. Not in the chart template (the API's
// garments and pharma templates have none, and the sign-up's setup counts the template's
// accounts): the company added it under its selling expenses when it set up its counters.
function addOverShortAccount(data: WorkspaceData): string | null {
  const parent = data.accounts.find((row) => row.code === '5300');
  if (!parent) return null;
  const id = crypto.randomUUID();
  data.accounts.push({
    id,
    parentId: parent.id,
    code: '5340',
    name: 'Cash over and short',
    type: parent.type,
    isGroup: false,
    purpose: null,
    holdsMoney: false,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  });
  return id;
}

// Step 20c: the liability an exchange's money passes through, like the API's retail template
// (2190). The garments chart has none, so it is added beside the over/short account, for the same
// reason.
function addExchangeAccount(data: WorkspaceData): string | null {
  const parent = data.accounts.find((row) => row.code === '2100');
  if (!parent) return null;
  const id = crypto.randomUUID();
  data.accounts.push({
    id,
    parentId: parent.id,
    code: '2190',
    name: 'POS exchange clearing',
    type: parent.type,
    isGroup: false,
    purpose: null,
    holdsMoney: false,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  });
  return id;
}

// --- Registers ----------------------------------------------------------------------------------

function branchOfRegister(data: WorkspaceData, stored: MockRegister): string {
  // A warehouse is never deleted, so a register's warehouse is always there
  const branchId = branchOf(data, stored.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${stored.warehouseId} of a register is gone`);
  return branchId;
}

export function toRegister(data: WorkspaceData, stored: MockRegister): PosRegister {
  return {
    ...stored,
    branchId: branchOfRegister(data, stored),
    lastShift: lastShiftOf(data, stored.id),
  };
}

// --- A shift's cash (step 20b) ------------------------------------------------------------------

// The API's pos_shift_cash(): the opening count, the cash the shift's sales took and the change
// they gave, its pay ins and pay outs, read from the rows now. A sale that arrives after a close
// without a count is counted too (decision 63). Step 20c: less the cash its returns paid back,
// whatever shift sold the goods; an exchange's money never left the drawer.
export function shiftCash(data: WorkspaceData, shift: MockShift): ShiftCash & { expected: string } {
  const sales = data.pos.sales.filter((sale) => sale.shift?.id === shift.id);
  const moved = (direction: PosCashDirection) =>
    sumMoney(
      data.pos.movements
        .filter((movement) => movement.shiftId === shift.id && movement.direction === direction)
        .map((movement) => movement.amount),
    );
  const cash: ShiftCash = {
    opening: addMoney(shift.opening.count.total, '0'),
    cashTaken: sumMoney(
      sales.flatMap((sale) =>
        sale.payments
          .filter((payment) => payment.method === 'cash')
          .map((payment) => payment.amount),
      ),
    ),
    changeGiven: sumMoney(sales.map((sale) => sale.change)),
    paidIn: moved('in'),
    paidOut: moved('out'),
    cashRefunded: sumMoney(
      data.pos.returns
        .filter((item) => item.shiftId === shift.id)
        .flatMap((item) =>
          item.refunds.filter((refund) => refund.method === 'cash').map((refund) => refund.amount),
        ),
    ),
  };
  return { ...cash, expected: expectedCashOf(cash) };
}

// The register's latest shift, by the highest number (the API's lastShiftsOf). cashLeft: the
// count at the close, or, when nobody counted, what the server expects now.
export function lastShiftOf(data: WorkspaceData, registerId: string): PosLastShift | null {
  const last = data.pos.shifts
    .filter((shift) => shift.registerId === registerId)
    .reduce<MockShift | null>(
      (latest, shift) => (latest === null || shift.sequence > latest.sequence ? shift : latest),
      null,
    );
  if (last === null) return null;
  return {
    id: last.id,
    sequence: last.sequence,
    status: last.status,
    cashLeft:
      last.status === 'open'
        ? null
        : last.status === 'closed'
          ? (last.closing?.count.total ?? null)
          : shiftCash(data, last).expected,
  };
}

export function findRegister(data: WorkspaceData, id: string): MockRegister {
  const found = data.pos.registers.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// By code, with who holds it: the device's name and its person
export function listRegisters(
  data: WorkspaceData,
  query: z.output<typeof posRegisterListQuerySchema>,
): PosRegisterListItem[] {
  return data.pos.registers
    .filter((item) => (item.archivedAt === null) === (query.status === 'active'))
    .map((item) => toRegister(data, item))
    .filter((item) => query.branchId === undefined || item.branchId === query.branchId)
    .toSorted((a, b) => a.code.localeCompare(b.code))
    .map((item) => {
      const device = data.sync.devices.find((candidate) => candidate.id === item.deviceId);
      const person = data.people.members.find((member) => member.userId === device?.userId);
      return {
        ...item,
        holder: device && person ? { deviceName: device.name, userName: person.fullName } : null,
      };
    });
}

// What the audit log shows of a register's form, like the API's snapshot(): the warehouse and the
// accounts by their codes
export function registerSnapshot(
  data: WorkspaceData,
  stored: MockRegister,
): Record<string, string | null> {
  return {
    name: stored.name,
    warehouse: data.stock.warehouses.find((place) => place.id === stored.warehouseId)?.code ?? null,
    cashAccount: codeOf(data.accounts, stored.accounts.cash),
    cardAccount: codeOf(data.accounts, stored.accounts.card),
    bkashAccount: codeOf(data.accounts, stored.accounts.bkash),
    nagadAccount: codeOf(data.accounts, stored.accounts.nagad),
    maxDiscountPercent: stored.maxDiscountPercent,
    paperWidth: stored.paperWidth,
    receiptFooter: stored.receiptFooter,
    overShortAccount: codeOf(data.accounts, stored.overShortAccountId),
    varianceAlert: stored.varianceAlert,
    lockAfter: stored.lockAfter,
    exchangeAccount: codeOf(data.accounts, stored.exchangeAccountId),
    returnDays: String(stored.returnDays),
  };
}

// Step 20c: the register's account for a tender, the API's accountOf(): an exchange goes through
// its exchange account; null = it does not take that method, or makes no exchanges
export function accountOf(stored: MockRegister, tender: PosTender): string | null {
  return tender === 'exchange' ? stored.exchangeAccountId : stored.accounts[tender];
}

type RegisterFields = Omit<PosRegisterInput, 'code'>;

// The API's create() and update() checks, all but the code: an active warehouse when it is new or
// changed, a held register kept in its device's branch, every account a money account, (step 20b)
// an over/short account that is an active income or expense account, not a group, and (step 20c)
// an exchange account, when one is picked, that is an active liability, not a group
function checkFields(data: WorkspaceData, fields: RegisterFields, before?: MockRegister): void {
  if (before?.warehouseId !== fields.warehouseId) {
    const place = data.stock.warehouses.find(
      (candidate) => candidate.id === fields.warehouseId && candidate.archivedAt === null,
    );
    if (!place) throw fieldProblem('pos_register_warehouse_invalid', 'warehouseId');
    if (before && before.deviceId !== null && place.branchId !== branchOfRegister(data, before)) {
      throw fieldProblem('pos_register_branch', 'warehouseId');
    }
  }
  const money = moneyAccountIds(data.accounts);
  const bad = POS_PAYMENT_METHODS.filter((method) => {
    const id = fields.accounts[method];
    return id !== null && !money.has(id);
  });
  if (bad.length > 0) {
    throw new MockProblem(
      409,
      'pos_register_account_invalid',
      Object.fromEntries(
        bad.map((method) => [`accounts.${method}`, ['pos_register_account_invalid' as const]]),
      ),
    );
  }
  const overShort = data.accounts.find((account) => account.id === fields.overShortAccountId);
  if (
    !overShort ||
    overShort.isGroup ||
    overShort.archivedAt !== null ||
    (overShort.type !== 'income' && overShort.type !== 'expense')
  ) {
    throw fieldProblem('pos_over_short_invalid', 'overShortAccountId');
  }
  if (fields.exchangeAccountId !== null) {
    const exchange = data.accounts.find((account) => account.id === fields.exchangeAccountId);
    if (
      !exchange ||
      exchange.isGroup ||
      exchange.archivedAt !== null ||
      exchange.type !== 'liability'
    ) {
      throw fieldProblem('pos_exchange_account_invalid', 'exchangeAccountId');
    }
  }
}

function formOf(fields: RegisterFields) {
  return {
    name: fields.name,
    warehouseId: fields.warehouseId,
    accounts: fields.accounts,
    maxDiscountPercent: percentText(fields.maxDiscountPercent),
    paperWidth: fields.paperWidth,
    receiptFooter: fields.receiptFooter,
    overShortAccountId: fields.overShortAccountId,
    varianceAlert: fields.varianceAlert,
    lockAfter: fields.lockAfter,
    exchangeAccountId: fields.exchangeAccountId,
    returnDays: fields.returnDays,
  };
}

export function createRegister(data: WorkspaceData, input: PosRegisterInput): MockRegister {
  if (data.pos.registers.some((item) => item.code === input.code)) {
    throw fieldProblem('pos_register_code_taken', 'code');
  }
  checkFields(data, input);
  const created: MockRegister = {
    id: crypto.randomUUID(),
    code: input.code,
    ...formOf(input),
    deviceId: null,
    lastNumber: 0,
    lastReturnNumber: 0,
    archivedAt: null,
    version: 1,
    updatedAt: now(),
  };
  data.pos.registers.push(created);
  return created;
}

// The code is not in the input: it is on every receipt the register printed
export function updateRegister(
  data: WorkspaceData,
  target: MockRegister,
  input: Omit<UpdatePosRegisterInput, 'version'>,
): void {
  checkFields(data, input, target);
  Object.assign(target, formOf(input), { version: target.version + 1, updatedAt: now() });
}

// Decision 33: not while a device holds it. A register comes back only to an active warehouse.
export function setRegisterArchived(
  data: WorkspaceData,
  target: MockRegister,
  archived: boolean,
): void {
  if ((target.archivedAt !== null) === archived) return;
  if (archived && target.deviceId !== null) throw new MockProblem(409, 'pos_register_in_use');
  if (
    !archived &&
    !data.stock.warehouses.some(
      (place) => place.id === target.warehouseId && place.archivedAt === null,
    )
  ) {
    throw fieldProblem('pos_register_warehouse_invalid', 'warehouseId');
  }
  Object.assign(target, {
    archivedAt: archived ? now() : null,
    version: target.version + 1,
    updatedAt: now(),
  });
}

// Decision 14: a device takes a register only when no device holds it. Taking the one it holds
// answers it as it is (a claim sent again). No version change: who holds it is not part of the
// form (decision 43). Returns whether the device took it now, for the audit row.
export function claimRegister(data: WorkspaceData, target: MockRegister, device: Device): boolean {
  if (target.deviceId === device.id) return false;
  if (target.archivedAt !== null) throw new MockProblem(409, 'pos_register_archived');
  if (target.deviceId !== null) throw new MockProblem(409, 'pos_register_in_use');
  if (branchOfRegister(data, target) !== device.branchId) {
    throw new MockProblem(409, 'pos_register_branch');
  }
  if (data.pos.registers.some((item) => item.deviceId === device.id)) {
    throw new MockProblem(409, 'pos_device_has_register');
  }
  Object.assign(target, { deviceId: device.id, updatedAt: now() });
  return true;
}

// A free register answers as it is (a release sent again); one another device holds is not this
// device's to free. Step 20b: not while a shift is open on it (the sign-out stops here). Returns
// whether it was let go now.
export function releaseRegister(
  data: WorkspaceData,
  target: MockRegister,
  device: Device,
): boolean {
  if (target.deviceId === null) return false;
  if (target.deviceId !== device.id) throw new MockProblem(409, 'pos_register_not_held');
  if (lastShiftOf(data, target.id)?.status === 'open') {
    throw new MockProblem(409, 'pos_shift_still_open');
  }
  Object.assign(target, { deviceId: null, updatedAt: now() });
  return true;
}

// Migration 0052's triggers: revoking a device, or moving it to another branch, frees the register
// it holds. No audit row (decision 51). Step 20b: a revoke closes the device's open shift first
// (pos-shift-data.ts), and a move is refused while one is open.
export function releaseHeldBy(data: WorkspaceData, deviceId: string): void {
  for (const item of data.pos.registers) {
    if (item.deviceId === deviceId) Object.assign(item, { deviceId: null, updatedAt: now() });
  }
}

// A held register keeps its warehouse in the device's branch (the API's warehouses_register_held,
// mapped to warehouse_branch_locked)
export function assertNoHeldRegister(data: WorkspaceData, warehouseId: string): void {
  if (
    data.pos.registers.some((item) => item.warehouseId === warehouseId && item.deviceId !== null)
  ) {
    throw fieldProblem('warehouse_branch_locked', 'branchId');
  }
}

// An account a register or a POS payment names stays (the API's foreign keys, account_in_use).
// Step 20b: also a register's over/short account, a reason's, and a pay in or out's. Step 20c: a
// register's exchange account and a return's refund.
export function usedByPos(data: WorkspaceData, accountId: string): boolean {
  return (
    data.pos.registers.some(
      (item) =>
        item.overShortAccountId === accountId ||
        item.exchangeAccountId === accountId ||
        POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
    ) ||
    data.pos.sales.some((sale) =>
      sale.payments.some((payment) => payment.accountId === accountId),
    ) ||
    data.pos.reasons.some((reason) => reason.accountId === accountId) ||
    data.pos.movements.some((movement) => movement.accountId === accountId) ||
    data.pos.returns.some((item) => item.refunds.some((refund) => refund.accountId === accountId))
  );
}

// --- The sale's stock (the API's planSale) ------------------------------------------------------

interface Plan {
  moves: Move[];
  batches: { batchId: string; quantity: string }[];
  shortQuantity: string;
  shortSerials: string[];
}

const NO_STOCK: Plan = { moves: [], batches: [], shortQuantity: '0', shortSerials: [] };

// What can be taken of `wanted` from `left`: none below zero
function takeable(left: string, wanted: string): string {
  if (compareQuantity(left, '0') <= 0) return '0';
  return compareQuantity(left, wanted) < 0 ? left : wanted;
}

// Where each goods line leaves from (decisions 7 and 15): an untracked item from the warehouse,
// what is missing below zero (none is "short" when the workspace allows below zero); a batch item
// from the device's batch, then the others by FEFO (none expired), the rest below zero on the
// device's batch; a serial item with the serial numbers that are in this warehouse, the others
// leave without one. The lines are planned in order, each from what the ones before left.
function planSale(
  data: WorkspaceData,
  warehouseId: string,
  date: string,
  lines: readonly { stockLine: z.output<typeof stockLineSchema>; goods: boolean }[],
): Plan[] {
  const { byBatch } = balancesOf(data.stock);
  const keyOf = (variantId: string, batchId: string | null) =>
    `${warehouseId}|${variantId}|${batchId ?? ''}`;
  const left = new Map(byBatch);
  const leftOf = (variantId: string, batchId: string | null) =>
    left.get(keyOf(variantId, batchId)) ?? '0';
  const take = (variantId: string, batchId: string | null, quantity: string) => {
    left.set(keyOf(variantId, batchId), subtractQuantity(leftOf(variantId, batchId), quantity));
  };

  return lines.map(({ stockLine, goods }, line): Plan => {
    if (!goods) return NO_STOCK;
    const { variantId, baseQuantity } = stockLine;
    const move = (batchId: string | null, quantity: string, serialNumbers: string[] = []) => ({
      line,
      warehouseId,
      stockLine,
      batchId,
      quantity,
      serialNumbers,
    });

    if (stockLine.tracking === 'batch') {
      // createSale() refused a batch line without a batch (stock_batch_required)
      const own = stockLine.batchId;
      if (own === null) throw new Error(`POS line ${String(line)} has no batch`);
      const taken = new Map<string, string>();
      const add = (batchId: string, quantity: string) => {
        if (compareQuantity(quantity, '0') <= 0) return;
        taken.set(batchId, addQuantity(taken.get(batchId) ?? '0', quantity));
        take(variantId, batchId, quantity);
      };
      let wanted = baseQuantity;
      const first = takeable(leftOf(variantId, own), wanted);
      add(own, first);
      wanted = subtractQuantity(wanted, first);
      const others = data.stock.batches
        .filter(
          (batch) =>
            batch.variantId === variantId &&
            batch.id !== own &&
            (batch.expiresOn === null || batch.expiresOn >= date),
        )
        .toSorted(
          (a, b) =>
            (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
            a.lotNumber.toLowerCase().localeCompare(b.lotNumber.toLowerCase()),
        );
      for (const other of others) {
        if (compareQuantity(wanted, '0') <= 0) break;
        const part = takeable(leftOf(variantId, other.id), wanted);
        add(other.id, part);
        wanted = subtractQuantity(wanted, part);
      }
      add(own, wanted);
      const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
      return {
        moves: parts.map((part) => move(part.batchId, part.quantity)),
        batches: parts,
        shortQuantity: wanted,
        shortSerials: [],
      };
    }

    const short = subtractQuantity(baseQuantity, takeable(leftOf(variantId, null), baseQuantity));
    take(variantId, null, baseQuantity);

    if (stockLine.tracking === 'serial') {
      const isHere = (serial: string) =>
        data.stock.serials.get(`${variantId}|${serial}`) === warehouseId;
      const found = stockLine.serialNumbers.filter(isHere);
      const missing = stockLine.serialNumbers.filter((serial) => !isHere(serial));
      return {
        moves: [
          ...(found.length > 0 ? [move(null, addQuantity(String(found.length), '0'), found)] : []),
          ...(missing.length > 0 ? [move(null, addQuantity(String(missing.length), '0'))] : []),
        ],
        batches: [],
        shortQuantity: short,
        shortSerials: missing,
      };
    }

    return {
      moves: [move(null, baseQuantity)],
      batches: [],
      shortQuantity: data.settings.allowNegativeStock ? '0' : short,
      shortSerials: [],
    };
  });
}

function isShort(line: { shortQuantity: string; shortSerials: readonly string[] }): boolean {
  return compareQuantity(line.shortQuantity, '0') > 0 || line.shortSerials.length > 0;
}

// --- The sale (the API's createFromDevice) ------------------------------------------------------

// One pos_sale.create command's work, inside push-data.ts's transaction(): the checks, the stock
// moved (below zero when it must), the entry, the sale written. Never refused for stock or for its
// date (decisions 7 and 26). Returns what the audit log and the bell need.
export function createSale(
  data: WorkspaceData,
  deviceId: string,
  saleId: string,
  input: PosSaleInput,
): { sale: MockPosSale; overrides: PosOverride[]; shortLines: number } {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  // Decision 44: only the device that holds the register numbers its sales
  if (target?.deviceId !== deviceId) throw fieldProblem('pos_register_not_held', 'registerId');
  const register = toRegister(data, target);
  const number = formatPosNumber(register.code, input.sequence);
  // Step 20b: the shift it was sold in, this device's on this register (the API's deviceShift()).
  // A closed one too: a late sale still counts in its cash (decision 63).
  const shift =
    input.shiftId === null ? null : deviceShift(data, input.shiftId, deviceId, register.id);

  // Decision 34: the register's account for each method now. Step 20c: an exchange's money goes
  // through the account its return put it on (the API's checkExchange()).
  const exchanges = exchangeAccounts(data, input, register.id);
  const accountIds = input.payments.map((payment, index) =>
    payment.method === 'exchange'
      ? (exchanges.get(index) ?? null)
      : accountOf(target, payment.method),
  );
  const missing = accountIds.flatMap((accountId, index) =>
    accountId === null ? [`payments.${String(index)}.method`] : [],
  );
  if (missing.length > 0) {
    throw new MockProblem(
      409,
      'pos_method_not_set',
      Object.fromEntries(missing.map((path) => [path, ['pos_method_not_set' as const]])),
    );
  }

  // Archived since the sale: kept, it was sold already (the ids sent are the kept ones)
  const customer =
    input.customerId === null ? null : customerOf(data, input.customerId, input.customerId);
  const resolved = resolveSalesLines(
    data,
    input.lines,
    input.pricesIncludeVat,
    new Set(input.lines.map((line) => line.taxRateId)),
    new Set(input.lines.map((line) => line.variantId)),
  );
  // The API's checkTracking(): a batch item names one of its batches, a serial item one serial
  // number per base unit
  const issues: { path: string; code: ErrorCode }[] = [];
  resolved.forEach(({ line }, index) => {
    const sent = input.lines[index];
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    if (line.productType !== 'goods' || !sent) return;
    if (line.tracking === 'batch') {
      if (sent.batchId === null) at('batchId', 'stock_batch_required');
      else if (
        !data.stock.batches.some(
          (batch) => batch.id === sent.batchId && batch.variantId === line.variantId,
        )
      ) {
        at('batchId', 'stock_batch_invalid');
      }
    }
    if (
      line.tracking === 'serial' &&
      (!isWholeQuantity(line.baseQuantity) ||
        wholeCount(line.baseQuantity) !== sent.serialNumbers.length)
    ) {
      at('serialNumbers', 'stock_serial_count');
    }
  });
  if (issues.length > 0) throw issuesError(issues);
  // Decision 34: impossible while one device holds the register, so a bug
  if (data.pos.sales.some((sale) => sale.number === number)) {
    throw fieldProblem('pos_number_taken', 'sequence');
  }
  // Step 20c: the line ids the device made, which a return made offline may already point at.
  // One already used is the API's pos_sale_lines_pkey (sync_id_taken, no field).
  const usedLineIds = new Set(data.pos.sales.flatMap((sale) => sale.lines.map((line) => line.id)));
  if (input.lines.some((line) => line.id !== null && usedLineIds.has(line.id))) {
    throw new MockProblem(409, 'sync_id_taken');
  }

  const amounts = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const paid = sumMoney(input.payments.map((payment) => payment.amount));
  const change = posChangeOf(input.payments, amounts.totals.total);
  const date = bookingDay(data, input.date);

  const lines = resolved.map(({ line }, index) => {
    const sent = input.lines[index];
    const goods = line.productType === 'goods';
    return {
      goods,
      // The line as the stock posting reads it; the schema's parse leaves out the sales fields
      stockLine: stockLineSchema.parse({
        ...line,
        batchId: goods && line.tracking === 'batch' ? (sent?.batchId ?? null) : null,
        lotNumber: null,
        expiresOn: null,
        manufacturedOn: null,
        serialNumbers: goods && line.tracking === 'serial' ? (sent?.serialNumbers ?? []) : [],
      }),
    };
  });
  const plans = planSale(data, register.warehouseId, input.date, lines);
  const values = postMoves(
    data,
    {
      date,
      kind: 'pos_sale',
      direction: 'out',
      documentId: saleId,
      number,
      belowZero: true,
    },
    plans.flatMap((plan) => plan.moves),
  );
  // postMoves() answers in the order of the moves: each line's cost is the sum of its own
  let next = 0;
  const costs = plans.map((plan) => {
    const own = values.slice(next, next + plan.moves.length);
    next += plan.moves.length;
    return sumMoney(own);
  });

  // The books (decision 29): the money in, the sale and its VAT, the cost of the goods
  const books = salesAccounts(data);
  const branchId = register.branchId;
  const cost = sumMoney(costs);
  const goodsAccounts = isZeroMoney(cost) ? null : deliveryAccounts(data);
  const cashAccount = register.accounts.cash;
  const entry = postStockEntry(data, {
    date,
    source: 'pos_sale',
    document: { id: saleId, number },
    narration: `POS sale ${number}`,
    amounts: [
      ...input.payments.map((payment, index) => ({
        accountId: accountIds[index] ?? cashAccount,
        branchId,
        amount: payment.amount,
      })),
      ...(compareMoney(change, '0') > 0
        ? [{ accountId: cashAccount, branchId, amount: negateMoney(change) }]
        : []),
      { accountId: books.sales, branchId, amount: negateMoney(amounts.totals.net) },
      { accountId: books.vatOutput, branchId, amount: negateMoney(amounts.totals.vat) },
      ...(goodsAccounts === null
        ? []
        : [
            { accountId: goodsAccounts.costOfGoodsSold, branchId, amount: cost },
            { accountId: goodsAccounts.inventory, branchId, amount: negateMoney(cost) },
          ]),
    ],
  });

  const saleLines = resolved.map(({ line }, index): MockPosLine => {
    const sent = input.lines[index];
    const lineAmounts = amounts.lines[index];
    const plan = plans[index] ?? NO_STOCK;
    if (!sent || !lineAmounts) throw new Error(`POS line ${String(index)} has no input`);
    const batchOf = (batchId: string | null) =>
      data.stock.batches.find((batch) => batch.id === batchId);
    return {
      ...line,
      // Step 20c: the device's own id
      id: sent.id ?? line.id,
      // The device's rate and the amounts worked out with it (decision 22)
      taxRate: { ...line.taxRate, rate: sent.rate },
      net: lineAmounts.net,
      vat: lineAmounts.vat,
      total: lineAmounts.total,
      billDiscount: lineAmounts.billDiscount,
      startingPrice: sent.startingPrice === null ? null : addMoney(sent.startingPrice, '0'),
      batches: plan.batches.map((part) => ({
        batchId: part.batchId,
        lotNumber: batchOf(part.batchId)?.lotNumber ?? '',
        expiresOn: batchOf(part.batchId)?.expiresOn ?? null,
        quantity: addQuantity(part.quantity, '0'),
      })),
      serialNumbers: line.tracking === 'serial' ? sent.serialNumbers : [],
      shortQuantity: addQuantity(plan.shortQuantity, '0'),
      shortSerials: plan.shortSerials,
      shortLot:
        line.tracking === 'batch' && compareQuantity(plan.shortQuantity, '0') > 0
          ? (batchOf(sent.batchId)?.lotNumber ?? null)
          : null,
      value: addMoney(costs[index] ?? '0', '0'),
    };
  });

  const sale: MockPosSale = {
    id: saleId,
    number,
    register: { id: register.id, code: register.code, name: register.name },
    shift: shift && { id: shift.id, number: shift.number },
    branchId,
    warehouseId: register.warehouseId,
    date,
    soldAt: input.soldAt,
    customer,
    cashier: { id: OWNER.id, fullName: OWNER.fullName },
    net: amounts.totals.net,
    vat: amounts.totals.vat,
    total: amounts.totals.total,
    lineCount: saleLines.length,
    soldShort: saleLines.some(isShort),
    createdAt: now(),
    pricesIncludeVat: input.pricesIncludeVat,
    discount: amounts.totals.discount,
    billDiscountType: input.billDiscountType,
    billDiscount: addMoney(input.billDiscount, '0'),
    billDiscountAmount: amounts.totals.billDiscount,
    paid,
    change,
    lines: saleLines,
    payments: input.payments.map((payment, index) => {
      // The return's number never changes, so it is kept with the payment
      const used = data.pos.returns.find((item) => item.id === payment.returnId);
      return {
        method: payment.method,
        amount: addMoney(payment.amount, '0'),
        reference: payment.reference,
        accountId: accountIds[index] ?? cashAccount,
        return: used ? { id: used.id, number: used.number } : null,
      };
    }),
    deviceId,
    entry,
  };
  data.pos.sales.unshift(sale);
  // The database moves the last number with the sale (0052's pos_sales_last_number)
  keepNumber(data, input);

  // Decision 30: the bell, to the people who put stock right. The mock's person is the owner, who
  // is always one of them. Last: nothing after it can throw, so a refused sale rings nothing.
  const short = saleLines.filter(isShort);
  if (short.length > 0) {
    data.notifications.unshift({
      id: crypto.randomUUID(),
      type: 'pos.sold_short',
      params: {
        id: saleId,
        number,
        warehouse:
          data.stock.warehouses.find((place) => place.id === register.warehouseId)?.name ?? '',
        count: new Set(short.map((line) => line.variantId)).size,
      },
      readAt: null,
      createdAt: now(),
    });
  }
  return {
    sale,
    overrides: posOverridesOf(input, register.maxDiscountPercent),
    shortLines: short.length,
  };
}

// Step 20c (decision 38), the API's checkExchange(): an exchange payment uses a return saved with
// this sale (the push ran it first), at the same register and in the same shift, for exactly the
// return's exchange refund, and no other sale used it. The device makes both, so each is a bug.
// Answers each exchange payment's account: the one its return's refund went to.
function exchangeAccounts(
  data: WorkspaceData,
  input: PosSaleInput,
  registerId: string,
): Map<number, string> {
  const accounts = new Map<number, string>();
  const issues: { path: string; code: ErrorCode }[] = [];
  input.payments.forEach((payment, index) => {
    if (payment.method !== 'exchange' || payment.returnId === null) return;
    const path = `payments.${String(index)}.method`;
    const used = data.pos.returns.find((item) => item.id === payment.returnId);
    if (!used) {
      issues.push({ path, code: 'pos_return_unknown' });
      return;
    }
    const refund = used.refunds.find((item) => item.method === 'exchange');
    const taken = data.pos.sales.some((sale) =>
      sale.payments.some((other) => other.return?.id === used.id),
    );
    if (
      used.registerId !== registerId ||
      used.shiftId !== input.shiftId ||
      refund === undefined ||
      compareMoney(refund.amount, payment.amount) !== 0 ||
      taken
    ) {
      issues.push({ path, code: 'pos_exchange_invalid' });
      return;
    }
    accounts.set(index, refund.accountId);
  });
  const [first] = issues;
  if (first !== undefined) {
    throw new MockProblem(
      409,
      first.code,
      Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])),
    );
  }
  return accounts;
}

// Decision 26, for every POS command (step 20b: a shift's open, pay ins and outs, close too): the
// device's day, unless its clock is ahead of today or the day is locked (the API's bookingDay())
export function bookingDay(data: WorkspaceData, deviceDate: string): string {
  const today = todayIn(data.settings.timezone);
  const day = deviceDate > today ? today : deviceDate;
  const { lockDate } = data.journal;
  return lockDate !== null && day <= lockDate ? shiftIsoDate(lockDate, 1) : day;
}

// The device's own shift (the API's deviceShift()): one of another device or another register is
// the same answer as one the server does not have, a bug on the device either way
export function deviceShift(
  data: WorkspaceData,
  shiftId: string,
  deviceId: string,
  registerId?: string,
): MockShift {
  const found = data.pos.shifts.find((shift) => shift.id === shiftId);
  if (
    found?.deviceId !== deviceId ||
    (registerId !== undefined && found.registerId !== registerId)
  ) {
    throw fieldProblem('pos_shift_unknown', 'shiftId');
  }
  return found;
}

// Decision 37: a refused sale's receipt was printed, so its number is used too. Only up, without a
// version, like the API's keepNumber().
export function keepNumber(data: WorkspaceData, input: { registerId: string; sequence: number }) {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target && target.lastNumber < input.sequence) target.lastNumber = input.sequence;
}

// "price on line 2, bill discount": the audit log's text, counted from 1 like the receipt
export function overrideText(overrides: readonly PosOverride[]): string {
  return overrides
    .map((override) =>
      override.kind === 'bill_discount'
        ? 'bill discount'
        : `${override.kind} on line ${String(override.line + 1)}`,
    )
    .join(', ');
}

// --- What the managers read ---------------------------------------------------------------------

export function findSale(data: WorkspaceData, id: string): MockPosSale {
  const found = data.pos.sales.find((sale) => sale.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

// Step 20c: what the returns brought back of a sale line so far, in its unit, and the serial
// numbers in the order they came back (the API's returnedOf())
export function returnedOf(
  data: WorkspaceData,
  saleLineId: string,
): { quantity: string; serialNumbers: string[] } {
  const lines = data.pos.returns.flatMap((item) =>
    item.lines.filter((line) => line.saleLineId === saleLineId),
  );
  return {
    quantity: addQuantity(
      lines.reduce((sum, line) => addQuantity(sum, line.quantity), '0'),
      '0',
    ),
    serialNumbers: lines.flatMap((line) => line.serialNumbers),
  };
}

// The schemas' parse leaves out what only the mock keeps (shortSerials, shortLot, value). Step
// 20c: with what came back of each line, and the returns of it, oldest first.
export function toPosSale(data: WorkspaceData, stored: MockPosSale): PosSale {
  const { deviceId, lines, ...rest } = stored;
  const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
  return {
    ...rest,
    lines: lines.map((line) =>
      posSaleLineSchema.parse({ ...line, returnedQuantity: returnedOf(data, line.id).quantity }),
    ),
    returns: data.pos.returns
      .filter((item) => item.saleId === stored.id)
      .toSorted((a, b) => a.returnedAt.localeCompare(b.returnedAt) || a.id.localeCompare(b.id))
      .map((item) => ({ id: item.id, number: item.number, date: item.date, total: item.total })),
    device: { id: deviceId, name: device?.name ?? '' },
  };
}

export function listSales(
  data: WorkspaceData,
  query: z.output<typeof posSaleListQuerySchema>,
): PosSalePage {
  const matching = data.pos.sales.filter(
    (sale) =>
      (query.registerId === undefined || sale.register.id === query.registerId) &&
      (query.customerId === undefined || sale.customer?.id === query.customerId),
  );
  const page = pageOf(newestFirst(matching), query);
  return {
    ...page,
    items: page.items.map((sale) => posSaleSummarySchema.parse(toPosSale(data, sale))),
  };
}

// Every line that went below zero or left without its serial numbers, newest sale first, with the
// variant's stock in that warehouse now (every batch together)
export function soldShortList(
  data: WorkspaceData,
  query: z.output<typeof soldShortQuerySchema>,
): SoldShortPage {
  const { byPlace } = balancesOf(data.stock);
  const rows = newestFirst(data.pos.sales)
    .filter((sale) => query.warehouseId === undefined || sale.warehouseId === query.warehouseId)
    .flatMap((sale) =>
      sale.lines.filter(isShort).map((line): SoldShortItem =>
        soldShortItemSchema.parse({
          ...line,
          lineId: line.id,
          saleId: sale.id,
          saleNumber: sale.number,
          date: sale.date,
          warehouseId: sale.warehouseId,
          shortQuantity: line.shortQuantity,
          lotNumber: line.shortLot,
          serialNumbers: line.shortSerials,
          onHandNow: addQuantity(byPlace.get(`${sale.warehouseId}|${line.variantId}`) ?? '0', '0'),
        }),
      ),
    );
  return pageOf(rows, query);
}
