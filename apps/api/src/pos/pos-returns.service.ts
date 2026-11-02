import { Inject, Injectable } from '@nestjs/common';
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
  type PartyRef,
  type PosRegisterSalesPage,
  type PosReturn,
  type PosReturnableSale,
  type PosReturnInput,
  posReturnAmounts,
  returnableQuantityOf,
  type PosReturnSummary,
  prorateMoney,
  subtractMoney,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  wholeCount,
} from '@omnivo/contracts';
import {
  batches,
  devices,
  posRegisters,
  posReturnLineBatches,
  posReturnLines,
  posReturnRefunds,
  posReturns,
  posSaleLineBatches,
  posSaleLines,
  posSalePayments,
  posSales,
  posShifts,
  serials,
  stockTransferLines,
  stockTransfers,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, gt, gte, inArray, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import {
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type VariantInfo,
} from '../inventory/stock-lines.js';
import { type StockMove, StockPostingService } from '../inventory/stock-posting.service.js';
import type { Access } from '../rbac/permission.service.js';
import { customerRefs } from '../sales/sales-lines.js';
import { bookingDay } from './booking-day.js';
import { accountOf } from './pos-registers.service.js';
import { posSalesFrom, returnableSalesOf, returnedFor, returnedOf } from './pos-returnable.js';
import { deviceShift } from './pos-shifts.service.js';

type ReturnRow = typeof posReturns.$inferSelect;
type SaleRow = typeof posSales.$inferSelect;
type SaleLineRow = typeof posSaleLines.$inferSelect;

const listCursorSchema = z.tuple([z.iso.date(), z.uuid()]);
const salesCursorSchema = z.tuple([z.number().int()]);

// The sale an exchange paid for, as the return's row names it
const exchangeSales = alias(posSales, 'exchange_sales');

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the return was made on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// Like a sale's number (step 20a, decision 34): the register is locked, so only a bug gets here
function numberTaken(number: string): AppError {
  return new AppError(
    409,
    'pos_return_number_taken',
    `Another return already has number ${number}.`,
    {
      fieldErrors: { sequence: ['pos_return_number_taken'] },
    },
  );
}

// The device found the sale on itself or on the server, and a return waits for its sale in the
// outbox: a sale the server does not have is a bug, or a sale of another workspace
function saleUnknown(status: 404 | 409): AppError {
  return new AppError(status, 'pos_return_sale_not_found', 'No POS sale has this receipt number.', {
    fieldErrors: { saleId: ['pos_return_sale_not_found'] },
  });
}

// A return line, worked out against its sale line before anything is written
interface PlannedLine {
  index: number;
  input: PosReturnInput['lines'][number];
  sale: SaleLineRow;
  variant: VariantInfo;
  baseQuantity: string;
  // What posted returns took back of the sale line before this one, in its unit
  before: string;
  // What the goods cost when they were sold, this return's share of it
  value: string;
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

// POS returns (step 20c). Like a sale, a return is written in one place: the sync's push, through
// createFromDevice. It is posted the moment it is written: its lines, the batches the goods went
// back into, its refunds, its stock movements and its journal entry, in the push's savepoint for
// that command. The money was paid back at the counter, so it is never refused for the window,
// for more than is left or for permission (decision 20): those go into the audit log. The refusals
// left are what someone can put right (a register with no account for a refund's method, or no
// exchange account) and bugs (a sale, a line or a serial number that is not the sale's).
@Injectable()
export class PosReturnsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly stock: StockPostingService,
    private readonly books: StockBooksService,
  ) {}

  // The work of one pos_return.create command, inside the push's savepoint. `access` is the
  // person's roles of now, for the audit log only.
  async createFromDevice(
    tx: Transaction,
    access: Access,
    returnId: string,
    input: PosReturnInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS return is written only from a device');

    // The device, then the register: the lock order of a sale (0052). FOR UPDATE on the register:
    // its returns are written one after the other, and 0056 moves its last return number.
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
      .for('share');
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatReturnNumber(register.code, input.sequence);
    // Decision 19: the shift of this register and this device. A shift closed since still takes
    // it, like a late sale (decision 40).
    await deviceShift(tx, input.shiftId, deviceId, register.id);

    // Where each refund's money came from: the register's account for the method now, or its
    // exchange account. Both can be put right in Settings → POS, then sent again from the Sync page.
    const issues: LineIssue[] = [];
    const refunds = input.refunds.map((refund, index) => {
      const accountId = accountOf(register, refund.method);
      if (accountId === null) {
        issues.push({
          path: `refunds.${String(index)}.method`,
          code: refund.method === 'exchange' ? 'pos_exchange_not_set' : 'pos_method_not_set',
        });
      }
      return { ...refund, accountId: accountId ?? '' };
    });
    const [firstIssue] = issues;
    if (firstIssue !== undefined) {
      throw new AppError(
        409,
        firstIssue.code,
        firstIssue.code === 'pos_exchange_not_set'
          ? 'The register has no exchange account. Set one in Settings → POS.'
          : 'The register has no account for a way this return paid back. Set one in Settings → POS.',
        { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])) },
      );
    }

    // The sale, FOR UPDATE: two counters taking back the same receipt at once are written one
    // after the other, so the second sees what the first took back. Nothing else locks a sale
    // (it never changes), so this waits only for another return of it.
    const [sale] = await tx
      .select()
      .from(posSales)
      .where(and(eq(posSales.tenantId, tenantId), eq(posSales.id, input.saleId)))
      .for('update');
    if (!sale) throw saleUnknown(409);
    const lines = await this.planLines(tx, sale, input);

    const window = isWithinReturnWindow(sale.date, input.date, register.returnDays);
    const net = sumMoney(input.lines.map((line) => line.net));
    const vat = sumMoney(input.lines.map((line) => line.vat));
    const total = addMoney(net, vat);
    // Decision 26 of 20a: on the device's day, or the first day the books take
    const date = await bookingDay(tx, input.date);

    try {
      await tx.insert(posReturns).values({
        id: returnId,
        tenantId,
        registerId: register.id,
        shiftId: input.shiftId,
        deviceId,
        sequence: input.sequence,
        number,
        date,
        returnedAt: new Date(input.returnedAt),
        saleId: sale.id,
        warehouseId: register.warehouseId,
        net,
        vat,
        total,
        note: input.note,
        outsideWindow: !window,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      if (
        isUniqueViolation(error, 'pos_returns_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_returns_tenant_number_idx')
      ) {
        throw numberTaken(number);
      }
      throw error;
    }

    // The goods come back into the register's warehouse (decision 3), at what they cost when sold
    const planned = await this.planStock(tx, register.warehouseId, lines);
    const moves = planned.flatMap((plan) => plan.moves);
    await this.stock.post(tx, {
      date,
      kind: 'pos_return',
      direction: 'in',
      documentId: returnId,
      documentNumber: number,
      moves,
    });

    const written = await tx
      .insert(posReturnLines)
      .values(
        lines.map((line) => ({
          tenantId,
          returnId,
          lineNo: line.index + 1,
          saleLineId: line.sale.id,
          variantId: line.sale.variantId,
          quantity: line.input.quantity,
          baseQuantity: line.baseQuantity,
          net: line.input.net,
          vat: line.input.vat,
          total: addMoney(line.input.net, line.input.vat),
          value: line.value,
          serialNumbers: line.input.serialNumbers,
        })),
      )
      .returning({ id: posReturnLines.id, lineNo: posReturnLines.lineNo });
    const lineIds = new Map(written.map((row) => [row.lineNo, row.id]));
    const batchRows = planned.flatMap((plan) => {
      const lineId = lineIds.get(plan.line.index + 1);
      if (lineId === undefined) return [];
      return plan.batches.map((part) => ({
        tenantId,
        lineId,
        saleLineId: plan.line.sale.id,
        batchId: part.batchId,
        quantity: part.quantity,
      }));
    });
    if (batchRows.length > 0) await tx.insert(posReturnLineBatches).values(batchRows);
    if (refunds.length > 0) {
      await tx.insert(posReturnRefunds).values(
        refunds.map((refund, index) => ({
          tenantId,
          returnId,
          lineNo: index + 1,
          method: refund.method,
          amount: refund.amount,
          reference: refund.reference,
          accountId: refund.accountId,
        })),
      );
    }

    const entry = await this.books.posReturn(
      tx,
      { id: returnId, number, date },
      {
        warehouseId: register.warehouseId,
        saleWarehouseId: sale.warehouseId,
        refunds,
        net,
        vat,
        cost: sumMoney(lines.map((line) => line.value)),
      },
    );

    await this.auditReturn(tx, access, { id: returnId, number, date, total }, input, {
      register,
      sale,
      lines,
      window,
      entryNumber: entry?.number ?? null,
    });

    // The return's own checks (0056's deferred triggers) here, inside the savepoint, like a sale's
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }

  // Decision 43, like a sale's number (20a, decision 37): a refused return's slip was printed, so
  // its number is used. The push calls this after the savepoint rolled back. Only up.
  async keepNumber(tx: Transaction, input: { registerId: string; sequence: number }) {
    await tx
      .update(posRegisters)
      .set({ lastReturnNumber: input.sequence })
      .where(
        and(
          eq(posRegisters.tenantId, getTenantId()),
          eq(posRegisters.id, input.registerId),
          sql`${posRegisters.lastReturnNumber} < ${input.sequence}`,
        ),
      );
  }

  // The return screen online: any register's receipt (decision 21). The number is unique in the
  // workspace (pos_sales_tenant_number_idx). The window is the screen's to check: it knows today.
  returnableSale(number: string): Promise<PosReturnableSale> {
    return this.withTenant(async (tx) => {
      const [sale] = await tx
        .select()
        .from(posSales)
        .where(and(eq(posSales.tenantId, getTenantId()), eq(posSales.number, number)));
      if (!sale) throw saleUnknown(404);
      const [found] = await returnableSalesOf(tx, [sale]);
      if (!found) throw saleUnknown(404);
      return found;
    });
  }

  // Decision 45: the sales the device reads right after it takes a register, in the order they
  // were sold in: by the register's own numbers (pos_sales_register_sequence_idx), which no device's
  // clock can disorder. The same days as the pull's pos_sale rows.
  registerSales(
    registerId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<PosRegisterSalesPage> {
    const after = decodeCursor(query.cursor, salesCursorSchema);
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [register] = await tx
        .select({ id: posRegisters.id })
        .from(posRegisters)
        .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, registerId)));
      if (!register) throw notFound('POS register');
      const rows = await tx
        .select()
        .from(posSales)
        .where(
          and(
            eq(posSales.tenantId, tenantId),
            eq(posSales.registerId, registerId),
            gte(posSales.date, await posSalesFrom(tx)),
            after === undefined ? undefined : gt(posSales.sequence, after[0]),
          ),
        )
        .orderBy(asc(posSales.sequence))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.sequence]);
      return { items: await returnableSalesOf(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    saleId?: string | undefined;
    shiftId?: string | undefined;
  }): Promise<{ items: PosReturnSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, listCursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posReturns.registerId, query.registerId),
          query.saleId === undefined ? undefined : eq(posReturns.saleId, query.saleId),
          query.shiftId === undefined ? undefined : eq(posReturns.shiftId, query.shiftId),
          after === undefined
            ? undefined
            : sql`(${posReturns.date}, ${posReturns.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<PosReturn> {
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const [summary] = await this.summaries(tx, eq(posReturns.id, id), 1);
      if (!summary) throw notFound('POS return');
      const [header] = await tx
        .select({
          note: posReturns.note,
          deviceId: posReturns.deviceId,
          deviceName: devices.name,
          pricesIncludeVat: posSales.pricesIncludeVat,
        })
        .from(posReturns)
        .innerJoin(
          devices,
          and(eq(devices.tenantId, posReturns.tenantId), eq(devices.id, posReturns.deviceId)),
        )
        .innerJoin(
          posSales,
          and(eq(posSales.tenantId, posReturns.tenantId), eq(posSales.id, posReturns.saleId)),
        )
        .where(and(eq(posReturns.tenantId, tenantId), eq(posReturns.id, id)));
      if (!header) throw notFound('POS return');
      const lineRows = await tx
        .select({
          line: posReturnLines,
          unitId: posSaleLines.unitId,
          description: posSaleLines.description,
          unitPrice: posSaleLines.unitPrice,
        })
        .from(posReturnLines)
        .innerJoin(
          posSaleLines,
          and(
            eq(posSaleLines.tenantId, posReturnLines.tenantId),
            eq(posSaleLines.id, posReturnLines.saleLineId),
          ),
        )
        .where(and(eq(posReturnLines.tenantId, tenantId), eq(posReturnLines.returnId, id)))
        .orderBy(asc(posReturnLines.lineNo));
      const variants = await loadVariants(
        tx,
        lineRows.map((row) => row.line.variantId),
      );
      const parts =
        lineRows.length === 0
          ? []
          : await tx
              .select({
                lineId: posReturnLineBatches.lineId,
                batchId: posReturnLineBatches.batchId,
                lotNumber: batches.lotNumber,
                expiresOn: batches.expiresOn,
                quantity: posReturnLineBatches.quantity,
              })
              .from(posReturnLineBatches)
              .innerJoin(
                batches,
                and(
                  eq(batches.tenantId, posReturnLineBatches.tenantId),
                  eq(batches.id, posReturnLineBatches.batchId),
                ),
              )
              .where(
                and(
                  eq(posReturnLineBatches.tenantId, tenantId),
                  inArray(
                    posReturnLineBatches.lineId,
                    lineRows.map((row) => row.line.id),
                  ),
                ),
              )
              .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
      const refundRows = await tx
        .select()
        .from(posReturnRefunds)
        .where(and(eq(posReturnRefunds.tenantId, tenantId), eq(posReturnRefunds.returnId, id)))
        .orderBy(asc(posReturnRefunds.lineNo));
      const [entry] = await this.books.entriesOf(tx, id);
      return {
        ...summary,
        pricesIncludeVat: header.pricesIncludeVat,
        note: header.note,
        lines: lineRows.flatMap(({ line, unitId, description, unitPrice }) => {
          // The FK keeps the variant while a line points at it
          const variant = variants.get(line.variantId);
          if (variant === undefined) return [];
          return [
            {
              variantId: variant.variantId,
              productId: variant.productId,
              productCode: variant.productCode,
              productName: variant.productName,
              optionValues: variant.optionValues,
              sku: variant.sku,
              baseUnitId: variant.baseUnitId,
              id: line.id,
              saleLineId: line.saleLineId,
              unitId,
              quantity: line.quantity,
              baseQuantity: line.baseQuantity,
              description,
              unitPrice,
              net: line.net,
              vat: line.vat,
              total: line.total,
              batches: parts
                .filter((part) => part.lineId === line.id)
                .map((part) => ({
                  batchId: part.batchId,
                  lotNumber: part.lotNumber,
                  expiresOn: part.expiresOn,
                  quantity: part.quantity,
                })),
              serialNumbers: line.serialNumbers,
            },
          ];
        }),
        refunds: refundRows.map((refund) => ({
          method: refund.method,
          amount: refund.amount,
          reference: refund.reference,
          accountId: refund.accountId,
        })),
        device: { id: header.deviceId, name: header.deviceName },
        entry: entry ?? null,
      };
    });
  }

  // Each line against its sale line: a line of this sale, its quantity in the base unit by the
  // sale line's own unit, its serial numbers out of the sale line's, and its share of what the
  // goods cost. A refusal here is a bug: the screen offers only the sale's lines and serials.
  private async planLines(
    tx: Transaction,
    sale: SaleRow,
    input: PosReturnInput,
  ): Promise<PlannedLine[]> {
    const saleLines = await tx
      .select()
      .from(posSaleLines)
      .where(and(eq(posSaleLines.tenantId, getTenantId()), eq(posSaleLines.saleId, sale.id)));
    const byId = new Map(saleLines.map((line) => [line.id, line]));
    const variants = await loadVariants(
      tx,
      saleLines.map((line) => line.variantId),
    );
    const returned = await returnedOf(
      tx,
      saleLines.map((line) => line.id),
    );
    const issues: LineIssue[] = [];
    const planned: PlannedLine[] = [];
    input.lines.forEach((line, index) => {
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      const saleLine = byId.get(line.saleLineId);
      const variant = saleLine === undefined ? undefined : variants.get(saleLine.variantId);
      if (saleLine === undefined || variant === undefined) {
        at('saleLineId', 'pos_return_line_unknown');
        return;
      }
      // Decision 17: in the sale line's unit. The product's pack is still there: a pack a
      // document used is never removed (step 12).
      const unit =
        saleLine.unitId === variant.baseUnitId
          ? { factor: '1' }
          : variant.units.find((pack) => pack.unitId === saleLine.unitId);
      const baseQuantity =
        unit === undefined
          ? null
          : toBaseQuantity(line.quantity, unit.factor, variant.baseDecimals);
      if (baseQuantity === null || !isQuantity(baseQuantity)) {
        at('quantity', 'quantity_format');
        return;
      }
      // A serial product's line brings back one serial number of the sale line per piece; any
      // other line brings back none
      const sold = new Set(saleLine.serialNumbers);
      const serialsOk =
        variant.tracking === 'serial'
          ? isWholeQuantity(baseQuantity) &&
            wholeCount(baseQuantity) === line.serialNumbers.length &&
            line.serialNumbers.every((serial) => sold.has(serial))
          : line.serialNumbers.length === 0;
      if (!serialsOk) {
        at('serialNumbers', 'pos_return_serial_invalid');
        return;
      }
      // The same shares as the money (posReturnAmounts), so all the returns of a line take back
      // exactly what it cost, to the paisa
      const before = returnedFor(returned, saleLine.id).quantity;
      const value = posReturnAmounts(
        { quantity: saleLine.quantity, net: saleLine.value, vat: '0', returnedQuantity: before },
        line.quantity,
      ).net;
      planned.push({ index, input: line, sale: saleLine, variant, baseQuantity, before, value });
    });
    if (issues.length > 0) throw linesError(issues);
    return planned;
  }

  // Where each line's goods go back to, in the register's warehouse:
  //   no tracking  the line's base quantity
  //   batch        into the batches the sale line left from (decision 16), in the order it took
  //                them (the cashier's batch first), each up to what it gave less what earlier
  //                returns put back; what is still left (more than was sold) into the first
  //   serial       a serial number that left with the sale comes back with it; one the sale took
  //                as a piece without its number (sold short, 20a), or one in stock or on a
  //                truck since, comes back as a piece without one, so a return is never refused
  // Each move carries its share of the line's cost, by quantity.
  private async planStock(
    tx: Transaction,
    warehouseId: string,
    lines: readonly PlannedLine[],
  ): Promise<
    { line: PlannedLine; moves: StockMove[]; batches: { batchId: string; quantity: string }[] }[]
  > {
    const tenantId = getTenantId();
    const goods = lines.filter((line) => line.variant.type === 'goods');
    const batchLines = goods.filter((line) => line.variant.tracking === 'batch');
    const saleBatches =
      batchLines.length === 0
        ? []
        : await tx
            .select({
              lineId: posSaleLineBatches.lineId,
              batchId: posSaleLineBatches.batchId,
              quantity: posSaleLineBatches.quantity,
              expiresOn: batches.expiresOn,
            })
            .from(posSaleLineBatches)
            .innerJoin(
              batches,
              and(
                eq(batches.tenantId, posSaleLineBatches.tenantId),
                eq(batches.id, posSaleLineBatches.batchId),
              ),
            )
            .where(
              and(
                eq(posSaleLineBatches.tenantId, tenantId),
                inArray(
                  posSaleLineBatches.lineId,
                  batchLines.map((line) => line.sale.id),
                ),
              ),
            )
            .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
    const backBefore =
      batchLines.length === 0
        ? []
        : await tx
            .select({
              saleLineId: posReturnLineBatches.saleLineId,
              batchId: posReturnLineBatches.batchId,
              quantity: posReturnLineBatches.quantity,
            })
            .from(posReturnLineBatches)
            .where(
              and(
                eq(posReturnLineBatches.tenantId, tenantId),
                inArray(
                  posReturnLineBatches.saleLineId,
                  batchLines.map((line) => line.sale.id),
                ),
              ),
            );
    const withNumber = await this.serialsBack(
      tx,
      goods.filter((line) => line.variant.tracking === 'serial'),
    );

    return lines.map((line) => {
      if (line.variant.type !== 'goods') return { line, moves: [], batches: [] };
      const move = (
        batchId: string | null,
        quantity: string,
        value: string,
        serialNumbers: string[] = [],
      ): StockMove => ({
        line: line.index,
        warehouseId,
        variant: line.variant,
        batchId,
        quantity,
        serialNumbers,
        value,
      });

      if (line.variant.tracking === 'batch') {
        const own = line.sale.batchId;
        const rows = saleBatches
          .filter((row) => row.lineId === line.sale.id)
          .sort((a, b) => Number(b.batchId === own) - Number(a.batchId === own));
        const taken = new Map<string, string>();
        let wanted = line.baseQuantity;
        for (const row of rows) {
          if (compareQuantity(wanted, '0') <= 0) break;
          const back = backBefore
            .filter((part) => part.saleLineId === line.sale.id && part.batchId === row.batchId)
            .reduce((sum, part) => addQuantity(sum, part.quantity), '0');
          const room = subtractQuantity(row.quantity, back);
          if (compareQuantity(room, '0') <= 0) continue;
          const part = compareQuantity(room, wanted) < 0 ? room : wanted;
          taken.set(row.batchId, part);
          wanted = subtractQuantity(wanted, part);
        }
        const [first] = rows;
        // A batch line always left from at least one batch (0052's pos_sale_line_batches_match)
        if (first === undefined) throw new Error(`POS sale line ${line.sale.id} has no batches`);
        if (compareQuantity(wanted, '0') > 0) {
          taken.set(first.batchId, addQuantity(taken.get(first.batchId) ?? '0', wanted));
        }
        const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
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

      if (line.variant.tracking === 'serial') {
        const found = line.input.serialNumbers.filter((serial) =>
          withNumber.has(`${line.variant.variantId}|${serial}`),
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
              ? [move(null, String(found.length), values[0] ?? '0', found)]
              : []),
            ...(pieces > 0
              ? [move(null, String(pieces), values[found.length > 0 ? 1 : 0] ?? '0')]
              : []),
          ],
          batches: [],
        };
      }

      return { line, moves: [move(null, line.baseQuantity, line.value)], batches: [] };
    });
  }

  // The serial numbers that can come back with their number: sold with the sale (not sold short),
  // out of every warehouse now and not on a truck. FOR UPDATE in id order, post()'s own order, so
  // nothing moves them between this and the posting. Returns variant|serial keys.
  private async serialsBack(tx: Transaction, lines: readonly PlannedLine[]): Promise<Set<string>> {
    const tenantId = getTenantId();
    const wanted = lines.flatMap((line) =>
      line.input.serialNumbers
        .filter((serial) => !line.sale.shortSerials.includes(serial))
        .map((serial) => ({ variantId: line.variant.variantId, serial })),
    );
    if (wanted.length === 0) return new Set();
    const variantIds = [...new Set(wanted.map((item) => item.variantId))];
    const numbers = [...new Set(wanted.map((item) => item.serial))];
    const rows = await tx
      .select({
        variantId: serials.variantId,
        serialNumber: serials.serialNumber,
        warehouseId: serials.warehouseId,
      })
      .from(serials)
      .where(
        and(
          eq(serials.tenantId, tenantId),
          inArray(serials.variantId, variantIds),
          inArray(serials.serialNumber, numbers),
        ),
      )
      .orderBy(asc(serials.id))
      .for('update');
    const sent = await tx
      .select({
        variantId: stockTransferLines.variantId,
        serialNumbers: stockTransferLines.serialNumbers,
      })
      .from(stockTransferLines)
      .innerJoin(
        stockTransfers,
        and(
          eq(stockTransfers.tenantId, stockTransferLines.tenantId),
          eq(stockTransfers.id, stockTransferLines.transferId),
        ),
      )
      .where(
        and(
          eq(stockTransferLines.tenantId, tenantId),
          eq(stockTransfers.status, 'in_transit'),
          inArray(stockTransferLines.variantId, variantIds),
        ),
      );
    const onTruck = new Set(
      sent.flatMap((line) => line.serialNumbers.map((serial) => `${line.variantId}|${serial}`)),
    );
    const out = new Set(
      rows
        .filter((row) => row.warehouseId === null)
        .map((row) => `${row.variantId}|${row.serialNumber}`),
    );
    return new Set(
      wanted
        .map((item) => `${item.variantId}|${item.serial}`)
        .filter((key) => out.has(key) && !onTruck.has(key)),
    );
  }

  // Decision 20: what the server would have refused, written down instead. Each row says what the
  // device sent and what the server knew.
  private async auditReturn(
    tx: Transaction,
    access: Access,
    document: { id: string; number: string; date: string; total: string },
    input: PosReturnInput,
    known: {
      register: typeof posRegisters.$inferSelect;
      sale: SaleRow;
      lines: readonly PlannedLine[];
      window: boolean;
      entryNumber: string | null;
    },
  ): Promise<void> {
    const { register, sale, lines } = known;
    const row = { entityType: 'pos_return' as const, entityId: document.id };
    await audit(tx, {
      ...row,
      action: 'pos_return.created',
      changes: created({
        number: document.number,
        date: document.date,
        returnedOn: input.date,
        register: register.code,
        sale: sale.number,
        total: document.total,
        refunds: input.refunds.map((refund) => `${refund.method} ${refund.amount}`).join(', '),
        entry: known.entryNumber,
      }),
    });
    if (!known.window) {
      await audit(tx, {
        ...row,
        action: 'pos_return.outside_window',
        changes: created({
          sale: sale.number,
          soldOn: sale.date,
          returnedOn: input.date,
          returnDays: String(register.returnDays),
        }),
      });
    }
    // Against what was returned before this one, as the server knows it (the sale is locked)
    const over = lines.filter((line) => {
      const left = returnableQuantityOf({
        quantity: line.sale.quantity,
        returnedQuantity: line.before,
      });
      return compareQuantity(line.input.quantity, left) > 0;
    });
    if (over.length > 0) {
      await audit(tx, {
        ...row,
        action: 'pos_return.over_returned',
        changes: created({
          lines: over
            .map(
              (line) =>
                `line ${String(line.index + 1)}: ${line.input.quantity} of ${line.sale.quantity}, ${line.before} back before`,
            )
            .join('; '),
        }),
      });
    }
    const differ = lines.flatMap((line) => {
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
    });
    if (differ.length > 0) {
      await audit(tx, {
        ...row,
        action: 'pos_return.amounts_differ',
        changes: created({ lines: differ.join('; ') }),
      });
    }
    if (!access.permissions.includes('pos.return.create')) {
      await audit(tx, {
        ...row,
        action: 'pos_return.without_permission',
        changes: created({
          number: document.number,
          returnedOn: input.date,
          missing: 'pos.return.create',
        }),
      });
    }
  }

  // The list's rows, and the page's header
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosReturnSummary[]> {
    const rows = await tx
      .select({
        ret: posReturns,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        shiftNumber: posShifts.number,
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        sale: {
          id: posSales.id,
          number: posSales.number,
          date: posSales.date,
          customerId: posSales.customerId,
        },
        exchangeSale: { id: exchangeSales.id, number: exchangeSales.number },
        lineCount: sql<number>`(SELECT count(*)::int FROM pos_return_lines l
          WHERE l.tenant_id = ${posReturns.tenantId} AND l.return_id = ${posReturns.id})`,
      })
      .from(posReturns)
      .innerJoin(
        posRegisters,
        and(
          eq(posRegisters.tenantId, posReturns.tenantId),
          eq(posRegisters.id, posReturns.registerId),
        ),
      )
      .innerJoin(
        posShifts,
        and(eq(posShifts.tenantId, posReturns.tenantId), eq(posShifts.id, posReturns.shiftId)),
      )
      .innerJoin(
        warehouses,
        and(
          eq(warehouses.tenantId, posReturns.tenantId),
          eq(warehouses.id, posReturns.warehouseId),
        ),
      )
      .innerJoin(
        posSales,
        and(eq(posSales.tenantId, posReturns.tenantId), eq(posSales.id, posReturns.saleId)),
      )
      // One sale at most uses a return (pos_sale_payments_return_idx), so no row is doubled
      .leftJoin(
        posSalePayments,
        and(
          eq(posSalePayments.tenantId, posReturns.tenantId),
          eq(posSalePayments.returnId, posReturns.id),
        ),
      )
      .leftJoin(
        exchangeSales,
        and(
          eq(exchangeSales.tenantId, posSalePayments.tenantId),
          eq(exchangeSales.id, posSalePayments.saleId),
        ),
      )
      .leftJoin(users, eq(users.id, posReturns.createdBy))
      .where(and(eq(posReturns.tenantId, getTenantId()), where))
      .orderBy(desc(posReturns.date), desc(posReturns.id))
      .limit(limit);
    const customers = await customerRefs(
      tx,
      rows.flatMap((row) => (row.sale.customerId === null ? [] : [row.sale.customerId])),
    );
    return rows.map((row) => toSummary(row, customers));
  }
}

function toSummary(
  row: {
    ret: ReturnRow;
    register: { id: string; code: string; name: string };
    shiftNumber: string;
    branchId: string;
    cashierName: string | null;
    sale: { id: string; number: string; date: string; customerId: string | null };
    exchangeSale: { id: string; number: string } | null;
    lineCount: number;
  },
  customers: Map<string, PartyRef>,
): PosReturnSummary {
  const { ret, sale } = row;
  // created_by is the person who pushed it: never empty for a return (createFromDevice sets it)
  if (ret.createdBy === null) throw new Error(`POS return ${ret.id} has no cashier`);
  return {
    id: ret.id,
    number: ret.number,
    register: row.register,
    shift: { id: ret.shiftId, number: row.shiftNumber },
    branchId: row.branchId,
    warehouseId: ret.warehouseId,
    date: ret.date,
    returnedAt: ret.returnedAt.toISOString(),
    sale: { id: sale.id, number: sale.number, date: sale.date },
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    cashier: { id: ret.createdBy, fullName: row.cashierName ?? '' },
    net: ret.net,
    vat: ret.vat,
    total: ret.total,
    lineCount: row.lineCount,
    exchangeSale: row.exchangeSale,
    outsideWindow: ret.outsideWindow,
    createdAt: ret.createdAt.toISOString(),
  };
}
