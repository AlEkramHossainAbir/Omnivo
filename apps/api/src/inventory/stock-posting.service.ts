import { Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type MovementKind,
  negateQuantity,
  subtractQuantity,
  sumQuantity,
  todayIn,
} from '@omnivo/contracts';
import {
  batches,
  reorderLevels,
  serials,
  stockBalances,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  tenantSettings,
} from '@omnivo/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { isCheckViolation } from '../common/db/pg-errors.js';
import { emit } from '../common/outbox/outbox.js';
import { AppError } from '../common/http/app-error.js';
import { getTenantId, tenantStorage } from '../common/tenant/tenant-context.js';
import type { Transaction } from '../common/tenant/with-tenant.js';
import { assertPeriodOpen } from '../journal/period-lock.service.js';
import {
  type LineIssue,
  linePath,
  linesError,
  type ResolvedLine,
  type VariantInfo,
} from './stock-lines.js';

// One movement of a document, before it is written: from which line (for errors under the right
// field), where, what and how much — always positive, the posting's direction gives the sign.
export interface StockMove {
  line: number;
  warehouseId: string;
  variant: VariantInfo;
  batchId: string | null;
  quantity: string;
  serialNumbers: string[];
}

export interface StockPosting {
  date: string;
  kind: MovementKind;
  // 'in' adds to the warehouse, 'out' takes from it. A document posts one direction at a time: an
  // adjustment is in or out, a transfer sends (out) and later receives (in).
  direction: 'in' | 'out';
  documentId: string;
  documentNumber: string;
  moves: readonly StockMove[];
  // A transfer's receipt: its serial numbers are on that transfer's lines, in transit, not "in
  // stock somewhere else"
  receivingTransferId?: string;
}

// The trigger's refusals as the API's answers, without a field: the trigger does not know which
// line of the document a movement came from
function triggerError(error: unknown): unknown {
  if (isCheckViolation(error, 'stock_balances_not_negative')) {
    return new AppError(409, 'stock_insufficient', 'Not enough stock for this posting.');
  }
  if (isCheckViolation(error, 'serials_in_stock')) {
    return new AppError(409, 'stock_serial_in_stock', 'A serial number is already in stock.');
  }
  if (isCheckViolation(error, 'serials_not_here')) {
    return new AppError(409, 'stock_serial_not_here', 'A serial number is not in this warehouse.');
  }
  return error;
}

function actorId(): string | null {
  return tenantStorage.getStore()?.principal?.userId ?? null;
}

// warehouse|variant|batch — the key of a balance row ('' for no batch)
function balanceKey(warehouseId: string, variantId: string, batchId: string | null): string {
  return `${warehouseId}|${variantId}|${batchId ?? ''}`;
}

// The one way into the stock ledger. Adjustments and transfers use it now; purchases, sales and
// POS (steps 15–20) will build a StockPosting and call post() inside their own transaction, so the
// document and its movements commit together or not at all. Every rule of stock lives here once —
// and the database checks the last ones again (migration 0022's trigger).
@Injectable()
export class StockPostingService {
  // A document is dated in an open period (the accounting lock date: from step 14 every movement
  // also posts to the books) and not in the future: tomorrow's stock cannot leave today
  async assertDate(tx: Transaction, date: string, field = 'date'): Promise<void> {
    await assertPeriodOpen(tx, date);
    const [settings] = await tx
      .select({ timezone: tenantSettings.timezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, getTenantId()));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
    if (date > todayIn(settings.timezone)) {
      throw new AppError(
        409,
        'stock_date_future',
        'A stock document cannot be dated in the future.',
        {
          fieldErrors: { [field]: ['stock_date_future'] },
        },
      );
    }
  }

  // The batches of lines that bring a batch product in: an existing lot of the variant, or a new
  // one. Receiving more of NP24117 adds to the same batch, and takes its expiry: typed again, it
  // must be the same (a lot never has two expiry dates). A new lot of a product with expiry dates
  // needs its date. Returns each line's batch id (null if untracked).
  async resolveBatches(
    tx: Transaction,
    lines: readonly ResolvedLine[],
  ): Promise<(string | null)[]> {
    const tenantId = getTenantId();
    const issues: LineIssue[] = [];
    const ids: (string | null)[] = [];
    for (const [index, line] of lines.entries()) {
      const lotNumber = line.lotNumber;
      if (lotNumber === null) {
        ids.push(null);
        continue;
      }
      const find = async () => {
        const [found] = await tx
          .select({ id: batches.id, expiresOn: batches.expiresOn })
          .from(batches)
          .where(
            and(
              eq(batches.tenantId, tenantId),
              eq(batches.variantId, line.variant.variantId),
              sql`lower(${batches.lotNumber}) = lower(${lotNumber})`,
            ),
          );
        return found;
      };
      let batch = await find();
      if (!batch) {
        if (line.variant.hasExpiry && line.expiresOn === null) {
          issues.push({ path: linePath(index, 'expiresOn'), code: 'stock_expiry_required' });
          ids.push(null);
          continue;
        }
        // ON CONFLICT DO NOTHING: two documents bringing in the same new lot at once both get
        // here; the unique index (variant, lower(lot)) lets one through and the other reads it
        await tx
          .insert(batches)
          .values({
            tenantId,
            productId: line.variant.productId,
            variantId: line.variant.variantId,
            lotNumber,
            manufacturedOn: line.manufacturedOn,
            expiresOn: line.expiresOn,
            createdBy: actorId(),
          })
          .onConflictDoNothing();
        batch = await find();
        if (!batch) throw new Error('Batch upsert returned no row');
      }
      if (line.expiresOn !== null && batch.expiresOn !== line.expiresOn) {
        issues.push({ path: linePath(index, 'expiresOn'), code: 'stock_batch_expiry_mismatch' });
      }
      ids.push(batch.id);
    }
    if (issues.length > 0) throw linesError(issues);
    return ids;
  }

