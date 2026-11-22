import { type ShopPaymentMethod } from '@omnivo/contracts';
import { storefrontOrderCounters, storefrontOrders, storefrontStockHolds } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';

import { emit } from '../../common/outbox/outbox.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import { newToken, tokenHash } from './order-secrets.js';

// W-000123: W for web (26c's decision 3), counted per shop (27a's decision 20)
function orderNumber(value: number): string {
  return `W-${String(value).padStart(6, '0')}`;
}

// Step 27d.3: a pending order becomes confirmed, by a right phone code (27a) or by its payment
// (27d). Moved here out of ShopOrdersService.checkCode, so both take the same number, the same
// tracking token and the same events. The caller holds the order's row lock and knows it is
// pending. `paymentMethod` is set in the same UPDATE when the payment confirms an order that had
// turned into Cash on Delivery (decision 3): the method guard (27d.2) lets it change only while the
// row is still pending, which it is until this statement
export async function confirmPendingOrder(
  tx: Transaction,
  tenantId: string,
  orderId: string,
  now: Date,
  paymentMethod?: ShopPaymentMethod,
): Promise<{ orderNo: string; trackingToken: string }> {
  // The shop's next number. INSERT … ON CONFLICT: the first order of a shop makes its counter
  // row. The row's lock holds until this transaction ends, so two confirms in one shop take
  // turns, and a confirm that rolls back gives its number back (27a's decision 20)
  const [counter] = await tx
    .insert(storefrontOrderCounters)
    .values({ tenantId, lastValue: 1 })
    .onConflictDoUpdate({
      target: storefrontOrderCounters.tenantId,
      set: { lastValue: sql`${storefrontOrderCounters.lastValue} + 1` },
    })
    .returning({ value: storefrontOrderCounters.lastValue });
  if (counter === undefined) throw new Error('The order counter was not written');
  const orderNo = orderNumber(counter.value);

  // The tracking link's token is made now (27a's decision 9): a pending order is never tracked.
  // Every code column is emptied in the same UPDATE (storefront_orders_pending_check)
  const trackingToken = newToken();
  await tx
    .update(storefrontOrders)
    .set({
      status: 'confirmed',
      orderNo,
      trackingTokenHash: tokenHash(trackingToken),
      confirmedAt: now,
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      codeHash: null,
      codeExpiresAt: null,
      codeSentAt: null,
      codeSends: null,
      codeTriesLeft: null,
      version: sql`${storefrontOrders.version} + 1`,
    })
    .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)));
  // The stock stays held, now with no end, until 27b's challan takes it out for real
  await tx
    .update(storefrontStockHolds)
    .set({ expiresAt: null })
    .where(
      and(eq(storefrontStockHolds.tenantId, tenantId), eq(storefrontStockHolds.orderId, orderId)),
    );
  // In the same transaction (common/outbox): the bell now, and 27b's sales order
  await emit(tx, 'storefront.order_confirmed', { orderId });
  return { orderNo, trackingToken };
}
