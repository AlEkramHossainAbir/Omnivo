import { Inject, Injectable } from '@nestjs/common';
import {
  multiplyMoney,
  type StockAdjustment,
  type StockAdjustmentInput,
  type StockAdjustmentSummary,
  type StockDocumentStatus,
  sumMoney,
  type UpdateStockAdjustmentInput,
} from '@omnivo/contracts';
import { stockAdjustmentLines, stockAdjustments, warehouses } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
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
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from './stock-lines.js';
import { StockBooksService } from './stock-books.service.js';
import { StockPostingService } from './stock-posting.service.js';
import { ValueAccess } from './value-access.js';

type AdjustmentRow = typeof stockAdjustments.$inferSelect;
type LineRow = typeof stockAdjustmentLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockAdjustments.id}
// as a bare "id", which inside this subquery would mean the line's own id
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_adjustment_lines l
   WHERE l.tenant_id = stock_adjustments.tenant_id AND l.adjustment_id = stock_adjustments.id
)`;

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. Post another adjustment to correct a posted one.',
  );
}

function toSummary(row: AdjustmentRow, lines: number): StockAdjustmentSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    warehouseId: row.warehouseId,
    direction: row.direction,
    reason: row.reason,
    note: row.note,
    status: row.status,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What posting adds to the lines besides what resolveLines() checked: the batches the lots became,
// the typed costs (step 14) and the values the posting worked out
interface LineExtras {
  batchIds?: readonly (string | null)[];
  unitCosts: readonly (string | null)[];
  values?: readonly string[];
}

// A typed cost belongs on a line that brings stock in; on an "out" line it means nothing (what
// leaves goes at the average cost), so it is not kept
function costsOf(
  direction: 'in' | 'out',
  lines: readonly { unitCost?: string | null }[],
): (string | null)[] {
  return lines.map((line) => (direction === 'in' ? (line.unitCost ?? null) : null));
}

// A stored line as resolveLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
  };
}

@Injectable()
export class StockAdjustmentsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
    private readonly access: ValueAccess,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: StockAdjustmentSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        and(
          query.status === undefined ? undefined : eq(stockAdjustments.status, query.status),
          query.warehouseId === undefined
            ? undefined
            : eq(stockAdjustments.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${stockAdjustments.date}, ${stockAdjustments.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<StockAdjustment> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockAdjustmentInput): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveLines(tx, input.lines, input.direction);
      const [row] = await tx
        .insert(stockAdjustments)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          warehouseId: input.warehouseId,
          direction: input.direction,
          reason: input.reason,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock adjustment insert returned no row');
      await this.writeLines(tx, row.id, lines, {
        unitCosts: costsOf(input.direction, input.lines),
      });
      await audit(tx, {
        action: 'stock_adjustment.created',
        entityType: 'stock_adjustment',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateStockAdjustmentInput): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveLines(tx, input.lines, input.direction);
      const [updated] = await tx
        .update(stockAdjustments)
        .set({
          date: input.date,
          warehouseId: input.warehouseId,
          direction: input.direction,
          reason: input.reason,
          note: input.note,
          version: sql`${stockAdjustments.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)))
        .returning();
      if (!updated) throw notFound('Stock adjustment');
      await this.writeLines(tx, id, lines, { unitCosts: costsOf(input.direction, input.lines) });
      await audit(tx, {
        action: 'stock_adjustment.updated',
        entityType: 'stock_adjustment',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, linesBefore.length),
          await this.snapshot(tx, updated, lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(stockAdjustments)
        .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)));
      await audit(tx, {
        action: 'stock_adjustment.deleted',
        entityType: 'stock_adjustment',
        entityId: id,
        changes: diff(await this.snapshot(tx, before, lines.length), {
          date: null,
          warehouse: null,
          direction: null,
          reason: null,
          lines: null,
        }),
      });
    });
  }

  post(id: string, version: number): Promise<StockAdjustment> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // A draft into the stock ledger: the date and the warehouse checked, every line checked again
  // against its product as it is now (a pack may have been resized since the draft was saved), the
  // lots turned into batches, the number taken, and the movements written — all in the caller's
  // transaction, so a refused line leaves nothing posted and no number used.
  private async postAndLog(tx: Transaction, draft: AdjustmentRow): Promise<void> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), draft.direction, { lock: true });
    const batchIds =
      draft.direction === 'in'
        ? await this.posting.resolveBatches(tx, lines)
        : lines.map((line) => line.batchId);
    // Step 14: an "in" line with a typed cost is worth quantity × cost (3 cartons × ৳1,200, in the
    // line's own unit); without one (null), the posting prices it at the average cost
    const unitCosts = costsOf(draft.direction, stored);
    const typedValues = lines.map((line, index) => {
      const cost = unitCosts[index] ?? null;
      return cost === null ? null : multiplyMoney(line.quantity, cost);
    });

    const number = await this.numbering.next(tx, 'inventory.adjustment', draft.date);
    const values = await this.posting.post(tx, {
      date: draft.date,
      kind: 'adjustment',
      direction: draft.direction,
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        variant: line.variant,
        batchId: batchIds[index] ?? null,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
        value: typedValues[index] ?? null,
      })),
    });
    // Still a draft here: the lines may change, and take their batches and values
    await this.writeLines(tx, draft.id, lines, { batchIds, unitCosts, values });
    await tx
      .update(stockAdjustments)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${stockAdjustments.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, draft.id)));
    // The books (step 14): one entry, the inventory account against the reason's account
    const entry = await this.books.adjustment(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        direction: draft.direction,
        reason: draft.reason,
        moved: [{ warehouseId: draft.warehouseId, value: sumMoney(values) }],
      },
    );
    await audit(tx, {
      action: 'stock_adjustment.posted',
      entityType: 'stock_adjustment',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The lines in the order they were written. batchIds: set when posting brings lots in; values:
  // set when posting has priced them.
  private async writeLines(
    tx: Transaction,
    adjustmentId: string,
    lines: readonly ResolvedLine[],
    { batchIds = lines.map((line) => line.batchId), unitCosts, values }: LineExtras,
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(stockAdjustmentLines)
      .where(
        and(
          eq(stockAdjustmentLines.tenantId, tenantId),
          eq(stockAdjustmentLines.adjustmentId, adjustmentId),
        ),
      );
    await tx.insert(stockAdjustmentLines).values(
      lines.map((line, index) => ({
        tenantId,
        adjustmentId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: batchIds[index] ?? null,
        lotNumber: line.lotNumber,
        expiresOn: line.expiresOn,
        manufacturedOn: line.manufacturedOn,
        serialNumbers: line.serialNumbers,
        unitCost: unitCosts[index] ?? null,
        value: values?.[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<AdjustmentRow> {
    const [row] = await tx
      .select()
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), eq(stockAdjustments.id, id)))
      .for('update');
    if (!row) throw notFound('Stock adjustment');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, adjustmentId: string) {
    return tx
      .select()
      .from(stockAdjustmentLines)
      .where(
        and(
          eq(stockAdjustmentLines.tenantId, getTenantId()),
          eq(stockAdjustmentLines.adjustmentId, adjustmentId),
        ),
      )
      .orderBy(asc(stockAdjustmentLines.lineNo));
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockAdjustmentSummary[]> {
    const rows = await tx
      .select({ adjustment: stockAdjustments, lineCount })
      .from(stockAdjustments)
      .where(and(eq(stockAdjustments.tenantId, getTenantId()), where))
      .orderBy(desc(stockAdjustments.date), desc(stockAdjustments.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.adjustment, row.lineCount));
  }

  private async read(tx: Transaction, id: string): Promise<StockAdjustment> {
    const [summary] = await this.summaries(tx, eq(stockAdjustments.id, id), 1);
    if (!summary) throw notFound('Stock adjustment');
    const lines = await this.linesOf(tx, id);
    const [canSee, entries] = await Promise.all([
      this.access.canSee(),
      this.books.entriesOf(tx, id),
    ]);
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
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            ...toStockLine(
              line,
              variant,
              line.batchId === null ? undefined : batches.get(line.batchId),
            ),
            // Typed by a person: part of the document. Worked out from the books: needs the
            // permission (step 14).
            unitCost: line.unitCost,
            value: canSee ? line.value : null,
          },
        ];
      }),
      entry: entries[0] ?? null,
    };
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: AdjustmentRow, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      warehouse: warehouse?.code ?? null,
      direction: row.direction,
      reason: row.reason,
      lines,
    };
  }
}
