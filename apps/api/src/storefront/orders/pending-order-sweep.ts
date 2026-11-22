import { Inject, Injectable, Logger } from '@nestjs/common';
import { SHOP_ORDER_HOLD_MINUTES } from '@omnivo/contracts';
import { type Db, storefrontOrders, storefrontPayments } from '@omnivo/db';
import { and, eq, inArray, lt, notInArray } from 'drizzle-orm';

import { getTenantId, runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { PAYMENT_GATEWAY, RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';
import type { PaymentGateway } from '../../payments/gateway.js';
import { GatewayAccounts } from '../gateway-accounts.js';
import { settleLocked } from './payment-settle.js';

const MINUTE_MS = 60 * 1000;

// Step 27d: an order with a payment try is given one more hour after its hold before the sweep
// looks at it. A shopper can sit on the gateway's page (an OTP from the bank, a slow bKash app)
// after the hold ended, and a payment that comes then still confirms the order (decision 5). The
// later the sweep, the smaller the window in which money arrives for an order already dropped
// (mine)
const PAYMENT_GRACE_MINUTES = 60;

// Step 27a: deletes the orders that never got their code (27a's decision 19), every 5 minutes. Two
// halves on two roles, like the report schedules' sweep:
// 1. as omnivo_worker (RELAY_DB): which workspaces have a pending order older than its hold.
//    Migration 0071 lets it read three columns of the pending rows only, never a name or a phone
// 2. as omnivo_app, inside each of those workspaces: delete them. Their lines and holds go with
//    them (ON DELETE CASCADE)
// Step 27d: before the delete, an order with payment tries is asked about (decision 5): a try the
// gateway says is paid is recorded, which confirms the order, so the delete passes it by; one the
// gateway is still processing, or cannot be asked about now, keeps its order for the next sweep.
// Nothing waits on this: an order past its hour can no longer be confirmed by its code (waitingOrder
// in shop-orders.service.ts), and its stock is free again by the holds' own expires_at. Provided
// by WorkerModule only.
@Injectable()
export class PendingOrderSweep {
  private readonly logger = new Logger(PendingOrderSweep.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly accounts: GatewayAccounts,
  ) {}

  // The number of orders deleted. One clock for both halves: the JavaScript one, as the orders'
  // times were written with it (ShopDb's now)
  async run(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SHOP_ORDER_HOLD_MINUTES * MINUTE_MS);
    // The policy shows omnivo_worker only pending rows; the status in the WHERE says so here too,
    // and it is what the partial index (storefront_orders_pending_idx) is for
    const tenants = await this.relayDb
      .selectDistinct({ tenantId: storefrontOrders.tenantId })
      .from(storefrontOrders)
      .where(and(eq(storefrontOrders.status, 'pending'), lt(storefrontOrders.createdAt, before)));

    let deleted = 0;
    for (const { tenantId } of tenants) {
      try {
        deleted += await runWithTenant(tenantId, async () => {
          const kept = await this.settleTries(now, before);
          return this.withTenant(async (tx) => {
            // pending again: an order confirmed between the two halves (or by its payment just
            // now) is kept
            const rows = await tx
              .delete(storefrontOrders)
              .where(
                and(
                  eq(storefrontOrders.tenantId, getTenantId()),
                  eq(storefrontOrders.status, 'pending'),
                  lt(storefrontOrders.createdAt, before),
                  kept.length === 0 ? undefined : notInArray(storefrontOrders.id, kept),
                ),
              )
              .returning({ id: storefrontOrders.id });
            return rows.length;
          });
        });
      } catch (error) {
        // One workspace's failure must not stop the others; the next sweep tries again
        this.logger.warn(`pending orders (tenant ${tenantId}): ${String(error)}`);
      }
    }
    return deleted;
  }

  // The ids of the pending orders past their hold that must stay for now. Every try that may still
  // pay is asked about: started, and failed or cancelled too, because only paid is final (27d.1's
  // mine 11). A not_opened try had no page, so nothing can come for it
  private async settleTries(now: Date, before: Date): Promise<string[]> {
    const tenantId = getTenantId();
    const tries = await this.withTenant((tx) =>
      tx
        .select({
          id: storefrontPayments.id,
          tranId: storefrontPayments.tranId,
          mode: storefrontPayments.mode,
          orderId: storefrontOrders.id,
          createdAt: storefrontOrders.createdAt,
        })
        .from(storefrontPayments)
        .innerJoin(
          storefrontOrders,
          and(
            eq(storefrontOrders.tenantId, storefrontPayments.tenantId),
            eq(storefrontOrders.id, storefrontPayments.orderId),
          ),
        )
        .where(
          and(
            eq(storefrontPayments.tenantId, tenantId),
            eq(storefrontOrders.status, 'pending'),
            lt(storefrontOrders.createdAt, before),
            inArray(storefrontPayments.status, ['started', 'failed', 'cancelled']),
          ),
        ),
    );
    const graceBefore = new Date(before.getTime() - PAYMENT_GRACE_MINUTES * MINUTE_MS);
    const kept = new Set<string>();
    for (const payment of tries) {
      // Too soon for an order with a try: next sweeps, until its grace hour is over
      if (payment.createdAt >= graceBefore) {
        kept.add(payment.orderId);
        continue;
      }
      if (kept.has(payment.orderId)) continue;
      const account = await this.accounts.open(tenantId, payment.mode);
      const answer =
        account === null
          ? ({ kind: 'problem', problem: 'rejected' } as const)
          : await this.gateway.find(account, payment.tranId);
      if (answer.kind === 'paid' || answer.kind === 'failed' || answer.kind === 'cancelled') {
        // As omnivo_app, with the same rules as the shop's own settle. A paid answer confirms the
        // order (no confirm SMS from here: the worker has no shop address to put in it; the shopper
        // still has /checkout/paid and /track)
        const result = await this.withTenant((tx) =>
          settleLocked(tx, tenantId, payment.id, answer, now, this.logger),
        );
        // A "paid" answer that is not this try's (another amount: settleLocked logged it) keeps
        // the order, so the staff still find it next to the gateway's record
        if (answer.kind === 'paid' && result?.status !== 'paid') kept.add(payment.orderId);
      } else if (answer.kind === 'pending' || answer.kind === 'problem') {
        // Still being processed, or the gateway (or the account) cannot answer now: keep it. An
        // account that never opens again keeps its orders until someone fixes the key, which the
        // log says
        kept.add(payment.orderId);
        if (answer.kind === 'problem') {
          this.logger.warn(`Could not ask about payment ${payment.tranId} (tenant ${tenantId})`);
        }
      }
    }
    return [...kept];
  }
}
