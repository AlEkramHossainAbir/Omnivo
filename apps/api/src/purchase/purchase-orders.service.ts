import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type PartyRef,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderReceiptFilter,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type UpdatePurchaseOrderInput,
} from '@omnivo/contracts';
import {
  goodsReceipts,
  parties,
  purchaseOrderLines,
  purchaseOrders,
  requisitionLines,
  requisitions,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { isCheckViolation } from '../common/db/pg-errors.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { type LineIssue, linePath, linesError } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  customerRefs,
  type ResolvedSalesLine,
  salesLineValues,
  toSalesLine,
  withVariants,
} from '../sales/sales-lines.js';
import { ApprovalsService } from './approvals.service.js';
import { assertSupplier, assertWarehouse, resolvePurchaseLines } from './purchase-lines.js';

type OrderRow = typeof purchaseOrders.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside these subqueries a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM purchase_order_lines l
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
)`;

// Approved, and a posted goods receipt brought something in. All of it would be "received".
const partlyReceived = sql<boolean>`(purchase_orders.status = 'approved' AND EXISTS (
  SELECT 1 FROM purchase_order_lines l
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
     AND l.received_quantity > 0
))`;

// The goods receipt form's orders: approved, with a goods line that has not all come in. An order
// of services only is never received (the bill takes it, 17c), so it is not offered.
const goodsToReceive = sql`EXISTS (
  SELECT 1 FROM purchase_order_lines l
    JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
   WHERE l.tenant_id = purchase_orders.tenant_id AND l.order_id = purchase_orders.id
     AND p.type = 'goods' AND l.received_quantity < l.base_quantity
)`;

function receiptFilter(filter: PurchaseOrderReceiptFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  return and(eq(purchaseOrders.status, 'approved'), goodsToReceive);
}

function notDraft(): AppError {
  return new AppError(
    409,
    'purchase_not_draft',
    'This order was submitted. Reopen it to change it, if nothing was received.',
  );
}

function wasSubmitted(): AppError {
  return new AppError(
    409,
    'purchase_was_submitted',
    'This order was submitted once, so its number and approval history stay. Cancel it instead.',
  );
}

function notApproved(): AppError {
  return new AppError(409, 'purchase_not_approved', 'This order is not approved.');
}

function toSummary(
  row: OrderRow,
  supplier: PartyRef,
  lines: number,
  partly: boolean,
): PurchaseOrderSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    expectedDate: row.expectedDate,
    supplier,
    supplierReference: row.supplierReference,
    warehouseId: row.warehouseId,
    status: row.status,
    partlyReceived: partly,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Purchase orders (step 17b): what the company asks a supplier to deliver, at what price. A draft
// is changed freely; submitting numbers it and hands it to the approvals engine (17a), which moves
// its status like a requisition's. Goods receipts (GoodsReceiptsService) bring it in, and the last
// one that completes it sets it received. It moves no stock and posts nothing itself.
@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
    private readonly approvals: ApprovalsService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: PurchaseOrderStatus | undefined;
    supplierId?: string | undefined;
    warehouseId?: string | undefined;
    receipt?: PurchaseOrderReceiptFilter | undefined;
  }): Promise<{ items: PurchaseOrderSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(purchaseOrders.status, query.status),
          query.supplierId === undefined
            ? undefined
            : eq(purchaseOrders.supplierId, query.supplierId),
          query.warehouseId === undefined
            ? undefined
            : eq(purchaseOrders.warehouseId, query.warehouseId),
          receiptFilter(query.receipt),
          after === undefined
            ? undefined
            : sql`(${purchaseOrders.date}, ${purchaseOrders.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.order.date, last.order.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.order, row.supplier, row.lineCount, row.partlyReceived),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<PurchaseOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: PurchaseOrderInput): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const supplier = await assertSupplier(tx, input.supplierId);
      await assertWarehouse(tx, input.warehouseId);
      // The order's own setting (decision 15), not the workspace's: that one is about selling
      const lines = await resolvePurchaseLines(tx, input.lines, input.pricesIncludeVat);
      const links = await this.checkRequisitionLines(tx, input, lines, new Set());
      const userId = currentPrincipal().userId;
      const [row] = await tx
        .insert(purchaseOrders)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          expectedDate: input.expectedDate,
          supplierId: supplier.id,
          supplierReference: input.supplierReference,
          warehouseId: input.warehouseId,
          paymentTermsDays: input.paymentTermsDays,
          pricesIncludeVat: input.pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Purchase order insert returned no row');
      await this.insertLines(tx, row.id, lines, links);
      await audit(tx, {
        action: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, supplier, lines.length)),
      });
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const supplierBefore = await this.supplierOf(tx, before.supplierId);
      const supplier = await assertSupplier(tx, input.supplierId, before.supplierId);
      // Once numbered, the number was given to this supplier (on the PDF, in an email): a reopened
      // order keeps its supplier, like a reopened sales order keeps its customer
      if (before.number !== null && supplier.id !== before.supplierId) {
        throw new AppError(
          409,
          'purchase_supplier_invalid',
          'This order was sent to its supplier. Write a new order for another one.',
          { fieldErrors: { supplierId: ['purchase_supplier_invalid'] } },
        );
      }
      await assertWarehouse(tx, input.warehouseId, before.warehouseId);
      const lines = await resolvePurchaseLines(
        tx,
        input.lines,
        input.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const links = await this.checkRequisitionLines(
        tx,
        input,
        lines,
        new Set(linesBefore.flatMap((line) => line.requisitionLineId ?? [])),
      );
      // The old lines first: migration 0038 refuses a new warehouse while a line buys for a
      // requisition of the old one, and the new lines are checked against the new warehouse
      await this.deleteLines(tx, id);
      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          date: input.date,
          expectedDate: input.expectedDate,
          supplierId: supplier.id,
          supplierReference: input.supplierReference,
          warehouseId: input.warehouseId,
          paymentTermsDays: input.paymentTermsDays,
          pricesIncludeVat: input.pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${purchaseOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
        .returning();
      if (!updated) throw notFound('Purchase order');
      await this.insertLines(tx, id, lines, links);
      await audit(tx, {
        action: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, supplierBefore, linesBefore.length),
          await this.snapshot(tx, updated, supplier, lines.length),
        ),
      });
      return this.read(tx, id);
    });
  }

  // Only a draft that was never submitted (decision 13): it has no number and no approval history,
  // so deleting it leaves no gap. Once numbered it is cancelled instead.
  async remove(id: string, version: number): Promise<void> {
    try {
      await this.withTenant(async (tx) => {
        const before = await this.lockDraft(tx, id, version);
        if (before.number !== null) throw wasSubmitted();
        const lines = await this.linesOf(tx, id);
        const supplier = await this.supplierOf(tx, before.supplierId);
        // The lines go with it (ON DELETE CASCADE)
        await tx
          .delete(purchaseOrders)
          .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
        const snapshot = await this.snapshot(tx, before, supplier, lines.length);
        await audit(tx, {
          action: 'purchase_order.deleted',
          entityType: 'purchase_order',
          entityId: id,
          changes: diff(
            snapshot,
            Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
          ),
        });
      });
    } catch (error) {
      // The database's own rule (0038), should a submit commit between our check and the delete
      if (isCheckViolation(error, 'purchase_orders_submitted_immutable')) throw wasSubmitted();
      throw error;
    }
  }

  // Numbered the first time (decision 13), then sent for approval with its total, VAT included
  // (decision 14). A supplier or warehouse archived while it was a draft stops it here: a draft may
  // keep one, but an order is not sent to a supplier the company stopped buying from.
  submit(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lockDraft(tx, id, version);
      await assertSupplier(tx, row.supplierId);
      await assertWarehouse(tx, row.warehouseId);
      // Still a draft here, so migration 0038 lets the number be set. The engine then moves the
      // status; purchase_orders_number_check needs the number by then.
      if (row.number === null) {
        await tx
          .update(purchaseOrders)
          .set({ number: await this.numbering.next(tx, 'purchase.order', row.date) })
          .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
      }
      await this.approvals.submit(tx, 'purchase_order', id, row.total);
      return this.read(tx, id);
    });
  }

  // Pending: taken back to change it. Approved: changed after all, and approved again from the
  // first level (decision 11). Not once a goods receipt points at it, even a draft one (decision
  // 21): its lines would be written again under the receipt's lines.
  reopen(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'pending' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_reopen',
          'Only a pending or approved order can be reopened.',
        );
      }
      await this.assertNoReceipt(tx, id);
      await this.approvals.reopen(tx, 'purchase_order', id, row.status);
      return this.read(tx, id);
    });
  }

  // Partly received, and the rest will not come: the mill delivered 900 of 1,000 m. A draft
  // receipt still waiting cannot be posted after this (decision 30); it is deleted.
  close(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'approved') throw notApproved();
      if ((await this.receiptOf(tx, id, 'posted')) === undefined) {
        throw new AppError(
          409,
          'purchase_cancel_instead',
          'Nothing was received against this order. Cancel it instead.',
        );
      }
      await this.setStatus(tx, id, 'closed');
      await audit(tx, {
        action: 'purchase_order.closed',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'closed' }),
      });
      return this.read(tx, id);
    });
  }

  // Will not be bought: a draft that was submitted once, or an approved order before any goods
  // receipt (decision 29). A pending one is reopened first: someone may be deciding it right now.
  cancel(id: string, version: number): Promise<PurchaseOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'draft' && row.status !== 'approved') {
        throw new AppError(
          409,
          'purchase_cannot_cancel',
          'Only a draft or approved order can be cancelled. Reopen a pending one first.',
        );
      }
      if (row.number === null) {
        throw new AppError(
          409,
          'purchase_delete_instead',
          'This order was never submitted. Delete it instead.',
        );
      }
      // Only an approved order can have one: a receipt needs an approved order, and an order with
      // one is never reopened. Asked for a draft too: two indexed queries, and the database asks
      // the same of every cancel.
      await this.assertNoReceipt(tx, id);
      await this.setStatus(tx, id, 'cancelled');
      await audit(tx, {
        action: 'purchase_order.cancelled',
        entityType: 'purchase_order',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'cancelled' }),
      });
      return this.read(tx, id);
    });
  }

  // A posted receipt: some came in, so it is closed, not reopened or cancelled. A draft one: the
  // store keeper deletes it first (decision 21). Asked after lock(): a receipt written at the same
  // moment locks the order FOR SHARE (migration 0038), so it either committed before our FOR
  // UPDATE and is seen here, or waits for us and then finds the order changed.
  private async assertNoReceipt(tx: Transaction, orderId: string): Promise<void> {
    if ((await this.receiptOf(tx, orderId, 'posted')) !== undefined) {
      throw new AppError(
        409,
        'purchase_close_instead',
        'Goods were received against this order. Close it instead.',
      );
    }
    if ((await this.receiptOf(tx, orderId, 'draft')) !== undefined) {
      throw new AppError(
        409,
        'purchase_receipt_draft',
        'A draft goods receipt points at this order. Delete it first.',
      );
    }
  }

  private async receiptOf(tx: Transaction, orderId: string, status: 'draft' | 'posted') {
    const [row] = await tx
      .select({ id: goodsReceipts.id })
      .from(goodsReceipts)
      .where(
        and(
          eq(goodsReceipts.tenantId, getTenantId()),
          eq(goodsReceipts.orderId, orderId),
          eq(goodsReceipts.status, status),
        ),
      )
      .limit(1);
    return row;
  }

  // The requisition lines the order's lines buy for (decision 16): a line of an approved
  // requisition for this order's warehouse, for the same item, once per order (the contract checks
  // that). A link the draft already had may stay after its requisition was closed: the draft is
  // written again on every save. FOR SHARE on the requisitions: a reopen or a cancel at the same
  // moment waits until we commit, and then sees this order (the database locks them too).
  // Returns each line's link, in line order.
  private async checkRequisitionLines(
    tx: Transaction,
    input: PurchaseOrderInput,
    lines: readonly ResolvedSalesLine[],
    keptIds: ReadonlySet<string>,
  ): Promise<(string | null)[]> {
    const links = input.lines.map((line) => line.requisitionLineId);
    const ids = links.filter((id): id is string => id !== null);
    if (ids.length === 0) return links;
    const rows = await tx
      .select({
        id: requisitionLines.id,
        variantId: requisitionLines.variantId,
        status: requisitions.status,
        warehouseId: requisitions.warehouseId,
      })
      .from(requisitionLines)
      .innerJoin(
        requisitions,
        and(
          eq(requisitions.tenantId, requisitionLines.tenantId),
          eq(requisitions.id, requisitionLines.requisitionId),
        ),
      )
      .where(and(eq(requisitionLines.tenantId, getTenantId()), inArray(requisitionLines.id, ids)))
      .for('share', { of: requisitions });
    const found = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    links.forEach((id, index) => {
      if (id === null) return;
      const row = found.get(id);
      const open = row?.status === 'approved' || (row?.status === 'closed' && keptIds.has(row.id));
      if (
        row === undefined ||
        !open ||
        row.warehouseId !== input.warehouseId ||
        row.variantId !== lines[index]?.variant.variantId
      ) {
        issues.push({
          path: linePath(index, 'requisitionLineId'),
          code: 'purchase_requisition_line_invalid',
        });
      }
    });
    if (issues.length > 0) throw linesError(issues);
    return links;
  }

  private async setStatus(
    tx: Transaction,
    id: string,
    status: 'closed' | 'cancelled',
  ): Promise<void> {
    await tx
      .update(purchaseOrders)
      .set({
        status,
        version: sql`${purchaseOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)));
  }

  private async deleteLines(tx: Transaction, orderId: string): Promise<void> {
    await tx
      .delete(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, getTenantId()),
          eq(purchaseOrderLines.orderId, orderId),
        ),
      );
  }

  // The database lets them in only while the order is a draft (purchase_order_lines_guard)
  private async insertLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ResolvedSalesLine[],
    links: readonly (string | null)[],
  ): Promise<void> {
    await tx.insert(purchaseOrderLines).values(
      lines.map((line, index) => ({
        ...salesLineValues(line, index),
        orderId,
        requisitionLineId: links[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: every change to an order takes turns with the others, with an approval (the engine
  // locks it the same way) and with a goods receipt being written or posted against it
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [row] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), eq(purchaseOrders.id, id)))
      .for('update');
    if (!row) throw notFound('Purchase order');
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private async lockDraft(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const row = await this.lock(tx, id, version);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }

  private linesOf(tx: Transaction, orderId: string) {
    return tx
      .select()
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.tenantId, getTenantId()),
          eq(purchaseOrderLines.orderId, orderId),
        ),
      )
      .orderBy(asc(purchaseOrderLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        order: purchaseOrders,
        supplier: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
        partlyReceived,
      })
      .from(purchaseOrders)
      .innerJoin(
        parties,
        and(
          eq(parties.tenantId, purchaseOrders.tenantId),
          eq(parties.id, purchaseOrders.supplierId),
        ),
      )
      .where(and(eq(purchaseOrders.tenantId, getTenantId()), where))
      .orderBy(desc(purchaseOrders.date), desc(purchaseOrders.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<PurchaseOrder> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(purchaseOrders.id, id), 1);
    if (!found) throw notFound('Purchase order');
    const { order: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    // The requisition each line buys for, with the requisition's number for the page's link
    const linked = await tx
      .select({
        id: requisitionLines.id,
        requisitionId: requisitions.id,
        number: requisitions.number,
      })
      .from(requisitionLines)
      .innerJoin(
        requisitions,
        and(
          eq(requisitions.tenantId, requisitionLines.tenantId),
          eq(requisitions.id, requisitionLines.requisitionId),
        ),
      )
      .where(
        and(
          eq(requisitionLines.tenantId, tenantId),
          inArray(
            requisitionLines.id,
            tx
              .select({ id: purchaseOrderLines.requisitionLineId })
              .from(purchaseOrderLines)
              .where(
                and(
                  eq(purchaseOrderLines.tenantId, tenantId),
                  eq(purchaseOrderLines.orderId, id),
                  isNotNull(purchaseOrderLines.requisitionLineId),
                ),
              ),
          ),
        ),
      );
    const links = new Map(linked.map((link) => [link.id, link]));
    const requisitionRefs = [
      ...new Map(
        linked.map((link) => [link.requisitionId, { id: link.requisitionId, number: link.number }]),
      ).values(),
    ].sort((a, b) => a.number.localeCompare(b.number));
    const receipts = await tx
      .select({
        id: goodsReceipts.id,
        number: goodsReceipts.number,
        date: goodsReceipts.date,
        status: goodsReceipts.status,
      })
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.tenantId, tenantId), eq(goodsReceipts.orderId, id)))
      .orderBy(asc(goodsReceipts.date), asc(goodsReceipts.id));
    return {
      ...toSummary(row, found.supplier, found.lineCount, found.partlyReceived),
      paymentTermsDays: row.paymentTermsDays,
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        requisitionLine:
          line.requisitionLineId === null ? null : (links.get(line.requisitionLineId) ?? null),
        receivedQuantity: line.receivedQuantity,
        rejectedQuantity: line.rejectedQuantity,
      })),
      requisitions: requisitionRefs,
      receipts,
      approval: await this.approvals.history(tx, 'purchase_order', id),
    };
  }

  // customerRefs() reads any party by id: here, the order's supplier
  private async supplierOf(tx: Transaction, supplierId: string): Promise<PartyRef> {
    const supplier = (await customerRefs(tx, [supplierId])).get(supplierId);
    if (!supplier) throw new Error(`Supplier ${supplierId} is missing`);
    return supplier;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: OrderRow, supplier: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      number: row.number,
      date: row.date,
      expectedDate: row.expectedDate,
      supplier: supplier.code,
      supplierReference: row.supplierReference,
      warehouse: warehouse?.code ?? null,
      paymentTermsDays: row.paymentTermsDays,
      pricesIncludeVat: row.pricesIncludeVat,
      total: row.total,
      lines,
    };
  }
}
