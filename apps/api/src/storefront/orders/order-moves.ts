import { Injectable } from '@nestjs/common';
import {
  compareMoney,
  multiplyMoney,
  spreadMoney,
  type StorefrontOrderStatus,
  todayIn,
} from '@omnivo/contracts';
import {
  deliveryLines,
  salesOrderLines,
  salesOrders,
  storefrontOrderLines,
  storefrontOrders,
  tenantSettings,
  warehouses,
} from '@omnivo/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import { audit, diff } from '../../common/audit/audit.js';
import { AppError, notFound } from '../../common/http/app-error.js';
import { currentActorId, getTenantId } from '../../common/tenant/tenant-context.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { InvoicesService } from '../../sales/invoices.service.js';
import type { OrderLineRow, OrderRow } from './order-view.js';
import { ShopPaymentReceipts } from './payment-receipts.js';

// Step 28a: a shop order's Shipped and Delivered, out of StorefrontOrdersService (27b), so the
// courier's news (storefront/shipping/shipment-news.ts) moves an order with the same code as the
// member's buttons: in the API for a webhook, and in the worker for the 15-minute poll, which has
// no StorefrontOrdersService. Each takes an order the caller has locked (FOR UPDATE) in its own
// transaction, and says nothing about versions: the buttons check the version first, the
// courier's news has none to check. Who did it is currentActorId(): the member, or null for the
// courier's news (27b's decision 20).

export function stepInvalid(): AppError {
  return new AppError(
    409,
    'storefront_order_step_invalid',
    'This order has moved on since it was loaded. Reload it.',
  );
}

// The order's columns a move may set
export type OrderMove = Partial<
  Pick<
    OrderRow,
    | 'status'
    | 'packedAt'
    | 'shippedAt'
    | 'deliveredAt'
    | 'cancelledAt'
    | 'cancelReason'
    | 'deliveryId'
    | 'invoiceId'
    | 'salesReturnId'
  >
> & { status: StorefrontOrderStatus };

// The new status, its time and its documents in one UPDATE (storefront_orders_documents_check
// reads them together), the version up, and the audit row of the move
export async function moveOrder(
  tx: Transaction,
  before: OrderRow,
  fields: OrderMove,
): Promise<void> {
  await tx
    .update(storefrontOrders)
    .set({
      ...fields,
      version: sql`${storefrontOrders.version} + 1`,
      updatedBy: currentActorId(),
    })
    .where(and(eq(storefrontOrders.tenantId, getTenantId()), eq(storefrontOrders.id, before.id)));
  const action = {
    confirmed: null,
    packed: 'storefront_order.packed',
    shipped: 'storefront_order.shipped',
    delivered: 'storefront_order.delivered',
    cancelled: 'storefront_order.cancelled',
    returned: null,
  } as const satisfies Record<StorefrontOrderStatus, string | null>;
  const name = action[fields.status];
  if (name === null) throw new Error(`No audit action for ${fields.status}`);
  await audit(tx, {
    action: name,
    entityType: 'storefront_order',
    entityId: before.id,
    changes: diff(
      { order: before.orderNo, status: before.status },
      {
        order: before.orderNo,
        status: fields.status,
        ...(fields.cancelReason === undefined ? {} : { reason: fields.cancelReason }),
      },
    ),
  });
}

// FOR UPDATE, never a pending order (that one is the shopper's). The courier's news locks the
// order this way before its parcel, the same order as the buttons, so the two take turns
export async function lockOrder(tx: Transaction, id: string): Promise<OrderRow> {
  const [order] = await tx
    .select()
    .from(storefrontOrders)
    .where(
      and(
        eq(storefrontOrders.tenantId, getTenantId()),
        eq(storefrontOrders.id, id),
        ne(storefrontOrders.status, 'pending'),
      ),
    )
    .for('update');
  if (!order) throw notFound('Shop order');
  return order;
}

// The order's sales order, which Packed and Delivered build on
export async function salesOrderOf(tx: Transaction, order: OrderRow) {
  if (order.salesOrderId === null) {
    throw new AppError(
      409,
      'storefront_order_no_sales_order',
      'This order has no sales order yet. Make the sales order first.',
    );
  }
  const [row] = await tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.tenantId, getTenantId()), eq(salesOrders.id, order.salesOrderId)));
  if (!row) throw new Error(`Sales order ${order.salesOrderId} is missing`);
  return row;
}

export function orderLinesOf(tx: Transaction, orderId: string): Promise<OrderLineRow[]> {
  return tx
    .select()
    .from(storefrontOrderLines)
    .where(
      and(
        eq(storefrontOrderLines.tenantId, getTenantId()),
        eq(storefrontOrderLines.orderId, orderId),
      ),
    )
    .orderBy(asc(storefrontOrderLines.position));
}

export function salesOrderLinesOf(tx: Transaction, salesOrderId: string) {
  return tx
    .select()
    .from(salesOrderLines)
    .where(
      and(eq(salesOrderLines.tenantId, getTenantId()), eq(salesOrderLines.orderId, salesOrderId)),
    )
    .orderBy(asc(salesOrderLines.lineNo));
}

// Today in the workspace's time zone: the documents a move makes are dated by it
export async function shopToday(tx: Transaction): Promise<string> {
  const [settings] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  return todayIn(settings?.timezone ?? 'Asia/Dhaka');
}

