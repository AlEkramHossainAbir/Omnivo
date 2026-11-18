import {
  SHOP_ORDER_STATUSES,
  storefrontImageSchema,
  type ShopOrder,
  type ShopOrderStatus,
  type ShopTracking,
} from '@omnivo/contracts';
import type { storefrontOrderLines, storefrontOrders } from '@omnivo/db';

import { shopImage } from '../media.js';

// Step 27a: an order as the shop's pages show it, from its rows. Pure functions, so the unit test
// covers every case without a database.

export type OrderRow = typeof storefrontOrders.$inferSelect;
export type OrderLineRow = typeof storefrontOrderLines.$inferSelect;

// Each status and the column that says when the order reached it. A Record over the statuses, so a
// status added to the contract without its column here does not compile
const STEP_AT = {
  pending: 'createdAt',
  confirmed: 'confirmedAt',
  packed: 'packedAt',
  shipped: 'shippedAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
  returned: 'returnedAt',
} as const satisfies Record<ShopOrderStatus, keyof OrderRow>;

// The timeline, oldest first (shopOrderSchema.history): every step the order has a time for. Read
// from the columns, not kept as a list of events, so it can never disagree with them (27a.2). Two
// steps at the same moment keep the life's own order: sort() is stable, and the list starts in
// SHOP_ORDER_STATUSES' order
export function historyOf(order: OrderRow): ShopOrder['history'] {
  return SHOP_ORDER_STATUSES.flatMap((status) => {
    const at = order[STEP_AT[status]];
    return at === null ? [] : [{ status, at: at.toISOString() }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// A confirmed order always has its number (storefront_orders_pending_check). The routes never show
// a pending order, so a missing number here is a bug, and a loud one is better than "W-null"
function numberOf(order: OrderRow): string {
  if (order.orderNo === null) throw new Error(`Order ${order.id} has no number yet`);
  return order.orderNo;
}

// What /order/<no> shows: everything, for the browser that placed the order (decision 16). Lines in
// the cart's order. Each photo is the small one, the size a checkout line draws; the jsonb is
// checked like a banner's (public-storefront.service.ts), because the database checks only that
// it is an object
export function orderOf(
  order: OrderRow,
  lines: readonly OrderLineRow[],
  mediaUrl: string,
): ShopOrder {
  return {
    orderNo: numberOf(order),
    placedAt: order.createdAt.toISOString(),
    status: order.status,
    history: historyOf(order),
    name: order.customerName,
    phone: order.phone,
    address: order.address,
    zoneName: order.zoneName,
    paymentMethod: order.paymentMethod,
    lines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((line) => ({
        listingId: line.listingId,
        slug: line.slug,
        name: line.name,
        packSize: line.packSize,
        image: shopImage(mediaUrl, storefrontImageSchema.parse(line.image), 'small'),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    subtotal: order.subtotal,
    discount: order.discount,
    couponCode: order.couponCode,
    deliveryCharge: order.deliveryCharge,
    total: order.total,
  };
}

// What a tracking link and the /track form show (26e's shopTrackingSchema): no name, phone,
// address or line, because the link gets forwarded. Each field picked by name, never `...order`.
// No parcel yet: couriers come in step 28
export function trackingOf(order: OrderRow, lines: readonly OrderLineRow[]): ShopTracking {
  return {
    orderNo: numberOf(order),
    placedAt: order.createdAt.toISOString(),
    status: order.status,
    history: historyOf(order),
    // Pieces, not lines: two face washes and a tea are 3 items
    itemCount: lines.reduce((count, line) => count + line.quantity, 0),
    total: order.total,
    paymentMethod: order.paymentMethod,
    shipments: [],
  };
}
