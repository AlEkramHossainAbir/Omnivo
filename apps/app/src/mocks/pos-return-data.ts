import {
  addMoney,
  addQuantity,
  compareMoney,
  compareQuantity,
  type ErrorCode,
  formatReturnNumber,
  isQuantity,
  isWholeQuantity,
  isWithinReturnWindow,
  isZeroMoney,
  negateMoney,
  POS_SALES_ON_DEVICE_DAYS,
  type PosRegisterSalesPage,
  type PosReturn,
  type PosReturnableSale,
  posReturnableSaleSchema,
  type PosReturnInput,
  posReturnAmounts,
  posReturnLineSchema,
  type posReturnListQuerySchema,
  type PosReturnPage,
  type PosReturnSummary,
  prorateMoney,
  returnableQuantityOf,
  shiftIsoDate,
  stockLineSchema,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  todayIn,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import type { z } from 'zod';

import { salesAccounts } from './invoice-data';
import { postStockEntry } from './journal-data';
import { MockProblem } from './mock';
import {
  accountOf,
  bookingDay,
  deviceShift,
  findRegister,
  type MockPosLine,
  type MockPosSale,
  type MockReturn,
  type MockReturnLine,
  returnedOf,
  toRegister,
} from './pos-data';
import { personName } from './pos-shift-data';
import { deliveryAccounts, fieldProblem, pageOf } from './sales-document-data';
import { branchOf, decimalsOf, issuesError, type Move, postMoves } from './stock-data';
import type { WorkspaceData } from './workspace-data';

// The mock's step 20c: POS returns. The API's pos-returnable.ts and pos-returns.service.ts on
// plain arrays, shortened. A return is written only by the push (push-data.ts calls
// createPosReturn), like a sale: the money was paid back at the counter, so it is never refused
// for the register's window, for more than is left, or for permission; those go into the audit
// log, which push-data.ts writes from what createPosReturn() answers (record() lives in
// workspace-data.ts, like for pos-data.ts). The returns live in data.pos.returns (pos-data.ts),
// where a sale reads what came back of each line and a shift what its returns paid back.

// --- What a return reads of a sale --------------------------------------------------------------

// The first day of the sales a device keeps: POS_SALES_ON_DEVICE_DAYS before the workspace's today
function posSalesFrom(data: WorkspaceData): string {
  return shiftIsoDate(todayIn(data.settings.timezone), -POS_SALES_ON_DEVICE_DAYS);
}

// A sale's number in its register's series: POS1-000123 → 123. The mock keeps the number only.
function sequenceOf(sale: MockPosSale): number {
  return Number(sale.number.slice(sale.register.code.length + 1));
}

// The one shape the return screen reads (the API's returnableSalesOf()): the route's answer, the
// register's recent sales and the device's pos_sale rows. The parse keeps only the contract's
// fields of each line.
export function toReturnable(data: WorkspaceData, sale: MockPosSale): PosReturnableSale {
  return posReturnableSaleSchema.parse({
    id: sale.id,
    number: sale.number,
    registerId: sale.register.id,
    date: sale.date,
    soldAt: sale.soldAt,
    customer: sale.customer,
    pricesIncludeVat: sale.pricesIncludeVat,
    total: sale.total,
    lines: sale.lines.map((line) => {
      const back = returnedOf(data, line.id);
      return {
        ...line,
        returnedSerialNumbers: back.serialNumbers,
        returnedQuantity: back.quantity,
      };
    }),
    payments: sale.payments.map((payment) => ({
      method: payment.method,
      amount: payment.amount,
    })),
  });
}

// Online, any register's receipt. The window is the screen's to check: it knows today.
export function returnableSale(data: WorkspaceData, number: string): PosReturnableSale {
  const found = data.pos.sales.find((sale) => sale.number === number);
  if (!found) {
    throw new MockProblem(404, 'pos_return_sale_not_found', {
      saleId: ['pos_return_sale_not_found'],
    });
  }
  return toReturnable(data, found);
}

// The sales the device reads right after it takes a register (decision 45), in the order they
// were sold in: by the register's own numbers, which no device's clock can disorder
export function registerSales(
  data: WorkspaceData,
  registerId: string,
  query: { limit: number; cursor?: string | undefined },
): PosRegisterSalesPage {
  findRegister(data, registerId);
  const from = posSalesFrom(data);
  const sales = data.pos.sales
    .filter((sale) => sale.register.id === registerId && sale.date >= from)
    .toSorted((a, b) => sequenceOf(a) - sequenceOf(b));
  const page = pageOf(sales, query);
  return { ...page, items: page.items.map((sale) => toReturnable(data, sale)) };
}

// The pos_sale rows a device keeps (the API's loader): the sales of the register it holds, of the
// last POS_SALES_ON_DEVICE_DAYS days. None for a device without a register.
export function keptSalesOf(data: WorkspaceData, deviceId: string): MockPosSale[] {
  const held = data.pos.registers.find((item) => item.deviceId === deviceId);
  if (!held) return [];
  const from = posSalesFrom(data);
  return data.pos.sales.filter((sale) => sale.register.id === held.id && sale.date >= from);
}

// --- The return (the API's createFromDevice) ----------------------------------------------------

// A return line, worked out against its sale line before anything is written
interface PlannedLine {
  index: number;
  input: PosReturnInput['lines'][number];
  sale: MockPosLine;
  baseQuantity: string;
  // What earlier returns took back of the sale line, in its unit
  before: string;
  // This return's share of what the goods cost when sold
  value: string;
}

// What the audit log needs of a return, besides the return: the push writes the rows
export interface PosReturnAudit {
  stored: MockReturn;
  registerCode: string;
  returnDays: number;
  sale: MockPosSale;
  // "line 1: 2 of 1.0000, 0.0000 back before", one per line that took back more than was left
  over: string[];
  // "line 1: 52 + 7.80 sent, 52.17 + 7.83 worked out", one per line whose amounts differ
  differ: string[];
}

// `value` cut by the quantities, adding up to it exactly: the last part takes what is left
function splitByQuantity(value: string, quantities: readonly string[]): string[] {
  const whole = sumQuantity(quantities);
  let left = value;
  return quantities.map((quantity, index) => {
    if (index === quantities.length - 1) return left;
    const part = prorateMoney(value, quantity, whole);
    left = subtractMoney(left, part);
    return part;
  });
}

// One pos_return.create command's work, inside push-data.ts's transaction(): the checks, the goods
// back into the register's warehouse, the refunds, the entry, the return written.
export function createPosReturn(
  data: WorkspaceData,
  device: { id: string; userId: string },
  returnId: string,
  input: PosReturnInput,
): PosReturnAudit {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target?.deviceId !== device.id) throw fieldProblem('pos_register_not_held', 'registerId');
  const register = toRegister(data, target);
  const number = formatReturnNumber(register.code, input.sequence);
  // Decision 19: this register's shift on this device; one closed since still takes it
  deviceShift(data, input.shiftId, device.id, register.id);

  // Where each refund's money came from: the register's account for the method now, or its
  // exchange account. Both are put right in Settings → POS registers, then sent again.
  const issues: { path: string; code: ErrorCode }[] = [];
  const refunds = input.refunds.map((refund, index) => {
    const accountId = accountOf(target, refund.method);
    if (accountId === null) {
      issues.push({
        path: `refunds.${String(index)}.method`,
        code: refund.method === 'exchange' ? 'pos_exchange_not_set' : 'pos_method_not_set',
      });
    }
    return {
      method: refund.method,
      amount: addMoney(refund.amount, '0'),
      reference: refund.reference,
      accountId: accountId ?? '',
    };
  });
  if (issues.length > 0) throw issuesError(issues);

  const sale = data.pos.sales.find((item) => item.id === input.saleId);
  if (!sale) throw fieldProblem('pos_return_sale_not_found', 'saleId');
  const lines = planLines(data, sale, input);
  const window = isWithinReturnWindow(sale.date, input.date, target.returnDays);
  const net = sumMoney(input.lines.map((line) => line.net));
  const vat = sumMoney(input.lines.map((line) => line.vat));
  const total = addMoney(net, vat);
  const date = bookingDay(data, input.date);
  // The register is the device's alone, so only a bug gets here (pos_returns_tenant_number_idx)
  if (
    data.pos.returns.some(
      (item) =>
        item.number === number ||
        (item.registerId === target.id && item.sequence === input.sequence),
    )
  ) {
    throw fieldProblem('pos_return_number_taken', 'sequence');
  }

  // Decision 3: the goods come back into the register's warehouse, at what they cost when sold
  const planned = planStock(data, register.warehouseId, lines);
  postMoves(
    data,
    { date, kind: 'pos_return', direction: 'in', documentId: returnId, number },
    planned.flatMap((plan) => plan.moves),
  );

  // The books (the API's StockBooksService.posReturn()): the sale and its cost come off the
  // sale's branch, the money and the goods are where they came back
  const books = salesAccounts(data);
  const here = register.branchId;
  const sold = branchOf(data, sale.warehouseId);
  const cost = sumMoney(lines.map((line) => line.value));
  const goodsAccounts = isZeroMoney(cost) ? null : deliveryAccounts(data);
  const entry = postStockEntry(data, {
    date,
    source: 'pos_return',
    document: { id: returnId, number },
    narration: `POS return ${number}`,
    amounts: [
      { accountId: data.salesAccounts.returns ?? books.sales, branchId: sold, amount: net },
      { accountId: books.vatOutput, branchId: sold, amount: vat },
      ...refunds.map((refund) => ({
        accountId: refund.accountId,
        branchId: here,
        amount: negateMoney(refund.amount),
      })),
      ...(goodsAccounts === null
        ? []
        : [
            { accountId: goodsAccounts.inventory, branchId: here, amount: cost },
            {
              accountId: goodsAccounts.costOfGoodsSold,
              branchId: sold,
              amount: negateMoney(cost),
            },
          ]),
    ],
  });

  const stored: MockReturn = {
    id: returnId,
    registerId: target.id,
    shiftId: input.shiftId,
    deviceId: device.id,
    cashierId: device.userId,
    sequence: input.sequence,
    number,
    date,
    returnedAt: input.returnedAt,
    saleId: sale.id,
    warehouseId: register.warehouseId,
    net,
    vat,
    total,
    note: input.note,
    outsideWindow: !window,
    createdAt: new Date().toISOString(),
    lines: planned.map(({ line, batches }): MockReturnLine => ({
      id: crypto.randomUUID(),
      saleLineId: line.sale.id,
      quantity: addQuantity(line.input.quantity, '0'),
      baseQuantity: addQuantity(line.baseQuantity, '0'),
      net: addMoney(line.input.net, '0'),
      vat: addMoney(line.input.vat, '0'),
      total: addMoney(line.input.net, line.input.vat),
      value: line.value,
      batches,
      serialNumbers: line.input.serialNumbers,
    })),
    refunds,
    entry,
  };
  data.pos.returns.push(stored);
  // The database moves the last return number with the return (0056's pos_returns_last_number)
  keepReturnNumber(data, input);

  return {
    stored,
    registerCode: register.code,
    returnDays: target.returnDays,
    sale,
    // Against what came back before this one, as the server knows it
    over: lines.flatMap((line) =>
      compareQuantity(
        line.input.quantity,
        returnableQuantityOf({ quantity: line.sale.quantity, returnedQuantity: line.before }),
      ) > 0
        ? [
            `line ${String(line.index + 1)}: ${line.input.quantity} of ${line.sale.quantity}, ${line.before} back before`,
          ]
        : [],
    ),
    differ: lines.flatMap((line) => {
      const server = posReturnAmounts(
        {
          quantity: line.sale.quantity,
          net: line.sale.net,
          vat: line.sale.vat,
          returnedQuantity: line.before,
        },
        line.input.quantity,
      );
      return compareMoney(server.net, line.input.net) === 0 &&
        compareMoney(server.vat, line.input.vat) === 0
        ? []
        : [
            `line ${String(line.index + 1)}: ${line.input.net} + ${line.input.vat} sent, ${server.net} + ${server.vat} worked out`,
          ];
    }),
  };
}

