import { Injectable } from '@nestjs/common';
import {
  addMoney,
  compareMoney,
  compareQuantity,
  isZeroMoney,
  type MovementKind,
  multiplyMoney,
  negateMoney,
  negateQuantity,
  prorateMoney,
  splitMoney,
  subtractMoney,
  subtractQuantity,
  sumQuantity,
  todayIn,
  unitCostOf,
} from '@omnivo/contracts';
import {
  batches,
  reorderLevels,
  serials,
  stockBalances,
  stockMovements,
  stockTransferLines,
  stockTransfers,
  stockValues,
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
  // Step 14, for a move IN: what it is worth (a typed cost × quantity, or what a transfer sent).
  // null or left out = at the variant's average cost now. A move OUT goes at the average, unless
  // it names what it took in at (step 17d: a purchase return leaves at its goods receipt line's
  // cost); outflowAt() decides what it really takes.
  value?: string | null;
}

// A variant's stock and value as stock_values holds them, while a posting works through its moves
interface ValueState {
  quantity: string;
  value: string;
  unitCost: string | null;
}

// One line of a revaluation: the variant and its new average cost per base unit
export interface Revaluation {
  line: number;
  variant: Pick<VariantInfo, 'variantId' | 'productId'>;
  unitCost: string;
}

// What a revaluation did to one variant, and where (the difference per warehouse, for the books)
export interface Revalued {
  quantity: string;
  oldUnitCost: string | null;
  oldValue: string;
  newValue: string;
  difference: string;
  byWarehouse: { warehouseId: string; value: string }[];
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
  // Step 20a: a POS sale, which is never refused for stock (decision 7). planSale() already worked
  // out where its goods leave from and what is missing; what is missing goes below zero.
  belowZero?: boolean;
}

// Step 20a: one line of a POS sale that takes stock out, as planSale() gets it. batchId is the
// batch the device chose; serialNumbers what the scanner read.
export interface SaleDemand {
  line: number;
  variant: VariantInfo;
  baseQuantity: string;
  batchId: string | null;
  serialNumbers: string[];
}

// Where that line's goods leave from: the moves to post, the batches they take (for
// pos_sale_line_batches), and what the warehouse did not have
export interface SalePlan {
  moves: StockMove[];
  batches: { batchId: string; quantity: string }[];
  shortQuantity: string;
  shortSerials: string[];
}

