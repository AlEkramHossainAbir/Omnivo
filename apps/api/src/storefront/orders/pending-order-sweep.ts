import { Inject, Injectable, Logger } from '@nestjs/common';
import { SHOP_ORDER_HOLD_MINUTES } from '@omnivo/contracts';
import { type Db, storefrontOrders } from '@omnivo/db';
import { and, eq, lt } from 'drizzle-orm';

import { getTenantId, runWithTenant } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { RELAY_DB, WITH_TENANT } from '../../infra/tokens.js';

// Step 27a: deletes the orders that never got their code (27a's decision 19), every 5 minutes. Two
// halves on two roles, like the report schedules' sweep:
// 1. as omnivo_worker (RELAY_DB): which workspaces have a pending order older than its hold.
//    Migration 0071 lets it read three columns of the pending rows only, never a name or a phone
// 2. as omnivo_app, inside each of those workspaces: delete them. Their lines and holds go with
//    them (ON DELETE CASCADE)
// Nothing waits on this: an order past its hour can no longer be confirmed (waitingOrder in
// shop-orders.service.ts), and its stock is free again by the holds' own expires_at. The sweep
// only stops keeping a phone number that was never confirmed. Provided by WorkerModule only.
@Injectable()
export class PendingOrderSweep {
  private readonly logger = new Logger(PendingOrderSweep.name);

  constructor(
    @Inject(RELAY_DB) private readonly relayDb: Db,
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
  ) {}

  // The number of orders deleted. One clock for both halves: the JavaScript one, as the orders'
  // times were written with it (ShopDb's now)
  async run(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - SHOP_ORDER_HOLD_MINUTES * 60 * 1000);
    // The policy shows omnivo_worker only pending rows; the status in the WHERE says so here too,
    // and it is what the partial index (storefront_orders_pending_idx) is for
    const tenants = await this.relayDb
      .selectDistinct({ tenantId: storefrontOrders.tenantId })
      .from(storefrontOrders)
      .where(and(eq(storefrontOrders.status, 'pending'), lt(storefrontOrders.createdAt, before)));

    let deleted = 0;
    for (const { tenantId } of tenants) {
      try {
        deleted += await runWithTenant(tenantId, () =>
          this.withTenant(async (tx) => {
            // pending again: an order confirmed between the two halves is kept
            const rows = await tx
              .delete(storefrontOrders)
              .where(
                and(
                  eq(storefrontOrders.tenantId, getTenantId()),
                  eq(storefrontOrders.status, 'pending'),
                  lt(storefrontOrders.createdAt, before),
                ),
              )
              .returning({ id: storefrontOrders.id });
            return rows.length;
          }),
        );
      } catch (error) {
        // One workspace's failure must not stop the others; the next sweep tries again
        this.logger.warn(`pending orders (tenant ${tenantId}): ${String(error)}`);
      }
    }
    return deleted;
  }
}