// Decision 43: a refused return's slip was printed, so its number is used. Only up.
export function keepReturnNumber(
  data: WorkspaceData,
  input: { registerId: string; sequence: number },
): void {
  const target = data.pos.registers.find((item) => item.id === input.registerId);
  if (target && target.lastReturnNumber < input.sequence) target.lastReturnNumber = input.sequence;
}

// Each line against its sale line (the API's planLines()): a line of this sale, its quantity in
// the base unit by the sale line's own unit, its serial numbers out of the sale line's, and its
// share of what the goods cost. A refusal here is a bug: the screen offers only the sale's lines.
function planLines(data: WorkspaceData, sale: MockPosSale, input: PosReturnInput): PlannedLine[] {
  const issues: { path: string; code: ErrorCode }[] = [];
  const planned: PlannedLine[] = [];
  input.lines.forEach((line, index) => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: `lines.${String(index)}.${field}`, code });
    };
    const saleLine = sale.lines.find((item) => item.id === line.saleLineId);
    if (!saleLine) {
      at('saleLineId', 'pos_return_line_unknown');
      return;
    }
    // Decision 17: in the sale line's unit. A pack a document used is never removed (step 12).
    const factor =
      saleLine.unitId === saleLine.baseUnitId
        ? '1'
        : saleLine.units.find((pack) => pack.unitId === saleLine.unitId)?.factor;
    const baseQuantity =
      factor === undefined
        ? null
        : toBaseQuantity(line.quantity, factor, decimalsOf(data, saleLine.baseUnitId));
    if (baseQuantity === null || !isQuantity(baseQuantity)) {
      at('quantity', 'quantity_format');
      return;
    }
    // A serial product's line brings back one serial number of the sale line per piece; any
    // other line brings back none
    const serialsOk =
      saleLine.tracking === 'serial'
        ? isWholeQuantity(baseQuantity) &&
          wholeCount(baseQuantity) === line.serialNumbers.length &&
          line.serialNumbers.every((serial) => saleLine.serialNumbers.includes(serial))
        : line.serialNumbers.length === 0;
    if (!serialsOk) {
      at('serialNumbers', 'pos_return_serial_invalid');
      return;
    }
    const before = returnedOf(data, saleLine.id).quantity;
    // The same shares as the money, so all the returns of a line take back exactly its cost
    const value = posReturnAmounts(
      { quantity: saleLine.quantity, net: saleLine.value, vat: '0', returnedQuantity: before },
      line.quantity,
    ).net;
    planned.push({ index, input: line, sale: saleLine, baseQuantity, before, value });
  });
  if (issues.length > 0) throw issuesError(issues);
  return planned;
}

