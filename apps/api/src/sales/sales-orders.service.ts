import { Inject, Injectable } from '@nestjs/common';
import {
  documentTotals,
  type OrderStatus,
  type PartyRef,
  type SalesOrder,
  type SalesOrderInput,
  type SalesOrderSummary,
  type UpdateSalesOrderInput,
} from '@omnivo/contracts';
import {
  deliveries,
  parties,
  quotations,
  salesOrderLines,
  salesOrders,
  warehouses,
} from '@omnivo/db';
import { and, asc, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { decodeCursor, toPage } from '../common/pagination/cursor.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { assertWarehousesActive } from '../inventory/stock-lines.js';
import { NumberingService } from '../numbering/numbering.service.js';
import {
  assertCustomer,
  customerRefs,
  pricesIncludeVatNow,
  type ResolvedSalesLine,
  resolveSalesLines,
  salesLineValues,
  shippingAddressOf,
  toSalesLine,
  withVariants,
} from './sales-lines.js';

type OrderRow = typeof salesOrders.$inferSelect;

const cursorSchema = z.tuple([z.iso.date(), z.uuid()]);

// By the table's name: inside these subqueries a bare "id" would be the line's own
const lineCount = sql<number>`(
  SELECT count(*)::int FROM sales_order_lines l
   WHERE l.tenant_id = sales_orders.tenant_id AND l.order_id = sales_orders.id
)`;

// Confirmed, and a posted delivery has taken something. A service line never counts: it stays at 0.
const partlyDelivered = sql<boolean>`(sales_orders.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM sales_order_lines l
   WHERE l.tenant_id = sales_orders.tenant_id AND l.order_id = sales_orders.id
     AND l.delivered_quantity > 0
))`;

function notDraft(): AppError {
  return new AppError(
    409,
    'sales_not_draft',
    'Only a draft order can be changed. Reopen it first, if nothing was delivered.',
  );
}

function notConfirmed(): AppError {
  return new AppError(409, 'order_not_confirmed', 'This order is not waiting for deliveries.');
}

function toSummary(
  row: OrderRow,
  customer: PartyRef,
  lines: number,
  partly: boolean,
): SalesOrderSummary {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    deliveryDate: row.deliveryDate,
    customer,
    customerReference: row.customerReference,
    warehouseId: row.warehouseId,
    status: row.status,
    partlyDelivered: partly,
    net: row.net,
    vat: row.vat,
    total: row.total,
    lineCount: lines,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SalesOrdersService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly numbering: NumberingService,
  ) {}

  list(query: {
    limit: number;
    cursor?: string | undefined;
    status?: OrderStatus | undefined;
    customerId?: string | undefined;
  }): Promise<{ items: SalesOrderSummary[]; nextCursor: string | null }> {
    const after = decodeCursor(query.cursor, cursorSchema);
    return this.withTenant(async (tx) => {
      const rows = await this.rows(
        tx,
        and(
          query.status === undefined ? undefined : eq(salesOrders.status, query.status),
          query.customerId === undefined ? undefined : eq(salesOrders.customerId, query.customerId),
          after === undefined
            ? undefined
            : sql`(${salesOrders.date}, ${salesOrders.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
        ),
        query.limit + 1,
      );
      const page = toPage(rows, query.limit, (last) => [last.order.date, last.order.id]);
      return {
        items: page.items.map((row) =>
          toSummary(row.order, row.customer, row.lineCount, row.partlyDelivered),
        ),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<SalesOrder> {
    return this.withTenant((tx) => this.read(tx, id));
  }

  create(input: SalesOrderInput): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const customer = await assertCustomer(tx, input.customerId);
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const quotation =
        input.quotationId === null
          ? null
          : await this.openQuotation(tx, input.quotationId, customer);
      // An order made from a quotation reads its prices the way the quotation did: the form copied
      // them from there. Otherwise the workspace setting now.
      const pricesIncludeVat = quotation?.pricesIncludeVat ?? (await pricesIncludeVatNow(tx));
      const lines = await resolveSalesLines(tx, input.lines, pricesIncludeVat);
      const [row] = await tx
        .insert(salesOrders)
        .values({
          tenantId: getTenantId(),
          date: input.date,
          deliveryDate: input.deliveryDate,
          customerId: customer.id,
          customerReference: input.customerReference,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          quotationId: quotation?.id ?? null,
          pricesIncludeVat,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          createdBy: currentPrincipal().userId,
          updatedBy: currentPrincipal().userId,
        })
        .returning();
      if (!row) throw new Error('Sales order insert returned no row');
      await this.writeLines(tx, row.id, lines);
      // The customer said yes: the quotation is accepted by the order made from it. No audit row
      // of its own: this one names it.
      if (quotation !== null) await this.setQuotationStatus(tx, quotation.id, 'accepted');
      await audit(tx, {
        action: 'sales_order.created',
        entityType: 'sales_order',
        entityId: row.id,
        changes: created({
          ...(await this.snapshot(tx, row, customer, lines.length)),
          quotation: quotation?.number ?? null,
        }),
      });
      if (input.confirm) await this.confirmAndLog(tx, row);
      return this.read(tx, row.id);
    });
  }

  update(id: string, input: UpdateSalesOrderInput): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, input.version);
      const linesBefore = await this.linesOf(tx, id);
      const customerBefore = await this.customerOf(tx, before.customerId);
      const customer = await assertCustomer(tx, input.customerId, before.customerId);
      // A reopened order keeps its customer: its number was given to this customer, and a
      // quotation of this customer may point at it
      if (before.number !== null || before.quotationId !== null) {
        if (customer.id !== before.customerId) {
          throw new AppError(
            409,
            'sales_customer_invalid',
            'This order belongs to its customer. Write a new order for another one.',
            { fieldErrors: { customerId: ['sales_customer_invalid'] } },
          );
        }
      }
      await assertWarehousesActive(tx, [{ field: 'warehouseId', warehouseId: input.warehouseId }]);
      const address = await shippingAddressOf(tx, customer.id, input.shippingAddressId);
      const lines = await resolveSalesLines(
        tx,
        input.lines,
        before.pricesIncludeVat,
        new Set(linesBefore.map((line) => line.taxRateId)),
      );
      const [updated] = await tx
        .update(salesOrders)
        .set({
          date: input.date,
          deliveryDate: input.deliveryDate,
          customerId: customer.id,
          customerReference: input.customerReference,
          warehouseId: input.warehouseId,
          shippingAddressId: address?.id ?? null,
          shippingAddress: address?.text ?? null,
          note: input.note,
          ...documentTotals(lines.map((line) => line.amounts)),
          version: sql`${salesOrders.version} + 1`,
          updatedBy: currentPrincipal().userId,
        })
        .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)))
        .returning();
      if (!updated) throw notFound('Sales order');
      await this.writeLines(tx, id, lines);
      await audit(tx, {
        action: 'sales_order.updated',
        entityType: 'sales_order',
        entityId: id,
        changes: diff(
          await this.snapshot(tx, before, customerBefore, linesBefore.length),
          await this.snapshot(tx, updated, customer, lines.length),
        ),
      });
      if (input.confirm) await this.confirmAndLog(tx, updated);
      return this.read(tx, id);
    });
  }

  // Only a draft that never had a number: one the customer was told about is cancelled instead,
  // so its number never disappears (the database refuses it too: sales_orders_numbered_immutable)
  remove(id: string, version: number): Promise<void> {
    return this.withTenant(async (tx) => {
      const before = await this.lockDraft(tx, id, version);
      if (before.number !== null) {
        throw new AppError(
          409,
          'order_numbered',
          'This order has a number. Confirm it and cancel it instead.',
        );
      }
      const lines = await this.linesOf(tx, id);
      const customer = await this.customerOf(tx, before.customerId);
      // The lines go with it (ON DELETE CASCADE)
      await tx
        .delete(salesOrders)
        .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)));
      // Its quotation waits for an answer again: the order that accepted it is gone
      if (before.quotationId !== null) {
        await this.setQuotationStatus(tx, before.quotationId, 'open');
      }
      const snapshot = await this.snapshot(tx, before, customer, lines.length);
      await audit(tx, {
        action: 'sales_order.deleted',
        entityType: 'sales_order',
        entityId: id,
        changes: diff(
          snapshot,
          Object.fromEntries(Object.keys(snapshot).map((field) => [field, null])),
        ),
      });
    });
  }

  confirm(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const draft = await this.lockDraft(tx, id, version);
      await this.confirmAndLog(tx, draft);
      return this.read(tx, id);
    });
  }

  // Back to draft, to be changed: only while no delivery points at it, not even a draft one (its
  // lines point at the order's lines, which a save replaces). The number stays.
  reopen(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      const [delivery] = await tx
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(and(eq(deliveries.tenantId, getTenantId()), eq(deliveries.orderId, id)))
        .limit(1);
      if (delivery) {
        throw new AppError(
          409,
          'order_has_deliveries',
          'Deliveries were made for this order. Close it and write a new order instead.',
        );
      }
      // The check sales_orders_confirmed_check: a draft has no confirmation
      await this.write(tx, id, { status: 'draft', confirmedAt: null, confirmedBy: null });
      await audit(tx, { action: 'sales_order.reopened', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }

  // Partly delivered, and the rest will not be: the customer took what there was
  close(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      if (!(await this.anythingDelivered(tx, id))) {
        throw new AppError(
          409,
          'order_nothing_delivered',
          'Nothing was delivered for this order. Cancel it instead.',
        );
      }
      await this.write(tx, id, { status: 'closed' });
      await audit(tx, { action: 'sales_order.closed', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }

  // Called off before anything left the warehouse
  cancel(id: string, version: number): Promise<SalesOrder> {
    return this.withTenant(async (tx) => {
      const row = await this.lock(tx, id, version);
      if (row.status !== 'confirmed') throw notConfirmed();
      if (await this.anythingDelivered(tx, id)) {
        throw new AppError(
          409,
          'order_partly_delivered',
          'Some of this order was delivered. Close it instead.',
        );
      }
      await this.write(tx, id, { status: 'cancelled' });
      await audit(tx, { action: 'sales_order.cancelled', entityType: 'sales_order', entityId: id });
      return this.read(tx, id);
    });
  }

  // The number the first time; a reopened order confirms again with the number it already has
  private async confirmAndLog(tx: Transaction, draft: OrderRow): Promise<void> {
    const number = draft.number ?? (await this.numbering.next(tx, 'sales.order', draft.date));
    await this.write(tx, draft.id, {
      status: 'confirmed',
      number,
      confirmedAt: new Date(),
      confirmedBy: currentPrincipal().userId,
    });
    await audit(tx, {
      action: 'sales_order.confirmed',
      entityType: 'sales_order',
      entityId: draft.id,
      changes: created({ number }),
    });
  }

  // The quotation an order is made from: this customer's, and still waiting for an answer. FOR
  // UPDATE: two orders made from it at once take turns, and the second finds it accepted.
  private async openQuotation(tx: Transaction, quotationId: string, customer: PartyRef) {
    const [row] = await tx
      .select({
        id: quotations.id,
        number: quotations.number,
        customerId: quotations.customerId,
        status: quotations.status,
        pricesIncludeVat: quotations.pricesIncludeVat,
      })
      .from(quotations)
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, quotationId)))
      .for('update');
    if (row?.customerId !== customer.id) {
      throw new AppError(
        409,
        'order_quotation_invalid',
        'This quotation is for another customer. Make the order from that customer’s quotation.',
        { fieldErrors: { quotationId: ['order_quotation_invalid'] } },
      );
    }
    if (row.status !== 'open') {
      throw new AppError(
        409,
        'quotation_not_open',
        'The customer has already answered this quotation.',
      );
    }
    return row;
  }

  // accepted ⇄ open: the only change migration 0028 lets through on an answered quotation
  private async setQuotationStatus(
    tx: Transaction,
    quotationId: string,
    status: 'open' | 'accepted',
  ): Promise<void> {
    await tx
      .update(quotations)
      .set({
        status,
        version: sql`${quotations.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(quotations.tenantId, getTenantId()), eq(quotations.id, quotationId)));
  }

  private async anythingDelivered(tx: Transaction, orderId: string): Promise<boolean> {
    const [line] = await tx
      .select({ id: salesOrderLines.id })
      .from(salesOrderLines)
      .where(
        and(
          eq(salesOrderLines.tenantId, getTenantId()),
          eq(salesOrderLines.orderId, orderId),
          sql`${salesOrderLines.deliveredQuantity} > 0`,
        ),
      )
      .limit(1);
    return line !== undefined;
  }

  private async write(
    tx: Transaction,
    id: string,
    fields: Partial<Pick<OrderRow, 'status' | 'number' | 'confirmedAt' | 'confirmedBy'>>,
  ): Promise<void> {
    await tx
      .update(salesOrders)
      .set({
        ...fields,
        version: sql`${salesOrders.version} + 1`,
        updatedBy: currentPrincipal().userId,
      })
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)));
  }

  private async writeLines(
    tx: Transaction,
    orderId: string,
    lines: readonly ResolvedSalesLine[],
  ): Promise<void> {
    await tx
      .delete(salesOrderLines)
      .where(
        and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)),
      );
    await tx
      .insert(salesOrderLines)
      .values(lines.map((line, index) => ({ ...salesLineValues(line, index), orderId })));
  }

  // FOR UPDATE: every change to an order takes turns with the others, and with a delivery being
  // posted against it (DeliveriesService locks the order the same way)
  private async lock(tx: Transaction, id: string, version: number): Promise<OrderRow> {
    const [row] = await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, id)))
      .for('update');
    if (!row) throw notFound('Sales order');
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
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, orderId)))
      .orderBy(asc(salesOrderLines.lineNo));
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number) {
    return tx
      .select({
        order: salesOrders,
        customer: { id: parties.id, code: parties.code, name: parties.name },
        lineCount,
        partlyDelivered,
      })
      .from(salesOrders)
      .innerJoin(
        parties,
        and(eq(parties.tenantId, salesOrders.tenantId), eq(parties.id, salesOrders.customerId)),
      )
      .where(and(eq(salesOrders.tenantId, getTenantId()), where))
      .orderBy(desc(salesOrders.date), desc(salesOrders.id))
      .limit(limit);
  }

  private async read(tx: Transaction, id: string): Promise<SalesOrder> {
    const tenantId = getTenantId();
    const [found] = await this.rows(tx, eq(salesOrders.id, id), 1);
    if (!found) throw notFound('Sales order');
    const { order: row } = found;
    const lines = await withVariants(tx, await this.linesOf(tx, id));
    const [quotation] =
      row.quotationId === null
        ? []
        : await tx
            .select({ id: quotations.id, number: quotations.number })
            .from(quotations)
            .where(and(eq(quotations.tenantId, tenantId), eq(quotations.id, row.quotationId)));
    const made = await tx
      .select({
        id: deliveries.id,
        number: deliveries.number,
        date: deliveries.date,
        status: deliveries.status,
      })
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, tenantId), eq(deliveries.orderId, id)))
      .orderBy(asc(deliveries.date), asc(deliveries.id));
    return {
      ...toSummary(row, found.customer, found.lineCount, found.partlyDelivered),
      pricesIncludeVat: row.pricesIncludeVat,
      discount: row.discount,
      shippingAddressId: row.shippingAddressId,
      shippingAddress: row.shippingAddress,
      note: row.note,
      lines: lines.map(({ row: line, variant }) => ({
        ...toSalesLine(line, variant),
        deliveredQuantity: line.deliveredQuantity,
      })),
      quotation: quotation ?? null,
      deliveries: made,
    };
  }

  private async customerOf(tx: Transaction, customerId: string): Promise<PartyRef> {
    const customer = (await customerRefs(tx, [customerId])).get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} is missing`);
    return customer;
  }

  // What the audit log shows: the header and the size, not every line
  private async snapshot(tx: Transaction, row: OrderRow, customer: PartyRef, lines: number) {
    const [warehouse] = await tx
      .select({ code: warehouses.code })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, row.warehouseId)));
    return {
      number: row.number,
      date: row.date,
      deliveryDate: row.deliveryDate,
      customer: customer.code,
      customerReference: row.customerReference,
      warehouse: warehouse?.code ?? null,
      total: row.total,
      lines,
    };
  }
}
