import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type DocumentRef,
  type ErrorCode,
  fitsDecimals,
  type GoodsReceipt,
  type GrnBillFilter,
  type GrnBillState,
  type GoodsReceiptInput,
  type GoodsReceiptLineInput,
  type GoodsReceiptSummary,
  isQuantity,
  isWholeQuantity,
  isZeroQuantity,
  type PartyRef,
  prorateMoney,
  type StockDocumentStatus,
  sumMoney,
  sumQuantity,
  toBaseQuantity,
  type UpdateGoodsReceiptInput,
  wholeCount,
  withTolerance,
} from '@omnivo/contracts';
import {
  billLines,
  bills,
  goodsReceiptLines,
  goodsReceipts,
  parties,
  products,
  purchaseOrderLines,
  purchaseOrders,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
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
  toStockLine,
} from '../inventory/stock-lines.js';
import { StockBooksService } from '../inventory/stock-books.service.js';
import { StockPostingService } from '../inventory/stock-posting.service.js';
import { ValueAccess } from '../inventory/value-access.js';
import { NumberingService } from '../numbering/numbering.service.js';
import { customerRefs } from '../sales/sales-lines.js';

type ReceiptRow = typeof goodsReceipts.$inferSelect;
type LineRow = typeof goodsReceiptLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside these subqueries a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM goods_receipt_lines l
   WHERE l.tenant_id = goods_receipts.tenant_id AND l.receipt_id = goods_receipts.id
)`;

// Step 17c: a posted line that accepted something and no posted bill bills yet (the partial index
// goods_receipt_lines_to_bill_idx), and a line a posted bill billed
const hasLineToBill = sql`EXISTS (
  SELECT 1 FROM goods_receipt_lines l
   WHERE l.tenant_id = goods_receipts.tenant_id AND l.receipt_id = goods_receipts.id
     AND NOT l.billed AND l.quantity > 0
)`;
const hasBilledLine = sql`EXISTS (
  SELECT 1 FROM goods_receipt_lines l
   WHERE l.tenant_id = goods_receipts.tenant_id AND l.receipt_id = goods_receipts.id AND l.billed
)`;

// Step 17c, decision 21: a draft, or a posted receipt no bill touched, is not billed; one with
// billed lines and lines still to bill is partly billed. A receipt that turned everything back has
// nothing to bill and stays "not billed", out of the bill form's list (to_bill).
const billState = sql<GrnBillState>`CASE
  WHEN goods_receipts.status <> 'posted' OR NOT ${hasBilledLine} THEN 'not_billed'
  WHEN ${hasLineToBill} THEN 'partly_billed'
  ELSE 'billed' END`;

function billFilter(filter: GrnBillFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  if (filter === 'to_bill') return and(eq(goodsReceipts.status, 'posted'), hasLineToBill);
  return and(eq(goodsReceipts.status, 'posted'), hasBilledLine, sql`NOT ${hasLineToBill}`);
}

// A receipt line as resolveReceiptLines() takes it: the form's line, or a stored one again. The
// order line is null on a receipt a bill makes (step 17c).
export type ReceiptLineInput = Omit<
  Pick<
    GoodsReceiptLineInput,
    | 'variantId'
    | 'unitId'
    | 'quantity'
    | 'serialNumbers'
    | 'lotNumber'
    | 'expiresOn'
    | 'manufacturedOn'
    | 'orderLineId'
    | 'rejectedQuantity'
    | 'rejectionReason'
  >,
  'orderLineId'
> & { orderLineId: string | null };

// A line checked against its product. `accepted` is a stock line like any other (decision 20),
// with a base quantity of zero when everything was turned back; `rejected` is in the same unit.
interface ReceiptLine {
  accepted: ResolvedLine;
  orderLineId: string | null;
  rejectedQuantity: string;
  rejectedBaseQuantity: string;
  rejectionReason: string | null;
}

// A draft receipt: always made from an order. A receipt a bill makes is posted in the
// transaction that makes it (receiveForBill), so no other request ever finds it a draft.
type DraftRow = ReceiptRow & { orderId: string };

// Step 17c: a bill's goods line of its own, as the bill hands it to receiveForBill()
export interface BillGoodsLine {
  variantId: string;
  unitId: string;
  quantity: string;
  lotNumber: string | null;
  expiresOn: string | null;
  manufacturedOn: string | null;
  serialNumbers: readonly string[];
  // The bill line's net: the goods come in at the bill's price, there being no order
  value: string;
}

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. Goods that go back after a posted receipt are a purchase return.',
  );
}

function toSummary(
  row: ReceiptRow,
  supplier: PartyRef,
  refs: { order: DocumentRef | null; bill: DocumentRef | null; billState: GrnBillState },
  lines: number,
): GoodsReceiptSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    supplier,
    order: refs.order,
    bill: refs.bill,
    billState: refs.billState,
    warehouseId: row.warehouseId,
    status: row.status,
    supplierChallan: row.supplierChallan,
    vehicle: row.vehicle,
    note: row.note,
    lineCount: lines,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as resolveReceiptLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): ReceiptLineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    serialNumbers: line.serialNumbers,
    lotNumber: line.lotNumber,
    expiresOn: line.expiresOn,
    manufacturedOn: line.manufacturedOn,
    orderLineId: line.orderLineId,
    rejectedQuantity: line.rejectedQuantity,
    rejectionReason: line.rejectionReason,
  };
}

// Every rule of a receipt line that does not depend on the order: like resolveLines() of the stock
// documents for an "in" line, with two differences. The accepted quantity may be zero (everything
// that came was turned back), and then nothing comes in: no lot, no serial numbers. The rejected
// quantity is checked against the same unit. lock: FOR SHARE on the products while posting, as
// resolveLines() does. Step 17c: a bill checks its own goods lines with it too, when it is saved.
export async function resolveReceiptLines(
  tx: Transaction,
  lines: readonly ReceiptLineInput[],
  { lock = false }: { lock?: boolean } = {},
): Promise<ReceiptLine[]> {
  const variants = await loadVariants(
    tx,
    lines.map((line) => line.variantId),
    { lock },
  );
  const issues: LineIssue[] = [];
  const resolved = lines.map((line, index): ReceiptLine | null => {
    const at = (field: string, code: ErrorCode) => {
      issues.push({ path: linePath(index, field), code });
      return null;
    };
    const variant = variants.get(line.variantId);
    // Goods only: a service on the order is never received. Archived: nothing new comes in.
    if (variant?.type !== 'goods' || variant.archived)
      return at('variantId', 'stock_variant_invalid');
    const unit =
      line.unitId === variant.baseUnitId
        ? { factor: '1', decimals: variant.baseDecimals }
        : variant.units.find((pack) => pack.unitId === line.unitId);
    if (unit === undefined) return at('unitId', 'stock_unit_invalid');
    // In the base unit, rounded to its decimals; zero stays zero. A quantity that rounds to
    // nothing (0.001 of a yard in whole metres) is a typing mistake.
    const inBase = (quantity: string, field: string): string | null => {
      if (isZeroQuantity(quantity)) return '0';
      if (!fitsDecimals(quantity, unit.decimals)) return at(field, 'stock_quantity_decimals');
      const base = toBaseQuantity(quantity, unit.factor, variant.baseDecimals);
      return isQuantity(base) ? base : at(field, 'quantity_format');
    };
    const baseQuantity = inBase(line.quantity, 'quantity');
    const rejectedBaseQuantity = inBase(line.rejectedQuantity, 'rejectedQuantity');
    if (baseQuantity === null || rejectedBaseQuantity === null) return null;
    const accepting = !isZeroQuantity(baseQuantity);

    // The lot of what came in. More of a known lot takes its expiry; a new lot of a product with
    // expiry dates needs one (StockPostingService.resolveBatches, when posted).
    const lotNumber = variant.tracking === 'batch' && accepting ? line.lotNumber : null;
    if (variant.tracking === 'batch' && accepting && lotNumber === null) {
      return at('lotNumber', 'stock_lot_required');
    }
    // One serial number per base unit accepted: 3 phones came in, 3 IMEIs. A rejected phone does
    // not come in, so its IMEI is not recorded.
    const serialNumbers = variant.tracking === 'serial' ? line.serialNumbers : [];
    if (
      variant.tracking === 'serial' &&
      (!isWholeQuantity(baseQuantity) || wholeCount(baseQuantity) !== serialNumbers.length)
    ) {
      return at('serialNumbers', 'stock_serial_count');
    }
    return {
      accepted: {
        variant,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: unit.factor,
        baseQuantity,
        batchId: null,
        lotNumber,
        expiresOn: lotNumber === null ? null : line.expiresOn,
        manufacturedOn: lotNumber === null ? null : line.manufacturedOn,
        serialNumbers,
      },
      orderLineId: line.orderLineId,
      rejectedQuantity: line.rejectedQuantity,
      rejectedBaseQuantity,
      // The database keeps a reason only for what was turned back (decision 20)
      rejectionReason: isZeroQuantity(rejectedBaseQuantity) ? null : line.rejectionReason,
    };
  });
  if (issues.length > 0) throw linesError(issues);
  return resolved.flatMap((line) => (line === null ? [] : [line]));
}

// The order a receipt takes goods against, as far as the receipt needs it
interface OrderInfo {
  id: string;
  number: string | null;
  supplierId: string;
}

// An order line, as the receipt checks and values it
interface OrderLineInfo {
  id: string;
  variantId: string;
  baseQuantity: string;
  receivedQuantity: string;
  net: string;
}

// Goods receipts (GRN, step 17b): what a supplier's truck brought in against an approved purchase
// order. Like a delivery the other way round: a draft is changed freely; posting numbers it, brings
// the accepted goods into stock at the order's price, books them (Dr Inventory / Cr Goods received
// not billed) and counts them on the order's lines. All in one transaction. Step 17c: a bill's goods
// lines of its own come in on a receipt too, with no order (receiveForBill), and a bill's posting
// marks the lines it bills (`billed`).
@Injectable()
export class GoodsReceiptsService {
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
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    orderId?: string | undefined;
    bill?: GrnBillFilter | undefined;
  }): Promise<{ items: GoodsReceiptSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(goodsReceipts.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(goodsReceipts.supplierId, query.supplierId),
          query.warehouseId === undefined
            ? undefined
            : eq(goodsReceipts.warehouseId, query.warehouseId),
          query.orderId === undefined ? undefined : eq(goodsReceipts.orderId, query.orderId),
          billFilter(query.bill),
          after === undefined
            ? undefined
            : sql`(${goodsReceipts.date}, ${goodsReceipts.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.receipt.date, last.receipt.id]);
      return {
        items: page.items.map((row) => toSummary(row.receipt, row.supplier, row, row.lineCount)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<GoodsReceipt> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: GoodsReceiptInput): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const order = await this.lockOrder(tx, input.orderId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveReceiptLines(tx, input.lines);
      await this.checkOrderLines(tx, order.id, lines);
      const [row] = await tx
        .insert(goodsReceipts)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          // The order's supplier, never one the form sends (goods_receipts_order_fk holds both)
          supplierId: order.supplierId,
          orderId: order.id,
          warehouseId: input.warehouseId,
          supplierChallan: input.supplierChallan,
          vehicle: input.vehicle,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Goods receipt insert returned no row');
      await this.writeLines(tx, row, lines);
      await audit(tx, {
        action: 'goods_receipt.created',
        entityType: 'goods_receipt',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, order, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, { ...row, orderId: order.id });
      return this.read(tx, row.id);
    });
  }

  // A receipt keeps its order (decision 20): the edit form does not send it
  update(id: string, input: UpdateGoodsReceiptInput): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const order = await this.lockOrder(tx, before.orderId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const lines = await resolveReceiptLines(tx, input.lines);
      await this.checkOrderLines(tx, order.id, lines);
      const [updated] = await tx
        .update(goodsReceipts)
        .set({
          date: input.date,
          warehouseId: input.warehouseId,
          supplierChallan: input.supplierChallan,
          vehicle: input.vehicle,
          note: input.note,
          version: sql`${goodsReceipts.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)))
        .returning();
      if (!updated) throw notFound('Goods receipt');
      await this.writeLines(tx, updated, lines);
      await audit(tx, {
        action: 'goods_receipt.updated',
        entityType: 'goods_receipt',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, order, linesBefore.length),
          await this.snapshot(tx, updated, order, lines.length),
        ),
      });
      if (input.post) await this.postAndLog(tx, { ...updated, orderId: order.id });
      return this.read(tx, id);
    });
  }

  // A draft, even one of an order that was closed since (decision 30): it brought nothing in
  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      const lines = await this.linesOf(tx, id);
      const order = await this.orderRef(tx, before.orderId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(goodsReceipts)
        .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)));
      const snapshot = await this.snapshot(tx, before, order, lines.length);
      await audit(tx, {
        action: 'goods_receipt.deleted',
        entityType: 'goods_receipt',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, version: number): Promise<GoodsReceipt> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // Step 17c: the goods of a bill's lines of its own (decision 4), received by a goods receipt the
  // bill posts in its own transaction: no order, the bill's supplier and warehouse, each line at
  // the bill line's net (there is no order price), so the moving average takes them in at what the
  // supplier charged. The bill is pending and locked by its posting (BillsService); the database
  // lets a receipt with a bill be written only then (goods_receipts_bill_check). Errors name the
  // lines as given here (lines.0 …); the bill maps them to its own lines. Returns the new receipt
  // lines' ids, in the order given.
  async receiveForBill(
    tx: Transaction,
    input: {
      billId: string;
      billNumber: string;
      supplierId: string;
      date: string;
      warehouseId: string;
      lines: readonly BillGoodsLine[];
    },
  ): Promise<string[]> {
    await this.posting.assertDate(tx, input.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
    const lines = await resolveReceiptLines(
      tx,
      input.lines.map((line) => ({
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        serialNumbers: [...line.serialNumbers],
        lotNumber: line.lotNumber,
        expiresOn: line.expiresOn,
        manufacturedOn: line.manufacturedOn,
        orderLineId: null,
        rejectedQuantity: '0',
        rejectionReason: null,
      })),
      { lock: true },
    );
    const userId = currentPrincipal().userId;
    const [row] = await tx
      .insert(goodsReceipts)
      .values({
        tenantId: getTenantId(),
        date: input.date,
        supplierId: input.supplierId,
        billId: input.billId,
        warehouseId: input.warehouseId,
        note: `Bill ${input.billNumber}`,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    if (!row) throw new Error('Goods receipt insert returned no row');
    const number = await this.numbering.next(tx, 'inventory.receipt', input.date);
    const batchIds = await this.posting.resolveBatches(
      tx,
      lines.map((line) => line.accepted),
    );
    const values = input.lines.map((line) => line.value);
    await this.posting.post(tx, {
      date: input.date,
      kind: 'purchase_receipt',
      direction: 'in',
      documentId: row.id,
      documentNumber: number,
      moves: lines.map((line, index) => ({
        line: index,
        warehouseId: input.warehouseId,
        variant: line.accepted.variant,
        batchId: batchIds[index] ?? null,
        quantity: line.accepted.baseQuantity,
        serialNumbers: line.accepted.serialNumbers,
        value: values[index] ?? '0',
      })),
    });
    const lineIds = await this.writeLines(
      tx,
      row,
      lines.map((line, index) => ({
        ...line,
        accepted: { ...line.accepted, batchId: batchIds[index] ?? null },
      })),
      values,
    );
    await tx
      .update(goodsReceipts)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: userId,
        version: sql`${goodsReceipts.version} + 1`,
        updatedBy: userId,
      })
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, row.id)));
    const entry = await this.books.purchaseReceipt(
      tx,
      { id: row.id, number, date: input.date },
      { warehouseId: input.warehouseId, value: sumMoney(values) },
    );
    await audit(tx, {
      action: 'goods_receipt.posted',
      entityType: 'goods_receipt',
      entityId: row.id,
      changes: created({
        ...(await this.snapshot(tx, row, null, lines.length)),
        number,
        bill: input.billNumber,
        entry: entry?.number ?? null,
      }),
    });
    return lineIds;
  }

  // A draft into stock: the date and the warehouse checked, the order locked and still approved,
  // the lines checked again against their products and against what the order still takes, the
  // number taken, the accepted goods moved in at the order's price, the order's lines counted and
  // the entry booked. In the caller's transaction: a refused line leaves nothing posted and no
  // number used.
  private async postAndLog(tx: Transaction, draft: DraftRow): Promise<void> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    // Locked before anything moves: two receipts of one order post one after the other, and the
    // second sees what the first brought in. A reopen, close or cancel waits for us too.
    const order = await this.lockOrder(tx, draft.orderId);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveReceiptLines(tx, stored.map(storedInput), { lock: true });
    const orderLines = await this.checkOrderLines(tx, order.id, lines);

    const number = await this.numbering.next(tx, 'inventory.receipt', draft.date);
    // Every line, so the errors name the person's own lines: a line that accepted nothing has no
    // lot, and gets no batch
    const batchIds = await this.posting.resolveBatches(
      tx,
      lines.map((line) => line.accepted),
    );
    // At the order's price (decision 2): the line's net, after its discount and before VAT
    // (decision 6), shared by what came in. 600 m of an order line of 1,000 m worth ৳3,12,500 is
    // worth ৳1,87,500; what came over the order is worth the same per metre (decision 7).
    const values = lines.map((line) => {
      const orderLine = line.orderLineId === null ? undefined : orderLines.get(line.orderLineId);
      if (!orderLine) throw new Error(`Order line ${String(line.orderLineId)} is missing`);
      return prorateMoney(orderLine.net, line.accepted.baseQuantity, orderLine.baseQuantity);
    });
    // Only what was accepted comes in. A line that turned everything back moves nothing.
    await this.posting.post(tx, {
      date: draft.date,
      kind: 'purchase_receipt',
      direction: 'in',
      documentId: draft.id,
      documentNumber: number,
      moves: lines.flatMap((line, index) =>
        isZeroQuantity(line.accepted.baseQuantity)
          ? []
          : [
              {
                line: index,
                warehouseId: draft.warehouseId,
                variant: line.accepted.variant,
                batchId: batchIds[index] ?? null,
                quantity: line.accepted.baseQuantity,
                serialNumbers: line.accepted.serialNumbers,
                value: values[index] ?? '0',
              },
            ],
      ),
    });
    // Still a draft here: the lines may change, and take their batches and values
    await this.writeLines(
      tx,
      draft,
      lines.map((line, index) => ({
        ...line,
        accepted: { ...line.accepted, batchId: batchIds[index] ?? null },
      })),
      values,
    );
    await tx
      .update(goodsReceipts)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${goodsReceipts.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, draft.id)));
    await this.receiveOnOrder(tx, order.id, lines);
    const entry = await this.books.purchaseReceipt(
      tx,
      { id: draft.id, number, date: draft.date },
      { warehouseId: draft.warehouseId, value: sumMoney(values) },
    );
    await audit(tx, {
      action: 'goods_receipt.posted',
      entityType: 'goods_receipt',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
  }

  // The order of a receipt: approved (decision 8). FOR UPDATE, in every write of a receipt: a
  // reopen or a cancel of the order waits and then sees the receipt, and two receipts posting
  // against one order take turns. Always taken after the receipt's own lock (lockDraft), never
  // before, so two of these never wait for each other in a circle.
  private async lockOrder(tx: Transaction, orderId: string): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        supplierId: purchaseOrders.supplierId,
        status: purchaseOrders.status,
      })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, orderId)))
      .for('update');
    if (!row) {
      throw new AppError(409, 'grn_order_invalid', 'Pick an approved purchase order.', {
        fieldErrors: { orderId: ['grn_order_invalid'] },
      });
    }
    // Reopened, received, closed or cancelled since the page was opened
    if (row.status !== 'approved') {
      throw new AppError(
        409,
        'purchase_not_approved',
        'This order is not waiting for goods any more.',
        { fieldErrors: { orderId: ['purchase_not_approved'] } },
      );
    }
    return { id: row.id, number: row.number, supplierId: row.supplierId };
  }

  // Each line receives a line of this order, for the same variant (in any of its units), and all
  // the lines together never bring in more than the order line still takes: ordered × (100 + the
  // workspace's percent) ÷ 100, less what posted receipts accepted (decisions 7 and 22). Two lines
  // may share an order line (two lots of one fabric). What was rejected does not count: it did not
  // come in. Drafts hold nothing, so two drafts may each take the whole rest; the second one to
  // post is refused here. Returns the order's lines, for the values.
  private async checkOrderLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ReceiptLine[],
  ): Promise<Map<string, OrderLineInfo>> {
    const tenantId = getTenantId();
    const rows = await tx
      .select({
        id: purchaseOrderLines.id,
        variantId: purchaseOrderLines.variantId,
        baseQuantity: purchaseOrderLines.baseQuantity,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
        net: purchaseOrderLines.net,
      })
      .from(purchaseOrderLines)
      .where(
        and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.orderId, orderId)),
      );
    const orderLines = new Map(rows.map((row) => [row.id, row]));
    const [settings] = await tx
      .select({ overReceiptPercent: tenantSettings.overReceiptPercent })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (!settings) throw new Error(`tenant_settings row missing for tenant ${tenantId}`);

    const issues: LineIssue[] = [];
    const taken = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLine = line.orderLineId === null ? undefined : orderLines.get(line.orderLineId);
      if (line.orderLineId === null || orderLine?.variantId !== line.accepted.variant.variantId) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'grn_order_line_invalid' });
        return;
      }
      taken.set(line.orderLineId, [
        ...(taken.get(line.orderLineId) ?? []),
        line.accepted.baseQuantity,
      ]);
    });
    for (const [orderLineId, quantities] of taken) {
      const orderLine = orderLines.get(orderLineId);
      if (!orderLine) continue;
      const most = withTolerance(orderLine.baseQuantity, settings.overReceiptPercent);
      const after = sumQuantity([orderLine.receivedQuantity, ...quantities]);
      if (compareQuantity(after, most) <= 0) continue;
      // Under every line that takes from it: the person decides which one to cut
      lines.forEach((line, index) => {
        if (line.orderLineId === orderLineId) {
          issues.push({ path: linePath(index, 'quantity'), code: 'grn_over_order' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
    return orderLines;
  }

  // What the posted lines accepted and turned back, onto their order lines; and when every goods
  // line has all it ordered, the order is received (decision 29). The lines first: migration 0038
  // lets received_quantity change only while the order is approved, and only up. A service line
  // is never received and does not hold the order open.
  private async receiveOnOrder(
    tx: Transaction,
    orderId: string,
    lines: readonly ReceiptLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, { accepted: string[]; rejected: string[] }>();
    for (const line of lines) {
      if (line.orderLineId === null) continue;
      const sums = byOrderLine.get(line.orderLineId) ?? { accepted: [], rejected: [] };
      sums.accepted.push(line.accepted.baseQuantity);
      sums.rejected.push(line.rejectedBaseQuantity);
      byOrderLine.set(line.orderLineId, sums);
    }
    for (const [orderLineId, sums] of byOrderLine) {
      await tx
        .update(purchaseOrderLines)
        .set({
          receivedQuantity: sql`${purchaseOrderLines.receivedQuantity} + ${sumQuantity(sums.accepted)}::numeric`,
          rejectedQuantity: sql`${purchaseOrderLines.rejectedQuantity} + ${sumQuantity(sums.rejected)}::numeric`,
        })
        .where(
          and(eq(purchaseOrderLines.tenantId, tenantId), eq(purchaseOrderLines.id, orderLineId)),
        );
    }
    const [open] = await tx
      .select({ id: purchaseOrderLines.id })
      .from(purchaseOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, purchaseOrderLines.tenantId),
          eq(products.id, purchaseOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(purchaseOrderLines.tenantId, tenantId),
          eq(purchaseOrderLines.orderId, orderId),
          eq(products.type, 'goods'),
          sql`${purchaseOrderLines.receivedQuantity} < ${purchaseOrderLines.baseQuantity}`,
        ),
      )
      .limit(1);
    // A new version either way: an order page open somewhere shows old received quantities, and
    // its next action (close) must reload first
    await tx
      .update(purchaseOrders)
      .set({
        ...(open === undefined ? { status: 'received' as const } : {}),
        version: sql`${purchaseOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.id, orderId)));
  }

  // The lines in the order they were written. values: set when posting has priced them. order_id
  // is the receipt's own (decision 31), so the foreign keys can check the order line belongs to it.
  // Returns the new lines' ids, in line order (step 17c: a bill points its lines at them).
  private async writeLines(
    tx: Transaction,
    receipt: ReceiptRow,
    lines: readonly ReceiptLine[],
    values?: readonly string[],
  ): Promise<string[]> {
    const tenantId = getTenantId();
    await tx
      .delete(goodsReceiptLines)
      .where(
        and(eq(goodsReceiptLines.tenantId, tenantId), eq(goodsReceiptLines.receiptId, receipt.id)),
      );
    const inserted = await tx
      .insert(goodsReceiptLines)
      .values(
        lines.map((line, index) => ({
          tenantId,
          receiptId: receipt.id,
          orderId: receipt.orderId,
          orderLineId: line.orderLineId,
          lineNo: index + 1,
          productId: line.accepted.variant.productId,
          variantId: line.accepted.variant.variantId,
          unitId: line.accepted.unitId,
          quantity: line.accepted.quantity,
          factor: line.accepted.factor,
          baseQuantity: line.accepted.baseQuantity,
          batchId: line.accepted.batchId,
          serialNumbers: line.accepted.serialNumbers,
          lotNumber: line.accepted.lotNumber,
          expiresOn: line.accepted.expiresOn,
          manufacturedOn: line.accepted.manufacturedOn,
          rejectedQuantity: line.rejectedQuantity,
          rejectedBaseQuantity: line.rejectedBaseQuantity,
          rejectionReason: line.rejectionReason,
          value: values?.[index] ?? null,
        })),
      )
      .returning({ id: goodsReceiptLines.id, lineNo: goodsReceiptLines.lineNo });
    return inserted.toSorted((a, b) => a.lineNo - b.lineNo).map((row) => row.id);
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<DraftRow> {
    const [row] = await tx
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), eq(goodsReceipts.id, id)))
      .for('update');
    if (!row) throw notFound('Goods receipt');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    const { orderId } = row;
    // A receipt a bill makes is posted before its transaction commits (receiveForBill)
    if (orderId === null) throw new Error(`Draft goods receipt ${id} has no order`);
    return { ...row, orderId };
  }

  private linesOf(tx: Transaction, receiptId: string) {
    return tx
      .select()
      .from(goodsReceiptLines)
      .where(
        and(
          eq(goodsReceiptLines.tenantId, getTenantId()),
          eq(goodsReceiptLines.receiptId, receiptId),
        ),
      )
      .orderBy(asc(goodsReceiptLines.lineNo));
  }

  // Step 17c: the order or the bill behind it, whichever it has (left joins: one of the two is
  // null), and how much of it is billed
  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        receipt: goodsReceipts,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        order: { id: purchaseOrders.id, number: purchaseOrders.number },
        bill: { id: bills.id, number: bills.number },
        billState,
        lineCount,
      })
      .from(goodsReceipts)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, goodsReceipts.tenantId), eq(parties.id, goodsReceipts.supplierId)),
      )
      .leftJoin(
        purchaseOrders,
        and(
          eq(purchaseOrders.tenantId, goodsReceipts.tenantId),
          eq(purchaseOrders.id, goodsReceipts.orderId),
        ),
      )
      .leftJoin(
        bills,
        and(eq(bills.tenantId, goodsReceipts.tenantId), eq(bills.id, goodsReceipts.billId)),
      )
      .where(and(eq(goodsReceipts.tenantId, getTenantId()), where))
      .orderBy(desc(goodsReceipts.date), desc(goodsReceipts.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<GoodsReceipt> {
    const [found] = await this.rows(tx, eq(goodsReceipts.id, id), 1);
    if (!found) throw notFound('Goods receipt');
    const { receipt: row } = found;
    const lines = await this.linesOf(tx, id);
    const [canSee, entries, variants, batches, billRefs] = await Promise.all([
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
      // Step 17c: the posted bills that bill its lines, oldest first
      tx
        .selectDistinct({ id: bills.id, number: bills.number, date: bills.date })
        .from(billLines)
        .innerJoin(
          bills,
          and(eq(bills.tenantId, billLines.tenantId), eq(bills.id, billLines.billId)),
        )
        .where(
          and(
            eq(billLines.tenantId, getTenantId()),
            eq(bills.status, 'posted'),
            inArray(
              billLines.receiptLineId,
              lines.map((line) => line.id),
            ),
          ),
        )
        .orderBy(asc(bills.date), asc(bills.id)),
    ]);
    return {
      ...toSummary(row, found.supplier, found, found.lineCount),
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
            orderLineId: line.orderLineId,
            rejectedQuantity: line.rejectedQuantity,
            rejectedBaseQuantity: line.rejectedBaseQuantity,
            rejectionReason: line.rejectionReason,
            billed: line.billed,
            // The order's price is on the order for everyone; what the stock was booked at is
            // worked out from the books and needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
          },
        ];
      }),
      bills: billRefs.map((bill) => ({ id: bill.id, number: bill.number })),
      entry: entries[0] ?? null,
    };
  }

  private async orderRef(tx: Transaction, orderId: string): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        supplierId: purchaseOrders.supplierId,
      })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, orderId)));
    // goods_receipts_order_fk keeps the order while a receipt points at it
    if (!row) throw new Error(`Purchase order ${orderId} of a goods receipt is missing`);
    return row;
  }

  // What the audit log shows: the header and the size, not every line. order: null for a receipt
  // a bill made (step 17c)
  private async snapshot(tx: Transaction, row: ReceiptRow, order: OrderInfo | null, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    const supplier = (await customerRefs(tx, [row.supplierId])).get(row.supplierId);
    return {
      date: row.date,
      supplier: supplier?.code ?? null,
      order: order?.number ?? null,
      warehouse: warehouse?.code ?? null,
      supplierChallan: row.supplierChallan,
      vehicle: row.vehicle,
      lines,
    };
  }
}