// Where each line's goods go back to, in the register's warehouse (the API's planStock()):
//   no tracking  the line's base quantity
//   batch        into the batches the sale line left from, in the order it took them (the
//                cashier's batch first), each up to what it gave less what earlier returns put
//                back; what is still left (more than was sold) into the first
//   serial       a serial number that left with the sale comes back with it; one the sale took as
//                a piece without its number (sold short), or one in stock or on a truck since,
//                comes back as a piece without one, so a return is never refused
// Each move carries its share of the line's cost, by quantity.
function planStock(
  data: WorkspaceData,
  warehouseId: string,
  lines: readonly PlannedLine[],
): { line: PlannedLine; moves: Move[]; batches: { batchId: string; quantity: string }[] }[] {
  const { stock } = data;
  return lines.map((line) => {
    if (line.sale.productType !== 'goods') return { line, moves: [], batches: [] };
    const tracking = line.sale.tracking;
    const stockLine = stockLineSchema.parse({
      ...line.sale,
      quantity: line.input.quantity,
      baseQuantity: line.baseQuantity,
      batchId: null,
      lotNumber: null,
      expiresOn: null,
      manufacturedOn: null,
      serialNumbers: [],
    });
    const move = (
      batchId: string | null,
      quantity: string,
      value: string,
      serialNumbers: string[] = [],
    ): Move => ({
      line: line.index,
      warehouseId,
      stockLine,
      batchId,
      quantity,
      serialNumbers,
      value,
    });

    if (tracking === 'batch') {
      const rows = line.sale.batches;
      const backBefore = data.pos.returns.flatMap((item) =>
        item.lines
          .filter((other) => other.saleLineId === line.sale.id)
          .flatMap((other) => other.batches),
      );
      const taken = new Map<string, string>();
      let wanted = line.baseQuantity;
      for (const row of rows) {
        if (compareQuantity(wanted, '0') <= 0) break;
        const back = backBefore
          .filter((part) => part.batchId === row.batchId)
          .reduce((sum, part) => addQuantity(sum, part.quantity), '0');
        const room = subtractQuantity(row.quantity, back);
        if (compareQuantity(room, '0') <= 0) continue;
        const part = compareQuantity(room, wanted) < 0 ? room : wanted;
        taken.set(row.batchId, part);
        wanted = subtractQuantity(wanted, part);
      }
      const [first] = rows;
      // A batch line always left from at least one batch (createSale's plan)
      if (first === undefined) throw new Error(`POS sale line ${line.sale.id} has no batches`);
      if (compareQuantity(wanted, '0') > 0) {
        taken.set(first.batchId, addQuantity(taken.get(first.batchId) ?? '0', wanted));
      }
      const parts = [...taken].map(([batchId, quantity]) => ({
        batchId,
        quantity: addQuantity(quantity, '0'),
      }));
      const values = splitByQuantity(
        line.value,
        parts.map((part) => part.quantity),
      );
      return {
        line,
        moves: parts.map((part, at) => move(part.batchId, part.quantity, values[at] ?? '0')),
        batches: parts,
      };
    }

    if (tracking === 'serial') {
      const travelling = (serial: string) =>
        stock.transfers.some(
          (transfer) =>
            transfer.status === 'in_transit' &&
            transfer.lines.some(
              (sent) =>
                sent.variantId === line.sale.variantId && sent.serialNumbers.includes(serial),
            ),
        );
      // Out of every warehouse now (null; undefined = a number the stock never knew)
      const found = line.input.serialNumbers.filter(
        (serial) =>
          !line.sale.shortSerials.includes(serial) &&
          stock.serials.get(`${line.sale.variantId}|${serial}`) === null &&
          !travelling(serial),
      );
      const pieces = line.input.serialNumbers.length - found.length;
      const quantities = [
        ...(found.length > 0 ? [String(found.length)] : []),
        ...(pieces > 0 ? [String(pieces)] : []),
      ];
      const values = splitByQuantity(line.value, quantities);
      return {
        line,
        moves: [
          ...(found.length > 0
            ? [move(null, addQuantity(String(found.length), '0'), values[0] ?? '0', found)]
            : []),
          ...(pieces > 0
            ? [
                move(
                  null,
                  addQuantity(String(pieces), '0'),
                  values[found.length > 0 ? 1 : 0] ?? '0',
                ),
              ]
            : []),
        ],
        batches: [],
      };
    }

    return { line, moves: [move(null, line.baseQuantity, line.value)], batches: [] };
  });
}

