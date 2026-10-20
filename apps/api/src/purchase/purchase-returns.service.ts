import { Inject, Injectable } from '@nestjs/common';
import {
  compareMoney,
  compareQuantity,
  keptQuantity,
  type PartyRef,
  prorateMoney,
  type PurchaseReturn,
  type PurchaseReturnInput,
  type PurchaseReturnSummary,
  type StockDocumentStatus,
  subtractMoney,
  sumQuantity,
  type UpdatePurchaseReturnInput,
} from '@omnivo/contracts';
import {
  billLines,
  bills,
  debitNoteLines,
  debitNotes,
  goodsReceiptLines,
  goodsReceipts,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  stockValues,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import {
  assertWarehousesActive,
  batchesOf,
  type LineIssue,
  linePath,
  linesError,
  loadVariants,
  type ResolvedLine,
  resolveLines,
  toStockLine,
} from '../inventory/stock-lines.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { customerRefs } from '../sales/sales-lines.js';
import { PurchaseBooksService } from './purchase-books.service.js';
import { assertSupplier } from './purchase-lines.js';

type ReturnRow = typeof purchaseReturns.$inferSelect;
type LineRow = typeof purchaseReturnLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM purchase_return_lines l
   WHERE l.tenant_id = purchase_returns.tenant_id AND l.return_id = purchase_returns.id
)`;

// What a line names, as the form sends it and as the database keeps it
interface LineRefs {
  receiptLineId: string | null;
  variantId: string;
  unitId: string;
  quantity: string;
  batchId: string | null;
  serialNumbers: readonly string[];
}

// A goods receipt line a return line sends back from, with what its receipt says about it
interface ReceiptLine {
  id: string;
  supplierId: string;
  status: StockDocumentStatus;
  // The warehouse the goods came into: its branch booked goods received not billed (17b), so the
  // return puts their cost back there
  warehouseId: string;
  variantId: string;
  baseQuantity: string;
  returnedQuantity: string;
  batchId: string | null;
  serialNumbers: string[];
  value: string | null;
  billed: boolean;
  orderLineId: string | null;
}

// The lines once checked: resolved like a stock document's (the batch of a receipt line is the
// receipt line's), with the receipt lines they name
interface Checked {
  lines: ResolvedLine[];
  receipts: Map<string, ReceiptLine>;
}

// The bill line that billed a receipt line, and its bill
interface Billing {
  billId: string;
  billLineId: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. A posted return is final: goods that come again come on a goods receipt.',
  );
}

function toSummary(row: ReturnRow, supplier: PartyRef, lines: number): PurchaseReturnSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
    warehouseId: row.warehouseId,
    reason: row.reason,
    status: row.status,
    note: row.note,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What `quantity` going back from a receipt line puts back on goods received not billed: its share
// of what the receipt line came in at (decision 2). Counted over everything sent back from the line
// so far, so a line that goes back in three goes gives back exactly its value, with no paisa left
// over by rounding.
function returnValue(receipt: ReceiptLine, quantity: string): string {
  if (receipt.value === null) throw new Error(`Posted receipt line ${receipt.id} has no value`);
  const after = sumQuantity([receipt.returnedQuantity, quantity]);
  return subtractMoney(
    prorateMoney(receipt.value, after, receipt.baseQuantity),
    prorateMoney(receipt.value, receipt.returnedQuantity, receipt.baseQuantity),
  );
}

// The database's last word on a receipt line (goods_receipt_lines_returned_check: never more back
// than was accepted), and on a bill and a return of the same goods posted at the same moment
// (purchase_returns_receipts_check, decision 28). The locks in postAndLog() make both unreachable in
// practice; each still answers with the code the form knows.
function returnRace(error: unknown): unknown {
  if (isCheckViolation(error, 'goods_receipt_lines_returned_check')) {
    return new AppError(
      409,
      'purchase_return_over_received',
      'Another return sent some of these goods back first. Reload and try again.',
    );
  }
  if (isCheckViolation(error, 'purchase_returns_receipts_check')) {
    return new AppError(
      409,
      'purchase_return_receipt_line_invalid',
      'A bill billed some of these goods while the return was posted. Reload and try again.',
    );
  }
  return error;
}

// Purchase returns (step 17d): goods sent back to a supplier, out of the warehouse the return names.
// A draft is changed freely; "Post" numbers it, takes the stock out at the cost it came in at, puts
// that cost back on goods received not billed, and counts it on the receipt lines it names (and,
// before a bill billed them, on the order's lines). It moves no money: a debit note does that.
@Injectable()
export class PurchaseReturnsService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly posting: StockPostingService,
    private readonly books: StockBooksService,
    private readonly purchaseBooks: PurchaseBooksService,
    private readonly access: ValueAccess,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: StockDocumentStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
  }): Promise<{ items: PurchaseReturnSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(purchaseReturns.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(purchaseReturns.supplierId, query.supplierId),
          query.warehouseId === undefined
            ? undefined
            : eq(purchaseReturns.warehouseId, query.warehouseId),
          after === undefined
            ? undefined
            : sql`(${purchaseReturns.date}, ${purchaseReturns.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [
        last.purchaseReturn.date,
        last.purchaseReturn.id,
      ]);
      return {
        items: page.items.map((row) => toSummary(row.purchaseReturn, row.supplier, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<PurchaseReturn> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  async create(input: PurchaseReturnInput): Promise<PurchaseReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const supplier = await assertSupplier(tx, input.supplierId);
        await assertWarehousesActive(tx, [
          { field: 'warehouseId', warehouseId: input.warehouseId },
        ]);
        const checked = await this.checkLines(tx, supplier.id, input.lines, false);
        const [row] = await tx
          .insert(purchaseReturns)
          .values({
            tenantId: getTenantId(),
            date: input.date,
            supplierId: supplier.id,
            warehouseId: input.warehouseId,
            reason: input.reason,
            note: input.note,
            createdBy: currentPrincipal().userId,
            updatedBy: currentPrincipal().userId,
          })
          .returning();
        if (!row) throw new Error('Purchase return insert returned no row');
        await this.writeLines(tx, row.id, input.lines, checked.lines);
        await audit(tx, {
          action: 'purchase_return.created',
          entityType: 'purchase_return',
          entityId: row.id,
          changes: created(await this.snapshot(tx, row, supplier, checked.lines.length)),
        });
        if (input.post) await this.postAndLog(tx, row);
        return this.read(tx, row.id);
      });
    } catch (error) {
      throw returnRace(error);
    }
  }

  async update(id: string, input: UpdatePurchaseReturnInput): Promise<PurchaseReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, input.version);
        const linesBefore = await this.linesOf(tx, id);
        const supplierBefore = await this.supplierOf(tx, before.supplierId);
        const supplier = await assertSupplier(tx, input.supplierId, before.supplierId);
        await assertWarehousesActive(tx, [
          { field: 'warehouseId', warehouseId: input.warehouseId },
        ]);
        const checked = await this.checkLines(tx, supplier.id, input.lines, false);
        const [updated] = await tx
          .update(purchaseReturns)
          .set({
            date: input.date,
            supplierId: supplier.id,
            warehouseId: input.warehouseId,
            reason: input.reason,
            note: input.note,
            version: sql`${purchaseReturns.version} + 1`,
            updatedBy: currentPrincipal().userId,
          })
          .where(and(eq(purchaseReturns.tenantId, getTenantId()), eq(purchaseReturns.id, id)))
          .returning();
        if (!updated) throw notFound('Purchase return');
        await this.writeLines(tx, id, input.lines, checked.lines);
        await audit(tx, {
          action: 'purchase_return.updated',
          entityType: 'purchase_return',
          entityId: id,
          changes: diff(
            await this.snapshot(tx, before, supplierBefore, linesBefore.length),
            await this.snapshot(tx, updated, supplier, checked.lines.length),
          ),
        });
        if (input.post) await this.postAndLog(tx, updated);
        return this.read(tx, id);
      });
    } catch (error) {
      throw returnRace(error);
    }
  }

  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const supplier = await this.supplierOf(tx, before.supplierId);
      // The lines go with it (ON DELETE CASCADE). A draft sent nothing back: nothing to undo.
      await tx
        .delete(purchaseReturns)
        .where(and(eq(purchaseReturns.tenantId, getTenantId()), eq(purchaseReturns.id, id)));
      const snapshot = await this.snapshot(tx, before, supplier, lines.length);
      await audit(tx, {
        action: 'purchase_return.deleted',
        entityType: 'purchase_return',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  async post(id: string, version: number): Promise<PurchaseReturn> {
    try {
      return await this.withTenant(async (tx) => {
        const draft = await this.lockDraft(tx, id, version);
        await this.postAndLog(tx, draft);
        return this.read(tx, id);
      });
    } catch (error) {
      throw returnRace(error);
    }
  }

  // Every rule of a line the contract cannot check. A line from a receipt line: a line of a posted
  // goods receipt of this supplier, of the same item (in any of its units), with its batch, no more
  // than it kept (accepted less what went back already; what was turned back at the gate never came
  // in, decision 16), and only serial numbers that came in on it (decision 15). A line on its own:
  // an item of this workspace with an existing batch, like a stock line that goes out
  // (resolveLines in 'out' mode: an archived item can still go back), and an average cost to leave
  // at. All problems at once, under each line. lock: true when posting (the receipt lines are
  // locked, see receiptLines()).
  private async checkLines(
    tx: Transaction,
    supplierId: string,
    lines: readonly LineRefs[],
    lock: boolean,
  ): Promise<Checked> {
    const receipts = await this.receiptLines(
      tx,
      lines.flatMap((line) => (line.receiptLineId === null ? [] : [line.receiptLineId])),
      lock,
    );
    const receiptOf = (line: LineRefs) =>
      line.receiptLineId === null ? undefined : receipts.get(line.receiptLineId);

    const issues: LineIssue[] = [];
    lines.forEach((line, index) => {
      if (line.receiptLineId === null) return;
      const receipt = receiptOf(line);
      if (
        receipt?.supplierId !== supplierId ||
        receipt.status !== 'posted' ||
        receipt.variantId !== line.variantId
      ) {
        issues.push({
          path: linePath(index, 'receiptLineId'),
          code: 'purchase_return_receipt_line_invalid',
        });
      }
    });
    if (issues.length > 0) throw linesError(issues);

    // A receipt line's goods go back in its own batch: the form sends none (the contract refuses
    // one), and a stored draft line keeps the one written when it was saved
    const resolved = await resolveLines(
      tx,
      lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        batchId: receiptOf(line)?.batchId ?? line.batchId,
        serialNumbers: [...line.serialNumbers],
      })),
      'out',
      { lock },
    );

    resolved.forEach((line, index) => {
      const typed = lines[index];
      const receipt = typed === undefined ? undefined : receiptOf(typed);
      if (receipt === undefined) return;
      if (compareQuantity(line.baseQuantity, keptQuantity(receipt)) > 0) {
        issues.push({ path: linePath(index, 'quantity'), code: 'purchase_return_over_received' });
      }
      const came = new Set(receipt.serialNumbers);
      if (line.serialNumbers.some((serial) => !came.has(serial))) {
        issues.push({
          path: linePath(index, 'serialNumbers'),
          code: 'purchase_return_serial_invalid',
        });
      }
    });
    // A line on its own leaves at the average cost (decision 2): an item that never had a cost
    // (no stock ever came in) has nothing to leave at
    const costed = await this.costedVariants(
      tx,
      lines.flatMap((line) => (line.receiptLineId === null ? [line.variantId] : [])),
    );
    lines.forEach((line, index) => {
      if (line.receiptLineId === null && !costed.has(line.variantId)) {
        issues.push({ path: linePath(index, 'variantId'), code: 'purchase_return_cost_unknown' });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    return { lines: resolved, receipts };
  }

  // The variants among `ids` that have an average cost (step 14's stock_values row)
  private async costedVariants(tx: Transaction, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ variantId: stockValues.variantId })
      .from(stockValues)
      .where(
        and(
          eq(stockValues.tenantId, getTenantId()),
          inArray(stockValues.variantId, [...new Set(ids)]),
          sql`${stockValues.unitCost} IS NOT NULL`,
        ),
      );
    return new Set(rows.map((row) => row.variantId));
  }

  // The goods receipt lines some return lines name, with their receipt's supplier, status and
  // warehouse. lock: the lines are locked FOR NO KEY UPDATE in id order, then read, so
  // returned_quantity and billed are what the last posting committed. A bill's posting locks the
  // same lines the same way (BillsService.receiptLines), so a return and a bill of one receipt line
  // take turns: whichever is second sees the first. NO KEY: a draft line being saved against them
  // (a KEY SHARE lock through its foreign key) is not blocked.
  private async receiptLines(
    tx: Transaction,
    ids: readonly string[],
    lock: boolean,
  ): Promise<Map<string, ReceiptLine>> {
    if (ids.length === 0) return new Map();
    const query = tx
      .select({
        id: goodsReceiptLines.id,
        variantId: goodsReceiptLines.variantId,
        baseQuantity: goodsReceiptLines.baseQuantity,
        returnedQuantity: goodsReceiptLines.returnedQuantity,
        batchId: goodsReceiptLines.batchId,
        serialNumbers: goodsReceiptLines.serialNumbers,
        value: goodsReceiptLines.value,
        billed: goodsReceiptLines.billed,
        orderLineId: goodsReceiptLines.orderLineId,
        supplierId: goodsReceipts.supplierId,
        status: goodsReceipts.status,
        warehouseId: goodsReceipts.warehouseId,
      })
      .from(goodsReceiptLines)
      .innerJoin(
        goodsReceipts,
        and(
          eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
          eq(goodsReceipts.id, goodsReceiptLines.receiptId),
        ),
      )
      .where(
        and(
          eq(goodsReceiptLines.tenantId, getTenantId()),
          inArray(goodsReceiptLines.id, [...new Set(ids)]),
        ),
      )
      .orderBy(asc(goodsReceiptLines.id));
    const rows = lock ? await query.for('no key update', { of: goodsReceiptLines }) : await query;
    return new Map(rows.map((row) => [row.id, row]));
  }

  // Posting, in the caller's transaction, in the order migration 0042 needs: the lines are written
  // while the return is still a draft (their values, and the bill line of a billed receipt line),
  // then the receipt lines and the orders, and the return becomes posted last. A refused step
  // leaves nothing: no number used, no stock moved.
  private async postAndLog(tx: Transaction, draft: ReturnRow): Promise<void> {
    const tenantId = getTenantId();
    // Open period, and not in the future: tomorrow's goods cannot leave today
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    // Active now: the return goes in the supplier's file
    await assertSupplier(tx, draft.supplierId);
    const stored = await this.linesOf(tx, draft.id);
    // Again, under the locks: another return may have sent the same goods back since the draft was
    // saved, or a bill may have billed them
    const { lines, receipts } = await this.checkLines(tx, draft.supplierId, stored, true);
    const receiptOf = (index: number) => {
      const id = stored[index]?.receiptLineId ?? null;
      return id === null ? undefined : receipts.get(id);
    };

    // Not billed yet, and from an order: the order counts them as not received (decision 3)
    const unbilled = lines.flatMap((line, index) => {
      const receipt = receiptOf(index);
      return receipt === undefined || receipt.billed || receipt.orderLineId === null
        ? []
        : [{ orderLineId: receipt.orderLineId, quantity: line.baseQuantity }];
    });
    const orders = await this.lockOrders(
      tx,
      unbilled.map((line) => line.orderLineId),
    );
    // Billed already: a debit note takes the money off this bill line
    const billing = await this.billingOf(
      tx,
      [...receipts.values()].filter((receipt) => receipt.billed).map((receipt) => receipt.id),
    );

    // What each line puts back on goods received not billed: a receipt line's cost; a line on its
    // own at the average cost (null: the stock posting works it out)
    const given = lines.map((line, index) => {
      const receipt = receiptOf(index);
      return receipt === undefined ? null : returnValue(receipt, line.baseQuantity);
    });
    const number = await this.numbering.next(tx, 'purchase.return', draft.date);
    const moved = await this.posting.post(tx, {
      date: draft.date,
      kind: 'purchase_return',
      direction: 'out',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: draft.warehouseId,
        variant: line.variant,
        batchId: line.batchId,
        quantity: line.baseQuantity,
        serialNumbers: line.serialNumbers,
        value: given[index] ?? null,
      })),
    });
    const values = lines.map((_, index) => given[index] ?? moved[index] ?? '0');

    // Still a draft here: the lines may change, and take their values and their billing
    await this.writeLines(tx, draft.id, stored, lines, {
      values,
      billing: stored.map((line) =>
        line.receiptLineId === null ? null : (billing.get(line.receiptLineId) ?? null),
      ),
    });
    // What went back, on each receipt line, in id order (the order every posting locks rows in).
    // Only up: migration 0042 refuses anything else on a posted receipt's line.
    const back = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const receipt = receiptOf(index);
      if (receipt === undefined) return;
      back.set(receipt.id, [...(back.get(receipt.id) ?? []), line.baseQuantity]);
    });
    for (const [id, quantities] of [...back].toSorted(([a], [b]) => a.localeCompare(b))) {
      await tx
        .update(goodsReceiptLines)
        .set({
          returnedQuantity: sql`${goodsReceiptLines.returnedQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.id, id)));
    }
    await this.returnOnOrders(tx, orders, unbilled);
    await tx
      .update(purchaseReturns)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${purchaseReturns.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseReturns.tenantId, tenantId), eq(purchaseReturns.id, draft.id)));

    // The books (decision 1): Dr Goods received not billed / Cr Inventory. The account for a
    // difference is looked up only when the stock could not give the receipt's cost (decision 32).
    const parts = lines.map((_, index) => ({
      receiptWarehouseId: receiptOf(index)?.warehouseId ?? draft.warehouseId,
      value: values[index] ?? '0',
      moved: moved[index] ?? '0',
    }));
    const differs = parts.some((part) => compareMoney(part.value, part.moved) !== 0);
    const entry = await this.books.purchaseReturn(
      tx,
      { id: draft.id, number, date: draft.date },
      {
        warehouseId: draft.warehouseId,
        lines: parts,
        differenceAccountId: differs ? await this.purchaseBooks.priceDifferenceAccountId(tx) : null,
      },
    );
    await audit(tx, {
      action: 'purchase_return.posted',
      entityType: 'purchase_return',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The orders behind some order lines, locked FOR UPDATE in id order (after the receipt lines,
  // the order this posting takes them in): a goods receipt of the same order waits, then sees what
  // went back. Returns order id → its status.
  private async lockOrders(
    tx: Transaction,
    orderLineIds: readonly string[],
  ): Promise<Map<string, string>> {
    const tenantId = getTenantId();
    if (orderLineIds.length === 0) return new Map();
    const owners = await tx
      .selectDistinct({ orderId: purchaseOrderLines.orderId })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          inArray(purchaseOrderLines.id, [...orderLineIds]),
        ),
      );
    const rows = await tx
      .select({ id: purchaseOrders.id, status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          inArray(
            purchaseOrders.id,
            owners.map((owner) => owner.orderId),
          ),
        ),
      )
      .orderBy(asc(purchaseOrders.id))
      .for('update');
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  // What went back before a bill billed it comes off its order lines (decision 3): their received
  // quantity comes down, and a received order is approved again (partly received), so the supplier
  // can send the goods again on it, or it can be closed. An approved order gets a new version too
  // (its page shows old received quantities). A closed order keeps its status and its version:
  // migration 0042 lets only its lines' received quantity come down.
  private async returnOnOrders(
    tx: Transaction,
    orders: ReadonlyMap<string, string>,
    lines: readonly { orderLineId: string; quantity: string }[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    for (const line of lines) {
      byOrderLine.set(line.orderLineId, [
        ...(byOrderLine.get(line.orderLineId) ?? []),
        line.quantity,
      ]);
    }
    for (const [orderLineId, quantities] of [...byOrderLine].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      await tx
        .update(purchaseOrderLines)
        .set({
          receivedQuantity: sql`${purchaseOrderLines.receivedQuantity} - ${sumQuantity(quantities)}::numeric`,
        })
        .where(
          and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.id, orderLineId)),
        );
    }
    for (const [orderId, status] of orders) {
      if (status !== 'received' && status !== 'approved') continue;
      await tx
        .update(purchaseOrders)
        .set({
          status: 'approved',
          version: sql`${purchaseOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, orderId)));
    }
  }

  // Receipt line → the posted bill line that billed it. Read under the receipt lines' lock, so the
  // `billed` flag and this agree.
  private async billingOf(
    tx: Transaction,
    receiptLineIds: readonly string[],
  ): Promise<Map<string, Billing>> {
    if (receiptLineIds.length === 0) return new Map();
    const rows = await tx
      .select({
        receiptLineId: billLines.receiptLineId,
        billId: billLines.billId,
        billLineId: billLines.id,
      })
      .from(billLines)
      .innerJoin(bills, and(eq(bills.tenantId, billLines.tenantId), eq(bills.id, billLines.billId)))
      .where(
        and(
          eq(billLines.tenantId, getTenantId()),
          inArray(billLines.receiptLineId, [...receiptLineIds]),
          eq(bills.status, 'posted'),
        ),
      );
    const billing = new Map(
      rows.flatMap((row) =>
        row.receiptLineId === null
          ? []
          : [[row.receiptLineId, { billId: row.billId, billLineId: row.billLineId }]],
      ),
    );
    for (const id of receiptLineIds) {
      if (!billing.has(id)) throw new Error(`Billed receipt line ${id} has no posted bill line`);
    }
    return billing;
  }

  // The lines in the order they were written. posted: set when posting has priced them and found
  // the bill lines that billed them.
  private async writeLines(
    tx: Transaction,
    returnId: string,
    typed: readonly LineRefs[],
    lines: readonly ResolvedLine[],
    posted?: { values: readonly string[]; billing: readonly (Billing | null)[] },
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(purchaseReturnLines)
      .where(
        and(eq(purchaseReturnLines.tenantId, tenantId), eq(purchaseReturnLines.returnId, returnId)),
      );
    await tx.insert(purchaseReturnLines).values(
      lines.map((line, index) => ({
        tenantId,
        returnId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        receiptLineId: typed[index]?.receiptLineId ?? null,
        billId: posted?.billing[index]?.billId ?? null,
        billLineId: posted?.billing[index]?.billLineId ?? null,
        value: posted?.values[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<ReturnRow> {
    const [row] = await tx
      .select()
      .from(purchaseReturns)
      .where(and(eq(purchaseReturns.tenantId, getTenantId()), eq(purchaseReturns.id, id)))
      .for('update');
    if (!row) throw notFound('Purchase return');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, returnId: string): Promise<LineRow[]> {
    return tx
      .select()
      .from(purchaseReturnLines)
      .where(
        and(
          eq(purchaseReturnLines.tenantId, getTenantId()),
          eq(purchaseReturnLines.returnId, returnId),
        ),
      )
      .orderBy(asc(purchaseReturnLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        purchaseReturn: purchaseReturns,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
      })
      .from(purchaseReturns)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, purchaseReturns.tenantId),
          eq(parties.id, purchaseReturns.supplierId),
        ),
      )
      .where(and(eq(purchaseReturns.tenantId, getTenantId()), where))
      .orderBy(desc(purchaseReturns.date), desc(purchaseReturns.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<PurchaseReturn> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(purchaseReturns.id, id), 1);
    if (!found) throw notFound('Purchase return');
    const { purchaseReturn: row } = found;
    const lines = await this.linesOf(tx, id);
    const receiptLineIds = lines.flatMap((line) =>
      line.receiptLineId === null ? [] : [line.receiptLineId],
    );
    const billIds = [
      ...new Set(lines.flatMap((line) => (line.billId === null ? [] : [line.billId]))),
    ];
    const [canSee, entries, variants, batches, receipts, billed, debits] = await Promise.all([
      this.access.canSee(),
      this.books.entriesOf(tx, id),
      loadVariants(
        tx,
        lines.map((line) => line.variantId),
      ),
      batchesOf(
        tx,
        lines.map((line) => line.batchId),
      ),
      receiptLineIds.length === 0
        ? []
        : tx
            .select({
              lineId: goodsReceiptLines.id,
              id: goodsReceipts.id,
              number: goodsReceipts.number,
            })
            .from(goodsReceiptLines)
            .innerJoin(
              goodsReceipts,
              and(
                eq(goodsReceipts.tenantId, goodsReceiptLines.tenantId),
                eq(goodsReceipts.id, goodsReceiptLines.receiptId),
              ),
            )
            .where(
              and(
                eq(goodsReceiptLines.tenantId, tenantId),
                inArray(goodsReceiptLines.id, receiptLineIds),
              ),
            )
            .orderBy(asc(goodsReceipts.number)),
      billIds.length === 0
        ? []
        : tx
            .select({ id: bills.id, number: bills.number })
            .from(bills)
            .where(and(eq(bills.tenantId, tenantId), inArray(bills.id, billIds))),
      // Drafts too: a second debit note for the same goods is then easy to spot
      tx
        .selectDistinct({ id: debitNotes.id, number: debitNotes.number })
        .from(debitNoteLines)
        .innerJoin(
          debitNotes,
          and(
            eq(debitNotes.tenantId, debitNoteLines.tenantId),
            eq(debitNotes.id, debitNoteLines.debitNoteId),
          ),
        )
        .innerJoin(
          purchaseReturnLines,
          and(
            eq(purchaseReturnLines.tenantId, debitNoteLines.tenantId),
            eq(purchaseReturnLines.id, debitNoteLines.returnLineId),
          ),
        )
        .where(and(eq(debitNoteLines.tenantId, tenantId), eq(purchaseReturnLines.returnId, id)))
        .orderBy(asc(debitNotes.number)),
    ]);
    const receiptOf = new Map(receipts.map((receipt) => [receipt.lineId, receipt]));
    const billNumber = new Map(billed.map((bill) => [bill.id, bill.number]));
    return {
      ...toSummary(row, found.supplier, found.lineCount),
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
            receiptLineId: line.receiptLineId,
            receiptNumber:
              line.receiptLineId === null
                ? null
                : (receiptOf.get(line.receiptLineId)?.number ?? null),
            billed: line.billLineId !== null,
            billLineId: line.billLineId,
            billId: line.billId,
            billNumber: line.billId === null ? null : (billNumber.get(line.billId) ?? null),
            debitedQuantity: line.debitedQuantity,
            // Worked out from the books: needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
          },
        ];
      }),
      // Each receipt once, by number (the query sorted them)
      receipts: [
        ...new Map(
          receipts.map((receipt) => [receipt.id, { id: receipt.id, number: receipt.number }]),
        ).values(),
      ],
      debitNotes: debits,
      entry: entries[0] ?? null,
    };
  }

  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: ReturnRow, supplier: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      supplier: supplier.code,
      warehouse: warehouse?.code ?? null,
      reason: row.reason,
      lines,
    };
  }
}
