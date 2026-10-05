import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type ErrorCode,
  fitsDecimals,
  isZeroQuantity,
  type ReceiveTransferInput,
  type StockTransfer,
  type StockTransferInput,
  type StockTransferSummary,
  type TransferStatus,
  type UpdateStockTransferInput,
  wholeCount,
} from '@omnivo/contracts';
import { stockTransferLines, stockTransfers, warehouses } from '@omnivo/db';
import { and, asc, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineInput,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from './stock-lines.js';
import { StockPostingService } from './stock-posting.service.js';

type TransferRow = typeof stockTransfers.$inferSelect;
type LineRow = typeof stockTransferLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockTransfers.id} as
// a bare "id", which inside these subqueries would mean the line's own id
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_transfer_lines l
   WHERE l.tenant_id = stock_transfers.tenant_id AND l.transfer_id = stock_transfers.id
)`;

// Any line received short: what was sent and what arrived differ
const short = sql<boolean>`EXISTS (
  SELECT 1 FROM stock_transfer_lines l
   WHERE l.tenant_id = stock_transfers.tenant_id AND l.transfer_id = stock_transfers.id
     AND l.received_quantity < l.base_quantity
)`;

function notDraft(): AppError {
  return new AppError(409, 'stock_not_draft', 'Only a draft transfer can be changed or sent.');
}

function toSummary(row: TransferRow, lines: number, isShort: boolean): StockTransferSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    fromWarehouseId: row.fromWarehouseId,
    toWarehouseId: row.toWarehouseId,
    sentOn: row.sentOn,
    receivedOn: row.receivedOn,
    note: row.note,
    lineCount: lines,
    short: isShort,
    sentAt: row.sentAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
  };
}

@Injectable()
export class StockTransfersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: TransferStatus | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: StockTransferSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(stockTransfers.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : or(
                eq(stockTransfers.fromWarehouseId, query.warehouseId),
                eq(stockTransfers.toWarehouseId, query.warehouseId),
              ),
          after === undefined
            ? undefined
            : sql`(${stockTransfers.sentOn}, ${stockTransfers.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.sentOn, last.id]);
    });
  }

  get(id: string): Promise<StockTransfer> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockTransferInput): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      await this.assertPlaces(tx, input);
      const lines = await resolveLines(tx, input.lines, 'out');
      const [row] = await tx
        .insert(stockTransfers)
        .values({
          tenantId: getTenantId(),
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          sentOn: input.date,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock transfer insert returned no row');
      await this.writeLines(tx, row.id, lines);
      await audit(tx, {
        action: 'stock_transfer.created',
        entityType: 'stock_transfer',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, lines.length)),
      });
      if (input.send) await this.sendAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateStockTransferInput): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await this.assertPlaces(tx, input);
      const lines = await resolveLines(tx, input.lines, 'out');
      const [updated] = await tx
        .update(stockTransfers)
        .set({
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          sentOn: input.date,
          note: input.note,
          version: sql`${stockTransfers.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)))
        .returning();
      if (!updated) throw notFound('Stock transfer');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'stock_transfer.updated',
        entityType: 'stock_transfer',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, linesBefore.length),
          await this.snapshot(tx, updated, lines.length),
        ),
      });
      if (input.send) await this.sendAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      await tx
        .delete(stockTransfers)
        .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)));
      await audit(tx, {
        action: 'stock_transfer.deleted',
        entityType: 'stock_transfer',
        entityId: id,
        changes: diff(await this.snapshot(tx, before, lines.length), {
          date: null,
          from: null,
          to: null,
          lines: null,
        }),
      });
    });
  }

  send(id: string, version: number): Promise<StockTransfer> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.sendAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // The second step, at the destination: what arrived is added there, on the day it arrived. A
  // line received short keeps the difference as its shortage — it left the source and never
  // reached the destination, and the transfer is where anyone can see that.
  receive(id: string, input: ReceiveTransferInput): Promise<StockTransfer> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      const [transfer] = await tx
        .select()
        .from(stockTransfers)
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)))
        .for('update');
      if (!transfer) throw notFound('Stock transfer');
      if (transfer.status !== 'in_transit') {
        throw new AppError(
          409,
          'transfer_not_in_transit',
          'Only a transfer on its way can be received.',
        );
      }
      if (transfer.version !== input.version) throw versionConflict();
      // It cannot arrive before it left
      if (input.date < transfer.sentOn) {
        throw new AppError(409, 'transfer_receive_date', 'It cannot arrive before it was sent.', {
          fieldErrors: { date: ['transfer_receive_date'] },
        });
      }
      await this.posting.assertDate(tx, input.date);

      const stored = await this.linesOf(tx, id);
      // Every line exactly once: a receipt that leaves a line out would leave it in transit for
      // ever, with no way to say what happened to it
      const byId = new Map(input.lines.map((line, index) => [line.lineId, { line, index }]));
      if (stored.length !== input.lines.length || stored.some((line) => !byId.has(line.id))) {
        throw new AppError(409, 'transfer_lines_mismatch', 'Receive every line of the transfer.', {
          fieldErrors: { lines: ['transfer_lines_mismatch'] },
        });
      }
      const variants = await loadVariants(
        tx,
        stored.map((line) => line.variantId),
        { lock: true },
      );
      const issues: LineIssue[] = [];
      const receipts = stored.map((line) => {
        const received = byId.get(line.id);
        if (!received) throw new Error('Line checked above');
        const { index } = received;
        const at = (field: string, code: ErrorCode) => {
          issues.push({ path: linePath(index, field), code });
        };
        const variant = variants.get(line.variantId);
        if (!variant) throw new Error(`Variant ${line.variantId} of a sent line is missing`);
        const quantity = received.line.receivedQuantity;
        if (compareQuantity(quantity, line.baseQuantity) > 0) {
          at('receivedQuantity', 'transfer_receive_too_many');
        } else if (!fitsDecimals(quantity, variant.baseDecimals)) {
          at('receivedQuantity', 'stock_quantity_decimals');
        }
        const serialNumbers = received.line.serialNumbers;
        if (variant.tracking === 'serial') {
          const sent = new Set(line.serialNumbers);
          received.line.serialNumbers.forEach((serial, serialIndex) => {
            if (!sent.has(serial))
              at(`serialNumbers.${String(serialIndex)}`, 'transfer_serial_not_sent');
          });
          if (wholeCount(quantity) !== serialNumbers.length || !fitsDecimals(quantity, 0)) {
            at('serialNumbers', 'stock_serial_count');
          }
        } else if (serialNumbers.length > 0) {
          at('serialNumbers', 'stock_serial_count');
        }
        return { line, index, variant, quantity, serialNumbers };
      });
      if (issues.length > 0) throw linesError(issues);

      for (const receipt of receipts) {
        await tx
          .update(stockTransferLines)
          .set({
            receivedQuantity: receipt.quantity,
            receivedSerialNumbers: receipt.serialNumbers,
          })
          .where(
            and(
              eq(stockTransferLines.tenantId, tenantId),
              eq(stockTransferLines.id, receipt.line.id),
            ),
          );
      }
      await this.posting.post(tx, {
        date: input.date,
        kind: 'transfer_in',
        direction: 'in',
        documentId: id,
        documentNumber: transfer.number ?? '',
        receivingTransferId: id,
        // Nothing arrived on a line: no movement for it, only its shortage
        moves: receipts.flatMap((receipt) =>
          isZeroQuantity(receipt.quantity)
            ? []
            : [
                {
                  line: receipt.index,
                  warehouseId: transfer.toWarehouseId,
                  variant: receipt.variant,
                  batchId: receipt.line.batchId,
                  quantity: receipt.quantity,
                  serialNumbers: receipt.serialNumbers,
                },
              ],
        ),
      });
      await tx
        .update(stockTransfers)
        .set({
          status: 'received',
          receivedOn: input.date,
          receivedAt: new Date(),
          receivedBy: currentPrincipal().userId,
          version: sql`${stockTransfers.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)));
      const isShort = receipts.some(
        (receipt) => compareQuantity(receipt.quantity, receipt.line.baseQuantity) < 0,
      );
      await audit(tx, {
        action: 'stock_transfer.received',
        entityType: 'stock_transfer',
        entityId: id,
        changes: created({ date: input.date, short: isShort }),
      });
      return this.read(tx, id);
    });
  }

  // The first step: the stock leaves the source, today's number is taken, and the transfer is in
  // transit. The lines are checked again with the products as they are now, like a journal post.
  private async sendAndLog(tx: Transaction, draft: TransferRow): Promise<void> {
    await this.posting.assertDate(tx, draft.sentOn);
    await this.assertPlaces(tx, {
      fromWarehouseId: draft.fromWarehouseId,
      toWarehouseId: draft.toWarehouseId,
    });
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), 'out', { lock: true });
    await this.writeLines(tx, draft.id, lines);
    const number = await this.numbering.next(tx, 'inventory.transfer', draft.sentOn);
    await this.posting.post(tx, {
      date: draft.sentOn,
      kind: 'transfer_out',
      direction: 'out',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.fromWarehouseId,
        variant: line.variant,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
      })),
    });
    await tx
      .update(stockTransfers)
      .set({
        status: 'in_transit',
        number,
        sentAt: new Date(),
        sentBy: currentPrincipal().userId,
        version: sql`${stockTransfers.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, draft.id)));
    await audit(tx, {
      action: 'stock_transfer.sent',
      entityType: 'stock_transfer',
      entityId: draft.id,
      changes: created({ number }),
    });
  }

  private assertPlaces(
    tx: Transaction,
    input: { fromWarehouseId: string; toWarehouseId: string },
  ): Promise<void> {
    return assertWarehousesActive(tx, [
      { field: 'fromWarehouseId', warehouseId: input.fromWarehouseId },
      { field: 'toWarehouseId', warehouseId: input.toWarehouseId },
    ]);
  }

  private async writeLines(
    tx: Transaction,
    transferId: string,
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(stockTransferLines)
      .where(
        and(
          eq(stockTransferLines.tenantId, tenantId),
          eq(stockTransferLines.transferId, transferId),
        ),
      );
    await tx.insert(stockTransferLines).values(
      lines.map((line, index) => ({
        tenantId,
        transferId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
      })),
    );
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<TransferRow> {
    const [row] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, getTenantId()), eq(stockTransfers.id, id)))
      .for('update');
    if (!row) throw notFound('Stock transfer');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, transferId: string) {
    return tx
      .select()
      .from(stockTransferLines)
      .where(
        and(
          eq(stockTransferLines.tenantId, getTenantId()),
          eq(stockTransferLines.transferId, transferId),
        ),
      )
      .orderBy(asc(stockTransferLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockTransferSummary[]> {
    const rows = await tx
      .select({ transfer: stockTransfers, lineCount, short })
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, getTenantId()), where))
      .orderBy(desc(stockTransfers.sentOn), desc(stockTransfers.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.transfer, row.lineCount, row.short));
  }

  private async read(tx: Transaction, id: string): Promise<StockTransfer> {
    const [summary] = await this.summaries(tx, eq(stockTransfers.id, id), 1);
    if (!summary) throw notFound('Stock transfer');
    const lines = await this.linesOf(tx, id);
    const [variants, batches] = await Promise.all([
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
    ]);
    return {
      ...summary,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            receivedQuantity: line.receivedQuantity,
            receivedSerialNumbers: line.receivedSerialNumbers,
          },
        ];
      }),
    };
  }

  private async snapshot(tx: Transaction, row: TransferRow, lines: number) {
    const places = await tx
      .select({ id: warehouses.id, code: warehouses.code })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.tenantId, getTenantId()),
          inArray(warehouses.id, [row.fromWarehouseId, row.toWarehouseId]),
        ),
      );
    const code = (id: string) => places.find((place) => place.id === id)?.code ?? null;
    return {
      date: row.sentOn,
      from: code(row.fromWarehouseId),
      to: code(row.toWarehouseId),
      lines,
    };
  }
}