// --- What the managers read ---------------------------------------------------------------------

export function findPosReturn(data: WorkspaceData, id: string): MockReturn {
  const found = data.pos.returns.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  return found;
}

function saleOf(data: WorkspaceData, stored: MockReturn): MockPosSale {
  // A sale is never deleted, and a return always names one
  const sale = data.pos.sales.find((item) => item.id === stored.saleId);
  if (!sale) throw new Error(`POS return ${stored.number} has no sale`);
  return sale;
}

function toSummary(data: WorkspaceData, stored: MockReturn): PosReturnSummary {
  const register = toRegister(data, findRegister(data, stored.registerId));
  const shift = data.pos.shifts.find((item) => item.id === stored.shiftId);
  const sale = saleOf(data, stored);
  // One sale at most uses a return (pos_sale_payments_return_idx)
  const exchangeSale = data.pos.sales.find((item) =>
    item.payments.some((payment) => payment.return?.id === stored.id),
  );
  return {
    id: stored.id,
    number: stored.number,
    register: { id: register.id, code: register.code, name: register.name },
    shift: { id: stored.shiftId, number: shift?.number ?? '' },
    branchId: branchOf(data, stored.warehouseId) ?? register.branchId,
    warehouseId: stored.warehouseId,
    date: stored.date,
    returnedAt: stored.returnedAt,
    sale: { id: sale.id, number: sale.number, date: sale.date },
    customer: sale.customer,
    cashier: { id: stored.cashierId, fullName: personName(data, stored.cashierId) },
    net: stored.net,
    vat: stored.vat,
    total: stored.total,
    lineCount: stored.lines.length,
    exchangeSale: exchangeSale ? { id: exchangeSale.id, number: exchangeSale.number } : null,
    outsideWindow: stored.outsideWindow,
    createdAt: stored.createdAt,
  };
}

