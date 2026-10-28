import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  compareQuantity,
  type ErrorCode,
  formatPosNumber,
  isWholeQuantity,
  negateMoney,
  type PartyRef,
  type PosOverride,
  posOverridesOf,
  type PosSale,
  type PosSaleInput,
  type PosSaleSummary,
  posSaleAmounts,
  posChangeOf,
  type SoldShortItem,
  sumMoney,
  todayIn,
  wholeCount,
} from '@omnivo/contracts';
import {
  batches,
  devices,
  posRegisters,
  posSaleLineBatches,
  posSaleLines,
  posSalePayments,
  posSales,
  tenantSettings,
  users,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { isUniqueViolation } from '../common/db/pg-errors.js';
import { AppError, notFound } from '../common/http/app-error.js';
import { emit } from '../common/outbox/outbox.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentDeviceId, currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { type LineIssue, linePath, linesError, loadVariants } from '../inventory/stock-lines.js';
import {
  type SaleDemand,
  type SalePlan,
  StockPostingService,
} from '../inventory/stock-posting.service.js';
import { firstOpenDay } from '../journal/period-lock.service.js';
import type { Access } from '../rbac/permission.service.js';
import {
  assertCustomer,
  customerRefs,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { accountOf } from './pos-registers.service.js';

type SaleRow = typeof posSales.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// A plan for a line that moves no stock: a service, which is sold but never delivered
const NO_STOCK: SalePlan = { moves: [], batches: [], shortQuantity: '0', shortSerials: [] };

function notHeld(): AppError {
  return new AppError(
    409,
    'pos_register_not_held',
    'This device does not hold the register the sale was made on.',
    { fieldErrors: { registerId: ['pos_register_not_held'] } },
  );
}

// Decision 34: not the cashier's to fix, and impossible under decision 14. It shows a bug.
function numberTaken(number: string): AppError {
  return new AppError(409, 'pos_number_taken', `Another sale already has number ${number}.`, {
    fieldErrors: { sequence: ['pos_number_taken'] },
  });
}

// "price on line 2, discount on line 3, bill discount": what the audit log shows of the
// overrides, counted from 1 like the receipt
function overrideText(overrides: readonly PosOverride[]): string {
  return overrides
    .map((override) =>
      override.kind === 'bill_discount'
        ? 'bill discount'
        : `${override.kind} on line ${String(override.line + 1)}`,
    )
    .join(', ');
}

// What a line moved short of: below zero, or serial numbers that were not there
function isShort(plan: SalePlan): boolean {
  return compareQuantity(plan.shortQuantity, '0') > 0 || plan.shortSerials.length > 0;
}

// POS sales (step 20a). A sale is written in one place: the sync's push, through createFromDevice
// (decision 21). It is posted the moment it is written (no draft, no status): its lines, the
// batches they left from, its payments, its stock movements and its journal entry, in the push's
// transaction for that command. It is never refused for stock or for its date (decisions 7, 26);
// the refusals left are a missing permission (decision 28), a register the device does not hold,
// a method the register lost (decision 34), and lines the server cannot read (an unknown item).
@Injectable()
export class PosSalesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly stock: StockPostingService,
    private readonly books: StockBooksService,
  ) {}

  // The work of one pos_sale.create command, inside the push's savepoint. `access` is the
  // person's roles of now: whether the sale and its overrides were theirs to make goes into the
  // audit log, never into a refusal.
  async createFromDevice(
    tx: Transaction,
    access: Access,
    saleId: string,
    input: PosSaleInput,
  ): Promise<void> {
    const tenantId = getTenantId();
    const deviceId = currentDeviceId();
    if (deviceId === null) throw new Error('A POS sale is written only from a device');

    // The device first, then the register (the lock order of 0052): a revoke of this device that
    // is running finishes first, and frees the register, which this then sees
    await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.tenantId, tenantId), eq(devices.id, deviceId)))
      .for('share');
    // FOR UPDATE: the sales of one register are written one after the other. The database
    // moves its last number in the same transaction (0052's pos_sales_last_number).
    const [register] = await tx
      .select()
      .from(posRegisters)
      .where(and(eq(posRegisters.tenantId, tenantId), eq(posRegisters.id, input.registerId)))
      .for('update');
    // The device holds its register while a sale of it waits (decisions 14 and 32), so this is a
    // bug or a register of another workspace
    if (register?.deviceId !== deviceId) throw notHeld();
    const number = formatPosNumber(register.code, input.sequence);

    // The register's account for each method now: the money goes where the register says today
    const issues: LineIssue[] = [];
    const payments = input.payments.map((payment, index) => {
      const accountId = accountOf(register, payment.method);
      if (accountId === null) {
        issues.push({ path: `payments.${String(index)}.method`, code: 'pos_method_not_set' });
      }
      return { ...payment, accountId: accountId ?? '' };
    });
    if (issues.length > 0) {
      throw new AppError(
        409,
        'pos_method_not_set',
        'The register has no account for a way this sale was paid. Set one in Settings → POS.',
        { fieldErrors: Object.fromEntries(issues.map((issue) => [issue.path, [issue.code]])) },
      );
    }

    // A customer archived after the sale keeps it (assertCustomer's keptId): it was sold already
    const customer =
      input.customerId === null
        ? null
        : await assertCustomer(tx, input.customerId, input.customerId);
    // Items and VAT rates archived after the sale stay usable for the same reason. The amounts
    // come from posSaleAmounts() below, with the device's rates (decision 22), not from here.
    const lines = await resolveSalesLines(
      tx,
      input.lines,
      input.pricesIncludeVat,
      new Set(input.lines.map((line) => line.taxRateId)),
      new Set(input.lines.map((line) => line.variantId)),
    );
    await this.checkTracking(tx, input, lines);
    const amounts = posSaleAmounts(
      input.lines,
      { type: input.billDiscountType, value: input.billDiscount },
      input.pricesIncludeVat,
    );
    const paid = sumMoney(input.payments.map((payment) => payment.amount));
    const change = posChangeOf(input.payments, amounts.totals.total);

    // Decision 26: on the device's day, unless the device's clock is ahead of the server's today,
    // or the books are closed for that day: then on the first day they take
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);
    const today = todayIn(settings.timezone);
    const date = await firstOpenDay(tx, input.date > today ? today : input.date);

    try {
      await tx.insert(posSales).values({
        id: saleId,
        tenantId,
        registerId: register.id,
        sequence: input.sequence,
        number,
        date,
        soldAt: new Date(input.soldAt),
        customerId: customer?.id ?? null,
        warehouseId: register.warehouseId,
        deviceId,
        pricesIncludeVat: input.pricesIncludeVat,
        billDiscountType: input.billDiscountType,
        billDiscount: input.billDiscount,
        billDiscountAmount: amounts.totals.billDiscount,
        discount: amounts.totals.discount,
        net: amounts.totals.net,
        vat: amounts.totals.vat,
        total: amounts.totals.total,
        paid,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      });
    } catch (error) {
      // The register is locked, so only a bug gets here (decision 34). The savepoint rolls back
      // when this leaves the push's nested transaction.
      if (
        isUniqueViolation(error, 'pos_sales_register_sequence_idx') ||
        isUniqueViolation(error, 'pos_sales_tenant_number_idx')
      ) {
        throw numberTaken(number);
      }
      throw error;
    }

    // The stock: where each goods line leaves from (decision 15), then the movements, which take
    // what is missing below zero
    const demands: SaleDemand[] = lines.flatMap((line, index) => {
      if (line.variant.type !== 'goods') return [];
      const sent = input.lines[index];
      return [
        {
          line: index,
          variant: line.variant,
          baseQuantity: line.baseQuantity,
          batchId: line.variant.tracking === 'batch' ? (sent?.batchId ?? null) : null,
          serialNumbers: line.variant.tracking === 'serial' ? (sent?.serialNumbers ?? []) : [],
        },
      ];
    });
    const planned = await this.stock.planSale(tx, register.warehouseId, input.date, demands);
    const plans = lines.map((_, index) => {
      const at = demands.findIndex((demand) => demand.line === index);
      return at === -1 ? NO_STOCK : (planned[at] ?? NO_STOCK);
    });
    const moves = plans.flatMap((plan) => plan.moves);
    const values = await this.stock.post(tx, {
      date,
      kind: 'pos_sale',
      direction: 'out',
      documentId: saleId,
      documentNumber: number,
      moves,
      belowZero: true,
    });
    // post() answers in the order of the moves: each line's value is the sum of its own
    let next = 0;
    const lineValues = plans.map((plan) => {
      const own = values.slice(next, next + plan.moves.length);
      next += plan.moves.length;
      return sumMoney(own);
    });

    const written = await tx
      .insert(posSaleLines)
      .values(
        lines.map((line, index) => {
          const sent = input.lines[index];
          const lineAmounts = amounts.lines[index];
          const plan = plans[index] ?? NO_STOCK;
          if (sent === undefined || lineAmounts === undefined) {
            throw new Error(`POS line ${String(index)} has no input`);
          }
          return {
            ...salesLineValues(line, index),
            // The device's rate and the amounts worked out with it (decision 22)
            taxRate: sent.rate,
            net: lineAmounts.net,
            vat: lineAmounts.vat,
            total: lineAmounts.total,
            saleId,
            startingPrice: sent.startingPrice,
            billDiscount: lineAmounts.billDiscount,
            batchId: line.variant.tracking === 'batch' ? sent.batchId : null,
            serialNumbers: line.variant.tracking === 'serial' ? sent.serialNumbers : [],
            value: lineValues[index] ?? '0',
            shortQuantity: plan.shortQuantity,
            shortSerials: plan.shortSerials,
          };
        }),
      )
      .returning({ id: posSaleLines.id, lineNo: posSaleLines.lineNo });
    const lineIds = new Map(written.map((row) => [row.lineNo, row.id]));
    const batchRows = plans.flatMap((plan, index) => {
      const lineId = lineIds.get(index + 1);
      const variantId = lines[index]?.variant.variantId;
      if (lineId === undefined || variantId === undefined) return [];
      return plan.batches.map((part) => ({
        tenantId,
        lineId,
        variantId,
        batchId: part.batchId,
        quantity: part.quantity,
      }));
    });
    if (batchRows.length > 0) await tx.insert(posSaleLineBatches).values(batchRows);
    await tx.insert(posSalePayments).values(
      payments.map((payment, index) => ({
        tenantId,
        saleId,
        lineNo: index + 1,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference,
        accountId: payment.accountId,
      })),
    );

    // The books: the change came out of the cash, so it is a minus on the cash account
    const cost = sumMoney(lineValues);
    const entry = await this.books.posSale(
      tx,
      { id: saleId, number, date },
      {
        warehouseId: register.warehouseId,
        payments: [
          ...payments.map((payment) => ({ accountId: payment.accountId, amount: payment.amount })),
          ...(compareMoney(change, '0') > 0
            ? [{ accountId: register.cashAccountId, amount: negateMoney(change) }]
            : []),
        ],
        net: amounts.totals.net,
        vat: amounts.totals.vat,
        cost,
      },
    );

    const shortLines = plans.filter(isShort).length;
    await audit(tx, {
      action: 'pos_sale.created',
      entityType: 'pos_sale',
      entityId: saleId,
      changes: created({
        number,
        date,
        soldOn: input.date,
        register: register.code,
        customer: customer?.code ?? null,
        total: amounts.totals.total,
        paid,
        entry: entry?.number ?? null,
        soldShort: shortLines,
      }),
    });
    // Decision 28: the push let it through without the permission (taken away while the device was
    // offline); the log says so, with the device's day, so a manager can see when it was sold
    if (!access.permissions.includes('pos.sale.create')) {
      await audit(tx, {
        action: 'pos_sale.without_permission',
        entityType: 'pos_sale',
        entityId: saleId,
        changes: created({ number, soldOn: input.date, missing: 'pos.sale.create' }),
      });
    }
    // Decision 25: written whether or not the cashier had the permission; never a refusal
    const overrides = posOverridesOf(input, register.maxDiscountPercent);
    if (overrides.length > 0) {
      await audit(tx, {
        action: 'pos_sale.overridden',
        entityType: 'pos_sale',
        entityId: saleId,
        changes: created({
          overrides: overrideText(overrides),
          maxDiscountPercent: register.maxDiscountPercent,
          allowed: access.permissions.includes('pos.price.override'),
        }),
      });
    }
    // Decision 30: the people who put stock right hear about it after the commit
    if (shortLines > 0) await emit(tx, 'pos.sold_short', { saleId });

    // The sale's own check (0052's deferred triggers) runs here, inside the savepoint, rather than
    // at the push's COMMIT after the answer row: a sale that does not add up fails with this
    // command, on this line of code. It is a bug either way, and the push answers it with a 500.
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }

  // Decision 37: a refused sale's receipt was printed, so its number is used. The push calls this
  // after the savepoint rolled back. Without a version, like the trigger's own move, and only up.
  async keepNumber(tx: Transaction, input: { registerId: string; sequence: number }) {
    await tx
      .update(posRegisters)
      .set({ lastNumber: input.sequence })
      .where(
        and(
          eq(posRegisters.tenantId, getTenantId()),
          eq(posRegisters.id, input.registerId),
          lt(posRegisters.lastNumber, input.sequence),
        ),
      );
  }

  list(query: {
    limit: number;
    cursor?: string | undefined;
    registerId?: string | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: PosSaleSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.registerId === undefined ? undefined : eq(posSales.registerId, query.registerId),
          query.customerId === undefined ? undefined : eq(posSales.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${posSales.date}, ${posSales.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<PosSale> {
    return this.withTenant(async (tx) => {
      const [summary] = await this.summaries(tx, eq(posSales.id, id), 1);
      if (!summary) throw notFound('POS sale');
      const [header] = await tx
        .select({ sale: posSales, deviceName: devices.name })
        .from(posSales)
        .innerJoin(
          devices,
          and(eq(devices.tenantId, posSales.tenantId), eq(devices.id, posSales.deviceId)),
        )
        .where(and(eq(posSales.tenantId, getTenantId()), eq(posSales.id, id)));
      if (!header) throw notFound('POS sale');
      const { sale } = header;
      const lineRows = await tx
        .select()
        .from(posSaleLines)
        .where(and(eq(posSaleLines.tenantId, getTenantId()), eq(posSaleLines.saleId, id)))
        .orderBy(asc(posSaleLines.lineNo));
      const parts =
        lineRows.length === 0
          ? []
          : await tx
              .select({
                lineId: posSaleLineBatches.lineId,
                batchId: posSaleLineBatches.batchId,
                lotNumber: batches.lotNumber,
                expiresOn: batches.expiresOn,
                quantity: posSaleLineBatches.quantity,
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
                  eq(posSaleLineBatches.tenantId, getTenantId()),
                  inArray(
                    posSaleLineBatches.lineId,
                    lineRows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(sql`${batches.expiresOn} ASC NULLS LAST`, asc(batches.id));
      const paymentRows = await tx
        .select()
        .from(posSalePayments)
        .where(and(eq(posSalePayments.tenantId, getTenantId()), eq(posSalePayments.saleId, id)))
        .orderBy(asc(posSalePayments.lineNo));
      const [entry] = await this.books.entriesOf(tx, id);
      return {
        ...summary,
        pricesIncludeVat: sale.pricesIncludeVat,
        discount: sale.discount,
        billDiscountType: sale.billDiscountType,
        billDiscount: sale.billDiscount,
        billDiscountAmount: sale.billDiscountAmount,
        paid: sale.paid,
        change: posChangeOf(paymentRows, sale.total),
        lines: (await withVariants(tx, lineRows)).map(({ row, variant }) => ({
          ...toSalesLine(row, variant),
          billDiscount: row.billDiscount,
          startingPrice: row.startingPrice,
          // The device's batch first, then the others by expiry, as planSale() took them
          batches: parts
            .filter((part) => part.lineId === row.id)
            .sort((a, b) => Number(b.batchId === row.batchId) - Number(a.batchId === row.batchId))
            .map((part) => ({
              batchId: part.batchId,
              lotNumber: part.lotNumber,
              expiresOn: part.expiresOn,
              quantity: part.quantity,
            })),
          serialNumbers: row.serialNumbers,
          shortQuantity: row.shortQuantity,
        })),
        payments: paymentRows.map((payment) => ({
          method: payment.method,
          amount: payment.amount,
          reference: payment.reference,
          accountId: payment.accountId,
        })),
        device: { id: sale.deviceId, name: header.deviceName },
        entry: entry ?? null,
      };
    });
  }

  // The lines that went below zero, newest sale first (decision 30). onHandNow is the variant's
  // stock in that warehouse now, every batch together, so a manager sees it was put right.
  soldShort(query: {
    limit: number;
    cursor?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: SoldShortItem[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      const rows = await tx
        .select({
          lineId: posSaleLines.id,
          variantId: posSaleLines.variantId,
          saleId: posSales.id,
          saleNumber: posSales.number,
          date: posSales.date,
          warehouseId: posSales.warehouseId,
          shortQuantity: posSaleLines.shortQuantity,
          shortSerials: posSaleLines.shortSerials,
          lotNumber: batches.lotNumber,
          onHandNow: sql<string>`coalesce((SELECT sum(sb.quantity) FROM stock_balances sb
            WHERE sb.tenant_id = ${posSales.tenantId} AND sb.warehouse_id = ${posSales.warehouseId}
              AND sb.variant_id = ${posSaleLines.variantId}), 0)::text`,
        })
        .from(posSaleLines)
        .innerJoin(
          posSales,
          and(eq(posSales.tenantId, posSaleLines.tenantId), eq(posSales.id, posSaleLines.saleId)),
        )
        .leftJoin(
          batches,
          and(eq(batches.tenantId, posSaleLines.tenantId), eq(batches.id, posSaleLines.batchId)),
        )
        .where(
          and(
            eq(posSaleLines.tenantId, tenantId),
            // The partial index's own condition (pos_sale_lines_short_idx)
            or(
              sql`${posSaleLines.shortQuantity} > 0`,
              sql`cardinality(${posSaleLines.shortSerials}) > 0`,
            ),
            query.warehouseId === undefined
              ? undefined
              : eq(posSales.warehouseId, query.warehouseId),
            after === undefined
              ? undefined
              : sql`(${posSales.date}, ${posSaleLines.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
          ),
        )
        .orderBy(desc(posSales.date), desc(posSaleLines.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit, (last) => [last.date, last.lineId]);
      const variants = await loadVariants(
        tx,
        page.items.map((row) => row.variantId),
      );
      return {
        items: page.items.flatMap((row) => {
          // The FK keeps the variant while a line points at it
          const variant = variants.get(row.variantId);
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
              lineId: row.lineId,
              saleId: row.saleId,
              saleNumber: row.saleNumber,
              date: row.date,
              warehouseId: row.warehouseId,
              shortQuantity: row.shortQuantity,
              lotNumber: row.lotNumber,
              serialNumbers: row.shortSerials,
              onHandNow: row.onHandNow,
            },
          ];
        }),
        nextCursor: page.nextCursor,
      };
    });
  }

  // Every rule of a goods line that resolveSalesLines() leaves to the stock documents: a batch
  // product names a batch of its own variant, a serial product one serial number per piece in the
  // base unit (resolveLines()'s rules, with the same codes). The device always sends them; a
  // refusal here is a bug, not a cashier's slip.
  private async checkTracking(
    tx: Transaction,
    input: PosSaleInput,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    const batchIds = [
      ...new Set(input.lines.flatMap((line) => (line.batchId === null ? [] : [line.batchId]))),
    ];
    const known =
      batchIds.length === 0
        ? []
        : await tx
            .select({ id: batches.id, variantId: batches.variantId })
            .from(batches)
            .where(and(eq(batches.tenantId, getTenantId()), inArray(batches.id, batchIds)));
    const batchVariant = new Map(known.map((batch) => [batch.id, batch.variantId]));
    const issues: LineIssue[] = [];
    lines.forEach((line, index) => {
      const sent = input.lines[index];
      const at = (field: string, code: ErrorCode) => {
        issues.push({ path: linePath(index, field), code });
      };
      if (sent === undefined || line.variant.type !== 'goods') return;
      if (line.variant.tracking === 'batch') {
        if (sent.batchId === null) at('batchId', 'stock_batch_required');
        else if (batchVariant.get(sent.batchId) !== line.variant.variantId) {
          at('batchId', 'stock_batch_invalid');
        }
      }
      // A pack of 2 phones is 2 pieces in the base unit, and 2 IMEIs
      if (
        line.variant.tracking === 'serial' &&
        (!isWholeQuantity(line.baseQuantity) ||
          wholeCount(line.baseQuantity) !== sent.serialNumbers.length)
      ) {
        at('serialNumbers', 'stock_serial_count');
      }
    });
    if (issues.length > 0) throw linesError(issues);
  }

  // The list's rows, and the page's header: the register, the branch, the cashier, the customer
  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<PosSaleSummary[]> {
    const rows = await tx
      .select({
        sale: posSales,
        register: { id: posRegisters.id, code: posRegisters.code, name: posRegisters.name },
        branchId: warehouses.branchId,
        cashierName: users.fullName,
        lineCount: sql<number>`(SELECT count(*)::int FROM pos_sale_lines l
          WHERE l.tenant_id = ${posSales.tenantId} AND l.sale_id = ${posSales.id})`,
        soldShort: sql<boolean>`EXISTS (SELECT 1 FROM pos_sale_lines l
          WHERE l.tenant_id = ${posSales.tenantId} AND l.sale_id = ${posSales.id}
            AND (l.short_quantity > 0 OR cardinality(l.short_serials) > 0))`,
      })
      .from(posSales)
      .innerJoin(
        posRegisters,
        and(eq(posRegisters.tenantId, posSales.tenantId), eq(posRegisters.id, posSales.registerId)),
      )
      .innerJoin(
        warehouses,
        and(eq(warehouses.tenantId, posSales.tenantId), eq(warehouses.id, posSales.warehouseId)),
      )
      .leftJoin(users, eq(users.id, posSales.createdBy))
      .where(and(eq(posSales.tenantId, getTenantId()), where))
      .orderBy(desc(posSales.date), desc(posSales.id))
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
    sale: SaleRow;
    register: { id: string; code: string; name: string };
    branchId: string;
    cashierName: string | null;
    lineCount: number;
    soldShort: boolean;
  },
  customers: Map<string, PartyRef>,
): PosSaleSummary {
  const { sale } = row;
  // created_by is the person who pushed it: never empty for a sale (createFromDevice sets it)
  if (sale.createdBy === null) throw new Error(`POS sale ${sale.id} has no cashier`);
  return {
    id: sale.id,
    number: sale.number,
    register: row.register,
    branchId: row.branchId,
    warehouseId: sale.warehouseId,
    date: sale.date,
    soldAt: sale.soldAt.toISOString(),
    customer: sale.customerId === null ? null : (customers.get(sale.customerId) ?? null),
    cashier: { id: sale.createdBy, fullName: row.cashierName ?? '' },
    net: sale.net,
    vat: sale.vat,
    total: sale.total,
    lineCount: row.lineCount,
    soldShort: row.soldShort,
    createdAt: sale.createdAt.toISOString(),
  };
}
