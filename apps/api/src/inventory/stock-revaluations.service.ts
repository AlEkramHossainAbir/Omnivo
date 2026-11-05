import { Inject, Injectable } from '@nestjs/common';
import {
  type StockRevaluation,
  type StockRevaluationInput,
  type StockRevaluationSummary,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import { stockRevaluationLines, stockRevaluations } from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created } from '../common/audit/audit.js';
import { notFound } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { type LineIssue, linePath, linesError, loadVariants } from './stock-lines.js';
import { StockBooksService } from './stock-books.service.js';
import { StockPostingService } from './stock-posting.service.js';

type RevaluationRow = typeof stockRevaluations.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// The outer table by its name: in a select from one table, Drizzle prints ${stockRevaluations.id}
// as a bare "id", which inside these subqueries would mean the line's own id (step 13's lesson)
const lineCount = sql<number>`(
  SELECT count(*)::int FROM stock_revaluation_lines l
   WHERE l.tenant_id = stock_revaluations.tenant_id AND l.revaluation_id = stock_revaluations.id
)`;
const difference = sql<string>`(
  SELECT round(coalesce(sum(l.new_value - l.old_value), 0), 4)::text FROM stock_revaluation_lines l
   WHERE l.tenant_id = stock_revaluations.tenant_id AND l.revaluation_id = stock_revaluations.id
)`;

function toSummary(row: RevaluationRow, lines: number, total: string): StockRevaluationSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    note: row.note,
    lineCount: lines,
    difference: total,
    postedAt: row.postedAt.toISOString(),
  };
}

// Revaluing stock (step 14): new average costs, posted at once. A revaluation is written whole
// in one transaction — its header, its movements (StockPostingService.revalue()), its lines and its
// journal entry — and never changes afterwards (migration 0024).
@Injectable()
export class StockRevaluationsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: StockRevaluationSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.summaries(
        tx,
        after === undefined
          ? undefined
          : sql`(${stockRevaluations.date}, ${stockRevaluations.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        query.limit + 1,
      );
      return toPage(rows, query.limit, (last) => [last.date, last.id]);
    });
  }

  get(id: string): Promise<StockRevaluation> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: StockRevaluationInput): Promise<StockRevaluation> {
    const tenantId = getTenantId();
    return this.withTenant(async (tx) => {
      // An open period, and not tomorrow: the same rule as every stock document
      await this.posting.assertDate(tx, input.date);
      // FOR SHARE on the products: nobody turns one into a service under us
      const variants = await loadVariants(
        tx,
        input.lines.map((line) => line.variantId),
        { lock: true },
      );
      const issues: LineIssue[] = [];
      input.lines.forEach((line, index) => {
        // The same answer for "no such variant", "another workspace's" and "a service"
        if (variants.get(line.variantId)?.type !== 'goods') {
          issues.push({ path: linePath(index, 'variantId'), code: 'stock_variant_invalid' });
        }
      });
      if (issues.length > 0) throw linesError(issues);

      const number = await this.numbering.next(tx, 'inventory.revaluation', input.date);
      const [row] = await tx
        .insert(stockRevaluations)
        .values({
          tenantId,
          number,
          date: input.date,
          note: input.note,
          postedBy: currentPrincipal().userId,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Stock revaluation insert returned no row');

      const results = await this.posting.revalue(
        tx,
        { date: input.date, documentId: row.id, documentNumber: number },
        input.lines.map((line, index) => {
          const variant = variants.get(line.variantId);
          if (!variant) throw new Error('Variant checked above');
          return { line: index, variant, unitCost: line.unitCost };
        }),
      );
      await tx.insert(stockRevaluationLines).values(
        input.lines.map((line, index) => {
          const variant = variants.get(line.variantId);
          const result = results[index];
          if (!variant || !result) throw new Error('Line checked above');
          return {
            tenantId,
            revaluationId: row.id,
            lineNo: index + 1,
            productId: variant.productId,
            variantId: variant.variantId,
            quantity: result.quantity,
            oldUnitCost: result.oldUnitCost,
            oldValue: result.oldValue,
            unitCost: line.unitCost,
            newValue: result.newValue,
          };
        }),
      );
      const entry = await this.books.revaluation(
        tx,
        { id: row.id, number, date: input.date },
        results.flatMap((result) => result.byWarehouse),
      );
      await audit(tx, {
        action: 'stock_revaluation.posted',
        entityType: 'stock_revaluation',
        entityId: row.id,
        changes: created({
          number,
          lines: input.lines.length,
          difference: sumMoney(results.map((result) => result.difference)),
          entry: entry?.number ?? null,
        }),
      });
      return this.read(tx, row.id);
    });
  }

  private async summaries(
    tx: Transaction,
    where: SQL | undefined,
    limit: number,
  ): Promise<StockRevaluationSummary[]> {
    const rows = await tx
      .select({ revaluation: stockRevaluations, lineCount, difference })
      .from(stockRevaluations)
      .where(and(eq(stockRevaluations.tenantId, getTenantId()), where))
      .orderBy(desc(stockRevaluations.date), desc(stockRevaluations.id))
      .limit(limit);
    return rows.map((row) => toSummary(row.revaluation, row.lineCount, row.difference));
  }

  private async read(tx: Transaction, id: string): Promise<StockRevaluation> {
    const [summary] = await this.summaries(tx, eq(stockRevaluations.id, id), 1);
    if (!summary) throw notFound('Stock revaluation');
    const lines = await tx
      .select()
      .from(stockRevaluationLines)
      .where(
        and(
          eq(stockRevaluationLines.tenantId, getTenantId()),
          eq(stockRevaluationLines.revaluationId, id),
        ),
      )
      .orderBy(asc(stockRevaluationLines.lineNo));
    const variants = await loadVariants(
      tx,
      lines.map((line) => line.variantId),
    );
    const [entry] = await this.books.entriesOf(tx, id);
    return {
      ...summary,
      lines: lines.flatMap((line) => {
        const variant = variants.get(line.variantId);
        // The FK keeps the variant while a line points at it
        if (!variant) return [];
        return [
          {
            id: line.id,
            variantId: variant.variantId,
            productId: variant.productId,
            productCode: variant.productCode,
            productName: variant.productName,
            optionValues: variant.optionValues,
            sku: variant.sku,
            baseUnitId: variant.baseUnitId,
            quantity: line.quantity,
            oldUnitCost: line.oldUnitCost,
            oldValue: line.oldValue,
            unitCost: line.unitCost,
            newValue: line.newValue,
            difference: subtractMoney(line.newValue, line.oldValue),
          },
        ];
      }),
      entry: entry ?? null,
    };
  }
}