// Newest date first, then by id, like the API's cursor
export function listPosReturns(
  data: WorkspaceData,
  query: z.output<typeof posReturnListQuerySchema>,
): PosReturnPage {
  const matching = data.pos.returns
    .filter(
      (item) =>
        (query.registerId === undefined || item.registerId === query.registerId) &&
        (query.saleId === undefined || item.saleId === query.saleId) &&
        (query.shiftId === undefined || item.shiftId === query.shiftId),
    )
    .toSorted((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const page = pageOf(matching, query);
  return { ...page, items: page.items.map((item) => toSummary(data, item)) };
}

// The product, unit, description and price are the sale line's; the batches by expiry, like the
// API's join
export function toPosReturn(data: WorkspaceData, stored: MockReturn): PosReturn {
  const sale = saleOf(data, stored);
  const device = data.sync.devices.find((candidate) => candidate.id === stored.deviceId);
  const batchOf = (batchId: string) => data.stock.batches.find((batch) => batch.id === batchId);
  return {
    ...toSummary(data, stored),
    pricesIncludeVat: sale.pricesIncludeVat,
    note: stored.note,
    lines: stored.lines.flatMap((line) => {
      const saleLine = sale.lines.find((item) => item.id === line.saleLineId);
      if (!saleLine) return [];
      return [
        posReturnLineSchema.parse({
          ...saleLine,
          id: line.id,
          saleLineId: line.saleLineId,
          quantity: line.quantity,
          baseQuantity: line.baseQuantity,
          net: line.net,
          vat: line.vat,
          total: line.total,
          batches: line.batches
            .map((part) => ({
              batchId: part.batchId,
              lotNumber: batchOf(part.batchId)?.lotNumber ?? '',
              expiresOn: batchOf(part.batchId)?.expiresOn ?? null,
              quantity: part.quantity,
            }))
            .toSorted((a, b) =>
              (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31'),
            ),
          serialNumbers: line.serialNumbers,
        }),
      ];
    }),
    refunds: stored.refunds,
    device: { id: stored.deviceId, name: device?.name ?? '' },
    entry: stored.entry,
  };
}
