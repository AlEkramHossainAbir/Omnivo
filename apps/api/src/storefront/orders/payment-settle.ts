import type { Logger } from '@nestjs/common';
import { compareMoney, type ShopPaymentStatus } from '@omnivo/contracts';
import { storefrontOrders, storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import { emit } from '../../common/outbox/outbox.js';
import type { Transaction } from '../../common/tenant/with-tenant.js';
import type { GatewayAnswer } from '../../payments/gateway.js';
import { confirmPendingOrder } from './confirm-order.js';

export type PaymentRow = typeof storefrontPayments.$inferSelect;

// What recording an answer did: the try's status after it, and, when this call confirmed the
// order, what the confirm SMS needs (the caller sends it once the transaction has committed)
export interface SettleResult {
  status: ShopPaymentStatus;
  confirmed: { orderNo: string; trackingToken: string; phone: string } | null;
}

// Why a "paid" answer is not this try's payment, or null when it is (decision 2). Each is a
// gateway answer the API refuses to believe: another try's payment, another amount, another
// currency. Never in the shopper's words: it is logged, and the try stays as it was, so the staff
// can look at it in SSLCommerz's own panel by its tran_id
function mismatch(
  payment: PaymentRow,
  answer: Extract<GatewayAnswer, { kind: 'paid' }>,
): string | null {
  if (answer.tranId !== payment.tranId) return 'another tran_id';
  if (answer.currency !== 'BDT') return `currency ${answer.currency}`;
  if (compareMoney(answer.amount, payment.amount) !== 0) return `amount ${answer.amount}`;
  // What the gateway pays out cannot be more than what it took (27d.2's amounts check); a store
  // amount above it would make a negative fee
  if (compareMoney(answer.storeAmount, answer.amount) > 0) return 'store_amount over the amount';
  return null;
}

// Step 27d: records what the gateway said about one try, in the caller's transaction. Three
// callers, on two roles: settle and /checkout/paid (ShopDb.orders, as omnivo_shop) and the
// worker's sweep (as omnivo_app). Both may write every column this writes (0076's grants).
//
// The order's row is locked first, then the try's: every other writer of an order's tries ("Try
// again", "Pay on delivery", the receipt job) locks the order first too, so two of them never wait
// for each other in a circle. With both locks held, a second call for the same payment (the
// browser's return and the IPN at once) finds the try paid already and changes nothing.
//
// null: the try is gone (its order was dropped with it)
export async function settleLocked(
  tx: Transaction,
  tenantId: string,
  paymentId: string,
  answer: GatewayAnswer,
  now: Date,
  logger: Logger,
): Promise<SettleResult | null> {
  const [found] = await tx
    .select({ orderId: storefrontPayments.orderId })
    .from(storefrontPayments)
    .where(and(eq(storefrontPayments.tenantId, tenantId), eq(storefrontPayments.id, paymentId)));
  if (found === undefined) return null;
  const [order] = await tx
    .select()
    .from(storefrontOrders)
    .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, found.orderId)))
    .for('update');
  const where = and(
    eq(storefrontPayments.tenantId, tenantId),
    eq(storefrontPayments.id, paymentId),
  );
  const [payment] = await tx.select().from(storefrontPayments).where(where).for('update');
  if (order === undefined || payment === undefined) return null;

  // Paid is final (27d.1's mine 11): the second of two calls, or a late "failed" after the money
  // came, changes nothing
  if (payment.status === 'paid') return { status: 'paid', confirmed: null };

  if (answer.kind === 'failed' || answer.kind === 'cancelled') {
    if (payment.status !== answer.kind) {
      await tx.update(storefrontPayments).set({ status: answer.kind, settledAt: now }).where(where);
    }
    return { status: answer.kind, confirmed: null };
  }
  // pending, none or a problem: nothing to record yet. A try that was started stays started, so a
  // later look (the IPN, /checkout/paid, the sweep) can still find it paid
  if (answer.kind !== 'paid') return { status: payment.status, confirmed: null };

  const wrong = mismatch(payment, answer);
  if (wrong !== null) {
    logger.error(
      `Payment ${payment.tranId} (tenant ${tenantId}): the gateway said paid, but ${wrong}`,
    );
    return { status: payment.status, confirmed: null };
  }

  await tx
    .update(storefrontPayments)
    .set({
      status: 'paid',
      settledAt: now,
      valId: answer.valId,
      cardType: answer.cardType,
      bankTranId: answer.bankTranId,
      storeAmount: answer.storeAmount,
    })
    .where(where);
  // The receipt is the worker's (decision 6), from the try's own row
  await emit(tx, 'storefront.payment_paid', { paymentId });

  // Still pending: this payment confirms it, even after its hold ended (decision 5: the money
  // came; the stock is checked again at Packed). An order that turned into Cash on Delivery and
  // was not confirmed yet goes back to online in the same UPDATE. An order confirmed already (the
  // shopper paid twice, or paid after typing the phone code) stays as it is: the receipt makes the
  // money an advance, and the order page says what to refund
  if (order.status !== 'pending') return { status: 'paid', confirmed: null };
  const confirmed = await confirmPendingOrder(
    tx,
    tenantId,
    order.id,
    now,
    order.paymentMethod === 'online' ? undefined : 'online',
  );
  return { status: 'paid', confirmed: { ...confirmed, phone: order.phone } };
}