  async post(tx: Transaction, posting: StockPosting): Promise<void> {
    if (posting.moves.length === 0) return;
    const serialIds = await this.checkSerials(tx, posting);
    const before = posting.direction === 'out' ? await this.checkAvailable(tx, posting) : null;

    const sign = (quantity: string) =>
      posting.direction === 'in' ? quantity : negateQuantity(quantity);
    const rows = posting.moves.flatMap((move) => {
      const base = {
        tenantId: getTenantId(),
        date: posting.date,
        warehouseId: move.warehouseId,
        productId: move.variant.productId,
        variantId: move.variant.variantId,
        batchId: move.batchId,
        kind: posting.kind,
        documentId: posting.documentId,
        documentNumber: posting.documentNumber,
        createdBy: actorId(),
      };
      // A serial product moves one row per serial number: the stock card then shows where each
      // IMEI went, and the trigger moves each serial row on its own
      if (move.serialNumbers.length > 0) {
        return move.serialNumbers.map((serial) => ({
          ...base,
          serialId: serialIds.get(`${move.variant.variantId}|${serial}`) ?? null,
          quantity: sign('1'),
        }));
      }
      return [{ ...base, serialId: null, quantity: sign(move.quantity) }];
    });
    // In the order of their balance rows: every document locks those rows in the same order, so
    // two documents touching the same products wait for each other instead of deadlocking
    rows.sort((a, b) =>
      balanceKey(a.warehouseId, a.variantId, a.batchId).localeCompare(
        balanceKey(b.warehouseId, b.variantId, b.batchId),
      ),
    );
    try {
      await tx.insert(stockMovements).values(rows);
    } catch (error) {
      // The database's last word (migration 0022's trigger). The checks above make it unreachable
      // in practice; if it ever speaks, the person still gets the 409 it means, not a 500. The
      // transaction is aborted either way, and rolls back when this error leaves withTenant.
      throw triggerError(error);
    }

    if (before !== null) await this.reportLow(tx, posting, before);
  }

  // Serial numbers in: made the first time they are seen, and never already in stock (in a
  // warehouse, or on a truck). Out: each one is in this warehouse. Returns variant|serial → id.
  private async checkSerials(tx: Transaction, posting: StockPosting): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const wanted = posting.moves.filter((move) => move.serialNumbers.length > 0);
    if (wanted.length === 0) return new Map();

