import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  rolePermissions,
  roles,
  storefrontOrders,
} from '@omnivo/db';
import { and, eq, isNull, or } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../../common/outbox/outbox.js';
import { getTenantId } from '../../common/tenant/tenant-context.js';
import type { WithTenant } from '../../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../../infra/tokens.js';
import { notify } from '../../notifications/notify.js';

// Step 27a: "New shop order W-000123 for ৳578" in the bell of the owners and of everyone who may
// read the shop's orders (storefront.order.read). 27b adds the sales order to this event. Like
// SoldShortHandler: the order is read when the job runs, and the event's id is each notification's
// key, so a second run of the job adds nothing.
@Injectable()
export class OrderConfirmedHandler implements EventHandler<'storefront.order_confirmed'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'storefront.order_confirmed'>): Promise<void> {
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
