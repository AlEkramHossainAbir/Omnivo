import { Inject, Injectable } from '@nestjs/common';
import {
  membershipRoles,
  memberships,
  permissions,
  posSales,
  rolePermissions,
  roles,
} from '@omnivo/db';
import { and, eq, isNull, ne, or } from 'drizzle-orm';

import type { EventHandler, OutboxEvent } from '../common/outbox/outbox.js';
import { getTenantId } from '../common/tenant/tenant-context.js';
import type { WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { notify } from '../notifications/notify.js';

// Cost floor: "POS1-000123 sold 2 lines below the buying price" in the bell of the owners and of
// everyone with pos.shift.manage (the people who watch the counters), never of the person who made
// the sale. The bell opens the sale. The count comes in the event: which lines were below cost
// depends on the cost and the margin when the sale was posted, which the sale's rows do not keep
// (the audit row pos_sale.below_cost does, in words). Like SoldShortHandler, the event id is each
// notification's key, so a second run of the job adds nothing.
@Injectable()
export class SoldBelowCostHandler implements EventHandler<'pos.sold_below_cost'> {
  constructor(@Inject(WITH_TENANT) private readonly withTenant: WithTenant) {}

  async handle(event: OutboxEvent<'pos.sold_below_cost'>): Promise<void> {
    const tenantId = getTenantId();
    await this.withTenant(async (tx) => {
      // A sale never changes (0052): its number and who made it are the ones of the event
      const [sale] = await tx
        .select({ id: posSales.id, number: posSales.number, seller: posSales.createdBy })
        .from(posSales)
        .where(and(eq(posSales.tenantId, tenantId), eq(posSales.id, event.payload.saleId)));
      if (!sale) return;

      // Owners, and members with a role that has pos.shift.manage, but not the seller
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
            or(eq(roles.kind, 'owner'), eq(permissions.key, 'pos.shift.manage')),
            sale.seller === null ? undefined : ne(memberships.userId, sale.seller),
          ),
        );
      for (const recipient of recipients) {
        await notify(tx, {
          userId: recipient.userId,
          type: 'pos.sold_below_cost',
          params: { id: sale.id, number: sale.number, count: event.payload.count },
          eventId: event.id,
        });
      }
    });
  }
}