    if (posting.direction === 'in') {
      await tx
        .insert(serials)
        .values(
          wanted.flatMap((move) =>
            move.serialNumbers.map((serialNumber) => ({
              tenantId,
              productId: move.variant.productId,
              variantId: move.variant.variantId,
              serialNumber,
              createdBy: actorId(),
            })),
          ),
        )
        .onConflictDoNothing();
    }
    const variantIds = [...new Set(wanted.map((move) => move.variant.variantId))];
    const numbers = [...new Set(wanted.flatMap((move) => move.serialNumbers))];
    // FOR UPDATE: the trigger moves these rows; until we commit, no other document moves them
    const rows = await tx
      .select({
        id: serials.id,
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
    const found = new Map(rows.map((row) => [`${row.variantId}|${row.serialNumber}`, row]));

    // On their way in another transfer: not in a warehouse, but not free to come in either
    const inTransit = new Set<string>();
    if (posting.direction === 'in') {
      const sent = await tx
        .select({
          transferId: stockTransferLines.transferId,
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
      for (const line of sent) {
        if (line.transferId === posting.receivingTransferId) continue;
        for (const serial of line.serialNumbers) inTransit.add(`${line.variantId}|${serial}`);
      }
    }

    const issues: LineIssue[] = [];
    for (const move of wanted) {
      const bad = move.serialNumbers.some((serial) => {
        const key = `${move.variant.variantId}|${serial}`;
        const row = found.get(key);
        // No row (cannot happen after the insert above) reads as "somewhere else": refused
        return posting.direction === 'in'
          ? row?.warehouseId !== null || inTransit.has(key)
          : row?.warehouseId !== move.warehouseId;
      });
      if (bad) {
        issues.push({
          path: linePath(move.line, 'serialNumbers'),
          code: posting.direction === 'in' ? 'stock_serial_in_stock' : 'stock_serial_not_here',
        });
      }
    }
    if (issues.length > 0) throw linesError(issues);
    return new Map(rows.map((row) => [`${row.variantId}|${row.serialNumber}`, row.id]));
  }

  // Enough stock for every line that takes some out. The balance rows are locked first (FOR
  // UPDATE, in key order): a second document taking the same stock waits here and then sees what
  // the first one left. Two lines taking the same batch count together. Returns each place's stock
  // before this document, per warehouse and variant, for the reorder check.
  private async checkAvailable(
    tx: Transaction,
    posting: StockPosting,
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    const pairs = [
      ...new Map(
        posting.moves.map((move) => [
          `${move.warehouseId}|${move.variant.variantId}`,
          sql`(${move.warehouseId}::uuid, ${move.variant.variantId}::uuid)`,
        ]),
      ).values(),
    ];
    const balances = await tx
      .select({
        warehouseId: stockBalances.warehouseId,
        variantId: stockBalances.variantId,
        batchId: stockBalances.batchId,
        quantity: stockBalances.quantity,
      })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.tenantId, tenantId),
          sql`(${stockBalances.warehouseId}, ${stockBalances.variantId}) IN (${sql.join(pairs, sql`, `)})`,
        ),
      )
      .orderBy(
        asc(stockBalances.warehouseId),
        asc(stockBalances.variantId),
        sql`${stockBalances.batchId} NULLS FIRST`,
      )
      .for('update');
    const available = new Map(
      balances.map((row) => [
        balanceKey(row.warehouseId, row.variantId, row.batchId),
        row.quantity,
      ]),
    );

    const demand = new Map<string, string[]>();
    for (const move of posting.moves) {
      const key = balanceKey(move.warehouseId, move.variant.variantId, move.batchId);
      demand.set(key, [...(demand.get(key) ?? []), move.quantity]);
    }

    const [settings] = await tx
      .select({ allowNegativeStock: tenantSettings.allowNegativeStock })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const issues: LineIssue[] = [];
    for (const move of posting.moves) {
      // Below zero is allowed only when the workspace says so, and never for a batch or an IMEI
      if (move.variant.tracking === 'none' && settings?.allowNegativeStock === true) continue;
      const key = balanceKey(move.warehouseId, move.variant.variantId, move.batchId);
      const wanted = sumQuantity(demand.get(key) ?? []);
      if (compareQuantity(available.get(key) ?? '0', wanted) < 0) {
        issues.push({ path: linePath(move.line, 'quantity'), code: 'stock_insufficient' });
      }
    }
    if (issues.length > 0) throw linesError(issues);

    const totals = new Map<string, string[]>();
    for (const row of balances) {
      const key = `${row.warehouseId}|${row.variantId}`;
      totals.set(key, [...(totals.get(key) ?? []), row.quantity]);
    }
    return new Map([...totals].map(([key, values]) => [key, sumQuantity(values)]));
  }

  // The places this document took down to (or below) their reorder level: one outbox event per
  // warehouse, and the worker tells the people who manage products (LowStockHandler). Only a
  // crossing counts — stock that was already low does not ring again with every sale.
  private async reportLow(
    tx: Transaction,
    posting: StockPosting,
    before: Map<string, string>,
  ): Promise<void> {
    const taken = new Map<
      string,
      { warehouseId: string; variantId: string; quantities: string[] }
    >();
    for (const move of posting.moves) {
      const key = `${move.warehouseId}|${move.variant.variantId}`;
      const entry = taken.get(key) ?? {
        warehouseId: move.warehouseId,
        variantId: move.variant.variantId,
        quantities: [],
      };
      entry.quantities.push(move.quantity);
      taken.set(key, entry);
    }
    const pairs = [...taken.values()].map(
      (entry) => sql`(${entry.warehouseId}::uuid, ${entry.variantId}::uuid)`,
    );
    const levels = await tx
      .select({
        warehouseId: reorderLevels.warehouseId,
        variantId: reorderLevels.variantId,
        minQuantity: reorderLevels.minQuantity,
      })
      .from(reorderLevels)
      .where(
        and(
          eq(reorderLevels.tenantId, getTenantId()),
          sql`(${reorderLevels.warehouseId}, ${reorderLevels.variantId}) IN (${sql.join(pairs, sql`, `)})`,
        ),
      );
    const crossed = new Map<string, string[]>();
    for (const level of levels) {
      const key = `${level.warehouseId}|${level.variantId}`;
      const was = before.get(key) ?? '0';
      const now = subtractQuantity(was, sumQuantity(taken.get(key)?.quantities ?? []));
      if (
        compareQuantity(was, level.minQuantity) > 0 &&
        compareQuantity(now, level.minQuantity) <= 0
      ) {
        crossed.set(level.warehouseId, [
          ...(crossed.get(level.warehouseId) ?? []),
          level.variantId,
        ]);
      }
    }
    for (const [warehouseId, variantIds] of crossed) {
      await emit(tx, 'stock.below_reorder', { warehouseId, variantIds });
    }
  }
}
