import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type Device,
  type ErrorCode,
  formatPosNumber,
  isZeroMoney,
  isWholeQuantity,
  moneyAccountIds,
  negateMoney,
  POS_PAYMENT_METHODS,
  type PosOverride,
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

// A register without its branch: the branch is its warehouse's, worked out when it is read, so a
// warehouse moved to another branch takes its free registers along (the API joins warehouses)
export type MockRegister = Omit<PosRegister, 'branchId'>;

// A sale's line as the mock keeps it: the contract's line, plus what the Sold short list reads
// (the API's short_serials column, and the lot of the batch that went below zero)
export interface MockPosLine extends PosSaleLine {
  shortSerials: string[];
  shortLot: string | null;
}

// The device by its id: its name is the one it has now when the sale is read
export type MockPosSale = Omit<PosSale, 'lines' | 'device'> & {
  deviceId: string;
  lines: MockPosLine[];
};

export interface MockPos {
  registers: MockRegister[];
  // Newest first: a new sale is put first
  sales: MockPosSale[];
}

export function emptyPos(): MockPos {
  return { registers: [], sales: [] };
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

function register(fields: Omit<MockRegister, 'id' | 'archivedAt' | 'version' | 'updatedAt'>) {
  return { id: crypto.randomUUID(), ...fields, archivedAt: null, version: 1, updatedAt: now() };
}

// The garments maker sells its export surplus at a factory outlet in the head office: the
// showroom counter is free, so this browser's device can take it; the outlet's second counter is
// held by the store office PC (seedDevices()), and stays in the list with that name. The
// Chattogram depot's counter was held by the depot computer revoked 12 days ago: the revoke freed
// it, and its numbers go on from 1,260. The pharma distributor has one counter at its depot.
// After seedDevices(): the outlet's counter names one of its devices.
export function seedPos(data: WorkspaceData, garments: boolean): void {
  const byCode = (code: string) => data.stock.warehouses.find((place) => place.code === code);
  const account = (code: string) => data.accounts.find((row) => row.code === code)?.id ?? null;
  const main = byCode('MAIN');
  const cash = account('1110');
  if (!main || cash === null) return;
  const card = account('1121');
  if (!garments) {
    data.pos.registers.push(
      register({
        code: 'POS1',
        name: 'Pharmacy counter',
        warehouseId: main.id,
        accounts: { cash, card, bkash: null, nagad: null },
        maxDiscountPercent: '5.00',
        paperWidth: '80',
        receiptFooter: 'Medicines once sold are not taken back. Keep this receipt for your doctor.',
        deviceId: null,
        lastNumber: 0,
      }),
    );
    return;
  }
  const storePc = data.sync.devices.find((device) => device.name === 'Store office PC');
  const depot = byCode('CTG');
  data.pos.registers.push(
    register({
      code: 'POS1',
      name: 'Showroom counter',
      warehouseId: main.id,
      accounts: { cash, card, bkash: null, nagad: null },
      maxDiscountPercent: '10.00',
      paperWidth: '80',
      receiptFooter: 'Goods once sold are exchanged within 7 days with this receipt.',
      deviceId: null,
      lastNumber: 0,
    }),
    register({
      code: 'POS2',
      name: 'Factory outlet counter',
      warehouseId: main.id,
      accounts: { cash, card: null, bkash: null, nagad: null },
      maxDiscountPercent: '5.00',
      paperWidth: '58',
      receiptFooter: null,
      deviceId: storePc?.id ?? null,
      lastNumber: 214,
    }),
  );
  if (depot) {
    data.pos.registers.push(
      register({
        code: 'CTG1',
        name: 'Depot counter',
        warehouseId: depot.id,
        accounts: { cash, card: null, bkash: null, nagad: null },
        maxDiscountPercent: '0.00',
        paperWidth: '80',
        receiptFooter: null,
        deviceId: null,
        lastNumber: 1260,
      }),
    );
  }
}

// --- Registers ----------------------------------------------------------------------------------

function branchOfRegister(data: WorkspaceData, stored: MockRegister): string {
  // A warehouse is never deleted, so a register's warehouse is always there
  const branchId = branchOf(data, stored.warehouseId);
  if (branchId === null) throw new Error(`Warehouse ${stored.warehouseId} of a register is gone`);
  return branchId;
}

export function toRegister(data: WorkspaceData, stored: MockRegister): PosRegister {
  return { ...stored, branchId: branchOfRegister(data, stored) };
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
  };
}

type RegisterFields = Omit<PosRegisterInput, 'code'>;

// The API's create() and update() checks, all but the code: an active warehouse when it is new or
// changed, a held register kept in its device's branch, and every account a money account
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
}

function formOf(fields: RegisterFields) {
  return {
    name: fields.name,
    warehouseId: fields.warehouseId,
    accounts: fields.accounts,
    maxDiscountPercent: percentText(fields.maxDiscountPercent),
    paperWidth: fields.paperWidth,
    receiptFooter: fields.receiptFooter,
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
// device's to free. Returns whether it was let go now.
export function releaseRegister(target: MockRegister, device: Device): boolean {
  if (target.deviceId === null) return false;
  if (target.deviceId !== device.id) throw new MockProblem(409, 'pos_register_not_held');
  Object.assign(target, { deviceId: null, updatedAt: now() });
  return true;
}

// Migration 0052's triggers: revoking a device, or moving it to another branch, frees the register
// it holds. No audit row (decision 51).
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

// An account a register or a POS payment names stays (the API's foreign keys, account_in_use)
export function usedByPos(data: WorkspaceData, accountId: string): boolean {
  return (
    data.pos.registers.some((item) =>
      POS_PAYMENT_METHODS.some((method) => item.accounts[method] === accountId),
    ) ||
    data.pos.sales.some((sale) => sale.payments.some((payment) => payment.accountId === accountId))
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

  // Decision 34: the register's account for each method now
  const missing = input.payments.flatMap((payment, index) =>
    register.accounts[payment.method] === null ? [`payments.${String(index)}.method`] : [],
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

  const amounts = posSaleAmounts(
    input.lines,
    { type: input.billDiscountType, value: input.billDiscount },
    input.pricesIncludeVat,
  );
  const paid = sumMoney(input.payments.map((payment) => payment.amount));
  const change = posChangeOf(input.payments, amounts.totals.total);
  // Decision 26: the device's day, unless its clock is ahead of today or the day is locked
  const today = todayIn(data.settings.timezone);
  const soldOn = input.date > today ? today : input.date;
  const { lockDate } = data.journal;
  const date = lockDate !== null && soldOn <= lockDate ? shiftIsoDate(lockDate, 1) : soldOn;

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
      ...input.payments.map((payment) => ({
        accountId: register.accounts[payment.method] ?? cashAccount,
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
    };
  });

  const sale: MockPosSale = {
    id: saleId,
    number,
    register: { id: register.id, code: register.code, name: register.name },
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
    payments: input.payments.map((payment) => ({
      method: payment.method,
      amount: addMoney(payment.amount, '0'),
      reference: payment.reference,
      accountId: register.accounts[payment.method] ?? cashAccount,
    })),
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

// The schemas' parse leaves out what only the mock keeps (shortSerials, shortLot)
export function toPosSale(data: WorkspaceData, stored: MockPosSale): PosSale {
  const { deviceId, lines, ...rest } = stored;
  const device = data.sync.devices.find((candidate) => candidate.id === deviceId);
  return {
    ...rest,
    lines: lines.map((line) => posSaleLineSchema.parse(line)),
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