@Injectable()
export class ShopOrderMoves {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly paymentReceipts: ShopPaymentReceipts,
  ) {}

  // 27b's decision 6: a status only. Step 28a: the courier's "picked up" calls it too
  async ship(tx: Transaction, order: OrderRow): Promise<void> {
    if (order.status !== 'packed') throw stepInvalid();
    await moveOrder(tx, order, { status: 'shipped', shippedAt: new Date() });
  }

  // 27b's decision 7: a posted invoice for what the challan took and the delivery charge, dated
  // today (decision 21) and unpaid: the cash the rider brings back is a money receipt. Step 28a:
  // the courier's "delivered" calls it too
  async deliver(tx: Transaction, order: OrderRow): Promise<void> {
    if (order.status !== 'shipped' || order.deliveryId === null) throw stepInvalid();
    const salesOrder = await salesOrderOf(tx, order);
    const orderLines = await orderLinesOf(tx, order.id);
    const soLines = await salesOrderLinesOf(tx, salesOrder.id);
    const soLineById = new Map(soLines.map((line) => [line.id, line]));
    const challan = await tx
      .select()
      .from(deliveryLines)
      .where(
        and(
          eq(deliveryLines.tenantId, getTenantId()),
          eq(deliveryLines.deliveryId, order.deliveryId),
        ),
      )
      .orderBy(asc(deliveryLines.lineNo));
    const [branch] = await tx
      .select({ id: warehouses.branchId })
      .from(warehouses)
      .where(
        and(eq(warehouses.tenantId, getTenantId()), eq(warehouses.id, salesOrder.warehouseId)),
      );
    if (!branch) throw new Error(`Warehouse ${salesOrder.warehouseId} is missing`);

    // Each challan line at its order line's price and VAT rate; then the delivery charge, the
    // sales order's lines after the order's own (the maker added it last). Step 27c: and with
    // its share of the order line's discount (a coupon's, spread by the maker), or the invoice
    // would bill more than the shopper pays
    const discounts = challanDiscounts(challan, soLineById);
    const goods = challan.map((line) => {
      const soLine = line.orderLineId === null ? undefined : soLineById.get(line.orderLineId);
      if (soLine === undefined) throw new Error(`Challan line ${line.id} has no order line`);
      return {
        variantId: line.variantId,
        unitId: line.unitId,
        quantity: line.quantity,
        description: soLine.description,
        unitPrice: soLine.unitPrice,
        discountType: 'amount' as const,
        discount: discounts.get(line.id) ?? '0',
        taxRateId: soLine.taxRateId,
        deliveryLineId: line.id,
        orderLineId: null,
        batchId: null,
        serialNumbers: [],
      };
    });
    const charges = soLines.slice(orderLines.length).map((soLine) => ({
      variantId: soLine.variantId,
      unitId: soLine.unitId,
      quantity: soLine.quantity,
      description: soLine.description,
      unitPrice: soLine.unitPrice,
      discountType: 'amount' as const,
      discount: '0',
      taxRateId: soLine.taxRateId,
      deliveryLineId: null,
      orderLineId: soLine.id,
      batchId: null,
      serialNumbers: [],
    }));
    const invoiceId = await this.invoices.createIn(tx, {
      customerId: salesOrder.customerId,
      date: await shopToday(tx),
      note: null,
      lines: [...goods, ...charges],
      // The customer's payment terms from today: 0 days for a new shop customer
      dueDate: null,
      customerReference: order.orderNo,
      branchId: branch.id,
      warehouseId: null,
      post: true,
      // Never over the limit: the invoice bills the confirmed order at its own prices, which
      // moves the amount from "on order" to "owed" and adds nothing (CreditService.check)
      overrideCreditLimit: false,
    });
    // Step 27d (decision 6): a paid online order's advance pays its invoice at once
    await this.paymentReceipts.applyToInvoice(tx, order.id, invoiceId);
    await moveOrder(tx, order, { status: 'delivered', deliveredAt: new Date(), invoiceId });
  }
}

// Step 27c: each challan line's share of its sales order line's discount, by challan line id. A
// line packed from two batches is two challan lines of one order line, so the order line's
// discount is spread over them by what each is worth at the order's price (spreadMoney: to the
// paisa, adding up to the discount exactly). One challan line per order line, the usual case,
// takes the whole discount. The maker wrote every discount of a shop's sales order as an amount
// (sales-order-maker.ts); a line without one gets none. Exported for its unit test
export function challanDiscounts(
  challan: readonly { id: string; orderLineId: string | null; quantity: string }[],
  orderLines: ReadonlyMap<string, { discountType: string; discount: string; unitPrice: string }>,
): Map<string, string> {
  const byOrderLine = new Map<string, { id: string; quantity: string }[]>();
  for (const line of challan) {
    if (line.orderLineId === null) continue;
    byOrderLine.set(line.orderLineId, [...(byOrderLine.get(line.orderLineId) ?? []), line]);
  }
  const shares = new Map<string, string>();
  for (const [orderLineId, lines] of byOrderLine) {
    const orderLine = orderLines.get(orderLineId);
    if (orderLine?.discountType !== 'amount' || compareMoney(orderLine.discount, '0') === 0) {
      continue;
    }
    const pieces = spreadMoney(
      orderLine.discount,
      lines.map((line) => multiplyMoney(line.quantity, orderLine.unitPrice)),
    );
    lines.forEach((line, index) => shares.set(line.id, pieces[index] ?? '0'));
  }
  return shares;
}
