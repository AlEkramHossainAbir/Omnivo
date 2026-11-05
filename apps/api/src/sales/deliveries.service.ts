import { Inject, Injectable } from '@nestjs/common';
import {
  compareQuantity,
  type Delivery,
  type DeliveryInput,
  type DeliveryInvoiceFilter,
  type DeliveryInvoiceState,
  type DeliveryReturnFilter,
  type DeliveryReturnState,
  type DeliverySummary,
  type PartyRef,
  type StockDocumentStatus,
  subtractQuantity,
  sumMoney,
  sumQuantity,
  type UpdateDeliveryInput,
} from '@omnivo/contracts';
import {
  deliveries,
  deliveryLines,
  invoiceLines,
  invoices,
  parties,
  products,
  salesOrderLines,
  salesOrders,
  salesReturnLines,
  salesReturns,
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
  type LineInput,
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
import { assertCustomer, customerRefs, shippingAddressOf } from './sales-lines.js';

type DeliveryRow = typeof deliveries.$inferSelect;
type LineRow = typeof deliveryLines.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside this subquery a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id
)`;

// Step 15c: does a line of it still wait for an invoice? (delivery_lines_to_invoice_idx) Since
// step 15d, a line that all came back before it was billed waits for nothing.
const lineToInvoice = sql`EXISTS (
  SELECT 1 FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id AND NOT l.invoiced
     AND l.returned_quantity < l.base_quantity
)`;
const lineInvoiced = sql`EXISTS (
  SELECT 1 FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id AND l.invoiced
)`;

// A draft is never invoiced: only posted lines can be billed
const invoiceState = sql<DeliveryInvoiceState>`CASE
  WHEN deliveries.status <> 'posted' OR NOT ${lineInvoiced} THEN 'not_invoiced'
  WHEN ${lineToInvoice} THEN 'partly_invoiced'
  ELSE 'invoiced' END`;

// The list's invoice filter: posted, with a line still to bill (what the invoice form offers), or
// with every line billed
function invoiceFilter(filter: DeliveryInvoiceFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  const lines = filter === 'to_invoice' ? lineToInvoice : sql`NOT ${lineToInvoice}`;
  return and(eq(deliveries.status, 'posted'), lines);
}

// Step 15d: did some of a line come back, and can some still come back? Only posted returns write
// returned_quantity, so a draft return changes neither.
const lineReturned = sql`EXISTS (
  SELECT 1 FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id
     AND l.returned_quantity > 0
)`;
const lineReturnable = sql`EXISTS (
  SELECT 1 FROM delivery_lines l
   WHERE l.tenant_id = deliveries.tenant_id AND l.delivery_id = deliveries.id
     AND l.returned_quantity < l.base_quantity
)`;

// A draft took nothing out, so nothing came back from it
const returnState = sql<DeliveryReturnState>`CASE
  WHEN deliveries.status <> 'posted' OR NOT ${lineReturned} THEN 'none'
  WHEN ${lineReturnable} THEN 'partly_returned'
  ELSE 'returned' END`;

// The list's return filter: posted, with a line that has not all come back (what the return form
// offers)
function returnFilter(filter: DeliveryReturnFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  return and(eq(deliveries.status, 'posted'), lineReturnable);
}

function notDraft(): AppError {
  return new AppError(
    409,
    'stock_not_draft',
    'Only a draft can be changed. What comes back from a posted delivery is a return.',
  );
}

function toSummary(
  row: DeliveryRow,
  customer: PartyRef,
  order: { id: string; number: string | null } | null,
  lines: number,
  invoiced: DeliveryInvoiceState,
  returned: DeliveryReturnState,
): DeliverySummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    customer,
    order,
    warehouseId: row.warehouseId,
    status: row.status,
    shippingAddress: row.shippingAddress,
    vehicle: row.vehicle,
    note: row.note,
    lineCount: lines,
    invoiceState: invoiced,
    returnState: returned,
    postedAt: row.postedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A stored line as resolveLines() takes it, to check it again when the draft is posted
function storedInput(line: LineRow): LineInput {
  return {
    variantId: line.variantId,
    unitId: line.unitId,
    quantity: line.quantity,
    batchId: line.batchId,
    serialNumbers: line.serialNumbers,
  };
}

// The order a delivery takes goods against, as far as the delivery needs it
interface OrderInfo {
  id: string;
  number: string | null;
}

@Injectable()
export class DeliveriesService {
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
    customerId?: string | undefined;
    warehouseId?: string | undefined;
    invoice?: DeliveryInvoiceFilter | undefined;
    return?: DeliveryReturnFilter | undefined;
  }): Promise<{ items: DeliverySummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(deliveries.status, query.status),
          query.customerId === undefined ? undefined : eq(deliveries.customerId, query.customerId),
          query.warehouseId === undefined
            ? undefined
            : eq(deliveries.warehouseId, query.warehouseId),
          invoiceFilter(query.invoice),
          returnFilter(query.return),
          after === undefined
            ? undefined
            : sql`(${deliveries.date}, ${deliveries.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.delivery.date, last.delivery.id]);
      return {
        items: page.items.map((row) =>
          toSummary(
            row.delivery,
            row.customer,
            row.order,
            row.lineCount,
            row.invoiceState,
            row.returnState,
          ),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<Delivery> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: DeliveryInput): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const order =
        input.orderId === null ? null : await this.lockOrder(tx, input.orderId, customer.id);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveLines(tx, input.lines, 'out');
      const orderLineIds = input.lines.map((line) => line.orderLineId);
      if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);
      const [row] = await tx
        .insert(deliveries)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          customerId: customer.id,
          orderId: order?.id ?? null,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          vehicle: input.vehicle,
          note: input.note,
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Delivery insert returned no row');
      await this.writeLines(tx, row.id, lines, orderLineIds);
      await audit(tx, {
        action: 'delivery.created',
        entityType: 'delivery',
        entityId: row.id,
        changes: created(await this.snapshot(tx, row, customer, order, lines.length)),
      });
      if (input.post) await this.postAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateDeliveryInput): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const orderBefore = await this.orderRef(tx, before.orderId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const order =
        input.orderId === null ? null : await this.lockOrder(tx, input.orderId, customer.id);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveLines(tx, input.lines, 'out');
      const orderLineIds = input.lines.map((line) => line.orderLineId);
      if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);
      const [updated] = await tx
        .update(deliveries)
        .set({
          date: input.date,
          customerId: customer.id,
          orderId: order?.id ?? null,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          vehicle: input.vehicle,
          note: input.note,
          version: sql`${deliveries.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)))
        .returning();
      if (!updated) throw notFound('Delivery');
      await this.writeLines(tx, id, lines, orderLineIds);
      await audit(tx, {
        action: 'delivery.updated',
        entityType: 'delivery',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, customerBefore, orderBefore, linesBefore.length),
          await this.snapshot(tx, updated, customer, order, lines.length),
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
      const customer = await this.customerOf(tx, before.customerId);
      const order = await this.orderRef(tx, before.orderId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(deliveries)
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)));
      const snapshot = await this.snapshot(tx, before, customer, order, lines.length);
      await audit(tx, {
        action: 'delivery.deleted',
        entityType: 'delivery',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  post(id: string, version: number): Promise<Delivery> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.postAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // Step 15c: the challan a direct invoice makes for its own goods lines, posted in the invoice's
  // transaction. It is an ordinary challan — numbered, in the stock ledger, with its cost of goods
  // sold — so the stock, the books and the challan list need nothing new: the invoice only bills
  // its lines. No order and no shipping address: the goods went over the counter, or the invoice
  // says where. Returns its number and its line ids in the order of `lines`; the invoice points its
  // lines at them, and marks them invoiced with the challan lines it bills. The line errors name
  // this challan's lines (lines.0, lines.1 …): the caller renames them to its own.
  async deliverForInvoice(
    tx: Transaction,
    input: {
      customerId: string;
      date: string;
      warehouseId: string;
      note: string;
      lines: readonly LineInput[];
    },
  ): Promise<{ id: string; number: string; lineIds: string[] }> {
    const customer = await this.customerOf(tx, input.customerId);
    const lines = await resolveLines(tx, input.lines, 'out');
    const orderLineIds = lines.map(() => null);
    const [row] = await tx
      .insert(deliveries)
      .values({
        tenantId: getTenantId(),
        date: input.date,
        customerId: input.customerId,
        warehouseId: input.warehouseId,
        note: input.note,
        createdBy: currentPrincipal().userId,
        updatedBy: currentPrincipal().userId,
      })
      .returning();
    if (!row) throw new Error('Delivery insert returned no row');
    await this.writeLines(tx, row.id, lines, orderLineIds);
    await audit(tx, {
      action: 'delivery.created',
      entityType: 'delivery',
      entityId: row.id,
      changes: created(await this.snapshot(tx, row, customer, null, lines.length)),
    });
    const number = await this.postAndLog(tx, row);
    // Posting wrote the lines again with their values, so their ids are new: read them now
    const posted = await this.linesOf(tx, row.id);
    return { id: row.id, number, lineIds: posted.map((line) => line.id) };
  }

  // A draft out of the warehouse, like a stock adjustment "out": the date and the warehouse
  // checked, the lines checked again against their products and (for an order) against what the
  // order still has to deliver, the number taken, the stock moved at its average cost, and the
  // cost of goods sold booked — all in the caller's transaction, so a refused line leaves nothing
  // posted and no number used. Returns the number (a direct invoice's challan needs it, step 15c).
  private async postAndLog(tx: Transaction, draft: DeliveryRow): Promise<string> {
    await this.posting.assertDate(tx, draft.date);
    await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: draft.warehouseId }]);
    // Locked before anything moves: two deliveries of one order post one after the other, and the
    // second sees what the first delivered. A close or cancel waits for us too.
    const order =
      draft.orderId === null ? null : await this.lockOrder(tx, draft.orderId, draft.customerId);
    const stored = await this.linesOf(tx, draft.id);
    const lines = await resolveLines(tx, stored.map(storedInput), 'out', { lock: true });
    const orderLineIds = stored.map((line) => line.orderLineId);
    if (order !== null) await this.checkOrderLines(tx, order.id, orderLineIds, lines);

    const number = await this.numbering.next(tx, 'sales.delivery', draft.date);
    const values = await this.posting.post(tx, {
      date: draft.date,
      kind: 'delivery',
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
      })),
    });
    // Still a draft here: the lines may change, and take their values
    await this.writeLines(tx, draft.id, lines, orderLineIds, values);
    await tx
      .update(deliveries)
      .set({
        status: 'posted',
        number,
        postedAt: new Date(),
        postedBy: currentPrincipal().userId,
        version: sql`${deliveries.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, draft.id)));
    if (order !== null) await this.deliverOnOrder(tx, order.id, orderLineIds, lines);
    // The books (you chose this): Dr Cost of goods sold / Cr Inventory, at what the stock cost.
    // The invoice (15c) books the sale itself.
    const entry = await this.books.delivery(
      tx,
      { id: draft.id, number, date: draft.date },
      { warehouseId: draft.warehouseId, value: sumMoney(values) },
    );
    await audit(tx, {
      action: 'delivery.posted',
      entityType: 'delivery',
      entityId: draft.id,
      changes: created({ number, entry: entry?.number ?? null }),
    });
    return number;
  }

  // The order of a delivery: this customer's, and confirmed (waiting for deliveries). FOR UPDATE,
  // in every write of a delivery: a reopen of the order waits and then sees the delivery, and two
  // deliveries posting against one order take turns. The lock is always taken after the
  // delivery's own (lockDraft), never before, so two of these never wait for each other in a circle.
  private async lockOrder(
    tx: Transaction,
    orderId: string,
    customerId: string,
  ): Promise<OrderInfo> {
    const [row] = await tx
      .select({
        id: salesOrders.id,
        number: salesOrders.number,
        customerId: salesOrders.customerId,
        status: salesOrders.status,
      })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, orderId)))
      .for('update');
    if (row?.customerId !== customerId) {
      throw new AppError(
        409,
        'delivery_order_invalid',
        'Pick a confirmed order of this customer, or deliver without an order.',
        { fieldErrors: { orderId: ['delivery_order_invalid'] } },
      );
    }
    if (row.status !== 'confirmed') {
      throw new AppError(
        409,
        'order_not_confirmed',
        'This order is not waiting for deliveries any more.',
        { fieldErrors: { orderId: ['order_not_confirmed'] } },
      );
    }
    return { id: row.id, number: row.number };
  }

  // Each line delivers a line of this order, of the same variant (in any of its units), and all
  // the lines together never deliver more than an order line still has to: ordered − delivered by
  // posted deliveries. Two lines may share an order line (two batches). Drafts hold nothing, so
  // two drafts may each take the whole rest; the second one to post is refused here.
  private async checkOrderLines(
    tx: Transaction,
    orderId: string,
    orderLineIds: readonly (string | null)[],
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const rows = await tx
      .select({
        id: salesOrderLines.id,
        variantId: salesOrderLines.variantId,
        baseQuantity: salesOrderLines.baseQuantity,
        deliveredQuantity: salesOrderLines.deliveredQuantity,
      })
      .from(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)),
      );
    const orderLines = new Map(rows.map((row) => [row.id, row]));
    const issues: LineIssue[] = [];
    const taken = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLineId = orderLineIds[index] ?? null;
      const orderLine = orderLineId === null ? undefined : orderLines.get(orderLineId);
      if (orderLineId === null) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'delivery_order_line_required' });
      } else if (orderLine?.variantId !== line.variant.variantId) {
        issues.push({ path: linePath(index, 'orderLineId'), code: 'delivery_order_line_invalid' });
      } else {
        taken.set(orderLineId, [...(taken.get(orderLineId) ?? []), line.baseQuantity]);
      }
    });
    for (const [orderLineId, quantities] of taken) {
      const orderLine = orderLines.get(orderLineId);
      if (!orderLine) continue;
      const left = subtractQuantity(orderLine.baseQuantity, orderLine.deliveredQuantity);
      if (compareQuantity(sumQuantity(quantities), left) <= 0) continue;
      // Under every line that takes from it: the person decides which one to cut
      orderLineIds.forEach((id, index) => {
        if (id === orderLineId) {
          issues.push({ path: linePath(index, 'quantity'), code: 'delivery_over_order' });
        }
      });
    }
    if (issues.length > 0) throw linesError(issues);
  }

  // What the posted lines delivered, onto their order lines; and when every goods line has all it
  // ordered, the order is delivered. The lines first: migration 0028 lets delivered_quantity change
  // only while the order is confirmed. A service line is never delivered and does not count.
  private async deliverOnOrder(
    tx: Transaction,
    orderId: string,
    orderLineIds: readonly (string | null)[],
    lines: readonly ResolvedLine[],
  ): Promise<void> {
    const tenantId = getTenantId();
    const byOrderLine = new Map<string, string[]>();
    lines.forEach((line, index) => {
      const orderLineId = orderLineIds[index] ?? null;
      if (orderLineId === null) return;
      byOrderLine.set(orderLineId, [...(byOrderLine.get(orderLineId) ?? []), line.baseQuantity]);
    });
    for (const [orderLineId, quantities] of byOrderLine) {
      await tx
        .update(salesOrderLines)
        .set({
          deliveredQuantity: sql`${salesOrderLines.deliveredQuantity} + ${sumQuantity(quantities)}::numeric`,
        })
        .where(and(eq(salesOrderLines.tenantId, tenantId), eq(salesOrderLines.id, orderLineId)));
    }
    const [open] = await tx
      .select({ id: salesOrderLines.id })
      .from(salesOrderLines)
      .innerJoin(
        products,
        and(
          eq(products.tenantId, salesOrderLines.tenantId),
          eq(products.id, salesOrderLines.productId),
        ),
      )
      .where(
        and(
          eq(salesOrderLines.tenantId, tenantId),
          eq(salesOrderLines.orderId, orderId),
          eq(products.type, 'goods'),
          sql`${salesOrderLines.deliveredQuantity} < ${salesOrderLines.baseQuantity}`,
        ),
      )
      .limit(1);
    // A new version either way: an order page open somewhere shows old delivered quantities, and
    // its next action (close) must reload first
    await tx
      .update(salesOrders)
      .set({
        ...(open === undefined ? { status: 'delivered' as const } : {}),
        version: sql`${salesOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(salesOrders.tenantId, tenantId), eq(salesOrders.id, orderId)));
  }

  // The lines in the order they were written. values: set when posting has priced them.
  private async writeLines(
    tx: Transaction,
    deliveryId: string,
    lines: readonly ResolvedLine[],
    orderLineIds: readonly (string | null)[],
    values?: readonly string[],
  ): Promise<void> {
    const tenantId = getTenantId();
    await tx
      .delete(deliveryLines)
      .where(and(eq(deliveryLines.tenantId, tenantId), eq(deliveryLines.deliveryId, deliveryId)));
    await tx.insert(deliveryLines).values(
      lines.map((line, index) => ({
        tenantId,
        deliveryId,
        lineNo: index + 1,
        productId: line.variant.productId,
        variantId: line.variant.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        factor: line.factor,
        baseQuantity: line.baseQuantity,
        batchId: line.batchId,
        serialNumbers: line.serialNumbers,
        orderLineId: orderLineIds[index] ?? null,
        value: values?.[index] ?? null,
      })),
    );
  }

  // FOR UPDATE: two saves of one draft run one after the other, and a save never overlaps a post
  private async lockDraft(tx: Transaction, id: string, version: number): Promise<DeliveryRow> {
    const [row] = await tx
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.id, id)))
      .for('update');
    if (!row) throw notFound('Delivery');
    if (row.status !== 'draft') throw notDraft();
    if (row.version !== version) throw versionConflict();
    return row;
  }

  private linesOf(tx: Transaction, deliveryId: string) {
    return tx
      .select()
      .from(deliveryLines)
      .where(
        and(eq(deliveryLines.tenantId, getTenantId()), eq(deliveryLines.deliveryId, deliveryId)),
      )
      .orderBy(asc(deliveryLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        delivery: deliveries,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        order: { id: salesOrders.id, number: salesOrders.number },
        lineCount,
        invoiceState,
        returnState,
      })
      .from(deliveries)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, deliveries.tenantId), eq(parties.id, deliveries.customerId)),
      )
      .leftJoin(
        salesOrders,
        and(eq(salesOrders.tenantId, deliveries.tenantId), eq(salesOrders.id, deliveries.orderId)),
      )
      .where(and(eq(deliveries.tenantId, getTenantId()), where))
      .orderBy(desc(deliveries.date), desc(deliveries.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<Delivery> {
    const [found] = await this.rows(tx, eq(deliveries.id, id), 1);
    if (!found) throw notFound('Delivery');
    const { delivery: row } = found;
    const lines = await this.linesOf(tx, id);
    const [canSee, entries, variants, batches, billedBy, returnedBy] = await Promise.all([
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
      this.invoicesOf(
        tx,
        lines.map((line) => line.id),
      ),
      this.returnsOf(
        tx,
        lines.map((line) => line.id),
      ),
    ]);
    return {
      ...toSummary(
        row,
        found.customer,
        found.order,
        found.lineCount,
        found.invoiceState,
        found.returnState,
      ),
      shippingAddressId: row.shippingAddressId,
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
            // Worked out from the books: needs inventory.stock.value (step 14)
            value: canSee ? line.value : null,
            invoiced: line.invoiced,
            returnedQuantity: line.returnedQuantity,
          },
        ];
      }),
      entry: entries[0] ?? null,
      invoices: billedBy,
      returns: returnedBy,
    };
  }

  // The posted invoices that bill some of these lines, by number (step 15c). A draft invoice that
  // names a line has claimed nothing yet, so it is not shown.
  private async invoicesOf(tx: Transaction, lineIds: readonly string[]) {
    if (lineIds.length === 0) return [];
    return tx
      .selectDistinct({ id: invoices.id, number: invoices.number })
      .from(invoiceLines)
      .innerJoin(
        invoices,
        and(eq(invoices.tenantId, invoiceLines.tenantId), eq(invoices.id, invoiceLines.invoiceId)),
      )
      .where(
        and(
          eq(invoiceLines.tenantId, getTenantId()),
          inArray(invoiceLines.deliveryLineId, [...lineIds]),
          eq(invoices.status, 'posted'),
        ),
      )
      .orderBy(asc(invoices.number));
  }

  // The posted sales returns that brought some of these lines back, by number (step 15d). A draft
  // return brought nothing back yet.
  private async returnsOf(tx: Transaction, lineIds: readonly string[]) {
    if (lineIds.length === 0) return [];
    return tx
      .selectDistinct({ id: salesReturns.id, number: salesReturns.number })
      .from(salesReturnLines)
      .innerJoin(
        salesReturns,
        and(
          eq(salesReturns.tenantId, salesReturnLines.tenantId),
          eq(salesReturns.id, salesReturnLines.returnId),
        ),
      )
      .where(
        and(
          eq(salesReturnLines.tenantId, getTenantId()),
          inArray(salesReturnLines.deliveryLineId, [...lineIds]),
          eq(salesReturns.status, 'posted'),
        ),
      )
      .orderBy(asc(salesReturns.number));
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  private async orderRef(tx: Transaction, orderId: string | null): Promise<OrderInfo | null> {
    if (orderId === null) return null;
    const [row] = await tx
      .select({ id: salesOrders.id, number: salesOrders.number })
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, orderId)));
    return row ?? null;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(
    tx: Transaction,
    row: DeliveryRow,
    customer: PartyRef,
    order: OrderInfo | null,
    lines: number,
  ) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      date: row.date,
      customer: customer.code,
      order: order?.number ?? null,
      warehouse: warehouse?.code ?? null,
      vehicle: row.vehicle,
      lines,
    };
  }
}
