import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  storefrontOrders,
} from '@omnivo/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { AppError } from '../../common/http/app-error.js';
import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { notify } from '../../notifications/notify.js';
import { ShopPaymentReceipts } from './payment-receipts.js';
import { ShopSalesOrderMaker } from './sales-order-maker.js';

// Step 27a: "New shop order W-000123 for ৳578" in the bell of the owners and of everyone who may
// read the shop's orders (storefront.order.read). Like SoldShortHandler: the order is read when the
// job runs, and the event's id is each notification's key, so a second run of the job adds nothing.
// Step 27b: first the order's customer and sales order (decision 1), here and not in the confirm,
// which runs as omnivo_shop and must never fail for something in the ERP.
@Injectable()
export class OrderConfirmedHandler implements EventHandler<'storefront.order_confirmed'> {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly maker: ShopSalesOrderMaker,
    private readonly paymentReceipts: ShopPaymentReceipts,
  ) {}

  async handle(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
    await this.makeSalesOrder(event.payload.orderId);
    // Step 27d: then the money receipts of its paid tries, which need the sales order's customer.
    // The payment_paid job may have run before the sales order was made and done nothing; this
    // one comes after it, so a paid order always gets its receipt (makeAll skips a try that has
    // one already)
    await this.paymentReceipts.makeAll(event.payload.orderId);
    await this.ring(event);
  }

  // Its own transaction, before the bell's: a refused sales order must not take the bell with it.
  // A refusal by the sales order's rules (an AppError: an archived product, no VAT rate) is kept on
  // the order as its code, in a second transaction after the first rolled back, and the job ends
  // there: running it again would be refused the same way until someone fixes the cause, and the
  // order page's "Make the sales order" is the retry. Anything else (the database went away) is
  // thrown, and the queue runs the job again later.
  private async makeSalesOrder(orderId: string): Promise<void> {
    const tenantId = getTenantId();
    try {
      await this.withTenant(async (tx) => {
        const [order] = await tx
          .select()
          .from(storefrontOrders)
          .where(and(eq(storefrontOrders.tenantId, tenantId), eq(storefrontOrders.id, orderId)))
          // The page's retry takes the same lock: whichever comes second sees the sales order
          .for('update');
        // A second run of the job (made already), or an order cancelled before the job ran
        if (order?.status !== 'confirmed' || order.salesOrderId !== null) return;
        await this.maker.make(tx, order);
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.withTenant(async (tx) => {
        await tx
          .update(storefrontOrders)
          .set({ documentError: error.code, version: sql`${storefrontOrders.version} + 1` })
          .where(
            and(
              eq(storefrontOrders.tenantId, tenantId),
              eq(storefrontOrders.id, orderId),
              // Only while it has none: the page's retry may have made it in the meantime
              isNull(storefrontOrders.salesOrderId),
            ),
          );
      });
    }
  }

  private async ring(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      const [order] = await tx
        .select({
          id: storefrontOrders.id,
          orderNo: storefrontOrders.orderNo,
          total: storefrontOrders.total,
        })
        .from(storefrontOrders)
        .where(
          and(
            eq(storefrontOrders.tenantId, tenantId),
            eq(storefrontOrders.id, event.payload.orderId),
          ),
        );
      // Gone (27b may let staff delete a test order) or, which cannot happen, without a number
      if (order?.orderNo == null) return;

      const recipients = await tx
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(
          membershipRoles,
          and(
            eq(membershipRoles.tenantId, memberships.tenantId),
            eq(membershipRoles.membershipId, memberships.id),
            isNull(membershipRoles.deletedAt),
          ),
        )
        .innerJoin(
          roles,
          and(
            eq(roles.tenantId, membershipRoles.tenantId),
            eq(roles.id, membershipRoles.roleId),
            isNull(roles.deletedAt),
          ),
        )
        .leftJoin(
          rolePermissions,
          and(
            eq(rolePermissions.tenantId, roles.tenantId),
            eq(rolePermissions.roleId, roles.id),
            isNull(rolePermissions.deletedAt),
          ),
        )
        .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(
          and(
            eq(memberships.tenantId, tenantId),
            isNull(memberships.deletedAt),
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'storefront.order.read')),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'storefront.order_confirmed',
          // The amount as it is stored ("578.0000"): the bell writes it as money in the reader's
          // language. Never the buyer's name or phone: a bell is seen over a shoulder
          params: { id: order.id, number: order.orderNo, total: order.total },
          eventId: event.id,
        });
      }
    });
  }
}