// What can be taken of `wanted` from `left`: the smaller of the two, and nothing from stock at
// zero or below
function takeable(left: string, wanted: string): string {
  if (compareQuantity(left, '0') <= 0) return '0';
  return compareQuantity(left, wanted) < 0 ? left : wanted;
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

// What `quantity` taken out of `state` is worth, at the average cost (step 14). Taking all of it
// takes all of its value — so stock that reaches zero is worth exactly zero, with no paisa left
// behind by rounding. Taking part takes its share. Taking more than there is (negative stock,
// when the workspace allows it) takes what there was, and prices the rest at the last average.
function outflowValue(state: ValueState, quantity: string): string {
  const positive = compareQuantity(state.quantity, '0') > 0;
  if (positive && compareQuantity(quantity, state.quantity) === 0) return state.value;
  if (positive && compareQuantity(quantity, state.quantity) < 0) {
    return prorateMoney(state.value, quantity, state.quantity);
  }
  const beyond = positive ? subtractQuantity(quantity, state.quantity) : quantity;
  return addMoney(positive ? state.value : '0', multiplyMoney(beyond, state.unitCost ?? '0'));
}

// Step 17d: what a move out that names its value (`given`) takes out of `state`. The named value,
// so the moving average of what stays is worked out again (a purchase return at what the goods came
// in at), within two limits that keep the stock's value true: the last of the stock takes all of
// its value (zero stock is worth zero, as above), and no part takes more than the stock is worth
// (what stays is never worth less than nothing). With no stock to go by, the named value. The
// caller books any difference from `given` (StockBooksService.purchaseReturn).
function outflowAt(state: ValueState, quantity: string, given: string): string {
  const positive = compareQuantity(state.quantity, '0') > 0;
  if (!positive) return given;
  if (compareQuantity(quantity, state.quantity) >= 0) return outflowValue(state, quantity);
  return compareMoney(given, state.value) > 0 ? state.value : given;
}

// The new state after a move, like migration 0024's trigger: the average follows the stock while
// there is some, and keeps its last value at zero or below
function apply(state: ValueState, quantity: string, value: string): ValueState {
  const next = {
    quantity: sumQuantity([state.quantity, quantity]),
    value: addMoney(state.value, value),
  };
  return {
    ...next,
    unitCost:
      compareQuantity(next.quantity, '0') > 0
        ? unitCostOf(next.value, next.quantity)
        : (state.unitCost ?? null),
  };
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

  // Returns what each move was worth (step 14), in the order of posting.moves: positive amounts to
  // the paisa. The caller gives them to StockBooksService for the journal entry, and keeps them on
  // its lines.
  async post(tx: Transaction, posting: StockPosting): Promise<string[]> {
    if (posting.moves.length === 0) return [];
    const serialIds = await this.checkSerials(tx, posting);
    // The variants' value rows first, then the balance rows: every posting takes its locks in this
    // order, so a document bringing stock in and one taking it out never wait for each other in a
    // circle (a deadlock)
    const states = await this.lockValues(
      tx,
      posting.moves.map((move) => move.variant.variantId),
    );
    const before = posting.direction === 'out' ? await this.checkAvailable(tx, posting) : null;

    // The value of each move, in the document's order: two lines of the same variant (two batches
    // of one product) price one after the other, the second at what the first left
    const issues: LineIssue[] = [];
    const values = posting.moves.map((move) => {
      const state = states.get(move.variant.variantId) ?? {
        quantity: '0',
        value: '0',
        unitCost: null,
      };
      let value: string;
      if (posting.direction === 'out') {
        const given = move.value ?? null;
        value =
          given === null
            ? outflowValue(state, move.quantity)
            : outflowAt(state, move.quantity, given);
        states.set(
          move.variant.variantId,
          apply(state, negateQuantity(move.quantity), negateMoney(value)),
        );
      } else {
        const given = move.value ?? null;
        if (given === null && state.unitCost === null) {
          // Nothing to go by: the first stock of an item needs its cost
          issues.push({ path: linePath(move.line, 'unitCost'), code: 'stock_cost_required' });
        }
        value = given ?? multiplyMoney(move.quantity, state.unitCost ?? '0');
        states.set(move.variant.variantId, apply(state, move.quantity, value));
      }
      return value;
    });
    if (issues.length > 0) throw linesError(issues);

    const sign = (quantity: string) =>
      posting.direction === 'in' ? quantity : negateQuantity(quantity);
    const signed = (value: string) => (posting.direction === 'in' ? value : negateMoney(value));
    const rows = posting.moves.flatMap((move, index) => {
      const value = values[index] ?? '0';
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
        // The move's value cut into one piece per serial number, adding up to it exactly
        const pieces = splitMoney(value, move.serialNumbers.length);
        return move.serialNumbers.map((serial, piece) => ({
          ...base,
          serialId: serialIds.get(`${move.variant.variantId}|${serial}`) ?? null,
          quantity: sign('1'),
          value: signed(pieces[piece] ?? '0'),
        }));
      }
      return [{ ...base, serialId: null, quantity: sign(move.quantity), value: signed(value) }];
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
    return values;
  }

  // Step 20a: where the goods of a POS sale leave from, worked out before post() (decision 15).
  // The sale was paid and printed, so nothing here refuses it for stock:
  //   no tracking  the line leaves as it is; what the warehouse does not have goes below zero
  //   batch        the device's batch first, then the other batches here by FEFO (not expired on
  //                the day of the sale), and what is still missing below zero on the device's batch
  //   serial       a serial number in this warehouse leaves with it; one that is not here
  //                (unknown, sold already, in another warehouse) leaves as a piece without one
  // The rows are locked in post()'s order (serials, values, balances), so post() takes the same
  // locks again without waiting, and the stock cannot change between the plan and the posting.
  // Two lines of one variant count against the same stock, one after the other.
  // shortQuantity is what went below zero against the rules: an untracked product in a workspace
  // that allows negative stock is never short, because any document may take it there.
  async planSale(
    tx: Transaction,
    warehouseId: string,
    date: string,
    demands: readonly SaleDemand[],
  ): Promise<SalePlan[]> {
    const tenantId = getTenantId();
    if (demands.length === 0) return [];
    const variantIds = [...new Set(demands.map((demand) => demand.variant.variantId))];

    const numbers = [...new Set(demands.flatMap((demand) => demand.serialNumbers))];
    const here = new Set<string>();
    if (numbers.length > 0) {
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
      for (const row of rows) {
        if (row.warehouseId === warehouseId) here.add(`${row.variantId}|${row.serialNumber}`);
      }
    }

    await this.lockValues(tx, variantIds);
    // checkAvailable()'s order. The batch's expiry and lot come along for FEFO; only the balance
    // rows are locked (a batch row never changes its expiry).
    const balances = await tx
      .select({
        variantId: stockBalances.variantId,
        batchId: stockBalances.batchId,
        quantity: stockBalances.quantity,
        lotNumber: batches.lotNumber,
        expiresOn: batches.expiresOn,
      })
      .from(stockBalances)
      .leftJoin(
        batches,
        and(eq(batches.tenantId, stockBalances.tenantId), eq(batches.id, stockBalances.batchId)),
      )
      .where(
        and(
          eq(stockBalances.tenantId, tenantId),
          eq(stockBalances.warehouseId, warehouseId),
          inArray(stockBalances.variantId, variantIds),
        ),
      )
      .orderBy(
        asc(stockBalances.warehouseId),
        asc(stockBalances.variantId),
        sql`${stockBalances.batchId} NULLS FIRST`,
      )
      .for('update', { of: stockBalances });
    const left = new Map(
      balances.map((row) => [balanceKey(warehouseId, row.variantId, row.batchId), row.quantity]),
    );
    const [settings] = await tx
      .select({ allowNegativeStock: tenantSettings.allowNegativeStock })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));

    return demands.map((demand): SalePlan => {
      const { variant } = demand;
      const key = (batchId: string | null) => balanceKey(warehouseId, variant.variantId, batchId);
      const leftOf = (batchId: string | null) => left.get(key(batchId)) ?? '0';
      const take = (batchId: string | null, quantity: string) => {
        left.set(key(batchId), subtractQuantity(leftOf(batchId), quantity));
      };
      const move = (batchId: string | null, quantity: string, serialNumbers: string[] = []) => ({
        line: demand.line,
        warehouseId,
        variant,
        batchId,
        quantity,
        serialNumbers,
      });

      if (variant.tracking === 'batch') {
        const own = demand.batchId;
        // The caller refuses a batch line without a batch (stock_batch_required)
        if (own === null) throw new Error(`POS line ${String(demand.line)} has no batch`);
        const taken = new Map<string, string>();
        const add = (batchId: string, quantity: string) => {
          if (compareQuantity(quantity, '0') <= 0) return;
          taken.set(batchId, sumQuantity([taken.get(batchId) ?? '0', quantity]));
          take(batchId, quantity);
        };
        let wanted = demand.baseQuantity;
        const first = takeable(leftOf(own), wanted);
        add(own, first);
        wanted = subtractQuantity(wanted, first);
        // FEFO: the batch that expires first, no expiry last, then by lot; an expired batch is
        // not on the shelf, so the goods did not come from it
        const others = balances
          .filter(
            (row): row is typeof row & { batchId: string } =>
              row.variantId === variant.variantId &&
              row.batchId !== null &&
              row.batchId !== own &&
              (row.expiresOn === null || row.expiresOn >= date),
          )
          .sort(
            (a, b) =>
              (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') ||
              (a.lotNumber ?? '').toLowerCase().localeCompare((b.lotNumber ?? '').toLowerCase()) ||
              a.batchId.localeCompare(b.batchId),
          );
        for (const other of others) {
          if (compareQuantity(wanted, '0') <= 0) break;
          const part = takeable(leftOf(other.batchId), wanted);
          add(other.batchId, part);
          wanted = subtractQuantity(wanted, part);
        }
        // What no batch had goes below zero on the device's batch: the batch the cashier sold
        const short = wanted;
        add(own, short);
        const parts = [...taken].map(([batchId, quantity]) => ({ batchId, quantity }));
        return {
          moves: parts.map((part) => move(part.batchId, part.quantity)),
          batches: parts,
          shortQuantity: short,
          shortSerials: [],
        };
      }

      const available = leftOf(null);
      const short = subtractQuantity(demand.baseQuantity, takeable(available, demand.baseQuantity));
      take(null, demand.baseQuantity);

      if (variant.tracking === 'serial') {
        // A serial number is on one line at most (documentSerialRules)
        const found = demand.serialNumbers.filter((serial) =>
          here.has(`${variant.variantId}|${serial}`),
        );
        const missing = demand.serialNumbers.filter(
          (serial) => !here.has(`${variant.variantId}|${serial}`),
        );
        return {
          moves: [
            ...(found.length > 0 ? [move(null, String(found.length), found)] : []),
            ...(missing.length > 0 ? [move(null, String(missing.length))] : []),
          ],
          batches: [],
          shortQuantity: short,
          shortSerials: missing,
        };
      }

      const allowed = settings?.allowNegativeStock === true;
      return {
        moves: [move(null, demand.baseQuantity)],
        batches: [],
        shortQuantity: allowed ? '0' : short,
        shortSerials: [],
      };
    });
  }

  // A revaluation (step 14): each variant gets a new average cost, and its stock's value changes
  // by the difference — no piece moves. The difference is written as movements of quantity 0
  // (kind 'revaluation'), one per warehouse that holds the variant, split by the quantity there,
  // so the stock card shows it and the books can tag each part with its warehouse's branch. The
  // trigger adds them to stock_values like any movement. Only stock that is there can be revalued.
  async revalue(
    tx: Transaction,
    document: { date: string; documentId: string; documentNumber: string },
    lines: readonly Revaluation[],
  ): Promise<Revalued[]> {
    const tenantId = getTenantId();
    const states = await this.lockValues(
      tx,
      lines.map((line) => line.variant.variantId),
    );
    const issues: LineIssue[] = [];
    const results: Revalued[] = [];
    const rows: (typeof stockMovements.$inferInsert)[] = [];
    for (const line of lines) {
      const state = states.get(line.variant.variantId);
      if (!state || compareQuantity(state.quantity, '0') <= 0) {
        issues.push({ path: linePath(line.line, 'variantId'), code: 'revaluation_no_stock' });
        continue;
      }
      const newValue = multiplyMoney(state.quantity, line.unitCost);
      const difference = subtractMoney(newValue, state.value);
      // Where the stock is: the warehouses holding some of it. The value rows are locked, so no
      // other posting moves this variant until we commit.
      const places = await tx
        .select({
          warehouseId: stockBalances.warehouseId,
          quantity: sql<string>`sum(${stockBalances.quantity})`,
        })
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.tenantId, tenantId),
            eq(stockBalances.variantId, line.variant.variantId),
          ),
        )
        .groupBy(stockBalances.warehouseId)
        .having(sql`sum(${stockBalances.quantity}) > 0`)
        .orderBy(asc(stockBalances.warehouseId));
      const held = sumQuantity(places.map((place) => place.quantity));
      // Each warehouse its share; the last one what rounding left, so the parts add up exactly
      let left = difference;
      const byWarehouse = places.map((place, index) => {
        const value =
          index === places.length - 1 ? left : prorateMoney(difference, place.quantity, held);
        left = subtractMoney(left, value);
        return { warehouseId: place.warehouseId, value };
      });
      for (const part of byWarehouse) {
        if (isZeroMoney(part.value)) continue;
        rows.push({
          tenantId,
          date: document.date,
          warehouseId: part.warehouseId,
          productId: line.variant.productId,
          variantId: line.variant.variantId,
          batchId: null,
          serialId: null,
          quantity: '0',
          value: part.value,
          kind: 'revaluation',
          documentId: document.documentId,
          documentNumber: document.documentNumber,
          createdBy: actorId(),
        });
      }
      results.push({
        quantity: state.quantity,
        oldUnitCost: state.unitCost,
        oldValue: state.value,
        newValue,
        difference,
        byWarehouse: byWarehouse.filter((part) => !isZeroMoney(part.value)),
      });
    }
    if (issues.length > 0) throw linesError(issues);
    if (rows.length > 0) await tx.insert(stockMovements).values(rows);
    return results;
  }

  // The value rows of these variants, locked (FOR UPDATE) in variant order — the first lock every
  // posting takes (see post()). A variant that never moved has no row yet: its first movement makes
  // it (the trigger), and until then it has nothing to price.
  private async lockValues(
    tx: Transaction,
    variantIds: readonly string[],
  ): Promise<Map<string, ValueState>> {
    const ids = [...new Set(variantIds)];
    const rows = await tx
      .select({
        variantId: stockValues.variantId,
        quantity: stockValues.quantity,
        value: stockValues.value,
        unitCost: stockValues.unitCost,
      })
      .from(stockValues)
      .where(and(eq(stockValues.tenantId, getTenantId()), inArray(stockValues.variantId, ids)))
      .orderBy(asc(stockValues.variantId))
      .for('update');
    return new Map(
      rows.map((row) => [
        row.variantId,
        { quantity: row.quantity, value: row.value, unitCost: row.unitCost },
      ]),
    );
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
    // Step 20a: a POS sale's shortages were counted by planSale(); they go below zero
    for (const move of posting.belowZero === true ? [] : posting.moves) {
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
