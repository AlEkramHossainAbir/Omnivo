import { Inject, Injectable } from '@nestjs/common';
import { storefrontPayments } from '@omnivo/db';
import { and, eq } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { ShopPaymentReceipts } from './payment-receipts.js';

// Step 27d (decision 6): a try was paid; make its money receipt. The order the payment confirmed
// has its order_confirmed job too, which makes the sales order and then the receipts: when this
// job comes first there is no sales order yet, makeOne does nothing, and that job makes it. A
// payment for an order confirmed long ago (the shopper paid twice) has its sales order, and this
// job is the one that makes its receipt
@Injectable()
export class PaymentPaidHandler implements EventHandler<'storefront.payment_paid'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly paymentReceipts: ShopPaymentReceipts,
  ) {}

  async handle(event: OutboxEvent<'storefront.payment_paid'>): Promise<void> {
    const tenantId = getTenantId();
    const [payment] = await this.withTenant((tx) =>
      tx
        .select({ orderId: storefrontPayments.orderId })
        .from(storefrontPayments)
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontPayments.id, event.payload.paymentId),
          ),
        ),
    );
    if (payment === undefined) return;
    await this.paymentReceipts.makeOne(payment.orderId, event.payload.paymentId);
  }
}
